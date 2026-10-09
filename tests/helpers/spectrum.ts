// One spectral line of a signal, for the DSP tests.
//
// The two functions return NUMBERS, and they share their sample loop through a
// typed array — on purpose. tests/dsp.test.ts used to have one helper that
// returned `{ amplitude, phase }`, and under load one run in twenty failed with
// "measured allpass delay 0.2: got 0": the object for the filtered signal and
// the object for the reference came back holding the same two numbers.
//
// That is a miscompilation in the V8 of Node 24.18 (V8 13.6), not something in
// the engine. When a function is optimised on the stack in the middle of its
// loop (Maglev OSR) and leaves optimised code again right after creating the
// object literal it returns, the literal's number fields are materialised as
// one shared box: every such object then shows whatever was written last. It
// needs Maglev, TurboFan, OSR and concurrent recompilation together (switching
// any one of them off makes it disappear, as does --no-maglev-escape-analysis),
// which is why it only showed on a loaded machine. Chromium 149 (V8 14.9) does
// not have it. tests/fixtures/literal-aliasing.check.ts reproduces it without
// any timing, and tests/dsp.test.ts runs that check against measureLine below.
//
// So: a helper with a sample loop in it hands back numbers, never a fresh
// object literal of numbers that a caller may keep next to another one.

const TAU = 2 * Math.PI;

/** [amplitude, phase] of the line measured last. */
const line = new Float64Array(2);

/**
 * The sample loop: the Hann-weighted DFT bin of `signal` at `hz` over
 * [start, start + length). Returns the shared pair [amplitude, phase], which
 * is only good until the next call: take the numbers out at once (the two
 * functions below do).
 */
export function measureLine(
  signal: ArrayLike<number>,
  hz: number,
  sampleRate: number,
  start: number,
  length: number,
): Float64Array {
  let re = 0;
  let im = 0;
  let weight = 0;
  for (let i = 0; i < length; i++) {
    const w = 0.5 - 0.5 * Math.cos((TAU * i) / length);
    const angle = (TAU * hz * (start + i)) / sampleRate;
    re += signal[start + i] * w * Math.cos(angle);
    im -= signal[start + i] * w * Math.sin(angle);
    weight += w;
  }
  line[0] = (2 * Math.hypot(re, im)) / weight;
  line[1] = Math.atan2(im, re);
  return line;
}

/** Amplitude of the partial of `signal` at `hz` over [start, start + length). */
export function amplitudeAt(
  signal: ArrayLike<number>,
  hz: number,
  sampleRate: number,
  start = 0,
  length = signal.length - start,
): number {
  return measureLine(signal, hz, sampleRate, start, length)[0];
}

/** Phase in radians (re a cosine at sample 0) of the partial of `signal` at `hz` over [start, start + length). */
export function phaseAt(
  signal: ArrayLike<number>,
  hz: number,
  sampleRate: number,
  start = 0,
  length = signal.length - start,
): number {
  return measureLine(signal, hz, sampleRate, start, length)[1];
}
