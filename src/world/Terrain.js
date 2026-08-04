/**
 * Terrain.js — the ground. Owner: level agent.
 *
 * The ground is a **rasterised region plan**, not a textured plane. `LevelData.GROUND`
 * paints axis-aligned rectangles of road / pavement / plaza / gravel / dirt over a 1 m
 * grid; each cell is emitted into the batch for its own material at its own height, and
 * wherever two neighbouring cells differ in height a riser quad is generated. That is
 * where the kerb steps, the plaza upstand and the yard edges come from — real geometry
 * with a real silhouette, rather than a decal.
 *
 * Height comes from three sources stacked:
 *   1. two octaves of deterministic value noise (±0.35 m), flattened to zero inside and
 *      within 3 m of every building footprint so no plinth ever floats or buries;
 *   2. a per-region lift (pavements +0.14, plaza +0.90) and a road crown so water has
 *      somewhere to run;
 *   3. a berm that rises 2.6 m outside the play space, closing the map visually without
 *      an invisible wall doing all the work.
 *
 * Collision is four `heightfield` colliders (the storm channel strip is deliberately
 * left uncovered so the channel is enterable) carrying **per-face surface tags**, so a
 * footstep on asphalt sounds different from one on dirt with no extra work anywhere
 * else in the engine.
 */
import * as THREE from 'three';
import { clamp, clamp01, fbm2, lerp, smoothstep, valueNoise2 } from './kit/geom.js';
import { GROUND, GROUND_VOIDS, BOUNDS } from './LevelData.js';

const CORE = { x0: -56, z0: -52, x1: 52, z1: 58 };
const CELL = 1;
const APRON = { x0: -132, z0: -132, x1: 132, z1: 132 };
const APRON_CELL = 6;

export class Terrain {
  /**
   * @param {object} ctx
   * @param {Array<{rect:number[]}>} footprints building footprints, for flattening
   */
  constructor(ctx, footprints = []) {
    this.ctx = ctx;
    this.footprints = footprints;
    this.regions = GROUND.slice();
    this.voids = GROUND_VOIDS.map((v) => v.rect).concat(footprints.map((f) => f.rect));
    this.cols = Math.round((CORE.x1 - CORE.x0) / CELL);
    this.rows = Math.round((CORE.z1 - CORE.z0) / CELL);
    this._cornerCache = null;
    this.colliders = [];
  }

  /* ------------------------------------------------------------- heights */

  /** Undulation + berm, before any region lift. */
  baseHeight(x, z) {
    let h = (fbm2(x * 0.031 + 11.3, z * 0.031 - 4.7, 3) - 0.5) * 0.62;
    h += (valueNoise2(x * 0.13 - 3.1, z * 0.13 + 8.4) - 0.5) * 0.16;
    // Flatten near buildings so plinths always meet grade.
    let flat = 0;
    for (let i = 0; i < this.footprints.length; i++) {
      const r = this.footprints[i].rect;
      const dx = Math.max(r[0] - x, 0, x - r[2]);
      const dz = Math.max(r[1] - z, 0, z - r[3]);
      const d = Math.hypot(dx, dz);
      const f = 1 - smoothstep(0.5, 3.6, d);
      if (f > flat) flat = f;
      if (flat >= 1) break;
    }
    h *= 1 - flat;
    // Berm outside the play space.
    const b = BOUNDS;
    const out = Math.max(
      b.playMinX - x,
      x - b.playMaxX,
      b.playMinZ - z,
      z - b.playMaxZ
    );
    if (out > 0) {
      h += smoothstep(0, 15, out) * 3.1 + (fbm2(x * 0.05, z * 0.05, 3) - 0.5) * smoothstep(2, 12, out) * 1.4;
    }
    return h;
  }

