/**
 * Controller.js — first-person movement controller. Owner: movement agent.
 * Publishes: `ctx.player`
 *
 * A capsule character controller tuned for Call-of-Duty feel: acceleration curves
 * rather than instant velocity, a real state machine (./MoveState.js), momentum
 * sliding, ledge mantling with root-motion timing, coyote time and jump buffering,
 * and wall-aware leaning.
 *
 * ── Public API (ctx.player) ────────────────────────────────────────────────────
 *   position        THREE.Vector3   feet position, world space (live, do not mutate)
 *   velocity        THREE.Vector3   metres/second (live)
 *   eyePosition     THREE.Vector3   camera pivot = position + eyeHeight + lean offset
 *   eyeHeight       number          current smoothed eye height above the feet
 *   state           string          one of MoveState.STATE
 *   previousState   string
 *   stance          'stand'|'crouch'|'prone'
 *   isGrounded      boolean
 *   groundNormal    THREE.Vector3
 *   groundSurface   string          ARCHITECTURE §5 surface tag under the feet
 *   speed           number          horizontal speed
 *   yaw, pitch      number          radians; pitch clamped to ±89°
 *   lean            number          -1..1 after wall clamping
 *   radius, height  number          collision capsule
 *   canFire         boolean         false during sprint / mantle
 *   weaponLower     0..1            how far the viewmodel should be lowered
 *   tacSprintCharge 0..1            stamina for tactical sprint (HUD)
 *   speedScale      number          writable multiplier (ADS, wounded, …)
 *   body            physics Body|null  kinematic trigger capsule in GROUP.PLAYER,
 *                                      `body.entity === ctx.player`, so AI/ballistics
 *                                      can hit the player and shooters can exclude it
 *   forward(out) / right(out) -> THREE.Vector3
 *   teleport(pos, yaw, pitch, opts)   pos is the EYE position (harness contract);
 *                                     pass {feet:true} to place the feet instead
 *   setStance(name) / addImpulse(v) / suspend(bool) / respawn(spawn?)
 *
 * ── Events emitted ─────────────────────────────────────────────────────────────
 *   player:step   {surface, speed, foot, position, volume, footstep, def}
 *   player:land   {impactSpeed, hard, surface, position}
 *   player:state  {from, to}
 *   player:jump   {state, speed}            (additive, documented here)
 *   player:mantle {kind, height, duration}  (additive)
 *   player:slide  {phase:'start'|'end', speed}  (additive)
 * ── Events consumed ────────────────────────────────────────────────────────────
 *   debug:cameraLock {locked}   suspends camera authorship + simulation for poses
 *   debug:pose       {stance, lean, sprint, …}
 *
 * ── Camera contract (for CameraRig, order 62) ──────────────────────────────────
 * This system writes the *base* pose to `ctx.camera` in update(): eye position
 * (feet + smoothed eye height + landing dip + step smoothing + lean offset) and
 * rotation (pitch, yaw, lean roll, YXZ). CameraRig runs after us and should add its
 * bob / sway / recoil / shake on top — additively, so the base stays authoritative.
 * If a rig wants full authority instead, set `ctx.player.ownCamera = false` and read
 * `eyePosition`, `yaw`, `pitch` and `roll` off this API; we then touch nothing.
 * While `debug:cameraLock` is active nobody may drive the camera — we mirror it.
 *
 * ── Why the collision here is discrete, not swept ──────────────────────────────
 * `ctx.physics.sweepCapsule()` is GJK conservative advancement, and it is not usable
 * as a character controller's primary test in this world:
 *   • `Shapes.supportLocal()` returns the origin for TRIMESH and HEIGHTFIELD, so a
 *     sweep against the terrain heightfield degenerates into "sweep against a single
 *     point at the patch centre" and reports a bogus t=0 hit with a downward normal
 *     whenever the capsule contains that point — a hard stick at every patch centre;
 *   • near a box edge the unconverged GJK simplex over-estimates separation (41 mm
 *     reported where the true gap is 8 mm), so the sweep misses the contact and the
 *     player walks through a 0.3 m kerb;
 *   • at exactly-touching separation it reports penetration with a (0,-1,0) normal,
 *     which freezes anyone sliding along a wall.
 * So movement uses:
 *   • `Shapes.collide()` — the engine's real narrowphase, exact for every shape
 *     including meshes — for contact resolution, moved in sub-radius chunks so
 *     nothing thinner than the capsule can be tunnelled through;
 *   • `ctx.physics.raycast()` — exact for every shape — for the floor and ceiling.
 * Everything else (surfaces, materials, groups, bodies) goes through the public API.
 */
import * as THREE from 'three';
import * as Shapes from '../physics/Shapes.js';
import {
  MoveStateMachine,
  STATE,
  STANCE,
  defOf,
  RADIUS,
  HEIGHT_STAND,
  HEIGHT_CROUCH,
  EYE_STAND,
  EYE_CROUCH,
  EYE_PRONE,
} from './MoveState.js';

/* ══════════════════════════════════════════════════════════════ tuning ══ */

const DEG = Math.PI / 180;

/** Shooter gravity, not earth gravity. -9.81 makes every jump feel like the moon. */
const GRAVITY = 18.0;
/** sqrt(2 * 18 * 0.89) — a ~0.89 m apex, which is the CoD silhouette. */
const JUMP_SPEED = 5.66;
const TERMINAL_SPEED = 58;

const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.15;
const JUMP_LOCKOUT = 0.09;

const SLOPE_LIMIT = 46 * DEG;
const SLOPE_COS = Math.cos(SLOPE_LIMIT);
const STEP_HEIGHT = 0.3;
/** View smoothing for the vertical teleports a step-up or a kerb produces. */
const STEP_SMOOTH_MAX = 0.20;
const STEP_SMOOTH_RATE = 20;
const STEP_SMOOTH_BLEED = 1.9;
const GROUND_OFFSET = 0.012;
const GROUND_PROBE = 0.07;
const SNAP_DIST = 0.34;

const MAX_SUBSTEP = 0.0125;
const MAX_SUBSTEPS = 5;

/** Strafing is slightly slower than forward, backpedalling slower still. */
const STRAFE_SCALE = 0.885;
const BACK_SCALE = 0.76;

const ACCEL_LOW_BOOST = 0.95; // extra acceleration at a standstill (curve, not a step)
const ACCEL_HIGH_TAPER = 0.42; // acceleration retained at top speed
const STOP_SPEED = 1.35;
const FRICTION_RAMP_TIME = 0.14;
const FRICTION_RAMP_MIN = 0.42;

const AIR_ACCEL = 7.6;
const AIR_WISH_CLAMP = 4.6;
const AIR_SPEED_MARGIN = 1.03;

const LEAN_DIST = 0.34;
const LEAN_ROLL = 12.5 * DEG;
const LEAN_RATE = 8.0;
const LEAN_HEAD_R = 0.22;

const PITCH_LIMIT = 89 * DEG;

const SLIDE_MIN_SPEED = 4.15;
const SLIDE_ENTER_MIN = 6.7;
const SLIDE_ENTER_MAX = 9.4;
const SLIDE_BOOST = 1.16;
const SLIDE_END_SPEED = 2.7;
const SLIDE_COOLDOWN = 0.9;
const SLIDE_STEER = 1.5; // rad/s — weak on purpose
const SLIDE_JUMP_RETAIN = 0.92;
const SLIDE_MIN_TIME = 0.14;
/** Constant deceleration + a drag term: a slide should last ~1 s, not ~0.4 s. */
const SLIDE_DECEL = 2.2;
const PRONE_EXIT_TIME = 0.35;

const TAC_SPRINT_TIME = 3.6;
const TAC_SPRINT_RECHARGE = 5.2;
const TAC_SPRINT_MIN_CHARGE = 0.34;
const DOUBLE_TAP_TIME = 0.3;

const LEDGE_MIN = 0.28;
const LEDGE_MAX = 2.32;
const VAULT_MAX = 0.62;
const MANTLE_MAX = 1.55;
const MANTLE_COOLDOWN = 0.22;
/** Landing-spot search distances past the near face, nearest acceptable wins. */
const VAULT_OUTS = [0.62, 1.02, 1.44, 0.26];
const MANTLE_OUTS = [0.26, 0.54];
/** Re-probing for a ledge every substep while pressed against a wall is wasteful. */
const LEDGE_PROBE_INTERVAL = 0.11;

/** WORLD | PROP — static props block, dynamic ones are filtered out per body. */
const MASK_SOLID = 1 | 8;

/* ══════════════════════════════════════════════════════════ scratch ══ */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _hz = new THREE.Vector3();
const _tmpClip = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _flatPos = new THREE.Vector3();
const _flatVel = new THREE.Vector3();
const _stepPos = new THREE.Vector3();
const _probeP = new THREE.Vector3();
const _prevPos = new THREE.Vector3();
const _push = new THREE.Vector3();
const _stepMove = new THREE.Vector3();
const _identQ = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

const _planes = [
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
];

/**
 * 5-point ground/ceiling probe footprint, in units of the capsule radius.
 * The outer points sit at 0.9R, not something timid like 0.68R: after a step-up the
 * capsule is directly over the step's lip, and a narrow footprint would miss it and
 * snap the player straight back down — a livelock at the bottom of every staircase.
 * This is safe because the contact resolver never lets the capsule rest closer than
 * a full radius to a wall face, so 0.9R can only ever see geometry below the feet.
 */
