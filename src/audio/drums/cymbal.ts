/**
 * Metal you hit: hi-hats, ride, crash, the cymbal swell and the gong.
 *
 * Hats and cymbals are three bands of an alloy table (see metal.ts), each
 * with its own decay so the top dies first, plus a stick transient, an
 * optional louder first instant and, for rides, a few bell modes that "ping".
 * The swell is the same metal played backwards in level: it grows towards
 * SWELL_PEAK seconds and is then cut. The gong is a set of slowly beating
 * mode pairs whose upper group and metallic wash bloom after the stroke.
 */
import { LN_60DB, Svf } from "../dsp";
import type { Engine, Hit, Kit, Mode } from "./core";
import {
  bandNoise,
  byVel,
  fall,
  highNoise,
  mix,
  ring,
  ringPairs,
  shape,
  span,
  work,
} from "./core";
import type { Alloy, AlloyId } from "./metal";
import { alloy } from "./metal";

type Triple = readonly [low: number, mid: number, high: number];

/** Seconds from the start of a cymbalSwell to its loudest point, for every kit. */
export const SWELL_PEAK = 1.8;

const gain = new Float64Array(3);
const decay = new Float64Array(3);

const TRIES = 4;
const tryAt = new Int32Array(TRIES);
const tryPeak = new Float64Array(TRIES);

/**
 * Where to start reading the alloy. The first milliseconds decide the peak
 * of a hat, and a random slice of metal can open with a spike or a lull; of
 * four random positions take the one with the second-lowest opening, so
 * equal hits have nearly equal peaks without sounding alike.
 */
function startOf(h: Hit, tables: Alloy): number {
  const mask = tables.mask;
  const count = Math.min(h.n, Math.round(0.003 * h.sr));
  for (let t = 0; t < TRIES; t++) {
    const a = (h.dice.uniform() * (mask + 1)) | 0;
    let top = 0;
    for (let i = 0; i < count; i++) {
      const j = (a + i) & mask;
      const v = tables.low[j] * gain[0] + tables.mid[j] * gain[1] + tables.high[j] * gain[2];
      if (v > top) top = v;
      else if (-v > top) top = -v;
    }
    tryAt[t] = a;
    tryPeak[t] = top;
  }
  let lowest = 0;
  for (let t = 1; t < TRIES; t++) if (tryPeak[t] < tryPeak[lowest]) lowest = t;
  let second = lowest === 0 ? 1 : 0;
  for (let t = 0; t < TRIES; t++)
    if (t !== lowest && tryPeak[t] < tryPeak[second]) second = t;
  return tryAt[second];
}

/** ADD the three bands of an alloy (levels in `gain`, T60s in `decay`) from a random position. */
function wash(h: Hit, id: AlloyId, width: number): void {
  const { sr, n, mid, side } = h;
  const tables = alloy(id, sr);
  const { low, high, mask } = tables;
  const middle = tables.mid;
  const a = startOf(h, tables);
  const b = a + (mask >> 1) + ((h.dice.uniform() * 4096) | 0);
  const k0 = fall(decay[0], sr);
  const k1 = fall(decay[1], sr);
  const k2 = fall(decay[2], sr);
  let e0 = gain[0];
  let e1 = gain[1];
  let e2 = gain[2];
  const longest = Math.max(decay[0], decay[1], decay[2]);
  const end = span(longest, sr, n, 75);
  if (width > 0) {
    for (let i = 0; i < end; i++) {
      const j = (a + i) & mask;
      const k = (b + i) & mask;
      mid[i] += low[j] * e0 + middle[j] * e1 + high[j] * e2;
      side[i] += (low[k] * e0 + middle[k] * e1 + high[k] * e2) * width;
      e0 *= k0;
      e1 *= k1;
      e2 *= k2;
    }
    h.wide = true;
  } else
    for (let i = 0; i < end; i++) {
      const j = (a + i) & mask;
      mid[i] += low[j] * e0 + middle[j] * e1 + high[j] * e2;
      e0 *= k0;
      e1 *= k1;
      e2 *= k2;
    }
}

