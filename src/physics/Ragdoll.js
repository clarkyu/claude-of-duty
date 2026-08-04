/**
 * Ragdoll.js — anatomically proportioned humanoid ragdoll. Owner: physics agent.
 * Reached through `ctx.physics.createRagdoll(skeletonOrPose, opts)`.
 *
 * 16 rigid bodies (the set named in the design brief): pelvis, spine, chest, head,
 * upper/lower arms, hands, thighs, shins, feet. Masses follow Dempster's segment
 * fractions for a 78 kg adult and scale with `opts.mass`; limb lengths follow standard
 * stature fractions and scale with `opts.height`.
 *
 * Why it does not explode / flail / twitch — the three classic ragdoll failures:
 *   - Self-collision is OFF by default. Limb capsules always interpenetrate slightly at
 *     the joints; letting them push each other apart is what launches ragdolls.
 *   - Every joint carries angular friction, expressed as the maximum relative spin
 *     (rad/s) it may remove per step, so a limb bleeds energy instead of swinging
 *     forever. Because the clamp scales with the joint's effective inertia, the same
 *     number means the same thing on a 0.5 kg hand and an 8.5 kg thigh — a fixed
 *     impulse clamp does not, and that is how hands end up doing 90 rad/s.
 *     Elbows and knees are hinges with one-sided limits, so no knee bends backwards.
 *   - High angular damping plus island sleeping means a ragdoll settles in ~2 seconds
 *     and then costs nothing.
 *
 * API
 *   ragdoll.bones                      array, and .byName lookup
 *   ragdoll.applyImpulse(name, impulse, point?)
 *   ragdoll.blendFromAnimation(t)      0 = animation drives, 1 = fully physical
 *   ragdoll.setAnimationPose(pose)     {name: {position, quaternion}}
 *   ragdoll.sample()                   -> [{name, position, quaternion, jointPosition}]
 *   ragdoll.settle() / .isSettled / .sleep() / .wake() / .dispose()
 */
import * as THREE from 'three';

/** Canonical bone names, in a fixed order so `sample()` output is stable. */
export const RAGDOLL_BONES = Object.freeze([
  'pelvis', 'spine', 'chest', 'head',
  'upperArmL', 'lowerArmL', 'handL',
  'upperArmR', 'lowerArmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
]);

/** Name fragments used to map an arbitrary skeleton onto the canonical set. */
const NAME_HINTS = [
  ['pelvis', ['pelvis', 'hips', 'hip', 'root']],
  ['spine', ['spine1', 'spine_01', 'spine', 'abdomen', 'waist']],
  ['chest', ['chest', 'spine2', 'spine_02', 'spine3', 'upperchest', 'torso']],
  ['head', ['head', 'skull']],
  ['upperArmL', ['leftarm', 'upperarm_l', 'l_upperarm', 'arm_l', 'shoulder_l', 'leftupperarm']],
  ['lowerArmL', ['leftforearm', 'lowerarm_l', 'forearm_l', 'l_forearm', 'elbow_l']],
  ['handL', ['lefthand', 'hand_l', 'l_hand']],
  ['upperArmR', ['rightarm', 'upperarm_r', 'r_upperarm', 'arm_r', 'shoulder_r', 'rightupperarm']],
  ['lowerArmR', ['rightforearm', 'lowerarm_r', 'forearm_r', 'r_forearm', 'elbow_r']],
  ['handR', ['righthand', 'hand_r', 'r_hand']],
  ['thighL', ['leftupleg', 'thigh_l', 'l_thigh', 'upleg_l', 'leftthigh']],
  ['shinL', ['leftleg', 'calf_l', 'shin_l', 'l_calf', 'leftshin']],
  ['footL', ['leftfoot', 'foot_l', 'l_foot']],
  ['thighR', ['rightupleg', 'thigh_r', 'r_thigh', 'upleg_r', 'rightthigh']],
  ['shinR', ['rightleg', 'calf_r', 'shin_r', 'r_calf', 'rightshin']],
  ['footR', ['rightfoot', 'foot_r', 'r_foot']],
];

