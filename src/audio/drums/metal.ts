/**
 * Metal for hats, cymbals, gongs and jingles.
 *
 * A struck plate rings in hundreds of inharmonic modes — far too many to run
 * as oscillators for every hat of a piece. Instead each "alloy" is designed
 * once in the frequency domain (partials at exact FFT bins, any spectral
 * shape for free, band-limited by construction) and transformed into a
 * seamlessly looping table. A hit then reads the free-running table from a
 * random position and only applies envelopes — exactly how a drum machine
 * gates its always-running metal oscillators.
 *
 * Every alloy is split into three bands that add up to the full sound, so a
 * hit can let the highs die faster than the lows the way real cymbals do.
 * Tables are built lazily per sample rate (a few milliseconds each).
 */
import { TAU, createRng, fft, smoothstep } from "../dsp";
import type { Random } from "../dsp";

export interface Alloy {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  /** table length - 1 (lengths are powers of two) */
  mask: number;
  /** RMS of the three tables (their sum has RMS 1) */
  rms: readonly [number, number, number];
}

export type AlloyId = "hat" | "bronze" | "machine" | "cymbal";

interface Spec {
  /** log2 of the table length */
  bits: number;
  seed: number;
  /** crossover frequencies of the three bands, Hz */
  split: readonly [number, number];
  /** power of the noise floor relative to the partials */
  noise: number;
  /** spectral envelope applied to partials and noise */
  shape(hz: number): number;
  /** place the partials: put(hz, amplitude, phase in turns) */
  fill(put: (hz: number, amp: number, phase: number) => void, random: Random): void;
}

const highpass = (hz: number, corner: number, order: number) =>
  1 / Math.sqrt(1 + Math.pow(corner / hz, 2 * order));
const lowpass = (hz: number, corner: number, order: number) =>
  1 / Math.sqrt(1 + Math.pow(hz / corner, 2 * order));
/** Gaussian bump on a log-frequency axis, `width` in octaves. */
const bell = (hz: number, centre: number, width: number) => {
  const x = Math.log2(hz / centre) / width;
  return Math.exp(-0.5 * x * x);
};

/**
 * `count` partials between lo and hi; `power` < 1 packs more of them towards
 * the top (a plate gets denser with frequency).
 */
function scatter(
  put: (hz: number, amp: number, phase: number) => void,
  random: Random,
  count: number,
  lo: number,
  hi: number,
  power: number,
): void {
  const a = Math.pow(lo, power);
  const b = Math.pow(hi, power);
  for (let i = 0; i < count; i++) {
    // stratified, so the partials never clump into a gap-and-cluster pattern
    const u = (i + random()) / count;
    put(Math.pow(a + (b - a) * u, 1 / power), 0.35 + 0.65 * random(), random());
  }
}

const SPECS: Record<AlloyId, Spec> = {
  // clean synthetic hi-hat: mostly shaped noise with a few dozen partials for a metallic edge
  hat: {
    bits: 16,
    seed: 0x48a7,
    split: [7000, 10000],
    noise: 1.6,
    shape: (hz) =>
      highpass(hz, 5200, 3) *
      lowpass(hz, 13500, 2) *
      (1 + 0.6 * bell(hz, 8500, 0.5)),
    fill: (put, random) => scatter(put, random, 48, 3000, 15000, 0.8),
  },
  // a pair of small bronze cymbals: hundreds of partials, hardly any noise
  bronze: {
    bits: 16,
    seed: 0xb207,
    split: [7000, 10500],
    noise: 0.12,
    shape: (hz) =>
      highpass(hz, 5000, 3) *
      lowpass(hz, 17500, 1) *
      (1 + 0.5 * bell(hz, 8000, 0.6)),
    fill: (put, random) => scatter(put, random, 320, 1800, 19000, 0.7),
  },
  // drum-machine metal: six detuned square waves through two resonant bands
  machine: {
    bits: 16,
    seed: 0x0808,
    split: [5200, 9000],
    noise: 0.04,
    shape: (hz) =>
      highpass(hz, 2600, 4) *
      lowpass(hz, 16000, 2) *
      (0.35 + 1.2 * bell(hz, 3440, 0.3) + 1.6 * bell(hz, 7100, 0.4)),
    fill: (put, random) => {
      for (const hz of [205.3, 304.4, 369.6, 522.7, 540, 800]) {
        const phase = random();
        for (let n = 1; n * hz < 21000; n += 2) put(n * hz, 1 / n, n * phase);
      }
    },
  },
  // a large cymbal: dense inharmonic partials from the bell to the top, long table for long rings
  cymbal: {
    bits: 17,
    seed: 0xc1a5,
    split: [2000, 6500],
    noise: 0.22,
    shape: (hz) =>
      highpass(hz, 480, 2) *
      lowpass(hz, 14500, 1) *
      (1 + 0.8 * bell(hz, 5500, 1.2)),
    fill: (put, random) => scatter(put, random, 640, 240, 19000, 0.62),
  },
};

