/**
 * destruction/util.js — small deterministic helpers shared by the destruction stack.
 * Owner: destruction agent.
 *
 * Nothing in here touches THREE, the DOM or Math.random. Every stochastic choice in
 * the destruction system is seeded from a string key through `hashStr`, so a fracture
 * pattern is byte-identical between runs and between machines.
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** FNV-1a over a string -> uint32. Stable across engines. */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix three floats (quantised to mm) into a stable uint32 — per-impact variation. */
export function hashPoint(x, y, z, salt = 0) {
  let h = Math.imul(Math.round(x * 1000) | 0, 0x27d4eb2d);
  h ^= Math.imul(Math.round(y * 1000) | 0, 0x165667b1);
  h ^= Math.imul(Math.round(z * 1000) | 0, 0x9e3779b1);
  h ^= Math.imul(salt | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Size buckets in metres. Fracture patterns are generated at *true* size (so UVs stay
 * in metres and the physics extents are right) which would blow the cache open if we
 * keyed on exact dimensions — so every extent snaps to the nearest step first.
 */
const SIZE_STEPS = [
  0.04, 0.06, 0.09, 0.13, 0.18, 0.25, 0.34, 0.45, 0.6, 0.8, 1.05, 1.4, 1.85, 2.4, 3.2,
];

export function snapSize(v) {
  const a = Math.abs(v) || 0.01;
  let best = SIZE_STEPS[0];
  let bestD = Infinity;
  for (let i = 0; i < SIZE_STEPS.length; i++) {
    const d = Math.abs(Math.log(SIZE_STEPS[i] / a));
    if (d < bestD) {
      bestD = d;
      best = SIZE_STEPS[i];
    }
  }
  return best;
}

/**
 * Closest point on an oriented box to `p`, and the squared distance to it.
 * Writes into `out` (a THREE.Vector3) and returns the squared distance.
 * Allocation free: `tmp` is a scratch Vector3 owned by the caller.
 */
export function closestOnObb(p, center, quat, invQuat, half, out, tmp) {
  tmp.copy(p).sub(center).applyQuaternion(invQuat);
  tmp.x = clamp(tmp.x, -half.x, half.x);
  tmp.y = clamp(tmp.y, -half.y, half.y);
  tmp.z = clamp(tmp.z, -half.z, half.z);
  out.copy(tmp).applyQuaternion(quat).add(center);
  return out.distanceToSquared(p);
}

/** True when `p` (world) is inside the oriented box, expanded by `pad` metres. */
export function insideObb(p, center, invQuat, half, pad, tmp) {
  tmp.copy(p).sub(center).applyQuaternion(invQuat);
  return (
    Math.abs(tmp.x) <= half.x + pad &&
    Math.abs(tmp.y) <= half.y + pad &&
    Math.abs(tmp.z) <= half.z + pad
  );
}

/** Smooth 0..1 falloff over a radius; 1 at the centre, 0 at the edge. */
export function falloff(dist, radius) {
  if (!(radius > 0)) return dist <= 0 ? 1 : 0;
  const t = clamp01(1 - dist / radius);
  return t * t * (3 - 2 * t);
}

/** A tiny LRU keyed by string. `onEvict(value)` is where geometry gets disposed. */
export class LRU {
  constructor(limit = 48, onEvict = null) {
    this.limit = limit;
    this.onEvict = onEvict;
    this.map = new Map();
  }

  get(k) {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    // Re-insert to mark as most recently used.
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }

  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      const dead = this.map.get(oldest);
      this.map.delete(oldest);
      try {
        this.onEvict?.(dead);
      } catch {
        /* eviction must never throw into a gameplay frame */
      }
    }
    return v;
  }

  get size() {
    return this.map.size;
  }

  clear() {
    for (const v of this.map.values()) {
      try {
        this.onEvict?.(v);
      } catch {
        /* ignore */
      }
    }
    this.map.clear();
  }
}

export default { clamp, clamp01, lerp, hashStr, hashPoint, snapSize, falloff, LRU };
