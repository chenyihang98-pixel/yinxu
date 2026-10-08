/**
 * Decisions of the app core as pure functions: no React, no timers, no
 * storage, no audio. Everything here runs under Node and is unit-tested.
 */
import type { AgentPlan, AgentTurn } from "../agent/types";
import { LIMITS, isInstrumentId, isKey, isStyleId } from "../music/catalog";
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
 * A message that is safe to show: Chinese text from our own code or the main
 * process, without IPC or exception prefixes. Anything else (an English
 * exception, an object) becomes `fallback`.
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
    ? clip(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim(), LIMITS.promptChars)
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
      committed && committed.mood === cleaned ? committed : stylePreset(cleaned);
    for (const preset of PRESET_FIELDS)
      if (!touched.includes(preset))
        draft = withField(draft, preset, source[preset]);
  }
  return { draft, touched };
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

/** The producer's answer as a stored turn. `revision` only when a version was made. */
export function agentTurn(
  id: string,
  at: string,
  plan: Pick<AgentPlan, "reply" | "reasoning" | "brain">,
  options: { revision?: number; direct?: boolean } = {},
): AgentTurn {
  const reasoning = plan.reasoning
    .map((line) => clip(line.trim(), 160))
    .filter(Boolean)
    .slice(0, 8);
  return {
    id,
    role: "agent",
    text: clip(plan.reply, 1500),
    at,
    ...(reasoning.length ? { reasoning } : {}),
    // Direct controls (应用调整 / 换一版旋律) are not a brain's answer.
    ...(options.direct ? {} : { brain: plan.brain }),
    ...(options.revision !== undefined ? { revision: options.revision } : {}),
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
    revision: nextRevision(base),
    tags,
    ...(input.audioBlob ? { audioBlob: input.audioBlob } : {}),
    ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0
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

export function shouldAutoplay(
  gestureAt: number | null,
  now: number,
): boolean {
  return (
    gestureAt !== null &&
    now >= gestureAt &&
    now - gestureAt < AUTOPLAY_WINDOW_MS
  );
}
