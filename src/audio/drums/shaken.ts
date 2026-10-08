/**
 * Things full of small parts: shaker, tambourine, sleigh bells.
 *
 * A particle model (after Perry Cook's PhISM): the instrument holds an
 * amount of shake energy that builds up or is injected by a strike and then
 * dies away; while it lasts, beads or jingles collide, every collision is a
 * clink that rings the resonances of the object — broad for a shaker's
 * shell, narrow and metallic for jingles and bells — and a grain of noise
 * that passes straight through. No two hits are the same, like the real
 * thing, but equal hits are about equally loud.
 */
import { Biquad } from "../dsp";
import type { Engine, Hit, Kit } from "./core";
import { bandNoise, byVel, fall, mix, shape, span, work } from "./core";

/** [centre Hz, quality, level, pan -1..1] of one resonance */
type Jingle = readonly [hz: number, q: number, level: number, pan: number];

interface Shaken {
  len: number;
  /** seconds for the motion to build up (0 = struck) */
  attack: number;
  /** T60 of the shake energy */
  t60: number;
  /** collisions per second at full energy */
  density: number;
  /** T60 of a single collision grain */
  grain: number;
  /** energy thrown in at the very start (hand on a tambourine) */
  strike: number;
  jingles: readonly Jingle[];
  /** the dry rattle: grains through a high-pass only */
  direct: number;
  directHz: number;
  /** tambourine head: level and pitch */
  thump: number;
  thumpHz: number;
  drive: number;
  lowpass: number;
  grit: number;
  pan: number;
  width: number;
}

const BASE: Shaken = {
  len: 0.15,
  attack: 0.02,
  t60: 0.1,
  density: 3000,
  grain: 0.004,
  strike: 0,
  jingles: [],
  direct: 0.4,
  directHz: 4000,
  thump: 0,
  thumpHz: 200,
  drive: 0,
  lowpass: 0,
  grit: 0,
  pan: 0,
  width: 0.3,
};
const sh = (p: Partial<Shaken>): Shaken => ({ ...BASE, ...p });

// prettier-ignore
const SHAKER: Record<Kit, Shaken> = {
  pop: sh({ len: 0.13, attack: 0.012, t60: 0.1, density: 3500, jingles: [[6500, 2.5, 1, -0.5], [9200, 3, 0.8, 0.6]], direct: 0.5, directHz: 5000, pan: 0.3 }),
  lofi: sh({ len: 0.11, attack: 0.013, t60: 0.085, density: 2500, grain: 0.005, jingles: [[3600, 2, 1, -0.4], [5200, 2.5, 0.6, 0.5]], direct: 0.25, directHz: 2500, drive: 1.4, lowpass: 6500, grit: 0.08, pan: 0.3, width: 0.2 }),
  // machine maracas: one crisp burst of high noise
  electro: sh({ len: 0.075, attack: 0.004, t60: 0.06, density: 9000, grain: 0.002, jingles: [[8000, 1.2, 1, 0]], direct: 1, directHz: 6000, pan: 0.3, width: 0.2 }),
  // egg shaker: the beads travel before they land
  acoustic: sh({ len: 0.18, attack: 0.016, t60: 0.13, density: 2600, grain: 0.005, jingles: [[4800, 2, 0.8, -0.6], [7200, 2.5, 1, 0.4], [10500, 3, 0.6, 0.7]], direct: 0.4, directHz: 3500, pan: 0.3, width: 0.35 }),
  brush: sh({ len: 0.15, attack: 0.015, t60: 0.11, density: 2200, grain: 0.005, jingles: [[4200, 2, 1, -0.5], [6500, 2.5, 0.7, 0.5]], direct: 0.3, directHz: 3000, pan: 0.3 }),
  // a big seed-pod rattle
  cinematic: sh({ len: 0.28, attack: 0.022, t60: 0.2, density: 1800, grain: 0.007, jingles: [[2600, 1.8, 1, -0.7], [4100, 2, 0.9, 0.7], [6400, 2.5, 0.6, 0]], direct: 0.35, directHz: 2000, pan: 0.2, width: 0.5 }),
  soft: sh({ len: 0.14, attack: 0.018, t60: 0.1, density: 3000, jingles: [[4500, 1.8, 1, 0]], direct: 0.2, directHz: 3000, lowpass: 7500, pan: 0.3, width: 0.2 }),
};

