/**
 * MotionBlurPass — per-pixel reconstruction motion blur (McGuire et al. 2012).
 * Owner: render-pipeline agent.
 *
 * Three stages, which is what makes it look like a camera shutter rather than a
 * directional smudge:
 *   1. **TileMax** — reduce the velocity buffer to the maximum velocity in each
 *      K x K tile (K = 20 px at 1080p).
 *   2. **NeighbourMax** — take the maximum over the 3x3 tile neighbourhood, so a fast
 *      object correctly blurs *outside* its own silhouette and does not leave a hard
 *      edge where its motion vector stops.
 *   3. **Reconstruction** — for every pixel, walk the dominant tile velocity with
 *      jittered sample positions, and weight each tap by whether the sample can
 *      plausibly blur onto this pixel (foreground/background classification against the
 *      depth buffer). That is what prevents the background smearing over a static
 *      foreground.
 *
 * Shutter is 180 degrees by default (exposure = 0.5 * frame time), the film standard;
 * velocity is scaled to the actual frame time so blur length is frame-rate independent.
 * Viewmodel pixels are excluded — the weapon is locked to the camera, so it must stay
 * sharp while the world streaks past it.
 */
import * as THREE from 'three';
import { Pass, GLSL_LIB, GLSL_DEPTH, GLSL_DEPTH_VIEW, postMaterial, blit, makeRT } from './Pass.js';

// Separable tile-max: TILE taps per pass instead of TILE^2, same result.
const TILE_MAX_FRAG = /* glsl */ `
uniform sampler2D tVelocity;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uTileSize;
varying vec2 vUv;
void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = -1.0;
  for ( int i = 0; i < TILE; i ++ ) {
    float f = float( i ) - uTileSize * 0.5 + 0.5;
    vec2 uv = vUv + uDirection * f * uTexel;
    vec2 v = texture2D( tVelocity, uv ).xy;
    float l = dot( v, v );
    if ( l > bestLen ) { bestLen = l; best = v; }
  }
  gl_FragColor = vec4( best, 0.0, 1.0 );
}
`;

const NEIGHBOUR_MAX_FRAG = /* glsl */ `
uniform sampler2D tTiles;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = 0.0;
  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 v = texture2D( tTiles, vUv + vec2( float( x ), float( y ) ) * uTexel ).xy;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4( best, 0.0, 1.0 );
}
`;

const RECONSTRUCT_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tVelocity;
uniform sampler2D tNeighbourMax;
uniform sampler2D tDepth;
uniform sampler2D tDepthView;
uniform vec4 uCam;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform float uFrame;
uniform float uIntensity;
uniform float uMaxBlurPx;
varying vec2 vUv;
${GLSL_LIB}
${GLSL_DEPTH}
${GLSL_DEPTH_VIEW}

float cone( float dist, float len )      { return saturate1( 1.0 - dist / max( len, 1e-4 ) ); }
float cylinder( float dist, float len )  { return 1.0 - smoothstep( 0.95 * len, 1.05 * len, dist ); }
float softDepthCompare( float za, float zb ) { return saturate1( 1.0 - ( za - zb ) / 0.6 ); }

