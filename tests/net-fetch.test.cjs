'use strict';

// F05: the fetch wrapper around Electron's `net` module. The real Chromium behaviour
// (redirects, abort, body cut-off, proxy) is proven by .scratch/desktop-main/net-probe.cjs
// under Electron; these tests pin the wrapper's own logic against a fake `net`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createNetFetch } = require('../electron/net-fetch.cjs');
const shared = require('../electron/providers/shared.cjs');

function fakeNet({ respond = async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }) } = {}) {
  const fetchCalls = [], requests = [];
  return {
    fetchCalls, requests,
    fetch: async (url, init) => { fetchCalls.push({ url, init }); return respond(url, init); },
    request: options => {
      const request = new EventEmitter();
      Object.assign(request, { options, headers: {}, aborted: false, ended: false, setHeader(name, value) { this.headers[name] = value; }, abort() { this.aborted = true; }, end() { this.ended = true; } });
      requests.push(request);
      return request;
    },
  };
}

test('requires the Electron net module', () => {
  for (const bad of [undefined, null, {}, { fetch() {} }, { request() {} }]) assert.throws(() => createNetFetch(bad), TypeError);
});

test('standard requests go through net.fetch without cookies or cache, redirect defaults to "error"', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const response = await netFetch('https://api.example-vendor.com/v1/x', { method: 'POST', headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(net.fetchCalls.length, 1);
  const { url, init } = net.fetchCalls[0];
  assert.equal(url, 'https://api.example-vendor.com/v1/x');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error', 'a missing redirect option never means "follow"');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.body, '{"a":1}');
  assert.deepEqual(init.headers, { Authorization: 'Bearer k', 'Content-Type': 'application/json' });
  assert.ok(init.signal instanceof AbortSignal);
  await netFetch('https://api.example-vendor.com/v1/x', { redirect: 'error' });
  assert.equal(net.fetchCalls[1].init.method, 'GET');
  assert.equal('body' in net.fetchCalls[1].init, false);
  await netFetch('https://api.example-vendor.com/v1/x', { redirect: 'follow' });
  assert.equal(net.fetchCalls[2].init.redirect, 'follow', 'an explicit choice is respected');
  await netFetch(new URL('https://api.example-vendor.com/v1/y'));
  assert.equal(net.fetchCalls[3].url, 'https://api.example-vendor.com/v1/y');
});

test('headers Chromium refuses are dropped; a Host header that disagrees with the URL is an error', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  // The Volcengine adapter signs and sends a Host header; raw net.fetch fails with ERR_INVALID_ARGUMENT on it.
  await netFetch('https://open.volcengineapi.com/?Action=QuerySong', { method: 'POST', body: '{}', headers: { Host: 'open.volcengineapi.com', 'Content-Type': 'application/json', 'X-Date': '20261008T000000Z', 'Content-Length': '2', Connection: 'keep-alive', Cookie: 'a=b', Authorization: 'HMAC-SHA256 Credential=x' } });
  assert.deepEqual(net.fetchCalls[0].init.headers, { 'Content-Type': 'application/json', 'X-Date': '20261008T000000Z', Authorization: 'HMAC-SHA256 Credential=x' });
  await netFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}', headers: new Headers({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01', host: 'api.anthropic.com' }) });
  assert.deepEqual(net.fetchCalls[1].init.headers, { 'anthropic-version': '2023-06-01', 'x-api-key': 'k' });
  await assert.rejects(netFetch('https://open.volcengineapi.com/', { headers: { Host: 'evil.test' } }), TypeError);
  assert.equal(net.fetchCalls.length, 2);
  await netFetch('https://api.example-vendor.com/', { headers: { 'X-Skip': undefined, 'X-Null': null, 'X-Number': 5 } });
  assert.deepEqual(net.fetchCalls[2].init.headers, { 'X-Number': '5' });
});

