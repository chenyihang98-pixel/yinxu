'use strict';

// Creates the included demo through the real UI, using a temporary profile.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(read, accept, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await sleep(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const examples = path.join(root, 'examples');
  const artifacts = path.join(root, 'test-results');
  await fs.mkdir(examples, { recursive: true });
  await fs.mkdir(artifacts, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-demo-'));
  const env = { ...process.env, MUSE_PORTABLE_DATA: '1', PORTABLE_EXECUTABLE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.MUSE_DEV_URL;
  let desktop;
  try {
    desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => Boolean(window.museDesktop) && Boolean(document.querySelector('textarea[aria-label="音乐描述"]')));
    const settings = await page.evaluate(() => window.museDesktop.getSettings());
    assert.equal(settings.hasApiKey, false);
    assert.equal(path.resolve(settings.dataPath), path.join(profile, 'Muse-Data'));
    await page.setViewportSize({ width: 1440, height: 1020 });
    await page.getByLabel('生成时长').selectOption('30');
    await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
    await page.getByRole('textbox', { name: '作品名称', exact: true }).waitFor();
    await waitFor(() => page.getByRole('button', { name: '导出', exact: true }).isEnabled(), Boolean, 'generation');
    await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('夏日小事');
    await page.getByRole('textbox', { name: '作品名称', exact: true }).press('Enter');
    await waitFor(() => page.locator('.recent-list button').first().textContent(), value => value.includes('夏日小事'), 'title save');
    const saveFile = async (file, label) => {
      await desktop.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }); }, file);
      await page.getByRole('button', { name: label }).click();
      return waitFor(async () => { try { return await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, result => Boolean(result?.length), file);
    };
    await page.getByRole('button', { name: '导出', exact: true }).click();
    const wavPath = path.join(examples, '夏日小事.wav');
    const wav = await saveFile(wavPath, /导出无损音频/);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 2);
    assert.equal(wav.readUInt32LE(24), 32000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.length, 44 + 30 * 32000 * 4);
    let power = 0;
    for (let i = 44; i < wav.length; i += 2) { const sample = wav.readInt16LE(i) / 32768; power += sample * sample; }
    const rms = Math.sqrt(power / ((wav.length - 44) / 2));
    assert.ok(rms > 0.004 && rms < 0.7);
    const jsonPath = path.join(examples, '夏日小事.muse.json');
    const project = JSON.parse((await saveFile(jsonPath, /保存可编辑工程/)).toString('utf8'));
    assert.equal(project.title, '夏日小事'); assert.equal(project.provider, 'local');
    assert.equal(project.config.duration, 30); assert.equal(project.config.mood, 'bright');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const screenshot = path.join(artifacts, 'muse-workbench.png');
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled', style: '.toast { visibility: hidden !important; }' });
    console.log(JSON.stringify({ wavPath, jsonPath, screenshot, seconds: 30, sampleRate: 32000, channels: 2, bits: 16, bytes: wav.length, rms, config: project.config }, null, 2));
  } finally {
    if (desktop) await desktop.close();
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('muse-demo-')) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
