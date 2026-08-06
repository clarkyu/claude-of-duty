/**
 * props/placement.js — where the clutter goes. Owner: props agent.
 *
 * Uniform scatter is what makes a level look procedurally generated. Real streets
 * accumulate stuff for *reasons*, so this file composes in clusters with intent:
 *
 *   - rubbish drifts into corners and blows up against walls;
 *   - crates, pallets and drums stack at loading points and inside yards;
 *   - barriers form lines *across* a lane, never along the middle of one;
 *   - stalls line the plaza and the souk, facing the street;
 *   - roofs carry tanks, aerials, dishes and AC plant;
 *   - vehicles park nose-in against kerbs, never in the middle of a firing lane.
 *
 * Everything is discovered by **raycast**, not by importing the level's data tables:
 * the world tells us where the ground, the walls and the roofs actually are, so this
 * file stays correct when the level agent moves a building.
 *
 * `P` (the placement context, built by world/Props.js) provides:
 *   P.rng                       deterministic Rng
 *   P.spawn(type, opts)         -> placed | null  (null = rejected, e.g. overlapping)
 *   P.ground(x, z, fromY)       -> {y, normal, surface} | null
 *   P.roofs / P.facades         discovered by the sweep in Props.js
 *   P.poi(id)                   ctx.level.pointsOfInterest lookup
 *   P.walkable(x, z)            nav grid query — never block a lane
 *   P.budget                    remaining triangle budget
 */
import { TAU, clamp01, lerp } from './geom.js';

/* ========================================================================== */
/*                            hand-placed anchors                             */
/* ========================================================================== */

/**
 * Curated set pieces. These are the ones the review cameras actually look at, so they
 * are authored rather than scattered. `yaw` is radians; positions are world XZ and the
 * Y comes from a downward raycast at spawn time.
 */
