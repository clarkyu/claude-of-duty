/**
 * kit/VertexAO.js — baked per-vertex ambient occlusion for the static level.
 * Owner: level agent.
 *
 * Why this exists: `ctx.materials` gives every surface texture-space AO, and
 * `ctx.lighting` gives screen-space contact shadows, but neither can tell you that a
 * patch of pavement is two metres inside an arcade. Baked vertex occlusion is the
 * cheapest way to get the *large-scale* darkening — under balconies, in doorway
 * reveals, at the base of every wall, inside the market hall — which is the single
 * biggest "this is a real game" tell in a static environment.
 *
 * ── How ─────────────────────────────────────────────────────────────────────────
 * Occluders are coarse oriented boxes (the same simplified volumes that go to
 * `ctx.physics`, plus chunky detail that carries no collision). They go in a uniform
 * XZ grid. Each vertex fires a cosine-weighted hemisphere of short rays (2.6 m — this
 * is contact/proximity occlusion, not global illumination) and the hit fraction,
 * distance-weighted, becomes `codOcc`.
 *
 * Results are memoised on a quantised (position, normal-octant) key, which collapses
 * the 3-6 duplicate vertices every chamfered corner produces and cuts the bake by
 * roughly 4x.
 *
 * ── Storage convention ──────────────────────────────────────────────────────────
 * The attribute is **occlusion, not AO**: 0 = open, 1 = fully enclosed. Any geometry
 * that never got baked — or that belongs to another system and happens to share one of
 * our materials — reads the WebGL default of 0 and renders unoccluded. Storing AO
 * directly would make those meshes render black, which is exactly the kind of failure
 * that must be impossible.
 *
 * ── Shader hook ─────────────────────────────────────────────────────────────────
 * `attachVertexAO(material)` chains onto `onBeforeCompile` *after* MaterialLibrary's
 * injection (so the chunk swaps have already happened) and *before* Lighting's, and
 * only touches anchors none of them consume: it declares the attribute ahead of
 * `void main()`, assigns the varying after `<begin_vertex>` and modulates
 * `reflectedLight` after `<lights_fragment_end>`. If any anchor is missing the patch
 * silently no-ops and the material renders exactly as it would have.
 */
import * as THREE from 'three';

/** Shared so the whole level can be tuned (or disabled) from one place. */
export const aoUniform = { value: new THREE.Vector2(1.0, 0.55) }; // indirect, direct

export function setVertexAOStrength(indirect, direct) {
  aoUniform.value.set(
    Math.max(0, Math.min(1.5, indirect)),
    Math.max(0, Math.min(1.5, direct === undefined ? indirect * 0.55 : direct))
  );
}

const VERT_DECL = `
attribute float codOcc;
varying float vCodOccV;
`;

const FRAG_DECL = `
varying float vCodOccV;
uniform vec2 uCodVAo;
`;

// language=GLSL
const FRAG_APPLY = `
{
	float codOccl = clamp( vCodOccV, 0.0, 1.0 );
	if ( codOccl > 0.0005 ) {
		float aoI = 1.0 - codOccl * uCodVAo.x;
		float aoD = 1.0 - codOccl * uCodVAo.y;
		reflectedLight.indirectDiffuse *= aoI;
		reflectedLight.indirectSpecular *= mix( 1.0, aoI, 0.7 );
		reflectedLight.directDiffuse *= aoD;
		reflectedLight.directSpecular *= mix( 1.0, aoD, 0.5 );
	}
}
`;

/**
 * Idempotent. Safe on any material, including ones shared with other systems: meshes
 * without the attribute read 0 and are untouched.
 */
