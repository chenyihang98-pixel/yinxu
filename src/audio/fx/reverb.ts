/**
 * Reverb: an 8-line feedback delay network.
 *
 *   in → low-cut → pre-delay → 6 all-pass diffusers per channel
 *      → 8 delay lines (mutually prime lengths scaled by `size`, 4 of them
 *        slowly modulated) → per-line shelving loss (RT60 at low and at high
 *        frequencies) → Hadamard mix → back into the lines
 *      → two orthogonal sums of the line outputs = decorrelated left / right
 *
 * Level convention: a centred, stationary source comes back with the same RMS
 * per channel as it went in (the impulse response of each channel has unit
 * energy at low and mid frequencies), whatever the decay and size. The caller
 * sets the wet level.
 */
import { Biquad, TAU, clamp, freeBuffer, nextPow2 } from "../dsp";
import { ANTI_DENORMAL, loopSyncedRate, nextPrime } from "./common";
import type { SendFx } from "./common";

export interface ReverbSettings {
  /** 0..1 perceived room size (scales the delay lengths) */
  size: number;
  /** RT60 in seconds at low and mid frequencies */
  decay: number;
  /** 0..1: how much faster the highs die away */
  damping: number;
  /** seconds before the reverb starts */
  preDelay: number;
}

export interface ReverbOptions {
  /** length of the piece when it loops: modulation is then periodic with it */
  loopSeconds?: number;
  /** high-pass on the reverb input in Hz (default 150, 0 = off) */
  lowCutHz?: number;
  /** 0..1 depth of the delay-line modulation (default 1) */
  modulation?: number;
}

/** Delay lengths in ms at size-scale 1; spread so no two share a common echo period. */
const LINE_MS = [11.3, 17.9, 25.7, 33.1, 41.9, 52.3, 64.9, 79.3];
/** Diffuser delays in ms: six for the left input, then six for the right. */
const DIFFUSER_MS = [
  1.31, 2.13, 3.61, 4.79, 9.29, 12.71, 1.49, 2.39, 3.89, 5.11, 8.69, 11.93,
];
const DIFFUSER_GAIN = [0.65, 0.65, 0.7, 0.7, 0.6, 0.6];
/** Modulation of lines 1, 3, 5 and 7: rate in Hz and starting phase in cycles. */
const MOD_HZ = [0.31, 0.47, 0.73, 1.03];
const MOD_PHASE = [0, 0.27, 0.53, 0.81];
/** Peak excursion of a modulated line in seconds. */
const MOD_DEPTH = 0.00015;
const LN_1000 = 6.907755278982137;
/** The sample counter wraps here; every buffer length divides it. */
const POSITION_MASK = 0x3fffffff;

/** Ratio of the RT60 at high frequencies to the RT60 at low frequencies for a `damping` of 0..1. */
export function dampingRatio(damping: number): number {
  return 0.1 + 0.9 * Math.pow(1 - clamp(damping, 0, 1), 1.2);
}

/** Frequency in Hz around which the decay changes from its low to its high value. */
export function dampingCorner(damping: number): number {
  return 6000 * Math.pow(1 / 3, clamp(damping, 0, 1));
}

/** How far `size` (0..1) stretches the delay network; a short decay cannot fill a large room. */
export function sizeScale(size: number, decay: number): number {
  const wanted = 0.45 + 1.25 * clamp(size, 0, 1);
  return Math.min(wanted, 0.25 + 0.6 * Math.max(decay, 0.1));
}

