/**
 * TextureForge — GPU procedural PBR texture generator. Owner: TextureForge agent.
 *
 * There are no art assets in this project: every texture in the game is rendered here,
 * on the GPU, by the shaders in ./shaders/. Nothing is generated on the CPU and nothing
 * is ever read back — a set is three render-target attachments plus a small displacement
 * map, cached by key and handed straight to MeshStandardMaterial.
 *
 * Pipeline per material
 *   1. height pass   -> RGBA16F scratch target (x = height, yzw = recipe scratch)
 *   2. surface pass  -> MRT x3: albedo(sRGB) / tangent normal / ORM(ao,rough,metal)
 *                       normals come from a Sobel of the height target, plus a
 *                       multi-radius occlusion/cavity term used to drive grime
 *   3. displace pass -> half-res greyscale height for parallax/displacement
 *
 * Publishes `ctx.textures`:
 *   pbr(name, opts)      -> PBRSet {map, normalMap, roughnessMap, metalnessMap, aoMap,
 *                                   displacementMap, ormMap, worldSize, depth, surface,
 *                                   setRepeat(u,v), dispose()}
 *   get(name)            -> pbr(name) with defaults (cached)
 *   has(name) / list()   -> catalogue
 *   detailNormal()       -> shared fine micro-detail normal map (tile ~20x)
 *   grungeMask()         -> shared RGBA grunge atlas (fine/blotch/cracks/streaks)
 *   noiseTexture(k,opts) -> generic tileable noise texture
 *   info(name)           -> {worldSize, depth, surface}
 *   selfTest()           -> {generated, ms, names}
 *   stats() / dispose()
 *
 * Events consumed: `quality:changed`, `setting:changed`(textureResolution|anisotropy).
 * Events emitted:  `textures:regenerated` {name, res}.
 *
 * Colour space: the shaders emit *linear* albedo. Attachment 0 is allocated as an sRGB
 * texture where supported, so the hardware encodes on write and decodes on sample —
 * full 8-bit precision in the darks with no double conversion. Normal/ORM/displacement
 * are NoColorSpace.
 */
import * as THREE from 'three';
import {
  FULLSCREEN_VERT,
  MATERIALS,
  MATERIAL_NAMES,
  buildHeightFrag,
  buildSurfaceFrag,
  DISPLACE_FRAG,
  DETAIL_NORMAL_FRAG,
  GRUNGE_FRAG,
  NOISE_FRAG,
} from './shaders/index.js';

const NOISE_KINDS = {
  value: 0,
  gradient: 1,
  perlin: 1,
  simplex: 2,
  simplex3: 3,
  simplexTiled: 4,
  worley: 5,
  cellular: 5,
  worleyF2: 6,
  worleyEdge: 7,
  fbm: 8,
  ridged: 9,
  turbulence: 10,
  warp: 11,
  cracks: 12,
  simplexFbm: 13,
};

const DEFAULT_MATERIAL = 'concrete_cast';

const pow2 = (n) => 1 << Math.max(5, Math.min(12, Math.round(Math.log2(Math.max(8, n)))));

/* ========================================================================== */

class Forge {
  constructor(ctx) {
    this.ctx = ctx;
    this.sets = new Map(); // key -> PBRSet
    this.helpers = new Map(); // key -> THREE.Texture
    this.heightRTs = new Map(); // res -> WebGLRenderTarget
    this.owned = []; // every render target we allocate
    this.materials = []; // every RawShaderMaterial we allocate
    this.dirty = new Set();
    this.gl = null;
    this.ok = false;
    this.srgbAttachment = true;
    this.floatHeight = true;
    this.res = 512;
    this.quality = 1;
    this.aniso = 8;
    this.seed = 1;
    this.bytes = 0;
    this.budget = 512 * 1024 * 1024;
    this.counters = { generated: 0, ms: 0, draws: 0 };
    this._unsub = [];
    this._warned = new Set();
  }

  /* ------------------------------------------------------------ lifecycle */

