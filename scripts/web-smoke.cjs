'use strict';

// End-to-end check of the web build the way the portal embeds it: dist-web/
// is served under /play/yinxu/ and framed by a parent page (1000×760), then
// opened directly on a phone-sized screen (390×780). Drives the real app
// through its data-testid hooks, fully offline.
//
//   npm run build:web && npm run test:web
//
// Builds nothing itself. Exits 1 on the first failed step and writes
// test-results/web-smoke.json either way. The run fails on any console
// error, CSP violation, failed request or request beyond the static files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist-web');
const OUT = path.join(ROOT, 'test-results');
const APP_PATH = '/play/yinxu/';
const PARENT_PATH = '/tools/yinxu/';
const FRAME = { width: 1000, height: 760 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, test, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  for (;;) {
    value = await read();
    if (test(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out: ${description}; last value: ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

/* ---------------- static server ---------------- */

function parentPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>音序 Muse（嵌入测试）</title>
<style>html,body{margin:0;background:#f4f3fa}iframe{display:block;border:0;margin:10px;width:${FRAME.width}px;height:${FRAME.height}px}</style>
</head><body><iframe id="app" src="${APP_PATH}" title="音序 Muse" allow="fullscreen"></iframe></body></html>`;
}

function startServer() {
  const log = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://local');
    const send = (status, body, type) => {
      log.push({ method: request.method, path: url.pathname, status });
      response.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "frame-ancestors 'self'",
      });
      response.end(body);
    };
    if (url.pathname === PARENT_PATH) return send(200, parentPage(), MIME['.html']);
    if (url.pathname.startsWith(APP_PATH)) {
      const relative = decodeURIComponent(url.pathname.slice(APP_PATH.length)) || 'index.html';
      const file = path.normalize(path.join(DIST, relative));
      if (!file.startsWith(DIST + path.sep)) return send(403, 'forbidden', 'text/plain');
      try {
        return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
      } catch {
        return send(404, 'not found', 'text/plain');
      }
    }
    return send(404, 'not found', 'text/plain');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        log,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    }),
  );
}

/* ---------------- browser ---------------- */

/** Chromium builds Playwright has downloaded on this machine, newest first. */
function installedChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  const layouts = {
    chromium_headless_shell: [
      'chrome-headless-shell-win64/chrome-headless-shell.exe',
      'chrome-headless-shell-linux64/chrome-headless-shell',
      'chrome-linux/headless_shell',
      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-headless-shell-mac-x64/chrome-headless-shell',
    ],
    chromium: [
      'chrome-win64/chrome.exe',
      'chrome-win/chrome.exe',
      'chrome-linux64/chrome',
      'chrome-linux/chrome',
      'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ],
  };
  const found = [];
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = /^(chromium_headless_shell|chromium)-(\d+)$/.exec(name);
      if (!match) continue;
      for (const relative of layouts[match[1]]) {
        const file = path.join(root, name, relative);
        if (fs.existsSync(file))
          found.push({ file, revision: Number(match[2]), shell: match[1] !== 'chromium' });
      }
    }
  }
  return found
    .sort((a, b) => b.revision - a.revision || Number(b.shell) - Number(a.shell))
    .map((entry) => entry.file);
}

async function launchBrowser() {
  const { chromium } = require('playwright');
  try {
    return { browser: await chromium.launch({ headless: true }), executable: 'bundled' };
  } catch (error) {
    // The bundled build for this Playwright version is not installed: use
    // whichever Chromium an earlier install left behind.
    for (const executablePath of installedChromium()) {
      try {
        return {
          browser: await chromium.launch({ headless: true, executablePath }),
          executable: executablePath,
        };
      } catch {
        /* try the next one */
      }
    }
    throw error;
  }
}

/* ---------------- helpers that run against the app frame ---------------- */

function records(frame) {
  return frame.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('muse-bgm');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('projects')) {
            database.close();
            resolve([]);
            return;
          }
          const tx = database.transaction('projects', 'readonly');
          const query = tx.objectStore('projects').getAll();
          query.onsuccess = () =>
            resolve(query.result.map(({ audioBlob, ...metadata }) => metadata));
          query.onerror = () => reject(query.error);
          tx.oncomplete = () => database.close();
        };
      }),
  );
}

function putRawRecord(frame, record) {
  return frame.evaluate(
    (value) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('muse-bgm');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const tx = database.transaction('projects', 'readwrite');
          tx.objectStore('projects').put(value);
          tx.oncomplete = () => {
            database.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      }),
    record,
  );
}

function wavInfo(bytes) {
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  const dataBytes = bytes.readUInt32LE(40);
  let sum = 0;
  let count = 0;
  for (let offset = 44; offset + 1 < bytes.length; offset += 2 * 16) {
    const sample = bytes.readInt16LE(offset) / 32768;
    sum += sample * sample;
    count++;
  }
  return {
    riff: bytes.toString('ascii', 0, 4),
    wave: bytes.toString('ascii', 8, 12),
    format: bytes.readUInt16LE(20),
    channels,
    sampleRate,
    bits,
    dataBytes,
    fileBytes: bytes.length,
    seconds: dataBytes / (sampleRate * channels * (bits / 8)),
    rms: Math.sqrt(sum / Math.max(1, count)),
  };
}

/** Runs in every document before the app: CSP violations, storage persistence, long tasks. */
function probes() {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (event) =>
    window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`),
  );
  window.__persistCalls = 0;
  const manager = navigator.storage;
  if (manager && typeof manager.persist === 'function') {
    const persist = manager.persist.bind(manager);
    manager.persist = () => {
      window.__persistCalls++;
      return persist();
    };
  }
  // Every (re)start of playback starts new AudioBufferSourceNodes.
  window.__sourceStarts = 0;
  if (window.AudioBufferSourceNode) {
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__sourceStarts++;
      return start.apply(this, args);
    };
  }
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* no long task timing in this browser */
  }
}

