/**
 * RenderPipeline — the HDR render graph and post-processing chain.
 * Owner: render-pipeline agent. Files owned: this file + src/render/passes/**.
 * Publishes: `ctx.pipeline`.
 *
 * Everything is hand written against `THREE.WebGLRenderTarget`; nothing from
 * `three/examples/jsm/postprocessing` is used, so precision, ordering and cost are all
 * explicit.
 *
 * ── Frame graph ─────────────────────────────────────────────────────────────────
 *   world      -> rtScene (RGBA16F + DepthTexture "Dworld")
 *   velocity   -> rtVelocity (RG in RGBA16F; camera reprojection + per-object movers)
 *   hi-Z       -> min-depth pyramid (mip atlas) for SSR
 *   g-buffer   -> half-res (·, roughness, metalness) via stand-in materials
 *   GTAO       -> half-res visibility + bilateral blur
 *   SSR        -> half-res hierarchical trace + roughness cone
 *   volumetric -> quarter-res raymarch + temporal accumulation
 *   composite  -> rtComp   (AO on indirect only, + SSR, + in-scattering)
 *   viewmodel  -> rtComp   (own depth attachment "Dview", cleared first so the weapon
 *                           can never clip into the world; post still sees it through
 *                           `sceneDepthLinear()`)
 *   TAA        -> history ping-pong (Halton jitter, YCoCg variance clip)
 *   exposure   -> 1x1 adaptation (mip-chain reduction, no readback)
 *   bloom      -> 6-mip Karis downsample + tent upsample, + lens flare
 *   DOF        -> physical CoC, split near/far gather
 *   motion blur-> tile-max / neighbour-max reconstruction
 *   tonemap    -> exposure, bloom, AgX, grade
 *   lens       -> CA / vignette / grain -> sRGB
 *   FXAA       -> only when TAA is off
 *
 * ── Public API (ctx.pipeline) ───────────────────────────────────────────────────
 *   render(dt)
 *   setPassEnabled(name, bool)
 *   setDebugView(mode | null)
 *   resize(w, h)
 *   setQuality(tier)
 *   getPass(name)
 *   passes            {name: Pass}
 *   grade             live colour-grade knobs (see TonemapPass)
 *   lens              live lens knobs (see LensPass)
 *   setEnvironmentColors(horizon, zenith, ground)   SSR/probe fallback tint
 *   stats             {passes, targets, jitterIndex}
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   quality:changed, setting:changed, engine:resize, debug:pose, debug:cameraLock,
 *   player:teleport, weapon:ads {ads}, weapon:equip
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   pipeline:ready {passes}
 */
import * as THREE from 'three';
import { disposeRT, blit } from './passes/Pass.js';
import VelocityPass from './passes/VelocityPass.js';
import GBufferPass from './passes/GBufferPass.js';
import HiZPass from './passes/HiZPass.js';
import GTAOPass from './passes/GTAOPass.js';
import SSRPass from './passes/SSRPass.js';
import VolumetricPass from './passes/VolumetricPass.js';
import CompositePass from './passes/CompositePass.js';
import TAAPass from './passes/TAAPass.js';
import AutoExposurePass from './passes/AutoExposurePass.js';
import BloomPass from './passes/BloomPass.js';
import DOFPass from './passes/DOFPass.js';
import MotionBlurPass from './passes/MotionBlurPass.js';
import TonemapPass from './passes/TonemapPass.js';
import LensPass from './passes/LensPass.js';
import FXAAPass from './passes/FXAAPass.js';
import DebugPass, { DEBUG_MODES } from './passes/DebugPass.js';

const ALIASES = {
  gtao: 'gtao',
  ssao: 'gtao',
  ao: 'gtao',
  ssr: 'ssr',
  reflections: 'ssr',
  volumetrics: 'volumetrics',
  godrays: 'volumetrics',
  fog: 'volumetrics',
  taa: 'taa',
  bloom: 'bloom',
  dof: 'dof',
  depthOfField: 'dof',
  motionBlur: 'motionBlur',
  tonemap: 'tonemap',
  grade: 'tonemap',
  lens: 'lens',
  fxaa: 'fxaa',
  autoExposure: 'autoExposure',
  exposure: 'autoExposure',
  velocity: 'velocity',
  gbuffer: 'gbuffer',
  composite: 'composite',
  hiz: 'hiz',
};

