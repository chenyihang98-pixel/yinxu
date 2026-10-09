/**
 * Plucked acoustic strings: guitar (steel), nylon (classical), guzheng and
 * pizzicato share one physical model and differ only in the numbers a
 * luthier would change: string material (ring times, stiffness), where and
 * with what the string is plucked, the resonances of the body, and what
 * happens at note-off.
 *
 * The model (see `guitar`, the calibrated exemplar of the group):
 *  - an extended Karplus-Strong string, plucked by a smooth pulse plus a
 *    little noise at a chosen point of its length (pick-position comb),
 *    harder and brighter with velocity;
 *  - the pluck passes a chain of allpasses first (the phase smear of a real
 *    body): same spectrum, but the energy of each cycle is spread out instead
 *    of stacked into one spike, which keeps peaks under control;
 *  - two "microphones" (comb taps at different points of the string) and a
 *    body EQ whose plate modes differ slightly left and right: gentle,
 *    mono-safe stereo;
 *  - at note-off the string is damped (a finger landing on it) or, for
 *    instruments nobody damps, left to ring out a little faster;
 *  - NoteEvent.bend slides into the note by resampling the string output,
 *    so tuning and brightness of the loop stay exact.
 * The level is predicted from the harmonic amplitudes (excitation × taps ×
 * body × decay), so every fret meets the -18 dBFS convention.
 */
import type { VoiceId } from "../../../music/score";
import type { Voice, VoiceNote } from "../types";
import {
  BEND_TIME,
  Biquad,
  biquadChain,
  KarplusString,
  LEVEL_WINDOW,
  LN_60DB,
  ModalBank,
  REFERENCE_RMS,
  TAU,
  bendOffset,
  clamp,
  clamp01,
  forkRng,
  makePluck,
  midiToHz,
  noteOffFrame,
  pluckLength,
  pluckSpectrum,
  scratch,
  velocityGain,
} from "../../dsp";
import type { PluckOptions } from "../../dsp";
import { velocityCeiling } from "../../dsp/extra-keys";

const BODY_POINTS = 240;
const BODY_LOW_HZ = 40;
const BODY_OCTAVES = 9.2;
const SMEAR_TAIL = 640;

interface BodyFilters {
  /** filters both channels share (run once, on the string signal) */
  shared: Biquad[];
  /** plate modes, different per channel */
  left: Biquad[];
  right: Biquad[];
}

interface StringModel {
  id: VoiceId;
  /** the delay line is sized for this; lower notes are clamped in pitch */
  lowestHz: number;
  /** T60 in seconds of the fundamental while the note is held */
  ring(f0: number, midi: number): number;
  /** T60 in seconds at 4 kHz while the note is held */
  ringHigh(midi: number): number;
  /** stiffness: allpass coefficient and number of sections */
  dispersion: readonly [coef: number, sections: number];
  /** pluck point as a share of the string: base + spread × random */
  position: readonly [base: number, spread: number];
  /** corner of the excitation tilt (overall brightness) */
  bodyHz(f0: number, vel: number): number;
  /**
   * -6 dB point of the plectrum / fingertip. Keep it above the fundamental:
   * a pulse wider than the period is a thump under the note, not a pluck.
   */
  hardnessHz(vel: number, f0: number): number;
  /** share of the pluck energy that is noise (note-to-note variation) */
  noise: number;
  /** allpass centre frequencies / q of the body phase smear */
  smear: readonly (readonly [hz: number, q: number])[];
  body(sampleRate: number): BodyFilters;
  /** second pickup point per channel as a share of the period, and its level */
  taps: readonly [left: number, right: number, mix: number];
  /** [T60, T60 at 4 kHz] once the note is released */
  damp(f0: number, midi: number): readonly [t60: number, t60High: number];
  tail(note: VoiceNote): number;
  /**
   * Pitch settle of a hard pluck: the string starts this many cents sharp
   * (tension rises while the amplitude is large) and relaxes with time
   * constant `tau` seconds.
   */
  settle?: { cents(vel: number): number; tau: number };
  /**
   * Cap the peak at velocityCeiling(vel). A ring shorter than the level
   * window would need more peak than exists to read -18 dBFS; capped by the
   * velocity law such notes are as loud as they can be and a harder pluck is
   * still louder. Without it only the hard |0.98| guard applies.
   */
  peakLimited?: boolean;
  /** body knock: fixed modes [hz, T60, level relative to the string] rung by the pluck itself */
  knock?: readonly (readonly [hz: number, t60: number, level: number])[];
}

