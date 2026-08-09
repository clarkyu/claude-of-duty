/**
 * props/geom.js — procedural geometry toolkit for set dressing. Owner: props agent.
 *
 * Nothing here touches the scene, physics or materials: it is pure geometry plus two
 * accumulators. Everything is authored in **metres at true size** so the box UV
 * projection below produces metre-space UVs, which is exactly the convention
 * MaterialLibrary.get() expects (uv (0,0)..(4,3) covers 4 m x 3 m).
 *
 * Primitives (all return a `Prim` = {p:[], n:[], i:[]}, flat arrays, origin-centred):
 *   chamferBox(sx,sy,sz,ch)      real bevelled box — 44 tris, the workhorse
 *   plainBox(sx,sy,sz)           12 tris, LOD-1 / hidden parts only
 *   revolve(profile,seg,opts)    lathe around Y; drums, posts, hydrants, cones
 *   cyl(r,h,seg,opts)            revolve() shorthand with chamfered rims
 *   tube(points,r,seg,opts)      parallel-transport sweep; cable, wire, railings
 *   helix(...)                   razor-wire coil
 *   torusPrim(R,r,seg,tSeg,arc)  tyres, rings
 *   sheet(nx,ny,fn)              cloth/awning grid; fn(u,v) returns the full position
 *   blob(sx,sy,sz,seg,fn)        deformable rounded mass — sandbags, rubble, produce
 *   quadPrim(w,h)                single plane in XY
 *
 * Accumulator:
 *   Accum  — per-material vertex pools with a matrix stack, metre-space box UVs,
 *            and the vertex-colour MASK the MaterialLibrary reads
 *            (r = grime, g = layer blend, b = water pooling). Grime is authored as a
 *            function of prop-local height so every prop is dirtier where it meets the
 *            ground, which is most of what "grounded" reads as at a glance. Props never
 *            use the layer blend, so `g` is repurposed as the **cloth flap mask** that
 *            props/materials.js animates — 0 at a seam or a pole, 1 at a free edge.
 *
 * Determinism: `Rng` is mulberry32. No Math.random() anywhere in this module.
 */
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);

/* ========================================================================== */
/*                                    rng                                     */
/* ========================================================================== */

/** Deterministic per-prop stream. Seeded from ctx.rng() so screenshots repeat. */
export class Rng {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** uniform in [a,b) */
  range(a, b) {
    return a + (b - a) * this.next();
  }
  /** symmetric jitter in [-a,a) */
  jitter(a) {
    return (this.next() * 2 - 1) * a;
  }
  int(n) {
    return Math.floor(this.next() * n) % Math.max(1, n);
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  chance(p) {
    return this.next() < p;
  }
  /** roughly gaussian, mean 0, sd ~0.4 */
  gauss() {
    return (this.next() + this.next() + this.next() - 1.5) * 0.8;
  }
}

/** Stable integer hash — turns a world position into a seed. */
export function hashSeed(a, b = 0, c = 0) {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ ((a * 8191) | 0), 0x01000193);
  h = Math.imul(h ^ ((b * 6151) | 0), 0x01000193);
  h = Math.imul(h ^ ((c * 3079) | 0), 0x01000193);
  h ^= h >>> 13;
  return h >>> 0;
}

/* ========================================================================== */
/*                              primitive plumbing                            */
/* ========================================================================== */

/** @typedef {{p:number[], n:number[], i:number[]}} Prim */

export function prim() {
  return { p: [], n: [], i: [] };
}

export function vert(pr, x, y, z, nx, ny, nz) {
  const id = pr.p.length / 3;
  pr.p.push(x, y, z);
  pr.n.push(nx, ny, nz);
  return id;
}

function faceNormal(a, b, c, out) {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / l;
  out[1] = ny / l;
  out[2] = nz / l;
  return out;
}

const _fn = [0, 0, 0];

/**
 * Triangle with a *desired* outward normal. Winding is corrected automatically, which
 * removes an entire class of sign bugs from the chamfer code below.
 */
export function tri(pr, a, b, c, nrm) {
  faceNormal(a, b, c, _fn);
  let flip = false;
  if (nrm) {
    flip = _fn[0] * nrm[0] + _fn[1] * nrm[1] + _fn[2] * nrm[2] < 0;
  }
  // The *desired* normal is authoritative; only the winding is corrected.
  const n = nrm || _fn;
  const nx = n[0];
  const ny = n[1];
  const nz = n[2];
  const i0 = vert(pr, a[0], a[1], a[2], nx, ny, nz);
  const i1 = vert(pr, b[0], b[1], b[2], nx, ny, nz);
  const i2 = vert(pr, c[0], c[1], c[2], nx, ny, nz);
  if (flip) pr.i.push(i0, i2, i1);
  else pr.i.push(i0, i1, i2);
}

/** Planar quad a-b-c-d with a desired outward normal. */
export function quad(pr, a, b, c, d, nrm) {
  tri(pr, a, b, c, nrm);
  tri(pr, a, c, d, nrm);
}

