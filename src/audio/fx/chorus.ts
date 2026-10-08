/**
 * Stereo chorus / ensemble for PartMix.chorus. Each channel is read back
 * through two slowly moving taps; the right channel's taps run a quarter
 * cycle behind the left ones, which spreads a mono source across the field.
 * The dry signal always stays, so a mono fold-down keeps its level and only
 * loses some of the shimmer.
 */
import { TAU, clamp01, nextPow2 } from "../dsp";
import { ANTI_DENORMAL, loopSyncedRate } from "./common";
import type { InsertFx } from "./common";

export interface ChorusOptions {
  /** length of the piece when it loops: the LFOs are then periodic with it */
  loopSeconds?: number;
}

/** Centre delay, peak excursion (seconds) and LFO rate (Hz) of the two taps. */
const TAP_A = { delay: 0.0075, depth: 0.0022, hz: 0.53, phase: 0 };
const TAP_B = { delay: 0.0125, depth: 0.0017, hz: 0.89, phase: 0.37 };

/** Dry and per-tap wet gain for an amount of 0..1 (constant power for uncorrelated taps). */
export function chorusGains(amount: number): { dry: number; wet: number } {
  const wet = 0.5 * clamp01(amount);
  return { dry: Math.sqrt(1 - 2 * wet * wet), wet };
}

export class Chorus implements InsertFx {
  readonly amount: number;
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly mask: number;
  private readonly baseA: number;
  private readonly baseB: number;
  private readonly depthA: number;
  private readonly depthB: number;
  private readonly dry: number;
  private readonly wet: number;
  /** LFO state: sin A, cos A, sin B, cos B and the per-sample rotation of each */
  private readonly lfo = new Float64Array(4);
  private readonly rotation = new Float64Array(4);
  /** radians per sample of the two LFOs */
  private readonly step = new Float64Array(2);
  private position = 0;

  constructor(sampleRate: number, amount: number, options: ChorusOptions = {}) {
    this.amount = clamp01(amount);
    const gains = chorusGains(this.amount);
    this.dry = gains.dry;
    this.wet = gains.wet;
    // a deeper sweep as the amount rises, never less than 60 % of full
    const sweep = 0.6 + 0.4 * this.amount;
    this.baseA = TAP_A.delay * sampleRate;
    this.baseB = TAP_B.delay * sampleRate;
    this.depthA = TAP_A.depth * sweep * sampleRate;
    this.depthB = TAP_B.depth * sweep * sampleRate;
    const size = nextPow2(Math.ceil(this.baseB + this.depthB) + 8);
    this.left = new Float32Array(size);
    this.right = new Float32Array(size);
    this.mask = size - 1;
    [TAP_A, TAP_B].forEach((tap, index) => {
      const step =
        (TAU * loopSyncedRate(tap.hz, options.loopSeconds)) / sampleRate;
      this.step[index] = step;
      this.rotation[index * 2] = Math.sin(step);
      this.rotation[index * 2 + 1] = Math.cos(step);
    });
    this.seek(0);
  }

  seek(frame: number): void {
    [TAP_A, TAP_B].forEach((tap, index) => {
      const angle = TAU * tap.phase + this.step[index] * frame;
      this.lfo[index * 2] = Math.sin(angle);
      this.lfo[index * 2 + 1] = Math.cos(angle);
    });
  }

  process(left: Float32Array, right: Float32Array, n: number): void {
    const bufL = this.left;
    const bufR = this.right;
    const mask = this.mask;
    const { baseA, baseB, depthA, depthB, dry, wet } = this;
    let sinA = this.lfo[0];
    let cosA = this.lfo[1];
    let sinB = this.lfo[2];
    let cosB = this.lfo[3];
    const stepSinA = this.rotation[0];
    const stepCosA = this.rotation[1];
    const stepSinB = this.rotation[2];
    const stepCosB = this.rotation[3];
    let w = this.position;
    for (let i = 0; i < n; i++) {
      const xl = left[i] + ANTI_DENORMAL;
      const xr = right[i] + ANTI_DENORMAL;
      bufL[w] = xl;
      bufR[w] = xr;

      // Each tap is a 4-point Hermite read. The right taps trail the left
      // ones by a quarter cycle (cos instead of sin).
      let delay = baseA + depthA * sinA;
      let whole = delay | 0;
      let t = delay - whole;
      let at = w - whole;
      let x0 = bufL[at & mask];
      let x1 = bufL[(at - 1) & mask];
      let c = (x1 - bufL[(at + 1) & mask]) * 0.5;
      let v = x0 - x1;
      let u = c + v;
      let a = u + v + (bufL[(at - 2) & mask] - x0) * 0.5;
      let wetL = ((a * t - (u + a)) * t + c) * t + x0;

      delay = baseB + depthB * sinB;
      whole = delay | 0;
      t = delay - whole;
      at = w - whole;
      x0 = bufL[at & mask];
      x1 = bufL[(at - 1) & mask];
      c = (x1 - bufL[(at + 1) & mask]) * 0.5;
      v = x0 - x1;
      u = c + v;
      a = u + v + (bufL[(at - 2) & mask] - x0) * 0.5;
      // the second tap is inverted: below about 50 Hz the two cancel, so the
      // chorus thickens the body of the sound without swelling its bass
      wetL -= ((a * t - (u + a)) * t + c) * t + x0;

      delay = baseA + depthA * cosA;
      whole = delay | 0;
      t = delay - whole;
      at = w - whole;
      x0 = bufR[at & mask];
      x1 = bufR[(at - 1) & mask];
      c = (x1 - bufR[(at + 1) & mask]) * 0.5;
      v = x0 - x1;
      u = c + v;
      a = u + v + (bufR[(at - 2) & mask] - x0) * 0.5;
      let wetR = ((a * t - (u + a)) * t + c) * t + x0;

      delay = baseB + depthB * cosB;
      whole = delay | 0;
      t = delay - whole;
      at = w - whole;
      x0 = bufR[at & mask];
      x1 = bufR[(at - 1) & mask];
      c = (x1 - bufR[(at + 1) & mask]) * 0.5;
      v = x0 - x1;
      u = c + v;
      a = u + v + (bufR[(at - 2) & mask] - x0) * 0.5;
      wetR -= ((a * t - (u + a)) * t + c) * t + x0;

      left[i] = dry * xl + wet * wetL;
      right[i] = dry * xr + wet * wetR;

      let next = sinA * stepCosA + cosA * stepSinA;
      cosA = cosA * stepCosA - sinA * stepSinA;
      sinA = next;
      next = sinB * stepCosB + cosB * stepSinB;
      cosB = cosB * stepCosB - sinB * stepSinB;
      sinB = next;
      w = (w + 1) & mask;
    }
    this.lfo[0] = sinA;
    this.lfo[1] = cosA;
    this.lfo[2] = sinB;
    this.lfo[3] = cosB;
    this.position = w;
  }
}
