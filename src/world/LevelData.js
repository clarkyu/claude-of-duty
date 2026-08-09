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
 *   ├─────────┴───────────┴─────┴────────────┴──────┴──────────┤  z 24..31
 *   │ W.ALLEY │  kiosks   │  dogleg  │    HOTEL    │   cafe    │  z 31..44
 *   └──────────────────────────────────────────────────────────┘
 *            S  (+Z)   South Cross z 46..56, team A spawns beyond
 *
 *   Lane A — West Alley, x -50..-44. Tight, shaded, two archways, roof access via the
 *            apartment external stair. Pure flank; nothing to hold, everything to
 *            surprise from.
 *   Lane B — Souk Street, x -3..14. The main artery. Broken in the middle by a raised
 *            plaza (+0.9 m) with a fountain, so it is never one clean sightline.
 *   Lane C — Canal Road, x 30..46, split down the middle by a 6 m storm channel sunk
 *            2.6 m below grade. Three bridges cross it (with standing headroom
 *            underneath, so the invert is one continuous lane), two ramps and two
 *            ladders get you in and out. Below-grade flank with no overhead cover.
 *   Back Alley — x -25..-21, a 4 m service cut that links all three cross-streets and
 *            feeds the Market Hall's west door. The classic "third option".
 *
 * Cross connections at z -42..-32 (North Cross), z -2..4 (Mid Cross), z 24..28
 * (Hotel Front) and z 46..56 (South Cross). No lane runs uninterrupted end to end:
 * the plaza, the channel and the fuel canopy each break their lane's long shot.
 *
 * Elevation tiers: channel invert -2.60 / street 0 / plaza +0.90 / first floors +4.0
 * / roofs +7.4 to +9.3 / minaret gallery +13.2. Six, comfortably over the three the
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
  /* 2.6 m, not 1.9: the three bridges are 0.5 m deep and a lane you cannot walk
     under standing up is not a lane — it is four disconnected pits. */
  channel: -2.6,
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
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [-2, 26, 16, 31] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [28, -44, 30, 30] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [46, -44, 48, 30] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [-44, -50, -42, 52] },
  { key: 'pave', mat: 'ground.pave', surface: 'concrete', lift: 0.14, rect: [-21, -2, 14, 4] },

  /* the raised plaza */
  { key: 'plaza', mat: 'ground.pave', surface: 'concrete', lift: 0.9, rect: [1, 4, 11, 14] },
];

/**
 * Rectangles that get no terrain at all. Building footprints are added at runtime.
 * This MUST match the channel's outer extent exactly (x0-wallThick .. x1+wallThick,
 * z0 .. z1) — overshooting it leaves a strip of ground missing at each end with
 * nothing under it, which is a hole you can fall through.
 */
export const GROUND_VOIDS = [{ rect: [34, -42, 41, 28], why: 'storm channel' }];

/* ═══════════════════════════════════════════════════════════════ the channel ══ */

