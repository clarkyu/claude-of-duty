/**
 * BloomPass — physically-motivated bloom, CoD:AW / Unreal style.
 * Owner: render-pipeline agent.
 *
 * Chain (Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare"):
 *   - Bright pass with a **soft knee** in exposure-relative HDR. The threshold sits at
 *     roughly the tonemapper's white point, so mid-grey never blooms — only genuine
 *     emissives, specular highlights and sky.
 *   - 13-tap downsample with **Karis average** on the first level: each 2x2 group is
 *     weighted by 1/(1+luma) before averaging, which kills the single-pixel fireflies
 *     that otherwise strobe through the whole mip chain under TAA.
 *   - 6 progressive mips, then a 9-tap **tent upsample** blended additively back up the
 *     chain. That produces the wide, soft, energy-preserving falloff a gaussian of the
 *     same cost cannot.
 *
 * Lens flare is generated here because this is where the bright-pass mips live:
 * radially mirrored ghosts with per-channel chromatic offsets, a halo ring, and a
 * horizontal anamorphic streak. Everything is derived from actually-bright pixels, so
 * nothing flares unless something in the scene is genuinely blowing out.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, postMaterial, blit, makeRT } from './Pass.js';

const PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tExposure;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;
varying vec2 vUv;
${GLSL_LIB}

vec3 karisTap( vec2 uv ) {
  vec3 c = texture2D( tSrc, uv ).rgb;
  return c;
}

void main() {
  float exposure = texture2D( tExposure, vec2( 0.5 ) ).r;
  exposure = exposure > 0.0 ? exposure : 1.0;

  // 4-tap box with Karis (luma) weighting: firefly suppression at the source.
  vec3 a = karisTap( vUv + vec2( -1.0, -1.0 ) * uTexel );
  vec3 b = karisTap( vUv + vec2(  1.0, -1.0 ) * uTexel );
  vec3 c = karisTap( vUv + vec2( -1.0,  1.0 ) * uTexel );
  vec3 d = karisTap( vUv + vec2(  1.0,  1.0 ) * uTexel );
  float wa = 1.0 / ( 1.0 + luma( a ) * exposure );
  float wb = 1.0 / ( 1.0 + luma( b ) * exposure );
  float wc = 1.0 / ( 1.0 + luma( c ) * exposure );
  float wd = 1.0 / ( 1.0 + luma( d ) * exposure );
  vec3 col = ( a * wa + b * wb + c * wc + d * wd ) / max( wa + wb + wc + wd, 1e-4 );

  col *= exposure;
  col = min( col, vec3( uClamp ) );

  // Soft-knee threshold (Unreal / Karis).
  float br = maxc( col );
  float soft = br - uThreshold + uKnee;
  soft = clamp( soft, 0.0, 2.0 * uKnee );
  soft = soft * soft / ( 4.0 * uKnee + 1e-5 );
  float contribution = max( soft, br - uThreshold ) / max( br, 1e-5 );

  gl_FragColor = vec4( col * contribution, 1.0 );
}
`;

const DOWNSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
${GLSL_LIB}
void main() {
  // 13-tap "dual filter" downsample (Jimenez).
  vec3 a = texture2D( tSrc, vUv + vec2( -2.0, -2.0 ) * uTexel ).rgb;
  vec3 b = texture2D( tSrc, vUv + vec2(  0.0, -2.0 ) * uTexel ).rgb;
  vec3 c = texture2D( tSrc, vUv + vec2(  2.0, -2.0 ) * uTexel ).rgb;
  vec3 d = texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  vec3 e = texture2D( tSrc, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  vec3 f = texture2D( tSrc, vUv + vec2( -2.0,  0.0 ) * uTexel ).rgb;
  vec3 g = texture2D( tSrc, vUv ).rgb;
  vec3 h = texture2D( tSrc, vUv + vec2(  2.0,  0.0 ) * uTexel ).rgb;
  vec3 i = texture2D( tSrc, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  vec3 j = texture2D( tSrc, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  vec3 k = texture2D( tSrc, vUv + vec2( -2.0,  2.0 ) * uTexel ).rgb;
  vec3 l = texture2D( tSrc, vUv + vec2(  0.0,  2.0 ) * uTexel ).rgb;
  vec3 m = texture2D( tSrc, vUv + vec2(  2.0,  2.0 ) * uTexel ).rgb;

  vec3 inner  = ( d + e + i + j ) * 0.125;
  vec3 outer0 = ( a + b + g + f ) * 0.03125;
  vec3 outer1 = ( b + c + h + g ) * 0.03125;
  vec3 outer2 = ( f + g + l + k ) * 0.03125;
  vec3 outer3 = ( g + h + m + l ) * 0.03125;
  gl_FragColor = vec4( inner + outer0 + outer1 + outer2 + outer3, 1.0 );
}
`;

const UPSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tSrc;      // smaller mip
uniform sampler2D tDst;      // the mip we are adding into
uniform vec2 uTexel;         // texel size of tSrc
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uRadius;
  // 9-tap tent.
  vec3 s =
    texture2D( tSrc, vUv + vec2( -o.x,  o.y ) ).rgb * 1.0 +
    texture2D( tSrc, vUv + vec2(  0.0,  o.y ) ).rgb * 2.0 +
    texture2D( tSrc, vUv + vec2(  o.x,  o.y ) ).rgb * 1.0 +
    texture2D( tSrc, vUv + vec2( -o.x,  0.0 ) ).rgb * 2.0 +
    texture2D( tSrc, vUv                      ).rgb * 4.0 +
    texture2D( tSrc, vUv + vec2(  o.x,  0.0 ) ).rgb * 2.0 +
    texture2D( tSrc, vUv + vec2( -o.x, -o.y ) ).rgb * 1.0 +
    texture2D( tSrc, vUv + vec2(  0.0, -o.y ) ).rgb * 2.0 +
    texture2D( tSrc, vUv + vec2(  o.x, -o.y ) ).rgb * 1.0;
  s *= 1.0 / 16.0;
  gl_FragColor = vec4( texture2D( tDst, vUv ).rgb + s, 1.0 );
}
`;

const FLARE_FRAG = /* glsl */ `
uniform sampler2D tSrc;      // a small bright-pass mip
uniform vec2 uTexel;
uniform float uGhostSpacing;
uniform float uHaloWidth;
uniform float uChroma;
uniform float uStreak;
varying vec2 vUv;
${GLSL_LIB}

/**
 * Per-channel radial offset — real ghosts disperse, they are never grey.
 *
 * The dispersion is capped, which it was not: the ghost loop passed
 * uChroma * (i + 1), so the fourth ghost sampled R and B **0.032 uv apart** — 41 px
 * at 1280 — off a mip that is already a broad blur of the brightest thing in frame. A
 * muzzle flash therefore did not produce a ghost, it produced a red arc and a blue arc
 * a couple of centimetres apart, which is the "quarter-frame flare rainbow" the review
 * has logged twice. Real dispersion in a coated lens is a fraction of a percent of the
 * frame and it does not grow without bound down the ghost train.
 */
vec3 sampleChroma( vec2 uv, vec2 dir, float amount ) {
  float a = min( amount, 0.006 );
  return vec3(
    texture2D( tSrc, uv + dir * a ).r,
    texture2D( tSrc, uv ).g,
    texture2D( tSrc, uv - dir * a ).b );
}

void main() {
  vec2 uv = 1.0 - vUv;                 // ghosts are the image mirrored through centre
  vec2 toCenter = vec2( 0.5 ) - uv;
  vec2 dir = normalize( toCenter + 1e-6 );

  vec3 result = vec3( 0.0 );
  for ( int i = 0; i < GHOSTS; i ++ ) {
    vec2 offset = toCenter * ( float( i ) + 1.0 ) * uGhostSpacing;
    vec2 guv = uv + offset;
    if ( guv.x < 0.0 || guv.x > 1.0 || guv.y < 0.0 || guv.y > 1.0 ) continue;
    float w = length( vec2( 0.5 ) - guv ) / length( vec2( 0.5 ) );
    w = pow( 1.0 - clamp( w, 0.0, 1.0 ), 6.0 );
    result += sampleChroma( guv, dir, uChroma * ( float( i ) + 1.0 ) ) * w;
  }

  // Halo: a soft ring at a fixed radius. Must reject off-screen the same way the
  // ghost loop above does — fract() here wrapped the ring around the frame edge,
  // so a blown highlight at centre painted its dispersed halo into the opposite
  // corners as large red arcs.
  vec2 haloVec = dir * uHaloWidth;
  vec2 haloUv = uv + haloVec;
  if ( haloUv.x >= 0.0 && haloUv.x <= 1.0 && haloUv.y >= 0.0 && haloUv.y <= 1.0 ) {
    float haloW = length( vec2( 0.5 ) - haloUv ) / length( vec2( 0.5 ) );
    haloW = pow( 1.0 - clamp( haloW, 0.0, 1.0 ), 8.0 );
    result += sampleChroma( haloUv, dir, uChroma * 2.0 ) * haloW * 0.7;
  }

  // Anamorphic streak: a wide, low-amplitude horizontal smear.
  vec3 streak = vec3( 0.0 );
  float wsum = 0.0;
  for ( int s = -8; s <= 8; s ++ ) {
    float fs = float( s );
    vec2 suv = vUv + vec2( fs * uTexel.x * 6.0, 0.0 );
    float w = exp( -fs * fs * 0.06 );
    streak += texture2D( tSrc, clamp( suv, vec2( 0.001 ), vec2( 0.999 ) ) ).rgb * w;
    wsum += w;
  }
  streak /= max( wsum, 1e-4 );
  /**
   * The anamorphic smear is a *wide horizontal band* — it is the one part of the flare
   * that covers real area — so a hard (0.35, 0.55, 1.0) tint on it is a blue wash laid
   * across whatever the brightest thing in frame is standing next to. In a golden-hour
   * frame that is the sunlit facade, and it is a large part of why the brightest decile
   * measures as the least golden part of the image. Anamorphic flares are cool, not
   * cyan; keep the bias and lose the cast.
   */
  result += streak * vec3( 0.74, 0.85, 1.0 ) * uStreak;

  gl_FragColor = vec4( max( result, vec3( 0.0 ) ), 1.0 );
}
`;

