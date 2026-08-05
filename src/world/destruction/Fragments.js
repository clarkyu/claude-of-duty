/**
 * destruction/Fragments.js — the debris pool. Owner: destruction agent.
 *
 * Every fragment on screen comes out of a fixed-size pool of `THREE.Mesh` slots that
 * are allocated once and then have their geometry and material array re-pointed at a
 * cached fracture cell. Sustained fire therefore costs zero geometry allocation and
 * zero material creation; the only per-break allocation left is the rigid body itself,
 * and only for chunks big enough to deserve one.
 *
 * Two simulation modes, chosen by size:
 *   body    a real `ctx.physics` box body — chunks you can trip over, they tumble,
 *           settle, and go to sleep like any other prop
 *   simple  ballistic integration with drag and a pre-resolved rest height — used for
 *           glass shards and crumbs, where 20 solver islands would be a waste
 *
 * The budget comes from `ctx.settings.get('particleBudget')`. When it is exhausted the
 * *oldest* live fragment is recycled, never the newest, so the debris field always
 * reflects what just happened rather than what happened a minute ago. Fragments do not
 * pop out: they shrink and sink over the last second of their life.
 */
import * as THREE from 'three';

const GRAVITY = 9.81;
const FADE = 1.1;

export class FragmentPool {
  constructor(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'destruction:fragments';
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;
    ctx.scene?.add(this.group);

    /** @type {Array} */
    this.slots = [];
    this.max = 48;
    this.live = 0;
    this.spawned = 0;
    this.recycled = 0;
    this._serial = 0;
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._down = new THREE.Vector3(0, -1, 0);
  }

  setMax(n) {
    this.max = Math.max(4, Math.min(256, Math.round(n)));
    while (this.live > this.max) this._killOldest();
  }

  _newSlot() {
    const mesh = new THREE.Mesh();
    mesh.visible = false;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = true;
    const slot = {
      mesh,
      mats: [null, null],
      body: null,
      active: false,
      mode: 'simple',
      age: 0,
      life: 8,
      serial: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      wx: 0,
      wy: 0,
      wz: 0,
      restY: -1e9,
      resting: false,
      scale: 1,
    };
    mesh.material = slot.mats;
    this.group.add(mesh);
    this.slots.push(slot);
    return slot;
  }

  _free() {
    for (const s of this.slots) if (!s.active) return s;
    if (this.slots.length < this.max) return this._newSlot();
    return this._killOldest();
  }

  _killOldest() {
    let oldest = null;
    for (const s of this.slots) {
      if (!s.active) continue;
      if (!oldest || s.serial < oldest.serial) oldest = s;
    }
    if (oldest) {
      this._release(oldest);
      this.recycled++;
    }
    return oldest;
  }

  _release(slot) {
    if (!slot.active) return;
    slot.active = false;
    slot.mesh.visible = false;
    slot.mesh.geometry = null;
    slot.mats[0] = null;
    slot.mats[1] = null;
    if (slot.body) {
      try {
        this.ctx.physics?.removeBody?.(slot.body);
      } catch {
        /* physics may already be gone during teardown */
      }
      slot.body = null;
    }
    this.live--;
    if (this.live < 0) this.live = 0;
  }

