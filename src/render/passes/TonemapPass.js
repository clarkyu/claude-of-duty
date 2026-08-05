/**
 * TonemapPass — exposure, bloom/flare composite, filmic tonemap, colour grade.
 * Owner: render-pipeline agent.
 *
 * Order matches a real colour pipeline:
 *   scene-referred  ->  exposure  ->  white balance  ->  + bloom + flare (dirt-modulated)
 *                   ->  tonemap (AgX or fitted ACES RRT+ODT)
 *   display-referred->  lift/gamma/gain  ->  per-channel curves  ->  split toning
 *                   ->  saturation + vibrance  ->  sRGB OETF
 *
 * Tonemap:
 *   - **AgX** by default. The naive `ACESFilmic` approximation everyone ships desaturates
 *     and hue-shifts bright saturated colours into a mustard smear; AgX keeps hue while
 *     rolling off, which is exactly what modern CoD/Unreal frames look like.
 *   - A properly fitted **ACES RRT+ODT** (Hill's matrices) is available as an option for
 *     comparison; still not the `x*(2.51x+0.03)` one-liner.
 *
 * Grade defaults are where a colourist would leave them for a modern military shooter:
 * a barely-there cool shadow, warm highlight, contrast 1.04, saturation 1.02 and a
 * little vibrance so skin and foliage keep life without the whole frame going neon.
 * Every knob is exposed on `ctx.pipeline.grade` and can be dialled live.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, postMaterial, blit } from './Pass.js';

const TONEMAP_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tFlare;
uniform sampler2D tDirt;
uniform sampler2D tExposure;
uniform vec2 uResolution;

uniform float uBloomStrength;
uniform float uFlareStrength;
uniform float uDirtStrength;

uniform vec3  uWhiteBalance;
uniform float uContrast;
uniform vec3  uLift;
uniform vec3  uGamma;
uniform vec3  uGain;
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uSplitBalance;
uniform float uSaturation;
uniform float uVibrance;
uniform float uShadowCrush;
uniform float uHighlightRolloff;
varying vec2 vUv;

${GLSL_LIB}

/* ---------------- AgX (Troy Sobotka), Rec.2020 working space ---------------- */
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  0.6274, 0.0691, 0.0164,
  0.3293, 0.9195, 0.0880,
  0.0433, 0.0114, 0.8956 );
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
   1.6605, -0.1246, -0.0182,
  -0.5876,  1.1329, -0.1006,
  -0.0728, -0.0083,  1.1187 );
const mat3 AgXInsetMatrix = mat3(
  0.8566271533, 0.1373189729, 0.1118982129,
  0.0951212405, 0.7612419906, 0.0767994186,
  0.0482516061, 0.1014390364, 0.8113023683 );
const mat3 AgXOutsetMatrix = mat3(
   1.1271005818, -0.1413297634, -0.1413297634,
  -0.1106066430,  1.1578237022, -0.1106066430,
  -0.0164939387, -0.0164939387,  1.2519364065 );
const float AgxMinEv = -12.47393;
const float AgxMaxEv = 4.026069;

vec3 agxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5     * x4 * x2
         - 40.14    * x4 * x
         + 31.96    * x4
         - 6.868    * x2 * x
         + 0.4298   * x2
         + 0.1191   * x
         - 0.00232;
}

vec3 tonemapAgX( vec3 color ) {
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * max( color, vec3( 0.0 ) );
  color = AgXInsetMatrix * color;
  color = max( color, 1e-10 );
  color = log2( color );
  color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
  color = clamp( color, 0.0, 1.0 );
  color = agxContrast( color );
  color = AgXOutsetMatrix * color;
  color = pow( max( color, vec3( 0.0 ) ), vec3( 2.2 ) );
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp( color, 0.0, 1.0 );
}

/* ---------------- Fitted ACES RRT + sRGB ODT (Stephen Hill) ---------------- */
const mat3 ACESInputMat = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777 );
const mat3 ACESOutputMat = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602 );

