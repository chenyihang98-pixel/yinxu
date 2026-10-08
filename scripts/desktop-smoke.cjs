'use strict';

// Launch the compiled UI with a disposable profile. No AI requests or real keys.
// Run `npm run build` first. Optional MUSE_SCREENSHOT_PATH captures the initial UI.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  await fs.access(path.join(root, 'dist', 'index.html'));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-desktop-smoke-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MUSE_DEV_URL;
  env.MUSE_PORTABLE_DATA = '1';
  env.PORTABLE_EXECUTABLE_DIR = profile;
  let desktop;
  try {
    desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => Boolean(window.museDesktop), null, { timeout: 15000 });
    await page.locator('#root').waitFor();
    await page.waitForFunction(() => document.querySelector('#root')?.textContent?.length > 50);
    const result = await page.evaluate(async () => {
      const settings = await window.museDesktop.getSettings();
      const bridgeKeys = Object.keys(window.museDesktop).sort();
      return { settings, bridgeKeys, nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined' };
    });
    assert.equal(result.nodeExposed, false, 'Node must not be exposed to the renderer');
    assert.equal(result.settings.hasApiKey, false, 'Smoke profile must contain no credentials');
    assert.equal(path.resolve(result.settings.dataPath), path.join(profile, 'Muse-Data'), 'Smoke must use a disposable profile');
    assert.deepEqual(result.bridgeKeys, ['cancelGeneration', 'deleteApiKey', 'deleteProviderCredentials', 'generateMusic', 'getSettings', 'openExternal', 'saveApiKey', 'saveAudio', 'saveProviderCredentials'].sort());
    assert.deepEqual(Object.keys(result.settings.providers).sort(), ['aliyun', 'elevenlabs', 'tencent', 'volcengine']);
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox };
    });
    assert.deepEqual(preferences, { contextIsolation: true, nodeIntegration: false, sandbox: true });
    await assert.rejects(page.evaluate(() => window.museDesktop.openExternal('https://example.com')), /未列入/);
    await assert.rejects(page.evaluate(() => window.museDesktop.generateMusic({ prompt: 'test', duration: 30 })), /填写.*凭据/);
    const fakeKey = 'muse-smoke-only-not-a-real-api-key';
    await page.evaluate(key => window.museDesktop.saveApiKey(key), fakeKey);
    const storedSettings = await page.evaluate(() => window.museDesktop.getSettings());
    assert.equal(storedSettings.hasApiKey, true);
    assert.equal(JSON.stringify(storedSettings).includes(fakeKey), false);
    const encrypted = await fs.readFile(path.join(profile, 'Muse-Data', 'music-credentials.json'), 'utf8');
    assert.equal(encrypted.includes(fakeKey), false, 'DPAPI store must not contain a plaintext API key');
    await page.evaluate(() => window.museDesktop.deleteApiKey());
    assert.equal((await page.evaluate(() => window.museDesktop.getSettings())).hasApiKey, false);
    if (process.env.MUSE_SCREENSHOT_PATH) {
      const screenshotPath = path.resolve(process.env.MUSE_SCREENSHOT_PATH);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath });
    }
    console.log('Desktop smoke passed: compiled UI, isolated preload, encrypted key CRUD, missing-key guard, link restrictions.');
  } finally {
    if (desktop) await desktop.close();
    // The resolved directory was created by this script under the OS temp directory.
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('muse-desktop-smoke-')) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
