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
 * Two things decide whether the result reads as a weapon or as a grey box, and neither
 * of them is triangle count:
 *
 *  1. **It must not track the sky.** Coated weapon finishes are dark dielectrics, not
 *     bare metal, so anodising and phosphate are authored at metalness ~0. Authored as
 *     metal, the albedo becomes a specular tint that never shows and the gun turns into
 *     a mirror: white at noon, a glowing beacon at night. See MATSPEC.
 *  2. **The wear has to be albedo, not reflection.** The corollary of (1): a chamfer
 *     authored as near-pure metal has no diffuse term either, so on a viewmodel whose
 *     environment weight is deliberately clamped it can only flare when a highlight
 *     happens to cross it. Rub-through is authored as a bright, mostly-dielectric
 *     substance so it holds its value break against the black anodising in every light.
 *  3. **Something has to occlude something.** There is no AO pass on the viewmodel
 *     scene, so every recess, slot, port and chamfer machined here would otherwise
 *     render as a flat plane. `bakeCavity` solves short-range occlusion into the
 *     vertex-colour red channel, which the MaterialLibrary reads as its grime mask.
 *  4. **A hole has to be a hole.** There is no CSG here: a dark box sunk into a solid
 *     is a painted outline, not an opening. Real openings come from `extrudeG`'s hole
 *     loops (the stock's skeleton window) or from geometry built with a gap in it (the
 *     handguard's M-LOK panels).
 *
 * Exports
 *   makeWeaponMaterials(ctx)          -> material bag keyed by MATSPEC below
 *   VIEWMODEL_ENV_SCALE               global weight on the viewmodel's IBL response
 *   buildWeapon(ctx, def, mats)       -> { root, nodes, meshes, tris }
 *                                        nodes: bolt, charging, dustCover, trigger,
 *                                        selector, boltCatch, magazine, follower,
 *                                        railTop, muzzle, underbarrel, eject,
 *                                        magwell, grip, foreEnd
 *   buildArms(ctx, mats, def)         -> { left, right, leftRig, rightRig }
 *   buildRedDot(ctx, mats, o)         -> { group, sight, reticle, reticleMat, glass,
 *                                        kind:'reflex', axisY, planeZ, dotRad, zoom }
 *   buildScope(ctx, mats, o)          -> { group, sight, image, imageMat, glass,
 *                                        kind:'scope', axisY, zoom, eyeboxRadius }
 *   buildIrons / buildMuzzleDevice / buildForegrip
 *   makeBrassPool(ctx, mats, n, cal)  -> { group, cases[] }
 *   makeMuzzleFlash(ctx, mats)        -> { group, mat, light, quads, jet }
 *   G                                 the geometry kit, for Attachments.js
 *
 * Geometry kit (all metres, all indexed position/normal/uv so they merge cleanly):
 *   boxG(w,h,d,chamfer,seg)     chamfered box; returns {main, edge}
 *   plainBoxG(w,h,d,skip)       6 quads, for recesses and slots
 *   extrudeG(section, opts)     extrude a 2D section along x|y|z, holes supported
 *   latheG(profile, radial)     turned profile around Z, hard/soft normal breaks
 *   sweepG(section, path)       sweep a 2D section along a polyline
 *   capsuleY / lensG / discG / stippleG / railG / chamferPoly / rectSection
 *   bakeCavity(items) / bakeTree(root)   short-range AO into vertex red
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

/* ---------------------------- baked cavity / AO --------------------------- */

/**
 * Hemisphere sample directions (Fibonacci spiral, +Y = surface normal). Fixed, so the
 * bake is bit-for-bit deterministic — screenshots have to be reproducible.
 */
const AO_DIRS = (() => {
  const out = [];
  const n = 11;
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 0.94;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.399963229728653;
    out.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
  }
  return out;
})();

/**
 * Bake short-range ambient occlusion into every geometry's vertex-colour red channel.
 *
 * There is no AO pass on the viewmodel scene — GTAO is fitted to the world camera — so
 * without this every mesh-to-mesh junction on the gun renders with zero contact
 * darkening, which is the single loudest "untextured hobby model" signal. The
 * MaterialLibrary reads vertex red as its *grime* mask: crevices get darker albedo and
 * higher roughness, exactly what soot and handling residue do to a real weapon.
 *
 * Method: splat every triangle into a coarse occupancy grid, then cone-trace a short
 * distance out of each vertex. Roughly 40 ms for a whole rifle; it runs once per build.
 *
 * @param {{geom:THREE.BufferGeometry, mtx:THREE.Matrix4}[]} items  parts plus the
 *        transform that carries each into the common space they occlude each other in
 * @param {{cell?:number, maxDist?:number, amount?:number}} o
 */
function bakeCavity(items, o = {}) {
  const list = items.filter((it) => it?.geom?.attributes?.position && it.geom.index);
  if (!list.length) return;
  const cell = o.cell ?? 0.0032;
  const maxDist = o.maxDist ?? 0.028;
  const amount = o.amount ?? 1;
  const inv = 1 / cell;

  /* -- transform every part into the common space once -------------------- */
  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _nm = new THREE.Matrix3();
  for (const it of list) {
    const src = it.geom.attributes.position.array;
    const sn = it.geom.attributes.normal.array;
    const count = it.geom.attributes.position.count;
    const wp = new Float32Array(count * 3);
    const wn = new Float32Array(count * 3);
    _nm.getNormalMatrix(it.mtx);
    for (let v = 0; v < count; v++) {
      _p.set(src[v * 3], src[v * 3 + 1], src[v * 3 + 2]).applyMatrix4(it.mtx);
      wp[v * 3] = _p.x; wp[v * 3 + 1] = _p.y; wp[v * 3 + 2] = _p.z;
      _n.set(sn[v * 3], sn[v * 3 + 1], sn[v * 3 + 2]).applyMatrix3(_nm).normalize();
      wn[v * 3] = _n.x; wn[v * 3 + 1] = _n.y; wn[v * 3 + 2] = _n.z;
    }
    it.wp = wp;
    it.wn = wn;
  }

  /* -- bounds ------------------------------------------------------------- */
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const it of list) {
    const p = it.wp;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
      if (p[i + 2] < z0) z0 = p[i + 2];
      if (p[i + 2] > z1) z1 = p[i + 2];
    }
  }
  if (!Number.isFinite(x0)) return;
  const pad = cell * 2;
  x0 -= pad; y0 -= pad; z0 -= pad;
  const nx = Math.min(400, Math.ceil((x1 - x0 + pad * 2) * inv) + 1);
  const ny = Math.min(400, Math.ceil((y1 - y0 + pad * 2) * inv) + 1);
  const nz = Math.min(600, Math.ceil((z1 - z0 + pad * 2) * inv) + 1);
  const total = nx * ny * nz;
  if (total <= 0 || total > 6e6) return;
  const grid = new Uint8Array(total);
  const nyz = ny * nz;

  const mark = (px, py, pz) => {
    const i = ((px - x0) * inv) | 0;
    const j = ((py - y0) * inv) | 0;
    const k = ((pz - z0) * inv) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    grid[i * nyz + j * nz + k] = 1;
  };

  /* -- splat every triangle ----------------------------------------------- */
  for (const it of list) {
    const p = it.wp;
    const idx = it.geom.index.array;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const e1x = p[b] - ax, e1y = p[b + 1] - ay, e1z = p[b + 2] - az;
      const e2x = p[c] - ax, e2y = p[c + 1] - ay, e2z = p[c + 2] - az;
      // Longest edge decides how finely the triangle needs sampling.
      const l1 = Math.hypot(e1x, e1y, e1z);
      const l2 = Math.hypot(e2x, e2y, e2z);
      const l3 = Math.hypot(e2x - e1x, e2y - e1y, e2z - e1z);
      const s = Math.min(8, Math.max(1, Math.ceil(Math.max(l1, l2, l3) * inv * 1.4)));
      for (let i = 0; i <= s; i++) {
        for (let j = 0; j <= s - i; j++) {
          const u = i / s;
          const v = j / s;
          mark(ax + e1x * u + e2x * v, ay + e1y * u + e2y * v, az + e1z * u + e2z * v);
        }
      }
    }
  }

  /* -- cone trace ---------------------------------------------------------- */
  const steps = Math.max(3, Math.round(maxDist / (cell * 1.25)));
  const occAt = (px, py, pz) => {
    const i = ((px - x0) * inv) | 0;
    const j = ((py - y0) * inv) | 0;
    const k = ((pz - z0) * inv) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
    return grid[i * nyz + j * nz + k];
  };

  for (const it of list) {
    const g = it.geom;
    const p = it.wp;
    const nrm = it.wn;
    const count = g.attributes.position.count;
    const col = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      const px = p[v * 3], py = p[v * 3 + 1], pz = p[v * 3 + 2];
      let nX = nrm[v * 3], nY = nrm[v * 3 + 1], nZ = nrm[v * 3 + 2];
      const nl = Math.hypot(nX, nY, nZ) || 1;
      nX /= nl; nY /= nl; nZ /= nl;
      // Tangent frame.
      let tx, ty, tz;
      if (Math.abs(nY) < 0.9) { tx = -nZ; ty = 0; tz = nX; } else { tx = 1; ty = 0; tz = 0; }
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const bx = nY * tz - nZ * ty;
      const by = nZ * tx - nX * tz;
      const bz = nX * ty - nY * tx;
      const ox = px + nX * cell * 1.35;
      const oy = py + nY * cell * 1.35;
      const oz = pz + nZ * cell * 1.35;

      let occ = 0;
      let wsum = 0;
      for (let d = 0; d < AO_DIRS.length; d++) {
        const D = AO_DIRS[d];
        const dx = tx * D[0] + nX * D[1] + bx * D[2];
        const dy = ty * D[0] + nY * D[1] + by * D[2];
        const dz = tz * D[0] + nZ * D[1] + bz * D[2];
        const w = D[1]; // cosine weight
        wsum += w;
        for (let s = 1; s <= steps; s++) {
          const t = (s / steps) * maxDist;
          if (occAt(ox + dx * t, oy + dy * t, oz + dz * t)) {
            occ += w * (1 - t / maxDist);
            break;
          }
        }
      }
      // Gamma above 1 keeps open faces open and reserves the mask for real crevices —
      // a flat outer panel that picks up a few grazing hits must not go grey.
      const a = clamp((occ / (wsum || 1)) * 1.34, 0, 1);
      col[v * 3] = clamp(Math.pow(a, 1.3) * amount, 0, 1);
      col[v * 3 + 1] = 0;
      col[v * 3 + 2] = 0;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    it.wp = null;
    it.wn = null;
  }
}

/**
 * Bake every mesh under `root`, in `root`'s space, so parts on different animated nodes
 * (dust cover, magazine, bolt, each finger joint) occlude each other correctly instead
 * of each being solved as if it sat at the origin.
 *
 * Exported as `bakeViewmodel` so WeaponSystem can re-bake the gun and the hands *as one
 * object* once they are assembled: that is what puts a contact shadow under each finger
 * on the grip and the handguard, and unlike a real shadow-casting light it costs
 * nothing per frame and adds no shader variants — which matters on a software
 * rasteriser where every new program variant is seconds of compile time.
 */
function bakeTree(root, o) {
  root.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const items = [];
  const seen = new Set();
  root.traverse((m) => {
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    // One bake per geometry: an instanced geometry (the brass pool) would otherwise be
    // solved once per instance and keep only the last answer.
    if (seen.has(m.geometry)) return;
    seen.add(m.geometry);
    items.push({ geom: m.geometry, mtx: new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld) });
  });
  bakeCavity(items, o);
  for (const it of items) {
    const g = it.geom;
    if (!g.attributes.color) {
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
    }
  }
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
      // Outward for a CCW outer loop and for a CW hole loop alike. The normal is a
      // section-space fact, so it maps straight through; only the triangle winding
      // cares about the mapping's handedness.
      put(dy, -dx, 0, n3);
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

/**
 * Capsule along +Y of total length `len` and radius `r`. Fingers want round
 * cross-sections far more than they want bevelled corners, and a lathe gives that
 * for a third of the triangles a chamfered box would cost.
 */
