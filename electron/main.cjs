"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  session,
  net,
} = require("electron");
const fs = require("node:fs/promises");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { createKeyStore } = require("./key-store.cjs");
const {
  createMusicService,
  safeFilename,
  isAllowedExternal,
  MusicError,
} = require("./music-service.cjs");
const { createAgentService } = require("./agent-service.cjs");
const {
  parseDevUrl,
  createIpcGuard,
  createTrustedHandler,
} = require("./ipc-guard.cjs");
const {
  createNetFetch,
  createBillingFetch,
  BILLING_PARTITION,
} = require("./net-fetch.cjs");
const {
  createCloseGuard,
  closePromptOptions,
  LEAVE,
} = require("./close-guard.cjs");
const { installContextMenu } = require("./context-menu.cjs");
const { CONTENT_SECURITY_POLICY } = require("./csp.cjs");

app.setName("Muse BGM");
app.setAppUserModelId("studio.muse.bgm");

// Opt-in only: keep the normal Windows per-user data location unless explicitly configured.
if (
  process.env.MUSE_PORTABLE_DATA === "1" &&
  process.env.PORTABLE_EXECUTABLE_DIR
) {
  const portableData = path.join(
    process.env.PORTABLE_EXECUTABLE_DIR,
    "Muse-Data",
  );
  mkdirSync(portableData, { recursive: true });
  app.setPath("userData", portableData);
}

// A QUIC request that fails is retried over TCP by Chromium itself, even on a brand-new
// connection. Nothing here needs HTTP/3, and a billable request must never be sent twice.
app.commandLine.appendSwitch("disable-quic");

/**
 * All main-process HTTP (cloud music, LLM) goes through Chromium's network stack
 * so the Windows system proxy / PAC is honoured. The one request of a generation
 * that is billed on arrival takes a separate path that cannot re-send it (see
 * createBillingFetch). MUSE_NETWORK=node switches both to Node's own fetch (no
 * proxy support): a troubleshooting fallback, and the seam end-to-end test
 * suites use to replace `globalThis.fetch` with a mock.
 */
const nodeFetch = (...args) => globalThis.fetch(...args);
const useNodeNetwork = process.env.MUSE_NETWORK === "node";
const fetchImpl = useNodeNetwork ? nodeFetch : createNetFetch(net);
// The session exists only after the app is ready; every caller runs later than that.
const submitFetch = useNodeNetwork
  ? nodeFetch
  : createBillingFetch(() => session.fromPartition(BILLING_PARTITION));

let mainWindow;
let keyStore;
const music = createMusicService({ fetchImpl, submitFetch });
const agent = createAgentService({ fetchImpl });
const closeGuard = createCloseGuard({
  isGenerating: () => music.busy,
  // From this process's own state: it holds whatever the page reports or has forgotten.
  pendingResult: () => music.pendingResult?.kind ?? null,
  ask: async (reason) => {
    const options = closePromptOptions(reason);
    const { response } = await (mainWindow
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options));
    return response === LEAVE;
  },
});
const productionFile = path.join(__dirname, "..", "dist", "index.html");
const devUrl = parseDevUrl(process.env.MUSE_DEV_URL, app.isPackaged);
const guard = createIpcGuard({ productionFile, devUrl });
const trusted = createTrustedHandler({
  isTrusted: (event) =>
    Boolean(mainWindow) && guard.isTrustedEvent(event, mainWindow.webContents),
  // Only application-defined messages cross the boundary, never raw OS/network details.
  isSafeError: (error) => error instanceof MusicError,
});
const trustedHandler = (channel, handler) =>
  ipcMain.handle(channel, trusted(handler));

