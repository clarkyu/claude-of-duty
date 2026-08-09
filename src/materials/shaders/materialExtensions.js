/**
 * materialExtensions — everything three's standard shader does not give us, injected
 * with `onBeforeCompile`. Owner: MaterialLibrary agent.
 *
 * One program text, many variants. Every feature is behind a `#define` so a wall that
 * only wants detail normals does not pay for parallax, and three's own program cache
 * key (which already hashes `material.defines`) keeps the variants apart.
 *
 * Features
 *   COD_TRIPLANAR   world-space projection, whiteout normal blend — no UV stretch on
 *                   slopes, no UVs required at all
 *   COD_POM         parallax occlusion mapping off the forge's displacement map, with
 *                   an optional 4-tap self-shadow and optional silhouette clipping
 *   COD_DETAIL      detail normal + detail albedo faded in by distance so a surface
 *                   stays crisp with the player's face against it
 *   COD_TILEBREAK   second rotated albedo/ORM/normal sample blended by a low-frequency
 *                   mask, faded in with distance so big surfaces never show a grid
 *   COD_VCOL        vertex colour as a *mask* (not a tint): r = grime, g = second
 *                   material (snow/mud), b = water pooling
 *   COD_LAYER       the second material itself (albedo/normal/ORM), height-aware blend
 *   COD_WET         global wetness: darker albedo, lower roughness, higher F0, puddles
 *                   pooling in concavities driven by the height field
 *   COD_DUST        global dust settling on up-facing micro-facets
 *   COD_SSS         wrap/backlight translucency (foliage, skin, thin fabric)
 *   COD_WIND        vertex wind animation from the shared wind uniform
 *   COD_SCREEN      procedural emissive display with scanlines + refresh roll
 *   COD_GLASS       fresnel-driven alpha with a dirt/smudge layer
 *   COD_WATER       two scrolling wave layers, Beer-Lambert absorption, shoreline foam,
 *                   optional planar-reflection texture
 *
 * Chunks replaced: map_fragment, color_fragment, roughnessmap_fragment,
 * metalnessmap_fragment, normal_fragment_maps, emissivemap_fragment, aomap_fragment,
 * project_vertex, plus *appends* after lights_physical_fragment / lights_fragment_end
 * and before opaque_fragment. Deliberately disjoint from the chunks Lighting.js
 * (lights_fragment_begin / lights_fragment_maps) and Sky.js (fog_*) patch, so all three
 * injections chain safely.
 */
import * as THREE from 'three';

/** Bump when the GLSL changes so cached programs are not reused across a hot reload. */
export const EXT_VERSION = 6;

/* ========================================================================== */
/*                             global uniform bag                             */
/* ========================================================================== */

/**
 * One object, shared by reference with every extended material, so the whole world
 * reacts together. MaterialLibrary.update() is the only writer.
 */
export function createGlobals() {
  return {
    uCodTime: { value: 0 },
    /** x,y = wind direction (world XZ, normalised), z = strength, w = gust */
    uCodWind: { value: new THREE.Vector4(0.92, 0.39, 0.35, 0) },
    uCodWetness: { value: 0 },
    uCodDust: { value: 0.18 },
    uCodSunDir: { value: new THREE.Vector3(0.36, 0.86, 0.36) },
    uCodSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
  };
}

export const GLOBAL_KEYS = ['uCodTime', 'uCodWind', 'uCodWetness', 'uCodDust', 'uCodSunDir', 'uCodSunColor'];

/* ========================================================================== */
/*                                   GLSL                                     */
/* ========================================================================== */

// language=GLSL
const GLOBAL_PARS = /* glsl */ `
uniform float uCodTime;
uniform vec4  uCodWind;
uniform float uCodWetness;
uniform float uCodDust;
uniform vec3  uCodSunDir;
uniform vec3  uCodSunColor;
`;

// language=GLSL
const HELPERS = /* glsl */ `
float codSat( float x ) { return clamp( x, 0.0, 1.0 ); }
vec3  codSat3( vec3 v ) { return clamp( v, 0.0, 1.0 ); }

// Normal mapping without precomputed tangents (thetenthplanet.de/archives/1180),
// evaluated in *world* space so triplanar and detail layers can share one frame.
mat3 codTangentFrame( vec3 p, vec3 n, vec2 uv ) {
	vec3 q0 = dFdx( p ), q1 = dFdy( p );
	vec2 s0 = dFdx( uv ), s1 = dFdy( uv );
	vec3 q1p = cross( q1, n ), q0p = cross( n, q0 );
	vec3 T = q1p * s0.x + q0p * s1.x;
	vec3 B = q1p * s0.y + q0p * s1.y;
	float det = max( dot( T, T ), dot( B, B ) );
	float sc = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
	return mat3( T * sc, B * sc, n );
}

vec2 codRot( vec2 v, float c, float s ) { return vec2( c * v.x - s * v.y, s * v.x + c * v.y ); }

// Three decorrelated randoms from one integer cell coordinate (Dave Hoskins' hash33,
// trimmed). Used to give every brick / flag / plank its own identity — the ONLY thing
// that stops a masonry wall reading as one photograph stamped in a grid.
vec3 codHash3( vec2 p ) {
	vec3 q = fract( p.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
	q += dot( q, q.yxz + 33.33 );
	return fract( ( q.xx + q.yz ).xyy * q.zyx );
}
`;

/* --------------------------------------------------------------- vertex --- */

// language=GLSL
export const VERT_PARS = /* glsl */ `
varying vec2 vCodUv;
varying vec3 vCodWPos;
varying vec3 vCodWNrm;
uniform vec4 uCodUvXf;      // repeat.xy, offset.xy
#ifdef COD_WIND
	uniform vec4 uCodWindP; // stiffness, amplitude(m), frequency, plantHeight(m)
	uniform float uCodTime;
	uniform vec4 uCodWind;
#endif
`;

/**
 * Replaces `#include <project_vertex>`: wind first (so it is baked into `transformed`
 * before the projection), then the varyings we need in the fragment stage.
 */
