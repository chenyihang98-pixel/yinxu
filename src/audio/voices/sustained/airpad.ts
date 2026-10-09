/**
 * airpad — bright, breathy, glassy pad for dreamy and ambient textures.
 *
 * A steady centred sine carries the pitch. Above it two banks of sine
 * partials (2nd .. 8th harmonic), a few cents flat on the left and sharp on
 * the right, start in phase and slowly drift apart: the partials beat at
 * different rates, so the sound widens and shimmers as it is held. Every
 * partial also breathes on its own slow LFO, so the colour keeps evolving.
 * Two independent bands of noise around the upper partials (one per channel,
 * wandering slowly) are the "air". Velocity lifts the upper partials.
 * Slow attack (0.9 .. 0.45 s) and a 1.8 s release.
 */
import type { Voice } from "../types";
import {
  Adsr,
  BEND_TIME,
  REFERENCE_RMS,
  WhiteNoise,
  bendOffset,
  clamp,
  forkRng,
  midiToHz,
  noteOffFrame,
  scratch,
  sinPhase,
  sinTurns,
  velocityGain,
} from "../../dsp";
import {
  CENT,
  SEMITONE,
  SvfRange,
  bandpassNoisePower,
  guardGain,
} from "../../dsp/extra-sustained";

/** highest harmonic of the two partial banks */
const TOP = 8;
/** amplitude of harmonic 2..8 relative to the centred fundamental: octaves and fifths ring, like glass */
const PARTIAL = [0, 0, 0.62, 0.44, 0.5, 0.2, 0.32, 0.1, 0.24];
/** share of each bank that reaches the other channel */
const CROSS = 0.3;
/** depth of the slow per-partial LFOs */
const BREATHE = 0.45;
const RELEASE = 1.8;
const CONTROL = 16;
const NOISE_Q = 3;

const lfoPhase = new Float64Array(2 * (TOP + 1));
const lfoRate = new Float64Array(2 * (TOP + 1));
const gainA = new Float64Array(TOP + 1);
const gainB = new Float64Array(TOP + 1);
const base = new Float64Array(TOP + 1);

const bands = new Map<number, [SvfRange, SvfRange]>();