const DEG = Math.PI / 180;

/**
 * Per-bone inertia inflation. Extremities are tiny and light, so they need the most:
 * without this a hand or a foot picks up 90 rad/s from a single ground contact and the
 * ragdoll reads as a broken puppet instead of a body.
 */
const INERTIA_SCALE = {
  pelvis: 2.0, spine: 2.0, chest: 2.0, head: 3.0,
  upperArmL: 4.0, lowerArmL: 5.0, handL: 9.0,
  upperArmR: 4.0, lowerArmR: 5.0, handR: 9.0,
  thighL: 3.0, shinL: 4.0, footL: 7.0,
  thighR: 3.0, shinR: 4.0, footR: 7.0,
};
const EXTRA_ANGULAR_DAMPING = {
  handL: 2.2, handR: 2.2, footL: 1.6, footR: 1.6,
  lowerArmL: 1.1, lowerArmR: 1.1, shinL: 0.9, shinR: 0.9,
};

/**
 * Default skeleton in metres for a 1.8 m adult, feet on y = 0, facing +Z.
 * y values are joint heights; every body is derived from them so changing `height`
 * rescales the whole rig consistently.
 */
function defaultLayout(H) {
  const s = H / 1.8;
  const y = (f) => f * H;
  const hipY = y(0.530), kneeY = y(0.285), ankleY = y(0.039);
  const shoulderY = y(0.800), elbowY = y(0.630), wristY = y(0.485);
  const neckY = y(0.870);
  const hipX = 0.085 * s;
  const shoulderX = 0.175 * s;

  const cap = (r, len) => ({ kind: 'capsule', radius: r * s, halfHeight: Math.max(0.005, (len / 2 - r * s)) });
  const bx = (x, yy, z) => ({ kind: 'box', hx: x * s, hy: yy * s, hz: z * s });

  const thighLen = hipY - kneeY;
  const shinLen = kneeY - ankleY;
  const upperArmLen = shoulderY - elbowY;
  const lowerArmLen = elbowY - wristY;

  return {
    scale: s,
    joints: { hipY, kneeY, ankleY, shoulderY, elbowY, wristY, neckY, hipX, shoulderX },
    bodies: {
      pelvis: { pos: [0, hipY + 0.035 * s, 0], shape: bx(0.105, 0.075, 0.085), mass: 11.5 },
      spine: { pos: [0, hipY + 0.185 * s, 0], shape: bx(0.095, 0.085, 0.078), mass: 9.0 },
      chest: { pos: [0, (shoulderY + neckY) * 0.5 - 0.10 * s, 0], shape: bx(0.135, 0.115, 0.095), mass: 16.0 },
      head: { pos: [0, neckY + 0.115 * s, 0.005 * s], shape: cap(0.095, 0.26 * s), mass: 5.3 },

      upperArmL: { pos: [-shoulderX - 0.01 * s, (shoulderY + elbowY) / 2, 0], shape: cap(0.048, upperArmLen), mass: 2.2 },
      lowerArmL: { pos: [-shoulderX - 0.02 * s, (elbowY + wristY) / 2, 0], shape: cap(0.042, lowerArmLen), mass: 1.4 },
      handL: { pos: [-shoulderX - 0.02 * s, wristY - 0.05 * s, 0], shape: bx(0.035, 0.052, 0.022), mass: 0.55 },

      upperArmR: { pos: [shoulderX + 0.01 * s, (shoulderY + elbowY) / 2, 0], shape: cap(0.048, upperArmLen), mass: 2.2 },
      lowerArmR: { pos: [shoulderX + 0.02 * s, (elbowY + wristY) / 2, 0], shape: cap(0.042, lowerArmLen), mass: 1.4 },
      handR: { pos: [shoulderX + 0.02 * s, wristY - 0.05 * s, 0], shape: bx(0.035, 0.052, 0.022), mass: 0.55 },

      thighL: { pos: [-hipX, (hipY + kneeY) / 2, 0], shape: cap(0.078, thighLen), mass: 8.5 },
      shinL: { pos: [-hipX, (kneeY + ankleY) / 2, 0], shape: cap(0.056, shinLen), mass: 3.6 },
      footL: { pos: [-hipX, ankleY * 0.5, 0.045 * s], shape: bx(0.045, ankleY * 0.5, 0.11), mass: 1.15 },

      thighR: { pos: [hipX, (hipY + kneeY) / 2, 0], shape: cap(0.078, thighLen), mass: 8.5 },
      shinR: { pos: [hipX, (kneeY + ankleY) / 2, 0], shape: cap(0.056, shinLen), mass: 3.6 },
      footR: { pos: [hipX, ankleY * 0.5, 0.045 * s], shape: bx(0.045, ankleY * 0.5, 0.11), mass: 1.15 },
    },
  };
}

