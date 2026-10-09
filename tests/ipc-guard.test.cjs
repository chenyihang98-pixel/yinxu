"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const {
  parseDevUrl,
  createIpcGuard,
  createTrustedHandler,
} = require("../electron/ipc-guard.cjs");

test("Windows trust check compares file paths, so drive-letter case, encoding, hash and query do not matter", () => {
  // F01: started from a lowercase-drive shell, Node builds the path with `d:` while Chromium reports `file:///D:/…`.
  const guard = createIpcGuard({
    productionFile: "d:\\makeBGM\\dist\\index.html",
    platform: "win32",
  });
  const table = [
    ["file:///D:/makeBGM/dist/index.html", true],
    ["file:///d:/makeBGM/dist/index.html", true],
    ["file:///D:/MAKEBGM/DIST/INDEX.HTML", true],
    ["file:///D:/makeBGM/dist/index.html#/library", true],
    ["file:///D:/makeBGM/dist/index.html?tab=settings#x", true],
    ["file:///D:/makeBGM/dist/../dist/index.html", true],
    ["file:///D:/makeBGM/dist/other.html", false],
    ["file:///D:/makeBGM/dist/index.html.evil", false],
    ["file:///D:/makeBGM/dist/index.html/extra", false],
    ["file:///E:/makeBGM/dist/index.html", false],
    ["file://evil.test/D:/makeBGM/dist/index.html", false],
    ["file:///D:/makeBGM/dist%2Findex.html", false],
    ["file:///D:/makeBGM/dist%5Cindex.html", false],
    ["https://evil.test/D:/makeBGM/dist/index.html", false],
    ["http://localhost:5173/", false],
    ["about:blank", false],
    ["javascript:alert(1)", false],
    ["data:text/html,<p>x</p>", false],
    ["not a url", false],
    ["", false],
    [null, false],
    [undefined, false],
    [{ href: "file:///D:/makeBGM/dist/index.html" }, false],
  ];
  for (const [url, expected] of table)
    assert.equal(guard.isTrustedUrl(url), expected, String(url));
  // The v0.2 check compared URL strings and failed in exactly this situation.
  assert.notEqual(
    pathToFileURL("d:\\makeBGM\\dist\\index.html", { windows: true }).href,
    "file:///D:/makeBGM/dist/index.html",
  );
});

test("Windows trust check handles spaces, Chinese folder names and UNC shares", () => {
  const local = createIpcGuard({
    productionFile:
      "C:\\Users\\小明\\App Data\\音序 Muse\\resources\\app.asar\\dist\\index.html",
    platform: "win32",
  });
  assert.equal(
    local.isTrustedUrl(
      "file:///C:/Users/%E5%B0%8F%E6%98%8E/App%20Data/%E9%9F%B3%E5%BA%8F%20Muse/resources/app.asar/dist/index.html",
    ),
    true,
  );
  assert.equal(
    local.isTrustedUrl(
      "file:///c:/users/小明/App Data/音序 Muse/resources/app.asar/dist/index.html",
    ),
    true,
  );
  assert.equal(
    local.isTrustedUrl(
      "file:///C:/Users/%E5%B0%8F%E7%BA%A2/App%20Data/%E9%9F%B3%E5%BA%8F%20Muse/resources/app.asar/dist/index.html",
    ),
    false,
  );
  const share = createIpcGuard({
    productionFile: "\\\\nas\\apps\\muse\\dist\\index.html",
    platform: "win32",
  });
  assert.equal(
    share.isTrustedUrl("file://nas/apps/muse/dist/index.html"),
    true,
  );
  assert.equal(
    share.isTrustedUrl("file://NAS/apps/Muse/dist/index.html#a"),
    true,
  );
  assert.equal(
    share.isTrustedUrl("file://other/apps/muse/dist/index.html"),
    false,
  );
  assert.equal(
    share.isTrustedUrl("file:///C:/apps/muse/dist/index.html"),
    false,
  );
});

test("POSIX trust check stays case-sensitive", () => {
  const guard = createIpcGuard({
    productionFile: "/opt/Muse/dist/index.html",
    platform: "linux",
  });
  assert.equal(
    guard.isTrustedUrl("file:///opt/Muse/dist/index.html?x=1#y"),
    true,
  );
  assert.equal(guard.isTrustedUrl("file:///opt/muse/dist/index.html"), false);
  assert.equal(
    guard.isTrustedUrl("file://host/opt/Muse/dist/index.html"),
    false,
  );
});

