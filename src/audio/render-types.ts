/**
 * Contract between the Score renderer (render.ts), the engine facade
 * (engine.ts) and the render worker (worker.ts). Plain data only.
 */
import type { MusicConfig } from "../types";
import type { ArrangementSummary, Score, TrackName } from "../music/score";

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
}

/** render.ts */
export type RenderScore = (
  score: Score,
  options?: RenderScoreOptions,
) => Promise<RenderedAudio>;

/** music/compose.ts — pure and deterministic for a given config */
export type Compose = (config: MusicConfig) => Score;

/* ---- worker protocol ---- */
export type WorkerRequest = { type: "render"; id: number; config: MusicConfig };
export type WorkerResponse =
  | { type: "progress"; id: number; fraction: number }
  | {
      type: "done";
      id: number;
      audio: RenderedAudio;
      summary: ArrangementSummary;
    }
  | { type: "error"; id: number; message: string };
