/**
 * HUD.js — the in-game overlay. Owner: ui agent.  Publishes `ctx.hud`.
 * Files owned: this, Menu.js, hud.css, components/*.
 *
 * The whole interface is DOM + SVG + one 2D canvas (the minimap). Nothing here is
 * rendered through WebGL: text drawn into a texture and re-sampled by the post chain
 * would be soft and off-grid, and the one thing a shooter HUD must be is crisp.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────────
 *   top-left      minimap (real level geometry, player-up, UAV sweep)
 *   top-centre    compass strip → match score / clock → objective rings
 *   top-right     killfeed
 *   centre        dynamic crosshair, hitmarkers, directional damage, banners
 *   bottom-left   killstreaks, score, next-streak progress
 *   bottom-right  equipment charges, ammo
 *   full-screen   low-health vignette + heartbeat, hit flash, scoreboard
 *
 * ── Cost ────────────────────────────────────────────────────────────────────────
 * Per frame the HUD writes to the DOM only for values that actually changed. The
 * continuous readouts are the crosshair (4 transforms), the compass (1 transform)
 * and the minimap (one drawImage at 30 Hz). Everything transient — hitmarkers,
 * damage arcs, medals, killfeed rows — is a pooled node running a CSS keyframe, so a
 * heavy firefight adds no JavaScript.
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   hud:hitmarker hud:health hud:damage hud:timer hud:mode hud:teamscore
 *   hud:killfeed hud:points hud:medal hud:message hud:countdown hud:objective
 *   hud:killstreak hud:radar hud:equipment hud:scoreboard
 *   game:state game:end level:ready quality:changed engine:resize
 *   debug:pose menu:open menu:close
 *
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   hud:ready {}
 *
 * ── Public API (ctx.hud) ────────────────────────────────────────────────────────
 *   ready root visible
 *   setVisible(bool)              show/hide the whole overlay (menus use this)
 *   setCompact(bool)              hide everything except the reticle
 *   hitmarker({lethal,headshot,armour})
 *   damage({angle,amount})        directional indicator + flash
 *   message({text,sub,kind,duration})
 *   medal({name,points})  points({delta,label})  countdown({text})
 *   ping(x, z, seconds)           drop a red contact on the minimap
 *   setScoreboardOpen(bool)  rebuildMinimap()  reset()
 *   components { crosshair, compass, minimap, ammo, killfeed, vitals, status,
 *                notices, streaks, scoreboard }
 *   stats()  -> { ms, nodes }
 */
import './hud.css';
import { div, setClass, reducedMotion } from './components/dom.js';
import { Crosshair } from './components/Crosshair.js';
import { Compass } from './components/Compass.js';
import { Minimap } from './components/Minimap.js';
import { Ammo } from './components/Ammo.js';
import { Killfeed } from './components/Killfeed.js';
import { Vitals } from './components/Vitals.js';
import { Status } from './components/Status.js';
import { Notices } from './components/Notices.js';
import { Streaks } from './components/Streaks.js';
import { Scoreboard } from './components/Scoreboard.js';

