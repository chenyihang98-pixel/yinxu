/**
 * brass — section brass for stabs and swells.
 *
 * Four players (band-limited saws a few cents apart, each scooping into the
 * note from 25–80 cents below within about 55 ms) through a 24 dB/octave
 * low-pass whose cutoff does what a brass bell does: it starts closed,
 * overshoots as the lips lock in ("bwah") and settles, and its whole range
 * rises steeply with velocity — soft notes are round, hard ones blare.
 * A first-order tilt whose corner follows the note turns the saw spectrum
 * into the flatter, pulse-like one of a brass instrument (harmonics 2–5
 * almost as strong as the fundamental). A fixed EQ adds body near 500 Hz and
 * presence near 1.2 kHz and takes the top off above 5.5 kHz, so fortissimo
 * stays brassy instead of harsh; a few allpasses spread each cycle in time
 * the way a bell and a room would. Attack is 85 ms (soft swell) .. 22 ms
 * (stab). The level is predicted from the saw harmonics through the settled
 * filter, the tilt and the EQ.
 */
import type { Voice } from "../types";
import {
  Adsr,
  BEND_TIME,
  Biquad,
  biquadChain,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  forkRng,
  midiToHz,
  noteOffFrame,
  panLeft,
  panRight,
  scratch,
  sinTurns,
  svfLowpassGain,
  velocityGain,
} from "../../dsp";
import {
  CENT,
  ResponseTable,
  SEMITONE,
  SawBank,
  SvfRange,
  TiltShelf,
  guardGain,
  onset,
  seedPhases,
} from "../../dsp/extra-sustained";

const PLAYERS = 4;
const DETUNE = [-5, -1.5, 2, 5.5];
const PAN = [-0.55, 0.25, -0.2, 0.6];
/** start phases for exactly these DETUNE / PAN tables (see seedPhases) */
const PHASES = [0, 0.593, 0.533, 0.771];
const Q1 = 0.6;
const Q2 = 1.05;
const RELEASE = 0.12;
const CONTROL = 16;
const MAX_INC = 0.24;
const MAX_HARMONICS = 400;
/** seconds the cutoff overshoot takes to settle (time constant) */
const SETTLE = 0.11;
/** linear gain of the tilt far above its corner */
const TILT = 3.4;
/** amplitude sustain level: a stab keeps a little of its bite, then sits */
const SUSTAIN = 0.9;
/** allpasses (Hz, q) that smear each cycle; the same on both channels */
const SMEAR: readonly [hz: number, q: number][] = [
  [240, 0.8],
  [700, 1],
  [1700, 1],
];

interface Rig {
  bank: SawBank;
  left1: SvfRange;
  left2: SvfRange;
  right1: SvfRange;
  right2: SvfRange;
  tiltLeft: TiltShelf;
  tiltRight: TiltShelf;
  eqLeft: Biquad[];
  eqRight: Biquad[];
  tableLeft: ResponseTable;
  tableRight: ResponseTable;
}

const rigs = new Map<number, Rig>();

function eq(sr: number, presence: number): Biquad[] {
  return [
    new Biquad().setHighpass(55, 0.7, sr),
    new Biquad().setPeak(500, 1.2, 2, sr),
    new Biquad().setPeak(presence, 0.9, 4, sr),
    new Biquad().setHighShelf(5500, -5, sr),
    ...SMEAR.map(([hz, q]) => new Biquad().setAllpass(hz, q, sr)),
  ];
}

function rigFor(sr: number): Rig {
  let rig = rigs.get(sr);
  if (rig) return rig;
  const eqLeft = eq(sr, 1150);
  const eqRight = eq(sr, 1300);
  rig = {
    bank: new SawBank(PLAYERS),
    left1: new SvfRange(),
    left2: new SvfRange(),
    right1: new SvfRange(),
    right2: new SvfRange(),
    tiltLeft: new TiltShelf(),
    tiltRight: new TiltShelf(),
    eqLeft,
    eqRight,
    tableLeft: new ResponseTable(eqLeft, sr),
    tableRight: new ResponseTable(eqRight, sr),
  };
  rigs.set(sr, rig);
  return rig;
}

const baseInc = new Float64Array(PLAYERS);
const scoop = new Float64Array(PLAYERS);
const scoopTime = new Float64Array(PLAYERS);
const vibPhase = new Float64Array(PLAYERS);

