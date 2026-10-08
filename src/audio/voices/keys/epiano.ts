/**
 * Electric piano: FM tine piano in the Rhodes manner.
 */
import type { Voice } from "../types";
import {
  REFERENCE_RMS,
  clamp,
  clamp01,
  midiToHz,
  noteOffFrame,
  scratch,
  sinPhase,
  velocityGain,
} from "../../dsp";
import { LevelTable, mixNote, velocityCeiling } from "../../dsp/extra-keys";

/**
 * Three phase-modulation pairs, the classic recipe:
 *  - BODY: carrier and modulator both on the note (1:1). The modulation
 *    index starts high and falls within a few hundred milliseconds, so a
 *    hard key "barks" (the octave as strong as the note) and then mellows
 *    into an almost pure tone, while a soft key never leaves the mellow state.
 *    Low keys growl more, high keys are clean (index scales with the key);
 *  - CHORUS: a quieter copy of the body 2 cents higher (at most 0.6 Hz).
 *    The pair beats a fraction of a hertz apart, upper harmonics faster than
 *    the fundamental: the slow shimmer of a tine against its tone bar;
 *  - TINE: a carrier on the note modulated at 14 × the note with a quickly
 *    dying index: the metallic "ting" of the attack at 13 and 15 × the note,
 *    louder with velocity, faded out towards the top (where it would pass
 *    Nyquist) and gone after half a second.
 * A phase-modulated sine has the power of its carrier whatever the index,
 * so velocity changes the colour without changing how the level is set.
 * The note rings for seconds while held; note-off is a felt damper (0.16 s).
 * A gentle 4.6 Hz auto-pan (the "vibrato" of a suitcase piano) moves the
 * note a decibel left and right; in mono it cancels exactly.
 * NoteEvent.bend is ignored: a tine cannot bend.
 */
const INV_TAU = 1 / (Math.PI * 2);
const CHORUS_CENTS = 2;
const CHORUS_LEVEL = 0.26;
const CHORUS_MAX_HZ = 0.6;
const TINE_RATIO = 14;
const PAN_RATE = 4.6;
const PAN_DEPTH = 0.11;
const RELEASE_T60 = 0.16;
const TAIL = 0.2;

/** T60 in seconds of the held note. */
function bodyRing(midi: number): number {
  return clamp(8 * Math.pow(2, -(midi - 60) / 24), 1.8, 12);
}

/** Per-sample factor of a decay with time constant `tau` seconds. */
function decayCoef(tau: number, sampleRate: number): number {
  return Math.exp(-1 / (tau * sampleRate));
}

