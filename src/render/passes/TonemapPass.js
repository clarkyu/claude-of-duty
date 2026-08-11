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
uniform vec3  uAgxLook;   // x slope, y power, z saturation — see agxLook()
uniform float uAgxHiSat;  // extra chroma restored in the top of the range
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

/**
 * **The AgX "look" transform — the half everyone forgets to ship.**
 *
 * AgX is two pieces: a log-encoded sigmoid that rolls highlights off without clipping,
 * and an ASC-CDL look applied *inside* the log domain that puts the chroma back. Ship
 * only the first (which is what three.js does, and what this pass did) and the inset
 * matrix's 11-14 % channel cross-mix is never undone, so the brightest, most saturated
 * part of the frame is also the most desaturated part of the output.
 *
 * The review measured that precisely: hero R-B by luminance decile running
 * +15.8, +41.5, +25.3 — the *top* decile turning back towards neutral — and firefight's
 * lit plaza reading R-B +26 while its own shadow reads +76. The sunlight was the least
 * golden thing in a golden-hour frame, which is the whole reason the set reads beige.
 *
 * Saturation here is applied around the luminance of the log-encoded value, so it only
 * rotates chroma and cannot change exposure or re-introduce clipping.
 */
vec3 agxLook( vec3 c ) {
  float l = luma( c );
  c = pow( max( c * uAgxLook.x, vec3( 0.0 ) ), vec3( uAgxLook.y ) );
  /**
   * The inset cross-mix is a fixed matrix, but the sigmoid compresses the top of the
   * range hardest, so a *constant* saturation leaves the brightest part of the frame
   * the flattest part of the output. Measured on the hero pose after the look transform
   * shipped: R-B by luminance decile ... 23.3, 44.8, **30.4** — the top decile turning
   * back towards neutral while the one below it is fully golden. The sun is still the
   * least golden thing in a golden-hour frame, just less so than before.
   *
   * Ramping the restoration with the log-encoded luminance gives the highlights back
   * the share the inset took from them. It is a rotation about the luminance, so it
   * cannot change exposure and cannot re-introduce clipping.
   *
   * **Weighted by how warm the pixel already is, and that part is not optional.**
   * Measured with a flat ramp: on the hero pose the top-centre sky went from R-B +8 to
   * -31 and, being the brightest large area in the frame, took over the brightest-5 %
   * population outright — key/fill separation fell from 26.7 to -2.9. "Put back the
   * chroma the sigmoid compressed" is the right instruction for the *key*; applied to
   * the sky as well it just swaps which end of the frame is over-saturated. With the
   * weight, a sunlit facade at R/B 2.5:1 gets about half the boost and 4:1 gets all of
   * it, while anything neutral or cool keeps the 1.26 the rest of the frame gets.
   */
  float warm = clamp( ( c.r - c.b ) * 7.0, 0.0, 1.0 );
  float sat = uAgxLook.z * ( 1.0 + uAgxHiSat * smoothstep( 0.52, 0.93, l ) * warm );
  return max( vec3( l ) + sat * ( c - vec3( l ) ), vec3( 0.0 ) );
}

