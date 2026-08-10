/**
 * sky.js — every GLSL string the sky/atmosphere system uses.
 * Owner: sky agent. Files owned: src/render/Sky.js + src/render/shaders/**.
 *
 * Nothing here touches the WebGL API; these are pure template literals consumed by
 * src/render/Sky.js. Kept in one module so the shading model (units, constants,
 * parameterisations) is defined exactly once and shared by the LUT passes, the cloud
 * raymarch, the sky dome and the aerial-perspective chunk other modules inject.
 *
 * Model
 * -----
 * Atmospheric scattering follows Hillaire 2020 ("A Scalable and Production Ready Sky
 * and Atmosphere Rendering Technique"): a transmittance LUT, a multiple-scattering
 * LUT and a sky-view LUT, with Rayleigh + Mie + **ozone absorption**. Ozone is what
 * keeps the twilight zenith deep blue instead of muddy grey — without it the blue
 * hour reads as "someone lerped to navy".
 *
 * Distances inside the atmosphere shaders are in **megametres** (1 Mm = 1000 km) so
 * float32 keeps its precision; cloud and aerial code works in **metres**.
 *
 * NOTE ON GLSL VERSION: three always compiles ShaderMaterial as `#version 300 es`
 * with `#define texture2D texture`, so `sampler3D` + `texture()` are available even
 * though the source is written in the GLSL1 dialect three expects.
 */

/* ══════════════════════════════════════════════════════════════ shared helpers ══ */

// language=GLSL
export const SKY_MATH = /* glsl */ `
#ifndef SKY_PI
#define SKY_PI 3.141592653589793
#endif

float sat1( float x ) { return clamp( x, 0.0, 1.0 ); }
vec3  sat3( vec3 x )  { return clamp( x, 0.0, 1.0 ); }
float safeacos( float x ) { return acos( clamp( x, -1.0, 1.0 ) ); }

float remap01( float v, float lo, float hi ) { return sat1( ( v - lo ) / max( hi - lo, 1e-5 ) ); }
float remapv( float v, float il, float ih, float ol, float oh ) {
  return ol + ( v - il ) * ( oh - ol ) / max( ih - il, 1e-5 );
}

float hgPhase( float c, float g ) {
  float g2 = g * g;
  float d = max( 1.0 + g2 - 2.0 * g * c, 1e-4 );
  return ( 1.0 - g2 ) / ( 4.0 * SKY_PI * d * sqrt( d ) );
}
float rayleighPhase( float c ) { return ( 3.0 / ( 16.0 * SKY_PI ) ) * ( 1.0 + c * c ); }

float hash11( float p ) {
  p = fract( p * 0.1031 );
  p *= p + 33.33;
  p *= p + p;
  return fract( p );
}
float hash13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.zyx + 31.32 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec3 hash33( vec3 p3 ) {
  p3 = fract( p3 * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yxx ) * p3.zyx );
}

float vnoise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = hash13( i + vec3( 0.0, 0.0, 0.0 ) );
  float b = hash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float c = hash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float d = hash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float e = hash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float g = hash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float h = hash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float k = hash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix( mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y ),
              mix( mix( e, g, f.x ), mix( h, k, f.x ), f.y ), f.z );
}
float fbm3( vec3 p ) {
  float v = 0.0, a = 0.5;
  for ( int i = 0; i < 4; i ++ ) {
    v += a * vnoise3( p );
    p = p * 2.03 + vec3( 11.7, 3.1, 19.3 );
    a *= 0.5;
  }
  return v;
}

/** Interleaved-gradient noise — cheap, well distributed, stable under TAA. */
float ign( vec2 px, float frame ) {
  px += 5.588238 * fract( frame * 0.6180339887 ) * 64.0;
  return fract( 52.9829189 * fract( 0.06711056 * px.x + 0.00583715 * px.y ) );
}
`;

/* ═════════════════════════════════════════════════════════════════ atmosphere ══ */

// language=GLSL
export const SKY_ATMOSPHERE = /* glsl */ `
const float ATMO_GROUND_R = 6.360;                        // Mm
const float ATMO_TOP_R    = 6.460;                        // Mm
const vec3  ATMO_RAY_S    = vec3( 5.802, 13.558, 33.100 );// 1/Mm
const float ATMO_MIE_S    = 3.996;
const float ATMO_MIE_A    = 4.400;
const vec3  ATMO_OZONE_A  = vec3( 0.650, 1.881, 0.085 );

/** Ray vs sphere centred at the origin. Returns the nearest positive hit, or -1. */
float atmoRaySphere( vec3 ro, vec3 rd, float rad ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - rad * rad;
  if ( c > 0.0 && b > 0.0 ) return -1.0;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  float sd = sqrt( disc );
  if ( sd > abs( b ) ) return -b + sd;   // origin inside the sphere
  return -b - sd;
}

void atmoScattering( vec3 pos, out vec3 rayS, out float mieS, out vec3 ext ) {
  float altKm = ( length( pos ) - ATMO_GROUND_R ) * 1000.0;
  float rayD = exp( -altKm / 8.0 );
  float mieD = exp( -altKm / 1.2 );
  rayS = ATMO_RAY_S * rayD;
  mieS = ATMO_MIE_S * mieD;
  // Chappuis band: a broad absorption around 25 km that survives long twilight paths.
  vec3 ozone = ATMO_OZONE_A * max( 0.0, 1.0 - abs( altKm - 25.0 ) / 15.0 );
  ext = rayS + vec3( mieS + ATMO_MIE_A * mieD ) + ozone;
}

vec2 atmoLutUv( vec3 pos, vec3 lightDir ) {
  float h = length( pos );
  float cosT = dot( pos / h, lightDir );
  return vec2( sat1( 0.5 + 0.5 * cosT ),
               sat1( ( h - ATMO_GROUND_R ) / ( ATMO_TOP_R - ATMO_GROUND_R ) ) );
}
vec3 atmoSampleLut( sampler2D lut, vec3 pos, vec3 lightDir ) {
  return texture2D( lut, atmoLutUv( pos, lightDir ) ).rgb;
}

/**
 * Sky-view LUT parameterisation (Hillaire §5.3). Azimuth is measured relative to the
 * sun so the LUT stays 2D, and the zenith axis uses a sqrt warp that piles resolution
 * onto the horizon where all the interesting gradient lives.
 */
vec2 skyViewUv( vec3 viewPos, vec3 rayDir, vec3 sunDir ) {
  float height = length( viewPos );
  vec3 up = viewPos / height;
  float horizonAngle = safeacos(
    sqrt( max( height * height - ATMO_GROUND_R * ATMO_GROUND_R, 0.0 ) ) / height ) - 0.5 * SKY_PI;
  float altitudeAngle = 0.5 * SKY_PI - safeacos( dot( rayDir, up ) );

  float azimuthAngle = 0.0;
  vec3 rt = cross( sunDir, up );
  float rl = length( rt );
  if ( rl > 1e-4 && abs( altitudeAngle ) < ( 0.5 * SKY_PI - 1e-4 ) ) {
    rt /= rl;
    vec3 fw = cross( up, rt );
    vec3 pd = rayDir - up * dot( rayDir, up );
    float pl = length( pd );
    pd = pl > 1e-6 ? pd / pl : fw;
    azimuthAngle = atan( dot( pd, rt ), dot( pd, fw ) ) + SKY_PI;
  }
  float coord = ( altitudeAngle + horizonAngle ) / ( 0.5 * SKY_PI );
  coord = sqrt( abs( coord ) ) * sign( coord );
  return vec2( azimuthAngle / ( 2.0 * SKY_PI ), coord * 0.5 + 0.5 );
}
`;

