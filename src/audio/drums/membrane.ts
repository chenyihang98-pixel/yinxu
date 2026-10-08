/**
 * Drums with a skin: kick, toms, taiko and the cinematic sub boom.
 *
 * One engine: a sine whose pitch falls onto the resting note (fast "knock"
 * plus a slow sag), optional overtones at membrane ratios, tanh drive on the
 * body, a band-passed noise click for the beater or stick, a broader noise
 * slap for the skin and, for booms, a low rumble. A kit is a set of numbers.
 */
import { sinPhase } from "../dsp";
import type { Engine, Hit, Kit, Mode } from "./core";
import {
  bandNoise,
  byVel,
  fall,
  mix,
  ring,
  saturate,
  shape,
  span,
  work,
} from "./core";

/** [frequency ratio to the fundamental, level, decay relative to the fundamental] */
type Overtone = Mode;

interface Membrane {
  /** seconds */
  len: number;
  /** resting pitch in Hz */
  hz: number;
  /** the hit starts at hz·bend and falls with time constant bendTau */
  bend: number;
  bendTau: number;
  /** extra slow fall: starts sag·hz above, time constant sagTau */
  sag: number;
  sagTau: number;
  /** seconds to -60 dB at vel 0.8 */
  t60: number;
  /** seconds at full level before the decay starts (drum-machine kicks) */
  hold: number;
  attack: number;
  overtones: readonly Overtone[];
  drive: number;
  /** beater / stick: RMS of a band-passed noise burst relative to the body */
  click: number;
  clickHz: number;
  clickT60: number;
  /** skin: broader, lower noise burst */
  slap: number;
  slapHz: number;
  slapT60: number;
  /** low noise under a boom */
  rumble: number;
  lowpass: number;
  grit: number;
  room: number;
  pan: number;
  /** side level of the slap (0 = mono) */
  width: number;
}

const BASE: Membrane = {
  len: 0.4,
  hz: 60,
  bend: 2,
  bendTau: 0.02,
  sag: 0,
  sagTau: 0.1,
  t60: 0.3,
  hold: 0,
  attack: 0.0008,
  overtones: [],
  drive: 0,
  click: 0,
  clickHz: 3000,
  clickT60: 0.012,
  slap: 0,
  slapHz: 1000,
  slapT60: 0.04,
  rumble: 0,
  lowpass: 0,
  grit: 0,
  room: 0,
  pan: 0,
  width: 0,
};
const m = (p: Partial<Membrane>): Membrane => ({ ...BASE, ...p });

/** Ideal-membrane overtone ratios (01, 11, 21, 02, 31, 12 …) used for natural drums. */
const HEAD: readonly Overtone[] = [
  [1.59, 0.3, 0.55],
  [2.14, 0.2, 0.45],
  [2.3, 0.12, 0.4],
  [2.65, 0.12, 0.34],
  [2.92, 0.07, 0.28],
];

// prettier-ignore
const KICK: Record<Kit, Membrane> = {
  // tight and punchy: short knock, clean click, a little drive
  pop: m({ len: 0.36, hz: 52, bend: 3.2, bendTau: 0.019, sag: 0.22, sagTau: 0.09, t60: 0.33, drive: 1.3, click: 0.2, clickHz: 3400, clickT60: 0.012, slap: 0.05, slapHz: 900, slapT60: 0.03 }),
  // sampled-from-vinyl thud: rounder attack, heavy saturation, no top
  lofi: m({ len: 0.3, hz: 57, bend: 2.4, bendTau: 0.026, sag: 0.18, sagTau: 0.1, t60: 0.27, attack: 0.002, drive: 2.4, click: 0.06, clickHz: 1500, clickT60: 0.012, slap: 0.06, slapHz: 500, slapT60: 0.04, lowpass: 3200, grit: 0.07 }),
  // 808: held sine that rings on, very short pitch blip
  electro: m({ len: 0.56, hz: 48, bend: 2.6, bendTau: 0.011, sag: 0.3, sagTau: 0.06, t60: 0.58, hold: 0.04, attack: 0.0004, drive: 0.9, click: 0.15, clickHz: 2600, clickT60: 0.008 }),
  // beater on a real head: shell overtones, felt click, a breath of room
  acoustic: m({ len: 0.42, hz: 61, bend: 1.8, bendTau: 0.016, sag: 0.12, sagTau: 0.1, t60: 0.34, attack: 0.001, overtones: [[1.59, 0.22, 0.4], [2.3, 0.14, 0.3], [3.6, 0.06, 0.2]], drive: 0.5, click: 0.2, clickHz: 2900, clickT60: 0.015, slap: 0.14, slapHz: 1100, slapT60: 0.045, room: 0.3 }),
  // jazz kick: tuned higher, open, felt beater played softly
  brush: m({ len: 0.36, hz: 70, bend: 1.6, bendTau: 0.02, sag: 0.1, sagTau: 0.1, t60: 0.3, attack: 0.003, overtones: [[1.59, 0.16, 0.5]], drive: 0.25, click: 0.05, clickHz: 1300, clickT60: 0.02, slap: 0.1, slapHz: 600, slapT60: 0.05, room: 0.2 }),
  // concert bass drum scale: low, long, driven, with a skin slap
  cinematic: m({ len: 0.98, hz: 41, bend: 2.5, bendTau: 0.03, sag: 0.3, sagTau: 0.18, t60: 0.98, attack: 0.0015, overtones: [[1.59, 0.2, 0.5], [2.14, 0.12, 0.35]], drive: 1.6, click: 0.12, clickHz: 2000, clickT60: 0.02, slap: 0.22, slapHz: 1400, slapT60: 0.07, room: 0.2 }),
  // a soft thump: no click at all
  soft: m({ len: 0.28, hz: 55, bend: 1.5, bendTau: 0.03, sag: 0.08, sagTau: 0.1, t60: 0.26, attack: 0.006, slap: 0.03, slapHz: 300, slapT60: 0.04, lowpass: 900 }),
};

