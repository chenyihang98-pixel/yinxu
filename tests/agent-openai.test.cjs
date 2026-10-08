'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const openai = require('../electron/agent/openai.cjs');
const { createAgentService } = require('../electron/agent-service.cjs');
const { PLAN_SCHEMA, buildSystemPrompt, validatePlanInput } = require('../electron/agent/plan-schema.cjs');

const KEY = 'sk-fake-deepseek-key-for-tests';
const CURRENT = { style: 'bright', instrument: 'piano', key: 'C major', bpm: 112, duration: 30, energy: 0.62, complexity: 0.5, reverb: 0.25, loop: true, volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 } };
const RAW_INPUT = { mode: 'new', request: '雨天咖啡馆里的慵懒爵士，一分钟，不要鼓', provider: 'local', history: [{ role: 'user', text: '你好' }, { role: 'agent', text: '想做什么样的音乐？' }], current: CURRENT };
const INPUT = validatePlanInput(RAW_INPUT);
const PLAN = {
  reply: '好的，做一首不带鼓的慵懒爵士。', title: '雨天特调', style: 'jazz', instrument: 'vibes', key: 'F major', bpm: 84, duration: 60,
  energy: 0.35, complexity: 0.6, reverb: 0.35, loop: true, newMelody: true, volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
  arrangement: { progression: ['ii7', 'V7', 'Imaj7', 'vi7'], form: [], drums: 'none', bass: 'walking', swing: 0.4, layers: { pad: true, arp: false, counter: false, perc: false }, melody: { density: -1, register: 'mid', motion: 'stepwise' } },
  reasoning: ['不要鼓：drums 设为 none'], cloudPrompt: '慵懒的咖啡馆爵士，颤音琴主奏，84 BPM，纯音乐，无人声，无歌词。',
};
const CLOUD = { kind: 'openai', preset: 'deepseek', apiKey: KEY, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' };
const LOCAL = { kind: 'ollama', preset: 'ollama', apiKey: '', model: 'qwen3.5:9b-q4_K_M', baseUrl: 'http://127.0.0.1:11434/v1' };
const publicLookup = async () => [{ address: '116.205.40.1', family: 4 }];

const completion = (content, { model = 'deepseek-chat', finish_reason = 'stop', message = {} } = {}) => new Response(JSON.stringify({
  id: 'chatcmpl-1', object: 'chat.completion', model, choices: [{ index: 0, finish_reason, message: { role: 'assistant', content, ...message } }], usage: { prompt_tokens: 4400, completion_tokens: 450 },
}), { status: 200, headers: { 'content-type': 'application/json' } });
const failure = (status, text = `upstream detail that must not leak ${KEY}`) => new Response(JSON.stringify({ error: { message: text, type: 'invalid_request_error' } }), { status, headers: { 'content-type': 'application/json' } });
function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, redirect: init.redirect, signal: init.signal, headers: { ...init.headers }, body: JSON.parse(init.body) };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}
const noSleep = async () => {};
const run = (fetchImpl, extra = {}) => openai.plan({ settings: CLOUD, input: INPUT, fetchImpl, lookup: publicLookup, sleep: noSleep, ...extra });
const safe = error => error.name === 'MusicError' && !error.message.includes(KEY) && !error.message.includes('upstream detail');