/* ══════════════════════════════════════════════════════════════════ LUT passes ══ */

// language=GLSL
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// language=GLSL
export const TRANSMITTANCE_FRAG = /* glsl */ `
precision highp float;
${SKY_MATH}
${SKY_ATMOSPHERE}
varying vec2 vUv;

void main() {
  float cosT = 2.0 * vUv.x - 1.0;
  float sinT = sqrt( max( 1.0 - cosT * cosT, 0.0 ) );
  float height = mix( ATMO_GROUND_R, ATMO_TOP_R, vUv.y );
  vec3 pos = vec3( 0.0, height, 0.0 );
  vec3 sunDir = normalize( vec3( 0.0, cosT, -sinT ) );

  vec3 tr = vec3( 1.0 );
  if ( atmoRaySphere( pos, sunDir, ATMO_GROUND_R ) > 0.0 ) {
    tr = vec3( 0.0 );
  } else {
    float atmoDist = atmoRaySphere( pos, sunDir, ATMO_TOP_R );
    float t = 0.0;
    for ( int i = 0; i < 40; i ++ ) {
      float newT = ( ( float( i ) + 0.3 ) / 40.0 ) * atmoDist;
      float dt = newT - t;
      t = newT;
      vec3 rs; float ms; vec3 ex;
      atmoScattering( pos + t * sunDir, rs, ms, ex );
      tr *= exp( -dt * ex );
    }
  }
  gl_FragColor = vec4( tr, 1.0 );
}
`;

// language=GLSL
export const MULTISCATTER_FRAG = /* glsl */ `
precision highp float;
${SKY_MATH}
${SKY_ATMOSPHERE}
uniform sampler2D tTransmittance;
uniform vec3 uGroundAlbedo;
varying vec2 vUv;

#define MS_SQRT 6
#define MS_STEPS 14

void main() {
  float cosT = 2.0 * vUv.x - 1.0;
  float sinT = sqrt( max( 1.0 - cosT * cosT, 0.0 ) );
  float height = mix( ATMO_GROUND_R, ATMO_TOP_R, vUv.y );
  vec3 pos = vec3( 0.0, height, 0.0 );
  vec3 sunDir = normalize( vec3( 0.0, cosT, -sinT ) );

  vec3 lumTotal = vec3( 0.0 );
  vec3 fms = vec3( 0.0 );
  float invSamples = 1.0 / float( MS_SQRT * MS_SQRT );

  for ( int i = 0; i < MS_SQRT; i ++ ) {
    for ( int j = 0; j < MS_SQRT; j ++ ) {
      float theta = SKY_PI * ( float( i ) + 0.5 ) / float( MS_SQRT );
      float phi = safeacos( 1.0 - 2.0 * ( float( j ) + 0.5 ) / float( MS_SQRT ) );
      float cp = cos( phi ), sp = sin( phi ), ct = cos( theta ), st = sin( theta );
      vec3 rayDir = vec3( cp * st, ct, sp * st );

      float atmoDist = atmoRaySphere( pos, rayDir, ATMO_TOP_R );
      float groundDist = atmoRaySphere( pos, rayDir, ATMO_GROUND_R );
      float tMax = groundDist > 0.0 ? groundDist : atmoDist;

      float cosL = dot( rayDir, sunDir );
      float miePhase = hgPhase( cosL, 0.8 );
      float rayPhase = rayleighPhase( cosL );

      vec3 lum = vec3( 0.0 );
      vec3 lumFactor = vec3( 0.0 );
      vec3 transmittance = vec3( 1.0 );
      float t = 0.0;
      for ( int s = 0; s < MS_STEPS; s ++ ) {
        float newT = ( ( float( s ) + 0.3 ) / float( MS_STEPS ) ) * tMax;
        float dt = newT - t;
        t = newT;
        vec3 np = pos + t * rayDir;
        vec3 rs; float ms; vec3 ex;
        atmoScattering( np, rs, ms, ex );
        vec3 sampleT = exp( -dt * ex );
        vec3 noPhase = rs + vec3( ms );
        vec3 sf = ( noPhase - noPhase * sampleT ) / max( ex, vec3( 1e-6 ) );
        lumFactor += transmittance * sf;

        vec3 sunT = atmoSampleLut( tTransmittance, np, sunDir );
        vec3 inScat = ( rs * rayPhase + vec3( ms * miePhase ) ) * sunT;
        vec3 integ = ( inScat - inScat * sampleT ) / max( ex, vec3( 1e-6 ) );
        lum += integ * transmittance;
        transmittance *= sampleT;
      }

      if ( groundDist > 0.0 && dot( pos, sunDir ) > 0.0 ) {
        vec3 hit = normalize( pos + groundDist * rayDir ) * ATMO_GROUND_R;
        lum += transmittance * uGroundAlbedo *
               atmoSampleLut( tTransmittance, hit, sunDir );
      }
      fms += lumFactor * invSamples;
      lumTotal += lum * invSamples;
    }
  }
  vec3 psi = lumTotal / max( 1.0 - fms, vec3( 1e-3 ) );
  gl_FragColor = vec4( psi, 1.0 );
}
`;

