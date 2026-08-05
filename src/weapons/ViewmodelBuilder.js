/**
 * ViewmodelBuilder — every gun in the game, generated as geometry at runtime.
 * Owner: weapons agent.
 *
 * There are no model files in this project, so the viewmodel is machined in code from
 * the same primitives a real part would be made from: extruded profiles (receivers,
 * rails, handguard facets), turned profiles (barrels, muzzle devices, optic tubes),
 * swept profiles (trigger guards, curved magazines, pistol grips) and chamfered boxes
 * (everything else). Every primitive emits its chamfer facets as a *separate*
 * geometry so the bevels can take a brighter, smoother material — that edge highlight
 * is most of the reason a gun reads as machined metal rather than as a grey box.
 *
 * Exports
 *   makeWeaponMaterials(ctx)             -> material bag (see MATSPEC below)
 *   buildWeapon(ctx, def, mats, atts)    -> { root, nodes, meshes, tris, sight, muzzle }
 *   buildArms(ctx, mats, def)            -> { left, right, leftRig, rightRig }
 *   buildRedDot / buildScope / buildIrons / buildMuzzleDevice / buildForegrip
 *   makeBrassPool(ctx, mats, n)          -> { group, cases[] }
 *   makeMuzzleFlash(ctx)                 -> { group, set(intensity, seed) }
 *   G  (the geometry kit, exported for Attachments.js)
 *
 * Everything is metres. Weapon-local space: +X right, +Y up, **−Z down the bore**.
 * The origin sits on the bore axis at the rear face of the upper receiver.
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ========================================================================== */
/*                              geometry kit (G)                              */
/* ========================================================================== */

/** Accumulates positions/normals/uvs and bakes one indexed BufferGeometry. */
class Buf {
  constructor() {
    this.p = [];
    this.n = [];
    this.t = [];
    this.i = [];
  }
  get count() {
    return this.p.length / 3;
  }
  v(x, y, z, nx, ny, nz, u, w) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.t.push(u, w);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  quad(a, b, c, d) {
    this.i.push(a, b, c, a, c, d);
  }
  geom() {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setIndex(this.i);
    return g;
  }
}

/** Merge indexed position/normal/uv geometries. Deliberately not three's version: we
 *  own every input, so this can be small, allocation-light and silent on edge cases. */
function mergeGeoms(list) {
  const geos = list.filter((g) => g && g.index && g.attributes.position);
  if (!geos.length) return null;
  if (geos.length === 1) return geos[0];
  let vc = 0;
  let ic = 0;
  for (const g of geos) {
    vc += g.attributes.position.count;
    ic += g.index.count;
  }
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const t = g.attributes.uv.array;
    pos.set(p, vo * 3);
    nrm.set(n, vo * 3);
    uv.set(t, vo * 2);
    const gi = g.index.array;
    for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Planar metre-space UV from a position and its dominant normal axis. */
function planarUv(x, y, z, nx, ny, nz) {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  if (ay >= ax && ay >= az) return [x, z];
  if (ax >= az) return [z, y];
  return [x, y];
}

/* ------------------------------- chamfered box ---------------------------- */

function axisSamples(half, r, seg) {
  const core = Math.max(0, half - r);
  const R = half - core;
  const out = [];
  for (let i = 0; i <= seg; i++) out.push(-(core + R * Math.tan((Math.PI / 4) * (1 - i / seg))));
  for (let i = 0; i <= seg; i++) out.push(core + R * Math.tan((Math.PI / 4) * (i / seg)));
  return out;
}

const FACES = [
  // n, u axis, v axis  (u x v = n)
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
  [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
];

/**
 * Chamfered box. Returns `{ main, edge }`: `main` is the six flat faces, `edge` is
 * every chamfer facet and corner patch, so they can carry different materials.
 * @param {number} w @param {number} h @param {number} d
 * @param {number} r chamfer radius (metres)
 * @param {number} seg chamfer subdivisions (1 = a single 45° facet)
 */
function boxG(w, h, d, r = 0.0012, seg = 1, opts = {}) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const hd = d * 0.5;
  const rr = Math.min(r, hw * 0.98, hh * 0.98, hd * 0.98);
  const core = [Math.max(0, hw - rr), Math.max(0, hh - rr), Math.max(0, hd - rr)];
  const sx = axisSamples(hw, rr, seg);
  const sy = axisSamples(hh, rr, seg);
  const sz = axisSamples(hd, rr, seg);
  const S = [sx, sy, sz];
  const mid = seg; // index of −core; mid+1 is +core
  const main = new Buf();
  const edge = new Buf();
  const skip = opts.skip || null; // e.g. {'-y':true} to omit a face

  const push = (buf, x, y, z) => {
    const cx = clamp(x, -core[0], core[0]);
    const cy = clamp(y, -core[1], core[1]);
    const cz = clamp(z, -core[2], core[2]);
    let ox = x - cx;
    let oy = y - cy;
    let oz = z - cz;
    const l = Math.hypot(ox, oy, oz) || 1;
    ox /= l;
    oy /= l;
    oz /= l;
    const px = cx + ox * rr;
    const py = cy + oy * rr;
    const pz = cz + oz * rr;
    const uv = planarUv(px, py, pz, ox, oy, oz);
    return buf.v(px, py, pz, ox, oy, oz, uv[0], uv[1]);
  };

  const NAMES = ['+x', '-x', '+y', '-y', '+z', '-z'];
  for (let f = 0; f < 6; f++) {
    if (skip && skip[NAMES[f]]) continue;
    const [n, ua, va] = FACES[f];
    const nAxis = n[0] ? 0 : n[1] ? 1 : 2;
    const uAxis = ua[0] ? 0 : ua[1] ? 1 : 2;
    const vAxis = va[0] ? 0 : va[1] ? 1 : 2;
    const nVal = (n[0] || n[1] || n[2]) * [hw, hh, hd][nAxis];
    const us = S[uAxis];
    const vs = S[vAxis];
    const cell = new Array(3);
    for (let i = 0; i < us.length - 1; i++) {
      for (let j = 0; j < vs.length - 1; j++) {
        const flat = i === mid && j === mid;
        const buf = flat ? main : edge;
        const q = [];
        for (const [du, dv] of [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ]) {
          cell[nAxis] = nVal;
          cell[uAxis] = us[i + du];
          cell[vAxis] = vs[j + dv];
          q.push(push(buf, cell[0], cell[1], cell[2]));
        }
        buf.quad(q[0], q[1], q[2], q[3]);
      }
    }
  }
  return { main: main.geom(), edge: edge.geom() };
}

/**
 * Unchamfered box, 2 triangles per face. For the parts that are *holes* — rail slots,
 * M-LOK cutouts, flutes — where every polygon spent on a bevel is wasted because the
 * feature is a dark recess a couple of millimetres deep.
 */
function plainBoxG(w, h, d, skip) {
  const b = new Buf();
  const hw = w * 0.5;
  const hh = h * 0.5;
  const hd = d * 0.5;
  const NAMES = ['+x', '-x', '+y', '-y', '+z', '-z'];
  const HALF = [hw, hh, hd];
  const cell = [0, 0, 0];
  for (let f = 0; f < 6; f++) {
    if (skip && skip[NAMES[f]]) continue;
    const [n, ua, va] = FACES[f];
    const nAxis = n[0] ? 0 : n[1] ? 1 : 2;
    const uAxis = ua[0] ? 0 : ua[1] ? 1 : 2;
    const vAxis = va[0] ? 0 : va[1] ? 1 : 2;
    const q = [];
    for (const [du, dv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      cell[nAxis] = (n[0] || n[1] || n[2]) * HALF[nAxis];
      cell[uAxis] = du * HALF[uAxis];
      cell[vAxis] = dv * HALF[vAxis];
      const uv = planarUv(cell[0], cell[1], cell[2], n[0], n[1], n[2]);
      q.push(b.v(cell[0], cell[1], cell[2], n[0], n[1], n[2], uv[0], uv[1]));
    }
    b.quad(q[0], q[1], q[2], q[3]);
  }
  return { main: b.geom(), edge: null };
}

/* -------------------------------- polygons -------------------------------- */

/**
 * Chamfer the corners of a closed 2D polygon.
 * @param {Array<[number,number]>} pts CCW
 * @returns {{pts: Array<[number,number]>, cham: boolean[]}} cham[i] marks the segment
 *          i -> i+1 as a chamfer facet.
 */
function chamferPoly(pts, r, seg = 1) {
  const n = pts.length;
  const out = [];
  const cham = [];
  for (let i = 0; i < n; i++) {
    const P = pts[(i - 1 + n) % n];
    const V = pts[i];
    const N = pts[(i + 1) % n];
    const inx = V[0] - P[0];
    const iny = V[1] - P[1];
    const onx = N[0] - V[0];
    const ony = N[1] - V[1];
    const li = Math.hypot(inx, iny) || 1;
    const lo = Math.hypot(onx, ony) || 1;
    const rr = Math.min(r, li * 0.45, lo * 0.45);
    if (rr < 1e-5) {
      out.push([V[0], V[1]]);
      cham.push(false);
      continue;
    }
    const A = [V[0] - (inx / li) * rr, V[1] - (iny / li) * rr];
    const B = [V[0] + (onx / lo) * rr, V[1] + (ony / lo) * rr];
    if (seg <= 1) {
      out.push(A);
      cham.push(true);
      out.push(B);
      cham.push(false);
    } else {
      for (let k = 0; k <= seg; k++) {
        const t = k / seg;
        const mt = 1 - t;
        out.push([
          mt * mt * A[0] + 2 * mt * t * V[0] + t * t * B[0],
          mt * mt * A[1] + 2 * mt * t * V[1] + t * t * B[1],
        ]);
        cham.push(k < seg);
      }
    }
  }
  return { pts: out, cham };
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/** Ear-clip a (possibly non-convex, possibly holed) section; always returns CCW faces. */
function triangulate(contour, holes) {
  const all = holes ? contour.concat(...holes) : contour;
  let faces;
  try {
    const c = contour.map((p) => new THREE.Vector2(p[0], p[1]));
    const h = (holes || []).map((loop) => loop.map((p) => new THREE.Vector2(p[0], p[1])));
    faces = THREE.ShapeUtils.triangulateShape(c, h) || [];
  } catch {
    // Fan fallback: convex-only but never throws.
    faces = [];
    for (let i = 1; i < contour.length - 1; i++) faces.push([0, i, i + 1]);
  }
  // Earcut's winding depends on the input ring order; normalise so callers can rely
  // on every face being counter-clockwise in section space.
  for (const f of faces) {
    const a = all[f[0]];
    const b = all[f[1]];
    const c2 = all[f[2]];
    if (!a || !b || !c2) continue;
    const area = (b[0] - a[0]) * (c2[1] - a[1]) - (c2[0] - a[0]) * (b[1] - a[1]);
    if (area < 0) {
      const t = f[1];
      f[1] = f[2];
      f[2] = t;
    }
  }
  return faces;
}

/** Reverse a loop, carrying per-segment flags with it. */
function reverseLoop(pts, flags) {
  const n = pts.length;
  const rp = pts.slice().reverse();
  let rf = null;
  if (flags && flags.length) {
    rf = new Array(n);
    for (let j = 0; j < n; j++) rf[j] = !!flags[(n - 2 - j + n) % n];
  }
  return { pts: rp, cham: rf };
}

/**
 * Extrude a closed 2D section along an axis.
 * @param {{pts:Array<[number,number]>, cham?:boolean[]}} section CCW in the plane
 * @param {object} o {axis:'x'|'y'|'z', from, to, capA, capB, holes}
 */
function extrudeG(section, o = {}) {
  const axis = o.axis || 'z';
  // (s, t) -> 3D is right-handed for x and z, left-handed for y; carry the sign
  // through the normals and the windings rather than reordering every section.
  const hand = axis === 'y' ? -1 : 1;
  const a0 = Math.min(o.from, o.to);
  const a1 = Math.max(o.from, o.to);
  let pts = section.pts || section;
  let cham = section.cham || null;
  if (polyArea(pts) < 0) {
    const r = reverseLoop(pts, cham);
    pts = r.pts;
    cham = r.cham;
  }
  const holes = (o.holes || []).map((h) => (polyArea(h) > 0 ? h.slice().reverse() : h));
  const main = new Buf();
  const edge = new Buf();

  const put = (s, t, a, out) => {
    if (axis === 'z') {
      out[0] = s;
      out[1] = t;
      out[2] = a;
    } else if (axis === 'y') {
      out[0] = s;
      out[1] = a;
      out[2] = t;
    } else {
      out[0] = a;
      out[1] = s;
      out[2] = t;
    }
  };
  const p3 = [0, 0, 0];
  const n3 = [0, 0, 0];

  const wall = (loop, flags) => {
    const n = loop.length;
    let peri = 0;
    for (let i = 0; i < n; i++) {
      const P = loop[i];
      const Q = loop[(i + 1) % n];
      let dx = Q[0] - P[0];
      let dy = Q[1] - P[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-7) continue;
      dx /= len;
      dy /= len;
      // Outward for a CCW outer loop and for a CW hole loop alike.
      put(dy * hand, -dx * hand, 0, n3);
      const buf = flags && flags[i] ? edge : main;
      const vs = [];
      let k = 0;
      for (const [pp, aa] of [
        [P, a1],
        [P, a0],
        [Q, a0],
        [Q, a1],
      ]) {
        put(pp[0], pp[1], aa, p3);
        const u = peri + (k === 2 || k === 3 ? len : 0);
        vs.push(buf.v(p3[0], p3[1], p3[2], n3[0], n3[1], n3[2], u, aa));
        k++;
      }
      if (hand > 0) buf.quad(vs[0], vs[1], vs[2], vs[3]);
      else buf.quad(vs[3], vs[2], vs[1], vs[0]);
      peri += len;
    }
  };

  wall(pts, cham);
  for (const h of holes) wall(h, null);

  const cap = (a, sign) => {
    const faces = triangulate(pts, holes.length ? holes : null);
    const all = holes.length ? pts.concat(...holes) : pts;
    put(0, 0, sign, n3);
    const base = [];
    for (const p of all) {
      put(p[0], p[1], a, p3);
      base.push(main.v(p3[0], p3[1], p3[2], n3[0], n3[1], n3[2], p[0], p[1]));
    }
    const flip = sign > 0 ? hand < 0 : hand > 0;
    for (const f of faces) {
      const A = base[f[0]];
      const B = base[f[1]];
      const C = base[f[2]];
      if (A === undefined || B === undefined || C === undefined) continue;
      if (flip) main.tri(C, B, A);
      else main.tri(A, B, C);
    }
  };
  if (o.capA !== false) cap(a0, -1);
  if (o.capB !== false) cap(a1, 1);

  return { main: main.geom(), edge: edge.geom() };
}

/* --------------------------------- lathe ---------------------------------- */

/**
 * Turned profile around the Z axis. `profile` entries are `[radius, z]` with an
 * optional flag string: 'hard' forces a normal break, 'edge' routes the segment that
 * *starts* at this point into the chamfer material.
 */
function latheG(profile, radial = 18, o = {}) {
  let prof = profile.map((p) => ({
    r: Math.max(1e-5, p[0]),
    z: p[1],
    hard: typeof p[2] === 'string' && p[2].includes('hard'),
    edge: typeof p[2] === 'string' && p[2].includes('edge'),
  }));
  if (prof.length < 2) return { main: null, edge: null };
  let capStart = !!o.capStart;
  let capEnd = !!o.capEnd;
  if (prof[prof.length - 1].z < prof[0].z) {
    // Normals are derived assuming increasing z. Reverse, remapping the per-segment
    // `edge` flag (it belongs to the segment that *starts* at each point) and the
    // per-point `hard` flag, then run the single forward code path.
    const n = prof.length;
    const rev = new Array(n);
    for (let j = 0; j < n; j++) {
      const src = prof[n - 1 - j];
      rev[j] = { r: src.r, z: src.z, hard: src.hard, edge: !!prof[Math.max(0, n - 2 - j)]?.edge };
    }
    prof = rev;
    const t = capStart;
    capStart = capEnd;
    capEnd = t;
  }
  const nseg = prof.length - 1;
  const segN = [];
  for (let i = 0; i < nseg; i++) {
    const dr = prof[i + 1].r - prof[i].r;
    const dz = prof[i + 1].z - prof[i].z;
    const l = Math.hypot(dr, dz) || 1;
    segN.push([dz / l, -dr / l, l]);
  }
  const main = new Buf();
  const edge = new Buf();
  const phi0 = o.phiStart ?? 0;
  const phiL = o.phiLength ?? TAU;
  const closed = Math.abs(phiL - TAU) < 1e-6;
  const cols = radial;
  const smoothCos = Math.cos((o.smoothAngle ?? 44) * (Math.PI / 180));
  let vLen = 0;

  for (let i = 0; i < nseg; i++) {
    const A = prof[i];
    const B = prof[i + 1];
    const [snx, sny, len] = segN[i];
    // Normal at each end: averaged with the neighbour unless a hard break.
    const nA = [snx, sny];
    const nB = [snx, sny];
    const prev = i > 0 ? segN[i - 1] : null;
    if (prev && !A.hard && prev[0] * snx + prev[1] * sny > smoothCos) {
      nA[0] = prev[0] + snx;
      nA[1] = prev[1] + sny;
    }
    const next = i < nseg - 1 ? segN[i + 1] : null;
    if (next && !B.hard && next[0] * snx + next[1] * sny > smoothCos) {
      nB[0] = next[0] + snx;
      nB[1] = next[1] + sny;
    }
    const la = Math.hypot(nA[0], nA[1]) || 1;
    const lb = Math.hypot(nB[0], nB[1]) || 1;
    nA[0] /= la;
    nA[1] /= la;
    nB[0] /= lb;
    nB[1] /= lb;
    const buf = A.edge ? edge : main;
    const ringA = [];
    const ringB = [];
    for (let k = 0; k <= cols; k++) {
      const th = phi0 + (phiL * k) / cols;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const u = th * ((A.r + B.r) * 0.5);
      ringA.push(buf.v(A.r * c, A.r * s, A.z, nA[0] * c, nA[0] * s, nA[1], u, vLen));
      ringB.push(buf.v(B.r * c, B.r * s, B.z, nB[0] * c, nB[0] * s, nB[1], u, vLen + len));
    }
    for (let k = 0; k < cols; k++) buf.quad(ringA[k], ringA[k + 1], ringB[k + 1], ringB[k]);
    vLen += len;
  }

  if (capStart && prof[0].r > 1e-4) discInto(main, prof[0].r, prof[0].z, -1, cols, phi0, phiL, o.capInner ?? 0);
  if (capEnd && prof[prof.length - 1].r > 1e-4) {
    discInto(main, prof[prof.length - 1].r, prof[prof.length - 1].z, 1, cols, phi0, phiL, o.capInner ?? 0);
  }
  void closed;
  return { main: main.geom(), edge: edge.geom() };
}

function discInto(buf, r, z, sign, cols, phi0 = 0, phiL = TAU, inner = 0) {
  const nz = sign;
  if (inner <= 1e-5) {
    const c = buf.v(0, 0, z, 0, 0, nz, 0, 0);
    const ring = [];
    for (let k = 0; k <= cols; k++) {
      const th = phi0 + (phiL * k) / cols;
      ring.push(buf.v(r * Math.cos(th), r * Math.sin(th), z, 0, 0, nz, r * Math.cos(th), r * Math.sin(th)));
    }
    for (let k = 0; k < cols; k++) {
      if (sign > 0) buf.tri(c, ring[k], ring[k + 1]);
      else buf.tri(c, ring[k + 1], ring[k]);
    }
  } else {
    const a = [];
    const b = [];
    for (let k = 0; k <= cols; k++) {
      const th = phi0 + (phiL * k) / cols;
      const co = Math.cos(th);
      const si = Math.sin(th);
      a.push(buf.v(inner * co, inner * si, z, 0, 0, nz, inner * co, inner * si));
      b.push(buf.v(r * co, r * si, z, 0, 0, nz, r * co, r * si));
    }
    for (let k = 0; k < cols; k++) {
      if (sign > 0) buf.quad(a[k], b[k], b[k + 1], a[k + 1]);
      else buf.quad(a[k + 1], b[k + 1], b[k], a[k]);
    }
  }
}

function discG(r, z, sign, cols = 24, inner = 0) {
  const b = new Buf();
  discInto(b, r, z, sign, cols, 0, TAU, inner);
  return b.geom();
}

/** Spherical cap — a lens surface. `bulge` is the sagitta; sign gives the facing. */
function lensG(r, bulge, sign = 1, rings = 5, cols = 28) {
  const b = new Buf();
  const R = (r * r + bulge * bulge) / (2 * Math.max(1e-6, Math.abs(bulge)));
  const cz = -sign * (R - Math.abs(bulge));
  const rows = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const rr = r * t;
    const zz = cz + sign * Math.sqrt(Math.max(0, R * R - rr * rr));
    const row = [];
    for (let k = 0; k <= cols; k++) {
      const th = (TAU * k) / cols;
      const x = rr * Math.cos(th);
      const y = rr * Math.sin(th);
      let nx = x - 0;
      let ny = y - 0;
      let nz = zz - cz;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx = (nx / l) * sign;
      ny = (ny / l) * sign;
      nz = (nz / l) * sign;
      row.push(b.v(x, y, zz, nx, ny, nz, x, y));
    }
    rows.push(row);
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < cols; k++) {
      if (sign > 0) b.quad(rows[i][k], rows[i + 1][k], rows[i + 1][k + 1], rows[i][k + 1]);
      else b.quad(rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k], rows[i][k]);
    }
  }
  return b.geom();
}

