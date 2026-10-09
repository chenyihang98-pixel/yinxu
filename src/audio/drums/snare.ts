/**
 * Sticks, hands and brushes: snare, brush stroke, clap, rim click, wood
 * block and finger snap.
 *
 *  - snare: tuned shell modes + band-passed "wire" noise with its own
 *    envelope + a very short crack;
 *  - brushSnare: noise through a gliding band-pass with a slow swell and a
 *    grainy bristle texture;
 *  - clap: one noise band gated by several bursts 8–12 ms apart, then a tail;
 *  - rim / woodblock: a handful of struck modes and a click;
 *  - fingerSnap: a quiet flick, then a short resonant band of noise.
 */
import { Svf } from "../dsp";
import type { Engine, Hit, Kit, Mode } from "./core";
import {
  bandNoise,
  byVel,
  fall,
  highNoise,
  highpass,
  mix,
  mixDelayed,
  ring,
  saturate,
  shape,
  span,
  sweep,
  work,
} from "./core";

/* ------------------------------------------------------------------ */
/* snare                                                               */
/* ------------------------------------------------------------------ */

interface Snare {
  len: number;
  /** shell modes; the first two carry the "note" of the drum */
  shell: readonly Mode[];
  /** level of the shell against the wires */
  tone: number;
  /** > 1: the shell starts this much sharp and falls (drum machines) */
  drop: number;
  dropTau: number;
  /** wires: RMS level, band centre, quality, extra high-pass, decay, attack */
  noise: number;
  band: number;
  q: number;
  hp: number;
  noiseT60: number;
  noiseAttack: number;
  /** 0..1 how much the shell shakes the wires (amplitude modulation) */
  wires: number;
  /** stick: very short high-passed burst */
  crack: number;
  crackHz: number;
  drive: number;
  lowpass: number;
  grit: number;
  room: number;
}

const SNARE_BASE: Snare = {
  len: 0.25,
  shell: [],
  tone: 1,
  drop: 1,
  dropTau: 0.01,
  noise: 0.5,
  band: 4000,
  q: 0.7,
  hp: 600,
  noiseT60: 0.2,
  noiseAttack: 0.0005,
  wires: 0,
  crack: 0,
  crackHz: 7000,
  drive: 0,
  lowpass: 0,
  grit: 0,
  room: 0,
};
const s = (p: Partial<Snare>): Snare => ({ ...SNARE_BASE, ...p });

// prettier-ignore
const SNARE: Record<Kit, Snare> = {
  // tight backbeat: clear 186 Hz note, bright wires, a crack on top
  pop: s({ len: 0.24, shell: [[186, 1, 0.13], [332, 0.45, 0.085], [530, 0.12, 0.05]], tone: 0.9, noise: 0.65, band: 3900, q: 0.65, hp: 700, noiseT60: 0.2, crack: 0.25, crackHz: 7000, drive: 0.6 }),
  // dull, crunchy, short: the wires sit around 2.4 kHz and nothing survives above 6 kHz
  lofi: s({ len: 0.2, shell: [[170, 1, 0.12], [300, 0.4, 0.07]], tone: 1, noise: 0.6, band: 2400, q: 0.9, hp: 400, noiseT60: 0.15, noiseAttack: 0.0015, drive: 1.8, lowpass: 5600, grit: 0.08 }),
  // drum machine: two falling oscillators and a snappy high-passed burst
  electro: s({ len: 0.22, shell: [[180, 1, 0.1], [330, 0.55, 0.06]], tone: 0.9, drop: 1.7, dropTau: 0.012, noise: 0.75, band: 4800, q: 0.5, hp: 1500, noiseT60: 0.17, crack: 0.2, crackHz: 9000, drive: 0.8 }),
  // a real drum: more shell modes, wires that buzz with the head and ring longer
  acoustic: s({ len: 0.36, shell: [[175, 1, 0.16], [285, 0.35, 0.1], [330, 0.5, 0.12], [520, 0.2, 0.07], [700, 0.1, 0.05]], tone: 0.85, noise: 0.6, band: 3600, q: 0.5, hp: 500, noiseT60: 0.27, wires: 0.45, crack: 0.3, crackHz: 6000, drive: 0.3, room: 0.3 }),
  // a tap with the brush: bristles spread the attack, little shell
  brush: s({ len: 0.2, shell: [[190, 0.5, 0.1], [340, 0.25, 0.07]], tone: 0.7, noise: 0.5, band: 5200, q: 0.6, hp: 900, noiseT60: 0.12, noiseAttack: 0.004, wires: 0.3, room: 0.2 }),
  // orchestral field drum: deep shell, long wires
  cinematic: s({ len: 0.52, shell: [[150, 1, 0.22], [245, 0.5, 0.16], [400, 0.2, 0.1]], tone: 0.9, noise: 0.65, band: 3000, q: 0.5, hp: 400, noiseT60: 0.42, wires: 0.4, crack: 0.25, crackHz: 5500, drive: 0.5, room: 0.25 }),
  // barely more than a soft tap
  soft: s({ len: 0.17, shell: [[200, 0.8, 0.09], [350, 0.2, 0.05]], tone: 1, noise: 0.5, band: 2800, q: 0.8, hp: 500, noiseT60: 0.11, noiseAttack: 0.003, lowpass: 6000 }),
};

