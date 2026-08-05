/**
 * Foliage.js — the vegetation layer. Owner: foliage agent.
 * Files owned: this file and src/world/foliage/**.
 * Publishes: `ctx.foliage`.
 *
 * Nothing says "static videogame" louder than a world where nothing moves, so this is
 * as much a *motion* system as a geometry one. Every plant in the map is generated in
 * code at boot — there is not a single leaf texture or tree model in the repo — and
 * every one of them moves, in three superposed frequency bands, off the one shared wind
 * vector in `ctx.materials.globals` so the whole world gusts together.
 *
 * ── Contents ────────────────────────────────────────────────────────────────────
 *   foliage/Atlas.js            GPU-baked leaf + bark PBR atlases (albedo/normal/ORM/mask)
 *   foliage/Builder.js          curved leaf cards and gnarled tubes with wind attributes
 *   foliage/Plants.js           grass, weeds, crack weeds, scrub, ivy, vines, pots
 *   foliage/Trees.js            recursive branching: olive, date palm, cypress
 *   foliage/FoliageMaterial.js  three-band wind, dithered alpha cutout, translucency
 *   foliage/Placement.js        deterministic hashed scatter + physics verification
 *
 * ── Rendering ───────────────────────────────────────────────────────────────────
 * One InstancedMesh per (species, part, LOD). Thousands of plants cost ~20 draw calls.
 * LOD is a *cross-dissolve*, not a switch: both LOD meshes carry the instance for a few
 * metres either side of the boundary and the shader dithers one out as it dithers the
 * other in, so nothing ever pops. Instance re-bucketing only runs when the camera has
 * actually moved, not every frame.
 *
 * ── Physics ─────────────────────────────────────────────────────────────────────
 * Bushes and tree canopies get `surface: 'foliage'` trigger volumes: bullets raycast
 * through them and get leaf-rustle FX and the right penetration behaviour, while the
 * player and the AI walk straight through. Tree *trunks* are solid `wood` capsules —
 * they are real cover.
 *
 * ── Public API (ctx.foliage) ────────────────────────────────────────────────────
 *   ready              boolean
 *   root               THREE.Group in ctx.scene
 *   instances          total placed plants
 *   density            current foliageDensity multiplier
 *   setDensity(v)      runtime thinning, no rebuild
 *   nearest(x, z, r)   -> {x,y,z,species,radius} | null
 *   isFoliage(body)    -> true if a physics body is one of ours
 *   speciesOf(body)    -> species id | null
 *   refresh()          force an LOD re-bucket (the harness calls this after a pose)
 *   stats()            -> { instances, draws, species[], placement, ... }
 *
 * ── Events ──────────────────────────────────────────────────────────────────────
 *   emits  `foliage:ready` { instances, species, draws }
 *   listens `quality:changed`, `setting:changed` (foliageDensity, shadows, taa),
 *           `debug:pose` ({ foliage:false } hides the layer, { wind } sets strength)
 */
import * as THREE from 'three';
import * as LevelData from './LevelData.js';
import { makeRNG } from '../core/RNG.js';
import { buildFoliageAtlas } from './foliage/Atlas.js';
import { FoliageMaterials } from './foliage/FoliageMaterial.js';
import { Placer } from './foliage/Placement.js';
import {
  buildGrassTuft,
  buildWeed,
  buildCrackWeed,
  buildBush,
  buildIvyPatch,
  buildHangVine,
  buildPotShell,
  buildPottedPlant,
} from './foliage/Plants.js';
import { buildOlive, buildPalm, buildCypress } from './foliage/Trees.js';

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const GROUP_WORLD = 1;

const GROUND_SURFACES = new Set(['dirt', 'sand', 'grass']);
const PAVED_SURFACES = new Set(['concrete', 'plaster', 'ceramic']);
const ANY_GROUND = new Set(['dirt', 'sand', 'grass', 'concrete', 'plaster']);

/* ========================================================================== */
/*                              species catalogue                             */
/* ========================================================================== */

/**
 * `wind` is [swayAmp, branchAmp, flutterAmp, timeScale] in metres of tip travel at
 * wind strength 1. `lod` is [switchDistance, cullDistance] in metres.
 */
