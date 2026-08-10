/**
 * Sky — physically based atmosphere, volumetric clouds, celestial bodies, aerial
 * perspective. Owner: sky agent. Files owned: this file + src/render/shaders/**.
 * Publishes: `ctx.sky`.
 *
 * ── What runs where ─────────────────────────────────────────────────────────────
 *   transmittance LUT   256x64   once, sun independent
 *   multiple-scatter LUT 32x32   regenerated when the sun moves > ~0.6 deg
 *   sky-view LUT        200x112  regenerated when the sun moves > ~0.12 deg
 *   cloud buffer        quarter res, every frame, temporally reprojected
 *   environment cube    64px + PMREM, regenerated with the multi-scatter LUT
 *   sky dome            full res, one draw, pinned to the far plane (.xyww)
 *
 * Scattering is Rayleigh + Mie + **ozone** (Hillaire 2020). Ozone is why the blue
 * hour is blue instead of brown. Clouds are a Perlin-Worley raymarch with a cone
 * shadow march, Henyey-Greenstein dual lobe, the powder term and a three-octave
 * multiple-scattering approximation. A second cirrus shell scrolls above them.
 *
 * ── Public API (ctx.sky) ────────────────────────────────────────────────────────
 *   setTimeOfDay(hours)            0..24, drives absolutely everything
 *   timeOfDay                      number
 *   sunDirection    Vector3        world-space direction *to* the sun (normalised)
 *   moonDirection   Vector3
 *   sunColor        Color          linear, peak-normalised
 *   sunIntensity    number         ready for THREE.DirectionalLight.intensity
 *   moonColor / moonIntensity
 *   keyDirection / keyColor / keyIntensity   whichever of sun/moon is dominant
 *   sunAltitude     number         radians above the horizon
 *   skyLuminance    number         mean sky radiance in render units
 *   adaptation      number         eye-adaptation multiplier currently applied
 *   physLuminance   number         un-adapted sky radiance (Hillaire units)
 *   zenithColor / horizonColor / groundColor / fogColor   Color
 *   ambientColor    Color          hemisphere-averaged sky, for a fallback ambient
 *   nightSkyColor   Color          airglow + light-pollution radiance floor the dome
 *                                  adds after dusk and `sampleSky` does not know about
 *   cloudCoverage   number         0..1, current deck cover
 *   starVisibility  number         0..1
 *   envTexture      Texture        PMREM cube-uv, assign straight to scene.environment
 *   envCubeTexture  CubeTexture    raw radiance cube (pre-PMREM)
 *   sampleSky(dir)  -> Color       CPU evaluation of the same scattering model
 *   applyAerialPerspective(material)  inject matching fog into any three material
 *   aerialUniforms  {}             the shared uniform objects that chunk needs
 *   aerialGLSL      {parsVertex, vertexBody, parsFragment, applyFragment}
 *   setCloudCoverage(x) / setCloudType(x) / setWind(x, z) / setHaze(k)
 *   setCirrus(x) / setStarBrightness(x) / setExposureScale(k)
 *   onEnvUpdate(fn) -> unsubscribe
 *
 * ── Events ──────────────────────────────────────────────────────────────────────
 *   emits `sky:timeOfDay` {hours, sunDirection, sunColor, sunIntensity, night}
 *   emits `sky:env`       {texture, cubeTexture}
 *   listens `debug:pose` {time|timeOfDay}, `sky:setTimeOfDay`, `quality:changed`,
 *           `weather:changed` {coverage, wind, haze, cirrus}
 *
 * If render/Lighting.js has not published a `setTimeOfDay`, this module installs a
 * shim on `ctx.lighting` so the screenshot harness (which calls
 * `ctx.lighting.setTimeOfDay(pose.time)`) still drives the sky. It never overwrites
 * a real implementation.
 */
import * as THREE from 'three';
import {
  FULLSCREEN_VERT,
  TRANSMITTANCE_FRAG,
  MULTISCATTER_FRAG,
  SKYVIEW_FRAG,
  CLOUD_FRAG,
  SKY_VERT,
  SKY_FRAG,
  AERIAL_PARS_VERT,
  AERIAL_VERT_BODY,
  AERIAL_PARS_FRAG,
  AERIAL_APPLY_FRAG,
} from './shaders/sky.js';

const DEG = Math.PI / 180;
const GROUND_R = 6.36; // Mm
const TOP_R = 6.46;
const BETA_R = [5.802, 13.558, 33.1];
const MIE_S = 3.996;
const MIE_A = 4.4;
const OZONE_A = [0.65, 1.881, 0.085];

/** Angular *radius*: the sun and moon are both ~0.53 degrees across. */
const SUN_ANG_RADIUS = 0.53 * 0.5 * DEG;
const MOON_ANG_RADIUS = 0.52 * 0.5 * DEG;

/**
 * Render units per unit of solar irradiance. The scattering integral is normalised
 * to a solar irradiance of 1, so *the same* factor has to scale both the sun's light
 * intensity and the sky's radiance or the two stop agreeing: too high and the sky
 * outruns sunlit geometry and AgX bleaches it to cream, too low and midday reads as
 * an overcast afternoon. 13 puts a clear noon zenith near 0.35 and a sunlit white
 * surface near 2.8 — the ratio a light meter actually measures.
 */
const IRRADIANCE_SCALE = 13.0;

/* ════════════════════════════════════════════════════════════ solar / lunar ══ */

const SITE_LAT = 34 * DEG;
const SUN_DEC = 8 * DEG;
/**
 * **The moon is staged, like the sun.** Its declination and elongation are the two
 * free parameters a date gives you, and the previous pair put it at compass azimuth
 * 173 deg and 51 deg altitude at the 21.5 night pose — behind the camera and near the
 * zenith, so the review's night frame contained no moon at all, and the only
 * directional light in it arrived from a source nobody could see.
 *
 * Solved instead for the frame: at 21.5 the sun's hour angle is 115.5 deg, so an
 * elongation of 189.5 deg puts the moon at H = -74 deg, and a 20 deg declination at
 * this latitude then places it at compass 81 deg / 24 deg altitude — which after
 * `SITE_AZIMUTH` is bearing 23 deg, up and to the right of the night camera, clear of
 * the Ochre Row roofline and three-quarters front to the street so its shadows fall
 * back toward the lens. The elongation is also, not coincidentally, a full moon: a
 * moon that rises around sunset *is* full, so the brightest, most photogenic phase is
 * the astronomically correct one for a shot taken two hours after dusk.
 */
const MOON_DEC = 20 * DEG;
const MOON_ELONGATION = 189.5 * DEG; // full moon, risen in the east after sunset
const SOLAR_NOON = 12.75;

/**
 * **Which way the map faces.** The solar path below is a real one; this rotates the
 * compass under it, which is the one free parameter a location gives you and the only
 * honest way to aim a low sun at a street that was laid out on the world axes.
 *
 * It matters far more than it sounds. The playable street is a canyon running along
 * Z between two blocks — Blue Shophouses at x = -20..-2 and Ochre Row at x = 14..29 —
 * 16 m apart and 8 m tall. A sun that sits *across* that canyon has to reach
 * atan(8.1 / 16) = 27 deg before a single square metre of carriageway sees it, and
 * 27 deg is not golden hour, it is mid-morning. Un-rotated, the 7.4 key came up at
 * azimuth 91 deg — due east, exactly broadside — so at its 15.8 deg altitude the
 * entire street, every prop in it and both facades below 3.6 m were in full shadow.
 * The cascades were correct and empty, the only light left was blue sky IBL, and the
 * "golden hour" hero frame measured R/B 0.52 on the ground: bluer than the sky.
 *
 * Rotating the site by -58 deg puts the 7.4 sun at azimuth ~33 deg. Measured against
 * the real colliders (raycasts from 23 camera-visible ground points and 72 facade
 * points): sunlit ground goes 0.0 -> 0.44 and lit facade area 0.31 -> 0.50, with
 * N.L on the east-facing shophouse wall — the big receding plane down the left of
 * the hero frame — rising from 0.02 to 0.48. The sun still sets behind Ochre Row so
 * the disc never enters frame, and the market-hall arcade it shafts through faces
 * +X, so the interior pose keeps its shafts (its lit floor fraction goes 0.21 -> 0.26)
 * and simply gets them on a more raking angle.
 */
const SITE_AZIMUTH = -58 * DEG;
const SITE_COS = Math.cos(SITE_AZIMUTH);
const SITE_SIN = Math.sin(SITE_AZIMUTH);

/**
 * Cinematic time warp. The sun still travels a real spherical path (so azimuth and
 * altitude stay consistent), but clock time is remapped so the review poses land on
 * the light they were art-directed for: 5.5 blue hour, 6.6 low morning, 7.4 golden
 * hour, 8.2 mid morning, 12 harsh noon, 19.5 the moment of sunset, 21.5 full night.
 *
 * **The morning keys are set by the level's own skyline, not by an almanac.** The map
 * sits inside a backdrop ring of 20–23 m facades about 92 m out, and every block in
 * between is 7–12 m tall. A receiver at eye height only sees the sun once
 *   tan(altitude) > (occluder height - eye height) / distance,
 * which for the 22.9 m ring works out at ~12.4 deg and for the nearest souk block at
 * ~13.3 deg. Anything below that and the *entire* playable street is in shadow: the
 * cascades are correct, there is simply no direct light in the level, the frame falls
 * back to sky-only IBL (which is blue), auto-exposure rails at its gain ceiling and
 * the whole image reads as a cold, underexposed night. 7.4 therefore maps to a
 * ~15.7 deg sun — high enough to clear the skyline by a comfortable margin, still low
 * enough that the air mass keeps the key warm and the shadows long.
 *
 * Altitude alone is not sufficient, though: clearance also depends on the *bearing*
 * the light arrives on, because the near occluders are two long walls, not a ring.
 * That half of the problem is solved by `SITE_AZIMUTH` above; do not tune one without
 * checking the other.
 *
 * **Altitude is bounded from below by the canyon, and the bound is hard.** Raycasting
 * the real colliders from 23 camera-visible ground points in the hero frame, with the
 * key already aimed down the street at azimuth 31, the sunlit fraction of that ground
 * measures 0.44 at 16 deg, 0.26 at 12 deg and 0.09 at 8 deg. A 6 deg sun — the
 * textbook golden-hour altitude, 9.5x shadows — lights essentially none of the
 * playable floor on this map, and an unlit floor is the defect we are fixing, not a
 * stylistic preference. 7.4 therefore sits at 15.4 deg, where the street is lit and
 * shadows still run 3.6x their casters' height.
 *
 * The colour that altitude *cannot* buy is bought separately and cheaply: the disc's
 * own transmittance at 15 deg is about 4900 K, a good 1400 K cooler than a camera
 * records at golden hour, so Lighting.js grades the key toward ~3300 K on an
 * altitude-driven curve (see `_syncFromSky`). A warm key over an honest sun reads
 * correct; an honest key over an unlit street does not. Per-pose overrides for both
 * live on `ctx.lighting.setSunStaging({ altitude, kelvin })`.
 */
const WARP_X = [0, 5.5, 6.6, 7.4, 8.2, 12, 19.5, 21.5, 24];
const WARP_Y = [0, 5.94, 7.16, 7.62, 7.97, 12.4, 19.11, 20.45, 24];

/** Monotone cubic (Fritsch-Carlson) — smooth, and never folds the clock backwards. */
function buildPchip(xs, ys) {
  const n = xs.length;
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * (xs[i + 1] - xs[i]) + (xs[i] - xs[i - 1]);
      const w2 = xs[i + 1] - xs[i] + 2 * (xs[i] - xs[i - 1]);
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0] + (x - xs[0]) * m[0];
    if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]) * m[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      ys[i] * (2 * t3 - 3 * t2 + 1) +
      m[i] * h * (t3 - 2 * t2 + t) +
      ys[i + 1] * (-2 * t3 + 3 * t2) +
      m[i + 1] * h * (t3 - t2)
    );
  };
}
const warpHours = buildPchip(WARP_X, WARP_Y);

/**
 * Horizontal direction for an equatorial (declination, hour-angle) pair. Y up, and
 * true north lies along -Z *rotated by `SITE_AZIMUTH`* — the map is not axis-aligned
 * with the compass, see the constant. Altitude is untouched by the rotation, so the
 * whole scattering model (which only ever sees `sunDirection.y` and angles to the
 * sun) is unaffected.
 */
