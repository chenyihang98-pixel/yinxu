"use strict";

// Shared by scripts/ui-smoke.cjs, scripts/cloud-workflow.cjs and
// scripts/packaged-smoke.cjs: launches the app in Electron (through Playwright)
// with a throw-away profile — from source, from a packaged "Muse BGM.exe", or
// from the portable self-extractor.
//
// A small module is loaded into the MAIN process: preloaded before the app's
// own main file when running from source (`electron -r <file> .`), installed
// through the inspector right after launch for a packaged build (which takes
// no -r). It
//   - replaces the native save dialog, the "close anyway?" message box, the
//     context menu and shell.openExternal with recorders, so nothing ever opens
//     on the tester's desktop (the message box answers "仍然关闭" unless a test
//     sets state.closeAnswer to 0, so a run can always be shut down);
//   - cancels and records every http(s)/ws request Chromium itself would make,
//     on the default session and on the session reserved for billable requests;
//   - with { mock: true } replaces globalThis.fetch by fixtures for the music
//     services and the language models (the app is started with
//     MUSE_NETWORK=node, so every main-process request goes through it).
// Nothing in here ever reaches a real service; `state.unknown` and
// `state.denied` must be empty at the end of a run. The one request the app
// makes on its own — the warm-up of a local model when its settings are saved
// — is recorded in `state.warmUps` and stopped here unless allowLoopback is set.
const { _electron: electron, chromium } = require("playwright");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const RESULTS = path.join(ROOT, "test-results");
const { BILLING_PARTITION } = require(
  path.join(ROOT, "electron", "net-fetch.cjs"),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `read` until `test` accepts its value. For things that have no event to wait for. */
async function until(read, test, description, timeout = 30000, every = 100) {
  const deadline = Date.now() + timeout;
  let value;
  for (;;) {
    value = await read();
    if (test(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `timed out: ${description}; last value: ${JSON.stringify(value)}`,
      );
    await sleep(every);
  }
}

/** A plan the mocked language models answer with unless a test queues another one. */
const DEFAULT_PLAN = Object.freeze({
  reasoning: ["雨天咖啡馆：慵懒、温暖", "不要鼓：鼓组设为无"],
  style: "jazz",
  instrument: "vibes",
  key: "F major",
  bpm: 84,
  duration: 15,
  energy: 0.35,
  complexity: 0.6,
  reverb: 0.35,
  loop: true,
  newMelody: true,
  volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
  arrangement: {
    progression: ["ii7", "V7", "Imaj7", "vi7"],
    form: [],
    drums: "none",
    bass: "walking",
    swing: 0.4,
    layers: { pad: true, arp: false, counter: false, perc: false },
    melody: { density: -1, register: "mid", motion: "stepwise" },
  },
  title: "雨天特调",
  reply: "好的，做一首不带鼓的慵懒爵士，像雨天窝在咖啡馆里。",
  cloudPrompt:
    "慵懒的咖啡馆爵士，颤音琴主奏，行走贝斯，84 BPM，纯音乐，无人声，无歌词。",
});

function mainPreloadSource({ mock, allowLoopback }) {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, session, dialog, shell, Menu } = require('electron');
const root = ${JSON.stringify(ROOT)};
const fixture = name => fs.readFileSync(path.join(root, 'tests', 'fixtures', name));
const state = globalThis.__museTest = {
  requests: [], unknown: [], denied: [], loopback: [], warmUps: [], dialogs: [], opened: [],
  // "close anyway?" questions asked, and the button the next one is answered with (0 stay, 1 leave)
  messageBoxes: [], closeAnswer: 1,
  // context menus the app wanted to show: one list of items per right click
  menus: [],
  savePath: null,
  tencent: { fail: 0, hang: false, delay: 150, garbage: false },
  // pollFail: an HTTP status every status query is answered with (0: the task runs and finishes as usual)
  volc: { polls: 0, pollsNeeded: 2, pollFail: 0 },
  aliyun: { fail: 0, downloadFail: 0 },
  llm: { plans: [], fail: 0, failAlways: 0, hang: false, delay: 100, calls: 0 },
  defaultPlan: ${JSON.stringify(DEFAULT_PLAN)},
};
dialog.showSaveDialog = async (_window, options) => {
  state.dialogs.push({ title: options.title, defaultPath: options.defaultPath, filters: options.filters });
  return state.savePath ? { canceled: false, filePath: state.savePath } : { canceled: true };
};
shell.openExternal = async url => { state.opened.push(String(url)); };
dialog.showMessageBox = async (...args) => {
  const options = args[args.length - 1] || {};
  state.messageBoxes.push({ message: options.message, detail: options.detail, buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId, type: options.type, modal: args.length > 1 });
  return { response: state.closeAnswer, checkboxChecked: false };
};
Menu.prototype.popup = function () {
  state.menus.push(this.items.map(item => ({ label: item.label, role: item.role, enabled: item.enabled, type: item.type })));
};
const realFetch = globalThis.fetch;
/** The app's warm-up of a local model: one token from /chat/completions on this computer. */
const isWarmUp = (url, method, body) => method === 'POST' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname.endsWith('/chat/completions') && Boolean(body) && body.max_tokens === 1;
const noteWarmUp = (url, body) => state.warmUps.push({ url: url.href, model: body.model, roles: Array.isArray(body.messages) ? body.messages.map(message => message.role) : [] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
/** Resolves after ms (never, for Infinity); rejects as soon as the request is aborted. */
const abortable = (signal, ms) => new Promise((resolve, reject) => {
  const aborted = () => signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
  if (signal?.aborted) { reject(aborted()); return; }
  const timer = ms === Infinity ? null : setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { if (timer) clearTimeout(timer); reject(aborted()); }, { once: true });
});
async function llmAnswer(options, wrap) {
  state.llm.calls++;
  if (state.llm.hang) await abortable(options.signal, Infinity);
  await abortable(options.signal, state.llm.delay);
  if (state.llm.fail || state.llm.failAlways) {
    const status = state.llm.failAlways || state.llm.fail;
    state.llm.fail = 0;
    return json({ type: 'error', error: { type: 'api_error', message: 'fixture failure' } }, status);
  }
  return wrap(state.llm.plans.length ? state.llm.plans.shift() : state.defaultPlan);
}
const mockFetch = async (rawUrl, options = {}) => {
  const url = new URL(typeof rawUrl === 'string' ? rawUrl : rawUrl instanceof URL ? rawUrl.href : String(rawUrl.url));
  const headers = Object.fromEntries(new Headers(options.headers).entries());
  let body = null;
  if (typeof options.body === 'string') { try { body = JSON.parse(options.body); } catch { body = options.body; } }
  if (!${JSON.stringify(Boolean(allowLoopback))} && isWarmUp(url, options.method, body)) {
    noteWarmUp(url, body);
    return json({ model: body.model, choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }] });
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]') {
    state.loopback.push(url.href);
    if (${JSON.stringify(Boolean(allowLoopback))}) return realFetch(rawUrl, options);
    state.unknown.push(url.href);
    throw new Error('Loopback request in a mocked run');
  }
  state.requests.push({ url: url.href, method: options.method || 'GET', headers, body });
  options.signal?.throwIfAborted();
  if (url.href === 'https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation') {
    if (state.tencent.hang) await abortable(options.signal, Infinity);
    await abortable(options.signal, state.tencent.delay);
    if (state.tencent.fail) { const status = state.tencent.fail; state.tencent.fail = 0; return json({ error: 'fixture unauthorized' }, status); }
    const audio = state.tencent.garbage ? Buffer.from('ID3 not really audio: bytes that pass the type sniffing and fail to decode') : fixture('music-3s.mp3');
    return json({ data: { audio: audio.toString('hex'), status: 2 }, base_resp: { status_code: 0, status_msg: 'success' }, extra_info: { music_duration: 3000 }, trace_id: 'fixture-tencent' });
  }
  if (url.hostname === 'open.volcengineapi.com') {
    const action = url.searchParams.get('Action');
    if (action === 'GenBGMForTime' || action === 'GenBGM') { state.volc.polls = 0; return json({ Code: 0, Result: { TaskID: 'fixture-volc-task' } }); }
    if (action === 'QuerySong') {
      if (state.volc.pollFail) return new Response('fixture: the status service is down', { status: state.volc.pollFail });
      state.volc.polls++;
      return state.volc.polls < state.volc.pollsNeeded
        ? json({ Code: 0, Result: { Status: 1 } })
        : json({ Code: 0, Result: { Status: 2, SongDetail: { AudioUrl: 'https://v3-default.douyinvod.com/muse-fixture.m4a', Duration: 3 } } });
    }
  }
  if (url.href === 'https://v3-default.douyinvod.com/muse-fixture.m4a') return new Response(fixture('music-3s.m4a'), { status: 200, headers: { 'Content-Type': 'audio/mp4' } });
  if (url.href === 'https://llm-cloud-fixture.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation') {
    if (state.aliyun.fail) { const status = state.aliyun.fail; state.aliyun.fail = 0; return json({ code: 'InvalidApiKey', message: 'fixture', request_id: 'fixture-aliyun-req' }, status); }
    return json({ request_id: 'fixture-aliyun', output: { finish_reason: 'stop', audio: { url: 'https://muse-fixture.oss-cn-beijing.aliyuncs.com/music.wav' } } });
  }
  if (url.href === 'https://muse-fixture.oss-cn-beijing.aliyuncs.com/music.wav') {
    if (state.aliyun.downloadFail > 0) { state.aliyun.downloadFail--; return new Response('fixture: storage is busy', { status: 503 }); }
    return new Response(fixture('music-3s.wav'), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  }
  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
    return llmAnswer(options, plan => json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body?.model || 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(plan) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
  }
  if (url.pathname.endsWith('/chat/completions')) {
    return llmAnswer(options, plan => json({ id: 'chatcmpl-fixture', object: 'chat.completion', model: body?.model || 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(plan) } }] }));
  }
  state.unknown.push(url.href);
  throw new Error('Unrecognized mock URL: live network prohibited');
};
if (${JSON.stringify(Boolean(mock))}) globalThis.fetch = mockFetch;
app.whenReady().then(() => {
  const guard = (details, callback) => {
    let host = '';
    try { host = new URL(details.url).hostname; } catch { /* recorded as denied below */ }
    if (${JSON.stringify(Boolean(allowLoopback))} && host === '127.0.0.1') { state.loopback.push(details.url); callback({}); return; }
    try {
      const body = JSON.parse(Buffer.from(details.uploadData?.[0]?.bytes ?? []).toString('utf8') || 'null');
      if (isWarmUp(new URL(details.url), details.method, body)) { noteWarmUp(new URL(details.url), body); callback({ cancel: true }); return; }
    } catch { /* not a warm-up: denied below */ }
    state.denied.push(details.url);
    callback({ cancel: true });
  };
  // The app's ordinary requests and its billable submissions use different sessions: watch both.
  for (const watched of [session.defaultSession, session.fromPartition(${JSON.stringify(BILLING_PARTITION)})]) {
    watched.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, guard);
  }
});
`;
}

function removeProfile(profile, prefix) {
  // Only ever a directory this harness created under the OS temp directory.
  const resolved = path.resolve(profile);
  if (
    path.dirname(resolved) === path.resolve(os.tmpdir()) &&
    path.basename(resolved).startsWith(prefix)
  )
    fs.rmSync(resolved, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150,
    });
}

/** Runs in the main process: loads the test module with the app's own require. */
const installHooks = (_electron, source) => {
  // eslint-disable-next-line no-new-func
  new Function("require", source)(
    process.mainModule.require.bind(process.mainModule),
  );
};

function launchEnvironment(profile, mock) {
  const env = {
    ...process.env,
    MUSE_PORTABLE_DATA: "1",
    PORTABLE_EXECUTABLE_DIR: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MUSE_DEV_URL;
  delete env.MUSE_NETWORK;
  if (mock) env.MUSE_NETWORK = "node";
  return env;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A minimal client for the Node inspector of a main process Playwright did not start. */
async function inspectorClient(port) {
  const targets = await until(
    async () => {
      try {
        return await (
          await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(1000),
          })
        ).json();
      } catch {
        return null;
      }
    },
    (list) => Array.isArray(list) && Boolean(list[0]?.webSocketDebuggerUrl),
    "the main-process inspector",
    60000,
    200,
  );
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () =>
        reject(new Error("could not connect to the main-process inspector")),
      { once: true },
    );
  });
  let lastId = 0;
  const waiting = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of waiting.values())
      entry.reject(new Error("the main process is gone"));
    waiting.clear();
  });
  const send = (method, params) => {
    const id = ++lastId;
    const answer = new Promise((resolve, reject) =>
      waiting.set(id, { resolve, reject }),
    );
    socket.send(JSON.stringify({ id, method, params }));
    return answer;
  };
  // The inspector answers while Node is still starting. An expression sent then
  // runs in the middle of the bootstrap, where there is no main module yet
  // ("Cannot read properties of undefined (reading 'require')"): wait for it.
  await until(
    async () =>
      (
        await send("Runtime.evaluate", {
          expression:
            "typeof process === 'object' && Boolean(process.mainModule && process.mainModule.require)",
          returnByValue: true,
        })
      ).result?.value === true,
    Boolean,
    "the main module of the packaged app",
    60000,
    25,
  );
  /** (electronModule, argument) => value, like Playwright's electronApplication.evaluate. */
  const evaluate = async (fn, argument) => {
    const expression = `(${fn.toString()})(process.mainModule.require('electron'), ${JSON.stringify(argument ?? null)})`;
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  return { evaluate, close: () => socket.close() };
}

/**
 * Start the app. Options:
 *   prefix         name prefix of the temp profile (required, e.g. "muse-ui-smoke-")
 *   profile        reuse a profile from an earlier launch (a relaunch of "the same installation")
 *   mock           replace the main-process fetch by fixtures
 *   allowLoopback  let requests to 127.0.0.1 through (a real local model)
 *   args           extra Electron switches
 *   executable     a packaged "Muse BGM.exe" to start instead of the source tree
 *   portable       the portable self-extractor to start instead (it is copied into the
 *                  profile first: the wrapper keeps its data next to itself)
 */
async function launchApp(options) {
  const {
    prefix,
    mock = false,
    allowLoopback = false,
    args = [],
    executable = null,
    portable = null,
  } = options;
  if (!prefix || !prefix.startsWith("muse-"))
    throw new Error(
      'launchApp needs a profile prefix that starts with "muse-"',
    );
  if (
    !executable &&
    !portable &&
    !fs.existsSync(path.join(ROOT, "dist", "index.html"))
  )
    throw new Error("dist/index.html is missing. Run `npm run build` first.");
  const profile =
    options.profile ?? fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const hooks = mainPreloadSource({ mock, allowLoopback });
  const env = launchEnvironment(profile, mock);
  let desktop = null;
  let page;
  let main;
  let quit;
  if (portable) {
    // The NSIS wrapper unpacks the app, sets PORTABLE_EXECUTABLE_DIR to its own
    // folder and passes the switches on. Playwright cannot drive it (the app is
    // a grandchild), so both debugging ports are opened by hand.
    const wrapper = path.join(profile, path.basename(portable));
    if (!fs.existsSync(wrapper)) fs.copyFileSync(portable, wrapper);
    const [inspectPort, pagePort] = [await freePort(), await freePort()];
    const child = spawn(
      wrapper,
      [
        ...args,
        `--inspect=127.0.0.1:${inspectPort}`,
        `--remote-debugging-port=${pagePort}`,
        "--remote-debugging-address=127.0.0.1",
      ],
      { cwd: profile, env, windowsHide: true, stdio: "ignore" },
    );
    const killTree = () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const killer = spawn(
          "taskkill.exe",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.once("exit", resolve);
        killer.once("error", resolve);
      });
    try {
      const inspector = await inspectorClient(inspectPort);
      main = inspector.evaluate;
      await main(installHooks, hooks);
      const endpoint = await until(
        async () => {
          try {
            return await (
              await fetch(`http://127.0.0.1:${pagePort}/json/version`, {
                signal: AbortSignal.timeout(1000),
              })
            ).json();
          } catch {
            return null;
          }
        },
        (value) => Boolean(value?.webSocketDebuggerUrl),
        "the window of the portable build",
        60000,
        200,
      );
      const browser = await chromium.connectOverCDP(
        endpoint.webSocketDebuggerUrl,
      );
      page = await until(
        async () =>
          browser
            .contexts()
            .flatMap((context) => context.pages())
            .find((candidate) => candidate.url().startsWith("file:")) ?? null,
        Boolean,
        "the page of the portable build",
        30000,
        200,
      );
      quit = async () => {
        await Promise.race([
          main(({ app }) => {
            setTimeout(() => app.quit(), 0);
          }).catch(() => {}),
          sleep(3000),
        ]);
        inspector.close();
        await Promise.race([browser.close().catch(() => {}), sleep(3000)]);
        await until(
          async () => child.exitCode,
          (code) => code !== null,
          "the portable build exits",
          20000,
          200,
        ).catch(killTree);
      };
    } catch (error) {
      await killTree();
      throw error;
    }
  } else if (executable) {
    desktop = await electron.launch({
      executablePath: executable,
      args: [...args],
      cwd: path.dirname(executable),
      env,
      timeout: 60000,
    });
    main = (fn, argument) => desktop.evaluate(fn, argument);
    await main(installHooks, hooks);
    page = await desktop.firstWindow();
    quit = () => desktop.close();
  } else {
    const preload = path.join(profile, "main-preload.cjs");
    fs.writeFileSync(preload, hooks);
    desktop = await electron.launch({
      args: [...args, "-r", preload, ROOT],
      cwd: ROOT,
      env,
      timeout: 30000,
    });
    main = (fn, argument) => desktop.evaluate(fn, argument);
    page = await desktop.firstWindow();
    quit = () => desktop.close();
  }
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) =>
    errors.push(`pageerror: ${error?.message || error}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.waitForFunction(
    () =>
      Boolean(window.museDesktop) &&
      Boolean(document.querySelector('[data-testid="nav-studio"]')),
    null,
    { timeout: 30000 },
  );

  const app = { desktop, page, profile, prefix, errors };
  app.$ = (id) => page.locator(`[data-testid="${id}"]`);
  /** Run a function in the main process: (electronModule, argument) => value. */
  app.main = main;
  app.state = () => main(() => globalThis.__museTest);
  /** Deep-merge a patch into the main-process test state. */
  app.setState = (patch) =>
    main((_electron, value) => {
      const merge = (target, source) => {
        for (const [key, item] of Object.entries(source)) {
          if (
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            target[key] &&
            typeof target[key] === "object" &&
            !Array.isArray(target[key])
          )
            merge(target[key], item);
          else target[key] = item;
        }
      };
      merge(globalThis.__museTest, value);
    }, patch);
  app.settings = () => page.evaluate(() => window.museDesktop.getSettings());
  /** Stored works, newest first, without their audio (blobType / blobBytes describe it). */
  app.records = () =>
    page.evaluate(
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
              resolve(
                query.result
                  .map(({ audioBlob, ...meta }) => ({
                    ...meta,
                    ...(audioBlob
                      ? { blobType: audioBlob.type, blobBytes: audioBlob.size }
                      : {}),
                  }))
                  .sort((a, b) =>
                    String(b.updatedAt).localeCompare(String(a.updatedAt)),
                  ),
              );
            query.onerror = () => reject(query.error);
            tx.oncomplete = () => database.close();
          };
        }),
    );
  /** No job is running. */
  app.idle = (timeout = 120000) =>
    page.waitForSelector('[data-testid="job-status"]', {
      state: "detached",
      timeout,
    });
  /** The work with this revision is loaded (kind: stems | mix | none) and saved. */
  app.loaded = async (revision, kind = "stems", timeout = 120000) => {
    await page.waitForSelector(
      `[data-testid="player-card"][data-revision="${revision}"][data-audio="${kind}"]`,
      { timeout },
    );
    await app.idle(timeout);
    await page.waitForSelector(
      '[data-testid="save-state"][data-state="saved"]',
      { timeout: 20000 },
    );
  };
  app.toasts = () =>
    page.locator('[data-testid="toast"] > span').allInnerTexts();
  /** Dismiss every toast on screen, so the next assertion only sees new ones. */
  app.clearToasts = async () => {
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
  /** Wait for a toast that matches; returns its text. */
  app.toast = async (pattern, timeout = 20000) => {
    const list = await until(
      app.toasts,
      (texts) => texts.some((text) => pattern.test(text)),
      `toast ${pattern}`,
      timeout,
    );
    return list.find((text) => pattern.test(text));
  };
  /** The next save dialog answers with this path (null: the user cancels). */
  app.saveTo = async (file) => {
    if (file) fs.rmSync(file, { force: true });
    await app.setState({ savePath: file });
  };
  /**
   * Click an export option and answer the save dialog with `file` (null: cancel).
   * Resolves when the export has finished — the option is enabled again only
   * after the main process has written the whole file — with the bytes on disk.
   */
  app.exportVia = async (optionId, file, timeout = 60000) => {
    const option = `[data-testid="export-option-${optionId}"]`;
    const dialogs = (await app.state()).dialogs.length;
    await app.saveTo(file);
    await page.click(option);
    await until(
      app.state,
      (state) => state.dialogs.length > dialogs,
      `save dialog for ${optionId}`,
      timeout,
    );
    await page.waitForSelector(`${option}:not([disabled])`, { timeout });
    return file ? fs.readFileSync(file) : null;
  };
  app.openSettings = async (tab) => {
    if (!(await app.$("settings-modal").count()))
      await app.$("settings-button").click();
    await app.$("settings-modal").waitFor();
    if (tab) await app.$(`settings-tab-${tab}`).click();
  };
  app.closeModal = async () => {
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', {
      state: "detached",
      timeout: 5000,
    });
  };
  /** 新建创作: back to the empty composer. */
  app.newPiece = async () => {
    if (await app.$("studio-empty").count()) return;
    await app.$("new-piece").click();
    await app.$("studio-empty").waitFor();
  };
  app.reload = async () => {
    await page.reload();
    await page.waitForFunction(
      () =>
        Boolean(window.museDesktop) &&
        Boolean(document.querySelector('[data-testid="nav-studio"]')),
    );
  };
  /** Quit the app. The profile is removed unless it is needed for a relaunch. */
  app.close = async ({ keepProfile = false } = {}) => {
    await Promise.resolve(quit()).catch(() => {});
    if (!keepProfile) removeProfile(profile, prefix);
  };
  return app;
}

/* ---------- a throw-away TLS certificate, for suites that stand in for a vendor's HTTPS endpoint ---------- */

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  if (body.length < 0x80)
    return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const size = [];
  for (let rest = body.length; rest > 0; rest >>= 8) size.unshift(rest & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | size.length, ...size]), body]);
}
function derOid(text) {
  const [first, second, ...rest] = text.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (let value of rest) {
    const chunk = [value & 0x7f];
    for (value >>= 7; value > 0; value >>= 7)
      chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
const derTime = (date) =>
  der(
    0x17,
    Buffer.from(
      `${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`,
      "ascii",
    ),
  );

/**
 * A self-signed certificate (ECDSA P-256, valid for a day) made with node:crypto
 * alone, so the suites need no openssl binary. Returns PEM `key` and `cert` for
 * a Node TLS server plus `fingerprint` in the form Electron reports
 * (certificate.fingerprint), so a test can trust exactly this certificate.
 */
function selfSignedCertificate({
  names = ["localhost"],
  addresses = ["127.0.0.1"],
} = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const algorithm = der(0x30, derOid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const name = der(
    0x30,
    der(
      0x31,
      der(
        0x30,
        derOid("2.5.4.3"),
        der(0x0c, Buffer.from("muse-test-server", "utf8")),
      ),
    ),
  );
  const altNames = der(
    0x30,
    ...names.map((host) => der(0x82, Buffer.from(host, "ascii"))),
    ...addresses.map((address) =>
      der(0x87, Buffer.from(address.split(".").map(Number))),
    ),
  );
  const serial = crypto.randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), // X.509 v3
    der(0x02, serial),
    algorithm,
    name,
    der(
      0x30,
      derTime(new Date(Date.now() - 3600_000)),
      derTime(new Date(Date.now() + 24 * 3600_000)),
    ),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, der(0x30, der(0x30, derOid("2.5.29.17"), der(0x04, altNames)))),
  );
  const certificate = der(
    0x30,
    tbs,
    algorithm,
    der(0x03, Buffer.from([0]), crypto.sign("sha256", tbs, privateKey)),
  );
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate
      .toString("base64")
      .match(/.{1,64}/g)
      .join("\n")}\n-----END CERTIFICATE-----\n`,
    fingerprint: `sha256/${crypto.createHash("sha256").update(certificate).digest("base64")}`,
  };
}

