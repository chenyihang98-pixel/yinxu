/**
 * Engine facade — the only audio entry point the UI uses.
 *   config.engine === 1 → frozen v0.2 synthesizer (old works sound the same)
 *   config.engine === 2 → compose() a Score, then renderScore() it
 *
 * Engine-2 renders run in ONE warm Web Worker (worker.ts) so the UI thread
 * stays free; where a worker cannot be had (no Worker global, a CSP or
 * file:// refusal, a worker that dies before its first message) the same job
 * runs on the calling thread in small slices instead, and the engine
 * remembers that for the rest of the session.
 *
 * A worker that is merely slow to start is another matter: its script may be
 * coming down a slow line. A render asked for meanwhile waits for it for about
 * a second (reported as the "starting" phase), then runs on the calling
 * thread; the worker is left to come up and serves the renders after that.
 *
 * Renders never overlap: the voices keep module state and are not
 * re-entrant, so every render — worker, in-thread or legacy — waits its turn
 * in one queue. Cancelling a queued render just drops it; cancelling the
 * running one terminates the worker (a fresh one is started lazily) or stops
 * the in-thread job at its next checkpoint.
 *
 * The same worker also builds WAV exports (mixdownInWorker): the samples are
 * copied out a channel at a time and mixed, clipped and encoded over there, so
 * an export of two minutes no longer stalls the page. Without an idle worker
 * the caller runs mixStems + encodeWav here instead; the bytes are the same.
 *
 * A render that fails rejects with an EngineError (engine-error.ts): a code, a
 * sentence for the user, and the exception text kept apart for the log.
 */
import type { MusicConfig, RenderResult, TrackName } from "../types";
import { TRACKS } from "../music/score";
import { renderMusic as renderLegacy } from "./engine-v1";
import { EngineError, describeFailure, engineFailure } from "./engine-error";
import { addScaled, finishMix } from "./mixdown";
import { freeBuffer } from "./render";
import type {
  MixdownJob,
  RenderDiagnostics,
  RenderJobResult,
  RenderedAudio,
  WorkerRequest,
  WorkerResponse,
} from "./render-types";
import { renderJob } from "./worker";

export { fadeChannels } from "./mixdown";
export { encodeWav } from "./wav";
export { REFERENCE_VOLUMES } from "./render-types";
export { EngineError, ENGINE_ERROR_TEXT } from "./engine-error";
export type { EngineErrorCode } from "./engine-error";
export type { MasterDiagnostics, RenderDiagnostics } from "./render-types";

/**
 * What a render is doing before its first progress: "starting" while it waits
 * for the render worker to come up, "rendering" once the music is being made
 * (in the worker or on the calling thread).
 */
export type RenderPhase = "starting" | "rendering";

export interface RenderOptions {
  /** 0..1, never backwards, at most about 20 times a second; ends with exactly 1 */
  onProgress?: (fraction: number) => void;
  /**
   * Called when the phase changes, "rendering" always and before the first
   * progress above 0. "starting" comes first only when the render really has
   * to wait for the worker (a first visit on a slow connection): show it
   * instead of a bar that stands at 0 %. It lasts at most the start-up time.
   */
  onPhase?: (phase: RenderPhase) => void;
  /** abort to cancel; renderMusic then rejects with an AbortError */
  signal?: AbortSignal;
}

/** RenderResult plus what the engine can tell about the render. */
export interface EngineRenderResult extends RenderResult {
  diagnostics: RenderDiagnostics;
}

/** The part of the Worker interface the engine uses. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
}

export interface EngineOptions {
  /** false keeps every render on the calling thread */
  worker?: boolean;
  /** how the render worker is made (tests; the default starts worker.ts as a module worker) */
  createWorker?: (() => WorkerLike) | null;
  /**
   * Milliseconds after its start during which renders wait for a worker that
   * has not posted its first message yet (default 1000). After that they run
   * on the calling thread; the worker is not given up on, and takes over as
   * soon as it is up.
   */
  startupTimeoutMs?: number;
  /** milliseconds the worker has to answer an export mixdown before the export is built on the calling thread */
  mixdownTimeoutMs?: number;
}

