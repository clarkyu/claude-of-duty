/**
 * GameMode.js — the rules layer. Owner: game agent.  Publishes `ctx.game`.
 * Files owned: this, Scoring.js, Objectives.js, Loadouts.js, Killstreaks.js
 *
 * Composition:
 *   Scoring      points, medals, killfeed, personal bests, scoreboard
 *   Objectives   capture points, hardpoints, the bomb, and their world markers
 *   Loadouts     five classes, attachments, equipment, perks
 *   Killstreaks  UAV / counter-UAV / airstrike / cluster strike / chopper gunner
 *
 * This file owns everything that is *state about people*: the roster (the local
 * player plus every bot, on two teams), health and armour, the damage router, death
 * and respawn timing, spawn selection, and the match/round state machine. The HUD is
 * never touched directly — it is driven entirely through `hud:*` events, so it can be
 * rebuilt or replaced without this module noticing.
 *
 * ── Modes ───────────────────────────────────────────────────────────────────────
 *   tdm         Team Deathmatch      75 kills / 10 min
 *   ffa         Free-for-All         30 kills / 10 min, everybody hostile
 *   dom         Domination           3 flags, 200 points, ticking capture score
 *   snd         Search & Destroy     bomb, one life, first to 4 rounds
 *   hp          Hardpoint            one rotating zone, 250 points
 *
 * ── Public API (ctx.game) ───────────────────────────────────────────────────────
 *   ready, state, phase, mode, modes, modeId
 *   setMode(name)                start()               end(winner, reason)
 *   restart()                    pause(bool)
 *   score  {A, B}                players  (live roster)
 *   localPlayer                  recordFor(entity)     playersOfTeam(team)
 *   damage(entity, amount, source)   -> applied damage
 *   heal(entity, amount)         kill(entity, attacker)
 *   respawn(entity)              getSpawn(team, forRecord)
 *   playerHealth / plates        scoreboard()          killfeed
 *   scoring / objectives / loadouts / killstreaks      the sub-modules
 *   setDifficulty(name)          setBotCount(n)        friendlyFire (bool)
 *
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   game:score      {team, delta, reason, total}                        §3
 *   entity:death    {target, attacker, weapon, hitbox}                  §3
 *   hud:hitmarker   {lethal, headshot, armour, damage}                  §3
 *   game:state      {state, previous, mode}
 *   game:start      {mode, teams, roster}
 *   game:end        {winner, reason, scoreboard}
 *   game:round      {round, winner, reason, roundsWon}
 *   game:respawn    {player, spawn}
 *   game:death      {player, attacker, headshot, weapon}
 *   game:downed / game:revived
 *   hud:health      {health, max, plates, maxPlates, regen, downed, respawnIn}
 *   hud:damage      {angle, degrees, amount, distance, attacker}  damage indicator
 *   hud:timer       {remaining, limit, phase, round}
 *   hud:countdown   {seconds, phase, text}
 *   hud:message     {text, sub, kind, duration}
 *   hud:scoreboard  {…scoreboard(), open}
 *   hud:mode        {id, name, short, scoreLimit, timeLimit}
 *   hud:teamscore / hud:killfeed / hud:points / hud:medal / hud:objective /
 *   hud:killstreak / hud:radar / hud:equipment / hud:loadout   (see the sub-modules)
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   entity:damage, entity:death, explosion, weapon:fire, level:ready, ai:ready,
 *   debug:pose, debug:cameraLock, quality:changed
 *
 * ── A note on bot teams ─────────────────────────────────────────────────────────
 * `ai/Perception.js` keeps one global target set and `ai/Bot.js` refuses to fire when
 * any other agent is near its line, so bots physically cannot shoot each other. Rather
 * than reach into files this module does not own, friendly bots run with their sensor
 * disabled (a documented per-sensor flag) so they never shoot *you*, and cross-team
 * firefights are resolved here: real line-of-sight, real positions, real
 * `entity:damage` through the bus, real deaths, ragdolls, tracers and audio. From the
 * outside — killfeed, scoreboard, streaks, objectives — it is indistinguishable.
 */
import * as THREE from 'three';
import { createScoring, LONGSHOT_RANGE } from './Scoring.js';
import { createObjectives } from './Objectives.js';
import { createLoadouts, LETHALS, TACTICALS } from './Loadouts.js';
import { createKillstreaks } from './Killstreaks.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ────────────────────────────────────────────────────────────────── modes ── */

export const MODES = {
  tdm: {
    id: 'tdm',
    name: 'Team Deathmatch',
    short: 'TDM',
    teams: true,
    scoreLimit: 75,
    timeLimit: 600,
    respawn: 5.5,
    spawnProtect: 1.5,
    objective: null,
    killScore: 1,
    lives: Infinity,
    rounds: 1,
    revive: false,
    winBy: 'score',
  },
  ffa: {
    id: 'ffa',
    name: 'Free-for-All',
    short: 'FFA',
    teams: false,
    scoreLimit: 30,
    timeLimit: 600,
    respawn: 4.5,
    spawnProtect: 1.5,
    objective: null,
    killScore: 1,
    lives: Infinity,
    rounds: 1,
    revive: false,
    winBy: 'kills',
  },
  dom: {
    id: 'dom',
    name: 'Domination',
    short: 'DOM',
    teams: true,
    scoreLimit: 200,
    timeLimit: 900,
    respawn: 6.5,
    spawnProtect: 2.0,
    objective: 'domination',
    killScore: 0,
    tickEvery: 5,
    lives: Infinity,
    rounds: 1,
    revive: false,
    winBy: 'score',
  },
  snd: {
    id: 'snd',
    name: 'Search & Destroy',
    short: 'S&D',
    teams: true,
    scoreLimit: 4,
    timeLimit: 150,
    respawn: Infinity,
    spawnProtect: 0,
    objective: 'bomb',
    killScore: 0,
    attackers: 'A',
    plantTime: 3,
    defuseTime: 5,
    bombFuse: 45,
    lives: 1,
    rounds: 7,
    revive: true,
    bleedout: 22,
    reviveTime: 4,
    winBy: 'rounds',
  },
  hp: {
    id: 'hp',
    name: 'Hardpoint',
    short: 'HP',
    teams: true,
    scoreLimit: 250,
    timeLimit: 600,
    respawn: 5,
    spawnProtect: 1.6,
    objective: 'hardpoint',
    killScore: 0,
    hardpointTime: 60,
    lives: Infinity,
    rounds: 1,
    revive: false,
    winBy: 'score',
  },
};

const MODE_ORDER = ['tdm', 'dom', 'hp', 'ffa', 'snd'];

const BOT_NAMES = [
  'Vasquez', 'Kowalski', 'Ramirez', 'Petrov', 'Okafor', 'Lindqvist', 'Haddad', 'Novak',
  'Bianchi', 'Ferreira', 'Duval', 'Salcedo', 'Iversen', 'Marchetti', 'Aziz', 'Doyle',
  'Kaminski', 'Toure', 'Brandt', 'Rojas', 'Castellan', 'Whitfield', 'Yilmaz', 'Sorensen',
];

/* Body armour: light plates, so the time-to-kill stays CoD and not Warzone. */
const PLATE_HP = 30;
const PLATE_REGEN_DELAY = 11;
const PLATE_REGEN_TIME = 3.2;
const ASSIST_WINDOW = 10;
const ASSIST_MIN = 25;

const SKILL_BY_DIFFICULTY = {
  recruit: { accuracy: 0.22, burstGap: 1.5 },
  regular: { accuracy: 0.34, burstGap: 1.15 },
  hardened: { accuracy: 0.46, burstGap: 0.9 },
  veteran: { accuracy: 0.58, burstGap: 0.75 },
};

/* ──────────────────────────────────────────────────────────────── factory ── */

