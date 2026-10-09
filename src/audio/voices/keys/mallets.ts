/**
 * Struck bars and tines: bell (celesta / glockenspiel), musicbox, marimba
 * and vibes. All four are modal: every vibration mode of the bar is one
 * exactly decaying sinusoid (ModalBank), so the partials sit where the
 * physics of the bar puts them, each with its own ring time, and the level
 * is known in closed form (struckPower) on every key.
 *
 * What tells them apart is what tells the real instruments apart: the mode
 * ratios (free steel bar 1 : 2.76 : 5.40, clamped comb tine 1 : 6.27 : 17.5,
 * tuned wooden / aluminium bar 1 : 4 : 10), how long the modes ring, how
 * hard the mallet is, and what happens when the note is let go.
 * NoteEvent.bend is ignored: a bar cannot bend.
 */
import type { Voice, VoiceNote } from "../types";
import {
  Biquad,
  LEVEL_WINDOW,
  LN_60DB,
  ModalBank,
  REFERENCE_RMS,
  WhiteNoise,
  clamp,
  clamp01,
  midiToHz,
  noteOffFrame,
  panLeft,
  panRight,
  scratch,
  sinPhase,
  velocityGain,
} from "../../dsp";
import {
  expMean,
  mixNote,
  struckPower,
  velocityCeiling,
} from "../../dsp/extra-keys";

const MAX_MODES = 16;
/** -6 dB point of the roll-off every mode passes (4th order) */
const AIR_HZ = 9000;
const bank = new ModalBank(MAX_MODES);
const modeHz = new Float64Array(MAX_MODES);
const modeAmp = new Float64Array(MAX_MODES);
const modeT60 = new Float64Array(MAX_MODES);
/** T60 after note-off (the smaller of this and the held T60 applies) */
const modeRelease = new Float64Array(MAX_MODES);
const modeLeft = new Float64Array(MAX_MODES);
const modeRight = new Float64Array(MAX_MODES);
let modes = 0;

/** Add one mode to the table of the note being built (dropped above the audible / safe band). */
function mode(
  hz: number,
  amp: number,
  t60: number,
  release: number,
  pan: number,
  sampleRate: number,
): void {
  if (modes >= MAX_MODES || hz > Math.min(15000, sampleRate * 0.42)) return;
  // rolled off at the top: partials up there would be glare, not tone
  const air = hz / AIR_HZ;
  amp /= 1 + air * air * air * air;
  if (!(amp > 1e-5)) return;
  modeHz[modes] = hz;
  modeAmp[modes] = amp;
  modeT60[modes] = t60;
  modeRelease[modes] = release;
  // in phase in both channels (mono sum unchanged), unity at the centre
  modeLeft[modes] = panLeft(pan) * Math.SQRT2;
  modeRight[modes] = panRight(pan) * Math.SQRT2;
  modes++;
}

/**
 * Gain that puts the mode table on the level convention (`extraPower` =
 * mean power over the level window of anything rendered outside the table).
 * A ring much shorter than the level window would need more peak than
 * exists; mixNote() caps those notes at velocityCeiling().
 */
function struckGain(vel: number, extraPower = 0): number {
  const mean =
    struckPower(
      modes,
      modeHz,
      modeAmp,
      modeT60,
      modeLeft,
      modeRight,
      LEVEL_WINDOW,
    ) + extraPower;
  return (REFERENCE_RMS * velocityGain(vel)) / Math.sqrt(Math.max(mean, 1e-12));
}

/** Strike the mode table and let it ring: free until `hold`, then with the release times. */
function ring(
  l: Float32Array,
  r: Float32Array,
  frames: number,
  hold: number,
  sampleRate: number,
): void {
  for (let k = 0; k < modes; k++)
    bank.set(k, modeHz[k], modeT60[k], modeAmp[k], sampleRate);
  bank.count = modes;
  bank.strike();
  bank.renderStereo(l, r, 0, hold, modeLeft, modeRight);
  for (let k = 0; k < modes; k++)
    bank.setDecay(k, Math.min(modeT60[k], modeRelease[k]), sampleRate);
  bank.renderStereo(l, r, hold, frames - hold, modeLeft, modeRight);
}

