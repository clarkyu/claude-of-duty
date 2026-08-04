/**
 * LevelData.js — "Bazaar", the map itself, as data. Owner: level agent.
 *
 * ── The design ──────────────────────────────────────────────────────────────────
 * A Mediterranean / Levantine town block, roughly 120 x 120 m of playable space,
 * laid out to classic three-lane rules.
 *
 *            N  (-Z)
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  backdrop skyline                                        │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ W.ALLEY │ garage  │alley│  MARKET HALL   │ ruin │ CANAL  │  z -44..-2
 *   │  lane A │ minaret │  B  │   (contested)  │ fuel │ lane C │
 *   ├─────────┴─────────┴─────┴────────────────┴──────┴────────┤  Mid Cross  z -2..4
 *   │ W.ALLEY │ apartments│alley│ shophouses │ SOUK │ ochre row│  z 4..26
 *   │         │           │     │            │ lane B         │
 *   ├─────────┴───────────┴─────┴────────────┴──────┴──────────┤  z 24..28
 *   │ W.ALLEY │  kiosks   │  dogleg  │    HOTEL    │   cafe    │  z 28..44
 *   └──────────────────────────────────────────────────────────┘
 *            S  (+Z)   South Cross z 46..56, team A spawns beyond
 *
 *   Lane A — West Alley, x -50..-44. Tight, shaded, two archways, roof access via the
 *            apartment external stair. Pure flank; nothing to hold, everything to
 *            surprise from.
 *   Lane B — Souk Street, x -3..14. The main artery. Broken in the middle by a raised
 *            plaza (+0.9 m) with a fountain, so it is never one clean sightline.
 *   Lane C — Canal Road, x 30..46, split down the middle by a 6 m storm channel sunk
 *            1.9 m below grade. Two bridges cross it, two ramps and a ladder get you
 *            in and out. Below-grade flank with no overhead cover.
 *   Back Alley — x -25..-21, a 4 m service cut that links all three cross-streets and
 *            feeds the Market Hall's west door. The classic "third option".
 *
 * Cross connections at z -42..-32 (North Cross), z -2..4 (Mid Cross), z 24..28
 * (Hotel Front) and z 46..56 (South Cross). No lane runs uninterrupted end to end:
 * the plaza, the channel and the fuel canopy each break their lane's long shot.
 *
 * Elevation tiers: channel invert -1.90 / street 0 / plaza +0.90 / first floors +4.0
 * / roofs +7.4 to +9.3 / minaret gallery +13.2. Five, comfortably over the three the
 * brief asks for.
 *
 * ── Conventions ─────────────────────────────────────────────────────────────────
 * Rect = [x0, z0, x1, z1] with x0<x1 and z0<z1. Building sides are indexed
 *   0 = +Z (south)   1 = +X (east)   2 = -Z (north)   3 = -X (west)
 * which is the order `wallRun` wants when you walk the footprint.
 * `u` on a side is metres from that side's start corner.
 */

/* ══════════════════════════════════════════════════════════════════ extents ══ */

export const BOUNDS = {
  minX: -64,
  maxX: 64,
  minZ: -58,
  maxZ: 60,
  minY: -3,
  maxY: 26,
  /** the fenced-off playable core */
  playMinX: -52,
  playMaxX: 50,
  playMinZ: -48,
  playMaxZ: 58,
};

export const TIERS = {
  channel: -1.9,
  street: 0,
  plaza: 0.9,
  floor1: 4.0,
  roofLow: 7.4,
  roofHigh: 9.3,
  gallery: 13.2,
};

/* ══════════════════════════════════════════════════════════════ ground plan ══ */

/**
 * Painted in order — later entries win. `lift` is metres above the terrain height
 * function; `void` regions emit no ground at all (a building or the channel owns it).
 * All rectangles are snapped to the 1 m rasterisation grid.
 */
