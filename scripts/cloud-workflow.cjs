'use strict';

// Cloud music services and the language-model producer, end to end through
// the REAL app: interface → preload → IPC → main-process adapters → decoder →
// library → playback → export. Only the network is replaced.
//
//   npm run build && node scripts/cloud-workflow.cjs
//   node scripts/cloud-workflow.cjs --ollama     also talk to a local Ollama, if one is running
//   node scripts/cloud-workflow.cjs --ollama-cold   the same, after asking Ollama to unload the model,
//                                                so the first message meets a model that still has to load
//
// The app is started with MUSE_NETWORK=node and a module preloaded into the
// main process that replaces globalThis.fetch (see tests/helpers/
// electron-harness.cjs): Tencent answers hex MP3, Volcengine a signed submit,
// polls and an M4A on its CDN, Aliyun a URL to a WAV, the models a plan. The
// three audio fixtures are 3 s long while 15 / 30 s are requested, so "the
// real length is shown" is checked for real. Any request to an address the
// mock does not know fails and is counted; Chromium's own network is denied
// and counted as well. The run fails unless both counts are zero: no real
// service is contacted, no real credential is used, nothing can be billed.
// Writes test-results/cloud-workflow-results.json.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, DEFAULT_PLAN, until, launchApp, removeProfile, wavInfo, createRun, describeFailure } = require('../tests/helpers/electron-harness.cjs');

const PREFIX = 'muse-cloud-workflow-';
const COLD_OLLAMA = process.argv.includes('--ollama-cold');
const WITH_OLLAMA = COLD_OLLAMA || process.argv.includes('--ollama');
const FAKE = {
  tencent: 'tokenhub-fake-key-never-live-001',
  accessKeyId: 'AKfakeonly123456789',
  secretAccessKey: 'SKfakeonly123456789abcdef',
  aliyun: 'sk-aliyun-fake-only-123456789',
  anthropic: 'sk-ant-fake-only-not-a-real-key-000',
  deepseek: 'sk-fake-deepseek-000000000',
};
const PROVIDERS = [
  { id: 'tencent', mime: 'audio/mpeg', ext: 'mp3', seconds: 15, isPost: (url) => url.includes('/minimax-music/generation') },
  { id: 'volcengine', mime: 'audio/mp4', ext: 'm4a', seconds: 30, isPost: (url) => /Action=GenBGM/.test(url) },
  { id: 'aliyun', mime: 'audio/wav', ext: 'wav', seconds: 15, isPost: (url) => url.includes('/music/generation') },
];
const fixture = (ext) => fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', `music-3s.${ext}`));

