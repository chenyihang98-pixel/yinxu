/**
 * Drum and percussion synthesizer of engine v2: 23 kinds × 8 kits, all
 * synthesized (no samples), deterministic for a given ctx.random.
 *
 * The engines live in ./drums/*: membranes (kick, toms, taiko, sub boom),
 * snare family (snare, brush stroke, clap, rim, wood block, finger snap),
 * metal (hats, ride, crash, swell, gong), shaken (shaker, tambourine, sleigh
 * bells) and the console chip. This file owns what they share:
 *
 *  - length(): the natural length of a hit. render() fills
 *    min(frames, natural length) and always ends on zero, so the renderer may
 *    pass FEWER frames to cut a hit short (e.g. choke an open hat);
 *  - level: every kind/kit is calibrated once per sample rate (the typical
 *    peak of a few dozen hits with fixed seeds at velocity 0.8) so that it
 *    peaks at drumPeak(kind, kit); a hit is then scaled by that fixed gain
 *    and the velocity law, never normalised on its own — two hats of equal
 *    velocity are equally loud — and only a peak that sticks out more than
 *    15 % is rounded off. Nothing exceeds 0.98;
 *  - velocity: (vel / 0.8)^1.5 up to 0.8, then as much of that slope as fits
 *    under 0.97 (a loud kick gains drive rather than peak). The engines make
 *    harder hits brighter and longer and softer hits rounder;
 *  - stereo: kick, snare, sub boom and the chip kit are centred mono; toms,
 *    cymbals and small percussion sit slightly off centre (drummer's view:
 *    hat left, ride right, toms high → low from left to right) with a
 *    decorrelated side signal that cancels in mono;
 *  - kit colour that is not specific to one engine: saturation, low-pass and
 *    sampler grit (lofi), early reflections (acoustic, brush, cinematic).
 *
 * One draw of ctx.random per hit, whatever the kind or length. The first
 * hit of a kind/kit costs a few milliseconds (calibration, and for metal the
 * building of a wavetable); everything is module state, so one hit at a time.
 */
import { DRUM_KINDS, DRUM_KITS } from "../music/score";
import type { DrumKind, DrumKitId } from "../music/score";
import type { DrumVoice } from "./voices/types";
import { OnePoleHP, fastTanh, panLeft, panRight } from "./dsp";
import { CHIP, NOISE_CHANNEL } from "./drums/chip";
import type { Hit } from "./drums/core";
import { Noise, active, lowpass, work } from "./drums/core";
import { CYMBALS, SWELL_PEAK } from "./drums/cymbal";
import { MEMBRANES } from "./drums/membrane";
import { SHAKEN } from "./drums/shaken";
import { SNARES } from "./drums/snare";

/** Velocity at which a hit peaks at drumPeak(kind, kit). */
export const DRUM_REFERENCE_VELOCITY = 0.8;

/**
 * Seconds from the start of a cymbalSwell to its loudest point, the same in
 * every kit: place the hit this long before the downbeat it leads into.
 */
export const SWELL_PEAK_SECONDS = SWELL_PEAK;

/** Sample peak of each kind at velocity 0.8 in a kit of level 1. */
export const DRUM_PEAKS: Record<DrumKind, number> = {
  kick: 0.84,
  snare: 0.65,
  rim: 0.42,
  clap: 0.55,
  hatClosed: 0.3,
  hatOpen: 0.3,
  ride: 0.3,
  crash: 0.45,
  tomLow: 0.62,
  tomMid: 0.58,
  tomHigh: 0.55,
  shaker: 0.22,
  tambourine: 0.28,
  woodblock: 0.4,
  brushSnare: 0.34,
  taiko: 0.84,
  cymbalSwell: 0.4,
  subBoom: 0.8,
  noiseHit: 0.28,
  noiseTick: 0.125,
  sleighBell: 0.26,
  gong: 0.55,
  fingerSnap: 0.42,
};

