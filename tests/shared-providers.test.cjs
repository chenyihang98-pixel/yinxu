'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const shared = require('../electron/providers/shared.cjs');
const aliyun = require('../electron/providers/aliyun.cjs');
const { createMusicService } = require('../electron/music-service.cjs');
const { normalizeCredentials, PROVIDERS } = require('../electron/credentials.cjs');
const { createKeyStore } = require('../electron/key-store.cjs');

const INPUT = { prompt: '青春欢快的校园钢琴背景音乐', duration: 30 };
const KEYS = {
  elevenlabs: { apiKey: 'fake-elevenlabs-key-only', model: 'music_v2_5' },
  tencent: { apiKey: 'fake-tokenhub-key-only', model: 'minimax-music-v2.6' },
  volcengine: { accessKeyId: 'AKIDEXAMPLEFAKE', secretAccessKey: 'fake-volcengine-secret-only', billingMode: 'prepaid' },
  aliyun: { apiKey: 'fake-bailian-key-only', workspaceId: 'workspace-test-123', model: 'fun-music-v1' },
};
const MP3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]);
const WAV = Buffer.alloc(48); WAV.write('RIFF'); WAV.writeUInt32LE(40, 4); WAV.write('WAVEfmt ', 8); WAV.writeUInt32LE(16, 16); WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22); WAV.writeUInt32LE(8000, 24); WAV.writeUInt32LE(16000, 28); WAV.writeUInt16LE(2, 32); WAV.writeUInt16LE(16, 34); WAV.write('data', 36); WAV.writeUInt32LE(4, 40);
const FLAC = Buffer.from('fLaC\x80\x00\x00\x00', 'binary');
const MP4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0]);
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const aliResult = url => json({ output: { finish_reason: 'stop', audio: { url } }, usage: { duration: 31 } });
const aliAudioUrl = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/pre/fun-music/fixture.mp3?signature=fixture';
const allSecrets = Object.values(KEYS).flatMap(value => [value.apiKey, value.accessKeyId, value.secretAccessKey].filter(Boolean));

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from([...Buffer.from(value)].map(byte => byte ^ 0xa7)),
    decryptString: value => Buffer.from([...value].map(byte => byte ^ 0xa7)).toString(),
  };
}
async function fixtureStore(t, safeStorage = fakeSafeStorage()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-provider-keys-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('muse-provider-keys-')) await fs.rm(resolved, { recursive: true, force: true });
  });
  return { directory, filename: path.join(directory, 'music-credentials.json'), store: createKeyStore(directory, safeStorage), safeStorage };
}

test('Aliyun request matches official non-streaming instrumental contract and model selection', () => {
  // https://help.aliyun.com/zh/model-studio/fun-music-api (checked 2026-10-08).
  const request = aliyun.buildRequest(INPUT, KEYS.aliyun);
  assert.equal(request.url, 'https://workspace-test-123.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation');
  assert.deepEqual(request.headers, { Authorization: 'Bearer fake-bailian-key-only', 'Content-Type': 'application/json' });
  assert.deepEqual(request.body, { model: 'fun-music-v1', input: { prompt: `${INPUT.prompt}\n目标时长约 30 秒，以纯音乐自然收尾。`, is_instrumental: true, format: 'mp3' } });
  for (const forbidden of ['duration', 'lyrics', 'gender', 'parameters', 'stream']) {
    assert.equal(Object.hasOwn(request.body, forbidden), false); assert.equal(Object.hasOwn(request.body.input, forbidden), false);
  }
  assert.equal(aliyun.buildRequest({ ...INPUT, model: 'fun-music-preview' }, KEYS.aliyun).body.model, 'fun-music-preview');
  assert.throws(() => aliyun.buildRequest(INPUT, { ...KEYS.aliyun, workspaceId: 'evil.test/path' }), /Workspace/);
  assert.throws(() => aliyun.buildRequest({ ...INPUT, prompt: '一'.repeat(2000) }, KEYS.aliyun), /2000/);
});

test('Aliyun upgrades official HTTP result to HTTPS and downloads with no API authorization', async () => {
  const calls = [];
  const result = await aliyun.generate({ input: INPUT, credentials: KEYS.aliyun, fetchImpl: async (url, options) => {
    calls.push([url, options]); return calls.length === 1 ? aliResult(aliAudioUrl) : new Response(MP3);
  } });
  assert.equal(calls.length, 2); assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[1][0], aliAudioUrl.replace('http:', 'https:'));
  assert.equal(calls[1][1].method, 'GET'); assert.equal(calls[1][1].redirect, 'manual');
  assert.deepEqual(Object.keys(calls[1][1].headers), ['Accept']);
  assert.equal(JSON.stringify(calls[1]).includes(KEYS.aliyun.apiKey), false);
  assert.equal(result.mimeType, 'audio/mpeg'); assert.deepEqual(Buffer.from(result.audio), MP3);
});

