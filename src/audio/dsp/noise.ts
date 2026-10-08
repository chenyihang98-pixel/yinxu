/**
 * Noise sources. Each generator owns a small integer state seeded once (from
 * a number or from ONE draw of a parent Random), so the audio is repeatable
 * and the per-sample cost is a few integer operations.
 */
import type { Random } from "./rng";
import { seedFrom } from "./rng";

function toSeed(source: number | Random): number {
  const seed = typeof source === "number" ? source >>> 0 : seedFrom(source);
  const mixed = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) | 0;
  // xorshift32 must never hold 0
  return mixed === 0 ? 0x1234567 : mixed;
}

/** Uniform white noise in [-1, 1) (xorshift32), RMS 0.577. */
export class WhiteNoise {
  private state: number;

  constructor(source: number | Random) {
    this.state = toSeed(source);
  }

  /** Next sample in [-1, 1). */
  next(): number {
    let s = this.state;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.state = s;
    return s / 2147483648;
  }

  /** Overwrite out[0..n) with gain·noise. */
  fill(out: Float32Array, n: number, gain = 1): void {
    let s = this.state;
    const scale = gain / 2147483648;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      out[i] = s * scale;
    }
    this.state = s;
  }

  /** ADD gain·noise into out[0..n). */
  add(out: Float32Array, n: number, gain = 1): void {
    let s = this.state;
    const scale = gain / 2147483648;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      out[i] += s * scale;
    }
    this.state = s;
  }
}

/**
 * Pink (-3 dB/octave) noise: white noise through Paul Kellet's filter bank,
 * scaled to stay inside ±1 (RMS about 0.21).
 */
export class PinkNoise {
  private readonly white: WhiteNoise;
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;

  constructor(source: number | Random) {
    this.white = new WhiteNoise(source);
  }

  /** Next pink sample, nominally within [-1, 1]. */
  next(): number {
    const w = this.white.next();
    this.b0 = 0.99886 * this.b0 + w * 0.0555179;
    this.b1 = 0.99332 * this.b1 + w * 0.0750759;
    this.b2 = 0.969 * this.b2 + w * 0.153852;
    this.b3 = 0.8665 * this.b3 + w * 0.3104856;
    this.b4 = 0.55 * this.b4 + w * 0.5329522;
    this.b5 = -0.7616 * this.b5 - w * 0.016898;
    const pink =
      this.b0 +
      this.b1 +
      this.b2 +
      this.b3 +
      this.b4 +
      this.b5 +
      this.b6 +
      w * 0.5362;
    this.b6 = w * 0.115926;
    return pink * 0.11;
  }

  /** Overwrite out[0..n) with gain·pink noise. */
  fill(out: Float32Array, n: number, gain = 1): void {
    for (let i = 0; i < n; i++) out[i] = gain * this.next();
  }
}

/**
 * Console-style LFSR noise (15-bit, NES-like): a ±1 square whose value changes
 * `clockHz` times per second. `short` selects the 93-step metallic sequence.
 */
export class LfsrNoise {
  private register = 1;
  private phase = 0;
  private value = 1;
  private readonly inc: number;
  private readonly tap: number;

  constructor(clockHz: number, sampleRate: number, short = false) {
    this.inc = clockHz / sampleRate;
    this.tap = short ? 6 : 1;
  }

  /** Next sample, exactly -1 or 1. */
  next(): number {
    this.phase += this.inc;
    while (this.phase >= 1) {
      this.phase -= 1;
      const r = this.register;
      const bit = (r ^ (r >> this.tap)) & 1;
      this.register = (r >> 1) | (bit << 14);
      this.value = this.register & 1 ? -1 : 1;
    }
    return this.value;
  }
}
