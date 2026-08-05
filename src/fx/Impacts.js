/**
 * Impacts — what a bullet does to a surface, plus explosions and shell casings.
 * Owner: FX agent. Used by FXSystem.
 *
 * Every effect here is driven off `ctx.materials.surfaceOf()`, so the same round
 * reads completely differently depending on what it hits, and a level artist who
 * tags a wall as `brick_red` gets brick-coloured dust for free:
 *
 *   concrete / plaster / brick   grey dust column, chips, a brief spark ring
 *   metal                        hot sparks that bounce, a ping of smoke, no dust
 *   wood                         splinters and a thin resinous haze
 *   dirt / sand / grass / snow   a soil plume with clods thrown out of the crater
 *   glass / ceramic              shards, glitter, no smoke
 *   water                        a splash crown, droplets and a surface ring
 *   flesh                        a fine mist and a few heavy droplets
 *   foliage                      shredded leaves
 *
 * ── Debris is real ──────────────────────────────────────────────────────────────
 * Chips, splinters, shards, clods and brass are *not* billboards. They are pooled
 * instanced meshes stepped on the CPU with gravity and drag, raycast against the
 * world through `ctx.physics`, bounced with the surface's own restitution and
 * friction, and settled flat where they stop. They are opaque solids, so they go
 * into `ctx.scene` rather than the FX overlay: that way they write depth, take
 * cascade shadows, sit in the AO and pick up the IBL like everything else. Debris
 * that floats or lights differently from the world it landed in is the fastest way
 * to make an impact look pasted on.
 *
 * Brass gets the same treatment plus a metallic ping on first bounce
 * (`ctx.audio.play`), and its viewmodel counterpart is left alone for the first
 * half second so the two never double up on screen.
 */
import * as THREE from 'three';
import { TYPE } from './GPUParticles.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

/* ═══════════════════════════════════════════════════════════════════ debris ══ */

const DEBRIS_KINDS = ['rock', 'splinter', 'shard', 'brass'];

class Debris {
  constructor(ctx, fx) {
    this.ctx = ctx;
    this.fx = fx;
    this.groups = [];
    this.live = 0;
  }

