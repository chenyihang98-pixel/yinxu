/**
 * Extended Karplus-Strong string (Jaffe/Smith): a delay loop closed through a
 * tuning allpass, optional dispersion allpasses (stiffness) and a one-pole
 * loss filter. The loop is tuned so the FUNDAMENTAL is exact for any loss or
 * stiffness setting, and decay is specified as T60 at two frequencies.
 *
 *   excitation -> (+) -----------------------------------------> output
 *                  ^                                          |
 *                  +-- loss <- dispersion <- allpass <- z^-N -+
 */
import { LN_60DB, TAU, clamp, nextPow2 } from "./math";
import { allpassCoefForDelay, allpassPhaseDelay } from "./filters";
import type { Random } from "./rng";
import { WhiteNoise } from "./noise";

const MAX_DISPERSION = 4;
const MIN_FRACTION = 0.2;

export class KarplusString {
  readonly sampleRate: number;
  private readonly line: Float32Array;
  private readonly mask: number;
  private write = 0;
  private hz = 440;
  private delayInt = 2;
  // tuning allpass
  private eta = 0;
  private apX = 0;
  private apY = 0;
  // dispersion allpasses (shared coefficient)
  private dispCoef = 0;
  private dispCount = 0;
  private readonly dispX = new Float64Array(MAX_DISPERSION);
  private readonly dispY = new Float64Array(MAX_DISPERSION);
  // loss filter y = b·x + pole·y
  private pole = 0;
  private lossB = 0.99;
  private lossY = 0;
  // queued excitation
  private excitation: Float32Array | null = null;
  private excitationPos = 0;
  private excitationEnd = 0;
  // varispeed read-out for bends
  private h0 = 0;
  private h1 = 0;
  private h2 = 0;
  private h3 = 0;
  private frac = 0;

  /** `lowestHz` sizes the delay line: the string can never be tuned below it. */
  constructor(sampleRate: number, lowestHz = 20) {
    this.sampleRate = sampleRate;
    const size = nextPow2(Math.ceil(sampleRate / lowestHz) + 8);
    this.line = new Float32Array(size);
    this.mask = size - 1;
    this.retune();
  }

  /** Fundamental in Hz (takes effect immediately, state is kept). */
  setFrequency(hz: number): void {
    this.hz = clamp(hz, this.sampleRate / (this.mask - 6), this.sampleRate / 4);
    this.retune();
  }

  /**
   * Ring time: T60 (seconds) of the fundamental and of a partial at `highHz`.
   * Call again at note-off with short times to damp the string naturally.
   */
  setDecay(t60: number, t60High: number, highHz = 4000): void {
    const sr = this.sampleRate;
    const f0 = this.hz;
    const f1 = Math.min(Math.max(highHz, f0 * 1.5), sr * 0.45);
    // losses grow about with f², keep the request consistent if f1 moved
    const scale = (highHz / f1) * (highHz / f1);
    const low = Math.max(t60, 1e-3);
    const high = Math.min(Math.max(t60High * Math.min(1, scale), 1e-4), low);
    const lnG0 = -LN_60DB / (f0 * low);
    const lnG1 = -LN_60DB / (f0 * high);
    const c0 = Math.cos((TAU * f0) / sr);
    const c1 = Math.cos((TAU * f1) / sr);
    const r2 = Math.exp(2 * (lnG1 - lnG0));
    let pole = 0;
    if (r2 < 1 - 1e-9) {
      const b = (r2 * c1 - c0) / (r2 - 1);
      pole = b > 1 ? b - Math.sqrt(b * b - 1) : 0.97;
    }
    pole = clamp(pole, 0, 0.97);
    const gain = Math.min(
      1,
      (Math.exp(lnG0) * Math.sqrt(1 - 2 * pole * c0 + pole * pole)) /
        (1 - pole),
    );
    this.pole = pole;
    this.lossB = gain * (1 - pole);
    this.retune();
  }

