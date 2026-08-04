/**
 * PhysicsWorld.js — deterministic rigid-body world. Owner: physics agent.
 * Publishes: `ctx.physics` (see docs/ARCHITECTURE.md §5).
 *
 * Custom solver, no external engine: the bundle stays lean and every screenshot is
 * byte-reproducible because nothing here calls Math.random(), iterates a Map by object
 * identity, or depends on frame timing (the sim runs on the engine's fixed 120 Hz step
 * and render transforms are interpolated with ctx.time.fixedAlpha).
 *
 * Public API on ctx.physics
 *   addStatic(collider|collider[])                -> Body | Body[]
 *   addBody({shape, mass, pos, quat, material, group, mask, ...}) -> Body
 *   removeBody(body)
 *   raycast(origin, dir, maxDist, mask, out?)     -> Hit | null
 *   raycastAll(origin, dir, maxDist, mask, limit) -> Hit[]
 *   sweepSphere(from, to, radius, mask)           -> Hit | null
 *   sweepCapsule(from, to, radius, height, mask)  -> Hit | null
 *   overlapSphere(center, radius, mask)           -> Body[]
 *   overlapBox(center, halfExtents, quat, mask)   -> Body[]
 *   applyImpulse(body, impulse, worldPoint)
 *   applyRadialImpulse(center, radius, strength, mask)
 *   createRagdoll(skeletonOrPose, opts)           -> Ragdoll
 *   addConstraint(c) / removeConstraint(c) / constraints.{ballSocket,hinge,coneTwist,distance}
 *   shapes.{sphere,box,capsule,convex,trimesh,heightfield,compound}
 *   debugDraw(scene, enabled)
 *   GROUP, SURFACES, materials, stats, setGravity(v), setBroadphase(kind)
 *
 * Hit = { point, normal, distance, body, surface, material, faceIndex, entity }
 *
 * Events emitted
 *   `physics:impact`  {body, other, point, normal, speed, surface}  — a new contact
 *                      whose closing speed exceeds `impactThreshold` (props landing,
 *                      debris tumbling); FX/audio hang decals and thuds off this.
 *   `physics:sleep`   {body}
 * Events consumed
 *   `explosion` {point, radius, damage|force}   — applies a falloff radial impulse.
 *   `quality:changed`                           — scales solver iteration counts.
 */
import * as THREE from 'three';
import * as Shapes from './Shapes.js';
import { Broadphase } from './Broadphase.js';
import {
  Solver, SOLVER_DEFAULTS, ContactConstraint,
  BallSocketConstraint, HingeConstraint, ConeTwistConstraint, DistanceConstraint,
} from './Solver.js';
import { createRagdoll as buildRagdoll, RAGDOLL_BONES } from './Ragdoll.js';

export const GROUP = Object.freeze({
  WORLD: 1, PLAYER: 2, AI: 4, PROP: 8, PROJECTILE: 16,
  TRIGGER: 32, RAGDOLL: 64, VIEWMODEL: 128, ALL: 0xffff,
});

/** The exact surface-tag set from ARCHITECTURE.md §5. */
export const SURFACES = Object.freeze([
  'concrete', 'metal', 'wood', 'dirt', 'sand', 'grass', 'glass', 'water',
  'fabric', 'flesh', 'rubber', 'plaster', 'ceramic', 'foliage', 'snow',
]);

/** friction / restitution / density(kg per m^3) per surface tag. */
const MATERIALS = {
  concrete: { friction: 0.92, restitution: 0.04, density: 2300, surface: 'concrete' },
  metal: { friction: 0.55, restitution: 0.16, density: 7800, surface: 'metal' },
  wood: { friction: 0.72, restitution: 0.18, density: 620, surface: 'wood' },
  dirt: { friction: 0.88, restitution: 0.02, density: 1500, surface: 'dirt' },
  sand: { friction: 1.05, restitution: 0.0, density: 1600, surface: 'sand' },
  grass: { friction: 0.85, restitution: 0.04, density: 900, surface: 'grass' },
  glass: { friction: 0.32, restitution: 0.22, density: 2500, surface: 'glass' },
  water: { friction: 0.16, restitution: 0.0, density: 1000, surface: 'water' },
  fabric: { friction: 1.0, restitution: 0.0, density: 300, surface: 'fabric' },
  flesh: { friction: 0.95, restitution: 0.0, density: 1050, surface: 'flesh' },
  rubber: { friction: 1.25, restitution: 0.62, density: 1200, surface: 'rubber' },
  plaster: { friction: 0.8, restitution: 0.05, density: 850, surface: 'plaster' },
  ceramic: { friction: 0.58, restitution: 0.24, density: 2400, surface: 'ceramic' },
  foliage: { friction: 0.6, restitution: 0.02, density: 400, surface: 'foliage' },
  snow: { friction: 0.42, restitution: 0.0, density: 400, surface: 'snow' },
  default: { friction: 0.7, restitution: 0.05, density: 900, surface: 'concrete' },
};

const FIXED_DT = 1 / 120;
let _bodyId = 1;

/**
 * V8's Math.hypot does careful overflow/underflow scaling and shows up as ~10% of the
 * whole physics frame in a profile. At metre scale we do not need it.
 */
function len3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}


/* ------------------------------------------------------------------ *
 * Body
 * ------------------------------------------------------------------ */

export class Body {
  constructor(shape, opts = {}) {
    this.id = _bodyId++;
    this.shape = shape;
    this.world = null;

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    if (opts.pos) this.position.copy(opts.pos);
    else if (opts.position) this.position.copy(opts.position);
    if (opts.quat) this.quaternion.copy(opts.quat);
    else if (opts.quaternion) this.quaternion.copy(opts.quaternion);
    this.quaternion.normalize();

    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    this.pseudoV = new THREE.Vector3();
    this.pseudoW = new THREE.Vector3();
    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();

    this.prevPosition = this.position.clone();
    this.prevQuaternion = this.quaternion.clone();

    this.aabbMin = new THREE.Vector3();
    this.aabbMax = new THREE.Vector3();

    const mat = resolveMaterial(opts.material, shape);
    this.material = mat;
    this.friction = opts.friction ?? mat.friction;
    this.restitution = opts.restitution ?? mat.restitution;
    this.surface = opts.surface || mat.surface;

    this.isStatic = !!opts.isStatic || (opts.mass ?? 0) <= 0;
    this.isKinematic = !!opts.kinematic;
    this.isTrigger = !!opts.trigger;
    this.group = opts.group ?? (this.isStatic ? GROUP.WORLD : GROUP.PROP);
    this.mask = opts.mask ?? GROUP.ALL;

    this.linearDamping = opts.linearDamping ?? 0.02;
    this.angularDamping = opts.angularDamping ?? 0.06;
    this.gravityScale = opts.gravityScale ?? 1;
    this.allowSleep = opts.allowSleep ?? true;
    this.awake = !this.isStatic;
    this.sleepTimer = 0;
    this.ccd = !!opts.ccd;

    this.entity = opts.entity ?? null;
    this.userData = opts.userData ?? null;
    this.mesh = opts.mesh ?? null;
    this.meshOffset = shape.originOffset ? shape.originOffset.clone() : new THREE.Vector3();
    this.ignore = null;
    this.proxyId = -1;
    this.proxyStatic = this.isStatic;
    this._index = -1;
    this.onContact = opts.onContact ?? null;
    /** optional per-triangle surface tags for a mesh collider */
    this.faceSurfaces = opts.faceSurfaces ?? null;

    /*
     * Inertia scaling. Physically correct inertia on a 0.5 kg hand gives an inverse
     * inertia around 1700, so any joint or contact impulse spins it like a firework.
     * Every shipped ragdoll inflates limb inertia; it also reads as more weight.
     */
    this.inertiaScale = opts.inertiaScale ?? 1;
    this.invI = new Float64Array(9);
    this._localI = new Float64Array(9);
    this.setMass(this.isStatic ? 0 : (opts.mass ?? 1));
    this.updateAABB();
  }

