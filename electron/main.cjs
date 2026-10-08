'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, net } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { createKeyStore } = require('./key-store.cjs');
const { createMusicService, safeFilename, isAllowedExternal, MusicError } = require('./music-service.cjs');
const { createAgentService } = require('./agent-service.cjs');
const { parseDevUrl, createIpcGuard, createTrustedHandler } = require('./ipc-guard.cjs');
const { createNetFetch } = require('./net-fetch.cjs');
const { CONTENT_SECURITY_POLICY } = require('./csp.cjs');

app.setName('Muse BGM');
app.setAppUserModelId('studio.muse.bgm');

// Opt-in only: keep the normal Windows per-user data location unless explicitly configured.
if (process.env.MUSE_PORTABLE_DATA === '1' && process.env.PORTABLE_EXECUTABLE_DIR) {
  const portableData = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Muse-Data');
  mkdirSync(portableData, { recursive: true });
  app.setPath('userData', portableData);
}

/**
 * All main-process HTTP (cloud music, LLM) goes through Chromium's network stack
 * so the Windows system proxy / PAC is honoured. MUSE_NETWORK=node switches to
 * Node's own fetch (no proxy support): a troubleshooting fallback, and the seam
 * end-to-end test suites use to replace `globalThis.fetch` with a mock.
 */
const chromiumFetch = createNetFetch(net);
const fetchImpl = process.env.MUSE_NETWORK === 'node' ? (...args) => globalThis.fetch(...args) : chromiumFetch;

let mainWindow;
let keyStore;
const music = createMusicService({ fetchImpl });
const agent = createAgentService({ fetchImpl });
const productionFile = path.join(__dirname, '..', 'dist', 'index.html');
const devUrl = parseDevUrl(process.env.MUSE_DEV_URL, app.isPackaged);
const guard = createIpcGuard({ productionFile, devUrl });
const trusted = createTrustedHandler({
  isTrusted: event => Boolean(mainWindow) && guard.isTrustedEvent(event, mainWindow.webContents),
  // Only application-defined messages cross the boundary, never raw OS/network details.
  isSafeError: error => error instanceof MusicError,
});
const trustedHandler = (channel, handler) => ipcMain.handle(channel, trusted(handler));

function registerHandlers() {
  trustedHandler('muse:get-settings', async () => {
    // One read of the credential file; a damaged entry is reported per service and never fails the call.
    const { providers, llm } = await keyStore.getOverview();
    return { hasApiKey: providers.elevenlabs.configured === true, providers, llm, dataPath: app.getPath('userData'), version: app.getVersion() };
  });
  trustedHandler('muse:save-api-key', key => keyStore.saveKey(key));
  trustedHandler('muse:delete-api-key', () => keyStore.deleteKey());
  trustedHandler('muse:save-provider', (provider, credentials) => keyStore.saveCredentials(provider, credentials));
  trustedHandler('muse:delete-provider', provider => keyStore.deleteCredentials(provider));
  // Credentials are read inside the job, after the lock is taken, so cancelling during the read works.
  trustedHandler('muse:generate-music', input => music.generate(input, () => keyStore.getCredentials(input?.provider)));
  trustedHandler('muse:cancel-generation', () => music.cancel());
  trustedHandler('muse:save-llm', settings => keyStore.saveLlmSettings(settings));
  trustedHandler('muse:delete-llm', () => keyStore.deleteLlmSettings());
  // The plan request carries no URL and no key: both come from the encrypted store.
  trustedHandler('muse:agent-plan', input => agent.plan(input, () => keyStore.getLlmSettings()));
  trustedHandler('muse:cancel-agent', () => agent.cancel());
  trustedHandler('muse:open-external', async url => {
    if (!isAllowedExternal(url)) throw new MusicError('此链接未列入允许打开的官方帮助页面。');
    await shell.openExternal(url);
  });
  trustedHandler('muse:save-audio', async input => {
    if (!input || typeof input !== 'object' || !(input.data instanceof ArrayBuffer) || input.data.byteLength === 0 || input.data.byteLength > 256 * 1024 * 1024) {
      throw new MusicError('导出数据为空或过大，请重新生成音乐后重试。');
    }
    const filename = safeFilename(input.name, input.format);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: input.format === 'json' ? '导出 Muse 工程' : '导出背景音乐',
      defaultPath: path.join(app.getPath('music'), filename),
      filters: [{ name: input.format === 'json' ? 'Muse 工程' : `${input.format.toUpperCase()} 音频`, extensions: [input.format] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (canceled || !filePath) return { saved: false };
    try { await fs.writeFile(filePath, Buffer.from(input.data)); }
    catch { throw new MusicError('无法写入所选文件，请选择可写的位置后重试。'); }
    return { saved: true, path: filePath };
  });
}

function cancelJobs() { music.cancel(); agent.cancel(); }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1060, minHeight: 720,
    title: '音序 Muse · BGM 创作工作台', backgroundColor: '#101112',
    icon: path.join(__dirname, 'assets', 'muse.png'),
    show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!guard.isTrustedUrl(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { cancelJobs(); mainWindow = null; });
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(productionFile);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(() => {
    keyStore = createKeyStore(app.getPath('userData'), safeStorage);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (!devUrl) {
      // Belt and braces: the policy that is enforced for file:// pages is the <meta> tag Vite writes from the same string.
      // Limited to the app's own files so API responses fetched by the main process are left untouched.
      session.defaultSession.webRequest.onHeadersReceived({ urls: ['file:///*'] }, (details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] } }));
    }
    registerHandlers();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(() => {
    dialog.showErrorBox('Muse 启动失败', '无法初始化应用。请检查数据目录权限后重新启动。');
    app.quit();
  });
  app.on('before-quit', cancelJobs);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
