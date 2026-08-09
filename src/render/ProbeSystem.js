/**
 * ProbeSystem — local, box-projected reflection probes.
 * Owner: lighting agent. Part of the `ctx.lighting` module group.
 *
 * A single sky IBL makes every interior wrong: a corridor reflects clouds, a room
 * reflects sunlight it cannot see, and metal reads as chrome floating in a void. The
 * fix is a handful of captured cubemaps placed in the volumes that matter, blended
 * per-pixel by position, and **box projected** — the reflection ray is intersected
 * with the probe's bounding box before the lookup, so a wall reflected in a floor
 * lands where the wall actually is instead of at infinity. Spherical probes are why
 * hobby interiors look like they were filmed inside a beach ball.
 *
 * Capture is spread out: one cube face per frame, then a PMREM pass. After the initial
 * warm-up one probe is refreshed every `refreshInterval` frames so emissives, time of
 * day and destruction eventually make it into the reflections.
 *
 * The PMREM output has to match `scene.environment`'s cube-uv layout exactly, because
 * `CUBEUV_TEXEL_WIDTH` / `MAX_MIP` are baked into the program from the scene
 * environment alone. If the sizes disagree we simply refuse to publish the probes
 * rather than render subtly wrong mips.
 *
 * Public API:
 *   build(count, hints)      place probes
 *   anchor(position, half)   move probe 0 onto the viewer without a rebuild
 *   tick(renderer, scene)    advance the capture scheduler (call after the main render)
 *   parsGLSL()               fragment declarations + `codProbeRadiance()`
 *   uniforms                 shared uniform objects for the material patch
 *   active                   number of probes with a valid capture
 *   version                  bumped whenever the generated GLSL changes
 */
