/**
 * HiZPass — hierarchical (min) depth pyramid for SSR empty-space skipping and the
 * DOF auto-focus probe.
 * Owner: render-pipeline agent.
 *
 * Level 0 is a half-resolution min of the scene depth buffer; every level above is the
 * minimum (closest) depth of its 2x2 parent footprint. That is the conservative bound a
 * screen-space ray march needs: if the ray is still in front of a cell's *closest*
 * surface, the whole cell is empty and can be skipped in one step.
 *
 * The pyramid is exposed to shaders as a horizontal **mip atlas** in a single texture
 * (level i occupies a rectangle described by `uHiZRect[i]`), rather than GPU mipmaps.
 * Render targets in three.js only allocate mip 0, and sampling a texture that is
 * simultaneously attached to the bound framebuffer is a feedback loop — the atlas
 * sidesteps both problems with one extra tiny blit per level.
 *
 * Public: `rect(i) -> Vector4(u0, v0, du, dv)`, `levels`, `texture`.
 */
import * as THREE from 'three';
import { Pass, postMaterial, blit } from './Pass.js';

const MAX_LEVELS = 10;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  // 2x2 min of the full-res depth buffer -> half-res level 0.
  float a = texture2D( tDepth, vUv + vec2( -0.5, -0.5 ) * uTexel ).x;
  float b = texture2D( tDepth, vUv + vec2(  0.5, -0.5 ) * uTexel ).x;
  float c = texture2D( tDepth, vUv + vec2( -0.5,  0.5 ) * uTexel ).x;
  float d = texture2D( tDepth, vUv + vec2(  0.5,  0.5 ) * uTexel ).x;
  gl_FragColor = vec4( min( min( a, b ), min( c, d ) ), 0.0, 0.0, 1.0 );
}
`;

const REDUCE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float a = texture2D( tSrc, vUv + vec2( -0.5, -0.5 ) * uTexel ).x;
  float b = texture2D( tSrc, vUv + vec2(  0.5, -0.5 ) * uTexel ).x;
  float c = texture2D( tSrc, vUv + vec2( -0.5,  0.5 ) * uTexel ).x;
  float d = texture2D( tSrc, vUv + vec2(  0.5,  0.5 ) * uTexel ).x;
  gl_FragColor = vec4( min( min( a, b ), min( c, d ) ), 0.0, 0.0, 1.0 );
}
`;

const ATLAS_FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = vec4( texture2D( tSrc, vUv ).x, 0.0, 0.0, 1.0 ); }
`;

function tinyRT(w, h, name) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.name = name;
  return rt;
}

export default class HiZPass extends Pass {
  constructor(ctx, shared) {
    super('hiz', ctx, shared);
    this.levels = 1;
    this.atlas = null;
    this._chain = [];
    this._rects = [];
    for (let i = 0; i < MAX_LEVELS; i++) this._rects.push(new THREE.Vector4(0, 0, 1, 1));

    this.copyMat = this.own(
      postMaterial('hiz:copy', COPY_FRAG, {
        tDepth: shared.tDepth,
        uTexel: { value: new THREE.Vector2() },
      })
    );
    this.reduceMat = this.own(
      postMaterial('hiz:reduce', REDUCE_FRAG, {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
      })
    );
    this.atlasMat = this.own(postMaterial('hiz:atlas', ATLAS_FRAG, { tSrc: { value: null } }));
  }

  setSize(w, h) {
    super.setSize(w, h);
    for (const t of this._chain) {
      t.texture.dispose();
      t.dispose();
    }
    this._chain.length = 0;
    if (this.atlas) {
      this.atlas.texture.dispose();
      this.atlas.dispose();
      this.atlas = null;
    }

    const bw = Math.max(1, w >> 1);
    const bh = Math.max(1, h >> 1);
    this.levels = Math.min(
      MAX_LEVELS,
      Math.max(1, Math.floor(Math.log2(Math.max(bw, bh))) - 1)
    );

    let x = 0;
    const heights = [];
    const widths = [];
    for (let i = 0; i < this.levels; i++) {
      const lw = Math.max(1, bw >> i);
      const lh = Math.max(1, bh >> i);
      widths.push(lw);
      heights.push(lh);
      this._chain.push(tinyRT(lw, lh, `hiZ.${i}`));
    }
    const atlasW = widths.reduce((a, b) => a + b, 0);
    const atlasH = bh;
    this.atlas = tinyRT(atlasW, atlasH, 'hiZ.atlas');

    for (let i = 0; i < this.levels; i++) {
      this._rects[i].set(x / atlasW, 0, widths[i] / atlasW, heights[i] / atlasH);
      x += widths[i];
    }
    for (let i = this.levels; i < MAX_LEVELS; i++) {
      this._rects[i].copy(this._rects[this.levels - 1]);
    }
    this._widths = widths;
    this._heights = heights;
    this._atlasW = atlasW;
    this._atlasH = atlasH;

    this.g.tHiZ.value = this.atlas.texture;
    this.g.uHiZLevels.value = this.levels;
    this.g.uHiZRect.value = this._rects;
  }

  render(renderer) {
    if (!this.atlas) return null;
    // Build the chain.
    this.copyMat.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    blit(renderer, this.copyMat, this._chain[0]);
    for (let i = 1; i < this.levels; i++) {
      this.reduceMat.uniforms.tSrc.value = this._chain[i - 1].texture;
      this.reduceMat.uniforms.uTexel.value.set(
        1 / this._widths[i - 1],
        1 / this._heights[i - 1]
      );
      blit(renderer, this.reduceMat, this._chain[i]);
    }
    // Pack into the atlas.
    const a = this.atlas;
    a.scissorTest = true;
    let x = 0;
    for (let i = 0; i < this.levels; i++) {
      const lw = this._widths[i];
      const lh = this._heights[i];
      a.viewport.set(x, 0, lw, lh);
      a.scissor.set(x, 0, lw, lh);
      this.atlasMat.uniforms.tSrc.value = this._chain[i].texture;
      blit(renderer, this.atlasMat, a);
      x += lw;
    }
    a.scissorTest = false;
    a.viewport.set(0, 0, this._atlasW, this._atlasH);
    a.scissor.set(0, 0, this._atlasW, this._atlasH);
    renderer.setRenderTarget(null);
    return a;
  }

  dispose() {
    for (const t of this._chain) {
      t.texture.dispose();
      t.dispose();
    }
    this._chain.length = 0;
    if (this.atlas) {
      this.atlas.texture.dispose();
      this.atlas.dispose();
      this.atlas = null;
    }
    super.dispose();
  }
}

/** GLSL snippet: requires `uniform sampler2D tHiZ; uniform vec4 uHiZRect[10];` */
export const GLSL_HIZ = /* glsl */ `
float hizFetch( int level, vec2 uv ) {
  vec4 r = uHiZRect[ level ];
  return texture2D( tHiZ, r.xy + clamp( uv, vec2( 0.001 ), vec2( 0.999 ) ) * r.zw ).x;
}
`;
