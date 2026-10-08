/**
 * Effect processors of the engine-v2 mixer. Everything works on stereo
 * Float32Array blocks at any sample rate and allocates only in constructors.
 *
 *   part inserts   cutFilter (PartMix.lowCut / highCut), Drive (drive),
 *                  Chorus (chorus), stereoMatrix (width + pan), duck curve
 *   track sends    PingPongDelay (SpaceSettings.delayTime / delayFeedback),
 *                  Reverb (size / decay / damping / preDelay)
 *
 * LOOP MODE. A looping piece must come back to its first sample with every
 * effect still ringing from the end. Each stateful effect is therefore run
 * over the last stretch of the loop first (output discarded) and only then
 * over the whole buffer: see forLoopTail(), runInsert() and runSend(). LFOs
 * take a rate with a whole number of cycles per loop and are put where they
 * belong with seek(), so the modulation is a function of the position in the
 * piece and is in the same place at the seam as well.
 */
import { Biquad, Oversampler2x, clamp, clamp01, fastTanh } from "./dsp";
import {
  ANTI_DENORMAL,
  BiquadCascade,
  FX_BLOCK,
  forLoopTail,
} from "./fx/common";
import type { InsertFx, SendFx } from "./fx/common";

export {
  ANTI_DENORMAL,
  BiquadCascade,
  FX_BLOCK,
  forLoopTail,
  loopSyncedRate,
} from "./fx/common";
export type { InsertFx, SendFx } from "./fx/common";
export { Chorus, chorusGains } from "./fx/chorus";
export type { ChorusOptions } from "./fx/chorus";
export { PingPongDelay } from "./fx/delay";
export type { DelayOptions } from "./fx/delay";
export {
  Reverb,
  dampingCorner,
  dampingRatio,
  sizeScale,
} from "./fx/reverb";
export type { ReverbOptions, ReverbSettings } from "./fx/reverb";
export {
  DUCK_DEPTH,
  DUCK_STEP,
  applyDuck,
  duckCurve,
  duckGainAt,
  duckRelease,
  fillDuckGains,
} from "./fx/duck";
export type { DuckHit, DuckOptions } from "./fx/duck";

/* ---- high-pass / low-pass (PartMix.lowCut, PartMix.highCut) ---- */

/**
 * 12 dB/octave Butterworth high-pass at `lowCutHz` and/or low-pass at
 * `highCutHz` (0 = that side off). Returns null when both are off or lie
 * outside the audible band.
 */
export function cutFilter(
  sampleRate: number,
  lowCutHz: number,
  highCutHz: number,
): BiquadCascade | null {
  const sections: Biquad[] = [];
  if (lowCutHz > 1)
    sections.push(
      new Biquad().setHighpass(
        Math.min(lowCutHz, sampleRate * 0.45),
        Math.SQRT1_2,
        sampleRate,
      ),
    );
  if (highCutHz > 1 && highCutHz < sampleRate * 0.45)
    sections.push(
      new Biquad().setLowpass(highCutHz, Math.SQRT1_2, sampleRate),
    );
  return sections.length ? new BiquadCascade(sections) : null;
}

/** In-place 12 dB/octave high-pass of a whole stereo buffer (zero initial state). */
export function highPass(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  hz: number,
  sampleRate: number,
): void {
  cutFilter(sampleRate, hz, 0)?.process(left, right, frames);
}

/** In-place 12 dB/octave low-pass of a whole stereo buffer (zero initial state). */
export function lowPass(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  hz: number,
  sampleRate: number,
): void {
  cutFilter(sampleRate, 0, hz)?.process(left, right, frames);
}

/* ---- soft saturation (PartMix.drive) ---- */

