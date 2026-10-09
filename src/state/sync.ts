/**
 * What tabs of the same origin tell each other about the library: a work was
 * stored or changed, a work was really deleted. A BroadcastChannel where the
 * browser has one, otherwise a localStorage key and the `storage` event
 * (which fires in every OTHER same-origin document — exactly what is needed).
 * Never throws; a tab that cannot talk simply behaves as before.
 */
export interface SyncMessage {
  /**
   * saved    a record was written (new, changed or put back)
   * deleted  a record is gone for good (the undo window is over)
   */
  type: "saved" | "deleted";
  id: string;
}

export interface TabSync {
  /** Tell the other tabs. The sender does not hear its own message. */
  post(message: SyncMessage): void;
  /** Returns the function that stops listening. */
  subscribe(listener: (message: SyncMessage) => void): () => void;
}

export const SYNC_CHANNEL = "muse-bgm";
export const SYNC_KEY = "muse-bgm:sync";

/** Anything received becomes a valid message or nothing. */
export function parseSyncMessage(value: unknown): SyncMessage | null {
  let source = value;
  if (typeof source === "string") {
    if (source.length > 1000) return null;
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source))
    return null;
  const { type, id } = source as Record<string, unknown>;
  if (type !== "saved" && type !== "deleted") return null;
  if (typeof id !== "string" || !id || id.length > 120) return null;
  return { type, id };
}

export const NO_SYNC: TabSync = {
  post() {},
  subscribe: () => () => {},
};

interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

interface StorageEventLike {
  key: string | null;
  newValue: string | null;
}

export interface SyncEnvironment {
  /** e.g. () => new BroadcastChannel(name); undefined or throwing = unavailable */
  channel?: (name: string) => ChannelLike;
  /** localStorage of the window, for the fallback */
  storage?: () => { setItem(key: string, value: string): void } | undefined;
  /** window.addEventListener("storage", …) for the fallback */
  onStorage?: (listener: (event: StorageEventLike) => void) => () => void;
}

export function createTabSync(environment: SyncEnvironment): TabSync {
  let channel: ChannelLike | null = null;
  try {
    channel = environment.channel?.(SYNC_CHANNEL) ?? null;
  } catch {
    channel = null;
  }
  if (channel) {
    const open = channel;
    return {
      post(message) {
        try {
          open.postMessage(message);
        } catch {
          /* closed or detached: nobody to tell */
        }
      },
      subscribe(listener) {
        const onMessage = (event: { data: unknown }) => {
          const message = parseSyncMessage(event.data);
          if (message) listener(message);
        };
        open.addEventListener("message", onMessage);
        return () => open.removeEventListener("message", onMessage);
      },
    };
  }
  if (!environment.storage || !environment.onStorage) return NO_SYNC;
  const { storage, onStorage } = environment;
  let counter = 0;
  return {
    post(message) {
      try {
        // The stamp makes two equal messages in a row two changes of the key.
        storage()?.setItem(
          SYNC_KEY,
          JSON.stringify({ ...message, stamp: `${Date.now()}-${++counter}` }),
        );
      } catch {
        /* storage refused: nobody to tell */
      }
    },
    subscribe(listener) {
      return onStorage((event) => {
        if (event.key !== SYNC_KEY || !event.newValue) return;
        const message = parseSyncMessage(event.newValue);
        if (message) listener(message);
      });
    },
  };
}

/** The channel of this window. */
export function browserSync(): TabSync {
  if (typeof window === "undefined") return NO_SYNC;
  return createTabSync({
    channel:
      typeof BroadcastChannel === "function"
        ? (name) => new BroadcastChannel(name)
        : undefined,
    storage: () => {
      try {
        return window.localStorage;
      } catch {
        return undefined;
      }
    },
    onStorage: (listener) => {
      window.addEventListener("storage", listener);
      return () => window.removeEventListener("storage", listener);
    },
  });
}
