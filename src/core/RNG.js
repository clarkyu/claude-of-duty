/**
 * Deterministic RNG. Owner: orchestrator (core).
 * Every stochastic decision in the game must route through one of these so the
 * screenshot harness produces byte-identical frames across runs.
 */

/** SplitMix32 — fast, good distribution, tiny state. */
export function makeRNG(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  /** Box–Muller, unit variance. */
  rng.gauss = () => {
    const u = Math.max(1e-7, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * rng());
  };
  /** Uniform point on the unit sphere. */
  rng.onSphere = (out) => {
    const z = rng() * 2 - 1;
    const t = rng() * 6.283185307179586;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.set(r * Math.cos(t), r * Math.sin(t), z);
    return out;
  };
  rng.fork = () => makeRNG((a ^ 0x85ebca6b) >>> 0);
  rng.reseed = (s) => {
    a = s >>> 0;
  };
  return rng;
}

/** Deterministic 2D value hash in [0,1) — for procedural placement without state. */
export function hash2(x, y) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