const SPECIES = [
  {
    id: 'grass',
    kind: 'ground',
    variants: 2,
    build: (rng, lod, v) => buildGrassTuft(rng, { lod, height: v === 0 ? 0.44 : 0.3, blades: v === 0 ? 8 : 6 }),
    wind: [0.10, 0.055, 0.028, 1.45],
    lod: [13, 33],
    scale: [0.62, 1.5],
    height: 0.45,
    tint: [1.02, 0.94, 0.66],
    jitter: 0.26,
    hue: 0.16,
    shadow: false,
  },
  {
    id: 'weed',
    kind: 'ground',
    variants: 1,
    build: (rng, lod) => buildWeed(rng, { lod, height: 0.74 }),
    wind: [0.18, 0.10, 0.038, 1.15],
    lod: [17, 40],
    scale: [0.6, 1.35],
    height: 0.78,
    tint: [1.05, 0.92, 0.58],
    jitter: 0.24,
    hue: 0.2,
    shadow: false,
  },
  {
    id: 'crackweed',
    kind: 'ground',
    variants: 1,
    build: (rng, lod) => buildCrackWeed(rng, { lod, height: 0.17 }),
    wind: [0.05, 0.032, 0.018, 1.7],
    lod: [9, 21],
    scale: [0.6, 1.4],
    height: 0.18,
    tint: [0.86, 0.98, 0.6],
    jitter: 0.22,
    hue: 0.18,
    shadow: false,
  },
  {
    id: 'scrub',
    kind: 'ground',
    variants: 2,
    build: (rng, lod, v) => buildBush(rng, { lod, radius: v === 0 ? 0.58 : 0.42, height: v === 0 ? 0.78 : 0.55 }),
    wind: [0.10, 0.085, 0.032, 1.0],
    lod: [22, 54],
    scale: [0.7, 1.45],
    height: 0.8,
    tint: [0.82, 0.95, 0.62],
    jitter: 0.22,
    hue: 0.2,
    shadow: true,
    collider: { kind: 'sphere', r: 0.55, y: 0.45, surface: 'foliage' },
  },
  {
    id: 'olive',
    kind: 'tree',
    variants: 2,
    build: (rng, lod, v) => buildOlive(rng, { lod, scale: v === 0 ? 1.25 : 1.0 }),
    wind: [0.30, 0.20, 0.060, 0.72],
    lod: [34, 200],
    scale: [0.85, 1.35],
    height: 4.2,
    tint: [0.92, 1.0, 0.82],
    jitter: 0.16,
    hue: 0.1,
    shadow: true,
  },
  {
    id: 'palm',
    kind: 'tree',
    variants: 1,
    build: (rng, lod) => buildPalm(rng, { lod, scale: 1.0 }),
    wind: [0.36, 0.50, 0.090, 0.60],
    lod: [40, 200],
    scale: [0.85, 1.25],
    height: 7.5,
    tint: [0.86, 1.02, 0.6],
    jitter: 0.14,
    hue: 0.1,
    shadow: true,
  },
  {
    id: 'cypress',
    kind: 'tree',
    variants: 1,
    build: (rng, lod) => buildCypress(rng, { lod, scale: 1.0 }),
    wind: [0.17, 0.10, 0.035, 0.82],
    lod: [40, 200],
    scale: [0.8, 1.3],
    height: 8,
    tint: [0.62, 0.86, 0.56],
    jitter: 0.14,
    hue: 0.08,
    shadow: true,
  },
  {
    id: 'ivy',
    kind: 'climb',
    variants: 1,
    build: (rng, lod) => buildIvyPatch(rng, { lod, width: 1.7, height: 2.4 }),
    wind: [0.02, 0.04, 0.04, 1.5],
    lod: [20, 48],
    scale: [0.7, 1.15],
    height: 2.4,
    tint: [0.7, 1.0, 0.6],
    jitter: 0.18,
    hue: 0.14,
    shadow: false,
  },
  {
    id: 'vine',
    kind: 'climb',
    variants: 1,
    build: (rng, lod) => buildHangVine(rng, { lod, length: 1.15 }),
    wind: [0.13, 0.13, 0.05, 1.2],
    lod: [18, 42],
    scale: [0.75, 1.4],
    height: 1.2,
    tint: [0.74, 1.0, 0.58],
    jitter: 0.2,
    hue: 0.14,
    shadow: false,
  },
  {
    id: 'potted',
    kind: 'pot',
    variants: 1,
    build: (rng, lod) => buildPottedPlant(rng, { lod, radius: 0.24, height: 0.34, baseY: 0.25 }),
    buildShell: (rng, lod) => buildPotShell(rng, { lod }),
    wind: [0.03, 0.035, 0.026, 1.35],
    lod: [20, 44],
    scale: [0.85, 1.25],
    height: 0.6,
    tint: [0.72, 1.0, 0.55],
    jitter: 0.24,
    hue: 0.22,
    shadow: true,
    collider: { kind: 'sphere', r: 0.26, y: 0.3, surface: 'ceramic', solid: true },
  },
];

/* ========================================================================== */
/*                              instanced parts                               */
/* ========================================================================== */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _nrm = new THREE.Vector3();

/** One InstancedMesh plus its per-instance wind/tint attributes. */
class Part {
  constructor(geo, mat, capacity, name) {
    const cap = Math.max(1, capacity);
    this.geometry = geo;
    this.material = mat;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (mat?.userData?.folDepth) this.mesh.customDepthMaterial = mat.userData.folDepth;
    this.aInst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aInst.setUsage(THREE.DynamicDrawUsage);
    this.aTint.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aInst', this.aInst);
    geo.setAttribute('aTint', this.aTint);
    const idx = geo.index ? geo.index.count : geo.attributes.position?.count || 0;
    this.tris = Math.round(idx / 3);
  }

  dispose() {
    try {
      this.mesh.dispose?.();
    } catch {
      /* best effort */
    }
    try {
      this.geometry.dispose();
    } catch {
      /* best effort */
    }
  }
}

/** One species+variant: a shared instance list rendered by 1-2 parts at 2 LODs. */
class Variant {
  constructor(def, index) {
    this.def = def;
    this.index = index;
    this.instances = [];
    this.parts = [[], []];
    this.height = def.height;
    this.canopy = null;
    this.trunkR = 0.12;
  }
}

