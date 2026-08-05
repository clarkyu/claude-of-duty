/**
 * GPUParticles — the GPU-simulated particle core behind every effect in the game.
 * Owner: FX agent. Consumed by FXSystem / MuzzleFlash / Tracers / Impacts / Smoke.
 *
 * ── How it works ────────────────────────────────────────────────────────────────
 * Particle state lives entirely in float textures, four RGBA32F attachments of a
 * ping-ponged MRT pair (`dim x dim`, sized from `ctx.settings.get('particleBudget')`):
 *
 *   T0  position.xyz          life        (seconds remaining)
 *   T1  velocity.xyz          rotation    (radians, integrated)
 *   T2  lifetime, sizeBegin, sizeEnd, typeId
 *   T3  tint.rgb (linear, may exceed 1)   rotationSpeed
 *
 * Each frame:
 *   1. `SIM`   one fullscreen quad reads the previous pair and writes the next —
 *              drag towards the wind field, buoyancy, gravity, a divergence-free
 *              pseudo-curl turbulence field, rotation, and camera-relative wrapping
 *              for the ambient motes.
 *   2. `EMIT`  the particles spawned this frame are rasterised as 1-pixel POINTS
 *              straight into their own texels of the target we just wrote. Nothing
 *              is uploaded as a texture, so a hundred spawns cost a hundred points.
 *   3. `DRAW`  two instanced billboard draws (alpha, then additive) read the state
 *              textures in the vertex shader.
 *
 * ── What makes it not look like 2009 ────────────────────────────────────────────
 *   • **Soft particles.** Every sprite fades against the scene depth copy FXSystem
 *     hands us. A hard sprite/geometry intersection is the single most obvious
 *     "this is a billboard" tell there is.
 *   • **Real lighting.** Smoke and dust are shaded with a spherical impostor normal
 *     perturbed by the sprite's own normal map, wrap-lit by the sun, filled by the
 *     L2 irradiance SH from `ctx.lighting`, and given a Henyey-Greenstein forward
 *     scattering lobe so a puff rim-lights hard when it is backlit. Unlit grey
 *     blobs are the classic failure and they are not possible here.
 *   • **Erosion dissolve.** Sprites carry a noise channel; the alpha threshold
 *     climbs with age, so a puff tears itself apart instead of uniformly fading.
 *   • **Depth-sorted alpha.** A CPU mirror integrates the alpha-blended particles
 *     with the same drag/gravity model and bucket-sorts them back-to-front every
 *     frame — O(n), allocation free.
 *   • **Motion stretch** along view-space velocity for sparks and droplets, and
 *     per-particle rotation for everything else.
 *
 * ── Public API ──────────────────────────────────────────────────────────────────
 *   new GPUParticles(ctx, globals)
 *   init()                            allocate; safe to call once
 *   spawn(type, p)                    -> bool   (see SPAWN below)
 *   frame(dt, camera)                 sim + emit + sort + upload (call before draw)
 *   meshAlpha / meshAdd               THREE.Mesh, add to your own scene
 *   setBudget(n) / capacity / live
 *   TYPE                              name -> index map
 *   typeIsAdditive(i)
 *   dispose()
 *
 * SPAWN fields (all optional bar position):
 *   px,py,pz  vx,vy,vz  life  size0 size1  rot  rotSpeed  r,g,b
 *
 * Nothing here calls Math.random(); every stochastic choice comes from ctx.rng.
 */
import * as THREE from 'three';

/* ══════════════════════════════════════════════════════════════════ types ══ */

/**
 * The behaviour table. `blend` picks the draw pass; everything else is uploaded
 * into four vec4 uniform arrays and indexed by the particle's typeId in the shader.
 *
 *   drag       1/s exponential approach to the wind field
 *   gravity    multiples of g (9.81)
 *   buoyancy   m/s^2 upwards — hot gas and fine dust rise
 *   turbulence m/s^2 of curl-noise forcing
 *   curl       spatial frequency of that noise (1/m)
 *   wind       how much of the world wind vector this type inherits
 *   wrap       >0: wrap into a box of this half-size around the camera (motes)
 *   sprite     atlas cell 0..15
 *   light      0 unlit/emissive, 1 lit volume, 2 lit fleck, 3 black-body ramp
 *   stretch    view-space velocity stretch factor (0 = round billboard)
 *   soft       soft-particle fade distance in metres
 *   dissolve   how far the erosion threshold climbs over the particle's life
 */
const TYPE_DEFS = [
  { name: 'smoke_soft', drag: 0.75, gravity: 0.0, buoyancy: 0.55, turbulence: 0.30, curl: 0.28, wind: 1.0, sprite: 0, light: 1, soft: 1.6, fadeIn: 0.14, fadeOut: 0.55, opacity: 0.95, dissolve: 0.78, rotDamp: 0.35 },
  { name: 'smoke_puff', drag: 2.6, gravity: 0.0, buoyancy: 0.85, turbulence: 0.55, curl: 0.9, wind: 0.8, sprite: 1, light: 1, soft: 0.9, fadeIn: 0.06, fadeOut: 0.5, opacity: 0.8, dissolve: 0.7, rotDamp: 0.5 },
  { name: 'dust', drag: 3.4, gravity: 0.10, buoyancy: 0.35, turbulence: 0.50, curl: 1.4, wind: 0.9, sprite: 2, light: 1, soft: 0.7, fadeIn: 0.04, fadeOut: 0.48, opacity: 0.85, dissolve: 0.68, rotDamp: 0.6 },
  { name: 'dust_wave', drag: 1.5, gravity: 0.02, buoyancy: 0.30, turbulence: 0.40, curl: 0.5, wind: 1.0, sprite: 0, light: 1, soft: 1.3, fadeIn: 0.10, fadeOut: 0.55, opacity: 0.9, dissolve: 0.74, rotDamp: 0.4 },
  { name: 'haze', drag: 0.12, gravity: 0.0, buoyancy: 0.02, turbulence: 0.05, curl: 0.08, wind: 0.35, sprite: 0, light: 1, soft: 6.0, fadeIn: 0.25, fadeOut: 0.35, opacity: 0.5, dissolve: 0.35, rotDamp: 0.2 },
  { name: 'mote', drag: 0.9, gravity: 0.004, buoyancy: 0.006, turbulence: 0.11, curl: 1.7, wind: 0.25, wrap: 7.0, sprite: 15, light: 1, soft: 0.35, fadeIn: 0, fadeOut: 0, opacity: 1.0, dissolve: 0.0, rotDamp: 0.9 },
  { name: 'spark', drag: 1.1, gravity: 1.0, buoyancy: 0.0, turbulence: 0.35, curl: 2.2, wind: 0.25, sprite: 4, light: 0, stretch: 0.055, soft: 0.28, fadeIn: 0.01, fadeOut: 0.65, opacity: 1.0, dissolve: 0.0, rotDamp: 0.9, blend: 'add' },
  { name: 'ember', drag: 1.5, gravity: 0.30, buoyancy: 0.55, turbulence: 0.55, curl: 1.1, wind: 0.7, sprite: 3, light: 0, stretch: 0.012, soft: 0.35, fadeIn: 0.05, fadeOut: 0.6, opacity: 1.0, dissolve: 0.0, rotDamp: 0.8, blend: 'add' },
  { name: 'fire', drag: 2.2, gravity: 0.0, buoyancy: 3.4, turbulence: 1.5, curl: 0.7, wind: 0.5, sprite: 8, light: 3, soft: 1.1, fadeIn: 0.05, fadeOut: 0.62, opacity: 1.0, dissolve: 0.6, rotDamp: 0.45, blend: 'add' },
  { name: 'flash', drag: 9.0, gravity: 0.0, buoyancy: 0.0, turbulence: 0.0, curl: 0.0, wind: 0.0, sprite: 14, light: 0, soft: 0.2, fadeIn: 0.06, fadeOut: 0.8, opacity: 1.0, dissolve: 0.0, rotDamp: 1.0, blend: 'add' },
  { name: 'fleck', drag: 0.9, gravity: 1.0, buoyancy: 0.0, turbulence: 0.30, curl: 2.6, wind: 0.3, sprite: 6, light: 2, stretch: 0.010, soft: 0.25, fadeIn: 0.01, fadeOut: 0.35, opacity: 1.0, dissolve: 0.0, rotDamp: 0.15 },
  { name: 'blood', drag: 3.2, gravity: 0.45, buoyancy: 0.0, turbulence: 0.30, curl: 2.0, wind: 0.4, sprite: 12, light: 1, soft: 0.35, fadeIn: 0.02, fadeOut: 0.55, opacity: 0.95, dissolve: 0.6, rotDamp: 0.6 },
  { name: 'splash', drag: 1.3, gravity: 1.0, buoyancy: 0.0, turbulence: 0.12, curl: 1.0, wind: 0.35, sprite: 11, light: 0, stretch: 0.030, soft: 0.25, fadeIn: 0.02, fadeOut: 0.5, opacity: 1.0, dissolve: 0.0, rotDamp: 0.7, blend: 'add' },
  { name: 'leaf', drag: 1.9, gravity: 0.22, buoyancy: 0.06, turbulence: 0.9, curl: 1.6, wind: 1.2, sprite: 13, light: 2, soft: 0.3, fadeIn: 0.05, fadeOut: 0.45, opacity: 1.0, dissolve: 0.0, rotDamp: 0.1 },
  { name: 'ring', drag: 4.0, gravity: 0.0, buoyancy: 0.0, turbulence: 0.0, curl: 0.0, wind: 0.2, sprite: 10, light: 0, soft: 0.5, fadeIn: 0.05, fadeOut: 0.75, opacity: 1.0, dissolve: 0.0, rotDamp: 1.0, blend: 'add' },
  { name: 'glow', drag: 6.0, gravity: 0.0, buoyancy: 0.1, turbulence: 0.0, curl: 0.0, wind: 0.2, sprite: 15, light: 0, soft: 0.6, fadeIn: 0.08, fadeOut: 0.72, opacity: 1.0, dissolve: 0.0, rotDamp: 1.0, blend: 'add' },
];

