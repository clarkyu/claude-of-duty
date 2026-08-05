/**
 * destruction/Voronoi.js — 3D Voronoi decomposition of a box, by half-space clipping.
 * Owner: destruction agent.
 *
 * A convex polyhedron is `{ faces: [{ pts: [[x,y,z], …] }] }`, each face wound CCW
 * about its outward normal. `clipPoly` is a Sutherland–Hodgman clip lifted to 3D: every
 * face is clipped against the plane, the crossing vertices are collected, deduplicated
 * and sorted by angle in the plane, and the resulting polygon is added back as the cap.
 * Because the input is convex, the cap is a single convex polygon and the result is
 * exact — no CSG library, no floating-point mesh repair.
 *
 * A Voronoi cell for site i is then just the source box clipped by the perpendicular
 * bisector of (i, j) for every other site j. That is O(n²) plane clips for n sites,
 * which for the 6–28 sites a fracture pattern actually wants is under a millisecond —
 * and it is done once at pattern-build time and cached, never per impact.
 *
 * Exterior vs interior faces are recovered afterwards by testing whether a face lies in
 * one of the six original bound planes. That is what lets a fragment show painted
 * plaster on the face that used to be the wall and raw brick on every fresh break.
 *
 * Exports: makeBoxPoly, clipPoly, voronoiCells, polyMass, polyToGeometry.
 */
import * as THREE from 'three';

const EPS = 1e-7;
const FACE_EPS = 2e-4;

/** Axis-aligned box as a convex poly, faces wound CCW about their outward normals. */
export function makeBoxPoly(hx, hy, hz) {
  const p = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const idx = [
    [0, 3, 2, 1], // -z
    [4, 5, 6, 7], // +z
    [0, 1, 5, 4], // -y
    [3, 7, 6, 2], // +y
    [0, 4, 7, 3], // -x
    [1, 2, 6, 5], // +x
  ];
  return { faces: idx.map((f) => ({ pts: f.map((i) => p[i].slice()) })) };
}

/** Newell normal of a polygon, normalised. Writes into `out` (length-3 array). */
function newell(pts, out) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l < 1e-12) {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return false;
  }
  out[0] = nx / l;
  out[1] = ny / l;
  out[2] = nz / l;
  return true;
}

/**
 * Clip a convex poly by the half-space `n·p <= d`. Returns a new poly, or null when
 * the plane removes everything. The input is not mutated.
 */
export function clipPoly(poly, nx, ny, nz, d) {
  const out = [];
  const cut = [];
  let kept = 0;
  let removed = 0;

  for (const f of poly.faces) {
    const pts = f.pts;
    const n = pts.length;
    const np = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const da = nx * a[0] + ny * a[1] + nz * a[2] - d;
      const db = nx * b[0] + ny * b[1] + nz * b[2] - d;
      if (da <= EPS) {
        np.push(a);
        kept++;
      } else removed++;
      if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
        const t = da / (da - db);
        const p = [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ];
        np.push(p);
        cut.push(p);
      }
    }
    if (np.length >= 3) out.push({ pts: np });
  }

  if (!out.length || kept === 0) return null;
  if (removed === 0) return poly; // plane missed the poly entirely

  if (cut.length >= 3) {
    const cap = dedupe(cut);
    if (cap.length >= 3) {
      orderInPlane(cap, nx, ny, nz);
      out.push({ pts: cap });
    }
  }
  return { faces: out };
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    let dup = false;
    for (const q of out) {
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      const dz = p[2] - q[2];
      if (dx * dx + dy * dy + dz * dz < 1e-12) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(p);
  }
  return out;
}

