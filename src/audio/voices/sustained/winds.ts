/**
 * flute and dizi — two blown pipes from one engine.
 *
 * The tone is additive: harmonics of one phase (Chebyshev recurrences for
 * sin kθ and cos kθ), so every amplitude and phase is under direct control
 * and nothing aliases. The harmonics are not stacked in phase (that would be
 * one spike per cycle): each is delayed a little more than the one below,
 * which spreads the energy of a cycle over part of the period. A pipe's
 * spectrum follows the breath: the harmonics come in one after another
 * during the attack, overshoot slightly ("chiff"), and swell with the
 * vibrato. Breath is band-passed noise, pulsed at the pitch of the note so
 * it fuses with the tone, strongest at the attack and independent in the two
 * channels (the tone itself is centred). Slight pitch wander keeps the
 * partials from sounding machine-locked.
 *
 * flute: sine-dominant, weak even harmonics, purer the higher it plays,
 *   soft attack (75 .. 30 ms), vibrato of about 5 Hz after 220 ms.
 * dizi: all harmonics present plus the buzz of the dimo membrane — a broad
 *   resonance near 3.6 kHz that grows with blowing pressure and flutters
 *   slightly — more breath, a tongued attack (35 .. 12 ms) with a quick
 *   rise into the pitch, faster and deeper vibrato. NoteEvent.bend slides
 *   into the note (both instruments).
 */
import type { VoiceId } from "../../../music/score";
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
import type { AttackShape } from "../../dsp";
import {
  CENT,
  SEMITONE,
  bandpassNoisePower,
  guardGain,
  onset,
} from "../../dsp/extra-sustained";

interface WindConfig {
  id: VoiceId;
  maxHarmonics: number;
  /** amplitude of harmonic k (k >= 2) at `hz` relative to the fundamental */
  harmonic(k: number, hz: number, f0: number, vel: number): number;
  /** attack seconds at vel 0 and at vel 1 */
  attack: [soft: number, hard: number];
  attackShape: AttackShape;
  release: number;
  /** breath RMS relative to the tone: while held (at vel 1 / at vel 0) and extra at the attack */
  breath: [hard: number, soft: number];
  chiff: number;
  /** time constant of the attack breath, seconds */
  chiffTime: number;
  /** centre of the breath band for this note, Hz, and its q */
  breathHz(f0: number): number;
  breathQ: number;
  /** vibrato: seconds before it starts, fade-in, rate (Hz), pitch depth (cents), amplitude depth */
  vibrato: {
    delay: number;
    fade: number;
    rate: number;
    cents: number;
    amplitude: number;
  };
  /** semitones below the note at the tongued start (scaled by velocity) and how long the rise takes */
  rise: number;
  riseTime: number;
  /** flutter of the harmonics from `buzzFrom` up (dizi membrane), 0 = none */
  buzz: number;
  buzzFrom: number;
  /** share of a period the energy of one cycle is spread over (0 = one spike per cycle) */
  spread: number;
  /** trim of the predicted level (the attack is part of the loudest 400 ms) */
  trim: number;
}

const FLUTE: WindConfig = {
  id: "flute",
  maxHarmonics: 10,
  harmonic(k, _hz, f0, vel) {
    // rolls off faster the higher the note; louder = brighter; even harmonics weak
    const slope = clamp(
      2 + 0.75 * Math.log2(f0 / 440) - 2 * (vel - 0.7),
      1.1,
      3.4,
    );
    return Math.pow(k, -slope) * (k % 2 === 0 ? 0.5 : 1);
  },
  attack: [0.075, 0.03],
  attackShape: "cos",
  release: 0.11,
  breath: [0.035, 0.07],
  chiff: 0.28,
  chiffTime: 0.035,
  breathHz: (f0) => clamp(2.5 * f0, 1800, 5000),
  breathQ: 1.3,
  vibrato: { delay: 0.22, fade: 0.35, rate: 5, cents: 9, amplitude: 0.12 },
  rise: 0.12,
  riseTime: 0.03,
  buzz: 0,
  buzzFrom: 99,
  spread: 0.5,
  trim: 1,
};

const DIZI: WindConfig = {
  id: "dizi",
  maxHarmonics: 22,
  harmonic(k, hz, f0, vel) {
    const slope = clamp(
      1.5 + 0.45 * Math.log2(f0 / 660) - 0.7 * (vel - 0.7),
      1,
      2.6,
    );
    // dimo membrane: a broad resonance that grows with blowing pressure
    const octaves = Math.log2(hz / 3600) / 0.6;
    // (its energy is shared by the harmonics inside it: fewer per harmonic on low notes)
    const membrane =
      (0.6 + 2.7 * Math.pow(vel, 1.5)) *
      Math.min(1, Math.sqrt(f0 / 500)) *
      Math.exp(-0.5 * octaves * octaves);
    return Math.pow(k, -slope) * (1 + membrane);
  },
  attack: [0.035, 0.012],
  attackShape: "exp",
  release: 0.075,
  breath: [0.06, 0.11],
  chiff: 0.4,
  chiffTime: 0.025,
  breathHz: (f0) => clamp(3 * f0, 2600, 6500),
  breathQ: 0.9,
  vibrato: { delay: 0.14, fade: 0.22, rate: 5.8, cents: 14, amplitude: 0.1 },
  rise: 0.45,
  riseTime: 0.022,
  buzz: 0.18,
  buzzFrom: 4,
  spread: 0.55,
  trim: 0.95,
};