interface StringRig extends BodyFilters {
  string: KarplusString;
  smear: Biquad[];
  /** |body EQ| on a log-frequency grid, per channel */
  bodyLeft: Float32Array;
  bodyRight: Float32Array;
}

function buildRig(model: StringModel, sampleRate: number): StringRig {
  const { shared, left, right } = model.body(sampleRate);
  const table = (plates: Biquad[]) => {
    const filters = [...shared, ...plates];
    const response = new Float32Array(BODY_POINTS + 1);
    for (let i = 0; i <= BODY_POINTS; i++) {
      const hz = BODY_LOW_HZ * Math.pow(2, (i / BODY_POINTS) * BODY_OCTAVES);
      let gain = 1;
      for (const filter of filters)
        gain *= filter.magnitude(Math.min(hz, sampleRate * 0.499), sampleRate);
      response[i] = gain;
    }
    return response;
  };
  return {
    string: new KarplusString(sampleRate, model.lowestHz),
    smear: model.smear.map(([hz, q]) =>
      new Biquad().setAllpass(hz, q, sampleRate),
    ),
    shared,
    left,
    right,
    bodyLeft: table(left),
    bodyRight: table(right),
  };
}

function bodyGain(table: Float32Array, hz: number): number {
  const position = clamp(
    (Math.log2(hz / BODY_LOW_HZ) / BODY_OCTAVES) * BODY_POINTS,
    0,
    BODY_POINTS - 1e-6,
  );
  const index = position | 0;
  return table[index] + (table[index + 1] - table[index]) * (position - index);
}

const KNOCK_MODES = 6;
const knockBank = new ModalBank(KNOCK_MODES);

