"use strict";

// F06: the renderer must receive only the Chinese message, not Electron's
// "Error invoking remote method '…': Error: " wrapper. Also checks that the bridge,
// the IPC channels and the DesktopAPI contract stay in step.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { shape, wires } = require("./helpers/source-shape.cjs");

const root = path.join(__dirname, "..");
const preloadSource = fs.readFileSync(
  path.join(root, "electron", "preload.cjs"),
  "utf8",
);
const mainSource = fs.readFileSync(
  path.join(root, "electron", "main.cjs"),
  "utf8",
);

/** Run the real preload file against a fake `electron` module (it is sandboxed, so it requires nothing else). */
function loadBridge(invoke) {
  const exposed = {};
  const required = [];
  const fakeRequire = (name) => {
    required.push(name);
    if (name !== "electron")
      throw new Error(`a sandboxed preload cannot require "${name}"`);
    return {
      contextBridge: {
        exposeInMainWorld: (key, api) => {
          exposed[key] = api;
        },
      },
      ipcRenderer: { invoke },
    };
  };
  vm.runInNewContext(`(function (require) { ${preloadSource}\n})`, {
    Error,
    String,
    Object,
    Promise,
  })(fakeRequire);
  return { exposed, required };
}

const METHODS = {
  getSettings: ["muse:get-settings", []],
  saveProviderCredentials: ["muse:save-provider", ["tencent", { apiKey: "k" }]],
  deleteProviderCredentials: ["muse:delete-provider", ["tencent"]],
  generateMusic: ["muse:generate-music", [{ prompt: "p", duration: 30 }]],
  cancelGeneration: ["muse:cancel-generation", []],
  retryLastDownload: ["muse:retry-download", ["aliyun"]],
  discardPendingResult: ["muse:discard-pending", ["aliyun"]],
  setUnsavedWork: ["muse:set-unsaved-work", [true]],
  saveAudio: ["muse:save-audio", [{ name: "n", format: "wav" }]],
  openExternal: ["muse:open-external", ["https://example.com"]],
  saveLlmSettings: ["muse:save-llm", [{ kind: "ollama", model: "m" }]],
  deleteLlmSettings: ["muse:delete-llm", []],
  agentPlan: ["muse:agent-plan", [{ mode: "new", request: "r" }]],
  cancelAgent: ["muse:cancel-agent", []],
};

test("bridge exposes exactly the DesktopAPI methods, frozen, each on its own channel", async () => {
  const calls = [];
  const { exposed, required } = loadBridge(async (...args) => {
    calls.push(args);
    return "result";
  });
  assert.deepEqual(required, ["electron"]);
  assert.deepEqual(Object.keys(exposed), ["museDesktop"]);
  const bridge = exposed.museDesktop;
  assert.ok(Object.isFrozen(bridge));
  assert.deepEqual(Object.keys(bridge).sort(), Object.keys(METHODS).sort());
  for (const [method, [channel, args]] of Object.entries(METHODS)) {
    calls.length = 0;
    assert.equal(await bridge[method](...args), "result");
    assert.deepEqual(calls, [[channel, ...args]], method);
  }
  // No raw IPC, no generic invoke.
  for (const leaked of [
    "ipcRenderer",
    "invoke",
    "send",
    "on",
    "require",
    "process",
  ])
    assert.equal(leaked in bridge, false, leaked);
});

