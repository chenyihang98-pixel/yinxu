/**
 * chipBass — the triangle channel of an 8-bit console.
 *
 * The 2A03 triangle is a 32-step, 4-bit staircase: a triangle plus a faint
 * buzz of step harmonics around 32x the fundamental, which is what makes it
 * audible on small speakers. Each step is band-limited here. The channel had
 * no volume control; this voice has, and velocity also sets how much of the
 * staircase is mixed into a smooth triangle (soft notes are rounder, hard
 * notes carry the full 4-bit steps). Instant attack, short release, mono.
 * Pitch bends move on the console's 60 Hz frame grid.
 */
import type { Voice } from "../types";
import {
  Adsr,
  MIN_RAMP,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  midiToHz,
  noteOffFrame,
  scratch,
  triBlamp,
  velocityGain,
} from "../../dsp";
import {
  NES_TRIANGLE_MAX_INC,
  NES_TRIANGLE_PEAK,
  SEMITONE,
  nesTriangle,
  nesTriangleLevel,
} from "../../dsp/extra-sustained";

const FRAME_RATE = 60;
const RELEASE = 0.01;
const MAX_INC = 0.24;

/** mean squares of the staircase, of the smooth triangle under it, and their product */
const MOMENTS = (() => {
  const points = 32 * 64;
  let steps = 0;
  let smooth = 0;
  let cross = 0;
  for (let i = 0; i < points; i++) {
    const phase = (i + 0.5) / points;
    const s = nesTriangleLevel(phase);
    let u = phase + 0.25;
    if (u >= 1) u -= 1;
    const t = NES_TRIANGLE_PEAK * (1 - 4 * Math.abs(u - 0.5));
    steps += s * s;
    smooth += t * t;
    cross += s * t;
  }
  return {
    steps: steps / points,
    smooth: smooth / points,
    cross: cross / points,
  };
})();

export const chipBass: Voice = {
  id: "chipBass",
  tail: () => RELEASE + 0.004,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 10, sr * 0.2);
    const bendPeak = note.bend && note.bend > 0 ? note.bend : 0;
    // above this pitch one step is shorter than two samples: play the smooth triangle
    const stepped =
      (f0 * Math.exp(bendPeak * SEMITONE)) / sr <= NES_TRIANGLE_MAX_INC * 0.8;
    const mix = stepped ? 0.2 + 0.8 * Math.pow(vel, 1.2) : 0;

    const power =
      mix * mix * MOMENTS.steps +
      (1 - mix) * (1 - mix) * MOMENTS.smooth +
      2 * mix * (1 - mix) * MOMENTS.cross;
    const gain = (REFERENCE_RMS * velocityGain(vel)) / Math.sqrt(power);

    const env = scratch(0, frames);
    new Adsr(sr, {
      attack: MIN_RAMP,
      decay: 0.1,
      sustain: 1,
      release: RELEASE,
      attackShape: "lin",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.004));

    const frameLength = sr / FRAME_RATE;
    const baseInc = Math.min(MAX_INC, f0 / sr);
    const smoothGain = (1 - mix) * NES_TRIANGLE_PEAK;
    let inc = baseInc;
    let phase = 0;
    let nextFrame = 0;
    for (let i = 0; i < frames; i++) {
      if (note.bend && i >= nextFrame) {
        inc = Math.min(
          MAX_INC,
          baseInc * Math.exp(bendOffset(note.bend, i / sr) * SEMITONE),
        );
        nextFrame += frameLength;
      }
      const v =
        (smoothGain * triBlamp(phase, inc) +
          (mix > 0 ? mix * nesTriangle(phase, inc) : 0)) *
        env[i] *
        gain;
      left[i] += v;
      right[i] += v;
      phase += inc;
      if (phase >= 1) phase -= 1;
    }
  },
};
