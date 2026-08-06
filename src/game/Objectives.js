/**
 * Objectives.js — capture points, hardpoints and the bomb. Owner: game agent.
 * Part of the rules layer published as `ctx.game` (see GameMode.js).
 *
 * Every objective is a `Zone`: a world position, a radius, an occupancy test run
 * against the live player + bot roster, and a state machine (neutral / capturing /
 * contested / owned). Domination, Hardpoint and Search & Destroy are three different
 * readings of the same machine.
 *
 * Sites are not hand-placed. They are sampled from `ctx.level.spawnPoints` — the only
 * positions the map guarantees are standable, collider-free and physics-height-snapped
 * — with farthest-point sampling biased toward the middle of the play space and along
 * the Z axis, because that is the axis the two teams spawn on. Each one is then named
 * after the nearest `pointsOfInterest` entry, so the HUD can say "Fountain Plaza"
 * rather than "Objective B".
 *
 * The markers are real world geometry, not HUD paint: a ground decal ring that follows
 * the terrain height sample by sample, a soft light column, and — for Domination — a
 * physical flag: concrete kerb base, chipped-steel pole, canvas banner. They are lit
 * by the scene, use `ctx.materials`, and sit *on* the ground, never above it.
 *
 * ── Public API (createObjectives(ctx, game) -> Objectives) ──────────────────────
 *   setMode(modeDef)            build the zone set for a mode (or clear it)
 *   reset()                     back to round-start state
 *   update(dt, roster, live)    tick capture logic (live only) + visuals
 *   zones                       live Zone[]
 *   zoneAt(id)
 *   state                       {mode, bomb, hardpoint, flags}
 *   hudPayload()                the object shipped on `hud:objective`
 *   bombPlanted / bombCarrier
 *   tryPlant(rec, dt) / tryDefuse(rec, dt)     progress-driven, call while held
 *   ownedBy(team) / setVisible(v) / setHeadless(v) / dispose()
 *
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   game:objective  {id, event, team, progress, zone}
 *        event: 'captured' | 'neutralised' | 'contested' | 'lost' | 'rotated' |
 *               'planted' | 'defused' | 'detonated' | 'progress'
 *   hud:objective   {mode, zones, bomb, hardpoint, message}
 */
import * as THREE from 'three';

