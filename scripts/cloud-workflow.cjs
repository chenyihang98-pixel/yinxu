'use strict';

// Full renderer/preload/IPC/provider/decoder workflow with local audio fixtures.
// Every main-process fetch is replaced before the real app is imported.
// No provider is contacted, no real credentials are read, and no quota is used.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read, test, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let result;
  do { result = await read(); if (test(result)) return result; await sleep(100); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${message}; last value ${JSON.stringify(result)}`);
}
async function records(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('muse-bgm', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('projects', 'readonly');
      const query = tx.objectStore('projects').getAll();
      query.onsuccess = () => resolve(query.result.map(({ audioBlob, ...project }) => ({ ...project, mimeType: audioBlob?.type, audioBytes: audioBlob?.size })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      query.onerror = () => reject(query.error);
      tx.oncomplete = () => db.close();
    };
  }));
}

function bootstrapSource(root) {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, session } = require('electron');
const root = ${JSON.stringify(root)};
const fixture = name => fs.readFileSync(path.join(root, 'tests', 'fixtures', name));
const state = globalThis.__museCloudTest = { requests: [], deniedNetwork: [], unknownRequests: [], failNextTencent: false, volcPolls: 0, dialogs: [] };
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (rawUrl, options = {}) => {
  const url = new URL(String(rawUrl));
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
  state.requests.push({ url: url.href, method: options.method || 'GET', headers, body });
  options.signal?.throwIfAborted();
  if (url.href === 'https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation') {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (state.failNextTencent) { state.failNextTencent = false; return new Response(JSON.stringify({ error: 'fixture unauthorized' }), { status: 401 }); }
    const audio = fixture('music-3s.mp3');
    return json({ data: { audio: audio.toString('hex'), status: 2 }, base_resp: { status_code: 0, status_msg: 'success' }, extra_info: { music_duration: 3000, music_sample_rate: 32000, music_channel: 2, music_size: audio.length }, request_id: 'fixture-tencent' });
  }
  if (url.hostname === 'open.volcengineapi.com') {
    const action = url.searchParams.get('Action');
    if (action === 'GenBGMForTime' || action === 'GenBGM') { state.volcPolls = 0; return json({ Code: 0, Result: { TaskID: 'fixture-volc-task' } }); }
    if (action === 'QuerySong') { state.volcPolls++; return state.volcPolls === 1 ? json({ Code: 0, Result: { Status: 1 } }) : json({ Code: 0, Result: { Status: 2, SongDetail: { AudioUrl: 'https://v3-default.douyinvod.com/muse-fixture.m4a', Duration: 3 } } }); }
  }
  if (url.href === 'https://v3-default.douyinvod.com/muse-fixture.m4a') return new Response(fixture('music-3s.m4a'), { status: 200, headers: { 'Content-Type': 'audio/mp4' } });
  if (url.href === 'https://llm-cloud-fixture.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation') return json({ request_id: 'fixture-aliyun', output: { finish_reason: 'stop', audio: { url: 'https://muse-fixture.oss-cn-beijing.aliyuncs.com/music.wav' } } });
  if (url.href === 'https://muse-fixture.oss-cn-beijing.aliyuncs.com/music.wav') return new Response(fixture('music-3s.wav'), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  state.unknownRequests.push(url.href);
  throw new Error('Unrecognized mock URL: live network prohibited');
};
// Defense in depth: Chromium network paths are also denied. Local file UI still loads.
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { state.deniedNetwork.push(details.url); callback({ cancel: true }); }));
require(path.join(root, 'electron', 'main.cjs'));
`;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const artifactDir = path.join(root, 'test-results');
  await fs.mkdir(artifactDir, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-cloud-workflow-'));
  const bootstrap = path.join(profile, 'bootstrap.cjs');
  await fs.writeFile(bootstrap, bootstrapSource(root));
  const env = { ...process.env, MUSE_PORTABLE_DATA: '1', PORTABLE_EXECUTABLE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.MUSE_DEV_URL;
  const fake = { tencent: 'tokenhub-fake-key-never-live-001', accessKeyId: 'AK-fake-only-123456789', secretAccessKey: 'SK-fake-only-123456789', aliyun: 'sk-aliyun-fake-only-123456789' };
  const checks = [];
  const errors = [];
  let desktop, page;
  const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
  try {
    desktop = await electron.launch({ args: [bootstrap], cwd: root, env, timeout: 30000 });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => Boolean(window.museDesktop?.saveProviderCredentials));
    await page.getByLabel('生成引擎').waitFor();
    await page.setViewportSize({ width: 1440, height: 1020 });
    const getState = () => desktop.evaluate(() => globalThis.__museCloudTest);
    const settings = () => page.evaluate(() => window.museDesktop.getSettings());
    const closeModal = () => page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    const ready = () => until(() => page.getByRole('button', { name: '生成我的 BGM', exact: true }).isEnabled(), Boolean, 'ready to generate');
    const cleanAlert = async () => { const close = page.getByRole('button', { name: '关闭错误提示', exact: true }); if (await close.count()) await close.click(); };
    assert.equal(path.resolve((await settings()).dataPath), path.join(profile, 'Muse-Data'));

    await page.getByLabel('生成引擎').selectOption('tencent');
    await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /请先保存.*腾讯云/);
    assert.equal((await getState()).requests.length, 0);
    await cleanAlert();
    pass('unconfigured cloud generation is blocked before any request');

    const configSelect = page.getByLabel('配置的服务商');
    await configSelect.selectOption('tencent');
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill(fake.tencent);
    await page.getByLabel('音乐模型', { exact: true }).selectOption('minimax-music-v2.6');
    await page.getByRole('button', { name: '保存此服务配置', exact: true }).click();
    await until(settings, result => result.providers.tencent.configured, 'Tencent credentials saved');
    await configSelect.selectOption('volcengine');
    await page.getByLabel('Access Key ID', { exact: true }).fill(fake.accessKeyId);
    await page.getByLabel('Secret Access Key', { exact: true }).fill(fake.secretAccessKey);
    await page.getByLabel('火山计费方式').selectOption('postpaid');
    await page.getByRole('button', { name: '保存此服务配置', exact: true }).click();
    await until(settings, result => result.providers.volcengine.configured, 'Volcengine credentials saved');
    await configSelect.selectOption('aliyun');
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill(fake.aliyun);
    await page.getByLabel('Workspace ID', { exact: true }).fill('llm-cloud-fixture');
    await page.getByLabel('音乐模型', { exact: true }).selectOption('fun-music-v1');
    await page.getByRole('button', { name: '保存此服务配置', exact: true }).click();
    await until(settings, result => result.providers.aliyun.configured, 'Aliyun credentials saved');
    assert.equal((await getState()).requests.length, 0, 'saving credentials must never call a provider');
    await closeModal();
    await page.reload();
    await page.getByLabel('生成引擎').waitFor();
    const saved = (await settings()).providers;
    assert.equal(saved.tencent.model, 'minimax-music-v2.6'); assert.equal(saved.volcengine.billingMode, 'postpaid');
    assert.equal(saved.aliyun.workspaceId, 'llm-cloud-fixture'); assert.equal(saved.aliyun.model, 'fun-music-v1');
    for (const provider of ['tencent', 'volcengine', 'aliyun']) assert.equal(saved[provider].configured, true);
    assert.ok(!JSON.stringify(saved).includes(fake.tencent), 'settings readback must not expose secrets');
    pass('all three provider credentials saved through UI and preserved after reload without being exposed');

    await page.getByLabel('生成引擎').selectOption('tencent');
    await page.getByLabel('生成时长').selectOption('15');
    await desktop.evaluate(() => { globalThis.__museCloudTest.failNextTencent = true; });
    await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /API Key.*无效|API Key.*过期/);
    await ready();
    assert.equal((await records(page)).length, 0);
    assert.equal((await getState()).requests.length, 1, '401 must not be retried automatically');
    await cleanAlert();
    pass('401 shows an actionable error, creates no work, and never retries automatically');

    const outputs = [];
    for (const [provider, mime, extension, target] of [['tencent', 'audio/mpeg', 'mp3', 15], ['volcengine', 'audio/mp4', 'm4a', 30], ['aliyun', 'audio/wav', 'wav', 15]]) {
      await page.getByLabel('生成引擎').selectOption(provider);
      await page.getByLabel('生成时长').selectOption(String(target));
      const countBefore = (await records(page)).length;
      const requestBefore = (await getState()).requests.length;
      // Two immediate clicks exercise the synchronous busy lock, before React repaints.
      await page.getByRole('button', { name: '生成我的 BGM', exact: true }).evaluate(button => { button.click(); button.click(); });
      const all = await until(() => records(page), result => result.length === countBefore + 1, `${provider} saved output`);
      await ready();
      const work = all[0];
      assert.equal(work.provider, provider); assert.equal(work.mimeType, mime); assert.equal(work.config.duration, target);
      assert.ok(work.audioDuration > 2.8 && work.audioDuration < 3.3, `actual duration from ${provider} decode: ${work.audioDuration}`);
      assert.notEqual(work.audioDuration, work.config.duration);
      assert.ok(await page.getByRole('slider', { name: '旋律音量', exact: true }).isDisabled(), 'cloud audio has no separate stems');
      assert.ok(await page.getByRole('button', { name: '旋律独奏', exact: true }).isDisabled());
      assert.match(await page.locator('.transport-time').textContent(), /00:03/);
      const newRequests = (await getState()).requests.slice(requestBefore);
      const submissions = newRequests.filter(request => provider === 'volcengine' ? /Action=GenBGM/.test(request.url) : provider === 'aliyun' ? request.url.includes('/music/generation') : request.url.includes('/minimax-music/generation'));
      assert.equal(submissions.length, 1, 'double click creates exactly one billable POST');

      await page.getByRole('button', { name: '播放', exact: true }).click();
      await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
      await until(() => page.getByRole('slider', { name: '播放进度' }).inputValue(), value => Number(value) > 0.05, 'decoded cloud audio plays');
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.getByRole('button', { name: '导出', exact: true }).click();
      const original = page.getByRole('button', { name: /导出 AI 原始音频/ });
      assert.equal(await original.locator('.format-icon').textContent(), extension.toUpperCase());
      const destination = path.join(profile, `${provider}-original.${extension}`);
      await desktop.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async (_window, options) => { globalThis.__museCloudTest.dialogs.push({ defaultPath: options.defaultPath, filters: options.filters }); return { canceled: false, filePath }; };
      }, destination);
      await original.click();
      const exported = await until(async () => { try { return await fs.readFile(destination); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, Boolean, 'original audio exported');
      const fixture = await fs.readFile(path.join(root, 'tests', 'fixtures', `music-3s.${extension}`));
      assert.deepEqual(exported, fixture, 'original export preserves bytes');
      assert.equal((await getState()).dialogs.at(-1).filters[0].extensions[0], extension);
      await closeModal();
      outputs.push({ provider, mime, actualDuration: work.audioDuration, requestedDuration: target, bytes: work.audioBytes, originalFormat: extension });
      pass(`${provider}: UI → IPC → adapter → decoder → saved work → playback → ${extension.toUpperCase()} original export`);
    }

    const state = await getState();
    assert.deepEqual(state.unknownRequests, []); assert.deepEqual(state.deniedNetwork, []);
    const tencent = state.requests.find(request => request.url.includes('tokenhub'));
    assert.equal(tencent.headers.authorization, `Bearer ${fake.tencent}`);
    assert.equal(tencent.body.model, 'minimax-music-v2.6'); assert.equal(tencent.body.is_instrumental, true);
    assert.equal(tencent.body.output_format, 'hex'); assert.equal(tencent.body.lyrics_optimizer, false);
    const volc = state.requests.find(request => /Action=GenBGM/.test(request.url));
    assert.match(volc.url, /Action=GenBGMForTime/); assert.match(volc.headers.authorization, /^HMAC-SHA256 Credential=AK-fake-only/);
    assert.match(volc.body.Text, /纯音乐/); assert.equal(volc.body.Version, 'v5.0');
    assert.equal(volc.body.Duration, 30); assert.deepEqual(volc.body.Segments, [{ Name: 'inst', Duration: 30 }]);
    assert.equal(state.requests.filter(request => request.url.includes('Action=QuerySong')).length, 2);
    const aliyun = state.requests.find(request => request.url.includes('maas.aliyuncs.com'));
    assert.equal(aliyun.headers.authorization, `Bearer ${fake.aliyun}`); assert.equal(aliyun.body.input.is_instrumental, true);
    assert.equal(aliyun.body.model, 'fun-music-v1');
    const downloads = state.requests.filter(request => request.method === 'GET');
    assert.equal(downloads.length, 2);
    for (const request of downloads) { assert.equal(request.headers.authorization, undefined); assert.equal(request.headers['x-date'], undefined); }
    pass('captured requests match official instrumental contracts; signed polling works; no auth on CDN downloads; zero live network');

    await page.getByRole('button', { name: '设置与生成服务', exact: true }).click();
    await page.getByLabel('配置的服务商').selectOption('tencent');
    await page.getByRole('button', { name: '移除此服务凭据', exact: true }).click();
    const afterDelete = await until(settings, result => !result.providers.tencent.configured, 'one credential removed');
    assert.equal(afterDelete.providers.volcengine.configured, true); assert.equal(afterDelete.providers.aliyun.configured, true);
    await closeModal();
    await page.reload(); await page.getByLabel('生成引擎').waitFor();
    const afterReload = (await settings()).providers;
    assert.equal(afterReload.tencent.configured, false); assert.equal(afterReload.volcengine.configured, true); assert.equal(afterReload.aliyun.configured, true);
    await page.getByRole('button', { name: /^我的作品/ }).click();
    await until(() => page.locator('.project-card').count(), count => count === 3, 'three cloud works after reload');
    assert.deepEqual(await page.locator('.cover-duration').allTextContents(), ['00:03', '00:03', '00:03']);
    const networkCount = (await getState()).requests.length;
    await page.locator('.project-cover').first().click(); await ready();
    assert.equal((await getState()).requests.length, networkCount, 'opening stored cloud audio must not regenerate');
    pass('deleting Tencent credentials preserves other providers; three saved cloud works survive reload and reopen offline');

    assert.deepEqual(errors, [], 'no renderer errors');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifactDir, 'cloud-workflow.png'), fullPage: true, animations: 'disabled', style: '.toast { visibility: hidden !important; }' });
    const sanitizedRequests = state.requests.map(({ url, method, headers, body }) => ({ url, method, authenticated: Boolean(headers.authorization), authType: headers.authorization?.split(' ')[0] ?? null, body }));
    const report = { mode: 'mocked-provider-responses-real-ui-ipc-decoding', liveRequests: 0, passed: checks.length, checks, outputs, requests: sanitizedRequests, rendererErrors: errors };
    await fs.writeFile(path.join(artifactDir, 'cloud-workflow-results.json'), JSON.stringify(report, null, 2));
    console.log(`Cloud workflow passed: ${checks.length} checks, zero live traffic.`);
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifactDir, 'cloud-workflow-failure.png'), fullPage: true }).catch(() => {});
      console.error('UI alerts:', await page.getByRole('alert').allTextContents().catch(() => []));
    }
    console.error('Renderer errors:', errors);
    throw error;
  } finally {
    if (desktop) await desktop.close();
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('muse-cloud-workflow-')) await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
