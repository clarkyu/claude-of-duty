/**
 * Foliage texture atlases — 100% GPU-procedural. Owner: foliage agent.
 *
 * There is no leaf PNG anywhere in this project. Everything here is rendered once at
 * boot into render targets by the shaders below and handed straight to the material
 * library's foliage recipe.
 *
 * Two atlases, each a 2x2 grid of cells:
 *
 *   LEAF                              BARK
 *   ┌─────────────┬─────────────┐     ┌─────────────┬─────────────┐
 *   │ 0 dry grass │ 1 olive     │     │ 0 olive     │ 1 palm      │
 *   │   blades    │   leaf spray│     │   gnarled   │   ring scar │
 *   ├─────────────┼─────────────┤     ├─────────────┼─────────────┤
 *   │ 2 broad     │ 3 pinnate   │     │ 2 smooth    │ 3 dry twig  │
 *   │   ovate leaf│   frond     │     │   thin bark │   / stem    │
 *   └─────────────┴─────────────┘     └─────────────┴─────────────┘
 *
 * Pipeline per atlas (4 passes, only the first is expensive):
 *   1. FIELD  -> RGBA8   r = height, g = vein/rib, b = per-leaf variation, a = coverage
 *   2. ALBEDO <- field   linear RGB into an SRGB8_ALPHA8 target (hardware encodes on
 *                        write, decodes on sample: full precision in the darks), a =
 *                        (a = coverage, kept for the height term)
 *   3. NORMAL <- field   Sobel of the height channel, tangent space
 *   4. ORM    <- field   r = AO (leaf layering + cavity), g = roughness, b = metal(0)
 *
 * The field target is kept alive for bark: the material extension's parallax path
 * samples it as the height map.
 *
 * Everything is seeded from `ctx.rng()` once, so two runs generate identical pixels.
 */
import * as THREE from 'three';

/* ========================================================================== */
/*                                   GLSL                                     */
/* ========================================================================== */

// language=GLSL
const TRI_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// language=GLSL
const NOISE = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uSeed;

float h11( float n ) { return fract( sin( n * 127.1 + uSeed ) * 43758.5453123 ); }
float h21( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) + uSeed ) * 43758.5453123 ); }

