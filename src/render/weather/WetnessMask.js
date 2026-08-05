/**
 * weather/WetnessMask.js — "covered surfaces stay dry", per pixel.
 * Owner: weather agent. Files owned: src/render/Weather.js, src/render/weather/**.
 *
 * `ctx.materials.setWetness()` is a single global scalar, which is right: the material
 * library owns what water does to a surface (darker albedo, lower roughness, puddles
 * pooling in the height field) and we must not duplicate any of that. But a scalar
 * cannot know that the floor of a shop is under a roof, so with wetness alone a
 * downpour soaks the inside of every building.
 *
 * So we chain one more `onBeforeCompile` onto the materials already in the scene and
 * replace exactly one line of the library's wetness block:
 *
 *     float wet = codSat( uCodWetness * uCodWet.x );
 *  -> float wet = codSat( uCodWetness * uCodWet.x * wxSkyWet( vCodWPos, codWN ) );
 *
 * `wxSkyWet` samples the shelter height field a short step **along the surface
 * normal**, which is what separates the two hard cases: pushing off an exterior facade
 * lands in the open street (wet), pushing off an interior wall lands inside the room,
 * under the roof (dry). Straight up off a floor does the same thing for horizontal
 * surfaces. No other module's file is touched — this is the same runtime chaining
 * Lighting.js and Sky.js already do, and `extendMaterial()` explicitly supports being
 * wrapped later.
 *
 * It is applied **lazily**: nothing happens until weather that actually wets things is
 * on its way. Patching changes the program cache key, so it costs one recompile of the
 * scene's materials; in clear weather that cost is never paid at all.
 *
 * If the library's wetness line is ever reworded, `indexOf` misses, we leave the
 * material exactly as we found it and the world simply goes uniformly wet again.
 */
import * as THREE from 'three';

/** The one line we rewrite, verbatim from materials/shaders/materialExtensions.js. */
/** Materials patched per scan pass — one recompile each, so keep it small. */
const PATCH_PER_SCAN = 4;

const MARKER = 'float wet = codSat( uCodWetness * uCodWet.x );';
const PATCHED = 'float wet = codSat( uCodWetness * uCodWet.x * wxSkyWet( vCodWPos, codWN ) );';

// language=GLSL
const PARS = /* glsl */ `
uniform sampler2D wxShelterMap;
uniform vec4  wxShelterRect;   // ( minX, maxZ, 1/sizeX, -1/sizeZ )
uniform vec2  wxShelterCfg;    // x = map valid, y = probe distance in metres

/**
 * 1 where the sky can rain on this pixel, 0 where something is over it.
 * The probe steps off along the normal first: a facade steps into the street and
 * stays wet, an interior wall steps into the room and goes dry.
 */
float wxSkyWet( vec3 wp, vec3 n ) {
	if ( wxShelterCfg.x < 0.5 ) return 1.0;
	vec3 sp = wp + n * wxShelterCfg.y;
	vec2 uv = ( sp.xz - wxShelterRect.xy ) * wxShelterRect.zw;
	// Outside the bake is outdoors, not indoors.
	if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return 1.0;
	float top = texture2D( wxShelterMap, uv ).r;
	if ( top < -1000.0 ) return 1.0;
	// How far below the topmost surface we sit. Under half a metre is that surface.
	return smoothstep( 1.8, 0.45, top - sp.y );
}
`;

export class WetnessMask {
  /**
   * @param {object} ctx
   * @param {import('./ShelterMap.js').ShelterMap} shelter
   */
  constructor(ctx, shelter) {
    this.ctx = ctx;
    this.shelter = shelter;
    this.enabled = true;
    this.applied = 0;
    this.skipped = 0;
    this._seen = new WeakSet();
    this._lastScan = -1e9;
    this._backlog = true;
    this._warned = false;
    this.uniforms = {
      wxShelterMap: { value: null },
      wxShelterRect: { value: new THREE.Vector4(-64, 60, 1 / 128, -1 / 118) },
      wxShelterCfg: { value: new THREE.Vector2(0, 0.75) },
    };
  }

