/**
 * DOFPass — physical depth of field with separated near / far fields.
 * Owner: render-pipeline agent.
 *
 * Circle of confusion comes from real lens maths, not an artistic curve:
 *
 *     CoC(mm) = |S2 - S1| / S2 * f^2 / ( N * ( S1 - f ) )
 *
 * with `f` the focal length, `N` the f-number, `S1` the focus distance and `S2` the
 * subject distance. It is converted to pixels through the sensor height (36x24 mm
 * full frame), so changing the aperture behaves exactly like changing it on a real
 * lens. Focus is pulled automatically towards whatever is under the crosshair, with a
 * spring so it does not snap, and the aperture opens when the player aims down sights
 * — the standard cinematic ADS rack-focus.
 *
 * Gather:
 *   - Half-resolution premultiplied prepare pass storing (colour, signed CoC).
 *   - Two golden-angle disc gathers, one per field. Splitting them is what removes
 *     haloing across depth discontinuities: the far field only accepts taps that are
 *     not closer than the centre (so a sharp foreground never bleeds into a blurred
 *     background), while the near field accepts everything and carries its own
 *     coverage alpha (so a blurred foreground correctly spills over a sharp
 *     background).
 *   - The near field's CoC is dilated with a max filter before gathering, otherwise
 *     out-of-focus foreground objects get a hard, obviously-wrong silhouette.
 *   - Sample positions are on a hexagon-warped disc, which gives the faint hex bokeh
 *     of a real 6-blade aperture rather than a perfectly round CG circle.
 *
 * Subtle by default (f/5.6-ish), stronger when ADS.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, GLSL_DEPTH, GLSL_DEPTH_VIEW, postMaterial, blit, makeRT } from './Pass.js';

/**
 * Auto-focus runs entirely on the GPU in a 1x1 ping-pong, exactly like the exposure
 * adaptation, so there is never a `readRenderTargetPixels` stall in the frame. It takes
 * the *nearest* depth in a small patch under the crosshair (a rack focus should snap to
 * the thing you are aiming at, not average it with the wall behind) and springs towards
 * it.
 */
const FOCUS_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tPrev;
uniform vec4 uCam;
uniform vec2 uTexel;
uniform float uDt;
uniform float uSpeed;
uniform float uManual;   // >0 overrides autofocus
uniform float uReset;
varying vec2 vUv;
${GLSL_LIB}
void main() {
  float best = 1e9;
  for ( int y = -2; y <= 2; y ++ ) {
    for ( int x = -2; x <= 2; x ++ ) {
      vec2 uv = vec2( 0.5 ) + vec2( float( x ), float( y ) ) * uTexel * 6.0;
      float raw = texture2D( tDepth, uv ).x;
      if ( raw >= 0.9999 ) continue;
      best = min( best, linearizeDepth( raw, uCam.x, uCam.y ) );
    }
  }
  float target = best > 1e8 ? 45.0 : clamp( best, 0.35, 220.0 );
  if ( uManual > 0.0 ) target = uManual;

  float prev = texture2D( tPrev, vec2( 0.5 ) ).r;
  if ( !( prev > 0.0 ) || uReset > 0.5 ) prev = target;
  float f = prev + ( target - prev ) * ( 1.0 - exp( -uDt * uSpeed ) );
  gl_FragColor = vec4( clamp( f, 0.2, 400.0 ), target, 0.0, 1.0 );
}
`;

const COC_PREPARE_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tDepthView;
uniform sampler2D tFocus;
uniform vec4 uCam;
uniform vec2 uTexel;        // full-res texel
uniform float uFocalLength; // metres
uniform float uAperture;    // f-number
uniform float uSensorHeight;// metres
uniform float uMaxCoC;      // pixels, full-res
uniform float uScreenHeight;
varying vec2 vUv;
${GLSL_LIB}
${GLSL_DEPTH}
${GLSL_DEPTH_VIEW}

float cocPixels( float dist, float focusDist ) {
  float f = uFocalLength;
  float S1 = max( focusDist, f * 1.02 );
  float S2 = max( dist, 1e-3 );
  float cocM = abs( S2 - S1 ) / S2 * ( f * f ) / ( uAperture * ( S1 - f ) );
  float px = cocM / uSensorHeight * uScreenHeight;
  return sign( S1 - S2 ) * min( px, uMaxCoC );   // >0 = near field
}

void main() {
  // 2x2 box on the full-res colour so the half-res prepare is not aliased.
  vec3 c0 = texture2D( tColor, vUv + vec2( -0.5, -0.5 ) * uTexel ).rgb;
  vec3 c1 = texture2D( tColor, vUv + vec2(  0.5, -0.5 ) * uTexel ).rgb;
  vec3 c2 = texture2D( tColor, vUv + vec2( -0.5,  0.5 ) * uTexel ).rgb;
  vec3 c3 = texture2D( tColor, vUv + vec2(  0.5,  0.5 ) * uTexel ).rgb;
  vec3 color = ( c0 + c1 + c2 + c3 ) * 0.25;

  float focus = texture2D( tFocus, vec2( 0.5 ) ).r;
  focus = focus > 0.0 ? focus : 8.0;
  float d = sceneDepthLinear( vUv );
  float coc = cocPixels( d, focus );
  gl_FragColor = vec4( color, coc );
}
`;

