/**
 * FXSystem — the effects layer. Owner: FX agent.
 * Files owned: this file, fx/GPUParticles.js, fx/MuzzleFlash.js, fx/Tracers.js,
 *              fx/Impacts.js, fx/Smoke.js.
 * Publishes: `ctx.fx`.
 *
 * ── Where the effects actually get drawn ────────────────────────────────────────
 * Particles are *not* children of `ctx.scene`. They live in two private scenes that
 * this module renders itself, from `scene.onAfterRender`:
 *
 *   ctx.scene.onAfterRender      -> copy scene depth -> [copy scene colour] -> draw fx.world
 *   ctx.viewScene.onAfterRender  -> draw fx.view (the muzzle flash, glued to the gun)
 *
 * The reason is soft particles. `ctx.pipeline` renders the world into an HDR target
 * whose depth attachment is exactly the buffer a soft particle has to read, and
 * sampling a texture that is attached to the bound framebuffer is a feedback loop.
 * So the first thing the hook does is resolve that depth into a private half-res
 * linear-distance buffer; from then on every sprite can fade against the world
 * instead of slicing through it. Drawing here also means the effects land *inside*
 * the HDR buffer, so they pick up bloom, TAA, auto-exposure, DOF and the grade for
 * free — a muzzle flash blooms because it is genuinely bright, not because it was
 * composited on afterwards.
 *
 * The scene *colour* is copied too, but only on frames where something asked for
 * refraction, so heat haze and explosion shockwaves cost nothing when idle.
 *
 * ── Public API (ctx.fx) ─────────────────────────────────────────────────────────
 *   impact(hit | point, normal?, opts?)     surface-aware impact effect
 *   tracer(from, to, opts)                  additive tracer segment
 *   muzzle(pos, dir, opts) | (weapon, mat4, opts)
 *   explosion(point, opts) | (opts)
 *   smoke(opts)                             grenade smoke volume
 *   brass(position, velocity, opts)         world shell casing with physics
 *   spawn(emitter, transform, opts)         registry-driven burst
 *   register(name, def) / emitters()        add your own emitter
 *   burst(type, opts)                       raw particle burst
 *   light(opts)                             pooled transient dynamic light
 *   distort(opts)                           refraction quad (heat / shockwave)
 *   clear()                                 kill everything (pose changes)
 *   particles                               the GPUParticles instance
 *   TYPE                                    particle type name -> index
 *   stats / ready / quality
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   bullet:impact, bullet:penetrate, bullet:ricochet, explosion, weapon:fire,
 *   entity:damage, player:land, physics:impact, quality:changed, setting:changed,
 *   debug:pose, level:ready, weather:wind
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   fx:ready {budget}
 */
import * as THREE from 'three';
import { GPUParticles, TYPE } from './GPUParticles.js';
import { MuzzleFlash } from './MuzzleFlash.js';
import { Tracers } from './Tracers.js';
import { Impacts } from './Impacts.js';
import { Smoke } from './Smoke.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ═════════════════════════════════════════════════════════════════ shaders ══ */

// language=GLSL
const COPY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Depth attachment -> linear view distance in metres. */
// language=GLSL
const DEPTH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform vec2 uCam;
varying vec2 vUv;
void main() {
	float d = texture2D( tDepth, vUv ).r;
	float vz = ( uCam.x * uCam.y ) / ( ( uCam.y - uCam.x ) * d - uCam.y );
	gl_FragColor = vec4( - vz, 0.0, 0.0, 1.0 );
}
`;

// language=GLSL
const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
varying vec2 vUv;
void main() {
	gl_FragColor = vec4( texture2D( tSrc, vUv ).rgb, 1.0 );
}
`;

/**
 * Refraction quads. Hot gas off a muzzle and the shock front of a blast are the
 * two places a shooter expects the *world itself* to bend; a additive white blob
 * instead of real distortion is the cheap-looking substitute.
 */
// language=GLSL
const DISTORT_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec4 aParams;   // radius, strength, age 0..1, kind
varying vec2 vQuad;
varying vec3 vParams;
varying vec3 vWorld;
void main() {
	vQuad = uv;
	vParams = aParams.yzw;
	vec4 mv = viewMatrix * vec4( aCenter, 1.0 );
	mv.xy += position.xy * aParams.x * 2.0;
	vWorld = aCenter;
	gl_Position = projectionMatrix * mv;
}
`;

// language=GLSL
const DISTORT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tFxDepth;
uniform vec2 uFxRes;
uniform float uDepthValid;
uniform float uTime;
varying vec2 vQuad;
varying vec3 vParams;   // strength, age, kind
varying vec3 vWorld;

void main() {
	vec2 q = vQuad * 2.0 - 1.0;
	float r = length( q );
	if ( r > 1.0 ) discard;

	float age = vParams.y;
	float kind = vParams.z;
	float mask;
	float push;

	if ( kind > 0.5 ) {
		// Shock front: a thin ring sweeping outward, thinning as it goes.
		float rad = clamp( age, 0.02, 1.0 );
		float w = mix( 0.10, 0.26, age );
		mask = exp( - pow( ( r - rad ) / w, 2.0 ) ) * ( 1.0 - age );
		push = mask * ( 1.0 - 2.0 * step( rad, r ) );
	} else {
		// Hot gas: a turbulent lens that boils outward from the bore.
		float n = sin( q.x * 21.0 + uTime * 37.0 ) * 0.5 + sin( q.y * 17.0 - uTime * 29.0 ) * 0.5;
		mask = pow( max( 0.0, 1.0 - r ), 1.7 ) * ( 1.0 - age ) * ( 0.75 + 0.25 * n );
		push = mask;
	}

	float amp = vParams.x * push;
	vec2 dir = r > 1e-4 ? q / r : vec2( 0.0 );
	vec2 uv = gl_FragCoord.xy / uFxRes + dir * amp;
	uv = clamp( uv, vec2( 0.002 ), vec2( 0.998 ) );

	vec3 c = texture2D( tScene, uv ).rgb;
	gl_FragColor = vec4( c, clamp( mask * 1.6, 0.0, 1.0 ) );
}
`;

