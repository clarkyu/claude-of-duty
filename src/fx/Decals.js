/**
 * Decals — bullet holes, scorch, blood, footprints, tyre marks and static environment
 * dressing. Owner: decals agent. Files owned: this file, fx/DecalProjector.js.
 * Publishes: `ctx.decals` (from the factory, so every other system's `init()` can use it).
 *
 * ── How a decal gets on screen ──────────────────────────────────────────────────
 * Nothing here clips geometry. Each decal is a **box projector** rendered by
 * `DecalBatch` (see DecalProjector.js): the fragment shader reads a private scene-depth
 * prepass, reconstructs the view-space position of whatever is visible under the box,
 * rejects it if it falls outside the box or if the receiver's normal is turned too far
 * away, and paints albedo + tangent normal + roughness onto it with premultiplied alpha.
 * Curved walls, bevels, crates, rubble piles and the seam between two merged meshes all
 * just work, and nothing z-fights.
 *
 * Because the batch material is a real `MeshStandardMaterial`, Lighting.js finds it in
 * its scan and the holes receive the same sun, CSM cascades, SH irradiance and probes as
 * the wall around them — which is the whole reason a bullet hole reads as a *hole* and
 * not as a dark sticker. Every hole ships a normal map and a roughness value, so it
 * catches a rim highlight when the sun rakes across it, and a one-tap parallax offset
 * makes the crater slide correctly as you walk past.
 *
 * ── Per-surface holes ───────────────────────────────────────────────────────────
 * The atlas cell is chosen from `ctx.materials.surfaceOf(surface).decal`, so the table
 * in SurfaceDefs.js stays the single source of truth:
 *   concrete  cratered core, spalled lip, radiating micro-cracks, pale dust halo
 *   brick     the same, with the red body colour showing through the crater
 *   metal     bright torn lip, darkened entry, flaked paint, metalness ~0.85
 *   wood      splintered tear with raised fibres standing proud of the surface
 *   glass     spiderweb that *grows*: four stages, then it punches through
 *   plaster   chipped hole revealing the grey substrate underneath
 *   dirt/sand shallow crater, ejecta ring, scattered clods
 *   snow      soft crater with a bright rim
 *   fabric    frayed tear with lifted threads
 * Rotation, scale, atlas variant and a free UV mirror are randomised per hit through
 * `ctx.rng`, so no two holes are the same and overlapping hits merge instead of tiling.
 *
 * ── Budget ──────────────────────────────────────────────────────────────────────
 * `ctx.settings.get('decalBudget')` caps the *dynamic* decals. Over budget, the oldest
 * one starts a 0.6 s fade and its slot is recycled when the fade finishes — decals never
 * pop out. Static dressing has its own cap and is exempt from recycling.
 *
 * ── Public API (ctx.decals) ─────────────────────────────────────────────────────
 *   place(hit, type?, opts?)            -> id | 0   surface-aware impact decal
 *   placeStatic(opts)                   -> id | 0   load-time environment dressing
 *   scorch(point, normal, radius, opts) -> id | 0   explosion burn
 *   blood(point, normal, dir, opts)     -> id | 0   directional spatter (+ drips)
 *   footprint(point, normal, forward, opts) -> id | 0
 *   tyre(from, to, width, opts)         -> id[]     a run of tread marks
 *   remove(id) / clear(kind?)
 *   setBudget(n) / budget / count / capacity
 *   setEnabled(b) / stats() / cells() / debugSpray(n, opts)
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   bullet:impact, bullet:penetrate, explosion, entity:damage, entity:death,
 *   player:step, quality:changed, setting:changed, debug:pose, boot:done, level:ready
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   decals:ready   {budget, capacity, cells}
 *   decal:glassBreak {point, normal, body, entity}   a pane has taken all it can
 */
import * as THREE from 'three';
import { DecalAtlas, DecalDepth, DecalBatch, CELLS } from './DecalProjector.js';
import { surfaceDefFor } from '../materials/SurfaceDefs.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ═════════════════════════════════════════════════════════════ decal recipes ══ */

/**
 * Look of a decal, per §5 surface tag. `cells` are atlas entries; one is picked at
 * random per hit. Sizes are metres for a rifle-calibre round and are scaled by the
 * `decalScale` in SurfaceDefs plus a per-hit jitter.
 */
const SURFACE_LOOK = {
  concrete: {
    cells: ['hole_concrete_a', 'hole_concrete_b', 'hole_concrete_c'],
    normal: 1.0, metal: 0.0, ao: 0.85, rough: -1, tint: [1, 1, 1], depth: 0.85,
  },
  metal: {
    cells: ['hole_metal_a', 'hole_metal_b'],
    normal: 1.25, metal: 0.82, ao: 0.7, rough: -1, tint: [1, 1, 1], depth: 0.6,
  },
  wood: {
    cells: ['hole_wood_a', 'hole_wood_b'],
    normal: 1.15, metal: 0.0, ao: 0.95, rough: -1, tint: [1, 1, 1], depth: 0.8,
  },
  dirt: {
    cells: ['hole_dirt_a', 'hole_dirt_b'],
    normal: 0.85, metal: 0.0, ao: 0.9, rough: -1, tint: [1, 1, 1], depth: 0.75,
  },
  sand: {
    cells: ['hole_sand_a', 'hole_dirt_b'],
    normal: 0.7, metal: 0.0, ao: 0.8, rough: -1, tint: [1, 1, 1], depth: 0.75,
  },
  grass: {
    cells: ['hole_dirt_a', 'hole_dirt_b'],
    normal: 0.8, metal: 0.0, ao: 0.9, rough: -1, tint: [0.92, 0.96, 0.85], depth: 0.75,
  },
  glass: {
    cells: ['glass_0'],
    normal: 0.9, metal: 0.0, ao: 0.35, rough: -1, tint: [1, 1, 1], depth: 0.45,
  },
  fabric: {
    cells: ['hole_fabric_a'],
    normal: 0.9, metal: 0.0, ao: 0.9, rough: -1, tint: [1, 1, 1], depth: 0.6,
  },
  flesh: {
    cells: ['blood_drop_a'],
    normal: 0.6, metal: 0.0, ao: 0.5, rough: 0.24, tint: [1, 1, 1], depth: 0.6,
  },
  rubber: {
    cells: ['hole_rubber_a'],
    normal: 1.05, metal: 0.0, ao: 0.85, rough: -1, tint: [1, 1, 1], depth: 0.6,
  },
  plaster: {
    cells: ['hole_plaster_a', 'hole_plaster_b'],
    normal: 1.0, metal: 0.0, ao: 0.95, rough: -1, tint: [1, 1, 1], depth: 0.85,
  },
  ceramic: {
    cells: ['hole_tile_a'],
    normal: 1.15, metal: 0.0, ao: 0.8, rough: -1, tint: [1, 1, 1], depth: 0.6,
  },
  snow: {
    cells: ['hole_snow_a'],
    normal: 0.8, metal: 0.0, ao: 1.0, rough: -1, tint: [1, 1, 1], depth: 0.8,
  },
  foliage: null,
  water: null,
};