function stringVoice(model: StringModel): Voice {
  const rigs = new Map<number, StringRig>();
  const [tapShareLeft, tapShareRight, micMix] = model.taps;
  return {
    id: model.id,
    tail: (note) => model.tail(note),
    render(left, right, frames, note, ctx) {
      const sr = ctx.sampleRate;
      let rig = rigs.get(sr);
      if (!rig) {
        rig = buildRig(model, sr);
        rigs.set(sr, rig);
      }
      const string = rig.string;
      const random = forkRng(ctx.random);
      const vel = clamp(note.vel, 0.02, 1);
      const f0 = clamp(midiToHz(note.midi), model.lowestHz * 1.02, sr / 5);
      const midi = note.midi;

      // --- string ---
      string.reset();
      string.setFrequency(f0);
      string.setDispersion(model.dispersion[0], model.dispersion[1]);
      const ring = model.ring(f0, midi) * (0.94 + 0.12 * random());
      string.setDecay(ring, model.ringHigh(midi), 4000);

      // --- pluck ---
      const pluck: PluckOptions = {
        sampleRate: sr,
        period: string.period,
        position: model.position[0] + model.position[1] * random(),
        bodyHz: model.bodyHz(f0, vel),
        hardnessHz: model.hardnessHz(vel, f0),
        noise: model.noise,
      };
      const excitationLength = pluckLength(pluck) + SMEAR_TAIL;
      const excitation = scratch(3, excitationLength);
      makePluck(excitation, pluck, random);
      biquadChain(rig.smear, excitation, excitationLength);
      for (let i = 0; i < 128; i++)
        excitation[excitationLength - 1 - i] *= i / 128;
      string.excite(excitation, excitationLength);

      // --- level: RMS of the first 400 ms predicted from the harmonics ---
      const period = string.period;
      const tapLeft = Math.max(1, Math.round(tapShareLeft * period));
      const tapRight = Math.max(1, Math.round(tapShareRight * period));
      const harmonics = Math.min(64, Math.floor((sr * 0.45) / f0));
      let power = 0;
      let startPower = 0;
      for (let k = 1; k <= harmonics; k++) {
        const hz = k * f0;
        const w = (TAU * hz) / sr;
        const amp = (2 / period) * pluckSpectrum(hz, pluck);
        const micL = Math.sqrt(
          1 + micMix * micMix + 2 * micMix * Math.cos(w * tapLeft),
        );
        const micR = Math.sqrt(
          1 + micMix * micMix + 2 * micMix * Math.cos(w * tapRight),
        );
        const l = amp * micL * bodyGain(rig.bodyLeft, hz);
        const r = amp * micR * bodyGain(rig.bodyRight, hz);
        const x = (2 * LN_60DB * LEVEL_WINDOW) / string.t60At(hz);
        const average = x < 1e-6 ? 1 : (1 - Math.exp(-x)) / x;
        power += 0.25 * (l * l + r * r) * average;
        startPower += 0.25 * (l * l + r * r);
      }
      const gain = (REFERENCE_RMS * velocityGain(vel)) / Math.sqrt(power);

      // --- string output: held, then damped ---
      const hold = noteOffFrame(note, frames, sr, 0.03);
      const raw = scratch(0, frames);
      const damp = () => {
        const [t60, t60High] = model.damp(f0, midi);
        string.setDecay(Math.min(t60, ring), t60High, 4000);
      };
      const settle = model.settle;
      if (note.bend || settle) {
        const settleSemitones = settle ? settle.cents(vel) / 100 : 0;
        const settleRate = settle ? 1 / settle.tau : 0;
        const glideFrames = Math.ceil(
          Math.max(note.bend ? BEND_TIME : 0, settle ? settle.tau * 7 : 0) * sr,
        );
        for (let i = 0; i < frames; i++) {
          if (i === hold) damp();
          let ratio = 1;
          if (i < glideFrames) {
            const t = i / sr;
            ratio = Math.pow(
              2,
              (bendOffset(note.bend, t) +
                settleSemitones * Math.exp(-t * settleRate)) /
                12,
            );
          }
          raw[i] = string.nextBent(ratio);
        }
      } else {
        string.process(raw, 0, hold);
        damp();
        string.process(raw, hold, frames - hold);
      }

      // --- body, two microphones ---
      biquadChain(rig.shared, raw, frames);
      const l = scratch(1, frames);
      const r = scratch(2, frames);
      for (let i = 0; i < frames; i++) {
        const s = raw[i];
        l[i] = s + (i >= tapLeft ? micMix * raw[i - tapLeft] : 0);
        r[i] = s + (i >= tapRight ? micMix * raw[i - tapRight] : 0);
      }
      biquadChain(rig.left, l, frames);
      biquadChain(rig.right, r, frames);

      // --- the body's own knock, rung by the pluck ---
      if (model.knock) {
        const strength = Math.sqrt(startPower) * (0.5 + 0.5 * vel);
        const modes = Math.min(KNOCK_MODES, model.knock.length);
        for (let k = 0; k < modes; k++) {
          const [hz, t60, level] = model.knock[k];
          knockBank.set(k, hz, t60, level * strength, sr);
        }
        knockBank.count = modes;
        knockBank.strike();
        const knock = scratch(4, frames);
        const length = Math.min(frames, Math.ceil(0.25 * sr));
        knockBank.render(knock, 0, length);
        for (let i = 0; i < length; i++) {
          // a little wider than the string: the plates differ left and right
          l[i] += knock[i];
          r[i] += knock[i] * 0.8;
        }
      }

      let peak = 0;
      for (let i = 0; i < frames; i++) {
        const a = Math.abs(l[i]);
        const b = Math.abs(r[i]);
        if (a > peak) peak = a;
        if (b > peak) peak = b;
      }
      // hard guarantee of the contract ceiling |1.0| (normally never engaged)
      const limit = model.peakLimited ? velocityCeiling(vel) : 0.98;
      const level = peak * gain > limit ? limit / peak : gain;
      const fade = Math.min(frames, Math.max(32, Math.round(0.015 * sr)));
      const fadeStart = frames - fade;
      for (let i = 0; i < fadeStart; i++) {
        left[i] += l[i] * level;
        right[i] += r[i] * level;
      }
      for (let i = fadeStart; i < frames; i++) {
        const fall =
          0.5 + 0.5 * Math.cos((Math.PI * (i - fadeStart + 1)) / fade);
        const g = level * fall;
        left[i] += l[i] * g;
        right[i] += r[i] * g;
      }
    },
  };
}