function horizonDirection(dec, hourAngle, out) {
  const sd = Math.sin(dec);
  const cd = Math.cos(dec);
  const sl = Math.sin(SITE_LAT);
  const cl = Math.cos(SITE_LAT);
  const ch = Math.cos(hourAngle);
  const east = -cd * Math.sin(hourAngle);
  const north = sd * cl - cd * sl * ch;
  const up = sd * sl + cd * cl * ch;
  // Rotation about +Y that adds SITE_AZIMUTH to the compass azimuth.
  return out
    .set(east * SITE_COS + north * SITE_SIN, up, -north * SITE_COS + east * SITE_SIN)
    .normalize();
}

/* ═════════════════════════════════════════════════ CPU copy of the atmosphere ══ */

function densityAt(altKm, out) {
  const rd = Math.exp(-altKm / 8);
  const md = Math.exp(-altKm / 1.2);
  const oz = Math.max(0, 1 - Math.abs(altKm - 25) / 15);
  out[0] = BETA_R[0] * rd + MIE_S * md + MIE_A * md + OZONE_A[0] * oz;
  out[1] = BETA_R[1] * rd + MIE_S * md + MIE_A * md + OZONE_A[1] * oz;
  out[2] = BETA_R[2] * rd + MIE_S * md + MIE_A * md + OZONE_A[2] * oz;
  return rd;
}

/** Nearest positive hit of a ray from (0,h,0) with a sphere of radius `rad`. */
function raySphereY(h, dy, dz, rad) {
  const b = h * dy;
  const c = h * h - rad * rad;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sd = Math.sqrt(disc);
  if (sd > Math.abs(b)) return -b + sd;
  return -b - sd;
}

const _tmpExt = [0, 0, 0];

/** Transmittance from height `h` (Mm) toward a direction with vertical cosine `cy`. */
function cpuTransmittance(h, cy, out) {
  const dy = cy;
  const dz = -Math.sqrt(Math.max(0, 1 - cy * cy));
  if (raySphereY(h, dy, dz, GROUND_R) > 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const tMax = raySphereY(h, dy, dz, TOP_R);
  if (!(tMax > 0)) {
    out[0] = out[1] = out[2] = 1;
    return out;
  }
  const steps = 24;
  let t = 0;
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < steps; i++) {
    const nt = ((i + 0.3) / steps) * tMax;
    const dt = nt - t;
    t = nt;
    const py = h + dy * t;
    const pz = dz * t;
    const r = Math.sqrt(py * py + pz * pz);
    densityAt((r - GROUND_R) * 1000, _tmpExt);
    a += dt * _tmpExt[0];
    b += dt * _tmpExt[1];
    c += dt * _tmpExt[2];
  }
  out[0] = Math.exp(-a);
  out[1] = Math.exp(-b);
  out[2] = Math.exp(-c);
  return out;
}

const _trA = [0, 0, 0];
const _trB = [0, 0, 0];

/**
 * Single-scattering radiance along a view direction. Coarser than the GPU LUT (no
 * multiple scattering) but the same physics, so CPU-derived colours agree with the
 * rendered sky to within a few percent outside of deep twilight.
 */
