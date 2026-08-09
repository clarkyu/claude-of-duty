/**
 * Bot.js — one enemy soldier: brain, gun, body. Owner: AI agent.
 *
 * ── Brain: a hierarchical state machine ─────────────────────────────────────────
 * Every tick `pickState()` re-evaluates from the top (health, ammo, contact,
 * suppression, squad order) and only switches when the new state genuinely wins, so
 * behaviour is stable instead of flickering. States:
 *
 *   idle / patrol      walk a loop of level POIs, scanning
 *   investigate        go to the last noise / last-known position and sweep it
 *   engage             stand and fight from where it is
 *   cover              move to a cover point, then peek-and-shoot from it
 *   suppress           squad role: keep the target's head down with long bursts
 *   flank              squad role: take a wide route to the target's side
 *   reposition         the current spot is bad (no LOS, too exposed) — move
 *   reload             break line of sight, then reload
 *   grenade            throw at a target that has stopped moving
 *   retreat            hurt: fall back to cover away from the threat
 *   dead               ragdoll
 *
 * ── Combat that feels fair ──────────────────────────────────────────────────────
 *   • a reaction delay before the first shot of every new contact
 *   • the aim vector *converges* on the target — it is slewed at a finite angular
 *     rate, it never snaps
 *   • a deliberate error cone that starts wide and tightens the longer the bot has
 *     tracked you continuously, re-rolled on a slow timer so it wanders rather than
 *     jitters, and widened by its own movement and by suppression
 *   • bursts with gaps, not a continuous beam
 *   • it will not fire through its own squadmates
 *   • `entity:suppressed` makes it duck, widen and fire blind
 *
 * ── Body: procedural animation ──────────────────────────────────────────────────
 * No animation clips exist, so the skeleton is driven directly: a locomotion blend
 * (idle / walk / run / crouch) with an analytic two-bone IK pass that plants each
 * foot on the real ground, an upper-body aim solution that twists spine, chest and
 * head toward the target, a recoil spring, additive hit reactions, and — on death —
 * a handoff to `ctx.physics.createRagdoll()` seeded from the exact live pose plus the
 * killing blow's impulse.
 *
 * Events emitted: `ai:fire`, `ai:callout`, `ai:state`, `entity:death`.
 * Events consumed (via AISystem): `entity:damage`, `entity:suppressed`.
 */
import * as THREE from 'three';
import { BONE_ORDER } from './CharacterBuilder.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

const GROUP = { WORLD: 1, PLAYER: 2, AI: 4, PROP: 8, PROJECTILE: 16, TRIGGER: 32, RAGDOLL: 64 };
const WORLD_MASK = GROUP.WORLD | GROUP.PROP;

/** bone -> Ballistics hitbox tag. Ids are exactly the keys of HITBOX_MULT. */
const BONE_HITBOX = {
  pelvis: 'pelvis', spine: 'stomach', chest: 'upper_torso', head: 'head',
  upperArmL: 'upper_arm', upperArmR: 'upper_arm',
  lowerArmL: 'forearm', lowerArmR: 'forearm',
  handL: 'hand', handR: 'hand',
  thighL: 'thigh', thighR: 'thigh',
  shinL: 'shin', shinR: 'shin',
  footL: 'foot', footR: 'foot',
};

/** A compact rifle profile — enough of a WeaponDef for Ballistics to work with. */
export const BOT_WEAPON = {
  id: 'ai_rifle',
  name: 'AK-pattern',
  class: 'ar',
  calibre: '7.62x39',
  rpm: 600,
  magSize: 30,
  damage: [
    { r: 0, v: 26 },
    { r: 20, v: 22 },
    { r: 45, v: 16 },
    { r: 80, v: 12 },
  ],
  headMult: 1.6,
  chestMult: 1.0,
  limbMult: 0.85,
  muzzleVelocity: 715,
  penetration: 0.7,
  tracerEvery: 4,
  spreadApplied: true,
};

let _nextId = 1;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _xAxis = new THREE.Vector3(1, 0, 0);

/* ══════════════════════════════════════════════════════════════════ two-bone IK ══ */

const _ikTarget = new THREE.Vector3();
const _ikRoot = new THREE.Vector3();
const _ikV = new THREE.Vector3();
const _ikY = new THREE.Vector3();
const _ikZ = new THREE.Vector3();
const _ikX = new THREE.Vector3();
const _ikPole = new THREE.Vector3();
const _ikInv = new THREE.Matrix4();

/**
 * Analytic two-bone IK. `rootBone`'s -Y axis runs down the limb and +Z is the joint's
 * bulge direction, which is the convention CharacterBuilder builds the rig with, so
 * knees bend backwards and elbows bend forwards without any per-limb special casing.
 */