/** Merge `src` into `dst`, optionally through a Matrix4. */
export function mergePrim(dst, src, mtx) {
  const base = dst.p.length / 3;
  if (!mtx) {
    for (let k = 0; k < src.p.length; k++) dst.p.push(src.p[k]);
    for (let k = 0; k < src.n.length; k++) dst.n.push(src.n[k]);
  } else {
    const e = mtx.elements;
    const nm = _normalMat(mtx);
    for (let k = 0; k < src.p.length; k += 3) {
      const x = src.p[k];
      const y = src.p[k + 1];
      const z = src.p[k + 2];
      dst.p.push(
        e[0] * x + e[4] * y + e[8] * z + e[12],
        e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14]
      );
      const nx = src.n[k];
      const ny = src.n[k + 1];
      const nz = src.n[k + 2];
      let ox = nm[0] * nx + nm[3] * ny + nm[6] * nz;
      let oy = nm[1] * nx + nm[4] * ny + nm[7] * nz;
      let oz = nm[2] * nx + nm[5] * ny + nm[8] * nz;
      const l = Math.hypot(ox, oy, oz) || 1;
      dst.n.push(ox / l, oy / l, oz / l);
    }
  }
  for (let k = 0; k < src.i.length; k++) dst.i.push(src.i[k] + base);
  return dst;
}

const _nm = new Float64Array(9);
function _normalMat(m) {
  // inverse-transpose of the upper 3x3; props only ever use rigid + uniform scale
  // transforms, so the cheap adjugate path is exact here.
  const e = m.elements;
  const a = e[0];
  const b = e[1];
  const c = e[2];
  const d = e[4];
  const f = e[5];
  const g = e[6];
  const h = e[8];
  const i = e[9];
  const j = e[10];
  _nm[0] = f * j - g * i;
  _nm[1] = g * h - d * j;
  _nm[2] = d * i - f * h;
  _nm[3] = c * i - b * j;
  _nm[4] = a * j - c * h;
  _nm[5] = b * h - a * i;
  _nm[6] = b * g - c * f;
  _nm[7] = c * d - a * g;
  _nm[8] = a * f - b * d;
  return _nm;
}

/* ========================================================================== */
/*                                 primitives                                 */
/* ========================================================================== */

/**
 * Box with a real 45° chamfer on all twelve edges: 6 inset faces, 12 edge strips,
 * 8 corner triangles. The bevel is what turns a grey cuboid into something that
 * catches a highlight — never place an unchamfered box where the player can see it.
 */
export function chamferBox(sx, sy, sz, ch = 0.02) {
  const ext = [sx * 0.5, sy * 0.5, sz * 0.5];
  // A bevel on a 12 mm wire is sub-pixel at any distance you can see the wire from, and
  // it costs 3.7x the triangles. Below 30 mm the plain box is the honest choice.
  if (Math.min(sx, sy, sz) < 0.03) return plainBox(sx, sy, sz);
  const t = Math.min(ch, ext[0] * 0.48, ext[1] * 0.48, ext[2] * 0.48);
  if (t <= 1e-4) return plainBox(sx, sy, sz);
  const pr = prim();
  const P = (i, vi, j, vj, k, vk) => {
    const o = [0, 0, 0];
    o[i] = vi;
    o[j] = vj;
    o[k] = vk;
    return o;
  };

  /* 6 inset faces */
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    const J = ext[j] - t;
    const K = ext[k] - t;
    for (const s of [1, -1]) {
      const n = [0, 0, 0];
      n[i] = s;
      const A = P(i, s * ext[i], j, -J, k, -K);
      const B = P(i, s * ext[i], j, J, k, -K);
      const C = P(i, s * ext[i], j, J, k, K);
      const D = P(i, s * ext[i], j, -J, k, K);
      quad(pr, A, B, C, D, n);
    }
  }

  /* 12 edge strips */
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const k = 3 - i - j;
      const K = ext[k] - t;
      for (const si of [1, -1]) {
        for (const sj of [1, -1]) {
          const n = [0, 0, 0];
          n[i] = si * Math.SQRT1_2;
          n[j] = sj * Math.SQRT1_2;
          const a = P(i, si * ext[i], j, sj * (ext[j] - t), k, -K);
          const b = P(i, si * ext[i], j, sj * (ext[j] - t), k, K);
          const c = P(i, si * (ext[i] - t), j, sj * ext[j], k, K);
          const d = P(i, si * (ext[i] - t), j, sj * ext[j], k, -K);
          quad(pr, a, b, c, d, n);
        }
      }
    }
  }

  /* 8 corner triangles */
  const r3 = 1 / Math.sqrt(3);
  for (const sx2 of [1, -1]) {
    for (const sy2 of [1, -1]) {
      for (const sz2 of [1, -1]) {
        const n = [sx2 * r3, sy2 * r3, sz2 * r3];
        const a = [sx2 * ext[0], sy2 * (ext[1] - t), sz2 * (ext[2] - t)];
        const b = [sx2 * (ext[0] - t), sy2 * ext[1], sz2 * (ext[2] - t)];
        const c = [sx2 * (ext[0] - t), sy2 * (ext[1] - t), sz2 * ext[2]];
        tri(pr, a, b, c, n);
      }
    }
  }
  return pr;
}

