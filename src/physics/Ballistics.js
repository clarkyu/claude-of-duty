/**
 * Ballistics.js — projectile simulation, wall-bangs, ricochets, grenades, suppression.
 * Owner: ballistics agent.  Publishes `ctx.ballistics`.
 *
 * Rounds are *simulated*, not hitscanned. Every shot spawns a pooled projectile with a
 * real muzzle velocity, gravity and quadratic air drag from a ballistic coefficient,
 * integrated on the engine's fixed 120 Hz step. Each step is swept with a raycast from
 * the previous position to the new one, so an 880 m/s round covering 7.3 m per step can
 * never tunnel through a 10 cm wall. Fast rounds sub-step further so the arc stays
 * smooth at long range.
 *
 * ── Public API (ctx.ballistics) ─────────────────────────────────────────────────
 *   fire(origin, dir, weaponDef, shooter?, opts?)   -> projectile | projectile[]
 *   throwGrenade(origin, dir, opts?)                -> grenade
 *   cook(shooter)  / cookTime(shooter)              hold-the-spoon timer
 *   explode(point, opts?)                           manual detonation
 *   aim(origin, dir, weaponDef, shooter?, state?, out?) -> THREE.Vector3
 *   coneFor(weaponDef, state)                       current spread half-angle, radians
 *   bloomOf(shooter) / resetAim(shooter)
 *   damageFor(weaponDef, metres, hitbox, armour)    -> {amount, mult, absorbed}
 *   classify(hit, entity)                           -> hitbox id
 *   penetration                                     the Penetration solver
 *   trajectory(origin, dir, weaponDef, out, n)      sampled arc, for debug/AI lead
 *   live / stats / HITBOX_MULT / setEnabled(bool)
 *
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   bullet:impact     {point, normal, surface, material, energy, entity, ...}
 *   bullet:penetrate  {entryPoint, exitPoint, surface, material, thickness, ...}
 *   bullet:ricochet   {point, normal, surface, dirIn, dirOut, energy}
 *   bullet:whiz       {point, distance, entity, speed}     — near-miss crack
 *   entity:damage     {target, amount, hitbox, attacker, point, dir, ...}   §3
 *   entity:suppressed {target, amount, attacker, point, distance, source}
 *   player:suppressed {amount}                              — CameraRig consumes this
 *   explosion         {point, radius, damage, source, owner}                §3
 *   grenade:throw / grenade:detonate  {point, type, owner}
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   debug:pose  {tracers, grenade, ballistics}   — harness-driven demo shots
 *   quality:changed                              — trims the projectile budget
 *
 * ── Contracts this module relies on (all optional-chained) ──────────────────────
 *   ctx.physics.raycast/applyImpulse/addBody/GROUP          (exists)
 *   ctx.materials.surfaceOf(x)                              (exists)
 *   ctx.fx.tracer(from, to, opts) / .impact(hit) / .explosion(point, opts)
 *        — FXSystem is still a stub, so a minimal pooled tracer renderer here is used
 *          until `ctx.fx.tracer` shows up; it hands over automatically.
 *   ctx.ai.bots[]  with `.position` and optionally `.alive`, `.armour`,
 *        `.hitboxAt(point, body)` — used for damage, suppression and explosion LOS.
 *
 * Nothing here calls Math.random(): every stochastic choice routes through ctx.rng.
 */
import * as THREE from 'three';
import createPenetration from './Penetration.js';

const DEG = Math.PI / 180;
const FIXED_DT = 1 / 120;

/* Collision groups (ARCHITECTURE §5). Preferred from ctx.physics.GROUP at runtime. */
const G = { WORLD: 1, PLAYER: 2, AI: 4, PROP: 8, PROJECTILE: 16, TRIGGER: 32, RAGDOLL: 64, VIEWMODEL: 128 };
/** What a bullet may hit: geometry, props, people, ragdolls. Not triggers/viewmodels. */
const BULLET_MASK = G.WORLD | G.PLAYER | G.AI | G.PROP | G.RAGDOLL;
/** What blocks line of sight for an explosion. */
const LOS_MASK = G.WORLD | G.PROP;

/**
 * Projectile mass (kg) and G1 ballistic coefficient per calibre. Drag retardation is
 * a = k·v², k = DRAG_K / BC — fitted so 5.56 loses ~30 % of its speed by 300 m, which
 * is what the real trajectory tables say.
 */
const DRAG_K = 3.7e-4;
const CALIBRE = {
  '5.56x45': { mass: 0.004, bc: 0.3 },
  '5.45x39': { mass: 0.0037, bc: 0.29 },
  '7.62x39': { mass: 0.0079, bc: 0.27 },
  '7.62x51': { mass: 0.0095, bc: 0.4 },
  '.300blk': { mass: 0.0125, bc: 0.35 },
  '.338lm': { mass: 0.0165, bc: 0.62 },
  '.50bmg': { mass: 0.042, bc: 0.68 },
  '9x19': { mass: 0.008, bc: 0.16 },
  '.45acp': { mass: 0.0148, bc: 0.19 },
  '12ga': { mass: 0.0024, bc: 0.09 },
};
const CLASS_CALIBRE = {
  ar: '5.56x45', smg: '9x19', dmr: '7.62x51', sniper: '.338lm',
  lmg: '7.62x51', shotgun: '12ga', pistol: '9x19', marksman: '7.62x51',
};

/**
 * Hitbox damage multipliers. A weapon def's headMult/chestMult/limbMult rescale their
 * whole group, so the authored per-gun numbers still drive the feel while the anatomy
 * stays consistent between weapons.
 */
export const HITBOX_MULT = Object.freeze({
  head: 1.8, neck: 1.5,
  upper_torso: 1.1, chest: 1.1, torso: 1.0, stomach: 1.0, pelvis: 1.0,
  arm: 0.85, upper_arm: 0.85, forearm: 0.85, leg: 0.85, thigh: 0.85, shin: 0.85,
  hand: 0.7, foot: 0.7,
});
const HITBOX_GROUP = {
  head: 'head', neck: 'head',
  upper_torso: 'torso', chest: 'torso', torso: 'torso', stomach: 'torso', pelvis: 'torso',
  arm: 'limb', upper_arm: 'limb', forearm: 'limb', leg: 'limb', thigh: 'limb', shin: 'limb',
  hand: 'limb', foot: 'limb',
};
/** Ragdoll bone -> hitbox. Ragdoll.js tags every bone body with userData.bone. */
const BONE_HITBOX = {
  pelvis: 'pelvis', spine: 'stomach', chest: 'upper_torso', head: 'head',
  upperArmL: 'upper_arm', upperArmR: 'upper_arm',
  lowerArmL: 'forearm', lowerArmR: 'forearm',
  handL: 'hand', handR: 'hand',
  thighL: 'thigh', thighR: 'thigh',
  shinL: 'shin', shinR: 'shin',
  footL: 'foot', footR: 'foot',
};
/** Armour coverage per hitbox — a plate carrier does nothing for a hand. */
const ARMOUR_COVERAGE = {
  head: 0.45, neck: 0.2,
  upper_torso: 1.0, chest: 1.0, torso: 1.0, stomach: 0.85, pelvis: 0.6,
  arm: 0.15, upper_arm: 0.15, forearm: 0.05, leg: 0.1, thigh: 0.1, shin: 0.05,
  hand: 0, foot: 0,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d) => (Number.isFinite(v) ? v : d);

/* ========================================================================== */

