/**
 * Measurement harness for voices and drums. Used by the unit tests and by
 * scratch scripts while designing a sound; never imported by the app.
 *
 *   const r = renderNote(VOICES.piano, { midi: 69, vel: 0.8, duration: 1 });
 *   loudestWindowDb(r); centsError(r, 69); centroidHz(r); checkClicks(r);
 *   assertVoiceContract(VOICES.piano, { range: [21, 108] });
 *
 * Levels are in dBFS of the AVERAGE CHANNEL POWER, sqrt((L² + R²) / 2), so a
 * centred mono voice reads the same as either of its channels.
 */
import { SAMPLE_RATE } from "../../music/score";
import type { DrumKind, DrumKitId } from "../../music/score";
import type { DrumVoice, Voice, VoiceNote } from "./types";
import {
  bandPower,
  createRng,
  fft,
  midiToHz,
  nextPow2,
  powerSpectrum,
  spectralCentroid,
} from "../dsp";
import type { Spectrum } from "../dsp";

const GUARD = 64;

export interface Rendered {
  left: Float32Array;
  right: Float32Array;
  frames: number;
  sampleRate: number;
  /** note-off position in frames (equals `frames` for drum hits) */
  holdFrames: number;
  /** false when the voice wrote outside [0, frames) */
  guardIntact: boolean;
  /** wall-clock nanoseconds per rendered frame of this call (noisy; average several) */
  nsPerFrame: number;
}

function finish(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
  holdFrames: number,
  elapsedMs: number,
  fill: number,
): Rendered {
  let guardIntact = true;
  for (let i = frames; i < frames + GUARD; i++)
    if (left[i] !== fill || right[i] !== fill) guardIntact = false;
  return {
    left: left.subarray(0, frames),
    right: right.subarray(0, frames),
    frames,
    sampleRate,
    holdFrames,
    guardIntact,
    nsPerFrame: (elapsedMs * 1e6) / Math.max(1, frames),
  };
}

/** Number of frames the renderer allocates for a note of this voice. */
export function noteFrames(
  voice: Voice,
  note: VoiceNote,
  sampleRate = SAMPLE_RATE,
): number {
  return Math.max(
    1,
    Math.ceil((note.duration + voice.tail(note)) * sampleRate),
  );
}

/**
 * Render one note exactly as the renderer would: zeroed buffers of
 * ceil((duration + tail) · sampleRate) frames and a seeded ctx.random.
 * `prefill` starts the buffers at that value instead of zero (to verify that
 * a voice ADDS rather than overwrites).
 */
export function renderNote(
  voice: Voice,
  note: VoiceNote,
  sampleRate = SAMPLE_RATE,
  seed = 1,
  prefill = 0,
): Rendered {
  const frames = noteFrames(voice, note, sampleRate);
  const left = new Float32Array(frames + GUARD).fill(prefill);
  const right = new Float32Array(frames + GUARD).fill(prefill);
  const started = performance.now();
  voice.render(left, right, frames, note, {
    sampleRate,
    random: createRng(seed),
  });
  const elapsed = performance.now() - started;
  return finish(
    left,
    right,
    frames,
    sampleRate,
    Math.min(frames, Math.round(note.duration * sampleRate)),
    elapsed,
    prefill,
  );
}

/** Render one drum hit exactly as the renderer would. */
export function renderDrum(
  drums: DrumVoice,
  kind: DrumKind,
  kit: DrumKitId,
  vel: number,
  sampleRate = SAMPLE_RATE,
  seed = 1,
  prefill = 0,
): Rendered {
  const frames = Math.max(1, Math.ceil(drums.length(kind, kit) * sampleRate));
  const left = new Float32Array(frames + GUARD).fill(prefill);
  const right = new Float32Array(frames + GUARD).fill(prefill);
  const started = performance.now();
  drums.render(left, right, frames, kind, kit, vel, {
    sampleRate,
    random: createRng(seed),
  });
  const elapsed = performance.now() - started;
  return finish(left, right, frames, sampleRate, frames, elapsed, prefill);
}

const toDb = (power: number) => 10 * Math.log10(power > 1e-24 ? power : 1e-24);