const NEAR_COC_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  // Max-dilate the near CoC so a blurred foreground has soft, spreading edges.
  float m = 0.0;
  for ( int y = -2; y <= 2; y ++ ) {
    for ( int x = -2; x <= 2; x ++ ) {
      float c = texture2D( tSrc, vUv + vec2( float( x ), float( y ) ) * uTexel ).a;
      m = max( m, max( c, 0.0 ) );
    }
  }
  vec4 s = texture2D( tSrc, vUv );
  gl_FragColor = vec4( s.rgb, m );
}
`;

const GATHER_FRAG = /* glsl */ `
uniform sampler2D tSrc;       // (colour, coc) at half res
uniform sampler2D tNear;      // (colour, dilated near coc)
uniform vec2 uTexel;
uniform float uFrame;
uniform float uMaxCoC;        // half-res pixels
varying vec2 vUv;
${GLSL_LIB}

// Warp a disc sample onto a hexagon — a 6-blade aperture, softly.
vec2 hexWarp( vec2 p ) {
  float a = atan( p.y, p.x );
  float r = length( p );
  float k = cos( PI / 6.0 ) / cos( mod( a, PI / 3.0 ) - PI / 6.0 );
  return p * mix( 1.0, k, 0.35 );
}

void main() {
#if NEAR_FIELD
  vec4 center = texture2D( tNear, vUv );
  float centerCoC = max( center.a, 0.0 );
#else
  vec4 center = texture2D( tSrc, vUv );
  float centerCoC = max( -center.a, 0.0 );
#endif

  if ( centerCoC < 0.5 ) {
    gl_FragColor = vec4( center.rgb, 0.0 );
    return;
  }

  float radius = min( centerCoC, uMaxCoC );
  float rot = ignTemporal( gl_FragCoord.xy, uFrame ) * TWO_PI;

  vec3 acc = vec3( 0.0 );
  float wsum = 0.0;
  float coverage = 0.0;

  for ( int i = 0; i < TAPS; i ++ ) {
    vec2 disc = hexWarp( vogelDisc( i, TAPS, rot ) );
    vec2 off = disc * radius * uTexel;
    vec2 uv = clamp( vUv + off, vec2( 0.001 ), vec2( 0.999 ) );

#if NEAR_FIELD
    vec4 s = texture2D( tNear, uv );
    float sCoC = max( s.a, 0.0 );
    // A near-field tap contributes if its own blur reaches this pixel.
    float w = saturate1( ( sCoC - length( disc ) * radius ) * 0.5 + 0.5 );
    coverage += w;
#else
    vec4 s = texture2D( tSrc, uv );
    float sCoC = max( -s.a, 0.0 );
    // Reject taps that are much sharper than the centre: that is the halo.
    float w = saturate1( ( sCoC - length( disc ) * radius ) * 0.5 + 0.5 );
    w *= sCoC >= centerCoC * 0.35 ? 1.0 : 0.15;
#endif
    // Energy normalisation: a bigger CoC spreads the same energy over more area.
    float e = 1.0 / max( sCoC * sCoC * 0.25, 1.0 );
    w *= e;
    acc += s.rgb * w;
    wsum += w;
  }

  vec3 col = wsum > 1e-4 ? acc / wsum : center.rgb;
#if NEAR_FIELD
  gl_FragColor = vec4( col, saturate1( coverage / float( TAPS ) * 1.6 ) );
#else
  gl_FragColor = vec4( col, saturate1( centerCoC / max( uMaxCoC, 1.0 ) ) );
#endif
}
`;

const COMBINE_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tFar;
uniform sampler2D tNear;
uniform sampler2D tPrepare;
uniform sampler2D tDepth;
uniform sampler2D tDepthView;
uniform vec4 uCam;
uniform vec2 uHalfTexel;
uniform float uMaxCoC;
varying vec2 vUv;
${GLSL_LIB}
${GLSL_DEPTH}
${GLSL_DEPTH_VIEW}

void main() {
  vec3 sharp = texture2D( tColor, vUv ).rgb;
  float coc = texture2D( tPrepare, vUv ).a;

  // Far field: blend in by how out of focus this pixel is.
  vec4 far = texture2D( tFar, vUv );
  float farBlend = saturate1( ( max( -coc, 0.0 ) - 0.6 ) / max( uMaxCoC * 0.55, 1.0 ) );
  vec3 col = mix( sharp, far.rgb, saturate1( farBlend ) );

  // Near field composites *over* everything, using its own coverage.
  vec4 near = texture2D( tNear, vUv );
  col = mix( col, near.rgb, saturate1( near.a ) );

  gl_FragColor = vec4( col, 1.0 );
}
`;