const UP = [0, 1, 0];
const DOWN = [0, -1, 0];
const RIGHT = [1, 0, 0];

/** Joint table: [parent, child, worldPivot(fn), type, params]. */
function jointTable(L) {
  const j = L.joints;
  const s = L.scale;
  return [
    ['pelvis', 'spine', [0, j.hipY + 0.11 * s, 0], 'cone',
      { axisA: UP, axisB: UP, swingSpan1: 26 * DEG, swingSpan2: 22 * DEG, twistSpan: 30 * DEG, damping: 0.32 }],
    ['spine', 'chest', [0, j.hipY + 0.26 * s, 0], 'cone',
      { axisA: UP, axisB: UP, swingSpan1: 22 * DEG, swingSpan2: 18 * DEG, twistSpan: 26 * DEG, damping: 0.32 }],
    ['chest', 'head', [0, j.neckY, 0], 'cone',
      { axisA: UP, axisB: UP, swingSpan1: 42 * DEG, swingSpan2: 34 * DEG, twistSpan: 55 * DEG, damping: 0.35 }],

    ['chest', 'upperArmL', [-j.shoulderX, j.shoulderY, 0], 'cone',
      { axisA: DOWN, axisB: DOWN, swingSpan1: 92 * DEG, swingSpan2: 74 * DEG, twistSpan: 50 * DEG, damping: 0.30 }],
    ['upperArmL', 'lowerArmL', [-j.shoulderX - 0.015 * s, j.elbowY, 0], 'hinge',
      { axisA: RIGHT, axisB: RIGHT, lowerLimit: -148 * DEG, upperLimit: 0, damping: 0.30 }],
    ['lowerArmL', 'handL', [-j.shoulderX - 0.02 * s, j.wristY, 0], 'hinge',
      { axisA: RIGHT, axisB: RIGHT, lowerLimit: -60 * DEG, upperLimit: 60 * DEG, damping: 0.25 }],

    ['chest', 'upperArmR', [j.shoulderX, j.shoulderY, 0], 'cone',
      { axisA: DOWN, axisB: DOWN, swingSpan1: 92 * DEG, swingSpan2: 74 * DEG, twistSpan: 50 * DEG, damping: 0.30 }],
    ['upperArmR', 'lowerArmR', [j.shoulderX + 0.015 * s, j.elbowY, 0], 'hinge',
      { axisA: RIGHT, axisB: RIGHT, lowerLimit: -148 * DEG, upperLimit: 0, damping: 0.30 }],
    ['lowerArmR', 'handR', [j.shoulderX + 0.02 * s, j.wristY, 0], 'hinge',
      { axisA: RIGHT, axisB: RIGHT, lowerLimit: -60 * DEG, upperLimit: 60 * DEG, damping: 0.25 }],

    ['pelvis', 'thighL', [-j.hipX, j.hipY, 0], 'cone',
      { axisA: DOWN, axisB: DOWN, swingSpan1: 72 * DEG, swingSpan2: 42 * DEG, twistSpan: 25 * DEG, damping: 0.30 }],
    ['thighL', 'shinL', [-j.hipX, j.kneeY, 0], 'hinge',
      { axisA: RIGHT, axisB: RIGHT, lowerLimit: 0, upperLimit: 142 * DEG, damping: 0.20 }],
    ['shinL', 'footL', [-j.hipX, j.ankleY, 0], 'hinge',
      { axisA: RIGHT, axisB: RIGHT, lowerLimit: -32 * DEG, upperLimit: 25 * DEG, damping: 0.18 }],

    ['pelvis', 'thighR', [j.hipX, j.hipY, 0], 'cone',
      { axisA: DOWN, axisB: DOWN, swingSpan1: 72 * DEG, swingSpan2: 42 * DEG, twistSpan: 25 * DEG, damping: 0.30 }],
    ['thighR', 'shinR', [j.hipX, j.kneeY, 0], 'hinge',
      { axisA: RIGHT, axisB: RIGHT, lowerLimit: 0, upperLimit: 142 * DEG, damping: 0.20 }],
    ['shinR', 'footR', [j.hipX, j.ankleY, 0], 'hinge',
      { axisA: RIGHT, axisB: RIGHT, lowerLimit: -32 * DEG, upperLimit: 25 * DEG, damping: 0.18 }],
  ];
}

