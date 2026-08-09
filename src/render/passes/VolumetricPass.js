/**
 * VolumetricPass — raymarched single-scattering for the sun (god rays / light shafts).
 * Owner: render-pipeline agent.
 *
 * - Marches the view ray from the near plane to the scene depth at quarter resolution.
 * - Density is exponential height fog plus a uniform ground layer, so shafts are
 *   strongest low down and near openings, the way real dusty air behaves.
 * - Occlusion comes from one of two sources, in order of preference:
 *     1. A shadow map published explicitly by the lighting module through
 *        `ctx.lighting.getVolumetricShadow()`. Each raymarch step is then shadow-tested
 *        in 3D, which is the correct result.
 *     2. Otherwise a screen-space light-shaft mask: the depth buffer is turned into a
 *        "sky is the emitter" occlusion image and radially blurred away from the sun's
 *        screen position (Mitchell, GPU Gems 3). Cheap, needs nothing from any other
 *        module, and still produces shafts that are genuinely shaped by the geometry
 *        on screen.
 *
 *   The pass deliberately does NOT reach into `light.shadow.map` by itself. three.js
 *   does not mark a render target's DepthTexture as `isRenderTargetTexture`, so binding
 *   one as an ordinary sampler makes `WebGLTextures.setTexture2D` take the upload path
 *   and re-`texImage2D` it — which silently wipes the shadow map every other frame and
 *   renders the whole level in shadow on alternate frames. Anything handed to us via
 *   `getVolumetricShadow()` is flagged before use; see `_adoptShadowTexture`.
 * - Anisotropic Henyey-Greenstein phase (g ~ 0.72) gives the strong forward lobe that
 *   makes looking towards the sun glow.
 * - Blue-noise (interleaved-gradient) dithering of the first step offset, plus
 *   temporal accumulation reprojected through the velocity buffer, removes the banding
 *   that low step counts otherwise produce.
 * - Upsampled with a depth-aware bilateral filter so shafts do not bleed over edges.
 *
 * Wanted from `ctx.lighting` (all optional, all probed defensively):
 *   `lighting.sun`                  THREE.DirectionalLight
 *   `lighting.sunDirection`         THREE.Vector3, world-space direction *to* the sun
 *   `lighting.getVolumetricShadow()` -> { matrix: Matrix4, map: Texture, bias: number }
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, GLSL_DEPTH, postMaterial, blit, makeRT } from './Pass.js';

const MARCH_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tShadow;
uniform sampler2D tShaft;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform vec4 uCam;
uniform vec2 uResolution;
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform mat4 uShadowMatrix;
uniform vec3 uSunDirView;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFrame;
uniform float uDensity;
uniform float uHeightFalloff;
uniform float uGroundY;
uniform float uAnisotropy;
uniform float uAmbientScatter;
uniform float uMaxDistance;
uniform float uShadowBias;
uniform float uHasShadow;
uniform float uHistoryBlend;
uniform vec3 uCameraPos;
#if VOL_LIGHTS > 0
uniform float uVolLightCount;
uniform vec4 uVolLightPos[ VOL_LIGHTS ];   // xyz position, w radius^2 (0 = slot unused)
uniform vec4 uVolLightCol[ VOL_LIGHTS ];   // rgb radiance scale, w cos(inner cone)
uniform vec4 uVolLightDir[ VOL_LIGHTS ];   // xyz spot axis, w cos(outer cone), -1 = omni
#endif
varying vec2 vUv;

${GLSL_LIB}
${GLSL_DEPTH}

float densityAt( vec3 worldPos ) {
  float h = worldPos.y - uGroundY;
  return uDensity * exp( -max( h, 0.0 ) * uHeightFalloff );
}

float shadowAt( vec3 worldPos ) {
  if ( uHasShadow < 0.5 ) return 1.0;
  vec4 sc = uShadowMatrix * vec4( worldPos, 1.0 );
  sc.xyz /= max( sc.w, 1e-5 );
  if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;
  float ref = texture2D( tShadow, sc.xy ).x;
  return step( sc.z - uShadowBias, ref );
}

void main() {
  float rawD = texture2D( tDepth, vUv ).x;
  float sceneDist = linearizeDepth( rawD, uCam.x, uCam.y );

  vec3 dirVS = normalize( viewRay( vUv, uInvProj ) );
  // sceneDist is -viewZ; convert to a distance along the (normalised) ray.
  float travel = min( min( sceneDist, uMaxDistance ) / max( -dirVS.z, 1e-4 ), uMaxDistance );

  float cosTheta = dot( dirVS, uSunDirView );
  float phase = henyeyGreenstein( cosTheta, uAnisotropy );

  float dither = ignTemporal( gl_FragCoord.xy, uFrame );
  float stepLen = travel / float( STEPS );

  // Screen-space light-shaft occlusion, used when no shadow map is published.
  float shaftVis = texture2D( tShaft, vUv ).r;

  vec3 scatter = vec3( 0.0 );
  float transmittance = 1.0;

  vec3 camWorld = uCameraPos;
  mat3 invViewRot = mat3( uInvView );
#if VOL_LIGHTS > 0
  // The view ray in world space, for the local lights' phase term. Constant per pixel.
  vec3 rayW = normalize( invViewRot * dirVS );
#endif

  for ( int i = 0; i < STEPS; i ++ ) {
    float t = ( float( i ) + dither ) * stepLen;
    vec3 pVS = dirVS * t;
    vec3 pW = camWorld + invViewRot * pVS;

    float d = densityAt( pW ) * stepLen;
    if ( d <= 0.0 ) continue;

    float vis = uHasShadow > 0.5 ? shadowAt( pW ) : shaftVis;
    // Direct sun in-scattering plus a small ambient (sky) term, so the haze reads as
    // lit air rather than a black subtractive fog. Keep the ambient term low — this is
    // what turns into a milky veil over the whole frame if it is overcooked.
    //
    // The ambient term is sky light scattered into the ray, so it has to fall off with
    // sky visibility too. Applying it flat lights the air inside a closed room exactly
    // as brightly as the air over an open street, which is the specific thing that
    // makes an interior read as if it were full of smoke.
    vec3 inscatter = uSunColor * ( phase * vis ) +
                     uFogColor * ( uAmbientScatter * mix( 0.45, 1.0, vis ) );

#if VOL_LIGHTS > 0
    /**
     * Local practicals scatter too, and at night they are the *only* thing that does:
     * the key is a moon two orders of magnitude down and the sun term above is zero,
     * so without this the dusty air a sodium lamp is standing in stays perfectly
     * clear and the lamp reads as a sprite pasted on the frame. Same Henyey-Greenstein
     * lobe as the sun, so a cone brightens as you look up into it. Unshadowed on
     * purpose — a shadowed cone costs a second map per light and buys almost nothing
     * at the scale a street lamp's shaft is read at.
     *
     * uVolLightCount is a uniform branch, so in daylight (when Lighting publishes
     * nothing) this whole block is skipped for the entire draw.
     */
    if ( uVolLightCount > 0.5 ) {
      for ( int li = 0; li < VOL_LIGHTS; li ++ ) {
        vec4 lp = uVolLightPos[ li ];
        if ( lp.w <= 0.0 ) continue;
        vec3 toL = lp.xyz - pW;
        float dd = dot( toL, toL );
        if ( dd > lp.w ) continue;
        vec3 lv = toL * inversesqrt( max( dd, 1e-6 ) );
        float win = 1.0 - dd / lp.w;
        float att = ( win * win ) / max( dd, 0.36 );
        vec4 ld = uVolLightDir[ li ];
        float cone = ld.w > -0.999 ? smoothstep( ld.w, uVolLightCol[ li ].w, dot( -lv, ld.xyz ) ) : 1.0;
        if ( cone <= 0.0 ) continue;
        inscatter += uVolLightCol[ li ].rgb *
          ( att * cone * henyeyGreenstein( dot( rayW, lv ), uAnisotropy ) );
      }
    }