export class Reverb implements SendFx {
  /** seconds until the tail is 60 dB down, including pre-delay and diffusion */
  readonly tailSeconds: number;
  /** delay-line lengths in samples */
  readonly lengths: number[];
  private readonly lines: Float64Array;
  private readonly mask: number;
  private readonly diffusers: Float64Array;
  private readonly diffuserMask: number;
  private readonly diffuserLength: number[];
  private readonly preLeft: Float64Array;
  private readonly preRight: Float64Array;
  private readonly preMask: number;
  private readonly preLength: number;
  /** per-line gain (including the 1/√8 of the mixing matrix) and shelf ratio */
  private readonly gain = new Float64Array(8);
  private readonly shelf = new Float64Array(8);
  private readonly lowpass = new Float64Array(8);
  private readonly lowpassCoef: number;
  private readonly lowCut: Biquad | null;
  private readonly lowCutState = new Float64Array(4);
  private readonly modDepth: number;
  private readonly modSin = new Float64Array(4);
  private readonly modCos = new Float64Array(4);
  private readonly modStepSin = new Float64Array(4);
  private readonly modStepCos = new Float64Array(4);
  /** radians per sample of the four line LFOs */
  private readonly modStep = new Float64Array(4);
  private readonly outGain: number;
  private readonly earlyGain: number;
  private position = 0;
  private workLeft = new Float32Array(0);
  private workRight = new Float32Array(0);

  constructor(
    sampleRate: number,
    settings: ReverbSettings,
    options: ReverbOptions = {},
  ) {
    const decay = clamp(settings.decay, 0.1, 30);
    const scale = sizeScale(settings.size, decay);
    const lengths: number[] = [];
    for (const ms of LINE_MS) {
      let length = nextPrime(Math.round((ms * scale * sampleRate) / 1000));
      while (lengths.includes(length)) length = nextPrime(length + 1);
      lengths.push(length);
    }
    this.lengths = lengths;
    const modulation = clamp(options.modulation ?? 1, 0, 1);
    this.modDepth = Math.min(
      MOD_DEPTH * sampleRate * modulation,
      lengths[1] / 8,
    );
    const size = nextPow2(lengths[7] + Math.ceil(this.modDepth) + 4);
    this.lines = new Float64Array(size * 8);
    this.mask = size - 1;

    this.diffuserLength = DIFFUSER_MS.map((ms) =>
      nextPrime(Math.round((ms * sampleRate) / 1000)),
    );
    const diffuserSize = nextPow2(Math.max(...this.diffuserLength) + 2);
    this.diffusers = new Float64Array(diffuserSize * DIFFUSER_MS.length);
    this.diffuserMask = diffuserSize - 1;

    this.preLength = Math.max(
      0,
      Math.round(clamp(settings.preDelay, 0, 1) * sampleRate),
    );
    const preSize = nextPow2(this.preLength + 2);
    this.preLeft = new Float64Array(preSize);
    this.preRight = new Float64Array(preSize);
    this.preMask = preSize - 1;

    // each line loses exactly what its length owes to the RT60, at DC and at Nyquist
    const ratio = dampingRatio(settings.damping);
    let total = 0;
    for (let i = 0; i < 8; i++) {
      const low = Math.exp((-LN_1000 * lengths[i]) / (decay * sampleRate));
      this.gain[i] = low * Math.SQRT1_2 * 0.5;
      this.shelf[i] = Math.pow(low, 1 / ratio - 1);
      total += lengths[i];
    }
    this.lowpassCoef =
      1 - Math.exp((-TAU * dampingCorner(settings.damping)) / sampleRate);

    const lowCutHz = options.lowCutHz ?? 150;
    this.lowCut =
      lowCutHz > 0
        ? new Biquad().setHighpass(lowCutHz, Math.SQRT1_2, sampleRate)
        : null;

    for (let i = 0; i < 4; i++) {
      const hz = loopSyncedRate(MOD_HZ[i], options.loopSeconds);
      const step = (TAU * hz) / sampleRate;
      this.modStep[i] = step;
      this.modStepSin[i] = Math.sin(step);
      this.modStepCos[i] = Math.cos(step);
    }
    this.seek(0);

    // energy time constant in samples: stored energy falls by e every tau samples
    const tau = (decay * sampleRate) / (2 * LN_1000);
    this.outGain = Math.sqrt(total / (16 * tau));
    // fills the gap before the shortest line answers, at the level the tail starts with
    this.earlyGain = 0.8 * Math.sqrt(lengths[0] / tau);
    this.tailSeconds = decay + this.preLength / sampleRate + 0.06;
  }

