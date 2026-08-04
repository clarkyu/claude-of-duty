/**
 * SSRPass — screen-space reflections.
 * Owner: render-pipeline agent.
 *
 * Trace:
 *   - View-space reflection ray, projected into screen space and marched against the
 *     hierarchical min-depth pyramid (HiZPass). While the ray is in front of a cell's
 *     closest surface the whole cell is empty, so the step doubles and the mip level
 *     climbs; a potential intersection drops the level and shortens the step. That is
 *     the empty-space-skipping property of Hi-Z tracing, without the fragile
 *     cell-boundary arithmetic.
 *   - Once level 0 reports the ray behind the surface, an 8-iteration binary search
 *     refines the crossing to sub-texel accuracy.
 *   - A thickness test rejects hits where the ray passed *behind* a surface that is
 *     thinner than `uThickness` — that is the classic "reflection sticking to the back
 *     of a pillar" artefact.
 *   - Edge fade (screen border), backface fade (ray pointing at the camera) and a
 *     grazing-angle fade keep the transition to the fallback invisible.
 *
 * Roughness:
 *   - Ray direction is jittered inside the GGX lobe (importance-sampled by roughness,
 *     rotated per frame so TAA integrates it).
 *   - The resolve does a cone blur whose radius grows with roughness * hit distance,
 *     which is the cheap stand-in for a pre-filtered radiance mip chain.
 *
 * Fallback: where the ray misses (off-screen, behind geometry, or too rough to be
 * worth tracing) the result fades to the environment estimate supplied by the pipeline
 * (`uEnvColor`, a horizon/zenith split refreshed from ctx.lighting each frame).
 * Output RGB = reflected radiance, A = confidence, so CompositePass can weight it.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, GLSL_DEPTH, postMaterial, blit, makeRT } from './Pass.js';
import { GLSL_HIZ } from './HiZPass.js';

const SSR_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tGBuffer;
uniform sampler2D tHiZ;
uniform vec4 uHiZRect[ 10 ];
uniform int uHiZLevels;
uniform vec4 uCam;
uniform vec2 uResolution;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform mat4 uInvView;
uniform float uFrame;
uniform float uThickness;
uniform float uMaxDistance;
uniform float uIntensity;
uniform vec3 uEnvHorizon;
uniform vec3 uEnvZenith;
uniform vec3 uEnvGround;
varying vec2 vUv;

${GLSL_LIB}
${GLSL_DEPTH}
${GLSL_HIZ}

vec3 envFallback( vec3 dirWorld ) {
  float y = dirWorld.y;
  vec3 up = mix( uEnvHorizon, uEnvZenith, pow( saturate1( y ), 0.55 ) );
  vec3 dn = mix( uEnvHorizon, uEnvGround, pow( saturate1( -y ), 0.5 ) );
  return y > 0.0 ? up : dn;
}

// GGX importance sample around N, in tangent space of N.
vec3 importanceGGX( vec2 Xi, vec3 N, float roughness ) {
  float a = max( roughness * roughness, 1e-3 );
  float phi = TWO_PI * Xi.x;
  float cosTheta = sqrt( ( 1.0 - Xi.y ) / ( 1.0 + ( a * a - 1.0 ) * Xi.y ) );
  float sinTheta = sqrt( max( 1.0 - cosTheta * cosTheta, 0.0 ) );
  vec3 H = vec3( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
  vec3 upv = abs( N.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 tx = normalize( cross( upv, N ) );
  vec3 ty = cross( N, tx );
  return normalize( tx * H.x + ty * H.y + N * H.z );
}

void main() {
  float rawD = texture2D( tDepth, vUv ).x;
  if ( rawD >= 0.9999 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec4 orm = texture2D( tGBuffer, vUv );
  float roughness = clamp( orm.g, 0.02, 1.0 );
  float metalness = clamp( orm.b, 0.0, 1.0 );

  // Very rough surfaces get nothing but the probe — tracing them is wasted work.
  if ( roughness > 0.75 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec2 fullTexel = 1.0 / uResolution;
  vec3 P = viewPosFromDepth( vUv, rawD, uInvProj );
  vec3 N = normalFromDepth( vUv, fullTexel, uInvProj );
  vec3 V = normalize( -P );
  if ( dot( N, V ) < 0.0 ) N = -N;

  float rot = ignTemporal( gl_FragCoord.xy, uFrame ) ;
  vec2 Xi = vec2( fract( rot * 1.61803398875 ), fract( rot * 3.14159265 + 0.5 ) );
  // Keep the stochastic lobe narrow: a single ray per pixel at half resolution cannot
  // pay for a wide one, and the residual noise survives TAA as a visible hatch.
  vec3 Nj = importanceGGX( Xi, N, roughness * 0.45 );
  vec3 R = normalize( reflect( -V, Nj ) );

  // World-space direction for the environment fallback.
  vec3 Rworld = normalize( ( uInvView * vec4( R, 0.0 ) ).xyz );
  vec3 fallback = envFallback( Rworld );

  // Rays aimed back out of the screen leave the frustum almost immediately.
  float backFade = saturate1( 1.0 - smoothstep( 0.15, 0.8, R.z ) );

  vec3 hitColor = fallback;
  float confidence = 0.0;

  float rayLen = uMaxDistance;
  if ( R.z > 1e-5 ) {
    // Clip the ray to the near plane so the projection stays valid.
    float toNear = ( -uCam.x - P.z ) / R.z;
    rayLen = toNear > 0.0 ? min( rayLen, toNear ) : 0.0;
  }

  if ( backFade > 0.01 && rayLen > 0.05 ) {
    vec3 startVS = P;
    vec3 endVS = P + R * rayLen;

    vec4 s0 = uProj * vec4( startVS, 1.0 );
    vec4 s1 = uProj * vec4( endVS, 1.0 );
    vec3 p0 = s0.xyz / s0.w;
    vec3 p1 = s1.xyz / s1.w;
    vec2 uv0 = p0.xy * 0.5 + 0.5;
    vec2 uv1 = p1.xy * 0.5 + 0.5;

    // Reciprocal-depth interpolation keeps the march perspective-correct.
    float invW0 = 1.0 / s0.w;
    float invW1 = 1.0 / s1.w;

    float t = 0.0;
    float dither = ignTemporal( gl_FragCoord.xy + 31.7, uFrame );
    float stepSize = 1.0 / float( MAX_STEPS );
    t = dither * stepSize;

    // Cap how far the mip climb is allowed to accelerate. An unbounded 2^level step
    // overshoots the whole ray after a handful of empty cells, so whether a pixel
    // finds its intersection ends up depending on its dither offset — which reads as
    // chunky, spatially coherent noise across a large reflective surface.
    int maxLevel = min( uHiZLevels - 1, 3 );
    int level = 0;
    float prevT = 0.0;
    bool hit = false;
    float hitT = 0.0;
    vec2 lastUv = uv0;

    for ( int i = 0; i < MAX_STEPS; i ++ ) {
      if ( t >= 1.0 ) break;
      vec2 uv = mix( uv0, uv1, t );
      if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;
      lastUv = uv;

      float invW = mix( invW0, invW1, t );
      float viewZ = -1.0 / invW;                       // negative, view space
      float sceneD = hizFetch( level, uv );
      float sceneZ = -linearizeDepth( sceneD, uCam.x, uCam.y );

      // View-space z is negative in front of the camera, so "closer" is "greater".
      if ( viewZ > sceneZ ) {
        // Ray is still in front of the closest surface in this cell -> empty.
        prevT = t;
        t += stepSize * exp2( float( level ) );
        level = min( level + 1, maxLevel );
      } else {
        if ( level <= 0 ) { hit = true; hitT = t; break; }
        level = level - 1;
        t = prevT;
        // fall through and retry at a finer level
      }
    }

    if ( hit ) {
      // Binary search refinement.
      float lo = prevT;
      float hi = hitT;
      for ( int b = 0; b < 8; b ++ ) {
        float mid = ( lo + hi ) * 0.5;
        vec2 uv = mix( uv0, uv1, mid );
        float invW = mix( invW0, invW1, mid );
        float viewZ = -1.0 / invW;
        float sceneZ = -linearizeDepth( texture2D( tDepth, uv ).x, uCam.x, uCam.y );
        if ( viewZ > sceneZ ) lo = mid; else hi = mid;
      }
      float tf = hi;
      vec2 uvHit = mix( uv0, uv1, tf );
      float invW = mix( invW0, invW1, tf );
      float rayZ = -1.0 / invW;
      float sceneZ = -linearizeDepth( texture2D( tDepth, uvHit ).x, uCam.x, uCam.y );

      // Thickness test: the ray must have entered the surface, not tunnelled past
      // something thin.
      float penetration = sceneZ - rayZ;               // >0 means ray is behind
      float thickOk = 1.0 - smoothstep( uThickness, uThickness * 3.0, penetration );

      // Never reflect the viewmodel or the sky.
      float skyMask = step( texture2D( tDepth, uvHit ).x, 0.9999 );

      // Roughness cone blur: sample the scene with a radius that grows with the
      // travelled distance and the roughness.
      float travelled = distance( uvHit, vUv );
      float cone = roughness * travelled * 2.4;
      vec3 acc = vec3( 0.0 );
      float wsum = 0.0;
      for ( int k = 0; k < CONE_TAPS; k ++ ) {
        vec2 o = vogelDisc( k, CONE_TAPS, rot * TWO_PI ) * cone;
        vec2 uvs = clamp( uvHit + o, vec2( 0.002 ), vec2( 0.998 ) );
        vec3 c = texture2D( tScene, uvs ).rgb;
        // Reject fireflies so a single blown pixel doesn't smear across the cone.
        float w = 1.0 / ( 1.0 + luma( c ) * 0.25 );
        acc += c * w;
        wsum += w;
      }
      vec3 col = acc / max( wsum, 1e-4 );

      // Screen-edge fade.
      vec2 e = smoothstep( vec2( 0.0 ), vec2( 0.12 ), uvHit ) *
               smoothstep( vec2( 0.0 ), vec2( 0.12 ), vec2( 1.0 ) - uvHit );
      float edge = e.x * e.y;
      // Fade with travel distance so long, unreliable rays dissolve into the probe.
      float distFade = 1.0 - smoothstep( 0.35, 0.95, tf );

      confidence = thickOk * skyMask * edge * backFade * distFade;
      hitColor = mix( fallback, col, confidence );
    } else {
      // A miss usually means the ray walked off the top of the frame, i.e. it left
      // towards the sky. Taking the colour where it exited instead of snapping to the
      // analytic probe is both more correct and — because a neighbouring pixel that
      // *did* hit returns something similar — removes the binary hit/miss dither that
      // one stochastic ray per pixel otherwise produces.
      vec2 exitUv = clamp( lastUv, vec2( 0.003 ), vec2( 0.997 ) );
      vec3 offScreen = texture2D( tScene, exitUv ).rgb;
      hitColor = mix( fallback, offScreen, 0.85 );
      confidence = 0.0;
    }
  }

  // Grazing angles reflect more (Fresnel); face-on metal still reflects strongly.
  float ndv = saturate1( dot( N, V ) );
  float f0 = mix( 0.04, 1.0, metalness );
  float fres = f0 + ( 1.0 - f0 ) * pow( 1.0 - ndv, 5.0 );
  float roughFade = 1.0 - smoothstep( 0.35, 0.75, roughness );

  float strength = uIntensity * fres * roughFade;
  gl_FragColor = vec4( hitColor, strength );
}
`;

const RESOLVE_FRAG = /* glsl */ `
uniform sampler2D tSSR;
uniform sampler2D tDepth;
uniform vec4 uCam;
uniform vec2 uTexel;
varying vec2 vUv;
${GLSL_LIB}
${GLSL_DEPTH}
void main() {
  // Depth-aware 5x5 blur to knock the stochastic ray noise down before TAA. One ray
  // per pixel at half resolution leaves coherent blocks that a 3x3 cannot reach.
  float cd = worldDepthLinear( vUv );
  vec4 sum = vec4( 0.0 );
  float wsum = 0.0;
  for ( int y = -2; y <= 2; y ++ ) {
    for ( int x = -2; x <= 2; x ++ ) {
      vec2 uv = vUv + vec2( float( x ), float( y ) ) * uTexel;
      vec4 s = texture2D( tSSR, uv );
      float d = worldDepthLinear( uv );
      float r = length( vec2( float( x ), float( y ) ) );
      float w = exp( -abs( d - cd ) / max( cd * 0.15, 0.25 ) ) * exp( -r * r * 0.22 );
      sum += s * w;
      wsum += w;
    }
  }
  gl_FragColor = sum / max( wsum, 1e-4 );
}
`;