test('OpenAI-compatible request: exact URL, headers and body; the answer is validated', async () => {
  const { calls, fetchImpl } = recorder(() => completion(JSON.stringify(PLAN)));
  const controller = new AbortController();
  const result = await run(fetchImpl, { signal: controller.signal });
  assert.deepEqual(result, { plan: PLAN, model: 'deepseek-chat' });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions', 'the stored base URL plus /chat/completions, no /v1 inserted');
  assert.equal(call.method, 'POST');
  assert.equal(call.redirect, 'error');
  assert.equal(call.signal, controller.signal);
  assert.deepEqual(call.headers, { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${KEY}` });
  assert.deepEqual(call.body, {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '想做什么样的音乐？' },
      { role: 'user', content: `【模式】new（新作品）\n【生成方式】本地合成引擎\n【当前设置】${JSON.stringify(CURRENT)}\n【用户的话】\n<<<\n${RAW_INPUT.request}\n>>>` },
    ],
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  });
  // Base URLs with a path keep it.
  const ark = recorder(() => completion(JSON.stringify(PLAN), { model: 'ep-20260801-abcde' }));
  assert.equal((await run(ark.fetchImpl, { settings: { ...CLOUD, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'ep-20260801-abcde' } })).model, 'ep-20260801-abcde');
  assert.equal(ark.calls[0].url, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  // An odd model id in the answer falls back to the configured one.
  const odd = recorder(() => completion(JSON.stringify(PLAN), { model: 'not a model id <b>' }));
  assert.equal((await run(odd.fetchImpl)).model, 'deepseek-chat');
});

test('Ollama: loopback only, no Authorization, schema-constrained answer with thinking switched off', async () => {
  const { calls, fetchImpl } = recorder(() => completion(JSON.stringify(PLAN), { model: 'qwen3.5:9b-q4_K_M' }));
  let lookups = 0;
  const result = await openai.plan({ settings: LOCAL, input: INPUT, fetchImpl, lookup: async () => { lookups++; return []; } });
  assert.deepEqual(result, { plan: PLAN, model: 'qwen3.5:9b-q4_K_M' });
  assert.equal(lookups, 0, 'no DNS check for the loopback address');
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json', Accept: 'application/json' });
  assert.equal(calls[0].redirect, 'error');
  assert.deepEqual(Object.keys(calls[0].body), ['model', 'messages', 'max_tokens', 'response_format', 'reasoning_effort']);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_schema', json_schema: { name: 'music_plan', strict: true, schema: JSON.parse(JSON.stringify(PLAN_SCHEMA)) } });
  assert.equal(calls[0].body.reasoning_effort, 'none');
  assert.equal(calls[0].body.max_tokens, 4096);
  // Even if a key is present in the settings object, a local model never receives it.
  const keyed = recorder(() => completion(JSON.stringify(PLAN)));
  await openai.plan({ settings: { ...LOCAL, apiKey: KEY }, input: INPUT, fetchImpl: keyed.fetchImpl });
  assert.equal('Authorization' in keyed.calls[0].headers, false);
  // An older Ollama that rejects these parameters is asked again, one parameter at a time.
  const old = recorder((call, count) => (count === 1 ? failure(400, 'invalid response_format: json_schema is not supported') : count === 2 ? failure(400, 'unknown field reasoning_effort') : completion(JSON.stringify(PLAN))));
  assert.deepEqual((await openai.plan({ settings: LOCAL, input: INPUT, fetchImpl: old.fetchImpl })).plan, PLAN);
  assert.deepEqual(old.calls.map(call => [call.body.response_format?.type, call.body.reasoning_effort]), [['json_schema', 'none'], ['json_object', 'none'], ['json_object', undefined]]);
});

test('base URL policy is enforced again at call time, before anything is sent', async () => {
  const { calls, fetchImpl } = recorder(() => completion(JSON.stringify(PLAN)));
  for (const baseUrl of ['http://api.deepseek.com', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://0x7f.1/v1', 'https://10.0.0.8/v1', 'https://gateway.internal/v1', 'https://user:pass@api.deepseek.com', 'https://api.deepseek.com/v1?x=1', '', undefined]) {
    await assert.rejects(run(fetchImpl, { settings: { ...CLOUD, baseUrl } }), error => error.name === 'MusicError', String(baseUrl));
  }
  for (const baseUrl of ['http://192.168.1.2:11434/v1', 'https://127.0.0.1:11434/v1', 'http://api.deepseek.com/v1', 'http://my-pc:11434/v1']) {
    await assert.rejects(openai.plan({ settings: { ...LOCAL, baseUrl }, input: INPUT, fetchImpl }), error => error.name === 'MusicError', baseUrl);
  }
  // A public-looking name that resolves to a private address (DNS rebinding, localtest.me-style names).
  for (const address of ['127.0.0.1', '10.0.0.8', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    await assert.rejects(run(fetchImpl, { lookup: async () => [{ address: '116.205.40.1', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] }), error => error.name === 'MusicError' && /本机或内网/.test(error.message), address);
  }
  assert.equal(calls.length, 0, 'the key never leaves for a refused address');
  // An unresolvable name (only a proxy could resolve it) is allowed through.
  await run(fetchImpl, { lookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  assert.equal(calls.length, 1);
});

test('answers wrapped the way real models wrap them are unwrapped: fences, <think>, prose, reasoning_content', async () => {
  const json = JSON.stringify(PLAN, null, 2);
  const wrapped = [
    json,
    `\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`\n${json}\n\`\`\`\n希望你喜欢！`,
    `<think>\n用户想要 {"style": "rock"} 吗？不，是爵士。\n</think>\n\n${json}`,
    `<thinking>先想想 {"bpm": 999}</thinking>\n这是方案：\n${json}\n如需调整请告诉我。`,
    `被截断的思考……{"style":"rock"} </think>\n${json}`,
    `好的，方案如下：${json}`,
    `{"note": "不是方案"}`.replace('{"note": "不是方案"}', `前言 {not json} 然后 ${json}`),
  ];
  for (const content of wrapped) {
    const { fetchImpl } = recorder(() => completion(content));
    assert.deepEqual((await run(fetchImpl)).plan, PLAN, content.slice(0, 40));
  }
  // Content delivered as parts; side channels are ignored.
  const parts = recorder(() => completion([{ type: 'text', text: json.slice(0, 50) }, { type: 'text', text: json.slice(50) }], { message: { reasoning_content: '{"style":"rock","bpm":180}', reasoning: 'thinking text' } }));
  assert.deepEqual((await run(parts.fetchImpl)).plan, PLAN);
  const reasoningOnly = recorder(() => completion('', { message: { reasoning_content: json } }));
  await assert.rejects(run(reasoningOnly.fetchImpl), /没有按约定返回方案/, 'reasoning_content is never used as the answer');
  // Braces inside strings do not confuse the scanner.
  const tricky = { ...PLAN, reply: '花括号 } 和 { 都在 "引号" 里 \\ 也没关系。' };
  assert.equal((await run(recorder(() => completion(`说明 ${JSON.stringify(tricky)} 结束`)).fetchImpl)).plan.reply, tricky.reply);
  assert.deepEqual(openai.extractPlanObject('no braces here'), null);
  assert.deepEqual(openai.extractPlanObject('{"a": {"b": [1, {"c": "}"}]}} trailing {"d": 1}'), { a: { b: [1, { c: '}' }] } });
  assert.deepEqual(openai.extractPlanObject('{prose} {"also": prose} {"d": 1}'), { d: 1 });
});

test('a cut-off answer is never rescued from one of its complete inner objects', async () => {
  // The outer object is truncated, but a form section inside it is complete and has an "energy" field.
  const truncated = '{"reasoning":["x"],"style":"rock","arrangement":{"form":[{"type":"intro","bars":4,"energy":0.9}],"drums":"stra';
  assert.equal(openai.extractPlanObject(truncated), null);
  assert.equal(openai.extractPlanObject(`\`\`\`json\n${truncated}`), null);
  for (const finish_reason of ['length', 'stop']) {
    await assert.rejects(run(recorder(() => completion(truncated, { finish_reason })).fetchImpl), error => safe(error) && /被截断|没有按约定返回方案/.test(error.message));
  }
});

test('an empty body or a connection that drops mid-answer gives the right message', async () => {
  await assert.rejects(run(recorder(() => new Response(null, { status: 200 })).fetchImpl), /无法识别的内容/);
  const dropped = recorder(() => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError(`terminated ${KEY}`)); } }), { status: 200 }));
  await assert.rejects(run(dropped.fetchImpl), error => safe(error) && /连接中断/.test(error.message));
  assert.equal(dropped.calls.length, 1);
});