test("bridge methods match DesktopAPI in src/types.ts and the handlers registered in main.cjs", () => {
  const types = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
  const body = /export interface DesktopAPI \{([\s\S]*?)\n\}/.exec(types)?.[1];
  assert.ok(body, "DesktopAPI interface found");
  const declared = [...body.matchAll(/^ {2}([A-Za-z]+)\(/gm)].map(
    (match) => match[1],
  );
  // The contract and the bridge list exactly the same methods.
  assert.deepEqual(
    [...declared].sort(),
    Object.keys(METHODS).sort(),
    "DesktopAPI and the bridge list the same methods",
  );
  assert.equal(new Set(declared).size, declared.length);
  const handled = [
    ...shape(mainSource).matchAll(/trustedHandler\('(muse:[a-z-]+)'/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    [...handled].sort(),
    Object.values(METHODS)
      .map(([channel]) => channel)
      .sort(),
  );
  assert.equal(
    new Set(handled).size,
    handled.length,
    "no channel is registered twice",
  );
  const wrapper = shape("ipcMain.handle(channel, trusted(handler))");
  assert.ok(shape(mainSource).includes(wrapper));
  assert.equal(
    /ipcMain\.(on|handle)\(/.test(shape(mainSource).replace(wrapper, "")),
    false,
    "every handler goes through the trusted wrapper",
  );
});

test("F06: Electron's IPC prefix is removed so the UI shows only the application message", async () => {
  const table = [
    [
      "Error invoking remote method 'muse:generate-music': Error: API Key 无效或已过期，请检查所选服务的密钥。",
      "API Key 无效或已过期，请检查所选服务的密钥。",
    ],
    [
      "Error invoking remote method 'muse:agent-plan': Error: 已取消本次编排。",
      "已取消本次编排。",
    ],
    [
      "Error invoking remote method 'muse:open-external': Error: 此链接未列入允许打开的官方帮助页面。",
      "此链接未列入允许打开的官方帮助页面。",
    ],
    [
      "Error invoking remote method 'muse:save-llm': MusicError: 接口地址必须以 https:// 开头。",
      "接口地址必须以 https:// 开头。",
    ],
    [
      "Error invoking remote method 'muse:get-settings': TypeError: Cannot read properties of undefined",
      "Cannot read properties of undefined",
    ],
    [
      "Error invoking remote method 'muse:x': 操作失败，请重试。",
      "操作失败，请重试。",
    ],
    [
      "Error invoking remote method 'muse:x': Error: 说明里提到 Error: 字样也保留",
      "说明里提到 Error: 字样也保留",
    ],
    ["已经是干净的消息。", "已经是干净的消息。"],
    [
      "提到 Error invoking remote method 但不在开头",
      "提到 Error invoking remote method 但不在开头",
    ],
    ["Error invoking remote method 'muse:x': Error: ", "操作失败，请重试。"],
    ["", "操作失败，请重试。"],
  ];
  for (const [raw, expected] of table) {
    const { exposed } = loadBridge(async () => {
      throw new Error(raw);
    });
    for (const method of [
      "generateMusic",
      "agentPlan",
      "getSettings",
      "saveLlmSettings",
      "openExternal",
    ]) {
      await assert.rejects(exposed.museDesktop[method]({}), (error) => {
        assert.equal(error.message, expected, `${method}: ${raw}`);
        assert.equal(
          /^Error invoking remote method/.test(error.message),
          false,
        );
        return true;
      });
    }
  }
  // Non-Error rejections are normalised too.
  for (const [thrown, expected] of [
    ["字符串错误", "字符串错误"],
    [
      { message: "Error invoking remote method 'muse:x': Error: 对象里的消息" },
      "对象里的消息",
    ],
    [undefined, "操作失败，请重试。"],
    [null, "操作失败，请重试。"],
    [42, "操作失败，请重试。"],
    [{ message: { nested: true } }, "操作失败，请重试。"],
  ]) {
    const { exposed } = loadBridge(() => Promise.reject(thrown));
    await assert.rejects(
      exposed.museDesktop.getSettings(),
      (error) => error.message === expected,
    );
  }
});

test("successful results and arguments pass through untouched", async () => {
  const audio = new ArrayBuffer(8);
  const { exposed } = loadBridge(async (_channel, input) => ({
    echoed: input,
    audio,
  }));
  const input = { prompt: "青春欢快", duration: 30 };
  const result = await exposed.museDesktop.generateMusic(input);
  assert.equal(result.echoed, input);
  assert.equal(result.audio, audio);
});

test("MAIN-05: setUnsavedWork sends a strict boolean; MAIN-02: retryLastDownload sends nothing but the service id", async () => {
  const calls = [];
  const { exposed } = loadBridge(async (...args) => {
    calls.push(args);
  });
  for (const value of [true, "true", 1, {}, null, undefined, false])
    await exposed.museDesktop.setUnsavedWork(value);
  assert.deepEqual(
    calls,
    [true, false, false, false, false, false, false].map((flag) => [
      "muse:set-unsaved-work",
      flag,
    ]),
    "only the boolean true raises the flag",
  );
  calls.length = 0;
  await exposed.museDesktop.retryLastDownload(
    "volcengine",
    "https://evil.test/a.mp3",
    { url: "https://evil.test" },
  );
  assert.deepEqual(
    calls,
    [["muse:retry-download", "volcengine"]],
    "no address can be passed across the bridge",
  );
});

test("FQ-01: discardPendingResult sends nothing but the service id; main.cjs reports and guards what the music service holds", async () => {
  const calls = [];
  const { exposed } = loadBridge(async (...args) => {
    calls.push(args);
    return true;
  });
  assert.equal(
    await exposed.museDesktop.discardPendingResult("aliyun", "extra", {
      all: true,
    }),
    true,
    "resolves to whether a result was given up",
  );
  assert.deepEqual(calls, [["muse:discard-pending", "aliyun"]]);
  // generateMusic passes its input on as it is: discardPending is read by the main process.
  calls.length = 0;
  const input = {
    provider: "tencent",
    prompt: "p",
    duration: 30,
    discardPending: true,
  };
  await exposed.museDesktop.generateMusic(input);
  assert.deepEqual(calls, [["muse:generate-music", input]]);

  assert.ok(
    wires(
      mainSource,
      `trustedHandler("muse:discard-pending", (provider) => music.discardPending(provider))`,
    ),
  );
  assert.ok(
    wires(
      mainSource,
      `trustedHandler("muse:generate-music", (input) => music.generate(input, () => keyStore.getCredentials(input?.provider)))`,
    ),
    "the whole input reaches the service, which decides about discardPending",
  );
  // The close guard and getSettings read the service's own state.
  assert.ok(
    wires(mainSource, `pendingResult: () => music.pendingResult?.kind ?? null`),
  );
  assert.ok(wires(mainSource, `const waiting = music.pendingResult;`));
  assert.ok(
    wires(
      mainSource,
      `pendingResult: waiting ? { provider: waiting.provider } : null`,
    ),
    "getSettings().pendingResult is { provider } or null, as DesktopSettings says",
  );
  const types = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
  assert.match(
    types,
    /pendingResult\?: \{ provider: CloudProvider \} \| null;/,
    "the contract this answers to",
  );
  assert.match(
    shape(types),
    /generateMusic\(input:\{[^}]*discardPending\?:boolean;?\}\)/,
    "the contract names the flag the service reads",
  );
  assert.ok(
    wires(
      types,
      `discardPendingResult(provider: CloudProvider): Promise<boolean>;`,
    ),
  );
});

test("MAIN-02 / MAIN-05 / MAIN-07: main.cjs wires the new handlers, the close guard and the context menu", () => {
  assert.ok(
    wires(
      mainSource,
      `trustedHandler("muse:retry-download", (provider) => music.retryLastDownload(provider))`,
    ),
  );
  assert.ok(
    wires(
      mainSource,
      `trustedHandler("muse:set-unsaved-work", (value) => { closeGuard.setUnsavedWork(value === true); })`,
    ),
  );
  assert.ok(
    wires(
      mainSource,
      `mainWindow.on("close", (event) => { closeGuard.allow(event, () => mainWindow?.close()); })`,
    ),
  );
  assert.ok(
    wires(
      mainSource,
      `app.on("before-quit", (event) => { if (closeGuard.allow(event, () => app.quit())) cancelJobs(); })`,
    ),
    "jobs are cancelled only when the quit really goes ahead",
  );
  assert.ok(wires(mainSource, `isGenerating: () => music.busy`));
  assert.ok(
    wires(
      mainSource,
      `installContextMenu(mainWindow.webContents, { Menu, getWindow: () => mainWindow })`,
    ),
  );
  assert.equal(
    /inspectElement|openDevTools|toggleDevTools/.test(mainSource),
    false,
    "no developer tools entry anywhere",
  );
});
