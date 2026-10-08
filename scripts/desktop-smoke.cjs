'use strict';

// Launch the compiled UI with a disposable profile and exercise the desktop bridge.
// No AI service is contacted and no real key is used: the only HTTP goes to a mock
// "local model" server on 127.0.0.1 started by this script.
// Run `npm run build` first. Optional MUSE_SCREENSHOT_PATH captures the initial UI.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const BRIDGE_KEYS = [
  'agentPlan', 'cancelAgent', 'cancelGeneration', 'deleteApiKey', 'deleteLlmSettings', 'deleteProviderCredentials',
  'generateMusic', 'getSettings', 'openExternal', 'saveApiKey', 'saveAudio', 'saveLlmSettings', 'saveProviderCredentials',
];
const CURRENT = { style: 'bright', instrument: 'piano', key: 'C major', bpm: 112, duration: 30, energy: 0.62, complexity: 0.5, reverb: 0.25, loop: true, volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 } };
const PLAN_INPUT = { mode: 'new', request: '雨天咖啡馆里的慵懒爵士，一分钟，不要鼓', provider: 'local', history: [], current: CURRENT };
const MOCK_PLAN = {
  reasoning: ['雨天咖啡馆：慵懒、温暖', '不要鼓：drums 设为 none'],
  style: 'jazz', instrument: 'vibes', key: 'F major', bpm: 84, duration: 60, energy: 0.35, complexity: 0.6, reverb: 0.35, loop: true, newMelody: true,
  volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
  arrangement: { progression: ['ii7', 'V7', 'Imaj7', 'vi7'], form: [], drums: 'none', bass: 'walking', swing: 0.4, layers: { pad: true, arp: false, counter: false, perc: false }, melody: { density: -1, register: 'mid', motion: 'stepwise' } },
  title: '雨天特调', reply: '好的，做一首不带鼓的慵懒爵士，像雨天窝在咖啡馆里。', cloudPrompt: '慵懒的咖啡馆爵士，颤音琴主奏，行走贝斯，84 BPM，纯音乐，无人声，无歌词。',
  unexpected: 'dropped by validation',
};

/** Reject -> message, resolve -> null: lets the test compare the exact text the UI would show. */
const messageOf = (page, expression) => page.evaluate(`(${expression}).then(() => null, error => error.message)`);

async function closedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startMockModel() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
      response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'tracking=1; Path=/' });
      response.end(JSON.stringify({ model: 'mock-local-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `<think>先想一想</think>\n\`\`\`json\n${JSON.stringify(MOCK_PLAN)}\n\`\`\`` } }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, port: server.address().port };
}

// MUSE_SMOKE_EXECUTABLE=<path to a packaged "Muse BGM.exe"> runs the same checks against a packaged build.
const EXECUTABLE = process.env.MUSE_SMOKE_EXECUTABLE ? path.resolve(process.env.MUSE_SMOKE_EXECUTABLE) : null;

async function launch(root, appPath, profile) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MUSE_DEV_URL;
  delete env.MUSE_NETWORK;
  env.MUSE_PORTABLE_DATA = '1';
  env.PORTABLE_EXECUTABLE_DIR = profile;
  const desktop = EXECUTABLE
    ? await electron.launch({ executablePath: EXECUTABLE, args: [], cwd: path.dirname(EXECUTABLE), env, timeout: 30000 })
    : await electron.launch({ args: [appPath], cwd: appPath, env, timeout: 30000 });
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => Boolean(window.museDesktop), null, { timeout: 15000 });
  await page.locator('#root').waitFor();
  return { desktop, page };
}