/** Raised-cosine fade-in of both channels. */
function rise(h: Hit, seconds: number): void {
  const count = Math.min(h.n, Math.max(1, Math.round(seconds * h.sr)));
  for (let i = 0; i < count; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / count);
    h.mid[i] *= g;
    h.side[i] *= g;
  }
}

/* ------------------------------------------------------------------ */
/* hats, ride, crash                                                   */
/* ------------------------------------------------------------------ */

interface Cymbal {
  len: number;
  alloy: AlloyId;
  /** level and T60 of the low / mid / high band at vel 0.8 */
  gains: Triple;
  t60: Triple;
  attack: number;
  /** the first instants are (1 + burst) times louder, fading with burstTau */
  burst: number;
  burstTau: number;
  /** stick tip: a few milliseconds of high-passed noise */
  stick: number;
  stickHz: number;
  /** bell modes of a ride */
  ping: readonly Mode[];
  pingLevel: number;
  drive: number;
  lowpass: number;
  grit: number;
  pan: number;
  width: number;
}

const CYMBAL_BASE: Cymbal = {
  len: 0.1,
  alloy: "hat",
  gains: [1, 1, 1],
  t60: [0.05, 0.05, 0.05],
  attack: 0.0004,
  burst: 0,
  burstTau: 0.02,
  stick: 0,
  stickHz: 8000,
  ping: [],
  pingLevel: 0,
  drive: 0,
  lowpass: 0,
  grit: 0,
  pan: 0,
  width: 0.25,
};
const c = (p: Partial<Cymbal>): Cymbal => ({ ...CYMBAL_BASE, ...p });

const HAT_PAN = -0.22;

// prettier-ignore
const HAT_CLOSED: Record<Kit, Cymbal> = {
  pop: c({ len: 0.07, alloy: "hat", gains: [0.5, 1, 0.9], t60: [0.05, 0.055, 0.045], stick: 0.25, stickHz: 9000, pan: HAT_PAN }),
  // dark and crunchy: the band below 7.5 kHz carries it
  lofi: c({ len: 0.055, alloy: "hat", gains: [1, 0.4, 0.08], t60: [0.045, 0.04, 0.03], attack: 0.001, drive: 1.5, lowpass: 7600, grit: 0.08, pan: HAT_PAN, width: 0.15 }),
  electro: c({ len: 0.06, alloy: "machine", gains: [0.3, 1, 0.8], t60: [0.04, 0.05, 0.04], pan: HAT_PAN }),
  acoustic: c({ len: 0.09, alloy: "bronze", gains: [0.6, 1, 0.7], t60: [0.075, 0.065, 0.045], stick: 0.35, stickHz: 6500, pan: HAT_PAN, width: 0.3 }),
  brush: c({ len: 0.08, alloy: "bronze", gains: [0.75, 0.8, 0.4], t60: [0.065, 0.055, 0.035], attack: 0.002, stick: 0.1, stickHz: 6000, pan: HAT_PAN }),
  cinematic: c({ len: 0.12, alloy: "bronze", gains: [0.9, 1, 0.7], t60: [0.105, 0.09, 0.06], stick: 0.3, stickHz: 6000, pan: HAT_PAN, width: 0.35 }),
  soft: c({ len: 0.065, alloy: "hat", gains: [0.9, 0.55, 0.18], t60: [0.05, 0.04, 0.03], attack: 0.003, lowpass: 9500, pan: HAT_PAN, width: 0.2 }),
};

