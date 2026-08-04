/**
 * TAAPass — temporal anti-aliasing.
 * Owner: render-pipeline agent.
 *
 * - Sub-pixel jitter comes from a Halton(2,3) sequence of 16 samples, applied to the
 *   projection matrices of *both* the world and viewmodel cameras by RenderPipeline
 *   (see `_applyJitter`), so the weapon anti-aliases too.
 * - History is reprojected with the velocity buffer written by VelocityPass. Static
 *   geometry uses camera-only reprojection; `userData.dynamic` objects get real
 *   per-object motion vectors.
 * - The history sample is clamped to the neighbourhood of the current pixel in
 *   **YCoCg** space, using a variance box (mean ± gamma * stddev) rather than a min/max
 *   box. Variance clipping keeps thin, high-contrast features (railings, wires, aliased
 *   specular) from being either clipped away or smeared.
 * - History is *clipped* toward the current colour along the ray, not clamped
 *   per-channel, which avoids the hue shifts a per-channel clamp introduces.
 * - The blend factor is variance driven: low-variance (converged, static) regions keep
 *   up to 96% history, high-variance regions drop to ~55%, and pixels whose reprojection
 *   is off-screen or whose depth disagrees reject history entirely. That is what stops
 *   TAA from turning motion into smear.
 * - Bicubic (Catmull-Rom, 5-tap) history filtering removes the softening a bilinear
 *   history fetch introduces every frame.
 * - `reset()` drops history for one frame — used after a teleport, pose change, resize
 *   or quality switch.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, GLSL_DEPTH, GLSL_DEPTH_VIEW, postMaterial, blit, makeRT } from './Pass.js';

const TAA_FRAG = /* glsl */ `
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform sampler2D tDepth;
uniform sampler2D tDepthView;
uniform vec4 uCam;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform float uHistoryValid;
uniform float uFeedbackMin;
uniform float uFeedbackMax;
uniform float uVarianceGamma;
varying vec2 vUv;

${GLSL_LIB}
${GLSL_DEPTH}
${GLSL_DEPTH_VIEW}

vec3 tonemapForBlend( vec3 c )   { return c / ( 1.0 + luma( c ) ); }
vec3 untonemapForBlend( vec3 c ) { return c / max( 1.0 - luma( c ), 1e-4 ); }

// 5-tap Catmull-Rom, the standard cheap approximation of the 16-tap filter.
vec3 sampleHistoryCatmullRom( sampler2D tex, vec2 uv, vec2 res ) {
  vec2 samplePos = uv * res;
  vec2 texPos1 = floor( samplePos - 0.5 ) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
  vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
  vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
  vec2 w3 = f * f * ( -0.5 + 0.5 * f );

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max( w12, vec2( 1e-5 ) );

  vec2 texPos0 = ( texPos1 - 1.0 ) / res;
  vec2 texPos3 = ( texPos1 + 2.0 ) / res;
  vec2 texPos12 = ( texPos1 + offset12 ) / res;

  vec3 result = vec3( 0.0 );
  result += texture2D( tex, vec2( texPos12.x, texPos0.y ) ).rgb * w12.x * w0.y;
  result += texture2D( tex, vec2( texPos0.x,  texPos12.y ) ).rgb * w0.x  * w12.y;
  result += texture2D( tex, vec2( texPos12.x, texPos12.y ) ).rgb * w12.x * w12.y;
  result += texture2D( tex, vec2( texPos3.x,  texPos12.y ) ).rgb * w3.x  * w12.y;
  result += texture2D( tex, vec2( texPos12.x, texPos3.y ) ).rgb * w12.x * w3.y;
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max( result / max( wsum, 1e-5 ), vec3( 0.0 ) );
}

// Clip the history colour toward the current colour along the ray to the AABB.
vec3 clipToAABB( vec3 boxMin, vec3 boxMax, vec3 c, vec3 h ) {
  vec3 center = 0.5 * ( boxMax + boxMin );
  vec3 extent = 0.5 * ( boxMax - boxMin ) + 1e-5;
  vec3 v = h - center;
  vec3 unit = v / extent;
  vec3 a = abs( unit );
  float ma = max( a.x, max( a.y, a.z ) );
  return ma > 1.0 ? center + v / ma : h;
}

void main() {
  vec3 current = texture2D( tCurrent, vUv ).rgb;

  if ( uHistoryValid < 0.5 ) { gl_FragColor = vec4( current, 1.0 ); return; }

  // Velocity: pick the closest-depth neighbour in a 3x3 so silhouettes reproject with
  // the foreground object rather than the background behind them.
  vec2 bestUv = vUv;
  float bestD = 1.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 uv = vUv + vec2( float( x ), float( y ) ) * uTexel;
      float d = texture2D( tDepth, uv ).x;
      if ( d < bestD ) { bestD = d; bestUv = uv; }
    }
  }
  vec2 velocity = texture2D( tVelocity, bestUv ).xy;
  // The viewmodel is locked to the camera: no reprojection.
  velocity *= 1.0 - viewmodelMask( vUv );

  vec2 histUv = vUv - velocity;
  if ( histUv.x < 0.0 || histUv.x > 1.0 || histUv.y < 0.0 || histUv.y > 1.0 ) {
    gl_FragColor = vec4( current, 1.0 );
    return;
  }

  // --- neighbourhood statistics in YCoCg ------------------------------------
  vec3 m1 = vec3( 0.0 );
  vec3 m2 = vec3( 0.0 );
  vec3 nmin = vec3( 1e9 );
  vec3 nmax = vec3( -1e9 );
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec3 s = rgb2ycocg( tonemapForBlend( texture2D( tCurrent, vUv + vec2( float( x ), float( y ) ) * uTexel ).rgb ) );
      m1 += s;
      m2 += s * s;
      nmin = min( nmin, s );
      nmax = max( nmax, s );
    }
  }
  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt( max( m2 / 9.0 - mean * mean, vec3( 0.0 ) ) );
  vec3 boxMin = max( mean - uVarianceGamma * sigma, nmin );
  vec3 boxMax = min( mean + uVarianceGamma * sigma, nmax );

  vec3 history = sampleHistoryCatmullRom( tHistory, histUv, uResolution );
  vec3 hY = rgb2ycocg( tonemapForBlend( history ) );
  vec3 cY = rgb2ycocg( tonemapForBlend( current ) );
  vec3 clipped = clipToAABB( boxMin, boxMax, cY, hY );

  // --- variance-driven feedback ---------------------------------------------
  float lumaSigma = sigma.x;
  float motion = length( velocity * uResolution );
  // Busy neighbourhoods and fast motion both reduce how much history we trust.
  float confidence = exp( -lumaSigma * 6.0 ) * exp( -motion * 0.06 );
  float feedback = mix( uFeedbackMin, uFeedbackMax, saturate1( confidence ) );
  // How far the history had to be clipped is itself a disocclusion signal.
  float clipDist = length( clipped - hY );
  feedback *= exp( -clipDist * 3.0 );

  vec3 resultY = mix( cY, clipped, feedback );
  vec3 result = untonemapForBlend( ycocg2rgb( resultY ) );
  gl_FragColor = vec4( max( result, vec3( 0.0 ) ), 1.0 );
}
`;