async function removeProfile(profile, prefix) {
  // The resolved directory was created by this script under the OS temp directory.
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith(prefix)) {
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function bridgeChecks(root) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-desktop-smoke-'));
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const credentialFile = path.join(profile, 'Muse-Data', 'music-credentials.json');
  const mock = await startMockModel();
  let desktop;
  try {
    const launched = await launch(root, root, profile);
    desktop = launched.desktop;
    const page = launched.page;
    await page.waitForFunction(() => document.querySelector('#root')?.textContent?.length > 50);
    const result = await page.evaluate(async () => {
      const settings = await window.museDesktop.getSettings();
      const bridgeKeys = Object.keys(window.museDesktop).sort();
      return { settings, bridgeKeys, nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined' };
    });
    assert.equal(result.nodeExposed, false, 'Node must not be exposed to the renderer');
    assert.deepEqual(result.bridgeKeys, BRIDGE_KEYS);
    assert.deepEqual(Object.keys(result.settings).sort(), ['dataPath', 'hasApiKey', 'llm', 'providers', 'version']);
    assert.equal(result.settings.hasApiKey, false, 'Smoke profile must contain no credentials');
    assert.equal(path.resolve(result.settings.dataPath), path.join(profile, 'Muse-Data'), 'Smoke must use a disposable profile');
    assert.equal(result.settings.version, version);
    assert.deepEqual(result.settings.llm, { configured: false });
    assert.deepEqual(result.settings.providers, { elevenlabs: { configured: false }, tencent: { configured: false }, volcengine: { configured: false }, aliyun: { configured: false } });
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox };
    });
    assert.deepEqual(preferences, { contextIsolation: true, nodeIntegration: false, sandbox: true });
    // The only runtime dependency of the main process must be loadable from the app (also when packed into app.asar).
    const runtime = await desktop.evaluate(({ app }) => {
      const { createRequire } = process.mainModule.require('node:module');
      const appRequire = createRequire(process.mainModule.require('node:path').join(app.getAppPath(), 'package.json'));
      return { packaged: app.isPackaged, sdk: typeof appRequire('@anthropic-ai/sdk').Anthropic };
    });
    assert.deepEqual(runtime, { packaged: Boolean(EXECUTABLE), sdk: 'function' });

    // Errors reach the renderer as the plain Chinese message, without Electron's IPC prefix.
    assert.equal(await messageOf(page, `window.museDesktop.openExternal('https://example.com')`), '此链接未列入允许打开的官方帮助页面。');
    assert.equal(await messageOf(page, `window.museDesktop.generateMusic({ prompt: 'test', duration: 30 })`), '请先在设置中填写所选音乐服务的凭据。');

    // Cloud music key: encrypted CRUD.
    const fakeKey = 'muse-smoke-only-not-a-real-api-key';
    await page.evaluate(key => window.museDesktop.saveApiKey(key), fakeKey);
    const storedSettings = await page.evaluate(() => window.museDesktop.getSettings());
    assert.equal(storedSettings.hasApiKey, true);
    assert.deepEqual(storedSettings.providers.elevenlabs, { configured: true, model: 'music_v1' });
    assert.equal(JSON.stringify(storedSettings).includes(fakeKey), false);
    assert.equal((await fs.readFile(credentialFile, 'utf8')).includes(fakeKey), false, 'DPAPI store must not contain a plaintext API key');

    // Producer agent settings: validation, encrypted CRUD, status without the key.
    assert.equal(await messageOf(page, `window.museDesktop.agentPlan(${JSON.stringify(PLAN_INPUT)})`), '还没有配置大模型。请先在设置中填写大模型的连接信息。');
    assert.equal(await messageOf(page, `window.museDesktop.saveLlmSettings({ kind: 'openai', preset: 'custom', apiKey: 'sk-smoke-only-not-real', model: 'some-model', baseUrl: 'https://127.0.0.1/v1' })`), '接口地址不能指向本机或内网。本机模型请选择“本机 Ollama”。');
    const fakeLlmKey = 'sk-ant-smoke-only-not-a-real-key';
    await page.evaluate(key => window.museDesktop.saveLlmSettings({ kind: 'anthropic', preset: 'claude', apiKey: key, model: 'claude-opus-5-5' }), fakeLlmKey);
    const withLlm = await page.evaluate(() => window.museDesktop.getSettings());
    assert.deepEqual(withLlm.llm, { configured: true, kind: 'anthropic', model: 'claude-opus-5-5', preset: 'claude' });
    assert.equal(withLlm.hasApiKey, true, 'saving LLM settings must not disturb the music credentials');
    const storedFile = await fs.readFile(credentialFile, 'utf8');
    assert.equal(storedFile.includes(fakeLlmKey), false, 'LLM key must be stored encrypted');
    assert.deepEqual(Object.keys(JSON.parse(storedFile)).sort(), ['llm', 'providers', 'version']);
    assert.deepEqual(Object.keys(JSON.parse(storedFile).providers), ['elevenlabs'], 'LLM settings stay outside the music providers map');

    // A plan through the whole chain (preload -> IPC guard -> DPAPI store -> agent service ->
    // Chromium network stack -> validation), against the mock local model on 127.0.0.1.
    await page.evaluate(port => window.museDesktop.saveLlmSettings({ kind: 'ollama', preset: 'ollama', apiKey: '', model: 'mock-local-model', baseUrl: `http://localhost:${port}/v1` }), mock.port);
    assert.deepEqual((await page.evaluate(() => window.museDesktop.getSettings())).llm, { configured: true, kind: 'ollama', model: 'mock-local-model', preset: 'ollama', baseUrl: `http://127.0.0.1:${mock.port}/v1` });
    // Saving a local model warms it up in the background: one request for a single token, answer discarded.
    for (let waited = 0; mock.requests.length < 1 && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(mock.requests.length, 1, 'the warm-up reached the local model');
    assert.equal(mock.requests[0].url, '/v1/chat/completions');
    assert.equal(mock.requests[0].method, 'POST');
    assert.equal(mock.requests[0].body.model, 'mock-local-model');
    assert.equal(mock.requests[0].body.max_tokens, 1);
    assert.deepEqual(mock.requests[0].body.messages.map(message => message.role), ['system', 'user']);
    assert.equal(mock.requests[0].headers.authorization, undefined);
    const planned = await page.evaluate(input => window.museDesktop.agentPlan(input), PLAN_INPUT);
    assert.deepEqual(Object.keys(planned).sort(), ['model', 'plan']);
    assert.equal(planned.model, 'mock-local-model');
    const { unexpected: _dropped, ...expectedPlan } = MOCK_PLAN;
    assert.deepEqual(planned.plan, expectedPlan, 'only validated plan fields come back');
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1].url, '/v1/chat/completions');
    assert.equal(mock.requests[1].headers.authorization, undefined, 'a local model gets no Authorization header');
    assert.equal(mock.requests[1].body.model, 'mock-local-model');
    assert.equal(mock.requests[1].headers.cookie, undefined, 'the warm-up left no cookie behind');
    await page.evaluate(input => window.museDesktop.agentPlan(input), PLAN_INPUT);
    assert.equal(mock.requests[2].headers.cookie, undefined, 'main-process requests keep no cookies');
    assert.equal(mock.requests.length, 3, 'one warm-up per save, none per plan');
    assert.equal(await messageOf(page, `window.museDesktop.agentPlan({ ...${JSON.stringify(PLAN_INPUT)}, request: '' })`), '请先说说想要什么样的音乐。');
    assert.equal(await messageOf(page, `window.museDesktop.agentPlan({ ...${JSON.stringify(PLAN_INPUT)}, baseUrl: 'https://evil.test', current: null })`), '编排请求的参数无效，请重新生成一次。');
    await page.evaluate(() => window.museDesktop.cancelAgent());

    // An unreachable local model fails fast with a safe message.
    const deadPort = await closedPort();
    await page.evaluate(port => window.museDesktop.saveLlmSettings({ kind: 'ollama', preset: 'ollama', apiKey: '', model: 'mock-local-model', baseUrl: `http://127.0.0.1:${port}/v1` }), deadPort);
    assert.equal(await messageOf(page, `window.museDesktop.agentPlan(${JSON.stringify(PLAN_INPUT)})`), '无法连接本机的 Ollama。请确认 Ollama 已启动，且设置里的地址和端口正确。');

    // A warm-up that cannot connect (the save above) is silent: no dialog, no rejected save, nothing in the page.
    await page.evaluate(() => window.museDesktop.deleteLlmSettings());
    await page.evaluate(() => window.museDesktop.deleteApiKey());
    const cleared = await page.evaluate(() => window.museDesktop.getSettings());
    assert.equal(cleared.hasApiKey, false);
    assert.deepEqual(cleared.llm, { configured: false });

    // One damaged entry must not take the settings call (or the other services) down.
    await page.evaluate(key => window.museDesktop.saveApiKey(key), fakeKey);
    const damaged = JSON.parse(await fs.readFile(credentialFile, 'utf8'));
    damaged.providers.tencent = { encryptedCredentials: 'bm90LWEtcmVhbC1jaXBoZXJ0ZXh0' };
    damaged.providers.futureService = { anything: true };
    damaged.futureTopLevel = { kept: true };
    await fs.writeFile(credentialFile, JSON.stringify(damaged));
    const afterDamage = await page.evaluate(() => window.museDesktop.getSettings());
    assert.deepEqual(afterDamage.providers.tencent, { configured: true, damaged: true });
    assert.deepEqual(afterDamage.providers.elevenlabs, { configured: true, model: 'music_v1' });
    await page.evaluate(() => window.museDesktop.deleteProviderCredentials('tencent'));
    const repaired = JSON.parse(await fs.readFile(credentialFile, 'utf8'));
    assert.deepEqual(repaired.futureTopLevel, { kept: true }, 'unknown top-level keys survive a save');
    assert.deepEqual(repaired.providers.futureService, { anything: true }, 'unknown provider ids survive a save');
    await page.evaluate(() => window.museDesktop.deleteApiKey());

    if (process.env.MUSE_SCREENSHOT_PATH) {
      const screenshotPath = path.resolve(process.env.MUSE_SCREENSHOT_PATH);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath });
    }
  } finally {
    if (desktop) await desktop.close();
    await new Promise(resolve => mock.server.close(resolve));
    await removeProfile(profile, 'muse-desktop-smoke-');
  }
}

