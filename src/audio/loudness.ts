/**
 * Loudness metering after ITU-R BS.1770-4 / EBU R 128: K-weighting computed
 * for the actual sample rate, 400 ms blocks with 75 % overlap, absolute gate
 * at -70 LUFS and relative gate 10 LU under the ungated mean.
 *
 * Reference points (EBU Tech 3341): a 997 Hz sine at full scale in ONE channel
 * reads -3.01 LUFS; the same sine in both channels of a stereo file reads
 * 0.00 LUFS, and a -23 dBFS stereo sine reads -23.0 LUFS.
 */

/** Length of one gating block in seconds. */
export const BLOCK_SECONDS = 0.4;
/** Hop between gating blocks in seconds (75 % overlap). */
export const HOP_SECONDS = 0.1;
/** Blocks quieter than this never count. */
export const ABSOLUTE_GATE_LUFS = -70;
/** Blocks this far under the ungated mean do not count. */
export const RELATIVE_GATE_LU = -10;
/** Window of the short-term loudness in seconds. */
export const SHORT_TERM_SECONDS = 3;

const OFFSET_DB = -0.691;
const HOPS_PER_BLOCK = Math.round(BLOCK_SECONDS / HOP_SECONDS);
const HOPS_PER_SHORT_TERM = Math.round(SHORT_TERM_SECONDS / HOP_SECONDS);

export interface BiquadCoefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting sections for `sampleRate`: the "head" high shelf
 * (+4 dB above about 1.7 kHz) and the RLB high-pass (38 Hz). At 48 kHz these
 * are the coefficients printed in BS.1770.
 */
export function kWeightingCoefs(sampleRate: number): {
  shelf: BiquadCoefs;
  highpass: BiquadCoefs;
} {
  const shelfK = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const vh = Math.pow(10, 3.999843853973347 / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const shelfQ = 0.7071752369554196;
  const shelfA0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const shelf: BiquadCoefs = {
    b0: (vh + (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0,
    b1: (2 * (shelfK * shelfK - vh)) / shelfA0,
    b2: (vh - (vb * shelfK) / shelfQ + shelfK * shelfK) / shelfA0,
    a1: (2 * (shelfK * shelfK - 1)) / shelfA0,
    a2: (1 - shelfK / shelfQ + shelfK * shelfK) / shelfA0,
  };
  const hpK = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  const hpQ = 0.5003270373238773;
  const hpA0 = 1 + hpK / hpQ + hpK * hpK;
  const highpass: BiquadCoefs = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (hpK * hpK - 1)) / hpA0,
    a2: (1 - hpK / hpQ + hpK * hpK) / hpA0,
  };
  return { shelf, highpass };
}

/** Linear gain of the K-weighting curve at `hz` (about +0.69 dB at 997 Hz). */
export function kWeightingGain(hz: number, sampleRate: number): number {
  const { shelf, highpass } = kWeightingCoefs(sampleRate);
  const w = (2 * Math.PI * hz) / sampleRate;
  const gain = (c: BiquadCoefs) => {
    const nr = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w);
    const ni = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w));
    const dr = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
    const di = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w));
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  };
  return gain(shelf) * gain(highpass);
}

/** LUFS of a K-weighted mean square summed over the channels. */
export function energyToLufs(meanSquare: number): number {
  return meanSquare > 0 ? OFFSET_DB + 10 * Math.log10(meanSquare) : -Infinity;
}

/** K-weighted mean square (summed over channels) that reads `lufs`. */
export function lufsToEnergy(lufs: number): number {
  return Math.pow(10, (lufs - OFFSET_DB) / 10);
}

/**
 * Gated (integrated) loudness from per-hop energies: `hops[i]` is the
 * K-weighted mean square, summed over the channels, of consecutive 100 ms
 * hops. Returns -Infinity when nothing passes the absolute gate.
 */
export function integratedFromHops(
  hops: ArrayLike<number>,
  count = hops.length,
): number {
  const blocks = count - HOPS_PER_BLOCK + 1;
  if (blocks < 1) return -Infinity;
  const absolute = lufsToEnergy(ABSOLUTE_GATE_LUFS);
  let sum = 0;
  let kept = 0;
  for (let i = 0; i < blocks; i++) {
    let energy = 0;
    for (let k = 0; k < HOPS_PER_BLOCK; k++) energy += hops[i + k];
    energy /= HOPS_PER_BLOCK;
    if (energy > absolute) {
      sum += energy;
      kept++;
    }
  }
  if (!kept) return -Infinity;
  const relative = (sum / kept) * Math.pow(10, RELATIVE_GATE_LU / 10);
  const gate = relative > absolute ? relative : absolute;
  sum = 0;
  kept = 0;
  for (let i = 0; i < blocks; i++) {
    let energy = 0;
    for (let k = 0; k < HOPS_PER_BLOCK; k++) energy += hops[i + k];
    energy /= HOPS_PER_BLOCK;
    if (energy > gate) {
      sum += energy;
      kept++;
    }
  }
  return kept ? energyToLufs(sum / kept) : -Infinity;
}

/**
 * Streaming stereo loudness meter. push() any number of blocks, then read
 * integrated / momentary / short-term loudness and the sample peak. Memory is
 * one number per 100 ms of audio.
 */
