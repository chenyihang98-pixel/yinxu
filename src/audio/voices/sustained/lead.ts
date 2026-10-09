/**
 * synth — expressive analog-style lead.
 *
 * Two oscillators a few cents apart that start with their fundamentals in
 * phase, a band-limited saw (slightly left) and a pulse whose width drifts
 * slowly (slightly right), into a 24 dB/octave resonant low-pass per
 * channel. The filter envelope snaps open at the start and settles to a
 * sustain that follows velocity and half the keyboard; the top of its travel
 * is capped so the lead cuts through without piercing. Vibrato arrives late
 * (300 ms) and stays subtle. Fast attack, 110 ms release; NoteEvent.bend
 * glides into the note. The level is predicted from the saw and pulse
 * harmonics through the filter, including what is left of their beating
 * over the measured window.
 */
import type { Voice } from "../types";
import {
  Adsr,
  BEND_TIME,
  LEVEL_WINDOW,
  REFERENCE_RMS,
  bendOffset,
  clamp,
  forkRng,
  midiToHz,
  noteOffFrame,
  panLeft,
  panRight,
  polyBlep,
  scratch,
  sinTurns,
  svfLowpassGain,
  velocityGain,
} from "../../dsp";
import { CENT, SEMITONE, SvfRange, onset } from "../../dsp/extra-sustained";

const DETUNE = 5.5;
const SAW_PAN = -0.32;
const PULSE_PAN = 0.32;
const PULSE_LEVEL = 0.8;
const PULSE_WIDTH = 0.4;
const PULSE_DRIFT = 0.07;
/**
 * (pulse power - saw power) / (pulse power + saw power) of the two
 * fundamentals: how far the detune is shifted towards the saw
 */
const CENTRING = 0.4;
const Q1 = 0.62;
const RELEASE = 0.11;
const CONTROL = 16;
const MAX_INC = 0.24;
const MAX_HARMONICS = 300;
/** time constant of the filter envelope, seconds */
const SNAP = 0.14;
/** amplitude sustain level */
const SUSTAIN = 0.84;

interface Rig {
  left1: SvfRange;
  left2: SvfRange;
  right1: SvfRange;
  right2: SvfRange;
}

const rigs = new Map<number, Rig>();

function rigFor(sr: number): Rig {
  let rig = rigs.get(sr);
  if (!rig) {
    rig = {
      left1: new SvfRange(),
      left2: new SvfRange(),
      right1: new SvfRange(),
      right2: new SvfRange(),
    };
    rigs.set(sr, rig);
  }
  return rig;
}

