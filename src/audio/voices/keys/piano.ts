/**
 * Piano: the warm grand of the keys group (the group's calibrated exemplar).
 */
import type { Voice, VoiceNote } from "../types";
import {
  Biquad,
  LEVEL_WINDOW,
  ModalBank,
  REFERENCE_RMS,
  WhiteNoise,
  clamp,
  clamp01,
  fadeOut,
  lerp,
  midiToHz,
  noteOffFrame,
  panLeft,
  panRight,
  scratch,
  velocityGain,
} from "../../dsp";

/**
 * Warm, felt-like grand. Additive/modal model:
 *  - up to 40 partials (every one within 46 dB of the strongest) at stretched
 *    frequencies k·f0·sqrt(1 + B·k²), each a decaying sinusoid with its own
 *    decay time (upper partials die sooner);
 *  - two "strings" per note: a prompt one and a slightly detuned, slower
 *    aftersound, which gives the two-stage decay and a very slow unison beat;
 *  - spectrum = hammer low-pass that opens with velocity × strike-position
 *    comb × soundboard roll-off below 60 Hz;
 *  - gentle stereo the way a soundboard gives it: every partial sits at its
 *    own spot around the position of the key (bass left, treble right), in
 *    phase in both channels, so the mono sum is unchanged;
 *  - a short low-passed noise burst for the hammer;
 *  - at note-off the damper shortens every partial (dampers get weaker towards
 *    the top and stop above F#6, where notes simply ring out).
 * The level is calibrated analytically from the partial table, so the note
 * meets the -18 dBFS convention on every key without rendering twice.
 * NoteEvent.bend is ignored: a piano cannot bend.
 */
const PIANO_PARTIALS = 40;
const promptBank = new ModalBank(PIANO_PARTIALS);
const afterBank = new ModalBank(PIANO_PARTIALS);
const hammerFilter = new Biquad();
const hammerHighpass = new Biquad();
const partialHz = new Float64Array(PIANO_PARTIALS);
const partialAmp = new Float64Array(PIANO_PARTIALS);
const partialRate = new Float64Array(PIANO_PARTIALS); // dB per second
const partialPhase = new Float64Array(PIANO_PARTIALS);
const promptLeft = new Float64Array(PIANO_PARTIALS);
const promptRight = new Float64Array(PIANO_PARTIALS);
const afterLeft = new Float64Array(PIANO_PARTIALS);
const afterRight = new Float64Array(PIANO_PARTIALS);

const PROMPT_SHARE = 0.72;
const PROMPT_RATE = 1.3;
const AFTER_SHARE = 0.38;
const AFTER_RATE = 0.55;
const DB_TO_NEPER = Math.LN10 / 20;
/** fastest decay the level calibration compensates for (dB/s): the short top notes stay naturally quieter */
const CALIBRATION_MAX_RATE = 45;

/** Inharmonicity coefficient B of the string for a key. */
function pianoInharmonicity(midi: number): number {
  return Math.max(7e-5, 1.8e-4 * Math.pow(2, (midi - 57) / 12));
}

/** Decay rate of the fundamental in dB per second (60 / T60). */
function pianoBaseRate(midi: number): number {
  const d = midi - 60;
  return d < 0
    ? 4.6 * Math.pow(2, d / 30)
    : 4.6 * Math.exp(0.048 * d + 0.0004 * d * d);
}

/** How strongly the damper acts: 1 in the bass and middle, 0 above F#6. */
function damperStrength(midi: number): number {
  return clamp01((92 - midi) / 8);
}

/** T60 of the damped fundamental after note-off. */
function pianoReleaseTime(midi: number): number {
  const damped = lerp(0.42, 0.14, clamp01((midi - 28) / 56));
  const natural = 60 / pianoBaseRate(midi);
  return lerp(Math.min(natural, 1.4), damped, damperStrength(midi));
}

/** ∫ e^(-s t) dt over [0, T] */
function expIntegral(s: number, T: number): number {
  return s * T < 1e-9 ? T : (1 - Math.exp(-s * T)) / s;
}