function twoBoneIK(rootBone, midBone, targetWorld, poleWorld, lenA, lenB) {
  const parent = rootBone.parent;
  if (!parent) return false;
  _ikInv.copy(parent.matrixWorld).invert();
  _ikTarget.copy(targetWorld).applyMatrix4(_ikInv);
  _ikRoot.copy(rootBone.position);
  _ikV.subVectors(_ikTarget, _ikRoot);
  let d = _ikV.length();
  if (d < 1e-4) return false;
  const dMax = (lenA + lenB) * 0.999;
  const dMin = Math.abs(lenA - lenB) + 0.02;
  d = clamp(d, dMin, dMax);
  _ikV.normalize();

  // Knee/elbow interior angle, then how far the first bone tilts off the chord.
  const cosKnee = clamp((lenA * lenA + lenB * lenB - d * d) / (2 * lenA * lenB), -1, 1);
  const flex = Math.PI - Math.acos(cosKnee);
  const cosAlpha = clamp((lenA * lenA + d * d - lenB * lenB) / (2 * lenA * d), -1, 1);
  const alpha = Math.acos(cosAlpha);

  _ikPole.copy(poleWorld).transformDirection(_ikInv);
  _ikY.copy(_ikV).negate(); // local +Y is up the limb
  _ikZ.copy(_ikPole).addScaledVector(_ikY, -_ikPole.dot(_ikY));
  if (_ikZ.lengthSq() < 1e-6) _ikZ.set(0, 0, 1).addScaledVector(_ikY, -_ikY.z);
  if (_ikZ.lengthSq() < 1e-6) _ikZ.set(1, 0, 0);
  _ikZ.normalize();
  _ikX.crossVectors(_ikY, _ikZ).normalize();
  _m1.makeBasis(_ikX, _ikY, _ikZ);
  _q1.setFromRotationMatrix(_m1);
  _q2.setFromAxisAngle(_xAxis, -alpha);
  rootBone.quaternion.copy(_q1).multiply(_q2);
  midBone.rotation.set(flex, 0, 0);
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════ bot ══ */

export function createBot(ctx, deps, opts = {}) {
  const { nav, perception, character, squad } = deps;
  const rng = ctx.rng || Math.random;
  const L = character.layout;

  const bot = {
    id: `bot${_nextId++}`,
    kind: 'bot',
    isBot: true,
    team: opts.team || 'B',
    squadId: opts.squadId ?? 0,
    name: opts.name || 'Soldier',

    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    eyePosition: new THREE.Vector3(),
    lookDir: new THREE.Vector3(0, 0, 1),
    aimDir: new THREE.Vector3(0, 0, 1),
    yaw: 0,
    pitch: 0,
    speed: 0,
    radius: 0.36,
    height: L.H,

    alive: true,
    health: 100,
    maxHealth: 100,
    armour: 0.28,
    stance: 'stand',
    state: 'idle',
    previousState: '',
    eyeHeight: 1.62,

    weapon: { ...BOT_WEAPON },
    ammo: BOT_WEAPON.magSize,
    reserve: 210,
    grenades: opts.grenades ?? 2,
    lastFireTime: -99,
    suppression: 0,

    character,
    sensor: null,
    role: 'none',
    debugPath: null,
  };

  /* ── tuning by difficulty ──────────────────────────────────────────────── */

  const skill = {
    reaction: [0.34, 0.58],
    turnRate: 3.4,
    aimError: 0.075,      // radians, worst case
    aimTighten: 1.5,      // 1/s toward the floor
    aimFloor: 0.012,      // best-case error
    burst: [3, 7],
    burstGap: [0.35, 0.95],
    reloadTime: 2.7,
    accuracyMove: 1.9,
    grenadeChance: 0.5,
    courage: 0.55,
  };

  function setSkill(next) {
    Object.assign(skill, next);
  }

  /* ── physics proxies ───────────────────────────────────────────────────── */

  const hitBodies = [];
  function createHitboxes() {
    const phys = ctx.physics;
    if (!phys?.addBody || !phys?.shapes) return;
    for (const hb of character.hitboxes) {
      let shape = null;
      try {
        shape = hb.id === 'head'
          ? phys.shapes.sphere(hb.radius)
          : phys.shapes.capsule(hb.radius, 0.18);
      } catch {
        shape = null;
      }
      if (!shape) continue;
      const body = phys.addBody({
        shape,
        mass: 12,
        kinematic: true,
        trigger: true,
        allowSleep: false,
        pos: { x: bot.position.x, y: bot.position.y + 1, z: bot.position.z },
        group: phys.GROUP?.AI ?? GROUP.AI,
        mask: phys.GROUP?.ALL ?? 0xffff,
        material: 'flesh',
        surface: 'flesh',
        entity: bot,
      });
      if (!body) continue;
      body.userData = { bot, hitbox: hb.hitbox || null, region: hb.id };
      if (hb.hitbox) body.hitbox = hb.hitbox;
      hitBodies.push({ def: hb, body });
    }
  }

  const _hbA = new THREE.Vector3();
  const _hbB = new THREE.Vector3();
  const _hbMid = new THREE.Vector3();
  const _hbDir = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  function updateHitboxes() {
    if (!hitBodies.length) return;
    for (const h of hitBodies) {
      const a = character.bones[h.def.bones[0]];
      const b = character.bones[h.def.bones[1]];
      if (!a || !b) continue;
      a.getWorldPosition(_hbA);
      b.getWorldPosition(_hbB);
      if (h.def.id === 'head') {
        _hbMid.copy(_hbA).addScaledVector(
          _hbDir.set(0, 1, 0).applyQuaternion(a.getWorldQuaternion(_q1)), 0.115 * L.s
        );
      } else {
        _hbMid.addVectors(_hbA, _hbB).multiplyScalar(0.5);
        _hbDir.subVectors(_hbB, _hbA);
        const len = _hbDir.length();
        if (len > 1e-4) {
          _hbDir.multiplyScalar(1 / len);
          _q1.setFromUnitVectors(_up, _hbDir);
        } else {
          _q1.identity();
        }
        // The capsule half-height is authored for the rest pose; scale it to the live
        // segment so a raised arm or a bent leg is still the right length.
        if (h.body.shape && h.body.shape.halfHeight !== undefined) {
          h.body.shape.halfHeight = Math.max(0.04, len * 0.5 - h.def.radius * 0.5);
        }
      }
      h.body.setQuaternion?.(_q1);
      h.body.setPosition?.(_hbMid.x, _hbMid.y, _hbMid.z);
    }
  }

  function removeHitboxes() {
    for (const h of hitBodies) ctx.physics?.removeBody?.(h.body);
    hitBodies.length = 0;
  }

  /* ── hitbox classification for Ballistics ──────────────────────────────── */

  const boneWorld = BONE_ORDER.map(() => new THREE.Vector3());
  const boneTail = BONE_ORDER.map(() => new THREE.Vector3());
  const TAIL_OF = {
    pelvis: 'spine', spine: 'chest', chest: 'head',
    upperArmL: 'lowerArmL', lowerArmL: 'handL',
    upperArmR: 'lowerArmR', lowerArmR: 'handR',
    thighL: 'shinL', shinL: 'footL',
    thighR: 'shinR', shinR: 'footR',
  };
  // Resolved once: this runs for every bone of every bot every frame.
  const TAIL_INDEX = BONE_ORDER.map((n) => (TAIL_OF[n] ? BONE_ORDER.indexOf(TAIL_OF[n]) : -1));
  const TAIL_EXT = BONE_ORDER.map((n) => (
    n === 'head' ? [0, 0.2, 0]
      : n.startsWith('hand') ? [0, -0.1, 0]
        : n.startsWith('foot') ? [0, 0, 0.16]
          : [0, 0.16, 0]
  ));
  const boneRefs = BONE_ORDER.map((n) => character.bones[n] || null);

  function cacheBonePositions() {
    for (let i = 0; i < BONE_ORDER.length; i++) {
      const b = boneRefs[i];
      if (!b) continue;
      b.getWorldPosition(boneWorld[i]);
    }
    for (let i = 0; i < BONE_ORDER.length; i++) {
      const ti = TAIL_INDEX[i];
      if (ti >= 0) {
        boneTail[i].copy(boneWorld[ti]);
        continue;
      }
      const b = boneRefs[i];
      if (!b) continue;
      const e = TAIL_EXT[i];
      _v1.set(e[0], e[1], e[2]).applyQuaternion(b.getWorldQuaternion(_q1));
      boneTail[i].copy(boneWorld[i]).add(_v1);
    }
  }

  function segDist(p, a, b) {
    _v1.subVectors(b, a);
    _v2.subVectors(p, a);
    const l2 = _v1.lengthSq();
    const t = l2 > 1e-9 ? clamp(_v2.dot(_v1) / l2, 0, 1) : 0;
    _v3.copy(a).addScaledVector(_v1, t);
    return _v3.distanceTo(p);
  }

  /** Ballistics calls this for every untagged hit on us. */
  function hitboxAt(point, body) {
    const tag = body?.userData?.hitbox;
    if (tag) return tag;
    let best = 'torso';
    let bestD = Infinity;
    for (let i = 0; i < BONE_ORDER.length; i++) {
      const name = BONE_ORDER[i];
      const d = segDist(point, boneWorld[i], boneTail[i]);
      const bias = name === 'head' ? -0.03 : name.startsWith('hand') || name.startsWith('foot') ? 0.03 : 0;
      if (d + bias < bestD) {
        bestD = d + bias;
        best = BONE_HITBOX[name] || 'torso';
      }
    }
    return best;
  }

  /* ── locomotion ────────────────────────────────────────────────────────── */

  const move = {
    path: null,
    node: 0,
    goal: new THREE.Vector3(),
    hasGoal: false,
    repathAt: -99,
    desired: new THREE.Vector3(),
    steered: new THREE.Vector3(),
    stuckTimer: 0,
    lastPos: new THREE.Vector3(),
    arriveDist: 0.55,
    sprint: false,
  };

  const SPEED = { stand: 3.5, crouch: 1.55, sprint: 5.6 };

  function setGoal(p, opts = {}) {
    if (!p) return false;
    move.goal.set(p.x, p.y, p.z);
    move.hasGoal = true;
    move.sprint = !!opts.sprint;
    move.arriveDist = opts.arrive ?? 0.55;
    return repath(opts);
  }

  function repath(opts = {}) {
    const now = ctx.time?.elapsed ?? 0;
    move.repathAt = now;
    if (!nav?.ready) {
      move.path = { points: [move.goal.clone()], length: 0, ok: true };
      move.node = 0;
      return true;
    }
    const path = nav.findPath(bot.position, move.goal, {
      radius: bot.radius + 0.06,
      spread: opts.spread ?? 1,
      maxNodes: opts.maxNodes ?? 1800,
    });
    if (!path.ok) {
      move.path = null;
      return false;
    }
    move.path = path;
    move.node = path.points.length > 1 ? 1 : 0;
    bot.debugPath = path;
    return true;
  }

  function clearGoal() {
    move.hasGoal = false;
    move.path = null;
    bot.debugPath = null;
    move.desired.set(0, 0, 0);
  }

  function pathDone() {
    if (!move.hasGoal) return true;
    const dx = bot.position.x - move.goal.x;
    const dz = bot.position.z - move.goal.z;
    return dx * dx + dz * dz < move.arriveDist * move.arriveDist;
  }

  const _steerOut = new THREE.Vector3();

  function followPath(dt, agents) {
    move.desired.set(0, 0, 0);
    move.steered.set(0, 0, 0);
    if (!move.hasGoal) return;
    const pts = move.path?.points;
    if (!pts || !pts.length) {
      // No path: at least face the goal and try again shortly.
      const now = ctx.time?.elapsed ?? 0;
      if (now - move.repathAt > 1.1) repath();
      return;
    }
    // Advance along the polyline.
    while (move.node < pts.length) {
      const p = pts[move.node];
      const dx = p.x - bot.position.x;
      const dz = p.z - bot.position.z;
      const near = move.node === pts.length - 1 ? move.arriveDist : 0.75;
      if (dx * dx + dz * dz < near * near) move.node++;
      else break;
    }
    if (move.node >= pts.length) {
      move.desired.set(0, 0, 0);
      return;
    }
    const target = pts[move.node];
    move.desired.set(target.x - bot.position.x, 0, target.z - bot.position.z);
    if (move.desired.lengthSq() < 1e-8) return;
    move.desired.normalize();
    if (nav?.avoid) nav.avoid(bot, move.desired, agents, dt, _steerOut);
    else _steerOut.copy(move.desired);
    move.steered.copy(_steerOut);
  }

  const _step = new THREE.Vector3();

  const _zero = new THREE.Vector3();

  function integrate(dt, agents) {
    followPath(dt, agents);
    const wanted = move.hasGoal && move.path ? move.steered : _zero;
    let maxSpeed = bot.stance === 'crouch' ? SPEED.crouch : (move.sprint ? SPEED.sprint : SPEED.stand);
    if (bot.suppression > 0.4) maxSpeed *= 0.82;
    const targetVx = wanted.x * maxSpeed;
    const targetVz = wanted.z * maxSpeed;
    const accel = wanted.lengthSq() > 1e-6 ? 12 : 16;
    bot.velocity.x = damp(bot.velocity.x, targetVx, accel, dt);
    bot.velocity.z = damp(bot.velocity.z, targetVz, accel, dt);
    if (Math.abs(bot.velocity.x) < 0.02) bot.velocity.x = 0;
    if (Math.abs(bot.velocity.z) < 0.02) bot.velocity.z = 0;

    _step.set(bot.velocity.x * dt, 0, bot.velocity.z * dt);
    const nx = bot.position.x + _step.x;
    const nz = bot.position.z + _step.z;
    const canGo = !nav?.ready || nav.canWalkLine(bot.position.x, bot.position.z, nx, nz, bot.radius);
    if (canGo) {
      bot.position.x = nx;
      bot.position.z = nz;
    } else {
      // Slide: try each axis alone before giving up, which is what keeps a bot from
      // gluing itself to a corner.
      const okX = !nav?.ready || nav.canWalkLine(bot.position.x, bot.position.z, nx, bot.position.z, bot.radius);
      const okZ = !nav?.ready || nav.canWalkLine(bot.position.x, bot.position.z, bot.position.x, nz, bot.radius);
      if (okX) bot.position.x = nx;
      else bot.velocity.x *= 0.2;
      if (okZ) bot.position.z = nz;
      else bot.velocity.z *= 0.2;
    }

    const gy = nav?.groundAt ? nav.groundAt(bot.position.x, bot.position.z) : (ctx.level?.groundY?.(bot.position.x, bot.position.z) ?? 0);
    bot.position.y = damp(bot.position.y, gy, 16, dt);
    bot.speed = Math.hypot(bot.velocity.x, bot.velocity.z);

    // Stuck detection: no progress while wanting to move -> force a repath.
    if (move.hasGoal) {
      const moved = bot.position.distanceToSquared(move.lastPos);
      if (moved < 0.0004 && bot.speed < 0.4) move.stuckTimer += dt;
      else move.stuckTimer = 0;
      if (move.stuckTimer > 0.85) {
        move.stuckTimer = 0;
        if (!repath({ spread: 0 })) clearGoal();
      }
    }
    move.lastPos.copy(bot.position);

    bot.eyeHeight = bot.stance === 'crouch' ? 1.06 : 1.62;
    bot.eyePosition.set(bot.position.x, bot.position.y + bot.eyeHeight, bot.position.z);
  }

  /* ── aiming ────────────────────────────────────────────────────────────── */

  const aim = {
    target: new THREE.Vector3(),
    hasTarget: false,
    trackTime: 0,
    errorYaw: 0,
    errorPitch: 0,
    errorGoalYaw: 0,
    errorGoalPitch: 0,
    errorAt: -99,
    reactionAt: -99,
    contactAt: -99,
    committed: false,
    recoil: 0,
  };

  const _aimTo = new THREE.Vector3();
  const _aimWanted = new THREE.Vector3();

  /** Where to shoot at: the target's chest, led by its velocity over the flight time. */
  function solveAimPoint(track, out) {
    const e = track.entity;
    const src = (track.visible && e?.position) || track.lastKnownPos;
    // A synthetic contact can carry no entity at all (debug poses aim a soldier at a
    // bearing rather than at a body); its lastKnownPos is already an aim point.
    const h = e ? (e.stance === 'crouch' ? 0.78 : 1.16) : 0;
    out.set(src.x, src.y + h, src.z);
    const v = (track.visible && e?.velocity) || track.lastKnownVel;
    if (v) {
      const dist = bot.eyePosition.distanceTo(out);
      const flight = dist / Math.max(120, bot.weapon.muzzleVelocity);
      // Bots lead imperfectly — full lead reads as aimbot.
      const leadQuality = 0.35 + 0.5 * clamp01(aim.trackTime / 1.6);
      out.x += v.x * flight * leadQuality;
      out.z += v.z * flight * leadQuality;
    }
    return out;
  }

  function updateAim(dt, track) {
    const now = ctx.time?.elapsed ?? 0;
    if (track && (track.visible || track.confidence > 0.15)) {
      solveAimPoint(track, aim.target);
      aim.hasTarget = true;
      if (track.visible) aim.trackTime += dt;
      else aim.trackTime = Math.max(0, aim.trackTime - dt * 0.9);
    } else {
      aim.hasTarget = false;
      aim.trackTime = Math.max(0, aim.trackTime - dt * 1.4);
    }

    // Error cone: wide on acquisition, tightening while tracking, opened up again by
    // our own movement and by incoming fire.
    const tighten = clamp01(aim.trackTime * skill.aimTighten);
    let err = lerp(skill.aimError, skill.aimFloor, tighten);
    err *= 1 + clamp01(bot.speed / SPEED.stand) * (skill.accuracyMove - 1);
    err *= 1 + bot.suppression * 1.5;
    if (bot.stance === 'crouch') err *= 0.78;
    if (now - aim.errorAt > 0.34) {
      aim.errorAt = now;
      const a = rng() * Math.PI * 2;
      const m = Math.sqrt(rng()) * err;
      aim.errorGoalYaw = Math.cos(a) * m;
      aim.errorGoalPitch = Math.sin(a) * m;
    }
    aim.errorYaw = damp(aim.errorYaw, aim.errorGoalYaw, 7, dt);
    aim.errorPitch = damp(aim.errorPitch, aim.errorGoalPitch, 7, dt);

    // Desired direction, plus error, plus recoil climb.
    if (aim.hasTarget) _aimTo.copy(aim.target);
    else _aimTo.copy(bot.position).addScaledVector(bot.lookDir, 8).setY(bot.position.y + 1.5);
    _aimWanted.subVectors(_aimTo, bot.eyePosition);
    if (_aimWanted.lengthSq() < 1e-8) _aimWanted.set(0, 0, 1);
    _aimWanted.normalize();

    let yaw = Math.atan2(_aimWanted.x, _aimWanted.z) + aim.errorYaw;
    let pitch = Math.asin(clamp(_aimWanted.y, -1, 1)) + aim.errorPitch + aim.recoil;
    pitch = clamp(pitch, -1.15, 1.05);

    // Converge — the aim slews at a finite rate and overshoots slightly, it never
    // teleports onto the target.
    const rate = skill.turnRate * (0.5 + 0.5 * clamp01(aim.trackTime / 0.8));
    let dy = yaw - bot.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const maxStep = rate * dt;
    bot.yaw += clamp(dy, -maxStep, maxStep);
    bot.pitch = damp(bot.pitch, pitch, rate * 1.5, dt);
    aim.recoil = damp(aim.recoil, 0, 5.5, dt);

    const cp = Math.cos(bot.pitch);
    bot.aimDir.set(Math.sin(bot.yaw) * cp, Math.sin(bot.pitch), Math.cos(bot.yaw) * cp).normalize();
    bot.lookDir.set(Math.sin(bot.yaw), 0, Math.cos(bot.yaw));
    void yaw;
  }

  /** Angle between where we are pointing and where the target actually is. */
  function aimOffAngle() {
    if (!aim.hasTarget) return Math.PI;
    _v1.subVectors(aim.target, bot.eyePosition);
    if (_v1.lengthSq() < 1e-8) return 0;
    _v1.normalize();
    return Math.acos(clamp(_v1.dot(bot.aimDir), -1, 1));
  }

  /* ── firing ────────────────────────────────────────────────────────────── */

  const gun = {
    burstLeft: 0,
    nextShotAt: -99,
    nextBurstAt: -99,
    reloading: false,
    reloadDone: 0,
    lastMuzzle: new THREE.Vector3(),
  };

  const _muzzlePos = new THREE.Vector3();
  const _fireDir = new THREE.Vector3();

  function muzzleWorld(out) {
    if (character.muzzle) {
      character.muzzle.getWorldPosition(out);
      // Guard against a degenerate skeleton putting the muzzle inside the chest.
      if (out.distanceToSquared(bot.eyePosition) < 9) return out;
    }
    return out.copy(bot.eyePosition).addScaledVector(bot.aimDir, 0.42);
  }

  /** Do not shoot a squadmate in the back. */
  function friendlyInLine(agents) {
    if (!agents) return false;
    muzzleWorld(_muzzlePos);
    for (const other of agents) {
      if (other === bot || other.alive === false) continue;
      _v1.set(
        other.position.x - _muzzlePos.x,
        other.position.y + 1.0 - _muzzlePos.y,
        other.position.z - _muzzlePos.z
      );
      const d = _v1.length();
      if (d > 26 || d < 0.2) continue;
      _v1.multiplyScalar(1 / d);
      const dot = _v1.dot(bot.aimDir);
      if (dot < 0.9) continue;
      const lateral = d * Math.sqrt(Math.max(0, 1 - dot * dot));
      if (lateral < 0.75) return true;
    }
    return false;
  }

  function startReload() {
    if (gun.reloading || bot.reserve <= 0 || bot.ammo >= bot.weapon.magSize) return false;
    gun.reloading = true;
    gun.reloadDone = (ctx.time?.elapsed ?? 0) + skill.reloadTime;
    gun.burstLeft = 0;
    ctx.bus?.emit?.('ai:callout', { bot, type: 'reloading', position: bot.position });
    squad?.callout?.(bot, 'reloading');
    ctx.audio?.playAt?.('mag_out', bot.position, { volume: 0.5, spatial: true });
    return true;
  }

  function finishReload() {
    const want = bot.weapon.magSize - bot.ammo;
    const take = Math.min(want, bot.reserve);
    bot.ammo += take;
    bot.reserve -= take;
    gun.reloading = false;
    ctx.audio?.playAt?.('mag_in', bot.position, { volume: 0.5, spatial: true });
  }

  function fireOnce(blind) {
    const now = ctx.time?.elapsed ?? 0;
    if (bot.ammo <= 0) {
      startReload();
      return false;
    }
    bot.ammo--;
    bot.lastFireTime = now;
    muzzleWorld(_muzzlePos);
    _fireDir.copy(bot.aimDir);
    if (blind) {
      // Firing blind from behind cover: point up and wide on purpose.
      _fireDir.x += (rng() * 2 - 1) * 0.14;
      _fireDir.y += 0.06 + rng() * 0.1;
      _fireDir.z += (rng() * 2 - 1) * 0.14;
      _fireDir.normalize();
    }
    try {
      ctx.ballistics?.fire?.(_muzzlePos, _fireDir, bot.weapon, bot, {
        spreadApplied: true,
        owner: 'ai',
        attacker: bot,
      });
    } catch {
      /* ballistics is defensive; never let a shot break the tick */
    }
    try {
      ctx.fx?.muzzle?.(_muzzlePos, _fireDir, { weapon: bot.weapon.id, scale: 0.85, world: true });
    } catch {
      /* fx optional */
    }
    ctx.audio?.playAt?.('ar_fire', _muzzlePos, { weapon: bot.weapon.id, volume: 0.9 });
    ctx.bus?.emit?.('ai:fire', { bot, origin: _muzzlePos.clone(), dir: _fireDir.clone(), weapon: bot.weapon.id });

    // Recoil: aim climb plus an animation kick.
    aim.recoil += 0.016 + rng() * 0.008;
    anim.recoil += 1;
    gun.lastMuzzle.copy(_muzzlePos);
    return true;
  }

  /**
   * @param {boolean} allowed can we shoot this tick at all
   * @param {boolean} blind   suppressive fire from behind cover
   */
  function updateGun(dt, allowed, blind, agents) {
    const now = ctx.time?.elapsed ?? 0;
    if (gun.reloading) {
      if (now >= gun.reloadDone) finishReload();
      return;
    }
    if (bot.ammo <= 0) {
      startReload();
      return;
    }
    if (!allowed) {
      gun.burstLeft = 0;
      return;
    }
    if (!blind && friendlyInLine(agents)) return;
    const interval = 60 / Math.max(60, bot.weapon.rpm);
    if (gun.burstLeft > 0) {
      if (now >= gun.nextShotAt) {
        fireOnce(blind);
        gun.burstLeft--;
        gun.nextShotAt = now + interval;
        if (gun.burstLeft <= 0) {
          gun.nextBurstAt = now + lerp(skill.burstGap[0], skill.burstGap[1], rng());
        }
      }
      return;
    }
    if (now < gun.nextBurstAt) return;
    gun.burstLeft = Math.round(lerp(skill.burst[0], skill.burst[1], rng()));
    gun.nextShotAt = now;
    void dt;
  }

  /* ── grenades ──────────────────────────────────────────────────────────── */

  const nade = { nextAt: 0, throwing: false, releaseAt: 0, target: new THREE.Vector3() };

  function canGrenade(track) {
    const now = ctx.time?.elapsed ?? 0;
    if (bot.grenades <= 0 || now < nade.nextAt || !track) return false;
    const d = bot.position.distanceTo(track.lastKnownPos);
    if (d < 7 || d > 26) return false;
    // Only worth it against somebody who has stopped moving — or somebody dug in
    // behind cover where a direct shot is not going to land.
    return (track.staticFor ?? 0) > 2.4 || (!track.visible && track.confidence > 0.35 && d < 18);
  }

  function throwGrenade(track) {
    const now = ctx.time?.elapsed ?? 0;
    nade.nextAt = now + 14 + rng() * 8;
    bot.grenades--;
    muzzleWorld(_muzzlePos);
    _v1.copy(track.lastKnownPos).sub(bot.eyePosition);
    const dist = _v1.length();
    _v1.normalize();
    // Ballistic loft: enough arc to clear a chest-high wall at this range.
    _v1.y += clamp(dist / 40, 0.16, 0.55);
    _v1.normalize();
    try {
      ctx.ballistics?.throwGrenade?.(bot.eyePosition, _v1, {
        owner: bot,
        attacker: bot,
        speed: clamp(dist * 1.35, 9, 20),
        fuse: 3.2,
      });
    } catch {
      /* optional */
    }
    ctx.bus?.emit?.('ai:callout', { bot, type: 'grenade', position: bot.position });
    squad?.callout?.(bot, 'grenade');
    ctx.audio?.playAt?.('grenade_throw', bot.position, { volume: 0.8 });
    anim.throwT = 0.55;
  }

  /* ── damage & death ────────────────────────────────────────────────────── */

  const hitReact = { pitch: 0, roll: 0, head: 0, t: 0 };
  let lastAttacker = null;
  let lastHit = { point: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), amount: 0, hitbox: 'torso' };

  function damage(evt) {
    if (!bot.alive) return;
    const amount = Math.max(0, evt?.amount ?? 0);
    if (amount <= 0) return;
    bot.health -= amount;
    lastAttacker = evt?.attacker || lastAttacker;
    if (evt?.point) lastHit.point.copy(evt.point);
    if (evt?.dir) lastHit.dir.copy(evt.dir);
    lastHit.amount = amount;
    lastHit.hitbox = evt?.hitbox || 'torso';

    // Flinch, scaled by damage and biased by where it landed.
    const f = clamp01(amount / 45);
    hitReact.t = 0.34;
    hitReact.pitch += f * 0.32 * (evt?.hitbox === 'head' ? 1.6 : 1);
    hitReact.roll += (rng() * 2 - 1) * f * 0.28;
    hitReact.head += f * 0.5;
    bot.suppression = clamp01(bot.suppression + f * 0.7);
    aim.recoil += f * 0.05;

    // Being shot is a contact even if we never saw it coming.
    if (lastAttacker && bot.sensor) {
      const t = bot.sensor.tracks.get(lastAttacker);
      if (t) {
        t.awareness = Math.max(t.awareness, 0.92);
        if (lastAttacker.position) t.lastKnownPos.copy(lastAttacker.position);
        t.confidence = Math.max(t.confidence, 0.7);
      } else if (lastAttacker.position) {
        perception?.registerTarget?.(lastAttacker);
      }
      squad?.shareContact?.(bot, lastAttacker, lastAttacker.position, 0.85);
    }

    ctx.audio?.playAt?.('hurt', bot.position, { volume: 0.7, spatial: true });
    if (bot.health <= 0) die(evt);
  }

  let ragdoll = null;
  let deathAt = -1;

  const _pose = {};
  for (const n of BONE_ORDER) {
    _pose[n] = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  }

  function die(evt) {
    if (!bot.alive) return;
    bot.alive = false;
    bot.state = 'dead';
    deathAt = ctx.time?.elapsed ?? 0;
    clearGoal();
    nav?.release?.(bot);
    squad?.onDeath?.(bot);
    removeHitboxes();

    // Snapshot the *live* pose: every ragdoll body starts exactly where the mesh is.
    character.root.updateMatrixWorld(true);
    // The rifle goes with him — reparented to the hand so it falls with the body
    // instead of being left hanging in the air by the root-space anchor.
    character.stowWeapon?.(true);
    for (const n of BONE_ORDER) character.bodyCentre(n, _pose[n].position, _pose[n].quaternion);

    try {
      ragdoll = ctx.physics?.createRagdoll?.(_pose, {
        height: L.H,
        mass: 82,
        entity: bot,
        group: ctx.physics?.GROUP?.RAGDOLL ?? GROUP.RAGDOLL,
        material: 'flesh',
        blend: 1,
        velocity: { x: bot.velocity.x * 0.6, y: 0, z: bot.velocity.z * 0.6 },
      }) || null;
    } catch {
      ragdoll = null;
    }
    if (ragdoll) {
      // The killing blow, converted into a shove on the part that was hit.
      const boneName = Object.keys(BONE_HITBOX).find((k) => BONE_HITBOX[k] === lastHit.hitbox) || 'chest';
      const mag = clamp(lastHit.amount * 2.4, 12, 130);
      _v1.copy(lastHit.dir);
      if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, 1);
      _v1.normalize().multiplyScalar(mag);
      _v1.y += mag * 0.14;
      try {
        ragdoll.applyImpulse(boneName, _v1, lastHit.point);
      } catch {
        /* optional */
      }
      // The mesh is now driven by the bodies, so its own transform must be identity.
      character.root.position.set(0, 0, 0);
      character.root.quaternion.identity();
      character.root.updateMatrixWorld(true);
    }

    ctx.audio?.playAt?.('death', bot.position, { volume: 0.9, spatial: true });
    ctx.bus?.emit?.('entity:death', {
      target: bot,
      attacker: evt?.attacker || lastAttacker || null,
      weapon: evt?.weapon || null,
      hitbox: evt?.hitbox || lastHit.hitbox,
      position: bot.position.clone(),
    });
  }

  const _sPos = new THREE.Vector3();
  const _sQuat = new THREE.Quaternion();

  function updateRagdoll() {
    if (!ragdoll || ragdoll.disposed) return;
    const samples = ragdoll.sample();
    if (!samples) return;
    character.root.position.set(0, 0, 0);
    character.root.quaternion.identity();
    character.root.updateMatrixWorld(true);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      _sPos.copy(s.position);
      _sQuat.copy(s.quaternion);
      character.applyBody(s.name, _sPos, _sQuat);
      const b = character.bones[s.name];
      b?.updateWorldMatrix?.(false, false);
    }
    const pelvis = ragdoll.byName?.pelvis?.body?.position;
    if (pelvis) bot.position.set(pelvis.x, pelvis.y - 0.9, pelvis.z);
  }

  /* ── animation ─────────────────────────────────────────────────────────── */

  const anim = {
    phase: 0,
    stride: 0,
    blendWalk: 0,
    blendCrouch: 0,
    recoil: 0,
    recoilV: 0,
    throwT: 0,
    lean: 0,
    breathe: 0,
    footY: [0, 0],
    footAt: [-99, -99],
    pelvisDrop: 0,
    peek: 0,
    ready: 0,
  };

  const legLen = {
    thigh: Math.abs(L.hipY - L.kneeY),
    shin: Math.abs(L.kneeY - L.ankleY),
  };
  const armLen = {
    upper: Math.hypot(L.elbowX - L.shoulderX, L.shoulderY - L.elbowY),
    lower: Math.hypot(L.wristX - L.elbowX, L.elbowY - L.wristY),
  };

  const _footTarget = new THREE.Vector3();
  const _poleF = new THREE.Vector3();
  const _gripW = new THREE.Vector3();
  const _poleR = new THREE.Vector3();
  const _poleL = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);

  /** Ground height under a foot, resampled on a timer (raycasts are not free). */
  function footGround(i, x, z, now) {
    if (now - anim.footAt[i] > 0.14) {
      anim.footAt[i] = now;
      const phys = ctx.physics;
      let y = nav?.groundAt ? nav.groundAt(x, z) : bot.position.y;
      if (phys?.raycast) {
        _v1.set(x, bot.position.y + 0.75, z);
        const hit = phys.raycast(_v1, _down, 1.9, WORLD_MASK);
        if (hit) y = hit.point.y;
      }
      anim.footY[i] = y;
    }
    return anim.footY[i];
  }

  function animate(dt) {
    const now = ctx.time?.elapsed ?? 0;
    const B = character.bones;
    const root = character.root;
    root.position.copy(bot.position);
    root.rotation.set(0, bot.yaw, 0);

    const runF = clamp01(bot.speed / SPEED.stand);
    anim.blendWalk = damp(anim.blendWalk, runF, 8, dt);
    anim.blendCrouch = damp(anim.blendCrouch, bot.stance === 'crouch' ? 1 : 0, 7, dt);
    anim.breathe += dt * 1.7;

    // Stride frequency scales with speed; a stopped bot parks its feet.
    // Stopped: freeze the phase and let `blendWalk` fade the amplitudes to zero, which
    // returns the legs to neutral without ever rewinding the cycle.
    const strideHz = lerp(0.9, 2.1, runF);
    if (bot.speed > 0.12) anim.phase = (anim.phase + dt * strideHz * Math.PI * 2) % (Math.PI * 2);

    const w = anim.blendWalk;
    const cr = anim.blendCrouch;
    const p = anim.phase;
    // Ducked all the way behind cover, or up and shooting.
    const wantPeek = bot.state === 'cover' && !bb.peekOut ? 1 : 0;
    anim.peek = damp(anim.peek, wantPeek, 6, dt);

    // ── pelvis / spine base
    //
    // A fighting stance is never symmetric. The hips are bladed off the aim line,
    // the shoulders counter-rotate back square to it, the weight sits on the rear
    // foot and *both* knees carry a break. Standing the rig bolt upright with the
    // feet level and the shoulders parallel to the hips is the loudest "mannequin"
    // tell a character has, and it is what the last capture was doing.
    //
    // The knee break has to come from dropping the pelvis, not from rotating the
    // shin: the foot IK below pins each ankle to the ground it is standing on, so
    // any bend authored into the leg is solved straight back out again unless the
    // hip is genuinely closer to the floor. 32 mm buys ~30 degrees of knee.
    const bob = Math.cos(p * 2) * 0.022 * w;
    const sway = Math.sin(p) * 0.028 * w;
    const settle = (1 - w) * (1 - cr * 0.35);
    const blade = settle * 0.30;
    anim.pelvisDrop = damp(anim.pelvisDrop, cr * 0.34 + anim.peek * 0.12 + settle * 0.032, 8, dt);
    B.pelvis.position.set(
      Math.sin(p) * 0.012 * w - settle * 0.018,
      L.hipY - anim.pelvisDrop + bob,
      -settle * 0.012
    );
    B.pelvis.rotation.set(
      0.06 * w + cr * 0.20 + settle * 0.055,
      -sway * 0.5 - blade,
      Math.sin(p) * 0.05 * w + settle * 0.062
    );

    // Upper body: split the aim pitch between spine, chest and head so the whole
    // torso participates instead of the head swivelling on a rigid trunk.
    // Lean into the strafe: the lateral component of the velocity in body space.
    const lat = bot.speed > 0.25
      ? clamp((bot.velocity.x * Math.cos(bot.yaw) - bot.velocity.z * Math.sin(bot.yaw)) / SPEED.stand, -1, 1)
      : 0;
    anim.lean = damp(anim.lean, lat * 0.55, 5, dt);

    const pitch = clamp(bot.pitch, -0.9, 0.8);
    const breathe = Math.sin(anim.breathe) * 0.012 * (1 - w);
    // The `blade` terms are the counter-rotation: spine and chest give back exactly
    // what the pelvis took, so the chest ends up square to the weapon while the hips
    // sit ~17 degrees off it.
    B.spine.rotation.set(
      0.05 + pitch * 0.16 + cr * 0.14 + breathe - hitReact.pitch * 0.5,
      sway * 0.35 + blade * 0.45,
      -anim.lean * 0.25 - settle * 0.035
    );
    B.chest.rotation.set(
      0.04 + pitch * 0.26 + breathe * 0.6 - hitReact.pitch * 0.8,
      sway * 0.5 + blade * 0.55,
      -anim.lean * 0.4 + hitReact.roll * 0.5 - settle * 0.045
    );
    B.head.rotation.set(pitch * 0.34 + hitReact.head * 0.5, -sway * 0.3, hitReact.roll * 0.4);

    // ── recoil spring (drives the whole upper body, not just the gun)
    const recoilTarget = 0;
    anim.recoilV += (recoilTarget - anim.recoil) * 220 * dt;
    anim.recoilV *= Math.exp(-14 * dt);
    anim.recoil += anim.recoilV * dt;
    anim.recoil = clamp(anim.recoil, -0.4, 3.2);
    const rk = anim.recoil * 0.055;
    B.chest.rotation.x -= rk * 0.5;
    B.spine.rotation.x -= rk * 0.25;

    // ── weapon anchor: root-space, aim-pitched, so the barrel is the fire vector
    const throwing = anim.throwT > 0;
    if (throwing) anim.throwT = Math.max(0, anim.throwT - dt);
    const tf = throwing ? clamp01(anim.throwT / 0.55) : 0;
    //
    // The anchor's origin is the pistol grip. It used to sit at `chestY * 0.99` —
    // 1.20 m, the height of a man's navel — so the rifle hung in front of the belly
    // with the muzzle level: from the front that is a four-pixel dark stick and from
    // any angle it reads as "carrying a plank", not "holding a weapon". Shouldered,
    // the grip belongs just under the shoulder line so the stock lands in the
    // shoulder pocket and the optic comes up near the eye. Patrol keeps the old low
    // ready, muzzle depressed. Everything else — the hands, the elbows, the fire
    // vector — follows the anchor, so this one number moves the whole upper body.
    const anchor = character.weaponAnchor;
    if (anchor && anchor.parent === root) {
      const passive = bot.state === 'patrol' || bot.state === 'idle';
      anim.ready = damp(anim.ready, throwing ? 0.1 : (passive ? 0.28 : 1), 4.5, dt);
      const rdy = anim.ready;
      anchor.position.set(
        (lerp(0.070, 0.102, rdy) - tf * 0.16) * L.s + Math.sin(p) * 0.008 * w,
        lerp(L.chestY * 0.90, L.shoulderY - 0.048 * L.s, rdy)
          - anim.pelvisDrop * 0.85 + bob * 0.8 - tf * 0.14,
        (lerp(0.205, 0.238, rdy) - anim.recoil * 0.012 - tf * 0.05) * L.s
      );
      anchor.rotation.set(
        -bot.pitch + anim.recoil * 0.035 + (1 - rdy) * 0.52,
        (1 - rdy) * 0.10,
        anim.lean * 0.2 - tf * 0.35 - rdy * 0.07
      );
      // Cheek down to the stock once the weapon is up.
      B.head.rotation.x += rdy * 0.10;
      B.head.rotation.z += rdy * 0.06;
    }

    // ── legs: swing cycle then IK to the real ground
    const hipAmp = lerp(0.22, 0.62, runF);
    const kneeAmp = lerp(0.35, 1.02, runF);
    const crouchKnee = cr * 0.95;
    const crouchHip = cr * 0.55;

    for (let i = 0; i < 2; i++) {
      const sfx = i === 0 ? 'L' : 'R';
      const ph = p + (i === 0 ? 0 : Math.PI);
      const th = B[`thigh${sfx}`];
      const sh = B[`shin${sfx}`];
      const ft = B[`foot${sfx}`];
      // Standing: left foot leads, right trails and carries the weight. Positive X
      // rotation swings a leg *backwards*, so the lead leg is the negative one.
      // Keep the displacement small — the foot IK still has to be able to reach the
      // ground, and with the pelvis 32 mm down the leg only has ~230 mm of horizontal
      // reach left before it comes up short and the boot floats.
      const stagger = settle * (i === 0 ? -0.16 : 0.10);
      const swing = Math.sin(ph) * hipAmp * w - crouchHip + stagger;
      const flex = Math.max(0, Math.sin(ph + 0.95)) * kneeAmp * w + crouchKnee + 0.05
        + settle * (i === 0 ? 0.0 : 0.08);
      th.rotation.set(
        swing,
        (i === 0 ? 1 : -1) * settle * 0.11,
        (i === 0 ? -1 : 1) * (0.02 + cr * 0.09 + settle * 0.055)
      );
      sh.rotation.set(flex, 0, 0);
      ft.rotation.set(-swing * 0.35 - flex * 0.42 + 0.06, (i === 0 ? 1 : -1) * settle * 0.16, 0);
    }

    root.updateMatrixWorld(true);

    // ── arms: two-bone IK onto the weapon's grips. The elbow poles point down and
    // outward, which is what makes a shouldered rifle read as "held" rather than
    // "stuck to the hands".
    // Only while the weapon still hangs off the root anchor. Once `stowWeapon(true)`
    // has parented it to the right hand the grips are *downstream* of the arm, and
    // IK-ing the arm onto them is a feedback loop that walks both hands out in front
    // of the chest at the same height — the rotated T-pose the review caught.
    if (character.gripR && character.gripL && anchor && anchor.parent === root) {
      character.gripR.getWorldPosition(_gripW);
      _poleR.set(Math.cos(bot.yaw) * 0.85, -0.55, -Math.sin(bot.yaw) * 0.85);
      if (tf > 0.02) {
        // Cocked back for a throw: drive the hand up behind the head instead.
        _gripW.copy(bot.eyePosition)
          .addScaledVector(bot.lookDir, -0.22 * tf)
          .addScaledVector(_poleR, -0.18 * tf);
        _gripW.y += 0.24 * tf;
      }
      twoBoneIK(B.upperArmR, B.lowerArmR, _gripW, _poleR, armLen.upper, armLen.lower);
      B.handR.rotation.set(0.28, 0.0, -0.18);

      character.gripL.getWorldPosition(_gripW);
      _poleL.set(-Math.cos(bot.yaw) * 0.55, -0.9, Math.sin(bot.yaw) * 0.55);
      twoBoneIK(B.upperArmL, B.lowerArmL, _gripW, _poleL, armLen.upper, armLen.lower);
      B.handL.rotation.set(0.34, 0.0, 0.34);
      root.updateMatrixWorld(true);
    }

    // Foot IK: plant each foot on the surface actually under it. Skipped while the
    // bot is airborne-ish or moving fast enough that the error is invisible.
    if (w < 0.95) {
      _poleF.set(Math.sin(bot.yaw), 0, Math.cos(bot.yaw));
      for (let i = 0; i < 2; i++) {
        const sfx = i === 0 ? 'L' : 'R';
        const th = B[`thigh${sfx}`];
        const sh = B[`shin${sfx}`];
        const ft = B[`foot${sfx}`];
        ft.getWorldPosition(_footTarget);
        const g = footGround(i, _footTarget.x, _footTarget.z, now);
        const wantY = g + L.ankleY;
        const dy = wantY - _footTarget.y;
        if (Math.abs(dy) < 0.006) continue;
        _footTarget.y += clamp(dy, -0.42, 0.42) * (1 - w * 0.3);
        twoBoneIK(th, sh, _footTarget, _poleF, legLen.thigh, legLen.shin);
        ft.rotation.x = -sh.rotation.x * 0.5 + 0.05;
      }
      root.updateMatrixWorld(true);
    }

    // ── hit reaction decay
    if (hitReact.t > 0) hitReact.t = Math.max(0, hitReact.t - dt);
    hitReact.pitch = damp(hitReact.pitch, 0, 6, dt);
    hitReact.roll = damp(hitReact.roll, 0, 6, dt);
    hitReact.head = damp(hitReact.head, 0, 5, dt);
  }

  /**
   * Snap every smoothed animation value onto its steady state and re-pose.
   *
   * The capture harness warms 8 frames — 0.13 s. A 4.5/s damp gets 45 % of the way
   * there in that time, so a soldier posed into a firefight was photographed with
   * his weapon still coming up and his stance half-settled. Anything a debug pose
   * sets has to be *instant*.
   */
  function settlePose() {
    const passive = bot.state === 'patrol' || bot.state === 'idle';
    anim.blendWalk = clamp01(bot.speed / SPEED.stand);
    anim.blendCrouch = bot.stance === 'crouch' ? 1 : 0;
    anim.peek = bot.state === 'cover' && !bb.peekOut ? 1 : 0;
    anim.ready = passive ? 0.28 : 1;
    anim.lean = 0;
    const settle = (1 - anim.blendWalk) * (1 - anim.blendCrouch * 0.35);
    anim.pelvisDrop = anim.blendCrouch * 0.34 + anim.peek * 0.12 + settle * 0.032;
    animate(1 / 60);
    cacheBonePositions();
    updateHitboxes();
  }

  /* ══════════════════════════════════════════════════════ behaviour states ══ */

  const bb = {
    stateAt: 0,
    coverPoint: null,
    coverCell: -1,
    investigate: new THREE.Vector3(),
    hasInvestigate: false,
    patrolIndex: 0,
    patrolWait: 0,
    peekTimer: 0,
    peekOut: false,
    lastCoverSearch: -99,
    lastCallout: -99,
    flankSide: 1,
    blindFire: false,
    holdUntil: 0,
    /**
     * A behaviour state a debug pose has pinned on. `pickState()` collapses to
     * 'engage' for the whole of `holdUntil`, which is right for a bot the harness
     * dropped into a firefight but wrong for staging one: a combat frame in which
     * every soldier is standing bolt upright in the open is not a firefight. With
     * this set, the arbitration keeps returning the posed state instead.
     */
    forcedState: null,
  };

  function setState(next) {
    if (bot.state === next) return;
    bot.previousState = bot.state;
    bot.state = next;
    bb.stateAt = ctx.time?.elapsed ?? 0;
    bb.peekTimer = 0;
    bb.peekOut = false;
    ctx.bus?.emit?.('ai:state', { bot, from: bot.previousState, to: next });
  }

  function stateAge() {
    return (ctx.time?.elapsed ?? 0) - bb.stateAt;
  }

  /**
   * A synthetic contact used by `forceCombat()`. The screenshot harness needs bots
   * that are *definitely* mid-firefight on the capture frame; leaving that to the
   * ordinary perception pipeline means one blocked line-of-sight ray drops a soldier
   * back to patrol and the shot has a man wandering through it.
   */
  const forced = {
    entity: null,
    /** When set, this contact outranks a live one for the duration of the hold. */
    override: false,
    awareness: 3,
    visible: true,
    seen: true,
    firstSeen: 0,
    lastSeen: 0,
    lastKnownPos: new THREE.Vector3(),
    lastKnownVel: new THREE.Vector3(),
    distance: 12,
    confidence: 1,
    exposure: 1,
    threat: 3,
    trackTime: 2.5,
    staticFor: 0,
    losAt: 0,
    losOk: true,
  };

  function bestTrack() {
    const now = ctx.time?.elapsed ?? 0;
    if (now < bb.holdUntil) {
      if (!forced.override) {
        const real = bot.sensor?.best;
        if (real?.visible) return real;
        forced.entity = forced.entity || ctx.player || null;
      }
      forced.lastSeen = now;
      return forced;
    }
    return bot.sensor?.best || null;
  }

  /**
   * Pin this bot into a firefight with `point` for `seconds`. Used by debug poses.
   * `opts.entity` names the body being shot at (default: the player); pass `null`
   * with `opts.override` to aim at the bare point instead — that is how a pose puts
   * a soldier onto a *bearing* rather than onto the lens, which is the only way the
   * weapon ever presents in anything but full foreshortening.
   */
  function forceCombat(point, seconds = 30, opts = {}) {
    const now = ctx.time?.elapsed ?? 0;
    bb.holdUntil = now + seconds;
    forced.entity = opts.entity !== undefined ? opts.entity : (ctx.player || null);
    forced.override = !!opts.override;
    forced.lastKnownPos.set(point.x, point.y, point.z);
    forced.lastKnownVel.set(0, 0, 0);
    forced.lastSeen = now;
    aim.committed = true;
    aim.reactionAt = -1;
    aim.trackTime = 2.4;
    /**
     * `opts.state` pins a posture for the hold — 'cover', 'suppress' or 'engage'.
     * 'cover' additionally needs somewhere to be *in*: without a cover point
     * `runCover()` immediately hands back to 'engage', so a caller that wants a man
     * hunkered behind a barrier passes the barrier's stand-off position too.
     */
    bb.forcedState = opts.state || null;
    if (opts.coverPos) {
      bb.coverPoint = { pos: new THREE.Vector3(opts.coverPos.x, opts.coverPos.y, opts.coverPos.z), cell: -1, score: 1 };
      bb.coverCell = -1;
      bb.lastCoverSearch = now + 1e6; // never re-search: the pose owns this position
    }
    setState(opts.state || 'engage');
    if (opts.peekOut !== undefined) {
      bb.peekOut = !!opts.peekOut;
      bb.peekTimer = opts.peekTimer ?? 3.0;
    }
  }

  function threatPoint(track, out) {
    const src = track.visible && track.entity?.position ? track.entity.position : track.lastKnownPos;
    return out.set(src.x, src.y + 1.55, src.z);
  }

  const _threat = new THREE.Vector3();

  function findCover(track, opts = {}) {
    const now = ctx.time?.elapsed ?? 0;
    if (now - bb.lastCoverSearch < 0.7) return bb.coverPoint;
    bb.lastCoverSearch = now;
    if (!nav?.coverPoints || !track) return null;
    threatPoint(track, _threat);
    const anchor = opts.anchor || bot.position;
    const list = nav.coverPoints(anchor, _threat, {
      owner: bot,
      rng,
      minRadius: opts.minRadius ?? 1.2,
      maxRadius: opts.maxRadius ?? 11,
      samples: 12,
      idealRange: opts.idealRange ?? 16,
      minThreatDistance: opts.minThreatDistance ?? 5,
    });
    for (const c of list) {
      if (squad?.isCoverTaken?.(c.cell, bot)) continue;
      bb.coverPoint = c;
      bb.coverCell = c.cell;
      squad?.takeCover?.(bot, c.cell);
      nav.claim?.(c.cell, bot);
      return c;
    }
    return null;
  }

  function inCover() {
    if (!bb.coverPoint) return false;
    const dx = bot.position.x - bb.coverPoint.pos.x;
    const dz = bot.position.z - bb.coverPoint.pos.z;
    return dx * dx + dz * dz < 0.8;
  }

  /* ── the top-level arbitration ─────────────────────────────────────────── */

  function pickState() {
    const track = bestTrack();
    const now = ctx.time?.elapsed ?? 0;
    if (now < bb.holdUntil) {
      if (bb.forcedState) return bot.state === 'grenade' ? 'grenade' : bb.forcedState;
      return bot.state === 'grenade' ? 'grenade' : 'engage';
    }
    const hurt = bot.health < bot.maxHealth * 0.34;
    const engaged = !!track && track.awareness >= 1 && (track.visible || track.confidence > 0.25);

    if (gun.reloading) {
      // Reload where we are if nobody can see us, otherwise get behind something.
      if (engaged && track.visible && !inCover()) return 'reload';
    }
    if (engaged && hurt && bot.state !== 'retreat' && rng() < 0.9) return 'retreat';
    if (bot.state === 'retreat' && (hurt || stateAge() < 3.2)) return 'retreat';

    if (engaged) {
      if (canGrenade(track) && rng() < skill.grenadeChance) return 'grenade';
      const role = squad?.roleOf?.(bot) || 'assault';
      if (role === 'flank' && stateAge() < 14) return 'flank';
      // Nothing to shoot at from here for a while: the position has stopped paying,
      // go find one that can see the last known location.
      const blindFor = now - (track.lastSeen ?? -99);
      if (bot.state === 'reposition' && stateAge() < 5 && !track.visible) return 'reposition';
      if (blindFor > 3.5 && track.confidence > 0.2 && role !== 'suppress') return 'reposition';
      if (role === 'suppress') return 'suppress';
      if (bot.suppression > 0.5 || !track.visible) return 'cover';
      if (bb.coverPoint && !inCover() && stateAge() < 6) return 'cover';
      if (!bb.coverPoint && rng() < 0.02) return 'cover';
      return 'engage';
    }

    if (track && track.awareness > 0.25) return 'investigate';
    if (bot.sensor?.lastNoise && now - bot.sensor.lastNoiseTime < 7) return 'investigate';
    if (bb.hasInvestigate) return 'investigate';
    return 'patrol';
  }

  /* ── per-state bodies ──────────────────────────────────────────────────── */

  const _tmpGoal = new THREE.Vector3();

  function runPatrol(dt) {
    bot.stance = 'stand';
    if (!move.hasGoal || pathDone()) {
      bb.patrolWait -= dt;
      if (bb.patrolWait > 0) {
        // Scan: sweep the look direction while standing still.
        bot.yaw += Math.sin((ctx.time?.elapsed ?? 0) * 0.7 + bb.patrolIndex) * dt * 0.55;
        return;
      }
      const pois = ctx.level?.pointsOfInterest;
      let picked = null;
      if (pois?.length) {
        bb.patrolIndex = (bb.patrolIndex + 1 + Math.floor(rng() * 3)) % pois.length;
        const poi = pois[bb.patrolIndex];
        if (poi?.pos) {
          const r = (poi.radius ?? 4) * 0.6;
          picked = _tmpGoal.set(
            poi.pos.x + (rng() * 2 - 1) * r,
            poi.pos.y,
            poi.pos.z + (rng() * 2 - 1) * r
          );
        }
      }
      if (!picked && nav?.ready) {
        const cells = nav.sampleCells(bot.position.x, bot.position.z, 8, 26, 6, rng);
        if (cells.length) picked = nav.cellCentre(cells[Math.floor(rng() * cells.length)], _tmpGoal);
      }
      if (picked) {
        setGoal(picked, { arrive: 1.2 });
        bb.patrolWait = 1.5 + rng() * 3.5;
      } else {
        bb.patrolWait = 1.5;
      }
    }
  }

  function runInvestigate(dt) {
    bot.stance = 'stand';
    const track = bestTrack();
    let dest = null;
    if (track && track.confidence > 0.05) dest = track.lastKnownPos;
    else if (bot.sensor?.lastNoise) dest = bot.sensor.lastNoise.pos;
    else if (bb.hasInvestigate) dest = bb.investigate;
    if (dest) {
      bb.investigate.copy(dest);
      bb.hasInvestigate = true;
      if (!move.hasGoal || move.goal.distanceToSquared(dest) > 4) {
        setGoal(dest, { arrive: 1.4, sprint: bot.position.distanceTo(dest) > 12 });
      }
    }
    if (pathDone()) {
      bb.peekTimer += dt;
      bot.yaw += Math.sin((ctx.time?.elapsed ?? 0) * 1.1) * dt * 0.9;
      if (bb.peekTimer > 3.5) {
        bb.hasInvestigate = false;
        bb.peekTimer = 0;
        clearGoal();
      }
    }
  }

  function runEngage(dt, track) {
    bot.stance = bot.suppression > 0.35 ? 'crouch' : 'stand';
    if (!track) return;
    // Strafe a little so the bot is not a static target, but stay in this pocket.
    if (!move.hasGoal || pathDone()) {
      if (rng() < dt * 0.55) {
        const side = rng() < 0.5 ? 1 : -1;
        _v1.subVectors(track.lastKnownPos, bot.position).setY(0).normalize();
        _tmpGoal.set(
          bot.position.x - _v1.z * side * (1.6 + rng() * 2.4),
          bot.position.y,
          bot.position.z + _v1.x * side * (1.6 + rng() * 2.4)
        );
        setGoal(_tmpGoal, { arrive: 0.7 });
      } else {
        clearGoal();
      }
    }
    void dt;
  }

  function runCover(dt, track) {
    if (!track) return;
    const c = bb.coverPoint || findCover(track);
    if (!c) {
      setState('engage');
      return;
    }
    if (!inCover()) {
      bot.stance = 'stand';
      if (!move.hasGoal || move.goal.distanceToSquared(c.pos) > 1.5) {
        setGoal(c.pos, { arrive: 0.45, sprint: bot.position.distanceTo(c.pos) > 6 });
      }
      return;
    }
    clearGoal();
    // Peek rhythm: down behind cover, up to shoot, down again.
    bb.peekTimer -= dt;
    if (bb.peekTimer <= 0) {
      bb.peekOut = !bb.peekOut;
      bb.peekTimer = bb.peekOut ? 0.9 + rng() * 1.3 : 0.7 + rng() * 1.4;
    }
    bot.stance = bb.peekOut ? 'stand' : 'crouch';
    // If the cover has stopped working (target flanked us), find new cover.
    if (track.visible && !bb.peekOut && stateAge() > 1.5 && rng() < dt * 0.6) {
      bb.coverPoint = null;
      nav?.release?.(bot);
    }
  }

  function runSuppress(dt, track) {
    bot.stance = 'crouch';
    if (!track) return;
    if (!bb.coverPoint) findCover(track, { maxRadius: 7, idealRange: 20 });
    if (bb.coverPoint && !inCover()) {
      setGoal(bb.coverPoint.pos, { arrive: 0.5 });
    } else {
      clearGoal();
    }
    bb.blindFire = !track.visible;
    void dt;
  }

  function runFlank(dt, track) {
    bot.stance = 'stand';
    if (!track) return;
    if (!move.hasGoal || pathDone() || stateAge() > 7) {
      const side = bb.flankSide;
      _v1.subVectors(track.lastKnownPos, bot.position).setY(0);
      const d = _v1.length();
      if (d < 0.5) return;
      _v1.multiplyScalar(1 / d);
      const around = clamp(d * 0.65, 5, 14);
      _tmpGoal.set(
        track.lastKnownPos.x - _v1.x * 6 - _v1.z * side * around,
        track.lastKnownPos.y,
        track.lastKnownPos.z - _v1.z * 6 + _v1.x * side * around
      );
      if (!setGoal(_tmpGoal, { arrive: 1.1, sprint: true, spread: 1.4 })) {
        bb.flankSide = -side;
        setState('cover');
      }
      bb.stateAt = ctx.time?.elapsed ?? 0;
    }
    void dt;
  }

  function runReload(dt, track) {
    // Get out of sight, then reload. If already unseen, just do it.
    if (!gun.reloading) startReload();
    if (track?.visible) {
      if (!bb.coverPoint) findCover(track, { maxRadius: 8 });
      if (bb.coverPoint && !inCover()) {
        bot.stance = 'stand';
        setGoal(bb.coverPoint.pos, { arrive: 0.5, sprint: true });
        return;
      }
    }
    bot.stance = 'crouch';
    clearGoal();
    void dt;
  }

  function runGrenade(dt, track) {
    if (!track) {
      setState('engage');
      return;
    }
    bot.stance = 'stand';
    clearGoal();
    if (anim.throwT <= 0 && stateAge() > 0.35) {
      throwGrenade(track);
      setState('cover');
    }
    void dt;
  }

  const _look = new THREE.Vector3();

  /**
   * The current spot has gone blind. Score nearby cells by whether a standing body
   * there could actually see the target's last known position, and go to the best
   * one — the "he's not where I left him" move.
   */
  function runReposition(dt, track) {
    bot.stance = 'stand';
    if (!track) {
      setState('patrol');
      return;
    }
    if (move.hasGoal && !pathDone()) return;
    if (stateAge() > 4.5 && pathDone()) {
      setState('engage');
      return;
    }
    if (!nav?.ready) {
      setState('engage');
      return;
    }
    const cells = nav.sampleCells(bot.position.x, bot.position.z, 3.5, 13, 10, rng);
    let best = null;
    let bestScore = -Infinity;
    _look.set(track.lastKnownPos.x, track.lastKnownPos.y + 1.2, track.lastKnownPos.z);
    for (const k of cells) {
      if (squad?.isCoverTaken?.(k, bot)) continue;
      const c = nav.cellCentre(k, new THREE.Vector3());
      _v1.set(c.x, c.y + 1.5, c.z);
      const sees = !nav.losBlocked(_v1, _look);
      const d = Math.hypot(c.x - bot.position.x, c.z - bot.position.z);
      const range = Math.hypot(c.x - _look.x, c.z - _look.z);
      const score = (sees ? 3.0 : 0) - d * 0.06 - Math.abs(range - 14) * 0.04;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) setGoal(best, { arrive: 0.8, sprint: true, spread: 1.2 });
    else setState('engage');
    void dt;
  }

  function runRetreat(dt, track) {
    bot.stance = 'stand';
    if (!track) {
      setState('patrol');
      return;
    }
    if (!move.hasGoal || pathDone()) {
      // Fall back: away from the threat, and behind something.
      _v1.subVectors(bot.position, track.lastKnownPos).setY(0);
      if (_v1.lengthSq() < 1e-6) _v1.set(1, 0, 0);
      _v1.normalize();
      _tmpGoal.copy(bot.position).addScaledVector(_v1, 9 + rng() * 5);
      const c = findCover(track, { anchor: _tmpGoal, maxRadius: 9, idealRange: 26, minThreatDistance: 12 });
      setGoal(c ? c.pos : _tmpGoal, { arrive: 0.9, sprint: true });
      if (stateAge() < 0.4) {
        ctx.bus?.emit?.('ai:callout', { bot, type: 'fallback', position: bot.position });
        squad?.callout?.(bot, 'fallback');
      }
    }
    void dt;
  }

  /* ── tick ──────────────────────────────────────────────────────────────── */

  function think(dt, agents) {
    const track = bestTrack();
    const next = pickState();
    if (next !== bot.state) {
      if (next === 'engage' || next === 'cover' || next === 'suppress') {
        const now = ctx.time?.elapsed ?? 0;
        if (now - bb.lastCallout > 6 && bot.previousState !== 'engage') {
          bb.lastCallout = now;
          ctx.bus?.emit?.('ai:callout', { bot, type: 'contact', position: bot.position, target: track?.entity });
          squad?.callout?.(bot, 'contact');
        }
      }
      setState(next);
      if (next !== 'cover' && next !== 'suppress' && next !== 'reload') {
        if (bb.coverPoint) {
          nav?.release?.(bot);
          squad?.dropCover?.(bot);
          bb.coverPoint = null;
        }
      }
    }

    switch (bot.state) {
      case 'patrol': runPatrol(dt); break;
      case 'investigate': runInvestigate(dt); break;
      case 'engage': runEngage(dt, track); break;
      case 'cover': runCover(dt, track); break;
      case 'suppress': runSuppress(dt, track); break;
      case 'flank': runFlank(dt, track); break;
      case 'reposition': runReposition(dt, track); break;
      case 'reload': runReload(dt, track); break;
      case 'grenade': runGrenade(dt, track); break;
      case 'retreat': runRetreat(dt, track); break;
      default: runPatrol(dt); break;
    }

    // Reaction gate: a brand-new contact cannot be shot at instantly.
    const now = ctx.time?.elapsed ?? 0;
    if (track && track.awareness >= 1) {
      if (!aim.committed) {
        aim.committed = true;
        aim.reactionAt = now + lerp(skill.reaction[0], skill.reaction[1], rng());
        aim.contactAt = now;
      }
    } else if (now - (track?.lastSeen ?? -99) > 2.5) {
      aim.committed = false;
    }

    updateAim(dt, track);

    const holding = now < bb.holdUntil;
    const canSeeTarget = !!track && track.visible && track.awareness >= 1;
    const reacted = (aim.committed && now >= aim.reactionAt) || holding;
    const onTarget = aimOffAngle() < 0.085;
    const blind = bot.state === 'suppress' ? bb.blindFire : (bot.state === 'cover' && !bb.peekOut && bot.suppression > 0.5);
    const wantFire =
      reacted &&
      !gun.reloading &&
      ((canSeeTarget && (onTarget || holding) && (bot.state !== 'cover' || bb.peekOut)) ||
        (blind && !!track && track.confidence > 0.2) ||
        (bot.state === 'suppress' && !!track && track.confidence > 0.3));
    updateGun(dt, wantFire, blind && !canSeeTarget, agents);

    bot.suppression = Math.max(0, bot.suppression - dt * 0.55);
  }

  /* ── public tick ───────────────────────────────────────────────────────── */

  function update(dt, agents) {
    if (!bot.alive) {
      updateRagdoll();
      cacheBonePositions();
      return;
    }
    think(dt, agents);
    integrate(dt, agents);
    animate(dt);
    cacheBonePositions();
    updateHitboxes();
  }

  /* ── spawn / teardown ──────────────────────────────────────────────────── */

  function spawn(pos, yaw) {
    bot.position.set(pos.x, pos.y, pos.z);
    bot.velocity.set(0, 0, 0);
    bot.yaw = yaw ?? 0;
    bot.pitch = 0;
    bot.alive = true;
    bot.health = bot.maxHealth;
    bot.ammo = bot.weapon.magSize;
    bot.state = 'patrol';
    bot.suppression = 0;
    deathAt = -1;
    if (ragdoll && !ragdoll.disposed) {
      try {
        ragdoll.dispose();
      } catch {
        /* best effort */
      }
    }
    ragdoll = null;
    for (const n of BONE_ORDER) {
      const b = character.bones[n];
      if (b) b.rotation.set(0, 0, 0);
    }
    character.stowWeapon?.(false);
    aim.committed = false;
    aim.trackTime = 0;
    gun.reloading = false;
    gun.burstLeft = 0;
    move.lastPos.copy(bot.position);
    bot.eyePosition.set(pos.x, pos.y + bot.eyeHeight, pos.z);
    bot.lookDir.set(Math.sin(bot.yaw), 0, Math.cos(bot.yaw));
    bot.aimDir.copy(bot.lookDir);
    character.root.position.copy(bot.position);
    character.root.rotation.set(0, bot.yaw, 0);
    character.setVisible(true);
    if (!hitBodies.length) createHitboxes();
    animate(1 / 60);
    cacheBonePositions();
    updateHitboxes();
  }

  function dispose() {
    removeHitboxes();
    nav?.release?.(bot);
    try {
      ragdoll?.dispose?.();
    } catch {
      /* best effort */
    }
    ragdoll = null;
    character.dispose();
  }

  Object.assign(bot, {
    hitboxAt,
    damage,
    die,
    update,
    spawn,
    dispose,
    setSkill,
    setGoal,
    clearGoal,
    setState,
    forceCombat,
    settlePose,
    get deathTime() {
      return deathAt;
    },
    get ragdoll() {
      return ragdoll;
    },
    get settled() {
      return !ragdoll || ragdoll.isSettled;
    },
    get reloading() {
      return gun.reloading;
    },
    get coverPoint() {
      return bb.coverPoint;
    },
    onSuppressed(amount) {
      bot.suppression = clamp01(bot.suppression + (amount ?? 0.3));
      if (bot.suppression > 0.5 && bot.state === 'engage') setState('cover');
    },
    _internals: { aim, gun, move, bb, anim, skill },
  });

  return bot;
}

export default createBot;
