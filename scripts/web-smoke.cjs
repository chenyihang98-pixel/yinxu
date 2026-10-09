"use strict";

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
//
// One step also loads the desktop renderer build (dist/, when it exists) in
// the same browser with a stand-in for the Electron bridge: the paid flows —
// billing notice, the question before a paid request, an unsaved paid result
// — cannot be reached in the web build, which has no cloud engines. Another
// opens the web build as a 1366×768 window (the size at which v0.3.0 hid the
// inspector's buttons) for what the review asked to be true on screen:
// pending edits stay reachable and are never dropped, the mixer and the
// chips follow what the piece contains, 循环试听 follows the structure.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// MUSE_WEB_DIST: check a web build that lives somewhere else (a private build
// next to other work in progress); the default is the one `npm run build:web` writes.
const DIST = process.env.MUSE_WEB_DIST
  ? path.resolve(process.env.MUSE_WEB_DIST)
  : path.join(ROOT, "dist-web");
const OUT = path.join(ROOT, "test-results");
// The desktop renderer build, for the paid-flow checks with a stand-in bridge (step 10h).
const DESKTOP_DIST = process.env.MUSE_DESKTOP_DIST
  ? path.resolve(process.env.MUSE_DESKTOP_DIST)
  : path.join(ROOT, "dist");
const DESKTOP_PATH = "/desktop/";
const APP_PATH = "/play/yinxu/";
const PARENT_PATH = "/tools/yinxu/";
const FRAME = { width: 1000, height: 760 };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, test, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  for (;;) {
    value = await read();
    if (test(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `timed out: ${description}; last value: ${JSON.stringify(value)}`,
      );
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
    const url = new URL(request.url, "http://local");
    const send = (status, body, type) => {
      log.push({ method: request.method, path: url.pathname, status });
      response.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "frame-ancestors 'self'",
      });
      response.end(body);
    };
    if (url.pathname === PARENT_PATH)
      return send(200, parentPage(), MIME[".html"]);
    for (const [prefix, root] of [
      [APP_PATH, DIST],
      [DESKTOP_PATH, DESKTOP_DIST],
    ]) {
      if (!url.pathname.startsWith(prefix)) continue;
      const relative =
        decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
      const file = path.normalize(path.join(root, relative));
      if (!file.startsWith(root + path.sep))
        return send(403, "forbidden", "text/plain");
      try {
        return send(
          200,
          fs.readFileSync(file),
          MIME[path.extname(file)] || "application/octet-stream",
        );
      } catch {
        return send(404, "not found", "text/plain");
      }
    }
    return send(404, "not found", "text/plain");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
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
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
  ].filter(Boolean);
  const layouts = {
    chromium_headless_shell: [
      "chrome-headless-shell-win64/chrome-headless-shell.exe",
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-linux/headless_shell",
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-headless-shell-mac-x64/chrome-headless-shell",
    ],
    chromium: [
      "chrome-win64/chrome.exe",
      "chrome-win/chrome.exe",
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
      "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
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
          found.push({
            file,
            revision: Number(match[2]),
            shell: match[1] !== "chromium",
          });
      }
    }
  }
  return found
    .sort(
      (a, b) => b.revision - a.revision || Number(b.shell) - Number(a.shell),
    )
    .map((entry) => entry.file);
}