/** Sort coplanar points CCW about +n so the cap's outward normal is +n. */
function orderInPlane(pts, nx, ny, nz) {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const inv = 1 / pts.length;
  cx *= inv;
  cy *= inv;
  cz *= inv;
  // Any vector not parallel to n gives a usable in-plane basis.
  let ux = 0;
  let uy = 0;
  let uz = 0;
  if (Math.abs(nx) < 0.9) {
    ux = 1;
  } else {
    uy = 1;
  }
  const dot = ux * nx + uy * ny + uz * nz;
  ux -= nx * dot;
  uy -= ny * dot;
  uz -= nz * dot;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;
  pts.sort((a, b) => {
    const ax = a[0] - cx;
    const ay = a[1] - cy;
    const az = a[2] - cz;
    const bx = b[0] - cx;
    const by = b[1] - cy;
    const bz = b[2] - cz;
    const aa = Math.atan2(ax * vx + ay * vy + az * vz, ax * ux + ay * uy + az * uz);
    const bb = Math.atan2(bx * vx + by * vy + bz * vz, bx * ux + by * uy + bz * uz);
    return aa - bb;
  });
}

/**
 * Voronoi cells of `sites` clipped to the box [-h, +h].
 * @param {number[][]} sites  [[x,y,z], …] inside the box
 * @returns {Array<{poly:object, site:number[]}>}
 */
export function voronoiCells(hx, hy, hz, sites) {
  const cells = [];
  for (let i = 0; i < sites.length; i++) {
    const a = sites[i];
    let poly = makeBoxPoly(hx, hy, hz);
    for (let j = 0; j < sites.length && poly; j++) {
      if (j === i) continue;
      const b = sites[j];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      let dz = b[2] - a[2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-6) continue;
      dx /= l;
      dy /= l;
      dz /= l;
      const mx = (a[0] + b[0]) * 0.5;
      const my = (a[1] + b[1]) * 0.5;
      const mz = (a[2] + b[2]) * 0.5;
      poly = clipPoly(poly, dx, dy, dz, dx * mx + dy * my + dz * mz);
    }
    if (poly && poly.faces.length >= 4) cells.push({ poly, site: a });
  }
  return cells;
}

/** Signed volume and centroid of a convex poly, by tetrahedral decomposition. */
export function polyMass(poly) {
  let vol = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const f of poly.faces) {
    const pts = f.pts;
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = pts[0];
      const b = pts[i];
      const c = pts[i + 1];
      const v =
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
      vol += v;
      cx += (a[0] + b[0] + c[0]) * 0.25 * v;
      cy += (a[1] + b[1] + c[1]) * 0.25 * v;
      cz += (a[2] + b[2] + c[2]) * 0.25 * v;
    }
  }
  if (Math.abs(vol) < 1e-12) return { volume: 0, centroid: [0, 0, 0] };
  return { volume: Math.abs(vol), centroid: [cx / vol, cy / vol, cz / vol] };
}

/** Does this face lie in one of the six original bound planes? */
function faceIsExterior(pts, hx, hy, hz) {
  const bounds = [hx, hy, hz];
  for (let ax = 0; ax < 3; ax++) {
    for (let s = -1; s <= 1; s += 2) {
      const v = s * bounds[ax];
      let all = true;
      for (const p of pts) {
        if (Math.abs(p[ax] - v) > FACE_EPS) {
          all = false;
          break;
        }
      }
      if (all) return true;
    }
  }
  return false;
}

/**
 * Turn one Voronoi cell into a render-ready BufferGeometry, centred on its own AABB.
 *
 * Two material groups come out of this, always in the same order:
 *   group 0  materialIndex 0  exterior faces — the object's original surface
 *   group 1  materialIndex 1  interior faces — the fresh break
 * Empty groups are omitted, so a fragment from deep inside the object costs one draw.
 *
 * Attributes: position, normal (flat, per face), uv (world metres, planar per face),
 * color (mask: r = grime, g = 0, b = 0 — MaterialLibrary's vertex-colour convention,
 * and a defined value there means a shared material with `vertexColors` on can never
 * read garbage).
 *
 * @param {object} cell        from voronoiCells()
 * @param {object} src         { hx, hy, hz, ox, oy, oz } source box + its world origin
 * @param {function} rnd       seeded 0..1 generator for the grime jitter
 */