export default class SSRPass extends Pass {
  constructor(ctx, shared) {
    super('ssr', ctx, shared);
    this.scale = 0.5;
    this.target = null;
    this.temp = null;

    this.uniforms = {
      tScene: { value: null },
      tDepth: shared.tDepth,
      tGBuffer: shared.tGBuffer,
      tHiZ: shared.tHiZ,
      uHiZRect: shared.uHiZRect,
      uHiZLevels: shared.uHiZLevels,
      uCam: shared.uCam,
      uResolution: shared.uResolution,
      uProj: shared.uProj,
      uInvProj: shared.uInvProj,
      uInvView: shared.uInvView,
      uFrame: shared.uFrame,
      uThickness: { value: 0.35 },
      uMaxDistance: { value: 24.0 },
      uIntensity: { value: 1.0 },
      uEnvHorizon: { value: new THREE.Vector3(0.32, 0.36, 0.42) },
      uEnvZenith: { value: new THREE.Vector3(0.22, 0.34, 0.58) },
      uEnvGround: { value: new THREE.Vector3(0.09, 0.085, 0.08) },
    };
    this.material = this.own(
      postMaterial('ssr', SSR_FRAG, this.uniforms, {
        defines: { MAX_STEPS: 40, CONE_TAPS: 6 },
      })
    );

    this.resolveUniforms = {
      tSSR: { value: null },
      tDepth: shared.tDepth,
      uCam: shared.uCam,
      uTexel: { value: new THREE.Vector2() },
    };
    this.resolveMaterial = this.own(postMaterial('ssr:resolve', RESOLVE_FRAG, this.resolveUniforms));
  }

