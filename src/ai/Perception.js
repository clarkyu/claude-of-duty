/**
 * Perception.js — the bots' senses. Owner: AI agent.
 *
 * A bot never "just knows" where you are. Everything it believes comes from three
 * channels that all feed one number per target — `awareness`, 0..1:
 *
 *   sight    a cone with a hard limit at `fov`, a peripheral band beyond it that only
 *            picks up movement, distance falloff, and a line-of-sight raycast against
 *            ctx.physics that is re-run on a budget (never every bot every frame).
 *            Contrast modifiers: a sprinting target is spotted ~3x faster than a
 *            crouched, still one, and a muzzle flash is spotted almost instantly.
 *   hearing  driven off the bus — `weapon:fire`, `player:step`, `explosion`,
 *            `bullet:impact` — attenuated by distance and by whether a wall is in the
 *            way. Hearing gives a *position*, not a target lock.
 *   memory   a last-known position that ages: confidence decays, and the bot keeps
 *            searching the place it last saw you rather than snapping onto your new
 *            location.
 *
 * Awareness has to climb past 1.0 before a bot will engage, and the climb takes
 * `1 / detectRate` seconds at best — that is the "no instant omniscient aim" rule.
 *
 * ── Public API ──────────────────────────────────────────────────────────────────
 *   createPerception(ctx) -> {
 *     sensor(owner) -> Sensor,  release(sensor),
 *     update(dt),               drives the shared raycast budget
 *     registerTarget(entity) / unregisterTarget(entity),
 *     setDifficulty(cfg), stats, dispose()
 *   }
 *   Sensor = {
 *     tracks: Map<entity, Track>, best: Track|null,
 *     awareness, alerted, alarmLevel,
 *     lastNoise: {pos, time, loudness} | null,
 *     see(point) -> boolean          one-off LOS test from this sensor's eye
 *     forget(entity), reset()
 *   }
 *   Track = { entity, awareness, visible, seen, lastSeen, lastKnownPos, lastKnownVel,
 *             distance, confidence, exposure, threat }
 *
 * Events consumed: weapon:fire, player:step, player:land, explosion, bullet:impact,
 *                  grenade:detonate, ai:fire (own bots, so they do not alert on
 *                  themselves), entity:death.
 */
import * as THREE from 'three';

const WORLD_MASK = 1 | 8; // GROUP.WORLD | GROUP.PROP
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const DIFFICULTY = {
  recruit: { detectRate: 0.55, sight: 42, fov: 1.75, reaction: [0.62, 0.95], hearing: 0.7 },
  regular: { detectRate: 0.95, sight: 58, fov: 1.92, reaction: [0.38, 0.62], hearing: 1.0 },
  hardened: { detectRate: 1.45, sight: 74, fov: 2.05, reaction: [0.24, 0.42], hearing: 1.25 },
  veteran: { detectRate: 2.0, sight: 92, fov: 2.2, reaction: [0.16, 0.3], hearing: 1.5 },
};