  init() {
    const ctx = this.ctx;
    this.res = this._targetRes();
    this.quality = this._targetQuality();
    this.aniso = this._targetAniso();
    // Texture memory ceiling. Past it, later materials drop a mip level rather than
    // exhausting VRAM (the software rasteriser in CI pays for this out of system RAM).
    this.budget = (ctx.settings?.get?.('headless') ? 360 : 640) * 1024 * 1024;
    // Deterministic base seed: derived from the engine RNG, never Math.random().
    this.seed = Math.floor((ctx.rng?.() ?? 0.5) * 4096) + 17;

    try {
      this._setupGL();
      this.ok = true;
    } catch (err) {
      this.ok = false;
      this._note('GPU texture generation unavailable, using flat fallbacks', err);
    }

    const bus = ctx.bus;
    if (bus?.on) {
      this._unsub.push(bus.on('quality:changed', () => this._onQuality()));
      this._unsub.push(
        bus.on('setting:changed', ({ key }) => {
          if (key === 'textureResolution' || key === 'anisotropy' || key === 'detailTextures') {
            this._onQuality();
          }
        })
      );
    }

    // Prove the whole path at boot with the two shared helpers plus one material, so a
    // broken shader shows up immediately instead of on first level load.
    if (this.ok) {
      try {
        this.detailNormal();
        this.grungeMask();
        this.pbr(DEFAULT_MATERIAL);
      } catch (err) {
        this._note('warm-up failed', err);
      }
    }
  }

  _setupGL() {
    const renderer = this.ctx.renderer;
    if (!renderer) throw new Error('no renderer');
    this.gl = renderer.getContext();

    const geo = new THREE.BufferGeometry();
    // One oversized triangle: no diagonal seam, no wasted quad rasterisation.
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
    );
    geo.setDrawRange(0, 3);
    this.geo = geo;
    this.blitScene = new THREE.Scene();
    this.blitScene.matrixAutoUpdate = false;
    this.blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(geo, this._makeMaterial(DISPLACE_FRAG, { uHeight: { value: null } }));
    this.quad.frustumCulled = false;
    this.quad.matrixAutoUpdate = false;
    this.blitScene.add(this.quad);

    this.displaceMat = this.quad.material;