vec3 rrtOdtFit( vec3 v ) {
  vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
  vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
  return a / b;
}
vec3 tonemapACESFitted( vec3 color ) {
  color = ACESInputMat * max( color, vec3( 0.0 ) );
  color = rrtOdtFit( color );
  color = ACESOutputMat * color;
  return clamp( color, 0.0, 1.0 );
}

/* ---------------- grade ---------------- */
vec3 liftGammaGain( vec3 c, vec3 lift, vec3 gamma, vec3 gain ) {
  c = c * gain + lift * ( 1.0 - c );
  return pow( max( c, vec3( 0.0 ) ), max( gamma, vec3( 0.01 ) ) );
}

vec3 splitTone( vec3 c, vec3 shadowTint, vec3 highlightTint, float balance ) {
  float l = luma( c );
  float sw = 1.0 - smoothstep( 0.0, 0.5 + balance * 0.5, l );
  float hw = smoothstep( 0.5 - balance * 0.5, 1.0, l );
  c += shadowTint * sw;
  c += highlightTint * hw;
  return c;
}

vec3 applyVibrance( vec3 c, float amount ) {
  float mx = maxc( c );
  float mn = min( c.r, min( c.g, c.b ) );
  float sat = mx - mn;
  // Boost the least saturated pixels most: that is vibrance, not saturation.
  float boost = amount * ( 1.0 - sat ) * ( 1.0 - sat );
  float l = luma( c );
  return mix( vec3( l ), c, 1.0 + boost );
}