/** Level of a kit against DRUM_PEAKS (gentle kits simply play quieter). */
export const KIT_LEVELS: Record<DrumKitId, number> = {
  pop: 1,
  lofi: 0.9,
  electro: 1,
  acoustic: 1,
  brush: 0.8,
  cinematic: 1,
  chip: 1,
  soft: 0.7,
};

/**
 * The console kit has its own peaks: square and LFSR waves have no crest, so
 * at an equal peak they would be far louder than filtered noise. Its noise
 * hats are balanced against its noise snare the way console music does it.
 */
const CHIP_PEAKS: Record<DrumKind, number> = {
  kick: 0.7,
  snare: 0.34,
  rim: 0.24,
  clap: 0.24,
  hatClosed: 0.125,
  hatOpen: 0.11,
  ride: 0.14,
  crash: 0.16,
  tomLow: 0.5,
  tomMid: 0.48,
  tomHigh: 0.46,
  shaker: 0.11,
  tambourine: 0.12,
  woodblock: 0.16,
  brushSnare: 0.11,
  taiko: 0.7,
  cymbalSwell: 0.12,
  subBoom: 0.7,
  noiseHit: 0.28,
  noiseTick: 0.125,
  sleighBell: 0.13,
  gong: 0.45,
  fingerSnap: 0.22,
};

/**
 * Nominal sample peak of a hit at velocity 0.8 — the calibration table.
 * The two noise-channel kinds are console sounds in every kit and keep the
 * console level whatever the kit.
 */
export function drumPeak(kind: DrumKind, kit: DrumKitId): number {
  if (kit === "chip" || kind === "noiseHit" || kind === "noiseTick")
    return CHIP_PEAKS[kind];
  return DRUM_PEAKS[kind] * KIT_LEVELS[kit];
}

const KINDS = DRUM_KINDS.length;
const KIND_INDEX = Object.fromEntries(
  DRUM_KINDS.map((kind, index) => [kind, index]),
) as Record<DrumKind, number>;
const KIT_INDEX = Object.fromEntries(
  DRUM_KITS.map((kit, index) => [kit, index]),
) as Record<DrumKitId, number>;

function naturalLength(kind: DrumKind, kit: DrumKitId): number {
  if (kit === "chip") return CHIP.length(kind);
  switch (kind) {
    case "kick":
    case "tomLow":
    case "tomMid":
    case "tomHigh":
    case "taiko":
    case "subBoom":
      return MEMBRANES.length(kind, kit);
    case "snare":
    case "brushSnare":
    case "clap":
    case "rim":
    case "woodblock":
    case "fingerSnap":
      return SNARES.length(kind, kit);
    case "hatClosed":
    case "hatOpen":
    case "ride":
    case "crash":
    case "cymbalSwell":
    case "gong":
      return CYMBALS.length(kind, kit);
    case "shaker":
    case "tambourine":
    case "sleighBell":
      return SHAKEN.length(kind, kit);
    case "noiseHit":
    case "noiseTick":
      return NOISE_CHANNEL.length(kind, kit);
  }
}

function engine(h: Hit, kind: DrumKind, kit: DrumKitId): void {
  if (kit === "chip") return CHIP.render(h, kind);
  switch (kind) {
    case "kick":
    case "tomLow":
    case "tomMid":
    case "tomHigh":
    case "taiko":
    case "subBoom":
      return MEMBRANES.render(h, kind, kit);
    case "snare":
    case "brushSnare":
    case "clap":
    case "rim":
    case "woodblock":
    case "fingerSnap":
      return SNARES.render(h, kind, kit);
    case "hatClosed":
    case "hatOpen":
    case "ride":
    case "crash":
    case "cymbalSwell":
    case "gong":
      return CYMBALS.render(h, kind, kit);
    case "shaker":
    case "tambourine":
    case "sleighBell":
      return SHAKEN.render(h, kind, kit);
    case "noiseHit":
    case "noiseTick":
      return NOISE_CHANNEL.render(h, kind, kit);
  }
}

