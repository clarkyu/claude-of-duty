/**
 * MuzzleFlash — the flash, the gas, the light. Owner: FX agent.
 * Used by FXSystem; never instantiated anywhere else.
 *
 * A muzzle flash is not one sprite. Firing one round puts five different things
 * on screen inside 60 ms, and leaving any of them out is instantly readable:
 *
 *   1. **Petals** — 3-6 additive cards with a lopsided star silhouette, each with
 *      its own randomised rotation, aspect and scale from `ctx.rng`. The shape is
 *      re-rolled every shot, so full-auto never degenerates into a looping sprite.
 *   2. **Bore glow** — a small, very bright radial core anchored at the crown,
 *      the part that actually drives the bloom.
 *   3. **Hot gas** — a fast-expanding, lit smoke puff plus unburnt powder sparks
 *      thrown down the bore, both simulated in the GPU particle system so they
 *      keep drifting on the wind after the flash is gone.
 *   4. **Refraction** — a short-lived distortion lens: the air in front of a
 *      muzzle genuinely bends the wall behind it.
 *   5. **A real light.** `ctx.lighting.addLight()` with a ~3-frame decay. This is
 *      the difference between "a bright sprite" and "the room lit up".
 *
 * The cards live in `ctx.viewScene` so they stay welded to the viewmodel, which
 * is rendered at its own narrower FOV. The world-space particles are emitted at
 * an FOV-corrected position (`_alignToView`) so the smoke leaves the barrel where
 * the barrel *looks* like it is, not where it mathematically is.
 *
 * Profiles come from the fitted muzzle device (`brake`, `comp`, `thread`,
 * suppressor) so a compensator vents up, a brake vents wide and a can barely
 * flashes at all.
 */
import * as THREE from 'three';
import { TYPE } from './GPUParticles.js';

const MAX_FLASH = 6;
const PETALS = 6;

/**
 * Per-device behaviour. `lobe` biases petal direction: x wide, y up.
 */
const PROFILES = {
  none: { size: 1.0, petals: 4, light: 1.0, smoke: 1.0, sparks: 1.0, lobeX: 0.55, lobeY: 0.25, life: 0.048, gas: 1.0 },
  thread: { size: 0.92, petals: 4, light: 0.95, smoke: 1.1, sparks: 0.9, lobeX: 0.5, lobeY: 0.22, life: 0.046, gas: 1.0 },
  brake: { size: 1.28, petals: 6, light: 1.35, smoke: 1.35, sparks: 1.35, lobeX: 1.25, lobeY: 0.18, life: 0.052, gas: 1.4 },
  comp: { size: 1.05, petals: 5, light: 1.1, smoke: 1.05, sparks: 1.1, lobeX: 0.4, lobeY: 0.95, life: 0.05, gas: 1.15 },
  flash_hider: { size: 0.72, petals: 3, light: 0.7, smoke: 0.9, sparks: 0.8, lobeX: 0.75, lobeY: 0.3, life: 0.04, gas: 0.9 },
  suppressor: { size: 0.30, petals: 2, light: 0.28, smoke: 2.1, sparks: 0.25, lobeX: 0.3, lobeY: 0.2, life: 0.03, gas: 1.9 },
};

// language=GLSL
const FLASH_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aQuat;      // billboard basis is built from the camera; xyz+w = pack
attribute vec4 aParams;    // width, height, rotation, brightness
attribute vec4 aTint;      // rgb, cell index
varying vec2 vUv;
varying vec3 vTint;
varying float vCell;
varying float vBright;

void main() {
	vUv = uv;
	vTint = aTint.rgb;
	vCell = aTint.w;
	vBright = aParams.w;

	vec4 mv = viewMatrix * vec4( aCenter, 1.0 );
	float c = cos( aParams.z ), s = sin( aParams.z );
	vec2 p = vec2( position.x * aParams.x, position.y * aParams.y );
	// Petals grow out of the bore, so the pivot sits at the back edge of the card.
	p.y += aParams.y * aQuat.w * 0.5;
	mv.xy += vec2( p.x * c - p.y * s, p.x * s + p.y * c );
	gl_Position = projectionMatrix * mv;
}
`;

// language=GLSL
const FLASH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tAtlas;
varying vec2 vUv;
varying vec3 vTint;
varying float vCell;
varying float vBright;

void main() {
	if ( vBright <= 0.0 ) discard;
	vec2 cell = vec2( mod( vCell, 4.0 ), floor( vCell / 4.0 ) );
	vec2 uv = ( cell + clamp( vUv, 0.004, 0.996 ) ) * 0.25;
	float d = texture2D( tAtlas, uv ).r;
	if ( d <= 0.003 ) discard;
	// Squared falloff keeps the core searing while the fringe stays thin — a
	// linear ramp reads as a fuzzy blob rather than burning gas.
	float a = d * d * vBright;
	gl_FragColor = vec4( vTint * a, 0.0 );
}
`;

