/**
 * Tempo-synced ping-pong delay for PartMix.delay. The send is summed to mono,
 * the first echo lands on the left after `time`, the next on the right after
 * 2 × `time`, and so on; every repeat is `feedback` times the one before and
 * passes a band-limiting filter again, so the echoes get darker and thinner
 * and stay behind the dry part.
 */
import { clamp, nextPow2 } from "../dsp";
import { ANTI_DENORMAL } from "./common";
import type { SendFx } from "./common";

export interface DelayOptions {
  /** low-pass in the echo path, Hz (default 4200) */
  dampHz?: number;
  /** high-pass in the echo path, Hz (default 180) */
  lowCutHz?: number;
  /** 0..1: how much of each echo also appears on the other side (default 0.2) */
  spill?: number;
}

export class PingPongDelay implements SendFx {
  /** echo spacing in samples */
  readonly delayFrames: number;
  /** seconds until the echoes are 60 dB down */
  readonly tailSeconds: number;
  readonly feedback: number;
  private readonly lineA: Float32Array;
  private readonly lineB: Float32Array;
  private readonly mask: number;
  private readonly lowCoef: number;
  private readonly highCoef: number;
  private readonly near: number;
  private readonly far: number;
  private lowA = 0;
  private highA = 0;
  private lowB = 0;
  private highB = 0;
  private position = 0;

  constructor(
    sampleRate: number,
    time: number,
    feedback: number,
    options: DelayOptions = {},
  ) {
    this.delayFrames = Math.max(
      1,
      Math.round(clamp(time, 0.001, 4) * sampleRate),
    );
    this.feedback = clamp(feedback, 0, 0.92);
    const size = nextPow2(this.delayFrames + 2);
    this.lineA = new Float32Array(size);
    this.lineB = new Float32Array(size);
    this.mask = size - 1;
    this.lowCoef =
      1 - Math.exp((-2 * Math.PI * (options.dampHz ?? 4200)) / sampleRate);
    this.highCoef =
      1 - Math.exp((-2 * Math.PI * (options.lowCutHz ?? 180)) / sampleRate);
    const spill = clamp(options.spill ?? 0.2, 0, 1);
    // equal-power placement of each echo: mostly one side, a little on the other
    const angle = ((1 - spill) * Math.PI) / 4;
    this.near = Math.cos(Math.PI / 4 - angle);
    this.far = Math.sin(Math.PI / 4 - angle);
    const repeats =
      this.feedback > 0.001 ? Math.log(0.001) / Math.log(this.feedback) : 1;
    this.tailSeconds = Math.min(
      60,
      (this.delayFrames / sampleRate) * (repeats + 1),
    );
  }

  process(
    inLeft: Float32Array,
    inRight: Float32Array,
    outLeft: Float32Array,
    outRight: Float32Array,
    n: number,
  ): void {
    const lineA = this.lineA;
    const lineB = this.lineB;
    const mask = this.mask;
    const delay = this.delayFrames;
    const feedback = this.feedback;
    const lowCoef = this.lowCoef;
    const highCoef = this.highCoef;
    const near = this.near;
    const far = this.far;
    let lowA = this.lowA;
    let highA = this.highA;
    let lowB = this.lowB;
    let highB = this.highB;
    let w = this.position;
    for (let i = 0; i < n; i++) {
      const input = (inLeft[i] + inRight[i]) * 0.5 + ANTI_DENORMAL;
      const read = (w - delay) & mask;
      const a = lineA[read];
      const b = lineB[read];
      // into A: the new sound plus what comes back from B, band-limited
      let x = input + feedback * b;
      lowA += lowCoef * (x - lowA);
      highA += highCoef * (lowA - highA);
      lineA[w] = lowA - highA;
      // into B: what just left A
      x = feedback * a + ANTI_DENORMAL;
      lowB += lowCoef * (x - lowB);
      highB += highCoef * (lowB - highB);
      lineB[w] = lowB - highB;
      outLeft[i] = a * near + b * far;
      outRight[i] = b * near + a * far;
      w = (w + 1) & mask;
    }
    this.lowA = lowA;
    this.highA = highA;
    this.lowB = lowB;
    this.highB = highB;
    this.position = w;
  }

  reset(): void {
    this.lineA.fill(0);
    this.lineB.fill(0);
    this.lowA = this.highA = this.lowB = this.highB = 0;
    this.position = 0;
  }
}
