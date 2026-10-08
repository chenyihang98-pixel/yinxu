'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = require('../electron/agent/anthropic.cjs');
const { createAgentService } = require('../electron/agent-service.cjs');
const { PLAN_SCHEMA, buildSystemPrompt, validatePlanInput } = require('../electron/agent/plan-schema.cjs');

const KEY = 'sk-ant-fake-key-for-tests-only';
const CURRENT = { style: 'bright', instrument: 'piano', key: 'C major', bpm: 112, duration: 30, energy: 0.62, complexity: 0.5, reverb: 0.25, loop: true, volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 } };
const RAW_INPUT = { mode: 'refine', request: '再慢一点，换成钢琴', provider: 'local', history: [{ role: 'user', text: '雨天咖啡馆里的慵懒爵士' }, { role: 'agent', text: '好的，已编排。' }], current: CURRENT };
const INPUT = validatePlanInput(RAW_INPUT);
const PLAN = {
  reply: '已经放慢，并换成了钢琴。', title: '雨天特调', style: 'jazz', instrument: 'piano', key: 'F major', bpm: 76, duration: 60,
  energy: 0.35, complexity: 0.6, reverb: 0.35, loop: true, newMelody: false, volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
  arrangement: { progression: ['ii7', 'V7', 'Imaj7', 'vi7'], form: [], drums: 'none', bass: 'walking', swing: 0.4, layers: { pad: true, arp: false, counter: false, perc: false }, melody: { density: -1, register: 'mid', motion: 'stepwise' } },
  reasoning: ['放慢速度', '主奏换成钢琴'], cloudPrompt: '慵懒的咖啡馆爵士，钢琴主奏，76 BPM，纯音乐，无人声，无歌词。',
};
const settings = (model = 'claude-opus-5-5') => ({ kind: 'anthropic', preset: 'claude', apiKey: KEY, model, baseUrl: '' });
const REQUEST_ID = 'req_011CSHoEeqs5C35K2UUqR7Fy';

function message({ text = JSON.stringify(PLAN), model = 'claude-opus-5-5', stop_reason = 'end_turn', content } = {}) {
  return new Response(JSON.stringify({
    id: 'msg_01', type: 'message', role: 'assistant', model, stop_reason, stop_sequence: null,
    content: content ?? [{ type: 'text', text }], usage: { input_tokens: 2200, output_tokens: 480 },
  }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': REQUEST_ID } });
}
function apiError(status, type, text = `upstream detail that must not leak ${KEY}`) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: text }, request_id: REQUEST_ID }), { status, headers: { 'content-type': 'application/json', 'request-id': REQUEST_ID, 'retry-after-ms': '1' } });
}
/** A fetch mock that records each request the SDK makes. */
function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, redirect: init.redirect, signal: init.signal, headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}
const plan = (fetchImpl, extra = {}) => anthropic.plan({ settings: settings(), input: INPUT, fetchImpl, ...extra });
const safe = error => error.name === 'MusicError' && !error.message.includes(KEY) && !error.message.includes('upstream detail');

test('Claude Opus 5.5 / Sonnet 5.5: exact request through the SDK on the beta endpoint with server-side fallback', async () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    const { calls, fetchImpl } = recorder(() => message({ model }));
    const controller = new AbortController();
    const result = await anthropic.plan({ settings: settings(model), input: INPUT, fetchImpl, signal: controller.signal });
    assert.deepEqual(result, { plan: PLAN, model });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages?beta=true');
    assert.equal(call.method, 'POST');
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(call.headers['x-api-key'], KEY);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(call.body, {
      model,
      max_tokens: 16000,
      system: buildSystemPrompt(),
      messages: [
        { role: 'user', content: '雨天咖啡馆里的慵懒爵士' },
        { role: 'assistant', content: '好的，已编排。' },
        { role: 'user', content: `【模式】refine（修改当前作品）\n【生成方式】本地合成引擎\n【当前设置】${JSON.stringify(CURRENT)}\n【用户的话】\n<<<\n再慢一点，换成钢琴\n>>>` },
      ],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: JSON.parse(JSON.stringify(PLAN_SCHEMA)) } },
      fallbacks: 'default',
    });
    // Parameters current models reject, and no assistant prefill.
    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools', 'stream', 'betas', 'output_format']) assert.equal(banned in call.body, false, banned);
    assert.equal(call.body.messages.at(-1).role, 'user');
  }
});

