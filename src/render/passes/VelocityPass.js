/**
 * VelocityPass — screen-space motion vectors for TAA and motion blur.
 * Owner: render-pipeline agent.
 *
 * Two tiers, so the common case costs one fullscreen triangle:
 *
 *  1. Camera-only reprojection. Every pixel is unprojected from the current depth
 *     buffer, then reprojected with the *previous* frame's un-jittered view-projection.
 *     Exact for static geometry, which is nearly all of a level.
 *
 *  2. Per-object velocity, opt-in. Any object in ctx.scene with
 *     `userData.dynamic === true` gets its previous world matrix tracked and is
 *     re-rendered into the velocity buffer through a proxy mesh (we never mutate
 *     another system's object). Proxies share geometry — no extra GPU memory.
 *     Depth-tested manually against tDepth so hidden movers don't leak velocity.
 *
 * Encoding: RG16F, velocity = currentUV - previousUV (i.e. `history = uv - v`).
 * Viewmodel pixels are handled by consumers via `viewmodelMask()` (velocity 0).
 */
import * as THREE from 'three';
import { Pass, postMaterial, blit } from './Pass.js';

const CAMERA_VELOCITY_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
varying vec2 vUv;

void main() {
  float d = texture2D( tDepth, vUv ).x;
  if ( d >= 1.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }

  vec4 clip = vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 world = uInvViewProj * clip;
  world /= world.w;

  vec4 prevClip = uPrevViewProj * world;
  // Behind the previous camera: no usable history.
  if ( prevClip.w <= 1e-6 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 0.0 ); return; }
  vec2 prevUv = ( prevClip.xy / prevClip.w ) * 0.5 + 0.5;

  gl_FragColor = vec4( vUv - prevUv, 0.0, 1.0 );
}
`;

const OBJECT_VELOCITY_VERT = /* glsl */ `
uniform mat4 uPrevModelMatrix;
uniform mat4 uPrevViewProj;
uniform mat4 uCurViewProj;
varying vec4 vCurClip;
varying vec4 vPrevClip;

