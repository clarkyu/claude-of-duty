/**
 * Where plants grow. Owner: foliage agent.
 *
 * An even carpet of grass is the tell-tale sign of a scattered videogame world. Real
 * neglected ground is *patchy*: vegetation survives where nothing walks on it and where
 * water collects — the base of a wall, the lee of a barrier, the crack between two
 * paving slabs, the corner of a yard nobody sweeps. So placement here is a union of
 * several generators rather than one Poisson disc:
 *
 *   patches()   low-frequency hashed patch field over open unmade ground. A patch is
 *               either on or off, and within it density falls off from the centre.
 *   wallBases() runs along building footprints, offset out by the plant's own radius so
 *               it grows *against* the wall rather than through it. Gated by a coarse
 *               1D mask so it forms runs of a few plants with bald stretches between,
 *               which is what a real wall base looks like.
 *   cracks()    lines along the kerb seam, where the carriageway meets the pavement.
 *   atPoints()  hand-placed anchors (planter rims, arch springings, channel copings).
 *   spaceOut()  a linear-time minimum-distance filter, so scrub and trees never stack.
 *
 * Nothing here calls Math.random(): every candidate comes from `hash2()` over integer
 * grid coordinates, so the exact same world is generated on every run and on every
 * machine, at any density. Density only *thins* the same candidate list (a candidate is
 * kept when its own hash is below the density threshold), so turning the setting down
 * never reshuffles the placement — plants disappear, they do not move.
 *
 * Every surviving candidate is then verified against real physics: a downward ray for
 * the ground point and its normal, an upward ray to reject anything indoors or under a
 * canopy, and a prop overlap test.
 */
import * as THREE from 'three';
import { hash2 } from '../../core/RNG.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const WORLD = 1; // GROUP.WORLD
const PROP = 8; // GROUP.PROP

/** Deterministic 0..1 stream from an integer pair plus a salt. */
function h(x, z, salt) {
  return hash2((x | 0) * 73856093 + (salt | 0) * 19349663, (z | 0) * 83492791 + (salt | 0) * 2971215073);
}

