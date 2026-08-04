/**
 * Lighting — the whole light rig: sun + CSM, IBL, reflection probes, local lights and
 * screen-space contact shadows.
 * Owner: lighting agent. Files owned: this file, render/CSM.js, render/ProbeSystem.js.
 * Publishes: `ctx.lighting`.
 *
 * ── Design ──────────────────────────────────────────────────────────────────────
 * There is deliberately **no AmbientLight and no HemisphereLight anywhere**. A flat
 * ambient term is the single fastest way to make a render look like a render: it lifts
 * shadow interiors by a constant, kills the colour separation between sky-lit and
 * sun-lit surfaces and flattens every normal map. Instead all indirect light comes from
 * an image-based environment:
 *
 *   • diffuse  — an L2 irradiance SH, projected on the CPU from `ctx.sky.sampleSky()`
 *                (the same scattering model the sky dome renders) plus a one-bounce
 *                ground term. Shadowed faces therefore pick up sky blue, up-facing
 *                faces pick up the zenith and down-facing faces pick up warm ground
 *                bounce — for free, and with no ringing.
 *   • specular — the sky's PMREM roughness chain on `scene.environment`, overridden
 *                locally by box-projected reflection probes (see ProbeSystem.js).
 *
 * The sun is a real CSM (see CSM.js) with PCSS contact hardening, and a short
 * depth-buffer ray march adds the small-scale occlusion the cascades are far too coarse
 * to resolve — the dark line where a crate actually meets the floor.
 *
 * ── How it reaches other people's materials ─────────────────────────────────────
 * Cascade selection, SH irradiance, probe blending and contact shadows all have to
 * happen inside the standard material shader. We do that by chaining
 * `material.onBeforeCompile` on every `MeshStandardMaterial` we find in the scene and
 * swapping three's `lights_fragment_begin` / `lights_fragment_maps` chunks for patched
 * copies. Nothing is written to another module's *files*; materials created later are
 * picked up by a periodic scan. Every injection is guarded, and a material we never
 * reach still renders correctly — it just sees one plain sun with a near-field shadow,
 * because only cascade 0 carries radiance.
 *
 * ── Public API (ctx.lighting) ───────────────────────────────────────────────────
 *   sun                      THREE.DirectionalLight (cascade 0 — the one with radiance)
 *   sunDirection             Vector3, world-space direction *towards* the sun
 *   envMap / envTexture      Texture currently on scene.environment
 *   irradianceSH             THREE.SphericalHarmonics3 (L2), render units
 *   ambientIrradiance(n)     -> THREE.Color, irradiance arriving at a world normal
 *   setTimeOfDay(hours)      forwards to ctx.sky, rescales sun/shadows/IBL
 *   timeOfDay                number
 *   addLight(def)            -> handle   (see LightManager.addLight for the def shape)
 *   removeLight(handle)
 *   kelvin(K, target?)       -> THREE.Color, Planckian locus, luminance-normalised
 *   setShadowsEnabled(bool) / setContactShadows(bool) / setProbesEnabled(bool)
 *   setExposureCompensation(f)
 *   refreshProbes()
 *   csm / probes / lights    the subsystems, for tools
 *   contactShadow            { texture, uniforms, render() } for the pipeline to consume
 *   stats                    { cascades, probes, activeLights, shadowLights }
 *   ready                    boolean
 *
 * ── Events ──────────────────────────────────────────────────────────────────────
 *   emits  `lighting:ready` {envTexture, sh, sun}    once the IBL is usable
 *   emits  `lighting:env`   {envTexture, sh}         whenever the IBL is rebuilt
 *   emits  `lighting:timeOfDay` {hours, sunIntensity, sunColor}
 *   listens `sky:env`, `sky:timeOfDay`, `quality:changed`, `setting:changed`,
 *           `debug:pose`, `level:ready`, `world:ready`, `boot:done`
 */
import * as THREE from 'three';
import { CascadedShadowMaps, SHADOW_COMMON_GLSL, glslDisc, vogelDisc } from './CSM.js';
import { ProbeSystem } from './ProbeSystem.js';

/* ═══════════════════════════════════════════════════════════════════ helpers ══ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _color = new THREE.Color();
const _mat4 = new THREE.Matrix4();

/**
 * Colour temperature -> linear sRGB, via the Planckian locus (Kim et al. cubic fit)
 * and CIE xyY -> XYZ -> Rec.709. Normalised to unit luminance so changing a lamp's
 * temperature never changes how bright it reads — which is what you want when the
 * intensity is authored separately.
 */