const NTYPES = TYPE_DEFS.length;

/** name -> index, exported so the effect modules never hard-code a number. */
export const TYPE = Object.freeze(
  TYPE_DEFS.reduce((m, t, i) => {
    m[t.name] = i;
    return m;
  }, /** @type {Record<string, number>} */ ({}))
);

const ADDITIVE = TYPE_DEFS.map((t) => t.blend === 'add');

/* ═════════════════════════════════════════════════════════════════ shaders ══ */

// language=GLSL
const NOISE_GLSL = /* glsl */ `
float fxHash11( float n ) { return fract( sin( n ) * 43758.5453123 ); }
float fxHash21( vec2 p ) {
	p = fract( p * vec2( 5.3983, 5.4427 ) );
	p += dot( p.yx, p.xy + vec2( 21.5351, 14.3137 ) );
	return fract( p.x * p.y * 95.4337 );
}
float fxValue2( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = fxHash21( i );
	float b = fxHash21( i + vec2( 1.0, 0.0 ) );
	float c = fxHash21( i + vec2( 0.0, 1.0 ) );
	float d = fxHash21( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float fxFbm2( vec2 p, int oct ) {
	float s = 0.0, a = 0.5, n = 0.0;
	for ( int i = 0; i < 6; i ++ ) {
		if ( i >= oct ) break;
		s += a * fxValue2( p );
		n += a;
		a *= 0.5;
		p = p * 2.03 + vec2( 17.1, 9.7 );
	}
	return s / max( n, 1e-4 );
}
/** Worley F1 on a jittered grid — the cell structure that makes smoke billow. */
float fxWorley( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	float d = 8.0;
	for ( int y = -1; y <= 1; y ++ ) {
		for ( int x = -1; x <= 1; x ++ ) {
			vec2 g = vec2( float( x ), float( y ) );
			vec2 o = vec2( fxHash21( i + g ), fxHash21( i + g + 37.7 ) );
			d = min( d, length( g + o - f ) );
		}
	}
	return clamp( d, 0.0, 1.0 );
}
`;

/**
 * The sprite atlas. 4x4 cells, generated once on the GPU at boot.
 *   R  density        G,B  tangent-space normal xy      A  erosion noise
 * Every cell is forced to zero at its border so linear filtering can never bleed
 * one sprite into its neighbour.
 */
// language=GLSL
const ATLAS_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${NOISE_GLSL}

float ring( float r, float c, float w ) { return exp( - pow( ( r - c ) / w, 2.0 ) ); }

