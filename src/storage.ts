/**
 * Work library (IndexedDB) and portable project JSON.
 *
 * Database "muse-bgm" version 1, store "projects" keyed by `id` — unchanged
 * since v0.2, so existing libraries open as they are. Every record passes
 * through the same strict validator on the way in and on the way out; records
 * without `config.engine` are v0.2 works and stay on engine 1.
 */
import type { AgentTurn } from "./agent/types";
import {
  LEGACY_INSTRUMENTS,
  LEGACY_KEYS,
  LEGACY_MOODS,
} from "./audio/engine-v1";
import { LIMITS, isInstrumentId, isKey, isStyleId } from "./music/catalog";
import { cleanArrangement } from "./music/defaults";
import { TRACKS } from "./music/score";
import { newId, platform } from "./platform";
import type {
  CloudMeta,
  Instrument,
  Mood,
  MusicConfig,
  Project,
  Provider,
  TrackName,
} from "./types";

export interface DamagedRecord {
  /** pass to readRawRecord / deleteProject */
  id: string;
  title: string;
  /** why this build cannot open it, ready to show */
  reason: string;
  /**
   * The raw record carries audio bytes (a cloud result): `readRawAudio` can
   * hand them over. The JSON of `readRawRecord` never contains audio.
   */
  audio?: { type: string; size: number };
  /** the record says it came from a cloud service: its audio was paid for */
  paid?: boolean;
}

/**
 * The fields of a stored work that change after it was made. Only what is
 * listed is written; everything else stays as it is in the library.
 */
export interface ProjectPatch {
  title?: string;
  favorite?: boolean;
  /** only the listed faders change */
  volumes?: Partial<Record<TrackName, number>>;
  audioDuration?: number;
  /** ISO timestamp; the later of this and the stored one is kept */
  updatedAt?: string;
}

/** DamagedRecord.reason of a work saved by a newer build (unknown style, key…). */
export const NEWER_VERSION_REASON = "由更新版本的音序创建，请升级后打开";
/** DamagedRecord.reason of a stored value that is not a work at all. */
export const NOT_A_PROJECT_REASON = "不是音序的工程数据";
/** Written by exportProject; importProject accepts 1..SCHEMA_VERSION. */
export const SCHEMA_VERSION = 2;

const DATABASE_NAME = "muse-bgm";
const DATABASE_VERSION = 1;
const STORE_NAME = "projects";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ID_LENGTH = 120;
const MAX_CHAT_TURNS = 40;
/** AgentTurn.note: the model's own words under an answer. */
const MAX_TURN_NOTE_CHARS = 400;
const UNTITLED = "未命名作品";
const PROVIDERS: readonly Provider[] = [
  "local",
  "tencent",
  "volcengine",
  "aliyun",
  "elevenlabs",
];
/** Ranges of the frozen v0.2 engine. */
const LEGACY_BPM = [60, 160] as const;
const LEGACY_DURATION = [15, 120] as const;
/** As the mixer names them. */
const TRACK_LABELS: Record<TrackName, string> = {
  melody: "旋律",
  chords: "和声",
  bass: "贝斯",
  drums: "鼓组",
};
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

class NewerVersionError extends Error {
  constructor() {
    super(NEWER_VERSION_REASON);
    this.name = "NewerVersionError";
  }
}

/** The value is no work at all: nothing in it is worth a field-level message. */
class NotAProjectError extends Error {
  constructor() {
    super(NOT_A_PROJECT_REASON);
    this.name = "NotAProjectError";
  }
}