test('Aliyun refuses unfinished/error responses and unsafe result domains without retrying generation', async () => {
  for (const response of [
    () => json({ code: 'Forbidden', message: KEYS.aliyun.apiKey }),
    () => json({ output: { finish_reason: null, audio: { url: aliAudioUrl } } }),
    () => json({ output: { finish_reason: 'stop', audio: {} } }),
    () => aliResult('https://aliyuncs.com.evil.test/audio.mp3'),
    () => aliResult('https://127.0.0.1/secret'),
    () => aliResult('https://user:pass@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a'),
    () => aliResult('file:///C:/private.wav'),
  ]) {
    let calls = 0;
    await assert.rejects(aliyun.generate({ input: INPUT, credentials: KEYS.aliyun, fetchImpl: async () => { calls++; return response(); } }), error => !error.message.includes(KEYS.aliyun.apiKey));
    assert.equal(calls, 1);
  }
});

test('Shared download validates every redirect and strips API auth across allowed redirects', async () => {
  const calls = [];
  const result = await shared.downloadAudio(aliAudioUrl, { allowedHostSuffixes: ['aliyuncs.com'], fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return calls.length === 1 ? new Response('', { status: 302, headers: { Location: 'http://another-result.oss-cn-beijing.aliyuncs.com/next.wav' } }) : new Response(WAV);
  } });
  assert.equal(calls[1][0], 'https://another-result.oss-cn-beijing.aliyuncs.com/next.wav');
  assert.equal(result.mimeType, 'audio/wav');
  for (const [, options] of calls) assert.deepEqual(options.headers, { Accept: 'audio/*,application/octet-stream' });
  let unsafeCalls = 0;
  await assert.rejects(shared.downloadAudio(aliAudioUrl, { allowedHostSuffixes: ['aliyuncs.com'], fetchImpl: async () => {
    unsafeCalls++; return new Response('', { status: 307, headers: { location: 'https://evil.test/secret' } });
  } }), /非官方/);
  assert.equal(unsafeCalls, 1);
});

test('Shared format detection supports MP3 WAV FLAC MP4 and never leaks pooled Buffer bytes', async () => {
  for (const [payload, type] of [[MP3, 'audio/mpeg'], [WAV, 'audio/wav'], [FLAC, 'audio/flac'], [MP4, 'audio/mp4']]) {
    const envelope = Buffer.concat([Buffer.from('SECRET_PREFIX'), payload, Buffer.from('SECRET_SUFFIX')]);
    const view = envelope.subarray(13, 13 + payload.length);
    const decoded = shared.decodeAudioBytes(view);
    assert.equal(decoded.mimeType, type); assert.deepEqual(Buffer.from(decoded.audio), payload);
    const result = await shared.readAudio(new Response(payload, { headers: { 'Content-Type': 'application/octet-stream' } }));
    assert.equal(result.mimeType, type);
  }
  assert.throws(() => shared.decodeAudioBytes(Buffer.from('<html>error</html>')), /格式/);
});

test('Shared reads bound headers, streams and JSON; statuses do not leak raw body secrets', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(shared.readBounded(new Response(stream, { headers: { 'Content-Length': '9999' } }), 100), /过大/);
  assert.equal(cancelled, true);
  await assert.rejects(shared.readAudio(new Response(MP3), 4), /大小限制/);
  await assert.rejects(shared.requestJson(async () => json({ data: 'x'.repeat(200) }), 'https://example.invalid', { method: 'GET' }, { maxBytes: 100 }), /大小限制/);
  for (const status of [401, 402, 403, 429, 500]) {
    await assert.rejects(shared.requestJson(async () => new Response(KEYS.tencent.apiKey, { status }), 'https://example.invalid', {}), error => !error.message.includes(KEYS.tencent.apiKey));
  }
  for (const body of ['null', '[]', 'broken']) await assert.rejects(shared.requestJson(async () => new Response(body), 'https://example.invalid', {}), /无效结果/);
});

