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
 *                (the same scattering model the sky dome renders) plus a **measured**
 *                one-bounce term: a 16-bin horizon profile raycast against the
 *                collision world tells the projection which bearings are sky and which
 *                are masonry, and shades the masonry properly. Shadowed faces therefore
 *                pick up warm facade bounce where a wall is standing and sky blue where
 *                it is not — for free, and with no ringing. See `_gatherLocalEnvironment`.
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
 *   getVolumetricShadow()    -> {map, matrix, bias, cascade} | null  — a real cascade
 *                               for render/passes/VolumetricPass.js to march against
 *   getVolumetricLights(n)   -> [{pos, color, radius, dir, cosInner, cosOuter}]
 *                               practicals worth scattering through, night only
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
/** Scratch for the local environment probe — see `_gatherLocalEnvironment`. */
const _hzO = new THREE.Vector3();
const _hzD = new THREE.Vector3();
const _hzP = new THREE.Vector3();
const _hzN = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _DOWN = new THREE.Vector3(0, -1, 0);

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

/** `[[x,y],…]` -> a GLSL vec2 argument list, for a `vec2[ n ]( … )` constructor. */
function discPoints(pts) {
  return pts.map(([x, y]) => `vec2(${x.toFixed(6)},${y.toFixed(6)})`).join(',');
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
uniform vec4 uAo;       // x radius (m), y strength, z power, w normal bias
varying vec2 vUv;

const vec2 COD_AO_DISC[ COD_AO_TAPS ] = vec2[ COD_AO_TAPS ]( COD_AO_POINTS );

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

/**
 * Short-range ambient occlusion, in the same pass and off the same depth buffer.
 *
 * This is the half of "grounding" the sun march cannot do. A contact shadow is a
 * *directional* query — it only exists where N·L > 0 and the key light reaches — so
 * in shade, indoors, or on a facade turned away from the sun it correctly returns
 * "unoccluded" and every scaffolding leg, planter and bench floats. AO is the
 * omnidirectional answer, it survives with no key light at all, and unlike the
 * pipeline's post-composite GTAO it is fed straight back into the *indirect*
 * lighting term inside the material, which is where the occlusion physically belongs.
 *
 * Alchemy-style estimator: each tap contributes by how far above the tangent plane
 * it sits, attenuated by distance so a wall two metres behind cannot occlude.
 */
float codAmbientOcclusion( vec3 P, vec3 N, float dist, float jitter ) {

	float radius = uAo.x;
	// World radius -> uv radius. The perspective divide is the only thing that keeps
	// the sample footprint constant in metres as the geometry recedes.
	vec2 uvR = vec2( uProj[ 0 ][ 0 ], uProj[ 1 ][ 1 ] ) * ( radius / ( 2.0 * max( dist, 0.05 ) ) );
	/**
	 * A tiny AO kernel on distant geometry is pure noise; a huge one on a nearby surface
	 * stops being occlusion at all.
	 *
	 * The upper clamp used to be 0.09, which at a 46-degree FOV is a **115-pixel** disc
	 * for anything closer than about 6.6 m — i.e. across the entire near foreground the
	 * "ambient occlusion" was sampling a tenth of the screen, every tap landed on some
	 * piece of nearby geometry, the estimator saturated, and the result was a blanket
	 * 0.25 multiplier over the whole bottom of the frame rather than a dark line where
	 * two surfaces meet. That is the mechanism behind the review's "the near-camera
	 * foreground is the darkest region in 8 of 8 frames": not the lighting, a screen-
	 * space term whose footprint ran away as things got closer.
	 */
	uvR = clamp( uvR, vec2( 0.0015 ), vec2( 0.05 ) );

	float ang = jitter * 6.2831853;
	vec2 rot = vec2( cos( ang ), sin( ang ) );
	float r2 = radius * radius;
	float occ = 0.0;

	for ( int k = 0; k < COD_AO_TAPS; k ++ ) {

		vec2 s = COD_AO_DISC[ k ];
		vec2 o = vec2( s.x * rot.x - s.y * rot.y, s.x * rot.y + s.y * rot.x ) * uvR;
		vec2 uv = clamp( vUv + o, vec2( 0.0 ), vec2( 1.0 ) );
		float sd = texture2D( tDepth, uv ).r;
		if ( sd >= 0.999999 ) continue;      // sky occludes nothing

		vec3 v = viewFromDepth( uv, sd ) - P;
		float d2 = dot( v, v );
		float nd = dot( N, v ) * inversesqrt( max( d2, 1e-8 ) );
		// Range attenuation, and a normal bias so a flat floor never occludes itself.
		occ += max( nd - uAo.w, 0.0 ) * ( r2 / ( r2 + d2 ) );

	}

	// 2/N: a fully enclosed point averages ~0.5 over a cosine-ish tap set.
	float ao = 1.0 - occ * ( 2.0 / float( COD_AO_TAPS ) ) * uAo.y;
	return pow( clamp( ao, 0.0, 1.0 ), uAo.z );

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

	float jitter = codHash( gl_FragCoord.xy );
	float ao = codAmbientOcclusion( P, N, dist, jitter );

	float ndl = dot( N, uSunView );
	// Facing away from the key light: it is already fully shadowed by N·L, and any
	// occlusion we found here would just double-darken the terminator. The AO term
	// still ships — that is the whole point of computing it separately.
	if ( ndl <= 0.05 ) {
		gl_FragColor = vec4( 1.0, packed, ao );
		return;
	}

	// A short march towards the key light. This only ever adds the occlusion CSM cannot
	// resolve: a couple of decimetres, fading out along the ray so it can never
	// become a long smear that fights the cascades.
	float shadow = 1.0;
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

	gl_FragColor = vec4( shadow, packed, ao );

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

    /* Ambient occlusion, shipped in the alpha channel of the same buffer.
       `aoRadius` is deliberately wider than the pipeline's GTAO (1.1 m) is allowed to
       reach in practice at this resolution: this term is doing "object meets ground",
       not "crevice detail", and 0.9 m is roughly a bench leg's worth of surroundings. */
    this.aoTaps = 8;
    this.aoRadius = 0.9;
    // The pipeline already runs a 1.1 m GTAO over the composited frame, so this term
    // has to be additive-but-modest or crevices get occluded twice and go to soot.
    this.aoStrength = 0.72;
    this.aoPower = 1.1;
    this.aoNormalBias = 0.05;
    /**
     * How much of the AO is allowed to bite the indirect term in the material.
     *
     * Trimmed from 0.70 once the IBL started carrying a *measured* horizon (see
     * `_gatherLocalEnvironment`): the SH now already knows that two thirds of the sky
     * over this street is masonry, so a screen-space term applying the same occlusion
     * a second time is double-counting — and it does it hardest exactly where the
     * review found the frame deadest, in the near foreground, which is the part of any
     * FPS frame with the most nearby geometry to occlude against.
     */
    this.aoIndirect = 0.55;

    this.material = new THREE.ShaderMaterial({
      name: 'lighting:contactShadows',
      defines: {
        COD_CS_STEPS: this.steps,
        COD_AO_TAPS: this.aoTaps,
        COD_AO_POINTS: discPoints(vogelDisc(this.aoTaps)),
      },
      uniforms: {
        tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uProj: { value: new THREE.Matrix4() },
        uSunView: { value: new THREE.Vector3(0, 1, 0) },
        uParams: { value: new THREE.Vector4(0.28, 0.55, 0.012, 140) },
        uAo: { value: new THREE.Vector4(0.9, 0.9, 1.35, 0.035) },
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
      this.aoTaps = 8;
    } else {
      switch (tier) {
        case 'low':
          this.scale = 0.5;
          this.steps = 6;
          this.aoTaps = 6;
          break;
        case 'medium':
          this.scale = 0.5;
          this.steps = 10;
          this.aoTaps = 10;
          break;
        case 'ultra':
          this.scale = 0.75;
          this.steps = 20;
          this.aoTaps = 16;
          break;
        default:
          this.scale = 0.5;
          this.steps = 14;
          this.aoTaps = 12;
          break;
      }
    }
    let dirty = false;
    if (this.material.defines.COD_CS_STEPS !== this.steps) {
      this.material.defines.COD_CS_STEPS = this.steps;
      dirty = true;
    }
    if (this.material.defines.COD_AO_TAPS !== this.aoTaps) {
      this.material.defines.COD_AO_TAPS = this.aoTaps;
      this.material.defines.COD_AO_POINTS = discPoints(vogelDisc(this.aoTaps));
      dirty = true;
    }
    if (dirty) this.material.needsUpdate = true;
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
    u.uAo.value.set(this.aoRadius, this.aoStrength, this.aoPower, this.aoNormalBias);

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
    /**
     * Headless keeps a smaller pool, but not as small as it was. At four points the
     * eight interior practicals and every prop-mounted stall lamp on the map were
     * competing for four slots against each other, and the screen-space score is
     * `power / d²` — so a 42 W street lamp twenty metres away beat the two market-stall
     * lamps four metres in front of the hero camera, which is the "motivated fill is
     * not measurable" the review measured under the awning. Six points and three spots
     * is two more `#if NUM_POINT_LIGHTS` iterations per fragment; it is the cheapest
     * light in the frame and it is aimed at the part of the frame the review calls the
     * darkest region in eight frames out of eight.
     */
    this.target = headless
      ? { points: Math.min(t.points, 6), spots: Math.min(t.spots, 3), shadowSpots: 0 }
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
   *          enabled?:boolean, daylight?:boolean}} def
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
      /** `true` opts out of the daylight dimmer — for lights that are meant to read
          in full sun (vehicle strobes, muzzle flashes, scripted beauty lights). */
      daylight: def.daylight === true,
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

  /**
   * Is this light under a roof? A lamp that can see the sky is a *street* lamp and
   * has no business burning at 7 in the morning; one that cannot is an interior
   * practical and stays on all day. Resolved once per light against the collision
   * world — 16 raycasts for the whole level, and the alternative is either leaving
   * ten sodium lamps blazing through every daylight capture (they were scoring high
   * enough on proximity to take both shadow slots in the hero frame, and a 42 W lamp
   * 4.6 m up puts ~2.0 irradiance on the pavement, which at golden hour is the same
   * order as the sun itself) or making Level.js tag them, which is not my file.
   */
  _skyLit(r) {
    if (r._skyLit !== undefined) return r._skyLit;
    const phys = this.ctx.physics;
    if (!phys?.raycast) return false; // unknown: assume indoors, i.e. leave it alone
    try {
      _v3.set(0, 1, 0);
      r._skyLit = !phys.raycast(r.position, _v3, 60, 1 | 8);
    } catch {
      r._skyLit = false;
    }
    return r._skyLit;
  }

  /** @param {number} dt @param {THREE.Vector3} viewer @param {number} exposure */
  update(dt, viewer, exposure) {
    const t = this.ctx.time?.elapsed ?? 0;
    const day = clamp01(this.lighting?.daylight ?? 0);

    // Flicker / pulse first: it feeds the importance score, so a light that has just
    // guttered out does not hold on to a shadow slot.
    for (const r of this.requests) {
      let mod = r.daylight === true ? 1 : 1 - day * (this._skyLit(r) ? 0.95 : 0.2);
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

/**
 * Diffuse albedo of "everything below the horizon" for the one-bounce IBL term:
 * an area-weighted mix of dark asphalt and warm stucco/terracotta facade. Spectral
 * on purpose — see `_rebuildIBL`.
 */
const BOUNCE_ALBEDO = new THREE.Color(0.26, 0.215, 0.165);

/**
 * Object / material names that must stay out of the shadow caster set. See
 * `Lighting._enrolCaster`. Deliberately narrow: everything not matched here casts.
 */
const NO_CAST_RE =
  /sky|dome|cloud|cirrus|star|galaxy|moon|horizon|backdrop|decal|grime|contact|scorch|roadpaint|tracer|muzzle|flash|spark|smoke|ember|dust|mote|particle|billboard|impostor|sprite|flare|halo|debug|helper|gizmo|hud|reticle|crosshair|marker|minimap|preview|outline|silhouette|viewmodel|wire|cable/i;

/**
 * How many window/door apertures can light a room at once. Four covers every review
 * pose (the market hall's south wall shows three from the interior camera) and keeps
 * the per-fragment loop under twenty instructions on the software rasteriser.
 */
const PORTAL_SLOTS = 4;

/**
 * ── The local environment probe ─────────────────────────────────────────────────
 *
 * `BOUNCE_ALBEDO` and the analytic skyline below it are a *guess* at what surrounds
 * the shading point. The guess was wrong in both directions at once: outdoors it left
 * half of a street canyon's masonry reading as bright blue sky, and indoors it handed
 * a market hall the full unoccluded irradiance of a clear morning — measured, from the
 * interior camera, 10 of 12 compass bearings see no sky at all below 90 degrees, and
 * the two that do only open up above 20. That is why the interior floor was a broad
 * warm pool with no shafts: there was nothing for a shaft to be brighter *than*.
 *
 * So measure it. Once per pose (and whenever the camera moves a couple of metres) we
 * fire a small fan of rays at the collision world and build a 16-bin horizon profile:
 * for each compass bearing, the elevation at which sky first appears, and the radiance
 * of whatever is below that elevation — computed as a real one-bounce, with the
 * occluder's own sun visibility raycast rather than assumed. Directions that hit
 * masonry get warm bounce, directions that see sky get sky, and the SH projection
 * below carries the difference. ~150 rays, cached; see `_gatherLocalEnvironment`.
 */
const HZ_BINS = 16;
/** sin(elevation) ladder the skyline search walks: 2, 5, 9, 14, 20, 27, 35, 46 deg. */
const HZ_LADDER = [0.035, 0.087, 0.156, 0.242, 0.342, 0.454, 0.574, 0.719];
/** Beyond this the occluder is far enough that aerial perspective makes it sky again. */
const HZ_RANGE = 52;
/** Softness of the skyline step, in sin(elevation) — the SH cannot resolve a hard edge. */
const HZ_FEATHER = 0.11;
/** A one-point probe is not the whole scene: never claim more than this much occlusion. */
const HZ_FILL = 0.86;
/** Diffuse albedo relative to BOUNCE_ALBEDO, by physics surface tag. */
const BOUNCE_GAIN = {
  concrete: 1.3,
  plaster: 1.55,
  ceramic: 1.4,
  sand: 1.5,
  snow: 2.6,
  wood: 1.0,
  fabric: 1.15,
  dirt: 0.8,
  metal: 0.75,
  rubber: 0.45,
  glass: 0.5,
  grass: 0.55,
  foliage: 0.5,
  water: 0.35,
  flesh: 0.9,
};

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

    /**
     * Filmic exaggeration of the solar disc: the real 0.0047 rad is almost hard.
     *
     * 4.2 was too much. A 20 m shadow thrown by a 15 deg sun already separates blocker
     * and receiver by tens of metres, and at 4.2x the disc that tip is metres wide —
     * which is how the plaza ended up with soft light/shade *regions* rather than the
     * legible shadow ladder the review asked for. 2.5 keeps the sharp contact point
     * and a visibly opening penumbra without dissolving the far end of a bar.
     */
    this.softnessScale = 1.9;
    this.shadowsEnabled = ctx.settings?.get?.('shadows') !== false;
    this.probesEnabled = true;
    this.exposureCompensation = 1;
    this.localLightScale = 1;

    /**
     * How far the screen-space AO is allowed to close the indirect term, and what it
     * closes *towards*. See the `COD_CONTACT` block in `_glsl()`.
     *
     * The review measured a vertical profile down the hero wall into the awning falling
     * from L 128 to RGB [1, 6, 19] in 25 pixels, with a third of the frame under L 32.
     * A multiply-to-zero is the wrong model: an occluder is a surface, and the surfaces
     * doing the occluding on this map are ochre plaster, pavement and canvas.
     */
    this.aoFloor = 0.34;
    this.bounceGain = 0.9;
    /** Aperture area lights — see `_updatePortals`. */
    this.portalsEnabled = true;
    this.portalGain = 1.5;
    this.portalSunGain = 1.0;
    this.portalCount = 0;
    this._portalTimer = 0;
    this._portalReady = false;
    this._portalAnchor = new THREE.Vector3(1e9, 1e9, 1e9);

    this.sunDirection = new THREE.Vector3(0.35, 0.72, 0.6).normalize();
    this.sunColor = new THREE.Color(1, 0.94, 0.86);
    this.sunIntensity = 8;
    /** Art-direction override for the key. See setSunStaging(). */
    this.sunStaging = { azimuth: null, altitude: null, kelvin: null };
    /** 0 at night, 1 in full sun — gates practicals. */
    this.daylight = 1;

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
      /**
       * What the occlusion occludes *towards*. rgb is the measured one-bounce
       * irradiance of the surroundings, w scales it. See `_glsl()` / `_updateBounce`.
       */
      uCodBounce: { value: new THREE.Vector4(0, 0, 0, 1) },
      /** x = AO floor on the indirect term, y = spare. */
      uCodAoFloor: { value: new THREE.Vector2(0.34, 0) },
      /* ── window / aperture portals, see `_updatePortals` ───────────────── */
      uCodPortalP: { value: Array.from({ length: PORTAL_SLOTS }, () => new THREE.Vector4()) },
      uCodPortalN: { value: Array.from({ length: PORTAL_SLOTS }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uCodPortalC: { value: Array.from({ length: PORTAL_SLOTS }, () => new THREE.Vector4()) },
    };

    this._patched = new WeakSet();
    /** Meshes the caster audit has already ruled on — see `_enrolCaster`. */
    this._audited = new WeakSet();
    this._casterFlips = 0;
    /** @type {Set<THREE.Material>} materials we have patched and may need to recompile */
    this._materials = new Set();
    this._glslCache = null;
    this._shaderKey = '';
    this._shaderVersion = 0;
    this._scanFrame = -999;
    this._fitFrame = -1;
    this._envDirty = true;
    this._envBudget = 4;
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
      this._envBudget = 4;
    });
    // A screenshot pose re-stages the sun, so grant a fresh convergence budget.
    on('debug:pose', () => {
      this._envDirty = true;
      this._envBudget = 4;
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
    on('debug:pose', (state) => {
      // A pose jump invalidates the contact buffer and every probe capture assumption.
      this.contact.valid = false;
      this._scanFrame = -999;
      // Per-pose key staging. `applyPose` sets the camera and the hour *before* it
      // emits this, so `sunAzimuthOffset` resolves against the final camera.
      try {
        const s = state || {};
        const has = (k) => Object.prototype.hasOwnProperty.call(s, k);
        if (has('sunAzimuth') || has('sunAltitude') || has('sunKelvin') || has('sunAzimuthOffset')) {
          this.setSunStaging({
            ...(has('sunAzimuth') ? { azimuth: s.sunAzimuth } : {}),
            ...(has('sunAzimuthOffset') ? { azimuthOffset: s.sunAzimuthOffset } : {}),
            ...(has('sunAltitude') ? { altitude: s.sunAltitude } : {}),
            ...(has('sunKelvin') ? { kelvin: s.sunKelvin } : {}),
          });
        } else if (
          this.sunStaging.azimuth !== null ||
          this.sunStaging.altitude !== null ||
          this.sunStaging.kelvin !== null
        ) {
          // A pose that says nothing about the key gets the almanac back, so one
          // staged pose can never leak its lighting into the next capture.
          this.setSunStaging(null);
        }
      } catch (err) {
        this._warn('staging', 'pose key staging failed', err);
      }
    });
    /**
     * **The muzzle flash has to light something.**
     *
     * `fx` draws a 248-peak sprite at the muzzle and the review's note is exactly right:
     * it lights nothing — no bounce off the barrel, no rim on the shooter, nothing on the
     * cover a metre in front. A flash is roughly a megacandela for two milliseconds; the
     * one thing it definitely does is illuminate its own surroundings.
     *
     * A pooled transient point light on `weapon:fire` is the cheapest honest fix and it
     * lives here because the light pool lives here. `daylight: true` opts it out of the
     * practicals dimmer — a muzzle flash reads in full sun, that is the point of it.
     * It decays over ~55 ms, which at 1/60 s is one to four frames, so a still captured
     * mid-burst catches it and a still captured between shots does not.
     */
    on('weapon:fire', (e) => {
      try {
        this._flash(e);
      } catch (err) {
        this._warn('flash', 'muzzle flash light failed', err);
      }
    });
    on('explosion', (e) => {
      try {
        this._flash({ origin: e?.point, intensity: 130, radius: Math.max(e?.radius ?? 6, 6), life: 0.16, kelvin: 2200 });
      } catch (err) {
        this._warn('flash', 'explosion light failed', err);
      }
    });
    on('lighting:stageSun', (o) => {
      try {
        this.setSunStaging(o);
      } catch (err) {
        this._warn('staging', 'stageSun event failed', err);
      }
    });
    const rescan = () => {
      this._scanFrame = -999;
      this._probeBuildPending = true;
      // A module that has just rebuilt its geometry may also have re-run its own
      // quality pass over `castShadow`; re-audit rather than trust the memo.
      this._audited = new WeakSet();
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
    /**
     * **Measured, not assumed: 1024 stays.**
     *
     * The obvious lever for the review's "no readable shadow bars" was the headless
     * resolution clamp — the tier asks for 1536, and at a 78 deg FOV that would take
     * the mid cascade from 4.2 cm texels to 2.8 cm, which is the difference between a
     * 6.4 cm window mullion being 1.5 texels and 2.3. It was tried and measured:
     * check.mjs went from 3.3 s to 7.4 s a frame for it, which on a harness that is
     * already the bottleneck for every agent on this repo is not a trade worth making
     * for a caster that is still marginal at the better number. The ladder came back
     * from the two changes that cost nothing instead — a 72 m shadow range (see
     * CSM.setQuality) and a 2.5x rather than 4.2x solar disc.
     */
    if (this.headless) res = Math.min(res, 1024);
    const cascades = clamp(s?.get?.('shadowCascades') ?? 4, 1, 4);

    /**
     * **Headless gets the fourth cascade back, and it is the whole of item 1.**
     *
     * Measured, in-engine, at the hero pose (78 degree FOV, 3 cascades, 72 m range):
     * cascade 1 covers 3.5-13 m — which is where *every* prop in every review frame
     * stands — with an ortho of **43.2 m across 1024 texels, i.e. 42 mm per texel**, and
     * cascade 2 lands on 310 mm. A stabilised cascade is fitted to the bounding sphere
     * of its frustum slice, and at a 78 degree FOV that sphere is dominated by the far
     * cap: radius = far * sqrt(tanH² + tanV²) = 13.08 * 1.65 = 21.6 m for a slice only
     * 9.6 m long. So a 0.6 m barrel was being rasterised into 14 texels, and PCSS then
     * blurred what survived by up to nine of them. That is the review's "nothing on the
     * ground but a contact smear" and its "20-40 px of structureless gradient", and it
     * is *not* a caster-set problem — the audit below confirms 529 of 592 meshes cast,
     * including all 42 skinned soldier parts and 49 instanced batches.
     *
     * Four cascades over the same 72 m re-splits it to 0.15 / 2.4 / 6.6 / 19.3 / 72, and
     * the band the props live in goes from 42 mm to 21 mm texels — the difference
     * between a barrel edge being half a texel and being one and a half. It costs one
     * extra shadow render, and the stagger already halves the two far ones.
     */
    /**
     * Four cascades is a floor, not a preference — measured in-engine, it is the whole
     * of the review's item 1. `Settings` gives the medium tier three, and at a 78 degree
     * FOV three cascades over 72 m puts the 3.5-13 m slice — which is where *every* prop
     * in every review frame stands — on an ortho of **43.2 m across 1024 texels, 42 mm
     * per texel**, with the last cascade at 310 mm. A stabilised cascade is fitted to
     * the bounding sphere of its frustum slice, and at that FOV the sphere is dominated
     * by the far cap: radius = far · sqrt(tanH² + tanV²) = 13.08 · 1.65 = 21.6 m for a
     * slice only 9.6 m long. A 0.6 m barrel was therefore rasterising into 14 texels and
     * PCSS was blurring what survived across up to nine more. That is exactly the
     * review's "nothing on the ground but a contact smear" and its "20-40 px of
     * structureless gradient" — and it is *not* a caster-set problem: the audit in
     * `_enrolCaster` measures 529 of 592 meshes casting, including all 42 skinned
     * soldier parts and 49 instanced batches.
     *
     * Splitting the same 72 m four ways gives 0.15 / 2.4 / 6.6 / 19.3 / 72 and takes the
     * prop band from 42 mm to 21 mm. It costs one extra shadow render; the stagger
     * already refreshes the two far cascades on alternate frames.
     */
    const wantCascades = this.tier === 'low' ? Math.min(cascades, 2) : Math.max(cascades, 4);
    let dirty = false;
    dirty = this.csm.setCascadeCount(wantCascades) || dirty;
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
      // Other modules re-run their own castShadow pass on `quality:changed`; re-audit
      // rather than trust the memo, or a tier change silently empties the caster set.
      this._audited = new WeakSet();
      if (dirty) this._invalidateShaders();
    }
  }

  _applyCascades(n) {
    // Same floor as setQuality — see the note there on why four is not negotiable.
    const want = this.tier === 'low' ? Math.min(n, 2) : Math.max(n, 4);
    if (this.csm.setCascadeCount(want)) {
      this.uniforms.uCsmSplits = this.csm.uniforms.uCsmSplits;
      this.uniforms.uCsmParams = this.csm.uniforms.uCsmParams;
      this.uniforms.uCsmControl = this.csm.uniforms.uCsmControl;
      this._invalidateShaders();
    }
  }

  setShadowsEnabled(on) {
    const was = this.shadowsEnabled;
    this.shadowsEnabled = !!on;
    if (!was && this.shadowsEnabled) {
      this._audited = new WeakSet();
      this._scanFrame = -999;
    }
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

  /* ────────────────────────────────────────────────────────────── key staging */

  /**
   * **Stage the key light.** Time of day picks an hour; this picks a *shot*.
   *
   *   ctx.lighting.setSunStaging({ azimuth, altitude, kelvin })
   *   ctx.lighting.setSunStaging({ azimuthOffset: -55 })   // relative to the camera
   *   ctx.lighting.setSunStaging(null)                     // release everything
   *
   * or, per review pose, as fields on the pose's `state` object — `sunAzimuth`,
   * `sunAltitude`, `sunAzimuthOffset`, `sunKelvin` — which arrive on `debug:pose`.
   *
   *   azimuth         degrees clockwise from -Z. 0 north, 90 = +X, 180 south.
   *   azimuthOffset   degrees from the camera's own view bearing, + = to the right.
   *                   Resolved once, at the moment it is set, against the live camera:
   *                   -70..-40 or +40..+70 puts the key three-quarters front and drops
   *                   the shadows back toward the lens where they can be seen.
   *   altitude        degrees above the horizon.
   *   kelvin          key colour temperature. Colour only — the disc, the sky and the
   *                   intensity stay physical. This is the cheap half of the golden
   *                   hour lie and the only part of the model that is allowed to be a
   *                   lie, because a warm key over a geometrically honest sun reads
   *                   correct while the reverse does not.
   *
   * Geometry is forwarded to `ctx.sky` so the dome, the disc, the clouds and the
   * aerial perspective re-aim with it; it is also re-applied locally every frame so
   * the rig still works against a sky stub that ignores the call.
   */
  setSunStaging(opts) {
    const s = this.sunStaging;
    if (!opts) {
      s.azimuth = null;
      s.altitude = null;
      s.kelvin = null;
    } else {
      const num = (v) => (Number.isFinite(v) ? v : null);
      if ('azimuth' in opts) s.azimuth = num(opts.azimuth);
      if ('azimuthOffset' in opts && Number.isFinite(opts.azimuthOffset)) {
        s.azimuth = this._cameraAzimuth() + opts.azimuthOffset;
      }
      if ('altitude' in opts) s.altitude = num(opts.altitude);
      if ('kelvin' in opts) s.kelvin = num(opts.kelvin);
    }
    if (s.azimuth !== null) s.azimuth = ((s.azimuth % 360) + 360) % 360;

    try {
      // Kelvin goes across too: the sky module owns the grade now (see Sky._gradeSun),
      // so the clouds, the cirrus, the aerial perspective and the disc are warmed by the
      // same curve as the key instead of only the key being warmed after the fact.
      this.ctx.sky?.setSunStaging?.({ azimuth: s.azimuth, altitude: s.altitude, kelvin: s.kelvin });
    } catch (err) {
      this._warn('staging', 'sky.setSunStaging failed', err);
    }
    this._syncFromSky(true);
    this._rebuildIBL(true);
    this.contact.valid = false;
    this.probes.refresh();
    return { ...s };
  }

  /** Camera view bearing in degrees, same convention as `azimuth`. */
  _cameraAzimuth() {
    const cam = this.ctx.camera;
    if (!cam) return 0;
    _v3.set(0, 0, -1).applyQuaternion(cam.quaternion);
    return (Math.atan2(_v3.x, -_v3.z) * 180) / Math.PI;
  }

  /** Re-aim `this.sunDirection` onto the staged bearing. Absolute, so idempotent. */
  _applyStaging() {
    const s = this.sunStaging;
    if (s.azimuth === null && s.altitude === null) return;
    const d = this.sunDirection;
    const alt =
      s.altitude === null ? Math.asin(clamp(d.y, -1, 1)) : (s.altitude * Math.PI) / 180;
    const az = s.azimuth === null ? Math.atan2(d.x, -d.z) : (s.azimuth * Math.PI) / 180;
    const ca = Math.cos(alt);
    d.set(Math.sin(az) * ca, Math.sin(alt), -Math.cos(az) * ca).normalize();
  }

  /**
   * **Key colour temperature.** The one place this rig is allowed to lie, and it has
   * to, because the two things golden hour is made of pull in opposite directions on
   * this map: the *colour* wants a 4-6 deg sun and the *lit floor* wants 15 (see the
   * warp table in Sky.js — below 8 deg the canyon shadows 91% of the visible ground).
   *
   * So the geometry stays honest and the colour is graded. The disc's own atmospheric
   * transmittance at a 15 deg sun is (1, 0.78, 0.55) peak-normalised, which is about
   * 4900 K — the review measured the resulting frame at a channel spread of 2 parts in
   * 255 and called it grey, correctly. A camera at golden hour records 2800-3500 K.
   * The curve below lands 3400 K at 15 deg and fades itself out entirely above ~40 deg
   * so harsh noon is left exactly as physics delivers it.
   *
   * Only the *hue* moves: `kelvinToLinearRGB` normalises to unit luminance and the sky
   * normalises to unit peak, so re-peaking preserves how bright the key reads. And it
   * only ever applies when the sun is the key — grading the moon orange at moonrise
   * would be a bug, not a look.
   */
  _gradeKey() {
    if (this.sunIntensity <= 1e-4) return;
    const sky = this.ctx.sky;
    if (sky && (sky.moonIntensity ?? 0) > (sky.sunIntensity ?? 0)) return;

    const altDeg = (Math.asin(clamp(this.sunDirection.y, -1, 1)) * 180) / Math.PI;
    if (altDeg <= 0) return;

    let kelvin = this.sunStaging.kelvin;
    let weight = 1;
    if (kelvin === null) {
      kelvin = clamp(2450 + 62 * altDeg, 2300, 6500);
      // Cross-fade back to the physical disc as the sun climbs out of the warm band.
      const t = clamp01((altDeg - 24) / 18);
      weight = 1 - t * t * (3 - 2 * t);
      if (weight <= 0.001) return;
    }

    kelvinToLinearRGB(kelvin, _color);
    const peak = Math.max(_color.r, _color.g, _color.b, 1e-6);
    this.sunColor.setRGB(
      this.sunColor.r + (_color.r / peak - this.sunColor.r) * weight,
      this.sunColor.g + (_color.g / peak - this.sunColor.g) * weight,
      this.sunColor.b + (_color.b / peak - this.sunColor.b) * weight
    );
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

    this._applyStaging();
    this._gradeKey();

    /**
     * **How much daylight is *here*, not how far the sun is above the horizon.**
     *
     * `daylight` gates every practical in the level (see LightManager.update), and it
     * asked exactly one question: is the sun up? Any sun above ~6 degrees switched the
     * whole rig off at 5 % — including the market stall lamps four metres in front of
     * the hero camera, standing in a canyon whose floor the sun does not reach until it
     * clears 27 degrees. That is why the signature frame's near foreground was cold and
     * dead: the only light sources aimed at it were being told it was the middle of the
     * day, and the review's brief for that foreground ("a local fill light motivated
     * by" something in the scene) was already standing in the shot, switched off.
     *
     * The horizon probe already measures both halves of the real question — how much
     * sky this spot can see, and how much of the ground around it the key actually
     * reaches — so use them. In the open the term is ~1 and nothing changes; in a
     * shaded canyon it lands near 0.7, which brings a 42 W stall lamp back to about a
     * third of its rated output: a warm pool roughly twice the shadow ambient, which
     * is what a market at golden hour actually looks like, and nowhere near the
     * "brighter than the sun" failure that made the blanket dimmer necessary.
     */
    const hz = this._hz;
    const localShade = hz
      ? clamp01(0.3 + 0.7 * hz.openSky) * clamp01(0.45 + 0.55 * hz.groundLit)
      : 1;
    /**
     * **Ask the sun, not the key.** `sunDirection` / `sunIntensity` on this class are
     * the *key light*, which after dusk is the moon — so at the 21.5 night pose the
     * daylight test was reading a moon 24 degrees up at intensity 0.97, concluding it
     * was daytime, and dimming every street lamp in the level to 5 % of its rating on
     * the one frame whose entire subject is street lamps. Sky publishes the solar
     * terms separately; use those, and fall back to the key only when there is no sky.
     */
    const skySun = this.ctx.sky;
    const solarY = skySun?.sunDirection ? skySun.sunDirection.y : this.sunDirection.y;
    const solarI = Number.isFinite(skySun?.sunIntensity) ? skySun.sunIntensity : this.sunIntensity;
    this.daylight =
      clamp01((solarY - 0.005) / 0.1) * clamp01(solarI / 0.6) * (0.45 + 0.55 * localShade);

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
        const v = new THREE.Vector3(sinT * Math.cos(phi), cosT, sinT * Math.sin(phi));
        // Which horizon bin this direction falls in, resolved once: the grid is fixed,
        // so the bin and its interpolation weight never change.
        const az = Math.atan2(v.x, -v.z) / (Math.PI * 2); // -0.5 .. 0.5 turns
        const f = (az - Math.floor(az)) * HZ_BINS - 0.5;
        const b0 = Math.floor(f);
        dirs.push({
          v,
          w: dOmega,
          up: cosT,
          bin: ((b0 % HZ_BINS) + HZ_BINS) % HZ_BINS,
          binF: f - b0,
        });
      }
    }
    this._shDirs = dirs;
    this._shCache = dirs.map(() => new THREE.Color());
    return dirs;
  }

  /** Cache key for the local environment probe: where we stand, and where the sun is. */
  _envKey() {
    const cam = this.ctx.camera;
    if (!cam) return '';
    const p = cam.position;
    const d = this.sunDirection;
    return `${Math.round(p.x * 0.5)},${Math.round(p.y * 0.5)},${Math.round(p.z * 0.5)}|${Math.round(
      d.x * 40
    )},${Math.round(d.y * 40)},${Math.round(d.z * 40)}|${Math.round(this.sunIntensity * 8)}`;
  }

  /**
   * **Measure the surroundings instead of assuming them.** See the HZ_* block above.
   *
   * Builds, from the camera, a 16-bin horizon profile plus the one-bounce radiance of
   * whatever stands below each bin's skyline, and a measured ground bounce. Every
   * bounce is shaded properly: the occluder's own N·L, its own sun visibility by
   * raycast, and its own sky visibility by one vertical ray — so a wall inside a
   * building bounces interior light, not an open field's.
   *
   * @param {number} eR sky irradiance on an unoccluded horizontal plane, per channel
   * @returns {object|null} the cached profile, or null when there is no physics world
   */
  _gatherLocalEnvironment(eR, eG, eB) {
    const ctx = this.ctx;
    const phys = ctx.physics;
    const cam = ctx.camera;
    if (!phys?.raycast || !cam) return null;
    const key = this._envKey();
    if (this._hz && this._hzKey === key) return this._hz;

    const hz =
      this._hz ||
      (this._hz = {
        sky: new Float32Array(HZ_BINS),
        r: new Float32Array(HZ_BINS),
        g: new Float32Array(HZ_BINS),
        b: new Float32Array(HZ_BINS),
        ground: [0, 0, 0],
        groundLit: 0,
        openSky: 1,
        rays: 0,
      });

    const MASK = 1 | 8; // WORLD | PROP
    const sun = this.sunDirection;
    const sunI = this.sunIntensity;
    const sunC = this.sunColor;
    const INV_PI = 1 / Math.PI;
    let rays = 0;

    /**
     * One-bounce radiance leaving a surface the probe hit. Writes into `_color` and
     * leaves the surface's sun visibility in `this._hzVis`.
     */
    const shade = (hit, checkRoof) => {
      const n = _hzN;
      if (hit.normal && hit.normal.lengthSq() > 1e-6) n.copy(hit.normal).normalize();
      else n.copy(_UP);
      const gain = BOUNCE_GAIN[hit.surface] ?? 1;
      const nl = Math.max(n.dot(sun), 0);
      let vis = 0;
      if (nl > 0.001 && sunI > 1e-4) {
        _hzP.copy(hit.point).addScaledVector(n, 0.06);
        rays++;
        vis = phys.raycast(_hzP, sun, 180, MASK) ? 0 : 1;
      }
      let openUp = 1;
      if (checkRoof) {
        _hzP.copy(hit.point).addScaledVector(n, 0.06);
        rays++;
        // Can this surface see the sky at all? A wall in a closed hall cannot, and
        // handing it a field's worth of skylight is exactly how an interior ends up
        // lit like an exterior. Only asked for where the bearing looks enclosed —
        // outdoors the answer is always yes and the ray is wasted.
        openUp = phys.raycast(_hzP, _UP, 40, MASK) ? 0.2 : 1;
      }
      const skyW = (0.5 + 0.5 * n.y) * openUp;
      const e = sunI * nl * vis;
      this._hzVis = vis;
      _color.setRGB(
        BOUNCE_ALBEDO.r * gain * (e * sunC.r + eR * skyW) * INV_PI,
        BOUNCE_ALBEDO.g * gain * (e * sunC.g + eG * skyW) * INV_PI,
        BOUNCE_ALBEDO.b * gain * (e * sunC.b + eB * skyW) * INV_PI
      );
    };

    /* ── ground first: it doubles as the fallback bounce for open bearings ──── */
    let gr = 0;
    let gg = 0;
    let gb = 0;
    let gn = 0;
    let glit = 0;
    for (let k = 0; k < 16; k++) {
      const az = (k / 16) * Math.PI * 2;
      // Spread over the whole near field, not just the pocket the camera is standing
      // in: 12 samples all inside one prop's shadow measured a sunlit fraction of 0.00
      // on a plaza that raycasts at 0.30, and the ground bounce came out pure skylight.
      const rad = 3 + (k % 4) * 4.5;
      // Start just above the eye, not high above it: from a metre over the roof an
      // interior probe measures the roof, not the floor it is standing on.
      _hzP.set(cam.position.x + Math.sin(az) * rad, cam.position.y + 2.2, cam.position.z - Math.cos(az) * rad);
      rays++;
      const h = phys.raycast(_hzP, _DOWN, 30, MASK);
      if (!h) continue;
      shade(h, false);
      gr += _color.r;
      gg += _color.g;
      gb += _color.b;
      glit += this._hzVis;
      gn++;
    }
    if (gn > 0) {
      hz.ground[0] = gr / gn;
      hz.ground[1] = gg / gn;
      hz.ground[2] = gb / gn;
      hz.groundLit = glit / gn;
    } else {
      hz.ground[0] = hz.ground[1] = hz.ground[2] = 0;
      hz.groundLit = 0;
    }

    /* ── the horizon fan ─────────────────────────────────────────────────────── */
    _hzO.copy(cam.position);
    // One ray decides whether the *probe* is under a roof, and therefore whether the
    // surfaces it hits need their own sky-visibility test. Outdoors the answer is
    // always "yes, it sees sky" and the extra 64 rays buy nothing.
    rays++;
    const enclosed = !!phys.raycast(_hzO, _UP, 45, MASK);
    let open = 0;
    for (let b = 0; b < HZ_BINS; b++) {
      const az = ((b + 0.5) / HZ_BINS) * Math.PI * 2;
      const sa = Math.sin(az);
      const ca = Math.cos(az);
      let line = 0.82; // nothing opened up all the way to 46 deg: treat as roofed
      /**
       * **Shade the whole occluded column, not just its foot.**
       *
       * The first version sampled only the lowest hit — 2 degrees up, which on a
       * street is the shadowed base of a wall or the side of a bench. At a 15 degree
       * sun *nothing* down there is lit, so every one of the 16 bearings measured a
       * bounce of 0.005 in luminance and the "warm facade opposite" the whole term
       * exists to capture never appeared. The card is the upper storeys: an ochre
       * plaster wall at N·L 0.39 under an 8.7 key leaves 0.38 of radiance, eleven times
       * the zenith in red. So walk the rungs, shade every other one, and average by the
       * cosine-weighted band each represents.
       */
      let br = 0;
      let bg = 0;
      let bb = 0;
      let bw = 0;
      let lr = 0;
      let lg = 0;
      let lb = 0;
      let shaded = false;
      for (let k = 0; k < HZ_LADDER.length; k++) {
        const s = HZ_LADDER[k];
        const c = Math.sqrt(Math.max(1 - s * s, 0));
        _hzD.set(sa * c, s, -ca * c);
        rays++;
        const h = phys.raycast(_hzO, _hzD, HZ_RANGE, MASK);
        if (!h) {
          // Sky starts somewhere between this rung and the last one.
          line = k === 0 ? 0 : (HZ_LADDER[k - 1] + s) * 0.5;
          break;
        }
        if (k % 2 === 0 || !shaded) {
          shade(h, enclosed);
          lr = _color.r;
          lg = _color.g;
          lb = _color.b;
          shaded = true;
        }
        // Cosine-weighted solid angle of the band this rung stands for: d(sin^2 e).
        const s0 = k === 0 ? 0 : (HZ_LADDER[k - 1] + s) * 0.5;
        const s1 = k + 1 < HZ_LADDER.length ? (s + HZ_LADDER[k + 1]) * 0.5 : 0.82;
        const wgt = Math.max(s1 * s1 - s0 * s0, 1e-4);
        br += lr * wgt;
        bg += lg * wgt;
        bb += lb * wgt;
        bw += wgt;
      }
      if (bw > 0) {
        hz.r[b] = br / bw;
        hz.g[b] = bg / bw;
        hz.b[b] = bb / bw;
      } else {
        hz.r[b] = hz.ground[0];
        hz.g[b] = hz.ground[1];
        hz.b[b] = hz.ground[2];
      }
      hz.sky[b] = line;
      open += 1 - line * line;
    }
    hz.openSky = open / HZ_BINS;
    hz.rays = rays;
    this._hzKey = key;
    return hz;
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

    /**
     * **The night floor.** `sampleSky()` is single scattering only, so after dusk it
     * returns ~0 and this SH — the only diffuse ambient in the whole rig — went to
     * black while the dome overhead was drawing airglow and a city's worth of sodium
     * spill. A sky that is visibly the brightest thing in the frame has to light the
     * street under it; Sky now publishes exactly the two terms its own shader adds.
     * Weighted toward the horizon, because that is where a light-polluted sky glows.
     */
    const nsky = sky?.nightSkyColor;
    if (nsky && nsky.r + nsky.g + nsky.b > 1e-6) {
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i];
        if (d.up <= 0) continue;
        const w = 0.45 + 0.55 * (1 - d.up);
        const c = this._shCache[i];
        c.r += nsky.r * w;
        c.g += nsky.g * w;
        c.b += nsky.b * w;
        eR += nsky.r * w * d.up * d.w;
        eG += nsky.g * w * d.up * d.w;
        eB += nsky.b * w * d.up * d.w;
      }
    }

    /**
     * One bounce off the environment. Without it every downward-facing surface —
     * chins, undersides of ledges, the bottom of a rifle — goes flat black and the
     * scene reads as CG.
     *
     * Two things have to be right or this term quietly becomes the whole lighting rig.
     *
     * **Albedo is spectral, not scalar.** A grey 0.30 multiplied the sky's own
     * (blue-dominant) irradiance as hard as it multiplied the sun's, so the "warm
     * bounce" it was supposed to add came out *bluer* than the sky it was correcting.
     * `BOUNCE_ALBEDO` is an area-weighted mix of asphalt (~0.10, neutral) and the
     * sandy stucco / terracotta the facades are actually made of (~0.35, warm), which
     * is what puts red back into the shadows without inventing brightness.
     *
     * **Only the *sunlit* part of the surroundings bounces sunlight.** The old term
     * used the full solar irradiance, i.e. it assumed every square metre around the
     * shading point was in direct sun. At a 16 deg sun in a 16 m canyon almost none of
     * it is, and the result was a lower hemisphere 5x brighter than the sky: measured
     * E(down) 0.75 against E(up) 0.49, so undersides were brighter than up-faces and
     * every shadow was filled to within a stop of its own key. `litGround` is a crude
     * elevation-driven stand-in for that fraction — 0 at the horizon, ~0.4 at golden
     * hour, 1 at noon when the sun clears everything — and it is the difference
     * between ambient that follows the sun and ambient that replaces it.
     */
    let hz = null;
    try {
      hz = this._gatherLocalEnvironment(eR, eG, eB);
    } catch (err) {
      this._warn('hzprobe', 'local environment probe failed, using the analytic skyline', err);
      hz = null;
    }

    const sunUp = Math.max(this.sunDirection.y, 0);
    const open = clamp01((sunUp - 0.06) / 0.5);
    // Floor at 0.3: the lower hemisphere is not only ground. Even when the street is
    // shadowed, the sunlit upper facades opposite are a large, warm, bright bounce
    // card, and dropping the whole term to the ground's lit fraction takes them with
    // it — the first pass at this cut the frame's mean luminance by a third and the
    // shadows went to mud.
    const litGround = 0.3 + 0.7 * open * open * (3 - 2 * open);
    const aR = BOUNCE_ALBEDO.r;
    const aG = BOUNCE_ALBEDO.g;
    const aB = BOUNCE_ALBEDO.b;
    const sunE = this.sunIntensity * sunUp * litGround;
    // The probe measured the ground it is actually standing on, sunlit fraction and
    // all; fall back to the elevation heuristic only when there is no physics world.
    const gR = hz ? hz.ground[0] : (aR * (sunE * this.sunColor.r + eR)) / Math.PI;
    const gG = hz ? hz.ground[1] : (aG * (sunE * this.sunColor.g + eG)) / Math.PI;
    const gB = hz ? hz.ground[2] : (aB * (sunE * this.sunColor.b + eB * 0.95)) / Math.PI;

    /**
     * **The skyline.** Everything above is the sky an observer standing in a field
     * would see, and this level is not a field. From the street the lowest 20-ish
     * degrees of every direction is not sky, it is the block opposite — and that band
     * is the *brightest* part of a clear morning sky (measured horizon radiance 1.25
     * against a zenith of 0.068), so leaving it unoccluded meant roughly half of all
     * diffuse irradiance arrived as bright blue light from directions that are
     * physically solid masonry. That is the whole reason shaded ground came out navy:
     * measured R/B 0.66 on the courtyard, bluer than the sky above it, next to a
     * sunlit ochre wall that in reality is throwing warm light straight at it.
     *
     * Replacing that band with the facade bounce is not a fudge, it is the missing
     * geometry term — and it is the cheap, global half of it. The per-pixel half is
     * the screen-space AO in the contact pass; this is what that AO is occluding
     * *towards*.
     */
    const SKYLINE_TOP = 0.34; // sin(20 deg): horizon-to-here is building, not sky
    const SKYLINE_FILL = 0.55; // it is a street, not a shaft — some sky still gets in
    // Facades are lighter than the road and catch more sun, so they bounce harder.
    const fR = gR * 1.45;
    const fG = gG * 1.45;
    const fB = gB * 1.45;

    const basis = [];
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      const c = this._shCache[i];
      let r;
      let g;
      let b;
      if (d.up <= -0.06) {
        r = gR;
        g = gG;
        b = gB;
      } else {
        // 1. sky, or whatever masonry is standing in front of it in this bearing
        let sr = c.r;
        let sg = c.g;
        let sb = c.b;
        if (hz) {
          const b0 = d.bin;
          const b1 = (b0 + 1) % HZ_BINS;
          const t = d.binF;
          const line = hz.sky[b0] + (hz.sky[b1] - hz.sky[b0]) * t;
          const occ = clamp01((line - d.up) / HZ_FEATHER + 0.5) * HZ_FILL;
          if (occ > 0.001) {
            sr += (hz.r[b0] + (hz.r[b1] - hz.r[b0]) * t - sr) * occ;
            sg += (hz.g[b0] + (hz.g[b1] - hz.g[b0]) * t - sg) * occ;
            sb += (hz.b[b0] + (hz.b[b1] - hz.b[b0]) * t - sb) * occ;
          }
        } else {
          const t = clamp01(d.up / SKYLINE_TOP);
          const occ = SKYLINE_FILL * (1 - t) * (1 - t);
          sr += (fR - sr) * occ;
          sg += (fG - sg) * occ;
          sb += (fB - sb) * occ;
        }
        // 2. soft blend into the ground term across the horizon, so the SH never has
        //    to resolve a hard step
        if (d.up < 0.06) {
          const t = (d.up + 0.06) / 0.12;
          r = gR + (sr - gR) * t;
          g = gG + (sg - gG) * t;
          b = gB + (sb - gB) * t;
        } else {
          r = sr;
          g = sg;
          b = sb;
        }
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

  /* ─────────────────────────────────────────────────────── transient flashes */

  /**
   * Fire a short-lived point light. Pooled: one handle is reused for the muzzle, so a
   * held trigger re-arms it rather than filling the request list.
   * @param {{origin?:any, point?:any, dir?:any, intensity?:number, radius?:number,
   *          life?:number, kelvin?:number}} e
   */
  _flash(e) {
    const src = e?.origin || e?.point || e?.position;
    if (!src) return;
    const isBlast = (e?.life ?? 0) > 0.1;
    const slot = isBlast ? '_blastLight' : '_muzzleLight';
    let h = this[slot];
    if (!h) {
      h = this[slot] = this.lights.addLight({
        type: 'point',
        intensity: 0,
        radius: 7,
        kelvin: e?.kelvin ?? 3600,
        priority: 6,
        daylight: true,
        enabled: false,
      });
    }
    const x = src.x ?? src[0] ?? 0;
    const y = src.y ?? src[1] ?? 0;
    const z = src.z ?? src[2] ?? 0;
    h.position.set(x, y, z);
    // Push it a little along the barrel so the flash is in front of the muzzle device
    // rather than inside it, or the first thing it lights is the suppressor's own back.
    const d = e?.dir;
    if (d) {
      const dx = d.x ?? d[0] ?? 0;
      const dy = d.y ?? d[1] ?? 0;
      const dz = d.z ?? d[2] ?? 0;
      const l = Math.hypot(dx, dy, dz) || 1;
      h.position.set(x + (dx / l) * 0.22, y + (dy / l) * 0.22, z + (dz / l) * 0.22);
    }
    if (Number.isFinite(e?.kelvin)) kelvinToLinearRGB(e.kelvin, h.color);
    h.radius = e?.radius ?? 7;
    /**
     * Intensity is candela-like and falls off as 1/d², in the same units as the level's
     * practicals (a 42 W street lamp 4.6 m up puts ~2 on the pavement). Measured, after
     * getting it wrong once: at 190 the flash put ~50 units of irradiance on a barrier
     * three metres out — six times a sunlit facade — and the bloom/flare chain answered
     * with rainbow ghosts across a third of the firefight frame. 36 lands about a stop
     * over sunlit at 2 m and falls under the ambient by 6 m, which is what a flash
     * actually does in daylight.
     */
    h._flashPeak = e?.intensity ?? 36;
    h.intensity = h._flashPeak;
    h.enabled = true;
    h._flashLife = e?.life ?? 0.055;
    h._flashAge = 0;
  }

  /** Decay whatever `_flash` armed. Called once per frame from update(). */
  _tickFlashes(dt) {
    for (const slot of ['_muzzleLight', '_blastLight']) {
      const h = this[slot];
      if (!h || !h.enabled) continue;
      h._flashAge += dt;
      const t = clamp01(1 - h._flashAge / Math.max(h._flashLife, 1e-3));
      if (t <= 0) {
        h.enabled = false;
        h.intensity = 0;
      } else {
        // Quadratic decay: a flash is over long before its afterglow is.
        h.intensity = (h._flashPeak ?? 36) * t * t;
      }
    }
  }

  /* ──────────────────────────────────────────────── bounce floor & portals */

  /**
   * **What the ambient occlusion occludes towards.**
   *
   * The horizon probe already measures, per compass bearing, the one-bounce radiance of
   * whatever masonry is standing in that direction, plus the radiance of the ground it
   * is standing on. That is exactly the light a screen-space AO tap is blocking when it
   * says "occluded": not the sky, the *wall*. Average it (weighted towards the ground,
   * because near-field occluders — a kerb, a crate, a counter, an awning post — are more
   * often below the shading point than beside it), multiply by pi to turn radiance into
   * the irradiance of a fully enclosing hemisphere, and hand it to the shader.
   *
   * Without a physics world there is no probe, so fall back to the SH's own DC term at a
   * plausible albedo — still coloured, still not zero.
   */
  _updateBounce() {
    const u = this.uniforms.uCodBounce.value;
    const hz = this._hz;
    let r = 0;
    let g = 0;
    let b = 0;
    if (hz) {
      for (let i = 0; i < HZ_BINS; i++) {
        r += hz.r[i];
        g += hz.g[i];
        b += hz.b[i];
      }
      const inv = 1 / HZ_BINS;
      r = r * inv * 0.45 + hz.ground[0] * 0.55;
      g = g * inv * 0.45 + hz.ground[1] * 0.55;
      b = b * inv * 0.45 + hz.ground[2] * 0.55;
    } else if (this._shValid) {
      const c = this.sh.coefficients[0];
      // Y00 = 0.2820948; irradiance of the DC term is 0.886227 * c0 * Y00-ish. Take a
      // conservative tenth of it as "what a nearby surface bounces back".
      r = Math.max(c.x, 0) * 0.0282;
      g = Math.max(c.y, 0) * 0.0282;
      b = Math.max(c.z, 0) * 0.0282;
    }
    u.set(Math.max(r, 0) * Math.PI, Math.max(g, 0) * Math.PI, Math.max(b, 0) * Math.PI, this.bounceGain);
    this.uniforms.uCodAoFloor.value.x = this.aoFloor;
  }

  /**
   * **Aperture area lights.** See the `codPortalIrradiance` GLSL for the shading model
   * and `world/Level.js collectPortals()` for where the rectangles come from.
   *
   * This runs on the CPU a couple of times a second, not per frame: the selection only
   * changes when the camera moves, and the radiance only when the sun does.
   *
   * Radiance of an opening, looking out of it:
   *   • the sky in that bearing, from the same scattering model everything else uses;
   *   • the sunlit ground and facade outside, from the horizon probe;
   *   • plus, when the sun can actually see the aperture, the solar irradiance it
   *     transmits, spread Lambertian over the opening — which is what makes a window
   *     on the sun side a hard warm source and one in shade a soft blue one.
   * Glazing takes ~18 % off, because it does.
   */
  _updatePortals(dt) {
    const uP = this.uniforms.uCodPortalP.value;
    const uN = this.uniforms.uCodPortalN.value;
    const uC = this.uniforms.uCodPortalC.value;
    const cam = this.ctx.camera;
    const list = this.ctx.level?.portals;
    const off = () => {
      for (let i = 0; i < PORTAL_SLOTS; i++) uC[i].w = 0;
      this.portalCount = 0;
    };
    if (!cam || !this.portalsEnabled || !Array.isArray(list) || !list.length) return off();

    this._portalTimer += dt;
    const moved = this._portalAnchor.distanceToSquared(cam.position) > 0.9;
    if (!moved && this._portalTimer < 0.4 && this._portalReady) return;
    this._portalTimer = 0;
    this._portalAnchor.copy(cam.position);
    this._portalReady = true;

    const RANGE = 17;
    const cands = this._portalCands || (this._portalCands = []);
    cands.length = 0;
    const cp = cam.position;
    for (const p of list) {
      const dx = p.x - cp.x;
      const dy = p.y - cp.y;
      const dz = p.z - cp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > RANGE * RANGE) continue;
      // The camera has to be on the room side, or this is somebody else's window.
      // A two-sided arch (negative hh) lights either side, so it never fails this.
      if (p.hh > 0 && dx * p.nx + dz * p.nz > -0.25) continue;
      const area = 4 * p.hw * Math.abs(p.hh);
      cands.push({ p, d2, score: area / Math.max(d2, 1) });
    }
    if (!cands.length) return off();
    cands.sort((a, b) => b.score - a.score);

    const sky = this.ctx.sky;
    const phys = this.ctx.physics;
    const hz = this._hz;
    const n = Math.min(PORTAL_SLOTS, cands.length);
    for (let i = 0; i < n; i++) {
      const p = cands[i].p;
      // Outward, tilted up: a window mostly sees sky above the block opposite.
      _hzD.set(-p.nx * 0.72, 0.5, -p.nz * 0.72).normalize();
      let sr = 0;
      let sg = 0;
      let sb = 0;
      if (sky?.sampleSky) {
        try {
          sky.sampleSky(_hzD, _color);
          sr = Math.max(_color.r, 0);
          sg = Math.max(_color.g, 0);
          sb = Math.max(_color.b, 0);
        } catch {
          /* the fallback below still lights the room */
        }
      }
      if (sr + sg + sb < 1e-5 && sky?.horizonColor) {
        sr = sky.horizonColor.r;
        sg = sky.horizonColor.g;
        sb = sky.horizonColor.b;
      }
      let r = sr * 0.55;
      let g = sg * 0.55;
      let b = sb * 0.55;
      if (hz) {
        r += hz.ground[0] * 1.1;
        g += hz.ground[1] * 1.1;
        b += hz.ground[2] * 1.1;
      }
      // Direct sun arriving at the outside face. The aperture's normal is horizontal,
      // so only the sun's horizontal component lands on it.
      const sd = this.sunDirection;
      const face = -(p.nx * sd.x + p.nz * sd.z);
      if (face > 0.02 && this.sunIntensity > 1e-3 && sd.y > 0) {
        let vis = 1;
        if (phys?.raycast) {
          _hzP.set(p.x - p.nx * 0.5, p.y, p.z - p.nz * 0.5);
          try {
            vis = phys.raycast(_hzP, sd, 140, 1 | 8) ? 0 : 1;
          } catch {
            vis = 0;
          }
        }
        if (vis > 0) {
          // E·cos / pi: the solar irradiance the opening transmits, re-emitted diffusely.
          const k = (this.sunIntensity * face * this.portalSunGain) / Math.PI;
          r += this.sunColor.r * k;
          g += this.sunColor.g * k;
          b += this.sunColor.b * k;
        }
      }
      // Glazing transmits ~82 %; a two-sided arch is looking into a covered walkway,
      // which is the street at second hand.
      const t = (p.glazed ? 0.82 : 1) * (p.hh < 0 ? 0.55 : 1);
      const gain = this.portalGain * t;
      uP[i].set(p.x, p.y, p.z, p.hw);
      uN[i].set(p.nx, 0, p.nz, p.hh);
      uC[i].set(r * gain, g * gain, b * gain, RANGE);
    }
    for (let i = n; i < PORTAL_SLOTS; i++) uC[i].w = 0;
    this.portalCount = n;
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

// ═════════════════ window / door apertures as area lights ═════════════════
/**
 * **A room is lit by its openings, not by the beam that happens to reach the floor.**
 *
 * The interior review measured window panes at 1.7:1 over the wall beside them, no
 * reveal wash, no spill and no directional cue anywhere in a 30 x 25 m hall — because
 * at the staged sun the beam geometrically cannot reach the ground storey, so *every*
 * lighting term in the rig honestly returned "nothing here". The missing physics is
 * that an aperture is a luminous rectangle in its own right: it radiates the sky and
 * the sunlit street outside it into the room whether or not a single ray of direct sun
 * makes it through.
 *
 * Each portal is a rectangle with an inward normal. The irradiance a fragment receives
 * is the standard disc-solid-angle approximation of a diffuse rectangle,
 *   E = L · A · cos(theta_portal) · cos(theta_surface) / ( d² + A/pi ),
 * which is exact at range, finite at the aperture plane, and costs one normalise and a
 * divide. The +A/pi is what stops a fragment in the reveal itself going to infinity.
 *
 * Radiance, the aperture's inward-facing side, and which side of the wall is "inside"
 * are all resolved on the CPU — see Lighting._updatePortals.
 */
uniform vec4 uCodPortalP[ ${PORTAL_SLOTS} ];   // xyz centre (world), w half-width
uniform vec4 uCodPortalN[ ${PORTAL_SLOTS} ];   // xyz inward normal, w half-height
uniform vec4 uCodPortalC[ ${PORTAL_SLOTS} ];   // rgb radiance, w range (m); w<=0 = unused
uniform mat4 uCodInvView;
uniform vec4 uCodBounce;    // rgb measured one-bounce irradiance of the surroundings, w gain
uniform vec2 uCodAoFloor;   // x: how far the indirect AO is allowed to close

vec3 codPortalIrradiance( vec3 wp, vec3 wn ) {
	vec3 sum = vec3( 0.0 );
	for ( int i = 0; i < ${PORTAL_SLOTS}; i ++ ) {
		vec4 C = uCodPortalC[ i ];
		if ( C.w <= 0.0 ) continue;
		vec4 P = uCodPortalP[ i ];
		vec4 N = uCodPortalN[ i ];
		vec3 d = P.xyz - wp;
		float dist2 = dot( d, d );
		float rng2 = C.w * C.w;
		if ( dist2 > rng2 ) continue;
		vec3 l = d * inversesqrt( max( dist2, 1e-6 ) );
		// The fragment has to be on the lit side of the aperture, and the aperture has
		// to be turned towards it: two cosines, both clamped, no light behind the wall.
		// A negative half-height marks a two-sided aperture — a colonnade arch between
		// two covered spaces — which radiates into whichever of them the fragment is in.
		float hh = abs( N.w );
		float facing = dot( -l, N.xyz );
		if ( N.w < 0.0 ) facing = abs( facing );
		if ( facing <= 0.03 ) continue;
		float ndl = dot( wn, l );
		if ( ndl <= 0.0 ) continue;
		float area = 4.0 * P.w * hh;
		float e = area * facing * ndl / ( dist2 + area * 0.3183099 );
		// Smooth range cut so a portal never pops as the camera walks past its radius.
		float fade = 1.0 - dist2 / rng2;
		sum += C.rgb * ( e * fade * fade );
	}
	return sum;
}
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
uniform vec4 uCodContactParams; // x sun strength, y depth normaliser, z AO strength

/**
 * The buffer was marched against last frame's depth, so we reproject this fragment
 * into the frame it was captured in and reject the sample when the depths disagree —
 * otherwise disoccluded pixels drag a smear of stale occlusion behind moving geometry.
 * Returns (sun contact shadow, ambient occlusion); (1, 1) whenever the sample cannot
 * be trusted, so a rejection can only ever *remove* occlusion, never invent it.
 */
vec2 codContactSample( vec3 viewPos ) {
	vec4 c = uCodContactMtx * vec4( viewPos, 1.0 );
	if ( c.w <= 0.0 ) return vec2( 1.0 );
	vec2 uv = c.xy / c.w * 0.5 + 0.5;
	if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return vec2( 1.0 );
	vec4 t = texture2D( uCodContactMap, uv );
	float stored = ( t.g + t.b * ( 1.0 / 255.0 ) ) * uCodContactParams.y;
	float expect = c.w;
	if ( abs( stored - expect ) > max( 0.08, expect * 0.02 ) ) return vec2( 1.0 );
	return vec2( t.r, t.a );
}

float codContactShadow( vec3 viewPos ) {
	if ( uCodContactParams.x <= 0.0 ) return 1.0;
	return mix( 1.0, codContactSample( viewPos ).x, uCodContactParams.x );
}

/**
 * Ambient occlusion for the *indirect* term. The sun contact shadow above only
 * exists where the key light does; this is what keeps a bench leg attached to the
 * pavement in open shade, at night, or indoors — the cases where the whole frame is
 * IBL and an unoccluded SH lookup makes every object float.
 */
float codContactAO( vec3 viewPos ) {
	if ( uCodContactParams.z <= 0.0 ) return 1.0;
	return mix( 1.0, codContactSample( viewPos ).y, uCodContactParams.z );
}
`;
    }

    if (useProbes) {
      pars += this.probes.parsGLSL();
      pars += `
#if defined( COD_PROBES )
// uCodInvView is declared once, above, next to the portal block.

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
    if (useContact) {
      /**
       * Occlude the indirect term. This is the half of "grounding" that the pipeline's
       * post-composite GTAO cannot do: that pass multiplies the *finished* pixel and
       * has to guess, from luminance, how much of it was direct light so it does not
       * darken sunlight. Here we are inside the material with the two terms still
       * separate, so the AO lands on exactly what it physically occludes — the sky and
       * bounce arriving at this fragment — and never touches the sun.
       *
       * `iblIrradiance` is what RE_IndirectSpecular_Physical turns into the cosine-
       * weighted diffuse, so for a standard/physical material this is the whole IBL
       * diffuse path. Specular gets a gentler share: a rough surface integrates a wide
       * lobe and is genuinely occluded, a mirror is not.
       *
       * ── Occlusion multiplies towards the bounce, not towards zero ─────────────
       * A straight `iblIrradiance *= ao` says that a fully occluded fragment receives
       * no light at all, which is only true inside a sealed black box. Physically, what
       * an occluder does is *replace* the sky in that solid angle with itself — and the
       * things doing the occluding here are a sunlit ochre facade, a pavement and a
       * canvas awning, none of which are black. The review measured the consequence:
       * a 25-pixel profile down the hero wall into the awning falling from L 128 to
       * RGB [1, 6, 19], and a third of the frame under L 32.
       *
       * So the occluded fraction is handed the *measured* one-bounce radiance of the
       * surroundings (`uCodBounce`, filled from the same horizon probe the SH is built
       * from) instead of nothing, and the multiplier itself is floored so a crevice
       * that the screen-space estimator over-occludes cannot reach black on its own.
       * Energy still goes down with occlusion — the bounce is roughly a tenth of open
       * sky — it just goes down to the right colour.
       */
      mapsChunk += `
#if defined( COD_CONTACT ) && defined( RE_IndirectDiffuse )
	float codAoRaw = codContactAO( geometryPosition );
	float codAo = mix( uCodAoFloor.x, 1.0, codAoRaw );
	vec3 codFill = uCodBounce.rgb * ( ( 1.0 - codAoRaw ) * uCodBounce.a );
	iblIrradiance = iblIrradiance * codAo + codFill;
	irradiance *= codAo;
	#if defined( RE_IndirectSpecular )
		radiance *= mix( 1.0, codAo, 0.55 * material.roughness + 0.15 );
	#endif
#endif
`;
    }

    /* ---- aperture portals: an opening lights the room it opens into ---- */
    mapsChunk += `
#if defined( RE_IndirectDiffuse )
	{
		vec3 codPw = ( uCodInvView * vec4( geometryPosition, 1.0 ) ).xyz;
		vec3 codNw = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
		iblIrradiance += codPortalIrradiance( codPw, codNw );
	}
#endif
`;

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

    const visitWorld = (obj) => {
      if (obj.isMesh || obj.isInstancedMesh || obj.isSkinnedMesh) {
        this._enrolCaster(obj);
        this._suppressGlazingShadow(obj);
      }
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) {
        for (const mm of m) this._patch(mm);
      } else {
        this._patch(m);
      }
    };
    const visitView = (obj) => {
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) {
        for (const mm of m) this._patch(mm);
      } else {
        this._patch(m);
      }
    };
    try {
      this.ctx.scene?.traverse(visitWorld);
      this.ctx.viewScene?.traverse(visitView);
    } catch (err) {
      this._warn('scan', 'material scan failed', err);
    }
  }

  /**
   * **The caster audit.** Nothing in this rig ever decided *what* casts — that was left
   * to eleven other modules, each with its own opinion and its own bug, and the review
   * measured the result: buildings and kerbs cast, and props, instanced street furniture,
   * foliage and soldiers did not. A barrel four metres from the lens, lit 3.4:1 side to
   * side, put nothing on the pavement.
   *
   * Shadow casting is a *lighting* decision, so it is made here, once, for the whole
   * scene, and the rule is the physical one: **opaque geometry casts.** The exclusions
   * below are all cases where a depth-buffer footprint would be a lie —
   *
   *   • the sky dome, the cloud shell, the star field and the horizon/backdrop rings,
   *     which are either at infinity or deliberately outside the shadow range;
   *   • decals, contact grime and road paint, which are coplanar with what they sit on
   *     and would shadow-acne their own receiver;
   *   • sprites, impostors, tracers, muzzle flashes, sparks, smoke and motes, which are
   *     camera-facing or additive and have no solid form to project;
   *   • anything a module explicitly opted out with `userData.noShadow`;
   *   • glazing, which `_suppressGlazingShadow` takes back off immediately after.
   *
   * The audit only ever turns casting **on**; a module that has deliberately switched a
   * mesh off keeps its decision by tagging it, not by leaving the flag false, so this can
   * never fight a caller that actually thought about it.
   *
   * `castShadow` is idempotent and the WeakSet means each mesh is examined exactly once,
   * so the whole thing costs one traversal of newly-added geometry per scan.
   */
  _enrolCaster(obj) {
    if (this._audited.has(obj)) return;
    this._audited.add(obj);
    if (obj.castShadow) return;
    if (!this.shadowsEnabled) return;
    if (obj.isSprite || obj.isPoints || obj.isLine) return;
    if (obj.userData?.noShadow || obj.userData?.decal || obj.userData?.viewmodel) return;

    // Name-based rejects. Test the whole ancestry: a mesh called `deck` inside a group
    // called `sky` is still sky.
    let node = obj;
    for (let depth = 0; node && depth < 8; depth++, node = node.parent) {
      if (node.userData?.noShadow) return;
      if (node.name && NO_CAST_RE.test(node.name)) return;
    }

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (!mats.length || !mats[0]) return;
    for (const m of mats) {
      if (!m) return;
      if (m.userData?.noShadow) return;
      if (m.visible === false) return;
      if (m.depthWrite === false) return;
      if (m.blending !== undefined && m.blending !== THREE.NormalBlending) return;
      if ((m.transmission ?? 0) > 0.15) return;
      if (m.transparent && (m.opacity ?? 1) < 0.85) return;
      if (m.name && NO_CAST_RE.test(m.name)) return;
    }

    // Size sanity. A 1 km backdrop shell in the caster set drags nothing useful into the
    // cascades and costs a full extra draw; a 2 mm fragment is below one texel anywhere.
    const geo = obj.geometry;
    if (geo && !geo.boundingSphere) {
      try {
        geo.computeBoundingSphere();
      } catch {
        /* degenerate geometry: fall through and let the size test pass */
      }
    }
    const r = geo?.boundingSphere?.radius ?? 1;
    if (!(r > 0.01) || r > 320) return;
    /**
     * Foliage is the one family where the owning module's "no" is worth keeping for the
     * small end of the range: a grass card is an alpha-tested plane whose depth
     * footprint at 2 cm texels is noise, and there are thousands of them. Trees, shrubs
     * and planted beds are objects and cast like objects.
     */
    if (obj.userData?.foliage && r < 0.5) return;

    obj.castShadow = true;
    this._casterFlips++;
  }

  /* ─────────────────────────────────────────────────────────────── per frame */

  update(dt) {
    if (this.broken) return;
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 1 / 60;

    // Keep the key light in step with the sky even when nobody called setTimeOfDay.
    this._syncFromSky(false);

    this._envTimer += d;
    // The IBL rebuild is a GGX prefilter over the whole roughness chain — cheap on a
    // GPU, brutal on a software rasteriser. Sky emits `sky:env` as its clouds drift,
    // so an unbounded dirty flag means rebuilding every few frames forever: measured
    // as 10-21s spikes every second or third frame at 1280x720, against a 10-65ms
    // steady state, which is what made screenshot capture impossible.
    //
    // Headless converges on a budget instead. A pose change grants a few rebuilds so
    // the environment settles to the new sun, then the flag is ignored until the sun
    // actually moves. Interactive keeps the timer, where the cost is affordable and
    // drifting cloud light genuinely should feed back into the IBL.
    // The IBL is now a *local* probe (see `_gatherLocalEnvironment`), so walking from
    // the street into the market hall changes it as much as the sun moving does. Check
    // that on a slow cadence — the key is quantised to 2 m and ~1.5 deg of sun, so a
    // stationary camera never re-gathers, and the budget below still bounds headless.
    if (!this._envDirty && this._envTimer > 0.5 && this._hzKey && this._hzKey !== this._envKey()) {
      this._envDirty = true;
      if (this.headless) this._envBudget = Math.max(this._envBudget, 1);
    }

    const budgeted = this.headless && this._envBudget <= 0;
    if (this._envDirty && !budgeted && this._envTimer > (this.headless ? 0.12 : 0.4)) {
      this._envTimer = 0;
      if (this.headless) this._envBudget--;
      try {
        this._rebuildIBL(false);
      } catch (err) {
        this._warn('ibl', 'IBL rebuild failed', err);
        this._envDirty = false;
      }
    }

    const viewer = this.ctx.camera?.position;
    try {
      this._tickFlashes(d);
    } catch (err) {
      this._warn('flashtick', 'flash decay failed', err);
    }
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

    // Keep the first probe on the viewer so the near field — where a grazing view of
    // the ground makes the environment reflection the dominant term — reflects the
    // street it is standing in rather than the open sky. See ProbeSystem.anchor().
    if (this.probesEnabled && viewer) {
      try {
        _v3.set(16, 9, 16);
        this.probes.anchor(viewer, _v3);
      } catch (err) {
        this._warn('probeanchor', 'probe anchoring failed', err);
      }
    }

    // Contact-shadow strength lives in a uniform so it can drop to zero the instant
    // the buffer stops being trustworthy (teleport, first frame, pipeline missing).
    const cs = this.uniforms.uCodContactParams.value;
    const live = this.contact.enabled && this.contact.valid;
    cs.x = live ? this.contact.strength : 0;
    cs.y = this.contact.normDist;
    cs.z = live ? this.contact.aoIndirect : 0;
    this.uniforms.uCodContactMap.value = this.contact.texture;

    this._updateBounce();
    try {
      this._updatePortals(d);
    } catch (err) {
      this._warn('portals', 'aperture portal update failed', err);
    }

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

  /**
   * **The volumetric pass asked for this and nobody ever answered.**
   *
   * `render/passes/VolumetricPass.js` documents an optional
   * `ctx.lighting.getVolumetricShadow()`; without it the pass falls back to a
   * screen-space light-shaft mask that treats "the sky is visible in this pixel" as
   * the only occlusion signal. That mask is structurally incapable of the two things
   * this scene most needs from it: a shaft through a *window* (the sky behind the
   * aperture is a handful of pixels, and the mask blurs radially away from the sun's
   * screen position, which for an interior is off-screen entirely), and any shaft at
   * all when the sun is not in frame. Handing over a real cascade makes each march
   * step a 3D shadow lookup, which is the correct answer and the reason a window shaft
   * has an edge.
   *
   * The cascade we hand over is the first one wide enough (~45 m of ortho) to cover
   * the part of the ray the eye reads shafts in. Cascade 0 is a few metres across and
   * would leave the rest of the march unshadowed; the last cascade's texels are far
   * too coarse to resolve a 1.2 m aperture.
   *
   * @returns {{map:THREE.Texture, matrix:THREE.Matrix4, bias:number, cascade:number}|null}
   */
  getVolumetricShadow() {
    if (this.broken || !this.shadowsEnabled || !this.csm.enabled) return null;
    const params = this.csm.uniforms.uCsmParams.value;
    let pick = 0;
    for (let i = 0; i < this.csm.count; i++) {
      pick = i;
      if ((params[i]?.w ?? 0) >= 30) break; // uCsmParams.w is the ortho size, in metres
    }
    const light = this.csm.lights[pick];
    const shadow = light?.shadow;
    const map = shadow?.map?.depthTexture;
    // Only once three has actually allocated it, and only in a mode that can be read
    // back as plain depth — a comparison sampler is undefined behaviour here.
    if (!map || map.compareFunction || !map.image || !(map.image.width > 0)) return null;
    return {
      map,
      matrix: shadow.matrix,
      // The march samples *air*, so it needs more bias than a surface does: a step
      // that lands a few centimetres inside a wall must not paint a shadow in the room.
      bias: Math.abs(shadow.bias || 0) * 2 + 0.0014,
      cascade: pick,
    };
  }

  /**
   * The strongest practicals near the camera, for the volumetric pass to scatter
   * through. Only published once the sun has stopped being the light in the room —
   * a lamp cone in full daylight is a lens flare, not physics — and only for lights
   * that are actually on this frame (`_mod` carries flicker, pulse and the daylight
   * dimmer). Sorted by the same screen-space importance the shadow slots use.
   *
   * @param {number} max
   * @returns {Array<{pos:THREE.Vector3,color:THREE.Vector3,radius:number,dir:THREE.Vector3,cosInner:number,cosOuter:number}>}
   */
  getVolumetricLights(max = 3) {
    const out = this._volLights || (this._volLights = []);
    out.length = 0;
    if (this.broken || !this.lights) return out;
    /**
     * 1 at night, 0 in full sun. The cut-off is deliberately blunt: the march is three
     * lights x 24 steps over a quarter-res buffer, which measures in *hundreds of
     * milliseconds* on the software rasteriser, and at gate 0.09 (the hero pose, whose
     * practicals are dimmed but not off) it would buy a cone nobody can see. Publish
     * nothing until the practicals are genuinely the light in the scene.
     */
    const gate = clamp01(1 - this.daylight * 1.4);
    if (gate <= 0.2) return out;

    const cam = this.ctx.camera;
    const pool = this._volPool || (this._volPool = []);
    const cand = this.lights.requests
      .filter((r) => r.enabled && (r._mod ?? 0) > 0.02 && r.intensity > 0.01)
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

    for (let i = 0; i < cand.length && out.length < max; i++) {
      const r = cand[i];
      // A lamp 60 m away contributes nothing but cost.
      if (cam && r.position.distanceToSquared(cam.position) > 3600) continue;
      const slot =
        pool[out.length] ||
        (pool[out.length] = {
          pos: new THREE.Vector3(),
          color: new THREE.Vector3(),
          dir: new THREE.Vector3(0, -1, 0),
          radius: 1,
          cosInner: 1,
          cosOuter: -1,
        });
      slot.pos.copy(r.position);
      /**
       * Coupling into the volumetric march.
       *
       * The key gets 0.15 because it is integrated over a hundred metres of ray and
       * only has to *tint* the frame. A lamp cone is the opposite problem: it is three
       * or four metres of ray, the weather preset authors the air at 0.0022 per metre
       * for aerial perspective (0.9 % of a 4 m cone), and at parity with the sun the
       * cone lands three decimal places below the pavement it stands on — measured, on
       * the night pose, at 1e-3 of linear radiance. 1.0 is the same order as the
       * physical coupling and puts the cone at roughly a third of the ground it lights,
       * which is what a sodium lamp in dusty air actually looks like.
       */
      const k = r.intensity * r._mod * this.localLightScale * gate * 1.0;
      slot.color.set(r.color.r * k, r.color.g * k, r.color.b * k);
      slot.radius = Math.max(r.radius, 0.5);
      if (r.type === 'spot') {
        slot.dir.copy(r.target).sub(r.position);
        if (slot.dir.lengthSq() < 1e-6) slot.dir.set(0, -1, 0);
        slot.dir.normalize();
        const ang = clamp(r.angle, 0.02, Math.PI / 2 - 0.01);
        slot.cosOuter = Math.cos(ang);
        slot.cosInner = Math.cos(ang * (1 - clamp01(r.penumbra) * 0.85));
      } else {
        slot.dir.set(0, -1, 0);
        slot.cosOuter = -1;
        slot.cosInner = 1;
      }
      out.push(slot);
    }
    return out;
  }

  /**
   * **Glazing is not a shadow caster.** A window pane transmits ~90 % of what hits it;
   * three renders every `castShadow` mesh into the depth map regardless of how
   * transparent its material is, so the market hall's 18 glass meshes were filling in
   * every aperture they sat in. That is a complete explanation for "the interior floor
   * gets a broad warm pool instead of projected window trapezoids": the trapezoids were
   * being deleted in the shadow pass, one pane at a time. Cheaper and more correct than
   * an alpha-tested depth material, and it re-applies on every scan so a later
   * `props:ready` that turns casting back on does not undo it.
   */
  _suppressGlazingShadow(obj) {
    if (!obj.castShadow) return;
    const m = obj.material;
    const mats = Array.isArray(m) ? m : [m];
    let glazed = false;
    for (const mm of mats) {
      if (!mm) continue;
      if ((mm.transmission ?? 0) > 0.15) glazed = true;
      else if (/glass|glaz|window|water|puddle/i.test(mm.name || '')) glazed = true;
      else if (mm.transparent && (mm.opacity ?? 1) < 0.6) glazed = true;
      if (glazed) break;
    }
    if (glazed) obj.castShadow = false;
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
      casterFlips: this._casterFlips,
      portals: this.portalCount,
      levelPortals: this.ctx.level?.portals?.length ?? 0,
      contact: this.contact.enabled && this.contact.valid,
      sh: this._shValid,
      openSky: this._hz ? +this._hz.openSky.toFixed(3) : null,
      groundLit: this._hz ? +this._hz.groundLit.toFixed(3) : null,
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
    setSunStaging: (o) => lighting.setSunStaging(o),
    get sunStaging() {
      return { ...lighting.sunStaging };
    },
    addLight: (def) => lighting.lights.addLight(def),
    removeLight: (h) => lighting.lights.removeLight(h),
    kelvin: (k, t) => kelvinToLinearRGB(k, t),
    ambientIrradiance: (n, t) => lighting.ambientIrradiance(n, t),
    setShadowsEnabled: (v) => lighting.setShadowsEnabled(v),
    setContactShadows: (v) => lighting.setContactShadows(v),
    setProbesEnabled: (v) => lighting.setProbesEnabled(v),
    setExposureCompensation: (v) => lighting.setExposureCompensation(v),
    refreshProbes: (n) => lighting.refreshProbes(n),
    /** See Lighting.getVolumetricShadow — consumed by render/passes/VolumetricPass.js. */
    getVolumetricShadow: () => {
      try {
        return lighting.getVolumetricShadow();
      } catch {
        return null;
      }
    },
    /** See Lighting.getVolumetricLights — practicals for the volumetric march. */
    getVolumetricLights: (n) => {
      try {
        return lighting.getVolumetricLights(n);
      } catch {
        return [];
      }
    },
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