  /**
   * Stiffness: `sections` (0..4) first-order allpasses with coefficient
   * `coef` (-0.9..0). More negative / more sections = sharper upper partials.
   */
  setDispersion(coef: number, sections = 1): void {
    this.dispCoef = clamp(coef, -0.9, 0);
    this.dispCount =
      this.dispCoef === 0 ? 0 : clamp(Math.round(sections), 0, MAX_DISPERSION);
    this.retune();
  }

  private retune(): void {
    const omega = (TAU * this.hz) / this.sampleRate;
    const lossDelay =
      Math.atan2(this.pole * Math.sin(omega), 1 - this.pole * Math.cos(omega)) /
      omega;
    const dispersionDelay =
      this.dispCount * allpassPhaseDelay(this.dispCoef, omega);
    const rest = this.sampleRate / this.hz - lossDelay - dispersionDelay;
    let whole = Math.floor(rest - MIN_FRACTION);
    if (whole < 1) whole = 1;
    const fraction = Math.max(MIN_FRACTION, rest - whole);
    this.delayInt = whole;
    this.eta = allpassCoefForDelay(fraction, omega);
  }

  /** Samples per cycle of the fundamental. */
  get period(): number {
    return this.sampleRate / this.hz;
  }

  /** T60 in seconds of a partial at `hz` with the current decay settings. */
  t60At(hz: number): number {
    const c = Math.cos((TAU * hz) / this.sampleRate);
    const magnitude =
      this.lossB / Math.sqrt(1 - 2 * this.pole * c + this.pole * this.pole);
    if (magnitude >= 1) return Infinity;
    return -LN_60DB / (this.hz * Math.log(magnitude));
  }

  /** Queue `length` samples of excitation; next()/nextBent() feed them into the loop. */
  excite(samples: Float32Array, length: number): void {
    this.excitation = samples;
    this.excitationPos = 0;
    this.excitationEnd = length;
  }

  /** One sample of the loop driven by `input` (use for bowed/continuous excitation). */
  tick(input: number): number {
    const line = this.line;
    const w = this.write;
    const d = line[(w - this.delayInt) & this.mask];
    let s = this.eta * (d - this.apY) + this.apX;
    this.apX = d;
    this.apY = s;
    if (this.dispCount > 0) {
      const a = this.dispCoef;
      const xs = this.dispX;
      const ys = this.dispY;
      for (let i = 0; i < this.dispCount; i++) {
        const y = a * (s - ys[i]) + xs[i];
        xs[i] = s;
        ys[i] = y;
        s = y;
      }
    }
    const lossY = this.lossB * s + this.pole * this.lossY;
    this.lossY = lossY;
    const y = input + lossY;
    line[w] = y;
    this.write = (w + 1) & this.mask;
    return y;
  }

  /** One sample, fed from the queued excitation. */
  next(): number {
    let input = 0;
    if (this.excitationPos < this.excitationEnd)
      input = (this.excitation as Float32Array)[this.excitationPos++];
    return this.tick(input);
  }

  /**
   * Block version of next(): overwrite out[offset .. offset + n) with the
   * string output, fed from the queued excitation. Fastest way to render.
   */
  process(out: Float32Array, offset: number, n: number): void {
    const line = this.line;
    const mask = this.mask;
    const delay = this.delayInt;
    const eta = this.eta;
    const pole = this.pole;
    const lossB = this.lossB;
    const dispCount = this.dispCount;
    const a = this.dispCoef;
    const xs = this.dispX;
    const ys = this.dispY;
    const excitation = this.excitation;
    const excitationEnd = excitation ? this.excitationEnd : 0;
    let excitationPos = this.excitationPos;
    let w = this.write;
    let apX = this.apX;
    let apY = this.apY;
    let lossY = this.lossY;
    for (let i = 0; i < n; i++) {
      const d = line[(w - delay) & mask];
      let s = eta * (d - apY) + apX;
      apX = d;
      apY = s;
      for (let j = 0; j < dispCount; j++) {
        const y = a * (s - ys[j]) + xs[j];
        xs[j] = s;
        ys[j] = y;
        s = y;
      }
      lossY = lossB * s + pole * lossY;
      let y = lossY;
      if (excitationPos < excitationEnd)
        y += (excitation as Float32Array)[excitationPos++];
      line[w] = y;
      w = (w + 1) & mask;
      out[offset + i] = y;
    }
    this.write = w;
    this.apX = apX;
    this.apY = apY;
    this.lossY = lossY;
    this.excitationPos = excitationPos;
  }

