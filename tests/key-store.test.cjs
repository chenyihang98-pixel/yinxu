"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createKeyStore } = require("../electron/key-store.cjs");
const {
  normalizeCredentials,
  normalizeLlmSettings,
  PROVIDERS,
  LLM_KINDS,
  ANTHROPIC_MODELS,
} = require("../electron/credentials.cjs");
const { SECRET_MAX, cleanSecret } = require("../electron/providers/shared.cjs");

const KEYS = {
  elevenlabs: { apiKey: "fake-elevenlabs-key-only", model: "music_v2_5" },
  tencent: { apiKey: "fake-tokenhub-key-only", model: "minimax-music-v2.6" },
  volcengine: {
    accessKeyId: "AKIDEXAMPLEFAKE",
    secretAccessKey: "fake-volcengine-secret-only",
    billingMode: "prepaid",
  },
  aliyun: {
    apiKey: "fake-bailian-key-only",
    workspaceId: "workspace-test-123",
    model: "fun-music-v1",
  },
};
const LLM = {
  anthropic: {
    kind: "anthropic",
    preset: "claude",
    apiKey: "sk-ant-fake-key-for-tests-only",
    model: "claude-sonnet-5-5",
  },
  openai: {
    kind: "openai",
    preset: "deepseek",
    apiKey: "sk-fake-deepseek-key-for-tests",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/",
  },
  ollama: {
    kind: "ollama",
    preset: "ollama",
    apiKey: "",
    model: "qwen3.5:9b-q4_K_M",
  },
};

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) =>
      Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa7)),
    decryptString: (value) =>
      Buffer.from([...value].map((byte) => byte ^ 0xa7)).toString(),
  };
}
async function fixture(t, safeStorage = fakeSafeStorage()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "muse-key-store-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) === path.resolve(os.tmpdir()) &&
      path.basename(resolved).startsWith("muse-key-store-")
    )
      await fs.rm(resolved, { recursive: true, force: true });
  });
  const filename = path.join(directory, "music-credentials.json");
  return {
    directory,
    filename,
    safeStorage,
    store: createKeyStore(directory, safeStorage),
    readFile: async () => JSON.parse(await fs.readFile(filename, "utf8")),
  };
}
const NOT_CONFIGURED = Object.fromEntries(
  PROVIDERS.map((provider) => [provider, { configured: false }]),
);

test("F03: one undecryptable entry is reported as damaged and hides nothing else", async (t) => {
  const { filename, store, readFile } = await fixture(t);
  for (const provider of PROVIDERS)
    await store.saveCredentials(provider, KEYS[provider]);
  const value = await readFile();
  value.providers.aliyun.encryptedCredentials = Buffer.from(
    "not what was encrypted",
  ).toString("base64");
  await fs.writeFile(filename, JSON.stringify(value));

  const statuses = await store.getStatuses();
  assert.deepEqual(statuses, {
    elevenlabs: { configured: true, model: "music_v2_5" },
    tencent: { configured: true, model: "minimax-music-v2.6" },
    volcengine: { configured: true, billingMode: "prepaid" },
    aliyun: { configured: true, damaged: true },
  });
  assert.deepEqual(
    await store.getCredentials("tencent"),
    KEYS.tencent,
    "healthy services keep working",
  );
  await assert.rejects(store.getCredentials("aliyun"), /无法解密此服务的凭据/);
  // Saving again repairs exactly that entry.
  await store.saveCredentials("aliyun", KEYS.aliyun);
  assert.deepEqual((await store.getStatuses()).aliyun, {
    configured: true,
    model: "fun-music-v1",
    workspaceId: "workspace-test-123",
  });
});

test("F03: malformed entries, missing secrets and a failing OS decrypt are isolated per service", async (t) => {
  const { filename, store, safeStorage, readFile } = await fixture(t);
  await store.saveCredentials("tencent", KEYS.tencent);
  await store.saveCredentials("elevenlabs", KEYS.elevenlabs);
  const value = await readFile();
  const seal = (data) =>
    safeStorage.encryptString(JSON.stringify(data)).toString("base64");
  value.providers.volcengine = { encryptedCredentials: 42 };
  value.providers.aliyun = {
    encryptedCredentials: seal({
      model: "fun-music-v1",
      workspaceId: "workspace-1",
    }),
  }; // decrypts, but the key is gone
  value.providers.tencent = {
    encryptedCredentials: seal({
      apiKey: KEYS.tencent.apiKey,
      model: "a-model-this-build-does-not-know",
    }),
  };
  await fs.writeFile(filename, JSON.stringify(value));
  assert.deepEqual(await store.getStatuses(), {
    elevenlabs: { configured: true, model: "music_v2_5" },
    tencent: { configured: true, model: "a-model-this-build-does-not-know" }, // lenient read: a stale model no longer fails the whole call
    volcengine: { configured: true, damaged: true },
    aliyun: { configured: true, damaged: true },
  });
  await assert.rejects(
    store.getCredentials("tencent"),
    /所选音乐模型不受支持/,
    "using it is still strict",
  );
  await store.deleteCredentials("volcengine");
  assert.deepEqual((await store.getStatuses()).volcengine, {
    configured: false,
  });

  const { directory } = await fixture(t);
  const broken = createKeyStore(directory, {
    ...fakeSafeStorage(),
    decryptString() {
      throw new Error("OS could not decrypt: key from another Windows account");
    },
  });
  await broken.saveCredentials("tencent", KEYS.tencent);
  const overview = await broken.getOverview();
  assert.deepEqual(overview.providers.tencent, {
    configured: true,
    damaged: true,
  });
  assert.deepEqual(overview.providers.aliyun, { configured: false });
  assert.equal(
    JSON.stringify(overview).includes("another Windows account"),
    false,
    "raw OS errors never leave the store",
  );
});

