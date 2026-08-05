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
import { wallRun, lowWall } from './kit/Walls.js';
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
  acUnitGeometry,
  instMatrix,
} from './kit/Street.js';
import { Terrain } from './Terrain.js';
import { buildBuilding, buildMinaret, buildFuelStation, buildBackdrop, sideLine, sidePoint } from './Buildings.js';
import DATA, {
  BOUNDS,
  TIERS,
  BUILDINGS,
  CHANNEL,
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
    const bd = getBatcher('backdrop');
    for (const b of BACKDROP) {
      try {
        buildBackdrop(bd, b);
      } catch (err) {
        warn('backdrop failed', err);
        bd.lod = 0;
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
    for (const c of COVER) {
      const cx = c.x ?? (c.x0 + c.x1) * 0.5;
      const cz = c.z ?? (c.z0 + c.z1) * 0.5;
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
            marketStall(b, cx, gy, cz, c.yaw || 0);
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

    // Scaffold against the shophouses in Souk Street. It now runs the full height of
    // the facade (7.2 m deck, 0.85 m parapet) instead of stopping at the balcony, so
    // the "mantle onto a roof" route the layout promises actually exists.
    const bs = getBatcher('street_11');
    const sx = -1.2;
    const sz = 16.5;
    const gy = terrain.groundY(sx, sz);
    const topY = 7.55;
    const sc = bs.b('metal.galv');
    for (const ox of [-1.4, 1.4]) {
      for (const oz of [-0.55, 0.55]) {
        sc.cylinder([sx + ox, gy, sz + oz], [sx + ox, gy + topY, sz + oz], 0.038, 8);
        // Diagonal bracing — a scaffold without it reads as four floating poles.
        for (let d = 0; d < 5; d++) {
          const ya = gy + 1.35 * d;
          const yb = gy + 1.35 * (d + 1);
          if (yb > gy + topY) break;
          sc.cylinder([sx + ox, ya, sz - 0.55], [sx + ox, yb, sz + 0.55], 0.018, 5);
        }
      }
      sc.cylinder([sx + ox, gy - 0.06, sz - 0.55], [sx + ox, gy - 0.06, sz + 0.55], 0.03, 6);
      bs.box(sx + ox, gy + topY * 0.5, sz, 0.06, topY * 0.5, 0.62, 'metal', { occlude: false });
    }
    for (const y of [1.35, 2.7, 4.05, 5.4, 6.75]) {
      sc.cylinder([sx - 1.4, gy + y, sz - 0.55], [sx + 1.4, gy + y, sz - 0.55], 0.03, 6);
      sc.cylinder([sx - 1.4, gy + y, sz + 0.55], [sx + 1.4, gy + y, sz + 0.55], 0.03, 6);
      const pl = bs.b('wood.ply');
      pl.box([sx, gy + y + 0.05, sz], [1.4, 0.03, 0.55], { chamfer: 0.008 });
      bs.box(sx, gy + y + 0.05, sz, 1.4, 0.06, 0.6, 'wood');
      bs.occluder({
        type: 'box',
        pos: { x: sx, y: gy + y + 0.05, z: sz },
        halfExtents: { x: 1.45, y: 0.09, z: 0.62 },
      });
    }
    ladder(bs, sx + 1.15, sz + 0.55, gy, gy + topY - 0.1, 0, 1, { offset: 0.24, mat: 'metal.galv' });
    // A tarp slung over the top lift: the silhouette this needs from Souk Street.
    const tp = bs.b('fabric.canvas');
    for (let i = 0; i < 6; i++) {
      const u0 = lerp(sx - 1.42, sx + 1.42, i / 6);
      const u1 = lerp(sx - 1.42, sx + 1.42, (i + 1) / 6);
      const s0 = Math.sin((i / 6) * Math.PI) * 0.12;
      const s1 = Math.sin(((i + 1) / 6) * Math.PI) * 0.12;
      tp.quad(
        [u0, gy + 6.78 - s0, sz - 0.57],
        [u1, gy + 6.78 - s1, sz - 0.57],
        [u1, gy + 5.5 - s1, sz - 0.62],
        [u0, gy + 5.5 - s0, sz - 0.62],
        [0, 0.04, -0.999]
      );
    }
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
      const isTerrain = bat.name.startsWith('terrain');
      for (const mb of bat.builders()) {
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
      obj.traverse((o) => {
        if (o.isMesh) {
          groups++;
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

    async init() {
      const t0 = now();
      ctx.level = api;
      palette = new Palette(ctx);
      field = new OcclusionField({ cell: 4, maxDist: 2.7 });

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