/* ------------------------------------------------------------------ */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();

export class Ragdoll {
  constructor(physics, ctx, layout) {
    this.physics = physics;
    this.ctx = ctx;
    this.layout = layout;
    /** @type {Array<{name:string, body:any, headLocal:THREE.Vector3}>} */
    this.bones = [];
    this.byName = Object.create(null);
    this.joints = [];
    this.blend = 1;
    this.animPose = null;
    this.driveGain = 0.35;
    this.disposed = false;
    this._samples = [];
    this.group = 0;
    this.entity = null;
  }

  get position() {
    return this.byName.pelvis?.body.position ?? _v.set(0, 0, 0);
  }

  get isSettled() {
    for (const b of this.bones) if (b.body.awake) return false;
    return true;
  }

  /** @param {string} name @param {{x,y,z}} impulse @param {{x,y,z}} [point] */
  applyImpulse(name, impulse, point) {
    const bone = this.byName[name] || this.byName.chest || this.bones[0];
    if (!bone) return this;
    // A shot never lands on one bone only — bleed a little into the neighbours so the
    // whole body reacts instead of one limb snapping away.
    bone.body.applyImpulse(
      impulse.x, impulse.y, impulse.z,
      point?.x, point?.y, point?.z
    );
    for (const nb of bone.neighbours) {
      nb.body.applyImpulse(impulse.x * 0.18, impulse.y * 0.18, impulse.z * 0.18);
    }
    this.wake();
    return this;
  }

  /** Push the whole ragdoll (explosions, vehicle impacts). */
  applyRadialImpulse(center, radius, strength) {
    for (const b of this.bones) {
      const dx = b.body.position.x - center.x;
      const dy = b.body.position.y - center.y;
      const dz = b.body.position.z - center.z;
      const d = Math.hypot(dx, dy, dz) || 1e-4;
      if (d > radius) continue;
      const f = (1 - d / radius) ** 2 * strength * b.body.mass;
      b.body.applyImpulse((dx / d) * f, (dy / d) * f + f * 0.4, (dz / d) * f);
    }
    this.wake();
    return this;
  }

  /**
   * 0 = the animation pose drives the bodies exactly (kinematic),
   * 1 = pure physics. Anything between powers the joints toward the pose, which is
   * how a "hit reaction" reads: the character keeps animating but sags on impact.
   */
  blendFromAnimation(t) {
    this.blend = Math.min(1, Math.max(0, t));
    const kinematic = this.blend <= 0.001;
    for (const b of this.bones) {
      if (b.body.isKinematic !== kinematic) {
        b.body.isKinematic = kinematic;
        b.body.setMass(kinematic ? 0 : b.mass);
      }
      b.body.wake();
    }
    return this;
  }