test('Shared cancellation prevents both initial and follow-up network requests', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(shared.downloadAudio(aliAudioUrl, { signal: controller.signal, allowedHostSuffixes: ['aliyuncs.com'], fetchImpl: async () => { calls++; return new Response(MP3); } }));
  await assert.rejects(shared.requestJson(async () => { calls++; return json({}); }, 'https://example.invalid', { signal: controller.signal }));
  assert.equal(calls, 0);
  const second = new AbortController();
  await assert.rejects(aliyun.generate({ input: INPUT, credentials: KEYS.aliyun, signal: second.signal, fetchImpl: async () => { calls++; second.abort(); return aliResult(aliAudioUrl); } }));
  assert.equal(calls, 1, 'cancellation after API response must not start CDN download');
});

test('Aggregate routes all four providers with saved model and selected credentials', async () => {
  for (const provider of PROVIDERS) {
    const calls = [];
    const service = createMusicService({ fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (provider === 'elevenlabs') return new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } });
      if (provider === 'tencent') return json({ base_resp: { status_code: 0 }, data: { status: 2, audio: MP3.toString('hex') } });
      if (provider === 'aliyun') return calls.length === 1 ? aliResult(aliAudioUrl) : new Response(MP3);
      if (calls.length === 1) return json({ Code: 0, Result: { TaskID: 'test-task' } });
      if (calls.length === 2) return json({ Code: 0, Result: { Status: 2, SongDetail: { AudioUrl: 'https://v1-default.douyinvod.com/test.wav' } } });
      return new Response(WAV);
    } });
    const result = await service.generate({ ...INPUT, provider }, KEYS[provider]);
    assert.ok(result.audio instanceof ArrayBuffer); assert.equal(service.busy, false);
    const [url, options] = calls[0]; const body = JSON.parse(options.body);
    if (provider === 'elevenlabs') { assert.match(url, /^https:\/\/api.elevenlabs.io\//); assert.equal(body.model_id, KEYS.elevenlabs.model); assert.equal(options.headers['xi-api-key'], KEYS.elevenlabs.apiKey); }
    if (provider === 'tencent') { assert.equal(url, 'https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation'); assert.equal(body.model, KEYS.tencent.model); }
    if (provider === 'aliyun') { assert.match(url, /^https:\/\/workspace-test-123.cn-beijing.maas.aliyuncs.com\//); assert.equal(body.model, KEYS.aliyun.model); }
    if (provider === 'volcengine') { assert.match(url, /Action=GenBGM&/); assert.match(options.headers.Authorization, /AKIDEXAMPLEFAKE/); }
  }
});

test('Aggregate blocks cross-provider duplicate billing until cancellation settles', async () => {
  let requests = 0;
  const service = createMusicService({ fetchImpl: (_url, { signal }) => {
    requests++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }));
  } });
  const first = service.generate({ ...INPUT, provider: 'tencent' }, KEYS.tencent);
  await assert.rejects(service.generate({ ...INPUT, provider: 'aliyun' }, KEYS.aliyun), /正在生成/);
  service.cancel();
  await assert.rejects(service.generate({ ...INPUT, provider: 'volcengine' }, KEYS.volcengine), /正在生成/);
  await assert.rejects(first, /已取消/);
  assert.equal(requests, 1); assert.equal(service.busy, false);
});

test('Aggregate discards late adapter success after cancellation or timeout', async () => {
  for (const provider of ['tencent', 'aliyun', 'volcengine']) {
    const adapter = require(`../electron/providers/${provider}.cjs`);
    const original = adapter.generate;
    try {
      let release;
      adapter.generate = () => new Promise(resolve => { release = resolve; });
      const service = createMusicService();
      const pending = service.generate({ ...INPUT, provider }, KEYS[provider]);
      service.cancel(); release({ audio: MP3.buffer, mimeType: 'audio/mpeg' });
      await assert.rejects(pending, /已取消/); assert.equal(service.busy, false);
      adapter.generate = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { audio: MP3.buffer, mimeType: 'audio/mpeg' }; };
      const timed = createMusicService({ timeoutMs: 5 });
      await assert.rejects(timed.generate({ ...INPUT, provider }, KEYS[provider]), /超过 5 分钟/);
      assert.equal(timed.busy, false);
    } finally { adapter.generate = original; }
  }
});

test('Credential defaults match real provider model IDs and reject untrusted provider paths', () => {
  assert.equal(normalizeCredentials('tencent', { apiKey: KEYS.tencent.apiKey }).model, 'minimax-music-v3.0');
  assert.equal(normalizeCredentials('aliyun', { apiKey: KEYS.aliyun.apiKey, workspaceId: 'workspace-1' }).model, 'fun-music-preview');
  assert.equal(normalizeCredentials('volcengine', { accessKeyId: KEYS.volcengine.accessKeyId, secretAccessKey: KEYS.volcengine.secretAccessKey }).billingMode, 'postpaid');
  assert.throws(() => normalizeCredentials('../main', KEYS.tencent), /不支持/);
  assert.throws(() => normalizeCredentials('tencent', { ...KEYS.tencent, model: 'music-2.6' }), /模型/);
  assert.throws(() => normalizeCredentials('aliyun', { ...KEYS.aliyun, workspaceId: '../private' }), /Workspace/);
});