export const piano: Voice = {
  id: "piano",
  tail(note: VoiceNote): number {
    return clamp(pianoReleaseTime(note.midi) * 1.1 + 0.03, 0.18, 1.6);
  },
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const midi = note.midi;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = midiToHz(midi);
    const detune = Math.pow(2, (0.25 + 0.35 * ctx.random()) / 1200);
    const noise = new WhiteNoise(ctx.random);

    // --- partial table: frequency, amplitude, decay rate, stereo position ---
    const inharmonicity = pianoInharmonicity(midi);
    const stretch = 1 / Math.sqrt(1 + inharmonicity);
    // hammer felt: spectral e-fold frequency, harder (brighter) with velocity and up the keyboard
    const hammerHz =
      680 * Math.pow(2, (midi - 60) / 36) * (0.4 + 0.95 * Math.pow(vel, 1.5));
    const baseRate = pianoBaseRate(midi);
    const nyquist = sr * 0.45;
    const keyPan = clamp((midi - 64) / 90, -0.3, 0.3);
    let count = 0;
    let strongest = 0;
    for (let k = 1; k <= PIANO_PARTIALS; k++) {
      const hz = f0 * k * Math.sqrt(1 + inharmonicity * k * k) * stretch;
      if (hz >= nyquist) break;
      const x = (hz - f0) / hammerHz;
      const rolloff = 0.86 * Math.exp(-x) + 0.14 / (1 + x * x);
      const strike = Math.sin((Math.PI * k) / 8.4);
      const comb = Math.sqrt(strike * strike + 0.05);
      const board = (hz * hz) / (hz * hz + 3600);
      const amp = rolloff * comb * board;
      if (amp > strongest) strongest = amp;
      if (k > 6 && amp < strongest * 0.005) break;
      partialHz[count] = hz;
      partialAmp[count] = amp;
      partialRate[count] = baseRate * (1 + (hz - f0) / 700);
      // golden-angle scatter: fixed per key and partial, the fundamental stays near the key position
      const scatter =
        (k === 1 ? 0.1 : 0.36) * Math.sin(k * 2.399963 + midi * 0.7);
      const promptPan = clamp(keyPan + scatter - 0.1, -1, 1);
      const afterPan = clamp(keyPan + scatter + 0.1, -1, 1);
      promptLeft[count] = panLeft(promptPan) * Math.SQRT2;
      promptRight[count] = panRight(promptPan) * Math.SQRT2;
      afterLeft[count] = panLeft(afterPan) * Math.SQRT2;
      afterRight[count] = panRight(afterPan) * Math.SQRT2;
      count++;
    }

    // the second string only matters where partials are strong: above that
    // the prompt string carries the whole partial (saves a third of the work)
    let doubled = 0;
    for (let k = 0; k < count; k++)
      if (partialAmp[k] > strongest * 0.03) doubled = k + 1;

    // --- analytic level: RMS of the first 400 ms of the held note ---
    const T = LEVEL_WINDOW;
    let power = 0;
    for (let k = 0; k < count; k++) {
      const a =
        partialAmp[k] *
        (k < doubled ? PROMPT_SHARE : PROMPT_SHARE + AFTER_SHARE);
      const b = k < doubled ? partialAmp[k] * AFTER_SHARE : 0;
      const rate = Math.min(partialRate[k], CALIBRATION_MAX_RATE);
      const sa = rate * PROMPT_RATE * DB_TO_NEPER;
      const sb = rate * AFTER_RATE * DB_TO_NEPER;
      const s = sa + sb;
      // the two strings stay nearly in phase for the first cycles, then drift
      const w = 2 * Math.PI * partialHz[k] * (detune - 1);
      const decay = Math.exp(-s * T);
      const cross =
        (s * (1 - decay * Math.cos(w * T)) + w * decay * Math.sin(w * T)) /
        (s * s + w * w);
      const aa = a * a * expIntegral(2 * sa, T);
      const bb = b * b * expIntegral(2 * sb, T);
      const ab = 2 * a * b * cross;
      const pl = promptLeft[k];
      const pr = promptRight[k];
      const al = afterLeft[k];
      const ar = afterRight[k];
      power +=
        0.25 *
        ((pl * pl + pr * pr) * aa +
          (al * al + ar * ar) * bb +
          (pl * al + pr * ar) * ab);
    }
    const gain = (REFERENCE_RMS * velocityGain(vel)) / Math.sqrt(power / T);

    // Dense bass spectra would stack into one tall pulse per cycle; a quadratic
    // phase spread (what string dispersion does within the first cycles) keeps
    // the same spectrum at a much lower crest factor.
    const dispersal = 0.9 * clamp01((count - 5) / 18);
    for (let k = 0; k < count; k++) {
      partialPhase[k] = (dispersal * Math.PI * (k + 1) * (k + 1)) / count;
      const t60 = 60 / partialRate[k];
      promptBank.set(
        k,
        partialHz[k],
        t60 / PROMPT_RATE,
        partialAmp[k] *
          (k < doubled ? PROMPT_SHARE : PROMPT_SHARE + AFTER_SHARE) *
          gain,
        sr,
      );
      if (k >= doubled) continue;
      afterBank.set(
        k,
        Math.min(partialHz[k] * detune, sr * 0.49),
        t60 / AFTER_RATE,
        partialAmp[k] * AFTER_SHARE * gain,
        sr,
      );
    }
    promptBank.count = count;
    afterBank.count = doubled;
    promptBank.strike(1, partialPhase);
    afterBank.strike(1, partialPhase);

    // --- render: held part, then the damped part ---
    const hold = noteOffFrame(note, frames, sr, 0.02);
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    promptBank.renderStereo(l, r, 0, hold, promptLeft, promptRight);
    afterBank.renderStereo(l, r, 0, hold, afterLeft, afterRight);
    const release = pianoReleaseTime(midi);
    const strength = damperStrength(midi);
    for (let k = 0; k < count; k++) {
      const natural = 60 / partialRate[k];
      // the damper kills upper partials a little faster than the fundamental
      const damped = release / (1 + 0.12 * k);
      const pa = natural / PROMPT_RATE;
      const pb = natural / AFTER_RATE;
      promptBank.setDecay(k, lerp(pa, Math.min(pa, damped), strength), sr);
      if (k < doubled)
        afterBank.setDecay(k, lerp(pb, Math.min(pb, damped), strength), sr);
    }
    promptBank.renderStereo(l, r, hold, frames - hold, promptLeft, promptRight);
    afterBank.renderStereo(l, r, hold, frames - hold, afterLeft, afterRight);

    // --- hammer: low-passed noise thump, more of it when played hard ---
    const thump = scratch(2, frames);
    const thumpFrames = Math.min(frames, Math.round(0.12 * sr));
    const thumpGain =
      REFERENCE_RMS *
      2.2 *
      Math.pow(vel, 1.8) *
      lerp(0.85, 1.1, clamp01((midi - 48) / 48));
    hammerFilter.setLowpass(
      lerp(350, 2600, vel) * Math.pow(2, (midi - 60) / 48),
      0.7,
      sr,
    );
    hammerHighpass.setHighpass(110, 0.7, sr);
    hammerFilter.reset();
    hammerHighpass.reset();
    const thumpDecay = Math.exp(
      -1 / (lerp(0.014, 0.007, clamp01((midi - 36) / 60)) * sr),
    );
    const thumpAttack = Math.max(8, Math.round(0.0012 * sr));
    let thumpEnv = thumpGain;
    for (let i = 0; i < thumpFrames; i++) {
      const rise =
        i < thumpAttack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / thumpAttack) : 1;
      thump[i] =
        hammerHighpass.next(hammerFilter.next(noise.next())) * thumpEnv * rise;
      thumpEnv *= thumpDecay;
    }
    fadeOut(thump, thumpFrames, Math.min(thumpFrames, 256));

    // --- attack ramp (softer when played softly), hammer, safety fade ---
    const attack = Math.max(16, Math.round((0.0012 + 0.004 * (1 - vel)) * sr));
    const fade = Math.min(frames, Math.max(32, Math.round(0.012 * sr)));
    const fadeStart = frames - fade;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      let env = 1;
      if (i < attack) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
      if (i >= fadeStart)
        env *= 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeStart + 1)) / fade);
      const n = thump[i];
      const x = (l[i] + n) * env;
      const y = (r[i] + n) * env;
      l[i] = x;
      r[i] = y;
      if (x > peak) peak = x;
      else if (-x > peak) peak = -x;
      if (y > peak) peak = y;
      else if (-y > peak) peak = -y;
    }
    // hard guarantee of the contract ceiling |1.0| (normally never engaged)
    const trim = peak > 0.98 ? 0.98 / peak : 1;
    for (let i = 0; i < frames; i++) {
      left[i] += l[i] * trim;
      right[i] += r[i] * trim;
    }
  },
};
