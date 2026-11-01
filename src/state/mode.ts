/**
 * Which interface the user prefers: 简单模式 (the default — scenes, one-tap
 * buttons, no words a musician would use) or 专业模式 (the complete v0.3
 * studio). Both are views of the same app core; nothing else depends on it.
 *
 * Remembered on this device (localStorage `muse-bgm:mode`). Every access is
 * guarded: a private window or a sandboxed frame may refuse storage, and then
 * the app simply starts in 简单模式. No React.
 */

export type UiMode = "simple" | "pro";

export const MODE_KEY = "muse-bgm:mode";

/** Anything but the exact word "pro" is 简单模式. */
export function parseMode(value: unknown): UiMode {
  return value === "pro" ? "pro" : "simple";
}

export interface ModeStore {
  read(): UiMode;
  write(mode: UiMode): void;
}

/** A store over any Storage-like object; `storage()` may throw or be undefined. */
export function createModeStore(
  storage: () => Pick<Storage, "getItem" | "setItem"> | undefined,
): ModeStore {
  return {
    read() {
      try {
        return parseMode(storage()?.getItem(MODE_KEY));
      } catch {
        return "simple";
      }
    },
    write(mode) {
      try {
        storage()?.setItem(MODE_KEY, parseMode(mode));
      } catch {
        /* not remembered: the next start is 简单模式 again */
      }
    },
  };
}

/** For tests and stand-ins: remembered in memory only. */
export function memoryModeStore(initial: UiMode = "simple"): ModeStore & {
  value: UiMode;
} {
  const store = {
    value: parseMode(initial),
    read: () => store.value,
    write: (mode: UiMode) => {
      store.value = parseMode(mode);
    },
  };
  return store;
}

export const browserModeStore: ModeStore = createModeStore(() => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
});