/** True when every sample of both channels is a finite number. */
export function isFiniteAudio(r: Rendered): boolean {
  for (let i = 0; i < r.frames; i++)
    if (!Number.isFinite(r.left[i]) || !Number.isFinite(r.right[i]))
      return false;
  return true;
}

/** Largest absolute sample of either channel (linear). */
export function peak(r: Rendered): number {
  let max = 0;
  for (let i = 0; i < r.frames; i++) {
    const l = Math.abs(r.left[i]);
    const rr = Math.abs(r.right[i]);
    if (l > max) max = l;
    if (rr > max) max = rr;
  }
  return max;
}

/** RMS in dBFS between two times in seconds (default: the whole render). */
export function rmsDb(r: Rendered, from = 0, to = Infinity): number {
  const start = Math.max(0, Math.round(from * r.sampleRate));
  const end = Math.min(r.frames, Math.round(Math.min(to, 1e9) * r.sampleRate));
  if (end <= start) return -240;
  let power = 0;
  for (let i = start; i < end; i++)
    power += r.left[i] * r.left[i] + r.right[i] * r.right[i];
  return toDb(power / (2 * (end - start)));
}

/**
 * RMS in dBFS of the loudest `window` seconds — the quantity of the level
 * convention (-18 dBFS for a 1 s note at vel 0.8). Renders shorter than the
 * window are measured over their whole length.
 */
export function loudestWindowDb(r: Rendered, window = 0.4): number {
  const size = Math.min(
    r.frames,
    Math.max(1, Math.round(window * r.sampleRate)),
  );
  let sum = 0;
  for (let i = 0; i < size; i++)
    sum += r.left[i] * r.left[i] + r.right[i] * r.right[i];
  let best = sum;
  for (let i = size; i < r.frames; i++) {
    const j = i - size;
    sum +=
      r.left[i] * r.left[i] +
      r.right[i] * r.right[i] -
      r.left[j] * r.left[j] -
      r.right[j] * r.right[j];
    if (sum > best) best = sum;
  }
  return toDb(best / (2 * size));
}

/** Largest |mean| of the two channels (linear). */
export function dcOffset(r: Rendered): number {
  let l = 0;
  let rr = 0;
  for (let i = 0; i < r.frames; i++) {
    l += r.left[i];
    rr += r.right[i];
  }
  return Math.max(Math.abs(l), Math.abs(rr)) / Math.max(1, r.frames);
}

/** Pearson correlation of left and right: 1 = mono, 0 = unrelated, negative = phase trouble. */
export function stereoCorrelation(r: Rendered): number {
  let ll = 0;
  let rr = 0;
  let lr = 0;
  for (let i = 0; i < r.frames; i++) {
    ll += r.left[i] * r.left[i];
    rr += r.right[i] * r.right[i];
    lr += r.left[i] * r.right[i];
  }
  const denominator = Math.sqrt(ll * rr);
  return denominator > 1e-20 ? lr / denominator : 1;
}

/** (L + R) / 2 as a new buffer. */
export function monoSum(r: Rendered): Float32Array {
  const mono = new Float32Array(r.frames);
  for (let i = 0; i < r.frames; i++) mono[i] = 0.5 * (r.left[i] + r.right[i]);
  return mono;
}

/**
 * Power spectrum (average of both channels) of `seconds` starting at `from`;
 * by default the first 0.6 s, where the level convention is measured.
 */
export function spectrumOf(r: Rendered, from = 0, seconds = 0.6): Spectrum {
  const start = Math.min(
    r.frames - 1,
    Math.max(0, Math.round(from * r.sampleRate)),
  );
  const length = Math.max(
    2,
    Math.min(r.frames - start, Math.round(seconds * r.sampleRate)),
  );
  const a = powerSpectrum(r.left, r.sampleRate, start, length);
  const b = powerSpectrum(r.right, r.sampleRate, start, length);
  for (let k = 0; k < a.power.length; k++)
    a.power[k] = 0.5 * (a.power[k] + b.power[k]);
  return a;
}

/** Spectral centroid in Hz (brightness) of the same span spectrumOf() uses. */
export function centroidHz(r: Rendered, from = 0, seconds = 0.6): number {
  return spectralCentroid(spectrumOf(r, from, seconds));
}

/**
 * Energy per band in dB relative to the total. `edges` are the band limits
 * in Hz, e.g. [0, 120, 500, 2000, 6000, 24000] gives five bands.
 */
