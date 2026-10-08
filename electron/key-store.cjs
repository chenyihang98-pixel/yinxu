'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { MusicError } = require('./providers/shared.cjs');
const { PROVIDERS, validateProvider, normalizeCredentials } = require('./credentials.cjs');

function createKeyStore(dataPath, safeStorage) {
  const target = path.join(dataPath, 'music-credentials.json');
  let mutation = Promise.resolve();
  const encryptedString = value => typeof value === 'string' && /^[A-Za-z0-9+/]+=*$/.test(value);
  async function read() {
    try {
      const raw = await fs.readFile(target, 'utf8'); if (raw.length > 65536) throw new Error();
      const value = JSON.parse(raw);
      if (value.version === 1 && encryptedString(value.encryptedApiKey)) return value;
      if (value.version !== 2 || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) throw new Error();
      for (const id of Object.keys(value.providers)) if (!PROVIDERS.includes(id) || !encryptedString(value.providers[id]?.encryptedCredentials)) throw new Error();
      return value;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 2, providers: {} };
      throw new MusicError('无法读取服务凭据，请保留原数据目录并检查文件权限。');
    }
  }
  function assertEncryption() { if (!safeStorage.isEncryptionAvailable()) throw new MusicError('系统密钥保护不可用，密钥未保存。请重新登录 Windows 后重试。'); }
  function decrypt(value, provider) {
    assertEncryption();
    try {
      if (value.version === 1 && provider === 'elevenlabs') return normalizeCredentials(provider, { apiKey: safeStorage.decryptString(Buffer.from(value.encryptedApiKey, 'base64')) });
      const entry = value.providers?.[provider];
      if (!entry) throw new MusicError('请先在设置中填写所选音乐服务的凭据。');
      return normalizeCredentials(provider, JSON.parse(safeStorage.decryptString(Buffer.from(entry.encryptedCredentials, 'base64'))));
    } catch (e) { if (e instanceof MusicError) throw e; throw new MusicError('无法解密此服务的凭据，请在当前 Windows 账户中重新保存。'); }
  }
  function wrap(credentials) { return { encryptedCredentials: safeStorage.encryptString(JSON.stringify(credentials)).toString('base64') }; }
  function v2(value) { return value.version === 1 ? { version: 2, providers: { elevenlabs: wrap(decrypt(value, 'elevenlabs')) } } : value; }
  function serialize(operation) { const pending = mutation.then(operation); mutation = pending.catch(() => {}); return pending; }
  async function write(value) {
    const tmp = `${target}.tmp`;
    try { await fs.mkdir(dataPath, { recursive: true }); await fs.writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }); await fs.rename(tmp, target); }
    catch { await fs.rm(tmp, { force: true }).catch(() => {}); throw new MusicError('无法保存加密凭据，请检查数据目录是否可写。'); }
  }
  const store = {
    async hasKey(provider = 'elevenlabs') { validateProvider(provider); await mutation; const value = await read(); return value.version === 1 ? provider === 'elevenlabs' : Boolean(value.providers[provider]); },
    async getCredentials(provider = 'elevenlabs') { validateProvider(provider); await mutation; return decrypt(await read(), provider); },
    async getKey() { return (await store.getCredentials('elevenlabs')).apiKey; },
    async getStatuses() {
      await mutation; const value = await read(); const statuses = {};
      for (const provider of PROVIDERS) {
        const configured = value.version === 1 ? provider === 'elevenlabs' : Boolean(value.providers[provider]);
        statuses[provider] = { configured };
        if (configured) {
          const data = decrypt(value, provider);
          for (const field of ['model', 'workspaceId', 'billingMode']) if (data[field]) statuses[provider][field] = data[field];
        }
      }
      return statuses;
    },
    saveCredentials(provider, input) {
      return serialize(async () => { const credentials = normalizeCredentials(provider, input); assertEncryption(); const value = v2(await read()); value.providers[provider] = wrap(credentials); await write(value); });
    },
    saveKey(key) { return store.saveCredentials('elevenlabs', { apiKey: key }); },
    deleteCredentials(provider) {
      return serialize(async () => {
        validateProvider(provider); const stored = await read();
        if (stored.version === 1 && provider !== 'elevenlabs') return;
        if (stored.version === 1) { try { await fs.rm(target, { force: true }); } catch { throw new MusicError('无法移除此服务的凭据。'); } return; }
        delete stored.providers[provider]; await write(stored);
      });
    },
    deleteKey() { return store.deleteCredentials('elevenlabs'); },
  };
  return store;
}
module.exports = { createKeyStore };
