/**
 * Killstreaks.js — UAV, counter-UAV, precision airstrike, cluster strike, chopper
 * gunner. Owner: game agent. Part of the rules layer published as `ctx.game`.
 *
 * Every reward has a real effect on the simulation, not just a HUD banner:
 *   uav             sweeps the enemy roster and ships contacts on `hud:radar`; an
 *                   enemy UAV raises `sensor.detectRate` on the opposing bots so
 *                   being scanned genuinely makes them find you faster
 *   counter_uav     jams the other team's radar for its duration
 *   airstrike       a jet flies the painted line, then walks `ctx.ballistics.explode`
 *                   bomb by bomb down it with real blast damage and FX
 *   cluster_strike  a mortar sheaf: many small blasts scattered over the marked area
 *   chopper_gunner  a real gunship orbits the map, acquires enemies with line-of-sight
 *                   raycasts and puts rounds on them with tracers and impact FX
 *
 * The aircraft are built here from primitives with `ctx.materials` surfaces, rotor
 * discs, strobes and nav lights. They are 60–110 m up, so silhouette and motion do the
 * work; nothing is a flat-shaded box.
 *
 * ── Public API (createKillstreaks(ctx, game) -> Killstreaks) ────────────────────
 *   STREAKS                    catalogue
 *   reset()                    wipe earned + active on match/round start
 *   onKill(rec)                advance a player's streak, award rewards
 *   earnedFor(rec)             string[]  ready-to-use ids
 *   use(rec, id) -> bool       fire one off
 *   useNext(rec) -> bool
 *   uavActive(team) / counterUavActive(team)
 *   active                     live reward instances
 *   update(dt)
 *   dispose()
 *
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   killstreak:earned {id, name, player, streak}
 *   killstreak:used   {id, name, player, team}
 *   killstreak:ended  {id, team}
 *   hud:killstreak    {available, streak, next, team}
 *   hud:radar         {contacts, uav, jammed, sweep}
 *   hud:message       {text, sub, kind}
 */
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ─────────────────────────────────────────────────────────────── catalogue ── */

export const STREAKS = {
  uav: {
    id: 'uav',
    name: 'UAV',
    cost: 4,
    duration: 32,
    blurb: 'Reveals enemy positions on the minimap.',
    icon: 'uav',
  },
  counter_uav: {
    id: 'counter_uav',
    name: 'Counter-UAV',
    cost: 5,
    duration: 30,
    blurb: 'Jams the enemy minimap.',
    icon: 'cuav',
  },
  airstrike: {
    id: 'airstrike',
    name: 'Precision Airstrike',
    cost: 7,
    duration: 9,
    blurb: 'Paint a line — a jet walks bombs down it.',
    icon: 'strike',
    aimed: true,
  },
  cluster_strike: {
    id: 'cluster_strike',
    name: 'Cluster Strike',
    cost: 9,
    duration: 8,
    blurb: 'A mortar sheaf saturates the marked area.',
    icon: 'cluster',
    aimed: true,
  },
  chopper_gunner: {
    id: 'chopper_gunner',
    name: 'Chopper Gunner',
    cost: 12,
    duration: 42,
    blurb: 'A gunship orbits the map and engages your enemies.',
    icon: 'chopper',
  },
};

export const STREAK_ORDER = ['uav', 'counter_uav', 'airstrike', 'cluster_strike', 'chopper_gunner'];

/* ────────────────────────────────────────────────────────── aircraft build ── */

function safeMaterial(ctx, name, fallbackColor = 0x4b4f52, over = null) {
  try {
    if (over && ctx.materials?.clone) return ctx.materials.clone(name, over);
    const m = ctx.materials?.get?.(name);
    if (m) return m;
  } catch {
    /* fall through */
  }
  return new THREE.MeshStandardMaterial({ color: fallbackColor, roughness: 0.62, metalness: 0.55 });
}

/**
 * A compact attack helicopter. Built from lathed/extruded primitives so it has a
 * believable silhouette from below — which is the only angle anyone sees it from.
 */