  setQuality(tier, headless) {
    const q = { low: [20, 4], medium: [28, 4], high: [40, 6], ultra: [56, 8] }[tier] || [40, 6];
    const steps = headless ? Math.min(q[0], 32) : q[0];
    if (this.material.defines.MAX_STEPS !== steps || this.material.defines.CONE_TAPS !== q[1]) {
      this.material.defines.MAX_STEPS = steps;
      this.material.defines.CONE_TAPS = q[1];
      this.material.needsUpdate = true;
    }
    this.scale = tier === 'ultra' ? 0.75 : 0.5;
  }

  setSize(w, h) {
    super.setSize(w, h);
    const sw = Math.max(1, Math.round(w * this.scale));
    const sh = Math.max(1, Math.round(h * this.scale));
    this.retarget('target', makeRT(sw, sh, { name: 'ssr' }));
    this.retarget('temp', makeRT(sw, sh, { name: 'ssr.tmp' }));
    this.retarget('temp2', makeRT(sw, sh, { name: 'ssr.tmp2' }));
    this.resolveUniforms.uTexel.value.set(1 / sw, 1 / sh);
    this.g.tSSR.value = this.target.texture;
  }

  /** @param {THREE.Texture} sceneColor HDR colour to reflect */
  render(renderer, sceneColor) {
    if (!this.target) return null;
    this.uniforms.tScene.value = sceneColor;
    blit(renderer, this.material, this.temp);
    // Two resolve iterations: one ray per pixel is noisy enough that a single 3x3
    // depth-aware pass still leaves a visible hatch on wet/polished surfaces.
    this.resolveUniforms.tSSR.value = this.temp.texture;
    blit(renderer, this.resolveMaterial, this.temp2);
    this.resolveUniforms.tSSR.value = this.temp2.texture;
    blit(renderer, this.resolveMaterial, this.target);
    return this.target;
  }
}