// prettier-ignore
const HAT_OPEN: Record<Kit, Cymbal> = {
  pop: c({ len: 0.42, alloy: "hat", gains: [0.5, 1, 0.9], t60: [0.36, 0.4, 0.3], burst: 1.2, stick: 0.2, stickHz: 9000, pan: HAT_PAN }),
  lofi: c({ len: 0.26, alloy: "hat", gains: [1, 0.45, 0.1], t60: [0.24, 0.22, 0.16], attack: 0.001, burst: 0.6, drive: 1.5, lowpass: 7600, grit: 0.08, pan: HAT_PAN, width: 0.15 }),
  electro: c({ len: 0.5, alloy: "machine", gains: [0.3, 1, 0.8], t60: [0.42, 0.48, 0.38], burst: 0.6, pan: HAT_PAN }),
  acoustic: c({ len: 0.58, alloy: "bronze", gains: [0.7, 1, 0.7], t60: [0.55, 0.5, 0.36], burst: 1, stick: 0.3, stickHz: 6500, pan: HAT_PAN, width: 0.3 }),
  brush: c({ len: 0.42, alloy: "bronze", gains: [0.75, 0.8, 0.4], t60: [0.4, 0.34, 0.22], attack: 0.003, burst: 0.4, pan: HAT_PAN }),
  cinematic: c({ len: 0.78, alloy: "bronze", gains: [0.9, 1, 0.7], t60: [0.74, 0.64, 0.45], burst: 1, stick: 0.25, stickHz: 6000, pan: HAT_PAN, width: 0.35 }),
  soft: c({ len: 0.32, alloy: "hat", gains: [0.9, 0.55, 0.18], t60: [0.3, 0.26, 0.18], attack: 0.004, burst: 0.2, lowpass: 9500, pan: HAT_PAN, width: 0.2 }),
};

const PING: readonly Mode[] = [
  [430, 0.3, 0.9],
  [612, 0.22, 0.8],
  [965, 0.3, 0.7],
  [1490, 0.25, 0.5],
  [2260, 0.2, 0.4],
  [3180, 0.15, 0.3],
];
/** the clear bell of a small jazz ride */
const BELL: readonly Mode[] = [
  [540, 0.5, 1],
  [810, 0.35, 0.85],
  [1230, 0.4, 0.75],
  [1880, 0.3, 0.6],
  [2750, 0.2, 0.45],
  [3900, 0.1, 0.3],
];
const RIDE_PAN = 0.3;

// prettier-ignore
const RIDE: Record<Kit, Cymbal> = {
  pop: c({ len: 1.1, alloy: "cymbal", gains: [0.35, 1, 0.8], t60: [1.05, 0.95, 0.6], burst: 2.5, burstTau: 0.012, stick: 0.5, stickHz: 7000, ping: PING, pingLevel: 1.4, pan: RIDE_PAN, width: 0.3 }),
  lofi: c({ len: 0.76, alloy: "cymbal", gains: [0.6, 0.8, 0.15], t60: [0.72, 0.6, 0.3], attack: 0.001, burst: 1.5, burstTau: 0.012, ping: PING, pingLevel: 1, drive: 1.2, lowpass: 6500, grit: 0.08, pan: RIDE_PAN, width: 0.2 }),
  // 808 cymbal: the low band rings on, the high band is a short splash
  electro: c({ len: 0.92, alloy: "machine", gains: [1, 0.9, 0.5], t60: [0.88, 0.7, 0.4], burst: 1.5, burstTau: 0.015, pan: RIDE_PAN, width: 0.3 }),
  acoustic: c({ len: 1.36, alloy: "cymbal", gains: [0.5, 1, 0.7], t60: [1.3, 1.15, 0.7], burst: 3, burstTau: 0.012, stick: 0.7, stickHz: 6500, ping: PING, pingLevel: 1.6, pan: RIDE_PAN, width: 0.35 }),
  // light ride with a clear bell ping over a quiet wash
  brush: c({ len: 1.1, alloy: "cymbal", gains: [0.4, 0.7, 0.35], t60: [1.05, 0.9, 0.5], attack: 0.0015, burst: 1.2, burstTau: 0.012, stick: 0.15, stickHz: 6000, ping: BELL, pingLevel: 2.4, pan: RIDE_PAN, width: 0.3 }),
  cinematic: c({ len: 1.8, alloy: "cymbal", gains: [0.8, 1, 0.6], t60: [1.72, 1.5, 0.9], burst: 2.5, burstTau: 0.015, stick: 0.5, stickHz: 6000, ping: PING, pingLevel: 1.2, pan: RIDE_PAN, width: 0.45 }),
  soft: c({ len: 0.82, alloy: "cymbal", gains: [0.6, 0.8, 0.3], t60: [0.78, 0.66, 0.4], attack: 0.004, burst: 0.5, ping: BELL, pingLevel: 1.6, lowpass: 8000, pan: RIDE_PAN, width: 0.25 }),
};

