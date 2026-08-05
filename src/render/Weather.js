/**
 * Weather — presets, precipitation, wetness, atmosphere and lightning.
 * Owner: weather agent. Files owned: this file + src/render/weather/**.
 * Publishes: `ctx.weather`.
 *
 * ── The one idea ────────────────────────────────────────────────────────────────
 * A weather preset is a single flat record of numbers (src/render/weather/presets.js).
 * `setPreset(name, seconds)` cross-fades that whole record, and every frame the *live*
 * record is pushed out to the modules that own the actual rendering:
 *
 *   ctx.sky        cloud coverage / type / cirrus / haze / cloud drift, and the two
 *                  aerial-perspective uniform vectors (`uSkyFog`, `uSkyMist`) that
 *                  every extended material in the world already samples
 *   ctx.lighting   sun brightness via `setExposureCompensation`, plus a real pooled
 *                  point light for each lightning strike
 *   ctx.materials  `setWetness` / `setDustLevel` / `setWind` — the shared globals the
 *                  material library documents, so wetness, wind and dust reach every
 *                  surface, foliage card and decal at once
 *   ctx.pipeline   volumetric fog density / colour / anisotropy, and the colour grade
 *                  (white balance, saturation, contrast) for the overall cast
 *   own geometry   rain, splashes, ripples, drips, motes, grit, mist, litter
 *   own overlay    lens droplets, heat shimmer, lightning flash
 *
 * Because there is exactly one source of truth, you cannot change the particles
 * without also changing the light, the fog and the wind — which is the point.
 *
 * ── Occlusion ───────────────────────────────────────────────────────────────────
 * `weather/ShelterMap.js` bakes a top-down depth render of the level into a small
 * height field, uploaded as a half-float texture. Rain, splashes, ripples, motes and
 * the lens droplets all test it, so nothing falls through a roof — for one texture
 * fetch instead of a raycast per particle. `weather/WetnessMask.js` feeds the same
 * field into the material library's wetness block so sheltered *surfaces* stay dry
 * too; it is applied lazily, the first time water is actually on its way, because it
 * costs a shader recompile that clear weather should never pay.
 *
 * ── Files ───────────────────────────────────────────────────────────────────────
 *   weather/presets.js       the seven records and the cross-fade maths
 *   weather/ShelterMap.js    the top-down bake: topAt / groundAt / openSky / exposure,
 *                            plus the roof lips that drip and the cells that pool
 *   weather/Precipitation.js rain, splashes, ripples, drips
 *   weather/Atmospherics.js  motes, grit, ground mist, litter
 *   weather/LensOverlay.js   droplets on the front element, heat haze, lightning flash
 *   weather/WetnessMask.js   per-pixel "is this under a roof?" for wetness
 *   weather/shaders.js       every GLSL string the above share
 *
 * ── Quality ─────────────────────────────────────────────────────────────────────
 * On `low` every particle system and the screen-space overlay are switched off, but
 * the sky, sun, fog, grade, wetness and wind still cross-fade — so the preset still
 * completely changes the mood of the frame, just without the geometry.
 *
 * ── Public API (ctx.weather) ────────────────────────────────────────────────────
 *   setPreset(name, seconds = 8)   cross-fade to a preset; returns the canonical name
 *   get()                          { preset, target, blend, wetness, wind, ...state }
 *   setWind(dir, strength)         dir: radians | {x,z} | [x,z]; strength m/s
 *   setWetness(v)                  0..1 override target; released by the next preset
 *   lightning(opts)                force a strike now
 *   presets()                      the list of names
 *   rebuildShelter()               re-bake after the world geometry changes
 *   shelter                        the ShelterMap (topAt / groundAt / openSky / exposure)
 *   state                          the live cross-faded record (read-only)
 *   ready
 *
 * ── Events ──────────────────────────────────────────────────────────────────────
 *   emits  `weather:changed`   {preset, coverage, cirrus, haze, wind, wetness, ...}
 *          `weather:wind`      {direction, strength, x, z}
 *          `weather:wetness`   {wetness}
 *          `weather:lightning` {point, distance, intensity}
 *          `weather:thunder`   {distance, delay, loudness}
 *   listens `quality:changed`, `boot:done`, `level:ready`, `debug:pose`
 *           ({weather:'storm'} | {weather:{preset, seconds}} | {wetness} | {wind})
 */