/* ========================================================================== */
/*                                   system                                   */
/* ========================================================================== */

/** @returns {import('../core/types.js').System} */
export default function createFoliage(ctx) {
  const api = {
    ready: false,
    root: null,
    instances: 0,
    density: 1,
    setDensity: () => 0,
    nearest: () => null,
    isFoliage: () => false,
    speciesOf: () => null,
    refresh: () => {},
    stats: () => ({ instances: 0, draws: 0, species: [], placement: null }),
  };
  ctx.foliage = api;

  const root = new THREE.Group();
  root.name = 'foliage';

  /** @type {Variant[]} */
  const variants = [];
  /** @type {Map<string, Variant[]>} */
  const bySpecies = new Map();
  const bodies = [];
  const bodySpecies = new WeakMap();
  const unsub = [];
  let atlas = null;
  let mats = null;
  let placer = null;
  let buildMs = 0;
  let placeMs = 0;
  let densityScale = 1;
  const lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  let needRepack = true;
  let visibleDraws = 0;
  let disposed = false;

  const warn = (msg, err) => {
    if (!ctx.settings?.get?.('headless') || err) console.warn(`[foliage] ${msg}`, err || '');
  };

  /* ------------------------------------------------------------ placement */

  function levelRects() {
    const roads = [];
    const footprints = [];
    const voids = [];
    try {
      for (const g of LevelData.GROUND || []) {
        if (g?.key === 'road' && Array.isArray(g.rect)) roads.push(g.rect);
      }
      for (const b of LevelData.BUILDINGS || []) {
        if (Array.isArray(b?.rect)) footprints.push(b.rect);
      }
      for (const v of LevelData.GROUND_VOIDS || []) {
        if (Array.isArray(v?.rect)) voids.push(v.rect);
      }
      const c = LevelData.CHANNEL;
      if (c) voids.push([c.x0 - (c.wallThick || 0.5), c.z0, c.x1 + (c.wallThick || 0.5), c.z1]);
    } catch (err) {
      warn('level data unavailable, placing on physics alone', err);
    }
    return { roads, footprints, voids };
  }

  function makeBounds() {
    const b = ctx.level?.bounds;
    if (b?.min && b?.max && Number.isFinite(b.min.x)) {
      return { minX: b.min.x + 1, maxX: b.max.x - 1, minZ: b.min.z + 1, maxZ: b.max.z - 1 };
    }
    const L = LevelData.BOUNDS;
    if (L) {
      return {
        minX: L.playMinX ?? -50,
        maxX: L.playMaxX ?? 50,
        minZ: L.playMinZ ?? -48,
        maxZ: L.playMaxZ ?? 58,
      };
    }
    return { minX: -50, maxX: 50, minZ: -48, maxZ: 58 };
  }

  /** Horizontal clearance for a tree crown: four rays at chest height of the canopy. */
  function crownClear(x, y, z, radius) {
    const phys = ctx.physics;
    if (!phys?.raycast) return true;
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    o.set(x, y + 2.2, z);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      d.set(Math.cos(a), 0, Math.sin(a));
      if (phys.raycast(o, d, radius, GROUP_WORLD)) return false;
    }
    return true;
  }

  function placeAll(density) {
    const out = new Map();
    const push = (id, list) => out.set(id, (out.get(id) || []).concat(list));
    const cap = Math.min(1.4, density + 0.2);

    /* ── ground cover in patches over unmade ground ───────────────────── */
    push(
      'grass',
      placer.patches({
        salt: 11,
        patch: 6.5,
        patchProb: 0.44,
        perPatch: 18,
        density: density * 1.15,
        surfaces: GROUND_SURFACES,
        headroom: 3.0,
        propRadius: 0.3,
        limit: Math.round(1800 * cap),
      })
    );
    /* ── a thinner, taller layer of dry weeds over the same ground ────── */
    push(
      'weed',
      placer.patches({
        salt: 29,
        patch: 9,
        patchProb: 0.3,
        perPatch: 9,
        density: density * 0.75,
        surfaces: GROUND_SURFACES,
        headroom: 3.0,
        propRadius: 0.35,
        limit: Math.round(420 * cap),
      })
    );
    /* ── the base of every wall: where a broom never reaches ──────────── */
    push(
      'grass',
      placer.wallBases({
        salt: 47,
        step: 0.82,
        offset: 0.24,
        jitter: 0.2,
        density: density * 1.1,
        surfaces: ANY_GROUND,
        headroom: 2.6,
        propRadius: 0.3,
        limit: Math.round(420 * cap),
      })
    );
    push(
      'weed',
      placer.wallBases({
        salt: 53,
        step: 1.9,
        offset: 0.3,
        jitter: 0.25,
        density: density * 0.6,
        surfaces: ANY_GROUND,
        headroom: 2.6,
        propRadius: 0.35,
        limit: Math.round(170 * cap),
      })
    );
    /* ── weeds pushing through the kerb seam ──────────────────────────── */
    push(
      'crackweed',
      placer.cracks({
        salt: 71,
        step: 1.15,
        density,
        surfaces: PAVED_SURFACES,
        headroom: 2.6,
        propRadius: 0.25,
        limit: Math.round(560 * cap),
      })
    );
    /* ── scrub in neglected corners and open yards ────────────────────── */
    push(
      'scrub',
      Placer.spaceOut(
        placer
          .patches({
            salt: 97,
            patch: 11,
            patchProb: 0.34,
            perPatch: 4,
            density: density * 0.8,
            surfaces: GROUND_SURFACES,
            headroom: 3.2,
            propRadius: 0.65,
            limit: 160,
          })
          .concat(
            placer.wallBases({
              salt: 101,
              step: 3.4,
              offset: 0.55,
              jitter: 0.3,
              density: density * 0.5,
              surfaces: ANY_GROUND,
              headroom: 3.0,
              propRadius: 0.7,
              limit: 90,
            })
          ),
        1.5
      )
    );

    /* ── trees ────────────────────────────────────────────────────────── */
    const treeSpots = Placer.spaceOut(
      placer.patches({
        salt: 211,
        patch: 9,
        patchProb: 0.62,
        perPatch: 3,
        density: Math.min(1, density) * 0.9,
        surfaces: ANY_GROUND,
        headroom: 7.5,
        propRadius: 1.0,
        maxSlope: 0.86,
        roadMargin: -0.6,
        limit: 170,
      }),
      6.5
    );
    const olives = [];
    const palms = [];
    const cypresses = [];
    for (const c of treeSpots) {
      const pick = c.r[2];
      // Palms line the paved streets and the plaza; olives take the unmade ground;
      // cypresses mark the boundaries.
      const paved = PAVED_SURFACES.has(c.surface);
      // A palm's crown is above every roof on this map, so only the trunk needs room;
      // an olive's canopy sits at 2-4 m and genuinely has to fit.
      if (paved ? pick < 0.55 : pick < 0.18) {
        if (crownClear(c.x, c.y, c.z, 1.3)) palms.push(c);
      } else if (pick < 0.72) {
        if (crownClear(c.x, c.y, c.z, 1.9)) olives.push(c);
      } else if (crownClear(c.x, c.y, c.z, 0.9)) {
        // A cypress is a 0.8 m wide column, so it fits where nothing else does — it is
        // the fallback, not the leftover.
        cypresses.push(c);
      }
    }
    push('olive', olives);
    push('palm', palms);
    push('cypress', cypresses);

    /* ── ivy climbing the walls ───────────────────────────────────────── */
    push(
      'ivy',
      Placer.spaceOut(
        placer.wallBases({
          salt: 307,
          step: 1.5,
          offset: 0.09,
          jitter: 0.04,
          density: Math.min(1.1, density) * 0.55,
          surfaces: ANY_GROUND,
          headroom: 2.4,
          propRadius: 0.3,
          limit: 90,
          accept: (c) => {
            // Only where the wall is actually tall enough to be worth climbing.
            const phys = ctx.physics;
            if (!phys?.raycast || !c.wall) return true;
            const o = new THREE.Vector3(c.x + c.wall.nx * 0.6, c.y + 2.3, c.z + c.wall.nz * 0.6);
            const d = new THREE.Vector3(-c.wall.nx, 0, -c.wall.nz);
            return !!phys.raycast(o, d, 1.1, GROUP_WORLD);
          },
        }),
        1.3
      )
    );

    /* ── hanging vines over copings, arches and planter rims ──────────── */
    push('vine', vineSpots(density));

    /* ── potted plants against shopfronts and on planters ─────────────── */
    push(
      'potted',
      Placer.spaceOut(
        placer
          .wallBases({
            salt: 401,
            step: 2.6,
            offset: 0.34,
            jitter: 0.12,
            density: Math.min(1, density) * 0.45,
            surfaces: PAVED_SURFACES,
            headroom: 2.4,
            propRadius: 0,
            limit: 40,
          })
          .concat(planterSpots()),
        0.9
      )
    );

    return out;
  }

  function vineSpots(density) {
    const list = [];
    const rng = makeRNG(0x51de51de);
    const c = LevelData.CHANNEL;
    if (c) {
      const n = Math.max(2, Math.round(((c.z1 - c.z0) / 5.5) * Math.min(1, density)));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const z = c.z0 + (c.z1 - c.z0) * t;
        if (rng() > 0.55) continue;
        for (let side = 0; side < 2; side++) {
          if (rng() > 0.6) continue;
          const nx = side === 0 ? -1 : 1;
          list.push({
            x: side === 0 ? c.x0 - 0.14 : c.x1 + 0.14,
            y: (c.topY ?? 0) - 0.05,
            z,
            nx: 0,
            ny: 1,
            nz: 0,
            surface: 'concrete',
            r: [rng(), rng(), rng()],
            lush: 1,
            yaw: Math.atan2(nx, 0),
          });
        }
      }
    }
    for (const a of LevelData.ARCHWAYS || []) {
      const w = (a.w ?? 4) * 0.5;
      const dx = Math.cos(a.yaw ?? 0);
      const dz = Math.sin(a.yaw ?? 0);
      for (let s = -1; s <= 1; s += 2) {
        for (let k = 0; k < 2; k++) {
          const off = w * s * (0.5 + k * 0.3);
          list.push({
            x: a.x + dx * off,
            y: (a.h ?? 4.2) - 0.14,
            z: a.z + dz * off,
            nx: 0,
            ny: 1,
            nz: 0,
            surface: 'plaster',
            r: [rng(), rng(), rng()],
            lush: 1,
            yaw: (a.yaw ?? 0) + s * 0.4,
          });
        }
      }
    }
    for (const p of planterRims()) list.push(p);

    // An anchor with nothing solid above it would leave a vine hanging in mid-air.
    const phys = ctx.physics;
    if (!phys?.raycast) return list;
    const o = new THREE.Vector3();
    const d = new THREE.Vector3(0, -1, 0);
    return list.filter((v) => {
      o.set(v.x, v.y + 0.5, v.z);
      return !!phys.raycast(o, d, 0.85, GROUP_WORLD);
    });
  }

  function planterRims() {
    const out = [];
    const rng = makeRNG(0x7a11ce7);
    for (const c of LevelData.COVER || []) {
      if (c?.kind !== 'planter') continue;
      const sx = (c.sx ?? 1.4) * 0.5;
      const sz = (c.sz ?? 2.8) * 0.5;
      const y = c.y !== undefined ? c.y : (ctx.level?.groundY?.(c.x, c.z) ?? 0) + 0.55;
      for (let i = 0; i < 2; i++) {
        const along = (rng() - 0.5) * 1.7;
        const side = rng() < 0.5 ? -1 : 1;
        const useX = sx > sz;
        out.push({
          x: c.x + (useX ? along * sx : side * sx),
          y: y - 0.03,
          z: c.z + (useX ? side * sz : along * sz),
          nx: 0,
          ny: 1,
          nz: 0,
          surface: 'concrete',
          r: [rng(), rng(), rng()],
          lush: 1,
          yaw: rng() * TAU,
        });
      }
    }
    return out;
  }

  function planterSpots() {
    const out = [];
    const rng = makeRNG(0x9a5e77);
    for (const c of LevelData.COVER || []) {
      if (c?.kind !== 'planter') continue;
      const cand = placer.probe(c.x + (rng() - 0.5) * 0.4, c.z + (rng() - 0.5) * 0.4, {
        headroom: 2.2,
        propRadius: 0,
        allowElevated: true,
      });
      if (!cand) continue;
      cand.r = [rng(), rng(), rng()];
      cand.lush = 1;
      out.push(cand);
    }
    return out;
  }

  /* ------------------------------------------------------------- assembly */

  function fadeFor(def, lod) {
    const near = def.lod[0];
    const far = def.lod[1];
    if (lod === 0) return [-2, -1, near - 2.5, near + 2.5];
    return [near - 2.5, near + 2.5, Math.max(near + 6, far - 9), far];
  }

  function buildSpecies(def, seedBase) {
    const list = [];
    for (let v = 0; v < (def.variants || 1); v++) {
      const variant = new Variant(def, v);
      list.push(variant);
      variants.push(variant);
    }
    bySpecies.set(def.id, list);

    for (let v = 0; v < list.length; v++) {
      const variant = list[v];
      for (let lod = 0; lod < 2; lod++) {
        // One independently seeded stream per (species, variant) — deliberately NOT
        // per LOD, so both LODs draw the same structure and the cross-dissolve has
        // nothing to give away. Independent per species so adding one never reshuffles
        // the shape of the others.
        const rng = makeRNG((seedBase + v * 7919 + def.id.charCodeAt(0) * 31 + def.id.length * 2749) >>> 0);
        const fade = fadeFor(def, lod);
        try {
          if (def.kind === 'tree') {
            const tree = def.build(rng, lod, v);
            if (lod === 0) {
              variant.height = tree.height;
              variant.canopy = tree.canopy;
              variant.trunkR = tree.trunkR;
            }
            if (tree.wood) {
              variant.parts[lod].push(
                new Part(tree.wood, mats.wood(`${def.id}:${lod}`, def.wind, fade), 1, `${def.id}${v}_wood_l${lod}`)
              );
            }
            if (tree.leaves) {
              variant.parts[lod].push(
                new Part(tree.leaves, mats.leaf(`${def.id}:${lod}`, def.wind, fade), 1, `${def.id}${v}_leaf_l${lod}`)
              );
            }
          } else {
            if (def.buildShell) {
              const shell = def.buildShell(rng, lod, v);
              variant.parts[lod].push(new Part(shell, mats.pot(), 1, `${def.id}${v}_pot_l${lod}`));
            }
            const geo = def.build(rng, lod, v);
            variant.parts[lod].push(
              new Part(geo, mats.leaf(`${def.id}:${lod}`, def.wind, fade), 1, `${def.id}${v}_l${lod}`)
            );
          }
        } catch (err) {
          warn(`geometry for ${def.id} lod${lod} failed`, err);
        }
      }
    }
    return list;
  }

  /**
   * InstancedMesh capacity is fixed at construction, so the meshes are rebuilt once the
   * instance lists are known rather than guessing high and wasting the buffers.
   */
  function sizeMeshes() {
    const shadows = !!ctx.settings?.get?.('shadows');
    for (const variant of variants) {
      const cap = Math.max(1, variant.instances.length);
      for (let lod = 0; lod < 2; lod++) {
        const parts = variant.parts[lod];
        for (let i = 0; i < parts.length; i++) {
          const old = parts[i];
          const part = new Part(old.geometry, old.material, cap, old.mesh.name);
          part.mesh.castShadow = !!variant.def.shadow && shadows && lod === 0;
          part.mesh.receiveShadow = true;
          part.mesh.userData.foliage = variant.def.id;
          parts[i] = part;
          root.add(part.mesh);
          try {
            old.mesh.dispose?.(); // the geometry is handed on to the replacement
          } catch {
            /* best effort */
          }
        }
      }
    }
  }

  function tintFor(def, r, r2) {
    const base = def.tint;
    const j = def.jitter ?? 0.2;
    const hue = def.hue ?? 0.15;
    // Value jitter plus a small green -> straw hue shift, so a bank of one species
    // never reads as a single flat colour.
    const val = 1 - j * 0.5 + r * j;
    const dry = r2 * hue;
    return [base[0] * val * (1 + dry * 0.8), base[1] * val * (1 - dry * 0.15), base[2] * val * (1 - dry * 0.55)];
  }

  function fillInstances(placed) {
    let total = 0;
    for (const def of SPECIES) {
      const list = bySpecies.get(def.id);
      if (!list || !list.length) continue;
      const cands = placed.get(def.id) || [];
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const v = list.length > 1 ? Math.min(list.length - 1, Math.floor(c.r[0] * list.length)) : 0;
        const variant = list[v];
        const scale = def.scale[0] + (def.scale[1] - def.scale[0]) * (0.35 * c.r[1] + 0.65 * c.r[2]);
        const height = (variant.height || def.height || 1) * scale;
        // Climbers take their orientation from the wall; everything else is free to
        // spin, and a bank of wall-base grass all facing the same way reads as decals.
        const yaw =
          c.yaw !== undefined
            ? c.yaw
            : def.kind === 'climb' && c.wall
              ? Math.atan2(c.wall.nx, c.wall.nz)
              : c.r[1] * TAU;
        // Sink the base a little so no plant ever reads as floating on uneven ground.
        const sink = def.kind === 'tree' ? 0.05 : def.kind === 'ground' ? 0.025 * scale : 0;
        variant.instances.push({
          x: c.x,
          y: c.y - sink,
          z: c.z,
          nx: c.nx,
          ny: c.ny,
          nz: c.nz,
          yaw,
          scale,
          stretch: 0.86 + c.r[0] * 0.32,
          height,
          phase: c.r[2],
          amp: scale * (0.8 + c.r[1] * 0.45),
          // Arc constraint: y drop per metre² of lateral swing for a plant this tall.
          droop: Math.min(2.2, Math.max(0.05, 1 / (2 * Math.max(0.22, height)))),
          tint: tintFor(def, c.r[0], c.r[1]),
          thin: c.r[2] * 0.999,
          surface: c.surface,
        });
        total++;
      }
    }
    return total;
  }

  /* -------------------------------------------------------------- physics */

  function addColliders() {
    const phys = ctx.physics;
    if (!phys?.addStatic) return;
    for (const variant of variants) {
      const def = variant.def;
      for (const inst of variant.instances) {
        try {
          if (def.kind === 'tree') {
            const h = Math.min(3.2, (variant.height || 4) * inst.scale * 0.62);
            const r = Math.max(0.08, (variant.trunkR || 0.15) * inst.scale * 1.15);
            const trunk = phys.addStatic({
              type: 'capsule',
              radius: r,
              height: Math.max(h, r * 2.2),
              pos: { x: inst.x, y: inst.y + h * 0.5, z: inst.z },
              surface: 'wood',
              group: GROUP_WORLD,
            });
            if (trunk) {
              bodies.push(trunk);
              bodySpecies.set(trunk, def.id);
            }
            if (variant.canopy) {
              // Trigger volume: bullets see 'foliage' and pass through with leaf FX,
              // bodies never collide with it.
              const leaf = phys.addStatic({
                type: 'sphere',
                radius: Math.max(0.4, variant.canopy.r * inst.scale * 1.15),
                pos: { x: inst.x, y: inst.y + variant.canopy.y * inst.scale, z: inst.z },
                surface: 'foliage',
                group: GROUP_WORLD,
                mask: 0,
                trigger: true,
              });
              if (leaf) {
                bodies.push(leaf);
                bodySpecies.set(leaf, def.id);
              }
            }
          } else if (def.collider) {
            const col = def.collider;
            const body = phys.addStatic({
              type: col.kind || 'sphere',
              radius: (col.r ?? 0.4) * inst.scale,
              pos: { x: inst.x, y: inst.y + (col.y ?? 0.3) * inst.scale, z: inst.z },
              surface: col.surface || 'foliage',
              group: GROUP_WORLD,
              mask: col.solid ? undefined : 0,
              trigger: !col.solid,
            });
            if (body) {
              bodies.push(body);
              bodySpecies.set(body, def.id);
            }
          }
        } catch (err) {
          warn('collider rejected', err);
        }
      }
    }
  }

  /* --------------------------------------------------------------- packing */

  function composeMatrix(def, inst, out) {
    _nrm.set(inst.nx, inst.ny, inst.nz);
    if (_nrm.lengthSq() < 1e-6) _nrm.copy(UP);
    else _nrm.normalize();
    // Ground cover hugs the slope; trees grow towards the sky whatever the slope does;
    // climbers take their orientation from the wall instead.
    const align = def.kind === 'tree' ? 0.22 : def.kind === 'ground' ? 0.85 : 0;
    if (align > 0 && _nrm.y < 0.9995) {
      _nrm.lerp(UP, 1 - align).normalize();
      _q.setFromUnitVectors(UP, _nrm);
    } else {
      _q.identity();
    }
    _qy.setFromAxisAngle(UP, inst.yaw);
    _q.multiply(_qy);
    _p.set(inst.x, inst.y, inst.z);
    _s.set(inst.scale, inst.scale * inst.stretch, inst.scale);
    out.compose(_p, _q, _s);
  }

  function writeSlot(parts, k, inst, matrix) {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      matrix.toArray(part.mesh.instanceMatrix.array, k * 16);
      const a = part.aInst.array;
      a[k * 4] = inst.phase;
      a[k * 4 + 1] = inst.amp;
      a[k * 4 + 2] = inst.droop;
      a[k * 4 + 3] = inst.thin;
      const t = part.aTint.array;
      t[k * 3] = inst.tint[0];
      t[k * 3 + 1] = inst.tint[1];
      t[k * 3 + 2] = inst.tint[2];
    }
  }

  function writeBucket(def, parts, list) {
    if (!parts.length) return;
    const n = Math.min(list.length, parts[0].mesh.instanceMatrix.count);
    for (let k = 0; k < n; k++) {
      composeMatrix(def, list[k], _m);
      writeSlot(parts, k, list[k], _m);
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      part.mesh.count = n;
      part.mesh.visible = n > 0;
      if (n === 0) continue;
      part.mesh.instanceMatrix.needsUpdate = true;
      part.aInst.needsUpdate = true;
      part.aTint.needsUpdate = true;
      try {
        part.mesh.computeBoundingSphere();
        // The wind pushes vertices past the static bounds; without the pad, plants at
        // the edge of frame get culled mid-gust.
        if (part.mesh.boundingSphere) part.mesh.boundingSphere.radius += 0.7;
      } catch {
        part.mesh.frustumCulled = false;
      }
      visibleDraws++;
    }
  }

  function repack(camPos) {
    visibleDraws = 0;
    for (const variant of variants) {
      const def = variant.def;
      const near = def.lod[0];
      const far = def.lod[1];
      const n0 = [];
      const n1 = [];
      const list = variant.instances;
      for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        if (inst.thin > densityScale) continue;
        const dx = inst.x - camPos.x;
        const dy = inst.y + inst.height * 0.5 - camPos.y;
        const dz = inst.z - camPos.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > far + 2) continue;
        if (d < near + 4) n0.push(inst);
        if (d > near - 4) n1.push(inst);
      }
      writeBucket(def, variant.parts[0], n0);
      writeBucket(def, variant.parts[1], n1);
    }
  }

  function applyShadowSetting() {
    const shadows = !!ctx.settings?.get?.('shadows');
    for (const variant of variants) {
      for (const part of variant.parts[0]) part.mesh.castShadow = !!variant.def.shadow && shadows;
    }
  }

  /* ------------------------------------------------------------------ init */

  return {
    name: 'foliage',
    order: 36,

    async init() {
      ctx.foliage = api;
      await yieldToBrowser();
      const t0 = now();
      try {
        atlas = buildFoliageAtlas(ctx, {});
      } catch (err) {
        warn('atlas bake unavailable', err);
        atlas = null;
      }
      try {
        mats = new FoliageMaterials(ctx, atlas);
      } catch (err) {
        warn('materials unavailable, foliage disabled', err);
        return;
      }

      const seedBase = Math.floor((ctx.rng?.() ?? 0.5) * 0x7fffffff) >>> 0;
      for (const def of SPECIES) {
        try {
          buildSpecies(def, seedBase);
        } catch (err) {
          warn(`species ${def.id} failed to build`, err);
        }
      }
      buildMs = now() - t0;
      await yieldToBrowser();

      const t1 = now();
      const rects = levelRects();
      placer = new Placer(ctx, {
        bounds: makeBounds(),
        roads: rects.roads,
        footprints: rects.footprints,
        voids: rects.voids,
      });
      densityScale = clamp(ctx.settings?.get?.('foliageDensity') ?? 1, 0, 2);
      let placed = new Map();
      try {
        // Generate at >= 1 and thin at runtime, so raising the quality tier later never
        // needs a rebuild and lowering it only removes plants, never moves them.
        placed = placeAll(Math.max(densityScale, 1));
      } catch (err) {
        warn('placement failed', err);
      }
      try {
        api.instances = fillInstances(placed);
      } catch (err) {
        warn('instancing failed', err);
      }
      placeMs = now() - t1;

      sizeMeshes();
      ctx.scene?.add(root);
      try {
        addColliders();
      } catch (err) {
        warn('collider pass failed', err);
      }

      try {
        repack(ctx.camera?.position || new THREE.Vector3());
      } catch (err) {
        warn('initial pack failed', err);
      }
      needRepack = true;

      /* -------------------------------------------------------- reactions */
      const bus = ctx.bus;
      if (bus?.on) {
        unsub.push(
          bus.on('quality:changed', () => {
            densityScale = clamp(ctx.settings?.get?.('foliageDensity') ?? 1, 0, 2);
            api.density = densityScale;
            try {
              mats?.onQualityChanged();
            } catch (err) {
              warn('quality re-apply failed', err);
            }
            applyShadowSetting();
            needRepack = true;
          })
        );
        unsub.push(
          bus.on('setting:changed', ({ key }) => {
            if (key === 'foliageDensity') {
              densityScale = clamp(ctx.settings?.get?.('foliageDensity') ?? 1, 0, 2);
              api.density = densityScale;
              needRepack = true;
            } else if (key === 'taa') {
              mats?.onQualityChanged();
            } else if (key === 'shadows') {
              applyShadowSetting();
            }
          })
        );
        unsub.push(
          bus.on('debug:pose', (state) => {
            if (!state) return;
            if (state.foliage !== undefined) root.visible = !!state.foliage;
            if (Number.isFinite(state.wind)) ctx.materials?.setWind?.(undefined, state.wind);
            needRepack = true;
          })
        );
      }

      api.ready = true;
      api.density = densityScale;
      api.root = root;
      api.setDensity = (v) => {
        densityScale = clamp(Number(v) || 0, 0, 2);
        api.density = densityScale;
        needRepack = true;
        return densityScale;
      };
      api.refresh = () => {
        needRepack = true;
      };
      api.isFoliage = (body) => !!body && bodySpecies.has(body);
      api.speciesOf = (body) => (body ? bodySpecies.get(body) || null : null);
      api.nearest = (x, z, radius = 3) => {
        let best = null;
        let bd = radius * radius;
        for (const variant of variants) {
          for (const inst of variant.instances) {
            const dx = inst.x - x;
            const dz = inst.z - z;
            const d = dx * dx + dz * dz;
            if (d >= bd) continue;
            bd = d;
            best = { x: inst.x, y: inst.y, z: inst.z, species: variant.def.id, radius: inst.height * 0.4 };
          }
        }
        return best;
      };
      api.stats = () => ({
        instances: api.instances,
        draws: visibleDraws,
        density: densityScale,
        buildMs: Math.round(buildMs),
        placeMs: Math.round(placeMs),
        atlas: atlas?.ok ? atlas.res : 0,
        colliders: bodies.length,
        species: variants.map((v) => ({
          id: v.def.id,
          variant: v.index,
          instances: v.instances.length,
          tris: v.parts[0].reduce((a, p) => a + p.tris, 0),
        })),
        placement: placer ? placer.stats : null,
      });

      ctx.bus?.emit?.('foliage:ready', {
        instances: api.instances,
        species: variants.length,
        draws: visibleDraws,
      });
      if (!ctx.settings?.get?.('headless')) {
        console.log(
          `[foliage] ${api.instances} plants / ${variants.length} variants / ` +
            `atlas ${atlas?.res || 0}px / build ${Math.round(buildMs)}ms / place ${Math.round(placeMs)}ms`
        );
      }
    },

    update() {
      if (!api.ready) return;
      mats?.tick(ctx.time?.elapsed ?? 0);
    },

    lateUpdate() {
      if (!api.ready || disposed) return;
      const cam = ctx.camera?.position;
      if (!cam) return;
      // Re-bucketing is O(instances); it only has to happen when the camera has
      // actually travelled, not on every frame.
      if (!needRepack && lastCam.distanceToSquared(cam) < 4) return;
      needRepack = false;
      lastCam.copy(cam);
      try {
        repack(cam);
      } catch (err) {
        warn('repack failed', err);
      }
    },

    dispose() {
      disposed = true;
      for (const off of unsub) {
        try {
          off?.();
        } catch {
          /* best effort */
        }
      }
      unsub.length = 0;
      for (const b of bodies) {
        try {
          ctx.physics?.removeBody?.(b);
        } catch {
          /* best effort */
        }
      }
      bodies.length = 0;
      for (const variant of variants) {
        for (let lod = 0; lod < 2; lod++) for (const part of variant.parts[lod]) part.dispose();
      }
      variants.length = 0;
      bySpecies.clear();
      root.clear();
      ctx.scene?.remove(root);
      try {
        mats?.dispose();
      } catch {
        /* best effort */
      }
      try {
        atlas?.dispose?.();
      } catch {
        /* best effort */
      }
      api.ready = false;
      if (ctx.foliage === api) ctx.foliage = null;
    },
  };
}

/* ------------------------------------------------------------------ utils */

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/**
 * Hand the event loop back for one task.
 *
 * `Engine.boot()` awaits every `init()` in turn, but an `init()` that never awaits a
 * *macrotask* stays inside the microtask queue — which the browser drains before it
 * fires DOMContentLoaded. The whole boot then blocks `page.goto()` in the screenshot
 * harness. One `setTimeout` here lets the document finish loading before the back half
 * of the manifest runs, and costs a single frame.
 */
function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