const CRASH_PAN = -0.12;

// prettier-ignore
const CRASH: Record<Kit, Cymbal> = {
  pop: c({ len: 1.8, alloy: "cymbal", gains: [0.7, 1, 0.9], t60: [1.75, 1.45, 0.9], burst: 1.5, burstTau: 0.03, stick: 0.5, stickHz: 6000, pan: CRASH_PAN, width: 0.45 }),
  lofi: c({ len: 1.1, alloy: "cymbal", gains: [1, 0.7, 0.15], t60: [1.06, 0.85, 0.5], attack: 0.001, burst: 1, burstTau: 0.03, drive: 1.6, lowpass: 6000, grit: 0.08, pan: CRASH_PAN, width: 0.3 }),
  electro: c({ len: 1.4, alloy: "machine", gains: [1, 1, 0.8], t60: [1.36, 1.15, 0.7], burst: 1, burstTau: 0.03, pan: CRASH_PAN, width: 0.45 }),
  acoustic: c({ len: 2.2, alloy: "cymbal", gains: [0.9, 1, 0.8], t60: [2.14, 1.8, 1.1], burst: 2, burstTau: 0.035, stick: 0.6, stickHz: 5500, pan: CRASH_PAN, width: 0.5 }),
  // soft mallet: the cymbal speaks slowly
  brush: c({ len: 1.6, alloy: "cymbal", gains: [0.8, 0.8, 0.4], t60: [1.55, 1.25, 0.7], attack: 0.015, pan: CRASH_PAN, width: 0.45 }),
  // a pair of piatti: low, huge, long
  cinematic: c({ len: 3.2, alloy: "cymbal", gains: [1.2, 1, 0.8], t60: [3.12, 2.5, 1.5], burst: 2, burstTau: 0.04, stick: 0.5, stickHz: 5000, pan: 0, width: 0.6 }),
  soft: c({ len: 1.4, alloy: "cymbal", gains: [0.8, 0.7, 0.25], t60: [1.36, 1.1, 0.6], attack: 0.025, lowpass: 8000, pan: CRASH_PAN, width: 0.4 }),
};

function cymbal(h: Hit, p: Cymbal): void {
  const { sr, n, vel } = h;
  const stretch = byVel(h, 0.8, 1.05);
  // harder strokes are brighter: the top band grows fastest …
  // … and on a ride the wash grows against the ping
  const body = p.pingLevel > 0 ? byVel(h, 0.8, 1.05) : 1;
  gain[0] = p.gains[0] * body * byVel(h, 1.3, 0.925);
  gain[1] = p.gains[1] * body;
  gain[2] = p.gains[2] * body * byVel(h, 0.55, 1.1125);
  for (let b = 0; b < 3; b++) decay[b] = p.t60[b] * stretch;
  wash(h, p.alloy, p.width);
  if (p.burst > 0) {
    const k = Math.exp(-1 / (p.burstTau * sr));
    const count = Math.min(n, Math.ceil(p.burstTau * sr * 7));
    let g = p.burst * byVel(h, 0.6, 1.1);
    for (let i = 0; i < count; i++) {
      h.mid[i] *= 1 + g;
      h.side[i] *= 1 + g;
      g *= k;
    }
  }
  if (p.pingLevel > 0)
    ring(h.mid, n, sr, p.ping, p.pingLevel, 1, stretch, (vel - 0.8) * 0.8);
  rise(h, p.attack * (1 + 2 * (1 - vel) * (1 - vel)) + 0.0015 * (1 - vel));
  if (p.stick > 0) {
    const count = span(0.006, sr, n, 70);
    const stick = work(3, count);
    highNoise(h, stick, count, p.stickHz);
    shape(stick, count, sr, 0.0002, 0.006);
    mix(h.mid, stick, count, p.stick * (0.15 + 1.33 * vel * vel));
  }
  h.pan = p.pan;
  h.drive = p.drive;
  h.lowpass = p.lowpass > 0 ? p.lowpass * byVel(h, 0.7, 1.075) : 0;
  h.grit = p.grit;
}