  setMass(mass) {
    if (!(mass > 0) || this.isStatic || this.isKinematic) {
      this.mass = 0;
      this.invMass = 0;
      this._localI.fill(0);
      this.invI.fill(0);
      if (mass <= 0) this.isStatic = this.isStatic || !this.isKinematic;
      return;
    }
    this.mass = mass;
    this.invMass = 1 / mass;
    const I = _tmpI9;
    Shapes.computeInertia(this.shape, mass * (this.inertiaScale || 1), I);
    // Invert the (possibly full) body-space tensor once.
    if (!invert3(I, this._localI)) {
      const d = 1 / Math.max(1e-6, I[0] || mass);
      this._localI.set([d, 0, 0, 0, d, 0, 0, 0, d]);
    }
    this.updateInertiaWorld();
  }

  updateInertiaWorld() {
    if (this.invMass === 0) { this.invI.fill(0); return; }
    Shapes.quatToMat3(this.quaternion, _rot9);
    const R = _rot9, L = this._localI, O = this.invI;
    // O = R * L * R^T
    const t = _tmp9;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        t[r * 3 + c] = R[r * 3] * L[c] + R[r * 3 + 1] * L[3 + c] + R[r * 3 + 2] * L[6 + c];
      }
    }
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        O[r * 3 + c] = t[r * 3] * R[c * 3] + t[r * 3 + 1] * R[c * 3 + 1] + t[r * 3 + 2] * R[c * 3 + 2];
      }
    }
  }

  updateAABB() {
    Shapes.computeAABB(this.shape, this.position, this.quaternion, this.aabbMin, this.aabbMax);
  }

  wake() {
    if (this.isStatic) return;
    this.awake = true;
    this.sleepTimer = 0;
  }

  sleep() {
    if (this.isStatic) return;
    this.awake = false;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
  }

  applyImpulse(ix, iy, iz, px, py, pz) {
    if (this.invMass === 0) return;
    this.wake();
    this.velocity.x += ix * this.invMass;
    this.velocity.y += iy * this.invMass;
    this.velocity.z += iz * this.invMass;
    if (px !== undefined) {
      const rx = px - this.position.x, ry = py - this.position.y, rz = pz - this.position.z;
      const tx = ry * iz - rz * iy, ty = rz * ix - rx * iz, tz = rx * iy - ry * ix;
      const I = this.invI;
      this.angularVelocity.x += I[0] * tx + I[1] * ty + I[2] * tz;
      this.angularVelocity.y += I[3] * tx + I[4] * ty + I[5] * tz;
      this.angularVelocity.z += I[6] * tx + I[7] * ty + I[8] * tz;
    }
  }

  applyForce(fx, fy, fz) {
    if (this.invMass === 0) return;
    this.wake();
    this.force.x += fx; this.force.y += fy; this.force.z += fz;
  }

  applyTorque(tx, ty, tz) {
    if (this.invMass === 0) return;
    this.wake();
    this.torque.x += tx; this.torque.y += ty; this.torque.z += tz;
  }

  setPosition(x, y, z) {
    this.position.set(x, y, z);
    this.prevPosition.copy(this.position);
    this.updateAABB();
    this.wake();
    this.world?._proxyDirty(this);
  }

  setQuaternion(q) {
    this.quaternion.copy(q).normalize();
    this.prevQuaternion.copy(this.quaternion);
    this.updateInertiaWorld();
    this.updateAABB();
    this.wake();
    this.world?._proxyDirty(this);
  }

  setVelocity(x, y, z) {
    this.velocity.set(x, y, z);
    this.wake();
  }

  /**
   * Attach a render object; the world writes its interpolated transform every frame
   * (see the system's update()). The transform written is world-space, so the mesh
   * should live at the scene root, not parented under a moving node.
   */
  setMesh(obj3d) {
    this.mesh = obj3d;
    if (obj3d) obj3d.matrixAutoUpdate = true;
    return this;
  }

  /** Interpolated render transform for smooth motion at any framerate. */
  getRenderTransform(alpha, outPos, outQuat) {
    if (outPos) outPos.lerpVectors(this.prevPosition, this.position, alpha);
    if (outQuat) outQuat.copy(this.prevQuaternion).slerp(this.quaternion, alpha);
    return this;
  }
}

const _tmpI9 = new Float64Array(9);
const _rot9 = new Float64Array(9);
const _tmp9 = new Float64Array(9);

function invert3(m, out) {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  let det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-16) return false;
  det = 1 / det;
  out[0] = A * det; out[1] = -(b * i - c * h) * det; out[2] = (b * f - c * e) * det;
  out[3] = B * det; out[4] = (a * i - c * g) * det; out[5] = -(a * f - c * d) * det;
  out[6] = C * det; out[7] = -(a * h - b * g) * det; out[8] = (a * e - b * d) * det;
  return true;
}

function resolveMaterial(m, shape) {
  void shape;
  if (!m) return MATERIALS.default;
  if (typeof m === 'string') return MATERIALS[m] || MATERIALS.default;
  const base = MATERIALS[m.surface] || MATERIALS.default;
  return {
    friction: m.friction ?? base.friction,
    restitution: m.restitution ?? base.restitution,
    density: m.density ?? base.density,
    surface: m.surface || base.surface,
  };
}

/* ------------------------------------------------------------------ *
 * World
 * ------------------------------------------------------------------ */

export class World {
  constructor(opts = {}) {
    this.gravity = new THREE.Vector3(0, -9.81, 0);
    if (opts.gravity) this.gravity.copy(opts.gravity);
    this.broadphase = new Broadphase({ margin: opts.margin ?? 0.06, kind: opts.broadphase || 'tree' });
    this.solver = new Solver(opts.solver);
    /** dynamic + kinematic bodies, kept in creation (id) order for determinism */
    this.bodies = [];
    /** static bodies, id order */
    this.statics = [];
    this.joints = [];
    /** @type {import('./Ragdoll.js').Ragdoll[]} — driven before each step */
    this._ragdolls = [];
    this._manifolds = new Map();
    this._live = [];
    this._pool = [];
    this._active = [];
    this._activeCount = 0;
    this._manifold = new Shapes.Manifold();
    this._stamp = 0;
    this.impactThreshold = 1.6;
    this.onImpact = null;
    this.stats = {
      bodies: 0, statics: 0, awake: 0, pairs: 0, contacts: 0, points: 0,
      joints: 0, islands: 0, sleeping: 0, stepMs: 0, broadMs: 0, narrowMs: 0, solveMs: 0,
      steps: 0,
    };
    this._now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
  }

  setGravity(x, y, z) {
    if (typeof x === 'object') this.gravity.copy(x);
    else this.gravity.set(x, y, z);
    for (const b of this.bodies) b.wake();
  }

  addBody(body) {
    body.world = this;
    if (body.isStatic) {
      this.statics.push(body);
    } else {
      body._index = this.bodies.length;
      this.bodies.push(body);
    }
    body.updateAABB();
    this.broadphase.addProxy(body);
    return body;
  }