function buildChopper(ctx, quality = 1) {
  const g = new THREE.Group();
  g.name = 'chopperGunner';
  const seg = quality > 0.5 ? 14 : 8;
  const hull = safeMaterial(ctx, 'painted_steel_chipped', 0x3c4042);
  const dark = safeMaterial(ctx, 'rusted_steel', 0x24262a);
  const glass = safeMaterial(ctx, 'glass_dirty', 0x1a2024);
  const geos = [];
  /** Only materials built here get disposed — the library's are shared. */
  const mats = [];

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.scale.set(sx, sy, sz);
    m.castShadow = false;
    m.receiveShadow = false;
    g.add(m);
    geos.push(geo);
    return m;
  };

  // Fuselage — a stretched capsule, nose down the -Z axis.
  const body = new THREE.CapsuleGeometry(0.95, 4.4, 4, seg);
  body.rotateX(Math.PI / 2);
  add(body, hull, 0, 0, 0.3, 0, 0, 0, 1, 0.86, 1);

  // Cockpit glass.
  const canopy = new THREE.SphereGeometry(0.82, seg, seg * 0.6, 0, Math.PI * 2, 0, Math.PI * 0.62);
  add(canopy, glass, 0, 0.24, -2.35, Math.PI * 0.52, 0, 0, 1.05, 1.3, 1.5);

  // Tail boom + fin.
  const boom = new THREE.CylinderGeometry(0.24, 0.42, 4.2, seg);
  boom.rotateX(Math.PI / 2);
  add(boom, hull, 0, 0.22, 4.6, 0, 0, 0);
  const fin = new THREE.BoxGeometry(0.14, 1.5, 0.9);
  add(fin, hull, 0, 0.85, 6.3, -0.18, 0, 0);
  const stab = new THREE.BoxGeometry(2.4, 0.1, 0.55);
  add(stab, hull, 0, 0.35, 6.0, 0, 0, 0);

  // Stub wings with pylons and rocket pods — the reason it reads as a gunship.
  const wing = new THREE.BoxGeometry(5.4, 0.16, 1.05);
  add(wing, hull, 0, -0.15, 0.5, 0, 0, 0.03);
  const podGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.5, seg);
  podGeo.rotateX(Math.PI / 2);
  add(podGeo, dark, -2.05, -0.42, 0.5);
  add(podGeo, dark, 2.05, -0.42, 0.5);
  const pylon = new THREE.BoxGeometry(0.12, 0.34, 0.7);
  add(pylon, dark, -2.05, -0.3, 0.5);
  add(pylon, dark, 2.05, -0.3, 0.5);

  // Chin turret.
  const turret = new THREE.SphereGeometry(0.42, seg, seg * 0.6);
  const turretMesh = add(turret, dark, 0, -0.62, -2.1, 0, 0, 0, 1, 0.8, 1.1);
  const barrel = new THREE.CylinderGeometry(0.075, 0.09, 1.25, 8);
  barrel.rotateX(Math.PI / 2);
  const barrelMesh = add(barrel, dark, 0, -0.66, -2.85);

  // Skids — grounded detail that also breaks the silhouette.
  const skid = new THREE.CylinderGeometry(0.07, 0.07, 3.4, 6);
  skid.rotateX(Math.PI / 2);
  add(skid, dark, -1.15, -1.15, 0.4);
  add(skid, dark, 1.15, -1.15, 0.4);
  const strut = new THREE.CylinderGeometry(0.055, 0.055, 1.05, 6);
  add(strut, dark, -1.05, -0.68, -0.7, 0, 0, 0.22);
  add(strut, dark, 1.05, -0.68, -0.7, 0, 0, -0.22);
  add(strut, dark, -1.05, -0.68, 1.5, 0, 0, 0.22);
  add(strut, dark, 1.05, -0.68, 1.5, 0, 0, -0.22);

  // Rotors: a hub with real blades plus a translucent disc for the blur.
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.15, 0.3);
  const hub = new THREE.CylinderGeometry(0.26, 0.32, 0.34, 8);
  const hubMesh = new THREE.Mesh(hub, dark);
  rotor.add(hubMesh);
  geos.push(hub);
  const bladeGeo = new THREE.BoxGeometry(7.6, 0.055, 0.42);
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(bladeGeo, dark);
    b.rotation.y = (i / 4) * Math.PI * 2;
    b.position.y = 0.1;
    rotor.add(b);
  }
  geos.push(bladeGeo);
  const discGeo = new THREE.CircleGeometry(7.7, quality > 0.5 ? 30 : 14);
  discGeo.rotateX(-Math.PI / 2);
  const discMat = new THREE.MeshBasicMaterial({
    color: 0x2a2c30,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  mats.push(discMat);
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.position.y = 0.12;
  rotor.add(disc);
  geos.push(discGeo);
  g.add(rotor);

  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.32, 0.85, 6.35);
  const trGeo = new THREE.BoxGeometry(0.06, 1.7, 0.2);
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(trGeo, dark);
    b.rotation.x = (i / 2) * Math.PI;
    tailRotor.add(b);
  }
  geos.push(trGeo);
  g.add(tailRotor);

  // Nav lights: port red, starboard green, belly strobe.
  const lightGeo = new THREE.SphereGeometry(0.09, 6, 5);
  const mkLight = (colour, x, y, z) => {
    const lm = new THREE.MeshBasicMaterial({ color: colour, toneMapped: false });
    mats.push(lm);
    const m = new THREE.Mesh(lightGeo, lm);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  geos.push(lightGeo);
  const lights = {
    port: mkLight(0xff2020, -2.75, -0.1, 0.5),
    starboard: mkLight(0x20ff40, 2.75, -0.1, 0.5),
    strobe: mkLight(0xffffff, 0, -0.95, 1.4),
    tail: mkLight(0xffffff, 0, 1.5, 6.4),
  };

  g.userData = { rotor, tailRotor, disc, lights, geos, mats, turret: turretMesh, barrel: barrelMesh, discMat };
  return g;
}