test('real output of a small local model: partial answers are completed from the current settings, never invented', async () => {
  // Observed with qwen3.5:9b in plain JSON mode: the object was closed right after "reasoning".
  const closedEarly = recorder(() => completion('{\n  "reasoning": ["场景为雨天咖啡馆", "drums置为none符合不要鼓的要求"]\n  }'));
  await assert.rejects(run(closedEarly.fetchImpl), error => safe(error) && /没有给出可用的音乐方案/.test(error.message));
  // Only the decisions, no texts: usable.
  const terse = recorder(() => completion('{"style":"jazz","instrument":"vibes","bpm":84,"arrangement":{"drums":"none"}}'));
  const { plan } = await run(terse.fetchImpl);
  assert.equal(plan.style, 'jazz'); assert.equal(plan.instrument, 'vibes'); assert.equal(plan.bpm, 84); assert.equal(plan.arrangement.drums, 'none');
  assert.equal(plan.key, CURRENT.key); assert.equal(plan.duration, CURRENT.duration); assert.deepEqual(plan.volumes, CURRENT.volumes);
  assert.equal(plan.title, '爵士小馆'); assert.ok(plan.reply.length > 0);
  // An enum the catalog does not have is an error, not a guess.
  for (const content of ['{"style":"lofi hip hop","bpm":80}', '{"style":"jazz","instrument":"saxophone"}', '{"style":"jazz","key":"Fm"}', '{"style":"jazz","arrangement":{"drums":"brushes"}}', '{"style":"jazz","bpm":"slow"}']) {
    await assert.rejects(run(recorder(() => completion(content)).fetchImpl), safe, content);
  }
});

