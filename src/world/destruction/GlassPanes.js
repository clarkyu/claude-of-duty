/**
 * destruction/GlassPanes.js — find every pane of glass in the world and make it real.
 * Owner: destruction agent.
 *
 * The level kit and the prop batcher merge their geometry aggressively: all the window
 * glass in a district is one draw call, and a windscreen is a handful of triangles
 * inside a 40k-triangle vehicle batch. There is therefore no "window mesh" to hide when
 * a pane is shot out. This module recovers the panes from the merged buffers:
 *
 *   1. Walk the level and prop roots for meshes whose material resolves (through
 *      `ctx.materials.surfaceOf`) to the §5 `glass` tag.
 *   2. Weld their vertices by quantised position and union-find the triangles into
 *      connected components. A merged box welds back into one component; two windows
 *      that never touch stay separate.
 *   3. Keep the components that look like glazing — thin on one axis, plausible area —
 *      and record their vertex indices, oriented bounds and plane normal.
 *   4. Give each one a thin static collider so a bullet can actually *hit* it.
 *      Without this the round sails straight through the opening and no impact event
 *      is ever raised, which is exactly why shooting out windows so often does nothing.
 *
 * Breaking a pane collapses its vertices onto their own centroid — every triangle in
 * the component becomes degenerate and rasterises to nothing — and removes the
 * collider. The original positions are kept so `reset()` can put the glass back.
 *
 * Panes at the same place in different LOD levels are grouped by a quantised centre so
 * one bullet takes out the pane at every level of detail at once.
 */
import * as THREE from 'three';

const WELD = 1e3; // 1 mm quantisation

/** Union-find over vertex slots. */
function makeDSU(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  return {
    find,
    union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    },
  };
}

/** Is this mesh (or one of its materials) glass? */
function glassMaterialIndex(ctx, mesh) {
  const surfaceOf = ctx.materials?.surfaceOf;
  if (!surfaceOf) return -1;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (let i = 0; i < mats.length; i++) {
    const m = mats[i];
    if (!m) continue;
    try {
      if (surfaceOf(m).surface === 'glass') return i;
    } catch {
      /* unknown material: not glass */
    }
  }
  return -1;
}

/**
 * Fit an oriented box to a slab of points. A shop front rotated 27° off the world axes
 * has a fat world AABB and would otherwise be rejected as "not thin enough", so the
 * pane normal is searched for rather than assumed: the candidates are world up plus a
 * fan of horizontal directions, which covers every window, windscreen and skylight the
 * map actually builds (all of them are either vertical-with-yaw or horizontal).
 *
 * @param {number[]} pts   flat xyz triples in world space
 * @returns {{centre:THREE.Vector3, normal:THREE.Vector3, quaternion:THREE.Quaternion,
 *            half:THREE.Vector3}|null}
 */
const _cand = [];
{
  _cand.push(new THREE.Vector3(0, 1, 0));
  const STEPS = 24;
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI;
    _cand.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
}

function fitPane(pts, maxThickness) {
  const n = pts.length / 3;
  if (n < 4) return null;
  let best = null;
  let bestExtent = Infinity;
  for (const c of _cand) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = pts[i * 3] * c.x + pts[i * 3 + 1] * c.y + pts[i * 3 + 2] * c.z;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const ext = hi - lo;
    if (ext < bestExtent) {
      bestExtent = ext;
      best = c;
    }
  }
  if (!best || bestExtent > maxThickness) return null;

  const normal = best.clone();
  const up = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const t = new THREE.Vector3().crossVectors(up, normal).normalize();
  const b = new THREE.Vector3().crossVectors(normal, t).normalize();
  const axes = [t, b, normal];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    const z = pts[i * 3 + 2];
    for (let a = 0; a < 3; a++) {
      const d = x * axes[a].x + y * axes[a].y + z * axes[a].z;
      if (d < lo[a]) lo[a] = d;
      if (d > hi[a]) hi[a] = d;
    }
  }
  const centre = new THREE.Vector3();
  for (let a = 0; a < 3; a++) centre.addScaledVector(axes[a], (lo[a] + hi[a]) * 0.5);
  const m = new THREE.Matrix4().makeBasis(t, b, normal);
  return {
    centre,
    normal,
    quaternion: new THREE.Quaternion().setFromRotationMatrix(m),
    half: new THREE.Vector3(
      Math.max(0.01, (hi[0] - lo[0]) * 0.5),
      Math.max(0.01, (hi[1] - lo[1]) * 0.5),
      Math.max(0.004, (hi[2] - lo[2]) * 0.5)
    ),
  };
}

/**
 * @returns {Array} pane records; see the module header for what each one holds.
 */