  init() {
    const s = this.ctx.settings;
    const headless = !!s?.get?.('headless');
    const tier = { low: 0.35, medium: 0.6, high: 1, ultra: 1.3 }[s?.tier || 'high'] ?? 1;
    const base = headless ? 26 : Math.round(72 * tier);
    const rng = this.fx.rng;

    for (const kind of DEBRIS_KINDS) {
      const cap = kind === 'brass' ? Math.max(12, Math.round(base * 0.5)) : base;
      const geo = this._geometry(kind, rng);
      const mat = this._material(kind);
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.name = `fx.debris.${kind}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = kind === 'brass';
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Per-piece albedo variation: a wall of identically coloured chips is as
      // flat-looking as a single-colour material.
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

      const items = [];
      for (let i = 0; i < cap; i++) {
        items.push({
          live: false,
          settled: false,
          bounces: 0,
          t: 0,
          life: 4,
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          quat: new THREE.Quaternion(),
          spin: new THREE.Vector3(),
          scale: new THREE.Vector3(1, 1, 1),
          rest: 0.2,
          fric: 0.7,
          kind,
          ping: false,
          check: 0,
          reveal: 0,
        });
      }
      // Park every slot at zero scale. InstancedMesh always draws `count`
      // instances, so a slot that has never been written — or one that has just
      // died — would otherwise leave a frozen chip hanging in mid-air.
      _s.set(0, 0, 0);
      _m.compose(_v.set(0, -9999, 0), _q.identity(), _s);
      for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _m);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = cap;
      this.groups.push({ kind, mesh, items, cap, dirty: true });
    }
  }

  _geometry(kind, rng) {
    if (kind === 'rock') {
      // A jittered icosahedron: convex, faceted, and it never reads as a cube.
      const g = new THREE.IcosahedronGeometry(0.5, 0);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const k = 0.62 + rng() * 0.72;
        p.setXYZ(i, p.getX(i) * k, p.getY(i) * (0.5 + rng() * 0.8), p.getZ(i) * k);
      }
      g.computeVertexNormals();
      return g;
    }
    if (kind === 'splinter') {
      const g = new THREE.BoxGeometry(1, 0.17, 0.24, 1, 1, 1);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        // Taper towards +x so a splinter has a point, and rough the faces up.
        const t = p.getX(i) > 0 ? 0.25 : 1.0;
        p.setXYZ(i, p.getX(i), p.getY(i) * t * (0.8 + rng() * 0.4), p.getZ(i) * t * (0.8 + rng() * 0.4));
      }
      g.computeVertexNormals();
      return g;
    }
    if (kind === 'shard') {
      const g = new THREE.BufferGeometry();
      const v = new Float32Array([
        0, 0, 0.5, -0.34, 0, -0.5, 0.3, 0, -0.42,
        0, 0.05, 0.5, -0.34, 0.05, -0.5, 0.3, 0.05, -0.42,
      ]);
      g.setAttribute('position', new THREE.BufferAttribute(v, 3));
      g.setIndex([0, 1, 2, 5, 4, 3, 0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5, 2, 5, 0, 0, 5, 3]);
      g.computeVertexNormals();
      return g;
    }
    // brass: a short tapered case with a rim
    const g = new THREE.CylinderGeometry(0.42, 0.5, 1, 10, 1, false);
    g.rotateZ(Math.PI * 0.5); // lay it along +x so spin looks like tumbling
    return g;
  }

  _material(kind) {
    const common = { flatShading: true, dithering: true };
    if (kind === 'brass') {
      return new THREE.MeshStandardMaterial({
        name: 'fx.debris.brass',
        color: 0xb9924a,
        metalness: 0.95,
        roughness: 0.29,
        envMapIntensity: 1.2,
        ...common,
      });
    }
    if (kind === 'shard') {
      return new THREE.MeshStandardMaterial({
        name: 'fx.debris.shard',
        color: 0xcfe2e8,
        metalness: 0.08,
        roughness: 0.06,
        envMapIntensity: 1.5,
        transparent: true,
        opacity: 0.82,
        ...common,
      });
    }
    if (kind === 'splinter') {
      return new THREE.MeshStandardMaterial({
        name: 'fx.debris.splinter',
        color: 0x9a7448,
        metalness: 0,
        roughness: 0.86,
        ...common,
      });
    }
    return new THREE.MeshStandardMaterial({
      name: 'fx.debris.rock',
      color: 0x9d968c,
      metalness: 0,
      roughness: 0.94,
      ...common,
    });
  }

  group(kind) {
    return this.groups.find((g) => g.kind === kind) || this.groups[0];
  }

  /**
   * @param {string} kind rock|splinter|shard|brass
   * @param {object} o {x,y,z, vx,vy,vz, size, life, rest, fric, color, spin}
   */
  add(kind, o) {
    const g = this.group(kind);
    if (!g) return null;
    let it = null;
    for (const c of g.items) {
      if (!c.live) {
        it = c;
        break;
      }
    }
    if (!it) {
      // Recycle the oldest settled piece before an airborne one.
      let best = null;
      for (const c of g.items) if (c.settled && (!best || c.t > best.t)) best = c;
      it = best || g.items[0];
    }
    const rng = this.fx.rng;
    it.live = true;
    it.settled = false;
    it.bounces = 0;
    it.t = 0;
    it.life = o.life ?? 6;
    it.pos.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    it.vel.set(o.vx ?? 0, o.vy ?? 0, o.vz ?? 0);
    it.quat.set(rng() - 0.5, rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
    const sp = o.spin ?? 22;
    it.spin.set((rng() - 0.5) * sp, (rng() - 0.5) * sp, (rng() - 0.5) * sp);
    const sz = o.size ?? 0.03;
    if (kind === 'splinter') it.scale.set(sz * 3.4, sz, sz);
    else if (kind === 'shard') it.scale.set(sz * 2.0, sz * 0.5, sz * 2.0);
    else if (kind === 'brass') it.scale.set(sz * 2.6, sz, sz);
    else it.scale.set(sz * (0.7 + rng() * 0.6), sz * (0.7 + rng() * 0.6), sz * (0.7 + rng() * 0.6));
    it.rest = o.rest ?? 0.22;
    it.fric = o.fric ?? 0.62;
    it.ping = kind === 'brass';
    it.check = 0;
    it.reveal = o.reveal ?? 0;

    if (o.color !== undefined) {
      _c.set(o.color);
      const j = 0.78 + rng() * 0.44;
      const idx = g.items.indexOf(it);
      g.mesh.instanceColor.setXYZ(idx, _c.r * j, _c.g * j, _c.b * j);
      g.mesh.instanceColor.needsUpdate = true;
    }
    g.dirty = true;
    return it;
  }

  update(dt) {
    const phys = this.ctx.physics;
    const mask = phys?.GROUP ? phys.GROUP.WORLD | phys.GROUP.PROP : 1 | 8;
    let live = 0;

    for (const g of this.groups) {
      let any = false;
      for (let i = 0; i < g.items.length; i++) {
        const it = g.items[i];
        if (!it.live) continue;
        any = true;
        it.t += dt;
        if (it.t >= it.life) {
          it.live = false;
          this._park(g, i);
          continue;
        }

        if (!it.settled) {
          it.vel.y -= 9.81 * dt;
          const drag = Math.exp(-1.1 * dt);
          it.vel.multiplyScalar(drag);

          const step = _d.copy(it.vel).multiplyScalar(dt);
          const dist = step.length();

          // Cheap collision: one ray along this frame's travel. Slow pieces only
          // get checked every few frames — settled gravel does not need 60 Hz.
          it.check -= 1;
          if (dist > 1e-4 && (it.check <= 0 || dist > 0.05) && typeof phys?.raycast === 'function') {
            it.check = dist > 0.25 ? 0 : 3;
            const hit = phys.raycast(it.pos, _v.copy(step).multiplyScalar(1 / dist), dist + 0.02, mask);
            if (hit && hit.point) {
              this._bounce(it, hit, dt);
              this._write(g, i, it);
              live++;
              continue;
            }
          }
          it.pos.add(step);

          const ang = it.spin.length() * dt;
          if (ang > 1e-5) {
            _q.setFromAxisAngle(_v.copy(it.spin).multiplyScalar(1 / it.spin.length()), ang);
            it.quat.premultiply(_q).normalize();
          }
          it.spin.multiplyScalar(Math.exp(-0.6 * dt));
        }

        this._write(g, i, it);
        live++;
      }
      if (any || g.dirty) {
        g.mesh.instanceMatrix.needsUpdate = true;
        g.dirty = false;
      }
    }
    this.live = live;
  }

  _bounce(it, hit, dt) {
    const nrm = _n.copy(hit.normal);
    const vn = it.vel.dot(nrm);
    it.pos.copy(hit.point).addScaledVector(nrm, 0.006);

    const def = this.ctx.materials?.surfaceOf?.(hit.surface || hit.material || hit.body?.surface);
    const rest = clamp((def?.restitution ?? it.rest) * (it.kind === 'brass' ? 1.6 : 1), 0.02, 0.6);
    const fric = clamp(def?.friction ?? it.fric, 0.1, 1.2);

    // Split into normal / tangential, reflect one and scrub the other.
    _v.copy(nrm).multiplyScalar(vn);
    it.vel.sub(_v); // tangential
    it.vel.multiplyScalar(1 - clamp01(fric * 0.55));
    it.vel.addScaledVector(nrm, -vn * rest);
    it.spin.multiplyScalar(0.45);
    it.bounces++;

    if (it.ping && it.bounces === 1 && Math.abs(vn) > 0.7) {
      try {
        this.ctx.audio?.play?.('brass_bounce', {
          position: it.pos,
          volume: clamp01(Math.abs(vn) * 0.22),
          surface: def?.surface,
        });
      } catch {
        /* audio is optional */
      }
      // A casing hitting concrete kicks a wisp of dust off the floor.
      if ((def?.surface === 'concrete' || def?.surface === 'dirt') && this.fx.density > 0.5) {
        this.fx.burst('dust', {
          x: it.pos.x,
          y: it.pos.y + 0.01,
          z: it.pos.z,
          dx: nrm.x,
          dy: nrm.y,
          dz: nrm.z,
          count: 2,
          cone: 0.9,
          speed: 0.35,
          life: 0.5,
          size0: 0.02,
          size1: 0.09,
          r: 0.6,
          g: 0.57,
          b: 0.52,
        });
      }
    }

    if (it.vel.lengthSq() < 0.36 || it.bounces > 4) {
      // Settle flat on the surface it landed on. Debris standing on end reads
      // wrong immediately; real fragments lie down.
      it.settled = true;
      it.vel.set(0, 0, 0);
      it.spin.set(0, 0, 0);
      _q.setFromUnitVectors(_up, nrm);
      it.quat.copy(_q).multiply(
        _q.setFromAxisAngle(_up, this.fx.rng() * Math.PI * 2)
      );
      it.pos.copy(hit.point).addScaledVector(nrm, it.scale.y * 0.5 + 0.002);
      it.life = Math.min(it.life, it.t + (it.kind === 'brass' ? 22 : 14));
    }
  }

  _write(g, i, it) {
    // Shrink away over the last half second instead of popping out of existence,
    // and stay invisible until `reveal` (see Impacts.brass).
    const remain = it.life - it.t;
    let k = remain < 0.5 ? clamp01(remain / 0.5) : 1;
    if (it.t < it.reveal) k = 0;
    _s.copy(it.scale).multiplyScalar(k);
    _m.compose(it.pos, it.quat, _s);
    g.mesh.setMatrixAt(i, _m);
  }

  /** Collapse a slot to nothing so a dead instance leaves no ghost behind. */
  _park(g, i) {
    _s.set(0, 0, 0);
    _m.compose(_v.set(0, -9999, 0), _q.identity(), _s);
    g.mesh.setMatrixAt(i, _m);
    g.dirty = true;
  }

  clear() {
    for (const g of this.groups) {
      for (let i = 0; i < g.items.length; i++) {
        g.items[i].live = false;
        this._park(g, i);
      }
      g.mesh.instanceMatrix.needsUpdate = true;
    }
    this.live = 0;
  }

  objects() {
    return this.groups.map((g) => g.mesh);
  }

  dispose() {
    for (const g of this.groups) {
      g.mesh.parent?.remove(g.mesh);
      g.mesh.geometry.dispose();
      g.mesh.material.dispose();
      g.mesh.dispose?.();
    }
    this.groups.length = 0;
  }
}

/* ══════════════════════════════════════════════════════════════════ impacts ══ */

export class Impacts {
  constructor(ctx, fx) {
    this.ctx = ctx;
    this.fx = fx;
    this.debris = new Debris(ctx, fx);
    this._brassDelay = [];
  }

  init() {
    this.debris.init();
  }

  objects() {
    return this.debris.objects();
  }

  get debrisLive() {
    return this.debris.live;
  }

  /** Build an orthonormal frame around the surface normal. */
  _frame(normal) {
    _n.copy(normal && Number.isFinite(normal.x) ? normal : _up).normalize();
    if (_n.lengthSq() < 0.5) _n.copy(_up);
    _t1.set(1, 0, 0);
    if (Math.abs(_n.x) > 0.85) _t1.set(0, 1, 0);
    _t1.crossVectors(_n, _t1).normalize();
    _t2.crossVectors(_n, _t1).normalize();
  }

  /**
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3|null} normal
   * @param {object} opts {surface, material, energy, dir, entity, exit}
   */
  impact(point, normal, opts) {
    const M = this.ctx.materials;
    const def = M?.surfaceOf ? M.surfaceOf(opts.material || opts.def || opts.surface || 'concrete') : null;
    const tag = def?.surface || opts.surface || 'concrete';
    const energy = clamp(opts.energy ?? 1400, 60, 6000);
    // A 5.56 at the muzzle is ~1700 J; scale everything off that so a spent round
    // at 300 m makes a puff and a fresh one at 5 m tears a chunk out.
    const power = clamp(Math.pow(energy / 1600, 0.65), 0.25, 2.2);
    const dens = this.fx.density;
    if (dens <= 0) return false;

    this._frame(normal);
    const nx = _n.x;
    const ny = _n.y;
    const nz = _n.z;
    const px = point.x + nx * 0.02;
    const py = point.y + ny * 0.02;
    const pz = point.z + nz * 0.02;

    _c.setHex(def?.impactColor ?? 0xb2aca2);
    const cr = _c.r;
    const cg = _c.g;
    const cb = _c.b;

    const smokeK = (def?.impactSmoke ?? 0.7) * (opts.exit ? 1.35 : 1);
    const sparkK = def?.impactSpark ?? 0.05;
    const debrisK = (def?.impactDebris ?? 0.6) * (opts.exit ? 0.6 : 1);

    switch (tag) {
      case 'metal':
        this._metal(px, py, pz, power, sparkK, smokeK, opts);
        break;
      case 'wood':
        this._wood(px, py, pz, power, debrisK, smokeK, cr, cg, cb);
        break;
      case 'glass':
      case 'ceramic':
        this._glass(px, py, pz, power, debrisK, tag, cr, cg, cb);
        break;
      case 'water':
        this._water(px, py, pz, power);
        break;
      case 'flesh':
        this._flesh(px, py, pz, power, opts);
        break;
      case 'foliage':
        this._foliage(px, py, pz, power, cr, cg, cb);
        break;
      case 'dirt':
      case 'sand':
      case 'grass':
      case 'snow':
        this._soil(px, py, pz, power, smokeK, debrisK, cr, cg, cb, tag);
        break;
      case 'fabric':
        this._fabric(px, py, pz, power, cr, cg, cb);
        break;
      default:
        this._masonry(px, py, pz, power, smokeK, debrisK, sparkK, cr, cg, cb);
        break;
    }
    return true;
  }

  /* ---- per-surface recipes ------------------------------------------------ */

  _masonry(x, y, z, p, smokeK, debrisK, sparkK, r, g, b) {
    // The dust column: a fast thin jet straight out of the hole, then a slower
    // billow that hangs. Two scales is what makes it read as pulverised material
    // rather than a puff of steam.
    this.fx.burst('dust', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(7 * smokeK * p),
      cone: 0.42, speed: 4.2 * p, speedVar: 0.6, spread: 0.03,
      life: 0.62, lifeVar: 0.4,
      size0: 0.04, size1: 0.34 * (0.7 + smokeK * 0.5), sizeVar: 0.4,
      spin: 2.2, r, g, b, shadeVar: 0.3,
    });
    this.fx.burst('smoke_puff', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(3 * smokeK * p),
      cone: 0.85, speed: 1.1, speedVar: 0.6, spread: 0.05,
      life: 1.5, lifeVar: 0.4,
      size0: 0.09, size1: 0.62, sizeVar: 0.4,
      r: r * 1.05, g: g * 1.05, b: b * 1.05, shadeVar: 0.25,
    });
    // A brief ring of hot grit — concrete does spark, just not like steel.
    if (sparkK > 0.01) {
      this.fx.burst('spark', {
        x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
        count: Math.round(5 * sparkK * 8 * p), cone: 1.15, speed: 5.5, speedVar: 0.8,
        life: 0.16, lifeVar: 0.6, size0: 0.012, size1: 0.003,
        r: 5.0, g: 2.2, b: 0.7,
      });
    }
    this.fx.burst('ring', {
      x: x + _n.x * 0.01, y: y + _n.y * 0.01, z: z + _n.z * 0.01,
      count: 1, speed: 0, life: 0.13,
      size0: 0.10 * p, size1: 0.55 * p, ignoreDensity: true,
      r: 1.6 * r, g: 1.3 * g, b: 0.9 * b,
    });
    this._chips('rock', x, y, z, Math.round(4 * debrisK * p), 0.012, 4.5 * p, 0x8f8a82);
  }

  _metal(x, y, z, p, sparkK, smokeK, opts) {
    // Sparks come off along the reflected incoming direction, not the normal —
    // that asymmetry is the single most recognisable thing about a steel hit.
    const dir = opts.dir && Number.isFinite(opts.dir.x) ? _d.copy(opts.dir).normalize() : _d.copy(_n).negate();
    const dot = dir.dot(_n);
    _v.copy(dir).addScaledVector(_n, -2 * dot).normalize();
    const mx = (_v.x + _n.x * 0.6) * 0.62;
    const my = (_v.y + _n.y * 0.6) * 0.62;
    const mz = (_v.z + _n.z * 0.6) * 0.62;

    this.fx.burst('spark', {
      x, y, z, dx: mx, dy: my, dz: mz,
      count: Math.round(20 * sparkK * p), cone: 0.55, speed: 11 * p, speedVar: 0.85,
      spread: 0.012, life: 0.34, lifeVar: 0.7,
      size0: 0.016, size1: 0.004, sizeVar: 0.5,
      r: 7.0, g: 3.1, b: 0.85,
    });
    this.fx.burst('ember', {
      x, y, z, dx: mx, dy: my, dz: mz,
      count: Math.round(6 * sparkK * p), cone: 0.9, speed: 4.5, speedVar: 0.9,
      life: 0.85, lifeVar: 0.6, size0: 0.010, size1: 0.002,
      r: 4.2, g: 1.5, b: 0.35,
    });
    // Bouncing sparks with real collisions: a handful of hot fragments that skip
    // off the floor. Cheap, and it sells the hardness of the surface.
    const nb = Math.round(3 * sparkK * this.fx.density);
    for (let i = 0; i < nb; i++) {
      const rng = this.fx.rng;
      this.debris.add('rock', {
        x, y, z,
        vx: mx * 7 + (rng() - 0.5) * 5,
        vy: my * 7 + rng() * 3.5,
        vz: mz * 7 + (rng() - 0.5) * 5,
        size: 0.006, life: 1.6, rest: 0.42, color: 0x2a2622, spin: 40,
      });
    }
    this.fx.burst('smoke_puff', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.max(1, Math.round(2 * smokeK * 4)), cone: 0.8, speed: 1.4,
      life: 0.6, lifeVar: 0.4, size0: 0.04, size1: 0.24,
      r: 0.34, g: 0.33, b: 0.32, shadeVar: 0.2,
    });
    this.fx.burst('glow', {
      x: x + _n.x * 0.01, y: y + _n.y * 0.01, z: z + _n.z * 0.01,
      count: 1, speed: 0, life: 0.07, size0: 0.10 * p, size1: 0.03,
      ignoreDensity: true, r: 6.0, g: 3.4, b: 1.2,
    });
    if (this.fx.density > 0.5) {
      this.fx.light({ x, y, z, intensity: 9 * p, radius: 3.2, kelvin: 2600, life: 0.06, curve: 3 });
    }
  }

  _wood(x, y, z, p, debrisK, smokeK, r, g, b) {
    this.fx.burst('fleck', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(9 * debrisK * p), cone: 0.6, speed: 5.5, speedVar: 0.8,
      life: 0.9, lifeVar: 0.5, size0: 0.028, size1: 0.022, sizeVar: 0.5,
      spin: 9, r: r * 1.2, g: g * 1.15, b: b * 1.1, shadeVar: 0.4,
    });
    this.fx.burst('dust', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(4 * smokeK * p), cone: 0.6, speed: 2.4, speedVar: 0.6,
      life: 0.75, lifeVar: 0.4, size0: 0.04, size1: 0.26,
      r: r * 1.3, g: g * 1.25, b: b * 1.2, shadeVar: 0.3,
    });
    this._chips('splinter', x, y, z, Math.round(4 * debrisK * p), 0.010, 5.5 * p, 0x8f6c42);
  }

  _glass(x, y, z, p, debrisK, tag, r, g, b) {
    const glass = tag === 'glass';
    this.fx.burst('spark', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(14 * debrisK * p), cone: 0.85, speed: 6.5, speedVar: 0.9,
      life: 0.5, lifeVar: 0.6, size0: 0.012, size1: 0.004,
      r: glass ? 1.9 : 1.5, g: glass ? 2.2 : 1.45, b: glass ? 2.6 : 1.35,
    });
    this.fx.burst('dust', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: glass ? 2 : Math.round(5 * p), cone: 0.9, speed: 1.6,
      life: 0.6, size0: 0.03, size1: 0.2,
      r: r * 1.1, g: g * 1.1, b: b * 1.15, shadeVar: 0.25,
    });
    this._chips(glass ? 'shard' : 'rock', x, y, z, Math.round(6 * debrisK * p), 0.014, 5.0 * p,
      glass ? 0xcfe4ea : 0xdcd6ca);
  }

  _soil(x, y, z, p, smokeK, debrisK, r, g, b, tag) {
    const rise = tag === 'snow' || tag === 'sand' ? 1.35 : 1;
    this.fx.burst('dust', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(9 * smokeK * p), cone: 0.5, speed: 4.6 * p, speedVar: 0.6,
      spread: 0.04, life: 0.9 * rise, lifeVar: 0.4,
      size0: 0.06, size1: 0.5 * rise, sizeVar: 0.4,
      r, g, b, shadeVar: 0.35,
    });
    this.fx.burst('smoke_puff', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(3 * smokeK * p), cone: 0.9, speed: 1.2,
      life: 1.9, lifeVar: 0.4, size0: 0.12, size1: 0.9 * rise,
      r: r * 1.1, g: g * 1.1, b: b * 1.1, shadeVar: 0.3,
    });
    this.fx.burst('fleck', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(7 * debrisK * p), cone: 0.55, speed: 5.0, speedVar: 0.8,
      life: 1.1, lifeVar: 0.5, size0: 0.022, size1: 0.018,
      spin: 8, r: r * 0.8, g: g * 0.8, b: b * 0.8, shadeVar: 0.4,
    });
    this._chips('rock', x, y, z, Math.round(3 * debrisK * p), 0.016, 4.2 * p,
      tag === 'snow' ? 0xe8eef4 : 0x6b5a44);
  }

  _water(x, y, z, p) {
    // The crown: a tight ring of droplets thrown up and out, plus a spray column.
    this.fx.burst('splash', {
      x, y, z, dx: 0, dy: 1, dz: 0,
      count: Math.round(18 * p), cone: 0.42, speed: 5.2 * p, speedVar: 0.6,
      spread: 0.02, life: 0.8, lifeVar: 0.4, size0: 0.020, size1: 0.010,
      r: 1.5, g: 1.9, b: 2.1,
    });
    this.fx.burst('splash', {
      x, y, z, dx: 0, dy: 1, dz: 0,
      count: Math.round(10 * p), cone: 0.9, speed: 2.4, speedVar: 0.8,
      life: 1.0, lifeVar: 0.5, size0: 0.012, size1: 0.006,
      r: 1.2, g: 1.6, b: 1.8,
    });
    this.fx.burst('dust', {
      x, y: y + 0.05, z, dx: 0, dy: 1, dz: 0,
      count: 4, cone: 0.7, speed: 1.4, life: 0.7,
      size0: 0.05, size1: 0.34, r: 1.05, g: 1.15, b: 1.2, shadeVar: 0.15,
    });
    // The surface ring, laid flat by giving it almost no size growth in Y.
    this.fx.burst('ring', {
      x, y: y + 0.015, z, count: 1, speed: 0, life: 0.55,
      size0: 0.12 * p, size1: 1.1 * p, ignoreDensity: true,
      r: 0.9, g: 1.25, b: 1.35,
    });
    try {
      this.ctx.decals?.add?.({ point: { x, y, z }, normal: _up, type: 'ripple', size: 0.6 });
    } catch {
      /* decals are optional */
    }
  }

  _flesh(x, y, z, p, opts) {
    const dir = opts.dir && Number.isFinite(opts.dir.x) ? _d.copy(opts.dir).normalize() : _d.copy(_n).negate();
    // Fine mist sprays *with* the round, heavy droplets fall back out of the wound.
    this.fx.burst('blood', {
      x, y, z, dx: dir.x, dy: dir.y + 0.15, dz: dir.z,
      count: Math.round(12 * p), cone: 0.55, speed: 3.6, speedVar: 0.7,
      spread: 0.025, life: 0.55, lifeVar: 0.5,
      size0: 0.035, size1: 0.16, sizeVar: 0.5,
      r: 0.34, g: 0.030, b: 0.022, shadeVar: 0.35,
    });
    this.fx.burst('blood', {
      x, y, z, dx: -_n.x, dy: -_n.y + 0.4, dz: -_n.z,
      count: Math.round(6 * p), cone: 0.8, speed: 1.6, speedVar: 0.8,
      life: 0.85, size0: 0.012, size1: 0.03,
      r: 0.20, g: 0.014, b: 0.012, shadeVar: 0.3,
    });
  }

  _foliage(x, y, z, p, r, g, b) {
    this.fx.burst('leaf', {
      x, y, z, dx: -_n.x, dy: 0.3, dz: -_n.z,
      count: Math.round(7 * p), cone: 1.0, speed: 2.6, speedVar: 0.8,
      life: 2.4, lifeVar: 0.5, size0: 0.045, size1: 0.045, sizeVar: 0.5,
      spin: 5, r: r * 1.3, g: g * 1.3, b: b * 1.3, shadeVar: 0.4,
    });
  }

  _fabric(x, y, z, p, r, g, b) {
    this.fx.burst('dust', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(5 * p), cone: 0.7, speed: 2.0, life: 0.7,
      size0: 0.03, size1: 0.2, r: r * 1.2, g: g * 1.2, b: b * 1.2, shadeVar: 0.3,
    });
    this.fx.burst('fleck', {
      x, y, z, dx: _n.x, dy: _n.y, dz: _n.z,
      count: Math.round(4 * p), cone: 0.8, speed: 2.6,
      life: 0.8, size0: 0.012, size1: 0.010, r, g, b,
    });
  }

  _chips(kind, x, y, z, count, size, speed, color) {
    const n = Math.round(count * this.fx.density);
    const rng = this.fx.rng;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * 0.75;
      const dx = _n.x + (_t1.x * Math.cos(a) + _t2.x * Math.sin(a)) * rr;
      const dy = _n.y + (_t1.y * Math.cos(a) + _t2.y * Math.sin(a)) * rr;
      const dz = _n.z + (_t1.z * Math.cos(a) + _t2.z * Math.sin(a)) * rr;
      const sp = speed * (0.45 + rng() * 0.9);
      this.debris.add(kind, {
        x, y, z,
        vx: dx * sp, vy: dy * sp + rng() * 1.4, vz: dz * sp,
        size: size * (0.6 + rng() * 0.9),
        life: 5 + rng() * 5,
        color,
        spin: 26,
      });
    }
  }

  /* ---- extra hooks -------------------------------------------------------- */

  ricochet(e) {
    if (!e?.point) return;
    const d = e.dirOut || e.normal;
    if (!d) return;
    this.fx.burst('spark', {
      x: e.point.x, y: e.point.y, z: e.point.z,
      dx: d.x, dy: d.y, dz: d.z,
      count: 8, cone: 0.35, speed: 13, speedVar: 0.7,
      life: 0.3, lifeVar: 0.6, size0: 0.014, size1: 0.003,
      r: 6.5, g: 2.8, b: 0.8,
    });
  }

  flesh(e) {
    if (!e?.point || e.surface === 'none') return;
    // Only the wound spray; the main impact path already ran for the surface.
    if (e.hitbox === 'head') {
      this.fx.burst('blood', {
        x: e.point.x, y: e.point.y, z: e.point.z,
        dx: e.dir?.x ?? 0, dy: (e.dir?.y ?? 0) + 0.4, dz: e.dir?.z ?? 0,
        count: 10, cone: 0.7, speed: 4.2, speedVar: 0.7,
        life: 0.6, size0: 0.05, size1: 0.24,
        r: 0.36, g: 0.032, b: 0.024, shadeVar: 0.3,
      });
    }
  }

  land(e) {
    const speed = Math.abs(e?.impactSpeed ?? 0);
    if (speed < 4) return;
    const p = this.ctx.player?.position || this.ctx.camera?.position;
    if (!p) return;
    const k = clamp01((speed - 4) / 8);
    const y = (this.ctx.level?.groundY?.(p.x, p.z) ?? p.y - 1.7) + 0.02;
    _n.set(0, 1, 0);
    _t1.set(1, 0, 0);
    _t2.set(0, 0, 1);
    this.fx.burst('dust', {
      x: p.x, y, z: p.z, dx: 0, dy: 1, dz: 0,
      count: Math.round(8 * k), cone: 1.4, speed: 1.8 * k + 0.6, speedVar: 0.6,
      spread: 0.22, life: 0.9, lifeVar: 0.4,
      size0: 0.10, size1: 0.55, sizeVar: 0.4,
      r: 0.52, g: 0.48, b: 0.42, shadeVar: 0.3,
    });
  }

  /** A heavy prop hitting the ground kicks dust too. */
  debrisImpact(e) {
    if (!e?.point || (e.speed ?? 0) < 3.5) return;
    if (this.fx.density < 0.5) return;
    const k = clamp01((e.speed - 3.5) / 8);
    this.fx.burst('dust', {
      x: e.point.x, y: e.point.y, z: e.point.z,
      dx: e.normal?.x ?? 0, dy: e.normal?.y ?? 1, dz: e.normal?.z ?? 0,
      count: Math.round(4 * k), cone: 1.2, speed: 1.2, life: 0.8,
      size0: 0.06, size1: 0.32, r: 0.5, g: 0.47, b: 0.42, shadeVar: 0.3,
    });
  }

  /* ---- brass -------------------------------------------------------------- */

  /**
   * The world casing. WeaponSystem draws its own in the viewmodel for ~1.15 s, so
   * ours stays hidden for the first half second and then takes over the arc —
   * two casings on screen at once is worse than none.
   */
  brass(position, velocity, opts = {}) {
    if (!position) return false;
    if (this.fx.density < 0.3) return false;
    const rng = this.fx.rng;
    const it = this.debris.add('brass', {
      x: position.x,
      y: position.y,
      z: position.z,
      vx: (velocity?.x ?? 1) * (0.85 + rng() * 0.3),
      vy: (velocity?.y ?? 1.5) * (0.85 + rng() * 0.3),
      vz: (velocity?.z ?? 0) * (0.85 + rng() * 0.3),
      size: opts.calibre === '7.62x51' ? 0.0072 : 0.0058,
      life: 26,
      rest: 0.34,
      fric: 0.5,
      color: 0xc39a4e,
      spin: 46,
      // The viewmodel casing owns the first half second; ours simulates the whole
      // arc but only becomes visible once theirs is out of frame.
      reveal: opts.owner === 'player' && opts.viewmodel !== false ? 0.5 : 0,
    });
    return !!it;
  }

  /* ---- explosions --------------------------------------------------------- */

  explosion(point, opts = {}) {
    const radius = clamp(opts.radius ?? 8, 1, 40);
    const kind = opts.type || 'frag';
    const dens = this.fx.density;
    const p = clamp(radius / 8, 0.4, 3);
    const x = point.x;
    const y = point.y;
    const z = point.z;
    const groundY = this.ctx.level?.groundY?.(x, z);
    const gy = Number.isFinite(groundY) ? groundY : y - 0.4;
    const nearGround = y - gy < radius * 0.35;

    // 1. The flash: one enormous, extremely short-lived core. This is what drives
    //    the bloom and the exposure dip.
    this.fx.burst('glow', {
      x, y, z, count: 1, speed: 0, life: 0.10,
      size0: 0.7 * p, size1: 3.2 * p, ignoreDensity: true,
      r: 46, g: 30, b: 13,
    });

    // 2. Fireball: black-body ramp handled in the shader, so it goes white -> yellow
    //    -> orange -> sooty over its life without any CPU colour animation.
    this.fx.burst('fire', {
      x, y, z, dx: 0, dy: 1, dz: 0,
      count: Math.round(26 * p), cone: 1.6, speed: 7.5 * p, speedVar: 0.75,
      spread: 0.3 * p, life: 0.72, lifeVar: 0.45,
      size0: 0.45 * p, size1: 2.4 * p, sizeVar: 0.4, spin: 1.6,
      r: 1, g: 1, b: 1,
    });

    // 3. Smoke column, born hot and dark, cooling as it climbs.
    this.fx.burst('smoke_soft', {
      x, y: y + 0.2 * p, z, dx: 0, dy: 1, dz: 0,
      count: Math.round(16 * p), cone: 1.3, speed: 4.2 * p, speedVar: 0.7,
      spread: 0.45 * p, life: 3.4, lifeVar: 0.4,
      size0: 0.6 * p, size1: 4.0 * p, sizeVar: 0.4, spin: 0.7,
      r: 0.11, g: 0.10, b: 0.095, shadeVar: 0.45,
    });

    // 4. The dust wave: a ring of ground-hugging billows racing outward. Without
    //    it an explosion looks like it happened in mid-air.
    if (nearGround) {
      const n = Math.round(16 * p * dens);
      const rng = this.fx.rng;
      for (let i = 0; i < n; i++) {
        const a = (i / Math.max(1, n)) * Math.PI * 2 + rng() * 0.3;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const r0 = radius * (0.12 + rng() * 0.12);
        this.fx.particles.spawn(TYPE.dust_wave, {
          px: x + ca * r0,
          py: gy + 0.15 + rng() * 0.4,
          pz: z + sa * r0,
          vx: ca * radius * (0.9 + rng() * 0.5),
          vy: 0.6 + rng() * 0.9,
          vz: sa * radius * (0.9 + rng() * 0.5),
          life: 2.6 + rng() * 1.4,
          size0: 0.5 * p,
          size1: (2.6 + rng() * 1.6) * p,
          rot: rng() * 6.28,
          rotSpeed: (rng() - 0.5) * 0.8,
          r: 0.44,
          g: 0.40,
          b: 0.34,
        });
      }
    }

    // 5. Ejecta: sparks, embers and real tumbling chunks.
    this.fx.burst('spark', {
      x, y, z, dx: 0, dy: 0.35, dz: 0,
      count: Math.round(34 * p), cone: 1.7, speed: 22 * p, speedVar: 0.85,
      life: 0.75, lifeVar: 0.7, size0: 0.03, size1: 0.006,
      r: 8, g: 3.4, b: 0.9,
    });
    this.fx.burst('ember', {
      x, y, z, dx: 0, dy: 0.5, dz: 0,
      count: Math.round(16 * p), cone: 1.6, speed: 8 * p, speedVar: 0.9,
      life: 1.8, lifeVar: 0.6, size0: 0.018, size1: 0.004,
      r: 5, g: 1.7, b: 0.4,
    });
    const chunks = Math.round(10 * p * dens);
    const rng2 = this.fx.rng;
    for (let i = 0; i < chunks; i++) {
      const a = rng2() * Math.PI * 2;
      const el = 0.25 + rng2() * 0.9;
      const sp = radius * (0.9 + rng2() * 1.4);
      this.debris.add('rock', {
        x, y: y + 0.1, z,
        vx: Math.cos(a) * sp,
        vy: el * sp,
        vz: Math.sin(a) * sp,
        size: 0.02 + rng2() * 0.045,
        life: 8 + rng2() * 6,
        color: 0x6f675d,
        spin: 40,
      });
    }

    // 6. The shock front — real refraction, not a white ring sprite.
    this.fx.distort({
      x, y, z,
      radius: radius * 0.35,
      radiusEnd: radius * 1.5,
      strength: 0.05,
      life: 0.34,
      kind: 'shock',
    });
    this.fx.burst('ring', {
      x, y, z, count: 1, speed: 0, life: 0.26,
      size0: 0.8 * p, size1: radius * 1.7, ignoreDensity: true,
      r: 3.2, g: 2.0, b: 1.0,
    });

    // 7. The light. Bright, warm, and gone in a third of a second.
    this.fx.light({
      x, y: y + 0.3, z,
      intensity: 900 * p,
      radius: Math.max(14, radius * 3),
      kelvin: 2000,
      life: 0.38,
      curve: 2.2,
    });

    try {
      this.ctx.decals?.add?.({
        point: { x, y: gy + 0.01, z },
        normal: _up,
        type: kind === 'frag' ? 'scorch' : 'scorch',
        size: radius * 0.55,
      });
    } catch {
      /* decals are optional */
    }
    return true;
  }

  /* ---- lifecycle ---------------------------------------------------------- */

  update(dt) {
    this.debris.update(dt);
  }

  clear() {
    this.debris.clear();
  }

  dispose() {
    this.debris.dispose();
  }
}

export default Impacts;
