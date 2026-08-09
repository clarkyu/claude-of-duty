/**
 * props/materials.js — the prop material palette. Owner: props agent.
 *
 * Every prop material is resolved through `ctx.materials`, never built by hand: that is
 * what gets the forge's PBR set, the parallax/detail/tile-break extension, the shared
 * wetness/dust/wind globals and the aerial-perspective hookup for free.
 *
 * The keys below are the *only* strings a prop generator may pass as a material. Keeping
 * the list short is a draw-call decision: a merged district costs one call per material
 * it actually uses, so the whole prop budget is (keys used) x (districts). Several keys
 * alias onto one material — see MAT_ALIAS below.
 *
 * Every entry opts into `vertexColors` because props author the MaterialLibrary vertex
 * MASK rather than a tint: r = grime, b = water pooling, and g — which props never use
 * for the library's layer blend — is repurposed as the cloth flap mask that
 * `_animateCloth()` below turns into wind motion. See props/geom.js.
 */
import * as THREE from 'three';
import { chainLinkAlpha } from './geom.js';
import { signageAtlas, disposeSignageAtlas } from './signageTexture.js';

/**
 * key -> { base, opts, surface? , tint?, rough? }
 *   base    a MaterialLibrary recipe name
 *   opts    passed straight to materials.get()
 *   tint    when set, the material is clone()d and recoloured (own draw call)
 *   rough   [min,max] override poked into uCodRough (car paint, plastics)
 */