const contactLow = new Biquad();
const contactHigh = new Biquad();

/**
 * The mallet (or plectrum) itself: a burst of noise between `highpassHz`
 * and `lowpassHz` that dies with time constant `tau`, added to both channels.
 */
function contact(
  l: Float32Array,
  r: Float32Array,
  frames: number,
  sampleRate: number,
  noise: WhiteNoise,
  lowpassHz: number,
  highpassHz: number,
  tau: number,
  gain: number,
): void {
  const length = Math.min(frames, Math.ceil(tau * 9 * sampleRate) + 8);
  if (length < 2 || !(gain > 0)) return;
  contactLow.setLowpass(lowpassHz, 0.7, sampleRate);
  contactHigh.setHighpass(highpassHz, 0.7, sampleRate);
  contactLow.reset();
  contactHigh.reset();
  const coef = Math.exp(-1 / (tau * sampleRate));
  const rise = Math.max(4, Math.round(0.0008 * sampleRate));
  let env = gain;
  for (let i = 0; i < length; i++) {
    const ramp = i < rise ? 0.5 - 0.5 * Math.cos((Math.PI * i) / rise) : 1;
    // fade the last samples so a truncated burst cannot step
    const end = length - i < 16 ? (length - 1 - i) / 16 : 1;
    const v =
      contactHigh.next(contactLow.next(noise.next())) * env * ramp * end;
    l[i] += v;
    r[i] += v;
    env *= coef;
  }
}

/** Fixed pseudo-random value in [-1, 1) per whole key: the same key always gets the same one. */
function keyJitter(midi: number, salt: number): number {
  const x = Math.sin(Math.round(midi) * 12.9898 + salt * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
}

/* ------------------------------------------------------------------- bell */

/**
 * Celesta / glockenspiel: a free steel bar (modes 1 : 2.756 : 5.404 : 8.933
 * : 13.34) over a small resonator that adds a faint octave. The fundamental
 * rings for seconds and the inharmonic upper modes ring half to three
 * quarters as long, so the glassy colour stays with the note instead of
 * being only a click; a harder hit (velocity) shortens the mallet contact,
 * which lets more of them through, and everything above 9 kHz is rolled off
 * so the top octaves glint without glare. The bar modes are doublets a
 * fraction of a hertz apart on opposite sides of the stereo image: the
 * slow, wandering shimmer of a real bar. Letting go of the key lowers a
 * felt damper gently, so short notes still bloom.
 */
const BELL_MODES: readonly [
  ratio: number,
  level: number,
  ring: number,
  order: number,
][] = [
  [1, 1, 1, 0],
  [2, 0.1, 0.7, 1],
  [2.756, 0.7, 0.75, 1],
  [5.404, 0.5, 0.55, 2],
  [8.933, 0.28, 0.35, 3],
  [13.345, 0.12, 0.2, 4],
];
const BELL_DOUBLET = [0.2, 0, 0.4, 0.4, 0.3, 0];

function bellRing(midi: number): number {
  return clamp(5 * Math.pow(2, -(midi - 69) / 16), 1.1, 7);
}

function bellRelease(midi: number): number {
  return clamp(1.3 * Math.pow(2, -(midi - 69) / 24), 0.45, 1.6);
}

export const bell: Voice = {
  id: "bell",
  tail(note: VoiceNote): number {
    return 0.8 * bellRelease(note.midi) + 0.04;
  },
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const midi = note.midi;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(midi), 20, sr * 0.2);
    const noise = new WhiteNoise(ctx.random);
    const ringTime = bellRing(midi);
    const releaseTime = bellRelease(midi);
    const hardness = 0.55 + 0.6 * vel;
    const contactHz = 3000 + 9000 * Math.pow(vel, 1.3);
    const keyPan = clamp((midi - 78) / 200, -0.08, 0.08);

    modes = 0;
    for (let k = 0; k < BELL_MODES.length; k++) {
      const [ratio, level, ringShare, order] = BELL_MODES[k];
      const hz = f0 * ratio;
      const x = hz / contactHz;
      const amp = (level * Math.pow(hardness, order)) / (1 + x * x);
      const t60 = ringTime * ringShare;
      const release = releaseTime * Math.sqrt(ringShare);
      const scatter =
        order === 0 ? 0.03 : 0.34 * Math.sin(k * 2.4 + midi * 0.7);
      const twin = BELL_DOUBLET[k];
      mode(hz, amp, t60, release, keyPan + scatter, sr);
      if (twin > 0) {
        const beat = (0.3 + 0.32 * order) * (1 + 0.3 * keyJitter(midi, k));
        const twinPan = keyPan - scatter - 0.12;
        mode(hz + beat, amp * twin, t60, release, twinPan, sr);
      }
    }

    const gain = struckGain(vel);
    const hold = noteOffFrame(note, frames, sr, 0.02);
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    ring(l, r, frames, hold, sr);
    // the mallet: a tiny bright tick
    contact(
      l,
      r,
      frames,
      sr,
      noise,
      3000 + 7000 * vel,
      1800,
      0.0011,
      0.5 * Math.pow(vel, 1.2),
    );
    mixNote(
      left,
      right,
      l,
      r,
      frames,
      gain,
      0.0006 * sr,
      0.03 * sr,
      velocityCeiling(vel),
    );
  },
};