// language=GLSL
export const SKYVIEW_FRAG = /* glsl */ `
precision highp float;
${SKY_MATH}
${SKY_ATMOSPHERE}
uniform sampler2D tTransmittance;
uniform sampler2D tMultiScatter;
uniform vec3 uSunDirection;   // already rotated into the LUT's canonical frame
uniform float uViewHeight;    // Mm, absolute (ground radius + camera altitude)
varying vec2 vUv;

#define SV_STEPS 32

vec3 raymarchScattering( vec3 pos, vec3 rayDir, vec3 sunDir, float tMax ) {
  float cosL = dot( rayDir, sunDir );
  float miePhase = hgPhase( cosL, 0.8 );
  float rayPhase = rayleighPhase( cosL );
  vec3 lum = vec3( 0.0 );
  vec3 transmittance = vec3( 1.0 );
  float t = 0.0;
  for ( int i = 0; i < SV_STEPS; i ++ ) {
    float newT = ( ( float( i ) + 0.3 ) / float( SV_STEPS ) ) * tMax;
    float dt = newT - t;
    t = newT;
    vec3 np = pos + t * rayDir;
    vec3 rs; float ms; vec3 ex;
    atmoScattering( np, rs, ms, ex );
    vec3 sampleT = exp( -dt * ex );
    vec3 sunT = atmoSampleLut( tTransmittance, np, sunDir );
    vec3 psiMS = atmoSampleLut( tMultiScatter, np, sunDir );
    vec3 inScat = rs * ( rayPhase * sunT + psiMS ) + vec3( ms ) * ( miePhase * sunT + psiMS );
    vec3 integ = ( inScat - inScat * sampleT ) / max( ex, vec3( 1e-6 ) );
    lum += integ * transmittance;
    transmittance *= sampleT;
  }
  return lum;
}

void main() {
  float azimuthAngle = ( vUv.x - 0.5 ) * 2.0 * SKY_PI;
  float adjV;
  if ( vUv.y < 0.5 ) { float c = 1.0 - 2.0 * vUv.y; adjV = -c * c; }
  else               { float c = vUv.y * 2.0 - 1.0;  adjV =  c * c; }

  vec3 viewPos = vec3( 0.0, uViewHeight, 0.0 );
  float height = length( viewPos );
  float horizonAngle = safeacos(
    sqrt( max( height * height - ATMO_GROUND_R * ATMO_GROUND_R, 0.0 ) ) / height ) - 0.5 * SKY_PI;
  float altitudeAngle = adjV * 0.5 * SKY_PI - horizonAngle;

  float ca = cos( altitudeAngle ), sa = sin( altitudeAngle );
  vec3 rayDir = vec3( ca * sin( azimuthAngle ), sa, -ca * cos( azimuthAngle ) );

  float atmoDist = atmoRaySphere( viewPos, rayDir, ATMO_TOP_R );
  float groundDist = atmoRaySphere( viewPos, rayDir, ATMO_GROUND_R );
  float tMax = groundDist > 0.0 ? groundDist : atmoDist;

  vec3 lum = raymarchScattering( viewPos, rayDir, uSunDirection, tMax );
  gl_FragColor = vec4( lum, 1.0 );
}
`;

/* ═══════════════════════════════════════════════════════════════════════ clouds ══ */

/**
 * Volumetric cumulus. Density is a Perlin-Worley base shape eroded by high-frequency
 * Worley detail, gated by a weather map (coverage / type) and a vertical profile.
 * The layer is a spherical shell around an artistically small planet (2000 km) so the
 * deck curves down to the horizon instead of stretching to infinity.
 */