export class Placer {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.bounds = opts.bounds || { minX: -50, maxX: 50, minZ: -48, maxZ: 58 };
    this.roads = opts.roads || [];
    this.footprints = opts.footprints || [];
    this.voids = opts.voids || [];
    this.origin = new THREE.Vector3();
    this.stats = { tested: 0, placed: 0, rejectedSurface: 0, rejectedIndoor: 0, rejectedProp: 0, rejectedSlope: 0 };
    this._hit = null;
  }

  inBounds(x, z) {
    const b = this.bounds;
    return x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
  }

  /** Rect test with a margin, used for roads, footprints and voids. */
  static inRect(r, x, z, margin = 0) {
    return x >= r[0] - margin && x <= r[2] + margin && z >= r[1] - margin && z <= r[3] + margin;
  }

  onRoad(x, z, margin = 0) {
    for (let i = 0; i < this.roads.length; i++) if (Placer.inRect(this.roads[i], x, z, margin)) return true;
    return false;
  }

  insideBuilding(x, z, margin = 0) {
    for (let i = 0; i < this.footprints.length; i++) {
      if (Placer.inRect(this.footprints[i], x, z, margin)) return true;
    }
    for (let i = 0; i < this.voids.length; i++) if (Placer.inRect(this.voids[i], x, z, margin)) return true;
    return false;
  }

  /**
   * Drop a candidate onto the world.
   * @returns {{x,y,z, nx,ny,nz, surface}|null}
   */
  probe(x, z, o = {}) {
    this.stats.tested++;
    const phys = this.ctx.physics;
    const level = this.ctx.level;
    const maxSlope = o.maxSlope ?? 0.72;
    let y = null;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let surface = null;

    const startY = (level?.groundY ? level.groundY(x, z) : 0) + 2.2;
    if (phys?.raycast) {
      this.origin.set(x, startY, z);
      const hit = phys.raycast(this.origin, DOWN, 4.0, WORLD);
      if (!hit) return null;
      if (hit.normal.y < maxSlope) {
        this.stats.rejectedSlope++;
        return null;
      }
      y = hit.point.y;
      nx = hit.normal.x;
      ny = hit.normal.y;
      nz = hit.normal.z;
      surface = hit.surface || null;
      // Roofs and balconies are "ground" too, but vegetation up there needs a reason.
      if (!o.allowElevated && y > (level?.groundY ? level.groundY(x, z) : 0) + 1.6) return null;
    } else if (level?.groundY) {
      y = level.groundY(x, z);
      surface = level.surfaceAt ? level.surfaceAt(x, z) : 'dirt';
    } else {
      return null;
    }

    if (o.surfaces && surface && !o.surfaces.has(surface)) {
      this.stats.rejectedSurface++;
      return null;
    }

    // Indoors / under a canopy: fire a ray straight up. Anything close overhead means
    // no rain and no sun, so nothing grows there.
    if (!o.allowIndoor && phys?.raycast) {
      this.origin.set(x, y + 0.15, z);
      const up = phys.raycast(this.origin, UP, o.headroom ?? 4.0, WORLD);
      if (up) {
        this.stats.rejectedIndoor++;
        return null;
      }
    }

    // Do not grow out of the top of a crate.
    const propR = o.propRadius ?? 0.35;
    if (phys?.overlapSphere && propR > 0) {
      this.origin.set(x, y + (o.propProbeY ?? 0.25), z);
      const near = phys.overlapSphere(this.origin, propR, PROP);
      if (near && near.length) {
        this.stats.rejectedProp++;
        return null;
      }
    }

    this.stats.placed++;
    return { x, y, z, nx, ny, nz, surface: surface || 'dirt' };
  }

  /**
   * Clumped scatter over open ground.
   *
   * @param {object} o
   * @param {number} o.salt        species id, keeps species from stacking
   * @param {number} o.patch       patch cell size in metres
   * @param {number} o.patchProb   fraction of cells that host a patch
   * @param {number} o.perPatch    candidates per active patch at density 1
   * @param {number} o.density     0..N from ctx.settings foliageDensity
   * @param {Set<string>} [o.surfaces]
   * @param {number} [o.roadMargin] reject within this distance of a carriageway
   * @param {(c:object)=>boolean} [o.accept]
   * @param {number} o.limit
   */
  patches(o) {
    const out = [];
    const b = this.bounds;
    const cell = o.patch ?? 7;
    const i0 = Math.floor(b.minX / cell);
    const i1 = Math.ceil(b.maxX / cell);
    const j0 = Math.floor(b.minZ / cell);
    const j1 = Math.ceil(b.maxZ / cell);
    const density = Math.max(0, o.density ?? 1);
    const perPatch = Math.max(1, Math.round(o.perPatch ?? 12));

    for (let j = j0; j <= j1 && out.length < o.limit; j++) {
      for (let i = i0; i <= i1 && out.length < o.limit; i++) {
        const seed = h(i, j, o.salt);
        if (seed > (o.patchProb ?? 0.32)) continue;
        // Patch intensity: most patches are thin, a few are lush.
        const lush = 0.25 + 0.75 * Math.pow(h(i + 977, j - 631, o.salt), 1.6);
        const cx = (i + 0.5) * cell;
        const cz = (j + 0.5) * cell;
        const pr = cell * (0.32 + 0.42 * lush);

        for (let k = 0; k < perPatch; k++) {
          if (out.length >= o.limit) break;
          const r1 = h(i * 131 + k, j * 17 + k * 7, o.salt + 11);
          const r2 = h(i * 29 - k * 3, j * 211 + k, o.salt + 23);
          const r3 = h(i * 7 + k * 41, j * 53 - k * 13, o.salt + 37);
          // Density thins the SAME candidate list instead of resampling it, so the
          // low-quality world is a subset of the high-quality one.
          if (r3 > Math.min(1, density * lush)) continue;
          // radial falloff from the patch centre: dense middle, ragged edge
          const rad = pr * Math.sqrt(r1) * (0.55 + 0.45 * r2);
          const ang = r2 * Math.PI * 2 + r1 * 1.7;
          const x = cx + Math.cos(ang) * rad;
          const z = cz + Math.sin(ang) * rad;
          if (!this.inBounds(x, z)) continue;
          if (this.insideBuilding(x, z, 0.35)) continue;
          if (o.roadMargin !== undefined && this.onRoad(x, z, -o.roadMargin)) continue;
          const c = this.probe(x, z, o);
          if (!c) continue;
          c.r = [r1, r2, r3];
          c.lush = lush;
          if (o.accept && !o.accept(c)) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Walk the perimeter of every footprint and place along it, offset outwards. This is
   * the single highest-value placement in the whole system: a wall meeting bare ground
   * with nothing in the joint is the thing that reads as "untextured box".
   */
  wallBases(o) {
    const out = [];
    const density = Math.max(0, o.density ?? 1);
    const step = o.step ?? 0.7;
    const offset = o.offset ?? 0.22;
    const rects = o.rects || this.footprints;
    let n = 0;

    for (let ri = 0; ri < rects.length && out.length < o.limit; ri++) {
      const r = rects[ri];
      const edges = [
        { x0: r[0], z0: r[1], x1: r[2], z1: r[1], ox: 0, oz: -1 },
        { x0: r[2], z0: r[1], x1: r[2], z1: r[3], ox: 1, oz: 0 },
        { x0: r[2], z0: r[3], x1: r[0], z1: r[3], ox: 0, oz: 1 },
        { x0: r[0], z0: r[3], x1: r[0], z1: r[1], ox: -1, oz: 0 },
      ];
      for (const e of edges) {
        const len = Math.hypot(e.x1 - e.x0, e.z1 - e.z0);
        const steps = Math.max(1, Math.floor(len / step));
        for (let k = 0; k < steps && out.length < o.limit; k++) {
          n++;
          const t = (k + 0.5) / steps;
          const r1 = h(ri * 313 + k, n, o.salt);
          const r2 = h(n * 7, ri * 91 - k, o.salt + 5);
          const r3 = h(k * 53, n * 29, o.salt + 13);
          // Vegetation along a wall is streaky, not continuous: gate on a smooth-ish
          // 1D mask so it forms runs of 3-6 plants with bald patches between.
          const run = h(ri * 101 + ((k / 4) | 0), 0, o.salt + 71);
          if (run > 0.62) continue;
          if (r3 > Math.min(1, density * 1.15)) continue;
          const x = e.x0 + (e.x1 - e.x0) * t + e.ox * (offset + r1 * (o.jitter ?? 0.22));
          const z = e.z0 + (e.z1 - e.z0) * t + e.oz * (offset + r1 * (o.jitter ?? 0.22));
          const jx = x + (r2 - 0.5) * step * 0.5 * Math.abs(e.oz);
          const jz = z + (r2 - 0.5) * step * 0.5 * Math.abs(e.ox);
          if (!this.inBounds(jx, jz)) continue;
          if (this.insideBuilding(jx, jz, -0.05)) continue;
          const c = this.probe(jx, jz, o);
          if (!c) continue;
          c.r = [r1, r2, r3];
          c.wall = { nx: e.ox, nz: e.oz };
          c.lush = 1;
          if (o.accept && !o.accept(c)) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Weeds in the seam between two paved surfaces. The seam is where the kerb meets the
   * carriageway, so walk the long edges of every road rect.
   */
  cracks(o) {
    const out = [];
    const density = Math.max(0, o.density ?? 1);
    const step = o.step ?? 1.1;
    let n = 0;
    for (let ri = 0; ri < this.roads.length && out.length < o.limit; ri++) {
      const r = this.roads[ri];
      const w = r[2] - r[0];
      const d = r[3] - r[1];
      // Only the two long edges: the kerb line.
      const along = w > d;
      const len = along ? w : d;
      const steps = Math.max(1, Math.floor(len / step));
      for (let side = 0; side < 2; side++) {
        for (let k = 0; k < steps && out.length < o.limit; k++) {
          n++;
          const t = (k + 0.5) / steps;
          const r1 = h(ri * 761 + k, n * 3 + side, o.salt);
          const r2 = h(n * 11 + side, ri * 47 - k, o.salt + 3);
          const r3 = h(k * 97 + side * 5, n * 13, o.salt + 29);
          if (r3 > Math.min(1, density * 0.55)) continue;
          const edge = side === 0 ? 0.06 : 0.94;
          const x = along ? r[0] + len * t : r[0] + (r[2] - r[0]) * edge;
          const z = along ? r[1] + (r[3] - r[1]) * edge : r[1] + len * t;
          const jx = x + (r1 - 0.5) * 0.4;
          const jz = z + (r2 - 0.5) * 0.4;
          if (!this.inBounds(jx, jz)) continue;
          if (this.insideBuilding(jx, jz, 0.2)) continue;
          const c = this.probe(jx, jz, o);
          if (!c) continue;
          c.r = [r1, r2, r3];
          c.lush = 0.5;
          if (o.accept && !o.accept(c)) continue;
          out.push(c);
        }
      }
    }
    return out;
  }

  /** Explicit hand-placed candidates (trees at landmarks, pots by doorways). */
  atPoints(points, o = {}) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const c = this.probe(p.x, p.z, { ...o, ...(p.opts || {}) });
      if (!c) continue;
      c.r = [h(i, 1, o.salt ?? 0), h(i, 2, o.salt ?? 0), h(i, 3, o.salt ?? 0)];
      c.lush = 1;
      c.tag = p.tag;
      c.yaw = p.yaw;
      out.push(c);
    }
    return out;
  }

  /**
   * Thin an already-generated list so no two entries are closer than `minDist`.
   * Grid-bucketed, so it is linear rather than quadratic even for a few thousand.
   */
  static spaceOut(list, minDist) {
    if (minDist <= 0) return list;
    const cell = minDist;
    const grid = new Map();
    const out = [];
    const d2 = minDist * minDist;
    for (const c of list) {
      const gi = Math.floor(c.x / cell);
      const gj = Math.floor(c.z / cell);
      let ok = true;
      for (let j = gj - 1; j <= gj + 1 && ok; j++) {
        for (let i = gi - 1; i <= gi + 1 && ok; i++) {
          const bucket = grid.get(i * 100003 + j);
          if (!bucket) continue;
          for (const o of bucket) {
            const dx = o.x - c.x;
            const dz = o.z - c.z;
            if (dx * dx + dz * dz < d2) {
              ok = false;
              break;
            }
          }
        }
      }
      if (!ok) continue;
      const key = gi * 100003 + gj;
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, (bucket = []));
      bucket.push(c);
      out.push(c);
    }
    return out;
  }
}

export default Placer;