function snare(h: Hit, p: Snare): void {
  const { sr, n, vel } = h;
  const out = h.mid;
  const stretch = byVel(h, 0.8, 1.05);
  // quiet strokes are mostly drum, loud ones mostly wires and crack
  const tone = p.tone * byVel(h, 1.2, 0.95);
  if (p.drop > 1) {
    const from = 1 + (p.drop - 1) * byVel(h, 0.5, 1.12);
    for (const [hz, level, t60] of p.shell)
      sweep(out, n, sr, hz, hz * from, p.dropTau, level * tone, t60 * stretch);
  } else ring(out, n, sr, p.shell, tone, 1, stretch, (vel - 0.8) * 0.6);

  const decay = p.noiseT60 * stretch;
  const count = span(decay, sr, n, 70);
  const wires = work(3, count);
  bandNoise(h, wires, count, p.band * byVel(h, 0.7, 1.075), p.q);
  highpass(wires, count, p.hp, sr);
  shape(wires, count, sr, p.noiseAttack * (1 + 4 * (1 - vel)), decay);
  if (p.wires > 0)
    for (let i = 0; i < count; i++) wires[i] *= 1 + p.wires * out[i];
  mix(out, wires, count, p.noise * byVel(h, 0.55, 1.11));

  if (p.crack > 0) {
    const short = span(0.01, sr, n, 70);
    const crack = work(3, short);
    highNoise(h, crack, short, p.crackHz);
    shape(crack, short, sr, 0.0002, 0.01);
    mix(out, crack, short, p.crack * (0.2 + 1.25 * vel * vel));
  }
  // a light stroke has no edge: the whole drum eases in
  const ease = Math.min(
    n,
    Math.round((0.0003 + 0.004 * (1 - vel) * (1 - vel)) * sr),
  );
  for (let i = 0; i < ease; i++)
    out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / ease);
  saturate(out, n, p.drive * byVel(h, 0.6, 1.1));
  h.lowpass = p.lowpass > 0 ? p.lowpass * byVel(h, 0.65, 1.09) : 0;
  h.grit = p.grit;
  h.room = p.room;
}

/* ------------------------------------------------------------------ */
/* brush stroke                                                        */
/* ------------------------------------------------------------------ */

interface Brush {
  len: number;
  /** seconds the swish takes to swell, then its decay */
  attack: number;
  t60: number;
  /** the band-pass glides from → to (Hz) over the stroke */
  from: number;
  to: number;
  q: number;
  /** 0..1 depth of the bristle grain */
  texture: number;
  /** a light tap at the start of the stroke */
  tap: number;
  /** a hint of the drum under the brush */
  shell: readonly Mode[];
  lowpass: number;
  grit: number;
  room: number;
  width: number;
}