// language=GLSL
export const CLOUD_COMMON = /* glsl */ `
precision highp sampler3D;

uniform sampler3D tShape;
uniform sampler3D tDetail;
uniform sampler2D tWeather;

uniform float uCloudBottom;
uniform float uCloudTop;
uniform float uCoverage;
uniform float uCloudDensity;
uniform float uCloudExtinction;
uniform float uCloudType;
uniform vec2  uCloudWind;      // metres of accumulated advection
uniform vec2  uWeatherWind;
uniform float uCloudBaseScale; // 1/metres
uniform float uCloudDetailMul;
uniform vec3  uCloudSunDir;
uniform vec3  uCloudSunColor;
uniform vec3  uCloudSkyTop;
uniform vec3  uCloudSkyBottom;
uniform vec3  uCloudHaze;
uniform float uCloudAerial;
uniform float uCloudMaxDist;

const float SKY_CLOUD_R = 2000000.0;

/** Altitude above the curved surface (parabolic approximation, precision friendly). */
float cloudAltitude( vec3 p ) {
  return p.y + ( p.x * p.x + p.z * p.z ) / ( 2.0 * SKY_CLOUD_R );
}

/** Distance along rd to the shell at altitude h, from a viewer at camAlt. */
float cloudLayerDist( vec3 rd, float camAlt, float h ) {
  float R = SKY_CLOUD_R;
  float b = rd.y * ( R + camAlt );
  float c = ( camAlt - h ) * ( 2.0 * R + camAlt + h );
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  float sd = sqrt( disc );
  float t0 = -b - sd;
  float t1 = -b + sd;
  if ( t1 < 0.0 ) return -1.0;
  return t0 > 0.0 ? t0 : t1;
}

/** Vertical density profile: rounded base, sheared flat top, anvil for storm types. */
float cloudProfile( float hf, float type ) {
  float stratus = remap01( hf, 0.0, 0.10 ) * ( 1.0 - remap01( hf, 0.12, 0.30 ) );
  float cumulus = remap01( hf, 0.02, 0.22 ) * ( 1.0 - remap01( hf, 0.60, 0.98 ) );
  float towering = remap01( hf, 0.01, 0.12 ) * ( 1.0 - remap01( hf, 0.86, 1.0 ) );
  float a = mix( stratus, cumulus, sat1( type * 2.0 ) );
  return mix( a, towering, sat1( ( type - 0.5 ) * 2.0 ) );
}

float cloudDensity( vec3 p, float lod ) {
  float alt = cloudAltitude( p );
  float hf = ( alt - uCloudBottom ) / ( uCloudTop - uCloudBottom );
  if ( hf < 0.0 || hf > 1.0 ) return 0.0;

  vec3 wp = p + vec3( uCloudWind.x, 0.0, uCloudWind.y );

  // Weather map: coverage, type, and a very large scale mass modulation.
  vec2 wuv = ( p.xz + uWeatherWind ) * ( 1.0 / 46000.0 );
  vec3 w = texture2D( tWeather, wuv ).rgb;
  float coverage = sat1( uCoverage * ( 0.30 + 1.45 * w.r ) * ( 0.55 + 0.75 * w.b ) );
  if ( coverage <= 0.001 ) return 0.0;
  float type = sat1( uCloudType * ( 0.35 + 1.1 * w.g ) );

  // Base shape: low-frequency Perlin remapped by Worley fbm -> billowing cauliflower.
  vec4 base = texture( tShape, wp * uCloudBaseScale + vec3( 0.0, hf * 0.09, 0.0 ) );
  float wfbm = base.g * 0.625 + base.b * 0.25 + base.a * 0.125;
  float shape = sat1( remapv( base.r, wfbm - 1.0, 1.0, 0.0, 1.0 ) );

  shape *= cloudProfile( hf, type );
  shape = sat1( remapv( shape, 1.0 - coverage, 1.0, 0.0, 1.0 ) );
  if ( shape <= 0.0 ) return 0.0;

  if ( lod < 0.5 ) {
    // Erode the edges with high-frequency detail; wispy at the base, billowy on top.
    vec3 dsample = texture( tDetail,
      wp * ( uCloudBaseScale * uCloudDetailMul ) + vec3( 0.0, uCloudWind.x * 4e-5, 0.0 ) ).rgb;
    float dfbm = dsample.r * 0.625 + dsample.g * 0.25 + dsample.b * 0.125;
    float dmod = mix( 1.0 - dfbm, dfbm, sat1( hf * 5.0 ) );
    shape = sat1( remapv( shape, dmod * 0.42, 1.0, 0.0, 1.0 ) );
  }

  // Real cumulus are denser at the top of the cell than at the ragged base.
  float vertical = mix( 0.35, 1.0, sat1( hf * 1.8 ) ) * ( 1.0 - 0.35 * remap01( hf, 0.80, 1.0 ) );
  return max( shape, 0.0 ) * uCloudDensity * vertical;
}

/**
 * Energy after N scattering orders (Wrenninge/Schneider octave approximation).
 * Phase is normalised so an isotropic scatterer returns 1 — that keeps the sun term
 * in "irradiance / pi" units and stops the forward lobe from silently rescaling the
 * whole deck.
 */
float cloudMultiScatter( float opticalDepth, float cosT ) {
  float e = 0.0;
  float a = 1.0, b = 1.0, c = 1.0;
  for ( int i = 0; i < 3; i ++ ) {
    float phase = mix( hgPhase( cosT, 0.78 * c ), hgPhase( cosT, -0.28 * c ), 0.30 );
    e += b * exp( -opticalDepth * a ) * phase * ( 4.0 * SKY_PI );
    a *= 0.52;
    b *= 0.48;
    c *= 0.62;
  }
  return e;
}

/** Cone-sampled shadow march toward the key light. Returns optical depth. */
float cloudLightDepth( vec3 p, vec3 L, int steps ) {
  const vec3 cone0 = vec3(  0.32, -0.14,  0.21 );
  const vec3 cone1 = vec3( -0.24,  0.27, -0.31 );
  const vec3 cone2 = vec3(  0.17,  0.33,  0.26 );
  float depth = 0.0;
  float t = 0.0;
  float ds = 55.0;
  for ( int i = 0; i < 8; i ++ ) {
    if ( i >= steps ) break;
    t += ds;
    vec3 jitter = ( i == 0 ? cone0 : ( i == 1 ? cone1 : cone2 ) ) * t * 0.30;
    float d = cloudDensity( p + L * t + jitter, 1.0 );
    depth += d * ds;
    ds *= 1.85;
  }
  // One long sample catches the bulk of a distant cell without another 8 taps.
  depth += cloudDensity( p + L * ( t + 1800.0 ), 1.0 ) * 900.0;
  return depth * uCloudExtinction;
}

/**
 * March the cloud deck. Returns premultiplied scattering in rgb and transmittance in a.
 */
vec4 cloudMarch( vec3 ro, vec3 rd, float dither, int steps, int lightSteps ) {
  if ( uCoverage <= 0.001 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
  float camAlt = cloudAltitude( ro );
  if ( rd.y < -0.004 && camAlt < uCloudBottom ) return vec4( 0.0, 0.0, 0.0, 1.0 );

  float tA = cloudLayerDist( rd, camAlt, uCloudBottom );
  float tB = cloudLayerDist( rd, camAlt, uCloudTop );
  float tStart, tEnd;
  if ( camAlt < uCloudBottom ) { tStart = tA; tEnd = tB; }
  else if ( camAlt > uCloudTop ) { tStart = tB; tEnd = tA; }
  else { tStart = 0.0; tEnd = max( tA, tB ); }
  if ( tStart < 0.0 || tEnd <= tStart ) return vec4( 0.0, 0.0, 0.0, 1.0 );
  tEnd = min( tEnd, tStart + uCloudMaxDist );

  float span = tEnd - tStart;
  float growth = 0.055;
  float n = float( steps );
  float ds0 = span / ( n * ( 1.0 + growth * ( n - 1.0 ) * 0.5 ) );

  float cosT = dot( rd, uCloudSunDir );
  float powderMix = sat1( -cosT * 0.5 + 0.5 );

  vec3 scattered = vec3( 0.0 );
  float transmittance = 1.0;
  float t = tStart + ds0 * dither;
  float distAccum = 0.0;
  float weightAccum = 1e-5;
  int empty = 0;

  for ( int i = 0; i < 128; i ++ ) {
    if ( i >= steps || transmittance < 0.015 || t > tEnd ) break;
    float ds = ds0 * ( 1.0 + growth * float( i ) );
    vec3 p = ro + rd * t;

    float d = cloudDensity( p, 0.0 );
    if ( d > 0.0008 ) {
      empty = 0;
      float sigmaE = max( d * uCloudExtinction, 1e-7 );
      float ld = cloudLightDepth( p, uCloudSunDir, lightSteps );
      float ms = cloudMultiScatter( ld, cosT );

      // Powder: the darkening you see on the lit side of a dense cell. Driven by
      // local density, not by step length, so it survives coarse far-field steps.
      float powder = 1.0 - exp( -d * 6.0 );
      float powderTerm = mix( 1.0, powder, powderMix );

      float hf = sat1( ( cloudAltitude( p ) - uCloudBottom ) / ( uCloudTop - uCloudBottom ) );
      vec3 ambient = mix( uCloudSkyBottom, uCloudSkyTop, hf * hf * 0.85 + 0.15 );
      ambient *= 0.35 + 0.65 * hf;

      // Albedo ~1: sigmaS == sigmaE, so the integral collapses to a clean
      // (radiance)*(1 - exp(-tau)) and can never exceed the source radiance.
      vec3 S = ( uCloudSunColor * ms * powderTerm + ambient ) * sigmaE;
      vec3 integ = ( S - S * exp( -sigmaE * ds ) ) / sigmaE;
      scattered += transmittance * integ;
      float w = transmittance * d;
      distAccum += t * w;
      weightAccum += w;
      transmittance *= exp( -sigmaE * ds );
    } else {
      empty ++;
      if ( empty > 2 ) t += ds * 1.4;   // skip through clear air
    }
    t += ds;
  }

  // Aerial perspective: distant cells wash into the haze instead of staying crisp.
  float meanDist = distAccum / weightAccum;
  float fade = 1.0 - exp( -meanDist * uCloudAerial );
  scattered = mix( scattered, uCloudHaze * ( 1.0 - transmittance ), fade * 0.92 );

  return vec4( max( scattered, vec3( 0.0 ) ), sat1( transmittance ) );
}
`;

