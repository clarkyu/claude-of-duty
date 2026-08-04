/**
 * SurfaceDefs — the single mapping from a material name to its *physical* identity.
 * Owner: MaterialLibrary agent.
 *
 * Ballistics, audio, FX and decals all read this table. It is deliberately plain data
 * (no THREE import, no side effects) so it can be imported from anywhere, including a
 * worker or a unit test, and so `JSON.stringify` on it always works.
 *
 * Public API (also re-exported through `ctx.materials.surfaceOf(x)`):
 *   SURFACE_TAGS            the 15 tags from ARCHITECTURE.md §5, in order
 *   SURFACE_BASE            per-tag defaults
 *   MATERIAL_SURFACE        per-material overrides
 *   surfaceDefFor(x)        -> frozen SurfaceDef (never null; falls back to concrete)
 *   surfaceTagFor(x)        -> one of SURFACE_TAGS
 *   listSurfaceDefs()       -> SurfaceDef[] for every known material
 *   resolveSurfaceName(x)   -> string name from a material / mesh / hit / string
 *
 * ── SurfaceDef fields ──────────────────────────────────────────────────────────
 *   material        string   the key this def was resolved from
 *   surface         string   ARCHITECTURE §5 tag — drives audio/decal/particle buckets
 *   density         number   kg/m³, real-world
 *   hardness        0..1     0 = snow, 1 = hardened steel. Drives spark/ricochet.
 *   rha             number   mm of RHA equivalent for **one metre** of this material.
 *                            A 0.15 m concrete wall = 0.15 * 150 = 22.5 mm RHA.
 *   maxPenetration  number   metres a 7.62×51 NATO ball round defeats at 100 m.
 *                            Scale by (energy / 3400 J) for other rounds.
 *   energyLoss      0..1     fraction of kinetic energy lost per metre travelled.
 *   penetrable      bool     false = ballistics should stop the round dead.
 *   ricochet        0..1     probability of a ricochet at a *shallow* (>65°) angle.
 *   shatters        bool     spawns shards / removes the panel when hit hard.
 *   impactParticle  string   FX preset id
 *   impactColor     number   0xRRGGBB, sRGB, colour of the debris/dust puff
 *   impactSpark     0..1     spark burst strength
 *   impactSmoke     0..1     dust/smoke puff strength
 *   impactDebris    0..1     chunk count multiplier
 *   decal           string   decal atlas entry, 'none' = do not place one
 *   decalScale      number   metres across for a rifle-calibre hole
 *   scorches        bool     leaves a burn ring for explosions
 *   footstep        string   audio id for a walking footstep
 *   impactSound     string   audio id for a bullet impact
 *   penetrateSound  string   audio id when a round passes through
 *   friction        number   Coulomb friction for the physics solver
 *   restitution     number   bounce for the physics solver
 *   softness        0..1     0 = rigid, 1 = deep/soft (footstep depth, dust kick)
 *   occlusion       0..1     audio low-pass amount when this material blocks a sound
 */

/** ARCHITECTURE.md §5 — use exactly these strings anywhere a surface tag is expected. */
export const SURFACE_TAGS = [
  'concrete',
  'metal',
  'wood',
  'dirt',
  'sand',
  'grass',
  'glass',
  'water',
  'fabric',
  'flesh',
  'rubber',
  'plaster',
  'ceramic',
  'foliage',
  'snow',
];

const TAG_SET = new Set(SURFACE_TAGS);

/* ========================================================================== */
/*                       per-tag physical defaults                            */
/* ========================================================================== */