const ANCHORS = [
  /* ── Souk Street: the hero shot looks north-west up this canyon ─────────── */
  { t: 'hatchback', x: 12.0, z: 12.5, yaw: 0.06, o: { damage: 'dented', paint: 'carWhite' } },
  { t: 'hatchback', x: -1.6, z: -18.5, yaw: Math.PI + 0.1, o: { paint: 'carBlue' } },
  { t: 'pickup', x: 12.3, z: -6.0, yaw: -0.04, o: { paint: 'carSand' } },
  { t: 'pickup', x: 20.5, z: -34.0, yaw: 1.62, o: { damage: 'burnt' } },
  { t: 'hatchback', x: 24.6, z: -38.5, yaw: 0.9, o: { damage: 'burnt' } },
  { t: 'hatchback', x: -46.6, z: 33.5, yaw: 1.55, o: { paint: 'carRed', damage: 'stripped' } },

  /* plaza market row */
  { t: 'market_stall', x: 3.0, z: 8.4, yaw: -1.57 },
  { t: 'market_stall', x: 8.9, z: 11.0, yaw: 1.57 },
  { t: 'cafe_table', x: 5.4, z: 6.2, yaw: 0.3 },
  { t: 'plastic_chair', x: 5.4, z: 5.4, yaw: 2.1 },
  { t: 'plastic_chair', x: 6.2, z: 6.6, yaw: -1.1 },
  { t: 'cafe_table', x: 6.9, z: 12.1, yaw: -0.5 },
  { t: 'plastic_chair', x: 6.2, z: 12.4, yaw: 0.8, o: { stack: 4 } },
  { t: 'bench', x: 2.2, z: 11.6, yaw: 1.57 },
  { t: 'bin', x: 10.6, z: 7.2, yaw: 0.4 },
  { t: 'hydrant', x: -1.9, z: 6.4 },
  { t: 'litter', x: 10.4, z: 9.4, o: { count: 9, spread: 0.7 } },

  /* the Mid Cross material close-up: concrete, sacking, timber, painted steel
     and rusted steel all inside a 4 m radius of the `materials` pose target */
  { t: 'oil_drum', x: -3.05, z: 1.55, yaw: 0.5, o: { mat: 'rust' } },
  { t: 'oil_drum', x: -3.5, z: 2.25, yaw: 1.4, o: { mat: 'signRed' } },
  { t: 'jerry_can', x: -2.45, z: 2.15, yaw: -0.6 },
  { t: 'wood_crate', x: -4.9, z: 2.5, yaw: 0.35, o: { size: 0.62, damaged: true } },
  { t: 'pallet', x: -2.2, z: 3.0, yaw: 1.2 },
  { t: 'tyre_stack', x: -5.6, z: 1.1, o: { count: 3 } },
  { t: 'litter', x: -3.4, z: 0.9, o: { count: 10, spread: 0.8 } },
  { t: 'cardboard_box', x: -4.2, z: 3.1, yaw: 0.9, o: { state: 'open' } },
  { t: 'utility_box', x: -6.6, z: 3.4, yaw: 0.02 },

  /* Souk Street north half — dressing the walk up to the north cross */
  { t: 'bus_shelter', x: 12.6, z: 3.2, yaw: -1.57 },
  { t: 'traffic_sign', x: -1.7, z: -3.2, yaw: 1.5, o: { kind: 'round' } },
  { t: 'traffic_sign', x: 12.9, z: -20.4, yaw: -1.5, o: { kind: 'rect' } },
  { t: 'bin', x: -1.8, z: -10.4, yaw: 1.2 },
  { t: 'bin', x: 12.7, z: -27.5, yaw: -0.8 },
  { t: 'utility_box', x: 12.8, z: -13.4, yaw: -1.55 },
  { t: 'hydrant', x: 12.6, z: -31.5 },
  { t: 'oil_drum', x: 11.4, z: -22.4, yaw: 0.2 },
  { t: 'oil_drum', x: 11.5, z: -21.7, yaw: 1.1, o: { tipped: true } },
  { t: 'gas_cylinder', x: -1.5, z: -26.4, yaw: 0.4 },
  { t: 'gas_cylinder', x: -1.9, z: -26.0, yaw: 2.1 },
  { t: 'produce_crate', x: -1.6, z: -14.4, yaw: 0.2 },
  { t: 'produce_crate', x: -1.5, z: -13.9, yaw: -0.5, o: { lift: 0.17 } },

  /* market hall interior — the `interior` pose stands at (-14.4, 1.6, -3.2) */
  { t: 'market_stall', x: -8.4, z: -8.6, yaw: 0.1, o: { w: 2.3, d: 1.2 } },
  { t: 'market_stall', x: -14.6, z: -9.4, yaw: 3.2, o: { w: 2.5, d: 1.25 } },
  { t: 'pallet', x: -11.4, z: -6.2, yaw: 0.25 },
  { t: 'produce_crate', x: -11.4, z: -6.2, yaw: 0.35, o: { lift: 0.15 } },
  { t: 'produce_crate', x: -11.0, z: -6.5, yaw: -0.4, o: { lift: 0.32 } },
  { t: 'wood_crate', x: -17.6, z: -6.4, yaw: 0.2, o: { size: 0.74 } },
  { t: 'wood_crate', x: -17.5, z: -7.2, yaw: -0.4, o: { size: 0.66 } },
  { t: 'wood_crate', x: -17.6, z: -6.5, yaw: 0.6, o: { size: 0.6, h: 0.5, lift: 0.76 } },
  { t: 'cardboard_box', x: -6.4, z: -5.2, yaw: 0.8, o: { state: 'crushed' } },
  { t: 'cardboard_box', x: -6.0, z: -5.6, yaw: -0.3 },
  { t: 'litter', x: -9.2, z: -4.2, o: { count: 12, spread: 1.3 } },
  { t: 'litter', x: -16.4, z: -12.0, o: { count: 8, spread: 1.0 } },
  { t: 'oil_drum', x: -19.4, z: -14.4, yaw: 0.7, o: { mat: 'olive' } },
  { t: 'oil_drum', x: -19.5, z: -15.1, yaw: 2.2 },
  { t: 'cable_spool', x: -6.6, z: -16.6, o: { radius: 0.62 } },
  { t: 'tarp_cover', x: -13.0, z: -18.4, yaw: 0.2, o: { w: 2.2, d: 1.6, h: 0.95 } },
  { t: 'plastic_chair', x: -12.2, z: -3.4, yaw: 1.4, o: { stack: 6 } },
  { t: 'bin', x: -19.6, z: -3.6, yaw: 0.3 },

  /* motor works yard — crates, drums, spools and a stripped car */
  { t: 'hatchback', x: -33.4, z: -16.2, yaw: 0.35, o: { damage: 'stripped', paint: 'carRed' } },
  { t: 'cable_spool', x: -29.4, z: -22.4 },
  { t: 'cable_spool', x: -30.6, z: -23.2, o: { onSide: true, radius: 0.55 } },
  { t: 'tyre_stack', x: -37.6, z: -25.4, o: { count: 5 } },
  { t: 'tyre_stack', x: -38.4, z: -24.6, o: { count: 3 } },
  { t: 'tyre', x: -36.7, z: -24.2 },
  { t: 'oil_drum', x: -27.4, z: -12.4, yaw: 0.4 },
  { t: 'oil_drum', x: -27.5, z: -13.1, yaw: 1.9, o: { mat: 'plasticBlue' } },
  { t: 'oil_drum', x: -28.1, z: -12.7, yaw: 0.9, o: { tipped: true } },
  { t: 'jerry_can', x: -26.6, z: -14.2, yaw: 0.7 },
  { t: 'jerry_can', x: -26.9, z: -14.5, yaw: -1.1 },
  { t: 'ammo_crate', x: -31.2, z: -11.4, yaw: 0.15 },
  { t: 'ammo_crate', x: -31.3, z: -11.5, yaw: 0.55, o: { lift: 0.34, open: true } },
  { t: 'pallet', x: -35.4, z: -11.8, yaw: 1.4 },
  { t: 'rubble_pile', x: -25.4, z: -26.4, yaw: 0.0, o: { length: 2.6 } },

  /* fuel forecourt */
  { t: 'oil_drum', x: 17.4, z: -24.6, yaw: 0.3 },
  { t: 'oil_drum', x: 17.5, z: -25.3, yaw: 1.2, o: { mat: 'signRed' } },
  { t: 'oil_drum', x: 18.1, z: -24.9, yaw: 2.4 },
  { t: 'jerry_can', x: 16.6, z: -23.4, yaw: 0.5 },
  { t: 'tyre_stack', x: 25.8, z: -25.4, o: { count: 4 } },
  { t: 'hesco', x: 15.2, z: -16.6, yaw: 0.0, o: { cells: 2 } },
  { t: 'sandbag_pile', x: 19.4, z: -13.2 },
  { t: 'ammo_crate', x: 26.4, z: -16.4, yaw: 1.5 },
  { t: 'bin', x: 22.6, z: -27.4, yaw: 0.9 },

  /* burnt block */
  { t: 'rubble_pile', x: 18.4, z: -31.4, yaw: 0.0, o: { length: 3.4, depth: 1.1 } },
  { t: 'rubble_pile', x: 24.6, z: -29.6, yaw: 0.3, o: { length: 2.8 } },
  { t: 'litter', x: 21.0, z: -33.5, o: { count: 14, spread: 1.8 } },
  { t: 'tyre', x: 23.2, z: -35.0, o: { lean: 1.2 } },

  /* channel: the sunken route needs a reason to look used */
  { t: 'oil_drum', x: 36.4, z: -6.0, yaw: 0.6, o: { tipped: true } },
  { t: 'tyre', x: 38.4, z: 4.5 },
  { t: 'tyre', x: 36.9, z: 14.2, o: { lean: 1.35 } },
  { t: 'rubble_pile', x: 38.6, z: -25.0, yaw: 1.57, o: { length: 2.4 } },
  { t: 'litter', x: 37.5, z: -12.0, o: { count: 12, spread: 1.6 } },
  { t: 'litter', x: 37.5, z: 8.0, o: { count: 10, spread: 1.4 } },
  { t: 'cardboard_box', x: 39.2, z: 1.4, yaw: 0.4, o: { state: 'crushed' } },

  /* hotel front / south cross */
  { t: 'bus_shelter', x: -4.6, z: 49.4, yaw: 0.0 },
  { t: 'planter', x: 3.0, z: 29.6, yaw: 0.0, o: { sx: 1.6, sz: 0.9 } },
  { t: 'planter', x: 11.0, z: 29.6, yaw: 0.0, o: { sx: 1.6, sz: 0.9 } },
  { t: 'bench', x: 7.2, z: 29.4, yaw: 0.0 },
  { t: 'bin', x: 14.4, z: 29.5, yaw: 0.3 },
  { t: 'hatchback', x: 18.6, z: 46.4, yaw: 1.6, o: { paint: 'carWhite' } },
  { t: 'pickup', x: -22.4, z: 48.6, yaw: -1.55, o: { paint: 'carBlue', damage: 'dented' } },
  { t: 'traffic_sign', x: 16.8, z: 30.2, yaw: 3.0, o: { kind: 'tall' } },

  /* west alley + kiosks */
  { t: 'bin', x: -45.4, z: 8.6, yaw: 1.4 },
  { t: 'gas_cylinder', x: -43.6, z: 27.4, yaw: 0.6 },
  { t: 'gas_cylinder', x: -43.9, z: 27.8, yaw: 1.9 },
  { t: 'produce_crate', x: -43.6, z: 36.4, yaw: 0.3 },
  { t: 'produce_crate', x: -43.5, z: 36.9, yaw: -0.2, o: { lift: 0.17 } },
  { t: 'market_stall', x: -46.2, z: 39.2, yaw: 1.57, o: { w: 2.0, d: 1.1 } },
  { t: 'pallet', x: -46.8, z: -14.4, yaw: 0.3 },
  { t: 'pallet', x: -46.8, z: -14.5, yaw: 1.1, o: { lift: 0.15 } },

  /* lamp columns — the level instances a simple pole on the main pavements, so these
     go where it does not: the yards, the alleys and the canal road */
  { t: 'lamp_post', x: 16.4, z: -8.6, yaw: -1.57, o: { height: 4.7 } },
  { t: 'lamp_post', x: -24.7, z: 6.6, yaw: 1.57, o: { height: 4.4 } },
  { t: 'lamp_post', x: -24.7, z: -30.4, yaw: 1.57, o: { height: 4.6 } },
  { t: 'lamp_post', x: 33.2, z: 20.4, yaw: 0, o: { height: 5.0 } },
  { t: 'lamp_post', x: -30.4, z: 29.4, yaw: 3.14, o: { height: 4.5 } },
  { t: 'lamp_post', x: 17.6, z: 28.4, yaw: 3.14, o: { height: 4.8 } },
  { t: 'lamp_post', x: -4.6, z: 45.4, yaw: 0, o: { height: 4.9 } },
  { t: 'lamp_post', x: 26.6, z: -44.4, yaw: 0, o: { height: 4.7 } },

  /* two defensive lines with properly stacked bags, where the level has none */
  { t: 'sandbag_wall', x: -29.4, z: -6.6, yaw: 0.05, o: { length: 3.2, courses: 6 } },
  { t: 'sandbag_wall', x: 44.2, z: 2.0, yaw: 1.6, o: { length: 2.8, courses: 5 } },

  /* grain store yard */
  { t: 'hesco', x: 44.8, z: -32.0, yaw: 1.57, o: { cells: 3 } },
  { t: 'jersey_barrier', x: 47.2, z: -20.0, yaw: 0.0, o: { length: 2.8 } },
  { t: 'cable_spool', x: 44.6, z: 24.4 },
  { t: 'wood_crate', x: 43.4, z: 27.4, yaw: 0.2, o: { size: 0.8 } },
  { t: 'wood_crate', x: 43.5, z: 27.3, yaw: 0.7, o: { size: 0.66, lift: 0.82 } },
  { t: 'pallet', x: 42.6, z: 26.4, yaw: 1.3 },
];