test('malformed or empty answers give a safe message', async () => {
  const cases = [
    [() => completion('抱歉，我无法输出 JSON。'), /没有按约定返回方案/],
    [() => completion(''), /没有按约定返回方案/],
    [() => completion(null), /没有按约定返回方案/],
    [() => completion('[1, 2, 3]'), /没有按约定返回方案/],
    [() => completion('{"style": "jazz", "bpm": 84'), /没有按约定返回方案/],
    [() => completion('', { finish_reason: 'length', message: { reasoning: 'x'.repeat(5000) } }), /被截断/], // observed: thinking used the whole budget
    [() => completion('{"style": "jazz", "reply": "写到一半', { finish_reason: 'length' }), /被截断/],
    [() => completion(JSON.stringify(PLAN), { finish_reason: 'content_filter' }), /拒绝了这次请求/],
    [() => new Response('<html><body>502 Bad Gateway</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }), /无法识别的内容/],
    [() => new Response('', { status: 200 }), /无法识别的内容/],
    [() => new Response(JSON.stringify({ choices: [] }), { status: 200 }), /没有按约定返回方案/],
    [() => new Response(JSON.stringify({ error: { message: `quota ${KEY}` } }), { status: 200 }), /没有按约定返回方案/],
    [() => new Response('null', { status: 200 }), /没有按约定返回方案/],
  ];
  for (const [respond, expected] of cases) {
    const { calls, fetchImpl } = recorder(respond);
    await assert.rejects(run(fetchImpl), error => safe(error) && expected.test(error.message), String(expected));
    assert.equal(calls.length, 1, 'a bad answer is not asked for again');
  }
});

test('HTTP 400 about response_format: retried once without it; other 400s are final', async () => {
  const picky = recorder((call, count) => (count === 1 ? failure(400, "This response_format type is unavailable now") : completion(JSON.stringify(PLAN))));
  assert.deepEqual((await run(picky.fetchImpl)).plan, PLAN);
  assert.equal(picky.calls.length, 2);
  assert.deepEqual(picky.calls[0].body.response_format, { type: 'json_object' });
  assert.equal('response_format' in picky.calls[1].body, false);
  const { response_format: _dropped, ...rest } = picky.calls[0].body;
  assert.deepEqual(picky.calls[1].body, rest, 'only that one parameter changes');

  const stillPicky = recorder(() => failure(400, 'response_format is not supported'));
  await assert.rejects(run(stillPicky.fetchImpl), error => safe(error) && /没有接受这次请求/.test(error.message));
  assert.equal(stillPicky.calls.length, 2, 'retried ONCE without response_format, then reported');

  const unrelated = recorder(() => failure(400, 'model `deepseek-chat` has been deprecated'));
  await assert.rejects(run(unrelated.fetchImpl), /没有接受这次请求/);
  assert.equal(unrelated.calls.length, 1);

  // Newer OpenAI models want max_completion_tokens instead of max_tokens.
  const renamed = recorder((call, count) => (count === 1 ? failure(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.") : completion(JSON.stringify(PLAN))));
  assert.deepEqual((await run(renamed.fetchImpl)).plan, PLAN);
  assert.equal(renamed.calls[1].body.max_completion_tokens, 4096);
  assert.equal('max_tokens' in renamed.calls[1].body, false);
  // The number of request-shape changes is bounded.
  const endless = recorder(() => failure(400, 'response_format max_completion_tokens reasoning'));
  await assert.rejects(run(endless.fetchImpl), /没有接受这次请求/);
  assert.ok(endless.calls.length <= 4);
});

test('HTTP status mapping, with at most one retry on 429 / 5xx after a short delay', async () => {
  const cases = [
    [401, /API Key 无效或已过期/, 1], [402, /余额不足/, 1], [403, /没有调用这个模型的权限/, 1], [404, /找不到这个模型或接口地址/, 1], [422, /没有接受这次请求/, 1],
    [429, /过于频繁或额度已用尽/, 2], [500, /暂时不可用/, 2], [502, /暂时不可用/, 2], [503, /暂时不可用/, 2], [418, /返回了错误（418）/, 1],
  ];
  for (const [status, expected, requests] of cases) {
    const waits = [];
    const { calls, fetchImpl } = recorder(() => failure(status));
    await assert.rejects(run(fetchImpl, { sleep: async ms => { waits.push(ms); } }), error => safe(error) && expected.test(error.message), `HTTP ${status}`);
    assert.equal(calls.length, requests, `HTTP ${status}`);
    assert.deepEqual(waits, requests === 2 ? [1500] : []);
  }
  const flaky = recorder((_call, count) => (count === 1 ? failure(503) : completion(JSON.stringify(PLAN))));
  assert.deepEqual((await run(flaky.fetchImpl)).plan, PLAN);
  assert.equal(flaky.calls.length, 2);
  // Local wording for the same statuses.
  const missingModel = recorder(() => failure(404, 'model "qwen3.5:9b" not found, try pulling it first'));
  await assert.rejects(openai.plan({ settings: LOCAL, input: INPUT, fetchImpl: missingModel.fetchImpl, sleep: noSleep }), /本机 Ollama 里没有这个模型/);
  const broken = recorder(() => failure(500));
  await assert.rejects(openai.plan({ settings: LOCAL, input: INPUT, fetchImpl: broken.fetchImpl, sleep: noSleep }), /本机 Ollama 出错了/);
  // A non-JSON error body is handled too.
  const html = recorder(() => new Response('<html>401 Authorization Required</html>', { status: 401 }));
  await assert.rejects(run(html.fetchImpl), /API Key 无效/);
});

test('network failures and redirects are reported without detail; a redirect is never followed', async () => {
  const offline = recorder(() => { throw new TypeError(`fetch failed: connect ECONNREFUSED 10.9.8.7:443 ${KEY}`); });
  await assert.rejects(run(offline.fetchImpl), error => safe(error) && /无法连接大模型服务/.test(error.message) && /系统代理/.test(error.message) && !/ECONNREFUSED|10\.9\.8\.7/.test(error.message));
  assert.equal(offline.calls.length, 1);
  const localDown = recorder(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(openai.plan({ settings: LOCAL, input: INPUT, fetchImpl: localDown.fetchImpl }), /无法连接本机的 Ollama/);
  // With redirect:"error" a real fetch rejects on a 3xx; a 3xx that still surfaces is not followed either.
  const redirect = recorder(() => new Response('', { status: 307, headers: { location: 'https://evil.test/chat/completions' } }));
  await assert.rejects(run(redirect.fetchImpl), safe);
  assert.equal(redirect.calls.length, 1);
  assert.equal(redirect.calls[0].redirect, 'error');
});

test('response size cap: 1 MiB by default, enforced on the header and on the stream', async () => {
  const huge = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...PLAN, cloudPrompt: 'x'.repeat(2 * 1024 * 1024) }) } }] });
  await assert.rejects(run(recorder(() => new Response(huge, { status: 200 })).fetchImpl), error => safe(error) && /内容过大/.test(error.message));
  let cancelled = false;
  const declared = recorder(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }));
  await assert.rejects(run(declared.fetchImpl), /内容过大/);
  assert.equal(cancelled, true);
  const small = recorder(() => completion(JSON.stringify(PLAN)));
  await assert.rejects(run(small.fetchImpl, { maxBytes: 200 }), /内容过大/);
  // Error bodies are bounded as well (64 KiB) and only searched for a parameter name.
  const bigError = recorder(() => new Response(`{"error":{"message":"${'x'.repeat(200_000)} response_format"}}`, { status: 400 }));
  await assert.rejects(run(bigError.fetchImpl), /没有接受这次请求/);
  assert.equal(bigError.calls.length, 1, 'an oversized error body is not read, so no downgrade is attempted');
});