test("F03: status values never contain secrets or non-status fields", async (t) => {
  const { filename, store, safeStorage, readFile } = await fixture(t);
  await store.saveCredentials("tencent", KEYS.tencent);
  const value = await readFile();
  value.providers.tencent.encryptedCredentials = safeStorage
    .encryptString(
      JSON.stringify({
        apiKey: KEYS.tencent.apiKey,
        model: "has spaces and <html>",
        workspaceId: { nested: true },
        billingMode: "x".repeat(500),
        note: "extra",
      }),
    )
    .toString("base64");
  await fs.writeFile(filename, JSON.stringify(value));
  assert.deepEqual(
    (await store.getStatuses()).tencent,
    { configured: true },
    "only short id-like status fields are projected",
  );
});

test("F03: a credential file that cannot be used fails no status call, and reading it changes nothing", async (t) => {
  for (const content of [
    "",
    "{ not json",
    "[]",
    "null",
    JSON.stringify({ version: 3, providers: {} }),
    JSON.stringify({ version: 2, providers: [] }),
    JSON.stringify({ version: 1, encryptedApiKey: "***" }),
  ]) {
    const { directory, filename, store } = await fixture(t);
    await fs.writeFile(filename, content);
    const overview = await store.getOverview();
    for (const provider of PROVIDERS)
      assert.deepEqual(overview.providers[provider], {
        configured: false,
        damaged: true,
      });
    assert.deepEqual(overview.llm, { configured: false, damaged: true });
    assert.deepEqual(await store.getStatuses(), overview.providers);
    assert.deepEqual(await store.getLlmStatus(), overview.llm);
    await assert.rejects(store.getLlmSettings(), /无法读取服务凭据/);
    await assert.rejects(store.getCredentials("tencent"), /无法读取服务凭据/);
    await assert.rejects(store.hasKey("tencent"), /无法读取服务凭据/);
    assert.equal(
      await fs.readFile(filename, "utf8"),
      content,
      "the file is left exactly as it was",
    );
    assert.deepEqual(await fs.readdir(directory), ["music-credentials.json"]);
  }
});

test("F03: a file written by a later format version is never taken for damage - every write stays refused", async (t) => {
  for (const content of [
    JSON.stringify({ version: 3, providers: {} }),
    JSON.stringify({ version: 12, stores: [{ anything: true }] }),
  ]) {
    const notices = [];
    const { directory, filename, safeStorage } = await fixture(t);
    const store = createKeyStore(directory, safeStorage, {
      onQuarantine: (notice) => notices.push(notice),
    });
    await fs.writeFile(filename, content);
    for (const write of [
      () => store.saveCredentials("tencent", KEYS.tencent),
      () => store.saveKey(KEYS.elevenlabs.apiKey),
      () => store.saveLlmSettings(LLM.anthropic),
      () => store.deleteCredentials("tencent"),
      () => store.deleteLlmSettings(),
    ])
      await assert.rejects(
        write(),
        (error) =>
          error.name === "MusicError" &&
          error.message ===
            "无法读取服务凭据，请保留原数据目录并检查文件权限。",
      );
    assert.equal(await fs.readFile(filename, "utf8"), content);
    assert.deepEqual(await fs.readdir(directory), ["music-credentials.json"]);
    assert.deepEqual(notices, []);
  }
});

/* ------------------------------------------- a damaged credential file */
// A zero-byte or unparseable file used to refuse every save and every removal for ever:
// the app could not be given a key again without deleting the file by hand.

const DAMAGED_CONTENTS = {
  "zero bytes": Buffer.alloc(0),
  "only white space": Buffer.from("  \r\n"),
  "not JSON": Buffer.from("{ not json"),
  "cut off in the middle": Buffer.from(
    '{"version":2,"providers":{"tencent":{"encryptedCred',
  ),
  "bytes that are no text": Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]),
  "an array": Buffer.from("[]"),
  null: Buffer.from("null"),
  "a number": Buffer.from("42"),
  "an object without a version": Buffer.from('{"providers":{}}'),
  "version 2 without its providers": Buffer.from(
    JSON.stringify({ version: 2, providers: [] }),
  ),
  "version 1 without a usable key": Buffer.from(
    JSON.stringify({ version: 1, encryptedApiKey: "***" }),
  ),
  "more than the size limit": Buffer.alloc(1024 * 1024 + 64, "x"),
};
const damagedBackupsIn = async (directory) =>
  (await fs.readdir(directory)).filter((name) => /damaged/.test(name)).sort();
const CLOCK = () => new Date("2026-10-09T12:34:56.789Z");
const STAMPED = "music-credentials.damaged-20261009T123456Z.bak";

/** A store over `directory` with a fixed clock that records what it tells the user. */
function noticing(directory, safeStorage = fakeSafeStorage(), now = CLOCK) {
  const notices = [];
  return {
    notices,
    store: createKeyStore(directory, safeStorage, {
      now,
      onQuarantine: (notice) => notices.push(notice),
    }),
  };
}

