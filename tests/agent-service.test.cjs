'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentService, MAX_RESPONSE_BYTES } = require('../electron/agent-service.cjs');
const { MusicError } = require('../electron/providers/shared.cjs');

const CURRENT = { style: 'bright', instrument: 'piano', key: 'C major', bpm: 112, duration: 30, energy: 0.62, complexity: 0.5, reverb: 0.25, loop: true, volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 } };
const INPUT = { mode: 'new', request: '雨天咖啡馆里的慵懒爵士，一分钟，不要鼓', provider: 'local', history: [], current: CURRENT };
const PLAN = {
  reply: '好的，做一首不带鼓的慵懒爵士。', title: '雨天特调', style: 'jazz', instrument: 'vibes', key: 'F major', bpm: 84, duration: 60,
  energy: 0.35, complexity: 0.6, reverb: 0.35, loop: true, newMelody: true, volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
  arrangement: { progression: [], form: [], drums: 'none', bass: 'walking', swing: 0.4, layers: { pad: true, arp: false, counter: false, perc: false }, melody: { density: -1, register: 'mid', motion: 'stepwise' } },
  reasoning: ['不要鼓：drums 设为 none'], cloudPrompt: '慵懒的咖啡馆爵士，纯音乐，无人声，无歌词。',
};
const SECRET = 'sk-ant-fake-key-for-tests-only';
const CLAUDE = { kind: 'anthropic', preset: 'claude', apiKey: SECRET, model: 'claude-opus-5-5' };
const DEEPSEEK = { kind: 'openai', preset: 'deepseek', apiKey: 'sk-fake-deepseek-key-for-tests', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' };
const OLLAMA = { kind: 'ollama', preset: 'ollama', apiKey: '', model: 'qwen3.5:9b-q4_K_M' };

/** Adapters that record their calls; `behaviour` decides what the call does. */
function fakeAdapters(behaviour = async () => ({ plan: PLAN, model: 'answering-model' })) {
  const calls = [];
  const make = name => ({ plan: async args => { calls.push({ name, ...args }); return behaviour(args, name); } });
  return { calls, adapters: { anthropic: make('anthropic'), openai: make('openai') } };
}
const hang = ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true }));