class RenderPipeline {
  constructor(ctx) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    this.ready = false;
    this.broken = false;
    this.width = 1;
    this.height = 1;
    this.frame = 0;

    /** Per-pass on/off overrides set through setPassEnabled(). */
    this.overrides = Object.create(null);
    this.passes = Object.create(null);
    this.debugMode = null;
    this._warned = false;
    this._unsub = [];

    // Shared uniform objects — one instance referenced by every material that needs
    // them, so a single write updates the whole graph.
    this.shared = {
      tDepth: { value: null },
      tDepthView: { value: null },
      tVelocity: { value: null },
      tAO: { value: null },
      tSSR: { value: null },
      tVolume: { value: null },
      tGBuffer: { value: null },
      tHiZ: { value: null },
      tBloom: { value: null },
      tFlare: { value: null },
      tDirt: { value: null },
      tExposure: { value: null },
      uHiZRect: { value: [] },
      uHiZLevels: { value: 1 },
      uCam: { value: new THREE.Vector4(0.05, 2000, 0.002, 12) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uProj: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
      uFrame: { value: 0 },
      uTime: { value: 0 },
    };

    // Matrices for reprojection.
    this._prevViewProj = new THREE.Matrix4();
    this._curViewProj = new THREE.Matrix4();
    this._curViewProjJittered = new THREE.Matrix4();
    this._unjitteredProj = new THREE.Matrix4();
    this._jitter = new THREE.Vector2();
    this._prevCamPos = new THREE.Vector3();
    this._prevCamQuat = new THREE.Quaternion();
    this._tmpV3 = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._savedClear = new THREE.Color();

    this._resetHistory = 2;

    // Full-res targets.
    this.rtScene = null;
    this.rtComp = null;
    this.rtA = null;
    this.rtB = null;
    this.rtLDR = null;
    this.rtLDR2 = null;
  }

  /* ------------------------------------------------------------------ setup */

  init() {
    const ctx = this.ctx;
    const P = this.passes;
    P.velocity = new VelocityPass(ctx, this.shared);
    P.gbuffer = new GBufferPass(ctx, this.shared);
    P.hiz = new HiZPass(ctx, this.shared);
    P.gtao = new GTAOPass(ctx, this.shared);
    P.ssr = new SSRPass(ctx, this.shared);
    P.volumetrics = new VolumetricPass(ctx, this.shared);
    P.composite = new CompositePass(ctx, this.shared);
    P.taa = new TAAPass(ctx, this.shared);
    P.autoExposure = new AutoExposurePass(ctx, this.shared);
    P.bloom = new BloomPass(ctx, this.shared);
    P.dof = new DOFPass(ctx, this.shared);
    P.motionBlur = new MotionBlurPass(ctx, this.shared);
    P.tonemap = new TonemapPass(ctx, this.shared);
    P.lens = new LensPass(ctx, this.shared);
    P.fxaa = new FXAAPass(ctx, this.shared);
    P.debug = new DebugPass(ctx, this.shared);

    this.grade = P.tonemap.grade;
    this.lens = P.lens.settings;
    this.dof = P.dof;

    // We tonemap ourselves; three must hand us raw linear HDR.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.setQuality(ctx.settings?.tier || 'high', false);
    this.setSize(size.x || 1280, size.y || 720);

    this._bind();
    this.ready = true;
    ctx.bus?.emit?.('pipeline:ready', { passes: Object.keys(P) });
  }