test("a damaged credential file no longer refuses saving or removing: it is set aside, the store starts empty, and the user is told once", async (t) => {
  const operations = {
    "save a music service": {
      run: (store) => store.saveCredentials("tencent", KEYS.tencent),
      after: async (store, value) => {
        assert.deepEqual(Object.keys(value.providers), ["tencent"]);
        assert.deepEqual(await store.getCredentials("tencent"), KEYS.tencent);
      },
    },
    "save the ElevenLabs key": {
      run: (store) => store.saveKey(KEYS.elevenlabs.apiKey),
      after: async (store) =>
        assert.equal(await store.getKey(), KEYS.elevenlabs.apiKey),
    },
    "save the language model": {
      run: (store) => store.saveLlmSettings(LLM.anthropic),
      after: async (store, value) => {
        assert.deepEqual(value.providers, {});
        assert.equal((await store.getLlmSettings()).model, LLM.anthropic.model);
      },
    },
    "remove a music service": {
      run: (store) => store.deleteCredentials("tencent"),
      after: async (_store, value) =>
        assert.deepEqual(value, { version: 2, providers: {} }),
    },
    "remove the language model": {
      run: (store) => store.deleteLlmSettings(),
      after: async (_store, value) =>
        assert.deepEqual(value, { version: 2, providers: {} }),
    },
  };
  for (const [kind, bytes] of Object.entries(DAMAGED_CONTENTS)) {
    for (const [name, operation] of Object.entries(operations)) {
      const label = `${kind} / ${name}`;
      const { directory, filename, readFile } = await fixture(t);
      await fs.writeFile(filename, bytes);
      const { store, notices } = noticing(directory);
      assert.deepEqual((await store.getOverview()).llm, {
        configured: false,
        damaged: true,
      });
      assert.deepEqual(await damagedBackupsIn(directory), [], label);

      await operation.run(store);

      assert.deepEqual(await damagedBackupsIn(directory), [STAMPED], label);
      assert.ok(
        (await fs.readFile(path.join(directory, STAMPED))).equals(bytes),
        `${label}: the damaged file is kept byte for byte`,
      );
      const value = await readFile();
      assert.equal(value.version, 2, label);
      await operation.after(store, value);
      assert.deepEqual(
        notices,
        [{ backupName: STAMPED }],
        `${label}: the user is told, once, where the old file went`,
      );
      // From here on it is an ordinary store: nothing is reported as damaged, copied or announced again.
      const overview = await store.getOverview();
      assert.equal(JSON.stringify(overview).includes("damaged"), false, label);
      await store.saveCredentials("aliyun", KEYS.aliyun);
      await store.saveLlmSettings(LLM.ollama);
      await store.deleteCredentials("aliyun");
      assert.deepEqual(await damagedBackupsIn(directory), [STAMPED], label);
      assert.equal(notices.length, 1, label);
      assert.deepEqual(
        (await fs.readdir(directory)).sort(),
        [STAMPED, "music-credentials.json"],
        `${label}: no temporary file is left`,
      );
    }
  }
});

test("a damaged credential file: reading sets nothing aside and says that the file is damaged", async (t) => {
  for (const [kind, bytes] of Object.entries(DAMAGED_CONTENTS)) {
    const { directory, filename } = await fixture(t);
    await fs.writeFile(filename, bytes);
    const { store, notices } = noticing(directory);
    await store.getOverview();
    await store.getStatuses();
    await store.getLlmStatus();
    for (const read of [
      () => store.getCredentials("tencent"),
      () => store.getKey(),
      () => store.hasKey("aliyun"),
      () => store.getLlmSettings(),
    ])
      await assert.rejects(
        read(),
        (error) =>
          error.name === "MusicError" &&
          error.message ===
            "无法读取服务凭据：凭据文件已损坏。请在设置中重新填写并保存密钥。",
        kind,
      );
    assert.deepEqual(await fs.readdir(directory), ["music-credentials.json"]);
    assert.ok((await fs.readFile(filename)).equals(bytes), kind);
    assert.deepEqual(notices, []);
  }
});

test("a damaged credential file: an existing .bak is never written over, and the same damage is not copied twice", async (t) => {
  const { directory, filename } = await fixture(t);
  const damaged = Buffer.from("{ first damage");
  await fs.writeFile(filename, damaged);
  // Files that already carry the names this copy would get, with other content.
  await fs.writeFile(path.join(directory, STAMPED), "an earlier copy");
  await fs.writeFile(
    path.join(directory, STAMPED.replace(".bak", "-2.bak")),
    "another earlier copy",
  );
  const { store, notices } = noticing(directory);
  await store.saveCredentials("tencent", KEYS.tencent);
  const third = STAMPED.replace(".bak", "-3.bak");
  assert.deepEqual(await damagedBackupsIn(directory), [
    STAMPED.replace(".bak", "-2.bak"),
    third,
    STAMPED,
  ]);
  assert.equal(
    await fs.readFile(path.join(directory, STAMPED), "utf8"),
    "an earlier copy",
  );
  assert.equal(
    await fs.readFile(
      path.join(directory, STAMPED.replace(".bak", "-2.bak")),
      "utf8",
    ),
    "another earlier copy",
  );
  assert.ok((await fs.readFile(path.join(directory, third))).equals(damaged));
  assert.deepEqual(notices, [{ backupName: third }]);

  // The same damaged file turns up again (restored from a backup, say): its copy is already there.
  await fs.writeFile(filename, damaged);
  const later = noticing(
    directory,
    fakeSafeStorage(),
    () => new Date("2027-01-02T03:04:05Z"),
  );
  await later.store.saveCredentials("tencent", KEYS.tencent);
  assert.equal((await damagedBackupsIn(directory)).length, 3, "no pile");
  assert.deepEqual(later.notices, [{ backupName: third }]);
  // Different damage is a different copy, under the time it was found.
  await fs.writeFile(filename, "{ second damage");
  await later.store.deleteCredentials("tencent");
  const fourth = "music-credentials.damaged-20270102T030405Z.bak";
  assert.equal(
    await fs.readFile(path.join(directory, fourth), "utf8"),
    "{ second damage",
  );
  assert.deepEqual(later.notices.at(-1), { backupName: fourth });
  assert.equal((await damagedBackupsIn(directory)).length, 4);
});