export function kelvinToLinearRGB(kelvin, target = new THREE.Color()) {
  const T = clamp(kelvin || 6500, 1600, 25000);
  const t2 = T * T;
  const t3 = t2 * T;
  let x;
  if (T <= 4000) {
    x = -0.2661239e9 / t3 - 0.2343589e6 / t2 + (0.8776956e3 / T) + 0.17991;
  } else {
    x = -3.0258469e9 / t3 + 2.1070379e6 / t2 + (0.2226347e3 / T) + 0.24039;
  }
  const x2 = x * x;
  const x3 = x2 * x;
  let y;
  if (T <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (T <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;

  y = Math.max(y, 1e-4);
  const Y = 1;
  const X = (x / y) * Y;
  const Z = ((1 - x - y) / y) * Y;

  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(r, 0);
  g = Math.max(g, 0);
  b = Math.max(b, 0);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = lum > 1e-5 ? 1 / lum : 1;
  return target.setRGB(r * k, g * k, b * k);
}

/** Deterministic 1-D value noise with smooth interpolation — for light flicker. */
function valueNoise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n) => {
    let v = Math.imul(n ^ seed, 0x27d4eb2d);
    v = Math.imul(v ^ (v >>> 15), 0x165667b1);
    return ((v ^ (v >>> 13)) >>> 0) / 4294967296;
  };
  const a = h(i);
  const b = h(i + 1);
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

/* ════════════════════════════════════════════════════ contact shadow pass ══ */

// language=GLSL
const CONTACT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// language=GLSL
const CONTACT_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform vec3 uSunView;
uniform vec4 uParams;   // x ray length (m), y thickness (m), z bias (m), w depth normaliser
varying vec2 vUv;

float codHash( vec2 p ) {
	return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

vec3 viewFromDepth( vec2 uv, float d ) {
	vec4 c = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
	vec4 p = uInvProj * c;
	return p.xyz / p.w;
}

/** 16 bits of linear view distance, so the consumer can reject disocclusions. */
vec2 packDist( float v ) {
	v = clamp( v, 0.0, 1.0 ) * 255.0;
	float a = floor( v );
	return vec2( a / 255.0, v - a );
}

void main() {

	float d = texture2D( tDepth, vUv ).r;
	vec3 P = viewFromDepth( vUv, d );
	float dist = - P.z;
	vec2 packed = packDist( dist / uParams.w );

	if ( d >= 0.999999 ) {
		gl_FragColor = vec4( 1.0, packed, 1.0 );
		return;
	}

	// Geometric normal straight out of the depth buffer. Launching the ray from the
	// surface *plane* rather than the surface itself is what stops a flat floor
	// shadowing itself into a speckled mess at grazing angles — the same normal-offset
	// trick the cascades use, and the reason a naive contact-shadow march looks awful.
	vec3 N = normalize( cross( dFdx( P ), dFdy( P ) ) );
	if ( dot( N, P ) > 0.0 ) N = - N;
	float ndl = dot( N, uSunView );
	// Facing away from the key light: it is already fully shadowed by N·L, and any
	// occlusion we found here would just double-darken the terminator.
	if ( ndl <= 0.05 ) {
		gl_FragColor = vec4( 1.0, packed, 1.0 );
		return;
	}

	// A short march towards the key light. This only ever adds the occlusion CSM cannot
	// resolve: a couple of decimetres, fading out along the ray so it can never
	// become a long smear that fights the cascades.
	float shadow = 1.0;
	float jitter = codHash( gl_FragCoord.xy );
	float rayLen = uParams.x * clamp( 1.0 + dist * 0.03, 1.0, 2.5 );
	vec3 stepV = uSunView * ( rayLen / float( COD_CS_STEPS ) );
	vec3 origin = P + N * ( 0.01 + dist * 0.003 );
	vec3 pos = origin + stepV * ( 0.25 + jitter * 0.75 );

	for ( int i = 0; i < COD_CS_STEPS; i ++ ) {

		vec4 clip = uProj * vec4( pos, 1.0 );
		if ( clip.w <= 0.0 ) break;
		vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
		if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;

		float sd = texture2D( tDepth, uv ).r;
		if ( sd < 0.999999 ) {
			vec3 sp = viewFromDepth( uv, sd );
			float delta = ( - sp.z ) - ( - pos.z );
			if ( delta < - uParams.z && delta > - uParams.y ) {
				float f = float( i ) / float( COD_CS_STEPS );
				shadow = min( shadow, f * f );
				break;
			}
		}
		pos += stepV;

	}

	gl_FragColor = vec4( shadow, packed, 1.0 );

}
`;

class ContactShadowPass {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this.valid = false;
    this.scale = 0.5;
    this.steps = 12;
    this.strength = 0.85;
    this.rayLength = 0.28;
    this.thickness = 0.55;
    this.bias = 0.012;
    this.normDist = 140;
    this.width = 1;
    this.height = 1;
    this.rt = null;

    this.material = new THREE.ShaderMaterial({
      name: 'lighting:contactShadows',
      defines: { COD_CS_STEPS: this.steps },
      uniforms: {
        tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Matrix4() },
        uSunView: { value: new THREE.Vector3(0, 1, 0) },
        uParams: { value: new THREE.Vector4(0.28, 0.55, 0.012, 140) },
      },
      vertexShader: CONTACT_VERT,
      fragmentShader: CONTACT_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this._scene = new THREE.Scene();
    this._scene.matrixAutoUpdate = false;
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this._quad.frustumCulled = false;
    this._quad.matrixAutoUpdate = false;
    this._scene.add(this._quad);

    /** viewProj the current buffer was captured with — the consumer reprojects into it. */
    this.captureViewProj = new THREE.Matrix4();
  }

  setQuality(tier, headless) {
    if (headless) {
      this.scale = 0.5;
      this.steps = 6;
    } else {
      switch (tier) {
        case 'low':
          this.scale = 0.5;
          this.steps = 6;
          break;
        case 'medium':
          this.scale = 0.5;
          this.steps = 10;
          break;
        case 'ultra':
          this.scale = 0.75;
          this.steps = 20;
          break;
        default:
          this.scale = 0.5;
          this.steps = 14;
          break;
      }
    }
    if (this.material.defines.COD_CS_STEPS !== this.steps) {
      this.material.defines.COD_CS_STEPS = this.steps;
      this.material.needsUpdate = true;
    }
    this.setSize(this.width, this.height);
  }

  setSize(w, h) {
    this.width = Math.max(1, Math.round(w));
    this.height = Math.max(1, Math.round(h));
    const cw = Math.max(16, Math.round(this.width * this.scale));
    const ch = Math.max(16, Math.round(this.height * this.scale));
    if (this.rt && this.rt.width === cw && this.rt.height === ch) return;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(cw, ch, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    this.rt.texture.name = 'lighting.contactShadows';
    this.valid = false;
  }

  get texture() {
    return this.rt?.texture || null;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} depthTexture scene depth for the frame that was just rendered
   * @param {THREE.PerspectiveCamera} camera the camera that depth belongs to
   * @param {THREE.Vector3} sunWorld world-space direction towards the sun
   */
  render(renderer, depthTexture, camera, sunWorld) {
    if (!this.enabled || !renderer || !depthTexture || !camera) {
      this.valid = false;
      return false;
    }
    if (!this.rt) this.setSize(this.width, this.height);

    const u = this.material.uniforms;
    u.tDepth.value = depthTexture;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uInvProj.value.copy(camera.projectionMatrix).invert();
    _dir.copy(sunWorld).transformDirection(camera.matrixWorldInverse).normalize();
    u.uSunView.value.copy(_dir);
    this.normDist = Math.min(camera.far, 300);
    u.uParams.value.set(this.rayLength, this.thickness, this.bias, this.normDist);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(this.rt);
      renderer.render(this._scene, this._camera);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }

    this.captureViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.valid = true;
    return true;
  }

  dispose() {
    this.rt?.dispose();
    this.rt = null;
    this.material.dispose();
    this._quad.geometry.dispose();
  }
}

/* ═══════════════════════════════════════════════════════════ local lights ══ */

const POOL_TIERS = {
  low: { points: 4, spots: 2, shadowSpots: 0 },
  medium: { points: 6, spots: 3, shadowSpots: 1 },
  high: { points: 8, spots: 4, shadowSpots: 2 },
  ultra: { points: 12, spots: 6, shadowSpots: 3 },
};

/** Radially symmetric beam profiles, projected through the spot cone like a gobo. */
const SPOT_PROFILES = {
  soft: (r) => Math.pow(clamp01(1 - r), 1.1),
  wide: (r) => clamp01(1 - Math.pow(r, 3.5)),
  narrow: (r) => Math.pow(clamp01(1 - r), 3.4) * 0.85 + Math.pow(clamp01(1 - r * 3), 2) * 0.6,
  // A cheap PAR-can look: bright core, visible shoulder, faint spill ring.
  par: (r) =>
    clamp01(Math.pow(clamp01(1 - r * 1.15), 1.6) + 0.16 * Math.exp(-Math.pow((r - 0.72) * 7, 2))),
  flashlight: (r) =>
    clamp01(Math.pow(clamp01(1 - r * 1.05), 2.2) * 1.15 + 0.1 * clamp01(1 - r * 1.6)),
};

class LightManager {
  constructor(ctx, lighting) {
    this.ctx = ctx;
    this.lighting = lighting;
    this.group = new THREE.Group();
    this.group.name = 'lighting.local';
    this.group.matrixAutoUpdate = false;

    /** @type {Array<object>} live light requests */
    this.requests = [];
    this._nextId = 1;

    this.pointPool = [];
    this.spotPool = [];
    this.shadowSpotCount = 0;
    this.limits = { points: 0, spots: 0, shadowSpots: 0 };
    this.target = { points: 8, spots: 4, shadowSpots: 2 };

    this.profiles = {};
    this.shadowResolution = 1024;
    this._assignTimer = 0;
    this._seed = 0;
  }

  setQuality(tier, headless) {
    const t = POOL_TIERS[tier] || POOL_TIERS.high;
    this.target = headless
      ? { points: Math.min(t.points, 4), spots: Math.min(t.spots, 2), shadowSpots: 0 }
      : { ...t };
    this.shadowResolution = headless ? 512 : tier === 'ultra' ? 1024 : 768;
    // Never shrink an existing pool: that would recompile every material mid-game.
    this.limits.points = Math.min(this.limits.points, this.target.points);
    this.limits.spots = Math.min(this.limits.spots, this.target.spots);
  }

  _profile(name) {
    const key = SPOT_PROFILES[name] ? name : 'soft';
    if (this.profiles[key]) return this.profiles[key];
    const size = 96;
    const data = new Uint8Array(size * size * 4);
    const fn = SPOT_PROFILES[key];
    let i = 0;
    for (let y = 0; y < size; y++) {
      const fy = (y + 0.5) / size * 2 - 1;
      for (let x = 0; x < size; x++) {
        const fx = (x + 0.5) / size * 2 - 1;
        const r = Math.sqrt(fx * fx + fy * fy);
        const v = clamp01(fn(r)) * 255;
        data[i++] = v;
        data[i++] = v;
        data[i++] = v;
        data[i++] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.name = `lighting.iesProfile.${key}`;
    tex.colorSpace = THREE.NoColorSpace; // the shader multiplies it in linearly
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    this.profiles[key] = tex;
    return tex;
  }

  /** Grow the pools to cover `need`, rounded up to a bucket so recompiles are rare. */
  _ensure(needPoints, needSpots) {
    let grew = false;
    const bucket = (n, step) => Math.min(Math.ceil(n / step) * step, 64);

    const wantPoints = Math.min(bucket(needPoints, 2), this.target.points);
    while (this.limits.points < wantPoints) {
      const l = new THREE.PointLight(0xffffff, 0, 12, 2);
      l.name = `local.point${this.pointPool.length}`;
      l.castShadow = false;
      this.group.add(l);
      this.pointPool.push(l);
      this.limits.points++;
      grew = true;
    }

    const wantSpots = Math.min(bucket(needSpots, 1), this.target.spots);
    while (this.limits.spots < wantSpots) {
      const idx = this.spotPool.length;
      const l = new THREE.SpotLight(0xffffff, 0, 20, 0.6, 0.45, 2);
      l.name = `local.spot${idx}`;
      // A fixed prefix of the pool casts shadows so three's light ordering — which puts
      // shadow casters first — never shuffles under us.
      l.castShadow = idx < this.target.shadowSpots;
      if (l.castShadow) {
        l.shadow.mapSize.set(this.shadowResolution, this.shadowResolution);
        l.shadow.bias = -0.0008;
        l.shadow.normalBias = 0.03;
        l.shadow.camera.near = 0.1;
        l.shadow.camera.far = 40;
        this.shadowSpotCount++;
      }
      // Every pooled spot owns a profile texture from birth, again for stable ordering.
      l.map = this._profile('soft');
      l.target.name = `${l.name}.target`;
      this.group.add(l);
      this.group.add(l.target);
      this.spotPool.push(l);
      this.limits.spots++;
      grew = true;
    }
    return grew;
  }

  /**
   * @param {{type?:'point'|'spot', position?:number[]|THREE.Vector3, direction?:number[]|THREE.Vector3,
   *          target?:number[]|THREE.Vector3, color?:number|string|THREE.Color, kelvin?:number,
   *          intensity?:number, radius?:number, angle?:number, penumbra?:number,
   *          castShadow?:boolean, profile?:string, priority?:number,
   *          flicker?:{amount?:number, speed?:number}, pulse?:{amount?:number, speed?:number, phase?:number},
   *          enabled?:boolean}} def
   * @returns {object} handle — mutate `handle.position` / `handle.intensity` freely
   */
  addLight(def = {}) {
    const rng = this.ctx.rng;
    const seed = ((rng ? rng() : 0.5) * 0xffffffff) >>> 0;
    const handle = {
      id: this._nextId++,
      type: def.type === 'spot' ? 'spot' : 'point',
      position: new THREE.Vector3(),
      target: new THREE.Vector3(0, -1, 0),
      color: new THREE.Color(1, 1, 1),
      intensity: Number.isFinite(def.intensity) ? def.intensity : 18,
      radius: Number.isFinite(def.radius) ? def.radius : 10,
      angle: Number.isFinite(def.angle) ? def.angle : 0.6,
      penumbra: Number.isFinite(def.penumbra) ? def.penumbra : 0.42,
      castShadow: !!def.castShadow,
      profile: def.profile || (def.type === 'spot' ? 'par' : 'soft'),
      priority: Number.isFinite(def.priority) ? def.priority : 1,
      flicker: def.flicker || null,
      pulse: def.pulse || null,
      enabled: def.enabled !== false,
      seed,
      _slot: null,
      _mod: 1,
      _score: 0,
      remove: () => this.removeLight(handle),
    };

    if (def.position) {
      if (Array.isArray(def.position)) handle.position.fromArray(def.position);
      else handle.position.copy(def.position);
    }
    if (def.target) {
      if (Array.isArray(def.target)) handle.target.fromArray(def.target);
      else handle.target.copy(def.target);
    } else if (def.direction) {
      const d = Array.isArray(def.direction)
        ? _v3.fromArray(def.direction)
        : _v3.copy(def.direction);
      handle.target.copy(handle.position).add(d.normalize().multiplyScalar(6));
    } else {
      handle.target.copy(handle.position).add(new THREE.Vector3(0, -3, 0));
    }
    if (Number.isFinite(def.kelvin)) kelvinToLinearRGB(def.kelvin, handle.color);
    else if (def.color !== undefined) handle.color.set(def.color);

    this.requests.push(handle);
    return handle;
  }

  removeLight(handle) {
    if (!handle) return false;
    const i = this.requests.indexOf(handle);
    if (i < 0) return false;
    this.requests.splice(i, 1);
    if (handle._slot) {
      handle._slot.intensity = 0;
      handle._slot = null;
    }
    return true;
  }

  clear() {
    for (const r of this.requests) if (r._slot) r._slot.intensity = 0;
    this.requests.length = 0;
  }

  /** @param {number} dt @param {THREE.Vector3} viewer @param {number} exposure */
  update(dt, viewer, exposure) {
    const t = this.ctx.time?.elapsed ?? 0;

    // Flicker / pulse first: it feeds the importance score, so a light that has just
    // guttered out does not hold on to a shadow slot.
    for (const r of this.requests) {
      let mod = 1;
      if (r.pulse) {
        const sp = r.pulse.speed ?? 1;
        const am = r.pulse.amount ?? 0.25;
        mod *= 1 - am + am * (0.5 + 0.5 * Math.sin(t * sp * 6.2831853 + (r.pulse.phase ?? 0)));
      }
      if (r.flicker) {
        const sp = r.flicker.speed ?? 9;
        const am = r.flicker.amount ?? 0.18;
        // Two octaves: a slow wander plus a fast twitch reads like a bad ballast.
        const n =
          0.65 * valueNoise1(t * sp, r.seed) + 0.35 * valueNoise1(t * sp * 3.7 + 11.3, r.seed ^ 0x9e37);
        mod *= 1 - am + am * n * 2;
      }
      r._mod = Math.max(0, mod);
      const d2 = viewer ? Math.max(r.position.distanceToSquared(viewer), 0.25) : 1;
      // Screen-space importance: radiant power over distance squared.
      r._score = (r.intensity * r._mod * r.priority * (r.radius * r.radius)) / d2;
      if (!r.enabled) r._score = -1;
    }

    const active = this.requests.filter((r) => r.enabled && r._mod > 0.001 && r.intensity > 0);
    active.sort((a, b) => b._score - a._score);

    const needPoints = active.filter((r) => r.type === 'point').length;
    const needSpots = active.filter((r) => r.type === 'spot').length;
    this._ensure(needPoints, needSpots);

    // Shadow slots are the scarce resource: hand them to the highest scoring casters.
    const shadowCap = Math.min(this.shadowSpotCount, this.target.shadowSpots);
    const wantShadow = active.filter((r) => r.type === 'spot' && r.castShadow).slice(0, shadowCap);
    const shadowSet = new Set(wantShadow);

    for (const l of this.pointPool) l.intensity = 0;
    for (const l of this.spotPool) l.intensity = 0;
    for (const r of this.requests) r._slot = null;

    let pi = 0;
    let sh = 0;
    const usedSpot = new Set();

    const bindSpot = (r, l) => {
      r._slot = l;
      l.position.copy(r.position);
      l.target.position.copy(r.target);
      l.color.copy(r.color);
      l.distance = r.radius;
      l.decay = 2;
      l.angle = clamp(r.angle, 0.02, Math.PI / 2 - 0.01);
      l.penumbra = clamp01(r.penumbra);
      l.intensity = r.intensity * r._mod * exposure;
      const prof = this._profile(r.profile);
      if (l.map !== prof) l.map = prof;
    };

    for (const r of active) {
      if (r.type !== 'point') continue;
      const l = this.pointPool[pi];
      if (!l) continue;
      pi++;
      r._slot = l;
      l.position.copy(r.position);
      l.color.copy(r.color);
      l.distance = r.radius;
      l.decay = 2;
      l.intensity = r.intensity * r._mod * exposure;
    }

    // Shadow-casting spots claim the shadow-capable prefix of the pool first…
    for (const r of active) {
      if (r.type !== 'spot' || !shadowSet.has(r) || sh >= shadowCap) continue;
      for (let k = 0; k < this.spotPool.length; k++) {
        const l = this.spotPool[k];
        if (usedSpot.has(k) || !l.castShadow) continue;
        usedSpot.add(k);
        bindSpot(r, l);
        sh++;
        break;
      }
    }
    // …then everyone else takes whatever is left, walking from the back so a spare
    // shadow slot stays available for the next frame's most important caster.
    for (const r of active) {
      if (r.type !== 'spot' || r._slot) continue;
      for (let k = this.spotPool.length - 1; k >= 0; k--) {
        if (usedSpot.has(k)) continue;
        usedSpot.add(k);
        bindSpot(r, this.spotPool[k]);
        break;
      }
    }

    this.activeCount = active.length;
    this.shadowCount = sh;
  }

  attach(scene) {
    if (scene && this.group.parent !== scene) scene.add(this.group);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const l of this.pointPool) l.dispose?.();
    for (const l of this.spotPool) {
      l.shadow?.map?.depthTexture?.dispose?.();
      l.shadow?.map?.dispose?.();
      l.dispose?.();
    }
    for (const k of Object.keys(this.profiles)) this.profiles[k].dispose();
    this.profiles = {};
    this.pointPool.length = 0;
    this.spotPool.length = 0;
    this.requests.length = 0;
  }
}

/* ═══════════════════════════════════════════════════════════════ Lighting ══ */

/** Direction grid for the CPU SH projection. Fixed, so the result is reproducible. */
const SH_PHI = 24;
const SH_THETA = 12;

class Lighting {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = false;
    this.broken = false;
    this.disposed = false;

    this.headless = !!ctx.settings?.get?.('headless');
    this.tier = ctx.settings?.tier || 'high';
    this.timeOfDay = 7.4;

    this.csm = new CascadedShadowMaps(ctx, {
      cascades: ctx.settings?.get?.('shadowCascades') ?? 4,
      resolution: ctx.settings?.get?.('shadowResolution') ?? 2048,
    });
    this.probes = new ProbeSystem(ctx, {
      max: 4,
      cubeSize: this.headless ? 48 : 64,
      refreshInterval: this.headless ? 600 : 300,
    });
    this.lights = new LightManager(ctx, this);
    this.contact = new ContactShadowPass(ctx);

    /** Filmic exaggeration of the solar disc: the real 0.0047 rad is almost hard. */
    this.softnessScale = 4.2;
    this.shadowsEnabled = ctx.settings?.get?.('shadows') !== false;
    this.probesEnabled = true;
    this.exposureCompensation = 1;
    this.localLightScale = 1;

    this.sunDirection = new THREE.Vector3(0.35, 0.72, 0.6).normalize();
    this.sunColor = new THREE.Color(1, 0.94, 0.86);
    this.sunIntensity = 8;

    this.sh = new THREE.SphericalHarmonics3();
    this.envTexture = null;
    this._fallbackEnvRT = null;
    this._fallbackPmrem = null;

    /* Shared uniform objects — one instance referenced by every patched material, so a
       single write per frame updates the whole scene. */
    this.uniforms = {
      ...this.csm.uniforms,
      ...this.probes.uniforms,
      uCodSH: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
      uCodInvView: { value: new THREE.Matrix4() },
      uCodContactMap: { value: null },
      uCodContactMtx: { value: new THREE.Matrix4() },
      uCodContactParams: { value: new THREE.Vector4(0, 140, 0, 0) },
    };

    this._patched = new WeakSet();
    /** @type {Set<THREE.Material>} materials we have patched and may need to recompile */
    this._materials = new Set();
    this._glslCache = null;
    this._shaderKey = '';
    this._shaderVersion = 0;
    this._scanFrame = -999;
    this._fitFrame = -1;
    this._envDirty = true;
    this._envTimer = 0;
    this._shValid = false;
    this._probeCount = 0;
    this._unsub = [];
    this._warned = new Set();
    this._afterRenderBound = () => this._afterRender();
    this._sceneHooks = [];
    this._shDirs = null;
    this._shCache = null;
  }

  /* ─────────────────────────────────────────────────────────────────── init */

  init() {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    if (!renderer) throw new Error('no renderer');

    // Raw depth in the shadow maps: three's PCF path binds sampler2DShadow, which can
    // only answer comparisons and makes the PCSS blocker search impossible.
    renderer.shadowMap.enabled = this.shadowsEnabled;
    renderer.shadowMap.type = THREE.BasicShadowMap;
    renderer.shadowMap.autoUpdate = true;

    this.setQuality(this.tier, false);

    this.csm.attach(ctx.scene);
    this.lights.attach(ctx.scene);

    this._hookScene(ctx.scene);
    this._hookScene(ctx.viewScene);

    this._syncFromSky(true);
    this._rebuildIBL(true);
    this._bind();

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.contact.setSize(size.x || 1280, size.y || 720);

    // Probes need geometry to capture, and the level has not loaded yet at order 24.
    this._probeCount = clamp(ctx.settings?.get?.('reflectionProbes') ?? 2, 0, 4);
    this._probeBuildPending = true;

    ctx.engine?.onNextFrame?.(this._afterRenderBound);

    this.ready = true;
    ctx.bus?.emit?.('lighting:ready', {
      envTexture: this.envTexture,
      sh: this.sh,
      sun: this.csm.lights[0] || null,
    });
  }

  _bind() {
    const bus = this.ctx.bus;
    if (!bus?.on) return;
    const on = (ev, fn) => {
      const off = bus.on(ev, fn);
      if (typeof off === 'function') this._unsub.push(off);
    };
    on('sky:env', () => {
      this._envDirty = true;
    });
    on('sky:timeOfDay', (e) => {
      if (e && Number.isFinite(e.hours)) this.timeOfDay = e.hours;
      this._syncFromSky(false);
      this._envDirty = true;
    });
    on('quality:changed', ({ tier }) => {
      try {
        this.setQuality(tier, true);
      } catch (err) {
        this._warn('quality', 'quality change failed', err);
      }
    });
    on('setting:changed', ({ key, value }) => {
      try {
        if (key === 'shadowCascades') this._applyCascades(value);
        else if (key === 'shadowResolution') this.csm.setResolution(value);
        else if (key === 'shadows') this.setShadowsEnabled(!!value);
        else if (key === 'contactShadows') this.setContactShadows(!!value);
        else if (key === 'reflectionProbes') this.refreshProbes(value);
      } catch (err) {
        this._warn('setting', 'setting change failed', err);
      }
    });
    on('debug:pose', () => {
      // A pose jump invalidates the contact buffer and every probe capture assumption.
      this.contact.valid = false;
      this._scanFrame = -999;
    });
    const rescan = () => {
      this._scanFrame = -999;
      this._probeBuildPending = true;
    };
    on('boot:done', rescan);
    on('level:ready', rescan);
    on('world:ready', rescan);
    on('props:ready', rescan);
    on('materials:changed', rescan);
  }

  /**
   * Grab the exact camera three is about to render with. `scene.onBeforeRender` runs
   * before `projectObject` and before the shadow pass, so a cascade fit done here is
   * the one the shadow maps are rendered against — no frame of latency, which matters
   * because the player controller moves the camera after our lateUpdate().
   */
  _hookScene(scene) {
    if (!scene || scene.__codLightingHook) return;
    const prev = scene.onBeforeRender;
    const self = this;
    scene.onBeforeRender = function (renderer, sc, camera, target) {
      if (typeof prev === 'function') {
        try {
          prev.call(this, renderer, sc, camera, target);
        } catch (err) {
          self._warn('hook', 'previous scene.onBeforeRender threw', err);
        }
      }
      try {
        self._onBeforeSceneRender(camera, sc);
      } catch (err) {
        self._warn('hook', 'lighting scene hook failed', err);
      }
    };
    scene.__codLightingHook = true;
    this._sceneHooks.push({ scene, prev });
  }

  _onBeforeSceneRender(camera, scene) {
    if (this.broken || !camera) return;
    const u = this.uniforms;
    u.uCodInvView.value.copy(camera.matrixWorld);
    if (this.contact.valid) {
      u.uCodContactMtx.value.multiplyMatrices(this.contact.captureViewProj, camera.matrixWorld);
    }

    // Fit once per engine frame, and only for the real world camera: the probe cube
    // cameras must not re-aim the cascades the shadow maps were rendered for.
    const frame = this.ctx.time?.frame ?? 0;
    if (scene === this.ctx.scene && camera === this.ctx.camera && this._fitFrame !== frame) {
      this._fitFrame = frame;
      this.csm.update(camera);
      // One shadow-map render per frame, however many times the pipeline re-renders
      // the scene for velocity / g-buffer / probes.
      for (const light of this.csm.lights) {
        if (light.shadow.autoUpdate) {
          light.shadow.autoUpdate = false;
          light.shadow.needsUpdate = true;
        }
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────── quality */

  setQuality(tier, rescan = true) {
    const s = this.ctx.settings;
    this.tier = tier || s?.tier || 'high';
    this.headless = !!s?.get?.('headless');

    let res = s?.get?.('shadowResolution') ?? 2048;
    if (this.headless) res = Math.min(res, 1024);
    const cascades = clamp(s?.get?.('shadowCascades') ?? 4, 1, 4);

    let dirty = false;
    dirty = this.csm.setCascadeCount(this.headless ? Math.min(cascades, 3) : cascades) || dirty;
    this.csm.setResolution(res);
    dirty = this.csm.setQuality(this.tier, this.headless) || dirty;
    // setCascadeCount rebuilds the uniform arrays, so re-point the shared references.
    this.uniforms.uCsmSplits = this.csm.uniforms.uCsmSplits;
    this.uniforms.uCsmParams = this.csm.uniforms.uCsmParams;
    this.uniforms.uCsmControl = this.csm.uniforms.uCsmControl;

    this.contact.enabled = (s?.get?.('contactShadows') ?? true) && !!this.shadowsEnabled;
    this.contact.setQuality(this.tier, this.headless);

    this.lights.setQuality(this.tier, this.headless);

    const probeCount = clamp(s?.get?.('reflectionProbes') ?? 2, 0, 4);
    if (probeCount !== this._probeCount) {
      this._probeCount = probeCount;
      this._probeBuildPending = true;
    }

    if (rescan) {
      this._scanFrame = -999;
      if (dirty) this._invalidateShaders();
    }
  }

  _applyCascades(n) {
    if (this.csm.setCascadeCount(this.headless ? Math.min(n, 3) : n)) {
      this.uniforms.uCsmSplits = this.csm.uniforms.uCsmSplits;
      this.uniforms.uCsmParams = this.csm.uniforms.uCsmParams;
      this.uniforms.uCsmControl = this.csm.uniforms.uCsmControl;
      this._invalidateShaders();
    }
  }

  setShadowsEnabled(on) {
    this.shadowsEnabled = !!on;
    this.csm.enabled = this.shadowsEnabled;
    if (this.ctx.renderer) this.ctx.renderer.shadowMap.enabled = this.shadowsEnabled;
    this.contact.enabled = this.shadowsEnabled && (this.ctx.settings?.get?.('contactShadows') ?? true);
  }

  setContactShadows(on) {
    this.contact.enabled = !!on && this.shadowsEnabled;
    if (!this.contact.enabled) this.contact.valid = false;
  }

  setProbesEnabled(on) {
    this.probesEnabled = !!on;
    this.probes.enabled = this.probesEnabled;
  }

  setExposureCompensation(f) {
    this.exposureCompensation = Number.isFinite(f) ? Math.max(0, f) : 1;
  }

  /* ──────────────────────────────────────────────────────────── time of day */

  setTimeOfDay(hours) {
    if (!Number.isFinite(hours)) return;
    this.timeOfDay = ((hours % 24) + 24) % 24;
    try {
      this.ctx.sky?.setTimeOfDay?.(this.timeOfDay);
    } catch (err) {
      this._warn('sky', 'sky.setTimeOfDay failed', err);
    }
    this._syncFromSky(true);
    this._rebuildIBL(true);
    this.contact.valid = false;
    // refresh(), not invalidate(): keeping the old captures live avoids a full
    // material recompile every time a pose changes the hour.
    this.probes.refresh();
    this.ctx.bus?.emit?.('lighting:timeOfDay', {
      hours: this.timeOfDay,
      sunIntensity: this.sunIntensity,
      sunColor: this.sunColor,
    });
  }

  /**
   * Pull the key light out of the sky model. The sky already returns a physically
   * scaled intensity (its own exposure adaptation included), so noon and dusk differ
   * by the right *ratio* and the pipeline's auto-exposure does the rest.
   */
  _syncFromSky(force) {
    const sky = this.ctx.sky;
    if (sky && (sky.keyDirection || sky.sunDirection)) {
      _dir.copy(sky.keyDirection || sky.sunDirection);
      const col = sky.keyColor || sky.sunColor || _color.setRGB(1, 0.95, 0.88);
      const inten = Number.isFinite(sky.keyIntensity)
        ? sky.keyIntensity
        : Number.isFinite(sky.sunIntensity)
          ? sky.sunIntensity
          : 8;
      this.sunDirection.copy(_dir);
      this.sunColor.copy(col);
      this.sunIntensity = inten * this.exposureCompensation;
      // The sky compresses six decades of daylight into ~1.5 on screen. Practicals
      // have to follow that compression or a street lamp at midnight arrives four
      // orders of magnitude above the sky and bleaches the frame — but following it
      // *fully* would keep the real (enormous) lamp-to-night-sky ratio. Half the
      // exponent lands practicals about 10-15x over the ambient, which is what a
      // night street actually looks like through a camera.
      this.localLightScale =
        clamp(Math.sqrt(Math.max(sky.adaptation ?? 1, 0.05)), 0.5, 6) * this.exposureCompensation;
    } else if (force) {
      // No sky module: a plausible mid-morning key so nothing renders black.
      const h = this.timeOfDay;
      const alt = Math.sin(((h - 6) / 12) * Math.PI);
      this.sunDirection.set(Math.cos((h / 24) * Math.PI * 2) * 0.6, Math.max(alt, -0.2), -0.6).normalize();
      this.sunIntensity = Math.max(0, alt) * 10 * this.exposureCompensation + 0.15;
      kelvinToLinearRGB(4200 + 2000 * clamp01(alt), this.sunColor);
      this.localLightScale = this.exposureCompensation;
    }

    this.csm.setKeyLight(this.sunDirection, this.sunColor, this.sunIntensity);

    // The sun's real angular radius is 0.0047 rad — technically correct and visually
    // almost hard-edged. Exaggerate a little, and a lot more near the horizon where
    // scattering genuinely smears the disc into a much larger source.
    const alt = clamp01(this.sunDirection.y);
    const horizon = 1 - clamp01(alt / 0.28);
    this.csm.setSoftness(0.0047 * this.softnessScale * (1 + 2.6 * horizon * horizon));
    // Shadows stay fully opaque: the IBL is what fills them in, not a lifted shadow
    // term. Lifting here is the classic way to turn a lit scene back into a flat one.
    this.csm.intensity = 1;
  }

  /* ─────────────────────────────────────────────────────────────────── IBL */

  _shDirections() {
    if (this._shDirs) return this._shDirs;
    const dirs = [];
    for (let it = 0; it < SH_THETA; it++) {
      const theta = ((it + 0.5) / SH_THETA) * Math.PI;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const dOmega = (Math.PI / SH_THETA) * ((2 * Math.PI) / SH_PHI) * sinT;
      for (let ip = 0; ip < SH_PHI; ip++) {
        const phi = ((ip + 0.5) / SH_PHI) * Math.PI * 2;
        dirs.push({
          v: new THREE.Vector3(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi)),
          w: dOmega,
          up: cosT,
        });
      }
    }
    this._shDirs = dirs;
    this._shCache = dirs.map(() => new THREE.Color());
    return dirs;
  }

  /**
   * Project the sky (plus a one-bounce ground term) into an L2 irradiance SH.
   * This runs on the CPU against `sky.sampleSky()` — the same analytic scattering the
   * dome renders — so it is deterministic, needs no GPU readback stall, and stays
   * consistent with the sun colour we hand the CSM.
   */
  _rebuildIBL(force = false) {
    const ctx = this.ctx;
    const sky = ctx.sky;

    // 1. Specular: hand the sky's prefiltered roughness chain to the scene.
    const env = sky?.envTexture || null;
    if (env) {
      if (ctx.scene && ctx.scene.environment !== env) ctx.scene.environment = env;
      this.envTexture = env;
    } else if (!this.envTexture) {
      this.envTexture = this._buildFallbackEnv();
      if (ctx.scene && this.envTexture) ctx.scene.environment = this.envTexture;
    }
    if (ctx.scene) ctx.scene.environmentIntensity = 1;

    // 2. Diffuse: an L2 SH so shadow interiors get sky colour, not a flat grey lift.
    const dirs = this._shDirections();
    const coeff = this.sh.coefficients;
    for (let i = 0; i < 9; i++) coeff[i].set(0, 0, 0);

    const canSample = typeof sky?.sampleSky === 'function';
    let skyOk = false;
    let eR = 0;
    let eG = 0;
    let eB = 0;

    if (canSample) {
      try {
        for (let i = 0; i < dirs.length; i++) {
          const d = dirs[i];
          if (d.up <= 0) continue;
          const c = sky.sampleSky(d.v, this._shCache[i]);
          if (!Number.isFinite(c.r)) throw new Error('sampleSky returned NaN');
          eR += c.r * d.up * d.w;
          eG += c.g * d.up * d.w;
          eB += c.b * d.up * d.w;
        }
        skyOk = true;
      } catch (err) {
        this._warn('ibl', 'sky.sampleSky failed, using a gradient environment', err);
      }
    }

    if (!skyOk) this._analyticSky(dirs);
    if (!skyOk) {
      eR = eG = eB = 0;
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i];
        if (d.up <= 0) continue;
        const c = this._shCache[i];
        eR += c.r * d.up * d.w;
        eG += c.g * d.up * d.w;
        eB += c.b * d.up * d.w;
      }
    }

    // One ground bounce. Without it every downward-facing surface — chins, undersides
    // of ledges, the bottom of a rifle — goes flat black and the scene reads as CG.
    const sunUp = Math.max(this.sunDirection.y, 0);
    const albedo = sky?.groundColor ? 0.16 : 0.14;
    const gR = (albedo * (this.sunIntensity * sunUp * this.sunColor.r + eR)) / Math.PI;
    const gG = (albedo * (this.sunIntensity * sunUp * this.sunColor.g + eG)) / Math.PI;
    const gB = (albedo * (this.sunIntensity * sunUp * this.sunColor.b + eB * 0.95)) / Math.PI;

    const basis = [];
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      const c = this._shCache[i];
      let r;
      let g;
      let b;
      if (d.up > 0.06) {
        r = c.r;
        g = c.g;
        b = c.b;
      } else if (d.up > -0.06) {
        // Soft horizon blend so the SH does not have to resolve a hard step.
        const t = (d.up + 0.06) / 0.12;
        r = gR + (c.r - gR) * t;
        g = gG + (c.g - gG) * t;
        b = gB + (c.b - gB) * t;
      } else {
        r = gR;
        g = gG;
        b = gB;
      }
      THREE.SphericalHarmonics3.getBasisAt(d.v, basis);
      for (let k = 0; k < 9; k++) {
        const wk = basis[k] * d.w;
        coeff[k].x += r * wk;
        coeff[k].y += g * wk;
        coeff[k].z += b * wk;
      }
    }

    const u = this.uniforms.uCodSH.value;
    let finite = true;
    for (let k = 0; k < 9; k++) {
      const c = coeff[k];
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) finite = false;
      u[k].copy(c);
    }
    const wasValid = this._shValid;
    this._shValid = finite && coeff[0].lengthSq() > 1e-12;
    if (!this._shValid) for (let k = 0; k < 9; k++) u[k].set(0, 0, 0);
    if (wasValid !== this._shValid) this._invalidateShaders();

    this._envDirty = false;
    ctx.bus?.emit?.('lighting:env', { envTexture: this.envTexture, sh: this.sh });
    if (force) this.probes.refresh();
  }

  /** Gradient stand-in when there is no sky module (or it threw). Never black. */
  _analyticSky(dirs) {
    const sky = this.ctx.sky;
    const zen = sky?.zenithColor || _color.setRGB(0.11, 0.2, 0.42);
    const zr = zen.r;
    const zg = zen.g;
    const zb = zen.b;
    const hor = sky?.horizonColor;
    const hr = hor ? hor.r : 0.42;
    const hg = hor ? hor.g : 0.47;
    const hb = hor ? hor.b : 0.56;
    for (let i = 0; i < dirs.length; i++) {
      const up = clamp01(dirs[i].up);
      const t = Math.pow(up, 0.55);
      this._shCache[i].setRGB(hr + (zr - hr) * t, hg + (zg - hg) * t, hb + (zb - hb) * t);
    }
  }

  _buildFallbackEnv() {
    const renderer = this.ctx.renderer;
    if (!renderer) return null;
    try {
      const w = 64;
      const h = 32;
      const data = new Float32Array(w * h * 4);
      let i = 0;
      for (let y = 0; y < h; y++) {
        const up = Math.cos(((y + 0.5) / h) * Math.PI);
        const t = Math.pow(clamp01(up), 0.55);
        for (let x = 0; x < w; x++) {
          const r = up > 0 ? 0.42 + (0.11 - 0.42) * t : 0.06;
          const g = up > 0 ? 0.47 + (0.2 - 0.47) * t : 0.055;
          const b = up > 0 ? 0.56 + (0.42 - 0.56) * t : 0.05;
          data[i++] = r;
          data[i++] = g;
          data[i++] = b;
          data[i++] = 1;
        }
      }
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.NoColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this._fallbackPmrem = this._fallbackPmrem || new THREE.PMREMGenerator(renderer);
      const rt = this._fallbackPmrem.fromEquirectangular(tex, this._fallbackEnvRT || undefined);
      this._fallbackEnvRT = rt;
      tex.dispose();
      rt.texture.name = 'lighting.fallbackEnv';
      return rt.texture;
    } catch (err) {
      this._warn('env', 'fallback environment failed', err);
      return null;
    }
  }

  /**
   * Irradiance arriving at a world-space normal, in render units. Accepts either a
   * THREE.Color or a THREE.Vector3 as the target — SphericalHarmonics3 only speaks
   * Vector3, so the conversion happens here rather than in every caller.
   * @param {THREE.Vector3} normal world space, normalised
   * @param {THREE.Color|THREE.Vector3} [target]
   */
  ambientIrradiance(normal, target = new THREE.Color()) {
    const v = (this._shEval = this._shEval || new THREE.Vector3());
    if (!this._shValid || !normal) v.set(0, 0, 0);
    else this.sh.getIrradianceAt(normal, v);
    const r = Math.max(v.x, 0);
    const g = Math.max(v.y, 0);
    const b = Math.max(v.z, 0);
    if (target && target.isColor) return target.setRGB(r, g, b);
    if (target && typeof target.set === 'function') return target.set(r, g, b);
    return new THREE.Color(r, g, b);
  }

  /* ─────────────────────────────────────────────── material shader patching */

  _shaderKeyNow() {
    const probes = this.probesEnabled && this.probes.ready ? this.probes.probes.length : 0;
    return `c${this.csm.version}p${probes}s${this._shValid ? 1 : 0}k${
      this.contact.enabled ? 1 : 0
    }`;
  }

  _invalidateShaders() {
    this._glslCache = null;
    this._shaderVersion++;
    for (const m of this._materials) m.needsUpdate = true;
  }

  _glsl() {
    const key = this._shaderKeyNow();
    if (this._glslCache && this._shaderKey === key) return this._glslCache;
    this._shaderKey = key;

    const useProbes = this.probesEnabled && this.probes.ready;
    const useSH = this._shValid;
    const useContact = this.contact.enabled;
    const n = this.csm.count;

    const spotTaps = this.headless ? 5 : this.tier === 'low' ? 5 : this.tier === 'ultra' ? 12 : 8;

    /* ---- fragment declarations, inserted just before void main() ---- */
    let pars = `
// ═════════ Claude of Duty — lighting injection (render/Lighting.js) ═════════
${SHADOW_COMMON_GLSL}
${this.csm.parsGLSL()}

// Local spot lights. BasicShadowMap keeps the maps readable for the cascade blocker
// search, but it also means three's own getShadow() is a hard step(); a practical
// with a stair-stepped edge undoes everything the cascades just bought us.
#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_BASIC ) && NUM_SPOT_LIGHT_SHADOWS > 0
#define COD_SPOT_PCF 1
${glslDisc('COD_SPOT_DISC', vogelDisc(spotTaps))}

float codSpotShadow( sampler2D shadowMap, vec2 mapSize, float intensity, float bias, float radius, vec4 coord ) {
	vec3 sc = coord.xyz / coord.w;
	if ( sc.z > 1.0 || sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 ) return 1.0;
	float zr = sc.z + bias;
	vec2 texel = 1.0 / max( mapSize, vec2( 1.0 ) );
	float ang = codShadowNoise( gl_FragCoord.xy ) * 6.2831853;
	vec2 rot = vec2( cos( ang ), sin( ang ) );
	float r = max( radius, 1.0 ) * 1.4;
	float sum = 0.0;
	for ( int k = 0; k < ${spotTaps}; k ++ ) {
		vec2 o = codRotate( COD_SPOT_DISC[ k ], rot ) * texel * r;
		sum += step( zr, texture2D( shadowMap, sc.xy + o ).r );
	}
	return mix( 1.0, sum * ${(1 / spotTaps).toFixed(8)}, intensity );
}
#endif
`;

    if (useSH) {
      pars += `
#define COD_SH 1
uniform vec3 uCodSH[ 9 ];

/** Ramamoorthi/Hanrahan L2 irradiance. Returns E, matching getIBLIrradiance(). */
vec3 codShIrradiance( vec3 nView ) {
	vec3 n = transformNormalByInverseViewMatrix( nView, viewMatrix );
	float x = n.x, y = n.y, z = n.z;
	vec3 r = uCodSH[ 0 ] * 0.886227;
	r += uCodSH[ 1 ] * ( 2.0 * 0.511664 ) * y;
	r += uCodSH[ 2 ] * ( 2.0 * 0.511664 ) * z;
	r += uCodSH[ 3 ] * ( 2.0 * 0.511664 ) * x;
	r += uCodSH[ 4 ] * ( 2.0 * 0.429043 ) * x * y;
	r += uCodSH[ 5 ] * ( 2.0 * 0.429043 ) * y * z;
	r += uCodSH[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	r += uCodSH[ 7 ] * ( 2.0 * 0.429043 ) * x * z;
	r += uCodSH[ 8 ] * 0.429043 * ( x * x - y * y );
	return max( r, vec3( 0.0 ) );
}
`;
    }

    if (useContact) {
      pars += `
#define COD_CONTACT 1
uniform sampler2D uCodContactMap;
uniform mat4 uCodContactMtx;    // capture viewProj * current camera world
uniform vec4 uCodContactParams; // x strength, y depth normaliser

/**
 * The buffer was marched against last frame's depth, so we reproject this fragment
 * into the frame it was captured in and reject the sample when the depths disagree —
 * otherwise disoccluded pixels drag a smear of stale occlusion behind moving geometry.
 */
float codContactShadow( vec3 viewPos ) {
	if ( uCodContactParams.x <= 0.0 ) return 1.0;
	vec4 c = uCodContactMtx * vec4( viewPos, 1.0 );
	if ( c.w <= 0.0 ) return 1.0;
	vec2 uv = c.xy / c.w * 0.5 + 0.5;
	if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return 1.0;
	vec4 t = texture2D( uCodContactMap, uv );
	float stored = ( t.g + t.b * ( 1.0 / 255.0 ) ) * uCodContactParams.y;
	float expect = c.w;
	if ( abs( stored - expect ) > max( 0.08, expect * 0.02 ) ) return 1.0;
	return mix( 1.0, t.r, uCodContactParams.x );
}
`;
    }

    if (useProbes) {
      pars += this.probes.parsGLSL();
      pars += `
#if defined( COD_PROBES )
uniform mat4 uCodInvView;

vec3 codIblRadiance( vec3 viewDir, vec3 nrm, float rough ) {
	vec3 rv = reflect( - viewDir, nrm );
	rv = normalize( mix( rv, nrm, pow4( rough ) ) );
	rv = transformDirectionByInverseViewMatrix( rv, viewMatrix );
	rv = envMapRotation * rv;
	vec3 base = textureCubeUV( envMap, rv, rough ).rgb;
	vec3 wp = ( uCodInvView * vec4( - vViewPosition, 1.0 ) ).xyz;
	return codProbeRadiance( wp, rv, rough, base ) * envMapIntensity;
}
#endif
`;
    }

    /* ---- patched lights_fragment_begin ---- */
    let original = THREE.ShaderChunk.lights_fragment_begin;

    const spotNeedle =
      'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;';
    if (original.includes(spotNeedle)) {
      original = original.replace(
        spotNeedle,
        () => `#ifdef COD_SPOT_PCF
		directLight.color *= ( directLight.visible && receiveShadow ) ? codSpotShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#else
		${spotNeedle}
		#endif`
      );
    }

    const dirRe =
      /#if \( NUM_DIR_LIGHTS > 0 \) && defined\( RE_Direct \)[\s\S]*?#pragma unroll_loop_end\s*\n\s*#endif/;

    let beginChunk = null;
    if (dirRe.test(original)) {
      const block = `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	// ── the sun: one light, N cascades, one RE_Direct ──────────────────────────
	{
		directionalLight = directionalLights[ 0 ];
		getDirectionalLightInfo( directionalLight, directLight );
		float codSun = 1.0;
		#ifdef COD_CSM
		// geometryPosition is the view-space position (three's vViewPosition is already
		// negated), so the positive distance along the view axis is -geometryPosition.z.
		if ( receiveShadow ) codSun = codCsmShadow( - geometryPosition.z, geometryNormal, directLight.direction );
		#elif defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
		// CSM unavailable (shadow map type changed under us): keep three's own filter.
		directionalLightShadow = directionalLightShadows[ 0 ];
		codSun = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ 0 ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
		#endif
		#ifdef COD_CONTACT
		if ( receiveShadow ) codSun = min( codSun, codContactShadow( geometryPosition ) );
		#endif
		directLight.color *= codSun;
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}

	// ── any other directional light behaves exactly as three intends ───────────
	#pragma unroll_loop_start
	for ( int i = ${n}; i < NUM_DIR_LIGHTS; i ++ ) {

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	#pragma unroll_loop_end

#endif`;
      beginChunk = original.replace(dirRe, () => block);
    } else {
      this._warn('glsl', 'lights_fragment_begin did not match; CSM falls back to three shadows');
    }

    /* ---- patched lights_fragment_maps ---- */
    const mapsSrc = THREE.ShaderChunk.lights_fragment_maps;
    let mapsChunk = mapsSrc;
    if (useSH) {
      const needle = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
      if (mapsChunk.includes(needle)) {
        mapsChunk = mapsChunk.replace(
          needle,
          `#ifdef COD_SH
				iblIrradiance += codShIrradiance( geometryNormal ) * envMapIntensity;
			#else
				iblIrradiance += getIBLIrradiance( geometryNormal );
			#endif`
        );
      }
    }
    if (useProbes) {
      const needle = 'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );';
      if (mapsChunk.includes(needle)) {
        mapsChunk = mapsChunk.replace(
          needle,
          `#if defined( COD_PROBES )
			radiance += codIblRadiance( geometryViewDir, geometryNormal, material.roughness );
		#else
			radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
		#endif`
        );
      }
    }

    this._glslCache = {
      pars,
      beginChunk,
      mapsChunk: mapsChunk === mapsSrc ? null : mapsChunk,
    };
    return this._glslCache;
  }

  /** Attach the injection to one material. Idempotent. */
  _patch(material) {
    if (!material || this._patched.has(material)) return;
    if (!material.isMeshStandardMaterial) return; // covers MeshPhysicalMaterial too
    if (material.userData?.noLightingPatch) return;

    this._patched.add(material);
    this._materials.add(material);

    const self = this;
    const prevOBC = typeof material.onBeforeCompile === 'function' ? material.onBeforeCompile : null;
    const prevOBCText = prevOBC ? prevOBC.toString() : '';
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
          self._warn('patch', 'a previous onBeforeCompile threw', err);
        }
      }
      try {
        self._inject(shader);
      } catch (err) {
        self._warn('patch', 'lighting injection failed for a material', err);
      }
    };

    // The cache key has to distinguish materials whose *previous* patch differed, or
    // three will hand them a program that only contains one of the two injections.
    material.customProgramCacheKey = function () {
      const base = prevKeyFn ? prevKeyFn.call(this) : prevOBCText;
      return `${base}|codLighting:${self._shaderVersion}:${self._shaderKeyNow()}`;
    };

    material.needsUpdate = true;
  }

  _inject(shader) {
    const g = this._glsl();
    // The probe system grows `uProbeMapN` entries after construction, so pull from the
    // live objects rather than the snapshot taken when `this.uniforms` was built.
    Object.assign(shader.uniforms, this.uniforms, this.csm.uniforms, this.probes.uniforms);

    let frag = shader.fragmentShader;
    // Everything below has to sit after cube_uv / envmap / shadowmap pars, which is
    // exactly where main() starts.
    const anchor = '\nvoid main() {';
    if (frag.includes(anchor)) {
      frag = frag.replace(anchor, `${g.pars}\nvoid main() {`);
    } else {
      frag = `${g.pars}\n${frag}`;
    }
    if (g.beginChunk) {
      frag = frag.replace('#include <lights_fragment_begin>', () => g.beginChunk);
    }
    if (g.mapsChunk) {
      frag = frag.replace('#include <lights_fragment_maps>', () => g.mapsChunk);
    }
    shader.fragmentShader = frag;
  }

  /** Walk both scenes and patch anything new. Cheap enough to run a few times a second. */
  _scan() {
    const frame = this.ctx.time?.frame ?? 0;
    const interval = this.headless ? 6 : 12;
    if (frame - this._scanFrame < interval) return;
    this._scanFrame = frame;

    const visit = (obj) => {
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) {
        for (const mm of m) this._patch(mm);
      } else {
        this._patch(m);
      }
    };
    try {
      this.ctx.scene?.traverse(visit);
      this.ctx.viewScene?.traverse(visit);
    } catch (err) {
      this._warn('scan', 'material scan failed', err);
    }
  }

  /* ─────────────────────────────────────────────────────────────── per frame */

  update(dt) {
    if (this.broken) return;
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 1 / 60;

    // Keep the key light in step with the sky even when nobody called setTimeOfDay.
    this._syncFromSky(false);

    this._envTimer += d;
    if (this._envDirty && this._envTimer > (this.headless ? 0.05 : 0.4)) {
      this._envTimer = 0;
      try {
        this._rebuildIBL(false);
      } catch (err) {
        this._warn('ibl', 'IBL rebuild failed', err);
        this._envDirty = false;
      }
    }

    const viewer = this.ctx.camera?.position;
    try {
      this.lights.update(d, viewer, this.localLightScale);
    } catch (err) {
      this._warn('lights', 'local light update failed', err);
    }

    if (this._probeBuildPending) {
      this._probeBuildPending = false;
      try {
        this.probes.build(this.probesEnabled ? this._probeCount : 0);
      } catch (err) {
        this._warn('probes', 'probe placement failed', err);
      }
    }

    // Contact-shadow strength lives in a uniform so it can drop to zero the instant
    // the buffer stops being trustworthy (teleport, first frame, pipeline missing).
    const cs = this.uniforms.uCodContactParams.value;
    cs.x = this.contact.enabled && this.contact.valid ? this.contact.strength : 0;
    cs.y = this.contact.normDist;
    this.uniforms.uCodContactMap.value = this.contact.texture;

    this._scan();

    // A change of shader-visible state (probe count, SH validity, contact on/off) has
    // to recompile, or the injected code and the uniforms disagree.
    if (this._glslCache && this._shaderKey !== this._shaderKeyNow()) this._invalidateShaders();
  }

  lateUpdate() {
    // Nothing: the cascade fit happens in scene.onBeforeRender, where the camera is
    // already final. See _hookScene().
  }

  /** Runs after the frame is on screen — the depth buffer is complete here. */
  _afterRender() {
    if (this.disposed) return;
    try {
      if (!this.broken) {
        const renderer = this.ctx.renderer;
        const depth = this._sceneDepthTexture();
        if (this.contact.enabled && depth) {
          this.contact.render(renderer, depth, this.ctx.camera, this.sunDirection);
        } else {
          this.contact.valid = false;
        }
        if (this.probesEnabled) {
          const published = this.probes.tick(renderer, this.ctx.scene);
          if (published && this._shaderKey !== this._shaderKeyNow()) this._invalidateShaders();
        }
      }
    } catch (err) {
      this._warn('after', 'post-render lighting work failed', err);
    }
    // Re-arm: the engine's callback list is one-shot.
    try {
      this.ctx.engine?.onNextFrame?.(this._afterRenderBound);
    } catch {
      /* engine going away */
    }
  }

  /**
   * The render pipeline owns the HDR targets. Read its scene depth if it has one,
   * otherwise contact shadows simply stay off — never guess at a texture.
   */
  _sceneDepthTexture() {
    const p = this.ctx.pipeline;
    if (!p || p.ready === false) return null;
    const impl = p._impl;
    if (!impl || impl.broken) return null;
    return impl.shared?.tDepth?.value || impl.rtScene?.depthTexture || null;
  }

  resize(w, h) {
    try {
      this.contact.setSize(w, h);
      this.contact.valid = false;
    } catch (err) {
      this._warn('resize', 'contact shadow resize failed', err);
    }
  }

  refreshProbes(count) {
    if (Number.isFinite(count)) this._probeCount = clamp(count, 0, 4);
    this._probeBuildPending = true;
  }

  get stats() {
    return {
      cascades: this.csm.count,
      shadowResolution: this.csm.resolution,
      pcss: this.csm.pcss,
      probes: this.probes.active,
      probeSlots: this.probes.probes.length,
      activeLights: this.lights.activeCount || 0,
      shadowLights: this.lights.shadowCount || 0,
      patchedMaterials: this._materials.size,
      contact: this.contact.enabled && this.contact.valid,
      sh: this._shValid,
      sunIntensity: this.sunIntensity,
      timeOfDay: this.timeOfDay,
    };
  }

  _warn(tag, msg, err) {
    if (this._warned.has(tag)) return;
    this._warned.add(tag);
    console.warn(`[lighting] ${msg}`, err || '');
  }

  dispose() {
    this.disposed = true;
    for (const off of this._unsub) {
      try {
        off();
      } catch {
        /* best effort */
      }
    }
    this._unsub.length = 0;
    for (const { scene, prev } of this._sceneHooks) {
      try {
        scene.onBeforeRender = prev || function () {};
        delete scene.__codLightingHook;
      } catch {
        /* best effort */
      }
    }
    this._sceneHooks.length = 0;
    this._materials.clear();
    try {
      if (this.ctx.scene && this.ctx.scene.environment === this.envTexture) {
        this.ctx.scene.environment = null;
      }
    } catch {
      /* ignore */
    }
    this.csm.dispose();
    this.probes.dispose();
    this.lights.dispose();
    this.contact.dispose();
    this._fallbackEnvRT?.dispose?.();
    this._fallbackPmrem?.dispose?.();
    this.ready = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════ factory ══ */

/** @returns {import('../core/types.js').System} */
export default function createLighting(ctx) {
  const lighting = new Lighting(ctx);

  // A complete surface from the first line, so a system that initialises before us —
  // or after a failed init() — never trips over `undefined`.
  const api = {
    ready: false,
    _impl: lighting,
    setTimeOfDay: (h) => lighting.setTimeOfDay(h),
    addLight: (def) => lighting.lights.addLight(def),
    removeLight: (h) => lighting.lights.removeLight(h),
    kelvin: (k, t) => kelvinToLinearRGB(k, t),
    ambientIrradiance: (n, t) => lighting.ambientIrradiance(n, t),
    setShadowsEnabled: (v) => lighting.setShadowsEnabled(v),
    setContactShadows: (v) => lighting.setContactShadows(v),
    setProbesEnabled: (v) => lighting.setProbesEnabled(v),
    setExposureCompensation: (v) => lighting.setExposureCompensation(v),
    refreshProbes: (n) => lighting.refreshProbes(n),
    get sun() {
      return lighting.csm.lights[0] || null;
    },
    get sunDirection() {
      return lighting.sunDirection;
    },
    /** Same vector, honestly named: after dusk the key light is the moon. */
    get keyDirection() {
      return lighting.sunDirection;
    },
    get sunColor() {
      return lighting.sunColor;
    },
    get sunIntensity() {
      return lighting.sunIntensity;
    },
    get timeOfDay() {
      return lighting.timeOfDay;
    },
    get envMap() {
      return lighting.envTexture;
    },
    get envTexture() {
      return lighting.envTexture;
    },
    get irradianceSH() {
      return lighting.sh;
    },
    get csm() {
      return lighting.csm;
    },
    get probes() {
      return lighting.probes;
    },
    get lights() {
      return lighting.lights;
    },
    /** Exposed so a future pipeline pass can own the march instead of us self-driving. */
    get contactShadow() {
      return {
        texture: lighting.contact.texture,
        uniforms: lighting.contact.material.uniforms,
        valid: lighting.contact.valid,
        viewProj: lighting.contact.captureViewProj,
        render: (renderer, depth, camera) =>
          lighting.contact.render(renderer, depth, camera, lighting.sunDirection),
      };
    },
    get uniforms() {
      return lighting.uniforms;
    },
    get stats() {
      return lighting.stats;
    },
  };

  return {
    name: 'lighting',
    order: 24,
    async init() {
      ctx.lighting = api;
      try {
        lighting.init();
        api.ready = true;
      } catch (err) {
        // Never take the frame down. Fall back to a single plain sun so the level is
        // at least lit while whatever broke gets fixed.
        console.warn('[lighting] init failed, falling back to a single sun:', err);
        lighting.broken = true;
        try {
          const sun = new THREE.DirectionalLight(0xfff2e0, 6);
          sun.position.set(40, 60, 30);
          ctx.scene?.add(sun);
          lighting.csm.lights[0] = sun;
        } catch {
          /* nothing left to do */
        }
      }
    },
    update(dt) {
      if (!lighting.ready || lighting.broken) return;
      lighting.update(dt);
    },
    lateUpdate(dt) {
      if (!lighting.ready || lighting.broken) return;
      lighting.lateUpdate(dt);
    },
    resize(w, h) {
      if (!lighting.ready || lighting.broken) return;
      lighting.resize(w, h);
    },
    dispose() {
      try {
        lighting.dispose();
      } catch {
        /* teardown is best-effort */
      }
    },
  };
}