    const ext = renderer.extensions;
    this.floatHeight = !!(
      ext?.has?.('EXT_color_buffer_float') || ext?.has?.('EXT_color_buffer_half_float')
    );
    this.srgbAttachment = this._probeSRGBAttachment();
  }

  /** Can we render into an SRGB8_ALPHA8 MRT attachment? SwiftShader can; be sure. */
  _probeSRGBAttachment() {
    const renderer = this.ctx.renderer;
    const gl = this.gl;
    let ok = false;
    let rt = null;
    try {
      rt = new THREE.WebGLRenderTarget(4, 4, {
        count: 3,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      rt.textures[0].colorSpace = THREE.SRGBColorSpace;
      rt.textures[1].colorSpace = THREE.NoColorSpace;
      rt.textures[2].colorSpace = THREE.NoColorSpace;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      renderer.setRenderTarget(prev);
    } catch {
      ok = false;
    }
    try {
      rt?.dispose();
    } catch {
      /* best effort */
    }
    return ok;
  }

  dispose() {
    for (const off of this._unsub) {
      try {
        off?.();
      } catch {
        /* best effort */
      }
    }
    this._unsub.length = 0;
    for (const rt of this.owned) {
      try {
        rt.dispose();
      } catch {
        /* best effort */
      }
    }
    for (const m of this.materials) {
      try {
        m.dispose();
      } catch {
        /* best effort */
      }
    }
    for (const rt of this.heightRTs.values()) {
      try {
        rt.dispose();
      } catch {
        /* best effort */
      }
    }
    try {
      this.geo?.dispose();
    } catch {
      /* best effort */
    }
    this.owned.length = 0;
    this.materials.length = 0;
    this.sets.clear();
    this.helpers.clear();
    this.heightRTs.clear();
    this.dirty.clear();
    this.ok = false;
  }

  /* -------------------------------------------------------------- settings */

  _targetRes() {
    const s = this.ctx.settings;
    const headless = !!s?.get?.('headless');
    // `?texres=N` lets the screenshot harness crank (or cut) generation resolution
    // without touching the quality tier.
    const override = Number(urlParam('texres'));
    if (override > 0) return pow2(override);
    let r = Number(s?.get?.('textureResolution')) || 1024;
    // 1K tiling maps + a 20x detail normal beats a soft 2K map and costs a quarter of
    // the memory. Hero surfaces can still ask for more through opts.res.
    r = Math.min(1024, Math.max(128, r));
    if (headless) r = Math.min(r, 1024);
    return pow2(r);
  }

  _targetQuality() {
    const s = this.ctx.settings;
    if (s?.get?.('headless')) return 0.62;
    const tier = s?.tier || 'high';
    return { low: 0.55, medium: 0.8, high: 1.0, ultra: 1.0 }[tier] ?? 1.0;
  }

  _targetAniso() {
    const s = this.ctx.settings;
    const want = Number(s?.get?.('anisotropy')) || 8;
    const max = Number(this.ctx.maxAnisotropy) || 1;
    return Math.max(1, Math.min(max, want));
  }

  _onQuality() {
    const res = this._targetRes();
    const q = this._targetQuality();
    const aniso = this._targetAniso();
    if (res === this.res && q === this.quality && aniso === this.aniso) return;
    this.res = res;
    this.quality = q;
    this.aniso = aniso;
    // Same Texture objects, new contents — anything already bound to a material keeps
    // working. Regeneration is amortised one set per frame so nothing hitches.
    for (const key of this.sets.keys()) this.dirty.add(key);
    for (const key of this.helpers.keys()) this.dirty.add(`helper:${key}`);
  }

  update() {
    if (!this.ok || this.dirty.size === 0) return;
    const key = this.dirty.values().next().value;
    this.dirty.delete(key);
    try {
      if (key.startsWith('helper:')) this._regenHelper(key.slice(7));
      else this._regenSet(key);
    } catch (err) {
      this._note(`regeneration of ${key} failed`, err);
    }
  }

  /* ----------------------------------------------------------- gl plumbing */

  _makeMaterial(frag, extraUniforms = {}) {
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: frag,
      uniforms: extraUniforms,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      transparent: false,
    });
    this.materials.push(m);
    return m;
  }

  _stdUniforms(res, seed, opts = {}) {
    return {
      uRes: { value: new THREE.Vector2(res, res) },
      uTexel: { value: new THREE.Vector2(1 / res, 1 / res) },
      uSeed: { value: seed },
      uQ: { value: this.quality },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uRoughBias: { value: opts.roughnessBias ?? 0 },
      uMacro: { value: opts.macro ?? 1 },
      uNormalScale: { value: opts.normalScale ?? 0.02 },
      uAO: { value: opts.ao ?? 1 },
      uP0: { value: new THREE.Vector4() },
      uP1: { value: new THREE.Vector4() },
      uHeight: { value: null },
    };
  }

  _draw(material, target) {
    const r = this.ctx.renderer;
    const prevRT = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    this.quad.material = material;
    r.setRenderTarget(target);
    r.render(this.blitScene, this.blitCam);
    r.setRenderTarget(prevRT);
    r.autoClear = prevAutoClear;
    this.counters.draws++;
  }

  _heightRT(res) {
    let rt = this.heightRTs.get(res);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(res, res, {
        format: THREE.RGBAFormat,
        type: this.floatHeight ? THREE.HalfFloatType : THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        generateMipmaps: false,
        depthBuffer: false,
        stencilBuffer: false,
        colorSpace: THREE.NoColorSpace,
      });
      this.heightRTs.set(res, rt);
    }
    return rt;
  }

  _surfaceRT(res) {
    const rt = new THREE.WebGLRenderTarget(res, res, {
      count: 3,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: true,
      anisotropy: this.aniso,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.textures[0].colorSpace = this.srgbAttachment ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    rt.textures[0].name = 'albedo';
    rt.textures[1].colorSpace = THREE.NoColorSpace;
    rt.textures[1].name = 'normal';
    rt.textures[2].colorSpace = THREE.NoColorSpace;
    rt.textures[2].name = 'orm';
    this.owned.push(rt);
    return rt;
  }

  _simpleRT(res, { mips = true, srgb = false } = {}) {
    const rt = new THREE.WebGLRenderTarget(res, res, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: mips,
      anisotropy: this.aniso,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: srgb && this.srgbAttachment ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    });
    this.owned.push(rt);
    return rt;
  }

  /* ----------------------------------------------------------------- pbr() */

  has(name) {
    return Object.prototype.hasOwnProperty.call(MATERIALS, name);
  }

  list() {
    return MATERIAL_NAMES.slice();
  }

  info(name) {
    const m = MATERIALS[name];
    if (!m) return null;
    return { name, worldSize: m.worldSize, depth: m.depth, surface: m.surface };
  }

  _key(name, opts) {
    // Deliberately NOT keyed on the ambient resolution: a quality change resizes the
    // existing render targets in place, so the same key must keep resolving to the
    // same set (otherwise every tier switch orphans the whole cache).
    return [
      name,
      opts.res ? pow2(opts.res) : 'auto',
      opts.seed ?? 'd',
      opts.roughnessBias ?? 0,
      opts.macro ?? 1,
      opts.ao ?? 1,
      opts.tint ? String(opts.tint) : '-',
      opts.variant ?? '',
    ].join('|');
  }

  pbr(name, opts = {}) {
    if (!this.has(name)) {
      this._note(`unknown material "${name}", substituting ${DEFAULT_MATERIAL}`);
      name = DEFAULT_MATERIAL;
    }
    const key = this._key(name, opts);
    const hit = this.sets.get(key);
    if (hit) return hit;
    let set;
    try {
      set = this.ok ? this._buildSet(key, name, opts) : this._fallbackSet(name);
    } catch (err) {
      this._note(`generation of "${name}" failed`, err);
      set = this._fallbackSet(name);
    }
    this.sets.set(key, set);
    return set;
  }

  get(name, opts) {
    return this.pbr(name, opts);
  }

  /** Bytes a set costs: 3 full-res RGBA8 attachments + a half-res displacement, +mips. */
  _setBytes(res) {
    return Math.round((3 * res * res * 4 + (res >> 1) * (res >> 1) * 4) * 1.34);
  }

  _resFor(opts) {
    let res = pow2(opts.res || this.res);
    if (opts.res) return res; // an explicit request is honoured
    while (res > 256 && this.bytes + this._setBytes(res) > this.budget) res >>= 1;
    return res;
  }

  _buildSet(key, name, opts) {
    const t0 = now();
    const def = MATERIALS[name];
    const res = this._resFor(opts);
    const seed = (opts.seed ?? this.seed) + hashName(name);
    const normalScale = (opts.normalScale ?? def.depth) / def.worldSize;

    const uniforms = this._stdUniforms(res, seed, {
      ...opts,
      normalScale,
      ao: opts.ao ?? def.ao ?? 1,
      macro: opts.macro ?? def.macro ?? 1,
    });
    if (opts.tint) uniforms.uTint.value.setRGB(opts.tint[0], opts.tint[1], opts.tint[2]);

    const heightMat = this._makeMaterial(buildHeightFrag(name), uniforms);
    const surfaceMat = this._makeMaterial(buildSurfaceFrag(name), uniforms);

    const surfaceRT = this._surfaceRT(res);
    const dispRT = this._simpleRT(Math.max(64, res >> 1), { mips: true });

    const set = {
      name,
      key,
      res,
      seed,
      surface: def.surface,
      worldSize: def.worldSize,
      depth: def.depth,
      map: surfaceRT.textures[0],
      normalMap: surfaceRT.textures[1],
      ormMap: surfaceRT.textures[2],
      roughnessMap: surfaceRT.textures[2],
      metalnessMap: surfaceRT.textures[2],
      aoMap: surfaceRT.textures[2],
      displacementMap: dispRT.texture,
      displacementScale: def.depth,
      normalScale: new THREE.Vector2(1, 1),
      _rt: surfaceRT,
      _disp: dispRT,
      _height: heightMat,
      _surface: surfaceMat,
      /** Convenience: tile so one repeat covers `worldSize` metres of geometry. */
      setRepeat(u, v = u) {
        for (const t of [set.map, set.normalMap, set.ormMap, set.displacementMap]) {
          if (t) {
            t.repeat.set(u, v);
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
          }
        }
        return set;
      },
      /** Repeat count for a surface `metres` across. */
      repeatFor(metres) {
        return metres / def.worldSize;
      },
      dispose: () => {
        this.sets.delete(key);
        this.bytes = Math.max(0, this.bytes - this._setBytes(set.res));
        try {
          surfaceRT.dispose();
          dispRT.dispose();
        } catch {
          /* best effort */
        }
      },
    };

    this.bytes += this._setBytes(res);
    this._renderSet(set);
    this.counters.generated++;
    this.counters.ms += now() - t0;
    return set;
  }

  _renderSet(set) {
    const heightRT = this._heightRT(set.res);
    set._height.uniforms.uRes.value.set(set.res, set.res);
    set._height.uniforms.uTexel.value.set(1 / set.res, 1 / set.res);
    set._height.uniforms.uQ.value = this.quality;
    set._surface.uniforms.uQ.value = this.quality;
    this._draw(set._height, heightRT);

    set._surface.uniforms.uHeight.value = heightRT.texture;
    this._draw(set._surface, set._rt);

    this.displaceMat.uniforms.uHeight.value = heightRT.texture;
    this._draw(this.displaceMat, set._disp);
  }

  _regenSet(key) {
    const set = this.sets.get(key);
    if (!set) return;
    this.bytes = Math.max(0, this.bytes - this._setBytes(set.res));
    const res = this._resFor({});
    if (res !== set.res) {
      set.res = res;
      set._rt.setSize(res, res);
      set._disp.setSize(Math.max(64, res >> 1), Math.max(64, res >> 1));
      set._height.uniforms.uRes.value.set(res, res);
      set._height.uniforms.uTexel.value.set(1 / res, 1 / res);
      set._surface.uniforms.uRes.value.set(res, res);
      set._surface.uniforms.uTexel.value.set(1 / res, 1 / res);
    }
    this.bytes += this._setBytes(res);
    for (const t of [set.map, set.normalMap, set.ormMap, set.displacementMap]) {
      if (t) t.anisotropy = this.aniso;
    }
    // Force a reallocation so the new anisotropy/size actually reaches the driver.
    set._rt.dispose();
    set._disp.dispose();
    this._renderSet(set);
    this.ctx.bus?.emit?.('textures:regenerated', { name: set.name, res: set.res });
  }

  /* --------------------------------------------------------------- helpers */

  detailNormal(opts = {}) {
    return this._helper('detailNormal', opts, (res, seed) => {
      // ~0.03 puts the steepest micro-facets around 15-20 degrees: clearly readable at
      // grazing angles up close, invisible past a couple of metres.
      const u = this._stdUniforms(res, seed, { normalScale: opts.strength ?? 0.03 });
      const mat = this._makeMaterial(DETAIL_NORMAL_FRAG, u);
      const rt = this._simpleRT(res, { mips: true });
      rt.texture.name = 'detailNormal';
      return { mat, rt };
    });
  }

  grungeMask(opts = {}) {
    return this._helper('grungeMask', opts, (res, seed) => {
      const u = this._stdUniforms(res, seed, {});
      const mat = this._makeMaterial(GRUNGE_FRAG, u);
      const rt = this._simpleRT(res, { mips: true });
      rt.texture.name = 'grungeMask';
      return { mat, rt };
    });
  }

  noiseTexture(kind = 'fbm', opts = {}) {
    const k = NOISE_KINDS[kind] ?? NOISE_KINDS.fbm;
    const scale = opts.scale ?? 8;
    const sx = Array.isArray(scale) ? scale[0] : scale;
    const sy = Array.isArray(scale) ? scale[1] : scale;
    const id = `noise:${kind}:${sx}x${sy}:${opts.octaves ?? 5}:${opts.lacunarity ?? 2}:${
      opts.gain ?? 0.5
    }:${opts.amount ?? 0.1}:${opts.seed ?? 'd'}`;
    return this._helper(
      id,
      opts,
      (res, seed) => {
        const u = this._stdUniforms(res, seed, {});
        u.uKind = { value: k };
        u.uScale = { value: new THREE.Vector2(sx, sy) };
        u.uOct = { value: Math.max(1, Math.min(8, opts.octaves ?? 5)) };
        u.uLac = { value: opts.lacunarity ?? 2.0 };
        u.uGain = { value: opts.gain ?? 0.5 };
        u.uAmt = { value: opts.amount ?? 0.1 };
        const mat = this._makeMaterial(NOISE_FRAG, u);
        const rt = this._simpleRT(res, { mips: opts.mips !== false });
        rt.texture.name = id;
        return { mat, rt };
      },
      opts.res || 0
    );
  }

  _helper(id, opts, build, resOverride) {
    const existing = this.helpers.get(id);
    if (existing) return existing;
    if (!this.ok) {
      const tex = this._fallbackTexture(id.startsWith('detail') ? 'normal' : 'grey');
      this.helpers.set(id, tex);
      return tex;
    }
    const explicit = resOverride || opts.res || 0;
    const res = pow2(explicit || Math.min(512, this.res));
    const seed = (opts.seed ?? this.seed) + hashName(id);
    try {
      const { mat, rt } = build(res, seed);
      this._draw(mat, rt);
      rt.texture.userData.forge = { id, mat, rt, res, seed, build, explicit };
      this.helpers.set(id, rt.texture);
      this.counters.generated++;
      return rt.texture;
    } catch (err) {
      this._note(`helper "${id}" failed`, err);
      const tex = this._fallbackTexture('grey');
      this.helpers.set(id, tex);
      return tex;
    }
  }

  _regenHelper(id) {
    const tex = this.helpers.get(id);
    const meta = tex?.userData?.forge;
    if (!meta) return;
    const res = pow2(meta.explicit || Math.min(512, this.res));
    if (res !== meta.res) {
      meta.res = res;
      meta.rt.setSize(res, res);
      meta.mat.uniforms.uRes?.value?.set(res, res);
      meta.mat.uniforms.uTexel?.value?.set(1 / res, 1 / res);
    }
    if (meta.mat.uniforms.uQ) meta.mat.uniforms.uQ.value = this.quality;
    tex.anisotropy = this.aniso;
    meta.rt.dispose();
    this._draw(meta.mat, meta.rt);
  }

  /* -------------------------------------------------------------- fallback */

  /**
   * Emergency path only (no WebGL2 / shader failure). Still deterministic and still
   * varied — a flat colour would be worse than useless.
   */
  _fallbackTexture(kind) {
    const n = 64;
    const data = new Uint8Array(n * n * 4);
    const rng = this.ctx.rng || (() => 0.5);
    const grid = new Float32Array(n * n);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();
    const smooth = (x, y) => {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          s += grid[(((y + dy + n) % n) * n + ((x + dx + n) % n))];
        }
      }
      return s / 9;
    };
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 4;
        const v = smooth(x, y);
        if (kind === 'normal') {
          data[i] = 128;
          data[i + 1] = 128;
          data[i + 2] = 255;
          data[i + 3] = 255;
        } else {
          const c = Math.round(110 + v * 60);
          data[i] = c;
          data[i + 1] = c;
          data[i + 2] = Math.round(c * 0.97);
          data[i + 3] = 255;
        }
      }
    }
    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.aniso;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  _fallbackSet(name) {
    const def = MATERIALS[name] || MATERIALS[DEFAULT_MATERIAL];
    const albedo = this._fallbackTexture('grey');
    albedo.colorSpace = THREE.SRGBColorSpace;
    const normal = this._fallbackTexture('normal');
    const orm = this._fallbackTexture('grey');
    const set = {
      name,
      key: `fallback:${name}`,
      res: 64,
      seed: 0,
      surface: def.surface,
      worldSize: def.worldSize,
      depth: def.depth,
      map: albedo,
      normalMap: normal,
      ormMap: orm,
      roughnessMap: orm,
      metalnessMap: orm,
      aoMap: orm,
      displacementMap: orm,
      displacementScale: def.depth,
      normalScale: new THREE.Vector2(1, 1),
      fallback: true,
      setRepeat(u, v = u) {
        for (const t of [albedo, normal, orm]) t.repeat.set(u, v);
        return set;
      },
      repeatFor(metres) {
        return metres / def.worldSize;
      },
      dispose() {
        albedo.dispose();
        normal.dispose();
        orm.dispose();
      },
    };
    return set;
  }

  /* ------------------------------------------------------------ diagnostics */

  selfTest(opts = {}) {
    const t0 = now();
    const names = [];
    const only = Array.isArray(opts.only) ? opts.only : MATERIAL_NAMES;
    for (const n of only) {
      try {
        const set = this.pbr(n, opts.setOpts || {});
        if (set) names.push(n);
      } catch (err) {
        this._note(`selfTest: ${n} failed`, err);
      }
    }
    try {
      this.detailNormal();
      this.grungeMask();
      this.noiseTexture('fbm', { scale: 8 });
    } catch {
      /* already reported */
    }
    return { generated: names.length, ms: Math.round(now() - t0), names };
  }

  stats() {
    return {
      ok: this.ok,
      res: this.res,
      quality: this.quality,
      anisotropy: this.aniso,
      sets: this.sets.size,
      helpers: this.helpers.size,
      draws: this.counters.draws,
      generated: this.counters.generated,
      ms: Math.round(this.counters.ms),
      srgbAttachment: this.srgbAttachment,
      floatHeight: this.floatHeight,
    };
  }

  _note(msg, err) {
    if (this._warned.has(msg)) return;
    this._warned.add(msg);
    // Warnings only: a texture problem must never fail the boot smoke test, and the
    // engine keeps rendering with the fallback set either way.
    if (!this.ctx.settings?.get?.('headless') || err) {
      console.warn(`[textures] ${msg}`, err || '');
    }
  }
}

