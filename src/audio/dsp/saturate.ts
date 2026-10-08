/**
 * Saturation curves and a 2x oversampler for running any nonlinearity with
 * less aliasing. softclip.ts (the contract's final master clipper) is a
 * separate thing; these are for colour inside voices and effects.
 */

/** Fast tanh (Padé 3/2, exact ±1 beyond |x| >= 3, error below 2.5 %, smooth everywhere). */
export function fastTanh(x: number): number {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/**
 * Tanh drive that keeps full scale at full scale: ±1 maps to ±1 and quiet
 * signals are raised by drive / tanh(drive). drive 0.5 = subtle, 2 = obvious, 5 = fuzz.
 */
export function tanhDrive(x: number, drive: number): number {
  return fastTanh(x * drive) / fastTanh(drive);
}

/** Cubic soft clip: linear near 0, exactly ±1 for |x| >= 1 (only 3rd harmonic for small signals). */
export function cubicSat(x: number): number {
  if (x >= 1) return 1;
  if (x <= -1) return -1;
  return 1.5 * x - 0.5 * x * x * x;
}

/**
 * Asymmetric tanh (adds even harmonics): tanh(x + bias) - tanh(bias).
 * The output has a small signal-dependent DC, so follow it with a DcBlocker.
 */
export function asymSat(x: number, bias: number): number {
  return fastTanh(x + bias) - fastTanh(bias);
}

const HALF = 11; // taps run from -HALF..HALF; even taps (except 0) are zero
const ODD_TAPS = HALF + 1; // 12 non-zero odd taps

/** Odd-indexed taps h[-11], h[-9] … h[11] of a Kaiser-windowed half-band low-pass. */
const HALFBAND_ODD: Float64Array = (() => {
  const beta = 5.65;
  const bessel = (x: number) => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 30; k++) {
      term *= (x / (2 * k)) * (x / (2 * k));
      sum += term;
    }
    return sum;
  };
  const taps = new Float64Array(ODD_TAPS);
  for (let i = 0; i < ODD_TAPS; i++) {
    const n = 2 * i - HALF;
    const sinc = Math.sin((Math.PI * n) / 2) / (Math.PI * n);
    const window =
      bessel(beta * Math.sqrt(1 - (n / (HALF + 1)) * (n / (HALF + 1)))) /
      bessel(beta);
    taps[i] = sinc * window;
  }
  // make the DC gain exactly 1: 0.5 (centre) + Σ odd taps = 1
  let sum = 0;
  for (let i = 0; i < ODD_TAPS; i++) sum += taps[i];
  for (let i = 0; i < ODD_TAPS; i++) taps[i] *= 0.5 / sum;
  return taps;
})();

/**
 * 2x oversampler (23-tap half-band FIR each way): flat to about 16 kHz at
 * 48 kHz, about 60 dB of image/alias rejection. Constant latency of
 * Oversampler2x.LATENCY samples at the base rate.
 */
export class Oversampler2x {
  /** samples of delay through up() + down() at the base rate */
  static readonly LATENCY = 12;
  /** the two samples produced by the last up() (earlier first) */
  a = 0;
  b = 0;
  private readonly input = new Float64Array(16);
  private inputPos = 0;
  private readonly high = new Float64Array(32);
  private highPos = 0;

  /** Feed one base-rate sample; read the two double-rate samples from `a` then `b`. */
  up(x: number): void {
    const ring = this.input;
    const p = (this.inputPos + 1) & 15;
    this.inputPos = p;
    ring[p] = x;
    let odd = 0;
    for (let i = 0; i < ODD_TAPS; i++)
      odd += HALFBAND_ODD[i] * ring[(p - i) & 15];
    this.a = ring[(p - 6) & 15];
    this.b = 2 * odd;
  }

  /** Feed the two (processed) double-rate samples; returns one base-rate sample. */
  down(a: number, b: number): number {
    const ring = this.high;
    let q = (this.highPos + 1) & 31;
    ring[q] = a;
    q = (q + 1) & 31;
    ring[q] = b;
    this.highPos = q;
    // centred on an `a` sample so the total latency is a whole 12 samples
    let sum = 0.5 * ring[(q - 13) & 31];
    for (let i = 0; i < ODD_TAPS; i++)
      sum += HALFBAND_ODD[i] * ring[(q - 2 - 2 * i) & 31];
    return sum;
  }

  /** One sample through `shaper` evaluated at twice the sample rate. */
  process(x: number, shaper: (v: number) => number): number {
    this.up(x);
    return this.down(shaper(this.a), shaper(this.b));
  }

  /** Clear the filter memory. */
  reset(): void {
    this.input.fill(0);
    this.high.fill(0);
    this.a = 0;
    this.b = 0;
  }
}

/**
 * In-place tanhDrive over buf[0..n). Pass an Oversampler2x to run the curve
 * at 2x (adds its latency); without one it runs at the base rate.
 */
export function saturateBlock(
  buf: Float32Array,
  n: number,
  drive: number,
  oversampler?: Oversampler2x,
): void {
  const norm = 1 / fastTanh(drive);
  if (!oversampler) {
    for (let i = 0; i < n; i++) buf[i] = fastTanh(buf[i] * drive) * norm;
    return;
  }
  for (let i = 0; i < n; i++) {
    oversampler.up(buf[i]);
    buf[i] =
      oversampler.down(
        fastTanh(oversampler.a * drive),
        fastTanh(oversampler.b * drive),
      ) * norm;
  }
}
