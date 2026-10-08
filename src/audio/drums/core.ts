/**
 * Shared machinery of the drum synthesizer: the per-hit state every engine
 * writes into, a reseedable noise source, scratch buffers and the block
 * helpers the engines are composed from.
 *
 * An engine renders ONE hit at unit level into `hit.mid` (and `hit.side` when
 * it is stereo: left = mid·panL + side, right = mid·panR − side). Level,
 * velocity law, safety fades and the final ADD belong to drums.ts.
 * Everything here is module state: one hit at a time per JS realm.
 */
import type { DrumKind, DrumKitId } from "../../music/score";
import { Biquad, LN_60DB, ModalBank, fastTanh, sinPhase } from "../dsp";

/** Every kit except the console one, which has an engine of its own. */
export type Kit = Exclude<DrumKitId, "chip">;

/** [frequency in Hz, level, seconds to -60 dB] of one resonant mode. */
export type Mode = readonly [hz: number, level: number, t60: number];

/** A family of drum kinds: how long a hit is and how to render it. */
export interface Engine<K extends DrumKind> {
  length(kind: K, kit: Kit): number;
  render(h: Hit, kind: K, kit: Kit): void;
}

/**
 * White noise in [-1, 1) (xorshift32), reseeded for every hit. restart()
 * begins a fresh stream that depends only on the seed and on how many
 * restarts came before — not on how many samples were drawn — so cutting a
 * hit short never changes the noise of its later layers.
 */
export class Noise {
  private state = 0x1234567;
  private base = 0;
  private streams = 0;

  seed(seed: number): void {
    this.base = seed | 0;
    this.streams = 0;
    this.restart();
  }

  restart(): void {
    // murmur3 finaliser: neighbouring seeds and streams must not resemble each other
    let x = (this.base + Math.imul(this.streams++, 0x9e3779b1)) | 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    this.state = x === 0 ? 0x1234567 : x;
  }

  /** Next sample in [-1, 1). */
  next(): number {
    let s = this.state;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.state = s;
    return s / 2147483648;
  }

  /** Next value in [0, 1). */
  uniform(): number {
    return this.next() * 0.5 + 0.5;
  }

  /** Next value in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * (this.next() * 0.5 + 0.5);
  }

  /** Overwrite out[0..n) with gain·noise. */
  fill(out: Float32Array, n: number, gain: number): void {
    let s = this.state;
    const scale = gain / 2147483648;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      out[i] = s * scale;
    }
    this.state = s;
  }
}

export interface Hit {
  sr: number;
  /** frames to render: min(frames of the caller, natural length) */
  n: number;
  /** 0.02..1 */
  vel: number;
  /**
   * √(sr / 48000). White noise multiplied by it has the same density per Hz
   * at every sample rate, so a filtered band keeps its level.
   */
  nd: number;
  /** audio noise of the hit */
  noise: Noise;
  /** a second, independent stream for the side channel */
  noise2: Noise;
  /** choices (table offsets, grain timing, jitter) */
  dice: Noise;
  mid: Float32Array;
  side: Float32Array;
  /** set by the engine when it wrote `side` */
  wide: boolean;
  /** -1..1 position of `mid` */
  pan: number;
  /** linear level correction the engine wants applied after calibration */
  trim: number;
  /** post-processing the engine asks drums.ts for (0 = off) */
  drive: number;
  /**
   * the peak the drive is relative to; 0 = the measured peak of the hit
   * (engines whose peak comes late set it, so a cut hit is driven the same)
   */
  driveLevel: number;
  /** low-pass corner in Hz */
  lowpass: number;
  /** 0..1 noise riding on the signal (dusty sampler) */
  grit: number;
  /** 0..1 level of the early reflections (mono unless the hit is wide) */
  room: number;
}

const pool: Float32Array[] = [];

/** Zeroed scratch buffer of at least n samples; slots 0 and 1 are the hit's mid and side. */
export function work(slot: number, n: number): Float32Array {
  let buffer = pool[slot];
  if (!buffer || buffer.length < n) {
    buffer = new Float32Array(Math.ceil(n * 1.25) + 256);
    pool[slot] = buffer;
  } else buffer.fill(0, 0, n);
  return buffer;
}

