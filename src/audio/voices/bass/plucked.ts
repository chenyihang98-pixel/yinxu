/**
 * fingerBass and uprightBass — two plucked bass strings from one engine.
 *
 * The string is the extended Karplus-Strong loop of the toolbox: plucked by a
 * soft, wide pulse (a fingertip, harder and brighter with velocity) whose
 * energy is first smeared in time by a few allpasses, so a low E is a round
 * wave instead of one spike per cycle. Upper partials die much faster than
 * the fundamental. What follows the string makes the instrument:
 *
 * fingerBass (electric): a magnetic pickup a sixth of the way up the string
 *   (a comb), the roll-off of a bass amp with round low mids, a few
 *   milliseconds of finger noise at the attack, long sustain, and a finger
 *   that stops the string at note-off — tight enough for eighth-note lines.
 * uprightBass (jazz pizzicato): a fat pluck over the end of the fingerboard,
 *   a wooden body (air and top resonances, a low-passed top), a knock of the
 *   body itself under the attack, upper partials gone within half a second
 *   while the fundamental sings on, and the slight sharpness of a hard pluck
 *   that settles within about 100 ms.
 *
 * Both are mono. NoteEvent.bend slides into the note. The level is predicted
 * from the harmonic amplitudes (pluck x pickup x tone x decay).
 */
import type { VoiceId } from "../../../music/score";
import type { Voice } from "../types";
import {
  BEND_TIME,
  Biquad,
  KarplusString,
  LEVEL_WINDOW,
  LN_60DB,
  OnePoleLP,
  REFERENCE_RMS,
  TAU,
  WhiteNoise,
  bendOffset,
  clamp,
  forkRng,
  midiToHz,
  noteOffFrame,
  pluckLength,
  pluckSpectrum,
  scratch,
  velocityGain,
} from "../../dsp";
import type { PluckOptions, Random } from "../../dsp";
import { ResponseTable, SEMITONE } from "../../dsp/extra-sustained";

interface StringBassConfig {
  id: VoiceId;
  tail: number;
  /** T60 of the fundamental, T60 at `highHz`, and that frequency */
  ring(f0: number): [t60: number, t60High: number, highHz: number];
  /** the pluck for this note (position along the string, tilt, finger hardness) */
  pluck(
    f0: number,
    vel: number,
    random: Random,
  ): Pick<PluckOptions, "position" | "bodyHz" | "hardnessHz">;
  /**
   * corner (Hz) of a one-pole low-pass that follows the note: it turns the
   * velocity-like spectrum of the loop into the rounder one of a string's
   * displacement, which is what keeps the fundamental the strongest partial
   */
  round(f0: number, vel: number): number;
  /** pickup comb y = s - mix · s[n - position · period]; mix 0 = none */
  pickup: [position: number, mix: number];
  /** everything after the string: amp or body */
  tone(sampleRate: number): Biquad[];
  /** T60 of the fundamental / at 1 kHz once the note is stopped */
  damp(f0: number): [t60: number, t60High: number];
  /** cents sharp at the pluck (at vel 1) and the time constant of the settle; 0 = none */
  settle: [cents: number, tau: number];
  /**
   * attack noise: resonances it rings (Hz, q, weight), the decay of the
   * burst that excites them, seconds until they have rung out, and its peak
   * against the string's
   */
  knock: {
    modes: readonly [hz: number, q: number, weight: number][];
    decay: number;
    length: number;
    level(vel: number): number;
  };
}

