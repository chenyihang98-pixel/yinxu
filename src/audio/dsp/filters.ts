/**
 * Filters. Every class keeps its state in double precision, exposes a
 * per-sample `next(x)`, an in-place block `process(buf, n)` and a
 * `magnitude(hz)` (linear gain of the current settings) so voices can predict
 * levels analytically and tests can compare measured against ideal responses.
 */
import { TAU, clamp } from "./math";

/**
 * One-pole low-pass (6 dB/octave), zero-delay-feedback form: exactly -3 dB
 * at the cutoff, unity at DC, safe to retune every sample.
 */
export class OnePoleLP {
  private g = 1;
  private k = 0.5;
  private s = 0;

  constructor(cutoffHz?: number, sampleRate?: number) {
    if (cutoffHz !== undefined && sampleRate !== undefined)
      this.setCutoff(cutoffHz, sampleRate);
  }

  /** -3 dB corner in Hz. */
  setCutoff(hz: number, sampleRate: number): void {
    this.g = Math.tan(
      (Math.PI * clamp(hz, 0.01, sampleRate * 0.49)) / sampleRate,
    );
    this.k = this.g / (1 + this.g);
  }

  next(x: number): number {
    const v = (x - this.s) * this.k;
    const y = v + this.s;
    this.s = y + v;
    return y;
  }

  process(buf: Float32Array, n: number): void {
    const k = this.k;
    let s = this.s;
    for (let i = 0; i < n; i++) {
      const v = (buf[i] - s) * k;
      const y = v + s;
      s = y + v;
      buf[i] = y;
    }
    this.s = s;
  }

  /** Linear gain at `hz`. */
  magnitude(hz: number, sampleRate: number): number {
    if (hz >= sampleRate * 0.5) return 0;
    const t = Math.tan((Math.PI * hz) / sampleRate) / this.g;
    return 1 / Math.sqrt(1 + t * t);
  }

  reset(): void {
    this.s = 0;
  }
}

/** One-pole high-pass (6 dB/octave), the exact complement of OnePoleLP: -3 dB at the cutoff, unity at Nyquist. */
export class OnePoleHP {
  private g = 1;
  private k = 0.5;
  private s = 0;

  constructor(cutoffHz?: number, sampleRate?: number) {
    if (cutoffHz !== undefined && sampleRate !== undefined)
      this.setCutoff(cutoffHz, sampleRate);
  }

  /** -3 dB corner in Hz. */
  setCutoff(hz: number, sampleRate: number): void {
    this.g = Math.tan(
      (Math.PI * clamp(hz, 0.01, sampleRate * 0.49)) / sampleRate,
    );
    this.k = this.g / (1 + this.g);
  }

  next(x: number): number {
    const v = (x - this.s) * this.k;
    const y = v + this.s;
    this.s = y + v;
    return x - y;
  }

  process(buf: Float32Array, n: number): void {
    const k = this.k;
    let s = this.s;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const v = (x - s) * k;
      const y = v + s;
      s = y + v;
      buf[i] = x - y;
    }
    this.s = s;
  }

  /** Linear gain at `hz`. */
  magnitude(hz: number, sampleRate: number): number {
    if (hz >= sampleRate * 0.5) return 1;
    const t = Math.tan((Math.PI * hz) / sampleRate) / this.g;
    return t / Math.sqrt(1 + t * t);
  }

  reset(): void {
    this.s = 0;
  }
}

/** DC blocker: y[n] = x[n] - x[n-1] + R·y[n-1], -3 dB at `cutoffHz` (default 20 Hz). */
export class DcBlocker {
  private r: number;
  private x1 = 0;
  private y1 = 0;

  constructor(sampleRate: number, cutoffHz = 20) {
    this.r = 1 - (TAU * cutoffHz) / sampleRate;
  }

  next(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  process(buf: Float32Array, n: number): void {
    const r = this.r;
    let x1 = this.x1;
    let y1 = this.y1;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      y1 = x - x1 + r * y1;
      x1 = x;
      buf[i] = y1;
    }
    this.x1 = x1;
    this.y1 = y1;
  }

  reset(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}

/** First-order allpass H(z) = (a + z^-1) / (1 + a·z^-1), |a| < 1. */
export class Allpass1 {
  a: number;
  private x1 = 0;
  private y1 = 0;

