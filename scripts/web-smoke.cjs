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
// billing notice, the question before a paid request (and what a double-click
// does to it), a length the service does not take, an unsaved paid result, a
// paid result whose file never arrived (the banner, its questions, a reload,
// 重新下载, 放弃这次结果) — cannot be reached in the web build, which has no
// cloud engines. Another
// opens the web build as a 1366×768 window (the size at which v0.3.0 hid the
// inspector's buttons) for what the review asked to be true on screen:
// pending edits stay reachable and are never dropped (a pill leads to them
// when their panel is off screen), the style chips are one stop for the Tab
// key, chord names are printed wherever they fit, the mixer and the chips
// follow what the piece contains, 循环试听 follows the structure.
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
/** 18 → "0:18": a length as the transport shows it. */
const clock = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

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

/**
 * The v0.3 interface is 专业模式 now; the app starts in 简单模式. The steps
 * written for v0.3 run in 专业模式: this sets the remembered preference
 * before the app reads it — unless a step chose a mode itself.
 */
function proMode() {
  try {
    if (!localStorage.getItem("muse-bgm:mode"))
      localStorage.setItem("muse-bgm:mode", "pro");
  } catch {
    /* storage refused: the step will notice */
  }
}

/** Words 简单模式 never shows (spec §1: no jargon, no English). */
const JARGON =
  /BPM|调性|大调|小调|分轨|混响|版本号|v\d|引擎|种子|段落|和弦|推子|制作人|[A-Za-z]{3,}/;

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
  window.__calls = [];
  window.__putFailures = 0;
  /** the next n downloads of a finished result fail (the music exists, its file does not arrive) */
  window.__downloadFailures = 0;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (window.__putFailures > 0) {
      window.__putFailures--;
      throw new DOMException("Internal error", "UnknownError");
    }
    return put.apply(this, args);
  };
  // What the main process holds outlives a reload of the page (sessionStorage does, too).
  const held = () => sessionStorage.getItem("__held");
  const hold = (provider) =>
    provider
      ? sessionStorage.setItem("__held", provider)
      : sessionStorage.removeItem("__held");
  window.__held = held;
  const NOT_DOWNLOADED =
    "音乐已生成，但下载失败（已尝试 4 次，网络不稳定或文件服务器暂时不可用）。重新生成会再次计费：请先检查网络，再到服务控制台找回这首音乐。（任务编号 smoke-0001）";
  const answer = () => ({
    audio: bytes.slice().buffer,
    mimeType: "audio/mpeg",
  });
  const later = (run) =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(run());
        } catch (error) {
          reject(error);
        }
      }, 200),
    );
  const download = () => {
    if (window.__downloadFailures > 0) {
      window.__downloadFailures--;
      throw new Error(NOT_DOWNLOADED);
    }
    hold(null);
    return answer();
  };
  window.museDesktop = Object.freeze({
    getSettings: async () => ({
      providers: {
        tencent: { configured: true, model: "minimax-music-v3.0" },
        volcengine: { configured: true },
        aliyun: { configured: false },
        elevenlabs: { configured: false },
      },
      llm: { configured: false },
      dataPath: "C:\\stand-in",
      version: "0.3.0-smoke",
      pendingResult: held() ? { provider: held() } : null,
    }),
    saveProviderCredentials: async () => {},
    deleteProviderCredentials: async () => {},
    generateMusic: (input) => {
      window.__calls.push(
        `generateMusic:${input.provider}:${input.duration}${input.discardPending === true ? ":discardPending" : ""}`,
      );
      // like the main process: no new paid request while a paid result waits, unless it may go
      if (held() && input.discardPending !== true)
        return Promise.reject(
          new Error(
            "还有一首已经付费的音乐没有取回，这次没有发出新的生成请求。请先点「重新下载」把它取回；确认不要它之后，才能开始新的生成。",
          ),
        );
      hold(null);
      localStorage.setItem("__paid", String(paid() + 1));
      return later(() => {
        // the service has made (and billed) the music; fetching its file may fail
        hold(input.provider);
        return download();
      });
    },
    cancelGeneration: async () => {},
    retryLastDownload: (provider) => {
      window.__calls.push(`retryLastDownload:${provider}`);
      if (held() !== provider)
        return Promise.reject(
          new Error(
            "没有等待重新下载的音乐。如需这首音乐，请到服务控制台查找，或重新生成。",
          ),
        );
      return later(download);
    },
    discardPendingResult: async (provider) => {
      window.__calls.push(`discardPendingResult:${provider}`);
      if (held() !== provider) return false;
      hold(null);
      return true;
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
 * screen, nothing is sent without a deliberate yes (a chip never sends, a
 * double-click answers nothing), a length the service does not take is
 * settled before the paid question, a result whose save failed stays, is not
 * left unasked and can be exported — and a result whose file never arrived
 * stays on offer until it is fetched or knowingly given up.
 */
async function desktopRenderer(browser, origin) {
  const mp3 = fs.readFileSync(
    path.join(ROOT, "tests", "fixtures", "music-3s.mp3"),
  );
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    locale: "zh-CN",
  });
  await context.addInitScript(proMode);
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
    // NEW-04: the selector shows the whole name of the engine, billing included (it was cut off at 220 px).
    assert.deepEqual(
      await $("composer-engine").evaluate((select) => {
        const style = getComputedStyle(select);
        const context = document.createElement("canvas").getContext("2d");
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = select.selectedOptions[0].textContent;
        const room =
          select.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        return { text, fits: context.measureText(text).width <= room + 1 };
      }),
      { text: "腾讯云 TokenHub · 按服务商计费", fits: true },
    );

    // NEW-09: a double-click on 生成 BGM opens the question — and answers nothing. (v0.3.0: the
    // second click landed on the backdrop, which is 取消; with other geometry it could land on a button.)
    await $("send-button").dblclick();
    await sleep(150);
    assert.equal(
      await $("dialog-paid").count(),
      1,
      "the question is still there",
    );
    assert.equal(
      await $("modal-shield").count(),
      1,
      "and takes no pointer input yet",
    );
    assert.equal(await paid(), 0);
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-testid"),
      ),
      "dialog-choice-cancel",
      "the safe answer keeps the focus",
    );
    assert.equal(
      await $("send-button").isDisabled(),
      true,
      "the control that opened the question is disabled while it is open",
    );
    // Enter right after it opened (a second or held Enter) is not an answer either.
    await page.keyboard.press("Enter");
    await page.keyboard.down("Enter");
    assert.equal(await $("dialog-paid").count(), 1);
    await $("modal-shield").waitFor({ state: "detached" });
    // A key that is being held never answers, however long the question has been open.
    await sleep(100);
    await page.keyboard.down("Enter"); // still down: auto-repeat
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    assert.equal(await $("dialog-paid").count(), 1);
    assert.equal(await paid(), 0);
    // After that moment a deliberate Enter on the focused 取消 does cancel.
    await page.keyboard.press("Enter");
    await $("dialog-paid").waitFor({ state: "detached" });
    assert.equal(await paid(), 0);
    assert.equal(await $("send-button").isEnabled(), true);
    // The same from the keyboard: Ctrl+Enter, Enter, Enter in one breath.
    await $("composer-input").focus();
    await page.keyboard.press("Control+Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await sleep(100);
    assert.equal(
      await $("dialog-paid").count(),
      1,
      "three quick Enters: asked, not answered",
    );
    assert.equal(await paid(), 0);
    await page.keyboard.press("Escape");
    await $("dialog-paid").waitFor({ state: "detached" });

    // FQ-04: a length the service does not take is settled BEFORE the paid question — v0.3.0
    // asked to confirm the payment and then refused with 生成失败.
    await $("composer-duration").selectOption("15");
    await $("composer-engine").selectOption("volcengine");
    assert.deepEqual(
      await $("composer-duration").evaluate((select) =>
        [...select.options]
          .filter((option) => option.disabled)
          .map((option) => option.textContent),
      ),
      ["15 秒 · 该引擎不支持"],
      "the selector says which lengths this engine takes",
    );
    await $("send-button").click();
    await $("dialog-duration").waitFor();
    assert.equal(await $("dialog-paid").count(), 0, "the length comes first");
    assert.match(
      await $("dialog-duration").innerText(),
      /火山引擎 AI 音乐支持 30–120 秒，这次的时长是 15 秒。[\s\S]*改为 30 秒[\s\S]*还没有发送任何请求/,
    );
    await $("dialog-choice-cancel").click();
    await $("dialog-duration").waitFor({ state: "detached" });
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    assert.equal(await paid(), 0);
    assert.deepEqual(
      (
        await page.locator('[data-testid="toast"] > span').allInnerTexts()
      ).filter((text) => text.startsWith("生成失败")),
      [],
      "nothing failed: nothing was sent",
    );
    await $("send-button").click();
    await $("dialog-choice-fit").click();
    await $("dialog-paid").waitFor();
    assert.equal(
      await $("composer-duration").inputValue(),
      "30",
      "what was agreed is what the composer now shows",
    );
    assert.equal(await paid(), 0, "and only now the paid question");
    await page.keyboard.press("Escape");
    await $("dialog-paid").waitFor({ state: "detached" });
    await $("composer-engine").selectOption("tencent");
    await $("composer-duration").selectOption("");
    assert.equal(
      await page.evaluate(() => window.__calls.length),
      0,
      "none of this reached the service",
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
    await pendingResult(page, { $, paid, idle, mixLoaded });
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
    // FQ-15: one link per destination. 打开服务商控制台 opened the very page 获取 API Key opens.
    assert.equal(await $("llm-console-link").count(), 0);
    assert.equal(await $("llm-key-link").count(), 1);
    assert.equal(await $("llm-key-warning").count(), 0);
    // NEW-08: with a cloud engine a failing model is not replaced without a question; the notice says so.
    assert.match(
      await $("llm-notice").innerText(),
      /模型不可用时，制作人会改用离线规则；选了云端生成时会先问你。$/,
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
    // FQ-15: a key that does not look like the vendor's is pointed out — and can still be saved.
    await $("llm-preset").selectOption("anthropic");
    await $("llm-key").fill("sk-proj-not-an-anthropic-key");
    assert.match(
      await $("llm-key-warning").innerText(),
      /不是以 sk-ant- 开头[\s\S]*仍然可以保存/,
    );
    assert.equal(await $("llm-save").isEnabled(), true);
    await $("llm-key").fill("sk-ant-api03-0123456789");
    assert.equal(await $("llm-key-warning").count(), 0);
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

/**
 * FQ-01: a paid result that was generated but not delivered. Starts with a
 * stored cloud work loaded and 本次会话不再提示 ticked for its service — the
 * state in which v0.3.0 lost such a result to one stray click, or to the next
 * request, without a word.
 */
async function pendingResult(page, { $, paid, idle, mixLoaded }) {
  const risk = () => page.evaluate(() => window.__risk.at(-1));
  const held = () => page.evaluate(() => window.__held());
  const calls = () => page.evaluate(() => window.__calls);
  const toasts = () =>
    page.locator('[data-testid="toast"] > span').allInnerTexts();
  const dismissToasts = async () => {
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
  const before = await paid();
  const works = (await records(page)).length;
  const revision = Number(await $("player-card").getAttribute("data-revision"));

  // The service makes the music (and bills it); the file does not arrive.
  await page.evaluate(() => {
    window.__downloadFailures = 1;
  });
  await $("composer-input").fill("安静一点");
  await $("composer-input").press("Enter");
  await $("pending-banner").waitFor({ timeout: 30000 });
  await idle();
  assert.equal(await paid(), before + 1, "one paid request");
  assert.equal(await held(), "tencent", "the main process holds the result");
  const banner = (await $("pending-text").innerText()).replace(/\s+/g, " ");
  assert.match(
    banner,
    /^腾讯云 TokenHub 的一次付费生成还没有取回。 ?音乐已生成，但下载失败（已尝试 4 次[\s\S]*（任务编号 smoke-0001）也可以点「重新下载」再取一次，不会再次计费。$/,
  );
  assert.deepEqual(
    (await toasts()).filter((text) => text.startsWith("生成失败")),
    [],
    "the music WAS made",
  );
  assert.equal(
    await page.locator('[data-testid="toast-action"]').count(),
    0,
    "the offer does not live in a notice that can be closed",
  );
  assert.equal(await risk(), true, "closing the window asks first");
  assert.equal((await records(page)).length, works);
  assert.equal(
    await $("composer-input").inputValue(),
    "安静一点",
    "the words are handed back",
  );
  // (a) Closing every notice loses nothing: the banner, the offer and the question on closing stay.
  await dismissToasts();
  assert.equal(await $("pending-banner").count(), 1);
  assert.equal(await $("pending-download").isEnabled(), true);
  assert.equal(await risk(), true);
  // ...on every page
  for (const target of ["library", "inspiration", "studio"]) {
    await $(`nav-${target}`).click();
    assert.equal(await $("pending-banner").count(), 1, `on ${target}`);
  }
  assert.deepEqual(await page.evaluate(layoutProblems), []);

  // (b) A new paid request does not replace it unasked — not even with 本次会话不再提示 ticked.
  await $("composer-input").press("Enter");
  await $("dialog-pending").waitFor();
  assert.equal(await $("dialog-paid").count(), 0);
  assert.match(
    await $("dialog-pending").innerText(),
    /还有一首付费生成的音乐没有取回[\s\S]*腾讯云 TokenHub 已经生成并计费的音乐还没有下载下来[\s\S]*发送新的生成请求后，它就无法再取回了/,
  );
  assert.deepEqual(
    await page
      .locator('[data-testid="dialog-pending"] .modal-foot button')
      .allInnerTexts(),
    ["取消", "重新下载", "放弃它，继续发送"],
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    ),
    "dialog-choice-stay",
  );
  await page.keyboard.press("Escape");
  await $("dialog-pending").waitFor({ state: "detached" });
  assert.equal(await paid(), before + 1, "nothing was sent");
  assert.equal(await $("pending-banner").count(), 1);
  // 新建创作 and opening another work ask as well; the safe answer changes nothing.
  await $("new-piece").click();
  await $("dialog-pending").waitFor();
  assert.deepEqual(
    await page
      .locator('[data-testid="dialog-pending"] .modal-foot button')
      .allInnerTexts(),
    ["取消", "重新下载", "稍后再取，继续"],
  );
  await $("dialog-choice-stay").click();
  await $("dialog-pending").waitFor({ state: "detached" });
  assert.equal(
    await $("player-card").getAttribute("data-revision"),
    String(revision),
  );
  const loadedId = await $("player-card").getAttribute("data-project");
  await $("nav-library").click();
  await page
    .locator(
      `[data-testid="library-card"]:not([data-project="${loadedId}"]) [data-testid="library-open"]`,
    )
    .first()
    .click();
  await $("dialog-pending").waitFor();
  await page.keyboard.press("Escape");
  await $("dialog-pending").waitFor({ state: "detached" });
  await $("nav-studio").click();
  assert.equal(
    await $("player-card").getAttribute("data-revision"),
    String(revision),
    "the work that was loaded is still the one",
  );
  // 放弃这次结果 is a question, and says what it costs.
  await $("pending-discard").click();
  await $("dialog-discard").waitFor();
  assert.match(
    await $("dialog-discard").innerText(),
    /放弃这首已经生成的音乐？[\s\S]*已经由腾讯云 TokenHub 生成并计费。放弃后，这里不再提供重新下载。[\s\S]*重新付费生成/,
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    ),
    "dialog-choice-keep",
  );
  await $("dialog-choice-keep").click();
  await $("dialog-discard").waitFor({ state: "detached" });
  assert.equal(await $("pending-banner").count(), 1);
  assert.equal(await held(), "tencent");

  // A reload of the page: the main process still holds the result, and says so — the banner is back.
  await page.reload();
  await mixLoaded(revision);
  await $("pending-banner").waitFor({ timeout: 15000 });
  assert.equal(
    (await $("pending-text").innerText()).replace(/\s+/g, " "),
    banner,
    "word for word",
  );
  assert.equal(await risk(), true);
  assert.equal(await page.locator('[role="dialog"]').count(), 0);

  // 重新下载 that fails again: still on offer, still nothing sent.
  await page.evaluate(() => {
    window.__downloadFailures = 1;
  });
  await $("pending-download").click();
  await page.waitForSelector(
    '[data-testid="job-status"][data-stage="downloading"]',
  );
  assert.match(
    await $("job-phase").innerText(),
    /正在重新下载已经生成的音乐，不会再次计费/,
  );
  assert.equal(
    await $("pending-download").isDisabled(),
    true,
    "not twice at once",
  );
  await idle();
  assert.equal(await $("pending-banner").count(), 1);
  assert.ok(
    (await toasts()).some((text) => /还是没有下载下来/.test(text)),
    JSON.stringify(await toasts()),
  );
  assert.equal(await paid(), before + 1);
  // 重新下载 that succeeds: stored, decoded and loaded exactly like a fresh result.
  await $("pending-download").click();
  await mixLoaded(revision + 1);
  await $("pending-banner").waitFor({ state: "detached" });
  await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', {
    timeout: 15000,
  });
  assert.equal(await paid(), before + 1, "fetched, not generated again");
  assert.equal(await held(), null);
  assert.equal(await risk(), false);
  const stored = await records(page);
  assert.equal(stored.length, works + 1);
  const delivered = stored.find((record) => record.revision === revision + 1);
  assert.equal(delivered.provider, "tencent");
  assert.ok(delivered.parentId, "a version of the work it was asked for");
  assert.deepEqual(
    delivered.chat
      .slice(-2)
      .map((turn) => [turn.role, turn.revision ?? turn.text]),
    [
      ["user", "安静一点"],
      ["agent", revision + 1],
    ],
    "the request it answers, then the producer's answer with its version",
  );
  assert.ok(
    !delivered.chat.some((turn) => turn.error),
    "no failure note is stored with it",
  );
  assert.equal(await $("composer-engine").inputValue(), "tencent");
  assert.deepEqual(
    (await calls()).filter((call) => call.startsWith("generateMusic")),
    [],
    "no request since the reload",
  );

  // 放弃这次结果, confirmed: gone here and in the main process; closing no longer asks; a reload brings nothing back.
  await page.evaluate(() => {
    window.__downloadFailures = 1;
  });
  await $("composer-input").fill("再安静一点");
  await $("composer-input").press("Enter");
  // (the reload forgot 本次会话不再提示: the paid question is back)
  await $("dialog-paid").waitFor();
  await $("dialog-choice-confirm").click();
  await $("pending-banner").waitFor({ timeout: 30000 });
  await idle();
  assert.equal(await paid(), before + 2);
  await $("pending-discard").click();
  await $("dialog-choice-discard").click();
  await $("pending-banner").waitFor({ state: "detached" });
  assert.equal(await held(), null, "the main process let go of it");
  assert.ok((await calls()).includes("discardPendingResult:tencent"));
  assert.equal(await risk(), false);
  await page.reload();
  await mixLoaded(revision + 1);
  await sleep(500);
  assert.equal(await $("pending-banner").count(), 0);
  assert.equal((await records(page)).length, works + 1);
  await $("composer-input").fill("");
  return { paid: before + 2 };
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
  await context.addInitScript(proMode);
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
  /** true, or what is wrong — so a failed assertion says it */
  const reachable = (id) =>
    page.evaluate((testId) => {
      const node = document.querySelector(`[data-testid="${testId}"]`);
      if (!node) return "not on the page";
      const box = node.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (
        box.top < 0 ||
        box.bottom > innerHeight ||
        box.left < 0 ||
        box.right > innerWidth
      )
        return `off screen: ${Math.round(box.left)},${Math.round(box.top)} – ${Math.round(box.right)},${Math.round(box.bottom)} in ${innerWidth}×${innerHeight}`;
      const hit = document.elementFromPoint(x, y);
      return (
        (!!hit && (hit === node || node.contains(hit))) ||
        `covered by ${hit ? hit.outerHTML.slice(0, 120) : "nothing"}`
      );
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

    /* FQ-13 — the 23 style chips are one stop for the Tab key; the arrows move between them */
    const focused = () =>
      page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    await $("composer-input").focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await focused(),
      "style-chip-auto",
      "Tab lands on the chosen chip",
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await focused(),
      "composer-duration",
      "v0.3.0: 22 more chips stood between the description and the selectors",
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(), "style-chip-auto");
    await page.keyboard.press("ArrowRight");
    assert.equal(await focused(), "style-chip-bright");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await focused(), "style-chip-festive", "the row wraps around");
    await page.keyboard.press("Home");
    assert.equal(await focused(), "style-chip-auto");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    assert.equal(await focused(), "style-chip-romantic");
    assert.equal(
      await pressed("style-chip-romantic"),
      "false",
      "moving is not choosing",
    );
    await page.keyboard.press("Enter");
    assert.equal(await pressed("style-chip-romantic"), "true");
    assert.equal(await pressed("style-chip-auto"), "false");
    assert.equal(
      await page.locator('.style-chips .chip[tabindex="0"]').count(),
      1,
      "exactly one chip takes Tab",
    );
    // Leaving the row and coming back lands on the chosen style.
    await page.keyboard.press("Tab");
    assert.equal(await focused(), "composer-duration");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(), "style-chip-romantic");
    await page.keyboard.press("Enter");
    assert.equal(
      await pressed("style-chip-auto"),
      "true",
      "a second Enter unpins",
    );

    /* UX-02 — 应用调整 / 全部还原 / 换一版旋律 are on screen however the panel is scrolled */
    await generate("雨夜咖啡馆，慵懒的钢琴和轻轻的鼓点");

    /* FQ-07 — a chord is named wherever its name fits, and names never run into each other */
    const chordFacts = () =>
      $("chord-strip").evaluate((strip) => {
        const nodes = [...strip.querySelectorAll(".chord")];
        const box = (node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect();
        };
        const drawn = nodes.filter(
          (node, index) =>
            index === 0 || nodes[index - 1].textContent !== node.textContent,
        );
        const shown = drawn.filter((node) => node.hasAttribute("data-shown"));
        let overlaps = 0;
        for (let index = 1; index < shown.length; index++)
          if (box(shown[index]).left < box(shown[index - 1]).right + 1)
            overlaps++;
        // A chord with no name printed although its name fits between the printed names with
        // room to spare. Counted on the names the layout prints (data-label), not on what the
        // pill of the chord that is playing leaves visible at this moment: the layout does not
        // depend on the playhead, and this check must not either. The layout keeps 3 px between
        // names and measures each a pixel or two wider than it is drawn (figures are set
        // tabular, which the canvas it measures with does not know), so a name that would only
        // just fit is rightly left out; SPARE px beyond the gap is what counts as room. (In 70
        // random pieces at 390 px, each looked at six times while playing, every name the
        // layout left out had at most 2.25 px to spare; the defect of v0.3.0 was an
        // overestimate of about 1.4 px per character.)
        const SPARE = 4;
        const printed = drawn.filter((node) => node.hasAttribute("data-label"));
        const missing = [];
        drawn.forEach((node) => {
          if (node.hasAttribute("data-label")) return;
          const left = node.getBoundingClientRect().left;
          const width = box(node).width + 6;
          const before = printed.filter(
            (other) => other.getBoundingClientRect().left < left,
          );
          const after = printed.filter(
            (other) => other.getBoundingClientRect().left > left,
          );
          const from = before.length ? box(before.at(-1)).right + 3 : -Infinity;
          const to = after.length
            ? after[0].getBoundingClientRect().left - 3
            : strip.getBoundingClientRect().right;
          if (left >= from + SPARE && left + width + 1 + SPARE <= to)
            missing.push(node.textContent);
        });
        return {
          drawn: drawn.length,
          printed: printed.length,
          shown: shown.length,
          overlaps,
          missing,
        };
      });
    const chordsWide = await chordFacts();
    assert.equal(chordsWide.overlaps, 0, JSON.stringify(chordsWide));
    assert.deepEqual(
      chordsWide.missing,
      [],
      "v0.3.0 left names out although there was room (the width of a name was overestimated)",
    );
    assert.ok(chordsWide.shown >= 2, JSON.stringify(chordsWide));
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
    // FQ-16: that tip does not lie over the line it comments on (it covered the hint under 应用调整).
    await clearToasts();
    await $("new-melody").hover();
    await page.waitForSelector(".tooltip");
    assert.deepEqual(
      await page.evaluate(() => {
        const tip = document.querySelector(".tooltip").getBoundingClientRect();
        const over = (id) => {
          const box = document
            .querySelector(`[data-testid="${id}"]`)
            .getBoundingClientRect();
          return (
            tip.left < box.right &&
            tip.right > box.left &&
            tip.top < box.bottom &&
            tip.bottom > box.top
          );
        };
        return {
          hint: over("apply-hint"),
          apply: over("apply-draft"),
          summary: over("pending-summary"),
          inside: tip.left >= 0 && tip.bottom <= innerHeight,
        };
      }),
      { hint: false, apply: false, summary: false, inside: true },
    );
    await page.mouse.move(4, 4);

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
    // FQ-13: the version tags of the thread are full-size targets (they measured 28×20).
    const tags = await page
      .locator('button[data-testid="turn-version"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return [Math.round(box.width), Math.round(box.height)];
        }),
      );
    assert.ok(tags.length >= 2, JSON.stringify(tags));
    for (const [width, height] of tags)
      assert.ok(width >= 28 && height >= 28, `version tag ${width}×${height}`);

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
    // the card's line and the header give the real length of this loop (fitted to whole bars, not the 15 s asked for)
    const loopSeconds = Number(
      await $("player-card").getAttribute("data-duration"),
    );
    assert.notEqual(Math.round(loopSeconds), 15);
    assert.ok(
      (await $("time-display").innerText()).endsWith(`/ ${clock(loopSeconds)}`),
      await $("time-display").innerText(),
    );

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
    // (a notice from the last generation may still be up: it sits where the footer will be)
    await clearToasts();
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
    /* FQ-06 — with the panel off screen, a pill says that edits are waiting and leads to them */
    for (const size of [
      { width: 390, height: 780 },
      { width: 1060, height: 720 },
    ]) {
      await page.setViewportSize(size);
      await $("inspector").scrollIntoViewIfNeeded();
      await $("pending-pill").waitFor({ state: "detached" });
      assert.equal(
        await reachable("apply-draft"),
        true,
        `apply-draft with the panel in view at ${size.width} px`,
      );
      await page.evaluate(() =>
        document.querySelector(".studio").scrollTo(0, 0),
      );
      await $("pending-pill").waitFor();
      assert.match(
        String(await reachable("apply-draft")),
        /^off screen/,
        "the buttons are below the fold here…",
      );
      // …and v0.3.0 showed nothing that said an edit was waiting.
      assert.equal((await $("pending-pill").innerText()).trim(), "1 项未应用");
      await sleep(400);
      assert.equal(await reachable("pending-pill"), true);
      assert.deepEqual(await page.evaluate(layoutProblems), []);
      const pillBox = await $("pending-pill").boundingBox();
      assert.ok(pillBox.height >= 28, `pill ${pillBox.height} px tall`);
      await $("pending-pill").click();
      await $("pending-pill").waitFor({ state: "detached" });
      await until(
        () => reachable("apply-draft"),
        (value) => value === true,
        `the pill leads to 应用调整 at ${size.width} px`,
      );
      assert.equal(await reachable("reset-draft"), true);
    }
    // a folded panel is opened by the pill
    await page.setViewportSize({ width: 390, height: 780 });
    await $("inspector-toggle").scrollIntoViewIfNeeded();
    if ((await $("inspector-toggle").getAttribute("aria-expanded")) === "true")
      await $("inspector-toggle").click();
    await page.evaluate(() => document.querySelector(".studio").scrollTo(0, 0));
    await $("pending-pill").click();
    await until(
      () => $("inspector-toggle").getAttribute("aria-expanded"),
      (value) => value === "true",
      "the pill opens the folded panel",
    );
    await until(
      () => reachable("apply-draft"),
      (value) => value === true,
      "and shows its buttons",
    );
    // chord names on a phone: fewer of them, and still none over another
    await page.evaluate(() => document.querySelector(".studio").scrollTo(0, 0));
    await sleep(200);
    const chordsNarrow = await chordFacts();
    assert.equal(chordsNarrow.overlaps, 0, JSON.stringify(chordsNarrow));
    assert.deepEqual(chordsNarrow.missing, [], JSON.stringify(chordsNarrow));
    await $("inspector").scrollIntoViewIfNeeded();
    await $("reset-draft").click();
    assert.equal(await $("apply-draft").isDisabled(), true);
    await page.evaluate(() => document.querySelector(".studio").scrollTo(0, 0));
    await sleep(300);
    assert.equal(
      await $("pending-pill").count(),
      0,
      "nothing waiting: no pill",
    );
    return {
      works: (await records(page)).length,
      chords: { wide: chordsWide, narrow: chordsNarrow },
    };
  } finally {
    await context.close();
  }
}