/** Density of sprite 'id' at cell-local point p (0..1). Also returns erosion noise. */
float shape( int id, vec2 p, out float erode ) {
	vec2 q = p * 2.0 - 1.0;
	float r = length( q );
	float ang = atan( q.y, q.x );
	float seed = float( id ) * 13.37;
	erode = fxFbm2( p * 5.0 + seed, 4 );
	float d = 0.0;

	if ( id == 0 ) {                       // billowing soft smoke
		vec2 w = p * 3.1 + seed + vec2( fxFbm2( p * 2.0 + seed, 3 ), fxFbm2( p * 2.0 + 5.0 + seed, 3 ) ) * 1.1;
		float lumps = 1.0 - fxWorley( w * 1.5 );
		float body = smoothstep( 1.02, 0.10, r + 0.30 * ( 1.0 - lumps ) );
		d = body * ( 0.52 + 0.62 * fxFbm2( p * 4.5 + seed, 5 ) );
	} else if ( id == 1 ) {                // tighter, higher contrast puff
		vec2 w = p * 4.4 + seed + fxFbm2( p * 3.0 + seed, 3 ) * 1.4;
		float lumps = 1.0 - fxWorley( w * 2.1 );
		d = smoothstep( 0.98, 0.08, r + 0.38 * ( 1.0 - lumps ) ) * ( 0.42 + 0.78 * fxFbm2( p * 7.0 + seed, 5 ) );
	} else if ( id == 2 ) {                // gritty dust — ragged, fine grain
		float n = fxFbm2( p * 9.0 + seed, 5 );
		d = smoothstep( 0.96, 0.05, r + 0.42 * ( 1.0 - n ) ) * ( 0.3 + 0.9 * n );
	} else if ( id == 3 ) {                // hot point (ember)
		d = exp( - r * r * 13.0 ) * 0.85 + exp( - r * r * 150.0 );
	} else if ( id == 4 ) {                // spark streak — hot head, thin tail
		float head = exp( - ( q.x * q.x * 130.0 + pow( q.y - 0.42, 2.0 ) * 46.0 ) );
		float tail = exp( - q.x * q.x * 90.0 ) * smoothstep( -0.95, 0.45, q.y ) * ( 1.0 - smoothstep( 0.35, 0.95, q.y ) );
		d = clamp( head * 1.35 + tail * 0.5, 0.0, 2.0 );
	} else if ( id == 5 ) {                // hard chip silhouette
		float edge = 0.46 + 0.14 * fxValue2( vec2( ang * 1.6, seed ) * 2.0 );
		d = smoothstep( edge, edge - 0.05, r ) * ( 0.62 + 0.5 * fxFbm2( p * 8.0 + seed, 3 ) );
	} else if ( id == 6 ) {                // splinter / fleck — thin tapered sliver
		float taper = mix( 1.0, 0.25, clamp( q.y * 0.5 + 0.5, 0.0, 1.0 ) );
		d = exp( - pow( q.x / ( 0.16 * taper ), 2.0 ) ) * smoothstep( 0.92, 0.72, abs( q.y ) );
		d *= 0.65 + 0.55 * fxFbm2( p * 10.0 + seed, 3 );
	} else if ( id == 7 ) {                // glass shard — a bright angular sliver
		float tri = smoothstep( 0.0, 0.06, 0.62 - abs( q.x ) * 2.1 - q.y * 0.55 );
		d = tri * smoothstep( 0.95, 0.6, abs( q.y ) ) * ( 0.75 + 0.45 * fxValue2( p * 6.0 + seed ) );
	} else if ( id == 8 ) {                // fireball core — turbulent licks
		vec2 w = p * 3.0 + seed + vec2( fxFbm2( p * 2.6 + seed, 4 ), fxFbm2( p * 2.6 + 9.0, 4 ) ) * 1.6;
		float t = fxFbm2( w * 2.2, 5 );
		d = smoothstep( 1.05, 0.06, r + 0.5 * ( 1.0 - t ) ) * ( 0.35 + 1.05 * t );
	} else if ( id == 9 ) {                // small glowing dot with a faint halo
		d = exp( - r * r * 30.0 ) + 0.22 * exp( - r * r * 4.0 );
	} else if ( id == 10 ) {               // expanding ring / shock front
		float n = 0.72 + 0.10 * fxValue2( vec2( ang * 2.4, seed ) );
		d = ring( r, n, 0.085 ) * ( 0.6 + 0.6 * fxFbm2( vec2( ang * 3.0, r * 6.0 ) + seed, 3 ) );
	} else if ( id == 11 ) {               // water droplet — teardrop
		float y = q.y * 0.5 + 0.5;
		float w = 0.34 * ( 1.0 - pow( y, 2.4 ) );
		d = smoothstep( w, w * 0.35, abs( q.x ) ) * smoothstep( 1.0, 0.86, abs( q.y ) );
		d *= 0.8 + 0.4 * ( 1.0 - y );
	} else if ( id == 12 ) {               // blood mist — speckled cloud
		float sp = 1.0 - fxWorley( p * 7.0 + seed );
		d = smoothstep( 1.0, 0.15, r ) * pow( sp, 2.6 ) * 1.5;
	} else if ( id == 13 ) {               // leaf
		float y = q.y * 0.5 + 0.5;
		float w = 0.52 * sin( 3.14159 * pow( y, 0.75 ) );
		d = smoothstep( w, w * 0.55, abs( q.x ) ) * smoothstep( 1.0, 0.9, abs( q.y ) );
		d *= 0.7 + 0.4 * fxValue2( vec2( q.x * 6.0, q.y * 2.0 ) + seed );
	} else if ( id == 14 ) {               // muzzle petal — a lopsided star lobe
		float lob = pow( max( 0.0, cos( ang * 2.5 + 0.6 ) ), 1.6 ) * 0.55
			+ pow( max( 0.0, cos( ang * 5.0 - 1.1 ) ), 3.0 ) * 0.30 + 0.22;
		float core = exp( - r * r * 34.0 );
		d = smoothstep( lob, lob * 0.12, r ) * ( 0.45 + 0.9 * fxFbm2( p * 6.0 + seed, 4 ) ) + core * 1.5;
	} else {                               // 15 — clean radial glow
		d = pow( max( 0.0, 1.0 - r ), 2.6 );
	}
	return clamp( d, 0.0, 2.0 );
}

void main() {
	vec2 g = vUv * 4.0;
	vec2 cell = floor( g );
	vec2 p = clamp( fract( g ), 0.0, 1.0 );
	int id = int( cell.y ) * 4 + int( cell.x );

	float e;
	float d = shape( id, p, e );

	// Normal from the density field. A flat sprite lights like cardboard; this is
	// what lets a single smoke puff show internal form under a raking sun.
	const float H = 0.012;
	float ex;
	float dx = shape( id, clamp( p + vec2( H, 0.0 ), 0.0, 1.0 ), ex ) - shape( id, clamp( p - vec2( H, 0.0 ), 0.0, 1.0 ), ex );
	float dy = shape( id, clamp( p + vec2( 0.0, H ), 0.0, 1.0 ), ex ) - shape( id, clamp( p - vec2( 0.0, H ), 0.0, 1.0 ), ex );
	vec2 n = vec2( - dx, - dy ) * 1.5;

	// Hard zero at the cell border: no bleeding between atlas entries.
	float b = min( min( p.x, p.y ), min( 1.0 - p.x, 1.0 - p.y ) );
	d *= smoothstep( 0.0, 0.035, b );

	gl_FragColor = vec4( clamp( d, 0.0, 1.0 ), n * 0.5 + 0.5, e );
}
`;

// language=GLSL
const QUAD_VERT = /* glsl */ `
out vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Simulation step. Four MRT attachments in, four out. */
// language=GLSL
const SIM_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 oState;
layout(location = 1) out vec4 oMotion;
layout(location = 2) out vec4 oAttr;
layout(location = 3) out vec4 oTint;

uniform sampler2D tState;
uniform sampler2D tMotion;
uniform sampler2D tAttr;
uniform sampler2D tTint;
uniform float uDt;
uniform float uTime;
uniform vec3 uWind;
uniform vec3 uCamPos;
uniform vec4 uTypeA[ FX_TYPES ];   // drag, gravity, turbulence, windScale
uniform vec4 uTypeB[ FX_TYPES ];   // buoyancy, curl, wrap, rotDamp

/**
 * A cheap analytically divergence-free field. Real curl noise needs six noise
 * evaluations per particle per frame; this costs six sines and is impossible to
 * tell apart once it is advecting smoke.
 */
vec3 pseudoCurl( vec3 p ) {
	return vec3(
		sin( p.y * 1.31 + p.z * 0.73 ) - cos( p.z * 1.09 - p.x * 0.51 ),
		sin( p.z * 1.17 + p.x * 0.91 ) - cos( p.x * 1.27 - p.y * 0.63 ),
		sin( p.x * 1.13 + p.y * 0.83 ) - cos( p.y * 1.21 - p.z * 0.44 )
	);
}