const ZILS: readonly Jingle[] = [
  [2700, 14, 0.5, -0.6],
  [4400, 18, 0.7, 0.5],
  [5900, 22, 1, -0.3],
  [7600, 24, 0.9, 0.6],
  [9400, 26, 0.7, -0.5],
  [11400, 28, 0.4, 0.3],
];

// prettier-ignore
const TAMBOURINE: Record<Kit, Shaken> = {
  pop: sh({ len: 0.32, attack: 0, t60: 0.26, density: 900, grain: 0.003, strike: 1.4, jingles: ZILS, direct: 0.25, directHz: 6000, pan: -0.3, width: 0.5 }),
  lofi: sh({ len: 0.24, attack: 0, t60: 0.2, density: 800, grain: 0.004, strike: 1.3, jingles: [[2300, 12, 0.6, -0.5], [3600, 14, 1, 0.5], [4900, 16, 0.8, -0.3], [6100, 18, 0.5, 0.4]], direct: 0.15, directHz: 3500, drive: 1.4, lowpass: 7000, grit: 0.08, pan: -0.3, width: 0.3 }),
  // synthetic: three bright bands and a lot of plain noise
  electro: sh({ len: 0.2, attack: 0, t60: 0.16, density: 2000, grain: 0.002, strike: 1.6, jingles: [[5400, 8, 0.8, -0.4], [7100, 8, 1, 0.4], [9300, 10, 0.8, 0]], direct: 0.6, directHz: 7000, pan: -0.3, width: 0.4 }),
  // with a head: the hand lands on skin, then the zils ring
  acoustic: sh({ len: 0.4, attack: 0, t60: 0.34, density: 800, grain: 0.003, strike: 1.4, jingles: [[2500, 14, 0.5, -0.6], [4100, 18, 0.8, 0.5], [5600, 22, 1, -0.3], [7300, 24, 0.9, 0.6], [9000, 26, 0.7, -0.5], [10800, 28, 0.5, 0.3], [12600, 28, 0.3, -0.2]], direct: 0.2, directHz: 5000, thump: 0.2, thumpHz: 210, pan: -0.3, width: 0.5 }),
  brush: sh({ len: 0.28, attack: 0, t60: 0.23, density: 700, grain: 0.003, strike: 0.8, jingles: ZILS.slice(0, 5), direct: 0.15, directHz: 5000, thump: 0.12, thumpHz: 230, pan: -0.3, width: 0.4 }),
  // several players
  cinematic: sh({ len: 0.55, attack: 0, t60: 0.46, density: 1100, grain: 0.004, strike: 1.5, jingles: [[2200, 12, 0.6, -0.8], [3300, 14, 0.7, 0.7], [4400, 18, 0.9, -0.4], [5900, 22, 1, 0.5], [7600, 24, 0.9, -0.6], [9400, 26, 0.7, 0.8], [11400, 28, 0.4, 0]], direct: 0.2, directHz: 4000, thump: 0.2, thumpHz: 170, pan: 0, width: 0.7 }),
  soft: sh({ len: 0.24, attack: 0.004, t60: 0.2, density: 600, grain: 0.003, strike: 0.7, jingles: ZILS.slice(0, 4), direct: 0.1, directHz: 4000, lowpass: 8500, pan: -0.3, width: 0.3 }),
};

const BELLS: readonly Jingle[] = [
  [2500, 40, 0.5, -0.7],
  [5300, 60, 0.9, 0.5],
  [6500, 70, 1, -0.3],
  [8300, 80, 0.9, 0.7],
  [9800, 90, 0.7, -0.5],
  [11900, 90, 0.4, 0.3],
];