/* --------------------------------- sweep ---------------------------------- */

/**
 * Sweep a closed 2D section along a 3D polyline. Frames use a fixed up vector, which
 * is exactly right for the flat-ish paths guns are made of (trigger guards, magazine
 * bodies, grip spines).
 */
function sweepG(section, path, o = {}) {
  const pts = section.pts || section;
  const cham = section.cham || [];
  const up = o.up ? new THREE.Vector3().fromArray(o.up) : new THREE.Vector3(0, 1, 0);
  const scales = o.scales || null;
  const n = pts.length;
  const m = path.length;
  if (m < 2 || n < 3) return { main: null, edge: null };
  const main = new Buf();
  const edge = new Buf();
  const P = path.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const frames = [];
  const t = new THREE.Vector3();
  const rgt = new THREE.Vector3();
  const upv = new THREE.Vector3();
  for (let i = 0; i < m; i++) {
    if (i === 0) t.copy(P[1]).sub(P[0]);
    else if (i === m - 1) t.copy(P[m - 1]).sub(P[m - 2]);
    else t.copy(P[i + 1]).sub(P[i - 1]);
    t.normalize();
    // Right-handed frame: r x u = t, so a CCW section stays CCW around the path.
    rgt.crossVectors(up, t);
    if (rgt.lengthSq() < 1e-8) rgt.set(1, 0, 0);
    rgt.normalize();
    upv.crossVectors(t, rgt).normalize();
    frames.push({ o: P[i].clone(), r: rgt.clone(), u: upv.clone(), t: t.clone() });
  }
  const rings = [];
  const ccw = polyArea(pts) > 0;
  for (let i = 0; i < m; i++) {
    const f = frames[i];
    const s = scales ? scales[i] : 1;
    const ring = [];
    for (let j = 0; j < n; j++) {
      ring.push(
        new THREE.Vector3(
          f.o.x + f.r.x * pts[j][0] * s + f.u.x * pts[j][1] * s,
          f.o.y + f.r.y * pts[j][0] * s + f.u.y * pts[j][1] * s,
          f.o.z + f.r.z * pts[j][0] * s + f.u.z * pts[j][1] * s
        )
      );
    }
    rings.push(ring);
  }
  const nrm = new THREE.Vector3();
  const _e1 = new THREE.Vector3();
  let vAcc = 0;
  for (let i = 0; i < m - 1; i++) {
    const seglen = rings[i][0].distanceTo(rings[i + 1][0]);
    let peri = 0;
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      const a = rings[i][j];
      const b = rings[i][j2];
      const c = rings[i + 1][j2];
      const d = rings[i + 1][j];
      _e1.copy(d).sub(a);
      nrm.copy(b).sub(a).cross(_e1).normalize();
      if (!Number.isFinite(nrm.x) || nrm.lengthSq() < 0.5) nrm.copy(frames[i].r);
      if (!ccw) nrm.negate();
      const buf = cham[j] ? edge : main;
      const len = a.distanceTo(b);
      const q = [
        buf.v(a.x, a.y, a.z, nrm.x, nrm.y, nrm.z, peri, vAcc),
        buf.v(b.x, b.y, b.z, nrm.x, nrm.y, nrm.z, peri + len, vAcc),
        buf.v(c.x, c.y, c.z, nrm.x, nrm.y, nrm.z, peri + len, vAcc + seglen),
        buf.v(d.x, d.y, d.z, nrm.x, nrm.y, nrm.z, peri, vAcc + seglen),
      ];
      if (ccw) buf.quad(q[0], q[1], q[2], q[3]);
      else buf.quad(q[3], q[2], q[1], q[0]);
      peri += len;
    }
    vAcc += seglen;
  }
  const capEnd = (ri, sign) => {
    const f = frames[ri];
    const ring = rings[ri];
    const faces = triangulate(pts, null);
    nrm.copy(f.t).multiplyScalar(sign);
    const base = ring.map((p, j) => main.v(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, pts[j][0], pts[j][1]));
    for (const fa of faces) {
      if (sign > 0 === ccw) main.tri(base[fa[0]], base[fa[1]], base[fa[2]]);
      else main.tri(base[fa[2]], base[fa[1]], base[fa[0]]);
    }
  };
  if (o.capA !== false) capEnd(0, -1);
  if (o.capB !== false) capEnd(m - 1, 1);
  return { main: main.geom(), edge: edge.geom() };
}

/* ------------------------------- small parts ------------------------------ */

/** Rounded-rectangle 2D section. */
function rectSection(w, h, r = 0.0015, seg = 1, cx = 0, cy = 0) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  return chamferPoly(
    [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ],
    r,
    seg
  );
}

/** A grid of truncated pyramids — moulded polymer stippling / checkering. */
function stippleG(w, h, nx, ny, size, depth, o = {}) {
  const b = new Buf();
  const stagger = o.stagger !== false;
  const top = size * 0.32;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const off = stagger && j % 2 ? 0.5 : 0;
      const x = (-w / 2) + ((i + 0.5 + off) / nx) * w;
      const y = (-h / 2) + ((j + 0.5) / ny) * h;
      if (x > w / 2 - size * 0.25) continue;
      const s = size * 0.5;
      const base = [
        [x - s, y - s],
        [x + s, y - s],
        [x + s, y + s],
        [x - s, y + s],
      ];
      const tp = [
        [x - top, y - top],
        [x + top, y - top],
        [x + top, y + top],
        [x - top, y + top],
      ];
      const bi = base.map((p) => b.v(p[0], p[1], 0, 0, 0, 1, p[0], p[1]));
      const ti = tp.map((p) => b.v(p[0], p[1], depth, 0, 0, 1, p[0], p[1]));
      // sides (normals approximated outward-and-up: enough for a 0.3 mm feature)
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        const ax = base[k][0] - x;
        const ay = base[k][1] - y;
        const l = Math.hypot(ax, ay) || 1;
        const nx2 = ax / l;
        const ny2 = ay / l;
        const a = b.v(base[k][0], base[k][1], 0, nx2 * 0.8, ny2 * 0.8, 0.6, base[k][0], base[k][1]);
        const c = b.v(base[k2][0], base[k2][1], 0, nx2 * 0.8, ny2 * 0.8, 0.6, base[k2][0], base[k2][1]);
        const d = b.v(tp[k2][0], tp[k2][1], depth, nx2 * 0.8, ny2 * 0.8, 0.6, tp[k2][0], tp[k2][1]);
        const e = b.v(tp[k][0], tp[k][1], depth, nx2 * 0.8, ny2 * 0.8, 0.6, tp[k][0], tp[k][1]);
        b.quad(a, c, d, e);
      }
      b.quad(ti[0], ti[1], ti[2], ti[3]);
      void bi;
    }
  }
  return b.geom();
}

/** Picatinny rail: an extruded MIL-STD-1913 cross-section plus real recessed slots. */
function railG(len, halfW, baseY, o = {}) {
  const pitch = o.pitch ?? 0.01;
  const slotW = o.slotW ?? 0.0052;
  const h = o.height ?? 0.0092;
  const topHalf = halfW * 0.72;
  const sec = chamferPoly(
    [
      [-halfW, baseY],
      [halfW, baseY],
      [halfW, baseY + h * 0.42],
      [topHalf, baseY + h * 0.72],
      [topHalf, baseY + h],
      [-topHalf, baseY + h],
      [-topHalf, baseY + h * 0.72],
      [-halfW, baseY + h * 0.42],
    ],
    0.0007,
    1
  );
  const body = extrudeG(sec, { axis: 'z', from: -len * 0.5, to: len * 0.5, capA: true, capB: true });
  const slots = [];
  const n = Math.max(1, Math.floor(len / pitch));
  const z0 = -len * 0.5 + (len - (n - 1) * pitch) * 0.5;
  for (let i = 0; i < n; i++) {
    const z = z0 + i * pitch;
    const g = plainBoxG(topHalf * 2.02, h * 0.56, slotW, { '+y': true });
    const m = new THREE.Matrix4().makeTranslation(0, baseY + h - h * 0.28 + 0.0002, z);
    if (g.main) g.main.applyMatrix4(m);
    if (g.edge) g.edge.applyMatrix4(m);
    slots.push(g);
  }
  return { body, slots };
}

const G = {
  Buf,
  mergeGeoms,
  boxG,
  extrudeG,
  latheG,
  sweepG,
  discG,
  lensG,
  chamferPoly,
  rectSection,
  stippleG,
  railG,
  planarUv,
};

/* ========================================================================== */
/*                                 materials                                  */
/* ========================================================================== */

/**
 * Weapon materials. Every one is a *clone* out of ctx.materials so the shared cache
 * is never mutated, each gets its own roughness/metalness window (a gun that is
 * uniformly shiny is the classic tell) and its own detail-normal frequency retuned
 * for centimetre-scale parts rather than the metre-scale level geometry.
 *
 * `noLightingPatch` keeps the world CSM injection off the viewmodel: the viewmodel
 * scene has its own key/fill and must never inherit the world's cascade shadows,
 * which are fitted for the world camera and would black the gun out indoors.
 */
