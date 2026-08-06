/**
 * Squad.js — fireteam coordination. Owner: AI agent.
 *
 * Individually competent bots still read as a mob: they all sprint the same lane, all
 * shoot from the same doorway, all reload at the same moment. This layer is the thin
 * shared brain that fixes that. It owns exactly four things:
 *
 *   1. **A contact blackboard.** When one member sees you, the others learn about it —
 *      but not instantly and not perfectly. A contact propagates after a `callout
 *      latency` (~0.35 s, the time it takes to say it) and arrives as an *awareness
 *      bump plus a position*, never as a lock, so a bot told "contact, east side" still
 *      has to find you before it can shoot.
 *   2. **Roles.** With a live contact and two or more effectives, one member is told to
 *      suppress (long bursts from cover, keeps firing at the last known position even
 *      with no LOS) and one is told to flank (wide route, no shooting on the move).
 *      Everybody else assaults. Roles are re-cut every 1.6 s and are sticky enough not
 *      to thrash.
 *   3. **Space.** Cover cells are reserved, so two bots never walk into the same
 *      doorway, and the navmesh is told about the reservation so their A* actively
 *      prefers a different lane.
 *   4. **Callouts.** Contact / reloading / grenade / fallback, rate-limited per squad
 *      so it sounds like a team and not a parrot.
 *
 * ── Public API ──────────────────────────────────────────────────────────────────
 *   createSquads(ctx, {nav, perception}) -> {
 *     add(bot, squadId) / remove(bot) / update(dt)
 *     shareContact(bot, entity, pos, confidence)
 *     roleOf(bot) -> 'assault'|'suppress'|'flank'
 *     takeCover(bot, cell) / dropCover(bot) / isCoverTaken(cell, bot)
 *     callout(bot, type) / onDeath(bot)
 *     squads, stats, dispose()
 *   }
 *
 * Events emitted: `ai:callout` {bot, type, position}, `ai:squad` {squad, role map}.
 */
import * as THREE from 'three';

const CALLOUT_COOLDOWN = { contact: 4.5, reloading: 2.5, grenade: 3.0, fallback: 6.0, clear: 8.0 };
const CALLOUT_SOUND = { contact: 'hurt', reloading: 'gear', grenade: 'gear', fallback: 'hurt', clear: 'gear' };
const ROLE_PERIOD = 1.6;
const CALLOUT_LATENCY = 0.35;