/* ========================================================================== */
/*                                   compose                                  */
/* ========================================================================== */

/**
 * Phase slices, as fractions of the tier's whole triangle allowance.
 *
 * These MUST sum to <= 1. They used to sum to 1.29, which meant the last two phases
 * (street-level wall clutter and the perimeter) were spending money the build did not
 * have: the roofs and the facades drained the account first and the player walked past
 * bare pavements. Everything the player can physically touch is now paid first, and the
 * skyline gets what is left.
 */
const PHASES = {
  anchors: 0.34,
  foreground: 0.07,
  drainage: 0.03,
  wallLines: 0.23,
  facades: 0.17,
  roofs: 0.12,
  perimeter: 0.04,
};

export function composeScene(P) {
  const r = P.rng;
  const B = Number.isFinite(P.total) && P.total > 0 ? P.total : 100000;
  const slice = (k) => Math.round(B * PHASES[k]);

  /* Order matters: the triangle budget is spent in this sequence, so the things the
     player stands next to are placed before the things on the skyline. */

  /* ---- 1. curated anchors ------------------------------------------------ */
  P.phase(slice('anchors'));
  for (const an of ANCHORS) {
    P.spawn(an.t, { x: an.x, z: an.z, yaw: an.yaw ?? r.range(0, TAU), ...(an.o || {}) });
  }

  /* ---- 2. near-field composition: things that hang INTO the review frames  */
  P.phase(slice('foreground'));
  dressForeground(P, r);

  /* ---- 3. drains and manholes in the gutter lines (cheap, always worth it) */
  P.phase(slice('drainage'));
  dressDrainage(P, r);

  /* ---- 4. wall-line clutter and corner rubbish: eye level, walked past ---- */
  P.phase(slice('wallLines'));
  dressWallLines(P, r);

  /* ---- 5. facades: AC, dishes, signs, shutters, downpipes, conduit ------- */
  P.phase(slice('facades'));
  dressFacades(P, r);

  /* ---- 6. rooftops: the skyline the vista and hero cameras read ---------- */
  P.phase(slice('roofs'));
  dressRoofs(P, r);

  /* ---- 7. perimeter fencing: razor wire on top of the existing fences ---- */
  P.phase(slice('perimeter'));
  dressPerimeter(P, r);
}