test("a damaged credential file: if no copy can be made nothing is written; if the new file cannot be written the user is not told it was", async (t) => {
  const { directory, filename } = await fixture(t);
  const damaged = Buffer.from("");
  await fs.writeFile(filename, damaged);
  const { store, notices } = noticing(directory);
  const realWrite = fs.writeFile;
  let refuse = ".bak";
  t.mock.method(fs, "writeFile", async (file, ...rest) => {
    if (String(file).endsWith(refuse))
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    return realWrite(file, ...rest);
  });
  for (const write of [
    () => store.saveCredentials("tencent", KEYS.tencent),
    () => store.saveLlmSettings(LLM.anthropic),
    () => store.deleteCredentials("tencent"),
    () => store.deleteLlmSettings(),
  ])
    await assert.rejects(write(), (error) => {
      assert.equal(error.name, "MusicError");
      assert.equal(
        error.message,
        "凭据文件已损坏，而且无法在数据目录中为它留下备份，所以这次没有保存。请检查数据目录是否可写后重试。",
      );
      return true;
    });
  assert.deepEqual(await fs.readdir(directory), ["music-credentials.json"]);
  assert.ok((await fs.readFile(filename)).equals(damaged));
  assert.deepEqual(notices, []);

  // The copy succeeds, the new file does not: the save fails as any save would, and says nothing about a copy.
  refuse = ".tmp";
  await assert.rejects(
    store.saveCredentials("tencent", KEYS.tencent),
    /无法保存加密凭据/,
  );
  assert.deepEqual(await damagedBackupsIn(directory), [STAMPED]);
  assert.ok(
    (await fs.readFile(filename)).equals(damaged),
    "still the damaged file",
  );
  assert.deepEqual(notices, []);
  // The next attempt goes through, reuses that copy and tells the user then.
  t.mock.restoreAll();
  await store.saveCredentials("tencent", KEYS.tencent);
  assert.deepEqual(await damagedBackupsIn(directory), [STAMPED]);
  assert.deepEqual(notices, [{ backupName: STAMPED }]);
  assert.deepEqual(await store.getCredentials("tencent"), KEYS.tencent);
});

test("a damaged credential file: a save that would be refused anyway copies nothing; racing saves make one copy and one notice", async (t) => {
  const { directory, filename } = await fixture(t);
  await fs.writeFile(filename, "{ damaged");
  const { store, notices } = noticing(directory);
  await assert.rejects(
    store.saveCredentials("tencent", { apiKey: "short" }),
    /格式不正确/,
  );
  await assert.rejects(
    store.saveCredentials("../main", KEYS.tencent),
    /不支持/,
  );
  await assert.rejects(store.deleteCredentials("../main"), /不支持/);
  await assert.rejects(store.saveLlmSettings({ kind: "nope" }), /不支持/);
  await assert.rejects(
    noticing(directory, fakeSafeStorage(false)).store.saveCredentials(
      "tencent",
      KEYS.tencent,
    ),
    /系统密钥保护不可用/,
  );
  assert.deepEqual(await fs.readdir(directory), ["music-credentials.json"]);
  assert.equal(await fs.readFile(filename, "utf8"), "{ damaged");
  assert.deepEqual(notices, []);

  await Promise.all([
    store.saveCredentials("tencent", KEYS.tencent),
    store.saveKey(KEYS.elevenlabs.apiKey),
    store.saveLlmSettings(LLM.ollama),
    store.saveCredentials("volcengine", KEYS.volcengine),
  ]);
  assert.deepEqual(await damagedBackupsIn(directory), [STAMPED]);
  assert.deepEqual(notices, [{ backupName: STAMPED }]);
  const overview = await store.getOverview();
  assert.deepEqual(
    PROVIDERS.filter((provider) => overview.providers[provider].configured),
    ["elevenlabs", "tencent", "volcengine"],
  );
  assert.equal(overview.llm.kind, "ollama");
});

test("a damaged credential file: telling the user can fail without failing the save; a file that cannot be read at all is left alone", async (t) => {
  const { directory, filename, safeStorage } = await fixture(t);
  await fs.writeFile(filename, "");
  const store = createKeyStore(directory, safeStorage, {
    now: CLOCK,
    onQuarantine: () => {
      throw new Error("the dialog could not be shown");
    },
  });
  await store.saveCredentials("tencent", KEYS.tencent);
  assert.deepEqual(await store.getCredentials("tencent"), KEYS.tencent);
  // No listener at all (the unit-test default) is fine too.
  const silent = await fixture(t);
  await fs.writeFile(silent.filename, "");
  await silent.store.saveCredentials("tencent", KEYS.tencent);
  assert.equal((await damagedBackupsIn(silent.directory)).length, 1);

  // Something that is not a file sits where the store should be: nothing can be read, nothing is replaced.
  const blocked = await fixture(t);
  await fs.mkdir(blocked.filename);
  const { store: unreadable, notices } = noticing(blocked.directory);
  for (const write of [
    () => unreadable.saveCredentials("tencent", KEYS.tencent),
    () => unreadable.deleteCredentials("tencent"),
    () => unreadable.saveLlmSettings(LLM.anthropic),
  ])
    await assert.rejects(
      write(),
      (error) =>
        error.message === "无法读取服务凭据，请保留原数据目录并检查文件权限。",
    );
  assert.deepEqual(await fs.readdir(blocked.directory), [
    "music-credentials.json",
  ]);
  assert.deepEqual(notices, []);
});