  _bind() {
    const bus = this.ctx.bus;
    if (!bus?.on) return;
    const on = (ev, fn) => {
      const off = bus.on(ev, fn);
      if (typeof off === 'function') this._unsub.push(off);
    };
    on('quality:changed', ({ tier }) => {
      this.setQuality(tier, true);
      this.resetHistory();
    });
    on('setting:changed', ({ key }) => {
      if (key === 'renderScale' || key === 'maxPixelRatio') this.resetHistory();
      if (key === 'exposure') this.resetHistory();
    });
    // A pose jump, teleport or camera lock invalidates every temporal buffer.
    on('debug:pose', () => this.resetHistory());
    on('debug:cameraLock', () => this.resetHistory());
    on('player:teleport', () => this.resetHistory());
    on('player:respawn', () => this.resetHistory());
    on('weapon:ads', (e) => {
      this.passes.dof.ads = !!(e && (e.ads ?? e.value ?? e.state));
    });
    // Keep the SSR probe fallback in step with the real IBL.
    on('lighting:ready', () => this.syncEnvironment());
    on('lighting:env', () => this.syncEnvironment());
    on('lighting:timeOfDay', () => this.syncEnvironment());
  }

  /**
   * Pull an up / horizon / down radiance estimate out of `ctx.lighting` so a screen
   * space reflection that misses fades into something that matches the actual IBL
   * instead of a hard-coded blue. Uses the documented `ambientIrradiance(normal)`
   * hook; silently keeps the previous values if lighting has not published one.
   */
  syncEnvironment() {
    const L = this.ctx.lighting;
    if (typeof L?.ambientIrradiance !== 'function') return;
    const u = this.passes.ssr?.uniforms;
    if (!u) return;
    try {
      const N = this._envN || (this._envN = new THREE.Vector3());
      const INV_PI = 1 / Math.PI;
      const grab = (x, y, z, out) => {
        const c = L.ambientIrradiance(N.set(x, y, z));
        if (!c || !Number.isFinite(c.r)) return false;
        out.set(Math.max(c.r, 0) * INV_PI, Math.max(c.g, 0) * INV_PI, Math.max(c.b, 0) * INV_PI);
        return true;
      };
      grab(0, 1, 0, u.uEnvZenith.value);
      grab(0.94, 0.34, 0, u.uEnvHorizon.value);
      grab(0, -1, 0, u.uEnvGround.value);
    } catch {
      /* lighting is allowed to be half-built; keep the previous estimate */
    }
  }

  /* ----------------------------------------------------------------- resize */

  setSize(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.width && h === this.height && this.rtScene) return;
    this.width = w;
    this.height = h;
    this.shared.uResolution.value.set(w, h);