/** Nothing on the page is wider than the viewport, and no control hangs off its side. */
function layoutProblems() {
  const problems = [];
  const width = window.innerWidth;
  if (document.documentElement.scrollWidth > width + 1)
    problems.push(`page ${document.documentElement.scrollWidth} px wide in a ${width} px viewport`);
  for (const node of document.querySelectorAll('button, a[href], select, textarea, input:not([type=file]):not([hidden])')) {
    const box = node.getBoundingClientRect();
    if (box.width < 1 || node.closest('[inert]')) continue;
    // rows that scroll sideways on purpose
    if (node.closest('.style-chips, .refine-chips, .tabs')) continue;
    if (getComputedStyle(node).visibility === 'hidden') continue;
    if (box.right > width + 1 || box.left < -1)
      problems.push(`${node.getAttribute('data-testid') || node.tagName} at ${Math.round(box.left)}..${Math.round(box.right)}`);
  }
  for (const node of document.querySelectorAll('body *')) {
    if (node.children.length || !node.textContent.trim() || node.closest('.sr-only')) continue;
    const size = parseFloat(getComputedStyle(node).fontSize);
    if (size < 11.99 && node.getBoundingClientRect().width > 0) problems.push(`${size}px text: ${node.textContent.trim().slice(0, 16)}`);
  }
  return problems.slice(0, 8);
}

