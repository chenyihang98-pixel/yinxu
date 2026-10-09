/**
 * Helpers every voice needs: the level convention of the Voice contract,
 * the velocity law, the shape of NoteEvent.bend and reusable scratch buffers
 * (the one piece of module state here: see trimScratch).
 */
import type { VoiceNote } from "../voices/types";
import { freeBuffer } from "./memory";

/** Linear RMS of -18 dBFS: the level of a 1 s note at REFERENCE_VELOCITY over its loudest 400 ms. */
export const REFERENCE_RMS = 0.12589254117941673;
/** Velocity at which a voice measures REFERENCE_RMS. */
export const REFERENCE_VELOCITY = 0.8;
/** Length in seconds of the window the level convention is measured over. */
export const LEVEL_WINDOW = 0.4;
/** Seconds a NoteEvent.bend takes to arrive on the written pitch. */
export const BEND_TIME = 0.07;

/**
 * Amplitude factor of the velocity law: (vel / 0.8)^exponent, 1 at vel 0.8.
 * Multiply a signal calibrated to REFERENCE_RMS by it (and ALSO make the
 * timbre brighter with velocity — level alone is not enough).
 */
export function velocityGain(vel: number, exponent = 1.5): number {
  const v = vel < 0.02 ? 0.02 : vel > 1 ? 1 : vel;
  return Math.pow(v / REFERENCE_VELOCITY, exponent);
}

/**
 * Pitch offset in semitones `t` seconds after the start of a note whose
 * NoteEvent.bend is `bend`: starts at `bend`, eases (raised cosine) to 0 at
 * `glide` seconds and stays there. Every voice uses this one curve.
 */
export function bendOffset(
  bend: number | undefined,
  t: number,
  glide = BEND_TIME,
): number {
  if (!bend || t >= glide) return 0;
  return bend * (0.5 + 0.5 * Math.cos((Math.PI * t) / glide));
}

/**
 * Sample index of note-off inside a buffer of `frames`: round(duration·sr),
 * kept at least `minReleaseSeconds` before the end so a release always fits.
 */
export function noteOffFrame(
  note: VoiceNote,
  frames: number,
  sampleRate: number,
  minReleaseSeconds = 0.003,
): number {
  const latest = frames - 1 - Math.ceil(minReleaseSeconds * sampleRate);
  const hold = Math.round(note.duration * sampleRate);
  return Math.max(1, Math.min(hold, latest));
}

const pool: (Float32Array | undefined)[] = [];
let poolBytes = 0;

/**
 * Longest slot, in samples, that stays allocated between renders (5.5 s at
 * 48 kHz, 1 MB): ordinary notes reuse their slots from render to render,
 * while what a drone of two minutes needed (29 MB per slot) is given back by
 * trimScratch() as soon as the render is over.
 */
export const SCRATCH_KEEP = 1 << 18;

/**
 * Reusable ZEROED work buffer of at least `frames` samples (it may be
 * longer: always pass your own frame count along). Voices and drums render
 * one after another, so slots 0..15 are free for whoever is rendering; the
 * content is only valid until the next call with the same slot.
 */
export function scratch(slot: number, frames: number): Float32Array {
  let buffer = pool[slot];
  if (!buffer || buffer.length < frames) {
    // ordinary notes get room to grow (up to what is kept), so a slot settles
    // after a few of them; a long drone gets what it asks for and no more
    const size =
      (frames > SCRATCH_KEEP
        ? frames
        : Math.min(SCRATCH_KEEP, Math.ceil(frames * 1.25))) + 1024;
    if (buffer) {
      poolBytes -= buffer.byteLength;
      // a long one that is outgrown goes back at once, like the rest (trimScratch)
      if (buffer.length > SCRATCH_KEEP + 1024) freeBuffer(buffer);
    }
    buffer = new Float32Array(size);
    poolBytes += buffer.byteLength;
    pool[slot] = buffer;
  } else buffer.fill(0, 0, frames);
  return buffer;
}

/** Bytes the scratch slots hold right now. */
export function scratchBytes(): number {
  return poolBytes;
}

/**
 * Give back every scratch slot longer than SCRATCH_KEEP, at once (see
 * freeBuffer). Returns the bytes released. Only between notes: whoever still
 * holds such a slot is left with an empty array.
 */
export function trimScratch(): number {
  let released = 0;
  for (let slot = 0; slot < pool.length; slot++) {
    const buffer = pool[slot];
    if (!buffer || buffer.length <= SCRATCH_KEEP + 1024) continue;
    released += buffer.byteLength;
    freeBuffer(buffer);
    pool[slot] = undefined;
  }
  poolBytes -= released;
  return released;
}

/** ADD a mono buffer into a stereo pair with separate gains. */
export function addMono(
  left: Float32Array,
  right: Float32Array,
  source: Float32Array,
  frames: number,
  gainLeft: number,
  gainRight: number,
): void {
  for (let i = 0; i < frames; i++) {
    const v = source[i];
    left[i] += v * gainLeft;
    right[i] += v * gainRight;
  }
}
