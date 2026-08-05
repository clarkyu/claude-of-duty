/**
 * weather/LensOverlay.js — the camera artefacts: rain on the front element, heat
 * shimmer over hot ground, and the sky lighting up when lightning strikes.
 * Owner: weather agent. Files owned: src/render/Weather.js, src/render/weather/**.
 *
 * ── Why this draws itself instead of being a pipeline pass ──────────────────────
 * `ctx.pipeline.addPass()` is a documented no-op, so there is no supported way to
 * inject a pass into the post chain. Putting the droplets in the world or viewmodel
 * scene instead would push them through TAA, and a screen-locked droplet field under
 * a moving camera is exactly the input TAA smears into mud.
 *
 * So we use the engine's own `onNextFrame()` hook, which runs after `pipeline.render()`
 * has finished and presented. At that point:
 *   - the default framebuffer holds the final, sRGB-encoded frame
 *   - `pipeline._impl.rtLDR` holds the same frame tonemapped and graded but still
 *     *linear*, one step before the lens pass — which is what we sample and refract
 *   - `pipeline._impl.rtScene.depthTexture` still holds world depth, for the shimmer
 *
 * We draw one small alpha-blended quad over the frame (droplets and shimmer only
 * cover the pixels they occupy — everywhere else discards, so the vignette and grain
 * underneath are untouched) and one additive quad for the flash. If any of those
 * buffers is missing the whole overlay silently switches itself off.
 */
import * as THREE from 'three';
import { LENS_VERT, LENS_FRAG, FLASH_FRAG } from './shaders.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class LensOverlay {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this.ready = false;
    this._warned = false;

    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.scene = new THREE.Scene();
    this.scene.name = 'weather.overlay';
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.dropsMat = new THREE.ShaderMaterial({
      name: 'weather:lens',
      vertexShader: LENS_VERT,
      fragmentShader: LENS_FRAG,
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        uCam: { value: new THREE.Vector4(0.05, 2000, 0.002, 12) },
        uResolution: { value: new THREE.Vector2(1280, 720) },
        uTime: { value: 0 },
        uAspect: { value: 16 / 9 },
        uDrops: { value: 0 },
        uRun: { value: 0 },
        uShimmer: { value: 0 },
        uHorizon: { value: 0.5 },
        uSpec: { value: new THREE.Color(0.75, 0.82, 1.0) },
        uHasDepth: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.flashMat = new THREE.ShaderMaterial({
      name: 'weather:flash',
      vertexShader: LENS_VERT,
      fragmentShader: FLASH_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(0.78, 0.85, 1.0) },
        uAmount: { value: 0 },
        uOrigin: { value: new THREE.Vector2(0.5, 0.85) },
        uSpread: { value: 0.6 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.dropsMesh = new THREE.Mesh(this.geometry, this.dropsMat);
    this.dropsMesh.frustumCulled = false;
    this.dropsMesh.renderOrder = 0;
    this.flashMesh = new THREE.Mesh(this.geometry, this.flashMat);
    this.flashMesh.frustumCulled = false;
    this.flashMesh.renderOrder = 1;
    this.scene.add(this.dropsMesh, this.flashMesh);

    /** Beads accumulate while it rains and evaporate when it stops. */
    this.wetLens = 0;
    this.ready = true;
  }

  setSize(w, h) {
    this.dropsMat.uniforms.uResolution.value.set(w, h);
    this.dropsMat.uniforms.uAspect.value = h > 0 ? w / h : 1.7778;
  }

  /**
   * @param {number} dt
   * @param {{drops:number, dropRun:number, shimmer:number, exposedToSky:number,
   *          time:number, flash:number, flashColor:THREE.Color, flashSpread:number,
   *          flashOrigin:THREE.Vector2, specColor:THREE.Color}} s
   */
  update(dt, s) {
    // Water builds on the lens far faster than it dries off it.
    const target = clamp(s.drops, 0, 1) * clamp(s.exposedToSky, 0, 1);
    const rate = target > this.wetLens ? 0.55 : 0.16;
    this.wetLens += (target - this.wetLens) * clamp(dt * rate, 0, 1);
    if (this.wetLens < 1e-4) this.wetLens = 0;

    const u = this.dropsMat.uniforms;
    u.uTime.value = s.time;
    u.uDrops.value = this.wetLens;
    u.uRun.value = 0.25 + 1.4 * clamp(s.dropRun, 0, 1);
    u.uShimmer.value = clamp(s.shimmer, 0, 1);
    u.uHorizon.value = s.horizon;
    if (s.specColor) u.uSpec.value.copy(s.specColor);

    const f = this.flashMat.uniforms;
    f.uAmount.value = Math.max(0, s.flash || 0);
    f.uSpread.value = clamp(s.flashSpread ?? 0.6, 0, 1);
    if (s.flashColor) f.uColor.value.copy(s.flashColor);
    if (s.flashOrigin) f.uOrigin.value.copy(s.flashOrigin);

    this.dropsMesh.visible = this.wetLens > 0.004 || u.uShimmer.value > 0.004;
    this.flashMesh.visible = f.uAmount.value > 0.0005;
  }

  get active() {
    return this.enabled && (this.dropsMesh.visible || this.flashMesh.visible);
  }

  /** Called from `engine.onNextFrame`, after the post chain has presented. */
  render() {
    if (!this.enabled || !this.ready) return;
    if (!this.dropsMesh.visible && !this.flashMesh.visible) return;
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    if (!renderer) return;

    const impl = ctx.pipeline?._impl;
    const sceneTex = impl?.rtLDR?.texture || null;
    const depthTex = impl?.rtScene?.depthTexture || null;
    const u = this.dropsMat.uniforms;
    u.tScene.value = sceneTex;
    u.tDepth.value = depthTex;
    u.uHasDepth.value = depthTex ? 1 : 0;
    const cam = ctx.camera;
    if (cam?.isPerspectiveCamera) u.uCam.value.set(cam.near, cam.far, 0.002, 12);

    // No linear source to refract: the droplets would be black. Flash still works.
    const canRefract = !!sceneTex;
    this.dropsMesh.visible = this.dropsMesh.visible && canRefract;
    if (!this.dropsMesh.visible && !this.flashMesh.visible) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.render(this.scene, this.camera);
    } catch (err) {
      if (!this._warned) {
        this._warned = true;
        console.warn('[weather] lens overlay disabled:', err?.message || err);
      }
      this.enabled = false;
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  dispose() {
    this.scene.clear();
    this.geometry.dispose();
    this.dropsMat.dispose();
    this.flashMat.dispose();
    this.ready = false;
  }
}

export default LensOverlay;