export const synth: Voice = {
  id: "synth",
  tail: () => RELEASE + 0.02,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const rig = rigFor(sr);
    const random = forkRng(ctx.random);
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(note.midi), 12, sr * 0.2);

    // --- filter: sustain follows velocity and half the keyboard ---
    const sustainCutoff = clamp(
      2300 * Math.pow(f0 / 440, 0.5) * (0.35 + 1.25 * Math.pow(vel, 1.3)),
      f0 * 1.1,
      Math.min(6500, sr * 0.36),
    );
    const snap = 0.6 + 1.5 * vel;
    const peakCutoff = Math.min(7500, sr * 0.4, sustainCutoff * (1 + snap));
    const q2 = 1.5 + 1.1 * vel;

    // Two oscillators a few cents apart beat; near a beat null the pitch of
    // the pair wobbles. Low notes beat so slowly that one null would last a
    // whole note, so the detune narrows below A3, and every note starts with
    // the two fundamentals in phase (the null comes late, the attack is
    // always the full sound).
    // The pulse carries more of the fundamental than the saw, so it sits
    // closer to the written pitch: the pair is centred where it is heard.
    const detune = DETUNE * clamp(Math.sqrt(f0 / 220), 0.4, 1) * CENT;
    const sawDetune = -detune * (1 + CENTRING);
    const pulseDetune = detune * (1 - CENTRING);
    const beatHz = f0 * (Math.exp(pulseDetune) - Math.exp(sawDetune));

    // --- level: both spectra through the filter, where the envelope spends the first 400 ms ---
    const measured = Math.min(peakCutoff, sustainCutoff * (1 + snap * 0.33));
    let sawSpectrum = 0;
    let pulseSpectrum = 0;
    let shared = 0;
    const top = Math.min(sr * 0.48, measured * 8);
    for (let k = 1; k <= MAX_HARMONICS && k * f0 < top; k++) {
      const hz = k * f0;
      const m =
        svfLowpassGain(hz, measured, Q1, sr) *
        svfLowpassGain(hz, measured, q2, sr);
      const saw = (2 / (Math.PI * k)) * m;
      const pulse =
        ((4 * Math.sin(Math.PI * k * PULSE_WIDTH)) / (Math.PI * k)) * m;
      sawSpectrum += 0.5 * saw * saw;
      pulseSpectrum += 0.5 * pulse * pulse;
      // odd harmonics of the two start in phase (k = 1, 5 ...) or in
      // antiphase (3, 7 ...) and then beat k times as fast as the fundamentals:
      // what is left of that over the window adds to (or takes from) the power
      if (k & 1) {
        const x = 2 * Math.PI * k * beatHz * LEVEL_WINDOW;
        const coherence = x < 1e-6 ? 1 : Math.sin(x) / x;
        shared += (k & 2 ? -1 : 1) * coherence * saw * pulse;
      }
    }
    const sawLeft = panLeft(SAW_PAN);
    const sawRight = panRight(SAW_PAN);
    const pulseLeft = PULSE_LEVEL * panLeft(PULSE_PAN);
    const pulseRight = PULSE_LEVEL * panRight(PULSE_PAN);
    const power =
      0.5 *
      (sawSpectrum * (sawLeft * sawLeft + sawRight * sawRight) +
        pulseSpectrum * (pulseLeft * pulseLeft + pulseRight * pulseRight) +
        shared * (sawLeft * pulseLeft + sawRight * pulseRight));
    // the envelope falls from 1 to SUSTAIN inside the measured window
    const gain = (REFERENCE_RMS * velocityGain(vel) * 1.05) / Math.sqrt(power);

    // --- envelope ---
    const env = scratch(2, frames);
    new Adsr(sr, {
      attack: 0.007 - 0.003 * vel,
      decay: 1.6,
      sustain: SUSTAIN,
      release: RELEASE,
      attackShape: "exp",
    }).render(env, frames, noteOffFrame(note, frames, sr, 0.008));

    // --- oscillators into two work buffers, filtered block by block ---
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    rig.left1.reset();
    rig.left2.reset();
    rig.right1.reset();
    rig.right2.reset();
    const sawBase = (f0 * Math.exp(sawDetune)) / sr;
    const pulseBase = (f0 * Math.exp(pulseDetune)) / sr;
    const vibPhase = random();
    const vibRate = (5.4 + 0.5 * random()) / sr;
    const driftPhase = random();
    let sawPhase = random();
    let pulsePhase =
      sawPhase +
      0.25 +
      0.5 * (PULSE_WIDTH + PULSE_DRIFT * sinTurns(driftPhase));
    pulsePhase -= Math.floor(pulsePhase);
    // a moving pulse edge is a detune that grows as the note gets lower:
    // slow the drift down with the pitch so the chorus stays a few cents wide
    const driftRate =
      (clamp(0.7 * Math.pow(f0 / 262, 0.6), 0.12, 1.5) *
        (0.85 + 0.3 * random())) /
      sr;
    const vibDepth = (5 + 5 * vel) * CENT;
    for (let from = 0; from < frames; from += CONTROL) {
      const to = Math.min(frames, from + CONTROL);
      const t = from / sr;
      const vibrato =
        onset(t, 0.3, 0.4) * vibDepth * sinTurns(vibPhase + vibRate * from);
      const ratio =
        (note.bend && t < BEND_TIME
          ? Math.exp(bendOffset(note.bend, t) * SEMITONE)
          : 1) *
        (1 + vibrato);
      const sawInc = Math.min(MAX_INC, sawBase * ratio);
      const pulseInc = Math.min(MAX_INC, pulseBase * ratio);
      const width =
        PULSE_WIDTH + PULSE_DRIFT * sinTurns(driftPhase + driftRate * from);
      for (let i = from; i < to; i++) {
        const saw = 2 * sawPhase - 1 - polyBlep(sawPhase, sawInc);
        sawPhase += sawInc;
        if (sawPhase >= 1) sawPhase -= 1;
        let shifted = pulsePhase + 1 - width;
        if (shifted >= 1) shifted -= 1;
        const pulse =
          (pulsePhase < width ? 2 : 0) -
          2 * width +
          polyBlep(pulsePhase, pulseInc) -
          polyBlep(shifted, pulseInc);
        pulsePhase += pulseInc;
        if (pulsePhase >= 1) pulsePhase -= 1;
        l[i] = saw * sawLeft + pulse * pulseLeft;
        r[i] = saw * sawRight + pulse * pulseRight;
      }
      const e = env[from];
      const hz =
        (sustainCutoff + (peakCutoff - sustainCutoff) * Math.exp(-t / SNAP)) *
        (0.4 + (0.6 * Math.min(e, SUSTAIN)) / SUSTAIN);
      rig.left1.set(hz, Q1, sr);
      rig.left2.set(hz, q2, sr);
      rig.right1.copy(rig.left1);
      rig.right2.copy(rig.left2);
      rig.left1.low(l, from, to);
      rig.left2.low(l, from, to);
      rig.right1.low(r, from, to);
      rig.right2.low(r, from, to);
    }
    for (let i = 0; i < frames; i++) {
      const a = env[i] * gain;
      left[i] += l[i] * a;
      right[i] += r[i] * a;
    }
  },
};
