/**
 * props/catalog.js — the prop type registry. Owner: props agent.
 *
 * One entry per spawnable type. `kind` decides how the prop is committed to the world:
 *
 *   'static'   merged into its district's batch, one static collider set          (default)
 *   'dynamic'  its own mesh + a physics body with mass, so it can be shot and shoved
 *   'solo'     its own mesh + LOD + static colliders (vehicles, big furniture)
 *   'flat'     merged, no collider at all (litter, grates, manhole lids, decals)
 *   'attach'   merged, no collider, mounted on a wall/roof rather than the ground
 *
 * `mass` (kg) is only read for 'dynamic'. `lod` false opts out of the box-shell LOD.
 */
import * as street from './street.js';
import * as military from './military.js';
import * as civilian from './civilian.js';
import * as vehicles from './vehicles.js';

/** @type {Record<string, {gen:Function, kind?:string, mass?:number, lod?:boolean, tall?:boolean}>} */
export const CATALOG = {
  /* ── street furniture ────────────────────────────────────────────────── */
  lamp_post: { gen: street.lampPost, kind: 'static', tall: true },
  bollard: { gen: street.bollard, kind: 'static' },
  kerb_run: { gen: street.kerbRun, kind: 'static', lod: false },
  /* ground structure at 1-3 m — see the note above roadPatch() in street.js */
  road_patch: { gen: street.roadPatch, kind: 'flat', lod: false },
  pothole: { gen: street.pothole, kind: 'flat', lod: false },
  sand_drift: { gen: street.sandDrift, kind: 'flat', lod: false },
  gutter_run: { gen: street.gutterRun, kind: 'flat', lod: false },
  drain_grate: { gen: street.drainGrate, kind: 'flat', lod: false },
  manhole: { gen: street.manholeCover, kind: 'flat', lod: false },
  traffic_sign: { gen: street.trafficSign, kind: 'static', tall: true },
  bus_shelter: { gen: street.busShelter, kind: 'static' },
  bench: { gen: street.bench, kind: 'static' },
  planter: { gen: street.planter, kind: 'static' },
  hydrant: { gen: street.hydrant, kind: 'static' },
  utility_box: { gen: street.utilityBox, kind: 'static' },
  ac_unit: { gen: street.acUnit, kind: 'attach' },
  ac_unit_roof: { gen: (a, r, o) => street.acUnit(a, r, { ...o, wall: false }), kind: 'static' },
  bin: { gen: street.rubbishBin, kind: 'dynamic', mass: 24 },
  downpipe: { gen: street.downpipe, kind: 'attach' },
  wall_conduit: { gen: street.wallConduit, kind: 'attach', lod: false },
  wall_vent: { gen: street.wallVent, kind: 'attach', lod: false },
  meter_box: { gen: street.meterBox, kind: 'attach', lod: false },

  /* ── conflict dressing ───────────────────────────────────────────────── */
  sandbag_wall: { gen: military.sandbagWall, kind: 'static' },
  sandbag_pile: { gen: military.sandbagPile, kind: 'static' },
  jersey_barrier: { gen: military.jerseyBarrier, kind: 'static' },
  hesco: { gen: military.hesco, kind: 'static' },
  razor_wire: { gen: military.razorWire, kind: 'attach', lod: false },
  chain_link: { gen: military.chainLink, kind: 'static', lod: false },
  pallet: { gen: military.pallet, kind: 'dynamic', mass: 22 },
  ammo_crate: { gen: military.ammoCrate, kind: 'dynamic', mass: 34 },
  wood_crate: { gen: military.woodCrate, kind: 'dynamic', mass: 28 },
  oil_drum: { gen: military.oilDrum, kind: 'dynamic', mass: 32 },
  jerry_can: { gen: military.jerryCan, kind: 'dynamic', mass: 18 },
  tyre_stack: { gen: military.tyreStack, kind: 'static' },
  tyre: { gen: military.tyre, kind: 'dynamic', mass: 8 },
  cable_spool: { gen: military.cableSpool, kind: 'static' },

  /* ── people ──────────────────────────────────────────────────────────────
   * Static, merged into the district batch, no colliders: these are set dressing,
   * not actors — the AI system owns anything that has to be shot at. `attach` (not
   * `flat`) because they must cast shadows and must live in a real district so they
   * cull: `flat` sends geometry to the shared detail bucket, which never casts and is
   * dropped wholesale on the low tier. `lod: false` skips the box-shell — a
   * person-shaped box is worse than nothing. Callers pass `force: true`, because a
   * vendor standing BEHIND a counter is the entire point and the overlap grid would
   * reject every one of them. See props/civilian.js. */
  vendor: { gen: civilian.vendor, kind: 'attach', lod: false },
  civilian: { gen: civilian.civilianStanding, kind: 'attach', lod: false },
  squatter: { gen: civilian.squatter, kind: 'attach', lod: false },
  porter: { gen: civilian.porter, kind: 'attach', lod: false },

  /* ── civilian life ───────────────────────────────────────────────────── */
  market_stall: { gen: civilian.marketStall, kind: 'static' },
  produce_crate: { gen: civilian.produceCrate, kind: 'dynamic', mass: 9 },
  plastic_chair: { gen: civilian.plasticChair, kind: 'dynamic', mass: 5 },
  cafe_table: { gen: civilian.cafeTable, kind: 'dynamic', mass: 11 },
  laundry_line: { gen: civilian.laundryLine, kind: 'attach', lod: false },
  satellite_dish: { gen: civilian.satelliteDish, kind: 'attach', lod: false },
  water_tank: { gen: civilian.waterTank, kind: 'static' },
  tv_aerial: { gen: civilian.tvAerial, kind: 'static', lod: false },
  chimney_flue: { gen: civilian.chimneyFlue, kind: 'static' },
  dish_farm: { gen: civilian.dishFarm, kind: 'static', lod: false },
  shop_sign: { gen: civilian.shopSign, kind: 'attach', lod: false },
  shop_shutter: { gen: civilian.shopShutter, kind: 'attach', lod: false },
  /* the written world — see props/signage.js */
  wall_mark: { gen: civilian.wallMark, kind: 'attach', lod: false },
  road_mark: { gen: civilian.roadMark, kind: 'flat', lod: false },
  cardboard_box: { gen: civilian.cardboardBox, kind: 'dynamic', mass: 3 },
  litter: { gen: civilian.litter, kind: 'flat', lod: false },
  rubble_pile: { gen: civilian.rubblePile, kind: 'static' },
  tarp_cover: { gen: civilian.tarpCover, kind: 'static' },
  gas_cylinder: { gen: civilian.gasCylinder, kind: 'dynamic', mass: 26 },

  /* ── vehicles ────────────────────────────────────────────────────────── */
  hatchback: { gen: vehicles.hatchback, kind: 'static' },
  pickup: { gen: vehicles.pickup, kind: 'static' },
};

export const TYPES = Object.keys(CATALOG);

export default CATALOG;
