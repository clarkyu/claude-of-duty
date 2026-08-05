/**
 * Geometry construction kit for procedural plants. Owner: foliage agent.
 *
 * Every plant in the game is assembled from two primitives:
 *
 *   addCard()  a curved, tapering leaf/blade card. It is *not* a rectangle: it follows
 *              an arc, narrows along its length, and its normals are bent towards a
 *              cluster centre so a bush shades like a volume instead of like a stack
 *              of postcards. UVs address one cell of the leaf atlas.
 *   addTube()  a tapered, gnarled tube along an arbitrary polyline. Trunks, branches,
 *              stems, vine cords and frond rachises are all this.
 *
 * Both write the wind attribute `aFol`:
 *   aFol.x  flex   0 at the anchored base, 1 at the free tip. Amplitude scales with it,
 *                  so the trunk never moves and the tips move most.
 *   aFol.y  phase  0..1, constant per card/branch — decorrelates the leaf-level flutter
 *                  so a bush never flaps in lockstep.
 *   aFol.z  leaf   0 = woody, 1 = leaf. Gates the fast flutter band.
 */
import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ALT = new THREE.Vector3(1, 0, 0);

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.fol = [];
    this.idx = [];
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  get triangleCount() {
    return this.idx.length / 3;
  }

  vertex(px, py, pz, nx, ny, nz, u, v, flex, phase, leaf) {
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.fol.push(flex, phase, leaf);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  quad(a, b, c, d) {
    this.idx.push(a, b, d, b, c, d);
  }

  /** Merge another builder's contents, optionally transformed. */
  append(other, matrix = null, normalMatrix = null) {
    const base = this.vertexCount;
    const p = other.pos;
    const n = other.nrm;
    if (matrix) {
      for (let i = 0; i < p.length; i += 3) {
        _a.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(matrix);
        this.pos.push(_a.x, _a.y, _a.z);
        _b.set(n[i], n[i + 1], n[i + 2]);
        if (normalMatrix) _b.applyMatrix3(normalMatrix);
        _b.normalize();
        this.nrm.push(_b.x, _b.y, _b.z);
      }
    } else {
      for (let i = 0; i < p.length; i++) {
        this.pos.push(p[i]);
        this.nrm.push(n[i]);
      }
    }
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.fol.length; i++) this.fol.push(other.fol[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(base + other.idx[i]);
    return this;
  }

  toGeometry(name = 'foliage') {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aFol', new THREE.BufferAttribute(new Float32Array(this.fol), 3));
    const count = this.vertexCount;
    const IndexArray = count > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(IndexArray.from(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Orthonormal basis with `dir` as +Y. Deterministic: no rng, no branching on data. */
export function basisFrom(dir, out = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() }) {
  out.y.copy(dir).normalize();
  const ref = Math.abs(out.y.y) > 0.94 ? ALT : UP;
  out.x.crossVectors(ref, out.y);
  if (out.x.lengthSq() < 1e-8) out.x.set(1, 0, 0);
  out.x.normalize();
  out.z.crossVectors(out.x, out.y).normalize();
  return out;
}

const _basis = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() };

/**
 * A single curved leaf card.
 *
 * @param {MeshBuilder} mb
 * @param {object} o
 * @param {THREE.Vector3} o.origin      base of the card (petiole)
 * @param {THREE.Vector3} o.dir         growth direction at the base
 * @param {THREE.Vector3} [o.side]      width axis; derived if omitted
 * @param {number} o.length
 * @param {number} o.width
 * @param {THREE.Vector3} [o.bend]      world direction the tip droops/leans towards
 * @param {number} [o.bendAmount]       metres of tip displacement along `bend`
 * @param {number} [o.segments]         length subdivisions (>=1)
 * @param {object} o.cell               {u0,v0,du,dv} atlas rect
 * @param {number} [o.taper]            width at the tip as a fraction of `width`
 * @param {THREE.Vector3} [o.bentCenter] blend normals away from this point
 * @param {number} [o.bentAmount]       0..1 how far to bend the normals
 * @param {number} [o.flexBase]         flex at the base (default 0.12)
 * @param {number} [o.flexTip]          flex at the tip  (default 1)
 * @param {number} [o.phase]            0..1 per-card wind phase
 * @param {number} [o.leaf]             0..1 flutter gate
 * @param {number} [o.cup]              cross-section curl, metres
 */
export function addCard(mb, o) {
  const segs = Math.max(1, o.segments ?? 3);
  const cell = o.cell;
  const taper = o.taper ?? 0.55;
  const bendAmount = o.bendAmount ?? 0;
  const phase = o.phase ?? 0;
  const leaf = o.leaf ?? 1;
  const flexBase = o.flexBase ?? 0.12;
  const flexTip = o.flexTip ?? 1;
  const cup = o.cup ?? 0;

  basisFrom(o.dir, _basis);
  const axis = new THREE.Vector3().copy(_basis.y);
  const side = new THREE.Vector3();
  if (o.side) side.copy(o.side);
  else side.copy(_basis.x);
  // Re-orthogonalise so a caller-supplied side axis never skews the card.
  side.addScaledVector(axis, -side.dot(axis));
  if (side.lengthSq() < 1e-8) side.copy(_basis.x);
  side.normalize();

  const rows = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Arc: quadratic in t so the base leaves straight and the tip curls over.
    const p = new THREE.Vector3().copy(o.origin).addScaledVector(axis, o.length * t);
    if (bendAmount !== 0 && o.bend) p.addScaledVector(o.bend, bendAmount * t * t);
    rows.push(p);
  }

  const face = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const out = new THREE.Vector3();
  const ring = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = rows[i];
    // Tangent from the arc so normals follow the curve.
    const prev = rows[Math.max(0, i - 1)];
    const next = rows[Math.min(segs, i + 1)];
    _t.copy(next).sub(prev);
    if (_t.lengthSq() < 1e-10) _t.copy(axis);
    _t.normalize();
    face.crossVectors(side, _t);
    // A card whose bend has rotated the tangent onto the width axis has no face
    // direction left; fall back to the un-bent frame rather than emitting NaN normals.
    if (face.lengthSq() < 1e-10) face.crossVectors(side, axis);
    if (face.lengthSq() < 1e-10) face.copy(_basis.z);
    face.normalize();
    const w = o.width * 0.5 * (1 - (1 - taper) * t);
    const flex = flexBase + (flexTip - flexBase) * t;
    const v = cell.v0 + cell.dv * t;

    for (let s = 0; s < 2; s++) {
      const sgn = s === 0 ? -1 : 1;
      _a.copy(p).addScaledVector(side, w * sgn);
      // Cross-section curl. A two-vertex-wide card cannot physically form a trough, so
      // fake it in the shading normal instead: tilt each edge outwards and the card
      // lights like a channelled leaf rather than a flat sheet.
      nrm.copy(face);
      if (cup !== 0) {
        nrm.addScaledVector(side, sgn * cup);
        if (nrm.lengthSq() > 1e-10) nrm.normalize();
        else nrm.copy(face);
      }
      // Bent normal: blend the card normal towards "outward from the cluster", which is
      // what makes a leaf mass shade like a volume instead of a stack of postcards.
      if (o.bentCenter && (o.bentAmount ?? 0) > 0) {
        out.copy(_a).sub(o.bentCenter);
        if (out.lengthSq() > 1e-8) {
          out.normalize();
          // A card diametrically opposite its cluster centre can cancel to zero here.
          nrm.lerp(out, o.bentAmount);
          if (nrm.lengthSq() > 1e-8) nrm.normalize();
          else nrm.copy(out);
        }
      }
      const u = cell.u0 + cell.du * (s === 0 ? 0 : 1);
      ring.push(mb.vertex(_a.x, _a.y, _a.z, nrm.x, nrm.y, nrm.z, u, v, flex, phase, leaf));
    }
  }

  for (let i = 0; i < segs; i++) {
    const a = ring[i * 2];
    const b = ring[i * 2 + 1];
    const c = ring[i * 2 + 3];
    const d = ring[i * 2 + 2];
    mb.quad(a, b, c, d);
  }
  return mb;
}

/**
 * A tapered tube along a polyline. `path` is [{p:Vector3, r:number, flex:number}].
 * Radial segments are the LOD dial: 6 near, 3 far.
 */
export function addTube(mb, path, o = {}) {
  const radial = Math.max(3, o.radial ?? 6);
  const cell = o.cell;
  const phase = o.phase ?? 0;
  const vScale = o.vScale ?? 1;
  const vOffset = o.vOffset ?? 0;
  const uTwist = o.twist ?? 0;
  if (!path || path.length < 2) return mb;

  const rings = [];
  const basis = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() };
  // Parallel-transport the frame so a gnarled branch does not spin its texture.
  const refX = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    dir.copy(next.p).sub(prev.p);
    if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
    dir.normalize();
    if (i === 0) {
      basisFrom(dir, basis);
      refX.copy(basis.x);
    } else {
      // project the previous reference onto the new normal plane
      refX.addScaledVector(dir, -refX.dot(dir));
      if (refX.lengthSq() < 1e-8) {
        basisFrom(dir, basis);
        refX.copy(basis.x);
      } else {
        refX.normalize();
      }
      basis.y.copy(dir);
      basis.x.copy(refX);
      basis.z.crossVectors(basis.x, basis.y).normalize();
    }
    const v = vOffset + vScale * (i / (path.length - 1));
    const ring = [];
    for (let s = 0; s <= radial; s++) {
      const a = (s / radial) * Math.PI * 2 + uTwist * v;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      // Trunks are not circular: pinch the section a little, differently per ring.
      const lobe = 1 + (o.lobes ? Math.cos(a * o.lobes + i * 0.7) * (o.lobeAmount ?? 0.12) : 0);
      const r = node.r * lobe;
      _a.copy(node.p).addScaledVector(basis.x, cx * r).addScaledVector(basis.z, cz * r);
      _n.copy(basis.x).multiplyScalar(cx).addScaledVector(basis.z, cz).normalize();
      const u = cell.u0 + cell.du * (s / radial);
      ring.push(
        mb.vertex(
          _a.x,
          _a.y,
          _a.z,
          _n.x,
          _n.y,
          _n.z,
          u,
          cell.v0 + cell.dv * Math.min(1, Math.max(0, v)),
          node.flex ?? 0,
          phase,
          0
        )
      );
    }
    rings.push(ring);
  }

  // Winding: the ring runs clockwise seen from the tip, so the quad has to be walked
  // A -> B -> B+1 -> A+1 for the face normal to point *out* of the tube. Get this
  // backwards and every trunk renders inside-out — lit from the inside, i.e. black.
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i];
    const B = rings[i + 1];
    for (let s = 0; s < radial; s++) mb.quad(A[s], B[s], B[s + 1], A[s + 1]);
  }

  if (o.cap) {
    const last = path[path.length - 1];
    const tipFlex = last.flex ?? 1;
    const tip = mb.vertex(
      last.p.x,
      last.p.y + 0,
      last.p.z,
      0,
      1,
      0,
      cell.u0 + cell.du * 0.5,
      cell.v0 + cell.dv,
      tipFlex,
      phase,
      0
    );
    const ring = rings[rings.length - 1];
    for (let s = 0; s < radial; s++) mb.tri(ring[s + 1], ring[s], tip);
  }
  return mb;
}

