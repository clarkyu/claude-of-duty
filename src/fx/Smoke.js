/**
 * Smoke — grenade volumes, battlefield haze and drifting dust motes.
 * Owner: FX agent. Used by FXSystem.
 *
 * ── Grenade smoke ───────────────────────────────────────────────────────────────
 * A smoke grenade is not a burst, it is a *source*. This emits continuously for
 * the whole burn, in three layers:
 *
 *   core    few, very large, slow billows that carry the mass and the opacity
 *   body    the bulk of the cloud, spawned on a growing shell around the canister
 *   fringe  small, fast, high-turbulence wisps that tear off the outside and give
 *           the silhouette something to do
 *
 * The cloud is *self-shadowed*: at spawn each particle's optical depth towards the
 * sun is estimated from where it sits inside the volume, and that pre-darkens its
 * albedo. Combined with the per-sprite wrap lighting and the forward-scattering
 * lobe in GPUParticles, the sun side of a bank glows and the far side goes cold
 * blue from the sky SH — which is what actually sells smoke as a volume rather
 * than a stack of grey cards.
 *
 * Advection comes from `ctx.materials.globals.wind` (direction, strength and the
 * live gust term), so a bank leans and shears with the same wind that is moving
 * the foliage.
 *
 * ── Ambient ─────────────────────────────────────────────────────────────────────
 * Two permanent populations, both budgeted well below the particle cap:
 *   • **haze** — a handful of enormous, nearly transparent billows sitting in the
 *     play space. They cost almost nothing and they put air between the camera
 *     and the far side of the map.
 *   • **motes** — fine dust in a box that follows the camera (the particle type
 *     wraps in the simulation shader, so they never need respawning). They are
 *     lit, so they only light up where the sun reaches them: look towards a window
 *     shaft and they sparkle, look away and they vanish. That is the effect the
 *     `interior` review pose is asking for.
 */
