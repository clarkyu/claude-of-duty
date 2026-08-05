/**
 * CameraRig — everything about how the camera *feels*.
 * Owner: camera agent. Files owned: player/CameraRig.js, player/Shake.js.
 * Publishes: `ctx.cameraRig`.
 * Listens: weapon:fire, weapon:equip, player:land, player:step, player:state,
 *          entity:damage, explosion, suppression, debug:cameraLock, setting:changed,
 *          quality:changed.
 * Emits:   camera:footfall {phase, stance, speed}  — fired at the bottom of each bob dip
 *          so the viewmodel / audio can hang a step on the exact visual contact.
 *
 * ── Where this sits ─────────────────────────────────────────────────────────────
 * `Controller.js` owns where the player *is*: it writes `ctx.camera.position` and
 * `.rotation` during `update()`. This rig runs in `lateUpdate()` and is purely additive:
 * every frame it snapshots the controller's pose as the **base**, computes a stack of
 * offsets, and writes `base + offsets` back out. Nothing here ever feeds back into aim,
 * so mouse look stays 1:1 exact no matter how violently the camera is being thrown
 * around — which is the difference between "punchy" and "unplayable".
 *
 * The base snapshot is self-healing: if the transform on entry is bit-identical to what
 * this rig wrote last frame, nobody upstream moved the camera, so the previously stored
 * base is reused rather than baking last frame's bob into this frame's base. That single
 * check is what stops the offsets from integrating into a slow drift when the player
 * controller is idle, stubbed, or paused.
 *
 * ── The stack (all frame-rate independent; see Shake.js) ────────────────────────
 *  1. View bob        distance-driven stride phase, figure-eight translation (x = sin p,
 *                     y = sin 2p) plus roll/pitch/yaw harmonics. Separate amplitude and
 *                     stride-length curves for walk / sprint / crouch, cross-faded so a
 *                     stance change is a blend and not a pop. Phase is *locked to the
 *                     footstep cycle*: `player:step` nudges the phase toward the nearest
 *                     bob minimum, so the footfall you hear lands on the dip you see.
 *  2. Landing impact  under-damped spring dip whose depth scales with impact speed, plus
 *                     a roll kick when you land while moving sideways, plus trauma on a
 *                     genuinely hard landing.
 *  3. Strafe tilt     a couple of degrees of roll leaning into lateral velocity, and a
 *                     whisker of pitch against forward acceleration.
 *  4. Recoil          spring-damper impulse per `weapon:fire`, vertical-biased with a
 *                     seeded horizontal scatter. Recovery is *partial*: a fraction of
 *                     every shot accumulates into a slowly-decaying rest offset, so
 *                     sustained fire climbs and controlling it is a skill.
 *  5. Shake           trauma model, Perlin-driven, distance-attenuated from `explosion`.
 *  6. Breathing       figure-eight sway with a noise wander; louder when hurt, when
 *                     winded from sprinting, and when aiming down sights.
 *  7. ADS + FOV       non-linear eased ADS blend (fast out, slow in) driving FOV and a
 *                     small pull-forward, composited with damped sprint/speed widening.
 *
 * Translation from layers 1/2/3/5 is applied in a **yaw-only** frame, so looking
 * straight up does not turn the vertical bob into a forward lunge. Recoil kickback and
 * the ADS pull-forward use the full view frame, because those genuinely follow the
 * muzzle.
 *
 * ── Public API (ctx.cameraRig) ──────────────────────────────────────────────────
 *   addImpulse({pos, rot, trauma, space})   push the camera around from anywhere.
 *                                           `pos`/`rot` are velocity impulses (m/s,
 *                                           rad/s) as Vector3 | [x,y,z] | {x,y,z};
 *                                           `space` is 'local' (default) or 'world'.
 *   getViewOffset()   -> live, non-allocating view of what the rig is doing this frame:
 *                        { pos, rot, bob, recoil, shake, ads, fov, speed, stance, ... }
 *                        The viewmodel rig counter-animates against `pos`/`rot`.
 *   shake(trauma)     add trauma directly (0..1).
 *   suppress(amount)  add suppression (near-miss jitter + slight FOV pinch).
 *   explosionAt(point, radius, damage)   manual version of the `explosion` event.
 *   reset()           snap every spring/blend to rest.
 *   setEnabled(bool) / enabled
 *   intensity         master multiplier on everything (0 disables all motion)
 *   ads, fov, trauma, exertion, stridePhase, strideT, speed, grounded, stance, locked
 */
import * as THREE from 'three';
import {
  TAU,
  DEG2RAD,
  clamp,
  clamp01,
  lerp,
  smoothstep,
  damp,
  easeTowards,
  Spring1,
  Spring3,
  Noise1D,
  TraumaShake,
  Sway,
} from './Shake.js';

/**
 * Per-stance bob curves. `cycle` is metres travelled per full two-step cycle — driving
 * the phase off distance rather than time is what makes the cadence automatically track
 * speed without a single tuning constant for frequency. `ref` is the speed at which the
 * stance is at full amplitude.
 */
const STANCES = {
  walk: {
    cycle: 2.05,
    ref: 4.3,
    posX: 0.0240,
    posY: 0.0200,
    posZ: 0.0060,
    roll: 0.0096, // ~0.55 deg
    pitch: 0.0042,
    yaw: 0.0038,
  },
  sprint: {
    cycle: 3.15,
    ref: 7.0,
    posX: 0.0400,
    posY: 0.0350,
    posZ: 0.0125,
    roll: 0.0210, // ~1.2 deg
    pitch: 0.0090,
    yaw: 0.0105,
  },
  crouch: {
    cycle: 1.50,
    ref: 2.2,
    posX: 0.0150,
    posY: 0.0130,
    posZ: 0.0040,
    roll: 0.0062,
    pitch: 0.0030,
    yaw: 0.0024,
  },
};