  /**
   * One sample read at `ratio` times normal speed (ratio = 2^(semitones/12),
   * 0.25..2): the whole string sound is bent, like changing its tension.
   * Use nextBent() for the WHOLE note when a note bends (it has a constant
   * 2-sample latency); ratio 1 settles back onto the unbent pitch exactly.
   */
  nextBent(ratio: number): number {
    let frac = this.frac;
    if (ratio === 1 && frac !== 0) {
      // slide onto a whole sample so the steady state is a pure delay
      frac += 1 + Math.min(0.002, 1 - frac);
      if (frac >= 2 - 1e-9) frac = 2;
    } else frac += ratio;
    while (frac >= 1) {
      frac -= 1;
      this.h0 = this.h1;
      this.h1 = this.h2;
      this.h2 = this.h3;
      this.h3 = this.next();
    }
    this.frac = frac;
    const c = (this.h2 - this.h0) * 0.5;
    const v = this.h1 - this.h2;
    const w = c + v;
    const a = w + v + (this.h3 - this.h1) * 0.5;
    return ((a * frac - (w + a)) * frac + c) * frac + this.h1;
  }

  /** Output from `delay` samples ago (integer, 0..period): a second pickup/microphone tap. */
  tap(delay: number): number {
    return this.line[(this.write - 1 - delay) & this.mask];
  }

  /** Silence the string and drop any queued excitation. */
  reset(): void {
    this.line.fill(0);
    this.apX = 0;
    this.apY = 0;
    this.dispX.fill(0);
    this.dispY.fill(0);
    this.lossY = 0;
    this.excitation = null;
    this.excitationPos = 0;
    this.excitationEnd = 0;
    this.h0 = 0;
    this.h1 = 0;
    this.h2 = 0;
    this.h3 = 0;
    this.frac = 0;
  }
}

export interface PluckOptions {
  sampleRate: number;
  /** samples per cycle of the string (KarplusString.period) */
  period: number;
  /** 0.03..0.5: where along the string it is plucked (0.5 = middle, small = near the bridge) */
  position: number;
  /** one-pole low-pass corner that sets the overall tilt, usually 1.5–3 × the fundamental */
  bodyHz: number;
  /** -6 dB point of the plectrum/finger: the pulse is a Hann bump sampleRate / hardnessHz long */
  hardnessHz: number;
  /**
   * 0..1 share of the energy that comes from a noise burst one period long.
   * It randomises the harmonic amplitudes of every note: about ±0.5 dB of
   * level at 0.03, ±3 dB at 0.2, the classic "every pluck differs" Karplus-
   * Strong at 1. Keep it small where notes must sit at a steady level.
   */
  noise: number;
}

function pluckCombDelay(options: PluckOptions): number {
  return Math.max(1, Math.round(options.position * options.period));
}

function pluckPulseWidth(options: PluckOptions): number {
  return clamp(Math.round(options.sampleRate / options.hardnessHz), 4, 96);
}

function pluckTiltCoef(options: PluckOptions): number {
  const sr = options.sampleRate;
  return 1 - Math.exp((-TAU * clamp(options.bodyHz, 10, sr * 0.45)) / sr);
}

const hannKernels = new Map<number, Float64Array>();

/** 1 − cos(2π·j / width) for j = 0 .. width − 1, kept per width. */
function hannKernel(width: number): Float64Array {
  let kernel = hannKernels.get(width);
  if (!kernel) {
    kernel = new Float64Array(width);
    for (let j = 0; j < width; j++) kernel[j] = 1 - Math.cos((TAU * j) / width);
    hannKernels.set(width, kernel);
  }
  return kernel;
}