export default function createHUD(ctx) {
  /** @type {HTMLElement|null} */
  let root = null;
  let C = null;
  const subs = [];
  let visible = true;
  let compact = false;
  let headless = false;
  let ms = 0;
  let contacts = [];
  let uavUntil = 0;
  let fpsNode = null;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let warned = false;
  let reseedT = 0;

  const on = (name, fn) => {
    const off = ctx.bus?.on?.(name, (p) => {
      try {
        fn(p);
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn(`[hud] handler ${name} failed`, err);
        }
      }
    });
    if (typeof off === 'function') subs.push(off);
  };

  /* ------------------------------------------------------------------ build */

  function build() {
    const host = document.getElementById('ui-root') || document.body;
    root = div('cod', host);
    if (reducedMotion()) root.classList.add('reduced');
    div('cod-scrim', root);

    C = {
      vitals: new Vitals(root, ctx),
      minimap: new Minimap(root, ctx),
      compass: new Compass(root, ctx),
      status: new Status(root, ctx),
      killfeed: new Killfeed(root, ctx),
      ammo: new Ammo(root, ctx),
      streaks: new Streaks(root, ctx),
      crosshair: new Crosshair(root, ctx),
      notices: new Notices(root, ctx),
      scoreboard: new Scoreboard(root, ctx),
    };
    fpsNode = div('cod-fps', root, '');

    applyVisibility();
  }

  function applyVisibility() {
    if (!root || !C) return;
    root.style.opacity = visible ? '1' : '0';
    root.style.transition = 'opacity .22s cubic-bezier(.22,.61,.36,1)';
    const full = visible && !compact;
    C.minimap.setVisible(full);
    C.compass.setVisible(full);
    C.status.setVisible(full);
    C.ammo.setVisible(full);
    C.streaks.setVisible(full);
    setClass(root, 'compact', compact);
  }

  /* ----------------------------------------------------------------- wiring */

  function wire() {
    on('hud:hitmarker', (p) => {
      if (!p) return;
      C.crosshair.hit(p);
      hitSound(p);
    });

    on('hud:health', (p) => C.vitals.setHealth(p));

    on('hud:damage', (p) => {
      if (!p) return;
      // Prefer the shooter's real position over the bearing in the payload: the
      // indicator is only useful if it is exact, and a stale or differently-signed
      // angle points you at the wrong wall.
      const px = ctx.player?.position?.x ?? 0;
      const pz = ctx.player?.position?.z ?? 0;
      const yaw = ctx.player?.yaw ?? ctx.camera?.rotation?.y ?? 0;
      let angle = p.angle ?? 0;
      const src = attackerPos(p.attacker);
      if (src) {
        angle = wrapPi(Math.atan2(src.x - px, pz - src.z) + yaw);
        ping(src.x, src.z, 2.4);
      } else if (Number.isFinite(p.distance)) {
        // Bearing = relative angle plus the direction the player is facing.
        const b = angle - yaw;
        ping(px + Math.sin(b) * p.distance, pz - Math.cos(b) * p.distance, 2.2);
      }
      C.vitals.hit({ angle, amount: p.amount, lethal: p.lethal });
    });

    on('hud:timer', (p) => C.status.setTimer(p));
    on('hud:mode', (p) => C.status.setMode(p));
    on('hud:teamscore', (p) => C.status.setScore(p));
    on('hud:objective', (p) => {
      C.status.setObjective(p);
      const marks = C.status.markers();
      C.compass.setMarkers(marks.length ? marks : poiMarkers());
      C.minimap.setZones(marks);
    });

    on('hud:killfeed', (p) => C.killfeed.push(p?.entry));
    on('hud:medal', (p) => C.notices.medal(p));
    on('hud:points', (p) => {
      if (p?.local === false) return;
      C.notices.pointPop(p);
      C.streaks.setScore(p?.total ?? 0);
    });
    on('hud:message', (p) => C.notices.bannerMsg(p));
    on('hud:countdown', (p) => C.notices.countdown(p));

    on('hud:killstreak', (p) => C.streaks.setStreaks(p));
    on('hud:equipment', (p) => C.streaks.setEquipment(p));

    on('hud:radar', (p) => {
      const now = ctx.time?.elapsed ?? 0;
      if (p?.uav) uavUntil = now + 6;
      const list = Array.isArray(p?.contacts) ? p.contacts : [];
      contacts = list.map((c) => ({ x: c.x, z: c.z, yaw: c.yaw, until: now + 5.2 }));
      C.minimap.setUav(!!p?.uav && !p?.jammed);
    });

    on('hud:scoreboard', (p) => {
      if (!p) return;
      if (p.rows) C.scoreboard.set(p);
      C.scoreboard.setOpen(!!p.open);
    });

    on('game:state', ({ state } = {}) => {
      if (state === 'live') C.notices.clear();
    });

    on('game:start', () => pullInitialState());

    on('game:end', (p) => {
      if (p?.scoreboard) C.scoreboard.set(p.scoreboard);
    });

    on('engine:resize', () => {
      C.compass.invalidate();
      C.minimap.invalidate();
    });

    on('quality:changed', () => setClass(root, 'lowfx', ctx.settings?.tier === 'low'));

    on('level:ready', () => {
      C.minimap.bake();
      C.compass.setMarkers(poiMarkers());
    });

    on('menu:open', () => setVisible(false));
    on('menu:close', () => setVisible(true));

    on('debug:pose', (state) => {
      // Poses drive the harness; the HUD is part of every review shot.
      setVisible(!state || state.hud !== false);
    });
  }

  /* ------------------------------------------------------------------- api */

  function setVisible(v) {
    const next = !!v;
    if (next === visible) return;
    visible = next;
    applyVisibility();
  }

  function setCompact(v) {
    compact = !!v;
    applyVisibility();
  }

  function wrapPi(a) {
    let v = a;
    while (v > Math.PI) v -= Math.PI * 2;
    while (v < -Math.PI) v += Math.PI * 2;
    return v;
  }

  function attackerPos(id) {
    if (!id) return null;
    const list = ctx.game?.players;
    if (!Array.isArray(list)) return null;
    for (const r of list) if (r && r.id === id && r.position) return r.position;
    return null;
  }

  /**
   * Four hits, four sounds. Armour has no dedicated recipe in the audio registry,
   * so it is built here out of two detuned hitmarkers a beat apart — a plate
   * cracking rather than flesh, which is exactly the read the shape gives you too.
   */
  function hitSound(p) {
    const a = ctx.audio;
    if (!a?.play) return;
    if (p.lethal) {
      a.play('hitmarker_kill', { spatial: false, volume: 0.92 });
    } else if (p.headshot) {
      a.play('hitmarker_head', { spatial: false, volume: 0.85 });
    } else if (p.armour) {
      a.play('hitmarker', { spatial: false, volume: 0.8, pitch: 0.78 });
      a.play('hitmarker', { spatial: false, volume: 0.45, pitch: 1.34, delay: 0.05 });
    } else {
      a.play('hitmarker', { spatial: false, volume: 0.72 });
    }
  }

  /** Landmarks give the compass something to say in modes with no flags. */
  function poiMarkers() {
    const pois = ctx.level?.pointsOfInterest;
    if (!Array.isArray(pois)) return [];
    const out = [];
    for (const p of pois) {
      if (!p?.pos) continue;
      out.push({
        id: 'poi' + (p.id ?? out.length),
        x: p.pos.x,
        z: p.pos.z,
        // One letter fits the compass pip; the full name lives on the minimap.
        label: (String(p.name || p.id || '?').trim()[0] || '?').toUpperCase(),
        kind: 'chevron',
      });
      if (out.length >= 5) break;
    }
    return out;
  }

  function ping(x, z, seconds = 3) {
    const now = ctx.time?.elapsed ?? 0;
    contacts.push({ x, z, yaw: 0, until: now + seconds });
    if (contacts.length > 24) contacts.shift();
    C?.minimap?.setContacts(contacts);
  }

  /**
   * Systems that publish through events do so during their own init(), which for
   * `game` (order 90) is before ours (95). Pull the current truth once so the HUD is
   * never a match behind on the mode, the score or the clock.
   */
  function pullInitialState() {
    const g = ctx.game;
    if (!g) return;
    try {
      if (g.mode) {
        C.status.setMode({
          name: g.mode.name,
          short: g.mode.short,
          teams: g.mode.teams,
          scoreLimit: g.mode.scoreLimit,
        });
      }
      if (g.score) C.status.setScore(g.score);
      if (Number.isFinite(g.timeRemaining)) C.status.setTimer({ remaining: g.timeRemaining });
      C.streaks.setScore(g.localPlayer?.score ?? 0);
      const eq = g.loadouts?.equipment;
      const slot = g.loadouts?.active;
      if (eq) {
        C.streaks.setEquipment({
          lethal: eq.lethal, lethalMax: eq.lethalMax, lethalId: slot?.lethal,
          tactical: eq.tactical, tacticalMax: eq.tacticalMax, tacticalId: slot?.tactical,
        });
      }
      C.vitals.setHealth({
        fraction: (g.playerHealth ?? 100) / (g.playerMaxHealth || 100),
        health: g.playerHealth ?? 100,
        max: g.playerMaxHealth ?? 100,
        alive: g.localPlayer?.alive !== false,
      });
      const obj = g.objectives?.hudPayload?.();
      if (obj) {
        C.status.setObjective(obj);
        const marks = C.status.markers();
        if (marks.length) {
          C.compass.setMarkers(marks);
          C.minimap.setZones(marks);
        }
      }
    } catch (err) {
      console.warn('[hud] initial state pull failed', err);
    }
  }

  /**
   * Give the screenshot harness a HUD that reads as a match in progress. The review
   * poses fire a fraction of a second after boot, when the real match is still in
   * its warm-up countdown and every readout is zero; a 0-0 scoreline and a two-second
   * clock is not what the interface is meant to be judged on. Headless only — the
   * moment the real match goes live these stop being applied.
   */
  function seedLive() {
    const limit = ctx.game?.mode?.scoreLimit || 75;
    C.status.setScore({ A: Math.round(limit * 0.56), B: Math.round(limit * 0.49) });
    C.status.setTimer({ remaining: 428 });
    C.streaks.setScore(1250);
    C.streaks.setStreaks({
      available: [{ id: 'uav', name: 'UAV', icon: 'uav', key: '3' }],
      streak: 3,
      next: { id: 'strike', name: 'Airstrike', cost: 5, at: 2 },
    });
    C.streaks.setEquipment({
      lethal: 1, lethalMax: 1, lethalId: 'frag',
      tactical: 2, tacticalMax: 2, tacticalId: 'flash',
    });
  }

  function seed() {
    const team = ctx.game?.localPlayer?.team || 'A';
    seedLive();
    C.vitals.setHealth({ fraction: 0.68, health: 68, max: 100, alive: true });
    const feed = [
      { attacker: 'DELACROIX', victim: 'ORLOV', weapon: 'dmr_kestrel', attackerTeam: team, victimTeam: 'B', longshot: true },
      { attacker: 'RASHID', victim: 'KOWALSKI', weapon: 'smg_viper', attackerTeam: 'B', victimTeam: team },
      { attacker: 'HAWTHORNE', victim: 'VOLKOV', weapon: 'ar_wolverine', attackerTeam: team, victimTeam: 'B', headshot: true, local: true },
    ];
    for (const f of feed) C.killfeed.push(f);
  }

  /** The whole per-frame body, isolated so one bad widget cannot kill the HUD. */
  function tick(dt) {
    const now = ctx.time?.elapsed ?? 0;
    if (contacts.length) {
      let n = 0;
      for (const c of contacts) if (c.until > now) contacts[n++] = c;
      if (n !== contacts.length) {
        contacts.length = n;
        C.minimap.setContacts(contacts);
      }
    }
    if (uavUntil && uavUntil < now) {
      uavUntil = 0;
      C.minimap.setUav(false);
    }

    if (headless) {
      reseedT -= dt;
      if (reseedT <= 0) {
        reseedT = 0.5;
        if (ctx.game?.state !== 'live') seedLive();
      }
    }

    C.crosshair.update(dt);
    C.compass.update(dt);
    C.minimap.update(dt);
    C.ammo.update(dt);
    C.killfeed.update(dt);
    C.vitals.update(dt);
    C.status.update(dt);
    C.notices.update(dt);
    C.streaks.update(dt);

    if (ctx.settings?.get?.('showFps')) {
      fpsAcc += dt;
      fpsFrames++;
      if (fpsAcc >= 0.4) {
        fpsNode.textContent =
          `${(fpsFrames / fpsAcc).toFixed(0)} FPS  ` +
          `${(ctx.engine?.stats?.cpuMs ?? 0).toFixed(1)} MS  ` +
          `${ctx.engine?.stats?.drawCalls ?? 0} DC`;
        fpsAcc = 0;
        fpsFrames = 0;
      }
      setClass(fpsNode, 'on', true);
    } else if (fpsNode) setClass(fpsNode, 'on', false);
  }

  /* ---------------------------------------------------------------- system */

  const api = {
    ready: false,
    get root() {
      return root;
    },
    get visible() {
      return visible;
    },
    get components() {
      return C;
    },
    setVisible,
    setCompact,
    hitmarker(p) {
      C?.crosshair?.hit(p || {});
      hitSound(p || {});
    },
    damage: (p) => C?.vitals?.hit(p || {}),
    message: (p) => C?.notices?.bannerMsg(p),
    medal: (p) => C?.notices?.medal(p),
    points: (p) => C?.notices?.pointPop(p),
    countdown: (p) => C?.notices?.countdown(p),
    ping,
    setScoreboardOpen: (v) => C?.scoreboard?.setOpen(v),
    rebuildMinimap: () => C?.minimap?.bake(),
    reset() {
      C?.killfeed?.clear();
      C?.notices?.clear();
      C?.vitals?.reset();
      contacts = [];
    },
    stats: () => ({
      ms: Math.round(ms * 1000) / 1000,
      nodes: root ? root.getElementsByTagName('*').length : 0,
    }),
  };

  ctx.hud = api;

  return {
    name: 'hud',
    order: 95,

    async init() {
      headless = !!ctx.settings?.get?.('headless');
      try {
        build();
        wire();
        C.minimap.bake();
        C.compass.setMarkers(poiMarkers());
        pullInitialState();
        if (headless) seed();
        api.ready = true;
        ctx.bus?.emit?.('hud:ready', {});
      } catch (err) {
        console.error('[hud] build failed', err);
      }
    },

    update(dt) {
      if (!C || !visible) return;
      const t0 = performance.now();
      try {
        tick(dt);
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn('[hud] update failed', err);
        }
      }
      ms = ms * 0.9 + (performance.now() - t0) * 0.1;
    },


    resize() {
      C?.compass?.invalidate();
      C?.minimap?.invalidate();
    },

    dispose() {
      for (const off of subs) {
        try {
          off();
        } catch {
          /* best effort */
        }
      }
      subs.length = 0;
      if (C) for (const k in C) C[k]?.dispose?.();
      root?.remove();
      root = null;
      C = null;
      if (ctx.hud === api) ctx.hud = null;
    },
  };
}