/* ------------------------------------------------------------------ */
/* swell                                                               */
/* ------------------------------------------------------------------ */

interface Swell {
  /** seconds after the peak until silence */
  release: number;
  /** "noise" = a filtered-noise riser instead of metal */
  alloy: AlloyId | "noise";
  gains: Triple;
  /** per band: the T60 of the cymbal this is the reverse of (short = late, steep rise) */
  t60: Triple;
  /** 0..1 depth of the mallet-roll ripple, and its rate in Hz */
  roll: number;
  rollHz: number;
  /** noise riser: band-pass glide in Hz */
  from: number;
  to: number;
  drive: number;
  lowpass: number;
  grit: number;
  width: number;
}

// prettier-ignore
const SWELL: Record<Kit, Swell> = {
  // a reversed crash
  pop: { release: 0.1, alloy: "cymbal", gains: [0.7, 1, 0.9], t60: [2.2, 1.6, 1], roll: 0, rollHz: 0, from: 0, to: 0, drive: 0, lowpass: 0, grit: 0, width: 0.45 },
  lofi: { release: 0.08, alloy: "cymbal", gains: [1, 0.7, 0.15], t60: [2, 1.5, 0.9], roll: 0, rollHz: 0, from: 0, to: 0, drive: 1.2, lowpass: 6000, grit: 0.08, width: 0.3 },
  // synth uplifter: noise through a band-pass that climbs
  electro: { release: 0.06, alloy: "noise", gains: [1, 1, 1], t60: [1.5, 1.5, 1.5], roll: 0, rollHz: 0, from: 500, to: 9000, drive: 0, lowpass: 0, grit: 0, width: 0.45 },
  // mallet roll on a suspended cymbal
  acoustic: { release: 0.14, alloy: "cymbal", gains: [0.9, 1, 0.8], t60: [2.4, 1.8, 1.1], roll: 0.3, rollHz: 13, from: 0, to: 0, drive: 0, lowpass: 0, grit: 0, width: 0.5 },
  brush: { release: 0.16, alloy: "cymbal", gains: [0.8, 0.8, 0.4], t60: [2.4, 1.8, 1.1], roll: 0.2, rollHz: 11, from: 0, to: 0, drive: 0, lowpass: 0, grit: 0, width: 0.45 },
  // the long one: a deep roll that keeps growing and lets go slowly
  cinematic: { release: 0.25, alloy: "cymbal", gains: [1.2, 1, 0.9], t60: [2.8, 2, 1.2], roll: 0.25, rollHz: 14, from: 0, to: 0, drive: 0, lowpass: 0, grit: 0, width: 0.6 },
  soft: { release: 0.2, alloy: "cymbal", gains: [0.8, 0.7, 0.25], t60: [2.6, 2, 1.2], roll: 0, rollHz: 0, from: 0, to: 0, drive: 0, lowpass: 8000, grit: 0, width: 0.4 },
};

const riserA = new Svf();
const riserB = new Svf();