void main() {
	vec4 S = texture( tState, vUv );
	vec4 M = texture( tMotion, vUv );
	vec4 A = texture( tAttr, vUv );
	vec4 T = texture( tTint, vUv );

	oAttr = A;
	oTint = T;

	if ( S.w <= 0.0 || uDt <= 0.0 ) {
		oState = vec4( S.xyz, 0.0 );
		oMotion = M;
		return;
	}

	int ty = int( clamp( A.w, 0.0, float( FX_TYPES - 1 ) ) + 0.5 );
	vec4 pa = uTypeA[ ty ];
	vec4 pb = uTypeB[ ty ];

	vec3 p = S.xyz;
	vec3 v = M.xyz;
	float dt = min( uDt, 0.05 );

	if ( pa.z > 0.0 ) {
		v += pseudoCurl( p * pb.y + uTime * 0.21 ) * pa.z * dt;
	}
	v.y += ( pb.x - pa.y * 9.81 ) * dt;

	// Exponential drag towards the wind field: stable at any dt, and it is what
	// makes a puff decelerate hard in the first 100 ms then coast.
	vec3 target = uWind * pa.w;
	float k = exp( - pa.x * dt );
	v = target + ( v - target ) * k;

	p += v * dt;

	// Ambient motes live forever inside a box that follows the camera.
	if ( pb.z > 0.0 ) {
		vec3 d = p - uCamPos;
		float w = pb.z;
		d = mod( d + w, 2.0 * w ) - w;
		p = uCamPos + d;
	}

	float rot = M.w + T.w * exp( - pb.w * ( 1.0 - S.w / max( A.x, 1e-3 ) ) * 3.0 ) * dt;
	float life = pb.z > 0.0 ? S.w : max( S.w - dt, 0.0 );

	oState = vec4( p, life );
	oMotion = vec4( v, rot );
}
`;

/** Emit pass — one GL_POINT per newly spawned particle, straight into its texel. */
// language=GLSL
const EMIT_VERT = /* glsl */ `
in vec4 aState;
in vec4 aMotion;
in vec4 aAttr;
in vec4 aTint;
in float aTexel;
uniform float uDim;
out vec4 vS;
out vec4 vM;
out vec4 vA;
out vec4 vT;
void main() {
	float x = mod( aTexel, uDim );
	float y = floor( aTexel / uDim );
	vec2 uv = ( vec2( x, y ) + 0.5 ) / uDim;
	gl_Position = vec4( uv * 2.0 - 1.0, 0.0, 1.0 );
	gl_PointSize = 1.0;
	vS = aState; vM = aMotion; vA = aAttr; vT = aTint;
}
`;

// language=GLSL
const EMIT_FRAG = /* glsl */ `
precision highp float;
in vec4 vS;
in vec4 vM;
in vec4 vA;
in vec4 vT;
layout(location = 0) out vec4 oState;
layout(location = 1) out vec4 oMotion;
layout(location = 2) out vec4 oAttr;
layout(location = 3) out vec4 oTint;
void main() {
	oState = vS; oMotion = vM; oAttr = vA; oTint = vT;
}
`;

/* --------------------------------------------------------------- draw pass -- */

// language=GLSL
const DRAW_VERT = /* glsl */ `
attribute float aSlot;

uniform sampler2D tState;
uniform sampler2D tMotion;
uniform sampler2D tAttr;
uniform sampler2D tTint;
uniform float uDim;
uniform vec4 uTypeC[ FX_TYPES ];   // sprite, lightMode, stretch, soft
uniform vec4 uTypeD[ FX_TYPES ];   // fadeIn, fadeOut, opacity, dissolve
uniform float uSizeScale;

varying vec2 vQuad;
varying vec2 vCell;
varying vec4 vColor;      // rgb tint, a alpha
varying vec3 vViewPos;
varying vec3 vWorldPos;
varying vec3 vParams;     // lightMode, dissolve threshold, soft distance
varying float vAge;

#ifdef FX_AERIAL
varying vec3 vSkyWorldPos;
#endif