export const CHANNEL = {
  x0: 34.5,
  x1: 40.5,
  z0: -42,
  z1: 28,
  topY: 0,
  floorY: TIERS.channel,
  wallThick: 0.5,
  headwalls: true,
  bridges: [
    { x0: 33.6, x1: 41.4, z0: -34, z1: -29.5, y: 0.02, thick: 0.26 },
    { x0: 33.6, x1: 41.4, z0: -1, z1: 3.5, y: 0.02, thick: 0.26 },
    { x0: 33.6, x1: 41.4, z0: 20, z1: 23.5, y: 0.02, thick: 0.26 },
  ],
  /* Cross-channel vehicle ramps. `rise` tracks the invert depth; 25 deg is steep for
     a real ramp but is exactly what a storm channel access ramp looks like, and it
     is well inside anything the movement code refuses to walk. */
  ramps: [
    { x: 34.7, z: -39.6, yaw: 0, length: 5.6, rise: 2.6, width: 3.4 },
    { x: 40.3, z: 25.6, yaw: Math.PI, length: 5.6, rise: 2.6, width: 3.4 },
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
    /* The east half of the first floor is cut away, so the hall is 8 m tall under the
       roof lantern and the surviving west deck reads as a mezzanine gallery looking
       down into it. This is what makes the contested centre worth contesting. */
    floorVoid: { level: 1, rect: [-11.8, -25.4, -3.6, -2.6] },
    interior: 'market',
    landmark: true,
  },
  {
    id: 'hotel',
    name: 'Hotel Almaz',
    /* z0 is 31, not 28: the review "vista" camera sits at (4, 9.5, 30) and at z0=28
       that put it inside the third-floor bedroom. Three metres south widens Hotel
       Front to a proper 7 m cross-street and gives the camera open air. */
    rect: [-2, 31, 16, 44],
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
    /* south facade: the 13.7 m flight only fits on an 18 m side */
    roofStair: { side: 0, u: 3 },
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
    /* The `weapon` review camera stands inside this ground floor. Without an inner
       leaf the room is lined with three *different* exterior paints meeting at hard
       vertical seams with no pilaster — which reads as a material assignment error,
       not as a room. One plaster leaf inside fixes that and gives the interior its
       own surface tag. */
    inner: 'int.plaster',
    interior: 'shop',
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
      /* Back door on the north wall — the wall the `weapon` camera looks straight at.
         A room whose far wall is three windows and nothing else has no way out and
         reads as a box; a doorway gives it a reveal, a threshold and a light shaft. */
      { side: 2, u: 4.6, w: 1.15, h: 2.3, type: 'door' },
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
    doors: [{ side: 3, u: 9, w: 1.6, h: 2.3, type: 'door' }],
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

/**
 * Distant silhouette blocks, LOD-2 only, outside the play space.
 *
 * Heights vary by roughly ±45 % about the mean rather than the ±10 % they used to,
 * because the thing that made the old vista frame read as scenery was that every block
 * topped out within two metres of its neighbour: a row of near-identical flat-topped
 * rectangles is the one skyline shape nobody has ever seen in a real city. Some of
 * these are 8 m sheds and some are 30 m slabs, and `buildBackdrop` puts a setback
 * tower on most of them on top of that.
 */
/*
 * ── Why these are so much taller than they look on paper ────────────────────────
 * A street-level camera sees the backdrop only in the slot of sky ABOVE the near
 * rooflines. The market hall parapet sits at 9.1 m and 31 m from the hero camera,
 * which is 13.4 degrees; a 24 m block at 100 m subtends 12.6 degrees and is therefore
 * *completely invisible* from the street no matter how carefully it is modelled. That
 * is exactly what happened: every rank was built, none of it was in any frame.
 *
 * The rule this list now follows is `h > 1.7 + 0.24 * distance` for anything meant to
 * be seen down a street — which for the first rank at 60-100 m means 25-40 m, and for
 * the second rank at 130-190 m means 40-70 m. Real Levantine cities have exactly this
 * profile: a low old town in the foreground and 12-20 storey concrete on the ridge
 * behind it.
 */
export const BACKDROP = [
  /* first rank, 60-110 m: reads immediately over the playspace rooflines */
  { rect: [-96, -86, -66, -60], h: 26, wall: 'wall.sand' },
  { rect: [-60, -92, -34, -62], h: 38, wall: 'wall.bone' },
  { rect: [-28, -88, -4, -60], h: 29, wall: 'wall.terracotta' },
  { rect: [2, -96, 30, -62], h: 44, wall: 'wall.sand' },
  { rect: [36, -84, 66, -60], h: 23, wall: 'wall.ochre' },
  { rect: [70, -70, 100, -30], h: 34, wall: 'wall.bone' },
  { rect: [72, -12, 98, 30], h: 25, wall: 'wall.sand' },
  { rect: [68, 40, 96, 76], h: 37, wall: 'wall.terracotta' },
  { rect: [10, 62, 48, 92], h: 27, wall: 'wall.bone' },
  { rect: [-40, 60, -2, 88], h: 33, wall: 'wall.ochre' },
  { rect: [-92, 46, -56, 82], h: 24, wall: 'wall.sand' },
  { rect: [-100, -18, -70, 30], h: 36, wall: 'wall.bone' },
  /* infill between the first-rank blocks, so the rank is a town and not a picket
     fence with sky between the posts */
  { rect: [-34, -74, -6, -56], h: 19, wall: 'wall.ochre' },
  { rect: [30, -78, 42, -58], h: 22, wall: 'wall.bone' },
  { rect: [-70, -60, -50, -50], h: 16, wall: 'wall.terracotta' },
  { rect: [56, -58, 78, -44], h: 18, wall: 'wall.sand' },

  /* Second rank at 110-190 m: the depth cue that turns one row of boxes into a town.
     Taller than the first rank, because at that distance anything shorter is behind
     it. */
  { rect: [-150, -160, -104, -122], h: 44, wall: 'wall.bone' },
  { rect: [-92, -168, -46, -128], h: 62, wall: 'wall.sand' },
  { rect: [-30, -172, 18, -132], h: 38, wall: 'wall.ochre' },
  { rect: [30, -166, 88, -124], h: 68, wall: 'wall.bone' },
  { rect: [104, -140, 158, -96], h: 46, wall: 'wall.terracotta' },
  { rect: [126, -60, 176, 6], h: 40, wall: 'wall.sand' },
  { rect: [132, 28, 184, 92], h: 54, wall: 'wall.bone' },
  { rect: [58, 106, 116, 156], h: 42, wall: 'wall.ochre' },
  { rect: [-34, 116, 30, 168], h: 50, wall: 'wall.sand' },
  { rect: [-124, 98, -60, 150], h: 36, wall: 'wall.bone' },
  { rect: [-168, 4, -116, 66], h: 48, wall: 'wall.terracotta' },
  { rect: [-176, -74, -122, -18], h: 41, wall: 'wall.sand' },
  /* the north-west block the hero camera looks straight down the market hall at */
  { rect: [-118, -126, -66, -96], h: 52, wall: 'wall.ochre' },
  { rect: [-56, -128, -16, -100], h: 47, wall: 'wall.bone' },
  { rect: [-8, -132, 40, -104], h: 58, wall: 'wall.terracotta' },

  /**
   * Third rank, 230-360 m: the hill town. Small blocks stepping up a slope, each one
   * sitting a little higher than the one in front, which is the layer that reads as
   * *landscape* rather than as another row of buildings. `far` drops the window quads
   * and the roof plant — none of it resolves past 200 m and it is a third of the
   * backdrop's triangles.
   */
  ...hillTown(),
];

/**
 * A stepped hillside of small houses climbing away to the north-north-west, which is
 * the bearing every street pose looks down. Deterministic — no RNG at module scope.
 */
function hillTown() {
  const out = [];
  const walls = ['wall.sand', 'wall.bone', 'wall.ochre', 'wall.terracotta'];
  /* five terraces, each further back and higher up the slope */
  for (let row = 0; row < 5; row++) {
    const z = -238 - row * 30;
    const base = 22 + row * 26; // the ground rises away from the town
    const n = 9 - row;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const cx = -300 + t * 600 + ((row % 2) * 34 - 17);
      const w = 26 + ((i * 13 + row * 7) % 22);
      const d = 20 + ((i * 7 + row * 11) % 16);
      const h = base + ((i * 17 + row * 23) % 26);
      out.push({ rect: [cx - w / 2, z - d / 2, cx + w / 2, z + d / 2], h, wall: walls[(i + row) % 4], far: true });
    }
  }
  return out;
}

/**
 * Tall non-playable silhouette elements at 150-400 m. A skyline is silhouette: without
 * these the horizon is a row of flat tops and a razor-straight ground line.
 * kind: 'minaret' | 'tower' | 'crane' | 'stack' | 'mast' | 'dome'
 */
export const SKYLINE = [
  /* ── near landmarks, 70-140 m: the ones a STREET camera can actually see ──────
     A silhouette only exists if it clears the roofline in front of it. These sit
     just beyond the fence line on the bearings the review cameras look down — north
     and north-west up Souk Street, and west across the market hall — and they are
     tall enough (35-60 m at 70-140 m) to stand clear of a 9 m parapet at 30 m. */
  { kind: 'minaret', x: -44, z: -74, base: 0, h: 42, r: 2.9 },
  { kind: 'dome', x: -52, z: -66, base: 0, h: 16, r: 8 },
  { kind: 'tower', x: 46, z: -84, base: 0, h: 40, r: 5.2 }, // water tower over the north cross
  { kind: 'crane', x: -14, z: -104, base: 0, h: 52, jib: 32, yaw: 1.1 },
  { kind: 'minaret', x: -96, z: -46, base: 0, h: 36, r: 2.6 },
  { kind: 'stack', x: 88, z: -96, base: 0, h: 54, r: 3.2 },
  { kind: 'mast', x: -78, z: -112, base: 0, h: 46 },
  { kind: 'tower', x: -84, z: 64, base: 0, h: 34, r: 5.0 },
  { kind: 'crane', x: 62, z: 96, base: 0, h: 44, jib: 30, yaw: -1.4 },

  /* ── mid distance, 150-300 m ────────────────────────────────────────────── */
  { kind: 'minaret', x: -118, z: -150, base: 0, h: 58, r: 3.4 },
  { kind: 'minaret', x: 96, z: 168, base: 0, h: 48, r: 3.0 },
  { kind: 'dome', x: -104, z: -132, base: 0, h: 28, r: 11 },
  { kind: 'tower', x: 172, z: -104, base: 0, h: 64, r: 7.5 }, // water tower
  { kind: 'tower', x: -196, z: 52, base: 0, h: 52, r: 6.4 },
  { kind: 'stack', x: 58, z: -212, base: 0, h: 86, r: 3.6 }, // smokestack
  { kind: 'stack', x: 74, z: -222, base: 0, h: 64, r: 2.9 },
  { kind: 'crane', x: -46, z: -196, base: 0, h: 62, jib: 34, yaw: 0.6 },
  { kind: 'crane', x: 128, z: 118, base: 0, h: 50, jib: 29, yaw: -2.1 },
  { kind: 'mast', x: -224, z: -30, base: 0, h: 74 },
  { kind: 'mast', x: 214, z: 92, base: 0, h: 62 },
  { kind: 'crane', x: 168, z: -158, base: 0, h: 66, jib: 36, yaw: 2.6 },
  /* landmarks standing on the hill town, so the far terrace is not just boxes */
  { kind: 'minaret', x: -168, z: -268, base: 30, h: 44, r: 3.0 },
  { kind: 'minaret', x: 122, z: -296, base: 48, h: 40, r: 2.8 },
  { kind: 'tower', x: -66, z: -330, base: 74, h: 38, r: 5.4 },
  { kind: 'stack', x: 214, z: -252, base: 26, h: 58, r: 3.0 },
];

/**
 * The far terrain band. A dead-straight horizon is the single loudest tell that the
 * world stops at the fence: this puts a rolling ridge and a broken foothill line
 * between the backdrop blocks and the sky.
 */
export const HORIZON = {
  /* `inner` sits just inside the coarse terrain apron (+/-240 m in Terrain.js), so
     the ridge starts under ground the player can already see and the join is never
     visible; `outer` carries the ridgeline itself. */
  inner: 235,
  outer: 620,
  segments: 64,
  /**
   * Ridge height as [amplitude, frequency] pairs, summed.
   *
   * These were 34 m at 620 m — three degrees of elevation, which from a 1.7 m eye in
   * a street canyon is *below every roofline in the map*, so the "layered vista" was
   * geometry nobody could ever see. A coastal Levantine town has real hills behind
   * it; at 620 m a 90-150 m ridge subtends 8-14 degrees and finally clears the
   * parapets, which is the whole reason it exists.
   */
  base: 96,
  /* integer frequencies so the ring closes without a seam at theta = 0 */
  bands: [
    [46, 1],
    [26, 3],
    [12, 7],
    [5, 13],
  ],
  mat: 'ground.dirt',
  /** a second, higher and further ridge behind the first */
  far: { inner: 540, outer: 1080, base: 205, amp: 78, mat: 'wall.bone' },
};

/**
 * Overhead cable runs. Every real street in this part of the world is netted with
 * them, and a catenary crossing the frame at 6-9 m is the cheapest foreground occluder
 * there is — which is what all eight review frames were missing.
 * [x0, z0, y0, x1, z1, y1, sag]
 */
export const CABLES = [
  /* Souk Street, crossing the hero and ads sightlines */
  [-1.4, 20.2, 6.4, 12.4, 19.4, 6.9, 0.85],
  [-1.4, 12.0, 6.6, 12.4, 12.6, 6.2, 0.9],
  [-1.4, 3.0, 6.2, 12.4, 3.6, 6.8, 0.95],
  [-1.4, -6.0, 6.8, 12.4, -5.2, 6.4, 0.9],
  [-1.4, -15.0, 6.5, 12.4, -15.6, 7.0, 0.95],
  [-1.4, -24.0, 6.9, 12.4, -23.4, 6.3, 0.9],
  [-1.4, -33.0, 6.4, 12.4, -33.6, 6.8, 0.85],
  /* Hotel Front, crossing the vista sightline low in frame */
  [-2.4, 27.6, 7.2, 16.4, 27.0, 7.6, 1.0],
  [-2.4, 29.4, 8.4, 16.4, 29.0, 8.1, 0.8],
  /* Mid Cross */
  [-21.4, 0.4, 6.6, -2.4, 0.8, 6.9, 1.1],
  [14.4, 1.2, 7.0, 29.4, 0.6, 6.5, 0.95],
  /* Back Alley and West Alley */
  [-25.4, -6.0, 6.2, -20.6, -6.4, 6.6, 0.4],
  [-25.4, 12.0, 6.4, -20.6, 11.6, 6.1, 0.4],
  [-43.4, -12.0, 6.0, -41.4, -12.4, 6.4, 0.25],
  /* Canal Road */
  [29.4, -18.0, 6.6, 46.4, -18.6, 7.0, 1.2],
  [29.4, 14.0, 7.0, 46.4, 13.4, 6.5, 1.2],
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
  /* on the plaza deck but clear of the fountain basin (centre 6,9 r 2.15) and
     both planters — a spawn inside the basin collider is an instant stuck bot */
  { pos: [3.0, 0.9, 12.0], yaw: 0.4, team: 'ffa' },
  { pos: [6, 0, -20], yaw: 0.1, team: 'ffa' },
  /* in the gap between the hotel and the cafe, not in the cafe's west wall */
  { pos: [18.0, 0, 33.0], yaw: 2.6, team: 'ffa' },
  { pos: [21, 0, -8], yaw: -1.5, team: 'ffa' },
  { pos: [32, 0, 12], yaw: -1.4, team: 'ffa' },
  { pos: [44, 0, -24], yaw: 1.6, team: 'ffa' },
  { pos: [37.5, TIERS.channel + 0.06, 6], yaw: 0.0, team: 'ffa' },
];

/* ═══════════════════════════════════════════════════════════ points of interest ══ */

export const POIS = [
  { id: 'market_hall', name: 'Market Hall', kind: 'objective', pos: [-12, 2, -14], radius: 13 },
  { id: 'plaza', name: 'Fountain Plaza', kind: 'objective', pos: [6, 0.9, 9], radius: 7 },
  { id: 'minaret', name: 'Minaret', kind: 'landmark', pos: [-34.5, 8, -40.5], radius: 6 },
  { id: 'hotel', name: 'Hotel Almaz', kind: 'landmark', pos: [7, 4, 36], radius: 12 },
  { id: 'fuel', name: 'Fuel Canopy', kind: 'landmark', pos: [21, 3, -20], radius: 8 },
  { id: 'channel_n', name: 'Channel North', kind: 'route', pos: [37.5, TIERS.channel, -22], radius: 6 },
  { id: 'channel_s', name: 'Channel South', kind: 'route', pos: [37.5, TIERS.channel, 12], radius: 6 },
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
  /* facing the first one across the street; kept off (8.5, 22) because the review
     hero camera stands there and a stall frame 30 cm from the lens is not a shot */
  { kind: 'stall', x: 9.3, z: 17.8, yaw: 3.1 },
  { kind: 'barrier', x: 2.4, z: 24.5, yaw: 0.0, len: 2.6 },
  { kind: 'bollards', x0: -0.4, z0: 4, x1: -0.4, z1: 14, n: 6 },
  { kind: 'bollards', x0: 11.4, z0: 4, x1: 11.4, z1: 14, n: 6 },

  /* Mid Cross — also the set for the close-up material pose, so it deliberately
     puts concrete, sacking, bare timber and painted steel within 4 m of each other */
  { kind: 'barrier', x: -8, z: 1.2, yaw: 0.0, len: 2.8 },
  { kind: 'crates', x: -4.6, z: 1.4, yaw: 0.4, top: 1.45 },
  { kind: 'sandbag', x0: -9.6, z0: 2.6, x1: -6.4, z1: 2.4, courses: 3 },
  { kind: 'stall', x: -6.4, z: 5.2, yaw: -0.2 },
  { kind: 'barrier', x: 18.5, z: 0.6, yaw: 0.1, len: 2.8 },
  { kind: 'crates', x: -16.5, z: 1.6, yaw: 0.2, top: 1.75 },
  { kind: 'sandbag', x0: 24, z0: -0.6, x1: 27.6, z1: -0.6, courses: 3 },

  /* North Cross */
  { kind: 'barrier', x: -14, z: -37, yaw: 0.0, len: 2.8 },
  { kind: 'barrier', x: -6.5, z: -39.5, yaw: 0.12, len: 2.8 },
  { kind: 'crates', x: 12, z: -36, yaw: -0.3, top: 2.0 },
  { kind: 'sandbag', x0: 26, z0: -35, x1: 30, z1: -35, courses: 4 },
  { kind: 'planter', x: -30, z: -37, sx: 3.2, sz: 1.4 },

  /* West Alley — the archways at z 14 and z -20 count as breaks too */
  { kind: 'crates', x: -46.5, z: 16, yaw: 0.1, top: 1.85 },
  { kind: 'barrier', x: -47.5, z: -8, yaw: 1.6, len: 2.4 },
  { kind: 'crates', x: -46.2, z: -26, yaw: -0.2, top: 1.6 },
  { kind: 'sandbag', x0: -49.4, z0: 32, x1: -45, z1: 32, courses: 3 },
  { kind: 'planter', x: -46.4, z: 3, sx: 1.4, sz: 3.0 },
  { kind: 'crates', x: -47.2, z: -37, yaw: 0.35, top: 1.75 },
  { kind: 'barrier', x: -46.8, z: 44, yaw: 1.5, len: 2.4 },
  { kind: 'crates', x: -46.6, z: 25, yaw: -0.3, top: 1.5 },

  /* Back Alley */
  { kind: 'crates', x: -23.2, z: 18, yaw: 0.3, top: 1.7 },
  { kind: 'barrier', x: -23, z: -12, yaw: 1.57, len: 2.4 },
  { kind: 'crates', x: -22.6, z: -24, yaw: -0.15, top: 2.1 },
  { kind: 'barrier', x: -23.2, z: -2.5, yaw: 1.5, len: 2.4 },
  { kind: 'crates', x: -22.8, z: 11, yaw: 0.2, top: 1.6 },

  /* Canal Road — the west carriageway ran 34 m clear before this */
  { kind: 'barrier', x: 32.2, z: -20, yaw: 0.0, len: 2.6 },
  { kind: 'barrier', x: 43.5, z: 8, yaw: 0.05, len: 2.6 },
  { kind: 'crates', x: 44.2, z: -28, yaw: 0.25, top: 1.9 },
  { kind: 'planter', x: 32.2, z: 14, sx: 1.4, sz: 3.0 },
  { kind: 'sandbag', x0: 41.5, z0: -36, x1: 45.5, z1: -36, courses: 4 },
  { kind: 'crates', x: 32.4, z: -34, yaw: -0.25, top: 1.8 },
  { kind: 'barrier', x: 31.8, z: -6, yaw: 0.08, len: 2.6 },
  { kind: 'crates', x: 32.6, z: 24, yaw: 0.4, top: 1.7 },
  { kind: 'planter', x: 43.6, z: -12, sx: 1.4, sz: 3.0 },
  { kind: 'crates', x: 44.0, z: 20, yaw: -0.35, top: 2.0 },

  /* Souk Street, the last stretch before the north spawn */
  { kind: 'crates', x: 2.8, z: -41, yaw: 0.3, top: 1.85 },
  { kind: 'barrier', x: 8.6, z: -44, yaw: 0.05, len: 2.8 },

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

/**
 * Off-grid traversals: the places a bot leaves the walkable grid for an upper deck,
 * a roof or the channel invert. `pos` is the world position of the *bottom* of the
 * link. Every one of these is backed by geometry that is actually climbable — if you
 * move a stair or a crate stack, move the link with it.
 * kind: 'stair' | 'ladder' | 'ramp' | 'mantle' | 'scaffold'
 */
export const LINKS = [
  /* apartments: external stair up the +X facade in the back alley, foot near z 17 */
  { from: 'grid', to: 'roof_apartments', kind: 'stair', pos: [-24.3, 0, 17.2] },
  /* hotel: external stair up the +Z facade, foot near x 1 */
  { from: 'grid', to: 'roof_hotel', kind: 'stair', pos: [1.0, 0, 44.7] },
  /* ochre row: fire escape on side 3 (x 14.2) at u 21.5 from z0=-2 -> z 19.5 */
  { from: 'grid', to: 'roof_ochre_row', kind: 'ladder', pos: [13.3, 0, 19.5] },
  { from: 'grid', to: 'mezz_market_hall', kind: 'stair', pos: [-19.4, 0, -24] },
  { from: 'mezz_market_hall', to: 'roof_market_hall', kind: 'stair', pos: [-19.4, 4.2, -4] },
  /* garage: crate stack in the back alley to 3.1 m, then a wall ladder to the deck */
  { from: 'grid', to: 'roof_garage', kind: 'mantle', pos: [-24.2, 0, -14] },
  { from: 'grid', to: 'roof_garage', kind: 'ladder', pos: [-24.85, 2.6, -14] },
  /* fuel: crates -> kiosk roof -> a crate on the kiosk roof -> the canopy deck */
  { from: 'grid', to: 'roof_fuel_kiosk', kind: 'mantle', pos: [21.6, 0, -23.8] },
  { from: 'roof_fuel_kiosk', to: 'canopy_fuel', kind: 'mantle', pos: [24.4, 3.2, -22.0] },
  { from: 'grid', to: 'channel_floor', kind: 'ramp', pos: [37.5, 0, -39.6] },
  { from: 'grid', to: 'channel_floor', kind: 'ramp', pos: [37.5, 0, 25.6] },
  { from: 'grid', to: 'channel_floor', kind: 'ladder', pos: [34.55, 0, 10] },
  { from: 'grid', to: 'channel_floor', kind: 'ladder', pos: [40.45, 0, -18] },
  /* shophouses: the scaffold in Souk Street climbs all the way to the parapet */
  { from: 'grid', to: 'roof_shophouses', kind: 'scaffold', pos: [-1.2, 0, 18.0] },
  { from: 'grid', to: 'roof_kiosks', kind: 'ladder', pos: [-29.4, 0, 36.0] },
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
  SKYLINE,
  HORIZON,
  CABLES,
  SPAWNS,
  POIS,
  PROBES,
  COVER,
  FENCES,
  LAMPS,
  DRAINS,
  MANHOLES,
  ARCHWAYS,
  LINKS,
};