/* ══════════════════════════════════════════════════════════════ distortion ══ */

const MAX_DISTORT = 12;

class Distortion {
  constructor(ctx, fx) {
    this.ctx = ctx;
    this.fx = fx;
    this.count = 0;
    this.items = [];
    for (let i = 0; i < MAX_DISTORT; i++) {
      this.items.push({ live: false, x: 0, y: 0, z: 0, r: 1, r0: 1, r1: 1, s: 0.02, t: 0, life: 0.1, kind: 0 });
    }
    this.aCenter = new Float32Array(MAX_DISTORT * 3);
    this.aParams = new Float32Array(MAX_DISTORT * 4);
  }

  init() {
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
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(this.aParams, 4).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    const G = this.fx.globals;
    this.material = new THREE.ShaderMaterial({
      name: 'fx:distortion',
      uniforms: {
        tScene: G.tFxScene,
        tFxDepth: G.tFxDepth,
        uFxRes: G.uFxRes,
        uDepthValid: G.uDepthValid,
        uTime: G.uTime,
      },
      vertexShader: DISTORT_VERT,
      fragmentShader: DISTORT_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx.distortion';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 2; // before the particles: it refracts the world, not them
    this.mesh.visible = false;
  }

  add(o) {
    for (const it of this.items) {
      if (it.live) continue;
      it.live = true;
      it.x = o.x || 0;
      it.y = o.y || 0;
      it.z = o.z || 0;
      it.r0 = o.radius ?? 0.4;
      it.r1 = o.radiusEnd ?? it.r0;
      it.r = it.r0;
      it.s = o.strength ?? 0.012;
      it.t = 0;
      it.life = Math.max(0.02, o.life ?? 0.12);
      it.kind = o.kind === 'shock' ? 1 : 0;
      return it;
    }
    return null;
  }

  update(dt) {
    let n = 0;
    for (const it of this.items) {
      if (!it.live) continue;
      it.t += dt;
      if (it.t >= it.life) {
        it.live = false;
        continue;
      }
      const a = it.t / it.life;
      it.r = it.r0 + (it.r1 - it.r0) * (1 - (1 - a) * (1 - a));
      const i3 = n * 3;
      const i4 = n * 4;
      this.aCenter[i3] = it.x;
      this.aCenter[i3 + 1] = it.y;
      this.aCenter[i3 + 2] = it.z;
      this.aParams[i4] = it.r;
      this.aParams[i4 + 1] = it.s;
      this.aParams[i4 + 2] = a;
      this.aParams[i4 + 3] = it.kind;
      n++;
    }
    this.count = n;
    if (!this.mesh) return;
    if (n > 0) {
      const c = this.mesh.geometry.getAttribute('aCenter');
      const p = this.mesh.geometry.getAttribute('aParams');
      c.needsUpdate = true;
      p.needsUpdate = true;
    }
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  dispose() {
    this.mesh?.geometry?.dispose();
    this.material?.dispose();
  }
}

/* ═════════════════════════════════════════════════════════════════ FX core ══ */

class FX {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = false;
    this.broken = false;
    this.now = 0;
    this.frameId = -1;
    this.quality = ctx.settings?.tier || 'high';
    this.headless = !!ctx.settings?.get?.('headless');
    /** Global density multiplier — tier and headless both pull on this. */
    this.density = 1;

    this._warned = new Set();
    this._unsub = [];
    this._hooks = [];
    this._impactRing = new Float32Array(32); // 8 x (frame,x,y,z)
    this._impactAt = 0;

    this.rng = ctx.rng || (() => 0.5);

    // One bag of uniform *objects*, shared by reference with every fx material,
    // so a single write per frame updates the whole effects layer.
    this.globals = {
      tFxDepth: { value: null },
      tFxScene: { value: null },
      uDepthValid: { value: 0 },
      uFxRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.3) },
      uSunColor: { value: new THREE.Vector3(3, 2.9, 2.7) },
      uSH: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
      uCamPos: { value: new THREE.Vector3() },
      uNear: { value: 0.05 },
      uWindVec: { value: new THREE.Vector3() },
    };

    this.emitters = new Map();
    this._lights = [];
    this._poseFire = 0;
    this._poseFireT = 0;

    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._color = new THREE.Color();
  }