// prettier-ignore
const BRUSH: Record<Kit, Brush> = {
  pop: { len: 0.27, attack: 0.02, t60: 0.2, from: 3000, to: 6500, q: 0.7, texture: 0.3, tap: 0.35, shell: [[190, 0.2, 0.08]], lowpass: 0, grit: 0, room: 0, width: 0.2 },
  lofi: { len: 0.25, attack: 0.024, t60: 0.18, from: 2200, to: 4200, q: 0.8, texture: 0.35, tap: 0.3, shell: [[175, 0.2, 0.08]], lowpass: 5000, grit: 0.08, room: 0, width: 0.15 },
  // machine "shh": plain high noise that swells quickly
  electro: { len: 0.23, attack: 0.018, t60: 0.17, from: 5000, to: 9000, q: 0.5, texture: 0, tap: 0, shell: [], lowpass: 0, grit: 0, room: 0, width: 0.2 },
  acoustic: { len: 0.31, attack: 0.025, t60: 0.2, from: 3200, to: 7000, q: 0.6, texture: 0.4, tap: 0.35, shell: [[180, 0.3, 0.1], [330, 0.15, 0.08]], lowpass: 0, grit: 0, room: 0.3, width: 0.25 },
  // the stroke the kit is named after: long swish across the head
  brush: { len: 0.44, attack: 0.035, t60: 0.31, from: 2200, to: 5000, q: 0.6, texture: 0.45, tap: 0.4, shell: [[190, 0.25, 0.1], [340, 0.12, 0.07]], lowpass: 0, grit: 0, room: 0.2, width: 0.25 },
  cinematic: { len: 0.56, attack: 0.05, t60: 0.4, from: 2200, to: 5500, q: 0.5, texture: 0.4, tap: 0.3, shell: [[150, 0.3, 0.16]], lowpass: 0, grit: 0, room: 0.25, width: 0.3 },
  soft: { len: 0.32, attack: 0.04, t60: 0.22, from: 2000, to: 4000, q: 0.7, texture: 0.3, tap: 0.15, shell: [], lowpass: 6000, grit: 0, room: 0, width: 0.2 },
};

const svf = new Svf();

function brush(h: Hit, p: Brush): void {
  const { sr, n } = h;
  const out = h.mid;
  const attack = p.attack * byVel(h, 1.5, 0.87);
  const decay = p.t60 * byVel(h, 0.8, 1.05);
  const rise = Math.max(1, Math.round(attack * sr));
  const bright = byVel(h, 0.7, 1.075);
  const k = fall(decay, sr);
  // slow random gain: the bristles catch and release
  const smooth = 1 - Math.exp((-2 * Math.PI * 300) / sr);
  const grain = p.texture / (0.5774 * Math.sqrt(smooth / (2 - smooth)));
  const stroke = attack + decay * 0.4;
  const env = work(4, n);
  const q = p.q;
  svf.reset();
  h.noise.restart();
  let a = 1;
  let rough = 0;
  for (let i = 0; i < n; i++) {
    if ((i & 31) === 0) {
      const x = Math.min(1, i / (stroke * sr));
      svf.set(p.from * Math.pow(p.to / p.from, x) * bright, q, sr);
    }
    let e: number;
    if (i < rise) e = 0.5 - 0.5 * Math.cos((Math.PI * i) / rise);
    else {
      e = a;
      a *= k;
    }
    rough += smooth * (h.dice.next() - rough);
    const g = 1 + grain * rough;
    env[i] = e;
    out[i] = svf.band(h.noise.next()) * e * (g < 0.2 ? 0.2 : g);
  }
  // unit RMS for the band at its mean centre
  const centre = Math.sqrt(p.from * p.to) * bright;
  const norm =
    h.nd / (q * 0.5774 * Math.sqrt((Math.PI * centre) / (48000 * q)));
  for (let i = 0; i < n; i++) out[i] *= norm;

  if (p.width > 0) {
    const side = work(3, n);
    bandNoise(h, side, n, centre, q, h.noise2);
    for (let i = 0; i < n; i++) h.side[i] += side[i] * env[i] * p.width;
    h.wide = true;
  }
  if (p.tap > 0) {
    const short = span(0.03, sr, n, 70);
    const tap = work(3, short);
    bandNoise(h, tap, short, 5500 * bright, 0.6);
    shape(tap, short, sr, 0.002, 0.03);
    mix(out, tap, short, p.tap * byVel(h, 0.3, 1.18));
  }
  ring(out, n, sr, p.shell, byVel(h, 0.6, 1.1));
  h.lowpass = p.lowpass;
  h.grit = p.grit;
  h.room = p.room;
}

/* ------------------------------------------------------------------ */
/* clap                                                                */
/* ------------------------------------------------------------------ */

