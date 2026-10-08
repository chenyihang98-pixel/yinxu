/**
 * choir — soft wordless "aah".
 *
 * Six singers spread across the stereo field (neighbours in pitch on
 * opposite sides): band-limited saws with their own drift and vibrato, plus a
 * whisper of aspiration noise, tilted by a one-pole low-pass into a glottal
 * source (-12 dB/octave; the corner rises with velocity, as a voice gets
 * brighter when it sings out). The vowel is a chain of formant resonances
 * near 700 / 1100 / 2600 Hz ("ah"). Vibrato sweeps the harmonics across the
 * formants, which is what makes a sung vowel shimmer. Slow attack
 * (320 .. 140 ms), 450 ms release. The level is predicted from the harmonics
 * through tilt and formants.
 */
import type { Voice } from "../types";
import {
  Adsr,
  BEND_TIME,
  Biquad,
  biquadChain,
  OnePoleLP,
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
  velocityGain,
} from "../../dsp";
import {
  CENT,
  ResponseTable,
  SEMITONE,
  SawBank,
  guardGain,
  onset,
  seedPhases,
} from "../../dsp/extra-sustained";

const SINGERS = 6;
/** cents */
const DETUNE = [-10, -5.8, -2.5, 2.1, 5.8, 9.6];
/** neighbours in pitch stand on opposite sides */
const PAN = [-0.55, 0.4, -0.2, 0.2, -0.4, 0.55];
/** start phases for exactly these DETUNE / PAN tables (see seedPhases) */
const PHASES = [0, 0.347, 0.146, 0.024, 0.598, 0.919];
const RELEASE = 0.45;
const CONTROL = 16;
const MAX_INC = 0.24;
const MAX_HARMONICS = 400;
/** allpasses (Hz, q) that smear each glottal pulse; the same on both channels */
const SMEAR: readonly [hz: number, q: number][] = [
  [180, 0.8],
  [480, 1],
  [1500, 1],
];
/** aspiration noise relative to one saw (amplitude) */
const BREATH = 0.07;

interface Rig {
  bank: SawBank;
  tiltLeft: OnePoleLP;
  tiltRight: OnePoleLP;
  vowelLeft: Biquad[];
  vowelRight: Biquad[];
  tableLeft: ResponseTable;
  tableRight: ResponseTable;
}

const rigs = new Map<number, Rig>();

/**
 * "ah": three formants, a weak fourth, and a soft roof over the top. The
 * first two (which carry the energy) are the same on both channels: around a
 * resonance the phase turns quickly, and two different ones would pull the
 * channels apart on the notes that sit between them. The formants are those
 * of many throats at once, so they are broader than a single singer's.
 */
function vowel(sr: number, f3: number): Biquad[] {
  return [
    new Biquad().setHighpass(70, 0.7, sr),
    new Biquad().setPeak(700, 3.5, 12, sr),
    new Biquad().setPeak(1100, 5, 9, sr),
    new Biquad().setPeak(f3, 6, 11, sr),
    new Biquad().setPeak(f3 * 1.3, 6, 5, sr),
    new Biquad().setLowpass(5200, 0.7, sr),
    ...SMEAR.map(([hz, q]) => new Biquad().setAllpass(hz, q, sr)),
  ];
}

function rigFor(sr: number): Rig {
  let rig = rigs.get(sr);
  if (rig) return rig;
  const vowelLeft = vowel(sr, 2550);
  const vowelRight = vowel(sr, 2720);
  rig = {
    bank: new SawBank(SINGERS),
    tiltLeft: new OnePoleLP(),
    tiltRight: new OnePoleLP(),
    vowelLeft,
    vowelRight,
    tableLeft: new ResponseTable(vowelLeft, sr),
    tableRight: new ResponseTable(vowelRight, sr),
  };
  rigs.set(sr, rig);
  return rig;
}

const baseInc = new Float64Array(SINGERS);
const vibPhase = new Float64Array(SINGERS);
const vibRate = new Float64Array(SINGERS);
const vibDepth = new Float64Array(SINGERS);
const driftPhase = new Float64Array(SINGERS);
const driftRate = new Float64Array(SINGERS);

