// The desktop / web adapter. Node has no window, so every environment is built by hand.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  DOWNLOAD_URL,
  createPlatform,
  desktop,
  newId,
  openExternal,
  platform,
  safeFileName,
  saveFile,
} from "../src/platform";

type Loose = Record<string, unknown>;
type PlatformModule = typeof import("../src/platform");

const scope = globalThis as unknown as Loose;

/** A fresh copy of the module, evaluated against whatever globals are set right now. */
let copies = 0;
const freshModule = (): Promise<PlatformModule> =>
  import(`../src/platform.ts?copy=${++copies}`);

function bridge(extra: Loose = {}): Loose {
  const noop = async () => undefined;
  return {
    getSettings: noop,
    saveProviderCredentials: noop,
    deleteProviderCredentials: noop,
    generateMusic: noop,
    cancelGeneration: noop,
    retryLastDownload: noop,
    setUnsavedWork: noop,
    saveAudio: async () => ({ saved: true, path: "C:\\Music\\a.wav" }),
    openExternal: noop,
    saveLlmSettings: noop,
    deleteLlmSettings: noop,
    agentPlan: noop,
    cancelAgent: noop,
    ...extra,
  };
}

/** Temporarily define globals; returns the function that restores them. */
function define(values: Loose): () => void {
  const saved = Object.keys(values).map(
    (key) => [key, Object.getOwnPropertyDescriptor(scope, key)] as const,
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(scope, key, {
      value,
      configurable: true,
      writable: true,
    });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(scope, key, descriptor);
      else delete scope[key];
    }
  };
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* ---------------- detection ---------------- */

test("outside a browser the adapter is an offline web page with safe defaults", () => {
  assert.equal(desktop, undefined);
  assert.deepEqual(platform, {
    isDesktop: false,
    isWeb: true,
    isEmbedded: false,
    version: "dev",
    canUseCloud: false,
    canUseLlm: false,
    downloadUrl: "https://starwright.xyz/tools/yinxu/#download",
  });
  assert.equal(DOWNLOAD_URL, platform.downloadUrl);
  assert.ok(Object.isFrozen(platform));
});

test("the desktop build with its bridge can use cloud music and the LLM", () => {
  const api = bridge();
  const host = {
    museDesktop: api,
    self: null as unknown,
    top: null as unknown,
  };
  host.self = host.top = host;
  const result = createPlatform({ web: false, version: "0.3.0", host });
  assert.equal(result.desktop, api);
  assert.deepEqual(result.platform, {
    isDesktop: true,
    isWeb: false,
    isEmbedded: false,
    version: "0.3.0",
    canUseCloud: true,
    canUseLlm: true,
    downloadUrl: DOWNLOAD_URL,
  });
});

test("an older preload without the agent still allows cloud music", () => {
  const { agentPlan: _agentPlan, ...old } = bridge();
  const result = createPlatform({
    web: false,
    version: "0.3.0",
    host: { museDesktop: old },
  });
  assert.equal(result.platform.isDesktop, true);
  assert.equal(result.platform.canUseCloud, true);
  assert.equal(result.platform.canUseLlm, false);
});

test("the web build never has cloud or LLM, whatever is called museDesktop", () => {
  const result = createPlatform({
    web: true,
    version: "0.3.0",
    host: { museDesktop: bridge() },
  });
  assert.equal(result.desktop, undefined);
  assert.equal(result.platform.isDesktop, false);
  assert.equal(result.platform.isWeb, true);
  assert.equal(result.platform.canUseCloud, false);
  assert.equal(result.platform.canUseLlm, false);
});

test("things that are not the real bridge are ignored", () => {
  const candidates: unknown[] = [
    undefined,
    null,
    "museDesktop",
    42,
    () => undefined,
    {},
    { getSettings: "yes", saveAudio: () => 1, openExternal: () => 1 },
    { generateMusic: () => 1, agentPlan: () => 1 },
  ];
  for (const museDesktop of candidates) {
    const result = createPlatform({
      web: false,
      version: "1",
      host: { museDesktop },
    });
    assert.equal(result.desktop, undefined, String(museDesktop));
    assert.equal(result.platform.canUseCloud, false);
    assert.equal(result.platform.canUseLlm, false);
  }
  const hostile = {
    get museDesktop(): unknown {
      throw new Error("no access");
    },
  };
  assert.equal(
    createPlatform({ web: false, version: "1", host: hostile }).desktop,
    undefined,
  );
  assert.equal(
    createPlatform({ web: false, version: "1", host: undefined }).platform
      .isWeb,
    true,
  );
});