void main() {
  vec3 centerColor = texture2D( tColor, vUv ).rgb;

  vec2 nmax = texture2D( tNeighbourMax, vUv ).xy * uResolution * uIntensity;
  float nmaxLen = length( nmax );
  if ( nmaxLen < 1.0 ) { gl_FragColor = vec4( centerColor, 1.0 ); return; }
  if ( nmaxLen > uMaxBlurPx ) nmax *= uMaxBlurPx / nmaxLen;
  nmaxLen = min( nmaxLen, uMaxBlurPx );

  float vmCenter = viewmodelMask( vUv );
  vec2 vCenter = texture2D( tVelocity, vUv ).xy * uResolution * uIntensity * ( 1.0 - vmCenter );
  float vCenterLen = max( length( vCenter ), 0.5 );
  float zCenter = sceneDepthLinear( vUv );

  float jitter = ignTemporal( gl_FragCoord.xy, uFrame ) - 0.5;

  vec3 sum = centerColor * ( 1.0 / max( vCenterLen, 1.0 ) );
  float wsum = 1.0 / max( vCenterLen, 1.0 );

  vec2 wn = nmax / max( nmaxLen, 1e-4 );
  vec2 wp = vec2( -wn.y, wn.x );
  if ( dot( wp, vCenter ) < 0.0 ) wp = -wp;
  vec2 wc = normalize( mix( wp, vCenter / max( vCenterLen, 1e-4 ), ( vCenterLen - 0.5 ) / 1.5 ) );

  for ( int i = 0; i < SAMPLES; i ++ ) {
    float t = mix( -1.0, 1.0, ( float( i ) + jitter + 1.0 ) / ( float( SAMPLES ) + 1.0 ) );
    // Alternate between the tile-dominant direction and this pixel's own direction,
    // which is what reconstructs a plausible shutter integral at silhouettes.
    bool even = mod( float( i ), 2.0 ) < 0.5;
    vec2 dir = even ? wc : wn;
    float dirLen = even ? vCenterLen : nmaxLen;
    vec2 offsetPx = dir * t * dirLen * 0.5;
    vec2 uv = vUv + offsetPx * uTexel;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;

    float zSample = sceneDepthLinear( uv );
    float vmS = viewmodelMask( uv );
    vec2 vSample = texture2D( tVelocity, uv ).xy * uResolution * uIntensity * ( 1.0 - vmS );
    float vSampleLen = max( length( vSample ), 0.5 );

    float dist = length( offsetPx );
    float fg = softDepthCompare( zCenter, zSample );  // sample is in front
    float bg = softDepthCompare( zSample, zCenter );  // sample is behind

    float weight =
      fg * cone( dist, vSampleLen ) +
      bg * cone( dist, vCenterLen ) +
      cylinder( dist, vSampleLen ) * cylinder( dist, vCenterLen ) * 2.0;

    // The viewmodel never blurs and never gets blurred over.
    weight *= ( 1.0 - vmCenter ) * ( 1.0 - vmS ) + vmCenter * vmS;

    sum += texture2D( tColor, uv ).rgb * weight;
    wsum += weight;
  }

  vec3 result = sum / max( wsum, 1e-4 );
  gl_FragColor = vec4( mix( centerColor, result, 1.0 - vmCenter ), 1.0 );
}
`;

export default class MotionBlurPass extends Pass {
  constructor(ctx, shared) {
    super('motionBlur', ctx, shared);
    this.tileSize = 20;
    this.shutter = 0.5; // 180-degree shutter

    this.tileMat = this.own(
      postMaterial(
        'mblur:tilemax',
        TILE_MAX_FRAG,
        {
          // NOTE: private uniform, not the shared one — this pass rebinds it per draw.
          tVelocity: { value: null },
          uTexel: { value: new THREE.Vector2() },
          uDirection: { value: new THREE.Vector2(1, 0) },
          uTileSize: { value: 20 },
        },
        { defines: { TILE: 20 } }
      )
    );
    this.neighbourMat = this.own(
      postMaterial('mblur:nmax', NEIGHBOUR_MAX_FRAG, {
        tTiles: { value: null },
        uTexel: { value: new THREE.Vector2() },
      })
    );
    this.reconstructMat = this.own(
      postMaterial(
        'mblur:reconstruct',
        RECONSTRUCT_FRAG,
        {
          tColor: { value: null },
          tVelocity: shared.tVelocity,
          tNeighbourMax: { value: null },
          tDepth: shared.tDepth,
          tDepthView: shared.tDepthView,
          uCam: shared.uCam,
          uResolution: shared.uResolution,
          uTexel: { value: new THREE.Vector2() },
          uFrame: shared.uFrame,
          uIntensity: { value: 0.5 },
          uMaxBlurPx: { value: 48 },
        },
        { defines: { SAMPLES: 12 } }
      )
    );
  }

  setQuality(tier, headless) {
    const s = { low: 6, medium: 8, high: 12, ultra: 16 }[tier] ?? 12;
    const n = headless ? Math.min(s, 10) : s;
    if (this.reconstructMat.defines.SAMPLES !== n) {
      this.reconstructMat.defines.SAMPLES = n;
      this.reconstructMat.needsUpdate = true;
    }
  }

  setSize(w, h) {
    super.setSize(w, h);
    const tile = Math.max(8, Math.min(24, Math.round((this.tileSize * h) / 1080) || 8));
    if (this.tileMat.defines.TILE !== tile) {
      this.tileMat.defines.TILE = tile;
      this.tileMat.needsUpdate = true;
    }
    this._tile = tile;
    this.tileMat.uniforms.uTileSize.value = tile;
    this.tileMat.uniforms.uTexel.value.set(1 / w, 1 / h);

    const tw = Math.max(1, Math.ceil(w / tile));
    const th = Math.max(1, Math.ceil(h / tile));
    this.retarget('tilesX', makeRT(tw, h, { name: 'mblur.tilesX', filter: THREE.NearestFilter }));
    this.retarget('tiles', makeRT(tw, th, { name: 'mblur.tiles', filter: THREE.NearestFilter }));
    this.retarget('nmax', makeRT(tw, th, { name: 'mblur.nmax', filter: THREE.NearestFilter }));
    this.neighbourMat.uniforms.uTexel.value.set(1 / tw, 1 / th);
    this.reconstructMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.reconstructMat.uniforms.uMaxBlurPx.value = Math.max(16, h * 0.06);
  }

  /** @param {number} dt @param {number} targetDt reference frame time (1/60) */
  render(renderer, source, target, dt) {
    if (!this.tiles) return null;
    // Velocity was measured over `dt`; scale to a 180-degree shutter at 60 Hz so the
    // streak length matches a real camera regardless of the actual frame rate.
    const scale = this.shutter * Math.min(Math.max((1 / 60) / Math.max(dt, 1e-4), 0.15), 4.0);
    this.reconstructMat.uniforms.uIntensity.value = scale;

    // Horizontal then vertical tile-max.
    this.tileMat.uniforms.tVelocity.value = this.g.tVelocity.value;
    this.tileMat.uniforms.uDirection.value.set(1, 0);
    this.tileMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    blit(renderer, this.tileMat, this.tilesX);

    this.tileMat.uniforms.tVelocity.value = this.tilesX.texture;
    this.tileMat.uniforms.uDirection.value.set(0, 1);
    this.tileMat.uniforms.uTexel.value.set(1 / this.tilesX.width, 1 / this.height);
    blit(renderer, this.tileMat, this.tiles);

    this.neighbourMat.uniforms.tTiles.value = this.tiles.texture;
    blit(renderer, this.neighbourMat, this.nmax);

    this.reconstructMat.uniforms.tColor.value = source;
    this.reconstructMat.uniforms.tNeighbourMax.value = this.nmax.texture;
    blit(renderer, this.reconstructMat, target);
    return target;
  }
}