/** No bevel — 12 tris. LOD shells, interiors, anything smaller than a chamfer. */
export function plainBox(sx, sy, sz) {
  const pr = prim();
  const a = sx * 0.5;
  const b = sy * 0.5;
  const c = sz * 0.5;
  const F = [
    [[1, 0, 0], [a, -b, -c], [a, -b, c], [a, b, c], [a, b, -c]],
    [[-1, 0, 0], [-a, -b, c], [-a, -b, -c], [-a, b, -c], [-a, b, c]],
    [[0, 1, 0], [-a, b, -c], [a, b, -c], [a, b, c], [-a, b, c]],
    [[0, -1, 0], [-a, -b, c], [a, -b, c], [a, -b, -c], [-a, -b, -c]],
    [[0, 0, 1], [-a, -b, c], [-a, b, c], [a, b, c], [a, -b, c]],
    [[0, 0, -1], [a, -b, -c], [a, b, -c], [-a, b, -c], [-a, -b, -c]],
  ];
  for (const f of F) quad(pr, f[1], f[2], f[3], f[4], f[0]);
  return pr;
}

/**
 * Lathe a 2-D profile [[r,y], …] around Y. Normals are smooth around the axis and
 * flat along it, which is what you want for a drum: a clean specular band, crisp rims.
 * @param {Array<[number,number]>} profile bottom-to-top; r may be 0 to close a cap
 */
export function revolve(profile, seg = 16, opts = {}) {
  const pr = prim();
  const arc = opts.arc ?? TAU;
  const closed = arc >= TAU - 1e-6;
  const n = Math.max(3, seg | 0);
  const steps = closed ? n : n + 1;
  const cos = new Float64Array(steps);
  const sin = new Float64Array(steps);
  const a0 = opts.startAngle ?? 0;
  for (let s = 0; s < steps; s++) {
    const a = a0 + (arc * s) / n;
    cos[s] = Math.cos(a);
    sin[s] = Math.sin(a);
  }
  for (let k = 0; k < profile.length - 1; k++) {
    const [r0, y0] = profile[k];
    const [r1, y1] = profile[k + 1];
    if (Math.abs(r0) < 1e-6 && Math.abs(r1) < 1e-6) continue;
    const dr = r1 - r0;
    const dy = y1 - y0;
    const nl = Math.hypot(dr, dy) || 1;
    const nr = dy / nl;
    const ny = -dr / nl;
    for (let s = 0; s < (closed ? n : n); s++) {
      const s2 = (s + 1) % steps;
      const c0 = cos[s];
      const q0 = sin[s];
      const c1 = cos[s2];
      const q1 = sin[s2];
      const A = [r0 * c0, y0, r0 * q0];
      const B = [r0 * c1, y0, r0 * q1];
      const C = [r1 * c1, y1, r1 * q1];
      const D = [r1 * c0, y1, r1 * q0];
      const nA = [nr * c0, ny, nr * q0];
      const nB = [nr * c1, ny, nr * q1];
      const i0 = vert(pr, A[0], A[1], A[2], nA[0], nA[1], nA[2]);
      const i1 = vert(pr, B[0], B[1], B[2], nB[0], nB[1], nB[2]);
      const i2 = vert(pr, C[0], C[1], C[2], nB[0], nB[1], nB[2]);
      const i3 = vert(pr, D[0], D[1], D[2], nA[0], nA[1], nA[2]);
      // A -> D -> C -> B is outward-facing for a bottom-to-top profile swept with
      // theta increasing; it stays correct for caps (r -> 0) with no special case.
      pr.i.push(i0, i3, i2, i0, i2, i1);
    }
  }
  return pr;
}

/** Cylinder with chamfered rims, centred on the origin, axis +Y. */
export function cyl(r, h, seg = 14, opts = {}) {
  const ch = Math.min(opts.chamfer ?? 0.012, r * 0.4, h * 0.24);
  const rt = opts.rTop ?? r;
  const cap = opts.cap !== false;
  const p = [];
  if (cap) p.push([0, -h / 2]);
  p.push([r - ch, -h / 2], [r, -h / 2 + ch], [rt, h / 2 - ch], [rt - ch, h / 2]);
  if (cap) p.push([0, h / 2]);
  return revolve(p, seg, opts);
}

