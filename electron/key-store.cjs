"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { MusicError } = require("./providers/shared.cjs");
const {
  PROVIDERS,
  LLM_KINDS,
  validateProvider,
  normalizeCredentials,
  normalizeLlmSettings,
  safeModelId,
} = require("./credentials.cjs");

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
 *
 * A V1 file is upgraded by the first save. If its key cannot be opened any more
 * (another Windows account, a restored profile) the save still goes through:
 * the old file is first copied, byte for byte, to
 *   userData/music-credentials.v1-<hash>.bak
 * and the unreadable key is left out of the new file. ElevenLabs then shows as
 * not configured, and the copy is there for whoever can still open it.
 *
 * A file that is no store at all (zero bytes, cut off, not JSON, the wrong
 * shape) can never be read again, so it must not block saving for ever either.
 * The first save or removal copies it, byte for byte, to
 *   userData/music-credentials.damaged-<UTC time>.bak
 * (an existing copy is never overwritten), starts again from an empty store and
 * reports the copy's name through `onQuarantine`, so the user is told that the
 * keys saved earlier have to be entered again. Reading never changes anything.
 * Two kinds of file are never replaced: one that cannot be read from disk, and
 * one written by a later format version.
 */
const MAX_FILE_CHARS = 1024 * 1024;
const UNREADABLE = "无法读取服务凭据，请保留原数据目录并检查文件权限。";
const DAMAGED =
  "无法读取服务凭据：凭据文件已损坏。请在设置中重新填写并保存密钥。";
const DAMAGED_BACKUP = /^music-credentials\.damaged-[0-9TZ-]+\.bak$/;
const MAX_BACKUP_NAMES = 50;
const STATUS_FIELDS = ["model", "workspaceId", "billingMode"];
const SECRET_FIELDS = {
  elevenlabs: ["apiKey"],
  tencent: ["apiKey"],
  aliyun: ["apiKey"],
  volcengine: ["accessKeyId", "secretAccessKey"],
};
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const encryptedString = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  /^[A-Za-z0-9+/]+=*$/.test(value);
const statusText = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);