test("main.cjs tells the user about the set-aside file in a dialog of its own, naming the copy", () => {
  const { wires } = require("./helpers/source-shape.cjs");
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "..", "electron", "main.cjs"),
    "utf8",
  );
  assert.ok(
    wires(
      source,
      `keyStore = createKeyStore(app.getPath("userData"), safeStorage, { onQuarantine: reportQuarantine })`,
    ),
  );
  assert.ok(wires(source, `function reportQuarantine({ backupName }) {`));
  const body = source.slice(
    source.indexOf("function reportQuarantine"),
    source.indexOf("function cancelJobs"),
  );
  assert.match(body, /dialog\.showMessageBox/);
  assert.match(body, /之前保存的密钥需要重新填写/);
  assert.match(body, /\$\{backupName\}/);
  assert.match(
    body,
    /\.catch\(/,
    "a dialog that fails is not an unhandled rejection",
  );
});

test("F07: ids and top-level keys from a newer build are tolerated and survive every write", async (t) => {
  const { filename, store, safeStorage, readFile } = await fixture(t);
  await store.saveCredentials("tencent", KEYS.tencent);
  const value = await readFile();
  const future = {
    encryptedCredentials: safeStorage
      .encryptString('{"apiKey":"future-service-key"}')
      .toString("base64"),
    addedIn: "0.9",
  };
  value.providers.suno = future;
  value.providers.udio = { shape: "unknown to this build" };
  value.agents = { planner: { encrypted: "abc" } };
  value.schemaHints = [1, 2, 3];
  await fs.writeFile(filename, JSON.stringify(value));

  assert.deepEqual(await store.getStatuses(), {
    ...NOT_CONFIGURED,
    tencent: { configured: true, model: "minimax-music-v2.6" },
  });
  assert.deepEqual(await store.getCredentials("tencent"), KEYS.tencent);
  assert.equal(await store.hasKey("tencent"), true);
  assert.throws(
    () => normalizeCredentials("suno", { apiKey: "future-service-key" }),
    /不支持/,
    "unknown ids are preserved, not usable",
  );

  await store.saveCredentials("aliyun", KEYS.aliyun);
  await store.saveLlmSettings(LLM.anthropic);
  await store.deleteCredentials("tencent");
  await store.deleteLlmSettings();
  const after = await readFile();
  assert.deepEqual(after.providers.suno, future);
  assert.deepEqual(after.providers.udio, { shape: "unknown to this build" });
  assert.deepEqual(after.agents, { planner: { encrypted: "abc" } });
  assert.deepEqual(after.schemaHints, [1, 2, 3]);
  assert.deepEqual(Object.keys(after.providers).sort(), [
    "aliyun",
    "suno",
    "udio",
  ]);
  assert.equal(after.version, 2);
});

test("LLM settings are stored encrypted under their own top-level key and never listed as a music service", async (t) => {
  const { filename, store, readFile } = await fixture(t);
  assert.deepEqual(await store.getLlmStatus(), { configured: false });
  await assert.rejects(store.getLlmSettings(), /还没有配置大模型/);
  await store.saveCredentials("tencent", KEYS.tencent);
  await store.saveLlmSettings(LLM.openai);

  const value = await readFile();
  assert.deepEqual(Object.keys(value).sort(), ["llm", "providers", "version"]);
  assert.deepEqual(
    Object.keys(value.providers),
    ["tencent"],
    "old builds reject unknown ids inside providers, so the LLM never goes there",
  );
  assert.deepEqual(Object.keys(value.llm), ["encryptedSettings"]);
  const raw = await fs.readFile(filename, "utf8");
  for (const secret of [LLM.openai.apiKey, "deepseek", KEYS.tencent.apiKey])
    assert.equal(raw.includes(secret), false);

  const status = await store.getLlmStatus();
  assert.deepEqual(status, {
    configured: true,
    kind: "openai",
    model: "deepseek-chat",
    preset: "deepseek",
    baseUrl: "https://api.deepseek.com",
  });
  assert.equal(
    JSON.stringify(await store.getOverview()).includes(LLM.openai.apiKey),
    false,
    "the key is never part of a status",
  );
  assert.deepEqual(await store.getLlmSettings(), {
    kind: "openai",
    preset: "deepseek",
    apiKey: LLM.openai.apiKey,
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
  });
  assert.deepEqual(await store.getStatuses(), {
    ...NOT_CONFIGURED,
    tencent: { configured: true, model: "minimax-music-v2.6" },
  });
  for (const kind of LLM_KINDS) assert.equal(PROVIDERS.includes(kind), false);

  await store.saveLlmSettings(LLM.anthropic);
  assert.deepEqual(await store.getLlmStatus(), {
    configured: true,
    kind: "anthropic",
    model: "claude-sonnet-5-5",
    preset: "claude",
  });
  await store.saveLlmSettings(LLM.ollama);
  assert.deepEqual(await store.getLlmStatus(), {
    configured: true,
    kind: "ollama",
    model: "qwen3.5:9b-q4_K_M",
    preset: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
  });
  assert.deepEqual(await store.getLlmSettings(), {
    kind: "ollama",
    preset: "ollama",
    apiKey: "",
    model: "qwen3.5:9b-q4_K_M",
    baseUrl: "http://127.0.0.1:11434/v1",
  });

  await store.deleteLlmSettings();
  assert.deepEqual(await store.getLlmStatus(), { configured: false });
  assert.deepEqual(
    await store.getCredentials("tencent"),
    KEYS.tencent,
    "music credentials are untouched",
  );
  await store.deleteLlmSettings(); // deleting twice is fine
});