/** Halton radical inverse. */
function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

export default class TAAPass extends Pass {
  constructor(ctx, shared) {
    super('taa', ctx, shared);
    this.sampleCount = 16;
    this.jitter = [];
    for (let i = 1; i <= this.sampleCount; i++) {
      this.jitter.push(new THREE.Vector2(halton(i, 2) - 0.5, halton(i, 3) - 0.5));
    }
    this.index = 0;
    this.historyValid = false;
    this.history = [null, null];
    this.cur = 0;

    this.uniforms = {
      tCurrent: { value: null },
      tHistory: { value: null },
      tVelocity: shared.tVelocity,
      tDepth: shared.tDepth,
      tDepthView: shared.tDepthView,
      uCam: shared.uCam,
      uResolution: shared.uResolution,
      uTexel: { value: new THREE.Vector2() },
      uHistoryValid: { value: 0 },
      uFeedbackMin: { value: 0.55 },
      uFeedbackMax: { value: 0.96 },
      uVarianceGamma: { value: 1.25 },
    };
    this.material = this.own(postMaterial('taa', TAA_FRAG, this.uniforms));
  }

  /** Sub-pixel offset for the current frame, in NDC units. */
  currentJitter(out, w, h) {
    const j = this.jitter[this.index % this.sampleCount];
    out.set((j.x * 2) / w, (j.y * 2) / h);
    return out;
  }

  advance() {
    this.index = (this.index + 1) % this.sampleCount;
  }

  reset() {
    this.historyValid = false;
    this.index = 0;
  }

  setSize(w, h) {
    super.setSize(w, h);
    this.retarget('history0', makeRT(w, h, { name: 'taa.h0' }));
    this.retarget('history1', makeRT(w, h, { name: 'taa.h1' }));
    this.history = [this.history0, this.history1];
    this.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.reset();
  }

  /** @returns {THREE.WebGLRenderTarget} the resolved frame (also the new history) */
  render(renderer, source) {
    const dst = this.history[this.cur ^ 1];
    this.uniforms.tCurrent.value = source;
    this.uniforms.tHistory.value = this.history[this.cur].texture;
    this.uniforms.uHistoryValid.value = this.historyValid ? 1 : 0;
    blit(renderer, this.material, dst);
    this.cur ^= 1;
    this.historyValid = true;
    return dst;
  }
}
