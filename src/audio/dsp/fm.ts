/**
 * Phase-modulation ("FM") operator on the shared sine wavetable. Chain them
 * by passing one operator's output (times a modulation index in radians)
 * as the next one's `pm` argument.
 */
import { sinTurns } from "./osc";

const INV_TAU = 1 / (Math.PI * 2);

export class FmOperator {
  /** 0..1 */
  phase: number;
  /** hz / sampleRate */
  inc = 0;
  /** self-modulation in radians per unit of output (0..~1.5); adds saw-like brightness */
  feedback = 0;
  private last = 0;

  constructor(hz = 440, sampleRate = 48000, phase = 0) {
    this.phase = phase - Math.floor(phase);
    this.inc = hz / sampleRate;
  }

  /** Operator frequency in Hz (carrier or modulator = ratio × note frequency). */
  setFreq(hz: number, sampleRate: number): void {
    this.inc = hz / sampleRate;
  }

  /** sin(2π·phase + pm + feedback·previous) — `pm` in radians — then advance. */
  next(pm = 0): number {
    const out = sinTurns(
      this.phase + (pm + this.feedback * this.last) * INV_TAU,
    );
    this.last = out;
    let phase = this.phase + this.inc;
    if (phase >= 1) phase -= 1;
    this.phase = phase;
    return out;
  }

  /** Restart at `phase` (0..1) and clear the feedback memory. */
  reset(phase = 0): void {
    this.phase = phase - Math.floor(phase);
    this.last = 0;
  }
}

/**
 * ADD a two-operator FM tone into out[0..n): carrier at `carrierInc`,
 * modulator at `modInc` (both hz / sampleRate), modulation index in radians
 * read per sample from `index[i]` (e.g. a decaying envelope), amplitude from
 * `amp[i]`. Returns nothing; phases start at 0 so the tone starts at zero.
 */
export function addFmPair(
  out: Float32Array,
  n: number,
  carrierInc: number,
  modInc: number,
  index: Float32Array,
  amp: Float32Array,
  gain = 1,
): void {
  let pc = 0;
  let pm = 0;
  for (let i = 0; i < n; i++) {
    const m = sinTurns(pm);
    out[i] += gain * amp[i] * sinTurns(pc + index[i] * m * INV_TAU);
    pc += carrierInc;
    if (pc >= 1) pc -= 1;
    pm += modInc;
    if (pm >= 1) pm -= 1;
  }
}