  removeBody(body) {
    if (!body || body.world !== this) return;
    this.broadphase.removeProxy(body);
    const list = body.isStatic ? this.statics : this.bodies;
    const i = list.indexOf(body);
    if (i >= 0) list.splice(i, 1);
    if (!body.isStatic) for (let k = i; k < this.bodies.length; k++) this.bodies[k]._index = k;
    // Drop any manifolds and joints that referenced it.
    for (let k = this._live.length - 1; k >= 0; k--) {
      const c = this._live[k];
      if (c.bodyA === body || c.bodyB === body) {
        this._manifolds.delete(c.key);
        this._live.splice(k, 1);
        this._pool.push(c);
      }
    }
    for (let k = this.joints.length - 1; k >= 0; k--) {
      if (this.joints[k].bodyA === body || this.joints[k].bodyB === body) this.joints.splice(k, 1);
    }
    body.world = null;
  }

  _proxyDirty(body) {
    this.broadphase.updateProxy(body);
  }

  addJoint(j) {
    this.joints.push(j);
    if (!j.collideConnected) {
      const a = j.bodyA, b = j.bodyB;
      if (a && b) {
        (a.ignore ||= new Set()).add(b.id);
        (b.ignore ||= new Set()).add(a.id);
      }
    }
    j.bodyA?.wake();
    j.bodyB?.wake();
    return j;
  }

  removeJoint(j) {
    const i = this.joints.indexOf(j);
    if (i >= 0) this.joints.splice(i, 1);
    j.bodyA?.ignore?.delete(j.bodyB?.id);
    j.bodyB?.ignore?.delete(j.bodyA?.id);
  }

  /* ---------------- step ---------------- */

  step(dt) {
    const t0 = this._now();
    this._stamp++;
    const bodies = this.bodies;

    // Animation-driven ragdolls get their velocity targets before integration.
    for (let i = 0; i < this._ragdolls.length; i++) {
      try {
        this._ragdolls[i].preStep(dt);
      } catch { /* a broken ragdoll must never stall the world */ }
    }

    // 1. Integrate velocities and refresh proxies.
    const gx = this.gravity.x, gy = this.gravity.y, gz = this.gravity.z;
    let awake = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b._index = i;
      b.prevPosition.copy(b.position);
      b.prevQuaternion.copy(b.quaternion);
      b.pseudoV.set(0, 0, 0);
      b.pseudoW.set(0, 0, 0);
      if (!b.awake || b.invMass === 0) {
        b.force.set(0, 0, 0);
        b.torque.set(0, 0, 0);
        continue;
      }
      awake++;
      const im = b.invMass;
      b.velocity.x += (gx * b.gravityScale + b.force.x * im) * dt;
      b.velocity.y += (gy * b.gravityScale + b.force.y * im) * dt;
      b.velocity.z += (gz * b.gravityScale + b.force.z * im) * dt;
      const I = b.invI, T = b.torque;
      b.angularVelocity.x += (I[0] * T.x + I[1] * T.y + I[2] * T.z) * dt;
      b.angularVelocity.y += (I[3] * T.x + I[4] * T.y + I[5] * T.z) * dt;
      b.angularVelocity.z += (I[6] * T.x + I[7] * T.y + I[8] * T.z) * dt;
      b.force.set(0, 0, 0);
      b.torque.set(0, 0, 0);
      // Exponential damping is stable at any dt, unlike (1 - d*dt).
      const ld = 1 / (1 + b.linearDamping * dt);
      const ad = 1 / (1 + b.angularDamping * dt);
      b.velocity.multiplyScalar(ld);
      b.angularVelocity.multiplyScalar(ad);
      this.broadphase.updateProxy(b, b.velocity.x * dt, b.velocity.y * dt, b.velocity.z * dt);
    }
    const t1 = this._now();

    // 2. Broadphase pairs.
    const pairCount = this.broadphase.computePairs(bodies);
    const t2 = this._now();

    // 3. Narrowphase -> persistent manifolds.
    const bpA = this.broadphase.pairA, bpB = this.broadphase.pairB;
    let active = 0;
    const m = this._manifold;
    for (let i = 0; i < pairCount; i++) {
      const A = bpA[i], B = bpB[i];
      if (A.isTrigger || B.isTrigger) {
        // Triggers still need the tight test, just no constraint.
        if (Shapes.collide(A.shape, A.position, A.quaternion, B.shape, B.position, B.quaternion, m)) {
          A.onContact?.(B, m, true);
          B.onContact?.(A, m, true);
        }
        continue;
      }
      // Tight-AABB reject. The broadphase works on *fat* boxes (margin + velocity
      // prediction), so a good third of its candidates are not actually touching;
      // six comparisons here are far cheaper than a full SAT that returns false.
      const amn = A.aabbMin, amx = A.aabbMax, bmn = B.aabbMin, bmx = B.aabbMax;
      if (amn.x > bmx.x || amx.x < bmn.x || amn.y > bmx.y ||
          amx.y < bmn.y || amn.z > bmx.z || amx.z < bmn.z) continue;
      if (!Shapes.collide(A.shape, A.position, A.quaternion, B.shape, B.position, B.quaternion, m)) continue;
      const key = A.id * 4194304 + B.id;
      let c = this._manifolds.get(key);
      const isNew = c === undefined;
      if (isNew) {
        c = this._pool.length ? this._pool.pop() : new ContactConstraint();
        c.key = key;
        c.count = 0;
        c.age = 0;
        this._manifolds.set(key, c);
        this._live.push(c);
      }
      c.update(m, A, B);
      c.friction = Math.sqrt(A.friction * B.friction);
      c.restitution = Math.max(A.restitution, B.restitution);
      c.stamp = this._stamp;
      // A sleeping body touched by a moving one has to wake up.
      if (A.awake && !B.awake && B.invMass > 0) B.wake();
      else if (B.awake && !A.awake && A.invMass > 0) A.wake();
      if (isNew && this.onImpact) this._reportImpact(c, A, B);
      this._active[active++] = c;
      A.onContact?.(B, m, false);
      B.onContact?.(A, m, false);
    }
    this._activeCount = active;
    // Retire stale manifolds (array order, never Map order).
    for (let i = this._live.length - 1; i >= 0; i--) {
      const c = this._live[i];
      if (c.stamp === this._stamp) continue;
      this._manifolds.delete(c.key);
      this._live.splice(i, 1);
      c.bodyA = null; c.bodyB = null; c.count = 0; c.age = 0;
      if (this._pool.length < 512) this._pool.push(c);
    }
    const t3 = this._now();

    // 4. Solve.
    this.solver.solve(this._active, active, this.joints, bodies, dt);