export const GROUND = [
  { key: 'dirt', mat: 'ground.dirt', surface: 'dirt', lift: 0, rect: [-80, -80, 80, 80] },

  /* yards and unmade ground */
  { key: 'gravel', mat: 'ground.gravel', surface: 'dirt', lift: 0, rect: [-25, -30, -21, 26] },
  { key: 'gravel', mat: 'ground.gravel', surface: 'dirt', lift: 0, rect: [14, -14, 29, -2] },
  { key: 'gravel', mat: 'ground.gravel', surface: 'dirt', lift: 0, rect: [14, -30, 28, -26] },
  { key: 'gravel', mat: 'ground.gravel', surface: 'dirt', lift: 0, rect: [-42, 44, -25, 52] },
  { key: 'gravel', mat: 'ground.gravel', surface: 'dirt', lift: 0, rect: [30, 30, 46, 42] },

  /* carriageways */
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.06, rect: [0, -46, 10, 28] },
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.05, rect: [-50, -2, 46, 4] },
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.06, rect: [-50, -42, 46, -32] },
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.06, rect: [-50, 46, 46, 56] },
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.05, rect: [-14, 24, 16, 28] },
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.05, rect: [-14, 28, -2, 52] },
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.05, rect: [-50, -50, -44, 52] },
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.05, rect: [30, -44, 34, 30] },
  { key: 'road', mat: 'ground.road', surface: 'concrete', lift: 0, crown: 0.05, rect: [41, -44, 46, 30] },

  /* pavements */
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [-3, -46, 0, 28] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [10, -46, 14, 28] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [-2, 26, 16, 28] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [28, -44, 30, 30] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [46, -44, 48, 30] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [-44, -50, -42, 52] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [-21, -2, 14, 4] },

  /* the raised plaza */
  { key: 'plaza', mat: 'ground.pave', surface: 'concrete', lift: 0.9, rect: [1, 4, 11, 14] },
];

/** Rectangles that get no terrain at all. Building footprints are added at runtime. */
export const GROUND_VOIDS = [{ rect: [34, -43, 41, 29], why: 'storm channel' }];

/* ═══════════════════════════════════════════════════════════════ the channel ══ */

export const CHANNEL = {
  x0: 34.5,
  x1: 40.5,
  z0: -42,
  z1: 28,
  topY: 0,
  floorY: TIERS.channel,
  wallThick: 0.5,
  bridges: [
    { x0: 33.6, x1: 41.4, z0: -34, z1: -29.5, y: 0.02 },
    { x0: 33.6, x1: 41.4, z0: -1, z1: 3.5, y: 0.02 },
    { x0: 33.6, x1: 41.4, z0: 20, z1: 23.5, y: 0.02 },
  ],
  ramps: [
    { x: 34.9, z: -40.5, yaw: 0, length: 5.4, rise: 1.9, width: 3.2 },
    { x: 40.1, z: 26.5, yaw: Math.PI, length: 5.4, rise: 1.9, width: 3.2 },
  ],
  ladders: [
    { x: 34.55, z: 10, nx: 1, nz: 0 },
    { x: 40.45, z: -18, nx: -1, nz: 0 },
  ],
};

/* ════════════════════════════════════════════════════════════════ buildings ══ */

/**
 * Sides: 0=+Z 1=+X 2=-Z 3=-X. `levels` are floor-to-floor heights from `base`.
 * `solid` lists sides that get no windows (party walls / blank gables).
 */
