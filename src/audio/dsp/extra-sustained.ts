/**
 * Extra primitives of the sustained and bass voice groups (voices/sustained,
 * voices/bass). Same rules as the rest of the toolbox: any sample rate,
 * allocation only in constructors. Import from "../dsp/extra-sustained"
 * (dsp/index.ts does not re-export this file).
 */
import { clamp } from "./math";
import type { Biquad } from "./filters";

/** 2^(semitones / 12) = exp(semitones · SEMITONE). */
export const SEMITONE = Math.LN2 / 12;
/** Frequency ratio - 1 of one cent to first order (exact enough below ±40 cents). */
export const CENT = Math.LN2 / 1200;

/** 0 before `delay`, eased (smoothstep) to 1 over the next `fade` seconds: the depth of a delayed vibrato. */
export function onset(t: number, delay: number, fade: number): number {
  const x = (t - delay) / fade;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

/**
 * |H(f)| of a chain of static biquads sampled on a log-frequency grid, so a
 * voice can predict the level of hundreds of harmonics per note with one
 * table lookup each.
 */
export class ResponseTable {
  private readonly table: Float32Array;
  private readonly lowHz: number;
  private readonly perOctave: number;
  private readonly last: number;

  constructor(
    filters: readonly Biquad[],
    sampleRate: number,
    lowHz = 16,
    octaves = 10.5,
    pointsPerOctave = 48,
  ) {
    const points = Math.ceil(octaves * pointsPerOctave);
    this.table = new Float32Array(points + 2);
    this.lowHz = lowHz;
    this.perOctave = pointsPerOctave;
    this.last = points;
    for (let i = 0; i < this.table.length; i++) {
      const hz = Math.min(
        lowHz * Math.pow(2, i / pointsPerOctave),
        sampleRate * 0.499,
      );
      let gain = 1;
      for (const filter of filters) gain *= filter.magnitude(hz, sampleRate);
      this.table[i] = gain;
    }
  }

  /** Linear gain of the chain at `hz`. */
  gain(hz: number): number {
    const position = clamp(
      Math.log2(hz / this.lowHz) * this.perOctave,
      0,
      this.last,
    );
    const index = position | 0;
    const a = this.table[index];
    return a + (this.table[index + 1] - a) * (position - index);
  }
}

/**
 * TPT state-variable filter that works on a RANGE of a buffer in place, so a
 * voice can retune it once per control block while it walks along one note.
 */
export class SvfRange {
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  private ic1 = 0;
  private ic2 = 0;

  /** Cutoff in Hz and resonance q (0.7071 = Butterworth). State is kept. */
  set(hz: number, q: number, sampleRate: number): void {
    const g = Math.tan(
      (Math.PI * clamp(hz, 5, sampleRate * 0.49)) / sampleRate,
    );
    const k = 1 / (q < 0.2 ? 0.2 : q);
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /** Take the coefficients (not the state) of another filter. */
  copy(other: SvfRange): void {
    this.k = other.k;
    this.a1 = other.a1;
    this.a2 = other.a2;
    this.a3 = other.a3;
  }

  /** Low-pass buf[from .. to) in place. */
  low(buf: Float32Array, from: number, to: number): void {
    const a1 = this.a1;
    const a2 = this.a2;
    const a3 = this.a3;
    let ic1 = this.ic1;
    let ic2 = this.ic2;
    for (let i = from; i < to; i++) {
      const v3 = buf[i] - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      buf[i] = v2;
    }
    this.ic1 = ic1;
    this.ic2 = ic2;
  }

  /** Band-pass buf[from .. to) in place, scaled to unity gain at the centre. */
  band(buf: Float32Array, from: number, to: number): void {
    const a1 = this.a1;
    const a2 = this.a2;
    const a3 = this.a3;
    const k = this.k;
    let ic1 = this.ic1;
    let ic2 = this.ic2;
    for (let i = from; i < to; i++) {
      const v3 = buf[i] - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      buf[i] = v1 * k;
    }
    this.ic1 = ic1;
    this.ic2 = ic2;
  }

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }
}

/**
 * First-order high shelf: unity at DC, `gain` (linear) far above the corner.
 * Used as a spectral tilt whose corner follows the note.
 */
export class TiltShelf {
  private g = 1;
  private k = 0.5;
  private lift = 0;
  private s = 0;

  /** Corner in Hz and linear gain of the top. */
  set(hz: number, gain: number, sampleRate: number): void {
    this.g = Math.tan(
      (Math.PI * clamp(hz, 1, sampleRate * 0.49)) / sampleRate,
    );
    this.k = this.g / (1 + this.g);
    this.lift = gain - 1;
  }

  process(buf: Float32Array, n: number): void {
    const k = this.k;
    const lift = this.lift;
    let s = this.s;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const v = (x - s) * k;
      const low = v + s;
      s = low + v;
      buf[i] = x + lift * (x - low);
    }
    this.s = s;
  }

  /** Linear gain at `hz`. */
  magnitude(hz: number, sampleRate: number): number {
    if (hz >= sampleRate * 0.5) return 1 + this.lift;
    const t = Math.tan((Math.PI * hz) / sampleRate) / this.g;
    const top = (1 + this.lift) * t;
    return Math.sqrt((1 + top * top) / (1 + t * t));
  }

  reset(): void {
    this.s = 0;
  }
}