test("an iframe is detected, including when the parent cannot be read", () => {
  const top = {};
  const framed = { self: null as unknown, top };
  framed.self = framed;
  assert.equal(
    createPlatform({ web: true, version: "1", host: framed }).platform
      .isEmbedded,
    true,
  );
  const alone = { self: null as unknown, top: null as unknown };
  alone.self = alone.top = alone;
  assert.equal(
    createPlatform({ web: true, version: "1", host: alone }).platform
      .isEmbedded,
    false,
  );
  const sandboxed = {
    self: {},
    get top(): unknown {
      throw new DOMException("cross-origin", "SecurityError");
    },
  };
  assert.equal(
    createPlatform({ web: true, version: "1", host: sandboxed }).platform
      .isEmbedded,
    true,
  );
  assert.equal(
    createPlatform({ web: true, version: "", host: alone }).platform.version,
    "dev",
  );
});

test("the build constants decide the module's own answer", async () => {
  const api = bridge();
  const host: Loose = { museDesktop: api };
  host.self = host.top = host;
  let restore = define({
    window: host,
    __APP_VERSION__: "0.3.0",
    __MUSE_WEB__: false,
  });
  try {
    const desktopBuild = await freshModule();
    assert.equal(desktopBuild.desktop, api);
    assert.equal(desktopBuild.platform.isDesktop, true);
    assert.equal(desktopBuild.platform.version, "0.3.0");
    assert.equal(desktopBuild.platform.canUseLlm, true);
  } finally {
    restore();
  }
  restore = define({
    window: host,
    __APP_VERSION__: "0.3.0",
    __MUSE_WEB__: true,
  });
  try {
    const webBuild = await freshModule();
    assert.equal(webBuild.desktop, undefined);
    assert.equal(webBuild.platform.isWeb, true);
    assert.equal(webBuild.platform.canUseCloud, false);
    assert.equal(webBuild.platform.canUseLlm, false);
    assert.equal(webBuild.platform.version, "0.3.0");
  } finally {
    restore();
  }
});

/* ---------------- file names ---------------- */

test("file names are valid on every desktop system", () => {
  assert.equal(safeFileName("青春晴空", "wav"), "青春晴空.wav");
  assert.equal(
    safeFileName('a<b>c:d"e/f\\g|h?i*j', "mp3"),
    "a_b_c_d_e_f_g_h_i_j.mp3",
  );
  assert.equal(
    safeFileName("../../etc/passwd", "json"),
    ".._.._etc_passwd.json",
  );
  assert.equal(
    safeFileName("line\nbreak\u0000tab\t", "wav"),
    "line_break_tab_.wav",
  );
  assert.equal(safeFileName("  spaced  ", "flac"), "spaced.flac");
  assert.equal(safeFileName("trailing dots...  ", "wav"), "trailing dots.wav");
  // an extension typed by the user is not doubled
  assert.equal(safeFileName("song.WAV", "wav"), "song.wav");
  assert.equal(safeFileName("song.mp3", "wav"), "song.wav");
  assert.equal(safeFileName("v1.2 final", "wav"), "v1.2 final.wav");
  // Windows device names and empty names fall back
  for (const reserved of [
    "CON",
    "nul",
    "com1",
    "LPT9",
    "aux.txt",
    "",
    "   ",
    "...",
    null,
    undefined,
    42,
  ])
    assert.equal(
      safeFileName(reserved, "m4a"),
      "Muse-BGM.m4a",
      String(reserved),
    );
  assert.equal(safeFileName("console", "wav"), "console.wav");
  // full-width look-alikes of forbidden characters are normalised first
  assert.equal(safeFileName("a／b：c", "wav"), "a_b_c.wav");
  const long = safeFileName("音".repeat(300), "wav");
  assert.equal(long.length, 104);
  const emoji = safeFileName("a" + "\ud83c\udfb5".repeat(80), "wav");
  assert.equal(/[\ud800-\udbff]\.wav$/.test(emoji), false);
  assert.ok(emoji.length <= 104);
});

/* ---------------- ids ---------------- */

test("newId gives distinct UUIDs", () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, UUID_V4);
});

