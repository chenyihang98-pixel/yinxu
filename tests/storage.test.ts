// Pure validation, import and export. IndexedDB behaviour lives in storage-idb.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurn } from "../src/agent/types";
import {
  LEGACY_INSTRUMENTS,
  LEGACY_KEYS,
  LEGACY_MOODS,
} from "../src/audio/engine-v1";
import { INSTRUMENT_IDS, KEYS, STYLE_IDS } from "../src/music/catalog";
import {
  NEWER_VERSION_REASON,
  SCHEMA_VERSION,
  deleteProject,
  describeStorageError,
  exportProject,
  importProject,
  listProjects,
  normalizeProject,
  readRawRecord,
  requestPersistence,
  saveProject,
  storageInfo,
} from "../src/storage";
import type { Project } from "../src/types";

type Loose = Record<string, unknown>;

/** A work exactly as v0.2 stored and exported it: twelve config keys, no engine. */
function legacyRecord(): Loose {
  return {
    id: "original-id",
    title: "青春晴空",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    provider: "local",
    favorite: true,
    revision: 2,
    tags: ["青春", "欢快"],
    config: {
      prompt: "青春欢快的校园 BGM",
      mood: "bright",
      bpm: 112,
      duration: 30,
      key: "C major",
      instrument: "piano",
      energy: 0.7,
      complexity: 0.4,
      reverb: 0.25,
      seed: 123456,
      loop: true,
      volumes: { melody: 0.8, chords: 0.6, bass: 0.65, drums: 0.5 },
    },
  };
}

function turn(index: number, extra: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: `turn-${index}`,
    role: index % 2 ? "agent" : "user",
    text: `第 ${index} 句`,
    at: new Date(Date.UTC(2026, 9, 3, 0, 0, index)).toISOString(),
    ...extra,
  };
}

/** A current (engine 2) work using everything v0.3 added. */
function modernProject(): Project {
  return {
    id: "modern-id",
    title: "江南烟雨",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    provider: "local",
    favorite: false,
    revision: 3,
    tags: ["国风", "古筝"],
    parentId: "parent-id",
    audioDuration: 48,
    chat: [
      turn(0),
      turn(1, {
        reasoning: ["风格：国风", "主奏：古筝"],
        brain: "llm",
        revision: 3,
      }),
      turn(2, { role: "agent", error: true, brain: "rules" }),
    ],
    cloud: { prompt: "Chinese guofeng, guzheng, instrumental", model: "music-v1" },
    config: {
      prompt: "江南烟雨，古筝与笛子",
      mood: "guofeng",
      bpm: 76,
      duration: 48,
      key: "F# minor",
      instrument: "guzheng",
      energy: 0.45,
      complexity: 0.6,
      reverb: 0.5,
      seed: 4000000000,
      loop: false,
      volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
      engine: 2,
      arrangement: {
        progression: ["i", "bVII", "bVI", "V7"],
        form: [
          { type: "intro", bars: 4, energy: 0.3 },
          { type: "verse", bars: 8, energy: 0.5 },
          { type: "outro", bars: 4, energy: 0.2 },
        ],
        drums: "light",
        bass: "pedal",
        swing: 0.1,
        layers: { pad: true, arp: false },
        melody: { density: 0.4, register: "high", motion: "stepwise" },
      },
    },
  };
}

const asJson = (value: Loose, schemaVersion: unknown = 1) =>
  JSON.stringify({ schemaVersion, ...value });

function withConfig(patch: Loose, base: Loose = legacyRecord()): Loose {
  return { ...base, config: { ...(base.config as Loose), ...patch } };
}

/* ---------------- export / import ---------------- */