function capsuleY(r, len, radial = 8, capSeg = 2) {
  const h = Math.max(1e-4, len * 0.5 - r);
  const prof = [];
  for (let i = 0; i <= capSeg; i++) {
    const a = -Math.PI * 0.5 + (Math.PI * 0.5 * i) / capSeg;
    prof.push([Math.max(1e-4, r * Math.cos(a)), -h + r * Math.sin(a)]);
  }
  prof.push([r, h]);
  for (let i = 1; i <= capSeg; i++) {
    const a = (Math.PI * 0.5 * i) / capSeg;
    prof.push([Math.max(1e-4, r * Math.cos(a)), h + r * Math.sin(a)]);
  }
  const g = latheG(prof, radial, {});
  const m = new THREE.Matrix4().makeRotationX(-Math.PI * 0.5);
  if (g.main) g.main.applyMatrix4(m);
  if (g.edge) g.edge.applyMatrix4(m);
  return g;
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
      // Outward from the sphere centre — that is the convex side for either facing.
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
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
  plainBoxG,
  capsuleY,
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
/**
 * Values are deliberately *dark and dielectric*.
 *
 * The single most damaging thing a weapon viewmodel can do is track the sky. Hard
 * anodising is an aluminium-oxide layer — optically a dark dielectric over metal, not
 * bare metal — and manganese phosphate is a porous conversion coating that is rougher
 * still. Authoring them as `metalness ~1` turns albedo into a specular tint that never
 * shows, and the gun becomes a chrome mirror of whatever the sky is doing: white at
 * noon, blue-white at night. A real receiver is one of the darkest objects on screen
 * and it *stays* dark when the environment changes.
 *
 * So: metalness stays near zero for every coated body part, and full metal is reserved
 * for the surfaces that genuinely are bare metal — chamfers where the finish has rubbed
 * through, handling wear, the bolt, pins, springs and brass.
 *
 * `det` is the detail-normal feature size in metres (the shader tiling works out to
 * exactly 1/det), and it is deliberately different for every substance: four parts
 * wearing the same normal at the same pitch is what made the stock, the pad, the grip
 * and the gloves all read as the same corduroy.
 *
 * `env` is the per-material environment weight; the viewmodel scene carries the world's
 * HDR sky, so this is the last line of defence against the whole gun becoming one
 * sky-coloured specular sheet. `grime` scales how strongly baked cavity occlusion
 * darkens and roughens the surface.
 */
/**
 * A note on the *edge* materials, which is where this model earned and then lost its
 * "used weapon" read twice in a row.
 *
 * Attempt one keyed chamfers as near-pure metal. A metal chamfer has no diffuse term,
 * so on a viewmodel whose environment weight is clamped it flared for the two frames a
 * highlight crossed it and was invisible the rest of the time.
 *
 * Attempt two overcorrected: bright *dielectric* rub-through, 0x99a1ab against a
 * 0x191c21 body — a 6:1 albedo step — applied by `sink.pair(main, edge, …)` to the
 * chamfer of **every primitive in the model**. Every bevel, every M-LOK lip, every rail
 * tooth, every knurl. The bodies were dark and correct and every millimetre-wide feature
 * on them was six times brighter, which is not edge wear, it is salt crust: measured at
 * 2.93× scene p99 against 0.52× scene p50, a 5.7:1 internal contrast on an object that
 * should sit around 3:1.
 *
 * What is authored here instead:
 *
 *  - **The default chamfer is a machined bevel, not rub-through.** A cut face on an
 *    anodised part is still anodised: it is a slightly lighter, slightly smoother
 *    version of the flank it came off, about 1.6:1, and that is all. This is the shade
 *    almost every `sink.pair` in the file gets, and at 1.6:1 a thousand of them read as
 *    machining rather than as confetti.
 *  - **Rub-through is a sparse mask, capped at ~2:1.** `wearBright` is reserved for the
 *    handful of places a hand, a magazine or a case actually scrubs, and even there the
 *    step is two stops, not six. Anodising that has genuinely worn to bare aluminium is
 *    a *matte* grey — burnished by a palm, oxidised within the hour — not a mirror, so
 *    it is also rougher than it used to be, which stops it collecting tight speculars.
 *  - **Every edge family is defined as a ratio against its own body**, listed after the
 *    hex, so the next person changing one can see immediately what they are doing to the
 *    internal contrast of the weapon.
 *
 * The detail normal stays dialled right down on the edge materials: a chamfer strip is
 * under a millimetre wide, so a 4 mm-feature normal across it is pure sub-pixel noise.
 */
const MATSPEC = {
  /* ── anodised aluminium: receiver, handguard, rails, optic bodies ──────── */
  anodised: { base: 'brushed_aluminium', color: 0x191c21, rough: [0.54, 0.74], metal: [0.0, 0.14], uv: 62, det: 0.006, nrm: 0.9, env: 0.42, grime: 0.9 },
  /* The default chamfer: a machined bevel in the same anodising, 1.6:1 on the flank.
   * NOT rub-through — see the note above. */
  anodisedEdge: { base: 'brushed_aluminium', color: 0x282c32, rough: [0.46, 0.66], metal: [0.04, 0.18], uv: 78, det: 0.004, nrm: 0.26, env: 0.3, grime: 0.7 },
  /* Optic bodies are their own substance. A sight housing is a smooth turned cylinder
   * lying along the bore, so unlike the flat-sided receiver it always presents a broad
   * band to the key light at a grazing angle, and it sits proud of everything so the
   * cavity bake never touches it. On the receiver's own values it measured 97 against
   * the receiver's 59 — a white pill floating over a black rifle. Real optic housings
   * are bead-blasted before anodising and they are among the *darkest* things on a
   * weapon, so this is darker than the receiver and its environment weight is halved
   * again on top of that. */
  opticBody: { base: 'brushed_aluminium', color: 0x0e1013, rough: [0.74, 0.94], metal: [0.0, 0.08], uv: 70, det: 0.005, nrm: 0.85, env: 0.09, grime: 0.95 },
  /* ...and so are its chamfers, of which a sight is nearly half made. 1.7:1 on the
   * housing. A sight is a sealed unit nobody handles once it is zeroed: its edges are
   * machined, not burnished. */
  opticEdge: { base: 'brushed_aluminium', color: 0x191c20, rough: [0.62, 0.82], metal: [0.02, 0.14], uv: 78, det: 0.004, nrm: 0.3, env: 0.12, grime: 0.85 },
  /* ── manganese phosphate: barrel, gas block, controls, small steel ─────── */
  /* Phosphate is a porous conversion coating — it is measurably rougher than hard
   * anodising and it has to *look* it, or the barrel and the receiver read as one
   * substance in two colours. The four families are deliberately spread across the
   * roughness range: anodising 0.54-0.74, phosphate 0.68-0.9, polymer 0.74-0.94,
   * rubber 0.9-1.0. */
  phosphate: { base: 'painted_steel_chipped', color: 0x111214, rough: [0.68, 0.9], metal: [0.0, 0.14], uv: 66, det: 0.006, nrm: 1.05, env: 0.28, grime: 1.05 },
  /* 1.9:1 on phosphate. Same job as anodisedEdge, one family down in value. */
  phosphateEdge: { base: 'brushed_aluminium', color: 0x212429, rough: [0.5, 0.7], metal: [0.06, 0.22], uv: 78, det: 0.004, nrm: 0.28, env: 0.26, grime: 0.7 },
  /* ── bare aluminium worn through the finish at handling points ─────────── */
  /* 2.1:1 on the receiver, and SPARSE: charging handle, selector, mag catch, bolt
   * catch, trigger shoe, magwell flare, port surround, takedown pins. Everything that
   * is merely a cut edge takes `anodisedEdge`. Worn anodising is matte grey aluminium
   * oxide, so this is a *rougher* surface than the coating it wore off, not a polished
   * one — a glossy wear shade is what turned the rail teeth into white noise. */
  wearBright: { base: 'brushed_aluminium', color: 0x363a41, rough: [0.4, 0.58], metal: [0.1, 0.28], uv: 86, det: 0.003, nrm: 0.24, env: 0.28, grime: 0.5 },
  /* 2.4:1, and only ever on hardware you could count: cross-bolts, ring screws, pins.
   * It keeps a real metal fraction because a screw head genuinely is bare steel, but
   * the environment weight is low enough that it cannot mirror the sky. */
  steelBright: { base: 'brushed_aluminium', color: 0x3f434a, rough: [0.34, 0.5], metal: [0.25, 0.5], uv: 82, det: 0.004, nrm: 0.5, env: 0.26, grime: 0.8 },
  /* parkerised steel — dark, matte, and emphatically not a mirror */
  steelDark: { base: 'galvanised_metal', color: 0x0f1012, rough: [0.5, 0.78], metal: [0.0, 0.2], uv: 64, det: 0.005, nrm: 0.8, env: 0.22, grime: 1.1 },
  /* ── the inside of anything: bores, slots, recesses, the ejection port ─── */
  bore: { base: 'rusted_steel', color: 0x040405, rough: [0.7, 0.98], metal: [0.0, 0.12], env: 0.07, uv: 52, det: 0.006, nrm: 0.8, grime: 1.3 },
  /* ── moulded polymer: stock, grip, magazine ────────────────────────────── */
  polymer: { base: 'rubber_tyre', color: 0x2b3021, rough: [0.74, 0.94], metal: [0.0, 0.03], uv: 96, det: 0.0032, nrm: 1.2, env: 0.2, grime: 0.9 },
  /* Polymer does not polish, it *scuffs*: the pigment goes chalky along a moulded edge.
   * 1.6:1 on the body — it used to be 2.4:1 and glossy, which is what put the hard
   * clipped specular on the top edge of the stock. */
  polymerEdge: { base: 'rubber_tyre', color: 0x444c3a, rough: [0.64, 0.86], metal: [0.0, 0.04], uv: 104, det: 0.0028, nrm: 0.8, env: 0.2, grime: 0.7 },
  rubber: { base: 'rubber_tyre', color: 0x0b0c0e, rough: [0.88, 1.0], metal: [0.0, 0.02], uv: 44, det: 0.0068, nrm: 1.6, env: 0.12, grime: 1.0 },
  /* Ejected cases only: they are in frame for four frames at a time and they are
   * genuinely polished brass. */
  brass: { base: 'brushed_aluminium', color: 0x8f7130, rough: [0.26, 0.5], metal: [0.9, 1.0], uv: 96, det: 0.003, nrm: 0.5, env: 0.8, grime: 0.6 },
  /* A *loaded* round is a different problem: the top of the stack sits in the magwell
   * for the whole match, and on the ejected-case shade it read as an orange bulb glowing
   * inside the gun. Lacquered military brass is dull, dark and half-shadowed by the feed
   * lips. */
  cartridge: { base: 'brushed_aluminium', color: 0x4a3a1c, rough: [0.5, 0.74], metal: [0.35, 0.6], uv: 96, det: 0.003, nrm: 0.5, env: 0.16, grime: 1.1 },
  /* ── hands ─────────────────────────────────────────────────────────────────
   * A viewmodel's value hierarchy runs gun < glove < sleeve only in a game where the
   * player is wearing white gloves. Measured, these came out at 79 against a 59
   * receiver and a 32 stock: the hands were the brightest thing on screen and the eye
   * went to them instead of to the weapon. Nomex assault gloves are near-black, and the
   * fabric recipes carry a heavy sheen term (0.85 on the uniform) that is authored for a
   * sunlit canvas awning and has to be pulled right down for a 9 cm object 40 cm from
   * the lens — see `makeWeaponMaterials`. */
  glove: { base: 'fabric_webbing', color: 0x14171c, rough: [0.82, 1.0], metal: [0.0, 0.03], uv: 62, det: 0.0034, nrm: 1.3, env: 0.18, grime: 0.95 },
  glovePad: { base: 'rubber_tyre', color: 0x0d0e11, rough: [0.66, 0.92], metal: [0.0, 0.03], uv: 124, det: 0.0022, nrm: 1.4, env: 0.14, grime: 1.0 },
  sleeve: { base: 'fabric_uniform', color: 0x1a1e17, rough: [0.82, 1.0], metal: [0.0, 0.02], uv: 46, det: 0.0042, nrm: 1.35, env: 0.15, grime: 1.1 },
  /* Second sleeve shade for the pattern breakup — see buildForearm. */
  sleeveDark: { base: 'fabric_uniform', color: 0x111410, rough: [0.84, 1.0], metal: [0.0, 0.02], uv: 52, det: 0.0036, nrm: 1.35, env: 0.13, grime: 1.15 },
  skin: { base: 'skin', color: 0x6d4d38, rough: [0.46, 0.76], metal: [0.0, 0.02], uv: 52, det: 0.004, nrm: 0.85, env: 0.22, grime: 0.8 },
};

/** Materials whose base recipe carries a fabric sheen lobe fitted to metre-scale cloth.
 *  On a hand 40 cm from the lens that lobe is most of the glove's rendered value. */
const SHEEN_TAME = { glove: 0.16, sleeve: 0.2, sleeveDark: 0.2, glovePad: 0.1 };

/** Global scale on every weapon material's environment weight; see MATSPEC.env. */
export const VIEWMODEL_ENV_SCALE = 0.55;

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
          aoDirect: 0.55,
          aerial: false,
          // Vertex red carries the baked cavity occlusion (see bakeCavity): the library
          // reads it as a grime mask, which darkens albedo and roughens the surface —
          // soot and handling residue collect in exactly the places AO darkens.
          vertexColors: true,
          grime: 1,
          grimeColor: 0x69696d,
          envMapIntensity: (s.env ?? 0.5) * VIEWMODEL_ENV_SCALE,
        }) || null;
    } catch {
      mat = null;
    }
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(s.color),
        roughness: s.rough[1],
        metalness: s.metal[1],
        envMapIntensity: (s.env ?? 0.5) * VIEWMODEL_ENV_SCALE,
      });
    }
    mat.name = `weapon:${key}`;
    mat.userData.noLightingPatch = true;
    mat.userData.envWeight = (s.env ?? 0.5) * VIEWMODEL_ENV_SCALE;
    /* Fabric sheen. `fabric_uniform` ships a 0.85 sheen lobe with a pale 0x7d8464
     * sheenColor, which is right for a sun-lit canvas awning across a courtyard and
     * catastrophic on a forearm that fills an eighth of the frame: the lobe fires at
     * every grazing angle, which on a cylinder is most of its silhouette, and it turned
     * the sleeve into a glowing olive tube brighter than the receiver. Tamed, not
     * removed — cloth without any sheen reads as painted plastic. */
    const tame = SHEEN_TAME[key];
    if (tame !== undefined && typeof mat.sheen === 'number') {
      mat.sheen = mat.sheen * tame;
      if (mat.sheenColor?.isColor) mat.sheenColor.multiplyScalar(0.45);
    }
    // Per-part roughness/metalness windows and a centimetre-scale detail normal.
    try {
      const u = lib?.uniformsOf?.(mat);
      if (u?.uCodRough) u.uCodRough.value.set(s.rough[0], s.rough[1]);
      if (u?.uCodMetal) u.uCodMetal.value.set(s.metal[0], s.metal[1]);
      if (u?.uCodDetail) u.uCodDetail.value.set(1 / Math.max(1e-4, s.det * s.uv), 0.62, 0.4, 40);
      if (u?.uCodVCol) {
        // x: grime strength, y: grunge tiling in *texture* space. The library's default
        // is fitted to metre-scale walls, where one blotch spans 1.6 m; on a 40 cm part
        // that is a single flat value. 18 mm blotches are the right scale for soot and
        // handling residue on a receiver.
        u.uCodVCol.value.set(0.62 * (s.grime ?? 1), 1 / (0.018 * s.uv), 0.85, 0);
      }
    } catch {
      /* a fallback material has no extension uniforms */
    }
    out[key] = mat;
  }
  /* Every interior surface in the model — bores, slots, recesses, the ejection port,
   * the inside of the optic tube — is a cylinder or a box seen *from inside*, which on
   * a front-facing material is exactly the set of triangles the rasteriser throws away.
   * So none of them were drawing anything, and where a tube was supposed to show a
   * matte-black wall behind a semi-transparent element the camera was actually looking
   * straight through the weapon at the scene. Two sides everywhere: it is the cheapest
   * material in the bag and there are a few thousand triangles of it. */
  if (out.bore) out.bore.side = THREE.DoubleSide;
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