test("LLM settings: invalid input and unavailable encryption never change the file; damaged entry is isolated", async (t) => {
  const { directory, filename, store, readFile } = await fixture(t);
  await store.saveLlmSettings(LLM.anthropic);
  const original = await fs.readFile(filename, "utf8");
  for (const invalid of [
    null,
    "text",
    [],
    {},
    { ...LLM.anthropic, kind: "tencent" },
    { ...LLM.anthropic, kind: "elevenlabs" },
    { ...LLM.anthropic, apiKey: "short" },
    { ...LLM.anthropic, apiKey: "has space inside key" },
    { ...LLM.anthropic, model: "claude-opus-4-1" },
    { ...LLM.anthropic, preset: "../../x" },
    { ...LLM.openai, model: "bad model name" },
    { ...LLM.openai, model: "" },
    { ...LLM.openai, baseUrl: "http://api.deepseek.com" },
    { ...LLM.openai, baseUrl: undefined },
    { ...LLM.openai, apiKey: "" },
    { ...LLM.ollama, baseUrl: "http://192.168.1.5:11434/v1" },
  ]) {
    await assert.rejects(
      store.saveLlmSettings(invalid),
      (error) => error.name === "MusicError",
      JSON.stringify(invalid),
    );
    assert.equal(await fs.readFile(filename, "utf8"), original);
  }
  await assert.rejects(
    createKeyStore(directory, fakeSafeStorage(false)).saveLlmSettings(
      LLM.openai,
    ),
    /系统密钥保护不可用/,
  );
  assert.equal(await fs.readFile(filename, "utf8"), original);

  await store.saveCredentials("tencent", KEYS.tencent);
  const value = await readFile();
  value.llm = { encryptedSettings: "Z2FyYmFnZQ==" };
  await fs.writeFile(filename, JSON.stringify(value));
  const overview = await store.getOverview();
  assert.deepEqual(overview.llm, { configured: true, damaged: true });
  assert.deepEqual(overview.providers.tencent, {
    configured: true,
    model: "minimax-music-v2.6",
  });
  await assert.rejects(store.getLlmSettings(), /无法解密大模型设置/);
  await store.saveLlmSettings(LLM.anthropic); // saving again repairs it
  assert.equal((await store.getLlmStatus()).configured, true);
  assert.equal((await store.getLlmStatus()).damaged, undefined);
});

test("LLM settings can be added to a legacy V1 file without losing the ElevenLabs key", async (t) => {
  const { filename, store, safeStorage, readFile } = await fixture(t);
  const legacyKey = "legacy-elevenlabs-secret-key";
  await fs.writeFile(
    filename,
    JSON.stringify({
      version: 1,
      encryptedApiKey: safeStorage.encryptString(legacyKey).toString("base64"),
      keptForLater: "yes",
    }),
  );
  assert.deepEqual(await store.getLlmStatus(), { configured: false });
  assert.deepEqual((await store.getStatuses()).elevenlabs, {
    configured: true,
  });
  await store.saveLlmSettings(LLM.anthropic);
  const migrated = await readFile();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.keptForLater, "yes");
  assert.equal("encryptedApiKey" in migrated, false);
  assert.equal(await store.getKey(), legacyKey);
  assert.equal((await store.getLlmSettings()).model, "claude-sonnet-5-5");
});

/* ------------------------------------------------------------------ MAIN-06 */

/** safeStorage of "another Windows account": it encrypts and decrypts its own data, but not `foreign` blobs. */
function otherAccount() {
  const base = fakeSafeStorage();
  return {
    ...base,
    decryptString: (value) => {
      const text = base.decryptString(value);
      if (!text.startsWith("{"))
        throw new Error(
          "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
        );
      return text;
    },
  };
}
const backupsIn = async (directory) =>
  (await fs.readdir(directory)).filter((name) =>
    /^music-credentials\.v1-[0-9a-f]{12}\.bak$/.test(name),
  );