/** @type {Record<string, object>} */
export const SURFACE_BASE = {
  concrete: {
    density: 2350,
    hardness: 0.72,
    rha: 150,
    maxPenetration: 0.19,
    energyLoss: 0.86,
    penetrable: true,
    ricochet: 0.18,
    shatters: false,
    impactParticle: 'dust',
    impactColor: 0xb2aca2,
    impactSpark: 0.05,
    impactSmoke: 0.7,
    impactDebris: 0.6,
    decal: 'bullethole_concrete',
    decalScale: 0.09,
    scorches: true,
    footstep: 'step_concrete',
    impactSound: 'impact_concrete',
    penetrateSound: 'pen_concrete',
    friction: 0.92,
    restitution: 0.08,
    softness: 0.0,
    occlusion: 0.9,
  },
  metal: {
    density: 7800,
    hardness: 0.95,
    rha: 780,
    maxPenetration: 0.014,
    energyLoss: 0.98,
    penetrable: true,
    ricochet: 0.46,
    shatters: false,
    impactParticle: 'spark',
    impactColor: 0xffc27a,
    impactSpark: 1.0,
    impactSmoke: 0.12,
    impactDebris: 0.15,
    decal: 'bullethole_metal',
    decalScale: 0.06,
    scorches: true,
    footstep: 'step_metal',
    impactSound: 'impact_metal',
    penetrateSound: 'pen_metal',
    friction: 0.58,
    restitution: 0.22,
    softness: 0.0,
    occlusion: 0.95,
  },
  wood: {
    density: 620,
    hardness: 0.32,
    rha: 38,
    maxPenetration: 0.42,
    energyLoss: 0.5,
    penetrable: true,
    ricochet: 0.05,
    shatters: false,
    impactParticle: 'splinter',
    impactColor: 0x9c7548,
    impactSpark: 0.0,
    impactSmoke: 0.35,
    impactDebris: 0.8,
    decal: 'bullethole_wood',
    decalScale: 0.085,
    scorches: true,
    footstep: 'step_wood',
    impactSound: 'impact_wood',
    penetrateSound: 'pen_wood',
    friction: 0.75,
    restitution: 0.14,
    softness: 0.1,
    occlusion: 0.6,
  },
  dirt: {
    density: 1550,
    hardness: 0.24,
    rha: 55,
    maxPenetration: 0.55,
    energyLoss: 0.7,
    penetrable: true,
    ricochet: 0.05,
    shatters: false,
    impactParticle: 'dirt',
    impactColor: 0x6d5a41,
    impactSpark: 0.0,
    impactSmoke: 1.0,
    impactDebris: 0.7,
    decal: 'bullethole_dirt',
    decalScale: 0.13,
    scorches: true,
    footstep: 'step_dirt',
    impactSound: 'impact_dirt',
    penetrateSound: 'pen_soft',
    friction: 0.95,
    restitution: 0.02,
    softness: 0.45,
    occlusion: 0.85,
  },
  sand: {
    density: 1620,
    hardness: 0.14,
    rha: 62,
    maxPenetration: 0.5,
    energyLoss: 0.78,
    penetrable: true,
    ricochet: 0.02,
    shatters: false,
    impactParticle: 'sand',
    impactColor: 0xc4a878,
    impactSpark: 0.0,
    impactSmoke: 1.2,
    impactDebris: 0.4,
    decal: 'bullethole_dirt',
    decalScale: 0.15,
    scorches: false,
    footstep: 'step_sand',
    impactSound: 'impact_sand',
    penetrateSound: 'pen_soft',
    friction: 1.0,
    restitution: 0.0,
    softness: 0.7,
    occlusion: 0.8,
  },
  grass: {
    density: 1350,
    hardness: 0.18,
    rha: 44,
    maxPenetration: 0.6,
    energyLoss: 0.66,
    penetrable: true,
    ricochet: 0.02,
    shatters: false,
    impactParticle: 'dirt',
    impactColor: 0x6a6c3a,
    impactSpark: 0.0,
    impactSmoke: 0.8,
    impactDebris: 0.6,
    decal: 'bullethole_dirt',
    decalScale: 0.12,
    scorches: true,
    footstep: 'step_grass',
    impactSound: 'impact_grass',
    penetrateSound: 'pen_soft',
    friction: 0.96,
    restitution: 0.02,
    softness: 0.5,
    occlusion: 0.7,
  },
  glass: {
    density: 2500,
    hardness: 0.8,
    rha: 48,
    maxPenetration: 0.24,
    energyLoss: 0.35,
    penetrable: true,
    ricochet: 0.02,
    shatters: true,
    impactParticle: 'shard',
    impactColor: 0xd6e6ec,
    impactSpark: 0.0,
    impactSmoke: 0.05,
    impactDebris: 1.0,
    decal: 'bullethole_glass',
    decalScale: 0.16,
    scorches: false,
    footstep: 'step_glass',
    impactSound: 'impact_glass',
    penetrateSound: 'pen_glass',
    friction: 0.35,
    restitution: 0.18,
    softness: 0.0,
    occlusion: 0.45,
  },
  water: {
    density: 1000,
    hardness: 0.0,
    rha: 26,
    maxPenetration: 0.9,
    energyLoss: 0.9,
    penetrable: true,
    ricochet: 0.3,
    shatters: false,
    impactParticle: 'splash',
    impactColor: 0x9fc3cc,
    impactSpark: 0.0,
    impactSmoke: 0.0,
    impactDebris: 0.0,
    decal: 'none',
    decalScale: 0,
    scorches: false,
    footstep: 'step_water',
    impactSound: 'impact_water',
    penetrateSound: 'pen_water',
    friction: 0.2,
    restitution: 0.0,
    softness: 1.0,
    occlusion: 0.3,
  },
  fabric: {
    density: 340,
    hardness: 0.08,
    rha: 7,
    maxPenetration: 1.1,
    energyLoss: 0.2,
    penetrable: true,
    ricochet: 0.0,
    shatters: false,
    impactParticle: 'fibre',
    impactColor: 0x8f8471,
    impactSpark: 0.0,
    impactSmoke: 0.3,
    impactDebris: 0.3,
    decal: 'bullethole_fabric',
    decalScale: 0.05,
    scorches: true,
    footstep: 'step_fabric',
    impactSound: 'impact_fabric',
    penetrateSound: 'pen_soft',
    friction: 0.9,
    restitution: 0.02,
    softness: 0.6,
    occlusion: 0.35,
  },
  flesh: {
    density: 1050,
    hardness: 0.05,
    rha: 14,
    maxPenetration: 0.85,
    energyLoss: 0.55,
    penetrable: true,
    ricochet: 0.0,
    shatters: false,
    impactParticle: 'blood',
    impactColor: 0x7c0d10,
    impactSpark: 0.0,
    impactSmoke: 0.0,
    impactDebris: 0.9,
    decal: 'blood_splat',
    decalScale: 0.22,
    scorches: false,
    footstep: 'step_flesh',
    impactSound: 'impact_flesh',
    penetrateSound: 'pen_flesh',
    friction: 0.85,
    restitution: 0.05,
    softness: 0.8,
    occlusion: 0.5,
  },
  rubber: {
    density: 1150,
    hardness: 0.2,
    rha: 32,
    maxPenetration: 0.35,
    energyLoss: 0.62,
    penetrable: true,
    ricochet: 0.03,
    shatters: false,
    impactParticle: 'rubber',
    impactColor: 0x2a2724,
    impactSpark: 0.0,
    impactSmoke: 0.25,
    impactDebris: 0.5,
    decal: 'bullethole_rubber',
    decalScale: 0.07,
    scorches: true,
    footstep: 'step_rubber',
    impactSound: 'impact_rubber',
    penetrateSound: 'pen_soft',
    friction: 1.15,
    restitution: 0.35,
    softness: 0.3,
    occlusion: 0.6,
  },
  plaster: {
    density: 950,
    hardness: 0.3,
    rha: 28,
    maxPenetration: 0.5,
    energyLoss: 0.42,
    penetrable: true,
    ricochet: 0.04,
    shatters: false,
    impactParticle: 'dust',
    impactColor: 0xe2ddd2,
    impactSpark: 0.0,
    impactSmoke: 1.3,
    impactDebris: 0.8,
    decal: 'bullethole_plaster',
    decalScale: 0.12,
    scorches: true,
    footstep: 'step_concrete',
    impactSound: 'impact_plaster',
    penetrateSound: 'pen_plaster',
    friction: 0.88,
    restitution: 0.06,
    softness: 0.05,
    occlusion: 0.7,
  },
  ceramic: {
    density: 2300,
    hardness: 0.85,
    rha: 96,
    maxPenetration: 0.12,
    energyLoss: 0.8,
    penetrable: true,
    ricochet: 0.22,
    shatters: true,
    impactParticle: 'shard',
    impactColor: 0xe8e4dc,
    impactSpark: 0.1,
    impactSmoke: 0.5,
    impactDebris: 0.9,
    decal: 'bullethole_tile',
    decalScale: 0.14,
    scorches: false,
    footstep: 'step_ceramic',
    impactSound: 'impact_ceramic',
    penetrateSound: 'pen_ceramic',
    friction: 0.62,
    restitution: 0.16,
    softness: 0.0,
    occlusion: 0.8,
  },
  foliage: {
    density: 420,
    hardness: 0.04,
    rha: 3,
    maxPenetration: 2.0,
    energyLoss: 0.08,
    penetrable: true,
    ricochet: 0.0,
    shatters: false,
    impactParticle: 'leaf',
    impactColor: 0x4f6b32,
    impactSpark: 0.0,
    impactSmoke: 0.1,
    impactDebris: 0.6,
    decal: 'none',
    decalScale: 0,
    scorches: true,
    footstep: 'step_foliage',
    impactSound: 'impact_foliage',
    penetrateSound: 'pen_foliage',
    friction: 0.8,
    restitution: 0.05,
    softness: 0.85,
    occlusion: 0.15,
  },
  snow: {
    density: 420,
    hardness: 0.06,
    rha: 9,
    maxPenetration: 1.4,
    energyLoss: 0.32,
    penetrable: true,
    ricochet: 0.01,
    shatters: false,
    impactParticle: 'snow',
    impactColor: 0xeef3f8,
    impactSpark: 0.0,
    impactSmoke: 1.1,
    impactDebris: 0.5,
    decal: 'bullethole_snow',
    decalScale: 0.16,
    scorches: false,
    footstep: 'step_snow',
    impactSound: 'impact_snow',
    penetrateSound: 'pen_soft',
    friction: 0.5,
    restitution: 0.0,
    softness: 0.75,
    occlusion: 0.6,
  },
};