/* ========================================================================== */
/*                            near-field composition                          */
/* ========================================================================== */

/**
 * Every marketing frame in this genre has something at 1.5-3 m from the lens: an
 * awning corner, a cable, a line of washing, a tarp. Without it a shot is gun +
 * midground + sky and reads flat no matter how good the midground is.
 *
 * These are authored against the review camera positions in tools/poses.js — the
 * eight viewpoints the whole world is judged from — and are deliberately off to one
 * side or high in the frame so they frame the shot instead of blocking it.
 */
const FOREGROUND = [
  /* ── hero / night: camera (8.5, 1.68, 22) looking NW up Souk Street ─────── */
  /* Washing strung across the canyon. Deliberately restrained: the first pass hung
     six garments at 3.5 m four metres from the lens and they filled a third of the
     frame as dark rags. A near-field element frames a shot by *clipping* it at the
     edge, so these sit high, carry three or four garments, and let the midground
     through between them. */
  { t: 'laundry_line', x: 11.4, z: 18.6, y: 4.7, raw: true, o: { to: [-9.4, 0.35, -1.1], count: 3, posts: false, sag: 0.5 } },
  { t: 'laundry_line', x: 11.2, z: 13.6, y: 5.2, raw: true, o: { to: [-9.0, -0.2, 0.9], count: 4, posts: false, sag: 0.55 } },
  // pavement furniture 3 m off the lens on the right, breaking the empty plaza
  { t: 'oil_drum', x: 10.9, z: 19.4, yaw: 0.4, o: { mat: 'rust' } },
  { t: 'oil_drum', x: 10.6, z: 20.1, yaw: 1.7 },
  { t: 'wood_crate', x: 10.4, z: 18.4, yaw: 0.5, o: { size: 0.72 } },
  { t: 'wood_crate', x: 10.5, z: 18.5, yaw: 1.15, o: { size: 0.6, lift: 0.74 } },
  { t: 'produce_crate', x: 6.6, z: 19.8, yaw: 0.3 },
  { t: 'produce_crate', x: 6.5, z: 19.6, yaw: -0.4, o: { lift: 0.17 } },
  { t: 'litter', x: 8.2, z: 19.2, o: { count: 14, spread: 1.9 } },
  { t: 'litter', x: 5.4, z: 15.4, o: { count: 12, spread: 1.7 } },
  { t: 'cardboard_box', x: 2.2, z: 20.4, yaw: 0.7, o: { state: 'crushed' } },

  /* ── vista: camera (4, 9.5, 30) on the hotel parapet, looking N ────────── */
  // a cable and a washing line crossing the top of the frame at 2-3 m
  { t: 'laundry_line', x: 12.2, z: 27.4, y: 9.6, raw: true, o: { to: [-15.6, 0.55, -0.6], count: 3, posts: false, sag: 0.8 } },
  { t: 'laundry_line', x: 11.4, z: 24.4, y: 10.6, raw: true, o: { to: [-14.2, -0.3, 0.4], count: 2, posts: false, sag: 0.9 } },

  /* ── weapon: camera (-8, 1.6, 14) inside the blue shophouse, looking N ─── */
  { t: 'market_stall', x: -11.6, z: 11.2, yaw: 1.5, o: { w: 2.1, d: 1.05 } },
  { t: 'wood_crate', x: -5.2, z: 11.6, yaw: 0.3, o: { size: 0.74 } },
  { t: 'wood_crate', x: -5.1, z: 11.5, yaw: 0.9, o: { size: 0.62, lift: 0.76 } },
  { t: 'produce_crate', x: -5.6, z: 12.6, yaw: -0.3 },
  { t: 'cardboard_box', x: -10.4, z: 9.2, yaw: 0.5, o: { state: 'open' } },
  { t: 'cardboard_box', x: -10.0, z: 9.6, yaw: -0.4, o: { state: 'crushed' } },
  { t: 'plastic_chair', x: -6.8, z: 13.4, yaw: 1.1, o: { stack: 5 } },
  { t: 'litter', x: -8.6, z: 10.4, o: { count: 11, spread: 1.4 } },
  { t: 'pallet', x: -9.8, z: 12.8, yaw: 1.3 },
  { t: 'oil_drum', x: -4.6, z: 9.4, yaw: 0.2, o: { mat: 'olive' } },
  // washing strung across the shop, 2.5 m from the lens, high left
  { t: 'laundry_line', x: -3.6, z: 11.5, y: 2.9, raw: true, o: { to: [-8.4, 0.1, 0.6], count: 5, posts: false, sag: 0.35 } },

  /* ── interior: camera (-14.4, 1.62, -3.2) in the market hall ───────────── */
  { t: 'laundry_line', x: -6.2, z: -5.4, y: 3.1, raw: true, o: { to: [-9.6, 0.2, -1.4], count: 6, posts: false, sag: 0.42 } },
  { t: 'market_stall', x: -12.4, z: -6.4, yaw: -1.5, o: { w: 2.2, d: 1.15 } },
  { t: 'produce_crate', x: -13.2, z: -4.4, yaw: 0.4 },
  { t: 'produce_crate', x: -13.1, z: -4.5, yaw: -0.3, o: { lift: 0.17 } },
  { t: 'cardboard_box', x: -16.2, z: -4.6, yaw: 0.6 },
  { t: 'litter', x: -13.6, z: -7.6, o: { count: 12, spread: 1.5 } },
  { t: 'tyre', x: -17.2, z: -3.0, o: { lean: 1.25 } },

  /* ── ads / firefight: down the Souk from (2,1.62,10) and (10,1.66,-6) ──── */
  { t: 'laundry_line', x: 11.6, z: 4.2, y: 4.6, raw: true, o: { to: [-10.4, 0.3, -0.8], count: 4, posts: false, sag: 0.5 } },
  { t: 'laundry_line', x: 11.5, z: -9.6, y: 4.8, raw: true, o: { to: [-10.2, -0.25, 1.2], count: 3, posts: false, sag: 0.55 } },
  { t: 'oil_drum', x: 1.2, z: 7.4, yaw: 0.9 },
  { t: 'litter', x: 2.6, z: 6.4, o: { count: 10, spread: 1.5 } },
  { t: 'rubble_pile', x: 12.6, z: -3.4, yaw: 1.5, o: { length: 2.2, depth: 0.7 } },

  /* ── materials: close-up at (-2.2, 1.35, 4.4) ──────────────────────────── */
  { t: 'litter', x: -2.9, z: 2.6, o: { count: 10, spread: 0.9 } },
  { t: 'gas_cylinder', x: -5.9, z: 2.9, yaw: 0.8 },
];