export default function createPerception(ctx) {
  const sensors = [];
  const targets = new Set();
  const unsubs = [];
  let cfg = { ...DIFFICULTY.regular };
  let rrIndex = 0;

  const stats = { rays: 0, sensors: 0, tracks: 0, noises: 0 };

  const _eye = new THREE.Vector3();
  const _tp = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  /** Chest/eye point of an entity (bots and the player both expose `position`). */
  function aimPoint(e, out, frac = 1) {
    const p = e?.eyePosition || e?.position;
    if (!p) return out.set(0, -9999, 0);
    if (e?.eyePosition && frac >= 0.999) return out.copy(p);
    const h = e?.eyeHeight ?? (e?.stance === 'crouch' ? 1.05 : 1.62);
    return out.set(p.x, p.y + h * frac, p.z);
  }

  function isAlive(e) {
    return !!e && e.alive !== false && (e.health === undefined || e.health > 0);
  }

  function losClear(from, to, ignoreEntity) {
    const phys = ctx.physics;
    if (!phys?.raycast) return true;
    _dir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const d = _dir.length();
    if (d < 0.05) return true;
    _dir.multiplyScalar(1 / d);
    stats.rays++;
    const hit = phys.raycast(from, _dir, d - 0.15, WORLD_MASK);
    if (!hit) return true;
    if (ignoreEntity && hit.entity === ignoreEntity) return true;
    return false;
  }

  /* ── tracks ────────────────────────────────────────────────────────────── */

  function makeTrack(entity) {
    return {
      entity,
      awareness: 0,
      visible: false,
      seen: false,
      firstSeen: -1,
      lastSeen: -1,
      lastKnownPos: new THREE.Vector3(),
      lastKnownVel: new THREE.Vector3(),
      distance: Infinity,
      confidence: 0,
      exposure: 0,
      threat: 0,
      trackTime: 0,
      /** Seconds the target has been effectively stationary. Drives grenade use. */
      staticFor: 0,
      losAt: -1,
      losOk: false,
    };
  }

  /* ── sensor ────────────────────────────────────────────────────────────── */

  function sensor(owner) {
    const s = {
      owner,
      tracks: new Map(),
      best: null,
      awareness: 0,
      alerted: false,
      alarmLevel: 0,
      lastNoise: null,
      lastNoiseTime: -99,
      losHz: 9,
      sight: cfg.sight,
      fov: cfg.fov,
      detectRate: cfg.detectRate,
      hearing: cfg.hearing,
      enabled: true,
      _losCursor: 0,
      see(point) {
        aimPoint(owner, _eye);
        return losClear(_eye, point, null);
      },
      track(entity) {
        return s.tracks.get(entity) || null;
      },
      forget(entity) {
        s.tracks.delete(entity);
        if (s.best?.entity === entity) s.best = null;
      },
      reset() {
        s.tracks.clear();
        s.best = null;
        s.awareness = 0;
        s.alerted = false;
        s.alarmLevel = 0;
        s.lastNoise = null;
      },
    };
    sensors.push(s);
    stats.sensors = sensors.length;
    return s;
  }

  function release(s) {
    const i = sensors.indexOf(s);
    if (i >= 0) sensors.splice(i, 1);
    stats.sensors = sensors.length;
  }

  /* ── hearing ───────────────────────────────────────────────────────────── */

  const _noise = new THREE.Vector3();

  /**
   * @param {{x,y,z}} pos  @param {number} loudness metres of "carry"
   * @param {object} [source] the entity that made it (never alerts itself)
   */
  function hear(pos, loudness, source, kind) {
    if (!pos) return;
    stats.noises++;
    const now = ctx.time?.elapsed ?? 0;
    _noise.set(pos.x ?? 0, pos.y ?? 0, pos.z ?? 0);
    for (const s of sensors) {
      if (!s.enabled || s.owner === source) continue;
      // Friendly noise is not a contact. Without this every bot investigates the
      // squadmate standing next to it the moment anybody opens fire.
      if (source && source.team && s.owner?.team && source.team === s.owner.team) continue;
      const op = s.owner?.position;
      if (!op) continue;
      const d = Math.hypot(op.x - _noise.x, op.y - _noise.y, op.z - _noise.z);
      const reach = loudness * s.hearing;
      if (d > reach) continue;
      let att = 1 - d / reach;
      // Walls muffle: one raycast per noise per bot, only for the close ones.
      if (d > 3 && d < reach * 0.85) {
        aimPoint(s.owner, _eye);
        if (!losClear(_eye, _noise, null)) att *= 0.45;
      }
      const gain = att * att * (kind === 'gunfire' ? 1.0 : 0.55);
      if (gain < 0.03) continue;
      s.alarmLevel = clamp01(s.alarmLevel + gain * 0.9);
      // Reuse the sensor's noise record: gunfire fires this dozens of times a second.
      if (!s.lastNoise) s.lastNoise = { pos: new THREE.Vector3(), time: 0, loudness: 0, kind: '', source: null };
      s.lastNoise.pos.copy(_noise);
      s.lastNoise.time = now;
      s.lastNoise.loudness = gain;
      s.lastNoise.kind = kind;
      s.lastNoise.source = source || null;
      s.lastNoiseTime = now;
      // A noise from a known target refines its last-known position; an unknown noise
      // only raises the alarm and gives a place to investigate.
      if (source && isAlive(source)) {
        let t = s.tracks.get(source);
        if (!t) {
          t = makeTrack(source);
          s.tracks.set(source, t);
        }
        t.awareness = Math.max(t.awareness, Math.min(0.92, t.awareness + gain * 0.8));
        // Hearing is imprecise: scatter the reported position with the distance.
        const err = clamp(d * 0.12, 0.4, 4.5) * (1 - gain * 0.6);
        const rng = ctx.rng || Math.random;
        t.lastKnownPos.set(
          _noise.x + (rng() * 2 - 1) * err,
          _noise.y,
          _noise.z + (rng() * 2 - 1) * err
        );
        t.confidence = Math.max(t.confidence, gain * 0.7);
        t.lastSeen = t.lastSeen < 0 ? now - 3 : t.lastSeen;
      }
    }
  }

  /* ── per-frame ─────────────────────────────────────────────────────────── */

  const FORGET_TIME = 11;

  function updateSensor(s, dt, now, budget) {
    if (!s.enabled || !isAlive(s.owner)) return budget;
    aimPoint(s.owner, _eye);
    const look = s.owner.lookDir || s.owner.forwardDir;
    if (look) _fwd.copy(look);
    else _fwd.set(0, 0, 1);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();

    let best = null;
    let bestScore = -Infinity;

    for (const entity of targets) {
      if (entity === s.owner) continue;
      let t = s.tracks.get(entity);
      const alive = isAlive(entity);
      if (!alive) {
        if (t) t.visible = false;
        continue;
      }
      if (!t) {
        t = makeTrack(entity);
        s.tracks.set(entity, t);
      }

      aimPoint(entity, _tp, 0.72); // upper chest
      const dx = _tp.x - _eye.x;
      const dy = _tp.y - _eye.y;
      const dz = _tp.z - _eye.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      t.distance = dist;

      let vis = 0;
      if (dist <= s.sight) {
        const inv = 1 / Math.max(1e-4, dist);
        const cosA = (dx * _fwd.x + dz * _fwd.z) * inv;
        const half = s.fov * 0.5;
        const cosLimit = Math.cos(half);
        const cosPeriph = Math.cos(Math.min(Math.PI * 0.98, half * 1.35));
        if (cosA > cosPeriph) {
          // Cone falloff: full inside the cone, fading through the peripheral band.
          const coneF = cosA >= cosLimit
            ? 1
            : clamp01((cosA - cosPeriph) / Math.max(1e-4, cosLimit - cosPeriph)) * 0.35;
          // Distance falloff — sharp beyond 60 % of max sight.
          const dn = dist / s.sight;
          const distF = dn < 0.35 ? 1 : clamp01(1 - (dn - 0.35) / 0.65) ** 1.35;
          vis = coneF * distF;
        }
      }

      // Contrast: motion, stance and shooting all change how fast you are picked up.
      if (vis > 0) {
        const spd = entity.speed ?? (entity.velocity ? Math.hypot(entity.velocity.x, entity.velocity.z) : 0);
        let contrast = 0.55 + clamp01(spd / 5.5) * 0.75;
        if (entity.stance === 'crouch') contrast *= 0.72;
        if (entity.stance === 'prone') contrast *= 0.5;
        if (entity.state === 'sprint' || entity.state === 'tacsprint') contrast *= 1.25;
        if (now - (entity.lastFireTime ?? -99) < 0.35) contrast = Math.max(contrast, 2.4);
        vis *= contrast;
      }

      // Line of sight — budgeted, staggered, and cached in between.
      const period = 1 / s.losHz;
      if (vis > 0 && (budget > 0 || t.losAt < 0) && now - t.losAt >= period) {
        t.losAt = now;
        budget--;
        // Two rays: chest first, then head, so a bot behind a low wall is only half
        // visible instead of binary.
        aimPoint(entity, _tp, 0.72);
        const chest = losClear(_eye, _tp, entity);
        let head = chest;
        if (!chest) {
          aimPoint(entity, _tp, 0.95);
          head = losClear(_eye, _tp, entity);
        }
        t.losOk = chest || head;
        t.exposure = chest && head ? 1 : (chest || head ? 0.5 : 0);
      }
      if (!t.losOk) vis = 0;

      // "Has he stopped moving?" — measured from the believed position, so it also
      // works while the target is only heard, not seen.
      {
        const sp = entity.speed ?? (entity.velocity ? Math.hypot(entity.velocity.x, entity.velocity.z) : 0);
        if (t.confidence > 0.2 && sp < 0.8) t.staticFor += dt;
        else t.staticFor = 0;
      }

      t.visible = vis > 0.02;
      if (t.visible) {
        if (t.firstSeen < 0) t.firstSeen = now;
        t.lastSeen = now;
        t.seen = true;
        t.trackTime += dt;
        const p = entity.position;
        if (entity.velocity) {
          t.lastKnownVel.set(entity.velocity.x, entity.velocity.y, entity.velocity.z);
        }
        t.lastKnownPos.set(p.x, p.y, p.z);
        t.confidence = 1;
        t.awareness = clamp01(t.awareness + vis * s.detectRate * dt);
      } else {
        t.trackTime = Math.max(0, t.trackTime - dt * 1.6);
        const age = now - t.lastSeen;
        // Memory: the belief decays, and the remembered position drifts along the
        // velocity the target had when it broke contact (a real lead, not a cheat).
        if (t.lastSeen >= 0 && age < 1.4 && t.lastKnownVel.lengthSq() > 0.2) {
          t.lastKnownPos.addScaledVector(t.lastKnownVel, dt * clamp01(1 - age / 1.4));
        }
        t.confidence = Math.max(0, t.confidence - dt * 0.28);
        const decay = t.awareness > 1 ? 0.16 : 0.34;
        t.awareness = Math.max(0, t.awareness - decay * dt);
        if (t.lastSeen >= 0 && age > FORGET_TIME && t.awareness <= 0.02) {
          t.seen = false;
          t.confidence = 0;
        }
      }
      t.threat = t.awareness * (t.visible ? 1.6 : 1) - dist * 0.004;

      if (t.threat > bestScore && (t.awareness > 0.05 || t.visible)) {
        bestScore = t.threat;
        best = t;
      }
    }

    s.best = best;
    s.awareness = best ? best.awareness : 0;
    s.alerted = !!best && best.awareness >= 1;
    s.alarmLevel = Math.max(s.alarmLevel - dt * 0.09, s.awareness);
    return budget;
  }

  function update(dt) {
    const now = ctx.time?.elapsed ?? 0;
    const n = sensors.length;
    if (!n) return;
    // Shared raycast budget, round-robin so no bot is starved.
    let budget = Math.max(4, Math.ceil(n * 1.5));
    stats.tracks = 0;
    for (let i = 0; i < n; i++) {
      const s = sensors[(rrIndex + i) % n];
      budget = updateSensor(s, dt, now, budget);
      stats.tracks += s.tracks.size;
    }
    rrIndex = (rrIndex + 1) % n;
  }

  /* ── bus wiring ────────────────────────────────────────────────────────── */

  function attributeShooter(origin) {
    // `weapon:fire` does not name the shooter; the local player is the only source of
    // that event, and the muzzle is always within a metre of their eye.
    const pl = ctx.player;
    if (!pl?.position || !origin) return null;
    const d = Math.hypot(pl.position.x - origin.x, pl.position.z - origin.z);
    return d < 2.2 ? pl : null;
  }

  function wire() {
    const on = (name, fn) => {
      const u = ctx.bus?.on?.(name, fn);
      if (u) unsubs.push(u);
    };
    on('weapon:fire', (e) => {
      const src = attributeShooter(e?.origin);
      const suppressed = !!e?.weapon?.suppressed || !!e?.suppressed;
      hear(e?.origin, suppressed ? 26 : 95, src, 'gunfire');
    });
    on('ai:fire', (e) => {
      hear(e?.origin, e?.suppressed ? 20 : 80, e?.bot, 'gunfire');
    });
    on('player:step', (e) => {
      const pos = e?.position || ctx.player?.position;
      const loud = 4.5 + clamp(e?.speed ?? 3, 0, 8) * 1.9;
      hear(pos, loud, ctx.player, 'footstep');
    });
    on('player:land', (e) => {
      hear(e?.position || ctx.player?.position, e?.hard ? 22 : 10, ctx.player, 'footstep');
    });
    on('explosion', (e) => hear(e?.point, 130, e?.owner || null, 'explosion'));
    on('grenade:detonate', (e) => hear(e?.point, 130, e?.owner || null, 'explosion'));
    on('bullet:impact', (e) => {
      // Only bullets that land near somebody are worth hearing about.
      if (!e?.point) return;
      hear(e.point, 16, e.attacker || null, 'impact');
    });
    on('entity:death', (e) => {
      const t = e?.target;
      if (!t) return;
      targets.delete(t);
      for (const s of sensors) s.forget(t);
    });
  }

  wire();

  return {
    sensor,
    release,
    update,
    hear,
    losClear,
    aimPoint,
    registerTarget(e) {
      if (e) targets.add(e);
    },
    unregisterTarget(e) {
      targets.delete(e);
      for (const s of sensors) s.forget(e);
    },
    get targets() {
      return targets;
    },
    setDifficulty(next) {
      cfg = { ...cfg, ...next };
      for (const s of sensors) {
        s.sight = cfg.sight;
        s.fov = cfg.fov;
        s.detectRate = cfg.detectRate;
        s.hearing = cfg.hearing;
      }
    },
    get config() {
      return cfg;
    },
    stats,
    dispose() {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* best effort */
        }
      }
      unsubs.length = 0;
      sensors.length = 0;
      targets.clear();
    },
  };
}