/** One resonance of a body: a peaking EQ at `hz`. */
const resonance = (hz: number, q: number, gainDb: number, sampleRate: number) =>
  new Biquad().setPeak(hz, q, gainDb, sampleRate);

/* ----------------------------------------------------------------- guitar */

/**
 * Steel-string acoustic guitar: plucked with a pick at 16–21 % of the
 * string, long ring on the fundamental, short at 4 kHz, slight stiffness;
 * body with the air resonance near 104 Hz and top-plate modes around 200 and
 * 450 Hz; the fretting finger damps the string at note-off.
 */
export const guitar: Voice = stringVoice({
  id: "guitar",
  lowestHz: 40,
  ring: (f0) => 7.5 * Math.pow(110 / f0, 0.45),
  ringHigh: (midi) => 0.55 + 0.3 * clamp01((midi - 40) / 36),
  dispersion: [-0.12, 1],
  position: [0.16, 0.05],
  bodyHz: (f0, vel) => f0 * 1.5 + 200 + 1300 * vel * vel,
  hardnessHz: (vel) => 1400 + 7000 * Math.pow(vel, 1.5),
  noise: 0.03,
  smear: [
    [180, 0.8],
    [420, 1.2],
    [950, 1.2],
    [2100, 1],
  ],
  body: (sr) => ({
    shared: [
      new Biquad().setHighpass(72, 0.75, sr),
      resonance(104, 3.2, 4, sr),
      new Biquad().setHighShelf(5200, -3, sr),
    ],
    left: [resonance(196, 4, 3.5, sr), resonance(410, 2.2, 2, sr)],
    right: [resonance(222, 4, 3.5, sr), resonance(520, 2.2, 2, sr)],
  }),
  taps: [0.11, 0.31, 0.3],
  damp: (_f0, midi) => [0.2 - 0.09 * clamp01((midi - 40) / 40), 0.05],
  tail: () => 0.28,
});

/* ------------------------------------------------------------------ nylon */

/**
 * Classical guitar: nylon strings played with the fingertip and nail nearer
 * the soundhole (22–28 % of the string). Nylon is soft and lossy: no
 * stiffness, a fundamental that rings two thirds as long as steel and upper
 * partials that are gone in a third of a second, so the tone is round and
 * darkens quickly. The lighter, fan-braced body answers lower and more
 * strongly (air 98 Hz, top near 200 Hz) and gives little above 4 kHz.
 */
export const nylon: Voice = stringVoice({
  id: "nylon",
  lowestHz: 40,
  ring: (f0) => 5.2 * Math.pow(110 / f0, 0.5),
  ringHigh: (midi) => 0.26 + 0.14 * clamp01((midi - 40) / 36),
  dispersion: [0, 0],
  position: [0.22, 0.06],
  bodyHz: (f0, vel) => f0 * 1.25 + 140 + 800 * vel * vel,
  hardnessHz: (vel, f0) => Math.max(850 + 3600 * Math.pow(vel, 1.5), 1.6 * f0),
  noise: 0.015,
  smear: [
    [160, 0.8],
    [380, 1.2],
    [850, 1.2],
    [1900, 1],
  ],
  body: (sr) => ({
    shared: [
      new Biquad().setHighpass(68, 0.75, sr),
      resonance(98, 3, 5, sr),
      new Biquad().setHighShelf(4200, -6, sr),
    ],
    left: [resonance(190, 3.5, 4, sr), resonance(380, 2, 2.5, sr)],
    right: [resonance(214, 3.5, 4, sr), resonance(470, 2, 2.5, sr)],
  }),
  taps: [0.13, 0.33, 0.3],
  damp: (_f0, midi) => [0.22 - 0.09 * clamp01((midi - 40) / 40), 0.05],
  tail: () => 0.3,
  peakLimited: true,
});

/* ---------------------------------------------------------------- guzheng */

/**
 * Guzheng: steel-cored strings over a long paulownia box, plucked close to
 * the bridge (11–14 %) with fingerpicks: a hard, bright attack full of upper
 * harmonics, stiff enough to sound metallic, and a ring that lasts many
 * seconds because metal keeps its upper partials. A hard pluck stretches the
 * string, so every note starts a few cents sharp and settles within a tenth
 * of a second; NoteEvent.bend adds the characteristic slide into the note
 * (the left hand pressing the string behind the bridge) on top of that.
 * Nobody damps a guzheng string: after note-off it rings on and fades.
 */
