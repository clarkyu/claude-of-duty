/**
 * destruction/Classes.js — what each breakable material *is*. Owner: destruction agent.
 *
 * A class answers five questions:
 *   how much punishment does it take          (hp, per m² of face area)
 *   what does partial damage look like        (states + the decal stage each maps to)
 *   how does it come apart                    (fracture distribution + fragment count)
 *   what does the fresh break look like       (interior material — the whole point)
 *   what comes off it                         (debris particles, dust, sound)
 *
 * Interior materials are the detail that separates a real destruction system from a
 * mesh swap. Snap a painted plaster wall and you see brick and grey substrate, not more
 * paint. Split a stained plank and the core is pale and fibrous. Shear sheet steel and
 * the tear is bright, unoxidised metal. Every entry below names both.
 *
 * Exports: CLASSES, classFor, MaterialResolver.
 */

/**
 * @typedef {object} BreakClass
 * @property {string} surface     ARCHITECTURE §5 tag, drives audio/FX/decals
 * @property {number} hp          hit points per square metre of the largest face
 * @property {number} minHp       floor, so a tiny pot is not a one-frame kill
 * @property {string} dist        fracture distribution (see Patterns.js)
 * @property {number} cells       fragment count at `high`
 * @property {string[]} states    damage state names, last one is 'broken'
 * @property {string} interior    material name for the fresh break faces
 * @property {number} interiorTint  colour multiplier applied to that material
 * @property {number} debris      debris particle multiplier
 * @property {number} dust        dust-puff multiplier
 * @property {number} impulse     how hard fragments are thrown, m/s per unit energy
 * @property {number} life        fragment lifetime in seconds
 * @property {string} breakSound  audio id
 */