test("newId works where crypto.randomUUID does not exist (plain http pages)", () => {
  let restore = define({
    crypto: {
      getRandomValues<T extends Uint8Array>(array: T): T {
        for (let i = 0; i < array.length; i++) array[i] = (i * 37 + 11) & 0xff;
        return array;
      },
    },
  });
  try {
    const id = newId();
    assert.match(id, UUID_V4);
    // bytes 0b 30 55 7a 9f c4 e9 0e 33 58 7d a2 c7 ec 11 36 with the version
    // nibble (e9 → 49) and the variant bits (33 → b3) forced
    assert.equal(id, "0b30557a-9fc4-490e-b358-7da2c7ec1136");
  } finally {
    restore();
  }
  restore = define({ crypto: undefined });
  try {
    const ids = new Set(Array.from({ length: 50 }, () => newId()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, UUID_V4);
  } finally {
    restore();
  }
  assert.match(newId(), UUID_V4);
});

/* ---------------- saving files ---------------- */

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  connected: boolean;
  clicks: number;
  click(): void;
  remove(): void;
}

/** Just enough DOM for a download, recording what the code did with it. */
function fakeDom(options: { clickThrows?: boolean } = {}) {
  const anchors: FakeAnchor[] = [];
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  const connectedAtClick: boolean[] = [];
  const document = {
    createElement(tag: string) {
      assert.equal(tag, "a");
      const anchor: FakeAnchor = {
        href: "",
        download: "",
        rel: "",
        style: { display: "" },
        connected: false,
        clicks: 0,
        click() {
          connectedAtClick.push(anchor.connected);
          if (options.clickThrows) throw new Error("blocked");
          anchor.clicks++;
        },
        remove() {
          anchor.connected = false;
        },
      };
      anchors.push(anchor);
      return anchor;
    },
    body: {
      appendChild(anchor: FakeAnchor) {
        anchor.connected = true;
      },
    },
  };
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:test/${blobs.size + 1}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  const restoreGlobals = define({ document });
  return {
    anchors,
    blobs,
    revoked,
    connectedAtClick,
    restore() {
      restoreGlobals();
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    },
  };
}

test("on the web a file is offered as a download with a safe name and the right type", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const dom = fakeDom();
  try {
    const data = new Uint8Array([82, 73, 70, 70]).buffer;
    const expected: [Parameters<typeof saveFile>[0]["format"], string][] = [
      ["wav", "audio/wav"],
      ["mp3", "audio/mpeg"],
      ["m4a", "audio/mp4"],
      ["flac", "audio/flac"],
      ["json", "application/json"],
    ];
    for (const [format, mime] of expected) {
      const result = await saveFile({ name: "夏日/海边: 第1版", data, format });
      assert.deepEqual(result, { saved: true });
      const anchor = dom.anchors.at(-1);
      assert.ok(anchor);
      assert.equal(anchor.download, `夏日_海边_ 第1版.${format}`);
      assert.equal(anchor.clicks, 1);
      assert.equal(
        anchor.connected,
        false,
        "the helper element is removed again",
      );
      assert.equal(anchor.style.display, "none");
      const blob = dom.blobs.get(anchor.href);
      assert.ok(blob);
      assert.equal(blob.type, mime);
      assert.deepEqual(
        new Uint8Array(await blob.arrayBuffer()),
        new Uint8Array(data),
      );
    }
    assert.ok(
      dom.connectedAtClick.every(Boolean),
      "clicked while attached to the document",
    );
    // the object URL must outlive the click, then be released
    assert.deepEqual(dom.revoked, []);
    mock.timers.tick(5_000);
    assert.deepEqual(dom.revoked, []);
    mock.timers.tick(60_000);
    assert.deepEqual(dom.revoked.sort(), [...dom.blobs.keys()].sort());
  } finally {
    dom.restore();
    mock.timers.reset();
  }
});

test("saved is false when the download could not even be requested", async () => {
  const data = new Uint8Array([1]).buffer;
  // no document at all (this test process)
  assert.deepEqual(await saveFile({ name: "a", data, format: "wav" }), {
    saved: false,
  });
  const dom = fakeDom({ clickThrows: true });
  try {
    assert.deepEqual(await saveFile({ name: "a", data, format: "wav" }), {
      saved: false,
    });
    assert.equal(dom.anchors[0].connected, false);
    assert.deepEqual(
      dom.revoked,
      [dom.anchors[0].href],
      "nothing is left behind",
    );
  } finally {
    dom.restore();
  }
});

test("empty data and unknown formats are refused with a clear message", async () => {
  const data = new Uint8Array([1]).buffer;
  await assert.rejects(
    saveFile({ name: "a", data: new ArrayBuffer(0), format: "wav" }),
    /导出数据为空/,
  );
  await assert.rejects(
    saveFile({
      name: "a",
      data: new Uint8Array([1]) as unknown as ArrayBuffer,
      format: "wav",
    }),
    /导出数据为空/,
  );
  await assert.rejects(
    saveFile({ name: "a", data, format: "exe" as never }),
    /不支持的导出格式/,
  );
  await assert.rejects(
    saveFile({ name: "a", data, format: "toString" as never }),
    /不支持的导出格式/,
  );
});