/** seconds, indexed [kit · KINDS + kind] */
const LENGTHS = new Float64Array(DRUM_KITS.length * KINDS);
for (const kit of DRUM_KITS)
  for (const kind of DRUM_KINDS)
    LENGTHS[KIT_INDEX[kit] * KINDS + KIND_INDEX[kind]] = naturalLength(
      kind,
      kit,
    );

const EMPTY = new Float32Array(0);
const hit: Hit = {
  sr: 48000,
  n: 0,
  vel: DRUM_REFERENCE_VELOCITY,
  nd: 1,
  noise: new Noise(),
  noise2: new Noise(),
  dice: new Noise(),
  mid: EMPTY,
  side: EMPTY,
  wide: false,
  pan: 0,
  trim: 1,
  drive: 0,
  driveLevel: 0,
  lowpass: 0,
  grit: 0,
  room: 0,
};

/**
 * Early reflections of a small room: [seconds, gain, side sign]. Sparse and
 * alternating in sign so they do not ring.
 */
const REFLECTIONS: readonly (readonly [number, number, number])[] = [
  [0.0071, 0.42, 1],
  [0.0113, -0.36, -1],
  [0.0167, 0.3, -1],
  [0.0229, -0.25, 1],
  [0.0307, 0.2, 1],
  [0.0401, -0.16, -1],
];
const roomFilter = new OnePoleHP();
const tapDelay = new Int32Array(6);
const tapMid = new Float64Array(6);
const tapSide = new Float64Array(6);

/** Kit colour asked for by the engine: saturation, grit, low-pass, room. */
function colour(h: Hit): void {
  const { n, sr, mid, side } = h;
  if (h.drive > 0.03) {
    // drive is relative to the hit's own peak, so it bites the transient and leaves the tail clean
    let top = h.driveLevel > 0 ? h.driveLevel : 1e-9;
    if (h.driveLevel <= 0)
      for (let i = 0; i < n; i++) {
        const a = mid[i] < 0 ? -mid[i] : mid[i];
        if (a > top) top = a;
      }
    const pre = h.drive / top;
    const make = top / fastTanh(h.drive);
    for (let i = 0; i < n; i++) mid[i] = fastTanh(mid[i] * pre) * make;
  }
  if (h.grit > 0) {
    // noise that rides on the signal and vanishes with it, like a noisy sampler
    const noise = h.noise2;
    noise.restart();
    for (let i = 0; i < n; i++) mid[i] *= 1 + h.grit * noise.next();
  }
  if (h.lowpass > 0) {
    lowpass(mid, n, h.lowpass, sr);
    if (h.wide) lowpass(side, n, h.lowpass, sr);
  }
  if (h.room > 0) {
    // only what is above the drum's fundamental reflects audibly; lows stay dry and tight
    const count = active(mid, n);
    const source = work(5, n);
    source.set(mid.subarray(0, count));
    roomFilter.setCutoff(250, sr);
    roomFilter.reset();
    roomFilter.process(source, count);
    const taps = REFLECTIONS.length;
    for (let k = 0; k < taps; k++) {
      tapDelay[k] = Math.round(REFLECTIONS[k][0] * sr);
      tapMid[k] = REFLECTIONS[k][1] * h.room * (h.wide ? 0.75 : 1);
      tapSide[k] = h.wide
        ? REFLECTIONS[k][1] * REFLECTIONS[k][2] * h.room * 0.6
        : 0;
    }
    const far = tapDelay[taps - 1];
    // until the last reflection has arrived, one tap at a time …
    for (let k = 0; k < taps; k++)
      for (let i = tapDelay[k]; i < far && i < n; i++) {
        mid[i] += tapMid[k] * source[i - tapDelay[k]];
        side[i] += tapSide[k] * source[i - tapDelay[k]];
      }
    // … then all six in one pass
    const [d0, d1, d2, d3, d4, d5] = tapDelay;
    const [m0, m1, m2, m3, m4, m5] = tapMid;
    const end = Math.min(n, count + far);
    if (h.wide) {
      const [s0, s1, s2, s3, s4, s5] = tapSide;
      for (let i = far; i < end; i++) {
        const a = source[i - d0];
        const b = source[i - d1];
        const c = source[i - d2];
        const d = source[i - d3];
        const e = source[i - d4];
        const f = source[i - d5];
        mid[i] += m0 * a + m1 * b + m2 * c + m3 * d + m4 * e + m5 * f;
        side[i] += s0 * a + s1 * b + s2 * c + s3 * d + s4 * e + s5 * f;
      }
    } else
      for (let i = far; i < end; i++)
        mid[i] +=
          m0 * source[i - d0] +
          m1 * source[i - d1] +
          m2 * source[i - d2] +
          m3 * source[i - d3] +
          m4 * source[i - d4] +
          m5 * source[i - d5];
  }
}