void main() {
  vec4 local = vec4( position, 1.0 );

  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
  #endif

  vec4 worldPos  = modelMatrix * local;
  vec4 prevWorld = uPrevModelMatrix * local;

  vCurClip = uCurViewProj * worldPos;
  vPrevClip = uPrevViewProj * prevWorld;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const OBJECT_VELOCITY_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uResolution;
varying vec4 vCurClip;
varying vec4 vPrevClip;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  // Manual depth test: the velocity target has no depth attachment so that it can
  // sample the scene depth texture without a framebuffer feedback loop.
  float sceneD = texture2D( tDepth, uv ).x;
  if ( gl_FragCoord.z > sceneD + 2.0e-5 ) discard;

  vec2 cur  = ( vCurClip.xy  / max( vCurClip.w,  1e-6 ) ) * 0.5 + 0.5;
  vec2 prev = ( vPrevClip.xy / max( vPrevClip.w, 1e-6 ) ) * 0.5 + 0.5;
  gl_FragColor = vec4( cur - prev, 0.0, 1.0 );
}
`;

export default class VelocityPass extends Pass {
  constructor(ctx, shared) {
    super('velocity', ctx, shared);

    this.uniforms = {
      tDepth: shared.tDepth,
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
    };
    this.material = this.own(
      postMaterial('velocity:camera', CAMERA_VELOCITY_FRAG, this.uniforms)
    );

    this.target = null;

    // Per-object proxies.
    this._proxies = new Map(); // sourceUUID -> { mesh, mat, src, seen }
    this._proxyScene = new THREE.Scene();
    this._proxyScene.matrixAutoUpdate = false;
    this._prevMatrices = new Map(); // sourceUUID -> Matrix4
    this._curViewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._tmpVP = new THREE.Matrix4();
    this._scan = 0;
    this._dynamic = [];
    this.hasDynamic = false;
  }

  setSize(w, h) {
    super.setSize(w, h);
    this.retarget(
      'target',
      new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
      })
    );
    this.target.texture.name = 'velocity';
    this.g.tVelocity.value = this.target.texture;
  }

  /** Collect `userData.dynamic` meshes. Re-scanned every few frames, not every frame. */
  _collect(scene) {
    this._dynamic.length = 0;
    scene.traverseVisible((o) => {
      if (o.userData && o.userData.dynamic === true && o.isMesh && o.geometry) {
        this._dynamic.push(o);
      }
    });
    this.hasDynamic = this._dynamic.length > 0;
  }

  _proxyFor(src) {
    let p = this._proxies.get(src.uuid);
    if (p && p.src === src && p.geometry === src.geometry) return p;
    if (p) {
      p.mat.dispose();
      this._proxyScene.remove(p.mesh);
    }
    const mat = new THREE.ShaderMaterial({
      name: 'velocity:object',
      uniforms: {
        tDepth: this.g.tDepth,
        uResolution: this.g.uResolution,
        uPrevModelMatrix: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: this._prevViewProj },
        uCurViewProj: { value: this._curViewProj },
      },
      vertexShader: OBJECT_VELOCITY_VERT,
      fragmentShader: OBJECT_VELOCITY_FRAG,
      depthTest: false,
      depthWrite: false,
      side: src.material?.side ?? THREE.FrontSide,
    });
    mat.toneMapped = false;
    let mesh;
    if (src.isInstancedMesh) {
      mesh = new THREE.InstancedMesh(src.geometry, mat, src.count);
      mesh.instanceMatrix = src.instanceMatrix;
    } else {
      mesh = new THREE.Mesh(src.geometry, mat);
    }
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    p = { mesh, mat, src, geometry: src.geometry };
    this._proxies.set(src.uuid, p);
    this._proxyScene.add(mesh);
    return p;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {THREE.Matrix4} prevViewProjUnjittered
   * @param {THREE.Matrix4} curViewProjUnjittered
   * @param {THREE.Matrix4} curViewProjJittered  matches how tDepth was rendered
   */
  render(renderer, scene, camera, prevVP, curVP, curVPJittered) {
    if (!this.target) return null;
    this._prevViewProj.copy(prevVP);
    this._curViewProj.copy(curVP);
    this.uniforms.uPrevViewProj.value.copy(prevVP);
    /**
     * **Both ends of the reprojection must be un-jittered.**
     *
     * The obvious-looking thing is to unproject with the matrix the depth buffer was
     * actually rendered with (`curVPJittered`), because that is geometrically exact for
     * the sample the rasteriser took. It is also wrong for TAA, and it is the single
     * most expensive kind of wrong: with a *completely static* camera it makes the
     * recovered world point sit on the jittered ray rather than the pixel-centre ray,
     * so reprojecting it through the un-jittered previous matrix returns
     * `uv - currentJitter` instead of `uv`. Velocity is then not zero but the Halton
     * offset itself — about half a pixel, in a different direction every frame.
     *
     * TAA history is an estimate of the converged value *at pixel centres*, so it must
     * be fetched at `uv` when nothing moved. Fetching it half a pixel away instead
     * resamples the history through a bicubic filter every single frame; at a 0.96
     * feedback that is a low-pass filter applied ~25 times per second to an image that
     * never gets a chance to reconverge. The frame goes soft and *stays* soft no matter
     * how long it is left to settle — which is exactly what a 48-frame warm-up showed.
     *
     * Using the un-jittered matrix here costs a sub-pixel lateral error in the
     * unprojected position (second order in jitter x parallax, i.e. invisible) and
     * gives an exactly-zero motion vector for static geometry under a static camera,
     * which is what every consumer of this buffer assumes.
     */
    this.uniforms.uInvViewProj.value.copy(curVP).invert();

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    blit(renderer, this.material, this.target);

    // --- per-object -------------------------------------------------------
    if (this._scan-- <= 0) {
      this._scan = 6;
      this._collect(scene);
    }
    if (!this.hasDynamic) return this.target;

    for (const p of this._proxies.values()) p.mesh.visible = false;
    for (const src of this._dynamic) {
      const p = this._proxyFor(src);
      p.mesh.visible = true;
      p.mesh.matrix.copy(src.matrixWorld);
      if (src.isInstancedMesh) {
        p.mesh.count = src.count;
        p.mesh.instanceMatrix = src.instanceMatrix;
      }
      let prev = this._prevMatrices.get(src.uuid);
      if (!prev) {
        prev = new THREE.Matrix4().copy(src.matrixWorld);
        this._prevMatrices.set(src.uuid, prev);
      }
      p.mat.uniforms.uPrevModelMatrix.value.copy(prev);
      p.mat.uniformsNeedUpdate = true;
    }
    renderer.render(this._proxyScene, camera);
    // Store this frame's transform for the next one.
    for (const src of this._dynamic) {
      this._prevMatrices.get(src.uuid).copy(src.matrixWorld);
    }
    return this.target;
  }

  dispose() {
    for (const p of this._proxies.values()) {
      p.mat.dispose();
      this._proxyScene.remove(p.mesh);
    }
    this._proxies.clear();
    this._prevMatrices.clear();
    super.dispose();
  }
}
