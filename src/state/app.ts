/**
 * The real app core: the browser's storage, audio engine, clock and (on
 * desktop) the Electron bridge. Tests build their own AppCore with fakes.
 */
import { producePlan } from "../agent/brain";
import {
  computePeaks,
  encodeWav,
  mixStems,
  mixdownInWorker,
  renderMusic,
} from "../audio/engine";
import { randomSeed } from "../music/defaults";
import { TRACKS } from "../music/score";
import { desktop, newId, openExternal, platform, saveFile } from "../platform";
import { decodeAudio, normalisePeaks } from "../services/generation";
import {
  deleteProject,
  exportProject,
  importProject,
  listProjects,
  readProject,
  readRawAudio,
  readRawRecord,
  requestPersistence,
  saveProject,
  storageInfo,
  updateProject,
} from "../storage";
import { AppCore } from "./core";
import type { CoreDeps } from "./ports";
import { clampVolume } from "./logic";
import { browserSession } from "./session";
import { browserSync } from "./sync";

/**
 * Resolves once the browser has had the chance to paint what was just
 * rendered. A hidden page gets no animation frames, so it never waits long.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    globalThis.setTimeout(finish, 100);
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => globalThis.setTimeout(finish, 0));
    else globalThis.setTimeout(finish, 0);
  });
}

export function browserDeps(): CoreDeps {
  return {
    platform,
    desktop,
    storage: {
      listProjects,
      saveProject,
      updateProject,
      readProject,
      deleteProject,
      readRawRecord,
      readRawAudio,
      importProject,
      storageInfo,
      requestPersistence,
    },
    renderMusic,
    decode: decodeAudio,
    stemsOutline: (audio, volumes) =>
      normalisePeaks(
        computePeaks(
          TRACKS.map((track) => ({
            buffer: audio.stems[track],
            gain: clampVolume(volumes[track]),
          })),
        ),
      ),
    producePlan,
    exporter: {
      mixStems,
      encodeWav,
      mixdown: mixdownInWorker,
      saveFile,
      exportProject,
      breathe: nextPaint,
    },
    openExternal,
    newId,
    randomSeed,
    now: () => Date.now(),
    timers: {
      set: (callback, ms) => globalThis.setTimeout(callback, ms),
      clear: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    session: browserSession,
    sync: browserSync(),
  };
}

/**
 * One core for the page. It lives outside React so that it survives
 * StrictMode remounts and so the root ErrorBoundary can still export the
 * current work after the component tree has failed.
 */
export const appCore = new AppCore(browserDeps());