// prettier-ignore
const SLEIGH: Record<Kit, Shaken> = {
  pop: sh({ len: 0.5, attack: 0.008, t60: 0.42, density: 420, grain: 0.0025, strike: 1.2, jingles: BELLS, direct: 0.08, directHz: 7000, pan: 0.25, width: 0.6 }),
  lofi: sh({ len: 0.36, attack: 0.008, t60: 0.3, density: 380, grain: 0.003, strike: 1.1, jingles: [[2300, 35, 0.6, -0.6], [4200, 50, 1, 0.5], [5400, 60, 0.9, -0.3], [6800, 70, 0.5, 0.5]], direct: 0.05, directHz: 4000, drive: 1.2, lowpass: 7500, grit: 0.08, pan: 0.25, width: 0.4 }),
  // a tuned bell tree: C, E, G and the octave
  electro: sh({ len: 0.4, attack: 0.005, t60: 0.32, density: 600, grain: 0.002, strike: 1.3, jingles: [[4186, 60, 1, -0.6], [5274, 70, 0.9, 0.5], [6272, 80, 0.9, -0.2], [8372, 90, 0.7, 0.6]], direct: 0.05, directHz: 7000, pan: 0.25, width: 0.5 }),
  acoustic: sh({ len: 0.6, attack: 0.01, t60: 0.5, density: 380, grain: 0.0025, strike: 1.2, jingles: [...BELLS, [3600, 50, 0.6, 0.1], [7400, 75, 0.8, -0.6]], direct: 0.1, directHz: 6000, pan: 0.25, width: 0.6 }),
  brush: sh({ len: 0.45, attack: 0.012, t60: 0.37, density: 300, grain: 0.0025, strike: 0.8, jingles: BELLS.slice(0, 5), direct: 0.06, directHz: 6000, pan: 0.25, width: 0.5 }),
  // a whole harness of bells
  cinematic: sh({ len: 0.8, attack: 0.012, t60: 0.7, density: 520, grain: 0.003, strike: 1.3, jingles: [[2100, 40, 0.5, -0.8], [3300, 50, 0.6, 0.8], [4700, 60, 0.9, -0.5], [5900, 70, 1, 0.4], [7200, 80, 0.9, -0.2], [8700, 85, 0.8, 0.7], [10300, 90, 0.6, -0.7], [12200, 90, 0.4, 0.2]], direct: 0.08, directHz: 5000, pan: 0, width: 0.8 }),
  soft: sh({ len: 0.5, attack: 0.016, t60: 0.4, density: 260, grain: 0.003, strike: 0.6, jingles: BELLS.slice(0, 5), direct: 0.03, directHz: 5000, lowpass: 9000, pan: 0.25, width: 0.5 }),
};

const MAX = 8;
const probe = new Biquad();
const b0 = new Float64Array(MAX);
const a1 = new Float64Array(MAX);
const a2 = new Float64Array(MAX);
const z1 = new Float64Array(MAX);
const z2 = new Float64Array(MAX);
const toMid = new Float64Array(MAX);
const toSide = new Float64Array(MAX);
const dry = new Biquad();

