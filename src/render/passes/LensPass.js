/**
 * LensPass — the physical camera in front of the render: distortion, chromatic
 * aberration, vignette, sensor grain and noise.
 * Owner: render-pipeline agent.
 *
 * Everything here is deliberately near the threshold of perception. An over-aberrated,
 * heavily vignetted frame is the single loudest "hobby renderer" tell, so:
 *   - **Chromatic aberration** is *transverse* only: the offset scales with r^2 from the
 *     optical centre and is zero in the middle third of the frame. R and B shift in
 *     opposite directions along the radius; there is no fixed screen-space offset.
 *     Three samples are taken along the radius so the fringe is a smear, not a ghost.
 *   - **Barrel/pincushion distortion** exists but defaults to 0. When enabled it uses a
 *     Brown-Conrady r^2/r^4 model and rescales so the frame still fills the screen.
 *   - **Vignette** is the natural cos^4 falloff of a real lens plus an optional
 *     mechanical term, not a black ring painted around the border.
 *   - **Film grain** is luminance dependent — heavy in the toe, almost absent in the
 *     highlights, exactly like film and like a real sensor's shot noise — and is
 *     animated per frame. A small independent chroma component is added because sensor
 *     noise is never purely monochrome.
 *   - **Lens dirt** is generated procedurally at init (deterministically, from ctx.rng)
 *     and is consumed by TonemapPass to modulate bloom and flare. It is exposed here
 *     because it belongs to the lens, not to the bloom.
 *
 * Output is sRGB-encoded and ready for the canvas (or FXAA).
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, postMaterial, blit } from './Pass.js';

const LENS_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uResolution;
uniform float uFrame;
uniform float uTime;
uniform float uAberration;
uniform float uDistortion;
uniform float uVignette;
uniform float uVignetteRoundness;
uniform float uGrain;
uniform float uGrainChroma;
uniform float uGrainSize;
varying vec2 vUv;

${GLSL_LIB}

vec2 distort( vec2 uv ) {
  if ( abs( uDistortion ) < 1e-4 ) return uv;
  vec2 c = uv - 0.5;
  float r2 = dot( c, c ) * 4.0;
  float k = 1.0 + uDistortion * r2 + uDistortion * 0.25 * r2 * r2;
  // Renormalise so the corners still land on the corners.
  float kMax = 1.0 + uDistortion + uDistortion * 0.25;
  return 0.5 + c * k / kMax;
}

void main() {
  vec2 uv = distort( vUv );
  vec2 c = uv - 0.5;
  float r2 = dot( c, c ) * 4.0;                 // 0 at centre, ~1 at edge-midpoint
  vec2 radial = c * 2.0;

  // --- transverse chromatic aberration -------------------------------------
  vec3 color;
  float amount = uAberration * smoothstep( 0.12, 1.0, r2 );
  if ( amount > 1e-6 ) {
    vec2 off = radial * amount;
    // Three samples along the radius smears the fringe instead of ghosting it.
    float r = 0.0, g = 0.0, b = 0.0;
    r += texture2D( tColor, clamp( uv + off * 1.00, vec2( 0.0 ), vec2( 1.0 ) ) ).r * 0.5;
    r += texture2D( tColor, clamp( uv + off * 0.66, vec2( 0.0 ), vec2( 1.0 ) ) ).r * 0.5;
    g  = texture2D( tColor, uv ).g;
    b += texture2D( tColor, clamp( uv - off * 1.00, vec2( 0.0 ), vec2( 1.0 ) ) ).b * 0.5;
    b += texture2D( tColor, clamp( uv - off * 0.66, vec2( 0.0 ), vec2( 1.0 ) ) ).b * 0.5;
    color = vec3( r, g, b );
  } else {
    color = texture2D( tColor, uv ).rgb;
  }

  // --- vignette: natural cos^4 plus a touch of mechanical falloff ----------
  vec2 vc = ( uv - 0.5 ) * vec2( mix( uResolution.x / max( uResolution.y, 1.0 ), 1.0, uVignetteRoundness ), 1.0 );
  float rr = length( vc ) * 2.0;
  float cosTheta = inversesqrt( 1.0 + rr * rr * 0.55 );
  float natural = cosTheta * cosTheta * cosTheta * cosTheta;
  float mechanical = 1.0 - smoothstep( 0.78, 1.5, rr ) * 0.35;
  color *= mix( 1.0, natural * mechanical, uVignette );

  // --- grain ---------------------------------------------------------------
  if ( uGrain > 0.0 ) {
    vec2 gp = gl_FragCoord.xy / max( uGrainSize, 0.5 );
    float n  = ignTemporal( gp, uFrame );
    float n2 = ignTemporal( gp + 53.0, uFrame * 1.37 + 11.0 );
    float n3 = ignTemporal( gp + 97.0, uFrame * 0.73 + 29.0 );
    // Centre and shape the noise: box-muller-ish, cheap.
    float lum = luma( color );
    // Film grain lives in the toe. Highlights are almost clean.
    float response = ( 1.0 - lum ) * ( 1.0 - lum ) * 0.85 + 0.15;
    float mono = ( n - 0.5 ) * 2.0;
    vec3 chroma = vec3( n - 0.5, n2 - 0.5, n3 - 0.5 ) * 2.0;
    color += mono * uGrain * response;
    color += chroma * uGrainChroma * response;
  }

  gl_FragColor = vec4( linearToSRGB( clamp( color, 0.0, 1.0 ) ), 1.0 );
}
`;

/** Deterministic, procedurally generated lens dirt / smudge map. */
function makeDirtTexture(rng, size = 256) {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const acc = new Float32Array(n);
  const R = typeof rng === 'function' ? rng : Math.random;

  const put = (cx, cy, radius, strength, aspect) => {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius * aspect));
    const x1 = Math.min(size - 1, Math.ceil(cx + radius * aspect));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(size - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / aspect;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const t = 1 - d2 / r2;
        acc[y * size + x] += strength * t * t;
      }
    }
  };

  // Big soft smudges (fingerprints, breath), tiny specks (dust), a few streaks.
  for (let i = 0; i < 22; i++) {
    put(R() * size, R() * size, 12 + R() * 44, 0.22 + R() * 0.4, 0.7 + R() * 1.6);
  }
  for (let i = 0; i < 420; i++) {
    put(R() * size, R() * size, 0.8 + R() * 3.2, 0.5 + R() * 0.9, 0.6 + R() * 1.2);
  }
  for (let i = 0; i < 9; i++) {
    const cx = R() * size;
    const cy = R() * size;
    const ang = (R() - 0.5) * 0.9;
    const len = 20 + R() * 90;
    const s = 0.16 + R() * 0.25;
    for (let t = 0; t < len; t++) {
      put(cx + Math.cos(ang) * t, cy + Math.sin(ang) * t, 1.6 + R() * 2.4, s * 0.25, 1);
    }
  }

  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, acc[i]);
  const inv = max > 0 ? 1 / max : 0;
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, acc[i] * inv);
    const b = Math.round(v * 255);
    data[i * 4] = b;
    data[i * 4 + 1] = b;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'lens.dirt';
  tex.needsUpdate = true;
  return tex;
}

