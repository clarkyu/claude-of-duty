/**
 * MaterialLibrary — every surface in the game comes from here. Owner: MaterialLibrary agent.
 *
 * The TextureForge makes the *pixels*; this module makes the *materials*: it picks the
 * right three material class, wires the forge's PBR set into it, remaps roughness and
 * metalness into a physically sane range per material, and extends three's standard
 * shader with the things it does not ship (see ./shaders/materialExtensions.js):
 * triplanar projection, parallax occlusion, distance-blended detail maps, tiling
 * break-up, vertex-colour layer blending, wetness/puddles, translucency, wind and
 * emissive screens.
 *
 * It is also the single source of truth for *physical* surface identity — ballistics,
 * audio, FX and decals all call `surfaceOf()` and get the table in ./SurfaceDefs.js.
 *
 * Publishes `ctx.materials`:
 *   get(name, opts)        -> cached THREE.Material, fully wired
 *   clone(name, overrides) -> a fresh variant (never share-mutate a cached material)
 *   decal(name, opts)      -> polygon-offset variant for decal/overlay geometry
 *   depthMaterial(name)    -> shadow-caster companion for wind-animated materials
 *   has(name) / list()     -> catalogue
 *   surfaceOf(x)           -> frozen SurfaceDef (name | Material | Mesh | physics Hit)
 *   surfaceTag(x)          -> the ARCHITECTURE §5 tag string
 *   surfaceTags()          -> the 15 legal tags
 *   rhaEquivalent(x, m)    -> mm of RHA equivalent for m metres of the material
 *   globals                -> { time, wind, windDirection, windStrength, windAngle,
 *                              wetness, dustLevel, sunDirection, uniforms }
 *   setWetness(v, now?) / setWind(dir, strength) / setDustLevel(v)
 *   setWaterReflection(texture, matrix)   planar-reflection hookup for water
 *   extend(material, opts) -> opt any foreign MeshStandardMaterial into the extension
 *   boxUv(geometry, scale) -> generate metre-space UVs (helper for level geometry)
 *   textureSet(name)       -> the raw forge PBRSet behind a material
 *   uniformsOf(material)   -> that material's uniform bag
 *   stats() / selfTest() / dispose()
 *
 * ── UV convention ──────────────────────────────────────────────────────────────
 * Geometry UVs are expected **in metres** (uv (0,0)..(4,3) covers a 4 m x 3 m wall).
 * `get()` then scales them by 1/worldSize so texel density is correct everywhere with
 * no per-mesh fiddling. Three escape hatches:
 *   get(name, { repeat: 2 })            – double the tiling density
 *   get(name, { projection:'triplanar'})– ignore UVs entirely, project from world space
 *   ctx.materials.boxUv(geometry)       – generate metre UVs for geometry that has none
 *
 * ── Useful `opts` ──────────────────────────────────────────────────────────────
 *   repeat, uvScale, offsetU/offsetV   tiling
 *   projection: 'uv' | 'triplanar'
 *   side: 'front'|'back'|'double', transparent, alphaTest, alphaMap, opacity
 *   vertexColors: true                 turn the vertex-colour MASK on:
 *                                        r = grime, g = second material, b = pooling
 *   layer: 'snow_packed'               the second material for the g channel, plus
 *                                      layerAmount / layerCavityBias / layerUpFacing /
 *                                      layerRepeat / layerRoughness
 *   detail, tileBreak, dust, wet       0..1 multipliers on the automatic effects
 *   normalScale, aoDirect, puddleLevel, grime, grimeColor, dustColor
 *   emissive, emissiveIntensity        for signage / screens
 *   variant                            force a separate cache entry
 * Materials are cached on (name + opts); two calls with the same arguments return the
 * *same* object, so never mutate one in place — use `clone()`.
 *
 * Events consumed: `quality:changed`, `setting:changed`, `weather:wetness`,
 * `weather:changed`, `weather:wind`.
 * Events emitted:  `materials:ready` {count}.
 *
 * URL: `?matcheck=all|core|off` controls the boot-time shader compile self-test
 * (default: `core` when headless, `off` otherwise).
 */
import * as THREE from 'three';
import {
  surfaceDefFor,
  surfaceTagFor,
  resolveSurfaceName,
  hasSurfaceDef,
  listSurfaceNames,
  SURFACE_TAGS,
  rhaEquivalent,
} from './SurfaceDefs.js';
import {
  createGlobals,
  extendMaterial,
  extendDepthMaterial,
  EXT_VERSION,
} from './shaders/materialExtensions.js';

/* ========================================================================== */
/*                                  recipes                                   */
/* ========================================================================== */

/**
 * Per-surface-tag starting point. Individual recipes override what they need; this is
 * what stops any material from being flat, and keeps the roughness/metalness ranges
 * physically defensible.
 */
const TAG_DEFAULTS = {
  concrete: { rough: [0.42, 1.0], metal: [0, 0.04], detail: 1.0, dust: 1.0, wet: 1.0, porosity: 0.85, tileBreak: 0.6, edgeWear: 0.5, streak: 1.0 },
  plaster: { rough: [0.55, 1.0], metal: [0, 0.02], detail: 1.0, dust: 0.9, wet: 0.9, porosity: 0.9, tileBreak: 0.5, edgeWear: 0.45, streak: 1.15 },
  metal: { rough: [0.14, 0.95], metal: [0, 1], detail: 0.8, dust: 0.7, wet: 1.0, porosity: 0.12, tileBreak: 0.25, env: 1.05, edgeWear: 0.7, streak: 0.9 },
  wood: { rough: [0.35, 1.0], metal: [0, 0.05], detail: 1.0, dust: 0.9, wet: 1.0, porosity: 0.75, tileBreak: 0.45, edgeWear: 0.6, streak: 0.8 },
  dirt: { rough: [0.6, 1.0], metal: [0, 0.02], detail: 1.0, dust: 0.5, wet: 1.0, porosity: 0.95, tileBreak: 0.85, triplanar: true, edgeWear: 0.2, streak: 0 },
  sand: { rough: [0.65, 1.0], metal: [0, 0.02], detail: 1.0, dust: 0.3, wet: 1.0, porosity: 0.95, tileBreak: 0.9, triplanar: true, edgeWear: 0.2, streak: 0 },
  grass: { rough: [0.55, 1.0], metal: [0, 0.02], detail: 1.0, dust: 0.4, wet: 1.0, porosity: 0.9, tileBreak: 0.9, triplanar: true, edgeWear: 0.15, streak: 0 },
  glass: { rough: [0.02, 0.5], metal: [0, 0.1], detail: 0.4, dust: 0.5, wet: 0.5, porosity: 0.05, tileBreak: 0, env: 1.2, edgeWear: 0, streak: 0 },
  water: { rough: [0.0, 1.0], metal: [0, 0], detail: 0, dust: 0, wet: 0, porosity: 0, tileBreak: 0, env: 1.2, edgeWear: 0, streak: 0 },
  // Thin coated cloth: light comes through an awning, and without it a canopy is a
  // painted plane. `snow_packed` had this configured and the fabric tag did not.
  fabric: {
    rough: [0.55, 1.0], metal: [0, 0.05], detail: 1.0, dust: 1.0, wet: 0.8, porosity: 0.95, tileBreak: 0.4,
    edgeWear: 0.3, streak: 0.9,
    sss: { strength: 0.34, power: 3.2, distortion: 0.32, ambient: 0.03, color: 0xb8a98a },
  },
  flesh: { rough: [0.28, 0.72], metal: [0, 0.02], detail: 1.0, dust: 0.2, wet: 0.6, porosity: 0.3, tileBreak: 0, edgeWear: 0, streak: 0 },
  rubber: { rough: [0.5, 1.0], metal: [0, 0.05], detail: 0.9, dust: 0.8, wet: 0.9, porosity: 0.25, tileBreak: 0.3, edgeWear: 0.4, streak: 0.5 },
  ceramic: { rough: [0.05, 0.9], metal: [0, 0.08], detail: 0.8, dust: 0.9, wet: 1.0, porosity: 0.3, tileBreak: 0.55, env: 1.1, edgeWear: 0.55, streak: 0.7 },
  foliage: {
    rough: [0.4, 0.9], metal: [0, 0.02], detail: 0.7, dust: 0.5, wet: 0.8, porosity: 0.6, tileBreak: 0,
    edgeWear: 0, streak: 0,
    sss: { strength: 0.8, power: 2.4, distortion: 0.4, ambient: 0.09, color: 0x6f9a3c },
  },
  snow: { rough: [0.35, 0.95], metal: [0, 0.02], detail: 1.0, dust: 0, wet: 0.7, porosity: 0.5, tileBreak: 0.9, triplanar: true, env: 1.1, edgeWear: 0.2, streak: 0 },
};

