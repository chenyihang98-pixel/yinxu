/**
 * Helpers shared by the keys and plucked voice groups (not re-exported from
 * the dsp index: import them from "../dsp/extra-keys").
 *
 *  - struckPower(): mean power of a set of decaying partials over the level
 *    window, including the beating of partials that sit a few Hz apart;
 *  - LevelTable: a lazily MEASURED level per (pitch, velocity) for voices
 *    whose level cannot be written down (FM, time-varying filters, clippers);
 *  - mixNote(): attack ramp, safety fade, ceiling guard and the final ADD.
 */
import { LN_60DB, TAU, clamp } from "./math";
import { createRng } from "./rng";
import type { Random } from "./rng";
import { LEVEL_WINDOW } from "./voice";

/** Mean of e^(-s·t) over [0, T]. */
export function expMean(s: number, T: number): number {
  const x = s * T;
  return x < 1e-6 ? 1 : (1 - Math.exp(-x)) / x;
}

/** Partials closer than this many Hz beat inside the level window instead of adding as powers. */
const COHERENT_HZ = 12;

/**
 * Mean power (average of the two channels) over the first `window` seconds
 * of `count` decaying sine partials that all start at phase 0:
 * amp[k] · e^(-6.91 t / t60[k]) · sin(2π hz[k] t), heard at gains gl[k] / gr[k].
 * Partials within 12 Hz of each other are treated as coherent (they start in
 * phase and drift apart), everything else as incoherent. `window` 0 gives
 * the power at the very start.
 */
export function struckPower(
  count: number,
  hz: ArrayLike<number>,
  amp: ArrayLike<number>,
  t60: ArrayLike<number>,
  gl: ArrayLike<number>,
  gr: ArrayLike<number>,
  window: number,
): number {
  let power = 0;
  for (let i = 0; i < count; i++) {
    const si = LN_60DB / Math.max(t60[i], 1e-4);
    power +=
      0.25 *
      (gl[i] * gl[i] + gr[i] * gr[i]) *
      amp[i] *
      amp[i] *
      expMean(2 * si, window);
    for (let j = i + 1; j < count; j++) {
      const difference = hz[j] - hz[i];
      if (difference > COHERENT_HZ || difference < -COHERENT_HZ) continue;
      const s = si + LN_60DB / Math.max(t60[j], 1e-4);
      const w = TAU * difference;
      let cross = 1;
      if (window > 0) {
        const decay = Math.exp(-s * window);
        cross =
          (s * (1 - decay * Math.cos(w * window)) +
            w * decay * Math.sin(w * window)) /
          ((s * s + w * w) * window);
      }
      power += 0.5 * (gl[i] * gl[j] + gr[i] * gr[j]) * amp[i] * amp[j] * cross;
    }
  }
  return power;
}

/** Renders one unit-gain note of a voice for LevelTable (buffers are zeroed, `frames` long). */
export type LevelProbe = (
  left: Float32Array,
  right: Float32Array,
  frames: number,
  midi: number,
  vel: number,
  sampleRate: number,
  random: Random,
) => void;

export interface LevelTableOptions {
  /** inclusive MIDI span of the grid; pitches outside use the nearest column */
  low: number;
  high: number;
  /** semitones between grid columns */
  step: number;
  /** ascending velocities of the grid rows */
  velocities: readonly number[];
  /** seconds rendered per probe (default 0.6: the level window plus room for an attack) */
  seconds?: number;
  probe: LevelProbe;
}

const PROBE_SEED = 0x6b657973;

/**
 * Loudest-window RMS of a voice at unit gain, measured on first use and
 * interpolated over pitch and velocity. A voice divides REFERENCE_RMS by
 * rms() to honour the level convention when its level has no closed form.
 * Grid points are rendered lazily (about a millisecond each, once per sample
 * rate), with a fixed seed, so the result never depends on the caller's
 * random stream. Call rms() BEFORE touching any shared state of the voice:
 * the probe renders through the same code.
 */
export class LevelTable {
  private readonly options: LevelTableOptions;
  private readonly columns: number;
  private readonly rows: number;
  private readonly tables = new Map<number, Float64Array>();
  private left = new Float32Array(0);
  private right = new Float32Array(0);

  constructor(options: LevelTableOptions) {
    this.options = options;
    this.columns =
      Math.max(1, Math.ceil((options.high - options.low) / options.step)) + 1;
    this.rows = options.velocities.length;
  }