export const BUILDINGS = [
  {
    id: 'market_hall',
    name: 'Market Hall',
    rect: [-21, -26, -3, -2],
    base: 0,
    levels: [4.2, 3.5],
    thick: 0.5,
    wall: 'brick.buff',
    inner: 'int.plaster',
    plinth: { h: 1.0, mat: 'struct.concrete', out: 0.06 },
    cornice: { h: 0.34, out: 0.16, mat: 'struct.concreteClean' },
    roof: { kind: 'flat', parapet: 1.4, deck: 'struct.concrete', clutter: 5 },
    windows: { spacing: 3.6, w: 1.15, h: 1.9, sill: 1.35, style: 'glazed' },
    upperWindows: { spacing: 3.6, w: 1.1, h: 1.5, sill: 1.1, style: 'shutter' },
    arcade: { side: 1, count: 4, w: 2.6, h: 3.5 },
    doors: [
      { side: 0, u: 9, w: 2.8, h: 3.4, type: 'arch' },
      { side: 2, u: 5.5, w: 3.2, h: 3.4, type: 'gate' },
      { side: 3, u: 17, w: 1.3, h: 2.3, type: 'door' },
    ],
    interior: 'market',
    landmark: true,
  },
  {
    id: 'hotel',
    name: 'Hotel Almaz',
    rect: [-2, 28, 16, 44],
    base: 0,
    levels: [3.8, 3.0, 3.0],
    thick: 0.42,
    wall: 'wall.bone',
    inner: 'int.plaster',
    plinth: { h: 0.95, mat: 'struct.concreteClean', out: 0.05 },
    cornice: { h: 0.3, out: 0.15 },
    roof: { kind: 'flat', parapet: 0.95, deck: 'struct.concrete', clutter: 6 },
    windows: { spacing: 3.0, w: 1.1, h: 1.85, sill: 1.05, style: 'glazed' },
    upperWindows: { spacing: 3.0, w: 1.0, h: 1.6, sill: 0.95, style: 'shutter' },
    doors: [{ side: 2, u: 9, w: 2.4, h: 2.8, type: 'door' }],
    balconies: [
      { side: 2, u: 4.2, level: 1 },
      { side: 2, u: 13.8, level: 1 },
      { side: 2, u: 9, level: 2, width: 4.2 },
      { side: 3, u: 8, level: 1 },
    ],
    awnings: [{ side: 2, u: 9, width: 4.4, depth: 1.8 }],
    signs: [{ side: 2, u: 9, y: 4.9, w: 4.2, h: 0.9 }],
    roofStair: { side: 3, u: 12 },
    landmark: true,
  },
  {
    id: 'shophouses',
    name: 'Blue Shophouses',
    rect: [-20, 7, -2, 25],
    base: 0,
    levels: [3.9, 3.3],
    thick: 0.38,
    units: 3,
    unitWalls: ['wall.blue', 'wall.ochre', 'wall.white'],
    wall: 'wall.blue',
    plinth: { h: 0.82, mat: 'struct.concrete', out: 0.05 },
    cornice: { h: 0.26, out: 0.13 },
    roof: { kind: 'flat', parapet: 0.85, deck: 'struct.concrete', clutter: 3 },
    windows: { spacing: 2.9, w: 1.5, h: 2.1, sill: 0.85, style: 'shop' },
    upperWindows: { spacing: 2.9, w: 0.95, h: 1.45, sill: 1.0, style: 'shutter' },
    doors: [
      { side: 1, u: 3.5, w: 1.15, h: 2.25, type: 'door' },
      { side: 1, u: 9.5, w: 1.15, h: 2.25, type: 'door' },
      { side: 1, u: 15, w: 1.15, h: 2.25, type: 'door' },
      { side: 0, u: 9, w: 1.2, h: 2.25, type: 'door' },
    ],
    awnings: [
      { side: 1, u: 6, width: 3.4 },
      { side: 1, u: 12.5, width: 3.4 },
    ],
    balconies: [
      { side: 1, u: 6, level: 1 },
      { side: 1, u: 13, level: 1 },
    ],
    signs: [
      { side: 1, u: 3.5, y: 3.15, w: 2.2, h: 0.62 },
      { side: 1, u: 12.5, y: 3.15, w: 2.6, h: 0.62 },
    ],
  },
  {
    id: 'ochre_row',
    name: 'Ochre Row',
    rect: [14, -2, 29, 24],
    base: 0,
    levels: [4.0, 3.2],
    thick: 0.4,
    units: 2,
    unitWalls: ['wall.terracotta', 'wall.sand'],
    wall: 'wall.terracotta',
    plinth: { h: 0.9, mat: 'struct.concrete', out: 0.05 },
    cornice: { h: 0.28, out: 0.14 },
    roof: { kind: 'flat', parapet: 0.9, deck: 'struct.concrete', clutter: 4 },
    windows: { spacing: 3.1, w: 1.45, h: 2.15, sill: 0.8, style: 'shop' },
    upperWindows: { spacing: 3.1, w: 1.0, h: 1.5, sill: 1.05, style: 'glazed' },
    doors: [
      { side: 3, u: 6, w: 1.2, h: 2.3, type: 'door' },
      { side: 3, u: 18, w: 2.6, h: 2.7, type: 'gate' },
      { side: 0, u: 8, w: 1.2, h: 2.3, type: 'door' },
    ],
    awnings: [
      { side: 3, u: 9.5, width: 3.6 },
      { side: 3, u: 14.5, width: 3.6 },
    ],
    balconies: [{ side: 3, u: 12, level: 1, width: 3.2 }],
    fireEscape: { side: 3, u: 21.5 },
    signs: [{ side: 3, u: 6, y: 3.3, w: 2.4, h: 0.66 }],
  },
  {
    id: 'apartments',
    name: 'Rashid Apartments',
    rect: [-42, 2, -25, 24],
    base: 0,
    levels: [3.6, 3.1, 3.1],
    thick: 0.42,
    wall: 'wall.pink',
    plinth: { h: 0.9, mat: 'struct.panel', out: 0.05 },
    cornice: { h: 0.3, out: 0.14 },
    roof: { kind: 'flat', parapet: 1.0, deck: 'struct.concrete', clutter: 6 },
    windows: { spacing: 3.2, w: 1.1, h: 1.7, sill: 1.0, style: 'shutter' },
    upperWindows: { spacing: 3.2, w: 1.1, h: 1.6, sill: 1.0, style: 'shutter' },
    doors: [
      { side: 1, u: 11, w: 1.4, h: 2.4, type: 'door' },
      { side: 0, u: 8, w: 1.2, h: 2.3, type: 'door' },
    ],
    balconies: [
      { side: 1, u: 5, level: 1 },
      { side: 1, u: 5, level: 2 },
      { side: 1, u: 16, level: 1 },
      { side: 1, u: 16, level: 2 },
      { side: 3, u: 6, level: 1 },
      { side: 3, u: 16, level: 2 },
    ],
    roofStair: { side: 1, u: 19 },
    landmark: true,
  },
  {
    id: 'garage',
    name: 'Hadid Motor Works',
    rect: [-42, -28, -25, -8],
    base: 0,
    levels: [6.4],
    thick: 0.44,
    wall: 'brick.painted',
    inner: 'int.plaster',
    plinth: { h: 1.1, mat: 'struct.panel', out: 0.06 },
    cornice: { h: 0.24, out: 0.12 },
    roof: { kind: 'corrugated', parapet: 0.5, deck: 'roof.corrugatedRust', clutter: 3 },
    windows: { spacing: 3.4, w: 1.6, h: 1.3, sill: 4.3, style: 'broken' },
    doors: [
      { side: 1, u: 5, w: 4.2, h: 4.4, type: 'gate' },
      { side: 1, u: 13, w: 4.2, h: 4.4, type: 'gate' },
      { side: 2, u: 4, w: 1.3, h: 2.3, type: 'door' },
    ],
    interior: 'garage',
  },
  {
    id: 'ruin',
    name: 'Burnt Block',
    rect: [14, -44, 28, -30],
    base: 0,
    levels: [3.8],
    thick: 0.42,
    wall: 'brick.red',
    plinth: { h: 0.8, mat: 'struct.concrete', out: 0.05 },
    roof: { kind: 'none' },
    windows: { spacing: 3.0, w: 1.3, h: 1.7, sill: 1.0, style: 'broken' },
    doors: [{ side: 0, u: 7, w: 1.6, h: 2.4, type: 'hole' }],
    ruin: true,
  },
  {
    id: 'warehouse',
    name: 'Grain Store',
    rect: [48, -38, 62, -12],
    base: 0,
    levels: [7.6],
    thick: 0.46,
    wall: 'struct.panelPale',
    plinth: { h: 1.2, mat: 'struct.concrete', out: 0.06 },
    cornice: { h: 0.22, out: 0.1 },
    roof: { kind: 'corrugated', parapet: 0.4, deck: 'roof.corrugated', clutter: 2 },
    windows: { spacing: 4.0, w: 1.8, h: 1.4, sill: 5.4, style: 'glazed' },
    doors: [{ side: 3, u: 12, w: 4.6, h: 5.0, type: 'gate' }],
    solid: [1],
  },
  {
    id: 'cafe',
    name: 'Corner Cafe',
    rect: [20, 30, 34, 44],
    base: 0,
    levels: [3.8, 3.2],
    thick: 0.4,
    wall: 'wall.green',
    plinth: { h: 0.85, mat: 'struct.concrete', out: 0.05 },
    cornice: { h: 0.26, out: 0.13 },
    roof: { kind: 'pitch', pitch: 0.36, mat: 'roof.shingle' },
    windows: { spacing: 3.0, w: 1.5, h: 2.0, sill: 0.85, style: 'shop' },
    upperWindows: { spacing: 3.0, w: 1.0, h: 1.5, sill: 1.0, style: 'shutter' },
    doors: [{ side: 2, u: 7, w: 1.2, h: 2.3, type: 'door' }],
    awnings: [{ side: 2, u: 7, width: 3.6 }],
  },
  {
    id: 'kiosks',
    name: 'Souk Kiosks',
    rect: [-42, 30, -30, 42],
    base: 0,
    levels: [3.4],
    thick: 0.36,
    units: 2,
    unitWalls: ['wall.sand', 'wall.terracotta'],
    wall: 'wall.sand',
    plinth: { h: 0.75, mat: 'struct.concrete', out: 0.05 },
    cornice: { h: 0.22, out: 0.12 },
    roof: { kind: 'flat', parapet: 0.7, deck: 'struct.concrete', clutter: 2 },
    windows: { spacing: 2.8, w: 1.35, h: 1.9, sill: 0.9, style: 'shop' },
    doors: [{ side: 1, u: 5, w: 1.1, h: 2.2, type: 'door' }],
    awnings: [{ side: 1, u: 8, width: 3.2 }],
  },
  {
    id: 'east_block',
    name: 'Canal Terrace',
    rect: [48, 4, 62, 30],
    base: 0,
    levels: [3.8, 3.2],
    thick: 0.4,
    wall: 'wall.ochre',
    plinth: { h: 0.85, mat: 'struct.concrete', out: 0.05 },
    cornice: { h: 0.26, out: 0.13 },
    roof: { kind: 'flat', parapet: 0.85, deck: 'struct.concrete', clutter: 3 },
    windows: { spacing: 3.1, w: 1.15, h: 1.8, sill: 0.95, style: 'shutter' },
    upperWindows: { spacing: 3.1, w: 1.0, h: 1.5, sill: 1.0, style: 'glazed' },
    doors: [{ side: 3, u: 8, w: 1.2, h: 2.3, type: 'door' }],
    solid: [1],
  },
];