/**
 * Mean square of white noise of unit variance after a unity-peak TPT
 * band-pass at (hz, q): its equivalent noise bandwidth as a share of Nyquist.
 * (Multiply by 1/3 for WhiteNoise, whose samples are uniform in ±1.)
 */
export function bandpassNoisePower(
  hz: number,
  q: number,
  sampleRate: number,
): number {
  const g = Math.tan((Math.PI * clamp(hz, 5, sampleRate * 0.49)) / sampleRate);
  const k = 1 / (q < 0.2 ? 0.2 : q);
  // (2/π) ∫ |H(s)|² · g / (1 + g²s²) ds over s = e^v, midpoint rule
  const steps = 160;
  const low = -7;
  const high = 7;
  const dv = (high - low) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const s = Math.exp(low + (i + 0.5) * dv);
    const ks = k * s;
    const re = 1 - s * s;
    sum += ((ks * ks) / (re * re + ks * ks)) * (g / (1 + g * g * s * s)) * s;
  }
  return (2 / Math.PI) * sum * dv;
}

/**
 * A handful of detuned band-limited saws rendered block by block into a
 * stereo pair. The voice writes `inc` (and once per note `phase`, `left`,
 * `right`), then calls render() for each control block.
 */
export class SawBank {
  readonly count: number;
  /** current phase of each saw, 0..1 */
  readonly phase: Float64Array;
  /** phase increment per sample of each saw (keep below 0.25) */
  readonly inc: Float64Array;
  /** gain of each saw into the left / right buffer */
  readonly left: Float64Array;
  readonly right: Float64Array;

  constructor(count: number) {
    this.count = count;
    this.phase = new Float64Array(count);
    this.inc = new Float64Array(count);
    this.left = new Float64Array(count);
    this.right = new Float64Array(count);
  }

  /** ADD every saw into l / r[from .. to) at its current increment. */
  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    for (let s = 0; s < this.count; s++) {
      let phase = this.phase[s];
      const inc = this.inc[s];
      const edge = 1 - inc;
      const gl = this.left[s];
      const gr = this.right[s];
      for (let i = from; i < to; i++) {
        let v = 2 * phase - 1;
        if (phase < inc) {
          const x = phase / inc;
          v -= x + x - x * x - 1;
        } else if (phase > edge) {
          const x = (phase - 1) / inc;
          v -= x * x + x + x + 1;
        }
        l[i] += gl * v;
        r[i] += gr * v;
        phase += inc;
        if (phase >= 1) phase -= 1;
      }
      this.phase[s] = phase;
    }
  }
}