/** The app must keep working when it is started through a lowercase drive letter (cmd, VS Code terminal). */
async function lowercaseDriveCheck(root) {
  if (EXECUTABLE) return 'skipped for a packaged executable';
  if (process.platform !== 'win32' || !/^[A-Z]:/.test(root)) return 'skipped (not a drive-letter path)';
  const lowered = root[0].toLowerCase() + root.slice(1);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-desktop-smoke-'));
  let desktop;
  try {
    const launched = await launch(root, lowered, profile);
    desktop = launched.desktop;
    const appPath = await desktop.evaluate(({ app }) => app.getAppPath());
    const pageUrl = launched.page.url();
    const settings = await launched.page.evaluate(() => window.museDesktop.getSettings());
    assert.equal(settings.hasApiKey, false);
    return `app path ${appPath}, page ${pageUrl.slice(0, 12)}…`;
  } finally {
    if (desktop) await desktop.close();
    await removeProfile(profile, 'muse-desktop-smoke-');
  }
}

async function main() {
  const root = path.resolve(__dirname, '..');
  await fs.access(EXECUTABLE ?? path.join(root, 'dist', 'index.html'));
  await bridgeChecks(root);
  const drive = await lowercaseDriveCheck(root);
  console.log(`Desktop smoke passed: isolated preload, ${BRIDGE_KEYS.length} bridge methods, settings shape, plain Chinese errors, encrypted music + LLM settings CRUD, plan through the Chromium network stack, damaged-entry isolation, lowercase drive start (${drive}).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
