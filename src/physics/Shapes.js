/**
 * Shapes.js — collision geometry, mass properties and the complete narrowphase.
 * Owner: physics agent. Internal to src/physics/*; surfaced through `ctx.physics.shapes`.
 *
 * Public API
 *   SHAPE                                        shape-type enum
 *   sphere/box/capsule/convex/trimesh/heightfield/compound   shape factories
 *   computeAABB(shape, pos, quat, outMin, outMax)
 *   computeInertia(shape, mass, outMatrix3)
 *   collide(sa, pa, qa, sb, pb, qb, manifold) -> boolean     (normal points A -> B)
 *   raycastShape(shape, pos, quat, o, d, maxDist, out) -> boolean
 *   gjkDistance(...) / epaPenetration(...)       convex distance + penetration
 *   Manifold                                     up to 4 points with warm-start ids
 *
 * Conventions
 *   - Shapes are authored in body-local space with the centre of mass at the origin.
 *     Factories that can produce an off-centre body (convex, compound) re-centre the
 *     geometry and record `shape.originOffset` so render meshes stay aligned.
 *   - Contact normals point from A towards B; to separate, move A by -n and B by +n.
 *   - Nothing here allocates during a step: every temporary comes from a module-level
 *     scratch pool, so the GC never runs mid-simulation (determinism + no hitches).
 *   - No Math.random() anywhere in this file.
 *
 * Narrowphase strategy
 *   Polyhedral pairs (box/convex/triangle) use SAT + reference-face clipping because it
 *   produces a proper multi-point manifold; single-point contacts are what make stacked
 *   boxes jitter. GJK is used for distance queries and sweeps, EPA as the penetration
 *   fallback when SAT cannot be applied (rounded/degenerate convexes).
 */
import * as THREE from 'three';

export const SHAPE = Object.freeze({
  SPHERE: 0,
  BOX: 1,
  CAPSULE: 2,
  CONVEX: 3,
  TRIMESH: 4,
  HEIGHTFIELD: 5,
  COMPOUND: 6,
});

export const MAX_MANIFOLD_POINTS = 4;
const EPS = 1e-9;

/**
 * V8's Math.hypot does careful overflow/underflow scaling and shows up as ~10% of the
 * whole physics frame in a profile. At metre scale we do not need it.
 */
function len3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}


/* ------------------------------------------------------------------ *
 * Scalar math helpers (no allocation)
 * ------------------------------------------------------------------ */

/** out = q * (x,y,z) */
export function qRotate(q, x, y, z, out) {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + qy * tz - qz * ty;
  out.y = y + qw * ty + qz * tx - qx * tz;
  out.z = z + qw * tz + qx * ty - qy * tx;
  return out;
}

/** out = conj(q) * (x,y,z) */
export function qRotateInv(q, x, y, z, out) {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + qy * tz - qz * ty;
  out.y = y + qw * ty + qz * tx - qx * tz;
  out.z = z + qw * tz + qx * ty - qy * tx;
  return out;
}

/** Shared scratch vectors. Nothing in the narrowphase allocates during a step. */
const _s = {
  a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
  d: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(),
};

/* ------------------------------------------------------------------ *
 * Manifold
 * ------------------------------------------------------------------ */

export class Manifold {
  constructor() {
    this.nx = 0; this.ny = 1; this.nz = 0;
    this.count = 0;
    this.px = new Float64Array(8);
    this.py = new Float64Array(8);
    this.pz = new Float64Array(8);
    this.depth = new Float64Array(8);
    this.id = new Int32Array(8);
  }

  reset() {
    this.count = 0;
  }

  setNormal(x, y, z) {
    this.nx = x; this.ny = y; this.nz = z;
  }

  add(x, y, z, depth, id) {
    let n = this.count;
    if (n >= 8) {
      // Replace the shallowest point rather than dropping the new one.
      let worst = 0;
      for (let i = 1; i < 8; i++) if (this.depth[i] < this.depth[worst]) worst = i;
      if (this.depth[worst] >= depth) return;
      n = worst;
    } else {
      this.count = n + 1;
    }
    this.px[n] = x; this.py[n] = y; this.pz[n] = z;
    this.depth[n] = depth; this.id[n] = id | 0;
  }

  /**
   * Reduce to MAX_MANIFOLD_POINTS keeping the deepest point plus the three that
   * maximise the contact patch area. A wide patch is what stops boxes from rocking.
   */
  reduce() {
    const n = this.count;
    if (n <= MAX_MANIFOLD_POINTS) return;
    const keep = _reduceKeep;
    // 1. deepest
    let best = 0;
    for (let i = 1; i < n; i++) if (this.depth[i] > this.depth[best]) best = i;
    keep[0] = best;
    // 2. farthest from #1
    let far = -1, fd = -1;
    for (let i = 0; i < n; i++) {
      if (i === keep[0]) continue;
      const dx = this.px[i] - this.px[keep[0]];
      const dy = this.py[i] - this.py[keep[0]];
      const dz = this.pz[i] - this.pz[keep[0]];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > fd) { fd = d2; far = i; }
    }
    keep[1] = far < 0 ? keep[0] : far;
    // 3. maximum triangle area with 1-2
    let t = -1, ta = -1;
    for (let i = 0; i < n; i++) {
      if (i === keep[0] || i === keep[1]) continue;
      const a = _triArea2(this, keep[0], keep[1], i);
      if (a > ta) { ta = a; t = i; }
    }
    keep[2] = t < 0 ? keep[1] : t;
    // 4. maximises quad area (max distance to the triangle's edges)
    let q = -1, qa = -1;
    for (let i = 0; i < n; i++) {
      if (i === keep[0] || i === keep[1] || i === keep[2]) continue;
      const a =
        _triArea2(this, keep[0], keep[1], i) +
        _triArea2(this, keep[1], keep[2], i) +
        _triArea2(this, keep[2], keep[0], i);
      if (a > qa) { qa = a; q = i; }
    }
    keep[3] = q < 0 ? keep[2] : q;

    for (let s = 0; s < MAX_MANIFOLD_POINTS; s++) {
      const src = keep[s];
      _tmpP[s * 5 + 0] = this.px[src];
      _tmpP[s * 5 + 1] = this.py[src];
      _tmpP[s * 5 + 2] = this.pz[src];
      _tmpP[s * 5 + 3] = this.depth[src];
      _tmpI[s] = this.id[src];
    }
    for (let s = 0; s < MAX_MANIFOLD_POINTS; s++) {
      this.px[s] = _tmpP[s * 5 + 0];
      this.py[s] = _tmpP[s * 5 + 1];
      this.pz[s] = _tmpP[s * 5 + 2];
      this.depth[s] = _tmpP[s * 5 + 3];
      this.id[s] = _tmpI[s];
    }
    this.count = MAX_MANIFOLD_POINTS;
  }
}
const _reduceKeep = new Int32Array(4);
const _tmpP = new Float64Array(20);
const _tmpI = new Int32Array(4);

function _triArea2(m, a, b, c) {
  const ax = m.px[b] - m.px[a], ay = m.py[b] - m.py[a], az = m.pz[b] - m.pz[a];
  const bx = m.px[c] - m.px[a], by = m.py[c] - m.py[a], bz = m.pz[c] - m.pz[a];
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return cx * cx + cy * cy + cz * cz;
}

/* ------------------------------------------------------------------ *
 * Shape factories
 * ------------------------------------------------------------------ */

function baseShape(type) {
  return {
    type,
    localMin: new THREE.Vector3(),
    localMax: new THREE.Vector3(),
    boundingRadius: 0,
    volume: 0,
    /** unit-mass inertia tensor, row-major 9 floats */
    unitInertia: new Float64Array(9),
    originOffset: new THREE.Vector3(), // geometry origin relative to the centre of mass
  };
}

export function sphere(radius) {
  const s = baseShape(SHAPE.SPHERE);
  s.radius = Math.max(1e-4, radius);
  s.localMin.set(-s.radius, -s.radius, -s.radius);
  s.localMax.set(s.radius, s.radius, s.radius);
  s.boundingRadius = s.radius;
  s.volume = (4 / 3) * Math.PI * s.radius ** 3;
  const i = 0.4 * s.radius * s.radius;
  s.unitInertia.set([i, 0, 0, 0, i, 0, 0, 0, i]);
  return s;
}

/** Axis-aligned in local space; half extents. */
export function box(hx, hy, hz) {
  const s = baseShape(SHAPE.BOX);
  hx = Math.max(1e-4, hx); hy = Math.max(1e-4, hy); hz = Math.max(1e-4, hz);
  s.halfExtents = new THREE.Vector3(hx, hy, hz);
  s.localMin.set(-hx, -hy, -hz);
  s.localMax.set(hx, hy, hz);
  s.boundingRadius = Math.sqrt(hx * hx + hy * hy + hz * hz);
  s.volume = 8 * hx * hy * hz;
  const ix = (hy * hy + hz * hz) / 3;
  const iy = (hx * hx + hz * hz) / 3;
  const iz = (hx * hx + hy * hy) / 3;
  s.unitInertia.set([ix, 0, 0, 0, iy, 0, 0, 0, iz]);
  attachBoxPoly(s, hx, hy, hz);
  return s;
}

/** Capsule along the local Y axis: segment [-halfHeight, +halfHeight], radius r. */
export function capsule(radius, halfHeight) {
  const s = baseShape(SHAPE.CAPSULE);
  s.radius = Math.max(1e-4, radius);
  s.halfHeight = Math.max(0, halfHeight);
  const r = s.radius, h = s.halfHeight;
  s.localMin.set(-r, -h - r, -r);
  s.localMax.set(r, h + r, r);
  s.boundingRadius = h + r;
  const cylV = Math.PI * r * r * 2 * h;
  const sphV = (4 / 3) * Math.PI * r * r * r;
  s.volume = cylV + sphV;
  const total = s.volume || 1;
  const mc = cylV / total, ms = sphV / total;
  const ix = mc * (h * h / 3 + r * r / 4) + ms * (0.4 * r * r) + ms * h * h;
  const iy = mc * (r * r / 2) + ms * (0.4 * r * r);
  s.unitInertia.set([ix, 0, 0, 0, iy, 0, 0, 0, ix]);
  return s;
}

/**
 * Convex hull from a point cloud (or explicit vertices+faces).
 * Recentres on the centre of mass and records `originOffset`.
 */
export function convex(points, opts = {}) {
  const s = baseShape(SHAPE.CONVEX);
  let pts = normalisePoints(points);
  let hull = null;
  try {
    hull = buildHull(pts);
  } catch {
    hull = null;
  }
  if (!hull || hull.faces.length < 4 || hull.nv < 4) {
    // Degenerate (coplanar / too few points): fall back to the tight AABB box.
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      if (pts[i] < mnx) mnx = pts[i];
      if (pts[i + 1] < mny) mny = pts[i + 1];
      if (pts[i + 2] < mnz) mnz = pts[i + 2];
      if (pts[i] > mxx) mxx = pts[i];
      if (pts[i + 1] > mxy) mxy = pts[i + 1];
      if (pts[i + 2] > mxz) mxz = pts[i + 2];
    }
    if (!isFinite(mnx)) { mnx = mny = mnz = -0.1; mxx = mxy = mxz = 0.1; }
    const hx = Math.max(0.005, (mxx - mnx) / 2);
    const hy = Math.max(0.005, (mxy - mny) / 2);
    const hz = Math.max(0.005, (mxz - mnz) / 2);
    const b = box(hx, hy, hz);
    b.originOffset.set(-(mnx + mxx) / 2, -(mny + mxy) / 2, -(mnz + mxz) / 2);
    return b;
  }

  s.verts = hull.verts;
  s.nv = hull.nv;
  s.faces = hull.faces;
  finalisePolyhedron(s, opts.recentre !== false);
  return s;
}

/** Static triangle soup with a BVH. Always infinite-mass. */
export function trimesh(vertices, indices) {
  const s = baseShape(SHAPE.TRIMESH);
  s.verts = vertices instanceof Float64Array ? vertices : Float64Array.from(vertices);
  s.indices = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  s.triCount = (s.indices.length / 3) | 0;
  s.bvh = new TriBVH(s.verts, s.indices);
  s.localMin.copy(s.bvh.rootMin);
  s.localMax.copy(s.bvh.rootMax);
  s.boundingRadius = Math.max(
    s.localMin.length(),
    s.localMax.length()
  );
  s.volume = 0;
  s.unitInertia.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  s.static = true;
  return s;
}

/**
 * Heightfield on the XZ plane. `heights[iz * nx + ix]`.
 * Local origin sits at the centre of the field.
 */
export function heightfield(heights, nx, nz, scaleX = 1, scaleZ = 1) {
  const s = baseShape(SHAPE.HEIGHTFIELD);
  s.heights = heights instanceof Float32Array ? heights : Float32Array.from(heights);
  s.nx = nx | 0;
  s.nz = nz | 0;
  s.scaleX = scaleX;
  s.scaleZ = scaleZ;
  s.originX = -((s.nx - 1) * scaleX) / 2;
  s.originZ = -((s.nz - 1) * scaleZ) / 2;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < s.heights.length; i++) {
    const v = s.heights[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!isFinite(mn)) { mn = 0; mx = 0; }
  s.minY = mn; s.maxY = mx;
  s.localMin.set(s.originX, mn, s.originZ);
  s.localMax.set(-s.originX, mx, -s.originZ);
  s.boundingRadius = Math.max(s.localMax.length(), s.localMin.length());
  s.volume = 0;
  s.unitInertia.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  s.static = true;
  return s;
}

/**
 * Compound of child shapes with local transforms.
 * children: [{ shape, position?, quaternion? }]
 */
export function compound(children) {
  const s = baseShape(SHAPE.COMPOUND);
  // Nested compounds are flattened so narrowphase recursion is exactly one level deep.
  const flat = [];
  const push = (c, pos, quat) => {
    const p = new THREE.Vector3().copy(c.position || ZERO_V);
    const q = new THREE.Quaternion().copy(c.quaternion || IDENT_Q);
    if (pos) { p.applyQuaternion(quat).add(pos); q.premultiply(quat); }
    if (c.shape && c.shape.type === SHAPE.COMPOUND) {
      for (const sub of c.shape.children) push(sub, p, q);
    } else if (c.shape) {
      flat.push({ shape: c.shape, position: p, quaternion: q });
    }
  };
  for (const c of children) push(c, null, null);
  s.children = flat;
  recomputeCompoundBounds(s);
  return s;
}

function recomputeCompoundBounds(s) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  let vol = 0;
  for (const c of s.children) {
    computeAABB(c.shape, c.position, c.quaternion, _s.a, _s.b);
    if (_s.a.x < mnx) mnx = _s.a.x;
    if (_s.a.y < mny) mny = _s.a.y;
    if (_s.a.z < mnz) mnz = _s.a.z;
    if (_s.b.x > mxx) mxx = _s.b.x;
    if (_s.b.y > mxy) mxy = _s.b.y;
    if (_s.b.z > mxz) mxz = _s.b.z;
    vol += c.shape.volume || 0;
  }
  if (!isFinite(mnx)) { mnx = mny = mnz = -0.1; mxx = mxy = mxz = 0.1; }
  s.localMin.set(mnx, mny, mnz);
  s.localMax.set(mxx, mxy, mxz);
  s.boundingRadius = Math.max(s.localMin.length(), s.localMax.length());
  s.volume = vol;

  // Unit inertia via mass-weighted parallel axis theorem about the compound origin.
  const I = s.unitInertia;
  I.fill(0);
  const totV = vol || 1;
  for (const c of s.children) {
    const w = (c.shape.volume || 0) / totV;
    if (w <= 0) continue;
    rotateInertia(c.shape.unitInertia, c.quaternion, _rotI);
    const p = c.position;
    const d2 = p.x * p.x + p.y * p.y + p.z * p.z;
    I[0] += w * (_rotI[0] + d2 - p.x * p.x);
    I[1] += w * (_rotI[1] - p.x * p.y);
    I[2] += w * (_rotI[2] - p.x * p.z);
    I[3] += w * (_rotI[3] - p.y * p.x);
    I[4] += w * (_rotI[4] + d2 - p.y * p.y);
    I[5] += w * (_rotI[5] - p.y * p.z);
    I[6] += w * (_rotI[6] - p.z * p.x);
    I[7] += w * (_rotI[7] - p.z * p.y);
    I[8] += w * (_rotI[8] + d2 - p.z * p.z);
  }
}
const _rotI = new Float64Array(9);
const _rotM = new Float64Array(9);

/** out = R * I * R^T  (row-major 3x3) */
function rotateInertia(I, q, out) {
  quatToMat3(q, _rotM);
  const R = _rotM;
  // t = R * I
  const t = _rotT;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      t[r * 3 + c] = R[r * 3] * I[c] + R[r * 3 + 1] * I[3 + c] + R[r * 3 + 2] * I[6 + c];
    }
  }
  // out = t * R^T
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        t[r * 3] * R[c * 3] + t[r * 3 + 1] * R[c * 3 + 1] + t[r * 3 + 2] * R[c * 3 + 2];
    }
  }
  return out;
}
const _rotT = new Float64Array(9);

export function quatToMat3(q, out) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy - wz;       out[2] = xz + wy;
  out[3] = xy + wz;       out[4] = 1 - (xx + zz); out[5] = yz - wx;
  out[6] = xz - wy;       out[7] = yz + wx;       out[8] = 1 - (xx + yy);
  return out;
}

