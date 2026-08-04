/**
 * DebugPass — the visualisation layer the review agents use to diagnose the frame.
 * Owner: render-pipeline agent.
 *
 * `ctx.pipeline.setDebugView(mode)` / `window.__COD.debugView(mode)` with one of:
 *   null | 'albedo' | 'normal' | 'roughness' | 'metalness' | 'depth' | 'velocity'
 *        | 'ao' | 'ssr' | 'bloom' | 'overdraw' | 'exposure' | 'volumetrics'
 *
 * Modes that need surface data ('albedo', 'roughness', 'metalness') are produced by
 * GBufferPass swapping in stand-in materials for one pass; 'normal' comes from the
 * depth-reconstructed normal the AO and SSR passes actually consume, so what you see is
 * what those passes see. 'overdraw' additively accumulates every fragment with depth
 * testing off and maps the count through a heat ramp.
 *
 * Every mode writes sRGB directly to the canvas, bypassing tonemapping, so the numbers
 * on screen are the numbers in the buffer.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, GLSL_DEPTH, GLSL_DEPTH_VIEW, postMaterial, blit } from './Pass.js';

const DEBUG_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tDepthView;
uniform sampler2D tVelocity;
uniform sampler2D tAO;
uniform sampler2D tSSR;
uniform sampler2D tBloom;
uniform sampler2D tGBuffer;
uniform sampler2D tVolume;
uniform sampler2D tExposure;
uniform vec4 uCam;
uniform vec2 uResolution;
uniform mat4 uInvProj;
uniform int uMode;
varying vec2 vUv;

${GLSL_LIB}
${GLSL_DEPTH}
${GLSL_DEPTH_VIEW}

vec3 heat( float t ) {
  t = clamp( t, 0.0, 1.0 );
  return clamp( vec3( 1.5 - abs( 4.0 * t - 3.0 ), 1.5 - abs( 4.0 * t - 2.0 ), 1.5 - abs( 4.0 * t - 1.0 ) ), 0.0, 1.0 );
}

void main() {
  vec3 c = vec3( 0.0 );

  if ( uMode == 1 ) {                                  // albedo (already in tColor)
    c = texture2D( tColor, vUv ).rgb;
  } else if ( uMode == 2 ) {                           // normal (view space)
    vec3 n = normalFromDepth( vUv, 1.0 / uResolution, uInvProj );
    c = n * 0.5 + 0.5;
  } else if ( uMode == 3 ) {                           // roughness
    c = vec3( texture2D( tGBuffer, vUv ).g );
  } else if ( uMode == 4 ) {                           // metalness
    c = vec3( texture2D( tGBuffer, vUv ).b );
  } else if ( uMode == 5 ) {                           // depth
    float d = sceneDepthLinear( vUv );
    float t = 1.0 - exp( -d * 0.03 );
    c = heat( t );
  } else if ( uMode == 6 ) {                           // velocity
    vec2 v = texture2D( tVelocity, vUv ).xy * uResolution;
    float m = length( v );
    c = vec3( 0.5 + v.x * 0.02, 0.5 + v.y * 0.02, clamp( m * 0.02, 0.0, 1.0 ) );
  } else if ( uMode == 7 ) {                           // ambient occlusion
    c = vec3( texture2D( tAO, vUv ).r );
  } else if ( uMode == 8 ) {                           // ssr
    vec4 s = texture2D( tSSR, vUv );
    c = s.rgb * s.a;
  } else if ( uMode == 9 ) {                           // bloom
    c = texture2D( tBloom, vUv ).rgb;
  } else if ( uMode == 10 ) {                          // overdraw (tColor = counter)
    float n = texture2D( tColor, vUv ).r * 20.0;
    c = heat( n / 12.0 );
  } else if ( uMode == 11 ) {                          // exposure readout
    float e = texture2D( tExposure, vec2( 0.5 ) ).r;
    float lum = texture2D( tExposure, vec2( 0.5 ) ).g;
    c = vec3( texture2D( tColor, vUv ).rgb ) * e;
    // Left edge strip: exposure, right edge strip: adapted luminance.
    if ( vUv.x < 0.02 ) c = heat( clamp( e / 4.0, 0.0, 1.0 ) );
    if ( vUv.x > 0.98 ) c = heat( clamp( lum / 4.0, 0.0, 1.0 ) );
  } else if ( uMode == 12 ) {                          // volumetrics
    vec4 v = texture2D( tVolume, vUv );
    c = v.rgb * 6.0;
  } else {
    c = texture2D( tColor, vUv ).rgb;
  }

  gl_FragColor = vec4( linearToSRGB( clamp( c, 0.0, 1.0 ) ), 1.0 );
}
`;

export const DEBUG_MODES = {
  albedo: 1,
  normal: 2,
  roughness: 3,
  metalness: 4,
  depth: 5,
  velocity: 6,
  ao: 7,
  ssr: 8,
  bloom: 9,
  overdraw: 10,
  exposure: 11,
  volumetrics: 12,
};

export default class DebugPass extends Pass {
  constructor(ctx, shared) {
    super('debug', ctx, shared);
    this.mode = null;

    this.uniforms = {
      tColor: { value: null },
      tDepth: shared.tDepth,
      tDepthView: shared.tDepthView,
      tVelocity: shared.tVelocity,
      tAO: shared.tAO,
      tSSR: shared.tSSR,
      tBloom: shared.tBloom,
      tGBuffer: shared.tGBuffer,
      tVolume: shared.tVolume,
      tExposure: shared.tExposure,
      uCam: shared.uCam,
      uResolution: shared.uResolution,
      uInvProj: shared.uInvProj,
      uMode: { value: 0 },
    };
    this.material = this.own(postMaterial('debug', DEBUG_FRAG, this.uniforms));

    this.overdrawMaterial = this.own(
      new THREE.MeshBasicMaterial({
        color: 0x0d0d0d,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      })
    );
    this.overdrawMaterial.toneMapped = false;
  }

  /** @returns {boolean} true when the mode is recognised */
  setMode(mode) {
    if (!mode) {
      this.mode = null;
      this.uniforms.uMode.value = 0;
      return true;
    }
    const id = DEBUG_MODES[mode];
    if (!id) return false;
    this.mode = mode;
    this.uniforms.uMode.value = id;
    return true;
  }

  render(renderer, source, target) {
    this.uniforms.tColor.value = source;
    blit(renderer, this.material, target);
    return target;
  }
}
