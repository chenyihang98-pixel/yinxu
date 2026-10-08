'use strict';

// End-to-end checks of the packaged renderer against a disposable Electron profile.
// Run `npm run build && node scripts/ui-smoke.cjs`. No credentials or AI calls.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(read, test, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let result;
  do {
    result = await read();
    if (test(result)) return result;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}; last value: ${JSON.stringify(result)}`);
}

async function records(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('muse-bgm', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const query = tx.objectStore('projects').getAll();
      query.onsuccess = () => resolve(query.result.map(({ audioBlob, ...metadata }) => metadata).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      query.onerror = () => reject(query.error);
      tx.oncomplete = () => db.close();
    };
  }));
}

async function setRange(page, label, value) {
  const range = page.getByRole('slider', { name: label, exact: true });
  await range.evaluate((input, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(nextValue));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await until(() => range.inputValue(), result => Math.abs(Number(result) - value) < 0.001, `${label} reflects ${value}`);
}

async function readSavedFile(file) {
  return until(async () => { try { return await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, result => Boolean(result?.length), `export ${path.basename(file)}`);
}

function verifyWav(bytes, seconds) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 2);
  assert.equal(bytes.readUInt32LE(24), 32000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.length, 44 + seconds * 32000 * 2 * 2);
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  let power = 0;
  for (let i = 44; i < bytes.length; i += 2) { const sample = bytes.readInt16LE(i) / 32768; power += sample * sample; }
  const rms = Math.sqrt(power / ((bytes.length - 44) / 2));
  assert.ok(rms > 0.004 && rms < 0.7, `audible, unclipped PCM; RMS=${rms}`);
  return { bytes: bytes.length, rms, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  await fs.access(path.join(root, 'dist', 'index.html'));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ui-smoke-'));
  const artifacts = path.join(root, 'test-results');
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, MUSE_PORTABLE_DATA: '1', PORTABLE_EXECUTABLE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MUSE_DEV_URL;
  let desktop;
  let page;
  const consoleErrors = [];
  const checks = [];
  const check = message => { checks.push(message); console.log(`PASS ${message}`); };
  try {
    desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.waitForFunction(() => Boolean(window.museDesktop) && Boolean(document.querySelector('textarea[aria-label="音乐描述"]')));
    const settings = await page.evaluate(() => window.museDesktop.getSettings());
    assert.equal(settings.hasApiKey, false);
    assert.equal(path.resolve(settings.dataPath), path.join(profile, 'Muse-Data'));
    const resize = async width => {
      await page.setViewportSize({ width, height: 1020 });
      await page.waitForFunction(size => innerWidth === size, width);
    };
    const screenshot = async name => {
      await page.evaluate(() => { document.querySelector('main')?.scrollTo(0, 0); window.scrollTo(0, 0); });
      await page.screenshot({ path: path.join(artifacts, name), fullPage: true, animations: 'disabled', style: '.toast { visibility: hidden !important; }' });
    };
    const waitCount = count => until(() => records(page), values => values.length === count, `${count} saved projects`);
    const latest = async () => (await records(page))[0];
    const waitReady = async () => { await page.getByRole('button', { name: '生成我的 BGM', exact: true }).waitFor(); await until(() => page.getByRole('button', { name: '生成我的 BGM', exact: true }).isEnabled(), Boolean, 'generation finished'); };
    const setSavePath = async destination => desktop.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    await resize(1440);
    await screenshot('ui-initial-1440.png');
    await page.getByLabel('生成时长').selectOption('15');
    await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
    await waitCount(1); await waitReady();
    const first = await latest();
    assert.equal(first.provider, 'local'); assert.equal(first.config.duration, 15); assert.equal(first.revision, 1);
    assert.ok(await page.getByRole('button', { name: '播放', exact: true }).isEnabled());
    await page.getByRole('textbox', { name: '作品名称' }).fill('Smoke 青春 BGM');
    await page.getByRole('textbox', { name: '作品名称' }).press('Enter');
    await until(latest, item => item.title === 'Smoke 青春 BGM', 'title saved');
    await screenshot('ui-generated-1440.png');
    check('15-second local composition generated and persisted; title editable');

    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
    await until(() => page.getByRole('slider', { name: '播放进度' }).inputValue(), value => Number(value) > 0.2, 'playback advances');
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await setRange(page, '播放进度', 7.5);
    assert.equal(await page.locator('.transport-time strong').textContent(), '00:07');
    await page.getByRole('button', { name: '回到开头', exact: true }).click();
    assert.equal(Number(await page.getByRole('slider', { name: '播放进度' }).inputValue()), 0);
    check('audio playback, pause, seeking, and rewind');

    await setRange(page, '节奏速度', 94);
    await page.getByLabel('主奏乐器', { exact: true }).selectOption('guitar');
    await page.getByRole('button', { name: '应用调整', exact: true }).click();
    await waitCount(2); await waitReady();
    const adjusted = await latest();
    assert.equal(adjusted.config.bpm, 94); assert.equal(adjusted.config.instrument, 'guitar');
    assert.equal(adjusted.config.seed, first.config.seed); assert.equal(adjusted.revision, 2);
    await page.getByRole('textbox', { name: '微调描述', exact: true }).fill('慢一点');
    await page.getByRole('button', { name: '应用描述微调', exact: true }).click();
    await waitCount(3); await waitReady();
    const refined = await latest();
    assert.equal(refined.config.bpm, 82); assert.equal(refined.config.instrument, 'guitar');
    assert.equal(refined.config.seed, first.config.seed); assert.equal(refined.revision, 3);
    check('manual adjustment keeps 94 BPM and guitar; natural refinement becomes 82 BPM with original seed');

    await page.getByRole('button', { name: '收藏作品', exact: true }).click();
    await until(latest, item => item.favorite, 'favorite persisted');
    await page.getByRole('button', { name: '鼓组静音', exact: true }).click();
    await until(latest, item => item.config.volumes.drums === 0, 'drums muted and persisted');
    assert.equal(Number(await page.getByRole('slider', { name: '鼓组音量' }).inputValue()), 0);
    await page.getByRole('button', { name: '旋律独奏', exact: true }).click();
    assert.match(await page.getByRole('button', { name: '旋律独奏', exact: true }).getAttribute('class'), /active/);
    await page.getByRole('button', { name: '导出', exact: true }).click();
    assert.match(await page.locator('.export-warning').textContent(), /独奏/);
    const soloPath = path.join(profile, 'solo.wav');
    await setSavePath(soloPath);
    await page.getByRole('button', { name: /导出无损音频/ }).click();
    const soloAudio = verifyWav(await readSavedFile(soloPath), 15);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '旋律独奏', exact: true }).click();
    await setRange(page, '鼓组音量', 0.31);
    await until(latest, item => item.config.volumes.drums === 0.31, 'custom drum volume persisted');
    await page.getByRole('button', { name: '导出', exact: true }).click();
    assert.equal(await page.locator('.export-warning').count(), 0);
    const wavPath = path.join(profile, 'mix.wav');
    await setSavePath(wavPath);
    await page.getByRole('button', { name: /导出无损音频/ }).click();
    const mixedAudio = verifyWav(await readSavedFile(wavPath), 15);
    assert.notEqual(mixedAudio.sha256, soloAudio.sha256, 'solo and full mix must differ');
    const jsonPath = path.join(profile, 'project.json');
    await setSavePath(jsonPath);
    await page.getByRole('button', { name: /保存可编辑工程/ }).click();
    const exported = JSON.parse((await readSavedFile(jsonPath)).toString('utf8'));
    assert.equal(exported.schemaVersion, 1); assert.equal(exported.config.bpm, 82);
    assert.equal(exported.config.seed, first.config.seed); assert.equal(exported.config.volumes.drums, 0.31);
    check(`mixer mute/solo changes PCM; WAV export valid (${mixedAudio.bytes} bytes); JSON export keeps settings`);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await resize(1060); await screenshot('ui-generated-1060.png');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, '1060px layout must not overflow horizontally');
    await resize(1440);

    await page.locator('input[type="file"]').setInputFiles(jsonPath);
    await waitCount(4); await waitReady();
    const imported = await latest();
    assert.notEqual(imported.id, exported.id); assert.deepEqual(imported.config, exported.config);
    await page.getByRole('button', { name: /^我的作品/ }).click();
    await until(() => page.locator('.project-card').count(), count => count === 4, 'four library cards');
    await page.getByRole('textbox', { name: '搜索作品', exact: true }).fill('not-a-real-title');
    assert.equal(await page.locator('.project-card').count(), 0);
    await page.getByRole('textbox', { name: '搜索作品', exact: true }).fill('Smoke');
    assert.equal(await page.locator('.project-card').count(), 4);
    await page.getByRole('button', { name: '我的收藏', exact: true }).click();
    assert.equal(await page.locator('.project-card').count(), 2);
    await screenshot('ui-library-1440.png');
    check('JSON imports as a separate editable work; library search and favorites filter');

    await page.reload();
    await page.getByRole('button', { name: /^我的作品/ }).click();
    await until(() => page.locator('.project-card').count(), count => count === 4, 'saved projects after reload');
    assert.equal((await records(page)).filter(item => item.favorite).length, 2);
    await page.locator('.project-cover').first().click();
    await waitReady();
    assert.equal(Number(await page.getByRole('slider', { name: '节奏速度' }).inputValue()), 82);
    assert.equal(await page.getByLabel('主奏乐器', { exact: true }).inputValue(), 'guitar');
    await page.getByRole('button', { name: '灵感库', exact: true }).click();
    assert.equal(await page.locator('.inspiration-card').count(), 6);
    await page.getByRole('button', { name: /掉进一场好梦/ }).click();
    assert.match(await page.getByRole('textbox', { name: '音乐描述', exact: true }).inputValue(), /梦幻/);
    assert.equal(await page.getByLabel('主奏乐器', { exact: true }).inputValue(), 'bell');
    check('reload restores saved projects; opening restores settings; six inspiration presets available');
    assert.deepEqual(consoleErrors, [], 'renderer must have no errors');
    check('renderer console and page error checks');
    const summary = { passed: checks.length, checks, consoleErrors, audio: { solo: soloAudio, mix: mixedAudio }, screenshots: ['ui-initial-1440.png', 'ui-generated-1440.png', 'ui-generated-1060.png', 'ui-library-1440.png'] };
    await fs.writeFile(path.join(artifacts, 'ui-smoke-results.json'), JSON.stringify(summary, null, 2));
    console.log(`UI smoke passed: ${checks.length} checks; screenshots in ${artifacts}`);
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, 'ui-smoke-failure.png'), fullPage: true }).catch(() => {});
      console.error('UI alerts:', await page.locator('[role="alert"]').allTextContents().catch(() => []));
    }
    console.error('Renderer errors:', consoleErrors);
    throw error;
  } finally {
    if (desktop) await desktop.close();
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('muse-ui-smoke-')) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
