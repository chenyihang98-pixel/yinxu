/**
 * Circular delay line with integer, linear, cubic and allpass-interpolated
 * taps. Convention: read*(d) returns the sample written d writes ago, so
 * `y = line.read(d); line.write(x + feedback * y)` is a d-sample feedback loop
 * (d >= 1) and, after write(x), read(1) === x.
 */
import { nextPow2 } from "./math";

export class DelayLine {
  /** power-of-two storage; index with `& mask` */
  readonly buffer: Float32Array;
  readonly mask: number;
  /** position the next write() will fill */
  index = 0;
  private allpassState = 0;

  /** `maxDelay` = longest delay in samples that will ever be read. */
  constructor(maxDelay: number) {
    const size = nextPow2(Math.ceil(maxDelay) + 4);
    this.buffer = new Float32Array(size);
    this.mask = size - 1;
  }

  /** Store one sample and advance. */
  write(x: number): void {
    this.buffer[this.index] = x;
    this.index = (this.index + 1) & this.mask;
  }

  /** Integer tap, delay >= 1. */
  read(delay: number): number {
    return this.buffer[(this.index - delay) & this.mask];
  }

  /** Fractional tap by linear interpolation (delay >= 1). Smooth under modulation, slightly dull. */
  readLinear(delay: number): number {
    const whole = Math.floor(delay);
    const frac = delay - whole;
    const i = this.index - whole;
    const a = this.buffer[i & this.mask];
    return a + (this.buffer[(i - 1) & this.mask] - a) * frac;
  }

  /** Fractional tap by 4-point Hermite interpolation (delay >= 2). Flatter than linear, safe to modulate. */
  readCubic(delay: number): number {
    const whole = Math.floor(delay);
    const t = delay - whole;
    const i = this.index - whole;
    const xm1 = this.buffer[(i + 1) & this.mask];
    const x0 = this.buffer[i & this.mask];
    const x1 = this.buffer[(i - 1) & this.mask];
    const x2 = this.buffer[(i - 2) & this.mask];
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    return ((a * t - (w + a)) * t + c) * t + x0;
  }

  /**
   * Fractional tap through a first-order allpass (delay >= 1.1): exactly flat
   * magnitude, so feedback loops keep their tuning AND brightness. Stateful —
   * use one line per tap and only for a fixed or slowly gliding delay.
   */
  readAllpass(delay: number): number {
    let whole = Math.floor(delay - 0.1);
    if (whole < 1) whole = 1;
    const frac = delay - whole;
    const eta = (1 - frac) / (1 + frac);
    const i = this.index - whole;
    const y =
      eta * (this.buffer[i & this.mask] - this.allpassState) +
      this.buffer[(i - 1) & this.mask];
    this.allpassState = y;
    return y;
  }

  /** Zero the line. */
  clear(): void {
    this.buffer.fill(0);
    this.allpassState = 0;
  }
}
