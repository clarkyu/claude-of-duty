/**
 * AISystem.js — enemy AI. Owner: AI agent.  Publishes `ctx.ai`.
 * Files owned: this, Navmesh.js, Perception.js, Bot.js, Squad.js, CharacterBuilder.js
 *
 * Composition:
 *   CharacterBuilder  procedural soldier — rig, skinned mesh, kit, hitboxes
 *   Navmesh           A* + funnel + string pull over `ctx.level.navRegions`
 *   Perception        vision cone / LOS budget / hearing / decaying memory
 *   Bot               HSM brain, gunplay, procedural animation, ragdoll handoff
 *   Squad             contact sharing, roles (suppress / flank), cover reservation
 *
 * ── Public API (ctx.ai) ─────────────────────────────────────────────────────────
 *   ready, bots                       live bot list (Ballistics reads this)
 *   spawn(opts) -> bot                {position, yaw, team, squad, variant, skill}
 *   despawn(bot) / clear()
 *   setDifficulty('recruit'|'regular'|'hardened'|'veteran')
 *   difficulty, count, alive
 *   setEnabled(bool)
 *   debugDraw(on)                     navmesh + live paths + state labels
 *   nav, perception, squads, builder  the sub-modules, for tools
 *   stats
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   entity:damage      route damage from Ballistics into the right bot
 *   entity:suppressed  duck, widen the cone, fire blind (friendly fire ignored)
 *   explosion          concussion only — Ballistics already deals the blast damage
 *   level:ready        (re)build the navmesh and place the opposition
 *   debug:pose         {bots:'engaged'|'idle'|'none'|n, aiDebug, difficulty}
 *   quality:changed    trims the bot budget
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   entity:death, ai:fire, ai:callout, ai:state, ai:squad, ai:ready
 */
import * as THREE from 'three';
import createCharacterBuilder from './CharacterBuilder.js';
import createNavmesh from './Navmesh.js';
import createPerception, { DIFFICULTY } from './Perception.js';
import createSquads from './Squad.js';
import { createBot } from './Bot.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Per-difficulty shooting profile, handed to every bot. */
const SKILL = {
  recruit: {
    reaction: [0.55, 0.95], turnRate: 2.3, aimError: 0.105, aimTighten: 0.9,
    aimFloor: 0.028, burst: [2, 4], burstGap: [0.6, 1.5], reloadTime: 3.0,
    accuracyMove: 2.4, grenadeChance: 0.25, courage: 0.35,
  },
  regular: {
    reaction: [0.36, 0.62], turnRate: 3.2, aimError: 0.078, aimTighten: 1.35,
    aimFloor: 0.017, burst: [3, 6], burstGap: [0.42, 1.1], reloadTime: 2.7,
    accuracyMove: 2.0, grenadeChance: 0.45, courage: 0.55,
  },
  hardened: {
    reaction: [0.24, 0.42], turnRate: 4.4, aimError: 0.055, aimTighten: 1.9,
    aimFloor: 0.010, burst: [4, 8], burstGap: [0.3, 0.8], reloadTime: 2.35,
    accuracyMove: 1.7, grenadeChance: 0.6, courage: 0.72,
  },
  veteran: {
    reaction: [0.15, 0.28], turnRate: 5.8, aimError: 0.04, aimTighten: 2.6,
    aimFloor: 0.006, burst: [5, 10], burstGap: [0.22, 0.6], reloadTime: 2.1,
    accuracyMove: 1.5, grenadeChance: 0.75, courage: 0.9,
  },
};

const BUDGET = { low: 4, medium: 6, high: 8, ultra: 10 };
const CORPSE_LIFETIME = 26;