/* ---------------- the run ---------------- */

/* ---------------- 简单模式 (the default) ---------------- */

/** The visible words of a page, minus the two the spec itself writes in Latin letters. */
function plainText(frame) {
  return frame.evaluate(() =>
    (document.querySelector(".app-body")?.innerText ?? "").replace(
      /Vlog|8-bit/g,
      "",
    ),
  );
}

/**
 * 简单模式 as a first visitor meets it, inside the portal's frame: a scene →
 * music plays → 快一点 → what changed, in plain words → 撤销 → 下载音乐 (a
 * 48 kHz WAV named by the title) → 我的音乐 (one card for both versions,
 * plays, deletes with 撤销) → 专业模式 and back. No jargon on any screen.
 */
async function simpleJourney(browser, origin, watch, downloads) {
  const context = await browser.newContext({
    viewport: { width: FRAME.width + 40, height: FRAME.height + 40 },
    acceptDownloads: true,
    locale: "zh-CN",
  });
  // no proMode here: a first visit starts in 简单模式
  await context.addInitScript(probes);
  const page = await context.newPage();
  watch(page);
  await page.goto(`${origin}${PARENT_PATH}`);
  const frame = await (await page.waitForSelector("iframe#app")).contentFrame();
  const $ = (id) => frame.locator(`[data-testid="${id}"]`);
  await $("simple-make").waitFor({ timeout: 30000 });
  assert.equal(
    await frame.locator(".app").getAttribute("data-mode"),
    "simple",
    "a first visit is 简单模式",
  );
  assert.equal(await $("nav-studio").count(), 0, "no 专业模式 navigation");
  assert.equal(await $("composer-engine").count(), 0, "no engine selector");
  assert.equal(await $("composer-brain").count(), 0, "no producer selector");
  assert.equal(await $("scene-card").count(), 12);
  assert.equal(await $("more-style").count(), 10);
  assert.match(await $("simple-lede").innerText(), /完全免费、不用联网/);
  assert.equal(
    await $("simple-ai-toggle").count(),
    0,
    "no AI service on the web",
  );
  assert.doesNotMatch(await plainText(frame), JARGON, "make page");
  assert.deepEqual(await frame.evaluate(layoutProblems), [], "make page");

  // one tap: 咖啡馆 (1 minute, a seamless loop)
  const starts = await frame.evaluate(() => window.__sourceStarts);
  await frame.locator('[data-testid="scene-card"][data-scene="cafe"]').click();
  await frame.waitForSelector(
    '[data-testid="simple-result"][data-revision="1"][data-audio="stems"]',
    { timeout: 120000 },
  );
  await $("simple-progress").waitFor({ state: "detached", timeout: 120000 });
  const [first] = await records(frame);
  assert.equal(first.config.mood, "chill");
  assert.equal(first.config.loop, true);
  assert.equal(first.config.duration, 60);
  // it plays by itself (the tap was the gesture), and the play button pauses it
  await until(
    () => $("simple-play").getAttribute("aria-pressed"),
    (value) => value === "true",
    "the new piece plays",
  );
  await until(
    () => frame.evaluate(() => window.__sourceStarts),
    (value) => value > starts,
    "audio sources started",
  );
  await $("simple-play").click();
  assert.equal(await $("simple-play").getAttribute("aria-pressed"), "false");
  assert.equal(
    await $("simple-summary").innerText(),
    "慵懒放松 · 1 分钟 · 可以循环播放",
  );
  assert.match(await $("simple-change").innerText(), /^做好了：慵懒放松/);
  assert.equal(await $("simple-undo").count(), 0, "nothing to undo yet");
  assert.doesNotMatch(await plainText(frame), JARGON, "result page");
  assert.deepEqual(await frame.evaluate(layoutProblems), [], "result page");

  // 快一点: a new version, what changed in plain words
  await $("tweak-faster").click();
  await frame.waitForSelector(
    '[data-testid="simple-result"][data-revision="2"][data-audio="stems"]',
    { timeout: 120000 },
  );
  await $("simple-progress").waitFor({ state: "detached", timeout: 120000 });
  const change = await $("simple-change").innerText();
  assert.match(
    change,
    /^改好了：节奏快了(?:一点|很多)，旋律(?:没变|大体没变)。/,
  );
  assert.doesNotMatch(
    change.replace(/\d+ (?:分钟|分|秒)/g, ""),
    /\d|[A-Za-z%]/,
  );
  assert.equal(await $("simple-prev").count(), 1, "上一版 is offered");
  const second = (await records(frame)).find((item) => item.revision === 2);
  assert.ok(second && second.config.bpm > first.config.bpm);
  if ((await $("simple-play").getAttribute("aria-pressed")) === "true")
    await $("simple-play").click();

  // 撤销: the version before, as it was
  await $("simple-undo").click();
  await frame.waitForSelector(
    `[data-testid="simple-result"][data-project="${first.id}"][data-audio="stems"]`,
    { timeout: 120000 },
  );
  await $("simple-progress").waitFor({ state: "detached", timeout: 120000 });
  assert.equal(await $("simple-change").count(), 0);
  assert.equal(await $("simple-next").count(), 1, "下一版 leads back");

  // 下载音乐: the whole piece at once, named by its title
  const title = await $("simple-title").inputValue();
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    $("simple-download").click(),
  ]);
  assert.equal(
    file.suggestedFilename(),
    `${title}.wav`,
    "no version in the name",
  );
  const target = path.join(downloads, "simple.wav");
  await file.saveAs(target);
  const wav = wavInfo(fs.readFileSync(target));
  assert.equal(wav.riff, "RIFF");
  assert.equal(wav.wave, "WAVE");
  assert.equal(wav.sampleRate, 48000);
  assert.equal(wav.channels, 2);
  assert.equal(wav.bits, 16);
  assert.ok(Math.abs(wav.seconds - 60) < 4, `${wav.seconds} s`);
  assert.ok(wav.rms > 0.001, `audible: rms ${wav.rms}`);

  // 我的音乐: one card for the piece and both its versions
  await $("simple-nav-library").click();
  await $("simple-library").waitFor();
  assert.equal(await $("simple-card").count(), 1);
  assert.equal(await $("simple-card-versions").innerText(), "共 2 版");
  assert.doesNotMatch(await plainText(frame), JARGON, "我的音乐");
  assert.deepEqual(await frame.evaluate(layoutProblems), [], "我的音乐");
  await $("simple-card-play").click();
  await until(
    () => $("mini-play").getAttribute("aria-pressed"),
    (value) => value === "true",
    "it plays from 我的音乐",
  );
  await $("simple-card-play").click();
  await until(
    () => $("mini-play").getAttribute("aria-pressed"),
    (value) => value === "false",
    "and pauses",
  );
  // 删除 takes the piece with every version; 撤销 brings it all back
  await $("simple-card-delete").click();
  await $("simple-card").waitFor({ state: "detached" });
  const undo = frame.locator('[data-testid="toast"]', {
    has: frame.locator('[data-testid="toast-action"]'),
  });
  assert.equal(await undo.locator("> span").innerText(), `已删除《${title}》`);
  await undo.locator('[data-testid="toast-action"]').click();
  await $("simple-card").waitFor();
  await until(
    async () => (await records(frame)).length,
    (count) => count === 2,
    "both versions are back",
  );

  // 专业模式 and back: nothing is lost, the choice is remembered
  await $("pro-mode-link").click();
  await $("nav-studio").waitFor();
  assert.ok(
    (await frame.locator('[data-testid="toast"] > span').allInnerTexts()).some(
      (text) => text.includes("可在设置里换回简单模式"),
    ),
  );
  assert.equal(
    await $("library-card").count(),
    2,
    "every version, one card each",
  );
  const before = await frame.evaluate(() => window.__csp);
  await page.reload();
  const again = await (await page.waitForSelector("iframe#app")).contentFrame();
  const a$ = (id) => again.locator(`[data-testid="${id}"]`);
  await a$("nav-studio").waitFor({ timeout: 30000 });
  await a$("settings-button").click();
  await a$("settings-tab-general").click();
  assert.equal(await a$("mode-pro").getAttribute("aria-checked"), "true");
  await a$("mode-simple").click();
  await a$("modal-close").click();
  await again
    .locator('[data-testid="simple-result"], [data-testid="simple-make"]')
    .first()
    .waitFor();
  const csp = [...before, ...(await again.evaluate(() => window.__csp))];
  await context.close();
  return { csp, change, seconds: +wav.seconds.toFixed(2) };
}

