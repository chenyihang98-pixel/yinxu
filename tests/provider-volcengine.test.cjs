'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { generate, buildBody, signRequest } = require('../electron/providers/volcengine.cjs');

const INPUT = { prompt: '青春欢快的背景音乐', duration: 30 };
const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example-not-real' };
const audioUrl = 'https://v1-default.douyinvod.com/fixture.wav?example=1';
const fixtureWav = (() => {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(1000, 44); bytes.writeInt16LE(-1000, 46);
  return bytes;
})();
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const success = Result => json({ Code: 0, Message: 'success', Result, ResponseMetadata: { Error: null } });
const submission = () => success({ TaskID: 'fixture-task-123', PredictedWaitTime: 0 });
const complete = (url = audioUrl, duration = 30.02) => success({ Status: 2, SongDetail: { AudioUrl: url, Duration: duration } });
const noSleep = { sleep: async () => {} };

test('Volcengine V4 signer matches independent Python official-algorithm reference vector', () => {
  // Reference calculated independently with Python hashlib/hmac, checked against
  // volcengine/volc-sdk-python SignerV4.py's sorted canonical headers and key scope.
  const body = { Text: INPUT.prompt, Duration: 30, Version: 'v5.0', EnableInputRewrite: false, Segments: [{ Name: 'inst', Duration: 30 }] };
  const signed = signRequest({ action: 'GenBGMForTime', body, credentials: CREDS, now: new Date('2026-10-08T00:00:00Z') });
  assert.equal(signed.url, 'https://open.volcengineapi.com/?Action=GenBGMForTime&Version=2024-08-12');
  assert.equal(signed.options.headers['X-Date'], '20261008T000000Z');
  assert.equal(signed.options.headers['X-Content-Sha256'], '3a3cd9bc1198f7789933270e6437593d41728ed3515078973058699c45360452');
  assert.equal(signed.options.headers.Authorization,
    'HMAC-SHA256 Credential=AKIDEXAMPLE/20261008/cn-beijing/imagination/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=bb1373627bfc0a85ccc8a3ce7851d4467e70e2036dd485f90df3cd17e5e5f6b4');
  assert.equal(signed.options.headers['X-Content-Sha256'], crypto.createHash('sha256').update(signed.options.body).digest('hex'));
  assert.equal(signed.options.redirect, 'error');
  assert.equal(JSON.stringify(signed).includes(CREDS.secretAccessKey), false);
});

test('Volcengine v5 duration segments preserve chosen duration over prompt duration', () => {
  const body = buildBody({ ...INPUT, prompt: '轻快的钢琴背景音乐，时长80秒', duration: 60 });
  assert.equal(body.Duration, 60);
  assert.deepEqual(body.Segments, [{ Name: 'inst', Duration: 60 }]);
  assert.equal(body.Version, 'v5.0');
  assert.equal(body.EnableInputRewrite, false);
  assert.match(body.Text, /无人声、无歌词/);
  assert.equal('Genre' in body, false);
});

test('Volcengine postpaid submission polls 0/1/2 once per step then downloads WAV without credentials', async () => {
  const calls = [], waits = [];
  const responses = [submission, () => success({ Status: 0 }), () => success({ Status: 1 }), () => complete(), () => new Response(fixtureWav, { headers: { 'content-type': 'application/octet-stream' } })];
  const result = await generate({ input: INPUT, credentials: CREDS, helpers: { sleep: async ms => waits.push(ms) }, fetchImpl: async (...args) => {
    calls.push(args); return responses.shift()();
  } });
  assert.equal(calls.length, 5);
  assert.match(calls[0][0], /Action=GenBGMForTime&/);
  assert.equal(calls.filter(([url]) => /Action=GenBGM/.test(url)).length, 1);
  assert.deepEqual(JSON.parse(calls[0][1].body), buildBody(INPUT));
  for (const [url, options] of calls.slice(1, 4)) {
    assert.match(url, /Action=QuerySong&/);
    assert.deepEqual(JSON.parse(options.body), { TaskID: 'fixture-task-123' });
    assert.match(options.headers.Authorization, /cn-beijing\/imagination\/request/);
  }
  const [downloadUrl, download] = calls[4];
  assert.equal(downloadUrl, audioUrl);
  assert.equal(download.method, 'GET');
  assert.equal(download.redirect, 'manual');
  assert.equal('Authorization' in download.headers, false);
  assert.equal(JSON.stringify(download).includes(CREDS.accessKeyId), false);
  assert.deepEqual(waits, [2000, 2000]);
  assert.equal(result.mimeType, 'audio/wav');
  assert.deepEqual(Buffer.from(result.audio), fixtureWav);
  assert.equal(result.requestedDuration, 30);
  assert.equal(result.providerDuration, 30.02);
});