import * as THREE from 'three';
import { ShelterMap } from './weather/ShelterMap.js';
import { Precipitation } from './weather/Precipitation.js';
import { Atmospherics } from './weather/Atmospherics.js';
import { LensOverlay } from './weather/LensOverlay.js';
import { WetnessMask } from './weather/WetnessMask.js';
import {
  PRESETS,
  PRESET_NAMES,
  resolvePreset,
  cloneRecord,
  lerpRecord,
  lerpAngle,
} from './weather/presets.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smootherstep: no velocity *or* acceleration discontinuity at either end. */
const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);

const DEFAULT_PRESET = 'clear';

/** Particle counts per tier. Halved again when the harness runs headless. */
const BUDGETS = {
  low: { rain: 0, splash: 0, ripple: 0, drip: 0, motes: 0, grit: 0, mist: 0, litter: 0 },
  medium: { rain: 3200, splash: 220, ripple: 120, drip: 90, motes: 420, grit: 1100, mist: 90, litter: 90 },
  high: { rain: 7000, splash: 420, ripple: 220, drip: 180, motes: 900, grit: 2400, mist: 170, litter: 190 },
  ultra: { rain: 12000, splash: 620, ripple: 320, drip: 260, motes: 1500, grit: 4000, mist: 260, litter: 300 },
};

class Weather {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = false;
    this.broken = false;
    this._warned = new Set();

    this.preset = DEFAULT_PRESET;
    this.targetPreset = DEFAULT_PRESET;
    this.state = cloneRecord(PRESETS[DEFAULT_PRESET]);
    this._from = cloneRecord(PRESETS[DEFAULT_PRESET]);
    this._to = cloneRecord(PRESETS[DEFAULT_PRESET]);
    this._fadeT = 1;
    this._fadeDur = 1;

    // Wind and wetness carry their own state because both have manual overrides and
    // both must survive a preset change smoothly.
    this.windAngle = this.state.windDir;
    this.windSpeed = this.state.windSpeed;
    this._windOverride = null;
    this.wetness = this.state.wetness;
    this._wetOverride = null;

    this.wind = new THREE.Vector3();
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._sunColor = new THREE.Color(1, 0.95, 0.86);
    this._sunIntensity = 8;
    this._specColor = new THREE.Color(0.75, 0.82, 1.0);
    this._v = new THREE.Vector3();
    this._flashOrigin = new THREE.Vector2(0.5, 0.85);
    this._flashColor = new THREE.Color(0.78, 0.86, 1.0);

    this.shelter = new ShelterMap(ctx);
    this.precip = new Precipitation(ctx, this.shelter);
    this.atmos = new Atmospherics(ctx, this.shelter);
    this.wetMask = new WetnessMask(ctx, this.shelter);
    this.lens = null;

    this.group = new THREE.Group();
    this.group.name = 'weather';
    this.group.userData.noShelter = true;
    this.group.add(this.precip.group, this.atmos.group);

    // Lightning.
    this.strikes = [];
    this.thunderQueue = [];
    this._strikeTimer = 6;
    this.flash = 0;
    this.flashSpread = 0.6;
    this._exposureResponse = 1;