// language=GLSL
export const VERT_BODY = /* glsl */ `
#ifdef COD_WIND
{
	vec4 codBase = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		codBase = batchingMatrix * codBase;
	#endif
	#ifdef USE_INSTANCING
		codBase = instanceMatrix * codBase;
	#endif
	codBase = modelMatrix * codBase;

	// Height above the instance pivot drives flexibility: the trunk stays put, the
	// tips move. (clamp(), not codSat() — the helpers only exist in the fragment pars.)
	float codFlex = clamp( transformed.y / max( 0.05, uCodWindP.w ), 0.0, 1.0 );
	codFlex = pow( codFlex, mix( 2.2, 1.1, clamp( uCodWindP.x, 0.0, 1.0 ) ) );

	float codW = uCodWind.z * ( 1.0 + uCodWind.w );
	vec2  codDir = normalize( uCodWind.xy + vec2( 1e-4, 0.0 ) );
	float codPh = dot( codBase.xz, vec2( 0.43, 0.31 ) ) + uCodTime * uCodWindP.z;

	// Two octaves: a slow bend plus a fast flutter, and a small lift so the geometry
	// does not visibly stretch.
	float codBend = sin( codPh ) * 0.62 + sin( codPh * 2.37 + 1.7 ) * 0.26 + sin( codPh * 5.1 + 0.4 ) * 0.12;
	float codAmp = uCodWindP.y * codW * codFlex;
	vec3  codOff = vec3( codDir.x, 0.0, codDir.y ) * codBend * codAmp;
	codOff.y -= abs( codBend ) * codAmp * 0.28;

	// Back into object space (rotation only — good enough, and cheap).
	transformed += ( vec3( dot( codOff, vec3( modelMatrix[0].xyz ) ),
	                       dot( codOff, vec3( modelMatrix[1].xyz ) ),
	                       dot( codOff, vec3( modelMatrix[2].xyz ) ) ) );
}
#endif

#include <project_vertex>

{
	vec4 codWP = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		codWP = batchingMatrix * codWP;
	#endif
	#ifdef USE_INSTANCING
		codWP = instanceMatrix * codWP;
	#endif
	codWP = modelMatrix * codWP;
	vCodWPos = codWP.xyz;

	vec3 codON = objectNormal;
	#ifdef USE_INSTANCING
		codON = mat3( instanceMatrix ) * codON;
	#endif
	#ifdef USE_BATCHING
		codON = mat3( batchingMatrix ) * codON;
	#endif
	vCodWNrm = normalize( mat3( modelMatrix ) * codON );

	vCodUv = uv * uCodUvXf.xy + uCodUvXf.zw;
}
`;

/* ------------------------------------------------------------- fragment --- */

// language=GLSL
export const FRAG_PARS = /* glsl */ `
varying vec2 vCodUv;
varying vec3 vCodWPos;
varying vec3 vCodWNrm;

uniform vec4 uCodUvXf;
uniform vec2 uCodRough;      // roughness range remapped from the ORM green channel
uniform vec2 uCodMetal;      // metalness range remapped from the ORM blue channel
uniform vec2 uCodNrmScale;   // base normal xy scale
uniform float uCodAoDirect;  // how much AO bleeds into direct light (small!)

uniform sampler2D uCodDetailNormal;
uniform sampler2D uCodGrunge;
uniform sampler2D uCodHeightMap;

#ifdef COD_TRIPLANAR
	uniform vec4 uCodTri;    // 1/metres, sharpness, _, _
#endif
#ifdef COD_POM
	uniform vec4 uCodPom;    // depth(uv units), layers, fadeEnd(m), clip
#endif
#ifdef COD_DETAIL
	uniform vec4 uCodDetail; // tiling, normalStrength, albedoStrength, fadeEnd(m)
#endif
#ifdef COD_TILEBREAK
	uniform vec4 uCodBreak;  // maskScale, strength, nearFraction, farStart(m)
#endif
#ifdef COD_CELLVAR
	uniform vec4 uCodCell;   // countsX, countsY, rowOffset, amount
	uniform vec4 uCodCell2;  // jointX, jointY, hueAmount, roughAmount
#endif
#ifdef COD_MACRO
	uniform vec4 uCodMacro;  // macroStrength, edgeWear, edgeMetal, streak
	uniform vec4 uCodMacro2; // localBandFreq(1/m), valueAmount, tintAmount, roughAmount
	uniform vec3 uCodMacroTint;
	uniform vec4 uCodWear;   // albedoDelta(signed), roughDelta(signed), _, _
#endif
#ifdef COD_LAYER
	uniform sampler2D uCodLayerMap;
	uniform sampler2D uCodLayerNormal;
	uniform sampler2D uCodLayerOrm;
	uniform vec4 uCodLayer;  // maskGain, globalAmount, cavityBias(0..1), contrast
	uniform vec4 uCodLayer2; // upFacingOnly, uvScale, roughMul, normalStrength
#endif
#ifdef COD_VCOL
	uniform vec4 uCodVCol;   // grimeGain, grimeTiling, poolGain, _
	uniform vec3 uCodGrimeColor;
#endif
#ifdef COD_WET
	uniform vec4 uCodWet;    // response, porosity, puddleLevel, puddleGain
	uniform vec2 uCodWet2;   // broad puddle mask tiling, contrast
#endif
#ifdef COD_DUST
	uniform vec4 uCodDustP;  // response, tiling, roughAdd, upPow
	uniform vec3 uCodDustColor;
#endif
#ifdef COD_SSS
	uniform vec4 uCodSss;    // strength, power, distortion, ambient
	uniform vec3 uCodSssColor;
#endif
#ifdef COD_SCREEN
	uniform vec4 uCodScreen; // nits, lineCount, lineDepth, flicker
	uniform vec3 uCodScreenTint;
#endif
#ifdef COD_GLASS
	uniform vec4 uCodGlass;  // baseAlpha, fresnelGain, dirtGain, dirtTiling
#endif
#ifdef COD_WATER
	uniform vec4 uCodWave;   // scaleA, scaleB, speedA, speedB
	uniform vec4 uCodWaveDir;
	uniform vec4 uCodWaterN; // strengthA, strengthB, rippleStrength, _
	uniform vec4 uCodWaterD; // depth(m), alphaGain, foamWidth, vcolDepthGain
	uniform vec3 uCodAbsorb;
	uniform vec3 uCodWaterColor;
	uniform vec3 uCodFoamColor;
#endif
#ifdef COD_REFLECT
	uniform sampler2D uCodReflect;
	uniform mat4 uCodReflectMtx;
	uniform vec4 uCodReflectP; // strength, distortion, _, _
#endif

${HELPERS}

#ifdef COD_POM
/**
 * Steep parallax with a linear interpolation step. tv is the tangent-space view
 * direction; the sample count scales with the grazing angle where the artefacts are.
 */
vec2 codParallax( sampler2D hmap, vec2 uv, vec3 tv, float scale, float layers, out float hOut ) {
	// Loop bound 24, not 40. Drivers unroll a constant-bound loop, so the bound sets the
	// compiled instruction count for every material that has POM — and on the software
	// rasteriser used for review builds, program compilation is the single biggest term
	// in boot time. Nothing above ultra (26 layers, clamped here) ever needed more.
	float n = clamp( mix( layers, max( 4.0, layers * 0.35 ), abs( tv.z ) ), 4.0, 24.0 );
	float stepH = 1.0 / n;
	vec2 delta = ( tv.xy / max( 0.25, tv.z ) ) * scale * stepH;
	float h = 1.0;
	vec2 cur = uv;
	float d = 1.0 - texture2D( hmap, cur ).x;
	for ( int i = 0; i < 24; i ++ ) {
		if ( float( i ) >= n || d < h ) break;
		h -= stepH;
		cur -= delta;
		d = 1.0 - texture2D( hmap, cur ).x;
	}
	vec2 prev = cur + delta;
	float after = d - h;
	float before = ( 1.0 - texture2D( hmap, prev ).x ) - h - stepH;
	float w = after / max( 1e-5, after - before );
	hOut = 1.0 - ( h + stepH * w );
	return mix( cur, prev, clamp( w, 0.0, 1.0 ) );
}

/** 4-tap horizon check towards the key light. Cheap, and it sells the depth. */
float codParallaxShadow( sampler2D hmap, vec2 uv, vec3 tl, float h0, float scale ) {
	if ( tl.z <= 0.02 ) return 1.0;
	vec2 delta = ( tl.xy / max( 0.25, tl.z ) ) * scale * 0.25;
	float occ = 0.0;
	for ( int i = 1; i <= 4; i ++ ) {
		float f = float( i );
		float hs = texture2D( hmap, uv + delta * f ).x;
		occ = max( occ, ( hs - ( h0 + 0.25 * f * ( 1.0 - h0 ) ) ) * ( 1.0 - f * 0.18 ) );
	}
	return codSat( 1.0 - occ * 3.2 );
}
#endif

#ifdef COD_SCREEN
/** A believable UI without a texture: bars, a grid, a caret and a slow sweep. */
vec3 codScreenContent( vec2 uv, float t ) {
	vec2 g = fract( uv * vec2( 46.0, 26.0 ) );
	float grid = ( 1.0 - smoothstep( 0.0, 0.09, min( g.x, g.y ) ) ) * 0.16;
	float rows = floor( uv.y * 13.0 );
	float seed = fract( sin( rows * 12.9898 ) * 43758.5453 );
	float barLen = 0.18 + seed * 0.62;
	float bar = step( 0.06, uv.x ) * step( uv.x, 0.06 + barLen );
	bar *= step( 0.28, fract( uv.y * 13.0 ) ) * step( fract( uv.y * 13.0 ), 0.72 );
	bar *= 0.35 + 0.65 * step( 0.35, fract( seed * 7.0 + t * 0.12 ) );
	float caret = step( 0.72, uv.x ) * step( uv.x, 0.76 ) * step( 0.86, uv.y ) * step( uv.y, 0.94 );
	caret *= step( 0.5, fract( t * 1.4 ) );
	float sweep = exp( -60.0 * abs( fract( uv.y * 0.5 - t * 0.09 ) - 0.5 ) ) * 0.5;
	return vec3( grid + bar * 0.9 + caret + sweep );
}
#endif
`;