const MATSPEC = {
  anodised: { base: 'brushed_aluminium', color: 0x3b3f45, rough: [0.32, 0.6], metal: [0.68, 1.0], uv: 52, det: 0.008, nrm: 0.75 },
  anodisedEdge: { base: 'brushed_aluminium', color: 0x9298a1, rough: [0.16, 0.33], metal: [0.9, 1.0], uv: 64, det: 0.005, nrm: 0.5 },
  phosphate: { base: 'painted_steel_chipped', color: 0x2b2d31, rough: [0.44, 0.8], metal: [0.55, 1.0], uv: 60, det: 0.007, nrm: 1.0 },
  phosphateEdge: { base: 'brushed_aluminium', color: 0xa0a6ae, rough: [0.18, 0.36], metal: [0.92, 1.0], uv: 64, det: 0.005, nrm: 0.5 },
  steelBright: { base: 'brushed_aluminium', color: 0xc2c7ce, rough: [0.13, 0.3], metal: [0.94, 1.0], uv: 70, det: 0.004, nrm: 0.45 },
  steelDark: { base: 'galvanised_metal', color: 0x1e2023, rough: [0.26, 0.54], metal: [0.85, 1.0], uv: 58, det: 0.006, nrm: 0.7 },
  bore: { base: 'rusted_steel', color: 0x0b0c0d, rough: [0.55, 0.92], metal: [0.35, 0.9], uv: 46, det: 0.007, nrm: 0.8 },
  polymer: { base: 'rubber_tyre', color: 0x33352e, rough: [0.58, 0.92], metal: [0.0, 0.06], uv: 88, det: 0.0035, nrm: 1.1 },
  polymerEdge: { base: 'rubber_tyre', color: 0x5c6053, rough: [0.44, 0.74], metal: [0.0, 0.06], uv: 96, det: 0.003, nrm: 0.8 },
  rubber: { base: 'rubber_tyre', color: 0x17181a, rough: [0.8, 0.99], metal: [0.0, 0.04], uv: 62, det: 0.005, nrm: 1.4 },
  brass: { base: 'brushed_aluminium', color: 0xb08c3e, rough: [0.2, 0.44], metal: [0.9, 1.0], uv: 90, det: 0.003, nrm: 0.5 },
  glove: { base: 'fabric_webbing', color: 0x282a30, rough: [0.62, 0.95], metal: [0.0, 0.08], uv: 46, det: 0.005, nrm: 1.2 },
  glovePad: { base: 'rubber_tyre', color: 0x1b1c20, rough: [0.58, 0.9], metal: [0.0, 0.05], uv: 72, det: 0.004, nrm: 1.25 },
  sleeve: { base: 'fabric_uniform', color: 0x5b6049, rough: [0.66, 1.0], metal: [0.0, 0.05], uv: 34, det: 0.006, nrm: 1.15 },
  skin: { base: 'skin', color: 0xb98a6c, rough: [0.34, 0.66], metal: [0.0, 0.03], uv: 48, det: 0.004, nrm: 0.8 },
};

export function makeWeaponMaterials(ctx) {
  const lib = ctx?.materials;
  const out = {};
  for (const [key, s] of Object.entries(MATSPEC)) {
    let mat = null;
    try {
      mat =
        lib?.clone?.(s.base, {
          color: s.color,
          uvScale: s.uv,
          dust: 0,
          wet: 0,
          tileBreak: 0,
          detail: 1,
          normalScale: s.nrm,
          aoDirect: 0.34,
          aerial: false,
          envMapIntensity: 1.15,
        }) || null;
    } catch {
      mat = null;
    }
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(s.color),
        roughness: s.rough[1],
        metalness: s.metal[1],
      });
    }
    mat.name = `weapon:${key}`;
    mat.userData.noLightingPatch = true;
    // Per-part roughness/metalness windows and a centimetre-scale detail normal.
    try {
      const u = lib?.uniformsOf?.(mat);
      if (u?.uCodRough) u.uCodRough.value.set(s.rough[0], s.rough[1]);
      if (u?.uCodMetal) u.uCodMetal.value.set(s.metal[0], s.metal[1]);
      if (u?.uCodDetail) u.uCodDetail.value.set(1 / Math.max(1e-4, s.det * s.uv), 0.62, 0.4, 40);
    } catch {
      /* a fallback material has no extension uniforms */
    }
    out[key] = mat;
  }
  out._optics = makeOpticMaterials(ctx);
  return out;
}

/* ------------------------------ optic glass ------------------------------- */

// language=GLSL
const GLASS_VERT = `
varying vec3 vWN;
varying vec3 vWV;
varying vec2 vLocal;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWN = normalize( mat3( modelMatrix ) * normal );
  vWV = normalize( cameraPosition - wp.xyz );
  vLocal = position.xy;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// language=GLSL
const GLASS_FRAG = `
precision highp float;
varying vec3 vWN;
varying vec3 vWV;
varying vec2 vLocal;
uniform vec3 uTint;      // anti-reflective coating colour
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uGlowColor;
uniform float uGlow;     // reticle bleed onto the front element
uniform float uRadius;
uniform float uFresnel;
uniform float uBase;
void main() {
  vec3 N = normalize( vWN );
  vec3 V = normalize( vWV );
  float ndv = clamp( dot( N, V ), 0.0, 1.0 );
  float f = pow( 1.0 - ndv, 4.0 );
  vec3 R = reflect( -V, N );
  // A cheap two-lobe environment: the real IBL is fed in from Lighting each frame.
  vec3 env = mix( uGround, uSky, smoothstep( -0.3, 0.45, R.y ) );
  float spec = pow( max( dot( R, uSunDir ), 0.0 ), 260.0 );
  // AR coatings only really show at grazing angles, and they show as colour.
  vec3 coat = uTint * ( 0.12 + 0.88 * f );
  float r = length( vLocal ) / max( 1e-4, uRadius );
  float rim = smoothstep( 0.72, 1.0, r );
  vec3 col = env * ( uBase + 0.85 * f ) + coat * 0.55 + uSunColor * spec * 5.0;
  col += uGlowColor * uGlow * exp( -r * r * 6.0 );
  col += env * rim * 0.35;
  float a = clamp( uBase * 0.9 + f * uFresnel + spec * 2.0 + rim * 0.35 + uGlow * 0.25, 0.0, 1.0 );
  gl_FragColor = vec4( col, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// language=GLSL
const RETICLE_FRAG = `
precision highp float;
varying vec2 vLocal;
uniform vec3 uColor;
uniform float uSize;      // dot radius in local units
uniform float uRing;      // 0 = plain dot, >0 = horseshoe ring radius
uniform float uIntensity;
uniform float uJitter;
void main() {
  vec2 p = vLocal / max( 1e-5, uSize );
  float d = length( p );
  // Slight bloom-friendly falloff: emitters are never a hard disc in real glass.
  float dot0 = exp( -d * d * 3.4 ) + 0.55 * exp( -d * d * 0.55 );
  float a = dot0;
  if ( uRing > 0.0 ) {
    float rd = abs( d - uRing );
    float ring = exp( -rd * rd * 26.0 );
    // horseshoe: fade the top of the ring out
    ring *= smoothstep( 0.55, -0.1, normalize( p + vec2( 1e-6 ) ).y );
    a = max( a, ring * 0.85 );
  }
  a *= uIntensity * ( 0.93 + 0.07 * uJitter );
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( uColor * a, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// language=GLSL
const RETICLE_VERT = `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

// language=GLSL
const SCOPE_FRAG = `
precision highp float;
varying vec2 vLocal;
varying vec3 vWN;
varying vec3 vWV;
uniform sampler2D uPip;
uniform float uUsePip;
uniform float uRadius;
uniform float uOffX;      // eye offset from the optical axis, in exit-pupil radii
uniform float uOffY;
uniform float uBlackout;  // 0 = perfect eye position, 1 = fully occluded
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uAxis;       // world direction the scope is pointing
uniform float uMil;       // reticle scale
uniform vec3 uReticle;
uniform float uIllum;

float line( float v, float w ) { return smoothstep( w, 0.0, abs( v ) ); }

void main() {
  vec2 p = vLocal / max( 1e-5, uRadius );
  float r = length( p );
  if ( r > 1.0 ) discard;

  // Pincushion: real erector systems curve straight lines near the edge.
  vec2 d = p * ( 1.0 + 0.085 * r * r );
  vec3 img;
  if ( uUsePip > 0.5 ) {
    vec2 uv = d * 0.5 + 0.5;
    // Lateral chromatic aberration grows toward the field stop.
    float ca = 0.004 * r * r;
    img.r = texture2D( uPip, uv + d * ca ).r;
    img.g = texture2D( uPip, uv ).g;
    img.b = texture2D( uPip, uv - d * ca ).b;
  } else {
    // No picture-in-picture this frame: show a physically-plausible sky/ground
    // split rotated by where the scope is actually pointing.
    float horizon = clamp( ( -uAxis.y * 3.2 ) + d.y * 1.15, -1.0, 1.0 );
    img = mix( uGround, uSky, smoothstep( -0.25, 0.25, horizon ) );
    img *= 0.82 + 0.18 * ( 1.0 - r * r );
  }

  // Reticle: fine duplex crosshair with mil dots and an illuminated centre.
  float w = 0.006 / max( 0.35, uMil );
  float thick = smoothstep( 0.28, 0.34, r ) * 2.4 + 1.0;
  float cross = max( line( d.x, w * thick ) * step( 0.02, r ), line( d.y, w * thick ) * step( 0.02, r ) );
  float dots = 0.0;
  for ( int i = 1; i <= 4; i++ ) {
    float m = float( i ) * 0.18;
    dots = max( dots, exp( -( pow( abs( d.x ) - m, 2.0 ) + d.y * d.y ) * 2600.0 ) );
    dots = max( dots, exp( -( pow( abs( d.y ) - m, 2.0 ) + d.x * d.x ) * 2600.0 ) );
  }
  float ret = clamp( cross + dots, 0.0, 1.0 );
  float centre = exp( -r * r * 5200.0 );
  img = mix( img, vec3( 0.008 ), ret * 0.94 );
  img += uReticle * centre * uIllum * 6.0;

  // Field stop + tube shadow.
  img *= 1.0 - smoothstep( 0.86, 1.0, r ) * 0.96;

  // Eyebox: the exit pupil is small, so a few millimetres off-axis crescents the
  // image and then blacks it out completely.
  float off = length( vec2( uOffX, uOffY ) );
  float cres = dot( normalize( p + vec2( 1e-6 ) ), normalize( vec2( uOffX, uOffY ) + vec2( 1e-6 ) ) );
  float shadow = smoothstep( 0.15, 1.25, off ) * smoothstep( -0.35, 0.95, cres );
  img *= 1.0 - clamp( shadow + uBlackout, 0.0, 1.0 );

  // Ocular glass on top of the image.
  vec3 N = normalize( vWN );
  vec3 V = normalize( vWV );
  float f = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.0 );
  img += uSky * f * 0.5 + uSunColor * f * 0.08;

  gl_FragColor = vec4( img, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// language=GLSL
const SCOPE_VERT = `
varying vec2 vLocal;
varying vec3 vWN;
varying vec3 vWV;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vLocal = position.xy;
  vWN = normalize( mat3( modelMatrix ) * normal );
  vWV = normalize( cameraPosition - wp.xyz );
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// language=GLSL
const FLASH_FRAG = `
precision highp float;
varying vec2 vUvF;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uAmount;
uniform float uSeed;
void main() {
  vec2 p = vUvF * 2.0 - 1.0;
  float r = length( p );
  float ang = atan( p.y, p.x );
  // Star-shaped bloom with a seeded lobe count so no two shots look identical.
  float lobes = 5.0 + floor( uSeed * 3.0 );
  float star = 0.55 + 0.45 * abs( cos( ang * lobes + uSeed * 6.28 ) );
  float core = exp( -r * r * 14.0 );
  float petal = exp( -pow( r / max( 0.25, star ), 2.4 ) * 3.2 );
  float a = ( core * 1.6 + petal * 0.8 ) * uAmount;
  if ( a < 0.004 ) discard;
  vec3 col = mix( uColorB, uColorA, clamp( core * 1.5, 0.0, 1.0 ) );
  gl_FragColor = vec4( col * a * 7.0, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// language=GLSL
const FLASH_VERT = `
varying vec2 vUvF;
void main() {
  vUvF = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

function makeOpticMaterials(ctx) {
  const glass = new THREE.ShaderMaterial({
    name: 'weapon:opticGlass',
    vertexShader: GLASS_VERT,
    fragmentShader: GLASS_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTint: { value: new THREE.Color(0.16, 0.42, 0.34) },
      uSky: { value: new THREE.Color(0.35, 0.46, 0.62) },
      uGround: { value: new THREE.Color(0.09, 0.085, 0.075) },
      uSunColor: { value: new THREE.Color(1.0, 0.92, 0.78) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.75, 0.5) },
      uGlowColor: { value: new THREE.Color(1.0, 0.12, 0.05) },
      uGlow: { value: 0.0 },
      uRadius: { value: 0.014 },
      uFresnel: { value: 0.78 },
      uBase: { value: 0.055 },
    },
  });
  const reticle = new THREE.ShaderMaterial({
    name: 'weapon:reticle',
    vertexShader: RETICLE_VERT,
    fragmentShader: RETICLE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(1.0, 0.1, 0.04) },
      uSize: { value: 0.3 },
      uRing: { value: 0.0 },
      uIntensity: { value: 6.5 },
      uJitter: { value: 0.0 },
    },
  });
  const scope = new THREE.ShaderMaterial({
    name: 'weapon:scopeImage',
    vertexShader: SCOPE_VERT,
    fragmentShader: SCOPE_FRAG,
    transparent: false,
    depthWrite: true,
    uniforms: {
      uPip: { value: null },
      uUsePip: { value: 0 },
      uRadius: { value: 0.0155 },
      uOffX: { value: 0 },
      uOffY: { value: 0 },
      uBlackout: { value: 0 },
      uSky: { value: new THREE.Color(0.35, 0.46, 0.62) },
      uGround: { value: new THREE.Color(0.09, 0.085, 0.075) },
      uSunColor: { value: new THREE.Color(1.0, 0.92, 0.78) },
      uAxis: { value: new THREE.Vector3(0, 0, -1) },
      uMil: { value: 1.0 },
      uReticle: { value: new THREE.Color(1.0, 0.14, 0.05) },
      uIllum: { value: 0.5 },
    },
  });
  const flash = new THREE.ShaderMaterial({
    name: 'weapon:muzzleFlash',
    vertexShader: FLASH_VERT,
    fragmentShader: FLASH_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColorA: { value: new THREE.Color(1.0, 0.93, 0.72) },
      uColorB: { value: new THREE.Color(1.0, 0.42, 0.1) },
      uAmount: { value: 0.0 },
      uSeed: { value: 0.0 },
    },
  });
  void ctx;
  return { glass, reticle, scope, flash };
}

/* ========================================================================== */
/*                                 part sink                                  */
/* ========================================================================== */

/** Guards against a caller pushing the same geometry twice with different matrices —
 *  applyMatrix4 mutates in place, so the second push would compound the first. */
const _consumed = new WeakSet();

class Sink {
  constructor() {
    this.bins = new Map();
  }
  add(key, geom, matrix) {
    if (!geom) return;
    let g = geom;
    if (_consumed.has(g)) g = g.clone();
    _consumed.add(g);
    if (matrix) g.applyMatrix4(matrix);
    let a = this.bins.get(key);
    if (!a) this.bins.set(key, (a = []));
    a.push(g);
  }
  /** Push a `{main, edge}` pair with separate material keys. */
  pair(p, mainKey, edgeKey, matrix) {
    if (!p) return;
    this.add(mainKey, p.main, matrix);
    this.add(edgeKey || mainKey, p.edge, matrix ? matrix.clone() : null);
  }
  meshes(mats, name = 'part') {
    const out = [];
    for (const [key, list] of this.bins) {
      const g = mergeGeoms(list);
      if (!g) continue;
      const m = new THREE.Mesh(g, mats[key] || mats.anodised);
      m.name = `${name}:${key}`;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      out.push(m);
    }
    this.bins.clear();
    return out;
  }
}

const mTrans = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
function mCompose(pos, rotEuler, scale) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(rotEuler || new THREE.Euler());
  m.compose(
    new THREE.Vector3(pos?.[0] || 0, pos?.[1] || 0, pos?.[2] || 0),
    q,
    new THREE.Vector3(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1)
  );
  return m;
}

/* ========================================================================== */
/*                              weapon assembly                               */
/* ========================================================================== */

/**
 * @param {object} ctx
 * @param {object} def  a WeaponDefs entry
 * @param {object} mats makeWeaponMaterials() result
 */
