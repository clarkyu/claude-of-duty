/**
 * kit/geom.js — the low-level geometry lathe for the level kit. Owner: level agent.
 *
 * Everything in the map is ultimately built by pushing triangles into a `MeshBuilder`.
 * Design rules that the rest of the kit relies on:
 *
 *  • **World space.** Kit modules emit vertices in world space (optionally through a
 *    matrix on the builder). That means one merge per (district × material) at the end
 *    and no per-piece Object3D — which is how the draw-call budget is met.
 *  • **Metre UVs, generated.** `ctx.materials` expects UVs in metres. Rather than
 *    author them per module we project from world position onto the dominant axis of
 *    the face (same convention as `materials.boxUv`), so neighbouring pieces tile
 *    continuously and nothing ever shows a texel-density seam.
 *  • **Vertex colour is a MASK, not a tint** — the material library reads
 *    r = grime, g = second-material layer, b = water pooling. `colorFn` on the builder
 *    authors it from position/normal, which is where splash-back at the base of walls
 *    and puddles in gutters come from.
 *  • **`codOcc` is baked occlusion**, 0 = open sky, 1 = fully enclosed. It is stored
 *    *inverted* on purpose: geometry that never got a bake, or a material shared with
 *    another system, reads 0 and therefore renders unoccluded instead of black.
 *  • **Winding is never authored.** `quad()`/`tri()` take the intended normal and flip
 *    the index order if the cross product disagrees, so a module author can never emit
 *    a backface by mistake.
 *
 * No Math.random anywhere: `mulberry32` + integer hash noise, both seeded from
 * constants, so two runs produce byte-identical geometry.
 *
 * Public API: MeshBuilder, mulberry32, hash / hash2 / hash3, valueNoise2, fbm2,
 * clamp, clamp01, lerp, smoothstep, and the primitive helpers hung off MeshBuilder.
 */
import * as THREE from 'three';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};
export const TAU = Math.PI * 2;

/** Deterministic PRNG. Same seed -> same map, independent of every other system. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- integer hash noise (position-stable, no state) ---------------------- */

export function hash(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
export function hash2(x, y) {
  return hash((x | 0) * 73856093 ^ (y | 0) * 19349663);
}
export function hash3(x, y, z) {
  return hash((x | 0) * 73856093 ^ (y | 0) * 19349663 ^ (z | 0) * 83492791);
}

export function valueNoise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

export function fbm2(x, y, octaves = 4, gain = 0.5, lac = 2.03) {
  let s = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += valueNoise2(x, y) * amp;
    norm += amp;
    amp *= gain;
    x *= lac;
    y *= lac;
  }
  return s / (norm || 1);
}

/* ========================================================================== */
/*                                MeshBuilder                                 */
/* ========================================================================== */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * One material's worth of triangles. Positions/normals are world space, UVs are in
 * metres, colours are the material-library mask, `occ` is baked occlusion.
 */
export class MeshBuilder {
  constructor(name = '') {
    this.name = name;
    this.p = [];
    this.n = [];
    this.u = [];
    this.c = [];
    this.o = [];
    this.idx = [];
    /** @type {THREE.Matrix4|null} */
    this.matrix = null;
    /** @type {THREE.Matrix3|null} */
    this.normalMatrix = null;
    /** (x,y,z,nx,ny,nz,out3) -> void; writes the vertex-colour mask. */
    this.colorFn = null;
    /** metres of UV shift, useful to break repetition between neighbouring walls. */
    this.uvOffset = [0, 0];
    /** radians; rotates the generated UV frame (corrugation direction, plank runs). */
    this.uvRot = 0;
    this.uvScale = 1;
    this._col = [0.15, 0, 0];
  }

  get vertexCount() {
    return this.p.length / 3;
  }
  get triCount() {
    return this.idx.length / 3;
  }
  get empty() {
    return this.idx.length === 0;
  }

  setMatrix(m) {
    if (!m) {
      this.matrix = null;
      this.normalMatrix = null;
      return this;
    }
    this.matrix = m;
    this.normalMatrix = this.normalMatrix || new THREE.Matrix3();
    this.normalMatrix.setFromMatrix4(m).invert().transpose();
    return this;
  }

  /** Push one vertex; returns its index. `uv` null => project from world space. */
  vert(x, y, z, nx, ny, nz, u, v) {
    if (this.matrix) {
      _v0.set(x, y, z).applyMatrix4(this.matrix);
      x = _v0.x;
      y = _v0.y;
      z = _v0.z;
      _n.set(nx, ny, nz).applyMatrix3(this.normalMatrix).normalize();
      nx = _n.x;
      ny = _n.y;
      nz = _n.z;
    }
    const i = this.p.length / 3;
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);