/**
 * Render one hit at unit level into the scratch pair hit.mid / hit.side
 * (pan, width and trim are left in `hit`).
 */
function produce(
  kind: DrumKind,
  kit: DrumKitId,
  sr: number,
  n: number,
  vel: number,
  seed: number,
): void {
  const h = hit;
  h.sr = sr;
  h.n = n;
  h.vel = vel;
  h.nd = Math.sqrt(sr / 48000);
  h.noise.seed(seed);
  h.noise2.seed(seed ^ 0x5bd1e995);
  h.dice.seed(seed ^ 0x2545f491);
  h.mid = work(0, n);
  h.side = work(1, n);
  h.wide = false;
  h.pan = 0;
  h.trim = 1;
  h.drive = 0;
  h.driveLevel = 0;
  h.lowpass = 0;
  h.grit = 0;
  h.room = 0;
  engine(h, kind, kit);
  colour(h);

  // safety fades: exactly zero at both ends, whatever the engine did
  const { mid, side } = h;
  const head = Math.min(n >> 1, Math.max(2, Math.round(0.0004 * sr)));
  for (let i = 0; i < head; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / head);
    mid[i] *= g;
    side[i] *= g;
  }
  const tail = Math.min(n - head, Math.max(2, Math.round(0.006 * sr)));
  for (let i = 0; i < tail; i++) {
    const g = 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / tail);
    mid[n - tail + i] *= g;
    side[n - tail + i] *= g;
  }
}

/** Sample peak of the hit in the scratch pair on its louder channel. */
function peakOf(h: Hit): number {
  const { n, mid, side } = h;
  const gl = panLeft(h.pan) * Math.SQRT2;
  const gr = panRight(h.pan) * Math.SQRT2;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = h.wide ? side[i] : 0;
    const l = Math.abs(mid[i] * gl + s);
    const r = Math.abs(mid[i] * gr - s);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  return peak;
}

const references = new Map<number, Float64Array>();
const TRIALS = 31;
const trial = new Float64Array(TRIALS);

/**
 * Seconds of a hit that contain its peak, which is all the calibration has
 * to render: a swell peaks at its end, a gong blooms, the rest are loudest
 * within a moment of the stroke.
 */
function peakSpan(kind: DrumKind): number {
  return kind === "cymbalSwell" ? Infinity : kind === "gong" ? 1 : 0.25;
}

/**
 * Unit-level peak of a kind/kit at the reference velocity, cached per sample
 * rate. Noise decides the exact peak of a single hit, so this is the typical
 * one: the mean of the middle half of up to 31 hits with fixed seeds.
 */