export const airpad: Voice = {
  id: "airpad",
  tail: () => RELEASE + 0.03,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const random = forkRng(ctx.random);
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 12, sr * 0.2);
    const bendPeak = note.bend && note.bend > 0 ? note.bend : 0;
    const highest = f0 * Math.exp(bendPeak * SEMITONE);
    const top = Math.max(1, Math.min(TOP, Math.floor((sr * 0.42) / highest)));

    // --- partials: brighter with velocity, thinner towards the top of the keyboard ---
    const tilt =
      (0.56 + 0.52 * vel) * clamp(Math.pow(330 / f0, 0.25), 0.6, 1.2);
    let upper = 0;
    for (let k = 2; k <= TOP; k++) {
      base[k] = k <= top ? PARTIAL[k] * Math.pow(tilt, Math.log2(k)) : 0;
      upper += 0.5 * base[k] * base[k];
      for (let bank = 0; bank < 2; bank++) {
        lfoPhase[bank * (TOP + 1) + k] = random();
        lfoRate[bank * (TOP + 1) + k] = (0.06 + 0.2 * random()) / sr;
      }
    }
    const tonal =
      0.5 + upper * (1 + CROSS * CROSS) * (1 + 0.5 * BREATHE * BREATHE);

    // --- air: one noise band per channel around the upper partials ---
    const centre = clamp(f0 * 4, 900, Math.min(6500, sr * 0.3));
    const airShare = 0.16 + 0.1 * (1 - vel);
    const bandPower = bandpassNoisePower(centre, NOISE_Q, sr) / 3;
    const airGain = Math.sqrt((airShare * tonal) / bandPower);
    // (the breathing partials lift the loudest 400 ms a little above the mean)
    const gain =
      (REFERENCE_RMS * velocityGain(vel) * 0.97) /
      Math.sqrt(tonal * (1 + airShare));

    // --- envelope ---
    const env = scratch(2, frames);
    new Adsr(sr, {
      attack: 0.9 - 0.45 * vel,
      decay: 0.1,
      sustain: 1,
      release: RELEASE,
      attackShape: "cos",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.01));

    // --- air into two work buffers ---
    let pair = bands.get(sr);
    if (!pair) {
      pair = [new SvfRange(), new SvfRange()];
      bands.set(sr, pair);
    }
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    new WhiteNoise(random).fill(l, frames, airGain);
    new WhiteNoise(random).fill(r, frames, airGain);
    pair[0].reset();
    pair[1].reset();
    const wanderPhase = random();
    const wanderRate = (0.11 + 0.1 * random()) / sr;

    // --- tone ---
    // detune shrinks towards the top so the upper partials never flutter
    const detune = 2.6 * clamp(Math.pow(262 / f0, 0.5), 0.4, 2) * CENT;
    const baseInc = f0 / sr;
    const start = random();
    let phase = start;
    let phaseA = start;
    let phaseB = start;
    let inc = baseInc;
    const bendFrames = note.bend ? Math.ceil(BEND_TIME * sr) : 0;
    for (let from = 0; from < frames; from += CONTROL) {
      const to = Math.min(frames, from + CONTROL);
      if (from <= bendFrames)
        inc =
          from < bendFrames
            ? Math.min(
                0.24,
                baseInc * Math.exp(bendOffset(note.bend, from / sr) * SEMITONE),
              )
            : baseInc;
      const incA = inc * (1 - detune);
      const incB = inc * (1 + detune);
      for (let k = 2; k <= top; k++) {
        gainA[k] =
          base[k] * (1 + BREATHE * sinTurns(lfoPhase[k] + lfoRate[k] * from));
        gainB[k] =
          base[k] *
          (1 +
            BREATHE *
              sinTurns(lfoPhase[TOP + 1 + k] + lfoRate[TOP + 1 + k] * from));
      }
      const wander = 1 + 0.12 * sinTurns(wanderPhase + wanderRate * from);
      pair[0].set(centre * wander, NOISE_Q, sr);
      pair[1].set(centre * (2 - wander), NOISE_Q, sr);
      pair[0].band(l, from, to);
      pair[1].band(r, from, to);
      for (let i = from; i < to; i++) {
        const fundamental = sinPhase(phase);
        phase += inc;
        if (phase >= 1) phase -= 1;
        // harmonics 2..top of each bank by the Chebyshev recurrence
        let quarter = phaseA + 0.25;
        if (quarter >= 1) quarter -= 1;
        let twoCos = 2 * sinPhase(quarter);
        let previous = 0;
        let current = sinPhase(phaseA);
        let a = 0;
        for (let k = 2; k <= top; k++) {
          const next = twoCos * current - previous;
          previous = current;
          current = next;
          a += gainA[k] * next;
        }
        phaseA += incA;
        if (phaseA >= 1) phaseA -= 1;
        quarter = phaseB + 0.25;
        if (quarter >= 1) quarter -= 1;
        twoCos = 2 * sinPhase(quarter);
        previous = 0;
        current = sinPhase(phaseB);
        let b = 0;
        for (let k = 2; k <= top; k++) {
          const next = twoCos * current - previous;
          previous = current;
          current = next;
          b += gainB[k] * next;
        }
        phaseB += incB;
        if (phaseB >= 1) phaseB -= 1;
        l[i] += fundamental + a + CROSS * b;
        r[i] += fundamental + b + CROSS * a;
      }
    }
    const out = guardGain(l, r, frames, gain);
    for (let i = 0; i < frames; i++) {
      const amp = env[i] * out;
      left[i] += l[i] * amp;
      right[i] += r[i] * amp;
    }
  },
};
