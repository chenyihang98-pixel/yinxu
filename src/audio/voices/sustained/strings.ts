/**
 * strings — ensemble string section.
 *
 * Six "players": detuned band-limited saws, each with its own vibrato rate
 * and phase (plus a small shared one) that fades in after the bow has
 * settled, spread across the stereo field. A little bow noise rides along.
 * The sum passes a 12 dB/octave low-pass that opens with velocity and with
 * the bow envelope, then a fixed body EQ (air and wood resonances near
 * 300 / 500 Hz, the "bridge hill" around 2.6 kHz) whose peaks sit at slightly
 * different frequencies left and right. Because the body does not move with
 * the note, every pitch gets its own harmonic balance, as on an instrument.
 * The bow attack lasts 120 ms (soft) .. 60 ms (hard); NoteEvent.bend is a
 * short scoop into the note. The level is predicted from the saw harmonics
 * through the filter and the body response.
 */
import type { Voice } from "../types";
import {
  Adsr,
  BEND_TIME,
  Biquad,
  biquadChain,
  REFERENCE_RMS,
  WhiteNoise,
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
  guardGain,
  onset,
  seedPhases,
} from "../../dsp/extra-sustained";

const PLAYERS = 6;
/** detune of each player as a share of SPREAD */
const DETUNE = [-1, -0.56, -0.19, 0.22, 0.6, 1];
const PAN = [-0.8, 0.55, -0.3, 0.3, -0.55, 0.8];
const LEVEL = [0.85, 1, 1, 1, 1, 0.85];
/** start phases for exactly these DETUNE / PAN / LEVEL tables (see seedPhases) */
const PHASES = [0, 0.301, 0.307, 0.089, 0.754, 0.137];
/** cents of the outermost players */
const SPREAD = 9;
const FILTER_Q = 0.75;
const RELEASE = 0.24;
const CONTROL = 16;
const MAX_INC = 0.24;
const MAX_HARMONICS = 400;
/** allpasses (Hz, q) of the body's phase response */
const SMEAR: readonly [hz: number, q: number][] = [
  [210, 0.8],
  [640, 1],
  [1900, 1],
];
/** bow noise relative to one saw (amplitude) */
const BOW_NOISE = 0.05;

interface Rig {
  bank: SawBank;
  lowLeft: SvfRange;
  lowRight: SvfRange;
  bodyLeft: Biquad[];
  bodyRight: Biquad[];
  tableLeft: ResponseTable;
  tableRight: ResponseTable;
}

const rigs = new Map<number, Rig>();

function body(sr: number, air: number, wood: number, hill: number): Biquad[] {
  return [
    new Biquad().setHighpass(45, 0.7, sr),
    new Biquad().setPeak(air, 3, 3, sr),
    new Biquad().setPeak(wood, 3.5, 3.5, sr),
    new Biquad().setPeak(1350, 1.2, -2.5, sr),
    new Biquad().setPeak(hill, 1.3, 3.5, sr),
    // a violin body radiates better the higher the partial, up to the bridge hill
    new Biquad().setHighShelf(1000, 4.5, sr, 0.5),
    // ... and smears each cycle in time (the same on both channels)
    ...SMEAR.map(([hz, q]) => new Biquad().setAllpass(hz, q, sr)),
  ];
}

function rigFor(sr: number): Rig {
  let rig = rigs.get(sr);
  if (rig) return rig;
  const bodyLeft = body(sr, 285, 470, 2500);
  const bodyRight = body(sr, 310, 540, 2850);
  rig = {
    bank: new SawBank(PLAYERS),
    lowLeft: new SvfRange(),
    lowRight: new SvfRange(),
    bodyLeft,
    bodyRight,
    tableLeft: new ResponseTable(bodyLeft, sr),
    tableRight: new ResponseTable(bodyRight, sr),
  };
  rigs.set(sr, rig);
  return rig;
}

const baseInc = new Float64Array(PLAYERS);
const vibPhase = new Float64Array(PLAYERS);
const vibRate = new Float64Array(PLAYERS);
const vibDepth = new Float64Array(PLAYERS);

