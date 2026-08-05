/**
 * weather/shaders.js — every GLSL string the weather system owns.
 * Owner: weather agent. Files owned: src/render/Weather.js, src/render/weather/**.
 *
 * All of these are `THREE.ShaderMaterial` sources (ESSL1, matching the rest of the
 * render stack), so three injects `position` / `uv` / `projectionMatrix` /
 * `viewMatrix` / `modelMatrix` / `cameraPosition` for us — never redeclare them.
 *
 * The shelter map is a single-channel half-float texture holding the **world Y of the
 * topmost surface** over the whole level, baked once from a top-down orthographic
 * depth render (see ShelterMap.js). Everything that must not happen indoors —
 * rain, splashes, ripples, lens droplets, litter, sun-shaft motes — tests against it.
 *
 *   uShelterRect = vec4( minX, maxZ, 1/sizeX, -1/sizeZ )
 *   uv = ( wp.xz - rect.xy ) * rect.zw
 */

// language=GLSL
export const W_COMMON = /* glsl */ `
float wHash11( float p ) {
	p = fract( p * 0.1031 );
	p *= p + 33.33;
	p *= p + p;
	return fract( p );
}
float wHash21( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 wHash22( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.xx + p3.yz ) * p3.zy );
}
float wNoise2( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = wHash21( i );
	float b = wHash21( i + vec2( 1.0, 0.0 ) );
	float c = wHash21( i + vec2( 0.0, 1.0 ) );
	float d = wHash21( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float wFbm2( vec2 p ) {
	float s = 0.0, a = 0.5;
	for ( int i = 0; i < 4; i++ ) { s += a * wNoise2( p ); p *= 2.03; a *= 0.5; }
	return s;
}

/**
 * The screen-space passes composite onto the *already sRGB-encoded* default
 * framebuffer, but sample the pipeline's linear display-referred buffer. Getting
 * this transfer wrong is the difference between a droplet that disappears and one
 * that reads as a grey blob, so it is spelled out rather than approximated with 2.2.
 */
vec3 wLinearToSRGB( vec3 c ) {
	c = max( c, vec3( 0.0 ) );
	return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
}
`;

/** Shelter-map sampling. Needs `uShelter`, `uShelterRect`, `uHasShelter`. */
// language=GLSL
export const W_SHELTER = /* glsl */ `
uniform sampler2D uShelter;
uniform vec4  uShelterRect;
uniform float uHasShelter;

/** World Y of the topmost surface above/below (x,z); -9000 outside the bake. */
float wTopAt( vec2 xz ) {
	if ( uHasShelter < 0.5 ) return -9000.0;
	vec2 uv = ( xz - uShelterRect.xy ) * uShelterRect.zw;
	if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return -9000.0;
	return texture2D( uShelter, uv ).r;
}

/** 1 when the point can see straight up to the sky, 0 when it is under a roof. */
float wOpenSky( vec3 p, float bias ) {
	return step( wTopAt( p.xz ) - bias, p.y );
}

/** Cheap three-tap march along the sun direction: 1 = lit, 0 = shadowed. */
float wSunVis( vec3 p, vec3 sunDir ) {
	if ( uHasShelter < 0.5 ) return 1.0;
	float v = 1.0;
	v *= step( wTopAt( p.xz + sunDir.xz * 1.6 ), p.y + sunDir.y * 1.6 + 0.15 );
	v *= step( wTopAt( p.xz + sunDir.xz * 4.5 ), p.y + sunDir.y * 4.5 + 0.15 );
	v *= step( wTopAt( p.xz + sunDir.xz * 11.0 ), p.y + sunDir.y * 11.0 + 0.15 );
	return v;
}
`;

/* ══════════════════════════════════════════════════════════════════════ rain ══ */

// language=GLSL
export const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed;   // xyz = home in the unit box, w = phase
attribute vec2 aParam;  // x = spawn threshold, y = speed variation

uniform float uTime;
uniform vec3  uAnchor;      // camera position, snapped so drops stay world-locked
uniform vec3  uBox;         // half extents of the rain volume
uniform vec3  uVel;         // ( wind.x, -fallSpeed, wind.z )
uniform float uWidth;
uniform float uStretch;
uniform float uIntensity;
uniform float uNearFade;

