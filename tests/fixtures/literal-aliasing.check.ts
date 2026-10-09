// Run by tests/dsp.test.ts in a process of its own:
//   node --allow-natives-syntax --expose-gc --import tsx tests/fixtures/literal-aliasing.check.ts
//
// The V8 of Node 24.18 can hand out two objects, made by the same object
// literal, whose number fields are ONE shared box (see tests/helpers/spectrum.ts
// for what that did to the DSP tests). In the wild it takes a loaded machine;
// here the tiers are driven by hand, so it happens every time or never:
//
//   1. the function runs once in the interpreter: its stores see the
//      literal's first maps, which are deprecated at once
//   2. optimised code takes over: the literal gets its boilerplate, the
//      feedback of the stores stays as it was
//   3. a collection clears that feedback; the optimised code is dropped
//   4. a long call: Maglev replaces the frame in the middle of the loop,
//      creates the literal and deoptimises at the first store — and the
//      object it materialises shares its number boxes with the next one
//
// The check drives two functions through that sequence: a helper of the old
// shape (returns `{ amplitude, phase }`) and measureLine, the sample loop the
// DSP tests really use. It prints one line of JSON; the test decides.
import { measureLine } from "../helpers/spectrum";

const native = (name: string) =>
  new Function("f", `%${name}(f)`) as (f: unknown) => void;
const prepare = native("PrepareFunctionForOptimization");
const optimizeOnNextCall = native("OptimizeFunctionOnNextCall");
const deoptimize = native("DeoptimizeFunction");
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --expose-gc");
const collect: () => void = gc;

const SR = 48000;
const TAU = 2 * Math.PI;

/** The helper tests/dsp.test.ts had: the same loop, the result as an object literal. */
function probeLiteral(
  signal: ArrayLike<number>,
  hz: number,
  sampleRate: number,
  start: number,
  length: number,
): { amplitude: number; phase: number } {
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
  return {
    amplitude: (2 * Math.hypot(re, im)) / weight,
    phase: Math.atan2(im, re),
  };
}

type Probe<T> = (
  signal: ArrayLike<number>,
  hz: number,
  sampleRate: number,
  start: number,
  length: number,
) => T;

const tone = (length: number, phase: number, level: number) =>
  Float32Array.from(
    { length },
    (_, i) => level * Math.cos((TAU * 440 * i) / SR + phase),
  );

/**
 * Steps 1–4 for `probe`; `read` takes the two numbers out of a result. The
 * two long calls measure tones of different level and phase: returns what
 * came back for each, read only after BOTH calls were made — as a test does
 * that compares a filtered signal with its reference.
 */
function drive<T>(
  probe: Probe<T>,
  read: (result: T) => [number, number],
  readAtOnce: boolean,
) {
  const short = tone(64, 0.3, 0.5);
  const first = tone(48000, 0.2, 0.9);
  const second = tone(48000, 1.1, 0.4);
  prepare(probe);
  probe(short, 440, SR, 0, 16);
  optimizeOnNextCall(probe);
  for (let k = 0; k < 12; k++) probe(short, 440, SR, 0, 16);
  collect();
  collect();
  deoptimize(probe);
  const a = probe(first, 440, SR, 0, first.length);
  const early = readAtOnce ? read(a) : null;
  const b = probe(second, 440, SR, 0, second.length);
  const [amplitudeA, phaseA] = early ?? read(a);
  const [amplitudeB, phaseB] = read(b);
  const close = (x: number, y: number) => Math.abs(x - y) < 1e-3;
  return {
    first: [amplitudeA, phaseA],
    second: [amplitudeB, phaseB],
    correct:
      close(amplitudeA, 0.9) &&
      close(phaseA, 0.2) &&
      close(amplitudeB, 0.4) &&
      close(phaseB, 1.1),
  };
}

const literal = drive(
  probeLiteral,
  (result) => [result.amplitude, result.phase],
  false,
);
const helper = drive(measureLine, (result) => [result[0], result[1]], true);
console.log(
  JSON.stringify({
    node: process.version,
    v8: process.versions.v8,
    literal,
    helper,
  }),
);