  /* ------------------------------------------------------------------ init */

  init() {
    const ctx = this.ctx;
    if (!ctx.renderer) throw new Error('no renderer');

    this._applyQuality(this.quality, false);

    this.worldScene = new THREE.Scene();
    this.worldScene.name = 'fx.world';
    this.worldScene.matrixAutoUpdate = false;
    this.viewFxScene = new THREE.Scene();
    this.viewFxScene.name = 'fx.view';
    this.viewFxScene.matrixAutoUpdate = false;

    this.particles = new GPUParticles(ctx, this.globals);
    this.particles.init();
    this.worldScene.add(this.particles.meshAlpha, this.particles.meshAdd);

    this.distortion = new Distortion(ctx, this);
    this.distortion.init();
    this.worldScene.add(this.distortion.mesh);

    this.tracers = new Tracers(ctx, this);
    this.tracers.init();
    if (this.tracers.mesh) this.worldScene.add(this.tracers.mesh);

    this.impacts = new Impacts(ctx, this);
    this.impacts.init();
    // Debris and brass are opaque solids, so they belong in the *world* pass:
    // they write depth, take cascade shadows and AO, and get the same IBL as the
    // floor they land on. Putting them in the FX overlay would light them wrong.
    for (const o of this.impacts.objects()) ctx.scene?.add(o);

    this.smoke = new Smoke(ctx, this);
    this.smoke.init();

    this.muzzleFx = new MuzzleFlash(ctx, this);
    this.muzzleFx.init();
    if (this.muzzleFx.viewGroup) this.viewFxScene.add(this.muzzleFx.viewGroup);
    if (this.muzzleFx.worldGroup) this.worldScene.add(this.muzzleFx.worldGroup);

    this._buildCopies();
    this._hookScene(ctx.scene, false);
    this._hookScene(ctx.viewScene, true);
    this._bind();

    const size = ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.resize(size.x || 1280, size.y || 720);

    this.ready = true;
    ctx.bus?.emit?.('fx:ready', { budget: this.particles.budget });
  }

  /* ------------------------------------------------------------- copy pass */