  /**
   * @param {object} d
   * @param {THREE.BufferGeometry} d.geometry  cached fracture cell geometry
   * @param {THREE.Material} d.exterior        material for group 0
   * @param {THREE.Material} d.interior        material for group 1
   * @param {THREE.Vector3}  d.position        world centre of the fragment
   * @param {THREE.Quaternion} d.quaternion    world orientation
   * @param {number[]} d.half                  local half extents, for the collider
   * @param {number} d.volume, d.density, d.radius, d.life
   * @param {number[]} d.velocity, d.spin
   * @param {string} d.surface                 §5 tag for friction/restitution/audio
   */
  spawn(d) {
    if (!d?.geometry) return null;
    const slot = this._free();
    if (!slot) return null;

    const mesh = slot.mesh;
    mesh.geometry = d.geometry;
    slot.mats[0] = d.exterior || d.interior || null;
    slot.mats[1] = d.interior || d.exterior || null;
    if (!slot.mats[0]) return null;
    mesh.position.copy(d.position);
    mesh.quaternion.copy(d.quaternion || this._q.identity());
    mesh.scale.setScalar(1);
    mesh.visible = true;
    mesh.castShadow = !!d.castShadow;
    mesh.receiveShadow = true;
    mesh.userData.dynamic = true;

    slot.active = true;
    slot.age = 0;
    slot.life = d.life ?? 8;
    slot.scale = 1;
    slot.serial = ++this._serial;
    slot.resting = false;
    slot.restY = -1e9;
    this.live++;
    this.spawned++;

    const vel = d.velocity || [0, 0, 0];
    const spin = d.spin || [0, 0, 0];
    const mass = Math.max(0.02, (d.volume || 0.001) * (d.density || 900));

    const wantBody =
      d.mode !== 'simple' && (d.radius || 0) >= (d.bodyThreshold ?? 0.055) && this.ctx.physics?.addBody;

    if (wantBody) {
      let shape = d.shape;
      if (!shape && this.ctx.physics?.shapes?.box) {
        shape = this.ctx.physics.shapes.box(d.half[0], d.half[1], d.half[2]);
      }
      let body = null;
      try {
        body = this.ctx.physics.addBody({
          shape,
          type: 'box',
          halfExtents: d.half,
          mass,
          pos: mesh.position,
          quat: mesh.quaternion,
          surface: d.surface || 'concrete',
          material: d.surface || 'concrete',
          group: 8, // PROP
          mask: 1 | 8, // WORLD | PROP — debris never shoves the player around
          linearDamping: 0.06,
          angularDamping: 0.18,
          inertiaScale: 1.6,
        });
      } catch {
        body = null;
      }
      if (body) {
        body.velocity.set(vel[0], vel[1], vel[2]);
        body.angularVelocity.set(spin[0], spin[1], spin[2]);
        body.entity = { kind: 'debris' };
        slot.body = body;
        slot.mode = 'body';
        return slot;
      }
    }

    // Simple mode: resolve where this thing is going to land, once, up front.
    slot.mode = 'simple';
    slot.vx = vel[0];
    slot.vy = vel[1];
    slot.vz = vel[2];
    slot.wx = spin[0];
    slot.wy = spin[1];
    slot.wz = spin[2];
    slot.restY = this._restHeight(mesh.position, d.half ? d.half[1] : 0.02);
    return slot;
  }

  _restHeight(pos, halfY) {
    let y = -1e9;
    try {
      const hit = this.ctx.physics?.raycast?.(pos, this._down, 14, 1 | 8);
      if (hit) y = hit.point.y;
    } catch {
      /* fall through to the terrain model */
    }
    if (y < -1e8) {
      const g = this.ctx.level?.groundY?.(pos.x, pos.z);
      if (typeof g === 'number' && isFinite(g)) y = g;
    }
    return y < -1e8 ? -1e9 : y + Math.max(0.006, halfY * 0.8);
  }

  update(dt) {
    if (!this.live) return;
    const step = Math.min(dt, 0.05);
    for (const s of this.slots) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) {
        this._release(s);
        continue;
      }

      if (s.mode === 'body') {
        const b = s.body;
        if (b) {
          s.mesh.position.copy(b.position);
          s.mesh.quaternion.copy(b.quaternion);
        }
      } else if (!s.resting) {
        s.vy -= GRAVITY * step;
        const drag = 1 - Math.min(0.6, 0.9 * step);
        s.vx *= drag;
        s.vz *= drag;
        const p = s.mesh.position;
        p.x += s.vx * step;
        p.y += s.vy * step;
        p.z += s.vz * step;
        if (p.y <= s.restY && s.vy < 0) {
          p.y = s.restY;
          if (s.vy < -1.4) {
            // One bounce, then it lies down. Two bounces reads as rubber.
            s.vy *= -0.28;
            s.vx *= 0.55;
            s.vz *= 0.55;
            s.wx *= 0.5;
            s.wy *= 0.5;
            s.wz *= 0.5;
          } else {
            s.resting = true;
            s.vx = s.vy = s.vz = 0;
            s.wx = s.wy = s.wz = 0;
          }
        }
        if (s.wx || s.wy || s.wz) {
          this._e.set(s.wx * step, s.wy * step, s.wz * step);
          this._q.setFromEuler(this._e);
          s.mesh.quaternion.multiply(this._q).normalize();
        }
      }

      // Shrink-and-sink rather than pop. Nothing vanishes in a single frame.
      const left = s.life - s.age;
      if (left < FADE) {
        const k = Math.max(0.001, left / FADE);
        s.scale = k;
        s.mesh.scale.setScalar(k);
        s.mesh.position.y -= (1 - k) * 0.0016;
      }
    }
  }

  /** Live fragments, oldest first — used by the budget trimmer. */
  clear() {
    for (const s of this.slots) this._release(s);
    this.live = 0;
  }

  stats() {
    return { live: this.live, pool: this.slots.length, max: this.max, spawned: this.spawned, recycled: this.recycled };
  }

  dispose() {
    this.clear();
    for (const s of this.slots) {
      s.mesh.geometry = null;
      this.group.remove(s.mesh);
    }
    this.slots.length = 0;
    this.group.parent?.remove(this.group);
  }
}

export default FragmentPool;