/** A strike jet. Only ever seen as a fast silhouette, so keep it lean. */
function buildJet(ctx, quality = 1) {
  const g = new THREE.Group();
  g.name = 'strikeJet';
  const seg = quality > 0.5 ? 12 : 7;
  const hull = safeMaterial(ctx, 'brushed_aluminium', 0x585d63);
  const dark = safeMaterial(ctx, 'rusted_steel', 0x25272b);
  const geos = [];
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.scale.set(sx, sy, sz);
    g.add(m);
    geos.push(geo);
    return m;
  };
  const body = new THREE.CapsuleGeometry(0.62, 8.5, 4, seg);
  body.rotateX(Math.PI / 2);
  add(body, hull, 0, 0, 0);
  const nose = new THREE.ConeGeometry(0.62, 2.4, seg);
  nose.rotateX(-Math.PI / 2);
  add(nose, hull, 0, 0, -5.9);
  // Delta wing.
  const wing = new THREE.BoxGeometry(9.6, 0.16, 3.0);
  add(wing, hull, 0, -0.1, 1.4, 0, 0, 0, 1, 1, 1);
  const wingTaper = new THREE.BoxGeometry(5.0, 0.14, 1.6);
  add(wingTaper, hull, 0, -0.1, -0.6);
  const tail = new THREE.BoxGeometry(0.16, 1.5, 1.5);
  add(tail, hull, -0.7, 0.65, 4.3, 0, 0, -0.24);
  add(tail, hull, 0.7, 0.65, 4.3, 0, 0, 0.24);
  const stab = new THREE.BoxGeometry(3.4, 0.12, 1.1);
  add(stab, hull, 0, 0, 4.5);
  const nozzle = new THREE.CylinderGeometry(0.52, 0.42, 0.9, seg);
  nozzle.rotateX(Math.PI / 2);
  add(nozzle, dark, 0, 0, 5.3);
  const flameGeo = new THREE.ConeGeometry(0.36, 2.6, 8, 1, true);
  flameGeo.rotateX(-Math.PI / 2);
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0x7fb4ff,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const flame = new THREE.Mesh(flameGeo, flameMat);
  flame.position.set(0, 0, 6.8);
  flame.rotation.x = Math.PI;
  g.add(flame);
  geos.push(flameGeo);
  g.userData = { geos, mats: [flameMat], flame, flameMat };
  return g;
}

/* ───────────────────────────────────────────────────────────────── factory ── */