export function buildWeapon(ctx, def, mats) {
  const b = def.build;
  const root = new THREE.Group();
  root.name = `weapon:${def.id}`;
  const nodes = {};
  const sink = new Sink();

  buildUpper(sink, b);
  buildBarrel(sink, b);
  buildHandguard(sink, b);
  buildLower(sink, b);
  buildGrip(sink, b);
  buildStock(sink, b);

  const staticMeshes = sink.meshes(mats, def.id);
  for (const m of staticMeshes) root.add(m);

  /* ---- moving parts, each its own node ---- */
  nodes.bolt = animPart(root, 'bolt', mats, (s) => buildBoltCarrier(s, b));
  nodes.charging = animPart(root, 'charging', mats, (s) => buildChargingHandle(s, b));
  nodes.dustCover = animPart(root, 'dustCover', mats, (s) => buildDustCover(s, b));
  nodes.trigger = animPart(root, 'trigger', mats, (s) => buildTrigger(s, b));
  nodes.selector = animPart(root, 'selector', mats, (s) => buildSelector(s, b));
  nodes.boltCatch = animPart(root, 'boltCatch', mats, (s) => buildBoltCatch(s, b));

  // The dust cover hinges along the bottom edge of the ejection port.
  nodes.dustCover.position.set(b.receiver.halfW - 0.0016, b.port.y0, (b.port.z0 + b.port.z1) * 0.5);

  const mag = new THREE.Group();
  mag.name = 'magazine';
  root.add(mag);
  nodes.magazine = mag;
  nodes.follower = new THREE.Group();
  mag.add(nodes.follower);
  buildMagazine(mag, nodes.follower, b, mats);

  /* ---- attachment mount points ---- */
  const railTopY = b.rail.y + 0.0092;
  nodes.railTop = new THREE.Object3D();
  nodes.railTop.position.set(0, railTopY, b.style === 'dmr' ? -0.085 : -0.072);
  root.add(nodes.railTop);

  // Muzzle devices are built from their *thread shoulder* backwards, so the mount
  // sits where the barrel's threaded section ends.
  nodes.muzzle = new THREE.Object3D();
  nodes.muzzle.position.set(0, 0, b.barrel.muzzleZ + (b.muzzleDevice?.len || 0));
  root.add(nodes.muzzle);

  nodes.underbarrel = new THREE.Object3D();
  nodes.underbarrel.position.set(0, -b.handguard.r * 0.94, (b.handguard.z0 + b.handguard.z1) * 0.5 - 0.02);
  root.add(nodes.underbarrel);

  nodes.eject = new THREE.Object3D();
  nodes.eject.position.set(b.receiver.halfW + 0.006, (b.port.y0 + b.port.y1) * 0.5, (b.port.z0 + b.port.z1) * 0.5);
  root.add(nodes.eject);

  nodes.magwell = new THREE.Object3D();
  nodes.magwell.position.set(0, b.magwell.yBot - 0.02, (b.magwell.z0 + b.magwell.z1) * 0.5);
  root.add(nodes.magwell);

  nodes.grip = new THREE.Object3D();
  nodes.grip.position.set(0, b.grip.y, b.grip.z);
  root.add(nodes.grip);

  nodes.foreEnd = new THREE.Object3D();
  nodes.foreEnd.position.set(0, -b.handguard.r * 0.55, b.handguard.z1 * 0.62 + b.handguard.z0 * 0.38);
  root.add(nodes.foreEnd);

  let tris = 0;
  root.traverse((o) => {
    if (o.isMesh && o.geometry?.index) tris += o.geometry.index.count / 3;
  });

  return { root, nodes, tris, meshes: staticMeshes };
}

function animPart(parent, name, mats, fn) {
  const g = new THREE.Group();
  g.name = name;
  const s = new Sink();
  fn(s);
  for (const m of s.meshes(mats, name)) g.add(m);
  parent.add(g);
  return g;
}

/* ------------------------------ upper receiver ---------------------------- */

function upperSection(b, notch) {
  const R = b.receiver;
  const hw = R.halfW;
  const pts = [
    [-hw, R.yBot + 0.004],
    [-hw * 0.86, R.yBot],
    [hw * 0.86, R.yBot],
    [hw, R.yBot + 0.004],
    [hw, R.yTop - 0.006],
    [hw * 0.62, R.yTop],
    [-hw * 0.62, R.yTop],
    [-hw, R.yTop - 0.006],
  ];
  if (notch) {
    // Rebuild the right wall with the ejection-port recess cut into it.
    const P = b.port;
    const d = P.depth;
    return chamferPoly(
      [
        [-hw, R.yBot + 0.004],
        [-hw * 0.86, R.yBot],
        [hw * 0.86, R.yBot],
        [hw, R.yBot + 0.004],
        [hw, P.y0],
        [hw - d, P.y0 + 0.0018],
        [hw - d, P.y1 - 0.0018],
        [hw, P.y1],
        [hw, R.yTop - 0.006],
        [hw * 0.62, R.yTop],
        [-hw * 0.62, R.yTop],
        [-hw, R.yTop - 0.006],
      ],
      0.0013,
      1
    );
  }
  return chamferPoly(pts, 0.0016, 2);
}

function buildUpper(sink, b) {
  const R = b.receiver;
  const P = b.port;
  const full = upperSection(b, false);
  const cut = upperSection(b, true);

  sink.pair(extrudeG(full, { axis: 'z', from: R.z0, to: P.z0 }), 'anodised', 'anodisedEdge');
  sink.pair(extrudeG(cut, { axis: 'z', from: P.z0, to: P.z1 }), 'anodised', 'anodisedEdge');
  sink.pair(extrudeG(full, { axis: 'z', from: P.z1, to: R.z1 }), 'anodised', 'anodisedEdge');

  // Top rail runs the length of the flat-top upper.
  const rail = railG(Math.abs(b.rail.z1 - b.receiver.z0) + 0.001, b.rail.halfW, b.rail.y, { pitch: 0.0101 });
  const railM = mTrans(0, 0, (b.rail.z1 + b.receiver.z0) * 0.5);
  sink.pair(rail.body, 'anodised', 'anodisedEdge', railM);
  for (const s of rail.slots) sink.pair(s, 'steelDark', 'steelDark', railM.clone());

  // Brass deflector behind the port, and the port's rear wall.
  const defl = boxG(0.011, 0.017, 0.02, 0.0035, 2);
  sink.pair(defl, 'anodised', 'anodisedEdge', mCompose(
    [R.halfW + 0.0032, P.y1 - 0.004, P.z1 + 0.011],
    new THREE.Euler(0, 0.34, 0.12)
  ));

  // Forward assist.
  const fa = latheG(
    [
      [0.0062, P.z1 + 0.004, 'hard'],
      [0.0062, P.z1 + 0.017],
      [0.0075, P.z1 + 0.0175, 'hard edge'],
      [0.0075, P.z1 + 0.0225],
      [0.0058, P.z1 + 0.0245, 'hard'],
    ],
    14,
    { capEnd: true }
  );
  sink.pair(fa, 'phosphate', 'phosphateEdge', mCompose([R.halfW - 0.0022, P.y1 - 0.0055, 0], new THREE.Euler(0, Math.PI * 0.5 + 0.0, 0)));

  // Charging-handle raceway at the rear, plus the receiver-extension boss.
  const boss = latheG(
    [
      [0.0165, R.z1 - 0.001, 'hard'],
      [0.0165, R.z1 + 0.006],
      [0.014, R.z1 + 0.0065, 'hard'],
    ],
    18,
    { capEnd: true }
  );
  sink.pair(boss, 'anodised', 'anodisedEdge');

  // Takedown / pivot pins.
  for (const z of [R.z0 + 0.014, R.z1 - 0.018]) {
    for (const s of [1, -1]) {
      const pin = latheG(
        [
          [0.0046, -0.0012, 'hard'],
          [0.0046, 0.0012],
          [0.0038, 0.0022, 'hard edge'],
        ],
        12,
        { capEnd: true, capStart: true }
      );
      sink.pair(pin, 'phosphate', 'phosphateEdge', mCompose(
        [s * (b.lower.halfW - 0.0005), b.lower.yTop - 0.006, z],
        new THREE.Euler(0, s * Math.PI * 0.5, 0)
      ));
    }
  }

  // Port interior: a dark recess wall so the cutout reads as an actual hole.
  const inner = boxG(0.0018, P.y1 - P.y0 - 0.001, P.z1 - P.z0 - 0.001, 0.0004, 1);
  sink.pair(inner, 'bore', 'bore', mTrans(R.halfW - P.depth - 0.0009, (P.y0 + P.y1) * 0.5, (P.z0 + P.z1) * 0.5));
}

/* --------------------------------- barrel --------------------------------- */

function buildBarrel(sink, b) {
  const B = b.barrel;
  const md = b.muzzleDevice || { len: 0.04, r: 0.012, style: 'brake', ports: 3 };
  const threadZ = B.muzzleZ + md.len;
  const prof = [
    [B.chamberR, B.chamberZ + 0.03, 'hard'],
    [B.chamberR, B.chamberZ - 0.012],
    [B.chamberR * 0.86, B.chamberZ - 0.016, 'hard edge'],
    [B.midR * 1.16, B.chamberZ - 0.02],
    [B.midR * 1.16, B.gasBlockZ + 0.05],
    [B.midR, B.gasBlockZ + 0.045, 'hard edge'],
    [B.midR, B.gasBlockZ + 0.004],
    [B.midR * 1.28, B.gasBlockZ, 'hard'],
    [B.midR * 1.28, B.gasBlockZ - 0.016],
    [B.midR, B.gasBlockZ - 0.02, 'hard edge'],
    [B.midR, threadZ + 0.02],
    [B.thinR, threadZ + 0.016, 'hard edge'],
    [B.thinR, threadZ],
  ];
  sink.pair(latheG(prof, 20, { capStart: true }), 'phosphate', 'phosphateEdge');

  // Muzzle threads: shallow rings, visible when the device is off.
  for (let i = 0; i < 5; i++) {
    const z = threadZ + 0.0025 + i * 0.0022;
    const ring = latheG(
      [
        [B.thinR * 0.94, z - 0.0009, 'hard'],
        [B.thinR * 1.03, z, 'hard'],
        [B.thinR * 0.94, z + 0.0009, 'hard'],
      ],
      16
    );
    sink.pair(ring, 'steelBright', 'steelBright');
  }

  // Gas block + gas tube (visible through the handguard cut-outs).
  const gb = boxG(0.0225, 0.0235, 0.028, 0.0018, 2);
  sink.pair(gb, 'phosphate', 'phosphateEdge', mTrans(0, 0.0012, B.gasBlockZ - 0.002));
  const tube = latheG(
    [
      [0.0022, B.gasBlockZ - 0.006, 'hard'],
      [0.0022, B.chamberZ - 0.004],
    ],
    10
  );
  sink.pair(tube, 'steelBright', 'steelBright', mTrans(0, B.midR * 1.02 + 0.0035, 0));

  // Fluting for the heavier profiles.
  if (B.fluted) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.26;
      const fl = latheG(
        [
          [B.midR * 0.985, B.gasBlockZ + 0.05, 'hard'],
          [B.midR * 0.985, B.chamberZ - 0.026, 'hard'],
        ],
        4,
        { phiStart: -0.16, phiLength: 0.32 }
      );
      sink.pair(fl, 'steelDark', 'steelDark', new THREE.Matrix4().makeRotationZ(a));
    }
  }
}

/* ------------------------------- handguard -------------------------------- */

/**
 * The handguard is built as separate facet panels with real gaps between the panel
 * segments — that is what an M-LOK slot or a heat vent physically is. A dark inner
 * tube sits behind them so the gaps read as openings and not as painted-on lines.
 */
function buildHandguard(sink, b) {
  const H = b.handguard;
  const z0 = Math.min(H.z0, H.z1);
  const z1 = Math.max(H.z0, H.z1);
  const len = z1 - z0;
  const facets = H.facets || 8;
  const rIn = H.r * 0.79;

  // Inner shroud.
  sink.pair(
    latheG(
      [
        [rIn, z0, 'hard'],
        [rIn, z1, 'hard'],
      ],
      facets * 3,
      {}
    ),
    'bore',
    'bore'
  );

  // Barrel nut at the rear.
  sink.pair(
    latheG(
      [
        [H.r * 0.99, z1 - 0.001, 'hard'],
        [H.r * 0.99, z1 + 0.012],
        [H.r * 0.82, z1 + 0.014, 'hard'],
      ],
      20,
      { capEnd: true }
    ),
    'anodised',
    'anodisedEdge'
  );
  // Muzzle-end cap ring.
  sink.pair(
    latheG(
      [
        [H.r * 0.9, z0 - 0.005, 'hard'],
        [H.r * 0.96, z0 - 0.002, 'hard edge'],
        [H.r * 0.96, z0 + 0.004, 'hard'],
      ],
      20,
      { capStart: true }
    ),
    'anodised',
    'anodisedEdge'
  );

  const half = Math.PI / facets;
  const chord = H.r * Math.tan(half) * 0.94;
  const thick = H.r * 0.19;

  for (let f = 0; f < facets; f++) {
    const ang = (f / facets) * TAU + Math.PI * 0.5; // facet 0 on top
    const isTop = f === 0;
    const vented = (H.ventRows || []).includes(f);
    const slotted = (H.slotRows || []).includes(f);
    if (isTop) continue; // the top rail covers this facet

    // Facet cross-section in facet-local space (x across, y radial).
    const sec = chamferPoly(
      [
        [-chord, -thick],
        [chord, -thick],
        [chord * 0.9, 0],
        [-chord * 0.9, 0],
      ],
      0.0009,
      1
    );
    const rot = new THREE.Euler(0, 0, ang - Math.PI * 0.5);
    const place = (za, zb) =>
      mCompose([Math.cos(ang) * (H.r - thick * 0.5), Math.sin(ang) * (H.r - thick * 0.5), (za + zb) * 0.5], rot);

    // The facet itself is continuous; a real M-LOK slot is a narrow window through
    // the middle of the panel, not a break in it. Heat vents on the shrouded style
    // are genuine gaps between panel segments.
    const cuts = [];
    if (vented) {
      const n = Math.max(3, Math.round(len / 0.038));
      const pitch = len / n;
      for (let i = 0; i < n; i++) {
        const c = z0 + pitch * (i + 0.5);
        cuts.push([c - pitch * 0.3, c + pitch * 0.3]);
      }
      const spans = [];
      let cur = z0;
      for (const [a, cEnd] of cuts) {
        if (a > cur + 0.002) spans.push([cur, a]);
        cur = cEnd;
      }
      if (cur < z1 - 0.002) spans.push([cur, z1]);
      for (const [za, zb] of spans) {
        const g = extrudeG(sec, { axis: 'z', from: -(zb - za) * 0.5, to: (zb - za) * 0.5 });
        sink.pair(g, 'anodised', 'anodisedEdge', place(za, zb));
      }
      for (const [a, cEnd] of cuts) {
        const g = plainBoxG(chord * 1.3, thick * 0.5, cEnd - a - 0.001);
        sink.pair(g, 'bore', 'bore', mCompose(
          [Math.cos(ang) * (H.r - thick * 1.25), Math.sin(ang) * (H.r - thick * 1.25), (a + cEnd) * 0.5],
          rot
        ));
      }
    } else {
      const g = extrudeG(sec, { axis: 'z', from: -len * 0.5, to: len * 0.5 });
      sink.pair(g, 'anodised', 'anodisedEdge', place(z0, z1));
      if (slotted) {
        const n = Math.max(2, Math.round(len / 0.041));
        const slotL = 0.031;
        const pitch = (len - 0.02) / n;
        for (let i = 0; i < n; i++) {
          const c = z0 + 0.01 + pitch * (i + 0.5);
          // Window straight through the panel: dark walls, then the inner shroud
          // showing through, which is exactly what an M-LOK slot looks like.
          const win = plainBoxG(0.0072, thick * 2.4, slotL, { '-y': true });
          sink.pair(win, 'bore', 'bore', mCompose(
            [Math.cos(ang) * (H.r - thick * 0.5), Math.sin(ang) * (H.r - thick * 0.5), c],
            rot
          ));
          // Chamfered lip around the window so it catches a highlight.
          for (const sx of [-1, 1]) {
            const lipG = plainBoxG(0.0012, thick * 0.9, slotL);
            sink.pair(lipG, 'anodisedEdge', 'anodisedEdge', mCompose(
              [
                Math.cos(ang) * (H.r - thick * 0.5) - Math.sin(ang) * sx * 0.0042,
                Math.sin(ang) * (H.r - thick * 0.5) + Math.cos(ang) * sx * 0.0042,
                c,
              ],
              rot
            ));
          }
        }
      }
    }
  }

  // Continuation of the top rail over the handguard — same base height as the upper's
  // rail, so the two are one continuous sight plane the way a free-float rail is.
  const rail = railG(len + 0.004, b.rail.halfW, b.rail.y, { pitch: 0.0101 });
  const railM = mTrans(0, 0, (z0 + z1) * 0.5);
  sink.pair(rail.body, 'anodised', 'anodisedEdge', railM);
  for (const s of rail.slots) sink.pair(s, 'steelDark', 'steelDark', railM.clone());

  // QD sling socket underneath.
  const qd = latheG(
    [
      [0.0058, -0.0022, 'hard'],
      [0.0058, 0.0022],
      [0.004, 0.0028, 'hard edge'],
    ],
    12,
    { capEnd: true }
  );
  sink.pair(qd, 'phosphate', 'phosphateEdge', mCompose(
    [H.r * 0.62, -H.r * 0.66, z0 + 0.05],
    new THREE.Euler(0, Math.PI * 0.5, 0)
  ));
}

