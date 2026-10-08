/**
 * Kick-keyed ducking ("sidechain" feel) for PartMix.duck. The renderer knows
 * every kick in advance, so instead of a compressor chasing the kick the
 * gain curve is drawn directly: down just before the hit, a short hold, then
 * a smooth release. The curve is stored at control rate and interpolated.
 */
import { clamp, clamp01 } from "../dsp";

/** Frames between two control points of a duck curve. */
export const DUCK_STEP = 32;

/** Gain reduction (as a fraction of the signal) at PartMix.duck = 1 under a full-velocity kick. */
export const DUCK_DEPTH = 0.72;

export interface DuckHit {
  /** seconds */
  t: number;
  /** 0..1 */
  vel: number;
}

export interface DuckOptions {
  /** seconds from full level down to the ducked level (default 0.005) */
  attack?: number;
  /** seconds the attack starts ahead of the hit (default 0.003) */
  lookahead?: number;
  /** seconds held at the ducked level (default 0.025) */
  hold?: number;
  /** seconds to come back up (default 0.18; musical range 0.12 .. 0.25) */
  release?: number;
  /** wrap the curve around the end of the piece */
  loop?: boolean;
  /** frames between control points (default DUCK_STEP) */
  step?: number;
}

/** Release time that lets a part breathe back in before the next beat at `bpm`. */
export function duckRelease(bpm: number): number {
  return clamp((60 / Math.max(bpm, 1)) * 0.45, 0.12, 0.25);
}

/**
 * Depth curve 0..1 (0 = untouched, 1 = fully ducked) sampled every `step`
 * frames: curve[k] belongs to frame k·step, and the last point lies at or
 * past the final frame. Overlapping hits take the deeper value.
 */
export function duckCurve(
  hits: readonly DuckHit[],
  frames: number,
  sampleRate: number,
  options: DuckOptions = {},
): Float32Array {
  const step = Math.max(1, Math.floor(options.step ?? DUCK_STEP));
  const attack = Math.max(0.0005, options.attack ?? 0.005);
  const lookahead = Math.max(0, options.lookahead ?? 0.003);
  const hold = Math.max(0, options.hold ?? 0.025);
  const release = Math.max(0.005, options.release ?? 0.18);
  const count = Math.ceil(Math.max(frames - 1, 0) / step) + 2;
  const curve = new Float32Array(count);
  const duration = frames / sampleRate;
  const length = attack + hold + release;
  const secondsPerPoint = step / sampleRate;

  const draw = (time: number, strength: number) => {
    const start = time - lookahead;
    const first = Math.max(0, Math.ceil(start / secondsPerPoint));
    const last = Math.min(
      count - 1,
      Math.floor((start + length) / secondsPerPoint),
    );
    for (let k = first; k <= last; k++) {
      const tau = k * secondsPerPoint - start;
      let shape: number;
      if (tau < attack) shape = 0.5 - 0.5 * Math.cos((Math.PI * tau) / attack);
      else if (tau < attack + hold) shape = 1;
      else
        shape =
          0.5 + 0.5 * Math.cos((Math.PI * (tau - attack - hold)) / release);
      const value = strength * shape;
      if (value > curve[k]) curve[k] = value;
    }
  };

  for (const hit of hits) {
    if (!(hit.vel > 0) || !Number.isFinite(hit.t)) continue;
    // a soft kick ducks less, but even a quiet one is felt
    const strength = Math.sqrt(clamp01(hit.vel));
    draw(hit.t, strength);
    if (options.loop && duration > 0) {
      // the release of a late hit continues at the start, and the attack of
      // a hit on the downbeat begins at the very end
      if (hit.t + length > duration) draw(hit.t - duration, strength);
      if (hit.t - lookahead < 2 * secondsPerPoint)
        draw(hit.t + duration, strength);
    }
  }
  return curve;
}

/** Gain at `frame` for a part with PartMix.duck = `amount`. */
export function duckGainAt(
  curve: Float32Array,
  frame: number,
  amount: number,
  step = DUCK_STEP,
): number {
  const position = frame / step;
  const index = Math.floor(position);
  const a = curve[Math.min(index, curve.length - 1)];
  const b = curve[Math.min(index + 1, curve.length - 1)];
  return 1 - amount * DUCK_DEPTH * (a + (b - a) * (position - index));
}

/**
 * Write the duck gain of frames [offset, offset + n) of the piece for a part
 * with PartMix.duck = `amount` into out[0 .. n).
 */
export function fillDuckGains(
  out: Float32Array,
  n: number,
  curve: Float32Array,
  offset: number,
  amount: number,
  step = DUCK_STEP,
): void {
  const scale = amount * DUCK_DEPTH;
  const last = curve.length - 1;
  let i = 0;
  while (i < n) {
    const frame = offset + i;
    const index = Math.floor(frame / step);
    const a = curve[index < last ? index : last];
    const b = curve[index + 1 < last ? index + 1 : last];
    const end = Math.min(n, (index + 1) * step - offset);
    const slope = (-scale * (b - a)) / step;
    let gain = 1 - scale * a + slope * (frame - index * step);
    for (; i < end; i++) {
      out[i] = gain;
      gain += slope;
    }
  }
}

/**
 * Multiply left/right[0 .. n) — which are frames [offset, offset + n) of the
 * piece — by the duck gain for `amount`.
 */
export function applyDuck(
  left: Float32Array,
  right: Float32Array,
  n: number,
  curve: Float32Array,
  offset: number,
  amount: number,
  step = DUCK_STEP,
): void {
  const scale = amount * DUCK_DEPTH;
  if (scale <= 0) return;
  const last = curve.length - 1;
  let i = 0;
  while (i < n) {
    const frame = offset + i;
    const index = Math.floor(frame / step);
    const a = curve[index < last ? index : last];
    const b = curve[index + 1 < last ? index + 1 : last];
    const end = Math.min(n, (index + 1) * step - offset);
    if (a === 0 && b === 0) {
      i = end;
      continue;
    }
    const slope = (b - a) / step;
    let depth = a + slope * (frame - index * step);
    for (; i < end; i++) {
      const gain = 1 - scale * depth;
      left[i] *= gain;
      right[i] *= gain;
      depth += slope;
    }
  }
}
