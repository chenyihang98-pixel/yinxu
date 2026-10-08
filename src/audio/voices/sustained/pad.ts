/**
 * pad — warm analog-style pad: seven detuned band-limited saws spread across
 * the stereo field plus a centred triangle for body, through a 24 dB/octave
 * low-pass (two TPT SVFs per channel) that opens with velocity, follows the
 * slow amplitude envelope and drifts with a slow LFO. The saws start from a
 * designed phase pattern (see seedPhases), rotated at random per note, so a
 * note neither swells nor thins by chance and the channels never start out
 * of phase, yet repeated notes do not flange identically.
 * The level is predicted from the saw harmonics through the filter.
 */
import type { Voice } from "../types";
import {
  Adsr,
  BEND_TIME,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  forkRng,
  midiToHz,
  noteOffFrame,
  panLeft,
  panRight,
  sawBlep,
  scratch,
  svfLowpassGain,
  velocityGain,
} from "../../dsp";
import { seedPhases } from "../../dsp/extra-sustained";

/** attack seconds at vel 0 and at vel 1 */
const ATTACK: [soft: number, hard: number] = [0.46, 0.2];
/** release seconds (to silence) */
const RELEASE = 1.3;
/** detune of the outermost saws in cents */
const SPREAD = 11;
/** level of the centred triangle relative to one saw */
const BODY = 0.9;

const SAWS = 7;
const DETUNE = [-1, -0.61, -0.24, 0, 0.27, 0.63, 1.04];
const SAW_GAIN = [0.72, 0.86, 1, 1, 1, 0.86, 0.72];
const SAW_PAN = [-1, 0.7, -0.4, 0, 0.4, -0.7, 1];
/**
 * start phases for exactly these DETUNE / SAW_GAIN / SAW_PAN tables and the
 * triangle locked to the centre saw (see seedPhases)
 */
const PHASES = [0, 0.19, 0.271, 0.691, 0.763, 0.873, 0.232];
/** the saw that is not detuned: the triangle never drifts against it */
const CENTRE = 3;
const Q1 = 0.56;
const Q2 = 0.9;
const CONTROL = 16;

const sawPhase = new Float64Array(SAWS);
const sawInc = new Float64Array(SAWS);
const sawLeft = new Float64Array(SAWS);
const sawRight = new Float64Array(SAWS);