// language=GLSL
export const CLOUD_FRAG = /* glsl */ `
precision highp float;
${SKY_MATH}
${CLOUD_COMMON}

uniform sampler2D tHistory;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform vec2 uResolution;
uniform float uFrame;
uniform float uReset;
uniform float uHistoryBlend;
varying vec2 vUv;

#ifndef CLOUD_STEPS
#define CLOUD_STEPS 48
#endif
#ifndef CLOUD_LIGHT_STEPS
#define CLOUD_LIGHT_STEPS 5
#endif

void main() {
  vec2 px = vUv * uResolution;

  // Sub-pixel jitter: temporal accumulation turns it into free supersampling.
  vec2 jit = ( vec2( hash11( uFrame * 1.13 + 0.37 ), hash11( uFrame * 2.71 + 5.11 ) ) - 0.5 )
             / uResolution;
  vec4 clip = vec4( ( vUv + jit ) * 2.0 - 1.0, 1.0, 1.0 );
  vec4 wp = uInvViewProj * clip;
  vec3 rd = normalize( wp.xyz / wp.w - uCamPos );

  float dither = ign( px, uFrame );
  vec4 cur = cloudMarch( uCamPos, rd, dither, CLOUD_STEPS, CLOUD_LIGHT_STEPS );

  // Reprojection is exact for a layer this distant: project the ray, not the pixel.
  vec4 pc = uPrevViewProj * vec4( uCamPos + rd * 40000.0, 1.0 );
  vec2 puv = pc.xy / max( pc.w, 1e-6 ) * 0.5 + 0.5;
  float valid = ( pc.w > 0.0 &&
                  puv.x > 0.001 && puv.x < 0.999 &&
                  puv.y > 0.001 && puv.y < 0.999 ) ? 1.0 : 0.0;

  vec4 hist = texture2D( tHistory, puv );
  hist = clamp( hist, cur - vec4( 0.22 ), cur + vec4( 0.22 ) );
  float a = uHistoryBlend * valid * ( 1.0 - uReset );
  gl_FragColor = mix( cur, hist, a );
}
`;

/* ═════════════════════════════════════════════════════════════════════ sky dome ══ */

// language=GLSL
export const SKY_VERT = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldDir = wp.xyz - cameraPosition;
  // .xyww pins the dome to the far plane: no clipping, no seam, no pole pinch.
  gl_Position = ( projectionMatrix * viewMatrix * wp ).xyww;
}
`;

// language=GLSL
export const SKY_FRAG = /* glsl */ `
precision highp float;
${SKY_MATH}
${SKY_ATMOSPHERE}
#ifdef SKY_ENV
${CLOUD_COMMON}
#endif

uniform sampler2D tTransmittance;
uniform sampler2D tSkyView;
uniform sampler2D tCirrus;
uniform sampler2D tGalaxy;
#ifndef SKY_ENV
uniform sampler2D tClouds;
uniform mat4 uCloudViewProj;
uniform float uHasClouds;
#endif

uniform vec3  uSunDirection;
uniform vec3  uMoonDirection;
uniform vec3  uSunDiscRadiance;
uniform vec3  uSunGlowColor;
uniform vec2  uSkyChroma;   // x saturation restore, y zenith-blue bias
uniform vec3  uMoonDiscRadiance;
uniform vec3  uMoonGlowColor;
uniform vec3  uNightSkyColor;
uniform vec3  uStarTint;
uniform vec3  uGroundLit;
uniform vec3  uCirrusSunColor;
uniform vec3  uCirrusAmbient;
uniform vec3  uPollutionColor;
uniform vec3  uCameraPos;
uniform vec2  uCirrusScroll;
uniform float uViewHeight;
uniform float uSkyScale;
uniform float uSunAngularRadius;
uniform float uMoonAngularRadius;
uniform float uStarFade;
uniform float uNightFade;
uniform float uCirrusAmount;
uniform float uCirrusHeight;
uniform float uTime;
uniform float uStarBrightness;

varying vec3 vWorldDir;

const vec3 LIMB_U = vec3( 0.34, 0.47, 0.64 );
const vec3 LIMB_V = vec3( 0.28, 0.23, 0.16 );

/* ---------------------------------------------------------------------- stars -- */