/* --------------------------------------------------------------- musicbox */

/**
 * Music box: a steel comb tine (clamped at one end, modes 1 : 6.267 : 17.55)
 * plucked by a pin. Almost a pure tone, plus the high inharmonic "tink" that
 * dies within a few hundred milliseconds, heard through a small wooden box
 * that has no bass (so the low keys turn thin, as they do on the real
 * thing). Every tine is a few cents off, always the same amount for the same
 * key, like a comb that left the factory slightly out of tune. Nothing damps
 * a tine: after note-off it keeps ringing and only fades a little sooner.
 */
function boxResponse(hz: number): number {
  const octaves = Math.log2(hz / 2300);
  const high = hz / 11000;
  return (
    (hz / Math.sqrt(hz * hz + 520 * 520)) *
    (1 + 0.4 * Math.exp((-octaves * octaves) / 0.8)) *
    (1 / (1 + high * high))
  );
}

function tineRing(midi: number): number {
  return clamp(2.4 * Math.pow(2, -(midi - 72) / 16), 0.8, 3.2);
}

/** cents each key of the comb is out of tune */
const TINE_DETUNE = 4.5;

export const musicbox: Voice = {
  id: "musicbox",
  tail(note: VoiceNote): number {
    return 0.8 * Math.min(tineRing(note.midi), 1.7) + 0.04;
  },
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const midi = note.midi;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 =
      clamp(midiToHz(midi), 20, sr * 0.2) *
      Math.pow(2, (TINE_DETUNE * keyJitter(midi, 1)) / 1200);
    const noise = new WhiteNoise(ctx.random);
    const ringTime = tineRing(midi);
    const release = Math.min(ringTime, 1.7);
    const pan = clamp((midi - 76) / 160, -0.1, 0.1);

    modes = 0;
    mode(f0, boxResponse(f0), ringTime, release, pan, sr);
    // a tine pulled further is no longer a pure tone: 2nd and 3rd harmonic
    // grow with the square of the deflection
    mode(
      f0 * 2,
      (0.04 + 0.22 * vel * vel) * boxResponse(f0 * 2),
      ringTime * 0.6,
      release * 0.6,
      pan + 0.1,
      sr,
    );
    mode(
      f0 * 3,
      (0.015 + 0.09 * vel * vel) * boxResponse(f0 * 3),
      ringTime * 0.4,
      release * 0.4,
      pan - 0.08,
      sr,
    );
    // the clamped-bar overtones: the "tink"
    mode(
      f0 * 6.267,
      (0.14 + 0.2 * vel) * boxResponse(f0 * 6.267),
      clamp(ringTime * 0.4, 0.2, 0.9),
      1,
      pan - 0.12,
      sr,
    );
    mode(
      f0 * 17.547,
      (0.03 + 0.07 * vel) * boxResponse(f0 * 17.547),
      0.07,
      1,
      pan + 0.12,
      sr,
    );

    const gain = struckGain(vel);
    const hold = noteOffFrame(note, frames, sr, 0.02);
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    ring(l, r, frames, hold, sr);
    // the pin letting go of the tine
    contact(l, r, frames, sr, noise, 9000, 3200, 0.0007, 0.3 * vel);
    mixNote(
      left,
      right,
      l,
      r,
      frames,
      gain,
      0,
      0.03 * sr,
      velocityCeiling(vel),
    );
  },
};