/** Sweep a circle along a polyline with parallel-transport frames. */
export function tube(points, radius, seg = 6, opts = {}) {
  const pr = prim();
  const n = points.length;
  if (n < 2) return pr;
  const cap = opts.cap !== false;
  const tan = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    let tz = b[2] - a[2];
    const l = Math.hypot(tx, ty, tz) || 1;
    tan.push([tx / l, ty / l, tz / l]);
  }
  // seed a normal perpendicular to the first tangent
  let nx = 0;
  let ny = 1;
  let nz = 0;
  if (Math.abs(tan[0][1]) > 0.9) {
    nx = 1;
    ny = 0;
  }
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = tan[i];
    // Gram-Schmidt against the tangent keeps the frame from twisting.
    const d = nx * t[0] + ny * t[1] + nz * t[2];
    let ux = nx - d * t[0];
    let uy = ny - d * t[1];
    let uz = nz - d * t[2];
    let l = Math.hypot(ux, uy, uz);
    if (l < 1e-5) {
      ux = t[1];
      uy = -t[0];
      uz = 0;
      l = Math.hypot(ux, uy, uz) || 1;
    }
    ux /= l;
    uy /= l;
    uz /= l;
    const vx = t[1] * uz - t[2] * uy;
    const vy = t[2] * ux - t[0] * uz;
    const vz = t[0] * uy - t[1] * ux;
    frames.push([ux, uy, uz, vx, vy, vz]);
    nx = ux;
    ny = uy;
    nz = uz;
  }
  const rad = typeof radius === 'function' ? radius : () => radius;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const p0 = points[i];
    const r = rad(i / (n - 1), i);
    const row = [];
    for (let s = 0; s < seg; s++) {
      const a = (TAU * s) / seg;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const dx = f[0] * ca + f[3] * sa;
      const dy = f[1] * ca + f[4] * sa;
      const dz = f[2] * ca + f[5] * sa;
      row.push(vert(pr, p0[0] + dx * r, p0[1] + dy * r, p0[2] + dz * r, dx, dy, dz));
    }
    ring.push(row);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < seg; s++) {
      const s2 = (s + 1) % seg;
      pr.i.push(ring[i][s], ring[i + 1][s2], ring[i + 1][s]);
      pr.i.push(ring[i][s], ring[i][s2], ring[i + 1][s2]);
    }
  }
  if (cap) {
    for (const [idx, dir] of [[0, -1], [n - 1, 1]]) {
      const t = tan[idx];
      const c = vert(pr, points[idx][0], points[idx][1], points[idx][2], t[0] * dir, t[1] * dir, t[2] * dir);
      const f = frames[idx];
      const r = rad(idx / (n - 1), idx);
      const rim = [];
      for (let s = 0; s < seg; s++) {
        const a = (TAU * s) / seg;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const dx = f[0] * ca + f[3] * sa;
        const dy = f[1] * ca + f[4] * sa;
        const dz = f[2] * ca + f[5] * sa;
        rim.push(
          vert(pr, points[idx][0] + dx * r, points[idx][1] + dy * r, points[idx][2] + dz * r, t[0] * dir, t[1] * dir, t[2] * dir)
        );
      }
      for (let s = 0; s < seg; s++) {
        const s2 = (s + 1) % seg;
        if (dir > 0) pr.i.push(c, rim[s], rim[s2]);
        else pr.i.push(c, rim[s2], rim[s]);
      }
    }
  }
  return pr;
}

/** Coil for razor wire / springs. Axis is +X so it lays along a fence run. */
export function helix(length, coilR, wireR, turns, seg = 7, ptsPerTurn = 8) {
  const pts = [];
  const total = Math.max(4, Math.round(turns * ptsPerTurn));
  for (let i = 0; i <= total; i++) {
    const t = i / total;
    const a = t * turns * TAU;
    pts.push([t * length - length / 2, Math.sin(a) * coilR, Math.cos(a) * coilR]);
  }
  return tube(pts, wireR, seg, { cap: false });
}

export function torusPrim(R, r, seg = 18, tSeg = 8, arc = TAU) {
  const pr = prim();
  const rows = [];
  const nSeg = Math.max(3, seg | 0);
  const closed = arc >= TAU - 1e-6;
  const steps = closed ? nSeg : nSeg + 1;
  for (let i = 0; i < steps; i++) {
    const a = (arc * i) / nSeg;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const row = [];
    for (let j = 0; j < tSeg; j++) {
      const b = (TAU * j) / tSeg;
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      const nx = cb * ca;
      const nz = cb * sa;
      const ny = sb;
      row.push(vert(pr, (R + r * cb) * ca, r * sb, (R + r * cb) * sa, nx, ny, nz));
    }
    rows.push(row);
  }
  for (let i = 0; i < (closed ? steps : steps - 1); i++) {
    const r0 = rows[i];
    const r1 = rows[(i + 1) % steps];
    for (let j = 0; j < tSeg; j++) {
      const j2 = (j + 1) % tSeg;
      pr.i.push(r0[j], r1[j2], r1[j]);
      pr.i.push(r0[j], r0[j2], r1[j2]);
    }
  }
  return pr;
}