/** Full inertia tensor for a shape at `mass`, row-major into `out` (Float64Array(9)). */
export function computeInertia(shape, mass, out) {
  const I = shape.unitInertia;
  for (let i = 0; i < 9; i++) out[i] = I[i] * mass;
  return out;
}

/* ------------------------------------------------------------------ *
 * Polyhedron helpers (box / convex / scratch triangle)
 * ------------------------------------------------------------------ */

function attachBoxPoly(s, hx, hy, hz) {
  const v = new Float64Array(24);
  const sx = [-1, 1, 1, -1, -1, 1, 1, -1];
  const sy = [-1, -1, -1, -1, 1, 1, 1, 1];
  const sz = [-1, -1, 1, 1, -1, -1, 1, 1];
  for (let i = 0; i < 8; i++) {
    v[i * 3] = sx[i] * hx;
    v[i * 3 + 1] = sy[i] * hy;
    v[i * 3 + 2] = sz[i] * hz;
  }
  s.verts = v;
  s.nv = 8;
  s.faces = [
    mkFace([4, 5, 6, 7], 0, 1, 0, hy),   // +Y
    mkFace([3, 2, 1, 0], 0, -1, 0, hy),  // -Y
    mkFace([1, 2, 6, 5], 1, 0, 0, hx),   // +X
    mkFace([3, 0, 4, 7], -1, 0, 0, hx),  // -X
    mkFace([2, 3, 7, 6], 0, 0, 1, hz),   // +Z
    mkFace([0, 1, 5, 4], 0, 0, -1, hz),  // -Z
  ];
  orientFaces(s);
  buildEdges(s);
}

/**
 * Force every face's vertex loop to wind counter-clockwise about its outward normal.
 * Clipping, `pointInFace` and the volume integral all depend on this.
 */
function orientFaces(s) {
  const V = s.verts;
  for (const f of s.faces) {
    const n = f.vi.length;
    if (n < 3) continue;
    let nx = 0, ny = 0, nz = 0; // Newell
    for (let i = 0; i < n; i++) {
      const a = f.vi[i] * 3, b = f.vi[(i + 1) % n] * 3;
      nx += (V[a + 1] - V[b + 1]) * (V[a + 2] + V[b + 2]);
      ny += (V[a + 2] - V[b + 2]) * (V[a] + V[b]);
      nz += (V[a] - V[b]) * (V[a + 1] + V[b + 1]);
    }
    if (nx * f.nx + ny * f.ny + nz * f.nz < 0) f.vi.reverse();
  }
}

function mkFace(vi, nx, ny, nz, d) {
  return { vi: Int32Array.from(vi), nx, ny, nz, d };
}

function buildEdges(s) {
  const seen = new Set();
  const list = [];
  for (const f of s.faces) {
    const n = f.vi.length;
    for (let i = 0; i < n; i++) {
      const a = f.vi[i], b = f.vi[(i + 1) % n];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo * 65536 + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(lo, hi);
    }
  }
  // Sorted for deterministic SAT axis iteration.
  const pairs = [];
  for (let i = 0; i < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
  pairs.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  s.edges = new Int32Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) {
    s.edges[i * 2] = pairs[i][0];
    s.edges[i * 2 + 1] = pairs[i][1];
  }
  s.edgeCount = pairs.length;

  /*
   * Record the two faces adjacent to each edge. The generic SAT uses them for Gauss-map
   * pruning: an edge pair can only produce a separating axis if their arcs on the Gauss
   * map cross, which a handful of dot products decides. Without it, a 60-edge hull pair
   * costs 3600 full projections a frame; with it, ~90% never get projected at all.
   */
  const adj = new Map();
  for (let f = 0; f < s.faces.length; f++) {
    const vi = s.faces[f].vi;
    for (let i = 0; i < vi.length; i++) {
      const a = vi[i], b = vi[(i + 1) % vi.length];
      const key = Math.min(a, b) * 65536 + Math.max(a, b);
      const rec = adj.get(key);
      if (rec === undefined) adj.set(key, [f, -1]);
      else if (rec[1] < 0) rec[1] = f;
    }
  }
  s.edgeFaces = new Int32Array(pairs.length * 2).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const rec = adj.get(pairs[i][0] * 65536 + pairs[i][1]);
    if (rec) { s.edgeFaces[i * 2] = rec[0]; s.edgeFaces[i * 2 + 1] = rec[1]; }
  }
}

function finalisePolyhedron(s, recentre) {
  orientFaces(s);
  // Mass properties via tetrahedron decomposition about the origin.
  const V = s.verts;
  let vol = 0;
  let cx = 0, cy = 0, cz = 0;
  const C = _polyC; C.fill(0);
  for (const f of s.faces) {
    for (let t = 1; t + 1 < f.vi.length; t++) {
      const i0 = f.vi[0] * 3, i1 = f.vi[t] * 3, i2 = f.vi[t + 1] * 3;
      const ax = V[i0], ay = V[i0 + 1], az = V[i0 + 2];
      const bx = V[i1], by = V[i1 + 1], bz = V[i1 + 2];
      const dx = V[i2], dy = V[i2 + 1], dz = V[i2 + 2];
      const det =
        ax * (by * dz - bz * dy) - ay * (bx * dz - bz * dx) + az * (bx * dy - by * dx);
      const v = det / 6;
      vol += v;
      cx += v * (ax + bx + dx) / 4;
      cy += v * (ay + by + dy) / 4;
      cz += v * (az + bz + dz) / 4;
      accumTetCovariance(C, det, ax, ay, az, bx, by, bz, dx, dy, dz);
    }
  }
  if (Math.abs(vol) < 1e-12) vol = 1e-12;
  cx /= vol; cy /= vol; cz /= vol;

  if (recentre && (Math.abs(cx) > 1e-6 || Math.abs(cy) > 1e-6 || Math.abs(cz) > 1e-6)) {
    for (let i = 0; i < s.nv; i++) {
      V[i * 3] -= cx; V[i * 3 + 1] -= cy; V[i * 3 + 2] -= cz;
    }
    for (const f of s.faces) f.d -= f.nx * cx + f.ny * cy + f.nz * cz;
    s.originOffset.set(-cx, -cy, -cz);
    // Recompute covariance about the new origin (parallel-axis on the covariance).
    C.fill(0);
    for (const f of s.faces) {
      for (let t = 1; t + 1 < f.vi.length; t++) {
        const i0 = f.vi[0] * 3, i1 = f.vi[t] * 3, i2 = f.vi[t + 1] * 3;
        const ax = V[i0], ay = V[i0 + 1], az = V[i0 + 2];
        const bx = V[i1], by = V[i1 + 1], bz = V[i1 + 2];
        const dx = V[i2], dy = V[i2 + 1], dz = V[i2 + 2];
        const det =
          ax * (by * dz - bz * dy) - ay * (bx * dz - bz * dx) + az * (bx * dy - by * dx);
        accumTetCovariance(C, det, ax, ay, az, bx, by, bz, dx, dy, dz);
      }
    }
  }

  s.volume = Math.abs(vol);
  const inv = 1 / s.volume;
  const tr = (C[0] + C[4] + C[8]) * inv;
  const I = s.unitInertia;
  I[0] = tr - C[0] * inv; I[1] = -C[1] * inv;     I[2] = -C[2] * inv;
  I[3] = -C[3] * inv;     I[4] = tr - C[4] * inv; I[5] = -C[5] * inv;
  I[6] = -C[6] * inv;     I[7] = -C[7] * inv;     I[8] = tr - C[8] * inv;
  // Guard against a degenerate (flat) hull producing a zero principal axis.
  for (let k = 0; k < 3; k++) if (!(I[k * 4] > 1e-8)) I[k * 4] = 1e-8;

  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  let br = 0;
  for (let i = 0; i < s.nv; i++) {
    const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
    if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
    if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    const r = x * x + y * y + z * z;
    if (r > br) br = r;
  }
  s.localMin.set(mnx, mny, mnz);
  s.localMax.set(mxx, mxy, mxz);
  s.boundingRadius = Math.sqrt(br);
  buildEdges(s);
}
const _polyC = new Float64Array(9);

function accumTetCovariance(C, det, ax, ay, az, bx, by, bz, cx, cy, cz) {
  // C += det * A * Ccanonical * A^T with A = [a b c] as columns.
  const k1 = 1 / 60, k2 = 1 / 120;
  const ma = [ax, bx, cx, ay, by, cy, az, bz, cz]; // row-major A
  // M = Ccanonical
  const M = [k1, k2, k2, k2, k1, k2, k2, k2, k1];
  // T = A * M
  const T = _covT;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      T[r * 3 + c] = ma[r * 3] * M[c] + ma[r * 3 + 1] * M[3 + c] + ma[r * 3 + 2] * M[6 + c];
    }
  }
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] +=
        det * (T[r * 3] * ma[c * 3] + T[r * 3 + 1] * ma[c * 3 + 1] + T[r * 3 + 2] * ma[c * 3 + 2]);
    }
  }
}
const _covT = new Float64Array(9);

function normalisePoints(points) {
  if (points instanceof Float64Array) return Float64Array.from(points);
  if (ArrayBuffer.isView(points)) return Float64Array.from(points);
  if (Array.isArray(points) && points.length && typeof points[0] === 'object') {
    const out = new Float64Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      out[i * 3] = points[i].x; out[i * 3 + 1] = points[i].y; out[i * 3 + 2] = points[i].z;
    }
    return out;
  }
  return Float64Array.from(points || []);
}

/* ---- incremental 3D convex hull ---- */

function buildHull(pts) {
  // Dedupe on a 1e-5 grid so co-located verts never create degenerate faces.
  const uniq = [];
  const seen = new Set();
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(x, y, z);
  }
  const n = uniq.length / 3;
  if (n < 4) return null;
  const P = Float64Array.from(uniq);

  const px = (i) => P[i * 3], py = (i) => P[i * 3 + 1], pz = (i) => P[i * 3 + 2];

  // Seed tetrahedron: extremes along X, then farthest from that line, then plane.
  let i0 = 0, i1 = 0;
  for (let i = 1; i < n; i++) {
    if (px(i) < px(i0)) i0 = i;
    if (px(i) > px(i1)) i1 = i;
  }
  if (i0 === i1) return null;
  let i2 = -1, best = 1e-8;
  const ex = px(i1) - px(i0), ey = py(i1) - py(i0), ez = pz(i1) - pz(i0);
  for (let i = 0; i < n; i++) {
    const dx = px(i) - px(i0), dy = py(i) - py(i0), dz = pz(i) - pz(i0);
    const cx = ey * dz - ez * dy, cy = ez * dx - ex * dz, cz = ex * dy - ey * dx;
    const m = cx * cx + cy * cy + cz * cz;
    if (m > best) { best = m; i2 = i; }
  }
  if (i2 < 0) return null;
  const ax = px(i2) - px(i0), ay = py(i2) - py(i0), az = pz(i2) - pz(i0);
  let nx = ey * az - ez * ay, ny = ez * ax - ex * az, nz = ex * ay - ey * ax;
  const nl = len3(nx, ny, nz);
  if (nl < 1e-12) return null;
  nx /= nl; ny /= nl; nz /= nl;
  let i3 = -1, bd = 1e-7;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(nx * (px(i) - px(i0)) + ny * (py(i) - py(i0)) + nz * (pz(i) - pz(i0)));
    if (d > bd) { bd = d; i3 = i; }
  }
  if (i3 < 0) return null;

  const tris = [];
  const addTri = (a, b, c) => {
    const abx = px(b) - px(a), aby = py(b) - py(a), abz = pz(b) - pz(a);
    const acx = px(c) - px(a), acy = py(c) - py(a), acz = pz(c) - pz(a);
    let fx = aby * acz - abz * acy, fy = abz * acx - abx * acz, fz = abx * acy - aby * acx;
    const l = len3(fx, fy, fz);
    if (l < 1e-14) return;
    fx /= l; fy /= l; fz /= l;
    tris.push({ a, b, c, nx: fx, ny: fy, nz: fz, d: fx * px(a) + fy * py(a) + fz * pz(a), dead: false });
  };
  const side = nx * (px(i3) - px(i0)) + ny * (py(i3) - py(i0)) + nz * (pz(i3) - pz(i0));
  if (side < 0) {
    addTri(i0, i1, i2); addTri(i0, i2, i3); addTri(i0, i3, i1); addTri(i1, i3, i2);
  } else {
    addTri(i0, i2, i1); addTri(i0, i1, i3); addTri(i0, i3, i2); addTri(i1, i2, i3);
  }

  const used = new Set([i0, i1, i2, i3]);
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    const x = px(i), y = py(i), z = pz(i);
    const visible = [];
    for (let t = 0; t < tris.length; t++) {
      const f = tris[t];
      if (f.dead) continue;
      if (f.nx * x + f.ny * y + f.nz * z - f.d > 1e-8) visible.push(t);
    }
    if (!visible.length) continue;
    const edgeCount = new Map();
    for (const t of visible) {
      const f = tris[t];
      f.dead = true;
      const e = [[f.a, f.b], [f.b, f.c], [f.c, f.a]];
      for (const [a, b] of e) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const key = lo * 1048576 + hi;
        const prev = edgeCount.get(key);
        if (prev) prev.n++;
        else edgeCount.set(key, { a, b, n: 1 });
      }
    }
    for (const rec of edgeCount.values()) {
      if (rec.n === 1) addTri(rec.a, rec.b, i);
    }
    used.add(i);
    if (tris.length > 4096) break; // safety valve on pathological clouds
  }

  const live = tris.filter((t) => !t.dead);
  if (live.length < 4) return null;

  // Compact the vertex set to those actually referenced.
  const remap = new Map();
  const verts = [];
  const vi = (old) => {
    let r = remap.get(old);
    if (r === undefined) {
      r = verts.length / 3;
      remap.set(old, r);
      verts.push(px(old), py(old), pz(old));
    }
    return r;
  };
  for (const t of live) { t.A = vi(t.a); t.B = vi(t.b); t.C = vi(t.c); }

  const faces = mergeCoplanar(live, verts);
  return { verts: Float64Array.from(verts), nv: verts.length / 3, faces };
}

/** Merge coplanar triangles into polygonal faces — essential for stable clipping. */
function mergeCoplanar(tris, verts) {
  const groups = [];
  for (const t of tris) {
    let g = null;
    for (const cand of groups) {
      if (
        cand.nx * t.nx + cand.ny * t.ny + cand.nz * t.nz > 0.99985 &&
        Math.abs(cand.d - t.d) < 1e-4
      ) { g = cand; break; }
    }
    if (!g) {
      g = { nx: t.nx, ny: t.ny, nz: t.nz, d: t.d, tris: [] };
      groups.push(g);
    }
    g.tris.push(t);
  }
  const faces = [];
  for (const g of groups) {
    if (g.tris.length === 1) {
      const t = g.tris[0];
      faces.push({ vi: Int32Array.from([t.A, t.B, t.C]), nx: g.nx, ny: g.ny, nz: g.nz, d: g.d });
      continue;
    }
    const edges = new Map();
    for (const t of g.tris) {
      const e = [[t.A, t.B], [t.B, t.C], [t.C, t.A]];
      for (const [a, b] of e) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const key = lo * 1048576 + hi;
        const prev = edges.get(key);
        if (prev) prev.n++;
        else edges.set(key, { a, b, n: 1 });
      }
    }
    const boundary = [];
    for (const rec of edges.values()) if (rec.n === 1) boundary.push(rec);
    const loop = chainLoop(boundary);
    if (loop && loop.length >= 3) {
      faces.push({ vi: Int32Array.from(loop), nx: g.nx, ny: g.ny, nz: g.nz, d: g.d });
    } else {
      for (const t of g.tris) {
        faces.push({ vi: Int32Array.from([t.A, t.B, t.C]), nx: g.nx, ny: g.ny, nz: g.nz, d: g.d });
      }
    }
  }
  void verts;
  return faces;
}

function chainLoop(edges) {
  if (!edges.length) return null;
  const next = new Map();
  for (const e of edges) {
    if (next.has(e.a)) return null; // non-manifold boundary — bail out
    next.set(e.a, e.b);
  }
  const start = edges[0].a;
  const loop = [start];
  let cur = next.get(start);
  let guard = 0;
  while (cur !== undefined && cur !== start && guard++ < 4096) {
    loop.push(cur);
    cur = next.get(cur);
  }
  if (cur !== start) return null;
  return loop.length === edges.length ? loop : null;
}

/* ------------------------------------------------------------------ *
 * AABB
 * ------------------------------------------------------------------ */