    this._allocTargets(w, h);
    for (const key of Object.keys(this.passes)) {
      try {
        this.passes[key].setSize(w, h);
      } catch (err) {
        this._warn(`pass ${key}.setSize failed`, err);
      }
    }
    this.resetHistory();
  }

  resize(w, h) {
    this.setSize(w, h);
  }

  _allocTargets(w, h) {
    const hdr = (name, depth) => {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: !!depth,
        stencilBuffer: false,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
      });
      rt.texture.name = name;
      if (depth) {
        const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
        dt.format = THREE.DepthFormat;
        dt.minFilter = THREE.NearestFilter;
        dt.magFilter = THREE.NearestFilter;
        dt.name = `${name}.depth`;
        rt.depthTexture = dt;
      }
      return rt;
    };
    const ldr = (name) => {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.UnsignedByteType,
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

    for (const k of ['rtScene', 'rtComp', 'rtA', 'rtB', 'rtLDR', 'rtLDR2']) {
      disposeRT(this[k]);
      this[k] = null;
    }
    this.rtScene = hdr('hdr.scene', true);
    this.rtComp = hdr('hdr.composite', true);
    this.rtA = hdr('hdr.a', false);
    this.rtB = hdr('hdr.b', false);
    /**
     * `rtLDR` holds the tonemapped, graded frame — display-referred but still **linear**
     * (LensPass owns the sRGB encode, because the vignette and the chromatic
     * aberration have to happen on linear light). Storing linear light in 8 bits is a
     * banding factory: one code value is 1/255 = 0.0039 linear, which is sRGB 0.0637,
     * i.e. the whole bottom 16/255 of the display range collapses into a single step.
     * Every shadow in the frame comes back as visible steps. Half-float costs one more
     * full-res RGBA16F buffer and removes the banding completely.
     */
    this.rtLDR = hdr('ldr.a', false);
    // rtLDR2 is post-LensPass, so it is already sRGB-encoded: 8 bits is correct there.
    this.rtLDR2 = ldr('ldr.b');

    this.shared.tDepth.value = this.rtScene.depthTexture;
    this.shared.tDepthView.value = this.rtComp.depthTexture;
  }

  /* ---------------------------------------------------------------- quality */

  setQuality(tier, resize = true) {
    const s = this.ctx.settings;
    const t = tier || s?.tier || 'high';
    const headless = !!s?.get?.('headless');
    this.tier = t;
    const P = this.passes;
    P.gtao?.setQuality?.(t, headless);
    P.ssr?.setQuality?.(t, headless);
    P.volumetrics?.setQuality?.(t, headless);
    P.bloom?.setQuality?.(t, headless);
    P.dof?.setQuality?.(t, headless);
    P.motionBlur?.setQuality?.(t, headless);
    if (resize && this.rtScene) {
      // Half/quarter-res buffers depend on the tier: rebuild them.
      for (const key of Object.keys(this.passes)) {
        try {
          this.passes[key].setSize(this.width, this.height);
        } catch (err) {
          this._warn(`pass ${key}.setSize failed`, err);
        }
      }
    }
  }

  /* --------------------------------------------------------------- controls */

  setPassEnabled(name, on) {
    const key = ALIASES[name] || name;
    if (!this.passes[key]) return false;
    this.overrides[key] = !!on;
    if (key === 'taa') this.resetHistory();
    return true;
  }

  isEnabled(key) {
    if (key in this.overrides) return this.overrides[key];
    const s = this.ctx.settings;
    const g = (k, d) => (s?.get ? (s.get(k) ?? d) : d);
    switch (key) {
      case 'gtao':
        return !!g('ssao', true);
      case 'ssr':
        return !!g('ssr', true);
      case 'volumetrics':
        return !!g('volumetrics', true) && (g('volumetricSteps', 32) | 0) > 0;
      case 'taa':
        return !!g('taa', true);
      case 'bloom':
        return !!g('bloom', true);
      case 'dof':
        return !!g('dof', true);
      case 'motionBlur':
        return !!g('motionBlur', true);
      case 'fxaa':
        // FXAA is the fallback: on whenever TAA is not resolving the frame.
        return !this.isEnabled('taa') || !!g('fxaa', false);
      case 'lens':
        return true;
      case 'tonemap':
        return true;
      case 'autoExposure':
        return true;
      default:
        return true;
    }
  }

  setDebugView(mode) {
    if (mode && !(mode in DEBUG_MODES)) {
      this.debugMode = null;
      this.passes.debug?.setMode(null);
      return false;
    }
    this.debugMode = mode || null;
    this.passes.debug?.setMode(this.debugMode);
    return true;
  }

  getPass(name) {
    return this.passes[ALIASES[name] || name] || null;
  }

  resetHistory() {
    this._resetHistory = 2;
    this.passes.taa?.reset?.();
    this.passes.volumetrics?.reset?.();
    this.passes.autoExposure?.reset?.();
    this.passes.dof?.resetFocus?.();
  }

  setEnvironmentColors(horizon, zenith, ground) {
    const u = this.passes.ssr?.uniforms;
    if (!u) return;
    if (horizon) u.uEnvHorizon.value.set(horizon.r ?? horizon.x, horizon.g ?? horizon.y, horizon.b ?? horizon.z);
    if (zenith) u.uEnvZenith.value.set(zenith.r ?? zenith.x, zenith.g ?? zenith.y, zenith.b ?? zenith.z);
    if (ground) u.uEnvGround.value.set(ground.r ?? ground.x, ground.g ?? ground.y, ground.b ?? ground.z);
  }

  /* ----------------------------------------------------------------- render */

  render(dt) {
    if (!this.ready || this.broken) return this._fallbackRender();
    try {
      this._render(Number.isFinite(dt) ? Math.min(Math.max(dt, 1e-5), 0.25) : 1 / 60);
    } catch (err) {
      this._warn('render failed, falling back to forward rendering', err);
      this.broken = true;
      this._restoreCameras();
      this._fallbackRender();
    }
  }

  _fallbackRender() {
    const r = this.renderer;
    const ctx = this.ctx;
    r.setRenderTarget(null);
    r.clear(true, true, false);
    r.render(ctx.scene, ctx.camera);
    r.clearDepth();
    r.render(ctx.viewScene, ctx.viewCamera);
  }

  _render(dt) {
    const r = this.renderer;
    const ctx = this.ctx;
    const cam = ctx.camera;
    const viewCam = ctx.viewCamera;
    const S = this.shared;

    this.frame++;
    S.uFrame.value = this.frame % 4096;
    // Lighting may come up after us, and the sky drifts with time of day.
    if (this.frame % 45 === 1) this.syncEnvironment();
    S.uTime.value = ctx.time?.elapsed ?? S.uTime.value + dt;

    const taaOn = this.isEnabled('taa');
    const fxaaOn = this.isEnabled('fxaa');
    const aoOn = this.isEnabled('gtao');
    const ssrOn = this.isEnabled('ssr');
    const volOn = this.isEnabled('volumetrics');
    const bloomOn = this.isEnabled('bloom');
    const dofOn = this.isEnabled('dof');
    const mbOn = this.isEnabled('motionBlur');
    const debug = this.debugMode;

    // Renderer state we own for the duration of the frame.
    r.autoClear = false;
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = 1;
    r.getClearColor(this._savedClear);
    const savedAlpha = r.getClearAlpha();

    // --- camera matrices, jitter --------------------------------------------
    cam.updateMatrixWorld();
    viewCam.updateMatrixWorld();
    this._unjitteredProj.copy(cam.projectionMatrix);
    this._unjitteredViewProj = this._unjitteredViewProj || new THREE.Matrix4();
    this._unjitteredViewProj.multiplyMatrices(this._unjitteredProj, cam.matrixWorldInverse);

    this._detectCameraJump(cam);

    if (taaOn) {
      this.passes.taa.currentJitter(this._jitter, this.width, this.height);
      this._applyJitter(cam, this._jitter);
      this._applyJitter(viewCam, this._jitter);
    } else {
      this._jitter.set(0, 0);
    }

    S.uProj.value.copy(cam.projectionMatrix);
    S.uInvProj.value.copy(cam.projectionMatrix).invert();
    S.uInvView.value.copy(cam.matrixWorld);
    S.uCam.value.set(cam.near, cam.far, viewCam.near, viewCam.far);
    this._curViewProjJittered.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._curViewProj.copy(this._unjitteredViewProj);

    const historyValid = this._resetHistory <= 0;

    // --- 1. world -> HDR -----------------------------------------------------
    r.setRenderTarget(this.rtScene);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(ctx.scene, cam);

    // --- 2. velocity ---------------------------------------------------------
    this.passes.velocity.render(
      r,
      ctx.scene,
      cam,
      this._prevViewProj,
      this._curViewProj,
      this._curViewProjJittered
    );

    // --- 3. surface parameters + hierarchical depth (only when SSR needs them)
    const needGBuffer =
      ssrOn || debug === 'roughness' || debug === 'metalness' || debug === 'albedo';
    if (needGBuffer) {
      // Shadow maps are already up to date from the main pass; re-rendering them for
      // every extra geometry pass would triple the shadow cost.
      const shadows = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      try {
        this.passes.gbuffer.render(r, ctx.scene, cam, 'orm');
      } finally {
        r.shadowMap.autoUpdate = shadows;
      }
    }
    if (ssrOn) this.passes.hiz.render(r);

    // --- 4. screen-space lighting -------------------------------------------
    // Sun sync is cheap and the composite's "AO on indirect only" heuristic needs the
    // sun direction whether or not volumetrics is running.
    this.passes.volumetrics.syncLighting(cam);
    this.passes.composite.uniforms.uSunDirView.value.copy(
      this.passes.volumetrics.uniforms.uSunDirView.value
    );

    if (aoOn) this.passes.gtao.render(r);
    if (ssrOn) this.passes.ssr.render(r, this.rtScene.texture);
    if (volOn) this.passes.volumetrics.render(r, cam, historyValid);

    // --- 5. composite --------------------------------------------------------
    this.passes.composite.render(r, this.rtScene.texture, this.rtComp, {
      ao: aoOn,
      ssr: ssrOn,
      volume: volOn,
    });

    // --- 6. viewmodel on top, with its own depth ----------------------------
    r.setRenderTarget(this.rtComp);
    r.clear(false, true, false);
    if (ctx.viewScene && ctx.viewScene.children.length) {
      r.render(ctx.viewScene, viewCam);
    }

    // --- 7. TAA --------------------------------------------------------------
    let current = this.rtComp.texture;
    if (taaOn) {
      const resolved = this.passes.taa.render(r, this.rtComp.texture);
      current = resolved.texture;
    }

    // --- 8. exposure ---------------------------------------------------------
    this.passes.autoExposure.prime(r);
    const exposureBias = this.ctx.settings?.get?.('exposure') ?? 1;
    if (this.isEnabled('autoExposure')) {
      this.passes.autoExposure.render(r, current, dt, exposureBias);
    }

    // --- 9. bloom + flare ----------------------------------------------------
    if (bloomOn) this.passes.bloom.render(r, current);

    // --- 10. depth of field --------------------------------------------------
    if (dofOn) {
      this.passes.dof.render(r, current, this.rtA, dt);
      current = this.rtA.texture;
    }

    // --- 11. motion blur -----------------------------------------------------
    if (mbOn && historyValid) {
      this.passes.motionBlur.render(r, current, this.rtB, dt);
      current = this.rtB.texture;
    }

    // --- 12. tonemap + grade -------------------------------------------------
    this.passes.tonemap.render(r, current, this.rtLDR, bloomOn);

    // --- 13. lens + output ---------------------------------------------------
    const lensTarget = fxaaOn ? this.rtLDR2 : null;
    this.passes.lens.render(r, this.rtLDR.texture, lensTarget, {
      aberration: !!(this.ctx.settings?.get?.('chromaticAberration') ?? true),
      grain: !!(this.ctx.settings?.get?.('grain') ?? true),
    });
    if (fxaaOn) this.passes.fxaa.render(r, this.rtLDR2.texture, null);

    // --- 14. debug override --------------------------------------------------
    if (debug) this._renderDebug(debug, current);

    // --- bookkeeping ---------------------------------------------------------
    this._prevViewProj.copy(this._curViewProj);
    this._prevCamPos.setFromMatrixPosition(cam.matrixWorld);
    this._prevCamQuat.copy(cam.quaternion);
    if (taaOn) this.passes.taa.advance();
    if (this._resetHistory > 0) this._resetHistory--;

    this._restoreCameras();
    r.setClearColor(this._savedClear, savedAlpha);
    r.setRenderTarget(null);
  }

  _renderDebug(mode, currentTexture) {
    const r = this.renderer;
    const ctx = this.ctx;
    let source = currentTexture;

    // rtComp owns a depth attachment, which these geometry re-renders need. It has
    // already been consumed by TAA at this point in the frame, so it is free.
    const scratch = this.rtComp;

    if (mode === 'albedo') {
      // The g-buffer pass renders albedo at half res; the debug view wants it
      // full-res and untonemapped, so re-render it here.
      const shadows = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      r.setRenderTarget(scratch);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, false);
      this.passes.gbuffer.swapIn(ctx.scene, 'albedo');
      try {
        r.render(ctx.scene, ctx.camera);
      } finally {
        this.passes.gbuffer.swapOut();
        r.shadowMap.autoUpdate = shadows;
      }
      source = scratch.texture;
    } else if (mode === 'overdraw') {
      const shadows = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      r.setRenderTarget(scratch);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, false);
      const prev = ctx.scene.overrideMaterial;
      ctx.scene.overrideMaterial = this.passes.debug.overdrawMaterial;
      try {
        r.render(ctx.scene, ctx.camera);
      } finally {
        ctx.scene.overrideMaterial = prev;
        r.shadowMap.autoUpdate = shadows;
      }
      source = scratch.texture;
    } else if (mode === 'roughness' || mode === 'metalness') {
      // Ensure the ORM buffer exists even when SSR is off.
      if (!this.isEnabled('ssr')) {
        const shadows = r.shadowMap.autoUpdate;
        r.shadowMap.autoUpdate = false;
        try {
          this.passes.gbuffer.render(r, ctx.scene, ctx.camera, 'orm');
        } finally {
          r.shadowMap.autoUpdate = shadows;
        }
      }
    }
    this.passes.debug.render(r, source, null);
  }

  /* ------------------------------------------------------------------ jitter */

  _applyJitter(camera, jitter) {
    if (!camera._pipeUnjittered) camera._pipeUnjittered = new THREE.Matrix4();
    camera._pipeUnjittered.copy(camera.projectionMatrix);
    camera._pipeJittered = true;
    camera.projectionMatrix.elements[8] += jitter.x;
    camera.projectionMatrix.elements[9] += jitter.y;
  }

  _restoreCameras() {
    for (const camera of [this.ctx.camera, this.ctx.viewCamera]) {
      if (camera && camera._pipeJittered && camera._pipeUnjittered) {
        camera.projectionMatrix.copy(camera._pipeUnjittered);
        camera._pipeJittered = false;
      }
    }
  }

  /** A teleport or pose change makes every temporal buffer a lie. */
  _detectCameraJump(cam) {
    this._tmpV3.setFromMatrixPosition(cam.matrixWorld);
    const moved = this._tmpV3.distanceToSquared(this._prevCamPos);
    this._tmpQ.copy(cam.quaternion);
    const dot = Math.abs(this._tmpQ.dot(this._prevCamQuat));
    if (moved > 9 || dot < 0.86) this.resetHistory();
  }

  /* ------------------------------------------------------------------- misc */

  get stats() {
    return {
      passes: Object.keys(this.passes).filter((k) => this.isEnabled(k)),
      tier: this.tier,
      size: [this.width, this.height],
      jitterIndex: this.passes.taa?.index ?? 0,
      debugView: this.debugMode,
      broken: this.broken,
    };
  }

  _warn(msg, err) {
    if (this._warned) return;
    this._warned = true;
    console.warn(`[pipeline] ${msg}`, err || '');
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
    for (const key of Object.keys(this.passes)) {
      try {
        this.passes[key].dispose();
      } catch {
        /* best effort */
      }
    }
    for (const k of ['rtScene', 'rtComp', 'rtA', 'rtB', 'rtLDR', 'rtLDR2']) {
      disposeRT(this[k]);
      this[k] = null;
    }
    this.ready = false;
  }
}

