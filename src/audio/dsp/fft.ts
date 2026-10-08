/**
 * Small radix-2 FFT and spectrum helpers for analysis (tests, loudness and
 * calibration scripts). Not meant for per-sample audio paths.
 */
import { TAU, nextPow2 } from "./math";

/**
 * In-place complex FFT of length 2^k. `inverse` computes the unscaled inverse
 * transform (divide by the length yourself).
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n < 2) return;
  if ((n & (n - 1)) !== 0 || im.length !== n)
    throw new Error("fft: length must be a power of two");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size *= 2) {
    const half = size >> 1;
    const angle = (sign * TAU) / size;
    const stepR = Math.cos(angle);
    const stepI = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const next = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR;
        wr = next;
      }
    }
  }
}

/** Periodic Hann window of length n. */
export function hannWindow(n: number): Float64Array {
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((TAU * i) / n);
  return window;
}

export interface Spectrum {
  /** power per bin, bins 0 .. size/2 (window-compensated: a full-scale sine sums to about 0.5) */
  power: Float64Array;
  /** width of one bin in Hz */
  binHz: number;
}

/**
 * Hann-windowed power spectrum of signal[start .. start + length), zero-padded
 * to a power of two (at least `minSize`).
 */
export function powerSpectrum(
  signal: ArrayLike<number>,
  sampleRate: number,
  start = 0,
  length = signal.length - start,
  minSize = 0,
): Spectrum {
  const count = Math.max(0, Math.min(length, signal.length - start));
  const size = nextPow2(Math.max(count, minSize, 2));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let windowPower = 0;
  for (let i = 0; i < count; i++) {
    const w = 0.5 - 0.5 * Math.cos((TAU * i) / count);
    re[i] = signal[start + i] * w;
    windowPower += w * w;
  }
  fft(re, im);
  const power = new Float64Array(size / 2 + 1);
  // Parseval: Σ|X|² / size = Σ x²; normalise to mean square of the unwindowed signal
  const norm = windowPower > 0 ? 2 / (size * windowPower) : 0;
  for (let k = 0; k <= size / 2; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) * norm;
    power[k] = k === 0 || k === size / 2 ? p / 2 : p;
  }
  return { power, binHz: sampleRate / size };
}

/** Power-weighted mean frequency in Hz of a spectrum (optionally inside [lowHz, highHz]). */
export function spectralCentroid(
  spectrum: Spectrum,
  lowHz = 0,
  highHz = Infinity,
): number {
  let weighted = 0;
  let total = 0;
  for (let k = 1; k < spectrum.power.length; k++) {
    const hz = k * spectrum.binHz;
    if (hz < lowHz || hz > highHz) continue;
    weighted += hz * spectrum.power[k];
    total += spectrum.power[k];
  }
  return total > 0 ? weighted / total : 0;
}

/** Sum of the power between two frequencies (same units as Spectrum.power). */
export function bandPower(
  spectrum: Spectrum,
  lowHz: number,
  highHz: number,
): number {
  const from = Math.max(0, Math.ceil(lowHz / spectrum.binHz));
  const to = Math.min(
    spectrum.power.length - 1,
    Math.floor(highHz / spectrum.binHz),
  );
  let total = 0;
  for (let k = from; k <= to; k++) total += spectrum.power[k];
  return total;
}