/**
 * Optic glass.
 *
 * The failure this replaces: the old shader put almost all of its energy in a
 * `pow(1-ndv, 4)` fresnel term and a 260-power sun lobe, so from anywhere except the
 * exact aiming axis the element contributed a few percent of alpha over a matte-black
 * tube interior. The sight read as an empty pipe with a machined rim.
 *
 * What a coated element actually does, and what this reproduces:
 *  - A multi-layer AR stack is an interference filter. Its residual reflection is
 *    strongly coloured and the colour *rotates with incidence angle* — the familiar
 *    green-at-square, cyan at 30°, violet-magenta at grazing. That angular colour
 *    sweep is the single most recognisable "this is coated glass" cue, and it is
 *    visible from every angle, not just off-axis.
 *  - The key angular fact is not fresnel, it is geometry. The two elements are 60 mm
 *    apart in a 28 mm tube, so past about 12° off the optical axis there is no clear
 *    path through both of them: everything behind the near element is the matte-black
 *    inner wall. A real sight does not read as a hole at that angle because the
 *    coating residual, the emitter spill and the dust on the glass are all you can
 *    see, and together they are plenty. So the presence of the element ramps up hard
 *    over the first ~25° off-axis and holds, instead of following a fresnel curve that
 *    only wakes up at 60°.
 *    The pleasant side effect is that the element visibly *clears* as the sight comes
 *    up to the eye, which is exactly what looking through a red dot feels like.
 *  - Glass is smooth, so it carries a *broad* sheen of whatever is in front of it as
 *    well as a tight sun glint. One narrow lobe alone is what made it look like a hole.
 *  - Nobody's optic is clean. A faint wipe pattern and edge haze keep the element from
 *    being an algebraically perfect void.
 */