/** Facts about a 16-bit PCM WAV file, with the RMS of its samples. */
function wavInfo(bytes) {
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  const dataBytes = bytes.readUInt32LE(40);
  let sum = 0;
  let count = 0;
  for (let offset = 44; offset + 1 < bytes.length; offset += 2 * 8) {
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
    riffSize: bytes.readUInt32LE(4),
    dataBytes,
    fileBytes: bytes.length,
    frames: dataBytes / (channels * (bits / 8)),
    seconds: dataBytes / (sampleRate * channels * (bits / 8)),
    rms: Math.sqrt(sum / Math.max(1, count)),
  };
}

/**
 * Runs named steps in order, stops at the first failure, and writes a JSON
 * report either way. `run.step(name, fn)`: fn may return a detail to record.
 */
function createRun(name, reportFile) {
  const report = {
    suite: name,
    startedAt: new Date().toISOString(),
    ok: false,
    steps: [],
  };
  const started = Date.now();
  return {
    report,
    async step(title, fn) {
      const t0 = Date.now();
      try {
        const detail = await fn();
        const ms = Date.now() - t0;
        report.steps.push({
          name: title,
          ok: true,
          ms,
          ...(detail === undefined ? {} : { detail }),
        });
        console.log(`ok   ${title}  (${(ms / 1000).toFixed(1)} s)`);
      } catch (error) {
        const ms = Date.now() - t0;
        report.steps.push({
          name: title,
          ok: false,
          ms,
          error: String(error?.stack || error),
        });
        console.error(
          `FAIL ${title}  (${(ms / 1000).toFixed(1)} s)\n${String(error?.stack || error)}`,
        );
        throw Object.assign(new Error(`step failed: ${title}`), {
          reported: true,
          cause: error,
        });
      }
    },
    /** Call once, in a finally block. Returns the process exit code. */
    finish(extra = {}) {
      report.ok =
        report.steps.length > 0 &&
        report.steps.every((step) => step.ok) &&
        !extra.error;
      report.seconds = +((Date.now() - started) / 1000).toFixed(1);
      Object.assign(report, extra);
      fs.mkdirSync(RESULTS, { recursive: true });
      fs.writeFileSync(
        path.join(RESULTS, reportFile),
        JSON.stringify(report, null, 2),
      );
      const passed = report.steps.filter((step) => step.ok).length;
      console.log(
        report.ok
          ? `${name} passed: ${passed} steps in ${report.seconds} s`
          : `${name} FAILED after ${passed} passed step(s), ${report.seconds} s — see test-results/${reportFile}`,
      );
      return report.ok ? 0 : 1;
    },
  };
}

/** On failure: a screenshot plus what the page is showing, for the console. */
async function describeFailure(app, name) {
  if (!app || app.page.isClosed()) return {};
  const file = path.join(RESULTS, `${name}-failure.png`);
  fs.mkdirSync(RESULTS, { recursive: true });
  await app.page.screenshot({ path: file }).catch(() => {});
  const toasts = await app.toasts().catch(() => []);
  const alerts = await app.page
    .locator('[role="alert"]')
    .allInnerTexts()
    .catch(() => []);
  const state = await app.state().catch(() => null);
  console.error("toasts:", JSON.stringify(toasts));
  console.error("alerts:", JSON.stringify(alerts));
  console.error("renderer errors:", JSON.stringify(app.errors));
  if (state)
    console.error(
      "network:",
      JSON.stringify({
        unknown: state.unknown,
        denied: state.denied,
        requests: state.requests.length,
      }),
    );
  return { screenshot: path.relative(ROOT, file), toasts, alerts };
}

module.exports = {
  ROOT,
  RESULTS,
  DEFAULT_PLAN,
  BILLING_PARTITION,
  sleep,
  until,
  launchApp,
  removeProfile,
  selfSignedCertificate,
  wavInfo,
  createRun,
  describeFailure,
};
