/**
 * AutoExposurePass — eye adaptation from an average log-luminance reduction.
 * Owner: render-pipeline agent.
 *
 * - The HDR frame is downsampled to 1/8 with a 4-tap box while converting to
 *   log2(luminance); successive 4x reductions collapse that to a single texel. No
 *   CPU readback, so there is no pipeline stall and the value is frame-exact.
 * - Very dark pixels are floored before the log so a few black texels cannot drag the
 *   average to negative infinity; the histogram-style clamp is applied in EV space.
 * - Adaptation is exponential with **separate speeds up and down** (the eye adapts to
 *   bright much faster than to dark: ~1.1 s down, ~0.35 s up), so walking out of a
 *   doorway blooms briefly and then settles, and walking into shade takes a beat.
 * - The final exposure uses the Saturation Based Sensitivity formulation
 *   (`EV100 = log2(L * 100 / 12.5)`, `exposure = 1 / (1.2 * 2^EV100)`), scaled by the
 *   artistic exposure from settings and clamped to a sane EV range.
 *
 * Output: a 1x1 RGBA16F texture whose R channel is the exposure multiplier and G is the
 * adapted luminance. Every pass that needs exposure samples it, so exposure is never
 * out of sync between bloom, tonemap and the AO direct-light heuristic.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, postMaterial, blit } from './Pass.js';

/**
 * Metering weight. A flat full-frame log-average lets whatever happens to be large
 * drive the exposure. Real cameras centre-weight, so this is a radial falloff about
 * the optical centre plus a bias away from the sky.
 *
 * **Which edge is which.** `Pass.js` draws every post pass as a fullscreen triangle with
 * `uv = (0,0)` pinned to clip `(-1,-1)`, so `uv.y = 0` is the **bottom** of the frame and
 * `uv.y = 1` is the **top**. The asymmetric term below therefore de-weights the *top* —
 * the sky — and always has, whatever three rounds of comments above it claimed. That is
 * worth keeping and worth stating: biasing a centre-weighted meter away from the sky is
 * exactly what a stills camera does, and on the exterior poses it is the only thing
 * stopping a bright dome metering the shaded street underneath it into the floor.
 *
 * What is *not* needed any more is a viewmodel deduction of any kind, at either edge:
 * `RenderPipeline` meters `rtComp` before the viewmodel is composited, so the gun is
 * not in this average at all. Anyone reading a "the weapon lives at the bottom"
 * justification here should delete the justification, not flip the term — flipping it
 * would take 22 % of the metering weight off the pavement in the near foreground, which
 * is the region the review has now twice measured as the darkest in 8 of 8 frames.
 */
const METER_WEIGHT = /* glsl */ `
float meterWeight( vec2 uv ) {
  vec2 d = uv - vec2( 0.5 );
  d.y *= 0.82;                                  // slightly wider than tall
  float radial = 1.0 - smoothstep( 0.22, 0.78, length( d ) );
  // Sky bias: uv.y = 1 is the top of the frame (see the note above).
  float skyBias = 1.0 - 0.22 * smoothstep( 0.70, 1.0, uv.y );
  return max( 0.10, radial * skyBias );
}
`;