// language=GLSL
const GLASS_FRAG = `
precision highp float;
varying vec3 vWN;
varying vec3 vWV;
varying vec2 vLocal;
uniform vec3 uTint;      // AR coating colour at normal incidence
uniform vec3 uTintMid;   // ... at ~45 degrees
uniform vec3 uTintEdge;  // ... at grazing
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uGlowColor;
uniform float uGlow;     // emitter bleed onto the element
uniform float uRadius;
uniform float uFresnel;
uniform float uBase;
uniform float uCoat;     // overall strength of the coating response
void main() {
  vec3 N = normalize( vWN );
  vec3 V = normalize( vWV );
  float ndv = clamp( abs( dot( N, V ) ), 0.0, 1.0 );
  float ang = 1.0 - ndv;              // 0 square-on, 1 edge-on
  float f4 = pow( ang, 4.0 );          // true fresnel tail
  vec3 R = reflect( -V, dot( N, V ) < 0.0 ? -N : N );
  // A cheap two-lobe environment: the real IBL is fed in from Lighting each frame.
  vec3 env = mix( uGround, uSky, smoothstep( -0.32, 0.5, R.y ) );
  float sd = max( dot( R, uSunDir ), 0.0 );
  float glint = pow( sd, 300.0 ) * 6.0;   // the sun itself
  float sheen = pow( sd, 16.0 ) * 0.45;   // the bright half of the sky around it

  float r = length( vLocal ) / max( 1e-4, uRadius );

  // "Off the aiming axis": 0 with your eye behind the sight, 1 by ~25 degrees out.
  float pres = smoothstep( 0.004, 0.105, ang );
  float graze = smoothstep( 0.20, 0.78, ang );

  // Thin-film interference: sweep the coating hue with incidence angle. The extra
  // radial term fakes the sweep a curved element shows across its own face.
  float hue = ang + r * 0.10;
  vec3 coat = mix(
    mix( uTint, uTintMid, smoothstep( 0.06, 0.42, hue ) ),
    uTintEdge,
    smoothstep( 0.40, 0.85, hue )
  );
  float coatAmt = uCoat * ( 0.07 + 0.85 * pres + 0.55 * graze );

  /* The coating residual is a REFLECTION, and it was being added as a constant.
   *
   * uTintEdge is a fixed colour, coatAmt runs to about 1.2 at hip angles, and the term
   * went straight into the sum with no environment factor at all — so the element put
   * out the same pastel lilac whether it was noon or midnight. Measured across a 4.2×
   * swing in ambient the lens moved 22 %: 111 under a 127 sky, 105 under a 57 night sky,
   * 127 in a room with an ambient of 30. That is not glass, that is an LED.
   *
   * A residual reflection cannot be brighter than what it is reflecting, so the whole
   * coating term now scales with the luminance of the environment the element faces.
   * The small floor is the residual of the *emitter and rim spill* inside the tube,
   * which genuinely is self-lit — but it is a floor of a few percent, not of 100 %. */
  float envLum = dot( env, vec3( 0.2126, 0.7152, 0.0722 ) );
  float coatLit = 0.04 + 2.1 * envLum;

  // Bevel + the haze of decades of lens tissue: brighter right at the field stop.
  float rim = smoothstep( 0.70, 1.0, r );
  // Wipe marks. Cheap, low-contrast, and it stops the element reading as a solid.
  float wipe = sin( vLocal.x * 640.0 + vLocal.y * 210.0 ) * sin( vLocal.y * 430.0 );
  float smudge = 0.020 + 0.030 * wipe * wipe;

  vec3 col = env * ( uBase + smudge + 0.09 * pres + 0.55 * f4 )
           + coat * coatAmt * coatLit
           + uSunColor * ( glint + sheen * ( 0.2 + 0.8 * pres ) )
           + env * rim * 0.4;
  /* The emitter sits low in the tube and throws a little red into the coating stack;
   * on a real red dot you can see that glow from well off the aiming axis, and it is
   * the cue that says "live optic" rather than "tube". It stays a *patch down by the
   * emitter*, not a wash: spread evenly over the element it turns the whole sight
   * picture pink, which is exactly what it did on the first pass. */
  float ey = ( vLocal.y / max( 1e-4, uRadius ) ) + 0.55;
  col += uGlowColor * uGlow * ( 0.25 * exp( -r * r * 5.0 ) + 0.85 * exp( -ey * ey * 9.0 ) );

  float a = clamp(
    uBase * 1.1 + smudge + pres * uFresnel * 0.55 + graze * uFresnel * 0.45
      + f4 * uFresnel * 0.4 + coatAmt * 0.30 + glint * 0.5 + rim * 0.42 + uGlow * 0.28,
    0.0, 1.0 );
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
uniform float uClip;      // ceiling on emitted radiance — see below
void main() {
  vec2 p = vLocal / max( 1e-5, uSize );
  float d = length( p );
  // A real dot is a hard, blown-out core with a *tight* bloom skirt. The wide skirt
  // that used to be here read as a 14 px pink smear instead of a 2 MOA aiming point.
  float dot0 = 1.7 * exp( -d * d * 26.0 ) + exp( -d * d * 4.6 ) + 0.16 * exp( -d * d * 1.15 );
  float a = dot0;
  if ( uRing > 0.0 ) {
    float rd = abs( d - uRing );
    float ring = exp( -rd * rd * 34.0 );
    // horseshoe: fade the top of the ring out
    ring *= smoothstep( 0.55, -0.1, normalize( p + vec2( 1e-6 ) ).y );
    a = max( a, ring * 0.85 );
  }
  a *= uIntensity * ( 0.93 + 0.07 * uJitter );
  if ( a < 0.002 ) discard;
  /* The emitted radiance is capped, the *alpha* is not.
   *
   * Additively blending uColor * a with a running to 15 does not make a brighter red
   * dot, it makes a white one: ACES desaturates hard above about 4, so the core clipped
   * out at (216,201,198) — a white pip with a red halo, which is what a blown-out
   * tungsten bulb looks like, not a 650 nm LED. A real emitter is monochromatic; the
   * core is *saturated* and the apparent size grows with brightness rather than the hue
   * washing out. Clipping the radiance and letting the skirt carry the intensity keeps
   * the dot red at every setting, and the bloom pass still sees a >1 pixel. */
  vec3 emit = uColor * min( a, uClip );
  gl_FragColor = vec4( emit, min( a, 1.0 ) );
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
  float f = pow( 1.0 - clamp( abs( dot( N, V ) ), 0.0, 1.0 ), 4.0 );
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
uniform float uMode;   // 0 = star card, 1 = forward gas jet
void main() {
  if ( uMode > 0.5 ) {
    // Jet: uv.y runs 0 at the crown to 1 at the tip.
    float t = clamp( vUvF.y, 0.0, 1.0 );
    float aj = uAmount * pow( 1.0 - t, 1.7 ) * ( 0.55 + 0.45 * sin( uSeed * 14.0 + t * 9.0 ) );
    if ( aj < 0.004 ) discard;
    vec3 cj = mix( uColorB, uColorA, 1.0 - t );
    gl_FragColor = vec4( cj * aj * 6.0, aj );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
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
      uTint: { value: new THREE.Color(0.05, 0.30, 0.24) },
      uTintMid: { value: new THREE.Color(0.09, 0.34, 0.66) },
      uTintEdge: { value: new THREE.Color(0.46, 0.20, 0.62) },
      uSky: { value: new THREE.Color(0.35, 0.46, 0.62) },
      uGround: { value: new THREE.Color(0.09, 0.085, 0.075) },
      uSunColor: { value: new THREE.Color(1.0, 0.92, 0.78) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.75, 0.5) },
      uGlowColor: { value: new THREE.Color(1.0, 0.12, 0.05) },
      uGlow: { value: 0.0 },
      uRadius: { value: 0.014 },
      uFresnel: { value: 0.78 },
      uBase: { value: 0.055 },
      uCoat: { value: 1.0 },
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
      uClip: { value: 2.6 },
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
      uMode: { value: 0.0 },
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
      // The viewmodel gets one shadow-casting key of its own (see
      // WeaponSystem.setupLights): the hands need to land on the receiver and the
      // optic needs to land on the rail, or nothing on the gun looks attached to it.
      m.castShadow = true;
      m.receiveShadow = true;
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

  // Contact darkening. Nothing in the viewmodel scene occludes anything — GTAO is
  // fitted to the world camera and the viewmodel meshes cast no shadows — so without a
  // bake every recess, slot, port and chamfer we just machined renders as a flat plane.
  bakeTree(root, { cell: 0.0028, maxDist: 0.026, amount: 1 });

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
      0.0019,
      1
    );
  }
  // Wider than a machinist would cut it. The chamfer is the carrier for the rub-through
  // wear that makes the receiver read as used, and at 720 p a 1.6 mm break on a part
  // 45 cm from the eye is three pixels — enough to alias, not enough to read.
  return chamferPoly(pts, 0.0022, 2);
}

function buildUpper(sink, b) {
  const R = b.receiver;
  const P = b.port;
  const full = upperSection(b, false);
  const cut = upperSection(b, true);

  sink.pair(extrudeG(full, { axis: 'z', from: R.z0, to: P.z0 }), 'anodised', 'anodisedEdge');
  /* The ejection port surround is scrubbed by hot brass, but this call chamfers the
   * *entire* receiver section, not just the port lip — on the rub-through shade it drew
   * a bright outline all the way round the upper. The section gets the ordinary bevel
   * and the wear goes on the port lip itself, below. */
  sink.pair(extrudeG(cut, { axis: 'z', from: P.z0, to: P.z1 }), 'anodised', 'anodisedEdge');
  // The lip the cases actually drag across, as its own strip.
  for (const py of [P.y0, P.y1]) {
    const lip = boxG(0.0022, 0.0016, P.z1 - P.z0 - 0.004, 0.0005, 1);
    sink.pair(lip, 'wearBright', 'wearBright', mTrans(R.halfW - 0.0011, py, (P.z0 + P.z1) * 0.5));
  }
  sink.pair(extrudeG(full, { axis: 'z', from: P.z1, to: R.z1 }), 'anodised', 'anodisedEdge');
  // Fore and aft walls of the port, so the cutout reads as a box and not a stripe.
  for (const [zw, sgn] of [[P.z0, 1], [P.z1, -1]]) {
    const wall = plainBoxG(P.depth, P.y1 - P.y0, 0.0016, { [sgn > 0 ? '-z' : '+z']: true });
    sink.pair(wall, 'bore', 'bore', mTrans(R.halfW - P.depth * 0.5, (P.y0 + P.y1) * 0.5, zw + sgn * 0.0008));
  }

  // Top rail runs the length of the flat-top upper. Its tooth tips are the highest
  // point on the weapon and every mount, sling and doorframe has been across them, so
  // the chamfers go to bare metal rather than to the ordinary edge shade.
  const rail = railG(Math.abs(b.rail.z1 - b.receiver.z0) + 0.001, b.rail.halfW, b.rail.y, { pitch: 0.0101 });
  const railM = mTrans(0, 0, (b.rail.z1 + b.receiver.z0) * 0.5);
  /* The tooth tips take the ordinary bare-aluminium edge shade rather than full
   * rub-through: at ten pixels a tooth there are four chamfer strips per tooth, and on
   * the brightest material on the gun that stops being a serrated rail and becomes a
   * band of white noise. The discrete handling points keep `wearBright`. */
  sink.pair(rail.body, 'anodised', 'anodisedEdge', railM);
  for (const s of rail.slots) sink.pair(s, 'steelDark', 'steelDark', railM.clone());

  // Brass deflector behind the port, and the port's rear wall.
  const defl = boxG(0.0155, 0.0225, 0.026, 0.0042, 2);
  sink.pair(defl, 'anodised', 'wearBright', mCompose(
    [R.halfW + 0.0052, P.y1 - 0.0045, P.z1 + 0.0135],
    new THREE.Euler(0, 0.38, 0.14)
  ));
  // Its leading face takes every case: a bright polished scar.
  const scar = plainBoxG(0.0016, 0.0135, 0.0165);
  sink.pair(scar, 'wearBright', 'wearBright', mCompose(
    [R.halfW + 0.0125, P.y1 - 0.005, P.z1 + 0.012],
    new THREE.Euler(0, 0.38, 0.14)
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
  // Forward assist: a thumb hits the face of it, so the rim is bare.
  sink.pair(fa, 'phosphate', 'wearBright', mCompose([R.halfW - 0.0022, P.y1 - 0.0055, 0], new THREE.Euler(0, Math.PI * 0.5 + 0.0, 0)));

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
      // Takedown pins get pushed with a punch or a cartridge rim: always bright.
      sink.pair(pin, 'phosphate', 'wearBright', mCompose(
        [s * (b.lower.halfW - 0.0005), b.lower.yTop - 0.006, z],
        new THREE.Euler(0, s * Math.PI * 0.5, 0)
      ));
    }
  }

  // Port interior: a dark recess wall so the cutout reads as an actual hole.
  const inner = boxG(0.0018, P.y1 - P.y0 - 0.001, P.z1 - P.z0 - 0.001, 0.0004, 1);
  sink.pair(inner, 'bore', 'bore', mTrans(R.halfW - P.depth - 0.0009, (P.y0 + P.y1) * 0.5, (P.z0 + P.z1) * 0.5));

  /* Machining. A billet upper is not a smooth extrusion: it carries lightening
   * pockets, a shell-deflector fence, roll pins and a hard panel line where the two
   * halves meet. Each of these is a couple of hundred triangles and each one is worth
   * more to the read than another thousand on a smooth surface. */
  // Lightening pockets on the left flank (the right is taken by the port).
  for (let i = 0; i < 2; i++) {
    const pz = R.z0 + 0.03 + i * 0.036;
    if (pz > P.z0 - 0.014) break;
    const pocket = plainBoxG(0.005, 0.011, 0.026, { '-x': true });
    sink.pair(pocket, 'bore', 'bore', mTrans(-(R.halfW - 0.0022), (R.yTop + R.yBot) * 0.5 + 0.002, pz));
    const lipT = boxG(0.0026, 0.0016, 0.027, 0.0006, 1);
    sink.pair(lipT, 'anodisedEdge', 'anodisedEdge', mTrans(-(R.halfW - 0.0008), (R.yTop + R.yBot) * 0.5 + 0.0075, pz));
    const lipB = boxG(0.0026, 0.0016, 0.027, 0.0006, 1);
    sink.pair(lipB, 'anodisedEdge', 'anodisedEdge', mTrans(-(R.halfW - 0.0008), (R.yTop + R.yBot) * 0.5 - 0.0035, pz));
  }
  // Panel line along the upper/lower split, both sides.
  for (const s of [1, -1]) {
    const line = plainBoxG(0.0016, 0.0013, R.z1 - R.z0 - 0.004);
    sink.pair(line, 'bore', 'bore', mTrans(s * (R.halfW - 0.0006), R.yBot + 0.0004, (R.z0 + R.z1) * 0.5));
  }
  // Roll pins through the receiver walls.
  for (const z of [P.z1 + 0.03, R.z0 + 0.052]) {
    for (const s of [1, -1]) {
      const pin = latheG(
        [
          [0.0021, -0.0006, 'hard'],
          [0.0021, 0.0008],
          [0.0016, 0.0013, 'hard edge'],
        ],
        8,
        { capEnd: true }
      );
      sink.pair(pin, 'steelDark', 'wearBright', mCompose(
        [s * (R.halfW - 0.0004), R.yTop - 0.009, z],
        new THREE.Euler(0, s * Math.PI * 0.5, 0)
      ));
    }
  }
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
  // Muzzle-end cap ring. The front of a handguard is what a weapon gets set down on.
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
          /* Window straight through the panel: dark walls, then the inner shroud
           * showing through, which is exactly what an M-LOK slot looks like.
           *
           * The panel section spans facet-local y ∈ [−thick, 0] about the placement
           * radius, so the window has to be sunk to match. It used to be centred on
           * the radius at 2.6× the panel thickness, which put its outer face 6 mm
           * *proud* of the handguard: a raised dark patch, not a slot. */
          const rP = H.r - thick * 0.5; // facet placement radius
          const winH = thick + 0.0022; // through the panel and a little past it
          const winY = -0.0004 - winH * 0.5; // outer face just below the surface
          const put = (dy, dx, geom, key) =>
            sink.pair(geom, key, key, mCompose(
              [
                Math.cos(ang) * (rP + dy) - Math.sin(ang) * dx,
                Math.sin(ang) * (rP + dy) + Math.cos(ang) * dx,
                c,
              ],
              rot
            ));
          put(winY, 0, plainBoxG(0.0088, winH, slotL, { '-y': true }), 'bore');
          // Chamfered lip along each long side of the window, flush with the panel, so
          // the opening catches a highlight instead of being a flat dark rectangle.
          for (const sx of [-1, 1]) {
            put(-thick * 0.24, sx * 0.0052, plainBoxG(0.0018, thick * 0.5, slotL), 'anodisedEdge');
          }
          // End caps: an M-LOK slot is a rounded-ended slot, not an open trench.
          for (const sz of [-1, 1]) {
            const cap = plainBoxG(0.0092, thick * 0.5, 0.0018);
            sink.pair(cap, 'anodisedEdge', 'anodisedEdge', mCompose(
              [
                Math.cos(ang) * (rP - thick * 0.24),
                Math.sin(ang) * (rP - thick * 0.24),
                c + sz * slotL * 0.5,
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
  /* The tooth tips take the ordinary bare-aluminium edge shade rather than full
   * rub-through: at ten pixels a tooth there are four chamfer strips per tooth, and on
   * the brightest material on the gun that stops being a serrated rail and becomes a
   * band of white noise. The discrete handling points keep `wearBright`. */
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
    0.0022,
    2
  );
  // The lower's bottom corners ride against plate carriers and truck seats all day —
  // but this is the chamfer of the whole spine, so it takes the machined bevel; the
  // discrete handling points (mag catch, bolt catch, magwell flare) carry the wear.
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
    0.0032,
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
    0.004,
    2
  ).pts;
  const lip = extrudeG(
    { pts: lipOuter, cham: null },
    { axis: 'y', from: M.yBot - 0.009, to: M.yBot, holes: [inner] }
  );
  // Every magazine change drags across this flare; it is always the brightest edge on
  // the lower receiver.
  sink.pair(lip, 'anodised', 'wearBright', wellM);

  // Trigger guard: swept loop.
  const tgSec = rectSection(0.0104, 0.0078, 0.002, 2);
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
  // The trigger guard is a handle in all but name — the support hand's knuckles, the
  // firing hand's second finger and every rack in the armoury have been across it.
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
  sink.pair(relBtn, 'phosphate', 'wearBright', mCompose(
    [L.halfW + 0.0012, L.yTop - 0.0085, M.z0 - 0.008],
    new THREE.Euler(0, Math.PI * 0.5, 0)
  ));
  // Checkering on the mag catch face, rubbed bright by a thumb.
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 3; k++) {
      const pip = plainBoxG(0.0009, 0.0011, 0.0011);
      sink.pair(pip, 'wearBright', 'wearBright', mTrans(
        L.halfW + 0.0044,
        L.yTop - 0.0085 + (i - 1) * 0.0019,
        M.z0 - 0.008 + (k - 1) * 0.0019
      ));
    }
  }

  // Magwell flute: the long oval scallop pressed into both sides of a magwell. It is
  // the one piece of shaping that stops the lower reading as a folded box.
  for (const s of [1, -1]) {
    const flute = plainBoxG(0.0044, halfD * 1.15, Math.abs(M.yTop - M.yBot) * 0.72, {
      [s > 0 ? '+x' : '-x']: true,
    });
    sink.pair(flute, 'bore', 'bore', mCompose(
      [s * (M.halfW - 0.0012), (M.yTop + M.yBot) * 0.5, (M.z0 + M.z1) * 0.5],
      new THREE.Euler(Math.PI * 0.5, 0, 0)
    ));
    for (const dy of [-1, 1]) {
      const lip = boxG(0.0022, 0.0016, halfD * 1.2, 0.0006, 1);
      sink.pair(lip, 'anodisedEdge', 'anodisedEdge', mTrans(
        s * (M.halfW - 0.0004),
        (M.yTop + M.yBot) * 0.5 + dy * Math.abs(M.yTop - M.yBot) * 0.36,
        (M.z0 + M.z1) * 0.5
      ));
    }
  }

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

  // Texture panels on both flats plus the front strap. Moulded grip stippling is
  // coarse and deep — it has to survive being seen through a gloved hand at 720p.
  for (const s of [1, -1]) {
    const st = stippleG(g.len * 0.66, g.d * 0.74, 5, 12, 0.0052, 0.0016);
    const mid = 0.52;
    const pos = [
      s * (g.w * 0.5 - 0.0004),
      g.y + dir.y * g.len * mid,
      g.z + dir.z * g.len * mid + 0.001,
    ];
    sink.add('polymerEdge', st, mCompose(pos, new THREE.Euler(g.angle, s * Math.PI * 0.5, Math.PI * 0.5)));
  }
  // Finger grooves on the front strap — the ridges *between* the fingers, which is
  // what makes a hand look like it has landed somewhere rather than nearby.
  for (let i = 0; i < 3; i++) {
    const t = 0.24 + i * 0.22;
    const groove = latheG(
      [
        [0.0042, -g.w * 0.44, 'hard'],
        [0.0042, g.w * 0.44, 'hard'],
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
  // Phosphate, not anodised: it is a different part from the shell around it, and the
  // value break is what makes the skeletonising cut read as a hole with something
  // behind it rather than as a painted-on shadow.
  sink.pair(latheG(prof, 20, { capEnd: true }), 'phosphate', 'phosphateEdge');
  // Length-of-pull detent ladder along the underside of the tube.
  for (let i = 0; i < 6; i++) {
    const z = z0 + 0.045 + i * 0.026;
    if (z > z1 - 0.03) break;
    const notch = plainBoxG(0.009, 0.0045, 0.008);
    sink.pair(notch, 'bore', 'bore', mTrans(0, -S.tubeR * 0.9, z));
    const lip = boxG(0.0092, 0.0014, 0.0018, 0.0004, 1);
    sink.pair(lip, 'phosphateEdge', 'phosphateEdge', mTrans(0, -S.tubeR * 0.99, z + 0.0045));
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
    /* A collapsible carbine stock is a thin polymer shell clamped around the buffer
     * tube, not a shoebox.
     *
     * Two things were wrong with the previous version and both are fixed here.
     *
     * 1. It was still the largest object in frame. A COD viewmodel is framed on the
     *    receiver and handguard; the butt is a tapering wedge that leaves the picture,
     *    not the hero shape. The comb has come down 4 mm (it was level with the rail,
     *    which is what made it read as a loaf), the section is narrower, the butt pad
     *    is 15 % shorter, and the whole assembly is shorter — see `stock.len` in
     *    WeaponDefs. The volume that is left has been pushed *down into the toe*, where
     *    it is out of the sight line and where the skeleton cut can live.
     *
     * 2. The skeletonising cut never existed. It was a `plainBoxG` tunnel *inside* a
     *    solid extrusion — there is no CSG here, so the shell's flanks still covered
     *    it and all it contributed was a faint dark outline on an unbroken surface.
     *    Worse, it was centred on the buffer tube, so even a real hole there would
     *    have been filled by the tube. It is now a genuine hole: a second loop passed
     *    to `extrudeG` as a hole, which triangulates both flank caps around it and
     *    walls the opening, placed *below* the tube where you can see daylight
     *    through it. */
    const precision = S.style === 'precision';
    const bodyW = precision ? 0.0405 : 0.0358;
    const zA = z0 + S.len * 0.16;
    const zR = z1 - 0.012;
    const combY = precision ? 0.0242 : 0.0176;
    const toeY = precision ? -0.0398 : -0.036;
    /* Section for an 'x' extrusion is (y, z). Rising comb, swept-back heel, dropped
     * toe kicked forward — the classic carbine silhouette. The bottom chain is broken
     * out because the skeleton window has to be fitted between it and the buffer tube,
     * and there is barely a centimetre to work with. */
    const zHeel = zR;
    const zToe = zR - 0.044;
    const zBelly = zA + 0.052;
    const yHeel = toeY * 0.83;
    // A near-straight toe rail rather than a swept belly. It costs nothing in the sight
    // line (all of it is below the bore) and it is the only way to find enough section
    // between the buffer tube and the underside for a skeleton window that reads.
    const yBelly = toeY * 0.92;
    const prof = chamferPoly(
      [
        [0.004, zA],
        [0.0142, zA + 0.03],
        [combY, zR - 0.05],
        [combY * 0.9, zR],
        [yHeel, zHeel],
        [toeY, zToe],
        [yBelly, zBelly],
        [-0.017, zA],
      ],
      0.0055,
      2
    );

    /* The skeleton window. It has to clear the buffer tube above it and the shell's
     * own bottom edge below it, so the numbers are derived rather than authored. */
    const cutTop = -S.tubeR - 0.0016;
    const cutZ0 = zR - 0.069;
    const cutZ1 = zR - 0.028;
    // Height of the shell's bottom edge at a given station.
    const bottomAt = (z) => {
      if (z <= zBelly) return yBelly;
      if (z <= zToe) return yBelly + ((z - zBelly) / Math.max(1e-5, zToe - zBelly)) * (toeY - yBelly);
      return toeY + ((z - zToe) / Math.max(1e-5, zHeel - zToe)) * (yHeel - toeY);
    };
    // Shallowest point anywhere under the window, plus a wall thickness.
    const cutBot = Math.max(bottomAt(cutZ0), bottomAt(cutZ1), bottomAt(zToe)) + 0.0038;
    const cutH = cutTop - cutBot;
    const holeLoop =
      cutH > 0.004
        ? chamferPoly(
            [
              [cutBot, cutZ0],
              [cutTop, cutZ0],
              [cutTop, cutZ1],
              [cutBot, cutZ1],
            ],
            Math.min(0.0024, cutH * 0.4),
            2
          ).pts
        : null;

    sink.pair(
      extrudeG(prof, {
        axis: 'x',
        from: -bodyW * 0.5,
        to: bodyW * 0.5,
        holes: holeLoop ? [holeLoop] : [],
      }),
      'polymer',
      'polymerEdge'
    );

    if (holeLoop) {
      // A chamfered lip standing just proud of each flank around the opening. It is
      // what makes the hole read as a moulded window with wall thickness rather than
      // as a decal, and it is the brightest thing on the stock.
      const cutL = cutZ1 - cutZ0;
      const cutY = (cutTop + cutBot) * 0.5;
      const cutZc = cutZ0 + cutL * 0.5;
      // Sat just *outside* the opening on every side: a lip that overhangs the hole
      // would eat a third of the only 9 mm of daylight there is to be had.
      for (const sx of [1, -1]) {
        for (const dz of [-1, 1]) {
          const lip = boxG(0.0028, cutH + 0.0056, 0.0032, 0.001, 1);
          sink.pair(lip, 'polymerEdge', 'polymerEdge', mTrans(
            sx * (bodyW * 0.5 - 0.0009),
            cutY,
            cutZc + dz * (cutL * 0.5 + 0.0015)
          ));
        }
        for (const dy of [-1, 1]) {
          const lip = boxG(0.0028, 0.0032, cutL + 0.006, 0.001, 1);
          sink.pair(lip, 'polymerEdge', 'polymerEdge', mTrans(
            sx * (bodyW * 0.5 - 0.0009),
            cutY + dy * (cutH * 0.5 + 0.0015),
            cutZc
          ));
        }
      }
    }
    // Sling slot through the toe, and a moulded QD socket boss.
    const slot = plainBoxG(bodyW * 1.1, 0.0075, 0.021);
    sink.pair(slot, 'bore', 'bore', mTrans(0, toeY + 0.006, zR - 0.0165));

    /* Butt: a hard polymer plate with a soft rubber pad on it. The pad gets a proper
     * toe/heel taper and its own, much coarser ribbing — four parts wearing the same
     * detail frequency is what made the old stock read as corduroy. */
    const plate = boxG(bodyW * 1.0, 0.0485, 0.011, 0.0045, 2);
    sink.pair(plate, 'polymer', 'polymerEdge', mCompose([0, -0.008, zR + 0.0035], new THREE.Euler(-0.11, 0, 0)));
    const padProf = chamferPoly(
      [
        [0.0215, 0.0],
        [0.0252, 0.006],
        [0.0205, 0.0125],
        [-0.0248, 0.0135],
        [-0.028, 0.006],
        [-0.0238, 0.0],
      ],
      0.0035,
      2
    );
    sink.pair(
      extrudeG(padProf, { axis: 'x', from: -bodyW * 0.48, to: bodyW * 0.48 }),
      'rubber',
      'rubber',
      mCompose([0, -0.008, zR + 0.0085], new THREE.Euler(-0.11, 0, 0))
    );
    for (let i = 0; i < 4; i++) {
      const groove = plainBoxG(bodyW * 0.96, 0.0018, 0.0018);
      sink.pair(groove, 'bore', 'bore', mCompose(
        [0, 0.0105 - i * 0.0098, zR + 0.0205],
        new THREE.Euler(-0.11, 0, 0)
      ));
    }

    if (S.cheek) {
      // Adjustable riser sitting *on* the comb, with its posts and detent ladder.
      const riserZ = zR - S.len * 0.3;
      const riserL = S.len * 0.42;
      // Down on its lowest setting: a riser standing proud of the comb puts back all
      // the section height the stock was just trimmed of, and reads as a bread loaf.
      /* Riser on its lowest setting but not bottomed out: a 3 mm gap with the guide
       * posts crossing it. The posts used to be 8.5 mm long against a comb the riser
       * sat flush on, so with the thinner riser they came straight out through the top
       * of it as a white speculary smear on the cheek piece. */
      const riserY = combY + 0.0062;
      const cheek = boxG(bodyW * 0.86, 0.0078, riserL, 0.0038, 2);
      sink.pair(cheek, 'polymer', 'polymerEdge', mCompose(
        [0, riserY, riserZ],
        new THREE.Euler(precision ? -0.05 : -0.03, 0, 0)
      ));
      // Moulded cheek texture: shallow and fine, not waffle.
      // Body shade, not the scuffed-edge shade: the comb faces the key light, so on the
      // lighter tone the moulded texture came out as a scatter of white dots.
      const combTex = stippleG(bodyW * 0.58, riserL * 0.74, 3, 8, 0.0058, 0.00055);
      sink.add('polymer', combTex, mCompose(
        [0, riserY + 0.0039, riserZ],
        new THREE.Euler(-Math.PI * 0.5 + (precision ? -0.05 : -0.03), 0, 0)
      ));
      for (const s of [1, -1]) {
        const post = latheG(
          [
            [0.0032, 0.0, 'hard'],
            [0.0032, 0.0052],
          ],
          10
        );
        // Parkerised, not bright: a 3 mm polished pin at this distance is a single
        // blown-out pixel that blooms into a white smear on the cheek piece.
        sink.pair(post, 'steelDark', 'steelDark', mCompose(
          [s * bodyW * 0.26, combY - 0.0006, riserZ + riserL * 0.34],
          new THREE.Euler(Math.PI * 0.5, 0, 0)
        ));
      }
    }
    // Length-of-pull latch: a lever on a pivot, under the tube, where a hand grabs it.
    const lever = boxG(0.0105, 0.021, 0.026, 0.0028, 2);
    sink.pair(lever, 'polymer', 'polymerEdge', mCompose([0, toeY * 0.86, zA + 0.026], new THREE.Euler(0.28, 0, 0)));
    for (let i = 0; i < 3; i++) {
      const rib = plainBoxG(0.0105, 0.0018, 0.0022);
      sink.pair(rib, 'bore', 'bore', mTrans(0, toeY * 0.86 - 0.008 + i * 0.006, zA + 0.0385));
    }
    const pivot = latheG(
      [
        [0.0026, -0.0062, 'hard'],
        [0.0026, 0.0062, 'hard'],
      ],
      10,
      { capStart: true, capEnd: true }
    );
    sink.pair(pivot, 'wearBright', 'wearBright', mCompose(
      [0, toeY * 0.72, zA + 0.014],
      new THREE.Euler(0, Math.PI * 0.5, 0)
    ));
    // QD sling cup on the left flank.
    const cup = latheG(
      [
        [0.0062, -0.002, 'hard'],
        [0.0062, 0.002],
        [0.0044, 0.003, 'hard edge'],
      ],
      12,
      { capEnd: true }
    );
    sink.pair(cup, 'steelDark', 'wearBright', mCompose(
      [-bodyW * 0.5, -0.01, zA + 0.024],
      new THREE.Euler(0, -Math.PI * 0.5, 0)
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
  const shaft = boxG(0.03, 0.0075, 0.052, 0.0016, 1);
  sink.pair(shaft, 'anodised', 'wearBright', mTrans(0, R.yTop - 0.0072, z - 0.024));
  const wing = boxG(0.02, 0.0125, 0.0085, 0.002, 2);
  sink.pair(wing, 'anodised', 'wearBright', mCompose([-0.0205, R.yTop - 0.0075, z + 0.002], new THREE.Euler(0, 0, 0.08)));
  const bar = boxG(0.05, 0.0092, 0.0085, 0.0019, 2);
  // Handling wear: a charging handle latch is grabbed every single time the weapon is
  // loaded, so the anodising is long gone and bare aluminium shows through.
  sink.pair(bar, 'anodised', 'wearBright', mTrans(0, R.yTop - 0.0075, z + 0.002));
  // Serrations on the latch.
  for (let i = 0; i < 6; i++) {
    const s = plainBoxG(0.0016, 0.0094, 0.0019);
    sink.pair(s, 'wearBright', 'wearBright', mTrans(-0.0128 - i * 0.0034, R.yTop - 0.0075, z + 0.0056));
    const s2 = plainBoxG(0.0016, 0.0094, 0.0019);
    sink.pair(s2, 'wearBright', 'wearBright', mTrans(0.0128 + i * 0.0034, R.yTop - 0.0075, z + 0.0056));
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
  const rib = boxG(0.0014, 0.0022, l * 0.86, 0.0005, 1);
  sink.pair(rib, 'wearBright', 'wearBright', mTrans(0.0028, h * 0.55, 0));
  // Parting line where the cover meets the receiver: a genuine dark gap, so the cover
  // reads as a separate part rather than as paint on the side of the upper.
  const gap = plainBoxG(0.0026, 0.0011, l);
  sink.pair(gap, 'bore', 'bore', mTrans(0.0013, h - 0.0004, 0));
  const gap2 = plainBoxG(0.0026, 0.0011, l);
  sink.pair(gap2, 'bore', 'bore', mTrans(0.0013, 0.0004, 0));
}

function buildTrigger(sink, b) {
  const g = b.grip;
  const z = g.z + 0.0165;
  const y = b.lower.yTop - 0.0125;
  // Thick enough to survive 720p: a 2 px dark line is not a trigger.
  const sec = rectSection(0.0072, 0.0042, 0.0019, 2);
  const path = [];
  for (let i = 0; i <= 7; i++) {
    const t = i / 7;
    path.push([0, y - 0.0205 * t, z + 0.0062 * Math.sin(t * 2.2) - 0.0015 * t]);
  }
  sink.pair(sweepG(sec, path, { up: [1, 0, 0] }), 'steelDark', 'wearBright');
  // Trigger shoe serrations — polished by a finger.
  for (let i = 0; i < 5; i++) {
    const s = plainBoxG(0.0068, 0.0011, 0.0013);
    sink.pair(s, 'wearBright', 'wearBright', mTrans(0, y - 0.0068 - i * 0.0034, z + 0.0056));
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
    // A thumb rides this every time the weapon comes up: worn bright on the edges.
    const lever = boxG(0.0058, 0.0235, 0.0078, 0.0022, 2);
    sink.pair(lever, 'phosphate', 'wearBright', mCompose(
      [s * (L.halfW + 0.0037), y - 0.0085, z],
      new THREE.Euler(0, 0, 0)
    ));
    const detent = plainBoxG(0.0062, 0.0022, 0.0026);
    sink.pair(detent, 'wearBright', 'wearBright', mTrans(s * (L.halfW + 0.0055), y - 0.016, z));
  }
}

function buildBoltCatch(sink, b) {
  const L = b.lower;
  const z = b.magwell.z1 + 0.012;
  const paddle = boxG(0.0055, 0.0118, 0.027, 0.0022, 2);
  sink.pair(paddle, 'phosphate', 'wearBright', mCompose(
    [-(L.halfW + 0.002), L.yTop - 0.0065, z],
    new THREE.Euler(0, 0, 0.1)
  ));
  for (let i = 0; i < 4; i++) {
    const rib = plainBoxG(0.0058, 0.0016, 0.0018);
    sink.pair(rib, 'wearBright', 'wearBright', mTrans(-(L.halfW + 0.0046), L.yTop - 0.0065, z - 0.008 + i * 0.0053));
  }
  const upper = boxG(0.0055, 0.009, 0.0095, 0.0014, 2);
  sink.pair(upper, 'phosphate', 'wearBright', mTrans(-(L.halfW + 0.002), L.yTop - 0.0025, z + 0.019));
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

  // Feed lips: steel, and proud of the body, because that is the part the magwell
  // actually indexes on.
  const lips = boxG(M.w * 1.03, 0.0105, M.d * 1.05, 0.002, 2);
  sink.pair(lips, 'steelDark', 'wearBright', mTrans(0, M.yTop + 0.004, M.z));

  /* Floorplate: a separate part with a real parting line and a finger ledge, not a
   * slab merged into the body. The parting line is what sells it as removable. */
  const last = path[path.length - 1];
  const tilt = new THREE.Euler(M.len / R, 0, 0);
  const parting = plainBoxG(M.w * 1.16, 0.0016, M.d * 1.2);
  sink.pair(parting, 'bore', 'bore', mCompose([0, last[1] + 0.0035, last[2]], tilt));
  const bp = boxG(M.w * 1.18, 0.0115, M.d * 1.2, 0.0028, 2);
  sink.pair(bp, 'polymer', 'polymerEdge', mCompose([0, last[1] - 0.0035, last[2]], tilt));
  // Front lip you hook a finger under to strip the plate off.
  const ledge = boxG(M.w * 1.2, 0.006, 0.008, 0.002, 2);
  sink.pair(ledge, 'polymerEdge', 'polymerEdge', mCompose(
    [0, last[1] - 0.0075, last[2] - M.d * 0.56],
    tilt
  ));
  const bpGrip = boxG(M.w * 1.04, 0.0045, M.d * 0.56, 0.0014, 1);
  sink.pair(bpGrip, 'rubber', 'rubber', mCompose([0, last[1] - 0.0105, last[2]], tilt));

  /* Witness holes: real rectangular windows with a raised, chamfered surround. Round
   * 2.8 mm pinpricks vanish at 720p; the surround is what makes them read. */
  const wCount = M.witness || 4;
  for (let i = 0; i < wCount; i++) {
    const t = 0.22 + (i / Math.max(1, wCount - 1)) * 0.58;
    const idx = Math.min(n, Math.round(t * n));
    const p = path[idx];
    for (const s of [1, -1]) {
      // Raised boss around the window.
      const boss = boxG(0.0125, 0.0088, 0.0022, 0.0009, 1);
      sink.pair(boss, 'polymerEdge', 'polymerEdge', mCompose(
        [s * (M.w * 0.5 + 0.0004), p[1], p[2]],
        new THREE.Euler(0, 0, 0)
      ));
      // The window itself: mouth proud of the boss face, outer face omitted, so the
      // camera looks straight into a dark interior instead of at the front of a bump.
      const win = plainBoxG(0.0042, 0.0056, 0.0096, { [s > 0 ? '+x' : '-x']: true });
      sink.pair(win, 'bore', 'bore', mTrans(s * (M.w * 0.5 + 0.0009), p[1], p[2]));
    }
  }
  // Longitudinal reinforcing ribs down both flanks, plus a spine on the front.
  for (const s of [1, -1]) {
    const rib = sweepG(rectSection(0.0032, 0.0024, 0.0007, 1), path.map((p) => [s * (M.w * 0.5 - 0.0004), p[1], p[2]]), {
      up: [0, 0, 1],
    });
    sink.pair(rib, 'polymerEdge', 'polymerEdge');
  }
  {
    const spine = sweepG(
      rectSection(0.0026, 0.0022, 0.0006, 1),
      path.map((p) => [0, p[1], p[2] - M.d * 0.5]),
      { up: [1, 0, 0] }
    );
    sink.pair(spine, 'polymerEdge', 'polymerEdge');
  }
  // Grip texture panels on the flanks, so the magazine is visibly a different
  // substance from the aluminium above it.
  for (const s of [1, -1]) {
    const idx = Math.round(n * 0.62);
    const p = path[idx];
    const st = stippleG(M.len * 0.3, M.d * 0.62, 4, 10, 0.0042, 0.0009);
    sink.add('polymerEdge', st, mCompose(
      [s * (M.w * 0.5 - 0.0002), p[1], p[2]],
      new THREE.Euler(M.len / R * 0.6, s * Math.PI * 0.5, Math.PI * 0.5)
    ));
  }

  for (const m of sink.meshes(mats, 'mag')) group.add(m);

  // Follower + top cartridge, animated when the mag empties.
  const fs = new Sink();
  const fol = boxG(M.w * 0.82, 0.006, M.d * 0.8, 0.0012, 1);
  fs.pair(fol, 'polymerEdge', 'polymerEdge');
  // Top round in the stack: case head at the rear, bullet pointing down the bore.
  const cr = M.w * 0.19;
  const cl = M.d * 0.92;
  const rnd = latheG(
    [
      [cr * 1.08, cl * 0.5, 'hard'],
      [cr * 1.08, cl * 0.42, 'hard edge'],
      [cr, cl * 0.36],
      [cr, -cl * 0.06],
      [cr * 0.78, -cl * 0.16, 'hard'],
      [cr * 0.72, -cl * 0.3],
      [cr * 0.42, -cl * 0.44],
      [cr * 0.1, -cl * 0.5],
    ],
    12,
    { capStart: true }
  );
  /* The top of the stack. On the ejected-case brass it was an orange bulb glowing in
   * the magwell in every pose; a loaded round is lacquered, dull and mostly in shadow
   * under the feed lips, so it sits 1.4 mm lower and takes the `cartridge` shade. */
  fs.pair(rnd, 'cartridge', 'cartridge', mTrans(0, 0.0048, 0));
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
  sink.pair(extrudeG(clamp2, { axis: 'z', from: zF + 0.012, to: zB - 0.012 }), 'opticBody', 'opticEdge');
  const recoilLug = boxG(0.0092, 0.005, 0.005, 0.0008, 1);
  sink.pair(recoilLug, 'opticBody', 'opticEdge', mTrans(0, 0.0018, 0));
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
  /* Mount hardware. Two cap screws through the clamp into the base, with a real slot
   * across each head. At 8× the mount was a smooth block: no fasteners anywhere, which
   * is the single fastest way for a machined part to read as a toy. */
  for (const sz of [zF + 0.019, zB - 0.019]) {
    const head = latheG(
      [
        [0.0036, 0, 'hard'],
        [0.0036, 0.0022],
        [0.0029, 0.0027, 'hard edge'],
      ],
      12,
      { capEnd: true }
    );
    sink.pair(head, 'steelBright', 'steelBright', mCompose([0.0142, mountH * 0.62, sz], new THREE.Euler(0, Math.PI * 0.5, 0)));
    const slot = plainBoxG(0.0009, 0.0056, 0.0012);
    sink.pair(slot, 'bore', 'bore', mCompose([0.0158, mountH * 0.62, sz], new THREE.Euler(0, Math.PI * 0.5, 0.5)));
  }

  /* Tube body.
   *
   * Two changes over the smooth pill it used to be: a *bell* at the objective — a real
   * reflex housing flares over the front element to shade it and to carry the hood —
   * and 40 radial segments instead of 22. At 22 the objective silhouette was a
   * countable polygon at any sensible zoom; the tube is the roundest thing on the
   * weapon and it has to survive being looked at.
   */
  const RAD = 40;
  const bellR = tubeR * 1.1;
  const tube = latheG(
    [
      [bellR, zF, 'hard'],
      [bellR, zF + 0.0055],
      [bellR * 0.965, zF + 0.0075, 'hard edge'],
      [tubeR * 0.99, zF + 0.016],
      [tubeR * 0.94, zF + 0.021, 'hard edge'],
      [tubeR * 0.94, zB - 0.016],
      [tubeR, zB - 0.012, 'hard edge'],
      [tubeR, zB, 'hard'],
    ],
    RAD
  );
  sink.pair(tube, 'opticBody', 'opticEdge', mTrans(0, axisY, 0));
  /* Interior. `bore` is double-sided (see makeWeaponMaterials) so this is now an
   * actually opaque near-black wall rather than a set of culled back faces the camera
   * looked straight through — which is what left the element with nothing dark behind
   * it and made it read as a self-lit bubble. Three baffle rings, because a smooth
   * black cone still reads as a hole. */
  const bore = latheG(
    [
      [glassR + 0.0016, zF + 0.0018, 'hard'],
      [glassR + 0.0016, zB - 0.0018, 'hard'],
    ],
    RAD
  );
  sink.pair(bore, 'bore', 'bore', mTrans(0, axisY, 0));
  for (let i = 0; i < 3; i++) {
    const bz = zF + 0.018 + i * 0.017;
    if (bz > zB - 0.016) break;
    const baffle = discG(glassR + 0.0016, bz, 1, RAD, glassR * 0.9);
    sink.add('bore', baffle, mTrans(0, axisY, 0));
  }
  /* Front and rear bezels (annuli closing the tube around the glass). These are broad
   * *faces*, not chamfers — the rear one is the ring you stare at through the whole of
   * ADS — so they take the dark body material. Keyed to the edge shade they became a
   * bright grey doughnut around the sight picture. */
  sink.add('opticBody', discG(bellR * 0.99, zF + 0.0015, -1, RAD, glassR), mTrans(0, axisY, 0));
  sink.add('opticBody', discG(tubeR * 0.99, zB - 0.0015, 1, RAD, glassR), mTrans(0, axisY, 0));

  // Hood ribs over the objective, on the bell.
  for (let i = 0; i < 2; i++) {
    const rib = latheG(
      [
        [bellR * 1.005, zF + 0.0016 + i * 0.0044, 'hard'],
        [bellR * 1.035, zF + 0.0026 + i * 0.0044, 'hard edge'],
        [bellR * 1.005, zF + 0.0036 + i * 0.0044, 'hard'],
      ],
      RAD
    );
    sink.pair(rib, 'opticBody', 'opticEdge', mTrans(0, axisY, 0));
  }

  /* Turrets: elevation on top, windage on the right.
   *
   * The knurl used to be ten 1.1 mm pegs standing 0 mm proud of a 12.4 mm cylinder —
   * sub-pixel, and keyed to a shade 3.8× the housing so all it contributed was
   * sparkle. It is now eighteen real flutes cut as boxes that straddle the surface,
   * plus a screwdriver slot across the cap and an index mark, so the turret reads as an
   * adjustable control instead of a bottle top. */
  const turret = (rot, pos) => {
    const t = latheG(
      [
        [0.0072, 0, 'hard'],
        [0.0072, 0.0052],
        [0.0064, 0.006, 'hard edge'],
        [0.0064, 0.0098],
        [0.0049, 0.0106, 'hard edge'],
      ],
      18,
      { capEnd: true }
    );
    const base = mCompose(pos, rot);
    sink.pair(t, 'opticBody', 'opticEdge', base);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU;
      const kn = plainBoxG(0.0012, 0.0012, 0.0034);
      const local = mCompose(
        [0.0064 * Math.cos(a), 0.0064 * Math.sin(a), 0.0079],
        new THREE.Euler(0, 0, a)
      );
      sink.pair(kn, 'opticEdge', 'opticEdge', new THREE.Matrix4().multiplyMatrices(base, local));
    }
    // Coin slot across the cap, and the zero index scored into the shoulder.
    const slot = plainBoxG(0.0011, 0.0082, 0.0014);
    sink.pair(slot, 'bore', 'bore', new THREE.Matrix4().multiplyMatrices(base, mTrans(0, 0, 0.0104)));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.12;
      const tick = plainBoxG(0.0006, 0.0022, 0.0009);
      const local = mCompose(
        [0.00725 * Math.cos(a), 0.00725 * Math.sin(a), 0.0026],
        new THREE.Euler(0, 0, a)
      );
      sink.pair(tick, 'bore', 'bore', new THREE.Matrix4().multiplyMatrices(base, local));
    }
  };
  turret(new THREE.Euler(-Math.PI * 0.5, 0, 0), [0, axisY + tubeR * 0.9, 0.006]);
  turret(new THREE.Euler(0, Math.PI * 0.5, 0), [tubeR * 0.9, axisY, 0.006]);
  /* Housing markings: an engraved panel on the left flank and a serial block behind it.
   * Recessed `bore` strokes, so they read as engraving in any light instead of as a
   * decal that has to be lit. */
  for (let i = 0; i < 5; i++) {
    const mark = plainBoxG(0.0008, 0.0026, 0.0032 - (i % 2) * 0.0009);
    sink.add('bore', mark, mTrans(-tubeR * 0.965, axisY - tubeR * 0.36, zB - 0.03 + i * 0.0052));
  }
  // Battery cap on the left.
  const cap = latheG(
    [
      [0.0068, 0, 'hard'],
      [0.0068, 0.0042],
      [0.0055, 0.005, 'hard edge'],
    ],
    16,
    { capEnd: true }
  );
  const capM = mCompose([-tubeR * 0.9, axisY, -0.004], new THREE.Euler(0, -Math.PI * 0.5, 0));
  sink.pair(cap, 'opticBody', 'opticEdge', capM);
  // Coin slot in the battery cap, and the six grip flutes round its rim.
  sink.pair(plainBoxG(0.0011, 0.0084, 0.0013), 'bore', 'bore', new THREE.Matrix4().multiplyMatrices(capM, mTrans(0, 0, 0.0048)));
  for (let i = 0; i < 8; i++) {
    const a2 = (i / 8) * TAU;
    const fl = plainBoxG(0.0012, 0.0012, 0.003);
    const local = mCompose([0.0068 * Math.cos(a2), 0.0068 * Math.sin(a2), 0.0022], new THREE.Euler(0, 0, a2));
    sink.pair(fl, 'opticEdge', 'opticEdge', new THREE.Matrix4().multiplyMatrices(capM, local));
  }

  for (const m of sink.meshes(mats, 'reddot')) group.add(m);
  bakeTree(group, { cell: 0.0022, maxDist: 0.018 });

  /* glass — optically FLAT.
   * A reflex sight is a window, not a lens: the sight picture is 1:1 with the world,
   * dead sharp, with the AR coating showing only as a blue-purple bloom at the rim. A
   * bulged, double-sided element displaces and doubles the background through the tube
   * and instantly reads as a glass marble instead of a coated window. */
  const gmat = mats._optics.glass.clone();
  gmat.uniforms = THREE.UniformsUtils.clone(mats._optics.glass.uniforms);
  gmat.uniforms.uRadius.value = glassR;
  // Objective: a green-square / cyan / violet stack, the common broadband AR on a
  // reflex front element. It is also the surface the emitter reflects off, so it is
  // deliberately the stronger of the two.
  gmat.uniforms.uTint.value.setRGB(0.028, 0.145, 0.125);
  gmat.uniforms.uTintMid.value.setRGB(0.038, 0.17, 0.36);
  gmat.uniforms.uTintEdge.value.setRGB(0.27, 0.11, 0.38);
  gmat.uniforms.uBase.value = 0.03;
  gmat.uniforms.uFresnel.value = 0.92;
  gmat.uniforms.uCoat.value = 1.0;
  gmat.side = THREE.FrontSide;
  const front = new THREE.Mesh(discG(glassR, 0, 1, RAD), gmat);
  front.position.set(0, axisY, zF + 0.0052);
  front.renderOrder = 10; // far -> near: front element, reticle, ocular element
  front.frustumCulled = false;
  group.add(front);
  const rearMat = gmat.clone();
  rearMat.uniforms = THREE.UniformsUtils.clone(gmat.uniforms);
  // Ocular: a warmer, weaker stack, so the two elements do not read as one sheet.
  rearMat.uniforms.uBase.value = 0.02;
  rearMat.uniforms.uFresnel.value = 0.68;
  rearMat.uniforms.uCoat.value = 0.78;
  rearMat.uniforms.uTint.value.setRGB(0.055, 0.095, 0.185);
  rearMat.uniforms.uTintMid.value.setRGB(0.15, 0.085, 0.26);
  rearMat.uniforms.uTintEdge.value.setRGB(0.3, 0.14, 0.3);
  rearMat.side = THREE.FrontSide;
  const rear = new THREE.Mesh(discG(glassR, 0, 1, RAD), rearMat);
  rear.position.set(0, axisY, zB - 0.005);
  rear.renderOrder = 12;
  rear.frustumCulled = false;
  group.add(rear);

  /* reticle */
  const rmat = mats._optics.reticle.clone();
  rmat.uniforms = THREE.UniformsUtils.clone(mats._optics.reticle.uniforms);
  // A 2 MOA dot is a hard, tiny, blown-out core with a tight bloom — not a soft smear.
  rmat.uniforms.uSize.value = (o.dotMoa ?? 2) * 0.00092;
  rmat.uniforms.uRing.value = o.ring ? 5.4 : 0;
  rmat.uniforms.uIntensity.value = 9.0;
  // 650 nm. Not a hint of green: what little there is has to survive the ACES matrix.
  rmat.uniforms.uColor.value.setRGB(1.0, 0.035, 0.008);
  rmat.uniforms.uClip.value = 2.7;
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
    glassR,
    planeZ: zF + 0.012,
    // Apparent angular size of the dot core. A true 2 MOA dot is 0.6 mrad — sub-pixel
    // at any sane render resolution — but a camera blooms it, so this is the size a
    // real one *reads* as. It was nearly twice this, which put a 14 px pink smear over
    // the target instead of an aiming point.
    dotRad: o.dotRad ?? (o.ring ? 0.0046 : 0.0034),
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
    sink.pair(base, 'opticBody', 'opticEdge', mTrans(0, mountH * 0.5, z));
    const ring = latheG(
      [
        [tubeR * 1.16, -0.0095, 'hard'],
        [tubeR * 1.16, 0.0095, 'hard'],
      ],
      18,
      { capStart: true, capEnd: true }
    );
    sink.pair(ring, 'opticBody', 'opticEdge', mTrans(0, axisY, z));
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
        new THREE.Euler(-Math.PI * 0.5, 0, s > 0 ? -0.5 : 0.5)
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
  sink.pair(body, 'opticBody', 'opticEdge', mTrans(0, axisY, 0));
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
  // A face, not a chamfer — see the note on the reflex sight's bezels.
  sink.add('opticBody', discG(objR * 0.99, zF + 0.003, -1, 24, objR * 0.82), mTrans(0, axisY, 0));

  // Magnification ring knurling.
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * TAU;
    const kn = plainBoxG(0.0014, 0.0014, 0.016);
    sink.pair(kn, 'opticBody', 'opticEdge', mTrans(
      Math.cos(a) * tubeR * 1.2,
      axisY + Math.sin(a) * tubeR * 1.2,
      zF + 0.099
    ));
  }
  // Turrets.
  for (const [rot, pos] of [
    [new THREE.Euler(-Math.PI * 0.5, 0, 0), [0, axisY + tubeR * 0.95, zF + 0.062]],
    [new THREE.Euler(0, Math.PI * 0.5, 0), [tubeR * 0.95, axisY, zF + 0.062]],
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
    sink.pair(t, 'opticBody', 'opticEdge', mCompose(pos, rot));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const kn = plainBoxG(0.0013, 0.0013, 0.009);
      const local = new THREE.Matrix4().makeTranslation(0.0088 * Math.cos(a), 0.0088 * Math.sin(a), 0.0115);
      sink.pair(kn, 'opticBody', 'opticEdge', new THREE.Matrix4().multiplyMatrices(mCompose(pos, rot), local));
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
  bakeTree(group, { cell: 0.0024, maxDist: 0.02 });

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
  // The ocular sits on top of the *sight picture*, so its coating is held back: enough
  // magenta bloom to say "there is glass here", not enough to tint the target.
  gmat.uniforms.uCoat.value = 0.45;
  gmat.uniforms.uTint.value.setRGB(0.16, 0.09, 0.24);
  gmat.uniforms.uTintMid.value.setRGB(0.26, 0.12, 0.36);
  gmat.uniforms.uTintEdge.value.setRGB(0.4, 0.2, 0.4);
  const oc = new THREE.Mesh(lensG(ocR * 0.84, 0.0009, 1, 3, 26), gmat);
  oc.position.set(0, axisY, zB - 0.0125);
  oc.renderOrder = 12;
  oc.frustumCulled = false;
  group.add(oc);

  const objMat = gmat.clone();
  objMat.uniforms = THREE.UniformsUtils.clone(gmat.uniforms);
  objMat.uniforms.uRadius.value = objR * 0.82;
  // The objective is what everyone else looks at, so it gets the full coating sweep.
  objMat.uniforms.uTint.value.setRGB(0.03, 0.15, 0.12);
  objMat.uniforms.uTintMid.value.setRGB(0.04, 0.17, 0.36);
  objMat.uniforms.uTintEdge.value.setRGB(0.27, 0.11, 0.36);
  objMat.uniforms.uCoat.value = 1.0;
  objMat.uniforms.uBase.value = 0.035;
  objMat.uniforms.uFresnel.value = 0.9;
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
  bakeTree(group, { cell: 0.0018, maxDist: 0.014 });
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
  bakeTree(group, { cell: 0.0018, maxDist: 0.014 });
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
  bakeTree(group, { cell: 0.0022, maxDist: 0.018 });
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

  const palmW = 0.079;
  const palmL = 0.089;
  const palmT = 0.029;
  // A hand gripping a 48 mm tube is not a flat paddle: the metacarpal arch folds the
  // knuckle block toward the palm. Two segments with a break between them is the
  // cheapest thing that reads as a hand closing around something.
  const bend = o.palmBend ?? 0.55;
  const proxL = palmL * 0.55;
  const distL = palmL * 0.45;
  const prox = boxG(palmW, proxL, palmT, 0.011, 2);
  sink.pair(prox, 'glove', 'glove', mTrans(0, proxL * 0.5, 0));
  const thenar = boxG(0.03, 0.048, 0.026, 0.011, 2);
  sink.pair(thenar, 'glove', 'glove', mCompose([-s * 0.026, 0.028, -0.003], new THREE.Euler(0, 0, s * 0.1)));
  const heel = boxG(palmW * 0.92, 0.024, palmT * 0.92, 0.01, 2);
  sink.pair(heel, 'glove', 'glove', mTrans(0, 0.006, -0.001));

  const knuckleNode = new THREE.Group();
  knuckleNode.position.set(0, proxL, 0);
  knuckleNode.rotation.x = -bend;
  root.add(knuckleNode);
  const knuckleM = worldRelativeTo(knuckleNode, root);
  const dist = boxG(palmW * 0.97, distL, palmT * 0.9, 0.01, 2);
  sink.pair(dist, 'glove', 'glove', new THREE.Matrix4().multiplyMatrices(knuckleM, mTrans(0, distL * 0.5, 0)));
  // Knuckle pad on the back of the hand, and the four knuckles under it. Without the
  // bumps the back of a closed hand is one smooth slab, which is most of why it reads
  // as a mitten rather than a fist.
  const backPad = boxG(palmW * 0.86, distL * 0.92, 0.006, 0.0035, 2);
  sink.pair(
    backPad,
    'glovePad',
    'glovePad',
    new THREE.Matrix4().multiplyMatrices(knuckleM, mTrans(0, distL * 0.52, palmT * 0.45))
  );
  for (let k = 0; k < 4; k++) {
    const kx = (-0.0295 + k * 0.0196) * s;
    const kr = (0.0092 - Math.abs(k - 1.4) * 0.0009) * 1.16;
    const knob = latheG(
      [
        [kr * 0.55, -0.005, 'hard'],
        [kr * 0.92, -0.001],
        [kr, 0.0035],
        [kr * 0.86, 0.007],
        [kr * 0.5, 0.0096, 'hard'],
      ],
      10,
      { capEnd: true }
    );
    sink.pair(
      knob,
      'glove',
      'glove',
      new THREE.Matrix4().multiplyMatrices(
        knuckleM,
        mCompose([kx, distL * 0.86, palmT * 0.38], new THREE.Euler(-0.4, 0, 0))
      )
    );
  }
  /* Metacarpal ridges.
   *
   * On the support hand the camera is behind the *back* of the hand — the fingers are
   * round the far side of the handguard where they cannot be seen — so the back is the
   * whole read, and a smooth block with four faint bumps on it is a mitten. Four raised
   * tendons running wrist-to-knuckle turn the same silhouette into a hand: the cavity
   * bake fills the valleys between them, and the valleys are the part you actually
   * see. */
  for (let k = 0; k < 4; k++) {
    const gx = (-0.0295 + k * 0.0196) * s;
    const ridge = boxG(0.0126, distL * 0.9, 0.0032, 0.0014, 1);
    sink.pair(
      ridge,
      'glove',
      'glove',
      new THREE.Matrix4().multiplyMatrices(
        knuckleM,
        mTrans(gx, distL * 0.5, palmT * 0.45 + 0.0026)
      )
    );
  }
  // Cuff.
  // Cuff. It has to taper *into* the forearm: at 33 mm radius against a 26 mm sleeve
  // it read as a wheel bolted to the wrist.
  const cuff = latheG(
    [
      [0.0262, -0.002, 'hard'],
      [0.0288, -0.012, 'hard edge'],
      [0.0284, -0.024],
      [0.0266, -0.03, 'hard edge'],
    ],
    16,
    // Capped: the forearm is aimed independently (the wrist bends), so an open cuff
    // tube let the camera see straight through the hand.
    { capEnd: true }
  );
  sink.pair(cuff, 'glovePad', 'glovePad', mCompose([0, 0, 0], new THREE.Euler(-Math.PI * 0.5, 0, 0), [1, 0.78, 1]));

  const FINGERS = [
    { x: -0.0295, len: [0.041, 0.027, 0.0205], r: [0.0102, 0.0092, 0.0082], splay: 0.1 },
    { x: -0.0098, len: [0.046, 0.031, 0.0215], r: [0.0104, 0.0094, 0.0084], splay: 0.03 },
    { x: 0.0098, len: [0.042, 0.029, 0.0205], r: [0.0098, 0.0089, 0.008], splay: -0.04 },
    { x: 0.0292, len: [0.033, 0.022, 0.0175], r: [0.0086, 0.0078, 0.007], splay: -0.13 },
  ];

  // A finger closed on something is not a stack of loose sausages: the pad flattens
  // against the surface. Squashing the contacting phalanges across the palm normal is
  // what turns four capsules into a grip.
  const squash = o.squash ?? 0;

  const makeFinger = (f, curls, target, keyed) => {
    let node = new THREE.Group();
    node.position.set(s * f.x, distL - 0.003, 0.001);
    node.rotation.z = -s * f.splay;
    target.add(node);
    const joints = [node];
    for (let i = 0; i < 3; i++) {
      const j = new THREE.Group();
      j.rotation.x = -curls[i];
      node.add(j);
      // Palm side is −Z (the fingers curl that way), so the pads and the flattening go
      // there. The knuckle side keeps its full radius.
      const sq = i < 2 ? 1 - squash : 1 - squash * 0.5;
      const seg = capsuleY(f.r[i], f.len[i] + f.r[i] * 1.5, 8, 2);
      const segM = mCompose([0, f.len[i] * 0.5, 0], null, [1.06, 1, sq]);
      const pad = i < 2 ? boxG(f.r[i] * 1.7, f.len[i] * 0.62, 0.0024, 0.0009, 1) : null;
      const padM = pad ? mTrans(0, f.len[i] * 0.52, -f.r[i] * sq * 0.92) : null;
      if (keyed) {
        const ss = new Sink();
        ss.pair(seg, 'glove', 'glove', segM);
        if (pad) ss.pair(pad, 'glovePad', 'glovePad', padM);
        for (const m of ss.meshes(mats, 'finger')) j.add(m);
      } else {
        j.updateMatrixWorld(true);
        const mtx = worldRelativeTo(j, root);
        sink.pair(seg, 'glove', 'glove', new THREE.Matrix4().multiplyMatrices(mtx, segM));
        if (pad) sink.pair(pad, 'glovePad', 'glovePad', new THREE.Matrix4().multiplyMatrices(mtx, padM));
      }
      const nxt = new THREE.Group();
      nxt.position.set(0, f.len[i], 0);
      j.add(nxt);
      joints.push(j);
      node = nxt;
    }
    return joints;
  };

  /* Curls. When a wrap target is given every finger is solved from *its own*
   * phalanx lengths — the middle finger is 5 mm longer than the index, so reusing one
   * curl triple over-closes it and drives the tip straight through whatever is being
   * held. A small per-finger stagger keeps the row from closing in lockstep, which is
   * most of what stops a closed hand looking like a moulded mitten. */
  const wrap = o.wrap || null;
  const curlFor = (f, i) =>
    wrap
      ? wrapCurls(wrap.R, f.len, (wrap.tighten ?? 1) * (1 - 0.02 * i), wrap.bend ?? 0)
      : [
          (o.curl ?? [1.05, 1.15, 0.75])[0] * (1 + 0.03 * i),
          (o.curl ?? [1.05, 1.15, 0.75])[1] * (1 + 0.02 * i),
          (o.curl ?? [1.05, 1.15, 0.75])[2],
        ];
  const holder = knuckleNode;

  const indexJoints = makeFinger(FINGERS[0], o.indexCurl ?? curlFor(FINGERS[0], 0), holder, true);
  for (let i = 1; i < 4; i++) makeFinger(FINGERS[i], curlFor(FINGERS[i], i), holder, false);

  // Thumb: two phalanges, rotated out of the palm plane.
  {
    const tn = new THREE.Group();
    const tb = o.thumbBase ?? [0.036, 0.033, 0.006];
    tn.position.set(-s * tb[0], tb[1], tb[2]);
    tn.rotation.set(-(o.thumb?.[0] ?? 0.35), s * (o.thumbYaw ?? 0.55), s * (o.thumbRoll ?? -0.55));
    root.add(tn);
    let cur = tn;
    const tl = [0.037, 0.031];
    const tr = [0.0128, 0.0108];
    for (let i = 0; i < 2; i++) {
      const j = new THREE.Group();
      j.rotation.x = -(o.thumb?.[i + 1] ?? 0.5);
      cur.add(j);
      const seg = capsuleY(tr[i], tl[i] + tr[i] * 1.5, 8, 2);
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
  // Where the knuckle row sits in hand space. The contact solve in buildArms needs it
  // to put the knuckles *on* the thing being held instead of near it.
  const kY = proxL + (distL - 0.003) * Math.cos(bend) + 0.001 * Math.sin(bend);
  const kZ = -(distL - 0.003) * Math.sin(bend) + 0.001 * Math.cos(bend);
  return { root, indexJoints, side, knuckle: [kY, kZ], palmT };
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
        [0.0262, 0.002, 'hard'],
        [0.0288, -0.024],
        [0.0352, -0.072],
        [0.0404, -0.14],
        [0.0396, -0.18, 'hard'],
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
          [0.0272, 0.004, 'hard'],
        [0.0298, -0.008, 'hard edge'],
        [0.0304, -0.03],
        [0.0288, -0.04, 'hard edge'],
      ],
      16
    ),
    'sleeve',
    'sleeve',
    mCompose([0, 0, 0], new THREE.Euler(-Math.PI * 0.5, 0, 0), [1, 0.86, 1])
  );
  // Cuff strap: a ring around the sleeve, not a slab stuck to one side.
  const strapRing = latheG(
    [
      [0.0322, -0.046, 'hard'],
      [0.0345, -0.05, 'hard edge'],
      [0.0345, -0.062],
      [0.0322, -0.066, 'hard edge'],
    ],
    14
  );
  sink.pair(
    strapRing,
    'glovePad',
    'glovePad',
    mCompose([0, 0, 0], new THREE.Euler(-Math.PI * 0.5, 0, 0), [1, 0.86, 1])
  );
  void s;
  for (const m of sink.meshes(mats, `arm_${side}`)) g.add(m);
  return g;
}

/** Radius of a finger's proximal phalanx — the offset a wrap rides at. */
const FINGER_R = 0.0098;

/**
 * Close a finger chain around a cylinder so the phalanges become *chords of the contact
 * circle*.
 *
 * Each joint turns by half the arc of the segment before it plus half the arc of the
 * one after, which is the only way the chain tracks the surface instead of spiralling
 * into it. A single hand-tuned curl triple cannot do this — it has to be re-solved for
 * every diameter, which is why one authored pose looked plausible on the pistol grip
 * and passed straight through the handguard.
 *
 * @param {number} R radius of the circle the finger *centrelines* follow
 */
function wrapCurls(R, lens, tighten = 1.0, bend = 0) {
  const d = 2 * Math.max(0.012, R);
  return [
    // The metacarpal arch (`palmBend`) has already turned the knuckle block, so it
    // pays for part of the first chord. Charging the full half-arc again on top of it
    // is what drove the fingertips straight through the middle of the handguard.
    clamp((lens[0] / d) * tighten - bend, 0.05, 1.45),
    clamp(((lens[0] + lens[1]) / d) * tighten, 0.12, 1.55),
    clamp(((lens[1] + lens[2]) / d) * tighten, 0.1, 1.4),
  ];
}

/**
 * Seat a hand on a cylinder.
 *
 * `axis` is a point on the held cylinder's centre line, `u` the radial direction the
 * hand presses from, `t` the tangential direction the fingers travel as they close.
 * The knuckle row lands exactly one finger-radius off the surface, which is where the
 * wrap solved by `wrapCurls` has to begin. The old code offset the wrist by a fixed
 * 46.5 mm whatever it was holding, which guaranteed a gap between fingertips and gun.
 *
 * The centre of the palm still floats about a centimetre clear, and that is correct:
 * on a 48 mm tube only the finger pads and the thenar pad touch, and the thenar block
 * is modelled proud enough to reach.
 */
function seatHand(node, hand, axis, u, t, seatR, slide = 0, roll = 0) {
  const U = new THREE.Vector3().fromArray(u).normalize();
  const T = new THREE.Vector3().fromArray(t).normalize();
  T.sub(U.clone().multiplyScalar(T.dot(U))).normalize();
  const X = new THREE.Vector3().crossVectors(T, U);
  node.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, T, U));
  const [kY, kZ] = hand.knuckle;
  // knuckle = origin + T*kY + U*kZ, and it must land at axis + U*seatR.
  node.position.set(
    axis[0] + U.x * (seatR - kZ) - T.x * kY + X.x * slide,
    axis[1] + U.y * (seatR - kZ) - T.y * kY + X.y * slide,
    axis[2] + U.z * (seatR - kZ) - T.z * kY + X.z * slide
  );
  /* `roll` swings the wrist about the *contact point*, around the held cylinder's own
   * axis, with the knuckle row pinned where it is.
   *
   * Without it the solve is stuck with a straight line from the contact to the wrist
   * along the surface tangent, which puts the wrist a full palm-length — 82 mm — round
   * the circumference from where the fingers touch. On a 24 mm tube that is most of a
   * hand hanging in clear air off one side of the handguard, and it is exactly the
   * "visible gap between hand and handguard, you can see the gravel through it" read:
   * the palm was never near the tube, only the knuckles were. A real support hand is
   * bent at the wrist, so the forearm leaves the hand at an angle to the palm rather
   * than tangentially. Rolling the seated hand about the contact reproduces that with
   * one number, and `wrapCurls` is told about it so the fingers stay on the surface. */
  if (roll) {
    const K = new THREE.Vector3(
      axis[0] + U.x * seatR,
      axis[1] + U.y * seatR,
      axis[2] + U.z * seatR
    );
    const q = new THREE.Quaternion().setFromAxisAngle(X, roll);
    node.position.sub(K).applyQuaternion(q).add(K);
    node.quaternion.premultiply(q);
  }
  return node;
}

/**
 * Both arms, seated on the weapon by an analytic contact solve: the firing hand wraps
 * the pistol grip with the trigger finger indexed along the receiver, the support hand
 * takes the handguard from the lower left with the fingers closing under it and up the
 * far side and the thumb riding forward along the top.
 */
export function buildArms(ctx, mats, def) {
  const b = def.build;
  const g = b.grip;
  const out = {};

  /* --- right (firing) hand -------------------------------------------------
   * The grip is treated as a cylinder about its own axis. The web of the hand sits on
   * the backstrap, the palm takes the right flank, and the fingers close forward
   * around the front strap.
   */
  // The grip section is a rounded rectangle, so the flank the palm sits on and the
  // effective radius the fingers travel round are two different numbers.
  const gripSideR = g.w * 0.5;
  const gripWrapR = (g.w * 0.5 + g.d * 0.5) * 0.5;
  // Perpendicular to the grip axis, pointing up and rearward: the backstrap normal.
  const gripRear = new THREE.Vector3(0, Math.sin(g.angle), Math.cos(g.angle));
  const rRig = new THREE.Group();
  rRig.name = 'rig:right';
  const rBend = 0.62;
  const right = buildHand(mats, 'right', {
    wrap: { R: gripWrapR + FINGER_R, tighten: 1.06, bend: rBend },
    indexCurl: [0.12, 0.06, 0.04],
    thumb: [0.5, 0.72, 0.46],
    thumbYaw: 0.5,
    thumbRoll: -0.5,
    squash: 0.2,
    palmBend: rBend,
  });
  const rHand = new THREE.Group();
  rHand.add(right.root);
  const gt = 0.34;
  const gripPt = [
    0,
    g.y - Math.cos(g.angle) * g.len * gt,
    g.z + Math.sin(g.angle) * g.len * gt,
  ];
  seatHand(
    rHand,
    right,
    gripPt,
    [1, 0, 0], // palm presses in from the right flank
    [-gripRear.x, -gripRear.y, -gripRear.z], // fingers close toward the front strap
    gripSideR + FINGER_R,
    0.004
  );
  rRig.add(rHand);
  const rArm = buildForearm(mats, 'right');
  const rDir = [0.26, -0.76, 0.6];
  // Start it inside the cuff so wrist and sleeve are one continuous limb.
  rArm.position.set(
    rHand.position.x + rDir[0] * 0.012 + 0.012,
    rHand.position.y + rDir[1] * 0.012 - 0.008,
    rHand.position.z + rDir[2] * 0.012
  );
  aimNode(rArm, rDir);
  rRig.add(rArm);
  out.right = right;
  out.rightRig = rRig;

  /* --- left (support) hand -------------------------------------------------
   * The handguard is a genuine cylinder of known radius, so the wrap is solved rather
   * than guessed: palm on the lower left at 215°, fingers travelling anticlockwise
   * under the tube and up the far side.
   */
  const hgR = b.handguard.r;
  /* Clock angle of the palm on the handguard. The wrist ends up one palm-length back
   * along the finger-travel direction, so this single number decides where the whole
   * forearm comes from: at 215° the wrist landed 47 mm *above* the bore and the cuff
   * sat on top of the handguard like a drum. Underneath and just left of bottom puts
   * the wrist below and to the left, where a support arm actually is, and sends the
   * fingers up the near side where they can be seen making contact. */
  const phi = 268 * (Math.PI / 180);
  const uL = [Math.cos(phi), Math.sin(phi), 0];
  const tL = [-Math.sin(phi), Math.cos(phi), 0];
  const lRig = new THREE.Group();
  lRig.name = 'rig:left';
  const lBend = 0.5;
  const left = buildHand(mats, 'left', {
    // Under 1.0 on purpose: the middle and ring fingers are the longest, so at a full
    // wrap they carry 165° of arc and their tips come over the top of the handguard
    // into the sight picture. This stops the row on the far flank.
    wrap: { R: hgR + FINGER_R, tighten: 0.84, bend: lBend },
    // Thumb forward: rolled 90° out of the finger plane so it runs down the side of
    // the handguard toward the muzzle instead of curling into it. That is the shape a
    // thumb-forward support grip actually makes, and it reads at a glance.
    thumb: [0.14, 0.18, 0.1],
    thumbYaw: 0.1,
    thumbRoll: 1.5,
    // Forward along the tube and tucked *up* against it. Sitting it out on the far
    // side of the wrist left it hanging in mid-air beside the handguard.
    thumbBase: [0.03, 0.02, -0.011],
    squash: 0.24,
    palmBend: lBend,
  });
  const lHand = new THREE.Group();
  lHand.add(left.root);
  const hz = b.handguard.z0 * 0.5 + b.handguard.z1 * 0.5;
  seatHand(lHand, left, [0, 0, hz], uL, tL, hgR + FINGER_R, 0.006);
  lRig.add(lHand);
  const lArm = buildForearm(mats, 'left');
  const lDir = [-0.34, -0.9, 0.27];
  lArm.position.set(
    lHand.position.x + lDir[0] * 0.012 - 0.006,
    lHand.position.y + lDir[1] * 0.012 - 0.004,
    lHand.position.z + lDir[2] * 0.012
  );
  aimNode(lArm, lDir);
  lRig.add(lArm);
  out.left = left;
  out.leftRig = lRig;

  bakeTree(rRig, { cell: 0.0035, maxDist: 0.03, amount: 1 });
  bakeTree(lRig, { cell: 0.0035, maxDist: 0.03, amount: 1 });

  return out;
}

/** Point a forearm (built along its own −Y) down `dir`. */
function aimNode(node, dir) {
  const d = new THREE.Vector3().fromArray(dir).normalize();
  node.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
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
  if (g && !g.attributes.color) {
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
  }
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
  // latheG's UVs are metre-space arc lengths, so remap v to 0..1 along the cone for
  // the jet branch of the shader.
  const jetGeo = latheG(
    [
      [0.001, 0.0, 'hard'],
      [0.021, -0.03],
      [0.014, -0.07],
      [0.002, -0.1],
    ],
    10
  ).main;
  if (jetGeo) {
    const pos = jetGeo.attributes.position;
    const uv = jetGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, 0.5, clamp(-pos.getZ(i) / 0.1, 0, 1));
    uv.needsUpdate = true;
  }
  const jetMat = mat.clone();
  jetMat.uniforms = THREE.UniformsUtils.clone(mat.uniforms);
  jetMat.uniforms.uMode.value = 1;
  const jet = new THREE.Mesh(jetGeo, jetMat);
  jet.frustumCulled = false;
  jet.renderOrder = 19;
  group.add(jet);
  // The group stays *visible* with the flash amount at zero. An invisible object is
  // skipped by the renderer's light collection, so hiding it would drop the point
  // light out of the scene and force every viewmodel material to recompile the first
  // time a shot is fired — a multi-second hitch on a software rasteriser.
  const light = new THREE.PointLight(0xffb066, 0, 2.2, 2.0);
  light.position.set(0, 0, -0.02);
  group.add(light);
  return { group, mat, jetMat, light, quads, jet };
}

export { G, bakeTree as bakeViewmodel };
export default buildWeapon;