test('Claude Haiku 5.5: same body on the stable endpoint, without betas or fallbacks', async () => {
  const { calls, fetchImpl } = recorder(() => message({ model: 'claude-haiku-5-5' }));
  const result = await anthropic.plan({ settings: settings('claude-haiku-5-5'), input: INPUT, fetchImpl });
  assert.deepEqual(result, { plan: PLAN, model: 'claude-haiku-5-5' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['anthropic-beta'], undefined);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
  assert.equal(calls[0].body.max_tokens, 16000);
  assert.deepEqual(calls[0].body.output_config, { effort: 'medium', format: { type: 'json_schema', schema: JSON.parse(JSON.stringify(PLAN_SCHEMA)) } });
});

test('client options: official SDK, pinned host, one retry, 90 s; environment variables cannot redirect the key', async t => {
  const saved = {};
  for (const [name, value] of Object.entries({ ANTHROPIC_BASE_URL: 'https://evil.test/proxy', ANTHROPIC_AUTH_TOKEN: 'env-oauth-token', ANTHROPIC_API_KEY: 'sk-ant-env-key-must-not-be-used' })) { saved[name] = process.env[name]; process.env[name] = value; }
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  let options;
  class Spy extends Anthropic { constructor(given) { options = given; super(given); } }
  const { calls, fetchImpl } = recorder(() => message());
  await plan(fetchImpl, { Anthropic: Spy });
  assert.equal(options.apiKey, KEY);
  assert.equal(options.authToken, null);
  assert.equal(options.baseURL, 'https://api.anthropic.com');
  assert.equal(options.maxRetries, 1);
  assert.equal(options.timeout, 90000);
  assert.equal(typeof options.fetch, 'function');
  assert.notEqual(options.fetch, fetchImpl, 'the SDK gets the guarded fetch, not the raw one');
  assert.equal(new URL(calls[0].url).origin, 'https://api.anthropic.com');
  assert.equal(calls[0].headers['x-api-key'], KEY);
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(JSON.stringify(calls).includes('env-'), false);
  // The default export of the installed package is the Anthropic class the adapter uses.
  assert.equal(typeof Anthropic, 'function');
  assert.equal(Anthropic.Anthropic, Anthropic.default);
  const real = recorder(() => message());
  assert.deepEqual(await plan(real.fetchImpl), { plan: PLAN, model: 'claude-opus-5-5' });
});

test('result: the model named by the response is returned (a fallback model may have answered)', async () => {
  const fallback = recorder(() => message({ model: 'claude-opus-4-8' }));
  assert.equal((await plan(fallback.fetchImpl)).model, 'claude-opus-4-8');
  for (const model of [undefined, null, '', 'not a model id', 'x'.repeat(300)]) {
    const odd = recorder(() => message({ model }));
    assert.equal((await plan(odd.fetchImpl)).model, 'claude-opus-5-5', String(model));
  }
  // Thinking and fallback blocks may precede the answer: the first text block is the plan.
  const blocks = recorder(() => message({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: JSON.stringify(PLAN) }, { type: 'text', text: 'ignored' }] }));
  assert.deepEqual((await plan(blocks.fetchImpl)).plan, PLAN);
  // Unknown fields from the model are dropped by validation.
  const extra = recorder(() => message({ text: JSON.stringify({ ...PLAN, secret: 'x', arrangement: { ...PLAN.arrangement, solo: true } }) }));
  assert.deepEqual((await plan(extra.fetchImpl)).plan, PLAN);
});