/**
 * Replaces `#include <map_fragment>`. Everything downstream reads the locals this
 * block leaves behind: codUv, codWN, codVw, codDist, codAlb, codOrm, codNw, …
 */
// language=GLSL
export const FRAG_SURFACE = /* glsl */ `
/* ───────────────────────────── COD surface ───────────────────────────── */
vec3 codWN = normalize( vCodWNrm );
#ifdef DOUBLE_SIDED
	codWN *= ( gl_FrontFacing ? 1.0 : - 1.0 );
#endif
vec3  codVw = cameraPosition - vCodWPos;
float codDist = length( codVw );
codVw /= max( codDist, 1e-4 );
vec2  codUv = vCodUv;
mat3  codTBN = codTangentFrame( vCodWPos, codWN, codUv );
float codHeight = 0.5;
float codPomShadow = 1.0;
float codWetAmount = 0.0;
float codGrime = 0.0;
float codMacroN = 0.5;    // world-space low-frequency band, 0..1
float codStreak = 0.0;    // world-space vertical staining
float codGlassDirt = 0.0;

#ifdef COD_POM
{
	vec3 tv = vec3( dot( codVw, codTBN[0] ), dot( codVw, codTBN[1] ), dot( codVw, codTBN[2] ) );
	float fade = 1.0 - smoothstep( uCodPom.z * 0.45, uCodPom.z, codDist );
	if ( fade > 0.02 && tv.z > 0.04 ) {
		float hOut;
		codUv = codParallax( uCodHeightMap, codUv, tv, uCodPom.x * fade, uCodPom.y, hOut );
		#ifdef COD_POM_SHADOW
		{
			vec3 tl = vec3( dot( uCodSunDir, codTBN[0] ), dot( uCodSunDir, codTBN[1] ), dot( uCodSunDir, codTBN[2] ) );
			codPomShadow = mix( 1.0, codParallaxShadow( uCodHeightMap, codUv, tl, hOut, uCodPom.x * fade ), fade );
		}
		#endif
		#ifdef COD_POM_CLIP
			// Silhouette clipping: the ray left the height volume without ever hitting
			// the surface, so this fragment is genuinely see-through.
			if ( hOut < uCodPom.w ) discard;
		#endif
	}
}
#endif

/* ---- base fetch (triplanar or plain UV) ---- */
vec4 codAlb;
vec4 codOrm;
vec3 codNw;
#ifdef COD_TRIPLANAR
{
	vec3 tp = vCodWPos * uCodTri.x;
	vec3 bw = pow( abs( codWN ), vec3( uCodTri.y ) );
	bw /= max( 1e-4, bw.x + bw.y + bw.z );
	vec2 uvX = vec2( - tp.z * sign( codWN.x ), tp.y );
	vec2 uvY = vec2( tp.x, tp.z * sign( codWN.y ) );
	vec2 uvZ = vec2( tp.x * sign( codWN.z ), tp.y );
	codAlb = texture2D( map, uvX ) * bw.x + texture2D( map, uvY ) * bw.y + texture2D( map, uvZ ) * bw.z;
	codOrm = texture2D( roughnessMap, uvX ) * bw.x + texture2D( roughnessMap, uvY ) * bw.y + texture2D( roughnessMap, uvZ ) * bw.z;
	vec3 nX = texture2D( normalMap, uvX ).xyz * 2.0 - 1.0;
	vec3 nY = texture2D( normalMap, uvY ).xyz * 2.0 - 1.0;
	vec3 nZ = texture2D( normalMap, uvZ ).xyz * 2.0 - 1.0;
	nX.xy *= uCodNrmScale; nY.xy *= uCodNrmScale; nZ.xy *= uCodNrmScale;
	// whiteout blend — keeps detail on all three planes instead of washing it out
	nX = vec3( nX.xy + codWN.zy, abs( nX.z ) * codWN.x );
	nY = vec3( nY.xy + codWN.xz, abs( nY.z ) * codWN.y );
	nZ = vec3( nZ.xy + codWN.xy, abs( nZ.z ) * codWN.z );
	codNw = normalize( nX.zyx * bw.x + nY.xzy * bw.y + nZ.xyz * bw.z );
	codUv = uvY; // detail/grunge layers keep a stable parameterisation
}
#else
{
	codAlb = texture2D( map, codUv );
	codOrm = texture2D( roughnessMap, codUv );
	vec3 nTS = texture2D( normalMap, codUv ).xyz * 2.0 - 1.0;
	nTS.xy *= uCodNrmScale;
	codNw = normalize( codTBN * nTS );
}
#endif
/* ---- tiling break-up: second rotated sample, low-frequency mask ---- */
#ifdef COD_TILEBREAK
{
	// The fade used to be smoothstep(2.5, 14, dist): zero break-up under 2.5 m, full
	// only past 14 m. That is backwards. The grid is *most* countable where the camera
	// dwells — the paving under your feet, the wall you are stood against — and the
	// distance term was guaranteeing it was untouched exactly there. Break-up is now on
	// everywhere, tapering only slightly in the very near field where the surface's own
	// detail carries the frame and a rotated second sample would just soften it.
	float amt = uCodBreak.y * mix( uCodBreak.z, 1.0, smoothstep( 0.8, uCodBreak.w, codDist ) );
	if ( amt > 0.01 ) {
		vec2 muv = vCodUv * uCodBreak.x;
		vec4 mk = texture2D( uCodGrunge, muv );
		float ang = ( mk.g - 0.5 ) * 2.6;
		float ca = cos( ang ), sa = sin( ang );
		mat2 R = mat2( ca, - sa, sa, ca );
		vec2 uv2 = R * ( codUv * 0.83 ) + vec2( mk.g * 5.13, mk.a * 3.77 );
		float w = smoothstep( 0.38, 0.62, mk.b * 0.55 + mk.g * 0.45 ) * amt;
		codAlb = mix( codAlb, texture2D( map, uv2 ), w );
		codOrm = mix( codOrm, texture2D( roughnessMap, uv2 ), w );
		vec3 n2 = texture2D( normalMap, uv2 ).xyz * 2.0 - 1.0;
		n2.xy = codRot( n2.xy * uCodNrmScale, ca, sa );
		#ifdef COD_TRIPLANAR
			codNw = normalize( mix( codNw, normalize( codTBN * n2 ), w * 0.6 ) );
		#else
			codNw = normalize( mix( codNw, normalize( codTBN * n2 ), w ) );
		#endif
	}
}
#endif

// The forge packs the full-resolution height field in albedo.a, so this is free and it
// is already sampled at the parallax-corrected, break-up-blended UV.
codHeight = codAlb.a;

/* ---- per-cell identity: every brick, flag, tile and plank is its own object ---- */
#ifdef COD_CELLVAR
{
	// Rotating a second copy of the whole map under a blotch mask (COD_TILEBREAK) is
	// stochastic tiling — the right tool for asphalt and dirt, the wrong one for
	// masonry: it shears the courses and muddies the bond without ever making two
	// bricks different from each other. A laid surface needs the opposite treatment,
	// per *unit*: the lattice is rebuilt here in the same tile space the recipe
	// authored it in, but vCodUv runs across the whole wall, so floor() gives a
	// globally unique id and the jitter never repeats with the texture.
	vec2 C = max( vec2( 1.0 ), floor( uCodCell.xy + 0.5 ) );
	float crow = floor( vCodUv.y * C.y );
	vec2 cp = vec2( vCodUv.x * C.x + uCodCell.z * crow, vCodUv.y * C.y );
	vec2 cid = floor( cp );
	vec2 cf = cp - cid;
	// The joint must not take the jitter with it or the mortar stripes course by course.
	vec2 cd = min( cf, 1.0 - cf );
	float cface = min( smoothstep( uCodCell2.x * 0.55, uCodCell2.x * 1.8, cd.x ),
	                   smoothstep( uCodCell2.y * 0.55, uCodCell2.y * 1.8, cd.y ) );
	vec3 crnd = codHash3( cid + vec2( 0.5, 0.5 ) );
	float ca = uCodCell.w * cface;
	// Value, hue and finish move independently: a pallet of flags or a kiln load of
	// bricks varies in all three and never in lockstep.
	codAlb.rgb *= 1.0 + ( crnd.x - 0.5 ) * 0.58 * ca;
	codAlb.rgb *= mix( vec3( 1.0 ),
	                   vec3( 1.0 + ( crnd.y - 0.5 ) * 0.30,
	                         1.0 + ( crnd.z - 0.5 ) * 0.09,
	                         1.0 - ( crnd.y - 0.5 ) * 0.27 ), uCodCell2.z * ca );
	codOrm.g = codSat( codOrm.g + ( crnd.z - 0.5 ) * uCodCell2.w * ca );
	// A unit that sits a little proud catches more light on top and more dirt below.
	codOrm.r = codSat( codOrm.r * ( 1.0 - ( crnd.x - 0.5 ) * 0.14 * ca ) );
}
#endif

/* ---- world-space macro variation, staining and convex edge wear ---- */
#ifdef COD_MACRO
{
	// Sampled from WORLD POSITION, never from the tile UV, so nothing here can line up
	// with a texture repeat. uCodGrunge packs r = fine dirt, g = large blotches,
	// b = cell net, a = downward streaks.
	//
	// TWO bands now, and the response belongs to the material. One 80 m fetch driving
	// a +/-30% albedo multiply on everything made the awning, the render behind it and
	// the timber all wear the same swirled topographic marble; the fix is not to delete
	// it (a long wall does drift) but to halve the amplitude, put a metre-scale band
	// under it, and let each family say what its drift IS — batch mismatch for
	// concrete, sun bleach for canvas, dulling for metal.
	vec4 mA = texture2D( uCodGrunge, vCodWPos.xz * 0.0125 + vCodWPos.y * 0.0031 );
	vec4 mB = texture2D( uCodGrunge, ( vCodWPos.xz + vCodWPos.y * 0.41 ) * uCodMacro2.x + 0.37 );
	codMacroN = codSat( mA.g * 0.62 + mA.r * 0.38 );
	float broad = codMacroN - 0.5;
	float local = ( mB.g * 0.45 + mB.r * 0.55 ) - 0.5;
	float macro = broad * 0.60 + local * 0.40;
	float amt = uCodMacro.x;
	codAlb.rgb *= 1.0 + macro * uCodMacro2.y * amt;
	// Batch-to-batch colour. Render, concrete and brick arrive in loads that never
	// quite match, and that mismatch is most of what makes a long wall read as built.
	codAlb.rgb = mix( codAlb.rgb, codAlb.rgb * uCodMacroTint,
	                  codSat( ( broad * 1.5 + local * 0.8 ) + 0.18 ) * uCodMacro2.z * amt );
	codOrm.g = codSat( codOrm.g + macro * uCodMacro2.w * amt );

	// Vertical staining, placed in world space. runoff() in the generation pass is in
	// tile UV, so every 3 m the identical streak restarted from nothing; here the
	// source band is horizontal world position and the smear runs down the building,
	// which is at least the right *kind* of wrong until decals place it from geometry.
	float face = codSat( 1.0 - abs( codWN.y ) * 1.8 );
	if ( uCodMacro.w > 0.01 && face > 0.02 ) {
		vec4 mS = texture2D( uCodGrunge, vec2( ( vCodWPos.x * 0.86 + vCodWPos.z * 0.51 ) * 0.055, vCodWPos.y * 0.011 ) );
		codStreak = codSat( mS.a * 1.4 + mS.r * 0.3 - 0.44 ) * face * uCodMacro.w;
		codAlb.rgb *= mix( vec3( 1.0 ), vec3( 0.66, 0.645, 0.60 ), codStreak * 0.75 );
		codOrm.g = codSat( codOrm.g + codStreak * 0.16 );
	}

	// Convex wear — the inverse of the cavity term that already drives grime. Two
	// things were wrong with it. It fired on the top third of the height field, which
	// on a crate is most of the face, and it made every worn texel BOTH brighter AND
	// smoother, which no real wear mechanism does: handled timber and paint go darker
	// and polished, abraded masonry goes paler and coarser, rubbed steel goes brighter
	// and polished. The direction is now a per-recipe signed pair. The trigger is also
	// tightened to proud AND open texels and cut by a world-space band, so two crates
	// side by side no longer carry a byte-identical outline.
	float open = smoothstep( 0.28, 0.78, codOrm.r );
	float convex = smoothstep( 0.74, 0.98, codHeight ) * open;
	float band = 0.30 + 1.25 * codSat( texture2D( uCodGrunge, vCodWPos.xy * 0.29 + vCodWPos.zx * 0.17 ).r );
	float wear = codSat( convex * band ) * uCodMacro.y * ( 1.0 - codStreak * 0.6 );
	codAlb.rgb *= 1.0 + uCodWear.x * wear;
	codOrm.g = codSat( codOrm.g + uCodWear.y * wear );
	codOrm.b = codSat( codOrm.b + wear * uCodMacro.z );
	codOrm.r = codSat( codOrm.r + wear * 0.10 );
}
#endif

/* ---- second material driven by vertex colour (snow / mud / paint) ---- */
#ifdef COD_VCOL
	vec3 codMask = codSat3( vColor.rgb );
#else
	vec3 codMask = vec3( 0.0 );
#endif

#ifdef COD_LAYER
{
	// Drifts pile up somewhere in particular. Without a world-scale mask a global
	// layerAmount is a uniform film over the whole map, which is worse than no layer.
	// lw is a COVERAGE TARGET in 0..1, not a weight: 0.3 means "about thirty percent
	// of this patch is silt". The old line then did w = sat(lw*(1+k) - bias*k), which
	// with k≈1.8 and bias≈0.5 only went positive for lw > 0.32 — i.e. for a global
	// amount of 0.2..0.32 the layer existed in a couple of percent of the deepest
	// cavities of the top few percent of the macro band, and the ground was one
	// material from kerb to horizon. The standard height blend below puts the 50%
	// crossover exactly at bias == lw, so the coverage on screen is the number asked
	// for, and contrast sets how hard the transition is instead of gating it away.
	float lw = codSat( codMask.g * uCodLayer.x + uCodLayer.y * ( 0.30 + 1.45 * codMacroN ) );
	if ( lw > 0.002 ) {
		// Height-aware: cavityBias 1 fills crevices first (mud, water), 0 covers
		// the peaks first (snow blowing onto a ledge).
		float bias = mix( 1.0 - codHeight, codHeight, uCodLayer.z );
		float soft = clamp( 1.0 / max( 0.35, uCodLayer.w ), 0.06, 1.2 );
		float w = codSat( ( lw - bias ) / soft + 0.5 );
		w = smoothstep( 0.0, 1.0, w );
		w *= mix( 1.0, codSat( codWN.y * 1.5 + 0.1 ), uCodLayer2.x );
		if ( w > 0.002 ) {
			vec2 luv = codUv * uCodLayer2.y;
			codAlb.rgb = mix( codAlb.rgb, texture2D( uCodLayerMap, luv ).rgb, w );
			vec4 lorm = texture2D( uCodLayerOrm, luv );
			codOrm.r = mix( codOrm.r, lorm.r, w );
			codOrm.g = mix( codOrm.g, lorm.g * uCodLayer2.z, w );
			codOrm.b = mix( codOrm.b, lorm.b, w );
			vec3 ln = texture2D( uCodLayerNormal, luv ).xyz * 2.0 - 1.0;
			ln.xy *= uCodLayer2.w;
			codNw = normalize( mix( codNw, normalize( codTBN * ln ), w ) );
		}
	}
}
#endif

/* ---- detail normal + detail albedo, faded by distance ---- */
#ifdef COD_DETAIL
{
	float f = 1.0 - smoothstep( uCodDetail.w * 0.3, uCodDetail.w, codDist );
	if ( f > 0.01 ) {
		vec2 duv = codUv * uCodDetail.x;
		vec3 dn = texture2D( uCodDetailNormal, duv ).xyz * 2.0 - 1.0;
		codNw = normalize( codNw + ( codTBN[0] * dn.x + codTBN[1] * dn.y ) * uCodDetail.y * f );
		float g = texture2D( uCodGrunge, duv * 0.37 ).r;
		codAlb.rgb *= mix( 1.0, 0.80 + 0.42 * g, uCodDetail.z * f );
		codOrm.g = codSat( codOrm.g + ( g - 0.5 ) * 0.16 * uCodDetail.z * f );
	}
}
#endif

/* ---- painted-on grime from the vertex red channel ---- */
#ifdef COD_VCOL
{
	float grime = codMask.r * uCodVCol.x;
	if ( grime > 0.002 ) {
		vec4 gr = texture2D( uCodGrunge, vCodUv * uCodVCol.y );
		float gm = codSat( grime * ( 0.35 + 1.1 * gr.g + 0.55 * gr.a ) );
		codAlb.rgb = mix( codAlb.rgb, codAlb.rgb * uCodGrimeColor, gm );
		codOrm.g = mix( codOrm.g, 0.93, gm * 0.85 );
		codOrm.r *= mix( 1.0, 0.75, gm );
		codGrime = gm;
	}
}
#endif

/* ---- dust settling on up-facing surfaces ---- */
#ifdef COD_DUST
{
	float up = codSat( codWN.y );
	float d = uCodDust * uCodDustP.x * pow( up, uCodDustP.w );
	// Dust sits on the micro-facets that point up, so bias it by the normal map too.
	d *= codSat( 0.35 + 0.65 * codSat( codNw.y ) );
	d *= 0.45 + 0.55 * texture2D( uCodGrunge, codUv * uCodDustP.y ).b;
	d = codSat( d ) * ( 1.0 - codGrime * 0.6 );
	codAlb.rgb = mix( codAlb.rgb, uCodDustColor, d * 0.55 );
	codOrm.g = codSat( codOrm.g + d * uCodDustP.z );
	codNw = normalize( mix( codNw, codWN, d * 0.25 ) );
}
#endif

/* ---- wetness ---- */
#ifdef COD_WET
{
	float wet = codSat( uCodWetness * uCodWet.x );
	if ( wet > 0.002 ) {
		float up = codSat( codWN.y * 1.7 - 0.55 );
		// Micro term: the height field decides which cracks hold water. Broad term: a
		// low-frequency mask so puddles gather in a few places instead of a uniform
		// film picking out every crack in the map.
		float pool = up * smoothstep( uCodWet.z + 0.12, uCodWet.z - 0.04, codHeight );
		float broad = texture2D( uCodGrunge, vCodUv * uCodWet2.x ).g;
		pool *= mix( 1.0, smoothstep( 0.40, 0.66, broad ), uCodWet2.y );
		#ifdef COD_VCOL
			pool = codSat( pool + codMask.b * uCodVCol.z );
		#endif
		float puddle = codSat( pool * wet * uCodWet.w );
		// A wet porous surface goes dark because the water fills the pores.
		codAlb.rgb *= mix( 1.0, mix( 1.0, 0.40, uCodWet.y ), wet );
		codAlb.rgb *= mix( 1.0, 0.62, puddle );
		codOrm.g = mix( codOrm.g, 0.16, wet * 0.72 );
		codOrm.g = mix( codOrm.g, 0.035, puddle );
		codOrm.r = mix( codOrm.r, min( 1.0, codOrm.r + 0.25 ), puddle );
		codNw = normalize( mix( codNw, codWN, puddle * 0.93 ) );
		codWetAmount = max( wet * 0.4, puddle );
	}
}
#endif

/* ---- glass: pane-to-pane variation and a real dirt gradient ---- */
#ifdef COD_GLASS
{
	// Computed here rather than at the alpha tail so it can drive roughness and the
	// specular response too — a dirty pane is not just a more opaque clean pane.
	// Per-pane hash: a real facade has a different film on every sheet, and identical
	// glazing across forty windows is one of the loudest "generated" tells there is.
	vec3 pcell = vCodWPos * vec3( 0.75, 0.55, 0.75 );
	vec3 pc = floor( pcell );
	vec3 pl = pcell - pc;
	float pane = fract( sin( dot( pc, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
	vec4 gr = texture2D( uCodGrunge, vCodUv * uCodGlass.w + pane * 7.13 );
	// Muck is not a uniform film over the sheet — that is exactly what turns a window
	// into an opaque card. It collects in the frame rebate and washes down from the
	// top, and the middle of the pane stays close to clear so the fresnel gradient and
	// whatever is behind the glass both survive.
	float rebate = codSat( 1.0 - min( min( pl.x, 1.0 - pl.x ), min( pl.y, 1.0 - pl.y ) ) * 5.5 );
	float down = codSat( 0.55 - pl.y ) * 1.6;
	float film = ( gr.r * 0.45 + gr.g * 0.55 ) * ( 0.16 + 0.55 * down + 0.85 * rebate );
	codGlassDirt = codSat( film * uCodGlass.z * ( 0.55 + 0.9 * pane ) );
	codAlb.rgb = mix( codAlb.rgb, codAlb.rgb * 0.55 + vec3( 0.15, 0.146, 0.136 ), codGlassDirt * 0.9 );
	// Clean glass is optically smooth; the film is what scatters. Driving roughness
	// from the dirt is what lets the clean part of the pane behave like a mirror.
	codOrm.g = codSat( mix( codOrm.g * 0.30, 0.78, codGlassDirt ) );
}
#endif

diffuseColor.rgb *= codAlb.rgb;
#ifdef COD_ALPHA_FROM_MAP
	diffuseColor.a *= codAlb.a;
#endif

float codAO = codOrm.r * codPomShadow;
`;

