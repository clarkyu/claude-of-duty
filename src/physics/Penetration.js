/**
 * Penetration.js — surface interaction solver for bullets. Owner: ballistics agent.
 *
 * Given a physics Hit and the round's remaining kinetic energy, this decides what the
 * round actually does at that surface: stop dead, ricochet off it, or punch through and
 * come out the far side with less energy and a slight deflection.
 *
 * It is deliberately a *solver*, not a system: it owns no scene objects and no frame
 * loop. `Ballistics.js` drives it. It is exported separately so Destruction, AI cover
 * evaluation and the level designer's debug tools can ask "would a 5.56 make it through
 * this?" without spawning a round.
 *
 * ── The physics ─────────────────────────────────────────────────────────────────
 * Every material's resistance comes from `ctx.materials.surfaceOf(x)` (SurfaceDefs.js):
 *   `maxPenetration`  metres a 7.62×51 NATO ball round (3400 J) defeats
 *   `rha`             mm RHA-equivalent per metre — used for the reported hardness
 *   `energyLoss`      fraction of KE lost per metre travelled inside the material
 *   `density`         kg/m³ — drives the momentum/deflection term
 *   `ricochet`        probability at a *shallow* (>65° from normal) incidence
 *   `penetrable`      false = stop the round dead, whatever its energy
 *
 * The path length through the material is measured, not guessed: we shoot a probe from
 * a point past the entry back *toward* it and take the first face belonging to the same
 * body. That gives the true slab thickness for an arbitrary angle through arbitrary
 * geometry, which is what makes a 45° shot through a wall cost more than a square one.
 *
 * Energy budget for a penetration:
 *   capacity = maxPenetration · penPower · (E / 3400 J) · gain
 *   frac     = thickness / capacity                      (>1 ⇒ the round stops)
 *   keep     = (1 − 0.85·frac) · (1 − energyLoss)^thickness
 *
 * ── Public API ──────────────────────────────────────────────────────────────────
 *   createPenetration(ctx)  -> solver
 *   solver.evaluate(hit, dir, energy, weapon, out) -> Outcome
 *   solver.probeThickness(point, dir, body, maxT, mask, outPoint, outNormal) -> metres
 *   solver.canPenetrate(surfaceLike, thickness, energy, penPower) -> boolean
 *   solver.capacityFor(surfaceLike, energy, penPower) -> metres
 *   solver.surfaceOf(x) -> SurfaceDef            (ctx.materials, with a local fallback)
 *   solver.gain            gameplay multiplier on every capacity (default 1.85)
 *   solver.REF_ENERGY      3400 J, the reference round the SurfaceDefs table is built on
 *
 * Outcome (a reused object — copy anything you keep):
 *   { action:'stop'|'penetrate'|'ricochet',
 *     def, thickness, energyIn, energyOut, damageScale,
 *     entryPoint, entryNormal, exitPoint, exitNormal, dirOut,
 *     incidence (rad from normal), grazing 0..1, absorbed 0..1 }
 *
 * Emits nothing. Ballistics owns `bullet:penetrate` / `bullet:impact`.
 */
import * as THREE from 'three';
import { surfaceDefFor } from '../materials/SurfaceDefs.js';

/** Kinetic energy of the round the SurfaceDefs penetration table is authored for. */
export const REF_ENERGY = 3400;

/** Angle from the surface normal past which a ricochet becomes possible. */
export const RICOCHET_ANGLE = 65 * (Math.PI / 180);

/** Below this the round has nothing left to give — it always stops. */
export const MIN_EXIT_ENERGY = 45;

/** Rounds slower than this cannot ricochet; they just bury themselves. */
export const MIN_RICOCHET_ENERGY = 180;

const HALF_PI = Math.PI * 0.5;
const EPS = 1e-4;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A Hit-shaped scratch object. PhysicsWorld.raycast only ever writes into it. */
function makeHit() {
  return {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    fraction: 0,
    body: null,
    surface: 'concrete',
    material: null,
    faceIndex: -1,
    entity: null,
  };
}