#endif

    // Energy-conserving integration of the analytic slab.
    float a = exp( -d );
    scatter += transmittance * ( 1.0 - a ) * inscatter;
    transmittance *= a;
    if ( transmittance < 0.02 ) break;
  }

  vec4 current = vec4( scatter, transmittance );

  // Temporal accumulation, reprojected through the velocity buffer.
  vec2 vel = texture2D( tVelocity, vUv ).xy;
  vec2 histUv = vUv - vel;
  float valid = ( histUv.x > 0.0 && histUv.x < 1.0 && histUv.y > 0.0 && histUv.y < 1.0 ) ? 1.0 : 0.0;
  vec4 hist = texture2D( tHistory, histUv );
  float blend = uHistoryBlend * valid;
  gl_FragColor = mix( current, hist, blend );
}
`;

/**
 * Screen-space light shafts. The depth buffer becomes an emitter mask (sky = 1, solid
 * geometry = 0) which is then integrated radially away from the sun's screen position
 * with exponential decay. Dithered start offsets keep the low tap count from banding.
 */
const SHAFT_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 uCam;
uniform vec2 uSunScreen;
uniform float uSunVisible;
uniform float uFrame;
uniform float uDecay;
uniform float uDensityScale;
varying vec2 vUv;
${GLSL_LIB}

void main() {
  if ( uSunVisible < 0.5 ) { gl_FragColor = vec4( 1.0 ); return; }

  vec2 delta = ( vUv - uSunScreen ) * uDensityScale / float( SHAFT_STEPS );
  vec2 uv = vUv;
  float illum = 1.0;
  float acc = 0.0;
  float wsum = 0.0;
  float jitter = ignTemporal( gl_FragCoord.xy, uFrame );
  uv -= delta * jitter;

  for ( int i = 0; i < SHAFT_STEPS; i ++ ) {
    uv -= delta;
    vec2 c = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
    // 1 where the sky (or anything past the far plane) is visible, 0 on geometry.
    float open = step( 0.9995, texture2D( tDepth, c ).x );
    acc += open * illum;
    wsum += illum;
    illum *= uDecay;
  }
  float shaft = wsum > 0.0 ? acc / wsum : 1.0;
  // Keep a floor so unshadowed haze never goes completely black.
  gl_FragColor = vec4( mix( 0.15, 1.0, shaft ) );
}
`;

const UPSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tVolume;
uniform sampler2D tDepth;
uniform vec4 uCam;
uniform vec2 uLowTexel;
uniform float uIntensity;
varying vec2 vUv;
${GLSL_LIB}
${GLSL_DEPTH}
void main() {
  float cd = worldDepthLinear( vUv );
  vec4 sum = vec4( 0.0 );
  float wsum = 0.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 o = vec2( float( x ), float( y ) ) * uLowTexel;
      vec4 s = texture2D( tVolume, vUv + o );
      float d = worldDepthLinear( vUv + o );
      // Generous depth tolerance on purpose: a tight one turns a ground plane seen at
      // a grazing angle into horizontal bands, because the weights change row by row.
      // We only need to reject real silhouette discontinuities here.
      float w = exp( -abs( d - cd ) / max( cd * 0.3, 0.5 ) );
      sum += s * w;
      wsum += w;
    }
  }
  vec4 v = sum / max( wsum, 1e-4 );
  gl_FragColor = vec4( v.rgb * uIntensity, v.a );
}
`;

export default class VolumetricPass extends Pass {
  constructor(ctx, shared) {
    super('volumetrics', ctx, shared);
    this.scale = 0.25;
    this.history = [null, null];
    this.cur = 0;
    this.target = null;
    this._sunDirWorld = new THREE.Vector3(0.42, 0.62, 0.36).normalize();
    this._tmp = new THREE.Vector3();
    this._black = null;

    this.uniforms = {
      tDepth: shared.tDepth,
      tShadow: { value: null },
      tShaft: { value: null },
      tHistory: { value: null },
      tVelocity: shared.tVelocity,
      uCam: shared.uCam,
      uResolution: shared.uResolution,
      uInvProj: shared.uInvProj,
      uInvView: shared.uInvView,
      uShadowMatrix: { value: new THREE.Matrix4() },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Vector3(1.0, 0.86, 0.68) },
      uFogColor: { value: new THREE.Vector3(0.35, 0.42, 0.52) },
      uFrame: shared.uFrame,
      // Extinction per metre at ground level. Clear-ish air with a bit of dust:
      // ~25% extinction over 100 m, which reads as aerial perspective rather than
      // a grey veil. Anything near 0.02 turns the whole frame into soup.
      uDensity: { value: 0.0028 },
      uHeightFalloff: { value: 0.075 },
      uGroundY: { value: 0.0 },
      uAnisotropy: { value: 0.72 },
      uAmbientScatter: { value: 0.14 },
      uMaxDistance: { value: 180.0 },
      uShadowBias: { value: 0.0016 },
      uHasShadow: { value: 0.0 },
      uHistoryBlend: { value: 0.9 },
      uCameraPos: { value: new THREE.Vector3() },
      uVolLightCount: { value: 0 },
      uVolLightPos: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uVolLightCol: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uVolLightDir: {
        value: [
          new THREE.Vector4(0, -1, 0, -1),
          new THREE.Vector4(0, -1, 0, -1),
          new THREE.Vector4(0, -1, 0, -1),
        ],
      },
    };
    this.material = this.own(
      postMaterial('volumetrics', MARCH_FRAG, this.uniforms, {
        defines: { STEPS: 32, VOL_LIGHTS: 3 },
      })
    );

    this.shaftUniforms = {
      tDepth: shared.tDepth,
      uCam: shared.uCam,
      uSunScreen: { value: new THREE.Vector2(0.5, 0.9) },
      uSunVisible: { value: 0 },
      uFrame: shared.uFrame,
      uDecay: { value: 0.965 },
      uDensityScale: { value: 1.0 },
    };
    this.shaftMaterial = this.own(
      postMaterial('volumetrics:shaft', SHAFT_FRAG, this.shaftUniforms, {
        defines: { SHAFT_STEPS: 24 },
      })
    );
    this._sunClip = new THREE.Vector3();

    this.upUniforms = {
      tVolume: { value: null },
      tDepth: shared.tDepth,
      uCam: shared.uCam,
      uLowTexel: { value: new THREE.Vector2() },
      uIntensity: { value: 1.0 },
    };
    this.upMaterial = this.own(postMaterial('volumetrics:up', UPSAMPLE_FRAG, this.upUniforms));
  }

  setQuality(tier, headless) {
    const steps = { low: 0, medium: 24, high: 40, ultra: 64 }[tier] ?? 40;
    const s = headless ? Math.min(steps, 28) : steps;
    if (s > 0 && this.material.defines.STEPS !== s) {
      this.material.defines.STEPS = s;
      this.material.needsUpdate = true;
    }
    this.scale = tier === 'ultra' ? 0.5 : 0.25;
  }

  setSize(w, h) {
    super.setSize(w, h);
    const lw = Math.max(1, Math.round(w * this.scale));
    const lh = Math.max(1, Math.round(h * this.scale));
    this.retarget('target', makeRT(lw, lh, { name: 'volumetrics' }));
    this.retarget('history0', makeRT(lw, lh, { name: 'volumetrics.h0' }));
    this.retarget('history1', makeRT(lw, lh, { name: 'volumetrics.h1' }));
    this.retarget('shaft', makeRT(lw, lh, { name: 'volumetrics.shaft' }));
    this.history = [this.history0, this.history1];
    this.uniforms.tShaft.value = this.shaft.texture;
    this.upUniforms.uLowTexel.value.set(1 / lw, 1 / lh);
    this.g.tVolume.value = this.target.texture;
    this.reset();
  }

  reset() {
    this._needsClear = true;
  }

  /** Pull sun + shadow info from ctx.lighting, defensively. */
  syncLighting(camera) {
    const L = this.ctx.lighting;
    const sun = L?.sun;
    let dir = null;
    if (L?.sunDirection?.isVector3) dir = this._tmp.copy(L.sunDirection).normalize();
    else if (sun?.isDirectionalLight) {
      dir = this._tmp
        .copy(sun.position)
        .sub(sun.target ? sun.target.position : { x: 0, y: 0, z: 0 })
        .normalize();
    }
    if (dir && Number.isFinite(dir.x) && dir.lengthSq() > 0.1) this._sunDirWorld.copy(dir);

    // World -> view direction.
    const v = this.uniforms.uSunDirView.value;
    v.copy(this._sunDirWorld).transformDirection(camera.matrixWorldInverse).normalize();

    const col = this.uniforms.uSunColor.value;
    if (sun?.color) {
      /**
       * The march multiplies this by the normalised HG phase and by the scattered
       * fraction of each slab, so the physically correct value here is the key's
       * irradiance itself. 0.055 was a dampener applied on top of that — an 18x
       * discount — and it is why a "volumetric" pass produced nothing legible: a 6 m
       * window shaft in 0.0022/m air came out at 3e-4 of linear radiance against a
       * floor sitting near 0.2, i.e. four decimal places below visible. 0.15 is still
       * well under the physical figure (the density is authored per weather preset and
       * would blow out looking straight into the sun at the honest value) but it puts
       * a shaft and a lamp cone into the range the eye can actually find.
       */
      const inten = Math.min(sun.intensity ?? 3, 20) * 0.15;
      col.set(sun.color.r * inten, sun.color.g * inten, sun.color.b * inten);
    } else {
      col.set(0.42, 0.37, 0.29);
    }

    this._syncFogColour();
    this._syncShadow();
    this._syncLocalLights();
  }

  /** Pull up to three practicals from the lighting module for in-scattering. */
  _syncLocalLights() {
    const u = this.uniforms;
    const max = this.material.defines.VOL_LIGHTS | 0;
    let list = null;
    try {
      list = this.ctx.lighting?.getVolumetricLights?.(max) || null;
    } catch {
      list = null;
    }
    let n = 0;
    for (let i = 0; i < max; i++) {
      const l = list && list[i];
      const p = u.uVolLightPos.value[i];
      const c = u.uVolLightCol.value[i];
      const d = u.uVolLightDir.value[i];
      if (!l) {
        p.set(0, 0, 0, 0);
        continue;
      }
      p.set(l.pos.x, l.pos.y, l.pos.z, Math.max(l.radius * l.radius, 0.04));
      c.set(l.color.x, l.color.y, l.color.z, l.cosInner ?? 1);
      d.set(l.dir.x, l.dir.y, l.dir.z, l.cosOuter ?? -1);
      n++;
    }
    u.uVolLightCount.value = n;
  }

  /**
   * The ambient in-scattering colour is *sky light*, so its brightness has to be the
   * sky's brightness at this hour. It was a hard-coded blue-grey, which is a defensible
   * guess at noon and simply wrong at every other time the game renders: the haze
   * stayed cold blue through a red sunset and stayed *bright* blue-grey through the
   * night pose, where it is the only thing lighting the air.
   *
   * **The hue, though, is not ours to own.** `render/Weather.js` writes this same
   * uniform to give each preset its cast — dust storms are orange, storms are slate —
   * and we run later in the frame than it does, so simply assigning the sky colour
   * here would silently win that race every frame and delete the entire weather
   * palette. So: whatever colour the uniform is carrying when we arrive is adopted as
   * the hue, and we only rescale it to the sky's luminance. A dust storm stays orange
   * and still goes dark at night; nobody has to know about anybody.
   *
   * The 0.70 factor reproduces the previously hand-tuned magnitude at the reference
   * mid-morning key, so the density of the veil is unchanged.
   */
  _syncFogColour() {
    const u = this.uniforms.uFogColor.value;
    if (!this._fogHue) this._fogHue = new THREE.Vector3().copy(u);
    if (!this._fogWritten) this._fogWritten = new THREE.Vector3().copy(u);
    // Anything that is not our own last write is another system claiming the hue.
    if (!u.equals(this._fogWritten)) this._fogHue.copy(u);

    const amb = this.ctx.sky?.ambientColor;
    const hue = this._fogHue;
    const hueLum = 0.2126 * hue.x + 0.7152 * hue.y + 0.0722 * hue.z;
    if (amb && Number.isFinite(amb.r) && hueLum > 1e-5) {
      const ambLum =
        0.2126 * Math.max(amb.r, 0) + 0.7152 * Math.max(amb.g, 0) + 0.0722 * Math.max(amb.b, 0);
      const k = (ambLum * 0.7) / hueLum;
      u.set(hue.x * k, hue.y * k, hue.z * k);
    }
    this._fogWritten.copy(u);
  }

  /**
   * Adopt the lighting module's cascade, if it publishes one.
   *
   * **This used to live at the tail of `_syncFogColour`, where `L` is not in scope.**
   * The `L?.getVolumetricShadow?.()` therefore threw a ReferenceError on every frame,
   * the surrounding `catch` swallowed it, and `uHasShadow` was hard-wired to 0 — so
   * the pass could only ever run its screen-space fallback no matter what any other
   * module published. Same code, correct scope.
   */
  _syncShadow() {
    const L = this.ctx.lighting;
    // Shadow map — only ever the one the lighting module hands us on purpose.
    let shadow = null;
    try {
      shadow = L?.getVolumetricShadow?.() || this._explicitShadow || null;
    } catch {
      shadow = this._explicitShadow || null;
    }
    if (shadow?.map && shadow?.matrix && this._adoptShadowTexture(shadow.map)) {
      this.uniforms.tShadow.value = shadow.map;
      this.uniforms.uShadowMatrix.value.copy(shadow.matrix);
      this.uniforms.uShadowBias.value = Math.abs(shadow.bias ?? 0.0015) || 0.0015;
      this.uniforms.uHasShadow.value = 1;
    } else {
      this.uniforms.uHasShadow.value = 0;
      this.uniforms.tShadow.value = this._blackTex();
    }
  }

  /**
   * Make an externally owned texture safe to bind as a plain sampler.
   *
   * three.js only sets `isRenderTargetTexture` on a render target's *colour* texture,
   * never on its DepthTexture. Without that flag `WebGLTextures.setTexture2D` treats a
   * bind as a possible upload and re-allocates the texture with `texImage2D(..., null)`,
   * destroying whatever was rendered into it. Setting the flag makes three bind it and
   * nothing more, which is the correct behaviour for something the GPU owns.
   *
   * Rejects depth textures configured for hardware comparison: reading those through a
   * non-shadow sampler is undefined behaviour in GLSL ES 3.00.
   */
  _adoptShadowTexture(tex) {
    if (!tex || !tex.isTexture) return false;
    if (tex.isDepthTexture) {
      if (tex.compareFunction) return false;
      // Only adopt once three has actually allocated it; flagging an unallocated
      // texture would make three skip the allocation and leave the FBO incomplete.
      if (!tex.image || !(tex.image.width > 0)) return false;
      if (tex.isRenderTargetTexture !== true) tex.isRenderTargetTexture = true;
    }
    return true;
  }

  /** Explicit hook for the lighting module: `pipeline.getPass('volumetrics').setShadow(...)` */
  setShadow(shadow) {
    this._explicitShadow = shadow || null;
  }

  _blackTex() {
    if (!this._black) {
      this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      this._black.needsUpdate = true;
    }
    return this._black;
  }

  /** Project the sun onto the screen for the light-shaft pass. */
  _updateSunScreen(camera) {
    const u = this.shaftUniforms;
    if (this.uniforms.uHasShadow.value > 0.5) {
      u.uSunVisible.value = 0; // real shadows are better; skip the screen-space term
      return;
    }
    const p = this._sunClip
      .copy(this._sunDirWorld)
      .multiplyScalar(1000)
      .add(this._tmp.setFromMatrixPosition(camera.matrixWorld));
    p.project(camera);
    // project() leaves NDC; behind the camera it wraps, so test the view-space sign.
    const dirView = this.uniforms.uSunDirView.value;
    const behind = dirView.z > -0.05;
    const off = Math.abs(p.x) > 2.2 || Math.abs(p.y) > 2.2;
    u.uSunVisible.value = behind || off ? 0 : 1;
    u.uSunScreen.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  }

  render(renderer, camera, historyValid) {
    if (!this.target) return null;
    this.uniforms.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    this.uniforms.uHistoryBlend.value = historyValid && !this._needsClear ? 0.88 : 0.0;

    this._updateSunScreen(camera);
    blit(renderer, this.shaftMaterial, this.shaft);

    const prev = this.history[this.cur];
    const next = this.history[this.cur ^ 1];
    this.uniforms.tHistory.value = prev.texture;
    blit(renderer, this.material, next);
    this.cur ^= 1;
    this._needsClear = false;

    this.upUniforms.tVolume.value = next.texture;
    blit(renderer, this.upMaterial, this.target);
    return this.target;
  }

  dispose() {
    this._black?.dispose();
    super.dispose();
  }
}