const MAX_K = 24;
const CONTROL = 16;
const base = new Float64Array(MAX_K + 1);
/** per-harmonic gains of the sin and cos series (amplitude x phase) */
const gainSin = new Float64Array(MAX_K + 1);
const gainCos = new Float64Array(MAX_K + 1);
const phaseCos = new Float64Array(MAX_K + 1);
const phaseSin = new Float64Array(MAX_K + 1);
/** log2(k): the breath tilts the spectrum by a number of dB per octave */
const OCTAVE = Float64Array.from({ length: MAX_K + 1 }, (_, k) =>
  k > 0 ? Math.log2(k) : 0,
);

function wind(config: WindConfig): Voice {
  return {
    id: config.id,
    tail: () => config.release + 0.02,
    render(left, right, frames, note, ctx) {
      const sr = ctx.sampleRate;
      const random = forkRng(ctx.random);
      const vel = clamp(note.vel, 0.02, 1);
      const f0 = clamp(midiToHz(note.midi), 12, sr * 0.2);
      const vib = config.vibrato;

      // --- harmonics that fit below Nyquist at the highest pitch of the note ---
      const bendPeak = note.bend && note.bend > 0 ? note.bend : 0;
      const highest =
        f0 * Math.exp(bendPeak * SEMITONE) * (1 + 2 * vib.cents * CENT);
      const count = Math.max(
        1,
        Math.min(config.maxHarmonics, Math.floor((sr * 0.45) / highest)),
      );
      base[1] = 1;
      let tonePower = 0.5;
      for (let k = 2; k <= count; k++) {
        base[k] = config.harmonic(k, k * f0, f0, vel);
        tonePower += 0.5 * base[k] * base[k];
      }
      // Schroeder's rule: delay each harmonic by the share of the power
      // below it, so the energy of a cycle is spread evenly over `spread`
      // of the period whatever the spectrum looks like
      let below = 0;
      let phi = 0;
      for (let k = 2; k <= count; k++) {
        below += (0.5 * base[k - 1] * base[k - 1]) / tonePower;
        phi -= 2 * Math.PI * config.spread * below;
        phaseCos[k] = Math.cos(phi);
        phaseSin[k] = Math.sin(phi);
      }
      const buzzFrom = Math.min(config.buzzFrom, count + 1);

      // --- breath: relative to the tone, more of it on soft notes ---
      const breathHz = Math.min(config.breathHz(f0), sr * 0.4);
      const held =
        config.breath[1] + (config.breath[0] - config.breath[1]) * vel;
      const chiff = config.chiff * (0.5 + 0.5 * vel);
      const toneRms = Math.sqrt(tonePower);
      // band-passed uniform noise, pulsed by (1 + 0.5 sin): mean square x 1.125
      const bandRms = Math.sqrt(
        (bandpassNoisePower(breathHz, config.breathQ, sr) / 3) * 1.125,
      );
      const breathGain = toneRms / bandRms;
      const gain =
        (REFERENCE_RMS * velocityGain(vel) * config.trim) /
        (toneRms * Math.sqrt(1 + held * held));

      // --- envelope ---
      const l = scratch(1, frames);
      const r = scratch(2, frames);
      const env = scratch(0, frames);
      const attack =
        config.attack[0] + (config.attack[1] - config.attack[0]) * vel;
      new Adsr(sr, {
        attack,
        decay: 0.1,
        sustain: 1,
        release: config.release,
        attackShape: config.attackShape,
      }).render(env, frames, noteOffFrame(note, frames, sr, 0.008));

      // --- modulation sources ---
      const vibPhase = random();
      const vibRate = (vib.rate * (0.95 + 0.1 * random())) / sr;
      const vibScale = 0.6 + 0.4 * vel;
      const wander1 = random();
      const wander2 = random();
      const rise = -config.rise * vel;
      const noiseLeft = new WhiteNoise(random);
      const noiseRight = new WhiteNoise(random);
      const flutter = new WhiteNoise(random);
      // breath band-pass (TPT SVF, same coefficients both channels)
      const g = Math.tan((Math.PI * breathHz) / sr);
      const kq = 1 / config.breathQ;
      const a1 = 1 / (1 + g * (g + kq));
      const a2 = g * a1;
      const a3 = g * a2;
      let l1 = 0;
      let l2 = 0;
      let r1 = 0;
      let r2 = 0;
      // flutter of the membrane: noise smoothed to a few hundred Hz
      const flutterCoef = 1 - Math.exp((-2 * Math.PI * 260) / sr);
      const flutterGain = config.buzz * 6;
      let flutterState = 0;

      const baseInc = f0 / sr;
      let inc = baseInc;
      let phase = 0;
      let breathLevel = 0;
      let swell = 1;
      const settleTime = Math.max(BEND_TIME, config.riseTime);
      for (let i = 0; i < frames; i++) {
        if ((i & (CONTROL - 1)) === 0) {
          const t = i / sr;
          // pitch: bend, tongued rise, wander, vibrato
          let semis = 0;
          if (t < settleTime) {
            semis = bendOffset(note.bend, t);
            if (t < config.riseTime) {
              const x = 1 - t / config.riseTime;
              semis += rise * x * x;
            }
          }
          const depth = vibScale * onset(t, vib.delay, vib.fade);
          const lfo = sinTurns(vibPhase + vibRate * i);
          const cents =
            depth * vib.cents * lfo +
            1.6 * sinTurns(wander1 + (0.83 * i) / sr) +
            1.1 * sinTurns(wander2 + (2.17 * i) / sr);
          inc = Math.min(
            0.24,
            baseInc *
              (semis !== 0 ? Math.exp(semis * SEMITONE) : 1) *
              (1 + cents * CENT),
          );
          // the breath builds the spectrum: upper harmonics follow the envelope,
          // overshoot a little at the start and swell with the vibrato
          const e = env[i];
          const bite = 1 + 0.2 * Math.exp(-t / 0.06);
          const tilt = Math.log(
            (0.5 + 0.5 * e) * bite * (1 + depth * vib.amplitude * lfo),
          );
          for (let k = 2; k <= count; k++) {
            const a = base[k] * Math.exp(OCTAVE[k] * tilt);
            gainSin[k] = a * phaseCos[k];
            gainCos[k] = a * phaseSin[k];
          }
          swell = 1 + depth * vib.amplitude * lfo;
          breathLevel =
            breathGain *
            (held * (0.4 + 0.6 * e) + chiff * Math.exp(-t / config.chiffTime));
        }
        // tone
        const s1 = sinPhase(phase);
        let quarter = phase + 0.25;
        if (quarter >= 1) quarter -= 1;
        const twoCos = 2 * sinPhase(quarter);
        phase += inc;
        if (phase >= 1) phase -= 1;
        let sinPrevious = 0;
        let sinCurrent = s1;
        let cosPrevious = 1;
        let cosCurrent = 0.5 * twoCos;
        let tone = s1;
        for (let k = 2; k < buzzFrom; k++) {
          const sinNext = twoCos * sinCurrent - sinPrevious;
          const cosNext = twoCos * cosCurrent - cosPrevious;
          sinPrevious = sinCurrent;
          sinCurrent = sinNext;
          cosPrevious = cosCurrent;
          cosCurrent = cosNext;
          tone += gainSin[k] * sinNext + gainCos[k] * cosNext;
        }
        if (buzzFrom <= count) {
          let upper = 0;
          for (let k = buzzFrom; k <= count; k++) {
            const sinNext = twoCos * sinCurrent - sinPrevious;
            const cosNext = twoCos * cosCurrent - cosPrevious;
            sinPrevious = sinCurrent;
            sinCurrent = sinNext;
            cosPrevious = cosCurrent;
            cosCurrent = cosNext;
            upper += gainSin[k] * sinNext + gainCos[k] * cosNext;
          }
          flutterState += flutterCoef * (flutter.next() - flutterState);
          tone += upper * (1 + flutterGain * flutterState);
        }
        // breath, pulsed at the pitch of the note
        const pulse = breathLevel * (1 + 0.5 * s1);
        let v3 = noiseLeft.next() - l2;
        let v1 = a1 * l1 + a2 * v3;
        let v2 = l2 + a2 * l1 + a3 * v3;
        l1 = 2 * v1 - l1;
        l2 = 2 * v2 - l2;
        const airLeft = v1 * kq * pulse;
        v3 = noiseRight.next() - r2;
        v1 = a1 * r1 + a2 * v3;
        v2 = r2 + a2 * r1 + a3 * v3;
        r1 = 2 * v1 - r1;
        r2 = 2 * v2 - r2;
        const airRight = v1 * kq * pulse;
        // the breath leads the tone: it is fully there at a quarter of the envelope
        const e = env[i];
        const body = tone * swell * e;
        const air = e < 0.25 ? 4 * e : 1;
        l[i] = body + airLeft * air;
        r[i] = body + airRight * air;
      }
      const out = guardGain(l, r, frames, gain);
      for (let i = 0; i < frames; i++) {
        left[i] += l[i] * out;
        right[i] += r[i] * out;
      }
    },
  };
}

export const flute = wind(FLUTE);
export const dizi = wind(DIZI);