function swell(h: Hit, p: Swell): void {
  const { sr, n, mid, side } = h;
  const top = Math.round(SWELL_PEAK * sr);
  const fade = Math.max(8, Math.round(p.release * sr));
  const rising = Math.min(n, top);
  const end = Math.min(n, top + fade);
  const bright = byVel(h, 0.4, 1.15);
  if (p.alloy === "noise") {
    const t60 = p.t60[1];
    const up = Math.exp(LN_60DB / (t60 * sr));
    const q = 2.2;
    const sweepTo = p.to * byVel(h, 0.6, 1.1);
    riserA.reset();
    riserB.reset();
    h.noise.restart();
    h.noise2.restart();
    let e = Math.exp((-LN_60DB * SWELL_PEAK) / t60);
    for (let i = 0; i < end; i++) {
      if ((i & 31) === 0) {
        const x = Math.min(1, i / top);
        const hz = p.from * Math.pow(sweepTo / p.from, x * x);
        riserA.set(hz, q, sr);
        riserB.set(hz * 1.07, q, sr);
      }
      let level = e;
      if (i < top) e *= up;
      else {
        const x = 0.5 + 0.5 * Math.cos((Math.PI * (i - top)) / fade);
        level = x * x;
      }
      mid[i] = riserA.band(h.noise.next()) * level * h.nd;
      side[i] = riserB.band(h.noise2.next()) * level * h.nd * p.width;
    }
    h.wide = true;
  } else {
    const tables = alloy(p.alloy, sr);
    const mask = tables.mask;
    const a = (h.dice.uniform() * (mask + 1)) | 0;
    const b = a + (mask >> 1) + ((h.dice.uniform() * 4096) | 0);
    const width = p.width;
    let power = 0;
    for (let band = 0; band < 3; band++) {
      const table = band === 0 ? tables.low : band === 1 ? tables.mid : tables.high;
      const g = p.gains[band] * (band === 2 ? bright : band === 0 ? byVel(h, 1.3, 0.925) : 1);
      power += g * g * tables.rms[band] * tables.rms[band];
      const t60 = p.t60[band];
      const up = Math.exp(LN_60DB / (t60 * sr));
      let e = g * Math.exp((-LN_60DB * SWELL_PEAK) / t60);
      for (let i = 0; i < rising; i++) {
        mid[i] += table[(a + i) & mask] * e;
        side[i] += table[(b + i) & mask] * e * width;
        e *= up;
      }
      for (let i = top; i < end; i++) {
        const x = 0.5 + 0.5 * Math.cos((Math.PI * (i - top)) / fade);
        const level = g * x * x;
        mid[i] += table[(a + i) & mask] * level;
        side[i] += table[(b + i) & mask] * level * width;
      }
    }
    h.wide = true;
    // the peak comes last: tell the drive what it will be (dense metal peaks about 12 dB over its RMS)
    h.driveLevel = 4 * Math.sqrt(power);
    if (p.roll > 0) {
      // single strokes are audible early in a roll and merge as it gets loud
      const step = p.rollHz / sr;
      for (let i = 0; i < rising; i++) {
        const x = i / top;
        const depth = p.roll * (1 - x * x);
        const ripple = 1 - depth * (0.5 + 0.5 * Math.cos(2 * Math.PI * step * i));
        mid[i] *= ripple;
        side[i] *= ripple;
      }
    }
  }
  h.drive = p.drive;
  h.lowpass = p.lowpass > 0 ? p.lowpass * byVel(h, 0.7, 1.075) : 0;
  h.grit = p.grit;
}

/* ------------------------------------------------------------------ */
/* gong                                                                */
/* ------------------------------------------------------------------ */

interface Gong {
  len: number;
  /** pitch of the lowest mode */
  hz: number;
  /** [ratio to hz, level, T60]: the modes that speak at once … */
  low: readonly Mode[];
  /** … and the ones that bloom */
  high: readonly Mode[];
  /** multiplies every mode decay (a kit with a short gong) */
  sustain: number;
  /** Hz between the two halves of a mode pair (slow shimmer) */
  beat: number;
  /** time constants: mallet softness, and how long the upper modes take to arrive */
  mallet: number;
  bloom: number;
  /** metallic wash: level, band gains, band decays, band bloom times */
  wash: number;
  washAlloy: AlloyId;
  washGains: Triple;
  washT60: Triple;
  washBloom: Triple;
  thump: number;
  drive: number;
  lowpass: number;
  grit: number;
  width: number;
}

const GONG_LOW: readonly Mode[] = [
  [1, 1, 3],
  [1.48, 0.55, 2.6],
  [2.01, 0.6, 2.4],
  [2.74, 0.35, 2],
];
const GONG_HIGH: readonly Mode[] = [
  [3.16, 0.6, 1.9],
  [3.92, 0.55, 1.7],
  [4.6, 0.5, 1.6],
  [5.43, 0.46, 1.4],
  [6.2, 0.42, 1.3],
  [7.3, 0.4, 1.15],
  [8.6, 0.34, 1],
  [10.1, 0.3, 0.9],
  [11.9, 0.24, 0.8],
  [13.7, 0.2, 0.7],
];

