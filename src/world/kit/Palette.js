/**
 * kit/Palette.js — the level's material vocabulary. Owner: level agent.
 *
 * Every batch in the map names a palette key, never a `ctx.materials` recipe directly.
 * That buys three things:
 *   1. **Variety with one program.** Two buildings can be `wall.sand` and `wall.ochre`
 *      — different `THREE.Material` instances with different tints and grime levels,
 *      but the same shader defines, so three compiles the program once. Shader compiles
 *      are ~1.5 s each under the CI's software rasteriser, so this matters a lot.
 *   2. **Trim-sheet banding.** Ground-level splash-back, mid-wall and roofline bands
 *      are separate keys, so a facade always has three material zones.
 *   3. A single place to add the vertex-AO shader hook (see VertexAO.js) to every
 *      material the level owns without touching anyone else's cached materials.
 *
 * Keys are `family.variant`. Unknown keys fall back to `struct.concrete` and log
 * nothing — a typo must never blank the level.
 */
import * as THREE from 'three';
import { attachVertexAO } from './VertexAO.js';

/**
 * spec: { m: recipe name, o: get() opts, tint: hex, k: extra clone() overrides }
 * `tint` is applied through clone() so the cached program is shared.
 */
export const PALETTE = {
  /* ── render/structural concrete ─────────────────────────────────────── */
  'struct.concrete': { m: 'concrete_cast', o: { vertexColors: true, grime: 0.85 } },
  'struct.concreteClean': { m: 'concrete_cast', o: { vertexColors: true, grime: 0.35 }, tint: 0xb8b3a8 },
  'struct.panel': { m: 'concrete_precast_panel', o: { vertexColors: true, grime: 0.9 } },
  'struct.panelPale': { m: 'concrete_precast_panel', o: { vertexColors: true, grime: 0.6 }, tint: 0xc4bfb2 },

  /* ── plaster / stucco facades — the Mediterranean colour story ──────── */
  'wall.sand': { m: 'stucco', o: { vertexColors: true, grime: 1.05 }, tint: 0xd8c39a },
  'wall.ochre': { m: 'stucco', o: { vertexColors: true, grime: 1.15 }, tint: 0xc08a4e },
  'wall.bone': { m: 'stucco', o: { vertexColors: true, grime: 0.9 }, tint: 0xe0dbc9 },
  'wall.terracotta': { m: 'stucco', o: { vertexColors: true, grime: 1.2 }, tint: 0xa8613f },
  'wall.blue': { m: 'plaster_cracked', o: { vertexColors: true, grime: 1.1 }, tint: 0x7f95a3 },
  'wall.green': { m: 'plaster_cracked', o: { vertexColors: true, grime: 1.25 }, tint: 0x8a9878 },
  'wall.white': { m: 'plaster_cracked', o: { vertexColors: true, grime: 1.0 }, tint: 0xd9d5c8 },
  'wall.pink': { m: 'plaster_cracked', o: { vertexColors: true, grime: 1.3 }, tint: 0xc4a08e },

  /* ── masonry ────────────────────────────────────────────────────────── */
  'brick.red': { m: 'brick_red', o: { vertexColors: true, grime: 1.0 } },
  'brick.buff': { m: 'brick_red', o: { vertexColors: true, grime: 1.1 }, tint: 0xb99b74 },
  'brick.painted': { m: 'brick_painted', o: { vertexColors: true, grime: 1.15 }, tint: 0xcfc6b0 },
  'brick.paintedBlue': { m: 'brick_painted', o: { vertexColors: true, grime: 1.2 }, tint: 0x8fa2ab },

  /* ── ground ─────────────────────────────────────────────────────────── */
  /* Made ground blends a second material through the vertex-colour green channel:
     asphalt breaking back to its aggregate base, paving silted over with dirt. The
     blend is height-aware, so it fills the joints and the low spots first — which is
     what stops 100 x 100 m of road reading as one tiled texture. */
  'ground.road': {
    m: 'asphalt',
    o: {
      vertexColors: true,
      grime: 0.7,
      puddleLevel: 0.5,
      layer: 'gravel',
      layerAmount: 0.0,
      layerCavityBias: 0.85,
      layerContrast: 1.9,
      layerRepeat: 1.35,
    },
  },
  'ground.pave': {
    m: 'sidewalk_paving',
    o: {
      vertexColors: true,
      grime: 0.9,
      puddleLevel: 0.45,
      layer: 'dirt_packed',
      layerAmount: 0.0,
      layerCavityBias: 0.9,
      layerContrast: 1.7,
    },
  },
  'ground.dirt': {
    m: 'dirt_packed',
    o: { vertexColors: true, layer: 'sand', layerAmount: 0.0, layerCavityBias: 0.0, grime: 0.5, puddleLevel: 0.55 },
  },
  'ground.gravel': { m: 'gravel', o: { vertexColors: true, grime: 0.6 } },
  'ground.rubble': { m: 'rubble', o: { vertexColors: true, grime: 1.0 } },

  /* ── roofs ──────────────────────────────────────────────────────────── */
  'roof.shingle': { m: 'roof_shingle', o: { vertexColors: true, grime: 1.0 } },
  'roof.corrugated': { m: 'corrugated_metal', o: { vertexColors: true, grime: 1.1 } },
  'roof.corrugatedRust': { m: 'corrugated_metal', o: { vertexColors: true, grime: 1.35 }, tint: 0x9c7a5e },

  /* ── metal ──────────────────────────────────────────────────────────── */
  'metal.rust': { m: 'rusted_steel', o: { vertexColors: true, grime: 1.1 } },
  'metal.galv': { m: 'galvanised_metal', o: { vertexColors: true, grime: 0.85 } },
  'metal.paintBlue': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 1.0 }, tint: 0x5f7e8c },
  'metal.paintRed': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 1.1 }, tint: 0x9c4a38 },
  'metal.paintGreen': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 1.05 }, tint: 0x53664a },
  'metal.paintCream': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 0.95 }, tint: 0xc3bda6 },

  /* ── timber ─────────────────────────────────────────────────────────── */
  'wood.weathered': { m: 'wood_plank_weathered', o: { vertexColors: true, grime: 1.05 } },
  'wood.painted': { m: 'plywood_painted', o: { vertexColors: true, grime: 1.0 }, tint: 0x6d7f6a },
  'wood.paintedBlue': { m: 'plywood_painted', o: { vertexColors: true, grime: 1.05 }, tint: 0x4a6272 },
  'wood.ply': { m: 'wood_ply', o: { vertexColors: true, grime: 1.2 } },

  /* ── glass & fabric ─────────────────────────────────────────────────── */
  'glass.window': { m: 'glass_dirty', o: { side: 'double' } },
  'glass.shop': { m: 'glass_dirty', o: { side: 'double', variant: 'shop' }, tint: 0xa8b2ae },
  'fabric.awning': { m: 'tarp', o: { side: 'double', vertexColors: true, grime: 1.0 }, tint: 0xa8564a },
  'fabric.awning2': { m: 'tarp', o: { side: 'double', vertexColors: true, grime: 1.0 }, tint: 0x4a6a86 },
  'fabric.canvas': { m: 'fabric_canvas', o: { side: 'double', vertexColors: true, grime: 1.1 }, tint: 0xbcb096 },

  /* ── interior ───────────────────────────────────────────────────────── */
  'int.tile': { m: 'ceramic_tile', o: { vertexColors: true, grime: 1.0 } },
  'int.plaster': { m: 'plaster_cracked', o: { vertexColors: true, grime: 0.85 }, tint: 0xcfc8b6 },

  /* ── water & signage ────────────────────────────────────────────────── */
  'water.pool': { m: 'water_pool', o: {} },
  'sign.lit': { m: 'sign_emissive', o: {}, k: { emissiveIntensity: 1.5 } },
};