  _buildCopies() {
    this._quadScene = new THREE.Scene();
    this._quadScene.matrixAutoUpdate = false;
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quadMesh.frustumCulled = false;
    this._quadMesh.matrixAutoUpdate = false;
    this._quadScene.add(this._quadMesh);

    this.depthMat = new THREE.ShaderMaterial({
      name: 'fx:depthResolve',
      uniforms: { tDepth: { value: null }, uCam: { value: new THREE.Vector2(0.05, 2000) } },
      vertexShader: COPY_VERT,
      fragmentShader: DEPTH_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMat = new THREE.ShaderMaterial({
      name: 'fx:sceneCopy',
      uniforms: { tSrc: { value: null } },
      vertexShader: COPY_VERT,
      fragmentShader: COPY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  resize(w, h) {
    const W = Math.max(16, Math.round(w));
    const H = Math.max(16, Math.round(h));
    this.globals.uFxRes.value.set(W, H);
    const s = this.headless || this.quality === 'low' ? 0.4 : 0.5;
    const cw = Math.max(8, Math.round(W * s));
    const ch = Math.max(8, Math.round(H * s));
    if (this._rtDepth && this._rtDepth.width === cw && this._rtDepth.height === ch) return;

    this._rtDepth?.dispose();
    this._rtScene?.dispose();
    const mk = (name) => {
      const rt = new THREE.WebGLRenderTarget(cw, ch, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
      });
      rt.texture.name = name;
      return rt;
    };
    this._rtDepth = mk('fx.depthLinear');
    this._rtScene = mk('fx.sceneCopy');
    this.globals.tFxDepth.value = this._rtDepth.texture;
    this.globals.tFxScene.value = this._rtScene.texture;
  }

  _blit(material, target) {
    const r = this.ctx.renderer;
    this._quadMesh.material = material;
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    try {
      r.setRenderTarget(target);
      r.render(this._quadScene, this._quadCam);
    } finally {
      r.autoClear = prevAuto;
      r.setRenderTarget(prev);
    }
  }

  /* ------------------------------------------------------------ scene hook */

  _hookScene(scene, isView) {
    if (!scene || scene.__codFxHook) return;
    const prev = scene.onAfterRender;
    const self = this;
    scene.onAfterRender = function (renderer, sc, camera) {
      if (typeof prev === 'function') {
        try {
          prev.call(this, renderer, sc, camera);
        } catch (err) {
          self._warn('prevHook', err);
        }
      }
      try {
        if (isView) self._afterViewRender(renderer, camera);
        else self._afterWorldRender(renderer, camera);
      } catch (err) {
        // Never throw inside three's render call: the pipeline would mark itself
        // broken forever and the whole post chain would drop out.
        self._warn(isView ? 'viewHook' : 'worldHook', err);
      }
    };
    scene.__codFxHook = true;
    this._hooks.push({ scene, prev });
  }

  /**
   * The main event. Runs once per engine frame, at the end of the world pass,
   * with every camera and viewmodel transform already final.
   */
  _afterWorldRender(renderer, camera) {
    if (!this.ready || this.broken) return;
    const ctx = this.ctx;
    if (camera !== ctx.camera) return; // probe / cube captures are not our frame
    const frame = ctx.time?.frame ?? 0;
    if (this._renderedFrame === frame) return; // velocity + g-buffer re-renders
    this._renderedFrame = frame;

    const dt = clamp(ctx.time?.dt ?? 1 / 60, 0, 0.05);
    const rt = renderer.getRenderTarget();

    // 1. Resolve the scene depth into a private linear buffer. Everything soft
    //    depends on this, and it must happen before anything else samples it.
    const depthTex = rt?.depthTexture || null;
    if (depthTex && this._rtDepth) {
      this.depthMat.uniforms.tDepth.value = depthTex;
      this.depthMat.uniforms.uCam.value.set(camera.near, camera.far);
      this._blit(this.depthMat, this._rtDepth);
      this.globals.uDepthValid.value = 1;
    } else {
      this.globals.uDepthValid.value = 0;
    }

    // 2. Late CPU state, then the GPU particle step. Both want the final camera.
    this._lateFrame(dt, camera);

    // 3. Scene colour, only when something is refracting it this frame.
    const wantCopy = this.distortion.count > 0 && rt?.texture;
    if (wantCopy) {
      this.copyMat.uniforms.tSrc.value = rt.texture;
      this._blit(this.copyMat, this._rtScene);
    }
    this.distortion.mesh.visible = this.distortion.count > 0 && !!wantCopy;

    // 4. Draw. autoClear is force-disabled: a stray `true` here would wipe the
    //    HDR buffer we are drawing on top of and blank the entire frame.
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.render(this.worldScene, camera);
    } finally {
      renderer.autoClear = prevAuto;
    }
  }

  _afterViewRender(renderer, camera) {
    if (!this.ready || this.broken) return;
    if (camera !== this.ctx.viewCamera) return;
    if (!this.viewFxScene.children.length) return;
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.render(this.viewFxScene, camera);
    } finally {
      renderer.autoClear = prevAuto;
    }
  }

  /** Per-frame work that has to see the settled camera. */
  _lateFrame(dt, camera) {
    this.globals.uCamPos.value.copy(camera.position);
    this.globals.uNear.value = camera.near;
    this.muzzleFx.lateUpdate?.(dt, camera);
    this.smoke.lateUpdate?.(dt, camera);
    this.tracers.lateUpdate?.(dt, camera);
    this.distortion.update(dt);
    this.particles.frame(dt, camera);
  }

  /* ----------------------------------------------------------------- update */

  update(dt) {
    if (!this.ready || this.broken) return;
    const d = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.05);
    this.now += d;
    this.globals.uTime.value = this.now;

    this._syncLighting();
    this._syncWind();
    this._poseFireStep(d);

    this.muzzleFx.update(d);
    this.tracers.update(d);
    this.impacts.update(d);
    this.smoke.update(d);
    this._stepLights(d);
  }

  /** Pull the key light and the sky irradiance so smoke is lit like everything else. */
  _syncLighting() {
    const L = this.ctx.lighting;
    const G = this.globals;
    const dir = L?.sunDirection || L?.keyDirection || this.ctx.sky?.keyDirection;
    if (dir && Number.isFinite(dir.x)) {
      const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      G.uSunDir.value.set(dir.x / len, dir.y / len, dir.z / len);
    }
    const c = L?.sunColor;
    const inten = Number.isFinite(L?.sunIntensity) ? L.sunIntensity : 6;
    if (c?.isColor) G.uSunColor.value.set(c.r * inten, c.g * inten, c.b * inten);

    const sh = L?.irradianceSH?.coefficients;
    const dst = G.uSH.value;
    if (sh && sh.length === 9 && Number.isFinite(sh[0]?.x)) {
      for (let i = 0; i < 9; i++) dst[i].copy(sh[i]);
    } else if (dst[0].lengthSq() < 1e-9) {
      // Never let smoke render black: a plausible sky-blue dome as a stand-in.
      dst[0].set(1.05, 1.25, 1.6);
      dst[2].set(0.3, 0.34, 0.4);
    }
  }

  _syncWind() {
    const g = this.ctx.materials?.globals;
    const w = g?.wind; // vec4: cos, sin, strength, gust
    const v = this.globals.uWindVec.value;
    if (w && Number.isFinite(w.x)) {
      const s = (w.z || 0) * (1 + (w.w || 0) * 0.5);
      v.set(w.x * s, 0, w.y * s);
    } else if (v.lengthSq() === 0) {
      v.set(0.55, 0, 0.22);
    }
  }

  /* ---------------------------------------------------------------- lights */

  /**
   * A pooled transient light. Muzzle flashes and explosions have to *actually*
   * light the wall next to them or they read as decals on the lens.
   */
  light(o = {}) {
    const L = this.ctx.lighting;
    if (typeof L?.addLight !== 'function') return null;
    let slot = null;
    for (const s of this._lights) {
      if (s.t >= s.life) {
        slot = s;
        break;
      }
    }
    if (!slot) {
      if (this._lights.length >= (this.headless ? 3 : 6)) {
        // Steal the one closest to finishing.
        slot = this._lights.reduce((a, b) => (a.t / a.life > b.t / b.life ? a : b));
      } else {
        let handle = null;
        try {
          handle = L.addLight({ type: 'point', intensity: 0, radius: 8, priority: 3 });
        } catch (err) {
          this._warn('addLight', err);
          return null;
        }
        if (!handle) return null;
        slot = { handle, t: 0, life: 0.01, i0: 0, radius: 8, curve: 2 };
        this._lights.push(slot);
      }
    }
    slot.t = 0;
    slot.life = Math.max(0.016, o.life ?? 0.06);
    slot.i0 = o.intensity ?? 60;
    slot.curve = o.curve ?? 2.4;
    slot.handle.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    slot.handle.radius = o.radius ?? 8;
    if (o.color) slot.handle.color.set(o.color);
    else if (Number.isFinite(o.kelvin) && typeof L.kelvin === 'function') L.kelvin(o.kelvin, slot.handle.color);
    slot.handle.intensity = slot.i0;
    slot.handle.enabled = true;
    return slot;
  }

  _stepLights(dt) {
    for (const s of this._lights) {
      if (s.t >= s.life) {
        if (s.handle.intensity !== 0) s.handle.intensity = 0;
        continue;
      }
      s.t += dt;
      const a = clamp01(s.t / s.life);
      s.handle.intensity = s.i0 * Math.pow(1 - a, s.curve);
      if (s.t >= s.life) s.handle.intensity = 0;
    }
  }

  distort(o) {
    return this.distortion.add(o);
  }

  /* ------------------------------------------------------------- pose mode */

  /**
   * The `firefight` review pose asks for combat with no player input. Drive a
   * scripted burst so the captured frame always has a live flash, tracers in the
   * air, fresh impacts downrange and smoke that has had time to drift.
   */
  _poseFireStep(dt) {
    if (this._poseFire <= 0) return;
    this._poseFire -= dt;
    this._poseFireT -= dt;
    const cam = this.ctx.camera;
    if (!cam) return;
    // Fire whenever the previous flash has burned out, so no captured frame can
    // land in the gap between rounds.
    if (this._poseFireT > 0 && this.muzzleFx.liveCount > 0) return;
    this._poseFireT = 0.075;

    const dir = this._v0.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(this._q));
    const jx = (this.rng() - 0.5) * 0.026;
    const jy = (this.rng() - 0.5) * 0.018;
    dir.x += jx;
    dir.y += jy;
    dir.normalize();

    const muzzle = this._v1.copy(cam.position).addScaledVector(dir, 0.55);
    muzzle.y -= 0.1;
    this.muzzle(muzzle, dir, { weapon: this.ctx.weapons?.currentId, scale: 1 });
    this.brass(muzzle, this._v2.set(dir.z, 1.5, -dir.x).multiplyScalar(2.2), { owner: 'player' });

    const hit = this.ctx.physics?.raycast?.(cam.position, dir, 140, 1 | 8);
    const end = this._v2;
    if (hit?.point) end.copy(hit.point);
    else end.copy(cam.position).addScaledVector(dir, 90);
    this.tracer(muzzle, end, { speed: 880, transient: true });
    if (hit?.point) {
      this.impact(hit.point, hit.normal, {
        surface: hit.surface,
        material: hit.material || hit.body?.surface,
        energy: 1600,
        dir,
      });
    }
  }