function dressForeground(P, r) {
  for (const an of FOREGROUND) {
    if (P.budget <= 0) break;
    // A `raw` line owns its own end point in prop-local space, so a random yaw would
    // swing it somewhere else entirely: those get 0 unless the entry says otherwise.
    const opts = { x: an.x, z: an.z, yaw: an.yaw ?? (an.raw ? 0 : r.range(0, TAU)), ...(an.o || {}) };
    if (an.raw) {
      opts.raw = true;
      opts.y = an.y;
    } else if (Number.isFinite(an.y)) {
      opts.y = an.y;
    }
    P.spawn(an.t, opts);
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Roof plant. The roof set was discovered by a downward raycast sweep, so this works
 * for any building the level agent adds without this file knowing about it.
 */
function dressRoofs(P, r) {
  const roofs = P.roofs;
  if (!roofs.length) return;
  /* group cells into rough clusters per roof height so tanks land together */
  let tanks = 0;
  let acs = 0;
  let aerials = 0;
  // A skyline is silhouette. Tall variants (tanks, aerials) are what the vista camera
  // actually reads at 60-120 m, so they are biased up hard and capped generously.
  const maxTanks = 18;
  const maxAc = 30;
  const maxAerials = 20;
  const shuffled = roofs.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    const t = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = t;
  }
  for (const cell of shuffled) {
    if (P.budget <= 0) break;
    /* keep off the very edge: a tank hanging over a parapet reads as a bug */
    if (cell.edge < 1.5) continue;
    const roll = r.next();
    if (roll < 0.19 && tanks < maxTanks) {
      if (P.spawn('water_tank', { x: cell.x, z: cell.z, y: cell.y, yaw: r.range(0, TAU), onRoof: true })) tanks++;
    } else if (roll < 0.34 && acs < maxAc) {
      if (P.spawn('ac_unit_roof', { x: cell.x, z: cell.z, y: cell.y, yaw: r.range(0, TAU), onRoof: true })) acs++;
    } else if (roll < 0.45 && aerials < maxAerials) {
      if (P.spawn('tv_aerial', { x: cell.x, z: cell.z, y: cell.y, yaw: r.range(0, TAU), onRoof: true })) aerials++;
    } else if (roll < 0.51) {
      P.spawn('satellite_dish', { x: cell.x, z: cell.z, y: cell.y + 0.9, yaw: r.range(0, TAU), raw: true, radius: r.range(0.3, 0.46) });
    } else if (roll < 0.56) {
      P.spawn('gas_cylinder', { x: cell.x, z: cell.z, y: cell.y, yaw: r.range(0, TAU), onRoof: true });
    } else if (roll < 0.61) {
      P.spawn('cardboard_box', { x: cell.x, z: cell.z, y: cell.y, yaw: r.range(0, TAU), onRoof: true, state: r.pick(['crushed', 'closed']) });
    } else if (roll < 0.65) {
      P.spawn('tyre', { x: cell.x, z: cell.z, y: cell.y, yaw: r.range(0, TAU), onRoof: true });
    } else if (roll < 0.71) {
      P.spawn('litter', { x: cell.x, z: cell.z, y: cell.y, onRoof: true, count: 5 + r.int(5), spread: 0.8 });
    } else if (roll < 0.75) {
      P.spawn('oil_drum', { x: cell.x, z: cell.z, y: cell.y, yaw: r.range(0, TAU), onRoof: true, static: true });
    }
  }
  /* laundry strung between roof parapets — pick pairs of cells on the same roof */
  let lines = 0;
  for (let i = 0; i < shuffled.length && lines < 8; i++) {
    const a = shuffled[i];
    if (a.edge < 1.0) continue;
    for (let k = i + 1; k < Math.min(shuffled.length, i + 60); k++) {
      const b = shuffled[k];
      if (Math.abs(b.y - a.y) > 0.35) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 3.2 || d > 6.5) continue;
      P.spawn('laundry_line', {
        x: a.x,
        z: a.z,
        y: a.y + r.range(1.5, 1.9),
        onRoof: true,
        raw: true,
        to: [b.x - a.x, r.jitter(0.15), b.z - a.z],
        count: 2 + r.int(3),
      });
      lines++;
      break;
    }
  }
}