async function mockedRun(run, shared) {
  const app = await launchApp({ prefix: PREFIX, mock: true });
  shared.app = app;
  shared.profile = app.profile;
  const { page, $ } = app;
  const requests = async () => (await app.state()).requests;
  const pressed = (id) => $(id).getAttribute('aria-pressed');
  const describe = async (text, seconds) => {
    await $('composer-input').fill(text);
    await $('composer-duration').selectOption(String(seconds));
  };

  await run.step('an engine without credentials is refused before any request, with the way to fix it', async () => {
    assert.equal(path.resolve((await app.settings()).dataPath), path.join(app.profile, 'Muse-Data'));
    await $('composer-engine').selectOption('tencent');
    await $('settings-modal').waitFor();
    assert.match(await app.toast(/请先在设置中保存/), /腾讯云 TokenHub 的服务凭据/);
    assert.equal(await $('provider-tencent-tab').getAttribute('aria-pressed'), 'true');
    assert.equal(await $('composer-engine').inputValue(), 'local');
    assert.deepEqual(await requests(), []);
  });

  await run.step('credentials of the three services are saved through the interface, encrypted, and never read back', async () => {
    await $('provider-tencent-apiKey').fill(FAKE.tencent);
    await $('provider-tencent-model').selectOption('minimax-music-v2.6');
    await $('provider-tencent-save').click();
    await until(app.settings, (settings) => settings.providers.tencent.configured, 'Tencent saved');
    await $('provider-volcengine-tab').click();
    await $('provider-volcengine-accessKeyId').fill(FAKE.accessKeyId);
    await $('provider-volcengine-secretAccessKey').fill(FAKE.secretAccessKey);
    await $('provider-volcengine-billingMode').selectOption('postpaid');
    await $('provider-volcengine-save').click();
    await until(app.settings, (settings) => settings.providers.volcengine.configured, 'Volcengine saved');
    await $('provider-aliyun-tab').click();
    await $('provider-aliyun-apiKey').fill(FAKE.aliyun);
    await $('provider-aliyun-workspaceId').fill('llm-cloud-fixture');
    await $('provider-aliyun-model').selectOption('fun-music-v1');
    await $('provider-aliyun-save').click();
    await until(app.settings, (settings) => settings.providers.aliyun.configured, 'Aliyun saved');
    assert.deepEqual(await requests(), [], 'saving never calls a service');
    await app.closeModal();
    await app.reload();
    const saved = (await app.settings()).providers;
    assert.deepEqual(saved.tencent, { configured: true, model: 'minimax-music-v2.6' });
    assert.deepEqual(saved.volcengine, { configured: true, billingMode: 'postpaid' });
    assert.deepEqual(saved.aliyun, { configured: true, model: 'fun-music-v1', workspaceId: 'llm-cloud-fixture' });
    const stored = fs.readFileSync(path.join(app.profile, 'Muse-Data', 'music-credentials.json'), 'utf8');
    for (const secret of [FAKE.tencent, FAKE.accessKeyId, FAKE.secretAccessKey, FAKE.aliyun]) {
      assert.ok(!stored.includes(secret), 'no secret in clear text on disk');
      assert.ok(!JSON.stringify(saved).includes(secret), 'no secret in the settings answer');
    }
    const engines = await $('composer-engine').locator('option').allInnerTexts();
    assert.equal(engines.filter((text) => text.includes('需先在设置中配置')).length, 1, 'only ElevenLabs is left unconfigured');
  });

  await run.step('HTTP 401: the message is Chinese and actionable, nothing is created, nothing is retried', async () => {
    await $('composer-engine').selectOption('tencent');
    await describe('雨夜咖啡馆的慵懒钢琴', 15);
    await app.setState({ tencent: { fail: 401 } });
    await $('send-button').click();
    const text = await app.toast(/生成失败/);
    await app.idle();
    assert.match(text, /^生成失败：API Key 无效或已过期/);
    assert.doesNotMatch(text, /Error invoking|remote method|Error:/);
    assert.deepEqual(await app.records(), []);
    assert.equal((await requests()).length, 1, 'one request, no automatic retry of a paid generation');
    assert.equal(await $('composer-input').inputValue(), '雨夜咖啡馆的慵懒钢琴', 'the description is handed back');
    await app.clearToasts();
    return { text };
  });

  await run.step('cancel while the service is working: the request is aborted, the billing note is honest', async () => {
    await app.setState({ tencent: { hang: true } });
    const before = (await requests()).length;
    await $('send-button').click();
    await page.waitForSelector('[data-testid="job-status"][data-stage="cloud"]');
    await until(requests, (list) => list.length === before + 1, 'the request reached the service');
    await $('nav-library').click();
    assert.equal(await $('job-status').count(), 1, 'the job can be cancelled from any page');
    await $('job-cancel').click();
    await app.idle(15000);
    const text = await app.toast(/已取消等待/);
    assert.match(text, /云端生成可能仍会计费/);
    await app.setState({ tencent: { hang: false } });
    assert.deepEqual((await app.toasts()).filter((item) => item.includes('生成失败')), [], 'a cancel is not reported as a failure');
    assert.deepEqual(await app.records(), []);
    assert.equal((await requests()).length, before + 1);
    // the main process is free again: the next generation below must go through
    await $('nav-studio').click();
    await app.clearToasts();
  });

  const outputs = [];
  for (const provider of PROVIDERS) {
    await run.step(`${provider.id}: one paid request → stored before decoding → real length → playback → original ${provider.ext} untouched`, async () => {
      await app.newPiece();
      await $('composer-engine').selectOption(provider.id);
      await describe('雨夜咖啡馆的慵懒钢琴，纯音乐', provider.seconds);
      const countBefore = (await app.records()).length;
      const before = (await requests()).length;
      // The stages the job goes through, in order.
      await page.evaluate(() => {
        window.__stages = [];
        window.__stageObserver = new MutationObserver(() => {
          const stage = document.querySelector('[data-testid="job-status"]')?.getAttribute('data-stage');
          if (stage && window.__stages.at(-1) !== stage) window.__stages.push(stage);
        });
        window.__stageObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-stage'] });
      });
      // Two clicks before React can repaint: the synchronous job lock must hold.
      await $('send-button').evaluate((button) => {
        button.click();
        button.click();
      });
      await app.loaded(1, 'mix', 60000);
      const stages = await page.evaluate(() => {
        window.__stageObserver.disconnect();
        return window.__stages;
      });
      const all = await app.records();
      assert.equal(all.length, countBefore + 1);
      const work = all[0];
      const bytes = fixture(provider.ext);
      assert.equal(work.provider, provider.id);
      assert.equal(work.blobType, provider.mime);
      assert.equal(work.blobBytes, bytes.length);
      assert.equal(work.config.duration, provider.seconds, 'the request is kept as asked');
      assert.ok(work.audioDuration > 2.8 && work.audioDuration < 3.3, `decoded length ${work.audioDuration}`);
      assert.ok(work.cloud.prompt.length > 10);
      assert.ok(stages.includes('saving') && stages.indexOf('decoding') > stages.indexOf('saving'), `saved before decoding: ${stages}`);
      assert.match(await $('time-display').innerText(), /\/ 0:03$/, 'the real 3 s are shown');
      assert.equal(await $('mixer-note').count(), 1, 'a cloud mix has no stems');
      assert.equal(await page.locator('[data-testid$="-fader"]').count(), 0);
      const sent = (await requests()).slice(before);
      assert.equal(sent.filter((request) => request.method === 'POST' && provider.isPost(request.url)).length, 1, 'a double click is one billable request');
      await until(() => pressed('play-button'), (value) => value === 'true', 'decoded audio plays');
      await until(() => $('waveform').getAttribute('aria-valuenow'), (value) => Number(value) >= 1, 'the playhead moves');
      if ((await pressed('play-button')) === 'true') await $('play-button').click();
      await $('export-button').click();
      await $('export-modal').waitFor();
      assert.deepEqual(
        await page.locator('[data-testid^="export-option-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))),
        ['export-option-mix', 'export-option-original'],
      );
      assert.match(await $('export-option-original').innerText(), new RegExp(provider.ext.toUpperCase()));
      const original = await app.exportVia('original', path.join(app.profile, `${provider.id}-original.${provider.ext}`));
      assert.ok(original.equals(bytes), 'the original file is byte-identical');
      const dialog = (await app.state()).dialogs.at(-1);
      assert.deepEqual(dialog.filters[0].extensions, [provider.ext]);
      assert.equal(path.extname(dialog.defaultPath), `.${provider.ext}`);
      const wav = wavInfo(await app.exportVia('mix', path.join(app.profile, `${provider.id}.wav`)));
      assert.ok(Math.abs(wav.seconds - work.audioDuration) < 0.05, `WAV of the decoded mix: ${wav.seconds} s`);
      await app.closeModal();
      await app.clearToasts();
      outputs.push({ provider: provider.id, mime: provider.mime, requested: provider.seconds, actual: work.audioDuration, bytes: work.blobBytes, stages });
      return outputs.at(-1);
    });
  }

  await run.step('what was sent matches the instrumental contracts; downloads carry no credentials', async () => {
    const list = await requests();
    const tencent = list.filter((request) => request.url.includes('tokenhub')).at(-1);
    assert.equal(tencent.headers.authorization, `Bearer ${FAKE.tencent}`);
    assert.equal(tencent.body.model, 'minimax-music-v2.6');
    assert.equal(tencent.body.is_instrumental, true);
    assert.equal(tencent.body.output_format, 'hex');
    assert.equal(tencent.body.lyrics_optimizer, false);
    const volc = list.find((request) => /Action=GenBGM/.test(request.url));
    assert.match(volc.url, /Action=GenBGMForTime/);
    assert.match(volc.headers.authorization, /^HMAC-SHA256 Credential=AKfakeonly/);
    assert.match(volc.body.Text, /纯音乐/);
    assert.equal(volc.body.Version, 'v5.0');
    assert.equal(volc.body.Duration, 30);
    assert.deepEqual(volc.body.Segments, [{ Name: 'inst', Duration: 30 }]);
    assert.equal(list.filter((request) => request.url.includes('Action=QuerySong')).length, 2, 'two signed polls');
    const aliyun = list.find((request) => request.url.includes('maas.aliyuncs.com'));
    assert.equal(aliyun.headers.authorization, `Bearer ${FAKE.aliyun}`);
    assert.equal(aliyun.body.model, 'fun-music-v1');
    assert.equal(aliyun.body.input.is_instrumental, true);
    const downloads = list.filter((request) => request.method === 'GET');
    assert.equal(downloads.length, 2);
    for (const request of downloads) {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers['x-date'], undefined);
    }
  });

  await run.step('a length the service does not offer is refused before anything is sent', async () => {
    await app.newPiece();
    await $('composer-engine').selectOption('volcengine');
    await describe('轻快的口哨', 15);
    const before = (await requests()).length;
    await $('send-button').click();
    const text = await app.toast(/30–120 秒/);
    await app.idle();
    assert.match(text, /火山引擎 AI 音乐支持 30–120 秒，这次的时长是 15 秒/);
    assert.equal((await requests()).length, before);
    await app.clearToasts();
  });

  await run.step('audio that cannot be decoded stays in the library with its original file and a clear message', async () => {
    await $('composer-engine').selectOption('tencent');
    await describe('一段测试用的钢琴', 15);
    await app.setState({ tencent: { garbage: true } });
    const countBefore = (await app.records()).length;
    await $('send-button').click();
    await page.waitForSelector('[data-testid="player-card"][data-audio="none"]', { timeout: 30000 });
    await app.idle();
    await app.setState({ tencent: { garbage: false } });
    const all = await app.records();
    assert.equal(all.length, countBefore + 1, 'the paid bytes were stored');
    assert.match(await $('audio-error').innerText(), /无法解码试听.*导出.*原始音频/);
    await $('export-button').click();
    await $('export-modal').waitFor();
    assert.deepEqual(
      await page.locator('[data-testid^="export-option-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid'))),
      ['export-option-original'],
    );
    const original = await app.exportVia('original', path.join(app.profile, 'undecodable.mp3'));
    assert.equal(original.length, all[0].blobBytes);
    await app.closeModal();
    await app.clearToasts();
    shared.undecodableId = all[0].id;
  });

  await run.step('a refinement of a cloud work is a new paid version on the same service, with the change in the prompt', async () => {
    const source = (await app.records()).find((record) => record.provider === 'tencent' && record.audioDuration);
    await $('nav-library').click();
    await page.locator(`[data-testid="library-card"][data-project="${source.id}"] [data-testid="library-open"]`).click();
    await page.waitForSelector(`[data-testid="player-card"][data-project="${source.id}"][data-audio="mix"]`);
    await app.idle();
    assert.equal(await $('composer-engine').inputValue(), 'tencent');
    const before = (await requests()).length;
    await $('composer-input').fill('慢一点，换成古筝');
    await $('composer-input').press('Enter');
    await app.loaded(2, 'mix', 60000);
    const next = (await app.records()).find((record) => record.parentId === source.id);
    assert.equal(next.revision, 2);
    assert.equal(next.provider, 'tencent');
    assert.equal(next.config.instrument, 'guzheng');
    assert.ok(next.config.bpm < source.config.bpm);
    const sent = (await requests()).slice(before);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.prompt, /古筝/);
    assert.match(sent[0].body.prompt, /纯音乐/);
    assert.ok(next.cloud.prompt.includes('古筝'));
    if ((await pressed('play-button')) === 'true') await $('play-button').click();
    await app.clearToasts();
  });

  await run.step('removing one credential leaves the others; stored cloud works reopen after a reload without any request', async () => {
    await app.openSettings('music');
    await $('provider-tencent-tab').click();
    await $('provider-tencent-remove').click();
    const after = (await until(app.settings, (settings) => !settings.providers.tencent.configured, 'Tencent removed')).providers;
    assert.equal(after.volcengine.configured && after.aliyun.configured, true);
    await app.closeModal();
    assert.equal(await $('composer-engine').inputValue(), 'local', 'the selected engine falls back to local');
    await app.reload();
    await page.waitForSelector('[data-testid="player-card"]', { timeout: 30000 });
    await app.idle();
    const saved = (await app.settings()).providers;
    assert.deepEqual([saved.tencent.configured, saved.volcengine.configured, saved.aliyun.configured], [false, true, true]);
    await $('nav-library').click();
    const works = await app.records();
    assert.equal(await page.locator('[data-testid="library-card"]').count(), works.length);
    assert.equal(works.length, 5);
    const count = (await requests()).length;
    const target = works.find((record) => record.provider === 'aliyun');
    const card = page.locator(`[data-testid="library-card"][data-project="${target.id}"]`);
    // paid audio is not deleted by one click
    await card.locator('[data-testid="library-delete"]').click();
    await card.locator('[data-testid="library-delete-confirm"]').waitFor();
    assert.match(await card.locator('.work-confirm p').innerText(), /付费生成的音频/);
    await card.getByRole('button', { name: '取消' }).click();
    assert.equal((await app.records()).length, 5);
    await card.locator('[data-testid="library-play"]').click();
    await page.waitForSelector(`[data-testid="player-card"][data-project="${target.id}"][data-audio="mix"]`);
    await app.idle();
    await until(() => pressed('play-button'), (value) => value === 'true', 'quick play from the library');
    await $('play-button').click();
    assert.equal((await requests()).length, count, 'opening stored audio never calls the service');
  });

  /* ---------- the producer's language model ---------- */

  const llmRequests = async () => (await requests()).filter((request) => /anthropic\.com|chat\/completions/.test(request.url));

  await run.step('Claude (mocked) plans a new piece: the plan is rendered locally and the thread names the model', async () => {
    await app.openSettings('llm');
    await $('llm-key').fill(FAKE.anthropic);
    await $('llm-save').click();
    await until(app.settings, (settings) => settings.llm.configured, 'Claude saved');
    await app.closeModal();
    await app.newPiece();
    assert.equal(await $('composer-engine').inputValue(), 'local');
    assert.equal(await $('composer-brain').inputValue(), 'llm', 'saving a model makes it the producer');
    const countBefore = (await app.records()).length;
    await $('composer-input').fill('雨天咖啡馆里的慵懒爵士，不要鼓');
    await $('send-button').click();
    await page.waitForSelector('[data-testid="job-status"][data-stage="planning"]');
    assert.match(await $('job-phase').innerText(), /大模型/);
    await app.loaded(1, 'stems', 60000);
    const all = await app.records();
    assert.equal(all.length, countBefore + 1);
    const work = all[0];
    assert.equal(work.title, DEFAULT_PLAN.title);
    assert.deepEqual(
      [work.config.mood, work.config.instrument, work.config.key, work.config.bpm, work.config.arrangement.drums],
      [DEFAULT_PLAN.style, DEFAULT_PLAN.instrument, DEFAULT_PLAN.key, DEFAULT_PLAN.bpm, 'none'],
    );
    assert.equal(work.chat.at(-1).brain, 'llm');
    assert.equal(work.chat.at(-1).text, DEFAULT_PLAN.reply);
    assert.equal(await page.locator('[data-testid="turn-brain"]').last().innerText(), 'claude-opus-5-5');
    const call = (await llmRequests()).at(-1);
    assert.match(call.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    assert.equal(call.headers['x-api-key'], FAKE.anthropic);
    assert.equal(call.body.model, 'claude-opus-5-5');
    assert.match(JSON.stringify(call.body.messages), /雨天咖啡馆/);
    if ((await pressed('play-button')) === 'true') await $('play-button').click();
    shared.llmFirst = work;
  });

  await run.step('Claude refines: it is shown the current work; the new version keeps the seed and the title', async () => {
    const first = shared.llmFirst;
    await app.setState({ llm: { plans: [{ ...DEFAULT_PLAN, bpm: 72, instrument: 'piano', reverb: 0.6, newMelody: false, title: '另一个名字', reply: '放慢到 72，换成钢琴，空间更大。', reasoning: ['速度 84 → 72', '主奏换成钢琴', '混响加大'] }] } });
    const before = (await llmRequests()).length;
    await $('composer-input').fill('再慢一点，换成钢琴主奏，混响大一些');
    await $('composer-input').press('Enter');
    await app.loaded(2, 'stems', 60000);
    const next = (await app.records()).find((record) => record.parentId === first.id);
    assert.deepEqual([next.config.bpm, next.config.instrument, next.config.reverb], [72, 'piano', 0.6]);
    assert.equal(next.config.seed, first.config.seed);
    assert.equal(next.title, first.title, 'a refinement keeps the title');
    assert.equal(next.chat.length, 4);
    const calls = await llmRequests();
    assert.equal(calls.length, before + 1);
    const sent = JSON.stringify(calls.at(-1).body.messages);
    assert.match(sent, /再慢一点/);
    assert.match(sent, /"bpm":\s*84|84 BPM|bpm[^,]{0,12}84/, 'the current tempo is in what the model sees');
    if ((await pressed('play-button')) === 'true') await $('play-button').click();
  });

  await run.step('the model fails (HTTP 500): the offline rules answer and the thread says so', async () => {
    await app.clearToasts();
    await app.setState({ llm: { failAlways: 500 } });
    await $('composer-input').fill('更有活力一点');
    await $('composer-input').press('Enter');
    await app.loaded(3, 'stems', 90000);
    await app.setState({ llm: { failAlways: 0 } });
    const next = (await app.records()).find((record) => record.revision === 3 && record.title === shared.llmFirst.title);
    assert.ok(next.config.energy > DEFAULT_PLAN.energy, 'the rules understood the request');
    assert.equal(next.chat.at(-1).brain, 'rules');
    const notice = await page.locator('[data-testid="turn-fallback"]').last().innerText();
    // one clause of what happened, then what was done: no advice, no brackets, no IPC wrapper
    assert.equal(notice, 'Claude 服务暂时不可用，已改用离线规则');
    assert.equal(await app.toast(/已改用离线规则/), notice);
    assert.equal(await page.locator('[data-testid="turn-brain"]').last().innerText(), '离线规则');
    if ((await pressed('play-button')) === 'true') await $('play-button').click();
    await app.clearToasts();
    return { notice };
  });

  await run.step('cancel while the model is thinking: nothing is generated, nothing falls back, the main process lets go', async () => {
    await app.setState({ llm: { hang: true } });
    const countBefore = (await app.records()).length;
    const calls = (await app.state()).llm.calls;
    await $('composer-input').fill('换成长笛');
    await $('composer-input').press('Enter');
    await page.waitForSelector('[data-testid="job-status"][data-stage="planning"]');
    assert.equal(await $('job-phase').innerText(), '制作人（大模型）正在理解你的想法，本机模型可能需要一两分钟');
    await until(app.state, (state) => state.llm.calls === calls + 1, 'the request reached the model');
    await $('job-cancel').click();
    await app.idle(15000);
    await app.toast(/已取消本次编排/);
    await app.setState({ llm: { hang: false } });
    assert.deepEqual((await app.toasts()).filter((text) => /已改用离线规则|生成失败/.test(text)), []);
    assert.equal((await app.records()).length, countBefore);
    assert.equal(await $('composer-input').inputValue(), '换成长笛');
    assert.equal(await $('player-card').getAttribute('data-revision'), '3');
    await $('composer-input').fill('');
    await app.clearToasts();
  });

  await run.step('an OpenAI-compatible model (mocked DeepSeek): Bearer key, /chat/completions; HTTP 401 falls back with the reason', async () => {
    await app.openSettings('llm');
    await $('llm-preset').selectOption('deepseek');
    assert.equal(await $('llm-base-url').inputValue(), 'https://api.deepseek.com');
    await $('llm-key').fill(FAKE.deepseek);
    await $('llm-model').fill('deepseek-chat');
    await $('llm-save').click();
    await until(app.settings, (settings) => settings.llm.preset === 'deepseek', 'DeepSeek saved');
    assert.deepEqual((await app.settings()).llm, { configured: true, kind: 'openai', preset: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' });
    await app.closeModal();
    await app.newPiece();
    await app.setState({ llm: { plans: [{ ...DEFAULT_PLAN, style: 'guofeng', instrument: 'guzheng', key: 'D major', bpm: 78, title: '竹影', reply: '古筝与竹笛，留白多一些。', arrangement: { ...DEFAULT_PLAN.arrangement, progression: [], drums: 'auto', bass: 'auto', swing: -1 } }] } });
    await describe('古风庭院，古筝', 15);
    await $('send-button').click();
    await app.loaded(1, 'stems', 60000);
    const work = (await app.records())[0];
    assert.deepEqual([work.title, work.config.mood, work.config.instrument, work.config.bpm], ['竹影', 'guofeng', 'guzheng', 78]);
    const call = (await llmRequests()).at(-1);
    assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(call.headers.authorization, `Bearer ${FAKE.deepseek}`);
    assert.equal(call.body.model, 'deepseek-chat');
    assert.equal(await page.locator('[data-testid="turn-brain"]').last().innerText(), 'deepseek-chat');
    if ((await pressed('play-button')) === 'true') await $('play-button').click();
    await app.setState({ llm: { fail: 401 } });
    await $('composer-input').fill('慢一点');
    await $('composer-input').press('Enter');
    await app.loaded(2, 'stems', 60000);
    const notice = await page.locator('[data-testid="turn-fallback"]').last().innerText();
    assert.equal(notice, 'API Key 无效或已过期，已改用离线规则');
    if ((await pressed('play-button')) === 'true') await $('play-button').click();
    await app.clearToasts();
  });

  await run.step('model + cloud engine: the service receives the model\'s own prompt, made instrumental', async () => {
    await app.newPiece();
    await $('composer-engine').selectOption('aliyun');
    assert.equal(await $('composer-brain').inputValue(), 'llm');
    await app.setState({ llm: { plans: [{ ...DEFAULT_PLAN, cloudPrompt: 'A lazy jazz tune for a rainy cafe, vibraphone lead, walking bass, 84 BPM' }] } });
    await describe('雨天咖啡馆爵士', 15);
    await $('send-button').click();
    await app.loaded(1, 'mix', 60000);
    const work = (await app.records())[0];
    const sent = (await requests()).filter((request) => request.url.includes('maas.aliyuncs.com')).at(-1);
    assert.match(sent.body.input.prompt, /rainy cafe/);
    assert.match(work.cloud.prompt, /rainy cafe.*(纯音乐|无人声)/);
    if ((await pressed('play-button')) === 'true') await $('play-button').click();
  });

  await run.step('zero real external requests; no renderer errors', async () => {
    const state = await app.state();
    assert.deepEqual(state.unknown, [], 'requests the mock did not know');
    assert.deepEqual(state.denied, [], 'requests through Chromium');
    assert.deepEqual(state.loopback, [], 'requests to this computer');
    assert.deepEqual(state.warmUps, [], 'saving a hosted model never calls it');
    assert.deepEqual(app.errors, []);
    const hosts = [...new Set(state.requests.map((request) => new URL(request.url).host))].sort();
    assert.deepEqual(hosts, ['api.anthropic.com', 'api.deepseek.com', 'llm-cloud-fixture.cn-beijing.maas.aliyuncs.com', 'muse-fixture.oss-cn-beijing.aliyuncs.com', 'open.volcengineapi.com', 'tokenhub.tencentmaas.com', 'v3-default.douyinvod.com']);
    shared.liveRequests = state.unknown.length + state.denied.length + state.loopback.length;
    shared.requests = state.requests.map(({ url, method, headers, body }) => ({
      url,
      method,
      auth: headers.authorization ? headers.authorization.split(' ')[0] : headers['x-api-key'] ? 'x-api-key' : null,
      model: body?.model ?? body?.Version ?? null,
    }));
    return { mocked: state.requests.length, hosts };
  });

  await page.screenshot({ path: path.join(ROOT, 'test-results', 'cloud-workflow.png') }).catch(() => {});
  shared.outputs = outputs;
}

/** Optional: the producer through a real model on this computer (no mocks, Chromium network stack). */
async function ollamaRun(run, shared) {
  let model = null;
  try {
    const tags = await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })).json();
    model = tags?.models?.[0]?.name ?? null;
  } catch {
    /* not running */
  }
  if (!model) {
    console.log('skip Ollama: no model is being served on http://127.0.0.1:11434');
    shared.ollama = { skipped: true };
    return;
  }
  const loaded = async () => {
    const ps = await (await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(3000) })).json();
    return (ps?.models ?? []).some((entry) => entry.name === model);
  };
  const facts = { model };
  if (COLD_OLLAMA) {
    // keep_alive 0 with no prompt: Ollama drops the model from memory (it loads again on the next request)
    await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(30000) }).then((response) => response.text());
    await until(loaded, (value) => value === false, 'the model is unloaded', 30000, 500);
  }
  facts.coldStart = !(await loaded());
  const app = await launchApp({ prefix: PREFIX, allowLoopback: true });
  shared.app = app;
  shared.profile = app.profile;
  const { page, $ } = app;
  /** Send and wait. A model on this computer has 240 s to answer; after that the rules do. */
  const converse = async (text, revision) => {
    const started = Date.now();
    await $('composer-input').fill(text);
    await $('send-button').click();
    await page.waitForSelector(`[data-testid="player-card"][data-revision="${revision}"][data-audio="stems"]`, { timeout: 300000 });
    await app.idle(60000);
    const work = (await app.records()).find((record) => record.revision === revision);
    return { work, turn: work.chat.at(-1), seconds: +((Date.now() - started) / 1000).toFixed(1) };
  };

  await run.step(`Ollama (${model}): configured through the settings form`, async () => {
    await app.openSettings('llm');
    await $('llm-preset').selectOption('ollama');
    await $('llm-model').fill(model);
    await $('llm-save').click();
    await until(app.settings, (settings) => settings.llm.kind === 'ollama', 'saved');
    await app.closeModal();
    assert.equal(await $('composer-brain').inputValue(), 'llm');
    // saving started the warm-up: the model is being loaded before the first message is written
    const warm = await until(async () => (await app.state()).loopback, (list) => list.length >= 1, 'the warm-up request');
    assert.deepEqual(warm, ['http://127.0.0.1:11434/v1/chat/completions']);
  });

  let first;
  await run.step('Ollama: a real "new" conversation — the first message after a start is answered by the model, not by the rules', async () => {
    const result = await converse('雨天咖啡馆里的慵懒爵士，30 秒，不要鼓', 1);
    facts.coldFallback = result.turn.brain !== 'llm';
    if (facts.coldFallback) facts.coldNotice = await page.locator('[data-testid="turn-fallback"]').last().innerText().catch(() => '');
    assert.equal(result.turn.brain, 'llm', `the model answered the first message (${result.seconds} s; ${facts.coldNotice ?? ''})`);
    first = result.work;
    assert.ok(/[一-龥]/.test(result.turn.text));
    assert.ok(first.config.duration >= 15 && first.config.duration <= 120);
    facts.new = { seconds: result.seconds, title: first.title, mood: first.config.mood, bpm: first.config.bpm, reply: result.turn.text };
    return facts.new;
  });

  await run.step('Ollama: a real "refine" conversation', async () => {
    const result = await converse('再慢一点，换成钢琴主奏', 2);
    assert.equal(result.turn.brain, 'llm', 'the model answered');
    assert.equal(result.work.parentId, first.id);
    assert.ok(result.work.config.bpm <= first.config.bpm);
    assert.equal(result.work.config.instrument, 'piano');
    facts.refine = { seconds: result.seconds, bpm: [first.config.bpm, result.work.config.bpm], reply: result.turn.text };
    return facts.refine;
  });

  await run.step('Ollama: only this computer was contacted', async () => {
    const state = await app.state();
    assert.deepEqual(state.denied, []);
    assert.ok(state.loopback.length >= 2 && state.loopback.every((url) => url.startsWith('http://127.0.0.1:11434/')), JSON.stringify(state.loopback));
    assert.deepEqual(app.errors, []);
  });
  shared.ollama = facts;
}