test("on the desktop saving goes through the native dialog", async () => {
  const calls: Loose[] = [];
  let answer: unknown = { saved: true, path: "D:\\Music\\夏日.wav" };
  const api = bridge({
    saveAudio: async (input: Loose) => {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const dom = fakeDom();
  const restore = define({ window: { museDesktop: api }, __MUSE_WEB__: false });
  try {
    const module = await freshModule();
    const data = new Uint8Array([1, 2, 3]).buffer;
    assert.deepEqual(
      await module.saveFile({ name: "夏日", data, format: "wav" }),
      {
        saved: true,
        path: "D:\\Music\\夏日.wav",
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "夏日");
    assert.equal(calls[0].format, "wav");
    assert.equal(calls[0].data, data);
    assert.equal(dom.anchors.length, 0, "no browser download on the desktop");

    answer = { saved: false };
    assert.deepEqual(
      await module.saveFile({ name: "夏日", data, format: "json" }),
      { saved: false },
    );
    answer = undefined;
    assert.deepEqual(
      await module.saveFile({ name: "夏日", data, format: "json" }),
      { saved: false },
    );
    // the main process explains failures in Chinese; they reach the caller unchanged
    answer = new Error("无法写入所选文件，请选择可写的位置后重试。");
    await assert.rejects(
      module.saveFile({ name: "夏日", data, format: "wav" }),
      /无法写入所选文件/,
    );
    await assert.rejects(
      module.saveFile({
        name: "夏日",
        data: new ArrayBuffer(0),
        format: "wav",
      }),
      /导出数据为空/,
    );
    assert.equal(calls.length, 4);
  } finally {
    restore();
    dom.restore();
  }
});

/* ---------------- external links ---------------- */

test("on the web a link opens in a new tab without handing over the opener", async () => {
  const opened: unknown[][] = [];
  const restore = define({
    window: {
      open: (...args: unknown[]) => {
        opened.push(args);
        return null;
      },
    },
  });
  try {
    assert.equal(
      await openExternal("https://starwright.xyz/tools/yinxu/#download"),
      true,
    );
    assert.deepEqual(opened, [
      [
        "https://starwright.xyz/tools/yinxu/#download",
        "_blank",
        "noopener,noreferrer",
      ],
    ]);
    // only web links: never script, file or data URLs
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "file:///C:/Windows/system32",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "not a url",
      "",
      "//starwright.xyz",
    ])
      assert.equal(await openExternal(url), false, url);
    assert.equal(opened.length, 1);
  } finally {
    restore();
  }
  const throwing = define({
    window: {
      open: () => {
        throw new Error("popup blocked");
      },
    },
  });
  try {
    assert.equal(await openExternal("https://example.com/"), false);
  } finally {
    throwing();
  }
  // no window at all
  assert.equal(await openExternal("https://example.com/"), false);
});

test("on the desktop a link goes to the main process and failures become false", async () => {
  const calls: string[] = [];
  let fail: "no" | "reject" | "throw" = "no";
  const api = bridge({
    openExternal: (url: string) => {
      calls.push(url);
      if (fail === "throw") throw new Error("bridge gone");
      return fail === "reject"
        ? Promise.reject(new Error("此链接未列入允许打开的官方帮助页面。"))
        : Promise.resolve();
    },
  });
  const opened: unknown[] = [];
  const restore = define({
    window: {
      museDesktop: api,
      open: (...args: unknown[]) => opened.push(args),
    },
    __MUSE_WEB__: false,
  });
  try {
    const module = await freshModule();
    // the allow-list in the main process compares exact strings: no normalisation
    assert.equal(
      await module.openExternal("https://bailian.console.aliyun.com"),
      true,
    );
    assert.deepEqual(calls, ["https://bailian.console.aliyun.com"]);
    fail = "reject";
    assert.equal(
      await module.openExternal("https://example.com/not-allowed"),
      false,
    );
    fail = "throw";
    assert.equal(await module.openExternal("https://example.com/"), false);
    assert.equal(await module.openExternal("javascript:alert(1)"), false);
    assert.equal(calls.length, 3, "non-web URLs never reach the main process");
    assert.deepEqual(opened, [], "the renderer never opens windows itself");
  } finally {
    restore();
  }
});