  /** The region covering (x,z), or null if the ground is owned by something else. */
  regionAt(x, z) {
    for (let i = 0; i < this.voids.length; i++) {
      const r = this.voids[i];
      if (x > r[0] && x < r[2] && z > r[1] && z < r[3]) return null;
    }
    let found = null;
    for (let i = 0; i < this.regions.length; i++) {
      const r = this.regions[i];
      const q = r.rect;
      if (x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]) found = r;
    }
    return found;
  }

  /** Extra lift from a road crown, evaluated at an arbitrary point of the region. */
  crownAt(region, x, z) {
    if (!region?.crown) return 0;
    const q = region.rect;
    const w = q[2] - q[0];
    const d = q[3] - q[1];
    const t = w <= d ? (x - q[0]) / Math.max(w, 1e-3) : (z - q[1]) / Math.max(d, 1e-3);
    const s = 1 - (2 * t - 1) * (2 * t - 1);
    return region.crown * clamp01(s);
  }

  /** Walkable surface height at (x,z) — used for spawns, nav and prop placement. */
  groundY(x, z) {
    const r = this.regionAt(x, z);
    if (!r) return this.baseHeight(x, z);
    return this.baseHeight(x, z) + (r.lift || 0) + this.crownAt(r, x, z);
  }

  surfaceAt(x, z) {
    return this.regionAt(x, z)?.surface || 'dirt';
  }

  /* -------------------------------------------------------------- colour */

  _colorFn() {
    return (x, y, z, nx, ny, nz, out) => {
      const up = ny > 0.5;
      const n1 = fbm2(x * 0.07 + 2.4, z * 0.07 - 5.1, 3);
      const n2 = valueNoise2(x * 0.42, z * 0.42);
      out[0] = clamp01(0.22 + n1 * 0.5 + (up ? 0 : 0.25) + n2 * 0.12);
      // Sand drift: the g channel drives the dirt material's second layer.
      out[1] = clamp01((fbm2(x * 0.022 - 9.2, z * 0.022 + 3.3, 3) - 0.42) * 2.6);
      out[2] = up ? clamp01(0.1 + Math.pow(clamp01(fbm2(x * 0.06 + 31, z * 0.06 - 17, 3) * 1.25), 2.2)) : 0;
    };
  }

  /* --------------------------------------------------------------- build */

  /**
   * @param {(name:string)=>import('./kit/Batcher.js').Batcher} getBatcher
   *        called with a district key; terrain is split 3x3 so culling works
   */
  build(getBatcher) {
    const cols = this.cols;
    const rows = this.rows;
    const corner = new Float32Array((cols + 1) * (rows + 1));
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        corner[j * (cols + 1) + i] = this.baseHeight(CORE.x0 + i * CELL, CORE.z0 + j * CELL);
      }
    }
    this._corner = corner;

    const colorFn = this._colorFn();
    const cellRegion = new Array(cols * rows);
    const cellH = new Float32Array(cols * rows * 4); // 00 10 11 01

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const cx = CORE.x0 + (i + 0.5) * CELL;
        const cz = CORE.z0 + (j + 0.5) * CELL;
        const reg = this.regionAt(cx, cz);
        cellRegion[j * cols + i] = reg;
        if (!reg) continue;
        const lift = reg.lift || 0;
        const x0 = CORE.x0 + i * CELL;
        const x1 = x0 + CELL;
        const z0 = CORE.z0 + j * CELL;
        const z1 = z0 + CELL;
        const b = j * (cols + 1) + i;
        const o = (j * cols + i) * 4;
        cellH[o] = corner[b] + lift + this.crownAt(reg, x0, z0);
        cellH[o + 1] = corner[b + 1] + lift + this.crownAt(reg, x1, z0);
        cellH[o + 2] = corner[b + cols + 2] + lift + this.crownAt(reg, x1, z1);
        cellH[o + 3] = corner[b + cols + 1] + lift + this.crownAt(reg, x0, z1);
      }
    }

    const districtOf = (i, j) => {
      const dx = Math.min(2, Math.floor((i * 3) / cols));
      const dz = Math.min(2, Math.floor((j * 3) / rows));
      return `terrain_${dx}${dz}`;
    };

    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const reg = cellRegion[j * cols + i];
        if (!reg) continue;
        const bat = getBatcher(districtOf(i, j));
        bat.colorFn = colorFn;
        const mb = bat.b(reg.mat);
        const x0 = CORE.x0 + i * CELL;
        const x1 = x0 + CELL;
        const z0 = CORE.z0 + j * CELL;
        const z1 = z0 + CELL;
        const o = (j * cols + i) * 4;
        const h00 = cellH[o];
        const h10 = cellH[o + 1];
        const h11 = cellH[o + 2];
        const h01 = cellH[o + 3];
        mb.quad([x0, h00, z0], [x1, h10, z0], [x1, h11, z1], [x0, h01, z1], [0, 1, 0]);

        // Risers where we sit above a neighbour (kerbs, plaza upstand, yard edges).
        const riser = (ni, nj, ax, ay, az, bx, by, bz, nrm) => {
          let nh = null;
          if (ni >= 0 && ni < cols && nj >= 0 && nj < rows) {
            const nr = cellRegion[nj * cols + ni];
            if (nr) {
              const no = (nj * cols + ni) * 4;
              nh = Math.min(cellH[no], cellH[no + 1], cellH[no + 2], cellH[no + 3]);
            }
          }
          const drop = nh === null ? Math.min(ay, by) - 0.75 : nh;
          if (Math.min(ay, by) - drop < 0.035) return;
          const rmb = bat.b(reg.riserMat || 'struct.concreteClean');
          rmb.quad([ax, drop, az], [bx, drop, bz], [bx, by, bz], [ax, ay, az], nrm);
        };
        riser(i, j - 1, x0, h00, z0, x1, h10, z0, [0, 0, -1]);
        riser(i, j + 1, x1, h11, z1, x0, h01, z1, [0, 0, 1]);
        riser(i - 1, j, x0, h01, z1, x0, h00, z0, [-1, 0, 0]);
        riser(i + 1, j, x1, h10, z0, x1, h11, z1, [1, 0, 0]);
      }
    }

    /* ── the coarse apron: everything from the play space out to the backdrop ── */
    const abat = getBatcher('terrain_apron');
    abat.colorFn = colorFn;
    abat.lod = 0;
    const amb = abat.b('ground.dirt');
    const ac = APRON_CELL;
    for (let z = APRON.z0; z < APRON.z1; z += ac) {
      for (let x = APRON.x0; x < APRON.x1; x += ac) {
        if (x + ac > CORE.x0 && x < CORE.x1 && z + ac > CORE.z0 && z < CORE.z1) continue;
        const q = (px, pz) => [px, this.baseHeight(px, pz) - 0.02, pz];
        amb.quad(q(x, z), q(x + ac, z), q(x + ac, z + ac), q(x, z + ac), [0, 1, 0]);
      }
    }

    this._buildCollision();
    return this.colliders;
  }

  /** Four heightfields; the storm-channel strip is left open on purpose. */
  _buildCollision() {
    const ch = GROUND_VOIDS[0].rect; // channel
    const step = 2;
    const strips = [
      [CORE.x0, CORE.z0, ch[0], CORE.z1],
      [ch[2], CORE.z0, CORE.x1, CORE.z1],
      [ch[0], CORE.z0, ch[2], ch[1]],
      [ch[0], ch[3], ch[2], CORE.z1],
    ];
    for (const [x0, z0, x1, z1] of strips) {
      if (x1 - x0 < step || z1 - z0 < step) continue;
      const nx = Math.round((x1 - x0) / step) + 1;
      const nz = Math.round((z1 - z0) / step) + 1;
      const heights = new Float32Array(nx * nz);
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const x = x0 + i * step;
          const z = z0 + j * step;
          const r = this.regionAt(x, z);
          // The plaza has its own box collider and steps; keep it out of the field.
          const lift = r && (r.lift || 0) <= 0.2 ? r.lift || 0 : 0;
          heights[j * nx + i] = this.baseHeight(x, z) + lift + (r ? this.crownAt(r, x, z) : 0);
        }
      }
      // Per-face surface tags: two triangles per cell, row-major like the shape.
      const faces = new Array((nx - 1) * (nz - 1) * 2);
      for (let j = 0; j < nz - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const s = this.surfaceAt(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step);
          const c = j * nx + i;
          faces[c * 2] = s;
          faces[c * 2 + 1] = s;
        }
      }
      this.colliders.push({
        type: 'heightfield',
        heights,
        width: nx,
        depth: nz,
        nx,
        nz,
        scaleX: step,
        scaleZ: step,
        pos: { x: (x0 + x1) * 0.5, y: 0, z: (z0 + z1) * 0.5 },
        surface: 'dirt',
        faceSurfaces: faces,
      });
    }
    // The far apron: one big flat slab well below grade so nothing can fall forever.
    this.colliders.push({
      type: 'box',
      pos: { x: 0, y: -12, z: 0 },
      halfExtents: { x: 200, y: 6, z: 200 },
      surface: 'dirt',
      occlude: false,
    });
  }
}

export default Terrain;
