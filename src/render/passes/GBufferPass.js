/**
 * GBufferPass — a *thin* material buffer for the passes that need surface
 * parameters: R = unused/mask, G = roughness, B = metalness, A = 1.
 * Owner: render-pipeline agent.
 *
 * Deliberately built from stock `MeshBasicMaterial`s rather than a custom shader:
 * `color = (1, roughness, metalness)` multiplied by the material's ORM texture gives
 * exactly the PBR product three.js itself computes (`roughness * roughnessMap.g`,
 * `metalness * metalnessMap.b`). That means instancing, skinning, morph targets,
 * alpha test and vertex colours all keep working with zero shader risk, and no other
 * agent's material is ever modified — we swap `mesh.material` for the duration of the
 * pass and put it straight back.
 *
 * View-space normals are NOT stored here: they are reconstructed from the depth buffer
 * (see `normalFromDepth` in Pass.js), which costs nothing extra and gives the geometric
 * normal AO and SSR actually want.
 *
 * Also provides the material-swap machinery used by the albedo/roughness/metalness
 * debug views.
 */
import * as THREE from 'three';
import { Pass } from './Pass.js';

const WHITE = new THREE.Color(1, 1, 1);

export default class GBufferPass extends Pass {
  constructor(ctx, shared) {
    super('gbuffer', ctx, shared);
    this.target = null;
    this._cache = new WeakMap(); // sourceMaterial -> { orm, albedo }
    this._saved = [];
    this._hidden = [];
    this.scale = 0.5;
  }

  setSize(w, h) {
    super.setSize(w, h);
    const s = this.scale;
    this.retarget(
      'target',
      new THREE.WebGLRenderTarget(
        Math.max(1, Math.round(w * s)),
        Math.max(1, Math.round(h * s)),
        {
          type: THREE.UnsignedByteType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: true,
          stencilBuffer: false,
          generateMipmaps: false,
          colorSpace: THREE.NoColorSpace,
        }
      )
    );
    this.target.texture.name = 'gbuffer.ORM';
    this.g.tGBuffer.value = this.target.texture;
  }

  /** Derive (and cache) the stand-in materials for one source material. */
  _derive(src) {
    let e = this._cache.get(src);
    if (e) return e;
    const common = {
      side: src.side ?? THREE.FrontSide,
      alphaTest: src.alphaTest || 0,
      transparent: false,
      depthWrite: src.depthWrite !== false,
      depthTest: true,
      vertexColors: false,
    };
    const rough = src.roughness !== undefined ? src.roughness : 0.85;
    const metal = src.metalness !== undefined ? src.metalness : 0.0;
    const ormMap = src.roughnessMap || src.metalnessMap || null;

    const orm = new THREE.MeshBasicMaterial({
      ...common,
      color: new THREE.Color(1.0, rough, metal),
      map: ormMap,
      alphaMap: src.alphaMap || null,
    });
    orm.toneMapped = false;

    const albedo = new THREE.MeshBasicMaterial({
      ...common,
      color: src.color ? src.color.clone() : WHITE.clone(),
      map: src.map || null,
      alphaMap: src.alphaMap || null,
    });
    albedo.toneMapped = false;

    e = { orm, albedo };
    this._cache.set(src, e);
    return e;
  }

  /** Swap every mesh material in `scene` for its `kind` stand-in. */
  swapIn(scene, kind) {
    this._saved.length = 0;
    this._hidden.length = 0;
    scene.traverseVisible((o) => {
      if (o.isPoints || o.isLine || o.isSprite) {
        // No meaningful surface parameters — keep them out of the buffer.
        o.visible = false;
        this._hidden.push(o);
        return;
      }
      if (!o.isMesh) return;
      const m = o.material;
      if (!m) return;
      this._saved.push(o, m);
      if (Array.isArray(m)) {
        o.material = m.map((sub) => (sub ? this._derive(sub)[kind] : sub));
      } else {
        o.material = this._derive(m)[kind];
      }
    });
  }

  swapOut() {
    for (let i = this._saved.length - 2; i >= 0; i -= 2) {
      this._saved[i].material = this._saved[i + 1];
    }
    this._saved.length = 0;
    for (const o of this._hidden) o.visible = true;
    this._hidden.length = 0;
  }

  /**
   * Render the ORM buffer. Safe to skip entirely: consumers fall back to
   * `uDefaultRoughness` when `g.tGBuffer.value` is null.
   */
  render(renderer, scene, camera, kind = 'orm') {
    if (!this.target) return null;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    // A scene background would clear this buffer to the sky colour and show up as
    // bogus roughness/metalness on every sky pixel.
    const bg = scene.background;
    scene.background = null;
    this.swapIn(scene, kind);
    try {
      renderer.render(scene, camera);
    } finally {
      this.swapOut();
      scene.background = bg;
    }
    return this.target;
  }

  dispose() {
    this.swapOut();
    super.dispose();
  }
}
