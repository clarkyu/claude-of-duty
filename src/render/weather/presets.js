/**
 * weather/presets.js — the seven weather states, as one flat record each.
 * Owner: weather agent. Files owned: src/render/Weather.js, src/render/weather/**.
 *
 * Every field here is a *number* (or a linear RGB triple), which is the whole point:
 * `setPreset(name, seconds)` cross-fades the entire record component-by-component, so
 * cloud coverage, sun intensity, fog density, wind, wetness, colour grade and particle
 * emission all arrive together on the same curve. There is no way to change one
 * without the others — swapping only the particles is exactly the failure mode this
 * table exists to make impossible.
 *
 * Where each field lands:
 *
 *   coverage/cloudType/cirrus/haze   ctx.sky.setCloudCoverage / setCloudType /
 *                                    setCirrus / setHaze
 *   sunScale                         ctx.lighting.setExposureCompensation
 *   fogDensity/fogStrength           sky.aerialUniforms.uSkyFog  (per-material aerial
 *                                    perspective — reaches every surface in the world)
 *   mistDensity/mistTop/mistScale    sky.aerialUniforms.uSkyMist (shallow ground layer)
 *   volDensity/volFogColor/volAniso  pipeline volumetrics pass (real in-scattering)
 *   wetness                          ctx.materials.setWetness
 *   dust                             ctx.materials.setDustLevel
 *   windSpeed/windDir/gust           ctx.materials.setWind + ctx.sky.setWind
 *   rain/rainSpeed/rainTint          Precipitation
 *   motes/litter/mistParticles/grit  Atmospherics
 *   drops/shimmer                    LensOverlay
 *   whiteBalance/saturation/contrast/gainTint   ctx.pipeline.grade
 *   lightning                        strikes per minute
 *
 * `visibility` is documentation, not a uniform: roughly the metre distance at which a
 * dark target washes out, so the numbers above can be sanity-checked against it.
 */

/** Linear-RGB triples. Fog colours are in render units, not sRGB. */
const CLEAR_FOG = [0.44, 0.56, 0.72];
const STORM_FOG = [0.26, 0.30, 0.36];
const DUST_FOG = [0.72, 0.44, 0.20];

/**
 * @typedef {Record<string, number|number[]>} PresetRecord
 */