interface Clap {
  len: number;
  /** number of bursts including the last one, which carries the tail */
  bursts: number;
  /** mean seconds between bursts and how much they wander (0..1) */
  gap: number;
  jitter: number;
  burstT60: number;
  tailT60: number;
  band: number;
  q: number;
  /** a second, higher band for the "air" of real hands */
  air: number;
  airHz: number;
  drive: number;
  lowpass: number;
  grit: number;
  room: number;
  width: number;
}

// prettier-ignore
const CLAP: Record<Kit, Clap> = {
  pop: { len: 0.25, bursts: 4, gap: 0.0098, jitter: 0.12, burstT60: 0.022, tailT60: 0.17, band: 1300, q: 1.3, air: 0.3, airHz: 4200, drive: 0.4, lowpass: 0, grit: 0, room: 0, width: 0.25 },
  lofi: { len: 0.2, bursts: 3, gap: 0.0105, jitter: 0.15, burstT60: 0.024, tailT60: 0.13, band: 950, q: 1.4, air: 0, airHz: 3000, drive: 1.6, lowpass: 4500, grit: 0.08, room: 0, width: 0.15 },
  // the classic: three sawtooth bursts 10 ms apart through a 1 kHz band-pass, then a reverb-like tail
  electro: { len: 0.29, bursts: 4, gap: 0.01, jitter: 0, burstT60: 0.02, tailT60: 0.21, band: 1050, q: 2, air: 0.12, airHz: 3500, drive: 0.5, lowpass: 0, grit: 0, room: 0, width: 0.2 },
  // a few real hands: uneven timing and levels, more air, a short room
  acoustic: { len: 0.26, bursts: 5, gap: 0.0092, jitter: 0.4, burstT60: 0.02, tailT60: 0.14, band: 1500, q: 0.9, air: 0.5, airHz: 3800, drive: 0, lowpass: 0, grit: 0, room: 0.3, width: 0.3 },
  brush: { len: 0.18, bursts: 2, gap: 0.011, jitter: 0.3, burstT60: 0.02, tailT60: 0.1, band: 1400, q: 1, air: 0.3, airHz: 3500, drive: 0, lowpass: 0, grit: 0, room: 0.2, width: 0.2 },
  // a hall full of hands
  cinematic: { len: 0.52, bursts: 7, gap: 0.0085, jitter: 0.45, burstT60: 0.03, tailT60: 0.42, band: 1150, q: 0.9, air: 0.4, airHz: 3200, drive: 0.3, lowpass: 0, grit: 0, room: 0.25, width: 0.5 },
  soft: { len: 0.16, bursts: 2, gap: 0.012, jitter: 0.2, burstT60: 0.022, tailT60: 0.09, band: 1200, q: 1, air: 0, airHz: 3000, drive: 0, lowpass: 5000, grit: 0, room: 0, width: 0.2 },
};

const starts = new Int32Array(8);
const levels = new Float32Array(8);

function clap(h: Hit, p: Clap): void {
  const { sr, n, vel } = h;
  const out = h.mid;
  const bright = byVel(h, 0.75, 1.06);
  bandNoise(h, out, n, p.band * bright, p.q);
  if (p.air > 0) {
    const air = work(3, n);
    bandNoise(h, air, n, p.airHz * bright, 0.8);
    mix(out, air, n, p.air * byVel(h, 0.4, 1.15));
  }
  // the gate: every burst restarts the envelope, the last one rings out
  const env = work(4, n);
  let t = 0;
  for (let b = 0; b < p.bursts; b++) {
    starts[b] = Math.round(t * sr);
    const last = b === p.bursts - 1;
    levels[b] = last
      ? 1
      : 0.6 + 0.3 * (b / p.bursts) + p.jitter * 0.4 * h.dice.next();
    t += p.gap * (1 + p.jitter * h.dice.next());
  }
  const ramp = Math.max(2, Math.round(0.0003 * sr));
  const burstK = fall(p.burstT60, sr);
  const tailK = fall(p.tailT60 * byVel(h, 0.75, 1.06), sr);
  let e = 0;
  for (let b = 0; b < p.bursts; b++) {
    const from = Math.min(n, starts[b]);
    const last = b === p.bursts - 1;
    const to = last ? n : Math.min(n, starts[b + 1]);
    const k = last ? tailK : burstK;
    const top = Math.min(to, from + ramp);
    for (let i = from; i < top; i++) {
      e += (levels[b] - e) / (ramp - (i - from));
      env[i] = e;
    }
    for (let i = top; i < to; i++) {
      e *= k;
      env[i] = e;
    }
  }
  for (let i = 0; i < n; i++) out[i] *= env[i];
  if (p.width > 0) {
    const side = work(3, n);
    bandNoise(h, side, n, p.band * bright, p.q, h.noise2);
    for (let i = 0; i < n; i++) h.side[i] += side[i] * env[i] * p.width;
    h.wide = true;
  }
  saturate(out, n, p.drive * byVel(h, 0.6, 1.1));
  h.lowpass = p.lowpass;
  h.grit = p.grit;
  h.room = p.room;
  // softer claps come from cupped hands: slower onset
  if (vel < 0.5) {
    const soft = Math.min(n, Math.round((0.5 - vel) * 0.008 * sr));
    for (let i = 0; i < soft; i++) out[i] *= i / soft;
  }
}