/** Bob minima (where a foot plants) for y = sin(2p). */
const FOOTFALL_PHASES = [(3 * Math.PI) / 4, (7 * Math.PI) / 4];

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const finite3 = (x, y, z) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);

/** Accepts Vector3 | [x,y,z] | {x,y,z} | null. Returns true if it wrote something. */
function readVec3(src, out) {
  if (!src) return false;
  if (Array.isArray(src)) {
    if (src.length < 3) return false;
    out.set(num(src[0]), num(src[1]), num(src[2]));
    return true;
  }
  if (typeof src.x === 'number' || typeof src.y === 'number' || typeof src.z === 'number') {
    out.set(num(src.x), num(src.y), num(src.z));
    return true;
  }
  return false;
}

/** Weapon defs in the wild are written in degrees about as often as radians. */
function angleOf(v, fallback) {
  if (!Number.isFinite(v)) return fallback;
  return Math.abs(v) > 0.25 ? v * DEG2RAD : v;
}

/** Wrap to (-PI, PI]. */
function wrapPi(a) {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/**
 * Velocity impulse that makes an under-damped spring peak at exactly `peak`.
 *
 * For `x'' = -w^2 x - 2*z*w*x'` kicked with velocity v, the first extremum is
 * `v * e^(-z/wd * atan2(wd, z)) / w` with `wd = sqrt(1 - z^2)`. Inverting that lets every
 * tuning number below be written as the displacement you actually want to see — "dip 9
 * centimetres", "kick up 1.2 degrees" — instead of an opaque velocity that silently
 * changes meaning whenever the damping ratio is touched.
 */
function peakImpulse(spring, peak) {
  const z = clamp(spring.damping, 0.05, 0.999);
  const wd = Math.sqrt(1 - z * z);
  const decay = Math.max(Math.exp((-z / wd) * Math.atan2(wd, z)), 0.05);
  return (peak * spring.frequency * TAU) / decay;
}

export default function createCameraRig(ctx) {
  // A fork keeps the 512 draws needed for the noise tables from shifting the global
  // deterministic stream that every system booting after us reads from.
  const tableRng = ctx.rng?.fork?.() ?? ctx.rng ?? (() => 0.5);
  const noise = new Noise1D(tableRng);

  // ── dynamical state ───────────────────────────────────────────────────────────
  const shake = new TraumaShake(tableRng, { noise });
  const sway = new Sway(noise, { rate: 0.24, wander: 0.11 });

  // Landing: under-damped so it bounces back through the rest position once.
  const landDip = new Spring1({ frequency: 3.3, damping: 0.42 });
  const landPitch = new Spring1({ frequency: 3.8, damping: 0.5 });
  const landRoll = new Spring1({ frequency: 3.1, damping: 0.46 });

  // Recoil: rotational (pitch/yaw/roll) and positional (kickback) springs.
  const recoilRot = new Spring3({ frequency: 8.5, damping: 0.52 });
  const recoilPos = new Spring3({ frequency: 10.5, damping: 0.62 });
  /** The part of the kick that does NOT come back — this is what makes fire climb. */
  const recoilRest = { x: 0, y: 0 };

  // Generic external impulses (addImpulse).
  const extRot = new Spring3({ frequency: 7.0, damping: 0.45 });
  const extPos = new Spring3({ frequency: 8.0, damping: 0.5 });

  // Blends and scalars.
  const blend = { walk: 0, sprint: 0, crouch: 0, air: 0 };
  let bobPhase = 0;
  let bobWeight = 0; // 0..1, how much the bob layer is contributing right now
  let strafeRoll = 0;
  let accelPitch = 0;
  let exertion = 0; // 0..1 winded-ness
  let suppression = 0;
  let adsBlend = 0;
  let fovMotion = 0;
  let fovBase = 60;
  let fovApplied = -1;
  let timeSinceFire = 999;
  let burst = 0;
  let sawLandEvent = false;
  let sawStepEvent = false;
  /** Measured seconds between `player:step` events — the controller's real cadence. */
  let stepInterval = 0;
  let timeSinceStep = 999;
  let prevGrounded = true;
  let prevFootIndex = -1;
  let locked = false;
  let started = false;

  // ── base-pose tracking ────────────────────────────────────────────────────────
  const base = { px: 0, py: 1.7, pz: 0, rx: 0, ry: 0, rz: 0 };
  const lastOut = { px: NaN, py: NaN, pz: NaN, rx: NaN, ry: NaN, rz: NaN };
  const prevBasePos = new THREE.Vector3(0, 1.7, 0);
  const estVel = new THREE.Vector3();
  const velWorld = new THREE.Vector3();
  let prevLocalForward = 0;

  // ── scratch (never allocate in lateUpdate) ────────────────────────────────────
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _quatYaw = new THREE.Quaternion();
  const _quatView = new THREE.Quaternion();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const offYaw = { x: 0, y: 0, z: 0 }; // yaw-frame translation
  const offView = { x: 0, y: 0, z: 0 }; // full-view-frame translation
  const offRot = { x: 0, y: 0, z: 0 };

  // ── published view offset (mutated in place; callers must not retain sub-objects
  //    across frames expecting a snapshot) ───────────────────────────────────────
  const viewOffset = {
    pos: new THREE.Vector3(),
    rot: new THREE.Vector3(),
    bob: { x: 0, y: 0, phase: 0, weight: 0, stride: 0 },
    recoil: { pitch: 0, yaw: 0, roll: 0, back: 0, climb: 0 },
    shake: { trauma: 0, intensity: 0 },
    breath: 0,
    ads: 0,
    fov: 60,
    speed: 0,
    lateral: 0,
    grounded: true,
    stance: 'idle',
    exertion: 0,
    suppression: 0,
  };

  const subs = [];
  const on = (name, fn) => {
    const un = ctx.bus?.on?.(name, fn);
    if (un) subs.push(un);
  };

  const scale = (key, d = 1) => {
    const v = ctx.settings?.get?.(key);
    return Number.isFinite(v) ? v : d;
  };

  // ── player / weapon state readers (every one of these is a stub today) ────────
  function stanceString() {
    let s = ctx.player?.state;
    if (s && typeof s === 'object') s = s.name ?? s.stance ?? s.current ?? s.value;
    return typeof s === 'string' ? s.toLowerCase() : '';
  }

  function readAdsTarget() {
    const w = ctx.weapons;
    if (!w) return { value: 0, numeric: false };
    const cur = w.current;
    const numeric = [w.adsProgress, w.adsBlend, w.adsT, cur?.adsProgress, cur?.adsT];
    for (const c of numeric) {
      if (typeof c === 'number' && Number.isFinite(c)) return { value: clamp01(c), numeric: true };
    }
    const bools = [w.ads, w.aiming, w.isAds, w.isAiming, cur?.ads, cur?.aiming];
    for (const c of bools) {
      if (typeof c === 'boolean') return { value: c ? 1 : 0, numeric: false };
      if (typeof c === 'number' && Number.isFinite(c)) return { value: clamp01(c), numeric: true };
    }
    return { value: 0, numeric: false };
  }

  function weaponDef() {
    const w = ctx.weapons;
    const cur = w?.current;
    return cur?.def || cur?.data || cur || w?.def || null;
  }

  function adsFovScaleOf(def) {
    const zoom = num(def?.zoom, 0);
    if (zoom > 1.01) return clamp(1 / zoom, 0.18, 0.98);
    const s = def?.adsFovScale ?? def?.fovScale ?? def?.adsFov;
    if (Number.isFinite(s) && s > 0.15 && s <= 1) return s;
    const g = ctx.settings?.get?.('adsFovScale');
    return Number.isFinite(g) && g > 0.15 && g <= 1 ? g : 0.72;
  }

  function healthFraction() {
    let hp = ctx.player?.health;
    if (!Number.isFinite(hp)) hp = ctx.player?.hp;
    if (!Number.isFinite(hp)) hp = ctx.game?.playerHealth;
    if (!Number.isFinite(hp)) return 1;
    return clamp01(hp > 1.5 ? hp / 100 : hp);
  }

  function isLocalPlayer(target) {
    if (!target) return false;
    const p = ctx.player;
    if (!p) return false;
    return (
      target === p ||
      target === p.entity ||
      target === p.body ||
      target.isPlayer === true ||
      target.isLocalPlayer === true ||
      target.name === 'player'
    );
  }

  // ── event handlers ────────────────────────────────────────────────────────────

  /**
   * Phase-lock the bob to the footstep cycle.
   *
   * Two things happen here. First the interval between `player:step` events is measured,
   * and while steps keep arriving that measurement — not this file's stride-length
   * constants — drives the phase rate. Without that, any disagreement between the
   * controller's cadence and ours is a permanent race that the correction below can
   * never win, and the bob visibly stutters. Second, the phase is nudged (never snapped)
   * toward the nearest bob minimum, so within a couple of steps the footfall you hear
   * lands on the dip you see.
   */
  function lockPhaseToFootstep() {
    sawStepEvent = true;
    if (timeSinceStep > 0.07 && timeSinceStep < 1.4) {
      stepInterval = stepInterval > 0 ? lerp(stepInterval, timeSinceStep, 0.35) : timeSinceStep;
    }
    timeSinceStep = 0;
    let bestErr = Infinity;
    for (const target of FOOTFALL_PHASES) {
      const e = wrapPi(target - bobPhase);
      if (Math.abs(e) < Math.abs(bestErr)) bestErr = e;
    }
    if (!Number.isFinite(bestErr)) return;
    // Partial correction: a hard snap would visibly jerk the horizon.
    bobPhase = (bobPhase + bestErr * 0.5 + TAU) % TAU;
  }

  function onLand(payload) {
    sawLandEvent = true;
    applyLanding(num(payload?.impactSpeed, num(payload?.speed, 6)));
  }

  function applyLanding(impactSpeed) {
    if (locked) return;
    const s = clamp01((Math.abs(impactSpeed) - 2.2) / 11);
    if (s <= 0.001) return;
    const k = scale('cameraShake', 1) * api.intensity;
    // Peaks: a 2.6 cm knee-bend off a kerb up to a 12 cm crunch off a roof.
    landDip.impulse(peakImpulse(landDip, -(0.026 + 0.096 * s) * k));
    landPitch.impulse(peakImpulse(landPitch, -(0.010 + 0.036 * s) * k));
    // Off-axis landings roll: you catch yourself on one leg.
    const lat = clamp(localLateral / 8, -1, 1);
    landRoll.impulse(peakImpulse(landRoll, -lat * (0.008 + 0.021 * s) * k));
    if (s > 0.35) shake.add((s - 0.35) * 0.55 * scale('cameraShake', 1));
    // A hard landing re-plants the stride cycle on the next step.
    bobPhase = FOOTFALL_PHASES[0];
  }

  function onFire(payload) {
    if (locked || !api.enabled) return;
    const def = payload?.weapon?.def || payload?.weapon || weaponDef();
    const rec = def?.recoil || def?.kick || null;

    let vert = angleOf(rec?.vertical ?? rec?.pitch ?? rec?.up, 0.0205);
    let horiz = angleOf(rec?.horizontal ?? rec?.yaw ?? rec?.side, 0.0092);
    let backKick = num(rec?.back ?? rec?.kickback, 0.022);
    vert = clamp(Math.abs(vert), 0.002, 0.09);
    horiz = clamp(Math.abs(horiz), 0.0, 0.05);
    backKick = clamp(Math.abs(backKick), 0, 0.12);

    const ads = payload?.ads === true || adsBlend > 0.5;
    const stanceMul = blend.crouch > 0.5 ? 0.82 : 1;
    const adsMul = lerp(1, 0.58, ads ? Math.max(adsBlend, 0.85) : adsBlend);
    const userMul = scale('cameraRecoil', 1) * api.intensity;
    const mul = stanceMul * adsMul * userMul;

    // Sustained fire gets progressively nastier — the reason burst discipline exists.
    burst = Math.min(burst + 1, 24);
    const climbMul = 1 + 0.38 * clamp01(burst / 9);

    const rng = ctx.rng;
    const g = typeof rng?.gauss === 'function' ? clamp(rng.gauss() * 0.5, -1.4, 1.4) : (rng ? rng() * 2 - 1 : 0);
    const jitter = typeof rng === 'function' ? rng() : 0.5;

    const kickPitch = vert * mul * climbMul * (0.82 + 0.36 * jitter);
    const kickYaw = horiz * mul * climbMul * g;
    const kickRoll = horiz * mul * 0.55 * -g;

    // Tuned as peak displacements, converted to the velocity the spring needs.
    recoilRot.impulse(
      peakImpulse(recoilRot.sx, kickPitch),
      peakImpulse(recoilRot.sy, kickYaw),
      peakImpulse(recoilRot.sz, kickRoll)
    );
    recoilPos.impulse(
      peakImpulse(recoilPos.sx, kickYaw * 0.35),
      peakImpulse(recoilPos.sy, backKick * 0.22 * mul),
      peakImpulse(recoilPos.sz, backKick * mul)
    );

    // The partial return: a slice of every shot sticks around as a rest offset that
    // only bleeds off once you stop firing.
    recoilRest.x = clamp(recoilRest.x + kickPitch * 0.32, 0, 0.070);
    recoilRest.y = clamp(recoilRest.y + kickYaw * 0.28, -0.042, 0.042);

    shake.add(0.035 * mul * (ads ? 0.5 : 1));
    timeSinceFire = 0;
  }

  function onExplosion(payload) {
    const p = payload?.point;
    if (!p) {
      shake.add(0.5 * scale('cameraShake', 1));
      return;
    }
    _v.set(num(p.x ?? p[0]), num(p.y ?? p[1]), num(p.z ?? p[2]));
    const radius = Math.max(num(payload?.radius, 6), 0.5);
    const dist = _v.distanceTo(ctx.camera?.position ?? _v2.set(base.px, base.py, base.pz));
    // Shake carries a good deal further than the damage does.
    const reach = Math.max(radius * 3.4, 10);
    const f = clamp01(1 - dist / reach);
    if (f <= 0) return;
    const power = clamp01(num(payload?.damage, 70) / 90);
    shake.add(clamp01(f * f * (0.55 + 0.65 * power)) * scale('cameraShake', 1) * api.intensity);
    // Close blasts also shove the camera bodily away from the blast.
    if (f > 0.45 && dist > 0.05) {
      _v2.set(base.px, base.py, base.pz).sub(_v).normalize();
      const push = (f - 0.45) * 2.4;
      addImpulse({ pos: { x: _v2.x * push, y: 0.35 * push, z: _v2.z * push }, space: 'world' });
    }
  }

  function onDamage(payload) {
    if (!isLocalPlayer(payload?.target)) return;
    const amount = clamp01(num(payload?.amount, 12) / 45);
    shake.add(amount * 0.34 * scale('cameraShake', 1));
    // Punch away from the shooter so you get a directional cue about where it came from.
    const d = payload?.dir;
    if (readVec3(d, _v)) {
      _euler.set(0, base.ry, 0, 'YXZ');
      _quatYaw.setFromEuler(_euler);
      _v2.set(1, 0, 0).applyQuaternion(_quatYaw);
      const side = clamp(_v.x * _v2.x + _v.z * _v2.z, -1, 1);
      extRot.impulse(amount * 1.6, side * amount * 1.1, -side * amount * 2.0);
    } else {
      extRot.impulse(amount * 1.4, 0, 0);
    }
    suppression = clamp01(suppression + amount * 0.5);
  }

  function onSuppress(payload) {
    const a = Number.isFinite(payload) ? payload : num(payload?.amount, 0.35);
    suppression = clamp01(suppression + clamp01(a));
  }

  function addImpulse(o) {
    if (!o || !api.enabled) return api;
    const k = api.intensity;
    const world = o.space === 'world';
    if (o.pos && readVec3(o.pos, _v)) {
      if (world) {
        _euler.set(0, base.ry, 0, 'YXZ');
        _quatYaw.setFromEuler(_euler);
        _v.applyQuaternion(_quatYaw.invert());
      }
      extPos.impulse(_v.x * k, _v.y * k, _v.z * k);
    }
    if (o.rot && readVec3(o.rot, _v)) {
      extRot.impulse(_v.x * k, _v.y * k, _v.z * k);
    }
    if (Number.isFinite(o.trauma)) shake.add(o.trauma * scale('cameraShake', 1) * k);
    return api;
  }

  // ── public API ────────────────────────────────────────────────────────────────
  const api = {
    ready: false,
    enabled: true,
    intensity: 1,
    locked: false,
    addImpulse,
    getViewOffset: () => viewOffset,
    shake: (t) => {
      shake.add(num(t, 0) * scale('cameraShake', 1) * api.intensity);
      return api;
    },
    suppress: onSuppress,
    explosionAt: (point, radius, damage) => onExplosion({ point, radius, damage }),
    setEnabled(v) {
      api.enabled = !!v;
      if (!api.enabled) api.reset();
      return api;
    },
    /** Everything back to rest, no ringing. Used on unlock, teleport and respawn. */
    reset() {
      shake.reset();
      landDip.reset(0);
      landPitch.reset(0);
      landRoll.reset(0);
      recoilRot.reset();
      recoilPos.reset();
      extRot.reset();
      extPos.reset();
      recoilRest.x = recoilRest.y = 0;
      strafeRoll = 0;
      accelPitch = 0;
      suppression = 0;
      fovMotion = 0;
      burst = 0;
      timeSinceFire = 999;
      // Forget the measured cadence: after a pose or a respawn it describes a life the
      // player is no longer living, and a stale interval would drive the bob until the
      // next footstep arrives to correct it.
      timeSinceStep = 999;
      stepInterval = 0;
      bobWeight = 0;
      estVel.set(0, 0, 0);
      offYaw.x = offYaw.y = offYaw.z = 0;
      offView.x = offView.y = offView.z = 0;
      offRot.x = offRot.y = offRot.z = 0;
      viewOffset.pos.set(0, 0, 0);
      viewOffset.rot.set(0, 0, 0);
      lastOut.px = NaN;
      return api;
    },
    // Live read-outs, refreshed every frame.
    ads: 0,
    fov: 60,
    trauma: 0,
    exertion: 0,
    suppression: 0,
    stridePhase: 0,
    strideT: 0,
    speed: 0,
    grounded: true,
    stance: 'idle',
    /** Let the viewmodel drive its own stride-locked animation off ours. */
    footfallPhases: FOOTFALL_PHASES.slice(),
    /** Set false if another system takes over syncing ctx.viewCamera. */
    syncViewCamera: true,
  };

  let localLateral = 0;

  // ── the frame ─────────────────────────────────────────────────────────────────

  function captureBase() {
    const cam = ctx.camera;
    const p = cam.position;
    const r = cam.rotation;
    const untouched =
      p.x === lastOut.px &&
      p.y === lastOut.py &&
      p.z === lastOut.pz &&
      r.x === lastOut.rx &&
      r.y === lastOut.ry &&
      r.z === lastOut.rz;
    if (!untouched) {
      base.px = p.x;
      base.py = p.y;
      base.pz = p.z;
      base.rx = r.x;
      base.ry = r.y;
      base.rz = r.z;
    }
  }

  function sampleMotion(dt) {
    const p = ctx.player;
    if (!readVec3(p?.velocity, velWorld) && !readVec3(p?.vel, velWorld)) {
      // No controller velocity yet: finite-difference the base pose instead.
      if (dt > 1e-5) {
        _v.set(base.px, base.py, base.pz).sub(prevBasePos).divideScalar(dt);
        if (_v.lengthSq() > 900) _v.set(0, 0, 0); // teleport, not movement
        estVel.set(damp(estVel.x, _v.x, 14, dt), damp(estVel.y, _v.y, 14, dt), damp(estVel.z, _v.z, 14, dt));
      }
      velWorld.copy(estVel);
    }
    prevBasePos.set(base.px, base.py, base.pz);

    const speed = Math.hypot(velWorld.x, velWorld.z);
    // Split into the camera's yaw frame: forward/right.
    const sy = Math.sin(base.ry);
    const cy = Math.cos(base.ry);
    const fwd = velWorld.x * -sy + velWorld.z * -cy;
    const right = velWorld.x * cy + velWorld.z * -sy;
    localLateral = right;
    const accelFwd = dt > 1e-5 ? (fwd - prevLocalForward) / dt : 0;
    prevLocalForward = fwd;
    return { speed, fwd, right, accelFwd };
  }

  function updateStance(dt, speed, grounded) {
    const s = stanceString();
    const pl = ctx.player;
    const boolSprint = pl?.sprinting ?? pl?.isSprinting;
    const boolCrouch = pl?.crouching ?? pl?.isCrouching;
    const prone = /prone/.test(s) || pl?.prone === true;
    let sprint = typeof boolSprint === 'boolean' ? boolSprint : /sprint|run/.test(s);
    let crouch = typeof boolCrouch === 'boolean' ? boolCrouch : /crouch|slide/.test(s) || prone;
    // A stubbed controller reports nothing: infer from speed so the rig still lives.
    if (!sprint && !crouch && speed > 6.2) sprint = true;

    const moving = speed > 0.35;
    const tSprint = sprint && moving && grounded ? 1 : 0;
    const tCrouch = crouch && grounded ? 1 : 0;
    const tWalk = !tSprint && !tCrouch && grounded ? 1 : 0;
    blend.sprint = damp(blend.sprint, tSprint, 9, dt);
    blend.crouch = damp(blend.crouch, tCrouch, 11, dt);
    blend.walk = damp(blend.walk, tWalk, 9, dt);
    blend.air = damp(blend.air, grounded ? 0 : 1, 12, dt);

    api.stance = !grounded ? 'air' : tCrouch ? 'crouch' : tSprint ? 'sprint' : moving ? 'walk' : 'idle';
    return { prone };
  }

  function mixStance(field) {
    const w = blend.walk + blend.sprint + blend.crouch;
    if (w < 1e-4) return STANCES.walk[field];
    return (
      (STANCES.walk[field] * blend.walk +
        STANCES.sprint[field] * blend.sprint +
        STANCES.crouch[field] * blend.crouch) /
      w
    );
  }

  function updateBob(dt, speed, grounded, prone, adsE) {
    const cycle = Math.max(0.4, mixStance('cycle'));
    const ref = Math.max(1, mixStance('ref'));

    timeSinceStep += dt;
    // Cadence: prefer the controller's measured footstep rate (half a cycle per step);
    // fall back to distance-driven when it isn't reporting steps. Both are dt-independent.
    const cadenceLive = sawStepEvent && stepInterval > 0.07 && timeSinceStep < 1.1;
    if (grounded && (cadenceLive || speed > 0.2)) {
      const rate = cadenceLive ? Math.PI / stepInterval : (TAU * speed) / cycle;
      bobPhase = (bobPhase + rate * dt) % TAU;
    } else if (!grounded) {
      // Coast the phase toward the next plant so the landing lines up.
      bobPhase = (bobPhase + TAU * 0.25 * dt) % TAU;
    }

    // Amplitude: ramps in from a standstill, saturates a little above the reference
    // speed, dies in the air, and is heavily suppressed while aiming.
    const speedW = smoothstep(0.25, 1.35, speed) * clamp(speed / ref, 0, 1.25);
    const target =
      speedW * (1 - blend.air * 0.92) * lerp(1, 0.30, adsE) * (prone ? 0.45 : 1);
    bobWeight = damp(bobWeight, target, 10, dt);

    const amp = bobWeight * scale('cameraBob', 1) * api.intensity;
    if (amp < 1e-5) {
      viewOffset.bob.x = viewOffset.bob.y = 0;
      viewOffset.bob.weight = 0;
      viewOffset.bob.phase = bobPhase;
      return;
    }

    const s1 = Math.sin(bobPhase);
    const s2 = Math.sin(bobPhase * 2);
    const c1 = Math.cos(bobPhase);

    // Figure-eight in the camera's local XY plane: x = sin p, y = sin 2p.
    const bx = mixStance('posX') * amp * s1;
    const by = mixStance('posY') * amp * s2;
    const bz = mixStance('posZ') * amp * c1;
    offYaw.x += bx;
    offYaw.y += by;
    offYaw.z += bz;

    // Roll leans into the sway; pitch counter-nods so the horizon stays readable.
    offRot.z += -mixStance('roll') * amp * s1;
    offRot.x += -mixStance('pitch') * amp * s2 * 0.5;
    offRot.y += mixStance('yaw') * amp * Math.sin(bobPhase + 0.55);

    viewOffset.bob.x = bx;
    viewOffset.bob.y = by;
    viewOffset.bob.weight = bobWeight;
    viewOffset.bob.phase = bobPhase;
    viewOffset.bob.stride = bobPhase / TAU;

    // Announce the visual footfall (only when the controller isn't already doing it).
    const idx = bobPhase < Math.PI ? 0 : 1;
    if (idx !== prevFootIndex) {
      prevFootIndex = idx;
      if (!sawStepEvent && bobWeight > 0.25) {
        ctx.bus?.emit?.('camera:footfall', { phase: bobPhase, stance: api.stance, speed });
      }
    }
  }

  function updateBreath(dt, speed, adsE, health) {
    // Winded from sprinting, and never fully recovered while you keep running.
    const sprinting = blend.sprint > 0.5 && speed > 3;
    exertion = clamp01(exertion + (sprinting ? 0.42 : -0.20) * dt);

    const hurt = 1 - health;
    const rate = 0.22 + 0.30 * exertion + 0.14 * hurt;
    sway.update(dt, rate);

    // Bob drowns breathing out; ADS is where you actually notice it.
    const mask = (1 - clamp01(bobWeight * 0.85)) * scale('cameraSway', 1) * api.intensity;
    const amp = (0.0016 + 0.0040 * adsE) * (1 + 1.5 * exertion + 1.1 * hurt) * mask;
    if (amp < 1e-6) {
      viewOffset.breath = sway.breath;
      return;
    }
    offRot.y += sway.x * amp;
    offRot.x += sway.y * amp * 0.75;
    offRot.z += sway.x * amp * 0.35;
    // Chest rise: tiny, but it is what stops a standing-still camera reading as a photo.
    offYaw.y += (sway.breath - 0.5) * 0.0035 * (1 + 0.8 * exertion) * mask;
    offYaw.x += sway.x * 0.0022 * mask;
    viewOffset.breath = sway.breath;
  }

  function updateAds(dt) {
    const { value, numeric } = readAdsTarget();
    if (numeric) {
      // The weapon owns the blend; follow it closely so sights and FOV agree.
      adsBlend = damp(adsBlend, value, 30, dt);
    } else {
      const def = weaponDef();
      const inT = clamp(num(def?.adsTime ?? def?.adsInTime, 0.20), 0.05, 0.9);
      const outT = clamp(num(def?.adsOutTime, inT * 0.72), 0.04, 0.9);
      adsBlend = easeTowards(adsBlend, value, value > adsBlend ? inT : outT, dt, 0.6);
    }
    return clamp01(adsBlend);
  }

  function updateRecoil(dt, adsE) {
    timeSinceFire += dt;
    if (timeSinceFire > 0.42) burst = Math.max(0, burst - dt * 14);
    // Hold the climb through the burst, then bleed it off.
    if (timeSinceFire > 0.11) {
      recoilRest.x = damp(recoilRest.x, 0, 2.3, dt);
      recoilRest.y = damp(recoilRest.y, 0, 1.9, dt);
    }
    recoilRot.setTarget(recoilRest.x, recoilRest.y, 0);
    recoilRot.update(dt);
    recoilPos.update(dt);

    // Aiming plants the gun in your shoulder: less of everything reaches the eye.
    const vis = lerp(1, 0.62, adsE);
    offRot.x += recoilRot.x * vis;
    offRot.y += recoilRot.y * vis;
    offRot.z += recoilRot.z * vis;
    offView.x += recoilPos.x * vis;
    offView.y += recoilPos.y * vis;
    offView.z += recoilPos.z * vis;

    viewOffset.recoil.pitch = recoilRot.x;
    viewOffset.recoil.yaw = recoilRot.y;
    viewOffset.recoil.roll = recoilRot.z;
    viewOffset.recoil.back = recoilPos.z;
    viewOffset.recoil.climb = recoilRest.x;
  }

  function updateFov(dt, speed, adsE) {
    const cam = ctx.camera;
    const settingFov = num(ctx.settings?.get?.('fov'), fovBase);
    if (settingFov > 20 && settingFov < 170) fovBase = settingFov;

    const fx = scale('cameraFovEffects', 1);
    // Sprint widening plus a gentler speed term, damped so it can never snap.
    const wide = (blend.sprint * 7.5 + clamp01(speed / 7.5) * 2.6) * fx * api.intensity;
    fovMotion = damp(fovMotion, wide, 6.5, dt);

    const adsMul = lerp(1, adsFovScaleOf(weaponDef()), adsE);
    const punch = (shake.intensity * 1.6 - suppression * 1.4) * fx;
    const target = clamp((fovBase + fovMotion) * adsMul + punch, 15, 165);

    if (Math.abs(target - fovApplied) > 0.0015) {
      cam.fov = target;
      cam.updateProjectionMatrix();
      fovApplied = target;
    }
    return target;
  }

  function compose() {
    const cam = ctx.camera;
    _euler.set(0, base.ry, 0, 'YXZ');
    _quatYaw.setFromEuler(_euler);
    _euler.set(base.rx, base.ry, base.rz, 'YXZ');
    _quatView.setFromEuler(_euler);

    _v.set(offYaw.x, offYaw.y, offYaw.z).applyQuaternion(_quatYaw);
    _v2.set(offView.x, offView.y, offView.z).applyQuaternion(_quatView);
    _v.add(_v2);

    // Clamp so a pathological impulse can never fling the camera through a wall.
    const maxT = 0.55;
    if (_v.lengthSq() > maxT * maxT) _v.setLength(maxT);

    const rx = clamp(base.rx + offRot.x, -Math.PI / 2 + 0.012, Math.PI / 2 - 0.012);
    const ry = base.ry + offRot.y;
    const rz = base.rz + clamp(offRot.z, -0.5, 0.5);

    if (!finite3(_v.x, _v.y, _v.z) || !finite3(rx, ry, rz)) {
      api.reset();
      return;
    }

    cam.position.set(base.px + _v.x, base.py + _v.y, base.pz + _v.z);
    cam.rotation.set(rx, ry, rz);

    lastOut.px = cam.position.x;
    lastOut.py = cam.position.y;
    lastOut.pz = cam.position.z;
    lastOut.rx = cam.rotation.x;
    lastOut.ry = cam.rotation.y;
    lastOut.rz = cam.rotation.z;

    // Publish in camera-local metres/radians so the viewmodel can counter-animate.
    viewOffset.pos.set(offYaw.x + offView.x, offYaw.y + offView.y, offYaw.z + offView.z);
    viewOffset.rot.set(offRot.x, offRot.y, offRot.z);
  }

  function syncViewCamera() {
    if (!api.syncViewCamera) return;
    const vc = ctx.viewCamera;
    const cam = ctx.camera;
    if (!vc || !cam) return;
    vc.position.copy(cam.position);
    vc.rotation.copy(cam.rotation);
    vc.updateMatrixWorld();
  }

  function zeroPublished() {
    viewOffset.pos.set(0, 0, 0);
    viewOffset.rot.set(0, 0, 0);
    viewOffset.bob.x = viewOffset.bob.y = viewOffset.bob.weight = 0;
    viewOffset.recoil.pitch = viewOffset.recoil.yaw = viewOffset.recoil.roll = 0;
    viewOffset.recoil.back = viewOffset.recoil.climb = 0;
    viewOffset.shake.trauma = viewOffset.shake.intensity = 0;
    viewOffset.ads = adsBlend;
    viewOffset.fov = ctx.camera?.fov ?? fovBase;
  }

  return {
    name: 'cameraRig',
    order: 62,

    async init() {
      ctx.cameraRig = api;
      fovBase = num(ctx.settings?.get?.('fov'), 90);
      const cam = ctx.camera;
      if (cam) {
        base.px = cam.position.x;
        base.py = cam.position.y;
        base.pz = cam.position.z;
        base.rx = cam.rotation.x;
        base.ry = cam.rotation.y;
        base.rz = cam.rotation.z;
        prevBasePos.copy(cam.position);
        fovApplied = cam.fov;
      }
      locked = ctx.debug?.cameraLocked === true;
      api.locked = locked;

      on('player:land', onLand);
      on('player:step', lockPhaseToFootstep);
      on('player:jump', () => {
        bobPhase = FOOTFALL_PHASES[1];
      });
      on('player:state', ({ to } = {}) => {
        if (typeof to === 'string' && /spawn|teleport|respawn/.test(to)) api.reset();
      });
      on('player:respawn', () => api.reset());
      on('weapon:fire', onFire);
      on('weapon:equip', () => {
        burst = 0;
        recoilRest.x = recoilRest.y = 0;
      });
      on('explosion', onExplosion);
      on('entity:damage', onDamage);
      on('suppression', onSuppress);
      on('player:suppressed', onSuppress);
      on('debug:cameraLock', ({ locked: l } = {}) => {
        locked = !!l;
        api.locked = locked;
        if (locked) {
          zeroPublished();
        } else {
          // Coming out of a pose: nothing should linger from before it.
          api.reset();
          fovApplied = ctx.camera?.fov ?? fovApplied;
          if (ctx.camera) {
            base.px = ctx.camera.position.x;
            base.py = ctx.camera.position.y;
            base.pz = ctx.camera.position.z;
            base.rx = ctx.camera.rotation.x;
            base.ry = ctx.camera.rotation.y;
            base.rz = ctx.camera.rotation.z;
            prevBasePos.copy(ctx.camera.position);
          }
        }
      });
      on('setting:changed', ({ key, value } = {}) => {
        if (key === 'fov' && Number.isFinite(value)) fovBase = value;
      });
      on('quality:changed', () => {
        // Nothing here is quality-dependent, but the pose harness leans on a clean slate.
        fovApplied = -1;
      });

      api.ready = true;
      started = true;
    },

    lateUpdate(dt) {
      if (!started) return;
      const cam = ctx.camera;
      if (!cam) return;
      // The harness owns the camera during a pose: contribute exactly nothing so the
      // screenshot transform is the one that was asked for, to the bit.
      if (locked || ctx.debug?.cameraLocked === true) {
        zeroPublished();
        syncViewCamera();
        return;
      }

      const step = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 1 / 60;

      captureBase();

      if (!api.enabled || api.intensity <= 0) {
        prevBasePos.set(base.px, base.py, base.pz);
        zeroPublished();
        syncViewCamera();
        return;
      }

      offYaw.x = offYaw.y = offYaw.z = 0;
      offView.x = offView.y = offView.z = 0;
      offRot.x = offRot.y = offRot.z = 0;

      const m = sampleMotion(step);
      const pl = ctx.player;
      const g = pl?.grounded ?? pl?.onGround ?? pl?.isGrounded ?? pl?.onFloor;
      const st = stanceString();
      const grounded = typeof g === 'boolean' ? g : !/air|jump|fall|falling/.test(st);
      const { prone } = updateStance(step, m.speed, grounded);

      // Fallback landing detection for a controller that doesn't emit `player:land`.
      if (!sawLandEvent && grounded && !prevGrounded) applyLanding(Math.abs(velWorld.y));
      prevGrounded = grounded;

      const adsE = updateAds(step);
      const health = healthFraction();

      // 1 — view bob
      updateBob(step, m.speed, grounded, prone, adsE);

      // 2 — landing impact
      landDip.update(step);
      landPitch.update(step);
      landRoll.update(step);
      offYaw.y += landDip.value;
      offRot.x += landPitch.value;
      offRot.z += landRoll.value;

      // 3 — strafe tilt / acceleration lean
      const tilt = scale('cameraTilt', 1) * api.intensity;
      const refSpeed = Math.max(2, mixStance('ref'));
      const targetRoll = -clamp(m.right / refSpeed, -1, 1) * 0.0335 * lerp(1, 0.4, adsE) * tilt;
      strafeRoll = damp(strafeRoll, targetRoll, 7.5, step);
      const targetPitch = -clamp(m.accelFwd / 26, -1, 1) * 0.0090 * lerp(1, 0.45, adsE) * tilt;
      accelPitch = damp(accelPitch, targetPitch, 6, step);
      offRot.z += strafeRoll;
      offRot.x += accelPitch;
      // Lateral drag: the body trails the strafe by a couple of centimetres.
      offYaw.x += -clamp(m.right / refSpeed, -1, 1) * 0.012 * tilt * lerp(1, 0.4, adsE);

      // 4 — recoil
      updateRecoil(step, adsE);

      // 5 — trauma shake + suppression jitter
      shake.update(step);
      const sMul = scale('cameraShake', 1) * api.intensity;
      offYaw.x += shake.pos.x * sMul;
      offYaw.y += shake.pos.y * sMul;
      offYaw.z += shake.pos.z * sMul;
      offRot.x += shake.rot.x * sMul;
      offRot.y += shake.rot.y * sMul;
      offRot.z += shake.rot.z * sMul;

      suppression = damp(suppression, 0, 0.85, step);
      if (suppression > 0.002) {
        const t = (ctx.time?.elapsed ?? 0) * 8.5;
        const a = suppression * suppression * 0.010 * sMul;
        offRot.x += noise.shaped(t + 211.3) * a;
        offRot.y += noise.shaped(t * 1.11 + 307.7) * a * 0.8;
        offRot.z += noise.shaped(t * 0.93 + 401.9) * a * 1.4;
      }

      // 6 — breathing
      updateBreath(step, m.speed, adsE, health);

      // 7 — ADS pull-forward (full view frame — it follows the muzzle, not the horizon)
      offView.z -= adsE * 0.032;
      offView.y -= adsE * 0.004;

      // external impulses
      extRot.update(step);
      extPos.update(step);
      offRot.x += extRot.x;
      offRot.y += extRot.y;
      offRot.z += extRot.z;
      offYaw.x += extPos.x;
      offYaw.y += extPos.y;
      offYaw.z += extPos.z;

      compose();

      // 8 — FOV
      const fov = updateFov(step, m.speed, adsE);

      syncViewCamera();

      // read-outs
      viewOffset.shake.trauma = shake.trauma;
      viewOffset.shake.intensity = shake.intensity;
      viewOffset.ads = adsE;
      viewOffset.fov = fov;
      viewOffset.speed = m.speed;
      viewOffset.lateral = m.right;
      viewOffset.grounded = grounded;
      viewOffset.stance = api.stance;
      viewOffset.exertion = exertion;
      viewOffset.suppression = suppression;
      api.ads = adsE;
      api.fov = fov;
      api.trauma = shake.trauma;
      api.exertion = exertion;
      api.suppression = suppression;
      api.stridePhase = bobPhase;
      api.strideT = bobPhase / TAU;
      api.speed = m.speed;
      api.grounded = grounded;
    },

    dispose() {
      for (const un of subs) {
        try {
          un();
        } catch {
          /* teardown is best-effort */
        }
      }
      subs.length = 0;
      started = false;
      if (ctx.cameraRig === api) ctx.cameraRig = null;
    },
  };
}
