/**
 * Scoring.js — points, medals, killfeed, personal bests, scoreboard. Owner: game agent.
 * Part of the rules layer published as `ctx.game` (see GameMode.js).
 *
 * Everything that turns an event into a number lives here so the modes only have to
 * say *what happened*, never *what it is worth*.
 *
 * ── Public API (createScoring(ctx) -> Scoring) ──────────────────────────────────
 *   reset(mode)                              new match
 *   registerKill(info)   -> KillResult       the whole kill pipeline in one call
 *   award(player, reason, opts)  -> number   points to one player (+ team score)
 *   teamAward(team, delta, reason)           objective points straight to a team
 *   addTeamScore(team, delta, reason)        alias used by Objectives
 *   killfeed                                 ring buffer, newest last
 *   feed(entry)                              push a bespoke killfeed line
 *   teamScore(team) / teams                  {A, B}
 *   scoreboard(players, opts) -> Scoreboard  sorted rows + team totals + summary
 *   best / personalBests                     session personal bests
 *   stats                                    match totals
 *   MULTIKILL_WINDOW / SCORE / MEDALS
 *
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   game:score      {team, delta, reason, total}                       (§3)
 *   hud:hitmarker   {lethal, headshot, armour, damage}                 (§3)
 *   hud:killfeed    {entry, entries}
 *   hud:medal       {id, name, points, streak}
 *   hud:points      {delta, reason, total, player}
 *   hud:teamscore   {A, B, limit}
 *   game:personalbest {kind, value, previous}
 */

/* ───────────────────────────────────────────────────────────── score values ── */

/** Score events. `points` is personal score; `team` is what the team scoreboard gets. */
export const SCORE = {
  kill: { points: 100, team: 1, label: 'Kill' },
  assist: { points: 50, team: 0, label: 'Assist' },
  headshot: { points: 50, team: 0, label: 'Headshot' },
  longshot: { points: 50, team: 0, label: 'Longshot' },
  wallbang: { points: 50, team: 0, label: 'Penetration Kill' },
  collateral: { points: 100, team: 0, label: 'Collateral' },
  melee: { points: 50, team: 0, label: 'Point Blank' },
  explosive: { points: 25, team: 0, label: 'Demolition' },
  revenge: { points: 50, team: 0, label: 'Revenge' },
  payback: { points: 50, team: 0, label: 'Payback' },
  firstblood: { points: 100, team: 0, label: 'First Blood' },
  comeback: { points: 50, team: 0, label: 'Comeback' },
  buzzkill: { points: 50, team: 0, label: 'Buzzkill' },
  killstreak: { points: 25, team: 0, label: 'Streak' },
  revive: { points: 100, team: 0, label: 'Revive' },
  /* objective */
  capture: { points: 200, team: 0, label: 'Capture' },
  capture_assist: { points: 100, team: 0, label: 'Capture Assist' },
  defend: { points: 100, team: 0, label: 'Defend' },
  neutralise: { points: 100, team: 0, label: 'Neutralised' },
  hold: { points: 5, team: 0, label: 'Holding' },
  plant: { points: 250, team: 0, label: 'Bomb Planted' },
  defuse: { points: 250, team: 0, label: 'Bomb Defused' },
  objective_kill: { points: 50, team: 0, label: 'Objective Kill' },
  streak_kill: { points: 50, team: 0, label: 'Killstreak Kill' },
  /* penalties */
  teamkill: { points: -100, team: 0, label: 'Team Kill' },
  suicide: { points: -50, team: 0, label: 'Suicide' },
};

/** Multikill names, index = kills within the window (2 -> Double Kill). */
export const MULTIKILLS = [
  null,
  null,
  { id: 'double', name: 'Double Kill', points: 50 },
  { id: 'triple', name: 'Triple Kill', points: 100 },
  { id: 'quad', name: 'Fury Kill', points: 200 },
  { id: 'penta', name: 'Frenzy Kill', points: 300 },
  { id: 'hexa', name: 'Superior Kill', points: 400 },
];