function createKeyStore(
  dataPath,
  safeStorage,
  { now = () => new Date(), onQuarantine } = {},
) {
  const target = path.join(dataPath, "music-credentials.json");
  let mutation = Promise.resolve();

  /**
   * What is on disk: {value} for a store this build understands (no file is an
   * empty store), {damaged: true} for content that is no store of any version.
   * Throws for a file that cannot be read, or that a later version wrote.
   */
  async function load() {
    let raw;
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return { value: { version: 2, providers: {} } };
      throw new MusicError(UNREADABLE);
    }
    let value;
    try {
      if (raw.length > MAX_FILE_CHARS) throw new Error();
      value = JSON.parse(raw);
    } catch {
      return { damaged: true };
    }
    if (isRecord(value)) {
      if (value.version === 1 && encryptedString(value.encryptedApiKey))
        return { value };
      if (value.version === 2 && isRecord(value.providers)) return { value };
      // Not damage: an older build must leave a newer one's data alone.
      if (Number.isInteger(value.version) && value.version > 2)
        throw new MusicError(UNREADABLE);
    }
    return { damaged: true };
  }
  async function read() {
    const loaded = await load();
    if (loaded.damaged) throw new MusicError(DAMAGED);
    return loaded.value;
  }
  /**
   * Copy the damaged file aside and return the copy's name. An identical copy
   * from an earlier attempt is reused; no existing file is ever written to. If
   * no copy can be made the caller must not write: it would destroy the only one.
   */
  async function quarantineDamaged() {
    try {
      const bytes = await fs.readFile(target);
      for (const name of await fs.readdir(dataPath)) {
        if (!DAMAGED_BACKUP.test(name)) continue;
        const earlier = await fs
          .readFile(path.join(dataPath, name))
          .catch(() => null);
        if (earlier && earlier.equals(bytes)) return name;
      }
      const stamp = now()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z");
      for (let copy = 1; copy <= MAX_BACKUP_NAMES; copy++) {
        const name = `music-credentials.damaged-${stamp}${copy > 1 ? `-${copy}` : ""}.bak`;
        try {
          // "wx": fails rather than writes when the name is taken.
          await fs.writeFile(path.join(dataPath, name), bytes, {
            flag: "wx",
            mode: 0o600,
          });
          return name;
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      }
      throw new Error("no free backup name");
    } catch {
      throw new MusicError(
        "凭据文件已损坏，而且无法在数据目录中为它留下备份，所以这次没有保存。请检查数据目录是否可写后重试。",
      );
    }
  }
  /** The store a save or removal starts from; `quarantined` names the copy when a damaged file was set aside. */
  async function writable() {
    const loaded = await load();
    if (!loaded.damaged) return { value: loaded.value, quarantined: null };
    return {
      value: { version: 2, providers: {} },
      quarantined: await quarantineDamaged(),
    };
  }
  /** Once the new file is in place. Telling the user must never fail what they asked for. */
  function announce(backupName) {
    if (!backupName || typeof onQuarantine !== "function") return;
    try {
      onQuarantine({ backupName });
    } catch {
      /* the save itself went through */
    }
  }
  function assertEncryption() {
    if (!safeStorage.isEncryptionAvailable())
      throw new MusicError(
        "系统密钥保护不可用，密钥未保存。请重新登录 Windows 后重试。",
      );
  }
  /** Decrypt one stored blob into a JSON object; throws a plain Error when it cannot. */
  function open(blob) {
    if (!encryptedString(blob)) throw new Error("malformed entry");
    const data = JSON.parse(
      safeStorage.decryptString(Buffer.from(blob, "base64")),
    );
    if (!isRecord(data)) throw new Error("malformed entry");
    return data;
  }
  function seal(data) {
    return safeStorage.encryptString(JSON.stringify(data)).toString("base64");
  }
  function decrypt(value, provider) {
    assertEncryption();
    try {
      if (value.version === 1 && provider === "elevenlabs")
        return normalizeCredentials(provider, {
          apiKey: safeStorage.decryptString(
            Buffer.from(value.encryptedApiKey, "base64"),
          ),
        });
      const entry = value.providers?.[provider];
      if (!entry) throw new MusicError("请先在设置中填写所选音乐服务的凭据。");
      return normalizeCredentials(provider, open(entry.encryptedCredentials));
    } catch (e) {
      if (e instanceof MusicError) throw e;
      throw new MusicError(
        "无法解密此服务的凭据，请在当前 Windows 账户中重新保存。",
      );
    }
  }
  /**
   * Keep a V1 file whose key this build cannot use, next to the credential file.
   * The name comes from the content, so repeating it never piles up copies. If the
   * copy cannot be made the caller must not write: it would destroy the only one.
   */
  async function quarantineLegacy() {
    try {
      const bytes = await fs.readFile(target);
      const backup = path.join(
        dataPath,
        `music-credentials.v1-${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.bak`,
      );
      const existing = await fs.readFile(backup).catch(() => null);
      if (!existing || !existing.equals(bytes))
        await fs.writeFile(backup, bytes, { mode: 0o600 });
    } catch {
      throw new MusicError(
        "旧版本保存的 ElevenLabs 密钥已无法解密，而且无法在数据目录中为它留下备份，所以这次没有保存。请检查数据目录是否可写后重试。",
      );
    }
  }
  /**
   * V1 -> V2, keeping any other top-level key. A legacy key that cannot be carried
   * over (it does not decrypt, or is not a usable key) never blocks the write: it
   * is quarantined and left out.
   */
  async function v2(value) {
    if (value.version !== 1) return value;
    const { encryptedApiKey: _legacy, ...rest } = value;
    const next = { ...rest, version: 2, providers: {} };
    let legacy = null;
    try {
      legacy = decrypt(value, "elevenlabs");
    } catch {
      /* quarantined below */
    }
    if (legacy)
      next.providers.elevenlabs = { encryptedCredentials: seal(legacy) };
    else await quarantineLegacy();
    return next;
  }
  function serialize(operation) {
    const pending = mutation.then(operation);
    mutation = pending.catch(() => {});
    return pending;
  }
  async function write(value) {
    const tmp = `${target}.tmp`;
    try {
      await fs.mkdir(dataPath, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(value), {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(tmp, target);
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new MusicError("无法保存加密凭据，请检查数据目录是否可写。");
    }
  }

  function providerStatus(value, provider) {
    const stored =
      value.version === 1
        ? provider === "elevenlabs"
        : value.providers[provider] !== undefined &&
          value.providers[provider] !== null;
    if (!stored) return { configured: false };
    try {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("encryption unavailable");
      const data =
        value.version === 1
          ? {
              apiKey: safeStorage.decryptString(
                Buffer.from(value.encryptedApiKey, "base64"),
              ),
            }
          : open(value.providers[provider]?.encryptedCredentials);
      if (
        !SECRET_FIELDS[provider].every(
          (field) => typeof data[field] === "string" && data[field],
        )
      )
        throw new Error("incomplete entry");
      const status = { configured: true };
      for (const field of STATUS_FIELDS)
        if (statusText(data[field])) status[field] = data[field];
      return status;
    } catch {
      return { configured: true, damaged: true };
    }
  }
  function llmStatus(value) {
    if (value.llm === undefined || value.llm === null)
      return { configured: false };
    try {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("encryption unavailable");
      const data = open(value.llm?.encryptedSettings);
      if (!LLM_KINDS.includes(data.kind) || !safeModelId(data.model))
        throw new Error("incomplete entry");
      const status = { configured: true, kind: data.kind, model: data.model };
      if (statusText(data.preset)) status.preset = data.preset;
      if (
        data.kind !== "anthropic" &&
        typeof data.baseUrl === "string" &&
        /^https?:\/\/[A-Za-z0-9.:[\]-]{1,260}(?:\/[A-Za-z0-9._~/-]*)?$/.test(
          data.baseUrl,
        )
      )
        status.baseUrl = data.baseUrl;
      return status;
    } catch {
      return { configured: true, damaged: true };
    }
  }

  const store = {
    async hasKey(provider = "elevenlabs") {
      validateProvider(provider);
      await mutation;
      const value = await read();
      return value.version === 1
        ? provider === "elevenlabs"
        : Boolean(value.providers[provider]);
    },
    async getCredentials(provider = "elevenlabs") {
      validateProvider(provider);
      await mutation;
      return decrypt(await read(), provider);
    },
    async getKey() {
      return (await store.getCredentials("elevenlabs")).apiKey;
    },
    /**
     * Non-secret status of every music service and of the LLM, from one read.
     * Never throws: an entry that cannot be opened is {configured:true, damaged:true};
     * if the file itself cannot be read, everything is {configured:false, damaged:true}.
     */
    async getOverview() {
      await mutation;
      let value = null;
      try {
        value = await read();
      } catch {
        /* reported per entry below */
      }
      const providers = {};
      for (const provider of PROVIDERS)
        providers[provider] = value
          ? providerStatus(value, provider)
          : { configured: false, damaged: true };
      return {
        providers,
        llm: value ? llmStatus(value) : { configured: false, damaged: true },
      };
    },
    async getStatuses() {
      return (await store.getOverview()).providers;
    },
    saveCredentials(provider, input) {
      return serialize(async () => {
        const credentials = normalizeCredentials(provider, input);
        assertEncryption();
        const { value: stored, quarantined } = await writable();
        const value = await v2(stored);
        value.providers[provider] = { encryptedCredentials: seal(credentials) };
        await write(value);
        announce(quarantined);
      });
    },
    saveKey(key) {
      return store.saveCredentials("elevenlabs", { apiKey: key });
    },
    deleteCredentials(provider) {
      return serialize(async () => {
        validateProvider(provider);
        const { value: stored, quarantined } = await writable();
        if (quarantined) {
          // Nothing of the damaged file could be read, so nothing is left to remove: start clean.
          await write(stored);
          announce(quarantined);
          return;
        }
        if (stored.version === 1 && provider !== "elevenlabs") return;
        if (stored.version === 1) {
          const {
            encryptedApiKey: _legacy,
            version: _version,
            ...rest
          } = stored;
          if (Object.keys(rest).length) {
            await write({ ...rest, version: 2, providers: {} });
            return;
          }
          try {
            await fs.rm(target, { force: true });
          } catch {
            throw new MusicError("无法移除此服务的凭据。");
          }
          return;
        }
        delete stored.providers[provider];
        await write(stored);
      });
    },
    deleteKey() {
      return store.deleteCredentials("elevenlabs");
    },

    /* ----- producer agent (large language model) ----- */
    async getLlmStatus() {
      return (await store.getOverview()).llm;
    },
    /** Full settings including the key - for the main-process agent service only. */
    async getLlmSettings() {
      await mutation;
      const value = await read();
      if (value.llm === undefined || value.llm === null)
        throw new MusicError(
          "还没有配置大模型。请先在设置中填写大模型的连接信息。",
        );
      assertEncryption();
      let data;
      try {
        data = open(value.llm?.encryptedSettings);
      } catch {
        throw new MusicError(
          "无法解密大模型设置，请在当前 Windows 账户中重新保存。",
        );
      }
      return normalizeLlmSettings(data);
    },
    saveLlmSettings(input) {
      return serialize(async () => {
        const settings = normalizeLlmSettings(input);
        assertEncryption();
        const { value: stored, quarantined } = await writable();
        const value = await v2(stored);
        value.llm = { encryptedSettings: seal(settings) };
        await write(value);
        announce(quarantined);
      });
    },
    deleteLlmSettings() {
      return serialize(async () => {
        const { value: stored, quarantined } = await writable();
        if (quarantined) {
          await write(stored);
          announce(quarantined);
          return;
        }
        if (stored.llm === undefined) return;
        delete stored.llm;
        await write(stored);
      });
    },
  };
  return store;
}
module.exports = { createKeyStore };