/* ---------------------------------------------------------------- marimba */

/**
 * Marimba: a rosewood bar tuned so its modes sit near 1 : 3.93 : 9.2 (two
 * octaves and a little over three), above a resonator tube. Wood loses its
 * upper modes within tens of milliseconds, so after the knock of the attack
 * only a warm, short-lived fundamental is left: about 1.5 s at A3, 0.85 s at
 * A4, a quarter of a second at the top. A yarn mallet gives a soft low
 * thump and lets through more of the upper modes when played harder.
 * Bars are not damped: the note rings out on its own after note-off (the
 * long bass bars a little faster, so a staccato bass line stays clean).
 * Above A4 the ring is shorter than the level window can be filled with, so
 * those notes are peak-limited (velocityCeiling) and read a few dB quieter.
 */
function barRing(midi: number): number {
  return clamp(1.3 * Math.pow(2, -(midi - 60) / 15), 0.22, 3);
}

export const marimba: Voice = {
  id: "marimba",
  tail(note: VoiceNote): number {
    return 0.8 * Math.min(barRing(note.midi), 1) + 0.04;
  },
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const midi = note.midi;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(midi), 20, sr * 0.2);
    const noise = new WhiteNoise(ctx.random);
    const ringTime = barRing(midi);
    const release = Math.min(ringTime, 1);
    const hardness = 0.4 + 0.8 * vel;
    const contactHz = 1200 + 4200 * vel;
    const pan = clamp((midi - 60) / 120, -0.2, 0.2);
    const through = (hz: number) =>
      1 / (1 + (hz / contactHz) * (hz / contactHz));

    modes = 0;
    mode(f0, 1, ringTime, release, pan, sr);
    mode(
      f0 * 3.93,
      0.45 * hardness * through(f0 * 3.93),
      clamp(ringTime * 0.25, 0.07, 0.4),
      1,
      pan + 0.1,
      sr,
    );
    mode(
      f0 * 9.2,
      0.14 * hardness * hardness * through(f0 * 9.2),
      clamp(ringTime * 0.08, 0.03, 0.12),
      1,
      pan - 0.1,
      sr,
    );

    const gain = struckGain(vel);
    const hold = noteOffFrame(note, frames, sr, 0.02);
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    ring(l, r, frames, hold, sr);
    // yarn on wood: a soft thump below the note
    contact(
      l,
      r,
      frames,
      sr,
      noise,
      (320 + 900 * vel) * Math.pow(2, (midi - 60) / 36),
      70,
      0.008,
      1.2 * Math.pow(vel, 1.2),
    );
    // a yarn mallet stays on the bar for a few milliseconds: no instant edge
    mixNote(
      left,
      right,
      l,
      r,
      frames,
      gain,
      (0.0035 - 0.002 * vel) * sr,
      0.025 * sr,
      velocityCeiling(vel),
    );
  },
};

/* ------------------------------------------------------------------ vibes */

/**
 * Vibraphone: an aluminium bar tuned 1 : 4 : 10 over a resonator tube whose
 * top is opened and closed by a motor-driven disc. Metal rings long (about
 * 7 s at A3, 4.5 s at A4), the two upper modes are a brief metallic edge,
 * and the motor makes the FUNDAMENTAL (the part the tube amplifies) swell
 * and fade 5.3 times a second, slightly out of step between the two
 * channels. A soft cord mallet; the damper bar stops the note at note-off.
 */