/** SurfaceDefs `decal` string -> atlas cells, for the entries that need a special look. */
const DECAL_ID_CELLS = {
  bullethole_concrete: ['hole_concrete_a', 'hole_concrete_b', 'hole_concrete_c'],
  bullethole_brick: ['hole_brick_a', 'hole_concrete_b'],
  bullethole_metal: ['hole_metal_a', 'hole_metal_b'],
  bullethole_wood: ['hole_wood_a', 'hole_wood_b'],
  bullethole_dirt: ['hole_dirt_a', 'hole_dirt_b'],
  bullethole_glass: ['glass_0'],
  bullethole_plaster: ['hole_plaster_a', 'hole_plaster_b'],
  bullethole_tile: ['hole_tile_a'],
  bullethole_snow: ['hole_snow_a'],
  bullethole_fabric: ['hole_fabric_a'],
  bullethole_rubber: ['hole_rubber_a'],
  blood_splat: ['blood_splat_a', 'blood_splat_b'],
};

const GLASS_STAGES = ['glass_0', 'glass_1', 'glass_2', 'glass_3'];

/** Static dressing archetypes for `placeStatic({ type })`. */
const STATIC_LOOK = {
  grime: { cells: ['grime_streak'], normal: 0.45, ao: 0.35, rough: 0.92, size: 2.2, opacity: 0.8 },
  contact: { cells: ['scorch_small'], normal: 0.25, ao: 0.25, rough: 0.96, size: 1.6, opacity: 0.62,
    tint: [0.62, 0.57, 0.5] },
  oil: { cells: ['oil_stain'], normal: 0.5, ao: 0.3, rough: -1, size: 1.6, opacity: 0.95 },
  poster: { cells: ['poster_a'], normal: 0.9, ao: 0.55, rough: -1, size: 0.9, opacity: 1.0 },
  graffiti: { cells: ['graffiti_a'], normal: 0.45, ao: 0.25, rough: -1, size: 1.7, opacity: 0.92 },
  stencil: { cells: ['stencil_arrow', 'stencil_hazard'], normal: 0.6, ao: 0.3, rough: -1, size: 0.7,
    opacity: 0.95 },
  rust: { cells: ['rust_a'], normal: 0.6, ao: 0.4, rough: -1, size: 0.9, opacity: 0.9 },
  crack: { cells: ['crack_a'], normal: 1.0, ao: 0.8, rough: -1, size: 1.4, opacity: 0.9 },
  scuff: { cells: ['scuff_a'], normal: 0.7, ao: 0.4, rough: -1, size: 0.6, opacity: 0.8 },
  scorch: { cells: ['scorch_large'], normal: 0.35, ao: 0.35, rough: 0.95, size: 2.4, opacity: 0.9 },
  tyre: { cells: ['tyre_mark'], normal: 0.35, ao: 0.3, rough: -1, size: 1.6, opacity: 0.85 },
  blood: { cells: ['blood_splat_a', 'blood_splat_b'], normal: 0.6, ao: 0.5, rough: 0.26, size: 1.0,
    opacity: 0.96 },
  footprint: { cells: ['foot_boot_a', 'foot_boot_b'], normal: 0.9, ao: 0.7, rough: -1, size: 0.32,
    opacity: 0.75 },
};

/* ════════════════════════════════════════════════════════════════════ system ══ */

