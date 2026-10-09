/**
 * Shared pieces of the effect processors: the two processor shapes, the
 * loop warm-up walk and a stereo biquad cascade.
 */
import { Biquad, TAU } from "../dsp";

/**
 * Added to the input of every recursive filter. A constant this small is
 * inaudible (-400 dBFS) but keeps filter states out of the denormal range
 * during rests, where x86 arithmetic becomes many times slower.
 */
export const ANTI_DENORMAL = 1e-20;

/** Effects are run in blocks of this many frames so their data stays in cache. */
export const FX_BLOCK = 2048;

/** An effect that replaces left/right[0 .. n) with its output. */
export interface InsertFx {
  process(left: Float32Array, right: Float32Array, n: number): void;
  /**
   * Modulated effects only: put the LFOs where they stand at `frame` of the
   * piece (negative while warming up before frame 0), so the modulation is a
   * function of the position in the piece and nothing else.
   */
  seek?(frame: number): void;
}

/**
 * An effect fed from a send: reads in[0 .. n) and WRITES only its wet signal
 * to out[0 .. n). `out` may be the same arrays as `in`.
 */
export interface SendFx {
  process(
    inLeft: Float32Array,
    inRight: Float32Array,
    outLeft: Float32Array,
    outRight: Float32Array,
    n: number,
  ): void;
  /** See InsertFx.seek. */
  seek?(frame: number): void;
  /** Give large internal buffers back at once (see dsp/memory.ts); the effect is finished. */
  release?(): void;
}

/**
 * Visit the LAST `warm` frames of a loop of `frames` frames in playing order,
 * in chunks of at most `block` frames. `warm` may be longer than the loop,
 * which is then walked more than once. Running a stateful effect over these
 * chunks (and discarding the output) leaves it in the state it would have
 * after the loop had been playing forever, so the following pass over
 * [0, frames) starts with the tail of the end already ringing.
 */
export function forLoopTail(
  frames: number,
  warm: number,
  block: number,
  visit: (from: number, count: number) => void,
): void {
  if (frames <= 0) return;
  let remaining = Math.max(0, Math.floor(warm));
  let position = (((frames - remaining) % frames) + frames) % frames;
  while (remaining > 0) {
    const count = Math.min(block, remaining, frames - position);
    visit(position, count);
    remaining -= count;
    position += count;
    if (position >= frames) position = 0;
  }
}

/**
 * LFO rate nearest to `hz` that completes a whole number of cycles in a loop
 * of `loopSeconds` (at least one). Without a loop the rate is returned as is.
 */
export function loopSyncedRate(hz: number, loopSeconds?: number): number {
  if (!loopSeconds || !(loopSeconds > 0)) return hz;
  return Math.max(1, Math.round(hz * loopSeconds)) / loopSeconds;
}

/**
 * A series of biquads applied to both channels, each channel with its own
 * state. Build the sections with the dsp Biquad designers.
 */
export class BiquadCascade implements InsertFx {
  readonly sections: number;
  /** b0 b1 b2 a1 a2 per section */
  private readonly coefs: Float64Array;
  /** left z1 z2, right z1 z2 per section */
  private readonly state: Float64Array;