/**
 * The catalogue. `set` is the TextureForge recipe (defaults to the key). Everything
 * else layers on top of TAG_DEFAULTS.
 *
 * parallax: height amplitude boost (0/false disables). detail/tileBreak/dust/wet are
 * 0..1 strengths. `sss`, `sheen`, `clearcoat`, `wind`, `screen`, `glass`, `water` turn
 * the specialised paths on.
 */
const RECIPES = {
  /* ── concrete & masonry ──────────────────────────────────────────────── */
  concrete_cast: { parallax: 1.0, aoIntensity: 1.0 },
  concrete_precast_panel: { parallax: 1.1 },
  asphalt: { rough: [0.5, 1.0], parallax: 0.7, tileBreak: 0.9, dust: 0.7 },
  sidewalk_paving: { parallax: 1.4, tileBreak: 0.7 },
  brick_red: { parallax: 1.6, detail: 1.0, tileBreak: 0.5 },
  brick_painted: { parallax: 1.4, rough: [0.35, 0.98] },
  rubble: { parallax: 1.2, triplanar: true, tileBreak: 0.9, dust: 1.2 },
  roof_shingle: { parallax: 1.3, tileBreak: 0.6 },

  /* ── plaster ─────────────────────────────────────────────────────────── */
  plaster_cracked: { parallax: 0.8 },
  stucco: { parallax: 1.0 },

  /* ── metal ───────────────────────────────────────────────────────────── */
  rusted_steel: { rough: [0.22, 1.0], metal: [0, 1], parallax: 0.8, env: 1.0 },
  painted_steel_chipped: { rough: [0.16, 0.95], metal: [0, 1], parallax: 0.6 },
  galvanised_metal: { rough: [0.18, 0.72], metal: [0.1, 1], parallax: 0, env: 1.1 },
  brushed_aluminium: { rough: [0.12, 0.6], metal: [0.35, 1], parallax: 0, detail: 0.5, env: 1.15 },
  corrugated_metal: { rough: [0.2, 0.9], metal: [0.05, 1], parallax: 1.8, pomShadow: true, env: 1.05 },

  /* ── wood ────────────────────────────────────────────────────────────── */
  wood_plank_weathered: { parallax: 1.2 },
  wood_ply: { parallax: 0.5 },
  plywood_painted: { parallax: 0.5, rough: [0.3, 0.95] },

  /* ── ground ──────────────────────────────────────────────────────────── */
  sand: { parallax: 1.0, triplanar: true },
  dirt_packed: { parallax: 1.0, triplanar: true },
  gravel: { parallax: 1.8, pomShadow: true, triplanar: true },
  dry_grass_ground: { parallax: 1.0, triplanar: true },
  snow_packed: { parallax: 1.0, triplanar: true, sss: { strength: 0.22, power: 2.5, color: 0xdfe9f5 } },

  /* ── fabric ──────────────────────────────────────────────────────────── */
  fabric_canvas: { physical: true, sheen: { amount: 0.6, roughness: 0.7, color: 0xbfb9a8 }, parallax: 0 },
  tarp: { physical: true, sheen: { amount: 0.45, roughness: 0.55, color: 0x9fbdb4 }, parallax: 0.6 },
  sandbag: { physical: true, sheen: { amount: 0.55, roughness: 0.8, color: 0xc9b48a }, parallax: 1.4 },
  carpet_worn: { physical: true, sheen: { amount: 0.75, roughness: 0.9, color: 0x9a8878 }, parallax: 0.8 },

  /* ── glass & ceramic ─────────────────────────────────────────────────── */
  glass_dirty: {
    physical: true,
    // Lower base alpha + a full-strength fresnel term: a pane you can see through
    // head-on that goes to a near-mirror at grazing incidence. That transition is the
    // single signature of glass and it was being flattened by a constant dirt film.
    glass: { alpha: 0.055, fresnel: 1.0, dirt: 0.6, dirtTiling: 1.2 },
    rough: [0.015, 0.55],
    transparent: true,
    depthWrite: false,
    side: 'double',
    parallax: 0,
    env: 1.55,
    ior: 1.52,
  },
  glass_clear: {
    physical: true,
    set: 'glass_dirty',
    glass: { alpha: 0.045, fresnel: 0.95, dirt: 0.12, dirtTiling: 1.0 },
    rough: [0.01, 0.16],
    transparent: true,
    depthWrite: false,
    side: 'double',
    parallax: 0,
    env: 1.3,
    ior: 1.52,
  },
  glass_cracked: {
    physical: true,
    set: 'glass_dirty',
    glass: { alpha: 0.16, fresnel: 0.8, dirt: 0.75, dirtTiling: 2.4 },
    rough: [0.03, 0.7],
    transparent: true,
    depthWrite: false,
    side: 'double',
    parallax: 0.6,
    detail: 1.4,
    env: 1.15,
    ior: 1.52,
  },
  /**
   * Genuinely refractive glass (three's transmission path). Costs an extra scene
   * render every frame, so it degrades to `glass_clear` behaviour below `high` and
   * in headless. Use it for thick/curved glass where you can actually see the bend;
   * a flat window pane refracts by almost nothing and `glass_clear` is the better buy.
   */
  glass_refractive: {
    physical: true,
    set: 'glass_dirty',
    glass: { alpha: 0.03, fresnel: 0.9, dirt: 0.1, dirtTiling: 1.0 },
    transmission: 0.94,
    thickness: 0.02,
    attenuationColor: 0xd8ece8,
    attenuationDistance: 1.6,
    rough: [0.01, 0.14],
    transparent: true,
    depthWrite: false,
    side: 'double',
    parallax: 0,
    env: 1.3,
    ior: 1.52,
  },
  ceramic_tile: { parallax: 1.6, pomShadow: true, rough: [0.05, 0.9], env: 1.1 },
  marble_lobby: { parallax: 0.5, rough: [0.035, 0.7], env: 1.2, clearcoat: 0.25 },

  /* ── misc ────────────────────────────────────────────────────────────── */
  rubber_tyre: { parallax: 1.4, rough: [0.5, 1.0] },

  /* ── specialised ─────────────────────────────────────────────────────── */
  water_pool: {
    physical: true,
    set: 'glass_dirty',
    water: {
      depth: 0.55,
      absorb: [0.95, 0.32, 0.2],
      color: 0x2f4a45,
      foam: 0xdfe6e4,
      waveScale: [2.2, 5.3],
      waveSpeed: [0.035, 0.055],
      alphaGain: 1.0,
      foamWidth: 0.22,
      normalStrength: [0.75, 0.5],
      ripples: 1.0,
    },
    transparent: true,
    side: 'double',
    depthWrite: false,
    env: 1.3,
    ior: 1.333,
  },
  water_deep: {
    physical: true,
    set: 'glass_dirty',
    water: {
      depth: 3.5,
      absorb: [0.55, 0.16, 0.09],
      color: 0x16333c,
      foam: 0xe6eeef,
      waveScale: [1.1, 3.1],
      waveSpeed: [0.028, 0.045],
      alphaGain: 1.0,
      foamWidth: 0.12,
      normalStrength: [0.9, 0.6],
      ripples: 0.7,
    },
    transparent: true,
    side: 'double',
    depthWrite: false,
    env: 1.35,
    ior: 1.333,
  },

  foliage_leaf: {
    set: 'dry_grass_ground',
    side: 'double',
    wind: { amplitude: 0.16, frequency: 1.7, stiffness: 0.45, height: 1.2 },
    sss: { strength: 0.85, power: 2.4, distortion: 0.4, ambient: 0.1, color: 0x6f9a3c },
    rough: [0.35, 0.85],
    color: 0x9fbf74,
    detail: 0.8,
    dust: 0.3,
    parallax: 0,
    tileBreak: 0,
  },
  foliage_bush: {
    set: 'dry_grass_ground',
    side: 'double',
    wind: { amplitude: 0.1, frequency: 1.2, stiffness: 0.3, height: 1.6 },
    sss: { strength: 0.7, power: 2.8, distortion: 0.35, ambient: 0.08, color: 0x59802f },
    rough: [0.4, 0.9],
    color: 0x8aa863,
    parallax: 0,
    tileBreak: 0,
  },
  foliage_grass: {
    set: 'dry_grass_ground',
    side: 'double',
    wind: { amplitude: 0.22, frequency: 2.3, stiffness: 0.6, height: 0.55 },
    sss: { strength: 0.95, power: 2.0, distortion: 0.45, ambient: 0.12, color: 0x8aa04a },
    rough: [0.45, 0.95],
    color: 0xb2b573,
    parallax: 0,
    tileBreak: 0,
  },

  skin: {
    physical: true,
    macro: 0,
    set: 'carpet_worn',
    surface: 'flesh',
    sss: { strength: 0.55, power: 3.4, distortion: 0.28, ambient: 0.06, color: 0x9c3a2a },
    rough: [0.3, 0.66],
    color: 0xc79070,
    clearcoat: 0.16,
    clearcoatRoughness: 0.5,
    detail: 1.0,
    detailMetres: 0.04,
    dust: 0.15,
    parallax: 0,
    tileBreak: 0,
  },
  skin_head: {
    physical: true,
    macro: 0,
    set: 'carpet_worn',
    surface: 'flesh',
    sss: { strength: 0.7, power: 3.0, distortion: 0.3, ambient: 0.08, color: 0xa8402c },
    rough: [0.26, 0.6],
    color: 0xcd9878,
    clearcoat: 0.22,
    clearcoatRoughness: 0.45,
    detail: 1.0,
    detailMetres: 0.025,
    dust: 0.1,
    parallax: 0,
    tileBreak: 0,
  },
  fabric_uniform: {
    // Characters walk through the world; a world-locked macro band would make their
    // kit change colour as they move. Same for webbing and skin.
    physical: true,
    macro: 0,
    set: 'fabric_canvas',
    surface: 'fabric',
    sheen: { amount: 0.85, roughness: 0.62, color: 0x7d8464 },
    sss: { strength: 0.18, power: 4.0, distortion: 0.2, ambient: 0.03, color: 0x5a5f42 },
    rough: [0.6, 1.0],
    color: 0x6f7455,
    detailMetres: 0.05,
    parallax: 0,
    tileBreak: 0.2,
  },
  fabric_webbing: {
    physical: true,
    macro: 0,
    set: 'fabric_canvas',
    surface: 'fabric',
    sheen: { amount: 0.6, roughness: 0.5, color: 0x5f6350 },
    rough: [0.5, 0.95],
    color: 0x4a4f3e,
    detailMetres: 0.03,
    parallax: 0.4,
    tileBreak: 0,
  },

  screen_display: {
    // The procedural display content is authored in 0..1 panel space, so this is the
    // one material that wants stock PlaneGeometry UVs rather than metres.
    uvUnit: true,
    set: 'brushed_aluminium',
    screen: { nits: 5.5, lines: 220, lineDepth: 0.28, flicker: 0.012, tint: 0x9fd0ff },
    emissive: 0x000000,
    rough: [0.05, 0.3],
    metal: [0, 0.15],
    color: 0x0a0d12,
    parallax: 0,
    tileBreak: 0,
    detail: 0.3,
    env: 1.15,
  },
  sign_emissive: {
    set: 'painted_steel_chipped',
    surface: 'metal',
    emissive: 0xff7a3c,
    emissiveIntensity: 4.5,
    rough: [0.2, 0.9],
    metal: [0, 1],
    screen: { nits: 0.0, lines: 90, lineDepth: 0.1, flicker: 0.05, tint: 0xff8a4a },
    parallax: 0.5,
  },
  light_panel: {
    set: 'brushed_aluminium',
    emissive: 0xfff0d8,
    emissiveIntensity: 8.0,
    // nits 0 = no procedural content, just the flicker + dirt modulation.
    screen: { nits: 0, lines: 0, lineDepth: 0, flicker: 0.018, tint: 0xffffff },
    rough: [0.15, 0.5],
    metal: [0, 0.1],
    color: 0xd8dce2,
    parallax: 0,
    tileBreak: 0,
    detail: 0.2,
  },
};