function invalid(detail: string): never {
  throw new Error(`工程文件格式不正确：${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  return isRecord(value) ? value : invalid(`${label}必须是对象。`);
}

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Label-like text: control characters removed, trimmed, clipped. */
function textValue(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") return invalid(`${label}必须是文字。`);
  const result = clip(value.replace(CONTROL_CHARACTERS, "").trim(), maxLength);
  if (!allowEmpty && !result) return invalid(`${label}不能为空。`);
  return result;
}

/** Free text kept as written (prompts, chat), minus control characters. */
function freeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") return invalid(`${label}必须是文字。`);
  return clip(value.replace(CONTROL_CHARACTERS, ""), maxLength);
}

/** Ids are never repaired: a changed id would point at another record. */
function idValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return invalid(`${label}无效。`);
  return value;
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

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(`${label}必须为布尔值。`);
  return value;
}

function dateValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  )
    return invalid(`${label}无效。`);
  return new Date(value).toISOString();
}

/**
 * A closed set of words. A word this build has never heard of was written by a
 * newer build; it is reported as such instead of being replaced by a default.
 */
function choice<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (typeof value !== "string") return invalid(`${label}必须是文字。`);
  if (!choices.includes(value as T)) throw new NewerVersionError();
  return value as T;
}

/**
 * Style / instrument / key. `allowed` is what the record's engine can play,
 * `known` is everything this build has. Known but not allowed is corruption.
 */
function engineChoice<T extends string>(
  value: unknown,
  allowed: (value: string) => boolean,
  known: (value: string) => boolean,
  label: string,
): T {
  if (typeof value !== "string") return invalid(`${label}必须是文字。`);
  if (allowed(value)) return value as T;
  if (!known(value)) throw new NewerVersionError();
  return invalid(`${label}与这首作品的引擎版本不匹配。`);
}

const inList = (list: readonly string[]) => (value: string) =>
  list.includes(value);
const legacyMood = inList(LEGACY_MOODS);
const legacyInstrument = inList(LEGACY_INSTRUMENTS);
const legacyKey = inList(LEGACY_KEYS);

function engineValue(value: unknown): 1 | 2 {
  // v0.2 never wrote the field: those works belong to the frozen engine.
  if (value === undefined) return 1;
  if (value === 1 || value === 2) return value;
  if (typeof value === "number" && Number.isInteger(value) && value > 2)
    throw new NewerVersionError();
  return invalid("引擎版本无效。");
}

function normalizeConfig(value: unknown): MusicConfig {
  const source = record(value, "音乐参数");
  // Enumerations first, so a work from a newer build is recognised as such
  // even when other details also differ.
  const engine = engineValue(source.engine);
  const legacy = engine === 1;
  const mood = engineChoice<Mood>(
    source.mood,
    legacy ? legacyMood : isStyleId,
    (item) => isStyleId(item) || legacyMood(item),
    "风格",
  );
  const instrument = engineChoice<Instrument>(
    source.instrument,
    legacy ? legacyInstrument : isInstrumentId,
    (item) => isInstrumentId(item) || legacyInstrument(item),
    "主奏乐器",
  );
  const key = engineChoice<string>(
    source.key,
    legacy ? legacyKey : isKey,
    (item) => isKey(item) || legacyKey(item),
    "调性",
  );
  const volumes = record(source.volumes, "分轨音量");
  const [bpmLow, bpmHigh] = legacy ? LEGACY_BPM : LIMITS.bpm;
  const [durationLow, durationHigh] = legacy
    ? LEGACY_DURATION
    : LIMITS.duration;
  const arrangement = legacy ? undefined : cleanArrangement(source.arrangement);
  return {
    prompt: freeText(source.prompt, "灵感描述", 2000),
    mood,
    bpm: numberValue(source.bpm, "速度", bpmLow, bpmHigh, true),
    duration: numberValue(source.duration, "时长", durationLow, durationHigh),
    key,
    instrument,
    energy: numberValue(source.energy, "情绪能量", 0, 1),
    complexity: numberValue(source.complexity, "旋律丰富度", 0, 1),
    reverb: numberValue(source.reverb, "空间混响", 0, 1),
    seed: numberValue(source.seed, "随机种子", 0, 0xffffffff, true),
    loop: booleanValue(source.loop, "循环设置"),
    volumes: Object.fromEntries(
      TRACKS.map((track) => [
        track,
        numberValue(volumes[track], `${TRACK_LABELS[track]}音量`, 0, 1),
      ]),
    ) as Record<TrackName, number>,
    engine,
    ...(arrangement ? { arrangement } : {}),
  };
}

function normalizeTurn(value: unknown): AgentTurn {
  const source = record(value, "对话记录");
  const role = choice(source.role, ["user", "agent"] as const, "对话角色");
  const brain =
    source.brain === undefined
      ? undefined
      : choice(source.brain, ["rules", "llm"] as const, "对话来源");
  let reasoning: string[] | undefined;
  if (source.reasoning !== undefined) {
    if (!Array.isArray(source.reasoning))
      return invalid("对话说明必须是列表。");
    reasoning = source.reasoning
      .map((item) => textValue(item, "对话说明", 160, true))
      .filter(Boolean)
      .slice(0, 8);
  }
  // A language model's own words, kept apart from the answer. Optional; an
  // empty one is simply not stored.
  const note =
    source.note === undefined
      ? ""
      : textValue(source.note, "模型说明", MAX_TURN_NOTE_CHARS, true);
  return {
    id: idValue(source.id, "对话编号"),
    role,
    text: freeText(source.text, "对话内容", 1500),
    at: dateValue(source.at, "对话时间"),
    ...(reasoning?.length ? { reasoning } : {}),
    ...(brain ? { brain } : {}),
    ...(source.revision !== undefined
      ? {
          revision: numberValue(
            source.revision,
            "对话对应的版本",
            1,
            Number.MAX_SAFE_INTEGER,
            true,
          ),
        }
      : {}),
    ...(source.error !== undefined
      ? { error: booleanValue(source.error, "对话错误标记") }
      : {}),
    ...(note ? { note } : {}),
  };
}

function normalizeChat(value: unknown): AgentTurn[] {
  if (!Array.isArray(value)) return invalid("对话记录必须是列表。");
  // Most recent last: when the thread is too long the oldest turns go.
  return value.slice(-MAX_CHAT_TURNS).map(normalizeTurn);
}

function normalizeCloud(value: unknown): CloudMeta {
  const source = record(value, "云端生成信息");
  const model =
    source.model === undefined
      ? ""
      : textValue(source.model, "云端模型", 128, true);
  return {
    prompt: freeText(source.prompt, "云端提示词", 2000),
    ...(model ? { model } : {}),
  };
}

const isBlob = (value: unknown): value is Blob =>
  typeof Blob !== "undefined" && value instanceof Blob;

function normalize(value: unknown, requireAudio: boolean): Project {
  // A work is told by its engine and its recipe. Without them the value is
  // something else (a stray entry, another program's data): say that, rather
  // than complain about whichever field happens to be checked first.
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    !isRecord(value.config)
  )
    throw new NotAProjectError();
  const source = value;
  const provider = choice(source.provider, PROVIDERS, "生成方式");
  const config = normalizeConfig(source.config);
  if (
    !Array.isArray(source.tags) ||
    source.tags.some((tag) => typeof tag !== "string")
  )
    return invalid("标签必须是文字列表。");
  const audioBlob = source.audioBlob;
  if (audioBlob !== undefined && (!isBlob(audioBlob) || audioBlob.size === 0))
    return invalid("音频数据为空或已损坏。");
  if (requireAudio && provider !== "local" && !isBlob(audioBlob))
    throw new Error(
      "这个云端作品的工程缺少音频文件，无法恢复。请在原来的「我的作品」中打开，或重新生成音乐。",
    );
  const chat = source.chat === undefined ? [] : normalizeChat(source.chat);
  return {
    id: idValue(source.id, "工程编号"),
    title: textValue(source.title, "作品名称", 80),
    createdAt: dateValue(source.createdAt, "创建时间"),
    updatedAt: dateValue(source.updatedAt, "修改时间"),
    config,
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
    ...(isBlob(audioBlob) ? { audioBlob } : {}),
    ...(source.audioDuration !== undefined
      ? {
          audioDuration: numberValue(
            source.audioDuration,
            "实际音频时长",
            0.01,
            3600,
          ),
        }
      : {}),
    ...(source.parentId !== undefined
      ? { parentId: idValue(source.parentId, "来源作品编号") }
      : {}),
    ...(chat.length ? { chat } : {}),
    ...(source.cloud !== undefined
      ? { cloud: normalizeCloud(source.cloud) }
      : {}),
  };
}

/**
 * Strict validator for anything that claims to be a Project: a stored record,
 * a work about to be saved, parsed JSON. Returns a fresh object holding only
 * known fields (numbers clamped into range); throws an Error with a Chinese
 * message for wrong types, non-finite numbers, values from a newer build, or
 * an AI work without its audio.
 */
export function normalizeProject(value: unknown): Project {
  return normalize(value, true);
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */

export type StorageAction = "读取" | "保存" | "删除";

/** The action as a phrase about the library, which the interface calls 「我的作品」. */
const ACTION_WORDS: Record<StorageAction, string> = {
  读取: "读取「我的作品」",
  保存: "保存到「我的作品」",
  删除: "删除「我的作品」里的作品",
};

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" ? name : "";
}

/**
 * Turn an IndexedDB failure into a message that says what actually happened.
 * `opening` is true when the database could not even be opened.
 */
export function describeStorageError(
  error: unknown,
  action: StorageAction,
  opening = false,
): Error {
  const saving = action === "保存";
  const unsaved = saving ? "本次作品尚未保存。" : "";
  const doing = ACTION_WORDS[action];
  // Never told for a save: what was just made lives only in this window, and
  // restarting would destroy it.
  const restart = platform.isDesktop ? "请重新启动应用" : "请刷新页面";
  const forbidden = `当前环境不允许使用「我的作品」（隐私模式、受限的内嵌页面或已禁用网站数据）。请允许此页面保存数据，或使用桌面版。${unsaved}`;
  switch (errorName(error)) {
    case "QuotaExceededError":
      return new Error(
        action === "保存"
          ? "本地存储空间不足，作品未保存。请导出已有作品并删除不需要的作品后重试。"
          : `本地存储空间不足，无法${doing}。请清理磁盘空间后重试。`,
      );
    case "VersionError":
      return new Error(
        `「我的作品」已被更新版本的音序升级，当前版本无法${action}。请使用新版音序打开。${unsaved}`,
      );
    case "SecurityError":
      return new Error(forbidden);
    case "InvalidStateError":
      // While opening this is how some private modes refuse storage; later it
      // means the connection was closed under us.
      return new Error(
        opening
          ? forbidden
          : saving
            ? `「我的作品」的连接已断开，无法保存。请重试。${unsaved}`
            : `「我的作品」的连接已断开，无法${action}。请重试；如果反复出现，${restart}。`,
      );
    case "AbortError":
      return new Error(`${doing}的操作被中断，请重试。${unsaved}`);
    case "UnknownError":
      return new Error(
        saving
          ? `本地数据库出现内部错误，暂时无法${doing}。请稍后重试；如仍失败，请检查磁盘剩余空间。${unsaved}`
          : `本地数据库出现内部错误，无法${doing}。${restart}；如仍失败，请检查磁盘剩余空间。`,
      );
    case "NotFoundError":
      return new Error(
        saving
          ? `「我的作品」的数据结构不完整，无法保存。${unsaved}`
          : `「我的作品」的数据结构不完整，无法${action}。${restart}后重试。`,
      );
    case "DataCloneError":
      return new Error(`作品中包含无法写入「我的作品」的数据。${unsaved}`);
    default:
      return new Error(`无法${doing}，请重试。${unsaved}`);
  }
}

/** Why the database could not be opened; worded later for the action. */
class OpenFailure {
  readonly kind: "unsupported" | "blocked" | "error";
  readonly cause: unknown;
  constructor(kind: OpenFailure["kind"], cause?: unknown) {
    this.kind = kind;
    this.cause = cause;
  }
}

function describeOpenFailure(failure: unknown, action: StorageAction): Error {
  const unsaved = action === "保存" ? "本次作品尚未保存。" : "";
  if (!(failure instanceof OpenFailure))
    return describeStorageError(failure, action, true);
  if (failure.kind === "unsupported")
    return new Error(
      `当前环境不支持「我的作品」，请使用桌面版或较新的浏览器。${unsaved}`,
    );
  if (failure.kind === "blocked")
    return new Error(
      `「我的作品」正被另一个音序窗口占用，请关闭其他窗口后重试。${unsaved}`,
    );
  return describeStorageError(failure.cause, action, true);
}

let connection: Promise<IDBDatabase> | undefined;

/** Rejects with an OpenFailure. */
function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  let factory: IDBFactory | undefined;
  try {
    factory = globalThis.indexedDB;
  } catch (error) {
    return Promise.reject(new OpenFailure("error", error));
  }
  if (!factory) return Promise.reject(new OpenFailure("unsupported"));
  const source = factory;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    const fail = (failure: OpenFailure) => {
      settled = true;
      reject(failure);
    };
    try {
      request = source.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      fail(new OpenFailure("error", error));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME))
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onerror = (event) => {
      event.preventDefault();
      fail(new OpenFailure("error", request.error));
    };
    request.onblocked = () => fail(new OpenFailure("blocked"));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      const forget = () => {
        if (connection === opening) connection = undefined;
      };
      // Another window is upgrading or deleting the library: let it proceed.
      database.onversionchange = () => {
        database.close();
        forget();
      };
      database.onclose = forget;
      resolve(database);
    };
  });
  connection = opening;
  // A failed open must not be cached, or the library stays broken until reload.
  opening.catch(() => {
    if (connection === opening) connection = undefined;
  });
  return opening;
}

/**
 * Run requests in one transaction and resolve with `read()` only after the
 * transaction has committed — a successful request alone is not a saved work.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  action: StorageAction,
  run: (store: IDBObjectStore) => () => T,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const opening = openDatabase();
    let database: IDBDatabase;
    try {
      database = await opening;
    } catch (failure) {
      throw describeOpenFailure(failure, action);
    }
    let tx: IDBTransaction;
    try {
      tx = database.transaction(STORE_NAME, mode);
    } catch (error) {
      // The cached connection was closed under us (the browser may do that
      // without an event): drop it and reopen once before giving up.
      if (attempt === 0 && errorName(error) === "InvalidStateError") {
        if (connection === opening) connection = undefined;
        continue;
      }
      throw describeStorageError(error, action);
    }
    return await new Promise<T>((resolve, reject) => {
      let read: () => T;
      let requestError: unknown;
      tx.oncomplete = () => resolve(read());
      tx.onerror = (event) => {
        requestError ??= (event.target as IDBRequest | null)?.error;
      };
      tx.onabort = () =>
        reject(describeStorageError(tx.error ?? requestError, action));
      try {
        read = run(tx.objectStore(STORE_NAME));
      } catch (error) {
        reject(describeStorageError(error, action));
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
      }
    });
  }
}

/** Synthetic id → real key, for records whose key is not a usable string. */
const damagedKeys = new Map<string, IDBValidKey>();

function storeKey(id: string): IDBValidKey {
  if (typeof id !== "string" || !id) throw new Error("工程编号无效。");
  return damagedKeys.get(id) ?? id;
}

function damagedTitle(value: unknown): string {
  const title = isRecord(value) ? value.title : undefined;
  if (typeof title !== "string") return UNTITLED;
  return clip(title.replace(CONTROL_CHARACTERS, "").trim(), 80) || UNTITLED;
}

/** What a damaged record still holds that is worth saving before deleting it. */
function damagedFacts(value: unknown): Pick<DamagedRecord, "audio" | "paid"> {
  if (!isRecord(value)) return {};
  const blob = value.audioBlob;
  const cloud =
    typeof value.provider === "string" && value.provider !== "local";
  return {
    ...(isBlob(blob) && blob.size > 0
      ? { audio: { type: blob.type, size: blob.size } }
      : {}),
    ...(cloud ? { paid: true } : {}),
  };
}

function damagedReason(error: unknown): string {
  if (error instanceof NewerVersionError) return NEWER_VERSION_REASON;
  return error instanceof Error && error.message
    ? error.message
    : "数据已损坏，无法读取";
}

/**
 * The whole library, newest first. A record this build cannot read is listed
 * in `damaged` (export it with readRawRecord, remove it with deleteProject)
 * and never hides the works that are fine.
 */
export async function listProjects(): Promise<{
  projects: Project[];
  damaged: DamagedRecord[];
}> {
  interface Row {
    key: IDBValidKey;
    value?: unknown;
    unreadable?: boolean;
  }
  const rows = await withStore<Row[]>("readonly", "读取", (store) => {
    const collected: Row[] = [];
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      // One request per record: a value the browser cannot deserialize fails
      // alone instead of failing a single getAll for the whole library.
      for (const key of keys.result) {
        const row: Row = { key };
        collected.push(row);
        const request = store.get(key);
        request.onsuccess = () => {
          row.value = request.result;
        };
        request.onerror = (event) => {
          row.unreadable = true;
          event.preventDefault();
          event.stopPropagation();
        };
      }
    };
    return () => collected;
  });

  const taken = new Set(
    rows.map((row) => row.key).filter((key) => typeof key === "string"),
  );
  const projects: Project[] = [];
  const damaged: DamagedRecord[] = [];
  damagedKeys.clear();
  let counter = 0;
  const report = (row: Row, reason: string) => {
    let id: string;
    if (
      typeof row.key === "string" &&
      row.key.length > 0 &&
      row.key.length <= MAX_ID_LENGTH
    )
      id = row.key;
    else {
      do id = `damaged:${++counter}`;
      while (taken.has(id));
      damagedKeys.set(id, row.key);
    }
    damaged.push({
      id,
      title: damagedTitle(row.value),
      reason,
      ...damagedFacts(row.value),
    });
  };
  for (const row of rows) {
    if (row.unreadable || row.value === undefined) {
      report(row, "这条记录的数据已损坏，无法读取");
      continue;
    }
    try {
      const project = normalize(row.value, true);
      projects.push(project);
    } catch (error) {
      report(row, damagedReason(error));
    }
  }
  const time = (project: Project, field: "updatedAt" | "createdAt") =>
    Date.parse(project[field]);
  projects.sort(
    (a, b) =>
      time(b, "updatedAt") - time(a, "updatedAt") ||
      time(b, "createdAt") - time(a, "createdAt") ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { projects, damaged };
}

/**
 * Store a whole work: a new one, or one that replaces what is there. Local
 * recipes and cloud audio Blobs are both stored by structured clone.
 *
 * `ifMissing` is for putting a work BACK (undo of a delete): the record is
 * written only when its key is free, so whatever another window stored there
 * in the meantime is kept. Resolves false when nothing was written.
 *
 * A work that is already in the library is changed with `updateProject`,
 * never with this function — a whole-record write from a window that read
 * the library earlier would undo what other windows did since.
 */
export async function saveProject(
  project: Project,
  options: { ifMissing?: boolean } = {},
): Promise<boolean> {
  const normalized = normalize(project, true);
  return await withStore("readwrite", "保存", (store) => {
    let written = true;
    if (options.ifMissing) {
      const existing = store.getKey(normalized.id);
      existing.onsuccess = () => {
        if (existing.result === undefined) store.put(normalized);
        else written = false;
      };
    } else store.put(normalized);
    return () => written;
  });
}

const later = (a: string, b: string | undefined) =>
  b !== undefined && Date.parse(b) > Date.parse(a) ? b : a;

/** `patch` applied to a stored work; throws like normalize for bad values. */
function applyPatch(current: Project, patch: ProjectPatch): Project {
  const volumes = { ...current.config.volumes };
  if (patch.volumes)
    for (const track of TRACKS) {
      const value = patch.volumes[track];
      if (value !== undefined)
        volumes[track] = numberValue(value, `${TRACK_LABELS[track]}音量`, 0, 1);
    }
  return {
    ...current,
    ...(patch.title !== undefined
      ? { title: textValue(patch.title, "作品名称", 80) }
      : {}),
    ...(patch.favorite !== undefined
      ? { favorite: booleanValue(patch.favorite, "收藏状态") }
      : {}),
    ...(patch.audioDuration !== undefined
      ? {
          audioDuration: numberValue(
            patch.audioDuration,
            "实际音频时长",
            0.01,
            3600,
          ),
        }
      : {}),
    ...(patch.updatedAt !== undefined
      ? {
          updatedAt: later(
            current.updatedAt,
            dateValue(patch.updatedAt, "修改时间"),
          ),
        }
      : {}),
    config: { ...current.config, volumes },
  };
}

/**
 * Change some fields of a stored work: read, patch and write in ONE
 * transaction, so a rename made in another window survives a favourite or a
 * fader move made here (and the other way round). Resolves with the work as
 * it is stored now, or null when the record no longer exists — a deleted work
 * stays deleted; it is never written back by an edit.
 *
 * `unlessNewer`: skip the patch (and resolve with the stored work) when the
 * record was modified after `patch.updatedAt` — for a change that was noted
 * down earlier and is applied late.
 */
export async function updateProject(
  id: string,
  patch: ProjectPatch,
  options: { unlessNewer?: boolean } = {},
): Promise<Project | null> {
  if (typeof id !== "string" || !id) throw new Error("工程编号无效。");
  let failure: unknown;
  try {
    return await withStore<Project | null>("readwrite", "保存", (store) => {
      let result: Project | null = null;
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result === undefined) return;
        try {
          const current = normalize(request.result, true);
          const stale =
            options.unlessNewer &&
            patch.updatedAt !== undefined &&
            Date.parse(current.updatedAt) > Date.parse(patch.updatedAt);
          result = stale ? current : applyPatch(current, patch);
          if (!stale) store.put(result);
        } catch (error) {
          // Nothing is written: neither a broken record nor a bad value.
          failure =
            error instanceof NewerVersionError ||
            error instanceof NotAProjectError
              ? new Error("这条记录无法读取，不能修改。")
              : error;
          store.transaction.abort();
        }
      };
      return () => result;
    });
  } catch (error) {
    throw failure ?? error;
  }
}

/** One stored work, or null when it is missing or cannot be read. */
export async function readProject(id: string): Promise<Project | null> {
  if (typeof id !== "string" || !id) throw new Error("工程编号无效。");
  const value = await withStore<unknown>("readonly", "读取", (store) => {
    const request = store.get(id);
    return () => request.result;
  });
  if (value === undefined) return null;
  try {
    return normalize(value, true);
  } catch {
    return null;
  }
}

/** Also removes damaged records: pass DamagedRecord.id. */
export async function deleteProject(id: string): Promise<void> {
  const key = storeKey(id);
  await withStore("readwrite", "删除", (store) => {
    store.delete(key);
    return () => undefined;
  });
  damagedKeys.delete(id);
}

/** JSON-safe copy of anything structured clone can hold, without binary data. */
function toPlain(value: unknown, path: Set<object>): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      return undefined;
  }
  if (value === null) return null;
  const object = value as object;
  if (isBlob(object) || object instanceof ArrayBuffer) return undefined;
  if (ArrayBuffer.isView(object)) return undefined;
  if (object instanceof Date)
    return Number.isFinite(object.getTime()) ? object.toISOString() : null;
  if (path.has(object)) return "[循环引用]";
  if (path.size >= 64) return "[嵌套过深]";
  path.add(object);
  let result: unknown;
  if (Array.isArray(object))
    result = object.map((item) => toPlain(item, path) ?? null);
  else if (object instanceof Map)
    result = [...object.entries()].map((entry) => toPlain(entry, path) ?? null);
  else if (object instanceof Set)
    result = [...object].map((item) => toPlain(item, path) ?? null);
  else {
    // A null prototype keeps a stored "__proto__" key an ordinary property.
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object)) {
      const item = toPlain((object as Record<string, unknown>)[key], path);
      if (item !== undefined) copy[key] = item;
    }
    result = copy;
  }
  path.delete(object);
  return result;
}

/**
 * The stored record exactly as it is, as JSON text and without audio — what a
 * user can save from a damaged entry before deleting it. null when missing.
 */
export async function readRawRecord(id: string): Promise<string | null> {
  const key = storeKey(id);
  const value = await withStore<unknown>("readonly", "读取", (store) => {
    const request = store.get(key);
    return () => request.result;
  });
  if (value === undefined) return null;
  return JSON.stringify(toPlain(value, new Set()) ?? null, null, 2);
}

/**
 * The audio bytes of a stored record exactly as they are, whatever state the
 * rest of the record is in — so paid audio can be saved from an entry this
 * build cannot open. null when the record has no audio.
 */
export async function readRawAudio(id: string): Promise<Blob | null> {
  const key = storeKey(id);
  const value = await withStore<unknown>("readonly", "读取", (store) => {
    const request = store.get(key);
    return () => request.result;
  });
  const blob = isRecord(value) ? value.audioBlob : undefined;
  return isBlob(blob) && blob.size > 0 ? blob : null;
}

function storageManager(): StorageManager | undefined {
  try {
    return typeof navigator === "undefined" ? undefined : navigator.storage;
  } catch {
    return undefined;
  }
}

const bytes = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** How full this origin's storage is, or null when the browser will not say. */
export async function storageInfo(): Promise<{
  usage: number;
  quota: number;
  persisted: boolean;
} | null> {
  try {
    const manager = storageManager();
    if (typeof manager?.estimate !== "function") return null;
    const estimate = await manager.estimate();
    const persisted =
      typeof manager.persisted === "function"
        ? await manager.persisted().catch(() => false)
        : false;
    return {
      usage: bytes(estimate?.usage),
      quota: bytes(estimate?.quota),
      persisted: persisted === true,
    };
  } catch {
    return null;
  }
}

/**
 * Ask the browser not to evict the library under storage pressure. Resolves
 * true when the origin is (now) persistent; never throws.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    const manager = storageManager();
    if (typeof manager?.persist !== "function") return false;
    if (typeof manager.persisted === "function" && (await manager.persisted()))
      return true;
    return (await manager.persist()) === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* portable JSON                                                       */
/* ------------------------------------------------------------------ */

/** Portable JSON holds the recipe and its history, never an audio binary. */
export function exportProject(project: Project): string {
  const { audioBlob: _audioBlob, ...metadata } = normalize(project, false);
  return JSON.stringify(
    { schemaVersion: SCHEMA_VERSION, ...metadata },
    null,
    2,
  );
}

/** Each import is a new project: importing never overwrites a saved work. */
export function importProject(text: string): Project {
  if (typeof text !== "string")
    throw new Error("无法读取工程文件，请选择有效的 Muse 工程 JSON 文件。");
  // UTF-8 never needs fewer bytes than UTF-16 code units, so the cheap test
  // spares encoding a file that is certainly too large.
  if (
    text.length > MAX_JSON_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES
  )
    throw new Error("工程文件过大，请选择小于 1 MB 的 Muse 工程 JSON 文件。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error("无法读取工程文件，请选择有效的 Muse 工程 JSON 文件。");
  }
  const source = record(parsed, "工程");
  const version = source.schemaVersion;
  if (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version > SCHEMA_VERSION
  )
    throw new Error("此工程文件由更新版本的音序导出，请升级后再导入。");
  if (version !== 1 && version !== 2)
    throw new Error("不支持此工程文件版本，请选择由音序导出的工程 JSON 文件。");
  if (
    typeof source.provider === "string" &&
    source.provider !== "local" &&
    (PROVIDERS as readonly string[]).includes(source.provider)
  )
    throw new Error(
      "云端作品的工程 JSON 不包含音频，无法单独导入。请在原来的「我的作品」中打开这首作品；本地作曲的工程可以导入。",
    );
  let project: Project;
  try {
    project = normalize(source, true);
  } catch (error) {
    if (error instanceof NewerVersionError)
      throw new Error("此工程文件由更新版本的音序创建，请升级后再导入。");
    if (error instanceof NotAProjectError)
      throw new Error(
        "这个文件不是音序的工程数据，请选择由音序导出的工程 JSON 文件。",
      );
    throw error;
  }
  const now = new Date().toISOString();
  return { ...project, id: newId(), createdAt: now, updatedAt: now };
}
