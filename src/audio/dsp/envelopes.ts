/**
 * Envelopes. Nothing here can produce a step: attacks and releases are at
 * least MIN_RAMP long, and releases end on EXACTLY zero after their nominal
 * time (the exponential aims slightly below zero and is clamped).
 */
import { LN_60DB, clamp01 } from "./math";

/** Shortest attack / fade any envelope will produce, in seconds. */
export const MIN_RAMP = 0.0015;
/**
 * Shortest exponential decay or release (time to reach zero), in seconds.
 * An exponential falls fastest at its start, so it needs four times the
 * linear minimum to stay as smooth.
 */
export const MIN_FALL = MIN_RAMP * 4;

/** "exp" = analog-style (fast then slowing), "lin" = straight, "cos" = S-curve (softest). */
export type AttackShape = "exp" | "lin" | "cos";

export interface AdsrParams {
  /** seconds from 0 to 1 */
  attack: number;
  /** seconds a fall from 1 to 0 would take; the fall stops at `sustain` */
  decay: number;
  /** 0..1 */
  sustain: number;
  /** seconds from 1 to exactly 0 (about -60 dB at 90 % of it) */
  release: number;
  attackShape?: AttackShape;
}

const ATTACK_RATIO = 0.3;
const FALL_RATIO = 0.001;

const IDLE = 0;
const ATTACK = 1;
const DECAY = 2;
const SUSTAIN = 3;
const RELEASE = 4;
const DONE = 5;

function fallCoef(samples: number): number {
  return Math.exp(-Math.log((1 + FALL_RATIO) / FALL_RATIO) / samples);
}

/**
 * ADSR with exponential decay/release. Use next()/gate()/release() for
 * streaming, or render() to write the whole envelope of one note.
 */
export class Adsr {
  /** current level, 0..1 */
  value = 0;
  private stage = IDLE;
  private readonly sampleRate: number;
  private shape: AttackShape = "exp";
  private attackSamples = 1;
  private attackCoef = 0;
  private attackBase = 0;
  private attackFrom = 0;
  private attackIndex = 0;
  private decayCoef = 0;
  private decayBase = 0;
  private sustain = 1;
  private releaseSamples = 1;
  private releaseCoef = 0;
  private releaseBase = 0;

  constructor(sampleRate: number, params: AdsrParams) {
    this.sampleRate = sampleRate;
    this.set(params);
  }

  /** Change the times/levels; takes effect from the next sample. */
  set(params: AdsrParams): void {
    const sr = this.sampleRate;
    this.shape = params.attackShape ?? "exp";
    this.attackSamples = Math.max(params.attack, MIN_RAMP) * sr;
    this.attackCoef = Math.exp(
      -Math.log((1 + ATTACK_RATIO) / ATTACK_RATIO) / this.attackSamples,
    );
    this.attackBase = (1 + ATTACK_RATIO) * (1 - this.attackCoef);
    this.sustain = clamp01(params.sustain);
    this.decayCoef = fallCoef(Math.max(params.decay, MIN_FALL) * sr);
    this.decayBase = (this.sustain - FALL_RATIO) * (1 - this.decayCoef);
    this.releaseSamples = Math.max(params.release, MIN_FALL) * sr;
    this.releaseCoef = fallCoef(this.releaseSamples);
    this.releaseBase = -FALL_RATIO * (1 - this.releaseCoef);
  }

  /** Note-on: start the attack from the current level. */
  gate(): void {
    this.stage = ATTACK;
    this.attackFrom = this.value;
    this.attackIndex = 0;
  }

  /** Note-off: start the release from the current level. */
  release(): void {
    if (this.stage !== IDLE && this.stage !== DONE)
      this.stage = RELEASE;
  }

  /** True once the release has reached zero. */
  get done(): boolean {
    return this.stage === DONE;
  }

  /** Advance one sample and return the level. */
  next(): number {
    let v = this.value;
    switch (this.stage) {
      case ATTACK: {
        if (this.shape === "exp") {
          v = this.attackBase + v * this.attackCoef;
        } else {
          const x = ++this.attackIndex / this.attackSamples;
          const curve =
            this.shape === "cos" ? 0.5 - 0.5 * Math.cos(Math.PI * x) : x;
          v = this.attackFrom + (1 - this.attackFrom) * curve;
          if (x >= 1) v = 1;
        }
        if (v >= 1) {
          v = 1;
          this.stage = DECAY;
        }
        break;
      }
      case DECAY:
        v = this.decayBase + v * this.decayCoef;
        if (v <= this.sustain) {
          v = this.sustain;
          this.stage = SUSTAIN;
        }
        break;
      case RELEASE:
        v = this.releaseBase + v * this.releaseCoef;
        if (v <= 0) {
          v = 0;
          this.stage = DONE;
        }
        break;
      default:
        break;
    }
    this.value = v;
    return v;
  }

