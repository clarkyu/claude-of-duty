/**
 * FXAAPass — FXAA 3.11 quality preset, used whenever TAA is off.
 * Owner: render-pipeline agent.
 *
 * Operates on the sRGB-encoded output of LensPass (FXAA is a perceptual-space filter;
 * running it on linear HDR produces the wrong edge weights). Luma is taken from the
 * green channel, the standard fast approximation.
 */
import * as THREE from 'three';
import { Pass, postMaterial, blit } from './Pass.js';

const FXAA_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uSubpix;
uniform float uEdgeThreshold;
uniform float uEdgeThresholdMin;
varying vec2 vUv;

#define FXAA_SEARCH_STEPS 12

float fxaaLuma( vec3 c ) { return c.g * ( 0.587 / 0.299 ) + c.r; }

void main() {
  vec2 t = uTexel;
  vec3 rgbM = texture2D( tColor, vUv ).rgb;

  float lumaM  = fxaaLuma( rgbM );
  float lumaN  = fxaaLuma( texture2D( tColor, vUv + vec2( 0.0, -t.y ) ).rgb );
  float lumaS  = fxaaLuma( texture2D( tColor, vUv + vec2( 0.0,  t.y ) ).rgb );
  float lumaW  = fxaaLuma( texture2D( tColor, vUv + vec2( -t.x, 0.0 ) ).rgb );
  float lumaE  = fxaaLuma( texture2D( tColor, vUv + vec2(  t.x, 0.0 ) ).rgb );

  float rangeMin = min( lumaM, min( min( lumaN, lumaS ), min( lumaW, lumaE ) ) );
  float rangeMax = max( lumaM, max( max( lumaN, lumaS ), max( lumaW, lumaE ) ) );
  float range = rangeMax - rangeMin;

  if ( range < max( uEdgeThresholdMin, rangeMax * uEdgeThreshold ) ) {
    gl_FragColor = vec4( rgbM, 1.0 );
    return;
  }

  float lumaNW = fxaaLuma( texture2D( tColor, vUv + vec2( -t.x, -t.y ) ).rgb );
  float lumaNE = fxaaLuma( texture2D( tColor, vUv + vec2(  t.x, -t.y ) ).rgb );
  float lumaSW = fxaaLuma( texture2D( tColor, vUv + vec2( -t.x,  t.y ) ).rgb );
  float lumaSE = fxaaLuma( texture2D( tColor, vUv + vec2(  t.x,  t.y ) ).rgb );

  float edgeHorz = abs( lumaNW + lumaNE - 2.0 * lumaN ) * 2.0 +
                   abs( lumaW  + lumaE  - 2.0 * lumaM ) * 4.0 +
                   abs( lumaSW + lumaSE - 2.0 * lumaS ) * 2.0;
  float edgeVert = abs( lumaNW + lumaSW - 2.0 * lumaW ) * 2.0 +
                   abs( lumaN  + lumaS  - 2.0 * lumaM ) * 4.0 +
                   abs( lumaNE + lumaSE - 2.0 * lumaE ) * 2.0;
  bool horzSpan = edgeHorz >= edgeVert;

  float luma1 = horzSpan ? lumaN : lumaW;
  float luma2 = horzSpan ? lumaS : lumaE;
  float grad1 = abs( luma1 - lumaM );
  float grad2 = abs( luma2 - lumaM );
  bool pair1 = grad1 >= grad2;

  float lengthSign = horzSpan ? -t.y : -t.x;
  if ( !pair1 ) lengthSign = -lengthSign;

  float lumaLocal = 0.5 * ( ( pair1 ? luma1 : luma2 ) + lumaM );
  float gradScaled = 0.25 * max( grad1, grad2 );

  vec2 posB = vUv;
  if ( horzSpan ) posB.y += lengthSign * 0.5; else posB.x += lengthSign * 0.5;

  vec2 offNP = horzSpan ? vec2( t.x, 0.0 ) : vec2( 0.0, t.y );
  vec2 posN = posB - offNP;
  vec2 posP = posB + offNP;

  float lumaEndN = fxaaLuma( texture2D( tColor, posN ).rgb ) - lumaLocal;
  float lumaEndP = fxaaLuma( texture2D( tColor, posP ).rgb ) - lumaLocal;
  bool doneN = abs( lumaEndN ) >= gradScaled;
  bool doneP = abs( lumaEndP ) >= gradScaled;

  for ( int i = 0; i < FXAA_SEARCH_STEPS; i ++ ) {
    if ( doneN && doneP ) break;
    if ( !doneN ) {
      posN -= offNP;
      lumaEndN = fxaaLuma( texture2D( tColor, posN ).rgb ) - lumaLocal;
      doneN = abs( lumaEndN ) >= gradScaled;
    }
    if ( !doneP ) {
      posP += offNP;
      lumaEndP = fxaaLuma( texture2D( tColor, posP ).rgb ) - lumaLocal;
      doneP = abs( lumaEndP ) >= gradScaled;
    }
  }

  float dstN = horzSpan ? vUv.x - posN.x : vUv.y - posN.y;
  float dstP = horzSpan ? posP.x - vUv.x : posP.y - vUv.y;
  bool directionN = dstN < dstP;
  float dst = min( dstN, dstP );
  float spanLength = dstP + dstN;

  float lumaEnd = directionN ? lumaEndN : lumaEndP;
  bool goodSpan = ( ( lumaM - lumaLocal ) < 0.0 ) != ( lumaEnd < 0.0 );
  float pixelOffset = max( 0.0, ( 0.5 - dst / max( spanLength, 1e-5 ) ) );
  if ( !goodSpan ) pixelOffset = 0.0;

  // Sub-pixel aliasing: low-pass the 3x3 and blend by local contrast.
  float lumaAvg = ( 2.0 * ( lumaN + lumaS + lumaW + lumaE ) +
                    lumaNW + lumaNE + lumaSW + lumaSE ) * ( 1.0 / 12.0 );
  float subpixOffset = clamp( abs( lumaAvg - lumaM ) / max( range, 1e-5 ), 0.0, 1.0 );
  subpixOffset = ( -2.0 * subpixOffset + 3.0 ) * subpixOffset * subpixOffset;
  subpixOffset = subpixOffset * subpixOffset * uSubpix;

  float finalOffset = max( pixelOffset, subpixOffset );

  vec2 uvFinal = vUv;
  if ( horzSpan ) uvFinal.y += finalOffset * lengthSign;
  else uvFinal.x += finalOffset * lengthSign;

  gl_FragColor = vec4( texture2D( tColor, uvFinal ).rgb, 1.0 );
}
`;

export default class FXAAPass extends Pass {
  constructor(ctx, shared) {
    super('fxaa', ctx, shared);
    this.uniforms = {
      tColor: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uSubpix: { value: 0.7 },
      uEdgeThreshold: { value: 0.166 },
      uEdgeThresholdMin: { value: 0.0625 },
    };
    this.material = this.own(postMaterial('fxaa', FXAA_FRAG, this.uniforms));
  }

  setSize(w, h) {
    super.setSize(w, h);
    this.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  render(renderer, source, target) {
    this.uniforms.tColor.value = source;
    blit(renderer, this.material, target);
    return target;
  }
}