interface TomSet {
  common: Partial<Membrane>;
  /** [low, mid, high] */
  hz: readonly [number, number, number];
  t60: readonly [number, number, number];
}
const TOM_PAN = [0.3, 0.04, -0.26];

function toms(set: TomSet): Membrane[] {
  return [0, 1, 2].map((i) =>
    m({
      bend: 1.5,
      bendTau: 0.04,
      sag: 0.08,
      sagTau: 0.12,
      width: 0.2,
      ...set.common,
      hz: set.hz[i],
      t60: set.t60[i],
      len: set.t60[i] * 1.05 + 0.02 + (set.common.room ? 0.04 : 0),
      pan: TOM_PAN[i],
    }),
  );
}

// prettier-ignore
const TOM: Record<Kit, Membrane[]> = {
  pop: toms({ common: { bend: 1.55, overtones: [[1.59, 0.18, 0.45], [2.14, 0.1, 0.3]], click: 0.13, clickHz: 2800, slap: 0.07, slapHz: 900, slapT60: 0.03, drive: 0.6 }, hz: [92, 128, 176], t60: [0.42, 0.36, 0.3] }),
  lofi: toms({ common: { bend: 1.45, bendTau: 0.045, overtones: [[1.59, 0.12, 0.4]], click: 0.06, clickHz: 1500, slap: 0.06, slapHz: 600, drive: 1.8, lowpass: 3600, grit: 0.07, attack: 0.0015 }, hz: [84, 116, 158], t60: [0.34, 0.3, 0.26] }),
  // 808 toms: a pure tone with a long glide and a trace of noise
  electro: toms({ common: { bend: 1.9, bendTau: 0.05, sag: 0.15, sagTau: 0.2, click: 0.08, clickHz: 2200, clickT60: 0.005, slap: 0.05, slapHz: 1200, slapT60: 0.08, drive: 0.5 }, hz: [82, 122, 172], t60: [0.5, 0.42, 0.34] }),
  acoustic: toms({ common: { bend: 1.15, bendTau: 0.05, overtones: HEAD, click: 0.18, clickHz: 3200, slap: 0.12, slapHz: 1300, slapT60: 0.04, drive: 0.35, room: 0.3 }, hz: [88, 122, 168], t60: [0.5, 0.44, 0.36] }),
  brush: toms({ common: { bend: 1.1, bendTau: 0.05, overtones: [[1.59, 0.25, 0.5], [2.14, 0.12, 0.4]], click: 0.05, clickHz: 1500, slap: 0.1, slapHz: 800, slapT60: 0.05, attack: 0.003, drive: 0.2, room: 0.2 }, hz: [104, 142, 190], t60: [0.44, 0.38, 0.32] }),
  // concert toms: deep and long
  cinematic: toms({ common: { bend: 1.4, bendTau: 0.06, overtones: HEAD, click: 0.12, clickHz: 2400, slap: 0.22, slapHz: 1500, slapT60: 0.06, drive: 1, room: 0.2, width: 0.3 }, hz: [66, 88, 118], t60: [0.96, 0.82, 0.68] }),
  soft: toms({ common: { bend: 1.25, bendTau: 0.05, overtones: [[1.59, 0.08, 0.4]], slap: 0.03, slapHz: 400, attack: 0.005, lowpass: 1400 }, hz: [96, 132, 178], t60: [0.32, 0.28, 0.24] }),
};

