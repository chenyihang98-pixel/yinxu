/**
 * Organ: a soft drawbar (tonewheel) organ through a slowly turning rotary
 * speaker.
 */
import type { Voice } from "../types";
import {
  LEVEL_WINDOW,
  LN_60DB,
  REFERENCE_RMS,
  SINE_TABLE,
  SINE_TABLE_SIZE,
  clamp,
  clamp01,
  midiToHz,
  noteOffFrame,
  scratch,
  velocityGain,
} from "../../dsp";
import { expMean, mixNote, velocityCeiling } from "../../dsp/extra-keys";

/**
 * Additive, the way the instrument works: one sine per drawbar footage.
 *  - Registration: a mellow jazz / ballad setting, 8' strongest with a soft
 *    16' underneath and 4', 2 2/3', 2' above. An organ has no touch, so
 *    velocity acts as the swell pedal and the upper drawbars: harder notes
 *    are louder AND pull the upper footages out further;
 *  - tonewheel foldback: footages above 5.6 kHz drop an octave (no wheel
 *    exists up there), which also keeps the top octave free of aliasing;
 *  - percussion: the 4' harmonic pings and decays in a third of a second,
 *    stronger with velocity, so comping has a defined front edge;
 *  - rotary speaker at "chorale" speed: the horn (everything above 800 Hz)
 *    turns at 0.86 Hz and the bass rotor at 0.72 Hz. Each channel is a
 *    microphone a quarter turn apart: the level swells as the horn passes
 *    (horn ±1.7 dB, rotor ±0.5 dB) and the pitch of the horn rises and
 *    falls (Doppler). The Doppler swing is a tenth of a cycle of phase per
 *    partial (about a cent at 800 Hz, less above): enough to move, small
 *    enough to keep the two channels correlated (mono-compatible) in the top
 *    octaves. The mean pitch is exact;
 *  - a 6 ms raised-cosine attack and a 35 ms release: fast, never a click.
 * NoteEvent.bend is ignored: tonewheels cannot bend.
 */
const FOOTAGES: readonly [
  /** multiple of half the note frequency (16' = 1, 8' = 2 …) */
  multiple: number,
  level: number,
  /** how strongly velocity pulls this drawbar out */
  open: number,
][] = [
  [1, 0.3, 0],
  [2, 1, 0],
  [3, 0.14, 0.6],
  [4, 0.46, 0.7],
  [6, 0.24, 1.1],
  [8, 0.17, 1.4],
  [12, 0.06, 2.2],
  [16, 0.045, 2.2],
];
const PARTIALS = FOOTAGES.length;
const FOLDBACK_HZ = 5600;
const HORN_HZ = 800;
const HORN_RATE = 0.86;
const ROTOR_RATE = 0.72;
const HORN_DEPTH = 0.2;
const ROTOR_DEPTH = 0.06;
/** phase swing the Doppler of the horn gives each partial, in cycles */
const DOPPLER_SWING = 0.1;
/** the loudest 400 ms sit on a crest of the rotor: this much above the mean */
const ROTOR_CREST = 1.05;
const PERCUSSION_T60 = 0.36;
const ATTACK = 0.006;
const RELEASE = 0.035;
const CONTROL = 16;

const partialInc = new Float64Array(PARTIALS);
const partialAmp = new Float64Array(PARTIALS);
const partialHorn = new Uint8Array(PARTIALS);
/** Doppler depth of each partial as a frequency ratio */
const partialDoppler = new Float64Array(PARTIALS);
const incLeft = new Float64Array(PARTIALS);
const incRight = new Float64Array(PARTIALS);
const phaseLeft = new Float64Array(PARTIALS);
const phaseRight = new Float64Array(PARTIALS);

