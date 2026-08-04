/**
 * kit/Batcher.js — geometry accumulation, batching, LOD and collision registration.
 * Owner: level agent.
 *
 * A `Batcher` is one spatial *district* of the map (a building, a street block, a
 * terrain quadrant). Everything authored into it lands in a per-material `MeshBuilder`,
 * so the district collapses to exactly one draw call per material it actually uses —
 * which is how a map this size stays under the budget — and to one tight bounding
 * sphere per mesh, so frustum culling is meaningful instead of being defeated by one
 * giant world mesh.
 *
 * Districts also carry:
 *   • **LOD.** Author with `bat.lod` set to 0 / 1 / 2 and the batcher keeps three
 *     parallel sets of builders. Small trim goes in 0 only, the shell goes in all
 *     three. `build()` returns a `THREE.LOD` when more than one level has content.
 *   • **Colliders.** `bat.collider()` records a simplified box/mesh for `ctx.physics`
 *     and, by default, also registers the same volume as an AO occluder.
 *   • **Instances.** `bat.instance(key, ...)` collects transforms for repeated modules
 *     (lamps, AC units, bollards, grates) that become one `InstancedMesh` per district.
 */
import * as THREE from 'three';
import { MeshBuilder } from './geom.js';

let _uid = 1;

export class Batcher {
  /**
   * @param {object} opts
   * @param {string} opts.name       district id, used for object names
   * @param {import('./Palette.js').Palette} opts.palette
   * @param {import('./VertexAO.js').OcclusionField} [opts.field]
   */
  constructor({ name = 'district', palette, field = null, colliderSink = null } = {}) {
    this.name = name;
    this.palette = palette;
    this.field = field;
    this.colliderSink = colliderSink;
    /** @type {Map<string, MeshBuilder>[]} indexed by LOD */
    this.levels = [new Map(), new Map(), new Map()];
    this.lod = 0;
    this.instances = new Map();
    this.colliders = [];
    this.matrixStack = [];
    this.matrix = null;
    this.colorFn = null;
    this.uvRot = 0;
    this.uvOffset = [0, 0];
  }

  /* -------------------------------------------------------------- authoring */

  /** The builder for `matKey` at the current LOD, with the current transform state. */
  b(matKey) {
    const map = this.levels[this.lod] || this.levels[0];
    let mb = map.get(matKey);
    if (!mb) {
      mb = new MeshBuilder(matKey);
      map.set(matKey, mb);
    }
    mb.setMatrix(this.matrix);
    mb.colorFn = this.colorFn;
    mb.uvRot = this.uvRot;
    mb.uvOffset = this.uvOffset;
    return mb;
  }

  /** Author into every LOD at once (shells, floors, big masses). */
  all(matKey) {
    return [0, 1, 2].map((l) => {
      const prev = this.lod;
      this.lod = l;
      const mb = this.b(matKey);
      this.lod = prev;
      return mb;
    });
  }

  /**
   * Run `fn(mb, lod)` on the builder at the current LOD and, optionally, the `extra`
   * coarser levels above it. Relative rather than absolute so a caller can author a
   * whole sub-assembly into the LOD-1 shell just by setting `bat.lod = 1` first.
   */
  upTo(matKey, extra, fn) {
    const prev = this.lod;
    const top = Math.min(2, prev + Math.max(0, extra | 0));
    for (let l = prev; l <= top; l++) {
      this.lod = l;
      fn(this.b(matKey), l);
    }
    this.lod = prev;
    return this;
  }

  push(matrix) {
    this.matrixStack.push(this.matrix);
    this.matrix = matrix;
    return this;
  }
  pop() {
    this.matrix = this.matrixStack.pop() || null;
    return this;
  }

  /* ------------------------------------------------------------- collision */

  /**
   * Register a simplified collider. Accepts the physics collider shape directly.
   * `occlude:false` opts out of the AO field (use for triggers and thin trim).
   */
  collider(desc) {
    if (!desc) return null;
    const c = { group: 1, ...desc };
    this.colliders.push(c);
    this.colliderSink?.push(c);
    if (desc.occlude !== false && this.field) this.occluder(desc);
    return c;
  }

  /** AO-only volume: chunky detail that should darken its surroundings. */
  occluder(desc) {
    if (!this.field || !desc) return;
    const t = (desc.type || 'box').toLowerCase();
    if (t !== 'box' && t !== 'plane') return;
    const p = desc.pos || desc.position || { x: 0, y: 0, z: 0 };
    let h = desc.halfExtents;
    if (!h && desc.size) h = { x: desc.size.x / 2, y: desc.size.y / 2, z: desc.size.z / 2 };
    if (!h) return;
    let yaw = desc.yaw || 0;
    if (!yaw && desc.quat) {
      const q = desc.quat;
      yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    }
    this.field.add(p.x ?? 0, p.y ?? 0, p.z ?? 0, h.x ?? h[0], h.y ?? h[1], h.z ?? h[2], yaw);
  }

  /** Box collider helper in centre/half form, with a §5 surface tag. */
  box(cx, cy, cz, hx, hy, hz, surface = 'concrete', extra) {
    return this.collider({
      type: 'box',
      pos: { x: cx, y: cy, z: cz },
      halfExtents: { x: hx, y: hy, z: hz },
      surface,
      ...extra,
    });
  }