export function polyToGeometry(cell, src, rnd) {
  const { poly } = cell;
  const { hx, hy, hz } = src;
  const ox = src.ox || 0;
  const oy = src.oy || 0;
  const oz = src.oz || 0;

  const nrm = [0, 0, 0];
  const extFaces = [];
  const intFaces = [];
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const f of poly.faces) {
    if (f.pts.length < 3) continue;
    if (!newell(f.pts, nrm)) continue;
    const rec = { pts: f.pts, n: [nrm[0], nrm[1], nrm[2]] };
    if (faceIsExterior(f.pts, hx, hy, hz)) extFaces.push(rec);
    else intFaces.push(rec);
    for (const p of f.pts) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[2] < minZ) minZ = p[2];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[2] > maxZ) maxZ = p[2];
    }
  }
  if (!extFaces.length && !intFaces.length) return null;

  const cxx = (minX + maxX) * 0.5;
  const cyy = (minY + maxY) * 0.5;
  const czz = (minZ + maxZ) * 0.5;

  let triCount = 0;
  for (const f of extFaces) triCount += f.pts.length - 2;
  for (const f of intFaces) triCount += f.pts.length - 2;
  if (triCount <= 0) return null;

  const vcount = triCount * 3;
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const col = new Float32Array(vcount * 3);

  let w = 0;
  const emit = (faces, grime) => {
    for (const f of faces) {
      const n = f.n;
      // Dominant-axis planar UV in world metres — the convention MaterialLibrary wants.
      const ax = Math.abs(n[0]);
      const ay = Math.abs(n[1]);
      const az = Math.abs(n[2]);
      let ui = 0;
      let vi = 1;
      if (ax >= ay && ax >= az) {
        ui = 2;
        vi = 1;
      } else if (ay >= az) {
        ui = 0;
        vi = 2;
      } else {
        ui = 0;
        vi = 1;
      }
      const off = [ox, oy, oz];
      for (let i = 1; i + 1 < f.pts.length; i++) {
        const tri = [f.pts[0], f.pts[i], f.pts[i + 1]];
        for (const p of tri) {
          const o = w * 3;
          pos[o] = p[0] - cxx;
          pos[o + 1] = p[1] - cyy;
          pos[o + 2] = p[2] - czz;
          nor[o] = n[0];
          nor[o + 1] = n[1];
          nor[o + 2] = n[2];
          uv[w * 2] = p[ui] + off[ui];
          uv[w * 2 + 1] = p[vi] + off[vi];
          // Grime lives in r. A fresh break is clean; the old outer face is not.
          col[o] = grime * (0.55 + rnd() * 0.9);
          col[o + 1] = 0;
          col[o + 2] = 0;
          w++;
        }
      }
    }
  };

  const geometry = new THREE.BufferGeometry();
  const extTris = extFaces.reduce((s, f) => s + f.pts.length - 2, 0);
  emit(extFaces, 0.3);
  emit(intFaces, 0.03);

  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (extTris > 0) geometry.addGroup(0, extTris * 3, 0);
  if (triCount - extTris > 0) geometry.addGroup(extTris * 3, (triCount - extTris) * 3, 1);
  geometry.computeBoundingSphere();

  const mass = polyMass(poly);
  return {
    geometry,
    centre: [cxx, cyy, czz],
    half: [
      Math.max(0.004, (maxX - minX) * 0.5),
      Math.max(0.004, (maxY - minY) * 0.5),
      Math.max(0.004, (maxZ - minZ) * 0.5),
    ],
    volume: mass.volume,
    radius: geometry.boundingSphere ? geometry.boundingSphere.radius : 0.1,
    exteriorTris: extTris,
    triangles: triCount,
  };
}

export default { makeBoxPoly, clipPoly, voronoiCells, polyMass, polyToGeometry };
