/**
 * Seeded randomness for the composer. Every musical decision draws from a
 * NAMED sub-stream (`rng.fork("melody")`), and a fork depends only on the
 * parent's seed and the name — never on how many numbers the parent has
 * already produced. Changing one decision (a drum fill, a fader) therefore
 * never reshuffles an unrelated one (the melody).
 */

export interface Rng {
  /** the seed this stream was created from */
  readonly seed: number;
  /** next float in [0, 1) */
  next(): number;
  /** float in [low, high) */
  range(low: number, high: number): number;
  /** integer in [low, high] (inclusive) */
  int(low: number, high: number): number;
  /** true with the given probability */
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** index drawn in proportion to the (non-negative) weights */
  weightedIndex(weights: readonly number[]): number;
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** independent, reproducible sub-stream */
  fork(name: string): Rng;
}

/** FNV-1a over the name, mixed with the parent seed (murmur-style finaliser). */
export function hashSeed(seed: number, name: string): number {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < name.length; i++)
    hash = Math.imul(hash ^ name.charCodeAt(i), 16777619) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** mulberry32 */
export function seededRandom(seed: number): Rng {
  const origin = seed >>> 0;
  let state = origin;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const weightedIndex = (weights: readonly number[]) => {
    let total = 0;
    for (const weight of weights) total += Math.max(0, weight);
    if (!(total > 0))
      return Math.min(weights.length - 1, Math.floor(next() * weights.length));
    let target = next() * total;
    for (let i = 0; i < weights.length; i++) {
      target -= Math.max(0, weights[i]);
      if (target < 0) return i;
    }
    return weights.length - 1;
  };
  return {
    seed: origin,
    next,
    range: (low, high) => low + (high - low) * next(),
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    chance: (probability) => next() < probability,
    pick: (items) =>
      items[Math.min(items.length - 1, Math.floor(next() * items.length))],
    weightedIndex,
    weighted: (items, weights) => items[weightedIndex(weights)],
    shuffle: (items) => {
      const result = items.slice();
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    },
    fork: (name) => seededRandom(hashSeed(origin, name)),
  };
}

/** One reproducible number in [0, 1) for a (seed, name) pair. */
export function hashUnit(seed: number, name: string): number {
  return seededRandom(hashSeed(seed, name)).next();
}