export const strings: Voice = {
  id: "strings",
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
      baseInc[s] = (f0 * Math.exp(DETUNE[s] * SPREAD * CENT)) / sr;
      bank.left[s] = LEVEL[s] * panLeft(PAN[s]);
      bank.right[s] = LEVEL[s] * panRight(PAN[s]);
      powerLeft += bank.left[s] * bank.left[s];
      powerRight += bank.right[s] * bank.right[s];
      vibPhase[s] = random();
      vibRate[s] = (5.2 + 1.1 * random()) / sr;
      vibDepth[s] = (8 + 6 * random()) * CENT;
    }
    const sharedPhase = random();
    const sharedRate = (5.5 + 0.4 * random()) / sr;
    const sharedDepth = 4 * CENT;
    // soft notes get less vibrato, like a section playing piano
    const vibrato = 0.55 + 0.45 * vel;

    // --- filter: opens with velocity, follows the keyboard a little ---
    const cutoff = clamp(
      3000 * Math.pow(f0 / 440, 0.35) * (0.4 + 1.1 * Math.pow(vel, 1.2)),
      f0 * 1.5,
      sr * 0.42,
    );

    // --- level: saw harmonics through the low-pass and each channel's body ---
    let spectrumLeft = 0;
    let spectrumRight = 0;
    const top = Math.min(sr * 0.48, cutoff * 12);
    for (let k = 1; k <= MAX_HARMONICS && k * f0 < top; k++) {
      const hz = k * f0;
      const a = (2 / (Math.PI * k)) * svfLowpassGain(hz, cutoff, FILTER_Q, sr);
      const p = 0.5 * a * a;
      const gl = rig.tableLeft.gain(hz);
      const gr = rig.tableRight.gain(hz);
      spectrumLeft += p * gl * gl;
      spectrumRight += p * gr * gr;
    }
    const power =
      0.5 * (spectrumLeft * powerLeft + spectrumRight * powerRight);
    // the loudest 400 ms of a beating unison sit a little above its mean power
    const gain = (REFERENCE_RMS * velocityGain(vel) * 0.89) / Math.sqrt(power);

    // --- bow envelope ---
    const env = scratch(2, frames);
    new Adsr(sr, {
      attack: 0.12 - 0.06 * vel,
      decay: 0.1,
      sustain: 1,
      release: RELEASE,
      attackShape: "cos",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.01));

    // --- source: bow noise, then the saws on top, low-passed block by block ---
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    new WhiteNoise(random).fill(l, frames, BOW_NOISE * 1.7);
    new WhiteNoise(random).fill(r, frames, BOW_NOISE * 1.7);
    rig.lowLeft.reset();
    rig.lowRight.reset();
    for (let from = 0; from < frames; from += CONTROL) {
      const to = Math.min(frames, from + CONTROL);
      const t = from / sr;
      const bend =
        note.bend && t < BEND_TIME
          ? Math.exp(bendOffset(note.bend, t) * SEMITONE)
          : 1;
      const depth = vibrato * onset(t, 0.16, 0.45);
      const shared =
        depth * sharedDepth * sinTurns(sharedPhase + sharedRate * from);
      for (let s = 0; s < PLAYERS; s++) {
        const inc =
          baseInc[s] *
          bend *
          (1 +
            shared +
            depth * vibDepth[s] * sinTurns(vibPhase[s] + vibRate[s] * from));
        bank.inc[s] = inc < MAX_INC ? inc : MAX_INC;
      }
      bank.render(l, r, from, to);
      rig.lowLeft.set(cutoff * (0.5 + 0.5 * env[from]), FILTER_Q, sr);
      rig.lowRight.copy(rig.lowLeft);
      rig.lowLeft.low(l, from, to);
      rig.lowRight.low(r, from, to);
    }

    // --- body, envelope, out ---
    biquadChain(rig.bodyLeft, l, frames);
    biquadChain(rig.bodyRight, r, frames);
    const out = guardGain(l, r, frames, gain);
    for (let i = 0; i < frames; i++) {
      const a = env[i] * out;
      left[i] += l[i] * a;
      right[i] += r[i] * a;
    }
  },
};