/** @returns {import('../core/types.js').System} */
export default function createDecals(ctx) {
  /* ── state ──────────────────────────────────────────────────────────────── */
  const state = {
    ready: false,
    enabled: true,
    broken: false,
    budget: 192,
    staticCap: 420,
    contactCap: 90,
    contactCount: 0,
    capacity: 512,
    nextId: 1,
    matrixDirty: false,
    paramsDirty: false,
    dressed: false,
    visibleCount: 0,
    bloodThisFrame: 0,
    prepassScale: 0.75,
    dressing: true,
  };

  /** @type {Array<object>} draw order: index in the array == instance index. */
  const list = [];
  const byId = new Map();
  /** Static decals queued before init() finished (Props places contact patches early). */
  const pending = [];

  let atlas = null;
  let depth = null;
  let batch = null;

  const rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
  const rand = () => {
    const v = rng();
    return Number.isFinite(v) ? v : 0.5;
  };
  const range = (a, b) => a + rand() * (b - a);

  /* ── scratch ────────────────────────────────────────────────────────────── */
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _t = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _aux = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _fwd = new THREE.Vector3(0, 0, 1);
  const _frustum = new THREE.Frustum();
  const _vp = new THREE.Matrix4();
  const _sphere = new THREE.Sphere();
  const _size = new THREE.Vector2();
  const _rect = [0, 0, 0, 0];
  const _params = [1, 1, 0, 0];
  const _tint = [1, 1, 1, 1];
  const _params2 = [-1, 0, -1, 0];

  let warned = false;
  const warn = (msg, err) => {
    if (warned) return;
    warned = true;
    console.warn(`[decals] ${msg}`, err || '');
  };

  /* ── helpers ────────────────────────────────────────────────────────────── */

  function surfaceDef(x) {
    try {
      const d = ctx.materials?.surfaceOf?.(x);
      if (d) return d;
    } catch {
      /* fall through to the plain-data table */
    }
    try {
      return surfaceDefFor(x);
    } catch {
      return null;
    }
  }

  function cellRect(name, mirror) {
    const r = atlas?.rect(name);
    if (!r) return null;
    if (mirror) {
      _rect[0] = r[0] + r[2];
      _rect[1] = r[1];
      _rect[2] = -r[2];
      _rect[3] = r[3];
    } else {
      _rect[0] = r[0];
      _rect[1] = r[1];
      _rect[2] = r[2];
      _rect[3] = r[3];
    }
    return _rect;
  }

  /**
   * Build the projector transform: columns are (tangent*w, bitangent*h, normal*d) and
   * the translation sits on the receiving surface.
   */
  function orient(out, pos, normal, angle, w, h, d, alignUp) {
    _n.copy(normal);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();
    if (alignUp && Math.abs(_n.y) < 0.985) {
      // Blood runs and grime streaks need local +Y to point at the sky.
      _t.crossVectors(_up, _n).normalize();
      _b.crossVectors(_n, _t).normalize();
    } else {
      _v.set(0, 1, 0);
      if (Math.abs(_n.y) > 0.94) _v.set(0, 0, 1);
      _t.crossVectors(_v, _n).normalize();
      _b.crossVectors(_n, _t).normalize();
    }
    if (angle) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const tx = _t.x * c + _b.x * s;
      const ty = _t.y * c + _b.y * s;
      const tz = _t.z * c + _b.z * s;
      _b.set(_b.x * c - _t.x * s, _b.y * c - _t.y * s, _b.z * c - _t.z * s);
      _t.set(tx, ty, tz);
    }
    const e = out.elements;
    e[0] = _t.x * w; e[1] = _t.y * w; e[2] = _t.z * w; e[3] = 0;
    e[4] = _b.x * h; e[5] = _b.y * h; e[6] = _b.z * h; e[7] = 0;
    e[8] = _n.x * d; e[9] = _n.y * d; e[10] = _n.z * d; e[11] = 0;
    e[12] = pos.x; e[13] = pos.y; e[14] = pos.z; e[15] = 1;
    return out;
  }

  function writeInstance(i, d) {
    if (!batch) return;
    orient(_m, d.pos, d.normal, d.angle, d.w, d.h, d.depth, d.alignUp);
    const r = cellRect(d.cell, d.mirror);
    if (!r) return;
    _params[0] = d.opacity;
    _params[1] = d.normalStrength;
    _params[2] = d.metal;
    _params[3] = d.roughBias;
    _tint[0] = d.tint[0];
    _tint[1] = d.tint[1];
    _tint[2] = d.tint[2];
    _tint[3] = d.ao;
    _params2[0] = d.drip;
    _params2[1] = 0;
    _params2[2] = d.rough;
    _params2[3] = 0;
    batch.setInstance(i, _m, r, _params, _tint, _params2);
  }

  function rebuild() {
    if (!batch) return;
    const n = Math.min(list.length, batch.capacity);
    for (let i = 0; i < n; i++) {
      list[i].slot = i;
      writeInstance(i, list[i]);
    }
    if (list.length > n) list.length = n;
    state.matrixDirty = true;
  }

  /* ── record lifecycle ───────────────────────────────────────────────────── */

  function makeRecord(o) {
    return {
      id: state.nextId++,
      slot: -1,
      kind: o.kind || 'impact',
      cell: o.cell,
      pos: o.pos.clone(),
      normal: o.normal.clone(),
      angle: o.angle || 0,
      alignUp: !!o.alignUp,
      mirror: !!o.mirror,
      w: o.w,
      h: o.h,
      depth: o.depth,
      radius: Math.max(o.w, o.h) * 0.72,
      opacity: 0,
      target: o.opacity ?? 1,
      normalStrength: o.normalStrength ?? 1,
      metal: o.metal ?? 0,
      rough: o.rough ?? -1,
      roughBias: o.roughBias ?? 0,
      ao: o.ao ?? 0.8,
      tint: o.tint ? [o.tint[0], o.tint[1], o.tint[2]] : [1, 1, 1],
      fadeIn: o.fadeIn ?? 0.05,
      born: ctx.time?.elapsed ?? 0,
      life: o.life ?? Infinity,
      dying: false,
      deathT: 0,
      fadeOut: o.fadeOut ?? 0.6,
      isStatic: !!o.isStatic,
      drip: o.drip ?? -1,
      dripRate: o.dripRate ?? 0,
      glassStage: o.glassStage ?? -1,
      body: o.body || null,
    };
  }

  function push(rec) {
    if (!batch) return 0;
    if (list.length >= batch.capacity) {
      // Make room by killing the oldest recyclable decal outright.
      const idx = list.findIndex((d) => !d.isStatic);
      if (idx < 0) return 0;
      byId.delete(list[idx].id);
      list.splice(idx, 1);
      rebuild();
    }
    rec.slot = list.length;
    list.push(rec);
    byId.set(rec.id, rec);
    writeInstance(rec.slot, rec);
    state.matrixDirty = true;
    enforceBudget();
    return rec.id;
  }

  function enforceBudget() {
    let dynamic = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].isStatic && !list[i].dying) dynamic++;
    let over = dynamic - state.budget;
    if (over <= 0) return;
    for (let i = 0; i < list.length && over > 0; i++) {
      const d = list[i];
      if (d.isStatic || d.dying) continue;
      d.dying = true;
      d.deathT = 0;
      over--;
    }
    state.paramsDirty = true;
  }

  function removeById(id) {
    const d = byId.get(id);
    if (!d) return false;
    const i = list.indexOf(d);
    if (i >= 0) list.splice(i, 1);
    byId.delete(id);
    rebuild();
    return true;
  }

  /* ── placement primitives ───────────────────────────────────────────────── */

  function pickCell(cells) {
    if (!cells || !cells.length) return null;
    return cells[Math.min(cells.length - 1, Math.floor(rand() * cells.length))];
  }

  function toVec3(v, out) {
    if (!v) return null;
    if (v.isVector3) return out.copy(v);
    if (Array.isArray(v)) return out.set(v[0] || 0, v[1] || 0, v[2] || 0);
    if (typeof v.x === 'number') return out.set(v.x, v.y || 0, v.z || 0);
    return null;
  }

  /* ── glass ──────────────────────────────────────────────────────────────── */

  /** A second hit near an existing crack grows the web instead of stacking a new one. */
  function growGlass(point, opts) {
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      if (d.glassStage < 0 || d.dying) continue;
      if (d.pos.distanceToSquared(point) > d.radius * d.radius * 1.5) continue;
      if (d.glassStage >= GLASS_STAGES.length - 1) {
        try {
          ctx.bus?.emit?.('decal:glassBreak', {
            point: d.pos.clone(),
            normal: d.normal.clone(),
            body: d.body || opts?.body || null,
            entity: opts?.entity || null,
          });
        } catch {
          /* listeners are optional */
        }
        return d.id;
      }
      d.glassStage++;
      d.cell = GLASS_STAGES[d.glassStage];
      d.w *= 1.22;
      d.h *= 1.22;
      d.radius = Math.max(d.w, d.h) * 0.72;
      d.ao = Math.min(0.75, d.ao + 0.08);
      writeInstance(d.slot, d);
      state.matrixDirty = true;
      return d.id;
    }
    return 0;
  }

  /* ── public: place ──────────────────────────────────────────────────────── */

  /**
   * @param {object} hit  physics Hit or a `bullet:impact` payload:
   *                      { point, normal, surface|material, dir?, energy?, body? }
   * @param {string} [type] 'bullet' (default) | 'blood' | 'scorch' | any STATIC_LOOK key
   */
  function place(hit, type, opts) {
    if (!state.ready || !state.enabled || state.broken || !hit) return 0;
    const point = toVec3(hit.point || hit.position || hit, _p);
    if (!point) return 0;
    const normal = toVec3(hit.normal, _n.clone()) || _fwd.clone();
    const o = opts || {};

    if (type && type !== 'bullet' && type !== 'impact') {
      if (type === 'blood') return blood(point, normal, hit.dir, o);
      if (type === 'scorch') return scorch(point, normal, o.radius ?? 1.6, o);
      return placeStatic({
        position: point,
        normal,
        type,
        size: o.size,
        rotation: o.rotation,
        opacity: o.opacity,
        tint: o.tint,
        aspect: o.aspect,
        dynamic: true,
        life: o.life,
      });
    }

    const def = surfaceDef(hit.material || hit.surface || o.surface);
    if (!def) return 0;
    if (def.decal === 'none') return 0;
    const tag = def.surface;
    const look = SURFACE_LOOK[tag];
    if (look === null) return 0;

    // Flesh: the hole itself is a spatter, and the round throws blood at what is behind.
    if (tag === 'flesh') {
      const id = blood(point, normal, hit.dir, { small: true, ...o });
      sprayBehind(hit, o);
      return id;
    }

    let cells = DECAL_ID_CELLS[def.decal] || look?.cells;
    if (!cells) cells = SURFACE_LOOK.concrete.cells;

    if (tag === 'glass') {
      const grown = growGlass(point, hit);
      if (grown) return grown;
      cells = [GLASS_STAGES[0]];
    }

    const energy = Number.isFinite(hit.energy) ? hit.energy : 2200;
    const cal = clamp(Math.pow(clamp(energy / 2400, 0.28, 3.2), 0.34), 0.62, 1.5);
    const base = (o.size ?? def.decalScale ?? 0.09) * cal * range(0.84, 1.22);
    const w = base;
    const h = base * range(0.94, 1.07);
    const dep = Math.max(0.035, base * (look?.depth ?? 0.8));

    const rec = makeRecord({
      kind: 'impact',
      cell: pickCell(cells),
      pos: point,
      normal,
      angle: rand() * TAU,
      mirror: rand() < 0.5,
      w,
      h,
      depth: dep,
      opacity: clamp01(o.opacity ?? 1),
      normalStrength: (look?.normal ?? 1) * (o.normalStrength ?? 1),
      metal: look?.metal ?? 0,
      rough: look?.rough ?? -1,
      roughBias: (o.roughBias ?? 0) + range(-0.04, 0.04),
      ao: look?.ao ?? 0.85,
      tint: o.tint || look?.tint,
      fadeIn: 0.04,
      life: o.life ?? Infinity,
      glassStage: tag === 'glass' ? 0 : -1,
      body: hit.body || null,
    });
    return push(rec);
  }

  /** Blood thrown past a body onto whatever is behind it. */
  function sprayBehind(hit, o) {
    if (state.bloodThisFrame > 2) return;
    const dir = toVec3(hit.dir, _v);
    const phys = ctx.physics;
    if (!dir || !phys?.raycast) return;
    try {
      const from = _p.copy(hit.point).addScaledVector(dir, 0.12);
      const h = phys.raycast(from, dir, 3.2, 1 | 8);
      if (!h || !h.point) return;
      state.bloodThisFrame++;
      blood(h.point, h.normal, dir, { size: range(0.5, 0.95), ...o });
    } catch {
      /* a missing or throwing raycast just means no spray */
    }
  }

  /* ── public: blood ──────────────────────────────────────────────────────── */

  function blood(point, normal, dir, opts) {
    if (!state.ready || !state.enabled || state.broken) return 0;
    const p = toVec3(point, _p);
    if (!p) return 0;
    const nrm = toVec3(normal, _n.clone()) || _up.clone();
    const o = opts || {};
    const small = !!o.small;
    const cells = small ? ['blood_drop_a'] : STATIC_LOOK.blood.cells;
    const size = o.size ?? (small ? range(0.16, 0.3) : range(0.55, 1.15));

    // Directional spatter: the local +X axis follows the impact vector projected onto
    // the receiving surface, and the splat is stretched along it.
    let angle = rand() * TAU;
    let stretch = 1;
    const d = toVec3(dir, _d);
    const upFacing = nrm.y > 0.72;
    if (d && d.lengthSq() > 1e-6) {
      d.normalize().addScaledVector(nrm, -d.dot(nrm));
      if (d.lengthSq() > 1e-4) {
        d.normalize();
        // angle of d in the (tangent, bitangent) frame built by orient()
        _aux.set(0, 1, 0);
        if (Math.abs(nrm.y) > 0.94) _aux.set(0, 0, 1);
        _t.crossVectors(_aux, nrm).normalize();
        _b.crossVectors(nrm, _t).normalize();
        angle = Math.atan2(d.dot(_b), d.dot(_t));
        stretch = small ? 1.15 : range(1.25, 1.7);
      }
    }

    const rec = makeRecord({
      kind: 'blood',
      cell: pickCell(cells),
      pos: p,
      normal: nrm,
      angle: upFacing ? rand() * TAU : angle,
      alignUp: !upFacing && !small,
      mirror: rand() < 0.5,
      w: size * (small ? 1 : stretch),
      h: size,
      depth: Math.max(0.05, size * 0.5),
      opacity: clamp01(o.opacity ?? 0.96),
      normalStrength: 0.6,
      metal: 0,
      rough: 0.22,
      roughBias: 0,
      ao: 0.5,
      tint: o.tint,
      fadeIn: 0.12,
      life: o.life ?? Infinity,
      // Runs only make sense on something close to vertical.
      drip: small || upFacing ? 0 : 0.02,
      dripRate: small || upFacing ? 0 : 1 / range(6, 15),
    });
    // A wall splat is anchored so the pool sits above the runs.
    if (!upFacing && !small) {
      rec.pos.addScaledVector(_up, -size * 0.08);
      rec.angle = 0;
      rec.h = size * range(1.5, 2.2);
      rec.w = size * stretch;
    }
    return push(rec);
  }

  /* ── public: scorch ─────────────────────────────────────────────────────── */

  function scorch(point, normal, radius, opts) {
    if (!state.ready || !state.enabled || state.broken) return 0;
    const p = toVec3(point, _p);
    if (!p) return 0;
    const nrm = toVec3(normal, _n.clone()) || _up.clone();
    const o = opts || {};
    const r = clamp(radius ?? 1.8, 0.25, 9);
    const rec = makeRecord({
      kind: 'scorch',
      cell: r > 0.75 ? 'scorch_large' : 'scorch_small',
      pos: p,
      normal: nrm,
      angle: rand() * TAU,
      mirror: rand() < 0.5,
      w: r * 2 * range(0.9, 1.12),
      h: r * 2 * range(0.9, 1.12),
      depth: Math.max(0.16, r * 0.55),
      opacity: clamp01(o.opacity ?? range(0.72, 0.95)),
      normalStrength: 0.3,
      metal: 0,
      rough: 0.94,
      roughBias: 0,
      ao: 0.3,
      tint: o.tint,
      fadeIn: 0.18,
      life: o.life ?? Infinity,
    });
    return push(rec);
  }

  /* ── public: footprints & tyre marks ────────────────────────────────────── */

  function footprint(point, normal, forward, opts) {
    if (!state.ready || !state.enabled || state.broken) return 0;
    const p = toVec3(point, _p);
    if (!p) return 0;
    const nrm = toVec3(normal, _n.clone()) || _up.clone();
    const o = opts || {};
    const look = STATIC_LOOK.footprint;
    const size = o.size ?? 0.30;
    let angle = o.rotation ?? 0;
    const f = toVec3(forward, _d);
    if (f && f.lengthSq() > 1e-6) {
      f.normalize().addScaledVector(nrm, -f.dot(nrm));
      if (f.lengthSq() > 1e-4) {
        f.normalize();
        _aux.set(0, 1, 0);
        if (Math.abs(nrm.y) > 0.94) _aux.set(0, 0, 1);
        _t.crossVectors(_aux, nrm).normalize();
        _b.crossVectors(nrm, _t).normalize();
        // the boot points "up" in decal space
        angle = Math.atan2(f.dot(_b), f.dot(_t)) - Math.PI * 0.5;
      }
    }
    const rec = makeRecord({
      kind: 'footprint',
      cell: o.cell || (o.right ? 'foot_boot_b' : 'foot_boot_a'),
      pos: p,
      normal: nrm,
      angle,
      w: size * 0.62,
      h: size,
      depth: Math.max(0.05, size * 0.55),
      opacity: clamp01(o.opacity ?? look.opacity),
      normalStrength: look.normal,
      metal: 0,
      rough: o.rough ?? -1,
      roughBias: 0.04,
      ao: look.ao,
      tint: o.tint,
      fadeIn: 0.06,
      life: o.life ?? 26,
      fadeOut: 5,
    });
    return push(rec);
  }

  function tyre(from, to, width, opts) {
    if (!state.ready || !state.enabled || state.broken) return [];
    const a = toVec3(from, new THREE.Vector3());
    const b = toVec3(to, new THREE.Vector3());
    if (!a || !b) return [];
    const o = opts || {};
    const w = width ?? 0.24;
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-3) return [];
    dir.multiplyScalar(1 / len);
    const seg = Math.max(0.8, o.segment ?? w * 5);
    const n = Math.min(48, Math.max(1, Math.ceil(len / seg)));
    const nrm = toVec3(o.normal, new THREE.Vector3()) || _up.clone();
    const ids = [];
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * len;
      const t1 = ((i + 1) / n) * len;
      const mid = a.clone().addScaledVector(dir, (t0 + t1) * 0.5);
      _d.copy(dir).addScaledVector(nrm, -dir.dot(nrm));
      let angle = 0;
      if (_d.lengthSq() > 1e-5) {
        _d.normalize();
        _aux.set(0, 1, 0);
        if (Math.abs(nrm.y) > 0.94) _aux.set(0, 0, 1);
        _t.crossVectors(_aux, nrm).normalize();
        _b.crossVectors(nrm, _t).normalize();
        angle = Math.atan2(_d.dot(_b), _d.dot(_t)) - Math.PI * 0.5;
      }
      const rec = makeRecord({
        kind: 'tyre',
        cell: 'tyre_mark',
        pos: mid,
        normal: nrm,
        angle,
        mirror: rand() < 0.5,
        w,
        h: t1 - t0,
        depth: Math.max(0.05, w * 0.6),
        opacity: clamp01((o.opacity ?? 0.85) * range(0.8, 1)),
        normalStrength: 0.35,
        metal: 0,
        rough: -1,
        roughBias: 0,
        ao: 0.3,
        tint: o.tint,
        fadeIn: 0.05,
        life: o.life ?? Infinity,
        isStatic: !!o.isStatic,
      });
      const id = push(rec);
      if (id) ids.push(id);
    }
    return ids;
  }

  /* ── public: static dressing ────────────────────────────────────────────── */

  /**
   * @param {object} opts { position, normal, type, size, aspect, rotation, opacity,
   *                        tint, surface, cell, dynamic, life }
   * @returns {number} decal id, or 0 if it was refused (the caller should fall back)
   */
  function placeStatic(opts) {
    const o = opts || {};
    if (!state.enabled || state.broken) return 0;
    if (!state.ready) {
      // Props and Level dress the map inside their own init(), which runs before ours.
      if (pending.length >= state.contactCap) return 0;
      pending.push({ ...o });
      return -1; // truthy: the caller may skip its own fallback
    }
    const p = toVec3(o.position || o.point, new THREE.Vector3());
    if (!p) return 0;
    const nrm = toVec3(o.normal, new THREE.Vector3()) || _up.clone();
    nrm.normalize();

    let type = o.type || 'grime';
    // A "grime" patch on the floor is a contact/dirt ring, not a run-down streak.
    if (type === 'grime' && nrm.y > 0.6) type = 'contact';
    const look = STATIC_LOOK[type] || STATIC_LOOK.grime;

    const isStatic = o.dynamic ? false : true;
    if (isStatic) {
      // Prop contact patches arrive in bulk. Past a point Props' own merged patch mesh
      // is the better deal — one draw call for the whole map — so hand them back.
      if (type === 'contact' && ++state.contactCount > state.contactCap) return 0;
      let statics = 0;
      for (let i = 0; i < list.length; i++) if (list[i].isStatic) statics++;
      if (statics >= state.staticCap) return 0;
    }

    const size = o.size ?? look.size;
    const aspect = o.aspect ?? 1;
    const alignUp = nrm.y < 0.6 && (type === 'grime' || type === 'rust' || type === 'poster' ||
      type === 'stencil' || type === 'blood');
    const rec = makeRecord({
      kind: 'static',
      cell: o.cell || pickCell(look.cells),
      pos: p,
      normal: nrm,
      angle: alignUp ? (o.rotation ?? 0) : (o.rotation ?? rand() * TAU),
      alignUp,
      mirror: o.mirror ?? rand() < 0.5,
      w: size * aspect,
      h: size,
      depth: Math.max(0.05, size * 0.35),
      opacity: clamp01(o.opacity ?? look.opacity),
      normalStrength: o.normalStrength ?? look.normal,
      metal: o.metal ?? 0,
      rough: o.rough ?? look.rough ?? -1,
      roughBias: o.roughBias ?? 0,
      ao: o.ao ?? look.ao,
      tint: o.tint || look.tint,
      fadeIn: isStatic ? 0.001 : 0.15,
      life: o.life ?? Infinity,
      isStatic,
      drip: type === 'blood' && nrm.y < 0.6 ? 1 : -1,
    });
    return push(rec);
  }

  function flushPending() {
    if (!pending.length) return;
    const queued = pending.splice(0, pending.length);
    for (const o of queued) {
      try {
        placeStatic(o);
      } catch (err) {
        warn('queued placeStatic failed', err);
      }
    }
  }

  /* ── automatic map dressing ─────────────────────────────────────────────── */

  /**
   * Nothing in a lived-in map is clean. If the level and props modules have not dressed
   * the walls themselves, lay down a restrained pass of weathering plus some old battle
   * damage: it is the difference between "a level" and "a place things happened in".
   */
  function dressMap() {
    if (state.dressed || !state.ready || !state.dressing) return;
    state.dressed = true;
    const phys = ctx.physics;
    if (!phys?.raycast) return;

    const anchors = [];
    const lv = ctx.level;
    for (const s of lv?.pointsOfInterest || []) if (s?.pos) anchors.push(s.pos);
    for (const s of lv?.spawnPoints || []) if (s?.pos) anchors.push(s.pos);
    if (!anchors.length) anchors.push(new THREE.Vector3(0, 1.6, 0));

    const dir = new THREE.Vector3();
    const org = new THREE.Vector3();
    let walls = 0;
    let grounds = 0;
    let damage = 0;

    const shoot = (from, d, maxDist) => {
      try {
        return phys.raycast(from, d, maxDist, 1 | 8);
      } catch {
        return null;
      }
    };

    for (let i = 0; i < 320; i++) {
      const a = anchors[Math.floor(rand() * anchors.length) % anchors.length];
      org.set(a.x + range(-7, 7), (a.y || 1.6) + range(-0.4, 1.9), a.z + range(-7, 7));
      const th = rand() * TAU;
      dir.set(Math.cos(th), range(-0.22, 0.12), Math.sin(th)).normalize();
      const hit = shoot(org, dir, 9);
      if (!hit || !hit.point || !hit.normal) continue;
      const def = surfaceDef(hit.material || hit.surface);
      const tag = def?.surface || 'concrete';
      if (tag === 'water' || tag === 'foliage' || tag === 'glass') continue;
      const nUp = Math.abs(hit.normal.y ?? 0);

      if (nUp < 0.45 && walls < 34) {
        // A vertical face: weathering, then the occasional tag or stencil.
        const roll = rand();
        let type = 'grime';
        let size = range(1.1, 2.6);
        if (tag === 'metal' && roll < 0.4) {
          type = 'rust';
          size = range(0.5, 1.1);
        } else if (roll > 0.9) {
          type = 'graffiti';
          size = range(1.1, 2.0);
        } else if (roll > 0.84) {
          type = 'poster';
          size = range(0.55, 0.95);
        } else if (roll > 0.74) {
          type = 'crack';
          size = range(0.9, 1.9);
        } else if (roll > 0.66) {
          type = 'scuff';
          size = range(0.4, 0.8);
        }
        const p = hit.point.clone().addScaledVector(hit.normal, 0.004);
        if (type === 'grime' || type === 'rust') p.y += range(0.2, 1.2);
        if (placeStatic({ position: p, normal: hit.normal, type, size, opacity: range(0.45, 0.9) })) {
          walls++;
        }
      } else if (nUp > 0.7 && grounds < 14) {
        const roll = rand();
        const type = roll < 0.42 ? 'oil' : roll < 0.72 ? 'contact' : 'scuff';
        if (
          placeStatic({
            position: hit.point.clone(),
            normal: hit.normal,
            type,
            size: range(0.7, 2.1),
            opacity: range(0.4, 0.85),
          })
        ) {
          grounds++;
        }
      }
    }

    // Old battle damage: a handful of tight bursts against walls, as if someone had
    // been pinned behind them. This is the detail the camera lingers on.
    for (let i = 0; i < 220 && damage < 46; i++) {
      const a = anchors[Math.floor(rand() * anchors.length) % anchors.length];
      org.set(a.x + range(-6, 6), (a.y || 1.6) + range(0.1, 1.4), a.z + range(-6, 6));
      const th = rand() * TAU;
      dir.set(Math.cos(th), range(-0.12, 0.1), Math.sin(th)).normalize();
      const hit = shoot(org, dir, 10);
      if (!hit || !hit.point || !hit.normal) continue;
      if (Math.abs(hit.normal.y ?? 0) > 0.5) continue;
      const def = surfaceDef(hit.material || hit.surface);
      if (!def || def.decal === 'none' || def.surface === 'glass' || def.surface === 'foliage') continue;
      // a burst of 3-6 rounds walking across the face
      const spread = range(0.18, 0.55);
      const n = 3 + Math.floor(rand() * 4);
      const across = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
      for (let k = 0; k < n && damage < 46; k++) {
        const q = hit.point
          .clone()
          .addScaledVector(across, range(-spread, spread))
          .addScaledVector(_up, range(-spread * 0.6, spread * 0.6))
          .addScaledVector(hit.normal, 0.002);
        if (
          place(
            { point: q, normal: hit.normal, material: def.material, surface: def.surface, energy: 2100 },
            'bullet',
            { opacity: range(0.7, 1.0) }
          )
        ) {
          damage++;
        }
      }
    }
    // Battle damage placed at load is scenery, not something to recycle on the next shot.
    for (const d of list) if (d.kind === 'impact') d.isStatic = true;
    state.staticCap = Math.max(state.staticCap, list.length + 24);
  }

  /* ── per-frame ──────────────────────────────────────────────────────────── */

  function animate(dt) {
    const now = ctx.time?.elapsed ?? 0;
    let removed = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      let dirty = false;

      if (!d.dying && d.life !== Infinity && now - d.born > d.life) {
        d.dying = true;
        d.deathT = 0;
      }

      if (d.dying) {
        d.deathT += dt;
        const k = clamp01(1 - d.deathT / Math.max(0.05, d.fadeOut));
        d.opacity = d.target * k * k;
        dirty = true;
        if (k <= 0.001) {
          byId.delete(d.id);
          list.splice(i, 1);
          removed = true;
          continue;
        }
      } else if (d.opacity < d.target) {
        d.opacity = Math.min(d.target, d.opacity + dt / Math.max(0.001, d.fadeIn));
        dirty = true;
      }

      if (d.dripRate > 0 && d.drip >= 0 && d.drip < 1) {
        // Runs accelerate as the bead gathers mass, then stall.
        d.drip = Math.min(1, d.drip + dt * d.dripRate * (0.35 + d.drip * 1.4));
        dirty = true;
      }

      if (dirty && d.slot >= 0 && batch) {
        batch.setOpacity(d.slot, d.opacity);
        batch.setDrip(d.slot, d.drip);
        state.paramsDirty = true;
      }
    }
    if (removed) rebuild();
  }

  function updateVisibility() {
    const cam = ctx.camera;
    if (!cam || !batch) return 0;
    cam.updateMatrixWorld();
    _vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_vp);
    const camPos = _v.setFromMatrixPosition(cam.matrixWorld);
    const maxDist = batch.uniforms.uDecalFade.value.y + 6;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.opacity <= 0.002) continue;
      if (d.pos.distanceTo(camPos) > maxDist + d.radius) continue;
      _sphere.center.copy(d.pos);
      _sphere.radius = d.radius + d.depth * 0.5;
      if (_frustum.intersectsSphere(_sphere)) n++;
    }
    return n;
  }

  /* ── init ───────────────────────────────────────────────────────────────── */

  function atlasRes() {
    const tex = ctx.settings?.get?.('textureResolution') ?? 1024;
    if (ctx.settings?.get?.('headless')) return tex >= 2048 ? 1024 : 512;
    return tex >= 2048 ? 2048 : tex >= 1024 ? 1024 : 512;
  }

  function prepassScale() {
    if (ctx.settings?.get?.('headless')) return 0.5;
    const tier = ctx.settings?.tier || 'high';
    if (tier === 'ultra') return 1.0;
    if (tier === 'high') return 0.75;
    return 0.5;
  }

  function applyQuality() {
    state.budget = Math.max(16, ctx.settings?.get?.('decalBudget') ?? 192);
    const par = ctx.settings?.get?.('parallax');
    if (batch) {
      batch.uniforms.uDecalGlobal.value.z = par === false ? 0 : 0.022;
      const tier = ctx.settings?.tier || 'high';
      const near = tier === 'low' ? 32 : tier === 'medium' ? 44 : 58;
      batch.uniforms.uDecalFade.value.set(near, near * 1.4);
    }
    state.prepassScale = prepassScale();
    if (depth) {
      const s = sizeNow();
      depth.setSize(s.x, s.y, state.prepassScale);
    }
    enforceBudget();
  }

  function sizeNow() {
    const impl = ctx.pipeline?._impl;
    if (impl?.width > 1 && impl?.height > 1) return _size.set(impl.width, impl.height);
    try {
      ctx.renderer.getDrawingBufferSize(_size);
    } catch {
      _size.set(1280, 720);
    }
    if (_size.x < 2 || _size.y < 2) _size.set(1280, 720);
    return _size;
  }

  /* ── the published API ──────────────────────────────────────────────────── */

  const api = {
    ready: false,
    place,
    placeStatic,
    scorch,
    blood,
    footprint,
    tyre,
    remove: removeById,
    clear(kind) {
      if (!kind) {
        list.length = 0;
        byId.clear();
      } else {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].kind === kind) {
            byId.delete(list[i].id);
            list.splice(i, 1);
          }
        }
      }
      rebuild();
      if (batch) batch.flush(list.length, true, true);
    },
    setBudget(n) {
      state.budget = Math.max(8, n | 0);
      enforceBudget();
    },
    setEnabled(b) {
      state.enabled = !!b;
      if (batch) batch.mesh.visible = !!b && list.length > 0;
    },
    get budget() {
      return state.budget;
    },
    get count() {
      return list.length;
    },
    get capacity() {
      return batch?.capacity ?? 0;
    },
    cells: () => CELLS.map((c) => c.name),
    stats: () => ({
      ready: state.ready,
      count: list.length,
      statics: list.reduce((a, d) => a + (d.isStatic ? 1 : 0), 0),
      dying: list.reduce((a, d) => a + (d.dying ? 1 : 0), 0),
      visible: state.visibleCount,
      budget: state.budget,
      capacity: batch?.capacity ?? 0,
      atlasRes: atlas?.res ?? 0,
      prepass: state.prepassScale,
      drawCalls: state.visibleCount > 0 ? 1 : 0,
    }),
    /** Spray test decals on whatever is in front of the camera (harness / debug). */
    debugSpray(n, opts) {
      const cam = ctx.camera;
      const phys = ctx.physics;
      if (!cam || !phys?.raycast) return 0;
      const o = opts || {};
      const count = clamp(n | 0 || 24, 1, 160);
      const org = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const dir = new THREE.Vector3();
      let placed = 0;
      const spread = o.spread ?? 0.22;
      for (let i = 0; i < count; i++) {
        dir
          .copy(fwd)
          .addScaledVector(right, range(-spread, spread))
          .addScaledVector(up, range(-spread, spread))
          .normalize();
        let hit = null;
        try {
          hit = phys.raycast(org, dir, o.range ?? 40, 1 | 8);
        } catch {
          hit = null;
        }
        if (!hit || !hit.point) continue;
        const def = surfaceDef(hit.material || hit.surface);
        if (place({ ...hit, material: def?.material, surface: def?.surface, dir, energy: 2400 })) {
          placed++;
        }
      }
      return placed;
    },
  };
  // Published from the factory: Props and Level dress the map from *their* init(), which
  // runs before ours, and `placeStatic` queues anything that arrives early.
  ctx.decals = api;

  /* ── system ─────────────────────────────────────────────────────────────── */
  const unsub = [];
  const on = (evt, fn) => {
    const off = ctx.bus?.on?.(evt, (payload) => {
      try {
        fn(payload);
      } catch (err) {
        warn(`handler for ${evt} threw`, err);
      }
    });
    if (off) unsub.push(off);
  };

  return {
    name: 'decals',
    // Deliberately after the camera rig (62): the depth prepass has to be rendered from
    // the *final* camera or the reconstruction slides by the rig's sway and recoil.
    order: 64,

    async init() {
      if (!ctx.renderer || !ctx.scene) {
        state.broken = true;
        return;
      }
      try {
        atlas = new DecalAtlas(ctx);
        const built = atlas.build(atlasRes());
        if (!built) {
          state.broken = true;
          warn('atlas unavailable, decals disabled');
          return;
        }
        state.budget = Math.max(16, ctx.settings?.get?.('decalBudget') ?? 192);
        state.capacity = clamp(state.budget * 2 + 384, 256, 1280) | 0;
        depth = new DecalDepth(ctx);
        state.prepassScale = prepassScale();
        const s = sizeNow();
        depth.setSize(s.x, s.y, state.prepassScale);
        batch = new DecalBatch(ctx, atlas, depth, state.capacity);
        batch.mesh.visible = false;
        ctx.scene.add(batch.mesh);
        applyQuality();
        state.ready = true;
        api.ready = true;
        flushPending();
        ctx.bus?.emit?.('decals:ready', {
          budget: state.budget,
          capacity: state.capacity,
          cells: CELLS.length,
        });
      } catch (err) {
        state.broken = true;
        state.ready = false;
        api.ready = false;
        console.warn('[decals] init failed, decals disabled:', err);
        return;
      }

      /* ── event wiring ─────────────────────────────────────────────────── */
      on('bullet:impact', (e) => {
        if (!e?.point) return;
        place(e, 'bullet');
      });
      on('bullet:penetrate', (e) => {
        if (!e?.exitPoint) return;
        const def = surfaceDef(e.material || e.surface);
        if (!def || def.decal === 'none') return;
        place(
          {
            point: e.exitPoint,
            normal: e.exitNormal || e.normal,
            material: def.material,
            surface: def.surface,
            energy: e.energy,
            dir: e.dir,
          },
          'bullet',
          { size: (def.decalScale || 0.09) * 1.35, opacity: 0.95 }
        );
      });
      on('explosion', (e) => {
        if (!e?.point) return;
        const phys = ctx.physics;
        const r = clamp((e.radius ?? 4) * 0.42, 0.6, 5.5);
        const p = toVec3(e.point, new THREE.Vector3());
        if (!p) return;
        // Burn the ground under the blast, plus whatever the fireball touched.
        let placed = false;
        if (phys?.raycast) {
          try {
            const h = phys.raycast(p, new THREE.Vector3(0, -1, 0), (e.radius ?? 4) * 0.9, 1 | 8);
            if (h?.point) {
              scorch(h.point, h.normal || _up, r);
              placed = true;
            }
          } catch {
            /* no ground under the blast */
          }
          const dir = new THREE.Vector3();
          for (let i = 0; i < 5; i++) {
            const th = rand() * TAU;
            dir.set(Math.cos(th), range(-0.25, 0.3), Math.sin(th)).normalize();
            try {
              const h = phys.raycast(p, dir, (e.radius ?? 4) * 0.85, 1 | 8);
              if (h?.point) {
                const def = surfaceDef(h.material || h.surface);
                if (def?.scorches !== false) {
                  scorch(h.point, h.normal, r * range(0.4, 0.8), { opacity: range(0.4, 0.8) });
                  placed = true;
                }
              }
            } catch {
              /* best effort */
            }
          }
        }
        if (!placed) scorch(p, _up, r);
      });
      on('entity:damage', (e) => {
        if (!e?.point || !e.dir) return;
        if ((e.amount ?? 0) < 4) return;
        if (state.bloodThisFrame > 2) return;
        state.bloodThisFrame++;
        sprayBehind({ point: e.point, dir: e.dir }, {});
      });
      on('entity:death', (e) => {
        if (!e?.point && !e?.target?.position) return;
        const p = toVec3(e.point || e.target?.position, new THREE.Vector3());
        const phys = ctx.physics;
        if (!p || !phys?.raycast) return;
        try {
          const h = phys.raycast(p, new THREE.Vector3(0, -1, 0), 2.4, 1 | 8);
          if (h?.point) blood(h.point, h.normal || _up, null, { size: range(0.8, 1.4) });
        } catch {
          /* best effort */
        }
      });
      on('player:step', (e) => {
        const def = surfaceDef(e?.surface);
        if (!def || (def.softness ?? 0) < 0.3) return;
        const p = ctx.player?.position;
        const phys = ctx.physics;
        if (!p || !phys?.raycast) return;
        try {
          const h = phys.raycast(
            new THREE.Vector3(p.x, p.y + 0.4, p.z),
            new THREE.Vector3(0, -1, 0),
            2.2,
            1 | 8
          );
          if (!h?.point) return;
          const vel = ctx.player?.velocity;
          const f = vel && vel.lengthSq?.() > 0.04 ? vel : null;
          state._footRight = !state._footRight;
          const side = state._footRight ? 1 : -1;
          const off = new THREE.Vector3(0, 0, 0);
          if (f) {
            off.set(-f.z, 0, f.x).normalize().multiplyScalar(0.11 * side);
          }
          footprint(h.point.clone().add(off), h.normal || _up, f, {
            right: state._footRight,
            opacity: clamp01(0.35 + (def.softness ?? 0.4) * 0.6),
            life: 20 + rand() * 14,
          });
        } catch {
          /* best effort */
        }
      });
      on('quality:changed', () => {
        try {
          if (atlas?.build(atlasRes())) batch?.refreshAtlas();
        } catch (err) {
          warn('atlas rebuild failed', err);
        }
        applyQuality();
      });
      on('setting:changed', ({ key }) => {
        if (key === 'decalBudget') {
          state.budget = Math.max(8, ctx.settings?.get?.('decalBudget') ?? 192);
          enforceBudget();
        } else if (key === 'renderScale' || key === 'parallax') {
          applyQuality();
        }
      });
      on('debug:pose', (s) => {
        const req = s?.decals;
        if (req === 'clear') {
          api.clear();
          return;
        }
        if (req === undefined || req === false) return;
        const n = typeof req === 'number' ? req : 30;
        api.debugSpray(n, typeof req === 'object' ? req : undefined);
      });
      on('boot:done', () => {
        try {
          dressMap();
        } catch (err) {
          warn('map dressing failed', err);
        }
      });
    },

    update(dt) {
      if (!state.ready || state.broken) return;
      state.bloodThisFrame = 0;
      flushPending();
      animate(clamp(dt || 0, 0, 0.25));
    },

    lateUpdate() {
      if (!state.ready || state.broken || !batch) return;
      if (!state.dressed && (ctx.time?.frame ?? 0) > 2) {
        try {
          dressMap();
        } catch (err) {
          warn('map dressing failed', err);
        }
      }

      if (!state.enabled || list.length === 0) {
        batch.mesh.visible = false;
        state.visibleCount = 0;
        return;
      }

      state.visibleCount = updateVisibility();
      if (state.visibleCount === 0) {
        // Nothing on screen: skip the depth prepass entirely. This is the common case
        // for most of the map and keeps the extra geometry pass off the frame budget.
        batch.mesh.visible = false;
        return;
      }

      const s = sizeNow();
      depth.setSize(s.x, s.y, state.prepassScale);

      batch.mesh.visible = false; // never let the decals occlude themselves
      const tex = depth.render(ctx.scene, ctx.camera);
      batch.mesh.visible = true;
      if (!tex) {
        batch.mesh.visible = false;
        return;
      }

      const u = batch.uniforms;
      u.uDecalDepth.value = tex;
      u.uDecalInvProj.value.copy(depth.invProjection);
      u.uDecalScreen.value.set(1 / s.x, 1 / s.y);
      u.uDecalTexel.value.set(1 / depth.width, 1 / depth.height);

      batch.flush(list.length, state.matrixDirty, state.paramsDirty);
      state.matrixDirty = false;
      state.paramsDirty = false;
    },

    resize(w, h) {
      if (!state.ready || state.broken || !depth) return;
      try {
        depth.setSize(w, h, state.prepassScale);
      } catch (err) {
        warn('resize failed', err);
      }
    },

    dispose() {
      for (const off of unsub) {
        try {
          off();
        } catch {
          /* best effort */
        }
      }
      unsub.length = 0;
      try {
        if (batch?.mesh?.parent) batch.mesh.parent.remove(batch.mesh);
      } catch {
        /* best effort */
      }
      batch?.dispose();
      depth?.dispose();
      atlas?.dispose();
      batch = null;
      depth = null;
      atlas = null;
      list.length = 0;
      byId.clear();
      state.ready = false;
      api.ready = false;
    },
  };
}
