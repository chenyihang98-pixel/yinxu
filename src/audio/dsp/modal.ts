/**
 * Modal synthesis: a bank of two-pole resonators, one per partial, each with
 * its own frequency, decay (T60) and gain. Two ways to use it:
 *
 *  - strike(): every mode becomes an exact decaying sinusoid
 *    amp · e^(-t/τ) · sin(2π f t) that starts at zero (no click), then
 *    render()/renderStereo() add the free-ringing bank a block at a time
 *    (about 0.7 ns per mode per sample; a mode stops costing anything once
 *    it has decayed below `silence`);
 *  - next(input): the bank as a resonant filter driven by an excitation
 *    signal (noise burst, mallet pulse …).
 */
import { LN_60DB, TAU } from "./math";

const CHUNK = 1024;

export class ModalBank {
  /** number of modes in use (set by the last set() index + 1, or directly) */
  count = 0;
  readonly capacity: number;
  /**
   * Amplitude below which render()/renderStereo() stop computing a mode
   * (default 1e-6 = -120 dBFS; 0 keeps every mode running forever).
   */
  silence = 1e-6;
  private readonly asleep: Uint8Array;
  private readonly order: Int32Array;
  private readonly coef: Float64Array; // 2 r cos(w)
  private readonly r2: Float64Array; // r²
  private readonly radius: Float64Array; // r
  private readonly sinW: Float64Array;
  private readonly cosW: Float64Array;
  private readonly amp: Float64Array;
  private readonly y1: Float64Array;
  private readonly y2: Float64Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.coef = new Float64Array(capacity);
    this.r2 = new Float64Array(capacity);
    this.radius = new Float64Array(capacity);
    this.sinW = new Float64Array(capacity);
    this.cosW = new Float64Array(capacity);
    this.amp = new Float64Array(capacity);
    this.y1 = new Float64Array(capacity);
    this.y2 = new Float64Array(capacity);
    this.asleep = new Uint8Array(capacity);
    this.order = new Int32Array(capacity);
  }

  /** List the modes that still ring in `order`; returns how many. */
  private collectAwake(): number {
    let awake = 0;
    for (let m = 0; m < this.count; m++)
      if (!this.asleep[m]) this.order[awake++] = m;
    return awake;
  }

  /** Save the state of mode m after a block and put it to sleep once it has faded. */
  private store(m: number, y1: number, y2: number): void {
    this.y1[m] = y1;
    this.y2[m] = y2;
    if (this.faded(m, y1, y2)) this.asleep[m] = 1;
  }

  /** True when mode m (state y1, y2 after a block) has decayed below `silence`. */
  private faded(m: number, y1: number, y2: number): boolean {
    // amplitude² · sin²(w) of a decaying sinusoid from two consecutive samples
    const z = this.radius[m] * y2;
    const s = this.silence * this.sinW[m];
    return y1 * y1 + z * z - 2 * this.cosW[m] * y1 * z < s * s;
  }

  /** Define mode `i`: frequency in Hz (below Nyquist), T60 in seconds, linear amplitude. */
  set(
    i: number,
    hz: number,
    t60: number,
    amp: number,
    sampleRate: number,
  ): void {
    const w = (TAU * hz) / sampleRate;
    this.sinW[i] = Math.sin(w);
    this.cosW[i] = Math.cos(w);
    this.amp[i] = amp;
    this.setDecay(i, t60, sampleRate);
    if (i >= this.count) this.count = i + 1;
  }

  /** Change the T60 of mode `i` while it rings (dampers, pedal, choke). */
  setDecay(i: number, t60: number, sampleRate: number): void {
    const r = Math.exp(-LN_60DB / (Math.max(t60, 1e-4) * sampleRate));
    this.radius[i] = r;
    this.coef[i] = 2 * r * this.cosW[i];
    this.r2[i] = r * r;
  }

  /** Scale every decay time by `factor` (< 1 damps) while the bank rings. */
  scaleDecay(factor: number): void {
    for (let i = 0; i < this.count; i++) {
      const r = Math.pow(this.radius[i], 1 / Math.max(factor, 1e-4));
      this.radius[i] = r;
      this.coef[i] = 2 * r * this.cosW[i];
      this.r2[i] = r * r;
    }
  }

  /**
   * Start every mode as a decaying sine of its amplitude × `scale` (replaces
   * the current state). Optional `phases` (radians per mode) start mode i at
   * sin(phase) instead of 0 — spreading them lowers the crest factor of dense
   * banks, but then the caller must fade the first milliseconds in.
   */
  strike(scale = 1, phases?: ArrayLike<number>): void {
    this.asleep.fill(0);
    for (let i = 0; i < this.count; i++) {
      const r = this.radius[i];
      const a = this.amp[i] * scale;
      const s = this.sinW[i];
      const c = this.cosW[i];
      if (!phases) {
        // y[-1] and y[-2] of a·r^n·sin(w n)
        this.y1[i] = (-a * s) / r;
        this.y2[i] = (-a * 2 * s * c) / (r * r);
      } else {
        const ps = Math.sin(phases[i]);
        const pc = Math.cos(phases[i]);
        // sin(p - w) and sin(p - 2w)
        this.y1[i] = (a * (ps * c - pc * s)) / r;
        this.y2[i] = (a * (ps * (2 * c * c - 1) - pc * 2 * s * c)) / (r * r);
      }
    }
  }

  /** ADD `n` samples of the ringing bank into out[offset ..), scaled by `gain`. */
  render(out: Float32Array, offset: number, n: number, gain = 1): void {
    const order = this.order;
    for (let start = 0; start < n; start += CHUNK) {
      const from = offset + start;
      const to = offset + Math.min(n, start + CHUNK);
      const awake = this.collectAwake();
      let k = 0;
      // four modes per pass: a quarter of the passes over the output buffer
      for (; k + 3 < awake; k += 4) {
        const m0 = order[k];
        const m1 = order[k + 1];
        const m2 = order[k + 2];
        const m3 = order[k + 3];
        const c0 = this.coef[m0];
        const c1 = this.coef[m1];
        const c2 = this.coef[m2];
        const c3 = this.coef[m3];
        const q0 = this.r2[m0];
        const q1 = this.r2[m1];
        const q2 = this.r2[m2];
        const q3 = this.r2[m3];
        let u0 = this.y1[m0];
        let u1 = this.y1[m1];
        let u2 = this.y1[m2];
        let u3 = this.y1[m3];
        let v0 = this.y2[m0];
        let v1 = this.y2[m1];
        let v2 = this.y2[m2];
        let v3 = this.y2[m3];
        for (let i = from; i < to; i++) {
          const a = c0 * u0 - q0 * v0;
          v0 = u0;
          u0 = a;
          const b = c1 * u1 - q1 * v1;
          v1 = u1;
          u1 = b;
          const c = c2 * u2 - q2 * v2;
          v2 = u2;
          u2 = c;
          const d = c3 * u3 - q3 * v3;
          v3 = u3;
          u3 = d;
          out[i] += gain * (a + b + c + d);
        }
        this.store(m0, u0, v0);
        this.store(m1, u1, v1);
        this.store(m2, u2, v2);
        this.store(m3, u3, v3);
      }
      for (; k < awake; k++) {
        const m = order[k];
        const c = this.coef[m];
        const q = this.r2[m];
        let u = this.y1[m];
        let v = this.y2[m];
        for (let i = from; i < to; i++) {
          const y = c * u - q * v;
          v = u;
          u = y;
          out[i] += gain * y;
        }
        this.store(m, u, v);
      }
    }
  }

  /** ADD `n` samples into a stereo pair with per-mode gains (gainsL[m], gainsR[m]). */
  renderStereo(
    left: Float32Array,
    right: Float32Array,
    offset: number,
    n: number,
    gainsL: ArrayLike<number>,
    gainsR: ArrayLike<number>,
  ): void {
    const order = this.order;
    for (let start = 0; start < n; start += CHUNK) {
      const from = offset + start;
      const to = offset + Math.min(n, start + CHUNK);
      const awake = this.collectAwake();
      let k = 0;
      for (; k + 3 < awake; k += 4) {
        const m0 = order[k];
        const m1 = order[k + 1];
        const m2 = order[k + 2];
        const m3 = order[k + 3];
        const c0 = this.coef[m0];
        const c1 = this.coef[m1];
        const c2 = this.coef[m2];
        const c3 = this.coef[m3];
        const q0 = this.r2[m0];
        const q1 = this.r2[m1];
        const q2 = this.r2[m2];
        const q3 = this.r2[m3];
        const l0 = gainsL[m0];
        const l1 = gainsL[m1];
        const l2 = gainsL[m2];
        const l3 = gainsL[m3];
        const r0 = gainsR[m0];
        const r1 = gainsR[m1];
        const r2 = gainsR[m2];
        const r3 = gainsR[m3];
        let u0 = this.y1[m0];
        let u1 = this.y1[m1];
        let u2 = this.y1[m2];
        let u3 = this.y1[m3];
        let v0 = this.y2[m0];
        let v1 = this.y2[m1];
        let v2 = this.y2[m2];
        let v3 = this.y2[m3];
        for (let i = from; i < to; i++) {
          const a = c0 * u0 - q0 * v0;
          v0 = u0;
          u0 = a;
          const b = c1 * u1 - q1 * v1;
          v1 = u1;
          u1 = b;
          const c = c2 * u2 - q2 * v2;
          v2 = u2;
          u2 = c;
          const d = c3 * u3 - q3 * v3;
          v3 = u3;
          u3 = d;
          left[i] += l0 * a + l1 * b + l2 * c + l3 * d;
          right[i] += r0 * a + r1 * b + r2 * c + r3 * d;
        }
        this.store(m0, u0, v0);
        this.store(m1, u1, v1);
        this.store(m2, u2, v2);
        this.store(m3, u3, v3);
      }
      for (; k < awake; k++) {
        const m = order[k];
        const c = this.coef[m];
        const q = this.r2[m];
        const gl = gainsL[m];
        const gr = gainsR[m];
        let u = this.y1[m];
        let v = this.y2[m];
        for (let i = from; i < to; i++) {
          const y = c * u - q * v;
          v = u;
          u = y;
          left[i] += gl * y;
          right[i] += gr * y;
        }
        this.store(m, u, v);
      }
    }
  }

  /**
   * One sample of the bank as a filter: each mode is driven by `input` and
   * the outputs are summed with the mode amplitudes. An impulse of 1 makes
   * mode i ring with peak amplitude amp[i]. Use EITHER strike() + render()
   * OR next() on one bank: the two scale the state differently.
   */
  next(input: number): number {
    let sum = 0;
    for (let m = 0; m < this.count; m++) {
      const y = this.coef[m] * this.y1[m] - this.r2[m] * this.y2[m] + input;
      this.y2[m] = this.y1[m];
      this.y1[m] = y;
      sum += this.amp[m] * this.sinW[m] * y;
    }
    return sum;
  }

  /** Let render() compute every mode again (after driving the bank with next()). */
  wake(): void {
    this.asleep.fill(0);
  }

  /** Silence all modes. */
  reset(): void {
    this.y1.fill(0);
    this.y2.fill(0);
    this.asleep.fill(0);
  }
}

/**
 * RMS over the first `window` seconds of a sum of decaying partials
 * Σ amps[k]·e^(-6.91 t / t60s[k])·sin(…), treating the partials as incoherent
 * (true for anything but exact unisons). Voices use it to calibrate levels
 * without rendering twice.
 */
export function decayingPartialsRms(
  amps: ArrayLike<number>,
  t60s: ArrayLike<number>,
  count: number,
  window: number,
): number {
  let power = 0;
  for (let k = 0; k < count; k++) {
    const x = (2 * LN_60DB * window) / Math.max(t60s[k], 1e-4);
    const average = x < 1e-6 ? 1 : (1 - Math.exp(-x)) / x;
    power += 0.5 * amps[k] * amps[k] * average;
  }
  return Math.sqrt(power);
}