export function computeAABB(shape, pos, quat, outMin, outMax) {
  switch (shape.type) {
    case SHAPE.SPHERE: {
      const r = shape.radius;
      outMin.set(pos.x - r, pos.y - r, pos.z - r);
      outMax.set(pos.x + r, pos.y + r, pos.z + r);
      return;
    }
    case SHAPE.CAPSULE: {
      const r = shape.radius, h = shape.halfHeight;
      qRotate(quat, 0, h, 0, _s.a);
      const ax = Math.abs(_s.a.x), ay = Math.abs(_s.a.y), az = Math.abs(_s.a.z);
      outMin.set(pos.x - ax - r, pos.y - ay - r, pos.z - az - r);
      outMax.set(pos.x + ax + r, pos.y + ay + r, pos.z + az + r);
      return;
    }
    default: {
      // Rotate the local AABB: centre + |R| * halfExtents.
      const mn = shape.localMin, mx = shape.localMax;
      const ccx = (mn.x + mx.x) * 0.5, ccy = (mn.y + mx.y) * 0.5, ccz = (mn.z + mx.z) * 0.5;
      const hx = (mx.x - mn.x) * 0.5, hy = (mx.y - mn.y) * 0.5, hz = (mx.z - mn.z) * 0.5;
      quatToMat3(quat, _rotM);
      const m = _rotM;
      const ex = Math.abs(m[0]) * hx + Math.abs(m[1]) * hy + Math.abs(m[2]) * hz;
      const ey = Math.abs(m[3]) * hx + Math.abs(m[4]) * hy + Math.abs(m[5]) * hz;
      const ez = Math.abs(m[6]) * hx + Math.abs(m[7]) * hy + Math.abs(m[8]) * hz;
      qRotate(quat, ccx, ccy, ccz, _s.a);
      outMin.set(pos.x + _s.a.x - ex, pos.y + _s.a.y - ey, pos.z + _s.a.z - ez);
      outMax.set(pos.x + _s.a.x + ex, pos.y + _s.a.y + ey, pos.z + _s.a.z + ez);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Support functions (GJK / EPA)
 * ------------------------------------------------------------------ */

/** Local-space support point of a convex shape along (dx,dy,dz). */
export function supportLocal(shape, dx, dy, dz, out) {
  switch (shape.type) {
    case SHAPE.SPHERE: {
      const l = len3(dx, dy, dz) || 1;
      out.set((dx / l) * shape.radius, (dy / l) * shape.radius, (dz / l) * shape.radius);
      return out;
    }
    case SHAPE.BOX: {
      const h = shape.halfExtents;
      out.set(dx >= 0 ? h.x : -h.x, dy >= 0 ? h.y : -h.y, dz >= 0 ? h.z : -h.z);
      return out;
    }
    case SHAPE.CAPSULE: {
      const l = len3(dx, dy, dz) || 1;
      const sy = dy >= 0 ? shape.halfHeight : -shape.halfHeight;
      out.set((dx / l) * shape.radius, sy + (dy / l) * shape.radius, (dz / l) * shape.radius);
      return out;
    }
    case SHAPE.CONVEX: {
      const V = shape.verts;
      let bi = 0, bd = -Infinity;
      for (let i = 0; i < shape.nv; i++) {
        const d = V[i * 3] * dx + V[i * 3 + 1] * dy + V[i * 3 + 2] * dz;
        if (d > bd) { bd = d; bi = i; }
      }
      out.set(V[bi * 3], V[bi * 3 + 1], V[bi * 3 + 2]);
      return out;
    }
    default:
      out.set(0, 0, 0);
      return out;
  }
}

export function supportWorld(shape, pos, quat, dx, dy, dz, out) {
  qRotateInv(quat, dx, dy, dz, _sup);
  supportLocal(shape, _sup.x, _sup.y, _sup.z, out);
  qRotate(quat, out.x, out.y, out.z, out);
  out.x += pos.x; out.y += pos.y; out.z += pos.z;
  return out;
}
const _sup = new THREE.Vector3();

/* ---- GJK closest distance between two convex shapes ---- */

const _gw = new Float64Array(4 * 3);
const _ga = new Float64Array(4 * 3);
const _gb = new Float64Array(4 * 3);
const _gbary = new Float64Array(4);
const _gsupA = new THREE.Vector3();
const _gsupB = new THREE.Vector3();

/**
 * @returns {number} separation distance (0 when intersecting).
 * On return `out.ax..az` / `out.bx..bz` hold the witness points and
 * `out.nx..nz` the unit direction from A to B.
 */
export function gjkDistance(sa, pa, qa, sb, pb, qb, out, maxIter = 32) {
  let nsimp = 0;
  _gbary.fill(0);
  out.hit = false;
  let dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
  if (dx * dx + dy * dy + dz * dz < 1e-12) { dx = 1; dy = 0; dz = 0; }

  for (let iter = 0; iter < maxIter; iter++) {
    const l = len3(dx, dy, dz);
    if (l < 1e-12) break;
    const ux = -dx / l, uy = -dy / l, uz = -dz / l;
    supportWorld(sa, pa, qa, ux, uy, uz, _gsupA);
    supportWorld(sb, pb, qb, -ux, -uy, -uz, _gsupB);
    const wx = _gsupA.x - _gsupB.x, wy = _gsupA.y - _gsupB.y, wz = _gsupA.z - _gsupB.z;

    // Convergence: the new support point cannot bring us closer to the origin.
    if (nsimp > 0) {
      const vdotw = dx * wx + dy * wy + dz * wz;
      const vv = dx * dx + dy * dy + dz * dz;
      if (vv - vdotw <= 1e-10 * vv) break;
    }

    let dup = false;
    for (let i = 0; i < nsimp; i++) {
      if (
        Math.abs(_gw[i * 3] - wx) < 1e-10 &&
        Math.abs(_gw[i * 3 + 1] - wy) < 1e-10 &&
        Math.abs(_gw[i * 3 + 2] - wz) < 1e-10
      ) { dup = true; break; }
    }
    if (dup) break;

    _gw[nsimp * 3] = wx; _gw[nsimp * 3 + 1] = wy; _gw[nsimp * 3 + 2] = wz;
    _ga[nsimp * 3] = _gsupA.x; _ga[nsimp * 3 + 1] = _gsupA.y; _ga[nsimp * 3 + 2] = _gsupA.z;
    _gb[nsimp * 3] = _gsupB.x; _gb[nsimp * 3 + 1] = _gsupB.y; _gb[nsimp * 3 + 2] = _gsupB.z;
    nsimp++;

    const r = closestSimplex(nsimp);
    nsimp = r.n;
    // `r` is the simplex point closest to the origin (v); the next search
    // direction is -v, which the loop head derives from (dx,dy,dz).
    dx = r.x; dy = r.y; dz = r.z;
    if (nsimp === 4 || (dx * dx + dy * dy + dz * dz) < 1e-14) {
      // Origin contained: shapes intersect.
      out.hit = true;
      out.simplexCount = nsimp;
      out.nx = 0; out.ny = 1; out.nz = 0;
      return 0;
    }
  }

  // Witness points from the barycentric weights of the final simplex.
  let axs = 0, ays = 0, azs = 0, bxs = 0, bys = 0, bzs = 0;
  for (let i = 0; i < 4; i++) {
    const w = _gbary[i];
    if (!w) continue;
    axs += w * _ga[i * 3]; ays += w * _ga[i * 3 + 1]; azs += w * _ga[i * 3 + 2];
    bxs += w * _gb[i * 3]; bys += w * _gb[i * 3 + 1]; bzs += w * _gb[i * 3 + 2];
  }
  out.hit = false;
  out.ax = axs; out.ay = ays; out.az = azs;
  out.bx = bxs; out.by = bys; out.bz = bzs;
  const sx = bxs - axs, sy = bys - ays, sz = bzs - azs;
  const dist = len3(sx, sy, sz);
  if (dist > 1e-12) { out.nx = sx / dist; out.ny = sy / dist; out.nz = sz / dist; }
  else { out.nx = 0; out.ny = 1; out.nz = 0; }
  return dist;
}

const _csRes = { x: 0, y: 0, z: 0, n: 0 };

/** Closest point of the current simplex to the origin; compacts the simplex in place. */
function closestSimplex(n) {
  _gbary.fill(0);
  if (n === 1) {
    _gbary[0] = 1;
    _csRes.x = _gw[0]; _csRes.y = _gw[1]; _csRes.z = _gw[2]; _csRes.n = 1;
    return _csRes;
  }
  if (n === 2) return closestSegment();
  if (n === 3) return closestTriangle();
  return closestTetra();
}

function keepSimplex(order, n) {
  for (let i = 0; i < n; i++) {
    const src = order[i];
    for (let k = 0; k < 3; k++) {
      _kw[i * 3 + k] = _gw[src * 3 + k];
      _ka[i * 3 + k] = _ga[src * 3 + k];
      _kb[i * 3 + k] = _gb[src * 3 + k];
    }
    _kbary[i] = _gbary[src];
  }
  for (let i = 0; i < n * 3; i++) { _gw[i] = _kw[i]; _ga[i] = _ka[i]; _gb[i] = _kb[i]; }
  for (let i = 0; i < 4; i++) _gbary[i] = i < n ? _kbary[i] : 0;
}
const _kw = new Float64Array(12);
const _ka = new Float64Array(12);
const _kb = new Float64Array(12);
const _kbary = new Float64Array(4);
const _ord = new Int32Array(4);

function closestSegment() {
  const ax = _gw[0], ay = _gw[1], az = _gw[2];
  const bx = _gw[3], by = _gw[4], bz = _gw[5];
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const ll = ex * ex + ey * ey + ez * ez;
  let t = ll > 1e-16 ? -(ax * ex + ay * ey + az * ez) / ll : 0;
  if (t <= 0) return pickVertex(0);
  if (t >= 1) return pickVertex(1);
  _gbary[0] = 1 - t; _gbary[1] = t;
  _csRes.x = ax + ex * t; _csRes.y = ay + ey * t; _csRes.z = az + ez * t; _csRes.n = 2;
  return _csRes;
}

function closestTriangle() {
  const ax = _gw[0], ay = _gw[1], az = _gw[2];
  const bx = _gw[3], by = _gw[4], bz = _gw[5];
  const cx = _gw[6], cy = _gw[7], cz = _gw[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = -ax, apy = -ay, apz = -az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return pickVertex(0);
  const bpx = -bx, bpy = -by, bpz = -bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return pickVertex(1);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return pickEdge(0, 1, d1 / (d1 - d3));
  const cpx = -cx, cpy = -cy, cpz = -cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return pickVertex(2);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return pickEdge(0, 2, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return pickEdge(1, 2, (d4 - d3) / ((d4 - d3) + (d5 - d6)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  _gbary[0] = 1 - v - w; _gbary[1] = v; _gbary[2] = w; _gbary[3] = 0;
  _csRes.x = ax + abx * v + acx * w;
  _csRes.y = ay + aby * v + acy * w;
  _csRes.z = az + abz * v + acz * w;
  _csRes.n = 3;
  return _csRes;
}

function pickVertex(i) {
  const x = _gw[i * 3], y = _gw[i * 3 + 1], z = _gw[i * 3 + 2];
  _ord[0] = i; keepSimplex(_ord, 1);
  _gbary[0] = 1; _gbary[1] = 0; _gbary[2] = 0; _gbary[3] = 0;
  _csRes.x = x; _csRes.y = y; _csRes.z = z; _csRes.n = 1;
  return _csRes;
}

function pickEdge(i, j, t) {
  const ax = _gw[i * 3], ay = _gw[i * 3 + 1], az = _gw[i * 3 + 2];
  const bx = _gw[j * 3], by = _gw[j * 3 + 1], bz = _gw[j * 3 + 2];
  _gbary.fill(0);
  _ord[0] = i; _ord[1] = j; keepSimplex(_ord, 2);
  _gbary[0] = 1 - t; _gbary[1] = t;
  _csRes.x = ax + (bx - ax) * t;
  _csRes.y = ay + (by - ay) * t;
  _csRes.z = az + (bz - az) * t;
  _csRes.n = 2;
  return _csRes;
}

function closestTetra() {
  // If the origin is inside all four faces we are done (intersecting).
  const idx = [[0, 1, 2, 3], [0, 2, 3, 1], [0, 3, 1, 2], [1, 3, 2, 0]];
  let bestD = Infinity;
  let bestFace = -1;
  for (let f = 0; f < 4; f++) {
    const [i, j, k, o] = idx[f];
    const ax = _gw[i * 3], ay = _gw[i * 3 + 1], az = _gw[i * 3 + 2];
    const bx = _gw[j * 3], by = _gw[j * 3 + 1], bz = _gw[j * 3 + 2];
    const cx = _gw[k * 3], cy = _gw[k * 3 + 1], cz = _gw[k * 3 + 2];
    const ox = _gw[o * 3], oy = _gw[o * 3 + 1], oz = _gw[o * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = len3(nx, ny, nz);
    if (l < 1e-14) continue;
    nx /= l; ny /= l; nz /= l;
    const dPlane = nx * ax + ny * ay + nz * az;
    const dOpp = nx * ox + ny * oy + nz * oz - dPlane;
    const sign = dOpp > 0 ? -1 : 1;
    const dOrigin = sign * (0 - dPlane);
    if (dOrigin > 0 && dOrigin < bestD) { bestD = dOrigin; bestFace = f; }
  }
  if (bestFace < 0) {
    _csRes.x = 0; _csRes.y = 0; _csRes.z = 0; _csRes.n = 4;
    return _csRes;
  }
  const [i, j, k] = idx[bestFace];
  _ord[0] = i; _ord[1] = j; _ord[2] = k;
  keepSimplex(_ord, 3);
  return closestTriangle();
}

/* ---- EPA penetration depth ---- */

const EPA_MAX_V = 96;
const EPA_MAX_F = 192;
const _eV = new Float64Array(EPA_MAX_V * 3);
const _eA = new Float64Array(EPA_MAX_V * 3);
const _eB = new Float64Array(EPA_MAX_V * 3);
const _eF = new Int32Array(EPA_MAX_F * 3);
const _eN = new Float64Array(EPA_MAX_F * 4);
const _eDead = new Uint8Array(EPA_MAX_F);

/**
 * Penetration normal + depth for two intersecting convex shapes.
 * `out` receives {nx,ny,nz,depth,ax,ay,az,bx,by,bz}. Returns false if it cannot converge.
 */
export function epaPenetration(sa, pa, qa, sb, pb, qb, out) {
  let nv = 0;
  const push = (dx, dy, dz) => {
    const l = len3(dx, dy, dz);
    if (!(l > 1e-12)) return false;
    supportWorld(sa, pa, qa, dx / l, dy / l, dz / l, _gsupA);
    supportWorld(sb, pb, qb, -dx / l, -dy / l, -dz / l, _gsupB);
    _eV[nv * 3] = _gsupA.x - _gsupB.x;
    _eV[nv * 3 + 1] = _gsupA.y - _gsupB.y;
    _eV[nv * 3 + 2] = _gsupA.z - _gsupB.z;
    _eA[nv * 3] = _gsupA.x; _eA[nv * 3 + 1] = _gsupA.y; _eA[nv * 3 + 2] = _gsupA.z;
    _eB[nv * 3] = _gsupB.x; _eB[nv * 3 + 1] = _gsupB.y; _eB[nv * 3 + 2] = _gsupB.z;
    nv++;
    return true;
  };

  /*
   * Build a tetrahedron that encloses the origin of the Minkowski difference.
   * Four fixed search directions do NOT work — for boxes several of them return the
   * same support vertex and the tetra collapses, which is exactly how a naive EPA
   * silently reports "no penetration" on a box stack.
   */
  if (!push(1, 0, 0)) return false;
  let d1x = -_eV[0], d1y = -_eV[1], d1z = -_eV[2];
  if (d1x * d1x + d1y * d1y + d1z * d1z < 1e-14) { d1x = 0; d1y = 1; d1z = 0; }
  if (!push(d1x, d1y, d1z)) return false;

  const ex = _eV[3] - _eV[0], ey = _eV[4] - _eV[1], ez = _eV[5] - _eV[2];
  // Component of -v0 perpendicular to the segment: ((e x v0) x e).
  let cx = ey * _eV[2] - ez * _eV[1];
  let cy = ez * _eV[0] - ex * _eV[2];
  let cz = ex * _eV[1] - ey * _eV[0];
  let px = cy * ez - cz * ey, py = cz * ex - cx * ez, pz = cx * ey - cy * ex;
  if (px * px + py * py + pz * pz < 1e-16) {
    // Origin lies on the segment: any perpendicular will do.
    if (Math.abs(ex) <= Math.abs(ey) && Math.abs(ex) <= Math.abs(ez)) { px = 0; py = -ez; pz = ey; }
    else if (Math.abs(ey) <= Math.abs(ez)) { px = -ez; py = 0; pz = ex; }
    else { px = -ey; py = ex; pz = 0; }
  } else { px = -px; py = -py; pz = -pz; }
  if (!push(px, py, pz)) return false;

  // Fourth point: off the triangle plane, on the side the origin sits on.
  const t1x = _eV[3] - _eV[0], t1y = _eV[4] - _eV[1], t1z = _eV[5] - _eV[2];
  const t2x = _eV[6] - _eV[0], t2y = _eV[7] - _eV[1], t2z = _eV[8] - _eV[2];
  let nx0 = t1y * t2z - t1z * t2y;
  let ny0 = t1z * t2x - t1x * t2z;
  let nz0 = t1x * t2y - t1y * t2x;
  if (nx0 * _eV[0] + ny0 * _eV[1] + nz0 * _eV[2] > 0) { nx0 = -nx0; ny0 = -ny0; nz0 = -nz0; }
  if (!push(nx0, ny0, nz0)) return false;
  if (!nonDegenerate()) {
    nv = 3;
    if (!push(-nx0, -ny0, -nz0)) return false;
    if (!nonDegenerate()) return false;
  }

  // Orient every face away from the tetra centroid (safer than using the origin,
  // which can sit exactly on a face for a shallow touch).
  const gx = (_eV[0] + _eV[3] + _eV[6] + _eV[9]) / 4;
  const gy = (_eV[1] + _eV[4] + _eV[7] + _eV[10]) / 4;
  const gz = (_eV[2] + _eV[5] + _eV[8] + _eV[11]) / 4;

  let nf = 0;
  const addFace = (a, b, c) => {
    if (nf >= EPA_MAX_F) return;
    const ax = _eV[a * 3], ay = _eV[a * 3 + 1], az = _eV[a * 3 + 2];
    const bx = _eV[b * 3], by = _eV[b * 3 + 1], bz = _eV[b * 3 + 2];
    const cx2 = _eV[c * 3], cy2 = _eV[c * 3 + 1], cz2 = _eV[c * 3 + 2];
    let nx = (by - ay) * (cz2 - az) - (bz - az) * (cy2 - ay);
    let ny = (bz - az) * (cx2 - ax) - (bx - ax) * (cz2 - az);
    let nz = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
    const l = len3(nx, ny, nz);
    if (l < 1e-14) return;
    nx /= l; ny /= l; nz /= l;
    if (nx * (ax - gx) + ny * (ay - gy) + nz * (az - gz) < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      const t = b; b = c; c = t;
    }
    const d = nx * ax + ny * ay + nz * az;
    _eF[nf * 3] = a; _eF[nf * 3 + 1] = b; _eF[nf * 3 + 2] = c;
    _eN[nf * 4] = nx; _eN[nf * 4 + 1] = ny; _eN[nf * 4 + 2] = nz; _eN[nf * 4 + 3] = d;
    _eDead[nf] = 0;
    nf++;
  };
  addFace(0, 1, 2); addFace(0, 2, 3); addFace(0, 3, 1); addFace(1, 3, 2);

  for (let iter = 0; iter < 48; iter++) {
    let best = -1, bd = Infinity;
    for (let f = 0; f < nf; f++) {
      if (_eDead[f]) continue;
      const d = Math.max(0, _eN[f * 4 + 3]);
      if (d < bd) { bd = d; best = f; }
    }
    if (best < 0) return false;
    const nx = _eN[best * 4], ny = _eN[best * 4 + 1], nz = _eN[best * 4 + 2];

    supportWorld(sa, pa, qa, nx, ny, nz, _gsupA);
    supportWorld(sb, pb, qb, -nx, -ny, -nz, _gsupB);
    const wx = _gsupA.x - _gsupB.x, wy = _gsupA.y - _gsupB.y, wz = _gsupA.z - _gsupB.z;
    const d = wx * nx + wy * ny + wz * nz;
    if (d - bd < 1e-5 || nv >= EPA_MAX_V || nf >= EPA_MAX_F - 8) {
      return finishEPA(best, bd, nx, ny, nz, out);
    }

    // Expand: remove all faces the new point can see, re-cone from the horizon.
    _horizon.length = 0;
    for (let f = 0; f < nf; f++) {
      if (_eDead[f]) continue;
      const fnx = _eN[f * 4], fny = _eN[f * 4 + 1], fnz = _eN[f * 4 + 2], fd = _eN[f * 4 + 3];
      if (fnx * wx + fny * wy + fnz * wz - fd > 1e-9) {
        _eDead[f] = 1;
        const a = _eF[f * 3], b = _eF[f * 3 + 1], c = _eF[f * 3 + 2];
        pushHorizon(a, b); pushHorizon(b, c); pushHorizon(c, a);
      }
    }
    _eV[nv * 3] = wx; _eV[nv * 3 + 1] = wy; _eV[nv * 3 + 2] = wz;
    _eA[nv * 3] = _gsupA.x; _eA[nv * 3 + 1] = _gsupA.y; _eA[nv * 3 + 2] = _gsupA.z;
    _eB[nv * 3] = _gsupB.x; _eB[nv * 3 + 1] = _gsupB.y; _eB[nv * 3 + 2] = _gsupB.z;
    const w = nv++;
    for (let i = 0; i < _horizon.length; i += 2) addFace(_horizon[i], _horizon[i + 1], w);
    if (!_horizon.length) return finishEPA(best, bd, nx, ny, nz, out);
  }
  return false;

  function finishEPA(face, depth, nx, ny, nz, o) {
    const a = _eF[face * 3], b = _eF[face * 3 + 1], c = _eF[face * 3 + 2];
    barycentricOnTriangle(
      _eV[a * 3], _eV[a * 3 + 1], _eV[a * 3 + 2],
      _eV[b * 3], _eV[b * 3 + 1], _eV[b * 3 + 2],
      _eV[c * 3], _eV[c * 3 + 1], _eV[c * 3 + 2],
      nx * depth, ny * depth, nz * depth, _bary
    );
    const u = _bary[0], v = _bary[1], w2 = _bary[2];
    o.nx = nx; o.ny = ny; o.nz = nz;
    o.depth = depth;
    o.ax = u * _eA[a * 3] + v * _eA[b * 3] + w2 * _eA[c * 3];
    o.ay = u * _eA[a * 3 + 1] + v * _eA[b * 3 + 1] + w2 * _eA[c * 3 + 1];
    o.az = u * _eA[a * 3 + 2] + v * _eA[b * 3 + 2] + w2 * _eA[c * 3 + 2];
    o.bx = u * _eB[a * 3] + v * _eB[b * 3] + w2 * _eB[c * 3];
    o.by = u * _eB[a * 3 + 1] + v * _eB[b * 3 + 1] + w2 * _eB[c * 3 + 1];
    o.bz = u * _eB[a * 3 + 2] + v * _eB[b * 3 + 2] + w2 * _eB[c * 3 + 2];
    return true;
  }

  function nonDegenerate() {
    if (nv < 4) return false;
    const ax = _eV[0], ay = _eV[1], az = _eV[2];
    const bx = _eV[3] - ax, by = _eV[4] - ay, bz = _eV[5] - az;
    const cx = _eV[6] - ax, cy = _eV[7] - ay, cz = _eV[8] - az;
    const dx = _eV[9] - ax, dy = _eV[10] - ay, dz = _eV[11] - az;
    const det =
      bx * (cy * dz - cz * dy) - by * (cx * dz - cz * dx) + bz * (cx * dy - cy * dx);
    return Math.abs(det) > 1e-12;
  }
}
const _horizon = [];
const _bary = new Float64Array(3);

function pushHorizon(a, b) {
  for (let i = 0; i < _horizon.length; i += 2) {
    if (_horizon[i] === b && _horizon[i + 1] === a) {
      _horizon.splice(i, 2);
      return;
    }
  }
  _horizon.push(a, b);
}

function barycentricOnTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, px, py, pz, out) {
  const v0x = bx - ax, v0y = by - ay, v0z = bz - az;
  const v1x = cx - ax, v1y = cy - ay, v1z = cz - az;
  const v2x = px - ax, v2y = py - ay, v2z = pz - az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-16) { out[0] = 1; out[1] = 0; out[2] = 0; return out; }
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  out[0] = 1 - v - w; out[1] = v; out[2] = w;
  return out;
}

export const gjkResult = {
  hit: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, nx: 0, ny: 1, nz: 0, simplexCount: 0,
};
export const epaResult = {
  nx: 0, ny: 1, nz: 0, depth: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0,
};

/* ------------------------------------------------------------------ *
 * Primitive narrowphase fast paths
 * ------------------------------------------------------------------ */

function collideSphereSphere(sa, pa, sb, pb, m) {
  const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
  const r = sa.radius + sb.radius;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return false;
  const d = Math.sqrt(d2);
  let nx = 0, ny = 1, nz = 0;
  if (d > 1e-9) { nx = dx / d; ny = dy / d; nz = dz / d; }
  m.setNormal(nx, ny, nz);
  const depth = r - d;
  // Contact at the midpoint of the two witness points.
  const px = pa.x + nx * (sa.radius - depth * 0.5);
  const py = pa.y + ny * (sa.radius - depth * 0.5);
  const pz = pa.z + nz * (sa.radius - depth * 0.5);
  m.add(px, py, pz, depth, 0);
  return true;
}

/** Closest point on a segment to a point. */
function closestOnSegment(ax, ay, az, bx, by, bz, px, py, pz, out) {
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const ll = ex * ex + ey * ey + ez * ez;
  let t = ll > 1e-16 ? ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / ll : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  out.x = ax + ex * t; out.y = ay + ey * t; out.z = az + ez * t;
  out.t = t;
  return out;
}
const _seg0 = { x: 0, y: 0, z: 0, t: 0 };
const _seg1 = { x: 0, y: 0, z: 0, t: 0 };

/** Closest points between two segments. */
function closestSegmentSegment(p1, q1, p2, q2, c1, c2) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= 1e-14 && e <= 1e-14) { s = 0; t = 0; }
  else if (a <= 1e-14) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-14) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den > 1e-14 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  c1.x = p1.x + d1x * s; c1.y = p1.y + d1y * s; c1.z = p1.z + d1z * s; c1.t = s;
  c2.x = p2.x + d2x * t; c2.y = p2.y + d2y * t; c2.z = p2.z + d2z * t; c2.t = t;
}

function capsuleSegment(shape, pos, quat, out0, out1) {
  qRotate(quat, 0, shape.halfHeight, 0, _s.a);
  out0.x = pos.x - _s.a.x; out0.y = pos.y - _s.a.y; out0.z = pos.z - _s.a.z;
  out1.x = pos.x + _s.a.x; out1.y = pos.y + _s.a.y; out1.z = pos.z + _s.a.z;
}
const _cs0 = { x: 0, y: 0, z: 0 };
const _cs1 = { x: 0, y: 0, z: 0 };
const _cs2 = { x: 0, y: 0, z: 0 };
const _cs3 = { x: 0, y: 0, z: 0 };

function collideSphereCapsule(sa, pa, sb, pb, qb, m, flip) {
  capsuleSegment(sb, pb, qb, _cs0, _cs1);
  closestOnSegment(_cs0.x, _cs0.y, _cs0.z, _cs1.x, _cs1.y, _cs1.z, pa.x, pa.y, pa.z, _seg0);
  const dx = _seg0.x - pa.x, dy = _seg0.y - pa.y, dz = _seg0.z - pa.z;
  const r = sa.radius + sb.radius;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return false;
  const d = Math.sqrt(d2);
  let nx = 0, ny = 1, nz = 0;
  if (d > 1e-9) { nx = dx / d; ny = dy / d; nz = dz / d; }
  const depth = r - d;
  const px = pa.x + nx * (sa.radius - depth * 0.5);
  const py = pa.y + ny * (sa.radius - depth * 0.5);
  const pz = pa.z + nz * (sa.radius - depth * 0.5);
  m.setNormal(flip ? -nx : nx, flip ? -ny : ny, flip ? -nz : nz);
  m.add(px, py, pz, depth, 0);
  return true;
}

function collideCapsuleCapsule(sa, pa, qa, sb, pb, qb, m) {
  capsuleSegment(sa, pa, qa, _cs0, _cs1);
  capsuleSegment(sb, pb, qb, _cs2, _cs3);
  closestSegmentSegment(_cs0, _cs1, _cs2, _cs3, _seg0, _seg1);
  const dx = _seg1.x - _seg0.x, dy = _seg1.y - _seg0.y, dz = _seg1.z - _seg0.z;
  const r = sa.radius + sb.radius;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= r * r) return false;
  const d = Math.sqrt(d2);
  let nx = 0, ny = 1, nz = 0;
  if (d > 1e-9) { nx = dx / d; ny = dy / d; nz = dz / d; }
  m.setNormal(nx, ny, nz);
  const depth = r - d;
  m.add(
    _seg0.x + nx * (sa.radius - depth * 0.5),
    _seg0.y + ny * (sa.radius - depth * 0.5),
    _seg0.z + nz * (sa.radius - depth * 0.5),
    depth, 0
  );

  // Parallel capsules get a second contact so they cannot pivot about one point.
  const a0x = _cs1.x - _cs0.x, a0y = _cs1.y - _cs0.y, a0z = _cs1.z - _cs0.z;
  const b0x = _cs3.x - _cs2.x, b0y = _cs3.y - _cs2.y, b0z = _cs3.z - _cs2.z;
  const la = len3(a0x, a0y, a0z), lb = len3(b0x, b0y, b0z);
  if (la > 1e-6 && lb > 1e-6) {
    const cosang = Math.abs((a0x * b0x + a0y * b0y + a0z * b0z) / (la * lb));
    if (cosang > 0.995) {
      // Overlap interval of the two segments projected on A's axis.
      const ux = a0x / la, uy = a0y / la, uz = a0z / la;
      const pA0 = 0, pA1 = la;
      let pB0 = (_cs2.x - _cs0.x) * ux + (_cs2.y - _cs0.y) * uy + (_cs2.z - _cs0.z) * uz;
      let pB1 = (_cs3.x - _cs0.x) * ux + (_cs3.y - _cs0.y) * uy + (_cs3.z - _cs0.z) * uz;
      if (pB0 > pB1) { const t = pB0; pB0 = pB1; pB1 = t; }
      const lo = Math.max(pA0, pB0), hi = Math.min(pA1, pB1);
      if (hi - lo > 1e-4) {
        for (const tv of [lo, hi]) {
          const cxp = _cs0.x + ux * tv, cyp = _cs0.y + uy * tv, czp = _cs0.z + uz * tv;
          closestOnSegment(_cs2.x, _cs2.y, _cs2.z, _cs3.x, _cs3.y, _cs3.z, cxp, cyp, czp, _seg1);
          const ex = _seg1.x - cxp, ey = _seg1.y - cyp, ez = _seg1.z - czp;
          const ed = len3(ex, ey, ez);
          const dep = r - ed;
          if (dep <= 0) continue;
          m.add(
            cxp + nx * (sa.radius - dep * 0.5),
            cyp + ny * (sa.radius - dep * 0.5),
            czp + nz * (sa.radius - dep * 0.5),
            dep, tv === lo ? 1 : 2
          );
        }
      }
    }
  }
  m.reduce();
  return true;
}

/* ---- sphere vs polyhedron (box / convex / triangle) ---- */

/** Sphere vs OBB: clamp the centre into the box. Far cheaper than the face walk below. */
function collideSphereBox(sa, pa, box, pb, qb, m, flip) {
  qRotateInv(qb, pa.x - pb.x, pa.y - pb.y, pa.z - pb.z, _s.a);
  const h = box.halfExtents;
  const cx = _s.a.x, cy = _s.a.y, cz = _s.a.z;
  let qx = cx < -h.x ? -h.x : (cx > h.x ? h.x : cx);
  let qy = cy < -h.y ? -h.y : (cy > h.y ? h.y : cy);
  let qz = cz < -h.z ? -h.z : (cz > h.z ? h.z : cz);
  let dx = cx - qx, dy = cy - qy, dz = cz - qz;
  let d2 = dx * dx + dy * dy + dz * dz;
  let nlx, nly, nlz, dist;
  if (d2 > 1e-14) {
    dist = Math.sqrt(d2);
    if (dist >= sa.radius) return false;
    nlx = dx / dist; nly = dy / dist; nlz = dz / dist;
  } else {
    // Centre inside: escape through the nearest face.
    const ex = h.x - Math.abs(cx), ey = h.y - Math.abs(cy), ez = h.z - Math.abs(cz);
    if (ex <= ey && ex <= ez) { nlx = cx >= 0 ? 1 : -1; nly = 0; nlz = 0; dist = -ex; }
    else if (ey <= ez) { nlx = 0; nly = cy >= 0 ? 1 : -1; nlz = 0; dist = -ey; }
    else { nlx = 0; nly = 0; nlz = cz >= 0 ? 1 : -1; dist = -ez; }
  }
  // Local normal points box -> sphere; A is the sphere, so A -> B is its negation.
  qRotate(qb, -nlx, -nly, -nlz, _s.b);
  const depth = sa.radius - dist;
  const nx = _s.b.x, ny = _s.b.y, nz = _s.b.z;
  m.setNormal(flip ? -nx : nx, flip ? -ny : ny, flip ? -nz : nz);
  const t = sa.radius - depth * 0.5;
  m.add(pa.x + nx * t, pa.y + ny * t, pa.z + nz * t, depth, 0);
  return true;
}

function collideSpherePoly(sa, pa, poly, pb, qb, m, flip) {
  if (poly.type === SHAPE.BOX) return collideSphereBox(sa, pa, poly, pb, qb, m, flip);
  // Sphere centre in the polyhedron's local frame.
  qRotateInv(qb, pa.x - pb.x, pa.y - pb.y, pa.z - pb.z, _s.a);
  const cx = _s.a.x, cy = _s.a.y, cz = _s.a.z;
  const faces = poly.faces, V = poly.verts;
  let maxDist = -Infinity, maxFace = -1;
  for (let f = 0; f < faces.length; f++) {
    const fa = faces[f];
    const d = fa.nx * cx + fa.ny * cy + fa.nz * cz - fa.d;
    if (d > maxDist) { maxDist = d; maxFace = f; }
  }
  if (maxFace < 0) return false;
  if (maxDist > sa.radius) return false;

  let nlx, nly, nlz, dist;
  if (maxDist <= 0) {
    // Centre inside: push out along the least-penetrating face.
    const fa = faces[maxFace];
    nlx = fa.nx; nly = fa.ny; nlz = fa.nz;
    dist = maxDist;
  } else {
    // Outside: closest point on the surface.
    let bx = 0, by = 0, bz = 0, bd = Infinity;
    for (let f = 0; f < faces.length; f++) {
      const fa = faces[f];
      const pd = fa.nx * cx + fa.ny * cy + fa.nz * cz - fa.d;
      if (pd <= 0) continue;
      const projx = cx - fa.nx * pd, projy = cy - fa.ny * pd, projz = cz - fa.nz * pd;
      if (pointInFace(poly, fa, projx, projy, projz)) {
        if (pd < bd) { bd = pd; bx = projx; by = projy; bz = projz; }
        continue;
      }
      const nvv = fa.vi.length;
      for (let i = 0; i < nvv; i++) {
        const i0 = fa.vi[i] * 3, i1 = fa.vi[(i + 1) % nvv] * 3;
        closestOnSegment(V[i0], V[i0 + 1], V[i0 + 2], V[i1], V[i1 + 1], V[i1 + 2], cx, cy, cz, _seg0);
        const ex = cx - _seg0.x, ey = cy - _seg0.y, ez = cz - _seg0.z;
        const ed = len3(ex, ey, ez);
        if (ed < bd) { bd = ed; bx = _seg0.x; by = _seg0.y; bz = _seg0.z; }
      }
    }
    if (bd >= sa.radius) return false;
    const dx = cx - bx, dy = cy - by, dz = cz - bz;
    const l = len3(dx, dy, dz);
    if (l < 1e-9) {
      const fa = faces[maxFace];
      nlx = fa.nx; nly = fa.ny; nlz = fa.nz;
    } else { nlx = dx / l; nly = dy / l; nlz = dz / l; }
    dist = bd;
  }

  // Local normal points from the polyhedron towards the sphere; flip to A->B (A = sphere).
  qRotate(qb, -nlx, -nly, -nlz, _s.b);
  const depth = sa.radius - dist;
  const nx = _s.b.x, ny = _s.b.y, nz = _s.b.z;
  m.setNormal(flip ? -nx : nx, flip ? -ny : ny, flip ? -nz : nz);
  m.add(
    pa.x + nx * (sa.radius - depth * 0.5),
    pa.y + ny * (sa.radius - depth * 0.5),
    pa.z + nz * (sa.radius - depth * 0.5),
    depth, 0
  );
  return true;
}

function pointInFace(poly, fa, x, y, z) {
  const V = poly.verts, n = fa.vi.length;
  for (let i = 0; i < n; i++) {
    const i0 = fa.vi[i] * 3, i1 = fa.vi[(i + 1) % n] * 3;
    const ex = V[i1] - V[i0], ey = V[i1 + 1] - V[i0 + 1], ez = V[i1 + 2] - V[i0 + 2];
    const px = x - V[i0], py = y - V[i0 + 1], pz = z - V[i0 + 2];
    const cx2 = ey * pz - ez * py, cy2 = ez * px - ex * pz, cz2 = ex * py - ey * px;
    if (cx2 * fa.nx + cy2 * fa.ny + cz2 * fa.nz < -1e-7) return false;
  }
  return true;
}

/* ---- SAT for polyhedron vs polyhedron ---- */

const _wvA = new Float64Array(3 * 128);
const _wvB = new Float64Array(3 * 128);
const _clip0 = new Float64Array(3 * 32);
const _clip1 = new Float64Array(3 * 32);
const _clipId0 = new Int32Array(32);
const _clipId1 = new Int32Array(32);

function toWorldVerts(poly, pos, quat, out) {
  const V = poly.verts, n = poly.nv;
  quatToMat3(quat, _rotM);
  const m = _rotM;
  for (let i = 0; i < n; i++) {
    const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
    out[i * 3] = m[0] * x + m[1] * y + m[2] * z + pos.x;
    out[i * 3 + 1] = m[3] * x + m[4] * y + m[5] * z + pos.y;
    out[i * 3 + 2] = m[6] * x + m[7] * y + m[8] * z + pos.z;
  }
}

function projectPoly(wv, n, ax, ay, az, out) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = wv[i * 3] * ax + wv[i * 3 + 1] * ay + wv[i * 3 + 2] * az;
    if (d < mn) mn = d;
    if (d > mx) mx = d;
  }
  out[0] = mn; out[1] = mx;
}
const _pr0 = new Float64Array(2);
const _pr1 = new Float64Array(2);

