/**
 * Decisions of the app core as pure functions: no React, no timers, no
 * storage, no audio. Everything here runs under Node and is unit-tested.
 */
import { TRACK_LABELS, keyLabel } from "../agent/cloudPrompt";
import type { AgentPlan, AgentTurn } from "../agent/types";
import {
  INSTRUMENT_LIST,
  LIMITS,
  STYLES,
  isInstrumentId,
  isKey,
  isStyleId,
} from "../music/catalog";
import { clampConfig, stylePreset } from "../music/defaults";
import { TRACKS } from "../music/score";
import type {
  CloudMeta,
  MusicConfig,
  Project,
  Provider,
  TrackName,
} from "../types";
import { DRAFT_FIELDS } from "./types";
import type { Draft, DraftField } from "./types";

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

export function isAbort(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * The text of a JavaScript exception, wherever it stands in a message. A
 * Chinese prefix in front of it ("本地引擎出错：Cannot read properties…")
 * does not make it something to show to a user.
 */
const RAW_EXCEPTION =
  /\b(?:Uncaught|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|InternalError|AggregateError|DOMException)\b|Cannot (?:read|set|access|convert|destructure)|is not (?:a function|defined|iterable|a constructor)|of (?:undefined|null)\b|(?:undefined|null) is not|Unexpected (?:token|end|identifier)|Maximum call stack|allocation failed|out of memory|Invalid (?:array|typed array|string) length/;
const OUT_OF_MEMORY =
  /allocation failed|out of memory|Invalid (?:array|typed array|string) length|Maximum call stack/i;
export const OUT_OF_MEMORY_TEXT =
  "内存不足，无法完成这次操作。请缩短时长或关闭其他页面后重试。";

/**
 * A message that is safe to show: Chinese text from our own code or the main
 * process, without IPC or exception prefixes. Anything else (an English
 * exception — bare or wrapped in a Chinese prefix — or an object) becomes
 * `fallback`; running out of memory is said as such.
 */
export function errorText(error: unknown, fallback: string): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const message = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  if (RAW_EXCEPTION.test(message))
    return OUT_OF_MEMORY.test(message) ? OUT_OF_MEMORY_TEXT : fallback;
  return /[一-鿿]/.test(message) ? message.slice(0, 240) : fallback;
}

/* ------------------------------------------------------------------ */
/* text                                                                */
/* ------------------------------------------------------------------ */

export const MAX_TITLE_CHARS = 64;

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** What the user typed, as the producer receives it; "" means nothing to send. */
export function cleanMessage(text: unknown): string {
  return typeof text === "string"
    ? clip(
        text
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
          .trim(),
        LIMITS.promptChars,
      )
    : "";
}

/**
 * A title the library accepts, or null when nothing usable was typed. Titles
 * are never made unique: the version tag and the date tell works apart.
 */
const LATIN_EDGE = /[A-Za-z0-9]/;
const CJK_EDGE = /[\u3400-\u9fff]/;

/**
 * Join pieces of a sentence, putting a space wherever a Latin letter or digit
 * meets a Chinese character: "腾讯云 TokenHub" + "正在创作" reads as
 * "腾讯云 TokenHub 正在创作", while "火山引擎 AI 音乐" + "正在创作" stays joined.
 */
export function joinText(...parts: string[]): string {
  let text = "";
  for (const part of parts) {
    if (!part) continue;
    const before = text.slice(-1);
    const after = part[0];
    const gap =
      (LATIN_EDGE.test(before) && CJK_EDGE.test(after)) ||
      (CJK_EDGE.test(before) && LATIN_EDGE.test(after));
    text += gap ? ` ${part}` : part;
  }
  return text;
}

/**
 * Add a ready-made phrase to what is already typed, without sending it and
 * without losing a character of the user's own text.
 */
export function appendPhrase(typed: string, phrase: string): string {
  const addition = phrase.trim();
  if (!addition) return typed;
  if (!typed.trim()) return addition;
  if (typed.includes(addition)) return typed;
  const joiner = /[，,。.；;、！!？?\s]$/.test(typed) ? "" : "，";
  return clip(`${typed}${joiner}${addition}`, LIMITS.promptChars);
}

export function cleanTitle(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const title = clip(
    input
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    MAX_TITLE_CHARS,
  ).trim();
  return title || null;
}

/* ------------------------------------------------------------------ */
/* draft                                                               */
/* ------------------------------------------------------------------ */

/** Fields a style brings with it (stylePreset). */
const PRESET_FIELDS = [
  "bpm",
  "key",
  "instrument",
  "energy",
  "complexity",
  "reverb",
] as const satisfies readonly DraftField[];