  /* ---------------------------------------------------------------- quality */

  _applyQuality(tier, live) {
    const s = this.ctx.settings;
    this.quality = tier || s?.tier || 'high';
    this.headless = !!s?.get?.('headless');
    const byTier = { low: 0.42, medium: 0.7, high: 1, ultra: 1.35 }[this.quality] ?? 1;
    this.density = this.headless ? Math.min(byTier, 0.5) : byTier;
    if (!live) return;
    try {
      this.particles.setBudget();
      const size = this.ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
      this._rtDepth?.dispose();
      this._rtDepth = null;
      this.resize(size.x, size.y);
      this.smoke.setQuality?.(this.quality);
    } catch (err) {
      this._warn('quality', err);
    }
  }

  /* ------------------------------------------------------------------ bind */

  _bind() {
    const bus = this.ctx.bus;
    if (!bus?.on) return;
    const on = (ev, fn) => {
      const off = bus.on(ev, fn);
      if (typeof off === 'function') this._unsub.push(off);
    };

    on('bullet:impact', (e) => {
      if (!e?.point) return;
      this.impact(e.point, e.normal, e);
    });
    on('bullet:penetrate', (e) => {
      if (!e?.exitPoint) return;
      // Spall out of the back face: a thinner, faster version of the entry puff.
      this.impact(e.exitPoint, e.exitNormal || e.normal, {
        surface: e.surface,
        material: e.material,
        energy: (e.energy ?? 900) * 0.55,
        exit: true,
        dir: e.dir,
      });
    });
    on('bullet:ricochet', (e) => {
      if (!e?.point) return;
      this.impacts.ricochet?.(e);
    });
    on('explosion', (e) => {
      if (!e?.point) return;
      this.explosion(e.point, e);
    });
    on('entity:damage', (e) => {
      if (!e?.point || !e.dir) return;
      this.impacts.flesh?.(e);
    });
    on('player:land', (e) => {
      this.impacts.land?.(e);
    });
    on('physics:impact', (e) => {
      this.impacts.debrisImpact?.(e);
    });
    on('quality:changed', ({ tier }) => this._applyQuality(tier, true));
    on('setting:changed', ({ key }) => {
      if (key === 'particleBudget') this._applyQuality(this.quality, true);
    });
    on('debug:pose', (state) => this._onPose(state || {}));
    on('level:ready', () => this.smoke.rebuildAmbient?.());
    on('world:ready', () => this.smoke.rebuildAmbient?.());
  }