/** Replaces `#include <map_fragment>` for water. */
// language=GLSL
export const FRAG_WATER = /* glsl */ `
/* ───────────────────────────── COD water ─────────────────────────────── */
vec3 codWN = normalize( vCodWNrm );
#ifdef DOUBLE_SIDED
	codWN *= ( gl_FrontFacing ? 1.0 : - 1.0 );
#endif
vec3  codVw = cameraPosition - vCodWPos;
float codDist = length( codVw );
codVw /= max( codDist, 1e-4 );
vec2  codUv = vCodUv;
mat3  codTBN = codTangentFrame( vCodWPos, codWN, codUv );
float codAO = 1.0;
float codPomShadow = 1.0;
float codWetAmount = 1.0;

// Two scrolling wave layers at different scales and directions — the classic trick,
// and still the cheapest way to get water that does not look like a mirror.
vec2 w1 = codUv * uCodWave.x + normalize( uCodWaveDir.xy ) * uCodTime * uCodWave.z;
vec2 w2 = codUv * uCodWave.y - normalize( uCodWaveDir.zw ) * uCodTime * uCodWave.w;
vec4 s1 = texture2D( uCodDetailNormal, w1 );
vec4 s2 = texture2D( uCodDetailNormal, w2 );
vec3 n1 = s1.xyz * 2.0 - 1.0;
vec3 n2 = s2.xyz * 2.0 - 1.0;
vec3 nTS = normalize( vec3( n1.xy * uCodWaterN.x + n2.xy * uCodWaterN.y, 1.0 ) );

// Rain ripples: concentric micro-normals that only appear when it is actually wet.
if ( uCodWaterN.z > 0.001 && uCodWetness > 0.01 ) {
	vec2 ruv = codUv * 9.0;
	float rp = fract( uCodTime * 1.6 );
	vec4 rs = texture2D( uCodGrunge, ruv * 0.5 );
	float ring = sin( ( rs.r * 12.0 + length( fract( ruv ) - 0.5 ) * 22.0 - rp * 12.0 ) );
	ring *= exp( -3.0 * rp ) * step( 0.55, rs.b );
	nTS.xy += ring * uCodWaterN.z * uCodWetness * 0.35;
	nTS = normalize( nTS );
}
vec3 codNw = normalize( codTBN * nTS );

float ndv = codSat( dot( codNw, codVw ) );

// Beer-Lambert through the water column. Depth comes from the uniform, scaled by the
// vertex red channel if the level author painted one, and lengthened at grazing angles.
float depth = uCodWaterD.x;
#ifdef COD_VCOL
	depth *= mix( 1.0, codSat( vColor.r ), uCodWaterD.w );
#endif
float path = depth / max( 0.16, ndv );
vec3 trans = exp( - uCodAbsorb * path );
vec3 body = uCodWaterColor * ( 1.0 - trans );

float fres = 0.02 + 0.98 * pow( 1.0 - ndv, 5.0 );
float alpha = codSat( max( 1.0 - dot( trans, vec3( 0.3333 ) ), fres ) * uCodWaterD.y );

// Shoreline + crest foam: s1.a / s2.a are the detail map own height field.
float crest = codSat( ( s1.a * 0.6 + s2.a * 0.4 ) * 1.6 - 0.72 );
float shore = 0.0;
#ifdef COD_VCOL
	shore = codSat( 1.0 - codSat( vColor.r ) / max( 0.02, uCodWaterD.z ) );
#endif
float foam = codSat( max( shore, crest ) * ( 0.7 + 0.3 * sin( uCodTime * 1.7 + codUv.x * 9.0 ) ) );
foam *= codSat( 0.35 + 0.65 * texture2D( uCodGrunge, codUv * 6.0 ).r * 2.0 );

vec4 codAlb = vec4( mix( body, uCodFoamColor, foam ), 1.0 );
vec4 codOrm = vec4( 1.0, mix( 0.035, 0.62, foam ), 0.0, 1.0 );
codNw = normalize( mix( codNw, codWN, foam * 0.5 ) );
alpha = max( alpha, foam * 0.9 );

diffuseColor.rgb *= codAlb.rgb;
diffuseColor.a = alpha;
float codHeight = 0.5;
vec3 codMask = vec3( 0.0 );
float codGrime = 0.0;
float codMacroN = 0.5;
float codStreak = 0.0;
float codGlassDirt = 0.0;
float codFresnel = fres;
`;