/* ----------------------------- lower receiver ----------------------------- */

function buildLower(sink, b) {
  const L = b.lower;
  const M = b.magwell;

  // Main body: the spine that carries the fire-control group.
  const spine = chamferPoly(
    [
      [-L.halfW, L.yBot + 0.003],
      [-L.halfW * 0.8, L.yBot],
      [L.halfW * 0.8, L.yBot],
      [L.halfW, L.yBot + 0.003],
      [L.halfW, L.yTop],
      [-L.halfW, L.yTop],
    ],
    0.0016,
    2
  );
  sink.pair(extrudeG(spine, { axis: 'z', from: L.z0, to: L.z1 }), 'anodised', 'anodisedEdge');

  // Magwell: a genuine tube — outer loop with an inner loop, so you can see down it.
  // Section is (lateral, fore-aft): a magazine is narrow across and deep front-to-back.
  const halfD = M.halfD ?? M.halfW * 1.6;
  const outer = chamferPoly(
    [
      [-M.halfW, -halfD],
      [M.halfW, -halfD],
      [M.halfW, halfD],
      [-M.halfW, halfD],
    ],
    0.0026,
    2
  ).pts;
  const iw = M.halfW - M.wallT;
  const ih = halfD - M.wallT;
  const inner = [
    [-iw, -ih],
    [-iw, ih],
    [iw, ih],
    [iw, -ih],
  ];
  // Section lives in XZ, extruded down Y.
  const wellSec = { pts: outer.map((p) => [p[0], p[1]]), cham: null };
  const g = extrudeG(wellSec, {
    axis: 'y',
    from: M.yBot,
    to: M.yTop,
    holes: [inner],
  });
  const wellM = mTrans(0, 0, (M.z0 + M.z1) * 0.5);
  sink.pair(g, 'anodised', 'anodisedEdge', wellM);

  // Flared magwell lip.
  const lipOuter = chamferPoly(
    [
      [-M.halfW - 0.0035, -halfD - 0.0035],
      [M.halfW + 0.0035, -halfD - 0.0035],
      [M.halfW + 0.0035, halfD + 0.0035],
      [-M.halfW - 0.0035, halfD + 0.0035],
    ],
    0.0032,
    2
  ).pts;
  const lip = extrudeG(
    { pts: lipOuter, cham: null },
    { axis: 'y', from: M.yBot - 0.008, to: M.yBot, holes: [inner] }
  );
  sink.pair(lip, 'anodised', 'anodisedEdge', wellM);

  // Trigger guard: swept loop.
  const tgSec = rectSection(0.0072, 0.0048, 0.0016, 2);
  const zA = b.grip.z + 0.006;
  const zB = M.z1 - 0.004;
  const yTop = L.yBot - 0.0005;
  const path = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // A rounded-front guard: straight along the top, then a smooth bow down and back.
    const z = zA + (zB - zA) * t;
    const bow = Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.08) / 0.92)));
    path.push([0, yTop - 0.0295 * Math.pow(bow, 0.72), z]);
  }
  path[0][1] = yTop - 0.002;
  path[path.length - 1][1] = yTop - 0.004;
  sink.pair(sweepG(tgSec, path, { up: [1, 0, 0] }), 'anodised', 'anodisedEdge');

  // Magazine release, bolt-catch fence, safety detent bumps.
  const relBoss = latheG(
    [
      [0.0072, -0.0016, 'hard'],
      [0.0072, 0.0022],
      [0.0055, 0.0032, 'hard edge'],
    ],
    12,
    { capEnd: true }
  );
  sink.pair(relBoss, 'anodised', 'anodisedEdge', mCompose(
    [L.halfW - 0.0008, L.yTop - 0.0085, M.z0 - 0.008],
    new THREE.Euler(0, Math.PI * 0.5, 0)
  ));
  const relBtn = latheG(
    [
      [0.0042, 0.0, 'hard'],
      [0.0042, 0.0026],
      [0.0034, 0.0034, 'hard edge'],
    ],
    12,
    { capEnd: true }
  );
  sink.pair(relBtn, 'phosphate', 'phosphateEdge', mCompose(
    [L.halfW + 0.0012, L.yTop - 0.0085, M.z0 - 0.008],
    new THREE.Euler(0, Math.PI * 0.5, 0)
  ));

  // Rear sling loop, swept as an actual closed ring around the receiver extension.
  const loopPath = [];
  for (let i = 0; i <= 12; i++) {
    const a = -Math.PI * 0.42 + (Math.PI * 1.84 * i) / 12;
    loopPath.push([0, L.yTop - 0.004 + Math.sin(a) * 0.0075, L.z1 - 0.004 + Math.cos(a) * 0.0075]);
  }
  sink.pair(sweepG(rectSection(0.0034, 0.0026, 0.0008, 1), loopPath, { up: [1, 0, 0] }), 'phosphate', 'phosphateEdge');
}

/* --------------------------------- grip ----------------------------------- */

function buildGrip(sink, b) {
  const g = b.grip;
  const dir = new THREE.Vector3(0, -Math.cos(g.angle), Math.sin(g.angle));
  const path = [];
  const scales = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Slight palm swell then a taper to the base.
    const bow = Math.sin(t * Math.PI) * 0.0055;
    path.push([0, g.y + dir.y * g.len * t, g.z + dir.z * g.len * t + bow]);
    scales.push(1 + 0.1 * Math.sin(t * Math.PI * 0.9) - 0.14 * t * t);
  }
  const sec = chamferPoly(
    [
      [-g.w * 0.5, -g.d * 0.42],
      [g.w * 0.5, -g.d * 0.42],
      [g.w * 0.5, g.d * 0.5],
      [g.w * 0.36, g.d * 0.58],
      [-g.w * 0.36, g.d * 0.58],
      [-g.w * 0.5, g.d * 0.5],
    ],
    0.0055,
    2
  );
  sink.pair(sweepG(sec, path, { up: [0, 0, 1] }), 'polymer', 'polymerEdge');

  // Texture panels on both flats plus the front strap.
  for (const s of [1, -1]) {
    const st = stippleG(g.len * 0.62, g.d * 0.7, 5, 11, 0.0046, 0.001);
    const mid = 0.52;
    const pos = [
      s * (g.w * 0.5 - 0.0004),
      g.y + dir.y * g.len * mid,
      g.z + dir.z * g.len * mid + 0.001,
    ];
    sink.add('polymerEdge', st, mCompose(pos, new THREE.Euler(g.angle, s * Math.PI * 0.5, Math.PI * 0.5)));
  }
  // Finger grooves on the front strap.
  for (let i = 0; i < 3; i++) {
    const t = 0.24 + i * 0.22;
    const groove = latheG(
      [
        [0.0032, -g.w * 0.42, 'hard'],
        [0.0032, g.w * 0.42, 'hard'],
      ],
      8
    );
    sink.pair(groove, 'polymer', 'polymerEdge', mCompose(
      [0, g.y + dir.y * g.len * t + 0.0008, g.z + dir.z * g.len * t - g.d * 0.44],
      new THREE.Euler(0, Math.PI * 0.5, 0)
    ));
  }
  // Beavertail / backstrap.
  const bt = boxG(g.w * 0.94, 0.026, 0.012, 0.004, 2);
  sink.pair(bt, 'polymer', 'polymerEdge', mCompose(
    [0, g.y + 0.006, g.z + g.d * 0.55],
    new THREE.Euler(-0.35, 0, 0)
  ));
  // Base plug.
  const plug = boxG(g.w * 0.82, 0.008, g.d * 0.78, 0.0025, 2);
  sink.pair(plug, 'rubber', 'rubber', mCompose(
    [0, g.y + dir.y * g.len - 0.001, g.z + dir.z * g.len],
    new THREE.Euler(g.angle, 0, 0)
  ));
}

/* --------------------------------- stock ---------------------------------- */

function buildStock(sink, b) {
  const S = b.stock;
  const z0 = S.z0;
  const z1 = S.z0 + S.len;

  // Receiver extension / buffer tube with its position notches.
  const prof = [
    [S.tubeR, z0, 'hard'],
    [S.tubeR, z1 - 0.02],
    [S.tubeR * 1.04, z1 - 0.018, 'hard edge'],
    [S.tubeR * 1.04, z1 - 0.004],
    [S.tubeR * 0.86, z1, 'hard edge'],
  ];
  sink.pair(latheG(prof, 20, { capEnd: true }), 'anodised', 'anodisedEdge');
  for (let i = 0; i < 6; i++) {
    const z = z0 + 0.045 + i * 0.026;
    if (z > z1 - 0.03) break;
    const notch = plainBoxG(0.0085, 0.004, 0.0075);
    sink.pair(notch, 'steelDark', 'steelDark', mTrans(0, -S.tubeR * 0.92, z));
  }

  if (S.style === 'folding') {
    // Skeletonised side-folder: two struts and a thin buttplate.
    for (const s of [1, -1]) {
      const strut = boxG(0.0075, 0.019, S.len * 0.78, 0.0022, 2);
      sink.pair(strut, 'anodised', 'anodisedEdge', mCompose(
        [s * 0.0155, -0.002, z0 + S.len * 0.46],
        new THREE.Euler(0.045 * s * 0, 0, 0)
      ));
    }
    const cross = boxG(0.036, 0.014, 0.008, 0.002, 2);
    sink.pair(cross, 'anodised', 'anodisedEdge', mTrans(0, -0.002, z0 + S.len * 0.62));
    const plate = boxG(0.038, 0.062, 0.0125, 0.004, 2);
    sink.pair(plate, 'polymer', 'polymerEdge', mCompose([0, -0.008, z1 - 0.006], new THREE.Euler(-0.09, 0, 0)));
    const pad = boxG(0.036, 0.058, 0.007, 0.0035, 2);
    sink.pair(pad, 'rubber', 'rubber', mCompose([0, -0.008, z1 + 0.003], new THREE.Euler(-0.09, 0, 0)));
    const hinge = latheG(
      [
        [0.0085, -0.012, 'hard'],
        [0.0085, 0.012],
      ],
      12,
      { capStart: true, capEnd: true }
    );
    sink.pair(hinge, 'phosphate', 'phosphateEdge', mCompose([0.021, -0.004, z0 + 0.012], new THREE.Euler(0, Math.PI * 0.5, 0)));
  } else {
    const precision = S.style === 'precision';
    const bodyW = precision ? 0.044 : 0.04;
    const body = chamferPoly(
      [
        [-bodyW * 0.5, -0.03],
        [bodyW * 0.5, -0.03],
        [bodyW * 0.5, 0.019],
        [bodyW * 0.34, 0.026],
        [-bodyW * 0.34, 0.026],
        [-bodyW * 0.5, 0.019],
      ],
      0.005,
      2
    );
    sink.pair(
      extrudeG(body, { axis: 'z', from: z0 + S.len * 0.24, to: z1 - 0.012 }),
      'polymer',
      'polymerEdge'
    );
    // Under-hook / sling slot.
    const hook = boxG(bodyW * 0.72, 0.016, 0.03, 0.004, 2);
    sink.pair(hook, 'polymer', 'polymerEdge', mCompose([0, -0.034, z0 + S.len * 0.42], new THREE.Euler(0.2, 0, 0)));
    // Buttplate + rubber pad.
    const plate = boxG(bodyW * 1.04, 0.072, 0.014, 0.005, 2);
    sink.pair(plate, 'polymer', 'polymerEdge', mCompose([0, -0.004, z1 - 0.004], new THREE.Euler(-0.11, 0, 0)));
    const pad = boxG(bodyW * 1.0, 0.07, 0.009, 0.004, 2);
    sink.pair(pad, 'rubber', 'rubber', mCompose([0, -0.004, z1 + 0.006], new THREE.Euler(-0.11, 0, 0)));
    if (S.cheek) {
      const cheek = boxG(bodyW * 0.86, 0.019, S.len * 0.44, 0.006, 2);
      sink.pair(cheek, 'polymer', 'polymerEdge', mCompose(
        [0, 0.031, z0 + S.len * 0.6],
        new THREE.Euler(precision ? -0.035 : -0.02, 0, 0)
      ));
      // Riser posts.
      for (const s of [1, -1]) {
        const post = latheG(
          [
            [0.0032, 0.0, 'hard'],
            [0.0032, 0.016],
          ],
          10
        );
        sink.pair(post, 'steelBright', 'steelBright', mCompose(
          [s * bodyW * 0.3, 0.021, z0 + S.len * 0.6],
          new THREE.Euler(Math.PI * 0.5, 0, 0)
        ));
      }
    }
    // Adjustment lever under the tube.
    const lever = boxG(0.01, 0.028, 0.026, 0.0025, 2);
    sink.pair(lever, 'polymer', 'polymerEdge', mCompose([0, -0.036, z0 + S.len * 0.3], new THREE.Euler(0.25, 0, 0)));
    // QD sling cup.
    const cup = latheG(
      [
        [0.006, -0.002, 'hard'],
        [0.006, 0.002],
        [0.0042, 0.003, 'hard edge'],
      ],
      12,
      { capEnd: true }
    );
    sink.pair(cup, 'phosphate', 'phosphateEdge', mCompose(
      [bodyW * 0.5, -0.012, z0 + S.len * 0.3],
      new THREE.Euler(0, Math.PI * 0.5, 0)
    ));
  }
}

/* ------------------------------ moving parts ------------------------------ */