  _onPose(state) {
    try {
      this.clear();
      this._poseFire = state.firing ? 6 : 0;
      this._poseFireT = 0;
      this.smoke.rebuildAmbient?.();
      if (state.smoke) {
        const cam = this.ctx.camera;
        const p = this._v0.copy(cam.position).addScaledVector(
          this._v1.set(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(this._q)),
          8
        );
        p.y = (this.ctx.level?.groundY?.(p.x, p.z) ?? 0) + 0.1;
        this.smoke.grenade({ position: p, radius: 4.5, duration: 20 });
      }
    } catch (err) {
      this._warn('pose', err);
    }
  }

  clear() {
    this.particles?.reset?.();
    this.tracers?.clear?.();
    this.impacts?.clear?.();
    this.smoke?.clear?.();
    this.muzzleFx?.clear?.();
    for (const s of this._lights) {
      s.t = s.life;
      s.handle.intensity = 0;
    }
  }

  /* ------------------------------------------------------------- burst api */

  /** Raw particle burst — the primitive every effect module is built from. */
  burst(type, o = {}) {
    const P = this.particles;
    if (!P?.ready) return 0;
    const ty = typeof type === 'string' ? TYPE[type] : type;
    if (ty === undefined) return 0;
    const rng = this.rng;
    const n = Math.max(0, Math.round((o.count ?? 1) * (o.ignoreDensity ? 1 : this.density)));
    if (n === 0) return 0;

    const px = o.x ?? 0;
    const py = o.y ?? 0;
    const pz = o.z ?? 0;
    const spread = o.spread ?? 0;
    const speed = o.speed ?? 0;
    const speedVar = o.speedVar ?? 0.4;
    const cone = o.cone ?? 1;
    const dx = o.dx ?? 0;
    const dy = o.dy ?? 1;
    const dz = o.dz ?? 0;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / dl;
    const uy = dy / dl;
    const uz = dz / dl;
    // Orthonormal basis around the emission axis, for cone sampling.
    const tx = Math.abs(ux) < 0.9 ? 1 : 0;
    const ty2 = Math.abs(ux) < 0.9 ? 0 : 1;
    let ax = uy * 0 - uz * ty2;
    let ay = uz * tx - ux * 0;
    let az = ux * ty2 - uy * tx;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    const bx = uy * az - uz * ay;
    const by = uz * ax - ux * az;
    const bz = ux * ay - uy * ax;

    let made = 0;
    for (let i = 0; i < n; i++) {
      const t1 = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * cone;
      const cx = ux + (ax * Math.cos(t1) + bx * Math.sin(t1)) * rr;
      const cy = uy + (ay * Math.cos(t1) + by * Math.sin(t1)) * rr;
      const cz = uz + (az * Math.cos(t1) + bz * Math.sin(t1)) * rr;
      const cl = Math.hypot(cx, cy, cz) || 1;
      const sp = speed * (1 - speedVar + rng() * speedVar * 2);
      const jitter = spread * (o.uniform ? 1 : Math.cbrt(rng()));
      const jx = (rng() * 2 - 1) * jitter;
      const jy = (rng() * 2 - 1) * jitter;
      const jz = (rng() * 2 - 1) * jitter;
      const life = (o.life ?? 1) * (1 - (o.lifeVar ?? 0.25) + rng() * (o.lifeVar ?? 0.25) * 2);
      const s0 = (o.size0 ?? 0.2) * (1 - (o.sizeVar ?? 0.3) + rng() * (o.sizeVar ?? 0.3) * 2);
      const s1 = (o.size1 ?? s0 * 2) * (1 - (o.sizeVar ?? 0.3) + rng() * (o.sizeVar ?? 0.3) * 2);
      const shade = o.shadeVar ? 1 - o.shadeVar * rng() : 1;
      if (
        P.spawn(ty, {
          px: px + jx,
          py: py + jy,
          pz: pz + jz,
          vx: (cx / cl) * sp + (o.vx ?? 0),
          vy: (cy / cl) * sp + (o.vy ?? 0),
          vz: (cz / cl) * sp + (o.vz ?? 0),
          life,
          size0: s0,
          size1: s1,
          rot: rng() * Math.PI * 2,
          rotSpeed: (rng() * 2 - 1) * (o.spin ?? 1.2),
          r: (o.r ?? 1) * shade,
          g: (o.g ?? 1) * shade,
          b: (o.b ?? 1) * shade,
        })
      ) {
        made++;
      }
    }
    return made;
  }