/** Vertex colour is a mask here, not a tint — replaces `#include <color_fragment>`. */
export const FRAG_COLOR_NOOP = '/* COD: vColor is a mask, see FRAG_SURFACE */';

// language=GLSL
export const FRAG_ROUGHNESS = /* glsl */ `
float roughnessFactor = clamp( mix( uCodRough.x, uCodRough.y, codOrm.g ), 0.015, 1.0 );
{
	// Specular anti-aliasing (Kaplanyan/Tokuyoshi, screen-space form). A smooth,
	// high-frequency normal field under-samples its own NDF and the leftovers arrive as
	// hard white sparkle that crawls when the camera moves — the picatinny rail on the
	// viewmodel being the loudest example in the set. Widening the lobe by the
	// screen-space variance of the shading normal is the standard fix and it costs two
	// derivatives.
	vec3 dnx = dFdx( codNw );
	vec3 dny = dFdy( codNw );
	float var2 = dot( dnx, dnx ) + dot( dny, dny );
	float a = roughnessFactor * roughnessFactor;
	roughnessFactor = clamp( sqrt( min( a + 0.45 * var2, 1.0 ) ), 0.015, 1.0 );
}
`;

// language=GLSL
export const FRAG_METALNESS = /* glsl */ `
float metalnessFactor = clamp( mix( uCodMetal.x, uCodMetal.y, codOrm.b ), 0.0, 1.0 );
`;

