/// <reference path="./env.d.ts" />
/**
 * Desktop / web adapter — the only module that touches `window.museDesktop`.
 * Everything else asks `platform` what is possible and calls the helpers here.
 */
import type { AudioFormat, DesktopAPI } from "./types";

export const DOWNLOAD_URL = "https://starwright.xyz/tools/yinxu/#download";

export type FileFormat = AudioFormat | "json";

export interface Platform {
  /** running inside the Electron app with a working bridge */
  readonly isDesktop: boolean;
  /** running as a web page (web build, or the desktop build in a browser) */
  readonly isWeb: boolean;
  /** running inside an iframe */
  readonly isEmbedded: boolean;
  readonly version: string;
  /** cloud music services are reachable (desktop main process only) */
  readonly canUseCloud: boolean;
  /** the producer agent can call an LLM (desktop main process only) */
  readonly canUseLlm: boolean;
  /** where web visitors get the Windows app */
  readonly downloadUrl: string;
}

const MIME: Record<FileFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  json: "application/json",
};
const FALLBACK_NAME = "Muse-BGM";
/** Long enough for a slow browser to start reading a large WAV. */
const REVOKE_DELAY_MS = 60_000;

function isEmbedded(host: unknown): boolean {
  if (!host) return false;
  try {
    const frame = host as { self?: unknown; top?: unknown };
    return frame.self !== frame.top;
  } catch {
    // Reading `top` can throw in a sandboxed frame: that is still a frame.
    return true;
  }
}

function findBridge(web: boolean, host: unknown): DesktopAPI | undefined {
  // The web build never trusts an object that is merely called museDesktop.
  if (web || !host) return undefined;
  let candidate: unknown;
  try {
    candidate = (host as { museDesktop?: unknown }).museDesktop;
  } catch {
    return undefined;
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const bridge = candidate as Partial<Record<keyof DesktopAPI, unknown>>;
  return typeof bridge.getSettings === "function" &&
    typeof bridge.saveAudio === "function" &&
    typeof bridge.openExternal === "function"
    ? (candidate as DesktopAPI)
    : undefined;
}

/** Pure detection, exported so tests can describe every environment. */
export function createPlatform(environment: {
  web: boolean;
  version: string;
  host: unknown;
}): { desktop: DesktopAPI | undefined; platform: Platform } {
  const bridge = findBridge(environment.web, environment.host);
  const has = (method: keyof DesktopAPI) =>
    !!bridge && typeof bridge[method] === "function";
  return {
    desktop: bridge,
    platform: Object.freeze({
      isDesktop: !!bridge,
      isWeb: !bridge,
      isEmbedded: isEmbedded(environment.host),
      version: environment.version || "dev",
      canUseCloud: has("generateMusic"),
      canUseLlm: has("agentPlan"),
      downloadUrl: DOWNLOAD_URL,
    }),
  };
}

const detected = createPlatform({
  web: typeof __MUSE_WEB__ !== "undefined" && __MUSE_WEB__ === true,
  version: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev",
  host: typeof window === "undefined" ? undefined : window,
});

/** The Electron bridge, or undefined on the web. */
export const desktop: DesktopAPI | undefined = detected.desktop;
export const platform: Platform = detected.platform;

/**
 * A file name that is valid on Windows, macOS and Linux. Mirrors safeFilename
 * in electron/music-service.cjs so both targets name files the same way.
 */
export function safeFileName(name: unknown, format: FileFormat): string {
  let base = typeof name === "string" ? name.normalize("NFKC") : "";
  base = base
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/\.(wav|mp3|m4a|flac|json)$/i, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 100)
    .replace(/[\ud800-\udbff]$/, "")
    .trim();
  if (!base || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(base))
    base = FALLBACK_NAME;
  return `${base}.${format}`;
}

/**
 * Hand a finished file to the user. Desktop: native save dialog (saved is
 * false when the dialog is cancelled). Web: a download; saved is true once the
 * browser was asked to download — the page cannot observe what happens next.
 */
export async function saveFile(input: {
  name: string;
  data: ArrayBuffer;
  format: FileFormat;
}): Promise<{ saved: boolean; path?: string }> {
  const { name, data, format } = input;
  if (!Object.hasOwn(MIME, format)) throw new Error("不支持的导出格式。");
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0)
    throw new Error("导出数据为空，请重新生成后再试。");
  if (desktop) {
    const result = await desktop.saveAudio({ name, data, format });
    return result?.saved
      ? {
          saved: true,
          ...(typeof result.path === "string" ? { path: result.path } : {}),
        }
      : { saved: false };
  }
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  )
    return { saved: false };
  const url = URL.createObjectURL(new Blob([data], { type: MIME[format] }));
  let clicked = false;
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeFileName(name, format);
    anchor.rel = "noopener";
    anchor.style.display = "none";
    // Older Firefox only honours a programmatic click on a connected element.
    document.body.appendChild(anchor);
    anchor.click();
    clicked = true;
  } catch {
    /* reported through saved: false */
  } finally {
    anchor?.remove();
    // Revoking at once would cancel the download in some browsers.
    if (clicked) setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    else URL.revokeObjectURL(url);
  }
  return { saved: clicked };
}

/**
 * Open a web page outside the app. Never throws; resolves false when the link
 * was refused (desktop: not on the main process allow-list; web: not http(s)
 * or no window). Callers may ignore the result.
 */
export function openExternal(url: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:")
    return Promise.resolve(false);
  if (desktop) {
    try {
      // The main process compares against an allow-list of exact strings, so
      // pass the caller's spelling rather than the normalised href.
      return desktop.openExternal(url).then(
        () => true,
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  }
  if (typeof window === "undefined" || typeof window.open !== "function")
    return Promise.resolve(false);
  try {
    // With "noopener" the return value is always null, so it says nothing.
    window.open(target.href, "_blank", "noopener,noreferrer");
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/**
 * A new UUID v4. `crypto.randomUUID` only exists in secure contexts, so plain
 * http pages (a LAN preview on a phone) fall back to getRandomValues.
 */
export function newId(): string {
  const source: Crypto | undefined = globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function")
    source.getRandomValues(bytes);
  else
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  return uuidFromBytes(bytes);
}