/**
 * Facade dressing. `P.facades` is a list of {x, y, z, nx, nz, height} points found by
 * horizontal raycasts, so an AC unit is always flush against a real wall.
 */
function dressFacades(P, r) {
  const f = P.facades;
  if (!f.length) return;
  let ac = 0;
  let dish = 0;
  let sign = 0;
  let shutter = 0;
  let pipe = 0;
  let line = 0;
  for (const w of f) {
    if (P.budget <= 0) break;
    const yaw = Math.atan2(w.nx, w.nz);
    const roll = r.next();
    /* high-level plant */
    if (w.free > 3.2 && roll < 0.12 && ac < 26) {
      P.spawn('ac_unit', { x: w.x, z: w.z, y: w.groundY + r.range(2.6, 5.4), yaw, onWall: true, normal: [w.nx, 0, w.nz] });
      ac++;
    } else if (w.free > 3.6 && roll < 0.17 && dish < 18) {
      P.spawn('satellite_dish', {
        x: w.x,
        z: w.z,
        y: w.groundY + r.range(3.0, 6.0),
        yaw,
        onWall: true,
        normal: [w.nx, 0, w.nz],
        radius: r.range(0.28, 0.42),
        aim: r.jitter(0.8),
      });
      dish++;
    } else if (w.free > 2.6 && roll < 0.235 && pipe < 26) {
      P.spawn('downpipe', {
        x: w.x,
        z: w.z,
        y: w.groundY,
        yaw,
        onWall: true,
        normal: [w.nx, 0, w.nz],
        height: Math.min(w.free, r.range(3.4, 7.0)),
      });
      pipe++;
    } else if (w.free > 3.0 && roll < 0.285 && sign < 20) {
      P.spawn('shop_sign', {
        x: w.x,
        z: w.z,
        y: w.groundY + r.range(2.6, 3.3),
        yaw,
        onWall: true,
        normal: [w.nx, 0, w.nz],
        projecting: r.chance(0.65),
        w: r.range(0.9, 1.5),
      });
      sign++;
    } else if (w.free > 2.6 && roll < 0.325 && shutter < 14) {
      P.spawn('shop_shutter', {
        x: w.x,
        z: w.z,
        y: w.groundY,
        yaw,
        onWall: true,
        normal: [w.nx, 0, w.nz],
        w: r.range(1.9, 2.6),
        h: r.range(2.0, 2.3),
      });
      shutter++;
    } else if (w.free > 4.0 && roll < 0.35 && line < 10) {
      /* laundry from a first-floor window out to the opposite wall */
      const len = r.range(2.6, 4.4);
      P.spawn('laundry_line', {
        x: w.x,
        z: w.z,
        y: w.groundY + r.range(3.4, 5.0),
        onWall: true,
        raw: true,
        // tied to a hook on the wall, not standing on poles
        posts: false,
        to: [w.nx * len, r.jitter(0.3), w.nz * len],
        count: 2 + r.int(2),
      });
      line++;
    } else if (roll < 0.52) {
      /* Fall-through 1: surface conduit. Six cylinders, always affordable, and it is
         what stops a 20 m facade being one unbroken plane. */
      P.spawn('wall_conduit', {
        x: w.x,
        z: w.z,
        y: w.groundY + r.range(0.1, 0.5),
        yaw,
        onWall: true,
        normal: [w.nx, 0, w.nz],
        height: Math.min(Math.max(1.4, w.free - 0.6), r.range(2.2, 4.6)),
      });
    } else if (roll < 0.64) {
      P.spawn('wall_vent', {
        x: w.x,
        z: w.z,
        y: w.groundY + r.range(2.1, 3.4),
        yaw,
        onWall: true,
        normal: [w.nx, 0, w.nz],
      });
    } else if (roll < 0.74) {
      P.spawn('meter_box', {
        x: w.x,
        z: w.z,
        y: w.groundY + r.range(1.25, 1.7),
        yaw,
        onWall: true,
        normal: [w.nx, 0, w.nz],
      });
    } else if (roll < 0.86) {
      /* Fall-through 2: a short conduit stub low on the wall. Cheapest of all. */
      P.spawn('wall_conduit', {
        x: w.x,
        z: w.z,
        y: w.groundY + r.range(0.05, 0.3),
        yaw,
        onWall: true,
        normal: [w.nx, 0, w.nz],
        height: r.range(1.2, 2.2),
        drop: r.range(0.5, 1.0),
      });
    }
  }
}