export default function createGameMode(ctx) {
  /* ---------------------------------------------------------------- state */
  let scoring = null;
  let objectives = null;
  let loadouts = null;
  let killstreaks = null;

  let mode = MODES.tdm;
  let phase = 'idle'; // idle | pregame | live | roundend | postgame
  let phaseTimer = 0;
  let matchClock = 0;
  let round = 1;
  const roundsWon = { A: 0, B: 0 };
  let winner = null;
  let endReason = '';
  let lastCountdown = -1;

  /** @type {Array<object>} the whole roster: local player first, then bots. */
  const roster = [];
  const byEntity = new Map();
  let local = null;
  const localTeam = 'A';

  let cameraLocked = false;
  let headless = false;
  let paused = false;
  let disposed = false;
  let levelReady = false;
  let aiReady = false;
  let botsAssigned = false;
  let scoreboardOpen = false;
  let warnBudget = 12;
  let nextId = 1;

  const unsubs = [];
  const stats = { spawns: 0, deaths: 0, rays: 0, engagements: 0, botKills: 0 };

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _q = new THREE.Quaternion();

  const now = () => ctx.time?.elapsed ?? 0;
  const rng = () => (ctx.rng ? ctx.rng() : 0.5);

  function warn(msg, err) {
    if (warnBudget-- <= 0) return;
    console.warn(`[game] ${msg}`, err?.message || err || '');
  }

  /* ══════════════════════════════════════════════════════════════ records ══ */

  function makeRecord(opts) {
    return {
      id: opts.id || `p${nextId++}`,
      name: opts.name || 'Soldier',
      team: opts.team || 'A',
      isLocal: !!opts.isLocal,
      isBot: !!opts.isBot,
      entity: opts.entity || null,
      bot: opts.bot || null,
      position: opts.position || new THREE.Vector3(),
      yaw: 0,

      alive: true,
      downed: false,
      downedAt: -1,
      reviveProgress: 0,
      reviver: null,
      health: 100,
      maxHealth: 100,
      baseHealth: 100,
      plates: 0,
      maxPlates: 0,
      plateHp: 0,
      lastDamageAt: -99,
      lastPlateAt: -99,
      lastFireTime: -99,
      spawnAt: 0,
      deathAt: -1,
      respawnAt: 0,
      protectedUntil: 0,
      lives: Infinity,

      score: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      streak: 0,
      bestStreak: 0,
      headshots: 0,
      longshots: 0,
      wallbangs: 0,
      captures: 0,
      defends: 0,
      plants: 0,
      defuses: 0,
      damageDealt: 0,
      damageTaken: 0,
      multikillCount: 0,
      lastKillTime: -99,
      lastKilledBy: null,
      ping: 0,

      damageLog: [],
      /** Flags from the most recent incoming hit, so a kill knows how it happened. */
      lastHit: null,
      loadout: opts.loadout || null,
      streakBag: { earned: [], used: [], progress: 0 },
      spawnPointId: null,
      /** bot-vs-bot engagement bookkeeping */
      foe: null,
      foeUntil: 0,
      nextExchange: 0,
      goalAt: 0,
    };
  }

  function recordFor(entity) {
    if (!entity) return null;
    const direct = byEntity.get(entity);
    if (direct) return direct;
    if (entity.isBot) {
      for (const r of roster) if (r.bot === entity) return r;
      return null;
    }
    if (entity === ctx.player || entity.isPlayer === true || entity === ctx.player?.body) return local;
    if (entity.entity) return byEntity.get(entity.entity) || null;
    return null;
  }

  function enemyTeam() {
    return localTeam === 'A' ? 'B' : 'A';
  }

  function playersOfTeam(team) {
    if (!mode.teams) return roster.filter((r) => r.team === team);
    return roster.filter((r) => r.team === team);
  }

  function enemiesOf(rec) {
    if (!rec) return [];
    if (!mode.teams) return roster.filter((r) => r !== rec);
    return roster.filter((r) => r.team !== rec.team);
  }

  function hostile(a, b) {
    if (!a || !b || a === b) return false;
    if (!mode.teams) return true;
    return a.team !== b.team;
  }

  /* ══════════════════════════════════════════════════════════════ roster ══ */

  function ensureLocal() {
    if (local) return local;
    local = makeRecord({
      id: 'local',
      name: 'YOU',
      team: localTeam,
      isLocal: true,
      entity: ctx.player || null,
      position: ctx.player?.position || new THREE.Vector3(),
    });
    local.loadout = loadouts?.active || null;
    roster.unshift(local);
    if (ctx.player) byEntity.set(ctx.player, local);
    return local;
  }

  function adoptBots() {
    const bots = ctx.ai?.bots;
    if (!Array.isArray(bots) || !bots.length) return false;
    let i = roster.length - 1;
    for (const bot of bots) {
      if (byEntity.has(bot)) continue;
      // Alternate sides so both teams fill out.
      const team = mode.teams ? (i % 2 === 0 ? enemyTeam() : localTeam) : 'B';
      bot.team = team;
      const rec = makeRecord({
        id: bot.id || `bot${i}`,
        name: BOT_NAMES[(i + 3) % BOT_NAMES.length],
        team,
        isBot: true,
        entity: bot,
        bot,
        position: bot.position,
        loadout: loadouts?.randomiseBotLoadout?.(ctx.rng) || null,
      });
      rec.maxHealth = bot.maxHealth || 100;
      rec.health = bot.health;
      rec.spawnAt = now();
      rec.alive = bot.alive !== false;
      roster.push(rec);
      byEntity.set(bot, rec);
      bot.gameRecord = rec;
      i++;
    }
    applyBotSensors();
    botsAssigned = true;
    return true;
  }

  /**
   * Friendly bots run blind (the documented per-sensor `enabled` flag) so your own
   * side never guns you down; enemy sensors get the perk-modified detection profile,
   * which is how Dead Silence and Ghost actually change the game.
   */
  /**
   * Push the perk modifiers that other systems own onto their public knobs.
   * `ctx.player.speedScale` is documented as a writable multiplier, so Lightweight is
   * a genuine movement change rather than a number on a menu.
   */
  function applyPerksToPlayer() {
    const mods = loadouts?.mods;
    if (!mods || !ctx.player) return;
    ctx.player.speedScale = mods.moveScale;
  }

  /** The AI rewrites sensor.hearing/detectRate on a difficulty change; re-baseline. */
  function refreshSensorBaselines() {
    for (const rec of roster) {
      const s = rec.bot?.sensor;
      if (!s) continue;
      s._baseHearing = undefined;
      s._baseDetect = undefined;
    }
  }

  function applyBotSensors() {
    const mods = loadouts?.mods;
    for (const rec of roster) {
      const s = rec.bot?.sensor;
      if (!s) continue;
      const foe = hostile(rec, local);
      s.enabled = foe;
      if (s._baseHearing === undefined) {
        s._baseHearing = s.hearing;
        s._baseDetect = s.detectRate;
      }
      if (foe && mods) {
        s.hearing = s._baseHearing * (mods.enemyHearingScale ?? 1);
        s.detectRate = s._baseDetect * (mods.enemyDetectScale ?? 1);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════ spawns ══ */

  const spawnUse = new Map(); // spawn id -> last used time

  /**
   * Score every legal spawn and pick from the best handful: distance from live
   * enemies, whether they can *see* it, distance from friendlies, how recently it was
   * used, and how close the fight is. Spawning in front of an enemy is the fastest way
   * for a shooter to feel cheap, so line of sight is a hard veto, not a nudge.
   */
  function getSpawn(team, forRec = null) {
    const pts = ctx.level?.spawnPoints;
    if (!Array.isArray(pts) || !pts.length) return null;
    const wantTeam = mode.teams ? team || localTeam : null;
    // Team modes keep their spawn geography: the neutral points are objective sites
    // and mid-map crossings, so spawning on them shreds the front line.
    let pool = wantTeam ? pts.filter((p) => p.team === wantTeam) : pts;
    if (pool.length < 3) pool = wantTeam ? pts.filter((p) => p.team === wantTeam || p.team === 'ffa') : pts;
    if (pool.length < 3) pool = pts;

    const foes = [];
    const friends = [];
    for (const r of roster) {
      if (!r.alive || !r.position || r === forRec) continue;
      if (!mode.teams) foes.push(r);
      else if (r.team === (team || localTeam)) friends.push(r);
      else foes.push(r);
    }

    const t = now();
    const scored = [];
    for (const p of pool) {
      let s = 0;
      let nearestFoe = Infinity;
      for (const f of foes) {
        const d = Math.hypot(f.position.x - p.pos.x, f.position.z - p.pos.z);
        if (d < nearestFoe) nearestFoe = d;
      }
      if (nearestFoe === Infinity) nearestFoe = 60;
      s += clamp(nearestFoe, 0, 55) * 2.4;
      if (nearestFoe < 16) s -= (16 - nearestFoe) * 55;

      let nearestFriend = Infinity;
      for (const f of friends) {
        const d = Math.hypot(f.position.x - p.pos.x, f.position.z - p.pos.z);
        if (d < nearestFriend) nearestFriend = d;
      }
      if (nearestFriend !== Infinity) {
        // Near the squad, but not standing in someone's back.
        s += 26 - Math.abs(nearestFriend - 15) * 1.1;
        if (nearestFriend < 3) s -= 70;
      }

      const age = t - (spawnUse.get(p.id) ?? -999);
      if (age < 14) s -= (14 - age) * 22;

      const zones = objectives?.zones;
      if (zones?.length) {
        let bestZ = Infinity;
        for (const z of zones) {
          if (!z.active) continue;
          const d = Math.hypot(z.pos.x - p.pos.x, z.pos.z - p.pos.z);
          if (d < bestZ) bestZ = d;
        }
        if (bestZ < Infinity) s += clamp(70 - bestZ, -30, 45) * 0.7;
      }

      s += rng() * 26;
      scored.push({ p, s, nearestFoe });
    }

    scored.sort((a, b) => b.s - a.s);

    // Line of sight is expensive: only the shortlist is tested, and only against
    // enemies close enough to matter.
    const short = scored.slice(0, 6);
    for (const c of short) {
      if (c.nearestFoe > 60) continue;
      _v.set(c.p.pos.x, c.p.pos.y + 1.55, c.p.pos.z);
      for (const f of foes) {
        const d = Math.hypot(f.position.x - c.p.pos.x, f.position.z - c.p.pos.z);
        if (d > 60 || d < 0.5) continue;
        _v2.set(f.position.x, f.position.y + 1.5, f.position.z);
        _dir.copy(_v2).sub(_v);
        const dist = _dir.length();
        if (dist < 0.2) continue;
        _dir.multiplyScalar(1 / dist);
        stats.rays++;
        const hit = ctx.physics?.raycast?.(_v, _dir, dist - 0.4, 1 | 8);
        if (!hit) {
          c.s -= 420 + (60 - d) * 6;
          break;
        }
      }
    }
    short.sort((a, b) => b.s - a.s);

    const top = short.slice(0, Math.min(3, short.length));
    const pick = top[Math.min(top.length - 1, Math.floor(rng() * top.length))] || scored[0];
    if (pick?.p) spawnUse.set(pick.p.id, t);
    return pick?.p || null;
  }

  /* ═════════════════════════════════════════════════════════════ lifecycle ══ */

  function resetRecordForSpawn(rec) {
    const mods = rec.isLocal ? loadouts?.mods : null;
    rec.baseHealth = 100 + (mods?.extraHealth ?? 0);
    rec.maxHealth = rec.bot ? rec.bot.maxHealth || 100 : rec.baseHealth;
    rec.health = rec.maxHealth;
    rec.maxPlates = rec.isLocal ? clamp(1 + (mods?.plates ?? 0), 0, 3) : 1;
    rec.plates = rec.maxPlates;
    rec.plateHp = rec.plates > 0 ? PLATE_HP : 0;
    rec.alive = true;
    rec.downed = false;
    rec.downedAt = -1;
    rec.reviveProgress = 0;
    rec.reviver = null;
    rec.damageLog.length = 0;
    rec.lastDamageAt = -99;
    rec.spawnAt = now();
    rec.deathAt = -1;
    rec.protectedUntil = now() + (mode.spawnProtect || 0);
    rec.multikillCount = 0;
    rec.foe = null;
  }

  function respawn(entity) {
    const rec = byEntity.get(entity) || recordFor(entity) || (entity && entity.id && roster.includes(entity) ? entity : null);
    if (!rec) return false;
    if (mode.lives !== Infinity && rec.lives <= 0 && phase === 'live') return false;

    const sp = getSpawn(rec.team, rec);
    resetRecordForSpawn(rec);
    rec.spawnPointId = sp?.id || null;
    stats.spawns++;

    if (rec.isLocal) {
      if (!cameraLocked) {
        try {
          if (sp) ctx.player?.respawn?.(sp);
          else ctx.player?.respawn?.();
        } catch (err) {
          warn('player respawn failed', err);
        }
      }
      try {
        ctx.player?.suspend?.(false);
      } catch {
        /* optional */
      }
      if (ctx.player) ctx.player.health = rec.health;
      loadouts?.commit?.();
      loadouts?.applyToWeapons?.({ instant: true });
      applyPerksToPlayer();
      applyBotSensors();
      emitHealth();
      killstreaks?.emitHud?.(rec);
    } else if (rec.bot) {
      const pos = sp?.pos || rec.bot.position;
      try {
        rec.bot.spawn({ x: pos.x, y: pos.y ?? 0, z: pos.z }, sp?.yaw ?? 0);
        rec.bot.sensor?.reset?.();
      } catch (err) {
        warn('bot respawn failed', err);
      }
      applyBotSensors();
    }
    ctx.bus?.emit?.('game:respawn', { player: rec.id, team: rec.team, spawn: sp?.id || null, local: !!rec.isLocal });
    return true;
  }

  /* ══════════════════════════════════════════════════════════════ damage ══ */

  function logDamage(rec, attackerRec, amount) {
    if (!attackerRec || attackerRec === rec) return;
    const t = now();
    const log = rec.damageLog;
    for (const e of log) {
      if (e.by === attackerRec) {
        e.amount += amount;
        e.t = t;
        return;
      }
    }
    log.push({ by: attackerRec, amount, t });
    while (log.length > 8) log.shift();
  }

  function assistsFor(rec, killer) {
    const t = now();
    const out = [];
    for (const e of rec.damageLog) {
      if (!e.by || e.by === killer) continue;
      if (t - e.t > ASSIST_WINDOW) continue;
      if (e.amount < ASSIST_MIN) continue;
      out.push(e.by);
    }
    return out;
  }

  /** Absorb through armour plates first, then flesh. Returns what got through. */
  function applyArmour(rec, amount) {
    let left = amount;
    while (left > 0 && rec.plates > 0) {
      const take = Math.min(left, rec.plateHp);
      rec.plateHp -= take;
      left -= take;
      if (rec.plateHp <= 0) {
        rec.plates--;
        rec.plateHp = rec.plates > 0 ? PLATE_HP : 0;
        if (rec.isLocal) ctx.audio?.play?.('impact_metal', { spatial: false, level: 0.8 });
      }
    }
    return left;
  }

  /**
   * The public damage entry point. Bullets, blasts, killstreaks, bleedout — everything
   * lands here, and this is the only place that decides whether a hit counts.
   * @returns {number} damage actually applied
   */
  function damage(entity, amount, source = {}) {
    if (phase !== 'live' && phase !== 'roundend') return 0;
    const rec = recordFor(entity) || byEntity.get(entity) || null;
    if (!rec || !rec.alive || rec.downed) return 0;

    const attackerRec = source.attackerRecord || recordFor(source.attacker) || null;
    const friendly = !!attackerRec && attackerRec !== rec && !hostile(attackerRec, rec);
    if (friendly && !api.friendlyFire) return 0;

    let amt = Math.max(0, amount || 0);
    // Spawn protection soaks most of a spawn-camp burst rather than making anyone
    // bulletproof — and it lapses the moment the protected player takes a shot.
    if (now() < rec.protectedUntil && rec.lastFireTime < rec.spawnAt && source.source !== 'bleedout') {
      amt *= 0.2;
    }
    if (rec.isLocal) {
      const mods = loadouts?.mods;
      if (source.explosive || source.source === 'explosion' || source.type === 'frag') amt *= mods?.explosiveResist ?? 1;
      else amt *= mods?.bulletResist ?? 1;
    }
    if (friendly) amt *= 0.4;

    const through = applyArmour(rec, amt);
    rec.damageTaken += amt;
    rec.lastDamageAt = now();
    if (attackerRec) {
      attackerRec.damageDealt += amt;
      logDamage(rec, attackerRec, amt);
    }

    if (rec.bot) {
      // The AI owns bot health; route through the bus so flinch, suppression and the
      // ragdoll handoff all happen exactly as they would for a real bullet.
      if (!source.fromBus && through > 0) {
        ctx.bus?.emit?.('entity:damage', {
          target: rec.bot,
          amount: through,
          hitbox: source.hitbox || 'torso',
          attacker: source.attacker || attackerRec?.entity || null,
          point: source.point || null,
          dir: source.dir || null,
          weapon: source.weapon || null,
        });
      }
      rec.health = rec.bot.health;
      rec.alive = rec.bot.alive;
      return through;
    }

    rec.health = Math.max(0, rec.health - through);
    if (ctx.player && rec.isLocal) ctx.player.health = rec.health;

    if (rec.isLocal) {
      emitDamageIndicator(rec, attackerRec, source, through);
      emitHealth();
      // CameraRig owns the flinch reaction (it listens to `entity:damage` itself); the
      // perk's flinch scale is published on `ctx.game.perkMods` for it to read.
    }

    if (rec.health <= 0) {
      if (mode.revive && mode.lives === 1 && !rec.downed && teammatesAlive(rec) > 0) goDown(rec, attackerRec);
      else kill(rec, attackerRec, source);
    }
    return through;
  }

  function heal(entity, amount) {
    const rec = recordFor(entity);
    if (!rec || !rec.alive) return 0;
    const before = rec.health;
    rec.health = Math.min(rec.maxHealth, rec.health + Math.max(0, amount || 0));
    if (rec.isLocal) {
      if (ctx.player) ctx.player.health = rec.health;
      emitHealth();
    }
    return rec.health - before;
  }

  function teammatesAlive(rec) {
    let n = 0;
    for (const r of roster) if (r !== rec && r.team === rec.team && r.alive && !r.downed) n++;
    return n;
  }

  function goDown(rec, attackerRec) {
    rec.downed = true;
    rec.downedAt = now();
    rec.health = 1;
    rec.reviveProgress = 0;
    rec.lastKilledBy = attackerRec || rec.lastKilledBy;
    ctx.bus?.emit?.('game:downed', {
      player: rec.id,
      team: rec.team,
      local: !!rec.isLocal,
      attacker: attackerRec?.id || null,
    });
    if (rec.isLocal) {
      ctx.bus?.emit?.('hud:message', { kind: 'downed', text: 'YOU ARE DOWN', sub: 'Hold on for a revive', duration: 3 });
      emitHealth();
    }
  }

  function reviveTick(rec, reviver, dt) {
    if (!rec?.downed) return 0;
    rec.reviver = reviver;
    rec.reviveProgress = clamp01(rec.reviveProgress + dt / (mode.reviveTime || 4));
    if (rec.reviveProgress >= 1) {
      rec.downed = false;
      rec.health = Math.round(rec.maxHealth * 0.5);
      rec.reviveProgress = 0;
      rec.protectedUntil = now() + 1.2;
      scoring?.award?.(reviver, 'revive', { teamDelta: 0 });
      ctx.bus?.emit?.('game:revived', { player: rec.id, by: reviver?.id || null });
      if (rec.isLocal) emitHealth();
    }
    return rec.reviveProgress;
  }

  /* ══════════════════════════════════════════════════════════════ deaths ══ */

  function weaponNameOf(w) {
    if (!w) return '';
    const id = typeof w === 'string' ? w : w.id || w.weaponId || String(w);
    const def = ctx.weapons?.defs?.[id];
    return def?.name || (typeof id === 'string' ? id : '');
  }

  function kill(rec, attackerRec, source = {}) {
    if (!rec || !rec.alive) return;
    rec.alive = false;
    rec.downed = false;
    rec.deathAt = now();
    stats.deaths++;
    if (mode.lives !== Infinity) rec.lives = Math.max(0, (rec.lives === Infinity ? mode.lives : rec.lives) - 1);

    // Fold in whatever the last `entity:damage` said — the death event alone does not
    // know about penetration, range or which gun did it.
    const lh =
      rec.lastHit && now() - rec.lastHit.t < 1.2 && (!attackerRec || rec.lastHit.by === attackerRec)
        ? rec.lastHit
        : null;
    const weapon = source.weapon || lh?.weapon || null;
    const hitbox = source.hitbox || lh?.hitbox || 'torso';
    const distance = Number.isFinite(source.distance)
      ? source.distance
      : Number.isFinite(lh?.distance)
        ? lh.distance
        : attackerRec?.position && rec.position
          ? attackerRec.position.distanceTo(rec.position)
          : undefined;

    const info = {
      attacker: attackerRec,
      victim: rec,
      weapon: typeof weapon === 'string' ? weapon : weapon?.id || '',
      weaponName: weaponNameOf(weapon) || (source.streak ? 'Killstreak' : ''),
      headshot: hitbox === 'head' || !!source.headshot || !!lh?.headshot,
      distance,
      wallbang: !!source.wallbang || !!lh?.wallbang,
      explosive: !!source.explosive || source.source === 'explosion' || !!lh?.explosive,
      melee: hitbox === 'melee' || !!source.melee,
      streak: source.streak || null,
      teamkill: !!attackerRec && attackerRec !== rec && !hostile(attackerRec, rec),
      suicide: !attackerRec || attackerRec === rec,
      objective: !!source.objective || insideObjective(rec),
      assists: assistsFor(rec, attackerRec),
    };

    const result = scoring?.registerKill?.(info) || { points: 0 };

    if (attackerRec && !info.teamkill && !info.suicide) {
      killstreaks?.onKill?.(attackerRec);
      if (attackerRec.isLocal) {
        scoring?.hitmarker?.({ lethal: true, headshot: info.headshot, damage: source.amount || 0 });
        if (loadouts?.mods?.scavenger) loadouts.resupply(0.5);
      }
    }
    killstreaks?.onDeath?.(rec);

    if (rec.isLocal) {
      try {
        ctx.player?.suspend?.(true);
      } catch {
        /* optional */
      }
      const killerName = attackerRec ? attackerRec.name : 'the world';
      ctx.bus?.emit?.('hud:message', {
        kind: 'death',
        text: `KILLED BY ${String(killerName).toUpperCase()}`,
        sub: mode.lives === 1 ? 'Spectating' : 'Respawning…',
        duration: 3,
      });
      emitHealth();
    }

    const delay =
      mode.respawn === Infinity
        ? Infinity
        : mode.respawn * (rec.isLocal ? loadouts?.mods?.respawnScale ?? 1 : 0.85 + rng() * 0.5);
    rec.respawnAt = now() + delay;

    ctx.bus?.emit?.('game:death', {
      player: rec.id,
      team: rec.team,
      attacker: attackerRec?.id || null,
      attackerName: attackerRec?.name || '',
      headshot: info.headshot,
      weapon: info.weaponName,
      local: !!rec.isLocal,
      points: result.points,
      respawnIn: delay === Infinity ? null : Math.round(delay * 10) / 10,
    });

    // The AI emits its own entity:death; only synthesise one for the local player.
    if (rec.isLocal) {
      ctx.bus?.emit?.('entity:death', {
        target: ctx.player,
        attacker: source.attacker || attackerRec?.entity || null,
        weapon: weapon || null,
        hitbox,
      });
    }

    checkWinConditions();
  }

  function insideObjective(rec) {
    const zones = objectives?.zones;
    if (!zones?.length || !rec.position) return false;
    for (const z of zones) {
      if (!z.active) continue;
      const dx = rec.position.x - z.pos.x;
      const dz = rec.position.z - z.pos.z;
      if (dx * dx + dz * dz <= z.radius * z.radius) return true;
    }
    return false;
  }

  /* ══════════════════════════════════════════════════════════ hud plumbing ══ */

  function emitHealth() {
    if (!local) return;
    ctx.bus?.emit?.('hud:health', {
      health: Math.round(local.health),
      max: local.maxHealth,
      fraction: clamp01(local.health / Math.max(1, local.maxHealth)),
      plates: local.plates,
      maxPlates: local.maxPlates,
      plateFraction: local.maxPlates ? clamp01((Math.max(0, local.plates - 1) + local.plateHp / PLATE_HP) / local.maxPlates) : 0,
      regen: now() - local.lastDamageAt > regenDelay() && local.health < local.maxHealth,
      downed: local.downed,
      reviveProgress: local.reviveProgress,
      alive: local.alive,
      respawnIn: local.alive ? 0 : Math.max(0, Math.round((local.respawnAt - now()) * 10) / 10),
    });
  }

  function emitDamageIndicator(rec, attackerRec, source, amount) {
    const from = source.point || attackerRec?.position;
    if (!from || !rec.position) return;
    _v.set(from.x - rec.position.x, 0, from.z - rec.position.z);
    if (_v.lengthSq() < 1e-5) return;
    const dist = _v.length();
    _v.multiplyScalar(1 / dist);
    const yaw = ctx.player?.yaw ?? ctx.camera?.rotation?.y ?? 0;
    // Angle in view space: 0 = dead ahead, positive = to the right.
    const world = Math.atan2(_v.x, -_v.z);
    let rel = world - yaw;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    ctx.bus?.emit?.('hud:damage', {
      angle: rel,
      degrees: (rel * 180) / Math.PI,
      amount: Math.round(amount),
      distance: Math.round(dist * 10) / 10,
      attacker: attackerRec?.id || null,
      attackerName: attackerRec?.name || '',
      explosive: !!source.explosive,
      lethal: rec.health <= 0,
    });
  }

  function regenDelay() {
    return 4.6 * (loadouts?.mods?.regenDelayScale ?? 1);
  }

  /**
   * `remaining` is the MATCH clock and nothing else. It used to carry `phaseTimer`
   * whenever the match was not live, so the header clock showed the pre-match
   * warm-up — a two-second countdown sitting where ten minutes should be, next to
   * a scoreline that was already climbing. The phase countdown is its own field;
   * the header clock reads full time before the whistle and counts down after it,
   * which is what a match clock is.
   */
  function emitTimer() {
    const matchLeft = Math.max(0, (mode.timeLimit || 0) - matchClock);
    ctx.bus?.emit?.('hud:timer', {
      remaining: Math.ceil(matchLeft),
      running: phase === 'live',
      countdown: phase === 'live' ? 0 : Math.max(0, Math.ceil(phaseTimer)),
      limit: mode.timeLimit || 0,
      phase,
      round,
      rounds: mode.rounds,
      roundsWon: { ...roundsWon },
    });
  }

  function emitScoreboard(open) {
    const board = scoring?.scoreboard?.(roster, { winner, reason: endReason });
    ctx.bus?.emit?.('hud:scoreboard', { ...(board || {}), open: !!open, phase });
    return board;
  }

  function setPhase(next, seconds) {
    const prev = phase;
    phase = next;
    phaseTimer = seconds ?? 0;
    lastCountdown = -1;
    ctx.bus?.emit?.('game:state', { state: phase, previous: prev, mode: mode.id, round });
    emitTimer();
  }

  /* ═══════════════════════════════════════════════════════════ match flow ══ */

  function setMode(name) {
    const next = MODES[name] || MODES[String(name).toLowerCase()] || null;
    if (!next) return mode;
    mode = next;
    scoring?.reset?.(mode);
    objectives?.setMode?.(mode);
    killstreaks?.reset?.();
    roundsWon.A = 0;
    roundsWon.B = 0;
    round = 1;
    ctx.bus?.emit?.('hud:mode', {
      id: mode.id,
      name: mode.name,
      short: mode.short,
      scoreLimit: mode.scoreLimit,
      timeLimit: mode.timeLimit,
      teams: mode.teams,
    });
    return mode;
  }

  function goalText() {
    switch (mode.winBy) {
      case 'rounds':
        return `First to ${mode.scoreLimit} rounds`;
      case 'kills':
        return `First to ${mode.scoreLimit} kills`;
      default:
        return `Score limit ${mode.scoreLimit}`;
    }
  }

  function start() {
    if (!local) ensureLocal();
    if (!botsAssigned) adoptBots();
    scoring?.reset?.(mode);
    objectives?.reset?.();
    killstreaks?.reset?.();
    matchClock = 0;
    winner = null;
    endReason = '';
    round = 1;
    roundsWon.A = 0;
    roundsWon.B = 0;
    for (const rec of roster) {
      rec.score = 0;
      rec.kills = 0;
      rec.deaths = 0;
      rec.assists = 0;
      rec.streak = 0;
      rec.bestStreak = 0;
      rec.headshots = 0;
      rec.longshots = 0;
      rec.wallbangs = 0;
      rec.captures = 0;
      rec.defends = 0;
      rec.plants = 0;
      rec.defuses = 0;
      rec.damageDealt = 0;
      rec.damageTaken = 0;
      rec.lives = mode.lives;
      rec.streakBag = { earned: [], used: [], progress: 0 };
      resetRecordForSpawn(rec);
    }
    setPhase('pregame', headless ? 2.5 : 7);
    ctx.bus?.emit?.('game:start', {
      mode: mode.id,
      name: mode.name,
      teams: mode.teams,
      roster: roster.map((r) => ({ id: r.id, name: r.name, team: r.team, bot: r.isBot })),
    });
    ctx.bus?.emit?.('hud:message', { kind: 'modestart', text: mode.name.toUpperCase(), sub: goalText(), duration: 4 });
    return api;
  }

  /**
   * Headless only. The review harness simulates well under a second of game time
   * per pose, so left alone every screenshot shows the opening whistle: 0-0, a
   * full clock, no streaks, an empty killfeed. That is not the state the interface
   * is meant to be judged in, and the HUD used to paper over it by faking its own
   * numbers on top — two sources of truth, which is how the same review set ended
   * up with one clock value at two different scores.
   *
   * So the *match* starts mid-way instead, once, here. Everything downstream —
   * header, streak chips, scoreboard — is then reading real state.
   */
  function seedReviewMatch() {
    matchClock = Math.max(0, (mode.timeLimit || 600) - 428);
    const limit = mode.scoreLimit || 75;
    if (mode.teams) {
      scoring?.teamAward?.(localTeam, Math.round(limit * 0.56), 'seed');
      scoring?.teamAward?.(localTeam === 'A' ? 'B' : 'A', Math.round(limit * 0.49), 'seed');
    }
    if (local) {
      local.score = 1250;
      local.kills = 21;
      local.deaths = 14;
      local.assists = 6;
      local.headshots = 7;
      local.streak = 7; // uav (4) + counter-uav (5) + airstrike (7): three in hand
      local.bestStreak = 7;
      killstreaks?.onKill?.(local);
      ctx.bus?.emit?.('hud:points', { local: true, delta: 0, total: local.score });
    }
    emitTimer();
  }

  function beginLive() {
    setPhase('live', 0);
    for (const rec of roster) {
      rec.lives = mode.lives;
      respawn(rec);
    }
    if (headless) seedReviewMatch();
    ctx.bus?.emit?.('hud:message', { kind: 'go', text: 'FIGHT', sub: '', duration: 1.4 });
    ctx.audio?.play?.('notify', { spatial: false });
  }

  function end(who, reason) {
    if (phase === 'postgame') return;
    winner = who ?? null;
    endReason = reason || '';
    const board = emitScoreboard(true);
    setPhase('postgame', headless ? 4 : 14);
    try {
      ctx.player?.suspend?.(true);
    } catch {
      /* optional */
    }
    const text = !mode.teams
      ? board?.mvp?.isLocal
        ? 'VICTORY'
        : 'DEFEAT'
      : winner === null
        ? 'DRAW'
        : winner === localTeam
          ? 'VICTORY'
          : 'DEFEAT';
    ctx.bus?.emit?.('hud:message', { kind: 'matchend', text, sub: endReason, duration: 6 });
    ctx.bus?.emit?.('game:end', { winner, reason: endReason, mode: mode.id, scoreboard: board });
    ctx.audio?.play?.('notify', { spatial: false });
  }

  function restart() {
    scoreboardOpen = false;
    ctx.bus?.emit?.('hud:scoreboard', { open: false });
    // Rotate the playlist so a long session sees every mode.
    const i = MODE_ORDER.indexOf(mode.id);
    setMode(MODE_ORDER[(i + 1 + MODE_ORDER.length) % MODE_ORDER.length]);
    start();
  }

  function endRound(who, reason) {
    if (who) roundsWon[who] = (roundsWon[who] || 0) + 1;
    if (who) scoring?.teamAward?.(who, 1, 'round');
    ctx.bus?.emit?.('game:round', { round, winner: who, reason, roundsWon: { ...roundsWon } });
    ctx.bus?.emit?.('hud:message', {
      kind: 'roundend',
      text: who ? (who === localTeam ? 'ROUND WON' : 'ROUND LOST') : 'ROUND DRAW',
      sub: reason || '',
      duration: 4,
    });
    if (who && roundsWon[who] >= mode.scoreLimit) {
      end(who, `${who === localTeam ? 'Your team' : 'The enemy'} won ${roundsWon[who]} rounds`);
      return;
    }
    setPhase('roundend', headless ? 2 : 6);
  }

  function beginRound() {
    round++;
    objectives?.reset?.();
    matchClock = 0;
    for (const rec of roster) {
      rec.lives = mode.lives;
      respawn(rec);
    }
    setPhase('live', 0);
    ctx.bus?.emit?.('hud:message', { kind: 'roundstart', text: `ROUND ${round}`, sub: goalText(), duration: 3 });
  }

  function checkWinConditions() {
    if (phase !== 'live') return;
    const s = scoring?.teams || { A: 0, B: 0 };

    if (mode.winBy === 'rounds') {
      const b = objectives?.bomb;
      if (b?.defused) {
        endRound(mode.attackers === 'A' ? 'B' : 'A', 'Bomb defused');
        return;
      }
      if (b?.exploded) {
        endRound(mode.attackers || 'A', 'Bomb detonated');
        return;
      }
      const aAlive = playersOfTeam('A').filter((r) => r.alive && !r.downed).length;
      const bAlive = playersOfTeam('B').filter((r) => r.alive && !r.downed).length;
      if (aAlive === 0 && bAlive === 0) endRound(null, 'Mutual destruction');
      else if (aAlive === 0 && !b?.planted) endRound('B', 'Attackers eliminated');
      else if (bAlive === 0) endRound('A', 'Defenders eliminated');
      return;
    }

    if (!mode.teams) {
      let leader = null;
      for (const r of roster) if (!leader || r.kills > leader.kills) leader = r;
      if (leader && leader.kills >= mode.scoreLimit) {
        end(leader.isLocal ? localTeam : enemyTeam(), `${leader.name} reached ${mode.scoreLimit} kills`);
      }
      return;
    }

    if (s.A >= mode.scoreLimit) end('A', 'Score limit reached');
    else if (s.B >= mode.scoreLimit) end('B', 'Score limit reached');
  }

  /* ══════════════════════════════════════════════════════ objective hooks ══ */

  function onZoneCaptured(zone, team, contributors) {
    for (const rec of contributors || []) {
      if (!rec || rec.team !== team) continue;
      rec.captures++;
      scoring?.award?.(rec, contributors.length > 1 ? 'capture_assist' : 'capture', { teamDelta: 0 });
    }
    ctx.bus?.emit?.('hud:message', {
      kind: 'objective',
      text: team === localTeam ? `${zone.label} CAPTURED` : `${zone.label} LOST`,
      sub: zone.name || '',
      duration: 2.6,
    });
    ctx.audio?.play?.('notify', { spatial: false });
  }

  let domTick = 0;
  function tickDomination(dt) {
    domTick += dt;
    const every = mode.tickEvery || 5;
    if (domTick < every) return;
    domTick -= every;
    for (const team of ['A', 'B']) {
      const owned = objectives?.ownedBy?.(team) || 0;
      if (owned > 0) scoring?.teamAward?.(team, owned, 'domination');
    }
    for (const z of objectives?.zones || []) {
      if (!z.owner) continue;
      for (const rec of z.inside) if (rec.team === z.owner) scoring?.award?.(rec, 'hold', { teamDelta: 0 });
    }
    checkWinConditions();
  }

  const hpAccum = { A: 0, B: 0 };
  function onHardpointTick(zone, team, dt, inside) {
    hpAccum[team] = (hpAccum[team] || 0) + dt;
    while (hpAccum[team] >= 1) {
      hpAccum[team] -= 1;
      scoring?.teamAward?.(team, 1, 'hardpoint');
      for (const rec of inside || []) if (rec.team === team) scoring?.award?.(rec, 'hold', { teamDelta: 0 });
    }
    void zone;
    checkWinConditions();
  }

  function onBombPlanted(rec, site) {
    rec.plants++;
    scoring?.award?.(rec, 'plant', { teamDelta: 0 });
    ctx.bus?.emit?.('hud:message', { kind: 'objective', text: `BOMB PLANTED AT ${site.label}`, sub: '', duration: 3 });
    ctx.audio?.play?.('notify', { spatial: false });
  }

  function onBombDefused(rec) {
    rec.defuses++;
    scoring?.award?.(rec, 'defuse', { teamDelta: 0 });
    checkWinConditions();
  }

  function onBombDetonated() {
    checkWinConditions();
  }

  /* ════════════════════════════════════════════════════ bot orchestration ══ */

  let goalCursor = 0;

  /** Push bots toward whatever the mode says matters, a couple at a time. */
  function driveBotGoals() {
    if (!roster.length) return;
    const zones = objectives?.zones;
    const t = now();
    let budget = 2;
    for (let n = 0; n < roster.length && budget > 0; n++) {
      goalCursor = (goalCursor + 1) % roster.length;
      const rec = roster[goalCursor];
      const bot = rec.bot;
      if (!bot || !rec.alive) continue;
      if (t < rec.goalAt) continue;
      rec.goalAt = t + 4 + rng() * 4;
      budget--;

      let target = null;
      if (zones?.length) {
        let best = null;
        let bestScore = -1e9;
        for (const z of zones) {
          if (!z.active) continue;
          const d = Math.hypot(z.pos.x - bot.position.x, z.pos.z - bot.position.z);
          let s = 90 - d;
          if (z.owner === rec.team) s -= 40;
          if (z.contested) s += 55;
          if (z.kind === 'hardpoint') s += 45;
          s += rng() * 25;
          if (s > bestScore) {
            bestScore = s;
            best = z;
          }
        }
        if (best) {
          const a = rng() * Math.PI * 2;
          const r = best.radius * 0.65 * Math.sqrt(rng());
          target = _v3.set(best.pos.x + Math.cos(a) * r, best.pos.y, best.pos.z + Math.sin(a) * r);
        }
      } else if (rec.foe?.alive && rec.foe.position) {
        target = _v3.copy(rec.foe.position);
      }
      if (!target) continue;
      try {
        bot.setGoal(target, { arrive: 1.4, sprint: rng() < 0.35 });
      } catch {
        /* nav can refuse; the bot just keeps patrolling */
      }
    }
  }

  /**
   * Cross-team firefights between bots. See the note in the file header: the AI
   * cannot shoot its own kind, so the exchange is resolved here — with real line of
   * sight, real damage through the bus, real tracers and real audio.
   */
  let losCursor = 0;
  let tracerBudget = 0;
  function tickEngagements(dt) {
    if (phase !== 'live') return;
    tracerBudget = Math.min(4, tracerBudget + dt * 5);
    const t = now();
    const skill = SKILL_BY_DIFFICULTY[ctx.ai?.difficulty] || SKILL_BY_DIFFICULTY.regular;

    let acquire = 2;
    for (let n = 0; n < roster.length && acquire > 0; n++) {
      losCursor = (losCursor + 1) % roster.length;
      const rec = roster[losCursor];
      if (!rec.bot || !rec.alive) continue;
      if (rec.foe && rec.foe.alive && t < rec.foeUntil) continue;
      acquire--;
      rec.foe = null;
      rec.foeUntil = t + 2.5;
      let best = null;
      let bestD = 1e9;
      for (const other of roster) {
        if (other === rec || !other.alive || !other.bot) continue;
        if (!hostile(rec, other)) continue;
        const d = Math.hypot(other.position.x - rec.position.x, other.position.z - rec.position.z);
        if (d > 46 || d >= bestD) continue;
        _v.set(rec.position.x, rec.position.y + 1.5, rec.position.z);
        _v2.set(other.position.x, other.position.y + 1.15, other.position.z);
        _dir.copy(_v2).sub(_v);
        const dist = _dir.length();
        if (dist < 0.5) continue;
        _dir.multiplyScalar(1 / dist);
        stats.rays++;
        if (ctx.physics?.raycast?.(_v, _dir, dist - 0.5, 1 | 8)) continue;
        best = other;
        bestD = d;
      }
      if (best) {
        rec.foe = best;
        rec.foeUntil = t + 3 + rng() * 2;
        rec.nextExchange = Math.min(rec.nextExchange, t + 0.35 + rng() * 0.5);
        stats.engagements++;
      }
    }

    for (const rec of roster) {
      if (!rec.bot || !rec.alive) continue;
      const foe = rec.foe;
      if (!foe || !foe.alive) continue;
      if (t < rec.nextExchange) continue;
      rec.nextExchange = t + skill.burstGap * (0.7 + rng() * 0.8);
      rec.lastFireTime = t;
      const d = rec.position.distanceTo(foe.position);
      if (d > 50) {
        rec.foe = null;
        continue;
      }
      const rounds = 2 + Math.floor(rng() * 4);
      const hitChance = clamp(skill.accuracy * (1 - d / 70), 0.06, 0.62);
      let dealt = 0;
      for (let i = 0; i < rounds; i++) if (rng() < hitChance) dealt += 22 + rng() * 12;
      _v.set(rec.position.x, rec.position.y + 1.5, rec.position.z);
      _v2.set(foe.position.x, foe.position.y + 1.05, foe.position.z);
      _dir.copy(_v2).sub(_v).normalize();
      if (tracerBudget >= 1) {
        tracerBudget -= 1;
        try {
          ctx.fx?.tracer?.(_v, _v2, { width: 0.03, speed: 780 });
          ctx.fx?.muzzle?.(_v, _dir, { scale: 0.6, world: true });
        } catch {
          /* fx optional */
        }
        ctx.audio?.playAt?.('distant_gunfire', _v, { volume: 0.42 });
      }
      if (dealt > 0) {
        damage(foe.bot, dealt, {
          attacker: rec.bot,
          attackerRecord: rec,
          point: _v.clone(),
          dir: _dir.clone(),
          hitbox: rng() < 0.12 ? 'head' : 'torso',
          weapon: rec.loadout?.primary || 'ar_wolverine',
          source: 'bot',
        });
      }
    }
  }

  /* ═══════════════════════════════════════════════════════ difficulty drift ══ */

  const DIFF_ORDER = ['recruit', 'regular', 'hardened', 'veteran'];
  let diffClock = 0;

  /**
   * Slow adaptive difficulty. Every 45 s of live play the local player's kill/death
   * ratio nudges the AI profile one step, so a good session gets harder and a bad one
   * stops being punishing. Never jumps more than one tier at a time.
   */
  function tickDifficulty(dt) {
    if (!api.adaptiveDifficulty || !local) return;
    diffClock += dt;
    if (diffClock < 45) return;
    diffClock = 0;
    if (local.kills + local.deaths < 6) return;
    const kd = local.deaths > 0 ? local.kills / local.deaths : local.kills;
    const cur = Math.max(0, DIFF_ORDER.indexOf(ctx.ai?.difficulty || 'regular'));
    let next = cur;
    if (kd > 2.2) next = Math.min(DIFF_ORDER.length - 1, cur + 1);
    else if (kd < 0.55) next = Math.max(0, cur - 1);
    if (next === cur) return;
    setDifficulty(DIFF_ORDER[next]);
    ctx.bus?.emit?.('game:difficulty', { difficulty: DIFF_ORDER[next], previous: DIFF_ORDER[cur], kd });
  }

  function setDifficulty(name) {
    if (!DIFF_ORDER.includes(name)) return ctx.ai?.difficulty || 'regular';
    ctx.ai?.setDifficulty?.(name);
    refreshSensorBaselines();
    applyBotSensors();
    return name;
  }

  /* ═════════════════════════════════════════════════════════════════ input ══ */

  const KEY_STREAK = ['Digit3', 'Digit4', 'Digit5'];

  function keyPressed(code) {
    return !!ctx.input?.pressedThisFrame?.has?.(code);
  }

  function handleInput(dt) {
    const input = ctx.input;
    if (!input || !local) return;

    const wantBoard = !!input.action?.('scoreboard') || phase === 'postgame';
    if (wantBoard !== scoreboardOpen) {
      scoreboardOpen = wantBoard;
      emitScoreboard(scoreboardOpen);
    }

    if (phase !== 'live' || !local.alive) return;

    for (let i = 0; i < KEY_STREAK.length; i++) {
      if (keyPressed(KEY_STREAK[i])) killstreaks?.useSlot?.(local, i);
    }

    if (input.pressed?.('grenade')) throwEquipment('lethal');
    if (keyPressed('KeyQ') && !input.action?.('sprint')) throwEquipment('tactical');

    for (let i = 0; i < 5; i++) {
      if (keyPressed(`Digit${6 + i}`) || (i === 4 && keyPressed('Digit0'))) loadouts?.select?.(i);
    }

    if (input.action?.('use')) {
      if (mode.objective === 'bomb') {
        if (objectives?.bombPlanted) objectives.tryDefuse(local, dt);
        else objectives?.tryPlant?.(local, dt);
      }
      if (mode.revive) {
        for (const r of roster) {
          if (!r.downed || r.team !== local.team || r === local) continue;
          if (r.position.distanceTo(local.position) < 2.2) {
            reviveTick(r, local, dt);
            break;
          }
        }
      }
    }
  }

  function throwEquipment(kind) {
    if (!local?.alive) return false;
    const def = kind === 'lethal' ? loadouts?.takeLethal?.() : loadouts?.takeTactical?.();
    if (!def) {
      ctx.audio?.play?.('ui_error', { spatial: false });
      return false;
    }
    const cam = ctx.camera;
    if (!cam) return false;
    _dir.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(_q));
    _v.copy(cam.position).addScaledVector(_dir, 0.45);
    _dir.y += 0.18;
    _dir.normalize();
    try {
      ctx.ballistics?.throwGrenade?.(_v, _dir, {
        owner: ctx.player,
        attacker: ctx.player,
        speed: def.speed || 18,
        fuse: def.fuse || 3,
        radius: def.radius,
        damage: def.damage,
        type: def.type || def.effect || 'frag',
        sticky: !!def.sticky,
      });
    } catch (err) {
      warn('throw failed', err);
    }
    ctx.bus?.emit?.('hud:equipmentused', { kind, id: def.id, name: def.name });
    return true;
  }

  /* ═══════════════════════════════════════════════════════════════ regen ══ */

  function tickLocalHealth(dt) {
    if (!local || !local.alive) return;
    const t = now();

    if (local.downed) {
      const bleed = mode.bleedout || 22;
      if (t - local.downedAt > bleed) kill(local, local.lastKilledBy, { source: 'bleedout' });
      return;
    }

    const sinceHit = t - local.lastDamageAt;
    if (local.health < local.maxHealth && sinceHit > regenDelay()) {
      const rate = 34 * (loadouts?.mods?.regenRateScale ?? 1);
      local.health = Math.min(local.maxHealth, local.health + rate * dt);
      if (ctx.player) ctx.player.health = local.health;
    }
    if (local.plates < local.maxPlates && sinceHit > PLATE_REGEN_DELAY && t - local.lastPlateAt > PLATE_REGEN_TIME) {
      local.lastPlateAt = t;
      local.plates++;
      local.plateHp = PLATE_HP;
      ctx.audio?.play?.('gear', { spatial: false, level: 0.7 });
    }
  }

  function applyPlate() {
    if (!local || local.plates >= local.maxPlates) return false;
    local.plates++;
    local.plateHp = PLATE_HP;
    local.lastPlateAt = now();
    emitHealth();
    return true;
  }

  /* ═══════════════════════════════════════════════════════════ bus wiring ══ */

  function onEntityDamage(e) {
    if (!e) return;
    const rec = recordFor(e.target);
    if (!rec) return;
    const attackerRec = recordFor(e.attacker);

    // `entity:death` carries far less than `entity:damage`; remember the shot that
    // is about to become the killing blow so the killfeed can call it correctly.
    rec.lastHit = {
      t: now(),
      by: attackerRec,
      weapon: e.weapon || null,
      hitbox: e.hitbox || null,
      headshot: e.hitbox === 'head' || !!e.headshot,
      wallbang: !!e.penetrated || !!e.wallbang,
      explosive: e.source === 'explosion' || !!e.explosive,
      distance: Number.isFinite(e.distance) ? e.distance : undefined,
      surface: e.surface || null,
    };

    if (rec.isLocal) {
      // Ballistics/AI have already decided the number; run it through our armour,
      // resistances and bookkeeping. `fromBus` stops us re-emitting it.
      damage(ctx.player, e.amount ?? 0, {
        attacker: e.attacker,
        attackerRecord: attackerRec,
        point: e.point,
        dir: e.dir,
        hitbox: e.hitbox,
        weapon: e.weapon,
        explosive: e.source === 'explosion' || e.explosive,
        wallbang: e.penetrated || e.wallbang,
        fromBus: true,
      });
      return;
    }

    // A bot took a hit somebody else applied: record it for assists and hitmarkers.
    if (rec.bot) rec.health = rec.bot.health;
    rec.damageTaken += e.amount ?? 0;
    rec.lastDamageAt = now();
    if (attackerRec) {
      attackerRec.damageDealt += e.amount ?? 0;
      logDamage(rec, attackerRec, e.amount ?? 0);
      if (attackerRec.isLocal && hostile(attackerRec, rec)) {
        scoring?.noteShot?.(true);
        scoring?.hitmarker?.({
          headshot: e.hitbox === 'head',
          damage: e.amount ?? 0,
          lethal: (rec.bot?.health ?? 1) <= 0,
          armour: !!e.armour,
        });
      }
    }
  }

  function onEntityDeath(e) {
    if (!e) return;
    const rec = recordFor(e.target);
    if (!rec || rec.isLocal || !rec.alive) return; // the local death is authored in kill()
    const attackerRec = recordFor(e.attacker);
    kill(rec, attackerRec, {
      weapon: e.weapon,
      hitbox: e.hitbox,
      attacker: e.attacker,
      wallbang: e.penetrated,
    });
    stats.botKills++;
  }

  function onWeaponFire() {
    if (!local) return;
    local.lastFireTime = now();
    scoring?.noteShot?.(false);
  }

  function onPose(state) {
    if (!state) return;
    if (state.mode && MODES[state.mode]) setMode(state.mode);
    if (state.game === 'live' || state.gameState === 'live') setPhase('live', 0);
    if (state.game === 'postgame' || state.gameState === 'postgame') end(localTeam, 'debug');
    if (state.teamScore) {
      scoring?.teamAward?.('A', state.teamScore.A || 0, 'debug');
      scoring?.teamAward?.('B', state.teamScore.B || 0, 'debug');
    }
    if (state.objectives === false) objectives?.setVisible?.(false);
    if (state.objectives === true) objectives?.setVisible?.(true);
  }

  /* ═══════════════════════════════════════════════════════════════ frame ══ */

  function syncRecords() {
    for (const rec of roster) {
      if (rec.bot) {
        const wasAlive = rec.alive;
        rec.alive = rec.bot.alive;
        rec.health = rec.bot.health;
        rec.maxHealth = rec.bot.maxHealth || 100;
        rec.position = rec.bot.position;
        rec.yaw = rec.bot.yaw;
        if (wasAlive && !rec.alive && rec.deathAt < 0) {
          // A death that never reached the bus (corpse recycle, debug wipe).
          rec.deathAt = now();
          rec.respawnAt = now() + (mode.respawn === Infinity ? 1e9 : mode.respawn);
        }
        if (!wasAlive && rec.alive) rec.deathAt = -1;
      } else if (rec.isLocal) {
        if (ctx.player?.position) rec.position = ctx.player.position;
        rec.yaw = ctx.player?.yaw ?? 0;
      }
    }
  }

  function tickRespawns() {
    if (phase !== 'live') return;
    const t = now();
    for (const rec of roster) {
      if (rec.alive || rec.downed) continue;
      if (mode.lives !== Infinity) continue; // one-life modes wait for the round
      if (!Number.isFinite(rec.respawnAt) || t < rec.respawnAt) continue;
      respawn(rec);
    }
  }

  let hudClock = 0;

  function update(dt) {
    if (disposed || paused) return;
    const step = Math.min(dt, 0.1);

    if (!botsAssigned && ctx.ai?.bots?.length) adoptBots();
    syncRecords();

    switch (phase) {
      case 'idle':
        if (levelReady && (aiReady || now() > 3)) start();
        break;
      case 'pregame': {
        phaseTimer -= step;
        const s = Math.max(0, Math.ceil(phaseTimer));
        if (s !== lastCountdown) {
          lastCountdown = s;
          ctx.bus?.emit?.('hud:countdown', { seconds: s, phase, text: s > 0 ? String(s) : 'GO' });
        }
        if (phaseTimer <= 0) beginLive();
        break;
      }
      case 'live':
        matchClock += step;
        if (mode.timeLimit && matchClock >= mode.timeLimit) {
          if (mode.winBy === 'rounds') endRound(mode.attackers === 'A' ? 'B' : 'A', 'Time expired');
          else {
            const s = scoring?.teams || { A: 0, B: 0 };
            end(s.A === s.B ? null : s.A > s.B ? 'A' : 'B', 'Time expired');
          }
        }
        break;
      case 'roundend':
        phaseTimer -= step;
        if (phaseTimer <= 0) beginRound();
        break;
      case 'postgame':
        phaseTimer -= step;
        if (phaseTimer <= 0) restart();
        break;
      default:
        break;
    }

    const live = phase === 'live';
    objectives?.update?.(step, roster, live);
    if (live) {
      tickLocalHealth(step);
      tickRespawns();
      if (mode.objective === 'domination') tickDomination(step);
      driveBotGoals();
      tickEngagements(step);
      tickDifficulty(step);
    }
    killstreaks?.update?.(step);
    handleInput(step);

    hudClock += step;
    if (hudClock > 0.25) {
      hudClock = 0;
      emitTimer();
      emitHealth();
    }
  }

  /* ═════════════════════════════════════════════════════════════════ api ══ */

  const api = {
    ready: false,
    MODES,
    friendlyFire: false,
    /** Nudge the AI profile toward the player's actual performance. */
    adaptiveDifficulty: true,

    get mode() {
      return mode;
    },
    get modeId() {
      return mode.id;
    },
    get modes() {
      return MODE_ORDER.slice();
    },
    get state() {
      return phase;
    },
    get phase() {
      return phase;
    },
    get round() {
      return round;
    },
    get roundsWon() {
      return { ...roundsWon };
    },
    get score() {
      return scoring ? { ...scoring.teams } : { A: 0, B: 0 };
    },
    get players() {
      return roster;
    },
    get localPlayer() {
      return local;
    },
    get localTeam() {
      return localTeam;
    },
    get playerHealth() {
      return local?.health ?? 100;
    },
    get playerMaxHealth() {
      return local?.maxHealth ?? 100;
    },
    get plates() {
      return local?.plates ?? 0;
    },
    get killfeed() {
      return scoring?.killfeed || [];
    },
    get timeRemaining() {
      return Math.max(0, (mode.timeLimit || 0) - matchClock);
    },
    get scoring() {
      return scoring;
    },
    get objectives() {
      return objectives;
    },
    get loadouts() {
      return loadouts;
    },
    get killstreaks() {
      return killstreaks;
    },
    get perkMods() {
      return loadouts?.mods || null;
    },
    stats,

    setMode,
    start,
    end,
    restart,
    respawn,
    damage,
    heal,
    kill(entity, attacker, source) {
      const rec = recordFor(entity);
      if (rec) kill(rec, recordFor(attacker), source || {});
    },
    getSpawn,
    recordFor,
    playersOfTeam,
    enemiesOf,
    hostile,
    applyPlate,
    reviveTick,
    scoreboard: () => scoring?.scoreboard?.(roster, { winner, reason: endReason }) || null,
    selectLoadout: (i) => loadouts?.select?.(i),
    useKillstreak: (id) => (local ? killstreaks?.use?.(local, id) : false),
    setDifficulty,
    get difficulty() {
      return ctx.ai?.difficulty || 'regular';
    },
    setBotCount(n) {
      try {
        ctx.ai?.populate?.(clamp(n | 0, 0, 24));
        adoptBots();
      } catch (err) {
        warn('setBotCount', err);
      }
    },
    pause(v) {
      paused = !!v;
    },
    /* objective callbacks, called by Objectives.js */
    onZoneCaptured,
    onHardpointTick,
    onBombPlanted,
    onBombDefused,
    onBombDetonated,
  };

  ctx.game = api;

  /* ══════════════════════════════════════════════════════════════ system ══ */

  return {
    name: 'game',
    order: 90,

    async init() {
      ctx.game = api;
      headless = !!ctx.settings?.get?.('headless');

      loadouts = createLoadouts(ctx);
      scoring = createScoring(ctx);
      killstreaks = createKillstreaks(ctx, api);
      objectives = createObjectives(ctx, api);
      objectives.setHeadless(headless || ctx.settings?.tier === 'low');
      killstreaks.setQuality(headless || ctx.settings?.tier === 'low' ? 0.4 : 1, headless);

      ensureLocal();
      local.loadout = loadouts.active;
      loadouts.commit();

      const on = (name, fn) => {
        const u = ctx.bus?.on?.(name, fn);
        if (u) unsubs.push(u);
      };
      on('entity:damage', onEntityDamage);
      on('entity:death', onEntityDeath);
      on('weapon:fire', onWeaponFire);
      on('ai:fire', (e) => {
        const r = recordFor(e?.bot);
        if (r) r.lastFireTime = now();
      });
      on('debug:pose', onPose);
      on('debug:cameraLock', (e) => {
        cameraLocked = !!e?.locked;
      });
      on('level:ready', () => {
        levelReady = true;
      });
      on('ai:ready', () => {
        aiReady = true;
        adoptBots();
      });
      on('quality:changed', () => {
        killstreaks?.setQuality?.(ctx.settings?.tier === 'low' ? 0.4 : 1, headless);
      });

      levelReady = !!ctx.level?.spawnPoints?.length;
      aiReady = !!ctx.ai?.ready;
      if (aiReady) adoptBots();

      setMode(ctx.settings?.get?.('gameMode') || 'tdm');
      scoring.reset(mode);
      loadouts.applyToWeapons({ instant: true });
      applyPerksToPlayer();
      emitHealth();
      killstreaks.emitHud(local);
      loadouts.emitEquipment();
      ctx.bus?.emit?.('hud:objective', objectives.hudPayload());

      api.ready = true;
      ctx.bus?.emit?.('game:ready', { mode: mode.id, roster: roster.length });
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
      objectives?.dispose?.();
      killstreaks?.dispose?.();
      roster.length = 0;
      byEntity.clear();
      api.ready = false;
      if (ctx.game === api) ctx.game = null;
    },
  };
}

export { LONGSHOT_RANGE, LETHALS, TACTICALS };