const VIBES_RATE = 5.3;
/** the motor takes the fundamental from 1 down to 1 - 2·depth */
const VIBES_DEPTH = 0.21;
const VIBES_OFFSET = 0.07;
const VIBES_RELEASE = 0.42;
const fundamental = new ModalBank(1);

function vibesRing(midi: number): number {
  return clamp(6.5 * Math.pow(2, -(midi - 60) / 18), 1.5, 8);
}

export const vibes: Voice = {
  id: "vibes",
  tail: () => 0.8 * VIBES_RELEASE + 0.04,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const midi = note.midi;
    const vel = clamp(note.vel, 0.02, 1);
    const f0 = clamp(midiToHz(midi), 20, sr * 0.2);
    const noise = new WhiteNoise(ctx.random);
    const ringTime = vibesRing(midi);
    const hardness = 0.4 + 0.8 * vel;
    const contactHz = 1500 + 5200 * vel;
    const pan = clamp((midi - 65) / 130, -0.18, 0.18);
    const through = (hz: number) =>
      1 / (1 + (hz / contactHz) * (hz / contactHz));

    modes = 0;
    mode(
      f0 * 3.98,
      (0.04 + 0.3 * vel * vel) * through(f0 * 3.98),
      clamp(ringTime * 0.4, 0.4, 2.5),
      0.3,
      pan + 0.16,
      sr,
    );
    mode(
      f0 * 9.93,
      0.11 * hardness * hardness * through(f0 * 9.93),
      clamp(ringTime * 0.07, 0.1, 0.4),
      0.2,
      pan - 0.16,
      sr,
    );

    // level: the tremolo'd fundamental plus the upper modes
    const fundLeft = panLeft(pan) * Math.SQRT2;
    const fundRight = panRight(pan) * Math.SQRT2;
    const tremoloPower =
      (1 - VIBES_DEPTH) * (1 - VIBES_DEPTH) + 0.5 * VIBES_DEPTH * VIBES_DEPTH;
    const fundPower =
      0.25 *
      (fundLeft * fundLeft + fundRight * fundRight) *
      tremoloPower *
      expMean((2 * LN_60DB) / ringTime, LEVEL_WINDOW);
    const gain = struckGain(vel, fundPower);

    const hold = noteOffFrame(note, frames, sr, 0.02);
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    ring(l, r, frames, hold, sr);
    const tone = scratch(2, frames);
    fundamental.set(0, f0, ringTime, 1, sr);
    fundamental.count = 1;
    fundamental.strike();
    fundamental.render(tone, 0, hold);
    fundamental.setDecay(0, VIBES_RELEASE, sr);
    fundamental.render(tone, hold, frames - hold);
    // the motor: discs fully open at the strike, left and right a little apart
    const centre = 1 - VIBES_DEPTH;
    const step = VIBES_RATE / sr;
    let phaseLeft = 0.25 + VIBES_OFFSET;
    let phaseRight = 0.25 - VIBES_OFFSET + 1;
    phaseRight -= Math.floor(phaseRight);
    for (let i = 0; i < frames; i++) {
      const s = tone[i];
      l[i] += s * fundLeft * (centre + VIBES_DEPTH * sinPhase(phaseLeft));
      r[i] += s * fundRight * (centre + VIBES_DEPTH * sinPhase(phaseRight));
      phaseLeft += step;
      if (phaseLeft >= 1) phaseLeft -= 1;
      phaseRight += step;
      if (phaseRight >= 1) phaseRight -= 1;
    }
    // cord on metal: a soft, short thump
    contact(
      l,
      r,
      frames,
      sr,
      noise,
      (500 + 900 * vel) * Math.pow(2, clamp01((midi - 48) / 48)),
      90,
      0.005,
      0.7 * Math.pow(vel, 1.2),
    );
    mixNote(
      left,
      right,
      l,
      r,
      frames,
      gain,
      (0.004 - 0.002 * vel) * sr,
      0.03 * sr,
      velocityCeiling(vel),
    );
  },
};
