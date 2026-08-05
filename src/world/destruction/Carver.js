/**
 * destruction/Carver.js — remove a prop from a merged batch. Owner: destruction agent.
 *
 * Static props are merged into one mesh per district per material, so there is no
 * object to hide when a market stall is blown apart. The carver does it at the vertex
 * level: every vertex of the batch that falls inside the prop's oriented bounding box
 * is collapsed onto a single point, which degenerates its triangles to zero area. The
 * batch keeps exactly the same buffers, the same draw call and the same bounding
 * sphere; the prop simply stops rasterising.
 *
 * A uniform world-space vertex grid is built lazily, once per mesh, so a carve touches
 * only the handful of cells the prop overlaps instead of walking a 100k-vertex buffer.
 * Original positions are kept so `reset()` can put the world back exactly as it was.
 */
import * as THREE from 'three';

const CELL = 1.0; // metres

export class MeshCarver {
  constructor() {
    /** @type {WeakMap<THREE.Mesh, {grid:Map<string,number[]>, dirty:boolean}>} */
    this.grids = new WeakMap();
    this._v = new THREE.Vector3();
    this._l = new THREE.Vector3();
    this._inv = new THREE.Quaternion();
  }

  _grid(mesh) {
    let entry = this.grids.get(mesh);
    if (entry) return entry;
    const pos = mesh.geometry?.getAttribute?.('position');
    if (!pos) return null;
    const grid = new Map();
    mesh.updateWorldMatrix(true, false);
    const m = mesh.matrixWorld;
    const v = this._v;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      const key = `${Math.floor(v.x / CELL)},${Math.floor(v.y / CELL)},${Math.floor(v.z / CELL)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(i);
    }
    entry = { grid };
    this.grids.set(mesh, entry);
    return entry;
  }

  /**
   * Collapse every vertex of `mesh` inside the oriented box.
   * @returns {{mesh:THREE.Mesh, verts:Uint32Array, saved:Float32Array}|null}
   */
  carve(mesh, centre, quat, half, pad = 0.02) {
    const geo = mesh?.geometry;
    const pos = geo?.getAttribute?.('position');
    if (!pos) return null;
    const entry = this._grid(mesh);
    if (!entry) return null;

    mesh.updateWorldMatrix(true, false);
    const world = mesh.matrixWorld;
    const inv = this._inv.copy(quat).invert();
    const hx = half.x + pad;
    const hy = half.y + pad;
    const hz = half.z + pad;
    const r = Math.sqrt(hx * hx + hy * hy + hz * hz);

    const i0 = Math.floor((centre.x - r) / CELL);
    const i1 = Math.floor((centre.x + r) / CELL);
    const j0 = Math.floor((centre.y - r) / CELL);
    const j1 = Math.floor((centre.y + r) / CELL);
    const k0 = Math.floor((centre.z - r) / CELL);
    const k1 = Math.floor((centre.z + r) / CELL);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 20000) return null;

    const hits = [];
    const v = this._v;
    const l = this._l;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const list = entry.grid.get(`${i},${j},${k}`);
          if (!list) continue;
          for (const vi of list) {
            v.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(world);
            l.copy(v).sub(centre).applyQuaternion(inv);
            if (Math.abs(l.x) <= hx && Math.abs(l.y) <= hy && Math.abs(l.z) <= hz) hits.push(vi);
          }
        }
      }
    }
    if (hits.length < 6) return null;

    const verts = Uint32Array.from(hits);
    const saved = new Float32Array(verts.length * 3);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < verts.length; i++) {
      const vi = verts[i];
      const x = pos.getX(vi);
      const y = pos.getY(vi);
      const z = pos.getZ(vi);
      saved[i * 3] = x;
      saved[i * 3 + 1] = y;
      saved[i * 3 + 2] = z;
      cx += x;
      cy += y;
      cz += z;
    }
    const invN = 1 / verts.length;
    cx *= invN;
    cy *= invN;
    cz *= invN;
    for (let i = 0; i < verts.length; i++) pos.setXYZ(verts[i], cx, cy, cz);
    pos.needsUpdate = true;
    return { mesh, verts, saved };
  }

  static restore(rec) {
    if (!rec) return false;
    const pos = rec.mesh?.geometry?.getAttribute?.('position');
    if (!pos) return false;
    for (let i = 0; i < rec.verts.length; i++) {
      pos.setXYZ(rec.verts[i], rec.saved[i * 3], rec.saved[i * 3 + 1], rec.saved[i * 3 + 2]);
    }
    pos.needsUpdate = true;
    return true;
  }

  dispose() {
    this.grids = new WeakMap();
  }
}

export default MeshCarver;