/* ========================================================================== */
/*                                   library                                  */
/* ========================================================================== */

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(v) ? v : d);

class Library {
  constructor(ctx) {
    this.ctx = ctx;
    this.globals = createGlobals();
    this.cache = new Map(); // key -> THREE.Material
    this.meta = new WeakMap(); // material -> { name, recipe, uniforms, set, opts }
    this.all = new Set();
    this.reflect = { texture: null, matrix: new THREE.Matrix4(), strength: 0.9, distortion: 0.06 };
    this.wetness = 0;
    this.wetTarget = 0;
    this.dust = 0.18;
    this.windAngle = 0.4;
    this.windStrength = 0.35;
    this._unsub = [];
    this._warned = new Set();
    this._q = this._quality();
    this._missingChunks = new Set();
    this._pendingAerial = new Set();
    this._shared = { detailNormal: null, grunge: null };
    this.stats = { built: 0, cached: 0, extended: 0 };
  }

  /* ------------------------------------------------------------- lifecycle */

  init() {
    const ctx = this.ctx;
    this._q = this._quality();

    // Shared helper textures. Both are cheap and the forge caches them.
    try {
      this._shared.detailNormal = ctx.textures?.detailNormal?.() || null;
      this._shared.grunge = ctx.textures?.grungeMask?.() || null;
    } catch (err) {
      this._note('shared helper textures unavailable', err);
    }
    if (!this._shared.detailNormal) this._shared.detailNormal = this._flatNormal();
    if (!this._shared.grunge) this._shared.grunge = this._flatGrey();

    const bus = ctx.bus;
    if (bus?.on) {
      this._unsub.push(bus.on('quality:changed', () => this._onQuality()));
      this._unsub.push(
        bus.on('setting:changed', ({ key }) => {
          if (key === 'parallax' || key === 'detailTextures' || key === 'anisotropy') this._onQuality();
        })
      );
      // Weather owns the rain; we own what rain does to every surface in the world.
      const wet = (e) => {
        const v = e?.wetness ?? e?.value ?? e?.amount;
        if (Number.isFinite(v)) this.setWetness(v);
      };
      this._unsub.push(bus.on('weather:wetness', wet));
      this._unsub.push(bus.on('weather:changed', wet));
      this._unsub.push(
        bus.on('weather:wind', (e) => {
          if (!e) return;
          this.setWind(e.direction ?? e.dir ?? e.angle, e.strength ?? e.speed);
        })
      );
    }

    this._syncLighting();
    this._validate();
    ctx.bus?.emit?.('materials:ready', { count: this.cache.size });
  }

  dispose() {
    for (const off of this._unsub) {
      try {
        off?.();
      } catch {
        /* best effort */
      }
    }
    this._unsub.length = 0;
    for (const m of this.all) {
      try {
        m.dispose();
      } catch {
        /* best effort */
      }
    }
    this.all.clear();
    this.cache.clear();
    for (const t of [this._fallbackNormal, this._fallbackGrey]) {
      try {
        t?.dispose();
      } catch {
        /* best effort */
      }
    }
  }

  /* --------------------------------------------------------------- quality */

  /**
   * The tier table is the authority on what the extension compiles, not the legacy
   * `parallax` boolean.
   *
   * Why: the stock `medium` preset ships `parallax:false` and this method used to give
   * `medium` zero POM layers and no tile break-up at all. Medium is the tier the review
   * harness renders (high is ~5x the frame cost on a software rasteriser), so *every*
   * screenshot anyone has ever looked at was missing parallax, tiling break-up and the
   * distance detail band — the recipe library was strictly better than what reached the
   * screen. `low` still gets 0 layers, so POM is genuinely compiled out there, and a
   * caller that explicitly asks for `parallax` can opt `low` back in.
   *
   * Budget: medium buys 6 POM layers with a 4 m fade (near-field only, which is the
   * only place parallax is legible anyway) on the deep-relief recipes, plus tile
   * break-up from 2.5 m out on everything. That is the cheapest set of switches that
   * still answers findings 2, 3 and 4; the SwiftShader review build cannot afford POM
   * on every wall in the map as well.
   */
  _quality() {
    const s = this.ctx.settings;
    const tier = s?.tier || 'high';
    const headless = !!s?.get?.('headless');
    const detail = s?.get?.('detailTextures') !== false;

    let layers = { low: 0, medium: 6, high: 18, ultra: 26 }[tier] ?? 18;
    if (layers === 0 && s?.get?.('parallax') === true) layers = 6;
    // The software rasteriser pays for every step of the ray march; cap it there.
    if (headless) layers = Math.min(layers, 8);

    let pomFade = { low: 0, medium: 4, high: 9, ultra: 14 }[tier] ?? 9;
    if (layers > 0 && pomFade <= 0) pomFade = 4;
    if (headless) pomFade = Math.min(pomFade, 5);

    // Medium buys parallax only where it is legible: deep, near-field relief — brick
    // courses, cobble, ceramic joints, corrugation, rubble. A 0.5-amplitude surface
    // (ply, plaster, sheet steel) gains almost nothing from POM and there is a lot of
    // it on screen, so it stays flat and the budget goes where the depth is.
    const pomMin = tier === 'medium' ? 1.2 : 0;

    let detailFade = { low: 4, medium: 14, high: 14, ultra: 20 }[tier] ?? 14;
    if (headless) detailFade = Math.min(detailFade, 14);

    return {
      tier,
      headless,
      parallax: layers > 0,
      pomLayers: layers,
      pomShadow: !headless && (tier === 'ultra' || tier === 'high'),
      detail,
      // Three extra fetches beyond 2.5 m, and it is the only thing standing between the
      // plaza and a chequerboard. Everything except `low` pays for it.
      tileBreak: tier !== 'low',
      // World-space macro variation + convex edge wear: one fetch, plus a second on
      // vertical faces only (the streak source). No distance fade — it is what stops
      // the *far* field looking tiled, which is exactly where it has to keep working.
      macro: tier !== 'low',
      pomMin,
      detailFade,
      pomFade,
    };
  }