function projectMin(wv, n, ax, ay, az) {
  let mn = Infinity;
  for (let i = 0; i < n; i++) {
    const d = wv[i * 3] * ax + wv[i * 3 + 1] * ay + wv[i * 3 + 2] * az;
    if (d < mn) mn = d;
  }
  return mn;
}

/*
 * SAT + reference-face clipping for polyhedral pairs. Normal points A -> B.
 *
 * Split into three pieces:
 *   satBoxBox    the 15-axis OBB test using the R/AbsR trick. A level is mostly boxes,
 *                and this is roughly 10x cheaper than the generic path — it was the
 *                difference between 9 ms and 3 ms a step on the 5000-collider benchmark.
 *   satGeneric   arbitrary convex hulls; iterates unique edge *directions*, not edges.
 *   buildManifold shared clipping, so both paths produce identical 4-point manifolds.
 */
const _satRes = {
  depth: 0, nx: 0, ny: 0, nz: 0,
  /** 0 = face of A, 1 = face of B, 2 = edge-edge */
  type: 0,
};
const _mA = new Float64Array(9);
const _mB = new Float64Array(9);
const _R = new Float64Array(9);
const _AbsR = new Float64Array(9);

function collidePolyPoly(pa2, pb2, posA, quatA, posB, quatB, m, idBase) {
  const nA = pa2.nv, nB = pb2.nv;
  if (nA > 128 || nB > 128) return false;
  const isBox = pa2.type === SHAPE.BOX && pb2.type === SHAPE.BOX;
  if (isBox) {
    if (!satBoxBox(pa2, posA, quatA, pb2, posB, quatB, _satRes)) return false;
  } else {
    toWorldVerts(pa2, posA, quatA, _wvA);
    toWorldVerts(pb2, posB, quatB, _wvB);
    if (!satGeneric(pa2, pb2, posA, quatA, posB, quatB, _satRes)) return false;
  }
  if (isBox) {
    toWorldVerts(pa2, posA, quatA, _wvA);
    toWorldVerts(pb2, posB, quatB, _wvB);
  }
  return buildManifold(pa2, pb2, quatA, quatB, _satRes, m, idBase);
}