  constructor(a = 0) {
    this.a = a;
  }

  next(x: number): number {
    const y = this.a * (x - this.y1) + this.x1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = 0;
    this.y1 = 0;
  }
}

/** Phase delay in samples of Allpass1 with coefficient `a` at `omega` rad/sample. */
export function allpassPhaseDelay(a: number, omega: number): number {
  const s = Math.sin(omega);
  const c = Math.cos(omega);
  return (Math.atan2(s, a + c) - Math.atan2(a * s, 1 + a * c)) / omega;
}

/** Allpass1 coefficient whose phase delay is exactly `delay` samples (0.1..1.9) at `omega`. */
export function allpassCoefForDelay(delay: number, omega: number): number {
  return (
    Math.sin(((1 - delay) * omega) / 2) / Math.sin(((1 + delay) * omega) / 2)
  );
}

/**
 * RBJ "Audio EQ Cookbook" biquad, transposed direct form II. Call one of the
 * set* methods, then next()/process(). Coefficients are public for inspection.
 */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private z1 = 0;
  private z2 = 0;

  private assign(
    b0: number,
    b1: number,
    b2: number,
    a0: number,
    a1: number,
    a2: number,
  ): this {
    const inv = 1 / a0;
    this.b0 = b0 * inv;
    this.b1 = b1 * inv;
    this.b2 = b2 * inv;
    this.a1 = a1 * inv;
    this.a2 = a2 * inv;
    return this;
  }

  /** 12 dB/octave low-pass; q = 0.7071 is Butterworth. */
  setLowpass(hz: number, q: number, sampleRate: number): this {
    const w = (TAU * clamp(hz, 1, sampleRate * 0.49)) / sampleRate;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return this.assign(
      (1 - c) / 2,
      1 - c,
      (1 - c) / 2,
      1 + alpha,
      -2 * c,
      1 - alpha,
    );
  }

  /** 12 dB/octave high-pass. */
  setHighpass(hz: number, q: number, sampleRate: number): this {
    const w = (TAU * clamp(hz, 1, sampleRate * 0.49)) / sampleRate;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return this.assign(
      (1 + c) / 2,
      -(1 + c),
      (1 + c) / 2,
      1 + alpha,
      -2 * c,
      1 - alpha,
    );
  }

  /** Band-pass with 0 dB peak gain at `hz`; bandwidth = hz / q. */
  setBandpass(hz: number, q: number, sampleRate: number): this {
    const w = (TAU * clamp(hz, 1, sampleRate * 0.49)) / sampleRate;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return this.assign(alpha, 0, -alpha, 1 + alpha, -2 * c, 1 - alpha);
  }

  /** Notch at `hz`. */
  setNotch(hz: number, q: number, sampleRate: number): this {
    const w = (TAU * clamp(hz, 1, sampleRate * 0.49)) / sampleRate;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return this.assign(1, -2 * c, 1, 1 + alpha, -2 * c, 1 - alpha);
  }

  /** Second-order allpass (flat magnitude, phase turns around `hz`). */
  setAllpass(hz: number, q: number, sampleRate: number): this {
    const w = (TAU * clamp(hz, 1, sampleRate * 0.49)) / sampleRate;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    return this.assign(
      1 - alpha,
      -2 * c,
      1 + alpha,
      1 + alpha,
      -2 * c,
      1 - alpha,
    );
  }

  /** Peaking EQ: `gainDb` boost/cut at `hz`, bandwidth = hz / q. */
  setPeak(hz: number, q: number, gainDb: number, sampleRate: number): this {
    const w = (TAU * clamp(hz, 1, sampleRate * 0.49)) / sampleRate;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a = Math.pow(10, gainDb / 40);
    return this.assign(
      1 + alpha * a,
      -2 * c,
      1 - alpha * a,
      1 + alpha / a,
      -2 * c,
      1 - alpha / a,
    );
  }