/* ------------------------------------------------------------------ */
/* rim click and wood block                                            */
/* ------------------------------------------------------------------ */

interface Tick {
  len: number;
  modes: readonly Mode[];
  click: number;
  clickHz: number;
  clickT60: number;
  attack: number;
  drive: number;
  lowpass: number;
  grit: number;
  room: number;
  pan: number;
}

const TICK_BASE: Tick = {
  len: 0.08,
  modes: [],
  click: 0,
  clickHz: 3500,
  clickT60: 0.006,
  attack: 0.0002,
  drive: 0,
  lowpass: 0,
  grit: 0,
  room: 0,
  pan: 0,
};
/** The length follows from the longest mode (at full velocity) and the room. */
const tk = (p: Partial<Tick>): Tick => {
  const longest = Math.max(...(p.modes ?? []).map((mode) => mode[2]));
  return {
    ...TICK_BASE,
    ...p,
    len: longest * 1.15 + 0.008 + (p.room ? 0.042 : 0),
  };
};

// prettier-ignore
const RIM: Record<Kit, Tick> = {
  pop: tk({ modes: [[480, 0.6, 0.035], [1120, 1, 0.03], [1890, 0.7, 0.022], [2900, 0.3, 0.015]], click: 0.3, clickHz: 3800, pan: -0.08 }),
  lofi: tk({ modes: [[430, 0.7, 0.028], [980, 1, 0.023], [1650, 0.5, 0.016]], click: 0.15, clickHz: 2200, drive: 1.5, lowpass: 4200, grit: 0.08, pan: -0.08 }),
  // 808 rim shot: two short tones a twelfth-ish apart pushed into clipping
  electro: tk({ modes: [[455, 1, 0.03], [1667, 0.9, 0.014]], click: 0.2, clickHz: 5000, clickT60: 0.003, drive: 1.6, pan: -0.08 }),
  // stick laid across the head: woody, with a touch of shell
  acoustic: tk({ modes: [[380, 0.5, 0.05], [870, 1, 0.04], [1750, 0.8, 0.03], [2500, 0.4, 0.02], [3900, 0.2, 0.012]], click: 0.4, clickHz: 2600, clickT60: 0.008, room: 0.3, pan: -0.08 }),
  brush: tk({ modes: [[420, 0.5, 0.04], [950, 1, 0.035], [1800, 0.5, 0.022]], click: 0.2, clickHz: 2400, attack: 0.0006, room: 0.2, pan: -0.08 }),
  // sticks in a hall: lower and longer
  cinematic: tk({ modes: [[320, 0.6, 0.09], [760, 1, 0.08], [1500, 0.7, 0.05], [2300, 0.3, 0.03]], click: 0.4, clickHz: 2200, clickT60: 0.01, room: 0.25, pan: -0.08 }),
  soft: tk({ modes: [[520, 1, 0.03], [1150, 0.4, 0.02]], attack: 0.001, lowpass: 5000, pan: -0.08 }),
};