  private measure(sampleRate: number, column: number, row: number): number {
    const { low, step, velocities, probe } = this.options;
    const frames = Math.ceil((this.options.seconds ?? 0.6) * sampleRate);
    if (this.left.length < frames) {
      this.left = new Float32Array(frames);
      this.right = new Float32Array(frames);
    }
    const left = this.left;
    const right = this.right;
    left.fill(0, 0, frames);
    right.fill(0, 0, frames);
    probe(
      left,
      right,
      frames,
      low + column * step,
      velocities[row],
      sampleRate,
      createRng(PROBE_SEED),
    );
    const size = Math.min(frames, Math.round(LEVEL_WINDOW * sampleRate));
    let sum = 0;
    for (let i = 0; i < size; i++)
      sum += left[i] * left[i] + right[i] * right[i];
    let best = sum;
    for (let i = size; i < frames; i++) {
      const j = i - size;
      sum +=
        left[i] * left[i] +
        right[i] * right[i] -
        left[j] * left[j] -
        right[j] * right[j];
      if (sum > best) best = sum;
    }
    return Math.sqrt(Math.max(best, 1e-30) / (2 * size));
  }

  private at(sampleRate: number, column: number, row: number): number {
    let table = this.tables.get(sampleRate);
    if (!table) {
      table = new Float64Array(this.columns * this.rows);
      this.tables.set(sampleRate, table);
    }
    const index = column * this.rows + row;
    let value = table[index];
    if (value === 0) {
      value = this.measure(sampleRate, column, row);
      table[index] = value;
    }
    return value;
  }

  /** Loudest-400 ms RMS (average channel power) of a held note at unit gain. */
  rms(midi: number, vel: number, sampleRate: number): number {
    const { low, step, velocities } = this.options;
    const position = clamp((midi - low) / step, 0, this.columns - 1);
    const column = Math.min(this.columns - 2, Math.floor(position));
    const x = this.columns > 1 ? position - column : 0;
    let row = 0;
    while (row < this.rows - 2 && vel > velocities[row + 1]) row++;
    let y = 0;
    if (this.rows > 1)
      y = clamp(
        (vel - velocities[row]) / (velocities[row + 1] - velocities[row]),
        0,
        1,
      );
    const c0 = Math.max(0, column);
    const c1 = Math.min(this.columns - 1, c0 + 1);
    const r1 = Math.min(this.rows - 1, row + 1);
    // bilinear in the log domain (levels are smooth in dB); a corner with no
    // weight is never measured
    let level = 0;
    const corner = (c: number, r: number, weight: number) => {
      if (weight > 0) level += weight * Math.log(this.at(sampleRate, c, r));
    };
    corner(c0, row, (1 - x) * (1 - y));
    corner(c1, row, x * (1 - y));
    corner(c0, r1, (1 - x) * y);
    corner(c1, r1, x * y);
    return Math.exp(level);
  }
}

/** Highest peak a single note may reach at full velocity (see velocityCeiling). */
export const PEAK_CEILING = 0.9;

/**
 * Peak allowed for a note of this velocity: PEAK_CEILING at vel 1, falling
 * with the velocity law (vel^1.5) below it. The level convention asks short
 * sounds for more peak than exists (a 0.3 s ring would need +3 dBFS to read
 * -18 dBFS RMS over 400 ms); capping every velocity by the same law keeps
 * such notes as loud as they can be while a harder hit is still exactly as
 * much louder as on any other voice.
 */
export function velocityCeiling(vel: number): number {
  const v = vel < 0.02 ? 0.02 : vel > 1 ? 1 : vel;
  return PEAK_CEILING * v * Math.sqrt(v);
}

/**
 * Last stage of a voice: ADD l/r (the note at unit gain) into left/right at
 * `gain`, with a raised-cosine ramp over the first `attackFrames` and a
 * raised-cosine fade to exactly zero over the last `fadeFrames`. If the peak
 * would pass `ceiling` (normally velocityCeiling(vel)) the whole note is
 * turned down to it, so the contract ceiling |1.0| can never be exceeded.
 * l/r are modified in place.
 */
export function mixNote(
  left: Float32Array,
  right: Float32Array,
  l: Float32Array,
  r: Float32Array,
  frames: number,
  gain: number,
  attackFrames: number,
  fadeFrames: number,
  ceiling: number,
): void {
  const attack = Math.min(frames, Math.max(0, Math.round(attackFrames)));
  for (let i = 0; i < attack; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
    l[i] *= g;
    r[i] *= g;
  }
  const fade = Math.min(frames, Math.max(1, Math.round(fadeFrames)));
  const fadeStart = frames - fade;
  for (let i = fadeStart; i < frames; i++) {
    const g = 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeStart + 1)) / fade);
    l[i] *= g;
    r[i] *= g;
  }
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const a = l[i] < 0 ? -l[i] : l[i];
    const b = r[i] < 0 ? -r[i] : r[i];
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const level = peak * gain > ceiling ? ceiling / peak : gain;
  for (let i = 0; i < frames; i++) {
    left[i] += l[i] * level;
    right[i] += r[i] * level;
  }
}
