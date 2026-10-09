"use strict";

/**
 * Who may call the `muse:*` IPC handlers, kept free of Electron so it can be unit tested.
 *
 * Production: only the app's own dist/index.html, compared as a FILE PATH rather
 * than a URL string. Chromium reports `file:///D:/…` while Node may build
 * `file:///d:/…` when the app is started from a lowercase-drive shell, so on
 * Windows the comparison ignores case; hash and query are ignored everywhere.
 * Development (unpackaged + MUSE_DEV_URL): only that loopback origin.
 */
const path = require("node:path");
const { fileURLToPath } = require("node:url");

/** A usable development URL (http on this computer, no credentials) or null. */
function parseDevUrl(value, isPackaged) {
  if (isPackaged || typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    )
      return parsed.href;
  } catch {
    /* An invalid development URL never enables remote app loading. */
  }
  return null;
}

function createIpcGuard({
  productionFile,
  devUrl = null,
  platform = process.platform,
}) {
  const windows = platform === "win32";
  const flavour = windows ? path.win32 : path.posix;
  const normalize = (file) => {
    const resolved = flavour.normalize(file);
    return windows ? resolved.toLowerCase() : resolved;
  };
  const expected = normalize(productionFile);
  const devOrigin = devUrl ? new URL(devUrl).origin : null;

  function isTrustedUrl(url) {
    if (typeof url !== "string" || !url) return false;
    try {
      const parsed = new URL(url);
      if (devOrigin) return parsed.origin === devOrigin;
      if (parsed.protocol !== "file:") return false;
      return normalize(fileURLToPath(parsed, { windows })) === expected;
    } catch {
      return false;
    }
  }

  /** The event must come from the main frame of the app window, showing the app's own page. */
  function isTrustedEvent(event, webContents) {
    return (
      Boolean(webContents) &&
      Boolean(event) &&
      event.sender === webContents &&
      Boolean(event.senderFrame) &&
      event.senderFrame === event.sender.mainFrame &&
      isTrustedUrl(event.senderFrame.url)
    );
  }

  return { isTrustedUrl, isTrustedEvent };
}

/**
 * Wrap an IPC handler: untrusted senders are refused, and only errors accepted
 * by `isSafeError` keep their message - OS, network and library errors never
 * reach the renderer.
 */
function createTrustedHandler({ isTrusted, isSafeError }) {
  return (handler) =>
    async (event, ...args) => {
      if (!isTrusted(event)) throw new Error("此页面没有桌面操作权限。");
      try {
        return await handler(...args);
      } catch (error) {
        throw new Error(
          isSafeError(error) ? error.message : "操作失败，请重试。",
        );
      }
    };
}

module.exports = { parseDevUrl, createIpcGuard, createTrustedHandler };