export function createKillstreaks(ctx, game) {
  const root = new THREE.Group();
  root.name = 'killstreaks';
  let added = false;
  let quality = 1;
  let headless = false;

  /** id -> instance for the live rewards. */
  const active = [];
  /** team -> { uav: until, counter: until } */
  const teamState = { A: { uav: 0, counter: 0 }, B: { uav: 0, counter: 0 } };

  let chopper = null;
  let jet = null;

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _dir = new THREE.Vector3();

  const now = () => ctx.time?.elapsed ?? 0;

  function ensureRoot() {
    if (!added && ctx.scene) {
      ctx.scene.add(root);
      added = true;
    }
  }

  /* ── earning ────────────────────────────────────────────────────────────── */

  function ensureBag(rec) {
    if (!rec.streakBag) rec.streakBag = { earned: [], used: [], progress: 0 };
    return rec.streakBag;
  }

  /** Effective kills for streak purposes (Hardline scales the count). */
  function effectiveStreak(rec) {
    const scale = rec?.isLocal ? game?.loadouts?.mods?.streakScale ?? 1 : 1;
    return (rec?.streak || 0) * scale;
  }

  function nextStreakFor(rec) {
    const bag = ensureBag(rec);
    const s = effectiveStreak(rec);
    for (const id of STREAK_ORDER) {
      const def = STREAKS[id];
      if (bag.earned.includes(id) || bag.used.includes(id)) continue;
      if (s < def.cost) return { id, name: def.name, cost: def.cost, at: def.cost - Math.floor(s) };
    }
    return null;
  }

  function emitHud(rec) {
    if (!rec?.isLocal) return;
    const bag = ensureBag(rec);
    ctx.bus?.emit?.('hud:killstreak', {
      available: bag.earned.map((id, i) => ({
        id,
        name: STREAKS[id]?.name || id,
        icon: STREAKS[id]?.icon || id,
        key: `${3 + i}`,
        slot: i,
      })),
      streak: rec.streak || 0,
      next: nextStreakFor(rec),
      team: rec.team,
      uav: uavActive(rec.team),
      jammed: counterUavActive(rec.team === 'A' ? 'B' : 'A'),
    });
  }

  /** Hand over anything the current streak has paid for and there is room to hold. */
  function grant(rec) {
    if (!rec) return;
    const bag = ensureBag(rec);
    const s = effectiveStreak(rec);
    for (const id of STREAK_ORDER) {
      const def = STREAKS[id];
      if (s < def.cost) continue;
      if (bag.earned.includes(id) || bag.used.includes(id)) continue;
      // Three in hand, like CoD: the rest wait until a slot frees rather than being
      // silently thrown away.
      if (bag.earned.length >= 3) break;
      bag.earned.push(id);
      ctx.bus?.emit?.('killstreak:earned', { id, name: def.name, player: rec.id, local: !!rec.isLocal, streak: rec.streak });
      if (rec.isLocal) {
        ctx.bus?.emit?.('hud:message', { kind: 'killstreak', text: `${def.name.toUpperCase()} READY`, sub: `Press ${3 + bag.earned.indexOf(id)}`, duration: 3 });
        ctx.audio?.play?.('notify', { spatial: false });
      } else if ((ctx.rng?.() ?? 1) < 0.7) {
        // Bots use theirs almost immediately — that is what makes streaks feel alive.
        setTimeout1(rec, id, 1.5 + (ctx.rng?.() ?? 0.5) * 4);
      }
    }
    emitHud(rec);
  }

  /** Called by GameMode after every confirmed kill. */
  function onKill(rec) {
    grant(rec);
  }

  /** Tiny deterministic timer (no setTimeout — the sim must stay stepable). */
  const pending = [];
  function setTimeout1(rec, id, delay) {
    pending.push({ rec, id, at: now() + delay });
  }

  function onDeath(rec) {
    if (!rec) return;
    const bag = ensureBag(rec);
    // CoD keeps whatever is still in hand and resets the counter, so the same reward
    // can be earned again on the next run. Clearing `used` is what re-arms it.
    bag.used.length = 0;
    emitHud(rec);
  }

  /* ── aim point ──────────────────────────────────────────────────────────── */

  /** Where the caller is pointing, on the ground. Falls back to map centre. */
  function aimPoint(rec, out) {
    out.set(0, 0, 0);
    const cam = rec?.isLocal ? ctx.camera : null;
    if (cam) {
      _dir.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
      const hit = ctx.physics?.raycast?.(cam.position, _dir, 220, 1 | 8);
      if (hit?.point) {
        out.copy(hit.point);
        return out;
      }
      // No geometry in front: project onto the ground plane.
      const t = _dir.y < -0.02 ? (cam.position.y - (ctx.level?.groundY?.(cam.position.x, cam.position.z) ?? 0)) / -_dir.y : 60;
      out.copy(cam.position).addScaledVector(_dir, clamp(t, 8, 140));
      out.y = ctx.level?.groundY?.(out.x, out.z) ?? 0;
      return out;
    }
    // A bot calls it in on the densest enemy cluster it knows about.
    const enemies = game?.playersOfTeam?.(rec?.team === 'A' ? 'B' : 'A') || [];
    let n = 0;
    for (const e of enemies) {
      if (!e.alive || !e.position) continue;
      out.add(e.position);
      n++;
    }
    if (n) out.multiplyScalar(1 / n);
    else {
      const pois = ctx.level?.pointsOfInterest;
      const p = pois?.length ? pois[Math.floor((ctx.rng?.() ?? 0.5) * pois.length)] : null;
      if (p?.pos) out.copy(p.pos);
    }
    out.y = ctx.level?.groundY?.(out.x, out.z) ?? out.y;
    return out;
  }

  /** Heading for a line strike: the caller's facing, or toward the enemy spawn. */
  function aimHeading(rec) {
    if (rec?.isLocal && ctx.camera) {
      _dir.set(0, 0, -1).applyQuaternion(ctx.camera.getWorldQuaternion(new THREE.Quaternion()));
      _dir.y = 0;
      if (_dir.lengthSq() > 1e-4) return Math.atan2(_dir.x, _dir.z);
    }
    return (rec?.team === 'A' ? 0 : Math.PI) + ((ctx.rng?.() ?? 0.5) - 0.5) * 0.7;
  }

  /* ── the rewards ────────────────────────────────────────────────────────── */

  function startUav(rec) {
    const team = rec.team;
    teamState[team].uav = now() + STREAKS.uav.duration;
    active.push({ id: 'uav', team, owner: rec, until: teamState[team].uav, sweep: 0 });
    ctx.audio?.play?.('notify', { spatial: false });
    return true;
  }

  function startCounterUav(rec) {
    const team = rec.team;
    teamState[team].counter = now() + STREAKS.counter_uav.duration;
    active.push({ id: 'counter_uav', team, owner: rec, until: teamState[team].counter });
    return true;
  }

  function startAirstrike(rec) {
    const centre = aimPoint(rec, new THREE.Vector3());
    const heading = aimHeading(rec);
    const inst = {
      id: 'airstrike',
      team: rec.team,
      owner: rec,
      until: now() + STREAKS.airstrike.duration,
      centre,
      heading,
      bombs: [],
      next: now() + 2.6,
      fired: 0,
      total: 10,
      spacing: 7.5,
    };
    // The run: the jet crosses the paint line and lays bombs along it.
    ensureRoot();
    if (!jet && !headless) {
      jet = buildJet(ctx, quality);
      root.add(jet);
    }
    if (jet) {
      jet.visible = true;
      inst.jetT = 0;
    }
    ctx.bus?.emit?.('hud:message', { kind: 'killstreak', text: 'AIRSTRIKE INBOUND', sub: 'Danger close', duration: 2.6 });
    ctx.audio?.play?.('distant_vehicle', { position: centre, volume: 1.1 });
    active.push(inst);
    return true;
  }

  function startCluster(rec) {
    const centre = aimPoint(rec, new THREE.Vector3());
    const inst = {
      id: 'cluster_strike',
      team: rec.team,
      owner: rec,
      until: now() + STREAKS.cluster_strike.duration,
      centre,
      next: now() + 1.8,
      fired: 0,
      total: headless ? 8 : 18,
      radius: 14,
    };
    ctx.bus?.emit?.('hud:message', { kind: 'killstreak', text: 'CLUSTER STRIKE', sub: 'Rounds inbound', duration: 2.4 });
    ctx.audio?.play?.('distant_explosion', { position: centre, volume: 0.8 });
    active.push(inst);
    return true;
  }

  function startChopper(rec) {
    ensureRoot();
    if (!chopper && !headless) {
      chopper = buildChopper(ctx, quality);
      root.add(chopper);
    }
    const bounds = ctx.level?.bounds;
    const cx = bounds ? (bounds.min.x + bounds.max.x) * 0.5 : 0;
    const cz = bounds ? (bounds.min.z + bounds.max.z) * 0.5 : 0;
    const inst = {
      id: 'chopper_gunner',
      team: rec.team,
      owner: rec,
      until: now() + STREAKS.chopper_gunner.duration,
      centre: new THREE.Vector3(cx, 0, cz),
      radius: 52,
      altitude: 46,
      angle: (ctx.rng?.() ?? 0.3) * Math.PI * 2,
      spin: 0,
      nextShot: now() + 3.2,
      target: null,
      burst: 0,
      pos: new THREE.Vector3(),
      aim: new THREE.Vector3(),
    };
    if (chopper) chopper.visible = true;
    ctx.bus?.emit?.('hud:message', { kind: 'killstreak', text: 'CHOPPER GUNNER', sub: 'Gunship on station', duration: 3 });
    ctx.audio?.play?.('distant_vehicle', { position: new THREE.Vector3(cx, 46, cz), volume: 1.2 });
    active.push(inst);
    return true;
  }

  const STARTERS = {
    uav: startUav,
    counter_uav: startCounterUav,
    airstrike: startAirstrike,
    cluster_strike: startCluster,
    chopper_gunner: startChopper,
  };

  function use(rec, id) {
    if (!rec?.alive) return false;
    const bag = ensureBag(rec);
    const i = bag.earned.indexOf(id);
    if (i < 0) return false;
    const start = STARTERS[id];
    if (!start) return false;
    let ok = false;
    try {
      ok = !!start(rec);
    } catch (err) {
      console.warn('[game] killstreak', id, 'failed:', err?.message || err);
      ok = false;
    }
    if (!ok) return false;
    bag.earned.splice(i, 1);
    bag.used.push(id);
    // A freed slot may immediately admit a reward the streak already paid for.
    grant(rec);
    ctx.bus?.emit?.('killstreak:used', { id, name: STREAKS[id]?.name || id, player: rec.id, team: rec.team, local: !!rec.isLocal });
    emitHud(rec);
    return true;
  }

  function useNext(rec) {
    const bag = ensureBag(rec);
    return bag.earned.length ? use(rec, bag.earned[0]) : false;
  }

  function useSlot(rec, slot) {
    const bag = ensureBag(rec);
    const id = bag.earned[slot];
    return id ? use(rec, id) : false;
  }

  /* ── radar ──────────────────────────────────────────────────────────────── */

  function uavActive(team) {
    return (teamState[team]?.uav ?? 0) > now();
  }
  function counterUavActive(team) {
    return (teamState[team]?.counter ?? 0) > now();
  }

  function sweepRadar(inst) {
    const localTeam = game?.localPlayer?.team;
    const enemies = game?.playersOfTeam?.(inst.team === 'A' ? 'B' : 'A') || [];
    const jammed = counterUavActive(inst.team === 'A' ? 'B' : 'A');
    const contacts = [];
    if (!jammed) {
      for (const e of enemies) {
        if (!e.alive || !e.position) continue;
        // Ghost keeps you off the sweep unless you are shooting.
        if (e.isLocal && game?.loadouts?.has?.('ghost') && now() - (e.lastFireTime ?? -99) > 2.5) continue;
        contacts.push({ id: e.id, x: e.position.x, z: e.position.z, y: e.position.y, yaw: e.yaw || 0, team: e.team });
      }
    }
    if (inst.team === localTeam) {
      ctx.bus?.emit?.('hud:radar', { contacts, uav: true, jammed, sweep: true, until: inst.until });
    }
    // Being under a UAV really does make the other side find you faster.
    if (!jammed) applyUavAwareness(inst.team);
  }

  function applyUavAwareness(team) {
    const bots = ctx.ai?.bots;
    if (!Array.isArray(bots)) return;
    const target = game?.localPlayer;
    if (!target || target.team === team) return;
    for (const b of bots) {
      const rec = game?.recordFor?.(b);
      if (!rec || rec.team !== team || !b.alive) continue;
      const t = b.sensor?.tracks?.get(ctx.player);
      if (t) {
        t.awareness = Math.max(t.awareness, 0.55);
        t.confidence = Math.max(t.confidence, 0.55);
        if (ctx.player?.position) t.lastKnownPos.copy(ctx.player.position);
      }
    }
  }

  /* ── strike execution ───────────────────────────────────────────────────── */

  function dropBomb(point, radius, damage, owner, type) {
    try {
      ctx.ballistics?.explode?.(point, { radius, damage, owner, attacker: owner, source: 'killstreak', type: type || 'frag' });
      return;
    } catch {
      /* fall through to a manual blast */
    }
    ctx.bus?.emit?.('explosion', { point: point.clone(), radius, damage, source: 'killstreak', owner });
    try {
      ctx.fx?.explosion?.(point, { radius, damage });
    } catch {
      /* optional */
    }
  }

  function tickAirstrike(inst, dt) {
    const t = now();
    // Jet flies the line, well ahead of its own bombs.
    if (jet) {
      inst.jetT = (inst.jetT ?? 0) + dt;
      const s = -170 + inst.jetT * 240;
      const h = inst.heading;
      jet.position.set(inst.centre.x + Math.sin(h) * s, 96 + Math.sin(inst.jetT * 0.6) * 2, inst.centre.z + Math.cos(h) * s);
      jet.rotation.set(0.03, h + Math.PI, Math.sin(inst.jetT * 0.9) * 0.06);
      jet.visible = Math.abs(s) < 300;
      if (jet.userData.flameMat) jet.userData.flameMat.opacity = 0.42 + 0.18 * Math.sin(t * 41);
    }
    if (inst.fired >= inst.total) return;
    if (t < inst.next) return;
    inst.next = t + 0.16;
    const k = inst.fired - (inst.total - 1) * 0.5;
    const h = inst.heading;
    _v.set(
      inst.centre.x + Math.sin(h) * k * inst.spacing + ((ctx.rng?.() ?? 0.5) - 0.5) * 2.4,
      0,
      inst.centre.z + Math.cos(h) * k * inst.spacing + ((ctx.rng?.() ?? 0.5) - 0.5) * 2.4
    );
    _v.y = (ctx.level?.groundY?.(_v.x, _v.z) ?? 0) + 0.4;
    dropBomb(_v, 11.5, 190, inst.owner, 'bomb');
    inst.fired++;
  }

  function tickCluster(inst, dt) {
    const t = now();
    if (inst.fired >= inst.total) return;
    if (t < inst.next) return;
    inst.next = t + 0.11 + (ctx.rng?.() ?? 0.5) * 0.16;
    const a = (ctx.rng?.() ?? 0.5) * Math.PI * 2;
    const r = Math.sqrt(ctx.rng?.() ?? 0.5) * inst.radius;
    _v.set(inst.centre.x + Math.cos(a) * r, 0, inst.centre.z + Math.sin(a) * r);
    _v.y = (ctx.level?.groundY?.(_v.x, _v.z) ?? 0) + 0.35;
    dropBomb(_v, 6.4, 110, inst.owner, 'frag');
    inst.fired++;
    void dt;
  }

  function tickChopper(inst, dt) {
    const t = now();
    inst.angle += dt * 0.16;
    const gy = ctx.level?.groundY?.(inst.centre.x, inst.centre.z) ?? 0;
    inst.pos.set(
      inst.centre.x + Math.cos(inst.angle) * inst.radius,
      gy + inst.altitude + Math.sin(t * 0.35) * 1.4,
      inst.centre.z + Math.sin(inst.angle) * inst.radius
    );
    if (chopper) {
      chopper.position.copy(inst.pos);
      // Nose along the tangent, banked into the turn.
      chopper.rotation.set(0.05, -inst.angle + Math.PI * 0.5, -0.16);
      const ud = chopper.userData;
      inst.spin += dt * 26;
      if (ud.rotor) ud.rotor.rotation.y = inst.spin;
      if (ud.tailRotor) ud.tailRotor.rotation.x = inst.spin * 2.6;
      if (ud.lights) {
        const blink = Math.sin(t * 3.4) > 0.7;
        ud.lights.strobe.visible = blink;
        ud.lights.tail.visible = Math.sin(t * 3.4 + 1.2) > 0.8;
      }
    }

    // Rotor wash: audible, and it should keep reminding you it is up there.
    if (t > (inst.nextRotorSound ?? 0)) {
      inst.nextRotorSound = t + 1.4;
      ctx.audio?.playAt?.('distant_vehicle', inst.pos, { volume: 0.55 });
    }

    // Acquire and engage.
    if (t < inst.nextShot) return;
    const enemies = game?.playersOfTeam?.(inst.team === 'A' ? 'B' : 'A') || [];
    let best = null;
    let bestD = 1e9;
    for (const e of enemies) {
      if (!e.alive || !e.position) continue;
      _v2.set(e.position.x, e.position.y + 1.2, e.position.z);
      const d = _v2.distanceTo(inst.pos);
      if (d > 130) continue;
      _dir.copy(_v2).sub(inst.pos);
      const dist = _dir.length();
      _dir.multiplyScalar(1 / dist);
      const hit = ctx.physics?.raycast?.(inst.pos, _dir, dist - 0.6, 1 | 8);
      if (hit) continue; // no line of sight
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) {
      inst.nextShot = t + 0.55;
      return;
    }
    inst.nextShot = t + 0.085;
    inst.aim.set(best.position.x, best.position.y + 1.1, best.position.z);
    // Walk the burst onto the target rather than laser-beaming it.
    const spread = 1.5;
    inst.aim.x += ((ctx.rng?.() ?? 0.5) - 0.5) * spread;
    inst.aim.z += ((ctx.rng?.() ?? 0.5) - 0.5) * spread;
    inst.aim.y += ((ctx.rng?.() ?? 0.5) - 0.5) * 0.8;
    try {
      ctx.fx?.tracer?.(inst.pos, inst.aim, { width: 0.06, colour: 0xffd7a0, speed: 900 });
    } catch {
      /* optional */
    }
    const dev = inst.aim.distanceTo(_v2.set(best.position.x, best.position.y + 1.1, best.position.z));
    if (dev < 0.85) {
      game?.damage?.(best.entity || best.bot || null, 34, {
        // The *entity*, not the record: Bot.damage() registers whatever it is given as
        // a perception target, and a scoreboard row is not something bots should hunt.
        attacker: inst.owner?.entity || null,
        attackerRecord: inst.owner,
        source: 'killstreak',
        streak: 'chopper_gunner',
        point: inst.aim.clone(),
        dir: _dir.clone(),
      });
    } else {
      try {
        ctx.fx?.impact?.(inst.aim, new THREE.Vector3(0, 1, 0), { surface: 'dirt', energy: 900 });
      } catch {
        /* optional */
      }
    }
    if (chopper?.userData?.barrel) {
      try {
        ctx.fx?.muzzle?.(chopper.localToWorld(_v.set(0, -0.66, -3.4)), _dir, { scale: 0.5, world: true });
      } catch {
        /* optional */
      }
    }
  }

  /* ── frame ──────────────────────────────────────────────────────────────── */

  function update(dt) {
    const t = now();

    for (let i = pending.length - 1; i >= 0; i--) {
      if (t >= pending[i].at) {
        const p = pending[i];
        pending.splice(i, 1);
        use(p.rec, p.id);
      }
    }

    for (let i = active.length - 1; i >= 0; i--) {
      const inst = active[i];
      if (t > inst.until) {
        if (inst.id === 'chopper_gunner' && chopper) chopper.visible = false;
        if (inst.id === 'airstrike' && jet) jet.visible = false;
        active.splice(i, 1);
        ctx.bus?.emit?.('killstreak:ended', { id: inst.id, team: inst.team });
        if (inst.id === 'uav' && inst.team === game?.localPlayer?.team) {
          ctx.bus?.emit?.('hud:radar', { contacts: [], uav: false, jammed: false, sweep: false });
        }
        continue;
      }
      switch (inst.id) {
        case 'uav':
          inst.sweep -= dt;
          if (inst.sweep <= 0) {
            inst.sweep = 1.35;
            sweepRadar(inst);
          }
          break;
        case 'airstrike':
          tickAirstrike(inst, dt);
          break;
        case 'cluster_strike':
          tickCluster(inst, dt);
          break;
        case 'chopper_gunner':
          tickChopper(inst, dt);
          break;
        default:
          break;
      }
    }
  }

  function reset() {
    active.length = 0;
    pending.length = 0;
    teamState.A.uav = 0;
    teamState.A.counter = 0;
    teamState.B.uav = 0;
    teamState.B.counter = 0;
    if (chopper) chopper.visible = false;
    if (jet) jet.visible = false;
    ctx.bus?.emit?.('hud:radar', { contacts: [], uav: false, jammed: false, sweep: false });
  }

  function setQuality(q, hless) {
    quality = q;
    headless = !!hless;
  }

  function dispose() {
    reset();
    for (const obj of [chopper, jet]) {
      if (!obj) continue;
      root.remove(obj);
      for (const g of obj.userData?.geos || []) {
        try {
          g.dispose();
        } catch {
          /* best effort */
        }
      }
      for (const m of obj.userData?.mats || []) {
        try {
          m.dispose();
        } catch {
          /* best effort */
        }
      }
    }
    chopper = null;
    jet = null;
    if (added) ctx.scene?.remove?.(root);
    added = false;
  }

  return {
    STREAKS,
    STREAK_ORDER,
    root,
    active,
    onKill,
    onDeath,
    use,
    useNext,
    useSlot,
    earnedFor: (rec) => ensureBag(rec).earned.slice(),
    nextStreakFor,
    emitHud,
    uavActive,
    counterUavActive,
    reset,
    update,
    setQuality,
    dispose,
    clamp01,
  };
}

export default createKillstreaks;