const FALLBACK = 'struct.concrete';

export class Palette {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map();
    this.owned = [];
    this.missing = new Set();
  }

  /** @returns {THREE.Material} never null */
  get(key) {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const spec = PALETTE[key] || PALETTE[FALLBACK];
    if (!PALETTE[key]) this.missing.add(key);
    let mat = null;
    try {
      const lib = this.ctx.materials;
      if (lib?.clone && (spec.tint !== undefined || spec.k)) {
        mat = lib.clone(spec.m, { ...spec.o, ...(spec.k || {}), color: spec.tint });
        this.owned.push(mat);
      } else if (lib?.get) {
        mat = lib.get(spec.m, spec.o);
      }
    } catch {
      mat = null;
    }
    if (!mat) {
      // The library is stubbed or threw: still render something with structure.
      mat = new THREE.MeshStandardMaterial({
        color: spec.tint ?? 0x9a948a,
        roughness: 0.85,
        metalness: 0.02,
        vertexColors: false,
      });
      this.owned.push(mat);
    }
    mat.name = mat.name || key;
    try {
      attachVertexAO(mat);
    } catch {
      /* AO is a nicety; never let it break the level */
    }
    this.cache.set(key, mat);
    return mat;
  }

  /** The §5 surface tag for a palette key — drives bullets, footsteps and decals. */
  surface(key) {
    const spec = PALETTE[key] || PALETTE[FALLBACK];
    try {
      return this.ctx.materials?.surfaceTag?.(spec.m) || guessTag(spec.m);
    } catch {
      return guessTag(spec.m);
    }
  }

  dispose() {
    for (const m of this.owned) {
      try {
        m.dispose();
      } catch {
        /* best effort */
      }
    }
    this.owned.length = 0;
    this.cache.clear();
  }
}

function guessTag(name) {
  if (/glass/.test(name)) return 'glass';
  if (/water/.test(name)) return 'water';
  if (/steel|metal|alumin/.test(name)) return 'metal';
  if (/wood|ply/.test(name)) return 'wood';
  if (/tarp|canvas|sandbag|carpet/.test(name)) return 'fabric';
  if (/sand/.test(name)) return 'sand';
  if (/dirt|gravel/.test(name)) return 'dirt';
  if (/grass/.test(name)) return 'grass';
  if (/plaster|stucco|brick_painted/.test(name)) return 'plaster';
  if (/tile|marble/.test(name)) return 'ceramic';
  if (/rubber/.test(name)) return 'rubber';
  return 'concrete';
}

export default Palette;