export default class DOFPass extends Pass {
  constructor(ctx, shared) {
    super('dof', ctx, shared);
    this.scale = 0.5;

    /** Aim-down-sights opens the aperture and pulls focus. Driven by `weapon:ads`. */
    this.ads = false;

    this.lens = {
      focalLength: 0.035, // 35 mm
      aperture: 5.6,
      sensorHeight: 0.024,
      adsAperture: 2.4,
      adsFocalLength: 0.055,
      maxCoCFraction: 0.012, // of screen height
      adsMaxCoCFraction: 0.026,
    };

    this.focusMat = this.own(
      postMaterial('dof:focus', FOCUS_FRAG, {
        tDepth: shared.tDepth,
        tPrev: { value: null },
        uCam: shared.uCam,
        uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uDt: { value: 1 / 60 },
        uSpeed: { value: 2.6 },
        uManual: { value: 0 },
        uReset: { value: 1 },
      })
    );
    this._focus = [
      this.own(makeRT(1, 1, { name: 'dof.focus0', filter: THREE.NearestFilter })),
      this.own(makeRT(1, 1, { name: 'dof.focus1', filter: THREE.NearestFilter })),
    ];
    this._focusCur = 0;
    this._focusPrimed = false;
    /** Set > 0 to lock focus at a distance in metres. */
    this.manualFocus = 0;

    this.prepUniforms = {
      tColor: { value: null },
      tDepth: shared.tDepth,
      tDepthView: shared.tDepthView,
      tFocus: { value: this._focus[0].texture },
      uCam: shared.uCam,
      uTexel: { value: new THREE.Vector2() },
      uFocalLength: { value: 0.035 },
      uAperture: { value: 5.6 },
      uSensorHeight: { value: 0.024 },
      uMaxCoC: { value: 10 },
      uScreenHeight: { value: 1080 },
    };
    this.prepMat = this.own(postMaterial('dof:prepare', COC_PREPARE_FRAG, this.prepUniforms));

    this.nearCoCMat = this.own(
      postMaterial('dof:nearcoc', NEAR_COC_FRAG, {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
      })
    );

    const gatherUniforms = () => ({
      tSrc: { value: null },
      tNear: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uFrame: shared.uFrame,
      uMaxCoC: { value: 5 },
    });
    this.farMat = this.own(
      postMaterial('dof:far', GATHER_FRAG, gatherUniforms(), {
        defines: { TAPS: 24, NEAR_FIELD: 0 },
      })
    );
    this.nearMat = this.own(
      postMaterial('dof:near', GATHER_FRAG, gatherUniforms(), {
        defines: { TAPS: 24, NEAR_FIELD: 1 },
      })
    );

    this.combineUniforms = {
      tColor: { value: null },
      tFar: { value: null },
      tNear: { value: null },
      tPrepare: { value: null },
      tDepth: shared.tDepth,
      tDepthView: shared.tDepthView,
      uCam: shared.uCam,
      uHalfTexel: { value: new THREE.Vector2() },
      uMaxCoC: { value: 10 },
    };
    this.combineMat = this.own(postMaterial('dof:combine', COMBINE_FRAG, this.combineUniforms));
  }

