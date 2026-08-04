/**
 * Pass.js — shared plumbing for the hand-written HDR render graph.
 * Owner: render-pipeline agent (src/render/RenderPipeline.js + src/render/passes/**).
 *
 * Not a game System. Provides:
 *   - `blit(renderer, material, target, clear)`  fullscreen-triangle draw
 *   - `class Pass`                                base class (name/enabled/setSize/dispose)
 *   - `makeRT()` / `disposeRT()`                  render-target helpers with no leaks
 *   - GLSL_LIB                                    the shared shader prelude every pass uses
 *
 * All shaders are authored in GLSL ES 1.00 style (`varying`, `texture2D`,
 * `gl_FragColor`, `texture2DLodEXT`). three.js 0.185 transparently rewrites these to
 * GLSL ES 3.00 for WebGL2, so this is both terse and portable.
 *
 * Emits no events.
 */
import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Fullscreen triangle                                                        */
/* -------------------------------------------------------------------------- */

const _geom = new THREE.BufferGeometry();
_geom.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
);
_geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
_geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);

const _quadScene = new THREE.Scene();
_quadScene.matrixAutoUpdate = false;
const _quadMesh = new THREE.Mesh(_geom, null);
_quadMesh.frustumCulled = false;
_quadMesh.matrixAutoUpdate = false;
_quadScene.add(_quadMesh);
const _quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** Draw one fullscreen triangle with `material` into `target` (null = canvas). */
export function blit(renderer, material, target = null, clear = false) {
  _quadMesh.material = material;
  renderer.setRenderTarget(target);
  if (clear) renderer.clear(true, false, false);
  renderer.render(_quadScene, _quadCam);
}

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/* -------------------------------------------------------------------------- */
/* Render target helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {number} w @param {number} h
 * @param {{type?:any, format?:any, filter?:any, depth?:boolean, depthTexture?:any,
 *          wrap?:any, name?:string}} [o]
 */
export function makeRT(w, h, o = {}) {
  const filter = o.filter ?? THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: o.type ?? THREE.HalfFloatType,
    format: o.format ?? THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: o.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: o.wrap ?? THREE.ClampToEdgeWrapping,
    depthBuffer: !!o.depth,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.name = o.name || 'rt';
  if (o.depth && o.depthTexture !== false) {
    const dt = new THREE.DepthTexture(
      Math.max(1, w | 0),
      Math.max(1, h | 0),
      THREE.UnsignedIntType
    );
    dt.format = THREE.DepthFormat;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    dt.name = (o.name || 'rt') + '.depth';
    rt.depthTexture = dt;
  }
  return rt;
}

export function disposeRT(rt) {
  if (!rt) return;
  try {
    rt.depthTexture?.dispose?.();
    rt.texture?.dispose?.();
    rt.dispose();
  } catch {
    /* teardown is best-effort */
  }
}

/** Build a ShaderMaterial configured for fullscreen post work. */
export function postMaterial(name, fragmentShader, uniforms, opts = {}) {
  const m = new THREE.ShaderMaterial({
    name,
    uniforms,
    defines: opts.defines || {},
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: opts.blending ?? THREE.NoBlending,
    transparent: opts.blending !== undefined && opts.blending !== THREE.NoBlending,
    premultipliedAlpha: false,
  });
  m.toneMapped = false;
  return m;
}

/* -------------------------------------------------------------------------- */
/* Pass base                                                                  */
/* -------------------------------------------------------------------------- */

export class Pass {
  /** @param {string} name */
  constructor(name, ctx, shared) {
    this.name = name;
    this.ctx = ctx;
    /** shared per-frame uniform objects owned by RenderPipeline */
    this.g = shared;
    this.enabled = true;
    this.width = 1;
    this.height = 1;
    this._materials = [];
    this._targets = [];
  }

  /** Track a material so dispose() is automatic. */
  own(m) {
    if (m && m.isMaterial) this._materials.push(m);
    else if (m && m.isWebGLRenderTarget) this._targets.push(m);
    return m;
  }

  /** Replace a tracked target (disposes the old one). */
  retarget(slot, rt) {
    const old = this[slot];
    if (old) {
      const i = this._targets.indexOf(old);
      if (i >= 0) this._targets.splice(i, 1);
      disposeRT(old);
    }
    this[slot] = rt;
    if (rt) this._targets.push(rt);
    return rt;
  }

  setSize(w, h) {
    this.width = w;
    this.height = h;
  }

