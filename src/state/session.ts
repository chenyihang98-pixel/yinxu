/**
 * The little that is remembered between launches: which work was open, what
 * was typed in the composer, which producer the user prefers — and what the
 * page still owed when it went away: deletions inside their undo window,
 * fader moves that were not written yet, inspector edits and words that were
 * never applied or sent, and how to file a paid result that still has to be
 * fetched. Lives in localStorage (a synchronous write, so it survives the
 * page going away, which a database write started during teardown does not);
 * every access is guarded because private modes and sandboxed frames may
 * refuse it. Nothing here is required for the app to work.
 *
 * The key is shared by every tab of the origin. The hints (last work, text,
 * producer) are simply last-writer-wins; the "owed" lists are merged by the
 * kernel on every write, so one tab never drops what another one noted.
 *
 * Everything read from it is treated as untrusted: a note that cannot be read
 * in full is ignored — never repaired into something that gets carried out.
 */
import type { AgentTurn, BrainKind } from "../agent/types";
import { LIMITS } from "../music/catalog";
import { clampConfig } from "../music/defaults";
import { TRACKS } from "../music/score";
import type { CloudProvider, MusicConfig, TrackName } from "../types";
import { cleanDraftPatch, clip } from "./logic";
import type { Draft } from "./types";

export const SESSION_KEY = "muse-bgm:session";

/** A soft-deleted work that is not really deleted yet. */
export interface PendingRemovalNote {
  id: string;
  /**
   * Epoch milliseconds from which any tab may carry the deletion out. While
   * the undo window is open this is its end; a page that goes away sets it
   * to "now", because nobody can undo any more.
   */
  expiresAt: number;
}

/** Fader positions that were set but may not have reached the library. */
export interface PendingMixNote {
  id: string;
  volumes: Partial<Record<TrackName, number>>;
  /** epoch milliseconds of the change */
  at: number;
}

/**
 * What the user left unfinished on a work: inspector edits that were not
 * applied, and words typed for the producer that were not sent.
 */
export interface ParkedNote {
  id: string;
  draft?: Partial<Draft>;
  text?: string;
}

/**
 * A cloud request as it was planned, reduced to what can be written down:
 * enough to file its result as a work when the file finally arrives — also
 * after the page was reloaded in between.
 */
export interface PendingOrderDetail {
  title: string;
  config: MusicConfig;
  /** the producer's answer as the thread will show it */
  reply: string;
  reasoning: string[];
  tags: string[];
  brain: BrainKind;
  /** the model's own words, when a language model planned it */
  modelNote?: string;
  /** the exact prompt that was sent */
  prompt: string;
  /** the music model that was asked */
  model?: string;
  /** the work the request refines; absent for a new piece */
  baseId?: string;
  /** the user's side of the request */
  mine: AgentTurn;
  /** model id that planned it / why the offline rules answered instead */
  planModel?: string;
  fallbackReason?: string;
  /** a direct control (应用调整 / 换一版) rather than a message */
  direct: boolean;
  /** composer text that was handed back when the download failed */
  typed?: string;
  /** why the file did not arrive, as the main process put it */
  reason: string;
}

/** The paid result that still has to be fetched, or that was given up. */
export interface PendingOrderNote {
  provider: CloudProvider;
  /** the user gave this result up: it is not offered again */
  discarded?: boolean;
  order?: PendingOrderDetail;
}

export interface Session {
  lastProjectId: string | null;
  composerText: string;
  brain: BrainKind;
  pendingRemovals: PendingRemovalNote[];
  pendingMixes: PendingMixNote[];
  parked: ParkedNote[];
  pendingOrder: PendingOrderNote | null;
}

export const EMPTY_SESSION: Session = {
  lastProjectId: null,
  composerText: "",
  brain: "rules",
  pendingRemovals: [],
  pendingMixes: [],
  parked: [],
  pendingOrder: null,
};

const MAX_ID_CHARS = 120;
const MAX_PENDING = 50;
/** Works whose unfinished edits are remembered; the most recent ones stay. */
export const MAX_PARKED = 24;
/** A stored session larger than this was not written by this app. */
const MAX_SESSION_CHARS = 400_000;
/** The largest time a Date can hold. */
const MAX_DATE_MS = 8.64e15;
/**
 * A note dated later than this from now was not written by this app (its
 * own notes are dated "now", or a few seconds ahead for an undo window).
 */
const MAX_AHEAD_MS = 24 * 3600 * 1000;

const CLOUD: readonly CloudProvider[] = [
  "tencent",
  "volcengine",
  "aliyun",
  "elevenlabs",
];

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;

/** A moment this app could have written down: a real time, not in the future. */
const isTime = (value: unknown, now: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_DATE_MS &&
  value <= now + MAX_AHEAD_MS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const empty = (): Session => ({
  ...EMPTY_SESSION,
  pendingRemovals: [],
  pendingMixes: [],
  parked: [],
});

/** The part of Storage that is used; a Map-backed fake satisfies it in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Deletions to finish. A bare id is the v0.3.0 form: due at the next start.
 * Anything else must say when it is due, readably — a note whose time cannot
 * be read is dropped, because the only thing it could be turned into is a
 * deletion nobody is known to have asked for.
 */
function parseRemovals(value: unknown, now: number): PendingRemovalNote[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, PendingRemovalNote>();
  for (const item of value) {
    if (isId(item)) byId.set(item, { id: item, expiresAt: 0 });
    else if (isRecord(item)) {
      const { id, expiresAt } = item;
      if (isId(id) && isTime(expiresAt, now)) byId.set(id, { id, expiresAt });
    }
  }
  return [...byId.values()].slice(0, MAX_PENDING);
}

function parseVolumes(value: unknown): Partial<Record<TrackName, number>> {
  const result: Partial<Record<TrackName, number>> = {};
  if (!isRecord(value)) return result;
  for (const track of TRACKS) {
    const level = value[track];
    if (typeof level === "number" && Number.isFinite(level))
      result[track] = Math.max(0, Math.min(1, level));
  }
  return result;
}

function parseMixes(value: unknown, now: number): PendingMixNote[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, PendingMixNote>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { id, volumes, at } = item;
    const levels = parseVolumes(volumes);
    if (isId(id) && isTime(at, now) && Object.keys(levels).length)
      byId.set(id, { id, volumes: levels, at });
  }
  return [...byId.values()].slice(0, MAX_PENDING);
}