test("MAIN-06: a V1 file whose key cannot be decrypted no longer blocks any save; the old file is kept as a .bak", async (t) => {
  const legacyFile = JSON.stringify({
    version: 1,
    encryptedApiKey: fakeSafeStorage()
      .encryptString("legacy-elevenlabs-secret-key")
      .toString("base64"),
    keptForLater: "yes",
  });
  const saves = {
    "the ElevenLabs key itself (what the damaged notice asks for)": (store) =>
      store.saveKey(KEYS.elevenlabs.apiKey),
    "another music service": (store) =>
      store.saveCredentials("tencent", KEYS.tencent),
    "the language model": (store) => store.saveLlmSettings(LLM.anthropic),
  };
  for (const [name, save] of Object.entries(saves)) {
    const { directory, filename, readFile } = await fixture(t);
    await fs.writeFile(filename, legacyFile);
    const store = createKeyStore(directory, otherAccount());
    // Before any save: reported honestly, nothing touched.
    assert.deepEqual((await store.getOverview()).providers.elevenlabs, {
      configured: true,
      damaged: true,
    });
    await assert.rejects(
      store.getCredentials("elevenlabs"),
      /无法解密此服务的凭据，请在当前 Windows 账户中重新保存/,
    );
    assert.deepEqual(await backupsIn(directory), []);
    assert.equal(await fs.readFile(filename, "utf8"), legacyFile);

    await save(store);

    const backups = await backupsIn(directory);
    assert.equal(backups.length, 1, name);
    assert.equal(
      await fs.readFile(path.join(directory, backups[0]), "utf8"),
      legacyFile,
      `${name}: the unreadable file is preserved byte for byte`,
    );
    const value = await readFile();
    assert.equal(value.version, 2);
    assert.equal("encryptedApiKey" in value, false);
    assert.equal(
      value.keptForLater,
      "yes",
      "other top-level keys are carried over",
    );
    const overview = await store.getOverview();
    if (name.startsWith("the ElevenLabs")) {
      assert.deepEqual(overview.providers.elevenlabs, {
        configured: true,
        model: "music_v1",
      });
      assert.equal(await store.getKey(), KEYS.elevenlabs.apiKey);
    } else {
      assert.deepEqual(
        overview.providers.elevenlabs,
        { configured: false },
        `${name}: the unreadable key is no longer listed as stored`,
      );
      assert.equal("elevenlabs" in value.providers, false);
    }
    if (name === "another music service")
      assert.deepEqual(await store.getCredentials("tencent"), KEYS.tencent);
    if (name === "the language model")
      assert.equal((await store.getLlmSettings()).model, LLM.anthropic.model);
    // Every later save works as on any V2 file, and makes no further copies.
    await store.saveCredentials("aliyun", KEYS.aliyun);
    await store.saveKey(KEYS.elevenlabs.apiKey);
    assert.deepEqual(await backupsIn(directory), backups);
    assert.deepEqual((await store.getStatuses()).elevenlabs, {
      configured: true,
      model: "music_v1",
    });
  }
});

test("MAIN-06: a legacy key that decrypts but is not a usable key is quarantined the same way", async (t) => {
  const { directory, filename, safeStorage, store } = await fixture(t);
  const legacyFile = JSON.stringify({
    version: 1,
    encryptedApiKey: safeStorage.encryptString("has spaces").toString("base64"),
  });
  await fs.writeFile(filename, legacyFile);
  await store.saveCredentials("tencent", KEYS.tencent);
  assert.equal((await backupsIn(directory)).length, 1);
  assert.deepEqual(await store.getCredentials("tencent"), KEYS.tencent);
  assert.deepEqual((await store.getStatuses()).elevenlabs, {
    configured: false,
  });
});

test("MAIN-06: repeating the quarantine keeps one copy; a readable legacy key is migrated and needs none", async (t) => {
  const { directory, filename, safeStorage } = await fixture(t);
  const legacyFile = JSON.stringify({
    version: 1,
    encryptedApiKey: safeStorage
      .encryptString("legacy-elevenlabs-secret-key")
      .toString("base64"),
  });
  const store = createKeyStore(directory, otherAccount());
  for (let round = 0; round < 3; round++) {
    await fs.writeFile(filename, legacyFile); // e.g. the same old file restored again
    await store.saveCredentials("tencent", KEYS.tencent);
  }
  assert.equal(
    (await backupsIn(directory)).length,
    1,
    "named after the content: no pile of copies",
  );

  const healthy = await fixture(t);
  await fs.writeFile(healthy.filename, legacyFile);
  await healthy.store.saveCredentials("tencent", KEYS.tencent);
  assert.deepEqual(await backupsIn(healthy.directory), []);
  assert.equal(await healthy.store.getKey(), "legacy-elevenlabs-secret-key");
});

test("MAIN-06: if the copy cannot be made nothing is written, and the message says what happened", async (t) => {
  const { directory, filename } = await fixture(t);
  const legacyFile = JSON.stringify({
    version: 1,
    encryptedApiKey: fakeSafeStorage()
      .encryptString("legacy-elevenlabs-secret-key")
      .toString("base64"),
  });
  await fs.writeFile(filename, legacyFile);
  const store = createKeyStore(directory, otherAccount());
  const realWrite = fs.writeFile;
  t.mock.method(fs, "writeFile", async (file, ...rest) => {
    if (String(file).endsWith(".bak"))
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    return realWrite(file, ...rest);
  });
  for (const save of [
    () => store.saveCredentials("tencent", KEYS.tencent),
    () => store.saveLlmSettings(LLM.anthropic),
    () => store.saveKey(KEYS.elevenlabs.apiKey),
  ]) {
    await assert.rejects(save(), (error) => {
      assert.equal(error.name, "MusicError");
      assert.match(error.message, /旧版本保存的 ElevenLabs 密钥已无法解密/);
      assert.match(error.message, /没有保存/);
      assert.equal(/EACCES/.test(error.message), false);
      return true;
    });
  }
  t.mock.restoreAll();
  assert.equal(
    await fs.readFile(filename, "utf8"),
    legacyFile,
    "the only copy of the old key is never destroyed",
  );
  assert.deepEqual(await backupsIn(directory), []);
  // Unavailable encryption is still reported as such, before anything is copied.
  await assert.rejects(
    createKeyStore(directory, fakeSafeStorage(false)).saveCredentials(
      "tencent",
      KEYS.tencent,
    ),
    /系统密钥保护不可用/,
  );
  assert.deepEqual(await backupsIn(directory), []);
});