export function bandEnergiesDb(
  r: Rendered,
  edges: number[] = [0, 120, 500, 2000, 6000, 24000],
  from = 0,
  seconds = 0.6,
): number[] {
  const spectrum = spectrumOf(r, from, seconds);
  let total = 0;
  for (const p of spectrum.power) total += p;
  const result: number[] = [];
  for (let i = 0; i + 1 < edges.length; i++)
    result.push(
      toDb(bandPower(spectrum, edges[i], edges[i + 1] - 1e-9) / (total || 1)),
    );
  return result;
}

/**
 * Fundamental frequency in Hz by autocorrelation. The signal is first
 * restricted to the band around `expectedHz` (or, if the fundamental is
 * missing, to its first few harmonics), the autocorrelation is corrected for
 * the analysis window, and the period is refined over many cycles, so the
 * result is good to well under a cent for steady tones.
 */
export function estimatePitch(
  signal: ArrayLike<number>,
  sampleRate: number,
  expectedHz: number,
  start = 0,
  length = signal.length - start,
): number {
  const count = Math.max(0, Math.min(length, signal.length - start, 32768));
  const period = sampleRate / expectedHz;
  if (count < period * 3) return NaN;
  const size = nextPow2(count * 2);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const wr = new Float64Array(size);
  const wi = new Float64Array(size);
  let mean = 0;
  for (let i = 0; i < count; i++) mean += signal[start + i];
  mean /= count;
  for (let i = 0; i < count; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / count);
    re[i] = (signal[start + i] - mean) * w;
    wr[i] = w;
  }
  fft(re, im);
  fft(wr, wi);
  const binHz = sampleRate / size;
  const bandEnergy = (lowHz: number, highHz: number) => {
    let sum = 0;
    const to = Math.min(size / 2, Math.floor(highHz / binHz));
    for (let k = Math.max(1, Math.ceil(lowHz / binHz)); k <= to; k++)
      sum += re[k] * re[k] + im[k] * im[k];
    return sum;
  };
  const low = expectedHz * 0.62;
  let high = expectedHz * 1.6;
  if (bandEnergy(low, high) < 0.02 * bandEnergy(low, sampleRate / 2))
    high = expectedHz * 5.5;
  for (let k = 0; k <= size / 2; k++) {
    const hz = k * binHz;
    const power = hz >= low && hz <= high ? re[k] * re[k] + im[k] * im[k] : 0;
    re[k] = power;
    im[k] = 0;
    if (k > 0 && k < size / 2) {
      re[size - k] = power;
      im[size - k] = 0;
    }
    const windowPower = wr[k] * wr[k] + wi[k] * wi[k];
    wr[k] = windowPower;
    wi[k] = 0;
    if (k > 0 && k < size / 2) {
      wr[size - k] = windowPower;
      wi[size - k] = 0;
    }
  }
  fft(re, im, true);
  fft(wr, wi, true);
  const maxLag = Math.floor(count * 0.5);
  const acf = (lag: number) => re[lag] / wr[lag];
  const refine = (centre: number, radius: number): number => {
    const from = Math.max(2, Math.floor(centre - radius));
    const to = Math.min(maxLag - 2, Math.ceil(centre + radius));
    let best = from;
    for (let lag = from; lag <= to; lag++) if (acf(lag) > acf(best)) best = lag;
    const a = acf(best - 1);
    const b = acf(best);
    const c = acf(best + 1);
    const denominator = a - 2 * b + c;
    return denominator < 0 ? best + (0.5 * (a - c)) / denominator : best;
  };
  // ±2.6 semitones around the expected period, then follow the peak outwards
  let lag = refine(period, period * 0.16);
  let cycles = 1;
  while ((cycles * 2 + 0.5) * lag < maxLag && cycles < 512) {
    cycles *= 2;
    lag = refine(lag * 2, Math.min(lag * 0.25, period * 0.3));
  }
  return (sampleRate * cycles) / lag;
}

/**
 * Pitch error in cents against `midi` (positive = sharp), measured on the
 * mono sum from `from` seconds for up to `seconds`.
 */