    this._gradeBase = null;
    /** Last value handed to each sky setter, so we never re-send an unchanged one. */
    this._skySent = {};
    this._lastPublish = -1e9;
    this._bakePending = 2;
    this._unsub = [];
    this._tier = ctx.settings?.tier || 'high';
    this._headless = !!ctx.settings?.get?.('headless');
    this._elapsed = 0;
    this.budget = { rain: 0, splash: 0, ripple: 0, drip: 0, motes: 0, grit: 0, mist: 0, litter: 0 };
  }

  /* ───────────────────────────────────────────────────────────────────── init */

  init() {
    const ctx = this.ctx;
    ctx.scene?.add(this.group);

    try {
      this.lens = new LensOverlay(ctx);
      const dpr = ctx.renderer?.getPixelRatio?.() ?? 1;
      this.lens.setSize(
        (window.innerWidth || 1280) * dpr,
        (window.innerHeight || 720) * dpr
      );
    } catch (err) {
      this._warn('lens', err);
      this.lens = null;
    }

    this._rebuildBudgets();
    this._snapshotGrade();
    this._bind();
    // Push the opening state everywhere before the first frame is drawn.
    this._apply(0, true);
    this.ready = true;
  }

  _bind() {
    const bus = this.ctx.bus;
    if (!bus?.on) return;
    const on = (ev, fn) => {
      const off = bus.on(ev, fn);
      if (typeof off === 'function') this._unsub.push(off);
    };
    on('quality:changed', ({ tier }) => {
      this._tier = tier || this.ctx.settings?.tier || 'high';
      try {
        this._rebuildBudgets();
      } catch (err) {
        this._warn('quality', err);
      }
    });
    // The shelter bake has to happen after the level, props, foliage and destruction
    // have all published their geometry — which is exactly what boot:done means.
    on('boot:done', () => {
      this._bakePending = 1;
    });
    on('level:ready', () => {
      this._bakePending = 2;
    });
    on('debug:pose', (s) => {
      if (!s) return;
      try {
        if (typeof s.weather === 'string') this.setPreset(s.weather, 0);
        else if (s.weather && typeof s.weather === 'object') {
          this.setPreset(s.weather.preset ?? s.weather.name, s.weather.seconds ?? 0);
        }
        if (Number.isFinite(s.wetness)) this.setWetness(s.wetness, true);
        if (s.wind) this.setWind(s.wind.direction ?? s.wind.dir ?? s.wind, s.wind.strength);
        if (s.lightning) this.lightning();
      } catch (err) {
        this._warn('pose', err);
      }
    });
  }

  _rebuildBudgets() {
    const tier = this._tier in BUDGETS ? this._tier : 'high';
    const src = BUDGETS[tier];
    const scale = this._headless ? 0.35 : 1;
    const cap = this.ctx.settings?.get?.('particleBudget') ?? 10000;
    const b = {};
    for (const k of Object.keys(src)) b[k] = Math.round(src[k] * scale);
    // The tier table is the real control; this is a backstop for anyone who lowers
    // `particleBudget` by hand. Rain and grit are the only two counts big enough to
    // matter, and both are pure vertex work — no simulation, no readback.
    const total = b.rain + b.grit;
    const room = Math.max(600, cap);
    if (total > room) {
      const f = room / total;
      b.rain = Math.round(b.rain * f);
      b.grit = Math.round(b.grit * f);
    }
    this.budget = b;
    try {
      this.precip.build(b);
      this.atmos.build(b);
    } catch (err) {
      this._warn('build', err);
    }
    if (this.lens) this.lens.enabled = tier !== 'low';
  }

  /** Read the grade knobs once so every write is absolute, never cumulative. */
  _snapshotGrade() {
    const g = this.ctx.pipeline?.grade;
    if (!g || this._gradeBase) return;
    const vec = (v) => (v && Number.isFinite(v.x) ? [v.x, v.y, v.z] : null);
    this._gradeBase = {
      whiteBalance: vec(g.whiteBalance) || [1, 1, 1],
      gain: vec(g.gain) || [1, 1, 1],
      saturation: Number.isFinite(g.saturation) ? g.saturation : 1,
      contrast: Number.isFinite(g.contrast) ? g.contrast : 1,
    };
  }

  /* ───────────────────────────────────────────────────────────────────── API */

  setPreset(name, seconds = 8) {
    const key = resolvePreset(name);
    if (!key) {
      this._warn('preset', new Error(`unknown weather preset "${name}"`));
      return this.targetPreset;
    }
    // Fade from wherever we actually are, not from the last preset's table entry:
    // interrupting a fade half way must not snap.
    this._from = cloneRecord(this.state);
    this._from.windDir = this.windAngle;
    this._from.windSpeed = this.windSpeed;
    this._from.wetness = this.wetness;
    this._to = cloneRecord(PRESETS[key]);
    this.targetPreset = key;
    const d = Number(seconds);
    this._fadeDur = Number.isFinite(d) && d > 0.016 ? d : 0.0001;
    this._fadeT = 0;
    // A new preset takes back the wetness and wind the caller had overridden.
    this._wetOverride = null;
    this._windOverride = null;
    if (this._fadeDur <= 0.0002) {
      this._fadeT = 1;
      this.preset = key;
      lerpRecord(this.state, this._from, this._to, 1);
      this.windAngle = this._to.windDir;
      this.windSpeed = this._to.windSpeed;
      this.wetness = this._to.wetness;
      this._apply(0, true);
    }
    this._strikeTimer = Math.min(this._strikeTimer, 4);
    return key;
  }

  get() {
    return {
      preset: this.preset,
      target: this.targetPreset,
      blend: clamp01(this._fadeT),
      wetness: this.wetness,
      wind: { direction: this.windAngle, strength: this.windSpeed, x: this.wind.x, z: this.wind.z },
      rain: this.state.rain,
      dust: this.state.dust,
      visibility: this.state.visibility,
      lightning: this.state.lightning,
      sheltered: this._exposure ?? 1,
      shelterReady: !!this.shelter.ready,
      wetMask: this.wetMask.stats(),
      state: this.state,
    };
  }

  /** @param {number|{x:number,z:number}|number[]} dir @param {number} [strength] */
  setWind(dir, strength) {
    let angle = this.windAngle;
    if (Number.isFinite(dir)) angle = dir;
    else if (dir && Number.isFinite(dir.x)) angle = Math.atan2(dir.z ?? dir.y ?? 0, dir.x);
    else if (Array.isArray(dir) && dir.length >= 2) angle = Math.atan2(dir[1], dir[0]);
    const speed = Number.isFinite(strength) ? clamp(strength, 0, 40) : this.windSpeed;
    this._windOverride = { angle, speed };
    this.windAngle = angle;
    this.windSpeed = speed;
    return { direction: angle, strength: speed };
  }

  setWetness(v, immediate = false) {
    const t = clamp01(Number(v) || 0);
    this._wetOverride = t;
    if (immediate) this.wetness = t;
    return t;
  }

  presets() {
    return PRESET_NAMES.slice();
  }

  rebuildShelter() {
    this._bakePending = 1;
    return true;
  }

  /* ───────────────────────────────────────────────────────────── lightning */

  /**
   * One strike: a real pooled point light with inverse-square falloff, an additive
   * screen flash for the sky and the air, a short exposure clamp-down afterwards, and
   * a thunder cue delayed by the speed of sound.
   * @param {{point?:THREE.Vector3, distance?:number, intensity?:number}} [opts]
   */
  lightning(opts = {}) {
    const ctx = this.ctx;
    const rng = ctx.rng || Math.random;
    const cam = ctx.camera?.position || this._v.set(0, 1.7, 0);

    let point = opts.point;
    if (!point) {
      const dist = Number.isFinite(opts.distance) ? opts.distance : 90 + rng() * 420;
      const a = rng() * Math.PI * 2;
      point = new THREE.Vector3(
        cam.x + Math.cos(a) * dist,
        (ctx.level?.bounds?.max?.y ?? 24) + 55 + rng() * 130,
        cam.z + Math.sin(a) * dist
      );
    } else {
      point = point.clone();
    }

    const dist = Math.max(20, point.distanceTo(cam));
    const near = clamp01(1 - (dist - 60) / 420);
    // Peak illuminance at the camera, in the same render units as the sun. A close
    // bolt genuinely overexposes; a distant one is a flicker on the clouds.
    const peak = (Number.isFinite(opts.intensity) ? opts.intensity : 5 + 22 * near * near) *
      (0.7 + 0.6 * rng());
    const radius = Math.max(dist * 2.4, 400);
    // Invert exactly the falloff three applies to a decay-2 point light with a
    // cutoff distance — `(1 - (d/R)^4)^2 / d^2` — so `peak` is the illuminance that
    // actually lands on the camera, in the same units as the sun.
    const ratio = Math.min(0.999, dist / radius);
    const win = Math.max(0.02, (1 - ratio * ratio * ratio * ratio) ** 2);
    const candela = (peak * dist * dist) / win;

    let handle = null;
    try {
      handle = ctx.lighting?.addLight?.({
        type: 'point',
        position: point,
        kelvin: 7600,
        intensity: 0,
        radius,
        castShadow: false,
        priority: 24,
      });
    } catch (err) {
      this._warn('strike', err);
    }

    // Return-stroke train: a bright leader, a gap, then one or two restrikes.
    const flickers = [{ t: 0.0, a: 1.0, d: 0.075 }];
    const extra = 1 + ((rng() * 2.4) | 0);
    let tt = 0.09 + rng() * 0.06;
    for (let i = 0; i < extra; i++) {
      flickers.push({ t: tt, a: 0.45 + rng() * 0.55, d: 0.05 + rng() * 0.09 });
      tt += 0.055 + rng() * 0.13;
    }
    const life = tt + 0.35;

    this.strikes.push({ handle, point, dist, candela, peak, flickers, life, age: 0 });

    const delay = dist / 343;
    const loudness = clamp01(1.1 - dist / 900);
    this.thunderQueue.push({ t: delay, dist, loudness, point });

    this.ctx.bus?.emit?.('weather:lightning', {
      point: point.clone(),
      distance: dist,
      intensity: peak,
    });
    return { point, distance: dist, delay };
  }

  _updateLightning(dt) {
    const rain = this.state.rain;
    const rate = this.state.lightning * clamp01(rain * 1.4 + 0.1);
    if (rate > 0.05) {
      this._strikeTimer -= dt;
      if (this._strikeTimer <= 0) {
        const rng = this.ctx.rng || Math.random;
        const mean = 60 / rate;
        // Poisson-ish spacing: storms cluster, they do not tick.
        this._strikeTimer = mean * (0.35 + 1.4 * rng() * rng());
        try {
          this.lightning();
        } catch (err) {
          this._warn('strike', err);
        }
      }
    } else {
      this._strikeTimer = Math.max(this._strikeTimer, 3);
    }

    // Lighting scales every local light by its exposure compensation — which *we*
    // just pulled down to 0.17 for the storm. A bolt does not get dimmer because the
    // sky is overcast, so divide that back out.
    const localScale = this.ctx.lighting?._impl?.localLightScale;
    const unscale = Number.isFinite(localScale) && localScale > 1e-3 ? 1 / localScale : 1;

    let flash = 0;
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.age += dt;
      let amp = 0;
      for (const f of s.flickers) {
        const u = s.age - f.t;
        if (u < 0 || u > f.d * 4) continue;
        // Fast rise, exponential decay — the shape of a real return stroke.
        amp += f.a * Math.min(1, u / 0.006) * Math.exp(-u / f.d);
      }
      amp = Math.min(amp, 1.6);
      if (s.handle) s.handle.intensity = s.candela * amp * unscale;
      // The screen lift follows the same envelope but saturates much sooner: the
      // sky is already near the top of the range before the bolt arrives.
      flash = Math.max(flash, Math.min(1.35, (s.peak / 14) * amp));
      if (s.age > s.life) {
        try {
          if (s.handle) this.ctx.lighting?.removeLight?.(s.handle);
        } catch {
          /* the light manager may already have dropped it */
        }
        this.strikes.splice(i, 1);
      }
    }
    this.flash = flash;

    // Exposure response: the camera clamps down after a flash and opens back up.
    const want = flash > 0.02 ? clamp(1 - flash * 0.16, 0.62, 1) : 1;
    const k = want < this._exposureResponse ? 12 : 0.9;
    this._exposureResponse += (want - this._exposureResponse) * clamp01(dt * k);

    // Where is the bolt on screen? Only used to bias the additive glow.
    const cam = this.ctx.camera;
    if (flash > 0.02 && this.strikes.length && cam) {
      const s = this.strikes[0];
      this._v.copy(s.point).project(cam);
      const behind = this._v.z > 1 || !Number.isFinite(this._v.x);
      this._flashOrigin.set(
        behind ? 0.5 : clamp(this._v.x * 0.5 + 0.5, -0.5, 1.5),
        behind ? 0.95 : clamp(this._v.y * 0.5 + 0.5, -0.5, 1.5)
      );
      this.flashSpread = clamp01(0.25 + s.dist / 500);
    }

    for (let i = this.thunderQueue.length - 1; i >= 0; i--) {
      const q = this.thunderQueue[i];
      q.t -= dt;
      if (q.t > 0) continue;
      this.thunderQueue.splice(i, 1);
      try {
        this.ctx.audio?.play?.(q.dist > 260 ? 'thunder_distant' : 'thunder', {
          position: q.point,
          volume: 0.35 + 0.65 * q.loudness,
          // A close crack is sharp; a distant one is a long low roll.
          pitch: clamp(1.15 - q.dist / 900, 0.55, 1.2),
        });
      } catch {
        /* audio is allowed to be a stub */
      }
      this.ctx.bus?.emit?.('weather:thunder', {
        distance: q.dist,
        loudness: q.loudness,
        point: q.point,
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────── per frame */

  update(dt) {
    if (this.broken) return;
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 1 / 60;
    this._elapsed += d;

    if (this._bakePending > 0) {
      this._bakePending--;
      if (this._bakePending === 0) this._bake();
    }

    if (this._fadeT < 1) {
      this._fadeT = Math.min(1, this._fadeT + d / this._fadeDur);
      const t = ease(this._fadeT);
      lerpRecord(this.state, this._from, this._to, t);
      // Direction has to take the short way round; the record lerp cannot know that.
      this.state.windDir = lerpAngle(this._from.windDir, this._to.windDir, t);
      if (this._fadeT >= 1) this.preset = this.targetPreset;
      else if (t > 0.5) this.preset = this.targetPreset;
    }

    // Lightning first: `_apply` reads the flash envelope and the exposure response it
    // produces, and a frame's delay on a 75 ms flash is a visible stutter.
    this._updateLightning(d);
    this._apply(d, false);
  }

  _bake() {
    try {
      const res = this._headless ? 256 : this._tier === 'low' ? 256 : 512;
      const ok = this.shelter.build(res);
      if (ok) {
        this.precip.build(this.budget); // drips are baked from the new edge list
        this.atmos.attachShelter();
        this.wetMask.attachShelter();
      }
    } catch (err) {
      this._warn('bake', err);
    }
  }

  /** Push the live record at every module that owns a piece of the look. */
  _apply(dt, force) {
    const ctx = this.ctx;
    const s = this.state;

    // ── wind ────────────────────────────────────────────────────────────────
    if (this._windOverride) {
      this.windAngle = this._windOverride.angle;
      this.windSpeed = this._windOverride.speed;
    } else {
      this.windAngle = s.windDir;
      this.windSpeed = s.windSpeed;
    }
    // Gusts are deterministic (no RNG) so screenshots stay byte-identical.
    const t = this._elapsed;
    const gust =
      1 +
      s.gust * (0.34 * Math.sin(t * 0.31) + 0.2 * Math.sin(t * 0.83 + 1.7) + 0.1 * Math.sin(t * 1.9));
    const speed = this.windSpeed * gust;
    const sway = 0.16 * s.gust * Math.sin(t * 0.19 + 0.6);
    const ang = this.windAngle + sway;
    this.wind.set(Math.cos(ang) * speed, 0, Math.sin(ang) * speed);

    // ── wetness: soaks in slowly, dries out much more slowly ────────────────
    const wetTarget = this._wetOverride !== null ? this._wetOverride : s.wetness;
    if (force) {
      this.wetness = wetTarget;
    } else {
      // ~20 s to soak, ~90 s to dry. Never a step, in either direction.
      const rate = wetTarget > this.wetness ? 1 / 20 : 1 / 90;
      this.wetness += (wetTarget - this.wetness) * clamp01(dt * rate * 6);
    }
    // Per-pixel "is this under a roof?" for the wetness. Deliberately lazy: patching
    // costs a shader recompile, so clear weather never pays for it, and rain has the
    // whole cross-fade to absorb it.
    if (this.wetness > 0.004 || wetTarget > 0.01) {
      this.wetMask.scan(ctx.time?.frame ?? 0);
    }

    // ── sky ─────────────────────────────────────────────────────────────────
    const sky = ctx.sky;
    if (sky) {
      try {
        // Only when it actually moved: setHaze re-runs the sky's whole lighting
        // solve, and a preset fade would otherwise call it 480 times.
        const set = (key, fn, v, eps = 1e-3) => {
          const prev = this._skySent[key];
          if (prev !== undefined && Math.abs(prev - v) < eps) return;
          this._skySent[key] = v;
          fn?.call(sky, v);
        };
        set('coverage', sky.setCloudCoverage, clamp01(s.coverage));
        set('cloudType', sky.setCloudType, clamp01(s.cloudType));
        set('cirrus', sky.setCirrus, clamp01(s.cirrus));
        set('haze', sky.setHaze, Math.max(0.05, s.haze), 4e-3);
        // Cloud drift, in the sky's own units — a fraction of the ground wind.
        sky.setWind?.(this.wind.x * 0.06, this.wind.z * 0.06);
        const a = sky.aerialUniforms;
        if (a) {
          a.uSkyFog?.value.set(
            Math.max(0, s.fogDensity),
            1 / Math.max(20, s.fogHeight),
            a.uSkyFog.value.z,
            Math.max(0, s.fogStrength)
          );
          a.uSkyMist?.value.set(
            Math.max(0, s.mistDensity),
            Math.max(2, s.mistTop),
            Math.max(1e-4, s.mistScale),
            1
          );
        }
      } catch (err) {
        this._warn('sky', err);
      }
    }

    // ── sun ─────────────────────────────────────────────────────────────────
    const lighting = ctx.lighting;
    if (lighting) {
      try {
        lighting.setExposureCompensation?.(clamp(s.sunScale, 0.02, 4));
      } catch (err) {
        this._warn('lighting', err);
      }
      if (lighting.sunDirection) this._sunDir.copy(lighting.sunDirection);
      if (lighting.sunColor) this._sunColor.copy(lighting.sunColor);
      if (Number.isFinite(lighting.sunIntensity)) this._sunIntensity = lighting.sunIntensity;
    }
    if (this._sunDir.lengthSq() < 1e-6) this._sunDir.set(0, 1, 0);

    // ── materials: wetness, dust and wind reach every surface through here ──
    const materials = ctx.materials;
    if (materials) {
      try {
        materials.setWetness?.(this.wetness, force);
        materials.setDustLevel?.(clamp01(s.dust));
        materials.setWind?.(this.windAngle, clamp(speed * 0.16, 0, 4));
      } catch (err) {
        this._warn('materials', err);
      }
    }

    // ── volumetric fog + colour grade ───────────────────────────────────────
    this._snapshotGrade();
    const pipeline = ctx.pipeline;
    if (pipeline) {
      try {
        const vol = pipeline.getPass?.('volumetrics');
        const u = vol?.uniforms;
        if (u) {
          u.uDensity.value = Math.max(0, s.volDensity);
          u.uHeightFalloff.value = Math.max(0.004, s.volHeightFalloff);
          u.uAnisotropy.value = clamp(s.volAniso, -0.9, 0.95);
          const c = s.volFogColor;
          u.uFogColor.value.set(c[0], c[1], c[2]);
          // A dust storm scatters light from every direction, not just the sun.
          u.uAmbientScatter.value = 0.12 + 0.34 * clamp01(s.dust);
          u.uMaxDistance.value = clamp(s.visibility * 1.4, 60, 260);
        }
        const g = pipeline.grade;
        const base = this._gradeBase;
        if (g && base) {
          const e = this._exposureResponse;
          g.whiteBalance?.set?.(
            base.whiteBalance[0] * s.whiteBalance[0],
            base.whiteBalance[1] * s.whiteBalance[1],
            base.whiteBalance[2] * s.whiteBalance[2]
          );
          g.gain?.set?.(
            base.gain[0] * s.gainTint[0] * e,
            base.gain[1] * s.gainTint[1] * e,
            base.gain[2] * s.gainTint[2] * e
          );
          // TonemapPass re-reads the scalars from `grade` every frame (syncGrade), and
          // shares the Vector3 objects outright, so both routes take effect at once.
          g.saturation = base.saturation * s.saturation;
          g.contrast = base.contrast * s.contrast;
        }
      } catch (err) {
        this._warn('pipeline', err);
      }
    }

    // ── our own geometry ────────────────────────────────────────────────────
    const camera = ctx.camera;
    if (!camera) return;
    this._exposure = this.shelter.ready
      ? this.shelter.exposure(camera.position.x, camera.position.y, camera.position.z, 1.8)
      : 1;

    const frame = {
      time: t,
      camera,
      wind: this.wind,
      wetness: this.wetness,
      sunDir: this._sunDir,
      sunColor: this._sunColor,
      sunIntensity: this._sunIntensity,
      fogColor: s.volFogColor,
      rain: s.rain,
      rainSpeed: s.rainSpeed,
      tint: s.rainTint,
      motes: s.motes,
      moteSize: s.moteSize,
      grit: s.grit,
      mistParticles: s.mistParticles,
      litter: s.litter,
    };
    try {
      this.precip.update(dt, frame);
      this.atmos.update(dt, frame);
    } catch (err) {
      this._warn('particles', err);
    }

    if (this.lens?.enabled) {
      try {
        this._specColor.copy(this._sunColor).lerp(SKY_BLUE, 0.55);
        this.lens.update(dt, {
          drops: s.drops,
          dropRun: s.dropRun,
          // Heat shimmer needs a hot, high sun and dry ground.
          shimmer: s.shimmer * clamp01(this._sunDir.y * 1.7 - 0.35) * clamp01(1 - this.wetness * 2),
          exposedToSky: 0.25 + 0.75 * this._exposure,
          time: t,
          horizon: this._horizonUv(camera),
          flash: this.flash,
          flashColor: this._flashColor,
          flashSpread: this.flashSpread,
          flashOrigin: this._flashOrigin,
          specColor: this._specColor,
        });
      } catch (err) {
        this._warn('lens', err);
      }
    }

    this._publish(force);
  }

  /** Screen-space v of the true horizon, for the shimmer mask. */
  _horizonUv(camera) {
    try {
      camera.getWorldDirection(this._v);
      this._v.y = 0;
      if (this._v.lengthSq() < 1e-6) return 0.5;
      this._v.normalize().multiplyScalar(4000).add(camera.position);
      this._v.project(camera);
      return clamp(this._v.y * 0.5 + 0.5, -0.5, 1.5);
    } catch {
      return 0.5;
    }
  }

  /** Broadcast, but not every frame — sky and materials both do real work on this. */
  _publish(force) {
    const bus = this.ctx.bus;
    if (!bus?.emit) return;
    const s = this.state;
    const changed =
      this._fadeT < 1 ||
      Math.abs(this.wetness - (this._lastWet ?? -1)) > 0.004 ||
      Math.abs(this.windSpeed - (this._lastWind ?? -1)) > 0.05;
    // Listeners do real work on this (the sky re-solves its lighting); a fade must
    // not turn into one broadcast per frame.
    if (!force && (!changed || this._elapsed - this._lastPublish < 1 / 6)) return;
    this._lastPublish = this._elapsed;
    this._lastWet = this.wetness;
    this._lastWind = this.windSpeed;
    // NOTE: `weather:changed` is consumed by Sky (coverage/cirrus/haze/wind) and by
    // MaterialLibrary (wetness). Both fields must be present on the same event.
    bus.emit('weather:changed', {
      preset: this.preset,
      target: this.targetPreset,
      coverage: clamp01(s.coverage),
      cirrus: clamp01(s.cirrus),
      haze: s.haze,
      wetness: this.wetness,
      rain: s.rain,
      dust: clamp01(s.dust),
      visibility: s.visibility,
      wind: { x: this.wind.x, z: this.wind.z },
    });
    bus.emit('weather:wind', {
      direction: this.windAngle,
      strength: clamp(this.windSpeed * 0.16, 0, 4),
      speed: this.windSpeed,
      x: this.wind.x,
      z: this.wind.z,
    });
    bus.emit('weather:wetness', { wetness: this.wetness });
  }

  lateUpdate() {
    // Draw the lens overlay once the post chain has presented; see LensOverlay.
    if (!this.lens?.active) return;
    const engine = this.ctx.engine;
    if (typeof engine?.onNextFrame !== 'function') return;
    engine.onNextFrame(() => {
      try {
        this.lens?.render();
      } catch (err) {
        this._warn('overlay', err);
      }
    });
  }

  resize(w, h) {
    this.lens?.setSize(w, h);
  }

  _warn(tag, err) {
    if (this._warned.has(tag)) return;
    this._warned.add(tag);
    console.warn(`[weather] ${tag}:`, err?.message || err);
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
    for (const s of this.strikes) {
      try {
        if (s.handle) this.ctx.lighting?.removeLight?.(s.handle);
      } catch {
        /* ignore */
      }
    }
    this.strikes.length = 0;
    this.thunderQueue.length = 0;
    // Materials keep our chained onBeforeCompile for their lifetime, so the uniform
    // must stop pointing at a texture we are about to free.
    this.wetMask.uniforms.wxShelterMap.value = null;
    this.wetMask.uniforms.wxShelterCfg.value.x = 0;
    this.wetMask.enabled = false;
    this.ctx.scene?.remove(this.group);
    this.precip.dispose();
    this.atmos.dispose();
    this.lens?.dispose();
    this.shelter.dispose();
    this.ready = false;
  }
}

const SKY_BLUE = new THREE.Color(0.55, 0.72, 1.0);

/** @returns {import('../core/types.js').System} */
export default function createWeather(ctx) {
  const weather = new Weather(ctx);

  // A complete surface from the first line: other systems may reach for us during
  // their own init(), before ours has run.
  const api = {
    ready: false,
    _impl: weather,
    setPreset: (n, s) => weather.setPreset(n, s),
    get: () => weather.get(),
    setWind: (d, s) => weather.setWind(d, s),
    setWetness: (v, now) => weather.setWetness(v, now),
    lightning: (o) => weather.lightning(o),
    presets: () => weather.presets(),
    rebuildShelter: () => weather.rebuildShelter(),
    get shelter() {
      return weather.shelter;
    },
    get state() {
      return weather.state;
    },
    get preset() {
      return weather.preset;
    },
    get wetness() {
      return weather.wetness;
    },
    get wind() {
      return weather.wind;
    },
  };

  return {
    name: 'weather',
    order: 26,
    async init() {
      ctx.weather = api;
      try {
        weather.init();
        api.ready = true;
      } catch (err) {
        // Never take the frame down over the weather.
        weather.broken = true;
        console.warn('[weather] init failed, weather disabled:', err);
      }
    },
    update(dt) {
      weather.update(dt);
    },
    lateUpdate() {
      weather.lateUpdate();
    },
    resize(w, h) {
      weather.resize(w, h);
    },
    dispose() {
      weather.dispose();
    },
  };
}