void main() {
	float x = mod( aSlot, uDim );
	float y = floor( aSlot / uDim );
	vec2 uvs = ( vec2( x, y ) + 0.5 ) / uDim;

	vec4 S = texture2D( tState, uvs );
	vec4 A = texture2D( tAttr, uvs );

	if ( S.w <= 0.0 ) {                    // dead slot: collapse off-screen
		gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
		vColor = vec4( 0.0 );
		vQuad = vec2( 0.0 );
		vCell = vec2( 0.0 );
		vViewPos = vec3( 0.0 );
		vWorldPos = vec3( 0.0 );
		vParams = vec3( 0.0 );
		vAge = 0.0;
		#ifdef FX_AERIAL
		vSkyWorldPos = vec3( 0.0 );
		#endif
		return;
	}

	vec4 M = texture2D( tMotion, uvs );
	vec4 T = texture2D( tTint, uvs );

	int ty = int( clamp( A.w, 0.0, float( FX_TYPES - 1 ) ) + 0.5 );
	vec4 pc = uTypeC[ ty ];
	vec4 pd = uTypeD[ ty ];

	float lifetime = max( A.x, 1e-3 );
	float age = clamp( 1.0 - S.w / lifetime, 0.0, 1.0 );
	vAge = age;

	// Size: ease-out towards sizeEnd so a puff blooms fast then settles.
	float se = 1.0 - pow( 1.0 - age, 2.2 );
	float size = mix( A.y, A.z, se ) * uSizeScale;

	// Envelope. fadeIn/fadeOut are fractions of the lifetime, not seconds, so a
	// long-lived haze billow and a 40 ms spark share one curve. Zero means "no
	// fade at all" — which is what the camera-wrapped motes need, since they
	// never age and would otherwise sit permanently at the start of the ramp.
	float fin = pd.x > 0.0 ? smoothstep( 0.0, pd.x, age ) : 1.0;
	float fout = pd.y > 0.0 ? 1.0 - smoothstep( 1.0 - pd.y, 1.0, age ) : 1.0;
	float alpha = fin * fout * pd.z;

	vec4 mv = viewMatrix * vec4( S.xyz, 1.0 );

	float rot = M.w;
	float cr = cos( rot ), sr = sin( rot );
	vec2 ax = vec2( cr, sr );
	vec2 ay = vec2( - sr, cr );

	// Motion stretch: elongate along the view-space velocity. Sparks and droplets
	// are read as streaks by the eye, never as dots.
	if ( pc.z > 0.0 ) {
		vec3 vv = ( viewMatrix * vec4( M.xyz, 0.0 ) ).xyz;
		float sl = length( vv.xy );
		if ( sl > 1e-4 ) {
			vec2 dirn = vv.xy / sl;
			float blend = clamp( sl * 0.12, 0.0, 1.0 );
			ay = mix( ay, dirn, blend );
			ax = mix( ax, vec2( - dirn.y, dirn.x ), blend );
			size *= 1.0;
			mv.xy += ay * ( position.y * size * ( pc.z * sl ) );
		}
	}

	mv.xy += ax * ( position.x * size ) + ay * ( position.y * size );

	vQuad = uv;
	vCell = vec2( mod( pc.x, 4.0 ), floor( pc.x / 4.0 ) );
	vColor = vec4( T.rgb, alpha );
	vViewPos = mv.xyz;
	// Centre, not corner: the lighting and fog terms want one value per sprite and
	// a per-vertex matrix inverse would be an absurd price for the difference.
	vWorldPos = S.xyz;
	vParams = vec3( pc.y, pd.w * age, max( pc.w, 1e-3 ) );

	#ifdef FX_AERIAL
	vSkyWorldPos = S.xyz;
	#endif

	gl_Position = projectionMatrix * mv;
}
`;

// language=GLSL
const DRAW_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tAtlas;
uniform sampler2D tFxDepth;
uniform vec2 uFxRes;
uniform float uDepthValid;
uniform vec3 uSunDir;        // world-space direction *towards* the sun
uniform vec3 uSunColor;      // linear colour * intensity
uniform vec3 uSH[ 9 ];
uniform vec3 uCamPos;
uniform float uNear;
uniform float uScatter;

varying vec2 vQuad;
varying vec2 vCell;
varying vec4 vColor;
varying vec3 vViewPos;
varying vec3 vWorldPos;
varying vec3 vParams;
varying float vAge;

#ifdef FX_AERIAL
FX_AERIAL_PARS
#endif

const float PI = 3.141592653589793;

/** L2 irradiance evaluation — same basis three uses, kept local so we own it. */
vec3 fxSH( vec3 n ) {
	vec3 r = uSH[ 0 ] * 0.886227;
	r += uSH[ 1 ] * 2.0 * 0.511664 * n.y;
	r += uSH[ 2 ] * 2.0 * 0.511664 * n.z;
	r += uSH[ 3 ] * 2.0 * 0.511664 * n.x;
	r += uSH[ 4 ] * 2.0 * 0.429043 * n.x * n.y;
	r += uSH[ 5 ] * 2.0 * 0.429043 * n.y * n.z;
	r += uSH[ 6 ] * ( 0.743125 * n.z * n.z - 0.247708 );
	r += uSH[ 7 ] * 2.0 * 0.429043 * n.x * n.z;
	r += uSH[ 8 ] * 0.429043 * ( n.x * n.x - n.y * n.y );
	return max( r, vec3( 0.0 ) );
}

float hg( float c, float g ) {
	float g2 = g * g;
	float d = max( 1.0 + g2 - 2.0 * g * c, 1e-4 );
	return ( 1.0 - g2 ) / ( 12.566370614 * d * sqrt( d ) );
}

/** Black-body-ish ramp for the fireball: white hot -> yellow -> orange -> soot. */
vec3 blackbody( float t ) {
	vec3 c = mix( vec3( 1.35, 1.22, 1.02 ), vec3( 1.25, 0.66, 0.19 ), smoothstep( 0.0, 0.30, t ) );
	c = mix( c, vec3( 0.92, 0.24, 0.045 ), smoothstep( 0.25, 0.62, t ) );
	c = mix( c, vec3( 0.13, 0.035, 0.014 ), smoothstep( 0.55, 1.0, t ) );
	return c;
}

void main() {
	if ( vColor.a <= 0.0 ) discard;

	vec2 quv = clamp( vQuad, 0.004, 0.996 );
	vec4 tex = texture2D( tAtlas, ( vCell + quv ) * 0.25 );

	// Erosion dissolve — the alpha threshold climbs with age so the sprite tears
	// apart along its own noise instead of ghosting out uniformly.
	float thr = vParams.y;
	float dens = tex.r * mix( 1.0, tex.a * 1.6, clamp( thr * 1.2, 0.0, 1.0 ) );
	float a = clamp( ( dens - thr ) / max( 1.0 - thr, 1e-3 ), 0.0, 1.0 );
	a = a * a * ( 3.0 - 2.0 * a );
	a *= vColor.a;
	if ( a <= 0.002 ) discard;

	int lm = int( vParams.x + 0.5 );
	vec3 col;

	if ( lm == 3 ) {
		// Fireball: emissive black-body ramp, brightness collapsing with age.
		col = blackbody( vAge ) * ( 1.0 + 26.0 * exp( - 5.0 * vAge ) ) * vColor.rgb;
	} else if ( lm == 0 ) {
		col = vColor.rgb;
	} else {
		// Spherical impostor normal, perturbed by the sprite's own normal map.
		vec2 sp = quv * 2.0 - 1.0;
		float rr = clamp( dot( sp, sp ), 0.0, 1.0 );
		vec3 nView = normalize( vec3( sp + ( tex.gb * 2.0 - 1.0 ) * 0.85, sqrt( 1.0 - rr ) + 0.35 ) );
		vec3 nWorld = normalize( transpose( mat3( viewMatrix ) ) * nView );

		vec3 L = uSunDir;
		vec3 V = normalize( vWorldPos - uCamPos );

		// Wrapped diffuse: a participating medium is lit well past the terminator.
		float w = lm == 2 ? 0.25 : 0.62;
		float ndl = clamp( ( dot( nWorld, L ) + w ) / ( 1.0 + w ), 0.0, 1.0 );
		vec3 direct = uSunColor * pow( ndl, 1.35 );

		// Forward scattering. This is the term that makes a smoke bank glow when
		// the sun is behind it — without it smoke reads as a flat grey cut-out.
		float ph = hg( dot( V, - L ), 0.72 );
		float thin = 1.0 - 0.65 * a;
		vec3 scatter = uSunColor * ph * uScatter * thin * ( lm == 1 ? 1.0 : 0.35 );

		vec3 amb = fxSH( nWorld );
		col = vColor.rgb * ( direct + amb ) / PI + vColor.rgb * scatter;
	}

	// Soft particles. Fading against the scene depth is what stops a puff from
	// showing a razor edge where it intersects the floor.
	float pd = - vViewPos.z;
	if ( uDepthValid > 0.5 ) {
		float sceneD = texture2D( tFxDepth, gl_FragCoord.xy / uFxRes ).r;
		a *= clamp( ( sceneD - pd ) / vParams.z, 0.0, 1.0 );
	}
	// …and against the near plane, so walking into a cloud does not flash-fill.
	a *= smoothstep( uNear, uNear + 0.30, pd );
	if ( a <= 0.002 ) discard;

	#ifdef FX_AERIAL
	col = skyAerialPerspective( col );
	#endif

	#ifdef FX_ADDITIVE
	gl_FragColor = vec4( max( col, vec3( 0.0 ) ) * a, 0.0 );
	#else
	gl_FragColor = vec4( max( col, vec3( 0.0 ) ) * a, a );
	#endif
}
`;

/* ═════════════════════════════════════════════════════════════════ system ══ */

const MAX_EMIT = 1536;
const SORT_BUCKETS = 512;

export class GPUParticles {
  /**
   * @param {object} ctx engine context
   * @param {object} globals FXSystem's shared uniform bag
   */
  constructor(ctx, globals) {
    this.ctx = ctx;
    this.globals = globals;
    this.ready = false;
    this.broken = false;
    this.dim = 64;
    this.cap = 4096;
    this.budget = 4096;
    this.live = 0;
    this.time = 0;
    this.sizeScale = 1;

    this.rtA = null;
    this.rtB = null;
    this.atlas = null;
    this._src = 0;

    this.meshAlpha = null;
    this.meshAdd = null;

    this.stats = { live: 0, alpha: 0, additive: 0, spawned: 0, dropped: 0 };
    this._warned = new Set();
  }

  /* ------------------------------------------------------------------ init */

  init() {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    if (!renderer) throw new Error('no renderer');

    const gl = renderer.getContext();
    const maxDraw = gl.getParameter(gl.MAX_DRAW_BUFFERS) || 1;
    if (maxDraw < 4) {
      throw new Error(`MAX_DRAW_BUFFERS=${maxDraw}, need 4`);
    }
    this._floatRT = !!renderer.extensions?.has?.('EXT_color_buffer_float');

    this._resolveBudget();
    this._buildTypeUniforms();
    this._allocTargets();
    this._buildAtlas();
    this._buildSim();
    this._buildEmit();
    this._buildDraw();
    this._clearState();

    this.ready = true;
  }

