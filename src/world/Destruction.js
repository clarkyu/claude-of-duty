/**
 * Destruction.js — breakable geometry. Owner: destruction agent.
 * Files owned: this file, world/destruction/**.
 * Publishes: `ctx.destruction`.
 *
 * ── What this is ────────────────────────────────────────────────────────────────
 * Combat that leaves the world untouched feels weightless. This module makes the map
 * answer back: windows spiderweb and then blow out, plaster spalls to brick, crates
 * burst into planks with pale splintered cores, oil drums dent, leak and cook off,
 * awnings tear, pots shatter. Everything is deterministic, budgeted and pooled.
 *
 * ── How a break happens ─────────────────────────────────────────────────────────
 *   1. **Registry.** `register(mesh, opts)` — and the automatic sweep in `init()` —
 *      files a breakable under a material class from destruction/Classes.js, with an
 *      oriented bounding box, hit points scaled by face area, and a damage-state track.
 *      Entries live in a 4 m XZ grid so an explosion never walks the whole list.
 *   2. **Damage.** `bullet:impact`, `bullet:penetrate`, `physics:impact` and
 *      `explosion` are converted into HP at a point. Partial damage advances the state,
 *      and *that* is where most of the readability lives: chips, dents and crazing are
 *      drawn by `ctx.decals`, not by swapping geometry. Glass is special-cased — the
 *      decal system owns the four-stage spiderweb and tells us when the pane has taken
 *      all it can, through `decal:glassBreak`.
 *   3. **Fracture.** The pattern is precomputed, never derived at the moment of impact:
 *      a 3D Voronoi decomposition of the object's box, clipped cell by cell and cached
 *      by (distribution, cell count, size bucket, variant). See destruction/Voronoi.js.
 *      Faces lying in the original bounds keep the object's own material; every fresh
 *      cut gets the class's **interior** material — raw brick under painted plaster,
 *      pale splintered ply under weathered plank, bright metal under rust. Painted
 *      faces on a fresh break is the classic tell, and it cannot happen here.
 *   4. **Swap.** The source stops rasterising — a discrete object is hidden, a pane or
 *      a batched prop has its vertices collapsed in place (destruction/GlassPanes.js,
 *      destruction/Carver.js) — its colliders are removed, and the cached cells are
 *      instantiated from the fragment pool as rigid bodies with mass proportional to
 *      volume and an impulse inherited from the damage direction.
 *   5. **Settle and retire.** Fragments tumble, sleep, then shrink and sink away. The
 *      live cap derives from `ctx.settings.get('particleBudget')`; over budget the
 *      oldest fragment is recycled, never the newest.
 *
 * Walls that were never registered are not ignored: sustained fire accumulates in a
 * 0.6 m bucket and, past a threshold, spalls a real patch — fragments, dust, and a
 * wider decal showing the brick underneath.
 *
 * ── Public API (`ctx.destruction`) ──────────────────────────────────────────────
 *   register(mesh, opts)               -> entry | null
 *   registerVolume(opts)               -> entry | null   (logical breakable, no mesh)
 *   damage(point, amount, dir, radius) -> number of entries damaged
 *   breakAt(point, opts)               -> entry | null   force the nearest breakable
 *   explode(point, opts)               -> number of entries damaged
 *   reset()                            put the world back, exactly
 *   stats()                            registry / fragment / pattern counters
 *   list(filter?) / unregister(entry) / entryAt(point, radius)
 *   setEnabled(b) / enabled / ready / classes
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   bullet:impact, bullet:penetrate, explosion, decal:glassBreak, physics:impact,
 *   props:rebuilt, quality:changed, setting:changed, debug:pose
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   destruction:ready  {breakables, panes}
 *   destruction:state  {entry, state, point}
 *   destruction:break  {point, normal, cls, surface, entry, fragments}
 *   explosion          {point, radius, damage, source:'drum'}   volatile cook-off
 */
import * as THREE from 'three';
import { PatternCache } from './destruction/Patterns.js';
import { CLASSES, PROP_CLASS, classFor, MaterialResolver } from './destruction/Classes.js';
import { FragmentPool } from './destruction/Fragments.js';
import { findPanes, collapsePane, restorePane } from './destruction/GlassPanes.js';
import { MeshCarver } from './destruction/Carver.js';
import { clamp, clamp01, falloff, hashPoint, closestOnObb } from './destruction/util.js';
import { surfaceDefFor } from '../materials/SurfaceDefs.js';

const GRID = 4; // metres, XZ registry cell
const GROUP_WORLD = 1;
const GROUP_PROP = 8;

const FRAG_BUDGET = { low: 14, medium: 34, high: 64, ultra: 96 };
const CELL_SCALE = { low: 0.45, medium: 0.72, high: 1.0, ultra: 1.25 };
const PANE_LIMIT = { low: 60, medium: 120, high: 200, ultra: 260 };

/** Batched (non-dynamic) prop types still worth blowing apart. */
const CARVEABLE = new Set([
  'market_stall',
  'chain_link',
  'planter',
  'tarp_cover',
  'shop_sign',
  'utility_box',
  'ac_unit',
  'ac_unit_roof',
  'satellite_dish',
  'traffic_sign',
  'water_tank',
  'tv_aerial',
  'razor_wire',
  'cable_spool',
]);

const DYNAMIC_SURFACES = new Set(['wood', 'glass', 'ceramic', 'fabric', 'rubber']);
const SPALLABLE = new Set(['plaster', 'concrete', 'ceramic', 'wood']);