test('plan: validated input and normalised settings reach the right adapter; only {plan, model} comes back', async () => {
  const fetchImpl = async () => { throw new Error('not used'); };
  const lookup = async () => [];
  for (const [settings, adapter] of [[CLAUDE, 'anthropic'], [DEEPSEEK, 'openai'], [OLLAMA, 'openai']]) {
    const { calls, adapters } = fakeAdapters(async () => ({ plan: { ...PLAN, extra: 'dropped', arrangement: { ...PLAN.arrangement, solo: true } }, model: 'answering-model', usage: { input_tokens: 1 }, raw: 'upstream text' }));
    const service = createAgentService({ adapters, fetchImpl, lookup });
    const result = await service.plan({ ...INPUT, request: `  ${INPUT.request}  `, apiKey: 'sk-renderer', baseUrl: 'https://evil.test' }, settings);
    assert.deepEqual(result, { plan: PLAN, model: 'answering-model' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, adapter);
    assert.deepEqual(calls[0].input, { ...INPUT });
    assert.equal(calls[0].settings.kind, settings.kind);
    assert.equal(calls[0].settings.baseUrl, settings.kind === 'anthropic' ? '' : settings.kind === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.deepseek.com');
    assert.equal(calls[0].fetchImpl, fetchImpl);
    assert.equal(calls[0].lookup, lookup);
    assert.equal(calls[0].maxBytes, MAX_RESPONSE_BYTES);
    assert.equal(MAX_RESPONSE_BYTES, 1024 * 1024);
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.equal(service.busy, false);
  }
});

test('plan: an unusable model id from the adapter falls back to the configured model', async () => {
  for (const model of [undefined, '', 'model with spaces', '<script>', 'x'.repeat(200), 42]) {
    const { adapters } = fakeAdapters(async () => ({ plan: PLAN, model }));
    assert.equal((await createAgentService({ adapters }).plan(INPUT, CLAUDE)).model, 'claude-opus-5-5');
  }
});

test('plan: malformed input is rejected before settings are read or any adapter runs', async () => {
  const { calls, adapters } = fakeAdapters();
  const service = createAgentService({ adapters });
  let settingsRead = 0;
  const settings = async () => { settingsRead++; return CLAUDE; };
  for (const bad of [null, undefined, 'text', {}, { ...INPUT, mode: 'edit' }, { ...INPUT, request: '' }, { ...INPUT, request: '字'.repeat(1501) }, { ...INPUT, provider: 'suno' },
    { ...INPUT, history: Array.from({ length: 13 }, () => ({ role: 'user', text: 'x' })) }, { ...INPUT, history: [{ role: 'user', text: '字'.repeat(601) }] },
    { ...INPUT, current: { ...CURRENT, style: 'lofi' } }, { ...INPUT, current: { ...CURRENT, bpm: '112' } }, { ...INPUT, current: undefined }]) {
    await assert.rejects(service.plan(bad, settings), error => error instanceof MusicError, JSON.stringify(bad)?.slice(0, 80));
    assert.equal(service.busy, false);
  }
  assert.equal(settingsRead, 0);
  assert.equal(calls.length, 0);
});

test('plan: missing, invalid or unreadable settings give a safe message and release the lock', async () => {
  const { calls, adapters } = fakeAdapters();
  const service = createAgentService({ adapters });
  await assert.rejects(service.plan(INPUT, async () => { throw new MusicError('还没有配置大模型。请先在设置中填写大模型的连接信息。'); }), /还没有配置大模型/);
  await assert.rejects(service.plan(INPUT, async () => { throw new Error(`EPERM: C:\\Users\\me\\AppData\\music-credentials.json ${SECRET}`); }), error => error instanceof MusicError && !error.message.includes(SECRET) && !/EPERM|AppData/.test(error.message));
  for (const settings of [null, undefined, {}, { ...CLAUDE, kind: 'tencent' }, { ...CLAUDE, apiKey: '' }, { ...DEEPSEEK, baseUrl: 'http://10.0.0.1/v1' }, { ...DEEPSEEK, baseUrl: 'https://localhost/v1' }, { ...OLLAMA, baseUrl: 'http://192.168.1.2:11434/v1' }]) {
    await assert.rejects(service.plan(INPUT, settings), error => error instanceof MusicError, JSON.stringify(settings));
    assert.equal(service.busy, false);
  }
  assert.equal(calls.length, 0, 'no adapter is called with settings that do not pass the strict check');
  assert.deepEqual(await service.plan(INPUT, CLAUDE), { plan: PLAN, model: 'answering-model' });
});

test('lock: one plan at a time; the second request is refused without touching the adapter', async () => {
  let release;
  const { calls, adapters } = fakeAdapters(() => (release ? { plan: PLAN, model: 'claude-opus-5-5' } : new Promise(resolve => { release = resolve; })));
  const service = createAgentService({ adapters });
  const first = service.plan(INPUT, CLAUDE);
  assert.equal(service.busy, true);
  await assert.rejects(service.plan({ ...INPUT, request: '另一个请求' }, DEEPSEEK), /上一次编排还在进行/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release({ plan: PLAN, model: 'claude-opus-5-5' });
  assert.deepEqual(await first, { plan: PLAN, model: 'claude-opus-5-5' });
  assert.equal(service.busy, false);
  await service.plan(INPUT, CLAUDE);
  assert.equal(calls.length, 2);
});

test('cancel: aborts the adapter signal, answers at once and frees the lock', async () => {
  const { calls, adapters } = fakeAdapters(hang);
  const service = createAgentService({ adapters });
  service.cancel(); // nothing running: a no-op
  const pending = service.plan(INPUT, CLAUDE);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].signal.aborted, false);
  service.cancel();
  assert.equal(calls[0].signal.aborted, true);
  await assert.rejects(pending, error => error instanceof MusicError && error.message === '已取消本次编排。');
  assert.equal(service.busy, false);
});

test('cancel while the settings are still being read is not lost (the lock is taken first)', async () => {
  const { calls, adapters } = fakeAdapters();
  const service = createAgentService({ adapters });
  let finishRead;
  const pending = service.plan(INPUT, () => new Promise(resolve => { finishRead = resolve; }));
  assert.equal(service.busy, true, 'busy as soon as plan() is called');
  service.cancel();
  await assert.rejects(pending, /已取消本次编排/);
  finishRead(CLAUDE);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0, 'the adapter never starts after a cancel during the read');
  assert.equal(service.busy, false);
});

