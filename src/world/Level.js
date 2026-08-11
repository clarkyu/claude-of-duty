/**
 * Level.js — "Bazaar". Map assembly, collision, navigation. Owner: level agent.
 * Files owned: this, LevelData.js, Terrain.js, Buildings.js, kit/**.
 * Publishes: `ctx.level`.
 *
 * ── What happens in init() ──────────────────────────────────────────────────────
 *   1. A `Palette` resolves the map's ~30 named surfaces from `ctx.materials`. Tinted
 *      variants are `clone()`d so a terrace can have four paint colours while three
 *      still compiles one program.
 *   2. Every district authors its geometry into a `Batcher` in world space. Districts
 *      are spatial (a building, a block, a terrain ninth) so one merged mesh per
 *      (district x material) keeps the draw call count low *and* keeps frustum culling
 *      meaningful.
 *   3. Simplified box colliders are captured alongside the render geometry and, by
 *      default, double as occluders for the AO field.
 *   4. Vertex occlusion is baked against that field and written to a `codOcc`
 *      attribute, which `kit/VertexAO.js` folds into every level material.
 *   5. Meshes are built (LOD 0 detailed / LOD 1 shell / LOD 2 silhouette), colliders
 *      go to `ctx.physics`, a walkable grid is raycast out of the finished world, and
 *      `ctx.level` is published.
 *
 * ── Public API (ctx.level) ──────────────────────────────────────────────────────
 *   ready            boolean
 *   root             THREE.Group added to ctx.scene
 *   bounds           THREE.Box3 of the playable space
 *   spawnPoints      [{ id, pos:Vector3, yaw, team:'A'|'B'|'ffa', surface }]
 *   getSpawn(team, rng?)            -> one spawn point, farthest-from-threat aware
 *   colliders        the raw collider descriptors handed to physics
 *   navRegions       walkable grid + convex polys, see NAV FORMAT below
 *   pointsOfInterest [{ id, name, kind, pos:Vector3, radius }]
 *   reflectionProbes probe hints consumed by render/ProbeSystem.js
 *   raycast(origin, dir, maxDist, mask)  -> physics Hit | null
 *   groundY(x, z)    walkable ground height from the terrain model (no physics needed)
 *   surfaceAt(x, z)  §5 surface tag of the ground
 *   isInside(p)      inside the play space?
 *   stats            { drawGroups, vertices, triangles, colliders, buildMs, aoMs }
 *
 * ── NAV FORMAT (ctx.level.navRegions) ───────────────────────────────────────────
 *   Cell (i,j) covers [origin[0] + i*cell, origin[0] + (i+1)*cell) in X and likewise
 *   in Z; its linear index is `k = j*cols + i`. Everything is a flat typed array so
 *   the AI can copy the whole grid into a worker with no marshalling.
 *
 *   {
 *     format:  'cod-navgrid-2',
 *     cell:    2,                        // metres
 *     origin:  [minX, minZ],             // world position of cell (0,0)'s corner
 *     cols, rows,
 *
 *     standable: Uint8Array(cols*rows),  // 1 = there IS a floor here with 1.85 m of
 *                                        //     headroom (raycast against real physics)
 *     walkable:  Uint8Array(cols*rows),  // 1 = standable AND connected, through open
 *                                        //     edges, to a spawn. THIS is the one to
 *                                        //     path on; `standable` is the raw signal.
 *     floor:     Float32Array,           // world Y of that surface
 *     clearance: Float32Array,           // metres of headroom above `floor`
 *     surface:   Uint8Array,             // index into `surfaces`
 *     surfaces:  string[],               // the 15 §5 tags, in canonical order
 *
 *     openX: Uint8Array,                 // openX[k]=1 -> you can step k -> k+1    (+X)
 *     openZ: Uint8Array,                 // openZ[k]=1 -> you can step k -> k+cols (+Z)
 *                                        // Grid adjacency is NOT connectivity: these
 *                                        // are probed with knee- and chest-height rays
 *                                        // so a 0.5 m wall between two cell centres,
 *                                        // a jersey barrier or a railing closes the
 *                                        // edge. Always path through these, never
 *                                        // through raw i±1 / j±1.
 *     islands: Int16Array,               // connected-component id, -1 if not standable
 *     stepUp:  1.0,   standHeight: 1.85, // the thresholds the grid was built with
 *     spawnCells: number[],              // cell index of each entry in spawnPoints
 *
 *     polys: [{ id, points:[[x,z]…], y, tier, tags:[] }]   // roofs, mezzanine, channel
 *     links: [{ from, to, kind:'stair'|'ladder'|'ramp'|'mantle'|'scaffold', pos:[x,y,z] }]
 *            // `from`/`to` are 'grid' or a poly id; `pos` is the foot of the traversal
 *
 *     index(x,z) -> k|-1        isWalkable(x,z)     floorAt(x,z)
 *     clearanceAt(x,z)          surfaceAt(x,z)      cellCentre(k) -> [x,z]
 *     isOpen(k, dir)            // dir 0=+X 1=-X 2=+Z 3=-Z
 *     neighbours(k, out?)       // the 4-connected cells you can actually step to
 *     nearestWalkable(x,z,r)    // -> k | -1, for snapping a spawn or a waypoint
 *   }
 *
 * ── Events ──────────────────────────────────────────────────────────────────────
 *   emits `level:ready` { bounds, spawnPoints, pointsOfInterest, navRegions }
 *   emits `level:built` { stats }
 *   listens `quality:changed`, `debug:pose`
 */
import * as THREE from 'three';
import { Palette } from './kit/Palette.js';
import { Batcher } from './kit/Batcher.js';
import { OcclusionField, bakeOcclusion, setVertexAOStrength } from './kit/VertexAO.js';
import { mulberry32, clamp01, fbm2, lerp, smoothstep, valueNoise2 } from './kit/geom.js';
import { wallRun, lowWall, WALL_OPENINGS, resetWallOpenings } from './kit/Walls.js';
import { stairs, ramp, ladder, railing, crate, crateStack } from './kit/Stairs.js';
import {
  kerb,
  stormDrain,
  manhole,
  drainageChannel,
  bridge,
  jerseyBarrier,
  planter,
  sandbagWall,
  marketStall,
  fence,
  bollardGeometry,
  lampGeometry,
  lampBowlGeometry,
  acUnitGeometry,
  instMatrix,
} from './kit/Street.js';
import { Terrain } from './Terrain.js';
import { buildBuilding, buildMinaret, buildFuelStation, buildBackdrop, buildHorizon, buildSkyline, sideLine, sidePoint } from './Buildings.js';
import DATA, {
  BOUNDS,
  TIERS,
  BUILDINGS,
  CHANNEL,
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
} from './LevelData.js';

/** District a building belongs to — grouping keeps the draw-call count down. */
const DISTRICT_OF = {
  market_hall: 'blk_hall',
  hotel: 'blk_hotel',
  shophouses: 'blk_souk_w',
  ochre_row: 'blk_souk_e',
  apartments: 'blk_west',
  garage: 'blk_west',
  kiosks: 'blk_westS',
  ruin: 'blk_north',
  warehouse: 'blk_east',
  cafe: 'blk_southE',
  east_block: 'blk_east',
};

