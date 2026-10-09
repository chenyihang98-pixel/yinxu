/**
 * Deterministic random streams. `Random` has the same shape as
 * VoiceContext.random, so a seeded stream can be handed to any voice.
 */

/** A 0 <= x < 1 stream; identical to VoiceContext["random"]. */
export type Random = () => number;

/** mulberry32: fast seeded generator, full 2^32 period, good enough for audio and music choices. */
export function createRng(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix any number of integers/floats into one 32-bit seed (order-sensitive). */
export function hashSeed(...parts: number[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const whole = Math.floor(part);
    hash = Math.imul(hash ^ (whole | 0), 0x01000193);
    hash = Math.imul(hash ^ (((part - whole) * 4294967296) | 0), 0x01000193);
    hash ^= hash >>> 15;
  }
  return hash >>> 0;
}

/** 32-bit seed drawn from a parent stream (consumes exactly one value). */
export function seedFrom(random: Random): number {
  return (random() * 4294967296) >>> 0;
}

/**
 * Independent child stream seeded by ONE draw from the parent. Voices use it
 * so a note consumes a fixed number of parent values whatever its length.
 */
export function forkRng(random: Random): Random {
  return createRng(seedFrom(random));
}

/** Uniform value in [lo, hi). */
export function randRange(random: Random, lo: number, hi: number): number {
  return lo + (hi - lo) * random();
}

/** Uniform value in [-1, 1). */
export function randBipolar(random: Random): number {
  return random() * 2 - 1;
}
