/**
 * CompositePass — folds the screen-space lighting buffers back into the HDR frame in a
 * single full-resolution read. Owner: render-pipeline agent.
 *
 * Applies, in order:
 *   1. **Ambient occlusion, on indirect light only.** The frame is forward-shaded, so
 *      there is no separate ambient buffer to multiply. Instead we estimate how
 *      ambient-dominated each pixel is and only darken that fraction:
 *        - a *scene-referred* luminance term (radiance is physical here: a sunlit
 *          surface sits above 1.0, a sky-lit one well below), and
 *        - an N·L term against the sun direction (surfaces facing away from the sun
 *          can only be lit indirectly, so they take AO in full).
 *      Deliberately NOT keyed off the auto-exposure value: exposure is derived from
 *      this pass's output, so feeding it back in closes a negative feedback loop with
 *      a one-frame delay, which oscillates the whole frame's brightness every other
 *      frame. Scene-referred thresholds are stable because they are absolute.
 *      Direct light is therefore never multiplied by AO — the failure mode that makes
 *      SSAO read as dirt smeared over the image.
 *   2. **Screen-space reflections**, weighted by the SSR confidence and a Fresnel /
 *      roughness term already baked into the SSR alpha, added as extra specular.
 *   3. **Volumetric in-scattering**: `colour * transmittance + inscatter`.
 *
 * Debug hooks: `setDebugView('ao' | 'ssr' | 'volumetrics')` shows each input buffer on
 * its own, so the review agents can see exactly what this pass was handed.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, GLSL_DEPTH, postMaterial, blit } from './Pass.js';

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform sampler2D tSSR;
uniform sampler2D tVolume;
uniform sampler2D tGBuffer;
uniform sampler2D tDepth;
uniform vec4 uCam;
uniform vec2 uResolution;
uniform mat4 uInvProj;
uniform vec3 uSunDirView;
uniform float uUseAO;
uniform float uUseSSR;
uniform float uUseVolume;
uniform float uAOStrength;
uniform float uAODirectProtect;
uniform float uSSRStrength;
uniform float uVolumeStrength;
varying vec2 vUv;

${GLSL_LIB}
${GLSL_DEPTH}

void main() {
  vec3 color = texture2D( tScene, vUv ).rgb;
  float rawD = texture2D( tDepth, vUv ).x;
  bool isSky = rawD >= 0.9999;

  if ( !isSky ) {
    // Smooth normal on purpose — this only weights how much AO is allowed to bite,
    // and the branchy reconstruction dithers on flat surfaces.
    vec3 N = smoothNormalFromDepth( vUv, 2.0 / uResolution, uInvProj );

    // ---- 1. ambient occlusion, indirect only --------------------------------
    if ( uUseAO > 0.5 ) {
      float ao = texture2D( tAO, vUv ).r;
      ao = clamp( ao, 0.0, 1.0 );

      // How much of this pixel is plausibly *direct* light? Absolute, scene-referred.
      float brightDirect = smoothstep( 0.45, 1.8, luma( color ) );
      float ndl = saturate1( dot( N, uSunDirView ) );
      float facingSun = smoothstep( 0.05, 0.55, ndl );
      float directFrac = saturate1( brightDirect * facingSun ) * uAODirectProtect;

      // Multi-bounce keeps mid-grey albedo from going to soot in the crevices.
      vec3 aoRGB = gtaoMultiBounce( ao, vec3( 0.28 ) );
      vec3 applied = mix( aoRGB, vec3( 1.0 ), directFrac );
      applied = mix( vec3( 1.0 ), applied, uAOStrength );
      color *= applied;
    }

    // ---- 2. screen-space reflections ----------------------------------------
    if ( uUseSSR > 0.5 ) {
      vec4 ssr = texture2D( tSSR, vUv );
      vec4 orm = texture2D( tGBuffer, vUv );
      float metal = clamp( orm.b, 0.0, 1.0 );
      // Metals tint their reflection with the surface; dielectrics do not.
      vec3 tint = mix( vec3( 1.0 ), normalize( max( color, vec3( 1e-4 ) ) ) * 1.4, metal * 0.7 );
      color += ssr.rgb * tint * ssr.a * uSSRStrength;
    }
  }

  // ---- 3. volumetrics --------------------------------------------------------
  if ( uUseVolume > 0.5 ) {
    vec4 v = texture2D( tVolume, vUv );
    // The sky already contains its own atmosphere; extinguishing it again would put a
    // grey veil over the whole upper half of the frame. Shafts still add to it.
    float transmittance = isSky ? 1.0 : clamp( v.a, 0.0, 1.0 );
    color = color * transmittance + v.rgb * uVolumeStrength;
  }

  gl_FragColor = vec4( max( color, vec3( 0.0 ) ), 1.0 );
}
`;

export default class CompositePass extends Pass {
  constructor(ctx, shared) {
    super('composite', ctx, shared);
    this.uniforms = {
      tScene: { value: null },
      tAO: shared.tAO,
      tSSR: shared.tSSR,
      tVolume: shared.tVolume,
      tGBuffer: shared.tGBuffer,
      tDepth: shared.tDepth,
      uCam: shared.uCam,
      uResolution: shared.uResolution,
      uInvProj: shared.uInvProj,
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uUseAO: { value: 0 },
      uUseSSR: { value: 0 },
      uUseVolume: { value: 0 },
      /**
       * The material now applies its own occlusion to the *indirect* term, floored and
       * tinted towards the measured facade bounce (see render/Lighting.js, the
       * `COD_CONTACT` block). This pass multiplies the finished pixel on top of that, so
       * at full strength the same geometry is occluded twice — which is most of how
       * 32-59 % of pixels ended up under L 32. Keep it as an edge-detail term.
       */
      uAOStrength: { value: 0.8 },
      uAODirectProtect: { value: 0.85 },
      // SSR is additive on top of whatever specular the forward pass already produced,
      // so it is deliberately under unity to avoid double-counting the environment.
      uSSRStrength: { value: 0.72 },
      uVolumeStrength: { value: 1.0 },
    };
    this.material = this.own(postMaterial('composite', COMPOSITE_FRAG, this.uniforms));
  }

  render(renderer, sceneTexture, target, flags) {
    this.uniforms.tScene.value = sceneTexture;
    this.uniforms.uUseAO.value = flags.ao ? 1 : 0;
    this.uniforms.uUseSSR.value = flags.ssr ? 1 : 0;
    this.uniforms.uUseVolume.value = flags.volume ? 1 : 0;
    blit(renderer, this.material, target);
    return target;
  }
}
