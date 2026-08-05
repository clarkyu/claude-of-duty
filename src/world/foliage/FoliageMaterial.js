/**
 * Foliage materials: wind, translucency and alpha handling. Owner: foliage agent.
 *
 * These are `ctx.materials.clone('foliage_leaf' | 'wood_plank_weathered')` variants —
 * they keep the whole MaterialLibrary extension stack (subsurface translucency, detail
 * normals, global dust and wetness, aerial perspective from Sky) and then chain one
 * more `onBeforeCompile` on top for the two things foliage needs that nothing else
 * does.
 *
 * ── 1. Three-band wind ──────────────────────────────────────────────────────────
 * The library's built-in COD_WIND is a single-band bend; it is switched OFF here and
 * replaced with three superposed bands, all driven by the *shared*
 * `ctx.materials.globals` wind uniform so the entire world gusts together:
 *
 *   band 1  ~0.4 Hz   whole-plant sway      moves the trunk crown
 *   band 2  ~1.6 Hz   branch oscillation    moves limbs against the trunk, + a
 *                                           cross-wind component so it is not a 1D flap
 *   band 3  ~6-10 Hz  leaf flutter          per-card, gated by the `aFol.z` leaf flag
 *
 * Amplitude scales with `aFol.x` **squared** — the base of a plant is pinned and only
 * the tips move — and every instance gets its own phase from `aInst.x` plus its world
 * position, so nothing ever moves in lockstep. The tip is pulled *down* in proportion
 * to how far it swung sideways, which keeps the plant from visibly stretching.
 *
 * The same code is injected into a matching `MeshDepthMaterial`, so the shadow sways
 * with the leaf instead of standing still.
 *
 * ── 2. Alpha ────────────────────────────────────────────────────────────────────
 * Alpha-tested, never sorted-blended: the material is opaque, writes depth and needs
 * no back-to-front ordering, so it cannot flicker against itself and TAA/DOF/SSAO all
 * treat it as solid geometry. The cutout is an analytic-coverage + interleaved-gradient
 * dither (an alpha-to-coverage stand-in that works without MSAA): coverage is
 * reconstructed from `fwidth()` of the mask, so distant mip-blurred leaves keep their
 * area instead of eroding away, and the dither width drops to near-zero when TAA is
 * off so a non-TAA frame stays clean.
 *
 * ── 3. Translucency ─────────────────────────────────────────────────────────────
 * COD_SSS from the library, dialled up for foliage. Backlit leaves pick up
 * `uCodSssColor` scaled by the wrap term, so a leaf with the sun behind it glows
 * yellow-green instead of going black. Card normals are bent outward from the cluster
 * centre at build time, which is the other half of making a leaf mass read as a volume.
 */
import * as THREE from 'three';

/* ========================================================================== */
/*                                   GLSL                                     */
/* ========================================================================== */

// language=GLSL
const WIND_VERT_PARS = /* glsl */ `
attribute vec3 aFol;          // x = flex (0 base -> 1 tip), y = card phase, z = leaf flag
#ifdef USE_INSTANCING
	attribute vec4 aInst;     // x = phase, y = amplitude scale, z = droop, w = seed
	attribute vec3 aTint;
#endif
varying vec3 vFolTint;
varying float vFolFade;
uniform vec4 uFolWind;        // swayAmp(m), branchAmp(m), flutterAmp(m), timeScale
uniform vec4 uFolFade;        // fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd
#ifndef COD_WIND
	uniform float uCodTime;
	uniform vec4 uCodWind;    // xy = direction, z = strength, w = gust
#endif
`;