  /** Point the uniforms at the current bake. Safe to call before any patching. */
  attachShelter() {
    const s = this.shelter;
    const tex = s?.ready ? s.texture : null;
    this.uniforms.wxShelterMap.value = tex;
    this.uniforms.wxShelterCfg.value.x = tex ? 1 : 0;
    if (s?.rect) this.uniforms.wxShelterRect.value.copy(s.rect);
  }

  /**
   * Walk the world and patch what we have not seen yet — but only a few materials per
   * pass.
   *
   * Patching changes the program cache key, so each one costs a shader recompile. Doing
   * the whole scene in a single frame is a hitch you can feel the moment the rain
   * starts; a handful every few frames spreads the same work across the couple of
   * seconds the wetness takes to soak in anyway, and nothing is visibly dry-then-wet
   * because the global wetness is still ramping the whole time. Once the backlog is
   * clear the scan drops to a slow poll that only exists to catch geometry created
   * later, like destruction fragments.
   *
   * @param {number} frame
   * @returns {number} materials patched this pass
   */
  scan(frame) {
    if (!this.enabled) return 0;
    if (!this.shelter?.ready) return 0;
    const interval = this._backlog ? 6 : 150;
    if (frame - this._lastScan < interval) return 0;
    this._lastScan = frame;
    this.attachShelter();

    let n = 0;
    let budget = PATCH_PER_SCAN;
    const visit = (obj) => {
      if (budget <= 0) return;
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) {
        for (const mm of m) {
          if (budget <= 0) break;
          if (this._patch(mm)) {
            n++;
            budget--;
          }
        }
      } else if (this._patch(m)) {
        n++;
        budget--;
      }
    };
    try {
      // World only. The viewmodel lives in its own scene whose world space is not the
      // level's, so a shelter lookup there would read a random street texel — the gun
      // in your hands keeps the plain global wetness.
      this.ctx.scene?.traverse(visit);
    } catch (err) {
      this._warn(err);
    }
    // Budget exhausted means there is almost certainly more waiting; come back soon.
    this._backlog = budget <= 0;
    return n;
  }

  _patch(material) {
    if (!material || this._seen.has(material)) return false;
    this._seen.add(material);
    // Only the material library's extended *surface* materials carry the wetness
    // block. `extendDepthMaterial` sets the same flag on the shadow-caster companions,
    // which have no wetness to mask — patching one would cost a recompile for nothing.
    if (
      !material.userData?.codExtended ||
      material.isMeshDepthMaterial ||
      material.isMeshDistanceMaterial
    ) {
      this.skipped++;
      return false;
    }

    const self = this;
    const prevOBC = typeof material.onBeforeCompile === 'function' ? material.onBeforeCompile : null;
    const defaultKey = THREE.Material.prototype.customProgramCacheKey;
    const prevKeyFn =
      material.customProgramCacheKey && material.customProgramCacheKey !== defaultKey
        ? material.customProgramCacheKey
        : null;

    material.onBeforeCompile = function (shader, renderer) {
      if (prevOBC) {
        try {
          prevOBC.call(this, shader, renderer);
        } catch (err) {
          self._warn(err);
        }
      }
      try {
        const frag = shader.fragmentShader;
        if (frag.indexOf(MARKER) < 0) return; // no wetness block; nothing to do
        let out = frag.replace(MARKER, () => PATCHED);
        // Function replacements throughout: GLSL is full of characters that `$&`-style
        // substitution would eat.
        const anchor = '\nvoid main() {';
        out = out.includes(anchor)
          ? out.replace(anchor, () => `\n${PARS}\nvoid main() {`)
          : `${PARS}\n${out}`;
        shader.fragmentShader = out;
        Object.assign(shader.uniforms, self.uniforms);
      } catch (err) {
        self._warn(err);
      }
    };

    // Distinguish patched from unpatched programs, or three hands one of them the
    // other's compiled shader.
    material.customProgramCacheKey = function () {
      return `${prevKeyFn ? prevKeyFn.call(this) : ''}|wxWet:1`;
    };
    material.needsUpdate = true;
    this.applied++;
    return true;
  }

  _warn(err) {
    if (this._warned) return;
    this._warned = true;
    console.warn('[weather] wetness mask injection failed:', err?.message || err);
  }

  stats() {
    return { applied: this.applied, skipped: this.skipped, valid: this.uniforms.wxShelterCfg.value.x };
  }
}

export default WetnessMask;