test("development URL is honoured only when unpackaged and only for a loopback http origin", () => {
  assert.equal(
    parseDevUrl("http://127.0.0.1:5173/", false),
    "http://127.0.0.1:5173/",
  );
  assert.equal(
    parseDevUrl("http://localhost:5173", false),
    "http://localhost:5173/",
  );
  assert.equal(parseDevUrl("http://[::1]:5173/", false), "http://[::1]:5173/");
  for (const [value, packaged] of [
    ["http://127.0.0.1:5173/", true],
    ["https://127.0.0.1:5173/", false],
    ["http://evil.test:5173/", false],
    ["http://user:pass@localhost:5173/", false],
    ["http://localhost.evil.test/", false],
    ["file:///C:/x.html", false],
    ["nonsense", false],
    ["", false],
    [undefined, false],
    [5173, false],
  ])
    assert.equal(parseDevUrl(value, packaged), null, String(value));

  const guard = createIpcGuard({
    productionFile: "D:\\makeBGM\\dist\\index.html",
    devUrl: "http://127.0.0.1:5173/",
    platform: "win32",
  });
  assert.equal(guard.isTrustedUrl("http://127.0.0.1:5173/"), true);
  assert.equal(
    guard.isTrustedUrl("http://127.0.0.1:5173/index.html?x=1#y"),
    true,
  );
  assert.equal(guard.isTrustedUrl("http://127.0.0.1:5174/"), false);
  assert.equal(guard.isTrustedUrl("http://localhost:5173/"), false);
  assert.equal(guard.isTrustedUrl("https://127.0.0.1:5173/"), false);
  assert.equal(
    guard.isTrustedUrl("file:///D:/makeBGM/dist/index.html"),
    false,
    "the dev server replaces the file origin",
  );
});

test("only the main frame of the app window, on the app page, is a trusted sender", () => {
  const guard = createIpcGuard({
    productionFile: "D:\\makeBGM\\dist\\index.html",
    platform: "win32",
  });
  const mainFrame = { url: "file:///D:/makeBGM/dist/index.html" };
  const webContents = { mainFrame };
  assert.equal(
    guard.isTrustedEvent(
      { sender: webContents, senderFrame: mainFrame },
      webContents,
    ),
    true,
  );
  const subFrame = { url: "file:///D:/makeBGM/dist/index.html" };
  assert.equal(
    guard.isTrustedEvent(
      { sender: webContents, senderFrame: subFrame },
      webContents,
    ),
    false,
    "sub-frame",
  );
  const otherContents = {
    mainFrame: { url: "file:///D:/makeBGM/dist/index.html" },
  };
  assert.equal(
    guard.isTrustedEvent(
      { sender: otherContents, senderFrame: otherContents.mainFrame },
      webContents,
    ),
    false,
    "another window",
  );
  const navigated = { mainFrame: { url: "https://evil.test/" } };
  assert.equal(
    guard.isTrustedEvent(
      { sender: navigated, senderFrame: navigated.mainFrame },
      navigated,
    ),
    false,
    "navigated away",
  );
  assert.equal(
    guard.isTrustedEvent(
      { sender: webContents, senderFrame: null },
      webContents,
    ),
    false,
    "frame already destroyed",
  );
  assert.equal(
    guard.isTrustedEvent({ sender: webContents, senderFrame: mainFrame }, null),
    false,
    "no window",
  );
  assert.equal(guard.isTrustedEvent(null, webContents), false);
});

test("trusted handler refuses untrusted senders and lets only application messages through", async () => {
  class SafeError extends Error {}
  let trustedSender = true;
  const calls = [];
  const wrap = createTrustedHandler({
    isTrusted: () => trustedSender,
    isSafeError: (error) => error instanceof SafeError,
  });
  const handler = wrap(async (...args) => {
    calls.push(args);
    if (args[0] === "safe") throw new SafeError("API Key 无效或已过期。");
    if (args[0] === "raw")
      throw new Error(
        "ENOENT: C:\\Users\\secret\\music-credentials.json sk-secret-key",
      );
    if (args[0] === "string") throw "plain string with sk-secret-key"; // eslint-disable-line no-throw-literal
    return { ok: args };
  });
  assert.deepEqual(
    await handler({ id: "event" }, "a", 2),
    { ok: ["a", 2] },
    "the IPC event object is not passed to the handler",
  );
  await assert.rejects(
    handler({}, "safe"),
    (error) =>
      error.message === "API Key 无效或已过期。" && error.constructor === Error,
  );
  await assert.rejects(
    handler({}, "raw"),
    (error) => error.message === "操作失败，请重试。",
  );
  await assert.rejects(
    handler({}, "string"),
    (error) => error.message === "操作失败，请重试。",
  );
  trustedSender = false;
  const before = calls.length;
  await assert.rejects(
    handler({}, "a"),
    (error) => error.message === "此页面没有桌面操作权限。",
  );
  assert.equal(
    calls.length,
    before,
    "the handler never runs for an untrusted sender",
  );
});