  /* ------------------------------------------------------------- registry */

  register(name, def) {
    if (typeof name !== 'string' || !def) return false;
    this.emitters.set(name, def);
    return true;
  }

  /**
   * Fire a registered emitter. `transform` may be a Vector3, a Matrix4, an
   * Object3D, or `{position, direction}`.
   */
  spawn(name, transform, opts = {}) {
    const def = this.emitters.get(name);
    if (!def) return false;
    const pos = this._v0;
    const dir = this._v1.set(0, 1, 0);
    this._decode(transform, pos, dir);
    try {
      if (typeof def === 'function') return def(this, pos, dir, opts) !== false;
      const merged = { ...def, ...opts, x: pos.x, y: pos.y, z: pos.z };
      if (def.align !== false) {
        merged.dx = dir.x;
        merged.dy = dir.y;
        merged.dz = dir.z;
      }
      return this.burst(def.type ?? 'dust', merged) > 0;
    } catch (err) {
      this._warn(`emitter:${name}`, err);
      return false;
    }
  }

  _decode(t, pos, dir) {
    if (!t) return;
    if (t.isVector3) {
      pos.copy(t);
    } else if (t.isMatrix4) {
      pos.setFromMatrixPosition(t);
      dir.set(-t.elements[8], -t.elements[9], -t.elements[10]).normalize();
    } else if (t.isObject3D) {
      t.updateWorldMatrix(true, false);
      pos.setFromMatrixPosition(t.matrixWorld);
      dir.set(0, 0, -1).applyQuaternion(t.getWorldQuaternion(this._q));
    } else if (Array.isArray(t)) {
      pos.fromArray(t);
    } else if (typeof t === 'object') {
      if (t.position) pos.copy(t.position);
      else if (t.point) pos.copy(t.point);
      if (t.direction) dir.copy(t.direction).normalize();
      else if (t.normal) dir.copy(t.normal).normalize();
    }
  }

  /* -------------------------------------------------------- public effects */

  /** Dedupe: ballistics both emits `bullet:impact` and calls us directly. */
  _dupImpact(x, y, z) {
    const f = this.ctx.time?.frame ?? 0;
    const ring = this._impactRing;
    for (let i = 0; i < 8; i++) {
      const o = i * 4;
      if (ring[o] !== f) continue;
      if (Math.abs(ring[o + 1] - x) < 0.02 && Math.abs(ring[o + 2] - y) < 0.02 && Math.abs(ring[o + 3] - z) < 0.02) {
        return true;
      }
    }
    const o = (this._impactAt++ & 7) * 4;
    ring[o] = f;
    ring[o + 1] = x;
    ring[o + 2] = y;
    ring[o + 3] = z;
    return false;
  }

  impact(a, b, c) {
    if (!this.ready || this.broken) return false;
    let point = null;
    let normal = null;
    let opts = null;
    if (a && a.isVector3) {
      point = a;
      normal = b && b.isVector3 ? b : null;
      opts = c || (b && !b.isVector3 ? b : null) || {};
    } else if (a && typeof a === 'object') {
      point = a.point || a.position || null;
      normal = a.normal || null;
      opts = a;
    }
    if (!point) return false;
    if (this._dupImpact(point.x, point.y, point.z)) return false;
    try {
      return this.impacts.impact(point, normal, opts || {});
    } catch (err) {
      this._warn('impact', err);
      return false;
    }
  }

  tracer(from, to, opts) {
    if (!this.ready || this.broken) return false;
    try {
      return this.tracers.tracer(from, to, opts || {});
    } catch (err) {
      this._warn('tracer', err);
      return false;
    }
  }

  /**
   * Accepts both call shapes in the wild:
   *   muzzle(worldPos: Vector3, dir: Vector3, opts)   — WeaponSystem
   *   muzzle(weaponId: string, worldMatrix: Matrix4, opts)
   */
  muzzle(a, b, c) {
    if (!this.ready || this.broken) return false;
    try {
      const pos = this._v0;
      const dir = this._v1.set(0, 0, -1);
      let opts = c || {};
      if (a && a.isVector3) {
        pos.copy(a);
        if (b && b.isVector3) dir.copy(b).normalize();
        else if (b && typeof b === 'object' && !b.isMatrix4) opts = b;
      } else {
        opts = { ...(c || {}), weapon: typeof a === 'string' ? a : (c || {}).weapon };
        if (b && b.isMatrix4) {
          pos.setFromMatrixPosition(b);
          dir.set(-b.elements[8], -b.elements[9], -b.elements[10]).normalize();
        } else {
          this._decode(b, pos, dir);
        }
      }
      return this.muzzleFx.fire(pos, dir, opts);
    } catch (err) {
      this._warn('muzzle', err);
      return false;
    }
  }