/** Streak medals at n kills without dying. */
export const MEDALS = {
  3: { id: 'bloodthirsty', name: 'Bloodthirsty', points: 50 },
  5: { id: 'merciless', name: 'Merciless', points: 100 },
  7: { id: 'ruthless', name: 'Ruthless', points: 150 },
  10: { id: 'relentless', name: 'Relentless', points: 200 },
  15: { id: 'nuclear', name: 'Unstoppable', points: 400 },
  20: { id: 'godlike', name: 'Godlike', points: 600 },
};

export const MULTIKILL_WINDOW = 4.0;
/** Metres beyond which a rifle kill counts as a longshot. */
export const LONGSHOT_RANGE = 42;
const FEED_MAX = 24;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ───────────────────────────────────────────────────────────────── factory ── */

export function createScoring(ctx) {
  const teams = { A: 0, B: 0 };
  const killfeed = [];
  const best = {
    streak: 0,
    kills: 0,
    score: 0,
    kdr: 0,
    longestShot: 0,
    multikill: 0,
    accuracy: 0,
  };
  const stats = {
    kills: 0,
    deaths: 0,
    assists: 0,
    headshots: 0,
    longshots: 0,
    wallbangs: 0,
    multikills: 0,
    shotsFired: 0,
    shotsHit: 0,
    objectives: 0,
    matchStart: 0,
  };
  let scoreLimit = 0;
  let modeName = '';
  let firstBloodTaken = false;
  /** Free-for-all has no team scoreboard — the per-player kill count is the score. */
  let teamsEnabled = true;
  /** What one kill is worth on the team scoreboard (0 in objective modes). */
  let killTeamValue = 1;

  const now = () => ctx.time?.elapsed ?? 0;

  /* ── personal bests, best-effort persisted ──────────────────────────────── */

  const STORE_KEY = 'cod.personalBests.v1';
  function loadBests() {
    try {
      const raw = globalThis.localStorage?.getItem?.(STORE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const k of Object.keys(best)) {
        if (typeof parsed?.[k] === 'number' && Number.isFinite(parsed[k])) best[k] = parsed[k];
      }
    } catch {
      /* private mode / no storage — bests are just session-local then */
    }
  }
  function saveBests() {
    try {
      globalThis.localStorage?.setItem?.(STORE_KEY, JSON.stringify(best));
    } catch {
      /* best effort */
    }
  }
  function noteBest(kind, value) {
    if (!Number.isFinite(value)) return false;
    const prev = best[kind] ?? 0;
    if (value <= prev) return false;
    best[kind] = value;
    saveBests();
    ctx.bus?.emit?.('game:personalbest', { kind, value, previous: prev });
    return true;
  }
  loadBests();

  /* ── killfeed ───────────────────────────────────────────────────────────── */

  function feed(entry) {
    const e = {
      t: now(),
      attacker: entry.attacker ?? '',
      attackerTeam: entry.attackerTeam ?? null,
      victim: entry.victim ?? '',
      victimTeam: entry.victimTeam ?? null,
      weapon: entry.weapon ?? '',
      weaponName: entry.weaponName ?? '',
      headshot: !!entry.headshot,
      wallbang: !!entry.wallbang,
      longshot: !!entry.longshot,
      explosive: !!entry.explosive,
      melee: !!entry.melee,
      streak: entry.streak || null,
      local: !!entry.local,
      kind: entry.kind || 'kill',
    };
    killfeed.push(e);
    while (killfeed.length > FEED_MAX) killfeed.shift();
    ctx.bus?.emit?.('hud:killfeed', { entry: e, entries: killfeed });
    return e;
  }

  /* ── awards ─────────────────────────────────────────────────────────────── */

  function emitTeamScore() {
    ctx.bus?.emit?.('hud:teamscore', { A: teams.A, B: teams.B, limit: scoreLimit, mode: modeName });
  }

  function teamAward(team, delta, reason) {
    if (!team || !delta || !teamsEnabled) return teams[team] ?? 0;
    if (teams[team] === undefined) teams[team] = 0;
    teams[team] += delta;
    ctx.bus?.emit?.('game:score', { team, delta, reason: reason || 'objective', total: teams[team] });
    emitTeamScore();
    return teams[team];
  }

  /**
   * Give one player points for `reason`. Also credits the team when the score event
   * carries a team value (kills in TDM) or `opts.team` is set explicitly.
   */
  function award(player, reason, opts = {}) {
    const def = SCORE[reason] || { points: opts.points || 0, team: 0, label: opts.label || reason };
    const pts = Math.round((opts.points ?? def.points) * (opts.scale ?? 1));
    if (!player) {
      if (opts.team && def.team) teamAward(opts.team, opts.teamDelta ?? def.team, reason);
      return pts;
    }
    player.score = (player.score || 0) + pts;
    player.matchScore = (player.matchScore || 0) + pts;
    if (pts !== 0) {
      ctx.bus?.emit?.('hud:points', {
        delta: pts,
        reason,
        label: opts.label || def.label,
        total: player.score,
        player: player.id,
        local: !!player.isLocal,
      });
    }
    const teamDelta = opts.teamDelta ?? (opts.creditTeam === false ? 0 : def.team);
    if (teamDelta && player.team) teamAward(player.team, teamDelta, reason);
    if (player.isLocal) noteBest('score', player.score);
    return pts;
  }

  /* ── the kill pipeline ──────────────────────────────────────────────────── */

  /**
   * @param {{attacker, victim, weapon, weaponName, headshot, distance, wallbang,
   *          explosive, melee, streak, assists, objective, teamkill, suicide,
   *          friendlyFire}} info
   * @returns {{points:number, medals:Array, multikill:object|null, streak:number}}
   */
  function registerKill(info = {}) {
    const a = info.attacker || null;
    const v = info.victim || null;
    const t = now();
    const medals = [];
    let points = 0;
    let multikill = null;

    if (v) {
      v.deaths = (v.deaths || 0) + 1;
      v.streak = 0;
      v.lastDeathTime = t;
      v.lastKilledBy = a || null;
      if (v.isLocal) stats.deaths++;
    }

    /* Suicide / team kill: no reward, a penalty, and the feed still shows it. */
    if (info.suicide || (a && v && a === v)) {
      if (v) award(v, 'suicide', { teamDelta: 0 });
      feed({
        attacker: '',
        victim: v?.name,
        victimTeam: v?.team,
        weapon: info.weapon,
        weaponName: info.weaponName,
        kind: 'suicide',
        local: !!v?.isLocal,
      });
      return { points: 0, medals, multikill, streak: 0 };
    }
    if (info.teamkill && a) {
      award(a, 'teamkill', { teamDelta: 0 });
      feed({
        attacker: a.name,
        attackerTeam: a.team,
        victim: v?.name,
        victimTeam: v?.team,
        weapon: info.weapon,
        weaponName: info.weaponName,
        kind: 'teamkill',
        local: !!a.isLocal || !!v?.isLocal,
      });
      return { points: 0, medals, multikill, streak: a.streak || 0 };
    }

    if (a) {
      a.kills = (a.kills || 0) + 1;
      a.streak = (a.streak || 0) + 1;
      a.bestStreak = Math.max(a.bestStreak || 0, a.streak);
      points += award(a, 'kill', { teamDelta: killTeamValue });

      /* Bonus conditions */
      if (info.headshot) {
        a.headshots = (a.headshots || 0) + 1;
        points += award(a, 'headshot');
        medals.push('headshot');
      }
      if (Number.isFinite(info.distance) && info.distance >= LONGSHOT_RANGE && !info.explosive) {
        a.longshots = (a.longshots || 0) + 1;
        points += award(a, 'longshot');
        medals.push('longshot');
        if (a.isLocal) noteBest('longestShot', Math.round(info.distance));
      } else if (a.isLocal && Number.isFinite(info.distance)) {
        noteBest('longestShot', Math.round(info.distance));
      }
      if (info.wallbang) {
        a.wallbangs = (a.wallbangs || 0) + 1;
        points += award(a, 'wallbang');
        medals.push('wallbang');
      }
      if (info.melee) points += award(a, 'melee');
      if (info.explosive) points += award(a, 'explosive');
      if (info.streak) points += award(a, 'streak_kill');
      if (info.objective) {
        points += award(a, 'objective_kill');
        stats.objectives++;
      }
      if (!firstBloodTaken) {
        firstBloodTaken = true;
        points += award(a, 'firstblood');
        medals.push('firstblood');
        ctx.bus?.emit?.('hud:medal', { id: 'firstblood', name: 'First Blood', points: SCORE.firstblood.points, local: !!a.isLocal });
      }
      if (v && a.lastKilledBy === v) {
        points += award(a, 'revenge');
        medals.push('revenge');
        a.lastKilledBy = null;
      }
      if (v && (v.streak || 0) === 0 && (v.bestStreak || 0) >= 5 && t - (v.lastStreakEnd || -99) < 0.2) {
        points += award(a, 'buzzkill');
      }

      /* Multikill window */
      if (t - (a.lastKillTime ?? -99) <= MULTIKILL_WINDOW) a.multikillCount = (a.multikillCount || 1) + 1;
      else a.multikillCount = 1;
      a.lastKillTime = t;
      const mk = MULTIKILLS[Math.min(a.multikillCount, MULTIKILLS.length - 1)];
      if (mk) {
        multikill = mk;
        points += award(a, 'multikill', { points: mk.points, label: mk.name, teamDelta: 0 });
        ctx.bus?.emit?.('hud:medal', { id: mk.id, name: mk.name, points: mk.points, local: !!a.isLocal, count: a.multikillCount });
        if (a.isLocal) {
          stats.multikills++;
          noteBest('multikill', a.multikillCount);
        }
      }

      /* Streak medals */
      const medal = MEDALS[a.streak];
      if (medal) {
        medals.push(medal.id);
        points += award(a, 'killstreak', { points: medal.points, label: medal.name, teamDelta: 0 });
        ctx.bus?.emit?.('hud:medal', { id: medal.id, name: medal.name, points: medal.points, local: !!a.isLocal, streak: a.streak });
      }

      if (a.isLocal) {
        stats.kills++;
        if (info.headshot) stats.headshots++;
        if (info.wallbang) stats.wallbangs++;
        if (Number.isFinite(info.distance) && info.distance >= LONGSHOT_RANGE) stats.longshots++;
        noteBest('streak', a.streak);
        noteBest('kills', a.kills);
      }
    }

    /* Assists */
    const assists = info.assists || [];
    for (const p of assists) {
      if (!p || p === a) continue;
      p.assists = (p.assists || 0) + 1;
      award(p, 'assist', { teamDelta: 0 });
      if (p.isLocal) stats.assists++;
    }

    if (v && (v.bestStreak || 0) > 0) v.lastStreakEnd = t;

    feed({
      attacker: a?.name,
      attackerTeam: a?.team,
      victim: v?.name,
      victimTeam: v?.team,
      weapon: info.weapon,
      weaponName: info.weaponName,
      headshot: info.headshot,
      wallbang: info.wallbang,
      longshot: Number.isFinite(info.distance) && info.distance >= LONGSHOT_RANGE,
      explosive: info.explosive,
      melee: info.melee,
      streak: info.streak || null,
      local: !!a?.isLocal || !!v?.isLocal,
    });

    return { points, medals, multikill, streak: a?.streak || 0 };
  }

  /* ── hitmarkers ─────────────────────────────────────────────────────────── */

  function hitmarker(opts = {}) {
    ctx.bus?.emit?.('hud:hitmarker', {
      lethal: !!opts.lethal,
      headshot: !!opts.headshot,
      armour: !!opts.armour,
      damage: opts.damage || 0,
      friendly: !!opts.friendly,
    });
  }

  /* ── scoreboard ─────────────────────────────────────────────────────────── */

  function scoreboard(players = [], opts = {}) {
    const rows = players
      .map((p) => {
        const kdr = p.deaths > 0 ? p.kills / p.deaths : p.kills;
        return {
          id: p.id,
          name: p.name,
          team: p.team,
          isLocal: !!p.isLocal,
          isBot: !!p.isBot,
          alive: !!p.alive,
          score: Math.round(p.score || 0),
          kills: p.kills || 0,
          deaths: p.deaths || 0,
          assists: p.assists || 0,
          kdr: Math.round(kdr * 100) / 100,
          streak: p.streak || 0,
          bestStreak: p.bestStreak || 0,
          headshots: p.headshots || 0,
          captures: p.captures || 0,
          defends: p.defends || 0,
          plants: p.plants || 0,
          defuses: p.defuses || 0,
          damage: Math.round(p.damageDealt || 0),
          ping: p.ping || 0,
          loadout: p.loadout?.name || '',
        };
      })
      .sort((x, y) => y.score - x.score || y.kills - x.kills || x.deaths - y.deaths);

    const teamRows = { A: [], B: [] };
    for (const r of rows) (teamRows[r.team] || (teamRows[r.team] = [])).push(r);

    const local = rows.find((r) => r.isLocal) || null;
    const mvp = rows[0] || null;
    const acc = stats.shotsFired > 0 ? stats.shotsHit / stats.shotsFired : 0;
    if (local) noteBest('kdr', Math.round((local.deaths ? local.kills / local.deaths : local.kills) * 100) / 100);
    noteBest('accuracy', Math.round(acc * 1000) / 10);

    return {
      mode: modeName,
      limit: scoreLimit,
      teams: { A: teams.A, B: teams.B },
      rows,
      teamRows,
      local,
      mvp,
      winner: opts.winner ?? null,
      reason: opts.reason ?? '',
      duration: Math.round(now() - stats.matchStart),
      summary: {
        kills: stats.kills,
        deaths: stats.deaths,
        assists: stats.assists,
        headshots: stats.headshots,
        longshots: stats.longshots,
        wallbangs: stats.wallbangs,
        multikills: stats.multikills,
        objectives: stats.objectives,
        accuracy: Math.round(acc * 1000) / 10,
        bestStreak: local?.bestStreak || 0,
        score: local?.score || 0,
      },
      best: { ...best },
    };
  }

  function reset(mode) {
    teams.A = 0;
    teams.B = 0;
    killfeed.length = 0;
    firstBloodTaken = false;
    scoreLimit = mode?.scoreLimit ?? 0;
    modeName = mode?.name || mode?.id || '';
    teamsEnabled = mode ? mode.teams !== false : true;
    killTeamValue = mode?.killScore ?? (mode?.objective ? 0 : 1);
    stats.kills = 0;
    stats.deaths = 0;
    stats.assists = 0;
    stats.headshots = 0;
    stats.longshots = 0;
    stats.wallbangs = 0;
    stats.multikills = 0;
    stats.shotsFired = 0;
    stats.shotsHit = 0;
    stats.objectives = 0;
    stats.matchStart = now();
    emitTeamScore();
  }

  return {
    SCORE,
    MEDALS,
    MULTIKILLS,
    MULTIKILL_WINDOW,
    LONGSHOT_RANGE,
    killfeed,
    stats,
    best,
    get personalBests() {
      return { ...best };
    },
    get teams() {
      return teams;
    },
    teamScore: (t) => teams[t] ?? 0,
    setLimit(n) {
      scoreLimit = n || 0;
    },
    reset,
    award,
    teamAward,
    addTeamScore: teamAward,
    registerKill,
    hitmarker,
    feed,
    scoreboard,
    noteBest,
    noteShot(hit) {
      stats.shotsFired++;
      if (hit) stats.shotsHit++;
    },
    clampScore: clamp,
  };
}

export default createScoring;