varying vec2  vUv;
varying float vFade;
varying float vNear;

${W_SHELTER}

void main() {
	vUv = uv;

	float span  = uBox.y * 2.0;
	float speed = max( 0.5, -uVel.y ) * ( 0.72 + 0.56 * aParam.y );
	vec3  vel   = vec3( uVel.x, -speed, uVel.z );
	float life  = span / speed;
	// Deterministic per-instance phase: drops are never in lockstep and never pop.
	float age   = mod( uTime + aSeed.w * life * 13.0, life );

	vec3 home = ( aSeed.xyz - 0.5 ) * uBox * 2.0;
	vec3 p = vec3( home.x, uBox.y, home.z ) + vel * age;
	// Wind would otherwise sweep one wall of the box empty — wrap in XZ.
	p.xz = mod( p.xz + uBox.xz, uBox.xz * 2.0 ) - uBox.xz;

	vec3 wp = uAnchor + p;

	float alive = step( aParam.x, uIntensity );
	alive *= wOpenSky( wp, 0.30 );

	vec3 toCam = cameraPosition - wp;
	float dist = length( toCam );
	toCam /= max( dist, 1e-4 );

	vec3 vdir = normalize( vel );
	vec3 side = cross( vdir, toCam );
	float sl = length( side );
	side = sl > 1e-4 ? side / sl : vec3( 1.0, 0.0, 0.0 );

	// Motion stretch: the streak is how far the drop travels in one exposure.
	float len = uStretch * speed * ( 0.55 + 0.9 * aSeed.x );
	// Parallax: near drops are fatter and softer, far drops thin out into a veil.
	float wid = uWidth * ( 0.65 + 0.7 * aSeed.z ) * ( 1.0 + dist * 0.020 );

	vec3 pos = wp + side * ( ( uv.x - 0.5 ) * wid ) + vdir * ( ( uv.y - 0.5 ) * len );

	vNear = smoothstep( uNearFade, uNearFade * 3.2, dist );
	vFade = vNear * ( 1.0 - smoothstep( uBox.x * 0.70, uBox.x * 1.02, dist ) ) * alive;

	gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
	if ( vFade <= 0.0011 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

// language=GLSL
export const RAIN_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uColor;
uniform vec3  uSunColor;
uniform float uOpacity;

varying vec2  vUv;
varying float vFade;
varying float vNear;

void main() {
	float ax = 1.0 - abs( vUv.x * 2.0 - 1.0 );
	ax = smoothstep( 0.0, 0.9, ax );
	// A falling drop is a teardrop smeared into a line: bright head, fading tail.
	float ay = smoothstep( 0.0, 0.34, vUv.y ) * smoothstep( 1.0, 0.58, vUv.y );
	float a = ax * ay * vFade * uOpacity;
	if ( a < 0.0035 ) discard;

	// A water cylinder is a lens — it concentrates whatever is behind it into a
	// bright core, which is why rain reads as light streaks and not grey dashes.
	float core = ax * ax * ax;
	vec3 c = uColor * ( 0.45 + 0.75 * core ) + uSunColor * core * 0.55;

	gl_FragColor = vec4( c, a );
}
`;

/* ═══════════════════════════════════════════════════════════════════ splashes ══ */

// language=GLSL
export const SPLASH_VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aData;   // x = birth, y = life, z = size, w = seed

uniform float uTime;
uniform float uSizeScale;

varying vec2  vUv;
varying float vAge;
varying float vSeed;

void main() {
	vUv = uv;
	vSeed = aData.w;

	float t = ( uTime - aData.x ) / max( aData.y, 1e-3 );
	vAge = t;
	if ( t < 0.0 || t > 1.0 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }

	float s = aData.z * uSizeScale * ( 0.30 + 1.35 * sqrt( t ) );
	vec3 centre = aOrigin + vec3( 0.0, s * 0.42, 0.0 );

	vec3 right = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
	vec3 up    = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );

	vec3 pos = centre + right * ( ( uv.x - 0.5 ) * s ) + up * ( ( uv.y - 0.5 ) * s );
	gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
}
`;

// language=GLSL
export const SPLASH_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uColor;
uniform float uOpacity;

varying vec2  vUv;
varying float vAge;
varying float vSeed;

void main() {
	vec2 q = vUv * 2.0 - 1.0;
	float r = length( q );

	// Crown: a rising ring of water with a few taller spikes on one side.
	float ring = smoothstep( 1.0, 0.62, r ) * smoothstep( 0.10, 0.52, r );
	float ang = atan( q.y, q.x );
	ring *= 0.55 + 0.45 * cos( ang * ( 5.0 + floor( vSeed * 4.0 ) ) + vSeed * 31.0 );
	// A short central jet that outlives the crown.
	float jet = exp( -pow( ( q.y - 0.15 ) * 2.6, 2.0 ) ) * exp( -pow( q.x * 6.5, 2.0 ) );

	float a = clamp( ring * 0.85 + jet * 0.6, 0.0, 1.0 );
	a *= ( 1.0 - vAge ) * ( 1.0 - vAge ) * uOpacity;
	if ( a < 0.004 ) discard;

	gl_FragColor = vec4( uColor, a );
}
`;

// language=GLSL
export const RIPPLE_VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aData;   // x = birth, y = life, z = size, w = seed

uniform float uTime;

varying vec2  vUv;
varying float vAge;

void main() {
	vUv = uv;
	float t = ( uTime - aData.x ) / max( aData.y, 1e-3 );
	vAge = t;
	if ( t < 0.0 || t > 1.0 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }

	float s = aData.z * ( 0.25 + 1.6 * t );
	// Ripples lie flat on the water film, lifted a hair to beat z-fighting.
	vec3 pos = aOrigin + vec3( ( uv.x - 0.5 ) * s, 0.012, ( uv.y - 0.5 ) * s );
	gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
}
`;

// language=GLSL
export const RIPPLE_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uColor;
uniform float uOpacity;

varying vec2  vUv;
varying float vAge;

void main() {
	vec2 q = vUv * 2.0 - 1.0;
	float r = length( q );
	if ( r > 1.0 ) discard;

	// Two concentric rings expanding at slightly different rates.
	float w = 0.16 + 0.10 * vAge;
	float a1 = smoothstep( w, 0.0, abs( r - 0.92 ) );
	float a2 = smoothstep( w * 0.7, 0.0, abs( r - 0.55 ) ) * 0.55;
	float a = ( a1 + a2 ) * ( 1.0 - vAge ) * ( 1.0 - vAge ) * uOpacity;
	if ( a < 0.003 ) discard;

	gl_FragColor = vec4( uColor, a );
}
`;

/* ══════════════════════════════════════════════════════════════════════ drips ══ */

// language=GLSL
export const DRIP_VERT = /* glsl */ `
attribute vec4 aEdge;   // xyz = lip position, w = fall distance
attribute vec3 aTune;   // x = period, y = phase, z = size

uniform float uTime;
uniform float uRate;      // cycles/second multiplier
uniform float uIntensity;

varying vec2  vUv;
varying float vFade;

void main() {
	vUv = uv;

	float period = aTune.x / max( uRate, 0.05 );
	float tc = mod( uTime + aTune.y * period, period );

	// Free fall: t = sqrt( 2h/g ). Anything longer is the bead swelling on the lip.
	float fallT = sqrt( 2.0 * max( aEdge.w, 0.05 ) / 9.81 );
	float y, s, a;
	if ( tc < fallT ) {
		float d = 4.905 * tc * tc;
		y = aEdge.y - d;
		s = aTune.z * ( 1.0 + min( tc * 3.0, 2.4 ) );      // stretches as it accelerates
		a = 1.0;
	} else {
		float g = clamp( ( tc - fallT ) / max( period - fallT, 0.05 ), 0.0, 1.0 );
		y = aEdge.y - 0.02;
		s = aTune.z * ( 0.35 + 0.9 * g * g );               // the next bead swelling
		a = g * g * 0.85;
	}

	vec3 centre = vec3( aEdge.x, y, aEdge.z );
	vec3 toCam = cameraPosition - centre;
	float dist = length( toCam );
	toCam /= max( dist, 1e-4 );
	vec3 side = normalize( cross( vec3( 0.0, 1.0, 0.0 ), toCam ) );

	vec3 pos = centre
		+ side * ( ( uv.x - 0.5 ) * aTune.z * 0.9 )
		+ vec3( 0.0, ( uv.y - 0.5 ) * s, 0.0 );

	vFade = a * uIntensity * ( 1.0 - smoothstep( 16.0, 26.0, dist ) ) * smoothstep( 0.4, 1.2, dist );
	gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
	if ( vFade <= 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

// language=GLSL
export const DRIP_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uColor;

varying vec2  vUv;
varying float vFade;

void main() {
	vec2 q = vUv * 2.0 - 1.0;
	// Teardrop: round at the bottom, drawn to a point at the top.
	float taper = mix( 1.0, 0.25, clamp( q.y * 0.5 + 0.5, 0.0, 1.0 ) );
	float d = length( vec2( q.x / max( taper, 0.05 ), q.y ) );
	float a = smoothstep( 1.0, 0.45, d ) * vFade;
	if ( a < 0.004 ) discard;
	float core = smoothstep( 0.9, 0.1, d );
	gl_FragColor = vec4( uColor * ( 0.5 + 0.9 * core ), a );
}
`;

/* ═══════════════════════════════════════════════════════════════════ airborne ══ */

/** Dust motes and wind-driven grit share one shader; uniforms decide the mood. */
// language=GLSL
export const MOTE_VERT = /* glsl */ `
attribute vec4 aSeed;   // xyz home, w phase
attribute vec2 aParam;  // x threshold, y size variation

uniform float uTime;
uniform vec3  uAnchor;
uniform vec3  uBox;
uniform vec3  uDrift;       // metres/second of bulk transport
uniform vec2  uJitter;      // x = amplitude, y = frequency
uniform float uSize;
uniform float uIntensity;
uniform vec3  uSunDir;      // world-space direction *to* the sun
uniform float uShaftBoost;
uniform float uIndoorFloor;

varying vec2  vUv;
varying float vFade;
varying float vLit;

${W_SHELTER}

void main() {
	vUv = uv;

	vec3 home = ( aSeed.xyz - 0.5 ) * uBox * 2.0;
	vec3 p = home + uDrift * uTime;
	p = mod( p + uBox, uBox * 2.0 ) - uBox;
	// Brownian wander so nothing travels in a dead straight line.
	float ph = aSeed.w * 62.83;
	p += vec3(
		sin( uTime * uJitter.y * 0.83 + ph ),
		sin( uTime * uJitter.y * 0.61 + ph * 1.7 ) * 0.6,
		cos( uTime * uJitter.y * 0.72 + ph * 2.3 )
	) * uJitter.x;

	vec3 wp = uAnchor + p;

	float alive = step( aParam.x, uIntensity );

	// Motes only read as motes when they light up crossing a sun shaft.
	float lit = wSunVis( wp, uSunDir );
	vLit = mix( uIndoorFloor, 1.0, lit ) * ( 1.0 + uShaftBoost * lit );

	vec3 toCam = cameraPosition - wp;
	float dist = length( toCam );
	toCam /= max( dist, 1e-4 );

	vec3 right = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
	vec3 up    = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );

	float s = uSize * ( 0.4 + 1.2 * aParam.y );
	vec3 pos = wp + right * ( ( uv.x - 0.5 ) * s ) + up * ( ( uv.y - 0.5 ) * s );

	// Forward scattering: a mote seen against the sun is many times brighter.
	float fs = pow( max( dot( -toCam, uSunDir ), 0.0 ), 6.0 );
	vLit *= 0.55 + 2.6 * fs;

	vFade = alive
		* smoothstep( 0.25, 0.9, dist )
		* ( 1.0 - smoothstep( uBox.x * 0.6, uBox.x * 1.0, dist ) );

	gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
	if ( vFade <= 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

// language=GLSL
export const MOTE_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uColor;
uniform float uOpacity;

varying vec2  vUv;
varying float vFade;
varying float vLit;

void main() {
	vec2 q = vUv * 2.0 - 1.0;
	float d = dot( q, q );
	if ( d > 1.0 ) discard;
	float a = ( 1.0 - d ) * ( 1.0 - d ) * vFade * uOpacity;
	if ( a < 0.0025 ) discard;
	gl_FragColor = vec4( uColor * vLit, a );
}
`;

/* ═════════════════════════════════════════════════════════════════════ litter ══ */

// language=GLSL
export const LITTER_VERT = /* glsl */ `
attribute vec4 aSeed;   // xz home, y kind, w phase
attribute vec2 aParam;  // x threshold, y size

uniform float uTime;
uniform vec3  uAnchor;
uniform vec2  uBox;
uniform vec3  uWind;        // world-space wind velocity
uniform float uIntensity;
uniform float uSize;
uniform sampler2D uGround;
uniform vec4  uGroundRect;
uniform float uHasGround;

varying vec2  vUv;
varying float vFade;
varying float vKind;

void main() {
	vUv = uv;
	vKind = aSeed.y;

	float sp = 0.55 + 0.9 * aSeed.w;
	vec2 xz = ( aSeed.xz - 0.5 ) * uBox * 2.0 + uWind.xz * uTime * sp;
	xz = mod( xz + uBox, uBox * 2.0 ) - uBox;
	vec2 wxz = uAnchor.xz + xz;

	float g = uAnchor.y - 1.7;
	if ( uHasGround > 0.5 ) {
		vec2 guv = ( wxz - uGroundRect.xy ) * uGroundRect.zw;
		if ( guv.x > 0.0 && guv.x < 1.0 && guv.y > 0.0 && guv.y < 1.0 ) {
			g = texture2D( uGround, guv ).r;
		}
	}

	// Tumble: scraping along, catching, hopping. Height is driven by wind strength.
	float ws = length( uWind.xz );
	float ph = uTime * ( 2.2 + 3.4 * aSeed.w ) + aSeed.x * 41.0;
	float hop = abs( sin( ph ) ) * ( 0.06 + 0.30 * clamp( ws * 0.22, 0.0, 1.6 ) );
	vec3 centre = vec3( wxz.x, g + 0.035 + hop, wxz.y );

	float spin = ph * 0.8;
	float cs = cos( spin ), sn = sin( spin );
	float s = uSize * ( 0.55 + 0.9 * aParam.y );

	// Tumbling card: spins about the wind axis, so it flashes edge-on and flat.
	vec3 wdir = ws > 1e-3 ? normalize( vec3( uWind.x, 0.0, uWind.z ) ) : vec3( 1.0, 0.0, 0.0 );
	vec3 axis = vec3( -wdir.z, 0.0, wdir.x );
	vec3 nrm = normalize( vec3( 0.0, 1.0, 0.0 ) * cs + wdir * sn );
	vec3 tan2 = normalize( cross( nrm, axis ) );

	vec3 pos = centre + axis * ( ( uv.x - 0.5 ) * s ) + tan2 * ( ( uv.y - 0.5 ) * s );

	float dist = distance( cameraPosition, centre );
	vFade = step( aParam.x, uIntensity )
		* smoothstep( 0.5, 1.6, dist )
		* ( 1.0 - smoothstep( uBox.x * 0.62, uBox.x * 0.98, dist ) );

	gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
	if ( vFade <= 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

// language=GLSL
export const LITTER_FRAG = /* glsl */ `
precision highp float;

uniform vec3 uPaper;
uniform vec3 uLeaf;
uniform float uOpacity;

varying vec2  vUv;
varying float vFade;
varying float vKind;

void main() {
	vec2 q = vUv * 2.0 - 1.0;
	float leaf = step( 0.5, vKind );

	// Paper is a torn rectangle; a leaf is a pointed ellipse.
	float shapePaper = step( abs( q.x ), 0.92 ) * step( abs( q.y ), 0.72 );
	float e = length( vec2( q.x * 1.35, q.y * 0.85 ) );
	float shapeLeaf = smoothstep( 1.0, 0.86, e );

	float a = mix( shapePaper, shapeLeaf, leaf ) * vFade * uOpacity;
	if ( a < 0.02 ) discard;

	vec3 c = mix( uPaper, uLeaf, leaf );
	// A crease down the middle so it never reads as a flat swatch.
	c *= 0.72 + 0.42 * abs( q.y );
	gl_FragColor = vec4( c, a );
}
`;

/* ═══════════════════════════════════════════════════════════════════════ mist ══ */

// language=GLSL
export const MIST_VERT = /* glsl */ `
attribute vec4 aSeed;

uniform float uTime;
uniform vec3  uAnchor;
uniform vec3  uBox;
uniform vec3  uWind;
uniform float uSize;
uniform float uIntensity;
uniform sampler2D uGround;
uniform vec4  uGroundRect;
uniform float uHasGround;

varying vec2  vUv;
varying float vFade;
varying float vSeed;

void main() {
	vUv = uv;
	vSeed = aSeed.w;

	vec2 xz = ( aSeed.xz - 0.5 ) * uBox.xz * 2.0 + uWind.xz * uTime * 0.22;
	xz = mod( xz + uBox.xz, uBox.xz * 2.0 ) - uBox.xz;
	vec2 wxz = uAnchor.xz + xz;

	float g = uAnchor.y - 1.7;
	if ( uHasGround > 0.5 ) {
		vec2 guv = ( wxz - uGroundRect.xy ) * uGroundRect.zw;
		if ( guv.x > 0.0 && guv.x < 1.0 && guv.y > 0.0 && guv.y < 1.0 ) g = texture2D( uGround, guv ).r;
	}

	float s = uSize * ( 0.6 + 0.8 * aSeed.y );
	float lift = 0.25 + 0.55 * aSeed.y + 0.12 * sin( uTime * 0.21 + aSeed.w * 27.0 );
	vec3 centre = vec3( wxz.x, g + lift, wxz.y );

	// Cylindrical billboard: mist keeps its horizontal lie, so it never pancakes
	// when you look down at it.
	vec3 toCam = cameraPosition - centre;
	toCam.y = 0.0;
	float dist = length( toCam );
	toCam = dist > 1e-3 ? toCam / dist : vec3( 0.0, 0.0, 1.0 );
	vec3 right = normalize( cross( vec3( 0.0, 1.0, 0.0 ), toCam ) );

	vec3 pos = centre + right * ( ( uv.x - 0.5 ) * s ) + vec3( 0.0, ( uv.y - 0.5 ) * s * 0.42, 0.0 );

	// Fade hard at both ends of the range: near, so it never fills the lens; far,
	// so it dissolves into the analytic aerial mist instead of ending in a line.
	vFade = uIntensity
		* smoothstep( 2.0, 7.0, dist )
		* ( 1.0 - smoothstep( uBox.x * 0.5, uBox.x * 0.95, dist ) );

	gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
	if ( vFade <= 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

// language=GLSL
export const MIST_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uColor;
uniform float uOpacity;
uniform float uTime;

varying vec2  vUv;
varying float vFade;
varying float vSeed;

${W_COMMON}

void main() {
	vec2 q = vUv * 2.0 - 1.0;
	float r = length( vec2( q.x, q.y * 1.7 ) );
	float body = smoothstep( 1.0, 0.05, r );
	if ( body <= 0.001 ) discard;

	float n = wFbm2( vUv * 3.2 + vec2( vSeed * 17.0, vSeed * 9.0 - uTime * 0.05 ) );
	float a = body * body * ( 0.35 + 0.75 * n ) * vFade * uOpacity;
	if ( a < 0.0025 ) discard;

	gl_FragColor = vec4( uColor, a );
}
`;

/* ════════════════════════════════════════════════════════════ lens / camera FX ══ */

// language=GLSL
export const LENS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy * 2.0, 0.0, 1.0 );
}
`;

// language=GLSL
export const LENS_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec4  uCam;        // near, far, viewNear, viewFar
uniform vec2  uResolution;
uniform float uTime;
uniform float uAspect;
uniform float uDrops;      // 0..1 how much water is on the front element
uniform float uRun;        // 0..1 how readily beads run (heavier rain = faster)
uniform float uShimmer;    // 0..1 heat haze over hot ground
uniform float uHorizon;    // screen-space y of the horizon, 0..1
uniform vec3  uSpec;       // colour of the specular pip on each bead
uniform float uHasDepth;
uniform vec2  uVignette;   // x = strength, y = roundness — LensPass's own settings

varying vec2 vUv;

${W_COMMON}

/**
 * We sample the pipeline's pre-lens buffer, but composite over the post-lens frame, so
 * the light inside a droplet has to be darkened by the same vignette the pixels around
 * it already got. This is LensPass's cos^4 + mechanical falloff, verbatim; without it
 * every bead near a corner glows brighter than the frame it sits on.
 */
float wVignette( vec2 uv ) {
	vec2 vc = ( uv - 0.5 ) * vec2( mix( uAspect, 1.0, uVignette.y ), 1.0 );
	float rr = length( vc ) * 2.0;
	float cosTheta = inversesqrt( 1.0 + rr * rr * 0.55 );
	float natural = cosTheta * cosTheta * cosTheta * cosTheta;
	float mechanical = 1.0 - smoothstep( 0.78, 1.5, rr ) * 0.35;
	return mix( 1.0, natural * mechanical, uVignette.x );
}

float wLinearDepth( vec2 uv ) {
	if ( uHasDepth < 0.5 ) return 1e4;
	float d = texture2D( tDepth, uv ).x;
	if ( d >= 0.999999 ) return 1e4;
	float z = d * 2.0 - 1.0;
	return ( 2.0 * uCam.x * uCam.y ) / ( uCam.y + uCam.x - z * ( uCam.y - uCam.x ) );
}

/**
 * One cell layer of beads. Cells hold at most one bead; big beads slide down under
 * gravity leaving a thinning trail, small ones cling. Each cell has its own
 * accumulate -> run -> evaporate cycle so the field never pulses in unison.
 */
vec3 wDropLayer( vec2 uv, float scale, float t, float amount, float run ) {
	vec2 st = uv * vec2( scale * uAspect, scale );
	vec2 id = floor( st );
	vec2 f = fract( st );

	float n = wHash21( id );
	vec2 n2 = wHash22( id + 7.31 );

	// Lifecycle: born, runs, is wiped. 0.78 of the cycle is "present".
	float cyc = fract( n * 3.77 + t / ( 7.5 + 6.0 * n2.x ) );
	float present = smoothstep( 0.0, 0.08, cyc ) * smoothstep( 0.86, 0.70, cyc );
	if ( n > amount || present <= 0.001 ) return vec3( 0.0 );

	float big = n2.y;
	float speed = run * ( 0.10 + 0.95 * big * big );
	float fall = fract( n * 5.19 + t * speed * 0.22 );

	vec2 c = vec2( 0.18 + 0.64 * n2.x, 1.0 - fall );
	vec2 q = f - c;

	float sz = ( 0.11 + 0.20 * big ) * ( 0.55 + 0.75 * present );
	float bead = smoothstep( sz, sz * 0.30, length( q * vec2( 1.0, 1.12 ) ) );

	// The trail a running bead leaves behind it, broken into beadlets.
	float tw = sz * ( 0.34 + 0.30 * big );
	float trail = smoothstep( tw, 0.0, abs( q.x ) )
		* smoothstep( 0.0, 0.06, q.y )
		* smoothstep( 0.55 * speed + 0.06, 0.02, q.y );
	trail *= 0.30 + 0.55 * wHash21( id * 3.0 + floor( q.y * 34.0 ) );
	trail *= step( 0.20, big );

	float m = clamp( bead + trail * 0.7, 0.0, 1.0 ) * present;
	// Refraction direction: a bead is a tiny ball lens, so it inverts what is behind.
	vec2 grad = -q * m * ( 0.5 + 1.2 * big );
	return vec3( grad, m );
}

void main() {
	vec2 uv = vUv;
	vec2 offs = vec2( 0.0 );
	float mask = 0.0;
	float spec = 0.0;

	if ( uShimmer > 0.001 ) {
		float lin = wLinearDepth( uv );
		// Only far, low, sunlit ground shimmers — never the weapon in your hands.
		float g = smoothstep( 7.0, 26.0, lin ) * smoothstep( 1.0, 0.0, lin / 90.0 );
		g *= smoothstep( uHorizon + 0.06, uHorizon - 0.22, uv.y );
		if ( g > 0.001 ) {
			float w1 = wFbm2( vec2( uv.x * 34.0, uv.y * 96.0 - uTime * 2.3 ) );
			float w2 = wFbm2( vec2( uv.x * 27.0 + 13.7, uv.y * 78.0 - uTime * 1.7 ) );
			offs += ( vec2( w1, w2 ) - 0.5 ) * 0.0075 * uShimmer * g;
			mask = max( mask, g * uShimmer * 0.9 );
		}
	}

	if ( uDrops > 0.003 ) {
		vec3 a = wDropLayer( uv, 7.0,  uTime, uDrops * 0.85, uRun );
		vec3 b = wDropLayer( uv, 13.0, uTime * 1.21 + 4.0, uDrops * 0.70, uRun * 0.7 );
		vec3 c = wDropLayer( uv, 23.0, uTime * 0.83 + 9.0, uDrops * 0.55, uRun * 0.4 );
		vec2 grad = a.xy * 0.055 + b.xy * 0.034 + c.xy * 0.020;
		float m = clamp( a.z + b.z * 0.8 + c.z * 0.55, 0.0, 1.0 );
		offs += grad;
		mask = max( mask, m );
		// The pip of sky reflected off the top-left of every bead.
		spec = pow( clamp( -( a.y * 14.0 ) - ( a.x * 7.0 ), 0.0, 1.0 ), 2.5 ) * a.z;
		spec += pow( clamp( -( b.y * 16.0 ), 0.0, 1.0 ), 3.0 ) * b.z * 0.5;
	}

	if ( mask < 0.002 ) discard;

	vec2 suv = clamp( uv + offs, vec2( 0.0015 ), vec2( 0.9985 ) );
	vec3 scene = texture2D( tScene, suv ).rgb;
	// Water on glass loses a little light and adds a specular pip.
	vec3 col = ( scene * 0.94 + uSpec * spec * 0.55 ) * wVignette( uv );

	gl_FragColor = vec4( wLinearToSRGB( col ), clamp( mask, 0.0, 1.0 ) );
}
`;

/* ══════════════════════════════════════════════════════════════════ lightning ══ */

/**
 * The flash itself is a real light (see Weather.lightning()), so this pass only adds
 * what a light cannot: the sky and the air between you and the strike lighting up.
 * Additive, so the vignette, grain and grade underneath all survive it.
 */
// language=GLSL
export const FLASH_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uColor;
uniform float uAmount;
uniform vec2  uOrigin;   // screen-space position of the bolt
uniform float uSpread;   // 0 = tight glow at the bolt, 1 = whole sky

varying vec2 vUv;

${W_COMMON}

void main() {
	if ( uAmount <= 0.0005 ) discard;
	vec2 d = ( vUv - uOrigin ) * vec2( 1.0, 0.62 );
	// A bright core where the bolt is, falling off into a broad sky-wide lift.
	float core = exp( -dot( d, d ) * mix( 26.0, 2.2, uSpread ) );
	float wide = 0.28 + 0.42 * uSpread;
	// Sky-side bias: the flash comes from above, so the top of the frame gets more.
	float sky = 0.55 + 0.75 * smoothstep( 0.15, 0.95, vUv.y );
	float a = ( core * 0.85 + wide ) * sky * uAmount;
	gl_FragColor = vec4( wLinearToSRGB( uColor * a ), 1.0 );
}
`;

export default {
  W_COMMON,
  W_SHELTER,
  RAIN_VERT,
  RAIN_FRAG,
  SPLASH_VERT,
  SPLASH_FRAG,
  RIPPLE_VERT,
  RIPPLE_FRAG,
  DRIP_VERT,
  DRIP_FRAG,
  MOTE_VERT,
  MOTE_FRAG,
  LITTER_VERT,
  LITTER_FRAG,
  MIST_VERT,
  MIST_FRAG,
  LENS_VERT,
  LENS_FRAG,
  FLASH_FRAG,
};
