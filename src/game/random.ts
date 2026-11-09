/** xorshift32: a small, seeded random number generator returning values in [0, 1). */
export function rng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** FNV-1a hash of a base seed and labels, so each run gets its own repeatable seed. */
export function runSeed(seed: number, ...labels: string[]): number {
  let hash = 0x811c9dc5 ^ seed;
  for (const char of labels.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Fisher–Yates shuffle of a copy. */
export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
