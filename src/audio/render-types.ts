/**
 * Contract between the Score renderer (render.ts), the engine facade
 * (engine.ts) and the render worker (worker.ts). Plain data only.
 */
import type { MusicConfig } from "../types";
import type { ArrangementSummary, Score, TrackName } from "../music/score";
import type { RenderReport } from "./render";

export type StereoPcm = [left: Float32Array, right: Float32Array];

export interface RenderedAudio {
  sampleRate: number;
  frames: number;
  /**
   * Final per-track audio. Bus processing and the loudness gain are already
   * baked in: summing the four stems with REFERENCE_VOLUMES lands on the
   * score's target loudness, and the only remaining stage is softClip().
   */
  stems: Record<TrackName, StereoPcm>;
}

/** Fader positions the master gain is calibrated for (the app's default mix). */
export const REFERENCE_VOLUMES: Record<TrackName, number> = {
  melody: 0.8,
  chords: 0.64,
  bass: 0.68,
  drums: 0.56,
};

export interface RenderScoreOptions {
  /** 0..1, called often (cheap) */
  onProgress?: (fraction: number) => void;
  /**
   * Awaited between work blocks (roughly every 30–60 ms of CPU). The host uses
   * it to yield to the event loop and may reject with an AbortError to cancel.
   * Omitted inside a Worker, where cancellation is terminate().
   */
  checkpoint?: () => Promise<void>;
  /** What the render did, what each stage cost and what the master measured; called once, just before the result. */
  onReport?: (report: RenderReport) => void;
}

/** render.ts */
export type RenderScore = (
  score: Score,
  options?: RenderScoreOptions,
) => Promise<RenderedAudio>;

/** music/compose.ts — pure and deterministic for a given config */
export type Compose = (config: MusicConfig) => Score;

/** What the master bus measured on the finished mix (see master.ts, MasterReport). */
export interface MasterDiagnostics {
  /** integrated loudness of the mix at REFERENCE_VOLUMES after the soft clipper, LUFS (-Infinity for silence) */
  lufs: number;
  targetLufs: number;
  /** LU the master deliberately stayed under the target (transient-only material); 0 normally */
  shortfallLu: number;
  /** sample peak of the reference mix before the soft clipper */
  peak: number;
  /** share of samples of the reference mix past the soft clipper's knee */
  clippedRatio: number;
  /** look-ahead limiter: deepest gain reduction in dB, and the share of the piece with more than 0.5 dB of it */
  limiter: { maxReductionDb: number; activeRatio: number };
  /** glue compressor gain reduction, dB */
  compressor: { maxReductionDb: number; meanReductionDb: number };
}

/**
 * Facts about one local render, kept next to the audio (the engine's
 * RenderResult.diagnostics). Plain data; nothing here changes the sound.
 */
export interface RenderDiagnostics {
  /** where the samples were computed: a Web Worker, the calling thread, or the frozen v0.2 engine */
  path: "worker" | "main" | "legacy";
  /** milliseconds spent composing the Score (0 for the legacy engine) */
  composeMs: number;
  /** milliseconds spent synthesising and mastering */
  renderMs: number;
  /** notes and drum hits that were synthesised (0 for the legacy engine, which does not count them) */
  notes: number;
  hits: number;
  /** bytes of full-length sample buffers the renderer allocated */
  bufferBytes: number;
  /** seconds per stage of the Score renderer (zeros for the legacy engine) */
  seconds: { voices: number; parts: number; sends: number; master: number };
  /** absent for the legacy engine, which has no master bus */
  master?: MasterDiagnostics;
}

/** What one engine-2 render job produces, on either side of the worker boundary. */
export interface RenderJobResult {
  audio: RenderedAudio;
  summary: ArrangementSummary;
  /** `path` is filled in by the engine facade, which knows where the job ran */
  diagnostics: Omit<RenderDiagnostics, "path">;
}

/* ---- worker protocol ---- */
export type WorkerRequest =
  | { type: "render"; id: number; config: MusicConfig }
  /** render a few silent-to-the-user seconds so the JIT and the drum wavetables are warm */
  | { type: "warm"; id: number };
export type WorkerResponse =
  /** posted once, as soon as the worker module has loaded */
  | { type: "ready" }
  | { type: "progress"; id: number; fraction: number }
  | ({ type: "done"; id: number } & RenderJobResult)
  | { type: "warmed"; id: number; ms: number }
  | { type: "error"; id: number; message: string };
