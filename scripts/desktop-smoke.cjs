"use strict";

// Launch the compiled UI with a disposable profile and exercise the desktop bridge.
// No AI service is contacted and no real key is used: the only HTTP goes to servers
// on 127.0.0.1 started by this script - a mock "local model", and (in a launch of its own)
// stand-ins for two music services, reached through the app's real network path by
// mapping the vendors' host names to this computer for that one Electron process.
// Run `npm run build` first. Optional MUSE_SCREENSHOT_PATH captures the initial UI.
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const http2 = require("node:http2");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const {
  selfSignedCertificate,
  until,
  ensureMode,
  BILLING_PARTITION,
} = require("../tests/helpers/electron-harness.cjs");

const BRIDGE_KEYS = [
  "agentPlan",
  "cancelAgent",
  "cancelGeneration",
  "deleteLlmSettings",
  "deleteProviderCredentials",
  "discardPendingResult",
  "generateMusic",
  "getSettings",
  "openExternal",
  "retryLastDownload",
  "saveAudio",
  "saveLlmSettings",
  "saveProviderCredentials",
  "setUnsavedWork",
];
const CURRENT = {
  style: "bright",
  instrument: "piano",
  key: "C major",
  bpm: 112,
  duration: 30,
  energy: 0.62,
  complexity: 0.5,
  reverb: 0.25,
  loop: true,
  volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
};
const PLAN_INPUT = {
  mode: "new",
  request: "雨天咖啡馆里的慵懒爵士，一分钟，不要鼓",
  provider: "local",
  history: [],
  current: CURRENT,
};
const MOCK_PLAN = {
  reasoning: ["雨天咖啡馆：慵懒、温暖", "不要鼓：drums 设为 none"],
  style: "jazz",
  instrument: "vibes",
  key: "F major",
  bpm: 84,
  duration: 60,
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
  unexpected: "dropped by validation",
};

/** Reject -> message, resolve -> null: lets the test compare the exact text the UI would show. */
const messageOf = (page, expression) =>
  page.evaluate(`(${expression}).then(() => null, error => error.message)`);

async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startMockModel() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
      });
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "tracking=1; Path=/",
      });
      response.end(
        JSON.stringify({
          model: "mock-local-model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: `<think>先想一想</think>\n\`\`\`json\n${JSON.stringify(MOCK_PLAN)}\n\`\`\``,
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, port: server.address().port };
}

// MUSE_SMOKE_EXECUTABLE=<path to a packaged "Muse BGM.exe"> runs the same checks against a packaged build.
const EXECUTABLE = process.env.MUSE_SMOKE_EXECUTABLE
  ? path.resolve(process.env.MUSE_SMOKE_EXECUTABLE)
  : null;

async function launch(root, appPath, profile, switches = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MUSE_DEV_URL;
  delete env.MUSE_NETWORK;
  env.MUSE_PORTABLE_DATA = "1";
  env.PORTABLE_EXECUTABLE_DIR = profile;
  const desktop = EXECUTABLE
    ? await electron.launch({
        executablePath: EXECUTABLE,
        args: [...switches],
        cwd: path.dirname(EXECUTABLE),
        env,
        timeout: 30000,
      })
    : await electron.launch({
        args: [...switches, appPath],
        cwd: appPath,
        env,
        timeout: 30000,
      });
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => Boolean(window.museDesktop), null, {
    timeout: 15000,
  });
  await page.locator("#root").waitFor();
  // these checks drive the v0.3 interface: 专业模式 (a fresh profile starts in 简单模式)
  await ensureMode(page, "pro");
  return { desktop, page };
}