function buildBoltCarrier(sink, b) {
  const R = b.receiver;
  const P = b.port;
  const zc = (P.z0 + P.z1) * 0.5;
  const carrier = latheG(
    [
      [0.0118, zc - 0.052, 'hard'],
      [0.0118, zc + 0.03],
      [0.0098, zc + 0.033, 'hard edge'],
      [0.0098, zc + 0.05],
    ],
    16,
    { capStart: true, capEnd: true }
  );
  sink.pair(carrier, 'steelDark', 'phosphateEdge', mTrans(0, 0.0012, 0));
  // Bolt face + extractor, visible in the port.
  const bolt = latheG(
    [
      [0.0072, zc - 0.062, 'hard'],
      [0.0072, zc - 0.05],
    ],
    14,
    { capStart: true }
  );
  sink.pair(bolt, 'steelBright', 'steelBright', mTrans(0, 0.0012, 0));
  const ext = boxG(0.005, 0.006, 0.014, 0.0009, 1);
  sink.pair(ext, 'steelBright', 'steelBright', mTrans(0.0078, 0.0035, zc - 0.056));
  // Cam pin boss on top.
  const cam = boxG(0.0075, 0.006, 0.012, 0.0012, 1);
  sink.pair(cam, 'phosphate', 'phosphateEdge', mTrans(0, 0.0125, zc - 0.026));
  void R;
}

function buildChargingHandle(sink, b) {
  const R = b.receiver;
  const z = R.z1 - 0.004;
  const shaft = boxG(0.03, 0.0075, 0.052, 0.0014, 1);
  sink.pair(shaft, 'anodised', 'anodisedEdge', mTrans(0, R.yTop - 0.0072, z - 0.024));
  const wing = boxG(0.02, 0.0125, 0.0085, 0.0018, 2);
  sink.pair(wing, 'anodised', 'anodisedEdge', mCompose([-0.0205, R.yTop - 0.0075, z + 0.002], new THREE.Euler(0, 0, 0.08)));
  const bar = boxG(0.05, 0.0092, 0.0085, 0.0016, 2);
  sink.pair(bar, 'anodised', 'anodisedEdge', mTrans(0, R.yTop - 0.0075, z + 0.002));
  // Serrations on the latch.
  for (let i = 0; i < 5; i++) {
    const s = plainBoxG(0.0014, 0.0092, 0.0016);
    sink.pair(s, 'anodisedEdge', 'anodisedEdge', mTrans(-0.0135 - i * 0.0032, R.yTop - 0.0075, z + 0.0055));
  }
}

/** Ejection-port cover. The group's origin is the hinge, placed by the caller. */
function buildDustCover(sink, b) {
  const P = b.port;
  const h = P.y1 - P.y0 + 0.001;
  const l = P.z1 - P.z0 + 0.002;
  const plate = boxG(0.0022, h, l, 0.0007, 1);
  sink.pair(plate, 'anodised', 'anodisedEdge', mTrans(0.0011, h * 0.5, 0));
  const hinge = latheG(
    [
      [0.0016, -l * 0.5, 'hard'],
      [0.0016, l * 0.5, 'hard'],
    ],
    8
  );
  sink.pair(hinge, 'steelBright', 'steelBright', mTrans(0.0012, 0, 0));
  const rib = boxG(0.0012, 0.0018, l * 0.86, 0.0004, 1);
  sink.pair(rib, 'anodisedEdge', 'anodisedEdge', mTrans(0.0026, h * 0.55, 0));
}

function buildTrigger(sink, b) {
  const g = b.grip;
  const z = g.z + 0.0165;
  const y = b.lower.yTop - 0.0125;
  const sec = rectSection(0.0058, 0.0034, 0.0012, 2);
  const path = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    path.push([0, y - 0.019 * t, z + 0.0052 * Math.sin(t * 2.2) - 0.0015 * t]);
  }
  sink.pair(sweepG(sec, path, { up: [1, 0, 0] }), 'steelDark', 'steelBright');
  // Trigger shoe serrations.
  for (let i = 0; i < 4; i++) {
    const s = plainBoxG(0.0056, 0.0009, 0.0011);
    sink.pair(s, 'steelBright', 'steelBright', mTrans(0, y - 0.0075 - i * 0.0034, z + 0.0048));
  }
}

function buildSelector(sink, b) {
  const L = b.lower;
  const z = b.grip.z + 0.0225;
  const y = L.yTop - 0.0062;
  for (const s of [1, -1]) {
    const boss = latheG(
      [
        [0.0058, 0, 'hard'],
        [0.0058, 0.0026],
        [0.0044, 0.0034, 'hard edge'],
      ],
      12,
      { capEnd: true }
    );
    sink.pair(boss, 'anodised', 'anodisedEdge', mCompose([s * (L.halfW - 0.0006), y, z], new THREE.Euler(0, s * Math.PI * 0.5, 0)));
    const lever = boxG(0.0055, 0.0225, 0.0072, 0.0014, 1);
    sink.pair(lever, 'phosphate', 'phosphateEdge', mCompose(
      [s * (L.halfW + 0.0035), y - 0.008, z],
      new THREE.Euler(0, 0, 0)
    ));
  }
}

function buildBoltCatch(sink, b) {
  const L = b.lower;
  const z = b.magwell.z1 + 0.012;
  const paddle = boxG(0.005, 0.011, 0.026, 0.0014, 1);
  sink.pair(paddle, 'phosphate', 'phosphateEdge', mCompose(
    [-(L.halfW + 0.0018), L.yTop - 0.0065, z],
    new THREE.Euler(0, 0, 0.1)
  ));
  const upper = boxG(0.005, 0.0085, 0.009, 0.0012, 1);
  sink.pair(upper, 'phosphate', 'phosphateEdge', mTrans(-(L.halfW + 0.0018), L.yTop - 0.0025, z + 0.019));
}

/* -------------------------------- magazine -------------------------------- */

function buildMagazine(group, followerNode, b, mats) {
  const M = b.mag;
  const sink = new Sink();
  const n = 9;
  const path = [];
  const R = M.curveR;
  // Sweep the body along a shallow arc: that curve is the single most recognisable
  // thing about a rifle magazine.
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const s = t * M.len;
    const a = s / R;
    // The toe of the magazine swings *forward*, toward the muzzle (−Z).
    path.push([0, M.yTop - s * Math.cos(a * 0.5), M.z - R * (1 - Math.cos(a))]);
  }
  const sec = chamferPoly(
    [
      [-M.w * 0.5, -M.d * 0.5],
      [M.w * 0.5, -M.d * 0.5],
      [M.w * 0.5, M.d * 0.5],
      [-M.w * 0.5, M.d * 0.5],
    ],
    0.0035,
    2
  );
  const scales = [];
  for (let i = 0; i <= n; i++) scales.push(1 - 0.02 * (i / n));
  sink.pair(sweepG(sec, path, { up: [0, 0, 1], scales }), 'polymer', 'polymerEdge');

  // Feed lips.
  const lips = boxG(M.w * 1.02, 0.009, M.d * 1.04, 0.0018, 2);
  sink.pair(lips, 'anodised', 'anodisedEdge', mTrans(0, M.yTop + 0.0035, M.z));
  // Baseplate.
  const last = path[path.length - 1];
  const bp = boxG(M.w * 1.14, 0.0105, M.d * 1.18, 0.0026, 2);
  sink.pair(bp, 'polymer', 'polymerEdge', mCompose([0, last[1] - 0.003, last[2]], new THREE.Euler(M.len / R, 0, 0)));
  const bpGrip = boxG(M.w * 1.02, 0.005, M.d * 0.5, 0.0015, 1);
  sink.pair(bpGrip, 'rubber', 'rubber', mCompose([0, last[1] - 0.01, last[2]], new THREE.Euler(M.len / R, 0, 0)));

  // Witness holes: a recessed dark port with a bright rim, one per round count.
  for (let i = 0; i < (M.witness || 4); i++) {
    const t = 0.24 + (i / Math.max(1, M.witness - 1)) * 0.56;
    const idx = Math.min(n, Math.round(t * n));
    const p = path[idx];
    for (const s of [1, -1]) {
      const hole = latheG(
        [
          [0.0028, 0, 'hard'],
          [0.0028, 0.0016],
        ],
        10,
        { capEnd: true }
      );
      sink.pair(hole, 'bore', 'bore', mCompose(
        [s * (M.w * 0.5 - 0.0012), p[1], p[2]],
        new THREE.Euler(0, s * Math.PI * 0.5, 0)
      ));
      const rim = latheG(
        [
          [0.0034, -0.0004, 'hard'],
          [0.0038, 0.0002, 'hard edge'],
        ],
        10
      );
      sink.pair(rim, 'polymerEdge', 'polymerEdge', mCompose(
        [s * (M.w * 0.5 - 0.0004), p[1], p[2]],
        new THREE.Euler(0, s * Math.PI * 0.5, 0)
      ));
    }
  }
  // Longitudinal reinforcing ribs.
  for (const s of [1, -1]) {
    const rib = sweepG(rectSection(0.0022, 0.0016, 0.0005, 1), path.map((p) => [s * (M.w * 0.5 - 0.0006), p[1], p[2]]), {
      up: [0, 0, 1],
    });
    sink.pair(rib, 'polymerEdge', 'polymerEdge');
  }

  for (const m of sink.meshes(mats, 'mag')) group.add(m);

  // Follower + top cartridge, animated when the mag empties.
  const fs = new Sink();
  const fol = boxG(M.w * 0.82, 0.006, M.d * 0.8, 0.0012, 1);
  fs.pair(fol, 'polymerEdge', 'polymerEdge');
  const rnd = latheG(
    [
      [M.d * 0.19, -0.012, 'hard'],
      [M.d * 0.19, 0.006],
      [M.d * 0.15, 0.011],
      [M.d * 0.06, 0.017],
    ],
    12,
    { capStart: true }
  );
  fs.pair(rnd, 'brass', 'brass', mCompose([0, 0.006, 0], new THREE.Euler(0, Math.PI * 0.5, 0)));
  for (const m of fs.meshes(mats, 'follower')) followerNode.add(m);
  followerNode.position.set(0, M.yTop - 0.006, M.z);
}

/* ========================================================================== */
/*                                   optics                                   */
/* ========================================================================== */

/**
 * Reflex sight. The tube, hood and mount are real geometry; the front element is a
 * curved glass surface with a fresnel + AR-coating shader, and the reticle is a
 * separate emissive quad that the weapon system re-projects every frame so it stays
 * collimated at infinity (moving your eye off-axis walks it across the glass exactly
 * the way a real red dot does).
 */
export function buildRedDot(ctx, mats, o = {}) {
  const group = new THREE.Group();
  group.name = 'optic:reddot';
  const sink = new Sink();
  const tubeR = o.tubeR ?? 0.0182;
  const glassR = o.glassR ?? 0.0142;
  const zF = -(o.length ?? 0.086) * 0.5;
  const zB = (o.length ?? 0.086) * 0.5;
  const mountH = o.mountH ?? 0.0135;
  const axisY = mountH + tubeR;

  // Mount: a rail clamp with a cross-bolt and a throw lever.
  const clamp2 = chamferPoly(
    [
      [-0.0142, 0],
      [0.0142, 0],
      [0.0142, mountH],
      [-0.0142, mountH],
    ],
    0.0018,
    2
  );
  sink.pair(extrudeG(clamp2, { axis: 'z', from: zF + 0.012, to: zB - 0.012 }), 'anodised', 'anodisedEdge');
  const recoilLug = boxG(0.0092, 0.005, 0.005, 0.0008, 1);
  sink.pair(recoilLug, 'anodised', 'anodisedEdge', mTrans(0, 0.0018, 0));
  const lever = boxG(0.0032, 0.0135, 0.023, 0.0012, 2);
  sink.pair(lever, 'phosphate', 'phosphateEdge', mCompose([-0.0158, mountH * 0.55, 0.004], new THREE.Euler(0, 0, -0.12)));
  const bolt = latheG(
    [
      [0.0026, -0.017, 'hard'],
      [0.0026, 0.017, 'hard'],
    ],
    10,
    { capStart: true, capEnd: true }
  );
  sink.pair(bolt, 'steelBright', 'steelBright', mCompose([0, mountH * 0.5, 0], new THREE.Euler(0, Math.PI * 0.5, 0)));

  // Tube body with a hood over the objective.
  const tube = latheG(
    [
      [tubeR, zF, 'hard'],
      [tubeR, zF + 0.008],
      [tubeR * 0.94, zF + 0.011, 'hard edge'],
      [tubeR * 0.94, zB - 0.012],
      [tubeR, zB - 0.009, 'hard edge'],
      [tubeR, zB, 'hard'],
    ],
    22
  );
  sink.pair(tube, 'anodised', 'anodisedEdge', mTrans(0, axisY, 0));
  // Interior — matte black so the reticle has something to sit against.
  const bore = latheG(
    [
      [glassR + 0.0012, zF + 0.001, 'hard'],
      [glassR + 0.0012, zB - 0.001, 'hard'],
    ],
    22
  );
  sink.pair(bore, 'bore', 'bore', mTrans(0, axisY, 0));
  // Front and rear bezels (annuli closing the tube around the glass).
  sink.add('anodisedEdge', discG(tubeR * 0.99, zF + 0.0015, -1, 22, glassR), mTrans(0, axisY, 0));
  sink.add('anodisedEdge', discG(tubeR * 0.99, zB - 0.0015, 1, 22, glassR), mTrans(0, axisY, 0));

  // Hood ribs over the objective.
  for (let i = 0; i < 3; i++) {
    const rib = latheG(
      [
        [tubeR * 1.03, zF + 0.002 + i * 0.0045, 'hard'],
        [tubeR * 1.07, zF + 0.0035 + i * 0.0045, 'hard edge'],
        [tubeR * 1.03, zF + 0.005 + i * 0.0045, 'hard'],
      ],
      22
    );
    sink.pair(rib, 'anodised', 'anodisedEdge', mTrans(0, axisY, 0));
  }

  // Turrets: elevation on top, windage on the right.
  const turret = (rot, pos) => {
    const t = latheG(
      [
        [0.0072, 0, 'hard'],
        [0.0072, 0.0055],
        [0.0062, 0.0062, 'hard edge'],
        [0.0062, 0.0092],
        [0.0048, 0.0098, 'hard edge'],
      ],
      14,
      { capEnd: true }
    );
    sink.pair(t, 'anodised', 'anodisedEdge', mCompose(pos, rot));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      const kn = plainBoxG(0.0011, 0.0011, 0.0055);
      const m = new THREE.Matrix4()
        .makeRotationZ(a)
        .premultiply(new THREE.Matrix4().makeTranslation(0, 0, 0.0072));
      const local = new THREE.Matrix4().makeTranslation(0.0062 * Math.cos(a), 0.0062 * Math.sin(a), 0.0035);
      void m;
      sink.pair(kn, 'anodisedEdge', 'anodisedEdge', new THREE.Matrix4().multiplyMatrices(mCompose(pos, rot), local));
    }
  };
  turret(new THREE.Euler(Math.PI * 0.5, 0, 0), [0, axisY + tubeR * 0.86, 0.006]);
  turret(new THREE.Euler(0, -Math.PI * 0.5, 0), [tubeR * 0.86, axisY, 0.006]);
  // Battery cap on the left.
  const cap = latheG(
    [
      [0.0068, 0, 'hard'],
      [0.0068, 0.0042],
      [0.0055, 0.005, 'hard edge'],
    ],
    14,
    { capEnd: true }
  );
  sink.pair(cap, 'anodised', 'anodisedEdge', mCompose([-tubeR * 0.9, axisY, -0.004], new THREE.Euler(0, Math.PI * 0.5, 0)));

  for (const m of sink.meshes(mats, 'reddot')) group.add(m);

  /* glass */
  const gmat = mats._optics.glass.clone();
  gmat.uniforms = THREE.UniformsUtils.clone(mats._optics.glass.uniforms);
  gmat.uniforms.uRadius.value = glassR;
  gmat.uniforms.uTint.value.setRGB(0.1, 0.34, 0.3);
  const front = new THREE.Mesh(lensG(glassR, 0.0016, -1, 4, 26), gmat);
  front.position.set(0, axisY, zF + 0.005);
  front.renderOrder = 10; // far -> near: front element, reticle, ocular element
  front.frustumCulled = false;
  group.add(front);
  const rearMat = gmat.clone();
  rearMat.uniforms = THREE.UniformsUtils.clone(gmat.uniforms);
  rearMat.uniforms.uBase.value = 0.028;
  rearMat.uniforms.uFresnel.value = 0.5;
  const rear = new THREE.Mesh(lensG(glassR, 0.0008, 1, 3, 26), rearMat);
  rear.position.set(0, axisY, zB - 0.005);
  rear.renderOrder = 12;
  rear.frustumCulled = false;
  group.add(rear);

  /* reticle */
  const rmat = mats._optics.reticle.clone();
  rmat.uniforms = THREE.UniformsUtils.clone(mats._optics.reticle.uniforms);
  rmat.uniforms.uSize.value = o.dotMoa ? o.dotMoa * 0.0016 : 0.0028;
  rmat.uniforms.uRing.value = o.ring ? 3.6 : 0;
  rmat.uniforms.uColor.value.setRGB(1.0, 0.09, 0.03);
  const quad = new THREE.PlaneGeometry(glassR * 1.9, glassR * 1.9);
  const reticle = new THREE.Mesh(quad, rmat);
  reticle.frustumCulled = false;
  reticle.renderOrder = 11;
  group.add(reticle);

  const sight = new THREE.Object3D();
  sight.position.set(0, axisY, zB - 0.006);
  group.add(sight);

  return {
    group,
    sight,
    reticle,
    reticleMat: rmat,
    glass: [gmat, rearMat],
    kind: 'reflex',
    axisY,
    planeZ: zF + 0.012,
    // Apparent angular size of the dot core. A true 2 MOA dot is sub-pixel at any
    // sane render resolution; this is the size a real one *reads* as, glow included.
    dotRad: o.dotRad ?? (o.ring ? 0.0052 : 0.0036),
    zoom: 1.0,
    height: axisY,
  };
}