/**
 * Ground clutter that hugs the walls. Rubbish, boxes and crates never sit in the middle
 * of a lane — they pile where the wind and the street sweeper leave them.
 */
function dressWallLines(P, r) {
  const f = P.facades;
  let n = 0;
  for (const w of f) {
    if (P.budget <= 0) break;
    if (n > 620) break;
    const roll = r.next();
    /* stand-off from the wall so nothing intersects it */
    const off = r.range(0.28, 0.75);
    const x = w.x + w.nx * off;
    const z = w.z + w.nz * off;
    const yaw = Math.atan2(w.nx, w.nz) + r.jitter(0.5);
    // The old thresholds left ~60 % of every wall line completely bare, which is the
    // single biggest reason the pavements read as swept. Real streets accumulate: the
    // fall-through at the end means *something* lands at nearly every sample point,
    // and the cheapest options (litter, rubble) carry most of the coverage.
    if (roll < 0.26) {
      const spread = r.range(0.4, 0.9);
      P.spawn('litter', {
        x: w.x + w.nx * (0.45 + spread * 0.5),
        z: w.z + w.nz * (0.45 + spread * 0.5),
        count: 4 + r.int(7),
        spread,
      });
      n++;
    } else if (roll < 0.34) {
      P.spawn('cardboard_box', { x, z, yaw, state: r.pick(['crushed', 'open', 'closed']) });
      n++;
    } else if (roll < 0.40) {
      P.spawn('rubble_pile', { x: w.x + w.nx * 0.1, z: w.z + w.nz * 0.1, yaw, length: r.range(1.4, 2.6), depth: r.range(0.5, 0.9) });
      n++;
    } else if (roll < 0.45) {
      P.spawn('pallet', { x, z, yaw: yaw + Math.PI / 2 + r.jitter(0.3) });
      n++;
    } else if (roll < 0.51) {
      P.spawn('oil_drum', { x, z, yaw, tipped: r.chance(0.18) });
      n++;
    } else if (roll < 0.57) {
      P.spawn('wood_crate', { x, z, yaw, size: r.range(0.5, 0.78) });
      n++;
    } else if (roll < 0.62) {
      P.spawn('tyre', { x, z, yaw, lean: r.chance(0.5) ? r.range(1.0, 1.4) : 0 });
      n++;
    } else if (roll < 0.66) {
      P.spawn('bin', { x, z, yaw });
      n++;
    } else if (roll < 0.70) {
      P.spawn('gas_cylinder', { x, z, yaw });
      n++;
    } else if (roll < 0.735) {
      P.spawn('sandbag_pile', { x, z, yaw });
      n++;
    } else if (roll < 0.765) {
      P.spawn('produce_crate', { x, z, yaw });
      n++;
    } else if (roll < 0.79) {
      P.spawn('tyre_stack', { x, z, count: 2 + r.int(3) });
      n++;
    } else if (roll < 0.815) {
      P.spawn('cable_spool', { x, z, radius: r.range(0.5, 0.68), onSide: r.chance(0.4) });
      n++;
    } else if (roll < 0.845) {
      P.spawn('jerry_can', { x, z, yaw });
      n++;
    } else {
      // Fall-through: never leave a metre of wall base with nothing in it. Litter is
      // 'flat', so it costs no collider and merges into the one debris batch.
      const spread = r.range(0.5, 1.1);
      P.spawn('litter', {
        x: w.x + w.nx * (0.4 + spread * 0.5),
        z: w.z + w.nz * (0.4 + spread * 0.5),
        count: 5 + r.int(8),
        spread,
      });
      n++;
    }
  }
}