export default function createAISystem(ctx) {
  const bots = [];
  const unsubs = [];
  const byBody = new WeakMap();
  let builder = null;
  let nav = null;
  let perception = null;
  let squads = null;
  let enabled = true;
  let disposed = false;
  let difficulty = 'regular';
  let headless = false;
  let quality = 1;
  let debugOn = false;
  let spawnQueue = 0;
  let levelReady = false;
  let warnedOnce = new Set();

  const stats = {
    bots: 0, alive: 0, spawned: 0, killed: 0, updateMs: 0,
    paths: 0, rays: 0, triangles: 0,
  };

  const warn = (tag, err) => {
    if (warnedOnce.has(tag)) return;
    warnedOnce.add(tag);
    console.warn(`[ai] ${tag}:`, err?.message || err || '');
  };

  const api = {
    ready: false,
    bots,
    stats,
    get difficulty() {
      return difficulty;
    },
    get count() {
      return bots.length;
    },
    get alive() {
      let n = 0;
      for (const b of bots) if (b.alive) n++;
      return n;
    },
  };

  /* ── spawn / despawn ───────────────────────────────────────────────────── */

  const _spawnPos = new THREE.Vector3();

  function pickSpawn(team) {
    const rng = ctx.rng || Math.random;
    const pts = ctx.level?.spawnPoints;
    if (pts?.length) {
      const pool = pts.filter((p) => (team ? p.team === team || p.team === 'ffa' : true));
      const list = pool.length ? pool : pts;
      // Farthest from the player, so a bot never materialises in your face.
      const pp = ctx.player?.position;
      let best = list[Math.floor(rng() * list.length)];
      if (pp) {
        let bestD = -1;
        for (let i = 0; i < 5; i++) {
          const c = list[Math.floor(rng() * list.length)];
          const d = Math.hypot(c.pos.x - pp.x, c.pos.z - pp.z) + rng() * 6;
          if (d > bestD) {
            bestD = d;
            best = c;
          }
        }
      }
      return { pos: best.pos, yaw: best.yaw ?? 0 };
    }
    return { pos: _spawnPos.set((rng() * 2 - 1) * 20, 0, (rng() * 2 - 1) * 20), yaw: rng() * Math.PI * 2 };
  }

  /**
   * @param {{position?, yaw?, team?, squad?, variant?, skill?, health?}} [opts]
   */
  function spawn(opts = {}) {
    if (disposed) return null;
    const rng = ctx.rng || Math.random;
    let character = null;
    try {
      // Height is quantised: the builder caches a whole assembled model (geometry,
      // skin weights and the baked occlusion) per (variant, height, quality), so a
      // continuous height means a cache miss for every single soldier and six full
      // rebuilds at spawn. Three buckets still reads as a squad of different men.
      const h = opts.height ?? [1.755, 1.80, 1.845][Math.floor(rng() * 3) % 3];
      character = builder?.build({
        variant: opts.variant ?? Math.floor(rng() * 3),
        height: h,
        quality,
      });
    } catch (err) {
      warn('character build failed', err);
      return null;
    }
    if (!character) return null;

    const squadId = opts.squad ?? Math.floor(bots.length / 3);
    const bot = createBot(ctx, { nav, perception, character, squad: squads }, {
      team: opts.team || 'B',
      squadId,
      name: opts.name,
      grenades: opts.grenades,
    });
    bot.sensor = perception?.sensor(bot) || null;
    bot.setSkill(opts.skill || SKILL[difficulty] || SKILL.regular);
    if (opts.health) {
      bot.maxHealth = opts.health;
      bot.health = opts.health;
    }

    const sp = opts.position
      ? { pos: opts.position, yaw: opts.yaw ?? 0 }
      : pickSpawn(opts.team || 'B');
    // Snap onto the navmesh so nobody spawns inside a wall or in mid-air.
    _spawnPos.set(sp.pos.x, sp.pos.y ?? 0, sp.pos.z);
    if (nav?.ready) {
      const k = nav.nearestWalkable(_spawnPos.x, _spawnPos.z, 8);
      if (k >= 0) {
        const c = nav.cellCentre(k, new THREE.Vector3());
        _spawnPos.set(c.x, c.y, c.z);
      }
      _spawnPos.y = nav.groundAt(_spawnPos.x, _spawnPos.z);
    } else if (ctx.level?.groundY) {
      _spawnPos.y = ctx.level.groundY(_spawnPos.x, _spawnPos.z);
    }

    ctx.scene?.add(character.root);
    bot.spawn(_spawnPos, sp.yaw ?? 0);
    squads?.add(bot, squadId);
    bots.push(bot);
    stats.spawned++;
    stats.bots = bots.length;
    stats.triangles = builder?.stats?.triangles ?? 0;
    return bot;
  }

  function despawn(bot) {
    const i = bots.indexOf(bot);
    if (i >= 0) bots.splice(i, 1);
    squads?.remove(bot);
    perception?.release?.(bot.sensor);
    try {
      bot.dispose();
    } catch (err) {
      warn('despawn', err);
    }
    stats.bots = bots.length;
  }

  function clear() {
    for (const b of bots.slice()) despawn(b);
  }

  /* ── population ───────────────────────────────────────────────────────── */

  function budget() {
    const tier = ctx.settings?.tier || 'high';
    let n = BUDGET[tier] ?? 6;
    if (headless) n = Math.min(n, 6);
    return n;
  }

  function populate(target) {
    const want = clamp(target ?? budget(), 0, 24);
    let guard = 0;
    while (bots.length < want && guard++ < 32) {
      if (!spawn({ team: 'B', squad: Math.floor(bots.length / 3) })) break;
    }
    while (bots.length > want) despawn(bots[bots.length - 1]);
  }

  /* ── damage routing ────────────────────────────────────────────────────── */

  function resolveTarget(t) {
    if (!t) return null;
    if (t.isBot) return t;
    if (t.userData?.bot) return t.userData.bot;
    const cached = byBody.get(t);
    if (cached) return cached;
    for (const b of bots) if (b === t) return b;
    return null;
  }

  function onDamage(e) {
    const bot = resolveTarget(e?.target);
    if (!bot || !bot.alive) return;
    bot.damage(e);
  }

  function onSuppressed(e) {
    const bot = resolveTarget(e?.target);
    if (!bot || !bot.alive) return;
    // Rounds from your own side cracking past do not make you dive for cover.
    const att = e?.attacker;
    if (att?.isBot && att.team === bot.team) return;
    bot.onSuppressed(e?.amount ?? 0.3);
    // Incoming fire is also information about where the shooter is.
    if (e?.attacker && e.attacker.position) {
      squads?.shareContact?.(bot, e.attacker, e.attacker.position, 0.5);
      const t = bot.sensor?.tracks?.get(e.attacker);
      if (t) t.awareness = Math.max(t.awareness, 0.6);
    }
  }

  const _ex = new THREE.Vector3();

  function onExplosion(e) {
    if (!e?.point) return;
    const radius = e.radius ?? 8;
    const dmg = e.damage ?? 110;
    _ex.set(e.point.x, e.point.y, e.point.z);
    for (const b of bots) {
      if (!b.alive) continue;
      const d = Math.hypot(b.position.x - _ex.x, b.position.y + 0.9 - _ex.y, b.position.z - _ex.z);
      if (d > radius) continue;
      // Damage is Ballistics' job — it already walks `ctx.ai.bots` for every blast and
      // emits `entity:damage`. Doubling it up here would halve every grenade's range.
      b.onSuppressed((1 - d / radius) ** 1.7 * 0.9);
    }
    void dmg;
  }

  /* ── debug pose support ────────────────────────────────────────────────── */

  const _camPos = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _side = new THREE.Vector3();
  const _cand = new THREE.Vector3();
  const _chest = new THREE.Vector3();
  const _ray = new THREE.Vector3();

  /**
   * Is there a clear view from the camera to a body standing at `p`?
   * (Uses its own scratch vectors — `p` is usually `_cand`, and clobbering the
   * caller's candidate here is how you end up with six soldiers stacked on a unit
   * direction vector at the world origin.)
   */
  function visibleFromCamera(p) {
    const phys = ctx.physics;
    if (!phys?.raycast) return true;
    _chest.set(p.x, p.y + 1.25, p.z);
    _ray.subVectors(_chest, _camPos);
    const d = _ray.length();
    if (d < 3 || d > 60) return false;
    _ray.multiplyScalar(1 / d);
    const hit = phys.raycast(_camPos, _ray, d - 0.6, 1 | 8);
    return !hit;
  }

  const _aimPt = new THREE.Vector3();
  const _cov = new THREE.Vector3();
  const _covStand = new THREE.Vector3();

  /**
   * Nearest piece of usable cover to `p`, and the spot a man would stand behind it
   * given that the threat is at `from`. Waist-to-chest blockers only: a kerb is not
   * cover and a building is not something you stand behind, you stand *in* it.
   *
   * Sources are the props system's own footprint index (barriers, drums, crates,
   * wrecks, spools) and the level's box colliders (jersey barriers, planters, low
   * walls) — nothing here invents geometry, so a soldier is always behind something
   * that is genuinely there.
   *
   * @returns {{stand: THREE.Vector3, top: number}|null}
   */
  function findCoverNear(p, from, radius = 4.2) {
    let best = null;
    let bestD = Infinity;
    const consider = (cx, cz, y0, y1, rx, rz) => {
      const top = y1;
      if (top < 0.55 || top > 1.85) return;
      const dx = cx - p.x;
      const dz = cz - p.z;
      const d = Math.hypot(dx, dz);
      if (d > radius) return;
      if (d < bestD) {
        bestD = d;
        best = { cx, cz, top, rx, rz, y0 };
      }
    };
    try {
      for (const f of ctx.props?.footprints?.() || []) consider(f.x, f.z, f.y0, f.y1, f.rx, f.rz);
    } catch {
      /* props may not be up */
    }
    const cols = ctx.level?.colliders;
    if (Array.isArray(cols)) {
      for (const c of cols) {
        if (!c || c.type !== 'box') continue;
        const pos = c.pos || c.position;
        const h = c.halfExtents;
        if (!pos || !h) continue;
        const hx = h.x ?? h[0] ?? 0;
        const hy = h.y ?? h[1] ?? 0;
        const hz = h.z ?? h[2] ?? 0;
        if (hy > 1.1 || hy < 0.24) continue;
        if (hx > 4 || hz > 4) continue; // a 40 m wall is not "a piece of cover"
        consider(pos.x, pos.z, (pos.y ?? 0) - hy, (pos.y ?? 0) + hy, hx, hz);
      }
    }
    if (!best) return null;
    /* stand on the far side of it from the threat, one stand-off back */
    _cov.set(best.cx - from.x, 0, best.cz - from.z);
    if (_cov.lengthSq() < 1e-4) return null;
    _cov.normalize();
    const back = Math.max(best.rx, best.rz) + 0.5;
    _covStand.set(best.cx + _cov.x * back, p.y, best.cz + _cov.z * back);
    if (nav?.ready) {
      const k = nav.nearestWalkable(_covStand.x, _covStand.z, 2.0);
      if (k < 0) return null;
      _covStand.y = nav.groundAt(_covStand.x, _covStand.z);
    } else {
      _covStand.y = ctx.level?.groundY?.(_covStand.x, _covStand.z) ?? p.y;
    }
    if (!visibleFromCamera(_covStand)) return null;
    return { stand: _covStand.clone(), top: best.top };
  }

  /* ── staged combat: keep the frame alive while a pose holds ─────────────── */

  /**
   * A capture is one rendered frame at the end of a warm-up. A muzzle flash lives for
   * about three frames and a burst gap is half a second, so whether the "combat" pose
   * contained any combat at all was a coin flip — and it kept coming up tails. While a
   * pose is staged this keeps at least one gun talking every single frame and puts
   * incoming rounds (tracer + impact spark + dust) on the geometry around the lens,
   * which is what the player is actually experiencing.
   */
  const staged = { on: false, until: 0, list: [], i: 0, frame: 0 };
  const _sp0 = new THREE.Vector3();
  const _sp1 = new THREE.Vector3();
  const _sdir = new THREE.Vector3();
  const _sup = new THREE.Vector3();

  function tickStaged() {
    const now = ctx.time?.elapsed ?? 0;
    if (!staged.on || now > staged.until) {
      staged.on = false;
      return;
    }
    staged.frame++;
    const rng = ctx.rng || Math.random;
    const live = staged.list.filter((b) => b && b.alive);
    if (!live.length) return;

    /**
     * The HUD side of being in a firefight: a hitmarker for the player's own burst
     * and a directional arc for the rounds coming back. Raised here rather than in
     * the pose handler so the HUD's own pose reset (which clears held transients)
     * has already run.
     */
    if (staged.frame === 1) {
      try {
        ctx.camera?.getWorldPosition(_camPos);
        ctx.bus?.emit?.('hud:hitmarker', { lethal: false, headshot: false });
        const src = live[0]?.position;
        if (src) {
          const yaw = ctx.player?.yaw ?? ctx.camera?.rotation?.y ?? 0;
          ctx.bus?.emit?.('hud:damage', { angle: Math.atan2(src.x - _camPos.x, _camPos.z - src.z) + yaw, amount: 22 });
        }
      } catch {
        /* hud optional */
      }
    }

    /* 1. never let every gun be between bursts on the frame that gets captured */
    let last = -1;
    for (const b of live) last = Math.max(last, b.lastFireTime ?? -1);
    if (now - last > 0.045) {
      for (let k = 0; k < live.length; k++) {
        const b = live[(staged.i + k) % live.length];
        const inr = b?._internals;
        if (!inr) continue;
        inr.gun.reloading = false;
        inr.gun.burstLeft = Math.max(inr.gun.burstLeft, 2 + Math.floor(rng() * 3));
        inr.gun.nextShotAt = now - 0.001;
        inr.gun.nextBurstAt = now;
        b.ammo = Math.max(b.ammo, 12);
        b.reserve = 600;
        staged.i = (staged.i + k + 1) % live.length;
        break;
      }
    }

    /* 2. incoming: their rounds landing on the geometry around the camera */
    if (!ctx.fx || staged.frame % 2) return;
    ctx.camera?.getWorldPosition(_camPos);
    for (let n = 0; n < 2; n++) {
      const b = live[(staged.frame + n) % live.length];
      if (!b) continue;
      _sp0.copy(b.eyePosition || b.position);
      _sp0.y = (b.position?.y ?? 0) + (b.stance === 'crouch' ? 1.0 : 1.45);
      /* a round that missed: 0.6-2.2 m off the lens, and slightly past it */
      _sp1
        .copy(_camPos)
        .addScaledVector(_side, (rng() * 2 - 1) * 2.2)
        .add(_sup.set(0, (rng() * 2 - 1) * 1.1, 0))
        .addScaledVector(_camDir, -(1.5 + rng() * 4));
      _sdir.subVectors(_sp1, _sp0);
      const dist = _sdir.length();
      if (dist < 1) continue;
      _sdir.multiplyScalar(1 / dist);
      let hit = null;
      try {
        hit = ctx.physics?.raycast?.(_sp0, _sdir, dist + 6, 1 | 8);
      } catch {
        hit = null;
      }
      const end = hit ? hit.point : _sp1;
      try {
        ctx.fx.tracer?.(_sp0, end, { owner: 'ai', width: 0.013, intensity: 6.5, heat: 1 });
        if (hit) {
          ctx.fx.impact?.(hit.point, hit.normal, {
            surface: hit.surface || 'concrete',
            energy: 1450,
            scale: 1.15,
            decal: false,
          });
        }
      } catch {
        /* fx is optional and must never break a pose */
      }
    }
  }

  /**
   * Lanes: [metres down the view axis, metres lateral, aim bearing offset].
   *
   * The first entry is the frame's subject and it is deliberately close — 7 m puts a
   * soldier at ~130 px of a 720p frame, which is the size at which kit is legible.
   * The previous set started at 8.5 m and scattered outwards, so the capture was six
   * distant figures and no subject.
   *
   * The third number is where that soldier is *shooting*, expressed as metres to the
   * side of the camera. It matters more than it looks: six men all aiming at the
   * lens are six men seen dead-on, and a rifle pointed at the camera is one pixel
   * wide. Turning half the fireteam onto a flanking bearing is what puts a weapon
   * side-on in the frame — and it is also what a real firefight looks like, because
   * not everybody in it is shooting at you.
   */
  /*
   * ── Round three: the lanes are tighter and much more central ─────────────────
   * Measured on the capture, the two visible fighters came out at ~40 px, at the two
   * extreme edges of the frame, with the whole middle third empty. Two causes, both
   * here: the lateral offsets were up to 6 m (at 8-10 m down the axis that is 30-37
   * degrees off centre, i.e. two thirds of the way to the frame edge), and the cover
   * search below was free to relocate a soldier several metres from the lane it had
   * just chosen for him — usually to the barrier at the side of the street.
   *
   * The lateral spread is now under 2.6 m in the near lanes and grows with distance,
   * so the fireteam forms a wedge in the middle of the frame the way one actually
   * would in a street. Cover displacement is clamped (see COVER_SHIFT_MAX).
   */
  const LANES = [
    [6.2, -1.9, 0],
    [8.6, 2.1, 5.0],
    [11.0, -2.6, 0],
    [9.4, 0.6, -6.0],
    [14.0, 3.2, 0],
    [12.6, -3.4, 6.0],
    [17.0, 1.4, -5.0],
    [15.5, -4.4, 0],
    [7.4, 2.6, 4.0],
    [20.0, 3.0, 0],
  ];

  /**
   * How far the cover search may move a soldier off his lane. Cover is worth having —
   * six men upright in an open street is a line-up — but not at the price of the
   * composition: a barrier three metres to the left of a lane is a soldier three
   * metres closer to the edge of frame, and that is how a combat shot ends up with an
   * empty middle.
   */
  const COVER_SHIFT_MAX = 1.6;

  /**
   * Place the opposition in front of the camera for the `firefight` pose: spread
   * along the view axis, on the navmesh, with a clear line to the lens, already
   * shooting — some of them at the lens, some past it. Without this the combat frame
   * is a picture of an empty street.
   */
  function poseEngaged(count) {
    const rng = ctx.rng || Math.random;
    ctx.camera?.getWorldPosition(_camPos);
    ctx.camera?.getWorldDirection(_camDir);
    _camDir.y = 0;
    if (_camDir.lengthSq() < 1e-6) _camDir.set(0, 0, -1);
    _camDir.normalize();
    _side.set(-_camDir.z, 0, _camDir.x);

    const wanted = Math.min(count, bots.length);
    const placed = [];
    const placedBots = new Set();
    let li = 0;
    for (let i = 0; i < wanted; i++) {
      const bot = bots[i];
      if (!bot) break;
      let best = null;
      let lane = LANES[0];
      for (let attempt = 0; attempt < LANES.length && !best; attempt++) {
        const cand = LANES[(li + attempt) % LANES.length];
        for (let jitter = 0; jitter < 4 && !best; jitter++) {
          const fwd = cand[0] + (jitter - 1.5) * 1.1;
          const lat = cand[1] + (rng() * 2 - 1) * 0.9;
          _cand.copy(_camPos).addScaledVector(_camDir, fwd).addScaledVector(_side, lat);
          if (nav?.ready) {
            const k = nav.nearestWalkable(_cand.x, _cand.z, 4);
            if (k < 0) continue;
            nav.cellCentre(k, _cand);
            _cand.y = nav.groundAt(_cand.x, _cand.z);
          } else {
            _cand.y = ctx.level?.groundY?.(_cand.x, _cand.z) ?? 0;
          }
          let clash = false;
          for (const p of placed) {
            if (p.distanceToSquared(_cand) < 3.0) {
              clash = true;
              break;
            }
          }
          if (clash) continue;
          if (!visibleFromCamera(_cand)) continue;
          best = _cand.clone();
          lane = cand;
        }
        if (best) li = (li + attempt + 1) % LANES.length;
      }
      if (!best) continue;
      placed.push(best);
      placedBots.add(bot);

      /**
       * ── Staging the firefight ────────────────────────────────────────────
       * Six men standing bolt upright in the middle of an open street is not a
       * combat frame, it is a police line-up. Every soldier looks for real cover
       * within 4 m — a jersey barrier, a wrecked car, an oil drum, a low wall —
       * and if he finds one he is planted *behind* it relative to the lens, put
       * into the `cover` behaviour and told whether he is down out of sight or up
       * over the top. What is left over goes to `suppress`, which crouches and
       * shoots. Only a third stay standing.
       */
      const cover = findCoverNear(best, _camPos, i === 0 ? 2.2 : 4.2);
      let role = i % 3 === 0 ? 'engage' : 'suppress';
      if (cover && cover.stand.distanceTo(best) <= COVER_SHIFT_MAX) {
        best.copy(cover.stand);
        role = i % 2 === 0 ? 'cover' : 'suppress';
      } else if (cover) {
        /* Cover exists but taking it would drag him out of the frame. Keep the lane,
           keep the crouch: a man low in the open still reads as a man in a fight. */
        role = 'suppress';
      }
      const peekOut = role !== 'cover' || i % 4 !== 3;

      // What this soldier is shooting at: the lens, or a bearing past it.
      // Two different points, because they are consumed differently — a contact that
      // names an *entity* is resolved by solveAimPoint(), which adds the chest offset
      // itself and therefore wants the player's feet; a bare override point is the
      // aim point as-authored and wants to be at chest height already.
      const bearing = lane[2];
      _chest.set(_camPos.x, _camPos.y - 1.6, _camPos.z);
      _aimPt.set(_camPos.x, _camPos.y - 0.16, _camPos.z).addScaledVector(_side, bearing);
      const yaw = Math.atan2(_aimPt.x - best.x, _aimPt.z - best.z);
      bot.spawn(best, yaw);
      // `suppression` is what the engage/cover behaviours actually read, so setting
      // it buys a genuine crouch and genuine blind fire rather than a posed one.
      bot.suppression = role === 'engage' ? 0.15 : 0.82;
      bot.stance = role === 'engage' || (role === 'cover' && peekOut) ? 'stand' : 'crouch';

      // Pin a live contact so the aim solution, the muzzle flash and the animation
      // are all doing the real thing rather than miming it — and so a single blocked
      // LOS ray cannot drop a soldier back to patrol mid-capture.
      const target = ctx.player || null;
      const hold = { state: role, peekOut, peekTimer: 3.5, coverPos: role === 'cover' ? best : undefined };
      if (bearing !== 0) {
        // Off-bearing: an override contact on the bare point, so the aim converges
        // there instead of snapping back onto the player over the warm frames.
        bot.forceCombat(_aimPt, 45, { ...hold, entity: null, override: true });
      } else {
        bot.forceCombat(_chest, 45, hold);
        if (target && bot.sensor) {
          perception?.registerTarget?.(target);
          const t = bot.sensor.tracks.get(target);
          if (t) {
            t.awareness = 1.8;
            t.visible = true;
            t.losOk = true;
            t.exposure = 1;
            t.confidence = 1;
            t.trackTime = 2.5;
            t.lastSeen = ctx.time?.elapsed ?? 0;
            t.lastKnownPos.copy(_chest);
            bot.sensor.best = t;
            bot.sensor.alerted = true;
          }
        }
      }
      const inr = bot._internals;
      if (inr) {
        inr.aim.committed = true;
        inr.aim.reactionAt = -1;
        inr.aim.trackTime = 2.2;
        // Stagger the bursts across the fireteam: two or three guns talking at any
        // instant reads as a firefight. All six on full auto just blows the exposure
        // out and turns the frame white.
        const now = ctx.time?.elapsed ?? 0;
        inr.gun.burstLeft = i % 2 === 0 ? 3 + Math.floor(rng() * 4) : 0;
        inr.gun.nextShotAt = now + rng() * 0.1;
        inr.gun.nextBurstAt = now + (i % 2 === 0 ? 0 : 0.12 + i * 0.09);
        inr.skill.burstGap = [0.28, 0.7];
        bot.reserve = 600;
        inr.bb.peekOut = true;
        inr.bb.peekTimer = 2.5;
      }
      // Point at the aim bearing on frame zero so nothing is caught mid-turn.
      bot.yaw = yaw;
      bot.pitch = Math.atan2(_aimPt.y - (best.y + 1.5), Math.hypot(_aimPt.x - best.x, _aimPt.z - best.z));
      bot.aimDir.set(
        Math.sin(bot.yaw) * Math.cos(bot.pitch),
        Math.sin(bot.pitch),
        Math.cos(bot.yaw) * Math.cos(bot.pitch)
      );
      bot.lookDir.set(Math.sin(bot.yaw), 0, Math.cos(bot.yaw));
      // Warm frames are too few for the animation damps to converge, so snap the
      // stance, the crouch and the shouldered weapon onto their targets now.
      bot.settlePose?.();
    }
    // Anyone who could not be placed goes behind the camera, out of frame.
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      if (placedBots.has(bot)) continue;
      _cand.copy(_camPos).addScaledVector(_camDir, -14 - i * 2);
      if (nav?.ready) {
        const k = nav.nearestWalkable(_cand.x, _cand.z, 10);
        if (k >= 0) nav.cellCentre(k, _cand);
        _cand.y = nav.groundAt(_cand.x, _cand.z);
      }
      bot?.spawn(_cand, 0);
    }

    /* ── the rest of the frame: smoke, and a live exchange of fire ─────────── */
    const now = ctx.time?.elapsed ?? 0;
    staged.on = true;
    staged.until = now + 40;
    staged.list = [...placedBots];
    staged.i = 0;
    staged.frame = 0;
    try {
      /*
       * Dust and smoke in the middle distance — the depth cue a combat frame needs.
       * Measured on the first capture: at 16 m, radius 3.6 and density 0.85 in a pale
       * grey, this veiled a third of the frame, lifted the black point across the
       * whole left side and fed the bloom/chromatic-aberration chain until the image
       * had rainbow arcs in it. Pushed back, made smaller, and recoloured to the tan
       * of masonry dust rather than white smoke, it does the same job at a fifth of
       * the screen coverage.
       */
      _cand.copy(_camPos).addScaledVector(_camDir, 23).addScaledVector(_side, -6.4);
      _cand.y = (nav?.ready ? nav.groundAt(_cand.x, _cand.z) : ctx.level?.groundY?.(_cand.x, _cand.z)) ?? 0;
      ctx.fx?.smoke?.({ position: _cand, radius: 2.6, duration: 26, density: 0.42, rise: 0.7, color: 0x9a9083 });
      _cand.copy(_camPos).addScaledVector(_camDir, 33).addScaledVector(_side, 7.5);
      _cand.y = (nav?.ready ? nav.groundAt(_cand.x, _cand.z) : ctx.level?.groundY?.(_cand.x, _cand.z)) ?? 0;
      ctx.fx?.smoke?.({ position: _cand, radius: 2.2, duration: 24, density: 0.32, rise: 0.9, color: 0x8e8578 });
    } catch {
      /* fx optional */
    }
  }

  function onPose(state) {
    if (!state) return;
    try {
      // A staged firefight belongs to the pose that asked for one. Every pose ends it,
      // including the ones that say nothing about bots — otherwise the viewmodel shot
      // taken after the combat shot is still full of tracers.
      staged.on = false;
      if (state.difficulty) setDifficulty(state.difficulty);
      if (state.aiDebug !== undefined) setDebug(!!state.aiDebug);
      const want = state.bots;
      if (want === undefined) return;
      if (want === 'none' || want === 0 || want === false) {
        for (const b of bots) b.character?.setVisible?.(false);
        enabled = false;
        return;
      }
      enabled = true;
      for (const b of bots) b.character?.setVisible?.(true);
      if (typeof want === 'number') populate(want);
      if (want === 'engaged') {
        populate(Math.max(5, Math.min(budget(), 7)));
        poseEngaged(6);
      } else if (want === 'idle') {
        for (const b of bots) b.setState('patrol');
      }
    } catch (err) {
      warn('pose', err);
    }
  }

  /* ── debug draw ────────────────────────────────────────────────────────── */

  let debugPaths = [];

  function setDebug(on) {
    debugOn = !!on;
    try {
      nav?.debugDraw?.(ctx.scene, debugOn);
    } catch (err) {
      warn('debugDraw', err);
    }
  }

  function updateDebug() {
    if (!debugOn || !nav) return;
    debugPaths.length = 0;
    for (const b of bots) if (b.alive && b.debugPath) debugPaths.push(b.debugPath);
    nav.setDebugPaths(debugPaths);
  }

  /* ── difficulty ────────────────────────────────────────────────────────── */

  function setDifficulty(level) {
    const key = typeof level === 'number'
      ? ['recruit', 'regular', 'hardened', 'veteran'][clamp(Math.round(level), 0, 3)]
      : String(level || 'regular').toLowerCase();
    if (!SKILL[key]) return difficulty;
    difficulty = key;
    perception?.setDifficulty?.(DIFFICULTY[key]);
    for (const b of bots) b.setSkill(SKILL[key]);
    return difficulty;
  }

  /* ── frame ─────────────────────────────────────────────────────────────── */

  let corpseSweepAt = 0;

  function update(dt) {
    if (disposed || !api.ready) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    if (spawnQueue > 0 && levelReady) {
      populate(spawnQueue);
      spawnQueue = 0;
    }
    if (!enabled) return;
    const step = Math.min(dt, 0.1);

    // Runs BEFORE the bots tick, so a gun topped up here fires on this very frame.
    if (staged.on) {
      try {
        tickStaged();
      } catch (err) {
        warn('staged combat', err);
        staged.on = false;
      }
    }

    perception?.update(step);
    squads?.update(step);

    let alive = 0;
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      try {
        b.update(step, bots);
      } catch (err) {
        warn(`bot ${b.id} update`, err);
        b.alive = false;
      }
      if (b.alive) alive++;
    }
    stats.alive = alive;
    stats.paths = nav?.stats?.paths ?? 0;
    stats.rays = perception?.stats?.rays ?? 0;

    // Recycle corpses: once the ragdoll has settled and enough time has passed the
    // soldier is respawned somewhere else rather than being rebuilt from scratch.
    const now = ctx.time?.elapsed ?? 0;
    if (now - corpseSweepAt > 1.0) {
      corpseSweepAt = now;
      for (const b of bots) {
        if (b.alive) continue;
        if (b.deathTime < 0 || now - b.deathTime < CORPSE_LIFETIME) continue;
        try {
          b.ragdoll?.dispose?.();
        } catch {
          /* best effort */
        }
        const sp = pickSpawn(b.team);
        const p = new THREE.Vector3(sp.pos.x, sp.pos.y ?? 0, sp.pos.z);
        if (nav?.ready) {
          const k = nav.nearestWalkable(p.x, p.z, 8);
          if (k >= 0) nav.cellCentre(k, p);
          p.y = nav.groundAt(p.x, p.z);
        }
        b.spawn(p, sp.yaw ?? 0);
        b.sensor?.reset?.();
        stats.killed++;
      }
    }

    updateDebug();
    stats.updateMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }

  /* ── system ────────────────────────────────────────────────────────────── */

  Object.assign(api, {
    spawn,
    despawn,
    clear,
    populate,
    setDifficulty,
    setEnabled(v) {
      enabled = !!v;
    },
    debugDraw: setDebug,
    SKILL,
  });
  // Real accessors — `Object.assign` would have *invoked* these and frozen in the
  // nulls that the sub-modules are before init() runs.
  Object.defineProperties(api, {
    enabled: { get: () => enabled, enumerable: true },
    nav: { get: () => nav, enumerable: true },
    perception: { get: () => perception, enumerable: true },
    squads: { get: () => squads, enumerable: true },
    builder: { get: () => builder, enumerable: true },
  });
  ctx.ai = api;

  return {
    name: 'ai',
    order: 80,

    async init() {
      ctx.ai = api;
      headless = !!ctx.settings?.get?.('headless');
      quality = headless || ctx.settings?.tier === 'low' ? 0.45 : 1;

      builder = createCharacterBuilder(ctx);
      nav = createNavmesh(ctx);
      perception = createPerception(ctx);
      squads = createSquads(ctx, { nav, perception });

      try {
        nav.build();
      } catch (err) {
        warn('navmesh build', err);
      }
      perception.setDifficulty(DIFFICULTY[difficulty]);
      if (ctx.player) perception.registerTarget(ctx.player);

      const on = (name, fn) => {
        const u = ctx.bus?.on?.(name, fn);
        if (u) unsubs.push(u);
      };
      on('entity:damage', onDamage);
      on('entity:suppressed', onSuppressed);
      on('explosion', onExplosion);
      on('debug:pose', onPose);
      on('level:ready', () => {
        levelReady = true;
        try {
          nav.build();
        } catch (err) {
          warn('navmesh rebuild', err);
        }
      });
      on('quality:changed', () => {
        if (bots.length > budget()) populate(budget());
      });

      levelReady = !!ctx.level?.navRegions;
      api.ready = true;

      // Populate immediately if the level is already up (it boots at order 32, we are
      // at 80), otherwise wait for `level:ready`.
      try {
        if (levelReady) populate(budget());
        else spawnQueue = budget();
      } catch (err) {
        warn('populate', err);
      }

      ctx.bus?.emit?.('ai:ready', {
        bots: bots.length,
        nav: nav.source,
        cells: nav.cellCount,
        triangles: builder?.stats?.triangles ?? 0,
      });
    },

    update,

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
      clear();
      nav?.dispose?.();
      perception?.dispose?.();
      squads?.dispose?.();
      builder?.dispose?.();
      api.ready = false;
    },
  };
}