  _resolveBudget() {
    const s = this.ctx.settings;
    const headless = !!s?.get?.('headless');
    let budget = s?.get?.('particleBudget') ?? 4000;
    if (!Number.isFinite(budget) || budget < 256) budget = 4000;
    // SwiftShader has to shade every one of these on the CPU.
    if (headless) budget = Math.min(budget, 2600);
    this.budget = Math.round(budget);
    const dim = Math.max(32, Math.min(256, Math.ceil(Math.ceil(Math.sqrt(this.budget)) / 16) * 16));
    this.dim = dim;
    this.cap = dim * dim;
  }

  _buildTypeUniforms() {
    const A = [];
    const B = [];
    const C = [];
    const D = [];
    for (const t of TYPE_DEFS) {
      A.push(new THREE.Vector4(t.drag ?? 0.5, t.gravity ?? 0, t.turbulence ?? 0, t.wind ?? 1));
      B.push(new THREE.Vector4(t.buoyancy ?? 0, t.curl ?? 0.3, t.wrap ?? 0, t.rotDamp ?? 0.5));
      C.push(new THREE.Vector4(t.sprite ?? 0, t.light ?? 1, t.stretch ?? 0, t.soft ?? 0.6));
      D.push(new THREE.Vector4(t.fadeIn ?? 0.1, t.fadeOut ?? 0.4, t.opacity ?? 1, t.dissolve ?? 0));
    }
    this.uTypeA = { value: A };
    this.uTypeB = { value: B };
    this.uTypeC = { value: C };
    this.uTypeD = { value: D };
  }