/** Amplitude that passes the drive curve unchanged, so loudness barely moves. */
export const DRIVE_PIVOT = 0.25;
/**
 * From this drive upwards the curve runs at twice the sample rate. Below it
 * the harmonics the curve adds to real parts stay more than 60 dB under the
 * part (measured on kits at 0.1–0.3 and plucked leads at 0.2–0.35), and the
 * oversampler would cost a quarter of a second per driven part in a
 * two-minute piece.
 */
export const DRIVE_OVERSAMPLE_FROM = 0.4;

/** Input gain of the tanh stage for a drive of 0..1 (1 .. 6). */
export function driveGain(drive: number): number {
  return 1 + 5 * clamp01(drive);
}

/**
 * The static drive curve: tanh(k·x), rescaled so DRIVE_PIVOT maps to itself.
 * Quieter material is lifted a little, peaks are rounded off.
 */
export function driveCurve(x: number, drive: number): number {
  const k = driveGain(drive);
  return (fastTanh(k * x) * DRIVE_PIVOT) / fastTanh(k * DRIVE_PIVOT);
}

/** Soft saturation insert. Heavy settings are oversampled 2x and report a latency. */
export class Drive implements InsertFx {
  readonly drive: number;
  /** frames the output lags the input (0 unless oversampled) */
  readonly latency: number;
  private readonly k: number;
  private readonly norm: number;
  private readonly overLeft: Oversampler2x | null;
  private readonly overRight: Oversampler2x | null;

  constructor(drive: number) {
    this.drive = clamp01(drive);
    this.k = driveGain(this.drive);
    this.norm = DRIVE_PIVOT / fastTanh(this.k * DRIVE_PIVOT);
    const oversample = this.drive >= DRIVE_OVERSAMPLE_FROM;
    this.overLeft = oversample ? new Oversampler2x() : null;
    this.overRight = oversample ? new Oversampler2x() : null;
    this.latency = oversample ? Oversampler2x.LATENCY : 0;
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    const k = this.k;
    const norm = this.norm;
    const overLeft = this.overLeft;
    const overRight = this.overRight;
    if (!overLeft || !overRight) {
      for (let i = 0; i < n; i++) {
        left[i] = fastTanh(left[i] * k) * norm;
        right[i] = fastTanh(right[i] * k) * norm;
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      overLeft.up(left[i] + ANTI_DENORMAL);
      left[i] =
        overLeft.down(fastTanh(overLeft.a * k), fastTanh(overLeft.b * k)) *
        norm;
      overRight.up(right[i] + ANTI_DENORMAL);
      right[i] =
        overRight.down(fastTanh(overRight.a * k), fastTanh(overRight.b * k)) *
        norm;
    }
  }
}

/** In-place soft saturation of a whole stereo buffer at the base rate. */
export function saturate(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  drive: number,
): void {
  const k = driveGain(drive);
  const norm = DRIVE_PIVOT / fastTanh(k * DRIVE_PIVOT);
  for (let i = 0; i < frames; i++) {
    left[i] = fastTanh(left[i] * k) * norm;
    right[i] = fastTanh(right[i] * k) * norm;
  }
}

/* ---- width (mid/side) and equal-power pan ---- */

/** out = M · in for a stereo pair: [ll lr; rl rr]. */
export interface StereoMatrix {
  ll: number;
  lr: number;
  rl: number;
  rr: number;
}

/**
 * Equal-power balance gains for pan -1..1, normalised so the centre is unity
 * on both sides: a part does not get quieter for sitting in the middle, and
 * the total power of a mono source is the same anywhere in the field.
 */
export function panGains(pan: number): [left: number, right: number] {
  // exactly unity in the centre, so a centred mono part stays bit-identical on both sides
  if (pan === 0) return [1, 1];
  const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.SQRT2 * Math.cos(angle), Math.SQRT2 * Math.sin(angle)];
}

/**
 * Width followed by pan as one matrix. Width scales the side signal
 * (L − R)/2: 0 folds the part to mono, 1 leaves it alone, up to 1.5 widens.
 */