export const brass: Voice = {
  id: "brass",
  tail: () => RELEASE + 0.02,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const rig = rigFor(sr);
    const bank = rig.bank;
    const random = forkRng(ctx.random);
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 12, sr * 0.2);

    // --- players ---
    let powerLeft = 0;
    let powerRight = 0;
    seedPhases(bank.phase, PHASES, random);
    for (let s = 0; s < PLAYERS; s++) {
      baseInc[s] = (f0 * Math.exp(DETUNE[s] * CENT)) / sr;
      bank.left[s] = panLeft(PAN[s]);
      bank.right[s] = panRight(PAN[s]);
      powerLeft += bank.left[s] * bank.left[s];
      powerRight += bank.right[s] * bank.right[s];
      // semitones below the note at the very start, and how long the lip takes
      scoop[s] = -(0.5 + 0.3 * random()) * (0.5 + 0.5 * vel);
      scoopTime[s] = 0.045 + 0.02 * random();
      vibPhase[s] = random();
    }
    const vibRate = (5 + 0.5 * random()) / sr;

    // --- filter: settled cutoff rises steeply with velocity; low brass is darker ---
    const settled = clamp(
      (300 + 3000 * Math.pow(vel, 1.4)) * Math.pow(f0 / 262, 0.55),
      f0 * 1.3,
      sr * 0.36,
    );
    const overshoot = 0.2 + 0.45 * vel;
    const attack = 0.085 - 0.063 * vel;
    const opening = attack * 1.25;
    const tiltHz = clamp(2.2 * f0, 200, 1100);
    rig.tiltLeft.set(tiltHz, TILT, sr);
    rig.tiltRight.set(tiltHz, TILT, sr);
    rig.tiltLeft.reset();
    rig.tiltRight.reset();

    // --- level: saw harmonics through the settled filter, the tilt and each EQ ---
    // (the loudest 400 ms still hold some overshoot: evaluate a little above)
    const measured = Math.min(sr * 0.4, settled * (1 + 0.22 * overshoot));
    let spectrumLeft = 0;
    let spectrumRight = 0;
    const top = Math.min(sr * 0.48, measured * 8);
    for (let k = 1; k <= MAX_HARMONICS && k * f0 < top; k++) {
      const hz = k * f0;
      const a =
        (2 / (Math.PI * k)) *
        svfLowpassGain(hz, measured, Q1, sr) *
        svfLowpassGain(hz, measured, Q2, sr) *
        rig.tiltLeft.magnitude(hz, sr);
      const p = 0.5 * a * a;
      const gl = rig.tableLeft.gain(hz);
      const gr = rig.tableRight.gain(hz);
      spectrumLeft += p * gl * gl;
      spectrumRight += p * gr * gr;
    }
    const power = 0.5 * (spectrumLeft * powerLeft + spectrumRight * powerRight);
    const gain = (REFERENCE_RMS * velocityGain(vel) * 1.03) / Math.sqrt(power);

    // --- amplitude envelope ---
    const env = scratch(2, frames);
    const hold = noteOffFrame(note, frames, sr, 0.008);
    new Adsr(sr, {
      attack,
      decay: 0.9,
      sustain: SUSTAIN,
      release: RELEASE,
      attackShape: "exp",
    }).render(env, frames, hold);

    // --- source and filter, block by block ---
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    rig.left1.reset();
    rig.left2.reset();
    rig.right1.reset();
    rig.right2.reset();
    const maxCutoff = sr * 0.42;
    for (let from = 0; from < frames; from += CONTROL) {
      const to = Math.min(frames, from + CONTROL);
      const t = from / sr;
      const bend = note.bend && t < BEND_TIME ? bendOffset(note.bend, t) : 0;
      const depth = onset(t, 0.45, 0.5);
      for (let s = 0; s < PLAYERS; s++) {
        const x = t / scoopTime[s];
        const lip = x < 1 ? scoop[s] * (1 - x) * (1 - x) : 0;
        const semis = bend + lip;
        const inc =
          baseInc[s] *
          (semis !== 0 ? Math.exp(semis * SEMITONE) : 1) *
          (1 + depth * 5 * CENT * sinTurns(vibPhase[s] + vibRate * from));
        bank.inc[s] = inc < MAX_INC ? inc : MAX_INC;
      }
      bank.render(l, r, from, to);
      // cutoff: half closed -> overshoot while the amplitude rises -> settle,
      // and it closes again with the release. (It must not start fully
      // closed: the phase of a low-pass that opens across the fundamental
      // advances by a large part of a cycle, which the ear takes for a note
      // that starts sharp and would swallow the lip scoop.)
      const rise = t < opening ? t / opening : 1;
      const bite = t < opening ? rise : Math.exp(-(t - opening) / SETTLE);
      const shape = (0.45 + 0.55 * rise * (2 - rise)) * (1 + overshoot * bite);
      const follow =
        from < hold
          ? 1
          : 0.45 + (0.55 * Math.min(env[from], SUSTAIN)) / SUSTAIN;
      const hz = Math.min(maxCutoff, settled * shape * follow);
      rig.left1.set(hz, Q1, sr);
      rig.left2.set(hz, Q2, sr);
      rig.right1.copy(rig.left1);
      rig.right2.copy(rig.left2);
      rig.left1.low(l, from, to);
      rig.left2.low(l, from, to);
      rig.right1.low(r, from, to);
      rig.right2.low(r, from, to);
    }

    // --- tilt, EQ, envelope, out ---
    rig.tiltLeft.process(l, frames);
    rig.tiltRight.process(r, frames);
    biquadChain(rig.eqLeft, l, frames);
    biquadChain(rig.eqRight, r, frames);
    const out = guardGain(l, r, frames, gain);
    for (let i = 0; i < frames; i++) {
      const a = env[i] * out;
      left[i] += l[i] * a;
      right[i] += r[i] * a;
    }
  },
};