async function removeProfile(profile, prefix) {
  // The resolved directory was created by this script under the OS temp directory.
  const resolved = path.resolve(profile);
  if (
    path.dirname(resolved) === path.resolve(os.tmpdir()) &&
    path.basename(resolved).startsWith(prefix)
  ) {
    await fs.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

async function bridgeChecks(root) {
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "muse-desktop-smoke-"),
  );
  const version = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  ).version;
  const credentialFile = path.join(
    profile,
    "Muse-Data",
    "music-credentials.json",
  );
  const mock = await startMockModel();
  let desktop;
  try {
    const launched = await launch(root, root, profile);
    desktop = launched.desktop;
    const page = launched.page;
    await page.waitForFunction(
      () => document.querySelector("#root")?.textContent?.length > 50,
    );
    const result = await page.evaluate(async () => {
      const settings = await window.museDesktop.getSettings();
      const bridgeKeys = Object.keys(window.museDesktop).sort();
      return {
        settings,
        bridgeKeys,
        nodeExposed:
          typeof window.require !== "undefined" ||
          typeof window.process !== "undefined",
      };
    });
    assert.equal(
      result.nodeExposed,
      false,
      "Node must not be exposed to the renderer",
    );
    assert.deepEqual(result.bridgeKeys, BRIDGE_KEYS);
    assert.deepEqual(Object.keys(result.settings).sort(), [
      "dataPath",
      "llm",
      "pendingResult",
      "providers",
      "version",
    ]);
    assert.equal(
      result.settings.pendingResult,
      null,
      "no paid result is waiting in a fresh start",
    );
    assert.equal(
      path.resolve(result.settings.dataPath),
      path.join(profile, "Muse-Data"),
      "Smoke must use a disposable profile",
    );
    assert.equal(result.settings.version, version);
    assert.deepEqual(result.settings.llm, { configured: false });
    assert.deepEqual(result.settings.providers, {
      elevenlabs: { configured: false },
      tencent: { configured: false },
      volcengine: { configured: false },
      aliyun: { configured: false },
    });
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const prefs =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
        sandbox: prefs.sandbox,
      };
    });
    assert.deepEqual(preferences, {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    // The only runtime dependency of the main process must be loadable from the app (also when packed into app.asar).
    const runtime = await desktop.evaluate(({ app }) => {
      const { createRequire } = process.mainModule.require("node:module");
      const appRequire = createRequire(
        process.mainModule
          .require("node:path")
          .join(app.getAppPath(), "package.json"),
      );
      return {
        packaged: app.isPackaged,
        sdk: typeof appRequire("@anthropic-ai/sdk").Anthropic,
      };
    });
    assert.deepEqual(runtime, {
      packaged: Boolean(EXECUTABLE),
      sdk: "function",
    });

    // Errors reach the renderer as the plain Chinese message, without Electron's IPC prefix.
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.openExternal('https://example.com')`,
      ),
      "此链接未列入允许打开的官方帮助页面。",
    );
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.generateMusic({ prompt: 'test', duration: 30 })`,
      ),
      "请先在设置中填写所选音乐服务的凭据。",
    );

    // Cloud music key: encrypted CRUD.
    const fakeKey = "muse-smoke-only-not-a-real-api-key";
    await page.evaluate(
      (key) =>
        window.museDesktop.saveProviderCredentials("elevenlabs", {
          apiKey: key,
        }),
      fakeKey,
    );
    const storedSettings = await page.evaluate(() =>
      window.museDesktop.getSettings(),
    );
    assert.deepEqual(storedSettings.providers.elevenlabs, {
      configured: true,
      model: "music_v1",
    });
    assert.equal(JSON.stringify(storedSettings).includes(fakeKey), false);
    assert.equal(
      (await fs.readFile(credentialFile, "utf8")).includes(fakeKey),
      false,
      "DPAPI store must not contain a plaintext API key",
    );

    // Producer agent settings: validation, encrypted CRUD, status without the key.
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.agentPlan(${JSON.stringify(PLAN_INPUT)})`,
      ),
      "还没有配置大模型。请先在设置中填写大模型的连接信息。",
    );
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.saveLlmSettings({ kind: 'openai', preset: 'custom', apiKey: 'sk-smoke-only-not-real', model: 'some-model', baseUrl: 'https://127.0.0.1/v1' })`,
      ),
      "接口地址不能指向本机或内网。本机模型请选择「本机 Ollama」。",
    );
    const fakeLlmKey = "sk-ant-smoke-only-not-a-real-key";
    await page.evaluate(
      (key) =>
        window.museDesktop.saveLlmSettings({
          kind: "anthropic",
          preset: "claude",
          apiKey: key,
          model: "claude-opus-5-5",
        }),
      fakeLlmKey,
    );
    const withLlm = await page.evaluate(() => window.museDesktop.getSettings());
    assert.deepEqual(withLlm.llm, {
      configured: true,
      kind: "anthropic",
      model: "claude-opus-5-5",
      preset: "claude",
    });
    assert.deepEqual(
      withLlm.providers.elevenlabs,
      { configured: true, model: "music_v1" },
      "saving LLM settings must not disturb the music credentials",
    );
    const storedFile = await fs.readFile(credentialFile, "utf8");
    assert.equal(
      storedFile.includes(fakeLlmKey),
      false,
      "LLM key must be stored encrypted",
    );
    assert.deepEqual(Object.keys(JSON.parse(storedFile)).sort(), [
      "llm",
      "providers",
      "version",
    ]);
    assert.deepEqual(
      Object.keys(JSON.parse(storedFile).providers),
      ["elevenlabs"],
      "LLM settings stay outside the music providers map",
    );

    // A plan through the whole chain (preload -> IPC guard -> DPAPI store -> agent service ->
    // Chromium network stack -> validation), against the mock local model on 127.0.0.1.
    await page.evaluate(
      (port) =>
        window.museDesktop.saveLlmSettings({
          kind: "ollama",
          preset: "ollama",
          apiKey: "",
          model: "mock-local-model",
          baseUrl: `http://localhost:${port}/v1`,
        }),
      mock.port,
    );
    assert.deepEqual(
      (await page.evaluate(() => window.museDesktop.getSettings())).llm,
      {
        configured: true,
        kind: "ollama",
        model: "mock-local-model",
        preset: "ollama",
        baseUrl: `http://127.0.0.1:${mock.port}/v1`,
      },
    );
    // Saving a local model warms it up in the background: one request for a single token, answer discarded.
    for (
      let waited = 0;
      mock.requests.length < 1 && waited < 5000;
      waited += 50
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      mock.requests.length,
      1,
      "the warm-up reached the local model",
    );
    assert.equal(mock.requests[0].url, "/v1/chat/completions");
    assert.equal(mock.requests[0].method, "POST");
    assert.equal(mock.requests[0].body.model, "mock-local-model");
    assert.equal(mock.requests[0].body.max_tokens, 1);
    assert.deepEqual(
      mock.requests[0].body.messages.map((message) => message.role),
      ["system", "user"],
    );
    assert.equal(mock.requests[0].headers.authorization, undefined);
    const planned = await page.evaluate(
      (input) => window.museDesktop.agentPlan(input),
      PLAN_INPUT,
    );
    assert.deepEqual(Object.keys(planned).sort(), ["model", "plan"]);
    assert.equal(planned.model, "mock-local-model");
    const { unexpected: _dropped, ...expectedPlan } = MOCK_PLAN;
    assert.deepEqual(
      planned.plan,
      expectedPlan,
      "only validated plan fields come back",
    );
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1].url, "/v1/chat/completions");
    assert.equal(
      mock.requests[1].headers.authorization,
      undefined,
      "a local model gets no Authorization header",
    );
    assert.equal(mock.requests[1].body.model, "mock-local-model");
    assert.equal(
      mock.requests[1].headers.cookie,
      undefined,
      "the warm-up left no cookie behind",
    );
    await page.evaluate(
      (input) => window.museDesktop.agentPlan(input),
      PLAN_INPUT,
    );
    assert.equal(
      mock.requests[2].headers.cookie,
      undefined,
      "main-process requests keep no cookies",
    );
    assert.equal(
      mock.requests.length,
      3,
      "one warm-up per save, none per plan",
    );
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.agentPlan({ ...${JSON.stringify(PLAN_INPUT)}, request: '' })`,
      ),
      "请先说说想要什么样的音乐。",
    );
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.agentPlan({ ...${JSON.stringify(PLAN_INPUT)}, baseUrl: 'https://evil.test', current: null })`,
      ),
      "编排请求的参数无效，请重新生成一次。",
    );
    await page.evaluate(() => window.museDesktop.cancelAgent());

    // An unreachable local model fails fast with a safe message (MAIN-08: and the message says which problem it is).
    // Nothing listens on the port: Ollama is not running.
    const deadPort = await closedPort();
    await page.evaluate(
      (port) =>
        window.museDesktop.saveLlmSettings({
          kind: "ollama",
          preset: "ollama",
          apiKey: "",
          model: "mock-local-model",
          baseUrl: `http://127.0.0.1:${port}/v1`,
        }),
      deadPort,
    );
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.agentPlan(${JSON.stringify(PLAN_INPUT)})`,
      ),
      "无法连接本机的 Ollama：它没有运行，或不在设置的端口上。请先启动 Ollama，再确认设置里的地址和端口。",
    );
    // Something listens there, but it is not an HTTP API: the address / port is the problem, not Ollama.
    const stranger = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end("220 not an http server\r\n"));
    });
    await new Promise((resolve) => stranger.listen(0, "127.0.0.1", resolve));
    const strangerPort = stranger.address().port;
    try {
      await page.evaluate(
        (port) =>
          window.museDesktop.saveLlmSettings({
            kind: "ollama",
            preset: "ollama",
            apiKey: "",
            model: "mock-local-model",
            baseUrl: `http://127.0.0.1:${port}/v1`,
          }),
        strangerPort,
      );
      assert.equal(
        await messageOf(
          page,
          `window.museDesktop.agentPlan(${JSON.stringify(PLAN_INPUT)})`,
        ),
        "本机的这个地址或端口不可用：那里运行的不是 Ollama，或连接被中断。请检查设置里的地址和端口。",
      );
    } finally {
      await new Promise((resolve) => stranger.close(resolve));
    }
    // A port the network stack refuses to connect to is turned down when it is saved, with the reason;
    // the previous address stays in place.
    for (const port of [6000, 10080, 6667]) {
      assert.equal(
        await messageOf(
          page,
          `window.museDesktop.saveLlmSettings({ kind: 'ollama', preset: 'ollama', apiKey: '', model: 'mock-local-model', baseUrl: 'http://127.0.0.1:${port}/v1' })`,
        ),
        `接口地址的端口 ${port} 是受限端口，应用无法向它发送请求。请让服务改用其他端口，再填写新的地址。`,
      );
    }
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.saveLlmSettings({ kind: 'openai', preset: 'custom', apiKey: 'sk-smoke-only-not-real', model: 'some-model', baseUrl: 'https://llm.example.com:6000/v1' })`,
      ),
      "接口地址的端口 6000 是受限端口，应用无法向它发送请求。请让服务改用其他端口，再填写新的地址。",
    );
    assert.equal(
      (await page.evaluate(() => window.museDesktop.getSettings())).llm.baseUrl,
      `http://127.0.0.1:${strangerPort}/v1`,
      "a refused save changes nothing",
    );

    // A warm-up that cannot connect (the save above) is silent: no dialog, no rejected save, nothing in the page.
    await page.evaluate(() => window.museDesktop.deleteLlmSettings());
    await page.evaluate(() =>
      window.museDesktop.deleteProviderCredentials("elevenlabs"),
    );
    const cleared = await page.evaluate(() => window.museDesktop.getSettings());
    assert.deepEqual(cleared.providers.elevenlabs, { configured: false });
    assert.deepEqual(cleared.llm, { configured: false });

    // One damaged entry must not take the settings call (or the other services) down.
    await page.evaluate(
      (key) =>
        window.museDesktop.saveProviderCredentials("elevenlabs", {
          apiKey: key,
        }),
      fakeKey,
    );
    const damaged = JSON.parse(await fs.readFile(credentialFile, "utf8"));
    damaged.providers.tencent = {
      encryptedCredentials: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
    };
    damaged.providers.futureService = { anything: true };
    damaged.futureTopLevel = { kept: true };
    await fs.writeFile(credentialFile, JSON.stringify(damaged));
    const afterDamage = await page.evaluate(() =>
      window.museDesktop.getSettings(),
    );
    assert.deepEqual(afterDamage.providers.tencent, {
      configured: true,
      damaged: true,
    });
    assert.deepEqual(afterDamage.providers.elevenlabs, {
      configured: true,
      model: "music_v1",
    });
    await page.evaluate(() =>
      window.museDesktop.deleteProviderCredentials("tencent"),
    );
    const repaired = JSON.parse(await fs.readFile(credentialFile, "utf8"));
    assert.deepEqual(
      repaired.futureTopLevel,
      { kept: true },
      "unknown top-level keys survive a save",
    );
    assert.deepEqual(
      repaired.providers.futureService,
      { anything: true },
      "unknown provider ids survive a save",
    );
    await page.evaluate(() =>
      window.museDesktop.deleteProviderCredentials("elevenlabs"),
    );

    // A credential file that is no store at all (here: zero bytes) used to refuse every save and
    // removal for ever. Now the first save sets it aside, starts empty, and tells the user once.
    // (The notice is a native dialog: recorded here instead of shown on the tester's desktop.)
    await desktop.evaluate(({ dialog }) => {
      globalThis.__museNotices = [];
      dialog.showMessageBox = async (...args) => {
        const options = args[args.length - 1];
        globalThis.__museNotices.push({
          message: options.message,
          detail: options.detail,
          buttons: options.buttons,
          modal: args.length > 1,
        });
        return { response: 0 };
      };
    });
    const notices = () => desktop.evaluate(() => globalThis.__museNotices);
    const dataFiles = async () =>
      (await fs.readdir(path.dirname(credentialFile))).filter((name) =>
        name.startsWith("music-credentials"),
      );
    await fs.writeFile(credentialFile, "");
    const unusable = await page.evaluate(() =>
      window.museDesktop.getSettings(),
    );
    assert.deepEqual(unusable.providers.tencent, {
      configured: false,
      damaged: true,
    });
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.generateMusic({ provider: 'tencent', prompt: '测试', duration: 30 })`,
      ),
      "无法读取服务凭据：凭据文件已损坏。请在设置中重新填写并保存密钥。",
    );
    assert.deepEqual(await dataFiles(), ["music-credentials.json"]);
    assert.deepEqual(await notices(), [], "reading sets nothing aside");
    assert.equal(
      await messageOf(
        page,
        `window.museDesktop.saveProviderCredentials('tencent', { apiKey: 'tokenhub-smoke-only-not-a-real-key' })`,
      ),
      null,
      "the save goes through",
    );
    const setAside = (await dataFiles()).filter((name) =>
      /^music-credentials\.damaged-\d{8}T\d{6}Z\.bak$/.test(name),
    );
    assert.equal(setAside.length, 1, JSON.stringify(await dataFiles()));
    assert.equal(
      (await fs.readFile(path.join(path.dirname(credentialFile), setAside[0])))
        .length,
      0,
      "the copy is the damaged file, byte for byte",
    );
    const told = await until(
      notices,
      (list) => list.length === 1,
      "the notice about the damaged credential file",
    );
    assert.equal(told[0].message, "之前保存的密钥需要重新填写");
    assert.ok(told[0].detail.includes(setAside[0]), told[0].detail);
    assert.deepEqual(told[0].buttons, ["知道了"]);
    assert.equal(told[0].modal, true);
    const restarted = await page.evaluate(() =>
      window.museDesktop.getSettings(),
    );
    assert.deepEqual(restarted.providers, {
      elevenlabs: { configured: false },
      tencent: { configured: true, model: "minimax-music-v3.0" },
      volcengine: { configured: false },
      aliyun: { configured: false },
    });
    await page.evaluate(() =>
      window.museDesktop.deleteProviderCredentials("tencent"),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await notices()).length, 1, "told once");
    assert.equal((await dataFiles()).length, 2, "one copy");

    if (process.env.MUSE_SCREENSHOT_PATH) {
      const screenshotPath = path.resolve(process.env.MUSE_SCREENSHOT_PATH);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath });
    }
  } finally {
    if (desktop) await desktop.close();
    await new Promise((resolve) => mock.server.close(resolve));
    await removeProfile(profile, "muse-desktop-smoke-");
  }
}

/** The app must keep working when it is started through a lowercase drive letter (cmd, VS Code terminal). */
async function lowercaseDriveCheck(root) {
  if (EXECUTABLE) return "skipped for a packaged executable";
  if (process.platform !== "win32" || !/^[A-Z]:/.test(root))
    return "skipped (not a drive-letter path)";
  const lowered = root[0].toLowerCase() + root.slice(1);
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "muse-desktop-smoke-"),
  );
  let desktop;
  try {
    const launched = await launch(root, lowered, profile);
    desktop = launched.desktop;
    const appPath = await desktop.evaluate(({ app }) => app.getAppPath());
    const pageUrl = launched.page.url();
    const settings = await launched.page.evaluate(() =>
      window.museDesktop.getSettings(),
    );
    assert.deepEqual(settings.providers.elevenlabs, { configured: false });
    return `app path ${appPath}, page ${pageUrl.slice(0, 12)}…`;
  } finally {
    if (desktop) await desktop.close();
    await removeProfile(profile, "muse-desktop-smoke-");
  }
}

/* ---------- paid requests, the close question and the context menu, through the real network path ---------- */

const UNCONFIRMED =
  "无法连接音乐服务，请检查网络。请求结果未确认，先查看服务控制台记录，再决定是否手动重试。";
/** The Aliyun endpoint of workspace "muse-smoke" and the OSS bucket its results are fetched from. */
const ALIYUN_API = "muse-smoke.cn-beijing.maas.aliyuncs.com";
const OSS = "muse-smoke.oss-cn-beijing.aliyuncs.com";
/** How long the stand-in server holds a request before it drops the connection without answering. */
const DROP_AFTER_MS = 800;

/**
 * A stand-in for a music service's HTTPS endpoint on 127.0.0.1 ("https1": HTTP/1.1
 * over TLS; "h2": HTTP/2). Every POST is recorded with the connection it arrived
 * on and how many requests that connection had already carried. `state.next`
 * decides what happens to the next POST only:
 *   "answer"  a normal answer (also for anything that arrives afterwards - so a
 *             request Chromium re-sends on its own WOULD be answered, exactly
 *             the situation in which a user is charged twice);
 *   "reset" / "close"  read the request, then drop the connection (RST / FIN)
 *             without answering: what a NAT or proxy does to a connection that
 *             sits idle while the service is composing;
 *   "hang"    read the request and never answer.
 * With `download`, GET requests are recorded in `state.gets` and answered by it
 * (a stand-in for the file server a finished result is fetched from).
 */
async function startVendor({
  protocol,
  tls,
  answer = () => ({
    status: 405,
    type: "text/plain",
    body: Buffer.from("not offered"),
  }),
  download,
}) {
  const state = {
    posts: [],
    gets: [],
    next: "answer",
    connections: 0,
    sockets: new Map(),
    hanging: [],
  };
  const track = (socket) => {
    socket.museId = ++state.connections;
    socket.museServed = 0;
    state.sockets.set(socket.remotePort, socket);
    socket.on("error", () => {});
  };
  const handle = (method, remotePort, body, reply) => {
    const socket = state.sockets.get(remotePort);
    if (method === "GET" && download) {
      state.gets.push({ connection: socket.museId });
      reply(download(state));
      return;
    }
    if (method !== "POST") {
      reply({
        status: 404,
        type: "text/plain",
        body: Buffer.from("not found"),
      });
      return;
    }
    const action = state.next;
    state.next = "answer";
    state.posts.push({
      connection: socket.museId,
      servedBefore: socket.museServed,
      bytes: body.length,
      action,
    });
    if (action === "reset") {
      setTimeout(() => socket.resetAndDestroy(), DROP_AFTER_MS);
      return;
    }
    if (action === "close") {
      setTimeout(() => socket.end(), DROP_AFTER_MS);
      return;
    }
    if (action === "hang") {
      state.hanging.push(socket);
      return;
    }
    socket.museServed++;
    reply(answer());
  };
  let server;
  if (protocol === "h2") {
    server = http2.createSecureServer({ key: tls.key, cert: tls.cert });
    server.on("session", (session) => session.on("error", () => {}));
    server.on("stream", (stream, headers) => {
      const chunks = [];
      stream.on("error", () => {});
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () =>
        handle(
          headers[":method"],
          stream.session.socket.remotePort,
          Buffer.concat(chunks),
          (result) => {
            stream.respond({
              ":status": result.status,
              "content-type": result.type,
            });
            stream.end(result.body);
          },
        ),
      );
    });
  } else {
    server = https.createServer(
      { key: tls.key, cert: tls.cert },
      (request, response) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () =>
          handle(
            request.method,
            request.socket.remotePort,
            Buffer.concat(chunks),
            (result) => {
              response.writeHead(result.status, {
                "content-type": result.type,
                "content-length": result.body.length,
              });
              response.end(result.body);
            },
          ),
        );
      },
    );
    server.keepAliveTimeout = 120000;
  }
  // The raw TCP socket (before TLS): the only one that can send a reset.
  server.on("connection", track);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of state.sockets.values()) socket.destroy();
      setTimeout(resolve, 2000).unref();
    });
  return { state, port: server.address().port, stop };
}

/** Command lines of the processes an Electron main process has started (Windows only; [] elsewhere or on failure). */
function childCommandLines(pid) {
  if (process.platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | ForEach-Object { $_.CommandLine }`,
      ],
      { windowsHide: true, timeout: 20000 },
      (error, stdout) =>
        resolve(error ? [] : String(stdout).split(/\r?\n/).filter(Boolean)),
    );
  });
}

