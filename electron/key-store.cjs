'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { MusicError } = require('./providers/shared.cjs');
const { PROVIDERS, LLM_KINDS, validateProvider, normalizeCredentials, normalizeLlmSettings, safeModelId } = require('./credentials.cjs');

/**
 * userData/music-credentials.json
 *   V2: { version: 2,
 *         providers: { <providerId>: { encryptedCredentials: "<base64>" } },
 *         llm:       { encryptedSettings: "<base64>" } }          // producer agent, optional
 *   V1: { version: 1, encryptedApiKey: "<base64>" }               // ElevenLabs only, read-compatible
 *
 * Reading is lenient, writing is strict: every entry is opened on its own, so one
 * unreadable entry never hides the others, and ids or top-level keys this build
 * does not know are carried through every save untouched (a newer build's data
 * survives an older one). The LLM settings sit outside `providers` because
 * v0.2 rejects the whole file when it meets an unknown provider id.
 */
const MAX_FILE_CHARS = 1024 * 1024;
const STATUS_FIELDS = ['model', 'workspaceId', 'billingMode'];
const SECRET_FIELDS = { elevenlabs: ['apiKey'], tencent: ['apiKey'], aliyun: ['apiKey'], volcengine: ['accessKeyId', 'secretAccessKey'] };
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const encryptedString = value => typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(value);
const statusText = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);