/**
 * @param {object} ctx engine service context
 */
export default function createPenetration(ctx) {
  /* Every vector here is pooled: a firefight resolves dozens of these per second and
     none of them may allocate. */
  const _probeFrom = new THREE.Vector3();
  const _probeDir = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _axisA = new THREE.Vector3();
  const _axisB = new THREE.Vector3();
  const _hitA = makeHit();
  const _hitB = makeHit();

  const outcome = {
    action: 'stop',
    def: null,
    thickness: 0,
    energyIn: 0,
    energyOut: 0,
    damageScale: 1,
    absorbed: 1,
    incidence: 0,
    grazing: 0,
    entryPoint: new THREE.Vector3(),
    entryNormal: new THREE.Vector3(),
    exitPoint: new THREE.Vector3(),
    exitNormal: new THREE.Vector3(),
    dirOut: new THREE.Vector3(),
    exitBody: null,
    reason: '',
  };

  const rand = () => {
    const r = ctx.rng;
    return typeof r === 'function' ? r() : 0.5;
  };
  const gauss = () => {
    const r = ctx.rng;
    if (r && typeof r.gauss === 'function') return r.gauss();
    return (rand() + rand() + rand() - 1.5) * 1.1547;
  };

  /** Physical identity of whatever we just hit. MaterialLibrary first, table second. */
  function surfaceOf(x) {
    try {
      const def = ctx.materials?.surfaceOf?.(x);
      if (def && typeof def === 'object' && def.surface) return def;
    } catch {
      /* the table below is always right, just less specific */
    }
    try {
      return surfaceDefFor(x);
    } catch {
      return surfaceDefFor('concrete');
    }
  }

  /**
   * Best material description for a hit: the mesh material name if the body carries
   * one, otherwise the physics surface tag. `surfaceDefFor` resolves either.
   */
  function defForHit(hit) {
    if (!hit) return surfaceOf('concrete');
    const ud = hit.body?.userData;
    if (ud) {
      if (typeof ud.codMaterial === 'string') return surfaceOf(ud.codMaterial);
      if (typeof ud.material === 'string') return surfaceOf(ud.material);
    }
    if (hit.body?.mesh?.material) {
      const d = surfaceOf(hit.body.mesh.material);
      if (d && d.material !== 'concrete_cast') return d;
    }
    if (typeof hit.surface === 'string') return surfaceOf(hit.surface);
    return surfaceOf(hit.material || 'concrete');
  }

  /** Metres of this material the round can defeat, given its energy and pen power. */
  function capacityFor(x, energy, penPower) {
    const def = typeof x === 'object' && x?.maxPenetration !== undefined ? x : surfaceOf(x);
    if (!def.penetrable) return 0;
    const e = clamp((energy || 0) / REF_ENERGY, 0, 4);
    const p = clamp(penPower ?? 1, 0, 4);
    return Math.max(0, def.maxPenetration * p * e * api.gain);
  }

  function canPenetrate(x, thickness, energy, penPower) {
    return thickness <= capacityFor(x, energy, penPower) && energy > MIN_EXIT_ENERGY;
  }

  /**
   * True slab thickness along `dir` starting at `point`, measured by probing from the
   * far side back toward the entry. Returns −1 when no exit face is found within
   * `maxT` (a solid block, or geometry with no back face).
   *
   * Iterative because the first probe can land on an *unrelated* body sitting between
   * the entry and the probe origin; when that happens we shorten the probe to just in
   * front of that face and try again. Converges in two or three passes in practice.
   *
   * @returns {number} metres, or −1
   */
  function probeThickness(point, dir, body, maxT, mask, outPoint, outNormal) {
    const phys = ctx.physics;
    if (!phys?.raycast) return -1;
    _dir.copy(dir).normalize();
    let probe = Math.max(0.01, maxT);
    for (let i = 0; i < 5 && probe > EPS; i++) {
      _probeFrom.copy(_dir).multiplyScalar(probe).add(point);
      _probeDir.copy(_dir).negate();
      let h = null;
      try {
        h = phys.raycast(_probeFrom, _probeDir, probe, mask, _hitA);
      } catch {
        return -1;
      }
      if (!h) {
        // Nothing between the probe origin and the entry: the probe started inside a
        // solid, or this body simply has no back face within reach. Halve and retry.
        probe *= 0.5;
        continue;
      }
      const dEntry = probe - h.distance;
      if (h.body === body) {
        if (dEntry <= EPS) return -1;
        if (outPoint) outPoint.copy(h.point);
        // raycast flips the normal toward the ray, so it points back along −dir here.
        if (outNormal) outNormal.copy(h.normal).negate().normalize();
        return dEntry;
      }
      if (dEntry <= EPS) {
        probe *= 0.5;
        continue;
      }
      probe = dEntry - 1e-3;
    }
    return -1;
  }

  /** Rotate `v` off-axis by `angle` radians in a uniformly random plane. */
  function scatter(v, angle) {
    if (!(angle > 1e-6)) return v;
    // Any vector not parallel to v gives us a usable basis.
    _axisA.set(0, 1, 0);
    if (Math.abs(v.y) > 0.94) _axisA.set(1, 0, 0);
    _axisB.crossVectors(v, _axisA).normalize();
    _axisA.crossVectors(_axisB, v).normalize();
    const phi = rand() * Math.PI * 2;
    const mag = Math.tan(angle) * Math.abs(gauss()) * 0.6;
    v.addScaledVector(_axisB, Math.cos(phi) * mag);
    v.addScaledVector(_axisA, Math.sin(phi) * mag);
    return v.normalize();
  }

  /**
   * Decide what the round does at `hit`.
   *
   * @param {object} hit    physics Hit (normal already faces the incoming ray)
   * @param {THREE.Vector3} dir   normalised travel direction
   * @param {number} energy joules remaining
   * @param {object} weapon { penetration, mask, maxPenetrations, noRicochet }
   * @returns {object} the shared `outcome` object
   */
  function evaluate(hit, dir, energy, weapon) {
    const o = outcome;
    const def = defForHit(hit);
    o.def = def;
    o.energyIn = energy;
    o.energyOut = 0;
    o.thickness = 0;
    o.damageScale = 1;
    o.absorbed = 1;
    o.exitBody = null;
    o.reason = '';
    o.entryPoint.copy(hit.point);
    o.entryNormal.copy(hit.normal);
    o.exitPoint.copy(hit.point);
    o.exitNormal.copy(hit.normal);
    o.dirOut.copy(dir);
    o.action = 'stop';

    // Incidence measured from the surface normal: 0 = square on, π/2 = a graze.
    const cosI = clamp(-dir.dot(hit.normal), -1, 1);
    o.incidence = Math.acos(clamp(Math.abs(cosI), 0, 1));
    o.grazing = clamp((o.incidence - RICOCHET_ANGLE) / (HALF_PI - RICOCHET_ANGLE), 0, 1);

    const penPower = clamp(weapon?.penetration ?? 1, 0, 4);
    const mask = weapon?.mask ?? 0xffff;

    /* ── 1. ricochet ───────────────────────────────────────────────────────────
       Shallow angle onto something hard. The harder and the shallower, the more
       likely; a soft or soaking surface simply eats the round. */
    if (
      !weapon?.noRicochet &&
      energy > MIN_RICOCHET_ENERGY &&
      o.incidence > RICOCHET_ANGLE &&
      (def.ricochet || 0) > 0
    ) {
      const hardness = clamp(def.hardness ?? 0.5, 0, 1);
      const p =
        def.ricochet *
        (0.2 + 0.8 * o.grazing) *
        (0.35 + 0.65 * hardness) *
        clamp(energy / REF_ENERGY, 0.25, 1.4);
      if (rand() < p) {
        // Mirror about the normal, then bleed energy: a graze keeps far more of it.
        const keep = clamp(0.3 + 0.45 * o.grazing - 0.15 * (1 - hardness), 0.12, 0.8);
        o.dirOut.copy(dir).addScaledVector(hit.normal, 2 * cosI).normalize();
        scatter(o.dirOut, (0.16 - 0.11 * o.grazing) * (1.2 - hardness * 0.5));
        // Never let the deflection drive the round back into the surface.
        const into = o.dirOut.dot(hit.normal);
        if (into < 0.02) o.dirOut.addScaledVector(hit.normal, 0.06 - into).normalize();
        o.action = 'ricochet';
        o.energyOut = energy * keep;
        o.absorbed = 1 - keep;
        o.damageScale = clamp(keep * 0.85, 0.08, 0.7);
        o.exitPoint.copy(hit.point).addScaledVector(hit.normal, 0.008);
        o.exitNormal.copy(hit.normal);
        o.reason = 'ricochet';
        if (o.energyOut < MIN_EXIT_ENERGY) {
          o.action = 'stop';
          o.energyOut = 0;
          o.reason = 'ricochet-spent';
        }
        return o;
      }
    }

    /* ── 2. penetration ─────────────────────────────────────────────────────── */
    if (!def.penetrable) {
      o.reason = 'impenetrable';
      return o;
    }
    const capacity = capacityFor(def, energy, penPower);
    if (!(capacity > 0.001)) {
      o.reason = 'no-capacity';
      return o;
    }
    // A steep angle means a longer path through the same slab; give the probe room.
    const probeLimit = Math.min(capacity * 1.6 + 0.05, 3.5);
    const thickness = probeThickness(
      hit.point,
      dir,
      hit.body,
      probeLimit,
      mask,
      o.exitPoint,
      o.exitNormal
    );
    if (thickness < 0) {
      o.reason = 'no-exit';
      return o;
    }
    o.thickness = thickness;
    if (thickness > capacity) {
      o.reason = 'too-thick';
      return o;
    }

    const frac = clamp(thickness / capacity, 0, 1);
    const bleed = Math.pow(Math.max(0.02, 1 - (def.energyLoss ?? 0.5)), thickness);
    // Density term: shoving a heavy medium aside costs momentum even when thin.
    const drag = 1 - clamp(((def.density ?? 1200) / 8000) * thickness * 0.9, 0, 0.5);
    const keep = clamp((1 - 0.85 * frac) * bleed * drag, 0, 1);
    const energyOut = energy * keep;
    if (energyOut < MIN_EXIT_ENERGY) {
      o.reason = 'spent-inside';
      return o;
    }

    o.action = 'penetrate';
    o.energyOut = energyOut;
    o.absorbed = 1 - keep;
    // Wall-bang damage: keeps the round lethal through drywall, chips it hard through
    // reinforced concrete. Pen-rated weapons hold on to more of it.
    o.damageScale = clamp(Math.pow(keep, 0.55) * (0.68 + 0.32 * penPower), 0.12, 1);

    // Yaw/tumble on exit — small, but enough that a long wall-bang is not a laser.
    o.dirOut.copy(dir);
    scatter(o.dirOut, 0.05 * (1 - keep) * (0.6 + 0.8 * clamp(def.hardness ?? 0.5, 0, 1)));
    o.exitPoint.addScaledVector(o.dirOut, 0.006);
    o.reason = 'through';
    return o;
  }

  const api = {
    /** Gameplay multiplier on every penetration capacity. 1 = strict real-world. */
    gain: 1.85,
    REF_ENERGY,
    RICOCHET_ANGLE,
    MIN_EXIT_ENERGY,
    evaluate,
    probeThickness,
    canPenetrate,
    capacityFor,
    surfaceOf,
    defForHit,
    scatter,
    outcome,
    /** Scratch hit other ballistics code can borrow for its own probes. */
    scratchHit: _hitB,
  };

  return api;
}