test('Four-provider encrypted saves are isolated, serialized, and expose only nonsensitive status', async t => {
  const { filename, store } = await fixtureStore(t);
  await Promise.all(PROVIDERS.map(provider => store.saveCredentials(provider, KEYS[provider])));
  for (const provider of PROVIDERS) assert.deepEqual(await store.getCredentials(provider), KEYS[provider]);
  const statuses = await store.getStatuses();
  assert.deepEqual(statuses, {
    elevenlabs: { configured: true, model: 'music_v2_5' },
    tencent: { configured: true, model: 'minimax-music-v2.6' },
    volcengine: { configured: true, billingMode: 'prepaid' },
    aliyun: { configured: true, model: 'fun-music-v1', workspaceId: 'workspace-test-123' },
  });
  const raw = await fs.readFile(filename, 'utf8');
  for (const secret of allSecrets) { assert.equal(raw.includes(secret), false); assert.equal(JSON.stringify(statuses).includes(secret), false); }
  await store.saveCredentials('tencent', { apiKey: 'replacement-tokenhub-key', model: 'minimax-music-v3.0' });
  await store.deleteCredentials('volcengine');
  assert.equal(await store.hasKey('volcengine'), false);
  assert.equal((await store.getCredentials('tencent')).apiKey, 'replacement-tokenhub-key');
  assert.deepEqual(await store.getCredentials('elevenlabs'), KEYS.elevenlabs);
  assert.deepEqual(await store.getCredentials('aliyun'), KEYS.aliyun);
  await store.deleteKey();
  assert.equal(await store.hasKey('elevenlabs'), false); assert.equal(await store.hasKey('tencent'), true); assert.equal(await store.hasKey('aliyun'), true);
});

test('V1 migration retains existing ElevenLabs key while adding another provider', async t => {
  const { filename, store, safeStorage } = await fixtureStore(t);
  const legacyKey = 'legacy-elevenlabs-secret-key';
  const legacy = JSON.stringify({ version: 1, encryptedApiKey: safeStorage.encryptString(legacyKey).toString('base64') });
  await fs.writeFile(filename, legacy);
  assert.equal(await store.hasKey(), true); assert.equal(await store.getKey(), legacyKey);
  await store.deleteCredentials('tencent'); assert.equal(await fs.readFile(filename, 'utf8'), legacy);
  await store.saveCredentials('aliyun', KEYS.aliyun);
  const migrated = JSON.parse(await fs.readFile(filename, 'utf8'));
  assert.equal(migrated.version, 2); assert.deepEqual(Object.keys(migrated.providers).sort(), ['aliyun', 'elevenlabs']);
  assert.equal(await store.getKey(), legacyKey); assert.deepEqual(await store.getCredentials('aliyun'), KEYS.aliyun);
  await store.deleteCredentials('aliyun'); assert.equal(await store.getKey(), legacyKey);
});

test('Failed decryption or unavailable encryption cannot overwrite existing credentials', async t => {
  const { filename, directory, store } = await fixtureStore(t);
  await store.saveCredentials('tencent', KEYS.tencent);
  const original = await fs.readFile(filename, 'utf8');
  const unavailable = createKeyStore(directory, fakeSafeStorage(false));
  await assert.rejects(unavailable.saveCredentials('aliyun', KEYS.aliyun), /系统密钥保护/);
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  await assert.rejects(store.saveCredentials('aliyun', { ...KEYS.aliyun, apiKey: 'bad' }));
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  const legacy = JSON.stringify({ version: 1, encryptedApiKey: 'c2VjcmV0' });
  await fs.writeFile(filename, legacy);
  const broken = createKeyStore(directory, { ...fakeSafeStorage(), decryptString() { throw new Error('OS could not decrypt'); } });
  await assert.rejects(broken.saveCredentials('aliyun', KEYS.aliyun), /无法解密/);
  assert.equal(await fs.readFile(filename, 'utf8'), legacy);
  await broken.deleteCredentials('elevenlabs');
  assert.equal(await broken.hasKey(), false, 'selected broken legacy entry can still be removed');
});