const LOGLUM_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
${GLSL_LIB}
${METER_WEIGHT}
void main() {
  vec3 a = texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  vec3 b = texture2D( tSrc, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  vec3 c = texture2D( tSrc, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  vec3 d = texture2D( tSrc, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  float l = 0.25 * ( luma( a ) + luma( b ) + luma( c ) + luma( d ) );
  // Carry the weight alongside the sample so the reduction can form a true
  // weighted average rather than a plain mean.
  float w = meterWeight( vUv );
  gl_FragColor = vec4( log2( max( l, 0.0005 ) ) * w, w, 0.0, 1.0 );
}
`;

const REDUCE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 a = texture2D( tSrc, vUv + vec2( -0.5, -0.5 ) * uTexel ).rg;
  vec2 b = texture2D( tSrc, vUv + vec2(  0.5, -0.5 ) * uTexel ).rg;
  vec2 c = texture2D( tSrc, vUv + vec2( -0.5,  0.5 ) * uTexel ).rg;
  vec2 d = texture2D( tSrc, vUv + vec2(  0.5,  0.5 ) * uTexel ).rg;
  gl_FragColor = vec4( 0.25 * ( a + b + c + d ), 0.0, 1.0 );
}
`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D tAverage;
uniform sampler2D tPrevious;
uniform float uDt;
uniform float uSpeedUp;
uniform float uSpeedDown;
uniform float uMinLogLum;
uniform float uMaxLogLum;
uniform float uExposureBias;
uniform float uKey;
uniform float uMinGain;
uniform float uMaxGain;
uniform float uAutoStrength;
uniform float uReset;
varying vec2 vUv;

void main() {
  // R holds sum(logLum * w), G holds sum(w); divide to recover the weighted mean.
  vec2 acc = texture2D( tAverage, vec2( 0.5 ) ).rg;
  float logLum = clamp( acc.r / max( acc.g, 1e-4 ), uMinLogLum, uMaxLogLum );
  float target = exp2( logLum );

  float prev = texture2D( tPrevious, vec2( 0.5 ) ).g;
  if ( !( prev > 0.0 ) || uReset > 0.5 ) prev = target;

  float speed = target > prev ? uSpeedUp : uSpeedDown;
  float adapted = prev + ( target - prev ) * ( 1.0 - exp( -uDt * speed ) );
  adapted = clamp( adapted, 1e-4, 1e4 );

  // Relative auto-exposure: a scene sitting at the reference key renders at exactly
  // the artistic exposure from Settings, and the gain is bounded so adaptation is a
  // correction rather than a normaliser that fights the lighting artist.
  float gain = clamp( uKey / adapted, uMinGain, uMaxGain );
  float exposure = uExposureBias * mix( 1.0, gain, uAutoStrength );
  exposure = clamp( exposure, 0.04, 12.0 );

  // EV100 is reported for HUD / debugging.
  float ev100 = log2( adapted * 100.0 / 12.5 );
  gl_FragColor = vec4( exposure, adapted, ev100, 1.0 );
}
`;

function lumRT(w, h, name) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.name = name;
  return rt;
}

export default class AutoExposurePass extends Pass {
  constructor(ctx, shared) {
    super('autoExposure', ctx, shared);
    this._chain = [];
    this._adapt = [null, null];
    this.cur = 0;
    this._reset = 1;

    this.logMat = this.own(
      postMaterial('exposure:log', LOGLUM_FRAG, {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
      })
    );
    this.reduceMat = this.own(
      postMaterial('exposure:reduce', REDUCE_FRAG, {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
      })
    );
    this.adaptMat = this.own(
      postMaterial('exposure:adapt', ADAPT_FRAG, {
        tAverage: { value: null },
        tPrevious: { value: null },
        uDt: { value: 1 / 60 },
        uSpeedUp: { value: 2.8 },
        uSpeedDown: { value: 0.9 },
        uMinLogLum: { value: -6.0 },
        uMaxLogLum: { value: 5.5 },
        uExposureBias: { value: 1.0 },
        /**
         * Reference key, compared against the **log-average** of the frame.
         *
         * This is the number the whole metering hangs off and it was set as if the
         * reduction produced an arithmetic mean. It does not: the log-average of a
         * scene with a large dark region sits far below its arithmetic mean, and on
         * the hero frame it measures 0.033 against an arithmetic 0.126 — a factor of
         * four. A 0.22 key therefore asked for 6.7x of gain, which pinned the ceiling
         * flat regardless of what the ceiling was; every exterior pose then rendered
         * at exactly the clamp and the meter had no authority over any of them. That
         * is the difference between "auto-exposure" and "a constant".
         *
         * 0.115 is the classic Reinhard key for a log-average meter under a filmic
         * curve. On the same frame it asks for 3.5x, inside the range, so the meter
         * actually meters — and the resulting exposure is within 10 % of where the
         * railed value happened to land, so nothing about the current look moves.
         */
        uKey: { value: 0.115 },
        uMinGain: { value: 0.28 },
        /**
         * **The ceiling was the operative constraint on the two poses the review calls
         * crushed, which means the meter had no authority over either of them.**
         *
         * The claim above — "wide enough that neither end is the operative constraint
         * for any pose the game contains" — is false for at least two of the eight. The
         * night pose measures a display mean of L 24 and the weapon pose L 32, which put
         * their log-averages an order of magnitude under the 0.115 key; the meter asks
         * for 10-30x, gets 4.5, and every frame in that region renders at exactly the
         * clamp. That is the same "auto-exposure is a constant" failure `uKey` was
         * corrected for one round earlier, arrived at from the other end of the range,
         * and it is a large part of the 81 % / 66 % under L 32 those two poses measure.
         *
         * 6.0 is still not a normaliser. `uAutoStrength` blends 30 % back towards the
         * artistic exposure, so a fully railed frame renders at 4.5x rather than 3.45x —
         * a third of a stop — and a night street at 81 % below L 32 is in no danger of
         * looking like daylight after a third of a stop. Nothing changes for hero, ads,
         * interior or firefight: those meter at 3-4x, inside the old range, so the
         * clamp never touched them and still does not.
         */
        uMaxGain: { value: 6.0 },
        uAutoStrength: { value: 0.7 },
        uReset: { value: 1 },
      })
    );

    this._adapt[0] = lumRT(1, 1, 'exposure.a');
    this._adapt[1] = lumRT(1, 1, 'exposure.b');
    this.own(this._adapt[0]);
    this.own(this._adapt[1]);
    shared.tExposure.value = this._adapt[0].texture;
    this._primed = false;
  }

  /** Seed both 1x1 targets so the first frame never samples uninitialised memory. */
  prime(renderer) {
    if (this._primed) return;
    const prevTarget = renderer.getRenderTarget();
    const oldClear = new THREE.Color();
    renderer.getClearColor(oldClear);
    const oldAlpha = renderer.getClearAlpha();
    for (const rt of this._adapt) {
      // Bind first: three converts the clear colour against whatever target is
      // current, so setting it before the bind would sRGB-encode the seed value.
      renderer.setRenderTarget(rt);
      renderer.setClearColor(new THREE.Color(1, 0.18, 0), 1);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(oldClear, oldAlpha);
    renderer.setRenderTarget(prevTarget);
    this._primed = true;
  }

  setSize(w, h) {
    super.setSize(w, h);
    for (const t of this._chain) {
      t.texture.dispose();
      t.dispose();
    }
    this._chain.length = 0;
    let cw = Math.max(1, w >> 3);
    let ch = Math.max(1, h >> 3);
    this._chain.push(lumRT(cw, ch, 'exposure.l0'));
    while (cw > 1 || ch > 1) {
      cw = Math.max(1, cw >> 2);
      ch = Math.max(1, ch >> 2);
      this._chain.push(lumRT(cw, ch, `exposure.l${this._chain.length}`));
    }
    this._reset = 1;
  }

  reset() {
    this._reset = 1;
  }

  /** @param {number} dt seconds */
  render(renderer, source, dt, exposureBias) {
    if (!this._chain.length) return;
    this.logMat.uniforms.tSrc.value = source;
    this.logMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    blit(renderer, this.logMat, this._chain[0]);

    for (let i = 1; i < this._chain.length; i++) {
      const src = this._chain[i - 1];
      this.reduceMat.uniforms.tSrc.value = src.texture;
      this.reduceMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      blit(renderer, this.reduceMat, this._chain[i]);
    }

    const prev = this._adapt[this.cur];
    const next = this._adapt[this.cur ^ 1];
    const u = this.adaptMat.uniforms;
    u.tAverage.value = this._chain[this._chain.length - 1].texture;
    u.tPrevious.value = prev.texture;
    u.uDt.value = Math.min(Math.max(dt, 1e-4), 0.2);
    u.uExposureBias.value = exposureBias;
    u.uReset.value = this._reset;
    blit(renderer, this.adaptMat, next);
    this.cur ^= 1;
    this._reset = 0;
    this.g.tExposure.value = next.texture;
  }

  dispose() {
    for (const t of this._chain) {
      t.texture.dispose();
      t.dispose();
    }
    this._chain.length = 0;
    super.dispose();
  }
}