  /** @param {Object<string,{position:{x,y,z}, quaternion:{x,y,z,w}}>} pose */
  setAnimationPose(pose) {
    this.animPose = pose || null;
    return this;
  }

  /** Called by PhysicsWorld before each fixed step. */
  preStep(dt) {
    if (this.disposed || !this.animPose || this.blend >= 1) return;
    const k = (1 - this.blend) * this.driveGain;
    const invDt = 1 / Math.max(1e-5, dt);
    for (const b of this.bones) {
      const target = this.animPose[b.name];
      if (!target) continue;
      const body = b.body;
      if (body.isKinematic) {
        if (target.position) body.position.copy(target.position);
        if (target.quaternion) body.quaternion.copy(target.quaternion);
        body.updateInertiaWorld();
        body.updateAABB();
        continue;
      }
      if (target.position) {
        const tvx = (target.position.x - body.position.x) * invDt;
        const tvy = (target.position.y - body.position.y) * invDt;
        const tvz = (target.position.z - body.position.z) * invDt;
        body.velocity.x += (tvx - body.velocity.x) * k;
        body.velocity.y += (tvy - body.velocity.y) * k;
        body.velocity.z += (tvz - body.velocity.z) * k;
      }
      if (target.quaternion) {
        _q.copy(target.quaternion).multiply(_qi.copy(body.quaternion).invert());
        if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
        const s = Math.hypot(_q.x, _q.y, _q.z);
        if (s > 1e-6) {
          const angle = 2 * Math.atan2(s, _q.w);
          const ax = (_q.x / s) * angle * invDt;
          const ay = (_q.y / s) * angle * invDt;
          const az = (_q.z / s) * angle * invDt;
          body.angularVelocity.x += (ax - body.angularVelocity.x) * k;
          body.angularVelocity.y += (ay - body.angularVelocity.y) * k;
          body.angularVelocity.z += (az - body.angularVelocity.z) * k;
        }
      }
      body.wake();
    }
  }

  /**
   * Interpolated bone transforms for rendering/skinning.
   * `jointPosition` is the bone's head (the joint), which is what a skeleton wants.
   */
  sample(alpha) {
    const a = alpha ?? this.ctx?.time?.fixedAlpha ?? 1;
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      const out = this._samples[i];
      out.position.lerpVectors(b.body.prevPosition, b.body.position, a);
      out.quaternion.copy(b.body.prevQuaternion).slerp(b.body.quaternion, a);
      out.jointPosition.copy(b.headLocal).applyQuaternion(out.quaternion).add(out.position);
      out.awake = b.body.awake;
    }
    return this._samples;
  }

  wake() {
    for (const b of this.bones) b.body.wake();
    return this;
  }

  sleep() {
    for (const b of this.bones) b.body.sleep();
    return this;
  }

  /** Run the sim forward until the ragdoll stops moving (spawn-time posing). */
  settle(maxSteps = 360) {
    const w = this.physics.world;
    for (let i = 0; i < maxSteps && !this.isSettled; i++) w.step(1 / 120);
    return this;
  }

  /** Move the whole rig without changing its pose. */
  teleport(offset) {
    for (const b of this.bones) {
      b.body.position.add(offset);
      b.body.prevPosition.copy(b.body.position);
      b.body.updateAABB();
      this.physics.world._proxyDirty(b.body);
    }
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const w = this.physics.world;
    for (const j of this.joints) w.removeJoint(j);
    for (const b of this.bones) w.removeBody(b.body);
    const idx = w._ragdolls.indexOf(this);
    if (idx >= 0) w._ragdolls.splice(idx, 1);
    this.bones.length = 0;
    this.joints.length = 0;
  }
}