// prettier-ignore
const GONG: Record<Kit, Gong> = {
  pop: { len: 3, hz: 104, low: GONG_LOW, high: GONG_HIGH, sustain: 1, beat: 0.7, mallet: 0.006, bloom: 0.09, wash: 1.4, washAlloy: "cymbal", washGains: [1, 0.6, 0.15], washT60: [2.4, 1.6, 0.9], washBloom: [0.12, 0.2, 0.3], thump: 0.25, drive: 0, lowpass: 0, grit: 0, width: 0.35 },
  lofi: { len: 2.2, hz: 98, low: GONG_LOW, high: GONG_HIGH.slice(0, 6), sustain: 0.72, beat: 0.6, mallet: 0.008, bloom: 0.09, wash: 1.0, washAlloy: "cymbal", washGains: [1, 0.3, 0.05], washT60: [1.8, 1.2, 0.6], washBloom: [0.12, 0.2, 0.3], thump: 0.25, drive: 1.4, lowpass: 4200, grit: 0.08, width: 0.25 },
  // synthetic gong: fewer, stranger partials and a drum-machine wash
  electro: { len: 2.4, hz: 130, low: [[1, 1, 2.4], [1.41, 0.7, 2.1], [2.24, 0.5, 1.8]], high: [[3.17, 0.4, 1.6], [4.53, 0.3, 1.4], [6.11, 0.25, 1.1], [8.37, 0.18, 0.9]], sustain: 1, beat: 1.1, mallet: 0.003, bloom: 0.07, wash: 0.6, washAlloy: "machine", washGains: [1, 0.7, 0.3], washT60: [1.8, 1.3, 0.8], washBloom: [0.08, 0.15, 0.22], thump: 0.1, drive: 0.5, lowpass: 0, grit: 0, width: 0.35 },
  acoustic: { len: 3.2, hz: 112, low: GONG_LOW, high: GONG_HIGH, sustain: 1.06, beat: 0.6, mallet: 0.007, bloom: 0.1, wash: 1.6, washAlloy: "cymbal", washGains: [1, 0.7, 0.2], washT60: [2.6, 1.8, 1], washBloom: [0.12, 0.22, 0.34], thump: 0.3, drive: 0, lowpass: 0, grit: 0, width: 0.4 },
  // a small gong with a soft beater
  brush: { len: 2.4, hz: 150, low: GONG_LOW, high: GONG_HIGH.slice(0, 7), sustain: 0.8, beat: 0.8, mallet: 0.012, bloom: 0.1, wash: 0.9, washAlloy: "cymbal", washGains: [1, 0.5, 0.1], washT60: [1.9, 1.3, 0.7], washBloom: [0.14, 0.24, 0.36], thump: 0.15, drive: 0, lowpass: 0, grit: 0, width: 0.35 },
  // tam-tam: no clear pitch, a crash that takes half a second to arrive
  cinematic: { len: 3.8, hz: 62, low: [[1, 1, 3.8], [1.52, 0.7, 3.4], [2.03, 0.6, 3.1], [2.66, 0.5, 2.8], [3.28, 0.4, 2.5]], high: [[4.1, 0.4, 2.3], [5.3, 0.36, 2.1], [6.7, 0.32, 1.9], [8.2, 0.28, 1.7], [10.1, 0.24, 1.5], [12.4, 0.2, 1.3], [15.2, 0.16, 1.1], [18.6, 0.12, 1]], sustain: 1, beat: 0.5, mallet: 0.01, bloom: 0.16, wash: 2.4, washAlloy: "cymbal", washGains: [1.2, 0.9, 0.3], washT60: [3.4, 2.4, 1.3], washBloom: [0.15, 0.3, 0.5], thump: 0.4, drive: 0, lowpass: 0, grit: 0, width: 0.5 },
  // closer to a singing bowl: a few pure, slowly beating partials
  soft: { len: 3, hz: 176, low: [[1, 1, 3], [2.71, 0.4, 2.2]], high: [[5.15, 0.15, 1.4], [8.2, 0.05, 0.9]], sustain: 1, beat: 1.3, mallet: 0.02, bloom: 0.12, wash: 0, washAlloy: "cymbal", washGains: [0, 0, 0], washT60: [1, 1, 1], washBloom: [0.1, 0.1, 0.1], thump: 0.05, drive: 0, lowpass: 5000, grit: 0, width: 0 },
};