test('only http(s) URLs and known redirect modes are accepted', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  for (const url of ['file:///C:/Windows/win.ini', 'ftp://example.com/x', 'data:text/plain,hi', 'chrome://settings', 'not a url']) await assert.rejects(netFetch(url), TypeError, url);
  await assert.rejects(netFetch('https://example.com/', { redirect: 'whatever' }), TypeError);
  await assert.rejects(netFetch('https://example.com/', { method: 'POST', body: '{}', redirect: 'manual' }), TypeError, 'manual redirects are for credential-free GET downloads only');
  assert.equal(net.fetchCalls.length + net.requests.length, 0);
});

test('abort: already aborted sends nothing; an abort in flight reaches the underlying request', async () => {
  const net = fakeNet({ respond: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true })) });
  const netFetch = createNetFetch(net);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(netFetch('https://example.com/', { signal: aborted.signal }), { name: 'AbortError' });
  await assert.rejects(netFetch('https://example.com/', { signal: aborted.signal, redirect: 'manual' }), { name: 'AbortError' });
  assert.equal(net.fetchCalls.length + net.requests.length, 0);
  const controller = new AbortController();
  const pending = netFetch('https://example.com/', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(net.fetchCalls[0].init.signal.aborted, false);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(net.fetchCalls[0].init.signal.aborted, true);
});

test('cancelling or over-running the body aborts the request (raw net.fetch kept downloading)', async () => {
  let pulls = 0, cancelled = false;
  const endless = () => new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; } }), { status: 200 });
  const net = fakeNet({ respond: async () => endless() });
  const netFetch = createNetFetch(net);
  const response = await netFetch('https://cdn.example-vendor.com/big');
  await assert.rejects(shared.readBounded(response, 256 * 1024), /大小限制/);
  assert.equal(net.fetchCalls[0].init.signal.aborted, true, 'the size cap ends the transfer, not just the reading');
  assert.equal(cancelled, true);
  assert.ok(pulls <= 8, `stopped pulling near the cap (${pulls} chunks)`);
  // Declared too large: cancelled before any read.
  const declared = fakeNet({ respond: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(10)); } }), { headers: { 'content-length': '99999999' } }) });
  const second = await createNetFetch(declared)('https://cdn.example-vendor.com/big');
  await assert.rejects(shared.readBounded(second, 1024), /过大/);
  assert.equal(declared.fetchCalls[0].init.signal.aborted, true);
  // A body read to the end does not abort anything, and the caller's abort listener is released.
  const fine = fakeNet();
  const controller = new AbortController();
  const third = await createNetFetch(fine)('https://api.example-vendor.com/', { signal: controller.signal });
  assert.deepEqual(await third.json(), { ok: true });
  assert.equal(fine.fetchCalls[0].init.signal.aborted, false);
  controller.abort();
  assert.equal(fine.fetchCalls[0].init.signal.aborted, false, 'a finished request is no longer tied to the caller signal');
});

test('status, headers and empty bodies are preserved', async () => {
  const net = fakeNet({ respond: async url => (url.endsWith('/401') ? new Response('{"error":"denied"}', { status: 401, statusText: 'Unauthorized', headers: { 'request-id': 'req_abc12345' } }) : new Response(null, { status: 204 })) });
  const netFetch = createNetFetch(net);
  const denied = await netFetch('https://api.example-vendor.com/401');
  assert.equal(denied.status, 401); assert.equal(denied.ok, false); assert.equal(denied.headers.get('request-id'), 'req_abc12345');
  assert.deepEqual(await denied.json(), { error: 'denied' });
  const empty = await netFetch('https://api.example-vendor.com/204');
  assert.equal(empty.status, 204); assert.equal(empty.body, null);
});