/** @type {Record<string, PresetRecord>} */
export const PRESETS = {
  clear: {
    visibility: 900,
    coverage: 0.1,
    cloudType: 0.18,
    cirrus: 0.3,
    haze: 0.95,
    sunScale: 1.0,
    fogDensity: 1.0,
    fogStrength: 1.0,
    fogHeight: 900,
    volHeightFalloff: 0.055,
    mistDensity: 0.0006,
    mistTop: 14.0,
    mistScale: 0.012,
    volDensity: 0.0022,
    volAniso: 0.7,
    volFogColor: CLEAR_FOG,
    wetness: 0.0,
    dust: 0.06,
    windSpeed: 1.6,
    windDir: 0.6,
    gust: 0.25,
    rain: 0.0,
    rainSpeed: 8.0,
    rainTint: [0.62, 0.70, 0.86],
    motes: 0.55,
    moteSize: 0.020,
    litter: 0.3,
    mistParticles: 0.0,
    grit: 0.0,
    drops: 0.0,
    dropRun: 0.0,
    shimmer: 0.5,
    whiteBalance: [1.0, 0.998, 0.995],
    saturation: 1.03,
    contrast: 1.05,
    gainTint: [1.005, 1.0, 0.994],
    lightning: 0,
  },

  hazy: {
    visibility: 420,
    coverage: 0.24,
    cloudType: 0.24,
    cirrus: 0.5,
    haze: 2.6,
    sunScale: 0.86,
    fogDensity: 2.3,
    fogStrength: 1.05,
    fogHeight: 520,
    volHeightFalloff: 0.062,
    mistDensity: 0.0035,
    mistTop: 20.0,
    mistScale: 0.014,
    volDensity: 0.0052,
    volAniso: 0.74,
    volFogColor: [0.52, 0.55, 0.62],
    wetness: 0.0,
    dust: 0.22,
    windSpeed: 1.1,
    windDir: 0.4,
    gust: 0.16,
    rain: 0.0,
    rainSpeed: 8.0,
    rainTint: [0.62, 0.70, 0.86],
    motes: 1.0,
    moteSize: 0.024,
    litter: 0.25,
    mistParticles: 0.15,
    grit: 0.06,
    drops: 0.0,
    dropRun: 0.0,
    shimmer: 0.85,
    whiteBalance: [1.02, 0.997, 0.972],
    saturation: 0.97,
    contrast: 1.02,
    gainTint: [1.02, 1.0, 0.972],
    lightning: 0,
  },

  overcast: {
    visibility: 520,
    coverage: 0.95,
    cloudType: 0.42,
    cirrus: 0.08,
    haze: 1.7,
    sunScale: 0.42,
    fogDensity: 1.9,
    fogStrength: 1.0,
    fogHeight: 600,
    volHeightFalloff: 0.05,
    mistDensity: 0.0022,
    mistTop: 22.0,
    mistScale: 0.012,
    volDensity: 0.0044,
    volAniso: 0.5,
    volFogColor: [0.40, 0.44, 0.50],
    wetness: 0.05,
    dust: 0.05,
    windSpeed: 2.6,
    windDir: 1.1,
    gust: 0.4,
    rain: 0.0,
    rainSpeed: 8.0,
    rainTint: [0.58, 0.64, 0.76],
    motes: 0.15,
    moteSize: 0.020,
    litter: 0.45,
    mistParticles: 0.2,
    grit: 0.0,
    drops: 0.0,
    dropRun: 0.0,
    shimmer: 0.0,
    whiteBalance: [0.985, 0.995, 1.02],
    saturation: 0.9,
    contrast: 1.01,
    gainTint: [0.98, 0.99, 1.02],
    lightning: 0,
  },

  rain: {
    visibility: 260,
    coverage: 0.9,
    cloudType: 0.55,
    cirrus: 0.0,
    haze: 2.1,
    sunScale: 0.32,
    fogDensity: 2.8,
    fogStrength: 1.05,
    fogHeight: 380,
    volHeightFalloff: 0.05,
    mistDensity: 0.005,
    mistTop: 20.0,
    mistScale: 0.016,
    volDensity: 0.0075,
    volAniso: 0.42,
    volFogColor: [0.34, 0.38, 0.45],
    wetness: 0.72,
    dust: 0.0,
    windSpeed: 3.4,
    windDir: 1.25,
    gust: 0.55,
    rain: 0.38,
    rainSpeed: 8.5,
    rainTint: [0.56, 0.64, 0.80],
    motes: 0.0,
    moteSize: 0.018,
    litter: 0.12,
    mistParticles: 0.35,
    grit: 0.0,
    drops: 0.42,
    dropRun: 0.55,
    shimmer: 0.0,
    whiteBalance: [0.975, 0.992, 1.03],
    saturation: 0.88,
    contrast: 1.03,
    gainTint: [0.965, 0.985, 1.03],
    lightning: 0,
  },

  storm: {
    visibility: 130,
    coverage: 1.0,
    cloudType: 0.86,
    cirrus: 0.0,
    haze: 2.6,
    sunScale: 0.17,
    fogDensity: 4.4,
    fogStrength: 1.1,
    fogHeight: 260,
    volHeightFalloff: 0.05,
    mistDensity: 0.011,
    mistTop: 24.0,
    mistScale: 0.02,
    volDensity: 0.0135,
    volAniso: 0.35,
    volFogColor: STORM_FOG,
    wetness: 1.0,
    dust: 0.0,
    windSpeed: 9.5,
    windDir: 1.45,
    gust: 1.0,
    rain: 1.0,
    rainSpeed: 11.5,
    rainTint: [0.52, 0.60, 0.78],
    motes: 0.0,
    moteSize: 0.018,
    litter: 0.7,
    mistParticles: 0.5,
    grit: 0.05,
    drops: 1.0,
    dropRun: 1.0,
    shimmer: 0.0,
    whiteBalance: [0.96, 0.988, 1.045],
    saturation: 0.8,
    contrast: 1.07,
    gainTint: [0.94, 0.975, 1.05],
    lightning: 7.5,
  },

  dust: {
    visibility: 55,
    coverage: 0.42,
    cloudType: 0.3,
    cirrus: 0.0,
    haze: 5.6,
    sunScale: 0.2,
    fogDensity: 7.5,
    fogStrength: 1.15,
    fogHeight: 110,
    volHeightFalloff: 0.022,
    mistDensity: 0.055,
    mistTop: 46.0,
    mistScale: 0.025,
    volDensity: 0.026,
    volAniso: 0.62,
    volFogColor: DUST_FOG,
    wetness: 0.0,
    dust: 1.0,
    windSpeed: 12.0,
    windDir: 2.1,
    gust: 0.9,
    rain: 0.0,
    rainSpeed: 8.0,
    rainTint: [0.7, 0.5, 0.3],
    motes: 0.0,
    moteSize: 0.030,
    litter: 1.0,
    mistParticles: 0.25,
    grit: 1.0,
    drops: 0.0,
    dropRun: 0.0,
    shimmer: 0.3,
    whiteBalance: [1.16, 0.97, 0.79],
    saturation: 0.72,
    contrast: 0.97,
    gainTint: [1.20, 0.97, 0.72],
    lightning: 0,
  },

  fog: {
    visibility: 42,
    coverage: 0.6,
    cloudType: 0.3,
    cirrus: 0.0,
    haze: 3.4,
    sunScale: 0.3,
    fogDensity: 6.0,
    fogStrength: 1.1,
    fogHeight: 64,
    volHeightFalloff: 0.035,
    mistDensity: 0.07,
    mistTop: 30.0,
    mistScale: 0.03,
    volDensity: 0.030,
    volAniso: 0.28,
    volFogColor: [0.60, 0.63, 0.68],
    wetness: 0.34,
    dust: 0.0,
    windSpeed: 0.7,
    windDir: 0.2,
    gust: 0.1,
    rain: 0.0,
    rainSpeed: 8.0,
    rainTint: [0.66, 0.70, 0.78],
    motes: 0.35,
    moteSize: 0.026,
    litter: 0.06,
    mistParticles: 1.0,
    grit: 0.0,
    drops: 0.06,
    dropRun: 0.1,
    shimmer: 0.0,
    whiteBalance: [0.995, 1.0, 1.008],
    saturation: 0.74,
    contrast: 0.96,
    gainTint: [0.99, 1.0, 1.01],
    lightning: 0,
  },
};

