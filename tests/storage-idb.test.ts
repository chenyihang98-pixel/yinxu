// The work library against a real IndexedDB implementation (fake-indexeddb).
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  NEWER_VERSION_REASON,
  deleteProject,
  listProjects,
  readRawRecord,
  saveProject,
} from "../src/storage";
import type { Project } from "../src/types";

type Loose = Record<string, unknown>;

const DATABASE = "muse-bgm";
const STORE = "projects";

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** A second connection, the way another window or an older build would open the library. */
async function openRaw(version = 1): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE, version);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE))
      request.result.createObjectStore(STORE, { keyPath: "id" });
  };
  return done(request);
}

async function putRaw(...records: Loose[]): Promise<void> {
  const database = await openRaw();
  const tx = database.transaction(STORE, "readwrite");
  for (const record of records) tx.objectStore(STORE).put(record);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  database.close();
}

async function getRaw(id: IDBValidKey): Promise<Loose | undefined> {
  const database = await openRaw();
  const value = await done(database.transaction(STORE).objectStore(STORE).get(id));
  database.close();
  return value as Loose | undefined;
}

/** Start every test from an empty library (also closes the module's cached connection). */
async function reset(): Promise<void> {
  await done(indexedDB.deleteDatabase(DATABASE));
}

function project(id: string, updatedAt: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    title: `作品 ${id}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    provider: "local",
    favorite: false,
    revision: 1,
    tags: ["测试"],
    config: {
      prompt: "轻快的午后",
      mood: "jazz",
      bpm: 120,
      duration: 30,
      key: "Bb major",
      instrument: "epiano",
      energy: 0.5,
      complexity: 0.5,
      reverb: 0.3,
      seed: 7,
      loop: true,
      volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
      engine: 2,
    },
    ...extra,
  };
}

/** Exactly what the v0.2 app wrote: no engine, no v0.3 fields. */
function legacyRecord(id: string, updatedAt: string): Loose {
  return {
    id,
    title: "旧版作品",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    provider: "local",
    favorite: true,
    revision: 4,
    tags: ["青春"],
    audioDuration: 30,
    config: {
      prompt: "青春欢快",
      mood: "bright",
      bpm: 112,
      duration: 30,
      key: "C major",
      instrument: "piano",
      energy: 0.62,
      complexity: 0.5,
      reverb: 0.25,
      seed: 42017,
      loop: true,
      volumes: { melody: 0.8, chords: 0.64, bass: 0.68, drums: 0.56 },
    },
  };
}

test("saved works are listed newest first and saving again replaces the record", async () => {
  await reset();
  assert.deepEqual(await listProjects(), { projects: [], damaged: [] });
  await saveProject(project("b", "2026-10-02T00:00:00.000Z"));
  await saveProject(project("c", "2026-10-03T00:00:00.000Z"));
  await saveProject(project("a", "2026-10-01T00:00:00.000Z"));
  let { projects, damaged } = await listProjects();
  assert.deepEqual(projects.map((item) => item.id), ["c", "b", "a"]);
  assert.deepEqual(damaged, []);

  // updating a work moves it to the top without duplicating it
  await saveProject(project("a", "2026-10-09T00:00:00.000Z", { title: "改名后", favorite: true }));
  ({ projects, damaged } = await listProjects());
  assert.deepEqual(projects.map((item) => item.id), ["a", "c", "b"]);
  assert.equal(projects[0].title, "改名后");
  assert.equal(projects[0].favorite, true);

  // equal timestamps fall back to a stable order
  await saveProject(project("z", "2026-10-03T00:00:00.000Z"));
  await saveProject(project("y", "2026-10-03T00:00:00.000Z"));
  ({ projects } = await listProjects());
  assert.deepEqual(projects.map((item) => item.id), ["a", "c", "y", "z", "b"]);
});

test("a save is only reported once it is committed, and stores the validated copy", async () => {
  await reset();
  const dirty = {
    ...project("clean-me", "2026-10-02T00:00:00.000Z"),
    secret: "not part of a project",
    title: "  需要整理  ",
  } as Project;
  await saveProject(dirty);
  const stored = await getRaw("clean-me");
  assert.ok(stored, "visible to an independent connection right after the promise resolves");
  assert.equal(stored.title, "需要整理");
  assert.equal("secret" in stored, false);
  assert.equal((stored.config as Loose).engine, 2);

  // many saves at once all land
  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      saveProject(project(`bulk-${index}`, `2026-10-05T00:00:${String(index).padStart(2, "0")}.000Z`)),
    ),
  );
  assert.equal((await listProjects()).projects.length, 26);

  // an invalid work is refused before anything is written
  await assert.rejects(
    saveProject({ ...project("bad", "2026-10-02T00:00:00.000Z"), revision: NaN }),
    /版本必须是有效数字/,
  );
  assert.equal(await getRaw("bad"), undefined);
});

test("a v0.2 library opens unchanged: old records become engine-1 works", async () => {
  await reset();
  const old = legacyRecord("old-1", "2026-09-02T00:00:00.000Z");
  await putRaw(old);
  const { projects, damaged } = await listProjects();
  assert.deepEqual(damaged, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].config.engine, 1);
  assert.deepEqual(projects[0].config, { ...(old.config as Loose), engine: 1 });
  assert.equal(projects[0].audioDuration, 30);
  // reading never rewrites what is stored
  assert.deepEqual(await getRaw("old-1"), old);
  // and a later save (e.g. toggling favourite) keeps it an engine-1 work
  await saveProject({ ...projects[0], favorite: false });
  assert.equal(((await getRaw("old-1"))?.config as Loose).engine, 1);
});

test("one corrupt and one future-style record never hide the works that are fine", async () => {
  await reset();
  await saveProject(project("good", "2026-10-05T00:00:00.000Z"));
  const corrupt = legacyRecord("corrupt", "2026-10-06T00:00:00.000Z");
  delete (corrupt.config as Loose).reverb;
  const future = {
    ...project("future", "2026-10-07T00:00:00.000Z"),
    title: "来自未来",
    config: { ...project("x", "").config, mood: "lofi", engine: 2, stereoWidth: 0.4 },
  };
  const mismatched = legacyRecord("mismatched", "2026-10-07T00:00:00.000Z");
  (mismatched.config as Loose).mood = "epic";
  await putRaw(
    corrupt,
    future as unknown as Loose,
    mismatched,
    legacyRecord("old", "2026-09-02T00:00:00.000Z"),
    { id: "no-title", provider: "local" },
    { id: "cloud-without-audio", ...withoutId(project("c", "2026-10-01T00:00:00.000Z")), provider: "tencent" },
  );

  const { projects, damaged } = await listProjects();
  assert.deepEqual(projects.map((item) => item.id), ["good", "old"]);
  const byId = new Map(damaged.map((item) => [item.id, item]));
  assert.deepEqual([...byId.keys()].sort(), ["cloud-without-audio", "corrupt", "future", "mismatched", "no-title"]);
  assert.equal(byId.get("future")?.reason, NEWER_VERSION_REASON);
  assert.equal(byId.get("future")?.title, "来自未来");
  assert.match(byId.get("corrupt")?.reason ?? "", /工程文件格式不正确：空间感必须是有效数字/);
  assert.equal(byId.get("corrupt")?.title, "旧版作品");
  assert.match(byId.get("mismatched")?.reason ?? "", /引擎版本不匹配/);
  assert.equal(byId.get("no-title")?.title, "未命名作品");
  assert.match(byId.get("cloud-without-audio")?.reason ?? "", /缺少音频/);

  // listing must not "repair" or drop anything a newer build may still need
  assert.equal(((await getRaw("future"))?.config as Loose).stereoWidth, 0.4);

  // the user can keep a copy of a damaged record, then remove it
  const raw = await readRawRecord("future");
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.config.mood, "lofi");
  assert.equal(parsed.config.stereoWidth, 0.4);
  await deleteProject("future");
  await deleteProject("corrupt");
  const after = await listProjects();
  assert.deepEqual(after.projects.map((item) => item.id), ["good", "old"]);
  assert.deepEqual(after.damaged.map((item) => item.id).sort(), ["cloud-without-audio", "mismatched", "no-title"]);
});

function withoutId(value: Project): Loose {
  const { id: _id, ...rest } = value;
  return rest;
}

test("records whose key is not a usable id can still be exported and deleted", async () => {
  await reset();
  await saveProject(project("good", "2026-10-05T00:00:00.000Z"));
  const long = "k".repeat(300);
  await putRaw(
    { id: 12345, title: "数字编号" },
    { id: long, title: "超长编号" },
    { id: " padded ", ...withoutId(project("p", "2026-10-01T00:00:00.000Z")) },
    // a real key that looks like the placeholder ids must not be shadowed
    { id: "damaged:1", title: "碰巧同名" },
  );
  const { projects, damaged } = await listProjects();
  assert.deepEqual(projects.map((item) => item.id), ["good"]);
  assert.equal(damaged.length, 4);
  assert.equal(new Set(damaged.map((item) => item.id)).size, 4);
  const titled = (title: string) => {
    const found = damaged.find((item) => item.title === title);
    assert.ok(found, title);
    return found;
  };
  const numeric = titled("数字编号");
  const overlong = titled("超长编号");
  assert.notEqual(numeric.id, "12345");
  assert.ok(overlong.id.length <= 120);
  assert.equal(titled("碰巧同名").id, "damaged:1");
  assert.equal(titled("作品 p").id, " padded ");
  assert.match(titled("作品 p").reason, /工程编号无效/);

  assert.equal(JSON.parse((await readRawRecord(numeric.id)) ?? "{}").title, "数字编号");
  assert.equal(JSON.parse((await readRawRecord(overlong.id)) ?? "{}").id, long);
  assert.equal(JSON.parse((await readRawRecord("damaged:1")) ?? "{}").title, "碰巧同名");

  for (const item of damaged) await deleteProject(item.id);
  assert.equal(await getRaw(12345), undefined);
  assert.equal(await getRaw(long), undefined);
  const after = await listProjects();
  assert.deepEqual(after.damaged, []);
  assert.deepEqual(after.projects.map((item) => item.id), ["good"]);
});

test("delete removes exactly one work and is harmless for a missing id", async () => {
  await reset();
  await saveProject(project("keep", "2026-10-02T00:00:00.000Z"));
  await saveProject(project("drop", "2026-10-03T00:00:00.000Z"));
  await deleteProject("drop");
  await deleteProject("never-existed");
  assert.deepEqual((await listProjects()).projects.map((item) => item.id), ["keep"]);
  await assert.rejects(deleteProject(""), /工程编号无效/);
  await assert.rejects(deleteProject(undefined as unknown as string), /工程编号无效/);
  assert.deepEqual((await listProjects()).projects.map((item) => item.id), ["keep"]);
});

test("cloud works keep their audio Blob byte for byte", async () => {
  await reset();
  const bytes = Uint8Array.from({ length: 4096 }, (_, index) => (index * 31) % 256);
  const cloud = project("cloud", "2026-10-08T00:00:00.000Z", {
    provider: "volcengine",
    audioBlob: new Blob([bytes], { type: "audio/mpeg" }),
    audioDuration: 61.5,
    cloud: { prompt: "轻快的爵士，纯音乐", model: "v5.0" },
    parentId: "local-parent",
    chat: [
      { id: "t1", role: "user", text: "来一首爵士", at: "2026-10-08T00:00:00.000Z" },
      { id: "t2", role: "agent", text: "好的", at: "2026-10-08T00:00:05.000Z", brain: "rules", revision: 1 },
    ],
  });
  await saveProject(cloud);
  const { projects, damaged } = await listProjects();
  assert.deepEqual(damaged, []);
  const [restored] = projects;
  assert.ok(restored.audioBlob instanceof Blob);
  assert.equal(restored.audioBlob.type, "audio/mpeg");
  assert.equal(restored.audioBlob.size, 4096);
  assert.deepEqual(new Uint8Array(await restored.audioBlob.arrayBuffer()), bytes);
  assert.equal(restored.audioDuration, 61.5);
  assert.deepEqual(restored.cloud, cloud.cloud);
  assert.deepEqual(restored.chat, cloud.chat);
  assert.equal(restored.parentId, "local-parent");

  // metadata edits re-save the same Blob
  await saveProject({ ...restored, favorite: true });
  const again = (await listProjects()).projects[0];
  assert.equal(again.favorite, true);
  assert.deepEqual(new Uint8Array(await again.audioBlob!.arrayBuffer()), bytes);

  // the raw export is JSON without the binary
  const raw = await readRawRecord("cloud");
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal("audioBlob" in parsed, false);
  assert.equal(parsed.provider, "volcengine");
  assert.equal(parsed.cloud.model, "v5.0");
});

test("readRawRecord returns plain JSON for anything structured clone can hold", async () => {
  await reset();
  const cyclic: Loose = { name: "loop" };
  cyclic.self = cyclic;
  await putRaw({
    id: "odd",
    title: "奇怪的记录",
    when: new Date("2026-10-01T00:00:00.000Z"),
    big: 12345678901234567890n,
    notNumber: NaN,
    binary: new Uint8Array([1, 2, 3]),
    buffer: new ArrayBuffer(8),
    audioBlob: new Blob(["x"]),
    nested: { blob: new Blob(["y"]), list: [1, undefined, new Blob(["z"])] },
    map: new Map([["a", 1]]),
    set: new Set(["s"]),
    cyclic,
    ["__proto__"]: "own property",
  });
  const raw = await readRawRecord("odd");
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.title, "奇怪的记录");
  assert.equal(parsed.when, "2026-10-01T00:00:00.000Z");
  assert.equal(parsed.big, "12345678901234567890");
  assert.equal(parsed.notNumber, "NaN");
  for (const dropped of ["binary", "buffer", "audioBlob"])
    assert.equal(dropped in parsed, false, dropped);
  assert.deepEqual(parsed.nested, { list: [1, null, null] });
  assert.deepEqual(parsed.map, [["a", 1]]);
  assert.deepEqual(parsed.set, ["s"]);
  assert.deepEqual(parsed.cyclic, { name: "loop", self: "[循环引用]" });
  assert.equal(await readRawRecord("missing"), null);
  await assert.rejects(readRawRecord(""), /工程编号无效/);
});

test("an aborted transaction surfaces an error and leaves the library untouched", async () => {
  await reset();
  await saveProject(project("before", "2026-10-02T00:00:00.000Z"));
  const store = IDBObjectStore.prototype as unknown as Loose;
  const originalPut = store.put as (...args: unknown[]) => IDBRequest;
  const originalDelete = store.delete as (...args: unknown[]) => IDBRequest;

  // the request itself succeeds, then the transaction aborts (as on a failed commit)
  store.put = function (this: IDBObjectStore, ...args: unknown[]) {
    const request = originalPut.apply(this, args);
    this.transaction.abort();
    return request;
  };
  try {
    await assert.rejects(
      saveProject(project("aborted", "2026-10-03T00:00:00.000Z")),
      (error: Error) => /作品库/.test(error.message) && /本次作品尚未保存/.test(error.message),
    );
  } finally {
    store.put = originalPut;
  }
  assert.equal(await getRaw("aborted"), undefined);

  // quota exhaustion reported by the browser while writing
  store.put = function () {
    throw new DOMException("full", "QuotaExceededError");
  };
  try {
    await assert.rejects(
      saveProject(project("too-big", "2026-10-03T00:00:00.000Z")),
      /本地存储空间不足，作品未保存/,
    );
  } finally {
    store.put = originalPut;
  }
  assert.equal(await getRaw("too-big"), undefined);

  store.delete = function (this: IDBObjectStore, ...args: unknown[]) {
    const request = originalDelete.apply(this, args);
    this.transaction.abort();
    return request;
  };
  try {
    await assert.rejects(deleteProject("before"), /删除作品库的操作被中断|无法删除作品库/);
  } finally {
    store.delete = originalDelete;
  }

  // nothing was lost and the library keeps working afterwards
  assert.deepEqual((await listProjects()).projects.map((item) => item.id), ["before"]);
  await saveProject(project("after", "2026-10-04T00:00:00.000Z"));
  assert.deepEqual((await listProjects()).projects.map((item) => item.id), ["after", "before"]);
});

test("a connection closed behind our back is reopened once instead of failing", async () => {
  await reset();
  await saveProject(project("one", "2026-10-02T00:00:00.000Z"));
  const database = IDBDatabase.prototype as unknown as Loose;
  const original = database.transaction as (...args: unknown[]) => IDBTransaction;
  let failures = 0;
  database.transaction = function (this: IDBDatabase, ...args: unknown[]) {
    if (failures++ === 0) throw new DOMException("closing", "InvalidStateError");
    return original.apply(this, args);
  };
  try {
    await saveProject(project("two", "2026-10-03T00:00:00.000Z"));
    assert.equal(failures, 2, "one failed attempt, one successful retry");
    // a connection that stays unusable is reported as such, not as "storage forbidden"
    database.transaction = function () {
      throw new DOMException("closing", "InvalidStateError");
    };
    await assert.rejects(listProjects(), /连接已断开/);
  } finally {
    database.transaction = original;
  }
  assert.deepEqual((await listProjects()).projects.map((item) => item.id), ["two", "one"]);
});

test("a library upgraded by a newer build is reported as such", async () => {
  await reset();
  await saveProject(project("mine", "2026-10-02T00:00:00.000Z"));
  // another window running a newer build bumps the database version; our
  // connection must step aside so that upgrade is not blocked
  const newer = await openRaw(2);
  newer.close();
  await assert.rejects(listProjects(), /更新版本的音序.*新版 App/);
  await assert.rejects(
    saveProject(project("late", "2026-10-03T00:00:00.000Z")),
    /更新版本的音序.*本次作品尚未保存/,
  );
  await reset();
  // and after the newer database is gone, the library works again
  await saveProject(project("fresh", "2026-10-03T00:00:00.000Z"));
  assert.deepEqual((await listProjects()).projects.map((item) => item.id), ["fresh"]);
});

test("a database without the projects store gives a clear error", async () => {
  await reset();
  // e.g. a script opened "muse-bgm" v1 before the app and created nothing
  const empty = await done(indexedDB.open(DATABASE, 1));
  empty.close();
  await assert.rejects(listProjects(), /结构不完整/);
  await reset();
});