export function attachVertexAO(material) {
  if (!material || material.userData?.codVertexAO) return material;
  if (material.isMeshDepthMaterial || material.isMeshDistanceMaterial) return material;
  material.userData = material.userData || {};
  material.userData.codVertexAO = true;

  const prev = typeof material.onBeforeCompile === 'function' ? material.onBeforeCompile : null;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) {
      try {
        prev.call(this, shader, renderer);
      } catch {
        /* someone else's patch failed; ours still has to land */
      }
    }
    try {
      shader.uniforms.uCodVAo = aoUniform;
      const v = shader.vertexShader;
      const f = shader.fragmentShader;
      if (!v.includes('void main() {') || !v.includes('#include <begin_vertex>')) return;
      if (!f.includes('void main() {') || !f.includes('#include <lights_fragment_end>')) return;
      shader.vertexShader = v
        .replace('void main() {', `${VERT_DECL}\nvoid main() {`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvCodOccV = codOcc;');
      shader.fragmentShader = f
        .replace('void main() {', `${FRAG_DECL}\nvoid main() {`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${FRAG_APPLY}`);
    } catch {
      /* degrade to no AO rather than to no material */
    }
  };

  const prevKey =
    material.customProgramCacheKey && material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey
      ? material.customProgramCacheKey
      : null;
  material.customProgramCacheKey = function () {
    return `${prevKey ? prevKey.call(this) : ''}|codVAO1`;
  };
  material.needsUpdate = true;
  return material;
}

/* ========================================================================== */
/*                              the bake itself                               */
/* ========================================================================== */

const STRIDE = 8; // cx cy cz hx hy hz cos sin

/** Uniform-grid store of oriented (yaw-only) boxes. */
export class OcclusionField {
  constructor({ cell = 4, maxDist = 2.6 } = {}) {
    this.cell = cell;
    this.maxDist = maxDist;
    this.boxes = [];
    this.grid = null;
    this.min = [0, 0];
    this.cols = 0;
    this.rows = 0;
    this.shrink = 0.05;
  }

  /** @param {number} yaw radians about Y */
  add(cx, cy, cz, hx, hy, hz, yaw = 0) {
    if (!(hx > 0) || !(hy > 0) || !(hz > 0)) return;
    this.boxes.push(cx, cy, cz, hx, hy, hz, Math.cos(yaw), Math.sin(yaw));
  }

  get count() {
    return this.boxes.length / STRIDE;
  }

  build() {
    const n = this.count;
    this.data = new Float32Array(this.boxes);
    if (n === 0) {
      this.grid = [];
      this.cols = this.rows = 0;
      return this;
    }
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const rad = [];
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const cx = this.data[o];
      const cz = this.data[o + 2];
      const hx = this.data[o + 3];
      const hz = this.data[o + 5];
      const c = Math.abs(this.data[o + 6]);
      const s = Math.abs(this.data[o + 7]);
      const ex = hx * c + hz * s;
      const ez = hx * s + hz * c;
      rad.push(ex, ez);
      if (cx - ex < minX) minX = cx - ex;
      if (cz - ez < minZ) minZ = cz - ez;
      if (cx + ex > maxX) maxX = cx + ex;
      if (cz + ez > maxZ) maxZ = cz + ez;
    }
    const cell = this.cell;
    this.min = [minX - cell, minZ - cell];
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 2);
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 2);
    // Guard against a pathological bounds explosion eating all the memory.
    if (this.cols * this.rows > 400000) {
      this.cell = cell * 4;
      this.cols = Math.max(1, Math.ceil((maxX - minX) / this.cell) + 2);
      this.rows = Math.max(1, Math.ceil((maxZ - minZ) / this.cell) + 2);
    }
    const grid = new Array(this.cols * this.rows);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const cx = this.data[o];
      const cz = this.data[o + 2];
      const ex = rad[i * 2];
      const ez = rad[i * 2 + 1];
      const c0 = this._col(cx - ex);
      const c1 = this._col(cx + ex);
      const r0 = this._row(cz - ez);
      const r1 = this._row(cz + ez);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const k = r * this.cols + c;
          (grid[k] || (grid[k] = [])).push(i);
        }
      }
    }
    this.grid = grid;
    return this;
  }

  _col(x) {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.min[0]) / this.cell)));
  }
  _row(z) {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((z - this.min[1]) / this.cell)));
  }

  /** Candidate box indices near (x,z), within `maxDist`. */
  gather(x, z, out) {
    out.length = 0;
    if (!this.grid || !this.grid.length) return out;
    const d = this.maxDist;
    const c0 = this._col(x - d);
    const c1 = this._col(x + d);
    const r0 = this._row(z - d);
    const r1 = this._row(z + d);
    for (let r = r0; r <= r1; r++) {
      const base = r * this.cols;
      for (let c = c0; c <= c1; c++) {
        const list = this.grid[base + c];
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const v = list[i];
          if (out.indexOf(v) < 0) out.push(v);
        }
      }
    }
    return out;
  }

  /** Slab test against box `bi`, shrunk so a vertex never occludes its own face. */
  hit(bi, ox, oy, oz, dx, dy, dz, tMax) {
    const d = this.data;
    const o = bi * STRIDE;
    const cs = d[o + 6];
    const sn = d[o + 7];
    let px = ox - d[o];
    const py = oy - d[o + 1];
    let pz = oz - d[o + 2];
    let rx = px * cs + pz * sn;
    let rz = -px * sn + pz * cs;
    px = rx;
    pz = rz;
    rx = dx * cs + dz * sn;
    rz = -dx * sn + dz * cs;
    const k = this.shrink;
    const hx = d[o + 3] - k;
    const hy = d[o + 4] - k;
    const hz = d[o + 5] - k;
    if (hx <= 0 || hy <= 0 || hz <= 0) return -1;

    let tmin = 0;
    let tmax = tMax;
    // X
    if (rx > -1e-7 && rx < 1e-7) {
      if (px < -hx || px > hx) return -1;
    } else {
      const inv = 1 / rx;
      let t1 = (-hx - px) * inv;
      let t2 = (hx - px) * inv;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    // Y
    if (dy > -1e-7 && dy < 1e-7) {
      if (py < -hy || py > hy) return -1;
    } else {
      const inv = 1 / dy;
      let t1 = (-hy - py) * inv;
      let t2 = (hy - py) * inv;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    // Z
    if (rz > -1e-7 && rz < 1e-7) {
      if (pz < -hz || pz > hz) return -1;
    } else {
      const inv = 1 / rz;
      let t1 = (-hz - pz) * inv;
      let t2 = (hz - pz) * inv;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    return tmin;
  }
}

/** Cosine-weighted hemisphere directions in tangent space (z = normal). */
function cosineHemisphere(n) {
  const dirs = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Hammersley: radical inverse base 2.
    let bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    const u1 = (i + 0.5) / n;
    const u2 = bits * 2.3283064365386963e-10;
    const r = Math.sqrt(u1);
    const phi = u2 * Math.PI * 2;
    dirs[i * 3] = r * Math.cos(phi);
    dirs[i * 3 + 1] = r * Math.sin(phi);
    dirs[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - u1));
  }
  return dirs;
}

/**
 * Bake occlusion into `occ` for the vertices in `pos`/`nrm` (flat world-space arrays).
 * Returns the number of rays traced, for budgeting.
 */
export function bakeOcclusion(field, pos, nrm, occ, opts = {}) {
  const samples = opts.samples ?? 12;
  const maxDist = field.maxDist;
  const strength = opts.strength ?? 1;
  const gamma = opts.gamma ?? 1;
  const bias = opts.bias ?? 0.035;
  const dirs = cosineHemisphere(samples);
  const cache = opts.cache || new Map();
  const cand = [];
  let lastCx = NaN;
  let lastCz = NaN;
  let rays = 0;
  const n = pos.length / 3;

  for (let vi = 0; vi < n; vi++) {
    const px = pos[vi * 3];
    const py = pos[vi * 3 + 1];
    const pz = pos[vi * 3 + 2];
    const nx = nrm[vi * 3];
    const ny = nrm[vi * 3 + 1];
    const nz = nrm[vi * 3 + 2];

    // Memoise on a 3 cm grid + coarse normal direction.
    const qx = Math.round(px * 33) + 4096;
    const qy = Math.round(py * 33) + 512;
    const qz = Math.round(pz * 33) + 4096;
    const nb = (nx > 0.4 ? 1 : nx < -0.4 ? 2 : 0) + (ny > 0.4 ? 3 : ny < -0.4 ? 6 : 0) + (nz > 0.4 ? 9 : nz < -0.4 ? 18 : 0);
    const key = (((qx * 2048 + qy) * 9000 + qz) * 32 + nb);
    const hit = cache.get(key);
    if (hit !== undefined) {
      occ[vi] = hit;
      continue;
    }

    // Tangent frame.
    let tx;
    let ty;
    let tz;
    if (Math.abs(ny) < 0.9) {
      tx = -nz;
      ty = 0;
      tz = nx;
    } else {
      tx = 1;
      ty = 0;
      tz = 0;
    }
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    const ox = px + nx * bias;
    const oy = py + ny * bias;
    const oz = pz + nz * bias;

    const cx = Math.round(px * 0.5);
    const cz = Math.round(pz * 0.5);
    if (cx !== lastCx || cz !== lastCz) {
      field.gather(px, pz, cand);
      lastCx = cx;
      lastCz = cz;
    }

    let sum = 0;
    if (cand.length) {
      for (let s = 0; s < samples; s++) {
        const a = dirs[s * 3];
        const b = dirs[s * 3 + 1];
        const c = dirs[s * 3 + 2];
        const dx = tx * a + bx * b + nx * c;
        const dy = ty * a + by * b + ny * c;
        const dz = tz * a + bz * b + nz * c;
        let best = -1;
        for (let ci = 0; ci < cand.length; ci++) {
          const t = field.hit(cand[ci], ox, oy, oz, dx, dy, dz, maxDist);
          if (t >= 0.01 && (best < 0 || t < best)) best = t;
        }
        rays++;
        if (best >= 0) {
          const f = 1 - best / maxDist;
          sum += f * f * 0.65 + f * 0.35;
        }
      }
    }
    // `gamma` < 1 lifts the mid-range: a raw hit fraction of 0.45 at the foot of a
    // wall is a real 45 % of the hemisphere gone, but linear it reads as a faint
    // smudge. The open-ground floor (~0.02) barely moves, so this darkens contacts
    // without greying out the map.
    const raw = sum / samples;
    const value = Math.min(1, (gamma === 1 ? raw : Math.pow(raw, gamma)) * strength);
    cache.set(key, value);
    occ[vi] = value;
  }
  return rays;
}

export default { attachVertexAO, OcclusionField, bakeOcclusion, setVertexAOStrength, aoUniform };