test('cancel: before the request, while waiting, during the retry delay and after the answer', async () => {
  const before = new AbortController(); before.abort();
  const never = recorder(() => completion(JSON.stringify(PLAN)));
  await assert.rejects(run(never.fetchImpl, { signal: before.signal }));
  assert.equal(never.calls.length, 0);

  const waiting = new AbortController();
  const hanging = recorder(call => new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true })));
  const pending = run(hanging.fetchImpl, { signal: waiting.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  waiting.abort();
  await assert.rejects(pending, error => error.name !== 'MusicError' || !/无法连接/.test(error.message), 'an abort is not reported as a network failure');
  assert.equal(hanging.calls.length, 1);

  const delayed = new AbortController();
  const busy = recorder(() => failure(503));
  await assert.rejects(openai.plan({ settings: CLOUD, input: INPUT, fetchImpl: busy.fetchImpl, lookup: publicLookup, signal: delayed.signal, sleep: async () => { delayed.abort(); } }));
  assert.equal(busy.calls.length, 1, 'no retry after a cancel during the delay');

  const after = new AbortController();
  const answered = recorder(() => { after.abort(); return completion(JSON.stringify(PLAN)); });
  await assert.rejects(run(answered.fetchImpl, { signal: after.signal }), 'an answer that arrives after the cancel is not returned');
});

