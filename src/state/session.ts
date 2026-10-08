/**
 * The little that is remembered between launches: which work was open, what
 * was typed in the composer, which producer the user prefers, and which
 * deletions were still inside their undo window. Lives in localStorage (a
 * synchronous write, so it survives the page going away); every access is
 * guarded because private modes and sandboxed frames may refuse it. Nothing
 * here is required for the app to work.
 */
import type { BrainKind } from "../agent/types";
import { LIMITS } from "../music/catalog";
import { clip } from "./logic";

export const SESSION_KEY = "muse-bgm:session";

export interface Session {
  lastProjectId: string | null;
  composerText: string;
  brain: BrainKind;
  /**
   * Works the user deleted whose undo window was still open at the last
   * write. If the page went away before the record was really deleted, the
   * next launch finishes the job.
   */
  pendingRemovals: string[];
}

export const EMPTY_SESSION: Session = {
  lastProjectId: null,
  composerText: "",
  brain: "rules",
  pendingRemovals: [],
};

const MAX_ID_CHARS = 120;
const MAX_PENDING_REMOVALS = 50;

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;

const empty = (): Session => ({ ...EMPTY_SESSION, pendingRemovals: [] });

/** The part of Storage that is used; a Map-backed fake satisfies it in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Anything stored (or tampered with) becomes a valid Session. */
export function parseSession(raw: unknown): Session {
  if (typeof raw !== "string" || !raw || raw.length > 20_000) return empty();
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
  const pending = source.pendingRemovals;
  return {
    lastProjectId: isId(id) ? id : null,
    composerText:
      typeof text === "string" ? clip(text, LIMITS.promptChars) : "",
    brain: source.brain === "llm" ? "llm" : "rules",
    pendingRemovals: Array.isArray(pending)
      ? [...new Set(pending.filter(isId))].slice(0, MAX_PENDING_REMOVALS)
      : [],
  };
}

export function serializeSession(session: Session): string {
  return JSON.stringify({
    lastProjectId: session.lastProjectId,
    composerText: clip(session.composerText, LIMITS.promptChars),
    brain: session.brain,
    pendingRemovals: (session.pendingRemovals ?? [])
      .filter(isId)
      .slice(0, MAX_PENDING_REMOVALS),
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