/**
 * Start phases of a detuned ensemble. Fully random phases make the first
 * few hundred milliseconds a lottery: the players are only a hertz apart, so
 * until they have drifted the fundamental may add up, cancel, or sit in
 * antiphase between the channels. `pattern` is a set of phases searched
 * offline (for the voice's exact detune / pan tables) so that the low
 * harmonics of both channels start at their long-term mean power with a
 * positive L/R correlation, stay near it while the players drift, and the
 * pitch of their sum stays centred.
 * The pattern is rotated as a whole by one random draw (which changes no
 * magnitude) and each player is jittered slightly, so notes still differ.
 * Returns the rotation, 0..1.
 */
export function seedPhases(
  phase: Float64Array,
  pattern: readonly number[],
  random: () => number,
  jitter = 0.03,
): number {
  const rotation = random();
  for (let i = 0; i < pattern.length; i++) {
    const p = rotation + pattern[i] + jitter * (random() - 0.5) + 1;
    phase[i] = p - Math.floor(p);
  }
  return rotation;
}

/**
 * Largest |sample| x gain of a stereo pair: returns `gain`, or the smaller
 * gain that keeps the peak at `ceiling` (a guard that normally never engages).
 */
export function guardGain(
  l: Float32Array,
  r: Float32Array,
  frames: number,
  gain: number,
  ceiling = 0.98,
): number {
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const a = Math.abs(l[i]);
    const b = Math.abs(r[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  return peak * gain > ceiling ? ceiling / peak : gain;
}

const NES_STEPS = 32;
/** The 2A03 triangle sequence 8..15, 15..0, 0..7 scaled to ±1, starting at the upward zero crossing. */
const NES_LEVEL: Float32Array = (() => {
  const levels = new Float32Array(NES_STEPS);
  for (let i = 0; i < NES_STEPS; i++) {
    const step = i < 8 ? 8 + i : i < 24 ? 23 - i : i - 24;
    levels[i] = (step - 7.5) / 7.5;
  }
  return levels;
})();
/** NES_JUMP[i] = height of the step INTO sequence position i (0 at the two flat tops). */
const NES_JUMP: Float32Array = (() => {
  const jumps = new Float32Array(NES_STEPS + 1);
  for (let i = 0; i <= NES_STEPS; i++)
    jumps[i] =
      NES_LEVEL[i % NES_STEPS] - NES_LEVEL[(i + NES_STEPS - 1) % NES_STEPS];
  return jumps;
})();

/** Peak of the smooth triangle the staircase of nesTriangle() is sampled from. */
export const NES_TRIANGLE_PEAK = 16 / 15;
/** Highest phase increment nesTriangle() band-limits properly (one step = two samples). */
export const NES_TRIANGLE_MAX_INC = 0.5 / NES_STEPS;

/**
 * NES-style triangle: a 32-step, 4-bit staircase in ±1 with every step
 * band-limited (PolyBLEP). Phase 0 is the upward zero crossing. Needs
 * inc <= NES_TRIANGLE_MAX_INC; above that use triBlamp().
 */
export function nesTriangle(phase: number, inc: number): number {
  const position = phase * NES_STEPS;
  const index = position | 0;
  const fraction = position - index;
  const dt = inc * NES_STEPS;
  let v = NES_LEVEL[index];
  if (fraction < dt) {
    const x = fraction / dt;
    v += 0.5 * NES_JUMP[index] * (x + x - x * x - 1);
  } else if (fraction > 1 - dt) {
    const x = (fraction - 1) / dt;
    v += 0.5 * NES_JUMP[index + 1] * (x * x + x + x + 1);
  }
  return v;
}

/** Sequence level of nesTriangle() without band-limiting (for level measurements). */
export function nesTriangleLevel(phase: number): number {
  return NES_LEVEL[(phase * NES_STEPS) | 0];
}