/** Multiply buf by 1 - e^(-t/tau): a sound that arrives instead of starting. */
function arrive(buf: Float32Array, n: number, sr: number, tau: number): void {
  const k = Math.exp(-1 / (tau * sr));
  const count = Math.min(n, Math.ceil(tau * sr * 12));
  let d = 1;
  for (let i = 0; i < count; i++) {
    buf[i] *= 1 - d;
    d *= k;
  }
}

function gong(h: Hit, p: Gong): void {
  const { sr, n, vel, mid, side } = h;
  const stretch = p.sustain * byVel(h, 0.8, 1.05);
  const body = work(3, n);
  ringPairs(body, n, sr, p.low, 1, p.hz, stretch, p.beat, h.dice);
  arrive(body, n, sr, p.mallet * (1 + 2 * (1 - vel)));
  mix(mid, body, n, 1);
  // the harder the stroke, the more energy spills into the upper modes
  const spill = byVel(h, 0.3, 1.175);
  const upper = work(3, n);
  ringPairs(upper, n, sr, p.high, spill, p.hz, stretch, p.beat * 1.7, h.dice);
  arrive(upper, n, sr, p.bloom);
  mix(mid, upper, n, 1);

  if (p.wash > 0) {
    const tables = alloy(p.washAlloy, sr);
    const mask = tables.mask;
    const a = (h.dice.uniform() * (mask + 1)) | 0;
    const b = a + (mask >> 1) + ((h.dice.uniform() * 4096) | 0);
    for (let band = 0; band < 3; band++) {
      const table = band === 0 ? tables.low : band === 1 ? tables.mid : tables.high;
      const t60 = p.washT60[band] * stretch;
      const k = fall(t60, sr);
      const kd = Math.exp(-1 / (p.washBloom[band] * sr));
      const end = span(t60, sr, n, 75);
      let e = p.wash * p.washGains[band] * spill * (band === 2 ? spill : 1);
      let d = 1;
      for (let i = 0; i < end; i++) {
        const level = e * (1 - d);
        mid[i] += table[(a + i) & mask] * level;
        side[i] += table[(b + i) & mask] * level * p.width;
        e *= k;
        d *= kd;
      }
    }
    h.wide = p.width > 0;
  }
  if (p.thump > 0) {
    const count = span(0.09, sr, n, 70);
    const thump = work(3, count);
    bandNoise(h, thump, count, 170, 0.6);
    shape(thump, count, sr, 0.004 + 0.006 * (1 - vel), 0.09);
    mix(mid, thump, count, p.thump * byVel(h, 0.5, 1.12));
  }
  h.drive = p.drive;
  h.lowpass = p.lowpass;
  h.grit = p.grit;
}

/* ------------------------------------------------------------------ */

export type CymbalKind =
  | "hatClosed"
  | "hatOpen"
  | "ride"
  | "crash"
  | "cymbalSwell"
  | "gong";

export const CYMBALS: Engine<CymbalKind> = {
  length(kind, kit) {
    switch (kind) {
      case "hatClosed":
        return HAT_CLOSED[kit].len;
      case "hatOpen":
        return HAT_OPEN[kit].len;
      case "ride":
        return RIDE[kit].len;
      case "crash":
        return CRASH[kit].len;
      case "cymbalSwell":
        return SWELL_PEAK + SWELL[kit].release;
      case "gong":
        return GONG[kit].len;
    }
  },
  render(h, kind, kit) {
    switch (kind) {
      case "hatClosed":
        return cymbal(h, HAT_CLOSED[kit]);
      case "hatOpen":
        return cymbal(h, HAT_OPEN[kit]);
      case "ride":
        return cymbal(h, RIDE[kit]);
      case "crash":
        return cymbal(h, CRASH[kit]);
      case "cymbalSwell":
        return swell(h, SWELL[kit]);
      case "gong":
        return gong(h, GONG[kit]);
    }
  },
};