vec3 cubeFaceDir( vec2 uv, float face ) {
  if ( face < 0.5 ) return normalize( vec3(  1.0, uv.y, uv.x ) );
  if ( face < 1.5 ) return normalize( vec3( -1.0, uv.y, uv.x ) );
  if ( face < 2.5 ) return normalize( vec3( uv.x,  1.0, uv.y ) );
  if ( face < 3.5 ) return normalize( vec3( uv.x, -1.0, uv.y ) );
  if ( face < 4.5 ) return normalize( vec3( uv.x, uv.y,  1.0 ) );
  return normalize( vec3( uv.x, uv.y, -1.0 ) );
}

/**
 * Procedural star field on a cube-face cell grid (uniform density, no pole clumping).
 * Magnitudes follow N(<m) ~ 10^(0.6 m), so flux is a power law: a handful of bright
 * stars over a dust of faint ones, which is what makes a real sky read as deep.
 */
vec3 starField( vec3 dir, float pixelAngle ) {
  const float CELLS = 172.0;
  const float OCCUPANCY = 0.17;   // ~30k stars over the sphere, ~4k above naked-eye
  vec3 a = abs( dir );
  float m = max( a.x, max( a.y, a.z ) );
  vec2 uv;
  float face;
  if ( m == a.x )      { uv = dir.zy / a.x; face = dir.x > 0.0 ? 0.0 : 1.0; }
  else if ( m == a.y ) { uv = dir.xz / a.y; face = dir.y > 0.0 ? 2.0 : 3.0; }
  else                 { uv = dir.xy / a.z; face = dir.z > 0.0 ? 4.0 : 5.0; }

  vec2 g = uv * CELLS;
  vec2 gi = floor( g );
  float sigma = max( pixelAngle * 0.80, 0.00085 );
  float horizonScint = sat1( 1.0 - dir.y * 1.7 );
  vec3 acc = vec3( 0.0 );

  for ( int y = -1; y <= 1; y ++ ) {
    for ( int x = -1; x <= 1; x ++ ) {
      vec2 c = gi + vec2( float( x ), float( y ) );
      vec3 h = hash33( vec3( c, face * 17.31 ) );
      if ( h.z > OCCUPANCY ) continue;

      // N(<m) ~ 10^(0.6 m) inverted, so flux is a power law over ~3 decades.
      float u = max( hash13( vec3( c * 1.37 + 7.7, face * 3.1 ) ), 1e-4 );
      float flux = 2.512 * pow( 1.0 + u * 31622.0, -0.66667 );

      vec2 sp = ( c + vec2( h.x, h.y ) ) / CELLS;
      vec3 sdir = cubeFaceDir( sp, face );
      float d = length( dir - sdir );
      float gauss = exp( -( d * d ) / ( sigma * sigma ) );
      if ( gauss < 0.002 ) continue;

      // Colour: mostly white, a blue-white tail and a gentle K/M tail. Stars read
      // as white to the naked eye; only the brightest show obvious tint.
      float ct = hash13( vec3( c * 0.71 - 3.3, face * 5.7 ) );
      vec3 col = ct < 0.30
        ? mix( vec3( 0.70, 0.80, 1.00 ), vec3( 1.0 ), ct / 0.30 )
        : mix( vec3( 1.0 ), vec3( 1.00, 0.83, 0.68 ), sat1( ( ct - 0.30 ) / 0.70 ) * 0.55 );

      // Scintillation: only meaningful low in the sky, and deliberately gentle.
      float tw = 1.0 + 0.30 * horizonScint *
                 sin( uTime * ( 2.3 + 4.7 * h.z ) + h.x * 41.0 );
      acc += col * ( flux * gauss * tw );
    }
  }
  return acc * uStarBrightness;
}

/**
 * Milky Way. The band is three octaves of fBm with dust lanes cut out of it, but
 * evaluating that per pixel costs ~1200 flops on every night frame, so it is baked
 * to a small equirect map at init. The u axis wraps (RepeatWrapping) and the texture
 * has no mips, so there is no seam and no derivative pop at the azimuth wrap.
 */
vec3 milkyWay( vec3 dir ) {
  vec2 guv = vec2( atan( dir.z, dir.x ) / ( 2.0 * SKY_PI ) + 0.5,
                   safeacos( dir.y ) / SKY_PI );
  return texture2D( tGalaxy, guv ).rgb * uStarTint * 2.0;
}

/* ---------------------------------------------------------------------- cirrus -- */

float cirrusCover( vec3 dir ) {
  if ( uCirrusAmount <= 0.001 || dir.y < 0.012 ) return 0.0;
  // Same curved-shell trick as the cumulus so the layer converges at the horizon.
  float R = 2000000.0;
  float camAlt = max( uCameraPos.y, 0.0 );
  float b = dir.y * ( R + camAlt );
  float c = ( camAlt - uCirrusHeight ) * ( 2.0 * R + camAlt + uCirrusHeight );
  float disc = b * b - c;
  if ( disc < 0.0 ) return 0.0;
  float t = -b + sqrt( disc );
  vec2 p = ( uCameraPos.xz + dir.xz * t ) * 0.000021;

  float a = texture2D( tCirrus, p + uCirrusScroll ).r;
  float d = texture2D( tCirrus, p * 2.7 + uCirrusScroll * 1.9 + vec2( 0.31, 0.77 ) ).g;
  float cover = sat1( ( a * 0.72 + d * 0.42 - 0.44 ) * 2.6 ) * uCirrusAmount;
  return cover * smoothstep( 0.012, 0.16, dir.y );
}

/* ------------------------------------------------------------------------ moon -- */

vec3 moonDisc( vec3 dir, float ang, out float mask ) {
  mask = 0.0;
  if ( ang > uMoonAngularRadius ) return vec3( 0.0 );
  vec3 up = abs( uMoonDirection.y ) > 0.98 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
  vec3 right = normalize( cross( up, uMoonDirection ) );
  vec3 mup = cross( uMoonDirection, right );

  vec3 off = dir - uMoonDirection * dot( dir, uMoonDirection );
  vec2 d2 = vec2( dot( off, right ), dot( off, mup ) ) / uMoonAngularRadius;
  float r2 = dot( d2, d2 );
  if ( r2 > 1.0 ) return vec3( 0.0 );
  float z = sqrt( max( 1.0 - r2, 0.0 ) );
  vec3 N = normalize( d2.x * right + d2.y * mup - z * uMoonDirection );

  float ndl = dot( N, uSunDirection );
  // The Moon is a retroreflector: Lommel-Seeliger flattens the Lambertian falloff.
  float lit = sat1( ndl );
  lit = lit / ( lit + 0.34 ) * 1.34;
  lit *= smoothstep( -0.06, 0.06, ndl );

  // Maria and highlands.
  float maria = fbm3( N * 3.1 + vec3( 4.7 ) );
  float craters = fbm3( N * 11.0 );
  float albedo = mix( 0.72, 1.18, sat1( maria * 1.25 ) ) * ( 0.88 + 0.24 * craters );

  mask = 1.0 - smoothstep( 0.962, 1.0, sqrt( r2 ) );
  return uMoonDiscRadiance * lit * albedo * mask;
}

