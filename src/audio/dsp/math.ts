/**
 * Scalar helpers shared by every DSP module. Pure functions, no state.
 */

export const TAU = Math.PI * 2;

/** ln(1000): an amplitude falls 60 dB after `LN_60DB / rate` seconds. */
export const LN_60DB = 6.907755278982137;

/** Limit x to [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Limit x to [0, 1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Linear interpolation from a (t = 0) to b (t = 1). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite ease 0..1 with zero slope at both ends (input is clamped). */
export function smoothstep(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** MIDI note number (fractional allowed, A4 = 69) to frequency in Hz. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Frequency in Hz to (fractional) MIDI note number. */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** Decibels to linear amplitude. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear amplitude to decibels (floored at -240 dB). */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain > 1e-12 ? gain : 1e-12);
}

/** Frequency ratio of an interval in semitones. */
export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/** Frequency ratio of an interval in cents. */
export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

/** Interval in cents between two frequencies (positive when hz > reference). */
export function centsBetween(hz: number, reference: number): number {
  return 1200 * Math.log2(hz / reference);
}

/** Left gain of an equal-power pan law, pan in -1 (left) .. 1 (right). */
export function panLeft(pan: number): number {
  return Math.cos((clamp(pan, -1, 1) + 1) * (Math.PI / 4));
}

/** Right gain of an equal-power pan law, pan in -1 (left) .. 1 (right). */
export function panRight(pan: number): number {
  return Math.sin((clamp(pan, -1, 1) + 1) * (Math.PI / 4));
}

/** Equal-power [left, right] gains; centre is 0.7071 each. Allocates: call outside loops. */
export function equalPowerPan(pan: number): [left: number, right: number] {
  return [panLeft(pan), panRight(pan)];
}

/** Per-sample multiplier that decays by 60 dB in `t60` seconds. */
export function t60ToCoef(t60: number, sampleRate: number): number {
  return Math.exp(-LN_60DB / (Math.max(t60, 1e-5) * sampleRate));
}

/** Per-sample multiplier of a one-pole with time constant `tau` seconds (decays to 1/e). */
export function tauToCoef(tau: number, sampleRate: number): number {
  return Math.exp(-1 / (Math.max(tau, 1e-6) * sampleRate));
}

/** Smallest power of two >= n (n >= 1). */
export function nextPow2(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}