/** Per-sample factor of a decay that falls 60 dB in `t60` seconds. */
export function fall(t60: number, sr: number): number {
  return Math.exp(-LN_60DB / (Math.max(t60, 1e-4) * sr));
}

/** Samples until a decay of `t60` has fallen by `db`, at most n. */
export function span(t60: number, sr: number, n: number, db = 80): number {
  return Math.min(n, Math.ceil((t60 * sr * db) / 60) + 1);
}

/** a at vel 0, b at vel 1. */
export function byVel(h: Hit, a: number, b: number): number {
  return a + (b - a) * h.vel;
}

/**
 * Multiply buf[0..n) by an envelope: raised-cosine rise over `attack`
 * seconds, level 1 until `hold` seconds, then a T60 decay.
 */
export function shape(
  buf: Float32Array,
  n: number,
  sr: number,
  attack: number,
  t60: number,
  hold = 0,
): void {
  const rise = Math.min(n, Math.max(1, Math.round(attack * sr)));
  for (let i = 0; i < rise; i++)
    buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / rise);
  const k = fall(t60, sr);
  let a = 1;
  for (let i = Math.max(0, Math.round(hold * sr)); i < n; i++) {
    buf[i] *= a;
    a *= k;
  }
}

/** ADD gain·src into out over [0, n). */
export function mix(
  out: Float32Array,
  src: Float32Array,
  n: number,
  gain: number,
): void {
  for (let i = 0; i < n; i++) out[i] += gain * src[i];
}

/** ADD gain·src[0..count) into out starting at `delay`, never past out[n). */
export function mixDelayed(
  out: Float32Array,
  src: Float32Array,
  count: number,
  gain: number,
  delay: number,
  n: number,
): void {
  const end = Math.min(count, n - delay);
  for (let i = 0; i < end; i++) out[i + delay] += gain * src[i];
}

const filterA = new Biquad();
const filterB = new Biquad();

/** RMS of unit white noise (times `nd`) after a 0 dB band-pass at hz with quality q. */
function bandRms(hz: number, q: number): number {
  return 0.5774 * Math.sqrt((Math.PI * hz) / (48000 * q));
}

/**
 * Overwrite out[0..n) with band-passed noise of RMS 1: centre `hz`, quality
 * `q` (bandwidth hz / q). No energy at DC.
 */
export function bandNoise(
  h: Hit,
  out: Float32Array,
  n: number,
  hz: number,
  q: number,
  source: Noise = h.noise,
): void {
  const centre = Math.min(hz, h.sr * 0.42);
  source.restart();
  source.fill(out, n, h.nd / bandRms(centre, q));
  filterA.setBandpass(centre, q, h.sr).reset();
  filterA.process(out, n);
}

/** Overwrite out[0..n) with noise high-passed at `hz` (12 dB/octave), RMS about 1. */
export function highNoise(
  h: Hit,
  out: Float32Array,
  n: number,
  hz: number,
  source: Noise = h.noise,
): void {
  const corner = Math.min(hz, h.sr * 0.42);
  const rms = 0.5774 * Math.sqrt(Math.max(0.05, (24000 - corner) / 24000));
  source.restart();
  source.fill(out, n, h.nd / rms);
  filterA.setHighpass(corner, 0.7071, h.sr).reset();
  filterA.process(out, n);
}

/**
 * Index after the last sample of buf[0..n) that is not silent. Filters stop
 * a few cycles after it: running one over a long run of zeros lets its state
 * decay into denormal numbers, which are extremely slow to compute with.
 */
export function active(buf: Float32Array, n: number): number {
  let i = n;
  while (i > 0 && buf[i - 1] > -1e-12 && buf[i - 1] < 1e-12) i--;
  return i;
}

/** How far past the last audible sample a filter with this corner still rings. */
function ringOut(buf: Float32Array, n: number, hz: number, sr: number): number {
  return Math.min(n, active(buf, n) + Math.ceil((8 * sr) / hz));
}