/**
 * Magnified optic. The image disc is a shader that either shows a live
 * picture-in-picture render (fed by WeaponSystem) or a physically-derived
 * sky/ground fallback, with pincushion, chromatic fringing, a duplex reticle and a
 * proper eyebox: a few millimetres off-axis crescents the image, more blacks it out.
 */
export function buildScope(ctx, mats, o = {}) {
  const group = new THREE.Group();
  group.name = 'optic:scope';
  const sink = new Sink();
  const objR = o.objR ?? 0.0235;
  const ocR = o.ocR ?? 0.0195;
  const tubeR = o.tubeR ?? 0.0155;
  const len = o.length ?? 0.196;
  const zF = -len * 0.55;
  const zB = len * 0.45;
  const mountH = o.mountH ?? 0.0165;
  const axisY = mountH + tubeR + 0.006;

  // Two-ring mount.
  for (const z of [zF + len * 0.3, zB - len * 0.22]) {
    const base = boxG(0.0295, mountH, 0.019, 0.002, 2);
    sink.pair(base, 'anodised', 'anodisedEdge', mTrans(0, mountH * 0.5, z));
    const ring = latheG(
      [
        [tubeR * 1.16, -0.0095, 'hard'],
        [tubeR * 1.16, 0.0095, 'hard'],
      ],
      18,
      { capStart: true, capEnd: true }
    );
    sink.pair(ring, 'anodised', 'anodisedEdge', mTrans(0, axisY, z));
    for (const s of [1, -1]) {
      const scr = latheG(
        [
          [0.0022, 0, 'hard'],
          [0.0022, 0.004],
          [0.0032, 0.0045, 'hard edge'],
        ],
        8,
        { capEnd: true }
      );
      sink.pair(scr, 'steelBright', 'steelBright', mCompose(
        [s * tubeR * 1.05, axisY - tubeR * 0.72, z],
        new THREE.Euler(0, 0, s > 0 ? -0.9 : 0.9)
      ));
    }
  }

  const body = latheG(
    [
      [objR, zF, 'hard'],
      [objR, zF + 0.024],
      [objR * 0.94, zF + 0.028, 'hard edge'],
      [tubeR, zF + 0.05],
      [tubeR, zF + 0.086],
      [tubeR * 1.2, zF + 0.09, 'hard edge'],
      [tubeR * 1.2, zF + 0.108],
      [tubeR, zF + 0.112, 'hard edge'],
      [tubeR, zB - 0.05],
      [ocR * 0.9, zB - 0.03, 'hard edge'],
      [ocR, zB - 0.02],
      [ocR, zB - 0.004],
      [ocR * 0.93, zB, 'hard edge'],
    ],
    24
  );
  sink.pair(body, 'anodised', 'anodisedEdge', mTrans(0, axisY, 0));
  sink.pair(
    latheG(
      [
        [tubeR * 0.92, zF + 0.03, 'hard'],
        [tubeR * 0.92, zB - 0.02, 'hard'],
      ],
      22
    ),
    'bore',
    'bore',
    mTrans(0, axisY, 0)
  );
  sink.add('anodisedEdge', discG(objR * 0.99, zF + 0.003, -1, 24, objR * 0.82), mTrans(0, axisY, 0));

  // Magnification ring knurling.
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * TAU;
    const kn = plainBoxG(0.0014, 0.0014, 0.016);
    sink.pair(kn, 'anodisedEdge', 'anodisedEdge', mTrans(
      Math.cos(a) * tubeR * 1.2,
      axisY + Math.sin(a) * tubeR * 1.2,
      zF + 0.099
    ));
  }
  // Turrets.
  for (const [rot, pos] of [
    [new THREE.Euler(Math.PI * 0.5, 0, 0), [0, axisY + tubeR * 0.9, zF + 0.062]],
    [new THREE.Euler(0, -Math.PI * 0.5, 0), [tubeR * 0.9, axisY, zF + 0.062]],
  ]) {
    const t = latheG(
      [
        [0.0105, 0, 'hard'],
        [0.0105, 0.006],
        [0.0088, 0.0068, 'hard edge'],
        [0.0088, 0.017],
        [0.0072, 0.0178, 'hard edge'],
      ],
      16,
      { capEnd: true }
    );
    sink.pair(t, 'anodised', 'anodisedEdge', mCompose(pos, rot));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const kn = plainBoxG(0.0013, 0.0013, 0.009);
      const local = new THREE.Matrix4().makeTranslation(0.0088 * Math.cos(a), 0.0088 * Math.sin(a), 0.0115);
      sink.pair(kn, 'anodisedEdge', 'anodisedEdge', new THREE.Matrix4().multiplyMatrices(mCompose(pos, rot), local));
    }
  }
  // Rubber eyepiece ring and a killflash-ish objective shade.
  sink.pair(
    latheG(
      [
        [ocR * 1.02, zB - 0.004, 'hard'],
        [ocR * 1.02, zB + 0.006],
        [ocR * 0.9, zB + 0.008, 'hard edge'],
      ],
      20,
      { capEnd: true }
    ),
    'rubber',
    'rubber',
    mTrans(0, axisY, 0)
  );

  for (const m of sink.meshes(mats, 'scope')) group.add(m);

  const imgMat = mats._optics.scope.clone();
  imgMat.uniforms = THREE.UniformsUtils.clone(mats._optics.scope.uniforms);
  imgMat.uniforms.uRadius.value = ocR * 0.82;
  const image = new THREE.Mesh(new THREE.CircleGeometry(ocR * 0.82, 34), imgMat);
  image.position.set(0, axisY, zB - 0.016);
  image.frustumCulled = false;
  group.add(image);

  const gmat = mats._optics.glass.clone();
  gmat.uniforms = THREE.UniformsUtils.clone(mats._optics.glass.uniforms);
  gmat.uniforms.uRadius.value = ocR * 0.84;
  gmat.uniforms.uBase.value = 0.02;
  gmat.uniforms.uFresnel.value = 0.62;
  gmat.uniforms.uTint.value.setRGB(0.32, 0.16, 0.4);
  const oc = new THREE.Mesh(lensG(ocR * 0.84, 0.0009, 1, 3, 26), gmat);
  oc.position.set(0, axisY, zB - 0.0125);
  oc.renderOrder = 12;
  oc.frustumCulled = false;
  group.add(oc);

  const objMat = gmat.clone();
  objMat.uniforms = THREE.UniformsUtils.clone(gmat.uniforms);
  objMat.uniforms.uRadius.value = objR * 0.82;
  objMat.uniforms.uTint.value.setRGB(0.14, 0.36, 0.28);
  objMat.uniforms.uBase.value = 0.05;
  const obj = new THREE.Mesh(lensG(objR * 0.82, 0.0022, -1, 4, 26), objMat);
  obj.position.set(0, axisY, zF + 0.008);
  obj.renderOrder = 12;
  obj.frustumCulled = false;
  group.add(obj);

  const sight = new THREE.Object3D();
  sight.position.set(0, axisY, zB - 0.014);
  group.add(sight);

  return {
    group,
    sight,
    image,
    imageMat: imgMat,
    glass: [gmat, objMat],
    kind: 'scope',
    axisY,
    zoom: o.zoom ?? 3.4,
    eyeboxRadius: o.eyebox ?? 0.012,
    height: axisY,
  };
}

/** Folding back-up iron sights — the default when no optic is fitted. */
export function buildIrons(ctx, mats, o = {}) {
  const group = new THREE.Group();
  const sink = new Sink();
  const h = o.height ?? 0.0335;
  // Rear aperture.
  const base = boxG(0.0225, 0.006, 0.017, 0.0012, 1);
  sink.pair(base, 'phosphate', 'phosphateEdge', mTrans(0, 0.003, 0.028));
  const ear = latheG(
    [
      [0.0072, -0.0016, 'hard'],
      [0.0072, 0.0016, 'hard'],
    ],
    16,
    { capStart: true, capEnd: true }
  );
  sink.pair(ear, 'phosphate', 'phosphateEdge', mTrans(0, h - 0.006, 0.028));
  const ap = latheG(
    [
      [0.0028, -0.0018, 'hard'],
      [0.0028, 0.0018, 'hard'],
    ],
    14
  );
  sink.pair(ap, 'bore', 'bore', mTrans(0, h - 0.006, 0.028));
  // Front post + hood.
  const fbase = boxG(0.019, 0.005, 0.014, 0.001, 1);
  sink.pair(fbase, 'phosphate', 'phosphateEdge', mTrans(0, 0.0025, -0.145));
  for (const s of [1, -1]) {
    const wing = boxG(0.0032, h * 0.95, 0.012, 0.0009, 1);
    sink.pair(wing, 'phosphate', 'phosphateEdge', mTrans(s * 0.0072, h * 0.5, -0.145));
  }
  const post = boxG(0.0022, h * 0.82, 0.0026, 0.0005, 1);
  sink.pair(post, 'steelBright', 'steelBright', mTrans(0, h * 0.44, -0.145));
  for (const m of sink.meshes(mats, 'irons')) group.add(m);
  const sight = new THREE.Object3D();
  sight.position.set(0, h - 0.006, 0.028);
  group.add(sight);
  return { group, sight, kind: 'irons', axisY: h - 0.006, zoom: 1.0, height: h - 0.006 };
}

/* ---------------------------- muzzle & underbarrel ------------------------ */

export function buildMuzzleDevice(ctx, mats, spec = {}) {
  const group = new THREE.Group();
  const sink = new Sink();
  const style = spec.style || 'brake';
  const r = spec.r ?? 0.0142;
  const len = spec.len ?? 0.05;

  if (style === 'suppressor') {
    const L = spec.len ?? 0.16;
    sink.pair(
      latheG(
        [
          [r * 0.72, 0.002, 'hard'],
          [r * 0.88, -0.004, 'hard edge'],
          [r, -0.012],
          [r, -L + 0.016],
          [r * 0.9, -L + 0.006, 'hard edge'],
          [r * 0.9, -L],
        ],
        22,
        { capEnd: true }
      ),
      'phosphate',
      'phosphateEdge'
    );
    sink.add('bore', discG(r * 0.86, -L - 0.0002, -1, 20, r * 0.3), null);
    // Heat-shield flutes.
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      const fl = latheG(
        [
          [r * 1.012, -0.02, 'hard'],
          [r * 1.012, -L + 0.02, 'hard'],
        ],
        3,
        { phiStart: -0.1, phiLength: 0.2 }
      );
      sink.pair(fl, 'steelDark', 'steelDark', new THREE.Matrix4().makeRotationZ(a));
    }
    // Mounting collar.
    sink.pair(
      latheG(
        [
          [r * 1.06, -0.002, 'hard'],
          [r * 1.06, -0.016],
          [r * 0.98, -0.019, 'hard edge'],
        ],
        20
      ),
      'anodised',
      'anodisedEdge'
    );
  } else if (style === 'comp') {
    sink.pair(
      latheG(
        [
          [r * 0.66, 0.004, 'hard'],
          [r * 0.82, -0.001, 'hard edge'],
          [r, -0.006],
          [r, -len + 0.005],
          [r * 0.88, -len, 'hard edge'],
        ],
        20,
        { capEnd: true }
      ),
      'phosphate',
      'phosphateEdge'
    );
    sink.add('bore', discG(r * 0.82, -len - 0.0002, -1, 18, r * 0.26), null);
    for (let i = 0; i < (spec.ports || 4); i++) {
      const z = -0.012 - i * ((len - 0.018) / Math.max(1, spec.ports || 4));
      const cut = plainBoxG(r * 2.2, r * 0.55, 0.0038);
      sink.pair(cut, 'bore', 'bore', mTrans(0, r * 0.62, z));
    }
  } else if (style === 'thread') {
    sink.pair(
      latheG(
        [
          [r * 0.72, 0.002, 'hard'],
          [r * 0.86, -0.002, 'hard edge'],
          [r * 0.86, -len],
        ],
        18,
        { capEnd: true }
      ),
      'phosphate',
      'phosphateEdge'
    );
    sink.add('bore', discG(r * 0.8, -len - 0.0002, -1, 16, r * 0.3), null);
  } else {
    // 3-port brake with a crenellated crown.
    sink.pair(
      latheG(
        [
          [r * 0.68, 0.005, 'hard'],
          [r * 0.86, 0.0, 'hard edge'],
          [r, -0.006],
          [r, -len + 0.006],
          [r * 0.9, -len, 'hard edge'],
        ],
        20,
        { capEnd: true }
      ),
      'phosphate',
      'phosphateEdge'
    );
    sink.add('bore', discG(r * 0.84, -len - 0.0002, -1, 18, r * 0.28), null);
    const n = spec.ports || 3;
    for (let i = 0; i < n; i++) {
      const z = -0.011 - i * ((len - 0.02) / n);
      for (const s of [1, -1]) {
        const cut = plainBoxG(r * 0.9, r * 1.5, 0.0042);
        sink.pair(cut, 'bore', 'bore', mCompose([s * r * 0.72, 0.0, z], new THREE.Euler(0, 0, s * 0.35)));
      }
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.3;
      const tooth = boxG(0.0022, 0.0045, 0.0055, 0.0005, 1);
      sink.pair(tooth, 'phosphateEdge', 'phosphateEdge', mTrans(
        Math.cos(a) * r * 0.82,
        Math.sin(a) * r * 0.82,
        -len + 0.0025
      ));
    }
  }
  for (const m of sink.meshes(mats, 'muzzle')) group.add(m);
  const tip = new THREE.Object3D();
  tip.position.set(0, 0, -(style === 'suppressor' ? spec.len ?? 0.16 : len) - 0.004);
  group.add(tip);
  return { group, tip, style };
}

