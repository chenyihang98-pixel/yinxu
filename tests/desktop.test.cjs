"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createMusicService,
  validateInput,
  safeFilename,
  isAllowedExternal,
} = require("../electron/music-service.cjs");
const { createKeyStore } = require("../electron/key-store.cjs");

const KEY = "test-secret-api-key-not-real";
const INPUT = { prompt: "青春欢快，轻盈的吉他与钢琴", duration: 30 };
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 1, 0]);
function audioResponse() {
  return new Response(MP3, { headers: { "Content-Type": "audio/mpeg" } });
}

test("provider sends one instrumental request and returns only audio", async () => {
  const calls = [];
  const service = createMusicService({
    fetchImpl: async (...args) => {
      calls.push(args);
      return audioResponse();
    },
  });
  const result = await service.generate(INPUT, KEY);
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(
    url,
    "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128",
  );
  assert.equal(options.headers["xi-api-key"], KEY);
  assert.equal(options.redirect, "error");
  assert.deepEqual(JSON.parse(options.body), {
    prompt: INPUT.prompt,
    music_length_ms: 30000,
    force_instrumental: true,
    model_id: "music_v1",
  });
  assert.equal(result.mimeType, "audio/mpeg");
  assert.ok(result.audio instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(result.audio), MP3);
  assert.equal(service.busy, false);
});

test("rejects malformed parameters before any network request", async () => {
  let calls = 0;
  const service = createMusicService({
    fetchImpl: async () => {
      calls++;
      return audioResponse();
    },
  });
  for (const invalid of [
    null,
    { ...INPUT, prompt: "" },
    { ...INPUT, prompt: "a".repeat(4101) },
    { ...INPUT, duration: 2 },
    { ...INPUT, duration: Infinity },
    { ...INPUT, duration: "30" },
    { ...INPUT, duration: 601 },
    { ...INPUT, model: "other" },
  ]) {
    await assert.rejects(service.generate(invalid, KEY));
  }
  await assert.rejects(service.generate(INPUT, "bad\r\nkey"));
  assert.equal(calls, 0);
  assert.equal(
    validateInput({ ...INPUT, model: "music_v2_5", duration: 3 }).model_id,
    "music_v2_5",
  );
});

test("upstream failures never reveal keys or raw response bodies and never retry", async () => {
  for (const status of [400, 401, 402, 403, 422, 429, 500]) {
    let calls = 0;
    const service = createMusicService({
      fetchImpl: async () => {
        calls++;
        return new Response(`secret=${KEY}`, { status });
      },
    });
    await assert.rejects(service.generate(INPUT, KEY), (error) => {
      assert.equal(error.name, "MusicError");
      assert.equal(error.message.includes(KEY), false);
      if (status === 401) assert.match(error.message, /API Key 无效/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(service.busy, false);
  }
  const service = createMusicService({
    fetchImpl: async () => {
      throw new Error(KEY);
    },
  });
  await assert.rejects(
    service.generate(INPUT, KEY),
    (error) => !error.message.includes(KEY) && /网络/.test(error.message),
  );
});

test("prevents concurrent billed requests; cancellation aborts the first and frees the lock", async () => {
  let calls = 0;
  let firstSignal;
  const service = createMusicService({
    fetchImpl: (_url, { signal }) => {
      calls++;
      firstSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    },
  });
  const first = service.generate(INPUT, KEY);
  assert.equal(service.busy, true);
  await assert.rejects(service.generate(INPUT, KEY), /正在生成/);
  assert.equal(calls, 1);
  service.cancel();
  assert.equal(firstSignal.aborted, true);
  await assert.rejects(first, /已取消等待生成/);
  assert.equal(service.busy, false);
});

test("timeouts are abortable, sanitized, and do not trigger a retry", async () => {
  let calls = 0;
  const service = createMusicService({
    timeoutMs: 15,
    fetchImpl: (_url, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error(KEY)), {
          once: true,
        }),
      );
    },
  });
  await assert.rejects(service.generate(INPUT, KEY), /超过 5 分钟/);
  assert.equal(calls, 1);
  assert.equal(service.busy, false);
});

test("rejects non-audio, oversized headers, oversized streams, and corrupt MP3 payloads", async () => {
  const cases = [
    () =>
      new Response('{"error":"secret"}', {
        headers: { "Content-Type": "application/json" },
      }),
    () =>
      new Response(MP3, {
        headers: { "Content-Type": "audio/mpeg", "Content-Length": "1024" },
      }),
    () =>
      new Response(new Uint8Array(20), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    () =>
      new Response("not mp3", { headers: { "Content-Type": "audio/mpeg" } }),
    () =>
      new Response(new Uint8Array(), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
  ];
  for (const makeResponse of cases) {
    const service = createMusicService({
      fetchImpl: async () => makeResponse(),
      maxBytes: 15,
    });
    await assert.rejects(service.generate(INPUT, KEY));
    assert.equal(service.busy, false);
  }
});

test("export filenames cannot contain paths or Windows reserved device names", () => {
  assert.equal(
    safeFilename("../青春/夏天:01.mp3", "mp3"),
    ".._青春_夏天_01.mp3",
  );
  assert.equal(safeFilename("CON", "wav"), "Muse-BGM.wav");
  assert.equal(safeFilename("aux.json", "json"), "Muse-BGM.json");
  assert.equal(safeFilename("春天.wav", "wav"), "春天.wav");
  assert.equal(safeFilename("", "wav"), "Muse-BGM.wav");
  assert.throws(() => safeFilename("demo", "exe"));
});

test("external URL allowlist rejects unrelated sites, credentials, suffixes and redirects", () => {
  assert.equal(
    isAllowedExternal("https://elevenlabs.io/app/settings/api-keys"),
    true,
  );
  for (const url of [
    "https://evil.test",
    "https://elevenlabs.io.evil.test/app/settings/api-keys",
    "https://evil@elevenlabs.io/app/settings/api-keys",
    "file:///C:/Windows",
    "javascript:alert(1)",
    "https://elevenlabs.io/app/settings/api-keys?redirect=https://evil.test",
  ]) {
    assert.equal(isAllowedExternal(url), false);
  }
});

test("key storage saves encrypted data, supports replacement and deletion, and never stores plaintext", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-key-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Deterministic fake encryption tests storage plumbing without using Windows credentials.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5)),
    decryptString: (value) =>
      Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString(),
  };
  const store = createKeyStore(dir, safeStorage);
  assert.equal(await store.hasKey(), false);
  await assert.rejects(store.getKey(), /填写/);
  await store.saveKey(KEY);
  assert.equal(await store.hasKey(), true);
  assert.equal(await store.getKey(), KEY);
  const raw = await fs.readFile(
    path.join(dir, "music-credentials.json"),
    "utf8",
  );
  assert.equal(raw.includes(KEY), false);
  await store.saveKey("test-updated-secret-key");
  assert.equal(await store.getKey(), "test-updated-secret-key");
  await store.deleteKey();
  assert.equal(await store.hasKey(), false);
});

test("key storage fails closed when system encryption is unavailable", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-key-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createKeyStore(dir, { isEncryptionAvailable: () => false });
  await assert.rejects(store.saveKey(KEY), /密钥未保存/);
  assert.deepEqual(await fs.readdir(dir), []);
});