/** In-place 12 dB/octave low-pass. */
export function lowpass(
  buf: Float32Array,
  n: number,
  hz: number,
  sr: number,
  q = 0.62,
): void {
  if (hz <= 0 || hz >= sr * 0.45) return;
  filterB.setLowpass(hz, q, sr).reset();
  filterB.process(buf, ringOut(buf, n, hz, sr));
}

/** In-place 12 dB/octave high-pass. */
export function highpass(
  buf: Float32Array,
  n: number,
  hz: number,
  sr: number,
  q = 0.7071,
): void {
  if (hz <= 0) return;
  const corner = Math.min(hz, sr * 0.42);
  filterB.setHighpass(corner, q, sr).reset();
  filterB.process(buf, ringOut(buf, n, corner, sr));
}

/** In-place tanh drive that keeps full scale at full scale; drive 0 leaves the signal alone. */
export function saturate(buf: Float32Array, n: number, drive: number): void {
  if (drive < 0.03) return;
  const norm = 1 / fastTanh(drive);
  for (let i = 0; i < n; i++) buf[i] = fastTanh(buf[i] * drive) * norm;
}

const bank = new ModalBank(64);
// a mode 74 dB under a unit-level hit is done (hits are scaled down further on the way out)
bank.silence = 2e-4;

/**
 * ADD a decaying sine that glides from `fromHz` to `hz` (time constant
 * `tau`) into out[0..n). Starts at zero.
 */
export function sweep(
  out: Float32Array,
  n: number,
  sr: number,
  hz: number,
  fromHz: number,
  tau: number,
  level: number,
  t60: number,
): void {
  const k = fall(t60, sr);
  const glide = Math.exp(-1 / (Math.max(tau, 1e-4) * sr));
  const end = span(t60, sr, n);
  const base = hz / sr;
  let offset = (fromHz - hz) / sr;
  let phase = 0;
  let a = level;
  for (let i = 0; i < end; i++) {
    out[i] += a * sinPhase(phase);
    phase += base + offset;
    if (phase >= 1) phase -= 1;
    offset *= glide;
    a *= k;
  }
}

/**
 * ADD a struck set of modes into out[0..n): every mode is a decaying sine
 * that starts at zero. `tune` scales the frequencies, `stretch` the decays,
 * `tilt` weights a mode by (hz / centre)^tilt, centre being the
 * energy-weighted mean pitch of the set: positive is brighter at about the
 * same level.
 */
export function ring(
  out: Float32Array,
  n: number,
  sr: number,
  modes: readonly Mode[],
  gain = 1,
  tune = 1,
  stretch = 1,
  tilt = 0,
): void {
  let count = 0;
  let centre = 1;
  if (tilt !== 0 && modes.length) {
    let log = 0;
    let weight = 0;
    for (const mode of modes) {
      log += mode[1] * mode[1] * Math.log(mode[0]);
      weight += mode[1] * mode[1];
    }
    centre = Math.exp(log / Math.max(weight, 1e-9));
  }
  for (const [hz, level, t60] of modes) {
    const f = hz * tune;
    if (f >= sr * 0.45 || count >= bank.capacity) continue;
    const weight = tilt === 0 ? level : level * Math.pow(hz / centre, tilt);
    bank.set(count++, f, t60 * stretch, weight, sr);
  }
  bank.count = count;
  if (!count) return;
  bank.strike();
  bank.render(out, 0, n, gain);
}

/**
 * The same, with every mode doubled by a twin `beat` Hz away (scaled by a
 * per-mode factor from `dice`), so the pair shimmers slowly.
 */
export function ringPairs(
  out: Float32Array,
  n: number,
  sr: number,
  modes: readonly Mode[],
  gain: number,
  tune: number,
  stretch: number,
  beat: number,
  dice: Noise,
): void {
  let count = 0;
  for (const [hz, level, t60] of modes) {
    const f = hz * tune;
    if (f >= sr * 0.45 || count + 2 > bank.capacity) continue;
    const offset = beat * dice.range(0.5, 1.5);
    bank.set(count++, f, t60 * stretch, level * 0.6, sr);
    bank.set(count++, f + offset, t60 * stretch * 0.93, level * 0.4, sr);
  }
  bank.count = count;
  if (!count) return;
  bank.strike();
  bank.render(out, 0, n, gain);
}