// language=GLSL
const WIND_VERT_BODY = /* glsl */ `
{
	vec4 folI = vec4( 0.0, 1.0, 0.35, 0.0 );
	vec3 folT = vec3( 1.0 );
	vec3 folOrg = vec3( 0.0 );
	#ifdef USE_INSTANCING
		folI = aInst;
		folT = aTint;
		folOrg = instanceMatrix[ 3 ].xyz;
	#endif
	folOrg = ( modelMatrix * vec4( folOrg, 1.0 ) ).xyz;

	// Per-instance phase: the attribute decorrelates plants of the same species and the
	// world position decorrelates plants that happen to share an attribute value.
	float folPh = folI.x * 6.2831853 + dot( folOrg.xz, vec2( 0.7137, 0.4211 ) );
	float folT2 = uCodTime * uFolWind.w;
	vec2  folDir = normalize( uCodWind.xy + vec2( 1e-5, 0.0 ) );
	float folW = clamp( uCodWind.z * ( 1.0 + uCodWind.w * 0.9 ), 0.0, 2.4 );

	float folFlex = clamp( aFol.x, 0.0, 1.0 );
	float folLph = aFol.y * 6.2831853;
	float folLeaf = aFol.z;

	// three bands, deliberately non-harmonic so they never re-phase into a single beat
	float folS1 = sin( folT2 * 0.37 + folPh ) * 0.62 + sin( folT2 * 0.61 + folPh * 1.73 + 2.1 ) * 0.38;
	float folS2 = sin( folT2 * 1.63 + folPh * 2.31 + folLph * 0.45 ) * 0.68 + sin( folT2 * 2.47 + folPh * 0.83 ) * 0.32;
	float folS3 = sin( folT2 * 6.30 + folLph * 3.10 + folPh ) * 0.58 + sin( folT2 * 10.1 + folLph * 5.30 + folPh * 2.1 ) * 0.42;

	vec3 folFwd = vec3( folDir.x, 0.0, folDir.y );
	vec3 folLat = vec3( - folDir.y, 0.0, folDir.x );
	float folAmp = folW * folI.y;
	float folF2 = folFlex * folFlex;

	vec3 folOff = folFwd * ( folS1 * uFolWind.x + folS2 * uFolWind.y * 0.55 ) * folAmp * folF2;
	folOff += folLat * folS2 * uFolWind.y * 0.32 * folAmp * folF2;
	folOff += ( folFwd * 0.35 + folLat * 0.55 + vec3( 0.0, 0.62, 0.0 ) )
	          * ( folS3 * uFolWind.z * folAmp * folLeaf * mix( 0.30, 1.0, folFlex ) );
	// Arc, not shear: the further the tip swings out, the lower it drops.
	folOff.y -= dot( folOff.xz, folOff.xz ) * folI.z;

	// World-space offset back into the vertex's own space. modelMatrix is orthonormal
	// here; the instance columns carry the per-plant yaw and scale.
	vec3 folM = vec3( dot( folOff, modelMatrix[ 0 ].xyz ),
	                  dot( folOff, modelMatrix[ 1 ].xyz ),
	                  dot( folOff, modelMatrix[ 2 ].xyz ) );
	#ifdef USE_INSTANCING
		vec3 fc0 = instanceMatrix[ 0 ].xyz;
		vec3 fc1 = instanceMatrix[ 1 ].xyz;
		vec3 fc2 = instanceMatrix[ 2 ].xyz;
		transformed += vec3( dot( folM, fc0 ) / max( 1e-6, dot( fc0, fc0 ) ),
		                     dot( folM, fc1 ) / max( 1e-6, dot( fc1, fc1 ) ),
		                     dot( folM, fc2 ) / max( 1e-6, dot( fc2, fc2 ) ) );
	#else
		transformed += folM;
	#endif

	// LOD cross-fade. Evaluated per vertex from the real camera distance so the
	// dissolve is smooth and needs no per-frame attribute uploads.
	vec4 folWp = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		folWp = instanceMatrix * folWp;
	#endif
	folWp = modelMatrix * folWp;
	float folD = distance( cameraPosition, folWp.xyz );
	float folIn = ( uFolFade.y > uFolFade.x ) ? smoothstep( uFolFade.x, uFolFade.y, folD ) : 1.0;
	float folOut = ( uFolFade.w > uFolFade.z ) ? 1.0 - smoothstep( uFolFade.z, uFolFade.w, folD ) : 1.0;
	vFolFade = clamp( min( folIn, folOut ), 0.0, 1.0 );
	vFolTint = folT;
}
`;

