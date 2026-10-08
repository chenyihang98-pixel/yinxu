/**
 * subBass — clean sub that small speakers can still follow: a sine with a
 * little triangle through a gentle tanh (odd harmonics, stronger with
 * velocity) plus a touch of 2nd and 4th harmonic, the even part an
 * asymmetric stage would add. At vel 0.8 the harmonics sit near
 * -13 / -14 / -19 / -25 dB (2nd..5th), so an E1 still has energy at
 * 120-210 Hz. The waveshape is static per note: its mean and RMS are
 * measured over one cycle up front, so there is no DC and the level is exact
 * on every pitch. Mono, soft attack (12 ms, up to 80 ms on long notes),
 * 90 ms release. NoteEvent.bend
 * glides into the note.
 */
import type { Voice } from "../types";
import {
  Adsr,
  BEND_TIME,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  fastTanh,
  midiToHz,
  noteOffFrame,
  scratch,
  sinPhase,
  velocityGain,
} from "../../dsp";

const TRIANGLE_MIX = 0.22;
const SHAPE_POINTS = 256;

function subShape(
  phase: number,
  drive: number,
  norm: number,
  second: number,
  fourth: number,
): number {
  let tri = phase + 0.25;
  if (tri >= 1) tri -= 1;
  const u =
    (1 - TRIANGLE_MIX) * sinPhase(phase) +
    TRIANGLE_MIX * (1 - 4 * Math.abs(tri - 0.5));
  let twice = phase + phase;
  if (twice >= 1) twice -= 1;
  let four = twice + twice;
  if (four >= 1) four -= 1;
  return (
    fastTanh(drive * u) * norm +
    second * sinPhase(twice) +
    fourth * sinPhase(four)
  );
}

export const subBass: Voice = {
  id: "subBass",
  tail: () => 0.1,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 8, sr * 0.2);
    const drive = 0.9 + 2.3 * Math.pow(vel, 1.3);
    const norm = 1 / fastTanh(drive);
    const second = 0.14 + 0.16 * vel;
    const fourth = 0.05 + 0.1 * vel;

    // --- measure the static waveshape: remove its DC, normalise its RMS ---
    let mean = 0;
    let square = 0;
    for (let i = 0; i < SHAPE_POINTS; i++) {
      const v = subShape(i / SHAPE_POINTS, drive, norm, second, fourth);
      mean += v;
      square += v * v;
    }
    mean /= SHAPE_POINTS;
    const rms = Math.sqrt(Math.max(1e-12, square / SHAPE_POINTS - mean * mean));
    const gain = (REFERENCE_RMS * velocityGain(vel)) / rms;

    const env = scratch(0, frames);
    new Adsr(sr, {
      // a pulsed line speaks at once; a long drone note swells in over a few
      // cycles (a 12 ms rise on a 50 Hz tone is a thump across the spectrum,
      // plain to hear when a held note is re-struck in a quiet texture)
      attack: clamp(0.012 + 0.03 * (note.duration - 0.6), 0.012, 0.08),
      decay: 0.1,
      sustain: 1,
      release: 0.09,
      attackShape: "cos",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.01));

    const bendFrames = note.bend ? Math.ceil(BEND_TIME * sr) : 0;
    const baseInc = f0 / sr;
    let inc = baseInc;
    let phase = 0;
    for (let i = 0; i < frames; i++) {
      if (i < bendFrames && (i & 7) === 0)
        inc = baseInc * Math.pow(2, bendOffset(note.bend, i / sr) / 12);
      else if (i === bendFrames) inc = baseInc;
      const v =
        (subShape(phase, drive, norm, second, fourth) - mean) * gain * env[i];
      left[i] += v;
      right[i] += v;
      phase += inc;
      if (phase >= 1) phase -= 1;
    }
  },
};