  _makeMRT() {
    const rt = new THREE.WebGLRenderTarget(this.dim, this.dim, {
      count: 4,
      type: this._floatRT ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    const names = ['state', 'motion', 'attr', 'tint'];
    for (let i = 0; i < rt.textures.length; i++) rt.textures[i].name = `fx.particles.${names[i]}`;
    return rt;
  }

  _allocTargets() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtA = this._makeMRT();
    this.rtB = this._makeMRT();
    this._src = 0;

    this.sType = new Uint8Array(this.cap);
    this.sDie = new Float32Array(this.cap);
    this.sActive = new Uint8Array(this.cap);
    this.sPos = new Float32Array(this.cap * 3);
    this.sVel = new Float32Array(this.cap * 3);
    this.free = new Int32Array(this.cap);
    for (let i = 0; i < this.cap; i++) this.free[i] = this.cap - 1 - i;
    this.freeTop = this.cap;

    this.listAlpha = new Int32Array(this.cap);
    this.listAdd = new Int32Array(this.cap);
    this.sortKey = new Float32Array(this.cap);
    this.bucketCount = new Int32Array(SORT_BUCKETS + 1);
    this.bucketOut = new Int32Array(this.cap);

    // Emit staging buffers, uploaded as vertex data — never as a texture.
    this.eState = new Float32Array(MAX_EMIT * 4);
    this.eMotion = new Float32Array(MAX_EMIT * 4);
    this.eAttr = new Float32Array(MAX_EMIT * 4);
    this.eTint = new Float32Array(MAX_EMIT * 4);
    this.eTexel = new Float32Array(MAX_EMIT);
    this.eCount = 0;
  }

  get current() {
    return this._src === 0 ? this.rtA : this.rtB;
  }

  get previous() {
    return this._src === 0 ? this.rtB : this.rtA;
  }

  /* ----------------------------------------------------------------- atlas */

  _buildAtlas() {
    const headless = !!this.ctx.settings?.get?.('headless');
    const size = headless ? 512 : 1024;
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.name = 'fx.spriteAtlas';

    const mat = new THREE.ShaderMaterial({
      name: 'fx:atlas',
      uniforms: {},
      vertexShader: QUAD_VERT.replace('out vec2 vUv;', 'varying vec2 vUv;'),
      fragmentShader: ATLAS_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this._blit(mat, rt, true);
    mat.dispose();

    this.atlasRT = rt;
    this.atlas = rt.texture;
  }

  /** Render a fullscreen quad material into `target`. */
  _blit(material, target, clear) {
    const renderer = this.ctx.renderer;
    if (!this._quadScene) {
      this._quadScene = new THREE.Scene();
      this._quadScene.matrixAutoUpdate = false;
      this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      this._quadMesh.frustumCulled = false;
      this._quadMesh.matrixAutoUpdate = false;
      this._quadScene.add(this._quadMesh);
    }
    this._quadMesh.material = material;
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(target);
      if (clear) renderer.clear(true, false, false);
      renderer.render(this._quadScene, this._quadCam);
    } finally {
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prev);
    }
  }

  /* ------------------------------------------------------------------- sim */

  _buildSim() {
    this.simMat = new THREE.ShaderMaterial({
      name: 'fx:particleSim',
      glslVersion: THREE.GLSL3,
      defines: { FX_TYPES: NTYPES },
      uniforms: {
        tState: { value: null },
        tMotion: { value: null },
        tAttr: { value: null },
        tTint: { value: null },
        uDt: { value: 0 },
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector3() },
        uCamPos: { value: new THREE.Vector3() },
        uTypeA: this.uTypeA,
        uTypeB: this.uTypeB,
      },
      vertexShader: QUAD_VERT,
      fragmentShader: SIM_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }

  _buildEmit() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('aState', new THREE.BufferAttribute(this.eState, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aMotion', new THREE.BufferAttribute(this.eMotion, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAttr', new THREE.BufferAttribute(this.eAttr, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTint', new THREE.BufferAttribute(this.eTint, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTexel', new THREE.BufferAttribute(this.eTexel, 1).setUsage(THREE.DynamicDrawUsage));
    // The emit shader needs no positions of its own; three still wants the slot.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_EMIT * 3), 3));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.emitGeo = g;

    this.emitMat = new THREE.ShaderMaterial({
      name: 'fx:particleEmit',
      glslVersion: THREE.GLSL3,
      uniforms: { uDim: { value: this.dim } },
      vertexShader: EMIT_VERT,
      fragmentShader: EMIT_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    this.emitPoints = new THREE.Points(g, this.emitMat);
    this.emitPoints.frustumCulled = false;
    this.emitPoints.matrixAutoUpdate = false;
    this.emitScene = new THREE.Scene();
    this.emitScene.matrixAutoUpdate = false;
    this.emitScene.add(this.emitPoints);
    this.emitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /* ------------------------------------------------------------------ draw */

  _drawGeometry(slots) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        3
      )
    );
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = new THREE.InstancedBufferAttribute(slots, 1);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aSlot', attr);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return g;
  }

  _buildDraw() {
    const ctx = this.ctx;
    const G = this.globals;

    let aerialPars = '';
    let hasAerial = false;
    const ag = ctx.sky?.aerialGLSL;
    const au = ctx.sky?.aerialUniforms;
    if (ag?.parsFragment && au) {
      // Reuse the sky's own in-scattering so a smoke bank at 80 m sits in the same
      // atmosphere as the wall behind it. Declared here, not injected via a chunk,
      // because these are hand-written shaders with no three material to patch.
      aerialPars = ag.parsFragment.replace(/varying\s+vec3\s+vSkyWorldPos\s*;/, 'varying vec3 vSkyWorldPos;');
      hasAerial = true;
    }

    const shared = {
      tState: { value: null },
      tMotion: { value: null },
      tAttr: { value: null },
      tTint: { value: null },
      tAtlas: { value: this.atlas },
      uDim: { value: this.dim },
      uTypeC: this.uTypeC,
      uTypeD: this.uTypeD,
      uSizeScale: { value: 1 },
      tFxDepth: G.tFxDepth,
      uFxRes: G.uFxRes,
      uDepthValid: G.uDepthValid,
      uSunDir: G.uSunDir,
      uSunColor: G.uSunColor,
      uSH: G.uSH,
      uCamPos: G.uCamPos,
      uNear: G.uNear,
      uScatter: { value: 0.9 },
    };
    if (hasAerial) Object.assign(shared, au);

    const frag = DRAW_FRAG.replace('FX_AERIAL_PARS', aerialPars);

    const mk = (additive) => {
      const defines = { FX_TYPES: NTYPES };
      if (additive) defines.FX_ADDITIVE = '';
      if (hasAerial) defines.FX_AERIAL = '';
      const m = new THREE.ShaderMaterial({
        name: additive ? 'fx:particlesAdd' : 'fx:particlesAlpha',
        defines,
        // A shallow copy: the two materials get their own bag but keep pointing at
        // the *same* shared uniform objects, so one write per frame updates both.
        uniforms: Object.assign({}, shared),
        vertexShader: DRAW_VERT,
        fragmentShader: frag,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
        blendEquation: THREE.AddEquation,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      return m;
    };

    this.matAlpha = mk(false);
    this.matAdd = mk(true);

    this.slotsAlpha = new Float32Array(this.cap);
    this.slotsAdd = new Float32Array(this.cap);

    this.meshAlpha = new THREE.Mesh(this._drawGeometry(this.slotsAlpha), this.matAlpha);
    this.meshAlpha.name = 'fx.particles.alpha';
    this.meshAlpha.frustumCulled = false;
    this.meshAlpha.matrixAutoUpdate = false;
    this.meshAlpha.renderOrder = 10;

    this.meshAdd = new THREE.Mesh(this._drawGeometry(this.slotsAdd), this.matAdd);
    this.meshAdd.name = 'fx.particles.additive';
    this.meshAdd.frustumCulled = false;
    this.meshAdd.matrixAutoUpdate = false;
    this.meshAdd.renderOrder = 24;
  }

  _clearState() {
    const renderer = this.ctx.renderer;
    const prev = renderer.getRenderTarget();
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    try {
      renderer.setClearColor(0x000000, 0);
      for (const rt of [this.rtA, this.rtB]) {
        renderer.setRenderTarget(rt);
        renderer.clear(true, false, false);
      }
    } finally {
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.setRenderTarget(prev);
    }
  }

  /* ----------------------------------------------------------------- spawn */

  typeIsAdditive(t) {
    return !!ADDITIVE[t];
  }

  get capacity() {
    return this.cap;
  }

  /**
   * Queue one particle. Returns false when the budget is full — callers should
   * treat that as "the frame is already busy enough" and not retry.
   * @param {number} type index from TYPE
   * @param {object} p spawn parameters
   */
  spawn(type, p) {
    if (!this.ready || this.broken) return false;
    if (this.eCount >= MAX_EMIT) {
      this.stats.dropped++;
      return false;
    }
    if (this.freeTop <= 0 || this.live >= this.budget) {
      this.stats.dropped++;
      return false;
    }
    const ty = type | 0;
    if (ty < 0 || ty >= NTYPES) return false;

    const slot = this.free[--this.freeTop];
    const life = Math.max(0.016, p.life ?? 1);
    const i4 = this.eCount * 4;

    this.eState[i4] = p.px ?? 0;
    this.eState[i4 + 1] = p.py ?? 0;
    this.eState[i4 + 2] = p.pz ?? 0;
    this.eState[i4 + 3] = life;

    this.eMotion[i4] = p.vx ?? 0;
    this.eMotion[i4 + 1] = p.vy ?? 0;
    this.eMotion[i4 + 2] = p.vz ?? 0;
    this.eMotion[i4 + 3] = p.rot ?? 0;

    this.eAttr[i4] = life;
    this.eAttr[i4 + 1] = Math.max(1e-3, p.size0 ?? 0.3);
    this.eAttr[i4 + 2] = Math.max(1e-3, p.size1 ?? p.size0 ?? 0.3);
    this.eAttr[i4 + 3] = ty;

    this.eTint[i4] = p.r ?? 1;
    this.eTint[i4 + 1] = p.g ?? 1;
    this.eTint[i4 + 2] = p.b ?? 1;
    this.eTint[i4 + 3] = p.rotSpeed ?? 0;

    this.eTexel[this.eCount] = slot;
    this.eCount++;

    this.sType[slot] = ty;
    this.sActive[slot] = 1;
    this.sDie[slot] = this.time + (TYPE_DEFS[ty].wrap ? 1e9 : life);
    const i3 = slot * 3;
    this.sPos[i3] = p.px ?? 0;
    this.sPos[i3 + 1] = p.py ?? 0;
    this.sPos[i3 + 2] = p.pz ?? 0;
    this.sVel[i3] = p.vx ?? 0;
    this.sVel[i3 + 1] = p.vy ?? 0;
    this.sVel[i3 + 2] = p.vz ?? 0;
    this.live++;
    this.stats.spawned++;
    return true;
  }

  /** Kill every live particle (pose changes, level reloads). */
  reset() {
    if (!this.ready) return;
    this.sActive.fill(0);
    this.freeTop = this.cap;
    for (let i = 0; i < this.cap; i++) this.free[i] = this.cap - 1 - i;
    this.live = 0;
    this.eCount = 0;
    this._clearState();
  }

  /* ------------------------------------------------------------------ frame */

  /**
   * Advance the simulation, flush spawns, sort and upload the draw lists.
   * Must run while nothing else owns the render target — FXSystem calls it from
   * the scene's onAfterRender, once every engine frame.
   */
  frame(dt, camera) {
    if (!this.ready || this.broken) return;
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.05) : 1 / 60;
    this.time += d;
    try {
      this._simulate(d);
      this._emit();
      this._cpuMirror(d, camera);
      this._upload(camera);
    } catch (err) {
      this._warn('frame', err);
      this.broken = true;
    }
  }

  _simulate(dt) {
    // `current` holds the state the last frame ended on; step it into the spare
    // target and flip, so `current` is always the freshest set.
    const src = this.current;
    const dst = this.previous;
    const u = this.simMat.uniforms;
    u.tState.value = src.textures[0];
    u.tMotion.value = src.textures[1];
    u.tAttr.value = src.textures[2];
    u.tTint.value = src.textures[3];
    u.uDt.value = dt;
    u.uTime.value = this.time;
    u.uWind.value.copy(this.globals.uWindVec.value);
    u.uCamPos.value.copy(this.globals.uCamPos.value);
    this._blit(this.simMat, dst, false);
    this._src ^= 1;
  }

  _emit() {
    if (this.eCount === 0) return;
    const renderer = this.ctx.renderer;
    const g = this.emitGeo;
    const n = this.eCount;
    for (const name of ['aState', 'aMotion', 'aAttr', 'aTint', 'aTexel']) {
      const a = g.getAttribute(name);
      a.clearUpdateRanges?.();
      a.addUpdateRange?.(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    g.setDrawRange(0, n);
    this.emitMat.uniforms.uDim.value = this.dim;

    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(this.current);
      renderer.render(this.emitScene, this.emitCam);
    } finally {
      renderer.autoClear = prevAuto;
      renderer.setRenderTarget(prev);
    }
    this.eCount = 0;
  }

  /**
   * A CPU shadow of the alpha-blended particles. It exists purely so the draw
   * order can be correct: the same drag/gravity/wind integration as the shader,
   * minus the turbulence, is plenty to sort by.
   */
  _cpuMirror(dt, camera) {
    const now = this.time;
    const pos = this.sPos;
    const vel = this.sVel;
    const act = this.sActive;
    const die = this.sDie;
    const typ = this.sType;
    const wind = this.globals.uWindVec.value;
    const camX = camera ? camera.position.x : 0;
    const camY = camera ? camera.position.y : 0;
    const camZ = camera ? camera.position.z : 0;

    let nA = 0;
    let nB = 0;
    let live = 0;
    const listA = this.listAlpha;
    const listB = this.listAdd;
    const key = this.sortKey;

    for (let i = 0; i < this.cap; i++) {
      if (!act[i]) continue;
      if (now >= die[i]) {
        act[i] = 0;
        this.free[this.freeTop++] = i;
        continue;
      }
      live++;
      const t = typ[i];
      if (ADDITIVE[t]) {
        if (nB < this.cap) listB[nB++] = i;
        continue;
      }
      const def = TYPE_DEFS[t];
      const i3 = i * 3;
      let vx = vel[i3];
      let vy = vel[i3 + 1];
      let vz = vel[i3 + 2];
      const ws = def.wind ?? 1;
      const k = Math.exp(-(def.drag ?? 0.5) * dt);
      vy += ((def.buoyancy ?? 0) - (def.gravity ?? 0) * 9.81) * dt;
      vx = wind.x * ws + (vx - wind.x * ws) * k;
      vy = wind.y * ws + (vy - wind.y * ws) * k;
      vz = wind.z * ws + (vz - wind.z * ws) * k;
      vel[i3] = vx;
      vel[i3 + 1] = vy;
      vel[i3 + 2] = vz;
      let px = pos[i3] + vx * dt;
      let py = pos[i3 + 1] + vy * dt;
      let pz = pos[i3 + 2] + vz * dt;
      const wr = def.wrap ?? 0;
      if (wr > 0) {
        const w2 = wr * 2;
        px = camX + (((px - camX + wr) % w2) + w2) % w2 - wr;
        py = camY + (((py - camY + wr) % w2) + w2) % w2 - wr;
        pz = camZ + (((pz - camZ + wr) % w2) + w2) % w2 - wr;
      }
      pos[i3] = px;
      pos[i3 + 1] = py;
      pos[i3 + 2] = pz;

      const dx = px - camX;
      const dy = py - camY;
      const dz = pz - camZ;
      key[i] = dx * dx + dy * dy + dz * dz;
      if (nA < this.cap) listA[nA++] = i;
    }

    this.live = live;
    this.countAlpha = nA;
    this.countAdd = nB;
  }

  /** O(n) bucket sort, far to near, so alpha-blended smoke composites correctly. */
  _sortAlpha(n) {
    if (n < 2) return this.listAlpha;
    const key = this.sortKey;
    const list = this.listAlpha;
    let maxK = 1;
    for (let i = 0; i < n; i++) {
      const k = key[list[i]];
      if (k > maxK) maxK = k;
    }
    const scale = (SORT_BUCKETS - 1) / maxK;
    const counts = this.bucketCount;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      // Descending: bucket 0 is the farthest, drawn first.
      const b = SORT_BUCKETS - 1 - ((key[list[i]] * scale) | 0);
      counts[b < 0 ? 0 : b > SORT_BUCKETS - 1 ? SORT_BUCKETS - 1 : b]++;
    }
    let run = 0;
    for (let b = 0; b < SORT_BUCKETS; b++) {
      const c = counts[b];
      counts[b] = run;
      run += c;
    }
    const out = this.bucketOut;
    for (let i = 0; i < n; i++) {
      const idx = list[i];
      let b = SORT_BUCKETS - 1 - ((key[idx] * scale) | 0);
      if (b < 0) b = 0;
      else if (b > SORT_BUCKETS - 1) b = SORT_BUCKETS - 1;
      out[counts[b]++] = idx;
    }
    return out;
  }

  _upload(camera) {
    const cur = this.current;
    const texA = cur.textures;

    for (const m of [this.matAlpha, this.matAdd]) {
      m.uniforms.tState.value = texA[0];
      m.uniforms.tMotion.value = texA[1];
      m.uniforms.tAttr.value = texA[2];
      m.uniforms.tTint.value = texA[3];
      m.uniforms.uDim.value = this.dim;
      m.uniforms.uSizeScale.value = this.sizeScale;
    }

    const nA = this.countAlpha | 0;
    const sorted = this._sortAlpha(nA);
    const sa = this.slotsAlpha;
    for (let i = 0; i < nA; i++) sa[i] = sorted[i];
    const ga = this.meshAlpha.geometry.getAttribute('aSlot');
    if (nA > 0) {
      ga.clearUpdateRanges?.();
      ga.addUpdateRange?.(0, nA);
      ga.needsUpdate = true;
    }
    this.meshAlpha.geometry.instanceCount = nA;
    this.meshAlpha.visible = nA > 0;

    const nB = this.countAdd | 0;
    const sb = this.slotsAdd;
    const lb = this.listAdd;
    for (let i = 0; i < nB; i++) sb[i] = lb[i];
    const gb = this.meshAdd.geometry.getAttribute('aSlot');
    if (nB > 0) {
      gb.clearUpdateRanges?.();
      gb.addUpdateRange?.(0, nB);
      gb.needsUpdate = true;
    }
    this.meshAdd.geometry.instanceCount = nB;
    this.meshAdd.visible = nB > 0;

    this.stats.live = this.live;
    this.stats.alpha = nA;
    this.stats.additive = nB;
  }

  /* --------------------------------------------------------------- quality */

  setBudget() {
    const before = this.dim;
    this._resolveBudget();
    if (this.dim === before || !this.ready) return false;
    this._allocTargets();
    this.meshAlpha.geometry.dispose();
    this.meshAdd.geometry.dispose();
    this.meshAlpha.geometry = this._drawGeometry(this.slotsAlpha);
    this.meshAdd.geometry = this._drawGeometry(this.slotsAdd);
    this.emitGeo.dispose();
    this._buildEmit();
    this._clearState();
    return true;
  }

  _warn(tag, err) {
    if (this._warned.has(tag)) return;
    this._warned.add(tag);
    console.warn(`[fx.particles] ${tag} failed:`, err?.message || err);
  }

  dispose() {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.atlasRT?.dispose();
    this.simMat?.dispose();
    this.emitMat?.dispose();
    this.emitGeo?.dispose();
    this.matAlpha?.dispose();
    this.matAdd?.dispose();
    this.meshAlpha?.geometry?.dispose();
    this.meshAdd?.geometry?.dispose();
    this._quadMesh?.geometry?.dispose();
    this.ready = false;
  }
}

export default GPUParticles;