// language=GLSL
const FOL_FRAG_PARS = /* glsl */ `
varying vec3 vFolTint;
varying float vFolFade;
uniform float uFolDither;
`;

// language=GLSL
const FOL_FRAG_TINT = /* glsl */ `
// Per-instance albedo variation. The library's extension turns three's own
// color_fragment into a no-op (vColor is a grime mask there), so the tint is applied
// here instead of through instanceColor.
diffuseColor.rgb *= vFolTint;
`;

// language=GLSL
const FOL_FRAG_ALPHATEST = /* glsl */ `
#ifdef USE_ALPHATEST
{
	float folA = diffuseColor.a;
	// Analytic coverage from the screen-space derivative: without this, mip-averaged
	// leaf masks erode and a hedge turns into lace at 30 m.
	float folWd = max( fwidth( folA ), 1e-4 );
	float folCov = clamp( ( folA - alphaTest ) / folWd + 0.5, 0.0, 1.0 ) * clamp( vFolFade, 0.0, 1.0 );
	// Interleaved gradient noise — cheap, stable under TAA, no texture fetch.
	float folN = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	if ( folCov < mix( 0.5, folN, uFolDither ) ) discard;
	diffuseColor.a = 1.0;
}
#endif
`;

/* ========================================================================== */
/*                                  patching                                  */
/* ========================================================================== */

const CHUNK = (n) => `#include <${n}>`;

/**
 * Chain the foliage injections onto a material that may already have been patched by
 * MaterialLibrary, Sky and Lighting. Never replaces an existing `onBeforeCompile`.
 */