  /** One input channel through low-cut, pre-delay and its six all-pass diffusers. */
  private diffuse(
    input: Float32Array,
    out: Float32Array,
    n: number,
    channel: 0 | 1,
  ): void {
    const buffer = this.diffusers;
    const mask = this.diffuserMask;
    const size = mask + 1;
    const lengths = this.diffuserLength;
    const first = channel * 6;
    const o0 = first * size;
    const o1 = o0 + size;
    const o2 = o1 + size;
    const o3 = o2 + size;
    const o4 = o3 + size;
    const o5 = o4 + size;
    const a0 = lengths[first];
    const a1 = lengths[first + 1];
    const a2 = lengths[first + 2];
    const a3 = lengths[first + 3];
    const a4 = lengths[first + 4];
    const a5 = lengths[first + 5];
    const [c0, c1, c2, c3, c4, c5] = DIFFUSER_GAIN;
    const pre = channel ? this.preRight : this.preLeft;
    const preMask = this.preMask;
    const preLength = this.preLength;
    const cut = this.lowCut;
    const b0 = cut ? cut.b0 : 1;
    const b1 = cut ? cut.b1 : 0;
    const b2 = cut ? cut.b2 : 0;
    const f1 = cut ? cut.a1 : 0;
    const f2 = cut ? cut.a2 : 0;
    const state = this.lowCutState;
    let z1 = state[channel * 2];
    let z2 = state[channel * 2 + 1];
    let w = this.position;
    for (let i = 0; i < n; i++) {
      let x = input[i] + ANTI_DENORMAL;
      const y = b0 * x + z1;
      z1 = b1 * x - f1 * y + z2;
      z2 = b2 * x - f2 * y;
      pre[w & preMask] = y;
      x = pre[(w - preLength) & preMask] + ANTI_DENORMAL;
      const dw = w & mask;
      let d = buffer[o0 + ((w - a0) & mask)];
      let v = x + c0 * d;
      buffer[o0 + dw] = v;
      x = d - c0 * v;
      d = buffer[o1 + ((w - a1) & mask)];
      v = x + c1 * d;
      buffer[o1 + dw] = v;
      x = d - c1 * v;
      d = buffer[o2 + ((w - a2) & mask)];
      v = x + c2 * d;
      buffer[o2 + dw] = v;
      x = d - c2 * v;
      d = buffer[o3 + ((w - a3) & mask)];
      v = x + c3 * d;
      buffer[o3 + dw] = v;
      x = d - c3 * v;
      d = buffer[o4 + ((w - a4) & mask)];
      v = x + c4 * d;
      buffer[o4 + dw] = v;
      x = d - c4 * v;
      d = buffer[o5 + ((w - a5) & mask)];
      v = x + c5 * d;
      buffer[o5 + dw] = v;
      out[i] = d - c5 * v;
      w = (w + 1) & POSITION_MASK;
    }
    state[channel * 2] = z1;
    state[channel * 2 + 1] = z2;
  }