const FINGER: StringBassConfig = {
  id: "fingerBass",
  tail: 0.16,
  ring: (f0) => [16 * Math.pow(55 / f0, 0.5), 0.6, 2000],
  pluck: (f0, vel, random) => ({
    position: 0.36 + 0.04 * random(),
    bodyHz: 1.2 * f0 + 50 + 240 * vel * vel,
    hardnessHz: 520 + 1500 * Math.pow(vel, 1.5),
  }),
  round: (f0, vel) => 1.5 * f0 * (0.75 + 0.6 * vel),
  pickup: [0.17, 0.15],
  tone: (sr) => [
    new Biquad().setHighpass(24, 0.7, sr),
    new Biquad().setPeak(200, 0.8, 2, sr),
    new Biquad().setPeak(750, 1.1, -2, sr),
    new Biquad().setLowpass(2100, 0.7, sr),
  ],
  damp: (f0) => [0.1 * Math.pow(55 / f0, 0.2), 0.03],
  settle: [0, 0.04],
  knock: {
    modes: [
      [1500, 1.1, 1],
      [2900, 1.4, 0.5],
    ],
    decay: 0.005,
    length: 0.03,
    level: (vel) => 0.1 + 0.1 * vel,
  },
};

const UPRIGHT: StringBassConfig = {
  id: "uprightBass",
  tail: 0.22,
  ring: (f0) => [5.5 * Math.pow(55 / f0, 0.45), 0.45, 1000],
  pluck: (f0, vel, random) => ({
    position: 0.34 + 0.05 * random(),
    bodyHz: 0.9 * f0 + 40 + 420 * vel * vel,
    hardnessHz: 500 + 1300 * Math.pow(vel, 1.5),
  }),
  round: (f0, vel) => 1.3 * f0 * (0.7 + 0.7 * vel),
  pickup: [0, 0],
  tone: (sr) => [
    new Biquad().setHighpass(24, 0.7, sr),
    new Biquad().setPeak(105, 3, 2.5, sr),
    new Biquad().setPeak(205, 2.5, 3, sr),
    new Biquad().setPeak(820, 1.4, 2.5, sr),
    new Biquad().setLowpass(1900, 0.6, sr),
  ],
  damp: (f0) => [0.16 * Math.pow(55 / f0, 0.2), 0.04],
  settle: [30, 0.045],
  knock: {
    modes: [
      [108, 3.5, 1],
      [215, 4.5, 0.9],
      [430, 4, 0.55],
      [900, 2.2, 0.4],
    ],
    decay: 0.004,
    length: 0.09,
    level: (vel) => 0.2 + 0.15 * vel,
  },
};

const LOWEST_HZ = 15;
/** partials counted for the level: above them rounding and tone leave nothing */
const MAX_HARMONICS = 48;
const TOP_HZ = 2800;
const SMEAR_TAIL = 1024;
/** allpass centre frequencies / q that spread each cycle of the pluck in time */
const SMEAR: readonly [hz: number, q: number][] = [
  [75, 0.7],
  [170, 1],
  [390, 1.2],
  [900, 1],
];
const CONTROL = 8;

/**
 * The noise-free excitation of makePluck() — a Hann pulse through the tilt
 * low-pass and the pluck-position comb — written directly. makePluck()
 * convolves, which costs a cosine per tap and sample: nothing for a guitar,
 * a fifth of a millisecond for the long period of a bass string.
 * pluckSpectrum() describes this excitation exactly. Returns its length.
 */
export function softPluck(out: Float32Array, options: PluckOptions): number {
  const sr = options.sampleRate;
  const length = Math.min(out.length, pluckLength(options));
  const width = clamp(Math.round(sr / options.hardnessHz), 4, 96);
  out.fill(0, 0, length);
  for (let j = 1; j < width && j < length; j++)
    out[j] = (1 - Math.cos((TAU * j) / width)) / width;
  const tilt = 1 - Math.exp((-TAU * clamp(options.bodyHz, 10, sr * 0.45)) / sr);
  let y = 0;
  for (let i = 0; i < length; i++) {
    y += tilt * (out[i] - y);
    out[i] = y;
  }
  const comb = Math.max(1, Math.round(options.position * options.period));
  for (let i = length - 1; i >= comb; i--) out[i] -= out[i - comb];
  const fade = Math.min(64, length >> 1);
  for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade;
  return length;
}