test("normalizeLlmSettings returns exactly {kind, preset, apiKey, model, baseUrl}", () => {
  assert.deepEqual(
    normalizeLlmSettings({
      kind: "anthropic",
      apiKey: "  sk-ant-fake-key-for-tests-only  ",
      model: "",
      extra: "dropped",
      baseUrl: "https://evil.test",
    }),
    {
      kind: "anthropic",
      preset: "custom",
      apiKey: "sk-ant-fake-key-for-tests-only",
      model: "claude-opus-5-5",
      baseUrl: "",
    },
  );
  assert.deepEqual(ANTHROPIC_MODELS, [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]);
  for (const model of ANTHROPIC_MODELS)
    assert.equal(
      normalizeLlmSettings({ ...LLM.anthropic, model }).model,
      model,
    );
  for (const model of [
    "deepseek-chat",
    "ep-20260801123456-abcde",
    "qwen3.5:9b-q4_K_M",
    "Qwen/Qwen3-72B-Instruct",
    "gpt-5.1",
    "glm-4.6",
    "a".repeat(128),
  ]) {
    assert.equal(normalizeLlmSettings({ ...LLM.openai, model }).model, model);
  }
  for (const model of [
    "",
    " ",
    "-leading-dash",
    "has space",
    "semi;colon",
    "a".repeat(129),
    "模型",
    "new\nline",
    undefined,
    42,
  ]) {
    assert.throws(
      () => normalizeLlmSettings({ ...LLM.openai, model }),
      /模型名称格式不正确/,
      String(model),
    );
  }
  assert.equal(
    normalizeLlmSettings({
      ...LLM.ollama,
      apiKey: "ignored-key-for-local-model",
    }).apiKey,
    "",
    "a local model never gets a key",
  );
  assert.equal(
    normalizeLlmSettings({
      ...LLM.ollama,
      baseUrl: "http://localhost:8080/v1/",
    }).baseUrl,
    "http://127.0.0.1:8080/v1",
  );
});

test("F16: one secret length limit for the store, the adapters and the LLM key", async (t) => {
  const long = "k".repeat(SECRET_MAX);
  assert.equal(SECRET_MAX, 4096);
  assert.equal(cleanSecret(`  ${long}  `), long);
  assert.equal(cleanSecret(`${long}k`), null);
  assert.equal(cleanSecret("k".repeat(9)), null);
  assert.equal(cleanSecret("has space in the middle"), null);
  assert.equal(cleanSecret("line\nbreak-inside-key"), null);
  assert.equal(cleanSecret(42), null);
  // A JWT-sized key (600 chars) was rejected by the v0.2 store although the adapter accepted it.
  const jwt = `eyJ${"a".repeat(597)}`;
  assert.equal(normalizeCredentials("tencent", { apiKey: jwt }).apiKey, jwt);
  assert.equal(
    normalizeCredentials("volcengine", {
      accessKeyId: jwt,
      secretAccessKey: long,
    }).secretAccessKey,
    long,
  );
  assert.equal(
    normalizeLlmSettings({ ...LLM.openai, apiKey: long }).apiKey,
    long,
  );
  for (const tooLong of [`${long}k`]) {
    assert.throws(() => normalizeCredentials("tencent", { apiKey: tooLong }));
    assert.throws(() =>
      normalizeLlmSettings({ ...LLM.openai, apiKey: tooLong }),
    );
  }
  const tencent = require("../electron/providers/tencent.cjs");
  const volcengine = require("../electron/providers/volcengine.cjs");
  const aliyun = require("../electron/providers/aliyun.cjs");
  const { validateApiKey } = require("../electron/music-service.cjs");
  assert.equal(validateApiKey(long), long);
  assert.throws(() => validateApiKey(`${long}k`));
  assert.equal(
    volcengine.validateCredentials({ accessKeyId: long, secretAccessKey: long })
      .accessKeyId,
    long,
  );
  assert.throws(() =>
    volcengine.validateCredentials({
      accessKeyId: `${long}k`,
      secretAccessKey: long,
    }),
  );
  assert.equal(
    aliyun.buildRequest(
      { prompt: "测试", duration: 30 },
      { apiKey: long, workspaceId: "workspace-1" },
    ).headers.Authorization,
    `Bearer ${long}`,
  );
  assert.throws(() =>
    aliyun.buildRequest(
      { prompt: "测试", duration: 30 },
      { apiKey: `${long}k`, workspaceId: "workspace-1" },
    ),
  );
  let sent = 0;
  await assert.rejects(
    tencent.generate({
      input: { prompt: "测试", duration: 30 },
      credentials: { apiKey: `${long}k` },
      fetchImpl: async () => {
        sent++;
        return new Response("{}");
      },
    }),
    /API Key/,
  );
  assert.equal(sent, 0);
  // The whole set of maximum-length secrets still fits the credential file.
  const { store } = await (async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "muse-key-store-"),
    );
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { store: createKeyStore(directory, fakeSafeStorage()) };
  })();
  await store.saveCredentials("elevenlabs", { apiKey: long });
  await store.saveCredentials("tencent", { apiKey: long });
  await store.saveCredentials("aliyun", {
    apiKey: long,
    workspaceId: "workspace-1",
  });
  await store.saveCredentials("volcengine", {
    accessKeyId: long,
    secretAccessKey: long,
  });
  await store.saveLlmSettings({ ...LLM.openai, apiKey: long });
  assert.equal(
    (await store.getCredentials("volcengine")).secretAccessKey,
    long,
  );
  assert.equal((await store.getLlmSettings()).apiKey, long);
});