  _onQuality() {
    const q = this._quality();
    const same =
      q.parallax === this._q.parallax &&
      q.pomLayers === this._q.pomLayers &&
      q.pomShadow === this._q.pomShadow &&
      q.detail === this._q.detail &&
      q.tileBreak === this._q.tileBreak &&
      q.macro === this._q.macro &&
      q.pomMin === this._q.pomMin &&
      q.detailFade === this._q.detailFade &&
      q.pomFade === this._q.pomFade;
    if (same) return;
    this._q = q;
    for (const mat of this.all) {
      const m = this.meta.get(mat);
      if (!m) continue;
      try {
        this._applyQuality(mat, m);
      } catch (err) {
        this._note('quality re-apply failed', err);
      }
    }
  }

  /** Toggle the expensive defines and retune their uniforms for the current tier. */
  _applyQuality(mat, m) {
    const q = this._q;
    const r = m.recipe;
    const u = m.uniforms;
    const d = mat.defines || (mat.defines = {});
    let dirty = false;

    const set = (key, on) => {
      const has = Object.prototype.hasOwnProperty.call(d, key);
      if (on && !has) {
        d[key] = '';
        dirty = true;
      } else if (!on && has) {
        delete d[key];
        dirty = true;
      }
    };

    // Parallax and triplanar are mutually exclusive: the triplanar path resamples in
    // world space and would throw the offset away, so paying for it would be a lie.
    const wantPom =
      q.parallax && r.parallaxAmount > 0 && r.parallaxAmount >= (q.pomMin || 0) && !r.water && !r.triplanar;
    set('COD_POM', wantPom);
    set('COD_POM_SHADOW', wantPom && q.pomShadow && r.pomShadow);
    set('COD_POM_CLIP', wantPom && r.pomClip > 0);
    const wantDetail = q.detail && r.detailAmount > 0;
    set('COD_DETAIL', wantDetail);
    const wantBreak = q.tileBreak && r.tileBreakAmount > 0 && !r.water;
    set('COD_TILEBREAK', wantBreak);
    const wantMacro = q.macro && r.macroAmount > 0 && !r.water && !r.screen;
    set('COD_MACRO', wantMacro);

    if (u.uCodPom) {
      u.uCodPom.value.set(r.pomScale, q.pomLayers, q.pomFade, r.pomClip);
    }
    if (u.uCodDetail) {
      u.uCodDetail.value.set(r.detailTiling, r.detailNormalStrength, r.detailAlbedoStrength, q.detailFade);
    }
    if (u.uCodBreak) {
      u.uCodBreak.value.set(r.breakScale, r.tileBreakAmount, 2.5, 14.0);
    }
    if (dirty) mat.needsUpdate = true;
  }

  /**
   * Does this material want the world-space macro / staining / edge-wear block?
   *
   * Only world-space geometry does. The viewmodel and the characters move *through*
   * the field, so a world-locked band would make their albedo swim as the player walks
   * and would paint rain streaks down a rifle receiver. `aerial:false` is already the
   * established "this is not world geometry" hint (the viewmodel sets it to keep Sky's
   * aerial perspective off), so it doubles as the opt-out here.
   */
  _macroFor(r, opts, recipeRaw) {
    if (opts.aerial === false) return 0;
    if (r.water || r.screen) return 0;
    const tag = r.tag;
    if (tag === 'flesh') return 0;
    const base = num(recipeRaw.macro, tag === 'glass' ? 0.35 : tag === 'foliage' ? 0.6 : 1.0);
    return clamp(num(opts.macro, 1) * base, 0, 2);
  }

  /* ----------------------------------------------------------------- get() */

  /** True only for names we genuinely know — `get()` still never fails on a typo. */
  has(name) {
    if (typeof name !== 'string') return false;
    if (Object.prototype.hasOwnProperty.call(RECIPES, name)) return true;
    if (this.ctx.textures?.has?.(name)) return true;
    return hasSurfaceDef(name);
  }

  list() {
    const names = new Set(Object.keys(RECIPES));
    for (const n of listSurfaceNames()) names.add(n);
    for (const n of this.ctx.textures?.list?.() || []) names.add(n);
    return [...names].sort();
  }

  /** Resolve an arbitrary string to a recipe key, honouring SurfaceDefs' aliases. */
  _recipeName(name) {
    if (typeof name !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(RECIPES, name)) return name;
    const canon = resolveSurfaceName(name);
    if (Object.prototype.hasOwnProperty.call(RECIPES, canon)) return canon;
    // A forge material with no explicit recipe still gets the tag defaults.
    if (this.ctx.textures?.has?.(canon)) return canon;
    return null;
  }

  key(name, opts) {
    return [
      name,
      opts.projection || '',
      opts.repeat ?? '',
      opts.uvScale ?? '',
      opts.side ?? '',
      opts.transparent ? 't' : '',
      opts.alphaTest ?? '',
      opts.decal ? 'd' : '',
      opts.vertexColors === true ? 'vc' : '',
      opts.layer ?? '',
      opts.layerAmount ?? '',
      opts.emissiveIntensity ?? '',
      opts.variant ?? '',
    ].join('|');
  }

