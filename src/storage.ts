import type {
  Instrument,
  Mood,
  MusicConfig,
  Project,
  TrackName,
} from "./types";

const DATABASE_NAME = "muse-bgm";
const STORE_NAME = "projects";
const MAX_JSON_BYTES = 1024 * 1024;
const MOODS: Mood[] = [
  "bright",
  "chill",
  "cinematic",
  "dreamy",
  "focus",
  "retro",
];
const INSTRUMENTS: Instrument[] = ["piano", "guitar", "synth", "bell"];
const KEYS = ["C major", "D major", "G major", "A minor", "D minor"];
const TRACKS: TrackName[] = ["melody", "chords", "bass", "drums"];
let connection: Promise<IDBDatabase> | undefined;

function invalid(detail: string): never {
  throw new Error(`工程文件格式不正确：${detail}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function textValue(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") return invalid(`${label}必须是文字。`);
  const result = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
  if (!allowEmpty && !result) return invalid(`${label}不能为空。`);
  return result;
}

function numberValue(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer = false,
): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return invalid(`${label}必须是有效数字。`);
  const bounded = Math.max(min, Math.min(max, value));
  return integer ? Math.round(bounded) : bounded;
}

function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T))
    return invalid(`${label}不受支持。`);
  return value as T;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(`${label}必须为布尔值。`);
  return value;
}

function dateValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return invalid(`${label}无效。`);
  return new Date(value).toISOString();
}

function normalizeConfig(value: unknown): MusicConfig {
  const source = record(value, "音乐参数");
  const volumes = record(source.volumes, "分轨音量");
  return {
    prompt: textValue(source.prompt, "灵感描述", 2000, true),
    mood: choice(source.mood, MOODS, "情绪"),
    bpm: numberValue(source.bpm, "速度", 60, 160, true),
    duration: numberValue(source.duration, "时长", 15, 120),
    key: choice(source.key, KEYS, "调性"),
    instrument: choice(source.instrument, INSTRUMENTS, "主奏乐器"),
    energy: numberValue(source.energy, "活力", 0, 1),
    complexity: numberValue(source.complexity, "丰富度", 0, 1),
    reverb: numberValue(source.reverb, "空间感", 0, 1),
    seed: numberValue(source.seed, "随机种子", 0, 0xffffffff, true),
    loop: booleanValue(source.loop, "循环设置"),
    volumes: Object.fromEntries(
      TRACKS.map((track) => [
        track,
        numberValue(volumes[track], `${track}音量`, 0, 1),
      ]),
    ) as Record<TrackName, number>,
  };
}

function normalizeProject(value: unknown, requireAudio: boolean): Project {
  const source = record(value, "工程");
  const provider = choice(
    source.provider,
    ["local", "elevenlabs", "tencent", "volcengine", "aliyun"] as const,
    "生成方式",
  );
  if (
    !Array.isArray(source.tags) ||
    source.tags.some((tag) => typeof tag !== "string")
  )
    return invalid("标签必须是文字列表。");
  const audioBlob = source.audioBlob;
  if (
    audioBlob !== undefined &&
    (!(audioBlob instanceof Blob) || audioBlob.size === 0)
  )
    return invalid("音频数据为空或已损坏。");
  if (requireAudio && provider !== "local" && !(audioBlob instanceof Blob)) {
    throw new Error(
      "此 AI 工程缺少音频文件，无法恢复。请在原作品库中打开，或重新生成音乐。",
    );
  }
  return {
    id: textValue(source.id, "工程编号", 120),
    title: textValue(source.title, "作品名称", 80),
    createdAt: dateValue(source.createdAt, "创建时间"),
    updatedAt: dateValue(source.updatedAt, "修改时间"),
    config: normalizeConfig(source.config),
    provider,
    favorite: booleanValue(source.favorite, "收藏状态"),
    revision: numberValue(
      source.revision,
      "版本",
      1,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    tags: [
      ...new Set(
        source.tags
          .map((tag) => textValue(tag, "标签", 32, true))
          .filter(Boolean),
      ),
    ].slice(0, 12),
    ...(audioBlob instanceof Blob ? { audioBlob } : {}),
    ...(source.audioDuration !== undefined ? { audioDuration: numberValue(source.audioDuration, "实际音频时长", 0.01, 3600) } : {}),
  };
}

function storageError(error: unknown, action: string): Error {
  const name = error instanceof Error ? error.name : "";
  if (name === "QuotaExceededError")
    return new Error(
      "本地存储空间不足，作品未保存。请导出已有作品并删除不需要的作品后重试。",
    );
  if (name === "SecurityError" || name === "InvalidStateError")
    return new Error(
      `无法${action}作品库：当前环境禁止本地存储，请使用桌面 App 或允许浏览器保存网站数据。`,
    );
  return new Error(
    `无法${action}作品库，请重试。${action === "保存" ? "本次作品尚未保存。" : ""}`,
  );
}

function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  if (typeof indexedDB === "undefined")
    return Promise.reject(
      new Error("当前环境不支持本地作品库，请使用桌面 App 或现代浏览器。"),
    );
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    const fail = (error: Error) => {
      settled = true;
      connection = undefined;
      reject(error);
    };
    try {
      request = indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      fail(storageError(error, "打开"));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME))
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onerror = () => fail(storageError(request.error, "打开"));
    request.onblocked = () =>
      fail(
        new Error("作品库正在被另一个窗口使用，请关闭其他 Muse 窗口后重试。"),
      );
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
        connection = undefined;
      };
      database.onclose = () => {
        connection = undefined;
      };
      resolve(database);
    };
  });
  // A synchronous open failure must also clear the cached rejected promise.
  connection.catch(() => {
    connection = undefined;
  });
  return connection;
}

async function transaction<T>(
  mode: IDBTransactionMode,
  action: string,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let request: IDBRequest<T>;
    try {
      const tx = database.transaction(STORE_NAME, mode);
      request = operation(tx.objectStore(STORE_NAME));
      // A successful request is not a committed save: wait for the transaction.
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () =>
        reject(storageError(request.error ?? tx.error, action));
      tx.onerror = () =>
        reject(storageError(request.error ?? tx.error, action));
    } catch (error) {
      reject(storageError(error, action));
    }
  });
}

/** Local recipes and cloud audio Blobs are both stored by structured clone. */
export async function saveProject(project: Project): Promise<void> {
  const normalized = normalizeProject(project, true);
  await transaction("readwrite", "保存", (store) => store.put(normalized));
}

export async function listProjects(): Promise<Project[]> {
  const records = await transaction<unknown[]>("readonly", "读取", (store) =>
    store.getAll(),
  );
  try {
    return records
      .map((value) => normalizeProject(value, true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    throw new Error(
      "作品库中有损坏的工程，无法完整读取。请保留当前 App 数据，以便恢复。",
    );
  }
}

export async function deleteProject(id: string): Promise<void> {
  await transaction("readwrite", "删除", (store) =>
    store.delete(textValue(id, "工程编号", 120)),
  );
}

/** Portable JSON contains the deterministic local recipe, never an audio binary. */
export function exportProject(project: Project): string {
  const { audioBlob: _audioBlob, ...metadata } = normalizeProject(
    project,
    false,
  );
  return JSON.stringify({ schemaVersion: 1, ...metadata }, null, 2);
}

/** Each import is a new local project so importing cannot overwrite a saved work. */
export function importProject(json: string): Project {
  if (
    typeof json !== "string" ||
    json.length > MAX_JSON_BYTES ||
    new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES
  ) {
    throw new Error("工程文件过大，请选择小于 1 MB 的 Muse 工程 JSON 文件。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("无法读取工程文件，请选择有效的 Muse 工程 JSON 文件。");
  }
  const source = record(parsed, "工程");
  if (source.schemaVersion !== 1)
    throw new Error("不支持此工程文件版本，请选择版本 1 的 Muse 工程文件。");
  if (source.provider === "elevenlabs")
    throw new Error(
      "AI 工程 JSON 不包含音频，无法单独导入。请在原作品库中打开 AI 作品；本地作曲工程可以导入。",
    );
  const project = normalizeProject(source, true);
  const now = new Date().toISOString();
  return {
    ...project,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
}