float vn( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( h21( i ), h21( i + vec2( 1.0, 0.0 ) ), u.x ),
	            mix( h21( i + vec2( 0.0, 1.0 ) ), h21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float fbm( vec2 p ) {
	float a = 0.5, s = 0.0;
	for ( int i = 0; i < 5; i ++ ) { s += a * vn( p ); p = p * 2.07 + vec2( 1.7, - 3.1 ); a *= 0.5; }
	return s;
}
float ridged( vec2 p ) {
	float a = 0.5, s = 0.0;
	for ( int i = 0; i < 4; i ++ ) { s += a * ( 1.0 - abs( vn( p ) * 2.0 - 1.0 ) ); p = p * 2.11 + vec2( -2.3, 1.1 ); a *= 0.5; }
	return s;
}
vec2 rot2( vec2 p, float a ) { float c = cos( a ), s = sin( a ); return vec2( c * p.x - s * p.y, s * p.x + c * p.y ); }
`;

/**
 * The leaf field. Every cell is a *cluster* of real leaf shapes, never a rectangle:
 * silhouette, midrib, side veins, cross-section curl and a per-leaf age variation all
 * come out of here so the albedo/normal/ORM passes are trivial lookups.
 */
// language=GLSL
const LEAF_FIELD_FRAG = /* glsl */ `
${NOISE}

/**
 * One leaf/blade in leaf-local space (+Y towards the tip, origin at the petiole).
 * Returns (coverage, height, vein).
 *   widest  where along the blade it is fattest — 0.45 lanceolate, 1.4 ovate
 *   tipCut  how hard the tip pinches to a point
 */
vec3 blade( vec2 p, float len, float wid, float tipCut, float widest, float seed ) {
	float t = p.y / len;
	if ( t < 0.0 || t > 1.0 ) return vec3( 0.0 );
	float prof = sin( pow( max( t, 1e-4 ), widest ) * 3.14159265 );
	float w = wid * pow( max( prof, 0.0 ), 0.60 );
	w *= 1.0 - smoothstep( 0.55, 1.0, t ) * tipCut;
	// A perfectly smooth silhouette reads as plastic; nibble the edge.
	w *= 0.90 + 0.20 * vn( vec2( t * 17.0, seed * 29.0 ) );
	if ( w < 1e-5 ) return vec3( 0.0 );
	float d = abs( p.x ) / w;
	float cover = 1.0 - smoothstep( 0.82, 1.02, d );
	if ( cover < 0.004 ) return vec3( 0.0 );
	// Cross-section: leaves are troughs, not planes.
	float curl = 0.42 + 0.58 * cos( min( d, 1.0 ) * 1.5 );
	float rib = exp( - pow( abs( p.x ) / max( w * 0.17, 1e-4 ), 2.0 ) );
	float sv = pow( 0.5 + 0.5 * sin( t * 34.0 + abs( p.x ) / max( w, 1e-4 ) * 3.4 ), 7.0 );
	sv *= ( 1.0 - rib ) * smoothstep( 0.02, 0.2, t );
	return vec3( cover, curl * 0.72 + rib * 0.28, max( rib, sv * 0.7 ) );
}

/** Keep the nearest (highest) leaf, so overlapping leaves layer instead of blending. */
void layer( inout vec4 o, vec3 b, float depth, float variation ) {
	if ( b.x < 0.004 ) return;
	float h = mix( 0.18, 1.0, depth ) * ( 0.55 + 0.45 * b.y );
	float cover = max( o.w, b.x );
	if ( h > o.x ) o = vec4( h, b.z, variation, cover );
	else o.w = cover;
}

/* ── cell 0: dry tufted grass ─────────────────────────────────────────────── */
vec4 cellGrass( vec2 p, float seed ) {
	vec4 o = vec4( 0.0 );
	// Six wide blades, not twenty hair-thin ones: a card only gets ~40 screen pixels
	// of width at 3 m, and anything finer resolves to grey fuzz instead of grass.
	for ( int i = 0; i < 6; i ++ ) {
		float fi = float( i );
		float r1 = h11( fi * 2.31 + seed ), r2 = h11( fi * 5.77 + seed + 11.0 ), r3 = h11( fi * 9.13 + seed + 23.0 );
		float x0 = - 0.72 + 1.44 * ( fi + 0.5 ) / 6.0 + ( r1 - 0.5 ) * 0.16;
		float len = 1.30 + r2 * 0.60;
		float lean = ( r3 - 0.5 ) * 1.5 + sign( x0 ) * 0.28;
		vec2 q = p - vec2( x0, - 0.98 );
		float t = clamp( q.y / len, 0.0, 1.0 );
		q.x -= lean * t * t;                       // blades arc, they do not stand up straight
		q = rot2( q, - lean * t * 0.35 );
		vec3 b = blade( q, len, 0.070 + r2 * 0.045, 0.96, 0.46, fi + seed );
		layer( o, b, 0.25 + r1 * 0.75, 0.55 + 0.45 * r3 );
	}
	return o;
}

/* ── cell 1: olive leaf spray (narrow, silvered, alternating) ─────────────── */
vec4 cellOlive( vec2 p, float seed ) {
	vec4 o = vec4( 0.0 );
	// woody stem down the middle
	float stem = 1.0 - smoothstep( 0.010, 0.020, abs( p.x + ( p.y + 1.0 ) * 0.03 ) );
	stem *= smoothstep( - 0.95, - 0.9, p.y ) * ( 1.0 - smoothstep( 0.55, 0.78, p.y ) );
	if ( stem > 0.01 ) o = vec4( 0.34, 0.9, 0.12, stem );
	for ( int i = 0; i < 16; i ++ ) {
		float fi = float( i );
		float r1 = h11( fi * 3.17 + seed ), r2 = h11( fi * 6.41 + seed + 7.0 ), r3 = h11( fi * 8.09 + seed + 19.0 );
		float side = mod( fi, 2.0 ) * 2.0 - 1.0;
		float along = - 0.86 + 1.52 * ( fi + 0.4 ) / 16.0;
		float ang = side * ( 0.62 + 0.30 * r1 ) + ( r2 - 0.5 ) * 0.22;
		float len = 0.52 - 0.19 * ( along + 0.86 ) / 1.52 + r3 * 0.10;
		vec2 q = rot2( p - vec2( 0.0, along ), - ang );
		vec3 b = blade( q, len, 0.052 + r2 * 0.016, 0.55, 0.55, fi + seed * 3.0 );
		layer( o, b, 0.2 + r1 * 0.8, 0.30 + 0.5 * r2 );
	}
	return o;
}

/* ── cell 2: broad ovate leaves (bush, ivy, vine, potted) ─────────────────── */
vec4 cellBroad( vec2 p, float seed ) {
	vec4 o = vec4( 0.0 );
	for ( int i = 0; i < 7; i ++ ) {
		float fi = float( i );
		float r1 = h11( fi * 4.13 + seed ), r2 = h11( fi * 7.31 + seed + 5.0 ), r3 = h11( fi * 11.7 + seed + 31.0 );
		float ang = ( fi / 7.0 ) * 6.2831853 + ( r1 - 0.5 ) * 0.5;
		float rad = 0.10 + r2 * 0.34;
		vec2 c = vec2( cos( ang ), sin( ang ) ) * rad;
		float len = 0.62 + r3 * 0.32;
		vec2 q = rot2( p - c, - ( ang - 1.5708 ) - ( r2 - 0.5 ) * 0.6 );
		vec3 b = blade( q, len, 0.20 + r1 * 0.10, 0.40, 1.25, fi + seed * 5.0 );
		layer( o, b, 0.15 + r3 * 0.85, 0.25 + 0.6 * r1 );
	}
	return o;
}

/* ── cell 3: pinnate frond section (palm, cypress spray) ──────────────────── */
vec4 cellFrond( vec2 p, float seed ) {
	vec4 o = vec4( 0.0 );
	// the rachis
	float rw = mix( 0.030, 0.008, clamp( p.y * 0.5 + 0.5, 0.0, 1.0 ) );
	float rach = 1.0 - smoothstep( rw * 0.8, rw * 1.4, abs( p.x ) );
	if ( rach > 0.01 ) o = vec4( 0.42, 1.0, 0.18, rach );
	for ( int i = 0; i < 30; i ++ ) {
		float fi = float( i );
		float r1 = h11( fi * 2.77 + seed ), r2 = h11( fi * 5.11 + seed + 3.0 );
		float side = mod( fi, 2.0 ) * 2.0 - 1.0;
		float u = ( floor( fi * 0.5 ) + 0.5 ) / 15.0;          // 0..1 along the rachis
		float along = - 0.95 + 1.86 * u;
		// leaflets sweep back harder towards the tip
		float ang = side * ( 1.30 - 0.62 * u ) + ( r1 - 0.5 ) * 0.16;
		float len = ( 0.30 + 0.62 * sin( pow( u, 0.75 ) * 3.14159 ) ) * ( 0.86 + r2 * 0.24 );
		vec2 q = rot2( p - vec2( 0.0, along ), - ang );
		vec3 b = blade( q, len, 0.020 + r2 * 0.008, 0.90, 0.42, fi + seed * 7.0 );
		layer( o, b, 0.25 + r1 * 0.7, 0.35 + 0.5 * r2 );
	}
	return o;
}

void main() {
	vec2 cell = floor( vUv * 2.0 );
	vec2 p = fract( vUv * 2.0 ) * 2.0 - 1.0;
	float id = cell.x + cell.y * 2.0;
	vec4 f;
	if ( id < 0.5 )      f = cellGrass( p, 1.0 );
	else if ( id < 1.5 ) f = cellOlive( p, 2.0 );
	else if ( id < 2.5 ) f = cellBroad( p, 3.0 );
	else                 f = cellFrond( p, 4.0 );
	// A hard border keeps mip bleed between cells off the silhouette.
	float m = max( abs( p.x ), abs( p.y ) );
	f.w *= 1.0 - smoothstep( 0.955, 0.995, m );
	gl_FragColor = f;
}
`;

/** Bark: cylindrical-periodic in u so it wraps a trunk with no seam. */
// language=GLSL
const BARK_FIELD_FRAG = /* glsl */ `
${NOISE}

/**
 * fbm sampled on a circle of radius "turns" so u = 0 and u = 1 are literally the same
 * point — the trunk texture wraps with no visible seam.
 */
float cylFbm( float u, float v, float turns, float vScale ) {
	float a = u * 6.2831853;
	float s = 0.0, amp = 0.5, t = turns;
	for ( int i = 0; i < 4; i ++ ) {
		vec2 pp = vec2( cos( a ) * t, sin( a ) * t ) + vec2( 0.0, v * vScale * ( t / turns ) );
		s += amp * vn( pp );
		t *= 2.03; amp *= 0.5;
	}
	return s;
}

/* olive: deep twisting ridges, knots, hollowed flutes */
vec4 cellOliveBark( vec2 uv ) {
	float u = uv.x, v = uv.y;
	float tw = u + v * 0.22 + cylFbm( u, v, 2.0, 1.4 ) * 0.10;   // the trunk twists as it grows
	float ridge = ridged( vec2( tw * 22.0, v * 3.2 ) );
	float coarse = cylFbm( u, v, 3.0, 2.6 );
	float h = ridge * 0.62 + coarse * 0.38;
	// flutes: olives are not cylinders, they are bundles of fused stems
	float flute = 0.5 + 0.5 * cos( tw * 6.2831853 * 4.0 );
	h = mix( h, h * 0.35, pow( flute, 2.2 ) * 0.7 );
	float crack = smoothstep( 0.58, 0.72, ridged( vec2( tw * 46.0, v * 9.0 ) ) );
	h -= crack * 0.42;
	float knot = smoothstep( 0.80, 0.94, fbm( vec2( u * 7.0, v * 5.0 ) + 3.3 ) );
	h += knot * 0.35;
	float lichen = smoothstep( 0.56, 0.80, fbm( vec2( u * 11.0, v * 8.0 ) - 7.1 ) );
	return vec4( clamp( h, 0.0, 1.0 ), crack, lichen, 1.0 );
}

/* date palm: overlapping diamond leaf-base scars */
vec4 cellPalmBark( vec2 uv ) {
	float u = uv.x, v = uv.y;
	vec2 g = vec2( u * 9.0, v * 26.0 );
	g.x += floor( g.y ) * 0.5;                     // brick-offset the scars
	vec2 f = fract( g ) - 0.5;
	float dia = 1.0 - smoothstep( 0.16, 0.52, abs( f.x ) + abs( f.y ) );
	float h = 0.36 + dia * 0.44;
	h += cylFbm( u, v, 4.0, 7.0 ) * 0.22;
	float fib = 0.5 + 0.5 * sin( u * 6.2831853 * 34.0 + cylFbm( u, v, 5.0, 9.0 ) * 6.0 );
	h += fib * 0.10;
	float crack = smoothstep( 0.62, 0.86, ridged( vec2( u * 40.0, v * 20.0 ) ) );
	h -= crack * 0.18;
	return vec4( clamp( h, 0.0, 1.0 ), crack, dia * 0.5, 1.0 );
}

/* cypress / young wood: fine fibrous strips */
vec4 cellSmoothBark( vec2 uv ) {
	float u = uv.x, v = uv.y;
	float strip = ridged( vec2( ( u + v * 0.06 ) * 34.0, v * 1.6 ) );
	float h = 0.42 + strip * 0.42 + cylFbm( u, v, 3.0, 5.0 ) * 0.18;
	float crack = smoothstep( 0.66, 0.86, ridged( vec2( u * 70.0, v * 5.0 ) ) );
	h -= crack * 0.22;
	return vec4( clamp( h, 0.0, 1.0 ), crack, 0.0, 1.0 );
}

/* dry stem / twig */
vec4 cellTwig( vec2 uv ) {
	float u = uv.x, v = uv.y;
	float h = 0.5 + cylFbm( u, v, 2.0, 9.0 ) * 0.4;
	float grain = 0.5 + 0.5 * sin( u * 6.2831853 * 12.0 + v * 3.0 );
	h += grain * 0.10;
	return vec4( clamp( h, 0.0, 1.0 ), 0.0, smoothstep( 0.6, 0.9, fbm( vec2( u * 9.0, v * 12.0 ) ) ), 1.0 );
}

void main() {
	vec2 cell = floor( vUv * 2.0 );
	vec2 luv = fract( vUv * 2.0 );
	float id = cell.x + cell.y * 2.0;
	vec4 f;
	if ( id < 0.5 )      f = cellOliveBark( luv );
	else if ( id < 1.5 ) f = cellPalmBark( luv );
	else if ( id < 2.5 ) f = cellSmoothBark( luv );
	else                 f = cellTwig( luv );
	gl_FragColor = f;
}
`;

/** Albedo pass — linear RGB, written into an sRGB attachment. */
// language=GLSL
const LEAF_ALBEDO_FRAG = /* glsl */ `
${NOISE}
uniform sampler2D uField;

void main() {
	vec4 f = texture2D( uField, vUv );
	float h = f.r, vein = f.g, varn = f.b, cover = f.a;

	// Mediterranean vegetation is never one green: olive-grey, straw, and burnt tips.
	vec3 young = vec3( 0.152, 0.223, 0.079 );
	vec3 mature = vec3( 0.113, 0.158, 0.061 );
	vec3 dry = vec3( 0.248, 0.202, 0.090 );
	vec3 c = mix( young, mature, smoothstep( 0.2, 0.85, varn ) );
	// tips and edges dry out first
	float edge = 1.0 - smoothstep( 0.10, 0.55, h );
	float dryness = clamp( edge * 0.75 + fbm( vUv * 26.0 ) * 0.55 - 0.12, 0.0, 1.0 );
	c = mix( c, dry, dryness * 0.72 );
	// midrib and veins are paler and slightly yellow
	c = mix( c, c * vec3( 1.45, 1.38, 1.05 ) + 0.012, vein * 0.55 );
	// waxy sheen towards the middle of the blade, dust towards the base
	c *= 0.78 + 0.42 * h;
	c = mix( c, vec3( 0.115, 0.100, 0.078 ), clamp( ( 1.0 - h ) * 0.45 * fbm( vUv * 9.0 + 4.0 ), 0.0, 0.5 ) );
	// fine speckle so no two texels match
	c *= 0.88 + 0.24 * fbm( vUv * 64.0 );

	gl_FragColor = vec4( max( c, vec3( 0.004 ) ), cover );
}
`;

/**
 * Coverage-only mask. Bound as the material's `alphaMap` (three reads the **green**
 * channel) rather than piggy-backing on the albedo's alpha, because the GBuffer and
 * shadow passes derive stand-in materials that carry `alphaMap` across — this is what
 * makes foliage cut out correctly in SSAO, SSR and the shadow maps too.
 */
// language=GLSL
const LEAF_MASK_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uField;
void main() {
	float a = texture2D( uField, vUv ).a;
	gl_FragColor = vec4( a, a, a, a );
}
`;

// language=GLSL
const BARK_ALBEDO_FRAG = /* glsl */ `
${NOISE}
uniform sampler2D uField;

void main() {
	vec4 f = texture2D( uField, vUv );
	float h = f.r, crack = f.g, lichen = f.b;
	vec3 pale = vec3( 0.262, 0.230, 0.180 );
	vec3 dark = vec3( 0.055, 0.045, 0.034 );
	vec3 c = mix( dark, pale, pow( clamp( h, 0.0, 1.0 ), 0.85 ) );
	c = mix( c, dark * 0.55, crack * 0.9 );                       // crevices go black
	c = mix( c, vec3( 0.135, 0.146, 0.108 ), lichen * 0.55 );     // grey-green lichen
	c *= 0.88 + 0.26 * fbm( vUv * 48.0 );
	// sun-bleaching on the exposed ridges
	c += vec3( 0.030, 0.026, 0.018 ) * smoothstep( 0.62, 0.95, h );
	gl_FragColor = vec4( max( c, vec3( 0.004 ) ), clamp( h, 0.0, 1.0 ) );
}
`;

// language=GLSL
const NORMAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uField;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uMaskGate;

void main() {
	float l = texture2D( uField, vUv - vec2( uTexel.x, 0.0 ) ).r;
	float r = texture2D( uField, vUv + vec2( uTexel.x, 0.0 ) ).r;
	float d = texture2D( uField, vUv - vec2( 0.0, uTexel.y ) ).r;
	float u = texture2D( uField, vUv + vec2( 0.0, uTexel.y ) ).r;
	float a = texture2D( uField, vUv ).a;
	vec3 n = normalize( vec3( ( l - r ) * uStrength, ( d - u ) * uStrength, 1.0 ) );
	// Outside the leaf the gradient is meaningless — flatten it so mip bleed on the
	// silhouette does not throw the shading off.
	n = normalize( mix( vec3( 0.0, 0.0, 1.0 ), n, mix( 1.0, smoothstep( 0.35, 0.9, a ), uMaskGate ) ) );
	gl_FragColor = vec4( n * 0.5 + 0.5, 1.0 );
}
`;

// language=GLSL
const LEAF_ORM_FRAG = /* glsl */ `
${NOISE}
uniform sampler2D uField;

void main() {
	vec4 f = texture2D( uField, vUv );
	float h = f.r, vein = f.g, varn = f.b;
	// AO: leaves buried under other leaves are darker, and so is the trough of the
	// cross-section. This is what stops a leaf cluster reading as one flat card.
	float ao = 0.46 + 0.54 * pow( clamp( h, 0.0, 1.0 ), 0.70 );
	ao *= 0.90 + 0.14 * fbm( vUv * 30.0 );
	// Roughness is remapped by the recipe into [0.35, 0.85]; waxy cuticle on the
	// upper blade, dusty and matte at the base and on dried tips.
	float rough = 0.30 + 0.50 * ( 1.0 - h ) + 0.22 * varn;
	rough -= vein * 0.10;
	rough += fbm( vUv * 40.0 + 9.0 ) * 0.18 - 0.06;
	gl_FragColor = vec4( clamp( ao, 0.0, 1.0 ), clamp( rough, 0.02, 1.0 ), 0.0, 1.0 );
}
`;

// language=GLSL
const BARK_ORM_FRAG = /* glsl */ `
${NOISE}
uniform sampler2D uField;

void main() {
	vec4 f = texture2D( uField, vUv );
	float h = f.r, crack = f.g, lichen = f.b;
	float ao = 0.34 + 0.66 * pow( clamp( h, 0.0, 1.0 ), 0.65 );
	ao = min( ao, 1.0 - crack * 0.42 );
	float rough = 0.62 + 0.34 * ( 1.0 - h ) + lichen * 0.16;
	rough += fbm( vUv * 36.0 ) * 0.16 - 0.05;
	gl_FragColor = vec4( clamp( ao, 0.0, 1.0 ), clamp( rough, 0.02, 1.0 ), 0.0, 1.0 );
}
`;

/* ========================================================================== */
/*                                   baker                                    */
/* ========================================================================== */

const CELL = 0.5;
const INSET = 0.004;

/** UV rect of an atlas cell, inset so bilinear/mip filtering cannot bleed neighbours. */
export function cellRect(index) {
  const i = ((index | 0) % 4 + 4) % 4;
  const cx = i % 2;
  const cy = (i / 2) | 0;
  return {
    u0: cx * CELL + INSET,
    v0: cy * CELL + INSET,
    du: CELL - INSET * 2,
    dv: CELL - INSET * 2,
  };
}

export const LEAF_CELL = Object.freeze({ grass: 0, olive: 1, broad: 2, frond: 3 });
export const BARK_CELL = Object.freeze({ olive: 0, palm: 1, smooth: 2, twig: 3 });

function fullscreenGeometry() {
  const g = new THREE.BufferGeometry();
  // Three components, not two: three's bounding-sphere helpers read .getZ() and a
  // 2-component position attribute makes them produce NaN.
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  );
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(3, 3, 1));
  return g;
}

class Baker {
  constructor(renderer) {
    this.renderer = renderer;
    this.geo = fullscreenGeometry();
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera();
    this.mesh = new THREE.Mesh(this.geo, null);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.owned = [];
  }

  target(res, { srgb = false, mips = true, aniso = 1 } = {}) {
    const rt = new THREE.WebGLRenderTarget(res, res, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    });
    rt.texture.name = 'foliage';
    rt.texture.anisotropy = Math.max(1, aniso | 0);
    this.owned.push(rt);
    return rt;
  }

  run(rt, frag, uniforms) {
    const r = this.renderer;
    const mat = new THREE.RawShaderMaterial({
      vertexShader: TRI_VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh.material = mat;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevColor = new THREE.Color();
    r.getClearColor(prevColor);
    const prevAlpha = r.getClearAlpha();
    try {
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.autoClear = false;
      r.clear(true, false, false);
      r.render(this.scene, this.camera);
    } finally {
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevColor, prevAlpha);
      r.autoClear = prevAutoClear;
      this.mesh.material = null;
      mat.dispose();
    }
    return rt.texture;
  }

  dispose() {
    this.geo.dispose();
    this.scene.clear();
  }
}

/* ========================================================================== */
/*                                   public                                   */
/* ========================================================================== */

/**
 * Bake both atlases.
 * @returns {{leaf:{map,normalMap,ormMap}, bark:{map,normalMap,ormMap,heightMap},
 *            res:number, dispose:()=>void, ok:boolean}}
 */
export function buildFoliageAtlas(ctx, opts = {}) {
  const renderer = ctx.renderer;
  const settings = ctx.settings;
  // The field pass evaluates ~16 leaf primitives per texel, so the cost is quadratic in
  // resolution. 512 gives each of the four atlas cells a 256px cluster, which is plenty
  // for geometry this small on screen — and it keeps the CI software rasteriser sane.
  const wanted = opts.res ?? Math.min(settings?.get?.('textureResolution') ?? 1024, 1024);
  const res = Math.max(256, Math.min(settings?.get?.('headless') ? 512 : 1024, 1 << Math.round(Math.log2(wanted))));
  const aniso = Math.min(ctx.maxAnisotropy || 4, settings?.get?.('anisotropy') ?? 8);
  const seed = Math.floor((ctx.rng?.() ?? 0.5) * 8192) + 3;

  const out = { leaf: null, bark: null, res, ok: false, dispose: () => {} };
  if (!renderer) return out;

  const baker = new Baker(renderer);
  try {
    const mkField = (frag) => {
      const rt = baker.target(res, { srgb: false, mips: false, aniso: 1 });
      rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping;
      baker.run(rt, frag, { uSeed: { value: seed } });
      return rt;
    };

    const leafField = mkField(LEAF_FIELD_FRAG);
    const barkField = mkField(BARK_FIELD_FRAG);

    const derive = (field, albedoFrag, ormFrag, normalStrength, maskGate) => {
      const albedo = baker.target(res, { srgb: true, mips: true, aniso });
      baker.run(albedo, albedoFrag, { uField: { value: field.texture }, uSeed: { value: seed } });
      const normal = baker.target(res, { srgb: false, mips: true, aniso });
      baker.run(normal, NORMAL_FRAG, {
        uField: { value: field.texture },
        uTexel: { value: new THREE.Vector2(1 / res, 1 / res) },
        uStrength: { value: normalStrength },
        uMaskGate: { value: maskGate },
      });
      const orm = baker.target(res, { srgb: false, mips: true, aniso });
      baker.run(orm, ormFrag, { uField: { value: field.texture }, uSeed: { value: seed } });
      return { map: albedo.texture, normalMap: normal.texture, ormMap: orm.texture };
    };

    out.leaf = derive(leafField, LEAF_ALBEDO_FRAG, LEAF_ORM_FRAG, 5.5, 1.0);
    const mask = baker.target(res, { srgb: false, mips: true, aniso });
    baker.run(mask, LEAF_MASK_FRAG, { uField: { value: leafField.texture } });
    out.leaf.alphaMap = mask.texture;

    out.bark = derive(barkField, BARK_ALBEDO_FRAG, BARK_ORM_FRAG, 5.5, 0.0);
    // The bark trunks are the one place foliage uses parallax; the extension wants a
    // dedicated height map and the field target already is one.
    barkField.texture.wrapS = barkField.texture.wrapT = THREE.RepeatWrapping;
    out.bark.heightMap = barkField.texture;

    out.ok = true;
  } catch (err) {
    console.warn('[foliage] atlas bake failed, falling back to library textures', err);
    out.ok = false;
  }

  const targets = baker.owned.slice();
  baker.dispose();
  out.dispose = () => {
    for (const rt of targets) {
      try {
        rt.dispose();
      } catch {
        /* best effort */
      }
    }
    targets.length = 0;
  };
  return out;
}

export default buildFoliageAtlas;