/* ========================================================================== */
/*                     per-material identity + overrides                      */
/* ========================================================================== */

/**
 * Every material the TextureForge produces, plus every specialised material the
 * MaterialLibrary adds on top. `surface` is the §5 tag; anything else overrides the
 * per-tag default. Keep this in sync with MaterialLibrary.RECIPES.
 *
 * @type {Record<string, {surface:string} & Record<string, any>>}
 */
export const MATERIAL_SURFACE = {
  /* ── concrete family ─────────────────────────────────────────────────── */
  concrete_cast: { surface: 'concrete' },
  concrete_precast_panel: { surface: 'concrete', rha: 165, maxPenetration: 0.17 },
  asphalt: {
    surface: 'concrete',
    density: 2240,
    hardness: 0.5,
    rha: 105,
    maxPenetration: 0.28,
    impactColor: 0x3a3835,
    impactSmoke: 0.85,
    ricochet: 0.1,
    footstep: 'step_asphalt',
    impactSound: 'impact_asphalt',
    softness: 0.05,
  },
  sidewalk_paving: { surface: 'concrete', ricochet: 0.24, impactColor: 0xa9a49b },
  brick_red: {
    surface: 'concrete',
    density: 1900,
    hardness: 0.58,
    rha: 92,
    maxPenetration: 0.3,
    impactColor: 0x9b5c46,
    impactParticle: 'dust',
    impactSmoke: 1.0,
    impactDebris: 0.85,
    decal: 'bullethole_brick',
    footstep: 'step_concrete',
    impactSound: 'impact_brick',
    ricochet: 0.12,
  },
  brick_painted: {
    surface: 'plaster',
    density: 1900,
    hardness: 0.56,
    rha: 90,
    maxPenetration: 0.3,
    impactColor: 0xc8bfae,
    decal: 'bullethole_brick',
    impactSound: 'impact_brick',
  },
  rubble: {
    surface: 'concrete',
    density: 1700,
    hardness: 0.55,
    rha: 100,
    maxPenetration: 0.34,
    impactColor: 0x9a938a,
    impactSmoke: 1.2,
    impactDebris: 1.0,
    footstep: 'step_rubble',
    softness: 0.3,
    friction: 1.05,
  },
  roof_shingle: {
    surface: 'concrete',
    density: 1400,
    hardness: 0.4,
    rha: 60,
    maxPenetration: 0.32,
    impactColor: 0x4a4642,
    decalScale: 0.11,
    footstep: 'step_shingle',
  },

  /* ── plaster ─────────────────────────────────────────────────────────── */
  plaster_cracked: { surface: 'plaster' },
  stucco: { surface: 'plaster', hardness: 0.36, rha: 40, impactColor: 0xd8cbb4 },

  /* ── metal ───────────────────────────────────────────────────────────── */
  rusted_steel: {
    surface: 'metal',
    hardness: 0.78,
    rha: 620,
    maxPenetration: 0.011,
    impactColor: 0xa9622c,
    impactSpark: 0.75,
    impactSmoke: 0.3,
    ricochet: 0.38,
  },
  painted_steel_chipped: { surface: 'metal', impactColor: 0xd9d3c6, impactSpark: 0.9 },
  galvanised_metal: {
    surface: 'metal',
    density: 7850,
    hardness: 0.88,
    rha: 720,
    maxPenetration: 0.006,
    impactSpark: 1.0,
    ricochet: 0.52,
    impactSound: 'impact_metal_thin',
    footstep: 'step_metal_thin',
    occlusion: 0.5,
  },
  brushed_aluminium: {
    surface: 'metal',
    density: 2700,
    hardness: 0.62,
    rha: 300,
    maxPenetration: 0.03,
    impactColor: 0xd7dade,
    impactSpark: 0.5,
    ricochet: 0.3,
  },
  corrugated_metal: {
    surface: 'metal',
    density: 7850,
    hardness: 0.86,
    rha: 700,
    maxPenetration: 0.005,
    impactSpark: 1.0,
    ricochet: 0.55,
    impactSound: 'impact_metal_thin',
    occlusion: 0.4,
  },

  /* ── wood ────────────────────────────────────────────────────────────── */
  wood_plank_weathered: { surface: 'wood' },
  wood_ply: { surface: 'wood', density: 560, rha: 34, maxPenetration: 0.46 },
  plywood_painted: { surface: 'wood', density: 560, rha: 34, impactColor: 0xbdb49f },

  /* ── ground ──────────────────────────────────────────────────────────── */
  sand: { surface: 'sand' },
  dirt_packed: { surface: 'dirt' },
  gravel: {
    surface: 'dirt',
    density: 1750,
    hardness: 0.45,
    rha: 74,
    maxPenetration: 0.4,
    impactColor: 0x8d867c,
    ricochet: 0.12,
    footstep: 'step_gravel',
    impactSound: 'impact_gravel',
    softness: 0.4,
    friction: 1.05,
  },
  dry_grass_ground: { surface: 'grass' },
  snow_packed: { surface: 'snow' },

  /* ── fabric ──────────────────────────────────────────────────────────── */
  fabric_canvas: { surface: 'fabric' },
  tarp: { surface: 'fabric', density: 420, impactColor: 0x2f5b52, occlusion: 0.25 },
  sandbag: {
    surface: 'fabric',
    density: 1600,
    hardness: 0.16,
    rha: 118,
    maxPenetration: 0.22,
    energyLoss: 0.82,
    impactParticle: 'sand',
    impactColor: 0xbda476,
    impactSmoke: 1.3,
    decal: 'bullethole_fabric',
    footstep: 'step_sand',
    impactSound: 'impact_sandbag',
    softness: 0.5,
    occlusion: 0.9,
  },
  carpet_worn: {
    surface: 'fabric',
    density: 480,
    impactColor: 0x5b4a3e,
    footstep: 'step_carpet',
    softness: 0.55,
  },

  /* ── glass / ceramic ─────────────────────────────────────────────────── */
  glass_dirty: { surface: 'glass' },
  glass_clear: { surface: 'glass' },
  glass_cracked: { surface: 'glass', hardness: 0.6, rha: 34, shatters: true, impactDebris: 1.4 },
  glass_refractive: { surface: 'glass', density: 2550, rha: 55, maxPenetration: 0.2 },
  ceramic_tile: { surface: 'ceramic' },
  marble_lobby: {
    surface: 'ceramic',
    density: 2700,
    hardness: 0.8,
    rha: 120,
    maxPenetration: 0.14,
    impactColor: 0xe6e3dd,
    footstep: 'step_marble',
    shatters: false,
  },

  /* ── misc ────────────────────────────────────────────────────────────── */
  rubber_tyre: { surface: 'rubber' },

  /* ── specialised (MaterialLibrary-only) ──────────────────────────────── */
  water_pool: { surface: 'water' },
  water_deep: { surface: 'water', maxPenetration: 1.4 },
  foliage_leaf: { surface: 'foliage' },
  foliage_bush: { surface: 'foliage' },
  foliage_grass: { surface: 'foliage', impactColor: 0x6d7a3c, softness: 0.9 },
  skin: { surface: 'flesh' },
  skin_head: { surface: 'flesh', impactDebris: 1.3 },
  fabric_uniform: {
    surface: 'fabric',
    density: 520,
    rha: 9,
    impactColor: 0x4d5240,
    footstep: 'step_fabric',
  },
  fabric_webbing: { surface: 'fabric', density: 700, rha: 14, hardness: 0.14 },
  screen_display: {
    surface: 'glass',
    hardness: 0.65,
    rha: 30,
    shatters: true,
    impactColor: 0x8fb8d0,
    impactSound: 'impact_glass',
  },
  sign_emissive: {
    surface: 'metal',
    hardness: 0.6,
    rha: 200,
    maxPenetration: 0.02,
    impactSpark: 0.8,
    shatters: false,
  },
  light_panel: {
    surface: 'glass',
    hardness: 0.55,
    rha: 22,
    shatters: true,
    impactColor: 0xf0f4ff,
  },
};