/**
 * Cloth / awning grid in the XZ plane centred on the origin.
 * @param {(u:number,v:number)=>[number,number,number]} fn full position for (u,v) in 0..1
 */
export function sheet(nx, ny, fn) {
  const pr = prim();
  const cols = Math.max(2, nx | 0);
  const rows = Math.max(2, ny | 0);
  const grid = [];
  const pos = [];
  for (let j = 0; j < rows; j++) {
    const line = [];
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1);
      const v = j / (rows - 1);
      const p = fn(u, v);
      pos.push(p);
      line.push(p);
    }
    grid.push(line);
  }
  // central-difference normals so the sag actually shades
  const idx = [];
  for (let j = 0; j < rows; j++) {
    const line = [];
    for (let i = 0; i < cols; i++) {
      const a = grid[j][Math.min(cols - 1, i + 1)];
      const b = grid[j][Math.max(0, i - 1)];
      const c = grid[Math.min(rows - 1, j + 1)][i];
      const d = grid[Math.max(0, j - 1)][i];
      const ux = a[0] - b[0];
      const uy = a[1] - b[1];
      const uz = a[2] - b[2];
      const vx = c[0] - d[0];
      const vy = c[1] - d[1];
      const vz = c[2] - d[2];
      let nx2 = uy * vz - uz * vy;
      let ny2 = uz * vx - ux * vz;
      let nz2 = ux * vy - uy * vx;
      let l = Math.hypot(nx2, ny2, nz2);
      if (l < 1e-9) {
        // a pinched corner has no local surface to differentiate; +Y is the safe guess
        nx2 = 0;
        ny2 = -1;
        nz2 = 0;
        l = 1;
      }
      const p = grid[j][i];
      // negated so the shading normal agrees with the triangle winding below
      line.push(vert(pr, p[0], p[1], p[2], -nx2 / l, -ny2 / l, -nz2 / l));
    }
    idx.push(line);
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      pr.i.push(idx[j][i], idx[j + 1][i], idx[j + 1][i + 1]);
      pr.i.push(idx[j][i], idx[j + 1][i + 1], idx[j][i + 1]);
    }
  }
  return pr;
}

/**
 * A squashable rounded mass. `fn(dirX,dirY,dirZ)` returns either a scalar radial
 * multiplier or a `[mx,my,mz]` triple. The triple matters for sandbags: squashing a bag
 * against the one below it must flatten it in Y *only* — scaling all three axes pinches
 * the shoulders in and turns the bag into a doughnut.
 */
export function blob(sx, sy, sz, seg = 10, fn = null) {
  const pr = prim();
  const rings = Math.max(3, (seg * 0.6) | 0);
  const cols = Math.max(5, seg | 0);
  const grid = [];
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    const row = [];
    for (let i = 0; i < cols; i++) {
      const th = (i / cols) * TAU;
      const dx = sp * Math.cos(th);
      const dy = cp;
      const dz = sp * Math.sin(th);
      const m = fn ? fn(dx, dy, dz) : 1;
      const mx = typeof m === 'number' ? m : m[0];
      const my = typeof m === 'number' ? m : m[1];
      const mz = typeof m === 'number' ? m : m[2];
      // the sphere direction is kept: at the poles every column collapses to one point,
      // so the central-difference normal is zero and has to fall back to it
      row.push([dx * sx * 0.5 * mx, dy * sy * 0.5 * my, dz * sz * 0.5 * mz, dx, dy, dz]);
    }
    grid.push(row);
  }
  const idx = [];
  for (let j = 0; j <= rings; j++) {
    const row = [];
    for (let i = 0; i < cols; i++) {
      const p = grid[j][i];
      const a = grid[j][(i + 1) % cols];
      const b = grid[j][(i - 1 + cols) % cols];
      const c = grid[Math.min(rings, j + 1)][i];
      const d = grid[Math.max(0, j - 1)][i];
      const ux = a[0] - b[0];
      const uy = a[1] - b[1];
      const uz = a[2] - b[2];
      const vx = c[0] - d[0];
      const vy = c[1] - d[1];
      const vz = c[2] - d[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      let l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) {
        nx = p[3];
        ny = p[4];
        nz = p[5];
        l = Math.hypot(nx, ny, nz) || 1;
      }
      row.push(vert(pr, p[0], p[1], p[2], nx / l, ny / l, nz / l));
    }
    idx.push(row);
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < cols; i++) {
      const i2 = (i + 1) % cols;
      pr.i.push(idx[j][i], idx[j + 1][i2], idx[j + 1][i]);
      pr.i.push(idx[j][i], idx[j][i2], idx[j + 1][i2]);
    }
  }
  return pr;
}

/** Single quad in the XY plane, +Z facing. */
export function quadPrim(w, h) {
  const pr = prim();
  const a = w / 2;
  const b = h / 2;
  quad(pr, [-a, -b, 0], [a, -b, 0], [a, b, 0], [-a, b, 0], [0, 0, 1]);
  return pr;
}