export function stereoMatrix(width: number, pan: number): StereoMatrix {
  const w = clamp(width, 0, 2);
  const [gl, gr] = panGains(pan);
  const same = (1 + w) / 2;
  const cross = (1 - w) / 2;
  return { ll: gl * same, lr: gl * cross, rl: gr * cross, rr: gr * same };
}

/** Apply a stereo matrix (times `gain`) in place. */
export function applyMatrix(
  left: Float32Array,
  right: Float32Array,
  n: number,
  matrix: StereoMatrix,
  gain = 1,
): void {
  const ll = matrix.ll * gain;
  const lr = matrix.lr * gain;
  const rl = matrix.rl * gain;
  const rr = matrix.rr * gain;
  if (lr === 0 && rl === 0) {
    if (ll === 1 && rr === 1) return;
    for (let i = 0; i < n; i++) {
      left[i] *= ll;
      right[i] *= rr;
    }
    return;
  }
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    left[i] = ll * l + lr * r;
    right[i] = rl * l + rr * r;
  }
}

/** Mid/side width in place: 0 = mono, 1 = unchanged, > 1 = wider. */
export function setWidth(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  width: number,
): void {
  applyMatrix(left, right, frames, stereoMatrix(width, 0));
}

/** Equal-power pan (balance) in place. */
export function setPan(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  pan: number,
): void {
  applyMatrix(left, right, frames, stereoMatrix(1, pan));
}

/* ---- whole-buffer runners with loop warm-up ---- */

let workLeft = new Float32Array(FX_BLOCK);
let workRight = new Float32Array(FX_BLOCK);

/**
 * Run an insert effect over left/right[0 .. frames) in place. With
 * `loopWarm` > 0 the effect first hears the last `loopWarm` frames (output
 * discarded), so its state at frame 0 continues from the end of the buffer.
 */
export function runInsert(
  fx: InsertFx,
  left: Float32Array,
  right: Float32Array,
  frames: number,
  loopWarm = 0,
): void {
  if (loopWarm > 0) {
    fx.seek?.(-Math.floor(loopWarm));
    forLoopTail(frames, loopWarm, FX_BLOCK, (from, count) => {
      workLeft.set(left.subarray(from, from + count));
      workRight.set(right.subarray(from, from + count));
      fx.process(workLeft, workRight, count);
    });
  }
  for (let from = 0; from < frames; from += FX_BLOCK) {
    const count = Math.min(FX_BLOCK, frames - from);
    fx.process(
      left.subarray(from, from + count),
      right.subarray(from, from + count),
      count,
    );
  }
}

/**
 * Run a send effect over in[0 .. frames) and ADD `gain` times its wet output
 * to out[0 .. frames). With `loopWarm` > 0 the tail of the end is already
 * ringing at frame 0 (see forLoopTail). `in` and `out` must be different
 * buffers.
 */
export function runSend(
  fx: SendFx,
  inLeft: Float32Array,
  inRight: Float32Array,
  outLeft: Float32Array,
  outRight: Float32Array,
  frames: number,
  gain = 1,
  loopWarm = 0,
): void {
  if (loopWarm > 0) {
    fx.seek?.(-Math.floor(loopWarm));
    forLoopTail(frames, loopWarm, FX_BLOCK, (from, count) => {
      fx.process(
        inLeft.subarray(from, from + count),
        inRight.subarray(from, from + count),
        workLeft,
        workRight,
        count,
      );
    });
  }
  for (let from = 0; from < frames; from += FX_BLOCK) {
    const count = Math.min(FX_BLOCK, frames - from);
    fx.process(
      inLeft.subarray(from, from + count),
      inRight.subarray(from, from + count),
      workLeft,
      workRight,
      count,
    );
    for (let i = 0; i < count; i++) {
      outLeft[from + i] += workLeft[i] * gain;
      outRight[from + i] += workRight[i] * gain;
    }
  }
}