import * as THREE from 'three';
import { TYPE } from './GPUParticles.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Smoke {
  constructor(ctx, fx) {
    this.ctx = ctx;
    this.fx = fx;
    /** @type {Array<object>} live grenade sources */
    this.sources = [];
    this.moteTarget = 0;
    this.moteLive = 0;
    this.hazeTarget = 0;
    this.hazeLive = 0;
    this._hazeTimer = 0;
    /** When each live haze billow is due to expire, so the count stays honest. */
    this._hazeExpiry = [];
    this._bounds = null;
    this._ambientReady = false;
    this._clock = 0;
  }

  init() {
    this.setQuality(this.ctx.settings?.tier || 'high');
  }

  setQuality(tier) {
    const headless = !!this.ctx.settings?.get?.('headless');
    const k = { low: 0.35, medium: 0.65, high: 1, ultra: 1.35 }[tier] ?? 1;
    this.moteTarget = Math.round((headless ? 90 : 260) * k);
    this.hazeTarget = Math.round((headless ? 8 : 22) * k);
    this.moteLive = 0;
    this.hazeLive = 0;
    this._hazeExpiry.length = 0;
    this._ambientReady = false;
  }

  rebuildAmbient() {
    this.moteLive = 0;
    this.hazeLive = 0;
    this._hazeExpiry.length = 0;
    this._ambientReady = false;
    this._bounds = this.ctx.level?.bounds || null;
  }

  /* ------------------------------------------------------------------ grenade */

  /**
   * @param {object} o {position|point, radius, duration, color, density, rise}
   */
  grenade(o = {}) {
    const p = o.position || o.point;
    if (!p) return false;
    const pos = new THREE.Vector3(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    const src = {
      pos,
      radius: clamp(o.radius ?? 4.5, 0.8, 14),
      duration: clamp(o.duration ?? 16, 0.5, 90),
      t: 0,
      acc: 0,
      accFringe: 0,
      accCore: 0,
      rise: o.rise ?? 0.85,
      opacity: clamp01(o.density ?? 1),
      color: new THREE.Color(o.color !== undefined ? o.color : 0xd8d6d2),
      pop: o.pop !== false,
    };
    this.sources.push(src);
    if (this.sources.length > 6) this.sources.shift();

    if (src.pop) {
      // The initial charge: a fast, bright, low puff that then feeds the column.
      this.fx.burst('smoke_puff', {
        x: pos.x, y: pos.y + 0.1, z: pos.z, dx: 0, dy: 1, dz: 0,
        count: 14, cone: 1.5, speed: 4.5, speedVar: 0.7, spread: 0.25,
        life: 2.4, lifeVar: 0.4, size0: 0.3, size1: 1.9, sizeVar: 0.4,
        r: src.color.r, g: src.color.g, b: src.color.b, shadeVar: 0.3,
      });
      this.fx.burst('spark', {
        x: pos.x, y: pos.y + 0.05, z: pos.z, dx: 0, dy: 1, dz: 0,
        count: 8, cone: 1.4, speed: 5, life: 0.35, size0: 0.012, size1: 0.003,
        r: 3.5, g: 1.6, b: 0.5,
      });
    }
    return true;
  }

  /** Optical depth towards the sun, as a 0..1 shade multiplier. */
  _selfShadow(dx, dy, dz, radius) {
    const L = this.fx.globals.uSunDir.value;
    const along = dx * L.x + dy * L.y + dz * L.z;
    // Distance from this point to the far edge of the cloud along the sun ray.
    const depth = clamp01((radius - along) / (2 * radius));
    return 0.22 + 0.78 * Math.exp(-2.6 * depth);
  }

  _emitSource(src, dt) {
    const P = this.fx.particles;
    if (!P?.ready) return;
    const rng = this.fx.rng;
    const dens = this.fx.density;
    const a = clamp01(src.t / src.duration);
    // Grow to full radius over the first fifth of the burn, then hold.
    const grow = clamp01(src.t / Math.max(0.6, src.duration * 0.2));
    const R = src.radius * (0.28 + 0.72 * grow);
    // Output tapers off as the canister burns out.
    const out = (1 - Math.pow(a, 3)) * dens;
    const cr = src.color.r * src.opacity;
    const cg = src.color.g * src.opacity;
    const cb = src.color.b * src.opacity;

    // ---- body: the bulk of the volume -------------------------------------
    src.acc += 34 * out * dt;
    let n = Math.floor(src.acc);
    src.acc -= n;
    n = Math.min(n, 14);
    for (let i = 0; i < n; i++) {
      const u = rng() * Math.PI * 2;
      const cz = rng() * 2 - 1;
      const sr = Math.sqrt(Math.max(0, 1 - cz * cz));
      const rr = Math.pow(rng(), 0.42) * R;
      const dx = Math.cos(u) * sr * rr;
      const dz = Math.sin(u) * sr * rr;
      const dy = cz * rr * 0.55 + 0.25;
      const shade = this._selfShadow(dx, dy, dz, R);
      P.spawn(TYPE.smoke_soft, {
        px: src.pos.x + dx,
        py: src.pos.y + Math.max(0.05, dy),
        pz: src.pos.z + dz,
        vx: dx * 0.28 + (rng() - 0.5) * 0.35,
        vy: src.rise * (0.5 + rng() * 0.8),
        vz: dz * 0.28 + (rng() - 0.5) * 0.35,
        life: 7 + rng() * 5,
        size0: 0.9 + rng() * 0.9,
        size1: (2.4 + rng() * 2.0) * (0.7 + grow * 0.5),
        rot: rng() * 6.283,
        rotSpeed: (rng() - 0.5) * 0.34,
        r: cr * shade,
        g: cg * shade,
        b: cb * shade,
      });
    }

    // ---- core: a few very large, very slow billows -------------------------
    src.accCore += 3.5 * out * dt;
    let nc = Math.floor(src.accCore);
    src.accCore -= nc;
    nc = Math.min(nc, 3);
    for (let i = 0; i < nc; i++) {
      const u = rng() * Math.PI * 2;
      const rr = Math.pow(rng(), 0.7) * R * 0.55;
      const dx = Math.cos(u) * rr;
      const dz = Math.sin(u) * rr;
      const dy = 0.3 + rng() * R * 0.35;
      const shade = this._selfShadow(dx, dy, dz, R) * 0.9;
      P.spawn(TYPE.smoke_soft, {
        px: src.pos.x + dx,
        py: src.pos.y + dy,
        pz: src.pos.z + dz,
        vx: (rng() - 0.5) * 0.16,
        vy: src.rise * 0.45,
        vz: (rng() - 0.5) * 0.16,
        life: 11 + rng() * 6,
        size0: 2.0 + rng() * 1.2,
        size1: (4.2 + rng() * 2.4) * (0.65 + grow * 0.55),
        rot: rng() * 6.283,
        rotSpeed: (rng() - 0.5) * 0.18,
        r: cr * shade,
        g: cg * shade,
        b: cb * shade,
      });
    }

    // ---- fringe: fast little wisps tearing off the outside -----------------
    src.accFringe += 20 * out * dt;
    let nf = Math.floor(src.accFringe);
    src.accFringe -= nf;
    nf = Math.min(nf, 10);
    for (let i = 0; i < nf; i++) {
      const u = rng() * Math.PI * 2;
      const cz = rng() * 2 - 1;
      const sr = Math.sqrt(Math.max(0, 1 - cz * cz));
      const dx = Math.cos(u) * sr * R;
      const dz = Math.sin(u) * sr * R;
      const dy = cz * R * 0.6 + 0.4;
      const shade = this._selfShadow(dx, dy, dz, R) * 1.1;
      P.spawn(TYPE.smoke_puff, {
        px: src.pos.x + dx * 0.9,
        py: src.pos.y + Math.max(0.05, dy),
        pz: src.pos.z + dz * 0.9,
        vx: dx * 0.5,
        vy: src.rise * 1.4 + rng() * 0.5,
        vz: dz * 0.5,
        life: 2.6 + rng() * 2.2,
        size0: 0.32 + rng() * 0.4,
        size1: 1.2 + rng() * 1.1,
        rot: rng() * 6.283,
        rotSpeed: (rng() - 0.5) * 1.1,
        r: cr * shade,
        g: cg * shade,
        b: cb * shade,
      });
    }
  }

  /* ------------------------------------------------------------------ ambient */

  _topUpMotes(camera) {
    const P = this.fx.particles;
    if (!P?.ready || !camera) return;
    const want = this.moteTarget;
    if (this.moteLive >= want) return;
    const rng = this.fx.rng;
    // Trickle the population in so a pose change does not spike a whole frame.
    const n = Math.min(28, want - this.moteLive);
    const R = 7; // must match the mote type's wrap radius
    for (let i = 0; i < n; i++) {
      const px = camera.position.x + (rng() * 2 - 1) * R;
      const py = camera.position.y + (rng() * 2 - 1) * R;
      const pz = camera.position.z + (rng() * 2 - 1) * R;
      const bright = 0.35 + rng() * 1.5;
      if (
        P.spawn(TYPE.mote, {
          px,
          py,
          pz,
          vx: (rng() - 0.5) * 0.09,
          vy: (rng() - 0.5) * 0.045,
          vz: (rng() - 0.5) * 0.09,
          life: 1e8,
          size0: 0.006 + rng() * 0.017,
          size1: 0.006 + rng() * 0.017,
          rot: rng() * 6.283,
          rotSpeed: 0,
          r: 1.05 * bright,
          g: 1.0 * bright,
          b: 0.92 * bright,
        })
      ) {
        this.moteLive++;
      } else {
        break;
      }
    }
  }

  _topUpHaze(dt, camera) {
    const P = this.fx.particles;
    if (!P?.ready || !camera) return;
    this._hazeTimer -= dt;
    if (this.hazeLive >= this.hazeTarget && this._hazeTimer > 0) return;
    this._hazeTimer = 1.5;

    const b = this._bounds || this.ctx.level?.bounds;
    const rng = this.fx.rng;
    const n = Math.min(4, Math.max(0, this.hazeTarget - this.hazeLive));
    for (let i = 0; i < n; i++) {
      let x;
      let y;
      let z;
      if (b && Number.isFinite(b.min?.x)) {
        x = b.min.x + rng() * (b.max.x - b.min.x);
        z = b.min.z + rng() * (b.max.z - b.min.z);
        y = b.min.y + 1.0 + rng() * Math.min(14, Math.max(3, (b.max.y - b.min.y) * 0.5));
      } else {
        x = camera.position.x + (rng() * 2 - 1) * 45;
        z = camera.position.z + (rng() * 2 - 1) * 45;
        y = camera.position.y + rng() * 8 - 1;
      }
      const life = 26 + rng() * 22;
      const tint = 0.55 + rng() * 0.35;
      if (
        P.spawn(TYPE.haze, {
          px: x,
          py: y,
          pz: z,
          vx: (rng() - 0.5) * 0.12,
          vy: 0.012,
          vz: (rng() - 0.5) * 0.12,
          life,
          size0: 9 + rng() * 10,
          size1: 16 + rng() * 16,
          rot: rng() * 6.283,
          rotSpeed: (rng() - 0.5) * 0.02,
          r: 0.30 * tint,
          g: 0.31 * tint,
          b: 0.33 * tint,
        })
      ) {
        this.hazeLive++;
        this._hazeExpiry.push(this._clock + life);
      } else {
        break;
      }
    }
  }

  /* ---------------------------------------------------------------- lifecycle */

  update(dt) {
    this._clock += dt;
    // Haze dies inside the GPU sim; the CPU only needs to know when to top up.
    const ex = this._hazeExpiry;
    while (ex.length && ex[0] <= this._clock) {
      ex.shift();
      this.hazeLive = Math.max(0, this.hazeLive - 1);
    }
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const s = this.sources[i];
      s.t += dt;
      // Keep emitting a little past the burn so the tail is not a hard cut.
      if (s.t > s.duration * 1.05) {
        this.sources.splice(i, 1);
        continue;
      }
      this._emitSource(s, dt);
    }
  }

  lateUpdate(dt, camera) {
    if (!this._ambientReady) {
      this._bounds = this.ctx.level?.bounds || this._bounds;
      this._ambientReady = true;
    }
    this._topUpMotes(camera);
    this._topUpHaze(dt, camera);
  }

  clear() {
    this.sources.length = 0;
    this.moteLive = 0;
    this.hazeLive = 0;
    this._hazeExpiry.length = 0;
    this._hazeTimer = 0;
  }

  dispose() {
    this.sources.length = 0;
    this._hazeExpiry.length = 0;
  }
}

export default Smoke;