/** @returns {import('../core/types.js').System} */
export default function createRenderPipeline(ctx) {
  const pipeline = new RenderPipeline(ctx);

  // A minimal always-valid API so nothing downstream ever sees `undefined`.
  const api = {
    ready: false,
    render: (dt) => pipeline.render(dt),
    setPassEnabled: (n, v) => pipeline.setPassEnabled(n, v),
    setDebugView: (m) => pipeline.setDebugView(m),
    resize: (w, h) => pipeline.setSize(w, h),
    setQuality: (t) => pipeline.setQuality(t),
    getPass: (n) => pipeline.getPass(n),
    resetHistory: () => pipeline.resetHistory(),
    setEnvironmentColors: (a, b, c) => pipeline.setEnvironmentColors(a, b, c),
    /** Compatibility with the stub contract in ARCHITECTURE.md §1. */
    addPass: () => false,
    get passes() {
      return pipeline.passes;
    },
    get grade() {
      return pipeline.passes.tonemap?.grade;
    },
    get lens() {
      return pipeline.passes.lens?.settings;
    },
    get dof() {
      return pipeline.passes.dof;
    },
    get stats() {
      return pipeline.stats;
    },
    get debugModes() {
      return Object.keys(DEBUG_MODES);
    },
    _impl: pipeline,
  };

  return {
    name: 'pipeline',
    order: 20,
    async init() {
      ctx.pipeline = api;
      try {
        pipeline.init();
        api.ready = true;
      } catch (err) {
        // Never take the frame down: degrade to a plain forward render.
        console.warn('[pipeline] init failed, forward rendering only:', err);
        pipeline.broken = true;
      }
    },
    resize(w, h) {
      if (pipeline.broken) return;
      try {
        pipeline.setSize(w, h);
      } catch (err) {
        console.warn('[pipeline] resize failed:', err);
      }
    },
    dispose() {
      pipeline.dispose();
    },
  };
}