/* ========================================================================== */
/*                          aliases + resolution                              */
/* ========================================================================== */

/** Forgiving lookup: short/common names people will actually type. */
export const MATERIAL_ALIASES = {
  concrete: 'concrete_cast',
  concrete_panel: 'concrete_precast_panel',
  road: 'asphalt',
  tarmac: 'asphalt',
  pavement: 'sidewalk_paving',
  sidewalk: 'sidewalk_paving',
  brick: 'brick_red',
  plaster: 'plaster_cracked',
  steel: 'rusted_steel',
  rust: 'rusted_steel',
  metal: 'painted_steel_chipped',
  painted_metal: 'painted_steel_chipped',
  sheet_metal: 'galvanised_metal',
  aluminium: 'brushed_aluminium',
  aluminum: 'brushed_aluminium',
  corrugated: 'corrugated_metal',
  wood: 'wood_plank_weathered',
  plank: 'wood_plank_weathered',
  plywood: 'wood_ply',
  dirt: 'dirt_packed',
  ground: 'dirt_packed',
  grass: 'dry_grass_ground',
  snow: 'snow_packed',
  canvas: 'fabric_canvas',
  carpet: 'carpet_worn',
  glass: 'glass_dirty',
  window: 'glass_dirty',
  tile: 'ceramic_tile',
  marble: 'marble_lobby',
  shingle: 'roof_shingle',
  tyre: 'rubber_tyre',
  tire: 'rubber_tyre',
  rubber: 'rubber_tyre',
  water: 'water_pool',
  foliage: 'foliage_leaf',
  leaf: 'foliage_leaf',
  bush: 'foliage_bush',
  flesh: 'skin',
  cloth: 'fabric_uniform',
  uniform: 'fabric_uniform',
  screen: 'screen_display',
  monitor: 'screen_display',
  sign: 'sign_emissive',
  neon: 'sign_emissive',
};

