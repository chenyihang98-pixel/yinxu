'use strict';

// Regression tests for the v0.2 audit findings in the cloud-music path:
// F14 (lock before credentials), F04 (vendor error codes / request ids), F15 (Aliyun OSS-only downloads).
const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../electron/providers/shared.cjs');
const aliyun = require('../electron/providers/aliyun.cjs');
const tencent = require('../electron/providers/tencent.cjs');
const { createMusicService, isAllowedExternal } = require('../electron/music-service.cjs');

const { MusicError } = shared;
const INPUT = { prompt: '青春欢快的校园钢琴背景音乐', duration: 30 };
const KEY = 'test-secret-api-key-not-real';
const MP3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]);
const ALIYUN = { apiKey: 'fake-bailian-key-only', workspaceId: 'workspace-test-123', model: 'fun-music-v1' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const audioResponse = () => new Response(MP3, { headers: { 'Content-Type': 'audio/mpeg' } });

/* ------------------------------------------------------------------- F14 */

test('F14: the lock is taken before credentials are read, so a cancel during the read cancels the job', async () => {
  let fetches = 0;
  const service = createMusicService({ fetchImpl: async () => { fetches++; return audioResponse(); } });
  let finishRead;
  const pending = service.generate(INPUT, () => new Promise(resolve => { finishRead = resolve; }));
  assert.equal(service.busy, true, 'busy as soon as generate() is called, before the key store answers');
  await assert.rejects(service.generate(INPUT, KEY), /正在生成/, 'a second request cannot slip in during the read');
  service.cancel();
  finishRead(KEY);
  await assert.rejects(pending, /已取消等待生成/);
  assert.equal(fetches, 0, 'nothing is sent, so nothing can be billed');
  assert.equal(service.busy, false);
});

test('F14: a credential loader works like a value, and its failures release the lock with a safe message', async () => {
  const calls = [];
  const service = createMusicService({ fetchImpl: async (...args) => { calls.push(args); return audioResponse(); } });
  let reads = 0;
  const result = await service.generate(INPUT, async () => { reads++; return { apiKey: KEY, model: 'music_v2' }; });
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(reads, 1);
  assert.equal(calls[0][1].headers['xi-api-key'], KEY);
  assert.equal(JSON.parse(calls[0][1].body).model_id, 'music_v2');

  await assert.rejects(service.generate(INPUT, async () => { throw new MusicError('请先在设置中填写所选音乐服务的凭据。'); }), /请先在设置中填写所选音乐服务的凭据/);
  assert.equal(service.busy, false);
  await assert.rejects(service.generate(INPUT, async () => { throw new Error(`EPERM: operation not permitted, open 'C:\\Users\\me\\music-credentials.json' ${KEY}`); }), error => error instanceof MusicError && !error.message.includes(KEY) && !/EPERM|Users/.test(error.message));
  assert.equal(service.busy, false);
  await assert.rejects(service.generate(INPUT, () => 'bad\r\nkey'), /API Key 格式不正确/);
  assert.equal(service.busy, false);
  assert.equal(calls.length, 1);

  // Input is still validated before the loader runs.
  let wasted = 0;
  await assert.rejects(service.generate({ ...INPUT, duration: 1 }, () => { wasted++; return KEY; }));
  await assert.rejects(service.generate({ ...INPUT, provider: '../main' }, () => { wasted++; return KEY; }), /不支持/);
  assert.equal(wasted, 0);
});

test('F14: a key store that never answers cannot hold the lock: timeout and cancel both release it', async () => {
  let fetches = 0;
  const service = createMusicService({ timeoutMs: 20, fetchImpl: async () => { fetches++; return audioResponse(); } });
  await assert.rejects(service.generate(INPUT, () => new Promise(() => {})), /超过 5 分钟/);
  assert.equal(service.busy, false);
  const patient = createMusicService({ fetchImpl: async () => { fetches++; return audioResponse(); } });
  const pending = patient.generate(INPUT, () => new Promise(() => {}));
  patient.cancel();
  await assert.rejects(pending, /已取消等待生成/);
  assert.equal(patient.busy, false);
  assert.equal(fetches, 0);
  // The service is usable again straight away.
  assert.equal((await patient.generate(INPUT, KEY)).mimeType, 'audio/mpeg');
});

/* ------------------------------------------------------------------- F04 */

test('F04: requestJson keeps discarding error bodies unless the adapter opts in', async () => {
  const body = { code: 'Arrearage', message: `raw text ${KEY}`, request_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' };
  await assert.rejects(shared.requestJson(async () => json(body, 400), 'https://example.invalid', {}), error => error.message === shared.httpMessage(400) && error.status === 400);
  const seen = [];
  await assert.rejects(shared.requestJson(async () => json(body, 400), 'https://example.invalid', {}, { onHttpError: details => { seen.push(details); return '自定义的安全文案。'; } }), error => error instanceof MusicError && error.message === '自定义的安全文案。' && error.status === 400);
  assert.equal(seen[0].status, 400);
  assert.deepEqual(seen[0].body, body);
  assert.equal(typeof seen[0].headers.get, 'function');
  // A mapper that returns nothing, throws, or returns a non-string falls back to the status text.
  for (const onHttpError of [() => undefined, () => '', () => { throw new Error('mapper bug'); }, () => ({ message: 'x' }), () => 42]) {
    await assert.rejects(shared.requestJson(async () => json(body, 403), 'https://example.invalid', {}, { onHttpError }), error => error.message === shared.httpMessage(403));
  }
  // Bodies that are not a JSON object, or are larger than 64 KiB, arrive as null and are never buffered whole.
  for (const response of [() => new Response('<html>', { status: 500 }), () => new Response('[1]', { status: 500 }), () => new Response('', { status: 500 }), () => new Response(`{"x":"${'y'.repeat(70000)}"}`, { status: 500 })]) {
    let received = 'unset';
    await assert.rejects(shared.requestJson(async () => response(), 'https://example.invalid', {}, { onHttpError: ({ body: parsed }) => { received = parsed; } }));
    assert.equal(received, null);
  }
  assert.equal(shared.safeReference('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  for (const bad of ['short', 'has space inside id', '<script>alert(1)</script>', 'x'.repeat(81), 42, null, undefined, { id: 'x' }]) assert.equal(shared.safeReference(bad), '');
  assert.equal(shared.withReference('消息。', '请求编号', 'req_12345678'), '消息。（请求编号 req_12345678）');
  assert.equal(shared.withReference('消息。', '请求编号', 'bad id'), '消息。');
});

test('F04: Aliyun maps enumerated DashScope codes on HTTP errors and quotes the request id', async () => {
  const REQUEST_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const cases = [
    [400, 'Arrearage', /账户已欠费/],
    [400, 'DataInspectionFailed', /内容安全审核/],
    [401, 'InvalidApiKey', /API Key 无效.*北京地域/],
    [429, 'Throttling.RateQuota', /限流或额度不足/],
    [429, 'Throttling', /限流或额度不足/],
    [403, 'AccessDenied.Unpurchased', /没有 Fun-Music 模型的使用权限/],
    [403, 'Model.AccessDenied', /没有 Fun-Music 模型的使用权限/],
    [400, 'InvalidParameter', /音乐服务未接受参数/], // not enumerated: status text
    [500, 'InternalError', /暂时不可用/],
  ];
  for (const [status, code, expected] of cases) {
    let calls = 0;
    await assert.rejects(aliyun.generate({ input: INPUT, credentials: ALIYUN, fetchImpl: async () => { calls++; return json({ code, message: `raw ${ALIYUN.apiKey}`, request_id: REQUEST_ID }, status); } }), error => {
      assert.match(error.message, expected, `${status} ${code}`);
      assert.ok(error.message.endsWith(`（请求编号 ${REQUEST_ID}）`), error.message);
      assert.equal(error.message.includes(ALIYUN.apiKey), false);
      assert.equal(error.message.includes('raw'), false);
      return true;
    });
    assert.equal(calls, 1, 'a billable request is never repeated');
  }
  // HTTP 200 with an error code, and an unfinished answer, also carry the id.
  await assert.rejects(aliyun.generate({ input: INPUT, credentials: ALIYUN, fetchImpl: async () => json({ code: 'DataInspectionFailed', message: 'x', request_id: REQUEST_ID }) }), error => /内容安全审核/.test(error.message) && error.message.includes(REQUEST_ID));
  await assert.rejects(aliyun.generate({ input: INPUT, credentials: ALIYUN, fetchImpl: async () => json({ code: 'SomethingElse', request_id: REQUEST_ID }) }), error => /百炼未完成音乐生成/.test(error.message) && error.message.includes(REQUEST_ID));
  await assert.rejects(aliyun.generate({ input: INPUT, credentials: ALIYUN, fetchImpl: async () => json({ output: { finish_reason: null }, request_id: REQUEST_ID }) }), error => /未返回完整音乐文件/.test(error.message) && error.message.includes(REQUEST_ID));
  await assert.rejects(aliyun.generate({ input: INPUT, credentials: ALIYUN, fetchImpl: async () => json({ code: 'Arrearage', request_id: `<img src=x onerror=${ALIYUN.apiKey}>` }, 400) }), error => /账户已欠费/.test(error.message) && !error.message.includes('请求编号'));
});

test('F04: Tencent maps base_resp codes on HTTP errors and quotes the trace id', async () => {
  const TRACE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
  const credentials = { apiKey: 'tokenhub-unit-test-key-only' };
  const cases = [
    [401, { base_resp: { status_code: 1004, status_msg: `raw ${credentials.apiKey}` }, trace_id: TRACE }, /TokenHub API Key 无效/],
    [402, { base_resp: { status_code: 1008 }, trace_id: TRACE }, /余额或音乐额度不足/],
    [429, { base_resp: { status_code: 1002 }, trace_id: TRACE }, /触发限流/],
    [400, { base_resp: { status_code: 1026 }, trace_id: TRACE }, /内容审核/],
    [400, { base_resp: { status_code: 2013, trace_id: TRACE } }, /未接受音乐参数/],
    [500, { trace_id: TRACE }, /暂时不可用/],
    [403, { request_id: TRACE }, /没有音乐模型访问权限/],
  ];
  for (const [status, body, expected] of cases) {
    let calls = 0;
    await assert.rejects(tencent.generate({ input: INPUT, credentials, fetchImpl: async () => { calls++; return json(body, status); } }), error => {
      assert.match(error.message, expected, `HTTP ${status}`);
      assert.ok(error.message.endsWith(`（追踪编号 ${TRACE}）`), error.message);
      assert.equal(error.message.includes(credentials.apiKey), false);
      return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(tencent.generate({ input: INPUT, credentials, fetchImpl: async () => json({ base_resp: { status_code: 1008, status_msg: 'x' }, trace_id: TRACE }) }), error => /余额或音乐额度不足/.test(error.message) && error.message.includes(TRACE));
  await assert.rejects(tencent.generate({ input: INPUT, credentials, fetchImpl: async () => new Response('gateway', { status: 502 }) }), error => /暂时不可用/.test(error.message) && !error.message.includes('追踪编号'));
});

/* ------------------------------------------------------------------- F15 */

test('F15: Aliyun result downloads are limited to OSS bucket hosts, on every hop', async () => {
  const allowed = ['dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 'another-result.oss-cn-beijing.aliyuncs.com', 'dashscope-result-wlcb-acdr-1.oss-cn-wulanchabu-acdr-1.aliyuncs.com', 'bucket123.oss-accelerate.aliyuncs.com'];
  const refused = [
    'attacker.cn-shanghai.fc.aliyuncs.com', 'anything.cn-beijing.maas.aliyuncs.com', 'oss-cn-beijing.aliyuncs.com', 'oss-cn-beijing-internal.aliyuncs.com',
    'bucket.oss-cn-beijing-internal.aliyuncs.com', 'a.b.oss-cn-beijing.aliyuncs.com', 'bucket.oss-cn-beijing.aliyuncs.com.evil.test', 'aliyuncs.com', 'ecs.aliyuncs.com', 'bucket.OSS-cn-beijing.aliyuncs.com.',
  ];
  for (const host of allowed) assert.equal(aliyun.isOssHost(host), true, host);
  for (const host of refused) assert.equal(aliyun.isOssHost(host), false, host);

  const result = url => json({ output: { finish_reason: 'stop', audio: { url } }, request_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
  for (const host of allowed) {
    const calls = [];
    const audio = await aliyun.generate({ input: INPUT, credentials: ALIYUN, fetchImpl: async (url, options) => { calls.push([url, options]); return calls.length === 1 ? result(`http://${host}/pre/fun-music/a.mp3?Signature=x`) : new Response(MP3); } });
    assert.equal(audio.mimeType, 'audio/mpeg');
    assert.equal(calls[1][0], `https://${host}/pre/fun-music/a.mp3?Signature=x`);
  }
  for (const host of refused) {
    let calls = 0;
    await assert.rejects(aliyun.generate({ input: INPUT, credentials: ALIYUN, fetchImpl: async () => { calls++; return calls === 1 ? result(`https://${host}/a.mp3`) : new Response(MP3); } }), /非官方音频下载地址|下载地址无效/, host);
    assert.equal(calls, 1, `${host}: nothing is fetched from a host outside OSS`);
  }
  // A redirect from an OSS host to another aliyuncs.com product is refused as well.
  let hops = 0;
  await assert.rejects(aliyun.generate({ input: INPUT, credentials: ALIYUN, fetchImpl: async () => {
    hops++;
    if (hops === 1) return result('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.mp3');
    return new Response('', { status: 302, headers: { location: 'https://attacker.cn-shanghai.fc.aliyuncs.com/a.mp3' } });
  } }), /非官方/);
  assert.equal(hops, 2);
  // The shared helper without a predicate behaves as before.
  const legacy = await shared.downloadAudio('https://anything.cn-shanghai.fc.aliyuncs.com/a.mp3', { allowedHostSuffixes: ['aliyuncs.com'], fetchImpl: async () => new Response(MP3) });
  assert.equal(legacy.mimeType, 'audio/mpeg');
  await assert.rejects(shared.downloadAudio('https://bucket.oss-cn-beijing.aliyuncs.com/a.mp3', { allowedHostSuffixes: ['aliyuncs.com'], hostAllowed: () => 'yes', fetchImpl: async () => new Response(MP3) }), /非官方/, 'only an explicit true opens the gate');
});

/* --------------------------------------------------------------- external links */

test('external link allowlist covers the LLM key pages and still matches exactly', () => {
  for (const url of [
    'https://platform.claude.com/settings/keys', 'https://console.anthropic.com/settings/keys', 'https://platform.deepseek.com/api_keys', 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', 'https://platform.moonshot.cn/console/api-keys',
    'https://cloud.siliconflow.cn/account/ak', 'https://platform.openai.com/api-keys', 'https://openrouter.ai/settings/keys', 'https://ollama.com/download', 'https://ollama.com/library',
    'https://console.cloud.tencent.com/tokenhub', 'https://elevenlabs.io/app/settings/api-keys',
  ]) assert.equal(isAllowedExternal(url), true, url);
  for (const url of ['https://platform.claude.com/', 'https://platform.claude.com/settings/keys/', 'https://platform.claude.com/settings/keys?next=https://evil.test', 'http://ollama.com/download', 'https://ollama.com.evil.test/download', 'https://api.deepseek.com', 'ollama://run', null, undefined, 42]) {
    assert.equal(isAllowedExternal(url), false, String(url));
  }
});