const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

export class MuzzleFlash {
  constructor(ctx, fx) {
    this.ctx = ctx;
    this.fx = fx;
    this.liveCount = 0;
    this.slots = [];
    this.viewGroup = null;
    this.worldGroup = null;
    this._tookOver = false;
    this._takeoverTries = 0;
  }

  init() {
    const cap = MAX_FLASH * (PETALS + 1);
    this.cap = cap;
    this.aCenter = new Float32Array(cap * 3);
    this.aQuat = new Float32Array(cap * 4);
    this.aParams = new Float32Array(cap * 4);
    this.aTint = new Float32Array(cap * 4);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(this.aCenter, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aQuat', new THREE.InstancedBufferAttribute(this.aQuat, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(this.aParams, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.aTint, 4).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geometry = g;

    this.material = new THREE.ShaderMaterial({
      name: 'fx:muzzleFlash',
      uniforms: { tAtlas: { value: this.fx.particles?.atlas || null } },
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      transparent: true,
      depthTest: false, // the flash owns the muzzle: never clipped by the barrel
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx.muzzleFlash';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;

    this.viewGroup = new THREE.Group();
    this.viewGroup.name = 'fx.muzzle.view';
    this.viewGroup.matrixAutoUpdate = false;
    this.viewGroup.add(this.mesh);

    for (let i = 0; i < MAX_FLASH; i++) {
      this.slots.push({
        live: false,
        t: 0,
        life: 0.05,
        pos: new THREE.Vector3(),
        dir: new THREE.Vector3(0, 0, -1),
        follow: false,
        seed: 0,
        scale: 1,
        profile: PROFILES.none,
        petals: [],
      });
      for (let p = 0; p < PETALS; p++) {
        this.slots[i].petals.push({ w: 0, h: 0, rot: 0, bright: 0, ox: 0, oy: 0, cell: 14, r: 1, g: 1, b: 1 });
      }
    }
  }

  /** FOV-correct a viewmodel-space point so it projects where the gun appears. */
  _alignToView(p, out) {
    const ctx = this.ctx;
    const cam = ctx.camera;
    const vcam = ctx.viewCamera;
    out.copy(p);
    if (!cam || !vcam) return out;
    const tw = Math.tan((cam.fov * Math.PI) / 360);
    const tv = Math.tan((vcam.fov * Math.PI) / 360);
    if (!(tw > 1e-5) || !(tv > 1e-5)) return out;
    const k = tv / tw;
    if (Math.abs(k - 1) < 1e-3) return out;
    // Take the point into camera space, scale its lateral offset by the FOV ratio,
    // put it back. Depth is untouched, so the smoke still starts at bore distance.
    cam.updateMatrixWorld();
    out.copy(p).applyMatrix4(_m4.copy(cam.matrixWorld).invert());
    out.x *= k;
    out.y *= k;
    out.applyMatrix4(cam.matrixWorld);
    return out;
  }

  _profileFor(opts) {
    if (opts.suppressed) return PROFILES.suppressor;
    let style = opts.device || null;
    if (!style) {
      const cur = this.ctx.weapons?.current;
      const dev = cur?.def?.geometry?.muzzleDevice;
      style = dev?.style || null;
      const att = cur?.attachments?.muzzle;
      if (typeof att === 'string') {
        if (att.includes('suppress')) return PROFILES.suppressor;
        if (att.includes('brake')) style = 'brake';
        else if (att.includes('comp')) style = 'comp';
        else if (att.includes('hider')) style = 'flash_hider';
      }
    }
    return PROFILES[style] || PROFILES.none;
  }

  /**
   * @param {THREE.Vector3} pos world/viewmodel muzzle position
   * @param {THREE.Vector3} dir bore direction
   */
  fire(pos, dir, opts = {}) {
    const rng = this.fx.rng;
    let slot = this.slots.find((s) => !s.live);
    if (!slot) slot = this.slots[0];

    const prof = this._profileFor(opts);
    const scale = (opts.scale ?? 1) * prof.size;

    slot.live = true;
    slot.t = 0;
    slot.life = prof.life * (0.85 + rng() * 0.35);
    slot.pos.copy(pos);
    slot.dir.copy(dir).normalize();
    slot.scale = scale;
    slot.profile = prof;
    // Only the local weapon's flash tracks the gun; anything else is fire-and-forget.
    slot.follow = opts.follow !== false && !opts.world && typeof this.ctx.weapons?.muzzleWorld === 'function';

    // Roll a brand-new silhouette. This is the whole reason repeated fire does not
    // look like a looping animation: petal count, aspect, lean and offset all move.
    const n = Math.max(2, Math.round(prof.petals * (0.7 + rng() * 0.6)));
    const warm = 0.82 + rng() * 0.3;
    for (let i = 0; i < PETALS; i++) {
      const p = slot.petals[i];
      if (i >= n) {
        p.bright = 0;
        continue;
      }
      const isCore = i === 0;
      const spin = rng() * Math.PI * 2;
      const stretch = 0.55 + rng() * 1.15;
      p.rot = spin;
      p.w = scale * (isCore ? 0.09 : 0.05 + rng() * 0.075) * (1 + prof.lobeX * (1 - Math.abs(Math.cos(spin))));
      p.h = scale * (isCore ? 0.09 : (0.06 + rng() * 0.09) * stretch) * (1 + prof.lobeY * Math.max(0, Math.sin(spin)));
      p.ox = (rng() - 0.5) * 0.012 * scale;
      p.oy = (rng() - 0.5) * 0.012 * scale;
      p.cell = isCore ? 15 : 14;
      // Powder flame runs white in the middle to deep orange at the fringe.
      const heat = isCore ? 1 : 0.45 + rng() * 0.5;
      const b = (isCore ? 34 : 13 + rng() * 16) * (opts.suppressed ? 0.3 : 1);
      p.bright = b;
      p.r = (1.0 * warm) * (0.85 + 0.15 * heat);
      p.g = (0.72 + 0.24 * heat) * warm;
      p.b = (0.34 + 0.45 * heat * heat) * warm;
    }

    // ---- world-space consequences ------------------------------------------
    const wp = this._alignToView(pos, _v);
    const d = slot.dir;
    const dens = this.fx.density;

    // Hot gas. Huge drag, so it punches out ~0.4 m then hangs and drifts.
    this.fx.burst('smoke_puff', {
      x: wp.x + d.x * 0.12,
      y: wp.y + d.y * 0.12,
      z: wp.z + d.z * 0.12,
      dx: d.x,
      dy: d.y,
      dz: d.z,
      count: Math.round(5 * prof.gas),
      cone: 0.5,
      speed: 7.5 * prof.gas,
      speedVar: 0.55,
      spread: 0.035,
      life: 0.55 + prof.smoke * 0.5,
      lifeVar: 0.35,
      size0: 0.07 * scale,
      size1: (0.42 + 0.5 * prof.smoke) * scale,
      sizeVar: 0.35,
      spin: 2.4,
      r: 0.62,
      g: 0.6,
      b: 0.58,
      shadeVar: 0.25,
    });

    // Unburnt powder, thrown forward and down-range, burning out as it goes.
    if (prof.sparks > 0.3) {
      this.fx.burst('ember', {
        x: wp.x + d.x * 0.08,
        y: wp.y + d.y * 0.08,
        z: wp.z + d.z * 0.08,
        dx: d.x,
        dy: d.y,
        dz: d.z,
        count: Math.round(9 * prof.sparks),
        cone: 0.34,
        speed: 13,
        speedVar: 0.7,
        spread: 0.02,
        life: 0.24,
        lifeVar: 0.6,
        size0: 0.014 * scale,
        size1: 0.004,
        sizeVar: 0.5,
        r: 5.5,
        g: 2.4,
        b: 0.7,
      });
    }

    // Air distortion off the crown.
    if (dens > 0.5 && !opts.suppressed) {
      this.fx.distort({
        x: wp.x + d.x * 0.16,
        y: wp.y + d.y * 0.16,
        z: wp.z + d.z * 0.16,
        radius: 0.16 * scale,
        radiusEnd: 0.38 * scale,
        strength: 0.010 * scale,
        life: 0.075,
        kind: 'heat',
      });
    }

    // The light. Short, hot, and genuinely lighting the geometry around it.
    this.fx.light({
      x: wp.x + d.x * 0.25,
      y: wp.y + d.y * 0.25,
      z: wp.z + d.z * 0.25,
      intensity: 130 * prof.light * scale,
      radius: 9 * scale,
      kelvin: 2350,
      life: 0.055,
      curve: 2.6,
    });

    this._takeOver();
    return true;
  }

  /**
   * WeaponSystem publishes `localMuzzleFlash` precisely so FX can own the flash.
   * It boots after us, so claim it the first time we see it.
   */
  _takeOver() {
    if (this._tookOver || this._takeoverTries > 240) return;
    this._takeoverTries++;
    const w = this.ctx.weapons;
    if (w && 'localMuzzleFlash' in w) {
      w.localMuzzleFlash = false;
      this._tookOver = true;
    }
  }

  update(dt) {
    let live = 0;
    for (const s of this.slots) {
      if (!s.live) continue;
      s.t += dt;
      if (s.t >= s.life) {
        s.live = false;
        continue;
      }
      live++;
    }
    this.liveCount = live;
    this._takeOver();
  }

  /** Rebuild the instance buffers against the *settled* viewmodel transform. */
  lateUpdate() {
    if (!this.mesh) return;
    const w = this.ctx.weapons;
    let n = 0;

    for (const s of this.slots) {
      if (!s.live) continue;
      if (s.follow && typeof w?.muzzleWorld === 'function') {
        // Re-read the bore every frame: at 60 fps a fast turn moves the muzzle
        // several centimetres between the shot and the frame it is drawn on.
        w.muzzleWorld(s.pos);
        if (typeof w.aimDir === 'function') w.aimDir(s.dir);
      }
      const a = s.t / s.life;
      // Flash intensity: instantaneous rise, exponential collapse over ~3 frames.
      const env = Math.pow(1 - a, 2.7) * (a < 0.12 ? a / 0.12 : 1);
      const grow = 1 + a * 0.9;

      for (const p of s.petals) {
        if (p.bright <= 0 || n >= this.cap) continue;
        const i3 = n * 3;
        const i4 = n * 4;
        this.aCenter[i3] = s.pos.x + s.dir.x * 0.03;
        this.aCenter[i3 + 1] = s.pos.y + s.dir.y * 0.03;
        this.aCenter[i3 + 2] = s.pos.z + s.dir.z * 0.03;
        this.aQuat[i4] = p.ox;
        this.aQuat[i4 + 1] = p.oy;
        this.aQuat[i4 + 2] = 0;
        this.aQuat[i4 + 3] = p.cell === 15 ? 0 : 0.55; // core is centred, petals hang off the bore
        this.aParams[i4] = p.w * grow;
        this.aParams[i4 + 1] = p.h * grow * (p.cell === 15 ? 1 : 1 + a * 0.6);
        this.aParams[i4 + 2] = p.rot;
        this.aParams[i4 + 3] = p.bright * env;
        this.aTint[i4] = p.r;
        this.aTint[i4 + 1] = p.g;
        this.aTint[i4 + 2] = p.b;
        this.aTint[i4 + 3] = p.cell;
        n++;
      }
    }

    if (n > 0) {
      for (const name of ['aCenter', 'aQuat', 'aParams', 'aTint']) {
        this.geometry.getAttribute(name).needsUpdate = true;
      }
      if (!this.material.uniforms.tAtlas.value) {
        this.material.uniforms.tAtlas.value = this.fx.particles?.atlas || null;
      }
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  clear() {
    for (const s of this.slots) s.live = false;
    this.liveCount = 0;
    if (this.geometry) this.geometry.instanceCount = 0;
    if (this.mesh) this.mesh.visible = false;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}

export default MuzzleFlash;