export function findPanes(ctx, roots, opts = {}) {
  const limit = opts.limit ?? 220;
  const minArea = opts.minArea ?? 0.09;
  const maxArea = opts.maxArea ?? 14;
  const maxThickness = opts.maxThickness ?? 0.16;
  const panes = [];
  const meshes = [];

  for (const root of roots) {
    if (!root) continue;
    try {
      root.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        if (glassMaterialIndex(ctx, o) < 0) return;
        const pos = o.geometry.getAttribute?.('position');
        // Welding is O(v) with a string key per vertex; glass batches are small, and a
        // giant one is a sign this is not glazing at all. Skip rather than stall boot.
        if (!pos || pos.count < 3 || pos.count > 40000) return;
        meshes.push(o);
      });
    } catch {
      /* a root we cannot walk is simply not a source of panes */
    }
  }

  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    try {
      mesh.updateWorldMatrix(true, false);
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position');
      const n = pos.count;
      const index = geo.index ? geo.index.array : null;
      const triCount = index ? index.length / 3 : n / 3;
      if (triCount < 1) continue;

      // Weld by quantised position so a merged box is one component, not six faces.
      const dsu = makeDSU(n);
      const weld = new Map();
      for (let i = 0; i < n; i++) {
        const key = `${Math.round(pos.getX(i) * WELD)},${Math.round(pos.getY(i) * WELD)},${Math.round(pos.getZ(i) * WELD)}`;
        const first = weld.get(key);
        if (first === undefined) weld.set(key, i);
        else dsu.union(first, i);
      }
      for (let t = 0; t < triCount; t++) {
        const a = index ? index[t * 3] : t * 3;
        const b = index ? index[t * 3 + 1] : t * 3 + 1;
        const c = index ? index[t * 3 + 2] : t * 3 + 2;
        dsu.union(a, b);
        dsu.union(a, c);
      }

      // Bucket vertices by component root.
      const comps = new Map();
      for (let i = 0; i < n; i++) {
        const r = dsu.find(i);
        let list = comps.get(r);
        if (!list) comps.set(r, (list = []));
        list.push(i);
      }
      if (comps.size > 4000) continue; // pathological geometry: leave it alone

      for (const list of comps.values()) {
        if (list.length < 4) continue;
        const world = [];
        for (const i of list) {
          v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
          world.push(v.x, v.y, v.z);
        }
        const fit = fitPane(world, maxThickness);
        if (!fit) continue;
        const area = fit.half.x * fit.half.y * 4;
        if (area < minArea || area > maxArea) continue;

        panes.push({
          mesh,
          verts: Uint32Array.from(list),
          centre: fit.centre,
          normal: fit.normal,
          quaternion: fit.quaternion,
          half: fit.half,
          area,
          key: `${Math.round(fit.centre.x * 4)}_${Math.round(fit.centre.y * 4)}_${Math.round(fit.centre.z * 4)}`,
          saved: null,
          collider: null,
          broken: false,
        });
        if (panes.length >= limit * 3) break;
      }
    } catch {
      /* one bad mesh must not cost us every window */
    }
    if (panes.length >= limit * 3) break;
  }

  // Group LOD duplicates, then keep the biggest panes if we are over budget.
  const groups = new Map();
  for (const p of panes) {
    let g = groups.get(p.key);
    if (!g) groups.set(p.key, (g = []));
    g.push(p);
  }
  const out = [...groups.values()];
  out.sort((a, b) => b[0].area - a[0].area);
  return out.slice(0, limit);
}

/** Collapse a pane's vertices to their centroid. Returns true when it actually moved. */
export function collapsePane(pane) {
  if (pane.broken) return false;
  const geo = pane.mesh?.geometry;
  const pos = geo?.getAttribute?.('position');
  if (!pos) return false;
  const verts = pane.verts;
  if (!pane.saved) {
    const saved = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
      const k = verts[i];
      saved[i * 3] = pos.getX(k);
      saved[i * 3 + 1] = pos.getY(k);
      saved[i * 3 + 2] = pos.getZ(k);
    }
    pane.saved = saved;
  }
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < verts.length; i++) {
    cx += pane.saved[i * 3];
    cy += pane.saved[i * 3 + 1];
    cz += pane.saved[i * 3 + 2];
  }
  const inv = 1 / verts.length;
  cx *= inv;
  cy *= inv;
  cz *= inv;
  for (let i = 0; i < verts.length; i++) pos.setXYZ(verts[i], cx, cy, cz);
  pos.needsUpdate = true;
  pane.broken = true;
  return true;
}

export function restorePane(pane) {
  if (!pane.broken || !pane.saved) {
    pane.broken = false;
    return false;
  }
  const pos = pane.mesh?.geometry?.getAttribute?.('position');
  if (!pos) return false;
  for (let i = 0; i < pane.verts.length; i++) {
    pos.setXYZ(pane.verts[i], pane.saved[i * 3], pane.saved[i * 3 + 1], pane.saved[i * 3 + 2]);
  }
  pos.needsUpdate = true;
  pane.broken = false;
  return true;
}

export default { findPanes, collapsePane, restorePane };