  setQuality(tier, headless) {
    const taps = { low: 12, medium: 16, high: 24, ultra: 32 }[tier] ?? 24;
    const t = headless ? Math.min(taps, 20) : taps;
    for (const m of [this.farMat, this.nearMat]) {
      if (m.defines.TAPS !== t) {
        m.defines.TAPS = t;
        m.needsUpdate = true;
      }
    }
  }

  setSize(w, h) {
    super.setSize(w, h);
    const hw = Math.max(1, Math.round(w * this.scale));
    const hh = Math.max(1, Math.round(h * this.scale));
    this.retarget('prepare', makeRT(hw, hh, { name: 'dof.prepare' }));
    this.retarget('nearCoC', makeRT(hw, hh, { name: 'dof.nearCoC' }));
    this.retarget('far', makeRT(hw, hh, { name: 'dof.far' }));
    this.retarget('near', makeRT(hw, hh, { name: 'dof.near' }));
    this.prepUniforms.uTexel.value.set(1 / w, 1 / h);
    this.prepUniforms.uScreenHeight.value = h;
    this.focusMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.focusMat.uniforms.uReset.value = 1;
    this.nearCoCMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.farMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.nearMat.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.combineUniforms.uHalfTexel.value.set(1 / hw, 1 / hh);
  }

  /** Seed the 1x1 focus targets so the first frame never reads uninitialised memory. */
  prime(renderer) {
    if (this._focusPrimed) return;
    const prevTarget = renderer.getRenderTarget();
    const old = new THREE.Color();
    renderer.getClearColor(old);
    const oldAlpha = renderer.getClearAlpha();
    for (const rt of this._focus) {
      // Bind before setting the clear colour — see AutoExposurePass.prime().
      renderer.setRenderTarget(rt);
      renderer.setClearColor(new THREE.Color(8, 8, 0), 1);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(old, oldAlpha);
    renderer.setRenderTarget(prevTarget);
    this._focusPrimed = true;
  }

  resetFocus() {
    this.focusMat.uniforms.uReset.value = 1;
  }

  /** GPU-side auto-focus: 1x1 ping-pong, no readback, no stall. */
  updateFocus(renderer, dt) {
    const u = this.focusMat.uniforms;
    u.tPrev.value = this._focus[this._focusCur].texture;
    u.uDt.value = Math.min(Math.max(dt, 1e-4), 0.2);
    u.uSpeed.value = this.ads ? 6.5 : 2.4;
    u.uManual.value = this.manualFocus > 0 ? this.manualFocus : 0;
    const dst = this._focus[this._focusCur ^ 1];
    blit(renderer, this.focusMat, dst);
    this._focusCur ^= 1;
    u.uReset.value = 0;
    this.prepUniforms.tFocus.value = dst.texture;
  }

  render(renderer, source, target, dt) {
    if (!this.prepare) return null;
    this.prime(renderer);
    this.updateFocus(renderer, dt);

    const L = this.lens;
    const fl = this.ads ? L.adsFocalLength : L.focalLength;
    const ap = this.ads ? L.adsAperture : L.aperture;
    const maxCoCPx =
      this.height * (this.ads ? L.adsMaxCoCFraction : L.maxCoCFraction);

    const u = this.prepUniforms;
    u.tColor.value = source;
    u.uFocalLength.value = fl;
    u.uAperture.value = ap;
    u.uSensorHeight.value = L.sensorHeight;
    u.uMaxCoC.value = maxCoCPx;
    blit(renderer, this.prepMat, this.prepare);

    this.nearCoCMat.uniforms.tSrc.value = this.prepare.texture;
    blit(renderer, this.nearCoCMat, this.nearCoC);

    const halfMax = maxCoCPx * this.scale;
    this.farMat.uniforms.tSrc.value = this.prepare.texture;
    this.farMat.uniforms.tNear.value = this.nearCoC.texture;
    this.farMat.uniforms.uMaxCoC.value = halfMax;
    blit(renderer, this.farMat, this.far);

    this.nearMat.uniforms.tSrc.value = this.prepare.texture;
    this.nearMat.uniforms.tNear.value = this.nearCoC.texture;
    this.nearMat.uniforms.uMaxCoC.value = halfMax;
    blit(renderer, this.nearMat, this.near);

    const c = this.combineUniforms;
    c.tColor.value = source;
    c.tFar.value = this.far.texture;
    c.tNear.value = this.near.texture;
    c.tPrepare.value = this.prepare.texture;
    c.uMaxCoC.value = maxCoCPx;
    blit(renderer, this.combineMat, target);
    return target;
  }
}