/* ------------------------------------------------------------------ */

function normaliseName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Map an arbitrary skeleton/pose onto the canonical bone set. */
function readSourcePose(src) {
  if (!src) return null;
  const out = Object.create(null);
  const consider = (name, obj) => {
    const n = normaliseName(name);
    for (const [canon, hints] of NAME_HINTS) {
      if (out[canon]) continue;
      for (const h of hints) {
        if (n.includes(h.replace(/[^a-z0-9]/g, ''))) {
          out[canon] = obj;
          return;
        }
      }
    }
  };

  if (Array.isArray(src.bones)) {
    // THREE.Skeleton (or anything with a .bones array of Object3D).
    for (const bone of src.bones) {
      if (!bone) continue;
      bone.updateWorldMatrix?.(true, false);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      if (bone.matrixWorld) bone.matrixWorld.decompose(p, q, s);
      else { p.copy(bone.position || p); q.copy(bone.quaternion || q); }
      consider(bone.name, { position: p, quaternion: q });
    }
  } else if (typeof src === 'object') {
    for (const key of Object.keys(src)) {
      const v = src[key];
      if (!v || typeof v !== 'object') continue;
      const p = v.position || v.pos || (v.isVector3 ? v : null);
      if (!p) continue;
      consider(key, {
        position: new THREE.Vector3().copy(p),
        quaternion: new THREE.Quaternion().copy(v.quaternion || v.quat || _qi.identity()),
      });
    }
  }
  return Object.keys(out).length >= 4 ? out : null;
}

/**
 * @param {object} physics ctx.physics api
 * @param {object} ctx     engine context
 * @param {object} skeletonOrPose THREE.Skeleton | {boneName: {position, quaternion}} | null
 * @param {object} opts    {position, quaternion, height, mass, group, mask, entity,
 *                          selfCollision, material, blend}
 */