async function paidRequestChecks(root) {
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "muse-desktop-smoke-"),
  );
  const mp3 = await fs.readFile(
    path.join(root, "tests", "fixtures", "music-3s.mp3"),
  );
  const tls = selfSignedCertificate({
    names: ["api.elevenlabs.io", "tokenhub.tencentmaas.com", ALIYUN_API, OSS],
  });
  const vendors = {
    // Aliyun answers with the address of the file; the file server is a second stand-in
    // whose `failing` flag decides whether a download gets the file or HTTP 503.
    aliyun: await startVendor({
      protocol: "https1",
      tls,
      answer: () => ({
        status: 200,
        type: "application/json",
        body: Buffer.from(
          JSON.stringify({
            request_id: "smoke-aliyun-0001",
            output: {
              finish_reason: "stop",
              audio: { url: `https://${OSS}/music.mp3?Signature=smoke` },
            },
          }),
        ),
      }),
    }),
    oss: await startVendor({
      protocol: "https1",
      tls,
      download: (state) =>
        state.failing
          ? { status: 503, type: "text/plain", body: Buffer.from("busy") }
          : { status: 200, type: "audio/mpeg", body: mp3 },
    }),
    elevenlabs: await startVendor({
      protocol: "https1",
      tls,
      answer: () => ({ status: 200, type: "audio/mpeg", body: mp3 }),
    }),
    tencent: await startVendor({
      protocol: "h2",
      tls,
      answer: () => ({
        status: 200,
        type: "application/json",
        body: Buffer.from(
          JSON.stringify({
            data: { audio: mp3.toString("hex"), status: 2 },
            base_resp: { status_code: 0, status_msg: "success" },
            trace_id: "smoke-trace-0001",
          }),
        ),
      }),
    }),
  };
  const facts = {};
  let desktop;
  try {
    // Only this Electron process resolves the two vendor names to the stand-ins; nothing else on the machine changes.
    const rules = `MAP api.elevenlabs.io 127.0.0.1:${vendors.elevenlabs.port}, MAP tokenhub.tencentmaas.com 127.0.0.1:${vendors.tencent.port}, MAP ${ALIYUN_API} 127.0.0.1:${vendors.aliyun.port}, MAP ${OSS} 127.0.0.1:${vendors.oss.port}`;
    const launched = await launch(root, root, profile, [
      `--host-resolver-rules=${rules}`,
    ]);
    desktop = launched.desktop;
    const page = launched.page;
    await page.waitForFunction(
      () => document.querySelector("#root")?.textContent?.length > 50,
    );
    const main = (fn, argument) => desktop.evaluate(fn, argument);
    // In the main process: trust exactly this run's certificate (everything else is verified as usual),
    // and record the close question and the context menu instead of showing them on the tester's desktop.
    await main(
      ({ session, dialog, Menu }, { partition, fingerprint }) => {
        const state = (globalThis.__museSmoke = {
          boxes: [],
          answer: 0,
          menus: [],
        });
        for (const each of [
          session.defaultSession,
          session.fromPartition(partition),
        ]) {
          each.setCertificateVerifyProc((request, callback) =>
            callback(request.certificate.fingerprint === fingerprint ? 0 : -3),
          );
        }
        dialog.showMessageBox = async (...args) => {
          const options = args[args.length - 1];
          state.boxes.push({
            message: options.message,
            detail: options.detail,
            buttons: options.buttons,
            defaultId: options.defaultId,
            cancelId: options.cancelId,
            modal: args.length > 1,
          });
          return { response: state.answer };
        };
        Menu.prototype.popup = function () {
          state.menus.push(
            this.items.map((item) => ({
              label: item.label,
              role: String(item.role).toLowerCase(),
              enabled: item.enabled,
              type: item.type,
            })),
          );
        };
      },
      { partition: BILLING_PARTITION, fingerprint: tls.fingerprint },
    );
    const smoke = () => main(() => globalThis.__museSmoke);

    await page.evaluate(() =>
      window.museDesktop.saveProviderCredentials("elevenlabs", {
        apiKey: "muse-smoke-only-not-a-real-api-key",
      }),
    );
    await page.evaluate(() =>
      window.museDesktop.saveProviderCredentials("tencent", {
        apiKey: "tokenhub-smoke-only-not-a-real-key",
      }),
    );
    const generate = (provider) =>
      page.evaluate(async (id) => {
        try {
          const result = await window.museDesktop.generateMusic({
            provider: id,
            prompt: "测试用的钢琴背景音乐",
            duration: 30,
          });
          return {
            ok: true,
            mimeType: result.mimeType,
            bytes: result.audio.byteLength,
          };
        } catch (error) {
          return { ok: false, message: error.message };
        }
      }, provider);

    /* MAIN-01: a billable POST is never sent twice, whatever happens to its connection. */
    const network = await main(async ({ app, session }, partition) => {
      const billing = session.fromPartition(partition);
      const probe = "https://api.example-vendor.com/";
      return {
        quicOff: app.commandLine.hasSwitch("disable-quic"),
        ownSession: billing !== session.defaultSession,
        inMemory: billing.isPersistent() === false,
        // the system proxy / PAC applies to billable requests exactly as to everything else
        sameProxy:
          (await billing.resolveProxy(probe)) ===
          (await session.defaultSession.resolveProxy(probe)),
      };
    }, BILLING_PARTITION);
    assert.deepEqual(network, {
      quicOff: true,
      ownSession: true,
      inMemory: true,
      sameProxy: true,
    });
    // (The process Playwright started is a launcher; the main process reports its own pid.)
    const children = await childCommandLines(await main(() => process.pid));
    const networkService = children.find((line) =>
      /--utility-sub-type=network\.mojom\.NetworkService/.test(line),
    );
    if (networkService)
      assert.match(
        networkService,
        /--disable-quic/,
        "the network service itself runs with QUIC off",
      );
    facts.networkService = networkService
      ? "runs with --disable-quic"
      : "command line not inspected";

    for (const [provider, drop] of [
      ["elevenlabs", "reset"],
      ["elevenlabs", "close"],
      ["tencent", "reset"],
      ["tencent", "close"],
    ]) {
      const { state } = vendors[provider];
      const label = `${provider} (${provider === "tencent" ? "HTTP/2" : "HTTP/1.1 over TLS"}, connection ${drop === "reset" ? "reset" : "closed"})`;
      const start = state.posts.length;
      // The generation before: answered, its connection stays open in Chromium's pool.
      const first = await generate(provider);
      assert.deepEqual(
        first,
        { ok: true, mimeType: "audio/mpeg", bytes: mp3.length },
        `${label}: ${JSON.stringify(first)}`,
      );
      // This one: the server has the request, then the connection is gone.
      state.next = drop;
      const second = await generate(provider);
      assert.deepEqual(
        second,
        { ok: false, message: UNCONFIRMED },
        `${label}: the caller is told the result is unconfirmed`,
      );
      await new Promise((resolve) => setTimeout(resolve, 400)); // time for a re-send to show up, if there were one
      assert.equal(
        state.posts.length - start,
        2,
        `${label}: the server received exactly one POST for the failed generation`,
      );
      // And the next one works again.
      const third = await generate(provider);
      assert.equal(third.ok, true, `${label}: ${JSON.stringify(third)}`);
      const posts = state.posts.slice(start);
      assert.equal(posts.length, 3);
      assert.deepEqual(
        posts.map((entry) => entry.servedBefore),
        [0, 0, 0],
        `${label}: every billable POST arrived on a connection that had carried nothing before`,
      );
      assert.equal(
        new Set(posts.map((entry) => entry.connection)).size,
        3,
        `${label}: three submissions, three connections`,
      );
    }
    // The same drop on the ordinary path (the default session, where the connection IS reused): this is
    // what MAIN-01 found. Recorded rather than asserted - it is Chromium's behaviour, not the app's.
    const control = {};
    for (const [provider, drop] of [
      ["elevenlabs", "reset"],
      ["tencent", "close"],
    ]) {
      const { state } = vendors[provider];
      const url =
        provider === "elevenlabs"
          ? "https://api.elevenlabs.io/v1/music"
          : "https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation";
      const send = () =>
        main(
          ({ net: electronNet }, target) =>
            electronNet
              .fetch(target, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: '{"control":"not a generation"}',
              })
              .then(
                async (response) => {
                  await response.arrayBuffer();
                  return `HTTP ${response.status}`;
                },
                (error) => String(error.message),
              ),
          url,
        );
      await send();
      const start = state.posts.length;
      state.next = drop;
      const outcome = await send();
      await new Promise((resolve) => setTimeout(resolve, 400));
      control[provider] = { arrivals: state.posts.length - start, outcome };
    }
    facts.control = control;
    const resent = Object.values(control).filter(
      (entry) => entry.arrivals === 2,
    ).length;
    if (resent < 2)
      console.warn(
        `note: on the ordinary path Chromium re-sent the dropped POST in only ${resent} of 2 cases - the single-POST result above is then weaker evidence: ${JSON.stringify(control)}`,
      );

    /* MAIN-07: right click. */
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.click();
    await composer.click({ button: "right" });
    const fieldMenu = (
      await until(
        smoke,
        (state) => state.menus.length === 1,
        "the context menu of a text field",
      )
    ).menus[0];
    assert.deepEqual(
      fieldMenu.map((item) => item.label),
      ["剪切", "复制", "粘贴", "全选"],
    );
    assert.deepEqual(
      fieldMenu.map((item) => item.role),
      ["cut", "copy", "paste", "selectall"],
    );
    assert.equal(
      fieldMenu[2].enabled,
      true,
      "paste is offered in a text field",
    );
    assert.equal(
      fieldMenu.every((item) => item.type === "normal"),
      true,
    );
    // A key field (as in Settings) and a line of text, added for this check only.
    await page.evaluate(() => {
      const box = document.createElement("div");
      box.id = "muse-smoke-probe";
      box.style.cssText =
        "position:fixed;left:12px;top:12px;z-index:2147483647;padding:24px;background:#fff;color:#000;user-select:text;-webkit-user-select:text";
      const secret = document.createElement("input");
      secret.type = "password";
      secret.id = "muse-smoke-secret";
      const text = document.createElement("p");
      text.id = "muse-smoke-text";
      text.textContent = "生成失败：请求编号 smoke-12345678";
      text.style.cssText =
        "user-select:text;-webkit-user-select:text;margin:12px 0 0";
      box.append(secret, text);
      document.body.append(box);
    });
    await page.locator("#muse-smoke-secret").click({ button: "right" });
    const secretMenu = (
      await until(
        smoke,
        (state) => state.menus.length === 2,
        "the context menu of a password field",
      )
    ).menus[1];
    assert.deepEqual(
      secretMenu.map((item) => `${item.label}:${item.enabled}`),
      ["剪切:false", "复制:false", "粘贴:true", "全选:false"],
      "an empty key field offers paste",
    );
    await page.evaluate(() => {
      document.activeElement?.blur();
      window
        .getSelection()
        .selectAllChildren(document.querySelector("#muse-smoke-text"));
    });
    await page.locator("#muse-smoke-text").click({ button: "right" });
    const textMenu = (
      await until(
        smoke,
        (state) => state.menus.length === 3,
        "the context menu of selected text",
      )
    ).menus[2];
    assert.deepEqual(
      textMenu.map((item) => `${item.label}:${item.role}:${item.enabled}`),
      ["复制:copy:true"],
    );
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page
      .locator("#muse-smoke-probe")
      .click({ button: "right", position: { x: 4, y: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      (await smoke()).menus.length,
      3,
      "a right click on nothing shows no menu",
    );
    await page.evaluate(() =>
      document.querySelector("#muse-smoke-probe").remove(),
    );

    const windows = () =>
      main(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((each) => !each.isDestroyed())
            .length,
      );
    const closeWindow = () =>
      main(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].close();
      });
    const settings = () =>
      page.evaluate(() => window.museDesktop.getSettings());

    /* ND-1: a billable request that cannot leave this computer still ends - by cancel, or by itself - and is reported as not sent. */
    const posted = () =>
      vendors.elevenlabs.state.posts.length +
      vendors.tencent.state.posts.length;
    const sentBeforeStall = posted();
    // The real billing session, with a closeAllConnections() whose answer never comes.
    await main(({ session }, partition) => {
      session.fromPartition(partition).closeAllConnections = () =>
        new Promise(() => {});
    }, BILLING_PARTITION);
    const stalled = generate("tencent");
    await new Promise((resolve) => setTimeout(resolve, 600));
    const cancelStarted = Date.now();
    await page.evaluate(() => window.museDesktop.cancelGeneration());
    assert.deepEqual(await stalled, {
      ok: false,
      message: "已取消等待生成。这次请求还没有发出，不会计费。",
    });
    facts.cancelMs = Date.now() - cancelStarted;
    assert.ok(facts.cancelMs < 3000, `cancel took ${facts.cancelMs} ms`);
    // Nobody cancels: the app gives up by itself after 5 s, and the music service is free again.
    const boundStarted = Date.now();
    assert.deepEqual(await generate("elevenlabs"), {
      ok: false,
      message:
        "没有发出请求，不会计费：应用没能为这次付费请求准备好独立的网络连接。请稍后重试；如果反复出现，请重启应用。",
    });
    facts.boundMs = Date.now() - boundStarted;
    assert.ok(
      facts.boundMs >= 4500 && facts.boundMs < 12000,
      `gave up after ${facts.boundMs} ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      posted(),
      sentBeforeStall,
      "neither request reached a service",
    );
    await main(({ session }, partition) => {
      delete session.fromPartition(partition).closeAllConnections;
    }, BILLING_PARTITION);
    for (const provider of ["tencent", "elevenlabs"]) {
      const after = await generate(provider);
      assert.equal(after.ok, true, `${provider}: ${JSON.stringify(after)}`);
    }
    assert.equal(posted(), sentBeforeStall + 2);

    /* FQ-01: a paid result the main process still holds - reported, guarded and never replaced unasked. */
    const collect = (provider) =>
      page.evaluate(async (id) => {
        try {
          const result = await window.museDesktop.retryLastDownload(id);
          return {
            ok: true,
            mimeType: result.mimeType,
            bytes: result.audio.byteLength,
          };
        } catch (error) {
          return { ok: false, message: error.message };
        }
      }, provider);
    await page.evaluate(() =>
      window.museDesktop.saveProviderCredentials("aliyun", {
        apiKey: "bailian-smoke-only-not-a-real-key",
        workspaceId: "muse-smoke",
        model: "fun-music-v1",
      }),
    );
    assert.equal((await settings()).pendingResult, null);
    const aliyun = vendors.aliyun.state;
    const oss = vendors.oss.state;
    oss.failing = true;
    const undelivered = await generate("aliyun");
    assert.equal(undelivered.ok, false);
    assert.match(
      undelivered.message,
      /^音乐已生成，但下载失败（已尝试 4 次.*（请求编号 smoke-aliyun-0001）$/,
    );
    assert.equal(aliyun.posts.length, 1, "one paid request");
    assert.equal(oss.gets.length, 4, "four download attempts");
    assert.deepEqual(
      (await settings()).pendingResult,
      { provider: "aliyun" },
      "getSettings says what the main process holds",
    );
    // The page reports nothing at stake (its notice was closed, say): closing asks all the same.
    await page.evaluate(() => window.museDesktop.setUnsavedWork(false));
    await closeWindow();
    const held = (
      await until(
        smoke,
        (state) => state.boxes.length === 1,
        "the question about music that was not fetched",
      )
    ).boxes[0];
    assert.equal(held.message, "有一首已经生成的音乐还没有取回");
    assert.match(held.detail, /已经生成了这首音乐并计费/);
    assert.match(held.detail, /再也取不回/);
    assert.match(held.detail, /重新生成需要再次付费[\s\S]*「重新下载」/);
    assert.deepEqual(held.buttons, ["返回应用", "仍然关闭"]);
    assert.equal(held.cancelId, 0);
    assert.equal(held.modal, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await windows(), 1, '"返回应用": the window stays open');
    // A new paid generation is refused - for that service and for any other - and nothing is sent.
    const paidBefore = posted() + aliyun.posts.length;
    for (const provider of ["tencent", "aliyun"])
      assert.deepEqual(await generate(provider), {
        ok: false,
        message:
          "还有一首已经付费的音乐没有取回，这次没有发出新的生成请求。请先点「重新下载」把它取回；确认不要它之后，才能开始新的生成。",
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(posted() + aliyun.posts.length, paidBefore);
    assert.deepEqual((await settings()).pendingResult, { provider: "aliyun" });
    // Giving it up takes the id of the service that holds it; then nothing is waiting any more.
    assert.equal(
      await page.evaluate(() =>
        window.museDesktop.discardPendingResult("tencent"),
      ),
      false,
    );
    assert.deepEqual((await settings()).pendingResult, { provider: "aliyun" });
    assert.equal(
      await page.evaluate(() =>
        window.museDesktop.discardPendingResult("aliyun"),
      ),
      true,
    );
    assert.equal((await settings()).pendingResult, null);
    assert.deepEqual(await collect("aliyun"), {
      ok: false,
      message:
        "没有等待重新下载的音乐。如需这首音乐，请到服务控制台查找，或重新生成。",
    });
    assert.equal(
      (await generate("tencent")).ok,
      true,
      "free to generate again",
    );
    // Once more, and this time the file server recovers: the result is fetched without a second paid request.
    assert.equal((await generate("aliyun")).ok, false);
    assert.deepEqual((await settings()).pendingResult, { provider: "aliyun" });
    oss.failing = false;
    assert.deepEqual(await collect("aliyun"), {
      ok: true,
      mimeType: "audio/mpeg",
      bytes: mp3.length,
    });
    assert.equal(aliyun.posts.length, 2, "two generations, two paid requests");
    assert.equal(
      oss.gets.length,
      9,
      "4 + 4 failed attempts and the one that worked",
    );
    assert.equal((await settings()).pendingResult, null);
    facts.pending =
      "reported, asked about on close, refused over, given up, collected";
    // (The questions recorded so far belong to this section.)
    await main(() => {
      globalThis.__museSmoke.boxes.length = 0;
    });

    /* MAIN-05: closing asks first while something paid for would be lost. */
    // The renderer holds a paid result that is not stored yet.
    await page.evaluate(() => window.museDesktop.setUnsavedWork(true));
    await closeWindow();
    const unsaved = (
      await until(
        smoke,
        (state) => state.boxes.length === 1,
        "the question about unsaved work",
      )
    ).boxes[0];
    assert.deepEqual(unsaved.buttons, ["返回应用", "仍然关闭"]);
    assert.match(unsaved.message, /还没有保存/);
    assert.equal(unsaved.cancelId, 0);
    assert.equal(unsaved.modal, true, "the question belongs to the window");
    assert.equal(await windows(), 1, "the window stays open");
    await page.evaluate(() => window.museDesktop.setUnsavedWork(false));
    // A paid generation is in flight.
    const eleven = vendors.elevenlabs.state;
    const sentBefore = eleven.posts.length;
    eleven.next = "hang";
    const inFlight = generate("elevenlabs").catch(() => ({
      ok: false,
      message: "the page is gone",
    }));
    await until(
      async () => eleven.posts.length,
      (count) => count === sentBefore + 1,
      "the generation request reaches the service",
    );
    await closeWindow();
    const generating = (
      await until(
        smoke,
        (state) => state.boxes.length === 2,
        "the question about a generation in flight",
      )
    ).boxes[1];
    assert.deepEqual(generating.buttons, ["继续等待", "仍然关闭"]);
    assert.match(generating.message, /还在生成/);
    assert.match(generating.detail, /计费/);
    assert.match(generating.detail, /无法取回/);
    assert.equal(generating.defaultId, 0);
    assert.equal(generating.cancelId, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await windows(), 1, '"继续等待": the window stays open');
    assert.equal(
      eleven.hanging[0].destroyed,
      false,
      '"继续等待": the request is still waiting for its answer',
    );
    // Quitting the whole app is held the same way.
    await main(({ app }) => {
      app.quit();
    });
    await until(
      smoke,
      (state) => state.boxes.length === 3,
      "the question on app.quit()",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await windows(), 1);
    assert.equal(
      eleven.hanging[0].destroyed,
      false,
      "a quit that was called off cancels nothing",
    );
    assert.equal(
      await page.evaluate(() => typeof window.museDesktop.generateMusic),
      "function",
      "the page is still alive",
    );
    // "仍然关闭": the app goes away and the request is abandoned (not sent again).
    await main(() => {
      globalThis.__museSmoke.answer = 1;
    });
    const exited = desktop.waitForEvent("close", { timeout: 20000 });
    await closeWindow().catch(() => {});
    await exited;
    await inFlight;
    await until(
      async () => eleven.hanging[0].destroyed,
      Boolean,
      "the abandoned request is closed",
      5000,
    );
    assert.equal(
      eleven.posts.length,
      sentBefore + 1,
      "one POST for the abandoned generation",
    );
    facts.questions = 3;
  } finally {
    if (desktop) {
      // After a failed check the close question may still be set to "stay": let the app go.
      await Promise.race([
        desktop
          .evaluate(() => {
            if (globalThis.__museSmoke) globalThis.__museSmoke.answer = 1;
          })
          .catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      const closed = await Promise.race([
        desktop.close().then(
          () => true,
          () => true,
        ),
        new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
      ]);
      if (!closed) desktop.process().kill();
    }
    await Promise.all(Object.values(vendors).map((vendor) => vendor.stop()));
    await removeProfile(profile, "muse-desktop-smoke-");
  }
  return facts;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  await fs.access(EXECUTABLE ?? path.join(root, "dist", "index.html"));
  await bridgeChecks(root);
  const drive = await lowercaseDriveCheck(root);
  const paid = await paidRequestChecks(root);
  console.log(
    `Desktop smoke passed: isolated preload, ${BRIDGE_KEYS.length} bridge methods, settings shape, plain Chinese errors, encrypted music + LLM settings CRUD, plan through the Chromium network stack, local-model connection messages and refused ports, damaged-entry isolation, a zero-byte credential file set aside on the first save with one notice, lowercase drive start (${drive}).`,
  );
  console.log(
    `Not sent: with the billing session's closeAllConnections() never answering, cancel ended the job in ${paid.cancelMs} ms and the app gave up by itself after ${paid.boundMs} ms, both reported as not sent, no POST reached a service, and the next generations went through. Pending result (Aliyun, real network path): ${paid.pending}.`,
  );
  console.log(
    `Paid requests: 4 dropped submissions (HTTP/1.1 over TLS and HTTP/2, reset and close) each reached the service exactly once on a never-used connection and were reported as unconfirmed; network service ${paid.networkService}; the same drop on the ordinary path: ${JSON.stringify(paid.control)}. Context menu in text fields / on selected text only. Closing asked ${paid.questions} times (unsaved work, generation in flight, quit) and left only on "仍然关闭".`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