test("v2 round-trip keeps recipe, arrangement, chat, cloud info and parent", () => {
  const original = modernProject();
  const json = exportProject(original);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal("audioBlob" in parsed, false);
  assert.equal(parsed.config.engine, 2);

  const imported = importProject(json);
  assert.deepEqual(imported.config, original.config);
  assert.deepEqual(imported.chat, original.chat);
  assert.deepEqual(imported.cloud, original.cloud);
  assert.equal(imported.parentId, "parent-id");
  assert.equal(imported.audioDuration, 48);
  assert.deepEqual(imported.tags, original.tags);
  assert.equal(imported.revision, 3);
  assert.equal(imported.favorite, false);

  // A new work: importing can never overwrite the one it came from.
  assert.notEqual(imported.id, original.id);
  assert.match(imported.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(importProject(json).id, imported.id);
  assert.notEqual(imported.createdAt, original.createdAt);
  assert.equal(imported.createdAt, imported.updatedAt);
  assert.equal(original.id, "modern-id");

  // Exporting the import gives the same file apart from identity and dates.
  const again = JSON.parse(exportProject(imported));
  for (const field of ["id", "createdAt", "updatedAt"]) {
    delete again[field];
    delete parsed[field];
  }
  assert.deepEqual(again, parsed);
});

test("a v0.2 file (schemaVersion 1) imports as an engine-1 work with its recipe intact", () => {
  const file = legacyRecord();
  const imported = importProject(asJson(file, 1));
  assert.equal(imported.config.engine, 1);
  assert.deepEqual(imported.config, { ...(file.config as Loose), engine: 1 });
  assert.equal(imported.favorite, true);
  assert.equal(imported.revision, 2);
  assert.deepEqual(imported.tags, ["青春", "欢快"]);
  assert.equal("arrangement" in imported.config, false);
  assert.equal("chat" in imported, false);
  assert.equal("parentId" in imported, false);
  // and it is written back out in the current format
  assert.equal(JSON.parse(exportProject(imported)).schemaVersion, 2);
});

test("a UTF-8 byte order mark in front of the JSON is tolerated", () => {
  assert.equal(importProject(`\ufeff${asJson(legacyRecord())}`).title, "青春晴空");
});

test("cloud works export without audio and cannot be imported on their own", () => {
  for (const provider of ["elevenlabs", "tencent", "volcengine", "aliyun"] as const) {
    const project: Project = {
      ...modernProject(),
      provider,
      audioBlob: new Blob(["real-audio"], { type: "audio/mpeg" }),
    };
    const json = exportProject(project);
    const parsed = JSON.parse(json);
    assert.equal("audioBlob" in parsed, false);
    assert.equal(json.includes("real-audio"), false);
    assert.deepEqual(parsed.cloud, project.cloud);
    assert.throws(() => importProject(json), /不包含音频/, provider);
  }
  // exporting does not need the audio to be present
  const { audioBlob: _dropped, ...withoutAudio } = {
    ...modernProject(),
    provider: "tencent" as const,
    audioBlob: undefined,
  };
  assert.equal(JSON.parse(exportProject(withoutAudio)).provider, "tencent");
  // but a strict check (library, save) does
  assert.throws(() => normalizeProject(withoutAudio), /缺少音频/);
});

test("import rejects malformed JSON and unsupported schema versions", () => {
  assert.throws(() => importProject("{"), /有效的 Muse/);
  assert.throws(() => importProject(""), /有效的 Muse/);
  assert.throws(() => importProject("null"), /必须是对象/);
  assert.throws(() => importProject("[]"), /必须是对象/);
  assert.throws(() => importProject('"text"'), /必须是对象/);
  assert.throws(() => importProject(42 as unknown as string), /有效的 Muse/);
  assert.throws(() => importProject(asJson(legacyRecord(), 3)), /更新版本/);
  for (const version of [0, 1.5, -1, "2", null, true])
    assert.throws(
      () => importProject(asJson(legacyRecord(), version)),
      /不支持此工程文件版本/,
      String(version),
    );
  // a stored record or hand-written object without a version is not a project file
  assert.throws(
    () => importProject(JSON.stringify(legacyRecord())),
    /不支持此工程文件版本/,
  );
});

test("size cap measures UTF-8 bytes, including multi-byte text", () => {
  assert.throws(() => importProject(" ".repeat(1024 * 1024 + 1)), /文件过大/);
  // 400 000 Chinese characters are 400 000 UTF-16 units but 1.2 MB of UTF-8
  assert.throws(
    () => importProject(JSON.stringify({ padding: "青".repeat(400000) })),
    /文件过大/,
  );
  // exactly at the limit is still read (and then rejected for its content)
  assert.throws(() => importProject(" ".repeat(1024 * 1024)), /有效的 Muse/);
});

test("the largest project the validator allows still fits an importable file", () => {
  const project = modernProject();
  const wide = "\ud83c\udfb5"; // 4 UTF-8 bytes per 2 UTF-16 units
  project.config.prompt = "青".repeat(2000);
  project.cloud = { prompt: "青".repeat(2000), model: "m".repeat(128) };
  project.tags = Array.from({ length: 12 }, (_, i) => `${i}`.padStart(2, "0") + "青".repeat(30));
  project.chat = Array.from({ length: 40 }, (_, i) =>
    turn(i, {
      text: wide.repeat(750),
      reasoning: Array.from({ length: 8 }, () => "青".repeat(160)),
      brain: "llm",
      revision: i + 1,
    }),
  );
  const json = exportProject(project);
  assert.ok(new TextEncoder().encode(json).byteLength < 1024 * 1024);
  const imported = importProject(json);
  assert.equal(imported.chat?.length, 40);
  assert.equal(imported.chat?.[39].text.length, 1500);
  assert.equal(imported.config.prompt.length, 2000);
});

/* ---------------- engines and enumerations ---------------- */

test("records without config.engine are v0.2 works and stay on engine 1", () => {
  assert.equal(normalizeProject(legacyRecord()).config.engine, 1);
  assert.equal(normalizeProject(withConfig({ engine: 1 })).config.engine, 1);
  assert.equal(normalizeProject(modernProject()).config.engine, 2);
  for (const engine of ["2", null, 0, 1.5, -1, true])
    assert.throws(
      () => normalizeProject(withConfig({ engine })),
      /引擎版本无效/,
      String(engine),
    );
});

test("engine 1 accepts every v0.2 style, instrument and key", () => {
  for (const mood of LEGACY_MOODS)
    assert.equal(normalizeProject(withConfig({ mood })).config.mood, mood);
  for (const instrument of LEGACY_INSTRUMENTS)
    assert.equal(
      normalizeProject(withConfig({ instrument })).config.instrument,
      instrument,
    );
  for (const key of LEGACY_KEYS)
    assert.equal(normalizeProject(withConfig({ key })).config.key, key);
});

test("engine 1 rejects values only engine 2 can play", () => {
  for (const patch of [
    { mood: "epic" },
    { instrument: "flute" },
    { key: "F# minor" },
  ]) {
    assert.throws(
      () => normalizeProject(withConfig(patch)),
      /引擎版本不匹配/,
      JSON.stringify(patch),
    );
    assert.throws(
      () => importProject(asJson(withConfig(patch))),
      /工程文件格式不正确/,
    );
    // the very same value is fine once the record says engine 2
    assert.doesNotThrow(() => normalizeProject(withConfig({ ...patch, engine: 2 })));
  }
});

test("engine 2 accepts the whole catalog", () => {
  const base = modernProject() as unknown as Loose;
  for (const mood of STYLE_IDS)
    assert.equal(normalizeProject(withConfig({ mood }, base)).config.mood, mood);
  for (const instrument of INSTRUMENT_IDS)
    assert.equal(
      normalizeProject(withConfig({ instrument }, base)).config.instrument,
      instrument,
    );
  for (const key of KEYS)
    assert.equal(normalizeProject(withConfig({ key }, base)).config.key, key);
});

test("tempo range follows the engine: 60-160 for engine 1, 50-200 for engine 2", () => {
  assert.equal(normalizeProject(withConfig({ bpm: 999 })).config.bpm, 160);
  assert.equal(normalizeProject(withConfig({ bpm: 10 })).config.bpm, 60);
  assert.equal(normalizeProject(withConfig({ bpm: 999, engine: 2 })).config.bpm, 200);
  assert.equal(normalizeProject(withConfig({ bpm: 10, engine: 2 })).config.bpm, 50);
  assert.equal(normalizeProject(withConfig({ bpm: 180, engine: 2 })).config.bpm, 180);
  assert.equal(normalizeProject(withConfig({ bpm: 111.6, engine: 2 })).config.bpm, 112);
});

test("values this build has never heard of are reported as a newer version, not coerced", () => {
  const cases: Loose[] = [
    withConfig({ mood: "lofi" }),
    withConfig({ mood: "vaporwave", engine: 2 }),
    withConfig({ instrument: "theremin", engine: 2 }),
    withConfig({ key: "C lydian", engine: 2 }),
    withConfig({ key: "X major" }),
    withConfig({ engine: 3 }),
    { ...legacyRecord(), provider: "suno" },
    { ...legacyRecord(), chat: [{ ...turn(0), role: "critic" }] },
    { ...legacyRecord(), chat: [{ ...turn(1), brain: "hybrid" }] },
  ];
  for (const value of cases) {
    assert.throws(
      () => normalizeProject(value),
      (error: Error) => error.message === NEWER_VERSION_REASON,
      JSON.stringify(value).slice(0, 120),
    );
    assert.throws(() => importProject(asJson(value)), /更新版本的音序/);
  }
  assert.equal(NEWER_VERSION_REASON, "由更新版本的音序创建，请升级后打开");
  // a newer build is recognised even when other details are also unfamiliar
  assert.throws(
    () => normalizeProject({ ...withConfig({ mood: "lofi", bpm: "fast" }), title: 7 }),
    (error: Error) => error.message === NEWER_VERSION_REASON,
  );
});

test("arrangement hints pass through cleanArrangement and only exist for engine 2", () => {
  const messy = withConfig(
    {
      engine: 2,
      arrangement: {
        progression: ["I", "not-a-chord", "V", 7, "vi"],
        form: [
          { type: "verse", bars: 400, energy: 9 },
          { type: "nonsense", bars: 4, energy: 0.5 },
        ],
        drums: "auto",
        bass: "walking",
        swing: 5,
        layers: { pad: "yes", perc: true },
        melody: { density: 2, register: "sky", motion: "leaps" },
        secret: "dropped",
      },
    },
  );
  assert.deepEqual(normalizeProject(messy).config.arrangement, {
    progression: ["I", "V", "vi"],
    form: [{ type: "verse", bars: 32, energy: 1 }],
    bass: "walking",
    swing: 0.66,
    layers: { perc: true },
    melody: { density: 1, motion: "leaps" },
  });
  // nothing usable left: the field disappears instead of staying as {}
  const empty = normalizeProject(withConfig({ engine: 2, arrangement: { drums: "auto" } }));
  assert.equal("arrangement" in empty.config, false);
  // the frozen engine has no arrangement hints
  const legacy = normalizeProject(withConfig({ arrangement: { bass: "walking" } }));
  assert.equal("arrangement" in legacy.config, false);
  // validating twice changes nothing (a saved work re-opens identically)
  const once = normalizeProject(modernProject());
  assert.deepEqual(normalizeProject(once), once);
});

/* ---------------- numbers, text and hostile input ---------------- */

test("finite numbers are clamped into the supported range", () => {
  const record = withConfig({
    bpm: 999,
    duration: -1,
    energy: 2,
    complexity: -3,
    reverb: 4,
    seed: 2 ** 40,
    volumes: { melody: 10, chords: 0.5, bass: 0.25, drums: -4 },
  });
  const { config } = importProject(asJson(record));
  assert.equal(config.bpm, 160);
  assert.equal(config.duration, 15);
  assert.equal(config.energy, 1);
  assert.equal(config.complexity, 0);
  assert.equal(config.reverb, 1);
  assert.equal(config.seed, 0xffffffff);
  assert.deepEqual(config.volumes, { melody: 1, chords: 0.5, bass: 0.25, drums: 0 });
  assert.equal(normalizeProject(withConfig({ duration: 500, engine: 2 })).config.duration, 120);
  assert.equal(normalizeProject({ ...legacyRecord(), revision: 0 }).revision, 1);
  assert.equal(normalizeProject({ ...legacyRecord(), revision: 2.6 }).revision, 3);
  assert.equal(normalizeProject({ ...legacyRecord(), audioDuration: 99999 }).audioDuration, 3600);
  assert.equal(normalizeProject({ ...legacyRecord(), audioDuration: 0 }).audioDuration, 0.01);
});

test("wrong types and absent values are rejected, never guessed", () => {
  const bad: [string, unknown][] = [
    ["mood", 3],
    ["instrument", null],
    ["key", ["C major"]],
    ["bpm", "112"],
    ["duration", null],
    ["energy", null],
    ["complexity", "0.5"],
    ["reverb", undefined],
    ["seed", "42"],
    ["loop", "true"],
    ["volumes", null],
    ["volumes", [0.8, 0.6, 0.6, 0.5]],
    ["prompt", 12],
  ];
  for (const [field, value] of bad)
    assert.throws(
      () => importProject(asJson(withConfig({ [field]: value }))),
      /工程文件格式不正确/,
      field,
    );
  const missing = legacyRecord();
  delete ((missing.config as Loose).volumes as Loose).bass;
  assert.throws(() => importProject(asJson(missing)), /低音音量必须是有效数字/);

  for (const [field, value] of [
    ["id", ""],
    ["id", 12],
    ["id", " padded "],
    ["id", "x".repeat(121)],
    ["id", "line\nbreak"],
    ["title", ""],
    ["title", "   "],
    ["title", null],
    ["createdAt", "yesterday"],
    ["updatedAt", 1759363200000],
    ["updatedAt", "2".repeat(80)],
    ["favorite", "yes"],
    ["revision", "2"],
    ["tags", "青春"],
    ["tags", ["ok", 3]],
    ["config", null],
    ["config", []],
    ["provider", null],
    ["audioDuration", "30"],
    ["audioDuration", null],
    ["parentId", 5],
    ["parentId", ""],
    ["parentId", "p".repeat(121)],
    ["chat", "hello"],
    ["chat", [null]],
    ["cloud", "prompt"],
    ["cloud", { prompt: 5 }],
    ["cloud", { prompt: "ok", model: 5 }],
    ["audioBlob", {}],
    ["audioBlob", "data:audio/wav;base64,AAAA"],
  ] as [string, unknown][])
    assert.throws(
      () => normalizeProject({ ...legacyRecord(), [field]: value }),
      /工程文件格式不正确/,
      `${field}=${JSON.stringify(value)}`,
    );
  for (const value of [null, undefined, 5, "project", [], () => 1])
    assert.throws(() => normalizeProject(value), /工程必须是对象/);
});

test("non-finite numbers fail before export can turn them into null", () => {
  const project = normalizeProject(legacyRecord());
  project.config.bpm = Infinity;
  assert.throws(() => exportProject(project), /速度必须是有效数字/);
  project.config.bpm = 112;
  project.config.volumes.bass = NaN;
  assert.throws(() => exportProject(project), /低音音量必须是有效数字/);
  project.config.volumes.bass = 0.5;
  project.config.seed = -Infinity;
  assert.throws(() => exportProject(project), /随机种子必须是有效数字/);
});

test("unknown properties are dropped and cannot alter prototypes", () => {
  const data = JSON.parse(exportProject(modernProject()));
  Object.defineProperty(data, "__proto__", {
    value: { polluted: true },
    enumerable: true,
  });
  data.extra = "discard";
  data.config.extra = "discard";
  data.config.volumes.vocals = 1;
  data.cloud.apiKey = "sk-should-never-be-kept";
  data.chat[0].html = "<script>";
  data.constructor = { prototype: { polluted: true } };
  const imported = importProject(JSON.stringify(data));
  assert.equal(Object.getPrototypeOf(imported), Object.prototype);
  assert.equal("polluted" in imported, false);
  assert.equal("polluted" in {}, false);
  assert.equal("extra" in imported, false);
  assert.equal("extra" in imported.config, false);
  assert.deepEqual(Object.keys(imported.config.volumes), ["melody", "chords", "bass", "drums"]);
  assert.deepEqual(Object.keys(imported.cloud ?? {}), ["prompt", "model"]);
  assert.equal("html" in (imported.chat?.[0] ?? {}), false);
  assert.equal(JSON.stringify(imported).includes("sk-should-never-be-kept"), false);
  assert.deepEqual(Object.keys(imported), [
    "id",
    "title",
    "createdAt",
    "updatedAt",
    "config",
    "provider",
    "favorite",
    "revision",
    "tags",
    "audioDuration",
    "parentId",
    "chat",
    "cloud",
  ]);
});

test("title and tags are cleaned and bounded", () => {
  const record = legacyRecord();
  record.title = `  ${"音".repeat(100)}\u0000  `;
  record.tags = [
    "青春",
    "青春",
    "  ",
    " 空格 ",
    "长".repeat(50),
    ...Array.from({ length: 15 }, (_, index) => String(index)),
  ];
  const project = normalizeProject(record);
  assert.equal(project.title.length, 80);
  assert.equal(project.title.includes("\u0000"), false);
  assert.equal(project.tags.length, 12);
  assert.equal(project.tags.filter((tag) => tag === "青春").length, 1);
  assert.equal(project.tags[1], "空格");
  assert.equal(project.tags[2].length, 32);
  // clipping never leaves half of an emoji behind
  const emoji = normalizeProject({ ...legacyRecord(), title: "a" + "\ud83c\udfb5".repeat(60) });
  assert.equal(emoji.title.length, 79);
  assert.equal(/[\ud800-\udbff]$/.test(emoji.title), false);
});

test("prompts are kept as written apart from control characters and overflow", () => {
  const project = normalizeProject(
    withConfig({ prompt: `  第一行\n第二行\u0007 ${"长".repeat(3000)}` }),
  );
  assert.equal(project.config.prompt.startsWith("  第一行\n第二行 长"), true);
  assert.equal(project.config.prompt.length, 2000);
  assert.equal(normalizeProject(withConfig({ prompt: "" })).config.prompt, "");
});

test("dates are normalised to ISO strings", () => {
  const project = normalizeProject({
    ...legacyRecord(),
    createdAt: "2026-10-01T09:00:00+09:00",
    chat: [{ ...turn(0), at: "2026-10-03" }],
  });
  assert.equal(project.createdAt, "2026-10-01T00:00:00.000Z");
  assert.equal(project.chat?.[0].at, "2026-10-03T00:00:00.000Z");
});

test("chat is limited to the 40 most recent turns with bounded text and reasoning", () => {
  const chat = Array.from({ length: 45 }, (_, index) => turn(index));
  chat[44] = turn(44, {
    text: "长".repeat(4000),
    reasoning: [...Array.from({ length: 12 }, (_, i) => `${i}`.repeat(400)), "", "  "],
    brain: "rules",
    revision: 7.2,
    error: false,
  });
  const project = normalizeProject({ ...legacyRecord(), chat });
  assert.equal(project.chat?.length, 40);
  assert.equal(project.chat?.[0].id, "turn-5");
  const last = project.chat?.[39];
  assert.equal(last?.id, "turn-44");
  assert.equal(last?.text.length, 1500);
  assert.equal(last?.reasoning?.length, 8);
  assert.ok(last?.reasoning?.every((line) => line.length === 160));
  assert.equal(last?.brain, "rules");
  assert.equal(last?.revision, 7);
  assert.equal(last?.error, false);
  // optional fields stay absent rather than becoming undefined-valued keys
  assert.deepEqual(Object.keys(project.chat?.[0] ?? {}), ["id", "role", "text", "at"]);
  // an empty thread is simply not stored
  assert.equal("chat" in normalizeProject({ ...legacyRecord(), chat: [] }), false);

  for (const [field, value] of [
    ["id", ""],
    ["text", 5],
    ["at", "soon"],
    ["role", 1],
    ["reasoning", "because"],
    ["reasoning", [1]],
    ["revision", "3"],
    ["error", "no"],
    ["brain", 2],
  ] as [string, unknown][])
    assert.throws(
      () => normalizeProject({ ...legacyRecord(), chat: [{ ...turn(1), [field]: value }] }),
      /工程文件格式不正确/,
      `${field}=${JSON.stringify(value)}`,
    );
});

test("cloud info is bounded and an empty model is omitted", () => {
  const project = normalizeProject({
    ...legacyRecord(),
    cloud: { prompt: "p".repeat(5000), model: "m".repeat(500) },
  });
  assert.equal(project.cloud?.prompt.length, 2000);
  assert.equal(project.cloud?.model?.length, 128);
  assert.deepEqual(
    normalizeProject({ ...legacyRecord(), cloud: { prompt: "x", model: "  " } }).cloud,
    { prompt: "x" },
  );
});

/* ---------------- without IndexedDB ---------------- */

test("cloud saves reject absent or empty audio before claiming success", async () => {
  const cloud = { ...(modernProject() as unknown as Loose), provider: "elevenlabs" };
  await assert.rejects(saveProject(cloud as unknown as Project), /缺少音频/);
  await assert.rejects(
    saveProject({ ...cloud, audioBlob: new Blob([]) } as unknown as Project),
    /音频数据为空/,
  );
});

test("an environment without IndexedDB clearly rejects every library operation", async () => {
  assert.equal(typeof indexedDB, "undefined");
  await assert.rejects(listProjects(), /不支持本地作品库，请使用桌面版或较新的浏览器。$/);
  await assert.rejects(saveProject(modernProject()), /不支持本地作品库.*本次作品尚未保存/);
  await assert.rejects(deleteProject("original-id"), /不支持本地作品库/);
  await assert.rejects(readRawRecord("original-id"), /不支持本地作品库/);
  await assert.rejects(deleteProject(""), /工程编号无效/);
});

test("a storage API that throws on access is reported, not crashed on", async () => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    get() {
      throw new DOMException("denied", "SecurityError");
    },
  });
  try {
    await assert.rejects(listProjects(), /不允许使用本地作品库/);
  } finally {
    delete (globalThis as Loose).indexedDB;
  }
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        throw new DOMException("insecure", "SecurityError");
      },
    },
  });
  try {
    await assert.rejects(saveProject(modernProject()), /不允许使用本地作品库.*本次作品尚未保存/);
    // the failed open is not cached: the next call tries again
    await assert.rejects(listProjects(), /不允许使用本地作品库/);
  } finally {
    delete (globalThis as Loose).indexedDB;
  }
});