  constructor(designs: readonly Biquad[]) {
    this.sections = designs.length;
    this.coefs = new Float64Array(designs.length * 5);
    this.state = new Float64Array(designs.length * 4);
    designs.forEach((design, index) => {
      this.coefs.set(
        [design.b0, design.b1, design.b2, design.a1, design.a2],
        index * 5,
      );
    });
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    if (right === left) {
      this.processChannel(left, n, 0);
      return;
    }
    // Sections are taken two at a time with both channels in one loop: the
    // four recurrences are independent enough for the CPU to overlap them,
    // which is about twice as fast as running them one after another.
    const coefs = this.coefs;
    const state = this.state;
    let section = 0;
    for (; section + 1 < this.sections; section += 2) {
      const c = section * 5;
      const s = section * 4;
      const b0 = coefs[c];
      const b1 = coefs[c + 1];
      const b2 = coefs[c + 2];
      const a1 = coefs[c + 3];
      const a2 = coefs[c + 4];
      const d0 = coefs[c + 5];
      const d1 = coefs[c + 6];
      const d2 = coefs[c + 7];
      const e1 = coefs[c + 8];
      const e2 = coefs[c + 9];
      let l1 = state[s];
      let l2 = state[s + 1];
      let r1 = state[s + 2];
      let r2 = state[s + 3];
      let l3 = state[s + 4];
      let l4 = state[s + 5];
      let r3 = state[s + 6];
      let r4 = state[s + 7];
      for (let i = 0; i < n; i++) {
        const xl = left[i] + ANTI_DENORMAL;
        const xr = right[i] + ANTI_DENORMAL;
        const yl = b0 * xl + l1;
        l1 = b1 * xl - a1 * yl + l2;
        l2 = b2 * xl - a2 * yl;
        const yr = b0 * xr + r1;
        r1 = b1 * xr - a1 * yr + r2;
        r2 = b2 * xr - a2 * yr;
        const zl = d0 * yl + l3;
        l3 = d1 * yl - e1 * zl + l4;
        l4 = d2 * yl - e2 * zl;
        const zr = d0 * yr + r3;
        r3 = d1 * yr - e1 * zr + r4;
        r4 = d2 * yr - e2 * zr;
        left[i] = zl;
        right[i] = zr;
      }
      state[s] = l1;
      state[s + 1] = l2;
      state[s + 2] = r1;
      state[s + 3] = r2;
      state[s + 4] = l3;
      state[s + 5] = l4;
      state[s + 6] = r3;
      state[s + 7] = r4;
    }
    if (section < this.sections) {
      const c = section * 5;
      const s = section * 4;
      const b0 = coefs[c];
      const b1 = coefs[c + 1];
      const b2 = coefs[c + 2];
      const a1 = coefs[c + 3];
      const a2 = coefs[c + 4];
      let l1 = state[s];
      let l2 = state[s + 1];
      let r1 = state[s + 2];
      let r2 = state[s + 3];
      for (let i = 0; i < n; i++) {
        const xl = left[i] + ANTI_DENORMAL;
        const xr = right[i] + ANTI_DENORMAL;
        const yl = b0 * xl + l1;
        l1 = b1 * xl - a1 * yl + l2;
        l2 = b2 * xl - a2 * yl;
        const yr = b0 * xr + r1;
        r1 = b1 * xr - a1 * yr + r2;
        r2 = b2 * xr - a2 * yr;
        left[i] = yl;
        right[i] = yr;
      }
      state[s] = l1;
      state[s + 1] = l2;
      state[s + 2] = r1;
      state[s + 3] = r2;
    }
  }

  /** Filter one buffer with the state of `channel` (0 = left, 1 = right). */
  processChannel(buf: Float32Array, n: number, channel: 0 | 1): void {
    const coefs = this.coefs;
    const state = this.state;
    for (let section = 0; section < this.sections; section++) {
      const c = section * 5;
      const s = section * 4 + channel * 2;
      const b0 = coefs[c];
      const b1 = coefs[c + 1];
      const b2 = coefs[c + 2];
      const a1 = coefs[c + 3];
      const a2 = coefs[c + 4];
      let z1 = state[s];
      let z2 = state[s + 1];
      for (let i = 0; i < n; i++) {
        const x = buf[i] + ANTI_DENORMAL;
        const y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        buf[i] = y;
      }
      state[s] = z1;
      state[s + 1] = z2;
    }
  }

  /** Linear gain of the whole cascade at `hz`. */
  magnitude(hz: number, sampleRate: number): number {
    const w = (TAU * hz) / sampleRate;
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    let gain = 1;
    for (let section = 0; section < this.sections; section++) {
      const c = section * 5;
      const coefs = this.coefs;
      const nr = coefs[c] + coefs[c + 1] * c1 + coefs[c + 2] * c2;
      const ni = -(coefs[c + 1] * s1 + coefs[c + 2] * s2);
      const dr = 1 + coefs[c + 3] * c1 + coefs[c + 4] * c2;
      const di = -(coefs[c + 3] * s1 + coefs[c + 4] * s2);
      gain *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    }
    return gain;
  }

  reset(): void {
    this.state.fill(0);
  }
}

/** Smallest prime >= n (n >= 2). */
export function nextPrime(n: number): number {
  let candidate = Math.max(2, Math.ceil(n));
  for (;;) {
    let prime = true;
    for (let d = 2; d * d <= candidate; d++)
      if (candidate % d === 0) {
        prime = false;
        break;
      }
    if (prime) return candidate;
    candidate++;
  }
}