/** Flat disc in the XZ plane, +Y facing (contact patches, manhole lids). */
export function discXZ(r, seg = 16) {
  const pr = prim();
  const c = vert(pr, 0, 0, 0, 0, 1, 0);
  const rim = [];
  for (let i = 0; i < seg; i++) {
    const a = (TAU * i) / seg;
    rim.push(vert(pr, Math.cos(a) * r, 0, Math.sin(a) * r, 0, 1, 0));
  }
  for (let i = 0; i < seg; i++) pr.i.push(c, rim[(i + 1) % seg], rim[i]);
  return pr;
}

/* ========================================================================== */
/*                                 accumulator                                */
/* ========================================================================== */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

/** Convenience transform builder — rigid only, uniform scale. */
export function xf(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q, new THREE.Vector3(s, s, s));
}

/** Rotation about +Y only — the common case. */
export function yawXf(x, y, z, yaw, s = 1) {
  return xf(x, y, z, 0, yaw, 0, s);
}

const _badGeom = new Set();

function finitePrim(pr) {
  if (!pr || !pr.p) return false;
  for (let k = 0; k < pr.p.length; k++) if (!Number.isFinite(pr.p[k])) return false;
  for (let k = 0; k < pr.n.length; k++) if (!Number.isFinite(pr.n[k])) return false;
  return true;
}

function finiteMtx(m) {
  const e = m?.elements;
  if (!e) return false;
  for (let k = 0; k < 16; k++) if (!Number.isFinite(e[k])) return false;
  return true;
}

class Group {
  constructor() {
    this.p = [];
    this.n = [];
    this.u = [];
    this.c = [];
    this.i = [];
    /**
     * True once anything in this group authored its own UVs through `uvFn`. Merging a
     * prop into a district normally adds a random UV offset so two copies of the same
     * crate do not show the same knot in the same place — but an *atlas* UV is an
     * index, not a tiling coordinate, and shifting it by 1.7 lands on a different
     * shop's sign. Explicit UVs are therefore never offset.
     */
    this.lockUv = false;
  }
  get count() {
    return this.p.length / 3;
  }
}

/**
 * Per-material vertex pools with a matrix stack.
 *
 * `grime` is the vertex-colour mask the MaterialLibrary reads:
 *   r = grime gain (dirt in crevices and at the ground line)
 *   g = second-material blend (unused by props; kept 0)
 *   b = water pooling (props pool at their base when it rains)
 */
export class Accum {
  constructor(opts = {}) {
    this.groups = new Map();
    this.stack = [];
    this.mtx = new THREE.Matrix4();
    /** default grime: strongest in the bottom `grimeHeight` metres */
    this.grimeHeight = opts.grimeHeight ?? 0.34;
    this.grimeGain = opts.grimeGain ?? 0.85;
    this.grimeFn = null;
    this.uvOffset = [0, 0];
    /** set by Props.js to the prop type, so a bad part can be named in a warning */
    this.tag = opts.tag || '';
    this.tris = 0;
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
  }

  group(mat) {
    let g = this.groups.get(mat);
    if (!g) {
      g = new Group();
      this.groups.set(mat, g);
    }
    return g;
  }

  push(mtx) {
    this.stack.push(this.mtx);
    this.mtx = mtx ? this.mtx.clone().multiply(mtx) : this.mtx.clone();
    return this;
  }
  pop() {
    this.mtx = this.stack.pop() || new THREE.Matrix4();
    return this;
  }

  /** Run `fn()` with `mtx` composed onto the stack. */
  at(mtx, fn) {
    this.push(mtx);
    fn(this);
    this.pop();
    return this;
  }