test("IndexedDB failures map to messages that say what happened", () => {
  const named = (name: string) => new DOMException("x", name);
  assert.match(describeStorageError(named("QuotaExceededError"), "保存").message, /存储空间不足，作品未保存/);
  assert.match(describeStorageError(named("QuotaExceededError"), "读取").message, /存储空间不足，无法读取/);
  assert.match(describeStorageError(named("VersionError"), "读取", true).message, /更新版本的音序.*新版 App/);
  assert.match(describeStorageError(named("SecurityError"), "读取", true).message, /隐私模式/);
  // while opening, InvalidStateError is how some private modes refuse storage
  assert.match(describeStorageError(named("InvalidStateError"), "读取", true).message, /隐私模式/);
  // afterwards it is a closed connection, not "storage is forbidden"
  const closed = describeStorageError(named("InvalidStateError"), "保存").message;
  assert.match(closed, /连接已断开/);
  assert.doesNotMatch(closed, /隐私|禁止|不允许/);
  assert.match(closed, /尚未保存/);
  assert.match(describeStorageError(named("AbortError"), "删除").message, /删除作品库的操作被中断/);
  assert.match(describeStorageError(named("UnknownError"), "读取").message, /内部错误/);
  assert.match(describeStorageError(named("NotFoundError"), "读取").message, /结构不完整/);
  assert.match(describeStorageError(named("DataCloneError"), "保存").message, /无法写入作品库.*尚未保存/);
  assert.match(describeStorageError(null, "保存").message, /无法保存作品库，请重试。本次作品尚未保存。/);
  assert.match(describeStorageError(new Error("boom"), "读取").message, /^无法读取作品库，请重试。$/);
  // internal details never leak into the message
  assert.doesNotMatch(describeStorageError(new Error("C:\\secret\\path"), "读取").message, /secret/);
  // only a failed save says the work is unsaved
  for (const name of ["VersionError", "SecurityError", "InvalidStateError", "AbortError", "UnknownError", "NotFoundError", ""]) {
    assert.match(describeStorageError(named(name), "保存").message, /本次作品尚未保存/, name);
    assert.doesNotMatch(describeStorageError(named(name), "读取").message, /尚未保存/, name);
    assert.doesNotMatch(describeStorageError(named(name), "删除").message, /尚未保存/, name);
  }
});