/* ------------------------------------------------------------------------ main -- */

void main() {
  vec3 dir = normalize( vWorldDir );
  float pixelAngle = clamp( length( fwidth( dir ) ), 0.00015, 0.02 );
  vec3 viewPos = vec3( 0.0, uViewHeight, 0.0 );

  /* --- atmospheric in-scattering ------------------------------------------- */
  vec2 svUv = skyViewUv( viewPos, dir, uSunDirection );
  vec3 sky = texture2D( tSkyView, svUv ).rgb * uSkyScale;
  vec3 viewTr = atmoSampleLut( tTransmittance, viewPos, dir );

  /**
   * **Give the zenith its blue back.**
   *
   * The scattering integral is right, but two things downstream flatten it before
   * anybody sees it: the sky-view LUT is 200x112 for a whole hemisphere (so the Rayleigh
   * gradient is carried by a handful of texels and bilinear filtering averages the
   * chroma out of it), and AgX's inset matrix mixes 11-14 % of each channel into its
   * neighbours on the way through the tonemapper. Both are luminance-preserving losses
   * of *saturation*, so the correction is a luminance-preserving restore of saturation,
   * applied here where the sky is still scene-referred and nothing else has been mixed
   * into it. The zenith bias then leans the top of the dome further towards blue, which
   * is where single scattering is strongest and where the filtering loss is worst.
   */
  {
    float skyL = dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) );
    sky = max( mix( vec3( skyL ), sky, uSkyChroma.x ), vec3( 0.0 ) );
    float up = sat1( dir.y );
    sky *= mix( vec3( 1.0 ), vec3( 0.86, 0.97, 1.20 ), up * up * uSkyChroma.y );
  }

  /* --- ground / distant terrain haze below the horizon ---------------------- */
  if ( dir.y < 0.0 ) {
    float gd = max( uCameraPos.y, 1.0 ) / max( -dir.y, 1e-3 );
    float vis = exp( -gd / 5200.0 );
    sky = mix( sky, uGroundLit, vis * 0.94 );
  }

  /* --- celestial bodies ------------------------------------------------------ */
  float cosSun = dot( dir, uSunDirection );
  float sunAng = safeacos( cosSun );
  vec3 sun = vec3( 0.0 );
  float sunEdge = 1.0 - smoothstep( uSunAngularRadius * 0.982, uSunAngularRadius * 1.018, sunAng );
  if ( sunEdge > 0.0 ) {
    float r = sat1( sunAng / uSunAngularRadius );
    float mu = sqrt( max( 1.0 - r * r, 0.0 ) );
    vec3 limb = max( 1.0 - LIMB_U * ( 1.0 - mu ) - LIMB_V * ( 1.0 - mu ) * ( 1.0 - mu ),
                     vec3( 0.0 ) );
    sun = uSunDiscRadiance * limb * sunEdge;
  }

  /**
   * Circumsolar aureole: forward-scattered sunlight off aerosols. Two lobes — a tight
   * one that reads as "the sun is *there*" and a broad one that warms the whole sun-side
   * quarter of the dome. Extinguished by the view transmittance like the disc, and cut
   * below the horizon so the glow does not survive into the ground blend.
   */
  vec3 aureole = uSunGlowColor *
    ( exp( -sunAng * 11.0 ) + 0.22 * exp( -sunAng * 2.6 ) ) *
    sat1( dir.y * 5.0 + 0.55 );

  float moonAng = safeacos( dot( dir, uMoonDirection ) );
  float moonMask;
  vec3 moon = moonDisc( dir, moonAng, moonMask );
  // Halo: the moon's own light scattered by the air right around it.
  vec3 moonHalo = uMoonGlowColor * ( 0.020 * exp( -moonAng * 26.0 ) +
                                     0.0035 * exp( -moonAng * 3.4 ) );

  /* --- night sky -------------------------------------------------------------- */
  vec3 stars = vec3( 0.0 );
  vec3 night = vec3( 0.0 );
  if ( uStarFade > 0.001 ) {
    stars = ( starField( dir, pixelAngle ) + milkyWay( dir ) ) * uStarFade;
    stars *= sat1( dir.y * 2.6 + 0.05 );   // atmospheric extinction near the horizon
  }
  if ( uNightFade > 0.001 ) {
    float zen = sat1( dir.y );
    // Airglow + residual Rayleigh: brightest a little above the horizon, never black
    // at the zenith. A night sky that crushes to 0 reads as a hole, not as sky.
    night = uNightSkyColor * ( 0.62 + 0.38 * ( 1.0 - zen ) ) * uNightFade;
    // Light-pollution dome. Sodium spill scattered by the whole air column: a broad
    // horizon-weighted wash with a real gradient into the upper sky, plus a small
    // isotropic floor. pow(., 9) put the entire term inside 20 degrees of the horizon,
    // which is below the frame in every pose we review.
    float below = sat1( 1.0 - dir.y );
    float dome = 0.22 + 0.78 * pow( below, 3.2 );
    night += uPollutionColor * dome * uNightFade;
    night += moonHalo * uNightFade;
  }

  /* --- cirrus deck ------------------------------------------------------------ */
  float cc = cirrusCover( dir );
  float cirrusT = exp( -cc * 2.6 );
  float forward = hgPhase( cosSun, 0.62 ) * 3.0 + 0.35;
  vec3 cirrusScatter = ( uCirrusSunColor * forward + uCirrusAmbient ) * ( 1.0 - cirrusT );

  /* --- cumulus deck ----------------------------------------------------------- */
  vec3 cloudScatter = vec3( 0.0 );
  float cloudT = 1.0;
