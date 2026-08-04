/**
 * GTAOPass — Ground-Truth Ambient Occlusion (Jimenez et al. 2016), horizon-search
 * form, with a depth-aware bilateral cross blur and temporal jitter.
 * Owner: render-pipeline agent.
 *
 * - Hemisphere visibility via the GTAO arc integral (not the cosine-weighted SSAO
 *   hack), so the falloff and the contact darkening are energy-correct.
 * - Normals are reconstructed from depth with the "closest neighbour" derivative
 *   pick, which keeps thin geometry (railings, wires, ladders) from smearing its
 *   normal across the silhouette and over-occluding the background.
 * - A thickness heuristic bounds how much a sample in front of the horizon can
 *   occlude, so thin foreground objects do not project fat black halos.
 * - Slice direction and step offset rotate per pixel (interleaved gradient noise)
 *   and per frame (golden ratio), so TAA converges the remaining noise away.
 * - Output is *visibility* in R (1 = unoccluded) plus linear depth in G for the
 *   bilateral blur and the upsample in the composite.
 *
 * The result is multiplied into indirect/ambient light only — see CompositePass, which
 * splits the shaded frame into a direct-dominant and ambient-dominant part before
 * applying it. AO is never allowed to darken a directly lit surface.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, GLSL_DEPTH, postMaterial, blit, makeRT } from './Pass.js';

const GTAO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec4 uCam;
uniform vec2 uResolution;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform float uFrame;
uniform float uRadius;      // world-space metres
uniform float uThickness;   // metres; how solid an occluder is assumed to be
uniform float uIntensity;
uniform vec2 uAoTexel;      // texel size of THIS (half-res) target
varying vec2 vUv;

${GLSL_LIB}
${GLSL_DEPTH}

void main() {
  float rawD = texture2D( tDepth, vUv ).x;
  float linD = linearizeDepth( rawD, uCam.x, uCam.y );

  // Sky / far plane: fully visible.
  if ( rawD >= 0.9999 ) { gl_FragColor = vec4( 1.0, linD, 0.0, 1.0 ); return; }

  vec2 fullTexel = 1.0 / uResolution;
  vec3 P = viewPosFromDepth( vUv, rawD, uInvProj );
  vec3 N = normalFromDepth( vUv, fullTexel, uInvProj );
  vec3 V = normalize( -P );

  // Screen-space radius of the world-space sampling sphere.
  float projScale = uProj[1][1] * 0.5 * uResolution.y;   // pixels per unit at z = 1
  float radiusPx = uRadius * projScale / max( linD, 0.02 );
  radiusPx = clamp( radiusPx, 4.0, 96.0 );

  // NB: do NOT scale the frame index by phi here — ignTemporal already advances by
  // 1/phi per frame, and phi * (1/phi) == 1 makes the sequence constant in time, which
  // freezes the sampling pattern into visible rings on flat ground.
  float noise = ignTemporal( gl_FragCoord.xy, uFrame );
  float noise2 = ignTemporal( gl_FragCoord.xy + 17.0, uFrame + 0.37 );

  float visibility = 0.0;
  float sliceCount = float( SLICES );
  float stepCount = float( STEPS );

  for ( int s = 0; s < SLICES; s ++ ) {
    float phi = ( float( s ) + noise ) * PI / sliceCount;
    vec2 sliceDir2 = vec2( cos( phi ), sin( phi ) );
    vec3 sliceDir = vec3( sliceDir2, 0.0 );

    vec3 planeNormal = normalize( cross( sliceDir, V ) );
    vec3 tangent = cross( V, planeNormal );
    vec3 projN = N - planeNormal * dot( N, planeNormal );
    float projNLen = length( projN );
    if ( projNLen < 1e-4 ) continue;
    vec3 projNn = projN / projNLen;

    float sgn = sign( dot( projNn, tangent ) );
    float cosN = clamp( dot( projNn, V ), -1.0, 1.0 );
    float n = sgn * acos( cosN );

    // Horizon search along both halves of the slice.
    // Sign convention: any direction in the slice plane is cos(t)*V + sin(t)*tangent,
    // and tangent points along +sliceDir. So marching +sliceDir finds the horizon on
    // the POSITIVE side (h2) and -sliceDir the negative side (h1). Getting this the
    // wrong way round makes flat ground read as fully occluded.
    float cosH1 = -1.0;   // -sliceDir half
    float cosH2 = -1.0;   // +sliceDir half
    for ( int t = 0; t < STEPS; t ++ ) {
      float frac = ( float( t ) + noise2 ) / stepCount;
      float dist = frac * frac * radiusPx + 1.0;   // quadratic: dense near the centre
      vec2 offset = sliceDir2 * dist / uResolution;

      // --- +sliceDir ---
      vec2 uvA = vUv + offset;
      if ( uvA.x > 0.0 && uvA.x < 1.0 && uvA.y > 0.0 && uvA.y < 1.0 ) {
        float dA = texture2D( tDepth, uvA ).x;
        if ( dA < 0.9999 ) {
          vec3 dv = viewPosFromDepth( uvA, dA, uInvProj ) - P;
          float len = length( dv );
          if ( len > 1e-5 ) {
            float c = dot( dv / len, V );
            // Range falloff + thickness: an occluder only counts while it is inside
            // the sampling sphere, and its influence decays past uThickness.
            float fall = saturate1( 1.0 - ( len - uRadius ) / max( uThickness, 1e-3 ) );
            cosH2 = max( cosH2, mix( cosH2, c, fall ) );
          }
        }
      }

      // --- -sliceDir ---
      vec2 uvB = vUv - offset;
      if ( uvB.x > 0.0 && uvB.x < 1.0 && uvB.y > 0.0 && uvB.y < 1.0 ) {
        float dB = texture2D( tDepth, uvB ).x;
        if ( dB < 0.9999 ) {
          vec3 dv = viewPosFromDepth( uvB, dB, uInvProj ) - P;
          float len = length( dv );
          if ( len > 1e-5 ) {
            float c = dot( dv / len, V );
            float fall = saturate1( 1.0 - ( len - uRadius ) / max( uThickness, 1e-3 ) );
            cosH1 = max( cosH1, mix( cosH1, c, fall ) );
          }
        }
      }
    }

    float h1 = -acos( clamp( cosH1, -1.0, 1.0 ) );
    float h2 =  acos( clamp( cosH2, -1.0, 1.0 ) );
    h1 = n + max( h1 - n, -HALF_PI );
    h2 = n + min( h2 - n,  HALF_PI );

    float sinN = sin( n );
    float arc =
      ( -cos( 2.0 * h1 - n ) + cosN + 2.0 * h1 * sinN ) +
      ( -cos( 2.0 * h2 - n ) + cosN + 2.0 * h2 * sinN );
    visibility += projNLen * 0.25 * arc;
  }

  visibility = saturate1( visibility / sliceCount );
  visibility = pow( visibility, uIntensity );

  gl_FragColor = vec4( visibility, linD, 0.0, 1.0 );
}
`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uDirection;   // texel-sized step
uniform float uDepthSigma;
varying vec2 vUv;

void main() {
  vec2 c = texture2D( tAO, vUv ).rg;
  float centerDepth = c.g;
  float sum = c.r * 0.2270270270;
  float wsum = 0.2270270270;

  // 9-tap gaussian, bilateral on linear depth.
  const float o1 = 1.3846153846;
  const float o2 = 3.2307692308;
  const float w1 = 0.3162162162;
  const float w2 = 0.0702702703;

  for ( int i = 0; i < 4; i ++ ) {
    float off = ( i == 0 || i == 1 ) ? o1 : o2;
    float wg  = ( i == 0 || i == 1 ) ? w1 : w2;
    float sgn = ( i == 0 || i == 2 ) ? 1.0 : -1.0;
    vec2 uv = vUv + uDirection * off * sgn;
    vec2 s = texture2D( tAO, uv ).rg;
    float dw = exp( -abs( s.g - centerDepth ) / max( uDepthSigma * max( centerDepth, 1.0 ) * 0.02, 1e-4 ) );
    float w = wg * dw;
    sum += s.r * w;
    wsum += w;
  }
  gl_FragColor = vec4( sum / max( wsum, 1e-4 ), centerDepth, 0.0, 1.0 );
}
`;

export default class GTAOPass extends Pass {
  constructor(ctx, shared) {
    super('gtao', ctx, shared);
    this.scale = 0.5;
    this.target = null;
    this.temp = null;

    this.uniforms = {
      tDepth: shared.tDepth,
      uCam: shared.uCam,
      uResolution: shared.uResolution,
      uInvProj: shared.uInvProj,
      uProj: shared.uProj,
      uFrame: shared.uFrame,
      uRadius: { value: 1.1 },
      uThickness: { value: 0.55 },
      uIntensity: { value: 1.25 },
      uAoTexel: { value: new THREE.Vector2() },
    };
    this.material = this.own(
      postMaterial('gtao', GTAO_FRAG, this.uniforms, {
        defines: { SLICES: 3, STEPS: 6 },
      })
    );

    this.blurUniforms = {
      tAO: { value: null },
      uDirection: { value: new THREE.Vector2() },
      uDepthSigma: { value: 1.0 },
    };
    this.blurMaterial = this.own(postMaterial('gtao:blur', BLUR_FRAG, this.blurUniforms));
  }

  /** @param {'low'|'medium'|'high'|'ultra'} tier */
  setQuality(tier, headless) {
    const q = { low: [2, 4], medium: [2, 5], high: [3, 6], ultra: [4, 8] }[tier] || [3, 6];
    const slices = headless ? Math.min(q[0], 3) : q[0];
    const steps = headless ? Math.min(q[1], 6) : q[1];
    if (this.material.defines.SLICES !== slices || this.material.defines.STEPS !== steps) {
      this.material.defines.SLICES = slices;
      this.material.defines.STEPS = steps;
      this.material.needsUpdate = true;
    }
    this.scale = tier === 'ultra' ? 1.0 : 0.5;
  }

  setSize(w, h) {
    super.setSize(w, h);
    const aw = Math.max(1, Math.round(w * this.scale));
    const ah = Math.max(1, Math.round(h * this.scale));
    this.retarget('target', makeRT(aw, ah, { name: 'gtao' }));
    this.retarget('temp', makeRT(aw, ah, { name: 'gtao.tmp' }));
    this.uniforms.uAoTexel.value.set(1 / aw, 1 / ah);
    this.g.tAO.value = this.target.texture;
  }

  render(renderer) {
    if (!this.target) return null;
    blit(renderer, this.material, this.target);

    const aw = this.target.width;
    const ah = this.target.height;
    this.blurUniforms.tAO.value = this.target.texture;
    this.blurUniforms.uDirection.value.set(1 / aw, 0);
    blit(renderer, this.blurMaterial, this.temp);
    this.blurUniforms.tAO.value = this.temp.texture;
    this.blurUniforms.uDirection.value.set(0, 1 / ah);
    blit(renderer, this.blurMaterial, this.target);
    return this.target;
  }
}