function reference(kind: DrumKind, kit: DrumKitId, sr: number): number {
  let table = references.get(sr);
  if (!table) {
    table = new Float64Array(LENGTHS.length);
    references.set(sr, table);
  }
  const slot = KIT_INDEX[kit] * KINDS + KIND_INDEX[kind];
  let value = table[slot];
  if (value === 0) {
    const seconds = Math.min(LENGTHS[slot], peakSpan(kind));
    const n = Math.max(1, Math.ceil(seconds * sr));
    const count = seconds > 1.2 ? 9 : seconds > 0.5 ? 15 : TRIALS;
    for (let i = 0; i < count; i++) {
      const seed = Math.imul(i + 1, 0x85ebca6b) ^ Math.imul(i + 7, 0xc2b2ae35);
      produce(kind, kit, sr, n, DRUM_REFERENCE_VELOCITY, seed);
      trial[i] = peakOf(hit);
    }
    const sorted = trial.subarray(0, count).sort();
    const from = count >> 2;
    const to = count - from;
    let sum = 0;
    for (let i = from; i < to; i++) sum += sorted[i];
    value = sum / (to - from) || 1;
    table[slot] = value;
  }
  return value;
}

/** No hit may exceed this sample peak. */
const CEILING = 0.98;
/** Peak a hit of velocity 1 aims for at most. */
const HEADROOM = 0.97;
const LAW = 1.5;

/**
 * Level factor of a velocity: 1 at 0.8, (vel / 0.8)^1.5 below, compressed
 * above only as far as the headroom demands.
 */
function velocityLaw(vel: number, nominal: number): number {
  const x = vel / DRUM_REFERENCE_VELOCITY;
  if (x <= 1) return Math.pow(x, LAW);
  const full = Math.pow(1 / DRUM_REFERENCE_VELOCITY, LAW);
  const top = Math.min(full, HEADROOM / nominal);
  return Math.pow(x, Math.log(top) / Math.log(1 / DRUM_REFERENCE_VELOCITY));
}

/** Identity up to `knee`, then a smooth approach to knee + room. */
function soften(x: number, knee: number, room: number): number {
  if (x > knee) return knee + room * fastTanh((x - knee) / room);
  if (x < -knee) return -knee - room * fastTanh((-x - knee) / room);
  return x;
}

export const DRUMS: DrumVoice = {
  length(kind, kit) {
    return LENGTHS[KIT_INDEX[kit] * KINDS + KIND_INDEX[kind]];
  },
  render(left, right, frames, kind, kit, vel, ctx) {
    const sr = ctx.sampleRate;
    const seed = (ctx.random() * 4294967296) >>> 0;
    const slot = KIT_INDEX[kit] * KINDS + KIND_INDEX[kind];
    const n = Math.min(frames, Math.ceil(LENGTHS[slot] * sr));
    // (also catches a kind or kit that is not in the catalogue: its length is NaN)
    if (!(vel > 0) || !(n >= 1)) return;
    const v = vel > 1 ? 1 : vel;
    const unit = reference(kind, kit, sr);
    produce(kind, kit, sr, n, v < 0.02 ? 0.02 : v, seed);
    const nominal = drumPeak(kind, kit);
    const target = nominal * velocityLaw(v, nominal);
    const gain = (target * hit.trim) / unit;
    // Noise decides the exact peak of a hit. The gain is fixed all the same
    // (equal velocities are equally loud); a peak that sticks out more than
    // usual is rounded off between `knee` and `top` instead.
    const top = Math.min(1.15 * target, CEILING);
    const knee = Math.min(0.92 * target, 0.86 * top);
    const room = top - knee;
    const { mid, side } = hit;
    const gl = gain * panLeft(hit.pan) * Math.SQRT2;
    const gr = gain * panRight(hit.pan) * Math.SQRT2;
    if (hit.wide)
      for (let i = 0; i < n; i++) {
        const s = side[i] * gain;
        left[i] += soften(mid[i] * gl + s, knee, room);
        right[i] += soften(mid[i] * gr - s, knee, room);
      }
    else if (hit.pan === 0)
      for (let i = 0; i < n; i++) {
        const x = soften(mid[i] * gl, knee, room);
        left[i] += x;
        right[i] += x;
      }
    else
      for (let i = 0; i < n; i++) {
        left[i] += soften(mid[i] * gl, knee, room);
        right[i] += soften(mid[i] * gr, knee, room);
      }
  },
};