  get(name, opts = {}) {
    const key = this.key(name, opts);
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.cached++;
      return hit;
    }
    let mat;
    try {
      mat = this._build(name, opts);
    } catch (err) {
      this._note(`build of "${name}" failed`, err);
      mat = this._emergency(name);
    }
    this.cache.set(key, mat);
    return mat;
  }

  /** A fresh, independent variant. Never mutate a material handed out by get(). */
  clone(name, overrides = {}) {
    let mat;
    try {
      mat = this._build(name, { ...overrides, __nocache: true });
    } catch (err) {
      this._note(`clone of "${name}" failed`, err);
      return this._emergency(name);
    }
    // Plain three properties the caller may want to poke directly.
    for (const k of ['color', 'emissive', 'sheenColor']) {
      if (overrides[k] !== undefined && mat[k]?.isColor) mat[k].set(overrides[k]);
    }
    for (const k of [
      'opacity',
      'transparent',
      'alphaTest',
      'depthWrite',
      'depthTest',
      'emissiveIntensity',
      'envMapIntensity',
      'aoMapIntensity',
      'wireframe',
      'flatShading',
      'toneMapped',
      'polygonOffset',
      'polygonOffsetFactor',
      'polygonOffsetUnits',
      'name',
    ]) {
      if (overrides[k] !== undefined) mat[k] = overrides[k];
    }
    if (overrides.side !== undefined) mat.side = resolveSide(overrides.side);
    mat.needsUpdate = true;
    return mat;
  }

  /** Decal / overlay variant: polygon offset so it never z-fights with its host. */
  decal(name, opts = {}) {
    return this.get(name, {
      ...opts,
      decal: true,
      transparent: opts.transparent !== false,
      variant: `decal${opts.variant || ''}`,
    });
  }

  /* ---------------------------------------------------------------- build */

  _build(name, opts) {
    const ctx = this.ctx;
    const rname = this._recipeName(name) || 'concrete_cast';
    const recipeRaw = RECIPES[rname] || {};
    const setName = recipeRaw.set || (ctx.textures?.has?.(rname) ? rname : 'concrete_cast');
    // SurfaceDefs is the authority on the §5 tag — it already knows that
    // `screen_display` is glass and `skin_head` is flesh.
    const tag = surfaceTagFor(rname);
    const tagDef = TAG_DEFAULTS[tag] || TAG_DEFAULTS.concrete;

    /* -- texture set ---------------------------------------------------- */
    const set = ctx.textures?.pbr?.(setName) || null;
    const worldSize = num(set?.worldSize, 2.5);
    const depth = num(set?.depth, 0.02);

    /* -- resolved recipe ------------------------------------------------ */
    const r = {
      name: rname,
      setName,
      tag,
      worldSize,
      depth,
      rough: recipeRaw.rough || tagDef.rough || [0.05, 1.0],
      metal: recipeRaw.metal || tagDef.metal || [0, 1],
      env: num(recipeRaw.env, num(tagDef.env, 1.0)),
      aoIntensity: num(recipeRaw.aoIntensity, 1.0),
      color: recipeRaw.color ?? 0xffffff,
      water: recipeRaw.water || null,
      glass: recipeRaw.glass || null,
      screen: recipeRaw.screen || null,
      // A tag may supply translucency (fabric, foliage) so a recipe that never thought
      // about it still reads as a thin sheet with light behind it rather than card.
      sss: recipeRaw.sss || (recipeRaw.sss === false ? null : tagDef.sss || null),
      sheen: recipeRaw.sheen || null,
      wind: recipeRaw.wind || null,
      pomShadow: recipeRaw.pomShadow !== false,
      pomClip: num(recipeRaw.pomClip, 0),
      dustAmount: num(recipeRaw.dust, num(tagDef.dust, 0)) * (opts.dust ?? 1),
      wetAmount: num(recipeRaw.wet, num(tagDef.wet, 0)) * (opts.wet ?? 1),
      porosity: num(recipeRaw.porosity, num(tagDef.porosity, 0.7)),
      detailAmount: num(recipeRaw.detail, num(tagDef.detail, 1)) * (opts.detail ?? 1),
      tileBreakAmount: num(recipeRaw.tileBreak, num(tagDef.tileBreak, 0)) * (opts.tileBreak ?? 1),
      detailMetres: num(recipeRaw.detailMetres, 0.16),
      // Convex wear: how strongly the proud parts of the height field lose their finish.
      edgeWear: num(recipeRaw.edgeWear, num(tagDef.edgeWear, 0.35)) * (opts.edgeWear ?? 1),
      edgeMetal: num(recipeRaw.edgeMetal, tag === 'metal' ? 0.55 : 0),
      // Vertical world-space staining. Ground and glass do not want it.
      streak: num(recipeRaw.streak, num(tagDef.streak, 0.75)) * (opts.streak ?? 1),
    };
    r.macroAmount = this._macroFor(r, opts, recipeRaw);

    /* -- UV scale (metre space -> texture space) ------------------------ */
    const projection =
      opts.projection || ((recipeRaw.triplanar ?? tagDef.triplanar) ? 'triplanar' : 'uv');
    const triplanar = projection === 'triplanar';
    // Default: geometry UVs are in metres, so scale by 1/worldSize. `uvUnit` recipes
    // (screens) expect stock 0..1 UVs instead and take the repeat straight through.
    const uvBase = recipeRaw.uvUnit ? 1 : 1 / worldSize;
    const uvScale = num(opts.uvScale, uvBase * num(opts.repeat, 1));
    r.triplanar = triplanar;
    r.uvScale = uvScale;
    r.pomScale = depth * uvScale * num(recipeRaw.parallax, 0) * 1.6;
    r.parallaxAmount = num(recipeRaw.parallax, 0);
    r.detailTiling = 1 / Math.max(1e-4, r.detailMetres * uvScale);
    r.detailNormalStrength = 0.55 * r.detailAmount;
    r.detailAlbedoStrength = 0.5 * r.detailAmount;
    r.breakScale = 1 / Math.max(1e-4, 11 * uvScale);

    /* -- material class + base properties ------------------------------- */
    const wantPhysical =
      !!(recipeRaw.physical || r.sheen || r.glass || r.water || recipeRaw.clearcoat || recipeRaw.ior);
    const Ctor = wantPhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;

    const params = {
      name: `cod:${rname}`,
      color: new THREE.Color(r.color),
      roughness: clamp(r.rough[1], 0.02, 1),
      metalness: clamp(r.metal[1], 0, 1),
      envMapIntensity: r.env,
      dithering: true,
    };
    if (set) {
      params.map = set.map;
      params.normalMap = set.normalMap;
      params.roughnessMap = set.ormMap;
      params.metalnessMap = set.ormMap;
      params.aoMap = set.ormMap;
      params.aoMapIntensity = r.aoIntensity;
      params.normalScale = new THREE.Vector2(1, 1);
    }
    const emissive = opts.emissive ?? recipeRaw.emissive;
    if (emissive !== undefined) {
      params.emissive = new THREE.Color(emissive);
      params.emissiveIntensity = num(opts.emissiveIntensity, num(recipeRaw.emissiveIntensity, 1));
    }
    if (wantPhysical) {
      if (recipeRaw.ior) params.ior = recipeRaw.ior;
      if (recipeRaw.clearcoat) {
        params.clearcoat = recipeRaw.clearcoat;
        params.clearcoatRoughness = num(recipeRaw.clearcoatRoughness, 0.3);
      }
      if (r.sheen) {
        params.sheen = clamp(num(r.sheen.amount, 0.5), 0, 1);
        params.sheenRoughness = clamp(num(r.sheen.roughness, 0.6), 0.05, 1);
        params.sheenColor = new THREE.Color(r.sheen.color ?? 0xffffff);
      }
      if (r.water || r.glass) params.specularIntensity = 1.0;
      // Real refraction is an extra full-scene render inside WebGLRenderer. Only the
      // top tiers pay for it; everyone else gets the fresnel-alpha glass, which for a
      // flat pane is visually almost identical.
      const canTransmit = !this._q.headless && (this._q.tier === 'high' || this._q.tier === 'ultra');
      if (recipeRaw.transmission && canTransmit) {
        params.transmission = recipeRaw.transmission;
        params.thickness = num(recipeRaw.thickness, 0.02);
        if (recipeRaw.attenuationColor !== undefined) {
          params.attenuationColor = new THREE.Color(recipeRaw.attenuationColor);
          params.attenuationDistance = num(recipeRaw.attenuationDistance, 1);
        }
      }
    }

    const transparent = opts.transparent ?? !!(recipeRaw.transparent || r.glass || r.water);
    if (transparent) {
      params.transparent = true;
      params.opacity = num(opts.opacity, 1);
      params.depthWrite = opts.depthWrite ?? recipeRaw.depthWrite ?? !r.water;
    }
    if (opts.alphaTest || recipeRaw.alphaTest) {
      params.alphaTest = num(opts.alphaTest, recipeRaw.alphaTest);
    }
    if (opts.alphaMap) params.alphaMap = opts.alphaMap;
    params.side = resolveSide(opts.side ?? recipeRaw.side ?? 'front');
    // Double-sided *opaque* geometry (leaf cards) must cast from both faces; glass and
    // water must not start casting solid shadows because they are double-sided.
    if (params.side === THREE.DoubleSide && !transparent) params.shadowSide = THREE.DoubleSide;

    if (opts.decal) {
      params.polygonOffset = true;
      params.polygonOffsetFactor = num(opts.polygonOffsetFactor, -3);
      params.polygonOffsetUnits = num(opts.polygonOffsetUnits, -6);
      params.depthWrite = false;
      params.transparent = true;
      params.side = THREE.FrontSide;
    }

    const mat = new Ctor(params);
    // Vertex colour is a *mask* for us, not a tint: r = grime, g = second material,
    // b = water pooling. Opt-in, because an instanced mesh that uses instanceColor for
    // ordinary tint variation would otherwise be read as a grime map.
    const useVCol = opts.vertexColors === true || !!opts.layer;
    mat.vertexColors = useVCol;
    this.all.add(mat);
    this.stats.built++;

    /* -- texture repeat (keeps the GBuffer/debug views honest) ---------- */
    try {
      set?.setRepeat?.(uvScale, uvScale);
    } catch {
      /* the fallback set has a simpler setRepeat */
    }

    /* -- uniforms -------------------------------------------------------- */
    const detailNormal = opts.detailNormal || this._shared.detailNormal;
    const grunge = opts.grungeMap || this._shared.grunge;
    const height = set?.displacementMap || grunge;

    const u = {
      ...this.globals,
      uCodUvXf: { value: new THREE.Vector4(uvScale, uvScale, num(opts.offsetU, 0), num(opts.offsetV, 0)) },
      uCodRough: { value: new THREE.Vector2(r.rough[0], r.rough[1]) },
      uCodMetal: { value: new THREE.Vector2(r.metal[0], r.metal[1]) },
      uCodNrmScale: { value: new THREE.Vector2(num(opts.normalScale, 1), num(opts.normalScale, 1)) },
      uCodAoDirect: { value: num(opts.aoDirect, 0.28) },
      uCodDetailNormal: { value: detailNormal },
      uCodGrunge: { value: grunge },
      uCodHeightMap: { value: height },
    };

    // MERGE, never replace: three's constructor put STANDARD/PHYSICAL in here and the
    // whole lighting model is gated on them.
    const defines = { ...(mat.defines || {}), COD_EXT: EXT_VERSION };
    if (triplanar) {
      defines.COD_TRIPLANAR = '';
      u.uCodTri = { value: new THREE.Vector4(uvScale, num(recipeRaw.triSharp, 6), 0, 0) };
    }
    if (r.parallaxAmount > 0) u.uCodPom = { value: new THREE.Vector4(r.pomScale, 18, 9, r.pomClip) };
    if (r.detailAmount > 0) {
      u.uCodDetail = {
        value: new THREE.Vector4(r.detailTiling, r.detailNormalStrength, r.detailAlbedoStrength, 14),
      };
    }
    if (r.tileBreakAmount > 0) u.uCodBreak = { value: new THREE.Vector4(r.breakScale, r.tileBreakAmount, 2.5, 14) };
    if (r.macroAmount > 0) {
      // x macro strength, y convex edge-wear strength, z edge metalness lift,
      // w vertical world-space staining. All world-space: none of it repeats with the
      // tile, which is the whole point — the old macro pass lived in tile UV space and
      // therefore *advertised* the repeat instead of hiding it.
      u.uCodMacro = {
        value: new THREE.Vector4(r.macroAmount, r.edgeWear, r.edgeMetal, r.streak),
      };
    }
    if (useVCol) {
      defines.COD_VCOL = '';
      u.uCodVCol = { value: new THREE.Vector4(num(opts.grime, 1), 1 / Math.max(1e-4, 1.6 * uvScale), 0.85, 0) };
      u.uCodGrimeColor = { value: new THREE.Color(opts.grimeColor ?? 0x4a4239) };
    }
    // Second material blended in by vertex colour green (snow drifting onto a ledge,
    // mud pooling in a rut, a painted-on wash). Height-aware so it fills the crevices
    // or covers the peaks depending on what it is meant to be.
    if (opts.layer) {
      const lset = ctx.textures?.pbr?.(this._recipeName(opts.layer) || 'snow_packed') || null;
      if (lset) {
        defines.COD_LAYER = '';
        const lTag = surfaceTagFor(opts.layer);
        const cavity = num(opts.layerCavityBias, lTag === 'snow' ? 0.15 : 0.85);
        u.uCodLayerMap = { value: lset.map };
        u.uCodLayerNormal = { value: lset.normalMap };
        u.uCodLayerOrm = { value: lset.ormMap };
        u.uCodLayer = {
          value: new THREE.Vector4(num(opts.layerGain, 1), num(opts.layerAmount, 0), cavity, num(opts.layerContrast, 1.6)),
        };
        u.uCodLayer2 = {
          value: new THREE.Vector4(
            num(opts.layerUpFacing, lTag === 'snow' ? 1 : 0.4),
            // codUv is metres * uvScale, so this brings it back to metres and then
            // into the layer texture's own worldSize.
            num(opts.layerRepeat, 1) / Math.max(1e-4, uvScale * num(lset.worldSize, 2.5)),
            num(opts.layerRoughness, 1),
            num(opts.layerNormalScale, 1)
          ),
        };
      } else {
        this._note(`layer material "${opts.layer}" is unavailable`);
      }
    }
    if (r.dustAmount > 0) {
      defines.COD_DUST = '';
      u.uCodDustP = {
        value: new THREE.Vector4(r.dustAmount, 1 / Math.max(1e-4, 3.2 * uvScale), 0.14, 2.2),
      };
      u.uCodDustColor = { value: new THREE.Color(opts.dustColor ?? 0xa89d8b) };
    }
    if (r.wetAmount > 0) {
      defines.COD_WET = '';
      u.uCodWet = {
        value: new THREE.Vector4(r.wetAmount, r.porosity, num(opts.puddleLevel, 0.42), num(opts.puddle, 1)),
      };
      // One broad puddle cell every ~6 m of world space.
      u.uCodWet2 = {
        value: new THREE.Vector2(1 / Math.max(1e-4, 6 * uvScale), num(opts.puddleBreakup, 0.85)),
      };
    }
    if (r.sss) {
      defines.COD_SSS = '';
      u.uCodSss = {
        value: new THREE.Vector4(
          num(r.sss.strength, 0.6),
          num(r.sss.power, 3),
          num(r.sss.distortion, 0.3),
          num(r.sss.ambient, 0.06)
        ),
      };
      u.uCodSssColor = { value: new THREE.Color(r.sss.color ?? 0x6f9a3c) };
    }
    if (r.wind) {
      defines.COD_WIND = '';
      u.uCodWindP = {
        value: new THREE.Vector4(
          num(r.wind.stiffness, 0.4),
          num(r.wind.amplitude, 0.12),
          num(r.wind.frequency, 1.5),
          num(r.wind.height, 1.0)
        ),
      };
    }
    if (r.screen) {
      defines.COD_SCREEN = '';
      u.uCodScreen = {
        value: new THREE.Vector4(
          num(r.screen.nits, 4),
          num(r.screen.lines, 200),
          num(r.screen.lineDepth, 0.25),
          num(r.screen.flicker, 0.02)
        ),
      };
      u.uCodScreenTint = { value: new THREE.Color(r.screen.tint ?? 0xaad4ff) };
    }
    if (r.glass) {
      defines.COD_GLASS = '';
      u.uCodGlass = {
        value: new THREE.Vector4(
          num(r.glass.alpha, 0.1),
          num(r.glass.fresnel, 0.9),
          num(r.glass.dirt, 0.4),
          num(r.glass.dirtTiling, 1) / Math.max(1e-4, 1.2 * uvScale)
        ),
      };
    }
    if (r.water) {
      defines.COD_WATER = '';
      const w = r.water;
      const ws = w.waveScale || [2, 5];
      const wsp = w.waveSpeed || [0.04, 0.06];
      const wn = w.normalStrength || [0.8, 0.5];
      u.uCodWave = { value: new THREE.Vector4(ws[0], ws[1], wsp[0], wsp[1]) };
      u.uCodWaveDir = { value: new THREE.Vector4(0.86, 0.51, -0.42, 0.91) };
      u.uCodWaterN = { value: new THREE.Vector4(wn[0], wn[1], num(w.ripples, 1), 0) };
      u.uCodWaterD = {
        value: new THREE.Vector4(num(w.depth, 1), num(w.alphaGain, 1), num(w.foamWidth, 0.2), num(w.vcolDepth, 1)),
      };
      const ab = w.absorb || [0.8, 0.3, 0.2];
      u.uCodAbsorb = { value: new THREE.Vector3(ab[0], ab[1], ab[2]) };
      u.uCodWaterColor = { value: new THREE.Color(w.color ?? 0x2c4a48) };
      u.uCodFoamColor = { value: new THREE.Color(w.foam ?? 0xe4ecea) };
      if (this.reflect.texture) this._wireReflection(u, defines);
    }

    mat.defines = defines;
    extendMaterial(mat, {
      mode: r.water ? 'water' : 'surface',
      uniforms: u,
      onMissingChunk: (c) => this._noteChunk(c),
    });
    this.stats.extended++;

    /* -- self-describing for physics / ballistics / audio / FX ----------- */
    const def = surfaceDefFor(rname);
    mat.userData.codMaterial = rname;
    mat.userData.surface = def.surface;
    mat.userData.codSurface = def.material;
    mat.userData.codWorldSize = worldSize;
    mat.userData.codUvScale = uvScale;
    // Hint for SSR / planar reflection passes: these surfaces are worth tracing.
    if (r.water || r.glass || r.metal[1] > 0.5 || r.rough[0] < 0.08) mat.userData.codReflective = true;

    const meta = { name: rname, recipe: r, uniforms: u, set, opts, triplanar };
    this.meta.set(mat, meta);
    this._applyQuality(mat, meta);
    // Sky owns aerial perspective; it is the documented integration point and without
    // it distant geometry reads as a flat cut-out against the sky.
    if (opts.aerial !== false) {
      this._pendingAerial.add(mat);
      this._drainAerial();
    }
    return mat;
  }

  /** Sky boots after us (order 22 vs 12), so this catches up once it exists. */
  _drainAerial() {
    const apply = this.ctx.sky?.applyAerialPerspective;
    if (typeof apply !== 'function' || this._pendingAerial.size === 0) return;
    for (const mat of this._pendingAerial) {
      try {
        apply(mat);
      } catch (err) {
        this._note('aerial perspective hookup failed', err);
      }
    }
    this._pendingAerial.clear();
  }

  _wireReflection(u, defines) {
    defines.COD_REFLECT = '';
    u.uCodReflect = { value: this.reflect.texture };
    u.uCodReflectMtx = { value: this.reflect.matrix };
    u.uCodReflectP = { value: new THREE.Vector4(this.reflect.strength, this.reflect.distortion, 0, 0) };
  }

  /** Last resort: still textured, still varied — never a flat colour. */
  _emergency(name) {
    const tag = surfaceTagFor(name);
    const mat = new THREE.MeshStandardMaterial({
      name: `cod:${name}:fallback`,
      color: new THREE.Color(0x8a8578),
      roughness: 0.9,
      metalness: tag === 'metal' ? 0.8 : 0.0,
      normalMap: this._shared.detailNormal || this._flatNormal(),
      map: this._shared.grunge || this._flatGrey(),
    });
    mat.userData.codMaterial = resolveSurfaceName(name);
    mat.userData.surface = tag;
    this.all.add(mat);
    return mat;
  }

  /* ------------------------------------------------------------- globals */

  update(dt) {
    const g = this.globals;
    const t = this.ctx.time?.elapsed;
    g.uCodTime.value = Number.isFinite(t) ? t : g.uCodTime.value + (Number.isFinite(dt) ? dt : 0);

    // Wetness eases towards its target so a rain shower does not snap on.
    const step = clamp((Number.isFinite(dt) ? dt : 1 / 60) * 0.35, 0, 1);
    this.wetness += (this.wetTarget - this.wetness) * step;
    g.uCodWetness.value = clamp(this.wetness, 0, 1);
    g.uCodDust.value = clamp(this.dust, 0, 1);

    // Gusts: deterministic, no RNG, so screenshots stay byte-identical.
    const tt = g.uCodTime.value;
    const gust = 0.28 * Math.sin(tt * 0.37) + 0.16 * Math.sin(tt * 0.91 + 1.9) + 0.08 * Math.sin(tt * 2.3 + 0.4);
    g.uCodWind.value.set(Math.cos(this.windAngle), Math.sin(this.windAngle), this.windStrength, gust);

    this._syncLighting();
    this._drainAerial();
  }

  /** Keep the SSS/parallax-shadow light vector in step with whatever is lighting us. */
  _syncLighting() {
    const l = this.ctx.lighting;
    const d = l?.sunDirection || l?.keyDirection;
    if (d && Number.isFinite(d.x)) {
      const v = this.globals.uCodSunDir.value;
      // Lighting reports the direction the sun *points*; we want surface -> light.
      const len = Math.hypot(d.x, d.y, d.z) || 1;
      v.set(d.x / len, d.y / len, d.z / len);
      if (v.y < 0) v.multiplyScalar(-1);
    }
    const c = l?.sunColor;
    if (c?.isColor) this.globals.uCodSunColor.value.copy(c);
  }

  setWetness(v, immediate = false) {
    this.wetTarget = clamp(Number(v) || 0, 0, 1);
    if (immediate) this.wetness = this.wetTarget;
    this.globals.uCodWetness.value = clamp(this.wetness, 0, 1);
    return this.wetTarget;
  }

  setWind(dir, strength) {
    if (Number.isFinite(dir)) this.windAngle = dir;
    else if (dir && Number.isFinite(dir.x)) this.windAngle = Math.atan2(dir.z ?? dir.y ?? 0, dir.x);
    else if (Array.isArray(dir) && dir.length >= 2) this.windAngle = Math.atan2(dir[1], dir[0]);
    if (Number.isFinite(strength)) this.windStrength = clamp(strength, 0, 4);
    this.globals.uCodWind.value.set(
      Math.cos(this.windAngle),
      Math.sin(this.windAngle),
      this.windStrength,
      this.globals.uCodWind.value.w
    );
    return { angle: this.windAngle, strength: this.windStrength };
  }

  setDustLevel(v) {
    this.dust = clamp(Number(v) || 0, 0, 1);
    this.globals.uCodDust.value = this.dust;
    return this.dust;
  }

  setWaterReflection(texture, matrix) {
    this.reflect.texture = texture || null;
    if (matrix?.isMatrix4) this.reflect.matrix.copy(matrix);
    for (const mat of this.all) {
      const m = this.meta.get(mat);
      if (!m?.recipe?.water) continue;
      const u = m.uniforms;
      if (texture) {
        if (!u.uCodReflect) {
          this._wireReflection(u, mat.defines || (mat.defines = {}));
          mat.needsUpdate = true;
        } else {
          u.uCodReflect.value = texture;
        }
      } else if (u.uCodReflect) {
        delete mat.defines.COD_REFLECT;
        mat.needsUpdate = true;
      }
    }
    return !!texture;
  }

  /* --------------------------------------------------------------- extras */

  /**
   * Opt a foreign MeshStandardMaterial into the extension (props, weapons, imported
   * meshes). It must already carry map/normalMap/roughnessMap or the shader has
   * nothing to sample.
   */
  extend(material, opts = {}) {
    if (!material?.isMeshStandardMaterial || material.userData?.codExtended) return material;
    if (!material.map || !material.normalMap || !material.roughnessMap) {
      this._note(`extend() needs map + normalMap + roughnessMap on "${material.name || 'unnamed'}"`);
      return material;
    }
    const uvScale = num(opts.uvScale, 1);
    const u = {
      ...this.globals,
      uCodUvXf: { value: new THREE.Vector4(uvScale, uvScale, 0, 0) },
      // Default the range to the material's own scalars so extending a foreign
      // material does not silently change how it looks.
      uCodRough: {
        value: new THREE.Vector2(num(opts.roughMin, 0.04), num(opts.roughMax, num(material.roughness, 1))),
      },
      uCodMetal: {
        value: new THREE.Vector2(num(opts.metalMin, 0), num(opts.metalMax, num(material.metalness, 1))),
      },
      uCodNrmScale: { value: new THREE.Vector2(num(opts.normalScale, 1), num(opts.normalScale, 1)) },
      uCodAoDirect: { value: num(opts.aoDirect, 0.28) },
      uCodDetailNormal: { value: this._shared.detailNormal },
      uCodGrunge: { value: this._shared.grunge },
      uCodHeightMap: { value: material.displacementMap || this._shared.grunge },
    };
    const defines = { ...(material.defines || {}), COD_EXT: EXT_VERSION };
    if (opts.detail !== false) {
      defines.COD_DETAIL = '';
      u.uCodDetail = { value: new THREE.Vector4(num(opts.detailTiling, 18), 0.45, 0.4, this._q.detailFade) };
    }
    if (opts.wet !== false) {
      defines.COD_WET = '';
      u.uCodWet = { value: new THREE.Vector4(num(opts.wet, 0.8), num(opts.porosity, 0.6), 0.42, 0.6) };
    }
    material.defines = defines;
    extendMaterial(material, { uniforms: u, onMissingChunk: (c) => this._noteChunk(c) });
    this.all.add(material);
    this.meta.set(material, {
      name: material.name || 'external',
      recipe: {
        parallaxAmount: 0,
        pomScale: 0,
        pomClip: 0,
        pomShadow: false,
        detailAmount: opts.detail === false ? 0 : 1,
        detailTiling: num(opts.detailTiling, 18),
        detailNormalStrength: 0.45,
        detailAlbedoStrength: 0.4,
        tileBreakAmount: 0,
        breakScale: 1,
        water: null,
      },
      uniforms: u,
      set: null,
      opts,
    });
    return material;
  }

  /**
   * Generate metre-space UVs from object-space positions by projecting each vertex
   * along its dominant normal axis. Exactly what box/plane level geometry wants, and
   * it makes `get()`'s default UV convention true for hand-built meshes.
   */
  boxUv(geometry, scale = 1) {
    try {
      const pos = geometry?.attributes?.position;
      if (!pos) return geometry;
      let nrm = geometry.attributes.normal;
      if (!nrm) {
        geometry.computeVertexNormals();
        nrm = geometry.attributes.normal;
      }
      const uv = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) * scale;
        const y = pos.getY(i) * scale;
        const z = pos.getZ(i) * scale;
        const nx = Math.abs(nrm.getX(i));
        const ny = Math.abs(nrm.getY(i));
        const nz = Math.abs(nrm.getZ(i));
        let u;
        let v;
        if (ny >= nx && ny >= nz) {
          u = x;
          v = z;
        } else if (nx >= nz) {
          u = z;
          v = y;
        } else {
          u = x;
          v = y;
        }
        uv[i * 2] = u;
        uv[i * 2 + 1] = v;
      }
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      return geometry;
    } catch (err) {
      this._note('boxUv failed', err);
      return geometry;
    }
  }

  textureSet(name) {
    const rname = this._recipeName(name) || 'concrete_cast';
    const setName = RECIPES[rname]?.set || rname;
    return this.ctx.textures?.pbr?.(setName) || null;
  }

  /**
   * The shadow-caster companion for a wind-animated material. Assign the result to
   * `mesh.customDepthMaterial` (and `customDistanceMaterial` for point lights) so the
   * shadow sways with the geometry instead of standing still.
   */
  depthMaterial(name, opts = {}) {
    const cacheKey = `depth|${name}|${opts.variant || ''}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    const rname = this._recipeName(name) || 'concrete_cast';
    const wind = RECIPES[rname]?.wind;
    const base = this.get(name, opts);
    const mat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: base.map || null,
      alphaMap: base.alphaMap || null,
      alphaTest: base.alphaTest || 0,
      side: base.side,
    });
    this.all.add(mat);
    if (wind) {
      const u = {
        ...this.globals,
        uCodWindP: {
          value: new THREE.Vector4(
            num(wind.stiffness, 0.4),
            num(wind.amplitude, 0.12),
            num(wind.frequency, 1.5),
            num(wind.height, 1.0)
          ),
        },
      };
      extendDepthMaterial(mat, { uniforms: u, onMissingChunk: (c) => this._noteChunk(c) });
    }
    this.cache.set(cacheKey, mat);
    return mat;
  }

  /* ---------------------------------------------------------- diagnostics */

  /**
   * Compile-check the shader variants. Runs at boot in headless mode so a GLSL typo
   * shows up in CI instead of the first time somebody looks at a wall.
   */
  _validate() {
    // Invariant: every recipe must have its own SurfaceDefs entry, or `surfaceOf()`
    // silently reports it as concrete and ballistics/audio/FX all get it wrong.
    const orphans = Object.keys(RECIPES).filter((n) => resolveSurfaceName(n) !== n);
    if (orphans.length) {
      console.error(`[materials] recipes missing a SurfaceDefs entry: ${orphans.join(', ')}`);
    }

    const mode = urlParam('matcheck') ?? (this.ctx.settings?.get?.('headless') ? 'core' : 'off');
    if (mode === 'off' || mode === '0') return;
    // Every program costs ~1.2 s to compile on the CI software rasteriser, and this
    // runs before `__BOOTED`, so `core` is deliberately just the *structurally*
    // distinct paths: main surface, triplanar, the water prelude, the wind vertex
    // shader, the vertex-colour layer blend, and the wind depth material. Run
    // `?matcheck=all` by hand when touching the GLSL.
    const names =
      mode === 'all'
        ? Object.keys(RECIPES)
        : ['concrete_cast', 'gravel', 'water_pool', 'foliage_leaf'];
    const t0 = now();
    let rt = null;
    let scene = null;
    try {
      const renderer = this.ctx.renderer;
      if (!renderer) return;
      scene = new THREE.Scene();
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.position.set(1, 2, 1);
      scene.add(light);
      scene.add(new THREE.HemisphereLight(0x8899aa, 0x40382c, 0.4));
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(0.5), 3));
      const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 10);
      cam.position.set(0, 0, 2);
      const probes = names.map((n) => [n, this.get(n)]);
      if (mode !== 'all') {
        // Feature combinations that are not reachable from a plain get(): the
        // vertex-colour layer blend and the wind-animated depth material.
        probes.push([
          'concrete_cast+layer',
          this.get('concrete_cast', {
            vertexColors: true,
            layer: 'snow_packed',
            layerAmount: 0.35,
            variant: 'selftest',
          }),
        ]);
        probes.push(['foliage_leaf/depth', this.depthMaterial('foliage_leaf')]);
      }
      const failed = [];
      for (const [n, m] of probes) {
        if (m?.isMeshDepthMaterial) {
          scene.add(new THREE.Mesh(geo, m));
          continue;
        }
        // `_build` degrades to a fallback instead of throwing, which would otherwise
        // hide a real regression behind a console warning. Make it loud here so the
        // boot smoke test actually gates this module.
        if (!m?.userData?.codExtended) failed.push(n);
        const mesh = new THREE.Mesh(geo, m);
        mesh.position.x = (scene.children.length - 2) * 0.001;
        scene.add(mesh);
      }
      if (failed.length) {
        console.error(`[materials] self-test: ${failed.length} material(s) fell back: ${failed.join(', ')}`);
      }
      rt = new THREE.WebGLRenderTarget(8, 8, { depthBuffer: true });
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(prev);
      geo.dispose();
    } catch (err) {
      this._note('material self-test failed', err);
    } finally {
      try {
        rt?.dispose();
        scene?.clear();
      } catch {
        /* best effort */
      }
    }
    if (!this.ctx.settings?.get?.('headless')) {
      console.log(`[materials] validated ${this.cache.size} variants in ${Math.round(now() - t0)}ms`);
    }
  }

  selfTest() {
    const t0 = now();
    const built = [];
    for (const n of Object.keys(RECIPES)) {
      try {
        if (this.get(n)) built.push(n);
      } catch (err) {
        this._note(`selfTest: ${n} failed`, err);
      }
    }
    return { built: built.length, ms: Math.round(now() - t0), names: built };
  }

  report() {
    return {
      materials: this.cache.size,
      instances: this.all.size,
      built: this.stats.built,
      cacheHits: this.stats.cached,
      extended: this.stats.extended,
      tier: this._q.tier,
      parallax: this._q.parallax,
      pomLayers: this._q.pomLayers,
      detail: this._q.detail,
      tileBreak: this._q.tileBreak,
      wetness: Number(this.wetness.toFixed(3)),
      dust: this.dust,
      wind: { angle: Number(this.windAngle.toFixed(3)), strength: this.windStrength },
      missingChunks: [...this._missingChunks],
      extVersion: EXT_VERSION,
    };
  }

  /* -------------------------------------------------------------- helpers */

  _flatNormal() {
    if (!this._fallbackNormal) {
      const d = new Uint8Array([128, 128, 255, 255]);
      const t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      this._fallbackNormal = t;
    }
    return this._fallbackNormal;
  }

  _flatGrey() {
    if (!this._fallbackGrey) {
      const d = new Uint8Array([128, 128, 128, 255]);
      const t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      this._fallbackGrey = t;
    }
    return this._fallbackGrey;
  }

  _noteChunk(chunk) {
    if (this._missingChunks.has(chunk)) return;
    this._missingChunks.add(chunk);
    console.warn(`[materials] three's <${chunk}> chunk moved; that feature is inactive`);
  }

  _note(msg, err) {
    if (this._warned.has(msg)) return;
    this._warned.add(msg);
    if (!this.ctx.settings?.get?.('headless') || err) console.warn(`[materials] ${msg}`, err || '');
  }
}