/** Classic OBB separating-axis test (Ericson, RTCD 4.4.1) with depth tracking. */
function satBoxBox(pa2, posA, quatA, pb2, posB, quatB, out) {
  quatToMat3(quatA, _mA);
  quatToMat3(quatB, _mB);
  const ha = pa2.halfExtents, hb = pb2.halfExtents;
  const ea0 = ha.x, ea1 = ha.y, ea2 = ha.z;
  const eb0 = hb.x, eb1 = hb.y, eb2 = hb.z;

  // R[i*3+j] = Aaxis_i . Baxis_j   (axes are the *columns* of the row-major matrices)
  for (let i = 0; i < 3; i++) {
    const axi = _mA[i], ayi = _mA[3 + i], azi = _mA[6 + i];
    for (let j = 0; j < 3; j++) {
      const r = axi * _mB[j] + ayi * _mB[3 + j] + azi * _mB[6 + j];
      _R[i * 3 + j] = r;
      _AbsR[i * 3 + j] = Math.abs(r) + 1e-9;
    }
  }
  const twx = posB.x - posA.x, twy = posB.y - posA.y, twz = posB.z - posA.z;
  const t0 = twx * _mA[0] + twy * _mA[3] + twz * _mA[6];
  const t1 = twx * _mA[1] + twy * _mA[4] + twz * _mA[7];
  const t2 = twx * _mA[2] + twy * _mA[5] + twz * _mA[8];
  const ea = _ea3, eb = _eb3, tl = _tl3;
  ea[0] = ea0; ea[1] = ea1; ea[2] = ea2;
  eb[0] = eb0; eb[1] = eb1; eb[2] = eb2;
  tl[0] = t0; tl[1] = t1; tl[2] = t2;

  let best = Infinity, bestType = 0, bestIdx = 0, bestSign = 1;

  // A's three face axes.
  for (let i = 0; i < 3; i++) {
    const ra = ea[i];
    const rb = eb[0] * _AbsR[i * 3] + eb[1] * _AbsR[i * 3 + 1] + eb[2] * _AbsR[i * 3 + 2];
    const d = ra + rb - Math.abs(tl[i]);
    if (d <= 0) return false;
    if (d < best) { best = d; bestType = 0; bestIdx = i; bestSign = tl[i] >= 0 ? 1 : -1; }
  }
  // B's three face axes.
  for (let j = 0; j < 3; j++) {
    const ra = ea[0] * _AbsR[j] + ea[1] * _AbsR[3 + j] + ea[2] * _AbsR[6 + j];
    const rb = eb[j];
    const proj = tl[0] * _R[j] + tl[1] * _R[3 + j] + tl[2] * _R[6 + j];
    const d = ra + rb - Math.abs(proj);
    if (d <= 0) return false;
    if (d < best) { best = d; bestType = 1; bestIdx = j; bestSign = proj >= 0 ? 1 : -1; }
  }
  // Nine edge-edge axes. Depths are divided by |axis| so they are comparable with the
  // face depths above, and biased by 1.02 so a near-tie keeps the 4-point face manifold.
  let edgeBest = Infinity, ei = -1, ej = -1, esign = 1;
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3, i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3, j2 = (j + 2) % 3;
      const ra = ea[i1] * _AbsR[i2 * 3 + j] + ea[i2] * _AbsR[i1 * 3 + j];
      const rb = eb[j1] * _AbsR[i * 3 + j2] + eb[j2] * _AbsR[i * 3 + j1];
      const proj = tl[i2] * _R[i1 * 3 + j] - tl[i1] * _R[i2 * 3 + j];
      const len = Math.sqrt(Math.max(1e-12, 1 - _R[i * 3 + j] * _R[i * 3 + j]));
      if (len < 1e-5) continue; // near-parallel edges: covered by the face axes
      const d = ra + rb - Math.abs(proj);
      if (d <= 0) return false;
      const dn = d / len;
      if (dn < edgeBest) { edgeBest = dn; ei = i; ej = j; esign = proj >= 0 ? 1 : -1; }
    }
  }

  if (ei >= 0 && edgeBest * 1.02 < best) {
    // Axis = Aaxis_ei x Baxis_ej, oriented A -> B.
    const ax = _mA[ei], ay = _mA[3 + ei], az = _mA[6 + ei];
    const bx = _mB[ej], by = _mB[3 + ej], bz = _mB[6 + ej];
    let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const l = len3(cx, cy, cz) || 1;
    cx = (cx / l) * esign; cy = (cy / l) * esign; cz = (cz / l) * esign;
    out.depth = edgeBest; out.nx = cx; out.ny = cy; out.nz = cz; out.type = 2;
    return true;
  }
  if (bestType === 0) {
    out.nx = _mA[bestIdx] * bestSign;
    out.ny = _mA[3 + bestIdx] * bestSign;
    out.nz = _mA[6 + bestIdx] * bestSign;
  } else {
    out.nx = _mB[bestIdx] * bestSign;
    out.ny = _mB[3 + bestIdx] * bestSign;
    out.nz = _mB[6 + bestIdx] * bestSign;
  }
  out.depth = best;
  out.type = bestType;
  return true;
}
const _ea3 = new Float64Array(3);
const _eb3 = new Float64Array(3);
const _tl3 = new Float64Array(3);

const _fnA = new Float64Array(3 * 256);
const _fnB = new Float64Array(3 * 256);
const _bEdge = new Float64Array(9 * 512); // per edge of B: dir, c, d, dxc packed as 9+3

/**
 * Generic convex-vs-convex SAT. Assumes _wvA/_wvB already hold world vertices.
 *
 * A hull's own extent along one of its face normals is free — it *is* the face plane
 * offset — so each face axis needs a single projection over the other hull instead of
 * two, and the axis is already oriented A -> B so no sign search is needed either.
 */
function satGeneric(pa2, pb2, posA, quatA, posB, quatB, out) {
  const nA = pa2.nv, nB = pb2.nv;
  const facesA = pa2.faces, facesB = pb2.faces;
  if (facesA.length > 256 || facesB.length > 256 || pb2.edgeCount > 512) return false;
  let bestDepth = Infinity, bax = 0, bay = 0, baz = 0;
  let bestType = -1;

  for (let f = 0; f < facesA.length; f++) {
    const fa = facesA[f];
    qRotate(quatA, fa.nx, fa.ny, fa.nz, _s.a);
    const ax = _s.a.x, ay = _s.a.y, az = _s.a.z;
    _fnA[f * 3] = ax; _fnA[f * 3 + 1] = ay; _fnA[f * 3 + 2] = az;
    const maxA = ax * posA.x + ay * posA.y + az * posA.z + fa.d;
    const d = maxA - projectMin(_wvB, nB, ax, ay, az);
    if (d <= 0) return false;
    if (d < bestDepth) { bestDepth = d; bestType = 0; bax = ax; bay = ay; baz = az; }
  }
  for (let f = 0; f < facesB.length; f++) {
    const fb = facesB[f];
    qRotate(quatB, fb.nx, fb.ny, fb.nz, _s.a);
    const ax = _s.a.x, ay = _s.a.y, az = _s.a.z;
    _fnB[f * 3] = ax; _fnB[f * 3 + 1] = ay; _fnB[f * 3 + 2] = az;
    const maxB = ax * posB.x + ay * posB.y + az * posB.z + fb.d;
    const d = maxB - projectMin(_wvA, nA, ax, ay, az);
    if (d <= 0) return false;
    // B's outward normal points back at A, so the A -> B axis is its negation.
    if (d < bestDepth) { bestDepth = d; bestType = 1; bax = -ax; bay = -ay; baz = -az; }
  }

  // Precompute B's edge frames once: direction, the two negated adjacent normals
  // (c, d) and d x c, so the inner loop is four dot products and a branch.
  const ebCount = pb2.edgeCount;
  const eb = pb2.edges, efb = pb2.edgeFaces;
  for (let j = 0; j < ebCount; j++) {
    const g0 = efb[j * 2], g1 = efb[j * 2 + 1];
    const o = j * 9;
    if (g0 < 0 || g1 < 0) { _bEdge[o] = 0; _bEdge[o + 1] = 0; _bEdge[o + 2] = 0; continue; }
    const b0 = eb[j * 2] * 3, b1 = eb[j * 2 + 1] * 3;
    let vx = _wvB[b1] - _wvB[b0], vy = _wvB[b1 + 1] - _wvB[b0 + 1], vz = _wvB[b1 + 2] - _wvB[b0 + 2];
    const l = len3(vx, vy, vz);
    if (l < 1e-9) { _bEdge[o] = 0; _bEdge[o + 1] = 0; _bEdge[o + 2] = 0; continue; }
    _bEdge[o] = vx / l; _bEdge[o + 1] = vy / l; _bEdge[o + 2] = vz / l;
    const cx = -_fnB[g0 * 3], cy = -_fnB[g0 * 3 + 1], cz = -_fnB[g0 * 3 + 2];
    const dx = -_fnB[g1 * 3], dy = -_fnB[g1 * 3 + 1], dz = -_fnB[g1 * 3 + 2];
    // A "flat" edge (two anti-parallel faces, i.e. a bare triangle) has a degenerate
    // Gauss arc; pruning would silently discard every edge axis, so mark it and test.
    _bEdgeFlat[j] = (cx * dx + cy * dy + cz * dz) < -0.999 ? 1 : 0;
    _bEdge[o + 3] = cx; _bEdge[o + 4] = cy; _bEdge[o + 5] = cz;
    _bEdge[o + 6] = dy * cz - dz * cy;
    _bEdge[o + 7] = dz * cx - dx * cz;
    _bEdge[o + 8] = dx * cy - dy * cx;
    _bEdgeD[j * 3] = dx; _bEdgeD[j * 3 + 1] = dy; _bEdgeD[j * 3 + 2] = dz;
  }

  let edgeBest = Infinity, eax = 0, eay = 0, eaz = 0;
  const ea = pa2.edges, efa = pa2.edgeFaces;
  for (let i = 0; i < pa2.edgeCount; i++) {
    const f0 = efa[i * 2], f1 = efa[i * 2 + 1];
    if (f0 < 0 || f1 < 0) continue;
    const ax = _fnA[f0 * 3], ay = _fnA[f0 * 3 + 1], az = _fnA[f0 * 3 + 2];
    const bx = _fnA[f1 * 3], by = _fnA[f1 * 3 + 1], bz = _fnA[f1 * 3 + 2];
    const a0 = ea[i * 2] * 3, a1 = ea[i * 2 + 1] * 3;
    let ux = _wvA[a1] - _wvA[a0], uy = _wvA[a1 + 1] - _wvA[a0 + 1], uz = _wvA[a1 + 2] - _wvA[a0 + 2];
    const ul = len3(ux, uy, uz);
    if (ul < 1e-9) continue;
    ux /= ul; uy /= ul; uz /= ul;
    // b x a spans the same great-circle arc as this edge.
    const bax2 = by * az - bz * ay;
    const bay2 = bz * ax - bx * az;
    const baz2 = bx * ay - by * ax;
    const aFlat = (ax * bx + ay * by + az * bz) < -0.999;

    for (let j = 0; j < ebCount; j++) {
      const o = j * 9;
      const vx = _bEdge[o], vy = _bEdge[o + 1], vz = _bEdge[o + 2];
      if (vx === 0 && vy === 0 && vz === 0) continue;
      const cx0 = _bEdge[o + 3], cy0 = _bEdge[o + 4], cz0 = _bEdge[o + 5];
      const dcx = _bEdge[o + 6], dcy = _bEdge[o + 7], dcz = _bEdge[o + 8];
      if (!aFlat && _bEdgeFlat[j] === 0) {
        const cba = cx0 * bax2 + cy0 * bay2 + cz0 * baz2;
        const dba = _bEdgeD[j * 3] * bax2 + _bEdgeD[j * 3 + 1] * bay2 + _bEdgeD[j * 3 + 2] * baz2;
        if (cba * dba >= 0) continue;
        const adc = ax * dcx + ay * dcy + az * dcz;
        const bdc = bx * dcx + by * dcy + bz * dcz;
        if (adc * bdc >= 0 || cba * bdc <= 0) continue;
      }

      let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const l = len3(cx, cy, cz);
      if (l < 1e-5) continue;
      cx /= l; cy /= l; cz /= l;
      projectPoly(_wvA, nA, cx, cy, cz, _pr0);
      projectPoly(_wvB, nB, cx, cy, cz, _pr1);
      const d1 = _pr0[1] - _pr1[0], d2 = _pr1[1] - _pr0[0];
      const d = d1 < d2 ? d1 : d2;
      if (d <= 0) return false;
      if (d < edgeBest) {
        edgeBest = d;
        const sg = d1 < d2 ? 1 : -1;
        eax = cx * sg; eay = cy * sg; eaz = cz * sg;
      }
    }
  }
  if (edgeBest < Infinity && edgeBest * 1.02 < bestDepth) {
    out.depth = edgeBest; out.nx = eax; out.ny = eay; out.nz = eaz; out.type = 2;
    return true;
  }
  if (bestType < 0) return false;
  out.depth = bestDepth; out.nx = bax; out.ny = bay; out.nz = baz; out.type = bestType;
  return true;
}
const _bEdgeD = new Float64Array(3 * 512);
const _bEdgeFlat = new Uint8Array(512);