/** @type {Record<string, BreakClass>} */
export const CLASSES = {
  glass: {
    surface: 'glass',
    hp: 26,
    minHp: 7,
    dist: 'radial',
    cells: 16,
    states: ['intact', 'cracked', 'shattered', 'broken'],
    exterior: 'glass_dirty',
    interior: 'glass_cracked',
    interiorTint: 0xdfe8ea,
    debris: 1.4,
    dust: 0.1,
    impulse: 1.5,
    life: 5,
    settle: 0.9,
    breakSound: 'glass_shatter',
    hitSound: 'glass_crack',
    noShadow: true,
  },
  vehicle_glass: {
    surface: 'glass',
    hp: 34,
    minHp: 9,
    dist: 'shard',
    cells: 20,
    states: ['intact', 'cracked', 'crazed', 'broken'],
    exterior: 'glass_dirty',
    interior: 'glass_cracked',
    interiorTint: 0xcfd8da,
    debris: 1.6,
    dust: 0.08,
    impulse: 1.2,
    life: 5,
    settle: 0.9,
    breakSound: 'glass_shatter_safety',
    hitSound: 'glass_crack',
    noShadow: true,
  },
  ceramic: {
    surface: 'ceramic',
    hp: 90,
    minHp: 10,
    dist: 'shard',
    cells: 14,
    states: ['intact', 'chipped', 'broken'],
    exterior: 'ceramic_tile',
    // Under the glaze a tile is unfired-looking biscuit — pale, matte, porous.
    interior: 'ceramic_tile',
    interiorTint: 0xbdb2a2,
    debris: 1.1,
    dust: 0.55,
    impulse: 1.1,
    life: 8,
    settle: 1.6,
    breakSound: 'ceramic_break',
    hitSound: 'impact_ceramic',
  },
  pot: {
    surface: 'ceramic',
    hp: 70,
    minHp: 9,
    dist: 'shard',
    cells: 12,
    states: ['intact', 'cracked', 'broken'],
    exterior: 'ceramic_tile',
    interior: 'ceramic_tile',
    interiorTint: 0xa8825f,
    debris: 1.2,
    dust: 0.8,
    impulse: 1.2,
    life: 9,
    settle: 1.6,
    breakSound: 'pot_break',
    hitSound: 'impact_ceramic',
    spill: 'dirt',
  },
  plaster: {
    surface: 'plaster',
    hp: 150,
    minHp: 40,
    dist: 'chunk',
    cells: 12,
    states: ['intact', 'chipped', 'spalled', 'broken'],
    exterior: 'plaster_cracked',
    // Paint and skim come off; what is behind it is brick.
    interior: 'brick_red',
    interiorTint: 0x9a6a54,
    debris: 1.0,
    dust: 1.5,
    impulse: 0.9,
    life: 11,
    settle: 2.0,
    breakSound: 'plaster_break',
    hitSound: 'impact_plaster',
  },
  concrete: {
    surface: 'concrete',
    hp: 420,
    minHp: 120,
    dist: 'chunk',
    cells: 10,
    states: ['intact', 'chipped', 'cracked', 'broken'],
    exterior: 'concrete_cast',
    interior: 'concrete_cast',
    interiorTint: 0x8e8880,
    debris: 0.9,
    dust: 1.4,
    impulse: 0.8,
    life: 12,
    settle: 2.4,
    breakSound: 'concrete_break',
    hitSound: 'impact_concrete',
  },
  wood: {
    surface: 'wood',
    hp: 150,
    minHp: 26,
    dist: 'strip',
    cells: 12,
    states: ['intact', 'splintered', 'holed', 'broken'],
    exterior: 'wood_plank_weathered',
    // Under the stain and grey weathering the core is pale and fibrous.
    interior: 'wood_ply',
    interiorTint: 0xd8bd90,
    debris: 1.3,
    dust: 0.45,
    impulse: 1.15,
    life: 10,
    settle: 1.8,
    breakSound: 'wood_break',
    hitSound: 'impact_wood',
  },
  crate: {
    surface: 'wood',
    hp: 120,
    minHp: 24,
    dist: 'strip',
    cells: 14,
    states: ['intact', 'splintered', 'broken'],
    exterior: 'wood_plank_weathered',
    interior: 'wood_ply',
    interiorTint: 0xdcc296,
    debris: 1.5,
    dust: 0.5,
    impulse: 1.35,
    life: 10,
    settle: 1.8,
    breakSound: 'crate_break',
    hitSound: 'impact_wood',
  },
  pallet: {
    surface: 'wood',
    hp: 90,
    minHp: 20,
    dist: 'strip',
    cells: 10,
    states: ['intact', 'splintered', 'broken'],
    exterior: 'wood_plank_weathered',
    interior: 'wood_ply',
    interiorTint: 0xd6bb8d,
    debris: 1.4,
    dust: 0.4,
    impulse: 1.4,
    life: 10,
    settle: 1.7,
    breakSound: 'crate_break',
    hitSound: 'impact_wood',
  },
  sheet_metal: {
    surface: 'metal',
    hp: 260,
    minHp: 55,
    dist: 'panel',
    cells: 7,
    states: ['intact', 'dented', 'holed', 'broken'],
    exterior: 'corrugated_metal',
    // A tear in galvanised sheet is bright and raw before it has any time to oxidise.
    interior: 'brushed_aluminium',
    interiorTint: 0xb9bec4,
    debris: 0.7,
    dust: 0.12,
    impulse: 1.2,
    life: 11,
    settle: 2.0,
    breakSound: 'metal_tear',
    hitSound: 'impact_metal_thin',
    deforms: true,
  },
  chain_link: {
    surface: 'metal',
    hp: 170,
    minHp: 45,
    dist: 'panel',
    cells: 6,
    states: ['intact', 'bowed', 'broken'],
    exterior: 'galvanised_metal',
    interior: 'brushed_aluminium',
    interiorTint: 0xa8adb2,
    debris: 0.5,
    dust: 0.05,
    impulse: 1.0,
    life: 9,
    settle: 1.6,
    breakSound: 'chainlink_break',
    hitSound: 'impact_metal_thin',
    noShadow: true,
  },
  drum: {
    surface: 'metal',
    hp: 280,
    minHp: 90,
    dist: 'panel',
    cells: 9,
    states: ['intact', 'dented', 'leaking', 'broken'],
    exterior: 'rusted_steel',
    interior: 'brushed_aluminium',
    interiorTint: 0x8d8478,
    debris: 0.9,
    dust: 0.3,
    impulse: 1.6,
    life: 12,
    settle: 2.2,
    breakSound: 'drum_burst',
    hitSound: 'impact_metal',
    deforms: true,
    volatile: true,
  },
  awning: {
    surface: 'fabric',
    hp: 60,
    minHp: 16,
    dist: 'panel',
    cells: 6,
    states: ['intact', 'torn', 'broken'],
    exterior: 'tarp',
    interior: 'fabric_canvas',
    interiorTint: 0xbfae90,
    debris: 0.5,
    dust: 0.5,
    impulse: 0.75,
    life: 9,
    settle: 1.4,
    breakSound: 'fabric_tear',
    hitSound: 'impact_fabric',
    noShadow: true,
  },
  vehicle_panel: {
    surface: 'metal',
    hp: 400,
    minHp: 140,
    dist: 'panel',
    cells: 8,
    states: ['intact', 'dented', 'buckled', 'broken'],
    exterior: 'painted_steel_chipped',
    interior: 'rusted_steel',
    interiorTint: 0x8a7f74,
    debris: 0.8,
    dust: 0.2,
    impulse: 1.3,
    life: 12,
    settle: 2.2,
    breakSound: 'metal_tear',
    hitSound: 'impact_metal',
    deforms: true,
  },
  plastic: {
    surface: 'rubber',
    hp: 80,
    minHp: 14,
    dist: 'panel',
    cells: 8,
    states: ['intact', 'cracked', 'broken'],
    exterior: 'rubber_tyre',
    interior: 'rubber_tyre',
    interiorTint: 0x8f8a84,
    debris: 0.9,
    dust: 0.15,
    impulse: 1.3,
    life: 8,
    settle: 1.4,
    breakSound: 'plastic_break',
    hitSound: 'impact_rubber',
  },
  cardboard: {
    surface: 'fabric',
    hp: 40,
    minHp: 8,
    dist: 'panel',
    cells: 6,
    states: ['intact', 'torn', 'broken'],
    exterior: 'fabric_canvas',
    interior: 'fabric_canvas',
    interiorTint: 0xb59a72,
    debris: 0.7,
    dust: 0.35,
    impulse: 1.0,
    life: 8,
    settle: 1.2,
    breakSound: 'cardboard_crush',
    hitSound: 'impact_fabric',
    noShadow: true,
  },
};