test("storage usage and persistence degrade gracefully and report real values", async () => {
  assert.equal(await storageInfo(), null);
  assert.equal(await requestPersistence(), false);

  let persisted = false;
  let asked = 0;
  const fake = {
    estimate: async () => ({ usage: 1234, quota: 5_000_000 }),
    persisted: async () => persisted,
    persist: async () => {
      asked++;
      persisted = true;
      return true;
    },
  };
  Object.defineProperty(globalThis.navigator, "storage", {
    configurable: true,
    value: fake,
  });
  try {
    assert.deepEqual(await storageInfo(), { usage: 1234, quota: 5_000_000, persisted: false });
    assert.equal(await requestPersistence(), true);
    assert.equal(asked, 1);
    assert.deepEqual(await storageInfo(), { usage: 1234, quota: 5_000_000, persisted: true });
    // already persistent: no second prompt
    assert.equal(await requestPersistence(), true);
    assert.equal(asked, 1);

    fake.estimate = async () => ({ usage: NaN, quota: undefined }) as never;
    assert.deepEqual(await storageInfo(), { usage: 0, quota: 0, persisted: true });
    fake.estimate = async () => {
      throw new Error("denied");
    };
    assert.equal(await storageInfo(), null);
    persisted = false;
    fake.persist = async () => {
      throw new Error("denied");
    };
    assert.equal(await requestPersistence(), false);
  } finally {
    delete (globalThis.navigator as unknown as Loose).storage;
  }
});