/** Edge whose both endpoints are most extreme along (dx,dy,dz). */
function findSupportEdge(poly, wv, dx, dy, dz) {
  let best = -Infinity, bi = 0;
  for (let i = 0; i < poly.edgeCount; i++) {
    const a = poly.edges[i * 2] * 3, b = poly.edges[i * 2 + 1] * 3;
    const da = wv[a] * dx + wv[a + 1] * dy + wv[a + 2] * dz;
    const dbv = wv[b] * dx + wv[b + 1] * dy + wv[b + 2] * dz;
    const score = da < dbv ? da : dbv;
    if (score > best) { best = score; bi = i; }
  }
  return bi;
}

/** Turn a chosen separating axis into a contact manifold (up to 4 points). */
function buildManifold(pa2, pb2, quatA, quatB, sat, m, idBase) {
  const bax = sat.nx, bay = sat.ny, baz = sat.nz;
  const bestDepth = sat.depth;

  if (sat.type === 2) {
    const ei = findSupportEdge(pa2, _wvA, bax, bay, baz);
    const ej = findSupportEdge(pb2, _wvB, -bax, -bay, -baz);
    const a0 = pa2.edges[ei * 2] * 3, a1 = pa2.edges[ei * 2 + 1] * 3;
    const b0 = pb2.edges[ej * 2] * 3, b1 = pb2.edges[ej * 2 + 1] * 3;
    _cs0.x = _wvA[a0]; _cs0.y = _wvA[a0 + 1]; _cs0.z = _wvA[a0 + 2];
    _cs1.x = _wvA[a1]; _cs1.y = _wvA[a1 + 1]; _cs1.z = _wvA[a1 + 2];
    _cs2.x = _wvB[b0]; _cs2.y = _wvB[b0 + 1]; _cs2.z = _wvB[b0 + 2];
    _cs3.x = _wvB[b1]; _cs3.y = _wvB[b1 + 1]; _cs3.z = _wvB[b1 + 2];
    closestSegmentSegment(_cs0, _cs1, _cs2, _cs3, _seg0, _seg1);
    m.setNormal(bax, bay, baz);
    m.add(
      (_seg0.x + _seg1.x) * 0.5, (_seg0.y + _seg1.y) * 0.5, (_seg0.z + _seg1.z) * 0.5,
      bestDepth, (idBase + 0x40000 + ei * 64 + ej) | 0
    );
    return true;
  }

  const refIsA = sat.type === 0;
  const refPoly = refIsA ? pa2 : pb2;
  const incPoly = refIsA ? pb2 : pa2;
  const refW = refIsA ? _wvA : _wvB;
  const incW = refIsA ? _wvB : _wvA;
  const refQ = refIsA ? quatA : quatB;
  const incQ = refIsA ? quatB : quatA;
  // The reference face's outward normal is the separating axis (flipped when the
  // reference body is B, whose outward direction points back towards A).
  const rnx = refIsA ? bax : -bax;
  const rny = refIsA ? bay : -bay;
  const rnz = refIsA ? baz : -baz;

  let rf = 0, rbest = -Infinity;
  for (let f = 0; f < refPoly.faces.length; f++) {
    const fa = refPoly.faces[f];
    qRotate(refQ, fa.nx, fa.ny, fa.nz, _s.a);
    const dd = _s.a.x * rnx + _s.a.y * rny + _s.a.z * rnz;
    if (dd > rbest) { rbest = dd; rf = f; }
  }
  let inf = 0, ibest = Infinity;
  for (let f = 0; f < incPoly.faces.length; f++) {
    const fa = incPoly.faces[f];
    qRotate(incQ, fa.nx, fa.ny, fa.nz, _s.a);
    const dd = _s.a.x * rnx + _s.a.y * rny + _s.a.z * rnz;
    if (dd < ibest) { ibest = dd; inf = f; }
  }

  const rFace = refPoly.faces[rf];
  const iFace = incPoly.faces[inf];
  let n0 = iFace.vi.length;
  if (n0 > 32) n0 = 32;
  for (let i = 0; i < n0; i++) {
    const vi = iFace.vi[i] * 3;
    _clip0[i * 3] = incW[vi]; _clip0[i * 3 + 1] = incW[vi + 1]; _clip0[i * 3 + 2] = incW[vi + 2];
    _clipId0[i] = iFace.vi[i];
  }
  let cnt = n0;
  let src = _clip0, srcId = _clipId0, dst = _clip1, dstId = _clipId1;
  const rn = rFace.vi.length;
  for (let e = 0; e < rn && cnt; e++) {
    const v0 = rFace.vi[e] * 3, v1 = rFace.vi[(e + 1) % rn] * 3;
    const ex = refW[v1] - refW[v0], ey = refW[v1 + 1] - refW[v0 + 1], ez = refW[v1 + 2] - refW[v0 + 2];
    // Inward side plane for a CCW face loop: normal = refNormal x edge.
    let px = rny * ez - rnz * ey, py = rnz * ex - rnx * ez, pz = rnx * ey - rny * ex;
    const pl = len3(px, py, pz);
    if (pl < 1e-9) continue;
    px /= pl; py /= pl; pz /= pl;
    const pd = px * refW[v0] + py * refW[v0 + 1] + pz * refW[v0 + 2];
    cnt = clipPolyPlane(src, srcId, cnt, px, py, pz, pd, dst, dstId, e);
    const ts = src; src = dst; dst = ts;
    const ti = srcId; srcId = dstId; dstId = ti;
  }
  m.setNormal(bax, bay, baz);
  if (!cnt) {
    // Degenerate clip (slivered face): keep a single point rather than dropping the pair.
    const vi = iFace.vi[0] * 3;
    m.add(incW[vi], incW[vi + 1], incW[vi + 2], bestDepth, idBase | 0);
    return true;
  }

  const rv0 = rFace.vi[0] * 3;
  const refD = rnx * refW[rv0] + rny * refW[rv0 + 1] + rnz * refW[rv0 + 2];
  for (let i = 0; i < cnt; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    const sep = rnx * x + rny * y + rnz * z - refD;
    if (sep > 1e-4) continue;
    // Place the point on the mid-surface for symmetric torque arms.
    const hx = x - rnx * sep * 0.5, hy = y - rny * sep * 0.5, hz = z - rnz * sep * 0.5;
    m.add(hx, hy, hz, -sep, (idBase + rf * 4096 + inf * 64 + (srcId[i] & 63)) | 0);
  }
  if (m.count === 0) {
    m.add(src[0], src[1], src[2], Math.max(0, bestDepth), (idBase + rf * 4096 + inf * 64) | 0);
  }
  m.reduce();
  return true;
}


function clipPolyPlane(src, srcId, n, px, py, pz, pd, dst, dstId, edgeIdx) {
  let out = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = src[i * 3], ay = src[i * 3 + 1], az = src[i * 3 + 2];
    const bx = src[j * 3], by = src[j * 3 + 1], bz = src[j * 3 + 2];
    const da = px * ax + py * ay + pz * az - pd;
    const db = px * bx + py * by + pz * bz - pd;
    if (da >= -1e-9) {
      if (out < 32) { dst[out * 3] = ax; dst[out * 3 + 1] = ay; dst[out * 3 + 2] = az; dstId[out] = srcId[i]; out++; }
    }
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const t = da / (da - db);
      if (out < 32) {
        dst[out * 3] = ax + (bx - ax) * t;
        dst[out * 3 + 1] = ay + (by - ay) * t;
        dst[out * 3 + 2] = az + (bz - az) * t;
        dstId[out] = 32 + edgeIdx * 4 + (srcId[i] & 3);
        out++;
      }
    }
  }
  return out;
}

/* ---- capsule vs polyhedron ---- */