// prettier-ignore
const TAIKO: Record<Kit, Membrane> = {
  pop: m({ len: 0.9, hz: 70, bend: 1.5, bendTau: 0.05, sag: 0.1, sagTau: 0.2, t60: 0.85, attack: 0.001, overtones: HEAD.slice(0, 4), drive: 1, click: 0.2, clickHz: 2600, slap: 0.3, slapHz: 1500, slapT60: 0.06, width: 0.2 }),
  lofi: m({ len: 0.66, hz: 66, bend: 1.45, bendTau: 0.05, sag: 0.1, sagTau: 0.2, t60: 0.62, attack: 0.002, overtones: HEAD.slice(0, 2), drive: 2.2, click: 0.08, clickHz: 1500, slap: 0.2, slapHz: 900, slapT60: 0.05, lowpass: 3000, grit: 0.07, width: 0.15 }),
  // synthetic war drum: big pitch drop, little skin
  electro: m({ len: 0.86, hz: 60, bend: 2.2, bendTau: 0.04, sag: 0.2, sagTau: 0.2, t60: 0.82, overtones: [[1.5, 0.15, 0.4]], drive: 1.2, click: 0.1, clickHz: 2400, clickT60: 0.006, slap: 0.15, slapHz: 1200, slapT60: 0.08, width: 0.15 }),
  // wooden bachi on a cowhide head
  acoustic: m({ len: 1.18, hz: 68, bend: 1.2, bendTau: 0.06, sag: 0.08, sagTau: 0.25, t60: 1.1, attack: 0.001, overtones: [...HEAD, [3.6, 0.06, 0.25]], drive: 0.8, click: 0.25, clickHz: 3000, clickT60: 0.014, slap: 0.3, slapHz: 1700, slapT60: 0.07, room: 0.3, width: 0.25 }),
  // soft mallet
  brush: m({ len: 0.78, hz: 74, bend: 1.25, bendTau: 0.06, sag: 0.06, sagTau: 0.2, t60: 0.72, attack: 0.004, overtones: HEAD.slice(0, 2), drive: 0.3, click: 0.03, clickHz: 1400, slap: 0.1, slapHz: 700, slapT60: 0.06, room: 0.2, width: 0.15 }),
  // the big one: lowest, longest, hardest slap
  cinematic: m({ len: 2, hz: 56, bend: 1.45, bendTau: 0.07, sag: 0.12, sagTau: 0.3, t60: 1.9, attack: 0.0012, overtones: [[1.59, 0.35, 0.6], [2.14, 0.25, 0.5], [2.3, 0.15, 0.45], [2.65, 0.15, 0.4], [2.92, 0.1, 0.3]], drive: 1.5, click: 0.2, clickHz: 2500, clickT60: 0.015, slap: 0.4, slapHz: 1600, slapT60: 0.09, room: 0.25, width: 0.3 }),
  soft: m({ len: 0.66, hz: 72, bend: 1.2, bendTau: 0.06, sag: 0.05, sagTau: 0.2, t60: 0.62, attack: 0.006, overtones: [[1.59, 0.1, 0.4]], slap: 0.04, slapHz: 400, lowpass: 1200 }),
};

// prettier-ignore
const BOOM: Record<Kit, Membrane> = {
  pop: m({ len: 1.28, hz: 42, bend: 2, bendTau: 0.09, sag: 0.25, sagTau: 0.4, t60: 1.2, hold: 0.03, attack: 0.004, drive: 1.6, slap: 0.18, slapHz: 500, slapT60: 0.08, rumble: 0.1 }),
  lofi: m({ len: 0.98, hz: 44, bend: 1.8, bendTau: 0.08, sag: 0.2, sagTau: 0.3, t60: 0.92, attack: 0.005, drive: 2.6, slap: 0.1, slapHz: 350, slapT60: 0.08, rumble: 0.08, lowpass: 2200, grit: 0.07 }),
  // the 808 drop: a long slow glide down
  electro: m({ len: 1.56, hz: 38, bend: 2.6, bendTau: 0.12, sag: 0.4, sagTau: 0.5, t60: 1.5, hold: 0.08, attack: 0.002, drive: 1.2, slap: 0.08, slapHz: 600, slapT60: 0.05 }),
  // gran cassa with a felt beater
  acoustic: m({ len: 1.38, hz: 46, bend: 1.3, bendTau: 0.08, sag: 0.08, sagTau: 0.3, t60: 1.3, attack: 0.005, overtones: HEAD.slice(0, 4), drive: 0.7, click: 0.04, clickHz: 1200, clickT60: 0.02, slap: 0.2, slapHz: 700, slapT60: 0.09, rumble: 0.08 }),
  brush: m({ len: 0.98, hz: 48, bend: 1.3, bendTau: 0.08, sag: 0.08, sagTau: 0.3, t60: 0.92, attack: 0.008, drive: 0.3, slap: 0.08, slapHz: 400, slapT60: 0.08, rumble: 0.05 }),
  // trailer impact: lowest and longest, an octave partial to carry on small speakers
  cinematic: m({ len: 2.9, hz: 34, bend: 2.3, bendTau: 0.12, sag: 0.35, sagTau: 0.6, t60: 2.8, hold: 0.06, attack: 0.004, overtones: [[2, 0.12, 0.7]], drive: 2, slap: 0.3, slapHz: 600, slapT60: 0.14, rumble: 0.16 }),
  soft: m({ len: 0.98, hz: 44, bend: 1.4, bendTau: 0.1, sag: 0.1, sagTau: 0.3, t60: 0.92, attack: 0.012, slap: 0.02, slapHz: 300, slapT60: 0.06, lowpass: 700 }),
};