export const pad: Voice = {
  id: "pad",
  tail: () => RELEASE + 0.03,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const random = forkRng(ctx.random);
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 12, sr * 0.2);

    // --- oscillators ---
    const spread = SPREAD * clamp(Math.pow(220 / f0, 0.3), 0.8, 1.5);
    let sawPower = 0;
    seedPhases(sawPhase, PHASES, random);
    for (let s = 0; s < SAWS; s++) {
      sawInc[s] = (f0 * Math.pow(2, (DETUNE[s] * spread) / 1200)) / sr;
      sawLeft[s] = SAW_GAIN[s] * panLeft(SAW_PAN[s]);
      sawRight[s] = SAW_GAIN[s] * panRight(SAW_PAN[s]);
      sawPower += 0.5 * SAW_GAIN[s] * SAW_GAIN[s];
    }
    // The triangle and the centre saw share one pitch, so their phase
    // relation lasts the whole note. Starting the triangle (a -cos) on the
    // phase of that saw (a -sin) puts their fundamentals a quarter cycle
    // apart: the powers add, as the level prediction assumes, instead of the
    // two reinforcing or cancelling by chance.
    let bodyPhase = sawPhase[CENTRE];
    const bodyInc = f0 / sr;
    const bodyGain = BODY * Math.SQRT1_2;
    const lfoPhase = random();
    const lfoInc = (0.19 + 0.1 * random()) / sr;

    // --- filter: keyboard tracking 60 %, opens with velocity ---
    const cutoff = clamp(
      700 * Math.pow(f0 / 220, 0.6) * (0.35 + 1.9 * Math.pow(vel, 1.2)),
      f0 * 1.2,
      sr * 0.4,
    );

    // --- level: mean power of the filtered saws + triangle at full envelope ---
    let sawSpectrum = 0;
    let triSpectrum = 0;
    const top = Math.min(sr * 0.48, cutoff * 14);
    for (let k = 1; k * f0 < top; k++) {
      const m =
        svfLowpassGain(k * f0, cutoff, Q1, sr) *
        svfLowpassGain(k * f0, cutoff, Q2, sr);
      const saw = 2 / (Math.PI * k);
      sawSpectrum += 0.5 * saw * saw * m * m;
      if (k & 1) {
        const tri = 8 / (Math.PI * Math.PI * k * k);
        triSpectrum += 0.5 * tri * tri * m * m;
      }
    }
    const power = sawSpectrum * sawPower + triSpectrum * bodyGain * bodyGain;
    // the loudest 400 ms of a beating unison sit a little above its mean power
    const gain = (REFERENCE_RMS * velocityGain(vel) * 0.92) / Math.sqrt(power);

    // --- envelope ---
    const env = scratch(0, frames);
    const attack = ATTACK[0] + (ATTACK[1] - ATTACK[0]) * vel;
    new Adsr(sr, {
      attack,
      decay: 0.1,
      sustain: 1,
      release: RELEASE,
      attackShape: "cos",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.01));

    // --- render ---
    // the seven saws live in locals (twice as fast as indexing typed arrays)
    const i0 = sawInc[0];
    const i1 = sawInc[1];
    const i2 = sawInc[2];
    const i3 = sawInc[3];
    const i4 = sawInc[4];
    const i5 = sawInc[5];
    const i6 = sawInc[6];
    let d0 = i0;
    let d1 = i1;
    let d2 = i2;
    let d3 = i3;
    let d4 = i4;
    let d5 = i5;
    let d6 = i6;
    let p0 = sawPhase[0];
    let p1 = sawPhase[1];
    let p2 = sawPhase[2];
    let p3 = sawPhase[3];
    let p4 = sawPhase[4];
    let p5 = sawPhase[5];
    let p6 = sawPhase[6];
    const gl0 = sawLeft[0];
    const gl1 = sawLeft[1];
    const gl2 = sawLeft[2];
    const gl3 = sawLeft[3];
    const gl4 = sawLeft[4];
    const gl5 = sawLeft[5];
    const gl6 = sawLeft[6];
    const gr0 = sawRight[0];
    const gr1 = sawRight[1];
    const gr2 = sawRight[2];
    const gr3 = sawRight[3];
    const gr4 = sawRight[4];
    const gr5 = sawRight[5];
    const gr6 = sawRight[6];
    let bodyStep = bodyInc;
    let l1a = 0;
    let l1b = 0;
    let l2a = 0;
    let l2b = 0;
    let r1a = 0;
    let r1b = 0;
    let r2a = 0;
    let r2b = 0;
    let a11 = 0;
    let a12 = 0;
    let a13 = 0;
    let a21 = 0;
    let a22 = 0;
    let a23 = 0;
    const k1 = 1 / Q1;
    const k2 = 1 / Q2;
    const bendFrames = note.bend ? Math.ceil(BEND_TIME * sr) : 0;
    const maxCutoff = sr * 0.45;
    for (let i = 0; i < frames; i++) {
      if ((i & (CONTROL - 1)) === 0) {
        const lfo = Math.sin(2 * Math.PI * (lfoPhase + lfoInc * i));
        const hz = Math.min(
          maxCutoff,
          cutoff * (0.5 + 0.5 * env[i]) * (1 + 0.045 * lfo),
        );
        const g = Math.tan((Math.PI * hz) / sr);
        a11 = 1 / (1 + g * (g + k1));
        a12 = g * a11;
        a13 = g * a12;
        a21 = 1 / (1 + g * (g + k2));
        a22 = g * a21;
        a23 = g * a22;
        if (i <= bendFrames) {
          const ratio =
            i < bendFrames
              ? Math.pow(2, bendOffset(note.bend, i / sr) / 12)
              : 1;
          d0 = i0 * ratio;
          d1 = i1 * ratio;
          d2 = i2 * ratio;
          d3 = i3 * ratio;
          d4 = i4 * ratio;
          d5 = i5 * ratio;
          d6 = i6 * ratio;
          bodyStep = bodyInc * ratio;
        }
      }
      let x = sawBlep(p0, d0);
      let sl = x * gl0;
      let sr2 = x * gr0;
      p0 += d0;
      if (p0 >= 1) p0 -= 1;
      x = sawBlep(p1, d1);
      sl += x * gl1;
      sr2 += x * gr1;
      p1 += d1;
      if (p1 >= 1) p1 -= 1;
      x = sawBlep(p2, d2);
      sl += x * gl2;
      sr2 += x * gr2;
      p2 += d2;
      if (p2 >= 1) p2 -= 1;
      x = sawBlep(p3, d3);
      sl += x * gl3;
      sr2 += x * gr3;
      p3 += d3;
      if (p3 >= 1) p3 -= 1;
      x = sawBlep(p4, d4);
      sl += x * gl4;
      sr2 += x * gr4;
      p4 += d4;
      if (p4 >= 1) p4 -= 1;
      x = sawBlep(p5, d5);
      sl += x * gl5;
      sr2 += x * gr5;
      p5 += d5;
      if (p5 >= 1) p5 -= 1;
      x = sawBlep(p6, d6);
      sl += x * gl6;
      sr2 += x * gr6;
      p6 += d6;
      if (p6 >= 1) p6 -= 1;
      // centred triangle (its few harmonics need no band-limiting below the filter)
      const tri = bodyGain * (1 - 4 * Math.abs(bodyPhase - 0.5));
      bodyPhase += bodyStep;
      if (bodyPhase >= 1) bodyPhase -= 1;
      sl += tri;
      sr2 += tri;
      // left: two cascaded SVF low-passes
      let v3 = sl - l1b;
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
      // right
      v3 = sr2 - r1b;
      v1 = a11 * r1a + a12 * v3;
      v2 = r1b + a12 * r1a + a13 * v3;
      r1a = 2 * v1 - r1a;
      r1b = 2 * v2 - r1b;
      v3 = v2 - r2b;
      v1 = a21 * r2a + a22 * v3;
      v2 = r2b + a22 * r2a + a23 * v3;
      r2a = 2 * v1 - r2a;
      r2b = 2 * v2 - r2b;
      const amp = env[i] * gain;
      left[i] += outL * amp;
      right[i] += v2 * amp;
    }
  },
};