// language=GLSL
export const FRAG_NORMAL = /* glsl */ `
normal = normalize( ( viewMatrix * vec4( codNw, 0.0 ) ).xyz );
`;

/** Appended after `#include <lights_physical_fragment>`. */
// language=GLSL
export const FRAG_PHYSICAL_TAIL = /* glsl */ `
#ifdef COD_WET
	// A water film raises F0 towards water's 0.02..0.05 and, more importantly, makes
	// the specular lobe tight. Both are what actually reads as "wet".
	material.roughness = max( 0.0325, mix( material.roughness, min( material.roughness, 0.09 ), codWetAmount ) );
	material.specularColor = min( material.specularColor * mix( 1.0, 2.1, codWetAmount ), vec3( 1.0 ) );
	material.specularF90 = mix( material.specularF90, 1.0, codWetAmount );
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );
#endif
#ifdef COD_WATER
	material.roughness = max( 0.0325, roughnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef COD_GLASS
	// F90 = 1 so the grazing-angle reflection reaches full strength. The pane's alpha
	// is fresnel-driven (see FRAG_ALPHA_TAIL), and because the blend multiplies the
	// whole outgoing radiance by alpha, that is also what lets the reflection grow
	// towards the edge of the sheet instead of sitting at one painted-on brightness.
	material.specularF90 = 1.0;
#endif
`;