/** Samples makePluck() needs for these options (size the buffer with it). */
export function pluckLength(options: PluckOptions): number {
  const ring = Math.ceil(
    (6 * options.sampleRate) / (TAU * Math.max(options.bodyHz, 10)),
  );
  return (
    Math.ceil(options.period) +
    pluckCombDelay(options) +
    pluckPulseWidth(options) +
    Math.min(ring, 4096)
  );
}

/**
 * Write a pluck excitation into out[0..pluckLength): a smooth pulse (plus an
 * optional noise burst one period long) through a one-pole tilt low-pass and
 * the pick-position comb. It starts at exactly zero, and its EXPECTED
 * spectrum is pluckSpectrum() whatever the noise share, so levels stay
 * predictable. Returns the length written.
 */
export function makePluck(
  out: Float32Array,
  options: PluckOptions,
  random: Random,
): number {
  const length = Math.min(out.length, pluckLength(options));
  const noiseShare = clamp(options.noise, 0, 1);
  const burst = Math.min(length, Math.max(2, Math.round(options.period)));
  out.fill(0, 0, length);
  if (noiseShare > 0) {
    const noise = new WhiteNoise(random);
    let energy = 0;
    for (let i = 0; i < burst; i++) {
      const v = noise.next();
      out[i] = v;
      energy += v * v;
    }
    const scale = Math.sqrt(noiseShare / (energy > 0 ? energy : 1));
    for (let i = 0; i < burst; i++) out[i] *= scale;
  }
  out[0] += Math.sqrt(1 - noiseShare);
  // Hann pulse of unit area (kernel[0] = 0, so the excitation starts at zero)
  const width = pluckPulseWidth(options);
  const kernel = hannKernel(width);
  // the input ends with the burst, so the pulse has left it `width` samples later: the rest stays zero
  const reach = Math.min(length, burst + width);
  for (let i = reach - 1; i >= 0; i--) {
    let sum = 0;
    const taps = Math.min(width - 1, i);
    for (let j = 1; j <= taps; j++) sum += kernel[j] * out[i - j];
    out[i] = sum / width;
  }
  const tilt = pluckTiltCoef(options);
  let y = 0;
  for (let i = 0; i < length; i++) {
    y += tilt * (out[i] - y);
    out[i] = y;
  }
  const comb = pluckCombDelay(options);
  for (let i = length - 1; i >= comb; i--) out[i] -= out[i - comb];
  // let the truncated low-pass tail end on zero
  const fade = Math.min(64, length >> 1);
  for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade;
  return length;
}

/** Expected magnitude at `hz` of the excitation makePluck() writes for these options. */
export function pluckSpectrum(hz: number, options: PluckOptions): number {
  const w = (TAU * hz) / options.sampleRate;
  const width = pluckPulseWidth(options);
  // DTFT of the Hann pulse by rotating a phasor (one cos/sin pair in total)
  const stepR = Math.cos(w);
  const stepI = Math.sin(w);
  const turn = TAU / width;
  const hannR = Math.cos(turn);
  const hannI = Math.sin(turn);
  let pr = 1;
  let pi = 0;
  let hr = 1;
  let hi = 0;
  let re = 0;
  let im = 0;
  for (let j = 0; j < width; j++) {
    const tap = 1 - hr;
    re += tap * pr;
    im += tap * pi;
    let t = pr * stepR - pi * stepI;
    pi = pr * stepI + pi * stepR;
    pr = t;
    t = hr * hannR - hi * hannI;
    hi = hr * hannI + hi * hannR;
    hr = t;
  }
  const pulse = Math.sqrt(re * re + im * im) / width;
  const p = 1 - pluckTiltCoef(options);
  const lp = (1 - p) / Math.sqrt(1 - 2 * p * stepR + p * p);
  return pulse * lp * 2 * Math.abs(Math.sin((w * pluckCombDelay(options)) / 2));
}
