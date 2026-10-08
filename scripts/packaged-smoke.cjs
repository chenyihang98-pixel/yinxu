'use strict';

// Test the distributable binary, not electron .; never uses keys or paid services.
const { _electron: electron, chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  let result;
  while (Date.now() < end) {
    result = await read();
    if (check(result)) return result;
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}; last value: ${JSON.stringify(result)}`);
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const executablePath = path.join(root, 'release', 'win-unpacked', 'Muse BGM.exe');
  const packageVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const portablePath = path.join(root, 'release', `Muse-BGM-${packageVersion}-Windows.exe`);
  await fs.access(executablePath); await fs.access(portablePath);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-packaged-smoke-'));
  const artifacts = path.join(root, 'test-results');
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, MUSE_PORTABLE_DATA: '1', PORTABLE_EXECUTABLE_DIR: temp };
  delete env.ELECTRON_RUN_AS_NODE; delete env.MUSE_DEV_URL;
  let app;
  let portable;
  let browser;
  const errors = [];
  const summary = { executablePath, version: packageVersion, checks: [], errors };
  const check = message => { summary.checks.push(message); console.log(`PASS ${message}`); };
  try {
    const launch = async () => {
      app = await electron.launch({ executablePath, args: [], env, cwd: root, timeout: 30000 });
      const page = await app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.waitForFunction(() => Boolean(window.museDesktop) && Boolean(document.querySelector('textarea[aria-label="音乐描述"]')));
      return page;
    };
    let page = await launch();
    await page.setViewportSize({ width: 1440, height: 1020 });
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), packageVersion);
    const settings = await page.evaluate(() => window.museDesktop.getSettings());
    assert.equal(settings.hasApiKey, false);
    assert.equal(path.resolve(settings.dataPath), path.join(temp, 'Muse-Data'));
    const expectedProviders = ['aliyun', 'elevenlabs', 'tencent', 'volcengine'];
    assert.deepEqual(Object.keys(settings.providers).sort(), expectedProviders);
    for (const status of Object.values(settings.providers)) assert.deepEqual(status, { configured: false });
    const providerOptions = await page.getByLabel('生成引擎').locator('option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent })));
    for (const [provider, label] of [['tencent', '腾讯云'], ['volcengine', '火山引擎'], ['aliyun', '阿里云']]) {
      assert.ok(providerOptions.some(option => option.value === provider && option.label.includes(label)), `${provider} must ship in the provider selector`);
    }
    summary.providers = providerOptions;
    check('Packaged version matches release; Tencent, Volcengine and Aliyun selectors plus four credential statuses are present');
    await page.getByLabel('生成时长').selectOption('15');
    await page.getByRole('textbox', { name: '音乐描述', exact: true }).fill('青春欢快，轻快的钢琴，阳光午后的背景音乐');
    await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
    await page.getByRole('textbox', { name: '作品名称', exact: true }).waitFor({ timeout: 60000 });
    await until(() => page.getByRole('button', { name: '导出', exact: true }).isEnabled(), Boolean, 'generation completes');
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('Packaged Smoke 青春钢琴');
    await page.getByRole('textbox', { name: '作品名称', exact: true }).press('Enter');
    check('Actual packaged EXE launches; 15-second offline composition completes');

    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(() => page.getByRole('slider', { name: '播放进度' }).inputValue(), value => Number(value) > 0.2, 'audio playback');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const wavPath = path.join(temp, 'packaged-output.wav');
    await app.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }); }, wavPath);
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await page.getByRole('button', { name: /导出无损音频/ }).click();
    const wav = await until(() => fs.readFile(wavPath).catch(() => null), bytes => bytes?.length > 44, 'WAV written');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 2); assert.equal(wav.readUInt32LE(24), 32000); assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.length, 44 + 15 * 32000 * 4);
    let power = 0;
    for (let offset = 44; offset < wav.length; offset += 2) power += (wav.readInt16LE(offset) / 32768) ** 2;
    const rms = Math.sqrt(power / ((wav.length - 44) / 2));
    assert.ok(rms > 0.004 && rms < 0.7);
    summary.wav = { bytes: wav.length, rms, sha256: crypto.createHash('sha256').update(wav).digest('hex') };
    await fs.copyFile(wavPath, path.join(artifacts, 'packaged-sample.wav'));
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, 'packaged-generated.png'), fullPage: true, animations: 'disabled' });
    check('Packaged audio plays and exports an audible stereo 32 kHz 16-bit WAV via real IPC');
    await page.getByRole('button', { name: /^我的作品/ }).click();
    await until(() => page.locator('.project-card').count(), count => count === 1, 'one saved library item');
    assert.match(await page.locator('.project-card').textContent(), /Packaged Smoke 青春钢琴/);
    // Fixture only: use our locally exported WAV to exercise cloud Blob persistence.
    // No ElevenLabs request is sent, and this audio is never presented as an MP3.
    await page.evaluate(base64 => new Promise((resolve, reject) => {
      const request = indexedDB.open('muse-bgm', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('projects', 'readwrite');
        const store = tx.objectStore('projects');
        const items = store.getAll();
        items.onsuccess = () => {
          const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
          store.put({ ...items.result[0], id: 'fixture-cloud-blob', title: 'Fixture cloud audio persistence', provider: 'elevenlabs', audioBlob: new Blob([bytes], { type: 'audio/wav' }), updatedAt: new Date().toISOString() });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }), wav.toString('base64'));
    await app.close(); app = null;

    page = await launch();
    await page.getByRole('button', { name: /^我的作品/ }).click();
    await until(() => page.locator('.project-card').count(), count => count === 2, 'library survives process restart');
    await page.getByRole('button', { name: '打开 Packaged Smoke 青春钢琴', exact: true }).click();
    await until(() => page.getByRole('button', { name: '播放', exact: true }).isEnabled(), Boolean, 'saved audio reopens');
    check('A full packaged process restart preserves library and reopens saved music');
    await page.getByRole('button', { name: /^我的作品/ }).click();
    await page.getByRole('button', { name: '打开 Fixture cloud audio persistence', exact: true }).click();
    await until(() => page.getByRole('button', { name: '播放', exact: true }).isEnabled(), Boolean, 'fixture cloud WAV decodes after restart');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await until(() => page.getByRole('slider', { name: '播放进度' }).inputValue(), value => Number(value) > 0.2, 'persisted fixture audio plays');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const blobState = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('muse-bgm', 1);
      request.onsuccess = () => {
        const db = request.result;
        const query = db.transaction('projects', 'readonly').objectStore('projects').get('fixture-cloud-blob');
        query.onsuccess = () => { const item = query.result; db.close(); resolve({ provider: item.provider, isBlob: item.audioBlob instanceof Blob, type: item.audioBlob.type, size: item.audioBlob.size }); };
        query.onerror = () => reject(query.error);
      };
      request.onerror = () => reject(request.error);
    }));
    assert.deepEqual(blobState, { provider: 'elevenlabs', isBlob: true, type: 'audio/wav', size: wav.length });
    summary.cloudFixture = { ...blobState, source: 'Locally generated WAV fixture; no AI service invoked' };
    check('Fixture cloud audio Blob survives process restart, retains MIME/data, decodes and plays');
    await app.close(); app = null;

    // Copy the wrapper to our own directory: NSIS sets PORTABLE_EXECUTABLE_DIR itself.
    const wrapperDir = path.join(temp, 'portable');
    await fs.mkdir(wrapperDir);
    const wrapper = path.join(wrapperDir, path.basename(portablePath));
    await fs.copyFile(portablePath, wrapper);
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    portable = spawn(wrapper, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], { cwd: wrapperDir, env: { ...env, PORTABLE_EXECUTABLE_DIR: wrapperDir }, windowsHide: true, stdio: 'ignore' });
    const endpoint = await until(async () => {
      try { const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }); return await response.json(); }
      catch { return null; }
    }, value => Boolean(value?.webSocketDebuggerUrl), 'portable wrapper opens browser window', 60000);
    browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    const wrapperPage = await until(async () => browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('file:')), Boolean, 'portable renderer');
    await wrapperPage.waitForFunction(() => Boolean(window.museDesktop) && Boolean(document.querySelector('textarea[aria-label="音乐描述"]')));
    const portableSettings = await wrapperPage.evaluate(() => window.museDesktop.getSettings());
    assert.equal(portableSettings.hasApiKey, false);
    assert.equal(path.resolve(portableSettings.dataPath), path.join(wrapperDir, 'Muse-Data'));
    assert.deepEqual(Object.keys(portableSettings.providers).sort(), expectedProviders);
    const wrapperOptions = await wrapperPage.getByLabel('生成引擎').locator('option').evaluateAll(options => options.map(option => option.value));
    for (const provider of expectedProviders) assert.ok(wrapperOptions.includes(provider));
    summary.portable = { bytes: (await fs.stat(portablePath)).size, title: await wrapperPage.title() };
    await wrapperPage.screenshot({ path: path.join(artifacts, 'portable-launched.png'), animations: 'disabled' });
    check('Portable EXE self-extracts and opens the complete app using an isolated profile');
    const session = await browser.newBrowserCDPSession();
    // Electron may exit before acknowledging Browser.close on the CDP socket.
    await Promise.race([session.send('Browser.close').catch(() => {}), sleep(2000)]);
    await Promise.race([browser.close().catch(() => {}), sleep(2000)]); browser = null;
    await until(() => Promise.resolve(portable.exitCode), code => code !== null, 'portable exits', 15000);
    portable = null;
    assert.deepEqual(errors, []);
    check('No renderer errors in packaged generation or restart');
    await fs.writeFile(path.join(artifacts, 'packaged-smoke-results.json'), JSON.stringify(summary, null, 2));
  } finally {
    if (app) await app.close().catch(() => {});
    if (browser) {
      const session = await browser.newBrowserCDPSession().catch(() => null);
      if (session) await Promise.race([session.send('Browser.close').catch(() => {}), sleep(2000)]);
      await Promise.race([browser.close().catch(() => {}), sleep(2000)]);
    }
    if (portable && portable.exitCode === null) {
      await new Promise(resolve => { const killer = spawn('taskkill.exe', ['/pid', String(portable.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('exit', resolve); killer.once('error', resolve); });
    }
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('muse-packaged-smoke-')) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  console.log(`Packaged smoke passed: ${summary.checks.length} checks.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