test('redirect "manual": the redirect is reported, not followed, through net.request', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const pending = netFetch('https://bucket.oss-cn-beijing.aliyuncs.com/a.mp3?sig=1', { method: 'GET', redirect: 'manual', headers: { Accept: 'audio/*,application/octet-stream', Host: 'bucket.oss-cn-beijing.aliyuncs.com' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(net.fetchCalls.length, 0);
  const [request] = net.requests;
  assert.deepEqual(request.options, { url: 'https://bucket.oss-cn-beijing.aliyuncs.com/a.mp3?sig=1', method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
  assert.deepEqual(request.headers, { Accept: 'audio/*,application/octet-stream' });
  assert.equal(request.ended, true);
  request.emit('redirect', 302, 'GET', 'https://other.oss-cn-beijing.aliyuncs.com/b.mp3', { location: ['ignored'] });
  request.emit('error', new Error('Redirect was cancelled')); // Electron reports the unfollowed redirect this way
  const response = await pending;
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://other.oss-cn-beijing.aliyuncs.com/b.mp3');
  assert.equal(response.body, null);
});

test('redirect "manual": a normal answer streams, obeys the size cap and aborts on cancel', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const pending = netFetch('https://v1-default.douyinvod.com/a.wav', { redirect: 'manual' });
  await new Promise(resolve => setImmediate(resolve));
  const [request] = net.requests;
  const incoming = Readable.from([Buffer.from('RIFF'), Buffer.alloc(100000), Buffer.alloc(100000), Buffer.alloc(100000)]);
  Object.assign(incoming, { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'audio/wav', 'set-cookie': ['a=1', 'b=2'] } });
  request.emit('response', incoming);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  await assert.rejects(shared.readBounded(response, 150000), /大小限制/);
  assert.equal(request.aborted, true);

  // Small body read completely: no abort.
  const small = netFetch('https://v1-default.douyinvod.com/b.wav', { redirect: 'manual' });
  await new Promise(resolve => setImmediate(resolve));
  const second = net.requests[1];
  const body = Readable.from([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 0])]);
  Object.assign(body, { statusCode: 200, statusMessage: 'OK', headers: {} });
  second.emit('response', body);
  assert.equal((await shared.readAudio(await small)).mimeType, 'audio/flac');
  assert.equal(second.aborted, false);
});

test('redirect "manual": network errors and aborts reject; late events are ignored', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const failing = netFetch('https://v1-default.douyinvod.com/a.wav', { redirect: 'manual' });
  await new Promise(resolve => setImmediate(resolve));
  net.requests[0].emit('error', new Error('net::ERR_CONNECTION_RESET'));
  await assert.rejects(failing, /ERR_CONNECTION_RESET/);

  const controller = new AbortController();
  const aborting = netFetch('https://v1-default.douyinvod.com/a.wav', { redirect: 'manual', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(aborting, { name: 'AbortError' });
  assert.equal(net.requests[1].aborted, true);
  net.requests[1].emit('redirect', 302, 'GET', 'https://evil.test/', {}); // too late to matter
  net.requests[1].emit('error', new Error('aborted'));
});

test('shared.downloadAudio follows an allowed redirect and refuses a hostile one through the wrapper', async () => {
  const net = fakeNet();
  const netFetch = createNetFetch(net);
  const drive = async steps => {
    for (const step of steps) {
      await new Promise(resolve => setImmediate(resolve));
      step(net.requests.at(-1));
    }
  };
  const wav = Buffer.alloc(48); wav.write('RIFF'); wav.write('WAVEfmt ', 8);
  const download = shared.downloadAudio('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=1', { fetchImpl: netFetch, allowedHostSuffixes: ['aliyuncs.com'] });
  await drive([
    request => request.emit('redirect', 302, 'GET', 'https://another.oss-cn-beijing.aliyuncs.com/b.wav', {}),
    request => { const body = Readable.from([wav]); Object.assign(body, { statusCode: 200, statusMessage: 'OK', headers: {} }); request.emit('response', body); },
  ]);
  assert.equal((await download).mimeType, 'audio/wav');
  assert.deepEqual(net.requests.map(request => request.options.url), ['https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=1', 'https://another.oss-cn-beijing.aliyuncs.com/b.wav']);
  for (const request of net.requests) assert.deepEqual(request.headers, { Accept: 'audio/*,application/octet-stream' }, 'no credentials on download hops');

  const hostile = shared.downloadAudio('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav', { fetchImpl: netFetch, allowedHostSuffixes: ['aliyuncs.com'] });
  await drive([request => request.emit('redirect', 307, 'GET', 'https://evil.test/steal', {})]);
  await assert.rejects(hostile, /非官方/);
  assert.equal(net.requests.length, 3, 'the hostile hop is never requested');
});