export default class BloomPass extends Pass {
  constructor(ctx, shared) {
    super('bloom', ctx, shared);
    this.mipCount = 5;
    this.mips = [];
    this.flare = null;

    this.prefilterMat = this.own(
      postMaterial('bloom:prefilter', PREFILTER_FRAG, {
        tSrc: { value: null },
        tExposure: shared.tExposure,
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: 1.05 },
        uKnee: { value: 0.6 },
        uClamp: { value: 48.0 },
      })
    );
    this.downMat = this.own(
      postMaterial('bloom:down', DOWNSAMPLE_FRAG, {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
      })
    );
    this.upMat = this.own(
      postMaterial('bloom:up', UPSAMPLE_FRAG, {
        tSrc: { value: null },
        tDst: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1.0 },
      })
    );
    this.flareMat = this.own(
      postMaterial(
        'bloom:flare',
        FLARE_FRAG,
        {
          tSrc: { value: null },
          uTexel: { value: new THREE.Vector2() },
          uGhostSpacing: { value: 0.32 },
          uHaloWidth: { value: 0.42 },
          // See sampleChroma(): the base dispersion, before the per-ghost ramp and the
          // hard cap. 0.008 put the first ghost alone at 10 px of R/B separation.
          uChroma: { value: 0.0022 },
          uStreak: { value: 0.11 },
        },
        { defines: { GHOSTS: 3 } }
      )
    );

    // Upsample needs to read the destination and write it: ping through a scratch.
    this._scratch = [];
  }

  setQuality(tier) {
    const n = { low: 3, medium: 4, high: 5, ultra: 6 }[tier] ?? 5;
    const q = this.ctx?.settings?.get?.('bloomQuality');
    this.mipCount = Math.max(3, Math.min(6, q || n));
  }

  setSize(w, h) {
    super.setSize(w, h);
    for (const m of this.mips) {
      m.texture.dispose();
      m.dispose();
    }
    for (const m of this._scratch) {
      m.texture.dispose();
      m.dispose();
    }
    this.mips = [];
    this._scratch = [];
    let mw = Math.max(1, w >> 1);
    let mh = Math.max(1, h >> 1);
    for (let i = 0; i < this.mipCount; i++) {
      this.mips.push(makeRT(mw, mh, { name: `bloom.${i}` }));
      this._scratch.push(makeRT(mw, mh, { name: `bloom.s${i}` }));
      mw = Math.max(1, mw >> 1);
      mh = Math.max(1, mh >> 1);
      if (mw === 1 && mh === 1) break;
    }
    this.mipCount = this.mips.length;

    const fw = this.mips[Math.min(2, this.mipCount - 1)].width;
    const fh = this.mips[Math.min(2, this.mipCount - 1)].height;
    this.retarget('flare', makeRT(fw, fh, { name: 'bloom.flare' }));
    this.g.tBloom.value = this.mips[0].texture;
    this.g.tFlare.value = this.flare.texture;
  }

  render(renderer, source) {
    if (!this.mips.length) return null;
    // Bright pass into mip 0.
    this.prefilterMat.uniforms.tSrc.value = source;
    this.prefilterMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    blit(renderer, this.prefilterMat, this.mips[0]);

    // Downsample chain.
    for (let i = 1; i < this.mipCount; i++) {
      const src = this.mips[i - 1];
      this.downMat.uniforms.tSrc.value = src.texture;
      this.downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      blit(renderer, this.downMat, this.mips[i]);
    }

    // Progressive upsample: mip[i] += tent(mip[i+1]).
    for (let i = this.mipCount - 2; i >= 0; i--) {
      const src = this.mips[i + 1];
      this.upMat.uniforms.tSrc.value = src.texture;
      this.upMat.uniforms.tDst.value = this.mips[i].texture;
      this.upMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      blit(renderer, this.upMat, this._scratch[i]);
      // Swap scratch into place so the next iteration reads the accumulated mip.
      const tmp = this.mips[i];
      this.mips[i] = this._scratch[i];
      this._scratch[i] = tmp;
    }

    this.g.tBloom.value = this.mips[0].texture;

    // Flare from a mid mip: bright, already blurred, cheap.
    const fsrc = this.mips[Math.min(2, this.mipCount - 1)];
    this.flareMat.uniforms.tSrc.value = fsrc.texture;
    this.flareMat.uniforms.uTexel.value.set(1 / fsrc.width, 1 / fsrc.height);
    blit(renderer, this.flareMat, this.flare);
    this.g.tFlare.value = this.flare.texture;
    return this.mips[0];
  }

  dispose() {
    for (const m of this.mips) {
      m.texture.dispose();
      m.dispose();
    }
    for (const m of this._scratch) {
      m.texture.dispose();
      m.dispose();
    }
    this.mips = [];
    this._scratch = [];
    super.dispose();
  }
}