function collideCapsulePoly(sa, pa, qa, poly, pb, qb, m, flip, idBase) {
  capsuleSegment(sa, pa, qa, _cs0, _cs1);
  const nB = poly.nv;
  if (nB > 128) return false;
  toWorldVerts(poly, pb, qb, _wvB);

  const sx = _cs1.x - _cs0.x, sy = _cs1.y - _cs0.y, sz = _cs1.z - _cs0.z;
  const slen = len3(sx, sy, sz);
  const ux = slen > 1e-9 ? sx / slen : 0, uy = slen > 1e-9 ? sy / slen : 1, uz = slen > 1e-9 ? sz / slen : 0;

  let bestDepth = Infinity, bnx = 0, bny = 1, bnz = 0, bestFace = -1, bestType = -1;
  const testAxis = (axP, ayP, azP, type, face) => {
    const l = len3(axP, ayP, azP);
    if (l < 1e-9) return true;
    const ax = axP / l, ay = ayP / l, az = azP / l;
    const s0 = _cs0.x * ax + _cs0.y * ay + _cs0.z * az;
    const s1 = _cs1.x * ax + _cs1.y * ay + _cs1.z * az;
    const amin = Math.min(s0, s1) - sa.radius;
    const amax = Math.max(s0, s1) + sa.radius;
    projectPoly(_wvB, nB, ax, ay, az, _pr1);
    const d1 = amax - _pr1[0], d2 = _pr1[1] - amin;
    if (d1 <= 0 || d2 <= 0) return false;
    const d = Math.min(d1, d2);
    if (d < bestDepth) {
      bestDepth = d; bestType = type; bestFace = face;
      const sgn = d1 < d2 ? 1 : -1;
      bnx = ax * sgn; bny = ay * sgn; bnz = az * sgn;
    }
    return true;
  };

  for (let f = 0; f < poly.faces.length; f++) {
    const fa = poly.faces[f];
    qRotate(qb, fa.nx, fa.ny, fa.nz, _s.a);
    if (!testAxis(_s.a.x, _s.a.y, _s.a.z, 0, f)) return false;
  }
  for (let i = 0; i < poly.edgeCount; i++) {
    const b0 = poly.edges[i * 2] * 3, b1 = poly.edges[i * 2 + 1] * 3;
    const vx = _wvB[b1] - _wvB[b0], vy = _wvB[b1 + 1] - _wvB[b0 + 1], vz = _wvB[b1 + 2] - _wvB[b0 + 2];
    if (!testAxis(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx, 1, i)) return false;
  }
  // Cap axes: from each capsule endpoint to its closest hull vertex.
  for (let e = 0; e < 2; e++) {
    const p = e === 0 ? _cs0 : _cs1;
    let bi = -1, bd = Infinity;
    for (let i = 0; i < nB; i++) {
      const dx = p.x - _wvB[i * 3], dy = p.y - _wvB[i * 3 + 1], dz = p.z - _wvB[i * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; bi = i; }
    }
    if (bi >= 0) {
      if (!testAxis(p.x - _wvB[bi * 3], p.y - _wvB[bi * 3 + 1], p.z - _wvB[bi * 3 + 2], 2, bi)) return false;
    }
  }
  if (bestType < 0) return false;

  // Normal currently points capsule -> poly (A -> B when A is the capsule).
  const outN = flip ? -1 : 1;
  m.setNormal(bnx * outN, bny * outN, bnz * outN);

  if (bestType === 0 && slen > 1e-6) {
    // Face contact: clip the capsule segment against the face's side planes so a
    // capsule lying on a surface gets two contact points instead of rocking on one.
    const fa = poly.faces[bestFace];
    let t0 = 0, t1 = 1;
    const fn = fa.vi.length;
    for (let e = 0; e < fn; e++) {
      const v0 = fa.vi[e] * 3, v1 = fa.vi[(e + 1) % fn] * 3;
      const ex = _wvB[v1] - _wvB[v0], ey = _wvB[v1 + 1] - _wvB[v0 + 1], ez = _wvB[v1 + 2] - _wvB[v0 + 2];
      let px = ey * bnz - ez * bny, py = ez * bnx - ex * bnz, pz = ex * bny - ey * bnx;
      const pl = len3(px, py, pz);
      if (pl < 1e-9) continue;
      px /= pl; py /= pl; pz /= pl;
      // Plane points inward when the capsule sits on the +bn side of the face.
      const sgn = -1;
      const nx2 = px * sgn, ny2 = py * sgn, nz2 = pz * sgn;
      const pd = nx2 * _wvB[v0] + ny2 * _wvB[v0 + 1] + nz2 * _wvB[v0 + 2];
      const d0 = nx2 * _cs0.x + ny2 * _cs0.y + nz2 * _cs0.z - pd;
      const d1v = nx2 * _cs1.x + ny2 * _cs1.y + nz2 * _cs1.z - pd;
      if (d0 <= 0 && d1v <= 0) continue;
      if (d0 > 0 && d1v > 0) { t0 = 1; t1 = 0; break; }
      const t = d0 / (d0 - d1v);
      if (d0 > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (t1 > t0) {
      qRotate(qb, fa.nx, fa.ny, fa.nz, _s.c);
      const fdw = _s.c.x * _wvB[fa.vi[0] * 3] + _s.c.y * _wvB[fa.vi[0] * 3 + 1] + _s.c.z * _wvB[fa.vi[0] * 3 + 2];
      let added = 0;
      for (let k = 0; k < 2; k++) {
        const t = k === 0 ? t0 : t1;
        if (k === 1 && t1 - t0 < 1e-4) break;
        const cxp = _cs0.x + sx * t, cyp = _cs0.y + sy * t, czp = _cs0.z + sz * t;
        const sep = _s.c.x * cxp + _s.c.y * cyp + _s.c.z * czp - fdw;
        const depth = sa.radius - sep;
        if (depth <= 0) continue;
        m.add(
          cxp - _s.c.x * (sa.radius - depth * 0.5),
          cyp - _s.c.y * (sa.radius - depth * 0.5),
          czp - _s.c.z * (sa.radius - depth * 0.5),
          depth, (idBase + 8 + k) | 0
        );
        added++;
      }
      if (added) { m.reduce(); return true; }
    }
  }

  // Single deepest point: closest point on the hull to the segment.
  let bx = 0, by = 0, bz = 0, bd2 = Infinity, cptx = 0, cpty = 0, cptz = 0;
  for (let f = 0; f < poly.faces.length; f++) {
    const fa = poly.faces[f];
    const fn = fa.vi.length;
    for (let e = 0; e < fn; e++) {
      const v0 = fa.vi[e] * 3, v1 = fa.vi[(e + 1) % fn] * 3;
      _cs2.x = _wvB[v0]; _cs2.y = _wvB[v0 + 1]; _cs2.z = _wvB[v0 + 2];
      _cs3.x = _wvB[v1]; _cs3.y = _wvB[v1 + 1]; _cs3.z = _wvB[v1 + 2];
      closestSegmentSegment(_cs0, _cs1, _cs2, _cs3, _seg0, _seg1);
      const dx = _seg1.x - _seg0.x, dy = _seg1.y - _seg0.y, dz = _seg1.z - _seg0.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd2) {
        bd2 = d2;
        bx = _seg1.x; by = _seg1.y; bz = _seg1.z;
        cptx = _seg0.x; cpty = _seg0.y; cptz = _seg0.z;
      }
    }
  }
  const depth = bestDepth;
  if (bd2 < Infinity) {
    m.add((bx + cptx) * 0.5, (by + cpty) * 0.5, (bz + cptz) * 0.5, depth, idBase | 0);
  } else {
    m.add(pa.x, pa.y, pa.z, depth, idBase | 0);
  }
  return m.count > 0;
}

/* ---- scratch triangle polyhedron ---- */

function makeTriPoly() {
  const p = {
    type: SHAPE.CONVEX,
    verts: new Float64Array(9),
    nv: 3,
    faces: [
      { vi: Int32Array.from([0, 1, 2]), nx: 0, ny: 1, nz: 0, d: 0 },
      { vi: Int32Array.from([2, 1, 0]), nx: 0, ny: -1, nz: 0, d: 0 },
    ],
    edges: Int32Array.from([0, 1, 0, 2, 1, 2]),
    // Both faces of the scratch triangle border every edge.
    edgeFaces: Int32Array.from([0, 1, 0, 1, 0, 1]),
    edgeCount: 3,
    localMin: new THREE.Vector3(),
    localMax: new THREE.Vector3(),
    boundingRadius: 0,
    unitInertia: new Float64Array(9),
    originOffset: new THREE.Vector3(),
    volume: 0,
  };
  return p;
}
const _triPoly = makeTriPoly();
const IDENT_Q = new THREE.Quaternion();
const ZERO_V = new THREE.Vector3();

function setTriPoly(p, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const V = p.verts;
  V[0] = ax; V[1] = ay; V[2] = az;
  V[3] = bx; V[4] = by; V[5] = bz;
  V[6] = cx; V[7] = cy; V[8] = cz;
  let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const l = len3(nx, ny, nz);
  if (l < 1e-12) return false;
  nx /= l; ny /= l; nz /= l;
  const d = nx * ax + ny * ay + nz * az;
  p.faces[0].nx = nx; p.faces[0].ny = ny; p.faces[0].nz = nz; p.faces[0].d = d;
  p.faces[1].nx = -nx; p.faces[1].ny = -ny; p.faces[1].nz = -nz; p.faces[1].d = -d;
  p.triNx = nx; p.triNy = ny; p.triNz = nz;
  return true;
}

/* ------------------------------------------------------------------ *
 * Triangle BVH
 * ------------------------------------------------------------------ */

export class TriBVH {
  constructor(verts, indices) {
    this.verts = verts;
    this.indices = indices;
    const tri = (indices.length / 3) | 0;
    this.triCount = tri;
    this.order = new Int32Array(tri);
    const cen = new Float64Array(tri * 3);
    const bmin = new Float64Array(tri * 3);
    const bmax = new Float64Array(tri * 3);
    for (let t = 0; t < tri; t++) {
      this.order[t] = t;
      const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
      for (let k = 0; k < 3; k++) {
        const a = verts[i0 + k], b = verts[i1 + k], c = verts[i2 + k];
        bmin[t * 3 + k] = Math.min(a, b, c);
        bmax[t * 3 + k] = Math.max(a, b, c);
        cen[t * 3 + k] = (a + b + c) / 3;
      }
    }
    this.triMin = bmin;
    this.triMax = bmax;

    const maxNodes = Math.max(1, tri * 2);
    this.nodeMin = new Float64Array(maxNodes * 3);
    this.nodeMax = new Float64Array(maxNodes * 3);
    this.nodeLeft = new Int32Array(maxNodes);
    this.nodeStart = new Int32Array(maxNodes);
    this.nodeCount = new Int32Array(maxNodes);
    this.numNodes = 0;
    this.rootMin = new THREE.Vector3(0, 0, 0);
    this.rootMax = new THREE.Vector3(0, 0, 0);
    if (tri > 0) {
      this._build(0, tri, cen, 0);
      this.rootMin.set(this.nodeMin[0], this.nodeMin[1], this.nodeMin[2]);
      this.rootMax.set(this.nodeMax[0], this.nodeMax[1], this.nodeMax[2]);
    }
    this._stack = new Int32Array(128);
  }

  _alloc() {
    return this.numNodes++;
  }

  _build(start, count, cen, depth) {
    const node = this._alloc();
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = start; i < start + count; i++) {
      const t = this.order[i];
      if (this.triMin[t * 3] < mnx) mnx = this.triMin[t * 3];
      if (this.triMin[t * 3 + 1] < mny) mny = this.triMin[t * 3 + 1];
      if (this.triMin[t * 3 + 2] < mnz) mnz = this.triMin[t * 3 + 2];
      if (this.triMax[t * 3] > mxx) mxx = this.triMax[t * 3];
      if (this.triMax[t * 3 + 1] > mxy) mxy = this.triMax[t * 3 + 1];
      if (this.triMax[t * 3 + 2] > mxz) mxz = this.triMax[t * 3 + 2];
    }
    this.nodeMin[node * 3] = mnx; this.nodeMin[node * 3 + 1] = mny; this.nodeMin[node * 3 + 2] = mnz;
    this.nodeMax[node * 3] = mxx; this.nodeMax[node * 3 + 1] = mxy; this.nodeMax[node * 3 + 2] = mxz;

    if (count <= 4 || depth > 40) {
      this.nodeLeft[node] = -1;
      this.nodeStart[node] = start;
      this.nodeCount[node] = count;
      return node;
    }
    const ex = mxx - mnx, ey = mxy - mny, ez = mxz - mnz;
    const axis = ex > ey ? (ex > ez ? 0 : 2) : (ey > ez ? 1 : 2);
    const mid = start + (count >> 1);
    // Deterministic partial sort on the centroid along the widest axis.
    const sub = Array.prototype.slice.call(this.order.subarray(start, start + count));
    sub.sort((a, b) => (cen[a * 3 + axis] - cen[b * 3 + axis]) || (a - b));
    for (let i = 0; i < count; i++) this.order[start + i] = sub[i];

    this.nodeLeft[node] = -2; // placeholder
    this.nodeStart[node] = 0;
    this.nodeCount[node] = 0;
    const l = this._build(start, mid - start, cen, depth + 1);
    this._build(start + (mid - start), count - (mid - start), cen, depth + 1);
    this.nodeLeft[node] = l;
    return node;
  }

  /** Visit every triangle index whose AABB overlaps the query box. */
  queryAABB(mnx, mny, mnz, mxx, mxy, mxz, cb) {
    if (this.numNodes === 0) return;
    const st = this._stack;
    let sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const n = st[--sp];
      if (
        this.nodeMin[n * 3] > mxx || this.nodeMax[n * 3] < mnx ||
        this.nodeMin[n * 3 + 1] > mxy || this.nodeMax[n * 3 + 1] < mny ||
        this.nodeMin[n * 3 + 2] > mxz || this.nodeMax[n * 3 + 2] < mnz
      ) continue;
      const left = this.nodeLeft[n];
      if (left < 0) {
        const s = this.nodeStart[n], c = this.nodeCount[n];
        for (let i = 0; i < c; i++) cb(this.order[s + i]);
      } else {
        if (sp + 2 >= st.length) continue;
        st[sp++] = left;
        st[sp++] = left + this._rightOffset(left);
      }
    }
  }

  _rightOffset(left) {
    // Children are laid out depth-first: right sibling follows the left subtree.
    return this._subtreeSize(left);
  }

  _subtreeSize(n) {
    if (this._sizes) return this._sizes[n];
    // Memoise subtree sizes once (cheap, build-time only).
    const sizes = new Int32Array(this.numNodes);
    const walk = (i) => {
      const l = this.nodeLeft[i];
      if (l < 0) { sizes[i] = 1; return 1; }
      const ls = walk(l);
      const rs = walk(l + ls);
      sizes[i] = 1 + ls + rs;
      return sizes[i];
    };
    if (this.numNodes) walk(0);
    this._sizes = sizes;
    return sizes[n];
  }

  /** Ray query; `cb(triIndex)` returns the current best t so traversal can prune. */
  raycast(ox, oy, oz, dx, dy, dz, maxT, cb) {
    if (this.numNodes === 0) return;
    const invx = dx !== 0 ? 1 / dx : 1e30;
    const invy = dy !== 0 ? 1 / dy : 1e30;
    const invz = dz !== 0 ? 1 / dz : 1e30;
    const st = this._stack;
    let sp = 0;
    st[sp++] = 0;
    let best = maxT;
    while (sp > 0) {
      const n = st[--sp];
      let t0 = 0, t1 = best;
      let a = (this.nodeMin[n * 3] - ox) * invx, b = (this.nodeMax[n * 3] - ox) * invx;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      a = (this.nodeMin[n * 3 + 1] - oy) * invy; b = (this.nodeMax[n * 3 + 1] - oy) * invy;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      a = (this.nodeMin[n * 3 + 2] - oz) * invz; b = (this.nodeMax[n * 3 + 2] - oz) * invz;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) continue;
      const left = this.nodeLeft[n];
      if (left < 0) {
        const s = this.nodeStart[n], c = this.nodeCount[n];
        for (let i = 0; i < c; i++) {
          const r = cb(this.order[s + i]);
          if (r !== undefined && r < best) best = r;
        }
      } else {
        if (sp + 2 >= st.length) continue;
        st[sp++] = left;
        st[sp++] = left + this._subtreeSize(left);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * collide() dispatch
 * ------------------------------------------------------------------ */

const _localPos = new THREE.Vector3();
const _localQuat = new THREE.Quaternion();
// Compound recursion is at most two levels deep (A compound x B compound), but the
// scratch is indexed by depth anyway so a nested case can never corrupt its parent.
const _childPos = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _childQuat = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
const _subManifolds = [new Manifold(), new Manifold(), new Manifold(), new Manifold()];

function isPoly(s) {
  return s.type === SHAPE.BOX || s.type === SHAPE.CONVEX;
}

/**
 * Fill `m` with a contact manifold between the two shapes. Normal points A -> B.
 * @returns {boolean} true when there is at least one contact point.
 */
export function collide(sa, pa, qa, sb, pb, qb, m) {
  m.reset();
  return collideInner(sa, pa, qa, sb, pb, qb, m, 0, 0);
}

function collideInner(sa, pa, qa, sb, pb, qb, m, idBase, depth) {
  const ta = sa.type, tb = sb.type;

  // Compounds recurse first.
  if ((ta === SHAPE.COMPOUND || tb === SHAPE.COMPOUND) && depth < 3) {
    const aIsC = ta === SHAPE.COMPOUND;
    const host = aIsC ? sa : sb;
    const hp = aIsC ? pa : pb;
    const hq = aIsC ? qa : qb;
    const cp = _childPos[depth];
    const cq = _childQuat[depth];
    const sub = _subManifolds[depth];
    let any = false;
    for (let i = 0; i < host.children.length; i++) {
      const c = host.children[i];
      qRotate(hq, c.position.x, c.position.y, c.position.z, cp);
      cp.add(hp);
      cq.copy(hq).multiply(c.quaternion);
      sub.reset();
      const ok = aIsC
        ? collideInner(c.shape, cp, cq, sb, pb, qb, sub, idBase + i * 1048576, depth + 1)
        : collideInner(sa, pa, qa, c.shape, cp, cq, sub, idBase + i * 1048576, depth + 1);
      if (ok) { mergeSub(m, sub); any = true; }
    }
    if (any) m.reduce();
    return any;
  }

  // Mesh / heightfield always play the "B" role.
  if (ta === SHAPE.TRIMESH || ta === SHAPE.HEIGHTFIELD) {
    const ok = collideConvexMesh(sb, pb, qb, sa, pa, qa, m, idBase, true);
    return ok;
  }
  if (tb === SHAPE.TRIMESH || tb === SHAPE.HEIGHTFIELD) {
    return collideConvexMesh(sa, pa, qa, sb, pb, qb, m, idBase, false);
  }

  if (ta === SHAPE.SPHERE && tb === SHAPE.SPHERE) return collideSphereSphere(sa, pa, sb, pb, m);
  if (ta === SHAPE.SPHERE && tb === SHAPE.CAPSULE) return collideSphereCapsule(sa, pa, sb, pb, qb, m, false);
  if (ta === SHAPE.CAPSULE && tb === SHAPE.SPHERE) return collideSphereCapsule(sb, pb, sa, pa, qa, m, true);
  if (ta === SHAPE.SPHERE && isPoly(sb)) return collideSpherePoly(sa, pa, sb, pb, qb, m, false);
  if (isPoly(sa) && tb === SHAPE.SPHERE) return collideSpherePoly(sb, pb, sa, pa, qa, m, true);
  if (ta === SHAPE.CAPSULE && tb === SHAPE.CAPSULE) return collideCapsuleCapsule(sa, pa, qa, sb, pb, qb, m);
  if (ta === SHAPE.CAPSULE && isPoly(sb)) return collideCapsulePoly(sa, pa, qa, sb, pb, qb, m, false, idBase);
  if (isPoly(sa) && tb === SHAPE.CAPSULE) return collideCapsulePoly(sb, pb, qb, sa, pa, qa, m, true, idBase);
  if (isPoly(sa) && isPoly(sb)) {
    if (collidePolyPoly(sa, sb, pa, qa, pb, qb, m, idBase)) return true;
    // SAT said "separated": trust it (SAT is exact for polyhedra).
    return false;
  }

  // Anything else: GJK/EPA fallback so no pair is ever silently ignored.
  const dist = gjkDistance(sa, pa, qa, sb, pb, qb, gjkResult);
  if (!gjkResult.hit && dist > 1e-6) return false;
  if (epaPenetration(sa, pa, qa, sb, pb, qb, epaResult)) {
    m.setNormal(epaResult.nx, epaResult.ny, epaResult.nz);
    m.add(
      (epaResult.ax + epaResult.bx) * 0.5,
      (epaResult.ay + epaResult.by) * 0.5,
      (epaResult.az + epaResult.bz) * 0.5,
      epaResult.depth, idBase | 0
    );
    return true;
  }
  return false;
}

function mergeSub(m, sub) {
  if (m.count === 0) m.setNormal(sub.nx, sub.ny, sub.nz);
  for (let i = 0; i < sub.count; i++) {
    m.add(sub.px[i], sub.py[i], sub.pz[i], sub.depth[i], sub.id[i]);
  }
}

/* ---- convex vs triangle mesh / heightfield ---- */

const _meshMin = new THREE.Vector3();
const _meshMax = new THREE.Vector3();
const _triM = new Manifold();

function collideConvexMesh(sc, pc, qc, sm, pm, qm, m, idBase, flipResult) {
  // Convex AABB in the mesh's local frame.
  computeAABB(sc, pc, qc, _meshMin, _meshMax);
  const ccx = (_meshMin.x + _meshMax.x) * 0.5;
  const ccy = (_meshMin.y + _meshMax.y) * 0.5;
  const ccz = (_meshMin.z + _meshMax.z) * 0.5;
  const chx = (_meshMax.x - _meshMin.x) * 0.5 + 0.02;
  const chy = (_meshMax.y - _meshMin.y) * 0.5 + 0.02;
  const chz = (_meshMax.z - _meshMin.z) * 0.5 + 0.02;
  qRotateInv(qm, ccx - pm.x, ccy - pm.y, ccz - pm.z, _s.d);
  quatToMat3(qm, _rotM);
  const R = _rotM;
  // |R^T| * halfExtents
  const ex = Math.abs(R[0]) * chx + Math.abs(R[3]) * chy + Math.abs(R[6]) * chz;
  const ey = Math.abs(R[1]) * chx + Math.abs(R[4]) * chy + Math.abs(R[7]) * chz;
  const ez = Math.abs(R[2]) * chx + Math.abs(R[5]) * chy + Math.abs(R[8]) * chz;
  const qmnx = _s.d.x - ex, qmny = _s.d.y - ey, qmnz = _s.d.z - ez;
  const qmxx = _s.d.x + ex, qmxy = _s.d.y + ey, qmxz = _s.d.z + ez;

  let any = false;
  const handleTri = (ax, ay, az, bx, by, bz, cx, cy, cz, triIdx) => {
    if (!setTriPoly(_triPoly, ax, ay, az, bx, by, bz, cx, cy, cz)) return;
    _triM.reset();
    let hit = false;
    const base = (idBase + (triIdx & 0xffff) * 64) | 0;
    if (sc.type === SHAPE.SPHERE) {
      hit = collideSpherePoly(sc, _localPos, _triPoly, ZERO_V, IDENT_Q, _triM, false);
    } else if (sc.type === SHAPE.CAPSULE) {
      hit = collideCapsulePoly(sc, _localPos, _localQuat, _triPoly, ZERO_V, IDENT_Q, _triM, false, base);
    } else if (isPoly(sc)) {
      hit = collidePolyPoly(sc, _triPoly, _localPos, _localQuat, ZERO_V, IDENT_Q, _triM, base);
    } else {
      hit = false;
    }
    if (!hit || _triM.count === 0) return;

    // Internal-edge correction: prefer the triangle's face normal when the SAT
    // normal is close to it, otherwise a body sliding over a mesh catches on seams.
    const tn = _triPoly.triNx, tn2 = _triPoly.triNy, tn3 = _triPoly.triNz;
    const dotN = _triM.nx * tn + _triM.ny * tn2 + _triM.nz * tn3;
    if (dotN > 0.55 && dotN < 0.99999) {
      const scale = 1 / Math.max(1e-4, dotN);
      let ok = true;
      for (let i = 0; i < _triM.count; i++) {
        const nd = _triM.depth[i] * scale;
        if (nd > 0.5) { ok = false; break; }
        _triM.depth[i] = nd;
      }
      if (ok) _triM.setNormal(tn, tn2, tn3);
    }

    // Back into world space.
    for (let i = 0; i < _triM.count; i++) {
      qRotate(qm, _triM.px[i], _triM.py[i], _triM.pz[i], _s.e);
      _triM.px[i] = _s.e.x + pm.x;
      _triM.py[i] = _s.e.y + pm.y;
      _triM.pz[i] = _s.e.z + pm.z;
    }
    qRotate(qm, _triM.nx, _triM.ny, _triM.nz, _s.f);
    if (m.count === 0 || _deepestDepth(_triM) > _deepestDepth(m)) {
      m.setNormal(flipResult ? -_s.f.x : _s.f.x, flipResult ? -_s.f.y : _s.f.y, flipResult ? -_s.f.z : _s.f.z);
    }
    for (let i = 0; i < _triM.count; i++) {
      m.add(_triM.px[i], _triM.py[i], _triM.pz[i], _triM.depth[i], _triM.id[i]);
    }
    any = true;
  };

  // Convex transform in the mesh's local frame.
  qRotateInv(qm, pc.x - pm.x, pc.y - pm.y, pc.z - pm.z, _localPos);
  _localQuat.copy(qm).invert().multiply(qc);

  if (sm.type === SHAPE.TRIMESH) {
    const V = sm.verts, I = sm.indices;
    sm.bvh.queryAABB(qmnx, qmny, qmnz, qmxx, qmxy, qmxz, (t) => {
      const i0 = I[t * 3] * 3, i1 = I[t * 3 + 1] * 3, i2 = I[t * 3 + 2] * 3;
      handleTri(
        V[i0], V[i0 + 1], V[i0 + 2],
        V[i1], V[i1 + 1], V[i1 + 2],
        V[i2], V[i2 + 1], V[i2 + 2], t
      );
    });
  } else {
    const ix0 = Math.max(0, Math.floor((qmnx - sm.originX) / sm.scaleX));
    const ix1 = Math.min(sm.nx - 2, Math.ceil((qmxx - sm.originX) / sm.scaleX));
    const iz0 = Math.max(0, Math.floor((qmnz - sm.originZ) / sm.scaleZ));
    const iz1 = Math.min(sm.nz - 2, Math.ceil((qmxz - sm.originZ) / sm.scaleZ));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x0 = sm.originX + ix * sm.scaleX, x1 = x0 + sm.scaleX;
        const z0 = sm.originZ + iz * sm.scaleZ, z1 = z0 + sm.scaleZ;
        const h00 = sm.heights[iz * sm.nx + ix];
        const h10 = sm.heights[iz * sm.nx + ix + 1];
        const h01 = sm.heights[(iz + 1) * sm.nx + ix];
        const h11 = sm.heights[(iz + 1) * sm.nx + ix + 1];
        const cell = iz * sm.nx + ix;
        handleTri(x0, h00, z0, x0, h01, z1, x1, h10, z0, cell * 2);
        handleTri(x1, h10, z0, x0, h01, z1, x1, h11, z1, cell * 2 + 1);
      }
    }
  }
  if (any) m.reduce();
  return any;
}