    // 5. Integrate positions (velocity + split-impulse pseudo velocity).
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.awake || b.invMass === 0) continue;
      const vx = b.velocity.x + b.pseudoV.x;
      const vy = b.velocity.y + b.pseudoV.y;
      const vz = b.velocity.z + b.pseudoV.z;
      b.position.x += vx * dt;
      b.position.y += vy * dt;
      b.position.z += vz * dt;
      const wx = b.angularVelocity.x + b.pseudoW.x;
      const wy = b.angularVelocity.y + b.pseudoW.y;
      const wz = b.angularVelocity.z + b.pseudoW.z;
      if (wx || wy || wz) integrateQuat(b.quaternion, wx, wy, wz, dt);
      b.pseudoV.set(0, 0, 0);
      b.pseudoW.set(0, 0, 0);
      /*
       * Continuous collision for the handful of bodies that need it (grenades, thrown
       * knives, fast debris). Discrete stepping tunnels as soon as a body travels more
       * than its own thickness in 1/120 s; a sphere sweep from the previous position
       * costs one BVH walk and stops it dead at the surface.
       */
      if (b.ccd) {
        const mx = b.position.x - b.prevPosition.x;
        const my = b.position.y - b.prevPosition.y;
        const mz = b.position.z - b.prevPosition.z;
        const moved = mx * mx + my * my + mz * mz;
        const r = Math.max(0.02, b.shape.boundingRadius);
        if (moved > r * r) {
          const t = this._sweepClamp(b, r);
          if (t >= 0) {
            b.position.set(
              b.prevPosition.x + mx * t,
              b.prevPosition.y + my * t,
              b.prevPosition.z + mz * t
            );
          }
        }
      }
      b.updateInertiaWorld();
      b.updateAABB();
    }

    // 6. Kinematic bodies: derive velocity from the transform delta so contacts push.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.isKinematic) continue;
      b.velocity.set(
        (b.position.x - b.prevPosition.x) / dt,
        (b.position.y - b.prevPosition.y) / dt,
        (b.position.z - b.prevPosition.z) / dt
      );
      b.updateAABB();
      this.broadphase.updateProxy(b);
    }

    // 7. Sleeping.
    this.solver.updateSleeping(bodies, this._active, active, this.joints, dt);

    const t4 = this._now();
    const s = this.stats;
    s.bodies = bodies.length;
    s.statics = this.statics.length;
    s.awake = awake;
    s.pairs = pairCount;
    s.contacts = active;
    s.points = this.solver.stats.points;
    s.joints = this.solver.stats.joints;
    s.islands = this.solver.stats.islands;
    s.sleeping = this.solver.stats.sleeping;
    s.broadMs = t2 - t1;
    s.narrowMs = t3 - t2;
    s.solveMs = t4 - t3;
    s.stepMs = t4 - t0;
    s.steps++;
  }

  /** @returns {number} time of impact in [0,1], or -1 when the path is clear. */
  _sweepClamp(b, radius) {
    if (!this._ccdShape || this._ccdRadius !== radius) {
      this._ccdShape = Shapes.sphere(radius * 0.9);
      this._ccdRadius = radius;
    }
    const from = b.prevPosition, to = b.position;
    let best = -1;
    const mnx = Math.min(from.x, to.x) - radius, mxx = Math.max(from.x, to.x) + radius;
    const mny = Math.min(from.y, to.y) - radius, mxy = Math.max(from.y, to.y) + radius;
    const mnz = Math.min(from.z, to.z) - radius, mxz = Math.max(from.z, to.z) + radius;
    const shape = this._ccdShape;
    const out = _ccdOut;
    this.broadphase.staticTree.query(mnx, mny, mnz, mxx, mxy, mxz, (other) => {
      if (!other || (b.group & other.mask) === 0 || (other.group & b.mask) === 0) return;
      const t = Shapes.sweepConvex(shape, from, _identQ, to, other.shape, other.position, other.quaternion, out);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    });
    return best;
  }

  _reportImpact(c, A, B) {
    if (!c.count) return;
    let vn = 0;
    const p = c.points[0];
    const rax = p.px - A.position.x, ray = p.py - A.position.y, raz = p.pz - A.position.z;
    const rbx = p.px - B.position.x, rby = p.py - B.position.y, rbz = p.pz - B.position.z;
    const avx = A.velocity.x + (A.angularVelocity.y * raz - A.angularVelocity.z * ray);
    const avy = A.velocity.y + (A.angularVelocity.z * rax - A.angularVelocity.x * raz);
    const avz = A.velocity.z + (A.angularVelocity.x * ray - A.angularVelocity.y * rax);
    const bvx = B.velocity.x + (B.angularVelocity.y * rbz - B.angularVelocity.z * rby);
    const bvy = B.velocity.y + (B.angularVelocity.z * rbx - B.angularVelocity.x * rbz);
    const bvz = B.velocity.z + (B.angularVelocity.x * rby - B.angularVelocity.y * rbx);
    vn = (bvx - avx) * c.nx + (bvy - avy) * c.ny + (bvz - avz) * c.nz;
    const speed = Math.abs(vn);
    if (speed < this.impactThreshold) return;
    this.onImpact(A, B, p.px, p.py, p.pz, c.nx, c.ny, c.nz, speed);
  }
}

const _ccdOut = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0 };
const _identQ = new THREE.Quaternion();

function integrateQuat(q, wx, wy, wz, dt) {
  // Exponential map: exact for constant angular velocity, no drift from normalising
  // a first-order update every step (which visibly shrinks fast-spinning debris).
  const angle = len3(wx, wy, wz) * dt;
  if (angle < 1e-9) {
    const hx = wx * dt * 0.5, hy = wy * dt * 0.5, hz = wz * dt * 0.5;
    const nx = q.x + (hx * q.w + hy * q.z - hz * q.y);
    const ny = q.y + (hy * q.w + hz * q.x - hx * q.z);
    const nz = q.z + (hz * q.w + hx * q.y - hy * q.x);
    const nw = q.w - (hx * q.x + hy * q.y + hz * q.z);
    q.set(nx, ny, nz, nw).normalize();
    return;
  }
  const inv = 1 / (angle / dt);
  const s = Math.sin(angle * 0.5);
  const dx = wx * inv * s, dy = wy * inv * s, dz = wz * inv * s, dw = Math.cos(angle * 0.5);
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  q.set(
    dw * qx + dx * qw + dy * qz - dz * qy,
    dw * qy + dy * qw + dz * qx - dx * qz,
    dw * qz + dz * qw + dx * qy - dy * qx,
    dw * qw - dx * qx - dy * qy - dz * qz
  ).normalize();
}

/* ------------------------------------------------------------------ *
 * System factory
 * ------------------------------------------------------------------ */

