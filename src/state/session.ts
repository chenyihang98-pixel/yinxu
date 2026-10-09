/**
 * The little that is remembered between launches: which work was open, what
 * was typed in the composer, which producer the user prefers — and what the
 * page still owed the library when it went away: deletions inside their undo
 * window and fader moves that were not written yet. Lives in localStorage (a
 * synchronous write, so it survives the page going away, which a database
 * write started during teardown does not); every access is guarded because
 * private modes and sandboxed frames may refuse it. Nothing here is required
 * for the app to work.
 *
 * The key is shared by every tab of the origin. The hints (last work, text,
 * producer) are simply last-writer-wins; the two "owed" lists are merged by
 * the kernel on every write, so one tab never drops what another one noted.
 */
import type { BrainKind } from "../agent/types";
import { LIMITS } from "../music/catalog";
import { TRACKS } from "../music/score";
import type { TrackName } from "../types";
import { clip } from "./logic";

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

export interface Session {
  lastProjectId: string | null;
  composerText: string;
  brain: BrainKind;
  pendingRemovals: PendingRemovalNote[];
  pendingMixes: PendingMixNote[];
}

export const EMPTY_SESSION: Session = {
  lastProjectId: null,
  composerText: "",
  brain: "rules",
  pendingRemovals: [],
  pendingMixes: [],
};

const MAX_ID_CHARS = 120;
const MAX_PENDING = 50;

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const empty = (): Session => ({
  ...EMPTY_SESSION,
  pendingRemovals: [],
  pendingMixes: [],
});

/** The part of Storage that is used; a Map-backed fake satisfies it in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function parseRemovals(value: unknown): PendingRemovalNote[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, PendingRemovalNote>();
  for (const item of value) {
    // v0.3.0 wrote bare ids: a deletion to finish at the next start.
    if (isId(item)) byId.set(item, { id: item, expiresAt: 0 });
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const { id, expiresAt } = item as Record<string, unknown>;
      if (isId(id))
        byId.set(id, { id, expiresAt: isTime(expiresAt) ? expiresAt : 0 });
    }
  }
  return [...byId.values()].slice(0, MAX_PENDING);
}

function parseVolumes(value: unknown): Partial<Record<TrackName, number>> {
  const result: Partial<Record<TrackName, number>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;
  for (const track of TRACKS) {
    const level = (value as Record<string, unknown>)[track];
    if (typeof level === "number" && Number.isFinite(level))
      result[track] = Math.max(0, Math.min(1, level));
  }
  return result;
}

function parseMixes(value: unknown): PendingMixNote[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, PendingMixNote>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { id, volumes, at } = item as Record<string, unknown>;
    const levels = parseVolumes(volumes);
    if (isId(id) && isTime(at) && Object.keys(levels).length)
      byId.set(id, { id, volumes: levels, at });
  }
  return [...byId.values()].slice(0, MAX_PENDING);
}

/** Anything stored (or tampered with) becomes a valid Session. */
export function parseSession(raw: unknown): Session {
  if (typeof raw !== "string" || !raw || raw.length > 40_000) return empty();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty();
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return empty();
  const source = value as Record<string, unknown>;
  const id = source.lastProjectId;
  const text = source.composerText;
  return {
    lastProjectId: isId(id) ? id : null,
    composerText:
      typeof text === "string" ? clip(text, LIMITS.promptChars) : "",
    brain: source.brain === "llm" ? "llm" : "rules",
    pendingRemovals: parseRemovals(source.pendingRemovals),
    pendingMixes: parseMixes(source.pendingMixes),
  };
}

export function serializeSession(session: Session): string {
  return JSON.stringify({
    lastProjectId: session.lastProjectId,
    composerText: clip(session.composerText, LIMITS.promptChars),
    brain: session.brain,
    pendingRemovals: parseRemovals(session.pendingRemovals),
    pendingMixes: parseMixes(session.pendingMixes),
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