vec3 tonemapAgX( vec3 color ) {
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * max( color, vec3( 0.0 ) );
  color = AgXInsetMatrix * color;
  color = max( color, 1e-10 );
  color = log2( color );
  color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
  color = clamp( color, 0.0, 1.0 );
  color = agxContrast( color );
  color = agxLook( color );
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
      /**
       * The flare buffer is a *chromatic* ghost — that is what makes it read as glass —
       * and the AgX look transform added below multiplies chroma by 1.26 on the way out.
       * At 0.032 the pair turned the muzzle flash in the firefight frame into a rainbow
       * arc across a third of the image, which is the same defect the review logged as
       * "heavy chromatic-aberration rainbows on frame edges". 0.012 keeps a ghost on a
       * genuinely bright source and stops it painting the wall behind it.
       */
      flareStrength: 0.012,
      dirtStrength: 0.3,
      whiteBalance: new THREE.Vector3(1.0, 0.998, 0.995),
      contrast: 1.085,
      /**
       * **`lift` and `shadowTint` are added to *display-referred linear* light, so a
       * value that looks tiny written down is enormous once encoded.**
       *
       * `liftGammaGain()` evaluates to `lift` exactly at black, and `splitTone()` adds
       * the full `shadowTint` there too, so the pair sets the frame's black point
       * outright. The previous 0.012 + 0.014 put it at 0.026 linear blue against
       * 0.000 red — sRGB (0, 18, 46), a flatly teal black that measured on the hero
       * frame as the darkest pixel in the image. Every shadow in the level inherited
       * it, which is most of what read as "strong blue cast": not the lighting at all,
       * but a grade adding a fixed 46/255 of blue underneath it.
       *
       * These values put the black point at sRGB (0, 5, 20) — still recognisably a
       * cool shadow, and still enough separation from 0 to keep the toe from looking
       * digital, but roughly a fifth of the tint.
       */
      /**
       * **Corrected once more: (0, 5, 20) was not a black point, it was no black point.**
       *
       * Taking the teal cast out was right, but it was taken out by very nearly deleting
       * the toe altogether, and the set-level measurement caught the cost: the fraction
       * of the frame under L 32 went from 30.1 % to 39.7 % across eight poses, with the
       * three sky-dominated frames — night 49 -> 79, vista 12.7 -> 35.4, weapon 55 -> 64 —
       * carrying most of it. A film stock does not resolve below its base density; a
       * digital zero reads as a hole and it is the single biggest contributor to the
       * "crushed" finding.
       *
       * These land the black point at roughly sRGB (6, 10, 18) — L 9.7 against the
       * previous 5.0 and the round-2 teal's 16.2. Still recognisably a cool near-black,
       * still a third of the tint that was doing the damage, and it costs nothing
       * anywhere else in the range because `lift` decays as `1 - c`.
       */
      lift: new THREE.Vector3(0.003, 0.0032, 0.0042),
      gamma: new THREE.Vector3(1.0, 1.0, 1.005),
      gain: new THREE.Vector3(1.005, 1.0, 0.994),
      shadowTint: new THREE.Vector3(-0.001, 0.0, 0.0022),
      // A touch more warmth where the key lands: the highlight end is the half of the
      // golden-hour contrast the set has never actually had. See `agxHiSat` below.
      highlightTint: new THREE.Vector3(0.019, 0.008, -0.011),
      splitBalance: 0.35,
      saturation: 1.02,
      vibrance: 0.09,
      // The toe crush is a second deduction on top of the black point, applied to the
      // same pixels; with the black point back it is no longer needed at full strength.
      shadowCrush: 0.07,
      /**
       * The rolloff pushes the top of the range towards 1 in every channel at once, so
       * every stop it adds is a stop of channel separation taken *out* of the brightest
       * part of the frame — which is exactly where the review measures the key as least
       * golden. Halved; the AgX shoulder is already doing the real highlight work.
       */
      highlightRolloff: 0.06,
      /**
       * AgX look: slope, power, saturation — see `agxLook()`. 1.26 is a shade under
       * Blender's "Punchy" (1.3) and is the term that stops the key desaturating exactly
       * where it is strongest. Slope and power stay at unity: the sigmoid already owns
       * the contrast, and this must not become a second grade.
       */
      agxLook: new THREE.Vector3(1.0, 1.0, 1.26),
      /**
       * Extra saturation blended into the *warm* top of the log range — see `agxLook()`.
       * 0.30 takes a strongly golden highlight to about 1.49 while leaving the mids, and
       * everything neutral or cool at any brightness, on the 1.26 the review credited.
       */
      agxHiSat: 0.3,
    };

    /**
     * How far towards the ambient illuminant the balance is pulled: 0 leaves
     * `grade.whiteBalance` alone, 1 would render open shade perfectly neutral (and
     * take all the gold out of the key with it). See syncWhiteBalance().
     */
    /**
     * Trimmed from 0.42 now that the *key* is graded at source.
     *
     * The balance was doing two jobs: neutralising a violently blue open shade, and
     * buying the warmth that a physically-honest 4900 K sun would not give. It bought
     * the second by taking 18 % out of blue and adding 22 % to red across the entire
     * frame — including the sky, which is the one surface in an exterior that is
     * *supposed* to be blue, and which the review measured at a channel spread of 2
     * parts in 255. `render/Sky.js` now grades the sun itself on an altitude curve, so
     * the warmth arrives as light rather than as a global channel tilt, and the shade is
     * warmed by a measured facade bounce rather than by pretending the film is tungsten.
     * What is left here is an ordinary partial shade balance.
     */
    this.balanceStrength = 0.18;

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
      // Owns its own vector: syncWhiteBalance() writes the *derived* balance here and
      // must never scribble on the authored `grade.whiteBalance` it derives it from.
      uWhiteBalance: { value: new THREE.Vector3().copy(this.grade.whiteBalance) },
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
      uAgxLook: { value: this.grade.agxLook },
      uAgxHiSat: { value: this.grade.agxHiSat },
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

  /**
   * Camera white balance, pulled part-way towards the *ambient* (shade) illuminant.
   *
   * This is the single knob that separates "golden hour" from "cold and CG". A sky-lit
   * surface in open shade is genuinely lit by 12000 K+ light, so a sensor balanced for
   * 5500 K renders it violently blue — which is exactly what the shaded street was
   * doing: measured B:R of 2.55 on asphalt whose albedo is neutral grey. A stills
   * photographer's answer at this hour is not to fix the lighting, it is to balance
   * warmer: pull white towards the shade, and the *same* frame turns the shadows
   * neutral and the sunlit facades gold. Both halves of the complaint, one operation,
   * and it is a real thing real cameras do.
   *
   * The correction is the ambient's inverse, luminance-normalised so it never changes
   * the exposure, taken to a fractional power (a partial balance — a full one would
   * neutralise the shade completely and take the warmth out of the key with it) and
   * faded out at night, where the eye expects cool and the "ambient" is moonlight
   * rather than sky.
   */
  syncWhiteBalance() {
    const sky = this.ctx?.sky;
    const amb = sky?.ambientColor;
    const wb = this.uniforms.uWhiteBalance.value;
    const base = this.grade.whiteBalance;
    if (!amb || !Number.isFinite(amb.r) || amb.r <= 1e-6 || amb.g <= 1e-6 || amb.b <= 1e-6) {
      wb.copy(base);
      return;
    }
    const night = Math.min(Math.max(sky.nightFactor ?? 0, 0), 1);
    const k = this.balanceStrength * (1 - night);
    if (k <= 1e-3) {
      wb.copy(base);
      return;
    }
    // Luminance-normalise the illuminant first, so only its *hue* drives the balance.
    const lum = 0.2126 * amb.r + 0.7152 * amb.g + 0.0722 * amb.b;
    if (!(lum > 1e-6)) {
      wb.copy(base);
      return;
    }
    let r = Math.pow(lum / amb.r, k);
    let g = Math.pow(lum / amb.g, k);
    let b = Math.pow(lum / amb.b, k);
    // Re-normalise: white balance must not double as an exposure change.
    const wl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (!(wl > 1e-6)) {
      wb.copy(base);
      return;
    }
    const inv = 1 / wl;
    const lo = 0.82;
    const hi = 1.22;
    wb.set(
      Math.min(Math.max(r * inv * base.x, lo), hi),
      Math.min(Math.max(g * inv * base.y, lo), hi),
      Math.min(Math.max(b * inv * base.z, lo), hi)
    );
  }

  syncGrade(bloomEnabled) {
    const g = this.grade;
    const u = this.uniforms;
    this.syncWhiteBalance();
    u.uBloomStrength.value = bloomEnabled ? g.bloomStrength : 0;
    u.uFlareStrength.value = bloomEnabled ? g.flareStrength : 0;
    u.uDirtStrength.value = g.dirtStrength;
    u.uContrast.value = g.contrast;
    u.uSplitBalance.value = g.splitBalance;
    u.uSaturation.value = g.saturation;
    u.uVibrance.value = g.vibrance;
    u.uShadowCrush.value = g.shadowCrush;
    u.uHighlightRolloff.value = g.highlightRolloff;
    u.uAgxHiSat.value = g.agxHiSat;
  }

  render(renderer, source, target, bloomEnabled) {
    this.syncGrade(bloomEnabled);
    this.uniforms.tColor.value = source;
    blit(renderer, this.material, target);
    return target;
  }
}