async function main() {
  const run = createRun('Cloud workflow', 'cloud-workflow-results.json');
  const shared = {};
  let failure = {};
  const profiles = [];
  try {
    await mockedRun(run, shared);
    profiles.push(shared.profile);
    await shared.app.close({ keepProfile: true });
    shared.app = null;
    if (WITH_OLLAMA) {
      await ollamaRun(run, shared);
      if (shared.profile && !profiles.includes(shared.profile)) profiles.push(shared.profile);
    }
  } catch (error) {
    failure = await describeFailure(shared.app, 'cloud-workflow');
    if (!error?.reported) console.error(error);
    failure.error = String(error?.cause?.message || error?.message || error);
  } finally {
    if (shared.app) await shared.app.close({ keepProfile: true });
    if (shared.profile && !profiles.includes(shared.profile)) profiles.push(shared.profile);
    for (const profile of profiles) removeProfile(profile, PREFIX);
  }
  process.exitCode = run.finish({
    mode: 'mocked provider and model responses; real interface, IPC, adapters, decoding and storage',
    // counted in the last mocked step; null when the run did not get that far
    liveRequests: shared.liveRequests ?? null,
    outputs: shared.outputs ?? [],
    requests: shared.requests ?? [],
    ...(shared.ollama ? { ollama: shared.ollama } : {}),
    ...(failure.error ? { error: failure.error, failure } : {}),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