/* ---------------- the run ---------------- */

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist-web/index.html is missing. Run `npm run build:web` first.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-web-smoke-'));
  const server = await startServer();
  const { browser, executable } = await launchBrowser();
  const started = Date.now();
  const report = { executable, origin: server.origin, steps: [], ok: false };
  const sink = { console: [], pageErrors: [], failed: [], requests: [], csp: [] };
  let step = 'start';
  let stepStarted = Date.now();
  const pass = (name, detail) => {
    const ms = Date.now() - stepStarted;
    stepStarted = Date.now();
    report.steps.push({ name, ms, ...(detail === undefined ? {} : { detail }) });
    console.log(`ok   ${name}  (${(ms / 1000).toFixed(1)} s)${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  };
  const watch = (page) => {
    page.on('console', (message) => {
      if (message.type() === 'error')
        sink.console.push({ text: message.text(), url: message.location()?.url });
    });
    page.on('pageerror', (error) => sink.pageErrors.push(String(error?.stack || error)));
    page.on('requestfailed', (request) =>
      sink.failed.push({ url: request.url(), error: request.failure()?.errorText }),
    );
    page.on('request', (request) => sink.requests.push(request.url()));
  };

  try {
    const context = await browser.newContext({
      viewport: { width: FRAME.width + 40, height: FRAME.height + 40 },
      acceptDownloads: true,
      locale: 'zh-CN',
    });
    await context.addInitScript(probes);
    const page = await context.newPage();
    watch(page);

    let frame;
    const open = async () => {
      const handle = await page.waitForSelector('iframe#app');
      frame = await handle.contentFrame();
      await frame.waitForSelector('[data-testid="nav-studio"]', { timeout: 30000 });
    };
    const $ = (id) => frame.locator(`[data-testid="${id}"]`);
    const card = () => $('player-card');
    const idle = () => frame.waitForSelector('[data-testid="job-status"]', { state: 'detached', timeout: 120000 });
    const revisionLoaded = async (revision) => {
      await frame.waitForSelector(`[data-testid="player-card"][data-revision="${revision}"][data-audio="stems"]`, { timeout: 120000 });
      await idle();
      await frame.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 15000 });
    };
    const download = async (trigger, name) => {
      const [file] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), trigger()]);
      const target = path.join(downloads, name);
      await file.saveAs(target);
      return { suggested: file.suggestedFilename(), bytes: fs.readFileSync(target) };
    };
    const byRevision = async (revision) => (await records(frame)).find((record) => record.revision === revision);
    const pressed = (id) => $(id).getAttribute('aria-pressed');
    const pause = async () => {
      if ((await pressed('play-button')) === 'true') await $('play-button').click();
    };
    const toasts = () => frame.locator('[data-testid="toast"] > span').allInnerTexts();
    const clearToasts = async () => {
      await frame.evaluate(() => {
        for (const button of document.querySelectorAll('[data-testid="toast-close"]')) button.click();
      });
      await frame.waitForSelector('[data-testid="toast"]', { state: 'detached', timeout: 5000 });
    };

    /* 1 — load inside the frame; web build: local only, the rest says where it is */
    step = 'load';
    await page.goto(`${server.origin}${PARENT_PATH}`);
    await open();
    assert.equal(frame.url(), `${server.origin}${APP_PATH}`);
    assert.equal(await frame.evaluate(() => window.self !== window.top), true, 'runs inside an iframe');
    assert.equal(await frame.evaluate(() => typeof window.museDesktop), 'undefined');
    const engines = await $('composer-engine').locator('option').evaluateAll((options) =>
      options.map((option) => ({ value: option.value, disabled: option.disabled, text: option.textContent })),
    );
    assert.equal(engines.length, 5);
    assert.deepEqual(engines.filter((option) => !option.disabled).map((option) => option.value), ['local']);
    assert.ok(engines.slice(1).every((option) => option.text.includes('桌面版可用')), JSON.stringify(engines));
    const brains = await $('composer-brain').locator('option').evaluateAll((options) =>
      options.map((option) => ({ value: option.value, disabled: option.disabled, text: option.textContent })),
    );
    assert.deepEqual(brains.map((option) => [option.value, option.disabled]), [['rules', false], ['llm', true]]);
    assert.ok(brains[1].text.includes('桌面版可用'));
    assert.equal(await $('desktop-link').getAttribute('target'), '_top');
    assert.match(await $('desktop-link').getAttribute('href'), /^https:\/\//);
    assert.equal(await $('style-chip-auto').getAttribute('aria-pressed'), 'true');
    assert.equal(await frame.locator('[data-testid^="style-chip-"]').count(), 23);
    assert.deepEqual(await frame.evaluate(layoutProblems), []);
    pass('loads inside the iframe as the web build', { engines: engines.length });

    /* 1b — settings on the web: no forms, a way to the desktop app */
    step = 'web settings';
    await $('settings-button').click();
    await $('settings-modal').waitFor();
    for (const tab of ['music', 'llm']) {
      await $(`settings-tab-${tab}`).click();
      await $('desktop-only').waitFor();
      assert.equal(await $('desktop-download').getAttribute('target'), '_top');
      assert.equal(await frame.locator('input[type="password"]').count(), 0, 'no secret fields on the web');
    }
    await $('settings-tab-about').click();
    assert.match(await $('about-version').innerText(), /网页版/);
    await page.keyboard.press('Escape');
    await $('settings-modal').waitFor({ state: 'detached' });
    pass('settings explain the desktop-only features instead of dead ends');

    /* 2 — describe → generate with the offline producer */
    step = 'generate';
    await $('composer-input').fill('雨夜咖啡馆，慵懒的钢琴和轻轻的鼓点');
    await $('composer-duration').selectOption('15');
    const preview = await until(() => $('plan-preview').innerText(), (text) => text.startsWith('将创作：'), 'plan preview');
    assert.match(preview, /慵懒松弛.*15 秒/);
    // Three clicks before the interface can repaint: one job, one work.
    await $('send-button').evaluate((button) => {
      button.click();
      button.click();
      button.click();
    });
    await revisionLoaded(1);
    const first = await byRevision(1);
    assert.ok(first, 'revision 1 is in IndexedDB');
    assert.equal(first.provider, 'local');
    assert.equal(first.config.engine, 2);
    assert.equal(first.config.mood, 'chill');
    assert.equal(first.config.duration, 15);
    assert.equal(first.chat.length, 2);
    const duration1 = Number(await card().getAttribute('data-duration'));
    assert.ok(duration1 > 5 && duration1 < 40, `duration ${duration1}`);
    assert.equal(await frame.locator('[data-testid$="-fader"]').count(), 4, 'four stems');
    assert.ok((await frame.locator('[data-testid="section-band"]').count()) >= 1, 'section bands');
    assert.ok((await $('chord-strip').locator('span').count()) >= 2, 'chord strip');
    assert.equal(await $('work-version').innerText(), 'v1');
    assert.match(await $('work-meta').innerText(), /慵懒松弛/);
    assert.equal(await $('composer-input').inputValue(), '', 'the sent text left the composer');
    assert.equal(await frame.locator('[data-testid="thread-turn"]').count(), 2);
    // v0.2 left the result below the fold with nothing focused (APP-07).
    const landing = await frame.evaluate(() => {
      const node = document.querySelector('[data-testid="play-button"]');
      const box = node.getBoundingClientRect();
      return { focused: document.activeElement === node, visible: box.top >= 0 && box.bottom <= innerHeight };
    });
    assert.deepEqual(landing, { focused: true, visible: true });
    await until(() => pressed('play-button'), (value) => value === 'true', 'plays after the click that started the job');
    assert.equal(await frame.evaluate(() => window.__persistCalls), 1, 'storage persistence is requested after the first save');
    assert.equal((await records(frame)).length, 1, 'the triple click made one work');
    pass('describe → generate → stems loaded, saved, in view and playing', { seconds: duration1, seed: first.config.seed, title: first.title });

    /* 3 — play / pause moves time */
    step = 'transport';
    const position = async () => Number(await $('waveform').getAttribute('aria-valuenow'));
    await until(position, (value) => value >= 2, 'playhead advances', 15000);
    await $('play-button').click();
    assert.equal(await pressed('play-button'), 'false');
    const paused = await $('time-display').innerText();
    assert.ok(!paused.startsWith('0:00'), `time moved while playing: ${paused}`);
    const held = await position();
    await $('restart-button').click();
    await until(position, (value) => value === 0, 'back to the start');
    await $('waveform').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await position(), 5, 'arrow keys seek by five seconds');
    await page.keyboard.press('Home');
    assert.equal(await position(), 0);
    assert.equal(await pressed('play-button'), 'false', 'seeking does not start playback');
    // 循环试听: playback wraps at the end and keeps going; without it, it stops there.
    await $('loop-toggle').click();
    assert.equal(await pressed('loop-toggle'), 'true');
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await $('play-button').click();
    await until(position, (value) => value <= 3, 'the audition loop wraps to the start', 10000);
    assert.equal(await pressed('play-button'), 'true', 'still playing after the wrap');
    await $('loop-toggle').click();
    await $('waveform').focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await until(() => pressed('play-button'), (value) => value === 'false', 'without the loop, playback stops at the end', 10000);
    await $('restart-button').click();
    pass('play, pause, seek and the audition loop move and hold the playhead', { paused, held });

    /* 3b — keyboard: real shortcuts, and none of them while typing */
    step = 'shortcuts';
    await $('work-meta').click();
    await page.keyboard.press('l');
    assert.equal(await pressed('loop-toggle'), 'true');
    await page.keyboard.press('l');
    assert.equal(await pressed('loop-toggle'), 'false');
    await page.keyboard.press('Space');
    await until(() => pressed('play-button'), (value) => value === 'true', 'Space plays');
    await page.keyboard.press('Space');
    await until(() => pressed('play-button'), (value) => value === 'false', 'Space pauses');
    await $('composer-input').click();
    await page.keyboard.type('l l');
    assert.equal(await $('composer-input').inputValue(), 'l l');
    assert.equal(await pressed('loop-toggle'), 'false', 'typing is not a shortcut');
    assert.equal(await pressed('play-button'), 'false');
    await $('composer-input').fill('');
    await page.keyboard.press('Control+e');
    await $('export-modal').waitFor();
    assert.equal(await frame.locator('.app-body').evaluate((node) => node.inert), true, 'the page behind a modal is inert');
    await page.keyboard.press('Escape');
    await $('export-modal').waitFor({ state: 'detached' });
    pass('keyboard shortcuts');

    /* 4 — refine by message: revision 2, drums muted, same seed */
    step = 'refine';
    await $('composer-input').fill('慢一点，不要鼓');
    await $('send-button').click();
    await revisionLoaded(2);
    await pause();
    const second = await byRevision(2);
    assert.equal(second.parentId, first.id);
    assert.equal(second.config.seed, first.config.seed, 'same seed');
    assert.ok(second.config.bpm < first.config.bpm, `${second.config.bpm} < ${first.config.bpm}`);
    assert.equal(second.config.volumes.drums, 0);
    assert.equal(second.title, first.title);
    assert.equal(await pressed('mixer-drums-mute'), 'true');
    assert.equal(await $('mixer-drums-fader').inputValue(), '0');
    assert.equal(await frame.locator('[data-testid="thread-turn"]').count(), 4);
    assert.equal((await records(frame)).length, 2, 'the first version is kept');
    // A message that asks for nothing audible: an answer, no new version.
    await $('composer-input').fill('今天天气怎么样');
    await $('composer-input').press('Enter');
    await until(() => frame.locator('[data-testid="thread-turn"]').count(), (count) => count === 6, 'the producer answers');
    await idle();
    assert.equal((await records(frame)).length, 2);
    assert.equal(await card().getAttribute('data-revision'), '2');
    assert.ok((await frame.locator('[data-testid="suggestion-chip"]').count()) >= 3, 'suggestions to try next');
    pass('refinement by message → v2, drums off, same seed; an idle message changes nothing', { bpm: [first.config.bpm, second.config.bpm] });

    /* 5 — inspector edit survives typing, then apply → revision 3 */
    step = 'inspector';
    assert.equal(await $('apply-draft').isDisabled(), true);
    await $('inspector-instrument').selectOption('guzheng');
    await $('changed-instrument').waitFor();
    assert.equal(await $('apply-draft').isDisabled(), false);
    assert.match(await $('apply-draft').innerText(), /1 项/);
    // v0.2 reset the whole inspector on any keystroke in the description.
    await $('composer-input').pressSequentially('复古电子 150 BPM', { delay: 5 });
    assert.equal(await $('inspector-instrument').inputValue(), 'guzheng');
    assert.equal(await $('mixer-drums-fader').inputValue(), '0');
    await $('composer-input').fill('');
    await $('apply-draft').click();
    await revisionLoaded(3);
    await pause();
    const third = await byRevision(3);
    assert.equal(third.config.instrument, 'guzheng');
    assert.equal(third.config.seed, first.config.seed, 'apply keeps the seed');
    assert.equal(third.config.bpm, second.config.bpm);
    assert.equal(third.parentId, second.id);
    assert.equal(await $('apply-draft').isDisabled(), true);
    pass('inspector change + apply → v3 with the same seed', { instrument: third.config.instrument });

    /* 5b — a 120 s render: the page stays responsive, the job shows everywhere, cancel writes nothing */
    step = 'long render and cancel';
    await $('inspector-duration').selectOption('120');
    const renderFrom = await frame.evaluate(() => performance.now());
    await $('apply-draft').click();
    await frame.waitForSelector('[data-testid="job-status"][data-stage="rendering"]', { timeout: 15000 });
    assert.equal(await $('send-button').isDisabled(), true, 'busy while a job runs');
    await $('nav-library').click();
    await $('library-page').waitFor();
    assert.equal(await $('job-status').count(), 1, 'the job is shown on the library page');
    assert.equal(await frame.locator('[data-testid="library-open"]').first().isDisabled(), true, 'works cannot be switched during a job');
    await $('nav-inspiration').click();
    await $('inspiration-page').waitFor();
    assert.equal(await $('job-status').count(), 1, 'and on the inspiration page');
    await $('nav-studio').click();
    // let the worker do most of the two minutes of audio, then cancel
    await until(() => $('job-progress').getAttribute('aria-valuenow'), (value) => Number(value) >= 60, 'the render makes progress', 90000);
    await $('job-cancel').click();
    await idle();
    const longest = await frame.evaluate((from) => Math.max(0, ...window.__longTasks.filter((task) => task.start >= from).map((task) => task.duration)), renderFrom);
    assert.ok(longest < 200, `longest main-thread task while rendering: ${longest} ms`);
    const cancelToast = await toasts();
    assert.ok(cancelToast.includes('已取消本地生成'), JSON.stringify(cancelToast));
    assert.equal(await card().getAttribute('data-revision'), '3');
    assert.equal(await card().getAttribute('data-audio'), 'stems');
    assert.equal((await records(frame)).length, 3, 'a cancelled job writes nothing');
    assert.equal(await $('inspector-duration').inputValue(), '120', 'the draft is still there to apply again');
    await $('reset-draft').click();
    assert.equal(await $('apply-draft').isDisabled(), true);
    pass('a long render keeps the page responsive, is shown on every page and can be cancelled', { longestTaskMs: Math.round(longest) });

    /* 6 — fader, mute, solo */
    step = 'mixer';
    const fader = $('mixer-melody-fader');
    await fader.focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await fader.inputValue(), '30');
    await until(() => byRevision(3), (record) => Math.abs(record.config.volumes.melody - 0.3) < 1e-6, 'fader saved');
    const bassBefore = (await byRevision(3)).config.volumes.bass;
    await $('mixer-bass-mute').click();
    assert.equal(await pressed('mixer-bass-mute'), 'true');
    await until(() => byRevision(3), (record) => record.config.volumes.bass === 0, 'mute saved');
    await $('mixer-bass-mute').click();
    await until(() => byRevision(3), (record) => record.config.volumes.bass === bassBefore, 'unmute returns to the old level');
    const beforeSolo = await byRevision(3);
    await $('mixer-melody-solo').click();
    assert.equal(await pressed('mixer-melody-solo'), 'true');
    // Playing with a stem soloed, then a fader move: playback goes on (v0.2 restarted the audio).
    await $('play-button').click();
    await until(() => pressed('play-button'), (value) => value === 'true', 'plays soloed');
    await until(position, (value) => value >= 1, 'the playhead moves');
    const startsBefore = await frame.evaluate(() => window.__sourceStarts);
    assert.ok(startsBefore >= 4, 'four stems are playing');
    await $('mixer-chords-fader').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await $('mixer-drums-mute').click();
    await $('mixer-drums-mute').click();
    await $('mixer-melody-solo').click();
    await $('mixer-melody-solo').click();
    assert.equal(await pressed('play-button'), 'true', 'mixing does not stop playback');
    // v0.2 re-mixed offline and restarted the audio on every fader event (APP-08).
    assert.equal(await frame.evaluate(() => window.__sourceStarts), startsBefore, 'faders, mute and solo are gain changes: nothing is restarted');
    await pause();
    await until(() => frame.locator('[data-testid="save-state"]').getAttribute('data-state'), (state) => state === 'saved', 'the mix is saved');
    assert.deepEqual((await byRevision(3)).config.volumes, beforeSolo.config.volumes, 'solo is not part of the work');
    assert.equal((await records(frame)).length, 3, 'mixing creates no versions');
    assert.equal(await card().getAttribute('data-revision'), '3');
    pass('fader, mute and solo', { melody: 0.3, bass: bassBefore });

    /* 7 — export with solo still on: full mix WAV (×1 and ×2), a stem, the project JSON */
    step = 'export';
    await $('export-button').click();
    await $('export-modal').waitFor();
    assert.deepEqual(
      await frame.locator('[data-testid^="export-option-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid').slice('export-option-'.length))),
      ['mix', 'stem-melody', 'stem-chords', 'stem-bass', 'stem-drums', 'project'],
    );
    const duration3 = Number(await card().getAttribute('data-duration'));
    const mix = await download(() => $('export-option-mix').click(), 'mix.wav');
    const mixInfo = wavInfo(mix.bytes);
    assert.equal(mixInfo.riff, 'RIFF');
    assert.equal(mixInfo.wave, 'WAVE');
    assert.equal(mixInfo.format, 1);
    assert.equal(mixInfo.channels, 2);
    assert.equal(mixInfo.sampleRate, 48000);
    assert.equal(mixInfo.bits, 16);
    assert.equal(mixInfo.fileBytes, 44 + mixInfo.dataBytes);
    assert.ok(Math.abs(mixInfo.seconds - duration3) < 0.01, `${mixInfo.seconds} s vs ${duration3} s`);
    assert.ok(mixInfo.rms > 0.01, `mix rms ${mixInfo.rms}`);
    assert.equal(mix.suggested, `${third.title} v3.wav`);
    const stem = await download(() => $('export-option-stem-melody').click(), 'melody.wav');
    const stemInfo = wavInfo(stem.bytes);
    assert.equal(stemInfo.sampleRate, 48000);
    assert.equal(stemInfo.dataBytes, mixInfo.dataBytes);
    assert.equal(stem.suggested, `${third.title} v3-旋律.wav`);
    // Melody is soloed in the player: the exported mix must still be the full mix.
    assert.ok(!mix.bytes.equals(stem.bytes), 'full mix differs from the soloed stem');
    assert.ok(mixInfo.rms > stemInfo.rms * 1.1, `mix rms ${mixInfo.rms} vs melody ${stemInfo.rms}`);
    // 循环次数: the loop twice, sample for sample.
    await $('export-repeats-2').click();
    const twice = await download(() => $('export-option-mix').click(), 'mix-x2.wav');
    assert.equal(twice.suggested, `${third.title} v3-循环x2.wav`);
    assert.equal(wavInfo(twice.bytes).dataBytes, mixInfo.dataBytes * 2);
    assert.ok(twice.bytes.subarray(44, 44 + mixInfo.dataBytes).equals(mix.bytes.subarray(44)), 'first pass');
    assert.ok(twice.bytes.subarray(44 + mixInfo.dataBytes).equals(mix.bytes.subarray(44)), 'second pass');
    const json = await download(() => $('export-option-project').click(), 'project.json');
    const projectFile = path.join(downloads, 'project.json');
    const parsed = JSON.parse(json.bytes.toString('utf8'));
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.audioBlob, undefined);
    assert.equal(parsed.revision, 3);
    assert.equal(parsed.config.seed, first.config.seed);
    assert.equal(parsed.config.volumes.melody, 0.3);
    assert.equal(parsed.chat.length, 8);
    assert.equal(json.suggested, `${third.title} v3.json`);
    await page.keyboard.press('Escape');
    await $('export-modal').waitFor({ state: 'detached' });
    pass('export: 48 kHz WAV of the full mix, the loop twice, a stem, the project JSON', {
      seconds: mixInfo.seconds,
      megabytes: +(mixInfo.fileBytes / 1048576).toFixed(2),
      mixRms: +mixInfo.rms.toFixed(4),
      stemRms: +stemInfo.rms.toFixed(4),
    });

    /* 7b — the interface fails to render: the work can still be exported, and the app comes back */
    step = 'error boundary';
    assert.deepEqual(sink.console, [], 'console errors before the forced one');
    assert.deepEqual(sink.pageErrors, [], 'page errors before the forced one');
    await frame.evaluate(() => {
      window.__getHours = Date.prototype.getHours;
      // the thread shows the time of each turn: make its next render throw
      Date.prototype.getHours = function () {
        throw new Error('web-smoke: forced render error');
      };
    });
    // The thread renders again as soon as something in it changes: typing may
    // already be enough, a new turn certainly is.
    await $('composer-input').fill('你好', { timeout: 5000 }).catch(() => {});
    if (!(await $('error-boundary').count())) await $('composer-input').press('Enter', { timeout: 5000 }).catch(() => {});
    await $('error-boundary').waitFor({ timeout: 30000 });
    assert.match(await $('error-boundary').innerText(), /界面出了点问题/);
    const rescued = await download(() => $('crash-export').click(), 'rescued.wav');
    assert.ok(rescued.bytes.equals(mix.bytes), 'the same full mix as before');
    await frame.evaluate(() => {
      Date.prototype.getHours = window.__getHours;
    });
    await $('crash-retry').click();
    await $('studio-work').waitFor();
    await idle();
    assert.equal(await card().getAttribute('data-revision'), '3');
    assert.equal(await $('play-button').isEnabled(), true);
    // What React and the boundary logged about the forced error is expected; nothing else may follow.
    const logged = sink.console.splice(0);
    assert.ok(logged.some((entry) => entry.text.includes('render failed')), 'the boundary logs the failure');
    assert.ok(sink.pageErrors.splice(0).every((text) => text.includes('forced render error')));
    await clearToasts();
    pass('a render error shows the recovery panel; export works; 回到界面 recovers');

    /* 8 — reload restores the session and the library */
    step = 'reload';
    await $('composer-input').fill('再明亮一点');
    // the composer text is remembered half a second after typing stops
    await until(
      () => frame.evaluate(() => JSON.parse(localStorage.getItem('muse-bgm:session') || '{}').composerText),
      (text) => text === '再明亮一点',
      'the session is written',
    );
    await page.reload();
    await open();
    await frame.waitForSelector(`[data-testid="player-card"][data-project="${third.id}"][data-audio="stems"]`, { timeout: 120000 });
    await idle();
    assert.equal(await pressed('play-button'), 'false', 'restored without playing');
    assert.equal(await $('composer-input').inputValue(), '再明亮一点');
    assert.equal(await $('mixer-melody-fader').inputValue(), '30');
    assert.equal(await pressed('mixer-melody-solo'), 'false', 'solo is not part of a work');
    await $('nav-library').click();
    assert.equal(await frame.locator('[data-testid="library-card"]').count(), 3);
    assert.match(await $('storage-note').innerText(), /只保存在这个浏览器里/);
    pass('reload restores the last work, the composer text and the library');

    /* 8b — import the exported project: a new work, rendered again by the engine */
    step = 'import';
    await $('import-input').setInputFiles(projectFile);
    await frame.waitForSelector(`[data-testid="player-card"][data-audio="stems"]:not([data-project="${third.id}"])`, { timeout: 120000 });
    await idle();
    const imported = (await records(frame)).find((record) => ![first.id, second.id, third.id].includes(record.id));
    assert.ok(imported, 'the import is a new record');
    assert.deepEqual(imported.config, parsed.config, 'the recipe survives the round trip');
    assert.equal(imported.revision, 3);
    assert.equal(imported.config.volumes.melody, 0.3);
    assert.equal(await card().getAttribute('data-project'), imported.id);
    assert.equal(await frame.locator('[data-testid="thread-turn"]').count(), 8, 'the conversation travels with the file');
    pass('import of the exported project JSON');

    /* 8c — library: rename, favourite, search, sort */
    step = 'library';
    await $('work-title').fill('导入的那一首');
    await page.keyboard.press('Enter');
    await until(() => records(frame), (list) => list.find((record) => record.id === imported.id)?.title === '导入的那一首', 'the new title is saved');
    await $('favourite-button').click();
    await until(() => records(frame), (list) => list.find((record) => record.id === imported.id)?.favorite === true, 'favourite is saved');
    await $('nav-library').click();
    const cards = frame.locator('[data-testid="library-card"]');
    assert.equal(await cards.count(), 4);
    await $('library-search').fill('导入');
    assert.equal(await cards.count(), 1);
    assert.match(await $('library-count').innerText(), /1\s*\/\s*4/);
    await $('library-search').fill('不存在的名字');
    await $('library-no-match').waitFor();
    await $('library-search').fill('');
    await $('library-favourites').click();
    assert.equal(await cards.count(), 1);
    await $('library-favourites').click();
    await $('library-sort-title').click();
    const sorted = await frame.locator('[data-testid="library-open"]').allInnerTexts();
    assert.deepEqual(sorted, [...sorted].sort((a, b) => a.localeCompare(b, 'zh-CN')));
    await $('library-sort-recent').click();
    assert.deepEqual(await frame.evaluate(layoutProblems), []);
    // Quick play, then another work while the first is playing: one plays, then none, never two.
    await frame.locator(`[data-testid="library-card"][data-project="${imported.id}"] [data-testid="library-play"]`).click();
    await until(() => pressed('play-button'), (value) => value === 'true', 'quick play opens the studio and plays');
    await $('nav-library').click();
    assert.equal(await pressed('mini-play'), 'true', 'it keeps playing while the library is browsed');
    await frame.locator(`[data-testid="library-card"][data-project="${third.id}"] [data-testid="library-open"]`).click();
    await frame.waitForSelector(`[data-testid="player-card"][data-project="${third.id}"][data-audio="stems"]`, { timeout: 120000 });
    await idle();
    assert.equal(await pressed('play-button'), 'false', 'a work that is merely opened does not start playing');
    assert.equal(await $('mixer-melody-fader').inputValue(), '30', 'its own mix is back');
    await $('nav-library').click();
    pass('library: rename, favourite, search, sort; opening another work stops the one playing');

    /* 9 — delete + undo, then a real delete */
    step = 'delete';
    const cardOf = (id) => frame.locator(`[data-testid="library-card"][data-project="${id}"]`);
    await cardOf(third.id).locator('[data-testid="library-delete"]').click();
    assert.equal(await cards.count(), 3);
    assert.equal((await records(frame)).length, 4, 'nothing is deleted during the undo window');
    await $('toast-action').click();
    assert.equal(await cards.count(), 4);
    await cardOf(first.id).locator('[data-testid="library-delete"]').click();
    assert.equal(await cards.count(), 3);
    await until(() => records(frame), (list) => list.length === 3, 'deleted after the undo window', 15000);
    assert.ok(!(await records(frame)).some((record) => record.id === first.id));
    pass('delete with undo, then delete for real');

    /* 9b — delete and leave at once: the deletion is still carried out */
    step = 'delete then reload';
    await cardOf(second.id).locator('[data-testid="library-delete"]').click();
    assert.equal((await records(frame)).length, 3, 'still stored inside the undo window');
    await page.reload();
    await open();
    await $('nav-library').click();
    await until(() => frame.locator('[data-testid="library-card"]').count(), (count) => count === 2, 'the deleted work does not come back');
    assert.ok(!(await records(frame)).some((record) => record.id === second.id), 'and it is gone from storage');
    pass('a delete followed by leaving the page is still a delete');

    /* 10 — a corrupt record is listed separately and does not hide the rest */
    step = 'damaged';
    await putRawRecord(frame, { id: 'corrupt-1', title: '坏掉的记录', config: { mood: 'polka', bpm: 'fast' } });
    await page.reload();
    await open();
    await $('nav-library').click();
    await $('damaged-section').waitFor();
    assert.equal(await frame.locator('[data-testid="damaged-record"]').count(), 1);
    assert.ok((await $('damaged-reason').innerText()).trim().length > 0);
    assert.equal(await frame.locator('[data-testid="library-card"]').count(), 2, 'good works are still listed');
    const raw = await download(() => $('damaged-export').click(), 'damaged.json');
    assert.match(raw.bytes.toString('utf8'), /polka/);
    await $('damaged-delete').click();
    await $('damaged-delete-confirm').click();
    await $('damaged-section').waitFor({ state: 'detached' });
    assert.ok(!(await records(frame)).some((record) => record.id === 'corrupt-1'));
    pass('damaged record: listed, exported, removed');

    /* 10b — inspiration → composer with a pinned style → a new piece */
    step = 'inspiration';
    await $('nav-inspiration').click();
    await $('inspiration-page').waitFor();
    assert.equal(await frame.locator('[data-testid="inspiration-card"]').count(), 22);
    assert.ok((await frame.locator('[data-testid="inspiration-prompt"]').count()) >= 15);
    await frame.locator('[data-testid="inspiration-card"][data-style="guofeng"]').click();
    await $('studio-empty').waitFor();
    assert.equal(await $('style-chip-guofeng').getAttribute('aria-pressed'), 'true');
    assert.ok((await $('composer-input').inputValue()).length > 4);
    assert.equal(await frame.locator('[data-testid="mini-transport"]').count(), 0, 'the work that was loaded is left');
    await $('composer-duration').selectOption('15');
    await $('composer-structure').selectOption('ending');
    await $('composer-input').focus();
    await page.keyboard.press('Control+Enter');
    await revisionLoaded(1);
    await pause();
    const fresh = (await records(frame)).find((record) => record.config.mood === 'guofeng');
    assert.ok(fresh, 'the pinned style was used');
    assert.equal(fresh.config.duration, 15);
    assert.equal(fresh.config.loop, false, 'the pinned structure was used');
    assert.equal(Number(await card().getAttribute('data-duration')), 15, 'a piece with an ending has exactly the asked length');
    assert.equal(fresh.chat.length, 2, 'a new piece starts its own conversation');
    await $('new-melody').click();
    await revisionLoaded(2);
    await pause();
    assert.equal(await frame.evaluate(() => window.__persistCalls), 1, 'persistence is asked for once per page load, not per save');
    const varied = (await records(frame)).find((record) => record.parentId === fresh.id);
    assert.notEqual(varied.config.seed, fresh.config.seed, '换一版旋律 changes the seed');
    assert.equal(varied.config.mood, 'guofeng');
    pass('inspiration pins a style; Ctrl+Enter generates; 换一版旋律 makes a new version', { title: fresh.title });

    /* 11 — the same build on a phone-sized screen, opened directly */
    step = 'phone';
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 780 }, acceptDownloads: true, locale: 'zh-CN', hasTouch: true, isMobile: true });
    await phoneContext.addInitScript(probes);
    const phone = await phoneContext.newPage();
    watch(phone);
    const p$ = (id) => phone.locator(`[data-testid="${id}"]`);
    await phone.goto(`${server.origin}${APP_PATH}`);
    // a browser of its own: nothing stored yet
    await p$('studio-empty').waitFor({ timeout: 30000 });
    assert.equal(await phone.evaluate(() => window.self === window.top), true);
    assert.deepEqual(await phone.evaluate(layoutProblems), [], 'empty composer');
    await p$('style-all').tap();
    await p$('style-sheet').waitFor();
    assert.equal(await phone.locator('[data-testid^="style-option-"]').count(), 23);
    await p$('style-option-chiptune').tap();
    await p$('style-sheet').waitFor({ state: 'detached' });
    assert.equal(await p$('style-chip-chiptune').getAttribute('aria-pressed'), 'true');
    await p$('composer-duration').selectOption('15');
    // a pinned style alone is enough to start from
    assert.equal(await p$('composer-input').inputValue(), '');
    assert.equal(await p$('send-button').isEnabled(), true);
    await p$('send-button').tap();
    await phone.waitForSelector('[data-testid="player-card"][data-revision="1"][data-audio="stems"]', { timeout: 120000 });
    await phone.waitForSelector('[data-testid="job-status"]', { state: 'detached', timeout: 120000 });
    await phone.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 15000 });
    const made = await records(phone);
    assert.equal(made.length, 1);
    assert.equal(made[0].config.mood, 'chiptune');
    const playBox = await p$('play-button').boundingBox();
    assert.ok(playBox && playBox.y >= 0 && playBox.y + playBox.height <= 780, 'the play button is on screen after generating');
    assert.ok(playBox.width >= 40 && playBox.height >= 40, `touch targets are at least 40 px: ${playBox.width}×${playBox.height}`);
    if ((await p$('play-button').getAttribute('aria-pressed')) === 'true') await p$('play-button').tap();
    assert.deepEqual(await phone.evaluate(layoutProblems), [], 'studio with a work');
    await p$('nav-library').tap();
    await p$('library-page').waitFor();
    assert.equal(await phone.locator('[data-testid="library-card"]').count(), 1);
    assert.deepEqual(await phone.evaluate(layoutProblems), [], 'library');
    assert.equal(await p$('mini-transport').count(), 1, 'the mini transport follows to other pages');
    await p$('mini-play').tap();
    await until(() => p$('mini-play').getAttribute('aria-pressed'), (value) => value === 'true', 'the mini transport plays');
    await p$('mini-play').tap();
    await p$('nav-inspiration').tap();
    await p$('inspiration-page').waitFor();
    assert.deepEqual(await phone.evaluate(layoutProblems), [], 'inspiration');
    await p$('settings-button').tap();
    await p$('settings-modal').waitFor();
    const sheet = await p$('settings-modal').boundingBox();
    assert.ok(sheet.x >= 0 && sheet.x + sheet.width <= 390.5, 'the dialog fits the screen');
    await p$('modal-close').tap();
    await p$('settings-modal').waitFor({ state: 'detached' });
    const phoneCsp = await phone.evaluate(() => window.__csp);
    await phoneContext.close();
    pass('phone-sized screen (390×780, touch): no sideways scrolling, style sheet, generate, mini transport');

    /* 12 — clean: no console errors, nothing but the static files requested */
    step = 'clean';
    const csp = [...(await frame.evaluate(() => window.__csp)), ...phoneCsp];
    const allowed = new Set(
      [PARENT_PATH, APP_PATH, ...fs.readdirSync(path.join(DIST, 'assets')).map((name) => `${APP_PATH}assets/${name}`)],
    );
    const network = sink.requests.filter((url) => /^(https?|wss?):/i.test(url));
    const foreign = network.filter((url) => {
      const parsedUrl = new URL(url);
      return parsedUrl.origin !== server.origin || !allowed.has(parsedUrl.pathname);
    });
    const badStatus = server.log.filter((entry) => entry.status !== 200);
    assert.deepEqual(sink.console, [], 'console errors');
    assert.deepEqual(sink.pageErrors, [], 'page errors');
    assert.deepEqual(sink.failed, [], 'failed requests');
    assert.deepEqual(csp, [], 'CSP violations');
    assert.deepEqual(foreign, [], 'requests beyond the static files');
    assert.deepEqual(badStatus, [], 'non-200 responses');
    pass('no console errors and no network beyond the static files', {
      requests: network.length,
      files: [...new Set(server.log.map((entry) => entry.path))].length,
    });
    report.ok = true;
  } catch (error) {
    report.error = { step, message: String(error?.stack || error) };
    report.console = sink.console;
    report.pageErrors = sink.pageErrors;
    report.failed = sink.failed;
    console.error(`FAIL ${step}\n${report.error.message}`);
    if (sink.console.length) console.error('console errors:', JSON.stringify(sink.console, null, 1));
    if (sink.pageErrors.length) console.error('page errors:', sink.pageErrors.join('\n'));
  } finally {
    await browser.close().catch(() => {});
    await server.close();
    fs.rmSync(downloads, { recursive: true, force: true });
    report.seconds = +((Date.now() - started) / 1000).toFixed(1);
    fs.writeFileSync(path.join(OUT, 'web-smoke.json'), JSON.stringify(report, null, 2));
  }
  console.log(report.ok ? `web smoke passed (${report.steps.length} steps in ${report.seconds} s)` : `web smoke FAILED at "${step}" after ${report.steps.length} passed step(s)`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