  /**
   * Write the envelope of one note into out[0..frames): gate at 0, release at
   * `holdFrames`. The release is shortened if needed so out[frames - 1] is 0.
   */
  render(out: Float32Array, frames: number, holdFrames: number): void {
    if (frames <= 0) return;
    const minFall = Math.ceil(MIN_FALL * this.sampleRate);
    let hold = Math.round(holdFrames);
    if (hold > frames - 1 - minFall) hold = frames - 1 - minFall;
    if (hold < 1) hold = Math.min(1, frames - 1);
    this.value = 0;
    this.gate();
    for (let i = 0; i < hold; i++) out[i] = this.next();
    const room = frames - 1 - hold;
    const savedCoef = this.releaseCoef;
    const savedBase = this.releaseBase;
    if (room < this.releaseSamples) {
      this.releaseCoef = fallCoef(Math.max(1, room));
      this.releaseBase = -FALL_RATIO * (1 - this.releaseCoef);
    }
    this.release();
    for (let i = hold; i < frames; i++) out[i] = this.next();
    out[frames - 1] = 0;
    this.releaseCoef = savedCoef;
    this.releaseBase = savedBase;
  }
}

/** Write the ADSR of one note (held `holdSeconds`) into out[0..frames). */
export function adsr(
  out: Float32Array,
  frames: number,
  sampleRate: number,
  params: AdsrParams,
  holdSeconds: number,
): void {
  new Adsr(sampleRate, params).render(out, frames, holdSeconds * sampleRate);
}

/** Free-running exponential decay: next() returns the level, then multiplies it by `coef`. */
export class ExpDecay {
  value: number;
  coef: number;

  /** Decays 60 dB in `t60` seconds, starting from `start`. */
  constructor(t60: number, sampleRate: number, start = 1) {
    this.value = start;
    this.coef = Math.exp(-LN_60DB / (Math.max(t60, 1e-5) * sampleRate));
  }

  /** Current level, then decay one sample. */
  next(): number {
    const v = this.value;
    this.value = v * this.coef;
    return v;
  }
}

export interface EnvSegment {
  /** level reached at the end of the segment */
  to: number;
  /** seconds */
  time: number;
  /** 0 = linear, > 0 = fast start (exponential approach), < 0 = slow start */
  curve?: number;
}

/**
 * Piecewise envelope through any number of exponential/linear segments; each
 * segment lands exactly on its target and the last level is held.
 */
export class SegmentEnvelope {
  /** current level */
  value: number;
  private readonly sampleRate: number;
  private readonly segments: EnvSegment[];
  private index = -1;
  private remaining = 0;
  private from = 0;
  private span = 0;
  private decay = 1;
  private factor = 1;
  private norm = 1;
  private step = 0;

  constructor(sampleRate: number, start: number, segments: EnvSegment[]) {
    this.sampleRate = sampleRate;
    this.value = start;
    this.segments = segments;
    this.advance();
  }

  private advance(): void {
    this.index++;
    const segment = this.segments[this.index];
    if (!segment) {
      this.remaining = Infinity;
      this.span = 0;
      this.step = 0;
      this.from = this.value;
      this.norm = 0;
      return;
    }
    const samples = Math.max(1, Math.round(segment.time * this.sampleRate));
    const curve = segment.curve ?? 0;
    this.remaining = samples;
    this.from = this.value;
    this.span = segment.to - this.value;
    if (Math.abs(curve) < 1e-3) {
      this.norm = 0;
      this.step = this.span / samples;
    } else {
      this.norm = 1 / (1 - Math.exp(-curve));
      this.factor = Math.exp(-curve / samples);
      this.decay = 1;
    }
  }

  /** Advance one sample and return the level. */
  next(): number {
    if (this.remaining === Infinity) return this.value;
    if (this.norm === 0) this.value += this.step;
    else {
      this.decay *= this.factor;
      this.value = this.from + this.span * (1 - this.decay) * this.norm;
    }
    if (--this.remaining <= 0) {
      this.value = this.from + this.span;
      this.advance();
    }
    return this.value;
  }

  /** Write the next `frames` levels into out[offset ..). */
  render(out: Float32Array, frames: number, offset = 0): void {
    for (let i = 0; i < frames; i++) out[offset + i] = this.next();
  }
}

/** Raised-cosine fade-in over the first `fadeFrames` samples of buf (in place). */
export function fadeIn(
  buf: Float32Array,
  frames: number,
  fadeFrames: number,
): void {
  const n = Math.min(Math.floor(fadeFrames), frames);
  for (let i = 0; i < n; i++)
    buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
}

/** Raised-cosine fade-out so buf[frames - 1] is exactly 0 (in place). */
export function fadeOut(
  buf: Float32Array,
  frames: number,
  fadeFrames: number,
): void {
  const n = Math.min(Math.floor(fadeFrames), frames);
  const start = frames - n;
  for (let i = 0; i < n; i++)
    buf[start + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / n);
}

/** Safety fades on both channels: guarantees a zero first and last sample. */
export function declick(
  left: Float32Array,
  right: Float32Array,
  frames: number,
  sampleRate: number,
  fadeInSeconds = 0.001,
  fadeOutSeconds = 0.004,
): void {
  const head = Math.max(2, Math.round(fadeInSeconds * sampleRate));
  const tail = Math.max(2, Math.round(fadeOutSeconds * sampleRate));
  fadeIn(left, frames, head);
  fadeIn(right, frames, head);
  fadeOut(left, frames, tail);
  fadeOut(right, frames, tail);
}