/* ------------------------------------------------------------------ utils */

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function urlParam(name) {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get(name);
  } catch {
    return null;
  }
}

/** Stable per-name seed offset so two materials never share a noise field. */
function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 4096) * 0.25;
}

/* ================================================================== system */

/** @returns {import('../core/types.js').System} */
export default function createTextureForge(ctx) {
  const forge = new Forge(ctx);

  const api = {
    ready: false,
    pbr: (name, opts) => forge.pbr(name, opts),
    get: (name, opts) => forge.pbr(name, opts),
    has: (name) => forge.has(name),
    list: () => forge.list(),
    info: (name) => forge.info(name),
    surfaceOf: (name) => forge.info(name)?.surface ?? 'concrete',
    detailNormal: (opts) => forge.detailNormal(opts),
    /** Suggested repeat for detailNormal() relative to the base map's repeat. */
    detailTiling: 20,
    grungeMask: (opts) => forge.grungeMask(opts),
    noiseTexture: (kind, opts) => forge.noiseTexture(kind, opts),
    selfTest: (opts) => forge.selfTest(opts),
    stats: () => forge.stats(),
    dispose: () => forge.dispose(),
    get resolution() {
      return forge.res;
    },
    get names() {
      return forge.list();
    },
    forge,
  };

  // Publish immediately so any factory that captures ctx.textures sees the real API.
  ctx.textures = api;

  return {
    name: 'textures',
    order: 10,
    async init() {
      try {
        forge.init();
      } catch (err) {
        console.warn('[textures] init failed, running with fallbacks', err);
      }
      api.ready = forge.ok;
      ctx.textures = api;
    },
    update() {
      forge.update();
    },
    dispose() {
      forge.dispose();
      api.ready = false;
    },
  };
}
