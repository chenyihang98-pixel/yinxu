'use strict';

// Exercise complete local workflows in a disposable real Electron profile.
// Run npm run build first. No real credentials or paid requests are used.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label, timeout = 40000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await sleep(60);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(value)}`);
}

async function records(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('muse-bgm', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const query = tx.objectStore('projects').getAll();
      query.onsuccess = () => resolve(query.result.map(({ audioBlob, ...metadata }) => ({
        ...metadata, audioBytes: audioBlob?.size ?? 0, audioType: audioBlob?.type ?? '',
      })));
      query.onerror = () => reject(query.error);
      tx.oncomplete = () => db.close();
    };
  }));
}

async function setRange(page, label, value) {
  const range = page.getByRole('slider', { name: label, exact: true });
  await range.evaluate((input, next) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await until(() => range.inputValue(), actual => Math.abs(Number(actual) - value) < 0.01, label);
}

function wavFixture(seconds = 3) {
  const rate = 16000, frames = rate * seconds;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 3000), 44 + i * 2);
  return bytes;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  await fs.access(path.join(root, 'dist', 'index.html'));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-workflow-regression-'));
  const artifacts = path.join(root, 'test-results');
  await fs.mkdir(artifacts, { recursive: true });
  const env = { ...process.env, MUSE_PORTABLE_DATA: '1', PORTABLE_EXECUTABLE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MUSE_DEV_URL;
  const checks = [], failures = [], rendererErrors = [];
  const filter = process.env.MUSE_REGRESSION_FILTER ? new RegExp(process.env.MUSE_REGRESSION_FILTER, 'i') : null;
  let desktop, page, serial = 0;
  try {
    desktop = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => rendererErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') rendererErrors.push(message.text()); });
    await page.waitForFunction(() => Boolean(window.museDesktop) && Boolean(document.querySelector('textarea[aria-label="音乐描述"]')));
    const settings = await page.evaluate(() => window.museDesktop.getSettings());
    assert.equal(path.resolve(settings.dataPath), path.join(profile, 'Muse-Data'));
    const ready = async () => {
      await until(() => page.locator('.generation-progress').count(), count => count === 0, 'generation idle', 120000);
      await page.getByRole('button', { name: '生成我的 BGM', exact: true }).waitFor();
      await until(() => page.getByRole('button', { name: '生成我的 BGM', exact: true }).isEnabled(), Boolean, 'generate enabled');
    };
    const closeModal = async () => {
      const close = page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true });
      if (await close.count()) await close.click();
    };
    const dismissError = async () => {
      const close = page.getByRole('button', { name: '关闭错误提示', exact: true });
      if (await close.count()) await close.click();
    };
    const studio = async () => {
      await closeModal(); await dismissError();
      await page.getByRole('button', { name: '创作工作台', exact: true }).click();
      await ready();
    };
    const currentId = async () => {
      const title = await page.getByRole('textbox', { name: '作品名称', exact: true }).inputValue();
      return (await records(page)).find(item => item.title === title)?.id;
    };
    const generate = async (prompt = '青春欢快的钢琴背景音乐', duration = 15) => {
      await studio();
      await page.getByLabel('生成引擎', { exact: true }).selectOption('local');
      const before = await records(page);
      const known = new Set(before.map(item => item.id));
      await page.getByRole('textbox', { name: '音乐描述', exact: true }).fill(prompt);
      await page.getByLabel('生成时长', { exact: true }).selectOption(String(duration));
      await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
      await until(() => records(page), values => values.length === before.length + 1, 'new project committed', 120000);
      await ready();
      const next = (await records(page)).find(item => !known.has(item.id));
      const title = `Regression ${++serial}`;
      await page.getByRole('textbox', { name: '作品名称', exact: true }).fill(title);
      await page.getByRole('textbox', { name: '作品名称', exact: true }).press('Enter');
      return until(() => records(page), values => values.find(item => item.id === next.id)?.title === title, 'renamed project committed').then(values => values.find(item => item.id === next.id));
    };
    const refine = async text => {
      const before = await records(page), known = new Set(before.map(item => item.id));
      await page.getByRole('textbox', { name: '微调描述', exact: true }).fill(text);
      await page.getByRole('button', { name: '应用描述微调', exact: true }).click();
      await until(() => records(page), values => values.length === before.length + 1, 'refinement committed', 60000);
      await ready();
      return (await records(page)).find(item => !known.has(item.id));
    };
    const readFile = file => until(async () => { try { return await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, value => Boolean(value?.length), 'export written');
    const setSavePath = async (file, canceled = false) => desktop.evaluate(({ dialog }, input) => {
      globalThis.__regressionSaveOptions = null;
      dialog.showSaveDialog = async (...args) => {
        globalThis.__regressionSaveOptions = args.at(-1);
        return { canceled: input.canceled, filePath: input.file };
      };
    }, { file, canceled });
    const exportedJson = async () => {
      const file = path.join(profile, `recipe-${++serial}.json`);
      await page.getByRole('button', { name: '导出', exact: true }).click();
      await setSavePath(file);
      await page.getByRole('button', { name: /保存可编辑工程/ }).click();
      const data = JSON.parse((await readFile(file)).toString('utf8'));
      await closeModal();
      return data;
    };
    const run = async (name, operation) => {
      if (filter && !filter.test(name)) return;
      try {
        await operation();
        checks.push(name); console.log(`PASS ${name}`);
      } catch (error) {
        failures.push({ name, error: error.message }); console.error(`FAIL ${name}: ${error.message}`);
        await page.screenshot({ path: path.join(artifacts, `workflow-failure-${failures.length}.png`) }).catch(() => {});
        // Undo only our fault injection; keep each test independent after failure.
        await page.evaluate(() => {
          if (window.__regressionPut) { IDBObjectStore.prototype.put = window.__regressionPut; delete window.__regressionPut; }
          if (window.__regressionResume) { AudioContext.prototype.resume = window.__regressionResume; delete window.__regressionResume; }
          if (window.__regressionDelete) { IDBObjectStore.prototype.delete = window.__regressionDelete; delete window.__regressionDelete; }
          if (window.__regressionComplete) { Object.defineProperty(IDBTransaction.prototype, 'oncomplete', window.__regressionComplete); delete window.__regressionComplete; }
          window.__releaseResume?.();
        }).catch(() => {});
        await closeModal().catch(() => {});
        await dismissError().catch(() => {});
      }
    };

    await run('Blank prompt and title are rejected; valid work remains recoverable', async () => {
      await page.getByRole('button', { name: /新建创作/ }).click();
      await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').textContent(), /描述/);
      assert.equal((await records(page)).length, 0);
      const item = await generate();
      await page.getByRole('textbox', { name: '作品名称', exact: true }).fill('   ');
      await page.getByRole('textbox', { name: '作品名称', exact: true }).press('Enter');
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('textbox', { name: '作品名称', exact: true }).inputValue(), item.title);
      assert.equal((await records(page)).find(value => value.id === item.id).title, item.title);
      await dismissError();
    });

    for (const [mood, prompt] of [
      ['bright', '青春欢快的钢琴'], ['chill', '慵懒咖啡馆吉他'], ['cinematic', '电影叙事钢琴'],
      ['dreamy', '梦幻空灵钟琴'], ['focus', '专注学习极简钢琴'], ['retro', '复古电子合成器'],
    ]) await run(`Local mood ${mood} produces a playable 15-second work`, async () => {
      const item = await generate(prompt, 15);
      assert.equal(item.config.mood, mood);
      assert.equal(Number(await page.getByRole('slider', { name: '播放进度', exact: true }).getAttribute('max')), 15);
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await until(() => page.getByRole('slider', { name: '播放进度', exact: true }).inputValue(), value => Number(value) > 0.08, 'audio advances');
      await page.getByRole('button', { name: '暂停', exact: true }).click();
    });

    for (const duration of [15, 30, 60, 120]) await run(`Local duration ${duration}s matches project and audio`, async () => {
      const item = await generate('青春欢快的钢琴背景音乐', duration);
      assert.equal(item.config.duration, duration);
      assert.equal(Number(await page.getByRole('slider', { name: '播放进度', exact: true }).getAttribute('max')), duration);
    });

    await run('Custom prompt duration remains visible in dropdown and saved recipe', async () => {
      await studio();
      await page.getByRole('textbox', { name: '音乐描述', exact: true }).fill('青春钢琴45秒');
      assert.equal(await page.getByLabel('生成时长', { exact: true }).inputValue(), '45');
      assert.equal((await generate('青春钢琴45秒', 45)).config.duration, 45);
    });

    await run('Natural mute, restore and English unmute retain melody seed', async () => {
      const original = await generate();
      const muted = await refine('不要鼓点');
      assert.equal(muted.config.volumes.drums, 0);
      const restored = await refine('恢复鼓点');
      assert.ok(restored.config.volumes.drums > 0);
      await refine('mute drums');
      const english = await refine('unmute drums');
      assert.ok(english.config.volumes.drums > 0);
      assert.equal(english.config.seed, original.config.seed);
    });

    await run('Unknown refinement reports no change and recovers without duplicate work', async () => {
      await generate();
      const count = (await records(page)).length;
      await page.getByRole('textbox', { name: '微调描述', exact: true }).fill('像一只穿雨衣的河马');
      await page.getByRole('button', { name: '应用描述微调', exact: true }).click();
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').textContent(), /没有改变|无法识别|不支持/);
      assert.equal((await records(page)).length, count);
      await dismissError(); await refine('慢一点');
    });

    await run('Cancel leaves no partial work; double-click creates exactly one work', async () => {
      const item = await generate();
      const count = (await records(page)).length;
      await page.getByLabel('生成时长', { exact: true }).selectOption('120');
      await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
      await page.getByRole('button', { name: '取消', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /新建创作/ }).isDisabled(), true);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await ready();
      assert.equal((await records(page)).length, count);
      assert.equal(await currentId(), item.id);
      await page.getByLabel('生成时长', { exact: true }).selectOption('15');
      await page.getByRole('button', { name: '生成我的 BGM', exact: true }).evaluate(button => { button.click(); button.click(); });
      await until(() => records(page), values => values.length === count + 1, 'one generation committed');
      await ready(); await sleep(150);
      assert.equal((await records(page)).length, count + 1);
    });

    await run('Malformed, unsupported-version and oversized imports reject then recover', async () => {
      const baseline = await generate();
      const count = (await records(page)).length;
      for (const [name, buffer] of [
        ['broken.json', Buffer.from('{broken')],
        ['version.json', Buffer.from(JSON.stringify({ schemaVersion: 99, ...baseline }))],
        ['oversized.json', Buffer.alloc(1024 * 1024 + 1, 32)],
      ]) {
        await page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'application/json', buffer });
        await page.getByRole('alert').waitFor();
        assert.equal((await records(page)).length, count);
        await dismissError();
      }
      const recipe = await exportedJson();
      await page.locator('input[type="file"]').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(recipe)) });
      await until(() => records(page), values => values.length === count + 1, 'valid import after rejection');
      await ready();
    });

    await run('Export uses rendered recipe while edits are still drafts', async () => {
      const item = await generate();
      await setRange(page, '节奏速度', 67);
      await page.getByLabel('主奏乐器', { exact: true }).selectOption('guitar');
      await page.getByRole('button', { name: '循环片段', exact: true }).click();
      const recipe = await exportedJson();
      assert.deepEqual(recipe.config, item.config);
      await page.getByRole('button', { name: '导出', exact: true }).click();
      assert.equal(await page.locator('.checkbox-row input').isDisabled(), item.config.loop);
      await closeModal();
    });

    await run('Quota error keeps audible result unsaved; subsequent save recovers', async () => {
      await generate();
      const count = (await records(page)).length;
      await page.evaluate(() => {
        window.__regressionPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () { throw new DOMException('Injected test quota', 'QuotaExceededError'); };
      });
      await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
      await page.getByRole('alert').waitFor(); await ready();
      assert.equal((await records(page)).length, count);
      assert.match(await page.locator('.autosave').textContent(), /保存失败|未保存/);
      assert.equal(await page.getByRole('button', { name: '播放', exact: true }).isEnabled(), true);
      await page.evaluate(() => { IDBObjectStore.prototype.put = window.__regressionPut; delete window.__regressionPut; });
      const recovered = await generate();
      assert.match(await page.locator('.autosave').textContent(), /已保存/);
      // Older works may require an actual-duration metadata update on open.
      await page.evaluate(async id => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('muse-bgm', 1);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('projects', 'readwrite');
          const store = tx.objectStore('projects'), get = store.get(id);
          get.onsuccess = () => store.put({ ...get.result, audioDuration: 30 });
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, recovered.id);
      await page.reload();
      await page.getByRole('button', { name: /^我的作品/ }).click();
      await page.evaluate(() => {
        window.__regressionPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function () { throw new DOMException('Injected test quota', 'QuotaExceededError'); };
      });
      await page.getByRole('button', { name: `打开 ${recovered.title}`, exact: true }).click();
      await page.getByRole('alert').waitFor(); await ready();
      assert.equal(await page.getByRole('textbox', { name: '作品名称', exact: true }).inputValue(), recovered.title);
      assert.equal(Number(await page.getByRole('slider', { name: '播放进度', exact: true }).getAttribute('max')), 15);
      assert.equal(await page.getByRole('button', { name: '播放', exact: true }).isEnabled(), true);
      assert.match(await page.locator('.autosave').textContent(), /保存失败|未保存/);
      await page.evaluate(() => { IDBObjectStore.prototype.put = window.__regressionPut; delete window.__regressionPut; });
      await dismissError();
    });

    await run('Delayed AudioContext resume cannot restart audio after New work', async () => {
      await generate();
      await page.evaluate(() => {
        window.__regressionResume = AudioContext.prototype.resume;
        AudioContext.prototype.resume = function () {
          const context = this, resume = window.__regressionResume;
          return new Promise((resolve, reject) => {
            window.__releaseResume = () => resume.call(context).then(resolve, reject);
          });
        };
      });
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await page.waitForFunction(() => typeof window.__releaseResume === 'function');
      await page.getByRole('button', { name: /新建创作/ }).click();
      await page.evaluate(async () => {
        AudioContext.prototype.resume = window.__regressionResume; delete window.__regressionResume;
        await window.__releaseResume(); delete window.__releaseResume;
      });
      await sleep(120);
      assert.equal(await page.getByRole('button', { name: '暂停', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '播放', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('textbox', { name: '音乐描述', exact: true }).inputValue(), '');
    });

    await run('Turning loop off after wrapping retains audible playback position', async () => {
      await generate();
      const loop = page.getByRole('button', { name: '循环试听', exact: true });
      if (!/active/.test(await loop.getAttribute('class'))) await loop.click();
      await setRange(page, '播放进度', 14.8);
      await page.getByRole('button', { name: '播放', exact: true }).click();
      await until(() => page.getByRole('slider', { name: '播放进度', exact: true }).inputValue(), value => Number(value) > 0.02 && Number(value) < 1, 'loop crossed boundary');
      const before = Number(await page.getByRole('slider', { name: '播放进度', exact: true }).inputValue());
      const changedAt = Date.now();
      await loop.click();
      await sleep(100);
      const position = Number(await page.getByRole('slider', { name: '播放进度', exact: true }).inputValue());
      const elapsed = (Date.now() - changedAt) / 1000;
      assert.ok(Math.abs(position - before - elapsed) < 0.65, `position must remain continuous after loop off: before=${before}, after=${position}, elapsed=${elapsed}`);
      await page.getByRole('button', { name: '暂停', exact: true }).click();
    });

    await run('Favorite and deletion persist across renderer reload', async () => {
      const item = await generate();
      await page.getByRole('button', { name: '收藏作品', exact: true }).click();
      await until(() => records(page), values => values.find(value => value.id === item.id)?.favorite, 'favorite committed');
      await page.reload();
      await page.getByRole('button', { name: /^我的作品/ }).click();
      const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name: item.title, exact: true }) });
      await card.waitFor();
      assert.match(await card.getByRole('button', { name: `收藏 ${item.title}`, exact: true }).getAttribute('class'), /active/);
      await card.getByRole('button', { name: `删除 ${item.title}`, exact: true }).click();
      await until(() => records(page), values => !values.some(value => value.id === item.id), 'delete committed');
      await page.reload();
      await page.getByRole('button', { name: /^我的作品/ }).click();
      assert.equal((await records(page)).some(value => value.id === item.id), false);
      await studio();
    });

    await run('A delayed deletion cannot clear a different newly opened work', async () => {
      const keep = await generate();
      const remove = await generate();
      await page.evaluate(() => {
        window.__regressionDelete = IDBObjectStore.prototype.delete;
        window.__regressionComplete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
        IDBObjectStore.prototype.delete = function (...args) {
          this.transaction.__delayDeleteCallback = true;
          return window.__regressionDelete.apply(this, args);
        };
        const descriptor = window.__regressionComplete;
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
          ...descriptor,
          set(callback) {
            descriptor.set.call(this, this.__delayDeleteCallback && callback ? function (event) {
              setTimeout(() => { callback.call(this, event); window.__deleteCallbackDelivered = true; }, 1800);
            } : callback);
          },
        });
        window.__deleteCallbackDelivered = false;
      });
      await page.getByRole('button', { name: /^我的作品/ }).click();
      await page.getByRole('button', { name: `删除 ${remove.title}`, exact: true }).evaluate(button => button.click());
      await page.getByRole('button', { name: `打开 ${keep.title}`, exact: true }).evaluate(button => button.click());
      await ready();
      assert.equal(await page.getByRole('textbox', { name: '作品名称', exact: true }).inputValue(), keep.title);
      await page.waitForFunction(() => window.__deleteCallbackDelivered === true);
      await sleep(100);
      assert.equal(await page.getByRole('textbox', { name: '作品名称', exact: true }).inputValue(), keep.title);
      assert.equal(await page.getByRole('button', { name: '播放', exact: true }).isEnabled(), true);
      await page.evaluate(() => {
        IDBObjectStore.prototype.delete = window.__regressionDelete; delete window.__regressionDelete;
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', window.__regressionComplete); delete window.__regressionComplete;
      });
    });

    await run('Cloud WAV fixture exports original MIME and exact bytes, without a network call', async () => {
      const base = await generate();
      const fixture = wavFixture(3), id = `fixture-${Date.now()}`;
      await page.evaluate(async input => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('muse-bgm', 1);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('projects', 'readwrite');
          tx.objectStore('projects').put({ ...input.base, id: input.id, title: 'Fixture Cloud WAV', provider: 'elevenlabs', audioDuration: 3,
            config: { ...input.base.config, duration: 120 }, audioBlob: new Blob([new Uint8Array(input.audio)], { type: 'audio/wav' }) });
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, { base, id, audio: [...fixture] });
      await page.reload();
      await page.getByRole('button', { name: /^我的作品/ }).click();
      await page.getByRole('button', { name: '打开 Fixture Cloud WAV', exact: true }).click();
      await ready();
      assert.equal(Number(await page.getByRole('slider', { name: '播放进度', exact: true }).getAttribute('max')), 3);
      assert.equal(await page.getByRole('slider', { name: '旋律音量', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '导出', exact: true }).click();
      const file = path.join(profile, 'cloud-original.wav');
      await setSavePath(file);
      await page.getByRole('button', { name: /导出 AI 原始音频/ }).click();
      assert.deepEqual(await readFile(file), fixture);
      const options = await desktop.evaluate(() => globalThis.__regressionSaveOptions);
      assert.deepEqual(options.filters[0].extensions, ['wav']);
      assert.match(options.defaultPath, /\.wav$/);
      await closeModal();
      await page.getByRole('button', { name: /^我的作品/ }).click();
      const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name: 'Fixture Cloud WAV', exact: true }) });
      assert.equal(await card.locator('.cover-duration').textContent(), '00:03');
      await studio();
    });

    for (const provider of ['tencent', 'volcengine', 'aliyun', 'elevenlabs']) await run(`Provider ${provider}: missing-key guard, invalid input, encrypted save and removal`, async () => {
      await studio();
      await page.getByRole('textbox', { name: '音乐描述', exact: true }).fill('青春欢快背景音乐');
      await page.getByLabel('生成引擎', { exact: true }).selectOption(provider);
      await page.getByRole('button', { name: '生成我的 BGM', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      assert.equal(await page.getByLabel('配置的服务商', { exact: true }).inputValue(), provider);
      const save = page.getByRole('button', { name: '保存此服务配置', exact: true });
      assert.equal(await save.isDisabled(), true);
      const status = async () => (await page.evaluate(() => window.museDesktop.getSettings())).providers[provider];
      assert.equal((await status()).configured, false);
      await dismissError();
      if (provider === 'volcengine') {
        await page.getByLabel('Access Key ID', { exact: true }).fill('bad');
        await page.getByLabel('Secret Access Key', { exact: true }).fill('bad');
      } else {
        await page.getByLabel('API Key', { exact: true }).fill('bad');
        if (provider === 'aliyun') await page.getByLabel('Workspace ID', { exact: true }).fill('workflow-test-space');
      }
      await save.click();
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').textContent(), /格式|完整/);
      assert.equal((await status()).configured, false);
      await dismissError();
      const dummy = `workflow-dummy-not-a-real-${provider}-key`;
      if (provider === 'volcengine') {
        await page.getByLabel('Access Key ID', { exact: true }).fill(`${dummy}-id`);
        await page.getByLabel('Secret Access Key', { exact: true }).fill(`${dummy}-secret`);
        await page.getByLabel('火山计费方式', { exact: true }).selectOption('prepaid');
      } else await page.getByLabel('API Key', { exact: true }).fill(dummy);
      await save.click();
      await until(status, value => value.configured, 'dummy credentials encrypted locally');
      const encrypted = await fs.readFile(path.join(profile, 'Muse-Data', 'music-credentials.json'), 'utf8');
      assert.equal(encrypted.includes(dummy), false);
      assert.equal(JSON.stringify(await status()).includes(dummy), false);
      if (provider === 'volcengine') {
        assert.equal((await status()).billingMode, 'prepaid');
        assert.equal(await page.getByLabel('Secret Access Key', { exact: true }).inputValue(), '');
      } else assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
      if (provider === 'aliyun') assert.equal((await status()).workspaceId, 'workflow-test-space');
      // Never invoke generation with the dummy credential saved.
      await page.getByRole('button', { name: '移除此服务凭据', exact: true }).click();
      await until(status, value => !value.configured, 'dummy credentials removed');
      await closeModal();
      await page.getByLabel('生成引擎', { exact: true }).selectOption('local');
    });

    if (rendererErrors.length) failures.push({ name: 'Renderer errors', error: rendererErrors.join('\n') });
    const summary = { passed: checks.length, failed: failures.length, checks, failures, rendererErrors, noPaidApiCalls: true };
    await fs.writeFile(path.join(artifacts, filter ? 'workflow-regression-focused-results.json' : 'workflow-regression-results.json'), JSON.stringify(summary, null, 2));
    assert.deepEqual(failures, [], 'all workflow regressions must pass');
    console.log(`Workflow regression passed: ${checks.length} checks.`);
  } finally {
    if (desktop) await desktop.close();
    // Delete only the newly created, resolved sibling of the OS temp directory.
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('muse-workflow-regression-')) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
