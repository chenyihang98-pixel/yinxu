/**
 * Oscillators. Phases are NORMALISED (0..1 = one cycle) and `inc` is the
 * per-sample phase increment hz / sampleRate (keep it below 0.25).
 *
 * Stateless per-sample kernels (`sawBlep(phase, inc)` …) let a voice keep the
 * phase in a local variable inside its own loop; `Oscillator` wraps the same
 * kernels with state; the `add*` functions render whole blocks.
 */
import { TAU } from "./math";

export const SINE_TABLE_SIZE = 4096;

/** One sine cycle plus two guard points for interpolation without masking. */
export const SINE_TABLE: Float32Array = (() => {
  const table = new Float32Array(SINE_TABLE_SIZE + 2);
  for (let i = 0; i < table.length; i++)
    table[i] = Math.sin((i * TAU) / SINE_TABLE_SIZE);
  table[SINE_TABLE_SIZE] = 0;
  return table;
})();

/** Wavetable sine of a phase already inside [0, 1] (linear interpolation, error below -125 dB). */
export function sinPhase(phase: number): number {
  const position = phase * SINE_TABLE_SIZE;
  const index = position | 0;
  const a = SINE_TABLE[index];
  return a + (SINE_TABLE[index + 1] - a) * (position - index);
}

/** Wavetable sine of any number of turns (cycles), negative values included. */
export function sinTurns(turns: number): number {
  return sinPhase(turns - Math.floor(turns));
}

/** Wavetable cosine of any number of turns. */
export function cosTurns(turns: number): number {
  return sinTurns(turns + 0.25);
}

/** Wrap a phase into [0, 1). */
export function wrapPhase(phase: number): number {
  return phase - Math.floor(phase);
}

/**
 * PolyBLEP residual of a downward step of height 2 at phase 0: subtract it
 * from a naive rising saw, add it for an upward step. t = phase, dt = inc.
 */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * PolyBLAMP residual of a corner at phase 0 whose slope rises by 1 per cycle:
 * add `slopeChange * polyBlamp(t, dt)` to a naive waveform with a kink.
 */
export function polyBlamp(t: number, dt: number): number {
  if (t < dt) {
    const x = 1 - t / dt;
    return (dt * x * x * x) / 6;
  }
  if (t > 1 - dt) {
    const x = 1 - (1 - t) / dt;
    return (dt * x * x * x) / 6;
  }
  return 0;
}

/** Aliasing saw -1..1 (reference for tests; do not use in voices). */
export function sawNaive(phase: number): number {
  return 2 * phase - 1;
}

/** Band-limited rising saw -1..1 for a phase in [0, 1). */
export function sawBlep(phase: number, inc: number): number {
  return 2 * phase - 1 - polyBlep(phase, inc);
}

/**
 * Band-limited pulse with duty cycle `width` (0.05..0.95, 0.5 = square).
 * DC is removed, so the output is zero-mean for every width (peak 2·max(w, 1-w)).
 */
export function pulseBlep(phase: number, inc: number, width: number): number {
  let shifted = phase + 1 - width;
  if (shifted >= 1) shifted -= 1;
  return (
    (phase < width ? 2 : 0) -
    2 * width +
    polyBlep(phase, inc) -
    polyBlep(shifted, inc)
  );
}

/** Band-limited triangle -1..1 that starts at 0 and rises (sine-like phase). */
export function triBlamp(phase: number, inc: number): number {
  let u = phase + 0.25;
  if (u >= 1) u -= 1;
  let v = u + 0.5;
  if (v >= 1) v -= 1;
  return (
    1 - 4 * Math.abs(u - 0.5) + 8 * (polyBlamp(u, inc) - polyBlamp(v, inc))
  );
}

/** Stateful oscillator: every waveform call returns one sample and advances the phase. */
export class Oscillator {
  /** current phase, 0..1 */
  phase: number;
  /** phase increment per sample (hz / sampleRate) */
  inc: number;

  constructor(hz = 440, sampleRate = 48000, phase = 0) {
    this.phase = wrapPhase(phase);
    this.inc = hz / sampleRate;
  }

  /** Set the frequency without touching the phase (safe every sample). */
  setFreq(hz: number, sampleRate: number): void {
    this.inc = hz / sampleRate;
  }

  private step(): number {
    const phase = this.phase;
    let next = phase + this.inc;
    if (next >= 1) next -= 1;
    this.phase = next;
    return phase;
  }

  /** Wavetable sine. */
  sine(): number {
    return sinPhase(this.step());
  }

  /** PolyBLEP saw. */
  saw(): number {
    return sawBlep(this.step(), this.inc);
  }

  /** PolyBLEP pulse, zero-mean. */
  pulse(width = 0.5): number {
    return pulseBlep(this.step(), this.inc, width);
  }

  /** PolyBLAMP triangle. */
  triangle(): number {
    return triBlamp(this.step(), this.inc);
  }
}

/** ADD gain·sin into out[0..n) at a fixed frequency; returns the phase after the block. */
export function addSine(
  out: Float32Array,
  n: number,
  phase: number,
  inc: number,
  gain: number,
): number {
  for (let i = 0; i < n; i++) {
    out[i] += gain * sinPhase(phase);
    phase += inc;
    if (phase >= 1) phase -= 1;
  }
  return phase;
}

/** ADD a band-limited saw into out[0..n); returns the phase after the block. */
export function addSaw(
  out: Float32Array,
  n: number,
  phase: number,
  inc: number,
  gain: number,
): number {
  const edge = 1 - inc;
  for (let i = 0; i < n; i++) {
    let s = 2 * phase - 1;
    if (phase < inc) {
      const x = phase / inc;
      s -= x + x - x * x - 1;
    } else if (phase > edge) {
      const x = (phase - 1) / inc;
      s -= x * x + x + x + 1;
    }
    out[i] += gain * s;
    phase += inc;
    if (phase >= 1) phase -= 1;
  }
  return phase;
}

/** ADD a band-limited zero-mean pulse into out[0..n); returns the phase after the block. */
export function addPulse(
  out: Float32Array,
  n: number,
  phase: number,
  inc: number,
  width: number,
  gain: number,
): number {
  for (let i = 0; i < n; i++) {
    out[i] += gain * pulseBlep(phase, inc, width);
    phase += inc;
    if (phase >= 1) phase -= 1;
  }
  return phase;
}

/** ADD a band-limited triangle into out[0..n); returns the phase after the block. */
export function addTriangle(
  out: Float32Array,
  n: number,
  phase: number,
  inc: number,
  gain: number,
): number {
  for (let i = 0; i < n; i++) {
    out[i] += gain * triBlamp(phase, inc);
    phase += inc;
    if (phase >= 1) phase -= 1;
  }
  return phase;
}