#ifdef SKY_ENV
  {
    vec4 cl = cloudMarch( uCameraPos, dir, 0.5, 14, 3 );
    cloudScatter = cl.rgb;
    cloudT = cl.a;
  }
#else
  if ( uHasClouds > 0.5 ) {
    vec4 pc = uCloudViewProj * vec4( uCameraPos + dir * 40000.0, 1.0 );
    if ( pc.w > 0.0 ) {
      vec2 cuv = clamp( pc.xy / pc.w * 0.5 + 0.5, vec2( 0.0 ), vec2( 1.0 ) );
      vec4 cl = texture2D( tClouds, cuv );
      cloudScatter = max( cl.rgb, vec3( 0.0 ) );
      cloudT = sat1( cl.a );
    }
  }
#endif

  /* --- composite -------------------------------------------------------------- */
  vec3 behind = ( stars + sun + moon ) * viewTr + night;
  vec3 color = behind * cirrusT * cloudT
             + cirrusScatter * cloudT
             + cloudScatter
             + ( sky + aureole * viewTr ) * mix( 0.30, 1.0, cloudT );

  gl_FragColor = vec4( max( color, vec3( 0.0 ) ), 1.0 );
}
`;

/* ══════════════════════════════════════════════════════ aerial perspective chunk ══ */

/**
 * Injected into other modules' materials by `ctx.sky.applyAerialPerspective(mat)`.
 * Same scattering coefficients as the sky, so distant geometry sits in exactly the
 * atmosphere the sky is painted with, plus an exponential height-fog term and a
 * wind-drifted noise layer for ground mist.
 */
// language=GLSL
export const AERIAL_PARS_VERT = /* glsl */ `
varying vec3 vSkyWorldPos;
`;

// language=GLSL
export const AERIAL_VERT_BODY = /* glsl */ `
#ifdef USE_INSTANCING
  vSkyWorldPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
#else
  vSkyWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;

// language=GLSL
export const AERIAL_PARS_FRAG = /* glsl */ `
varying vec3 vSkyWorldPos;
uniform vec3  uSkyBetaR;
uniform float uSkyBetaM;
uniform vec3  uSkySunColor;
uniform vec3  uSkyAmbientColor;
uniform vec3  uSkySunDir;
uniform vec3  uSkyCamPos;
uniform vec4  uSkyFog;      // x density, y 1/heightScale, z groundY, w strength
uniform vec4  uSkyMist;     // x density, y top height, z world scale, w drift
uniform vec2  uSkyMistWind;

float skyHgPhase( float c, float g ) {
  float g2 = g * g;
  float d = max( 1.0 + g2 - 2.0 * g * c, 1e-4 );
  return ( 1.0 - g2 ) / ( 12.566370614 * d * sqrt( d ) );
}
float skyRayleighPhase( float c ) { return 0.0596831 * ( 1.0 + c * c ); }

float skyHash2( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float skyVnoise2( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = skyHash2( i );
  float b = skyHash2( i + vec2( 1.0, 0.0 ) );
  float c = skyHash2( i + vec2( 0.0, 1.0 ) );
  float d = skyHash2( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

/** Analytic optical depth through an exponential atmosphere along a segment. */
float skyAirMass( float y0, float dirY, float dist, float invH ) {
  float e0 = exp( -max( y0, 0.0 ) * invH );
  if ( abs( dirY ) < 1e-3 ) return dist * e0;
  float y1 = max( y0 + dirY * dist, 0.0 );
  return ( e0 - exp( -y1 * invH ) ) / ( dirY * invH );
}

vec3 skyAerialPerspective( vec3 color ) {
  vec3 v = vSkyWorldPos - uSkyCamPos;
  float dist = length( v );
  if ( dist < 0.05 ) return color;
  vec3 dir = v / dist;

  float invH = uSkyFog.y;
  float mass = max( skyAirMass( uSkyCamPos.y - uSkyFog.z, dir.y, dist, invH ), 0.0 );

  vec3 tauR = uSkyBetaR * mass;
  float tauM = uSkyBetaM * mass;

  // Ground mist: a shallow, slowly drifting noise layer that hugs the terrain.
  float mistTop = uSkyMist.y;
  float mid = ( uSkyCamPos.y + vSkyWorldPos.y ) * 0.5 - uSkyFog.z;
  float mistH = exp( -max( mid, 0.0 ) / max( mistTop, 1.0 ) );
  vec2 mp = ( uSkyCamPos.xz + dir.xz * dist * 0.5 ) * uSkyMist.z + uSkyMistWind;
  float mn = skyVnoise2( mp ) * 0.62 + skyVnoise2( mp * 2.7 + 3.1 ) * 0.38;
  float mist = uSkyMist.x * mistH * ( 0.35 + 1.15 * mn ) * dist;

  vec3 tau = ( tauR + vec3( tauM ) ) * uSkyFog.x + vec3( mist );
  vec3 T = exp( -tau * uSkyFog.w );

  float cosT = dot( dir, uSkySunDir );
  vec3 sR = uSkyBetaR * skyRayleighPhase( cosT );
  float sM = uSkyBetaM * skyHgPhase( cosT, 0.76 );
  vec3 weight = ( sR + vec3( sM ) ) / max( uSkyBetaR + vec3( uSkyBetaM ), vec3( 1e-6 ) );

  vec3 inscatter = ( uSkySunColor * weight + uSkyAmbientColor ) * ( vec3( 1.0 ) - T );
  return color * T + inscatter;
}
`;

// language=GLSL
export const AERIAL_APPLY_FRAG = /* glsl */ `
  gl_FragColor.rgb = skyAerialPerspective( gl_FragColor.rgb );
`;

export default {
  SKY_MATH,
  SKY_ATMOSPHERE,
  FULLSCREEN_VERT,
  TRANSMITTANCE_FRAG,
  MULTISCATTER_FRAG,
  SKYVIEW_FRAG,
  CLOUD_COMMON,
  CLOUD_FRAG,
  SKY_VERT,
  SKY_FRAG,
  AERIAL_PARS_VERT,
  AERIAL_VERT_BODY,
  AERIAL_PARS_FRAG,
  AERIAL_APPLY_FRAG,
};