/** The minaret is hand-built: a tapering shaft, a gallery and a cap. */
export const MINARET = { x: -34.5, z: -40.5, base: 0, radius: 2.3, height: 13.2, galleryY: 10.4, capY: 16.6 };

/** Fuel station: canopy on four columns plus a small kiosk. */
export const FUEL = {
  canopy: { x0: 14, z0: -26, x1: 28, z1: -14, y: 5.2, thick: 0.6 },
  kiosk: { rect: [23, -25, 28, -19], h: 3.2 },
  pumpIslands: [
    [17.5, -20],
    [22.0, -20],
  ],
};

/** Distant silhouette blocks, LOD-2 only, outside the play space. */
export const BACKDROP = [
  { rect: [-96, -86, -66, -60], h: 11, wall: 'wall.sand' },
  { rect: [-60, -92, -34, -62], h: 16, wall: 'wall.bone' },
  { rect: [-28, -88, -4, -60], h: 13, wall: 'wall.terracotta' },
  { rect: [2, -96, 30, -62], h: 19, wall: 'wall.sand' },
  { rect: [36, -84, 66, -60], h: 10, wall: 'wall.ochre' },
  { rect: [70, -70, 100, -30], h: 15, wall: 'wall.bone' },
  { rect: [72, -12, 98, 30], h: 12, wall: 'wall.sand' },
  { rect: [68, 40, 96, 76], h: 17, wall: 'wall.terracotta' },
  { rect: [10, 62, 48, 92], h: 14, wall: 'wall.bone' },
  { rect: [-40, 60, -2, 88], h: 12, wall: 'wall.ochre' },
  { rect: [-92, 46, -56, 82], h: 16, wall: 'wall.sand' },
  { rect: [-100, -18, -70, 30], h: 13, wall: 'wall.bone' },
];