function registerHandlers() {
  trustedHandler("muse:get-settings", async () => {
    // One read of the credential file; a damaged entry is reported per service and never fails the call.
    const { providers, llm } = await keyStore.getOverview();
    const waiting = music.pendingResult;
    return {
      providers,
      llm,
      dataPath: app.getPath("userData"),
      version: app.getVersion(),
      // A paid result this process still holds; retryLastDownload(provider) collects it.
      pendingResult: waiting ? { provider: waiting.provider } : null,
    };
  });
  trustedHandler("muse:save-provider", (provider, credentials) =>
    keyStore.saveCredentials(provider, credentials),
  );
  trustedHandler("muse:delete-provider", (provider) =>
    keyStore.deleteCredentials(provider),
  );
  // Credentials are read inside the job, after the lock is taken, so cancelling during the read works.
  // While a paid result is waiting to be collected the service refuses, unless input.discardPending is true.
  trustedHandler("muse:generate-music", (input) =>
    music.generate(input, () => keyStore.getCredentials(input?.provider)),
  );
  trustedHandler("muse:cancel-generation", () => music.cancel());
  // Collects the paid result the service still holds (downloads it again, or goes on waiting for a task
  // that had not finished); takes a service id only - the address stays in the main process.
  trustedHandler("muse:retry-download", (provider) =>
    music.retryLastDownload(provider),
  );
  // The user gives that result up: nothing is fetched, and closing or generating no longer asks about it.
  trustedHandler("muse:discard-pending", (provider) =>
    music.discardPending(provider),
  );
  // The renderer is holding a paid result that is not in the library yet: closing asks first.
  trustedHandler("muse:set-unsaved-work", (value) => {
    closeGuard.setUnsavedWork(value === true);
  });
  trustedHandler("muse:save-llm", async (settings) => {
    const saved = await keyStore.saveLlmSettings(settings);
    // A model on this computer needs a minute or more to load: start that now, in the background,
    // rather than during the user's first message. Does nothing for hosted services; never reports.
    void agent.warmUp(() => keyStore.getLlmSettings());
    return saved;
  });
  trustedHandler("muse:delete-llm", () => {
    agent.stopWarmUp();
    return keyStore.deleteLlmSettings();
  });
  // The plan request carries no URL and no key: both come from the encrypted store.
  trustedHandler("muse:agent-plan", (input) =>
    agent.plan(input, () => keyStore.getLlmSettings()),
  );
  trustedHandler("muse:cancel-agent", () => agent.cancel());
  trustedHandler("muse:open-external", async (url) => {
    if (!isAllowedExternal(url))
      throw new MusicError("此链接未列入允许打开的官方帮助页面。");
    await shell.openExternal(url);
  });
  trustedHandler("muse:save-audio", async (input) => {
    if (
      !input ||
      typeof input !== "object" ||
      !(input.data instanceof ArrayBuffer) ||
      input.data.byteLength === 0 ||
      input.data.byteLength > 256 * 1024 * 1024
    ) {
      throw new MusicError("导出数据为空或过大，请重新生成音乐后重试。");
    }
    const filename = safeFilename(input.name, input.format);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: input.format === "json" ? "导出 Muse 工程" : "导出背景音乐",
      defaultPath: path.join(app.getPath("music"), filename),
      filters: [
        {
          name:
            input.format === "json"
              ? "Muse 工程"
              : `${input.format.toUpperCase()} 音频`,
          extensions: [input.format],
        },
      ],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (canceled || !filePath) return { saved: false };
    try {
      await fs.writeFile(filePath, Buffer.from(input.data));
    } catch {
      throw new MusicError("无法写入所选文件，请选择可写的位置后重试。");
    }
    return { saved: true, path: filePath };
  });
}

/** The credential file was damaged and has been set aside: say so once, whatever the page is showing. */
function reportQuarantine({ backupName }) {
  const options = {
    type: "warning",
    title: "音序 Muse",
    message: "之前保存的密钥需要重新填写",
    detail: `保存密钥的文件已损坏，无法读取。原文件已另存为数据目录里的「${backupName}」，应用已从空白的凭据重新开始：刚才的操作已经生效，其他服务的密钥和大模型设置请在设置中重新填写。`,
    buttons: ["知道了"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  void Promise.resolve()
    .then(() =>
      mainWindow
        ? dialog.showMessageBox(mainWindow, options)
        : dialog.showMessageBox(options),
    )
    .catch(() => {});
}

function cancelJobs() {
  music.cancel();
  agent.cancel();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    title: "音序 Muse · BGM 创作",
    backgroundColor: "#101112",
    icon: path.join(__dirname, "assets", "muse.png"),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!guard.isTrustedUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  installContextMenu(mainWindow.webContents, {
    Menu,
    getWindow: () => mainWindow,
  });
  // A page that loads afresh holds nothing: whatever the previous one reported is gone with it.
  closeGuard.reset();
  mainWindow.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument)
      closeGuard.setUnsavedWork(false);
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    closeGuard.allow(event, () => mainWindow?.close());
  });
  mainWindow.on("closed", () => {
    cancelJobs();
    mainWindow = null;
  });
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(productionFile);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app
    .whenReady()
    .then(() => {
      keyStore = createKeyStore(app.getPath("userData"), safeStorage, {
        onQuarantine: reportQuarantine,
      });
      for (const each of [
        session.defaultSession,
        session.fromPartition(BILLING_PARTITION),
      ]) {
        each.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false),
        );
        each.setPermissionCheckHandler(() => false);
      }
      if (!devUrl) {
        // Belt and braces: the policy that is enforced for file:// pages is the <meta> tag Vite writes from the same string.
        // Limited to the app's own files so API responses fetched by the main process are left untouched.
        session.defaultSession.webRequest.onHeadersReceived(
          { urls: ["file:///*"] },
          (details, callback) =>
            callback({
              responseHeaders: {
                ...details.responseHeaders,
                "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
              },
            }),
        );
      }
      registerHandlers();
      createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch(() => {
      dialog.showErrorBox(
        "Muse 启动失败",
        "无法初始化应用。请检查数据目录权限后重新启动。",
      );
      app.quit();
    });
  // Quitting asks first as well; jobs are cancelled only once the quit is really going ahead.
  app.on("before-quit", (event) => {
    if (closeGuard.allow(event, () => app.quit())) cancelJobs();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