/**
 * Build a gnarled path from a start point and direction. Old olive wood does not grow
 * straight: it wanders, thickens at knots and thins between them.
 */
export function gnarlPath(origin, dir, length, r0, r1, opts = {}) {
  const steps = Math.max(2, opts.steps ?? 5);
  const wobble = opts.wobble ?? 0.12;
  const droop = opts.droop ?? 0;
  const knots = opts.knots ?? 0.18;
  const rng = opts.rng;
  const path = [];
  const p = origin.clone();
  const d = dir.clone().normalize();
  const b = basisFrom(d, { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() });
  const seg = length / steps;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = (r0 + (r1 - r0) * t) * (1 + Math.sin(t * 9.3 + (opts.seed ?? 0)) * knots);
    path.push({ p: p.clone(), r: Math.max(0.004, r), flex: opts.flexFn ? opts.flexFn(t) : t * t });
    if (i === steps) break;
    // step forward, then bend the direction for the next segment
    p.addScaledVector(d, seg);
    if (rng) {
      d.addScaledVector(b.x, (rng() - 0.5) * wobble);
      d.addScaledVector(b.z, (rng() - 0.5) * wobble);
    }
    d.y -= droop * seg;
    d.normalize();
  }
  return path;
}

/** Simple cone/cylinder for pots and planters. Returns positions in local space. */
export function addPot(mb, o = {}) {
  const rTop = o.rTop ?? 0.19;
  const rBot = o.rBot ?? 0.14;
  const h = o.height ?? 0.26;
  const radial = o.radial ?? 12;
  const cell = o.cell;
  const rim = o.rim ?? 0.018;
  const rings = [
    { y: 0, r: rBot },
    { y: h * 0.86, r: rTop },
    { y: h * 0.86, r: rTop + rim },
    { y: h, r: rTop + rim },
    { y: h, r: rTop * 0.94 },
    { y: h - 0.02, r: rTop * 0.9 },
  ];
  const idx = [];
  for (let k = 0; k < rings.length; k++) {
    const row = [];
    for (let s = 0; s <= radial; s++) {
      const a = (s / radial) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      const nY = k >= 3 ? 0.4 : 0.12;
      _n.set(cx, nY, cz).normalize();
      row.push(
        mb.vertex(
          cx * rings[k].r,
          rings[k].y,
          cz * rings[k].r,
          _n.x,
          _n.y,
          _n.z,
          cell.u0 + cell.du * (s / radial),
          cell.v0 + cell.dv * (rings[k].y / h),
          0,
          0,
          0
        )
      );
    }
    idx.push(row);
  }
  for (let k = 0; k < rings.length - 1; k++) {
    for (let s = 0; s < radial; s++) mb.quad(idx[k][s], idx[k + 1][s], idx[k + 1][s + 1], idx[k][s + 1]);
  }
  // soil disc
  const centre = mb.vertex(0, h - 0.035, 0, 0, 1, 0, cell.u0 + cell.du * 0.5, cell.v0 + cell.dv * 0.5, 0, 0, 0);
  const soil = [];
  for (let s = 0; s <= radial; s++) {
    const a = (s / radial) * Math.PI * 2;
    soil.push(
      mb.vertex(
        Math.cos(a) * rTop * 0.9,
        h - 0.045,
        Math.sin(a) * rTop * 0.9,
        0,
        1,
        0,
        cell.u0 + cell.du * (0.5 + Math.cos(a) * 0.4),
        cell.v0 + cell.dv * (0.5 + Math.sin(a) * 0.4),
        0,
        0,
        0
      )
    );
  }
  for (let s = 0; s < radial; s++) mb.tri(centre, soil[s + 1], soil[s]);
  return mb;
}

export default { MeshBuilder, addCard, addTube, addPot, gnarlPath, basisFrom };