export interface EngineStatus {
  /**
   * "idle": no worker yet (one is started on demand) · "starting": started,
   * nothing heard yet (renders wait for it for the start-up time, then run on
   * the calling thread until it is up) · "ready": a warm worker is waiting ·
   * "unavailable": workers do not work here, renders run on the calling thread
   */
  worker: "idle" | "starting" | "ready" | "unavailable";
  /** renders waiting or running */
  pending: number;
}

const PEAK_BINS = 140;
/** Milliseconds between two onProgress calls. */
const PROGRESS_INTERVAL_MS = 50;
/** Milliseconds of synthesis between two yields when rendering on the calling thread. */
const IN_THREAD_PACE_MS = 12;
/** Share of the progress bar that belongs to the render job; the rest is handing the audio to the UI. */
const JOB_SHARE = 0.97;
/**
 * How long after its start a worker is waited for. From disk or from the
 * cache it is up in a tenth of that; if it is not, a bar at 0 % for longer
 * than this is worse than a render on the calling thread.
 */
const STARTUP_TIMEOUT_MS = 1000;
/** Two minutes of audio are mixed and encoded in well under a second. */
const MIXDOWN_TIMEOUT_MS = 20_000;
/** A worker that dies this many times in a row mid-render is not started again. */
const MAX_CRASHES = 2;

function abortError(): DOMException {
  return new DOMException("已取消生成", "AbortError");
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/** Let the event loop run one turn (paint, input, timers) before going on. */
const breathe: () => Promise<void> = (() => {
  // a MessageChannel hop is not clamped to 4 ms the way nested timers are;
  // outside a page (Node) a pending port would keep the process alive
  if (typeof document !== "undefined" && typeof MessageChannel === "function") {
    const channel = new MessageChannel();
    const waiting: (() => void)[] = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    return () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        channel.port2.postMessage(0);
      });
  }
  return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
})();

/* ------------------------------------------------------------------ */
/* waveform outlines                                                   */
/* ------------------------------------------------------------------ */

/** Normalised 0..1 waveform outline of one or more stereo buffers summed with gains. */
export function computePeaks(
  buffers: { buffer: AudioBuffer; gain: number }[],
  bins = PEAK_BINS,
): number[] {
  const count = Math.max(1, Math.floor(bins));
  const result = new Array<number>(count).fill(0);
  const length = buffers[0]?.buffer.length ?? 0;
  if (!length) return result;
  const channels = buffers
    .filter((entry) => entry.gain > 0)
    .map((entry) => ({
      left: entry.buffer.getChannelData(0),
      right: entry.buffer.getChannelData(
        Math.min(1, entry.buffer.numberOfChannels - 1),
      ),
      gain: entry.gain,
    }));
  for (let bin = 0; bin < count; bin++) {
    const start = Math.floor((bin * length) / count);
    const end = Math.floor(((bin + 1) * length) / count);
    const step = Math.max(1, Math.floor((end - start) / 160));
    let peak = 0;
    for (let i = start; i < end; i += step) {
      let left = 0;
      let right = 0;
      for (const channel of channels) {
        left += channel.left[i] * channel.gain;
        right += channel.right[i] * channel.gain;
      }
      peak = Math.max(peak, Math.abs(left), Math.abs(right));
    }
    result[bin] = peak;
  }
  return result;
}

function normalise(peaks: number[], reference?: number): number[] {
  const max = Math.max(reference ?? 0, ...peaks, 0.001);
  return peaks.map((value) => value / max);
}

function describe(
  stems: Record<TrackName, AudioBuffer>,
  volumes: Record<TrackName, number>,
) {
  const mix = computePeaks(
    TRACKS.map((track) => ({
      buffer: stems[track],
      gain: clamp01(volumes[track]),
    })),
  );
  const raw = Object.fromEntries(
    TRACKS.map((track) => [
      track,
      computePeaks([{ buffer: stems[track], gain: 1 }], 48),
    ]),
  ) as Record<TrackName, number[]>;
  const loudest = Math.max(...TRACKS.flatMap((track) => raw[track]), 0.001);
  const stemPeaks = Object.fromEntries(
    TRACKS.map((track) => [track, normalise(raw[track], loudest)]),
  ) as Record<TrackName, number[]>;
  return { peaks: normalise(mix), stemPeaks };
}