/** Appended after `#include <lights_fragment_end>` — translucency / SSS. */
// language=GLSL
export const FRAG_SSS = /* glsl */ `
#ifdef COD_SSS
{
	// Cheap forward-scatter wrap: light that went *through* the surface and came out
	// the other side. Not path tracing, but it is the difference between a leaf and
	// a piece of green cardboard.
	vec3 L = normalize( uCodSunDir );
	vec3 H = normalize( - L + codWN * uCodSss.z );
	float back = pow( codSat( dot( codVw, - H ) ), max( 0.25, uCodSss.y ) );
	float thin = mix( 0.55, 1.0, codSat( codAO ) );
	vec3 tr = uCodSssColor * ( back * uCodSss.x + uCodSss.w ) * thin;
	reflectedLight.directDiffuse += material.diffuseColor * tr * uCodSunColor;
}
#endif
#ifdef COD_REFLECT
{
	vec4 rp = uCodReflectMtx * vec4( vCodWPos, 1.0 );
	vec2 ruv = ( rp.xy / max( 1e-4, abs( rp.w ) ) ) * 0.5 + 0.5;
	ruv += codNw.xz * uCodReflectP.y;
	if ( ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0 ) {
		float f = 0.03 + 0.97 * pow( 1.0 - codSat( dot( codNw, codVw ) ), 5.0 );
		reflectedLight.indirectSpecular += texture2D( uCodReflect, ruv ).rgb * f * uCodReflectP.x;
	}
}
#endif
`;

/** Replaces `#include <aomap_fragment>`. */
// language=GLSL
export const FRAG_AO = /* glsl */ `
{
	#ifdef USE_AOMAP
		float ambientOcclusion = ( codAO - 1.0 ) * aoMapIntensity + 1.0;
	#else
		float ambientOcclusion = codAO;
	#endif
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT )
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN )
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
	// A little AO on direct light too. Physically wrong, universally shipped: it is
	// what stops every mesh-to-mesh junction from looking like it is floating.
	float ao2 = mix( 1.0, ambientOcclusion, uCodAoDirect );
	reflectedLight.directDiffuse *= ao2;
	reflectedLight.directSpecular *= mix( 1.0, ambientOcclusion, uCodAoDirect * 0.5 );
}
`;

/** Replaces `#include <emissivemap_fragment>`. */
// language=GLSL
export const FRAG_EMISSIVE = /* glsl */ `
#ifdef USE_EMISSIVEMAP
	totalEmissiveRadiance *= texture2D( emissiveMap, codUv ).rgb;
#endif
#ifdef COD_SCREEN
{
	// Mains flicker: barely perceptible, but a perfectly steady light source is one of
	// the things that reads instantly as "not a real place".
	float flick = 1.0 + uCodScreen.w * ( sin( uCodTime * 41.3 ) * 0.5 + sin( uCodTime * 13.7 + 1.1 ) * 0.5 );
	// Dirt on the diffuser dims the panel unevenly.
	totalEmissiveRadiance *= flick * ( 0.80 + 0.36 * texture2D( uCodGrunge, vCodUv * 0.7 ).g );
	if ( uCodScreen.x > 0.0 ) {
		vec3 content = codScreenContent( vCodUv, uCodTime );
		float sl = 0.5 + 0.5 * cos( vCodUv.y * uCodScreen.y * 6.2831853 );
		totalEmissiveRadiance += content * uCodScreenTint * uCodScreen.x * mix( 1.0, sl, uCodScreen.z ) * flick;
	}
}
#endif
`;

/** Inserted before `#include <opaque_fragment>`. */
// language=GLSL
export const FRAG_ALPHA_TAIL = /* glsl */ `
#ifdef COD_GLASS
{
	// Fresnel: near-transparent head-on, near-opaque at grazing. That transition IS
	// glass — a pane with a constant alpha reads as a sheet of dark plastic.
	// The dirt term used to add up to 0.65 of flat opacity on its own, which swamped
	// the fresnel ramp and left every pane a matte cream card. It contributes a third
	// of that now, so the gradient from near-clear head-on to near-mirror at grazing
	// is what you actually see.
	float f = pow( 1.0 - codSat( dot( codNw, codVw ) ), 5.0 );
	diffuseColor.a = codSat( uCodGlass.x + f * uCodGlass.y + codGlassDirt * 0.30 );
}
#endif
`;

/* ========================================================================== */
/*                              JS: the extender                              */
/* ========================================================================== */

const CHUNK = (name) => `#include <${name}>`;

/** Replace the first occurrence of a chunk include; warn (once) if it moved. */
function swap(src, chunk, replacement, warn) {
  const needle = CHUNK(chunk);
  if (!src.includes(needle)) {
    warn?.(chunk);
    return src;
  }
  return src.replace(needle, () => replacement);
}

