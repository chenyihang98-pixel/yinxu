/**
 * The last stage of the master bus: a transparent soft clipper. It is
 * stateless, so the exact same curve runs offline (export) and in the Web
 * Audio graph (WaveShaperNode) — what you hear is what you export.
 *
 * Linear up to ±KNEE (−3.1 dBFS); above that the signal bends smoothly and
 * can never exceed ±0.881 (−1.1 dBFS). Input beyond ±1 is held at the ends.
 */
export const KNEE = 0.7;
const LIMIT = 0.9;
const RANGE = LIMIT - KNEE;

export function softClip(x: number): number {
  const a = x < 0 ? -x : x;
  if (a <= KNEE) return x;
  const shaped = KNEE + RANGE * Math.tanh(((a > 1 ? 1 : a) - KNEE) / RANGE);
  return x < 0 ? -shaped : shaped;
}

/** Highest magnitude softClip can output. */
export const CEILING = softClip(1);

/** Curve for WaveShaperNode.curve (odd length, spans input −1..1). */
export function makeSoftClipCurve(size = 4097): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) curve[i] = softClip((i / (size - 1)) * 2 - 1);
  return curve;
}

/** Apply the soft clipper in place. */
export function softClipBuffer(data: Float32Array): void {
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v > KNEE || v < -KNEE) data[i] = softClip(v);
  }
}