function parseParked(value: unknown): ParkedNote[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, ParkedNote>();
  for (const item of value) {
    if (!isRecord(item) || !isId(item.id)) continue;
    const draft = cleanDraftPatch(item.draft);
    const text =
      typeof item.text === "string" ? clip(item.text, LIMITS.promptChars) : "";
    if (!Object.keys(draft).length && !text.trim()) continue;
    // a later entry for the same work replaces the earlier one, at the end
    byId.delete(item.id);
    byId.set(item.id, {
      id: item.id,
      ...(Object.keys(draft).length ? { draft } : {}),
      ...(text.trim() ? { text } : {}),
    });
  }
  return [...byId.values()].slice(-MAX_PARKED);
}

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" ? clip(value, max) : null;

const lines = (value: unknown, count: number, max: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => clip(item.trim(), max))
        .filter(Boolean)
        .slice(0, count)
    : [];

function parseOrderDetail(
  value: unknown,
  now: number,
): PendingOrderDetail | undefined {
  if (!isRecord(value) || !isRecord(value.config) || !isRecord(value.mine))
    return undefined;
  const title = text(value.title, 64)?.trim();
  const reply = text(value.reply, 1500);
  const prompt = text(value.prompt, 4000);
  const mine = value.mine;
  const said = text(mine.text, 1500);
  const at =
    typeof mine.at === "string" && mine.at.length <= 64
      ? Date.parse(mine.at)
      : NaN;
  if (
    !title ||
    reply === null ||
    prompt === null ||
    !isId(mine.id) ||
    said === null ||
    !isTime(at, now)
  )
    return undefined;
  const optional = (source: unknown, max: number) => {
    const read = text(source, max)?.trim();
    return read ? read : undefined;
  };
  const model = optional(value.model, 128);
  const modelNote = optional(value.modelNote, 400);
  const planModel = optional(value.planModel, 128);
  const fallbackReason = optional(value.fallbackReason, 200);
  const typed = text(value.typed, LIMITS.promptChars);
  return {
    title,
    config: clampConfig(value.config as Partial<MusicConfig>),
    reply,
    reasoning: lines(value.reasoning, 8, 160),
    tags: lines(value.tags, 12, 32),
    brain: value.brain === "llm" ? "llm" : "rules",
    ...(modelNote ? { modelNote } : {}),
    prompt,
    ...(model ? { model } : {}),
    ...(isId(value.baseId) ? { baseId: value.baseId } : {}),
    mine: {
      id: mine.id,
      role: "user",
      text: said,
      at: new Date(at).toISOString(),
    },
    ...(planModel ? { planModel } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    direct: value.direct === true,
    ...(typed ? { typed } : {}),
    reason: text(value.reason, 600) ?? "",
  };
}

function parseOrder(value: unknown, now: number): PendingOrderNote | null {
  if (!isRecord(value)) return null;
  const provider = CLOUD.find((item) => item === value.provider);
  if (!provider) return null;
  if (value.discarded === true) return { provider, discarded: true };
  const order = parseOrderDetail(value.order, now);
  return order ? { provider, order } : { provider };
}

/** Anything stored (or tampered with) becomes a valid Session. */
export function parseSession(raw: unknown, now: number = Date.now()): Session {
  if (typeof raw !== "string" || !raw || raw.length > MAX_SESSION_CHARS)
    return empty();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty();
  }
  if (!isRecord(value)) return empty();
  const id = value.lastProjectId;
  const typed = value.composerText;
  return {
    lastProjectId: isId(id) ? id : null,
    composerText:
      typeof typed === "string" ? clip(typed, LIMITS.promptChars) : "",
    brain: value.brain === "llm" ? "llm" : "rules",
    pendingRemovals: parseRemovals(value.pendingRemovals, now),
    pendingMixes: parseMixes(value.pendingMixes, now),
    parked: parseParked(value.parked),
    pendingOrder: parseOrder(value.pendingOrder, now),
  };
}

export function serializeSession(
  session: Session,
  now: number = Date.now(),
): string {
  return JSON.stringify({
    lastProjectId: session.lastProjectId,
    composerText: clip(session.composerText, LIMITS.promptChars),
    brain: session.brain,
    pendingRemovals: parseRemovals(session.pendingRemovals, now),
    pendingMixes: parseMixes(session.pendingMixes, now),
    parked: parseParked(session.parked),
    pendingOrder: parseOrder(session.pendingOrder, now),
  });
}

export interface SessionStore {
  read(): Session;
  /** Never throws; a refused write is simply not remembered. */
  write(session: Session): void;
}

export function createSessionStore(
  storage: () => KeyValueStore | undefined,
): SessionStore {
  return {
    read() {
      try {
        return parseSession(storage()?.getItem(SESSION_KEY));
      } catch {
        return empty();
      }
    },
    write(session) {
      try {
        storage()?.setItem(SESSION_KEY, serializeSession(session));
      } catch {
        /* quota, private mode, sandboxed frame: not remembered */
      }
    },
  };
}

/** localStorage of this window, when there is one and it may be used. */
export const browserSession: SessionStore = createSessionStore(() => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
});