/**
 * Wire the extension into one material. Call exactly **once** per material, at
 * construction time — Lighting.js and Sky.js wrap `onBeforeCompile` later and would
 * lose their patch if we reassigned it afterwards. Everything that changes at runtime
 * goes through `defines` (recompile) or `uniforms` (free).
 *
 * @param {THREE.Material} material
 * @param {object} cfg
 * @param {'surface'|'water'} [cfg.mode]
 * @param {Record<string,any>} cfg.uniforms  merged global + per-material uniform bag
 * @param {(chunk:string)=>void} [cfg.onMissingChunk]
 * @returns {THREE.Material}
 */
export function extendMaterial(material, cfg = {}) {
  if (!material || material.userData?.codExtended) return material;
  const mode = cfg.mode === 'water' ? 'water' : 'surface';
  const uniforms = cfg.uniforms || {};
  const warn = cfg.onMissingChunk;

  const prevOBC = typeof material.onBeforeCompile === 'function' ? material.onBeforeCompile : null;

  material.onBeforeCompile = function (shader, renderer) {
    if (prevOBC) {
      try {
        prevOBC.call(this, shader, renderer);
      } catch {
        /* another patch failed; ours still has to land */
      }
    }
    try {
      Object.assign(shader.uniforms, uniforms);

      /* ---- vertex ---- */
      let vert = shader.vertexShader;
      vert = vert.replace('void main() {', `${VERT_PARS}\nvoid main() {`);
      vert = swap(vert, 'project_vertex', VERT_BODY, warn);
      shader.vertexShader = vert;

      /* ---- fragment ---- */
      let frag = shader.fragmentShader;
      const anchor = 'void main() {';
      if (frag.includes(anchor)) {
        frag = frag.replace(anchor, `${GLOBAL_PARS}\n${FRAG_PARS}\nvoid main() {`);
      } else {
        frag = `${GLOBAL_PARS}\n${FRAG_PARS}\n${frag}`;
      }
      frag = swap(frag, 'map_fragment', mode === 'water' ? FRAG_WATER : FRAG_SURFACE, warn);
      frag = swap(frag, 'color_fragment', FRAG_COLOR_NOOP, warn);
      frag = swap(frag, 'roughnessmap_fragment', FRAG_ROUGHNESS, warn);
      frag = swap(frag, 'metalnessmap_fragment', FRAG_METALNESS, warn);
      frag = swap(frag, 'normal_fragment_maps', FRAG_NORMAL, warn);
      frag = swap(frag, 'emissivemap_fragment', FRAG_EMISSIVE, warn);
      frag = swap(frag, 'aomap_fragment', FRAG_AO, warn);
      frag = frag.replace(
        CHUNK('lights_physical_fragment'),
        () => `${CHUNK('lights_physical_fragment')}\n${FRAG_PHYSICAL_TAIL}`
      );
      frag = frag.replace(
        CHUNK('lights_fragment_end'),
        () => `${CHUNK('lights_fragment_end')}\n${FRAG_SSS}`
      );
      frag = frag.replace(CHUNK('opaque_fragment'), () => `${FRAG_ALPHA_TAIL}\n${CHUNK('opaque_fragment')}`);
      shader.fragmentShader = frag;
    } catch (err) {
      console.warn('[materials] shader injection failed, falling back to stock three', err);
    }
  };

  const prevKey =
    material.customProgramCacheKey && material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey
      ? material.customProgramCacheKey
      : null;
  material.customProgramCacheKey = function () {
    const base = prevKey ? prevKey.call(this) : '';
    return `${base}|codExt:${EXT_VERSION}:${mode}`;
  };

  material.userData = material.userData || {};
  material.userData.codExtended = true;
  // Non-enumerable: `Material.copy()` runs userData through JSON, which would choke on
  // the texture graph inside these uniforms. A `.clone()` simply loses the extension
  // and renders as stock three instead of throwing.
  Object.defineProperty(material.userData, 'codUniforms', {
    value: uniforms,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  material.needsUpdate = true;
  return material;
}

/**
 * Wind-only injection for the depth/distance material a wind-animated mesh casts its
 * shadow with. Without this the leaves sway and their shadows do not, which is worse
 * than no sway at all. The depth shader has no `objectNormal` outside
 * USE_DISPLACEMENTMAP, so this is a strict subset of VERT_BODY.
 */
export function extendDepthMaterial(material, cfg = {}) {
  if (!material || material.userData?.codExtended) return material;
  const uniforms = cfg.uniforms || {};
  const prevOBC = typeof material.onBeforeCompile === 'function' ? material.onBeforeCompile : null;

  material.onBeforeCompile = function (shader, renderer) {
    if (prevOBC) {
      try {
        prevOBC.call(this, shader, renderer);
      } catch {
        /* keep going */
      }
    }
    try {
      Object.assign(shader.uniforms, uniforms);
      let vert = shader.vertexShader;
      vert = vert.replace(
        'void main() {',
        `uniform vec4 uCodWindP;\nuniform float uCodTime;\nuniform vec4 uCodWind;\nvoid main() {`
      );
      vert = swap(vert, 'project_vertex', WIND_ONLY_BODY, cfg.onMissingChunk);
      shader.vertexShader = vert;
    } catch (err) {
      console.warn('[materials] depth wind injection failed', err);
    }
  };

  const prevKey =
    material.customProgramCacheKey && material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey
      ? material.customProgramCacheKey
      : null;
  material.customProgramCacheKey = function () {
    return `${prevKey ? prevKey.call(this) : ''}|codWindDepth:${EXT_VERSION}`;
  };
  material.userData = material.userData || {};
  material.userData.codExtended = true;
  material.needsUpdate = true;
  return material;
}

// language=GLSL
const WIND_ONLY_BODY = /* glsl */ `
{
	vec4 codBase = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		codBase = batchingMatrix * codBase;
	#endif
	#ifdef USE_INSTANCING
		codBase = instanceMatrix * codBase;
	#endif
	codBase = modelMatrix * codBase;
	float codFlex = clamp( transformed.y / max( 0.05, uCodWindP.w ), 0.0, 1.0 );
	codFlex = pow( codFlex, mix( 2.2, 1.1, clamp( uCodWindP.x, 0.0, 1.0 ) ) );
	float codW = uCodWind.z * ( 1.0 + uCodWind.w );
	vec2 codDir = normalize( uCodWind.xy + vec2( 1e-4, 0.0 ) );
	float codPh = dot( codBase.xz, vec2( 0.43, 0.31 ) ) + uCodTime * uCodWindP.z;
	float codBend = sin( codPh ) * 0.62 + sin( codPh * 2.37 + 1.7 ) * 0.26 + sin( codPh * 5.1 + 0.4 ) * 0.12;
	float codAmp = uCodWindP.y * codW * codFlex;
	vec3 codOff = vec3( codDir.x, 0.0, codDir.y ) * codBend * codAmp;
	codOff.y -= abs( codBend ) * codAmp * 0.28;
	transformed += vec3( dot( codOff, vec3( modelMatrix[0].xyz ) ),
	                     dot( codOff, vec3( modelMatrix[1].xyz ) ),
	                     dot( codOff, vec3( modelMatrix[2].xyz ) ) );
}

#include <project_vertex>
`;

export default { createGlobals, extendMaterial, extendDepthMaterial, EXT_VERSION };