/**
 * Rendered PCM → AudioBuffers. An AudioBuffer cannot adopt memory, so this
 * is the one copy the audio makes on the UI thread; it is done a channel at
 * a time with a breath in between (two minutes are 180 MB), and each source
 * channel is freed as soon as it has been copied.
 */
async function toAudioBuffers(
  audio: RenderedAudio,
  signal: AbortSignal | undefined,
  onChannel: (done: number, total: number) => void,
): Promise<Record<TrackName, AudioBuffer>> {
  const stems = {} as Record<TrackName, AudioBuffer>;
  const total = TRACKS.length * 2;
  let done = 0;
  for (const track of TRACKS) {
    const buffer = new AudioBuffer({
      length: Math.max(1, audio.frames),
      numberOfChannels: 2,
      sampleRate: audio.sampleRate,
    });
    const pcm = audio.stems[track] as (Float32Array | null)[];
    for (let channel = 0; channel < 2; channel++) {
      const source = pcm[channel];
      if (source) {
        buffer.getChannelData(channel).set(source);
        // 23 MB per channel of a two-minute piece: back to the system now, not at the next collection
        freeBuffer(source);
      }
      pcm[channel] = null;
      onChannel(++done, total);
      await breathe();
      if (signal?.aborted) throw abortError();
    }
    stems[track] = buffer;
  }
  return stems;
}

/* ------------------------------------------------------------------ */
/* one render at a time                                                */
/* ------------------------------------------------------------------ */

let queueTail: Promise<void> = Promise.resolve();
let pending = 0;

/**
 * Run `task` after every render queued before it. A render that is aborted
 * while it waits is rejected at once and never runs.
 */
function enqueue<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let state: "waiting" | "running" | "done" = "waiting";
    pending++;
    const settle = () => {
      if (state === "done") return false;
      state = "done";
      pending--;
      signal?.removeEventListener("abort", onAbort);
      return true;
    };
    const onAbort = () => {
      // a running task hears the signal itself and stops at its own pace
      if (state === "waiting" && settle()) reject(abortError());
    };
    signal?.addEventListener("abort", onAbort);
    const start = (): Promise<void> | void => {
      if (state !== "waiting") return;
      state = "running";
      return task().then(
        (value) => {
          if (settle()) resolve(value);
        },
        (error) => {
          if (settle()) reject(error);
        },
      );
    };
    queueTail = queueTail.then(start, start);
  });
}

/** onProgress as the UI wants it: clamped, never backwards, not too often, exactly one final 1. */
function progressReporter(
  onProgress: ((fraction: number) => void) | undefined,
): (fraction: number) => void {
  let last = -1;
  let lastTime = -Infinity;
  return (fraction) => {
    if (!onProgress) return;
    const value = clamp01(fraction);
    if (value <= last) return;
    const time = now();
    if (value < 1 && last >= 0 && time - lastTime < PROGRESS_INTERVAL_MS)
      return;
    last = value;
    lastTime = time;
    onProgress(value);
  };
}

/* ------------------------------------------------------------------ */
/* the render worker                                                   */
/* ------------------------------------------------------------------ */

interface WorkerTask {
  id: number;
  message(message: WorkerResponse): void;
  /** the worker is gone: it died in the middle of this job, or the engine was reconfigured */
  failure(detail: string): void;
}

interface Session {
  worker: WorkerLike;
  /** the worker has posted at least one message: workers do work here, and this one is up */
  spoke: boolean;
  task: WorkerTask | null;
  /** when the worker was started, on the engine's clock */
  startedAt: number;
  /** renders waiting for the first message: called with true when it comes, false when the worker is gone */
  waiting: ((up: boolean) => void)[];
}