  process(
    inLeft: Float32Array,
    inRight: Float32Array,
    outLeft: Float32Array,
    outRight: Float32Array,
    n: number,
  ): void {
    if (this.workLeft.length < n) {
      this.workLeft = new Float32Array(n);
      this.workRight = new Float32Array(n);
    }
    const workLeft = this.workLeft;
    const workRight = this.workRight;
    this.diffuse(inLeft, workLeft, n, 0);
    this.diffuse(inRight, workRight, n, 1);

    const lines = this.lines;
    const mask = this.mask;
    const size = mask + 1;
    const o1 = size;
    const o2 = size * 2;
    const o3 = size * 3;
    const o4 = size * 4;
    const o5 = size * 5;
    const o6 = size * 6;
    const o7 = size * 7;
    const [n0, n1, n2, n3, n4, n5, n6, n7] = this.lengths;
    const gain = this.gain;
    const shelf = this.shelf;
    const g0 = gain[0];
    const g1 = gain[1];
    const g2 = gain[2];
    const g3 = gain[3];
    const g4 = gain[4];
    const g5 = gain[5];
    const g6 = gain[6];
    const g7 = gain[7];
    const r0 = shelf[0];
    const r1 = shelf[1];
    const r2 = shelf[2];
    const r3 = shelf[3];
    const r4 = shelf[4];
    const r5 = shelf[5];
    const r6 = shelf[6];
    const r7 = shelf[7];
    const lowpass = this.lowpass;
    let p0 = lowpass[0];
    let p1 = lowpass[1];
    let p2 = lowpass[2];
    let p3 = lowpass[3];
    let p4 = lowpass[4];
    let p5 = lowpass[5];
    let p6 = lowpass[6];
    let p7 = lowpass[7];
    const k = this.lowpassCoef;

    const depth = this.modDepth;
    const modSin = this.modSin;
    const modCos = this.modCos;
    let s1 = modSin[0];
    let q1 = modCos[0];
    let s3 = modSin[1];
    let q3 = modCos[1];
    let s5 = modSin[2];
    let q5 = modCos[2];
    let s7 = modSin[3];
    let q7 = modCos[3];
    const ss1 = this.modStepSin[0];
    const sc1 = this.modStepCos[0];
    const ss3 = this.modStepSin[1];
    const sc3 = this.modStepCos[1];
    const ss5 = this.modStepSin[2];
    const sc5 = this.modStepCos[2];
    const ss7 = this.modStepSin[3];
    const sc7 = this.modStepCos[3];

    const outGain = this.outGain;
    const early = this.earlyGain;
    let w = this.position;

    for (let i = 0; i < n; i++) {
      const xl = workLeft[i];
      const xr = workRight[i];

      // line outputs: even lines fixed, odd lines read through a moving tap
      const t0 = lines[(w - n0) & mask];
      const t2 = lines[o2 + ((w - n2) & mask)];
      const t4 = lines[o4 + ((w - n4) & mask)];
      const t6 = lines[o6 + ((w - n6) & mask)];

      let delay = n1 + depth * s1;
      let whole = delay | 0;
      let near = lines[o1 + ((w - whole) & mask)];
      const t1 =
        near + (lines[o1 + ((w - whole - 1) & mask)] - near) * (delay - whole);
      delay = n3 + depth * s3;
      whole = delay | 0;
      near = lines[o3 + ((w - whole) & mask)];
      const t3 =
        near + (lines[o3 + ((w - whole - 1) & mask)] - near) * (delay - whole);
      delay = n5 + depth * s5;
      whole = delay | 0;
      near = lines[o5 + ((w - whole) & mask)];
      const t5 =
        near + (lines[o5 + ((w - whole - 1) & mask)] - near) * (delay - whole);
      delay = n7 + depth * s7;
      whole = delay | 0;
      near = lines[o7 + ((w - whole) & mask)];
      const t7 =
        near + (lines[o7 + ((w - whole - 1) & mask)] - near) * (delay - whole);

      let next = s1 * sc1 + q1 * ss1;
      q1 = q1 * sc1 - s1 * ss1;
      s1 = next;
      next = s3 * sc3 + q3 * ss3;
      q3 = q3 * sc3 - s3 * ss3;
      s3 = next;
      next = s5 * sc5 + q5 * ss5;
      q5 = q5 * sc5 - s5 * ss5;
      s5 = next;
      next = s7 * sc7 + q7 * ss7;
      q7 = q7 * sc7 - s7 * ss7;
      s7 = next;

      // per-line loss: unity at DC, `r` at Nyquist, times the RT60 gain
      p0 += k * (t0 - p0);
      const f0 = g0 * (p0 + r0 * (t0 - p0));
      p1 += k * (t1 - p1);
      const f1 = g1 * (p1 + r1 * (t1 - p1));
      p2 += k * (t2 - p2);
      const f2 = g2 * (p2 + r2 * (t2 - p2));
      p3 += k * (t3 - p3);
      const f3 = g3 * (p3 + r3 * (t3 - p3));
      p4 += k * (t4 - p4);
      const f4 = g4 * (p4 + r4 * (t4 - p4));
      p5 += k * (t5 - p5);
      const f5 = g5 * (p5 + r5 * (t5 - p5));
      p6 += k * (t6 - p6);
      const f6 = g6 * (p6 + r6 * (t6 - p6));
      p7 += k * (t7 - p7);
      const f7 = g7 * (p7 + r7 * (t7 - p7));

      // Hadamard mix (the 1/√8 lives in g0..g7)
      const h0 = f0 + f1;
      const h1 = f0 - f1;
      const h2 = f2 + f3;
      const h3 = f2 - f3;
      const h4 = f4 + f5;
      const h5 = f4 - f5;
      const h6 = f6 + f7;
      const h7 = f6 - f7;
      const m0 = h0 + h2;
      const m1 = h1 + h3;
      const m2 = h0 - h2;
      const m3 = h1 - h3;
      const m4 = h4 + h6;
      const m5 = h5 + h7;
      const m6 = h4 - h6;
      const m7 = h5 - h7;

      const il = xl * 0.5 + ANTI_DENORMAL;
      const ir = xr * 0.5 + ANTI_DENORMAL;
      const lw = w & mask;
      lines[lw] = m0 + m4 + il;
      lines[o1 + lw] = m1 + m5 + ir;
      lines[o2 + lw] = m2 + m6 - il;
      lines[o3 + lw] = m3 + m7 - ir;
      lines[o4 + lw] = m0 - m4 + il;
      lines[o5 + lw] = m1 - m5 + ir;
      lines[o6 + lw] = m2 - m6 - il;
      lines[o7 + lw] = m3 - m7 - ir;

      outLeft[i] =
        (t0 + t1 + t2 + t3 - t4 - t5 - t6 - t7) * outGain + xl * early;
      outRight[i] =
        (t0 - t1 + t2 - t3 + t4 - t5 + t6 - t7) * outGain + xr * early;
      w = (w + 1) & POSITION_MASK;
    }

    lowpass[0] = p0;
    lowpass[1] = p1;
    lowpass[2] = p2;
    lowpass[3] = p3;
    lowpass[4] = p4;
    lowpass[5] = p5;
    lowpass[6] = p6;
    lowpass[7] = p7;
    modSin[0] = s1;
    modCos[0] = q1;
    modSin[1] = s3;
    modCos[1] = q3;
    modSin[2] = s5;
    modCos[2] = q5;
    modSin[3] = s7;
    modCos[3] = q7;
    this.position = w;
  }

  /** Give the delay lines (a megabyte) back at once; the reverb must not be used afterwards. */
  release(): void {
    freeBuffer(this.lines);
    freeBuffer(this.diffusers);
    freeBuffer(this.preLeft);
    freeBuffer(this.preRight);
  }

  seek(frame: number): void {
    for (let i = 0; i < 4; i++) {
      const angle = TAU * MOD_PHASE[i] + this.modStep[i] * frame;
      this.modSin[i] = Math.sin(angle);
      this.modCos[i] = Math.cos(angle);
    }
  }

  /** Empty every delay and filter and rewind the modulation. */
  reset(): void {
    this.lines.fill(0);
    this.diffusers.fill(0);
    this.preLeft.fill(0);
    this.preRight.fill(0);
    this.lowpass.fill(0);
    this.lowCutState.fill(0);
    this.seek(0);
    this.position = 0;
  }
}