export default function createBallistics(ctx) {
  const pen = createPenetration(ctx);

  let enabled = true;
  let disposed = false;
  let warned = new Set();
  const warnOnce = (tag, err) => {
    if (warned.has(tag)) return;
    warned.add(tag);
    console.warn(`[ballistics] ${tag}:`, err?.message || err);
  };

  /* ── pools ─────────────────────────────────────────────────────────────── */

  let MAX_PROJECTILES = 192;
  const pool = [];
  const live = [];

  function makeProjectile() {
    return {
      id: 0, active: false,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      sx: 0, sy: 0, sz: 0, // where this fixed step started (tracer + suppression span)
      ox: 0, oy: 0, oz: 0, // muzzle
      mass: 0.004, dragK: 0.00123,
      dist: 0, life: 0, maxLife: 4, maxRange: 700,
      pens: 0, ricochets: 0, impacts: 0,
      def: null, weaponId: '', owner: null, attacker: null,
      penPower: 1, damageFn: null, damageScale: 1,
      mask: BULLET_MASK, ignore: null,
      tracer: false, tracerLive: false,
      hitEnt: [null, null, null, null], hitEntN: 0,
      spec: { penetration: 1, mask: BULLET_MASK, noRicochet: false },
    };
  }
  for (let i = 0; i < 48; i++) pool.push(makeProjectile());

  let _pid = 1;
  function acquire() {
    let p = pool.pop();
    if (!p) {
      if (live.length >= MAX_PROJECTILES) {
        // Budget exhausted: retire the oldest round rather than dropping the new shot.
        release(live[0], 0);
        p = pool.pop() || makeProjectile();
      } else {
        p = makeProjectile();
      }
    }
    p.id = _pid++;
    p.active = true;
    live.push(p);
    return p;
  }

  function release(p, index) {
    p.active = false;
    p.def = null;
    p.owner = null;
    p.attacker = null;
    p.damageFn = null;
    p.ignore = null;
    p.hitEntN = 0;
    p.hitEnt[0] = p.hitEnt[1] = p.hitEnt[2] = p.hitEnt[3] = null;
    const i = index !== undefined && live[index] === p ? index : live.indexOf(p);
    if (i >= 0) {
      live[i] = live[live.length - 1];
      live.pop();
    }
    if (pool.length < 256) pool.push(p);
  }

  /* ── scratch (nothing in the hot path allocates) ────────────────────────── */

  const _o = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _imp = new THREE.Vector3();
  const _axis = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _camFwd = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _grav = new THREE.Vector3(0, -9.81, 0);
  const _entities = [];
  const _los = new THREE.Vector3();
  const _hit = {
    point: new THREE.Vector3(), normal: new THREE.Vector3(),
    distance: 0, fraction: 0, body: null, surface: 'concrete',
    material: null, faceIndex: -1, entity: null,
  };
  const _losHit = {
    point: new THREE.Vector3(), normal: new THREE.Vector3(),
    distance: 0, fraction: 0, body: null, surface: 'concrete',
    material: null, faceIndex: -1, entity: null,
  };

  const stats = {
    shots: 0, projectiles: 0, impacts: 0, penetrations: 0, ricochets: 0,
    damageEvents: 0, grenades: 0, suppressions: 0, tracers: 0,
  };

  const rand = () => {
    const r = ctx.rng;
    return typeof r === 'function' ? r() : 0.5;
  };

  const groups = () => ctx.physics?.GROUP || G;

  /* ====================================================================== */
  /*                        aim: spread, bloom, recoil                       */
  /* ====================================================================== */

  /**
   * Per-shooter aim state. Bloom grows per shot and recovers; the authored recoil
   * pattern accumulates into an aim offset that decays back to zero.
   */
  const aimStates = new Map();
  function aimStateFor(key) {
    let st = aimStates.get(key);
    if (!st) {
      st = {
        bloom: 0, shot: 0, idle: 0, yaw: 0, pitch: 0, lastFire: -99,
        recover: 5.5 * DEG, hold: 0.13, settle: 7,
      };
      aimStates.set(key, st);
    }
    return st;
  }
  function ownerTagOf(def, opts) {
    return opts?.owner ?? def?.owner ?? null;
  }
  /**
   * WeaponSystem hands the shot over with `owner:'player'` folded into the def object
   * and no explicit shooter, so both routes have to count as the local player.
   */
  function isLocalPlayer(shooter, def, opts) {
    if (shooter && shooter === ctx.player) return true;
    if (shooter) return false;
    return ownerTagOf(def, opts) === 'player';
  }
  function aimKey(shooter, def, opts) {
    return shooter || ownerTagOf(def, opts) || 'default';
  }

  /** Weapon-def spread block -> current cone half-angle in radians. */
  function coneFor(def, s = {}) {
    const sp = def?.spread;
    const ads = clamp01(num(s.ads, 0));
    const bloom = Math.max(0, num(s.bloom, 0));
    if (!sp) {
      // No authored spread: a sane default that still respects ADS.
      return (ads > 0.5 ? 0.12 * DEG : 2.2 * DEG) + bloom;
    }
    const moving = clamp01(num(s.moving, 0));
    const base = sp.hipBase + (sp.adsBase - sp.hipBase) * ads;
    const max = sp.hipMax + (sp.adsMax - sp.hipMax) * ads;
    let cone = Math.min(max, base + bloom);
    cone *= 1 + ((sp.moveMul ?? 1) - 1) * moving * (1 - 0.55 * ads);
    if (s.airborne) cone *= sp.jumpMul ?? 2.5;
    if (s.crouched) cone *= sp.crouchMul ?? 0.85;
    /*
     * First-shot accuracy. Fully aimed in, planted, no bloom left over: the round goes
     * exactly where the reticle points. Everything else in the game leans on this being
     * true — a marksman rifle that scatters its first shot feels broken.
     */
    if (ads > 0.985 && moving < 0.02 && !s.airborne && bloom <= 1e-6) cone = 0;
    return Math.max(0, cone);
  }

  /** Read the shooter's movement state so the cone reacts to it. */
  function shooterState(shooter, def, opts, st) {
    const isPlayer = isLocalPlayer(shooter, def, opts);
    const src = isPlayer ? ctx.player : shooter;
    const ads = opts?.ads !== undefined
      ? (typeof opts.ads === 'boolean' ? (opts.ads ? 1 : 0) : clamp01(opts.ads))
      : clamp01(num(src?.adsRaw ?? src?.ads, isPlayer ? clamp01(num(ctx.weapons?.ads, 0)) : 0));
    const speed = num(src?.speed, 0);
    return {
      ads,
      bloom: st.bloom,
      moving: clamp01(opts?.moving !== undefined ? opts.moving : speed / 4.5),
      airborne: opts?.airborne !== undefined ? !!opts.airborne : src?.isGrounded === false,
      crouched: opts?.crouched !== undefined
        ? !!opts.crouched
        : /crouch|prone|slide/.test(String(src?.stance ?? '')),
    };
  }

  /** Authored recoil sample for shot `i`, in radians (mirrors WeaponDefs.recoilStep). */
  function recoilSample(def, i, out) {
    const r = def?.recoil;
    out.x = 0;
    out.y = 0;
    if (!r) return out;
    const unit = num(r.unit, 0.003);
    const pat = r.pattern;
    let h;
    let v;
    if (pat && i < pat.length) {
      h = pat[i][0];
      v = pat[i][1];
    } else {
      const tail = r.tail || { h: 0.8, v: 0.6, jitter: 0.4 };
      const k = i - (pat?.length ?? 0);
      h = tail.h * (k % 2 === 0 ? 1 : -1) * (0.7 + 0.3 * Math.sin(k * 0.9));
      v = tail.v;
    }
    const jitter = num(r.tail?.jitter, 0.4);
    h += (rand() * 2 - 1) * jitter * 0.5;
    v *= 1 + (rand() * 2 - 1) * jitter * 0.22;
    out.x = h * unit;
    out.y = v * unit;
    return out;
  }
  const _recoil = { x: 0, y: 0 };

  /** Offset `dir` by yaw/pitch in the plane perpendicular to it. */
  function offsetDir(dir, yaw, pitch) {
    if (!yaw && !pitch) return dir;
    _up.set(0, 1, 0);
    _side.crossVectors(dir, _up);
    if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0);
    _side.normalize();
    _up.crossVectors(_side, dir).normalize();
    dir.addScaledVector(_side, Math.tan(yaw));
    dir.addScaledVector(_up, Math.tan(pitch));
    return dir.normalize();
  }

  /**
   * Full aim solution: recoil offset, then a cone. Returns `out` (or a new vector).
   * Weapons that already applied their own cone pass `opts.spreadApplied`.
   */
  function aim(origin, dir, def, shooter, opts, out) {
    const o = out || new THREE.Vector3();
    o.copy(dir).normalize();
    const st = aimStateFor(aimKey(shooter, def, opts));
    const state = shooterState(shooter, def, opts, st);

    let preSpread = !!(opts?.spreadApplied || def?.spreadApplied);
    /*
     * WeaponSystem applies its own cone before handing the shot over. Re-coning it here
     * would widen every player shot by ~40 %. Detect it: for the local player the base
     * axis is the camera forward, so any deviation at all means the cone is already in.
     */
    if (!preSpread && isLocalPlayer(shooter, def, opts) && ctx.camera) {
      _camFwd.set(0, 0, -1).applyQuaternion(ctx.camera.getWorldQuaternion(_q));
      if (_camFwd.dot(o) < 0.9999999) preSpread = true;
    }

    if (!preSpread) {
      offsetDir(o, st.yaw, st.pitch);
      const cone = coneFor(def, state);
      if (cone > 1e-7) {
        const a = rand() * Math.PI * 2;
        const m = Math.sqrt(rand()) * cone;
        offsetDir(o, Math.cos(a) * m, Math.sin(a) * m);
      }
    }

    // Advance the pattern *after* the shot leaves: the first round is always clean.
    recoilSample(def, st.shot, _recoil);
    st.yaw += _recoil.x;
    st.pitch += _recoil.y;
    st.shot++;
    st.idle = 0;
    st.lastFire = ctx.time?.elapsed ?? 0;
    const sp = def?.spread;
    if (sp) {
      const perShot = state.ads > 0.5 ? sp.adsPerShot : sp.hipPerShot;
      st.bloom = Math.min(sp.hipMax ?? 0.1, st.bloom + num(perShot, 0.004));
      st.recover = num(state.ads > 0.5 ? sp.adsRecover : sp.hipRecover, 5.5 * DEG);
    } else {
      st.bloom = Math.min(0.1, st.bloom + 0.004);
      st.recover = 5.5 * DEG;
    }
    st.settle = num(def?.recoil?.recovery, 7);
    return o;
  }

  /** Bloom recovery + recoil settle. Runs every frame, over a handful of shooters. */
  function updateAim(dt) {
    if (!aimStates.size) return;
    aimStates.forEach((st) => {
      st.idle += dt;
      /*
       * Bloom only starts shrinking once the trigger is released. Recovering during
       * sustained fire is the classic mistake: the authored per-shot growth and the
       * per-second recovery very nearly cancel at cyclic rate, so the cone would never
       * open up and hip-firing a full mag would be as accurate as tapping.
       */
      if (st.bloom > 0 && st.idle > st.hold) {
        st.bloom = Math.max(0, st.bloom - st.recover * dt);
      }
      const k = 1 - Math.exp(-st.settle * dt);
      st.yaw -= st.yaw * k;
      st.pitch -= st.pitch * k;
      // Long enough between bursts and the pattern starts over, as every shooter does.
      if (st.idle > 0.42 && st.shot !== 0) st.shot = 0;
    });
  }

  /* ====================================================================== */
  /*                              round data                                */
  /* ====================================================================== */

  function roundOf(def) {
    const key = def?.calibre || CLASS_CALIBRE[def?.class] || '5.56x45';
    return CALIBRE[key] || CALIBRE[CLASS_CALIBRE[def?.class]] || CALIBRE['5.56x45'];
  }

  /** Interpolated body damage from the authored curve. */
  function curveDamage(def, metres) {
    if (typeof def?.damageAt === 'function') {
      const v = def.damageAt(metres);
      if (Number.isFinite(v)) return v;
    }
    const c = def?.damage;
    if (!Array.isArray(c) || !c.length) return 25;
    const d = Number.isFinite(metres) ? metres : 0;
    if (d <= c[0].r) return c[0].v;
    for (let i = 1; i < c.length; i++) {
      if (d <= c[i].r) {
        const a = c[i - 1];
        const b = c[i];
        const t = (d - a.r) / Math.max(1e-4, b.r - a.r);
        return a.v + (b.v - a.v) * t;
      }
    }
    return c[c.length - 1].v;
  }

  /**
   * Hitbox multiplier, rescaled by the weapon's authored group multipliers so a gun
   * with headMult 1.6 lands on 1.6 for a headshot but still keeps hand < limb < torso.
   */
  function hitboxMultiplier(def, hitbox) {
    const base = HITBOX_MULT[hitbox] ?? 1;
    const grp = HITBOX_GROUP[hitbox] ?? 'torso';
    if (grp === 'head') return base * (num(def?.headMult, 1.8) / 1.8);
    if (grp === 'limb') return base * (num(def?.limbMult, 0.85) / 0.85);
    return base * (num(def?.chestMult, 1.0) / 1.0);
  }

  /**
   * Which part did we hit? Explicit tags win (ragdoll bones, AI-authored hitboxes);
   * otherwise it is derived from where the point sits inside the body's own bounds,
   * which is correct for the capsule proxies the player and bots use.
   */
  function classify(hit, entity, dir) {
    const body = hit?.body;
    const ud = body?.userData;
    const tagged = ud?.hitbox || body?.hitbox || (ud?.bone ? BONE_HITBOX[ud.bone] : null);
    if (typeof tagged === 'string' && HITBOX_MULT[tagged] !== undefined) return tagged;
    if (typeof entity?.hitboxAt === 'function') {
      try {
        const t = entity.hitboxAt(hit.point, body);
        if (typeof t === 'string' && HITBOX_MULT[t] !== undefined) return t;
      } catch {
        /* fall through to geometry */
      }
    }
    if (!body?.aabbMin || !body?.aabbMax) return 'torso';
    const minY = body.aabbMin.y;
    const h = Math.max(0.3, body.aabbMax.y - minY);
    const f = clamp01((hit.point.y - minY) / h);
    if (f > 0.855) return 'head';
    if (f > 0.835) return 'neck';
    /*
     * Arms sit *across* the shot, not radially out from the body axis: the hit point on
     * a capsule is always ~one radius from the axis along the incoming ray, so a radial
     * measure calls every square-on chest shot a forearm. Project onto the axis
     * perpendicular to both the shot and world up instead.
     */
    if (dir && f > 0.46 && f < 0.835) {
      _up.set(0, 1, 0);
      _side.crossVectors(_up, dir);
      const sl = _side.length();
      if (sl > 1e-4) {
        _side.multiplyScalar(1 / sl);
        const lat = Math.abs(
          (hit.point.x - body.position.x) * _side.x + (hit.point.z - body.position.z) * _side.z
        );
        const halfW = Math.max(0.16, (body.aabbMax.x - body.aabbMin.x) * 0.5);
        if (lat > halfW * 0.94) return 'hand';
        if (lat > halfW * 0.72) return 'forearm';
      }
    }
    if (f > 0.7) return 'upper_torso';
    if (f > 0.58) return 'stomach';
    if (f > 0.47) return 'pelvis';
    if (f > 0.25) return 'thigh';
    if (f > 0.055) return 'shin';
    return 'foot';
  }

  /**
   * Damage after falloff, hitbox and armour.
   * Armour is read from the entity but never mutated — this module does not own it.
   * `armour` in 0..1 is a flat fraction; > 1 is treated as plate HP.
   */
  function damageFor(def, metres, hitbox, armourRaw, scale) {
    const base = curveDamage(def, metres);
    const mult = hitboxMultiplier(def, hitbox);
    let amount = base * mult * (scale ?? 1);
    let absorbed = 0;
    const armour = num(armourRaw, 0);
    if (armour > 0) {
      const cover = ARMOUR_COVERAGE[hitbox] ?? 0.8;
      if (armour <= 1) {
        absorbed = amount * clamp01(armour) * cover;
      } else {
        // Plate HP: soaks up to 65 % of the hit until it is used up.
        absorbed = Math.min(armour, amount * 0.65 * cover);
      }
      amount = Math.max(0, amount - absorbed);
    }
    return { amount, base, mult, absorbed };
  }

  /* ====================================================================== */
  /*                                 firing                                 */
  /* ====================================================================== */

  /**
   * Spawn a round (or a pellet spread).
   * @param {THREE.Vector3|{x,y,z}} origin muzzle position, world space
   * @param {THREE.Vector3|{x,y,z}} dir    aim direction (need not be normalised)
   * @param {object} weaponDef             a WeaponDefs entry, or any subset of it
   * @param {object} [shooter]             the firing entity (excluded from its own round)
   * @param {object} [opts]                {ads, moving, tracer, pellets, spreadApplied,…}
   */
  function fire(origin, dir, weaponDef, shooter, opts) {
    if (!enabled || !origin || !dir) return null;
    const def = weaponDef || {};
    try {
      stats.shots++;
      const pellets = Math.max(1, Math.round(num(opts?.pellets ?? def.pellets, 1)));
      const st = aimStateFor(aimKey(shooter, def, opts));

      // One aim solution per trigger pull; pellets scatter around it.
      aim(origin, dir, def, shooter, opts, _axis);

      const mine = isLocalPlayer(shooter, def, opts);
      const attacker =
        shooter || opts?.attacker || (mine ? ctx.player : null) || ownerTagOf(def, opts) || null;
      const round = roundOf(def);
      const mv = clamp(num(def.muzzleVelocity, 880), 60, 1400);
      const bc = num(def.ballisticCoefficient, round.bc);
      const mass = num(def.projectileMass, round.mass);
      const tracerEvery = Math.max(0, Math.round(num(def.tracerEvery, 0)));
      // Tracers: only when the weapon carries them, and only every Nth round.
      let wantTracer = false;
      if (opts?.tracer !== undefined) wantTracer = !!opts.tracer;
      else if (def.tracer !== undefined) wantTracer = !!def.tracer;
      else if (tracerEvery > 0) wantTracer = (st.shot - 1) % tracerEvery === 0;

      let first = null;
      for (let i = 0; i < pellets; i++) {
        const p = acquire();
        p.def = def;
        p.weaponId = def.id || opts?.weapon || '';
        p.owner = ownerTagOf(def, opts) ?? (mine ? 'player' : 'ai');
        p.attacker = attacker;
        p.ignore = shooter || (mine ? ctx.player : null);
        p.mass = mass;
        p.dragK = DRAG_K / Math.max(0.05, bc);
        p.penPower = clamp(num(def.penetration, 0.8), 0, 4);
        p.damageFn = typeof def.damageAt === 'function' ? def.damageAt : null;
        p.damageScale = 1;
        p.maxRange = num(def.maxRange, mv > 500 ? 900 : 420);
        p.maxLife = clamp(p.maxRange / Math.max(80, mv) * 2.4, 0.6, 6);
        p.dist = 0;
        p.life = 0;
        p.pens = 0;
        p.ricochets = 0;
        p.impacts = 0;
        p.hitEntN = 0;
        p.mask = num(opts?.mask, BULLET_MASK);
        p.spec.penetration = p.penPower;
        p.spec.mask = p.mask;
        p.spec.noRicochet = !!(opts?.noRicochet ?? def.noRicochet);
        p.tracer = wantTracer && pellets === 1;
        p.tracerLive = p.tracer;

        p.x = p.sx = p.ox = origin.x;
        p.y = p.sy = p.oy = origin.y;
        p.z = p.sz = p.oz = origin.z;

        _d.copy(_axis);
        if (pellets > 1) {
          const cone = num(opts?.pelletSpread ?? def.pelletSpread, 2.6 * DEG);
          const a = rand() * Math.PI * 2;
          const m = Math.sqrt(rand()) * cone;
          offsetDir(_d, Math.cos(a) * m, Math.sin(a) * m);
        }
        const v = mv * (1 + (rand() * 2 - 1) * 0.006); // real ammo is not identical
        p.vx = _d.x * v;
        p.vy = _d.y * v;
        p.vz = _d.z * v;
        if (!first) first = p;
      }
      stats.projectiles = live.length;

      // Advance immediately so a muzzle-contact shot resolves on the frame it is
      // fired instead of one fixed step later.
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        if (p.life === 0 && p.dist === 0) advance(p, FIXED_DT, i);
      }
      return pellets === 1 ? first : null;
    } catch (err) {
      warnOnce('fire failed', err);
      return null;
    }
  }

  /* ====================================================================== */
  /*                              integration                               */
  /* ====================================================================== */

  const IMPACT_STOP = 0;
  const IMPACT_CONTINUE = 1; // ignore this body, keep going along the same ray
  const IMPACT_REDIRECT = 2; // penetrated or ricocheted; position/velocity rewritten
  let _remain = 0;

  /**
   * One fixed step for one projectile: integrate with gravity + quadratic drag, sweep
   * the swept segment against the world, then run tracers and suppression over the
   * span actually travelled.
   * @returns {boolean} still alive
   */
  function advance(p, fdt, index) {
    const phys = ctx.physics;
    p.sx = p.x; p.sy = p.y; p.sz = p.z;

    let speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    // Sub-step so the arc stays smooth and the sweep segments stay short.
    const subs = clamp(Math.ceil((speed * fdt) / 4), 1, 4);
    const h = fdt / subs;

    for (let s = 0; s < subs; s++) {
      speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
      const k = p.dragK * speed;
      p.vx += (_grav.x - p.vx * k) * h;
      p.vy += (_grav.y - p.vy * k) * h;
      p.vz += (_grav.z - p.vz * k) * h;
      const ax0 = p.x, ay0 = p.y, az0 = p.z;
      p.x += p.vx * h;
      p.y += p.vy * h;
      p.z += p.vz * h;

      if (phys?.raycast) {
        let ax = ax0, ay = ay0, az = az0;
        let guard = 0;
        while (guard++ < 4) {
          const dx = p.x - ax, dy = p.y - ay, dz = p.z - az;
          const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (L < 1e-6) break;
          _o.set(ax, ay, az);
          _d.set(dx / L, dy / L, dz / L);
          let hit = null;
          try {
            hit = phys.raycast(_o, _d, L, p.mask, _hit);
          } catch (err) {
            warnOnce('raycast failed', err);
            break;
          }
          if (!hit) break;
          const code = resolveImpact(p, hit, _d, L - hit.distance);
          if (code === IMPACT_STOP) {
            p.dist += Math.sqrt(
              (hit.point.x - ax0) ** 2 + (hit.point.y - ay0) ** 2 + (hit.point.z - az0) ** 2
            );
            p.x = hit.point.x; p.y = hit.point.y; p.z = hit.point.z;
            finishSpan(p);
            release(p, index);
            return false;
          }
          if (code === IMPACT_CONTINUE) {
            ax = hit.point.x + _d.x * 0.02;
            ay = hit.point.y + _d.y * 0.02;
            az = hit.point.z + _d.z * 0.02;
            continue;
          }
          // REDIRECT: p.x/y/z sit at the exit point, velocity points the new way.
          ax = p.x; ay = p.y; az = p.z;
          if (_remain > 1e-4) {
            const inv = 1 / Math.max(1e-6, Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz));
            p.x += p.vx * inv * _remain;
            p.y += p.vy * inv * _remain;
            p.z += p.vz * inv * _remain;
          }
        }
      }
      p.dist += Math.sqrt(
        (p.x - ax0) * (p.x - ax0) + (p.y - ay0) * (p.y - ay0) + (p.z - az0) * (p.z - az0)
      );
    }

    p.life += fdt;
    finishSpan(p);

    const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    if (p.life > p.maxLife || p.dist > p.maxRange || spd < 70 || p.y < -220) {
      release(p, index);
      return false;
    }
    return true;
  }

  /** Tracer + suppression over the span this round covered in the last fixed step. */
  function finishSpan(p) {
    const dx = p.x - p.sx, dy = p.y - p.sy, dz = p.z - p.sz;
    const L2 = dx * dx + dy * dy + dz * dz;
    if (L2 < 1e-6) return;
    if (p.tracerLive) {
      // A real tracer burns out; drawing one for the whole 900 m flight of a miss is
      // both wrong and a torrent of FX calls for something nobody can see any more.
      if (p.life > TRACER_BURN || p.dist > TRACER_RANGE) p.tracerLive = false;
      else if (L2 > 0.16) emitTracer(p);
    }
    suppressAlong(p);
  }

  /* ====================================================================== */
  /*                            impact resolution                            */
  /* ====================================================================== */

  function alreadyHit(p, ent) {
    for (let i = 0; i < p.hitEntN; i++) if (p.hitEnt[i] === ent) return true;
    return false;
  }
  function markHit(p, ent) {
    if (p.hitEntN < 4) p.hitEnt[p.hitEntN++] = ent;
  }

  function resolveImpact(p, hit, dir, remainAfter) {
    _remain = 0;
    // A round never hits the thing that fired it.
    if (p.ignore && hit.entity && hit.entity === p.ignore) return IMPACT_CONTINUE;
    if (hit.body?.isTrigger && !hit.entity) return IMPACT_CONTINUE;

    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
    const energy = 0.5 * p.mass * speed * speed;
    const def = pen.defForHit(hit);
    p.impacts++;
    stats.impacts++;

    /* ── damage ─────────────────────────────────────────────────────────── */
    const entity = hit.entity;
    let damaged = false;
    if (entity && entity !== p.attacker && !alreadyHit(p, entity)) {
      markHit(p, entity);
      damaged = true;
      const hitbox = classify(hit, entity, dir);
      const armour = entity.armour ?? entity.armor ?? entity.plates ?? 0;
      const dmg = damageFor(p.def, p.dist + hit.distance, hitbox, armour, p.damageScale);
      if (dmg.amount > 0.01) {
        stats.damageEvents++;
        ctx.bus?.emit?.('entity:damage', {
          target: entity,
          amount: dmg.amount,
          hitbox,
          attacker: p.attacker,
          point: hit.point.clone(),
          dir: dir.clone(),
          normal: hit.normal.clone(),
          weapon: p.weaponId,
          source: 'bullet',
          surface: def.surface,
          material: def.material,
          distance: p.dist + hit.distance,
          headshot: hitbox === 'head',
          multiplier: dmg.mult,
          baseAmount: dmg.base,
          armourAbsorbed: dmg.absorbed,
          penetrated: p.pens > 0,
          ricocheted: p.ricochets > 0,
          energy,
          body: hit.body,
        });
      }
      // Note: damage is delivered through the event only. Calling a `takeDamage()`
      // method as well would double-apply it for any entity that does both.
    }

    /* ── impact event: FX, decals and audio all hang off this ───────────── */
    ctx.bus?.emit?.('bullet:impact', {
      point: hit.point.clone(),
      normal: hit.normal.clone(),
      surface: def.surface,
      material: def.material,
      energy,
      entity: entity || null,
      body: hit.body || null,
      dir: dir.clone(),
      def,
      weapon: p.weaponId,
      attacker: p.attacker,
      distance: p.dist + hit.distance,
      penetrated: p.pens > 0,
      damaged,
      speed,
    });
    try {
      ctx.fx?.impact?.(hit.point, hit.normal, {
        surface: def.surface, material: def.material, energy, entity, def, dir,
      });
    } catch (err) {
      warnOnce('fx.impact threw', err);
    }
    try {
      ctx.audio?.play?.(def.impactSound || 'impact_concrete', {
        position: hit.point, surface: def.surface, energy,
      });
    } catch {
      /* audio is optional */
    }

    /* ── momentum transfer into dynamic props ───────────────────────────── */
    const body = hit.body;
    if (body && body.invMass > 0 && ctx.physics?.applyImpulse) {
      // Momentum plus a gameplay term for the energy actually dumped into the body.
      const j = Math.min(28, p.mass * speed * 2.4);
      _imp.copy(dir).multiplyScalar(j);
      try {
        ctx.physics.applyImpulse(body, _imp, hit.point);
      } catch (err) {
        warnOnce('applyImpulse threw', err);
      }
    }

    /* ── penetrate / ricochet / stop ────────────────────────────────────── */
    const maxPens = Math.round(num(p.def?.maxPenetrations, 3));
    const outcome = pen.evaluate(hit, dir, energy, p.spec);

    if (outcome.action === 'ricochet' && p.ricochets < 2) {
      p.ricochets++;
      stats.ricochets++;
      const v = Math.sqrt((2 * outcome.energyOut) / Math.max(1e-6, p.mass));
      p.x = outcome.exitPoint.x; p.y = outcome.exitPoint.y; p.z = outcome.exitPoint.z;
      p.vx = outcome.dirOut.x * v;
      p.vy = outcome.dirOut.y * v;
      p.vz = outcome.dirOut.z * v;
      p.damageScale *= outcome.damageScale;
      ctx.bus?.emit?.('bullet:ricochet', {
        point: outcome.exitPoint.clone(),
        normal: outcome.entryNormal.clone(),
        dirIn: dir.clone(),
        dirOut: outcome.dirOut.clone(),
        surface: def.surface,
        material: def.material,
        energy: outcome.energyOut,
        weapon: p.weaponId,
        attacker: p.attacker,
      });
      _remain = Math.max(0, remainAfter);
      return IMPACT_REDIRECT;
    }

    if (outcome.action === 'penetrate' && p.pens < maxPens) {
      p.pens++;
      stats.penetrations++;
      const v = Math.sqrt((2 * outcome.energyOut) / Math.max(1e-6, p.mass));
      p.x = outcome.exitPoint.x; p.y = outcome.exitPoint.y; p.z = outcome.exitPoint.z;
      p.vx = outcome.dirOut.x * v;
      p.vy = outcome.dirOut.y * v;
      p.vz = outcome.dirOut.z * v;
      p.damageScale *= outcome.damageScale;
      ctx.bus?.emit?.('bullet:penetrate', {
        entryPoint: outcome.entryPoint.clone(),
        exitPoint: outcome.exitPoint.clone(),
        entryNormal: outcome.entryNormal.clone(),
        exitNormal: outcome.exitNormal.clone(),
        surface: def.surface,
        material: def.material,
        thickness: outcome.thickness,
        energyIn: outcome.energyIn,
        energyOut: outcome.energyOut,
        damageScale: p.damageScale,
        dir: outcome.dirOut.clone(),
        weapon: p.weaponId,
        attacker: p.attacker,
        entity: entity || null,
      });
      try {
        ctx.audio?.play?.(def.penetrateSound || 'pen_concrete', { position: outcome.exitPoint });
      } catch {
        /* optional */
      }
      _remain = Math.max(0, remainAfter - outcome.thickness);
      return IMPACT_REDIRECT;
    }

    return IMPACT_STOP;
  }

  /* ====================================================================== */
  /*                              suppression                               */
  /* ====================================================================== */

  const SUPPRESS_RADIUS = 2.4;
  const suppressClock = new WeakMap();

  function entityList() {
    const out = _entities;
    out.length = 0;
    const pl = ctx.player;
    if (pl) out.push(pl);
    const bots = ctx.ai?.bots;
    if (Array.isArray(bots)) {
      for (let i = 0; i < bots.length; i++) {
        const b = bots[i];
        if (b && b.alive !== false && b !== pl) out.push(b);
      }
    } else if (bots && typeof bots.forEach === 'function') {
      bots.forEach((b) => {
        if (b && b.alive !== false && b !== pl) out.push(b);
      });
    }
    return out;
  }

  /** Feet position of an entity, into `out`. */
  function entityPos(e, out) {
    const p = e?.position || e?.body?.position;
    if (p) out.set(num(p.x, 0), num(p.y, 0), num(p.z, 0));
    else out.set(0, -9999, 0);
    return out;
  }

  /** Squared distance from a point to the segment a→b, plus the chest offset. */
  function segDistSq(ax, ay, az, bx, by, bz, px, py, pz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    let t = 0;
    if (l2 > 1e-9) t = clamp01(((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2);
    const cx = ax + dx * t - px, cy = ay + dy * t - py, cz = az + dz * t - pz;
    return cx * cx + cy * cy + cz * cz;
  }

  /** Rounds cracking past somebody make them keep their head down. */
  function suppressAlong(p) {
    const list = entityList();
    if (!list.length) return;
    const now = ctx.time?.elapsed ?? 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e === p.attacker || e === p.ignore) continue;
      entityPos(e, _v1);
      // Chest height, so a round over the head still registers as a near miss.
      const d2 = segDistSq(p.sx, p.sy, p.sz, p.x, p.y, p.z, _v1.x, _v1.y + 1.1, _v1.z);
      if (d2 > SUPPRESS_RADIUS * SUPPRESS_RADIUS) continue;
      const d = Math.sqrt(d2);
      const clock = suppressClock.get(e);
      if (clock !== undefined && now - clock < 0.1) continue;
      suppressClock.set(e, now);
      const amount = clamp01(1 - d / SUPPRESS_RADIUS) * 0.55;
      stats.suppressions++;
      ctx.bus?.emit?.('entity:suppressed', {
        target: e,
        amount,
        attacker: p.attacker,
        point: new THREE.Vector3(p.x, p.y, p.z),
        distance: d,
        source: 'bullet',
        weapon: p.weaponId,
      });
      ctx.bus?.emit?.('bullet:whiz', {
        point: new THREE.Vector3(p.x, p.y, p.z),
        distance: d,
        entity: e,
        speed: Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz),
      });
      if (e === ctx.player) ctx.bus?.emit?.('player:suppressed', { amount });
    }
  }

  /* ====================================================================== */
  /*                                tracers                                 */
  /* ====================================================================== */

  /*
   * FXSystem owns tracers. Until it implements `tracer()`, this pooled line renderer
   * stands in so the sim is actually visible; it hands over the moment FX shows up.
   */
  const TRACER_SEGS = 128;
  /** Tracer compound burn time / visible range. */
  const TRACER_BURN = 1.1;
  const TRACER_RANGE = 420;
  let tracerFallback = null;
  const tracerLife = new Float32Array(TRACER_SEGS);
  let tracerHead = 0;

  function ensureTracerFallback() {
    if (tracerFallback || disposed) return tracerFallback;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(TRACER_SEGS * 6);
    const col = new Float32Array(TRACER_SEGS * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = 'ballisticsTracers';
    lines.frustumCulled = false;
    lines.renderOrder = 12;
    lines.castShadow = false;
    lines.receiveShadow = false;
    ctx.scene?.add(lines);
    tracerFallback = { geo, pos, col, mat, lines };
    return tracerFallback;
  }

  function pushFallbackTracer(ax, ay, az, bx, by, bz) {
    const t = ensureTracerFallback();
    if (!t) return;
    const i = tracerHead;
    tracerHead = (tracerHead + 1) % TRACER_SEGS;
    const o = i * 6;
    t.pos[o] = ax; t.pos[o + 1] = ay; t.pos[o + 2] = az;
    t.pos[o + 3] = bx; t.pos[o + 4] = by; t.pos[o + 5] = bz;
    tracerLife[i] = 0.085;
  }

  function updateTracerFallback(dt) {
    const t = tracerFallback;
    if (!t) return;
    let any = false;
    for (let i = 0; i < TRACER_SEGS; i++) {
      let l = tracerLife[i];
      if (l <= 0) {
        const o = i * 6;
        if (t.col[o] !== 0) {
          t.col[o] = t.col[o + 1] = t.col[o + 2] = 0;
          t.col[o + 3] = t.col[o + 4] = t.col[o + 5] = 0;
        }
        continue;
      }
      l -= dt;
      tracerLife[i] = l;
      any = true;
      // Hot core at the head, cooling toward the tail. HDR values so bloom catches it.
      const k = clamp01(l / 0.085);
      const a = k * k;
      const o = i * 6;
      t.col[o] = 2.6 * a * 0.55; t.col[o + 1] = 0.9 * a * 0.5; t.col[o + 2] = 0.22 * a * 0.5;
      t.col[o + 3] = 3.4 * a; t.col[o + 4] = 1.5 * a; t.col[o + 5] = 0.45 * a;
    }
    t.geo.attributes.position.needsUpdate = true;
    t.geo.attributes.color.needsUpdate = true;
    t.geo.setDrawRange(0, TRACER_SEGS * 2);
    t.lines.visible = any;
  }

  /** Hand the segment the round actually flew to FX, so the streak matches the sim. */
  function emitTracer(p) {
    stats.tracers++;
    const fx = ctx.fx;
    if (typeof fx?.tracer === 'function') {
      _v1.set(p.sx, p.sy, p.sz);
      _v2.set(p.x, p.y, p.z);
      try {
        fx.tracer(_v1, _v2, {
          weapon: p.weaponId,
          speed: Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz),
          owner: p.owner,
          first: p.dist < 12,
          projectile: p.id,
        });
        return;
      } catch (err) {
        warnOnce('fx.tracer threw', err);
        p.tracerLive = false;
        return;
      }
    }
    pushFallbackTracer(p.sx, p.sy, p.sz, p.x, p.y, p.z);
  }

  /* ====================================================================== */
  /*                                grenades                                */
  /* ====================================================================== */

  const GRENADE_MAX = 8;
  const grenades = [];
  let grenadeProto = null;
  /** owner -> ctx.time.elapsed when they started holding the spoon. */
  const cookTimers = new Map();
  const cookKey = (o) => o ?? 'player';

  /** A frag body, fuze cap, spoon and pin — small, but properly shaded and worn. */
  function buildGrenadeMesh() {
    if (grenadeProto) return grenadeProto.clone(true);
    const g = new THREE.Group();
    g.name = 'grenade';
    const steel = ctx.materials?.get?.('painted_steel_chipped')
      || new THREE.MeshStandardMaterial({ color: 0x39402f, roughness: 0.62, metalness: 0.75 });
    const bright = ctx.materials?.get?.('brushed_aluminium') || steel;

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.0305, 0.03, 5, 16), steel);
    body.position.y = 0.001;
    const fuze = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0135, 0.02, 12), bright);
    fuze.position.y = 0.0555;
    const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.0085, 0.056, 0.0125), bright);
    spoon.position.set(0.0295, 0.036, 0);
    spoon.rotation.z = 0.11;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0092, 0.0018, 5, 12), bright);
    ring.position.set(-0.0165, 0.0585, 0);
    ring.rotation.y = Math.PI / 2;

    for (const m of [body, fuze, spoon, ring]) {
      m.castShadow = true;
      m.receiveShadow = true;
      // VelocityPass only writes motion vectors for meshes flagged dynamic, and a
      // grenade tumbling through the air is exactly what motion blur is for.
      m.userData.dynamic = true;
      g.add(m);
    }
    grenadeProto = g;
    return g.clone(true);
  }

  function acquireGrenade() {
    for (let i = 0; i < grenades.length; i++) if (!grenades[i].active) return grenades[i];
    if (grenades.length >= GRENADE_MAX) {
      const g = grenades[0];
      detonate(g);
      return g;
    }
    const g = { active: false, group: null, body: null, t: 0, fuse: 3.5, damage: 130, radius: 8, owner: null, attacker: null, type: 'frag' };
    grenades.push(g);
    return g;
  }

  /**
   * Throw a grenade as a real rigid body — it bounces, rolls and can be cooked.
   * @param {object} opts {speed, fuse, cook, damage, radius, type, owner, spin}
   */
  function throwGrenade(origin, dir, opts = {}) {
    if (!enabled || !origin || !dir) return null;
    try {
      const g = acquireGrenade();
      const GR = groups();
      if (!g.group) g.group = buildGrenadeMesh();
      if (!g.group.parent) ctx.scene?.add(g.group);
      g.group.visible = true;

      const key = cookKey(opts.owner);
      const held = cookTimers.has(key)
        ? Math.max(0, (ctx.time?.elapsed ?? 0) - cookTimers.get(key))
        : 0;
      const cooked = clamp(num(opts.cook, held), 0, 10);
      cookTimers.delete(key);
      g.fuse = Math.max(0.12, num(opts.fuse, 3.6) - cooked);
      g.t = 0;
      g.damage = num(opts.damage, 130);
      g.radius = num(opts.radius, 8.5);
      g.type = opts.type || 'frag';
      g.owner = opts.owner ?? null;
      g.attacker = opts.attacker ?? opts.owner ?? null;
      g.active = true;

      _d.copy(dir).normalize();
      const speed = num(opts.speed, 17);
      // Described as a plain collider so PhysicsWorld builds the shape — passing a
      // half-built shape object down that path is how you end up with a unit box.
      const body = ctx.physics?.addBody?.({
        type: 'sphere',
        radius: 0.036,
        mass: 0.4,
        pos: { x: origin.x + _d.x * 0.25, y: origin.y + _d.y * 0.25, z: origin.z + _d.z * 0.25 },
        material: 'metal',
        surface: 'metal',
        restitution: 0.3,
        friction: 0.62,
        linearDamping: 0.02,
        angularDamping: 0.5,
        group: GR.PROP ?? G.PROP,
        mask: (GR.WORLD ?? 1) | (GR.PROP ?? 8) | (GR.AI ?? 4),
        ccd: true,
        mesh: g.group,
        entity: null,
      });
      g.body = body || null;
      if (body) {
        body.setVelocity?.(_d.x * speed, _d.y * speed + 1.4, _d.z * speed);
        body.angularVelocity?.set?.(
          (rand() * 2 - 1) * 12, (rand() * 2 - 1) * 9, (rand() * 2 - 1) * 12
        );
      } else {
        // No physics: fall back to a straight ballistic path so the fuse still runs.
        g.group.position.set(origin.x, origin.y, origin.z);
      }
      stats.grenades++;
      ctx.bus?.emit?.('grenade:throw', {
        point: new THREE.Vector3(origin.x, origin.y, origin.z),
        dir: _d.clone(), type: g.type, owner: g.owner, fuse: g.fuse,
      });
      try {
        ctx.audio?.play?.('grenade_throw', { position: origin });
      } catch {
        /* optional */
      }
      return g;
    } catch (err) {
      warnOnce('throwGrenade failed', err);
      return null;
    }
  }

  function recycleGrenade(g) {
    g.active = false;
    if (g.body) {
      try {
        ctx.physics?.removeBody?.(g.body);
      } catch {
        /* best effort */
      }
      g.body = null;
    }
    if (g.group) g.group.visible = false;
  }

  function detonate(g) {
    if (!g.active) return;
    const pos = g.body?.position || g.group?.position;
    _v3.set(num(pos?.x, 0), num(pos?.y, 0), num(pos?.z, 0));
    recycleGrenade(g);
    explode(_v3, {
      radius: g.radius, damage: g.damage, attacker: g.attacker,
      owner: g.owner, type: g.type, source: 'grenade',
    });
    ctx.bus?.emit?.('grenade:detonate', {
      point: _v3.clone(), type: g.type, owner: g.owner,
    });
  }

  /** True when `to` cannot be seen from `from`. Cover has to actually protect. */
  function losBlocked(from, to, dist) {
    const phys = ctx.physics;
    if (!phys?.raycast) return false;
    _los.copy(to).sub(from);
    const L = _los.length();
    if (L < 1e-4) return false;
    _los.multiplyScalar(1 / L);
    let h = null;
    try {
      h = phys.raycast(from, _los, L - 0.12, LOS_MASK, _losHit);
    } catch {
      return false;
    }
    return !!h && h.distance < (dist ?? L) - 0.15;
  }

  const BLAST_SAMPLES = [0.25, 1.05, 1.62];

  /**
   * Radial damage with real line-of-sight sampling: three points up the body, so
   * crouching behind a wall genuinely saves you and only your head being exposed
   * only gets you hurt a little.
   */
  function explode(point, opts = {}) {
    const radius = num(opts.radius, 8);
    const damage = num(opts.damage, 120);
    const attacker = opts.attacker ?? opts.owner ?? null;
    ctx.bus?.emit?.('explosion', {
      point: point.clone ? point.clone() : new THREE.Vector3(point.x, point.y, point.z),
      radius,
      damage,
      source: opts.source || 'explosion',
      owner: opts.owner ?? null,
      type: opts.type || 'frag',
    });
    try {
      ctx.fx?.explosion?.(point, { radius, damage, type: opts.type || 'frag' });
    } catch (err) {
      warnOnce('fx.explosion threw', err);
    }
    try {
      ctx.audio?.play?.('explosion', { position: point });
    } catch {
      /* optional */
    }

    const list = entityList();
    const now = ctx.time?.elapsed ?? 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      entityPos(e, _v2);
      let best = Infinity;
      let bestVisible = Infinity;
      let visible = 0;
      for (let s = 0; s < BLAST_SAMPLES.length; s++) {
        _v1.set(_v2.x, _v2.y + BLAST_SAMPLES[s], _v2.z);
        const d = _v1.distanceTo(point);
        if (d > radius) continue;
        if (d < best) best = d;
        if (!losBlocked(point, _v1, d)) {
          visible++;
          if (d < bestVisible) bestVisible = d;
        }
      }
      if (!(best < radius)) continue;
      const visFrac = visible / BLAST_SAMPLES.length;
      const dist = visible ? bestVisible : best;
      // Fully occluded still stings a little — overpressure goes around corners.
      const cover = visible === 0 ? 0.12 : 0.4 + 0.6 * visFrac;
      const fall = Math.pow(clamp01(1 - dist / radius), 1.35);
      const amount = damage * fall * cover;
      if (amount >= 1) {
        stats.damageEvents++;
        ctx.bus?.emit?.('entity:damage', {
          target: e,
          amount,
          hitbox: 'torso',
          attacker,
          point: point.clone ? point.clone() : new THREE.Vector3(point.x, point.y, point.z),
          dir: _v1.set(_v2.x, _v2.y + 1.0, _v2.z).sub(point).normalize().clone(),
          source: opts.source || 'explosion',
          weapon: opts.type || 'frag',
          distance: dist,
          headshot: false,
          occluded: visible === 0,
          visibility: visFrac,
        });
      }
      // Anything inside a wide bubble of a blast is suppressed, cover or not.
      if (best < radius * 1.8) {
        suppressClock.set(e, now);
        const amt = clamp01(1 - best / (radius * 1.8));
        stats.suppressions++;
        ctx.bus?.emit?.('entity:suppressed', {
          target: e, amount: amt, attacker, distance: best, source: 'explosion',
          point: point.clone ? point.clone() : new THREE.Vector3(point.x, point.y, point.z),
        });
        if (e === ctx.player) ctx.bus?.emit?.('player:suppressed', { amount: amt });
      }
    }
  }

  function tickGrenades(fdt) {
    for (let i = 0; i < grenades.length; i++) {
      const g = grenades[i];
      if (!g.active) continue;
      g.t += fdt;
      if (!g.body && g.group) {
        // Physics-less fallback: simple ballistic drop so the fuse still means something.
        g.group.position.y -= 4.9 * fdt * fdt;
      }
      if (g.t >= g.fuse) detonate(g);
    }
  }

  /* ====================================================================== */
  /*                                  debug                                 */
  /* ====================================================================== */

  /** Sampled arc for debug draw / AI lead solving. Fills `out` with Vector3s. */
  function trajectory(origin, dir, weaponDef, out, n = 32, dt = 0.02) {
    const res = out || [];
    const round = roundOf(weaponDef);
    const bc = num(weaponDef?.ballisticCoefficient, round.bc);
    const k0 = DRAG_K / Math.max(0.05, bc);
    let vx = 0, vy = 0, vz = 0;
    _d.copy(dir).normalize();
    const mv = clamp(num(weaponDef?.muzzleVelocity, 880), 60, 1400);
    vx = _d.x * mv; vy = _d.y * mv; vz = _d.z * mv;
    let x = origin.x, y = origin.y, z = origin.z;
    for (let i = 0; i < n; i++) {
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const k = k0 * sp;
      vx += (_grav.x - vx * k) * dt;
      vy += (_grav.y - vy * k) * dt;
      vz += (_grav.z - vz * k) * dt;
      x += vx * dt; y += vy * dt; z += vz * dt;
      if (res[i]) res[i].set(x, y, z);
      else res[i] = new THREE.Vector3(x, y, z);
    }
    res.length = n;
    return res;
  }

  /** Harness hook: `debug:pose` can ask for a demo burst or a live grenade. */
  function onPose(state) {
    if (!state) return;
    try {
      const cam = ctx.camera;
      if (!cam) return;
      _v1.copy(cam.position);
      _v2.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(_q));
      const n = Number(state.tracers) || 0;
      if (n > 0) {
        const def = ctx.weapons?.current?.def || { muzzleVelocity: 880, calibre: '5.56x45', penetration: 0.8, tracerEvery: 1 };
        for (let i = 0; i < Math.min(12, n); i++) {
          _v3.copy(_v2);
          offsetDir(_v3, (rand() * 2 - 1) * 0.012, (rand() * 2 - 1) * 0.008);
          fire(_v1, _v3, def, ctx.player, { tracer: true, spreadApplied: true, owner: 'player' });
        }
      }
      if (state.grenade) {
        throwGrenade(_v1, _v2, {
          fuse: typeof state.grenade === 'number' ? state.grenade : 3.2,
          owner: ctx.player,
        });
      }
      if (state.ballistics === 'clear') {
        for (let i = live.length - 1; i >= 0; i--) release(live[i], i);
      }
    } catch (err) {
      warnOnce('debug pose', err);
    }
  }

  /* ====================================================================== */
  /*                                  api                                   */
  /* ====================================================================== */

  const api = {
    ready: false,
    fire,
    throwGrenade,
    explode,
    aim: (origin, dir, def, shooter, opts, out) => aim(origin, dir, def, shooter, opts, out),
    coneFor,
    trajectory,
    classify,
    damageFor,
    hitboxMultiplier,
    penetration: pen,
    stats,
    HITBOX_MULT,
    BULLET_MASK,
    get live() { return live.length; },
    get grenades() { return grenades.filter((g) => g.active).length; },

    /**
     * Start holding the spoon. `throwGrenade` subtracts however long it was held from
     * the fuse (floored at 0.12 s), so cooking past the fuse blows up in your hand —
     * poll `cookTime()` if you want to warn the player before that happens.
     */
    cook(owner) {
      cookTimers.set(cookKey(owner), ctx.time?.elapsed ?? 0);
      return true;
    },
    cookTime(owner) {
      const t0 = cookTimers.get(cookKey(owner));
      return t0 === undefined ? 0 : Math.max(0, (ctx.time?.elapsed ?? 0) - t0);
    },
    cancelCook(owner) {
      cookTimers.delete(cookKey(owner));
    },

    bloomOf(shooter) {
      return aimStates.get(shooter || 'default')?.bloom ?? 0;
    },
    aimState(shooter) {
      return aimStateFor(shooter || 'default');
    },
    resetAim(shooter) {
      const st = aimStates.get(shooter || 'default');
      if (st) {
        st.bloom = 0;
        st.shot = 0;
        st.yaw = 0;
        st.pitch = 0;
      }
    },
    setEnabled(v) {
      enabled = !!v;
      if (!enabled) for (let i = live.length - 1; i >= 0; i--) release(live[i], i);
    },
    /** Drop every round and grenade in flight — used on respawn / round reset. */
    clear() {
      for (let i = live.length - 1; i >= 0; i--) release(live[i], i);
      for (const g of grenades) recycleGrenade(g);
      aimStates.clear();
    },
  };

  function applyQuality() {
    const tier = ctx.settings?.tier || 'high';
    MAX_PROJECTILES = { low: 64, medium: 128, high: 192, ultra: 256 }[tier] ?? 192;
    while (live.length > MAX_PROJECTILES) release(live[0], 0);
  }

  // Published from the factory too: another system's factory may capture ctx.ballistics
  // before our init() runs.
  ctx.ballistics = api;

  const unsubs = [];
  const on = (name, fn) => {
    const u = ctx.bus?.on?.(name, fn);
    if (u) unsubs.push(u);
  };

  return {
    name: 'ballistics',
    order: 44,

    async init() {
      ctx.ballistics = api;
      try {
        const g = ctx.physics?.gravity;
        if (g) _grav.set(num(g.x, 0), num(g.y, -9.81), num(g.z, 0));
      } catch {
        /* the default is right anyway */
      }
      applyQuality();
      on('quality:changed', applyQuality);
      on('debug:pose', onPose);
      on('player:respawn', () => api.clear());
      api.ready = true;
    },

    fixed(fdt) {
      if (!enabled) return;
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        if (!p.active) continue;
        try {
          advance(p, fdt, i);
        } catch (err) {
          warnOnce('projectile step failed', err);
          release(p, i);
        }
      }
      stats.projectiles = live.length;
      try {
        tickGrenades(fdt);
      } catch (err) {
        warnOnce('grenade tick failed', err);
      }
    },

    update(dt) {
      updateAim(dt);
      updateTracerFallback(dt);
    },

    dispose() {
      disposed = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* best effort */
        }
      }
      unsubs.length = 0;
      for (let i = live.length - 1; i >= 0; i--) release(live[i], i);
      for (const g of grenades) {
        recycleGrenade(g);
        if (g.group?.parent) g.group.parent.remove(g.group);
      }
      grenades.length = 0;
      if (grenadeProto) {
        grenadeProto.traverse((o) => o.geometry?.dispose?.());
        grenadeProto = null;
      }
      if (tracerFallback) {
        tracerFallback.lines.parent?.remove(tracerFallback.lines);
        tracerFallback.geo.dispose();
        tracerFallback.mat.dispose();
        tracerFallback = null;
      }
      aimStates.clear();
      cookTimers.clear();
      warned = new Set();
      if (ctx.ballistics === api) ctx.ballistics = null;
    },
  };
}