  explosion(a, b) {
    if (!this.ready || this.broken) return false;
    try {
      let point = null;
      let opts = b || {};
      if (a && (a.isVector3 || Array.isArray(a))) {
        point = a.isVector3 ? a : this._v0.fromArray(a);
      } else if (a && typeof a === 'object') {
        point = a.point || a.position;
        opts = a;
      }
      if (!point) return false;
      if (this._dupImpact(point.x + 1e3, point.y, point.z)) return false;
      return this.impacts.explosion(point, opts);
    } catch (err) {
      this._warn('explosion', err);
      return false;
    }
  }

  smokeGrenade(opts) {
    if (!this.ready || this.broken) return false;
    try {
      return this.smoke.grenade(opts || {});
    } catch (err) {
      this._warn('smoke', err);
      return false;
    }
  }

  brass(position, velocity, opts) {
    if (!this.ready || this.broken) return false;
    try {
      return this.impacts.brass(position, velocity, opts || {});
    } catch (err) {
      this._warn('brass', err);
      return false;
    }
  }

  get stats() {
    return {
      particles: this.particles?.stats ?? null,
      budget: this.particles?.budget ?? 0,
      tracers: this.tracers?.live ?? 0,
      debris: this.impacts?.debrisLive ?? 0,
      lights: this._lights.filter((l) => l.t < l.life).length,
      distortion: this.distortion?.count ?? 0,
      density: this.density,
      tier: this.quality,
    };
  }

  _warn(tag, err) {
    if (this._warned.has(tag)) return;
    this._warned.add(tag);
    console.warn(`[fx] ${tag} failed:`, err?.message || err);
  }

  dispose() {
    for (const off of this._unsub) {
      try {
        off();
      } catch {
        /* best effort */
      }
    }
    this._unsub.length = 0;
    for (const { scene, prev } of this._hooks) {
      try {
        scene.onAfterRender = prev || function () {};
        delete scene.__codFxHook;
      } catch {
        /* best effort */
      }
    }
    this._hooks.length = 0;
    for (const s of this._lights) {
      try {
        this.ctx.lighting?.removeLight?.(s.handle);
      } catch {
        /* best effort */
      }
    }
    this._lights.length = 0;
    this.particles?.dispose();
    this.tracers?.dispose?.();
    this.impacts?.dispose?.();
    this.smoke?.dispose?.();
    this.muzzleFx?.dispose?.();
    this.distortion?.dispose();
    this._rtDepth?.dispose();
    this._rtScene?.dispose();
    this.depthMat?.dispose();
    this.copyMat?.dispose();
    this._quadMesh?.geometry?.dispose();
    this.ready = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════ system ══ */

/** @returns {import('../core/types.js').System} */
export default function createFXSystem(ctx) {
  const fx = new FX(ctx);

  const api = {
    ready: false,
    _impl: fx,
    TYPE,
    impact: (a, b, c) => fx.impact(a, b, c),
    tracer: (a, b, c) => fx.tracer(a, b, c),
    muzzle: (a, b, c) => fx.muzzle(a, b, c),
    explosion: (a, b) => fx.explosion(a, b),
    smoke: (o) => fx.smokeGrenade(o),
    brass: (a, b, c) => fx.brass(a, b, c),
    spawn: (n, t, o) => fx.spawn(n, t, o),
    burst: (t, o) => fx.burst(t, o),
    register: (n, d) => fx.register(n, d),
    registerEmitter: (n, d) => fx.register(n, d),
    emitters: () => [...fx.emitters.keys()],
    light: (o) => fx.light(o),
    distort: (o) => fx.distort(o),
    clear: () => fx.clear(),
    get particles() {
      return fx.particles;
    },
    get stats() {
      return fx.stats;
    },
  };

  return {
    name: 'fx',
    order: 40,

    async init() {
      try {
        fx.init();
        api.ready = true;
        ctx.fx = api;
      } catch (err) {
        console.warn('[fx] init failed, effects disabled:', err?.message || err);
        fx.broken = true;
        // Hand back a bare object: ballistics and weapons both probe for our
        // methods and fall back to their own minimal versions when absent.
        ctx.fx = { ready: false, _impl: fx };
      }
    },

    update(dt) {
      fx.update(dt);
    },

    resize(w, h) {
      if (!fx.ready) return;
      try {
        fx.resize(w, h);
      } catch (err) {
        console.warn('[fx] resize failed:', err?.message || err);
      }
    },

    dispose() {
      try {
        fx.dispose();
      } catch {
        /* teardown is best-effort */
      }
    },
  };
}