// prettier-ignore
const WOODBLOCK: Record<Kit, Tick> = {
  pop: tk({ modes: [[880, 1, 0.07], [2310, 0.35, 0.03], [3650, 0.12, 0.015]], click: 0.15, clickHz: 4000, clickT60: 0.004, pan: 0.2 }),
  lofi: tk({ modes: [[720, 1, 0.055], [1900, 0.3, 0.026]], click: 0.08, clickHz: 2500, drive: 1.4, lowpass: 4500, grit: 0.08, pan: 0.2 }),
  // drum-machine block: two clean tones a fifth apart
  electro: tk({ modes: [[1100, 1, 0.05], [1650, 0.45, 0.035]], click: 0.1, clickHz: 5000, clickT60: 0.003, drive: 0.8, pan: 0.2 }),
  acoustic: tk({ modes: [[760, 1, 0.09], [1980, 0.4, 0.04], [3400, 0.15, 0.02], [4700, 0.06, 0.012]], click: 0.3, clickHz: 3000, clickT60: 0.006, room: 0.3, pan: 0.2 }),
  brush: tk({ modes: [[800, 1, 0.07], [2080, 0.3, 0.03]], click: 0.1, clickHz: 2500, attack: 0.0006, room: 0.2, pan: 0.2 }),
  // temple block: big, hollow, low
  cinematic: tk({ modes: [[420, 1, 0.15], [1090, 0.4, 0.07], [1830, 0.15, 0.04]], click: 0.25, clickHz: 2200, clickT60: 0.008, room: 0.25, pan: 0.2 }),
  soft: tk({ modes: [[660, 1, 0.065], [1730, 0.12, 0.025]], attack: 0.0012, lowpass: 5000, pan: 0.2 }),
};

function tick(h: Hit, p: Tick): void {
  const { sr, n, vel } = h;
  const out = h.mid;
  // harder strokes excite the upper modes and ring a little longer
  ring(out, n, sr, p.modes, 1, 1, byVel(h, 0.8, 1.05), vel - 0.8);
  const attack = p.attack * (1 + 3 * (1 - vel)) + 0.001 * (1 - vel) * (1 - vel);
  const rise = Math.min(n, Math.max(1, Math.round(attack * sr)));
  for (let i = 0; i < rise; i++)
    out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / rise);
  if (p.click > 0) {
    const count = span(p.clickT60, sr, n, 70);
    const click = work(3, count);
    bandNoise(h, click, count, p.clickHz * byVel(h, 0.7, 1.075), 0.7);
    shape(click, count, sr, 0.0002, p.clickT60);
    mix(out, click, count, p.click * (0.2 + 1.25 * vel * vel));
  }
  saturate(out, n, p.drive * byVel(h, 0.6, 1.1));
  h.pan = p.pan;
  h.lowpass = p.lowpass > 0 ? p.lowpass * byVel(h, 0.65, 1.09) : 0;
  h.grit = p.grit;
  h.room = p.room;
}

/* ------------------------------------------------------------------ */
/* finger snap                                                         */
/* ------------------------------------------------------------------ */

interface Snap {
  len: number;
  /** main resonance of the cupped hand and a weaker upper one */
  hz: number;
  q: number;
  hz2: number;
  mix2: number;
  t60: number;
  /** level of the flick that precedes the snap by `gap` seconds */
  pre: number;
  gap: number;
  /** seconds of extra attack per unit of missing velocity */
  soft: number;
  drive: number;
  lowpass: number;
  grit: number;
  room: number;
  width: number;
}

// prettier-ignore
const SNAP: Record<Kit, Snap> = {
  pop: { len: 0.085, hz: 2400, q: 3.2, hz2: 4700, mix2: 0.4, t60: 0.06, pre: 0.14, gap: 0.006, soft: 0.001, drive: 0, lowpass: 0, grit: 0, room: 0, width: 0.15 },
  // the hip-hop layer: lower, duller, a bit crushed
  lofi: { len: 0.09, hz: 1700, q: 2.8, hz2: 3200, mix2: 0.25, t60: 0.065, pre: 0.1, gap: 0.006, soft: 0.001, drive: 1.5, lowpass: 5200, grit: 0.08, room: 0, width: 0.1 },
  electro: { len: 0.07, hz: 2700, q: 4.5, hz2: 5400, mix2: 0.5, t60: 0.045, pre: 0, gap: 0, soft: 0.0005, drive: 0.6, lowpass: 0, grit: 0, room: 0, width: 0.15 },
  acoustic: { len: 0.15, hz: 2300, q: 2.6, hz2: 4400, mix2: 0.45, t60: 0.075, pre: 0.2, gap: 0.007, soft: 0.001, drive: 0, lowpass: 0, grit: 0, room: 0.35, width: 0.2 },
  brush: { len: 0.13, hz: 2200, q: 2.6, hz2: 4200, mix2: 0.35, t60: 0.065, pre: 0.18, gap: 0.007, soft: 0.0015, drive: 0, lowpass: 0, grit: 0, room: 0.25, width: 0.15 },
  cinematic: { len: 0.2, hz: 2000, q: 2.4, hz2: 3900, mix2: 0.4, t60: 0.11, pre: 0.2, gap: 0.008, soft: 0.001, drive: 0, lowpass: 0, grit: 0, room: 0.35, width: 0.35 },
  // fingertips rather than a snap: rounder, shorter, no flick to speak of
  soft: { len: 0.065, hz: 2200, q: 2.2, hz2: 3800, mix2: 0.15, t60: 0.045, pre: 0.05, gap: 0.004, soft: 0.003, drive: 0, lowpass: 5500, grit: 0, room: 0, width: 0.1 },
};