  dispose() {
    for (const m of this._materials) m.dispose?.();
    for (const t of this._targets) disposeRT(t);
    this._materials.length = 0;
    this._targets.length = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared GLSL prelude                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Uniform contract assumed by GLSL_LIB (all supplied by RenderPipeline.shared):
 *   sampler2D tDepth      world-camera depth (UnsignedInt24, DepthFormat)
 *   sampler2D tDepthView  viewmodel-camera depth (1.0 where there is no viewmodel)
 *   vec4      uCam        (worldNear, worldFar, viewNear, viewFar)
 *   vec2      uResolution full-res pixel size of the frame
 *   float     uFrame      monotonically increasing frame counter
 */
export const GLSL_LIB = /* glsl */ `
#ifndef PI
  #define PI 3.141592653589793
#endif
#define HALF_PI 1.5707963267948966
#define TWO_PI 6.283185307179586

float saturate1( float x ) { return clamp( x, 0.0, 1.0 ); }
vec3  saturate3( vec3 x )  { return clamp( x, 0.0, 1.0 ); }
float maxc( vec3 c ) { return max( c.r, max( c.g, c.b ) ); }
float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// --- perceptual / colour ---------------------------------------------------
vec3 rgb2ycocg( vec3 c ) {
  return vec3(
     0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
     0.5  * c.r             - 0.5  * c.b,
    -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}
vec3 ycocg2rgb( vec3 c ) {
  float t = c.x - c.z;
  return vec3( t + c.y, c.x + c.z, t - c.y );
}
vec3 linearToSRGB( vec3 c ) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / 2.4 ) ) - 0.055;
  return mix( lo, hi, step( vec3( 0.0031308 ), c ) );
}
vec3 srgbToLinear( vec3 c ) {
  vec3 lo = c / 12.92;
  vec3 hi = pow( ( max( c, vec3( 0.0 ) ) + 0.055 ) / 1.055, vec3( 2.4 ) );
  return mix( lo, hi, step( vec3( 0.04045 ), c ) );
}

// --- noise -----------------------------------------------------------------
// Interleaved gradient noise (Jimenez, CoD:AW) — blue-noise-like spectrum, free.
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
// Temporally rotated by the golden ratio so accumulation converges evenly.
float ignTemporal( vec2 p, float frame ) {
  return fract( ign( p ) + frame * 0.6180339887498949 );
}
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 hash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
// Vogel / golden-angle disc sample — even coverage for any tap count.
vec2 vogelDisc( int i, int n, float rotation ) {
  float fi = float( i ) + 0.5;
  float r = sqrt( fi / float( n ) );
  float theta = fi * 2.3999632297286533 + rotation;
  return vec2( r * cos( theta ), r * sin( theta ) );
}

// --- depth -----------------------------------------------------------------
float linearizeDepth( float d, float n, float f ) {
  // d in [0,1] window depth, standard (non-reversed) projection.
  float z = d * 2.0 - 1.0;
  return ( 2.0 * n * f ) / ( f + n - z * ( f - n ) );
}
float delinearizeDepth( float lz, float n, float f ) {
  float z = ( ( f + n ) - ( 2.0 * n * f ) / max( lz, 1e-6 ) ) / ( f - n );
  return z * 0.5 + 0.5;
}
/** View-space position from a *world-camera* depth sample. */
vec3 viewPosFromDepth( vec2 uv, float rawDepth, mat4 invProj ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0 );
  vec4 v = invProj * clip;
  return v.xyz / v.w;
}
vec3 viewRay( vec2 uv, mat4 invProj ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
  vec4 v = invProj * clip;
  return v.xyz / v.w;
}

// --- misc ------------------------------------------------------------------
float henyeyGreenstein( float cosTheta, float g ) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * cosTheta;
  return ( 1.0 - g2 ) / ( 4.0 * PI * max( d * sqrt( max( d, 1e-4 ) ), 1e-4 ) );
}
vec3 gtaoMultiBounce( float visibility, vec3 albedo ) {
  vec3 a =  2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c =  2.7552 * albedo + 0.6903;
  float v = visibility;
  return clamp( v * ( a * v * v + b * v + c ), vec3( v ), vec3( 1.0 ) );
}
`;

/**
 * World-depth helpers. Requires: `sampler2D tDepth`, `vec4 uCam`.
 * Must be pasted AFTER GLSL_LIB.
 *
 * Deliberately does NOT touch the viewmodel depth texture — a pass that renders into
 * the target that owns that texture must not declare it, or WebGL reports a
 * framebuffer feedback loop. Use GLSL_DEPTH_VIEW only in passes that write elsewhere.
 */
export const GLSL_DEPTH = /* glsl */ `
float worldDepthRaw( vec2 uv )      { return texture2D( tDepth, uv ).x; }
float worldDepthLinear( vec2 uv )   { return linearizeDepth( texture2D( tDepth, uv ).x, uCam.x, uCam.y ); }

/**
 * Smooth depth-derived view normal (plain central differences).
 *
 * Use this anywhere the normal only feeds a *weighting* term. The branchy
 * "closest neighbour" version below decides between a forward and a backward
 * difference by comparing quantised 24-bit depths, and on a large flat surface that
 * comparison is decided by quantisation noise — the branch then flips per pixel and
 * prints a fine dither into whatever it modulates.
 */
vec3 smoothNormalFromDepth( vec2 uv, vec2 texel, mat4 invProj ) {
  vec3 c = viewPosFromDepth( uv, texture2D( tDepth, uv ).x, invProj );
  vec3 r = viewPosFromDepth( uv + vec2( texel.x, 0.0 ), texture2D( tDepth, uv + vec2( texel.x, 0.0 ) ).x, invProj );
  vec3 l = viewPosFromDepth( uv - vec2( texel.x, 0.0 ), texture2D( tDepth, uv - vec2( texel.x, 0.0 ) ).x, invProj );
  vec3 u = viewPosFromDepth( uv + vec2( 0.0, texel.y ), texture2D( tDepth, uv + vec2( 0.0, texel.y ) ).x, invProj );
  vec3 d = viewPosFromDepth( uv - vec2( 0.0, texel.y ), texture2D( tDepth, uv - vec2( 0.0, texel.y ) ).x, invProj );
  vec3 n = cross( r - l, u - d );
  float len = length( n );
  return len > 1e-9 ? n / len : vec3( 0.0, 0.0, 1.0 );
}

/**
 * Accurate depth-derived view normal. Picks the closest horizontal/vertical
 * neighbour on each axis so silhouettes and thin geometry keep a sane normal
 * instead of smearing across the discontinuity (Turánszky's improved variant).
 */
vec3 normalFromDepth( vec2 uv, vec2 texel, mat4 invProj ) {
  float c  = worldDepthRaw( uv );
  float l1 = worldDepthRaw( uv - vec2( texel.x, 0.0 ) );
  float l2 = worldDepthRaw( uv - vec2( texel.x * 2.0, 0.0 ) );
  float r1 = worldDepthRaw( uv + vec2( texel.x, 0.0 ) );
  float r2 = worldDepthRaw( uv + vec2( texel.x * 2.0, 0.0 ) );
  float d1 = worldDepthRaw( uv - vec2( 0.0, texel.y ) );
  float d2 = worldDepthRaw( uv - vec2( 0.0, texel.y * 2.0 ) );
  float u1 = worldDepthRaw( uv + vec2( 0.0, texel.y ) );
  float u2 = worldDepthRaw( uv + vec2( 0.0, texel.y * 2.0 ) );

  float dl = abs( ( 2.0 * l1 - l2 ) - c );
  float dr = abs( ( 2.0 * r1 - r2 ) - c );
  float dd = abs( ( 2.0 * d1 - d2 ) - c );
  float du = abs( ( 2.0 * u1 - u2 ) - c );

  vec3 P  = viewPosFromDepth( uv, c, invProj );
  vec3 hDeriv, vDeriv;
  if ( dl < dr ) hDeriv = P - viewPosFromDepth( uv - vec2( texel.x, 0.0 ), l1, invProj );
  else           hDeriv = viewPosFromDepth( uv + vec2( texel.x, 0.0 ), r1, invProj ) - P;
  if ( dd < du ) vDeriv = P - viewPosFromDepth( uv - vec2( 0.0, texel.y ), d1, invProj );
  else           vDeriv = viewPosFromDepth( uv + vec2( 0.0, texel.y ), u1, invProj ) - P;

  vec3 n = cross( hDeriv, vDeriv );
  float len = length( n );
  return len > 1e-9 ? n / len : vec3( 0.0, 0.0, 1.0 );
}
`;

/**
 * Viewmodel-aware depth. Requires GLSL_LIB + GLSL_DEPTH plus `sampler2D tDepthView`.
 * The viewmodel is rendered with its own camera into its own depth attachment, so its
 * window depth has to be re-linearised with the viewmodel near/far (uCam.zw) before it
 * can be compared with the world.
 */
export const GLSL_DEPTH_VIEW = /* glsl */ `
float viewmodelDepthRaw( vec2 uv ) { return texture2D( tDepthView, uv ).x; }
float viewmodelMask( vec2 uv )     { return step( texture2D( tDepthView, uv ).x, 0.999999 ); }

/** Combined scene depth in metres: the viewmodel wins wherever it drew. */
float sceneDepthLinear( vec2 uv ) {
  float dv = texture2D( tDepthView, uv ).x;
  if ( dv < 0.999999 ) return linearizeDepth( dv, uCam.z, uCam.w );
  return linearizeDepth( texture2D( tDepth, uv ).x, uCam.x, uCam.y );
}
`;

export default Pass;