async function launchBrowser() {
  const { chromium } = require("playwright");
  try {
    return {
      browser: await chromium.launch({ headless: true }),
      executable: "bundled",
    };
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
        const request = indexedDB.open("muse-bgm");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("projects")) {
            database.close();
            resolve([]);
            return;
          }
          const tx = database.transaction("projects", "readonly");
          const query = tx.objectStore("projects").getAll();
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
        const request = indexedDB.open("muse-bgm");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const tx = database.transaction("projects", "readwrite");
          tx.objectStore("projects").put(value);
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
    riff: bytes.toString("ascii", 0, 4),
    wave: bytes.toString("ascii", 8, 12),
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
  document.addEventListener("securitypolicyviolation", (event) =>
    window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`),
  );
  window.__persistCalls = 0;
  const manager = navigator.storage;
  if (manager && typeof manager.persist === "function") {
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
      for (const entry of list.getEntries())
        window.__longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
        });
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* no long task timing in this browser */
  }
}

/** Nothing on the page is wider than the viewport, and no control hangs off its side. */
function layoutProblems() {
  const problems = [];
  const width = window.innerWidth;
  if (document.documentElement.scrollWidth > width + 1)
    problems.push(
      `page ${document.documentElement.scrollWidth} px wide in a ${width} px viewport`,
    );
  for (const node of document.querySelectorAll(
    "button, a[href], select, textarea, input:not([type=file]):not([hidden])",
  )) {
    const box = node.getBoundingClientRect();
    if (box.width < 1 || node.closest("[inert]")) continue;
    // rows that scroll sideways on purpose
    if (node.closest(".style-chips, .refine-chips, .tabs")) continue;
    if (getComputedStyle(node).visibility === "hidden") continue;
    if (box.right > width + 1 || box.left < -1)
      problems.push(
        `${node.getAttribute("data-testid") || node.tagName} at ${Math.round(box.left)}..${Math.round(box.right)}`,
      );
  }
  for (const node of document.querySelectorAll("body *")) {
    if (
      node.children.length ||
      !node.textContent.trim() ||
      node.closest(".sr-only")
    )
      continue;
    const size = parseFloat(getComputedStyle(node).fontSize);
    if (size < 11.99 && node.getBoundingClientRect().width > 0)
      problems.push(`${size}px text: ${node.textContent.trim().slice(0, 16)}`);
  }
  return problems.slice(0, 8);
}

/* ---------------- the desktop renderer in the browser ---------------- */

/**
 * Stands in for the Electron preload bridge (runs before the app). A "cloud
 * service" that answers with a real MP3 after a moment, a save dialog that
 * records what it was given, and a counter of paid requests that survives a
 * reload. Nothing leaves the page.
 */
function standInBridge({ mp3Base64 }) {
  const bytes = Uint8Array.from(atob(mp3Base64), (char) => char.charCodeAt(0));
  const paid = () => Number(localStorage.getItem("__paid") || 0);
  window.__paid = paid;
  window.__saved = [];
  window.__risk = [];
  window.__putFailures = 0;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (window.__putFailures > 0) {
      window.__putFailures--;
      throw new DOMException("Internal error", "UnknownError");
    }
    return put.apply(this, args);
  };
  window.museDesktop = Object.freeze({
    getSettings: async () => ({
      providers: {
        tencent: { configured: true, model: "minimax-music-v3.0" },
        volcengine: { configured: false },
        aliyun: { configured: false },
        elevenlabs: { configured: false },
      },
      llm: { configured: false },
      dataPath: "C:\\stand-in",
      version: "0.3.0-smoke",
    }),
    saveProviderCredentials: async () => {},
    deleteProviderCredentials: async () => {},
    generateMusic: () => {
      localStorage.setItem("__paid", String(paid() + 1));
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({ audio: bytes.slice().buffer, mimeType: "audio/mpeg" }),
          200,
        ),
      );
    },
    cancelGeneration: async () => {},
    retryLastDownload: async () => {
      throw new Error("没有等待重新下载的音乐。");
    },
    setUnsavedWork: async (value) => void window.__risk.push(value),
    saveAudio: async (input) => {
      window.__saved.push({
        name: input.name,
        format: input.format,
        bytes: input.data.byteLength,
      });
      return { saved: true, path: "C:\\Music\\stand-in" };
    },
    openExternal: async () => {},
    saveLlmSettings: async () => {},
    deleteLlmSettings: async () => {},
    agentPlan: async () => {
      throw new Error("还没有配置大模型。");
    },
    cancelAgent: async () => {},
  });
}

/**
 * The paid flows, in the real interface: with a cloud engine the cost is on
 * screen, nothing is sent without a yes (a chip never sends), and a result
 * whose save failed stays, is not left unasked, and can be exported.
 */
async function desktopRenderer(browser, origin) {
  const mp3 = fs.readFileSync(
    path.join(ROOT, "tests", "fixtures", "music-3s.mp3"),
  );
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    locale: "zh-CN",
  });
  await context.addInitScript(standInBridge, {
    mp3Base64: mp3.toString("base64"),
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(String(error?.stack || error)));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  const $ = (id) => page.locator(`[data-testid="${id}"]`);
  const paid = () => page.evaluate(() => window.__paid());
  const idle = () =>
    page.waitForSelector('[data-testid="job-status"]', {
      state: "detached",
      timeout: 120000,
    });
  const mixLoaded = async (revision) => {
    await page.waitForSelector(
      `[data-testid="player-card"][data-revision="${revision}"][data-audio="mix"]`,
      { timeout: 60000 },
    );
    await idle();
  };
  try {
    await page.goto(`${origin}${DESKTOP_PATH}`);
    await $("nav-studio").waitFor({ timeout: 30000 });
    assert.equal(
      await page.evaluate(() =>
        document.querySelector(".app").getAttribute("data-platform"),
      ),
      "desktop",
    );
    // A cloud engine: the cost is said where the request is started, and the preview is worded as a target.
    await $("composer-input").fill("雨夜咖啡馆，慵懒的钢琴");
    assert.equal(
      await $("paid-notice").count(),
      0,
      "the local engine is free: no notice",
    );
    assert.match(await $("hero-lede").innerText(), /本地作曲不联网/);
    await $("composer-engine").selectOption("tencent");
    assert.match(
      await $("composer-engine").locator('option[value="tencent"]').innerText(),
      /^腾讯云 TokenHub · 按服务商计费$/,
      "the selector names a service as the settings do",
    );
    // UX-11: with a cloud engine selected nothing on the page still promises "offline, on this computer"
    assert.match(
      await $("hero-lede").innerText(),
      /交给腾讯云 TokenHub 云端生成，按服务商计费/,
    );
    assert.doesNotMatch(await $("hero-lede").innerText(), /不联网|本机/);
    assert.match(
      await $("paid-notice").innerText(),
      /将向腾讯云 TokenHub 发送一次新的生成请求，按该服务计费/,
    );
    await until(
      () => $("plan-preview").innerText(),
      (text) => text.startsWith("目标："),
      "the preview is a target, not a promise",
    );
    // Sending asks first; Escape (the safe answer has the focus) sends nothing and keeps the text.
    await $("send-button").click();
    await $("dialog-paid").waitFor();
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-testid"),
      ),
      "dialog-choice-cancel",
    );
    assert.equal(await paid(), 0);
    await page.keyboard.press("Escape");
    await $("dialog-paid").waitFor({ state: "detached" });
    assert.equal(await paid(), 0);
    assert.equal(
      await $("composer-input").inputValue(),
      "雨夜咖啡馆，慵懒的钢琴",
    );
    await $("send-button").click();
    await $("dialog-choice-confirm").click();
    await mixLoaded(1);
    assert.equal(await paid(), 1);
    await page.waitForSelector(
      '[data-testid="save-state"][data-state="saved"]',
      { timeout: 15000 },
    );
    // Next day: the cloud work is restored and the selector follows it. One click on a chip buys nothing.
    await page.reload();
    await mixLoaded(1);
    assert.equal(await $("composer-engine").inputValue(), "tencent");
    assert.match(
      await $("paid-notice").innerText(),
      /云端每次都是重新生成，不保留原旋律/,
    );
    assert.equal(
      (await $("new-melody").innerText()).trim(),
      "重新生成一版（计费）",
    );
    await $("composer-input").fill("再安静一些");
    const chips = page.locator('[data-testid="suggestion-chip"]');
    const chipCount = Math.min(4, await chips.count());
    for (let index = 0; index < chipCount; index++)
      await chips.nth(index).click();
    await sleep(500);
    assert.equal(
      await paid(),
      1,
      "v0.3.0: every chip was a paid request at once",
    );
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    assert.ok(
      (await $("composer-input").inputValue()).startsWith("再安静一些，"),
      "the chips joined what was typed",
    );
    // The composed message asks, generates one new version, and does not claim the melody was kept.
    await $("composer-input").fill("慢一点");
    await $("composer-input").press("Enter");
    await $("dialog-paid").waitFor();
    assert.equal(await paid(), 1);
    await $("dialog-remember").check();
    await $("dialog-choice-confirm").click();
    await mixLoaded(2);
    assert.equal(await paid(), 2);
    const reply = (
      await page
        .locator('[data-testid="thread-turn"][data-role="agent"] .turn-text')
        .allInnerTexts()
    ).at(-1);
    assert.doesNotMatch(reply, /旋律素材保持不变|旋律保持不变/);
    assert.match(reply, /重新生成/);
    assert.equal(
      await page.evaluate(() => window.__risk.at(-1)),
      false,
      "nothing at risk once the result is stored",
    );
    // A paid result whose save fails (twice: the first write and the automatic retry) stays on screen.
    await page.evaluate(() => {
      window.__putFailures = 2;
    });
    await $("composer-input").fill("更有活力");
    await $("composer-input").press("Enter");
    await mixLoaded(3);
    assert.equal(
      await paid(),
      3,
      "no question this time: 本次会话不再提示 was ticked",
    );
    await $("unsaved-banner").waitFor();
    assert.match(
      await $("unsaved-banner").innerText(),
      /腾讯云 TokenHub 付费生成，但还没有保存到「我的作品」/,
    );
    assert.equal(
      await page.evaluate(() => window.__risk.at(-1)),
      true,
      "the shell is told: its close button asks first",
    );
    const said = (
      await page.locator('[data-testid="toast"] > span').allInnerTexts()
    ).join(" | ");
    assert.match(said, /没能保存到「我的作品」[\s\S]*请先导出原始音频/);
    assert.doesNotMatch(
      said,
      /重新启动/,
      "v0.3.0 advised a restart, which destroys the only copy",
    );
    await until(
      () => page.evaluate(() => window.__putFailures),
      (left) => left === 0,
      "the automatic retry ran",
      15000,
    );
    await sleep(300);
    assert.equal(await $("unsaved-banner").count(), 1);
    // Leaving it asks; the safe answer keeps it. A new version (a further payment) asks about it first, too.
    await page.evaluate(() => {
      window.__putFailures = 99;
    });
    await $("new-piece").click();
    await $("dialog-unsaved").waitFor();
    assert.match(
      await $("dialog-unsaved").innerText(),
      /付费生成的音频还没有保存[\s\S]*重新生成需要再次付费/,
    );
    await page.keyboard.press("Escape");
    await $("dialog-unsaved").waitFor({ state: "detached" });
    assert.equal(
      await $("player-card").getAttribute("data-revision"),
      "3",
      "v0.3.0: one click emptied the studio",
    );
    await $("composer-input").fill("慢一点");
    await $("composer-input").press("Enter");
    await $("dialog-unsaved").waitFor();
    await $("dialog-choice-stay").click();
    assert.equal(await paid(), 3);
    // 导出原始音频 hands over the exact bytes; 重试保存 stores it once the library works again.
    await $("unsaved-export").click();
    await until(
      () => page.evaluate(() => window.__saved.length),
      (count) => count === 1,
      "the original audio was handed to the save dialog",
    );
    const exported = await page.evaluate(() => window.__saved[0]);
    assert.equal(exported.format, "mp3");
    assert.equal(exported.bytes, mp3.length);
    await page.evaluate(() => {
      window.__putFailures = 0;
    });
    await $("retry-save").click();
    await $("unsaved-banner").waitFor({ state: "detached" });
    await page.waitForSelector(
      '[data-testid="save-state"][data-state="saved"]',
      { timeout: 15000 },
    );
    assert.equal(await page.evaluate(() => window.__risk.at(-1)), false);
    assert.equal(
      (await records(page)).filter((record) => record.provider === "tencent")
        .length,
      3,
      "all three paid results are in the library",
    );
    // A cloud work: the header is worded as the request, and no tempo is claimed for audio nobody measured.
    assert.match(
      await $("work-meta").innerText(),
      /^生成要求：慵懒松弛 · 约 \d+ BPM · /,
    );
    await $("nav-library").click();
    await $("library-page").waitFor();
    for (const line of await page.locator(".work-line").allInnerTexts())
      assert.doesNotMatch(line, /BPM/, line);
    // UX-06: 制作人大模型 — a disabled save button says why; a hint never looks like a value.
    await $("settings-button").click();
    await $("settings-tab-llm").click();
    await $("llm-form").waitFor();
    await $("llm-preset").selectOption("deepseek");
    await $("llm-key").fill("sk-0123456789abcdef0123456789abcdef");
    assert.equal(await $("llm-save").isDisabled(), true);
    assert.equal(
      (await $("llm-save-reason").innerText()).trim(),
      "还需要填写：模型",
    );
    assert.equal(
      await $("llm-save").getAttribute("aria-describedby"),
      await $("llm-save-reason").getAttribute("id"),
    );
    assert.match(
      await $("llm-model").getAttribute("placeholder"),
      /^形如 /,
      "an example of the format, worded as one",
    );
    assert.match(
      await $("llm-model-hint").innerText(),
      /在服务商控制台的模型列表里复制模型名称/,
    );
    assert.equal(
      await $("llm-console-link").count(),
      1,
      "with the way to that console",
    );
    const looks = await page.evaluate(() => {
      const model = document.querySelector('[data-testid="llm-model"]');
      const url = document.querySelector('[data-testid="llm-base-url"]');
      const style = (node, pseudo) => getComputedStyle(node, pseudo);
      return {
        placeholder: style(model, "::placeholder").color,
        value: style(model).color,
        readOnly: {
          colour: style(url).color,
          background: style(url).backgroundColor,
          border: style(url).borderTopStyle,
          locked: !!url.parentElement.querySelector("svg"),
        },
        field: style(model).backgroundColor,
      };
    });
    assert.notEqual(
      looks.placeholder,
      looks.value,
      "a hint is dimmer than a value",
    );
    assert.notEqual(
      looks.placeholder,
      looks.readOnly.colour,
      "v0.3.0: an empty field with a hint and a filled read-only field looked the same",
    );
    assert.notEqual(
      looks.readOnly.background,
      looks.field,
      "a read-only value does not sit in an input well",
    );
    assert.equal(looks.readOnly.border, "dashed");
    assert.equal(looks.readOnly.locked, true);
    await $("llm-model").fill("some-model");
    assert.equal(await $("llm-save").isEnabled(), true);
    assert.equal(await $("llm-save-reason").count(), 0);
    await $("llm-preset").selectOption("ollama");
    assert.match(
      await $("llm-notice").innerText(),
      /^本机 Ollama：你的描述文字只发给这台电脑上的 Ollama/,
    );
    assert.doesNotMatch(
      await $("llm-notice").innerText(),
      /发送给所选服务商/,
      "v0.3.0 said both at once",
    );
    await page.keyboard.press("Escape");
    await $("settings-modal").waitFor({ state: "detached" });
    assert.deepEqual(problems, [], "console and page errors");
    return { paidRequests: await paid() };
  } finally {
    await context.close();
  }
}

/* ---------------- the web build as a small desktop window ---------------- */

/**
 * What the v0.3 review asked to be true on screen, checked where it was
 * found wanting: a 1366×768 window (the inspector's buttons were below the
 * fold there), then the same page narrowed to a phone.
 */
async function reviewWindow(browser, origin, watch) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
  });
  await context.addInitScript(probes);
  const page = await context.newPage();
  watch(page);
  const $ = (id) => page.locator(`[data-testid="${id}"]`);
  const pressed = (id) => $(id).getAttribute("aria-pressed");
  const loaded = async (revision) => {
    await page.waitForSelector(
      `[data-testid="player-card"][data-revision="${revision}"][data-audio="stems"]`,
      { timeout: 120000 },
    );
    await page.waitForSelector('[data-testid="job-status"]', {
      state: "detached",
      timeout: 120000,
    });
    await page.waitForSelector(
      '[data-testid="save-state"][data-state="saved"]',
      { timeout: 15000 },
    );
  };
  const pause = async () => {
    if ((await pressed("play-button")) === "true")
      await $("play-button").click();
  };
  const toastTexts = () =>
    page.locator('[data-testid="toast"] > span').allInnerTexts();
  const clearToasts = async () => {
    await page.evaluate(() => {
      for (const button of document.querySelectorAll(
        '[data-testid="toast-close"]',
      ))
        button.click();
    });
    await page.waitForSelector('[data-testid="toast"]', {
      state: "detached",
      timeout: 5000,
    });
  };
  /** On screen and not covered: the point in its middle hits it. */
  const reachable = (id) =>
    page.evaluate((testId) => {
      const node = document.querySelector(`[data-testid="${testId}"]`);
      if (!node) return false;
      const box = node.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (
        box.top < 0 ||
        box.bottom > innerHeight ||
        box.left < 0 ||
        box.right > innerWidth
      )
        return false;
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === node || node.contains(hit));
    }, id);
  const pending = () =>
    page
      .locator('[data-testid^="changed-"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-testid")).sort(),
      );
  const tip = () =>
    page.evaluate(() => {
      const node = document.querySelector(".tooltip");
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const axis = document.querySelector(".timeline").getBoundingClientRect();
      return {
        text: node.textContent,
        overTimeAxis: box.bottom > axis.top && box.top < axis.bottom,
      };
    });
  const generate = async (text, options = {}) => {
    if (await $("studio-work").count()) await $("new-piece").click();
    await $("studio-empty").waitFor();
    await $("composer-input").fill(text);
    if (options.style) await $(`style-chip-${options.style}`).click();
    if (options.seconds)
      await $("composer-duration").selectOption(String(options.seconds));
    if (options.structure)
      await $("composer-structure").selectOption(options.structure);
    await $("send-button").click();
    await loaded(1);
    await pause();
    return $("player-card").getAttribute("data-project");
  };
  try {
    await page.goto(`${origin}${APP_PATH}`);
    await $("studio-empty").waitFor({ timeout: 30000 });

    /* UX-02 — 应用调整 / 全部还原 / 换一版旋律 are on screen however the panel is scrolled */
    await generate("雨夜咖啡馆，慵懒的钢琴和轻轻的鼓点");
    for (const id of ["apply-draft", "reset-draft", "new-melody"])
      assert.equal(
        await reachable(id),
        true,
        `${id} is on screen at 1366×768 (v0.3.0: 30 px below the fold)`,
      );
    await $("inspector-instrument").selectOption("guzheng");
    await $("inspector-bpm-number").fill("96");
    await $("inspector-bpm-number").press("Enter");
    assert.deepEqual(await pending(), ["changed-bpm", "changed-instrument"]);
    assert.match(
      await $("pending-summary").innerText(),
      /^2 项待应用\s*速度、主奏乐器$/,
    );
    assert.match(await $("apply-draft").innerText(), /应用调整（2 项）/);
    for (const id of ["apply-draft", "reset-draft", "new-melody"])
      assert.equal(await reachable(id), true, id);
    // the panel scrolled to its top or its end: the footer stays where it is
    for (const top of [0, 99999]) {
      await page.evaluate(
        (value) => document.querySelector(".studio-side").scrollTo(0, value),
        top,
      );
      assert.equal(
        await reachable("apply-draft"),
        true,
        `apply-draft with the panel scrolled to ${top}`,
      );
    }
    assert.match(
      await $("apply-hint").innerText(),
      /^应用调整会生成一个新版本，之前的版本会保留。/,
    );
    assert.match(
      await $("new-melody").getAttribute("data-tip"),
      /这 2 项修改不会用上，会留在新版本上等待应用/,
      "the tip says what happens to the pending edits",
    );

    /* UX-02 — 换一版旋律 and a chat message keep the pending edits, and say so */
    await clearToasts();
    await $("new-melody").click();
    await loaded(2);
    await pause();
    assert.match(
      await $("work-meta").innerText(),
      /柔和钢琴/,
      "the variation is of the work as it is",
    );
    assert.deepEqual(
      await pending(),
      ["changed-bpm", "changed-instrument"],
      "v0.3.0: the draft was reset without a word",
    );
    assert.equal(await $("inspector-instrument").inputValue(), "guzheng");
    assert.ok(
      (await toastTexts()).some((text) =>
        /还有 2 项没有应用的修改，已保留在新版本上/.test(text),
      ),
      JSON.stringify(await toastTexts()),
    );
    await clearToasts();
    await $("composer-input").fill("慢一点");
    await $("composer-input").press("Enter");
    await loaded(3);
    assert.deepEqual(await pending(), ["changed-bpm", "changed-instrument"]);
    assert.equal(await $("inspector-bpm-number").inputValue(), "96");

    /* UX-08 — the finished job focuses the play button; no tip parks itself on the time axis */
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-testid"),
      ),
      "play-button",
    );
    await sleep(900);
    assert.equal(
      await tip(),
      null,
      "focus set by the app shows no tip (v0.3.0: 暂停（空格） over the chord strip for the whole playback)",
    );
    await pause();
    const playBox = await $("play-button").boundingBox();
    await page.mouse.move(4, 4);
    await page.mouse.move(
      playBox.x + playBox.width / 2,
      playBox.y + playBox.height / 2,
    );
    await sleep(800);
    assert.deepEqual(
      await tip(),
      { text: "播放（空格）", overTimeAxis: false },
      "a hovered tip sits under the transport",
    );
    await page.mouse.down();
    await page.mouse.up();
    await sleep(1200);
    assert.equal(
      await tip(),
      null,
      "no tip comes back on the button that was just clicked",
    );
    await pause();
    await page.mouse.move(4, 4);
    await $("restart-button").focus();
    await page.keyboard.press("Tab");
    await sleep(200);
    assert.equal(
      (await tip())?.overTimeAxis,
      false,
      "keyboard focus still gets its tip, under the control",
    );
    await page.keyboard.press("Escape");

    /* lost input — leaving the work parks the edits and the unsent words; coming back returns them */
    await $("composer-input").fill("结尾留一点空白");
    await clearToasts();
    await $("new-piece").click();
    await $("studio-empty").waitFor();
    assert.equal(await $("composer-input").inputValue(), "");
    await page.locator('[data-testid="recent-work"]').first().click();
    await page.waitForSelector(
      '[data-testid="player-card"][data-revision="3"][data-audio="stems"]',
      { timeout: 60000 },
    );
    await page.waitForSelector('[data-testid="job-status"]', {
      state: "detached",
      timeout: 60000,
    });
    assert.deepEqual(
      await pending(),
      ["changed-bpm", "changed-instrument"],
      "v0.3.0: leaving a work dropped its pending edits",
    );
    assert.equal(await $("composer-input").inputValue(), "结尾留一点空白");
    assert.ok(
      (await toastTexts()).some((text) =>
        /有 2 项修改没有应用，已经放回来了/.test(text),
      ),
      JSON.stringify(await toastTexts()),
    );
    await $("composer-input").fill("");
    await $("reset-draft").click();
    assert.deepEqual(await pending(), []);
    assert.equal(await $("apply-draft").isDisabled(), true);
    assert.equal(await $("pending-summary").count(), 0);

    /* UX-12 — the library: a version reads "v3 · 源自 v2" in full, also on the open work */
    await $("nav-library").click();
    await $("library-page").waitFor();
    const cards = await page
      .locator('[data-testid="library-card"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const origin = node.querySelector('[data-testid="library-origin"]');
          return {
            version: node.querySelector('[data-testid="library-version"]')
              .textContent,
            origin: origin?.textContent ?? null,
            cut: origin ? origin.scrollWidth > origin.clientWidth + 1 : false,
            tip: origin?.getAttribute("data-tip") ?? null,
            open:
              node.querySelector('[data-testid="library-current"]')
                ?.textContent ?? null,
          };
        }),
      );
    assert.deepEqual(
      cards.map((item) => [item.version, item.origin, item.cut, item.open]),
      [
        ["v3", "源自 v2", false, "当前打开"],
        ["v2", "源自 v1", false, null],
        ["v1", null, false, null],
      ],
    );
    assert.match(cards[0].tip, /^v3 · 源自《.+》v2$/);
    await $("nav-studio").click();

    /* UX-07 — the mixer names who plays; only a silent stem is "not used"; the chips follow */
    const loopWork = await generate("深夜学习用的，安静一点", {
      style: "chill",
      seconds: 15,
    });
    const rows = async () =>
      Object.fromEntries(
        await page
          .locator(".mix-row")
          .evaluateAll((nodes) =>
            nodes.map((node) => [
              node.getAttribute("data-track"),
              [
                node.querySelector(".mix-name span").textContent.trim(),
                node.hasAttribute("data-silent"),
              ],
            ]),
          ),
      );
    const chipTexts = () =>
      page.locator('[data-testid="suggestion-chip"]').allInnerTexts();
    const before = await rows();
    assert.deepEqual(before.melody, ["电钢琴", false]);
    assert.deepEqual(
      before.chords,
      ["电钢琴", false],
      "v0.3.0: 这首曲子没有用到, next to a sounding stem",
    );
    assert.deepEqual(before.drums, ["这一版没有用到", true]);
    assert.ok(
      !(await chipTexts()).includes("不要鼓"),
      "there are no drums to take away",
    );
    assert.ok(
      (await chipTexts()).includes("加点沙锤"),
      JSON.stringify(await chipTexts()),
    );
    // the card's line and the header give the real length of this loop
    assert.match(await $("time-display").innerText(), /\/ 0:18$/);

    /* UX-09 — 循环试听 follows the structure; a choice is kept per structure */
    assert.equal(await pressed("loop-toggle"), "true", "a 循环片段 loops");
    // the chip that was offered does what it says: percussion comes in, and now there are drums to remove
    await page
      .locator('[data-testid="suggestion-chip"]', { hasText: "加点沙锤" })
      .click();
    await loaded(2);
    await pause();
    const after = await rows();
    assert.equal(after.drums[1], false, "the drum stem now sounds");
    assert.notEqual(after.drums[0], "这一版没有用到");
    assert.ok(
      (await chipTexts()).includes("不要鼓"),
      JSON.stringify(await chipTexts()),
    );
    const loopVersion = await $("player-card").getAttribute("data-project");
    const endingWork = await generate("温柔的钢琴独奏，婚礼入场", {
      seconds: 30,
      structure: "ending",
    });
    assert.match(await $("work-meta").innerText(), /完整结尾/);
    assert.equal(
      await pressed("loop-toggle"),
      "false",
      "a composed ending is not wrapped back to the start (v0.3.0: the toggle carried over)",
    );
    await $("loop-toggle").click();
    assert.equal(await pressed("loop-toggle"), "true");
    const open = async (id) => {
      await $("nav-library").click();
      await page
        .locator(
          `[data-testid="library-card"][data-project="${id}"] [data-testid="library-open"]`,
        )
        .click();
      await page.waitForSelector(
        `[data-testid="player-card"][data-project="${id}"]:not([data-audio="none"])`,
        { timeout: 60000 },
      );
      await page.waitForSelector('[data-testid="job-status"]', {
        state: "detached",
        timeout: 60000,
      });
    };
    await open(loopVersion);
    assert.equal(await pressed("loop-toggle"), "true");
    await page.locator(".player-meta").click();
    await page.keyboard.press("l");
    assert.equal(
      await pressed("loop-toggle"),
      "false",
      "L turns it off for 循环片段 pieces",
    );
    await open(endingWork);
    assert.equal(
      await pressed("loop-toggle"),
      "true",
      "the choice made on a 完整结尾 piece is still there",
    );
    await open(loopWork);
    assert.equal(
      await pressed("loop-toggle"),
      "false",
      "and so is the one for 循环片段",
    );

    /* UX-02 on a narrow window: the panel is a card; while edits are pending its buttons stick to the page */
    await page.setViewportSize({ width: 390, height: 780 });
    await $("inspector-toggle").waitFor();
    if ((await $("inspector-toggle").getAttribute("aria-expanded")) === "false")
      await $("inspector-toggle").click();
    await $("inspector-instrument").selectOption("guzheng");
    await $("inspector-instrument").scrollIntoViewIfNeeded();
    assert.equal(
      await reachable("apply-draft"),
      true,
      "apply-draft at 390×780 with the top of the panel in view",
    );
    assert.equal(await reachable("reset-draft"), true);
    assert.deepEqual(
      await page.evaluate(layoutProblems),
      [],
      "the sticky footer on a phone",
    );
    await $("reset-draft").click();
    assert.equal(await $("apply-draft").isDisabled(), true);
    return { works: (await records(page)).length };
  } finally {
    await context.close();
  }
}

/* ---------------- the run ---------------- */

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error(
      `${path.relative(ROOT, DIST) || DIST}/index.html is missing. Run \`npm run build:web\` first.`,
    );
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "muse-web-smoke-"));
  const server = await startServer();
  const { browser, executable } = await launchBrowser();
  const started = Date.now();
  const report = { executable, origin: server.origin, steps: [], ok: false };
  const sink = {
    console: [],
    pageErrors: [],
    failed: [],
    requests: [],
    csp: [],
  };
  let step = "start";
  let stepStarted = Date.now();
  const pass = (name, detail) => {
    const ms = Date.now() - stepStarted;
    stepStarted = Date.now();
    report.steps.push({
      name,
      ms,
      ...(detail === undefined ? {} : { detail }),
    });
    console.log(
      `ok   ${name}  (${(ms / 1000).toFixed(1)} s)${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`,
    );
  };
  const watch = (page) => {
    page.on("console", (message) => {
      if (message.type() === "error")
        sink.console.push({
          text: message.text(),
          url: message.location()?.url,
        });
    });
    page.on("pageerror", (error) =>
      sink.pageErrors.push(String(error?.stack || error)),
    );
    page.on("requestfailed", (request) =>
      sink.failed.push({
        url: request.url(),
        error: request.failure()?.errorText,
      }),
    );
    page.on("request", (request) => sink.requests.push(request.url()));
  };

  try {
    const context = await browser.newContext({
      viewport: { width: FRAME.width + 40, height: FRAME.height + 40 },
      acceptDownloads: true,
      locale: "zh-CN",
    });
    await context.addInitScript(probes);
    const page = await context.newPage();
    watch(page);

    let frame;
    const open = async () => {
      const handle = await page.waitForSelector("iframe#app");
      frame = await handle.contentFrame();
      await frame.waitForSelector('[data-testid="nav-studio"]', {
        timeout: 30000,
      });
    };
    const $ = (id) => frame.locator(`[data-testid="${id}"]`);
    const card = () => $("player-card");
    const idle = () =>
      frame.waitForSelector('[data-testid="job-status"]', {
        state: "detached",
        timeout: 120000,
      });
    const revisionLoaded = async (revision) => {
      await frame.waitForSelector(
        `[data-testid="player-card"][data-revision="${revision}"][data-audio="stems"]`,
        { timeout: 120000 },
      );
      await idle();
      await frame.waitForSelector(
        '[data-testid="save-state"][data-state="saved"]',
        { timeout: 15000 },
      );
      assert.equal(
        await card().getAttribute("data-render-path"),
        "worker",
        "composed in the render worker, not on the page",
      );
    };
    const download = async (trigger, name) => {
      const [file] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        trigger(),
      ]);
      const target = path.join(downloads, name);
      await file.saveAs(target);
      return {
        suggested: file.suggestedFilename(),
        bytes: fs.readFileSync(target),
      };
    };
    const byRevision = async (revision) =>
      (await records(frame)).find((record) => record.revision === revision);
    const pressed = (id) => $(id).getAttribute("aria-pressed");
    const pause = async () => {
      if ((await pressed("play-button")) === "true")
        await $("play-button").click();
    };
    const toasts = () =>
      frame.locator('[data-testid="toast"] > span').allInnerTexts();
    const clearToasts = async () => {
      await frame.evaluate(() => {
        for (const button of document.querySelectorAll(
          '[data-testid="toast-close"]',
        ))
          button.click();
      });
      await frame.waitForSelector('[data-testid="toast"]', {
        state: "detached",
        timeout: 5000,
      });
    };

    /* 1 — load inside the frame; web build: local only, the rest says where it is */
    step = "load";
    await page.goto(`${server.origin}${PARENT_PATH}`);
    await open();
    assert.equal(frame.url(), `${server.origin}${APP_PATH}`);
    assert.equal(
      await frame.evaluate(() => window.self !== window.top),
      true,
      "runs inside an iframe",
    );
    assert.equal(
      await frame.evaluate(() => typeof window.museDesktop),
      "undefined",
    );
    const engines = await $("composer-engine")
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => ({
          value: option.value,
          disabled: option.disabled,
          text: option.textContent,
        })),
      );
    assert.equal(engines.length, 5);
    assert.deepEqual(
      engines
        .filter((option) => !option.disabled)
        .map((option) => option.value),
      ["local"],
    );
    assert.ok(
      engines.slice(1).every((option) => option.text.includes("桌面版可用")),
      JSON.stringify(engines),
    );
    const brains = await $("composer-brain")
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => ({
          value: option.value,
          disabled: option.disabled,
          text: option.textContent,
        })),
      );
    assert.deepEqual(
      brains.map((option) => [option.value, option.disabled]),
      [
        ["rules", false],
        ["llm", true],
      ],
    );
    assert.ok(brains[1].text.includes("桌面版可用"));
    assert.equal(await $("desktop-link").getAttribute("target"), "_top");
    assert.match(await $("desktop-link").getAttribute("href"), /^https:\/\//);
    assert.equal(
      await $("style-chip-auto").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(
      await frame.locator('[data-testid^="style-chip-"]').count(),
      23,
    );
    assert.deepEqual(await frame.evaluate(layoutProblems), []);
    pass("loads inside the iframe as the web build", {
      engines: engines.length,
    });

    /* 1b — settings on the web: no forms, a way to the desktop app */
    step = "web settings";
    await $("settings-button").click();
    await $("settings-modal").waitFor();
    for (const tab of ["music", "llm"]) {
      await $(`settings-tab-${tab}`).click();
      await $("desktop-only").waitFor();
      assert.equal(await $("desktop-download").getAttribute("target"), "_top");
      assert.equal(
        await frame.locator('input[type="password"]').count(),
        0,
        "no secret fields on the web",
      );
    }
    await $("settings-tab-about").click();
    assert.match(await $("about-version").innerText(), /网页版/);
    await page.keyboard.press("Escape");
    await $("settings-modal").waitFor({ state: "detached" });
    pass("settings explain the desktop-only features instead of dead ends");

    /* 2 — describe → generate with the offline producer */
    step = "generate";
    await $("composer-input").fill("雨夜咖啡馆，慵懒的钢琴和轻轻的鼓点");
    await $("composer-duration").selectOption("15");
    const preview = await until(
      () => $("plan-preview").innerText(),
      (text) => text.startsWith("将创作：") && text.includes("设定 15 秒"),
      "plan preview",
    );
    // UX-04: a loop is fitted to whole bars; 15 s at 80 BPM is 18 s, and the line says so before anything is made
    assert.match(
      preview,
      /^将创作：慵懒松弛 · 80 BPM · .* · 18 秒（设定 15 秒） · 循环片段$/,
    );
    // Three clicks before the interface can repaint: one job, one work.
    await $("send-button").evaluate((button) => {
      button.click();
      button.click();
      button.click();
    });
    await revisionLoaded(1);
    const first = await byRevision(1);
    assert.ok(first, "revision 1 is in IndexedDB");
    assert.equal(first.provider, "local");
    assert.equal(first.config.engine, 2);
    assert.equal(first.config.mood, "chill");
    assert.equal(first.config.duration, 15);
    assert.equal(first.chat.length, 2);
    const duration1 = Number(await card().getAttribute("data-duration"));
    assert.ok(duration1 > 5 && duration1 < 40, `duration ${duration1}`);
    assert.equal(
      await frame.locator('[data-testid$="-fader"]').count(),
      4,
      "four stems",
    );
    assert.ok(
      (await frame.locator('[data-testid="section-band"]').count()) >= 1,
      "section bands",
    );
    assert.ok(
      (await $("chord-strip").locator("span").count()) >= 2,
      "chord strip",
    );
    assert.equal(await $("work-version").innerText(), "v1");
    assert.match(
      await $("work-meta").innerText(),
      /^慵懒松弛 · 80 BPM · .* · 循环片段/,
    );
    // UX-04: header, clock, footnote and reply agree with the audio (v0.3.0: "15 秒" everywhere, player 0:18)
    assert.equal(duration1, 18);
    assert.equal(
      (await $("fit-notice").innerText()).trim(),
      "设定 15 秒；循环片段按整小节对齐，实际是 18 秒",
    );
    assert.match(await $("time-display").innerText(), /\/ 0:18$/);
    const said1 = await frame
      .locator('[data-testid="thread-turn"][data-role="agent"] .turn-text')
      .first()
      .innerText();
    assert.match(
      said1,
      /18 秒，循环片段。$/,
      "the producer names the structure as the rest of the interface does",
    );
    assert.doesNotMatch(said1, /15 秒/);
    const chips1 = await frame
      .locator(
        '[data-testid="thread-turn"][data-role="agent"] .turn-reasons li',
      )
      .allInnerTexts();
    assert.ok(chips1.includes("按你的设定：15 秒"), JSON.stringify(chips1));
    assert.ok(
      chips1.includes("循环片段按整小节对齐：实际 18 秒（设定 15 秒）"),
      JSON.stringify(chips1),
    );
    assert.equal(
      await $("composer-input").inputValue(),
      "",
      "the sent text left the composer",
    );
    assert.equal(await frame.locator('[data-testid="thread-turn"]').count(), 2);
    // v0.2 left the result below the fold with nothing focused (APP-07).
    const landing = await frame.evaluate(() => {
      const node = document.querySelector('[data-testid="play-button"]');
      const box = node.getBoundingClientRect();
      return {
        focused: document.activeElement === node,
        visible: box.top >= 0 && box.bottom <= innerHeight,
      };
    });
    assert.deepEqual(landing, { focused: true, visible: true });
    await until(
      () => pressed("play-button"),
      (value) => value === "true",
      "plays after the click that started the job",
    );
    assert.equal(
      await frame.evaluate(() => window.__persistCalls),
      1,
      "storage persistence is requested after the first save",
    );
    assert.equal(
      (await records(frame)).length,
      1,
      "the triple click made one work",
    );
    pass("describe → generate → stems loaded, saved, in view and playing", {
      seconds: duration1,
      seed: first.config.seed,
      title: first.title,
    });

    /* 3 — play / pause moves time */
    step = "transport";
    const position = async () =>
      Number(await $("waveform").getAttribute("aria-valuenow"));
    await until(position, (value) => value >= 2, "playhead advances", 15000);
    await $("play-button").click();
    assert.equal(await pressed("play-button"), "false");
    const paused = await $("time-display").innerText();
    assert.ok(
      !paused.startsWith("0:00"),
      `time moved while playing: ${paused}`,
    );
    const held = await position();
    await $("restart-button").click();
    await until(position, (value) => value === 0, "back to the start");
    await $("waveform").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await position(), 5, "arrow keys seek by five seconds");
    await page.keyboard.press("Home");
    assert.equal(await position(), 0);
    assert.equal(
      await pressed("play-button"),
      "false",
      "seeking does not start playback",
    );
    // 循环试听: playback wraps at the end and keeps going; without it, it stops there.
    // UX-09: this is a 循环片段, so the audition loop is already on (v0.3.0: off, and the piece stopped at its end).
    assert.equal(await pressed("loop-toggle"), "true");
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+ArrowLeft");
    await $("play-button").click();
    await until(
      position,
      (value) => value <= 3,
      "the audition loop wraps to the start",
      10000,
    );
    assert.equal(
      await pressed("play-button"),
      "true",
      "still playing after the wrap",
    );
    await $("loop-toggle").click();
    await $("waveform").focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+ArrowLeft");
    await until(
      () => pressed("play-button"),
      (value) => value === "false",
      "without the loop, playback stops at the end",
      10000,
    );
    await $("restart-button").click();
    pass("play, pause, seek and the audition loop move and hold the playhead", {
      paused,
      held,
    });

    /* 3b — keyboard: real shortcuts, and none of them while typing */
    step = "shortcuts";
    await $("work-meta").click();
    await page.keyboard.press("l");
    assert.equal(await pressed("loop-toggle"), "true");
    await page.keyboard.press("l");
    assert.equal(await pressed("loop-toggle"), "false");
    await page.keyboard.press("Space");
    await until(
      () => pressed("play-button"),
      (value) => value === "true",
      "Space plays",
    );
    await page.keyboard.press("Space");
    await until(
      () => pressed("play-button"),
      (value) => value === "false",
      "Space pauses",
    );
    await $("composer-input").click();
    await page.keyboard.type("l l");
    assert.equal(await $("composer-input").inputValue(), "l l");
    assert.equal(
      await pressed("loop-toggle"),
      "false",
      "typing is not a shortcut",
    );
    assert.equal(await pressed("play-button"), "false");
    await $("composer-input").fill("");
    await page.keyboard.press("Control+e");
    await $("export-modal").waitFor();
    assert.equal(
      await frame.locator(".app-body").evaluate((node) => node.inert),
      true,
      "the page behind a modal is inert",
    );
    await page.keyboard.press("Escape");
    await $("export-modal").waitFor({ state: "detached" });
    pass("keyboard shortcuts");

    /* 4 — refine by message: revision 2, drums muted, same seed */
    step = "refine";
    await $("composer-input").fill("慢一点，不要鼓");
    await $("send-button").click();
    await revisionLoaded(2);
    await pause();
    const second = await byRevision(2);
    assert.equal(second.parentId, first.id);
    assert.equal(second.config.seed, first.config.seed, "same seed");
    assert.ok(
      second.config.bpm < first.config.bpm,
      `${second.config.bpm} < ${first.config.bpm}`,
    );
    assert.equal(second.config.volumes.drums, 0);
    assert.equal(second.title, first.title);
    assert.equal(await pressed("mixer-drums-mute"), "true");
    assert.equal(await $("mixer-drums-fader").inputValue(), "0");
    assert.equal(await frame.locator('[data-testid="thread-turn"]').count(), 4);
    assert.equal((await records(frame)).length, 2, "the first version is kept");
    // A message that asks for nothing audible: an answer, no new version.
    await $("composer-input").fill("今天天气怎么样");
    await $("composer-input").press("Enter");
    await until(
      () => frame.locator('[data-testid="thread-turn"]').count(),
      (count) => count === 6,
      "the producer answers",
    );
    await idle();
    assert.equal((await records(frame)).length, 2);
    assert.equal(await card().getAttribute("data-revision"), "2");
    assert.ok(
      (await frame.locator('[data-testid="suggestion-chip"]').count()) >= 3,
      "suggestions to try next",
    );
    pass(
      "refinement by message → v2, drums off, same seed; an idle message changes nothing",
      { bpm: [first.config.bpm, second.config.bpm] },
    );

    /* 5 — inspector edit survives typing, then apply → revision 3 */
    step = "inspector";
    assert.equal(await $("apply-draft").isDisabled(), true);
    await $("inspector-instrument").selectOption("guzheng");
    await $("changed-instrument").waitFor();
    assert.equal(await $("apply-draft").isDisabled(), false);
    assert.match(await $("apply-draft").innerText(), /1 项/);
    // v0.2 reset the whole inspector on any keystroke in the description.
    await $("composer-input").pressSequentially("复古电子 150 BPM", {
      delay: 5,
    });
    assert.equal(await $("inspector-instrument").inputValue(), "guzheng");
    assert.equal(await $("mixer-drums-fader").inputValue(), "0");
    await $("composer-input").fill("");
    await $("apply-draft").click();
    await revisionLoaded(3);
    await pause();
    const third = await byRevision(3);
    assert.equal(third.config.instrument, "guzheng");
    assert.equal(third.config.seed, first.config.seed, "apply keeps the seed");
    assert.equal(third.config.bpm, second.config.bpm);
    assert.equal(third.parentId, second.id);
    assert.equal(await $("apply-draft").isDisabled(), true);
    pass("inspector change + apply → v3 with the same seed", {
      instrument: third.config.instrument,
    });

    /* 5b — a 120 s render: the page stays responsive, the job shows everywhere, cancel writes nothing */
    step = "long render and cancel";
    await $("inspector-duration").selectOption("120");
    const renderFrom = await frame.evaluate(() => performance.now());
    await $("apply-draft").click();
    await frame.waitForSelector(
      '[data-testid="job-status"][data-stage="rendering"]',
      { timeout: 15000 },
    );
    assert.equal(
      await $("send-button").isDisabled(),
      true,
      "busy while a job runs",
    );
    await $("nav-library").click();
    await $("library-page").waitFor();
    assert.equal(
      await $("job-status").count(),
      1,
      "the job is shown on the library page",
    );
    assert.equal(
      await frame.locator('[data-testid="library-open"]').first().isDisabled(),
      true,
      "works cannot be switched during a job",
    );
    await $("nav-inspiration").click();
    await $("inspiration-page").waitFor();
    assert.equal(
      await $("job-status").count(),
      1,
      "and on the inspiration page",
    );
    await $("nav-studio").click();
    // let the worker do most of the two minutes of audio, then cancel
    await until(
      () => $("job-progress").getAttribute("aria-valuenow"),
      (value) => Number(value) >= 60,
      "the render makes progress",
      90000,
    );
    await $("job-cancel").click();
    await idle();
    const longest = await frame.evaluate(
      (from) =>
        Math.max(
          0,
          ...window.__longTasks
            .filter((task) => task.start >= from)
            .map((task) => task.duration),
        ),
      renderFrom,
    );
    assert.ok(
      longest < 200,
      `longest main-thread task while rendering: ${longest} ms`,
    );
    const cancelToast = await toasts();
    assert.ok(
      cancelToast.includes("已取消本地生成"),
      JSON.stringify(cancelToast),
    );
    assert.equal(await card().getAttribute("data-revision"), "3");
    assert.equal(await card().getAttribute("data-audio"), "stems");
    assert.equal(
      (await records(frame)).length,
      3,
      "a cancelled job writes nothing",
    );
    assert.equal(
      await $("inspector-duration").inputValue(),
      "120",
      "the draft is still there to apply again",
    );
    await $("reset-draft").click();
    assert.equal(await $("apply-draft").isDisabled(), true);
    pass(
      "a long render keeps the page responsive, is shown on every page and can be cancelled",
      { longestTaskMs: Math.round(longest) },
    );

    /* 6 — fader, mute, solo */
    step = "mixer";
    const fader = $("mixer-melody-fader");
    await fader.focus();
    await page.keyboard.press("Home");
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
    assert.equal(await fader.inputValue(), "30");
    await until(
      () => byRevision(3),
      (record) => Math.abs(record.config.volumes.melody - 0.3) < 1e-6,
      "fader saved",
    );
    const bassBefore = (await byRevision(3)).config.volumes.bass;
    await $("mixer-bass-mute").click();
    assert.equal(await pressed("mixer-bass-mute"), "true");
    await until(
      () => byRevision(3),
      (record) => record.config.volumes.bass === 0,
      "mute saved",
    );
    await $("mixer-bass-mute").click();
    await until(
      () => byRevision(3),
      (record) => record.config.volumes.bass === bassBefore,
      "unmute returns to the old level",
    );
    const beforeSolo = await byRevision(3);
    await $("mixer-melody-solo").click();
    assert.equal(await pressed("mixer-melody-solo"), "true");
    // Playing with a stem soloed, then a fader move: playback goes on (v0.2 restarted the audio).
    await $("play-button").click();
    await until(
      () => pressed("play-button"),
      (value) => value === "true",
      "plays soloed",
    );
    await until(position, (value) => value >= 1, "the playhead moves");
    const startsBefore = await frame.evaluate(() => window.__sourceStarts);
    assert.ok(startsBefore >= 4, "four stems are playing");
    await $("mixer-chords-fader").focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await $("mixer-drums-mute").click();
    await $("mixer-drums-mute").click();
    await $("mixer-melody-solo").click();
    await $("mixer-melody-solo").click();
    assert.equal(
      await pressed("play-button"),
      "true",
      "mixing does not stop playback",
    );
    // v0.2 re-mixed offline and restarted the audio on every fader event (APP-08).
    assert.equal(
      await frame.evaluate(() => window.__sourceStarts),
      startsBefore,
      "faders, mute and solo are gain changes: nothing is restarted",
    );
    await pause();
    await until(
      () =>
        frame.locator('[data-testid="save-state"]').getAttribute("data-state"),
      (state) => state === "saved",
      "the mix is saved",
    );
    assert.deepEqual(
      (await byRevision(3)).config.volumes,
      beforeSolo.config.volumes,
      "solo is not part of the work",
    );
    assert.equal(
      (await records(frame)).length,
      3,
      "mixing creates no versions",
    );
    assert.equal(await card().getAttribute("data-revision"), "3");
    pass("fader, mute and solo", { melody: 0.3, bass: bassBefore });

    /* 7 — export with solo still on: full mix WAV (×1 and ×2), a stem, the project JSON */
    step = "export";
    await $("export-button").click();
    await $("export-modal").waitFor();
    assert.deepEqual(
      await frame
        .locator('[data-testid^="export-option-"]')
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            node.getAttribute("data-testid").slice("export-option-".length),
          ),
        ),
      [
        "mix",
        "stem-melody",
        "stem-chords",
        "stem-bass",
        "stem-drums",
        "project",
      ],
    );
    const duration3 = Number(await card().getAttribute("data-duration"));
    const mix = await download(() => $("export-option-mix").click(), "mix.wav");
    const mixInfo = wavInfo(mix.bytes);
    assert.equal(mixInfo.riff, "RIFF");
    assert.equal(mixInfo.wave, "WAVE");
    assert.equal(mixInfo.format, 1);
    assert.equal(mixInfo.channels, 2);
    assert.equal(mixInfo.sampleRate, 48000);
    assert.equal(mixInfo.bits, 16);
    assert.equal(mixInfo.fileBytes, 44 + mixInfo.dataBytes);
    assert.ok(
      Math.abs(mixInfo.seconds - duration3) < 0.01,
      `${mixInfo.seconds} s vs ${duration3} s`,
    );
    assert.ok(mixInfo.rms > 0.01, `mix rms ${mixInfo.rms}`);
    assert.equal(mix.suggested, `${third.title} v3.wav`);
    const stem = await download(
      () => $("export-option-stem-melody").click(),
      "melody.wav",
    );
    const stemInfo = wavInfo(stem.bytes);
    assert.equal(stemInfo.sampleRate, 48000);
    assert.equal(stemInfo.dataBytes, mixInfo.dataBytes);
    assert.equal(stem.suggested, `${third.title} v3-旋律.wav`);
    // Melody is soloed in the player: the exported mix must still be the full mix.
    assert.ok(
      !mix.bytes.equals(stem.bytes),
      "full mix differs from the soloed stem",
    );
    assert.ok(
      mixInfo.rms > stemInfo.rms * 1.1,
      `mix rms ${mixInfo.rms} vs melody ${stemInfo.rms}`,
    );
    // 循环次数: the loop twice, sample for sample.
    await $("export-repeats-2").click();
    const twice = await download(
      () => $("export-option-mix").click(),
      "mix-x2.wav",
    );
    assert.equal(twice.suggested, `${third.title} v3-循环x2.wav`);
    assert.equal(wavInfo(twice.bytes).dataBytes, mixInfo.dataBytes * 2);
    assert.ok(
      twice.bytes
        .subarray(44, 44 + mixInfo.dataBytes)
        .equals(mix.bytes.subarray(44)),
      "first pass",
    );
    assert.ok(
      twice.bytes
        .subarray(44 + mixInfo.dataBytes)
        .equals(mix.bytes.subarray(44)),
      "second pass",
    );
    const json = await download(
      () => $("export-option-project").click(),
      "project.json",
    );
    const projectFile = path.join(downloads, "project.json");
    const parsed = JSON.parse(json.bytes.toString("utf8"));
    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.audioBlob, undefined);
    assert.equal(parsed.revision, 3);
    assert.equal(parsed.config.seed, first.config.seed);
    assert.equal(parsed.config.volumes.melody, 0.3);
    assert.equal(parsed.chat.length, 8);
    assert.equal(json.suggested, `${third.title} v3.json`);
    await page.keyboard.press("Escape");
    await $("export-modal").waitFor({ state: "detached" });
    pass(
      "export: 48 kHz WAV of the full mix, the loop twice, a stem, the project JSON",
      {
        seconds: mixInfo.seconds,
        megabytes: +(mixInfo.fileBytes / 1048576).toFixed(2),
        mixRms: +mixInfo.rms.toFixed(4),
        stemRms: +stemInfo.rms.toFixed(4),
      },
    );

    /* 7b — the interface fails to render: the work can still be exported, and the app comes back */
    step = "error boundary";
    assert.deepEqual(sink.console, [], "console errors before the forced one");
    assert.deepEqual(sink.pageErrors, [], "page errors before the forced one");
    await frame.evaluate(() => {
      window.__getHours = Date.prototype.getHours;
      // the thread shows the time of each turn: make its next render throw
      Date.prototype.getHours = function () {
        throw new Error("web-smoke: forced render error");
      };
    });
    // The thread renders again as soon as something in it changes: typing may
    // already be enough, a new turn certainly is.
    await $("composer-input")
      .fill("你好", { timeout: 5000 })
      .catch(() => {});
    if (!(await $("error-boundary").count()))
      await $("composer-input")
        .press("Enter", { timeout: 5000 })
        .catch(() => {});
    await $("error-boundary").waitFor({ timeout: 30000 });
    assert.match(await $("error-boundary").innerText(), /界面出了点问题/);
    const rescued = await download(
      () => $("crash-export").click(),
      "rescued.wav",
    );
    assert.ok(rescued.bytes.equals(mix.bytes), "the same full mix as before");
    await frame.evaluate(() => {
      Date.prototype.getHours = window.__getHours;
    });
    await $("crash-retry").click();
    await $("studio-work").waitFor();
    await idle();
    assert.equal(await card().getAttribute("data-revision"), "3");
    assert.equal(await $("play-button").isEnabled(), true);
    // What React and the boundary logged about the forced error is expected; nothing else may follow.
    const logged = sink.console.splice(0);
    assert.ok(
      logged.some((entry) => entry.text.includes("render failed")),
      "the boundary logs the failure",
    );
    assert.ok(
      sink.pageErrors
        .splice(0)
        .every((text) => text.includes("forced render error")),
    );
    await clearToasts();
    pass(
      "a render error shows the recovery panel; export works; 回到界面 recovers",
    );

    /* 8 — reload restores the session and the library */
    step = "reload";
    await $("composer-input").fill("再明亮一点");
    // the composer text is remembered half a second after typing stops
    await until(
      () =>
        frame.evaluate(
          () =>
            JSON.parse(localStorage.getItem("muse-bgm:session") || "{}")
              .composerText,
        ),
      (text) => text === "再明亮一点",
      "the session is written",
    );
    await page.reload();
    await open();
    await frame.waitForSelector(
      `[data-testid="player-card"][data-project="${third.id}"][data-audio="stems"]`,
      { timeout: 120000 },
    );
    await idle();
    assert.equal(
      await pressed("play-button"),
      "false",
      "restored without playing",
    );
    assert.equal(await $("composer-input").inputValue(), "再明亮一点");
    assert.equal(await $("mixer-melody-fader").inputValue(), "30");
    assert.equal(
      await pressed("mixer-melody-solo"),
      "false",
      "solo is not part of a work",
    );
    await $("nav-library").click();
    assert.equal(
      await frame.locator('[data-testid="library-card"]').count(),
      3,
    );
    assert.match(await $("storage-note").innerText(), /只保存在这个浏览器里/);
    pass("reload restores the last work, the composer text and the library");

    /* 8b — import the exported project: a new work, rendered again by the engine */
    step = "import";
    await $("import-input").setInputFiles(projectFile);
    await frame.waitForSelector(
      `[data-testid="player-card"][data-audio="stems"]:not([data-project="${third.id}"])`,
      { timeout: 120000 },
    );
    await idle();
    const imported = (await records(frame)).find(
      (record) => ![first.id, second.id, third.id].includes(record.id),
    );
    assert.ok(imported, "the import is a new record");
    assert.deepEqual(
      imported.config,
      parsed.config,
      "the recipe survives the round trip",
    );
    assert.equal(imported.revision, 3);
    assert.equal(imported.config.volumes.melody, 0.3);
    assert.equal(await card().getAttribute("data-project"), imported.id);
    assert.equal(
      await frame.locator('[data-testid="thread-turn"]').count(),
      8,
      "the conversation travels with the file",
    );
    pass("import of the exported project JSON");

    /* 8c — library: rename, favourite, search, sort */
    step = "library";
    await $("work-title").fill("导入的那一首");
    await page.keyboard.press("Enter");
    await until(
      () => records(frame),
      (list) =>
        list.find((record) => record.id === imported.id)?.title ===
        "导入的那一首",
      "the new title is saved",
    );
    await $("favourite-button").click();
    await until(
      () => records(frame),
      (list) =>
        list.find((record) => record.id === imported.id)?.favorite === true,
      "favourite is saved",
    );
    await $("nav-library").click();
    const cards = frame.locator('[data-testid="library-card"]');
    assert.equal(await cards.count(), 4);
    await $("library-search").fill("导入");
    assert.equal(await cards.count(), 1);
    assert.match(await $("library-count").innerText(), /1\s*\/\s*4/);
    await $("library-search").fill("不存在的名字");
    await $("library-no-match").waitFor();
    await $("library-search").fill("");
    await $("library-favourites").click();
    assert.equal(await cards.count(), 1);
    await $("library-favourites").click();
    await $("library-sort-title").click();
    const sorted = await frame
      .locator('[data-testid="library-open"]')
      .allInnerTexts();
    assert.deepEqual(
      sorted,
      [...sorted].sort((a, b) => a.localeCompare(b, "zh-CN")),
    );
    await $("library-sort-recent").click();
    assert.deepEqual(await frame.evaluate(layoutProblems), []);
    // Quick play, then another work while the first is playing: one plays, then none, never two.
    await frame
      .locator(
        `[data-testid="library-card"][data-project="${imported.id}"] [data-testid="library-play"]`,
      )
      .click();
    await until(
      () => pressed("play-button"),
      (value) => value === "true",
      "quick play opens the studio and plays",
    );
    await $("nav-library").click();
    assert.equal(
      await pressed("mini-play"),
      "true",
      "it keeps playing while the library is browsed",
    );
    await frame
      .locator(
        `[data-testid="library-card"][data-project="${third.id}"] [data-testid="library-open"]`,
      )
      .click();
    await frame.waitForSelector(
      `[data-testid="player-card"][data-project="${third.id}"][data-audio="stems"]`,
      { timeout: 120000 },
    );
    await idle();
    assert.equal(
      await pressed("play-button"),
      "false",
      "a work that is merely opened does not start playing",
    );
    assert.equal(
      await $("mixer-melody-fader").inputValue(),
      "30",
      "its own mix is back",
    );
    await $("nav-library").click();
    pass(
      "library: rename, favourite, search, sort; opening another work stops the one playing",
    );

    /* 9 — delete + undo, then a real delete */
    step = "delete";
    const cardOf = (id) =>
      frame.locator(`[data-testid="library-card"][data-project="${id}"]`);
    await cardOf(third.id).locator('[data-testid="library-delete"]').click();
    assert.equal(await cards.count(), 3);
    assert.equal(
      (await records(frame)).length,
      4,
      "nothing is deleted during the undo window",
    );
    await $("toast-action").click();
    assert.equal(await cards.count(), 4);
    await cardOf(first.id).locator('[data-testid="library-delete"]').click();
    assert.equal(await cards.count(), 3);
    await until(
      () => records(frame),
      (list) => list.length === 3,
      "deleted after the undo window",
      15000,
    );
    assert.ok(!(await records(frame)).some((record) => record.id === first.id));
    pass("delete with undo, then delete for real");

    /* 9b — delete and leave at once: the deletion is still carried out */
    step = "delete then reload";
    await cardOf(second.id).locator('[data-testid="library-delete"]').click();
    assert.equal(
      (await records(frame)).length,
      3,
      "still stored inside the undo window",
    );
    await page.reload();
    await open();
    await $("nav-library").click();
    await until(
      () => frame.locator('[data-testid="library-card"]').count(),
      (count) => count === 2,
      "the deleted work does not come back",
    );
    assert.ok(
      !(await records(frame)).some((record) => record.id === second.id),
      "and it is gone from storage",
    );
    pass("a delete followed by leaving the page is still a delete");

    /* 10 — a corrupt record is listed separately and does not hide the rest */
    step = "damaged";
    await putRawRecord(frame, {
      id: "corrupt-1",
      title: "坏掉的记录",
      config: { mood: "polka", bpm: "fast" },
    });
    // A paid cloud work written by a newer build (a style this one does not know), audio intact.
    const paidBytes = 3000;
    await frame.evaluate(
      ({ record, size }) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("muse-bgm");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const tx = database.transaction("projects", "readwrite");
            const bytes = new Uint8Array(size);
            bytes.set([0x49, 0x44, 0x33, 4]);
            tx.objectStore("projects").put({
              ...record,
              audioBlob: new Blob([bytes], { type: "audio/mpeg" }),
            });
            tx.oncomplete = () => {
              database.close();
              resolve();
            };
            tx.onabort = () => reject(tx.error);
          };
        }),
      {
        size: paidBytes,
        record: {
          ...first,
          id: "paid-future",
          title: "付费作品",
          provider: "tencent",
          chat: undefined,
          cloud: { prompt: "p" },
          config: { ...first.config, mood: "hyperpop-2030" },
        },
      },
    );
    await page.reload();
    await open();
    await $("nav-library").click();
    await $("damaged-section").waitFor();
    const damagedRow = (id) =>
      frame.locator(`[data-testid="damaged-record"][data-record="${id}"]`);
    assert.equal(
      await frame.locator('[data-testid="damaged-record"]').count(),
      2,
    );
    assert.ok(
      (
        await damagedRow("corrupt-1")
          .locator('[data-testid="damaged-reason"]')
          .innerText()
      ).trim().length > 0,
    );
    assert.equal(
      await frame.locator('[data-testid="library-card"]').count(),
      2,
      "good works are still listed",
    );
    const raw = await download(
      () =>
        damagedRow("corrupt-1")
          .locator('[data-testid="damaged-export"]')
          .click(),
      "damaged.json",
    );
    assert.match(raw.bytes.toString("utf8"), /polka/);
    assert.equal(
      await damagedRow("corrupt-1")
        .locator('[data-testid="damaged-export-audio"]')
        .count(),
      0,
      "no audio in it: no audio export",
    );
    // v0.3.0 offered only the JSON (which never holds audio) and advised "export, then delete".
    assert.match(
      await damagedRow("paid-future").innerText(),
      /含付费生成的音频/,
    );
    assert.match(await frame.locator(".damaged-lede").innerText(), /不含音频/);
    const paidJson = await download(
      () =>
        damagedRow("paid-future")
          .locator('[data-testid="damaged-export"]')
          .click(),
      "paid.json",
    );
    assert.ok(!/audioBlob/.test(paidJson.bytes.toString("utf8")));
    assert.ok(
      (await toasts()).some((text) => text.includes("不含音频")),
      JSON.stringify(await toasts()),
    );
    const paidAudio = await download(
      () =>
        damagedRow("paid-future")
          .locator('[data-testid="damaged-export-audio"]')
          .click(),
      "paid.mp3",
    );
    assert.equal(paidAudio.suggested, "付费作品-原始音频.mp3");
    assert.equal(
      paidAudio.bytes.length,
      paidBytes,
      "every byte of the paid audio",
    );
    assert.equal(paidAudio.bytes.toString("latin1", 0, 3), "ID3");
    await damagedRow("paid-future")
      .locator('[data-testid="damaged-delete"]')
      .click();
    assert.match(
      await damagedRow("paid-future")
        .locator('[data-testid="damaged-confirm-note"]')
        .innerText(),
      /付费生成的音频将无法找回/,
    );
    await damagedRow("paid-future")
      .locator('[data-testid="damaged-delete-confirm"]')
      .click();
    await damagedRow("paid-future").waitFor({ state: "detached" });
    await damagedRow("corrupt-1")
      .locator('[data-testid="damaged-delete"]')
      .click();
    await damagedRow("corrupt-1")
      .locator('[data-testid="damaged-delete-confirm"]')
      .click();
    await $("damaged-section").waitFor({ state: "detached" });
    assert.ok(
      !(await records(frame)).some(
        (record) => record.id === "corrupt-1" || record.id === "paid-future",
      ),
    );
    await clearToasts();
    pass(
      "damaged records: listed, exported (JSON, and the audio of a paid one), removed",
    );

    /* 10b — inspiration → composer with a pinned style → a new piece */
    step = "inspiration";
    await $("nav-inspiration").click();
    await $("inspiration-page").waitFor();
    assert.equal(
      await frame.locator('[data-testid="inspiration-card"]').count(),
      22,
    );
    assert.ok(
      (await frame.locator('[data-testid="inspiration-prompt"]').count()) >= 15,
    );
    await frame
      .locator('[data-testid="inspiration-card"][data-style="guofeng"]')
      .click();
    await $("studio-empty").waitFor();
    assert.equal(
      await $("style-chip-guofeng").getAttribute("aria-pressed"),
      "true",
    );
    // A style card pins its style and writes nothing for the user: the style's own blurb used to be
    // put into the description and parsed as if they had typed it (19 of 22 cards came out wrong).
    // It wipes nothing either: the words still in the composer from step 8 are untouched.
    assert.equal(await $("composer-input").inputValue(), "再明亮一点");
    await $("composer-input").fill("");
    assert.match(await $("style-hint").innerText(), /已选「国风古韵」/);
    const pinnedPreview = await until(
      () => $("plan-preview").innerText(),
      (text) => text.startsWith("将创作："),
      "a preview from the pinned style alone",
    );
    assert.match(pinnedPreview, /^将创作：国风古韵 · \d+ BPM/);
    const presetBpm = Number(/(\d+) BPM/.exec(pinnedPreview)[1]);
    assert.equal(
      await $("send-button").isEnabled(),
      true,
      "a pinned style alone can be sent",
    );
    assert.equal(
      await frame.locator('[data-testid="mini-transport"]').count(),
      0,
      "the work that was loaded is left",
    );
    await $("composer-duration").selectOption("15");
    await $("composer-structure").selectOption("ending");
    await $("composer-input").focus();
    await page.keyboard.press("Control+Enter");
    await revisionLoaded(1);
    await pause();
    const fresh = (await records(frame)).find(
      (record) => record.config.mood === "guofeng",
    );
    assert.ok(fresh, "the pinned style was used");
    assert.equal(
      fresh.config.bpm,
      presetBpm,
      "the style's own tempo, not one parsed out of its blurb",
    );
    assert.equal(
      fresh.config.prompt,
      "国风古韵",
      "the stored description is the style's name",
    );
    assert.equal(fresh.chat[0].text, "「国风古韵」风格");
    assert.equal(fresh.config.duration, 15);
    assert.equal(fresh.config.loop, false, "the pinned structure was used");
    assert.equal(
      Number(await card().getAttribute("data-duration")),
      15,
      "a piece with an ending has exactly the asked length",
    );
    assert.equal(
      fresh.chat.length,
      2,
      "a new piece starts its own conversation",
    );
    await $("new-melody").click();
    await revisionLoaded(2);
    await pause();
    assert.equal(
      await frame.evaluate(() => window.__persistCalls),
      1,
      "persistence is asked for once per page load, not per save",
    );
    const varied = (await records(frame)).find(
      (record) => record.parentId === fresh.id,
    );
    assert.notEqual(
      varied.config.seed,
      fresh.config.seed,
      "换一版旋律 changes the seed",
    );
    assert.equal(varied.config.mood, "guofeng");
    pass(
      "inspiration pins a style and writes no description; Ctrl+Enter generates; 换一版旋律 makes a new version",
      { title: fresh.title },
    );

    /* 10c — a suggestion chip does not erase unsent text; versions of one piece share the thread */
    step = "chip and versions";
    const unsent = "把副歌写得更有记忆点";
    await $("composer-input").fill(unsent);
    const chip = frame.locator('[data-testid="suggestion-chip"]').first();
    const chipText = (await chip.innerText()).trim();
    await chip.click();
    await revisionLoaded(3);
    await pause();
    // v0.3.0 cleared the composer for the chip and, after a cancel, put the chip's words there.
    assert.equal(
      await $("composer-input").inputValue(),
      unsent,
      "the chip did not erase what was typed",
    );
    const turnsNow = await frame.locator('[data-testid="thread-turn"]').count();
    assert.equal(turnsNow, 6);
    assert.equal(
      (
        await frame
          .locator('[data-testid="thread-turn"][data-role="user"]')
          .last()
          .innerText()
      )
        .replace(/^你：/, "")
        .trim(),
      chipText,
    );
    assert.equal(
      await $("thread-version-note").count(),
      0,
      "the newest version needs no way back",
    );
    // Open v1 from its tag: the later conversation stays, the note says which version plays, one click returns.
    await frame.locator('button[data-testid="turn-version"]').first().click();
    await frame.waitForSelector(
      `[data-testid="player-card"][data-project="${fresh.id}"][data-audio="stems"]`,
      { timeout: 120000 },
    );
    await idle();
    assert.equal(
      await frame.locator('[data-testid="thread-turn"]').count(),
      turnsNow,
      "v0.3.0 showed only the first exchange here",
    );
    assert.match(
      await $("thread-version-note").innerText(),
      /正在听 v1[\s\S]*最新的是 v\s*3/,
    );
    assert.equal(
      await frame.locator('button[data-testid="turn-version"]').count(),
      2,
      "v2 and v3 can be opened from here",
    );
    assert.equal(await $("composer-input").inputValue(), unsent);
    await $("thread-latest").click();
    await frame.waitForSelector(
      '[data-testid="player-card"][data-revision="3"][data-audio="stems"]',
      { timeout: 120000 },
    );
    await idle();
    assert.equal(await $("thread-version-note").count(), 0);
    await $("composer-input").fill("");
    // (several pieces have a v3 by now: this one is identified by what is loaded)
    const newest = { id: await card().getAttribute("data-project") };
    assert.equal(
      (await records(frame)).find((record) => record.id === newest.id).parentId,
      varied.id,
    );
    pass(
      "a chip keeps the unsent text; an earlier version keeps the conversation and offers the way back",
      { chip: chipText },
    );

    /* 10d — a fader move inside the save delay survives the page going away */
    step = "fader flush on reload";
    const drums = $("mixer-drums-fader");
    await drums.focus();
    await page.keyboard.press("ArrowLeft");
    const settled = Number(await drums.inputValue());
    const drumsOf = async (id) =>
      Math.round(
        (await records(frame)).find((record) => record.id === id).config.volumes
          .drums * 100,
      );
    await until(
      () => drumsOf(newest.id),
      (value) => value === settled,
      "key up saves at once",
    );
    // The key goes down again and stays down: on screen one step lower, the library still one behind.
    await page.keyboard.down("ArrowLeft");
    assert.equal(Number(await drums.inputValue()), settled - 1);
    await page.reload();
    await page.keyboard.up("ArrowLeft");
    await open();
    await frame.waitForSelector(
      `[data-testid="player-card"][data-project="${newest.id}"][data-audio="stems"]`,
      { timeout: 120000 },
    );
    await idle();
    assert.equal(
      Number(await $("mixer-drums-fader").inputValue()),
      settled - 1,
      "v0.3.0 came back with the older value",
    );
    assert.equal(
      await drumsOf(newest.id),
      settled - 1,
      "and it is in the library",
    );
    assert.deepEqual(
      await frame.evaluate(
        () => JSON.parse(localStorage.getItem("muse-bgm:session")).pendingMixes,
      ),
      [],
      "nothing left owed",
    );
    pass("a fader move that was not saved yet survives a reload", {
      drums: [settled, settled - 1],
    });

    /* 10e — five quick deletes: one undo notice that later toasts cannot push out */
    step = "undo stack";
    const { chat: _chat, parentId: _parentId, ...recipe } = fresh;
    for (let index = 0; index < 5; index++)
      await putRawRecord(frame, {
        ...recipe,
        id: `del-${index}`,
        title: `del-${index}`,
        revision: 1,
        updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
      });
    await page.reload();
    await open();
    await idle();
    await $("nav-library").click();
    await $("library-page").waitFor();
    const libraryCards = frame.locator('[data-testid="library-card"]');
    const cardFor = (id) =>
      frame.locator(`[data-testid="library-card"][data-project="${id}"]`);
    const total = await libraryCards.count();
    for (let index = 0; index < 5; index++)
      await cardFor(`del-${index}`)
        .locator('[data-testid="library-delete"]')
        .click();
    assert.equal(await libraryCards.count(), total - 5);
    // v0.3.0: five toasts, the first pushed out by the cap of four — its deletion could not be undone.
    assert.equal(
      await frame.locator('[data-testid="toast-action"]').count(),
      1,
      "one undo for all five",
    );
    assert.ok(
      (await toasts()).includes("已删除 5 首作品"),
      JSON.stringify(await toasts()),
    );
    assert.equal((await $("toast-action").innerText()).trim(), "全部撤销");
    await $("toast-action").click();
    await until(
      () => libraryCards.count(),
      (count) => count === total,
      "all five are back",
    );
    await until(
      toasts,
      (list) => list.includes("已恢复 5 首作品"),
      "undo is confirmed once the records are there",
    );
    assert.equal(
      (await records(frame)).filter((record) => record.id.startsWith("del-"))
        .length,
      5,
    );
    assert.equal(
      await frame.locator('[data-testid="toast-action"]').count(),
      0,
    );
    pass("five quick deletes are undone together");

    /* 10f — two tabs of the same site: pending deletes, renames and real deletes are coordinated */
    step = "two tabs";
    const tabB = await context.newPage();
    watch(tabB);
    const b$ = (id) => tabB.locator(`[data-testid="${id}"]`);
    const bIdle = () =>
      tabB.waitForSelector('[data-testid="job-status"]', {
        state: "detached",
        timeout: 120000,
      });
    const bCard = (id) =>
      tabB.locator(`[data-testid="library-card"][data-project="${id}"]`);
    const stored = async (id) =>
      (await records(frame)).find((record) => record.id === id);
    // A delete in this tab, then the other tab starts inside the undo window: the deletion is this tab's to finish or undo.
    await cardFor("del-0").locator('[data-testid="library-delete"]').click();
    await $("toast-action").waitFor();
    await tabB.goto(`${server.origin}${APP_PATH}`);
    await tabB.waitForSelector('[data-testid="nav-studio"]', {
      timeout: 30000,
    });
    await b$("nav-library").click();
    await b$("library-page").waitFor();
    // its library is listed: whatever a starting tab finishes of old deletions has happened by now
    await bCard("del-1").waitFor();
    assert.ok(
      await stored("del-0"),
      "v0.3.0: the tab that just started deleted it at once",
    );
    await $("toast-action").click();
    await until(toasts, (list) => list.includes("已恢复"), "undo is confirmed");
    assert.ok(await stored("del-0"), "undone means it is in the library");
    await bIdle();
    // A rename here; the other tab, which listed the library before, shows it and adds a favourite: both are kept.
    await cardFor("del-1").locator('[data-testid="library-open"]').click();
    await frame.waitForSelector(
      '[data-testid="player-card"][data-project="del-1"][data-audio="stems"]',
      { timeout: 120000 },
    );
    await idle();
    await $("work-title").fill("renamed-in-A");
    await page.keyboard.press("Enter");
    await until(
      () => stored("del-1"),
      (record) => record.title === "renamed-in-A",
      "the rename is saved",
    );
    await until(
      () => bCard("del-1").locator('[data-testid="library-open"]').innerText(),
      (text) => text.trim() === "renamed-in-A",
      "the other tab hears about the rename",
    );
    await bCard("del-1").locator('[data-testid="library-favourite"]').click();
    await until(
      () => stored("del-1"),
      (record) => record.favorite === true,
      "the favourite is saved",
    );
    assert.equal(
      (await stored("del-1")).title,
      "renamed-in-A",
      "v0.3.0: the stale tab wrote its whole record and the rename was gone",
    );
    await until(
      () => pressed("favourite-button"),
      (value) => value === "true",
      "this tab hears about the favourite",
    );
    // A real delete here while the other tab has that work open: it stays deleted there too.
    await bCard("del-2").locator('[data-testid="library-open"]').click();
    await tabB.waitForSelector(
      '[data-testid="player-card"][data-project="del-2"][data-audio="stems"]',
      { timeout: 120000 },
    );
    await bIdle();
    await $("nav-library").click();
    await cardFor("del-2").locator('[data-testid="library-delete"]').click();
    await until(
      () => stored("del-2"),
      (record) => record === undefined,
      "deleted after the undo window",
      15000,
    );
    await until(
      () => tabB.locator('[data-testid="player-card"]').count(),
      (count) => count === 0,
      "the other tab lets go of the deleted work",
    );
    assert.ok(
      (await tabB.locator('[data-testid="toast"] > span').allInnerTexts()).some(
        (text) => text.includes("已在另一个窗口中删除"),
      ),
    );
    await sleep(700);
    assert.equal(
      await stored("del-2"),
      undefined,
      "v0.3.0: the next fader move in the other tab wrote it back",
    );
    await tabB.close();
    pass(
      "two tabs: a pending delete is left to its tab, a rename and a favourite both survive, a deleted work stays deleted",
    );

    /* 10g — a save that fails: the result stays, says so, is retried once on its own and can be retried by hand */
    step = "unsaved result";
    await $("new-piece").click();
    await $("studio-empty").waitFor();
    // The next two library writes fail (the first save and the automatic retry); storage is healthy afterwards.
    await frame.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.__putFailures = 2;
      IDBObjectStore.prototype.put = function (...args) {
        if (window.__putFailures > 0) {
          window.__putFailures--;
          throw new DOMException("Internal error", "UnknownError");
        }
        return put.apply(this, args);
      };
    });
    await $("composer-input").fill("安静专注的钢琴，适合阅读");
    await $("composer-duration").selectOption("15");
    await $("send-button").click();
    await frame.waitForSelector(
      '[data-testid="player-card"][data-revision="1"][data-audio="stems"]',
      { timeout: 120000 },
    );
    await idle();
    await $("unsaved-banner").waitFor();
    const unsavedId = await card().getAttribute("data-project");
    assert.equal(await $("save-state").getAttribute("data-state"), "failed");
    const failure = (await toasts()).find((text) =>
      text.startsWith("音乐已生成，但没能保存到「我的作品」"),
    );
    assert.ok(failure, JSON.stringify(await toasts()));
    assert.ok(
      !/重新启动|刷新页面/.test(failure),
      "the only copy is in this page: never told to reload",
    );
    assert.match(failure, /请先导出/);
    assert.match(
      await $("unsaved-banner").innerText(),
      /还没有保存到「我的作品」，现在只存在于当前窗口/,
    );
    assert.equal(await stored(unsavedId), undefined);
    assert.equal(await $("play-button").isEnabled(), true, "it still plays");
    assert.deepEqual(await frame.evaluate(layoutProblems), [], "banner");
    await pause();
    // The banner is on every page, and the automatic retry (which fails here too) does not take it away.
    await $("nav-library").click();
    await $("library-page").waitFor();
    assert.equal(await $("unsaved-banner").count(), 1);
    assert.ok(
      !(
        await frame
          .locator('[data-testid="library-card"]')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-project")),
          )
      ).includes(unsavedId),
      "not listed as if it were saved",
    );
    await until(
      () => frame.evaluate(() => window.__putFailures),
      (left) => left === 0,
      "the automatic retry ran",
      15000,
    );
    await sleep(300);
    assert.equal(
      await $("unsaved-banner").count(),
      1,
      "still unsaved, still said",
    );
    assert.equal(await stored(unsavedId), undefined);
    // 重试保存 by hand, now that storage works again.
    await $("retry-save").click();
    await $("unsaved-banner").waitFor({ state: "detached" });
    assert.ok(await stored(unsavedId), "the work reached the library");
    await frame
      .locator(`[data-testid="library-card"][data-project="${unsavedId}"]`)
      .waitFor();
    await $("nav-studio").click();
    assert.equal(await $("save-state").getAttribute("data-state"), "saved");
    await clearToasts();
    pass(
      "a failed save keeps the result on screen with a banner; the automatic retry and 重试保存 store it",
    );

    /* 10h — the desktop renderer (dist/) with a stand-in bridge: paid requests and paid results */
    step = "desktop renderer: paid flows";
    if (fs.existsSync(path.join(DESKTOP_DIST, "index.html")))
      pass(
        "desktop renderer with a stand-in bridge: nothing is paid for unasked, a paid result is not lost",
        await desktopRenderer(browser, server.origin),
      );
    else
      console.log(
        "skip desktop renderer: dist/index.html is missing (run `npm run build` to include the paid-flow checks)",
      );

    /* 10i — a 1366×768 window: pending edits, the mixer and chips, the audition loop, tooltips, the version tag */
    step = "review: reachable, truthful, nothing dropped";
    pass(
      "1366×768: pending edits reachable and kept, mixer and chips follow the piece, 循环试听 follows the structure, tips stay out of the way",
      await reviewWindow(browser, server.origin, watch),
    );

    /* 11 — the same build on a phone-sized screen, opened directly */
    step = "phone";
    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 780 },
      acceptDownloads: true,
      locale: "zh-CN",
      hasTouch: true,
      isMobile: true,
    });
    await phoneContext.addInitScript(probes);
    const phone = await phoneContext.newPage();
    watch(phone);
    const p$ = (id) => phone.locator(`[data-testid="${id}"]`);
    await phone.goto(`${server.origin}${APP_PATH}`);
    // a browser of its own: nothing stored yet
    await p$("studio-empty").waitFor({ timeout: 30000 });
    assert.equal(await phone.evaluate(() => window.self === window.top), true);
    assert.deepEqual(
      await phone.evaluate(layoutProblems),
      [],
      "empty composer",
    );
    await p$("style-all").tap();
    await p$("style-sheet").waitFor();
    assert.equal(
      await phone.locator('[data-testid^="style-option-"]').count(),
      23,
    );
    await p$("style-option-chiptune").tap();
    await p$("style-sheet").waitFor({ state: "detached" });
    assert.equal(
      await p$("style-chip-chiptune").getAttribute("aria-pressed"),
      "true",
    );
    await p$("composer-duration").selectOption("15");
    // a pinned style alone is enough to start from
    assert.equal(await p$("composer-input").inputValue(), "");
    assert.equal(await p$("send-button").isEnabled(), true);
    await p$("send-button").tap();
    await phone.waitForSelector(
      '[data-testid="player-card"][data-revision="1"][data-audio="stems"]',
      { timeout: 120000 },
    );
    await phone.waitForSelector('[data-testid="job-status"]', {
      state: "detached",
      timeout: 120000,
    });
    await phone.waitForSelector(
      '[data-testid="save-state"][data-state="saved"]',
      { timeout: 15000 },
    );
    const made = await records(phone);
    assert.equal(made.length, 1);
    assert.equal(made[0].config.mood, "chiptune");
    const playBox = await p$("play-button").boundingBox();
    assert.ok(
      playBox && playBox.y >= 0 && playBox.y + playBox.height <= 780,
      "the play button is on screen after generating",
    );
    assert.ok(
      playBox.width >= 40 && playBox.height >= 40,
      `touch targets are at least 40 px: ${playBox.width}×${playBox.height}`,
    );
    if ((await p$("play-button").getAttribute("aria-pressed")) === "true")
      await p$("play-button").tap();
    assert.deepEqual(
      await phone.evaluate(layoutProblems),
      [],
      "studio with a work",
    );
    await p$("nav-library").tap();
    await p$("library-page").waitFor();
    assert.equal(
      await phone.locator('[data-testid="library-card"]').count(),
      1,
    );
    assert.deepEqual(await phone.evaluate(layoutProblems), [], "library");
    assert.equal(
      await p$("mini-transport").count(),
      1,
      "the mini transport follows to other pages",
    );
    await p$("mini-play").tap();
    await until(
      () => p$("mini-play").getAttribute("aria-pressed"),
      (value) => value === "true",
      "the mini transport plays",
    );
    await p$("mini-play").tap();
    await p$("nav-inspiration").tap();
    await p$("inspiration-page").waitFor();
    assert.deepEqual(await phone.evaluate(layoutProblems), [], "inspiration");
    await p$("settings-button").tap();
    await p$("settings-modal").waitFor();
    const sheet = await p$("settings-modal").boundingBox();
    assert.ok(
      sheet.x >= 0 && sheet.x + sheet.width <= 390.5,
      "the dialog fits the screen",
    );
    await p$("modal-close").tap();
    await p$("settings-modal").waitFor({ state: "detached" });
    const phoneCsp = await phone.evaluate(() => window.__csp);
    await phoneContext.close();
    pass(
      "phone-sized screen (390×780, touch): no sideways scrolling, style sheet, generate, mini transport",
    );

    /* 12 — clean: no console errors, nothing but the static files requested */
    step = "clean";
    const csp = [...(await frame.evaluate(() => window.__csp)), ...phoneCsp];
    const allowed = new Set([
      PARENT_PATH,
      APP_PATH,
      ...fs
        .readdirSync(path.join(DIST, "assets"))
        .map((name) => `${APP_PATH}assets/${name}`),
    ]);
    const network = sink.requests.filter((url) => /^(https?|wss?):/i.test(url));
    const foreign = network.filter((url) => {
      const parsedUrl = new URL(url);
      return (
        parsedUrl.origin !== server.origin || !allowed.has(parsedUrl.pathname)
      );
    });
    const badStatus = server.log.filter((entry) => entry.status !== 200);
    assert.deepEqual(sink.console, [], "console errors");
    assert.deepEqual(sink.pageErrors, [], "page errors");
    assert.deepEqual(sink.failed, [], "failed requests");
    assert.deepEqual(csp, [], "CSP violations");
    assert.deepEqual(foreign, [], "requests beyond the static files");
    assert.deepEqual(badStatus, [], "non-200 responses");
    pass("no console errors and no network beyond the static files", {
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
    if (sink.console.length)
      console.error("console errors:", JSON.stringify(sink.console, null, 1));
    if (sink.pageErrors.length)
      console.error("page errors:", sink.pageErrors.join("\n"));
  } finally {
    await browser.close().catch(() => {});
    await server.close();
    fs.rmSync(downloads, { recursive: true, force: true });
    report.seconds = +((Date.now() - started) / 1000).toFixed(1);
    fs.writeFileSync(
      path.join(OUT, "web-smoke.json"),
      JSON.stringify(report, null, 2),
    );
  }
  console.log(
    report.ok
      ? `web smoke passed (${report.steps.length} steps in ${report.seconds} s)`
      : `web smoke FAILED at "${step}" after ${report.steps.length} passed step(s)`,
  );
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