/**
 * Accepts a name, a THREE.Material, a Mesh, or a physics Hit and digs out the best
 * material name it can find. Never throws.
 * @returns {string}
 */
export function resolveSurfaceName(x) {
  if (x == null) return 'concrete_cast';
  if (typeof x === 'string') return canonicalName(x);
  // physics Hit / bullet:impact payload
  if (typeof x === 'object') {
    const ud = x.userData;
    if (ud) {
      if (typeof ud.codMaterial === 'string') return canonicalName(ud.codMaterial);
      if (typeof ud.material === 'string') return canonicalName(ud.material);
      if (typeof ud.surface === 'string') return canonicalName(ud.surface);
    }
    if (typeof x.codMaterial === 'string') return canonicalName(x.codMaterial);
    if (x.material && x.material !== x) {
      const inner = resolveSurfaceName(x.material);
      if (inner !== 'concrete_cast') return inner;
    }
    if (typeof x.surface === 'string') return canonicalName(x.surface);
    if (typeof x.name === 'string' && x.name) return canonicalName(x.name);
  }
  return 'concrete_cast';
}

function canonicalName(raw) {
  const s = String(raw).trim();
  if (Object.prototype.hasOwnProperty.call(MATERIAL_SURFACE, s)) return s;
  const lower = s.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MATERIAL_SURFACE, lower)) return lower;
  if (Object.prototype.hasOwnProperty.call(MATERIAL_ALIASES, lower)) return MATERIAL_ALIASES[lower];
  // A bare §5 tag is a legal input — resolve it to a representative material.
  if (TAG_SET.has(lower)) return TAG_FALLBACK[lower];
  // Suffixed clones ("brick_red#2", "concrete_cast.decal") still resolve.
  const cut = lower.split(/[#|@]/)[0].replace(/\.(decal|lod\d+|inst)$/, '');
  if (Object.prototype.hasOwnProperty.call(MATERIAL_SURFACE, cut)) return cut;
  if (Object.prototype.hasOwnProperty.call(MATERIAL_ALIASES, cut)) return MATERIAL_ALIASES[cut];
  return 'concrete_cast';
}

/** One representative material per §5 tag, for when only a tag is known. */
const TAG_FALLBACK = {
  concrete: 'concrete_cast',
  metal: 'painted_steel_chipped',
  wood: 'wood_plank_weathered',
  dirt: 'dirt_packed',
  sand: 'sand',
  grass: 'dry_grass_ground',
  glass: 'glass_dirty',
  water: 'water_pool',
  fabric: 'fabric_canvas',
  flesh: 'skin',
  rubber: 'rubber_tyre',
  plaster: 'plaster_cracked',
  ceramic: 'ceramic_tile',
  foliage: 'foliage_leaf',
  snow: 'snow_packed',
};

/* ========================================================================== */
/*                               public lookups                               */
/* ========================================================================== */

const _cache = new Map();

/**
 * Full physical description of a material. Always returns a frozen object — callers
 * can hold onto it, and a typo resolves to concrete rather than crashing ballistics.
 * @param {string|object} x
 */
export function surfaceDefFor(x) {
  const name = resolveSurfaceName(x);
  const hit = _cache.get(name);
  if (hit) return hit;
  const over = MATERIAL_SURFACE[name] || { surface: 'concrete' };
  const tag = TAG_SET.has(over.surface) ? over.surface : 'concrete';
  const def = Object.freeze({
    material: name,
    ...SURFACE_BASE[tag],
    ...over,
    surface: tag,
  });
  _cache.set(name, def);
  return def;
}

/** @returns {string} one of SURFACE_TAGS */
export function surfaceTagFor(x) {
  return surfaceDefFor(x).surface;
}

/** Every known material, resolved. */
export function listSurfaceDefs() {
  return Object.keys(MATERIAL_SURFACE).map(surfaceDefFor);
}

/** Names of every material this table knows about. */
export function listSurfaceNames() {
  return Object.keys(MATERIAL_SURFACE);
}

/** True if `name` (after alias resolution) is a material this table describes. */
export function hasSurfaceDef(name) {
  if (typeof name !== 'string') return false;
  const s = name.trim();
  const lower = s.toLowerCase();
  return (
    Object.prototype.hasOwnProperty.call(MATERIAL_SURFACE, s) ||
    Object.prototype.hasOwnProperty.call(MATERIAL_SURFACE, lower) ||
    Object.prototype.hasOwnProperty.call(MATERIAL_ALIASES, lower) ||
    TAG_SET.has(lower)
  );
}

/**
 * mm of RHA equivalent for `thickness` metres of this material — the number
 * Ballistics wants when deciding whether a round makes it through a wall.
 */
export function rhaEquivalent(x, thickness) {
  const d = surfaceDefFor(x);
  return d.rha * Math.max(0, thickness || 0);
}

export default {
  SURFACE_TAGS,
  SURFACE_BASE,
  MATERIAL_SURFACE,
  MATERIAL_ALIASES,
  surfaceDefFor,
  surfaceTagFor,
  listSurfaceDefs,
  listSurfaceNames,
  hasSurfaceDef,
  resolveSurfaceName,
  rhaEquivalent,
};