const PROBE_PTS = [
  [0, 0],
  [0.9, 0],
  [-0.9, 0],
  [0, 0.9],
  [0, -0.9],
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

function forwardOf(yaw, out) {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}
function rightOf(yaw, out) {
  return out.set(Math.cos(yaw), 0, -Math.sin(yaw));
}

/* ══════════════════════════════════════════════════════════ system ══ */

export default function createController(ctx) {
  /* ---- simulation state ------------------------------------------------- */
  const position = new THREE.Vector3(0, 1, 0);
  const velocity = new THREE.Vector3();
  const eyePosition = new THREE.Vector3(0, EYE_STAND, 0);
  const groundNormal = new THREE.Vector3(0, 1, 0);
  const leanOffset = new THREE.Vector3();
  const safePos = new THREE.Vector3(0, 1, 0);

  let yaw = 0;
  let pitch = 0;
  let roll = 0;

  let grounded = false;
  let groundSurface = 'concrete';
  let groundBody = null;
  let lastAirVy = 0;

  let capsuleHeight = HEIGHT_STAND;
  let eyeHeight = EYE_STAND;
  let dip = 0;
  let dipVel = 0;

  let leanRaw = 0;
  let leanClamped = 0;

  let coyote = 0;
  let jumpBuffer = 0;
  let jumpLockout = 0;
  let airSpeedCap = 6.5;
  let noInputTime = 0;
  let landPenalty = 0;
  let mantleCooldown = 0;
  let ledgeProbeWait = 0;
  let slideCooldown = 0;
  let strideAccum = 0;
  let stepFoot = 0;
  let stepSmooth = 0;

  let tacCharge = 1;
  let tacActive = false;
  let lastSprintTap = -10;
  let lastForwardTap = -10;
  let proneToggle = false;

  let wallContact = false;
  let approachSpeed = 0;
  const wallNormal = new THREE.Vector3();

  let camLocked = false;
  let suspended = false;
  let disposed = false;
  let warnBudget = 6;
  let placed = false;

  const mantle = {
    active: false,
    kind: STATE.VAULT,
    t: 0,
    dur: 0.35,
    height: 0,
    exitSpeed: 2,
    start: new THREE.Vector3(),
    end: new THREE.Vector3(),
  };

  const intent = {
    x: 0,
    z: 0,
    has: false,
    jumpHeld: false,
    jumpPressed: false,
    crouchHeld: false,
    crouchPressed: false,
    pronePressed: false,
    sprintHeld: false,
    usePressed: false,
    leanL: false,
    leanR: false,
    ads: false,
  };

  const unsubs = [];
  let playerBody = null;

  /* ---- reusable physics hit records (raycast(…, out) never allocates) ---- */
  const makeHit = () => ({
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    body: null,
    surface: 'concrete',
    material: null,
    faceIndex: -1,
    entity: null,
    fraction: 0,
  });
  const hits = [makeHit(), makeHit(), makeHit(), makeHit(), makeHit(), makeHit()];
  const hitA = makeHit();
  const hitB = makeHit();
  const hitC = makeHit();
  const hitLean = makeHit();

  /* ---- collision shapes ------------------------------------------------- */
  const shapeCache = new Map();
  function capShape(radius, height) {
    const hh = Math.max(0, height * 0.5 - radius);
    const key = (Math.round(radius * 1000) << 12) ^ Math.round(hh * 1000);
    let s = shapeCache.get(key);
    if (!s) {
      s = Shapes.capsule(radius, hh);
      shapeCache.set(key, s);
    }
    return s;
  }
  const manifold = new Shapes.Manifold();
  const _cMin = new THREE.Vector3();
  const _cMax = new THREE.Vector3();
  const _cCentre = new THREE.Vector3();
  const _chunk = new THREE.Vector3();

  const bp = () => ctx.physics?.world?.broadphase || null;

  /** Movement must not be blocked by triggers, dynamics, or our own capsule. */
  function solidBody(b) {
    if (!b || b.isTrigger) return false;
    if (b === playerBody || b.entity === api) return false;
    if ((b.group & MASK_SOLID) === 0) return false;
    if (!b.isStatic && b.invMass > 0) return false; // dynamic props get pushed, not walked into
    return true;
  }

  /*
   * Contact resolution.
   *
   * `Shapes.collide()` is the engine's real narrowphase (SAT/clipping for convex
   * pairs, a proper BVH walk for meshes) and it is accurate. `Shapes.sweepConvex()`
   * is GJK conservative advancement, and near a box edge its unconverged simplex
   * over-estimates the separation badly enough to miss the contact entirely — it
   * reports 41 mm of clearance where the true gap is 8 mm, so a swept controller
   * walks straight through a 0.3 m kerb. So: move discretely in sub-radius chunks
   * (which cannot tunnel) and resolve with real manifolds.
   */
  let planeCount = 0;
  let contactWall = false;
  let contactGround = false;
  let contactCeiling = false;
  const contactNormal = new THREE.Vector3(0, 1, 0);

  function addPlane(nx, ny, nz) {
    for (let i = 0; i < planeCount; i++) {
      const p = _planes[i];
      if (p.x * nx + p.y * ny + p.z * nz > 0.985) return;
    }
    if (planeCount < _planes.length) _planes[planeCount++].set(nx, ny, nz);
  }

  /**
   * Push the capsule out of every overlap and record the contact planes.
   * Walkable-ground contacts are recorded but not pushed: the ray-based ground
   * probe owns vertical placement, and two systems moving the capsule up at once
   * is exactly how you get a jittering player.
   * @returns {number} contacts resolved
   */
  function resolveContacts(pos, radius, height, vel, iterations = 3) {
    const broad = bp();
    planeCount = 0;
    contactWall = false;
    contactGround = false;
    contactCeiling = false;
    if (!broad?.queryAABB) return 0;
    const cap = capShape(radius, height);
    const hh = Math.max(0, height * 0.5 - radius);
    let total = 0;
    for (let iter = 0; iter < iterations; iter++) {
      _cCentre.set(pos.x, pos.y + height * 0.5, pos.z);
      Shapes.computeAABB(cap, _cCentre, _identQ, _cMin, _cMax);
      _push.set(0, 0, 0);
      let n = 0;
      broad.queryAABB(_cMin.x, _cMin.y, _cMin.z, _cMax.x, _cMax.y, _cMax.z, (body) => {
        if (!solidBody(body)) return;
        manifold.reset();
        if (
          !Shapes.collide(cap, _cCentre, _identQ, body.shape, body.position, body.quaternion, manifold)
        ) {
          return;
        }
        if (manifold.count === 0) return;
        let di = 0;
        let depth = manifold.depth[0];
        for (let i = 1; i < manifold.count; i++) {
          if (manifold.depth[i] > depth) {
            depth = manifold.depth[i];
            di = i;
          }
        }
        let nx = manifold.nx;
        let ny = manifold.ny;
        let nz = manifold.nz;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(nl > 1e-6)) return;
        nx /= nl;
        ny /= nl;
        nz /= nl;
        // The manifold normal's orientation is an internal convention; derive the
        // outward sign from the geometry rather than trusting it.
        const ay = clamp(manifold.py[di], _cCentre.y - hh, _cCentre.y + hh);
        const vx = _cCentre.x - manifold.px[di];
        const vy = ay - manifold.py[di];
        const vz = _cCentre.z - manifold.pz[di];
        if (vx * nx + vy * ny + vz * nz < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        addPlane(nx, ny, nz);
        if (ny >= SLOPE_COS) {
          contactGround = true;
          return; // vertical placement belongs to the ground probe
        }
        if (ny <= -SLOPE_COS) {
          /*
           * A ceiling. Never push down on one: standing up inside a low overhang
           * would drive the capsule straight through the floor and out of the
           * world. Flag it instead — the stance logic compresses us to a crouch,
           * and moveVertical's head-check stops us jumping into it.
           */
          contactCeiling = true;
          return;
        }
        // Near-vertical: a wall. Flag it even at zero depth — once the resolver has
        // scrubbed your velocity you stop penetrating measurably, and a depth-gated
        // flag goes quiet exactly when step-up and auto-vault need to know you are
        // stuck against something.
        contactWall = true;
        contactNormal.set(nx, ny, nz);
        // Exactly-touching contacts report ~0 depth. Pushing those apart would make
        // the player creep away from every wall they lean on.
        if (depth < 6e-4) return;
        n++;
        const d = Math.min(depth, 0.5);
        _push.x += nx * d;
        _push.y += ny * d;
        _push.z += nz * d;
      });
      total += n;
      if (!n) break;
      const pl = _push.length();
      if (pl < 1e-5) break;
      if (pl > 0.5) _push.multiplyScalar(0.5 / pl);
      // Belt and braces: contact resolution may never sink the player.
      if (_push.y < -0.05) _push.y = -0.05;
      pos.add(_push);
    }
    if (vel && planeCount) clipToPlanes(vel, planeCount);
    return total;
  }

  /**
   * Advance `pos` by `delta`, resolving contacts as we go. The move is split into
   * sub-radius chunks so nothing thinner than the capsule can be tunnelled through,
   * and the residual is clipped against the contact planes so we slide along walls
   * and creases instead of stopping dead.
   * @returns {boolean} true when a wall (not a walkable slope) was contacted
   */
  function moveAndResolve(pos, delta, radius, height, vel) {
    const len = delta.length();
    if (len < 1e-7) {
      resolveContacts(pos, radius, height, vel);
      return contactWall;
    }
    const chunks = Math.min(8, Math.max(1, Math.ceil(len / (radius * 0.5))));
    _chunk.copy(delta).multiplyScalar(1 / chunks);
    let wall = false;
    let ceiling = false;
    let ground = false;
    for (let i = 0; i < chunks; i++) {
      pos.add(_chunk);
      resolveContacts(pos, radius, height, vel);
      if (contactWall) {
        wall = true;
        wallNormal.copy(contactNormal);
      }
      if (contactCeiling) ceiling = true;
      if (contactGround) ground = true;
      if (planeCount && i + 1 < chunks) clipToPlanes(_chunk, planeCount);
    }
    // Report the flags for the whole move, not just the last chunk.
    contactCeiling = ceiling;
    contactGround = ground;
    contactWall = wall;
    return wall;
  }

  /* ---- ray probes (exact for every shape, including the terrain) --------- */

  /**
   * Five downward rays over the capsule footprint. Returns the highest standable
   * contact at or below the feet, or null.
   */
  function groundProbe(pos, dist, radius) {
    const ph = ctx.physics;
    if (!ph?.raycast) return null;
    const up = 0.12;
    const max = dist + up;
    let best = null;
    let bestY = -Infinity;
    let centreHit = null;
    for (let i = 0; i < PROBE_PTS.length; i++) {
      const ox = PROBE_PTS[i][0] * radius;
      const oz = PROBE_PTS[i][1] * radius;
      _probeP.set(pos.x + ox, pos.y + up, pos.z + oz);
      const h = ph.raycast(_probeP, DOWN, max, MASK_SOLID, hits[i]);
      if (!h || !solidBody(h.body)) continue;
      if (h.normal.y < SLOPE_COS) continue;
      if (h.point.y > pos.y + 0.05) continue;
      if (i === 0) centreHit = h;
      if (h.point.y > bestY) {
        bestY = h.point.y;
        best = h;
      }
    }
    if (!best) return null;
    // Prefer the centre ray's normal/surface when it agrees, so a foot hanging over
    // a kerb does not swap the material under you every frame.
    if (centreHit && Math.abs(centreHit.point.y - bestY) < 0.06) return centreHit;
    return best;
  }

  /** True when a capsule of `height` fits here (upward ray fan). */
  function hasHeadroom(pos, height, radius) {
    const ph = ctx.physics;
    if (!ph?.raycast) return true;
    const start = 0.22;
    const max = height - start - 0.02;
    if (max <= 0.02) return true;
    for (let i = 0; i < PROBE_PTS.length; i++) {
      const ox = PROBE_PTS[i][0] * radius * 0.8;
      const oz = PROBE_PTS[i][1] * radius * 0.8;
      _probeP.set(pos.x + ox, pos.y + start, pos.z + oz);
      const h = ph.raycast(_probeP, UP, max, MASK_SOLID, hitA);
      if (h && solidBody(h.body)) return false;
    }
    return true;
  }

  /** Free-space test: used by mantle validation and the step-up rise check. */
  function isFree(x, y, z, radius, height, tolerance = 0.02) {
    const broad = bp();
    if (!broad?.queryAABB) return true;
    const cap = capShape(radius, height);
    _v0.set(x, y + height * 0.5, z);
    Shapes.computeAABB(cap, _v0, _identQ, _cMin, _cMax);
    let blocked = false;
    broad.queryAABB(_cMin.x, _cMin.y, _cMin.z, _cMax.x, _cMax.y, _cMax.z, (body) => {
      if (blocked || !solidBody(body)) return;
      manifold.reset();
      if (!Shapes.collide(cap, _v0, _identQ, body.shape, body.position, body.quaternion, manifold)) return;
      for (let i = 0; i < manifold.count; i++) {
        if (manifold.depth[i] > tolerance) {
          blocked = true;
          return;
        }
      }
    });
    return !blocked;
  }

  /**
   * Where the feet sit when the capsule rests tangent to the plane the ground probe
   * found. On a slope the bottom sphere touches uphill of the vertical ray hit, so
   * a naive `hitY + offset` buries the capsule and the contact resolver fights the
   * ground snap forever.
   */
  function restHeight(hit, radius) {
    const ny = Math.max(0.55, hit.normal.y);
    return hit.point.y + GROUND_OFFSET + (radius * (1 - ny)) / ny;
  }

  /* ---- collide and slide ------------------------------------------------ */

  /**
   * Quake-style multi-plane clip: project out of every violated plane, and slide
   * along the crease when two planes fight. Without the crease case you catch on
   * every seam between two coplanar-ish boxes.
   */
  function clipToPlanes(v, count) {
    if (count <= 0) return;
    if (count === 1) {
      const d = v.dot(_planes[0]);
      if (d < 0) v.addScaledVector(_planes[0], -d);
      return;
    }
    for (let i = 0; i < count; i++) {
      const pi = _planes[i];
      const d = v.dot(pi);
      if (d >= 0) continue;
      _tmpClip.copy(v).addScaledVector(pi, -d);
      let ok = true;
      for (let j = 0; j < count; j++) {
        if (j !== i && _tmpClip.dot(_planes[j]) < -1e-4) {
          ok = false;
          break;
        }
      }
      if (ok) {
        v.copy(_tmpClip);
        return;
      }
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        const pj = _planes[j];
        if (_tmpClip.dot(pj) >= -1e-4) continue;
        _cross.crossVectors(pi, pj);
        const cl = _cross.length();
        if (cl < 1e-4) {
          v.set(0, 0, 0);
          return;
        }
        _cross.multiplyScalar(1 / cl);
        const along = _cross.dot(v);
        _tmpClip.copy(_cross).multiplyScalar(along);
        let ok2 = true;
        for (let k = 0; k < count; k++) {
          if (_tmpClip.dot(_planes[k]) < -1e-4) {
            ok2 = false;
            break;
          }
        }
        if (ok2) {
          v.copy(_tmpClip);
          return;
        }
      }
    }
    v.set(0, 0, 0);
  }

  /* ---- vertical motion --------------------------------------------------- */

  function moveVertical(dy, height, radius) {
    if (dy < 0) {
      // Rays, not sweeps: exact for the terrain heightfield, and they cannot tunnel
      // no matter how fast we are falling.
      const want = -dy;
      const g = groundProbe(position, want + GROUND_PROBE, radius);
      if (g) {
        const rest = restHeight(g, radius);
        if (position.y - rest <= want + 1e-4) {
          position.y = rest;
          if (velocity.y < 0) velocity.y = 0;
          return;
        }
      }
      position.y += dy;
      return;
    }
    // Upward: a ray fan from the shoulders, so a low ceiling stops the jump.
    let allowed = dy;
    const ph = ctx.physics;
    if (ph?.raycast) {
      const from = height - radius * 0.5;
      for (let i = 0; i < PROBE_PTS.length; i++) {
        _probeP.set(
          position.x + PROBE_PTS[i][0] * radius * 0.8,
          position.y + from,
          position.z + PROBE_PTS[i][1] * radius * 0.8
        );
        const h = ph.raycast(_probeP, UP, dy + radius * 0.5 + 0.03, MASK_SOLID, hitB);
        if (h && solidBody(h.body)) {
          allowed = Math.min(allowed, Math.max(0, h.distance - radius * 0.5 - 0.02));
        }
      }
    }
    position.y += allowed;
    if (allowed < dy - 1e-4 && velocity.y > 0) velocity.y = 0;
  }

  /* ---- step-up ----------------------------------------------------------- */

  /**
   * Retry a blocked horizontal move from `STEP_HEIGHT` higher up. Accepted only if
   * it makes real horizontal progress AND lands on something standable — otherwise
   * you get a controller that walks up thin air at the edge of every ledge.
   */
  function tryStepUp(startPos, move, height, radius, flatProgress) {
    const len = Math.hypot(move.x, move.z);
    if (len < 1e-6) return false;
    if (!isFree(startPos.x, startPos.y + STEP_HEIGHT, startPos.z, radius * 0.9, height, 0.012)) {
      return false;
    }
    /*
     * Probe with at least a capsule radius of travel. When you walk into a kerb the
     * contact resolver scrubs your velocity to nearly nothing within one substep, so
     * the *actual* delta is well under a millimetre — far too small to tell whether
     * there is a step ahead or a wall. Probe generously, commit conservatively.
     */
    const probeLen = Math.max(len, radius * 1.1);
    const dx = move.x / len;
    const dz = move.z / len;
    _stepPos.set(startPos.x, startPos.y + STEP_HEIGHT, startPos.z);
    _stepMove.set(dx * probeLen, 0, dz * probeLen);
    moveAndResolve(_stepPos, _stepMove, radius, height, null);
    const gained = Math.hypot(_stepPos.x - startPos.x, _stepPos.z - startPos.z);
    if (gained < Math.max(flatProgress + 0.006, probeLen * 0.5)) return false;

    /*
     * Commit a modest advance — enough that the ground probe's 0.9R footprint clears
     * the lip we are climbing, and no more. Looking for the floor at the *probe*
     * position instead would overshoot a whole tread on a staircase and reject the
     * step for being too high, which stops the player dead four steps up.
     */
    const advance = Math.min(gained, Math.max(len, radius * 0.38));
    _stepPos.set(startPos.x + dx * advance, startPos.y + STEP_HEIGHT, startPos.z + dz * advance);

    // Must land on something standable within the rise, or we stepped into thin air.
    const g = groundProbe(_stepPos, STEP_HEIGHT + GROUND_PROBE, radius);
    if (!g) return false;
    if (g.normal.y < SLOPE_COS) return false;
    const rest = restHeight(g, radius);
    if (rest <= startPos.y + 0.012) return false; // not actually a step up
    if (rest > startPos.y + STEP_HEIGHT + 0.02) return false;

    _stepPos.y = rest;
    if (!hasHeadroom(_stepPos, height, radius)) return false;
    if (!isFree(_stepPos.x, _stepPos.y + 0.01, _stepPos.z, radius * 0.94, height, 0.02)) return false;
    startPos.copy(_stepPos);
    return true;
  }

  /* ---- ledge detection --------------------------------------------------- */

  function probeLedge(def) {
    const ph = ctx.physics;
    if (!ph?.raycast) return null;
    forwardOf(yaw, _fwd);
    let wallDist = -1;
    let wallY = 0;
    const heights = [0.32, 0.78, 1.22, 1.72];
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] > LEDGE_MAX) break;
      _probeP.set(position.x, position.y + heights[i], position.z);
      const h = ph.raycast(_probeP, _fwd, RADIUS + 0.55, MASK_SOLID, hitA);
      if (h && solidBody(h.body) && Math.abs(h.normal.y) < 0.5) {
        wallDist = h.distance;
        wallY = heights[i];
        break;
      }
    }
    if (wallDist < 0) return null;

    // Top surface just past the face.
    const ax = position.x + _fwd.x * (wallDist + 0.3);
    const az = position.z + _fwd.z * (wallDist + 0.3);
    _probeP.set(ax, position.y + LEDGE_MAX + 0.4, az);
    const top = ph.raycast(_probeP, DOWN, LEDGE_MAX + 0.46, MASK_SOLID, hitB);
    if (!top || !solidBody(top.body) || top.normal.y < 0.62) return null;
    const h = top.point.y - position.y;
    if (h < LEDGE_MIN || h > LEDGE_MAX) return null;
    if (h < wallY - 0.35) return null; // the face we hit is above the ledge: not a ledge

    let kind = STATE.CLIMB;
    let dur = 1.05;
    let exit = 1.0;
    if (h <= VAULT_MAX) {
      kind = STATE.VAULT;
      dur = 0.35;
      exit = 3.2;
    } else if (h <= MANTLE_MAX) {
      kind = STATE.MANTLE;
      dur = 0.75;
      exit = 1.7;
    }
    if (kind !== STATE.VAULT && def && !def.canMantle) return null;

    /*
     * Landing spot. Try progressively further out and take the first place the
     * player actually fits. A vault prefers to carry you over and *past* a thin
     * obstacle (a railing, a low fence) and only settles for standing on top when
     * the obstacle is too deep to clear; a mantle just wants the near edge of the
     * surface it is climbing onto.
     */
    const outs = kind === STATE.VAULT ? VAULT_OUTS : MANTLE_OUTS;
    const pr = RADIUS * 0.88;
    let tx = 0;
    let tz = 0;
    let ty = 0;
    let found = false;
    for (let i = 0; i < outs.length; i++) {
      const d = wallDist + RADIUS + outs[i];
      const cx = position.x + _fwd.x * d;
      const cz = position.z + _fwd.z * d;
      _probeP.set(cx, top.point.y + 0.5, cz);
      const floor = ph.raycast(
        _probeP,
        DOWN,
        kind === STATE.VAULT ? 1.9 : 0.85,
        MASK_SOLID,
        hitC
      );
      let cy = top.point.y;
      if (floor && solidBody(floor.body) && floor.normal.y >= SLOPE_COS) cy = floor.point.y;
      if (cy > top.point.y + 0.05) cy = top.point.y;
      if (cy < position.y - LEDGE_MAX) continue; // a pit, not a landing
      if (!isFree(cx, cy + 0.04, cz, pr, HEIGHT_CROUCH)) continue;
      tx = cx;
      tz = cz;
      ty = cy;
      found = true;
      break;
    }
    if (!found) return null;

    // Also need room directly over the lip, or we clip the wall on the way up.
    const ex = position.x + _fwd.x * (wallDist + RADIUS * 0.5);
    const ez = position.z + _fwd.z * (wallDist + RADIUS * 0.5);
    if (!isFree(ex, top.point.y + 0.06, ez, pr * 0.9, HEIGHT_CROUCH * 0.8)) return null;

    mantle.kind = kind;
    mantle.dur = dur;
    mantle.height = h;
    mantle.exitSpeed = exit;
    mantle.start.copy(position);
    mantle.end.set(tx, ty + 0.02, tz);
    return mantle;
  }

  function startMantle() {
    mantle.active = true;
    mantle.t = 0;
    velocity.set(0, 0, 0);
    grounded = false;
    coyote = 0;
    jumpBuffer = 0;
    strideAccum = 0;
    if (!machine.request(mantle.kind)) machine.force(mantle.kind);
    ctx.bus?.emit('player:mantle', {
      kind: mantle.kind,
      height: mantle.height,
      duration: mantle.dur,
    });
  }

  function stepScripted(h) {
    if (!mantle.active) {
      // Defensive: a scripted state without a drive would freeze the player.
      if (!machine.force(STATE.FALL)) machine.force(STATE.IDLE);
      return;
    }
    _prevPos.copy(position);
    mantle.t += h;
    const p = clamp(mantle.t / mantle.dur, 0, 1);
    const vaulting = mantle.kind === STATE.VAULT;
    // Root-motion feel: rise first, then translate over the lip.
    const vT = clamp(p / (vaulting ? 0.5 : 0.58), 0, 1);
    const hT = clamp((p - (vaulting ? 0.12 : 0.3)) / (vaulting ? 0.88 : 0.7), 0, 1);
    const vy = easeOutCubic(vT);
    const hxz = easeInOutCubic(hT);
    const apex = vaulting ? 0.06 : 0.0;
    position.y = lerp(mantle.start.y, mantle.end.y, vy) + Math.sin(p * Math.PI) * apex;
    position.x = lerp(mantle.start.x, mantle.end.x, hxz);
    position.z = lerp(mantle.start.z, mantle.end.z, hxz);
    if (h > 1e-6) {
      velocity.set(
        (position.x - _prevPos.x) / h,
        (position.y - _prevPos.y) / h,
        (position.z - _prevPos.z) / h
      );
    }
    if (p >= 1) {
      mantle.active = false;
      mantleCooldown = MANTLE_COOLDOWN;
      forwardOf(yaw, _fwd);
      velocity.set(_fwd.x * mantle.exitSpeed, 0, _fwd.z * mantle.exitSpeed);
      grounded = false;
      lastAirVy = 0;
      machine.force(STATE.FALL);
      updateGround(h);
    }
  }

  /* ---- ground acceleration ----------------------------------------------- */

  function wishVector(def, out) {
    forwardOf(yaw, _fwd);
    rightOf(yaw, _right);
    const fz = -intent.z;
    const sx = intent.x;
    out.set(0, 0, 0);
    if (!intent.has) return 0;
    out.addScaledVector(_fwd, fz);
    out.addScaledVector(_right, sx);
    const l = out.length();
    if (l < 1e-5) return 0;
    out.multiplyScalar(1 / l);
    // Directional speed scaling: forward > strafe > backward.
    const fwdAmt = Math.max(0, fz);
    const backAmt = Math.max(0, -fz);
    const strafeAmt = Math.abs(sx);
    const denom = fwdAmt + backAmt + strafeAmt || 1;
    const dirScale =
      (fwdAmt * 1 + strafeAmt * STRAFE_SCALE + backAmt * BACK_SCALE) / denom;
    return def.speed * dirScale * speedScale();
  }

  function speedScale() {
    let s = api.speedScale;
    const w = ctx.weapons?.moveSpeedScale;
    if (typeof w === 'number' && w > 0) s *= w;
    else if (intent.ads) s *= 0.55;
    if (landPenalty > 0) s *= 1 - landPenalty;
    return s;
  }

  function groundMove(h, def) {
    const wishSpeed = wishVector(def, _wish);
    _v0.set(velocity.x, 0, velocity.z);
    const speed = _v0.length();

    if (wishSpeed > 0.01 && def.accel > 0) {
      noInputTime = 0;
      // Acceleration curve: strong off the mark, tapering as you approach top speed.
      const ratio = clamp(speed / Math.max(0.5, wishSpeed), 0, 1);
      const accel = def.accel * (1 + ACCEL_LOW_BOOST * (1 - ratio) - (1 - ACCEL_HIGH_TAPER) * ratio * ratio);
      _v1.copy(_wish).multiplyScalar(wishSpeed).sub(_v0);
      const need = _v1.length();
      const step = accel * h;
      if (need > step) _v1.multiplyScalar(step / need);
      velocity.x += _v1.x;
      velocity.z += _v1.z;
    } else if (speed > 1e-4) {
      noInputTime += h;
      // Friction ramps in — an instant stop reads as ice-skating in reverse.
      const ramp = lerp(
        FRICTION_RAMP_MIN,
        1,
        clamp(noInputTime / FRICTION_RAMP_TIME, 0, 1)
      );
      const control = Math.max(speed, STOP_SPEED);
      const drop = control * def.friction * ramp * h;
      const ns = Math.max(0, speed - drop);
      const m = ns / speed;
      velocity.x *= m;
      velocity.z *= m;
    }
  }

  function airMove(h, def) {
    const src = defOf(machine.airFrom);
    const control = (def.airControl ?? 1) * (src.airControl ?? 1);
    const wishSpeed = wishVector(src, _wish);
    if (wishSpeed <= 0.01) return;
    const capped = Math.min(wishSpeed, AIR_WISH_CLAMP);
    const cur = velocity.x * _wish.x + velocity.z * _wish.z;
    const add = capped - cur;
    if (add <= 0) return;
    const step = Math.min(add, AIR_ACCEL * control * h);
    velocity.x += _wish.x * step;
    velocity.z += _wish.z * step;
    // Hard clamp: air strafing redirects momentum, it never manufactures it.
    const hs = Math.hypot(velocity.x, velocity.z);
    if (hs > airSpeedCap) {
      const m = airSpeedCap / hs;
      velocity.x *= m;
      velocity.z *= m;
    }
  }

  /* ---- slide -------------------------------------------------------------- */

  function enterSlide() {
    if (!machine.request(STATE.SLIDE)) return false;
    _v0.set(velocity.x, 0, velocity.z);
    let sp = _v0.length();
    forwardOf(yaw, _fwd);
    if (sp < 0.5) _v0.copy(_fwd);
    else _v0.multiplyScalar(1 / sp);
    // Momentum preserving with a small entry boost — the reward for committing.
    sp = clamp(sp * SLIDE_BOOST + 0.9, SLIDE_ENTER_MIN, SLIDE_ENTER_MAX);
    velocity.x = _v0.x * sp;
    velocity.z = _v0.z * sp;
    strideAccum = 0;
    ctx.bus?.emit('player:slide', { phase: 'start', speed: sp });
    return true;
  }

  function updateSlide(h, def) {
    _v0.set(velocity.x, 0, velocity.z);
    let sp = _v0.length();
    if (sp > 1e-4) _v0.multiplyScalar(1 / sp);

    // Weak steering: you can shape a slide, not turn it into a strafe.
    if (intent.x !== 0 && sp > 0.5) {
      const turn = -intent.x * SLIDE_STEER * h;
      const cs = Math.cos(turn);
      const sn = Math.sin(turn);
      const nx = _v0.x * cs + _v0.z * sn;
      const nz = -_v0.x * sn + _v0.z * cs;
      _v0.set(nx, 0, nz);
      sp *= 1 - Math.min(0.35, Math.abs(turn)) * 0.28; // turning scrubs a little speed
    }

    // Gravity along the ground plane: downhill accelerates, uphill bleeds.
    if (grounded && groundNormal.y < 0.999) {
      _v1.set(0, -GRAVITY, 0);
      _v1.addScaledVector(groundNormal, GRAVITY * groundNormal.y);
      sp += (_v1.x * _v0.x + _v1.z * _v0.z) * h * 0.9;
    }

    const surfMul = groundSurface === 'snow' || groundSurface === 'water' ? 0.55 : 1;
    sp -= (SLIDE_DECEL + sp * def.friction) * surfMul * h;
    if (sp < 0) sp = 0;
    velocity.x = _v0.x * sp;
    velocity.z = _v0.z * sp;

    const tooSlow = sp < SLIDE_END_SPEED;
    const expired = machine.time >= def.duration;
    if (tooSlow || expired || !grounded) endSlide(sp);
  }

  function endSlide(sp) {
    slideCooldown = SLIDE_COOLDOWN;
    ctx.bus?.emit('player:slide', { phase: 'end', speed: sp });
    if (!grounded) {
      machine.request(STATE.FALL);
      return;
    }
    if (intent.crouchHeld || !hasHeadroom(position, HEIGHT_STAND, RADIUS)) {
      machine.request(intent.has ? STATE.CROUCH_WALK : STATE.CROUCH);
    } else {
      machine.request(intent.has ? STATE.WALK : STATE.IDLE);
    }
  }

  /* ---- jumping ------------------------------------------------------------ */

  function tryJump() {
    if (jumpBuffer <= 0 || jumpLockout > 0) return false;
    const def = machine.def;
    if (def.scripted) return false;
    const sliding = machine.current === STATE.SLIDE;
    if (!def.canJump && !(sliding && machine.time >= SLIDE_MIN_TIME)) return false;
    if (!grounded && coyote <= 0) return false;
    if (!hasHeadroom(position, HEIGHT_CROUCH + 0.12, RADIUS)) return false;

    let vy = JUMP_SPEED;
    if (sliding) {
      velocity.x *= SLIDE_JUMP_RETAIN;
      velocity.z *= SLIDE_JUMP_RETAIN;
      slideCooldown = SLIDE_COOLDOWN;
      ctx.bus?.emit('player:slide', { phase: 'end', speed: Math.hypot(velocity.x, velocity.z) });
      vy *= 0.97;
    } else if (def.stance === STANCE.CROUCH) {
      vy *= 0.86;
    } else if (def.stance === STANCE.PRONE) {
      return false;
    }
    velocity.y = vy;
    grounded = false;
    coyote = 0;
    jumpBuffer = 0;
    jumpLockout = JUMP_LOCKOUT;
    lastAirVy = vy;
    airSpeedCap = Math.max(Math.hypot(velocity.x, velocity.z), def.speed) * AIR_SPEED_MARGIN;
    if (!machine.request(STATE.JUMP)) machine.force(STATE.JUMP);
    ctx.bus?.emit('player:jump', {
      state: machine.previous,
      speed: Math.hypot(velocity.x, velocity.z),
    });
    return true;
  }

  /* ---- state resolution ---------------------------------------------------- */

  function desiredStance() {
    let stance = STANCE.STAND;
    if (proneToggle) stance = STANCE.PRONE;
    else if (intent.crouchHeld) stance = STANCE.CROUCH;
    // The headroom fan is five raycasts, so only pay for it when we are actually
    // trying to grow — staying at the height we already occupy is always legal.
    const cur = machine.def.stance;
    if (stance === STANCE.STAND && (cur !== STANCE.STAND || contactCeiling)) {
      if (!hasHeadroom(position, HEIGHT_STAND, RADIUS)) stance = STANCE.CROUCH;
    }
    if (stance === STANCE.CROUCH && cur === STANCE.PRONE) {
      if (!hasHeadroom(position, HEIGHT_CROUCH, RADIUS)) stance = STANCE.PRONE;
    }
    return stance;
  }

  function resolveState(h) {
    const def = machine.def;

    // Airborne bookkeeping.
    if (!grounded && !def.airborne && !def.scripted && coyote <= 0) {
      if (machine.current === STATE.SLIDE) endSlide(Math.hypot(velocity.x, velocity.z));
      else machine.request(STATE.FALL);
    }
    if (!grounded && machine.current === STATE.JUMP && velocity.y < 0) {
      machine.request(STATE.FALL);
    }

    // Mantle beats everything else — it is the highest-priority traversal.
    if (tryMantle()) return;
    if (tryJump()) return;

    if (machine.current === STATE.SLIDE) {
      updateSlide(h, machine.def);
      return;
    }
    if (!grounded) return;
    if (machine.current === STATE.LAND && !machine.expired) return;

    const stance = desiredStance();
    const moving = intent.has && Math.hypot(velocity.x, velocity.z) > 0.35;

    // Slide entry: sprinting + crouch, with a real cooldown so slide-cancelling
    // costs you something.
    if (
      intent.crouchPressed &&
      slideCooldown <= 0 &&
      machine.def.canSlide &&
      stance !== STANCE.PRONE &&
      Math.hypot(velocity.x, velocity.z) >= SLIDE_MIN_SPEED
    ) {
      intent.crouchPressed = false;
      if (enterSlide()) return;
    }

    // Getting out of prone always passes through crouch, and takes a beat — going
    // prone is a commitment, which is the whole point of the stance.
    if (machine.current === STATE.PRONE && stance !== STANCE.PRONE) {
      if (machine.time >= PRONE_EXIT_TIME) machine.request(STATE.CROUCH);
      return;
    }
    if (stance === STANCE.PRONE) {
      machine.request(STATE.PRONE);
      return;
    }
    if (stance === STANCE.CROUCH) {
      machine.request(moving ? STATE.CROUCH_WALK : STATE.CROUCH);
      return;
    }

    const wantsSprint =
      intent.sprintHeld &&
      intent.has &&
      intent.z < -0.35 &&
      !intent.ads &&
      landPenalty < 0.3;
    if (wantsSprint) {
      if (tacActive && tacCharge > 0) machine.request(STATE.TAC_SPRINT);
      else machine.request(STATE.SPRINT);
      return;
    }
    machine.request(moving || intent.has ? STATE.WALK : STATE.IDLE);
  }

  function tryMantle() {
    if (mantle.active || mantleCooldown > 0) return false;
    const def = machine.def;
    if (def.scripted || def.stance === STANCE.PRONE) return false;
    const wants = jumpBuffer > 0 || intent.usePressed;
    // Auto-vault: sprinting into something low should just flow over it. Use the
    // speed we *approached* at, not the post-collision speed, which the contact
    // resolver has already scrubbed against the wall normal.
    const auto =
      wallContact &&
      grounded &&
      intent.has &&
      intent.z < -0.5 &&
      Math.max(approachSpeed, Math.hypot(velocity.x, velocity.z)) > 2.8;
    if (!wants && !auto) return false;
    if (ledgeProbeWait > 0) return false;
    if (!probeLedge(def)) {
      ledgeProbeWait = LEDGE_PROBE_INTERVAL;
      return false;
    }
    if (auto && !wants && mantle.kind !== STATE.VAULT) return false;
    startMantle();
    return true;
  }

  /* ---- ground / landing ---------------------------------------------------- */

  function updateGround(h) {
    const was = grounded;
    const def = machine.def;
    const radius = RADIUS;
    const snapping = was && velocity.y <= 0.6 && jumpLockout <= 0 && !def.scripted;
    const dist = GROUND_PROBE + (snapping ? SNAP_DIST : 0);
    const g = velocity.y <= 0.6 ? groundProbe(position, dist, radius) : null;

    if (g) {
      grounded = true;
      groundNormal.copy(g.normal);
      groundBody = g.body;
      groundSurface = g.surface || 'concrete';
      const preY = position.y;
      position.y = restHeight(g, RADIUS);
      if (was) {
        /*
         * Absorb *discontinuous* ground changes in the view — a kerb, a stair lip,
         * the crease where a ramp meets the floor. A continuous slope is left alone:
         * feeding a ramp's steady climb into the smoother would park the camera a
         * permanent hand's width below the player's actual eyeline.
         */
        const rise = position.y - preY;
        const expected = Math.hypot(velocity.x, velocity.z) * h * 1.05 + 0.005;
        if (Math.abs(rise) > expected) {
          stepSmooth = clamp(
            stepSmooth + rise - Math.sign(rise) * expected,
            -STEP_SMOOTH_MAX,
            STEP_SMOOTH_MAX
          );
        }
      }
      if (velocity.y < 0) velocity.y = 0;
      coyote = COYOTE_TIME;
      safePos.copy(position);
    } else {
      grounded = false;
      groundNormal.set(0, 1, 0);
    }

    if (!was && grounded) doLanding();
    else if (was && !grounded && !def.scripted) {
      airSpeedCap = Math.max(
        Math.hypot(velocity.x, velocity.z),
        machine.def.speed
      ) * AIR_SPEED_MARGIN;
    }
  }

  function doLanding() {
    const impact = Math.max(0, -lastAirVy);
    const hard = impact > 9.5;
    ctx.bus?.emit('player:land', {
      impactSpeed: impact,
      hard,
      surface: groundSurface,
      position,
    });
    if (impact > 1.4) {
      dipVel -= clamp(impact * 0.09, 0, 0.9);
      emitStep(Math.max(impact * 0.35, Math.hypot(velocity.x, velocity.z)), true);
      strideAccum = 0;
    }
    if (impact > 2.5) {
      landPenalty = clamp((impact - 2.5) / 16, 0, 0.55);
      machine.request(STATE.LAND);
    }
    lastAirVy = 0;
  }

  /* ---- footsteps ----------------------------------------------------------- */

  let cachedSurfaceKey = null;
  let cachedSurfaceDef = null;

  function surfaceInfo() {
    const tag = groundSurface || 'concrete';
    if (tag !== cachedSurfaceKey) {
      cachedSurfaceKey = tag;
      cachedSurfaceDef = null;
      try {
        // A bare §5 tag is a legal input to surfaceOf(); it resolves to the
        // representative material for that tag (SurfaceDefs.resolveSurfaceName).
        cachedSurfaceDef = ctx.materials?.surfaceOf?.(tag) || null;
      } catch {
        cachedSurfaceDef = null;
      }
    }
    return cachedSurfaceDef;
  }

  function emitStep(speed, landing = false) {
    const def = surfaceInfo();
    stepFoot ^= 1;
    ctx.bus?.emit('player:step', {
      surface: def?.surface || groundSurface || 'concrete',
      speed,
      foot: stepFoot ? 'right' : 'left',
      landing,
      position,
      volume: clamp(speed / 6.5, 0.18, 1) * (machine.def.stance === STANCE.CROUCH ? 0.45 : 1),
      footstep: def?.footstep || null,
      def,
    });
  }

  function updateStride(h) {
    const def = machine.def;
    if (!grounded || def.stride <= 0) return;
    const sp = Math.hypot(velocity.x, velocity.z);
    if (sp < 0.4) {
      // Priming the accumulator makes the first footfall land on the first stride
      // rather than a full stride later.
      strideAccum = def.stride * 0.58;
      return;
    }
    strideAccum += sp * h;
    if (strideAccum >= def.stride) {
      strideAccum -= def.stride;
      emitStep(sp);
    }
  }

  /* ---- one simulation substep ----------------------------------------------- */

  function tickTimers(h) {
    if (coyote > 0) coyote = Math.max(0, coyote - h);
    if (jumpBuffer > 0) jumpBuffer = Math.max(0, jumpBuffer - h);
    if (jumpLockout > 0) jumpLockout = Math.max(0, jumpLockout - h);
    if (slideCooldown > 0) slideCooldown = Math.max(0, slideCooldown - h);
    if (mantleCooldown > 0) mantleCooldown = Math.max(0, mantleCooldown - h);
    if (ledgeProbeWait > 0) ledgeProbeWait = Math.max(0, ledgeProbeWait - h);
    if (landPenalty > 0) landPenalty = Math.max(0, landPenalty - h * 1.8);
    // Decaying peak speed: auto-vault and slide entry care how fast you *were* going
    // a moment ago, not what is left after a wall scrubbed your velocity to zero.
    approachSpeed = Math.max(Math.hypot(velocity.x, velocity.z), approachSpeed - h * 7);

    if (machine.current === STATE.TAC_SPRINT) {
      tacCharge = clamp(tacCharge - h / TAC_SPRINT_TIME, 0, 1);
      if (tacCharge <= 0) tacActive = false;
    } else {
      const rate = machine.current === STATE.SPRINT ? 0.35 : 1;
      tacCharge = clamp(tacCharge + (h * rate) / TAC_SPRINT_RECHARGE, 0, 1);
      if (!intent.sprintHeld) tacActive = false;
    }
  }

  function simulate(h) {
    machine.tick(h);
    tickTimers(h);

    if (machine.def.scripted) {
      stepScripted(h);
      syncHeight(h);
      return;
    }

    resolveState(h);
    const def = machine.def;
    if (def.scripted) {
      stepScripted(h);
      syncHeight(h);
      return;
    }

    if (machine.current === STATE.SLIDE) {
      // updateSlide already shaped the velocity this substep.
    } else if (grounded) {
      groundMove(h, def);
    } else {
      airMove(h, def);
    }

    if (!grounded) {
      velocity.y -= GRAVITY * h;
      if (velocity.y < -TERMINAL_SPEED) velocity.y = -TERMINAL_SPEED;
    }
    lastAirVy = Math.min(lastAirVy, velocity.y);
    if (grounded) lastAirVy = 0;

    syncHeight(h);
    integrate(h);
    updateGround(h);
    updateStride(h);
    guardrails();
  }

  /** Collision height follows the state; it never grows into geometry. */
  function syncHeight(h) {
    const want = machine.def.height;
    if (want > capsuleHeight) {
      // Standing up: only if there is room, otherwise stay compressed.
      if (hasHeadroom(position, want, RADIUS)) capsuleHeight = damp(capsuleHeight, want, 16, h);
    } else {
      capsuleHeight = damp(capsuleHeight, want, 22, h);
    }
    if (Math.abs(capsuleHeight - want) < 0.005) capsuleHeight = want;
  }

  function integrate(h) {
    _delta.copy(velocity).multiplyScalar(h);
    const height = capsuleHeight;
    const radius = RADIUS;

    if (Math.abs(_delta.y) > 1e-7) moveVertical(_delta.y, height, radius);

    _hz.set(_delta.x, 0, _delta.z);
    const want = _hz.length();
    wallContact = false;
    if (want > 1e-7) {
      _flatPos.copy(position);
      _flatVel.copy(velocity);
      approachSpeed = Math.max(approachSpeed, Math.hypot(velocity.x, velocity.z));
      const wall = moveAndResolve(position, _hz, radius, height, velocity);
      const flatGain = Math.hypot(position.x - _flatPos.x, position.z - _flatPos.z);
      // Progress-based backstop: whatever the contact flags say, if we asked to move
      // and barely did, something is in the way.
      if (wall || flatGain < want * 0.75) wallContact = true;
      if (wallContact && (grounded || coyote > 0) && flatGain < want * 0.92) {
        // Step up from where the resolver left us, flush against the riser — not
        // from the start of the frame. Trying it from further back means the drop
        // probe never reaches over the lip, the attempt fails, and the player loses
        // all their speed to the wall clip before succeeding a frame later. That is
        // the difference between running up stairs and stuttering up them.
        const preY = position.y;
        _flatPos.copy(position);
        _v2.set(_delta.x, 0, _delta.z);
        if (tryStepUp(_flatPos, _v2, height, radius, 0)) {
          // Absorb the vertical pop in the view: a staircase is a sequence of
          // teleports, and un-smoothed it strobes the whole screen.
          stepSmooth = clamp(
            stepSmooth + (_flatPos.y - preY),
            -STEP_SMOOTH_MAX,
            STEP_SMOOTH_MAX
          );
          position.copy(_flatPos);
          velocity.copy(_flatVel);
          velocity.y = Math.min(velocity.y, 0);
          wallContact = false;
        }
      }
    } else {
      resolveContacts(position, radius, height, velocity);
      if (contactWall) wallContact = true;
    }
  }

  /** Nothing here may ever produce NaN or drop the player out of the world. */
  function guardrails() {
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      position.copy(safePos);
      velocity.set(0, 0, 0);
      return;
    }
    if (
      !Number.isFinite(velocity.x) ||
      !Number.isFinite(velocity.y) ||
      !Number.isFinite(velocity.z)
    ) {
      velocity.set(0, 0, 0);
    }
    const b = ctx.level?.bounds;
    const floorY = b?.min?.y !== undefined ? b.min.y - 12 : -80;
    if (position.y < floorY) respawn();
  }

  /* ---- input ----------------------------------------------------------------- */

  function sampleInput(dt) {
    const inp = ctx.input;
    intent.x = 0;
    intent.z = 0;
    intent.has = false;
    intent.jumpPressed = false;
    intent.crouchPressed = false;
    intent.pronePressed = false;
    intent.usePressed = false;
    if (!inp || inp.enabled === false || suspended) {
      intent.jumpHeld = false;
      intent.crouchHeld = false;
      intent.sprintHeld = false;
      intent.leanL = false;
      intent.leanR = false;
      intent.ads = false;
      return;
    }

    inp.moveVector?.(_v0);
    intent.x = _v0.x || 0;
    intent.z = _v0.z || 0;
    intent.has = Math.abs(intent.x) > 0.06 || Math.abs(intent.z) > 0.06;

    intent.jumpHeld = !!inp.action?.('jump');
    intent.jumpPressed = !!inp.pressed?.('jump');
    intent.crouchHeld = !!inp.action?.('crouch');
    intent.crouchPressed = !!inp.pressed?.('crouch');
    intent.pronePressed = !!inp.pressed?.('prone');
    intent.sprintHeld = !!inp.action?.('sprint');
    intent.usePressed = !!inp.pressed?.('use');
    intent.leanL = !!inp.action?.('leanLeft');
    intent.leanR = !!inp.action?.('leanRight');
    intent.ads = !!inp.ads;

    if (intent.jumpPressed) jumpBuffer = JUMP_BUFFER;
    if (intent.pronePressed) proneToggle = !proneToggle;
    if (intent.crouchHeld && proneToggle) proneToggle = false;

    // Tactical sprint: double-tap sprint or double-tap forward, CoD style.
    const now = ctx.time?.elapsed ?? 0;
    if (inp.pressed?.('sprint')) {
      if (now - lastSprintTap < DOUBLE_TAP_TIME && tacCharge >= TAC_SPRINT_MIN_CHARGE) {
        tacActive = true;
      }
      lastSprintTap = now;
    }
    if (inp.pressed?.('forward')) {
      if (
        now - lastForwardTap < DOUBLE_TAP_TIME &&
        intent.sprintHeld &&
        tacCharge >= TAC_SPRINT_MIN_CHARGE
      ) {
        tacActive = true;
      }
      lastForwardTap = now;
    }
    void dt;
  }

  function applyLook(dt) {
    const look = ctx.input?.consumeLook?.(dt);
    if (!look) return;
    if (suspended) return;
    if (Number.isFinite(look.yaw)) yaw += look.yaw;
    if (Number.isFinite(look.pitch)) pitch += look.pitch;
    // Keep yaw in range so long sessions never lose float precision.
    if (yaw > Math.PI) yaw -= Math.PI * 2;
    else if (yaw < -Math.PI) yaw += Math.PI * 2;
    pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /* ---- view ------------------------------------------------------------------- */

  function eyeTargetHeight() {
    let t = machine.def.eye;
    if (machine.current === STATE.SLIDE) {
      // Ease down into the slide instead of snapping the camera to the floor.
      t = lerp(EYE_STAND, machine.def.eye, easeOutQuad(clamp(machine.time / 0.18, 0, 1)));
    }
    if (mantle.active) {
      const p = clamp(mantle.t / mantle.dur, 0, 1);
      t = lerp(EYE_CROUCH + 0.1, machine.def.eye, easeOutQuad(p));
    }
    // Never let the eye sit above the collision capsule.
    return Math.min(t, Math.max(EYE_PRONE, capsuleHeight - 0.1));
  }

  function updateView(dt) {
    const target = eyeTargetHeight();
    const rate = target < eyeHeight ? 24 : 15;
    eyeHeight = damp(eyeHeight, target, rate, dt);

    /*
     * Bleed off the step-smoothing offset: exponential for shape, plus a constant
     * floor so it always resolves quickly. Running up stairs adds a fresh 0.18 m
     * every ~70 ms, and a purely exponential decay lets the offset accumulate until
     * the camera is a knee-height behind the player. STEP_SMOOTH_MAX caps that.
     */
    stepSmooth = damp(stepSmooth, 0, STEP_SMOOTH_RATE, dt);
    const bleed = STEP_SMOOTH_BLEED * dt;
    if (stepSmooth > bleed) stepSmooth -= bleed;
    else if (stepSmooth < -bleed) stepSmooth += bleed;
    else stepSmooth = 0;

    // Landing dip: a critically damped spring, not a scripted animation.
    dipVel += (-dip * 165 - dipVel * 19) * dt;
    dip += dipVel * dt;
    dip = clamp(dip, -0.22, 0.06);

    updateLean(dt);

    eyePosition.set(position.x, position.y + eyeHeight + dip - stepSmooth, position.z);
    eyePosition.add(leanOffset);
  }

  function updateLean(dt) {
    const def = machine.def;
    let want = 0;
    if (def.canLean && !mantle.active && !suspended) {
      want = (intent.leanR ? 1 : 0) - (intent.leanL ? 1 : 0);
    }
    leanRaw = damp(leanRaw, want, LEAN_RATE, dt);
    if (Math.abs(leanRaw) < 0.002) leanRaw = 0;

    let allowed = Math.abs(leanRaw);
    if (allowed > 0.01) {
      rightOf(yaw, _right);
      const sign = leanRaw >= 0 ? 1 : -1;
      _v1.copy(_right).multiplyScalar(sign);
      _v0.set(position.x, position.y + eyeHeight, position.z);
      const maxD = LEAN_DIST * allowed;
      const h = ctx.physics?.raycast?.(_v0, _v1, maxD + LEAN_HEAD_R, MASK_SOLID, hitLean);
      if (h && solidBody(h.body)) {
        allowed = Math.min(allowed, Math.max(0, h.distance - LEAN_HEAD_R) / LEAN_DIST);
      }
      leanClamped = sign * allowed;
    } else {
      leanClamped = leanRaw;
    }
    rightOf(yaw, _right);
    leanOffset.copy(_right).multiplyScalar(leanClamped * LEAN_DIST);
    roll = -leanClamped * LEAN_ROLL;
  }

  function writeCamera() {
    const cam = ctx.camera;
    if (!cam || !api.ownCamera) return;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(pitch, yaw, roll);
    cam.position.copy(eyePosition);
    cam.updateMatrixWorld(true);
    // Fallback so the viewmodel scene is never orphaned; CameraRig (order 62) runs
    // after us and is free to override this with lag/sway.
    const vc = ctx.viewCamera;
    if (vc) {
      vc.position.copy(cam.position);
      vc.quaternion.copy(cam.quaternion);
      vc.updateMatrixWorld(true);
    }
  }

  /** While the harness owns the camera we follow it instead of driving it. */
  function mirrorCamera() {
    const cam = ctx.camera;
    if (!cam) return;
    eyePosition.copy(cam.position);
    yaw = cam.rotation.y;
    pitch = clamp(cam.rotation.x, -PITCH_LIMIT, PITCH_LIMIT);
    position.set(cam.position.x, cam.position.y - eyeHeight, cam.position.z);
    const vc = ctx.viewCamera;
    if (vc) {
      vc.position.copy(cam.position);
      vc.quaternion.copy(cam.quaternion);
      vc.updateMatrixWorld(true);
    }
  }

  /* ---- physics proxy ------------------------------------------------------------ */

  function syncBody() {
    if (!playerBody) return;
    playerBody.setPosition?.(position.x, position.y + capsuleHeight * 0.5, position.z);
  }

  /* ---- state machine host --------------------------------------------------------- */

  const machine = new MoveStateMachine({
    guard(from, to, def) {
      // Never stand up into a ceiling.
      if (def.stance === STANCE.STAND && def.height > capsuleHeight + 0.02) {
        if (!hasHeadroom(position, def.height, RADIUS)) return false;
      }
      if (to === STATE.PRONE && !grounded) return false;
      if ((to === STATE.SPRINT || to === STATE.TAC_SPRINT) && !grounded) return false;
      return true;
    },
    onExit(from, to, fromDef) {
      // Anything that yanks us out of a scripted traversal early — an explosion, a
      // teleport, a debug pose — must retire the mantle, or `mantle.active` latches
      // on and no further vault ever triggers.
      if (fromDef.scripted && !defOf(to).scripted && mantle.active) {
        mantle.active = false;
        mantleCooldown = MANTLE_COOLDOWN;
      }
    },
    onEnter(to) {
      if (to === STATE.LAND) strideAccum = Math.min(strideAccum, defOf(to).stride * 0.5);
      if (to === STATE.SPRINT || to === STATE.TAC_SPRINT) leanRaw = 0;
    },
    onChange(from, to) {
      ctx.bus?.emit('player:state', { from, to });
    },
  });

  /* ---- public api ------------------------------------------------------------------ */

  const api = {
    ready: false,
    position,
    velocity,
    eyePosition,
    groundNormal,
    /** Normal of the last wall the capsule pushed against — viewmodel wall-avoidance. */
    wallNormal,
    radius: RADIUS,
    /** writable multiplier other systems (ADS, wounds, buffs) can scale movement with */
    speedScale: 1,
    body: null,
    machine,
    STATE,
    /** Set false by a camera rig that wants sole authority over ctx.camera. */
    ownCamera: true,

    get eyeHeight() {
      return eyeHeight + dip;
    },
    get height() {
      return capsuleHeight;
    },
    get state() {
      return machine.current;
    },
    get previousState() {
      return machine.previous;
    },
    get stateTime() {
      return machine.time;
    },
    get stance() {
      return machine.def.stance;
    },
    get isGrounded() {
      return grounded;
    },
    /* Aliases. CameraRig probes `grounded`/`onGround`/`crouching`/`isSprinting`
     * before falling back to regex-matching the state string; publishing the names
     * it asks for first keeps it on the exact path instead of the guess path. */
    get grounded() {
      return grounded;
    },
    get onGround() {
      return grounded;
    },
    get crouching() {
      return machine.def.stance === STANCE.CROUCH;
    },
    get isCrouching() {
      return machine.def.stance === STANCE.CROUCH;
    },
    get isSprinting() {
      return machine.is(STATE.SPRINT, STATE.TAC_SPRINT);
    },
    get groundSurface() {
      return groundSurface;
    },
    /** The body the player is standing on, or null. */
    get groundBody() {
      return groundBody;
    },
    get speed() {
      return Math.hypot(velocity.x, velocity.z);
    },
    get verticalSpeed() {
      return velocity.y;
    },
    get yaw() {
      return yaw;
    },
    set yaw(v) {
      if (Number.isFinite(v)) yaw = v;
    },
    get pitch() {
      return pitch;
    },
    set pitch(v) {
      if (Number.isFinite(v)) pitch = clamp(v, -PITCH_LIMIT, PITCH_LIMIT);
    },
    get lean() {
      return leanClamped;
    },
    get roll() {
      return roll;
    },
    get sprinting() {
      return machine.is(STATE.SPRINT, STATE.TAC_SPRINT);
    },
    get crouched() {
      return machine.def.stance === STANCE.CROUCH;
    },
    get prone() {
      return machine.def.stance === STANCE.PRONE;
    },
    get touchingWall() {
      return wallContact;
    },
    get sliding() {
      return machine.current === STATE.SLIDE;
    },
    get mantling() {
      return mantle.active;
    },
    get mantleProgress() {
      return mantle.active ? clamp(mantle.t / mantle.dur, 0, 1) : 0;
    },
    get mantleKind() {
      return mantle.active ? mantle.kind : null;
    },
    get canFire() {
      return machine.def.canFire && !mantle.active && !suspended;
    },
    get weaponLower() {
      return machine.def.weaponLower;
    },
    get tacSprintCharge() {
      return tacCharge;
    },
    get cameraLocked() {
      return camLocked;
    },

    forward(out) {
      return forwardOf(yaw, out || new THREE.Vector3());
    },
    right(out) {
      return rightOf(yaw, out || new THREE.Vector3());
    },
    /** Full look direction including pitch — what weapons/ballistics want. */
    lookDir(out) {
      const o = out || new THREE.Vector3();
      const cp = Math.cos(pitch);
      return o.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    },

    /**
     * Harness contract (src/core/DebugTools.js): `teleport(cam.position, yaw, pitch)`
     * where cam.position is the EYE. Pass `{feet:true}` to place the feet instead.
     */
    teleport(pos, newYaw, newPitch, opts) {
      try {
        const px = pos?.x ?? pos?.[0] ?? position.x;
        const py = pos?.y ?? pos?.[1] ?? position.y;
        const pz = pos?.z ?? pos?.[2] ?? position.z;
        if (Number.isFinite(newYaw)) yaw = newYaw;
        if (Number.isFinite(newPitch)) pitch = clamp(newPitch, -PITCH_LIMIT, PITCH_LIMIT);
        const feetY = opts?.feet ? py : py - eyeTargetHeight();
        position.set(px, feetY, pz);
        velocity.set(0, 0, 0);
        grounded = false;
        coyote = 0;
        jumpBuffer = 0;
        jumpLockout = 0;
        landPenalty = 0;
        slideCooldown = 0;
        mantle.active = false;
        dip = 0;
        dipVel = 0;
        stepSmooth = 0;
        leanRaw = 0;
        leanClamped = 0;
        leanOffset.set(0, 0, 0);
        strideAccum = 0;
        lastAirVy = 0;
        machine.force(STATE.IDLE);
        capsuleHeight = machine.def.height;
        eyeHeight = machine.def.eye;
        if (!hasHeadroom(position, HEIGHT_STAND, RADIUS)) {
          machine.force(STATE.CROUCH);
          capsuleHeight = machine.def.height;
          eyeHeight = machine.def.eye;
        }
        resolveContacts(position, RADIUS, capsuleHeight, null, 4);
        const g = groundProbe(position, 2.4, RADIUS);
        if (g) {
          position.y = g.point.y + GROUND_OFFSET;
          grounded = true;
          groundNormal.copy(g.normal);
          groundSurface = g.surface || 'concrete';
          groundBody = g.body;
            }
        safePos.copy(position);
        eyePosition.set(position.x, position.y + eyeHeight, position.z);
        syncBody();
        placed = true;
      } catch (err) {
        warn('teleport failed', err);
      }
      return api;
    },

    setStance(name) {
      if (name === STANCE.PRONE) proneToggle = true;
      else proneToggle = false;
      if (name === STANCE.CROUCH) machine.request(STATE.CROUCH);
      else if (name === STANCE.PRONE) machine.request(STATE.PRONE);
      else if (name === STANCE.STAND) machine.request(STATE.IDLE);
      return api;
    },

    /** Explosions, knockback, elevator pads — anything that shoves the player. */
    addImpulse(v, launch = true) {
      if (!v) return api;
      velocity.x += v.x || 0;
      velocity.y += v.y || 0;
      velocity.z += v.z || 0;
      if (launch && (v.y || 0) > 0.5) {
        grounded = false;
        jumpLockout = JUMP_LOCKOUT;
        airSpeedCap = Math.max(airSpeedCap, Math.hypot(velocity.x, velocity.z) * 1.05);
        machine.request(STATE.FALL);
      }
      return api;
    },

    respawn(spawn) {
      const s = spawn || pickSpawn();
      const p = s?.pos || s?.position;
      const y = s?.yaw ?? yaw;
      if (p) api.teleport({ x: p.x, y: p.y + 0.05, z: p.z }, y, 0, { feet: true });
      else api.teleport({ x: 0, y: 1.2, z: 0 }, y, 0, { feet: true });
      return api;
    },

    suspend(on) {
      suspended = !!on;
      if (suspended) velocity.set(0, 0, 0);
      return api;
    },

    stats() {
      return {
        state: machine.current,
        stance: machine.def.stance,
        grounded,
        speed: Math.hypot(velocity.x, velocity.z),
        vy: velocity.y,
        surface: groundSurface,
        eyeHeight,
        height: capsuleHeight,
        lean: leanClamped,
        tacCharge,
        mantling: mantle.active,
      };
    },
  };

  // Published from the factory too: peers capture ctx.player before our init() runs.
  ctx.player = api;

  function warn(msg, err) {
    if (warnBudget-- <= 0) return;
    console.warn(`[player] ${msg}`, err?.message || err || '');
  }

  function pickSpawn() {
    const lvl = ctx.level;
    if (!lvl) return null;
    // spawnPoints[0] first: getSpawn() consumes the level RNG, and screenshots have
    // to be reproducible.
    const list = lvl.spawnPoints;
    if (Array.isArray(list) && list.length) return list[0];
    try {
      if (typeof lvl.getSpawn === 'function') return lvl.getSpawn('ffa') || null;
    } catch {
      /* the level may not have finished building its spawn table */
    }
    return null;
  }

  /** First real frame: drop onto the world now that colliders exist. */
  function placeOnce() {
    if (placed) return;
    const broad = bp();
    const statics = ctx.physics?.world?.statics;
    if (!broad || !statics || statics.length === 0) return; // colliders not ingested yet
    placed = true;
    const s = pickSpawn();
    const p = s?.pos || s?.position;
    if (p) {
      position.set(p.x, p.y + 0.06, p.z);
      if (Number.isFinite(s?.yaw)) yaw = s.yaw;
    } else {
      position.set(0, 1.2, 0);
    }
    velocity.set(0, 0, 0);
    resolveContacts(position, RADIUS, capsuleHeight, null, 4);
    const g = groundProbe(position, 3.0, RADIUS);
    if (g) {
      position.y = g.point.y + GROUND_OFFSET;
      grounded = true;
      groundNormal.copy(g.normal);
      groundSurface = g.surface || 'concrete';
      groundBody = g.body;
    }
    if (!hasHeadroom(position, HEIGHT_STAND, RADIUS)) {
      machine.force(STATE.CROUCH);
      capsuleHeight = machine.def.height;
      eyeHeight = machine.def.eye;
    }
    safePos.copy(position);
    eyePosition.set(position.x, position.y + eyeHeight, position.z);
  }

  /* ---- system ------------------------------------------------------------------------ */

  return {
    name: 'player',
    order: 60,

    async init() {
      ctx.player = api;
      try {
        const s = pickSpawn();
        const p = s?.pos || s?.position;
        if (p) {
          position.set(p.x, p.y + 0.06, p.z);
          if (Number.isFinite(s?.yaw)) yaw = s.yaw;
        } else if (ctx.camera) {
          position.set(ctx.camera.position.x, ctx.camera.position.y - EYE_STAND, ctx.camera.position.z);
        }
        safePos.copy(position);
        eyePosition.set(position.x, position.y + eyeHeight, position.z);
      } catch (err) {
        warn('spawn lookup failed', err);
      }

      // A kinematic *trigger* capsule so AI and ballistics can hit the player.
      // Trigger, not solid: it never feeds the contact solver, so it cannot fight the
      // controller's own contact resolution or launch nearby props.
      // Shooters should exclude it with `hit.entity === ctx.player` or mask out GROUP.PLAYER.
      try {
        const GROUP = ctx.physics?.GROUP;
        playerBody = ctx.physics?.addBody?.({
          shape: Shapes.capsule(RADIUS, Math.max(0, HEIGHT_STAND * 0.5 - RADIUS)),
          mass: 82,
          kinematic: true,
          trigger: true,
          allowSleep: false,
          pos: { x: position.x, y: position.y + HEIGHT_STAND * 0.5, z: position.z },
          group: GROUP?.PLAYER ?? 2,
          mask: GROUP?.ALL ?? 0xffff,
          material: 'flesh',
          surface: 'flesh',
          entity: api,
        }) || null;
        api.body = playerBody;
      } catch (err) {
        warn('player collision proxy unavailable', err);
      }

      unsubs.push(
        ctx.bus?.on?.('debug:cameraLock', (e) => {
          camLocked = !!e?.locked;
          if (camLocked) mirrorCamera();
        }) || (() => {})
      );
      unsubs.push(
        ctx.bus?.on?.('debug:pose', (state) => {
          if (!state) return;
          try {
            if (state.stance) api.setStance(state.stance);
            if (state.lean !== undefined) {
              leanRaw = clamp(Number(state.lean) || 0, -1, 1);
              leanClamped = leanRaw;
            }
            if (state.playerState && machine.force) machine.force(state.playerState);
            if (state.sprint === true) machine.force(STATE.SPRINT);
          } catch (err) {
            warn('debug pose', err);
          }
        }) || (() => {})
      );
      unsubs.push(
        ctx.bus?.on?.('explosion', (e) => {
          if (!e?.point) return;
          const r = e.radius ?? 5;
          const dx = position.x - e.point.x;
          const dy = position.y + 0.9 - e.point.y;
          const dz = position.z - e.point.z;
          const d = Math.hypot(dx, dy, dz);
          if (!(d < r)) return;
          const f = (1 - d / r) * Math.min(9, (e.damage ?? 80) * 0.06);
          const inv = 1 / Math.max(0.2, d);
          api.addImpulse({ x: dx * inv * f, y: Math.abs(dy * inv) * f * 0.7 + f * 0.35, z: dz * inv * f });
        }) || (() => {})
      );

      api.ready = true;
    },

    update(dt) {
      if (disposed) return;
      try {
        if (camLocked) {
          // Still drain the look buffer, or unlocking snaps the view by however
          // much the mouse moved while the harness owned the camera.
          ctx.input?.consumeLook?.(dt);
          mirrorCamera();
          return;
        }
        placeOnce();
        applyLook(dt);
        sampleInput(dt);

        if (!suspended) {
          const step = clamp(dt, 0, 0.25);
          const n = clamp(Math.ceil(step / MAX_SUBSTEP), 1, MAX_SUBSTEPS);
          const h = step / n;
          for (let i = 0; i < n; i++) simulate(h);
        } else {
          machine.tick(dt);
        }

        updateView(dt);
        writeCamera();
        syncBody();
      } catch (err) {
        // A movement hiccup must never disable the system (the engine would blank the
        // player for the rest of the session and the smoke test would fail).
        warn('update', err);
        velocity.set(0, 0, 0);
        if (!Number.isFinite(position.x)) position.copy(safePos);
      }
    },

    dispose() {
      disposed = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* teardown is best-effort */
        }
      }
      unsubs.length = 0;
      try {
        if (playerBody) ctx.physics?.removeBody?.(playerBody);
      } catch {
        /* physics may already be gone */
      }
      playerBody = null;
      api.body = null;
      shapeCache.clear();
      api.ready = false;
      if (ctx.player === api) ctx.player = null;
    },
  };
}