  /**
   * Append a primitive.
   * @param {string} mat material key
   * @param {Prim} pr
   * @param {THREE.Matrix4} [local] extra transform, composed after the stack
   * @param {object} [o] { grime:number|fn, pool:number, uvOff:[u,v], uvAxis:'x'|'y'|'z' }
   */
  add(mat, pr, local, o = {}) {
    // A single NaN vertex poisons computeBoundingSphere for the whole merged district,
    // so bad input is dropped at the door and named once rather than silently shipped.
    if (!finitePrim(pr) || !finiteMtx(this.mtx) || (local && !finiteMtx(local))) {
      const key = `${this.tag || 'prop'}:${mat}`;
      if (!_badGeom.has(key)) {
        _badGeom.add(key);
        console.warn(`[props] non-finite geometry from ${key}, part skipped`);
      }
      return this;
    }
    const g = this.group(mat);
    const base = g.count;
    _m.copy(this.mtx);
    if (local) _m.multiply(local);
    const e = _m.elements;
    const nm = _normalMat(_m);
    const gf = o.grime !== undefined ? o.grime : this.grimeFn;
    const gain = this.grimeGain;
    const gh = o.grimeHeight ?? this.grimeHeight;
    const poolBase = o.pool ?? 1;
    const ff = o.flap ?? null;
    const uo = o.uvOff || this.uvOffset;
    const uvS = o.uvScale ?? 1;

    for (let k = 0; k < pr.p.length; k += 3) {
      const lx = pr.p[k];
      const ly = pr.p[k + 1];
      const lz = pr.p[k + 2];
      const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
      const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
      const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
      g.p.push(x, y, z);
      if (x < this.min[0]) this.min[0] = x;
      if (y < this.min[1]) this.min[1] = y;
      if (z < this.min[2]) this.min[2] = z;
      if (x > this.max[0]) this.max[0] = x;
      if (y > this.max[1]) this.max[1] = y;
      if (z > this.max[2]) this.max[2] = z;

      const lnx = pr.n[k];
      const lny = pr.n[k + 1];
      const lnz = pr.n[k + 2];
      let nx = nm[0] * lnx + nm[3] * lny + nm[6] * lnz;
      let ny = nm[1] * lnx + nm[4] * lny + nm[7] * lnz;
      let nz = nm[2] * lnx + nm[5] * lny + nm[8] * lnz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      g.n.push(nx, ny, nz);

      /* metre-space box UVs projected along the dominant *local* axis, so the
         texture is glued to the part and rotates with it. */
      const ax = Math.abs(lnx);
      const ay = Math.abs(lny);
      const az = Math.abs(lnz);
      let uu;
      let vv;
      if (o.uvFn) {
        const t = o.uvFn(lx, ly, lz);
        uu = t[0];
        vv = t[1];
        g.u.push(uu, vv);
        g.lockUv = true;
      } else {
        if (ay >= ax && ay >= az) {
          uu = lx;
          vv = lz;
        } else if (ax >= az) {
          uu = lz;
          vv = ly;
        } else {
          uu = lx;
          vv = ly;
        }
        g.u.push(uu * uvS + uo[0], vv * uvS + uo[1]);
      }

      /* vertex-colour mask */
      let grime;
      if (typeof gf === 'function') grime = gf(x, y, z, lx, ly, lz);
      else if (typeof gf === 'number') grime = gf;
      else grime = clamp01(1 - y / gh) * 0.9;
      // up-facing surfaces collect dust and drip stains; undersides stay dark
      const up = clamp01(ny) * 0.22 + clamp01(-ny) * 0.34;
      grime = clamp01(grime * gain + up * 0.35);
      const pool = clamp01((1 - clamp01(y / (gh * 1.6))) * clamp01(ny) * poolBase);
      // g = cloth flap mask, consumed by the wind injection in props/materials.js
      let flap = 0;
      if (ff !== null) flap = clamp01(typeof ff === 'function' ? ff(x, y, z, lx, ly, lz) : ff);
      g.c.push(grime, flap, pool);
    }
    for (let k = 0; k < pr.i.length; k++) g.i.push(pr.i[k] + base);
    this.tris += pr.i.length / 3;
    return this;
  }

  /** Append every group of another Accum through `mtx` (prop -> district). */
  merge(other, mtx, uvOff) {
    const e = mtx ? mtx.elements : null;
    const nm = mtx ? _normalMat(mtx) : null;
    const ou = uvOff ? uvOff[0] : 0;
    const ov = uvOff ? uvOff[1] : 0;
    for (const [mat, src] of other.groups) {
      const g = this.group(mat);
      const base = g.count;
      for (let k = 0; k < src.p.length; k += 3) {
        const x = src.p[k];
        const y = src.p[k + 1];
        const z = src.p[k + 2];
        if (e) {
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
          const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
          g.p.push(wx, wy, wz);
          if (wx < this.min[0]) this.min[0] = wx;
          if (wy < this.min[1]) this.min[1] = wy;
          if (wz < this.min[2]) this.min[2] = wz;
          if (wx > this.max[0]) this.max[0] = wx;
          if (wy > this.max[1]) this.max[1] = wy;
          if (wz > this.max[2]) this.max[2] = wz;
        } else {
          g.p.push(x, y, z);
        }
        const nx = src.n[k];
        const ny = src.n[k + 1];
        const nz = src.n[k + 2];
        if (nm) {
          let ox = nm[0] * nx + nm[3] * ny + nm[6] * nz;
          let oy = nm[1] * nx + nm[4] * ny + nm[7] * nz;
          let oz = nm[2] * nx + nm[5] * ny + nm[8] * nz;
          const l = Math.hypot(ox, oy, oz) || 1;
          g.n.push(ox / l, oy / l, oz / l);
        } else {
          g.n.push(nx, ny, nz);
        }
      }
      if (src.lockUv) {
        g.lockUv = true;
        for (let k = 0; k < src.u.length; k++) g.u.push(src.u[k]);
      } else {
        for (let k = 0; k < src.u.length; k += 2) g.u.push(src.u[k] + ou, src.u[k + 1] + ov);
      }
      for (let k = 0; k < src.c.length; k++) g.c.push(src.c[k]);
      for (let k = 0; k < src.i.length; k++) g.i.push(src.i[k] + base);
    }
    this.tris += other.tris;
    return this;
  }

