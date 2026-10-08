/**
 * Pluck: the modern electronic pluck of dance and pop ostinatos.
 */
import type { Voice } from "../types";
import {
  BEND_TIME,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  midiToHz,
  noteOffFrame,
  panLeft,
  panRight,
  pulseBlep,
  sawBlep,
  scratch,
  velocityGain,
} from "../../dsp";
import type { Random } from "../../dsp";
import { LevelTable, mixNote, velocityCeiling } from "../../dsp/extra-keys";

/**
 * Subtractive synth pluck:
 *  - two band-limited saws 10 cents apart, one a little left and one a
 *    little right, over a centred square for a hollow body;
 *  - a 24 dB/octave low-pass (two zero-delay SVFs per channel, a little
 *    resonance) whose cutoff starts wide open (higher with velocity) and
 *    snaps down to a little above the note (time constant 80 ms): the
 *    "pluck";
 *  - amplitude falls to a quiet sustain in a few hundred milliseconds and
 *    stops within 70 ms of note-off, so fast patterns stay tight;
 *  - the oscillators restart on every note for a defined front edge; only
 *    the second saw begins at a slightly different point each time (from
 *    the part's random stream) so repeated notes are not carbon copies.
 * NoteEvent.bend glides the oscillators into the note. The level is
 * measured once per pitch / velocity region (LevelTable).
 */
const DETUNE_CENTS = 5;
const SAW_PAN = 0.45;
const SQUARE_LEVEL = 0.45;
const Q1 = 0.6;
const CONTROL = 8;
const SUSTAIN = 0.2;
const AMP_TAU = 0.2;
const FILTER_TAU = 0.08;
const RELEASE_T60 = 0.07;
const TAIL = 0.075;

function pluckCore(
  l: Float32Array,
  r: Float32Array,
  frames: number,
  hold: number,
  midi: number,
  velocity: number,
  bend: number | undefined,
  sr: number,
  random: Random,
): void {
  const vel = clamp(velocity, 0.02, 1);
  const f0 = clamp(midiToHz(midi), 16, sr * 0.2);
  const incA = (f0 * Math.pow(2, -DETUNE_CENTS / 1200)) / sr;
  const incB = (f0 * Math.pow(2, DETUNE_CENTS / 1200)) / sr;
  const incS = f0 / sr;
  // both saws start on their zero crossing; the square starts on a flat part
  let phaseA = 0.5;
  let phaseB = 0.5 + 0.06 * (random() - 0.5);
  let phaseS = 0.25;
  const sawNear = panRight(SAW_PAN);
  const sawFar = panLeft(SAW_PAN);
  const square = SQUARE_LEVEL * Math.SQRT1_2;

  // --- filter: rest just above the note, opened by the envelope ---
  const rest = clamp(f0 * 2.2 + 500, 300, Math.min(6000, sr * 0.3));
  // wide open means 11 kHz: above that a saw edge is only a click
  const top = Math.min(
    sr * 0.42,
    11000,
    rest * (2.5 + 14 * Math.pow(vel, 1.3)),
  );
  const q2 = 1.3 + 0.9 * vel;
  const k1 = 1 / Q1;
  const k2 = 1 / q2;
  const filterStep = Math.exp(-CONTROL / (FILTER_TAU * sr));
  const ampStep = Math.exp(-1 / (AMP_TAU * sr));
  const releaseStep = Math.exp(-6.907755 / (RELEASE_T60 * sr));
  const bendFrames = bend ? Math.ceil(BEND_TIME * sr) : 0;

  let sweep = 1;
  let body = 1 - SUSTAIN;
  let release = 1;
  let dA = incA;
  let dB = incB;
  let dS = incS;
  let a11 = 0;
  let a12 = 0;
  let a13 = 0;
  let a21 = 0;
  let a22 = 0;
  let a23 = 0;
  let l1a = 0;
  let l1b = 0;
  let l2a = 0;
  let l2b = 0;
  let r1a = 0;
  let r1b = 0;
  let r2a = 0;
  let r2b = 0;
  for (let i = 0; i < frames; i++) {
    if ((i & (CONTROL - 1)) === 0) {
      const g = Math.tan((Math.PI * (rest + (top - rest) * sweep)) / sr);
      sweep *= filterStep;
      a11 = 1 / (1 + g * (g + k1));
      a12 = g * a11;
      a13 = g * a12;
      a21 = 1 / (1 + g * (g + k2));
      a22 = g * a21;
      a23 = g * a22;
      if (i <= bendFrames) {
        const ratio =
          i < bendFrames ? Math.pow(2, bendOffset(bend, i / sr) / 12) : 1;
        dA = incA * ratio;
        dB = incB * ratio;
        dS = incS * ratio;
      }
    }
    const a = sawBlep(phaseA, dA);
    const b = sawBlep(phaseB, dB);
    const s = square * pulseBlep(phaseS, dS, 0.5);
    phaseA += dA;
    if (phaseA >= 1) phaseA -= 1;
    phaseB += dB;
    if (phaseB >= 1) phaseB -= 1;
    phaseS += dS;
    if (phaseS >= 1) phaseS -= 1;
    // left: saw A near, saw B far
    let v3 = a * sawNear + b * sawFar + s - l1b;
    let v1 = a11 * l1a + a12 * v3;
    let v2 = l1b + a12 * l1a + a13 * v3;
    l1a = 2 * v1 - l1a;
    l1b = 2 * v2 - l1b;
    v3 = v2 - l2b;
    v1 = a21 * l2a + a22 * v3;
    v2 = l2b + a22 * l2a + a23 * v3;
    l2a = 2 * v1 - l2a;
    l2b = 2 * v2 - l2b;
    const outL = v2;
    // right: mirrored
    v3 = a * sawFar + b * sawNear + s - r1b;
    v1 = a11 * r1a + a12 * v3;
    v2 = r1b + a12 * r1a + a13 * v3;
    r1a = 2 * v1 - r1a;
    r1b = 2 * v2 - r1b;
    v3 = v2 - r2b;
    v1 = a21 * r2a + a22 * v3;
    v2 = r2b + a22 * r2a + a23 * v3;
    r2a = 2 * v1 - r2a;
    r2b = 2 * v2 - r2b;
    if (i >= hold) release *= releaseStep;
    const amp = (SUSTAIN + body) * release;
    body *= ampStep;
    l[i] = outL * amp;
    r[i] = v2 * amp;
  }
}

const level = new LevelTable({
  low: 12,
  high: 116,
  step: 4,
  velocities: [0.05, 0.3, 0.55, 0.8, 1],
  probe(left, right, frames, midi, vel, sampleRate, random) {
    pluckCore(
      left,
      right,
      frames,
      frames,
      midi,
      vel,
      undefined,
      sampleRate,
      random,
    );
  },
});

export const pluck: Voice = {
  id: "pluck",
  tail: () => TAIL,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const vel = clamp(note.vel, 0.02, 1);
    const gain =
      (REFERENCE_RMS * velocityGain(vel)) / level.rms(note.midi, vel, sr);
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    pluckCore(
      l,
      r,
      frames,
      noteOffFrame(note, frames, sr, 0.02),
      note.midi,
      vel,
      note.bend,
      sr,
      ctx.random,
    );
    mixNote(
      left,
      right,
      l,
      r,
      frames,
      gain,
      0.0012 * sr,
      0.012 * sr,
      velocityCeiling(vel),
    );
  },
};