function shake(h: Hit, p: Shaken): void {
  const { sr, n, vel, mid, side } = h;
  // resonances; a hard shake tilts the energy towards the upper ones
  const tilt = (vel - 0.8) * 0.9;
  let centre = 1;
  if (p.jingles.length) {
    let log = 0;
    let weight = 0;
    for (const jingle of p.jingles) {
      log += jingle[2] * jingle[2] * Math.log(jingle[0]);
      weight += jingle[2] * jingle[2];
    }
    centre = Math.exp(log / Math.max(weight, 1e-9));
  }
  let count = 0;
  for (const [hz, q, level, pan] of p.jingles) {
    if (hz >= sr * 0.44 || count >= MAX) continue;
    probe.setBandpass(hz, q, sr);
    b0[count] = probe.b0;
    a1[count] = probe.a1;
    a2[count] = probe.a2;
    z1[count] = 0;
    z2[count] = 0;
    // the narrower the resonance, the quieter it rings: make up for part of that
    const g = level * Math.sqrt(q) * Math.pow(hz / centre, tilt);
    toMid[count] = g;
    toSide[count] = g * pan * p.width;
    count++;
  }
  dry.setHighpass(Math.min(p.directHz * byVel(h, 0.75, 1.06), sr * 0.42), 0.7071, sr).reset();
  const direct = p.direct * byVel(h, 0.6, 1.1);

  const build = Math.round(p.attack * (1 + 0.6 * (1 - vel)) * sr);
  const energyK = fall(p.t60 * byVel(h, 0.8, 1.05), sr);
  const grainK = fall(p.grain, sr);
  const chance = (p.density * byVel(h, 0.85, 1.04)) / sr;
  const noise = h.noise;
  const dice = h.dice;
  const nd = h.nd;
  noise.restart();
  // The strike: one impulse that sets every jingle ringing together, plus a
  // noise grain. A gentle hand lands over a few milliseconds instead of at once.
  const landing = Math.max(1, Math.round((0.0002 + 0.003 * (1 - vel) * (1 - vel)) * sr));
  const thrown = (0.5 * p.strike) / landing;
  // an impulse has to grow with the sample rate to ring a resonance equally
  const impulse = 3 * (sr / 48000);
  const impact = (2 * p.strike * impulse) / landing;
  // Collisions get weaker with the energy but rarer only with its square
  // root: a ringing tambourine keeps sizzling quietly instead of stopping.
  const rateK = Math.sqrt(energyK);
  let level = 0;
  let decay = 1;
  let rate = 1;
  // collisions come at jittered, not at purely random, intervals: the same
  // shake always holds about the same number of them, so it is equally loud
  let due = dice.uniform();
  let wait = 0;
  for (let i = 0; i < n; i++) {
    let energy: number;
    if (i < build) energy = 0.5 - 0.5 * Math.cos((Math.PI * i) / build);
    else {
      energy = decay;
      decay *= energyK;
      rate *= rateK;
    }
    // what the jingles hear: the clink of each collision (the tiny floor here
    // and below keeps the filters out of denormal numbers between collisions)
    let clink = 1e-12;
    wait += chance * (i < build ? energy : rate);
    if (wait >= due) {
      wait -= due;
      due = 0.5 + dice.uniform();
      const hit = energy * (0.7 + 0.3 * dice.uniform());
      level += hit;
      clink = dice.next() < 0 ? -hit * impulse : hit * impulse;
    }
    if (i < landing) {
      level += thrown;
      clink += impact;
    }
    // what the shell lets through directly: the grain of noise of each collision
    const x = (level + 1e-12) * noise.next() * nd;
    level = level < 1e-20 ? 0 : level * grainK;
    let m = direct * dry.next(x);
    let s = 0;
    for (let j = 0; j < count; j++) {
      const y = b0[j] * clink + z1[j];
      z1[j] = z2[j] - a1[j] * y;
      z2[j] = -b0[j] * clink - a2[j] * y;
      m += toMid[j] * y;
      s += toSide[j] * y;
    }
    mid[i] = m;
    side[i] = s;
  }
  h.wide = p.width > 0 && count > 0;
  if (p.thump > 0) {
    const short = span(0.07, sr, n, 70);
    const thump = work(3, short);
    bandNoise(h, thump, short, p.thumpHz, 1.2);
    shape(thump, short, sr, 0.001, 0.07);
    mix(mid, thump, short, p.thump * byVel(h, 0.9, 1.025) * p.strike);
  }
  h.pan = p.pan;
  h.drive = p.drive;
  h.lowpass = p.lowpass > 0 ? p.lowpass * byVel(h, 0.75, 1.06) : 0;
  h.grit = p.grit;
}

export type ShakenKind = "shaker" | "tambourine" | "sleighBell";

function recipe(kind: ShakenKind, kit: Kit): Shaken {
  return kind === "shaker"
    ? SHAKER[kit]
    : kind === "tambourine"
      ? TAMBOURINE[kit]
      : SLEIGH[kit];
}

export const SHAKEN: Engine<ShakenKind> = {
  length: (kind, kit) => recipe(kind, kit).len,
  render: (h, kind, kit) => shake(h, recipe(kind, kit)),
};