function epianoCore(
  l: Float32Array,
  r: Float32Array,
  frames: number,
  hold: number,
  midi: number,
  velocity: number,
  sr: number,
): void {
  const vel = clamp(velocity, 0.02, 1);
  const f0 = clamp(midiToHz(midi), 16, sr * 0.2);
  const octave = (midi - 60) / 12;

  // --- body and chorus pairs ---
  // the fundamental of a 1:1 pair is J0(I) - J2(I): it gives way to the
  // octave above index 1.2 and vanishes at 1.84, so the bark stops at 1.35
  const keyScale = clamp(Math.pow(2, -octave * 0.3), 0.45, 1.25);
  const barkIndex = Math.min(1.35, (0.12 + 1.1 * vel * vel) * keyScale);
  // (a soft key stays nearly pure; from mezzo-forte up the tone keeps some edge while it rings)
  const restIndex = Math.min(
    0.8,
    (0.1 + 0.5 * vel + 0.3 * Math.max(0, vel - 0.4)) * keyScale,
  );
  const barkCoef = decayCoef(
    clamp(0.3 * Math.pow(2, -octave * 0.35), 0.1, 0.5),
    sr,
  );
  const ampCoef = Math.exp(-6.907755 / (bodyRing(midi) * sr));
  const incA = f0 / sr;
  // 2 cents sharp, but never beating faster than CHORUS_MAX_HZ
  const beat = Math.min(
    f0 * (Math.pow(2, CHORUS_CENTS / 1200) - 1),
    CHORUS_MAX_HZ,
  );
  const incB = (f0 + beat) / sr;

  // --- tine pair: only where 15 × the note stays below Nyquist ---
  const tineTop = (0.42 * sr) / (TINE_RATIO + 1);
  const tineFade = clamp01((tineTop - f0) / (tineTop * 0.35));
  const tineLevel =
    // (a soft key keeps the old, gentle ting)
    (0.3 + 0.12 * clamp01((vel - 0.4) / 0.3)) *
    (0.25 + 0.95 * vel) *
    tineFade *
    clamp(0.45 + (midi - 36) / 44, 0.45, 1);
  const tineIndex0 = 0.35 + 1.05 * vel;
  const tineIndexCoef = decayCoef(0.16, sr);
  const tineAmpCoef = Math.exp(
    -6.907755 / (clamp(1.5 * Math.pow(2, -octave * 0.6), 0.4, 2.6) * sr),
  );
  // no tine, no modulator: 14 × a top note would pass a cycle per sample
  const incT = tineLevel > 0 ? (f0 * TINE_RATIO) / sr : 0;

  const releaseCoef = Math.exp(-6.907755 / (RELEASE_T60 * sr));
  const panStep = PAN_RATE / sr;

  let phaseA = 0;
  let phaseB = 0;
  let phaseT = 0;
  let phasePan = 0;
  let bark = Math.max(0, barkIndex - restIndex);
  let amp = 1;
  let tineAmp = tineLevel;
  let tineIndex = tineIndex0;
  let release = 1;
  for (let i = 0; i < frames; i++) {
    if (i >= hold) release *= releaseCoef;
    const index = (restIndex + bark) * INV_TAU;
    let x = phaseA + index * sinPhase(phaseA);
    const a = sinPhase(x - Math.floor(x));
    x = phaseB + 0.8 * index * sinPhase(phaseB);
    const b = sinPhase(x - Math.floor(x));
    x = phaseA + tineIndex * INV_TAU * sinPhase(phaseT);
    const t = sinPhase(x - Math.floor(x));
    const body = amp * a;
    const chorus = amp * CHORUS_LEVEL * b;
    const tine = tineAmp * t;
    const pan = PAN_DEPTH * sinPhase(phasePan);
    // the chorus pair sits a little left, the tine a little right
    l[i] = (body + 1.25 * chorus + 0.85 * tine) * (1 + pan) * release;
    r[i] = (body + 0.75 * chorus + 1.15 * tine) * (1 - pan) * release;
    phaseA += incA;
    if (phaseA >= 1) phaseA -= 1;
    phaseB += incB;
    if (phaseB >= 1) phaseB -= 1;
    phaseT += incT;
    if (phaseT >= 1) phaseT -= 1;
    phasePan += panStep;
    if (phasePan >= 1) phasePan -= 1;
    bark *= barkCoef;
    amp *= ampCoef;
    tineAmp *= tineAmpCoef;
    tineIndex *= tineIndexCoef;
  }
}

const level = new LevelTable({
  low: 16,
  high: 112,
  step: 4,
  velocities: [0.05, 0.3, 0.55, 0.8, 1],
  probe(left, right, frames, midi, vel, sampleRate) {
    epianoCore(left, right, frames, frames, midi, vel, sampleRate);
  },
});

export const epiano: Voice = {
  id: "epiano",
  tail: () => TAIL,
  render(left, right, frames, note, ctx) {
    const sr = ctx.sampleRate;
    const vel = clamp(note.vel, 0.02, 1);
    const gain =
      (REFERENCE_RMS * velocityGain(vel)) / level.rms(note.midi, vel, sr);
    const l = scratch(0, frames);
    const r = scratch(1, frames);
    const hold = noteOffFrame(note, frames, sr, 0.02);
    epianoCore(l, r, frames, hold, note.midi, vel, sr);
    // the hammer tip is neoprene: a softer key lands a little later
    const attack = (0.0015 + 0.0035 * (1 - vel)) * sr;
    mixNote(
      left,
      right,
      l,
      r,
      frames,
      gain,
      attack,
      0.02 * sr,
      velocityCeiling(vel),
    );
  },
};