const sameValue = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number"
    ? Math.abs(a - b) < 1e-6
    : a === b;

export function draftOf(config: MusicConfig): Draft {
  return {
    mood: config.mood,
    bpm: config.bpm,
    instrument: config.instrument,
    key: config.key,
    energy: config.energy,
    complexity: config.complexity,
    reverb: config.reverb,
    duration: config.duration,
    loop: config.loop,
  };
}

/** Inspector fields whose draft value differs from the committed work. */
export function changedFields(
  draft: Draft,
  committed: MusicConfig | null | undefined,
): DraftField[] {
  if (!committed) return [];
  return DRAFT_FIELDS.filter(
    (field) => !sameValue(draft[field], committed[field]),
  );
}

function withField<K extends DraftField>(
  draft: Draft,
  field: K,
  value: Draft[K],
): Draft {
  return { ...draft, [field]: value };
}

/** Keep a hand-edited value inside the range the engine accepts. */
function cleanDraftValue<K extends DraftField>(
  field: K,
  value: Draft[K],
  fallback: Draft[K],
): Draft[K] {
  const number = (low: number, high: number, integer: boolean) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    const bounded = Math.max(low, Math.min(high, value));
    return (integer ? Math.round(bounded) : bounded) as Draft[K];
  };
  switch (field) {
    case "bpm":
      return number(LIMITS.bpm[0], LIMITS.bpm[1], true);
    case "duration":
      return number(LIMITS.duration[0], LIMITS.duration[1], true);
    case "energy":
    case "complexity":
    case "reverb":
      return number(0, 1, false);
    case "loop":
      return (typeof value === "boolean" ? value : fallback) as Draft[K];
    case "mood":
      return isStyleId(value) ? value : fallback;
    case "instrument":
      return isInstrumentId(value) ? value : fallback;
    default:
      return isKey(value) ? value : fallback;
  }
}

/**
 * Inspector edits read back from somewhere that cannot be trusted (the
 * remembered session): only fields that exist, with values the engine
 * accepts. A value of the wrong kind is left out, never replaced by a guess.
 */
export function cleanDraftPatch(value: unknown): Partial<Draft> {
  const patch: Partial<Draft> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return patch;
  const source = value as Record<string, unknown>;
  const absent = Symbol("absent");
  for (const field of DRAFT_FIELDS) {
    if (!Object.hasOwn(source, field)) continue;
    const cleaned = cleanDraftValue(
      field,
      source[field] as Draft[typeof field],
      absent as unknown as Draft[typeof field],
    );
    if ((cleaned as unknown) !== absent)
      Object.assign(patch, { [field]: cleaned });
  }
  return patch;
}

/**
 * One inspector edit. Choosing a style also moves tempo, key, lead, energy,
 * richness and reverb to that style's preset — except the fields the user has
 * already set by hand (`touched`). Going back to the committed style returns
 * the untouched fields to the committed values.
 */
export function editDraft<K extends DraftField>(
  state: { draft: Draft; touched: DraftField[] },
  committed: MusicConfig | null,
  field: K,
  value: Draft[K],
): { draft: Draft; touched: DraftField[] } {
  const cleaned = cleanDraftValue(field, value, state.draft[field]);
  let draft = withField(state.draft, field, cleaned);
  const touched = state.touched.includes(field)
    ? state.touched
    : [...state.touched, field];
  if (field === "mood" && isStyleId(cleaned)) {
    const source: Pick<MusicConfig, (typeof PRESET_FIELDS)[number]> =
      committed && committed.mood === cleaned
        ? committed
        : stylePreset(cleaned);
    for (const preset of PRESET_FIELDS)
      if (!touched.includes(preset))
        draft = withField(draft, preset, source[preset]);
  }
  return { draft, touched };
}

/**
 * Inspector edits that a finished generation did not use, to be put on top
 * of the new version's draft instead of being wiped: every field whose
 * current value differs from what the job consumed (the draft it applied, or
 * the committed values it started from) and from the new version itself.
 */
export function carriedDraft(
  current: Draft,
  consumed: Draft,
  next: MusicConfig,
): Partial<Draft> {
  const carried: Partial<Draft> = {};
  for (const field of DRAFT_FIELDS)
    if (
      !sameValue(current[field], consumed[field]) &&
      !sameValue(current[field], next[field])
    )
      Object.assign(carried, { [field]: current[field] });
  return carried;
}