  /** Low shelf: `gainDb` below `hz` (slope 1 = steepest without overshoot). */
  setLowShelf(
    hz: number,
    gainDb: number,
    sampleRate: number,
    slope = 1,
  ): this {
    const w = (TAU * clamp(hz, 1, sampleRate * 0.49)) / sampleRate;
    const c = Math.cos(w);
    const a = Math.pow(10, gainDb / 40);
    const alpha =
      (Math.sin(w) / 2) * Math.sqrt((a + 1 / a) * (1 / slope - 1) + 2);
    const k = 2 * Math.sqrt(a) * alpha;
    return this.assign(
      a * (a + 1 - (a - 1) * c + k),
      2 * a * (a - 1 - (a + 1) * c),
      a * (a + 1 - (a - 1) * c - k),
      a + 1 + (a - 1) * c + k,
      -2 * (a - 1 + (a + 1) * c),
      a + 1 + (a - 1) * c - k,
    );
  }

  /** High shelf: `gainDb` above `hz`. */
  setHighShelf(
    hz: number,
    gainDb: number,
    sampleRate: number,
    slope = 1,
  ): this {
    const w = (TAU * clamp(hz, 1, sampleRate * 0.49)) / sampleRate;
    const c = Math.cos(w);
    const a = Math.pow(10, gainDb / 40);
    const alpha =
      (Math.sin(w) / 2) * Math.sqrt((a + 1 / a) * (1 / slope - 1) + 2);
    const k = 2 * Math.sqrt(a) * alpha;
    return this.assign(
      a * (a + 1 + (a - 1) * c + k),
      -2 * a * (a - 1 + (a + 1) * c),
      a * (a + 1 + (a - 1) * c - k),
      a + 1 - (a - 1) * c + k,
      2 * (a - 1 - (a + 1) * c),
      a + 1 - (a - 1) * c - k,
    );
  }