/* ══════════════════════════════════════════════════════════════════ spawns ══ */

/**
 * `team`: 'A' (south, attacking up the map), 'B' (north), 'ffa'.
 * `yaw` faces the player into the map. Publised as ctx.level.spawnPoints.
 */
export const SPAWNS = [
  /* Team A — south end, behind the South Cross */
  { pos: [-47, 0, 50], yaw: Math.PI, team: 'A' },
  { pos: [-36, 0, 51], yaw: Math.PI, team: 'A' },
  { pos: [-20, 0, 52], yaw: Math.PI, team: 'A' },
  { pos: [-8, 0, 50], yaw: Math.PI, team: 'A' },
  { pos: [6, 0, 52], yaw: Math.PI, team: 'A' },
  { pos: [24, 0, 51], yaw: Math.PI, team: 'A' },
  { pos: [38, 0, 50], yaw: Math.PI, team: 'A' },
  { pos: [44, 0, 52], yaw: Math.PI, team: 'A' },

  /* Team B — north end, beyond the North Cross */
  { pos: [-47, 0, -45], yaw: 0, team: 'B' },
  { pos: [-34, 0, -46], yaw: 0, team: 'B' },
  { pos: [-23, 0, -44], yaw: 0, team: 'B' },
  { pos: [-8, 0, -45], yaw: 0, team: 'B' },
  { pos: [5, 0, -44], yaw: 0, team: 'B' },
  { pos: [20, 0, -46], yaw: 0, team: 'B' },
  { pos: [32, 0, -45], yaw: 0, team: 'B' },
  { pos: [44, 0, -44], yaw: 0, team: 'B' },

  /* Free-for-all — spread across all three lanes and both flanks */
  { pos: [-47, 0, 20], yaw: -1.5, team: 'ffa' },
  { pos: [-47, 0, -20], yaw: -1.6, team: 'ffa' },
  { pos: [-33, 0, 34], yaw: 2.4, team: 'ffa' },
  { pos: [-23, 0, 12], yaw: 1.5, team: 'ffa' },
  { pos: [-23, 0, -18], yaw: 1.6, team: 'ffa' },
  { pos: [-12, 0, -36], yaw: 0.3, team: 'ffa' },
  { pos: [5, 0, 20], yaw: 3.1, team: 'ffa' },
  { pos: [6, 0.9, 9], yaw: 0.2, team: 'ffa' },
  { pos: [6, 0, -20], yaw: 0.1, team: 'ffa' },
  { pos: [20, 0, 34], yaw: 2.6, team: 'ffa' },
  { pos: [21, 0, -8], yaw: -1.5, team: 'ffa' },
  { pos: [32, 0, 12], yaw: -1.4, team: 'ffa' },
  { pos: [44, 0, -24], yaw: 1.6, team: 'ffa' },
  { pos: [37.5, -1.85, 6], yaw: 0.0, team: 'ffa' },
];