export const organ: Voice = {
  id: "organ",
  tail: () => RELEASE + 0.01,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 16, sr * 0.2);
    const pull = 0.3 + 0.9 * vel;

    // --- drawbars ---
    let count = 0;
    let power = 0;
    let percussionSlot = -1;
    for (let k = 0; k < PARTIALS; k++) {
      const [multiple, level, open] = FOOTAGES[k];
      let hz = 0.5 * f0 * multiple;
      while (hz > FOLDBACK_HZ) hz *= 0.5;
      let amp = level * Math.pow(pull, open);
      // the 16' wheel fades out where it would only be rumble
      if (multiple === 1) amp *= clamp01((hz - 28) / 30);
      if (amp < 1e-4) continue;
      // foldback can land two footages on one wheel: let them share it
      let slot = count;
      for (let j = 0; j < count; j++)
        if (Math.abs(partialInc[j] * sr - hz) < 0.01) slot = j;
      if (slot === count) {
        partialInc[slot] = hz / sr;
        partialAmp[slot] = 0;
        partialHorn[slot] = hz >= HORN_HZ ? 1 : 0;
        partialDoppler[slot] = (DOPPLER_SWING * 2 * Math.PI * HORN_RATE) / hz;
        phaseLeft[slot] = 0;
        phaseRight[slot] = 0;
        count++;
      }
      partialAmp[slot] += amp;
      if (multiple === 4) percussionSlot = slot;
    }
    const percussion = percussionSlot < 0 ? 0 : 0.55 * Math.pow(vel, 1.5);
    const percussionRate = LN_60DB / PERCUSSION_T60;
    for (let k = 0; k < count; k++) {
      const depth = partialHorn[k] ? HORN_DEPTH : ROTOR_DEPTH;
      const a = partialAmp[k];
      let square = a * a;
      if (k === percussionSlot)
        square +=
          2 * a * percussion * expMean(percussionRate, LEVEL_WINDOW) +
          percussion * percussion * expMean(2 * percussionRate, LEVEL_WINDOW);
      power += 0.5 * square * (1 + 0.5 * depth * depth);
    }
    const gain =
      (REFERENCE_RMS * velocityGain(vel)) /
      (ROTOR_CREST * Math.sqrt(Math.max(power, 1e-9)));

    // --- render ---
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    const hold = noteOffFrame(note, frames, sr, RELEASE * 0.8);
    const releaseFrames = Math.max(1, frames - hold);
    const percussionCoef = Math.exp(-percussionRate / sr);
    let ping = percussion;
    let hornL = 1;
    let hornR = 1;
    let rotorL = 1;
    let rotorR = 1;
    const table = SINE_TABLE;
    const size = SINE_TABLE_SIZE;
    for (let i = 0; i < frames; i++) {
      if ((i & (CONTROL - 1)) === 0) {
        const t = i / sr;
        const horn = 2 * Math.PI * HORN_RATE * t;
        const rotor = 2 * Math.PI * ROTOR_RATE * t;
        // microphones a quarter turn apart; Doppler follows the rate of
        // change of the distance, a quarter turn ahead of the level
        hornL = 1 + HORN_DEPTH * Math.sin(horn);
        hornR = 1 + HORN_DEPTH * Math.cos(horn);
        const towardsL = Math.cos(horn);
        const towardsR = -Math.sin(horn);
        for (let k = 0; k < count; k++) {
          incLeft[k] = partialInc[k] * (1 + partialDoppler[k] * towardsL);
          incRight[k] = partialInc[k] * (1 + partialDoppler[k] * towardsR);
        }
        rotorL = 1 + ROTOR_DEPTH * Math.sin(rotor);
        rotorR = 1 + ROTOR_DEPTH * Math.cos(rotor);
      }
      let sl = 0;
      let sr2 = 0;
      for (let k = 0; k < count; k++) {
        const a = k === percussionSlot ? partialAmp[k] + ping : partialAmp[k];
        let p = phaseLeft[k];
        let position = p * size;
        let index = position | 0;
        let s = table[index];
        s += (table[index + 1] - s) * (position - index);
        if (partialHorn[k]) {
          sl += a * hornL * s;
          p += incLeft[k];
          if (p >= 1) p -= 1;
          phaseLeft[k] = p;
          p = phaseRight[k];
          position = p * size;
          index = position | 0;
          s = table[index];
          s += (table[index + 1] - s) * (position - index);
          sr2 += a * hornR * s;
          p += incRight[k];
          if (p >= 1) p -= 1;
          phaseRight[k] = p;
        } else {
          sl += a * rotorL * s;
          sr2 += a * rotorR * s;
          p += partialInc[k];
          if (p >= 1) p -= 1;
          phaseLeft[k] = p;
        }
      }
      ping *= percussionCoef;
      if (i >= hold) {
        // raised-cosine release that reaches zero on the last frame
        const g =
          0.5 + 0.5 * Math.cos((Math.PI * (i - hold + 1)) / releaseFrames);
        sl *= g;
        sr2 *= g;
      }
      l[i] = sl;
      r[i] = sr2;
    }
    mixNote(
      left,
      right,
      l,
      r,
      frames,
      gain,
      ATTACK * sr,
      1,
      velocityCeiling(vel),
    );
  },
};
