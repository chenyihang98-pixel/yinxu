/**
 * synthBass — saw and square through a resonant low-pass with a snappy
 * filter envelope.
 *
 * Both oscillators restart in phase on every note (a falling saw and a
 * square whose fundamentals add), so each note of a sixteenth-note ostinato
 * has the same solid fundamental and the same attack. The 24 dB/octave
 * filter opens far above its resting point at the start and snaps back
 * within about 70 ms; velocity raises the resting cutoff, the depth of the
 * snap and the resonance. Mono, 2 ms attack, 50 ms release;
 * NoteEvent.bend glides into the note. Because the harmonics are phase
 * locked the level is exact: it is the power of the harmonic series through
 * the filter, averaged over the first 400 ms of the envelope.
 */
import type { Voice } from "../types";
import {
  Adsr,
  BEND_TIME,
  LEVEL_WINDOW,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  midiToHz,
  noteOffFrame,
  polyBlep,
  scratch,
  svfLowpassGain,
  velocityGain,
} from "../../dsp";
import { SEMITONE, SvfRange } from "../../dsp/extra-sustained";

const SQUARE_LEVEL = 0.35;
const Q1 = 0.65;
const RELEASE = 0.05;
const CONTROL = 16;
const MAX_INC = 0.24;
const MAX_HARMONICS = 160;
/** time constant of the filter snap, seconds */
const SNAP = 0.07;
/** amplitude envelope: falls from 1 towards SUSTAIN (a full fall would take DECAY seconds) */
const SUSTAIN = 0.78;
const DECAY = 1.4;
/** points of the first 400 ms the level is averaged over */
const LEVEL_POINTS = 6;

const filters = new Map<number, [SvfRange, SvfRange]>();

export const synthBass: Voice = {
  id: "synthBass",
  tail: () => RELEASE + 0.01,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 10, sr * 0.2);

    // --- filter: resting cutoff, snap depth and resonance rise with velocity ---
    const rest = clamp(
      160 + 520 * Math.pow(vel, 1.3) + 1.6 * f0,
      f0 * 1.05,
      sr * 0.3,
    );
    const snap = 1.5 + 5.5 * vel;
    const q2 = 1.3 + 1.5 * vel;
    const ceiling = Math.min(9000, sr * 0.4);
    const cutoffAt = (t: number) =>
      Math.min(ceiling, rest * (1 + snap * Math.exp(-t / SNAP)));

    // --- level: mean power of the locked harmonics over the first 400 ms ---
    const fall = Math.log(1001) / DECAY;
    let power = 0;
    for (let p = 0; p < LEVEL_POINTS; p++) {
      const t = ((p + 0.5) / LEVEL_POINTS) * LEVEL_WINDOW;
      const cutoff = cutoffAt(t);
      // the Adsr decay: an exponential from 1 that aims just below SUSTAIN
      const amp = Math.max(
        SUSTAIN,
        SUSTAIN - 0.001 + (1.001 - SUSTAIN) * Math.exp(-fall * t),
      );
      let spectrum = 0;
      const top = Math.min(sr * 0.48, cutoff * 6);
      for (let k = 1; k <= MAX_HARMONICS && k * f0 < top; k++) {
        const hz = k * f0;
        // falling saw 2/(πk); the square adds 4/(πk) on odd harmonics
        const a =
          ((2 + (k & 1 ? 4 * SQUARE_LEVEL : 0)) / (Math.PI * k)) *
          svfLowpassGain(hz, cutoff, Q1, sr) *
          svfLowpassGain(hz, cutoff, q2, sr);
        spectrum += 0.5 * a * a;
      }
      power += (spectrum * amp * amp) / LEVEL_POINTS;
    }
    const gain = (REFERENCE_RMS * velocityGain(vel)) / Math.sqrt(power);

    // --- envelope ---
    const env = scratch(1, frames);
    new Adsr(sr, {
      attack: 0.002,
      decay: DECAY,
      sustain: SUSTAIN,
      release: RELEASE,
      attackShape: "cos",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.006));

    // --- oscillators (phase locked) and filter, block by block ---
    let pair = filters.get(sr);
    if (!pair) {
      pair = [new SvfRange(), new SvfRange()];
      filters.set(sr, pair);
    }
    pair[0].reset();
    pair[1].reset();
    const buf = scratch(0, frames);
    const baseInc = f0 / sr;
    let phase = 0;
    for (let from = 0; from < frames; from += CONTROL) {
      const to = Math.min(frames, from + CONTROL);
      const t = from / sr;
      const inc = Math.min(
        MAX_INC,
        note.bend && t < BEND_TIME
          ? baseInc * Math.exp(bendOffset(note.bend, t) * SEMITONE)
          : baseInc,
      );
      for (let i = from; i < to; i++) {
        let half = phase + 0.5;
        if (half >= 1) half -= 1;
        const edge = polyBlep(phase, inc);
        buf[i] =
          1 -
          2 * phase +
          edge +
          SQUARE_LEVEL * ((phase < 0.5 ? 1 : -1) + edge - polyBlep(half, inc));
        phase += inc;
        if (phase >= 1) phase -= 1;
      }
      const hz =
        cutoffAt(t) * (0.5 + (0.5 * Math.min(env[from], SUSTAIN)) / SUSTAIN);
      pair[0].set(hz, Q1, sr);
      pair[1].set(hz, q2, sr);
      pair[0].low(buf, from, to);
      pair[1].low(buf, from, to);
    }
    for (let i = 0; i < frames; i++) {
      const v = buf[i] * env[i] * gain;
      left[i] += v;
      right[i] += v;
    }
  },
};