export const PROP_MATS = {
  /* ── masonry ─────────────────────────────────────────────────────────── */
  concrete: { base: 'concrete_cast', opts: { repeat: 1.5, grime: 1.3, grimeColor: 0x38332a } },
  paving: { base: 'sidewalk_paving', opts: { repeat: 1.3, grime: 1.2 } },

  /* ── metal ───────────────────────────────────────────────────────────── */
  steel: { base: 'painted_steel_chipped', opts: { repeat: 2.4, grime: 1.15 } },
  rust: { base: 'rusted_steel', opts: { repeat: 2.2, grime: 1.35, grimeColor: 0x35241a } },
  galv: { base: 'galvanised_metal', opts: { repeat: 2.6, grime: 1.1 } },
  alu: { base: 'brushed_aluminium', opts: { repeat: 3.0, grime: 0.8 } },

  /* ── timber ──────────────────────────────────────────────────────────── */
  wood: { base: 'wood_plank_weathered', opts: { repeat: 1.9, grime: 1.25 } },
  ply: { base: 'wood_ply', opts: { repeat: 2.1, grime: 1.1 } },
  paintwood: { base: 'plywood_painted', opts: { repeat: 2.1, grime: 1.2 } },
  /** flattened corrugated card — a tinted ply so it costs no new shader */
  card: { base: 'wood_ply', tint: 0xa9855c, opts: { repeat: 2.6, grime: 1.4 }, rough: [0.62, 1.0] },

  /* ── soft ────────────────────────────────────────────────────────────── */
  sacking: { base: 'sandbag', opts: { repeat: 1.7, grime: 1.2 } },
  canvas: { base: 'fabric_canvas', opts: { repeat: 1.4, side: 'double', grime: 1.15 } },
  tarp: { base: 'tarp', opts: { repeat: 1.2, side: 'double', grime: 1.2 } },
  tyre: { base: 'rubber_tyre', opts: { repeat: 3.0, grime: 1.25 } },

  /* ── glazing ─────────────────────────────────────────────────────────── */
  glass: { base: 'glass_dirty', opts: { repeat: 1.0 }, noVCol: true },

  /* ── vehicles: each body colour is its own clone, but there are only a few ─ */
  carRed: { base: 'painted_steel_chipped', tint: 0x7d2b22, opts: { repeat: 3.2, grime: 1.0 }, rough: [0.1, 0.55] },
  carWhite: { base: 'painted_steel_chipped', tint: 0xa9a79c, opts: { repeat: 3.2, grime: 1.15 }, rough: [0.14, 0.62] },
  carBlue: { base: 'painted_steel_chipped', tint: 0x2f4a63, opts: { repeat: 3.2, grime: 1.05 }, rough: [0.11, 0.58] },
  carSand: { base: 'painted_steel_chipped', tint: 0x8d7c58, opts: { repeat: 3.2, grime: 1.25 }, rough: [0.16, 0.7] },
  burnt: { base: 'rusted_steel', tint: 0x2a2320, opts: { repeat: 2.6, grime: 1.5 }, rough: [0.5, 1.0] },

  /* ── painted signage / plastics ──────────────────────────────────────── */
  plasticBlue: { base: 'plywood_painted', tint: 0x3d6b86, opts: { repeat: 3.0, grime: 1.1 }, rough: [0.2, 0.7] },
  plasticGreen: { base: 'plywood_painted', tint: 0x4a6b3c, opts: { repeat: 3.0, grime: 1.1 }, rough: [0.2, 0.7] },
  olive: { base: 'plywood_painted', tint: 0x5c5f3e, opts: { repeat: 2.2, grime: 1.3 }, rough: [0.35, 0.95] },
  signWhite: { base: 'painted_steel_chipped', tint: 0xc6c3b8, opts: { repeat: 2.0, grime: 1.0 }, rough: [0.2, 0.75] },
  signRed: { base: 'painted_steel_chipped', tint: 0x8e2a22, opts: { repeat: 2.0, grime: 1.0 }, rough: [0.2, 0.75] },
  produce: { base: 'dry_grass_ground', tint: 0x8b8a3c, opts: { repeat: 4.0, grime: 0.6 }, rough: [0.3, 0.8] },

  /* ── emissive lenses: built by PropPalette.lens(), listed here so surfaceTag()
        still reports glass to ballistics and FX ─────────────────────────────── */
  lens: { base: 'light_panel', opts: {} },
  lensCold: { base: 'light_panel', opts: {} },

  /* ── alpha-cutout weaves: built by PropPalette.cutout() in registerCutouts() ── */
  chain: { base: 'galvanised_metal', opts: { repeat: 2.6 } },

  /* ── the written world: one canvas atlas, two materials. props/signage.js ──── */
  /** opaque enamel/board faces — shop fascias, street plates, unit numbers */
  signage: { base: 'painted_steel_chipped', opts: {} },
  /** alpha-tested paint straight onto a wall, shutter or road */
  signageDecal: { base: 'painted_steel_chipped', opts: {} },
};

/** Emissive lamp lens — read by the night pose, so it is deliberately restrained. */
const LENS = { base: 'light_panel', emissiveIntensity: 3.2 };

/**
 * Draw-call budget: a merged district costs one call per *material*, so several keys
 * deliberately collapse onto one. Keeping the aliases here (rather than editing every
 * generator) means the split can be retuned without touching the geometry code.
 */
export const MAT_ALIAS = {
  paving: 'concrete',
  alu: 'galv',
  ply: 'wood',
  paintwood: 'wood',
  carRed: 'carSand',
};

/** Resolves and caches the palette. One instance per Props system. */
/** Materials that get the cloth wind displacement. */
const CLOTH = new Set(['canvas', 'tarp']);

// language=GLSL
const BEGIN_VERTEX_WIND = `#include <begin_vertex>
#ifdef USE_COLOR
	float codFlap = vColor.g;
	if ( codFlap > 0.002 ) {
		vec3 codWp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
		float codPh = uPropWind.w * 1.9 + codWp.x * 0.8 + codWp.z * 0.6;
		float codAmp = codFlap * ( 0.010 + 0.055 * uPropWind.z );
		transformed.x += sin( codPh ) * codAmp * uPropWind.x;
		transformed.z += sin( codPh * 1.11 + 1.7 ) * codAmp * uPropWind.y;
		transformed.y += sin( codPh * 0.83 + 0.4 ) * codAmp * 0.55;
	}
#endif`;