export class LoudnessMeter {
  readonly sampleRate: number;
  /** highest |sample| seen on either channel */
  peak = 0;
  private readonly hopFrames: number;
  private readonly shelf: BiquadCoefs;
  private readonly highpass: BiquadCoefs;
  /** biquad states: [shelf z1, shelf z2, hp z1, hp z2] per channel */
  private readonly state = new Float64Array(8);
  private hops = new Float64Array(256);
  private hopCount = 0;
  private hopFill = 0;
  private hopEnergy = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.hopFrames = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
    const coefs = kWeightingCoefs(sampleRate);
    this.shelf = coefs.shelf;
    this.highpass = coefs.highpass;
  }

  /**
   * Feed frames [offset, offset + frames). `right` may be the same array as
   * `left` (dual mono) or null for a single-channel signal.
   */
  push(
    left: Float32Array,
    right: Float32Array | null,
    frames = left.length,
    offset = 0,
  ): void {
    const { b0: sb0, b1: sb1, b2: sb2, a1: sa1, a2: sa2 } = this.shelf;
    const { a1: ha1, a2: ha2 } = this.highpass;
    const state = this.state;
    let l1 = state[0];
    let l2 = state[1];
    let l3 = state[2];
    let l4 = state[3];
    let r1 = state[4];
    let r2 = state[5];
    let r3 = state[6];
    let r4 = state[7];
    let peak = this.peak;
    let fill = this.hopFill;
    let energy = this.hopEnergy;
    const hopFrames = this.hopFrames;
    const end = offset + frames;
    for (let i = offset; i < end; i++) {
      const xl = left[i];
      const al = xl < 0 ? -xl : xl;
      if (al > peak) peak = al;
      // shelf, then high-pass (b = 1, -2, 1); both transposed direct form II
      const sl = sb0 * xl + l1;
      l1 = sb1 * xl - sa1 * sl + l2;
      l2 = sb2 * xl - sa2 * sl;
      const yl = sl + l3;
      l3 = -2 * sl - ha1 * yl + l4;
      l4 = sl - ha2 * yl;
      energy += yl * yl;
      if (right) {
        const xr = right[i];
        const ar = xr < 0 ? -xr : xr;
        if (ar > peak) peak = ar;
        const sr = sb0 * xr + r1;
        r1 = sb1 * xr - sa1 * sr + r2;
        r2 = sb2 * xr - sa2 * sr;
        const yr = sr + r3;
        r3 = -2 * sr - ha1 * yr + r4;
        r4 = sr - ha2 * yr;
        energy += yr * yr;
      }
      if (++fill === hopFrames) {
        this.pushHop(energy / hopFrames);
        fill = 0;
        energy = 0;
      }
    }
    state[0] = l1;
    state[1] = l2;
    state[2] = l3;
    state[3] = l4;
    state[4] = r1;
    state[5] = r2;
    state[6] = r3;
    state[7] = r4;
    this.peak = peak;
    this.hopFill = fill;
    this.hopEnergy = energy;
  }

  private pushHop(meanSquare: number): void {
    if (this.hopCount === this.hops.length) {
      const grown = new Float64Array(this.hops.length * 2);
      grown.set(this.hops);
      this.hops = grown;
    }
    this.hops[this.hopCount++] = meanSquare;
  }

  /** Completed 100 ms hops (K-weighted mean square summed over channels). */
  get hopEnergies(): Float64Array {
    return this.hops.subarray(0, this.hopCount);
  }

  /** Integrated (gated) loudness in LUFS; -Infinity for silence or less than 400 ms. */
  get integrated(): number {
    return integratedFromHops(this.hops, this.hopCount);
  }

  private windowed(hopsPerWindow: number): Float64Array {
    const count = Math.max(0, this.hopCount - hopsPerWindow + 1);
    const result = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      let energy = 0;
      for (let k = 0; k < hopsPerWindow; k++) energy += this.hops[i + k];
      result[i] = energyToLufs(energy / hopsPerWindow);
    }
    return result;
  }

  /** Momentary loudness (400 ms window), one value per 100 ms. */
  momentary(): Float64Array {
    return this.windowed(HOPS_PER_BLOCK);
  }

  /** Short-term loudness (3 s window), one value per 100 ms. */
  shortTerm(): Float64Array {
    return this.windowed(HOPS_PER_SHORT_TERM);
  }

  /** Loudest momentary value in LUFS (-Infinity when shorter than 400 ms). */
  get momentaryMax(): number {
    return maxOf(this.momentary());
  }

  /** Loudest short-term value in LUFS (-Infinity when shorter than 3 s). */
  get shortTermMax(): number {
    return maxOf(this.shortTerm());
  }

  /** Sample peak in dBFS. */
  get peakDb(): number {
    return this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity;
  }
}

function maxOf(values: Float64Array): number {
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  return max;
}

function meter(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
): LoudnessMeter {
  const result = new LoudnessMeter(sampleRate);
  result.push(left, right, left.length);
  return result;
}

/** Integrated loudness in LUFS of a stereo (or, with right = null, mono) signal. */
export function integratedLoudness(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
): number {
  return meter(left, right, sampleRate).integrated;
}

/** Momentary loudness series (400 ms window, 100 ms hop) in LUFS. */
export function momentaryLoudness(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
): Float64Array {
  return meter(left, right, sampleRate).momentary();
}

/** Short-term loudness series (3 s window, 100 ms hop) in LUFS. */
export function shortTermLoudness(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
): Float64Array {
  return meter(left, right, sampleRate).shortTerm();
}

/** Highest |sample| over any number of channels. */
export function samplePeak(...channels: Float32Array[]): number {
  let peak = 0;
  for (const data of channels)
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
  return peak;
}