/* ------------------------------------------------------------------ utils */

function resolveSide(s) {
  if (s === THREE.DoubleSide || s === THREE.BackSide || s === THREE.FrontSide) return s;
  if (s === 'double' || s === 2) return THREE.DoubleSide;
  if (s === 'back' || s === 1) return THREE.BackSide;
  return THREE.FrontSide;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function urlParam(name) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(name);
  } catch {
    return null;
  }
}

/* ================================================================== system */

/** @returns {import('../core/types.js').System} */
export default function createMaterialLibrary(ctx) {
  const lib = new Library(ctx);

  const globalsView = {
    get uniforms() {
      return lib.globals;
    },
    get time() {
      return lib.globals.uCodTime.value;
    },
    get wetness() {
      return lib.globals.uCodWetness.value;
    },
    set wetness(v) {
      lib.setWetness(v);
    },
    get dustLevel() {
      return lib.dust;
    },
    set dustLevel(v) {
      lib.setDustLevel(v);
    },
    get windStrength() {
      return lib.windStrength;
    },
    set windStrength(v) {
      lib.setWind(undefined, v);
    },
    get windDirection() {
      return new THREE.Vector2(Math.cos(lib.windAngle), Math.sin(lib.windAngle));
    },
    set windDirection(v) {
      lib.setWind(v, undefined);
    },
    get windAngle() {
      return lib.windAngle;
    },
    get wind() {
      return lib.globals.uCodWind.value;
    },
    get sunDirection() {
      return lib.globals.uCodSunDir.value;
    },
  };

  const api = {
    ready: false,
    get: (name, opts) => lib.get(name, opts),
    has: (name) => lib.has(name),
    list: () => lib.list(),
    clone: (name, overrides) => lib.clone(name, overrides),
    decal: (name, opts) => lib.decal(name, opts),
    extend: (material, opts) => lib.extend(material, opts),
    depthMaterial: (name, opts) => lib.depthMaterial(name, opts),
    textureSet: (name) => lib.textureSet(name),
    boxUv: (geometry, scale) => lib.boxUv(geometry, scale),

    /* physical surface identity — ballistics / audio / FX / decals */
    surfaceOf: (x) => surfaceDefFor(x),
    surfaceTag: (x) => surfaceTagFor(x),
    surfaceTags: () => SURFACE_TAGS.slice(),
    rhaEquivalent: (x, thickness) => rhaEquivalent(x, thickness),

    /* world state */
    globals: globalsView,
    setWetness: (v, immediate) => lib.setWetness(v, immediate),
    setWind: (dir, strength) => lib.setWind(dir, strength),
    setDustLevel: (v) => lib.setDustLevel(v),
    setWaterReflection: (tex, mtx) => lib.setWaterReflection(tex, mtx),

    /* diagnostics */
    stats: () => lib.report(),
    selfTest: () => lib.selfTest(),
    dispose: () => lib.dispose(),
    uniformsOf: (m) => m?.userData?.codUniforms || null,
    _impl: lib,
  };

  // Published immediately so any factory that captures ctx.materials gets the real API.
  ctx.materials = api;

  return {
    name: 'materials',
    order: 12,
    async init() {
      ctx.materials = api;
      try {
        lib.init();
        api.ready = true;
      } catch (err) {
        // A material problem must never blank the screen.
        console.warn('[materials] init failed, running with fallbacks', err);
      }
    },
    update(dt) {
      try {
        lib.update(dt);
      } catch (err) {
        console.warn('[materials] update failed', err);
      }
    },
    dispose() {
      lib.dispose();
      api.ready = false;
    },
  };
}