export default function createLevel(ctx) {
  /** @type {any} */
  const api = {
    ready: false,
    root: null,
    bounds: new THREE.Box3(
      new THREE.Vector3(BOUNDS.minX, BOUNDS.minY, BOUNDS.minZ),
      new THREE.Vector3(BOUNDS.maxX, BOUNDS.maxY, BOUNDS.maxZ)
    ),
    spawnPoints: [],
    colliders: [],
    navRegions: null,
    pointsOfInterest: [],
    reflectionProbes: PROBES.map((p) => ({ position: p.position.slice(), size: p.size.slice() })),
    /**
     * Every window, door and arch the wall kit authored, in world space, as
     * `{x, y, z, nx, nz, hw, hh, type, glazed}`. `render/Lighting.js` turns the ones
     * near the camera into rectangular area lights so an interior is lit by its
     * apertures rather than only by whatever beam happens to reach the floor.
     * See kit/Walls.js WALL_OPENINGS.
     */
    portals: [],
    probes: PROBES,
    data: DATA,
    tiers: TIERS,
    stats: { drawGroups: 0, vertices: 0, triangles: 0, colliders: 0, buildMs: 0, aoMs: 0, materials: 0 },
  };
  // Published from the factory too: other systems' factories run before our init().
  ctx.level = api;

  let palette = null;
  let terrain = null;
  let field = null;
  let root = null;
  const batchers = new Map();
  const bodies = [];
  const lights = [];
  const geomCache = new Map();
  const unsubs = [];

  /* Deterministic and independent of every other system's RNG consumption, so the
     map is byte-identical between runs no matter what boots before us. */
  const rng = mulberry32(0x0badc0de);

  const getBatcher = (name) => {
    let b = batchers.get(name);
    if (!b) {
      b = new Batcher({ name, palette, field, colliderSink: api.colliders });
      b.colorFn = makeColorFn();
      batchers.set(name, b);
    }
    b.lod = 0;
    b.matrix = null;
    b.matrixStack.length = 0;
    b.uvRot = 0;
    b.uvOffset = [0, 0];
    b.uvScale = 1;
    b.colorFn = b.colorFn || makeColorFn();
    return b;
  };

  /**
   * The vertex-colour mask author. r = grime, g = second-material layer, b = pooling.
   * Splash-back at the base of every wall, dirt collecting on up-facing ledges, water
   * pooling in low flat places — all from position and normal, no hand painting.
   */
  /** baseHeight() walks every footprint; memoise it on a 2 m grid for the colour pass. */
  const _hCache = new Map();
  function cachedBase(x, z) {
    if (!terrain) return 0;
    const k = (Math.round(x * 0.5) + 512) * 4096 + (Math.round(z * 0.5) + 512);
    let v = _hCache.get(k);
    if (v === undefined) {
      v = terrain.baseHeight(x, z);
      _hCache.set(k, v);
    }
    return v;
  }

  function makeColorFn() {
    return (x, y, z, nx, ny, nz, out) => {
      const g = cachedBase(x, z);
      const above = y - g;
      const splash = smoothstep(1.7, 0.0, above);
      const noise = fbm2(x * 0.21 + 4.1, y * 0.17 - z * 0.09, 3);
      const streak = valueNoise2(x * 1.9 + z * 1.9, y * 0.11) * 0.35;
      let grime = 0.1 + splash * splash * 0.62 + noise * 0.24;
      if (ny > 0.55) grime += 0.16; // dust and dirt settle on ledges
      if (ny < -0.4) grime += 0.22; // soffits and undersides stay filthy
      grime += streak * clamp01(above * 0.2) * 0.5;
      out[0] = clamp01(grime);
      out[1] = 0;
      // Water only really stands on up-facing surfaces within a metre of grade, and
      // only in patches — a permanently damp kerb everywhere reads as varnish.
      out[2] = ny > 0.6 ? clamp01(splash * splash * 0.34 * (0.35 + valueNoise2(x * 0.35, z * 0.35))) : 0;
    };
  }

  /* ══════════════════════════════════════════════════════════════ authoring ══ */

  function authorTerrain() {
    // Footprints do two jobs: they flatten the ground undulation so no plinth floats
    // or buries, and they drive the extra terrain tessellation that makes the baked
    // contact shadow at a wall base tight instead of a metre wide. The channel and
    // the minaret get one for the same reason a building does.
    const footprints = BUILDINGS.map((b) => ({ rect: b.rect }));
    footprints.push({ rect: FUEL.kiosk.rect.slice() });
    footprints.push({ rect: [CHANNEL.x0 - CHANNEL.wallThick, CHANNEL.z0, CHANNEL.x1 + CHANNEL.wallThick, CHANNEL.z1] });
    footprints.push({
      rect: [MINARET.x - MINARET.radius - 0.6, MINARET.z - MINARET.radius - 0.6, MINARET.x + MINARET.radius + 0.6, MINARET.z + MINARET.radius + 0.6],
    });
    terrain = new Terrain(ctx, footprints);
    const cols = terrain.build(getBatcher);
    for (const c of cols) api.colliders.push(c);
  }

  function authorBuildings() {
    for (const def of BUILDINGS) {
      const bat = getBatcher(DISTRICT_OF[def.id] || 'blk_misc');
      try {
        buildBuilding(bat, def, rng);
      } catch (err) {
        warn(`building ${def.id} failed`, err);
        bat.lod = 0;
        bat.uvOffset = [0, 0];
        bat.matrix = null;
        bat.matrixStack.length = 0;
      }
    }
    try {
      buildMinaret(getBatcher('blk_west'), MINARET);
    } catch (err) {
      warn('minaret failed', err);
    }
    try {
      buildFuelStation(getBatcher('blk_north'), FUEL, rng);
    } catch (err) {
      warn('fuel station failed', err);
    }
    /**
     * Three explicit depth bands, which is how a retail vista frame is actually built:
     *   1. the playspace (everything above);
     *   2. a mid backdrop of non-playable blocks at 60-190 m with real silhouette;
     *   3. a far layer — tall landmark shapes at 150-300 m and a terrain ridge beyond
     *      them — so the horizon is never a straight line and the world does not
     *      visibly stop at the fence.
     * All of it lives in one batcher, so the whole far distance is a handful of draws.
     */
    const bd = getBatcher('backdrop');
    for (const b of BACKDROP) {
      try {
        buildBackdrop(bd, b);
      } catch (err) {
        warn('backdrop failed', err);
        bd.lod = 0;
      }
    }
    bd.lod = 0;
    bd.uvScale = 1;
    bd.uvOffset = [0, 0];
    try {
      buildSkyline(bd, SKYLINE);
    } catch (err) {
      warn('skyline failed', err);
    }
    const hz = getBatcher('horizon');
    try {
      // The far ridge is 600-1100 m out: stretch its UVs hard or the ground texture
      // reads as a tiled bedsheet across half the sky.
      hz.uvScale = 0.06;
      buildHorizon(hz, HORIZON);
      hz.uvScale = 1;
    } catch (err) {
      warn('horizon failed', err);
      hz.uvScale = 1;
    }
  }

  /**
   * Overhead cable runs. Every street in a town like this is netted with them, and a
   * catenary crossing the frame at 6-9 m is the cheapest near-field occluder there is:
   * all eight review frames were gun + midground + sky with nothing in the foreground,
   * and this is the single change that buys the most depth per triangle.
   *
   * Each run also drops a service spur and, on the long spans, a strung lamp — which
   * gives the night pose something above head height to bloom against.
   */
  function authorCables() {
    // One batcher for every run in the map, not one per street quadrant. Four
    // materials x four street districts was 16 meshes for a few hundred metres of
    // wire, and each of those costs a draw in the main pass and in every shadow
    // cascade. Consolidated it is four meshes total.
    const b = getBatcher('cables');
    for (const c of CABLES) {
      const [x0, z0, y0, x1, z1, y1, sag = 0.8] = c;
      const mb = b.b('metal.rust');
      const N = 8;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        pts.push([lerp(x0, x1, t), lerp(y0, y1, t) - Math.sin(t * Math.PI) * sag, lerp(z0, z1, t)]);
      }
      for (let i = 0; i < N; i++) mb.cylinder(pts[i], pts[i + 1], 0.017, 4);
      // A second, slacker conductor a little below it — one wire reads as a mistake.
      for (let i = 0; i < N; i++) {
        const a = [pts[i][0], pts[i][1] - 0.16 - Math.sin(((i / N) * Math.PI)) * 0.12, pts[i][2] + 0.1];
        const bb = [pts[i + 1][0], pts[i + 1][1] - 0.16 - Math.sin((((i + 1) / N) * Math.PI)) * 0.12, pts[i + 1][2] + 0.1];
        mb.cylinder(a, bb, 0.012, 4);
      }
      // Insulator + bracket at each end so the run lands on something.
      for (const [ex, ey, ez] of [[x0, y0, z0], [x1, y1, z1]]) {
        b.b('metal.galv').box([ex, ey + 0.06, ez], [0.1, 0.06, 0.1], { chamfer: 0.02 });
        b.b('struct.concreteClean').cylinder([ex, ey + 0.12, ez], [ex, ey + 0.26, ez], 0.05, 6, { radius2: 0.07 });
      }
      // A strung lamp at mid span on the longer runs.
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L > 9) {
        const mx = (x0 + x1) * 0.5;
        const mz = (z0 + z1) * 0.5;
        const my = (y0 + y1) * 0.5 - sag;
        b.b('metal.rust').cylinder([mx, my, mz], [mx, my - 0.5, mz], 0.01, 4);
        b.b('metal.paintGreen').cylinder([mx, my - 0.5, mz], [mx, my - 0.72, mz], 0.19, 8, { radius2: 0.06 });
        b.b('sign.lit').cylinder([mx, my - 0.7, mz], [mx, my - 0.74, mz], 0.11, 8);
      }
    }
  }

  /** Which street quadrant a point belongs to — four batches, four cull volumes. */
  function streetBat(x, z) {
    return getBatcher(`street_${x < 0 ? 0 : 1}${z < 0 ? 0 : 1}`);
  }

  function authorChannel() {
    const bat = getBatcher('channel');
    const c = CHANNEL;
    drainageChannel(bat, c);
    for (const b of c.bridges) {
      bridge(bat, b);
      railing(bat, b.x0 + 0.2, b.z0 + 0.12, b.x1 - 0.2, b.z0 + 0.12, b.y, { height: 1.05, mat: 'metal.rust' });
      railing(bat, b.x1 - 0.2, b.z1 - 0.12, b.x0 + 0.2, b.z1 - 0.12, b.y, { height: 1.05, mat: 'metal.rust' });
    }
    for (const r of c.ramps) {
      ramp(bat, { x: r.x, y: c.floorY, z: r.z, yaw: r.yaw, length: r.length, rise: r.rise, width: r.width });
    }
    for (const l of c.ladders) {
      ladder(bat, l.x, l.z, c.floorY + 0.05, c.topY + 0.95, l.nx, l.nz, { offset: 0.14 });
    }
    // Debris in the invert: cover down in the trench. Kept out of the ramp and
    // bridge footprints so nothing ever spawns a crate half inside a slab.
    const blocked = c.bridges
      .map((b) => [b.z0 - 0.6, b.z1 + 0.6])
      .concat(c.ramps.map((r) => [r.z - r.width * 0.5 - 0.6, r.z + r.width * 0.5 + 0.6]));
    for (let i = 0, placed = 0; i < 40 && placed < 8; i++) {
      const z = lerp(c.z0 + 4, c.z1 - 4, rng());
      const x = lerp(c.x0 + 1.1, c.x1 - 1.1, rng());
      if (blocked.some(([a, b]) => z > a && z < b)) continue;
      crate(bat, x, c.floorY + 0.06, z, 0.9, 0.85, 0.9, rng() * 3.1, { mat: rng() > 0.5 ? 'wood.ply' : 'wood.weathered' });
      placed++;
    }
    // Big pipe outfall through the west wall — a landmark from inside the trench,
    // placed on a clear stretch between the north bridge and the mid bridge.
    const pz = -12;
    const pm = bat.b('metal.rust');
    pm.cylinder([c.x0 - 0.05, c.floorY + 0.95, pz], [c.x0 + 1.5, c.floorY + 0.95, pz], 0.78, 14, { caps: false });
    pm.cylinder([c.x0 + 1.5, c.floorY + 0.95, pz], [c.x0 + 1.74, c.floorY + 0.95, pz], 0.92, 14);
    bat.box(c.x0 + 0.8, c.floorY + 0.95, pz, 0.85, 0.78, 0.78, 'metal');
    // Silt fan spilling out of it — the invert should not be swept clean.
    bat.b('ground.rubble').prism(
      [
        [c.x0 + 0.4, c.floorY + 0.04, pz - 1.5],
        [c.x0 + 3.4, c.floorY + 0.04, pz - 1.1],
        [c.x0 + 3.4, c.floorY + 0.04, pz + 1.1],
        [c.x0 + 0.4, c.floorY + 0.04, pz + 1.5],
      ],
      [
        [c.x0 + 0.45, c.floorY + 0.32, pz - 1.0],
        [c.x0 + 2.6, c.floorY + 0.1, pz - 0.75],
        [c.x0 + 2.6, c.floorY + 0.1, pz + 0.75],
        [c.x0 + 0.45, c.floorY + 0.32, pz + 1.0],
      ]
    );
  }

  function authorPlaza() {
    const bat = getBatcher('street_11');
    const px0 = 1;
    const px1 = 11;
    const pz0 = 4;
    const pz1 = 14;
    const y = TIERS.plaza;
    // Retaining edge on the east and west, steps north and south.
    for (const x of [px0, px1]) {
      lowWall(bat, x, pz0 + 0.6, x, pz1 - 0.6, 0, y, 0.4, 'struct.concreteClean', { coping: true, chamfer: 0.02 });
    }
    const nSteps = 5;
    const rise = y / nSteps;
    const run = 0.34;
    // North flight climbs in +Z onto the deck; south flight climbs in -Z.
    for (const [zTop, yaw] of [
      [pz0, -Math.PI / 2],
      [pz1, Math.PI / 2],
    ]) {
      const dz = yaw < 0 ? -1 : 1;
      stairs(bat, {
        x: (px0 + px1) * 0.5,
        y: 0,
        z: zTop + dz * nSteps * run,
        yaw,
        width: px1 - px0 - 1.6,
        steps: nSteps,
        rise,
        run,
        mat: 'ground.pave',
        nosingMat: 'struct.concreteClean',
        stringer: false,
        railing: 'none',
      });
    }
    // Plaza slab collision (the heightfield deliberately ignores the lift).
    bat.box((px0 + px1) * 0.5, y - 0.35, (pz0 + pz1) * 0.5, (px1 - px0) * 0.5, 0.35, (pz1 - pz0) * 0.5, 'concrete');

    // Fountain: octagonal basin, standing water, a central plinth.
    const fx = (px0 + px1) * 0.5;
    const fz = (pz0 + pz1) * 0.5;
    const seg = 8;
    const ring = (r, yy) => {
      const out = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2 + Math.PI / 8;
        out.push([fx + Math.cos(a) * r, yy, fz + Math.sin(a) * r]);
      }
      return out;
    };
    const fb = bat.b('struct.concreteClean');
    fb.prism(ring(2.15, y), ring(2.05, y + 0.62));
    // The one surface in the map that genuinely wants its normals pointing at the
    // solid's axis rather than away from it: the inside face of the basin.
    fb.prism(ring(1.72, y + 0.62), ring(1.78, y + 0.16), { cap: false, inward: true });
    bat.b('water.pool').poly(ring(1.7, y + 0.42), [0, 1, 0]);
    fb.box([fx, y + 0.98, fz], [0.36, 0.36, 0.36], { chamfer: 0.03 });
    fb.cylinder([fx, y + 1.3, fz], [fx, y + 1.72, fz], 0.13, 10, { radius2: 0.09 });
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2 + Math.PI / 8;
      bat.box(fx + Math.cos(a) * 1.95, y + 0.35, fz + Math.sin(a) * 1.95, 0.5, 0.35, 0.5, 'concrete');
    }
    bat.box(fx, y + 0.7, fz, 0.5, 0.7, 0.5, 'concrete');
  }

  function authorStreetFurniture() {
    /* kerbs along every carriageway edge */
    const runs = [
      [0, -46, 0, 28],
      [10, -46, 10, 28],
      [-50, -2, 46, -2],
      [-50, 4, 46, 4],
      [-50, -32, 46, -32],
      [-50, -42, 46, -42],
      [-50, 46, 46, 46],
      [-50, 56, 46, 56],
      [30, -44, 30, 30],
      [46, -44, 46, 30],
      [-44, -50, -44, 52],
      [-2, 28, -2, 52],
      [-14, 28, -14, 52],
    ];
    // Segmented so a 70 m kerb follows the ground instead of floating over it.
    for (const [x0, z0, x1, z1] of runs) {
      const L = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.round(L / 7));
      for (let i = 0; i < n; i++) {
        const ax = lerp(x0, x1, i / n);
        const az = lerp(z0, z1, i / n);
        const bx = lerp(x0, x1, (i + 1) / n);
        const bz = lerp(z0, z1, (i + 1) / n);
        const b = streetBat((ax + bx) * 0.5, (az + bz) * 0.5);
        kerb(b, ax, az, bx, bz, {
          y: terrain.baseHeight((ax + bx) * 0.5, (az + bz) * 0.5),
          height: 0.135,
          width: 0.26,
        });
      }
    }

    for (const d of DRAINS) stormDrain(streetBat(d.x, d.z), d.x, d.z, terrain.groundY(d.x, d.z) + 0.005, d.yaw);
    for (const [x, z] of MANHOLES) manhole(streetBat(x, z), x, z, terrain.groundY(x, z) + 0.005, rng);

    for (const f of FENCES) {
      const L = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
      const n = Math.max(1, Math.round(L / 10));
      for (let i = 0; i < n; i++) {
        const ax = lerp(f.x0, f.x1, i / n);
        const az = lerp(f.z0, f.z1, i / n);
        const bx = lerp(f.x0, f.x1, (i + 1) / n);
        const bz = lerp(f.z0, f.z1, (i + 1) / n);
        const b = streetBat((ax + bx) * 0.5, (az + bz) * 0.5);
        fence(b, ax, az, bx, bz, terrain.groundY((ax + bx) * 0.5, (az + bz) * 0.5) - 0.1, f.h ?? 2.4);
      }
    }

    /* archways over the alleys */
    for (const a of ARCHWAYS) {
      const b = streetBat(a.x, a.z);
      const half = a.w * 0.5;
      const dx = Math.cos(a.yaw);
      const dz = -Math.sin(a.yaw);
      wallRun(b, {
        x0: a.x - dx * half,
        z0: a.z - dz * half,
        x1: a.x + dx * half,
        z1: a.z + dz * half,
        y0: 0,
        y1: a.top,
        thick: 1.1,
        mat: a.mat,
        openings: [{ u: half, w: a.w - 1.0, h: a.h, sill: 0, type: 'arch' }],
        plinth: { h: 0.9, mat: 'struct.concrete', out: 0.05 },
        cornice: { h: 0.26, out: 0.14 },
        collide: true,
      });
    }

    /* cover rhythm */
    /**
     * Level geometry does not get the props system's overlap test, so a crate stack
     * authored on top of a lamp column just goes in and the pole comes out of the
     * middle of it. Anything that would land on a column is skipped here.
     */
    const clearOfLamps = (cx, cz, rad) => {
      for (const [lx, lz] of LAMPS) {
        if (Math.abs(lx - cx) < rad && Math.abs(lz - cz) < rad) return false;
      }
      return true;
    };
    for (const c of COVER) {
      const cx = c.x ?? (c.x0 + c.x1) * 0.5;
      const cz = c.z ?? (c.z0 + c.z1) * 0.5;
      if (c.kind !== 'bollards' && !clearOfLamps(cx, cz, 1.7)) continue;
      const b = streetBat(cx, cz);
      const gy = c.y !== undefined ? c.y : terrain.groundY(cx, cz);
      try {
        switch (c.kind) {
          case 'barrier':
            jerseyBarrier(b, cx, gy, cz, c.yaw || 0, c.len || 2.4);
            break;
          case 'planter':
            planter(b, cx, gy, cz, c.sx || 1.4, c.sz || 3.0, c.yaw || 0);
            break;
          case 'sandbag':
            sandbagWall(b, c.x0, c.z0, c.x1, c.z1, terrain.groundY(c.x0, c.z0), c.courses || 3);
            break;
          case 'stall':
            // Frame and goods deck vary per position, so the four street stalls are
            // four different traders rather than four copies of one prefab.
            marketStall(b, cx, gy, cz, c.yaw || 0, {
              variant: (Math.abs(Math.round(cx) + Math.round(cz) * 3) % 3) | 0,
              goods: (Math.abs(Math.round(cx) * 5 + Math.round(cz)) % 4) | 0,
              width: 2.4 + (Math.abs(Math.round(cz)) % 3) * 0.22,
              depth: 1.6 + (Math.abs(Math.round(cx)) % 2) * 0.24,
            });
            break;
          case 'crates':
            crateStack(b, cx, cz, gy, gy + (c.top || 1.8), c.yaw || 0, rng);
            break;
          case 'bollards': {
            const n = c.n || 5;
            for (let i = 0; i < n; i++) {
              const t = n === 1 ? 0.5 : i / (n - 1);
              const bx = lerp(c.x0, c.x1, t);
              const bz = lerp(c.z0, c.z1, t);
              b.instance('bollard', 'struct.concreteClean', bollardGeometry, instMatrix(bx, terrain.groundY(bx, bz), bz), geomCache);
              b.box(bx, terrain.groundY(bx, bz) + 0.45, bz, 0.12, 0.45, 0.12, 'concrete', { occlude: false });
            }
            break;
          }
          default:
            break;
        }
      } catch (err) {
        warn(`cover ${c.kind} failed`, err);
      }
    }

    /* lamp columns */
    for (const [x, z] of LAMPS) {
      const b = streetBat(x, z);
      const gy = terrain.groundY(x, z);
      const yaw = x < 5 ? 0 : Math.PI;
      b.instance('lamp', 'metal.paintGreen', () => lampGeometry(4.7), instMatrix(x, gy, z), geomCache);
      // The glazed bowl is its own instance in the emissive key, so the column reads
      // as a lit fitting at night instead of terminating in a small grey box.
      b.instance('lampBowl', 'sign.lit', () => lampBowlGeometry(4.7), instMatrix(x, gy, z), geomCache);
      b.box(x, gy + 2.3, z, 0.11, 2.3, 0.11, 'metal', { occlude: false });
      b.occluder({ type: 'box', pos: { x, y: gy + 2.4, z }, halfExtents: { x: 0.12, y: 2.4, z: 0.12 } });
      void yaw;
    }

    /* air-conditioners peppered up the residential facades */
    const acHosts = [
      ['apartments', 1],
      ['shophouses', 1],
      ['hotel', 2],
      ['ochre_row', 3],
    ];
    for (const [id, side] of acHosts) {
      const def = BUILDINGS.find((b) => b.id === id);
      if (!def) continue;
      const s = sideLine(def.rect, side, def.thick ?? 0.4);
      const bat = getBatcher(DISTRICT_OF[id]);
      const n = Math.max(2, Math.floor(s.len / 5));
      for (let i = 0; i < n; i++) {
        const u = ((i + 0.5) * s.len) / n;
        const p = sidePoint(def.rect, side, def.thick ?? 0.4, u, (def.thick ?? 0.4) * 0.5 + 0.24);
        const y = (def.base ?? 0) + (def.levels[0] || 3.6) + 0.9 + (i % 2) * 0.4;
        bat.instance('ac', 'metal.galv', acUnitGeometry, instMatrix(p.x, y, p.z, s.yaw), geomCache);
      }
    }
  }

  /**
   * The vertical routes that are NOT part of a building descriptor: crate stacks,
   * wall ladders and a scaffold. Every one of these is referenced by a LevelData
   * LINK, so if you change a height here, change the link too.
   */
  function authorMantles() {
    const b = getBatcher('street_00');
    // Back alley: crates to 3.1 m, then a wall ladder the rest of the way onto the
    // garage's corrugated deck at 6.72 m. Crates alone were a 3.6 m dead end.
    crateStack(b, -24.2, -14, terrain.groundY(-24.2, -14), 3.1, 0.15, rng);
    ladder(b, -24.88, -14, terrain.groundY(-24.88, -14) + 2.4, 7.7, 1, 0, {
      offset: 0.16,
      mat: 'metal.rust',
    });
    // Onto the warehouse loading dock and then its roof.
    const be = getBatcher('street_01');
    crateStack(be, 47.0, -30, terrain.groundY(47, -30), 2.6, -0.2, rng);

    // Kiosks block: a straight ladder up the east face to the low roof (3.4 m).
    const bk = getBatcher('blk_westS');
    ladder(bk, -29.9, 36.0, terrain.groundY(-29.9, 36) + 0.1, 4.5, 1, 0, {
      offset: 0.18,
      mat: 'metal.rust',
    });

    // Scaffold against the shophouses in Souk Street: three bays along the facade,
    // running the full height so the "mantle onto a roof" route the layout promises
    // actually exists.
    const bs = getBatcher('street_11');
    // Standing on the Souk Street pavement against the shophouses' east wall (x = -2),
    // so the run goes along Z and the ties reach the wall in -X.
    scaffoldRun(bs, { x: -1.2, z: 18.0, axis: 'z', bays: 3, pitch: 2.9, lifts: 5, lift: 1.35, depth: 1.1, face: -1 });
  }

  /**
   * A scaffold that could actually stand up.
   *
   * What was here before failed every basic test: one isolated bay on a 20 m facade,
   * a single 7.5 m ladder flight running straight *through* all five decks, bare
   * plywood with no toe boards or guard rails, bracing only across the 1.1 m depth and
   * never in the plane of the face, no base plates and no wall ties — so it read as a
   * gameplay ladder wearing a costume.
   *
   * This builds it the way a real one goes up:
   *   • standards on **base plates and sole boards**, three bays along the facade;
   *   • ledgers and transoms at every lift, decks made of five separate boards;
   *   • a **hatch cut in every deck**, with the ladder in a stagger — a short flight
   *     per lift, alternating end to end, never one continuous 7.5 m run;
   *   • **toe boards** on both edges and a **guard rail + mid rail** on the outboard
   *     face of every lift;
   *   • **face bracing** in the plane of the 2.9 m bay, not just across the depth;
   *   • **wall ties** back to the building, two per lift.
   */
  function scaffoldRun(bat, o) {
    const bays = Math.max(1, o.bays ?? 3);
    const pitch = o.pitch ?? 2.9; // bay length along the facade
    const lifts = o.lifts ?? 5;
    const lh = o.lift ?? 1.35; // lift height
    const dep = o.depth ?? 1.1; // inner-to-outer standard spacing
    const face = o.face ?? -1; // which side of the run the building is on
    const alongZ = o.axis === 'z';
    const gy = terrain.groundY(o.x, o.z);
    const topY = lifts * lh + 0.8;
    const run = bays * pitch;
    /** local (u along the facade, v across the depth) -> world [x, z] */
    const W = (u, v) => (alongZ ? [o.x + v, o.z + u] : [o.x + u, o.z + v]);
    const P = (u, y, v) => {
      const w = W(u, v);
      return [w[0], y, w[1]];
    };
    const u0 = -run / 2;
    const u1 = run / 2;
    const vIn = face * dep * 0.5; // standard line nearest the wall
    const vOut = -face * dep * 0.5;
    const sc = bat.b('metal.galv');
    const nStd = bays + 1;
    const hx = alongZ ? dep * 0.5 + 0.06 : run * 0.5;
    const hz = alongZ ? run * 0.5 : dep * 0.5 + 0.06;

    /* standards on base plates and sole boards */
    for (let i = 0; i < nStd; i++) {
      const u = u0 + i * pitch;
      for (const v of [vIn, vOut]) {
        sc.cylinder(P(u, gy + 0.06, v), P(u, gy + topY, v), 0.038, 8);
        // base plate on a timber sole board — a standard resting straight on the
        // tarmac is what makes a scaffold read as dropped in rather than erected
        sc.box(P(u, gy + 0.035, v), [0.075, 0.025, 0.075], { chamfer: 0.006 });
        bat.b('wood.weathered').box(P(u, gy + 0.012, v), [0.16, 0.012, 0.16], { chamfer: 0.005 });
        // joint collar where two tubes couple
        sc.cylinder(P(u, gy + topY * 0.52, v), P(u, gy + topY * 0.52 + 0.14, v), 0.048, 8);
        const w = W(u, v);
        bat.box(w[0], gy + topY * 0.5, w[1], 0.09, topY * 0.5, 0.09, 'metal', { occlude: false });
      }
    }

    for (let l = 1; l <= lifts; l++) {
      const y = gy + l * lh;
      /* ledgers along the facade, both standard lines, plus a lower rail */
      for (const v of [vIn, vOut]) {
        sc.cylinder(P(u0 - 0.14, y, v), P(u1 + 0.14, y, v), 0.03, 6);
        sc.cylinder(P(u0 - 0.14, y - 0.42, v), P(u1 + 0.14, y - 0.42, v), 0.022, 5);
      }
      /* transoms across the depth at every standard */
      for (let i = 0; i < nStd; i++) {
        const u = u0 + i * pitch;
        sc.cylinder(P(u, y + 0.012, vIn), P(u, y + 0.012, vOut), 0.028, 6);
      }

      /* decking: five boards per bay, with a real hatch cut in one bay per lift */
      const hatchBay = l % 2 === 0 ? 0 : bays - 1;
      const nBoards = 5;
      const bw = (dep - 0.06) / (2 * nBoards);
      const hv = -face * 0.24; // the hatch sits on the outboard side of the deck
      const ha = hatchBay === 0 ? u0 + 0.16 : u1 - 0.88;
      const hb = ha + 0.72;
      const pl = bat.b('wood.ply');
      for (let b = 0; b < bays; b++) {
        const ba = u0 + b * pitch;
        const bb = ba + pitch;
        for (let k = 0; k < nBoards; k++) {
          const v = ((k + 0.5) / nBoards - 0.5) * (dep - 0.06);
          const cut = b === hatchBay && Math.abs(v - hv) < 0.28;
          const spans = cut ? [[ba + 0.02, ha], [hb, bb - 0.02]] : [[ba + 0.02, bb - 0.02]];
          for (const [sa, sb] of spans) {
            if (sb - sa < 0.12) continue;
            const c = (sa + sb) * 0.5;
            const half = (sb - sa) * 0.5;
            pl.box(P(c, y + 0.055, v), alongZ ? [bw, 0.028, half] : [half, 0.028, bw], { chamfer: 0.006 });
          }
        }
        // steel end band on each deck
        sc.box(P(ba + 0.06, y + 0.055, 0), alongZ ? [dep * 0.46, 0.035, 0.02] : [0.02, 0.035, dep * 0.46], { chamfer: 0.004 });
        const cw = W(ba + pitch * 0.5, 0);
        bat.box(cw[0], y + 0.055, cw[1], alongZ ? dep * 0.48 : pitch * 0.5, 0.055, alongZ ? pitch * 0.5 : dep * 0.48, 'wood');
        bat.occluder({
          type: 'box',
          pos: { x: cw[0], y: y + 0.055, z: cw[1] },
          halfExtents: { x: alongZ ? dep * 0.5 : pitch * 0.5, y: 0.09, z: alongZ ? pitch * 0.5 : dep * 0.5 },
        });
      }

      /* toe boards on both edges */
      for (const s of [-1, 1]) {
        const c = W(0, s * (dep * 0.5 - 0.03));
        bat.b('wood.weathered').box([c[0], y + 0.16, c[1]], alongZ ? [0.018, 0.11, run * 0.5] : [run * 0.5, 0.11, 0.018], {
          chamfer: 0.004,
        });
      }
      /* guard rail + mid rail on the outboard face, and returns at both ends */
      sc.cylinder(P(u0 - 0.14, y + 0.98, vOut), P(u1 + 0.14, y + 0.98, vOut), 0.024, 5);
      sc.cylinder(P(u0 - 0.14, y + 0.56, vOut), P(u1 + 0.14, y + 0.56, vOut), 0.02, 5);
      for (const u of [u0 - 0.02, u1 + 0.02]) {
        sc.cylinder(P(u, y + 0.98, vIn), P(u, y + 0.98, vOut), 0.022, 5);
      }

      /* wall ties: two per lift, tube plus wall plate, back into the building */
      for (const f of [0.26, 0.76]) {
        const u = u0 + run * f;
        sc.cylinder(P(u, y - 0.1, vIn), P(u, y - 0.1, vIn + face * 0.62), 0.024, 5);
        bat.b('metal.rust').box(P(u, y - 0.1, vIn + face * 0.66), [0.06, 0.06, 0.06], { chamfer: 0.008 });
      }

      /* the climb: one short flight per lift, staggered end to end and landing
         through the hatch, instead of one 7.5 m run passing through every deck */
      const lu = hatchBay === 0 ? u0 + 0.52 : u1 - 0.52;
      const lw = W(lu, hv);
      const n = alongZ ? [-face, 0] : [0, -face];
      ladder(bat, lw[0], lw[1], y - lh, y + 0.95, n[0], n[1], { offset: 0.2, mat: 'metal.galv' });
    }

    /* face bracing IN THE PLANE OF THE FACADE, alternating bay to bay: without it the
       frame is a parallelogram and would rack flat under its own weight */
    for (let b = 0; b < bays; b++) {
      for (let l = 0; l < lifts; l++) {
        if ((b + l) % 2) continue;
        const a = u0 + b * pitch;
        const c = a + pitch;
        sc.cylinder(P(a, gy + l * lh + 0.1, vOut), P(c, gy + (l + 1) * lh + 0.1, vOut), 0.019, 5);
      }
    }
    /* ledger bracing across the depth, every other standard */
    for (let b = 0; b <= bays; b += 2) {
      const a = u0 + b * pitch;
      for (let l = 0; l < lifts; l++) {
        sc.cylinder(P(a, gy + l * lh + 0.1, vIn), P(a, gy + (l + 1) * lh + 0.1, vOut), 0.018, 5);
      }
    }

    /* debris sheeting over the outboard face of the top lifts — the silhouette this
       needs from the street, and a real solid so the hem catches light */
    const tp = bat.b('fabric.canvas');
    const ty1 = gy + lifts * lh + 0.9;
    const ty0 = gy + Math.max(0, lifts - 2) * lh;
    const segs = bays * 3;
    const vf = vOut - face * 0.05;
    for (let i = 0; i < segs; i++) {
      const a = lerp(u0, u1, i / segs);
      const c = lerp(u0, u1, (i + 1) / segs);
      const s0 = Math.sin((i / segs) * Math.PI * 2.2) * 0.09;
      const s1 = Math.sin(((i + 1) / segs) * Math.PI * 2.2) * 0.09;
      tp.prism(
        [P(a, ty0 - s0, vf - face * 0.025), P(c, ty0 - s1, vf - face * 0.025), P(c, ty0 - s1, vf), P(a, ty0 - s0, vf)],
        [P(a, ty1 - s0 * 0.4, vf - face * 0.025), P(c, ty1 - s1 * 0.4, vf - face * 0.025), P(c, ty1 - s1 * 0.4, vf), P(a, ty1 - s0 * 0.4, vf)]
      );
    }
    void hx;
    void hz;
  }

  /* ══════════════════════════════════════════════════════════════════ lights ══ */

  function authorLights() {
    const L = ctx.lighting;
    if (!L?.addLight) return;
    // Street lamps: only the ones that matter for the night pose, so the light
    // manager's slot budget is spent where the camera actually is.
    const keyLamps = [
      [-0.6, -22],
      [-0.6, -6],
      [-0.6, 18],
      [12.2, -16],
      [12.2, 2],
      [12.2, 22],
      [-24, 4],
      [29.2, -12],
      [-43.2, -4],
      [4, 26.5],
    ];
    for (const [x, z] of keyLamps) {
      const y = terrain.groundY(x, z) + 4.6;
      lights.push(
        L.addLight({
          type: 'spot',
          position: [x + (x < 5 ? 0.9 : -0.9), y, z],
          direction: [0, -1, 0],
          kelvin: 2450,
          intensity: 42,
          radius: 13,
          angle: 1.15,
          penumbra: 0.65,
          priority: 2,
          flicker: { amount: 0.035, speed: 7.3 },
        })
      );
    }
    // Interior practicals: the market hall and the hotel lobby read as inhabited.
    const practicals = [
      { p: [-8, 3.4, -14], k: 3000, i: 26, r: 11 },
      { p: [-16, 3.4, -20], k: 3000, i: 20, r: 9 },
      // South end of the hall — the half the interior review pose actually looks at.
      { p: [-12, 3.6, -6.5], k: 3000, i: 22, r: 10 },
      { p: [7, 3.1, 37], k: 2900, i: 22, r: 10 },
      // The blue shophouse ground floor: the `weapon` review camera stands in it, and
      // an unlit shop reads as a cave no matter how well it is dressed.
      // Kept off the partition: at 1.5 m the falloff blew the plaster out to a flat
      // cream gradient with no texture left in it at all.
      { p: [-5.4, 2.85, 12.6], k: 2850, i: 11, r: 7 },
      { p: [-13.4, 2.85, 11.4], k: 2850, i: 9, r: 6 },
      { p: [-33, 4.8, -18], k: 4200, i: 24, r: 12 },
      { p: [21, 4.4, -20], k: 5200, i: 34, r: 12 },
    ];
    for (const q of practicals) {
      lights.push(
        L.addLight({ type: 'point', position: q.p, kelvin: q.k, intensity: q.i, radius: q.r, priority: 1 })
      );
    }
  }

  /* ═══════════════════════════════════════════════════════════════════ bake ══ */

  function bakeAO() {
    const t0 = now();
    field.build();
    const cache = new Map();
    let verts = 0;
    for (const bat of batchers.values()) for (const mb of bat.builders()) verts += mb.vertexCount;
    // Keep the bake bounded on very slow machines without changing the look much.
    const samples = verts > 420000 ? 8 : verts > 240000 ? 10 : 13;
    for (const bat of batchers.values()) {
      // Nothing beyond the play space gets a bake: proximity occlusion is a 2.7 m
      // effect and these are 60 m to 1 km out, so every ray would miss. Skipping them
      // is both correct and the cheapest thing we can do to the boot cost.
      if (bat.name === 'horizon' || bat.name === 'backdrop') continue;
      const isTerrain = bat.name.startsWith('terrain');
      // LOD 0 only. Every building is authored three times and the shells are never
      // seen closer than 62 m, where a 2.7 m proximity term is invisible — baking them
      // was a third of the bake for nothing. Unbaked geometry reads codOcc = 0, which
      // is the documented "render unoccluded" default, so this can only be safe.
      for (const mb of bat.builders(0)) {
        bakeOcclusion(field, mb.p, mb.n, mb.o, {
          samples: isTerrain ? Math.max(8, samples - 3) : samples,
          strength: isTerrain ? 0.95 : 1.0,
          gamma: 0.85,
          cache,
        });
      }
    }
    api.stats.aoMs = Math.round(now() - t0);
    api.stats.vertices = verts;
  }

  /* ══════════════════════════════════════════════════════════════════ output ══ */

  function assemble() {
    root = new THREE.Group();
    root.name = 'level';
    root.matrixAutoUpdate = false;
    let groups = 0;
    let tris = 0;
    for (const bat of batchers.values()) {
      let obj = null;
      try {
        obj = bat.build({ lodDistances: [0, 62, 130], geometryCache: geomCache });
      } catch (err) {
        warn(`district ${bat.name} failed to build`, err);
      }
      if (!obj) continue;
      // The far distance never casts or receives shadows. A 2 km ridge in the shadow
      // caster set would drag every cascade's fit out to the horizon and turn the
      // near shadows to mush — and none of it is resolvable at that range anyway.
      const far = bat.name === 'horizon' || bat.name === 'backdrop';
      /**
       * The outer ground rings do not cast either. They are flat dirt from the fence
       * out to 240 m at a 6-24 m cell: a horizontal plane's only shadow is on itself,
       * and every one of those quads was being re-rasterised into all four cascades.
       * The play-space terrain keeps casting — its kerbs, plaza upstand and yard
       * edges have real risers and a 15-degree sun makes real shadows off them.
       */
      const flatApron = bat.name === 'terrain_apron' || bat.name === 'terrain_outer';
      obj.traverse((o) => {
        if (o.isMesh) {
          groups++;
          if (far) {
            o.castShadow = false;
            o.receiveShadow = false;
          } else if (flatApron) {
            o.castShadow = false;
          }
          const idx = o.geometry?.index;
          if (idx) tris += idx.count / 3;
        }
      });
      root.add(obj);
    }
    root.updateMatrixWorld(true);
    api.stats.drawGroups = groups;
    api.stats.triangles = Math.round(tris);
    api.stats.materials = palette.cache.size;
    ctx.scene?.add(root);
    api.root = root;
  }

  function registerCollision() {
    const phys = ctx.physics;
    if (!phys?.addStatic) return;
    for (const c of api.colliders) {
      try {
        const b = phys.addStatic(c);
        if (b) {
          bodies.push(b);
          if (c.faceSurfaces) b.faceSurfaces = c.faceSurfaces;
          if (c.tag) b.tag = c.tag;
        }
      } catch (err) {
        warn('collider rejected', err);
      }
    }
    api.stats.colliders = bodies.length;
    try {
      phys.setFallbackGround?.(false);
    } catch {
      /* optional */
    }
  }

  /* ════════════════════════════════════════════════════════════════ spawning ══ */

  function buildSpawns() {
    const phys = ctx.physics;
    const org = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    api.spawnPoints = SPAWNS.map((s, i) => {
      const [sx, sy, sz] = s.pos;
      let y = sy;
      let surf = terrain ? terrain.surfaceAt(sx, sz) : 'dirt';
      // Drop onto whatever is actually there. The terrain model alone gets this
      // wrong wherever the ground is a void the level fills in itself — the channel
      // invert most of all, where `groundY` reports grade and the spawn would hang
      // 2.6 m in the air.
      let snapped = false;
      if (phys?.raycast) {
        org.set(sx, sy + 1.7, sz);
        const hit = phys.raycast(org, down, 6.0, 1);
        if (hit && hit.normal.y > 0.5) {
          y = hit.point.y;
          surf = hit.surface || surf;
          snapped = true;
        }
      }
      if (!snapped && terrain) {
        y = sy < -0.05 ? sy : Math.max(sy, terrain.groundY(sx, sz));
      }
      y += 0.02;
      return {
        id: `spawn_${i}`,
        pos: new THREE.Vector3(sx, y, sz),
        position: new THREE.Vector3(sx, y, sz),
        yaw: s.yaw,
        team: s.team,
        surface: surf,
      };
    });
    api.pointsOfInterest = POIS.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      pos: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]),
      radius: p.radius,
    }));
  }

  /**
   * Pick a spawn for `team`, biased away from `avoid` (usually live enemies) the way
   * a real spawn system does — nearest-threat distance, then a seeded shuffle.
   */
  api.getSpawn = function getSpawn(team = 'ffa', avoid = null, r = null) {
    const pool = api.spawnPoints.filter((s) => (team ? s.team === team : true));
    const list = pool.length ? pool : api.spawnPoints;
    if (!list.length) return null;
    if (!avoid || !avoid.length) {
      const pick = Math.floor((r ? r() : rng()) * list.length);
      return list[Math.min(list.length - 1, pick)];
    }
    let best = list[0];
    let bestD = -1;
    for (const s of list) {
      let d = Infinity;
      for (const a of avoid) {
        const p = a.position || a.pos || a;
        const dd = (p.x - s.pos.x) ** 2 + (p.z - s.pos.z) ** 2;
        if (dd < d) d = dd;
      }
      const jitter = 1 + ((r ? r() : rng()) - 0.5) * 0.25;
      if (d * jitter > bestD) {
        bestD = d * jitter;
        best = s;
      }
    }
    return best;
  };

  /* ═════════════════════════════════════════════════════════════════════ nav ══ */

  const NAV_CELL = 2;
  /** Below this the only thing a ray can hit is Terrain's fall-catch slab at y = -6. */
  const NAV_MIN_FLOOR = TIERS.channel - 0.4; // the channel invert still counts, the -6 slab does not
  const NAV_MAX_FLOOR = 3.4; // above this you are on a roof, which lives in `polys`
  const NAV_STAND = 1.85; // metres of headroom a bot needs
  // Biggest floor-to-floor change a bot can walk. The channel ramps climb 0.93 m per
  // cell, so this has to clear that; the knee/chest ray below is what actually stops
  // a bot walking up a 1 m wall.
  const NAV_STEP = 1.0;

  function buildNav() {
    const x0 = BOUNDS.playMinX;
    const z0 = BOUNDS.playMinZ;
    const cols = Math.ceil((BOUNDS.playMaxX - x0) / NAV_CELL);
    const rows = Math.ceil((BOUNDS.playMaxZ - z0) / NAV_CELL);
    const n = cols * rows;
    const standable = new Uint8Array(n);
    const walkable = new Uint8Array(n);
    const floor = new Float32Array(n);
    const clearance = new Float32Array(n);
    const surfIdx = new Uint8Array(n);
    const openX = new Uint8Array(n);
    const openZ = new Uint8Array(n);
    const islands = new Int16Array(n).fill(-1);
    // §5 surface tags, in the canonical order, so an index is meaningful elsewhere.
    const surfaces = [
      'concrete', 'metal', 'wood', 'dirt', 'sand', 'grass', 'glass', 'water',
      'fabric', 'flesh', 'rubber', 'plaster', 'ceramic', 'foliage', 'snow',
    ];
    const sIndex = (s) => {
      const i = surfaces.indexOf(s);
      return i < 0 ? 3 : i; // unknown reads as dirt
    };
    const phys = ctx.physics;
    const down = new THREE.Vector3(0, -1, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const org = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const cellX = (i) => x0 + (i + 0.5) * NAV_CELL;
    const cellZ = (j) => z0 + (j + 0.5) * NAV_CELL;

    /* ── pass 1: find the standing surface in every cell ─────────────────── */
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const cx = cellX(i);
        const cz = cellZ(j);
        const k = j * cols + i;
        let y = terrain ? terrain.groundY(cx, cz) : 0;
        let surf = terrain ? terrain.surfaceAt(cx, cz) : 'dirt';
        let head = NAV_STAND;
        let ok = true;

        if (phys?.raycastAll) {
          org.set(cx, 48, cz);
          const hits = phys.raycastAll(org, down, 80, 1, 16) || [];
          // Lowest real floor first: a bot walks the ground layer, not the roof.
          const cand = hits
            .filter((h) => h.normal.y >= 0.6 && h.point.y >= NAV_MIN_FLOOR && h.point.y <= NAV_MAX_FLOOR)
            .sort((a, b) => a.point.y - b.point.y);
          let picked = null;
          for (const hit of cand) {
            org.set(cx, hit.point.y + 0.22, cz);
            const overhead = phys.raycast(org, up, NAV_STAND + 0.5, 1);
            // A ray that starts inside a wall reports distance 0 — exactly the
            // signal we want for "this cell is solid".
            const room = overhead ? overhead.distance + 0.22 : NAV_STAND + 0.72;
            if (room < NAV_STAND) continue;
            picked = hit;
            head = Math.min(room, 4);
            break;
          }
          if (picked) {
            y = picked.point.y;
            surf = picked.surface || surf;
          } else {
            ok = false;
          }
        } else {
          // No physics: fall back to the terrain model and veto building footprints.
          for (const b of BUILDINGS) {
            const r = b.rect;
            if (cx > r[0] && cx < r[2] && cz > r[1] && cz < r[3]) {
              ok = false;
              break;
            }
          }
        }
        standable[k] = ok ? 1 : 0;
        floor[k] = y;
        clearance[k] = ok ? head : 0;
        surfIdx[k] = sIndex(surf);
      }
    }

    /* ── pass 2: which cell-to-cell steps a body can actually make ───────── */
    // Grid adjacency alone would walk straight through a 0.5 m wall, so each edge
    // is probed with a knee-height ray between the two standing positions.
    const edgeOpen = (ka, kb, ax, az, bx, bz) => {
      if (!standable[ka] || !standable[kb]) return 0;
      const ya = floor[ka];
      const yb = floor[kb];
      if (Math.abs(yb - ya) > NAV_STEP) return 0;
      if (!phys?.raycast) return 1;
      const h = 0.5;
      org.set(ax, ya + h, az);
      dir.set(bx - ax, yb - ya, bz - az);
      const len = dir.length();
      if (len < 1e-4) return 1;
      dir.multiplyScalar(1 / len);
      if (phys.raycast(org, dir, len, 1)) return 0;
      // A second probe at chest height catches shutters, beams and railings that
      // start above the knee.
      org.set(ax, ya + 1.35, az);
      if (phys.raycast(org, dir, len, 1)) return 0;
      return 1;
    };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (i + 1 < cols) openX[k] = edgeOpen(k, k + 1, cellX(i), cellZ(j), cellX(i + 1), cellZ(j));
        if (j + 1 < rows) openZ[k] = edgeOpen(k, k + cols, cellX(i), cellZ(j), cellX(i), cellZ(j + 1));
      }
    }

    /* ── pass 3: connected components, then keep the ones a spawn touches ── */
    const stack = [];
    let island = 0;
    const sizes = [];
    for (let s = 0; s < n; s++) {
      if (!standable[s] || islands[s] >= 0) continue;
      const id = island++;
      let size = 0;
      stack.length = 0;
      stack.push(s);
      islands[s] = id;
      while (stack.length) {
        const k = stack.pop();
        size++;
        const i = k % cols;
        const j = (k - i) / cols;
        if (i + 1 < cols && openX[k] && islands[k + 1] < 0) {
          islands[k + 1] = id;
          stack.push(k + 1);
        }
        if (i > 0 && openX[k - 1] && islands[k - 1] < 0) {
          islands[k - 1] = id;
          stack.push(k - 1);
        }
        if (j + 1 < rows && openZ[k] && islands[k + cols] < 0) {
          islands[k + cols] = id;
          stack.push(k + cols);
        }
        if (j > 0 && openZ[k - cols] && islands[k - cols] < 0) {
          islands[k - cols] = id;
          stack.push(k - cols);
        }
      }
      sizes.push(size);
    }
    // An island is "live" if a spawn stands in it. The largest island is kept
    // unconditionally as a safety net: if a data change ever orphaned every spawn,
    // losing the whole street network would be a far worse failure than keeping one
    // component the spawns happen not to touch.
    const live = new Set();
    const idxOf = (x, z) => {
      const i = Math.floor((x - x0) / NAV_CELL);
      const j = Math.floor((z - z0) / NAV_CELL);
      if (i < 0 || j < 0 || i >= cols || j >= rows) return -1;
      return j * cols + i;
    };
    const spawnCells = [];
    for (const s of api.spawnPoints) {
      const k = idxOf(s.pos.x, s.pos.z);
      spawnCells.push(k);
      if (k >= 0 && islands[k] >= 0) live.add(islands[k]);
    }
    let biggest = -1;
    let biggestSize = -1;
    for (let a = 0; a < sizes.length; a++) {
      if (sizes[a] > biggestSize) {
        biggestSize = sizes[a];
        biggest = a;
      }
    }
    if (biggest >= 0) live.add(biggest);
    let count = 0;
    for (let k = 0; k < n; k++) {
      const w = standable[k] && islands[k] >= 0 && live.has(islands[k]) ? 1 : 0;
      walkable[k] = w;
      count += w;
    }

    // Upper decks as convex polygons: every flat roof, the mezzanine and the canopy.
    const polys = [];
    for (const b of BUILDINGS) {
      const roof = b.roof || {};
      if (roof.kind === 'pitch' || roof.kind === 'none') continue;
      const ys = (b.levels || []).reduce((a, h) => a + h, b.base ?? 0);
      const inset = (b.thick ?? 0.4) + 0.35;
      polys.push({
        id: `roof_${b.id}`,
        points: [
          [b.rect[0] + inset, b.rect[1] + inset],
          [b.rect[2] - inset, b.rect[1] + inset],
          [b.rect[2] - inset, b.rect[3] - inset],
          [b.rect[0] + inset, b.rect[3] - inset],
        ],
        y: ys + (roof.kind === 'corrugated' ? 0.32 : 0),
        tier: 'roof',
        tags: ['roof', b.id],
      });
    }
    polys.push({
      id: 'mezz_market_hall',
      points: [
        [-20.4, -25.4],
        [-11.8, -25.4],
        [-11.8, -2.6],
        [-20.4, -2.6],
      ],
      y: 4.2,
      tier: 'floor1',
      tags: ['interior', 'market_hall'],
    });
    polys.push({
      id: 'roof_fuel_kiosk',
      points: [
        [FUEL.kiosk.rect[0] + 0.5, FUEL.kiosk.rect[1] + 0.5],
        [FUEL.kiosk.rect[2] - 0.5, FUEL.kiosk.rect[1] + 0.5],
        [FUEL.kiosk.rect[2] - 0.5, FUEL.kiosk.rect[3] - 0.5],
        [FUEL.kiosk.rect[0] + 0.5, FUEL.kiosk.rect[3] - 0.5],
      ],
      y: FUEL.kiosk.h,
      tier: 'roof',
      tags: ['roof', 'step'],
    });
    polys.push({
      id: 'canopy_fuel',
      points: [
        [FUEL.canopy.x0, FUEL.canopy.z0],
        [FUEL.canopy.x1, FUEL.canopy.z0],
        [FUEL.canopy.x1, FUEL.canopy.z1],
        [FUEL.canopy.x0, FUEL.canopy.z1],
      ],
      y: FUEL.canopy.y + 0.08,
      tier: 'roof',
      tags: ['roof', 'vantage'],
    });
    polys.push({
      id: 'channel_floor',
      points: [
        [CHANNEL.x0 + 0.2, CHANNEL.z0 + 0.2],
        [CHANNEL.x1 - 0.2, CHANNEL.z0 + 0.2],
        [CHANNEL.x1 - 0.2, CHANNEL.z1 - 0.2],
        [CHANNEL.x0 + 0.2, CHANNEL.z1 - 0.2],
      ],
      y: CHANNEL.floorY + 0.06,
      tier: 'channel',
      tags: ['route', 'lowground'],
    });

    const links = LINKS.map((l) => ({ ...l, pos: l.pos.slice() }));

    const nav = {
      format: 'cod-navgrid-2',
      cell: NAV_CELL,
      origin: [x0, z0],
      cols,
      rows,
      standable,
      walkable,
      floor,
      clearance,
      surface: surfIdx,
      surfaces,
      openX,
      openZ,
      islands,
      spawnCells,
      stepUp: NAV_STEP,
      standHeight: NAV_STAND,
      polys,
      links,
      index(x, z) {
        const i = Math.floor((x - x0) / NAV_CELL);
        const j = Math.floor((z - z0) / NAV_CELL);
        if (i < 0 || j < 0 || i >= cols || j >= rows) return -1;
        return j * cols + i;
      },
      isWalkable(x, z) {
        const k = nav.index(x, z);
        return k >= 0 && walkable[k] === 1;
      },
      floorAt(x, z) {
        const k = nav.index(x, z);
        return k >= 0 && standable[k] ? floor[k] : terrain ? terrain.groundY(x, z) : 0;
      },
      clearanceAt(x, z) {
        const k = nav.index(x, z);
        return k >= 0 ? clearance[k] : 0;
      },
      surfaceAt(x, z) {
        const k = nav.index(x, z);
        return k >= 0 ? surfaces[surfIdx[k]] : 'dirt';
      },
      cellCentre(k) {
        const i = k % cols;
        const j = (k - i) / cols;
        return [x0 + (i + 0.5) * NAV_CELL, z0 + (j + 0.5) * NAV_CELL];
      },
      /** dir: 0 = +X, 1 = -X, 2 = +Z, 3 = -Z. */
      isOpen(k, dirIndex) {
        if (k < 0 || k >= n) return false;
        const i = k % cols;
        const j = (k - i) / cols;
        switch (dirIndex) {
          case 0:
            return i + 1 < cols && openX[k] === 1;
          case 1:
            return i > 0 && openX[k - 1] === 1;
          case 2:
            return j + 1 < rows && openZ[k] === 1;
          default:
            return j > 0 && openZ[k - cols] === 1;
        }
      },
      /** Indices of the 4-connected neighbours a bot can actually step to. */
      neighbours(k, out = []) {
        out.length = 0;
        if (k < 0 || k >= n) return out;
        const i = k % cols;
        const j = (k - i) / cols;
        if (i + 1 < cols && openX[k]) out.push(k + 1);
        if (i > 0 && openX[k - 1]) out.push(k - 1);
        if (j + 1 < rows && openZ[k]) out.push(k + cols);
        if (j > 0 && openZ[k - cols]) out.push(k - cols);
        return out;
      },
      /** Nearest walkable cell to (x,z) within `radius` metres, or -1. */
      nearestWalkable(x, z, radius = 8) {
        const k0 = nav.index(x, z);
        if (k0 >= 0 && walkable[k0]) return k0;
        const r = Math.ceil(radius / NAV_CELL);
        const i0 = Math.floor((x - x0) / NAV_CELL);
        const j0 = Math.floor((z - z0) / NAV_CELL);
        let best = -1;
        let bestD = Infinity;
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            const i = i0 + di;
            const j = j0 + dj;
            if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
            const k = j * cols + i;
            if (!walkable[k]) continue;
            const d = di * di + dj * dj;
            if (d < bestD) {
              bestD = d;
              best = k;
            }
          }
        }
        return best;
      },
    };
    nav.walkableCells = count;
    nav.standableCells = standable.reduce((a, v) => a + v, 0);
    nav.islandCount = island;
    api.navRegions = nav;
  }

  /* ═══════════════════════════════════════════════════════════════ portals ══ */

  /**
   * **Publish the apertures, and work out which way is indoors.**
   *
   * The wall kit records every opening it authors (kit/Walls.js `WALL_OPENINGS`) with
   * the wall's *outward* normal, which is a geometric fact about the footprint winding
   * and not necessarily the direction a room is in — a courtyard wall's "outward" face
   * is inside the block. So each aperture is probed: step half a metre to either side
   * and cast straight up. The side that is roofed is the room; the side that sees sky
   * is the street.
   *
   * Apertures with sky on both sides (a garden gate, a freestanding arch) are dropped —
   * they have no interior to light and would only add cost. Apertures with a roof on
   * both sides keep the side further from the play space as the source.
   *
   * Costs two raycasts per opening, once, at build time.
   */
  /**
   * How many frames the portal sweep is still allowed to re-run.
   *
   * `collectPortals()` needs a *queryable* physics world: it decides which side of each
   * aperture is indoors by casting straight up from either side. Our own colliders are
   * registered a few lines earlier in `init()`, but the broadphase they go into is only
   * guaranteed to be refit once the solver has stepped, and `ctx.props` (order 34) has
   * not run at all yet — so an init-time sweep can legitimately come back with nothing.
   * Retry for a few frames and stop as soon as it finds apertures.
   */
  let portalRetries = 4;

  function collectPortals() {
    const out = [];
    const phys = ctx.physics;
    const up = { x: 0, y: 1, z: 0 };
    const MASK = 1 | 8; // WORLD | PROP
    const probeUp = (x, y, z) => {
      if (!phys?.raycast) return false;
      try {
        return !!phys.raycast({ x, y, z }, up, 26, MASK);
      } catch {
        return false;
      }
    };
    for (const op of WALL_OPENINGS) {
      // Ignore anything too small to matter as a light source, and anything above the
      // top storey where nothing the player stands in can see it.
      const area = 4 * op.hw * op.hh;
      if (area < 0.55 || op.y > 26) continue;
      const step = 0.75;
      const ax = op.x + op.nx * step;
      const az = op.z + op.nz * step;
      const bx = op.x - op.nx * step;
      const bz = op.z - op.nz * step;
      const y = Math.max(op.y, 0.4);
      const roofA = probeUp(ax, y, az);
      const roofB = probeUp(bx, y, bz);
      if (!roofA && !roofB) continue; // open on both sides: a gate in a wall, no room
      /**
       * Roofed on both sides is not a mistake — it is a colonnade. The market hall's
       * arcade is four 2.6 x 3.5 m arches between a covered walkway and the hall, i.e.
       * the largest apertures on the map and the ones the interior camera is looking
       * straight at, and a strict "one side must see sky" test throws every one of them
       * away. Keep them, mark them two-sided (a negative `hh` carries the flag through
       * to the shader), and derate: an arch opening onto a shaded walkway transmits the
       * street at second hand, not the open sky.
       */
      const twoSided = roofA && roofB;
      const s = roofA ? 1 : -1;
      out.push({
        x: op.x,
        y: op.y,
        z: op.z,
        // inward = towards the room
        nx: op.nx * s,
        nz: op.nz * s,
        hw: op.hw,
        hh: twoSided ? -op.hh : op.hh,
        type: op.type,
        glazed: !!op.glazed,
      });
    }
    api.portals = out;
    api.stats.portals = out.length;
    api.stats.portalCandidates = WALL_OPENINGS.length;
    return out.length;
  }
  api.collectPortals = collectPortals;

  /* ═══════════════════════════════════════════════════════════════ utilities ══ */

  api.raycast = function raycast(origin, dir, maxDist = 200, mask = 0xffff) {
    return ctx.physics?.raycast ? ctx.physics.raycast(origin, dir, maxDist, mask) : null;
  };
  api.groundY = (x, z) => (terrain ? terrain.groundY(x, z) : 0);
  api.surfaceAt = (x, z) => (terrain ? terrain.surfaceAt(x, z) : 'dirt');
  api.isInside = (p) => {
    const x = p?.x ?? p?.[0] ?? 0;
    const z = p?.z ?? p?.[2] ?? 0;
    return x > BOUNDS.playMinX && x < BOUNDS.playMaxX && z > BOUNDS.playMinZ && z < BOUNDS.playMaxZ;
  };
  api.poi = (id) => api.pointsOfInterest.find((p) => p.id === id) || null;

  function warn(msg, err) {
    // Deliberately console.warn, never console.error: a partially built district must
    // not fail the CI smoke test when the rest of the map is fine.
    console.warn(`[level] ${msg}:`, err?.message || err);
  }
  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /* ══════════════════════════════════════════════════════════════════ system ══ */

  return {
    name: 'level',
    order: 32,

    /** Only job: give the aperture sweep a few frames' grace. See `portalRetries`. */
    update() {
      if (portalRetries <= 0) return;
      portalRetries--;
      try {
        if (collectPortals() > 0) portalRetries = 0;
      } catch (err) {
        portalRetries = 0;
        warn('portal collection failed', err);
      }
    },

    async init() {
      const t0 = now();
      ctx.level = api;
      palette = new Palette(ctx);
      field = new OcclusionField({ cell: 4, maxDist: 2.7 });
      resetWallOpenings();

      try {
        authorTerrain();
      } catch (err) {
        warn('terrain failed', err);
        terrain = terrain || new Terrain(ctx, []);
      }
      try {
        authorBuildings();
      } catch (err) {
        warn('buildings failed', err);
      }
      try {
        authorChannel();
      } catch (err) {
        warn('channel failed', err);
      }
      try {
        authorPlaza();
      } catch (err) {
        warn('plaza failed', err);
      }
      try {
        authorStreetFurniture();
      } catch (err) {
        warn('street furniture failed', err);
      }
      try {
        authorMantles();
      } catch (err) {
        warn('mantles failed', err);
      }
      try {
        authorCables();
      } catch (err) {
        warn('cables failed', err);
      }

      try {
        bakeAO();
      } catch (err) {
        warn('AO bake failed', err);
      }
      assemble();
      registerCollision();
      buildSpawns();
      try {
        buildNav();
      } catch (err) {
        warn('nav build failed', err);
      }
      try {
        authorLights();
      } catch (err) {
        warn('lights failed', err);
      }
      try {
        collectPortals();
      } catch (err) {
        warn('portal collection failed', err);
      }

      api.stats.buildMs = Math.round(now() - t0);
      api.ready = true;

      unsubs.push(
        ctx.bus?.on?.('quality:changed', ({ tier }) => {
          setVertexAOStrength(tier === 'low' ? 0.75 : 1.0);
        }) || (() => {})
      );

      ctx.bus?.emit?.('level:ready', {
        bounds: api.bounds,
        spawnPoints: api.spawnPoints,
        pointsOfInterest: api.pointsOfInterest,
        navRegions: api.navRegions,
        reflectionProbes: api.reflectionProbes,
      });
      ctx.bus?.emit?.('level:built', { stats: api.stats });
      portalRetries = 0;
      if (!ctx.settings?.get?.('headless')) {
        console.log(
          `[level] ${api.stats.drawGroups} meshes, ${(api.stats.triangles / 1000) | 0}k tris, ` +
            `${api.stats.colliders} colliders, ${api.stats.materials} materials, ` +
            `AO ${api.stats.aoMs}ms, total ${api.stats.buildMs}ms`
        );
      }
    },

    dispose() {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* best effort */
        }
      }
      unsubs.length = 0;
      for (const l of lights) {
        try {
          ctx.lighting?.removeLight?.(l);
        } catch {
          /* best effort */
        }
      }
      lights.length = 0;
      for (const b of bodies) {
        try {
          ctx.physics?.removeBody?.(b);
        } catch {
          /* best effort */
        }
      }
      bodies.length = 0;
      if (root) {
        root.traverse((o) => {
          if (o.isMesh) {
            try {
              o.geometry?.dispose();
            } catch {
              /* best effort */
            }
          }
        });
        ctx.scene?.remove(root);
        root = null;
      }
      for (const g of geomCache.values()) {
        try {
          g.dispose?.();
        } catch {
          /* best effort */
        }
      }
      geomCache.clear();
      palette?.dispose();
      batchers.clear();
      api.ready = false;
    },
  };
}