function strike(h: Hit, p: Membrane): void {
  const { sr, n, vel } = h;
  const out = h.mid;
  // harder hits ring longer, knock further and are driven harder
  const t60 = p.t60 * byVel(h, 0.8, 1.05);
  const base = p.hz / sr;
  const k1 = Math.exp(-1 / (p.bendTau * sr));
  const k2 = Math.exp(-1 / (p.sagTau * sr));
  const k = fall(t60, sr);
  const from = Math.round(p.hold * sr);
  const end = Math.min(n, from + span(t60, sr, n));
  let e1 = (p.bend - 1) * byVel(h, 0.5, 1.12);
  let e2 = p.sag;
  let phase = 0;
  let a = 1;
  for (let i = 0; i < end; i++) {
    out[i] += a * sinPhase(phase);
    phase += base * (1 + e1 + e2);
    if (phase >= 1) phase -= 1;
    e1 *= k1;
    e2 *= k2;
    if (i >= from) a *= k;
  }
  // the overtones of the head ring at their resting pitch
  ring(out, n, sr, p.overtones, byVel(h, 0.5, 1.12), p.hz, t60);

  // a soft hit lands softly
  const attack = p.attack * (1 + 2 * (1 - vel)) + 0.004 * (1 - vel) * (1 - vel);
  const rise = Math.min(n, Math.max(1, Math.round(attack * sr)));
  for (let i = 0; i < rise; i++)
    out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / rise);
  saturate(out, n, p.drive * byVel(h, 0.5, 1.12));

  if (p.click > 0) {
    const count = span(p.clickT60, sr, n, 70);
    const click = work(3, count);
    bandNoise(h, click, count, p.clickHz * byVel(h, 0.7, 1.075), 0.8);
    shape(click, count, sr, 0.0003, p.clickT60);
    mix(out, click, count, p.click * (0.25 + 1.17 * vel * vel));
  }
  if (p.slap > 0) {
    const decay = p.slapT60 * byVel(h, 0.8, 1.05);
    const count = span(decay, sr, n, 70);
    const level = p.slap * byVel(h, 0.4, 1.15);
    const slapHz = p.slapHz * byVel(h, 0.75, 1.06);
    const slap = work(3, count);
    bandNoise(h, slap, count, slapHz, 0.55);
    shape(slap, count, sr, 0.0008, decay);
    mix(out, slap, count, level);
    if (p.width > 0) {
      bandNoise(h, slap, count, slapHz, 0.55, h.noise2);
      shape(slap, count, sr, 0.0008, decay);
      mix(h.side, slap, count, level * p.width);
      h.wide = true;
    }
  }
  if (p.rumble > 0) {
    const decay = t60 * 0.45;
    const count = span(decay, sr, n, 70);
    const rumble = work(3, count);
    bandNoise(h, rumble, count, 70, 0.8);
    shape(rumble, count, sr, 0.012, decay);
    mix(out, rumble, count, p.rumble);
  }
  h.pan = p.pan;
  h.lowpass = p.lowpass > 0 ? p.lowpass * byVel(h, 0.65, 1.09) : 0;
  h.grit = p.grit;
  h.room = p.room;
}

export type MembraneKind =
  | "kick"
  | "tomLow"
  | "tomMid"
  | "tomHigh"
  | "taiko"
  | "subBoom";

function recipe(kind: MembraneKind, kit: Kit): Membrane {
  switch (kind) {
    case "kick":
      return KICK[kit];
    case "tomLow":
      return TOM[kit][0];
    case "tomMid":
      return TOM[kit][1];
    case "tomHigh":
      return TOM[kit][2];
    case "taiko":
      return TAIKO[kit];
    case "subBoom":
      return BOOM[kit];
  }
}

export const MEMBRANES: Engine<MembraneKind> = {
  length: (kind, kit) => recipe(kind, kit).len,
  render: (h, kind, kit) => strike(h, recipe(kind, kit)),
};