export function centsError(
  r: Rendered,
  midi: number,
  from = 0.06,
  seconds = 0.6,
): number {
  const start = Math.min(r.frames, Math.round(from * r.sampleRate));
  const length = Math.min(r.frames - start, Math.round(seconds * r.sampleRate));
  const hz = estimatePitch(
    monoSum(r),
    r.sampleRate,
    midiToHz(midi),
    start,
    length,
  );
  return 1200 * Math.log2(hz / midiToHz(midi));
}

export interface ClickOptions {
  /** largest allowed |first sample| (default 0.01) */
  startLevel?: number;
  /**
   * largest allowed step between neighbours in the first 64 samples
   * (default 0.2). A larger step is still accepted when the rest of the note
   * steps just as much (a loud high note is not a click).
   */
  startJump?: number;
  /** largest allowed |sample| in the last 64 samples (default 0.003, about -50 dBFS) */
  endLevel?: number;
  /** largest allowed step between neighbours anywhere (default 0.6) */
  maxJump?: number;
  /**
   * largest allowed step around note-off as a multiple of the largest step in
   * the 20 ms before it (default 1.6); 0 disables the check (drums)
   */
  releaseJumpRatio?: number;
}

export interface ClickReport {
  ok: boolean;
  problems: string[];
  startLevel: number;
  startJump: number;
  endLevel: number;
  maxJump: number;
  /** step at note-off divided by the largest step just before it */
  releaseJumpRatio: number;
}

/**
 * Click check: the render must start and end at (near) zero, must not step
 * abruptly in its first 64 samples, anywhere, or when the note is released.
 */
export function checkClicks(
  r: Rendered,
  options: ClickOptions = {},
): ClickReport {
  const limits = {
    startLevel: options.startLevel ?? 0.01,
    startJump: options.startJump ?? 0.2,
    endLevel: options.endLevel ?? 0.003,
    maxJump: options.maxJump ?? 0.6,
    releaseJumpRatio: options.releaseJumpRatio ?? 1.6,
  };
  const { left, right, frames } = r;
  const edge = Math.min(64, frames);
  const step = (i: number) =>
    Math.max(
      Math.abs(left[i] - left[i - 1]),
      Math.abs(right[i] - right[i - 1]),
    );
  const startLevel = Math.max(Math.abs(left[0]), Math.abs(right[0]));
  let startJump = 0;
  for (let i = 1; i < edge; i++) startJump = Math.max(startJump, step(i));
  let endLevel = 0;
  for (let i = frames - edge; i < frames; i++)
    endLevel = Math.max(endLevel, Math.abs(left[i]), Math.abs(right[i]));
  let maxJump = 0;
  let laterJump = 0;
  for (let i = 1; i < frames; i++) {
    const s = step(i);
    if (s > maxJump) maxJump = s;
    if (i >= edge && s > laterJump) laterJump = s;
  }
  let releaseJumpRatio = 0;
  const hold = r.holdFrames;
  const before = Math.round(0.02 * r.sampleRate);
  if (limits.releaseJumpRatio > 0 && hold - before > 1 && hold + 24 < frames) {
    let usual = 0;
    for (let i = hold - before; i < hold - 8; i++)
      usual = Math.max(usual, step(i));
    let around = 0;
    for (let i = hold - 8; i <= hold + 24; i++)
      around = Math.max(around, step(i));
    releaseJumpRatio = around / (usual + 0.004);
  }
  const problems: string[] = [];
  if (startLevel > limits.startLevel)
    problems.push(`starts at ${startLevel.toFixed(4)} (limit ${limits.startLevel})`);
  if (startJump > limits.startJump && startJump > laterJump * 1.25)
    problems.push(`steps ${startJump.toFixed(3)} within the first 64 samples (limit ${limits.startJump})`);
  if (endLevel > limits.endLevel)
    problems.push(`ends at ${endLevel.toFixed(5)} (limit ${limits.endLevel})`);
  if (maxJump > limits.maxJump)
    problems.push(`steps ${maxJump.toFixed(3)} between two samples (limit ${limits.maxJump})`);
  if (limits.releaseJumpRatio > 0 && releaseJumpRatio > limits.releaseJumpRatio)
    problems.push(
      `note-off step is ${releaseJumpRatio.toFixed(2)}x the steps before it (limit ${limits.releaseJumpRatio})`,
    );
  return {
    ok: problems.length === 0,
    problems,
    startLevel,
    startJump,
    endLevel,
    maxJump,
    releaseJumpRatio,
  };
}