void main() {
  float exposure = texture2D( tExposure, vec2( 0.5 ) ).r;
  exposure = exposure > 0.0 ? exposure : 1.0;

  vec3 color = texture2D( tColor, vUv ).rgb * exposure;

  // Lens dirt modulates how much bloom and flare the "glass" scatters back.
  float dirt = texture2D( tDirt, vUv ).r;
  float dirtMul = 1.0 + dirt * uDirtStrength;

  vec3 bloom = texture2D( tBloom, vUv ).rgb;
  vec3 flare = texture2D( tFlare, vUv ).rgb;
  color = mix( color, bloom, clamp( uBloomStrength * dirtMul, 0.0, 0.9 ) );
  color += flare * uFlareStrength * dirtMul;

  // White balance in scene-referred space, where it physically belongs.
  color *= uWhiteBalance;

  // Log-space contrast around middle grey, pre-tonemap: this is what gives the
  // filmic "toe" its shape instead of crushing the display-referred output.
  vec3 logc = log2( max( color, vec3( 1e-6 ) ) );
  logc = ( logc - log2( 0.18 ) ) * uContrast + log2( 0.18 );
  color = exp2( logc );

  #if TONEMAP_ACES
    vec3 tm = tonemapACESFitted( color );
  #else
    vec3 tm = tonemapAgX( color );
  #endif

  // ---- display-referred grade ----
  vec3 graded = liftGammaGain( tm, uLift, uGamma, uGain );
  graded = splitTone( graded, uShadowTint, uHighlightTint, uSplitBalance );

  // Per-channel curve: a gentle S with independent toe crush and shoulder rolloff.
  graded = graded + uShadowCrush * ( graded * graded * ( 3.0 - 2.0 * graded ) - graded );
  graded = mix( graded, 1.0 - pow( 1.0 - graded, vec3( 1.0 + uHighlightRolloff ) ), 0.5 );

  float l = luma( graded );
  graded = mix( vec3( l ), graded, uSaturation );
  graded = applyVibrance( graded, uVibrance );

  gl_FragColor = vec4( clamp( graded, 0.0, 1.0 ), 1.0 );
}
`;

export default class TonemapPass extends Pass {
  constructor(ctx, shared) {
    super('tonemap', ctx, shared);

    /**
     * Live-tweakable grade. Everything here is deliberately understated.
     *
     * `bloomStrength` feeds a `mix( color, bloom, k )`, which is veiling glare, not an
     * additive highlight: the coarse mips of the bloom chain hold a near-frame-average,
     * so every dark pixel in the frame gets lifted by `k * (frame average)` no matter
     * how far it is from anything bright. Measured on the hero frame, 0.045 + a 0.055
     * flare was adding 50 % to the linear value of the shaded street — the shadows lost
     * half their depth and the whole image read milky. 0.028/0.032 keeps the glow on
     * genuinely bright pixels (where bloom is locally large) and takes the veil off the
     * shadows.
     */
    this.grade = {
      bloomStrength: 0.028,
      flareStrength: 0.032,
      dirtStrength: 0.4,
      whiteBalance: new THREE.Vector3(1.0, 0.998, 0.995),
      contrast: 1.045,
      lift: new THREE.Vector3(0.004, 0.006, 0.012),
      gamma: new THREE.Vector3(1.0, 1.0, 1.005),
      gain: new THREE.Vector3(1.005, 1.0, 0.994),
      shadowTint: new THREE.Vector3(-0.006, 0.0, 0.014),
      highlightTint: new THREE.Vector3(0.014, 0.006, -0.008),
      splitBalance: 0.35,
      saturation: 1.02,
      vibrance: 0.09,
      shadowCrush: 0.06,
      highlightRolloff: 0.12,
    };

    this.uniforms = {
      tColor: { value: null },
      tBloom: shared.tBloom,
      tFlare: shared.tFlare,
      tDirt: shared.tDirt,
      tExposure: shared.tExposure,
      uResolution: shared.uResolution,
      uBloomStrength: { value: this.grade.bloomStrength },
      uFlareStrength: { value: this.grade.flareStrength },
      uDirtStrength: { value: this.grade.dirtStrength },
      uWhiteBalance: { value: this.grade.whiteBalance },
      uContrast: { value: this.grade.contrast },
      uLift: { value: this.grade.lift },
      uGamma: { value: this.grade.gamma },
      uGain: { value: this.grade.gain },
      uShadowTint: { value: this.grade.shadowTint },
      uHighlightTint: { value: this.grade.highlightTint },
      uSplitBalance: { value: this.grade.splitBalance },
      uSaturation: { value: this.grade.saturation },
      uVibrance: { value: this.grade.vibrance },
      uShadowCrush: { value: this.grade.shadowCrush },
      uHighlightRolloff: { value: this.grade.highlightRolloff },
    };
    this.material = this.own(
      postMaterial('tonemap', TONEMAP_FRAG, this.uniforms, { defines: { TONEMAP_ACES: 0 } })
    );
  }

  /** @param {'agx'|'aces'} which */
  setTonemapper(which) {
    const v = which === 'aces' ? 1 : 0;
    if (this.material.defines.TONEMAP_ACES !== v) {
      this.material.defines.TONEMAP_ACES = v;
      this.material.needsUpdate = true;
    }
  }

  syncGrade(bloomEnabled) {
    const g = this.grade;
    const u = this.uniforms;
    u.uBloomStrength.value = bloomEnabled ? g.bloomStrength : 0;
    u.uFlareStrength.value = bloomEnabled ? g.flareStrength : 0;
    u.uDirtStrength.value = g.dirtStrength;
    u.uContrast.value = g.contrast;
    u.uSplitBalance.value = g.splitBalance;
    u.uSaturation.value = g.saturation;
    u.uVibrance.value = g.vibrance;
    u.uShadowCrush.value = g.shadowCrush;
    u.uHighlightRolloff.value = g.highlightRolloff;
  }

  render(renderer, source, target, bloomEnabled) {
    this.syncGrade(bloomEnabled);
    this.uniforms.tColor.value = source;
    blit(renderer, this.material, target);
    return target;
  }
}