let options: EngineOptions = {};
let session: Session | null = null;
let unavailable = false;
let crashes = 0;
let lastId = 0;

function defaultWorkerFactory(): (() => WorkerLike) | null {
  if (typeof Worker !== "function") return null;
  // this exact expression is what Vite turns into a bundled worker chunk
  return () =>
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    }) as unknown as WorkerLike;
}

function errorDetail(event: unknown): string {
  const message = (event as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message ? message : "worker error";
}

function closeSession(target: Session): void {
  target.worker.onmessage = null;
  target.worker.onerror = null;
  if ("onmessageerror" in target.worker) target.worker.onmessageerror = null;
  try {
    target.worker.terminate();
  } catch {
    // a worker that cannot be terminated is abandoned all the same
  }
  if (session === target) session = null;
  // whoever was waiting for it to come up goes on without it
  for (const resume of target.waiting.splice(0)) resume(false);
}

function failSession(target: Session, detail: string): void {
  if (session !== target) return;
  const task = target.task;
  target.task = null;
  closeSession(target);
  if (!target.spoke) {
    // an error and never a word: workers do not work here (CSP, file://, …)
    unavailable = true;
  } else if (++crashes >= MAX_CRASHES) unavailable = true;
  task?.failure(detail);
}

/** The warm worker, started on first use; null when renders must stay on this thread. */
function openSession(): Session | null {
  if (unavailable || options.worker === false) return null;
  if (session) return session;
  const create =
    options.createWorker === undefined
      ? defaultWorkerFactory()
      : options.createWorker;
  if (!create) {
    unavailable = true;
    return null;
  }
  let worker: WorkerLike;
  try {
    worker = create();
  } catch {
    unavailable = true;
    return null;
  }
  const opened: Session = {
    worker,
    spoke: false,
    task: null,
    startedAt: now(),
    waiting: [],
  };
  worker.onmessage = (event) => {
    if (session !== opened) return;
    if (!opened.spoke) {
      opened.spoke = true;
      for (const resume of opened.waiting.splice(0)) resume(true);
    }
    const message = event.data;
    if (!message || message.type === "ready") return;
    if (opened.task && message.id === opened.task.id)
      opened.task.message(message);
  };
  worker.onerror = (event) => {
    (event as { preventDefault?: () => void } | null)?.preventDefault?.();
    failSession(opened, errorDetail(event));
  };
  if ("onmessageerror" in worker)
    worker.onmessageerror = () =>
      failSession(opened, "message could not be read");
  session = opened;
  return opened;
}

/** Milliseconds left of the time a starting worker is waited for. */
function startupLeft(target: Session): number {
  return (
    target.startedAt + (options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS) - now()
  );
}

/**
 * Wait for a worker that has been started and not yet heard from. Resolves
 * with true once it has posted its first message, with false when this render
 * should not wait for it (any longer): the worker failed, or the time a worker
 * is given to start is over.
 *
 * A slow worker is NOT given up on. Its script may be 300 kB coming down a
 * slow line: the render that could not wait runs on this thread, the worker
 * goes on loading, and the next render after its first message runs there.
 */
function workerUp(
  target: Session,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (target.spoke) return Promise.resolve(true);
  const patience = startupLeft(target);
  if (!(patience > 0)) return Promise.resolve(false);
  return new Promise<boolean>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = target.waiting.indexOf(settle);
      if (index >= 0) target.waiting.splice(index, 1);
    };
    const settle = (up: boolean) => {
      done();
      resolve(up);
    };
    const onAbort = () => {
      // nothing is running yet: the worker is left to finish starting
      done();
      reject(abortError());
    };
    const timer = setTimeout(() => settle(false), patience);
    // a pending timer must not keep a Node process alive
    (timer as { unref?: () => void }).unref?.();
    target.waiting.push(settle);
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Render in the worker. Resolves with null when the job has to run on this
 * thread after all (no worker, or it is not up in time). `starting` is called
 * when the job has to wait for the worker to come up, `began` when the job
 * has been handed to it.
 */
async function renderInWorker(
  config: MusicConfig,
  report: (fraction: number) => void,
  signal: AbortSignal | undefined,
  starting: () => void,
  began: () => void,
): Promise<RenderJobResult | null> {
  const target = openSession();
  if (!target) return null;
  if (!target.spoke) {
    // past its start-up time it is not waited for: the job runs here at once
    if (!(startupLeft(target) > 0)) return null;
    starting();
    const up = await workerUp(target, signal);
    // (it may have been closed meanwhile: the engine was reconfigured)
    if (!up || session !== target) return null;
  }
  began();
  return new Promise<RenderJobResult | null>((resolve, reject) => {
    const id = ++lastId;
    const release = () => {
      if (target.task?.id === id) target.task = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      release();
      closeSession(target);
      reject(abortError());
    };
    target.task = {
      id,
      message(message) {
        if (message.type === "progress") {
          try {
            report(message.fraction);
          } catch (error) {
            // the caller's progress handler threw: stop the work it no longer wants
            release();
            closeSession(target);
            reject(error);
          }
        } else if (message.type === "done") {
          release();
          crashes = 0;
          resolve({
            audio: message.audio,
            summary: message.summary,
            diagnostics: message.diagnostics,
          });
        } else if (message.type === "error") {
          release();
          reject(new EngineError(message.code, message.detail));
        }
      },
      failure(detail) {
        release();
        const { code } = describeFailure(detail, "engine-crashed");
        reject(new EngineError(code, detail));
      },
    };
    signal?.addEventListener("abort", onAbort);
    try {
      target.worker.postMessage({ type: "render", id, config });
    } catch {
      // the config could not be cloned for the worker: this thread can still read it
      release();
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * `handler` (the caller's onProgress or onPhase), with whatever it throws
 * noted in `thrown`: that is the caller's own error, not a failure of the
 * engine, and the render is rejected with it as it is.
 */
function callerHandler<T>(
  handler: ((value: T) => void) | undefined,
  thrown: unknown[],
): ((value: T) => void) | undefined {
  if (!handler) return undefined;
  return (value) => {
    try {
      handler(value);
    } catch (error) {
      thrown.push(error);
      throw error;
    }
  };
}

async function renderLegacyJob(
  config: MusicConfig,
  report: (fraction: number) => void,
  signal: AbortSignal | undefined,
  phase: (phase: RenderPhase) => void,
): Promise<EngineRenderResult> {
  const started = now();
  phase("rendering");
  const legacy = await renderLegacy(config, (fraction) => {
    if (signal?.aborted) throw abortError();
    // the last word belongs to the facade
    report(Math.min(fraction, 0.999));
  });
  if (signal?.aborted) throw abortError();
  const result: EngineRenderResult = {
    stems: legacy.stems,
    ...describe(legacy.stems, config.volumes),
    duration: legacy.buffer.duration,
    sampleRate: legacy.buffer.sampleRate,
    diagnostics: {
      path: "legacy",
      composeMs: 0,
      renderMs: now() - started,
      notes: 0,
      hits: 0,
      bufferBytes: legacy.buffer.length * 4 * 2 * (TRACKS.length + 1),
      seconds: { voices: 0, parts: 0, sends: 0, master: 0 },
    },
  };
  report(1);
  return result;
}

async function renderJobHere(
  config: MusicConfig,
  report: (fraction: number) => void,
  signal: AbortSignal | undefined,
): Promise<RenderJobResult> {
  return renderJob(config, {
    onProgress: (fraction) => report(fraction * JOB_SHARE),
    paceMs: IN_THREAD_PACE_MS,
    checkpoint: async () => {
      await breathe();
      if (signal?.aborted) throw abortError();
    },
  });
}

async function renderCurrentJob(
  config: MusicConfig,
  report: (fraction: number) => void,
  signal: AbortSignal | undefined,
  phase: (phase: RenderPhase) => void,
): Promise<EngineRenderResult> {
  let path: RenderDiagnostics["path"] = "worker";
  let job = await renderInWorker(
    config,
    (fraction) => report(fraction * JOB_SHARE),
    signal,
    () => phase("starting"),
    () => phase("rendering"),
  );
  if (!job) {
    path = "main";
    if (signal?.aborted) throw abortError();
    phase("rendering");
    job = await renderJobHere(config, report, signal);
  }
  if (signal?.aborted) throw abortError();
  const { audio, summary, diagnostics } = job;
  const stems = await toAudioBuffers(audio, signal, (done, total) =>
    report(JOB_SHARE + (0.999 - JOB_SHARE) * (done / total)),
  );
  const result: EngineRenderResult = {
    stems,
    ...describe(stems, config.volumes),
    duration: audio.frames / audio.sampleRate,
    sampleRate: audio.sampleRate,
    arrangement: summary,
    diagnostics: { path, ...diagnostics },
  };
  report(1);
  return result;
}

/**
 * Offline, deterministic composition + synthesis. No network, no audio
 * permission. Calls may overlap: they are rendered one after another, in the
 * order they were made.
 *
 * Rejects with an AbortError when `signal` aborts, with whatever the caller's
 * own onProgress / onPhase handler threw, and otherwise only with an
 * EngineError: a stable `code`, a message that can be shown to the user, and
 * the original exception text in `detail` for the log.
 */
export function renderMusic(
  config: MusicConfig,
  renderOptions: RenderOptions = {},
): Promise<EngineRenderResult> {
  const { signal } = renderOptions;
  const thrown: unknown[] = [];
  const report = progressReporter(
    callerHandler(renderOptions.onProgress, thrown),
  );
  const onPhase = callerHandler(renderOptions.onPhase, thrown);
  let last: RenderPhase | undefined;
  const phase = (next: RenderPhase) => {
    if (next === last) return;
    last = next;
    onPhase?.(next);
  };
  return enqueue(signal, async () => {
    try {
      return await (config.engine === 1
        ? renderLegacyJob(config, report, signal, phase)
        : renderCurrentJob(config, report, signal, phase));
    } catch (error) {
      throw thrown.includes(error) ? error : engineFailure(error);
    }
  });
}

/**
 * Start the render worker ahead of the first render and let it compile its
 * hot loops on a few throw-away seconds. Optional and harmless: without a
 * worker it does nothing, and a render requested meanwhile simply follows.
 */
export function prewarm(): void {
  const target = openSession();
  if (!target) return;
  try {
    target.worker.postMessage({ type: "warm", id: ++lastId });
  } catch {
    // warming is best effort
  }
}

/** Change how the engine runs (tests, or `worker: false` to stay on one thread). Drops the current worker. */
export function configureEngine(next: EngineOptions = {}): void {
  if (session) {
    const task = session.task;
    session.task = null;
    closeSession(session);
    task?.failure("engine reconfigured");
  }
  options = { ...next };
  unavailable = false;
  crashes = 0;
}

export function engineStatus(): EngineStatus {
  return {
    worker:
      unavailable || options.worker === false
        ? "unavailable"
        : !session
          ? "idle"
          : session.spoke
            ? "ready"
            : "starting",
    pending,
  };
}

/**
 * Offline mixdown for export. `only` renders a single stem at its fader level.
 * Engine 2 ends with the same soft clipper the player uses; engine 1 keeps the
 * v0.2 behaviour (plain sum, scaled down only if it would clip).
 */
export function mixStems(
  stems: Record<TrackName, AudioBuffer>,
  volumes: Record<TrackName, number>,
  engine: 1 | 2,
  only?: TrackName | null,
): AudioBuffer {
  const first = stems.melody;
  const result = new AudioBuffer({
    length: first.length,
    numberOfChannels: 2,
    sampleRate: first.sampleRate,
  });
  const channels = [result.getChannelData(0), result.getChannelData(1)];
  for (let channel = 0; channel < 2; channel++)
    for (const track of TRACKS) {
      if (only && track !== only) continue;
      const gain = clamp01(volumes[track]);
      if (!gain) continue;
      addScaled(
        channels[channel],
        stems[track].getChannelData(
          Math.min(channel, stems[track].numberOfChannels - 1),
        ),
        gain,
      );
    }
  finishMix(channels, engine === 2 ? "softclip" : "legacy");
  return result;
}

/* ------------------------------------------------------------------ */
/* export mixdown in the worker                                        */
/* ------------------------------------------------------------------ */

/** What an export is made of: the stems of a local work, or one decoded file. */
export type MixdownSource =
  | {
      kind: "stems";
      stems: Record<TrackName, AudioBuffer>;
      volumes: Record<TrackName, number>;
      engine: 1 | 2;
      /** a single stem at its fader level */
      only?: TrackName | null;
    }
  | { kind: "buffer"; buffer: AudioBuffer };

/** Copy the samples an export needs out of their AudioBuffers, one channel per turn of the event loop. */
async function copyForMixdown(
  from: MixdownSource,
  fade: boolean,
): Promise<MixdownJob> {
  const copy = async (buffer: AudioBuffer) => {
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      // 23 MB per channel of a two-minute piece: the AudioBuffer keeps its
      // samples, the copy leaves with the message
      channels.push(buffer.getChannelData(channel).slice(0, buffer.length));
      await breathe();
    }
    return channels;
  };
  if (from.kind === "buffer")
    return {
      sampleRate: from.buffer.sampleRate,
      frames: from.buffer.length,
      sources: [{ channels: await copy(from.buffer), gain: 1 }],
      finish: "none",
      fade,
    };
  const sources: MixdownJob["sources"] = [];
  for (const track of TRACKS) {
    if (from.only && track !== from.only) continue;
    const gain = clamp01(from.volumes[track]);
    if (!gain) continue;
    sources.push({ channels: await copy(from.stems[track]), gain });
  }
  return {
    sampleRate: from.stems.melody.sampleRate,
    frames: from.stems.melody.length,
    sources,
    finish: from.engine === 2 ? "softclip" : "legacy",
    fade,
  };
}

/** A warm worker with nothing to do. An export never waits for one to start, nor behind a render. */
const idleSession = (): Session | null =>
  session && session.spoke && !session.task ? session : null;

/**
 * Build the WAV file of an export in the render worker: the same result as
 * encodeWav(mixStems(…)) — or, for a decoded file, encodeWav(buffer) — with
 * the optional v0.2 fade in between, byte for byte.
 *
 * Resolves with null when the worker cannot take the job right now (there is
 * none, it has not started, a render is running or waiting, or it failed on
 * the way). Nothing is lost then: the caller builds the file on its own thread.
 */
export function mixdownInWorker(
  from: MixdownSource,
  fade = false,
): Promise<ArrayBuffer | null> {
  if (pending > 0 || !idleSession()) return Promise.resolve(null);
  // through the render queue: a render requested meanwhile waits its turn
  return enqueue(undefined, async () => {
    if (!idleSession()) return null;
    const job = await copyForMixdown(from, fade);
    const target = idleSession();
    if (!target) return null;
    return new Promise<ArrayBuffer | null>((resolve) => {
      const id = ++lastId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (wav: ArrayBuffer | null) => {
        if (timer !== undefined) clearTimeout(timer);
        if (target.task?.id === id) target.task = null;
        resolve(wav);
      };
      target.task = {
        id,
        message(message) {
          if (message.type === "mixed") finish(message.wav);
          else if (message.type === "error") finish(null);
        },
        failure() {
          finish(null);
        },
      };
      timer = setTimeout(() => {
        // a worker that does not answer is not asked again
        finish(null);
        closeSession(target);
      }, options.mixdownTimeoutMs ?? MIXDOWN_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      try {
        target.worker.postMessage(
          { type: "mixdown", id, job },
          job.sources.flatMap((entry) =>
            entry.channels.map((data) => data.buffer as ArrayBuffer),
          ),
        );
      } catch {
        finish(null);
      }
    }).catch(() => null);
  }).catch(() => null);
}