/** RMS in dBFS of the last `seconds` of the render: a finished tail reads below -60. */
export function tailDb(r: Rendered, seconds = 0.003): number {
  const duration = r.frames / r.sampleRate;
  return rmsDb(r, Math.max(0, duration - seconds), duration);
}

/** True when the last `seconds` are below `thresholdDb` dBFS RMS. */
export function tailIsSilent(
  r: Rendered,
  seconds = 0.003,
  thresholdDb = -60,
): boolean {
  return tailDb(r, seconds) <= thresholdDb;
}

/** Average render cost in nanoseconds per frame over `repeats` renders of the same note. */
export function measureCost(
  voice: Voice,
  note: VoiceNote,
  repeats = 8,
  sampleRate = SAMPLE_RATE,
): number {
  const frames = noteFrames(voice, note, sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const ctx = { sampleRate, random: createRng(1) };
  voice.render(left, right, frames, note, ctx);
  voice.render(left, right, frames, note, ctx);
  let best = Infinity;
  for (let i = 0; i < repeats; i++) {
    left.fill(0);
    right.fill(0);
    const started = performance.now();
    voice.render(left, right, frames, note, ctx);
    best = Math.min(best, performance.now() - started);
  }
  return (best * 1e6) / frames;
}

export interface ContractOptions {
  /** inclusive MIDI range the voice is used in (default [36, 96]) */
  range?: [low: number, high: number];
  /** semitones between tested pitches (default 5) */
  step?: number;
  sampleRate?: number;
  /** pitches of the level convention (default A3, D#4, A4) */
  levelMidis?: number[];
  /** target level in dBFS (default -18) and its tolerance (default 2) */
  levelDb?: number;
  levelTolerance?: number;
  /**
   * allowed deviation from levelDb for 1 s notes at vel 0.8 anywhere in the
   * range (default 6 dB); null skips the check
   */
  rangeLevelTolerance?: number | null;
  /** tuning tolerance in cents (default 10) */
  centsTolerance?: number;
  /** true for bells, noises and other voices without a single pitch: skips tuning */
  inharmonic?: boolean;
  /** velocities of the sweep (default [0.25, 0.6, 1]) */
  velocities?: number[];
  /** held durations of the sweep in seconds (default [0.04, 0.25, 1]); 8 s holds are added at three pitches */
  durations?: number[];
  /** allowed span of level(vel 1) - level(vel 0.4) in dB (default [6, 18]; vel^1.5 gives 11.9) */
  velocityLevelDb?: [min: number, max: number];
  /** centroid(vel 1) / centroid(vel 0.4) must be at least this (default 1.05) */
  minBrightnessRatio?: number;
  /** longest acceptable tail() in seconds (default 8) */
  maxTail?: number;
  /** largest acceptable |DC| for notes of 0.25 s or more (default 0.01) */
  maxDc?: number;
  /** smallest acceptable L/R correlation (default 0: never out of phase) */
  minCorrelation?: number;
  clicks?: ClickOptions;
  /** seeds averaged for the level convention (default [1, 2, 3, 4]) */
  seeds?: number[];
  /** second sample rate the voice must also work at (default 44100; 0 skips) */
  otherSampleRate?: number;
}

export interface ContractRow {
  midi: number;
  /** loudest-400 ms level of a 1 s note at vel 0.8, dBFS */
  levelDb: number;
  /** tuning error in cents (NaN when not measured) */
  cents: number;
  /** spectral centroid in Hz */
  centroid: number;
  peak: number;
  /** tail() in seconds */
  tail: number;
  correlation: number;
}

export interface ContractReport {
  id: string;
  /** empty when the voice honours the contract */
  failures: string[];
  /** level-convention pitches: mean over the seeds */
  levels: { midi: number; levelDb: number }[];
  /** one row per tested pitch (1 s, vel 0.8) */
  rows: ContractRow[];
  /** per level pitch: level(vel 1) - level(vel 0.4) and the centroid ratio */
  velocity: { midi: number; levelSpanDb: number; brightnessRatio: number }[];
  /** highest peak seen in any render (vel 1 included) */
  worstPeak: number;
  renders: number;
  /** mean wall-clock cost over the sweep */
  nsPerFrame: number;
}

/**
 * Run every check the Voice contract (voices/types.ts) asks for and return
 * the measurements plus a list of failures (empty = pass):
 *  - level: 1 s notes at vel 0.8 on `levelMidis` read levelDb ± levelTolerance
 *    over their loudest 400 ms (mean of several seeds), and stay within
 *    rangeLevelTolerance over the whole range;
 *  - never above |1.0|, finite, nothing written outside [0, frames);
 *  - click-free start, release and end for 40 ms .. 8 s notes at all velocities;
 *  - in tune within centsTolerance (also at a fractional pitch, after a bend
 *    and at a second sample rate);
 *  - velocity raises level AND brightness;
 *  - identical output for the same seeded ctx.random, no Math.random;
 *  - render() ADDS into the buffers.
 */
export function checkVoiceContract(
  voice: Voice,
  options: ContractOptions = {},
): ContractReport {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const [low, high] = options.range ?? [36, 96];
  const stepSize = options.step ?? 5;
  const levelMidis = options.levelMidis ?? [57, 63, 69];
  const levelDb = options.levelDb ?? -18;
  const levelTolerance = options.levelTolerance ?? 2;
  const rangeTolerance =
    options.rangeLevelTolerance === undefined ? 6 : options.rangeLevelTolerance;
  const centsTolerance = options.centsTolerance ?? 10;
  const velocities = options.velocities ?? [0.25, 0.6, 1];
  const durations = options.durations ?? [0.04, 0.25, 1];
  const [spanMin, spanMax] = options.velocityLevelDb ?? [6, 18];
  const minBrightness = options.minBrightnessRatio ?? 1.05;
  const maxTail = options.maxTail ?? 8;
  const maxDc = options.maxDc ?? 0.01;
  const minCorrelation = options.minCorrelation ?? 0;
  const seeds = options.seeds ?? [1, 2, 3, 4];
  const otherRate =
    options.otherSampleRate === undefined ? 44100 : options.otherSampleRate;
  const tune = !options.inharmonic;

  const failures: string[] = [];
  const fail = (message: string) => {
    if (failures.length < 60) failures.push(`${voice.id}: ${message}`);
  };
  const label = (note: VoiceNote, rate = sampleRate) =>
    `midi ${note.midi} vel ${note.vel} ${note.duration}s` +
    (note.bend ? ` bend ${note.bend}` : "") +
    (rate === sampleRate ? "" : ` @${rate}`);
  let worstPeak = 0;
  let renders = 0;
  let costSum = 0;

  /** Render + the checks every single render must pass. */
  const run = (
    note: VoiceNote,
    rate = sampleRate,
    seed = 1,
  ): Rendered | null => {
    const what = label(note, rate);
    const tail = voice.tail(note);
    if (!Number.isFinite(tail) || tail < 0 || tail > maxTail) {
      fail(`${what}: tail() = ${tail} (must be 0..${maxTail} s)`);
      return null;
    }
    let r: Rendered;
    try {
      r = renderNote(voice, note, rate, seed);
    } catch (error) {
      fail(`${what}: render threw ${(error as Error).message}`);
      return null;
    }
    renders++;
    costSum += r.nsPerFrame;
    if (!r.guardIntact) fail(`${what}: wrote beyond frames`);
    if (!isFiniteAudio(r)) {
      fail(`${what}: produced NaN or Infinity`);
      return null;
    }
    const p = peak(r);
    if (p > worstPeak) worstPeak = p;
    if (p > 1) fail(`${what}: peak ${p.toFixed(3)} exceeds 1.0`);
    const clicks = checkClicks(r, options.clicks);
    for (const problem of clicks.problems) fail(`${what}: ${problem}`);
    if (note.duration >= 0.25) {
      const dc = dcOffset(r);
      if (dc > maxDc) fail(`${what}: DC offset ${dc.toFixed(4)}`);
      const correlation = stereoCorrelation(r);
      if (correlation < minCorrelation)
        fail(`${what}: L/R correlation ${correlation.toFixed(2)}`);
    }
    return r;
  };

  const pitches: number[] = [];
  for (let midi = low; midi < high; midi += stepSize) pitches.push(midi);
  pitches.push(high);

  const originalRandom = Math.random;
  Math.random = () => {
    throw new Error("Math.random() used inside a voice");
  };
  try {
    // --- level convention -------------------------------------------------
    const levels: ContractReport["levels"] = [];
    for (const midi of levelMidis) {
      let power = 0;
      for (const seed of seeds) {
        const r = run({ midi, vel: 0.8, duration: 1 }, sampleRate, seed);
        const db = r ? loudestWindowDb(r) : -240;
        power += Math.pow(10, db / 10) / seeds.length;
        if (r && Math.abs(db - levelDb) > levelTolerance + 2)
          fail(
            `midi ${midi} seed ${seed}: level ${db.toFixed(1)} dBFS is more than ${levelTolerance + 2} dB from ${levelDb}`,
          );
      }
      const mean = toDb(power);
      levels.push({ midi, levelDb: mean });
      if (Math.abs(mean - levelDb) > levelTolerance)
        fail(
          `level convention: midi ${midi} at vel 0.8 reads ${mean.toFixed(1)} dBFS, want ${levelDb} ±${levelTolerance}`,
        );
    }

    // --- sweep over the range ---------------------------------------------
    const rows: ContractRow[] = [];
    for (const midi of pitches) {
      const reference = run({ midi, vel: 0.8, duration: 1 });
      if (reference) {
        const db = loudestWindowDb(reference);
        const cents = tune ? centsError(reference, midi) : NaN;
        rows.push({
          midi,
          levelDb: db,
          cents,
          centroid: centroidHz(reference),
          peak: peak(reference),
          tail: voice.tail({ midi, vel: 0.8, duration: 1 }),
          correlation: stereoCorrelation(reference),
        });
        if (rangeTolerance !== null && Math.abs(db - levelDb) > rangeTolerance)
          fail(
            `midi ${midi}: level ${db.toFixed(1)} dBFS is more than ${rangeTolerance} dB from ${levelDb}`,
          );
        if (tune && !(Math.abs(cents) <= centsTolerance))
          fail(`midi ${midi}: ${cents.toFixed(1)} cents off`);
      }
      for (const duration of durations)
        for (const vel of velocities) run({ midi, vel, duration });
    }
    for (const midi of [low, Math.round((low + high) / 2), high])
      run({ midi, vel: 0.7, duration: 8 });

    // --- velocity: louder and brighter ------------------------------------
    const velocity: ContractReport["velocity"] = [];
    for (const midi of levelMidis) {
      const soft = run({ midi, vel: 0.4, duration: 1 });
      const hard = run({ midi, vel: 1, duration: 1 });
      const softest = run({ midi, vel: 0.2, duration: 1 });
      if (!soft || !hard || !softest) continue;
      const span = loudestWindowDb(hard) - loudestWindowDb(soft);
      const ratio = centroidHz(hard) / Math.max(1, centroidHz(soft));
      velocity.push({ midi, levelSpanDb: span, brightnessRatio: ratio });
      if (span < spanMin || span > spanMax)
        fail(
          `midi ${midi}: vel 1 is ${span.toFixed(1)} dB above vel 0.4, want ${spanMin}..${spanMax}`,
        );
      if (loudestWindowDb(softest) >= loudestWindowDb(soft))
        fail(`midi ${midi}: vel 0.2 is not quieter than vel 0.4`);
      if (ratio < minBrightness)
        fail(
          `midi ${midi}: vel 1 is only ${ratio.toFixed(3)}x as bright as vel 0.4, want ${minBrightness}x`,
        );
    }

    // --- determinism and additivity ---------------------------------------
    const probe: VoiceNote = { midi: levelMidis[0], vel: 0.7, duration: 0.3 };
    const first = run(probe, sampleRate, 77);
    const second = run(probe, sampleRate, 77);
    if (first && second)
      for (let i = 0; i < first.frames; i++)
        if (
          first.left[i] !== second.left[i] ||
          first.right[i] !== second.right[i]
        ) {
          fail(`not deterministic for the same ctx.random (frame ${i})`);
          break;
        }
    if (first) {
      const offset = renderNote(voice, probe, sampleRate, 77, 0.25);
      if (!offset.guardIntact) fail("wrote beyond frames (prefilled buffers)");
      for (let i = 0; i < first.frames; i++)
        if (
          Math.abs(offset.left[i] - 0.25 - first.left[i]) > 1e-5 ||
          Math.abs(offset.right[i] - 0.25 - first.right[i]) > 1e-5
        ) {
          fail(`render() overwrites instead of adding (frame ${i})`);
          break;
        }
    }

    // --- pitch details ----------------------------------------------------
    const middle = levelMidis[Math.floor(levelMidis.length / 2)];
    if (tune) {
      const fractional = run({ midi: middle + 0.37, vel: 0.8, duration: 1 });
      if (fractional) {
        const cents = centsError(fractional, middle + 0.37);
        if (!(Math.abs(cents) <= centsTolerance))
          fail(`fractional midi ${middle + 0.37}: ${cents.toFixed(1)} cents off`);
      }
    }
    for (const bend of [2, -2]) {
      const bent = run({ midi: middle, vel: 0.8, duration: 1, bend });
      if (bent && tune) {
        const cents = centsError(bent, middle, 0.3, 0.5);
        if (!(Math.abs(cents) <= centsTolerance))
          fail(`bend ${bend}: settles ${cents.toFixed(1)} cents off`);
      }
    }
    if (otherRate && otherRate !== sampleRate) {
      const here = run({ midi: middle, vel: 0.8, duration: 1 });
      const there = run({ midi: middle, vel: 0.8, duration: 1 }, otherRate);
      if (here && there) {
        const difference = loudestWindowDb(there) - loudestWindowDb(here);
        if (Math.abs(difference) > 1.5)
          fail(
            `level changes by ${difference.toFixed(1)} dB at ${otherRate} Hz`,
          );
        if (tune) {
          const cents = centsError(there, middle);
          if (!(Math.abs(cents) <= centsTolerance))
            fail(`${cents.toFixed(1)} cents off at ${otherRate} Hz`);
        }
        const expected = Math.ceil(
          (1 + voice.tail({ midi: middle, vel: 0.8, duration: 1 })) * otherRate,
        );
        if (there.frames !== expected) fail("frame count mismatch");
      }
    }

    return {
      id: voice.id,
      failures,
      levels,
      rows,
      velocity,
      worstPeak,
      renders,
      nsPerFrame: renders ? costSum / renders : 0,
    };
  } finally {
    Math.random = originalRandom;
  }
}

/** checkVoiceContract(), throwing one Error that lists every failure. */
export function assertVoiceContract(
  voice: Voice,
  options: ContractOptions = {},
): ContractReport {
  const report = checkVoiceContract(voice, options);
  if (report.failures.length)
    throw new Error(
      `voice "${voice.id}" breaks the contract (${report.failures.length}):\n  ` +
        report.failures.join("\n  "),
    );
  return report;
}

/** Fixed-width table of a contract report for scratch scripts and test logs. */
export function formatReport(report: ContractReport): string {
  const lines = [
    `${report.id}: ${report.failures.length ? "FAIL" : "ok"}, ${report.renders} renders, ` +
      `peak ${report.worstPeak.toFixed(3)}, ${report.nsPerFrame.toFixed(0)} ns/frame ` +
      `(${(1e9 / SAMPLE_RATE / Math.max(1e-9, report.nsPerFrame)).toFixed(0)}x real time)`,
    `  level @0.8: ${report.levels.map((l) => `${l.midi}=${l.levelDb.toFixed(1)}`).join("  ")} dBFS`,
    `  velocity:   ${report.velocity
      .map(
        (v) =>
          `${v.midi}: +${v.levelSpanDb.toFixed(1)} dB, x${v.brightnessRatio.toFixed(2)} brighter`,
      )
      .join("  ")}`,
    "  midi  level   cents  centroid  peak   tail   corr",
  ];
  for (const row of report.rows)
    lines.push(
      `  ${String(row.midi).padStart(4)}  ${row.levelDb.toFixed(1).padStart(5)}  ` +
        `${(Number.isNaN(row.cents) ? "-" : row.cents.toFixed(1)).padStart(6)}  ` +
        `${row.centroid.toFixed(0).padStart(7)}  ${row.peak.toFixed(3)}  ` +
        `${row.tail.toFixed(2).padStart(5)}  ${row.correlation.toFixed(2).padStart(5)}`,
    );
  for (const failure of report.failures) lines.push(`  ! ${failure}`);
  return lines.join("\n");
}