test('Volcengine prepaid selects only GenBGM; MP4 response keeps actual MIME', async () => {
  const mp4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0]);
  const calls = [];
  const responses = [submission, () => complete('https://v50-default.douyinvod.com/fixture.mp4'), () => new Response(mp4)];
  const result = await generate({ input: { ...INPUT, duration: 120 }, credentials: { ...CREDS, billingMode: 'prepaid' }, helpers: noSleep, fetchImpl: async (...args) => { calls.push(args); return responses.shift()(); } });
  assert.match(calls[0][0], /Action=GenBGM&/);
  assert.equal(result.mimeType, 'audio/mp4');
});

test('Volcengine rejects unsupported duration, English-only prompt, model and credentials before submission', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not reach network'); };
  for (const input of [{ ...INPUT, duration: 15 }, { ...INPUT, duration: 121 }, { ...INPUT, duration: NaN }, { ...INPUT, duration: 30.5 }, { ...INPUT, prompt: 'bright happy' }, { ...INPUT, model: 'v4.0' }, { ...INPUT, prompt: '' }]) {
    await assert.rejects(generate({ input, credentials: CREDS, fetchImpl }));
  }
  for (const credentials of [null, { ...CREDS, secretAccessKey: 'short' }, { ...CREDS, accessKeyId: 'bad\ncredential' }, { ...CREDS, billingMode: 'automatic' }]) {
    await assert.rejects(generate({ input: INPUT, credentials, fetchImpl }));
  }
  assert.equal(calls, 0);
});

test('Volcengine errors are sanitized and never repeat a billed submit', async () => {
  for (const firstResponse of [
    () => json({ Code: 50000001, Message: CREDS.secretAccessKey }),
    () => json({ ResponseMetadata: { Error: { Code: 'SignatureDoesNotMatch', Message: CREDS.secretAccessKey } } }),
    () => new Response(CREDS.secretAccessKey, { status: 403 }),
    () => new Response(CREDS.secretAccessKey, { status: 500 }),
    () => success({ TaskID: '../../secret' }),
    () => new Response('{not json'),
  ]) {
    let calls = 0;
    await assert.rejects(generate({ input: INPUT, credentials: CREDS, fetchImpl: async () => { calls++; return firstResponse(); } }), error => {
      assert.equal(error.name, 'MusicError'); assert.equal(error.message.includes(CREDS.secretAccessKey), false); return true;
    });
    assert.equal(calls, 1);
  }
});

test('Volcengine failed or unknown task states stop polling without resubmission', async () => {
  for (const status of [3, 99]) {
    let calls = 0;
    await assert.rejects(generate({ input: INPUT, credentials: CREDS, helpers: noSleep, fetchImpl: async () => {
      calls++; return calls === 1 ? submission() : success({ Status: status, FailureReason: { Code: 300061, Msg: CREDS.secretAccessKey } });
    } }), error => !error.message.includes(CREDS.secretAccessKey));
    assert.equal(calls, 2);
  }
});

test('Volcengine blocks nonofficial initial download URLs and hostile redirects', async () => {
  for (const url of ['http://v1-default.douyinvod.com/test.wav', 'https://v51-default.douyinvod.com/test.wav', 'https://v1-default.douyinvod.com.evil.test/a', 'https://example.com/a', 'https://user:pass@v1-default.douyinvod.com/a', 'https://127.0.0.1/a']) {
    let calls = 0;
    await assert.rejects(generate({ input: INPUT, credentials: CREDS, fetchImpl: async () => { calls++; return calls === 1 ? submission() : complete(url); } }), /白名单/);
    assert.equal(calls, 2);
  }
  let calls = 0;
  await assert.rejects(generate({ input: INPUT, credentials: CREDS, fetchImpl: async () => {
    calls++; if (calls === 1) return submission(); if (calls === 2) return complete();
    return new Response('', { status: 302, headers: { location: 'https://evil.test/stolen' } });
  } }), /非官方/);
  assert.equal(calls, 3);
});

test('Volcengine cancellation before submission and during poll wait prevents later network work', async () => {
  const first = new AbortController(); first.abort(); let calls = 0;
  await assert.rejects(generate({ input: INPUT, credentials: CREDS, signal: first.signal, fetchImpl: async () => { calls++; return submission(); } }), /取消/);
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(generate({ input: INPUT, credentials: CREDS, signal: controller.signal, fetchImpl: async () => {
    calls++;
    if (calls === 1) return submission();
    setTimeout(() => controller.abort(), 10);
    return success({ Status: 1 });
  } }), /取消/);
  assert.equal(calls, 2);
});

test('Volcengine times out bounded polling and enforces download size limit', async () => {
  let calls = 0;
  await assert.rejects(generate({ input: INPUT, credentials: CREDS, helpers: noSleep, fetchImpl: async () => {
    calls++; return calls === 1 ? submission() : success({ Status: 1 });
  } }), /超过 5 分钟/);
  assert.equal(calls, 151, 'one submit and exactly 150 status queries');
  calls = 0;
  await assert.rejects(generate({ input: INPUT, credentials: CREDS, maxBytes: 16, fetchImpl: async () => {
    calls++; if (calls === 1) return submission(); if (calls === 2) return complete(); return new Response(fixtureWav);
  } }), /大小限制/);
  assert.equal(calls, 3);
});