/* ═══════════════════════════════════════════════════════════ points of interest ══ */

export const POIS = [
  { id: 'market_hall', name: 'Market Hall', kind: 'objective', pos: [-12, 2, -14], radius: 13 },
  { id: 'plaza', name: 'Fountain Plaza', kind: 'objective', pos: [6, 0.9, 9], radius: 7 },
  { id: 'minaret', name: 'Minaret', kind: 'landmark', pos: [-34.5, 8, -40.5], radius: 6 },
  { id: 'hotel', name: 'Hotel Almaz', kind: 'landmark', pos: [7, 4, 36], radius: 12 },
  { id: 'fuel', name: 'Fuel Canopy', kind: 'landmark', pos: [21, 3, -20], radius: 8 },
  { id: 'channel_n', name: 'Channel North', kind: 'route', pos: [37.5, -1.9, -30], radius: 6 },
  { id: 'channel_s', name: 'Channel South', kind: 'route', pos: [37.5, -1.9, 16], radius: 6 },
  { id: 'back_alley', name: 'Back Alley', kind: 'route', pos: [-23, 0, -6], radius: 5 },
  { id: 'west_alley', name: 'West Alley', kind: 'route', pos: [-47, 0, 0], radius: 5 },
  { id: 'garage', name: 'Motor Works', kind: 'objective', pos: [-33, 1, -18], radius: 9 },
  { id: 'ruin', name: 'Burnt Block', kind: 'cover', pos: [21, 0, -37], radius: 7 },
  { id: 'warehouse', name: 'Grain Store', kind: 'cover', pos: [55, 1, -25], radius: 9 },
  { id: 'north_cross', name: 'North Cross', kind: 'route', pos: [0, 0, -37], radius: 8 },
  { id: 'south_cross', name: 'South Cross', kind: 'route', pos: [0, 0, 51], radius: 8 },
];