export const choir: Voice = {
  id: "choir",
  tail: () => RELEASE + 0.03,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const rig = rigFor(sr);
    const bank = rig.bank;
    const random = forkRng(ctx.random);
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 12, sr * 0.2);

    // --- singers ---
    let powerLeft = 0;
    let powerRight = 0;
    seedPhases(bank.phase, PHASES, random);
    for (let s = 0; s < SINGERS; s++) {
      baseInc[s] = (f0 * Math.exp(DETUNE[s] * CENT)) / sr;
      bank.left[s] = panLeft(PAN[s]);
      bank.right[s] = panRight(PAN[s]);
      powerLeft += bank.left[s] * bank.left[s];
      powerRight += bank.right[s] * bank.right[s];
      vibPhase[s] = random();
      vibRate[s] = (4.9 + 1.1 * random()) / sr;
      vibDepth[s] = (6 + 5 * random()) * CENT;
      driftPhase[s] = random();
      driftRate[s] = (0.25 + 0.5 * random()) / sr;
    }

    // --- glottal tilt: brighter when sung louder ---
    const tilt = clamp(520 + 2300 * Math.pow(vel, 1.3), 200, sr * 0.3);
    rig.tiltLeft.setCutoff(tilt, sr);
    rig.tiltRight.setCutoff(tilt, sr);
    rig.tiltLeft.reset();
    rig.tiltRight.reset();

    // --- level: saw harmonics through the tilt and each vowel ---
    let spectrumLeft = 0;
    let spectrumRight = 0;
    const top = Math.min(sr * 0.48, 9000);
    for (let k = 1; k <= MAX_HARMONICS && k * f0 < top; k++) {
      const hz = k * f0;
      const a = (2 / (Math.PI * k)) * rig.tiltLeft.magnitude(hz, sr);
      const p = 0.5 * a * a;
      const gl = rig.tableLeft.gain(hz);
      const gr = rig.tableRight.gain(hz);
      spectrumLeft += p * gl * gl;
      spectrumRight += p * gr * gr;
    }
    const power =
      0.5 * (spectrumLeft * powerLeft + spectrumRight * powerRight);
    // the loudest 400 ms of six beating voices sit a little above their mean
    const gain = (REFERENCE_RMS * velocityGain(vel) * 0.91) / Math.sqrt(power);

    // --- envelope ---
    const env = scratch(2, frames);
    new Adsr(sr, {
      attack: 0.32 - 0.18 * vel,
      decay: 0.1,
      sustain: 1,
      release: RELEASE,
      attackShape: "cos",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.01));

    // --- source: breath, then the singers on top ---
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    new WhiteNoise(random).fill(l, frames, BREATH * 1.7);
    new WhiteNoise(random).fill(r, frames, BREATH * 1.7);
    const vibrato = 0.6 + 0.4 * vel;
    for (let from = 0; from < frames; from += CONTROL) {
      const to = Math.min(frames, from + CONTROL);
      const t = from / sr;
      const bend =
        note.bend && t < BEND_TIME
          ? Math.exp(bendOffset(note.bend, t) * SEMITONE)
          : 1;
      const depth = vibrato * onset(t, 0.3, 0.6);
      for (let s = 0; s < SINGERS; s++) {
        const inc =
          baseInc[s] *
          bend *
          (1 +
            2 * CENT * sinTurns(driftPhase[s] + driftRate[s] * from) +
            depth * vibDepth[s] * sinTurns(vibPhase[s] + vibRate[s] * from));
        bank.inc[s] = inc < MAX_INC ? inc : MAX_INC;
      }
      bank.render(l, r, from, to);
    }

    // --- tilt, vowel, envelope, out ---
    rig.tiltLeft.process(l, frames);
    rig.tiltRight.process(r, frames);
    biquadChain(rig.vowelLeft, l, frames);
    biquadChain(rig.vowelRight, r, frames);
    const out = guardGain(l, r, frames, gain);
    for (let i = 0; i < frames; i++) {
      const a = env[i] * out;
      left[i] += l[i] * a;
      right[i] += r[i] * a;
    }
  },
};