export class PropPalette {
  constructor(ctx) {
    this.ctx = ctx;
    this.windU = { value: new THREE.Vector4(1, 0, 0.35, 0) };
    this.cache = new Map();
    this.owned = [];
    this.textures = [];
    this.missing = new Set();
  }

  /** Collapse an alias to the key that actually owns a material. */
  resolve(key) {
    return MAT_ALIAS[key] || key;
  }

  /** @returns {THREE.Material} never null */
  get(rawKey) {
    const key = this.resolve(rawKey);
    const hit = this.cache.get(key);
    if (hit) return hit;
    // Emissive lenses are built by lens() so the night pose gets real practicals.
    if (key === 'lens') return this.lens(0xffc07a, 3.4);
    if (key === 'lensCold') return this.lens(0xcfe2ff, 2.2);
    if (key === 'chain') return this.registerCutouts().chain;
    if (key === 'signage' || key === 'signageDecal') return this.signageMaterial(key === 'signageDecal');
    const mat = this._build(key);
    this.cache.set(key, mat);
    return mat;
  }

  _build(key) {
    const lib = this.ctx.materials;
    const def = PROP_MATS[key];
    if (!def) {
      if (!this.missing.has(key)) {
        this.missing.add(key);
        console.warn(`[props] unknown material key "${key}", falling back to concrete`);
      }
      return this.get('concrete');
    }
    const opts = {
      ...def.opts,
      vertexColors: def.noVCol ? undefined : true,
      variant: `prop_${key}`,
    };
    let mat = null;
    try {
      if (def.tint !== undefined) {
        mat = lib?.clone?.(def.base, { ...opts, color: def.tint, name: `prop:${key}` }) || null;
        if (mat) this.owned.push(mat);
      } else {
        mat = lib?.get?.(def.base, opts) || null;
      }
    } catch (err) {
      console.warn(`[props] material "${key}" failed to build`, err?.message || err);
    }
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.9, name: `prop:${key}:fallback` });
      this.owned.push(mat);
    }
    if (def.rough) {
      try {
        const u = lib?.uniformsOf?.(mat);
        if (u?.uCodRough?.value?.set) u.uCodRough.value.set(def.rough[0], def.rough[1]);
      } catch {
        /* the extension is optional; the material still renders */
      }
    }
    mat.userData.propMaterial = key;
    if (CLOTH.has(key)) this._animateCloth(mat);
    return mat;
  }

  /**
   * Cloth motion. The MaterialLibrary owns `onBeforeCompile` on these materials, so we
   * *wrap* it rather than replace it: their extension runs first, then we add one
   * displacement in the vertex stage driven by the flap mask in vColor.g. Our own
   * uniform (rather than theirs) keeps this independent of their vertex prelude.
   */
  _animateCloth(mat) {
    if (!mat || mat.userData.propCloth) return mat;
    mat.userData.propCloth = true;
    const windU = this.windU;
    const prev = typeof mat.onBeforeCompile === 'function' ? mat.onBeforeCompile : null;
    mat.onBeforeCompile = function propCloth(shader, renderer) {
      try {
        if (prev) prev.call(this, shader, renderer);
      } catch (err) {
        console.warn('[props] base onBeforeCompile failed', err?.message || err);
      }
      if (!shader?.vertexShader?.includes('#include <begin_vertex>')) return;
      shader.uniforms.uPropWind = windU;
      shader.vertexShader =
        'uniform vec4 uPropWind;\n' +
        shader.vertexShader.replace('#include <begin_vertex>', BEGIN_VERTEX_WIND);
    };
    mat.needsUpdate = true;
    return mat;
  }

  /** Called from Props.update(): keeps the cloth in step with the shared wind globals. */
  tickWind(globals) {
    const w = globals?.wind;
    const u = this.windU.value;
    if (w && Number.isFinite(w.x)) u.set(w.x, w.y, Math.max(0, w.z + (w.w || 0) * 0.5), u.w);
    const t = globals?.time;
    u.w = Number.isFinite(t) ? t : u.w + 0.016;
  }

  /* ══════════════════════════════════════════════════════════════ signage ══ */

  /**
   * The signage atlas. Drawn once into a 1024² canvas (see props/signage.js) and
   * uploaded as a single sRGB `CanvasTexture`, so every readable mark in the world —
   * fascias, plates, stencils, graffiti, road paint, cracks — shares one texture and
   * therefore one draw call per district per material.
   *
   * @returns {{layout: object, texture: THREE.Texture|null}}
   */
  signageAtlas() {
    return signageAtlas(this.ctx);
  }

  /**
   * Board face (opaque) or paint decal (alpha-tested, polygon-offset). Deliberately a
   * plain Standard material rather than a MaterialLibrary recipe: the library owns
   * `map` and would overwrite the atlas with its own tiling albedo. All the wear,
   * grime, chipping and overspray is painted into the canvas instead, and the sky's
   * aerial perspective is injected by hand so a distant fascia hazes with everything
   * else.
   */
  signageMaterial(decal) {
    const ck = decal ? 'signageDecal' : 'signage';
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const { texture } = this.signageAtlas();
    const mat = new THREE.MeshStandardMaterial({
      name: `prop:${ck}`,
      map: texture,
      /**
       * Not white. An enamelled board painted a mid green reads at about 0.3 albedo;
       * multiplied by an 11-intensity sun through ACES it clips to cream and the
       * fascia comes out as a blank pale panel with a ghost of lettering on it —
       * measured on the first capture. A stop and a half down puts the board back
       * below the sunlit stucco it is bolted to, which is where a painted sign
       * actually sits, and the shop colours survive.
       */
      color: decal ? 0xb4b0a8 : 0xa9a59c,
      roughness: decal ? 0.94 : 0.72,
      metalness: 0.0,
      envMapIntensity: decal ? 0.35 : 0.4,
      side: THREE.FrontSide,
      dithering: true,
    });
    if (decal) {
      /*
       * Genuinely blended, not alpha-tested. Half of what this material carries is
       * *soft*: aerosol overspray round a tag, the fade at the edge of an oil stain,
       * the worn-out middle of a road arrow. A cutout turns every one of those into a
       * hard-edged blob, which reads worse than having no decal there at all. It costs
       * one transparent pass on flat geometry that never overlaps itself.
       */
      mat.transparent = true;
      mat.depthWrite = false;
      mat.alphaTest = 0.012;
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -4;
      mat.polygonOffsetUnits = -8;
    } else {
      mat.transparent = false;
      mat.alphaTest = 0.5;
    }
    mat.userData.propMaterial = ck;
    mat.userData.surface = decal ? 'concrete' : 'metal';
    try {
      this.ctx.sky?.applyAerialPerspective?.(mat);
    } catch {
      /* aerial perspective is a nicety; the sign still renders */
    }
    this.owned.push(mat);
    this.cache.set(ck, mat);
    return mat;
  }

  /** Builds (once) the chain-link weave. 60 mm apertures, alpha-tested. */
  registerCutouts() {
    if (this._cutouts) return this._cutouts;
    const intact = this.cutout('chain', chainLinkAlpha(128, 0.13), 0.24, 'intact');
    this._cutouts = { chain: intact };
    this.cache.set('chain', intact);
    return this._cutouts;
  }

  /**
   * Cut-out material for chain-link panels and torn mesh. `alphaMap` is not part of
   * MaterialLibrary's cache key, so `variant` has to carry the identity.
   */
  cutout(key, alphaMap, tileMetres = 0.42, variant = 'a') {
    const ck = `cut:${key}:${variant}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const def = PROP_MATS[key] || PROP_MATS.galv;
    const tex = alphaMap;
    if (tex) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1 / tileMetres, 1 / tileMetres);
      tex.needsUpdate = true;
      this.textures.push(tex);
    }
    let mat = null;
    try {
      mat = this.ctx.materials?.get?.(def.base, {
        ...def.opts,
        vertexColors: true,
        alphaMap: tex,
        alphaTest: 0.5,
        transparent: false,
        side: 'double',
        variant: `prop_cut_${key}_${variant}`,
      });
    } catch (err) {
      console.warn('[props] cutout material failed', err?.message || err);
    }
    if (!mat) mat = this.get(key);
    mat.userData.propMaterial = `${key}:cutout`;
    this.cache.set(ck, mat);
    return mat;
  }

  /** Soft dirt patch that welds a prop to the ground. Polygon-offset decal variant. */
  contact(alphaMap) {
    const hit = this.cache.get('contact');
    if (hit) return hit;
    let mat = null;
    try {
      if (alphaMap) {
        alphaMap.wrapS = alphaMap.wrapT = THREE.ClampToEdgeWrapping;
        this.textures.push(alphaMap);
      }
      // A clone, not decal(), so the patch can be tinted well below the ground albedo:
      // the point is a soft occlusion ring that welds the prop to the surface, and
      // untinted dirt over dirt is invisible.
      mat = this.ctx.materials?.clone?.('dirt_packed', {
        alphaMap,
        decal: true,
        transparent: true,
        depthWrite: false,
        opacity: 0.68,
        repeat: 1.6,
        color: 0x584f43,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -8,
        variant: 'propContact',
        name: 'prop:contact',
      });
      if (mat) this.owned.push(mat);
    } catch (err) {
      console.warn('[props] contact decal material failed', err?.message || err);
    }
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: 0x2a251d,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        alphaMap: alphaMap || null,
      });
      this.owned.push(mat);
    }
    mat.userData.propMaterial = 'contact';
    this.cache.set('contact', mat);
    return mat;
  }

  /** Emissive lamp/sign lens. */
  lens(color = 0xffd9a0, intensity = 3.2) {
    const ck = `lens:${color.toString(16)}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    let mat = null;
    try {
      mat = this.ctx.materials?.clone?.(LENS.base, {
        emissive: color,
        emissiveIntensity: intensity,
        repeat: 2.0,
        variant: ck,
        name: `prop:${ck}`,
      });
      if (mat) this.owned.push(mat);
    } catch (err) {
      console.warn('[props] lens material failed', err?.message || err);
    }
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: 0x101010,
        emissive: new THREE.Color(color),
        emissiveIntensity: intensity,
        roughness: 0.4,
      });
      this.owned.push(mat);
    }
    this.cache.set(ck, mat);
    return mat;
  }

  /** True if `key` is transparent — those meshes must not write depth first. */
  isTransparent(key) {
    return key === 'glass';
  }

  /**
   * ARCHITECTURE §5 surface tag behind a prop material key — the string physics,
   * ballistics, audio and FX all switch on. Always via SurfaceDefs, never guessed.
   */
  surfaceTag(rawKey) {
    const def = PROP_MATS[this.resolve(rawKey)];
    const base = def?.base || 'concrete_cast';
    try {
      return this.ctx.materials?.surfaceTag?.(base) || 'concrete';
    } catch {
      return 'concrete';
    }
  }

  /** Full SurfaceDef (density, hardness, friction…) behind a prop material key. */
  surfaceDef(rawKey) {
    const def = PROP_MATS[this.resolve(rawKey)];
    const base = def?.base || 'concrete_cast';
    try {
      return this.ctx.materials?.surfaceOf?.(base) || null;
    } catch {
      return null;
    }
  }

  dispose() {
    disposeSignageAtlas();
    for (const m of this.owned) {
      try {
        m.dispose();
      } catch {
        /* best effort */
      }
    }
    for (const t of this.textures) {
      try {
        t.dispose();
      } catch {
        /* best effort */
      }
    }
    this.owned.length = 0;
    this.textures.length = 0;
    this.cache.clear();
  }
}

export default PropPalette;