  isEmpty() {
    return this.groups.size === 0;
  }

  /** @returns {Map<string, THREE.BufferGeometry>} */
  build() {
    return this.buildGrouped((k) => k);
  }

  /**
   * Build one BufferGeometry per *resolved* group token. Several material keys can
   * alias to the same THREE.Material (paving -> concrete, alu -> galv, …); grouping by
   * the resolved token is what keeps a merged district to one draw call per material
   * rather than one per key.
   * @param {(matKey:string)=>any} keyOf
   * @returns {Map<any, THREE.BufferGeometry>}
   */
  buildGrouped(keyOf) {
    /** @type {Map<any, Group[]>} */
    const buckets = new Map();
    for (const [mat, g] of this.groups) {
      if (!g.i.length) continue;
      const token = keyOf(mat);
      let list = buckets.get(token);
      if (!list) {
        list = [];
        buckets.set(token, list);
      }
      list.push(g);
    }
    const out = new Map();
    for (const [token, list] of buckets) {
      let nv = 0;
      let ni = 0;
      for (const g of list) {
        nv += g.p.length / 3;
        ni += g.i.length;
      }
      const pos = new Float32Array(nv * 3);
      const nrm = new Float32Array(nv * 3);
      const uv = new Float32Array(nv * 2);
      const col = new Float32Array(nv * 3);
      const IndexArray = nv > 65000 ? Uint32Array : Uint16Array;
      const idx = new IndexArray(ni);
      let vo = 0;
      let io = 0;
      for (const g of list) {
        pos.set(g.p, vo * 3);
        nrm.set(g.n, vo * 3);
        uv.set(g.u, vo * 2);
        col.set(g.c, vo * 3);
        for (let k = 0; k < g.i.length; k++) idx[io + k] = g.i[k] + vo;
        vo += g.p.length / 3;
        io += g.i.length;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      out.set(token, geo);
    }
    return out;
  }

  /** Local-space bounds of everything added so far. */
  bounds() {
    if (this.min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    return {
      min: this.min.slice(),
      max: this.max.slice(),
      size: [this.max[0] - this.min[0], this.max[1] - this.min[1], this.max[2] - this.min[2]],
    };
  }
}

/* ========================================================================== */
/*                          small procedural textures                         */
/* ========================================================================== */

/**
 * Chain-link diamond weave as an alpha map. Real wire geometry at 50 mm aperture
 * would be ~40 k tris per panel; a cutout costs four.
 */
export function chainLinkAlpha(size = 128, thickness = 0.13) {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // two crossing sawtooth bands = a diamond weave
      const a = Math.abs(((u + v) % 0.5) / 0.5 - 0.5) * 2;
      const b = Math.abs(((u - v + 1) % 0.5) / 0.5 - 0.5) * 2;
      const w = Math.min(a, b);
      const on = w > 1 - thickness * 2 ? 255 : 0;
      const i = (y * size + x) * 4;
      // slight shading so the wire is not a flat silhouette
      const shade = 190 + Math.round(60 * (1 - w));
      d[i] = d[i + 1] = d[i + 2] = on ? shade : 0;
      d[i + 3] = on;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Soft radial falloff — contact grime patches under props. */
export function radialFadeAlpha(size = 64, power = 1.8) {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      const r = clamp01(1 - Math.hypot(u, v) * 2);
      // lumpy edge so the patch is not a perfect circle
      const wob = 0.82 + 0.18 * Math.sin(Math.atan2(v, u) * 5.0 + u * 9.0);
      const a = Math.round(255 * Math.pow(clamp01(r * wob * 1.15), power));
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = a;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Torn chain-link: the weave with a ragged bite out of the middle. */
export function tornChainAlpha(size = 128, seed = 7) {
  const t = chainLinkAlpha(size, 0.13);
  const d = t.image.data;
  const rng = new Rng(seed);
  const cx = rng.range(0.3, 0.7);
  const cy = rng.range(0.35, 0.75);
  const rr = rng.range(0.16, 0.3);
  const lobes = [];
  for (let i = 0; i < 7; i++) lobes.push(rng.range(0.6, 1.4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size - cx;
      const v = y / size - cy;
      const ang = Math.atan2(v, u);
      const li = ((ang + Math.PI) / TAU) * lobes.length;
      const l0 = lobes[Math.floor(li) % lobes.length];
      const l1 = lobes[(Math.floor(li) + 1) % lobes.length];
      const l = lerp(l0, l1, li - Math.floor(li));
      if (Math.hypot(u, v) < rr * l) d[(y * size + x) * 4 + 3] = 0;
    }
  }
  t.needsUpdate = true;
  return t;
}

export default {
  Rng,
  Accum,
  chamferBox,
  plainBox,
  revolve,
  cyl,
  tube,
  helix,
  torusPrim,
  sheet,
  blob,
  quadPrim,
  discXZ,
  xf,
  yawXf,
};