test('stop_reason is checked before the content: refusal and max_tokens', async () => {
  const refusal = recorder(() => message({ stop_reason: 'refusal', content: [] }));
  await assert.rejects(plan(refusal.fetchImpl), error => safe(error) && /拒绝了这次请求/.test(error.message));
  assert.equal(refusal.calls.length, 1, 'a refusal is not retried');
  // Even when a refusal carries schema-valid text, it is not used.
  const refusalWithText = recorder(() => message({ stop_reason: 'refusal' }));
  await assert.rejects(plan(refusalWithText.fetchImpl), /拒绝了这次请求/);
  const cut = recorder(() => message({ stop_reason: 'max_tokens', text: JSON.stringify(PLAN).slice(0, 200) }));
  await assert.rejects(plan(cut.fetchImpl), error => safe(error) && /被截断/.test(error.message));
  const cutButComplete = recorder(() => message({ stop_reason: 'max_tokens' }));
  await assert.rejects(plan(cutButComplete.fetchImpl), /被截断/);
  assert.equal(cut.calls.length, 1);
});

test('malformed answers never reach the caller', async () => {
  for (const response of [
    () => message({ text: '这是我为你设计的方案：{"style":"jazz"' }),
    () => message({ text: 'not json at all' }),
    () => message({ text: '' }),
    () => message({ content: [] }),
    () => message({ content: [{ type: 'thinking', thinking: 'only thinking', signature: 's' }] }),
    () => message({ content: [{ type: 'text' }] }),
    () => message({ text: JSON.stringify([PLAN]) }),
    () => message({ text: JSON.stringify({ ...PLAN, style: 'lofi' }) }),
    () => message({ text: JSON.stringify({ ...PLAN, bpm: '76' }) }),
    () => message({ text: JSON.stringify({ reply: '只有一句话' }) }),
    () => new Response('<html>gateway page</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }),
  ]) {
    const { calls, fetchImpl } = recorder(response);
    await assert.rejects(plan(fetchImpl), safe);
    assert.equal(calls.length, 1);
  }
});

test('HTTP errors map to fixed Chinese messages through the SDK error classes; raw text never leaks', async () => {
  const cases = [
    [401, 'authentication_error', /API Key 无效或已过期/, 1],
    [403, 'permission_error', /没有使用这个 Claude 模型的权限/, 1],
    [404, 'not_found_error', /模型当前不可用/, 1],
    [402, 'billing_error', /余额不足/, 1],
    [413, 'request_too_large', /内容太长/, 1],
    [429, 'rate_limit_error', /过于频繁或额度已用尽/, 2],
    [529, 'overloaded_error', /繁忙（过载）/, 2],
    [500, 'api_error', /暂时不可用/, 2],
    [503, 'api_error', /暂时不可用/, 2],
    [418, 'invalid_request_error', /返回了错误（418）/, 1],
  ];
  for (const [status, type, expected, requests] of cases) {
    const { calls, fetchImpl } = recorder(() => apiError(status, type));
    await assert.rejects(plan(fetchImpl), error => safe(error) && expected.test(error.message), `HTTP ${status}`);
    assert.equal(calls.length, requests, `HTTP ${status}: ${requests === 2 ? 'retried exactly once (maxRetries 1)' : 'not retried'}`);
  }
  // A server error keeps the request id (id-shaped only) so support can find it.
  const server = recorder(() => apiError(500, 'api_error'));
  await assert.rejects(plan(server.fetchImpl), error => error.message.includes(`请求编号 ${REQUEST_ID}`));
  // One transient failure, then success: the single SDK retry recovers.
  const flaky = recorder((_call, count) => (count === 1 ? apiError(529, 'overloaded_error') : message()));
  assert.deepEqual((await plan(flaky.fetchImpl)).plan, PLAN);
  assert.equal(flaky.calls.length, 2);
});

test('HTTP 400 on the beta endpoint falls back once to the stable endpoint; a second 400 is reported', async () => {
  const recovered = recorder((call, count) => (count === 1 ? apiError(400, 'invalid_request_error', 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.') : message()));
  assert.deepEqual(await plan(recovered.fetchImpl), { plan: PLAN, model: 'claude-opus-5-5' });
  assert.equal(recovered.calls.length, 2);
  assert.equal(recovered.calls[0].url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(recovered.calls[1].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(recovered.calls[1].headers['anthropic-beta'], undefined);
  assert.equal('fallbacks' in recovered.calls[1].body, false);
  const { fallbacks: _fallbacks, ...withoutFallbacks } = recovered.calls[0].body;
  assert.deepEqual(recovered.calls[1].body, withoutFallbacks, 'otherwise the same request');

  const rejected = recorder(() => apiError(400, 'invalid_request_error'));
  await assert.rejects(plan(rejected.fetchImpl), error => safe(error) && /没有接受这次请求/.test(error.message) && error.message.includes(REQUEST_ID));
  assert.equal(rejected.calls.length, 2);
  // Haiku is already on the stable endpoint: no second attempt.
  const haiku = recorder(() => apiError(400, 'invalid_request_error'));
  await assert.rejects(anthropic.plan({ settings: settings('claude-haiku-5-5'), input: INPUT, fetchImpl: haiku.fetchImpl }), /没有接受这次请求/);
  assert.equal(haiku.calls.length, 1);
  // Other failures on the beta endpoint are not turned into a second request shape.
  const unauthorised = recorder(() => apiError(401, 'authentication_error'));
  await assert.rejects(plan(unauthorised.fetchImpl), /API Key 无效/);
  assert.equal(unauthorised.calls.length, 1);
});

test('network failure and SDK timeout mention the system proxy and reveal nothing', async () => {
  const offline = recorder(() => { throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND api.anthropic.com via 10.1.2.3 ${KEY}`); });
  await assert.rejects(plan(offline.fetchImpl), error => safe(error) && /无法连接 Claude 服务/.test(error.message) && /系统代理/.test(error.message) && !/ENOTFOUND|10\.1\.2\.3/.test(error.message));
  assert.equal(offline.calls.length, 2, 'connection errors are retried once by the SDK');

  // The SDK's own timeout (shortened here; the adapter passes 90 s) raises APIConnectionTimeoutError.
  class Impatient extends Anthropic { constructor(given) { super({ ...given, timeout: 25, maxRetries: 0 }); } }
  const hanging = recorder(call => new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true })));
  await assert.rejects(plan(hanging.fetchImpl, { Anthropic: Impatient }), error => safe(error) && /连接 Claude 服务超时/.test(error.message) && /系统代理/.test(error.message));
});

test('cancel: an aborted signal stops the request and is reported as cancelled', async () => {
  const before = new AbortController(); before.abort();
  const never = recorder(() => message());
  await assert.rejects(plan(never.fetchImpl, { signal: before.signal }), error => safe(error) && /已取消本次编排/.test(error.message));
  assert.equal(never.calls.length, 0, 'nothing is sent after a cancel');

  const controller = new AbortController();
  const hanging = recorder(call => new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true })));
  const pending = plan(hanging.fetchImpl, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(hanging.calls.length, 1);
  controller.abort();
  await assert.rejects(pending, error => safe(error) && /已取消本次编排/.test(error.message));
  assert.equal(hanging.calls.length, 1, 'a cancelled request is not retried');
});

test('through the agent service: timeout and a late answer after cancel are discarded', async () => {
  // Timeout: the service stops after its own limit even though the SDK would wait longer.
  const slow = recorder(call => new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true })));
  const timed = createAgentService({ fetchImpl: slow.fetchImpl, timeoutMs: 40 });
  await assert.rejects(timed.plan(RAW_INPUT, settings()), error => safe(error) && /没有回应，已停止等待/.test(error.message));
  assert.equal(slow.calls.length, 1);
  assert.equal(slow.calls[0].signal.aborted, true);
  assert.equal(timed.busy, false);

  // Late result: the server answers after the user cancelled; the answer must go nowhere.
  let answer;
  const late = recorder(() => new Promise(resolve => { answer = () => resolve(message({ text: JSON.stringify({ ...PLAN, title: '迟到的结果' }) })); }));
  const service = createAgentService({ fetchImpl: late.fetchImpl });
  let settled = null;
  const pending = service.plan(RAW_INPUT, settings()).then(value => { settled = { value }; }, error => { settled = { error }; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(late.calls.length, 1);
  service.cancel();
  await pending;
  assert.match(settled.error.message, /已取消本次编排/);
  assert.equal(service.busy, false);
  answer();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(late.calls.length, 1);
  assert.match(settled.error.message, /已取消本次编排/, 'the late answer changes nothing');
});

test('responses larger than the cap are cut off, with or without Content-Length', async () => {
  const big = JSON.stringify({ id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x'.repeat(300_000) }], usage: { input_tokens: 1, output_tokens: 1 } });
  let cancelled = false;
  const declared = recorder(() => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode(big)); }, cancel() { cancelled = true; } }), { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) } }));
  await assert.rejects(plan(declared.fetchImpl, { maxBytes: 64 * 1024 }), error => safe(error) && /内容过大/.test(error.message));
  assert.equal(cancelled, true, 'the body is released without being read');
  let produced = 0;
  const streamed = recorder(() => new Response(new ReadableStream({ pull(controller) { produced += 16384; controller.enqueue(new Uint8Array(16384).fill(32)); } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(plan(streamed.fetchImpl, { maxBytes: 64 * 1024 }), error => safe(error) && /内容过大/.test(error.message));
  assert.ok(produced <= 64 * 1024 + 3 * 16384, `reading stops near the cap (read ${produced} bytes)`);
  // A normal answer under the default 1 MiB cap is fine.
  assert.deepEqual((await plan(recorder(() => message()).fetchImpl)).plan, PLAN);
});

test('the fetch handed to the SDK refuses every host but the official API and never follows redirects', async () => {
  // A stand-in for an SDK that (through a bug or a hostile environment) tries another host.
  const attempts = [];
  const makeClient = target => {
    class Wandering {
      constructor(options) {
        const create = async () => { attempts.push(target); return (await options.fetch(target, { method: 'POST', body: '{}', headers: { 'x-api-key': options.apiKey }, redirect: 'follow' })).json(); };
        this.messages = { create }; this.beta = { messages: { create } };
      }
    }
    for (const name of ['AuthenticationError', 'PermissionDeniedError', 'NotFoundError', 'RateLimitError', 'APIConnectionTimeoutError', 'APIConnectionError', 'APIUserAbortError', 'BadRequestError', 'APIError']) Wandering[name] = Anthropic[name];
    return Wandering;
  };
  const { calls, fetchImpl } = recorder(() => message());
  for (const target of ['https://evil.test/v1/messages', 'http://api.anthropic.com/v1/messages', 'https://api.anthropic.com.evil.test/v1/messages', 'https://api.anthropic.com:8443/v1/messages', 'https://user@evil.test/v1/messages', 'http://127.0.0.1:11434/v1/messages']) {
    await assert.rejects(plan(fetchImpl, { Anthropic: makeClient(target) }), safe, target);
  }
  assert.equal(calls.length, 0, 'the key is never sent anywhere else');
  assert.equal(attempts.length, 6);
  // The official host passes, with redirects forced off whatever the caller asked for.
  assert.deepEqual((await plan(fetchImpl, { Anthropic: makeClient('https://api.anthropic.com/v1/messages') })).plan, PLAN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'error');
});

test('only the offered Claude models are sent', async () => {
  const { calls, fetchImpl } = recorder(() => message());
  for (const model of ['claude-opus-4-1', 'claude-3-5-sonnet-20241022', 'claude-opus-5-5-20260401', 'gpt-5', '', undefined]) {
    await assert.rejects(anthropic.plan({ settings: { ...settings(), model }, input: INPUT, fetchImpl }), error => error.name === 'MusicError', String(model));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual([...anthropic.FALLBACK_MODELS], ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(anthropic.FALLBACK_BETA, 'server-side-fallback-2026-07-01');
  assert.equal(anthropic.MAX_TOKENS, 16000);
});