/** Razor wire along the tops of the perimeter fences, plus two chain-link runs. */
function dressPerimeter(P, r) {
  const B = P.bounds;
  if (!B) return;
  /* The fence line is not at the map bounds, so each edge is discovered by casting
     inwards until something fence-shaped is hit. */
  const edges = [
    { axis: 'z', at: B.minX + 1, dir: [1, 0], a0: B.minZ + 8, a1: B.maxZ - 8, yaw: Math.PI / 2 },
    { axis: 'z', at: B.maxX - 1, dir: [-1, 0], a0: B.minZ + 8, a1: B.maxZ - 8, yaw: Math.PI / 2 },
    { axis: 'x', at: B.minZ + 1, dir: [0, 1], a0: B.minX + 8, a1: B.maxX - 8, yaw: 0 },
    { axis: 'x', at: B.maxZ - 1, dir: [0, -1], a0: B.minX + 8, a1: B.maxX - 8, yaw: 0 },
  ];
  let n = 0;
  for (const e of edges) {
    const steps = Math.max(1, Math.floor((e.a1 - e.a0) / 3.4));
    for (let i = 0; i < steps && n < 28; i++) {
      if (P.budget <= 0) break;
      if (!r.chance(0.5)) continue;
      const t = (i + 0.5) / steps;
      const along = lerp(e.a0, e.a1, t);
      const x = e.axis === 'z' ? e.at : along;
      const z = e.axis === 'z' ? along : e.at;
      const top = P.fenceTop(x, z, e.dir, 26);
      if (!top) continue;
      if (P.spawn('razor_wire', { x: top.x, z: top.z, y: top.y + 0.3, yaw: e.yaw, raw: true, length: 3.2, radius: 0.3 })) n++;
    }
  }

  /* two free-standing chain-link runs closing off yards, each topped with wire */
  for (const run of [
    { x: -25.5, z: 30.0, yaw: 0, length: 8, h: 2.2 },
    { x: 24.0, z: -8.5, yaw: Math.PI / 2, length: 7, h: 2.0 },
  ]) {
    const rec = P.spawn('chain_link', run);
    if (!rec) continue;
    const segs = Math.max(1, Math.round(run.length / 3));
    for (let i = 0; i < segs; i++) {
      const t = (i + 0.5) / segs - 0.5;
      P.spawn('razor_wire', {
        x: rec.position.x + Math.cos(run.yaw) * t * run.length,
        z: rec.position.z - Math.sin(run.yaw) * t * run.length,
        y: rec.position.y + run.h + 0.24,
        yaw: run.yaw,
        raw: true,
        length: run.length / segs,
        radius: 0.28,
      });
    }
  }
}

/** Gully grates and manhole lids where water would actually run. */
function dressDrainage(P, r) {
  const spots = [
    [0.6, -34, -Math.PI / 2], [0.6, -18, -Math.PI / 2], [0.6, 10, -Math.PI / 2],
    [9.4, -28, Math.PI / 2], [9.4, -4, Math.PI / 2], [9.4, 16, Math.PI / 2],
    [30.6, -30, -Math.PI / 2], [30.6, 6, -Math.PI / 2],
    [45.4, -14, Math.PI / 2], [45.4, 18, Math.PI / 2],
    [-44.6, 30, Math.PI / 2], [-44.6, -8, Math.PI / 2],
    [-20, -0.6, 0], [8, 25.4, 0], [-8, 48.6, 0],
  ];
  for (const [x, z, yaw] of spots) P.spawn('drain_grate', { x, z, yaw });
  const lids = [[3.4, -12], [7.6, 14], [-16, 1.4], [-36, 2.2], [27, -18], [42.6, 12], [-10, 40], [20, 33], [4.6, -44]];
  for (const [x, z] of lids) P.spawn('manhole', { x, z, yaw: r.range(0, TAU) });
  void clamp01;
}

export default composeScene;