export default class LensPass extends Pass {
  constructor(ctx, shared) {
    super('lens', ctx, shared);

    this.dirt = makeDirtTexture(ctx?.rng, 256);
    shared.tDirt.value = this.dirt;

    this.settings = {
      aberration: 0.0016,   // fraction of the frame at the corners
      distortion: 0.0,      // Brown-Conrady k1; off by default
      vignette: 0.55,
      vignetteRoundness: 0.65,
      grain: 0.016,
      grainChroma: 0.006,
      grainSize: 1.35,
    };

    this.uniforms = {
      tColor: { value: null },
      uResolution: shared.uResolution,
      uFrame: shared.uFrame,
      uTime: shared.uTime,
      uAberration: { value: this.settings.aberration },
      uDistortion: { value: this.settings.distortion },
      uVignette: { value: this.settings.vignette },
      uVignetteRoundness: { value: this.settings.vignetteRoundness },
      uGrain: { value: this.settings.grain },
      uGrainChroma: { value: this.settings.grainChroma },
      uGrainSize: { value: this.settings.grainSize },
    };
    this.material = this.own(postMaterial('lens', LENS_FRAG, this.uniforms));
  }

  sync(flags) {
    const s = this.settings;
    const u = this.uniforms;
    u.uAberration.value = flags.aberration ? s.aberration : 0;
    u.uDistortion.value = s.distortion;
    u.uVignette.value = s.vignette;
    u.uVignetteRoundness.value = s.vignetteRoundness;
    u.uGrain.value = flags.grain ? s.grain : 0;
    u.uGrainChroma.value = flags.grain ? s.grainChroma : 0;
    u.uGrainSize.value = s.grainSize;
  }

  render(renderer, source, target, flags) {
    this.sync(flags);
    this.uniforms.tColor.value = source;
    blit(renderer, this.material, target);
    return target;
  }

  dispose() {
    this.dirt?.dispose();
    super.dispose();
  }
}