export function buildForegrip(ctx, mats, spec = {}) {
  const group = new THREE.Group();
  const sink = new Sink();
  if (spec.style === 'angled') {
    const sec = chamferPoly(
      [
        [-0.014, 0],
        [0.014, 0],
        [0.012, -0.05],
        [-0.012, -0.05],
      ],
      0.0035,
      2
    );
    sink.pair(extrudeG(sec, { axis: 'z', from: -0.028, to: 0.028 }), 'polymer', 'polymerEdge');
    for (let i = 0; i < 5; i++) {
      const rib = plainBoxG(0.03, 0.0022, 0.0035);
      sink.pair(rib, 'polymerEdge', 'polymerEdge', mCompose([0, -0.008 - i * 0.0085, -0.016 + i * 0.006], new THREE.Euler(0.5, 0, 0)));
    }
  } else {
    sink.pair(
      latheG(
        [
          [0.016, 0.0, 'hard'],
          [0.016, -0.006],
          [0.0135, -0.012, 'hard edge'],
          [0.0128, -0.058],
          [0.0152, -0.066, 'hard edge'],
          [0.0138, -0.072],
        ],
        16,
        { capEnd: true }
      ),
      'polymer',
      'polymerEdge',
      new THREE.Matrix4().makeRotationX(Math.PI * 0.5)
    );
    for (let i = 0; i < 6; i++) {
      const ring = latheG(
        [
          [0.0141, -0.016 - i * 0.0075, 'hard'],
          [0.0128, -0.0195 - i * 0.0075, 'hard'],
        ],
        14
      );
      sink.pair(ring, 'polymerEdge', 'polymerEdge', new THREE.Matrix4().makeRotationX(Math.PI * 0.5));
    }
    const clampBlk = boxG(0.026, 0.011, 0.03, 0.0018, 2);
    sink.pair(clampBlk, 'polymer', 'polymerEdge', mTrans(0, 0.0032, 0));
  }
  for (const m of sink.meshes(mats, 'foregrip')) group.add(m);
  return { group };
}

/* ========================================================================== */
/*                                arms & hands                                */
/* ========================================================================== */

/**
 * A gloved hand. Local frame: +X across the palm from index to little finger,
 * +Y wrist -> knuckles, +Z out of the palm. `s` mirrors it for the left hand.
 * The index finger keeps live joints so the trigger finger can be indexed along
 * the receiver when the trigger is not being pressed.
 */
function buildHand(mats, side, o = {}) {
  const s = side === 'left' ? -1 : 1;
  const root = new THREE.Group();
  root.name = `hand:${side}`;
  const sink = new Sink();

  const palmW = 0.084;
  const palmL = 0.093;
  const palmT = 0.031;
  const palm = boxG(palmW, palmL, palmT, 0.011, 2);
  sink.pair(palm, 'glove', 'glove', mTrans(0, palmL * 0.5, 0));
  // Thenar (thumb muscle) pad and the heel of the hand.
  const thenar = boxG(0.03, 0.05, 0.026, 0.011, 2);
  sink.pair(thenar, 'glove', 'glove', mCompose([-s * 0.026, 0.03, -0.003], new THREE.Euler(0, 0, s * 0.1)));
  const heel = boxG(palmW * 0.92, 0.024, palmT * 0.92, 0.01, 2);
  sink.pair(heel, 'glove', 'glove', mTrans(0, 0.006, -0.001));
  // Knuckle pads on the back of the hand.
  const backPad = boxG(palmW * 0.86, 0.05, 0.006, 0.0035, 2);
  sink.pair(backPad, 'glovePad', 'glovePad', mTrans(0, palmL * 0.62, palmT * 0.5 - 0.001));
  // Cuff.
  const cuff = latheG(
    [
      [0.036, -0.004, 'hard'],
      [0.038, -0.016, 'hard edge'],
      [0.037, -0.03],
    ],
    16
  );
  sink.pair(cuff, 'glovePad', 'glovePad', mCompose([0, 0, 0], new THREE.Euler(-Math.PI * 0.5, 0, 0), [1, 0.78, 1]));

  const FINGERS = [
    { x: -0.0295, len: [0.041, 0.027, 0.0205], r: [0.0102, 0.0092, 0.0082], splay: 0.1 },
    { x: -0.0098, len: [0.046, 0.031, 0.0215], r: [0.0104, 0.0094, 0.0084], splay: 0.03 },
    { x: 0.0098, len: [0.042, 0.029, 0.0205], r: [0.0098, 0.0089, 0.008], splay: -0.04 },
    { x: 0.0292, len: [0.033, 0.022, 0.0175], r: [0.0086, 0.0078, 0.007], splay: -0.13 },
  ];

  const makeFinger = (f, curls, target, keyed) => {
    let node = new THREE.Group();
    node.position.set(s * f.x, palmL - 0.004, 0.002);
    node.rotation.z = -s * f.splay;
    target.add(node);
    const joints = [node];
    for (let i = 0; i < 3; i++) {
      const j = new THREE.Group();
      j.rotation.x = -curls[i];
      node.add(j);
      const seg = boxG(f.r[i] * 2, f.len[i], f.r[i] * 1.86, f.r[i] * 0.82, 1);
      if (keyed) {
        const ss = new Sink();
        ss.pair(seg, 'glove', 'glove', mTrans(0, f.len[i] * 0.5, 0));
        if (i < 2) {
          const pad = boxG(f.r[i] * 1.6, f.len[i] * 0.5, 0.0026, 0.0009, 1);
          ss.pair(pad, 'glovePad', 'glovePad', mTrans(0, f.len[i] * 0.55, f.r[i] * 0.9));
        }
        for (const m of ss.meshes(mats, 'finger')) j.add(m);
      } else {
        const mtx = new THREE.Matrix4();
        j.updateMatrixWorld(true);
        // Bake into hand space.
        j.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3());
        mtx.copy(worldRelativeTo(j, root));
        sink.pair(seg, 'glove', 'glove', new THREE.Matrix4().multiplyMatrices(mtx, mTrans(0, f.len[i] * 0.5, 0)));
        if (i < 2) {
          const pad = boxG(f.r[i] * 1.6, f.len[i] * 0.5, 0.0026, 0.0009, 1);
          sink.pair(pad, 'glovePad', 'glovePad', new THREE.Matrix4().multiplyMatrices(mtx, mTrans(0, f.len[i] * 0.55, f.r[i] * 0.9)));
        }
      }
      const nxt = new THREE.Group();
      nxt.position.set(0, f.len[i], 0);
      j.add(nxt);
      joints.push(j);
      node = nxt;
    }
    return joints;
  };

  const curl = o.curl ?? [1.05, 1.15, 0.75];
  const idxCurl = o.indexCurl ?? curl;
  const holder = new THREE.Group();
  root.add(holder);

  const indexJoints = makeFinger(FINGERS[0], idxCurl, holder, true);
  for (let i = 1; i < 4; i++) {
    const c = [curl[0] * (1 + 0.03 * i), curl[1] * (1 + 0.02 * i), curl[2]];
    makeFinger(FINGERS[i], c, holder, false);
  }

  // Thumb: two phalanges, rotated out of the palm plane.
  {
    const tn = new THREE.Group();
    tn.position.set(-s * 0.036, 0.036, 0.006);
    tn.rotation.set(-(o.thumb?.[0] ?? 0.35), s * (o.thumbYaw ?? 0.55), s * (o.thumbRoll ?? -0.55));
    root.add(tn);
    let cur = tn;
    const tl = [0.037, 0.031];
    const tr = [0.0128, 0.0108];
    for (let i = 0; i < 2; i++) {
      const j = new THREE.Group();
      j.rotation.x = -(o.thumb?.[i + 1] ?? 0.5);
      cur.add(j);
      const seg = boxG(tr[i] * 2, tl[i], tr[i] * 1.86, tr[i] * 0.8, 1);
      const mtx = worldRelativeTo(j, root);
      sink.pair(seg, 'glove', 'glove', new THREE.Matrix4().multiplyMatrices(mtx, mTrans(0, tl[i] * 0.5, 0)));
      const nxt = new THREE.Group();
      nxt.position.set(0, tl[i], 0);
      j.add(nxt);
      cur = nxt;
    }
    root.remove(tn);
  }

  for (const m of sink.meshes(mats, `hand_${side}`)) root.add(m);
  return { root, indexJoints, side };
}

/** Local matrix of `obj` expressed in `ancestor` space (both must be in one tree). */
function worldRelativeTo(obj, ancestor) {
  const m = new THREE.Matrix4();
  const chain = [];
  let o = obj;
  while (o && o !== ancestor) {
    chain.push(o);
    o = o.parent;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    chain[i].updateMatrix();
    m.multiply(chain[i].matrix);
  }
  return m;
}

/** Forearm in a rolled sleeve, pointing back along -Y from the wrist. */
function buildForearm(mats, side) {
  const g = new THREE.Group();
  const sink = new Sink();
  const s = side === 'left' ? -1 : 1;
  sink.pair(
    latheG(
      [
        [0.036, 0.004, 'hard'],
        [0.0405, -0.03],
        [0.049, -0.11],
        [0.055, -0.2],
        [0.052, -0.235, 'hard'],
      ],
      16,
      { capEnd: true }
    ),
    'sleeve',
    'sleeve',
    mCompose([0, 0, 0], new THREE.Euler(-Math.PI * 0.5, 0, 0), [1, 0.86, 1])
  );
  // Rolled cuff at the wrist.
  sink.pair(
    latheG(
      [
        [0.038, 0.006, 'hard'],
        [0.0435, -0.006, 'hard edge'],
        [0.0435, -0.03],
        [0.0398, -0.038, 'hard edge'],
      ],
      16
    ),
    'sleeve',
    'sleeve',
    mCompose([0, 0, 0], new THREE.Euler(-Math.PI * 0.5, 0, 0), [1, 0.86, 1])
  );
  // Strap detail.
  const strap = boxG(0.078, 0.012, 0.006, 0.002, 1);
  sink.pair(strap, 'glovePad', 'glovePad', mTrans(0, -0.052, s * 0.0));
  for (const m of sink.meshes(mats, `arm_${side}`)) g.add(m);
  return g;
}

/**
 * Both arms, already oriented onto the weapon: the firing hand wraps the pistol
 * grip with the trigger finger indexed along the receiver, the support hand takes
 * the handguard from underneath with the thumb over the top.
 */
export function buildArms(ctx, mats, def) {
  const b = def.build;
  const g = b.grip;
  const out = {};

  /* --- right (firing) hand -------------------------------------------------
   * The web of the hand sits on the backstrap and the knuckles come round to the
   * front strap, so wrist -> knuckles runs forward and a little up, and the back of
   * the hand faces out to the right. The index finger and thumb are on the −X side
   * of the hand's own frame, which lands them on top — where they belong.
   */
  const rRig = new THREE.Group();
  rRig.name = 'rig:right';
  const right = buildHand(mats, 'right', {
    curl: [1.26, 1.42, 0.78],
    indexCurl: [0.12, 0.06, 0.04],
    thumb: [0.5, 0.72, 0.55],
    thumbYaw: 0.62,
    thumbRoll: -0.5,
  });
  const rHand = new THREE.Group();
  rHand.add(right.root);
  orientTo(rHand, [0.86, 0.42, -0.28], [-0.35, 0.12, -0.93]);
  // Knuckles just off the front strap, on the right.
  const gt = 0.36;
  const gx = Math.sin(g.angle);
  const gyd = -Math.cos(g.angle);
  const px = 0;
  const py = g.y + gyd * g.len * gt;
  const pz = g.z + gx * g.len * gt;
  const frontN = [0, -Math.sin(g.angle), -Math.cos(g.angle)];
  const knuck = [
    px + g.w * 0.36,
    py + frontN[1] * (g.d * 0.5 + 0.008),
    pz + frontN[2] * (g.d * 0.5 + 0.008),
  ];
  rHand.position.set(knuck[0] + 0.0326, knuck[1] - 0.0112, knuck[2] + 0.0865);
  rRig.add(rHand);
  const rArm = buildForearm(mats, 'right');
  rArm.position.copy(rHand.position);
  aimNode(rArm, [0.3, -0.56, 0.77]);
  rRig.add(rArm);
  out.right = right;
  out.rightRig = rRig;

  /* --- left (support) hand -------------------------------------------------
   * C-clamp from underneath: the palm takes the lower-left of the handguard, the
   * fingers wrap over the bottom and up the right side, the thumb rides forward
   * along the top.
   */
  const lRig = new THREE.Group();
  lRig.name = 'rig:left';
  const left = buildHand(mats, 'left', {
    curl: [1.14, 1.34, 0.86],
    indexCurl: [1.06, 1.3, 0.82],
    thumb: [0.34, 0.42, 0.26],
    thumbYaw: 0.78,
    thumbRoll: -0.24,
  });
  const lHand = new THREE.Group();
  lHand.add(left.root);
  orientTo(lHand, [-0.62, -0.72, -0.3], [0.8, -0.52, -0.3]);
  const hz = b.handguard.z0 * 0.55 + b.handguard.z1 * 0.45;
  const rad = b.handguard.r + 0.0155;
  const palmC = [-0.652 * rad, -0.758 * rad, hz];
  lHand.position.set(palmC[0] - 0.0368, palmC[1] + 0.0239, palmC[2] + 0.0138);
  lRig.add(lHand);
  const lArm = buildForearm(mats, 'left');
  lArm.position.copy(lHand.position);
  aimNode(lArm, [-0.32, -0.72, 0.62]);
  lRig.add(lArm);
  out.left = left;
  out.leftRig = lRig;

  return out;
}

/** Point a forearm (built along its own −Y) down `dir`. */
function aimNode(node, dir) {
  const d = new THREE.Vector3().fromArray(dir).normalize();
  node.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
  return node;
}

/**
 * Orient a hand: local +Z becomes `back` (the back of the hand) and local +Y becomes
 * `finger` (wrist -> knuckles), orthogonalised against it.
 */
function orientTo(node, back, finger) {
  const z = new THREE.Vector3().fromArray(back).normalize();
  const y = new THREE.Vector3().fromArray(finger);
  y.sub(z.clone().multiplyScalar(y.dot(z))).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  node.quaternion.setFromRotationMatrix(m);
  return node;
}

/* ========================================================================== */
/*                              brass & muzzle FX                             */
/* ========================================================================== */

export function makeBrassPool(ctx, mats, n = 10, calibre = 0.0057) {
  const group = new THREE.Group();
  group.name = 'brass';
  const L = calibre * 8.0;
  const g = mergeGeoms([
    latheG(
      [
        [calibre * 1.06, -L * 0.5, 'hard'],
        [calibre * 1.06, -L * 0.42, 'hard edge'],
        [calibre, -L * 0.36],
        [calibre, L * 0.24],
        [calibre * 0.86, L * 0.38, 'hard'],
        [calibre * 0.84, L * 0.5],
      ],
      10,
      { capStart: true, capEnd: true }
    ).main,
  ]);
  const cases = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(g, mats.brass);
    m.visible = false;
    m.frustumCulled = false;
    group.add(m);
    cases.push({ mesh: m, life: 0, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
  }
  return { group, cases };
}

export function makeMuzzleFlash(ctx, mats) {
  const group = new THREE.Group();
  group.name = 'muzzleFlash';
  const mat = mats._optics.flash;
  const quads = [];
  for (let i = 0; i < 3; i++) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), mat);
    q.rotation.z = (i / 3) * Math.PI;
    q.position.z = -0.004 * i;
    q.frustumCulled = false;
    q.renderOrder = 20;
    group.add(q);
    quads.push(q);
  }
  // A short forward jet so the flash has depth rather than reading as a sticker.
  const jet = new THREE.Mesh(
    latheG(
      [
        [0.001, 0.0, 'hard'],
        [0.021, -0.03],
        [0.014, -0.07],
        [0.002, -0.1],
      ],
      10
    ).main,
    mat
  );
  jet.frustumCulled = false;
  jet.renderOrder = 19;
  group.add(jet);
  group.visible = false;
  const light = new THREE.PointLight(0xffb066, 0, 2.2, 2.0);
  light.position.set(0, 0, -0.02);
  group.add(light);
  return { group, mat, light, quads, jet };
}

export { G };
export default buildWeapon;