function guzhengRelease(f0: number): number {
  return clamp(1.5 * Math.pow(220 / f0, 0.3), 0.7, 1.8);
}

export const guzheng: Voice = stringVoice({
  id: "guzheng",
  lowestHz: 30,
  ring: (f0) => 9 * Math.pow(110 / f0, 0.4),
  ringHigh: (midi) => 1 + 0.35 * clamp01((midi - 38) / 48),
  dispersion: [-0.22, 2],
  position: [0.11, 0.03],
  bodyHz: (f0, vel) => f0 * 2.5 + 400 + 2400 * vel * vel,
  hardnessHz: (vel, f0) => Math.max(2600 + 5400 * Math.pow(vel, 1.5), 1.6 * f0),
  noise: 0.05,
  smear: [
    [210, 0.8],
    [480, 1.2],
    [1100, 1.2],
    [2500, 1],
    [4200, 1.2],
    [6500, 1.2],
  ],
  body: (sr) => ({
    shared: [
      new Biquad().setHighpass(60, 0.75, sr),
      resonance(150, 2.5, 3, sr),
      resonance(285, 3, 3, sr),
      // bright, but the pluck's upper harmonics stay under the body of the
      // note (3–5 dB of shelf: at the level of its mids it cut like a harpsichord)
      new Biquad().setHighShelf(3600, -2.5, sr),
      // silk-wound steel is bright, not glassy: little above 9 kHz
      new Biquad().setLowpass(9000, 0.7, sr),
    ],
    left: [resonance(520, 3, 3, sr), resonance(1900, 1.2, 2.5, sr)],
    right: [resonance(640, 3, 3, sr), resonance(2400, 1.2, 2.5, sr)],
  }),
  taps: [0.09, 0.27, 0.3],
  damp: (f0) => [guzhengRelease(f0), 0.3],
  tail: (note) => 0.75 * guzhengRelease(midiToHz(note.midi)),
  peakLimited: true,
  settle: { cents: (vel) => 2 + 9 * vel * vel, tau: 0.045 },
});

/* -------------------------------------------------------------- pizzicato */

/**
 * Orchestral pizzicato: a bowed-string instrument plucked with the flesh of
 * the finger over the end of the fingerboard (32–36 % of the string). The
 * soft fingertip gives few upper harmonics, and a short, heavily damped
 * string lets them go within a tenth of a second: what remains is a round,
 * woody note well under a second long (longer on the cello and bass
 * strings). The body is that of the violin family, with its air and plate
 * resonances, and the pluck rings those directly as a small knock. A
 * pizzicato is not stopped: after note-off the string only fades a little
 * sooner, so staccato and held notes sound alike.
 */
function pizzRing(f0: number): number {
  return clamp(0.88 * Math.pow(440 / f0, 0.5), 0.34, 1.9);
}

export const pizzicato: Voice = stringVoice({
  id: "pizzicato",
  lowestHz: 30,
  ring: (f0) => pizzRing(f0),
  ringHigh: () => 0.1,
  dispersion: [0, 0],
  position: [0.32, 0.04],
  bodyHz: (f0, vel) => f0 * 0.8 + 80 + 500 * vel * vel,
  hardnessHz: (vel, f0) => Math.max(500 + 1200 * Math.pow(vel, 1.5), 2 * f0),
  noise: 0.015,
  smear: [
    [140, 0.7],
    [330, 0.9],
    [720, 1],
    [1500, 1],
  ],
  body: (sr) => ({
    shared: [
      new Biquad().setHighpass(55, 0.75, sr),
      resonance(130, 2, 3, sr),
      resonance(282, 3.5, 5, sr),
      new Biquad().setHighShelf(3500, -7, sr),
    ],
    left: [resonance(470, 4, 4, sr), resonance(900, 2, 2.5, sr)],
    right: [resonance(540, 4, 4, sr), resonance(1100, 2, 2.5, sr)],
  }),
  taps: [0.12, 0.3, 0.3],
  damp: () => [0.5, 0.06],
  tail: () => 0.42,
  peakLimited: true,
  knock: [
    [148, 0.11, 0.24],
    [282, 0.09, 0.36],
    [505, 0.06, 0.27],
    [930, 0.035, 0.12],
  ],
});