test('late result after cancel is discarded and cannot leak into the next request', async () => {
  const releases = [];
  const { adapters } = fakeAdapters(() => new Promise(resolve => { releases.push(resolve); }));
  const service = createAgentService({ adapters });
  const first = service.plan({ ...INPUT, request: '第一个请求' }, CLAUDE);
  await new Promise(resolve => setImmediate(resolve));
  service.cancel();
  await assert.rejects(first, /已取消本次编排/);
  // The user asks again while the abandoned call is still out there.
  const second = service.plan({ ...INPUT, request: '第二个请求' }, CLAUDE);
  await new Promise(resolve => setImmediate(resolve));
  releases[0]({ plan: { ...PLAN, title: '迟到的旧结果' }, model: 'late-model' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.busy, true, 'the late answer does not end the second job');
  releases[1]({ plan: { ...PLAN, title: '新的结果' }, model: 'fresh-model' });
  assert.deepEqual(await second, { plan: { ...PLAN, title: '新的结果' }, model: 'fresh-model' });
});

test('a result that arrives in the same tick as the cancel is still discarded', async () => {
  let release;
  const { adapters } = fakeAdapters(() => new Promise(resolve => { release = resolve; }));
  const service = createAgentService({ adapters });
  const pending = service.plan(INPUT, CLAUDE);
  await new Promise(resolve => setImmediate(resolve));
  release({ plan: PLAN, model: 'claude-opus-5-5' });
  service.cancel();
  await assert.rejects(pending, /已取消本次编排/);
});

test('timeout: stops waiting, aborts the adapter, discards a late result and never retries', async () => {
  let release;
  const { calls, adapters } = fakeAdapters(() => new Promise(resolve => { release = resolve; }));
  const service = createAgentService({ adapters, timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(service.plan(INPUT, CLAUDE), error => error instanceof MusicError && /没有回应，已停止等待/.test(error.message));
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(service.busy, false);
  release({ plan: PLAN, model: 'late-model' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.busy, false);
  // Default is 90 seconds, and the message says so.
  const slow = createAgentService({ adapters: fakeAdapters(hang).adapters, timeoutMs: 90_000 });
  const pending = slow.plan(INPUT, CLAUDE);
  slow.cancel();
  await assert.rejects(pending, /已取消/);
  const quick = createAgentService({ adapters: fakeAdapters(hang).adapters, timeoutMs: 1000 * 0.03 });
  await assert.rejects(quick.plan(INPUT, CLAUDE), /超过 0 秒|没有回应/);
});

test('errors: MusicError messages pass, everything else becomes a fixed message without upstream text', async () => {
  const cases = [
    [new MusicError('Claude API Key 无效或已过期，请在设置中更新。'), /^Claude API Key 无效或已过期，请在设置中更新。$/],
    [new Error(`401 {"error":{"message":"invalid x-api-key ${SECRET}"}}`), /^大模型调用失败，请稍后重试，或先用内置规则生成。$/],
    [new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:443'), /^大模型调用失败/],
    [Object.assign(new Error('boom'), { name: 'MusicError' }), /^大模型调用失败/], // only real instances count
    ['plain string', /^大模型调用失败/],
  ];
  for (const [thrown, expected] of cases) {
    const { adapters } = fakeAdapters(async () => { throw thrown; });
    const service = createAgentService({ adapters });
    await assert.rejects(service.plan(INPUT, CLAUDE), error => error instanceof MusicError && expected.test(error.message) && !error.message.includes(SECRET) && !/ECONNREFUSED|10\.0\.0\.1/.test(error.message));
    assert.equal(service.busy, false);
  }
});

test('whatever an adapter returns is validated again before it crosses the IPC boundary', async () => {
  for (const result of [null, undefined, 'text', {}, { plan: null, model: 'm' }, { plan: 'raw upstream text', model: 'm' }, { plan: { ...PLAN, style: 'not-a-style' }, model: 'm' }, { plan: { ...PLAN, bpm: '84' }, model: 'm' }, { plan: { reply: 'only a reply' }, model: 'm' }]) {
    const { adapters } = fakeAdapters(async () => result);
    await assert.rejects(createAgentService({ adapters }).plan(INPUT, CLAUDE), error => error instanceof MusicError, JSON.stringify(result));
  }
  const { adapters } = fakeAdapters(async () => ({ plan: { ...PLAN, bpm: 9999, energy: 5 }, model: 'm' }));
  const { plan } = await createAgentService({ adapters }).plan(INPUT, CLAUDE);
  assert.equal(plan.bpm, 200); assert.equal(plan.energy, 1);
});

test('default adapters are the real modules and are wired by kind', async () => {
  // Claude: the SDK is driven through the injected fetch (no network); the request goes to the official API host only.
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), redirect: init.redirect });
    return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(PLAN) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  const service = createAgentService({ fetchImpl, lookup: async () => [{ address: '116.205.40.1', family: 4 }] });
  assert.deepEqual(await service.plan(INPUT, CLAUDE), { plan: PLAN, model: 'claude-opus-5-5' });
  assert.equal(new URL(requests[0].url).origin, 'https://api.anthropic.com');
  assert.equal(requests[0].headers['x-api-key'], SECRET);
  assert.equal(requests[0].redirect, 'error');
  // OpenAI-compatible: same service, other adapter.
  requests.length = 0;
  const openaiFetch = async (url, init) => { requests.push({ url: String(url), headers: init.headers }); return new Response(JSON.stringify({ model: 'deepseek-chat', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(PLAN) } }] })); };
  const second = createAgentService({ fetchImpl: openaiFetch, lookup: async () => [{ address: '116.205.40.1', family: 4 }] });
  assert.deepEqual(await second.plan(INPUT, DEEPSEEK), { plan: PLAN, model: 'deepseek-chat' });
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].headers.Authorization, `Bearer ${DEEPSEEK.apiKey}`);
});