/** §5 surface tag -> the class that best describes breaking it. */
const SURFACE_CLASS = {
  glass: 'glass',
  ceramic: 'ceramic',
  plaster: 'plaster',
  concrete: 'concrete',
  wood: 'wood',
  metal: 'sheet_metal',
  fabric: 'awning',
  rubber: 'plastic',
  dirt: 'concrete',
  sand: 'concrete',
  grass: 'concrete',
  snow: 'concrete',
};

/** Prop type (props/catalog.js) -> class. Anything absent falls back to its surface. */
export const PROP_CLASS = {
  wood_crate: 'crate',
  ammo_crate: 'crate',
  produce_crate: 'crate',
  pallet: 'pallet',
  cable_spool: 'crate',
  oil_drum: 'drum',
  gas_cylinder: 'drum',
  jerry_can: 'plastic',
  cardboard_box: 'cardboard',
  bin: 'plastic',
  plastic_chair: 'plastic',
  cafe_table: 'plastic',
  planter: 'pot',
  market_stall: 'awning',
  tarp_cover: 'awning',
  chain_link: 'chain_link',
  razor_wire: 'chain_link',
  shop_sign: 'sheet_metal',
  shop_shutter: 'sheet_metal',
  utility_box: 'sheet_metal',
  ac_unit: 'sheet_metal',
  ac_unit_roof: 'sheet_metal',
  water_tank: 'plastic',
  satellite_dish: 'sheet_metal',
  traffic_sign: 'sheet_metal',
  bus_shelter: 'glass',
  tv_aerial: 'chain_link',
  hatchback: 'vehicle_panel',
  pickup: 'vehicle_panel',
  van: 'vehicle_panel',
  sedan: 'vehicle_panel',
  truck: 'vehicle_panel',
  car: 'vehicle_panel',
};

/** Resolve a class from an explicit name, a prop type or a §5 surface tag. */
export function classFor(name, surfaceTag) {
  if (name && CLASSES[name]) return name;
  if (name && PROP_CLASS[name]) return PROP_CLASS[name];
  if (surfaceTag && SURFACE_CLASS[surfaceTag]) return SURFACE_CLASS[surfaceTag];
  return 'concrete';
}

/**
 * Builds and owns the interior materials — one clone per class, made eagerly at init
 * so `boot:done` triggers exactly one lighting rescan and no material is ever created
 * inside a gameplay frame.
 */
export class MaterialResolver {
  constructor(ctx) {
    this.ctx = ctx;
    this.interior = new Map();
    this.exterior = new Map();
    this.fallback = null;
  }

  build() {
    const lib = this.ctx.materials;
    if (!lib?.clone) return;
    for (const [id, def] of Object.entries(CLASSES)) {
      try {
        const m = lib.clone(def.interior, {
          color: def.interiorTint,
          vertexColors: true,
          variant: `break_int_${id}`,
          name: `break_interior_${id}`,
          // A fresh break is matte and open-pored: no gloss, no accumulated wetness.
          grime: 0.12,
          dust: 0.25,
          wet: 0.15,
          normalScale: 1.25,
          repeat: 1.6,
        });
        if (m) this.interior.set(id, m);
      } catch {
        /* a missing interior variant must never stop a break */
      }
      try {
        const m = lib.get(def.exterior, { vertexColors: true, variant: 'break_ext' });
        if (m) this.exterior.set(id, m);
      } catch {
        /* falls back below */
      }
    }
    try {
      this.fallback = lib.get('concrete_cast', { vertexColors: true, variant: 'break_ext' });
    } catch {
      this.fallback = null;
    }
  }

  interiorFor(cls) {
    return this.interior.get(cls) || this.exterior.get(cls) || this.fallback;
  }

  exteriorFor(cls, srcMaterial) {
    // Prefer the object's own material so a fragment matches the thing it came off.
    if (srcMaterial && !Array.isArray(srcMaterial)) return srcMaterial;
    if (Array.isArray(srcMaterial) && srcMaterial[0]) return srcMaterial[0];
    return this.exterior.get(cls) || this.fallback;
  }

  dispose() {
    for (const m of this.interior.values()) m?.dispose?.();
    this.interior.clear();
    this.exterior.clear();
  }
}

export default CLASSES;
