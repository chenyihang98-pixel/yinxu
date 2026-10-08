'use strict';

// F06: the renderer must receive only the Chinese message, not Electron's
// "Error invoking remote method '…': Error: " wrapper. Also checks that the bridge,
// the IPC channels and the DesktopAPI contract stay in step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');

/** Run the real preload file against a fake `electron` module (it is sandboxed, so it requires nothing else). */
function loadBridge(invoke) {
  const exposed = {};
  const required = [];
  const fakeRequire = name => {
    required.push(name);
    if (name !== 'electron') throw new Error(`a sandboxed preload cannot require "${name}"`);
    return { contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } }, ipcRenderer: { invoke } };
  };
  vm.runInNewContext(`(function (require) { ${preloadSource}\n})`, { Error, String, Object, Promise })(fakeRequire);
  return { exposed, required };
}

const METHODS = {
  getSettings: ['muse:get-settings', []],
  saveApiKey: ['muse:save-api-key', ['key']],
  deleteApiKey: ['muse:delete-api-key', []],
  saveProviderCredentials: ['muse:save-provider', ['tencent', { apiKey: 'k' }]],
  deleteProviderCredentials: ['muse:delete-provider', ['tencent']],
  generateMusic: ['muse:generate-music', [{ prompt: 'p', duration: 30 }]],
  cancelGeneration: ['muse:cancel-generation', []],
  saveAudio: ['muse:save-audio', [{ name: 'n', format: 'wav' }]],
  openExternal: ['muse:open-external', ['https://example.com']],
  saveLlmSettings: ['muse:save-llm', [{ kind: 'ollama', model: 'm' }]],
  deleteLlmSettings: ['muse:delete-llm', []],
  agentPlan: ['muse:agent-plan', [{ mode: 'new', request: 'r' }]],
  cancelAgent: ['muse:cancel-agent', []],
};

test('bridge exposes exactly the DesktopAPI methods, frozen, each on its own channel', async () => {
  const calls = [];
  const { exposed, required } = loadBridge(async (...args) => { calls.push(args); return 'result'; });
  assert.deepEqual(required, ['electron']);
  assert.deepEqual(Object.keys(exposed), ['museDesktop']);
  const bridge = exposed.museDesktop;
  assert.ok(Object.isFrozen(bridge));
  assert.deepEqual(Object.keys(bridge).sort(), Object.keys(METHODS).sort());
  for (const [method, [channel, args]] of Object.entries(METHODS)) {
    calls.length = 0;
    assert.equal(await bridge[method](...args), 'result');
    assert.deepEqual(calls, [[channel, ...args]], method);
  }
  // No raw IPC, no generic invoke.
  for (const leaked of ['ipcRenderer', 'invoke', 'send', 'on', 'require', 'process']) assert.equal(leaked in bridge, false, leaked);
});

test('bridge methods match DesktopAPI in src/types.ts and the handlers registered in main.cjs', () => {
  const types = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf8');
  const body = /export interface DesktopAPI \{([\s\S]*?)\n\}/.exec(types)?.[1];
  assert.ok(body, 'DesktopAPI interface found');
  const declared = [...body.matchAll(/^ {2}([A-Za-z]+)\(/gm)].map(match => match[1]);
  assert.deepEqual([...declared].sort(), Object.keys(METHODS).sort());
  const handled = [...mainSource.matchAll(/trustedHandler\('(muse:[a-z-]+)'/g)].map(match => match[1]);
  assert.deepEqual([...handled].sort(), Object.values(METHODS).map(([channel]) => channel).sort());
  assert.equal(new Set(handled).size, handled.length, 'no channel is registered twice');
  assert.equal(/ipcMain\.(on|handle)\(/.test(mainSource.replace('ipcMain.handle(channel, trusted(handler))', '')), false, 'every handler goes through the trusted wrapper');
});

test("F06: Electron's IPC prefix is removed so the UI shows only the application message", async () => {
  const table = [
    ["Error invoking remote method 'muse:generate-music': Error: API Key 无效或已过期，请检查所选服务的密钥。", 'API Key 无效或已过期，请检查所选服务的密钥。'],
    ["Error invoking remote method 'muse:agent-plan': Error: 已取消本次编排。", '已取消本次编排。'],
    ["Error invoking remote method 'muse:open-external': Error: 此链接未列入允许打开的官方帮助页面。", '此链接未列入允许打开的官方帮助页面。'],
    ["Error invoking remote method 'muse:save-llm': MusicError: 接口地址必须以 https:// 开头。", '接口地址必须以 https:// 开头。'],
    ["Error invoking remote method 'muse:get-settings': TypeError: Cannot read properties of undefined", 'Cannot read properties of undefined'],
    ["Error invoking remote method 'muse:x': 操作失败，请重试。", '操作失败，请重试。'],
    ["Error invoking remote method 'muse:x': Error: 说明里提到 Error: 字样也保留", '说明里提到 Error: 字样也保留'],
    ['已经是干净的消息。', '已经是干净的消息。'],
    ['提到 Error invoking remote method 但不在开头', '提到 Error invoking remote method 但不在开头'],
    ["Error invoking remote method 'muse:x': Error: ", '操作失败，请重试。'],
    ['', '操作失败，请重试。'],
  ];
  for (const [raw, expected] of table) {
    const { exposed } = loadBridge(async () => { throw new Error(raw); });
    for (const method of ['generateMusic', 'agentPlan', 'getSettings', 'saveLlmSettings', 'openExternal']) {
      await assert.rejects(exposed.museDesktop[method]({}), error => {
        assert.equal(error.message, expected, `${method}: ${raw}`);
        assert.equal(/^Error invoking remote method/.test(error.message), false);
        return true;
      });
    }
  }
  // Non-Error rejections are normalised too.
  for (const [thrown, expected] of [['字符串错误', '字符串错误'], [{ message: "Error invoking remote method 'muse:x': Error: 对象里的消息" }, '对象里的消息'], [undefined, '操作失败，请重试。'], [null, '操作失败，请重试。'], [42, '操作失败，请重试。'], [{ message: { nested: true } }, '操作失败，请重试。']]) {
    const { exposed } = loadBridge(() => Promise.reject(thrown));
    await assert.rejects(exposed.museDesktop.getSettings(), error => error.message === expected);
  }
});

test('successful results and arguments pass through untouched', async () => {
  const audio = new ArrayBuffer(8);
  const { exposed } = loadBridge(async (_channel, input) => ({ echoed: input, audio }));
  const input = { prompt: '青春欢快', duration: 30 };
  const result = await exposed.museDesktop.generateMusic(input);
  assert.equal(result.echoed, input);
  assert.equal(result.audio, audio);
});