interface Rig {
  string: KarplusString;
  smear: Biquad[];
  round: OnePoleLP;
  tone: Biquad[];
  table: ResponseTable;
  knock: Biquad[];
}

function stringBass(config: StringBassConfig): Voice {
  const rigs = new Map<number, Rig>();
  const rigFor = (sr: number): Rig => {
    let rig = rigs.get(sr);
    if (rig) return rig;
    const tone = config.tone(sr);
    rig = {
      string: new KarplusString(sr, LOWEST_HZ),
      smear: SMEAR.map(([hz, q]) => new Biquad().setAllpass(hz, q, sr)),
      round: new OnePoleLP(),
      tone,
      table: new ResponseTable(tone, sr),
      knock: config.knock.modes.map(([hz, q]) =>
        new Biquad().setBandpass(hz, q, sr),
      ),
    };
    rigs.set(sr, rig);
    return rig;
  };

  return {
    id: config.id,
    tail: () => config.tail,
    render(left, right, frames, note, ctx) {
      const sr = ctx.sampleRate;
      const rig = rigFor(sr);
      const string = rig.string;
      const random = forkRng(ctx.random);
      const vel = clamp(note.vel, 0.02, 1);
      const f0 = clamp(midiToHz(note.midi), LOWEST_HZ * 1.1, sr / 5);

      // --- string ---
      string.reset();
      string.setDispersion(0, 0);
      string.setFrequency(f0);
      const [t60, t60High, highHz] = config.ring(f0);
      string.setDecay(t60 * (0.95 + 0.1 * random()), t60High, highHz);
      const period = string.period;

      // --- pluck, smeared in time ---
      const pluck: PluckOptions = {
        sampleRate: sr,
        period,
        noise: 0,
        ...config.pluck(f0, vel, random),
      };
      const excitationLength = pluckLength(pluck) + SMEAR_TAIL;
      const excitation = scratch(3, excitationLength);
      softPluck(excitation, pluck);
      for (const allpass of rig.smear) {
        allpass.reset();
        allpass.process(excitation, excitationLength);
      }
      for (let i = 0; i < 128; i++)
        excitation[excitationLength - 1 - i] *= i / 128;
      string.excite(excitation, excitationLength);

      // --- level: harmonics through rounding, pickup and tone, averaged over the first 400 ms ---
      rig.round.setCutoff(Math.min(config.round(f0, vel), sr * 0.4), sr);
      rig.round.reset();
      const [pickupPosition, pickupMix] = config.pickup;
      const pickupDelay = Math.max(1, Math.round(pickupPosition * period));
      const harmonics = Math.max(
        1,
        Math.min(
          MAX_HARMONICS,
          Math.floor(TOP_HZ / f0),
          Math.floor((sr * 0.45) / f0),
        ),
      );
      let power = 0;
      let startPower = 0;
      for (let k = 1; k <= harmonics; k++) {
        const hz = k * f0;
        let a =
          (2 / period) *
          pluckSpectrum(hz, pluck) *
          rig.round.magnitude(hz, sr) *
          rig.table.gain(hz);
        if (pickupMix > 0)
          a *= Math.sqrt(
            1 +
              pickupMix * pickupMix -
              2 * pickupMix * Math.cos(((TAU * hz) / sr) * pickupDelay),
          );
        const x = (2 * LN_60DB * LEVEL_WINDOW) / string.t60At(hz);
        const average = x < 1e-6 ? 1 : (1 - Math.exp(-x)) / x;
        startPower += 0.5 * a * a;
        power += 0.5 * a * a * average;
      }
      const gain = (REFERENCE_RMS * velocityGain(vel)) / Math.sqrt(power);

      // --- string output: held, then stopped by the hand ---
      const hold = noteOffFrame(note, frames, sr, 0.03);
      const raw = scratch(0, frames);
      const stop = () => {
        const [stopped, stoppedHigh] = config.damp(f0);
        string.setDecay(stopped, stoppedHigh, 1000);
      };
      const sharp = (config.settle[0] / 100) * vel * vel;
      const settleTau = config.settle[1];
      const glide = Math.ceil(
        Math.max(note.bend ? BEND_TIME : 0, sharp > 0 ? 7 * settleTau : 0) * sr,
      );
      if (glide > 0) {
        const floor = Math.exp(-7);
        let ratio = 1;
        for (let i = 0; i < frames; i++) {
          if (i === hold) stop();
          if (i < glide) {
            if ((i & (CONTROL - 1)) === 0) {
              const t = i / sr;
              const semis =
                bendOffset(note.bend, t) +
                (sharp * Math.max(0, Math.exp(-t / settleTau) - floor)) /
                  (1 - floor);
              ratio = Math.min(1.9, Math.exp(semis * SEMITONE));
            }
          } else ratio = 1;
          raw[i] = string.nextBent(ratio);
        }
      } else {
        string.process(raw, 0, hold);
        stop();
        string.process(raw, hold, frames - hold);
      }

      // --- rounding, pickup, then amp / body ---
      rig.round.process(raw, frames);
      if (pickupMix > 0)
        for (let i = frames - 1; i >= pickupDelay; i--)
          raw[i] -= pickupMix * raw[i - pickupDelay];
      for (const filter of rig.tone) {
        filter.reset();
        filter.process(raw, frames);
      }

      // --- attack noise: a burst ringing the knock resonances ---
      const knockFrames = Math.min(frames, Math.ceil(config.knock.length * sr));
      const burst = scratch(1, knockFrames);
      const ring = scratch(2, knockFrames);
      const knock = scratch(4, knockFrames);
      const noise = new WhiteNoise(random);
      const burstCoef = Math.exp(-1 / (config.knock.decay * sr));
      let level = 1;
      for (let i = 0; i < knockFrames && level > 1e-4; i++) {
        burst[i] = noise.next() * level * Math.min(1, i / 12);
        level *= burstCoef;
      }
      for (let m = 0; m < rig.knock.length; m++) {
        const filter = rig.knock[m];
        const weight = config.knock.modes[m][2];
        for (let i = 0; i < knockFrames; i++) ring[i] = burst[i];
        filter.reset();
        filter.process(ring, knockFrames);
        for (let i = 0; i < knockFrames; i++) knock[i] += weight * ring[i];
      }
      let knockPeak = 0;
      for (let i = 0; i < knockFrames; i++) {
        const a = Math.abs(knock[i]);
        if (a > knockPeak) knockPeak = a;
      }
      // its peak against the peak of a sine as strong as the string at the pluck
      const knockGain =
        knockPeak > 0
          ? (config.knock.level(vel) * Math.sqrt(2 * startPower)) / knockPeak
          : 0;
      // fade the knock buffer out so it ends on zero
      const knockFade = Math.min(knockFrames, 256);
      for (let i = 0; i < knockFade; i++)
        knock[knockFrames - 1 - i] *= i / knockFade;
      for (let i = 0; i < knockFrames; i++) raw[i] += knockGain * knock[i];

      // --- out: ceiling guard, fade to silence ---
      let peak = 0;
      for (let i = 0; i < frames; i++) {
        const a = Math.abs(raw[i]);
        if (a > peak) peak = a;
      }
      const out = peak * gain > 0.98 ? 0.98 / peak : gain;
      const fade = Math.min(frames, Math.max(32, Math.round(0.015 * sr)));
      const fadeStart = frames - fade;
      for (let i = 0; i < fadeStart; i++) {
        const v = raw[i] * out;
        left[i] += v;
        right[i] += v;
      }
      for (let i = fadeStart; i < frames; i++) {
        const v =
          raw[i] *
          out *
          (0.5 + 0.5 * Math.cos((Math.PI * (i - fadeStart + 1)) / fade));
        left[i] += v;
        right[i] += v;
      }
    },
  };
}

export const fingerBass = stringBass(FINGER);
export const uprightBass = stringBass(UPRIGHT);