  /** Yawed box collider (quaternion built here so callers stay 2D). */
  boxYaw(cx, cy, cz, hx, hy, hz, yaw, surface = 'concrete', extra) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    return this.collider({
      type: 'box',
      pos: { x: cx, y: cy, z: cz },
      halfExtents: { x: hx, y: hy, z: hz },
      quat: { x: q.x, y: q.y, z: q.z, w: q.w },
      yaw,
      surface,
      ...extra,
    });
  }

  /* ------------------------------------------------------------ instancing */

  /**
   * @param {string} key        unique per (module, material)
   * @param {string} matKey     palette key
   * @param {() => THREE.BufferGeometry} factory  built once, cached on the registry
   * @param {THREE.Matrix4} m
   */
  instance(key, matKey, factory, m, registry) {
    let rec = this.instances.get(key);
    if (!rec) {
      rec = { key, matKey, factory, registry, matrices: [] };
      this.instances.set(key, rec);
    }
    rec.matrices.push(m.clone());
    return this;
  }

  /* --------------------------------------------------------------- output */

  /** Total vertices, for budgeting. */
  get vertexCount() {
    let n = 0;
    for (const map of this.levels) for (const mb of map.values()) n += mb.vertexCount;
    return n;
  }

  /** Flat list of every builder across every LOD (for the AO bake). */
  builders() {
    const out = [];
    for (const map of this.levels) for (const mb of map.values()) if (!mb.empty) out.push(mb);
    return out;
  }

  /**
   * @param {{lodDistances?:number[], geometryCache?:Map}} opts
   * @returns {THREE.Object3D|null}
   */
  build(opts = {}) {
    const dist = opts.lodDistances || [0, 55, 110];
    const groups = [];
    for (let l = 0; l < 3; l++) {
      const map = this.levels[l];
      if (!map.size) {
        groups.push(null);
        continue;
      }
      const g = new THREE.Group();
      g.name = `${this.name}_lod${l}`;
      let any = false;
      for (const [matKey, mb] of map) {
        if (mb.empty) continue;
        const geo = mb.toGeometry();
        if (!geo) continue;
        geo.name = `${this.name}:${matKey}`;
        const mesh = new THREE.Mesh(geo, this.palette.get(matKey));
        mesh.name = `${this.name}.${matKey}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.userData.surface = this.palette.surface(matKey);
        g.add(mesh);
        any = true;
      }
      groups.push(any ? g : null);
    }

    // Instanced modules ride on LOD 0 and 1 (they vanish at the far level).
    const instRoot = this._buildInstances(opts.geometryCache);

    const present = groups.filter(Boolean);
    if (!present.length && !instRoot) return null;

    if (present.length <= 1) {
      const root = present[0] || new THREE.Group();
      root.name = this.name;
      if (instRoot) root.add(instRoot);
      return root;
    }

    // THREE.LOD switches on the distance from the camera to the LOD's own world
    // position. Our geometry is authored in world space, so the LOD would sit at the
    // origin and every district would switch at once. Put the LOD at the district
    // centroid and counter-translate each level, which leaves the vertices exactly
    // where they were while giving the switch a meaningful reference point.
    const c = new THREE.Vector3();
    const bb = new THREE.Box3();
    for (const mesh of present[0].children) {
      if (mesh.geometry?.boundingBox) bb.union(mesh.geometry.boundingBox);
    }
    if (!bb.isEmpty()) bb.getCenter(c);

    const lod = new THREE.LOD();
    lod.name = this.name;
    lod.position.copy(c);
    lod.matrixAutoUpdate = false;
    lod.updateMatrix();
    for (let l = 0; l < 3; l++) {
      if (!groups[l]) continue;
      if (l === 0 && instRoot) groups[l].add(instRoot);
      groups[l].position.copy(c).negate();
      groups[l].matrixAutoUpdate = false;
      groups[l].updateMatrix();
      lod.addLevel(groups[l], dist[l] ?? l * 60);
    }
    return lod;
  }

  _buildInstances(cache) {
    if (!this.instances.size) return null;
    const root = new THREE.Group();
    root.name = `${this.name}_inst`;
    for (const rec of this.instances.values()) {
      if (!rec.matrices.length) continue;
      let geo = cache?.get(rec.key);
      if (!geo) {
        try {
          geo = rec.factory();
        } catch {
          geo = null;
        }
        if (!geo) continue;
        cache?.set(rec.key, geo);
      }
      const mesh = new THREE.InstancedMesh(geo, this.palette.get(rec.matKey), rec.matrices.length);
      mesh.name = `${this.name}.inst.${rec.key}`;
      for (let i = 0; i < rec.matrices.length; i++) mesh.setMatrixAt(i, rec.matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.surface = this.palette.surface(rec.matKey);
      mesh.frustumCulled = true;
      try {
        mesh.computeBoundingSphere();
      } catch {
        /* three computes it lazily anyway */
      }
      root.add(mesh);
    }
    return root.children.length ? root : null;
  }
}

/** Build a yaw+translate matrix without allocating a fresh Object3D each time. */
export function xform(x, y, z, yaw = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    new THREE.Vector3(sx, sy, sz)
  );
  m.userData = _uid++;
  return m;
}

export default Batcher;