function cpuSkyRadiance(dirY, dirZ, sunY, cosLight, viewH, out) {
  const tMaxGround = raySphereY(viewH, dirY, dirZ, GROUND_R);
  const tMaxTop = raySphereY(viewH, dirY, dirZ, TOP_R);
  const tMax = tMaxGround > 0 ? tMaxGround : tMaxTop;
  if (!(tMax > 0)) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const rayPhase = (3 / (16 * Math.PI)) * (1 + cosLight * cosLight);
  const g = 0.8;
  const dd = Math.max(1 + g * g - 2 * g * cosLight, 1e-4);
  const miePhase = ((1 - g * g) / (4 * Math.PI * dd * Math.sqrt(dd)));
  const steps = 14;
  let t = 0;
  const trans = [1, 1, 1];
  out[0] = out[1] = out[2] = 0;
  for (let i = 0; i < steps; i++) {
    const nt = ((i + 0.3) / steps) * tMax;
    const dt = nt - t;
    t = nt;
    const py = viewH + dirY * t;
    const pz = dirZ * t;
    const r = Math.sqrt(py * py + pz * pz);
    const altKm = (r - GROUND_R) * 1000;
    const rd = Math.exp(-altKm / 8);
    const md = Math.exp(-altKm / 1.2);
    densityAt(altKm, _tmpExt);
    // Snapshot: cpuTransmittance() reuses the same scratch array.
    const e0 = _tmpExt[0];
    const e1 = _tmpExt[1];
    const e2 = _tmpExt[2];
    // Local up at the sample; the sun cosine changes along a long twilight ray.
    const localCos = (py * sunY + pz * -Math.sqrt(Math.max(0, 1 - sunY * sunY))) / Math.max(r, 1e-6);
    cpuTransmittance(r, Math.max(localCos, -1), _trA);
    for (let ch = 0; ch < 3; ch++) {
      const rs = BETA_R[ch] * rd;
      const ms = MIE_S * md;
      const ext = Math.max(ch === 0 ? e0 : ch === 1 ? e1 : e2, 1e-6);
      const st = Math.exp(-dt * ext);
      const inScat = (rs * rayPhase + ms * miePhase) * _trA[ch];
      out[ch] += ((inScat - inScat * st) / ext) * trans[ch];
      trans[ch] *= st;
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════ noise fields ══ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// prettier-ignore
const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

function ihash3(x, y, z, seed) {
  let h =
    (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) + Math.imul(seed, 2654435761)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
function fadeC(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function gdot(ix, iy, iz, dx, dy, dz, period, seed) {
  const gx = ((ix % period) + period) % period;
  const gy = ((iy % period) + period) % period;
  const gz = ((iz % period) + period) % period;
  const g = (ihash3(gx, gy, gz, seed) % 12) * 3;
  return GRAD3[g] * dx + GRAD3[g + 1] * dy + GRAD3[g + 2] * dz;
}
/** Tileable Perlin noise; the lattice wraps at `period`. Returns roughly [-1, 1]. */
function perlin3(x, y, z, period, seed) {
  const X = Math.floor(x);
  const Y = Math.floor(y);
  const Z = Math.floor(z);
  const fx = x - X;
  const fy = y - Y;
  const fz = z - Z;
  const u = fadeC(fx);
  const v = fadeC(fy);
  const w = fadeC(fz);
  const n000 = gdot(X, Y, Z, fx, fy, fz, period, seed);
  const n100 = gdot(X + 1, Y, Z, fx - 1, fy, fz, period, seed);
  const n010 = gdot(X, Y + 1, Z, fx, fy - 1, fz, period, seed);
  const n110 = gdot(X + 1, Y + 1, Z, fx - 1, fy - 1, fz, period, seed);
  const n001 = gdot(X, Y, Z + 1, fx, fy, fz - 1, period, seed);
  const n101 = gdot(X + 1, Y, Z + 1, fx - 1, fy, fz - 1, period, seed);
  const n011 = gdot(X, Y + 1, Z + 1, fx, fy - 1, fz - 1, period, seed);
  const n111 = gdot(X + 1, Y + 1, Z + 1, fx - 1, fy - 1, fz - 1, period, seed);
  const x00 = n000 + u * (n100 - n000);
  const x10 = n010 + u * (n110 - n010);
  const x01 = n001 + u * (n101 - n001);
  const x11 = n011 + u * (n111 - n011);
  const y0 = x00 + v * (x10 - x00);
  const y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

function worleyPoints(period, rand) {
  const p = new Float32Array(period * period * period * 3);
  for (let i = 0; i < p.length; i++) p[i] = rand();
  return p;
}
/** Tileable Worley (F1) distance in cell units. */
function worley3(pts, period, x, y, z) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const cz = Math.floor(z);
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz++) {
    const wz = (((cz + dz) % period) + period) % period;
    for (let dy = -1; dy <= 1; dy++) {
      const wy = (((cy + dy) % period) + period) % period;
      const row = (wz * period + wy) * period;
      for (let dx = -1; dx <= 1; dx++) {
        const wx = (((cx + dx) % period) + period) % period;
        const idx = (row + wx) * 3;
        const ex = x - (cx + dx + pts[idx]);
        const ey = y - (cy + dy + pts[idx + 1]);
        const ez = z - (cz + dz + pts[idx + 2]);
        const d = ex * ex + ey * ey + ez * ez;
        if (d < best) best = d;
      }
    }
  }
  return Math.sqrt(best);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const remap = (v, il, ih, ol, oh) => ol + ((v - il) * (oh - ol)) / Math.max(ih - il, 1e-5);

/**
 * Base cloud shape volume. R is Perlin-Worley (the cauliflower), GBA are Worley fbm
 * octaves the shader uses to erode it.
 */
function buildShapeVolume(size, rand) {
  const data = new Uint8Array(size * size * size * 4);
  const seed = (rand() * 0x7fffffff) | 0;
  const p3 = worleyPoints(3, rand);
  const p6 = worleyPoints(6, rand);
  const p12 = worleyPoints(12, rand);
  let i = 0;
  for (let z = 0; z < size; z++) {
    const fz = z / size;
    for (let y = 0; y < size; y++) {
      const fy = y / size;
      for (let x = 0; x < size; x++) {
        const fx = x / size;
        let pf = 0;
        let amp = 0.55;
        let per = 3;
        for (let o = 0; o < 4; o++) {
          pf += amp * perlin3(fx * per, fy * per, fz * per, per, seed + o * 71);
          per *= 2;
          amp *= 0.5;
        }
        pf = clamp01(pf * 0.72 + 0.5);

        const w3 = clamp01(1 - worley3(p3, 3, fx * 3, fy * 3, fz * 3));
        const w6 = clamp01(1 - worley3(p6, 6, fx * 6, fy * 6, fz * 6));
        const w12 = clamp01(1 - worley3(p12, 12, fx * 12, fy * 12, fz * 12));

        const wLow = clamp01(w3 * 0.625 + w6 * 0.25 + w12 * 0.125);
        const wMid = clamp01(w6 * 0.625 + w12 * 0.25 + w3 * 0.125);
        const wHigh = clamp01(w12 * 0.7 + w6 * 0.3);

        const pw = clamp01(remap(pf, wLow - 1, 1, 0, 1));
        data[i++] = pw * 255;
        data[i++] = wLow * 255;
        data[i++] = wMid * 255;
        data[i++] = wHigh * 255;
      }
    }
  }
  return data;
}

/** High-frequency erosion volume. */
function buildDetailVolume(size, rand) {
  const data = new Uint8Array(size * size * size * 4);
  const p2 = worleyPoints(2, rand);
  const p4 = worleyPoints(4, rand);
  const p8 = worleyPoints(8, rand);
  let i = 0;
  for (let z = 0; z < size; z++) {
    const fz = z / size;
    for (let y = 0; y < size; y++) {
      const fy = y / size;
      for (let x = 0; x < size; x++) {
        const fx = x / size;
        const w2 = clamp01(1 - worley3(p2, 2, fx * 2, fy * 2, fz * 2));
        const w4 = clamp01(1 - worley3(p4, 4, fx * 4, fy * 4, fz * 4));
        const w8 = clamp01(1 - worley3(p8, 8, fx * 8, fy * 8, fz * 8));
        data[i++] = clamp01(w2 * 0.625 + w4 * 0.25 + w8 * 0.125) * 255;
        data[i++] = clamp01(w4 * 0.7 + w8 * 0.3) * 255;
        data[i++] = w8 * 255;
        data[i++] = 255;
      }
    }
  }
  return data;
}

function perlin2(x, y, period, seed) {
  return perlin3(x, y, 0.5, period, seed);
}

/** Weather map: R coverage, G cloud type, B large-scale mass. */
function buildWeatherMap(size, rand) {
  const data = new Uint8Array(size * size * 4);
  const s0 = (rand() * 0x7fffffff) | 0;
  const s1 = (rand() * 0x7fffffff) | 0;
  const s2 = (rand() * 0x7fffffff) | 0;
  let i = 0;
  for (let y = 0; y < size; y++) {
    const fy = y / size;
    for (let x = 0; x < size; x++) {
      const fx = x / size;
      let cov = 0;
      let amp = 0.58;
      let per = 3;
      for (let o = 0; o < 5; o++) {
        cov += amp * perlin2(fx * per, fy * per, per, s0 + o * 37);
        per *= 2;
        amp *= 0.5;
      }
      cov = clamp01(cov * 1.05 + 0.5);
      cov = clamp01(remap(cov, 0.24, 0.86, 0, 1));

      let typ = 0;
      amp = 0.6;
      per = 2;
      for (let o = 0; o < 3; o++) {
        typ += amp * perlin2(fx * per + 3.7, fy * per - 1.9, per, s1 + o * 53);
        per *= 2;
        amp *= 0.5;
      }
      typ = clamp01(typ * 1.1 + 0.5);

      const mass = clamp01(perlin2(fx * 2, fy * 2, 2, s2) * 0.9 + 0.55);

      data[i++] = cov * 255;
      data[i++] = typ * 255;
      data[i++] = mass * 255;
      data[i++] = 255;
    }
  }
  return data;
}

/**
 * Milky Way, baked into an equirect map. Three fBm octaves per texel would be far
 * too expensive per pixel at night, and the band is smooth enough that a 256x128
 * map is indistinguishable from evaluating it live. `u` wraps, so no seam.
 */
function buildGalaxyMap(w, h, rand) {
  const data = new Uint8Array(w * h * 4);
  const s0 = (rand() * 0x7fffffff) | 0;
  const s1 = (rand() * 0x7fffffff) | 0;
  const s2 = (rand() * 0x7fffffff) | 0;
  // Galactic pole, tilted so the band cuts the sky at a believable angle.
  const gx = 0.5203;
  const gy = 0.6603;
  const gz = -0.5417;
  // Direction of the galactic centre, which is brighter and warmer.
  const cx = -0.62;
  const cy = -0.28;
  const cz = -0.73;
  const fbm = (x, y, z, seed, oct) => {
    let v = 0;
    let a = 0.5;
    let f = 1;
    for (let o = 0; o < oct; o++) {
      v += a * perlin3(x * f + o * 7.3, y * f - o * 3.1, z * f + o * 11.7, 64, seed + o * 91);
      f *= 2.04;
      a *= 0.5;
    }
    return clamp01(v * 1.15 + 0.5);
  };
  let i = 0;
  for (let y = 0; y < h; y++) {
    const theta = ((y + 0.5) / h) * Math.PI;
    const st = Math.sin(theta);
    const dy = Math.cos(theta);
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w - 0.5) * Math.PI * 2;
      const dx = Math.cos(phi) * st;
      const dz = Math.sin(phi) * st;
      const b = dx * gx + dy * gy + dz * gz;
      let band = Math.exp(-b * b * 34);
      if (band < 0.002) {
        i += 4;
        continue;
      }
      const clump = fbm(dx * 6.5, dy * 6.5, dz * 6.5, s0, 4);
      const dust = fbm(dx * 13, dy * 13, dz * 13, s1, 3);
      const fine = fbm(dx * 26, dy * 26, dz * 26, s2, 2);
      const lane = clamp01(1 - 1.45 * dust);
      // The core bulge is denser and redder than the outer arms.
      const core = Math.max(0, dx * cx + dy * cy + dz * cz);
      const bulge = Math.pow(core, 7) * 0.85;
      const v = clamp01(band * (0.18 + 0.95 * clump) * lane * (0.45 + 0.55 * fine) + bulge * band);
      const warm = clamp01(bulge * 1.4 + dust * 0.25);
      data[i++] = clamp01(v * (0.82 + 0.4 * warm)) * 255;
      data[i++] = clamp01(v * 0.93) * 255;
      data[i++] = clamp01(v * (1.0 - 0.25 * warm)) * 255;
      data[i++] = 255;
    }
  }
  return data;
}

/** Cirrus: fibrous, wind-stretched fbm. */
function buildCirrusMap(size, rand) {
  const data = new Uint8Array(size * size * 4);
  const s0 = (rand() * 0x7fffffff) | 0;
  const s1 = (rand() * 0x7fffffff) | 0;
  let i = 0;
  for (let y = 0; y < size; y++) {
    const fy = y / size;
    for (let x = 0; x < size; x++) {
      const fx = x / size;
      // Strong anisotropy: cirrus streaks along the jetstream.
      let a = 0;
      let amp = 0.6;
      let per = 2;
      for (let o = 0; o < 5; o++) {
        a += amp * perlin2(fx * per, fy * per * 5, per, s0 + o * 29);
        per *= 2;
        amp *= 0.5;
      }
      a = clamp01(a * 1.1 + 0.5);
      let b = 0;
      amp = 0.6;
      per = 4;
      for (let o = 0; o < 4; o++) {
        b += amp * perlin2(fx * per + 5.3, fy * per * 3.5, per, s1 + o * 17);
        per *= 2;
        amp *= 0.5;
      }
      b = clamp01(b * 1.15 + 0.5);
      // Sharpen into filaments.
      a = clamp01(Math.pow(a, 1.7) * 1.35);
      b = clamp01(Math.pow(b, 2.1) * 1.5);
      data[i++] = a * 255;
      data[i++] = b * 255;
      data[i++] = clamp01(a * b) * 255;
      data[i++] = 255;
    }
  }
  return data;
}

/* ══════════════════════════════════════════════════════════════════ utilities ══ */

const QUAD_GEOMETRY = new THREE.PlaneGeometry(2, 2);

class FullScreenPass {
  constructor(material) {
    this.material = material;
    this.scene = new THREE.Scene();
    this.scene.matrixAutoUpdate = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(QUAD_GEOMETRY, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
  }
  render(renderer, target) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
  }
  dispose() {
    this.material.dispose();
  }
}

function makeRT(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: opts.type ?? THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: opts.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: opts.wrapT ?? opts.wrap ?? THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.name = opts.name || 'sky.rt';
  return rt;
}

/* ═══════════════════════════════════════════════════════════════════════ Sky ══ */

class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = false;
    this.broken = false;
    this.hours = 7.4;

    const seed = Math.floor((ctx.rng ? ctx.rng() : 0.5) * 0xffffffff) >>> 0;
    this.rand = mulberry32(seed || 0x51ce7a11);

    this.headless = !!ctx.settings?.get?.('headless');
    this.tier = ctx.settings?.tier || 'high';

    /** Art-directed key bearing, degrees; null = follow the almanac. See _stageSun(). */
    this._sunStaging = { azimuth: null, altitude: null, kelvin: null };
    /**
     * **The golden-hour grade lives here, not downstream of here.**
     *
     * `render/Lighting.js` used to warm the key on an altitude curve *after* taking it
     * from this module, which meant exactly one consumer of the sun's colour was graded
     * — the CSM — while the six that live in this file were not: the cloud deck, the
     * cirrus, the aerial-perspective in-scatter, the lit-ground term the dome blends to
     * below the horizon, and the solar disc itself. The review measured the result as
     * "the key is graded and the sky is not": cloud undersides grey at a 3300 K golden
     * hour, sky channel spread of 2-12 parts in 255, and no sun-side asymmetry at all.
     *
     * The curve is the same one and the justification is unchanged (see the WARP_X note
     * above): the disc's own transmittance at a 15-degree sun is about 4900 K, a camera
     * at golden hour records 2800-3500 K, and the *altitude* cannot be lowered to buy
     * that colour without putting the entire playable street in shadow. It fades out
     * above ~40 degrees so harsh noon stays exactly as physics delivers it.
     */
    this._gradeStrength = 1;

    /* ------------------------------------------------------- published state */
    this.sunDirection = new THREE.Vector3(0, 0.2, -1).normalize();
    this.moonDirection = new THREE.Vector3(0, -0.3, 1).normalize();
    this.keyDirection = new THREE.Vector3(0, 0.2, -1).normalize();
    this.sunColor = new THREE.Color(1, 0.9, 0.78);
    this.moonColor = new THREE.Color(0.68, 0.76, 1.0);
    this.keyColor = new THREE.Color(1, 0.9, 0.78);
    this.sunIntensity = 8;
    this.moonIntensity = 0;
    this.keyIntensity = 8;
    this.sunAltitude = 0.2;
    this.skyLuminance = 1;
    this.starVisibility = 0;
    this.nightFactor = 0;
    this.adaptLift = 1;
    this.physLuminance = 0.0165;
    this.zenithColor = new THREE.Color(0.16, 0.3, 0.62);
    this.horizonColor = new THREE.Color(0.62, 0.66, 0.74);
    this.groundColor = new THREE.Color(0.08, 0.078, 0.072);
    this.fogColor = new THREE.Color(0.62, 0.66, 0.74);
    this.ambientColor = new THREE.Color(0.3, 0.38, 0.52);
    this.envTexture = null;
    this.envCubeTexture = null;

    /* ---------------------------------------------------------------- tuning */
    this.exposureScale = IRRADIANCE_SCALE; // physical radiance -> render units
    this.sunDiscScale = 1200.0;
    /** Multiplied by `adaptLift` in `_pushUniforms`; ~8 in render units at full night. */
    this.moonDiscScale = 0.34;
    this.groundAlbedo = new THREE.Color(0.11, 0.105, 0.096);
    /**
     * Fair-weather cumulus with plenty of open sky between the cells.
     *
     * These are only the *defaults*, in force from init until `render/Weather.js`
     * publishes a preset (it drives coverage / type / cirrus / haze from that point
     * on). They still matter: they are what the very first frames and the initial
     * environment cube are built from, and what the sky falls back to if weather is
     * ever stubbed out again. 0.48 put roughly two thirds of the dome under cloud and,
     * with the cirrus shell in front of all of it, read as thin overcast — the sky
     * measured B:R 1.27 on the hero frame, i.e. almost white, with no blue for the
     * warm facades to sit against.
     */
    this.coverage = 0.4;
    this.cloudType = 0.5;
    this.cirrusAmount = 0.2;
    this.starBrightness = 0.55;
    this.haze = 1.0;
    this.wind = new THREE.Vector2(7.5, 2.4); // m/s
    this.lightPollution = 0.012;

    /* --------------------------------------------------------------- runtime */
    this._cloudOffset = new THREE.Vector2(0, 0);
    this._weatherOffset = new THREE.Vector2(0, 0);
    this._cirrusScroll = new THREE.Vector2(0, 0);
    this._mistOffset = new THREE.Vector2(0, 0);
    this._elapsed = 0;
    this._frame = 0;
    this._cloudIndex = 0;
    this._cloudReset = 3;
    this._lutDirty = true;
    this._msDirty = true;
    this._envDirty = true;
    this._envTimer = 0;
    this._lastLutSun = new THREE.Vector3(0, -1, 0);
    this._lastMsSun = new THREE.Vector3(0, -1, 0);
    this._unsub = [];
    this._envListeners = [];
    this._ownsFog = false;
    this._ownsEnvironment = false;
    this._shimmedLighting = false;
    this._width = 1280;
    this._height = 720;
    this._warned = false;

    this._cloudCam = new THREE.PerspectiveCamera(90, 1.777, 1, 100);
    this._cloudCam.matrixAutoUpdate = false;
    this._cloudViewProj = new THREE.Matrix4();
    this._cloudPrevViewProj = new THREE.Matrix4();
    this._cloudInvViewProj = new THREE.Matrix4();
    this._tmpV = new THREE.Vector3();
    this._tmpM = new THREE.Matrix4();

    this._trans = [0, 0, 0];
    this._rad = [0, 0, 0];
  }

  /* ─────────────────────────────────────────────────────────────────── setup */

  init() {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    if (!renderer) throw new Error('no renderer');

    this._buildTextures();
    this._buildUniforms();
    this._buildLutPasses();
    this._buildCloudPass();
    this._buildDome();
    this._bind();

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.setSize(size.x || 1280, size.y || 720);

    // Transmittance is sun independent: bake it exactly once.
    this._transmittancePass.render(renderer, this.rtTransmittance);

    this.setTimeOfDay(this.hours, true);
    this._updateLuts(true);
    this._renderEnvironment(true);

    this.ready = true;
  }

  _buildTextures() {
    const shapeSize = 64;
    const detailSize = 32;
    const rand = this.rand;

    const shape = new THREE.Data3DTexture(buildShapeVolume(shapeSize, rand), shapeSize, shapeSize, shapeSize);
    shape.format = THREE.RGBAFormat;
    shape.type = THREE.UnsignedByteType;
    shape.minFilter = THREE.LinearFilter;
    shape.magFilter = THREE.LinearFilter;
    shape.wrapS = shape.wrapT = shape.wrapR = THREE.RepeatWrapping;
    shape.unpackAlignment = 4;
    shape.needsUpdate = true;
    shape.name = 'sky.cloudShape';
    this.texShape = shape;

    const detail = new THREE.Data3DTexture(buildDetailVolume(detailSize, rand), detailSize, detailSize, detailSize);
    detail.format = THREE.RGBAFormat;
    detail.type = THREE.UnsignedByteType;
    detail.minFilter = THREE.LinearFilter;
    detail.magFilter = THREE.LinearFilter;
    detail.wrapS = detail.wrapT = detail.wrapR = THREE.RepeatWrapping;
    detail.unpackAlignment = 4;
    detail.needsUpdate = true;
    detail.name = 'sky.cloudDetail';
    this.texDetail = detail;

    const weather = new THREE.DataTexture(buildWeatherMap(256, rand), 256, 256, THREE.RGBAFormat);
    weather.wrapS = weather.wrapT = THREE.RepeatWrapping;
    weather.minFilter = THREE.LinearMipmapLinearFilter;
    weather.magFilter = THREE.LinearFilter;
    weather.generateMipmaps = true;
    weather.needsUpdate = true;
    weather.name = 'sky.weather';
    this.texWeather = weather;

    const cirrus = new THREE.DataTexture(buildCirrusMap(512, rand), 512, 512, THREE.RGBAFormat);
    cirrus.wrapS = cirrus.wrapT = THREE.RepeatWrapping;
    cirrus.minFilter = THREE.LinearMipmapLinearFilter;
    cirrus.magFilter = THREE.LinearFilter;
    cirrus.generateMipmaps = true;
    cirrus.anisotropy = Math.min(8, this.ctx.maxAnisotropy || 1);
    cirrus.needsUpdate = true;
    cirrus.name = 'sky.cirrus';
    this.texCirrus = cirrus;

    const galaxy = new THREE.DataTexture(buildGalaxyMap(256, 128, rand), 256, 128, THREE.RGBAFormat);
    galaxy.wrapS = THREE.RepeatWrapping; // azimuth wraps: no seam
    galaxy.wrapT = THREE.ClampToEdgeWrapping;
    galaxy.minFilter = THREE.LinearFilter;
    galaxy.magFilter = THREE.LinearFilter;
    galaxy.generateMipmaps = false; // mips would pop across the atan seam
    galaxy.needsUpdate = true;
    galaxy.name = 'sky.galaxy';
    this.texGalaxy = galaxy;
  }

  _buildUniforms() {
    const v3 = (x, y, z) => ({ value: new THREE.Vector3(x, y, z) });
    const v2 = (x, y) => ({ value: new THREE.Vector2(x, y) });
    const f = (x) => ({ value: x });

    // Cloud uniforms are shared by the raymarch pass and the environment dome.
    this.uCloud = {
      tShape: { value: this.texShape },
      tDetail: { value: this.texDetail },
      tWeather: { value: this.texWeather },
      uCloudBottom: f(1250),
      uCloudTop: f(4300),
      uCoverage: f(this.coverage),
      uCloudDensity: f(1.0),
      uCloudExtinction: f(0.038),
      uCloudType: f(this.cloudType),
      uCloudWind: v2(0, 0),
      uWeatherWind: v2(0, 0),
      uCloudBaseScale: f(1 / 11500),
      uCloudDetailMul: f(13.0),
      uCloudSunDir: v3(0, 1, 0),
      uCloudSunColor: v3(6, 5.4, 4.6),
      uCloudSkyTop: v3(0.5, 0.7, 1.1),
      uCloudSkyBottom: v3(0.22, 0.25, 0.3),
      uCloudHaze: v3(0.7, 0.75, 0.85),
      uCloudAerial: f(1 / 32000),
      uCloudMaxDist: f(95000),
    };

    this.uAtmos = {
      tTransmittance: { value: null },
      tSkyView: { value: null },
      uSunDirection: v3(0, 1, 0),
      uViewHeight: f(GROUND_R + 0.00006),
      uSkyScale: f(this.exposureScale),
    };

    this.uSky = {
      ...this.uAtmos,
      tCirrus: { value: this.texCirrus },
      tGalaxy: { value: this.texGalaxy },
      uMoonDirection: v3(0, -1, 0),
      uSunDiscRadiance: v3(400, 380, 340),
      /** Circumsolar aureole — see the `uSunGlowColor` note in `_pushUniforms`. */
      uSunGlowColor: v3(0.4, 0.3, 0.18),
      uMoonDiscRadiance: v3(2, 2.1, 2.4),
      uMoonGlowColor: v3(0.05, 0.06, 0.09),
      uNightSkyColor: v3(0.0022, 0.0034, 0.0072),
      uStarTint: v3(0.55, 0.6, 0.85),
      uGroundLit: v3(0.05, 0.05, 0.05),
      uCirrusSunColor: v3(1.2, 1.1, 0.95),
      uCirrusAmbient: v3(0.25, 0.3, 0.4),
      uPollutionColor: v3(0.02, 0.012, 0.005),
      uCameraPos: v3(0, 1.7, 0),
      uCirrusScroll: v2(0, 0),
      uSunAngularRadius: f(SUN_ANG_RADIUS),
      uMoonAngularRadius: f(MOON_ANG_RADIUS),
      uStarFade: f(0),
      uNightFade: f(0),
      uCirrusAmount: f(this.cirrusAmount),
      /** x saturation restore, y zenith-blue bias — see the dome shader. */
      uSkyChroma: v2(1.55, 0.85),
      uCirrusHeight: f(8200),
      uTime: f(0),
      uStarBrightness: f(this.starBrightness),
    };

    // Aerial-perspective uniforms handed to other modules.
    this.aerialUniforms = {
      uSkyBetaR: v3(4.6e-5, 1.09e-4, 2.65e-4),
      uSkyBetaM: f(1.4e-4),
      uSkySunColor: v3(1, 0.9, 0.78),
      uSkyAmbientColor: v3(0.3, 0.38, 0.52),
      uSkySunDir: v3(0, 1, 0),
      uSkyCamPos: v3(0, 1.7, 0),
      /**
       * x density, y 1/heightScale, z ground Y, w strength.
       *
       * A 900 m scale height and unit density is *clean air over an ocean*: with
       * beta_R+M summing to 1.86-4.05e-4 per metre it put 2-5% of extinction on a
       * 120 m building, so the backdrop ring punched through at essentially full
       * contrast with a razor roofline — measured (54,52,57) on the far tower, as
       * dark and as saturated as blocks four times closer. There is no aerial
       * perspective at that strength, only a haze band lying on the ground.
       *
       * 10x density puts ~26% extinction plus inscatter on that same 120 m (and ~7%
       * at 30 m, so the near field is untouched), and a 140 m scale height gives the
       * vertical gradient a dusty urban basin actually has — rooftops and the minaret
       * gallery clear noticeably faster than the street they stand over, which is the
       * cue that sells depth. Weather still scales all of it through `haze`.
       */
      uSkyFog: { value: new THREE.Vector4(10.0, 1 / 140, 0.0, 1.0) },
      uSkyMist: { value: new THREE.Vector4(2.4e-5, 26.0, 0.0035, 1.0) },
      uSkyMistWind: v2(0, 0),
    };
  }

  _buildLutPasses() {
    this.rtTransmittance = makeRT(256, 64, { name: 'sky.transmittance' });
    this.rtMultiScatter = makeRT(32, 32, { name: 'sky.multiscatter' });
    const svW = this.headless ? 160 : 200;
    const svH = this.headless ? 96 : 112;
    this.rtSkyView = makeRT(svW, svH, { name: 'sky.skyview' });

    this.uAtmos.tTransmittance.value = this.rtTransmittance.texture;
    this.uSky.tTransmittance.value = this.rtTransmittance.texture;
    this.uSky.tSkyView.value = this.rtSkyView.texture;

    this._transmittancePass = new FullScreenPass(
      new THREE.ShaderMaterial({
        name: 'sky:transmittance',
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: TRANSMITTANCE_FRAG,
        depthTest: false,
        depthWrite: false,
      })
    );

    this._multiScatterPass = new FullScreenPass(
      new THREE.ShaderMaterial({
        name: 'sky:multiscatter',
        uniforms: {
          tTransmittance: { value: this.rtTransmittance.texture },
          uGroundAlbedo: { value: new THREE.Vector3(0.16, 0.15, 0.14) },
        },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: MULTISCATTER_FRAG,
        depthTest: false,
        depthWrite: false,
      })
    );

    this._skyViewPass = new FullScreenPass(
      new THREE.ShaderMaterial({
        name: 'sky:skyview',
        uniforms: {
          tTransmittance: { value: this.rtTransmittance.texture },
          tMultiScatter: { value: this.rtMultiScatter.texture },
          uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
          uViewHeight: this.uAtmos.uViewHeight,
        },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: SKYVIEW_FRAG,
        depthTest: false,
        depthWrite: false,
      })
    );
  }

  _cloudQuality() {
    const s = this.ctx.settings;
    const tier = s?.tier || 'high';
    const headless = this.headless;
    if (headless) {
      return tier === 'low'
        ? { scale: 0.2, steps: 20, light: 3 }
        : { scale: 0.3, steps: 34, light: 4 };
    }
    switch (tier) {
      case 'low':
        return { scale: 0.22, steps: 26, light: 3 };
      case 'medium':
        return { scale: 0.25, steps: 40, light: 4 };
      case 'ultra':
        return { scale: 0.34, steps: 72, light: 6 };
      default:
        return { scale: 0.28, steps: 54, light: 5 };
    }
  }

  _buildCloudPass() {
    const q = this._cloudQuality();
    this._cloudScale = q.scale;

    this.uCloudPass = {
      ...this.uCloud,
      tHistory: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFrame: { value: 0 },
      uReset: { value: 1 },
      uHistoryBlend: { value: 0.9 },
    };

    this._cloudMaterial = new THREE.ShaderMaterial({
      name: 'sky:clouds',
      uniforms: this.uCloudPass,
      defines: { CLOUD_STEPS: q.steps, CLOUD_LIGHT_STEPS: q.light },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: CLOUD_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this._cloudPass = new FullScreenPass(this._cloudMaterial);
    this._cloudRT = [null, null];
  }

  _buildDome() {
    const uniforms = { ...this.uSky, ...{ tClouds: { value: null } } };
    uniforms.uCloudViewProj = { value: new THREE.Matrix4() };
    uniforms.uHasClouds = { value: 0 };
    this.uDome = uniforms;

    this.material = new THREE.ShaderMaterial({
      name: 'sky:dome',
      uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    const geo = new THREE.BoxGeometry(2, 2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'sky.dome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.sky = true;
    this.ctx.scene?.add(this.mesh);

    // Environment variant: same shader, clouds marched inline (no screen buffer).
    const envUniforms = { ...this.uSky, ...this.uCloud };
    this.uEnv = envUniforms;
    this.materialEnv = new THREE.ShaderMaterial({
      name: 'sky:dome:env',
      uniforms: envUniforms,
      defines: { SKY_ENV: 1 },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.envMesh = new THREE.Mesh(geo, this.materialEnv);
    this.envMesh.frustumCulled = false;
    this.envMesh.matrixAutoUpdate = false;
    this.envScene = new THREE.Scene();
    this.envScene.add(this.envMesh);

    const cubeSize = this.headless ? 48 : 64;
    this.cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    this.cubeRT.texture.name = 'sky.envCube';
    this.cubeCamera = new THREE.CubeCamera(0.05, 100, this.cubeRT);
    this.envCubeTexture = this.cubeRT.texture;
  }

  _bind() {
    const bus = this.ctx.bus;
    if (!bus?.on) return;
    const on = (ev, fn) => {
      const off = bus.on(ev, fn);
      if (typeof off === 'function') this._unsub.push(off);
    };
    on('debug:pose', (state) => {
      const t = state?.time ?? state?.timeOfDay ?? state?.hour;
      if (typeof t === 'number') this.setTimeOfDay(t);
      this._cloudReset = 3;
    });
    on('sky:setTimeOfDay', (e) => {
      const t = typeof e === 'number' ? e : e?.hours ?? e?.time;
      if (typeof t === 'number') this.setTimeOfDay(t);
    });
    on('player:teleport', () => {
      this._cloudReset = 2;
    });
    on('quality:changed', () => {
      try {
        this._rebuildCloudQuality();
      } catch (err) {
        this._warn('quality change failed', err);
      }
    });
    on('weather:changed', (e) => {
      if (!e) return;
      if (typeof e.coverage === 'number') this.setCloudCoverage(e.coverage);
      if (typeof e.cirrus === 'number') this.setCirrus(e.cirrus);
      if (typeof e.haze === 'number') this.setHaze(e.haze);
      if (e.wind) this.setWind(e.wind.x ?? e.wind[0] ?? 0, e.wind.z ?? e.wind.y ?? e.wind[1] ?? 0);
    });
  }

  _rebuildCloudQuality() {
    const q = this._cloudQuality();
    if (this._cloudMaterial.defines.CLOUD_STEPS === q.steps && this._cloudScale === q.scale) return;
    this._cloudMaterial.defines.CLOUD_STEPS = q.steps;
    this._cloudMaterial.defines.CLOUD_LIGHT_STEPS = q.light;
    this._cloudMaterial.needsUpdate = true;
    this._cloudScale = q.scale;
    this.setSize(this._width, this._height);
  }

  /* ────────────────────────────────────────────────────────────────── sizing */

  setSize(w, h) {
    this._width = Math.max(1, Math.round(w));
    this._height = Math.max(1, Math.round(h));
    const cw = Math.max(32, Math.round(this._width * this._cloudScale));
    const ch = Math.max(18, Math.round(this._height * this._cloudScale));
    if (this._cloudRT[0] && this._cloudRT[0].width === cw && this._cloudRT[0].height === ch) return;
    for (let i = 0; i < 2; i++) {
      this._cloudRT[i]?.dispose();
      this._cloudRT[i] = makeRT(cw, ch, { name: `sky.clouds${i}` });
    }
    this.uCloudPass.uResolution.value.set(cw, ch);
    this._cloudReset = 3;
  }

  /* ──────────────────────────────────────────────────────── time of day model */

  setTimeOfDay(hours, force = false) {
    if (!Number.isFinite(hours)) return;
    const h = ((hours % 24) + 24) % 24;
    if (!force && Math.abs(h - this.hours) < 1e-5) return;
    this.hours = h;

    const t = warpHours(h);
    const H = (t - SOLAR_NOON) * 15 * DEG;
    horizonDirection(SUN_DEC, H, this.sunDirection);
    horizonDirection(MOON_DEC, H - MOON_ELONGATION, this.moonDirection);
    this._stageSun();
    this.sunAltitude = Math.asin(THREE.MathUtils.clamp(this.sunDirection.y, -1, 1));

    this._recomputeLighting();

    // Only redo the expensive LUTs when the sun has actually moved.
    if (force || this.sunDirection.dot(this._lastLutSun) < Math.cos(0.12 * DEG)) this._lutDirty = true;
    if (force || this.sunDirection.dot(this._lastMsSun) < Math.cos(0.6 * DEG)) {
      this._msDirty = true;
      this._envDirty = true;
    }

    this.ctx.bus?.emit?.('sky:timeOfDay', {
      hours: this.hours,
      sunDirection: this.sunDirection,
      sunColor: this.sunColor,
      sunIntensity: this.sunIntensity,
      moonDirection: this.moonDirection,
      night: this.nightFactor,
    });
  }

  /**
   * **Staging override — the clock no longer owns the light direction.**
   *
   * `horizonDirection()` derives azimuth purely from the hour angle, so time of day
   * and key bearing were welded together: every review pose in the set came out with
   * the sun between azimuth 87 and 102 deg, which put it behind the camera in six of
   * the eight and made every shadow fall away from the lens and hide behind its own
   * caster. Altitude and azimuth are the two things a director stages, and a physical
   * almanac has no opinion worth defending about which way a fictional street faces.
   *
   * So: `setSunStaging({azimuth, altitude})` pins either or both, in degrees, azimuth
   * measured clockwise from -Z (0 = north, 90 = +X). It rewrites the sun direction
   * *before* anything else consumes it, so the dome, the disc, the cloud lighting, the
   * aerial perspective, the CPU sky samples and the CSM key all still agree with each
   * other — this is a re-aim, not a decoupling, and there is nothing to keep in sync.
   * The moon rides the same azimuth rotation so the celestial sphere stays coherent.
   */
  _stageSun() {
    const s = this._sunStaging;
    if (!s || (s.azimuth === null && s.altitude === null)) return;
    const d = this.sunDirection;
    const alt0 = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    const az0 = Math.atan2(d.x, -d.z);
    const alt = s.altitude === null ? alt0 : s.altitude * DEG;
    const az = s.azimuth === null ? az0 : s.azimuth * DEG;
    const ca = Math.cos(alt);
    d.set(Math.sin(az) * ca, Math.sin(alt), -Math.cos(az) * ca).normalize();

    const dAz = az - az0;
    if (Math.abs(dAz) > 1e-9) {
      const c = Math.cos(dAz);
      const sn = Math.sin(dAz);
      const m = this.moonDirection;
      m.set(m.x * c - m.z * sn, m.y, m.z * c + m.x * sn).normalize();
    }
  }

  /**
   * @param {{azimuth?:number|null, altitude?:number|null, kelvin?:number|null}|null} opts
   *        degrees (kelvin in K); `null` for a field (or for the whole object) releases
   *        it back to the almanac / the default altitude curve.
   */
  setSunStaging(opts) {
    const s = this._sunStaging;
    if (!opts) {
      s.azimuth = null;
      s.altitude = null;
      s.kelvin = null;
    } else {
      if ('azimuth' in opts) s.azimuth = Number.isFinite(opts.azimuth) ? opts.azimuth : null;
      if ('altitude' in opts) s.altitude = Number.isFinite(opts.altitude) ? opts.altitude : null;
      if ('kelvin' in opts) s.kelvin = Number.isFinite(opts.kelvin) ? opts.kelvin : null;
    }
    this.setTimeOfDay(this.hours, true);
    return { azimuth: s.azimuth, altitude: s.altitude, kelvin: s.kelvin };
  }

  /**
   * Planckian locus -> linear sRGB, peak-normalised. Same fit `render/Lighting.js`
   * uses (Kim et al. cubic + CIE xyY -> Rec.709), duplicated rather than imported so
   * this module keeps its "depends on nothing but three" contract.
   */
  _kelvinRGB(kelvin, out) {
    const T = THREE.MathUtils.clamp(kelvin || 6500, 1600, 25000);
    const t2 = T * T;
    const t3 = t2 * T;
    let x;
    if (T <= 4000) x = -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / T + 0.17991;
    else x = -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / T + 0.24039;
    const x2 = x * x;
    const x3 = x2 * x;
    let y;
    if (T <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
    else if (T <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
    else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
    y = Math.max(y, 1e-4);
    const X = x / y;
    const Z = (1 - x - y) / y;
    let r = 3.2404542 * X - 1.5371385 - 0.4985314 * Z;
    let g = -0.969266 * X + 1.8760108 + 0.041556 * Z;
    let b = 0.0556434 * X - 0.2040259 + 1.0572252 * Z;
    r = Math.max(r, 0);
    g = Math.max(g, 0);
    b = Math.max(b, 0);
    const peak = Math.max(r, g, b, 1e-6);
    return out.setRGB(r / peak, g / peak, b / peak);
  }

  /**
   * Warm the key towards a golden-hour colour temperature, in place, before anything in
   * this file consumes `sunColor`. Peak-normalised on both sides, so this changes hue
   * and nothing else — the intensity, the disc size and the geometry all stay physical.
   * See `_gradeStrength` for why the grade exists at all.
   *
   * @returns {number} 0..1, how much of the grade was applied — the dome uses it to
   *          decide how much circumsolar warmth to add.
   */
  _gradeSun() {
    this.gradeWeight = 0;
    if (this.sunIntensity <= 1e-4) return 0;
    const altDeg = (Math.asin(THREE.MathUtils.clamp(this.sunDirection.y, -1, 1)) * 180) / Math.PI;
    if (altDeg <= 0) return 0;
    let kelvin = this._sunStaging.kelvin;
    let weight = this._gradeStrength;
    if (kelvin === null) {
      kelvin = THREE.MathUtils.clamp(2450 + 62 * altDeg, 2300, 6500);
      const t = clamp01((altDeg - 24) / 18);
      weight *= 1 - t * t * (3 - 2 * t);
    }
    if (weight <= 0.001) return 0;
    const c = this._gradeColor || (this._gradeColor = new THREE.Color());
    this._kelvinRGB(kelvin, c);
    const s = this.sunColor;
    const peak = Math.max(s.r, s.g, s.b, 1e-6);
    s.setRGB(
      (s.r / peak + (c.r - s.r / peak) * weight) * peak,
      (s.g / peak + (c.g - s.g / peak) * weight) * peak,
      (s.b / peak + (c.b - s.b / peak) * weight) * peak
    );
    const p2 = Math.max(s.r, s.g, s.b, 1e-6);
    s.setRGB(s.r / p2, s.g / p2, s.b / p2);
    this.gradeWeight = weight;
    return weight;
  }

  /** Everything CPU-side that depends on the sun position. */
  _recomputeLighting() {
    const sunY = this.sunDirection.y;
    const viewH = GROUND_R + 0.00006;

    // Direct sun transmittance -> colour and intensity of the key light.
    cpuTransmittance(viewH, sunY, this._trans);
    const T = this._trans;
    const lum = 0.2126 * T[0] + 0.7152 * T[1] + 0.0722 * T[2];
    const peak = Math.max(T[0], T[1], T[2], 1e-6);
    // Below the horizon the disc is gone; fade the direct term out smoothly.
    const above = clamp01((sunY + 0.018) / 0.05);
    this.sunIntensity = IRRADIANCE_SCALE * lum * above;
    this.sunColor.setRGB(T[0] / peak, T[1] / peak, T[2] / peak);
    if (this.sunIntensity < 1e-4) this.sunColor.setRGB(1, 0.86, 0.72);

    // Sky radiance at a few reference directions (single scattering, CPU).
    const zen = cpuSkyRadiance(1, 0, sunY, sunY, viewH, this._rad).slice();
    const sunAz = Math.sqrt(Math.max(0, 1 - sunY * sunY));
    const horSun = cpuSkyRadiance(0.06, -0.998, sunY, 0.06 * sunY + 0.998 * sunAz, viewH, this._rad).slice();
    const horOpp = cpuSkyRadiance(0.06, 0.998, sunY, 0.06 * sunY - 0.998 * sunAz, viewH, this._rad).slice();
    const mid = cpuSkyRadiance(0.55, -0.835, sunY, 0.55 * sunY + 0.835 * sunAz, viewH, this._rad).slice();

    // The CPU march skips multiple scattering; a modest lift keeps it consistent.
    const ms = 1.42;

    /**
     * Eye adaptation. Noon to civil twilight is a ~10^3 drop and on to a moonless
     * night another ~10^3 — six decades that no tonemapper (and certainly not the
     * pipeline's 0.4..2.4 auto-exposure gain) can hold. Compress it with a power
     * curve so the *ratios* survive: a 10^6 physical range becomes about 60:1 on
     * screen. Crucially the same factor scales the sky, the ambient, the IBL cube
     * and the sun, so the scene stays internally consistent — this is exposure, not
     * a per-element fudge.
     */
    const meanR = (zen[0] + mid[0] * 2 + horSun[0] + horOpp[0]) * 0.2;
    const meanG = (zen[1] + mid[1] * 2 + horSun[1] + horOpp[1]) * 0.2;
    const meanB = (zen[2] + mid[2] * 2 + horSun[2] + horOpp[2]) * 0.2;
    this.physLuminance = Math.max(0.2126 * meanR + 0.7152 * meanG + 0.0722 * meanB, 1e-9);
    const REF_LUM = 0.0165; // clear-noon mean sky radiance, Hillaire units
    // 0.45 turns six decades of physical range into roughly 1.5 decades on screen:
    // dawn lands ~15x under noon, which is where a filmic stock would put it.
    this.adaptLift = THREE.MathUtils.clamp(Math.pow(this.physLuminance / REF_LUM, -0.45), 1.0, 26);
    const scale = this.exposureScale * this.adaptLift;

    const boost = (v) => Math.max(v * scale * ms, 0);
    this.sunIntensity *= this.adaptLift;

    // A directional light near the horizon stands in for the sun *plus* its aureole,
    // and the aureole is nothing like as reddened as the disc. Straight disc
    // transmittance would hand Lighting a cartoon-red key at sunset.
    const aureole = clamp01(1 - sunY / 0.16);
    if (aureole > 0.001 && this.sunIntensity > 1e-4) {
      const hp = Math.max(horSun[0], horSun[1], horSun[2], 1e-9);
      const k = 0.45 * aureole;
      const r = this.sunColor.r * (1 - k) + (horSun[0] / hp) * k;
      const g = this.sunColor.g * (1 - k) + (horSun[1] / hp) * k;
      const b = this.sunColor.b * (1 - k) + (horSun[2] / hp) * k;
      const p = Math.max(r, g, b, 1e-6);
      this.sunColor.setRGB(r / p, g / p, b / p);
    }

    // Grade before anything downstream reads it: clouds, cirrus, aerial perspective,
    // the lit-ground term and the disc all consume `sunColor` from here on.
    this._gradeSun();

    this.zenithColor.setRGB(boost(zen[0]), boost(zen[1]), boost(zen[2]));
    this.horizonColor.setRGB(
      boost((horSun[0] + horOpp[0]) * 0.5),
      boost((horSun[1] + horOpp[1]) * 0.5),
      boost((horSun[2] + horOpp[2]) * 0.5)
    );
    const ambR = boost((zen[0] + mid[0] * 2 + horSun[0] + horOpp[0]) * 0.2);
    const ambG = boost((zen[1] + mid[1] * 2 + horSun[1] + horOpp[1]) * 0.2);
    const ambB = boost((zen[2] + mid[2] * 2 + horSun[2] + horOpp[2]) * 0.2);

    // Night floor: airglow + moonlight + a city's worth of light pollution.
    const night = clamp01((-sunY - 0.02) / 0.16);
    this.nightFactor = night;
    this.starVisibility = clamp01((-sunY - 0.005) / 0.13);

    const moonUp = clamp01(this.moonDirection.y / 0.12);
    // Illuminated fraction of the lunar disc, from the sun-moon elongation.
    const elong = Math.acos(THREE.MathUtils.clamp(this.sunDirection.dot(this.moonDirection), -1, 1));
    const phase = 0.5 * (1 + Math.cos(Math.PI - elong));
    /**
     * **The moon has to ride the same adaptation curve as the sun.** `adaptLift` is an
     * exposure, and the entire contract of this module is that one factor scales the
     * sky radiance, the ambient, the IBL cube *and* the key together so the scene stays
     * internally consistent. The sun gets it (`sunIntensity *= adaptLift` above); the
     * moon was the one term that did not, so at full night the sky and the ambient were
     * lifted 26x while the only directional light in the scene stayed at its raw
     * physical 0.05. The result had no key at all: every facade was lit purely by
     * residual blue Rayleigh skyglow and measured RGB (0, 4, 15) out of 255 — a
     * saturated navy silhouette with a literally empty red channel, and 75 % of the
     * frame under luma 20. The base is retuned so the lifted value lands where a
     * moonlit key belongs rather than 26x where it used to sit.
     */
    const moonBase = 0.04 * moonUp * night * phase;
    this.moonIntensity = moonBase * this.adaptLift;
    this.moonColor.setRGB(0.66, 0.74, 1.0);

    /**
     * Night floor. Airglow alone is faintly green and the residual Rayleigh term is
     * deep blue; a *city* at night is neither. Sodium and LED spill is the dominant
     * ambient in any inhabited night scene and it is warm, and it was already being
     * drawn into the sky dome (`uPollutionColor`) while contributing nothing at all to
     * surface lighting — the sky glowed orange over rooftops lit only in blue. Folding
     * the same term into the ambient makes the two agree and gives the shadow side of a
     * building a red channel to work with.
     */
    const nightAmb = 0.0075 * night;
    const poll = this.lightPollution * night;
    const moonFill = this.moonIntensity * 0.02;
    this.ambientColor.setRGB(
      ambR + nightAmb * 0.55 + poll * 0.95 + moonFill * 0.85,
      ambG + nightAmb * 0.72 + poll * 0.55 + moonFill * 0.92,
      ambB + nightAmb * 1.35 + poll * 0.24 + moonFill * 1.25
    );

    this.skyLuminance =
      0.2126 * this.ambientColor.r + 0.7152 * this.ambientColor.g + 0.0722 * this.ambientColor.b;

    // The dominant light source for shadow casting.
    if (this.sunIntensity >= this.moonIntensity) {
      this.keyDirection.copy(this.sunDirection);
      this.keyColor.copy(this.sunColor);
      this.keyIntensity = this.sunIntensity;
    } else {
      this.keyDirection.copy(this.moonDirection);
      this.keyColor.copy(this.moonColor);
      this.keyIntensity = this.moonIntensity;
    }

    this.groundColor.setRGB(
      this.groundAlbedo.r * (this.sunIntensity * Math.max(sunY, 0) * this.sunColor.r + this.ambientColor.r),
      this.groundAlbedo.g * (this.sunIntensity * Math.max(sunY, 0) * this.sunColor.g + this.ambientColor.g),
      this.groundAlbedo.b * (this.sunIntensity * Math.max(sunY, 0) * this.sunColor.b + this.ambientColor.b)
    );

    // Fog picks up the horizon in the sun's half of the sky — that is where the
    // eye reads aerial perspective.
    this.fogColor.setRGB(
      boost(horSun[0] * 0.62 + horOpp[0] * 0.38) + nightAmb * 0.6,
      boost(horSun[1] * 0.62 + horOpp[1] * 0.38) + nightAmb * 0.8,
      boost(horSun[2] * 0.62 + horOpp[2] * 0.38) + nightAmb * 1.4
    );

    this._pushUniforms(T, night);
  }

  _pushUniforms(T, night) {
    const u = this.uSky;
    const c = this.uCloud;
    const a = this.aerialUniforms;

    u.uSunDirection.value.copy(this.sunDirection);
    u.uMoonDirection.value.copy(this.moonDirection);
    u.uStarFade.value = this.starVisibility;
    u.uNightFade.value = night;
    u.uSkyScale.value = this.exposureScale * this.adaptLift;
    u.uStarBrightness.value = this.starBrightness;
    u.uCirrusAmount.value = this.cirrusAmount;

    // The disc is *not* pre-attenuated here: the shader multiplies by the view
    // transmittance, which is what reddens and dims it as it sets.
    const discFade = clamp01((this.sunDirection.y + 0.02) / 0.03);
    const disc = this.sunDiscScale * discFade * this.adaptLift;
    // The disc takes the graded key's hue. It was a hard-coded (1, 0.985, 0.96) — a
    // white sun over a 3300 K key, which is the one object in frame that absolutely
    // cannot disagree with the light it is casting.
    const sc = this.sunColor;
    u.uSunDiscRadiance.value.set(disc * sc.r, disc * sc.g, disc * sc.b);
    /**
     * **Circumsolar aureole.** The dome had a disc four pixels across and nothing else:
     * no forward-scattering glow, so the review found "no sun disc, no circumsolar glow,
     * no sun-side asymmetry — the NW sky is identical to the N sky with the key staged at
     * azimuth 24". The sky-view LUT does carry an aureole, but it is a 200x112 texture
     * over the whole hemisphere: the 10-degree lobe that reads as *where the sun is*
     * lands inside two texels of it and is filtered away.
     *
     * Two exponentials — a tight 6-degree core and a broad 40-degree wash — reconstruct
     * it analytically, tinted with the graded key and scaled by the same aerosol load the
     * rest of the frame uses. This is the term that makes a sky read as "lit from over
     * there" rather than as a gradient, and it is the only reason the sun's *bearing* is
     * legible in a frame the disc itself never enters.
     */
    const glowFade = clamp01((this.sunDirection.y + 0.03) / 0.08);
    const gk = 0.62 * glowFade * this.adaptLift * this.exposureScale * clamp01(0.45 + 0.55 * this.haze);
    u.uSunGlowColor.value.set(sc.r * gk, sc.g * gk * 0.86, sc.b * gk * 0.62);
    /**
     * **The lunar disc rides `adaptLift` too.** It was the last term that did not, and
     * it is the one that matters most for a night frame: the exposure curve lifts the
     * sky, the ambient, the IBL and the moon's *light* by up to 26x while the disc
     * itself stayed at its raw 0.9, so the brightest object in a night sky rendered
     * dimmer than the skyglow around it and read as a grey sticker. A moon is a
     * sunlit rock — it is the one thing in that frame that should clip.
     * The base is retuned down by the same order the lift adds.
     */
    const moonLit = this.moonDiscScale * (0.22 + 0.78 * night) * this.adaptLift;
    u.uMoonDiscRadiance.value.set(moonLit * 0.92, moonLit * 0.95, moonLit);
    u.uMoonGlowColor.value.set(
      this.moonIntensity * 0.9,
      this.moonIntensity * 0.98,
      this.moonIntensity * 1.25
    );
    /**
     * **The night floor has to ride `adaptLift` like everything else.** It was the one
     * term that did not. At full night the exposure curve lifts the ambient, the moon,
     * the IBL and the scattered sky by 26x while these two constants stayed at their
     * raw physical value, so the dome — the thing that is *emitting* that ambient —
     * came out ~50x darker than the ground it was lighting: measured zenith sRGB
     * (1,1,2) against unlit courtyard (37,32,32). Outdoors at night the sky is the
     * source and has to be the brightest thing in frame.
     *
     * The bases are retuned down by the same order the lift adds, so the *product*
     * lands where the old hand-tuned constants were aiming rather than 26x past it.
     */
    const nightLift = this.adaptLift;
    u.uNightSkyColor.value.set(0.00042 * nightLift, 0.00062 * nightLift, 0.00136 * nightLift);
    // Light pollution is sodium and LED spill scattered by the air *above* the city:
    // a broad dome-wide wash that is strongest at the horizon, not a 10-degree band.
    // The shader's falloff was pow(1 - dir.y, 9), which is dead by 20 degrees up and
    // left the sky neutral and gradientless everywhere the camera actually looks.
    const poll = this.lightPollution * nightLift * 0.42;
    u.uPollutionColor.value.set(poll * 1.0, poll * 0.52, poll * 0.2);
    /**
     * **What the night dome adds, published so it can also light something.**
     *
     * `sampleSky()` is the single-scattering integral and nothing else, so after dusk
     * it returns essentially zero — while the dome the player is looking at is drawing
     * airglow plus a whole city's sodium spill on top of it. Lighting projects
     * `sampleSky` into its irradiance SH, so that glow was decorative: a sky that was
     * visibly the brightest thing in frame and contributed not one photon to the street
     * underneath it. This is the same two constants the shader uses, handed over as a
     * radiance so the SH can carry them.
     */
    this._nightSky = this._nightSky || new THREE.Color();
    this._nightSky.setRGB(
      u.uNightSkyColor.value.x + u.uPollutionColor.value.x * 0.35,
      u.uNightSkyColor.value.y + u.uPollutionColor.value.y * 0.35,
      u.uNightSkyColor.value.z + u.uPollutionColor.value.z * 0.35
    );
    u.uGroundLit.value.set(this.groundColor.r, this.groundColor.g, this.groundColor.b);

    // Cirrus sits at ~8 km, so it keeps direct sun long after the ground is dark.
    cpuTransmittance(GROUND_R + 0.0082, this.sunDirection.y, _trB);
    const cirrusFade = clamp01((this.sunDirection.y + 0.10) / 0.09);
    const cirrusK = 2.1 * cirrusFade * this.adaptLift;
    /* The cirrus is lit by the same sun as everything else, so it takes the same grade:
       hue lerped towards the key, magnitude kept at the physical 8.2 km transmittance. */
    {
      const gw = this.gradeWeight || 0;
      const pk = Math.max(_trB[0], _trB[1], _trB[2], 1e-6);
      const nr = _trB[0] / pk;
      const ng = _trB[1] / pk;
      const nb = _trB[2] / pk;
      const k = cirrusK * pk;
      u.uCirrusSunColor.value.set(
        (nr + (sc.r - nr) * gw) * k,
        (ng + (sc.g - ng) * gw) * k,
        (nb + (sc.b - nb) * gw) * k
      );
    }
    u.uCirrusAmbient.value.set(
      this.ambientColor.r * 0.55,
      this.ambientColor.g * 0.55,
      this.ambientColor.b * 0.62
    );

    // Cloud lighting: the key light is the sun by day and the moon at night.
    const useMoon = this.moonIntensity > this.sunIntensity;
    const kd = useMoon ? this.moonDirection : this.sunDirection;
    c.uCloudSunDir.value.copy(kd);
    // Irradiance -> Lambertian-equivalent radiance; the phase term is normalised so
    // an isotropic scatterer is 1, which keeps this in physical units.
    const ki = (useMoon ? this.moonIntensity * 6 : this.sunIntensity) / Math.PI;
    const kc = useMoon ? this.moonColor : this.sunColor;
    c.uCloudSunColor.value.set(kc.r * ki, kc.g * ki, kc.b * ki);
    c.uCloudSkyTop.value.set(this.zenithColor.r * 0.8, this.zenithColor.g * 0.8, this.zenithColor.b * 0.8);
    /**
     * **Cloud undersides at golden hour are not grey.** They were being fed
     * horizon + lit ground and nothing else, which at a 15-degree sun is a pair of terms
     * that have both already had their warmth averaged out of them — hence the review's
     * "cloud undersides are grey at a 3300 K golden hour". The missing term is the one
     * that dominates in reality: the low sun raking the *base* of the deck, which is why
     * a sunset deck lights from below. It rides the same grade weight as the key, so at
     * noon (weight 0) it contributes nothing and the deck stays neutral.
     */
    const under = Math.max(this.sunIntensity, 0) * 0.06 * (this.gradeWeight || 0) * clamp01(1 - this.sunDirection.y / 0.55);
    c.uCloudSkyBottom.value.set(
      this.horizonColor.r * 0.30 + this.groundColor.r * 0.5 + sc.r * under,
      this.horizonColor.g * 0.30 + this.groundColor.g * 0.5 + sc.g * under,
      this.horizonColor.b * 0.30 + this.groundColor.b * 0.5 + sc.b * under
    );
    c.uCloudHaze.value.set(this.horizonColor.r, this.horizonColor.g, this.horizonColor.b);
    c.uCoverage.value = this.coverage;
    c.uCloudType.value = this.cloudType;

    // Aerial perspective / fog.
    const hz = this.haze;
    a.uSkyBetaR.value.set(4.6e-5 * hz, 1.09e-4 * hz, 2.65e-4 * hz);
    a.uSkyBetaM.value = 1.4e-4 * hz;
    /**
     * **Aerial perspective has to converge to the sky, or the skyline out-shines it.**
     *
     * `skyAerialPerspective()` evaluates `colour·T + (sunColour·weight + ambient)·(1-T)`,
     * so the pair below *is* the colour every surface tends to at range. It was authored
     * as two independent fudge factors (0.09 of the solar irradiance, 0.42 of the
     * ambient) with nothing tying them to what the dome behind the same pixel is
     * painting — and the review measured the consequence exactly: distant skyline blocks
     * at L 143.7 with a channel spread of 4.3, "brighter AND greyer than the sky above
     * them". A roofline that is *lighter* than the sky it is silhouetted against is the
     * one thing aerial perspective can never physically do.
     *
     * So solve for it. `weight` is a normalised phase ratio that averages ~1 across the
     * frame, so splitting the horizon radiance 38/62 between a sun-coloured term and a
     * neutral one lands infinite distance on the horizon's own radiance, warmer towards
     * the sun and cooler away from it — which is aerial perspective.
     */
    {
      const hs = this.horizonColor;
      const hLum = Math.max(0.2126 * hs.r + 0.7152 * hs.g + 0.0722 * hs.b, 1e-6);
      const sLum = Math.max(0.2126 * sc.r + 0.7152 * sc.g + 0.0722 * sc.b, 1e-6);
      const k1 = (0.38 * hLum) / sLum;
      const k2 = 0.62;
      const mI = this.moonIntensity * 0.5;
      a.uSkySunColor.value.set(sc.r * k1 + this.moonColor.r * mI, sc.g * k1 + this.moonColor.g * mI, sc.b * k1 + this.moonColor.b * mI);
      a.uSkyAmbientColor.value.set(hs.r * k2, hs.g * k2, hs.b * k2);
    }
    a.uSkySunDir.value.copy(this.keyDirection);

    if (this._fog) {
      this._fog.color.copy(this.fogColor);
    }
    this.ctx.pipeline?.setEnvironmentColors?.(this.horizonColor, this.zenithColor, this.groundColor);
  }

  /* ──────────────────────────────────────────────────────────────────── LUTs */

  _updateLuts(force = false) {
    const renderer = this.ctx.renderer;
    if (!renderer) return;
    if (!force && !this._lutDirty && !this._msDirty) return;

    // The LUTs are built in a canonical frame with the sun at azimuth 0.
    const sy = THREE.MathUtils.clamp(this.sunDirection.y, -1, 1);
    const sz = -Math.sqrt(Math.max(0, 1 - sy * sy));

    if (force || this._msDirty) {
      this._multiScatterPass.render(renderer, this.rtMultiScatter);
      this._lastMsSun.copy(this.sunDirection);
      this._msDirty = false;
    }
    this._skyViewPass.material.uniforms.uSunDirection.value.set(0, sy, sz);
    this._skyViewPass.material.uniforms.uViewHeight.value = this.uAtmos.uViewHeight.value;
    this._skyViewPass.render(renderer, this.rtSkyView);
    this._lastLutSun.copy(this.sunDirection);
    this._lutDirty = false;
  }

  /* ───────────────────────────────────────────────────────────── environment */

  _renderEnvironment(force = false) {
    const renderer = this.ctx.renderer;
    if (!renderer || !this.cubeCamera) return;
    if (!force && !this._envDirty) return;
    this._envDirty = false;

    const cam = this.ctx.camera;
    this.uSky.uCameraPos.value.set(0, Math.max(cam?.position?.y ?? 1.7, 1.0), 0);
    this.envMesh.position.set(0, 0, 0);
    this.envMesh.updateMatrix();
    this.envMesh.updateMatrixWorld(true);
    this.cubeCamera.position.set(0, 0, 0);
    this.cubeCamera.updateMatrixWorld(true);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    try {
      this.cubeCamera.update(renderer, this.envScene);
    } catch (err) {
      this._warn('environment cube render failed', err);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }

    try {
      if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);
      const rt = this._pmrem.fromCubemap(this.cubeRT.texture, this._pmremRT || undefined);
      this._pmremRT = rt;
      this.envTexture = rt.texture;
      this.envTexture.name = 'sky.env';
    } catch (err) {
      // PMREM is an optimisation for IBL; the raw cube is still usable.
      this._warn('PMREM generation failed, exposing the raw cube instead', err);
      this.envTexture = this.cubeRT.texture;
    }
    this.envCubeTexture = this.cubeRT.texture;

    // Only claim scene.environment if nothing else has: Lighting owns IBL when it
    // is real, and we must not stomp on it.
    const scene = this.ctx.scene;
    if (scene && this.envTexture) {
      if (!scene.environment || (this._ownsEnvironment && scene.environment === this._lastEnv)) {
        scene.environment = this.envTexture;
        this._ownsEnvironment = true;
        this._lastEnv = this.envTexture;
      }
    }

    this.ctx.bus?.emit?.('sky:env', { texture: this.envTexture, cubeTexture: this.envCubeTexture });
    for (const fn of this._envListeners) {
      try {
        fn(this.envTexture, this.envCubeTexture);
      } catch {
        /* a listener must never take the sky down */
      }
    }
  }

  /* ──────────────────────────────────────────────────────────────── per frame */

  update(dt) {
    const d = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.25) : 1 / 60;
    this._elapsed += d;
    this.uSky.uTime.value = this._elapsed;

    // Slow advection. Clouds move metres per second, so nothing shimmers.
    this._cloudOffset.x -= this.wind.x * d;
    this._cloudOffset.y -= this.wind.y * d;
    this._weatherOffset.x -= this.wind.x * 0.22 * d;
    this._weatherOffset.y -= this.wind.y * 0.22 * d;
    this._cirrusScroll.x -= this.wind.x * 2.6 * 0.000021 * d;
    this._cirrusScroll.y -= this.wind.y * 2.6 * 0.000021 * d;
    this._mistOffset.x += this.wind.x * 0.09 * d * 0.0035;
    this._mistOffset.y += this.wind.y * 0.09 * d * 0.0035;

    this.uCloud.uCloudWind.value.copy(this._cloudOffset);
    this.uCloud.uWeatherWind.value.copy(this._weatherOffset);
    this.uSky.uCirrusScroll.value.copy(this._cirrusScroll);
    this.aerialUniforms.uSkyMistWind.value.copy(this._mistOffset);

    this._shimLighting();

    try {
      this._updateLuts(false);
    } catch (err) {
      this._warn('LUT update failed', err);
    }

    this._envTimer += d;
    if (this._envDirty && this._envTimer > 0.25) {
      this._envTimer = 0;
      try {
        this._renderEnvironment(false);
      } catch (err) {
        this._warn('environment update failed', err);
      }
    }
  }

  lateUpdate() {
    const ctx = this.ctx;
    const cam = ctx.camera;
    if (!cam) return;
    this._frame++;

    // Dome follows the camera; .xyww in the vertex shader keeps it at infinity.
    this.mesh.position.copy(cam.position);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);

    this.uSky.uCameraPos.value.copy(cam.position);
    this.aerialUniforms.uSkyCamPos.value.copy(cam.position);
    this.uAtmos.uViewHeight.value = GROUND_R + Math.max(cam.position.y, 0) / 1e6 + 0.00006;

    try {
      this._renderClouds(cam);
    } catch (err) {
      this._warn('cloud pass failed, falling back to a clear sky', err);
      this.uDome.uHasClouds.value = 0;
    }
  }

  _renderClouds(cam) {
    const renderer = this.ctx.renderer;
    if (!renderer || !this._cloudRT[0] || this.coverage <= 0.001) {
      this.uDome.uHasClouds.value = 0;
      return;
    }

    /**
     * **Do not re-march a cloud field that has not moved.**
     *
     * The march is 40 steps of Perlin-Worley with a 4-step cone shadow at every one of
     * them, over a quarter-res buffer — by a distance the most expensive thing in the
     * frame that is not the scene itself. It is also temporally accumulated at a 0.9
     * history blend, so it converges in about ten frames and then re-derives the same
     * answer forever. On a *moving* camera that is necessary: the reprojection needs a
     * fresh sample every frame. On a still one it is pure waste, and the screenshot
     * harness holds the camera still for 48 warm frames per pose.
     *
     * Wind is not a reason to re-march either. At 7.5 m/s against an 11.5 km base
     * scale the field advances 0.001 % of a cell per frame; the cadence below lets it
     * accumulate to something a texel can actually resolve before paying for it again.
     */
    const still =
      this._lastCloudCam &&
      this._lastCloudCam.p.distanceToSquared(cam.position) < 1e-6 &&
      Math.abs(this._lastCloudCam.q.dot(cam.quaternion)) > 0.9999995 &&
      this._lastCloudCam.fov === cam.fov;
    if (!this._lastCloudCam) {
      this._lastCloudCam = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov };
    } else {
      this._lastCloudCam.p.copy(cam.position);
      this._lastCloudCam.q.copy(cam.quaternion);
      this._lastCloudCam.fov = cam.fov;
    }
    const interval = this.headless ? 6 : 3;
    this._cloudIdle = still ? (this._cloudIdle || 0) + 1 : 0;
    if (this._cloudReset <= 0 && this._cloudIdle > 8 && this._cloudIdle % interval !== 0) {
      // Keep publishing the last buffer: the dome still needs something to sample.
      this.uDome.uHasClouds.value = this._cloudRT[this._cloudIndex] ? 1 : 0;
      return;
    }

    // A slightly wider frustum than the world camera gives a guard band, so the one
    // frame of camera latency (this runs before CameraRig's lateUpdate) can never
    // expose an unshaded edge.
    const c = this._cloudCam;
    c.fov = Math.min((cam.fov || 75) * 1.18, 150);
    c.aspect = cam.aspect || 16 / 9;
    c.near = 1;
    c.far = 1000;
    c.position.copy(cam.position);
    c.quaternion.copy(cam.quaternion);
    c.updateMatrix();
    c.updateMatrixWorld(true);
    c.updateProjectionMatrix();

    this._cloudPrevViewProj.copy(this._cloudViewProj);
    this._cloudViewProj.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this._cloudInvViewProj.copy(this._cloudViewProj).invert();

    const u = this.uCloudPass;
    u.uInvViewProj.value.copy(this._cloudInvViewProj);
    u.uPrevViewProj.value.copy(this._cloudPrevViewProj);
    u.uCamPos.value.copy(cam.position);
    u.uFrame.value = this._frame % 4096;
    u.uReset.value = this._cloudReset > 0 ? 1 : 0;
    u.uHistoryBlend.value = 0.9;

    const src = this._cloudIndex;
    const dst = 1 - src;
    u.tHistory.value = this._cloudRT[src].texture;
    this._cloudPass.render(renderer, this._cloudRT[dst]);
    this._cloudIndex = dst;

    this.uDome.tClouds.value = this._cloudRT[dst].texture;
    this.uDome.uCloudViewProj.value.copy(this._cloudViewProj);
    this.uDome.uHasClouds.value = 1;
    if (this._cloudReset > 0) this._cloudReset--;
  }

  /**
   * The screenshot harness drives time of day through `ctx.lighting.setTimeOfDay`.
   * If Lighting has not implemented it yet, forward it here rather than silently
   * rendering every pose at the same hour. A real implementation always wins.
   */
  _shimLighting() {
    if (this._shimmedLighting) return;
    const L = this.ctx.lighting;
    if (!L) return;
    this._shimmedLighting = true;
    try {
      const prev = L.setTimeOfDay;
      if (typeof prev === 'function') {
        // Chain rather than replace: Lighting stays in charge of its own state and
        // the sky simply also hears about it. setTimeOfDay() early-outs on an
        // unchanged hour, so forwarding twice costs nothing.
        L.setTimeOfDay = (h) => {
          const r = prev.call(L, h);
          this.setTimeOfDay(h);
          return r;
        };
      } else {
        L.setTimeOfDay = (h) => this.setTimeOfDay(h);
      }
    } catch {
      /* frozen or accessor-only object: nothing to do */
    }
    if (!L.sunDirection) {
      try {
        L.sunDirection = this.sunDirection;
      } catch {
        /* ignore */
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────── public API */

  /** CPU evaluation of the same scattering model, for gameplay/tools code. */
  sampleSky(dir, target = new THREE.Color()) {
    const d = this._tmpV.copy(dir).normalize();
    const sunY = this.sunDirection.y;
    const cosL = d.dot(this.sunDirection);
    const viewH = GROUND_R + 0.00006;
    // Work in the canonical plane: only the vertical component and the sun angle
    // matter for a spherically symmetric atmosphere.
    const dy = d.y;
    const dz = -Math.sqrt(Math.max(0, 1 - dy * dy));
    cpuSkyRadiance(dy, dz, sunY, cosL, viewH, this._rad);
    const s = this.exposureScale * this.adaptLift * 1.42;
    return target.setRGB(
      Math.max(this._rad[0] * s, 0),
      Math.max(this._rad[1] * s, 0),
      Math.max(this._rad[2] * s, 0)
    );
  }

  applyAerialPerspective(material) {
    if (!material || material.userData?.__skyAerial) return material;
    const uniforms = this.aerialUniforms;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      if (typeof prev === 'function') {
        try {
          prev.call(this, shader, renderer);
        } catch {
          /* keep going: our chunk still needs to land */
        }
      }
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = `${AERIAL_PARS_VERT}\n${shader.vertexShader}`;
      if (shader.vertexShader.includes('#include <fog_vertex>')) {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>\n${AERIAL_VERT_BODY}`
        );
      } else {
        shader.vertexShader = shader.vertexShader.replace(/\}\s*$/, `${AERIAL_VERT_BODY}\n}`);
      }
      shader.fragmentShader = `${AERIAL_PARS_FRAG}\n${shader.fragmentShader}`;
      if (shader.fragmentShader.includes('#include <fog_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', AERIAL_APPLY_FRAG);
      } else {
        shader.fragmentShader = shader.fragmentShader.replace(/\}\s*$/, `${AERIAL_APPLY_FRAG}\n}`);
      }
    };
    const prevKey = material.customProgramCacheKey;
    material.customProgramCacheKey = function () {
      const base = typeof prevKey === 'function' ? prevKey.call(this) : '';
      return `${base}|sky-aerial`;
    };
    material.userData = material.userData || {};
    material.userData.__skyAerial = true;
    material.needsUpdate = true;
    return material;
  }

  installSceneFog(enabled = true) {
    const scene = this.ctx.scene;
    if (!scene) return false;
    if (!enabled) {
      if (this._fog && scene.fog === this._fog) scene.fog = null;
      this._fog = null;
      return true;
    }
    if (scene.fog && scene.fog !== this._fog) return false; // someone else owns it
    if (!this._fog) this._fog = new THREE.FogExp2(this.fogColor.getHex(), 0.0011);
    this._fog.color.copy(this.fogColor);
    scene.fog = this._fog;
    this._ownsFog = true;
    return true;
  }

  setCloudCoverage(v) {
    this.coverage = clamp01(v);
    this.uCloud.uCoverage.value = this.coverage;
    this._envDirty = true;
  }
  setCloudType(v) {
    this.cloudType = clamp01(v);
    this.uCloud.uCloudType.value = this.cloudType;
  }
  setCirrus(v) {
    this.cirrusAmount = clamp01(v);
    this.uSky.uCirrusAmount.value = this.cirrusAmount;
  }
  setWind(x, z) {
    this.wind.set(x, z);
  }
  setHaze(k) {
    this.haze = Math.max(0, k);
    this._recomputeLighting();
  }
  setStarBrightness(v) {
    this.starBrightness = Math.max(0, v);
    this.uSky.uStarBrightness.value = this.starBrightness;
  }
  setExposureScale(k) {
    this.exposureScale = Math.max(0.01, k);
    this._recomputeLighting(); // republishes uSkyScale with the adaptation applied
  }
  onEnvUpdate(fn) {
    if (typeof fn !== 'function') return () => {};
    this._envListeners.push(fn);
    if (this.envTexture) {
      try {
        fn(this.envTexture, this.envCubeTexture);
      } catch {
        /* ignore */
      }
    }
    return () => {
      const i = this._envListeners.indexOf(fn);
      if (i >= 0) this._envListeners.splice(i, 1);
    };
  }

  _warn(msg, err) {
    if (this._warned) return;
    this._warned = true;
    console.warn(`[sky] ${msg}`, err || '');
  }

  dispose() {
    for (const off of this._unsub) {
      try {
        off();
      } catch {
        /* best effort */
      }
    }
    this._unsub.length = 0;
    this._envListeners.length = 0;

    if (this.mesh) this.ctx.scene?.remove(this.mesh);
    if (this._fog && this.ctx.scene?.fog === this._fog) this.ctx.scene.fog = null;
    if (this._ownsEnvironment && this.ctx.scene?.environment === this.envTexture) {
      this.ctx.scene.environment = null;
    }

    this.mesh?.geometry?.dispose();
    this.material?.dispose();
    this.materialEnv?.dispose();
    this._transmittancePass?.dispose();
    this._multiScatterPass?.dispose();
    this._skyViewPass?.dispose();
    this._cloudPass?.dispose();
    this.rtTransmittance?.dispose();
    this.rtMultiScatter?.dispose();
    this.rtSkyView?.dispose();
    this._cloudRT?.[0]?.dispose();
    this._cloudRT?.[1]?.dispose();
    this.cubeRT?.dispose();
    this._pmremRT?.dispose();
    this._pmrem?.dispose();
    this.texShape?.dispose();
    this.texDetail?.dispose();
    this.texWeather?.dispose();
    this.texCirrus?.dispose();
    this.texGalaxy?.dispose();
    this.ready = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════ factory ══ */

/** @returns {import('../core/types.js').System} */
export default function createSky(ctx) {
  const sky = new Sky(ctx);

  // A complete API surface exists from the first line so nothing downstream can
  // trip over `undefined`, even if init() degrades.
  const api = {
    ready: false,
    _impl: sky,
    setTimeOfDay: (h) => sky.setTimeOfDay(h),
    setSunStaging: (o) => sky.setSunStaging(o),
    get sunStaging() {
      return { ...sky._sunStaging };
    },
    sampleSky: (d, t) => sky.sampleSky(d, t),
    applyAerialPerspective: (m) => sky.applyAerialPerspective(m),
    installSceneFog: (v) => sky.installSceneFog(v),
    setCloudCoverage: (v) => sky.setCloudCoverage(v),
    setCloudType: (v) => sky.setCloudType(v),
    setCirrus: (v) => sky.setCirrus(v),
    setWind: (x, z) => sky.setWind(x, z),
    setHaze: (k) => sky.setHaze(k),
    setStarBrightness: (v) => sky.setStarBrightness(v),
    setExposureScale: (k) => sky.setExposureScale(k),
    onEnvUpdate: (fn) => sky.onEnvUpdate(fn),
    get timeOfDay() {
      return sky.hours;
    },
    get sunDirection() {
      return sky.sunDirection;
    },
    get moonDirection() {
      return sky.moonDirection;
    },
    get keyDirection() {
      return sky.keyDirection;
    },
    get sunColor() {
      return sky.sunColor;
    },
    get moonColor() {
      return sky.moonColor;
    },
    get keyColor() {
      return sky.keyColor;
    },
    get sunIntensity() {
      return sky.sunIntensity;
    },
    get moonIntensity() {
      return sky.moonIntensity;
    },
    get keyIntensity() {
      return sky.keyIntensity;
    },
    get sunAltitude() {
      return sky.sunAltitude;
    },
    get skyLuminance() {
      return sky.skyLuminance;
    },
    get adaptation() {
      return sky.adaptLift;
    },
    get physLuminance() {
      return sky.physLuminance;
    },
    get starVisibility() {
      return sky.starVisibility;
    },
    get nightFactor() {
      return sky.nightFactor;
    },
    get zenithColor() {
      return sky.zenithColor;
    },
    get horizonColor() {
      return sky.horizonColor;
    },
    get groundColor() {
      return sky.groundColor;
    },
    get fogColor() {
      return sky.fogColor;
    },
    get ambientColor() {
      return sky.ambientColor;
    },
    /**
     * Radiance floor the dome paints after dusk (airglow + light pollution) that
     * `sampleSky()` knows nothing about. Consumers projecting the sky into an
     * irradiance basis must add it, or the night sky lights nothing. See `_pushUniforms`.
     */
    get nightSkyColor() {
      return sky._nightSky || null;
    },
    /** Current cloud cover, 0..1 — the CPU sky model does not include the deck. */
    get cloudCoverage() {
      return sky.coverage;
    },
    get envTexture() {
      return sky.envTexture;
    },
    get envCubeTexture() {
      return sky.envCubeTexture;
    },
    get aerialUniforms() {
      return sky.aerialUniforms;
    },
    aerialGLSL: {
      parsVertex: AERIAL_PARS_VERT,
      vertexBody: AERIAL_VERT_BODY,
      parsFragment: AERIAL_PARS_FRAG,
      applyFragment: AERIAL_APPLY_FRAG,
    },
  };

  return {
    name: 'sky',
    order: 22,
    async init() {
      ctx.sky = api;
      try {
        sky.init();
        sky.installSceneFog(true);
        api.ready = true;
      } catch (err) {
        // Never take the frame down: a broken sky must still leave a lit horizon.
        console.warn('[sky] init failed, falling back to a flat gradient:', err);
        sky.broken = true;
        try {
          if (ctx.scene && !ctx.scene.background) {
            ctx.scene.background = new THREE.Color(0.32, 0.42, 0.58);
          }
        } catch {
          /* ignore */
        }
      }
    },
    update(dt) {
      if (!sky.ready || sky.broken) return;
      sky.update(dt);
    },
    lateUpdate() {
      if (!sky.ready || sky.broken) return;
      sky.lateUpdate();
    },
    resize(w, h) {
      if (!sky.ready || sky.broken) return;
      try {
        sky.setSize(w, h);
      } catch (err) {
        console.warn('[sky] resize failed:', err);
      }
    },
    dispose() {
      try {
        sky.dispose();
      } catch {
        /* teardown is best-effort */
      }
    },
  };
}