test('through the agent service: cancel, timeout and late results use the service messages', async () => {
  const hang = call => new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true }));
  const slow = recorder(hang);
  const timed = createAgentService({ fetchImpl: slow.fetchImpl, lookup: publicLookup, timeoutMs: 30 });
  await assert.rejects(timed.plan(RAW_INPUT, CLOUD), error => safe(error) && /没有回应，已停止等待/.test(error.message));
  assert.equal(slow.calls.length, 1);

  const cancelled = recorder(hang);
  const service = createAgentService({ fetchImpl: cancelled.fetchImpl, lookup: publicLookup });
  const pending = service.plan(RAW_INPUT, CLOUD);
  await new Promise(resolve => setTimeout(resolve, 10));
  service.cancel();
  await assert.rejects(pending, error => error.message === '已取消本次编排。');
  assert.equal(service.busy, false);

  let answer;
  const late = recorder(() => new Promise(resolve => { answer = () => resolve(completion(JSON.stringify({ ...PLAN, title: '迟到的结果' }))); }));
  const lateService = createAgentService({ fetchImpl: late.fetchImpl, lookup: publicLookup });
  const first = lateService.plan(RAW_INPUT, CLOUD);
  await new Promise(resolve => setTimeout(resolve, 10));
  lateService.cancel();
  await assert.rejects(first, /已取消本次编排/);
  answer();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lateService.busy, false);
  const fresh = createAgentService({ fetchImpl: recorder(() => completion(JSON.stringify(PLAN))).fetchImpl, lookup: publicLookup });
  assert.deepEqual(await fresh.plan(RAW_INPUT, CLOUD), { plan: PLAN, model: 'deepseek-chat' });
});