  next(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  process(buf: Float32Array, n: number): void {
    const b0 = this.b0;
    const b1 = this.b1;
    const b2 = this.b2;
    const a1 = this.a1;
    const a2 = this.a2;
    let z1 = this.z1;
    let z2 = this.z2;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = z1;
    this.z2 = z2;
  }

  /** Linear gain of the current coefficients at `hz`. */
  magnitude(hz: number, sampleRate: number): number {
    const w = (TAU * hz) / sampleRate;
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2;
    const ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2;
    const di = -(this.a1 * s1 + this.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/** Three sections of a chain in one pass (see biquadChain). */
function chainOfThree(
  filters: readonly Biquad[],
  first: number,
  buf: Float32Array,
  n: number,
): void {
  const a = filters[first];
  const b = filters[first + 1];
  const c = filters[first + 2];
  const ab0 = a.b0;
  const ab1 = a.b1;
  const ab2 = a.b2;
  const aa1 = a.a1;
  const aa2 = a.a2;
  const bb0 = b.b0;
  const bb1 = b.b1;
  const bb2 = b.b2;
  const ba1 = b.a1;
  const ba2 = b.a2;
  const cb0 = c.b0;
  const cb1 = c.b1;
  const cb2 = c.b2;
  const ca1 = c.a1;
  const ca2 = c.a2;
  let a1 = 0;
  let a2 = 0;
  let b1 = 0;
  let b2 = 0;
  let c1 = 0;
  let c2 = 0;
  for (let i = 0; i < n; i++) {
    let x = buf[i];
    let y = ab0 * x + a1;
    a1 = ab1 * x - aa1 * y + a2;
    a2 = ab2 * x - aa2 * y;
    // rounded exactly as a write to the Float32Array between two passes would
    x = Math.fround(y);
    y = bb0 * x + b1;
    b1 = bb1 * x - ba1 * y + b2;
    b2 = bb2 * x - ba2 * y;
    x = Math.fround(y);
    y = cb0 * x + c1;
    c1 = cb1 * x - ca1 * y + c2;
    c2 = cb2 * x - ca2 * y;
    buf[i] = y;
  }
}

/** Two sections of a chain in one pass (see biquadChain). */
function chainOfTwo(
  filters: readonly Biquad[],
  first: number,
  buf: Float32Array,
  n: number,
): void {
  const a = filters[first];
  const b = filters[first + 1];
  const ab0 = a.b0;
  const ab1 = a.b1;
  const ab2 = a.b2;
  const aa1 = a.a1;
  const aa2 = a.a2;
  const bb0 = b.b0;
  const bb1 = b.b1;
  const bb2 = b.b2;
  const ba1 = b.a1;
  const ba2 = b.a2;
  let a1 = 0;
  let a2 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    let x = buf[i];
    let y = ab0 * x + a1;
    a1 = ab1 * x - aa1 * y + a2;
    a2 = ab2 * x - aa2 * y;
    x = Math.fround(y);
    y = bb0 * x + b1;
    b1 = bb1 * x - ba1 * y + b2;
    b2 = bb2 * x - ba2 * y;
    buf[i] = y;
  }
}

/**
 * Run buf[0 .. n) through `filters` one after the other, every filter
 * starting at rest: the same samples, bit for bit, as reset() + process() on
 * each in turn, in about half the time. Three sections share a pass, so the
 * CPU overlaps their recurrences (more per pass is slower again: the JIT
 * runs out of registers). The filters' own states are not touched.
 */
export function biquadChain(
  filters: readonly Biquad[],
  buf: Float32Array,
  n: number,
): void {
  const count = filters.length;
  let k = 0;
  // 4 sections go as 2 + 2, everything else as threes and one rest
  for (; count - k >= 3 && count - k !== 4; k += 3)
    chainOfThree(filters, k, buf, n);
  for (; count - k >= 2; k += 2) chainOfTwo(filters, k, buf, n);
  if (k < count) {
    const last = filters[k];
    const b0 = last.b0;
    const b1 = last.b1;
    const b2 = last.b2;
    const a1 = last.a1;
    const a2 = last.a2;
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
  }
}

/**
 * Zero-delay-feedback (TPT) state-variable filter, 12 dB/octave. Stable under
 * audio-rate cutoff modulation: call set() as often as every sample.
 * low()/band()/high() each process ONE sample and return that response;
 * tick() processes one sample and leaves all three in lp / bp / hp.
 */
export class Svf {
  /** outputs of the last tick() */
  lp = 0;
  bp = 0;
  hp = 0;
  private g = 0;
  private k = 1;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private ic1 = 0;
  private ic2 = 0;

  constructor(cutoffHz?: number, q?: number, sampleRate?: number) {
    if (cutoffHz !== undefined && sampleRate !== undefined)
      this.set(cutoffHz, q ?? Math.SQRT1_2, sampleRate);
  }

  /** Cutoff in Hz and resonance q (0.5 = no peak, 0.7071 = Butterworth, > 4 = strongly resonant). */
  set(hz: number, q: number, sampleRate: number): void {
    const g = Math.tan(
      (Math.PI * clamp(hz, 5, sampleRate * 0.49)) / sampleRate,
    );
    const k = 1 / (q < 0.2 ? 0.2 : q);
    this.g = g;
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /** Process one sample; read lp / bp / hp afterwards. */
  tick(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
  }

  /** Low-pass one sample. */
  low(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }

  /** Band-pass one sample (peak gain q; multiply by 1/q for unity peak). */
  band(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v1;
  }

  /** High-pass one sample. */
  high(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return x - this.k * v1 - v2;
  }

  /** In-place low-pass of buf[0..n) with the current settings. */
  process(buf: Float32Array, n: number): void {
    const a1 = this.a1;
    const a2 = this.a2;
    const a3 = this.a3;
    let ic1 = this.ic1;
    let ic2 = this.ic2;
    for (let i = 0; i < n; i++) {
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

  /** Linear gain of the low-pass output at `hz` for the current settings. */
  magnitude(hz: number, sampleRate: number): number {
    return svfLowpassMagnitude(hz, this.g, this.k, sampleRate);
  }

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
    this.lp = 0;
    this.bp = 0;
    this.hp = 0;
  }
}

function svfLowpassMagnitude(
  hz: number,
  g: number,
  k: number,
  sampleRate: number,
): number {
  if (hz >= sampleRate * 0.5) return 0;
  const s = Math.tan((Math.PI * hz) / sampleRate) / g;
  const re = 1 - s * s;
  const im = k * s;
  return 1 / Math.sqrt(re * re + im * im);
}

/** Linear gain at `hz` of an Svf low-pass set to (cutoffHz, q) without building one. */
export function svfLowpassGain(
  hz: number,
  cutoffHz: number,
  q: number,
  sampleRate: number,
): number {
  const g = Math.tan(
    (Math.PI * clamp(cutoffHz, 5, sampleRate * 0.49)) / sampleRate,
  );
  return svfLowpassMagnitude(hz, g, 1 / (q < 0.2 ? 0.2 : q), sampleRate);
}