export default function createDestruction(ctx) {
  /* ── state ──────────────────────────────────────────────────────────────── */

  const entries = [];
  const grid = new Map();
  const byBody = new Map();
  const carves = [];
  const pending = [];
  const surfaceAcc = new Map();

  const patterns = new PatternCache(40, 0x5bd1e995);
  const resolver = new MaterialResolver(ctx);
  const carver = new MeshCarver();
  let pool = null;

  let nextId = 1;
  let broken = 0;
  let paneCount = 0;
  let inExplosion = 0;
  let refreshTimer = 0;
  let batchMeshCache = null;
  const unsub = [];
  const warned = new Set();

  /* Scratch. Every function below owns its own vectors — sharing one `_v` across a
   * call chain is exactly how a break ends up throwing its debris at the wrong wall. */
  const _qa = new THREE.Quaternion();
  const _up = new THREE.Vector3(0, 1, 0);
  const _down = new THREE.Vector3(0, -1, 0);
  const _fwdZ = new THREE.Vector3(0, 0, 1);
  const _zero = new THREE.Vector3(0, 0, 0);
  const _box = new THREE.Box3();
  const _hits = [];
  // per-function scratch
  const _qNear = new THREE.Vector3();
  const _qTmp = new THREE.Vector3();
  const _dmgDir = new THREE.Vector3();
  const _bp = new THREE.Vector3();
  const _bn = new THREE.Vector3();
  const _bd = new THREE.Vector3();
  const _losO = new THREE.Vector3();
  const _losD = new THREE.Vector3();
  const _losT = new THREE.Vector3();
  const _fp = new THREE.Vector3();
  const _fa = new THREE.Vector3();
  const _sn = new THREE.Vector3();
  const _sp = new THREE.Vector3();
  const _wp = new THREE.Vector3();
  const _wq = new THREE.Quaternion();
  const _scaleTmp = new THREE.Vector3();

  const api = { ready: false, enabled: true, classes: CLASSES };

  const warn = (tag, err) => {
    if (warned.has(tag)) return;
    warned.add(tag);
    console.warn(`[destruction] ${tag}:`, err?.message || err);
  };

  let fallbackState = 0x2f6e2b1;
  const rnd = () => {
    if (typeof ctx.rng === 'function') return ctx.rng();
    fallbackState = (Math.imul(fallbackState, 1664525) + 1013904223) >>> 0;
    return fallbackState / 4294967296;
  };

  /* ── spatial index ──────────────────────────────────────────────────────── */

  function indexEntry(e) {
    const r = e.radius;
    const i0 = Math.floor((e.centre.x - r) / GRID);
    const i1 = Math.floor((e.centre.x + r) / GRID);
    const k0 = Math.floor((e.centre.z - r) / GRID);
    const k1 = Math.floor((e.centre.z + r) / GRID);
    e.cells = [];
    for (let i = i0; i <= i1; i++) {
      for (let k = k0; k <= k1; k++) {
        const key = `${i},${k}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(e);
        e.cells.push(key);
      }
    }
  }

  function deindexEntry(e) {
    for (const key of e.cells || []) {
      const list = grid.get(key);
      if (!list) continue;
      const i = list.indexOf(e);
      if (i >= 0) list.splice(i, 1);
    }
    e.cells = null;
  }

  /** Unbroken entries whose bounding sphere reaches within `radius` of `p`. */
  function query(p, radius, out) {
    out.length = 0;
    const i0 = Math.floor((p.x - radius) / GRID);
    const i1 = Math.floor((p.x + radius) / GRID);
    const k0 = Math.floor((p.z - radius) / GRID);
    const k1 = Math.floor((p.z + radius) / GRID);
    if ((i1 - i0 + 1) * (k1 - k0 + 1) > 4096) return out;
    for (let i = i0; i <= i1; i++) {
      for (let k = k0; k <= k1; k++) {
        const list = grid.get(`${i},${k}`);
        if (!list) continue;
        for (const e of list) {
          if (e.broken || out.indexOf(e) >= 0) continue;
          const rr = radius + e.radius;
          if (e.centre.distanceToSquared(p) <= rr * rr) out.push(e);
        }
      }
    }
    return out;
  }

  /* ── registration ───────────────────────────────────────────────────────── */

  function makeEntry(o) {
    const cls = classFor(o.cls || o.class || o.propType, o.surface);
    const def = CLASSES[cls] || CLASSES.concrete;
    const half = new THREE.Vector3(
      Math.max(0.012, o.half.x),
      Math.max(0.012, o.half.y),
      Math.max(0.012, o.half.z)
    );
    // Hit points track the largest face: a shop window is not as tough as a porthole.
    const face =
      Math.max(half.x * half.y, half.y * half.z, half.z * half.x) * 4;
    const hp = Math.max(def.minHp, def.hp * face) * (o.hpScale ?? 1);
    const quaternion = (o.quaternion || _qa.identity()).clone().normalize();
    const e = {
      id: nextId++,
      cls,
      def,
      kind: o.kind || 'volume',
      centre: o.centre.clone(),
      quaternion,
      invQuaternion: quaternion.clone().invert(),
      localOffset: null,
      half,
      radius: half.length(),
      surface: o.surface || def.surface,
      hp: o.hp ?? hp,
      maxHp: o.hp ?? hp,
      state: 0,
      broken: false,
      cells: null,
      panes: o.panes || null,
      object: o.object || null,
      srcMaterial: o.srcMaterial || null,
      bodies: o.bodies ? o.bodies.filter(Boolean) : [],
      colliderDefs: o.colliderDefs || null,
      propRec: o.propRec || null,
      propType: o.propType || null,
      carveRecs: null,
      hidden: false,
      variant: (o.variant ?? nextId) & 3,
      volatile: !!def.volatile && o.volatile !== false,
      leaking: 0,
      lastHit: -999,
      onBreak: typeof o.onBreak === 'function' ? o.onBreak : null,
      tag: o.tag || null,
    };
    if (e.kind === 'object' && e.object) {
      e.object.updateWorldMatrix(true, false);
      e.object.getWorldPosition(_wp);
      e.localOffset = e.centre.clone().sub(_wp).applyQuaternion(e.invQuaternion);
    }
    entries.push(e);
    indexEntry(e);
    for (const b of e.bodies) byBody.set(b, e);
    return e;
  }

  function surfaceTagOf(material) {
    if (!material) return null;
    try {
      const m = Array.isArray(material) ? material[0] : material;
      return ctx.materials?.surfaceOf ? ctx.materials.surfaceOf(m).surface : surfaceDefFor(m).surface;
    } catch {
      return null;
    }
  }

  /**
   * Mark an Object3D as breakable.
   * @param {THREE.Object3D} mesh
   * @param {object} opts  { cls, surface, hp, hpScale, bodies, onBreak, tag,
   *                         half, centre, quaternion, material, volatile }
   */
  function register(mesh, opts = {}) {
    try {
      if (!mesh || !mesh.isObject3D) return registerVolume(opts);
      mesh.updateWorldMatrix(true, true);
      let quaternion = opts.quaternion
        ? opts.quaternion.clone()
        : mesh.getWorldQuaternion(new THREE.Quaternion());
      let half = opts.half ? new THREE.Vector3().copy(opts.half) : null;
      let centre = opts.centre ? new THREE.Vector3().copy(opts.centre) : null;

      if (!half || !centre) {
        // Fit the box in the object's own frame so a rotated crate stays tight.
        const inv = new THREE.Matrix4().makeRotationFromQuaternion(quaternion).invert();
        const local = new THREE.Vector3();
        _box.makeEmpty();
        mesh.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          const bb = o.geometry.boundingBox;
          if (!bb) return;
          for (let i = 0; i < 8; i++) {
            local.set(
              i & 1 ? bb.max.x : bb.min.x,
              i & 2 ? bb.max.y : bb.min.y,
              i & 4 ? bb.max.z : bb.min.z
            );
            local.applyMatrix4(o.matrixWorld).applyMatrix4(inv);
            _box.expandByPoint(local);
          }
        });
        if (_box.isEmpty()) return null;
        if (!centre) centre = _box.getCenter(new THREE.Vector3()).applyQuaternion(quaternion);
        if (!half) half = _box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      }

      let srcMaterial = opts.material || null;
      if (!srcMaterial) {
        mesh.traverse((o) => {
          if (!srcMaterial && o.isMesh && o.material) srcMaterial = o.material;
        });
      }
      return makeEntry({
        ...opts,
        kind: opts.kind || 'object',
        object: mesh,
        centre,
        half,
        quaternion,
        srcMaterial,
        surface: opts.surface || surfaceTagOf(srcMaterial) || undefined,
      });
    } catch (err) {
      warn('register', err);
      return null;
    }
  }

  /** A breakable with no discrete mesh — a pane group, a batched prop, a wall patch. */
  function registerVolume(opts = {}) {
    try {
      if (!opts.centre || !opts.half) return null;
      return makeEntry({ ...opts, kind: opts.kind || 'volume' });
    } catch (err) {
      warn('registerVolume', err);
      return null;
    }
  }

  function unregister(e) {
    if (!e) return false;
    const i = entries.indexOf(e);
    if (i < 0) return false;
    entries.splice(i, 1);
    deindexEntry(e);
    for (const b of e.bodies) byBody.delete(b);
    return true;
  }

  /* ── automatic discovery ────────────────────────────────────────────────── */

  function discoverPanes() {
    const tier = ctx.settings?.tier || 'high';
    const limit = PANE_LIMIT[tier] ?? 160;
    let groups = [];
    try {
      groups = findPanes(ctx, [ctx.level?.root, ctx.props?.root], { limit });
    } catch (err) {
      warn('pane discovery', err);
      return;
    }
    for (const g of groups) {
      const lead = g[0];
      if (!lead) continue;
      // Small low panes inside the prop batch are vehicle glazing: laminated, and it
      // crazes into a sheet of dice rather than long shards.
      const vehicular = lead.mesh?.parent && lead.area < 1.9 && lead.centre.y < 2.15;
      const cls = vehicular ? 'vehicle_glass' : 'glass';
      const colliderDef = {
        type: 'box',
        halfExtents: [
          Math.max(0.02, lead.half.x),
          Math.max(0.02, lead.half.y),
          Math.max(0.006, lead.half.z),
        ],
        pos: lead.centre.clone(),
        quat: lead.quaternion.clone(),
        surface: 'glass',
        material: 'glass_dirty',
        group: GROUP_WORLD,
      };
      const e = makeEntry({
        kind: 'pane',
        cls,
        surface: 'glass',
        centre: lead.centre,
        quaternion: lead.quaternion,
        half: lead.half,
        panes: g,
        colliderDefs: [colliderDef],
        srcMaterial: Array.isArray(lead.mesh.material) ? lead.mesh.material[0] : lead.mesh.material,
        variant: hashPoint(lead.centre.x, lead.centre.y, lead.centre.z, 7) & 3,
      });
      if (!e) continue;
      addColliders(e);
      paneCount++;
    }
  }

  /**
   * Glass with no collider is glass a bullet flies straight through — no impact event,
   * no decal, no break. This is the piece that makes windows actually shootable.
   */
  function addColliders(e) {
    if (!e.colliderDefs) return;
    for (const def of e.colliderDefs) {
      try {
        const body = ctx.physics?.addStatic?.(def);
        if (!body) continue;
        body.entity = { kind: 'breakable', id: e.id, cls: e.cls };
        e.bodies.push(body);
        byBody.set(body, e);
      } catch (err) {
        warn('pane collider', err);
      }
    }
  }

  function discoverProps() {
    const list = ctx.props?.list?.();
    if (!Array.isArray(list)) return;
    for (const rec of list) {
      try {
        const type = rec.type;
        const known = PROP_CLASS[type];
        const hasObject = !!rec.object;
        let cls = known;
        if (!cls) {
          if (!hasObject || !DYNAMIC_SURFACES.has(rec.surface)) continue;
          cls = classFor(null, rec.surface);
        } else if (!hasObject && !CARVEABLE.has(type)) {
          continue;
        }

        const b = rec.bounds;
        if (!b || !b.size) continue;
        const s = rec.scale || 1;
        const half = new THREE.Vector3(
          Math.max(0.02, (b.size[0] / 2) * s),
          Math.max(0.02, (b.size[1] / 2) * s),
          Math.max(0.02, (b.size[2] / 2) * s)
        );
        if (half.length() > 4.5) continue; // a bus shelter is architecture, not debris
        const quat = rec.quaternion ? rec.quaternion.clone() : new THREE.Quaternion();
        const centre = new THREE.Vector3(
          ((b.min[0] + b.max[0]) / 2) * s,
          ((b.min[1] + b.max[1]) / 2) * s,
          ((b.min[2] + b.max[2]) / 2) * s
        )
          .applyQuaternion(quat)
          .add(rec.position);

        const bodies = [];
        if (rec.body) bodies.push(rec.body);
        if (Array.isArray(rec.colliders)) for (const c of rec.colliders) if (c) bodies.push(c);

        makeEntry({
          kind: hasObject ? 'object' : 'batched',
          cls,
          propType: type,
          propRec: rec,
          surface: rec.surface,
          centre,
          half,
          quaternion: quat,
          object: rec.object || null,
          bodies,
          variant: (rec.id ?? 0) & 3,
        });
      } catch (err) {
        warn('prop registration', err);
      }
    }
  }

  /* ── damage ─────────────────────────────────────────────────────────────── */

  function energyToDamage(energy) {
    if (!Number.isFinite(energy)) return 26;
    return clamp(6 + energy * 0.0118, 3, 120);
  }

  /** Nearest unbroken breakable whose surface is within `radius` of `point`. */
  function entryAt(point, radius = 0.3) {
    query(point, radius, _hits);
    let best = null;
    let bestD = Infinity;
    for (const e of _hits) {
      const d = closestOnObb(point, e.centre, e.quaternion, e.invQuaternion, e.half, _qNear, _qTmp);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best && bestD <= radius * radius ? best : null;
  }

  /**
   * Apply HP of damage at a point.
   * @returns {number} entries damaged
   */
  function damage(point, amount, dir, radius = 0.25) {
    if (!api.enabled || !(amount > 0) || !point) return 0;
    query(point, radius, _hits);
    const list = _hits.slice();
    let n = 0;
    for (const e of list) {
      if (e.broken) continue;
      const d2 = closestOnObb(point, e.centre, e.quaternion, e.invQuaternion, e.half, _qNear, _qTmp);
      const d = Math.sqrt(d2);
      if (d > radius) continue;
      const k = radius > 0.001 ? falloff(d, radius) * 0.65 + 0.35 : 1;
      applyDamage(e, point, amount * k, dir);
      n++;
    }
    return n;
  }

  function applyDamage(e, point, amount, dir) {
    if (e.broken || !(amount > 0)) return;
    e.hp -= amount;
    e.lastHit = ctx.time?.elapsed ?? 0;
    if (e.hp <= 0) {
      doBreak(e, point, dir, amount);
      return;
    }
    const states = e.def.states;
    const t = 1 - clamp01(e.hp / e.maxHp);
    const stage = Math.min(states.length - 2, Math.floor(t * (states.length - 1)));
    if (stage > e.state) {
      e.state = stage;
      onStateChange(e, point, dir);
    }
  }

  /**
   * Sub-lethal damage. Early stages are decals — chips, dents, crazing — because a
   * geometry swap for every scratch is both expensive and, at this scale, less
   * convincing than a well-lit crater.
   */
  function onStateChange(e, point, dir) {
    const def = e.def;
    const name = def.states[e.state];
    try {
      ctx.bus?.emit?.('destruction:state', { entry: e, state: name, point: _sp.copy(point).clone() });
    } catch {
      /* listeners are optional */
    }

    // Glass crazing belongs to the decal system's four-stage spiderweb; a second web
    // on top of it just reads as mush.
    if (e.surface !== 'glass') {
      _sn.copy(point).sub(e.centre);
      if (_sn.lengthSq() < 1e-8) _sn.copy(_up);
      _sn.normalize();
      const revealed = def.interior === 'brick_red' && e.state >= 2 ? 'brick_red' : e.surface;
      try {
        ctx.decals?.place?.({ point, normal: _sn, surface: revealed }, undefined, {
          size: clamp(0.16 + e.state * 0.14, 0.14, 0.55),
          opacity: 0.9,
        });
      } catch (err) {
        warn('state decal', err);
      }
    }

    try {
      _sp.copy(dir && dir.isVector3 ? dir : _up);
      if (dir && dir.isVector3) _sp.multiplyScalar(-1);
      ctx.fx?.impact?.(point, _sp, { surface: e.surface, scale: 0.7 + e.state * 0.25 });
    } catch (err) {
      warn('state fx', err);
    }
    try {
      ctx.audio?.play?.(def.hitSound || 'impact_concrete', { position: point, volume: 0.6 });
    } catch {
      /* audio is optional */
    }
    if (name === 'leaking') startLeak(e);
  }

  /* ── the break ──────────────────────────────────────────────────────────── */

  function doBreak(e, point, dir, power = 40) {
    if (e.broken) return;
    e.broken = true;
    e.hp = 0;
    e.state = e.def.states.length - 1;
    broken++;
    deindexEntry(e);

    // Snapshot the inputs first: `point` and `dir` are very often caller scratch.
    if (point) _bp.copy(point);
    else _bp.copy(e.centre);
    if (dir && dir.isVector3 && dir.lengthSq() > 1e-8) _bd.copy(dir).normalize();
    else _bd.set(0, 0, 0);
    _bn.copy(_bp).sub(e.centre);
    if (_bn.lengthSq() < 1e-8) _bn.copy(_up);
    _bn.normalize();

    hideSource(e);
    removeColliders(e);
    const count = spawnFragments(e, _bp, _bd, power);
    breakFx(e, _bp, _bn, power);

    if (e.volatile) queueCookOff(e);
    try {
      e.onBreak?.(e, _bp);
    } catch (err) {
      warn('onBreak callback', err);
    }
    try {
      ctx.bus?.emit?.('destruction:break', {
        point: _bp.clone(),
        normal: _bn.clone(),
        cls: e.cls,
        surface: e.surface,
        entry: e,
        fragments: count,
      });
    } catch {
      /* listeners are optional */
    }
  }

  function hideSource(e) {
    if (e.kind === 'pane' && e.panes) {
      for (const p of e.panes) {
        try {
          collapsePane(p);
        } catch (err) {
          warn('pane collapse', err);
        }
      }
      e.hidden = true;
      return;
    }
    if (e.object) {
      e.object.visible = false;
      e.hidden = true;
      return;
    }
    if (e.kind !== 'batched') return;

    const recs = [];
    for (const mesh of batchMeshes()) {
      const geo = mesh.geometry;
      if (!geo) continue;
      if (!geo.boundingSphere) {
        try {
          geo.computeBoundingSphere();
        } catch {
          continue;
        }
      }
      const bs = geo.boundingSphere;
      if (!bs) continue;
      mesh.updateWorldMatrix(true, false);
      _wp.copy(bs.center).applyMatrix4(mesh.matrixWorld);
      mesh.getWorldScale(_scaleTmp);
      const s = Math.max(Math.abs(_scaleTmp.x), Math.abs(_scaleTmp.y), Math.abs(_scaleTmp.z)) || 1;
      if (_wp.distanceTo(e.centre) > bs.radius * s + e.radius + 0.5) continue;
      try {
        const rec = carver.carve(mesh, e.centre, e.quaternion, e.half, 0.03);
        if (rec) recs.push(rec);
      } catch (err) {
        warn('carve', err);
      }
    }
    if (recs.length) {
      e.carveRecs = recs;
      for (const r of recs) carves.push(r);
      e.hidden = true;
    }
  }

  function batchMeshes() {
    if (batchMeshCache) return batchMeshCache;
    const out = [];
    const root = ctx.props?.root;
    if (root) {
      try {
        root.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          const pos = o.geometry.getAttribute?.('position');
          if (!pos || pos.count > 150000) return;
          out.push(o);
        });
      } catch (err) {
        warn('batch scan', err);
      }
    }
    batchMeshCache = out;
    return out;
  }

  function removeColliders(e) {
    for (const b of e.bodies) {
      if (!b) continue;
      try {
        ctx.physics?.removeBody?.(b);
      } catch {
        /* already gone */
      }
    }
  }

  /* ── fragments ──────────────────────────────────────────────────────────── */

  function spawnFragments(e, point, dir, power) {
    if (!pool) return 0;
    const def = e.def;
    const tier = ctx.settings?.tier || 'high';
    const count = clamp(Math.round(def.cells * (CELL_SCALE[tier] ?? 1)), 3, 32);
    let pattern = null;
    try {
      pattern = patterns.get({
        dist: def.dist,
        count,
        hx: e.half.x,
        hy: e.half.y,
        hz: e.half.z,
        variant: e.variant,
      });
    } catch (err) {
      warn('pattern build', err);
      return 0;
    }
    if (!pattern?.cells?.length) return 0;

    // The pattern was built at snapped extents; stretch it back onto the real object so
    // the debris field covers exactly the volume that just disappeared.
    const sx = e.half.x / pattern.half[0];
    const sy = e.half.y / pattern.half[1];
    const sz = e.half.z / pattern.half[2];

    const surfDef = surfaceDefFor(def.exterior);
    const density = (surfDef?.density ?? 900) * 0.55;
    const exterior = resolver.exteriorFor(e.cls, e.srcMaterial);
    const interior = resolver.interiorFor(e.cls);
    if (!exterior && !interior) return 0;
    const shadows = !!ctx.settings?.get?.('shadows') && !def.noShadow;
    const impulse = def.impulse * clamp(0.4 + power / 55, 0.45, 3.2);
    const cap = Math.min(pattern.cells.length, Math.max(4, Math.round(pool.max * 0.75)));

    let made = 0;
    for (const cell of pattern.cells) {
      if (made >= cap) break;
      _fp.set(cell.centre[0] * sx, cell.centre[1] * sy, cell.centre[2] * sz)
        .applyQuaternion(e.quaternion)
        .add(e.centre);

      // Thrown away from the impact, carried by the shot, and lifted enough that the
      // pile does not simply appear on the floor.
      _fa.copy(_fp).sub(point);
      const d = _fa.length();
      if (d > 1e-4) _fa.multiplyScalar(1 / d);
      else _fa.copy(_up);
      const spread = impulse * (0.9 + rnd() * 1.5);
      const vx = _fa.x * spread + dir.x * impulse * 0.85 + (rnd() - 0.5) * 0.7;
      const vy = _fa.y * spread * 0.7 + dir.y * impulse * 0.5 + 0.6 + rnd() * 1.1;
      const vz = _fa.z * spread + dir.z * impulse * 0.85 + (rnd() - 0.5) * 0.7;

      const hx = cell.half[0] * sx;
      const hy = cell.half[1] * sy;
      const hz = cell.half[2] * sz;
      if (!cell.shapes) cell.shapes = new Map();
      const shapeKey = `${hx.toFixed(3)}_${hy.toFixed(3)}_${hz.toFixed(3)}`;
      let shape = cell.shapes.get(shapeKey);
      if (shape === undefined) {
        shape = null;
        try {
          shape = ctx.physics?.shapes?.box ? ctx.physics.shapes.box(hx, hy, hz) : null;
        } catch {
          shape = null;
        }
        cell.shapes.set(shapeKey, shape);
      }

      const slot = pool.spawn({
        geometry: cell.geometry,
        exterior,
        interior,
        position: _fp,
        quaternion: e.quaternion,
        scale: [sx, sy, sz],
        half: [hx, hy, hz],
        shape,
        volume: cell.volume * sx * sy * sz,
        density,
        radius: cell.radius * Math.max(sx, sy, sz),
        surface: e.surface,
        life: def.life * (0.75 + rnd() * 0.5),
        velocity: [vx, vy, vz],
        spin: [(rnd() - 0.5) * 9, (rnd() - 0.5) * 9, (rnd() - 0.5) * 9],
        castShadow: shadows && cell.radius > 0.09,
        mode: cell.radius * Math.max(sx, sy, sz) < 0.05 ? 'simple' : undefined,
      });
      if (slot) made++;
    }
    return made;
  }

  /* ── effects ────────────────────────────────────────────────────────────── */

  const _col = new THREE.Color();

  function breakFx(e, point, normal, power) {
    const def = e.def;
    const surfDef = surfaceDefFor(def.exterior);
    _col.setHex(surfDef?.impactColor ?? 0xb2aca2, THREE.SRGBColorSpace);
    const size = clamp(e.radius, 0.15, 2.2);

    try {
      const fx = ctx.fx;
      if (fx?.burst) {
        if (def.dust > 0.05) {
          fx.burst('dust', {
            x: point.x, y: point.y, z: point.z,
            dx: normal.x, dy: normal.y + 0.4, dz: normal.z,
            cone: 0.9,
            count: Math.round(10 + 22 * def.dust * size),
            spread: size * 0.55,
            speed: 1.4 + power * 0.02,
            speedVar: 0.7,
            life: 1.5 + def.dust * 1.4,
            size0: size * 0.28,
            size1: size * 1.5,
            r: _col.r, g: _col.g, b: _col.b,
            shadeVar: 0.3,
          });
        }
        if (def.debris > 0.05) {
          fx.burst('fleck', {
            x: point.x, y: point.y, z: point.z,
            dx: normal.x, dy: normal.y + 0.55, dz: normal.z,
            cone: 0.85,
            count: Math.round(8 + 26 * def.debris * size),
            spread: size * 0.4,
            speed: 3.2 + power * 0.05,
            speedVar: 0.75,
            life: 1.3,
            size0: 0.012,
            size1: 0.03,
            r: _col.r, g: _col.g, b: _col.b,
            shadeVar: 0.45,
          });
        }
        if (e.surface === 'metal') {
          fx.burst('spark', {
            x: point.x, y: point.y, z: point.z,
            dx: normal.x, dy: normal.y, dz: normal.z,
            cone: 0.8, count: 14, speed: 6, life: 0.5,
            size0: 0.02, size1: 0.05, r: 1, g: 0.72, b: 0.36,
          });
        }
      }
    } catch (err) {
      warn('break fx', err);
    }

    try {
      ctx.audio?.play?.(def.breakSound, { position: point, volume: 1 });
    } catch {
      /* audio is optional */
    }

    // A chunk out of a wall leaves a scar, not just a pile.
    if (e.kind !== 'object' && e.surface !== 'glass') {
      try {
        ctx.decals?.place?.({ point, normal, surface: e.surface }, undefined, {
          size: clamp(size * 0.9, 0.2, 1.4),
          opacity: 0.85,
        });
      } catch (err) {
        warn('break decal', err);
      }
    }
  }

  /** A punctured drum weeps before it lets go. */
  function startLeak(e) {
    e.leaking = ctx.time?.elapsed ?? 0;
    try {
      _sp.copy(e.centre);
      _sp.y -= e.half.y * 0.9;
      ctx.decals?.place?.({ point: _sp, normal: _up, surface: 'concrete' }, 'oil', {
        size: Math.max(0.6, e.half.x * 3),
        opacity: 0.9,
      });
    } catch {
      /* the stain is a nice-to-have */
    }
    try {
      ctx.fx?.burst?.('smoke_puff', {
        x: e.centre.x, y: e.centre.y, z: e.centre.z,
        dy: -1, cone: 0.4, count: 6, speed: 0.7, life: 1.6,
        size0: 0.06, size1: 0.3, r: 0.18, g: 0.16, b: 0.14,
      });
    } catch {
      /* optional */
    }
  }

  function queueCookOff(e) {
    pending.push({
      point: e.centre.clone(),
      radius: clamp(e.radius * 5.5, 3.2, 8),
      damage: 110,
      t: 0.28 + rnd() * 0.22,
    });
  }

  /* ── explosions ─────────────────────────────────────────────────────────── */

  function explode(point, opts = {}) {
    if (!api.enabled || !point) return 0;
    const radius = clamp(opts.radius ?? 4, 0.4, 30);
    const dmg = opts.damage ?? 100;
    query(point, radius, _hits);
    const list = _hits.slice();
    let n = 0;
    for (const e of list) {
      if (e.broken) continue;
      const d2 = closestOnObb(point, e.centre, e.quaternion, e.invQuaternion, e.half, _qNear, _qTmp);
      const d = Math.sqrt(d2);
      if (d > radius) continue;
      const vis = lineOfSight(point, _qNear, e);
      if (vis <= 0.02) continue; // cover works
      const amount = dmg * (0.3 + falloff(d, radius) * vis * 1.8);
      _dmgDir.copy(_qNear).sub(point);
      if (_dmgDir.lengthSq() > 1e-8) _dmgDir.normalize();
      else _dmgDir.copy(_up);
      applyDamage(e, _qNear, amount, _dmgDir);
      n++;
    }

    if (radius > 2.2) {
      try {
        const hit = ctx.physics?.raycast?.(point, _down, radius * 1.4, GROUP_WORLD | GROUP_PROP);
        if (hit && ctx.decals?.scorch) {
          ctx.decals.scorch(hit.point, hit.normal, clamp(radius * 0.55, 0.6, 5), { opacity: 0.85 });
        }
      } catch (err) {
        warn('scorch', err);
      }
    }
    return n;
  }

  /**
   * 0 = fully covered, 1 = clear line. Three rays, so a railing does not read as a
   * bunker and a jersey barrier still protects what is behind it.
   */
  function lineOfSight(from, to, ignoreEntry) {
    const phys = ctx.physics;
    if (!phys?.raycast) return 1;
    _losT.copy(to).sub(from);
    const dist = _losT.length();
    if (dist < 0.15) return 1;
    let clear = 0;
    let tries = 0;
    for (let i = 0; i < 3; i++) {
      _losO.copy(from);
      if (i === 1) _losO.y += 0.26;
      else if (i === 2) _losO.y -= 0.22;
      _losD.copy(to).sub(_losO);
      const dl = _losD.length();
      if (dl < 1e-3) continue;
      _losD.multiplyScalar(1 / dl);
      tries++;
      let hit = null;
      try {
        hit = phys.raycast(_losO, _losD, dl - 0.08, GROUP_WORLD | GROUP_PROP);
      } catch {
        hit = null;
      }
      if (!hit) {
        clear++;
        continue;
      }
      if (hit.body && byBody.get(hit.body) === ignoreEntry) clear++; // our own skin
    }
    return tries ? clear / tries : 1;
  }

  /* ── ad-hoc surface damage on unregistered walls ────────────────────────── */

  function accumulateSurface(point, surface, amount, dir, normal) {
    if (!SPALLABLE.has(surface)) return;
    const key = `${Math.round(point.x / 0.6)},${Math.round(point.y / 0.6)},${Math.round(point.z / 0.6)}`;
    const now = ctx.time?.elapsed ?? 0;
    let rec = surfaceAcc.get(key);
    if (!rec) {
      if (surfaceAcc.size > 160) {
        let coldest = null;
        let coldT = Infinity;
        for (const [k, r] of surfaceAcc) {
          if (r.t < coldT) {
            coldT = r.t;
            coldest = k;
          }
        }
        if (coldest !== null) surfaceAcc.delete(coldest);
      }
      surfaceAcc.set(key, (rec = { acc: 0, t: now, n: 0 }));
    }
    rec.acc += amount;
    rec.t = now;
    const threshold = surface === 'concrete' ? 260 : surface === 'wood' ? 150 : 170;
    if (rec.acc < threshold || rec.n >= 2) return;
    rec.acc = 0;
    rec.n++;
    spallPatch(point, normal, surface, dir);
  }

  /**
   * A patch of wall lets go: real convex fragments with a brick interior, a dust puff,
   * and a wider decal so the hole stays readable long after the debris has gone.
   */
  function spallPatch(point, normal, surface, dir) {
    if (!pool) return;
    const cls = classFor(null, surface);
    const def = CLASSES[cls];
    const half = 0.15 + rnd() * 0.08;
    let pattern = null;
    try {
      pattern = patterns.get({
        dist: 'chunk',
        count: Math.round(6 * (CELL_SCALE[ctx.settings?.tier || 'high'] ?? 1)) + 2,
        hx: half,
        hy: half,
        hz: 0.04,
        variant: hashPoint(point.x, point.y, point.z, 3) & 3,
      });
    } catch (err) {
      warn('spall pattern', err);
      return;
    }
    if (!pattern?.cells?.length) return;

    _sn.copy(normal && normal.isVector3 ? normal : _up);
    if (_sn.lengthSq() < 1e-8) _sn.copy(_up);
    _sn.normalize();
    const q = _wq.setFromUnitVectors(_fwdZ, _sn);
    const surfDef = surfaceDefFor(def.exterior);
    const density = (surfDef?.density ?? 1200) * 0.5;
    const exterior = resolver.exteriorFor(cls, null);
    const interior = resolver.interiorFor(cls);
    let made = 0;
    for (const cell of pattern.cells) {
      if (made >= 8) break;
      _fp.set(cell.centre[0], cell.centre[1], cell.centre[2])
        .applyQuaternion(q)
        .add(point)
        .addScaledVector(_sn, 0.02);
      const sp = 1.4 + rnd() * 2.2;
      pool.spawn({
        geometry: cell.geometry,
        exterior,
        interior,
        position: _fp,
        quaternion: q,
        half: cell.half,
        volume: cell.volume,
        density,
        radius: cell.radius,
        surface,
        life: def.life * 0.7,
        velocity: [
          _sn.x * sp + (rnd() - 0.5) * 1.1,
          _sn.y * sp + 0.9 + rnd() * 0.8,
          _sn.z * sp + (rnd() - 0.5) * 1.1,
        ],
        spin: [(rnd() - 0.5) * 12, (rnd() - 0.5) * 12, (rnd() - 0.5) * 12],
        castShadow: false,
        mode: 'simple',
      });
      made++;
    }

    try {
      _col.setHex(surfDef?.impactColor ?? 0xcfc7b8, THREE.SRGBColorSpace);
      ctx.fx?.burst?.('dust', {
        x: point.x, y: point.y, z: point.z,
        dx: _sn.x, dy: _sn.y + 0.3, dz: _sn.z,
        cone: 0.8, count: 14, spread: 0.18, speed: 1.6, life: 1.5,
        size0: 0.12, size1: 0.7,
        r: _col.r, g: _col.g, b: _col.b, shadeVar: 0.3,
      });
    } catch (err) {
      warn('spall fx', err);
    }
    try {
      // The reveal: under painted plaster there is brick, and now you can see it.
      const under = cls === 'plaster' ? 'brick_red' : def.exterior;
      ctx.decals?.place?.({ point, normal: _sn, surface: under }, undefined, {
        size: half * 2.6,
        opacity: 0.95,
      });
    } catch (err) {
      warn('spall decal', err);
    }
    try {
      ctx.audio?.play?.(def.breakSound, { position: point, volume: 0.5 });
    } catch {
      /* optional */
    }
    void dir;
  }

  /* ── force-break helpers ────────────────────────────────────────────────── */

  function breakAt(point, opts = {}) {
    if (!api.enabled || !point) return null;
    const e = opts.entry || entryAt(point, opts.radius ?? 0.6);
    if (!e || e.broken) return null;
    _dmgDir.copy(opts.dir && opts.dir.isVector3 ? opts.dir : _down);
    doBreak(e, point, _dmgDir, opts.power ?? 55);
    return e;
  }

  /* ── event handlers ─────────────────────────────────────────────────────── */

  function onImpact(p) {
    if (!api.enabled || !p?.point) return;
    const dmg = energyToDamage(p.energy);
    const direct = p.body ? byBody.get(p.body) : null;
    if (direct && !direct.broken) {
      applyDamage(direct, p.point, dmg, p.dir);
      return;
    }
    const near = entryAt(p.point, 0.32);
    if (near) {
      applyDamage(near, p.point, dmg, p.dir);
      return;
    }
    accumulateSurface(p.point, p.surface || 'concrete', dmg, p.dir, p.normal);
  }

  function onPenetrate(p) {
    if (!api.enabled) return;
    // A round that punched through has already spent itself: half damage, both faces.
    const dmg = energyToDamage(p?.energyOut ?? p?.energyIn ?? 900) * 0.5;
    if (p?.entryPoint) damage(p.entryPoint, dmg, p.dir, 0.25);
    if (p?.exitPoint) damage(p.exitPoint, dmg, p.dir, 0.25);
  }

  function onExplosion(p) {
    if (!api.enabled || !p?.point) return;
    if (inExplosion > 2) return; // a chain reaction must terminate
    inExplosion++;
    try {
      explode(p.point, { radius: p.radius ?? 4, damage: p.damage ?? 100 });
    } finally {
      inExplosion--;
    }
  }

  function onGlassBreak(p) {
    if (!api.enabled) return;
    let e = p?.body ? byBody.get(p.body) : null;
    if (!e && p?.point) e = entryAt(p.point, 0.7);
    if (!e || e.broken || e.surface !== 'glass') return;
    _dmgDir.copy(p?.normal && p.normal.isVector3 ? p.normal : _up).multiplyScalar(-1);
    doBreak(e, p?.point || e.centre, _dmgDir, 45);
  }

  function onPhysicsImpact(p) {
    // Something thrown into a breakable at speed should break it: a drum blown into a
    // market stall, a crate kicked down a stairwell.
    if (!api.enabled || !p?.point || !(p.speed > 5)) return;
    const e = entryAt(p.point, 0.35);
    if (!e) return;
    const mass = p.body?.mass || 8;
    applyDamage(e, p.point, clamp(mass * p.speed * 0.3, 4, 90), p.normal);
  }

  /* ── budget ─────────────────────────────────────────────────────────────── */

  function applyBudget() {
    const tier = ctx.settings?.tier || 'high';
    const particles = ctx.settings?.get?.('particleBudget') ?? 4000;
    pool?.setMax(clamp(Math.round(particles / 110), 8, FRAG_BUDGET[tier] ?? 48));
  }

  /* ── reset ──────────────────────────────────────────────────────────────── */

  function reset() {
    pool?.clear();
    pending.length = 0;
    surfaceAcc.clear();
    for (const rec of carves) MeshCarver.restore(rec);
    carves.length = 0;
    for (const e of entries) {
      if (e.panes) for (const p of e.panes) restorePane(p);
      if (e.object && e.hidden) e.object.visible = true;
      const wasBroken = e.broken;
      e.hidden = false;
      e.carveRecs = null;
      e.leaking = 0;
      e.hp = e.maxHp;
      e.state = 0;
      if (!wasBroken) continue;
      e.broken = false;
      indexEntry(e);
      for (const b of e.bodies) {
        if (!b || b.world) continue;
        try {
          ctx.physics?.world?.addBody?.(b);
        } catch {
          /* a collider we cannot restore only affects debug poses */
        }
      }
    }
    broken = 0;
  }

  /* ── debug poses ────────────────────────────────────────────────────────── */

  function onPose(state) {
    // Poses have to be reproducible, so every one starts from an intact world.
    reset();
    const d = state?.destruction;
    if (!d) return;
    const spec = typeof d === 'string' || d === true ? { mode: d === true ? 'broken' : d } : d;
    const centre = spec.break
      ? new THREE.Vector3().fromArray(spec.break)
      : ctx.camera
        ? ctx.camera.getWorldPosition(new THREE.Vector3())
        : new THREE.Vector3();
    const mode = spec.mode || 'broken';
    if (mode === 'reset' || mode === 'none') return;
    const glassOnly = mode === 'shattered' || mode === 'glass';
    const radius = spec.radius ?? (glassOnly ? 30 : 18);

    query(centre, radius, _hits);
    const list = _hits.slice().sort((a, b) => a.id - b.id);
    let n = 0;
    for (const e of list) {
      if (glassOnly && e.surface !== 'glass') continue;
      if (n >= (spec.limit ?? 24)) break;
      n++;
      _dmgDir.copy(e.centre).sub(centre);
      if (_dmgDir.lengthSq() < 1e-8) _dmgDir.copy(_up);
      _dmgDir.normalize();
      _sp.copy(e.centre).addScaledVector(_dmgDir, -e.radius * 0.85);
      doBreak(e, _sp, _dmgDir, spec.power ?? 55);
    }
    // Let the debris land, so the screenshot shows a settled scene not a freeze-frame.
    const settle = spec.settle ?? 1.0;
    if (settle > 0 && pool) {
      const steps = Math.min(45, Math.round(settle * 45));
      for (let i = 0; i < steps; i++) {
        pool.update(1 / 45);
        try {
          // The solver is tuned for 1/120; feeding it a render-sized step would make
          // the debris jitter, so take two proper sub-steps instead.
          ctx.physics?.step?.(1 / 120);
          ctx.physics?.step?.(1 / 120);
        } catch {
          /* stepping physics here is a bonus, not a requirement */
        }
      }
    }
  }

  /* ── api ────────────────────────────────────────────────────────────────── */

  Object.assign(api, {
    register,
    registerVolume,
    unregister,
    damage,
    breakAt,
    explode,
    entryAt,
    reset,
    list(filter) {
      if (!filter) return entries.slice();
      if (typeof filter === 'string') return entries.filter((e) => e.cls === filter || e.propType === filter);
      if (typeof filter === 'function') return entries.filter(filter);
      return entries.slice();
    },
    setEnabled(v) {
      api.enabled = !!v;
    },
    stats() {
      return {
        breakables: entries.length,
        panes: paneCount,
        broken,
        fragments: pool ? pool.stats() : null,
        patterns: patterns.size,
        patternsBuilt: patterns.built,
        patternMs: Math.round(patterns.buildMs),
        surfaceBuckets: surfaceAcc.size,
        pendingBlasts: pending.length,
      };
    },
  });

  /* ── system ─────────────────────────────────────────────────────────────── */

  return {
    name: 'destruction',
    order: 38,

    async init() {
      ctx.destruction = api;
      try {
        patterns.seed = (Math.floor(rnd() * 0xffffffff) ^ 0x5bd1e995) >>> 0;
        resolver.build();
        pool = new FragmentPool(ctx);
        applyBudget();

        discoverPanes();
        discoverProps();

        const on = (name, fn) => {
          const off = ctx.bus?.on?.(name, (p) => {
            try {
              fn(p);
            } catch (err) {
              warn(name, err);
            }
          });
          if (off) unsub.push(off);
        };
        on('bullet:impact', onImpact);
        on('bullet:penetrate', onPenetrate);
        on('explosion', onExplosion);
        on('decal:glassBreak', onGlassBreak);
        on('physics:impact', onPhysicsImpact);
        on('quality:changed', applyBudget);
        on('setting:changed', (p) => {
          if (p?.key === 'particleBudget' || p?.key === 'shadows') applyBudget();
        });
        on('debug:pose', onPose);
        on('props:rebuilt', () => {
          batchMeshCache = null;
        });

        api.ready = true;
        ctx.bus?.emit?.('destruction:ready', { breakables: entries.length, panes: paneCount });
      } catch (err) {
        // A destruction failure must never blank the screen.
        console.warn('[destruction] init failed, running inert', err);
        api.ready = false;
      }
    },

    update(dt) {
      if (!api.ready) return;
      try {
        pool?.update(dt);
      } catch (err) {
        warn('fragment update', err);
      }

      // Queued cook-offs go out on the bus, so fx, physics, decals, audio and the AI
      // all react to a drum exactly as they would to a grenade.
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        p.t -= dt;
        if (p.t > 0) continue;
        pending.splice(i, 1);
        try {
          ctx.fx?.explosion?.(p.point, { radius: p.radius, damage: p.damage, type: 'fuel' });
        } catch (err) {
          warn('cook-off fx', err);
        }
        try {
          ctx.bus?.emit?.('explosion', {
            point: p.point,
            radius: p.radius,
            damage: p.damage,
            source: 'drum',
          });
        } catch (err) {
          warn('cook-off emit', err);
        }
      }

      // Dynamic props drift and topple; keep their boxes where the meshes actually are.
      refreshTimer -= dt;
      if (refreshTimer > 0) return;
      refreshTimer = 1.1;
      for (const e of entries) {
        if (e.broken || e.kind !== 'object' || !e.object || !e.object.parent) continue;
        e.object.updateWorldMatrix(true, false);
        e.object.getWorldPosition(_wp);
        e.object.getWorldQuaternion(_wq);
        _sp.copy(e.localOffset || _zero).applyQuaternion(_wq).add(_wp);
        if (_sp.distanceToSquared(e.centre) < 4e-4 && _wq.angleTo(e.quaternion) < 0.02) continue;
        deindexEntry(e);
        e.centre.copy(_sp);
        e.quaternion.copy(_wq);
        e.invQuaternion.copy(_wq).invert();
        indexEntry(e);
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
        reset();
      } catch {
        /* best effort */
      }
      pool?.dispose();
      pool = null;
      patterns.dispose();
      resolver.dispose();
      carver.dispose();
      entries.length = 0;
      grid.clear();
      byBody.clear();
      surfaceAcc.clear();
      api.ready = false;
    },
  };
}