function _deepestDepth(m) {
  let d = -Infinity;
  for (let i = 0; i < m.count; i++) if (m.depth[i] > d) d = m.depth[i];
  return d;
}

/* ------------------------------------------------------------------ *
 * Raycasting
 * ------------------------------------------------------------------ */

const _rayO = new THREE.Vector3();
const _rayD = new THREE.Vector3();

/**
 * Ray vs shape in world space.
 * @param out {{t:number, nx:number, ny:number, nz:number, faceIndex:number}}
 */
export function raycastShape(shape, pos, quat, ox, oy, oz, dx, dy, dz, maxDist, out) {
  qRotateInv(quat, ox - pos.x, oy - pos.y, oz - pos.z, _rayO);
  qRotateInv(quat, dx, dy, dz, _rayD);
  if (!raycastLocal(shape, _rayO.x, _rayO.y, _rayO.z, _rayD.x, _rayD.y, _rayD.z, maxDist, out)) {
    return false;
  }
  qRotate(quat, out.nx, out.ny, out.nz, _s.a);
  out.nx = _s.a.x; out.ny = _s.a.y; out.nz = _s.a.z;
  return true;
}

const _subRay = { t: 0, nx: 0, ny: 0, nz: 0, faceIndex: -1 };
const _childRayO = new THREE.Vector3();
const _childRayD = new THREE.Vector3();

function raycastLocal(shape, ox, oy, oz, dx, dy, dz, maxDist, out) {
  switch (shape.type) {
    case SHAPE.SPHERE: return raySphere(ox, oy, oz, dx, dy, dz, shape.radius, maxDist, out);
    case SHAPE.BOX: return rayBox(ox, oy, oz, dx, dy, dz, shape.halfExtents, maxDist, out);
    case SHAPE.CAPSULE: return rayCapsule(ox, oy, oz, dx, dy, dz, shape.radius, shape.halfHeight, maxDist, out);
    case SHAPE.CONVEX: return rayConvex(shape, ox, oy, oz, dx, dy, dz, maxDist, out);
    case SHAPE.TRIMESH: return rayTrimesh(shape, ox, oy, oz, dx, dy, dz, maxDist, out);
    case SHAPE.HEIGHTFIELD: return rayHeightfield(shape, ox, oy, oz, dx, dy, dz, maxDist, out);
    case SHAPE.COMPOUND: {
      let hit = false;
      out.t = maxDist;
      for (let i = 0; i < shape.children.length; i++) {
        const c = shape.children[i];
        qRotateInv(c.quaternion, ox - c.position.x, oy - c.position.y, oz - c.position.z, _childRayO);
        qRotateInv(c.quaternion, dx, dy, dz, _childRayD);
        if (raycastLocal(c.shape, _childRayO.x, _childRayO.y, _childRayO.z,
          _childRayD.x, _childRayD.y, _childRayD.z, out.t, _subRay)) {
          if (_subRay.t < out.t) {
            out.t = _subRay.t;
            qRotate(c.quaternion, _subRay.nx, _subRay.ny, _subRay.nz, _s.b);
            out.nx = _s.b.x; out.ny = _s.b.y; out.nz = _s.b.z;
            out.faceIndex = _subRay.faceIndex;
            out.childIndex = i;
            hit = true;
          }
        }
      }
      return hit;
    }
    default: return false;
  }
}

function raySphere(ox, oy, oz, dx, dy, dz, r, maxDist, out) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  if (c > 0 && b > 0) return false;
  const disc = b * b - c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxDist) return false;
  out.t = t;
  const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
  const il = 1 / (r || 1);
  out.nx = px * il; out.ny = py * il; out.nz = pz * il;
  out.faceIndex = -1;
  return true;
}

function rayBox(ox, oy, oz, dx, dy, dz, h, maxDist, out) {
  let tmin = 0, tmax = maxDist;
  let nAxis = 0, nSign = 1;
  const o = [ox, oy, oz], d = [dx, dy, dz], hh = [h.x, h.y, h.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < -hh[a] || o[a] > hh[a]) return false;
      continue;
    }
    const inv = 1 / d[a];
    let t1 = (-hh[a] - o[a]) * inv;
    let t2 = (hh[a] - o[a]) * inv;
    let s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; nAxis = a; nSign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (tmin < 0 || tmin > maxDist) return false;
  out.t = tmin;
  out.nx = nAxis === 0 ? nSign : 0;
  out.ny = nAxis === 1 ? nSign : 0;
  out.nz = nAxis === 2 ? nSign : 0;
  out.faceIndex = nAxis * 2 + (nSign > 0 ? 0 : 1);
  return true;
}

function rayCapsule(ox, oy, oz, dx, dy, dz, r, hh, maxDist, out) {
  // Infinite cylinder about Y, then clamp to the segment, then the caps.
  const a = dx * dx + dz * dz;
  let best = Infinity, bnx = 0, bny = 0, bnz = 0;
  if (a > 1e-12) {
    const b = ox * dx + oz * dz;
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / a;
      if (t < 0) t = (-b + sq) / a;
      if (t >= 0 && t <= maxDist) {
        const y = oy + dy * t;
        if (y >= -hh && y <= hh) {
          best = t;
          const px = ox + dx * t, pz = oz + dz * t;
          const il = 1 / (r || 1);
          bnx = px * il; bny = 0; bnz = pz * il;
        }
      }
    }
  }
  for (let s = 0; s < 2; s++) {
    const cy = s === 0 ? -hh : hh;
    const oyc = oy - cy;
    const b = ox * dx + oyc * dy + oz * dz;
    const c = ox * ox + oyc * oyc + oz * oz - r * r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    let t = -b - sq;
    if (t < 0) t = -b + sq;
    if (t < 0 || t > maxDist || t >= best) continue;
    const px = ox + dx * t, py = oyc + dy * t, pz = oz + dz * t;
    const il = 1 / (r || 1);
    best = t; bnx = px * il; bny = py * il; bnz = pz * il;
  }
  if (best === Infinity) return false;
  out.t = best; out.nx = bnx; out.ny = bny; out.nz = bnz; out.faceIndex = -1;
  return true;
}

function rayConvex(shape, ox, oy, oz, dx, dy, dz, maxDist, out) {
  let tmin = 0, tmax = maxDist, face = -1;
  let nx = 0, ny = 0, nz = 0;
  for (let f = 0; f < shape.faces.length; f++) {
    const fa = shape.faces[f];
    const denom = fa.nx * dx + fa.ny * dy + fa.nz * dz;
    const dist = fa.nx * ox + fa.ny * oy + fa.nz * oz - fa.d;
    if (Math.abs(denom) < 1e-12) {
      if (dist > 0) return false;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) {
      if (t > tmin) { tmin = t; face = f; nx = fa.nx; ny = fa.ny; nz = fa.nz; }
    } else if (t < tmax) tmax = t;
    if (tmin > tmax) return false;
  }
  if (face < 0 || tmin < 0 || tmin > maxDist) return false;
  out.t = tmin; out.nx = nx; out.ny = ny; out.nz = nz; out.faceIndex = face;
  return true;
}

function rayTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, ox, oy, oz, dx, dy, dz, maxT) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-7 || u > 1 + 1e-7) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-7 || u + v > 1 + 1e-7) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 0 || t > maxT) return -1;
  return t;
}

function rayTrimesh(shape, ox, oy, oz, dx, dy, dz, maxDist, out) {
  const V = shape.verts, I = shape.indices;
  let best = maxDist, bt = -1;
  shape.bvh.raycast(ox, oy, oz, dx, dy, dz, maxDist, (t) => {
    const i0 = I[t * 3] * 3, i1 = I[t * 3 + 1] * 3, i2 = I[t * 3 + 2] * 3;
    const hit = rayTriangle(
      V[i0], V[i0 + 1], V[i0 + 2],
      V[i1], V[i1 + 1], V[i1 + 2],
      V[i2], V[i2 + 1], V[i2 + 2],
      ox, oy, oz, dx, dy, dz, best
    );
    if (hit >= 0 && hit < best) { best = hit; bt = t; }
    return best;
  });
  if (bt < 0) return false;
  const i0 = I[bt * 3] * 3, i1 = I[bt * 3 + 1] * 3, i2 = I[bt * 3 + 2] * 3;
  let nx = (V[i1 + 1] - V[i0 + 1]) * (V[i2 + 2] - V[i0 + 2]) - (V[i1 + 2] - V[i0 + 2]) * (V[i2 + 1] - V[i0 + 1]);
  let ny = (V[i1 + 2] - V[i0 + 2]) * (V[i2] - V[i0]) - (V[i1] - V[i0]) * (V[i2 + 2] - V[i0 + 2]);
  let nz = (V[i1] - V[i0]) * (V[i2 + 1] - V[i0 + 1]) - (V[i1 + 1] - V[i0 + 1]) * (V[i2] - V[i0]);
  const l = len3(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
  out.t = best; out.nx = nx; out.ny = ny; out.nz = nz; out.faceIndex = bt;
  return true;
}

function rayHeightfield(shape, ox, oy, oz, dx, dy, dz, maxDist, out) {
  // Slab-clip to the field bounds, then walk cells with a 2D DDA.
  let t0 = 0, t1 = maxDist;
  const mn = shape.localMin, mx = shape.localMax;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const lo = [mn.x, mn.y - 0.001, mn.z], hi = [mx.x, mx.y + 0.001, mx.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < lo[a] || o[a] > hi[a]) return false;
      continue;
    }
    const inv = 1 / d[a];
    let ta = (lo[a] - o[a]) * inv, tb = (hi[a] - o[a]) * inv;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  const steps = Math.min(4096, Math.ceil(((t1 - t0) / Math.min(shape.scaleX, shape.scaleZ)) * 2) + 2);
  const dt = (t1 - t0) / steps;
  let best = -1, bi = -1, bj = -1, bTri = 0;
  for (let s = 0; s <= steps && best < 0; s++) {
    const t = t0 + dt * s;
    const px = ox + dx * t, pz = oz + dz * t;
    const ix = Math.floor((px - shape.originX) / shape.scaleX);
    const iz = Math.floor((pz - shape.originZ) / shape.scaleZ);
    for (let jz = iz - 1; jz <= iz + 1; jz++) {
      for (let jx = ix - 1; jx <= ix + 1; jx++) {
        if (jx < 0 || jz < 0 || jx >= shape.nx - 1 || jz >= shape.nz - 1) continue;
        const x0 = shape.originX + jx * shape.scaleX, x1 = x0 + shape.scaleX;
        const z0 = shape.originZ + jz * shape.scaleZ, z1 = z0 + shape.scaleZ;
        const h00 = shape.heights[jz * shape.nx + jx];
        const h10 = shape.heights[jz * shape.nx + jx + 1];
        const h01 = shape.heights[(jz + 1) * shape.nx + jx];
        const h11 = shape.heights[(jz + 1) * shape.nx + jx + 1];
        let hit = rayTriangle(x0, h00, z0, x0, h01, z1, x1, h10, z0, ox, oy, oz, dx, dy, dz, maxDist);
        if (hit >= 0 && (best < 0 || hit < best)) { best = hit; bi = jx; bj = jz; bTri = 0; }
        hit = rayTriangle(x1, h10, z0, x0, h01, z1, x1, h11, z1, ox, oy, oz, dx, dy, dz, maxDist);
        if (hit >= 0 && (best < 0 || hit < best)) { best = hit; bi = jx; bj = jz; bTri = 1; }
      }
    }
  }
  if (best < 0) return false;
  const x0 = shape.originX + bi * shape.scaleX, x1 = x0 + shape.scaleX;
  const z0 = shape.originZ + bj * shape.scaleZ, z1 = z0 + shape.scaleZ;
  const h00 = shape.heights[bj * shape.nx + bi];
  const h10 = shape.heights[bj * shape.nx + bi + 1];
  const h01 = shape.heights[(bj + 1) * shape.nx + bi];
  const h11 = shape.heights[(bj + 1) * shape.nx + bi + 1];
  let ax, ay, az, bx, by, bz, cx, cy, cz;
  if (bTri === 0) {
    ax = x0; ay = h00; az = z0; bx = x0; by = h01; bz = z1; cx = x1; cy = h10; cz = z0;
  } else {
    ax = x1; ay = h10; az = z0; bx = x0; by = h01; bz = z1; cx = x1; cy = h11; cz = z1;
  }
  let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const l = len3(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
  out.t = best; out.nx = nx; out.ny = ny; out.nz = nz;
  out.faceIndex = (bj * shape.nx + bi) * 2 + bTri;
  return true;
}

/* ------------------------------------------------------------------ *
 * Conservative advancement sweep (sphere / capsule vs any convex)
 * ------------------------------------------------------------------ */

const _caPos = new THREE.Vector3();
const _caRes = {
  hit: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, nx: 0, ny: 1, nz: 0, simplexCount: 0,
};

/**
 * Sweep shape A from `fromPos` to `toPos` (no rotation) against static shape B.
 * @returns {number} time of impact in [0,1], or -1 for no hit. Fills `out` with the
 *          contact normal (pointing back along the sweep) and the world point.
 */
export function sweepConvex(sa, fromPos, qa, toPos, sb, pb, qb, out, tolerance = 1e-3) {
  const dx = toPos.x - fromPos.x, dy = toPos.y - fromPos.y, dz = toPos.z - fromPos.z;
  const len = len3(dx, dy, dz);
  if (len < 1e-9) return -1;
  let t = 0;
  _caPos.copy(fromPos);
  for (let iter = 0; iter < 48; iter++) {
    const dist = gjkDistance(sa, _caPos, qa, sb, pb, qb, _caRes);
    if (_caRes.hit || dist <= tolerance) {
      out.t = t;
      out.nx = -_caRes.nx; out.ny = -_caRes.ny; out.nz = -_caRes.nz;
      if (!(out.nx || out.ny || out.nz)) { out.nx = -dx / len; out.ny = -dy / len; out.nz = -dz / len; }
      out.px = _caRes.bx; out.py = _caRes.by; out.pz = _caRes.bz;
      return t;
    }
    // Closing speed along the separation normal.
    const closing = (dx * _caRes.nx + dy * _caRes.ny + dz * _caRes.nz);
    if (closing <= 1e-9) return -1;
    const dt = (dist - tolerance * 0.5) / closing;
    t += dt;
    if (t > 1) return -1;
    _caPos.set(fromPos.x + dx * t, fromPos.y + dy * t, fromPos.z + dz * t);
  }
  return -1;
}

export const shapeFactories = {
  sphere, box, capsule, convex, trimesh, heightfield, compound,
};

export { EPS };