function build(spec: Spec, sr: number): Alloy {
  const size = 1 << spec.bits;
  const half = size >> 1;
  const binHz = sr / size;
  const random = createRng(spec.seed);
  // positive-frequency spectrum of the full sound
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  let power = 0;
  spec.fill((hz, amp, phase) => {
    const bin = Math.round(hz / binHz);
    if (bin < 2 || bin >= half - 2) return;
    const a = amp * spec.shape(bin * binHz);
    re[bin] += a * Math.cos(TAU * phase);
    im[bin] += a * Math.sin(TAU * phase);
    power += a * a;
  }, random);
  if (spec.noise > 0) {
    const from = Math.max(2, Math.ceil(60 / binHz));
    const to = Math.min(half - 2, Math.floor(Math.min(21500, sr * 0.47) / binHz));
    let floor = 0;
    for (let bin = from; bin < to; bin++) {
      const a = spec.shape(bin * binHz);
      floor += a * a;
    }
    const gain = Math.sqrt((spec.noise * Math.max(power, 1e-9)) / Math.max(floor, 1e-12));
    for (let bin = from; bin < to; bin++) {
      const a = gain * spec.shape(bin * binHz);
      const phase = TAU * random();
      re[bin] += a * Math.cos(phase);
      im[bin] += a * Math.sin(phase);
      power += a * a;
    }
  }
  // each band: Hermitian spectrum → real table; a sine of amplitude 2a per bin
  const norm = 1 / Math.sqrt(2 * Math.max(power, 1e-12));
  const [f1, f2] = spec.split;
  const band = (index: number): Float32Array => {
    const xr = new Float64Array(size);
    const xi = new Float64Array(size);
    for (let bin = 1; bin < half; bin++) {
      const octaves = Math.log2((bin * binHz) / f1);
      const c1 = smoothstep(octaves / 0.7 + 0.5);
      const c2 = smoothstep(Math.log2((bin * binHz) / f2) / 0.7 + 0.5);
      const weight = index === 0 ? 1 - c1 : index === 1 ? c1 * (1 - c2) : c1 * c2;
      if (weight === 0) continue;
      xr[bin] = re[bin] * weight;
      xi[bin] = im[bin] * weight;
      xr[size - bin] = xr[bin];
      xi[size - bin] = -xi[bin];
    }
    fft(xr, xi, true);
    const table = new Float32Array(size);
    for (let i = 0; i < size; i++) table[i] = xr[i] * norm;
    return table;
  };
  const low = band(0);
  const mid = band(1);
  const high = band(2);
  const rms = (table: Float32Array) => {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += table[i] * table[i];
    return Math.sqrt(sum / size);
  };
  return { low, mid, high, mask: size - 1, rms: [rms(low), rms(mid), rms(high)] };
}

const cache = new Map<number, Partial<Record<AlloyId, Alloy>>>();

/** The three band tables of an alloy at this sample rate; low + mid + high has RMS 1. */
export function alloy(id: AlloyId, sr: number): Alloy {
  let set = cache.get(sr);
  if (!set) {
    set = {};
    cache.set(sr, set);
  }
  return (set[id] ??= build(SPECS[id], sr));
}