/** 简单模式 on a phone: no sideways scrolling, the main buttons on the first screen. */
async function simplePhone(browser, origin, watch) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 780 },
    locale: "zh-CN",
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(probes);
  const phone = await context.newPage();
  watch(phone);
  const $ = (id) => phone.locator(`[data-testid="${id}"]`);
  await phone.goto(`${origin}${APP_PATH}`);
  await $("simple-make").waitFor({ timeout: 30000 });
  assert.deepEqual(await phone.evaluate(layoutProblems), [], "make page");
  // 做一首 with a sentence of one's own: no length named, so one minute
  await $("simple-input").fill("海边日落，温柔一点");
  await $("simple-send").tap();
  await phone.waitForSelector(
    '[data-testid="simple-result"][data-audio="stems"]',
    { timeout: 120000 },
  );
  await $("simple-progress").waitFor({ state: "detached", timeout: 120000 });
  const [made] = await records(phone);
  assert.equal(made.config.prompt, "海边日落，温柔一点");
  assert.equal(made.config.duration, 60);
  if ((await $("simple-play").getAttribute("aria-pressed")) === "true")
    await $("simple-play").tap();
  for (const id of [
    "simple-play",
    "simple-download",
    "simple-another",
    "simple-restart",
  ]) {
    const box = await $(id).boundingBox();
    assert.ok(
      box && box.y >= 0 && box.y + box.height <= 780 && box.height >= 44,
      `${id} is on the first screen and big enough: ${JSON.stringify(box)}`,
    );
  }
  assert.deepEqual(await phone.evaluate(layoutProblems), [], "result page");
  await $("simple-nav-library").tap();
  await $("simple-library").waitFor();
  assert.deepEqual(await phone.evaluate(layoutProblems), [], "我的音乐");
  const csp = await phone.evaluate(() => window.__csp);
  await context.close();
  return csp;
}