export default function createPhysicsWorld(ctx) {
  const world = new World();
  const rayOut = { t: 0, nx: 0, ny: 0, nz: 0, faceIndex: -1, childIndex: -1 };
  const sweepOut = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0 };
  const scratch = {
    v0: new THREE.Vector3(), v1: new THREE.Vector3(), v2: new THREE.Vector3(),
    q0: new THREE.Quaternion(),
    mn: new THREE.Vector3(), mx: new THREE.Vector3(),
    manifold: new Shapes.Manifold(),
  };
  const overlapResults = [];
  /** cached query shapes so raycast/sweep/overlap never allocate a shape per call */
  const shapeCache = new Map();
  let fallbackGround = null;
  let debug = null;
  let unsubs = [];

  /* --- collider ingestion ------------------------------------------------ */

  function shapeFromCollider(c) {
    const type = (c.type || 'box').toLowerCase();
    switch (type) {
      case 'sphere':
        return Shapes.sphere(c.radius ?? 0.5);
      case 'capsule': {
        const r = c.radius ?? 0.3;
        const hh = c.halfHeight !== undefined
          ? c.halfHeight
          : Math.max(0, (c.height ?? 1.8) / 2 - r);
        return Shapes.capsule(r, hh);
      }
      case 'plane': {
        // A plane is a very large, very thin box — keeps one narrowphase path.
        const size = c.size ?? 500;
        return Shapes.box(size, 0.5, size);
      }
      case 'convex':
        return Shapes.convex(c.points || c.vertices || []);
      case 'heightfield':
        return Shapes.heightfield(
          c.heights, c.width ?? c.nx ?? 0, c.depth ?? c.nz ?? 0,
          c.scaleX ?? c.scale ?? 1, c.scaleZ ?? c.scale ?? 1
        );
      case 'mesh':
      case 'trimesh': {
        const geo = extractGeometry(c);
        if (!geo) return Shapes.box(0.5, 0.5, 0.5);
        return Shapes.trimesh(geo.vertices, geo.indices);
      }
      case 'compound':
        return Shapes.compound(
          (c.children || []).map((ch) => ({
            shape: ch.shape || shapeFromCollider(ch),
            position: ch.position || ch.pos,
            quaternion: ch.quaternion || ch.quat,
          }))
        );
      case 'box':
      default: {
        if (c.halfExtents) {
          const h = c.halfExtents;
          return Shapes.box(h.x ?? h[0], h.y ?? h[1], h.z ?? h[2]);
        }
        if (c.size) {
          const s = c.size;
          return Shapes.box((s.x ?? s[0]) / 2, (s.y ?? s[1]) / 2, (s.z ?? s[2]) / 2);
        }
        return Shapes.box(c.hx ?? 0.5, c.hy ?? 0.5, c.hz ?? 0.5);
      }
    }
  }

  /** Accepts raw arrays, a THREE.BufferGeometry, or a THREE.Mesh/Object3D. */
  function extractGeometry(c) {
    try {
      if (c.vertices && c.indices) {
        return { vertices: Float64Array.from(c.vertices), indices: Uint32Array.from(c.indices) };
      }
      let geometry = c.geometry || null;
      let matrix = c.matrix || null;
      const obj = c.object || c.mesh || null;
      if (!geometry && obj) {
        if (obj.isMesh) {
          geometry = obj.geometry;
          obj.updateWorldMatrix?.(true, false);
          matrix = c.matrix || obj.matrixWorld;
        } else if (obj.isObject3D) {
          return mergeObjectGeometry(obj);
        }
      }
      if (!geometry) return null;
      const posAttr = geometry.getAttribute?.('position');
      if (!posAttr) return null;
      const verts = new Float64Array(posAttr.count * 3);
      const v = scratch.v0;
      for (let i = 0; i < posAttr.count; i++) {
        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        if (matrix) v.applyMatrix4(matrix);
        verts[i * 3] = v.x; verts[i * 3 + 1] = v.y; verts[i * 3 + 2] = v.z;
      }
      let idx;
      if (geometry.index) idx = Uint32Array.from(geometry.index.array);
      else {
        idx = new Uint32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) idx[i] = i;
      }
      return { vertices: verts, indices: idx };
    } catch (err) {
      console.warn('[physics] could not read collider geometry:', err?.message || err);
      return null;
    }
  }

  function mergeObjectGeometry(root) {
    const verts = [];
    const idx = [];
    const v = new THREE.Vector3();
    root.updateWorldMatrix?.(true, true);
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.getAttribute?.('position');
      if (!pos) return;
      const base = verts.length / 3;
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
        verts.push(v.x, v.y, v.z);
      }
      if (o.geometry.index) {
        const a = o.geometry.index.array;
        for (let i = 0; i < a.length; i++) idx.push(base + a[i]);
      } else {
        for (let i = 0; i < pos.count; i++) idx.push(base + i);
      }
    });
    if (!idx.length) return null;
    return { vertices: Float64Array.from(verts), indices: Uint32Array.from(idx) };
  }

  function addStatic(collider) {
    if (Array.isArray(collider)) return collider.map(addStatic);
    if (!collider) return null;
    try {
      const shape = collider.shape || shapeFromCollider(collider);
      let pos = collider.pos || collider.position;
      let quat = collider.quat || collider.quaternion;
      // A plane described by normal/constant becomes a thin box under the surface.
      if ((collider.type || '').toLowerCase() === 'plane') {
        const n = collider.normal
          ? scratch.v0.copy(collider.normal).normalize()
          : scratch.v0.set(0, 1, 0);
        const d = collider.constant ?? collider.offset ?? 0;
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
        pos = new THREE.Vector3(n.x * d, n.y * d, n.z * d).addScaledVector(n, -0.5);
        quat = q;
      }
      const body = new Body(shape, {
        ...collider,
        pos, quat,
        mass: 0,
        isStatic: true,
        group: collider.group ?? GROUP.WORLD,
        material: collider.material ?? collider.surface,
        surface: collider.surface,
      });
      return world.addBody(body);
    } catch (err) {
      console.warn('[physics] addStatic failed, collider skipped:', err?.message || err);
      return null;
    }
  }

  function addBody(desc = {}) {
    try {
      const shape = desc.shape && desc.shape.type !== undefined
        ? desc.shape
        : shapeFromCollider(desc.shape || desc);
      let mass = desc.mass;
      if (mass === undefined) {
        const mat = resolveMaterial(desc.material, shape);
        mass = Math.max(0.05, (shape.volume || 0.01) * (mat.density || 900) * 0.35);
      }
      const body = new Body(shape, { ...desc, mass });
      return world.addBody(body);
    } catch (err) {
      console.warn('[physics] addBody failed:', err?.message || err);
      return null;
    }
  }

  /* --- queries ----------------------------------------------------------- */

  function makeHit() {
    return {
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      distance: 0,
      body: null,
      surface: 'concrete',
      material: null,
      faceIndex: -1,
      entity: null,
      fraction: 0,
    };
  }

  function surfaceOf(body, faceIndex) {
    if (body.faceSurfaces && faceIndex >= 0) {
      const s = body.faceSurfaces[faceIndex];
      if (typeof s === 'string') return s;
      if (typeof s === 'number' && SURFACES[s]) return SURFACES[s];
    }
    return body.surface;
  }

  let _rcMask = GROUP.ALL;
  let _rcBest = Infinity;
  let _rcBody = null;
  let _rcOx = 0, _rcOy = 0, _rcOz = 0, _rcDx = 0, _rcDy = 0, _rcDz = 0;
  let _rcIgnore = null;
  const _rcHitOut = { t: 0, nx: 0, ny: 0, nz: 0, faceIndex: -1 };

  const _rayLeaf = (body) => {
    if (!body || (body.group & _rcMask) === 0) return _rcBest;
    if (_rcIgnore && (_rcIgnore === body || (_rcIgnore.has && _rcIgnore.has(body)))) return _rcBest;
    if (Shapes.raycastShape(body.shape, body.position, body.quaternion,
      _rcOx, _rcOy, _rcOz, _rcDx, _rcDy, _rcDz, _rcBest, rayOut)) {
      if (rayOut.t < _rcBest) {
        _rcBest = rayOut.t;
        _rcBody = body;
        _rcHitOut.t = rayOut.t;
        _rcHitOut.nx = rayOut.nx; _rcHitOut.ny = rayOut.ny; _rcHitOut.nz = rayOut.nz;
        _rcHitOut.faceIndex = rayOut.faceIndex;
      }
    }
    return _rcBest;
  };

  /**
   * Closest hit along a ray. `out` is optional — pass a reused Hit for a completely
   * allocation-free call (ballistics does this for every pellet).
   */
  function raycast(origin, dir, maxDist = 1000, mask = GROUP.ALL, out = null) {
    const dx = dir.x, dy = dir.y, dz = dir.z;
    const len = len3(dx, dy, dz);
    if (!(len > 0) || !(maxDist > 0)) return null;
    _rcOx = origin.x; _rcOy = origin.y; _rcOz = origin.z;
    _rcDx = dx / len; _rcDy = dy / len; _rcDz = dz / len;
    _rcMask = mask;
    _rcBest = maxDist;
    _rcBody = null;
    _rcIgnore = null;
    world.broadphase.raycast(_rcOx, _rcOy, _rcOz, _rcDx, _rcDy, _rcDz, maxDist, _rayLeaf);
    if (!_rcBody) return null;
    const hit = out || makeHit();
    hit.distance = _rcHitOut.t;
    hit.fraction = _rcHitOut.t / maxDist;
    hit.point.set(
      _rcOx + _rcDx * _rcHitOut.t,
      _rcOy + _rcDy * _rcHitOut.t,
      _rcOz + _rcDz * _rcHitOut.t
    );
    hit.normal.set(_rcHitOut.nx, _rcHitOut.ny, _rcHitOut.nz);
    // Always face the ray so decals and impact FX orient correctly.
    if (hit.normal.x * _rcDx + hit.normal.y * _rcDy + hit.normal.z * _rcDz > 0) hit.normal.negate();
    hit.body = _rcBody;
    hit.faceIndex = _rcHitOut.faceIndex;
    hit.surface = surfaceOf(_rcBody, _rcHitOut.faceIndex);
    hit.material = _rcBody.material;
    hit.entity = _rcBody.entity;
    return hit;
  }

  /** Every hit along the ray, near to far. Used by penetration/wallbang logic. */
  function raycastAll(origin, dir, maxDist = 1000, mask = GROUP.ALL, limit = 8) {
    const hits = [];
    const skip = new Set();
    let guard = 0;
    while (hits.length < limit && guard++ < limit + 4) {
      _rcIgnore = skip;
      const dx = dir.x, dy = dir.y, dz = dir.z;
      const len = len3(dx, dy, dz) || 1;
      _rcOx = origin.x; _rcOy = origin.y; _rcOz = origin.z;
      _rcDx = dx / len; _rcDy = dy / len; _rcDz = dz / len;
      _rcMask = mask;
      _rcBest = maxDist;
      _rcBody = null;
      world.broadphase.raycast(_rcOx, _rcOy, _rcOz, _rcDx, _rcDy, _rcDz, maxDist, _rayLeaf);
      _rcIgnore = null;
      if (!_rcBody) break;
      const hit = makeHit();
      hit.distance = _rcHitOut.t;
      hit.fraction = _rcHitOut.t / maxDist;
      hit.point.set(_rcOx + _rcDx * hit.distance, _rcOy + _rcDy * hit.distance, _rcOz + _rcDz * hit.distance);
      hit.normal.set(_rcHitOut.nx, _rcHitOut.ny, _rcHitOut.nz);
      if (hit.normal.x * _rcDx + hit.normal.y * _rcDy + hit.normal.z * _rcDz > 0) hit.normal.negate();
      hit.body = _rcBody;
      hit.faceIndex = _rcHitOut.faceIndex;
      hit.surface = surfaceOf(_rcBody, _rcHitOut.faceIndex);
      hit.material = _rcBody.material;
      hit.entity = _rcBody.entity;
      hits.push(hit);
      skip.add(_rcBody);
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  function cachedSphere(radius) {
    const k = Math.round(radius * 1000);
    let s = shapeCache.get(k);
    if (!s) { s = Shapes.sphere(radius); shapeCache.set(k, s); }
    return s;
  }

  function cachedCapsule(radius, halfHeight) {
    const k = Math.round(radius * 1000) * 100003 + Math.round(halfHeight * 1000);
    let s = shapeCache.get(k);
    if (!s) { s = Shapes.capsule(radius, halfHeight); shapeCache.set(k, s); }
    return s;
  }

  function sweepShape(shape, from, to, mask, quat) {
    const q = quat || scratch.q0.identity();
    Shapes.computeAABB(shape, from, q, scratch.mn, scratch.mx);
    Shapes.computeAABB(shape, to, q, scratch.v1, scratch.v2);
    const mnx = Math.min(scratch.mn.x, scratch.v1.x), mny = Math.min(scratch.mn.y, scratch.v1.y);
    const mnz = Math.min(scratch.mn.z, scratch.v1.z);
    const mxx = Math.max(scratch.mx.x, scratch.v2.x), mxy = Math.max(scratch.mx.y, scratch.v2.y);
    const mxz = Math.max(scratch.mx.z, scratch.v2.z);

    let bestT = Infinity, bestBody = null;
    let bnx = 0, bny = 1, bnz = 0, bpx = 0, bpy = 0, bpz = 0;
    world.broadphase.queryAABB(mnx, mny, mnz, mxx, mxy, mxz, (body) => {
      if (!body || (body.group & mask) === 0) return;
      const t = Shapes.sweepConvex(shape, from, q, to, body.shape, body.position, body.quaternion, sweepOut);
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestBody = body;
        bnx = sweepOut.nx; bny = sweepOut.ny; bnz = sweepOut.nz;
        bpx = sweepOut.px; bpy = sweepOut.py; bpz = sweepOut.pz;
      }
    });
    if (!bestBody) return null;
    const hit = makeHit();
    hit.fraction = bestT;
    hit.distance = bestT * from.distanceTo(to);
    hit.point.set(bpx, bpy, bpz);
    hit.normal.set(bnx, bny, bnz).normalize();
    hit.body = bestBody;
    hit.surface = bestBody.surface;
    hit.material = bestBody.material;
    hit.entity = bestBody.entity;
    hit.faceIndex = -1;
    return hit;
  }

  function sweepSphere(from, to, radius, mask = GROUP.ALL) {
    return sweepShape(cachedSphere(radius), from, to, mask, null);
  }

  /** `height` is the total capsule height including the caps (player-controller style). */
  function sweepCapsule(from, to, radius, height, mask = GROUP.ALL, quat = null) {
    const hh = Math.max(0, height / 2 - radius);
    return sweepShape(cachedCapsule(radius, hh), from, to, mask, quat);
  }

  function overlapShape(shape, pos, quat, mask, out) {
    const res = out || overlapResults;
    res.length = 0;
    Shapes.computeAABB(shape, pos, quat, scratch.mn, scratch.mx);
    world.broadphase.queryAABB(
      scratch.mn.x, scratch.mn.y, scratch.mn.z,
      scratch.mx.x, scratch.mx.y, scratch.mx.z,
      (body) => {
        if (!body || (body.group & mask) === 0) return;
        if (Shapes.collide(shape, pos, quat, body.shape, body.position, body.quaternion, scratch.manifold)) {
          res.push(body);
        }
      }
    );
    // Stable order regardless of tree layout.
    res.sort((a, b) => a.id - b.id);
    return res;
  }

  function overlapSphere(center, radius, mask = GROUP.ALL, out = null) {
    return overlapShape(cachedSphere(radius), center, scratch.q0.identity(), mask, out || []);
  }

  function overlapBox(center, halfExtents, quat = null, mask = GROUP.ALL, out = null) {
    // Tolerate overlapBox(center, halfExtents, mask) — peers read §5 and drop the quat.
    if (typeof quat === 'number') { mask = quat; quat = null; }
    const h = halfExtents;
    const hx = h.x ?? h[0] ?? 0.5, hy = h.y ?? h[1] ?? 0.5, hz = h.z ?? h[2] ?? 0.5;
    const key = `b${Math.round(hx * 1000)}_${Math.round(hy * 1000)}_${Math.round(hz * 1000)}`;
    let s = shapeCache.get(key);
    if (!s) { s = Shapes.box(hx, hy, hz); shapeCache.set(key, s); }
    return overlapShape(s, center, quat || scratch.q0.identity(), mask, out || []);
  }

  function applyImpulse(body, impulse, worldPoint) {
    if (!body) return;
    body.applyImpulse(
      impulse.x, impulse.y, impulse.z,
      worldPoint?.x, worldPoint?.y, worldPoint?.z
    );
  }

  /** Explosion push with inverse-square-ish falloff. Deterministic, no RNG. */
  function applyRadialImpulse(center, radius, strength, mask = GROUP.ALL) {
    const list = overlapSphere(center, radius, mask, []);
    for (const b of list) {
      if (b.invMass === 0) continue;
      const dx = b.position.x - center.x;
      const dy = b.position.y - center.y;
      const dz = b.position.z - center.z;
      const d = len3(dx, dy, dz) || 1e-4;
      const falloff = Math.max(0, 1 - d / radius);
      const j = strength * falloff * falloff * b.mass;
      // Slight upward bias reads as a real blast rather than a flat shove.
      b.applyImpulse(
        (dx / d) * j, (dy / d) * j + j * 0.35, (dz / d) * j,
        center.x + dx * 0.5, center.y + dy * 0.5, center.z + dz * 0.5
      );
    }
    return list.length;
  }

  /* --- debug draw --------------------------------------------------------- */

  function createDebug() {
    const maxSegs = 24000;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(maxSegs * 6);
    const col = new Float32Array(maxSegs * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, depthTest: false, transparent: true, opacity: 0.9,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = 'physicsDebug';
    lines.frustumCulled = false;
    lines.renderOrder = 9999;
    return { geo, pos, col, mat, lines, maxSegs, n: 0, scene: null };
  }

  function dbSeg(d, x0, y0, z0, x1, y1, z1, r, g, b) {
    if (d.n >= d.maxSegs) return;
    const i = d.n * 6;
    d.pos[i] = x0; d.pos[i + 1] = y0; d.pos[i + 2] = z0;
    d.pos[i + 3] = x1; d.pos[i + 4] = y1; d.pos[i + 5] = z1;
    d.col[i] = r; d.col[i + 1] = g; d.col[i + 2] = b;
    d.col[i + 3] = r; d.col[i + 4] = g; d.col[i + 5] = b;
    d.n++;
  }

  const _dbA = new THREE.Vector3();
  const _dbB = new THREE.Vector3();

  function dbLocal(d, body, ax, ay, az, bx, by, bz, r, g, bl, off) {
    _dbA.set(ax, ay, az).applyQuaternion(body.quaternion).add(body.position);
    _dbB.set(bx, by, bz).applyQuaternion(body.quaternion).add(body.position);
    if (off) { _dbA.add(off); _dbB.add(off); }
    dbSeg(d, _dbA.x, _dbA.y, _dbA.z, _dbB.x, _dbB.y, _dbB.z, r, g, bl);
  }

  function drawShape(d, body, shape, off, r, g, b) {
    switch (shape.type) {
      case Shapes.SHAPE.SPHERE: {
        const rad = shape.radius;
        const N = 16;
        for (let axis = 0; axis < 3; axis++) {
          for (let i = 0; i < N; i++) {
            const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
            const c0 = Math.cos(a0) * rad, s0 = Math.sin(a0) * rad;
            const c1 = Math.cos(a1) * rad, s1 = Math.sin(a1) * rad;
            if (axis === 0) dbLocal(d, body, c0, s0, 0, c1, s1, 0, r, g, b, off);
            else if (axis === 1) dbLocal(d, body, c0, 0, s0, c1, 0, s1, r, g, b, off);
            else dbLocal(d, body, 0, c0, s0, 0, c1, s1, r, g, b, off);
          }
        }
        break;
      }
      case Shapes.SHAPE.CAPSULE: {
        const rad = shape.radius, hh = shape.halfHeight, N = 12;
        for (let i = 0; i < N; i++) {
          const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
          const c0 = Math.cos(a0) * rad, s0 = Math.sin(a0) * rad;
          const c1 = Math.cos(a1) * rad, s1 = Math.sin(a1) * rad;
          dbLocal(d, body, c0, hh, s0, c1, hh, s1, r, g, b, off);
          dbLocal(d, body, c0, -hh, s0, c1, -hh, s1, r, g, b, off);
        }
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          const c = Math.cos(a) * rad, s = Math.sin(a) * rad;
          dbLocal(d, body, c, -hh, s, c, hh, s, r, g, b, off);
        }
        const M = 8;
        for (let i = 0; i < M; i++) {
          const a0 = (i / M) * Math.PI * 0.5, a1 = ((i + 1) / M) * Math.PI * 0.5;
          dbLocal(d, body, Math.cos(a0) * rad, hh + Math.sin(a0) * rad, 0,
            Math.cos(a1) * rad, hh + Math.sin(a1) * rad, 0, r, g, b, off);
          dbLocal(d, body, 0, hh + Math.sin(a0) * rad, Math.cos(a0) * rad,
            0, hh + Math.sin(a1) * rad, Math.cos(a1) * rad, r, g, b, off);
          dbLocal(d, body, Math.cos(a0) * rad, -hh - Math.sin(a0) * rad, 0,
            Math.cos(a1) * rad, -hh - Math.sin(a1) * rad, 0, r, g, b, off);
          dbLocal(d, body, 0, -hh - Math.sin(a0) * rad, Math.cos(a0) * rad,
            0, -hh - Math.sin(a1) * rad, Math.cos(a1) * rad, r, g, b, off);
        }
        break;
      }
      case Shapes.SHAPE.BOX:
      case Shapes.SHAPE.CONVEX: {
        const V = shape.verts, E = shape.edges;
        for (let i = 0; i < shape.edgeCount; i++) {
          const a = E[i * 2] * 3, bIdx = E[i * 2 + 1] * 3;
          dbLocal(d, body, V[a], V[a + 1], V[a + 2], V[bIdx], V[bIdx + 1], V[bIdx + 2], r, g, b, off);
        }
        break;
      }
      case Shapes.SHAPE.COMPOUND: {
        for (const c of shape.children) {
          const o = _dbOff.copy(c.position).applyQuaternion(body.quaternion);
          if (off) o.add(off);
          // Child orientation is folded in by temporarily composing the quaternion.
          const saved = _dbQ.copy(body.quaternion);
          body.quaternion.multiply(c.quaternion);
          drawShape(d, body, c.shape, o, r, g, b);
          body.quaternion.copy(saved);
        }
        break;
      }
      default: {
        // Mesh / heightfield: outline the world AABB, drawing every triangle would
        // swamp the line budget.
        const mn = body.aabbMin, mx = body.aabbMax;
        boxWire(d, mn, mx, r * 0.6, g * 0.6, b * 0.6);
      }
    }
  }
  const _dbOff = new THREE.Vector3();
  const _dbQ = new THREE.Quaternion();

  function boxWire(d, mn, mx, r, g, b) {
    const xs = [mn.x, mx.x], ys = [mn.y, mx.y], zs = [mn.z, mx.z];
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        dbSeg(d, xs[0], ys[i], zs[j], xs[1], ys[i], zs[j], r, g, b);
        dbSeg(d, xs[i], ys[0], zs[j], xs[i], ys[1], zs[j], r, g, b);
        dbSeg(d, xs[i], ys[j], zs[0], xs[i], ys[j], zs[1], r, g, b);
      }
    }
  }

  function debugDraw(scene, enabled = true) {
    if (!enabled) {
      if (debug?.scene) { debug.scene.remove(debug.lines); debug.scene = null; }
      if (debug) debug.enabled = false;
      return debug?.lines ?? null;
    }
    if (!debug) debug = createDebug();
    debug.enabled = true;
    const target = scene || ctx.scene;
    if (target && debug.scene !== target) {
      debug.scene?.remove(debug.lines);
      target.add(debug.lines);
      debug.scene = target;
    }
    return debug.lines;
  }

  function updateDebug() {
    if (!debug?.enabled) return;
    const d = debug;
    d.n = 0;
    for (const b of world.bodies) {
      const awake = b.awake;
      drawShape(d, b, b.shape, null,
        b.isKinematic ? 0.2 : (awake ? 0.25 : 0.15),
        b.isKinematic ? 0.9 : (awake ? 0.95 : 0.35),
        b.isKinematic ? 0.9 : (awake ? 0.35 : 0.9));
    }
    // Statics near the camera only — 5000 wireframes would obliterate the budget.
    const cam = ctx.camera;
    const cx = cam?.position.x ?? 0, cy = cam?.position.y ?? 0, cz = cam?.position.z ?? 0;
    let drawn = 0;
    for (const b of world.statics) {
      if (drawn > 240) break;
      const dx = b.position.x - cx, dy = b.position.y - cy, dz = b.position.z - cz;
      if (dx * dx + dy * dy + dz * dz > 900) continue;
      drawShape(d, b, b.shape, null, 0.45, 0.45, 0.5);
      drawn++;
    }
    // Contacts: red crosses at the point, yellow line along the normal.
    for (let i = 0; i < world._activeCount; i++) {
      const c = world._active[i];
      for (let p = 0; p < c.count; p++) {
        const pt = c.points[p];
        const s = 0.035;
        dbSeg(d, pt.px - s, pt.py, pt.pz, pt.px + s, pt.py, pt.pz, 1, 0.15, 0.1);
        dbSeg(d, pt.px, pt.py - s, pt.pz, pt.px, pt.py + s, pt.pz, 1, 0.15, 0.1);
        dbSeg(d, pt.px, pt.py, pt.pz - s, pt.px, pt.py, pt.pz + s, 1, 0.15, 0.1);
        const L = 0.12 + Math.min(0.3, pt.normalImpulse * 0.02);
        dbSeg(d, pt.px, pt.py, pt.pz,
          pt.px + c.nx * L, pt.py + c.ny * L, pt.pz + c.nz * L, 1, 0.9, 0.15);
      }
    }
    d.geo.attributes.position.needsUpdate = true;
    d.geo.attributes.color.needsUpdate = true;
    d.geo.setDrawRange(0, d.n * 2);
    d.geo.computeBoundingSphere?.();
  }

  /* --- quality scaling ---------------------------------------------------- */

  function applyQuality() {
    const tier = ctx.settings?.tier || 'high';
    const iters = { low: 5, medium: 7, high: 9, ultra: 12 }[tier] ?? 8;
    const pos = { low: 2, medium: 2, high: 3, ultra: 4 }[tier] ?? 3;
    world.solver.configure({ velocityIterations: iters, positionIterations: pos });
  }

  /* --- public api --------------------------------------------------------- */

  const api = {
    ready: false,
    world,
    Body,
    GROUP,
    SURFACES,
    materials: MATERIALS,
    shapes: Shapes.shapeFactories,
    SHAPE: Shapes.SHAPE,
    RAGDOLL_BONES,
    fixedDt: FIXED_DT,
    stats: world.stats,

    addStatic,
    addStatics: (list) => (Array.isArray(list) ? list.map(addStatic) : [addStatic(list)]),
    addBody,
    removeBody: (b) => world.removeBody(b),
    body: (id) => world.bodies.find((b) => b.id === id) || world.statics.find((b) => b.id === id) || null,

    raycast,
    raycastAll,
    sweepSphere,
    sweepCapsule,
    overlapSphere,
    overlapBox,
    applyImpulse,
    applyRadialImpulse,
    material: (name) => MATERIALS[name] || MATERIALS.default,

    /** Manual step — the engine normally drives this from fixed(). */
    step: (dt = FIXED_DT) => world.step(dt),
    setGravity: (v) => world.setGravity(v),
    get gravity() { return world.gravity; },
    setBroadphase(kind) {
      // Rebuild both trees with the requested implementation.
      const all = world.statics.concat(world.bodies);
      world.broadphase.clear();
      world.broadphase = new Broadphase({ kind });
      for (const b of all) world.broadphase.addProxy(b);
    },
    configureSolver: (patch) => world.solver.configure(patch),
    solverSettings: world.solver.settings,

    constraints: {
      ballSocket: (a, b, pa, pb) => world.addJoint(new BallSocketConstraint(a, b, pa, pb)),
      hinge: (a, b, pa, pb, aa, ab, o) => world.addJoint(new HingeConstraint(a, b, pa, pb, aa, ab, o)),
      coneTwist: (a, b, pa, pb, aa, ab, o) => world.addJoint(new ConeTwistConstraint(a, b, pa, pb, aa, ab, o)),
      distance: (a, b, pa, pb, o) => world.addJoint(new DistanceConstraint(a, b, pa, pb, o)),
    },
    addConstraint: (c) => world.addJoint(c),
    removeConstraint: (c) => world.removeJoint(c),

    createRagdoll: (skeletonOrPose, opts) => {
      try {
        return buildRagdoll(api, ctx, skeletonOrPose, opts);
      } catch (err) {
        console.warn('[physics] createRagdoll failed:', err?.message || err);
        return null;
      }
    },

    debugDraw,
    /** Remove the auto-created ground once the level supplies real geometry. */
    setFallbackGround(on) {
      if (!on && fallbackGround) {
        world.removeBody(fallbackGround);
        fallbackGround = null;
      }
      return fallbackGround;
    },
    get hasGround() { return !!fallbackGround || world.statics.length > 0; },
  };

  // Published immediately as well as in init(): another system's *factory* runs before
  // our init(), and defensive `ctx.physics?.x` still wants the real object when it can.
  ctx.physics = api;

  return {
    name: 'physics',
    order: 30,

    async init() {
      ctx.physics = api;
      applyQuality();
      world.onImpact = (A, B, px, py, pz, nx, ny, nz, speed) => {
        const dyn = A.invMass > 0 ? A : B;
        const other = dyn === A ? B : A;
        ctx.bus?.emit('physics:impact', {
          body: dyn, other,
          point: { x: px, y: py, z: pz },
          normal: { x: nx, y: ny, z: nz },
          speed,
          surface: other.surface || dyn.surface,
        });
      };
      unsubs.push(ctx.bus?.on?.('quality:changed', applyQuality) || (() => {}));
      unsubs.push(ctx.bus?.on?.('explosion', (e) => {
        if (!e?.point) return;
        const r = e.radius ?? 5;
        const force = e.force ?? (e.damage ?? 100) * 0.9;
        applyRadialImpulse(e.point, r, force * 0.03, GROUP.PROP | GROUP.RAGDOLL | GROUP.AI);
      }) || (() => {}));
      unsubs.push(ctx.bus?.on?.('debug:pose', (state) => {
        if (state && state.physicsDebug !== undefined) debugDraw(ctx.scene, !!state.physicsDebug);
      }) || (() => {}));
      api.ready = true;
    },

    fixed(fdt) {
      // Safety net: if nothing has registered collision geometry by the first step,
      // drop in a ground plane so bodies (and the player) do not fall forever.
      if (world.statics.length === 0 && !fallbackGround) {
        const level = ctx.level;
        const list = level?.colliders;
        if (Array.isArray(list) && list.length) {
          addStatic(list);
        }
        if (world.statics.length === 0) {
          fallbackGround = addStatic({
            type: 'box', halfExtents: { x: 256, y: 1, z: 256 },
            pos: { x: 0, y: -1, z: 0 }, surface: 'concrete',
          });
        }
      }
      world.step(fdt);
    },

    update() {
      // Interpolated render transforms — smooth at any framerate, exact at 120 Hz.
      const alpha = ctx.time?.fixedAlpha ?? 1;
      const bodies = world.bodies;
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const mesh = b.mesh;
        if (!mesh) continue;
        mesh.quaternion.copy(b.prevQuaternion).slerp(b.quaternion, alpha);
        mesh.position.lerpVectors(b.prevPosition, b.position, alpha);
        if (b.meshOffset.lengthSq() > 1e-12) {
          scratch.v0.copy(b.meshOffset).applyQuaternion(mesh.quaternion);
          mesh.position.add(scratch.v0);
        }
      }
      updateDebug();
    },

    dispose() {
      for (const u of unsubs) { try { u(); } catch { /* best effort */ } }
      unsubs = [];
      if (debug) {
        debug.scene?.remove(debug.lines);
        debug.geo.dispose();
        debug.mat.dispose();
        debug = null;
      }
      world.broadphase.clear();
      world.bodies.length = 0;
      world.statics.length = 0;
      world.joints.length = 0;
      world._manifolds.clear();
      world._live.length = 0;
      if (ctx.physics === api) ctx.physics = null;
    },
  };
}

export { Shapes, SOLVER_DEFAULTS };