/** Box-projected reflection probe hints, consumed by render/ProbeSystem.js. */
export const PROBES = [
  { position: [-12, 2.2, -14], size: [20, 8, 26] },
  { position: [5.5, 2.0, 8], size: [22, 10, 30] },
  { position: [5.5, 2.0, -24], size: [18, 10, 26] },
  { position: [-23, 2.0, 4], size: [8, 9, 40] },
  { position: [-47, 2.0, 0], size: [10, 9, 40] },
  { position: [37.5, 0.0, -8], size: [16, 8, 44] },
  { position: [7, 5.0, 36], size: [24, 12, 22] },
  { position: [-33, 2.2, -18], size: [20, 8, 24] },
];

/* ═══════════════════════════════════════════════════════ architectural cover ══ */

/**
 * The cover rhythm. Every lane gets something at waist or chest height roughly every
 * 6-10 m so no straight run is a free 40 m sightline.
 * kind: 'barrier' | 'planter' | 'sandbag' | 'stall' | 'crates' | 'bollards' | 'fence'
 */
export const COVER = [
  /* Souk Street, north half */
  { kind: 'barrier', x: 2.6, z: -8, yaw: 0.06, len: 2.6 },
  { kind: 'barrier', x: 8.2, z: -13.5, yaw: -0.1, len: 2.6 },
  { kind: 'planter', x: 3.2, z: -19, sx: 1.5, sz: 3.4 },
  { kind: 'crates', x: 8.6, z: -25, yaw: 0.4, top: 1.9 },
  { kind: 'barrier', x: 4.0, z: -30, yaw: 1.55, len: 2.8 },
  { kind: 'sandbag', x0: 7.2, z0: -35, x1: 10.6, z1: -35, courses: 4 },
  { kind: 'stall', x: 2.4, z: -3.6, yaw: -1.57 },

  /* Plaza and Souk Street, south half */
  { kind: 'planter', x: 1.9, z: 5.6, sx: 1.4, sz: 2.8, y: 0.9 },
  { kind: 'planter', x: 10.1, z: 12.4, sx: 1.4, sz: 2.8, y: 0.9 },
  { kind: 'stall', x: 4.2, z: 17.5, yaw: 0.05 },
  { kind: 'stall', x: 8.6, z: 21.5, yaw: 3.1 },
  { kind: 'barrier', x: 2.4, z: 24.5, yaw: 0.0, len: 2.6 },
  { kind: 'bollards', x0: -0.4, z0: 4, x1: -0.4, z1: 14, n: 6 },
  { kind: 'bollards', x0: 11.4, z0: 4, x1: 11.4, z1: 14, n: 6 },

  /* Mid Cross */
  { kind: 'barrier', x: -8, z: 1.2, yaw: 0.0, len: 2.8 },
  { kind: 'barrier', x: 18.5, z: 0.6, yaw: 0.1, len: 2.8 },
  { kind: 'crates', x: -16.5, z: 1.6, yaw: 0.2, top: 1.75 },
  { kind: 'sandbag', x0: 24, z0: -0.6, x1: 27.6, z1: -0.6, courses: 3 },

  /* North Cross */
  { kind: 'barrier', x: -14, z: -37, yaw: 0.0, len: 2.8 },
  { kind: 'barrier', x: -6.5, z: -39.5, yaw: 0.12, len: 2.8 },
  { kind: 'crates', x: 12, z: -36, yaw: -0.3, top: 2.0 },
  { kind: 'sandbag', x0: 26, z0: -35, x1: 30, z1: -35, courses: 4 },
  { kind: 'planter', x: -30, z: -37, sx: 3.2, sz: 1.4 },

  /* West Alley */
  { kind: 'crates', x: -46.5, z: 16, yaw: 0.1, top: 1.85 },
  { kind: 'barrier', x: -47.5, z: -8, yaw: 1.6, len: 2.4 },
  { kind: 'crates', x: -46.2, z: -26, yaw: -0.2, top: 1.6 },
  { kind: 'sandbag', x0: -49.4, z0: 32, x1: -45, z1: 32, courses: 3 },

  /* Back Alley */
  { kind: 'crates', x: -23.2, z: 18, yaw: 0.3, top: 1.7 },
  { kind: 'barrier', x: -23, z: -12, yaw: 1.57, len: 2.4 },
  { kind: 'crates', x: -22.6, z: -24, yaw: -0.15, top: 2.1 },

  /* Canal Road */
  { kind: 'barrier', x: 32.2, z: -20, yaw: 0.0, len: 2.6 },
  { kind: 'barrier', x: 43.5, z: 8, yaw: 0.05, len: 2.6 },
  { kind: 'crates', x: 44.2, z: -28, yaw: 0.25, top: 1.9 },
  { kind: 'planter', x: 32.2, z: 14, sx: 1.4, sz: 3.0 },
  { kind: 'sandbag', x0: 41.5, z0: -36, x1: 45.5, z1: -36, courses: 4 },

  /* South Cross */
  { kind: 'barrier', x: -18, z: 48.5, yaw: 0.0, len: 2.8 },
  { kind: 'barrier', x: 12, z: 50.5, yaw: 0.08, len: 2.8 },
  { kind: 'crates', x: 30, z: 49, yaw: -0.2, top: 1.8 },

  /* Fuel forecourt and yards */
  { kind: 'barrier', x: 16.5, z: -10, yaw: 1.57, len: 2.6 },
  { kind: 'crates', x: 26.5, z: -8.5, yaw: 0.5, top: 2.2 },
  { kind: 'sandbag', x0: 15, z0: -28.5, x1: 19, z1: -28.5, courses: 3 },
];