export function createRagdoll(physics, ctx, skeletonOrPose, opts = {}) {
  const world = physics.world;
  if (!world._ragdolls) world._ragdolls = [];

  const height = opts.height ?? 1.8;
  const totalMass = opts.mass ?? 78;
  const L = defaultLayout(height);
  const layoutMassSum = Object.values(L.bodies).reduce((a, b) => a + b.mass, 0);
  const massScale = totalMass / layoutMassSum;

  const rd = new Ragdoll(physics, ctx, L);
  rd.entity = opts.entity ?? null;

  const root = new THREE.Vector3();
  if (opts.position) root.copy(opts.position);
  const rootQ = new THREE.Quaternion();
  if (opts.quaternion) rootQ.copy(opts.quaternion);

  const source = readSourcePose(skeletonOrPose);
  /*
   * A perfectly symmetric I-pose is in *stable* equilibrium: locked knees, flat feet,
   * centre of mass exactly over the ankles. With no RNG to break the tie the rig will
   * happily stand there like a shop mannequin. Real ragdolls are handed a death-anim
   * pose that is never balanced, so the default pose gets a small deterministic lean
   * and a relaxed slump — it reads as a body going limp and guarantees a collapse.
   */
  const lean = opts.lean ?? 0.10;
  const leanQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), lean);
  const group = opts.group ?? (physics.GROUP?.RAGDOLL ?? 64);
  const mask = opts.mask ?? ((physics.GROUP?.ALL ?? 0xffff) & ~(physics.GROUP?.VIEWMODEL ?? 128));
  const material = opts.material ?? 'flesh';

  // --- bodies
  for (const name of RAGDOLL_BONES) {
    const def = L.bodies[name];
    if (!def) continue;
    const shape = def.shape.kind === 'capsule'
      ? physics.shapes.capsule(def.shape.radius, def.shape.halfHeight)
      : physics.shapes.box(def.shape.hx, def.shape.hy, def.shape.hz);

    const pos = new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2]);
    const quat = new THREE.Quaternion();
    const src = source?.[name];
    if (src) {
      pos.copy(src.position);
      quat.copy(src.quaternion);
    } else {
      pos.applyQuaternion(leanQ);
      quat.copy(leanQ);
      pos.applyQuaternion(rootQ).add(root);
      quat.premultiply(rootQ);
    }

    const body = physics.addBody({
      shape,
      mass: def.mass * massScale,
      pos,
      quat,
      material,
      group,
      mask,
      entity: opts.entity ?? null,
      inertiaScale: INERTIA_SCALE[name] ?? 2.5,
      linearDamping: 0.09,
      angularDamping: 0.55 + (EXTRA_ANGULAR_DAMPING[name] ?? 0),
      allowSleep: true,
      restitution: 0.0,
      friction: 0.9,
    });
    if (!body) continue;
    body.userData = { ragdoll: rd, bone: name };
    // Head (joint) offset from the centre of mass, in bone-local space.
    const headLocal = new THREE.Vector3(0, def.shape.kind === 'capsule'
      ? def.shape.halfHeight + def.shape.radius
      : (def.shape.hy || 0), 0);
    const rec = { name, body, headLocal, mass: def.mass * massScale, neighbours: [] };
    rd.bones.push(rec);
    rd.byName[name] = rec;
    rd._samples.push({
      name,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      jointPosition: new THREE.Vector3(),
      awake: true,
    });
  }

  if (!rd.bones.length) throw new Error('ragdoll produced no bodies');

  // --- self-collision policy
  if (!opts.selfCollision) {
    const ids = rd.bones.map((b) => b.body.id);
    for (const b of rd.bones) {
      b.body.ignore = new Set(ids);
      b.body.ignore.delete(b.body.id);
    }
  }

  // --- joints
  const pivot = new THREE.Vector3();
  const localA = new THREE.Vector3();
  const localB = new THREE.Vector3();
  for (const [pName, cName, wp, kind, params] of jointTable(L)) {
    const A = rd.byName[pName], B = rd.byName[cName];
    if (!A || !B) continue;
    pivot.set(wp[0], wp[1], wp[2]);
    if (source) {
      // Use the midpoint between the two bone origins when driven by a real skeleton.
      pivot.copy(A.body.position).add(B.body.position).multiplyScalar(0.5);
    } else {
      pivot.applyQuaternion(leanQ).applyQuaternion(rootQ).add(root);
    }
    localA.copy(pivot).sub(A.body.position).applyQuaternion(_qi.copy(A.body.quaternion).invert());
    localB.copy(pivot).sub(B.body.position).applyQuaternion(_qi.copy(B.body.quaternion).invert());
    const axisA = new THREE.Vector3(params.axisA[0], params.axisA[1], params.axisA[2]);
    const axisB = new THREE.Vector3(params.axisB[0], params.axisB[1], params.axisB[2]);

    let joint;
    if (kind === 'hinge') {
      joint = physics.constraints.hinge(A.body, B.body, localA, localB, axisA, axisB, {
        lowerLimit: params.lowerLimit,
        upperLimit: params.upperLimit,
        enableLimit: true,
        angularDamping: params.damping ?? 0.02,
      });
    } else {
      joint = physics.constraints.coneTwist(A.body, B.body, localA, localB, axisA, axisB, {
        swingSpan1: params.swingSpan1,
        swingSpan2: params.swingSpan2,
        twistSpan: params.twistSpan,
        angularDamping: params.damping ?? 0.04,
      });
    }
    if (joint) {
      joint.ragdoll = rd;
      rd.joints.push(joint);
      A.neighbours.push(B);
      B.neighbours.push(A);
    }
  }

  rd.group = group;
  if (opts.blend !== undefined) rd.blendFromAnimation(opts.blend);
  if (opts.velocity) {
    for (const b of rd.bones) b.body.velocity.copy(opts.velocity);
  }
  world._ragdolls.push(rd);
  return rd;
}

export default createRagdoll;
