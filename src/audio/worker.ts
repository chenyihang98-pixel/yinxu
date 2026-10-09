/**
 * The engine-2 render job (compose → synthesise → master → summarise) and the
 * Web Worker that runs it off the UI thread.
 *
 * engine.ts starts this file as a module worker and, where no worker can be
 * had, calls renderJob() directly on its own thread. Inside a worker the
 * module answers WorkerRequest messages one at a time — the voices keep
 * module state and are not re-entrant — and hands the finished stems over by
 * TRANSFER, so two minutes of audio cross the thread boundary without a copy.
 * The same worker also mixes and encodes exports (mixdown.ts).
 */
import type { MusicConfig } from "../types";
import { compose, summarize } from "../music/compose";
import { DEFAULT_CONFIG } from "../music/defaults";
import { TRACKS } from "../music/score";
import type { Score } from "../music/score";
import { DRUMS } from "./drums";
import { describeFailure } from "./engine-error";
import { mixdownToWav } from "./mixdown";
import { renderScoreWith } from "./render";
import type { RenderReport } from "./render";
import type {
  RenderJobResult,
  RenderScoreOptions,
  WorkerRequest,
  WorkerResponse,
} from "./render-types";
import { VOICES } from "./voices";

/** Share of a job's progress bar that belongs to composing. */
const COMPOSE_SHARE = 0.01;
/** Milliseconds between two progress messages of the worker (20 per second). */
export const PROGRESS_INTERVAL_MS = 50;
/** Seconds of the warm-up render. */
const WARM_SECONDS = 3;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : 0;

export interface RenderJobOptions extends RenderScoreOptions {
  /** see RenderWithOptions.paceMs: milliseconds of work between two checkpoints */
  paceMs?: number;
}

/**
 * One whole engine-2 render. Deterministic for a given config, wherever it
 * runs. `onProgress` goes from 0 to 1; a rejecting `checkpoint` cancels.
 */
export async function renderJob(
  config: MusicConfig,
  options: RenderJobOptions = {},
): Promise<RenderJobResult> {
  const started = now();
  const score = compose(config);
  const composed = now();
  options.onProgress?.(COMPOSE_SHARE);
  let report: RenderReport | undefined;
  const audio = await renderScoreWith(
    score,
    { voices: VOICES, drums: DRUMS },
    {
      onProgress: (fraction) =>
        options.onProgress?.(COMPOSE_SHARE + fraction * (1 - COMPOSE_SHARE)),
      checkpoint: options.checkpoint,
      paceMs: options.paceMs,
      onReport: (value) => {
        report = value;
        options.onReport?.(value);
      },
    },
  );
  const finished = now();
  const done = report as RenderReport;
  return {
    audio,
    summary: summarize(score),
    diagnostics: {
      composeMs: composed - started,
      renderMs: finished - composed,
      notes: done.notes,
      hits: done.hits,
      bufferBytes: done.bufferBytes,
      seconds: {
        voices: done.seconds.voices,
        parts: done.seconds.parts,
        sends: done.seconds.sends,
        master: done.seconds.master,
      },
      master: {
        lufs: done.master.lufs,
        targetLufs: done.master.targetLufs,
        shortfallLu: done.master.shortfallLu,
        peak: done.master.peak,
        clippedRatio: done.master.clippedRatio,
        limiter: {
          maxReductionDb: done.master.limiter.maxReductionDb,
          activeRatio: done.master.limiter.activeRatio,
        },
        compressor: {
          maxReductionDb: done.master.compressor.maxReductionDb,
          meanReductionDb: done.master.compressor.meanReductionDb,
        },
      },
    },
  };
}

/** The opening seconds of the default piece: enough to compile the hot loops and build a drum kit. */
function warmScore(): Score {
  const score = compose({ ...DEFAULT_CONFIG, duration: 15, loop: false });
  const last = WARM_SECONDS - 0.6;
  return {
    ...score,
    duration: WARM_SECONDS,
    loop: false,
    parts: score.parts.map((part) =>
      part.kind === "notes"
        ? {
            ...part,
            notes: part.notes
              .filter((note) => note.t < last)
              .map((note) => ({ ...note, d: Math.min(note.d, 0.4) })),
          }
        : { ...part, hits: part.hits.filter((hit) => hit.t < last) },
    ),
  };
}

/** Render a few seconds and throw them away. Returns the milliseconds it took. */
export async function warmUp(): Promise<number> {
  const started = now();
  await renderScoreWith(warmScore(), { voices: VOICES, drums: DRUMS });
  return now() - started;
}

/** The part of DedicatedWorkerGlobalScope this module uses (also what a test double provides). */
export interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
}

async function handle(
  scope: WorkerScope,
  request: WorkerRequest,
): Promise<void> {
  try {
    if (request.type === "warm") {
      scope.postMessage({ type: "warmed", id: request.id, ms: await warmUp() });
      return;
    }
    if (request.type === "mixdown") {
      const wav = mixdownToWav(request.job);
      scope.postMessage({ type: "mixed", id: request.id, wav }, [wav]);
      return;
    }
    let lastPost = -Infinity;
    let lastFraction = -1;
    const result = await renderJob(request.config, {
      onProgress: (fraction) => {
        const time = now();
        if (time - lastPost < PROGRESS_INTERVAL_MS || fraction <= lastFraction)
          return;
        lastPost = time;
        lastFraction = fraction;
        scope.postMessage({ type: "progress", id: request.id, fraction });
      },
    });
    const transfer: Transferable[] = [];
    for (const track of TRACKS)
      for (const channel of result.audio.stems[track])
        transfer.push(channel.buffer as ArrayBuffer);
    scope.postMessage({ type: "done", id: request.id, ...result }, transfer);
  } catch (error) {
    // what went wrong travels as a code and the original text; the words the
    // user reads are chosen on the other side (engine-error.ts)
    scope.postMessage({
      type: "error",
      id: request.id,
      ...describeFailure(error),
    });
  }
}

/** Serve WorkerRequests arriving on `scope`, strictly one after another. */
export function attachWorker(scope: WorkerScope): void {
  let chain: Promise<void> = Promise.resolve();
  scope.onmessage = (event) => {
    const request = event.data;
    chain = chain.then(() => handle(scope, request));
  };
  scope.postMessage({ type: "ready" });
}

// Started as a worker: serve. Imported by engine.ts on the UI thread: stay passive.
const host = globalThis as unknown as {
  WorkerGlobalScope?: unknown;
  document?: unknown;
} & WorkerScope;
if (
  typeof host.WorkerGlobalScope !== "undefined" &&
  typeof host.document === "undefined" &&
  typeof host.postMessage === "function"
)
  attachWorker(host);