/** Spellings the API accepts, so `setPreset('light rain')` does the obvious thing. */
export const ALIASES = {
  sunny: 'clear',
  clearsky: 'clear',
  haze: 'hazy',
  smog: 'hazy',
  cloudy: 'overcast',
  grey: 'overcast',
  gray: 'overcast',
  lightrain: 'rain',
  drizzle: 'rain',
  rainy: 'rain',
  showers: 'rain',
  thunderstorm: 'storm',
  thunder: 'storm',
  heavyrain: 'storm',
  duststorm: 'dust',
  sandstorm: 'dust',
  haboob: 'dust',
  foggy: 'fog',
  mist: 'fog',
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** @param {string} name @returns {string|null} canonical key */
export function resolvePreset(name) {
  if (typeof name !== 'string') return null;
  const k = name.toLowerCase().replace(/[\s_-]/g, '');
  if (PRESETS[k]) return k;
  if (ALIASES[k] && PRESETS[ALIASES[k]]) return ALIASES[k];
  return null;
}

/** A mutable copy of a preset, used for the live state and the fade endpoints. */
export function cloneRecord(src) {
  const out = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    out[k] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

/** `out = a + (b - a) * t`, in place, component-wise, arrays included. */
export function lerpRecord(out, a, b, t) {
  for (const k of Object.keys(b)) {
    const bv = b[k];
    const av = a[k];
    if (Array.isArray(bv)) {
      const o = Array.isArray(out[k]) ? out[k] : (out[k] = bv.slice());
      const src = Array.isArray(av) ? av : bv;
      for (let i = 0; i < bv.length; i++) o[i] = src[i] + (bv[i] - src[i]) * t;
    } else if (typeof bv === 'number') {
      const src = typeof av === 'number' ? av : bv;
      out[k] = src + (bv - src) * t;
    } else {
      out[k] = bv;
    }
  }
  return out;
}

/** Angles must take the short way round or the wind spins through north. */
export function lerpAngle(a, b, t) {
  const TAU = Math.PI * 2;
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export default PRESETS;