function createKeyStore(dataPath, safeStorage) {
  const target = path.join(dataPath, 'music-credentials.json');
  let mutation = Promise.resolve();

  async function read() {
    let raw;
    try { raw = await fs.readFile(target, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { version: 2, providers: {} };
      throw new MusicError('无法读取服务凭据，请保留原数据目录并检查文件权限。');
    }
    try {
      if (raw.length > MAX_FILE_CHARS) throw new Error();
      const value = JSON.parse(raw);
      if (!isRecord(value)) throw new Error();
      if (value.version === 1 && encryptedString(value.encryptedApiKey)) return value;
      if (value.version !== 2 || !isRecord(value.providers)) throw new Error();
      return value;
    } catch { throw new MusicError('无法读取服务凭据，请保留原数据目录并检查文件权限。'); }
  }
  function assertEncryption() { if (!safeStorage.isEncryptionAvailable()) throw new MusicError('系统密钥保护不可用，密钥未保存。请重新登录 Windows 后重试。'); }
  /** Decrypt one stored blob into a JSON object; throws a plain Error when it cannot. */
  function open(blob) {
    if (!encryptedString(blob)) throw new Error('malformed entry');
    const data = JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64')));
    if (!isRecord(data)) throw new Error('malformed entry');
    return data;
  }
  function seal(data) { return safeStorage.encryptString(JSON.stringify(data)).toString('base64'); }
  function decrypt(value, provider) {
    assertEncryption();
    try {
      if (value.version === 1 && provider === 'elevenlabs') return normalizeCredentials(provider, { apiKey: safeStorage.decryptString(Buffer.from(value.encryptedApiKey, 'base64')) });
      const entry = value.providers?.[provider];
      if (!entry) throw new MusicError('请先在设置中填写所选音乐服务的凭据。');
      return normalizeCredentials(provider, open(entry.encryptedCredentials));
    } catch (e) { if (e instanceof MusicError) throw e; throw new MusicError('无法解密此服务的凭据，请在当前 Windows 账户中重新保存。'); }
  }
  /** V1 -> V2, keeping any other top-level key. Fails (and so blocks the write) when the legacy key cannot be decrypted. */
  function v2(value) {
    if (value.version !== 1) return value;
    const { encryptedApiKey: _legacy, ...rest } = value;
    return { ...rest, version: 2, providers: { elevenlabs: { encryptedCredentials: seal(decrypt(value, 'elevenlabs')) } } };
  }
  function serialize(operation) { const pending = mutation.then(operation); mutation = pending.catch(() => {}); return pending; }
  async function write(value) {
    const tmp = `${target}.tmp`;
    try { await fs.mkdir(dataPath, { recursive: true }); await fs.writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }); await fs.rename(tmp, target); }
    catch { await fs.rm(tmp, { force: true }).catch(() => {}); throw new MusicError('无法保存加密凭据，请检查数据目录是否可写。'); }
  }

  function providerStatus(value, provider) {
    const stored = value.version === 1 ? provider === 'elevenlabs' : value.providers[provider] !== undefined && value.providers[provider] !== null;
    if (!stored) return { configured: false };
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable');
      const data = value.version === 1
        ? { apiKey: safeStorage.decryptString(Buffer.from(value.encryptedApiKey, 'base64')) }
        : open(value.providers[provider]?.encryptedCredentials);
      if (!SECRET_FIELDS[provider].every(field => typeof data[field] === 'string' && data[field])) throw new Error('incomplete entry');
      const status = { configured: true };
      for (const field of STATUS_FIELDS) if (statusText(data[field])) status[field] = data[field];
      return status;
    } catch { return { configured: true, damaged: true }; }
  }
  function llmStatus(value) {
    if (value.llm === undefined || value.llm === null) return { configured: false };
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('encryption unavailable');
      const data = open(value.llm?.encryptedSettings);
      if (!LLM_KINDS.includes(data.kind) || !safeModelId(data.model)) throw new Error('incomplete entry');
      const status = { configured: true, kind: data.kind, model: data.model };
      if (statusText(data.preset)) status.preset = data.preset;
      if (data.kind !== 'anthropic' && typeof data.baseUrl === 'string' && /^https?:\/\/[A-Za-z0-9.:[\]-]{1,260}(?:\/[A-Za-z0-9._~/-]*)?$/.test(data.baseUrl)) status.baseUrl = data.baseUrl;
      return status;
    } catch { return { configured: true, damaged: true }; }
  }

  const store = {
    async hasKey(provider = 'elevenlabs') { validateProvider(provider); await mutation; const value = await read(); return value.version === 1 ? provider === 'elevenlabs' : Boolean(value.providers[provider]); },
    async getCredentials(provider = 'elevenlabs') { validateProvider(provider); await mutation; return decrypt(await read(), provider); },
    async getKey() { return (await store.getCredentials('elevenlabs')).apiKey; },
    /**
     * Non-secret status of every music service and of the LLM, from one read.
     * Never throws: an entry that cannot be opened is {configured:true, damaged:true};
     * if the file itself cannot be read, everything is {configured:false, damaged:true}.
     */
    async getOverview() {
      await mutation;
      let value = null;
      try { value = await read(); } catch { /* reported per entry below */ }
      const providers = {};
      for (const provider of PROVIDERS) providers[provider] = value ? providerStatus(value, provider) : { configured: false, damaged: true };
      return { providers, llm: value ? llmStatus(value) : { configured: false, damaged: true } };
    },
    async getStatuses() { return (await store.getOverview()).providers; },
    saveCredentials(provider, input) {
      return serialize(async () => { const credentials = normalizeCredentials(provider, input); assertEncryption(); const value = v2(await read()); value.providers[provider] = { encryptedCredentials: seal(credentials) }; await write(value); });
    },
    saveKey(key) { return store.saveCredentials('elevenlabs', { apiKey: key }); },
    deleteCredentials(provider) {
      return serialize(async () => {
        validateProvider(provider); const stored = await read();
        if (stored.version === 1 && provider !== 'elevenlabs') return;
        if (stored.version === 1) {
          const { encryptedApiKey: _legacy, version: _version, ...rest } = stored;
          if (Object.keys(rest).length) { await write({ ...rest, version: 2, providers: {} }); return; }
          try { await fs.rm(target, { force: true }); } catch { throw new MusicError('无法移除此服务的凭据。'); }
          return;
        }
        delete stored.providers[provider]; await write(stored);
      });
    },
    deleteKey() { return store.deleteCredentials('elevenlabs'); },

    /* ----- producer agent (large language model) ----- */
    async getLlmStatus() { return (await store.getOverview()).llm; },
    /** Full settings including the key - for the main-process agent service only. */
    async getLlmSettings() {
      await mutation; const value = await read();
      if (value.llm === undefined || value.llm === null) throw new MusicError('还没有配置大模型。请先在设置中填写大模型的连接信息。');
      assertEncryption();
      let data;
      try { data = open(value.llm?.encryptedSettings); }
      catch { throw new MusicError('无法解密大模型设置，请在当前 Windows 账户中重新保存。'); }
      return normalizeLlmSettings(data);
    },
    saveLlmSettings(input) {
      return serialize(async () => { const settings = normalizeLlmSettings(input); assertEncryption(); const value = v2(await read()); value.llm = { encryptedSettings: seal(settings) }; await write(value); });
    },
    deleteLlmSettings() {
      return serialize(async () => { const stored = await read(); if (stored.llm === undefined) return; delete stored.llm; await write(stored); });
    },
  };
  return store;
}
module.exports = { createKeyStore };