/**
 * 简单模式 in the desktop renderer with a stand-in bridge: the AI switch is
 * off by default; on, a scene is a paid request that is asked first; a tweak
 * of a paid piece is asked again; 下载音乐 saves the audio as it came.
 */
async function simpleCloud(browser, origin) {
  const mp3 = fs.readFileSync(
    path.join(ROOT, "tests", "fixtures", "music-3s.mp3"),
  );
  const context = await browser.newContext({
    viewport: { width: 1060, height: 720 },
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
  await page.goto(`${origin}${DESKTOP_PATH}`);
  await $("simple-make").waitFor({ timeout: 30000 });
  await $("simple-ai-toggle").waitFor();
  assert.equal(
    await $("simple-ai-toggle").getAttribute("aria-checked"),
    "false",
  );
  assert.match(await $("simple-lede").innerText(), /完全免费/);
  await $("simple-ai-toggle").click();
  assert.equal(
    await $("simple-ai-toggle").getAttribute("aria-checked"),
    "true",
  );
  assert.match(await $("simple-lede").innerText(), /按次付费/);
  assert.match(
    await $("simple-ai-toggle").innerText(),
    /腾讯云 TokenHub，按次付费/,
  );
  // a scene is a paid request now: asked first; 取消 sends nothing
  await page.locator('[data-testid="scene-card"][data-scene="tech"]').click();
  await $("dialog-paid").waitFor();
  await sleep(600);
  await $("dialog-choice-cancel").click();
  await $("dialog-paid").waitFor({ state: "detached" });
  assert.equal(await paid(), 0, "nothing was paid for");
  assert.equal(await $("scene-card").count(), 12, "back on the scenes");
  await page.locator('[data-testid="scene-card"][data-scene="tech"]').click();
  await $("dialog-paid").waitFor();
  await sleep(600);
  await $("dialog-choice-confirm").click();
  await page.waitForSelector(
    '[data-testid="simple-result"][data-audio="mix"]',
    { timeout: 60000 },
  );
  await $("simple-progress").waitFor({ state: "detached", timeout: 60000 });
  assert.equal(await paid(), 1);
  assert.match(await $("simple-summary").innerText(), /AI 服务生成/);
  await $("simple-paid").waitFor();
  // a tweak of a paid piece is a new paid request: asked again
  await $("tweak-slower").click();
  await $("dialog-paid").waitFor();
  await sleep(600);
  await $("dialog-choice-cancel").click();
  await $("dialog-paid").waitFor({ state: "detached" });
  assert.equal(await paid(), 1, "取消: nothing was sent");
  // 下载音乐: the bytes exactly as the service sent them, named by the title
  const title = await $("simple-title").inputValue();
  await $("simple-download").click();
  await until(
    () => page.evaluate(() => window.__saved.length),
    (count) => count === 1,
    "the file was handed to the save dialog",
  );
  const saved = await page.evaluate(() => window.__saved[0]);
  assert.deepEqual(saved, { name: title, format: "mp3", bytes: mp3.length });
  // a paid result whose save fails: the same banner and question as 专业模式
  await page.evaluate(() => {
    window.__putFailures = 99;
  });
  await $("tweak-slower").click();
  await $("dialog-paid").waitFor();
  await sleep(600);
  await $("dialog-choice-confirm").click();
  await page.waitForSelector(
    '[data-testid="simple-result"][data-revision="2"][data-audio="mix"]',
    { timeout: 60000 },
  );
  assert.equal(await paid(), 2);
  await $("unsaved-banner").waitFor();
  assert.match(
    await $("unsaved-banner").innerText(),
    /付费生成，但还没有保存到「我的音乐」/,
  );
  await $("simple-restart").click();
  await $("dialog-unsaved").waitFor();
  await page.keyboard.press("Escape");
  await $("dialog-unsaved").waitFor({ state: "detached" });
  assert.equal(
    await $("simple-result").getAttribute("data-revision"),
    "2",
    "the paid result stays on screen",
  );
  await $("unsaved-export").click();
  await until(
    () => page.evaluate(() => window.__saved.length),
    (count) => count === 2,
    "the original audio was handed to the save dialog",
  );
  await page.evaluate(() => {
    window.__putFailures = 0;
  });
  await $("retry-save").click();
  await $("unsaved-banner").waitFor({ state: "detached" });
  await context.close();
  assert.deepEqual(problems, [], "console errors in the desktop renderer");
  return { saved: saved.format };
}

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
    await context.addInitScript(proMode);
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
    // UX-04: a loop is fitted to whole bars; 15 s at 80 BPM is not 15 s of audio, and the line
    // says what it will be before anything is made. (How many bars the composer picks is its
    // own business: every later statement is held against this one and against the audio.)
    const fitted =
      /^将创作：慵懒松弛 · 80 BPM · .* · (\d+(?:\.\d)?) 秒（设定 15 秒） · 循环片段$/.exec(
        preview,
      )?.[1];
    assert.ok(fitted, preview);
    assert.notEqual(fitted, "15");
    assert.equal(
      (Number(fitted) * 80) % 240,
      0,
      `${fitted} s at 80 BPM is a whole number of bars`,
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
    assert.equal(duration1, Number(fitted));
    assert.equal(
      (await $("fit-notice").innerText()).trim(),
      `设定 15 秒；循环片段按整小节对齐，实际是 ${fitted} 秒`,
    );
    assert.ok(
      (await $("time-display").innerText()).endsWith(`/ ${clock(duration1)}`),
      await $("time-display").innerText(),
    );
    const said1 = await frame
      .locator('[data-testid="thread-turn"][data-role="agent"] .turn-text')
      .first()
      .innerText();
    assert.ok(
      said1.endsWith(`${fitted} 秒，循环片段。`),
      `the producer names the length of the audio and the structure as the rest of the interface does: ${said1}`,
    );
    assert.doesNotMatch(said1, /15 秒/);
    const chips1 = await frame
      .locator(
        '[data-testid="thread-turn"][data-role="agent"] .turn-reasons li',
      )
      .allInnerTexts();
    assert.ok(chips1.includes("按你的设定：15 秒"), JSON.stringify(chips1));
    assert.ok(
      chips1.includes(`循环片段按整小节对齐：实际 ${fitted} 秒（设定 15 秒）`),
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
    // FQ-05: an inspector edit that was not applied is part of what a reload brings back.
    await $("inspector-reverb").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const pendingReverb = await $("inspector-reverb").inputValue();
    assert.equal(
      await frame.locator('[data-testid="changed-reverb"]').count(),
      1,
    );
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
    assert.equal(
      await $("inspector-reverb").inputValue(),
      pendingReverb,
      "v0.3.0: the words came back, the unapplied edit was gone",
    );
    assert.equal(
      await frame.locator('[data-testid="changed-reverb"]').count(),
      1,
    );
    assert.match(await $("apply-draft").innerText(), /应用调整（1 项）/);
    assert.notEqual(
      String(Math.round(third.config.reverb * 100)),
      pendingReverb,
      "pending is pending: the stored work is as it was",
    );
    await $("reset-reverb").click();
    assert.equal(
      await frame.locator('[data-testid="changed-reverb"]').count(),
      0,
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
    // It was the work that is open in the studio: it leaves the studio too.
    await $("mini-transport").waitFor({ state: "detached" });
    await $("toast-action").click();
    assert.equal(await cards.count(), 4);
    // FQ-14: 撤销 puts it back where it was — in the studio as well (v0.3.0 said 已恢复 and
    // left the studio empty), paused, with its mix and the words typed for it; the page stays.
    await $("mini-transport").waitFor({ timeout: 120000 });
    await idle();
    assert.equal(
      await $("library-page").count(),
      1,
      "the page the user is on stays",
    );
    assert.equal(
      await pressed("mini-play"),
      "false",
      "it does not start playing",
    );
    await $("nav-studio").click();
    await frame.waitForSelector(
      `[data-testid="player-card"][data-project="${third.id}"][data-audio="stems"]`,
    );
    assert.equal(await $("composer-input").inputValue(), "再明亮一点");
    assert.equal(await $("mixer-melody-fader").inputValue(), "30");
    await $("nav-library").click();
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
    // The work from step 8 is loaded (撤销 brought it back in step 9). The words typed for it
    // stay with it: the new-piece composer starts empty, and gets a half-written description.
    await $("new-piece").click();
    await $("studio-empty").waitFor();
    assert.equal(
      await $("composer-input").inputValue(),
      "",
      "the words typed for the work stay with that work",
    );
    await $("composer-input").fill("写了半句的描述");
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
    // It wipes nothing either: the description that was being written is untouched.
    assert.equal(await $("composer-input").inputValue(), "写了半句的描述");
    await $("composer-input").fill("");
    // NEW-03: the hint says the pin is enough — the style's blurb is not repeated in it
    // (it stands next to 风格) — and sits inside the box, in line with the preview above it.
    assert.equal(
      (await $("style-hint").innerText()).trim(),
      "已选「国风古韵」风格，可以直接生成，也可以再写几句想要的画面。",
    );
    assert.deepEqual(
      await frame.evaluate(() => {
        const hint = document.querySelector('[data-testid="style-hint"]');
        const box = document
          .querySelector(".composer-box")
          .getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(hint);
        const words = text.getBoundingClientRect();
        const preview = document
          .querySelector('[data-testid="plan-preview"] span')
          .getBoundingClientRect();
        return {
          inset:
            words.left - box.left >= 12 &&
            box.right - words.right >= 12 &&
            box.bottom - words.bottom >= 8,
          aligned: Math.abs(words.left - preview.left) <= 1,
        };
      }),
      { inset: true, aligned: true },
    );
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
    await phoneContext.addInitScript(proMode);
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

    /* 11b — 简单模式, the default: in the frame, on a phone, with a paid service */
    step = "simple mode";
    const simple = await simpleJourney(
      browser,
      server.origin,
      watch,
      downloads,
    );
    const simplePhoneCsp = await simplePhone(browser, server.origin, watch);
    pass(
      "简单模式 (default): scene → plays → 快一点 → plain change line → 撤销 → 下载音乐 (48 kHz WAV) → 我的音乐 (one card, plays, delete + 撤销) → 专业模式 and back; phone layout",
      { change: simple.change, seconds: simple.seconds },
    );
    if (fs.existsSync(path.join(DESKTOP_DIST, "index.html"))) {
      step = "simple mode: paid service";
      pass(
        "简单模式 with an AI service: off by default, every paid request asked first, 下载音乐 saves the original, an unsaved paid result keeps its banner and question",
        await simpleCloud(browser, server.origin),
      );
    }

    /* 12 — clean: no console errors, nothing but the static files requested */
    step = "clean";
    const csp = [
      ...(await frame.evaluate(() => window.__csp)),
      ...phoneCsp,
      ...simple.csp,
      ...simplePhoneCsp,
    ];
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