import * as THREE from 'three';

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _tmp = new THREE.Vector3();

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class ProbeSystem {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.count = 0;
    this.max = clamp(Math.round(opts.max ?? 4), 0, 4);
    this.cubeSize = clamp(Math.round(opts.cubeSize ?? 64), 16, 128);
    this.refreshInterval = opts.refreshInterval ?? 240;
    this.version = 0;
    this.active = 0;
    this.enabled = true;
    this.broken = false;

    /** @type {Array<{position:THREE.Vector3, min:THREE.Vector3, max:THREE.Vector3, feather:number, intensity:number, rt:THREE.WebGLCubeRenderTarget|null, pmrem:THREE.WebGLRenderTarget|null, captured:boolean}>} */
    this.probes = [];

    this.uniforms = {
      uProbePos: { value: [] },
      uProbeMin: { value: [] },
      uProbeMax: { value: [] },
    };

    this._pmrem = null;
    this._cursor = 0;
    this._face = 0;
    this._frame = 0;
    this._refreshRemaining = 0;
    this._cubeCam = null;
    this._warned = false;
  }

  /* ─────────────────────────────────────────────────────────────── placement */

  /**
   * @param {number} count how many probes the quality tier allows
   * @param {Array<{position:number[]|THREE.Vector3, size?:number[]|THREE.Vector3}>} [hints]
   *        explicit placements, normally supplied by the level
   */
  build(count, hints) {
    this.dispose(false);
    const n = clamp(Math.round(count ?? 0), 0, this.max);
    this.count = n;
    this.active = 0;
    if (n === 0) {
      this._syncUniformArrays();
      this.version++;
      return;
    }

    const placements = this._placements(n, hints);
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const rt = new THREE.WebGLCubeRenderTarget(this.cubeSize, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
      });
      rt.texture.name = `probe${i}.cube`;
      this.probes.push({
        position: p.position,
        min: p.min,
        max: p.max,
        feather: p.feather,
        intensity: 1,
        rt,
        pmrem: null,
        captured: false,
      });
    }

    if (!this._cubeCam) {
      this._cubeCam = new THREE.CubeCamera(0.08, 400, this.probes[0].rt);
      this._cubeCam.name = 'probe.cubeCamera';
    }

    this._syncUniformArrays();
    this._cursor = 0;
    this._face = 0;
    this.version++;
  }

  _placements(n, hints) {
    const out = [];
    const ctx = this.ctx;

    const push = (pos, halfSize, feather) => {
      const position = pos.clone();
      const min = position.clone().sub(halfSize);
      const max = position.clone().add(halfSize);
      out.push({ position, min, max, feather: feather ?? Math.min(halfSize.x, halfSize.z) * 0.35 });
    };

    // 1. Explicit level authoring wins.
    const list = hints || ctx.level?.reflectionProbes || ctx.level?.probes || null;
    if (Array.isArray(list) && list.length) {
      for (const h of list.slice(0, n)) {
        const pos = Array.isArray(h.position)
          ? new THREE.Vector3().fromArray(h.position)
          : new THREE.Vector3().copy(h.position || h);
        const size = h.size
          ? Array.isArray(h.size)
            ? new THREE.Vector3().fromArray(h.size)
            : new THREE.Vector3().copy(h.size)
          : new THREE.Vector3(24, 10, 24);
        push(pos, size.multiplyScalar(0.5), h.feather);
      }
      if (out.length) return out;
    }

    // 2. Otherwise derive a grid from whatever geometry exists.
    const bounds = this._sceneBounds();
    bounds.getSize(_size);
    const cx = (bounds.min.x + bounds.max.x) * 0.5;
    const cz = (bounds.min.z + bounds.max.z) * 0.5;
    const y = Math.min(bounds.min.y + 2.2, (bounds.min.y + bounds.max.y) * 0.5);

    if (n === 1) {
      const half = new THREE.Vector3(
        Math.max(_size.x * 0.6, 12),
        Math.max(_size.y * 0.6, 6),
        Math.max(_size.z * 0.6, 12)
      );
      push(new THREE.Vector3(cx, y, cz), half);
      return out;
    }

    // Rectangular tiling that stays square-ish however many probes we were given.
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const stepX = Math.max(_size.x / cols, 10);
    const stepZ = Math.max(_size.z / rows, 10);
    const halfBox = new THREE.Vector3(stepX * 0.75, Math.max(_size.y * 0.6, 6), stepZ * 0.75);
    let made = 0;
    for (let r = 0; r < rows && made < n; r++) {
      for (let c = 0; c < cols && made < n; c++) {
        const px = cx + (c - (cols - 1) * 0.5) * stepX;
        const pz = cz + (r - (rows - 1) * 0.5) * stepZ;
        push(new THREE.Vector3(px, y, pz), halfBox.clone());
        made++;
      }
    }
    return out;
  }

  _sceneBounds() {
    const scene = this.ctx.scene;
    _box.makeEmpty();
    if (scene) {
      scene.traverseVisible((o) => {
        if (!o.isMesh || o.userData?.sky || o.userData?.noProbe) return;
        const g = o.geometry;
        if (!g) return;
        if (!g.boundingBox) {
          try {
            g.computeBoundingBox();
          } catch {
            return;
          }
        }
        if (!g.boundingBox) return;
        _tmp.copy(g.boundingBox.max).sub(g.boundingBox.min);
        // Skip skyboxes / ground planes the size of a county: they would swamp the fit.
        if (_tmp.length() > 900) return;
        _box.expandByObject(o);
      });
    }
    if (_box.isEmpty()) {
      _box.set(new THREE.Vector3(-24, 0, -24), new THREE.Vector3(24, 12, 24));
    } else {
      _box.getSize(_size);
      if (_size.x < 8) _box.expandByVector(new THREE.Vector3(6, 0, 0));
      if (_size.z < 8) _box.expandByVector(new THREE.Vector3(0, 0, 6));
      if (_size.y < 4) _box.expandByVector(new THREE.Vector3(0, 3, 0));
    }
    return _box.clone();
  }

  _syncUniformArrays() {
    const pos = [];
    const min = [];
    const max = [];
    for (let i = 0; i < this.probes.length; i++) {
      const p = this.probes[i];
      pos.push(new THREE.Vector4(p.position.x, p.position.y, p.position.z, 0));
      min.push(new THREE.Vector4(p.min.x, p.min.y, p.min.z, p.feather));
      max.push(new THREE.Vector4(p.max.x, p.max.y, p.max.z, p.intensity));
    }
    this.uniforms.uProbePos.value = pos;
    this.uniforms.uProbeMin.value = min;
    this.uniforms.uProbeMax.value = max;
    for (let i = 0; i < this.probes.length; i++) {
      const key = `uProbeMap${i}`;
      if (!this.uniforms[key]) this.uniforms[key] = { value: null };
      this.uniforms[key].value = this.probes[i].pmrem?.texture || null;
    }
  }

  /* ───────────────────────────────────────────────────────────────── capture */

  /**
   * Advance the capture scheduler by one frame. Must be called *after* the main scene
   * render so the shadow maps and the sky are already current.
   * @returns {boolean} true when a probe finished and the shader needs the new texture
   */
  tick(renderer, scene) {
    if (this.broken || !this.enabled || !this.probes.length || !renderer || !scene) return false;
    this._frame++;

    const probe = this.probes[this._cursor];
    if (!probe) return false;

    // Once everything is captured, only refresh on the slow cadence.
    const idle = this.active >= this.probes.length && this._refreshRemaining <= 0;
    if (idle && this._face === 0 && this._frame % this.refreshInterval !== 0) return false;

    let published = false;
    try {
      published = this._renderFace(renderer, scene, probe);
    } catch (err) {
      this._warn('probe capture failed', err);
      this.broken = true;
      return false;
    }
    return published;
  }

  _renderFace(renderer, scene, probe) {
    const cam = this._cubeCam;
    if (!cam) return false;

    // The six face cameras are only oriented by updateCoordinateSystem(); CubeCamera
    // normally does that inside update(), which we bypass to spread the cost out.
    if (cam.coordinateSystem !== renderer.coordinateSystem) {
      cam.coordinateSystem = renderer.coordinateSystem;
      cam.updateCoordinateSystem();
    }

    cam.position.copy(probe.position);
    cam.updateMatrixWorld(true);

    const faceCam = cam.children[this._face];
    if (!faceCam) {
      this._face = 0;
      return false;
    }

    // The sky dome is a unit box pinned to the camera; from a probe 30 m away it would
    // subtend almost nothing and the capture would come back with a black sky. Park it
    // on the probe for the duration of the face. Sky rewrites this every lateUpdate.
    const dome = this._findSky(scene);
    if (dome) {
      this._domePos = this._domePos || new THREE.Vector3();
      this._domePos.copy(dome.position);
      dome.position.copy(probe.position);
      dome.updateMatrixWorld(true);
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    // Shadow maps were rendered for the main pass this frame; re-rendering them six
    // more times would multiply the frame cost of the whole level.
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    try {
      renderer.setRenderTarget(probe.rt, this._face);
      renderer.clear();
      renderer.render(scene, faceCam);
    } finally {
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
      if (dome) {
        dome.position.copy(this._domePos);
        dome.updateMatrixWorld(true);
      }
    }

    this._face++;
    if (this._face < 6) return false;
    this._face = 0;

    // All six faces are in: prefilter into the roughness chain.
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);
    const rt = this._pmrem.fromCubemap(probe.rt.texture, probe.pmrem || undefined);
    probe.pmrem = rt;
    rt.texture.name = `probe.pmrem`;

    if (!probe.captured) {
      probe.captured = true;
      this.active++;
    }
    if (this._refreshRemaining > 0) this._refreshRemaining--;
    this._syncUniformArrays();
    // Announce the probe only once it has real content in it.
    this.uniforms.uProbePos.value[this._cursor].w = 1;

    this._cursor = (this._cursor + 1) % this.probes.length;
    return true;
  }

  /**
   * **Move the first probe onto the viewer.**
   *
   * The auto-placed grid sits at the centre of the level, so most of the frame — and
   * all of the near field, which is where a grazing view of the ground makes the
   * environment reflection the *dominant* term on a dark surface — falls outside every
   * probe's influence and reflects the raw sky cube instead. Standing in a 16 m canyon
   * that means the asphalt two metres from the lens mirrors open blue sky in directions
   * that are solid ochre masonry: the specular twin of the skyline bug the irradiance
   * SH now measures its way out of, and a large part of why the hero foreground reads
   * cold however warm the diffuse gets.
   *
   * Deliberately an in-place edit, not a `build()`: rebuilding drops `active` to zero,
   * which flips `ready`, which changes Lighting's shader key and recompiles every
   * material in the scene — tens of seconds on the software rasteriser. The old capture
   * stays bound and live until the new one lands.
   *
   * @param {THREE.Vector3} position
   * @param {THREE.Vector3} half half-extents of the box the probe is authoritative over
   * @returns {boolean} true when the probe actually moved
   */
  anchor(position, half) {
    const p = this.probes[0];
    if (!p || !position) return false;
    // Hysteresis: re-capturing six faces every time the player takes a step would cost
    // more than the reflection is worth.
    if (p.captured && p.position.distanceToSquared(position) < 25) return false;
    p.position.copy(position);
    p.min.copy(position).sub(half);
    p.max.copy(position).add(half);
    p.feather = Math.min(half.x, half.z) * 0.35;
    this._syncUniformArrays();
    if (p.captured) this.uniforms.uProbePos.value[0].w = 1;
    this._refreshRemaining = Math.max(this._refreshRemaining, 1);
    this._cursor = 0;
    this._face = 0;
    return true;
  }

  /**
   * Re-capture every probe as soon as possible while leaving the existing textures
   * live. Dropping them instead would flip `ready` to false, which changes the shader
   * key and forces a full material recompile — several seconds on a software
   * rasteriser, every single time the time of day moves.
   */
  refresh() {
    this._refreshRemaining = this.probes.length;
    this._cursor = 0;
    this._face = 0;
  }

  _findSky(scene) {
    if (this._dome && this._dome.parent) return this._dome;
    // Not found yet: retry occasionally rather than traversing on every face.
    if (this._domeSearch !== undefined && this._frame - this._domeSearch < 60) return null;
    this._domeSearch = this._frame;
    this._dome = null;
    scene.traverse((o) => {
      if (!this._dome && o.userData?.sky) this._dome = o;
    });
    return this._dome;
  }

  /**
   * The PMREM layout must line up with `scene.environment`, or `textureCubeUV()` reads
   * the wrong mips. Called by Lighting before it enables the probe path.
   */
  matchesEnvironment(envTexture) {
    if (!envTexture?.image) return true;
    const h = envTexture.image.height;
    for (const p of this.probes) {
      if (!p.pmrem) continue;
      if (p.pmrem.texture?.image?.height !== h && p.pmrem.height !== h) return false;
    }
    return true;
  }

  /** Hard reset: drops every capture. Use `refresh()` unless the placements changed. */
  invalidate() {
    for (const p of this.probes) p.captured = false;
    this.active = 0;
    this._cursor = 0;
    this._face = 0;
    this._refreshRemaining = 0;
    for (const v of this.uniforms.uProbePos.value) v.w = 0;
  }

  /* ─────────────────────────────────────────────────────────────────── GLSL */

  /** True when there is at least one captured probe worth sampling. */
  get ready() {
    return !this.broken && this.enabled && this.active > 0;
  }

  parsGLSL() {
    const n = this.probes.length;
    if (!n) return '';
    let maps = '';
    for (let i = 0; i < n; i++) maps += `uniform sampler2D uProbeMap${i};\n`;

    let blend = '';
    for (let i = 0; i < n; i++) {
      blend += `
	{
		vec4 pp = uProbePos[ ${i} ];
		vec3 bmin = uProbeMin[ ${i} ].xyz;
		vec3 bmax = uProbeMax[ ${i} ].xyz;
		float w = pp.w * codProbeWeight( worldPos, bmin, bmax, uProbeMin[ ${i} ].w, pp.xyz );
		if ( w > 0.0001 ) {
			vec3 d = codBoxProject( worldRefl, worldPos, bmin, bmax, pp.xyz );
			acc += textureCubeUV( uProbeMap${i}, d, roughness ).rgb * ( w * uProbeMax[ ${i} ].w );
			wsum += w;
		}
	}
`;
    }

    return `
// ── local reflection probes (box projected) ──────────────────────────────────
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
#define COD_PROBES 1

uniform vec4 uProbePos[ ${n} ];   // xyz centre, w enabled
uniform vec4 uProbeMin[ ${n} ];   // xyz box min, w feather (m)
uniform vec4 uProbeMax[ ${n} ];   // xyz box max, w intensity
${maps}
/**
 * Falloff towards the box faces so neighbouring probes cross-fade instead of popping,
 * *and* away from the capture point.
 *
 * The second half matters more than it looks. Containment alone gives every point in
 * a 45 m auto-placed box a weight of 1, so a cube shot from the middle of the open
 * street completely replaces the sky IBL on surfaces inside a closed room thirty
 * metres away — and because box projection only re-aims the direction and knows
 * nothing about occlusion, two walls of the same 8 m room end up sampling two
 * unrelated parts of an outdoor capture. That is the "cold wall, warm ceiling, no
 * motivating source" artefact: it is not a lighting decision, it is a probe reaching
 * somewhere it has no information about. Fading with distance from the capture point,
 * normalised to the probe's own half-extent, keeps the probe authoritative where it
 * was measured and hands the rest back to the sky environment.
 */
float codProbeWeight( vec3 p, vec3 bmin, vec3 bmax, float feather, vec3 origin ) {
	vec3 d = min( p - bmin, bmax - p );
	float m = min( min( d.x, d.y ), d.z );
	float box = clamp( m / max( feather, 0.05 ), 0.0, 1.0 );
	vec3 halfExtent = max( ( bmax - bmin ) * 0.5, vec3( 0.5 ) );
	float rel = length( ( p - origin ) / halfExtent );
	return box * ( 1.0 - smoothstep( 0.3, 0.95, rel ) );
}

/** Intersect the reflection ray with the probe volume and re-aim it at the capture point. */
vec3 codBoxProject( vec3 dir, vec3 p, vec3 bmin, vec3 bmax, vec3 origin ) {
	vec3 sgn = mix( vec3( 1.0 ), vec3( -1.0 ), lessThan( dir, vec3( 0.0 ) ) );
	vec3 inv = 1.0 / ( sgn * max( abs( dir ), vec3( 1e-5 ) ) );
	vec3 t1 = ( bmax - p ) * inv;
	vec3 t2 = ( bmin - p ) * inv;
	vec3 tmax = max( t1, t2 );
	float t = min( min( tmax.x, tmax.y ), tmax.z );
	if ( t <= 0.0 ) return dir;
	return ( p + dir * t ) - origin;
}

vec3 codProbeRadiance( vec3 worldPos, vec3 worldRefl, float roughness, vec3 fallback ) {
	vec3 acc = vec3( 0.0 );
	float wsum = 0.0;
${blend}
	if ( wsum <= 0.0001 ) return fallback;
	return mix( fallback, acc / wsum, clamp( wsum, 0.0, 1.0 ) );
}

#endif
`;
  }

  _warn(msg, err) {
    if (this._warned) return;
    this._warned = true;
    console.warn(`[probes] ${msg}`, err || '');
  }

  dispose(full = true) {
    for (const p of this.probes) {
      p.rt?.dispose?.();
      p.pmrem?.dispose?.();
    }
    this.probes.length = 0;
    this.active = 0;
    this.uniforms.uProbePos.value = [];
    this.uniforms.uProbeMin.value = [];
    this.uniforms.uProbeMax.value = [];
    for (const k of Object.keys(this.uniforms)) {
      if (k.startsWith('uProbeMap')) this.uniforms[k].value = null;
    }
    if (full) {
      this._pmrem?.dispose?.();
      this._pmrem = null;
      this._cubeCam = null;
    }
  }
}

export default ProbeSystem;