function patch(material, uniforms, opts = {}) {
  if (!material || material.userData?.__folPatched) return material;
  const prev = typeof material.onBeforeCompile === 'function' ? material.onBeforeCompile : null;
  const tint = opts.tint !== false;

  material.onBeforeCompile = function (shader, renderer) {
    if (prev) {
      try {
        prev.call(this, shader, renderer);
      } catch {
        /* someone else's patch failed; ours still has to land */
      }
    }
    try {
      Object.assign(shader.uniforms, uniforms);

      let v = shader.vertexShader;
      // Defaults first, so the varyings are always written even if the anchor moved.
      v = v.replace(
        'void main() {',
        `${WIND_VERT_PARS}\nvoid main() {\n\tvFolTint = vec3( 1.0 );\n\tvFolFade = 1.0;`
      );
      // The library already swapped project_vertex for its own body — which still
      // contains the include — so this lands inside it, after any library wind and
      // before the projection. If the library is absent it lands on the stock chunk.
      if (v.includes(CHUNK('project_vertex'))) {
        v = v.replace(CHUNK('project_vertex'), () => `${WIND_VERT_BODY}\n${CHUNK('project_vertex')}`);
      }
      shader.vertexShader = v;

      let f = shader.fragmentShader;
      f = f.replace('void main() {', `${FOL_FRAG_PARS}\nvoid main() {`);
      if (tint && f.includes(CHUNK('alphamap_fragment'))) {
        f = f.replace(CHUNK('alphamap_fragment'), () => `${CHUNK('alphamap_fragment')}\n${FOL_FRAG_TINT}`);
      }
      if (f.includes(CHUNK('alphatest_fragment'))) {
        f = f.replace(CHUNK('alphatest_fragment'), () => FOL_FRAG_ALPHATEST);
      }
      shader.fragmentShader = f;
    } catch (err) {
      console.warn('[foliage] shader patch failed, using the unpatched material', err);
    }
  };

  const prevKey =
    material.customProgramCacheKey &&
    material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey
      ? material.customProgramCacheKey
      : null;
  material.customProgramCacheKey = function () {
    return `${prevKey ? prevKey.call(this) : ''}|fol:1:${tint ? 't' : 'n'}`;
  };

  material.userData = material.userData || {};
  material.userData.__folPatched = true;
  Object.defineProperty(material.userData, 'folUniforms', {
    value: uniforms,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  material.needsUpdate = true;
  return material;
}

/* ========================================================================== */
/*                                  factory                                   */
/* ========================================================================== */

const V4 = (x, y, z, w) => ({ value: new THREE.Vector4(x, y, z, w) });

/** No fade at all — used by the shadow caster, whose "camera" is the light. */
const NO_FADE = [-2, -1, 1e7, 1e7 + 1];

export class FoliageMaterials {
  constructor(ctx, atlas) {
    this.ctx = ctx;
    this.atlas = atlas;
    this.owned = [];
    this.leafVariants = new Map();
    this.woodVariants = new Map();
    this.globals = ctx.materials?.globals?.uniforms || null;
    this.localTime = { value: 0 };
    this.localWind = { value: new THREE.Vector4(0.92, 0.39, 0.35, 0) };
    this.dither = { value: 0.85 };
    this.alphaTest = 0.36;
    this._syncDither();
  }

  _windUniforms() {
    const g = this.globals;
    return {
      uCodTime: g?.uCodTime || this.localTime,
      uCodWind: g?.uCodWind || this.localWind,
    };
  }

  _syncDither() {
    const s = this.ctx.settings;
    const taa = !!s?.get?.('taa');
    // Full stochastic coverage only pays off when a temporal filter can resolve it.
    this.dither.value = taa ? 0.85 : 0.22;
  }

  /** Called from Foliage.update() when the library is unavailable. */
  tick(elapsed) {
    if (this.globals) return;
    this.localTime.value = elapsed;
  }

  /**
   * @param {string} key      cache key (species + lod)
   * @param {number[]} wind   [swayAmp, branchAmp, flutterAmp, timeScale]
   * @param {number[]} fade   [inStart, inEnd, outStart, outEnd]
   */
  leaf(key, wind, fade) {
    const hit = this.leafVariants.get(key);
    if (hit) return hit;
    const mat = this._buildLeaf(key, wind, fade);
    this.leafVariants.set(key, mat);
    return mat;
  }

  wood(key, wind, fade) {
    const hit = this.woodVariants.get(key);
    if (hit) return hit;
    const mat = this._buildWood(key, wind, fade);
    this.woodVariants.set(key, mat);
    return mat;
  }

  _buildLeaf(key, wind, fade) {
    const ctx = this.ctx;
    const leaf = this.atlas?.leaf;
    let mat = null;
    try {
      mat = ctx.materials?.clone?.('foliage_leaf', {
        side: 'double',
        alphaTest: this.alphaTest,
        alphaMap: leaf?.alphaMap || null,
        transparent: false,
        depthWrite: true,
        variant: `fol_${key}`,
      });
    } catch (err) {
      console.warn('[foliage] leaf material clone failed', err);
    }
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.72,
        metalness: 0,
        side: THREE.DoubleSide,
        alphaTest: this.alphaTest,
      });
    }
    mat.name = `foliage:leaf:${key}`;
    // The recipe ships a green base tint meant to colour an untextured surface. Our
    // atlas already carries the leaf colour, and multiplying the two crushes foliage
    // to near-black — species variation comes from the per-instance `aTint` instead.
    mat.color.setRGB(1, 1, 1);
    if (leaf) {
      mat.map = leaf.map;
      mat.normalMap = leaf.normalMap;
      mat.roughnessMap = leaf.ormMap;
      mat.metalnessMap = leaf.ormMap;
      mat.aoMap = leaf.ormMap;
      mat.alphaMap = leaf.alphaMap;
    }
    mat.side = THREE.DoubleSide;
    mat.shadowSide = THREE.DoubleSide;
    mat.transparent = false;
    mat.depthWrite = true;
    mat.depthTest = true;
    mat.alphaTest = this.alphaTest;
    mat.aoMapIntensity = 1.0;

    const d = mat.defines || (mat.defines = {});
    delete d.COD_WIND; // superseded by the three-band version below
    delete d.COD_POM;
    delete d.COD_TILEBREAK;

    const u = ctx.materials?.uniformsOf?.(mat) || null;
    if (u) {
      // Atlas UVs are absolute 0..1 texture coordinates, not metres.
      u.uCodUvXf?.value.set(1, 1, 0, 0);
      // Micro detail at leaf scale, not at wall scale.
      u.uCodDetail?.value.set(7.0, 0.35, 0.30, 26.0);
      // Translucency: this is the difference between a leaf and green cardboard.
      u.uCodSss?.value.set(0.85, 2.3, 0.42, 0.06);
      u.uCodSssColor?.value.setRGB(0.42, 0.55, 0.16);
      u.uCodRough?.value.set(0.32, 0.92);
      // The extension drives normal strength from its own uniform, not material.normalScale.
      u.uCodNrmScale?.value.set(1.35, 1.35);
      if (u.uCodAoDirect) u.uCodAoDirect.value = 0.34;
      // Dust settles on leaves too, but far less than on a ledge.
      u.uCodDustP?.value.set(0.28, 3.5, 0.1, 2.6);
    }

    const uniforms = {
      ...this._windUniforms(),
      uFolWind: V4(wind[0], wind[1], wind[2], wind[3]),
      uFolFade: V4(fade[0], fade[1], fade[2], fade[3]),
      uFolDither: this.dither,
    };
    patch(mat, uniforms);
    this.owned.push(mat);

    const depth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      alphaMap: leaf?.alphaMap || null,
      alphaTest: this.alphaTest,
      side: THREE.DoubleSide,
    });
    depth.name = `foliage:leafDepth:${key}`;
    patch(
      depth,
      {
        ...this._windUniforms(),
        uFolWind: V4(wind[0], wind[1], wind[2], wind[3]),
        uFolFade: V4(NO_FADE[0], NO_FADE[1], NO_FADE[2], NO_FADE[3]),
        // A dithered shadow map is just noise: cut hard here.
        uFolDither: { value: 0 },
      },
      { tint: false }
    );
    this.owned.push(depth);
    mat.userData.folDepth = depth;
    return mat;
  }

  _buildWood(key, wind, fade) {
    const ctx = this.ctx;
    const bark = this.atlas?.bark;
    let mat = null;
    try {
      mat = ctx.materials?.clone?.('wood_plank_weathered', { variant: `folwood_${key}` });
    } catch (err) {
      console.warn('[foliage] bark material clone failed', err);
    }
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: 0x5a4c3c, roughness: 0.9, metalness: 0 });
    }
    mat.name = `foliage:bark:${key}`;
    if (bark) {
      mat.map = bark.map;
      mat.normalMap = bark.normalMap;
      mat.roughnessMap = bark.ormMap;
      mat.metalnessMap = bark.ormMap;
      mat.aoMap = bark.ormMap;
    }
    mat.side = THREE.FrontSide;

    const u = ctx.materials?.uniformsOf?.(mat) || null;
    if (u) {
      u.uCodUvXf?.value.set(1, 1, 0, 0);
      u.uCodDetail?.value.set(9.0, 0.55, 0.42, 22.0);
      u.uCodRough?.value.set(0.55, 1.0);
      u.uCodNrmScale?.value.set(0.85, 0.85);
      if (u.uCodHeightMap && bark?.heightMap) u.uCodHeightMap.value = bark.heightMap;
      u.uCodDustP?.value.set(0.55, 4.0, 0.12, 2.2);
    }
    const d = mat.defines || (mat.defines = {});
    delete d.COD_TILEBREAK;
    // No parallax on bark: the height relief is already in the normal map, the trunk is
    // never seen at a grazing angle up close, and the POM self-shadow term was eating
    // most of the lit side of the trunk.
    delete d.COD_POM;
    delete d.COD_POM_SHADOW;
    delete d.COD_POM_CLIP;

    const uniforms = {
      ...this._windUniforms(),
      uFolWind: V4(wind[0], wind[1], wind[2], wind[3]),
      uFolFade: V4(fade[0], fade[1], fade[2], fade[3]),
      uFolDither: this.dither,
    };
    patch(mat, uniforms);
    this.owned.push(mat);

    // Trunks are opaque, but they still have to sway with their own canopy or the
    // shadow and the geometry drift apart.
    const depth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.FrontSide,
    });
    depth.name = `foliage:barkDepth:${key}`;
    patch(
      depth,
      {
        ...this._windUniforms(),
        uFolWind: V4(wind[0], wind[1], wind[2], wind[3]),
        uFolFade: V4(NO_FADE[0], NO_FADE[1], NO_FADE[2], NO_FADE[3]),
        uFolDither: { value: 0 },
      },
      { tint: false }
    );
    this.owned.push(depth);
    mat.userData.folDepth = depth;
    return mat;
  }

  /** Terracotta pot / planter shell. Not wind animated. */
  pot() {
    if (this._pot) return this._pot;
    let mat = null;
    try {
      mat = this.ctx.materials?.clone?.('stucco', {
        color: 0xa8613c,
        repeat: 2.6,
        variant: 'folpot',
      });
    } catch {
      /* fall through */
    }
    if (!mat) mat = new THREE.MeshStandardMaterial({ color: 0x9a5a38, roughness: 0.88, metalness: 0 });
    mat.name = 'foliage:pot';
    mat.userData.surface = 'ceramic';
    this._pot = mat;
    this.owned.push(mat);
    return mat;
  }

  onQualityChanged() {
    this._syncDither();
    // MaterialLibrary re-derives the parallax/detail uniforms from the *recipe* on a
    // tier change, which would undo the leaf-scale retune above.
    for (const mat of this.leafVariants.values()) {
      const u = this.ctx.materials?.uniformsOf?.(mat);
      if (!u) continue;
      u.uCodUvXf?.value.set(1, 1, 0, 0);
      u.uCodDetail?.value.set(7.0, 0.35, 0.30, 26.0);
      const d = mat.defines;
      if (d && (d.COD_POM !== undefined || d.COD_TILEBREAK !== undefined)) {
        delete d.COD_POM;
        delete d.COD_POM_SHADOW;
        delete d.COD_TILEBREAK;
        mat.needsUpdate = true;
      }
    }
    for (const mat of this.woodVariants.values()) {
      const u = this.ctx.materials?.uniformsOf?.(mat);
      if (!u) continue;
      u.uCodUvXf?.value.set(1, 1, 0, 0);
      u.uCodDetail?.value.set(9.0, 0.55, 0.42, 22.0);
      if (u.uCodHeightMap && this.atlas?.bark?.heightMap) u.uCodHeightMap.value = this.atlas.bark.heightMap;
      const d = mat.defines;
      if (d && (d.COD_POM !== undefined || d.COD_TILEBREAK !== undefined)) {
        delete d.COD_POM;
        delete d.COD_POM_SHADOW;
        delete d.COD_POM_CLIP;
        delete d.COD_TILEBREAK;
        mat.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const m of this.owned) {
      try {
        m.dispose();
      } catch {
        /* best effort */
      }
    }
    this.owned.length = 0;
    this.leafVariants.clear();
    this.woodVariants.clear();
    this._pot = null;
  }
}

export default FoliageMaterials;