export default function createSquads(ctx, deps = {}) {
  const { nav, perception } = deps;
  const squads = new Map();
  const bySquad = new Map(); // bot -> squad
  const roles = new Map(); // bot -> role
  const coverOwner = new Map(); // cell -> bot
  const botCover = new Map(); // bot -> cell
  const pending = []; // delayed contact broadcasts
  const stats = { squads: 0, callouts: 0, contacts: 0, flanks: 0 };

  const _v = new THREE.Vector3();

  function squadOf(bot) {
    return bySquad.get(bot) || null;
  }

  function makeSquad(id) {
    const s = {
      id,
      members: [],
      contact: null, // {entity, pos:Vector3, time, confidence}
      lastRoleAt: -99,
      lastCallout: Object.create(null),
      suppressor: null,
      flanker: null,
      flankSide: 1,
    };
    squads.set(id, s);
    stats.squads = squads.size;
    return s;
  }

  function add(bot, squadId = 0) {
    const s = squads.get(squadId) || makeSquad(squadId);
    if (s.members.indexOf(bot) < 0) s.members.push(bot);
    bySquad.set(bot, s);
    roles.set(bot, 'assault');
    bot.squadId = squadId;
    return s;
  }

  function remove(bot) {
    const s = squadOf(bot);
    if (s) {
      const i = s.members.indexOf(bot);
      if (i >= 0) s.members.splice(i, 1);
      if (s.suppressor === bot) s.suppressor = null;
      if (s.flanker === bot) s.flanker = null;
    }
    bySquad.delete(bot);
    roles.delete(bot);
    dropCover(bot);
  }

  /* ── contact sharing ───────────────────────────────────────────────────── */

  function shareContact(bot, entity, pos, confidence = 0.7) {
    const s = squadOf(bot);
    if (!s || !entity || !pos) return;
    const now = ctx.time?.elapsed ?? 0;
    const p = _v.set(pos.x, pos.y, pos.z).clone();
    if (!s.contact || s.contact.entity !== entity || confidence >= s.contact.confidence * 0.85) {
      s.contact = { entity, pos: p, time: now, confidence, from: bot };
    }
    stats.contacts++;
    pending.push({ squad: s, entity, pos: p, confidence, at: now + CALLOUT_LATENCY, from: bot });
  }

  function flushPending(now) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i];
      if (now < c.at) continue;
      pending.splice(i, 1);
      for (const m of c.squad.members) {
        if (m === c.from || m.alive === false || !m.sensor) continue;
        let t = m.sensor.tracks.get(c.entity);
        if (!t) {
          // Nothing tracked yet: give the sensor a seed it can confirm with its eyes.
          perception?.registerTarget?.(c.entity);
          t = m.sensor.tracks.get(c.entity);
        }
        if (!t) continue;
        // A radio call raises awareness and points you at a place. It does not aim
        // for you: the awareness ceiling here is deliberately below 1.
        t.awareness = Math.max(t.awareness, Math.min(0.88, c.confidence));
        if (!t.visible) {
          t.lastKnownPos.copy(c.pos);
          t.confidence = Math.max(t.confidence, c.confidence * 0.8);
        }
      }
    }
  }

  /* ── roles ─────────────────────────────────────────────────────────────── */

  function effectives(s) {
    const out = [];
    for (const m of s.members) if (m.alive !== false) out.push(m);
    return out;
  }

  function assignRoles(s, now) {
    if (now - s.lastRoleAt < ROLE_PERIOD) return;
    s.lastRoleAt = now;
    const live = effectives(s);
    if (!live.length) return;

    // The squad only has roles while there is something to fight.
    let contact = s.contact;
    let bestConf = contact ? contact.confidence : 0;
    for (const m of live) {
      const t = m.sensor?.best;
      if (!t || t.awareness < 0.75) continue;
      const conf = t.visible ? 1.2 : t.confidence;
      if (conf > bestConf) {
        bestConf = conf;
        contact = { entity: t.entity, pos: t.lastKnownPos.clone(), time: now, confidence: conf, from: m };
      }
    }
    s.contact = contact;
    if (!contact || now - contact.time > 9 || live.length < 2) {
      for (const m of live) roles.set(m, 'assault');
      s.suppressor = null;
      s.flanker = null;
      return;
    }

    // Suppressor: whoever already has eyes on and the most ammo. Flanker: whoever is
    // furthest from the suppressor's lane, so the two approaches actually diverge.
    let sup = null;
    let supScore = -Infinity;
    for (const m of live) {
      const t = m.sensor?.tracks.get(contact.entity);
      const score =
        (t?.visible ? 2.2 : 0) +
        (m.ammo ?? 0) / 30 +
        (m.reloading ? -1.5 : 0) -
        m.position.distanceTo(contact.pos) * 0.02;
      if (score > supScore) {
        supScore = score;
        sup = m;
      }
    }
    let flank = null;
    let flankScore = -Infinity;
    for (const m of live) {
      if (m === sup) continue;
      if (m.health !== undefined && m.health < 45) continue;
      const d = m.position.distanceTo(contact.pos);
      const score = -Math.abs(d - 18) * 0.05 + (m === s.flanker ? 0.6 : 0) + (m.ammo ?? 0) / 60;
      if (score > flankScore) {
        flankScore = score;
        flank = m;
      }
    }
    for (const m of live) roles.set(m, 'assault');
    if (sup) roles.set(sup, 'suppress');
    if (flank && live.length >= 3) {
      roles.set(flank, 'flank');
      if (s.flanker !== flank) {
        s.flankSide = -s.flankSide;
        stats.flanks++;
      }
      if (flank._internals?.bb) flank._internals.bb.flankSide = s.flankSide;
    }
    s.suppressor = sup;
    s.flanker = live.length >= 3 ? flank : null;
    ctx.bus?.emit?.('ai:squad', {
      squad: s.id,
      suppressor: sup?.id || null,
      flanker: s.flanker?.id || null,
      contact: contact.entity ? (contact.entity.name || 'player') : null,
    });
  }

  /* ── cover reservations ────────────────────────────────────────────────── */

  function takeCover(bot, cell) {
    if (cell === undefined || cell < 0) return;
    dropCover(bot);
    coverOwner.set(cell, bot);
    botCover.set(bot, cell);
  }

  function dropCover(bot) {
    const cell = botCover.get(bot);
    if (cell === undefined) return;
    botCover.delete(bot);
    if (coverOwner.get(cell) === bot) coverOwner.delete(cell);
    nav?.release?.(bot);
  }

  function isCoverTaken(cell, bot) {
    const owner = coverOwner.get(cell);
    return !!owner && owner !== bot && owner.alive !== false;
  }

  /* ── callouts ──────────────────────────────────────────────────────────── */

  function callout(bot, type) {
    const s = squadOf(bot);
    const now = ctx.time?.elapsed ?? 0;
    const cd = CALLOUT_COOLDOWN[type] ?? 3;
    if (s) {
      const last = s.lastCallout[type];
      if (last !== undefined && now - last < cd) return false;
      s.lastCallout[type] = now;
    }
    stats.callouts++;
    ctx.bus?.emit?.('ai:callout', { bot, type, position: bot.position, squad: s?.id ?? -1 });
    const id = CALLOUT_SOUND[type];
    // The audio registry has no bark bank yet; use the closest voice/foley id it does
    // have, quietly, and let AudioEngine grow real callouts later off `ai:callout`.
    if (id && ctx.audio?.has?.(id)) {
      ctx.audio.playAt(id, bot.position, {
        volume: type === 'contact' ? 0.55 : 0.35,
        pitch: 0.85 + (bot.id.charCodeAt(3) % 7) * 0.03,
        nodedupe: true,
      });
    }
    return true;
  }

  function onDeath(bot) {
    const s = squadOf(bot);
    dropCover(bot);
    roles.set(bot, 'assault');
    if (!s) return;
    if (s.suppressor === bot) s.suppressor = null;
    if (s.flanker === bot) s.flanker = null;
    s.lastRoleAt = -99;
    // A death is loud information: everybody left knows roughly where it came from.
    const killer = bot.sensor?.best?.entity;
    if (killer && killer.position) {
      shareContact(bot, killer, killer.position, 0.75);
    }
  }

  /* ── tick ──────────────────────────────────────────────────────────────── */

  function update(dt) {
    const now = ctx.time?.elapsed ?? 0;
    flushPending(now);
    for (const s of squads.values()) {
      assignRoles(s, now);
      // Bots that saw something this frame feed the blackboard.
      for (const m of s.members) {
        if (m.alive === false) continue;
        const t = m.sensor?.best;
        if (t?.visible && t.awareness >= 1) {
          if (!s.contact || now - s.contact.time > 0.9 || s.contact.entity !== t.entity) {
            shareContact(m, t.entity, t.lastKnownPos, 1);
          }
        }
      }
    }
    void dt;
  }

  return {
    add,
    remove,
    update,
    shareContact,
    roleOf: (bot) => roles.get(bot) || 'assault',
    setRole: (bot, role) => roles.set(bot, role),
    takeCover,
    dropCover,
    isCoverTaken,
    callout,
    onDeath,
    contactOf: (bot) => squadOf(bot)?.contact || null,
    squads,
    stats,
    dispose() {
      squads.clear();
      bySquad.clear();
      roles.clear();
      coverOwner.clear();
      botCover.clear();
      pending.length = 0;
    },
  };
}
