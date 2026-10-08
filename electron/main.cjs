'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session } = require('electron');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createKeyStore } = require('./key-store.cjs');
const { createMusicService, safeFilename, isAllowedExternal, MusicError } = require('./music-service.cjs');

app.setName('Muse BGM');
app.setAppUserModelId('studio.muse.bgm');

// Opt-in only: keep the normal Windows per-user data location unless explicitly configured.
if (process.env.MUSE_PORTABLE_DATA === '1' && process.env.PORTABLE_EXECUTABLE_DIR) {
  const portableData = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Muse-Data');
  mkdirSync(portableData, { recursive: true });
  app.setPath('userData', portableData);
}

let mainWindow;
let keyStore;
const music = createMusicService();
const productionUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
let devUrl = null;
if (!app.isPackaged && process.env.MUSE_DEV_URL) {
  try {
    const parsed = new URL(process.env.MUSE_DEV_URL);
    if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && !parsed.username && !parsed.password) devUrl = parsed.href;
  } catch { /* An invalid development URL never enables remote app loading. */ }
}

function isTrustedUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (devUrl) return parsed.origin === new URL(devUrl).origin;
    parsed.hash = '';
    parsed.search = '';
    return parsed.href === productionUrl;
  } catch { return false; }
}

function trustedHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isTrustedUrl(event.senderFrame.url)) {
      throw new Error('此页面没有桌面操作权限。');
    }
    try { return await handler(...args); }
    catch (error) {
      // Only application-defined messages cross the boundary, never raw OS/network details.
      throw new Error(error instanceof MusicError ? error.message : '操作失败，请重试。');
    }
  });
}

function registerHandlers() {
  trustedHandler('muse:get-settings', async () => ({ hasApiKey: await keyStore.hasKey(), providers: await keyStore.getStatuses(), dataPath: app.getPath('userData') }));
  trustedHandler('muse:save-api-key', key => keyStore.saveKey(key));
  trustedHandler('muse:delete-api-key', () => keyStore.deleteKey());
  trustedHandler('muse:save-provider', (provider, credentials) => keyStore.saveCredentials(provider, credentials));
  trustedHandler('muse:delete-provider', provider => keyStore.deleteCredentials(provider));
  trustedHandler('muse:generate-music', async input => music.generate(input, await keyStore.getCredentials(input?.provider)));
  trustedHandler('muse:cancel-generation', () => music.cancel());
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
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!isTrustedUrl(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { music.cancel(); mainWindow = null; });
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(() => {
    keyStore = createKeyStore(app.getPath('userData'), safeStorage);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (!devUrl) {
      const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } }));
    }
    registerHandlers();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(() => {
    dialog.showErrorBox('Muse 启动失败', '无法初始化应用。请检查数据目录权限后重新启动。');
    app.quit();
  });
  app.on('before-quit', () => music.cancel());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