    if (u === undefined || u === null) {
      const ax = nx < 0 ? -nx : nx;
      const ay = ny < 0 ? -ny : ny;
      const az = nz < 0 ? -nz : nz;
      if (ay >= ax && ay >= az) {
        u = x;
        v = z;
      } else if (ax >= az) {
        u = z;
        v = y;
      } else {
        u = x;
        v = y;
      }
    }
    if (this.uvRot !== 0) {
      const cs = Math.cos(this.uvRot);
      const sn = Math.sin(this.uvRot);
      const uu = u * cs - v * sn;
      v = u * sn + v * cs;
      u = uu;
    }
    this.u.push(u * this.uvScale + this.uvOffset[0], v * this.uvScale + this.uvOffset[1]);

    if (this.colorFn) {
      this.colorFn(x, y, z, nx, ny, nz, this._col);
      this.c.push(this._col[0], this._col[1], this._col[2]);
    } else {
      this.c.push(0.12, 0, 0);
    }
    this.o.push(0);
    return i;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
    return this;
  }

  /**
   * Quad p0..p3 in ring order. `nrm` is the intended outward normal; the winding is
   * corrected automatically so a module can never emit a backface.
   */
  quad(p0, p1, p2, p3, nrm, uvs) {
    _v1.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    _v2.set(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
    _v0.crossVectors(_v1, _v2);
    if (_v0.lengthSq() < 1e-14) return this;
    if (!nrm) {
      _v0.normalize();
      nrm = [_v0.x, _v0.y, _v0.z];
    }
    const flip = _v0.x * nrm[0] + _v0.y * nrm[1] + _v0.z * nrm[2] < 0;
    const a = this.vert(p0[0], p0[1], p0[2], nrm[0], nrm[1], nrm[2], uvs?.[0], uvs?.[1]);
    const b = this.vert(p1[0], p1[1], p1[2], nrm[0], nrm[1], nrm[2], uvs?.[2], uvs?.[3]);
    const c = this.vert(p2[0], p2[1], p2[2], nrm[0], nrm[1], nrm[2], uvs?.[4], uvs?.[5]);
    const d = this.vert(p3[0], p3[1], p3[2], nrm[0], nrm[1], nrm[2], uvs?.[6], uvs?.[7]);
    if (flip) {
      this.idx.push(a, d, c, a, c, b);
    } else {
      this.idx.push(a, b, c, a, c, d);
    }
    return this;
  }

  triangle(p0, p1, p2, nrm) {
    _v1.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    _v2.set(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
    _v0.crossVectors(_v1, _v2);
    if (_v0.lengthSq() < 1e-16) return this;
    if (!nrm) {
      _v0.normalize();
      nrm = [_v0.x, _v0.y, _v0.z];
    }
    const flip = _v0.x * nrm[0] + _v0.y * nrm[1] + _v0.z * nrm[2] < 0;
    const a = this.vert(p0[0], p0[1], p0[2], nrm[0], nrm[1], nrm[2]);
    const b = this.vert(p1[0], p1[1], p1[2], nrm[0], nrm[1], nrm[2]);
    const c = this.vert(p2[0], p2[1], p2[2], nrm[0], nrm[1], nrm[2]);
    if (flip) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
    return this;
  }

  /** Convex polygon fan, flat, with an explicit normal. */
  poly(points, nrm) {
    if (points.length < 3) return this;
    for (let i = 1; i < points.length - 1; i++) {
      this.triangle(points[0], points[i], points[i + 1], nrm);
    }
    return this;
  }

  /**
   * Axis-aligned box with chamfered edges. `chamfer` in metres (1–3 cm is the sweet
   * spot — a perfectly sharp 90° edge catches no highlight and is the strongest
   * "videogame from 2005" tell there is).
   *
   * @param {number[]} c   centre [x,y,z]
   * @param {number[]} h   half extents [hx,hy,hz]
   * @param {{chamfer?:number, faces?:object}} [opts]
   */
  box(c, h, opts) {
    const cham = opts?.chamfer ?? 0.02;
    const hx = Math.abs(h[0]);
    const hy = Math.abs(h[1]);
    const hz = Math.abs(h[2]);
    if (hx < 1e-5 || hy < 1e-5 || hz < 1e-5) return this;
    const k = Math.min(cham, hx * 0.45, hy * 0.45, hz * 0.45);
    // A chamfered box costs 44 triangles against 12. On a bar thinner than ~7 cm the
    // bevel is sub-pixel at any realistic viewing distance, so it is pure cost: trim,
    // mullions, balusters and slats fall back to the cheap box automatically.
    const thin = Math.min(hx, hy, hz) * 2 < (opts?.chamferMin ?? 0.075);
    if (k <= 0.0015 || thin) return this.plainBox(c, [hx, hy, hz], opts?.faces);

    const [cx, cy, cz] = c;
    const ax = hx - k;
    const ay = hy - k;
    const az = hz - k;
    const P = (x, y, z) => [cx + x, cy + y, cz + z];
    const S = [-1, 1];

    // 6 inset faces
    for (const s of S) {
      this.quad(P(s * hx, -ay, -az), P(s * hx, -ay, az), P(s * hx, ay, az), P(s * hx, ay, -az), [s, 0, 0]);
      this.quad(P(-ax, s * hy, -az), P(-ax, s * hy, az), P(ax, s * hy, az), P(ax, s * hy, -az), [0, s, 0]);
      this.quad(P(-ax, -ay, s * hz), P(-ax, ay, s * hz), P(ax, ay, s * hz), P(ax, -ay, s * hz), [0, 0, s]);
    }
    const r2 = Math.SQRT1_2;
    // 12 edge chamfers
    for (const sa of S) {
      for (const sb of S) {
        // along Z (between ±X and ±Y)
        this.quad(
          P(sa * hx, sb * ay, -az),
          P(sa * hx, sb * ay, az),
          P(sa * ax, sb * hy, az),
          P(sa * ax, sb * hy, -az),
          [sa * r2, sb * r2, 0]
        );
        // along Y (between ±X and ±Z)
        this.quad(
          P(sa * hx, -ay, sb * az),
          P(sa * hx, ay, sb * az),
          P(sa * ax, ay, sb * hz),
          P(sa * ax, -ay, sb * hz),
          [sa * r2, 0, sb * r2]
        );
        // along X (between ±Y and ±Z)
        this.quad(
          P(-ax, sa * hy, sb * az),
          P(ax, sa * hy, sb * az),
          P(ax, sa * ay, sb * hz),
          P(-ax, sa * ay, sb * hz),
          [0, sa * r2, sb * r2]
        );
      }
    }
    const r3 = 1 / Math.sqrt(3);
    for (const sx of S) {
      for (const sy of S) {
        for (const sz of S) {
          this.triangle(
            P(sx * hx, sy * ay, sz * az),
            P(sx * ax, sy * hy, sz * az),
            P(sx * ax, sy * ay, sz * hz),
            [sx * r3, sy * r3, sz * r3]
          );
        }
      }
    }
    return this;
  }

  /** Cheap 6-quad box for structure the player never sees an edge of. */
  plainBox(c, h, faces) {
    const [cx, cy, cz] = c;
    const [hx, hy, hz] = h;
    const P = (x, y, z) => [cx + x, cy + y, cz + z];
    const f = faces || null;
    if (!f || f.px !== false) this.quad(P(hx, -hy, -hz), P(hx, -hy, hz), P(hx, hy, hz), P(hx, hy, -hz), [1, 0, 0]);
    if (!f || f.nx !== false) this.quad(P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz), [-1, 0, 0]);
    if (!f || f.py !== false) this.quad(P(-hx, hy, -hz), P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), [0, 1, 0]);
    if (!f || f.ny !== false) this.quad(P(-hx, -hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, -hy, -hz), [0, -1, 0]);
    if (!f || f.pz !== false) this.quad(P(-hx, -hy, hz), P(-hx, hy, hz), P(hx, hy, hz), P(hx, -hy, hz), [0, 0, 1]);
    if (!f || f.nz !== false) this.quad(P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz), P(hx, -hy, -hz), [0, 0, -1]);
    return this;
  }

  /**
   * Generic prism from a bottom ring to a top ring (same length, matching order).
   * Wedges, tapered plinths, sloped coping and kerb returns all come from this.
   */
  prism(bottom, top, opts) {
    const n = bottom.length;
    if (n < 3 || top.length !== n) return this;
    if (opts?.cap !== false) {
      // Cap normals point away from the opposite ring, whatever the winding was.
      let bx = 0;
      let by = 0;
      let bz = 0;
      let tx = 0;
      let ty = 0;
      let tz = 0;
      for (let i = 0; i < n; i++) {
        bx += bottom[i][0];
        by += bottom[i][1];
        bz += bottom[i][2];
        tx += top[i][0];
        ty += top[i][1];
        tz += top[i][2];
      }
      _v0.set((tx - bx) / n, (ty - by) / n, (tz - bz) / n);
      if (_v0.lengthSq() < 1e-12) _v0.set(0, 1, 0);
      _v0.normalize();
      this.poly(top, [_v0.x, _v0.y, _v0.z]);
      this.poly(bottom.slice().reverse(), [-_v0.x, -_v0.y, -_v0.z]);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.quad(bottom[i], bottom[j], top[j], top[i], null);
    }
    return this;
  }

  /**
   * Cylinder along an arbitrary axis. Used for columns, pipes, railings, rebar.
   * `segments` 6–16; below 8 add `flat` so the facets read as machined, not broken.
   */
  cylinder(from, to, radius, segments = 10, opts) {
    const ax = to[0] - from[0];
    const ay = to[1] - from[1];
    const az = to[2] - from[2];
    const len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-5 || radius < 1e-5) return this;
    const dx = ax / len;
    const dy = ay / len;
    const dz = az / len;
    // Any vector not parallel to the axis makes a stable frame.
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (Math.abs(dy) > 0.94) {
      ux = 1;
      uy = 0;
    }
    let tx = uy * dz - uz * dy;
    let ty = uz * dx - ux * dz;
    let tz = ux * dy - uy * dx;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = dy * tz - dz * ty;
    const by = dz * tx - dx * tz;
    const bz = dx * ty - dy * tx;
    const r1 = opts?.radius2 ?? radius;
    const bot = [];
    const top = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ox = tx * ca + bx * sa;
      const oy = ty * ca + by * sa;
      const oz = tz * ca + bz * sa;
      bot.push([from[0] + ox * radius, from[1] + oy * radius, from[2] + oz * radius]);
      top.push([to[0] + ox * r1, to[1] + oy * r1, to[2] + oz * r1]);
    }
    const caps = opts?.caps !== false;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const a = ((i + 0.5) / segments) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.quad(bot[i], bot[j], top[j], top[i], [tx * ca + bx * sa, ty * ca + by * sa, tz * ca + bz * sa]);
    }
    if (caps) {
      this.poly(top, [dx, dy, dz]);
      this.poly(bot.slice().reverse(), [-dx, -dy, -dz]);
    }
    return this;
  }

  /**
   * Semicircular arch ring extruded along Z or X — the voussoir band over a doorway.
   * `axis` is the extrusion direction ('x' or 'z'). Returns nothing; adds intrados,
   * extrados and both faces so the arch has real thickness and a real reveal.
   */
  archRing(cx, cy, cz, rInner, rOuter, depth, axis, segments = 12, opts) {
    const half = depth * 0.5;
    const a0 = opts?.a0 ?? 0;
    const a1 = opts?.a1 ?? Math.PI;
    const along = axis === 'x' ? [1, 0, 0] : [0, 0, 1];
    const side = axis === 'x' ? [0, 0, 1] : [1, 0, 0];
    const at = (r, a, t) => [
      cx + side[0] * Math.cos(a) * r + along[0] * t,
      cy + Math.sin(a) * r,
      cz + side[2] * Math.cos(a) * r + along[2] * t,
    ];
    for (let i = 0; i < segments; i++) {
      const aa = a0 + ((a1 - a0) * i) / segments;
      const ab = a0 + ((a1 - a0) * (i + 1)) / segments;
      const am = (aa + ab) * 0.5;
      const nIn = [-side[0] * Math.cos(am), -Math.sin(am), -side[2] * Math.cos(am)];
      const nOut = [side[0] * Math.cos(am), Math.sin(am), side[2] * Math.cos(am)];
      // intrados (soffit)
      this.quad(at(rInner, aa, -half), at(rInner, ab, -half), at(rInner, ab, half), at(rInner, aa, half), nIn);
      // extrados
      this.quad(at(rOuter, aa, -half), at(rOuter, aa, half), at(rOuter, ab, half), at(rOuter, ab, -half), nOut);
      // the two faces
      this.quad(
        at(rInner, aa, -half),
        at(rOuter, aa, -half),
        at(rOuter, ab, -half),
        at(rInner, ab, -half),
        [-along[0], 0, -along[2]]
      );
      this.quad(
        at(rInner, aa, half),
        at(rInner, ab, half),
        at(rOuter, ab, half),
        at(rOuter, aa, half),
        [along[0], 0, along[2]]
      );
    }
    return this;
  }

  /** Append another builder's contents (already in world space). */
  append(other) {
    const base = this.p.length / 3;
    for (let i = 0; i < other.p.length; i++) this.p.push(other.p[i]);
    for (let i = 0; i < other.n.length; i++) this.n.push(other.n[i]);
    for (let i = 0; i < other.u.length; i++) this.u.push(other.u[i]);
    for (let i = 0; i < other.c.length; i++) this.c.push(other.c[i]);
    for (let i = 0; i < other.o.length; i++) this.o.push(other.o[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(other.idx[i] + base);
    return this;
  }

  /** @returns {THREE.BufferGeometry|null} */
  toGeometry() {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.u), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setAttribute('codOcc', new THREE.BufferAttribute(new Float32Array(this.o), 1));
    const n = this.p.length / 3;
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Rotate a 2D point about the origin — used constantly for yawed footprints. */
export function rot2(x, z, cs, sn) {
  return [x * cs - z * sn, x * sn + z * cs];
}

export default MeshBuilder;