/** Fences that close the play space and screen the yards. */
export const FENCES = [
  { x0: -52, z0: -50, x1: -52, z1: 54, h: 2.6 },
  { x0: -52, z0: 56, x1: 50, z1: 56, h: 2.6 },
  { x0: 50, z0: 56, x1: 50, z1: -46, h: 2.6 },
  { x0: -52, z0: -50, x1: -6, z1: -50, h: 2.6 },
  { x0: 6, z0: -50, x1: 50, z1: -50, h: 2.6 },
  { x0: 30, z0: 30, x1: 46, z1: 30, h: 2.1 },
  { x0: -42, z0: 44, x1: -25, z1: 44, h: 2.1 },
];

/** Lamp columns — placed on pavements, and the reason the night pose has practicals. */
export const LAMPS = [
  [-0.6, -40], [-0.6, -22], [-0.6, -6], [-0.6, 18],
  [12.2, -34], [12.2, -16], [12.2, 2], [12.2, 22],
  [-43.2, -30], [-43.2, -4], [-43.2, 22], [-43.2, 44],
  [29.2, -36], [29.2, -12], [29.2, 12], [46.8, -24], [46.8, 8],
  [-24, 4], [-24, -24], [-16, 26.5], [4, 26.5], [18, 26.5],
  [-30, 48], [0, 48], [26, 48],
];

/** Kerb-inlet drains, always in the gutter line where water would actually run. */
export const DRAINS = [
  { x: 0.4, z: -30, yaw: -Math.PI / 2 },
  { x: 0.4, z: 2, yaw: -Math.PI / 2 },
  { x: 9.6, z: -12, yaw: Math.PI / 2 },
  { x: 9.6, z: 20, yaw: Math.PI / 2 },
  { x: 30.4, z: -20, yaw: -Math.PI / 2 },
  { x: 45.6, z: 4, yaw: Math.PI / 2 },
  { x: -44.4, z: 10, yaw: Math.PI / 2 },
  { x: -44.4, z: -22, yaw: Math.PI / 2 },
];

export const MANHOLES = [
  [5, -26],
  [5, 1],
  [-47, 6],
  [-23, -2],
  [37, 33],
  [20, 49],
];

/** Archways spanning the alleys — the classic souk silhouette and a shadow gate. */
export const ARCHWAYS = [
  { x: -47, z: 14, w: 6, yaw: Math.PI / 2, h: 4.4, top: 6.2, mat: 'wall.sand' },
  { x: -47, z: -20, w: 6, yaw: Math.PI / 2, h: 4.4, top: 6.6, mat: 'wall.bone' },
  { x: -23, z: 8, w: 4, yaw: Math.PI / 2, h: 4.0, top: 5.8, mat: 'wall.ochre' },
];

export default {
  BOUNDS,
  TIERS,
  GROUND,
  GROUND_VOIDS,
  CHANNEL,
  BUILDINGS,
  MINARET,
  FUEL,
  BACKDROP,
  SPAWNS,
  POIS,
  PROBES,
  COVER,
  FENCES,
  LAMPS,
  DRAINS,
  MANHOLES,
  ARCHWAYS,
};