const snapModes: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, 0],
];

function fingerSnap(h: Hit, p: Snap): void {
  const { sr, n, vel } = h;
  const out = h.mid;
  const gap = Math.round(p.gap * sr);
  const decay = p.t60 * byVel(h, 0.8, 1.05);
  const count = span(decay, sr, n, 70);
  const bright = byVel(h, 0.85, 1.04);
  // the snap itself: the cupped hand rings at two pitches (the same for every snap) …
  const body = work(3, count);
  snapModes[0][0] = p.hz * bright;
  snapModes[0][1] = 1;
  snapModes[0][2] = decay * 0.7;
  snapModes[1][0] = p.hz2 * bright;
  snapModes[1][1] = p.mix2 * byVel(h, 0.4, 1.15);
  snapModes[1][2] = decay * 0.4;
  ring(body, count, sr, snapModes, 2);
  // … around a burst of noise in the same two bands (different every time)
  const noise = work(4, count);
  bandNoise(h, noise, count, p.hz * bright, p.q);
  shape(noise, count, sr, 0.0003, decay);
  mix(body, noise, count, 0.4);
  bandNoise(h, noise, count, p.hz2 * bright, p.q);
  shape(noise, count, sr, 0.0003, decay * 0.55);
  mix(body, noise, count, 0.4 * p.mix2 * byVel(h, 0.4, 1.15));
  // softer snaps come off the palm more slowly
  const attack = Math.min(
    count,
    Math.round((0.0002 + p.soft * (1.5 - vel)) * sr),
  );
  for (let i = 0; i < attack; i++)
    body[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
  mixDelayed(out, body, count, 1, gap, n);
  if (p.width > 0) {
    bandNoise(h, noise, count, p.hz2 * bright, p.q, h.noise2);
    shape(noise, count, sr, 0.0003, decay * 0.55);
    mixDelayed(h.side, noise, count, p.width, gap, n);
    h.wide = true;
  }
  if (p.pre > 0 && gap > 0) {
    // skin sliding off skin
    const short = Math.min(n, gap + Math.round(0.002 * sr));
    const flick = work(3, short);
    highNoise(h, flick, short, 3000);
    shape(flick, short, sr, 0.002, 0.012);
    mix(out, flick, short, p.pre);
  }
  saturate(out, n, p.drive);
  h.lowpass = p.lowpass;
  h.grit = p.grit;
  h.room = p.room;
}

/* ------------------------------------------------------------------ */

export type SnareKind =
  "snare" | "brushSnare" | "clap" | "rim" | "woodblock" | "fingerSnap";

export const SNARES: Engine<SnareKind> = {
  length(kind, kit) {
    switch (kind) {
      case "snare":
        return SNARE[kit].len;
      case "brushSnare":
        return BRUSH[kit].len;
      case "clap":
        return CLAP[kit].len;
      case "rim":
        return RIM[kit].len;
      case "woodblock":
        return WOODBLOCK[kit].len;
      case "fingerSnap":
        return SNAP[kit].len;
    }
  },
  render(h, kind, kit) {
    switch (kind) {
      case "snare":
        return snare(h, SNARE[kit]);
      case "brushSnare":
        return brush(h, BRUSH[kit]);
      case "clap":
        return clap(h, CLAP[kit]);
      case "rim":
        return tick(h, RIM[kit]);
      case "woodblock":
        return tick(h, WOODBLOCK[kit]);
      case "fingerSnap":
        return fingerSnap(h, SNAP[kit]);
    }
  },
};