/** 还原: one field (or all of them) back to the committed work. */
export function resetDraft(
  state: { draft: Draft; touched: DraftField[] },
  committed: MusicConfig,
  field?: DraftField,
): { draft: Draft; touched: DraftField[] } {
  if (!field) return { draft: draftOf(committed), touched: [] };
  return {
    draft: withField(state.draft, field, committed[field]),
    touched: state.touched.filter((item) => item !== field),
  };
}

/**
 * The configuration 应用调整 generates: the committed work with the draft's
 * fields on top. Seed, volumes and description always come from the committed
 * work, so the melody material and the mix survive. Style-specific
 * arrangement hints do not survive a change of style. Always engine 2.
 */
export function configFromDraft(
  committed: MusicConfig,
  draft: Draft,
): MusicConfig {
  const base = clampConfig(committed);
  const restyled = draft.mood !== committed.mood;
  return clampConfig(
    {
      ...base,
      ...draftOf({ ...base, ...draft }),
      seed: committed.seed,
      volumes: { ...committed.volumes },
      prompt: committed.prompt,
      arrangement: restyled ? undefined : committed.arrangement,
    },
    base,
  );
}

/* ------------------------------------------------------------------ */
/* mixer                                                               */
/* ------------------------------------------------------------------ */

export function clampVolume(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

export function sameVolumes(
  a: Record<TrackName, number>,
  b: Record<TrackName, number>,
): boolean {
  return TRACKS.every((track) => Math.abs(a[track] - b[track]) < 1e-6);
}

/**
 * Faders of a version that was planned from `start` but finished while the
 * user kept mixing: a track the plan itself changed keeps the plan's level;
 * every other track takes where the fader is now.
 */
export function rebaseVolumes(
  planned: Record<TrackName, number>,
  start: Record<TrackName, number>,
  live: Record<TrackName, number>,
): Record<TrackName, number> {
  const result = { ...planned };
  for (const track of TRACKS)
    if (Math.abs(planned[track] - start[track]) < 1e-6)
      result[track] = clampVolume(live[track], planned[track]);
  return result;
}

/**
 * M button. Muting remembers the fader position; unmuting returns to it (or
 * to `fallback` when the work was already muted when it was opened).
 */
export function toggleMuteVolumes(
  volumes: Record<TrackName, number>,
  mutedFrom: Partial<Record<TrackName, number>>,
  track: TrackName,
  fallback: number,
): {
  volumes: Record<TrackName, number>;
  mutedFrom: Partial<Record<TrackName, number>>;
} {
  const current = clampVolume(volumes[track]);
  const { [track]: remembered, ...rest } = mutedFrom;
  if (current > 0)
    return {
      volumes: { ...volumes, [track]: 0 },
      mutedFrom: { ...rest, [track]: current },
    };
  const restored = clampVolume(remembered, 0) || clampVolume(fallback, 0.6);
  return { volumes: { ...volumes, [track]: restored }, mutedFrom: rest };
}

/* ------------------------------------------------------------------ */
/* thread                                                              */
/* ------------------------------------------------------------------ */

/** Same cap as storage.ts: the newest turns are kept. */
export const MAX_THREAD_TURNS = 40;

export function capThread(turns: readonly AgentTurn[]): AgentTurn[] {
  return turns.slice(-MAX_THREAD_TURNS);
}

export function userTurn(id: string, at: string, text: string): AgentTurn {
  return { id, role: "user", text: clip(text, 1500), at };
}

/**
 * One kind of quotation mark in the whole interface: everything that is
 * quoted or named stands in 「」. The offline rules write it that way; a
 * language model may quote with curly quotes (U+201C, U+201D).
 */
export function houseQuotes(text: string): string {
  return text.replace(/\u201c([^\u201c\u201d]*)\u201d/g, "「$1」");
}

/**
 * One name per thing, also in what the producer says: 循环片段 / 完整结尾
 * for a work's structure, 新版引擎 for the engine. The offline rules use
 * those words themselves; this table catches the other ways a language
 * model tends to put them. A text that already uses the interface's words
 * passes unchanged.
 */
const HOUSE_TERMS: readonly (readonly [RegExp, string])[] = [
  [/改为带结尾的完整版本/g, "结构改为完整结尾"],
  [/改为无缝循环/g, "结构改为循环片段"],
  [/已经是带结尾的完整版本/g, "已经是完整结尾"],
  [/已经是无缝循环的版本/g, "已经是循环片段"],
  [/可无缝循环/g, "循环片段"],
  [/带完整结尾/g, "完整结尾"],
  [/无缝循环/g, "循环片段"],
  [/新版音色引擎/g, "新版引擎"],
];

export function houseTerms(text: string): string {
  let result = text;
  for (const [pattern, word] of HOUSE_TERMS)
    result = result.replace(pattern, word);
  return result;
}

/** Quotation marks and names as the interface uses them. */
export const houseStyle = (text: string): string =>
  houseTerms(houseQuotes(text));

/**
 * Apply `change` to everything in `text` that is not a quotation. Quoted
 * words — the user's request repeated back in 「」, or in the curly quotes a
 * language model may use — are somebody's own wording: they are never
 * rewritten, whatever the text around them is corrected to.
 */
export function outsideQuotes(
  text: string,
  change: (part: string) => string,
): string {
  return text
    .split(/(「[^「」]*」|\u201c[^\u201c\u201d]*\u201d)/)
    .map((part, index) => (index % 2 === 1 ? part : change(part)))
    .join("");
}

/* ---------- names instead of ids ---------- */

/**
 * The catalogue's own ids, as they can turn up in something a language model
 * wrote ("主奏乐器更换为 piano"), with the names the interface uses for them.
 */
const NAME_OF_ID: ReadonlyMap<string, string> = new Map<string, string>([
  ...STYLES.map((style) => [style.id, style.label] as const),
  ...INSTRUMENT_LIST.map((item) => [item.id, item.label] as const),
  ...TRACKS.map((track) => [track, TRACK_LABELS[track]] as const),
]);
const ID_WORD = new RegExp(
  `( ?)(?<![A-Za-z0-9_#.-])(${[...NAME_OF_ID.keys()]
    .sort((a, b) => b.length - a.length)
    .join("|")})(?![A-Za-z0-9_-])( ?)`,
  "g",
);
const KEY_WORD =
  /( ?)(?<![A-Za-z0-9_-])([A-G](?:#|b)? (?:major|minor))(?![A-Za-z])( ?)/g;
const HAN = /\p{Script=Han}/u;

/**
 * Text for the thread with every bare id put into words: a style, a lead
 * instrument, a track or a key is called what the inspector and the mixer
 * call it. A space that only separated the id from Chinese text goes with it.
 * Text without ids comes back unchanged.
 */
export function plainNames(text: string): string {
  const named =
    (nameOf: (id: string) => string | undefined) =>
    (
      match: string,
      gapBefore: string,
      id: string,
      gapAfter: string,
      offset: number,
      whole: string,
    ) => {
      const name = nameOf(id);
      if (!name) return match;
      const before = whole[offset - 1] ?? "";
      const after = whole[offset + match.length] ?? "";
      const closeBefore = HAN.test(before) && HAN.test(name[0] ?? "");
      const closeAfter = HAN.test(after) && HAN.test(name.at(-1) ?? "");
      return `${closeBefore ? "" : gapBefore}${name}${closeAfter ? "" : gapAfter}`;
    };
  // What stands in quotes is somebody's own wording and stays as it is.
  return outsideQuotes(text, (part) =>
    part
      .replace(
        KEY_WORD,
        named((id) => (isKey(id) ? keyLabel(id) : undefined)),
      )
      .replace(
        ID_WORD,
        named((id) => NAME_OF_ID.get(id)),
      ),
  );
}

/** The model's own words under an answer: this many characters at most. */
export const MAX_NOTE_CHARS = 400;

/**
 * What a language model said in its own words, as the thread may show it:
 * one line, house quotes and names, clipped. "" when there is nothing to show.
 */
export function cleanNote(note: unknown): string {
  if (typeof note !== "string") return "";
  return clip(
    plainNames(houseStyle(note.replace(/[\p{Cc}\s]+/gu, " ").trim())),
    MAX_NOTE_CHARS,
  ).trim();
}

/** The producer's answer as a stored turn. `revision` only when a version was made. */
export function agentTurn(
  id: string,
  at: string,
  plan: Pick<AgentPlan, "reply" | "reasoning" | "brain"> &
    Partial<Pick<AgentPlan, "modelNote">>,
  options: { revision?: number; direct?: boolean } = {},
): AgentTurn {
  const reasoning = plan.reasoning
    .map((line) => {
      const styled = houseStyle(line.trim());
      // The offline rules write their own chips; a model may name things by id.
      return clip(plan.brain === "llm" ? plainNames(styled) : styled, 160);
    })
    .filter(Boolean)
    .slice(0, 8);
  const text = clip(houseStyle(plan.reply), 1500);
  // The model's own words are kept apart from the answer, which the app
  // writes from what really changes. A note that only repeats the answer
  // adds nothing, and a direct control has no model behind it.
  const said = options.direct ? "" : cleanNote(plan.modelNote);
  return {
    id,
    role: "agent",
    text,
    at,
    ...(reasoning.length ? { reasoning } : {}),
    // Direct controls (应用调整 / 换一版旋律) are not a brain's answer.
    ...(options.direct ? {} : { brain: plan.brain }),
    ...(options.revision !== undefined ? { revision: options.revision } : {}),
    ...(said && said !== text ? { note: said } : {}),
  };
}

export function failureTurn(id: string, at: string, text: string): AgentTurn {
  return { id, role: "agent", text: clip(text, 1500), at, error: true };
}

/* ------------------------------------------------------------------ */
/* versions                                                            */
/* ------------------------------------------------------------------ */

export interface NewProjectInput {
  id: string;
  /** ISO timestamp */
  now: string;
  plan: Pick<AgentPlan, "config" | "title" | "tags">;
  /** the work this one refines; null for a new piece */
  base: Project | null;
  provider: Provider;
  /** full thread including the two new turns */
  chat: AgentTurn[];
  audioDuration?: number;
  audioBlob?: Blob;
  cloud?: CloudMeta;
  /** version number in the lineage; default: one more than the base's */
  revision?: number;
}

/** Revision a generation started from `base` will produce. */
export function nextRevision(base: Project | null): number {
  return base ? base.revision + 1 : 1;
}

/**
 * Every generation is a new work: new id, revision + 1, parentId = the work
 * it came from. The earlier version stays in the library untouched. A
 * refinement keeps its title; a new piece takes the producer's.
 */
export function buildProject(input: NewProjectInput): Project {
  const { base, plan } = input;
  const title =
    (base ? cleanTitle(base.title) : null) ??
    cleanTitle(plan.title) ??
    "未命名作品";
  const tags = [
    ...new Set(plan.tags.map((tag) => clip(tag.trim(), 32)).filter(Boolean)),
  ].slice(0, 12);
  const chat = capThread(input.chat);
  const duration = input.audioDuration;
  return {
    id: input.id,
    title,
    createdAt: input.now,
    updatedAt: input.now,
    config: plan.config,
    provider: input.provider,
    favorite: false,
    revision: input.revision ?? nextRevision(base),
    tags,
    ...(input.audioBlob ? { audioBlob: input.audioBlob } : {}),
    ...(typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration > 0
      ? { audioDuration: duration }
      : {}),
    ...(base ? { parentId: base.id } : {}),
    ...(chat.length ? { chat } : {}),
    ...(input.cloud ? { cloud: input.cloud } : {}),
  };
}

/** Does the stored duration need to be corrected after a render / decode? */
export function durationChanged(
  stored: number | undefined,
  actual: number,
): boolean {
  if (!Number.isFinite(actual) || actual <= 0) return false;
  return stored === undefined || Math.abs(stored - actual) > 0.05;
}

/* ------------------------------------------------------------------ */
/* scheduling                                                          */
/* ------------------------------------------------------------------ */

/** Faders are saved this long after the last move (and at once on release). */
export const MIX_SAVE_DELAY_MS = 400;
export const SESSION_SAVE_DELAY_MS = 500;
export const UNDO_WINDOW_MS = 8000;
/** A failed first save of a new work is retried once, this much later. */
export const SAVE_RETRY_MS = 3000;
export const TOAST_INFO_MS = 4000;
export const TOAST_ERROR_MS = 8000;
/** Autoplay only if the gesture that started the job is this recent. */
export const AUTOPLAY_WINDOW_MS = 60_000;

/**
 * Trailing-debounce bookkeeping without a timer: `dueAt` is when the pending
 * write has to happen, null when nothing is pending. The core owns the one
 * timer and asks these functions what to do.
 */
export interface Schedule {
  dueAt: number | null;
}

export const IDLE: Schedule = { dueAt: null };

/** Something changed at `now`: (re)start the wait. */
export function scheduleChange(now: number, delay: number): Schedule {
  return { dueAt: now + Math.max(0, delay) };
}

/** The user let go: write now if anything is pending. */
export function scheduleRelease(schedule: Schedule, now: number): Schedule {
  return schedule.dueAt === null ? schedule : { dueAt: now };
}

export function isDue(schedule: Schedule, now: number): boolean {
  return schedule.dueAt !== null && now >= schedule.dueAt;
}

/** Milliseconds until the pending write, or null when nothing is pending. */
export function waitFor(schedule: Schedule, now: number): number | null {
  return schedule.dueAt === null ? null : Math.max(0, schedule.dueAt - now);
}

export function shouldAutoplay(gestureAt: number | null, now: number): boolean {
  return (
    gestureAt !== null &&
    now >= gestureAt &&
    now - gestureAt < AUTOPLAY_WINDOW_MS
  );
}