const TEAM_COLOUR = {
  A: new THREE.Color(0.15, 0.46, 0.92),
  B: new THREE.Color(0.94, 0.3, 0.13),
  neutral: new THREE.Color(0.86, 0.78, 0.46),
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ── the ring shader ──────────────────────────────────────────────────────── */

// language=GLSL
const RING_VERT = /* glsl */ `
  varying vec2 vLocal;
  varying vec3 vWorldPos;
  void main() {
    vLocal = position.xz;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// language=GLSL
const RING_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vLocal;
  varying vec3 vWorldPos;
  uniform vec3  uColor;
  uniform vec3  uContestColor;
  uniform float uRadius;
  uniform float uTime;
  uniform float uProgress;   // 0..1 capture bar
  uniform float uContest;    // 0..1 contested flash
  uniform float uOwned;      // 0..1 owned by uColor's team
  uniform float uOpacity;
  uniform vec3  uCamera;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    float r = length(vLocal) / max(uRadius, 0.001);
    if (r > 1.02) discard;

    float ang = atan(vLocal.y, vLocal.x);           // -PI..PI
    float a01 = (ang + 3.14159265) / 6.28318531;    // 0..1 clockwise from -X

    // The read is the rim, not the fill: a painted boundary line on the ground.
    float band = smoothstep(0.885, 0.955, r) * (1.0 - smoothstep(0.985, 1.012, r));
    // Barely-there interior wash so the zone has a footprint without becoming paint.
    float fill = 0.055 * smoothstep(0.15, 1.0, r) * (1.0 - smoothstep(0.95, 1.0, r));
    // Slow rotating sweep — the thing that says "this is live".
    float sweep = pow(max(0.0, sin((a01 - uTime * 0.11) * 6.28318531) * 0.5 + 0.5), 16.0);
    // Capture bar drawn round the rim.
    float bar = step(a01, uProgress) * band * 1.4 * step(0.001, uProgress);
    // Ownership pulse.
    float pulse = 0.5 + 0.5 * sin(uTime * 2.1 + r * 5.0);
    // Dashed inner guide ring.
    float dash = smoothstep(0.615, 0.638, r) * (1.0 - smoothstep(0.655, 0.678, r));
    dash *= step(0.5, fract(a01 * 24.0 + uTime * 0.05));

    float grain = hash(floor(vWorldPos.xz * 22.0)) * 0.2 + 0.88;

    vec3 col = mix(uColor, uContestColor, uContest);
    float alpha = (band * (0.34 + 0.16 * pulse * uOwned) + fill + sweep * band * 0.6 + bar * 0.4 + dash * 0.16);
    alpha *= grain * uOpacity;
    alpha *= 1.0 + uContest * (0.35 + 0.45 * sin(uTime * 14.0));

    // Fade the marker out under the player's feet so it never covers the sights.
    float dCam = distance(uCamera.xz, vWorldPos.xz);
    alpha *= smoothstep(1.2, 4.5, dCam);
    // And fade it away at long range so the map does not glow.
    alpha *= 1.0 - smoothstep(48.0, 82.0, dCam);

    if (alpha < 0.004) discard;
    // Saturated only on the rim; the wash reads as a dusty scuff, not a light box.
    vec3 outCol = mix(mix(col, vec3(0.78, 0.79, 0.8), 0.5), col, clamp(band * 2.2, 0.0, 1.0));
    gl_FragColor = vec4(outCol * (1.0 + uContest * 0.4), clamp(alpha, 0.0, 0.5));
  }
`;

// language=GLSL
const BEAM_VERT = /* glsl */ `
  varying float vH;
  varying vec3 vWorldPos;
  void main() {
    vH = uv.y;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// language=GLSL
const BEAM_FRAG = /* glsl */ `
  precision highp float;
  varying float vH;
  varying vec3 vWorldPos;
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform vec3 uCamera;
  void main() {
    float fade = pow(1.0 - vH, 1.9);
    float shimmer = 0.82 + 0.18 * sin(uTime * 1.7 + vH * 9.0);
    float d = distance(uCamera.xz, vWorldPos.xz);
    float near = smoothstep(2.0, 6.0, d);
    float far = 1.0 - smoothstep(70.0, 110.0, d);
    float a = fade * shimmer * uOpacity * near * far * 0.3;
    if (a < 0.003) discard;
    // Saturate slightly so the column reads as a team colour, not fog.
    gl_FragColor = vec4(uColor * 1.25, a);
  }
`;

/* ─────────────────────────────────────────────────────────────── factory ── */

export function createObjectives(ctx, game) {
  const root = new THREE.Group();
  root.name = 'objectives';
  root.matrixAutoUpdate = false;
  root.renderOrder = 6;

  /** @type {Array<object>} */
  const zones = [];
  const disposables = [];
  let mode = null;
  let visible = true;
  let headless = false;
  let added = false;
  const _cam = new THREE.Vector3();

  const state = {
    mode: null,
    /** Search & Destroy */
    bomb: {
      planted: false,
      site: null,
      carrier: null,
      timer: 0,
      fuse: 45,
      plantProgress: 0,
      defuseProgress: 0,
      defusing: null,
      planter: null,
      defuser: null,
      exploded: false,
      defused: false,
    },
    /** Hardpoint */
    hardpoint: { index: 0, zone: null, nextRotate: 0, rotateEvery: 60 },
    message: '',
  };

  /* ── level helpers ──────────────────────────────────────────────────────── */

  const _down = new THREE.Vector3(0, -1, 0);
  const _org = new THREE.Vector3();

  /**
   * Real surface height, not terrain grade. `Level.groundY` models the terrain, which
   * is wrong wherever the map builds a floor over it — the plaza deck, the market hall
   * slab, the channel invert. A short downward ray finds what is actually there, and
   * the result is clamped so a marker never climbs a wall it happens to touch.
   */
  function groundY(x, z, hintY = 0, span = 2.4, lift = 1.3, drop = 2.6) {
    const phys = ctx.physics;
    if (phys?.raycast) {
      _org.set(x, hintY + span, z);
      // WORLD only: props are street furniture, and a marker draped over a crate lid
      // is the single most "hobby project" thing a capture zone can do.
      const hit = phys.raycast(_org, _down, span + 4.0, 1);
      if (hit?.point && (hit.normal?.y ?? 1) > 0.4) {
        return clamp(hit.point.y, hintY - drop, hintY + lift);
      }
    }
    const y = ctx.level?.groundY?.(x, z);
    return Number.isFinite(y) ? clamp(y, hintY - drop, hintY + lift) : hintY;
  }

  function poi(id) {
    const p = ctx.level?.poi?.(id);
    if (p?.pos) return p;
    const list = ctx.level?.pointsOfInterest;
    if (list?.length) return list[0];
    return null;
  }

  /** Nearest point-of-interest name, so a site is called something human. */
  function nameNear(x, z) {
    let best = null;
    let bestD = Infinity;
    for (const p of ctx.level?.pointsOfInterest || []) {
      if (!p?.pos) continue;
      const d = Math.hypot(p.pos.x - x, p.pos.z - z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best?.name || 'Objective';
  }

  /**
   * Objective sites are picked from the level's neutral spawn points: those are the
   * only positions the map guarantees are standable, clear of colliders and already
   * height-snapped against real physics. Farthest-point sampling from the map centre
   * then spreads `n` of them across the play space.
   */
  function candidateSites() {
    const out = [];
    for (const p of ctx.level?.spawnPoints || []) {
      if (p?.team === 'ffa' && p.pos) out.push(p.pos);
    }
    if (out.length >= 4) return out;
    for (const p of ctx.level?.pointsOfInterest || []) if (p?.pos) out.push(p.pos);
    return out;
  }

  /**
   * Farthest-point sampling, with two deliberate biases:
   *   • sites stay inside the middle of the play space, because objectives pinned to
   *     the perimeter turn every mode into a spawn-trap;
   *   • separation is measured with the Z axis weighted up, because both teams spawn
   *     north/south, so a set spread along Z is what makes the lanes contested.
   */
  function pickSpread(n) {
    const all = candidateSites();
    if (all.length <= n) return all.slice();
    const b = ctx.level?.bounds;
    const cx = b ? (b.min.x + b.max.x) * 0.5 : 0;
    const cz = b ? (b.min.z + b.max.z) * 0.5 : 0;
    const half = b ? Math.max(20, Math.min(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5) : 60;

    let cands = all.filter((p) => Math.hypot(p.x - cx, p.z - cz) < half * 0.66);
    if (cands.length < n) cands = all.filter((p) => Math.hypot(p.x - cx, p.z - cz) < half * 0.85);
    if (cands.length < n) cands = all;

    const sep = (a, c) => Math.hypot((a.x - c.x) * 0.7, (a.z - c.z) * 1.4);

    let seed = cands[0];
    let bestD = Infinity;
    for (const p of cands) {
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (d < bestD) {
        bestD = d;
        seed = p;
      }
    }
    const chosen = [seed];
    while (chosen.length < n) {
      let best = null;
      let bestScore = -1;
      for (const c of cands) {
        if (chosen.includes(c)) continue;
        let m = Infinity;
        for (const s of chosen) m = Math.min(m, sep(c, s));
        if (m > bestScore) {
          bestScore = m;
          best = c;
        }
      }
      if (!best) break;
      chosen.push(best);
    }
    return chosen;
  }

  /* ── marker construction ────────────────────────────────────────────────── */

  function makeRing(zone) {
    const r = zone.radius;
    const seg = headless ? 14 : 24;
    const geo = new THREE.PlaneGeometry(r * 2, r * 2, seg, seg);
    geo.rotateX(-Math.PI / 2);
    // Follow the ground, sample by sample, so the marker never floats or clips.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + zone.pos.x;
      const z = pos.getZ(i) + zone.pos.z;
      // Follow the slab, but never wander more than a step from the zone plane, so a
      // kerb or a doorway sill cannot tear the marker into a wall.
      pos.setY(i, groundY(x, z, zone.pos.y, 1.0, 0.45, 1.1) - zone.pos.y + 0.025);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: TEAM_COLOUR.neutral.clone() },
        uContestColor: { value: new THREE.Color(1.0, 0.86, 0.25) },
        uRadius: { value: r },
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uContest: { value: 0 },
        uOwned: { value: 0 },
        uOpacity: { value: 1 },
        uCamera: { value: new THREE.Vector3() },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(zone.pos);
    mesh.renderOrder = 7;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    disposables.push(geo, mat);
    return mesh;
  }

  function makeBeam(zone) {
    const h = 7.5;
    const geo = new THREE.CylinderGeometry(0.22, 0.55, h, headless ? 8 : 14, 1, true);
    geo.translate(0, h * 0.5, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: TEAM_COLOUR.neutral.clone() },
        uTime: { value: 0 },
        uOpacity: { value: 1 },
        uCamera: { value: new THREE.Vector3() },
      },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(zone.pos);
    mesh.renderOrder = 8;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    disposables.push(geo, mat);
    return mesh;
  }

  /** A real flag: kerb base, steel pole, canvas banner. Domination only. */
  function makeFlag(zone) {
    const g = new THREE.Group();
    const mat = (name, over) => {
      try {
        if (over && ctx.materials?.clone) return ctx.materials.clone(name, over);
        return ctx.materials?.get?.(name) || new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.85 });
      } catch {
        return new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.85 });
      }
    };

    const baseGeo = new THREE.CylinderGeometry(0.42, 0.5, 0.22, 12);
    baseGeo.translate(0, 0.11, 0);
    const base = new THREE.Mesh(baseGeo, mat('concrete_cast'));
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    const poleGeo = new THREE.CylinderGeometry(0.038, 0.045, 3.1, 8);
    poleGeo.translate(0, 1.55 + 0.2, 0);
    const pole = new THREE.Mesh(poleGeo, mat('painted_steel_chipped'));
    pole.castShadow = true;
    pole.receiveShadow = true;
    g.add(pole);

    // Sand-bag ring so the flag reads as fortified rather than dropped in.
    const bagGeo = new THREE.BoxGeometry(0.52, 0.19, 0.3);
    const bagMat = mat('sandbag');
    const bags = new THREE.InstancedMesh(bagGeo, bagMat, 7);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      p.set(Math.cos(a) * 0.86, 0.1, Math.sin(a) * 0.86);
      q.setFromEuler(new THREE.Euler(0, -a + Math.PI / 2, (i % 2 ? 1 : -1) * 0.04));
      s.set(1, 1, 1);
      m.compose(p, q, s);
      bags.setMatrixAt(i, m);
    }
    bags.instanceMatrix.needsUpdate = true;
    bags.castShadow = true;
    bags.receiveShadow = true;
    g.add(bags);

    const bannerGeo = new THREE.PlaneGeometry(0.95, 0.62, 8, 4);
    bannerGeo.translate(0.5, 2.95, 0);
    const bannerMat = mat('fabric_canvas', { color: 0xb8b2a4, side: 'double' });
    if (bannerMat) {
      bannerMat.side = THREE.DoubleSide;
      if ('shadowSide' in bannerMat) bannerMat.shadowSide = THREE.DoubleSide;
    }
    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.castShadow = true;
    banner.receiveShadow = true;
    banner.userData.baseGeo = bannerGeo;
    g.add(banner);

    g.position.copy(zone.pos);
    g.updateMatrix();
    disposables.push(baseGeo, poleGeo, bagGeo, bannerGeo, bannerMat);
    zone.banner = banner;
    zone.bannerGeo = bannerGeo;
    return g;
  }

  /** The bomb itself — a satchel with a blinking arming light. */
  function makeBomb() {
    const g = new THREE.Group();
    let mat;
    try {
      mat = ctx.materials?.get?.('fabric_webbing') || new THREE.MeshStandardMaterial({ color: 0x2b2b28, roughness: 0.9 });
    } catch {
      mat = new THREE.MeshStandardMaterial({ color: 0x2b2b28, roughness: 0.9 });
    }
    const bodyGeo = new THREE.BoxGeometry(0.36, 0.2, 0.24);
    bodyGeo.translate(0, 0.1, 0);
    const body = new THREE.Mesh(bodyGeo, mat);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const ledGeo = new THREE.SphereGeometry(0.022, 8, 6);
    ledGeo.translate(0.1, 0.21, 0.07);
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xff2d10, toneMapped: false });
    const led = new THREE.Mesh(ledGeo, ledMat);
    g.add(led);
    g.visible = false;
    // Kept out of `disposables`: that list is emptied on every mode change, and the
    // bomb outlives it.
    return { group: g, led, geos: [bodyGeo, ledGeo], mats: [ledMat] };
  }

  let bombVisual = null;

  /* ── zone construction ──────────────────────────────────────────────────── */

  function makeZone(def) {
    const p = def.poi ? poi(def.poi) : null;
    const px = def.at?.x ?? def.pos?.[0] ?? p?.pos?.x ?? 0;
    const pz = def.at?.z ?? def.pos?.[2] ?? p?.pos?.z ?? 0;
    const py = groundY(px, pz, def.at?.y ?? def.pos?.[1] ?? p?.pos?.y ?? 0);
    const zone = {
      id: def.id,
      label: def.label || def.id,
      name: def.name || p?.name || nameNear(px, pz),
      kind: def.kind || 'capture',
      pos: new THREE.Vector3(px, py, pz),
      radius: def.radius ?? Math.min(9, Math.max(5, p?.radius ?? 7)),
      height: def.height ?? 4.5,
      owner: def.owner ?? null,
      capturing: null,
      progress: 0,
      contested: false,
      occupants: { A: 0, B: 0 },
      inside: [],
      active: def.active !== false,
      captureTime: def.captureTime ?? 9,
      lastEvent: '',
      lastEventAt: -99,
      contributors: new Set(),
      ring: null,
      beam: null,
      flag: null,
      banner: null,
    };
    zone.ring = makeRing(zone);
    zone.beam = makeBeam(zone);
    root.add(zone.ring, zone.beam);
    if (def.flag) {
      zone.flag = makeFlag(zone);
      root.add(zone.flag);
    }
    return zone;
  }

  function destroyBomb() {
    if (!bombVisual) return;
    root.remove(bombVisual.group);
    for (const d of [...(bombVisual.geos || []), ...(bombVisual.mats || [])]) {
      try {
        d.dispose?.();
      } catch {
        /* best effort */
      }
    }
    bombVisual = null;
  }

  function clearZones() {
    for (const z of zones) {
      if (z.ring) root.remove(z.ring);
      if (z.beam) root.remove(z.beam);
      if (z.flag) root.remove(z.flag);
    }
    zones.length = 0;
    destroyBomb();
    for (const d of disposables) {
      try {
        d.dispose?.();
      } catch {
        /* best effort */
      }
    }
    disposables.length = 0;
  }

  /* ── mode wiring ────────────────────────────────────────────────────────── */

  /** Hardpoint rotation ring, filled from the level on setMode. */
  let hardpointRing = [];

  function setMode(def) {
    mode = def || null;
    state.mode = def?.id || null;
    clearZones();
    state.message = '';
    resetBomb();

    if (!def?.objective) {
      emitHud();
      return zones;
    }

    if (def.objective === 'domination') {
      // Three well-separated sites, ordered south (A, team A's home) to north (C).
      const sites = pickSpread(3).slice().sort((a, b) => b.z - a.z);
      const labels = ['A', 'B', 'C'];
      sites.forEach((at, i) =>
        zones.push(makeZone({ id: labels[i], label: labels[i], at, kind: 'capture', flag: true, radius: 7.2, captureTime: 9 }))
      );
      // Home flags start owned, exactly like Dom's opening state.
      if (zones[0]) zones[0].owner = 'A';
      if (zones[zones.length - 1]) zones[zones.length - 1].owner = 'B';
    } else if (def.objective === 'hardpoint') {
      hardpointRing = pickSpread(6);
      state.hardpoint.index = 0;
      state.hardpoint.rotateEvery = def.hardpointTime ?? 60;
      state.hardpoint.nextRotate = (ctx.time?.elapsed ?? 0) + state.hardpoint.rotateEvery;
      zones.push(makeZone({ id: 'HP', label: 'HILL', at: hardpointRing[0], kind: 'hardpoint', radius: 7.5 }));
      state.hardpoint.zone = zones[0];
    } else if (def.objective === 'bomb') {
      // Both sites on the defenders' half of the map.
      const spread = pickSpread(4).slice().sort((a, b) => a.z - b.z);
      const sites = (def.attackers === 'A' ? spread.slice(0, 2) : spread.slice(-2)).sort((a, b) => a.x - b.x);
      const labels = ['A', 'B'];
      sites.forEach((at, i) =>
        zones.push(makeZone({ id: labels[i], label: labels[i], at, kind: 'bombsite', radius: 6.4, flag: false }))
      );
      if (!bombVisual) {
        bombVisual = makeBomb();
        root.add(bombVisual.group);
      }
    }
    applyColours(true);
    emitHud();
    return zones;
  }

  function resetBomb() {
    const b = state.bomb;
    b.planted = false;
    b.site = null;
    b.carrier = null;
    b.timer = 0;
    b.plantProgress = 0;
    b.defuseProgress = 0;
    b.defusing = null;
    b.planter = null;
    b.defuser = null;
    b.exploded = false;
    b.defused = false;
    if (bombVisual) bombVisual.group.visible = false;
  }

  function reset() {
    resetBomb();
    for (const z of zones) {
      z.progress = 0;
      z.capturing = null;
      z.contested = false;
      z.contributors.clear();
      z.occupants.A = 0;
      z.occupants.B = 0;
    }
    if (mode?.objective === 'domination') {
      for (const z of zones) z.owner = null;
      if (zones.length) zones[0].owner = 'A';
      if (zones.length > 1) zones[zones.length - 1].owner = 'B';
    } else if (mode?.objective === 'hardpoint') {
      state.hardpoint.index = 0;
      state.hardpoint.nextRotate = (ctx.time?.elapsed ?? 0) + state.hardpoint.rotateEvery;
      moveHardpoint(0);
    }
    applyColours(true);
    emitHud();
  }

  /* ── occupancy ──────────────────────────────────────────────────────────── */

  function tally(roster) {
    for (const z of zones) {
      z.occupants.A = 0;
      z.occupants.B = 0;
      z.inside.length = 0;
      if (!z.active) continue;
      const r2 = z.radius * z.radius;
      for (let i = 0; i < roster.length; i++) {
        const rec = roster[i];
        if (!rec?.alive) continue;
        const p = rec.position;
        if (!p) continue;
        const dy = p.y - z.pos.y;
        if (dy < -3 || dy > z.height) continue;
        const dx = p.x - z.pos.x;
        const dz = p.z - z.pos.z;
        if (dx * dx + dz * dz > r2) continue;
        z.occupants[rec.team] = (z.occupants[rec.team] || 0) + 1;
        z.inside.push(rec);
      }
    }
  }

  function announce(zone, event, team, extra) {
    zone.lastEvent = event;
    zone.lastEventAt = ctx.time?.elapsed ?? 0;
    ctx.bus?.emit?.('game:objective', {
      id: zone.id,
      label: zone.label,
      event,
      team: team ?? null,
      progress: zone.progress,
      zone,
      ...extra,
    });
  }

  /* ── capture tick ───────────────────────────────────────────────────────── */

  function tickCapture(z, dt) {
    const a = z.occupants.A;
    const b = z.occupants.B;
    const contested = a > 0 && b > 0;
    z.contested = contested;

    if (contested) {
      if (z.lastEvent !== 'contested' || (ctx.time?.elapsed ?? 0) - z.lastEventAt > 3) announce(z, 'contested', null);
      return;
    }

    const team = a > 0 ? 'A' : b > 0 ? 'B' : null;
    if (!team) {
      // Decay towards neutral when abandoned mid-capture.
      if (z.progress > 0) {
        z.progress = Math.max(0, z.progress - dt / (z.captureTime * 1.8));
        if (z.progress === 0) z.capturing = null;
      }
      return;
    }

    if (z.owner === team) {
      z.progress = 0;
      z.capturing = null;
      for (const rec of z.inside) z.contributors.add(rec);
      return;
    }

    if (z.capturing !== team) {
      z.capturing = team;
      z.progress = 0;
      z.contributors.clear();
    }
    const n = team === 'A' ? a : b;
    // Extra bodies help, with diminishing returns — the CoD curve.
    const rate = (1 / z.captureTime) * (1 + 0.55 * (Math.sqrt(n) - 1));
    z.progress += rate * dt;
    for (const rec of z.inside) z.contributors.add(rec);

    if (z.progress >= 1) {
      const prevOwner = z.owner;
      z.owner = team;
      z.progress = 0;
      z.capturing = null;
      if (prevOwner && prevOwner !== team) announce(z, 'neutralised', team, { from: prevOwner });
      announce(z, 'captured', team, { contributors: [...z.contributors] });
      game?.onZoneCaptured?.(z, team, [...z.contributors]);
      z.contributors.clear();
      applyColours();
    }
  }

  /* ── hardpoint ──────────────────────────────────────────────────────────── */

  function moveHardpoint(index) {
    const z = state.hardpoint.zone;
    if (!z || !hardpointRing.length) return;
    const p = hardpointRing[index % hardpointRing.length];
    if (!p) return;
    const y = groundY(p.x, p.z, p.y);
    z.pos.set(p.x, y, p.z);
    z.name = nameNear(p.x, p.z);
    z.owner = null;
    z.progress = 0;
    z.capturing = null;
    z.contested = false;
    // Rebuild the ring so it hugs the new ground.
    if (z.ring) {
      root.remove(z.ring);
      const oldGeo = z.ring.geometry;
      const oldMat = z.ring.material;
      const i1 = disposables.indexOf(oldGeo);
      if (i1 >= 0) disposables.splice(i1, 1);
      const i2 = disposables.indexOf(oldMat);
      if (i2 >= 0) disposables.splice(i2, 1);
      oldGeo.dispose();
      oldMat.dispose();
      z.ring = makeRing(z);
      root.add(z.ring);
    }
    if (z.beam) {
      z.beam.position.copy(z.pos);
      z.beam.updateMatrix();
    }
    announce(z, 'rotated', null, { name: z.name, index });
    applyColours(true);
  }

  function tickHardpoint(dt) {
    const hp = state.hardpoint;
    const z = hp.zone;
    if (!z) return;
    const now = ctx.time?.elapsed ?? 0;
    if (now >= hp.nextRotate) {
      hp.index++;
      hp.nextRotate = now + hp.rotateEvery;
      moveHardpoint(hp.index);
    }
    const a = z.occupants.A;
    const b = z.occupants.B;
    z.contested = a > 0 && b > 0;
    if (z.contested) {
      z.owner = null;
      return;
    }
    const team = a > 0 ? 'A' : b > 0 ? 'B' : null;
    z.owner = team;
    if (!team) return;
    z.progress = clamp01(z.progress + dt * 0.4);
    game?.onHardpointTick?.(z, team, dt, z.inside);
  }

  /* ── bomb ───────────────────────────────────────────────────────────────── */

  function siteFor(rec) {
    for (const z of zones) {
      if (z.kind !== 'bombsite') continue;
      const dx = rec.position.x - z.pos.x;
      const dz = rec.position.z - z.pos.z;
      const dy = (rec.position.y ?? 0) - z.pos.y;
      if (dy < -3 || dy > z.height) continue;
      if (dx * dx + dz * dz <= z.radius * z.radius) return z;
    }
    return null;
  }

  /** Call every frame the plant key is held. Returns 0..1 progress. */
  function tryPlant(rec, dt) {
    const b = state.bomb;
    if (b.planted || !rec?.alive) return 0;
    if (mode?.objective !== 'bomb') return 0;
    if (rec.team !== (mode.attackers || 'A')) return 0;
    const site = siteFor(rec);
    if (!site) {
      b.plantProgress = Math.max(0, b.plantProgress - dt * 1.6);
      return b.plantProgress;
    }
    b.plantProgress = clamp01(b.plantProgress + dt / (mode.plantTime ?? 3));
    if (b.plantProgress >= 1) {
      b.planted = true;
      b.site = site;
      b.planter = rec;
      b.timer = mode.bombFuse ?? 45;
      b.fuse = b.timer;
      b.plantProgress = 0;
      site.owner = rec.team;
      if (bombVisual) {
        bombVisual.group.position.set(rec.position.x, groundY(rec.position.x, rec.position.z, rec.position.y), rec.position.z);
        bombVisual.group.rotation.y = (ctx.rng?.() ?? 0.5) * Math.PI * 2;
        bombVisual.group.updateMatrix();
        bombVisual.group.visible = true;
      }
      announce(site, 'planted', rec.team, { planter: rec.name });
      game?.onBombPlanted?.(rec, site);
      applyColours(true);
    }
    return b.plantProgress;
  }

  /** Call every frame the defuse key is held. */
  function tryDefuse(rec, dt) {
    const b = state.bomb;
    if (!b.planted || !rec?.alive || b.defused || b.exploded) return 0;
    if (rec.team === (mode?.attackers || 'A')) return 0;
    const site = b.site;
    if (!site) return 0;
    const dx = rec.position.x - site.pos.x;
    const dz = rec.position.z - site.pos.z;
    if (dx * dx + dz * dz > site.radius * site.radius) {
      b.defuseProgress = Math.max(0, b.defuseProgress - dt * 1.4);
      return b.defuseProgress;
    }
    b.defusing = rec;
    b.defuseProgress = clamp01(b.defuseProgress + dt / (mode?.defuseTime ?? 5));
    if (b.defuseProgress >= 1) {
      b.defused = true;
      b.planted = false;
      b.defuser = rec;
      if (bombVisual) bombVisual.group.visible = false;
      announce(site, 'defused', rec.team, { defuser: rec.name });
      game?.onBombDefused?.(rec, site);
    }
    return b.defuseProgress;
  }

  function tickBomb(dt) {
    const b = state.bomb;
    if (!b.planted) return;
    b.timer -= dt;
    if (bombVisual?.led) {
      const t = ctx.time?.elapsed ?? 0;
      const rate = clamp(1 + (1 - b.timer / Math.max(1, b.fuse)) * 9, 1, 12);
      bombVisual.led.visible = Math.sin(t * rate * Math.PI) > 0;
    }
    if (b.timer <= 0) {
      b.planted = false;
      b.exploded = true;
      const p = b.site?.pos;
      if (p) {
        try {
          ctx.ballistics?.explode?.(p.clone().setY(p.y + 0.4), { radius: 16, damage: 260, type: 'bomb', source: 'objective' });
        } catch {
          /* optional */
        }
      }
      if (bombVisual) bombVisual.group.visible = false;
      if (b.site) announce(b.site, 'detonated', mode?.attackers || 'A');
      game?.onBombDetonated?.(b.site);
    }
  }

  /* ── visuals ────────────────────────────────────────────────────────────── */

  function colourFor(team) {
    return TEAM_COLOUR[team] || TEAM_COLOUR.neutral;
  }

  function applyColours(force) {
    for (const z of zones) {
      const col = colourFor(z.capturing || z.owner);
      if (z.ring) {
        z.ring.material.uniforms.uColor.value.lerp(col, force ? 1 : 0.5);
        z.ring.material.uniforms.uOwned.value = z.owner ? 1 : 0;
      }
      if (z.beam) z.beam.material.uniforms.uColor.value.lerp(col, force ? 1 : 0.5);
      if (z.banner) {
        const m = z.banner.material;
        if (m?.color) m.color.copy(colourFor(z.owner)).multiplyScalar(z.owner ? 0.62 : 0.5).addScalar(0.12);
      }
    }
  }

  const _wind = new THREE.Vector3();

  function updateVisuals(dt) {
    const t = ctx.time?.elapsed ?? 0;
    if (ctx.camera) _cam.copy(ctx.camera.position);
    for (const z of zones) {
      if (z.ring) {
        const u = z.ring.material.uniforms;
        u.uTime.value = t;
        u.uProgress.value = z.progress;
        u.uContest.value += ((z.contested ? 1 : 0) - u.uContest.value) * Math.min(1, dt * 7);
        u.uOwned.value += ((z.owner ? 1 : 0) - u.uOwned.value) * Math.min(1, dt * 4);
        u.uCamera.value.copy(_cam);
        u.uOpacity.value = z.active ? 1 : 0;
      }
      if (z.beam) {
        const u = z.beam.material.uniforms;
        u.uTime.value = t;
        u.uCamera.value.copy(_cam);
        u.uOpacity.value = z.active ? 1 : 0;
      }
      // Banner ripples on the shared wind uniforms — no private wind model.
      if (z.banner && z.bannerGeo) {
        const g = ctx.materials?.globals;
        const strength = clamp(g?.windStrength ?? 0.45, 0.05, 1.4);
        const dir = g?.windDirection;
        _wind.set(dir?.x ?? 1, 0, dir?.z ?? 0);
        const pos = z.bannerGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i) - 0.5;
          const y = pos.getY(i) - 2.95;
          const k = clamp01(x / 0.95);
          const w = Math.sin(t * 3.1 + x * 6.0 + y * 2.0) * 0.06 * k * strength;
          pos.setZ(i, w + Math.sin(t * 1.7 + x * 2.4) * 0.03 * k * strength);
        }
        pos.needsUpdate = true;
        z.banner.rotation.y = Math.atan2(_wind.x, _wind.z) * 0.12 + Math.sin(t * 0.6) * 0.05;
      }
    }
    applyColours(false);
  }

  /* ── hud ────────────────────────────────────────────────────────────────── */

  function hudPayload() {
    return {
      mode: mode?.id || null,
      objective: mode?.objective || null,
      zones: zones.map((z) => ({
        id: z.id,
        label: z.label,
        name: z.name,
        kind: z.kind,
        owner: z.owner,
        capturing: z.capturing,
        progress: Math.round(z.progress * 100) / 100,
        contested: z.contested,
        active: z.active,
        x: z.pos.x,
        z: z.pos.z,
        radius: z.radius,
        occupants: { A: z.occupants.A, B: z.occupants.B },
      })),
      bomb: {
        planted: state.bomb.planted,
        site: state.bomb.site?.label || null,
        timer: Math.max(0, Math.round(state.bomb.timer * 10) / 10),
        plantProgress: Math.round(state.bomb.plantProgress * 100) / 100,
        defuseProgress: Math.round(state.bomb.defuseProgress * 100) / 100,
        carrier: state.bomb.carrier?.name || null,
      },
      hardpoint: {
        name: state.hardpoint.zone?.name || null,
        secondsLeft: Math.max(0, Math.round(state.hardpoint.nextRotate - (ctx.time?.elapsed ?? 0))),
      },
      message: state.message,
    };
  }

  let hudClock = 0;
  function emitHud() {
    ctx.bus?.emit?.('hud:objective', hudPayload());
  }

  /* ── frame ──────────────────────────────────────────────────────────────── */

  function update(dt, roster, live = true) {
    if (!zones.length) return;
    if (!added && ctx.scene) {
      ctx.scene.add(root);
      added = true;
    }
    if (live) {
      tally(roster || []);
      if (mode?.objective === 'domination') {
        for (const z of zones) tickCapture(z, dt);
      } else if (mode?.objective === 'hardpoint') {
        tickHardpoint(dt);
      } else if (mode?.objective === 'bomb') {
        tickBomb(dt);
      }
    }
    if (visible) updateVisuals(dt);
    hudClock += dt;
    if (hudClock >= 0.2) {
      hudClock = 0;
      emitHud();
    }
  }

  return {
    root,
    zones,
    state,
    setMode,
    reset,
    update,
    hudPayload,
    emitHud,
    tryPlant,
    tryDefuse,
    siteFor,
    zoneAt: (id) => zones.find((z) => z.id === id) || null,
    get bombPlanted() {
      return state.bomb.planted;
    },
    get bomb() {
      return state.bomb;
    },
    ownedBy(team) {
      let n = 0;
      for (const z of zones) if (z.owner === team) n++;
      return n;
    },
    setVisible(v) {
      visible = !!v;
      root.visible = !!v;
    },
    setHeadless(v) {
      headless = !!v;
    },
    dispose() {
      clearZones();
      if (added) ctx.scene?.remove?.(root);
      added = false;
    },
  };
}

export default createObjectives;
