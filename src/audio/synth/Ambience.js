/**
 * Ambience.js — the synthesised environment bed. Owner: audio agent.
 *
 * Six continuous layers plus a scheduler for one-shots. Nothing here is a loop:
 * every layer is filtered noise whose cutoff, resonance and level are driven by a
 * bank of LFOs at mutually irrational periods, so the bed never repeats inside a
 * match. The scheduler adds birds, distant battle, creaks and dogs at Poisson
 * intervals on top.
 *
 *   wind      pink noise through a wandering bandpass, plus a resonant whistle
 *             layer that only appears in a gust. Tracks ctx.weather's windSpeed
 *             and gust fields directly.
 *   city      brown noise under 200 Hz plus two slightly-detuned low oscillators.
 *             The beat between them is the "hum" of a city you stop hearing after
 *             ten seconds and immediately miss when it is gone.
 *   rain      three separate layers — hiss on stone, a mid patter, and a bright
 *             tick layer for tin and glass — each with its own level curve so
 *             drizzle and downpour are different sounds, not one sound louder.
 *   grit      wind-blown sand: a dust-storm-only band that rises with `dust`.
 *   distance  a very low, very slow swell: traffic, generators, the rest of the
 *             city being a city.
 *   battle    scheduled far-off gunfire and ordnance, quiet and heavily filtered.
 *
 * All of it is bus-routed to `ambience`, none of it is spatialised (it is
 * everywhere), except the scheduled one-shots which are played through the normal
 * positional path so a bird is actually in a tree.
 */
import {
  ahr, biquad, chain, clamp, clamp01, gainNode, jitter, lerp, rr, safeStart, safeStop,
  setFreq, expFreq, rampTo, setAt, stereoPan, targetAt, hz, disconnect,
} from './dsp.js';

/** A bank of sine LFOs with deliberately non-harmonic periods. */
class LFOBank {
  constructor(rng, n = 6) {
    this.phases = [];
    this.rates = [];
    for (let i = 0; i < n; i++) {
      this.phases.push(rng() * Math.PI * 2);
      // Periods from ~4 s to ~95 s, none an integer multiple of another.
      this.rates.push((Math.PI * 2) / (3.7 + i * 6.1 + rng() * 11.3));
    }
  }

  step(dt) {
    for (let i = 0; i < this.phases.length; i++) {
      this.phases[i] += this.rates[i] * dt;
      if (this.phases[i] > Math.PI * 4) this.phases[i] -= Math.PI * 4;
    }
  }

  /** Value in [-1,1] from LFO `i`. */
  v(i) {
    return Math.sin(this.phases[i % this.phases.length]);
  }

  /** Sum of two LFOs, in [-1,1] — never repeats within a session. */
  v2(a, b) {
    return (this.v(a) + this.v(b)) * 0.5;
  }
}

export class Ambience {
  /**
   * @param {AudioContext} ac
   * @param {object} o { nz, rng, dest, reverb, playAt, ctx, quality }
   */
  constructor(ac, o) {
    this.ac = ac;
    this.nz = o.nz;
    this.rng = o.rng;
    this.dest = o.dest;
    this.ctx = o.ctx;
    this.playAt = o.playAt || (() => {});
    this.quality = o.quality || 'high';
    this.running = false;
    this.level = 1;
    this.lfo = new LFOBank(this.rng, 8);
    this.layers = {};
    this.nodes = [];
    this.time = 0;
    this._paramT = 0;
    // Live weather-derived targets.
    this.w = { wind: 1.6, gust: 0.25, rain: 0, wetness: 0, dust: 0.06, coverage: 0.1, preset: 'clear' };
    this.timers = { bird: 6, battle: 12, creak: 20, dog: 40, gust: 5, veh: 30 };
    this.bounds = { x: 60, z: 60, y: 8 };
  }

  /** Build the persistent graph. Safe to call twice. */
  start() {
    if (this.running) return;
    const ac = this.ac;
    const out = gainNode(ac, 0);
    out.connect(this.dest);
    this.out = out;
    this.nodes.push(out);

    this.layers.wind = this._noiseLayer('pink', 320, 0.9, 0.0, { pan: 0 });
    this.layers.whistle = this._noiseLayer('white', 1500, 7.0, 0.0, { pan: 0.25 });
    this.layers.lowWind = this._noiseLayer('brown', 110, 0.7, 0.0, { pan: -0.2, type: 'lowpass' });
    this.layers.city = this._noiseLayer('brown', 180, 0.6, 0.0, { pan: 0, type: 'lowpass' });
    this.layers.rainHiss = this._noiseLayer('white', 4200, 0.6, 0.0, { pan: 0, type: 'highpass' });
    this.layers.rainMid = this._noiseLayer('white', 1500, 0.8, 0.0, { pan: -0.15 });
    this.layers.rainTick = this._noiseLayer('velvet', 5200, 1.4, 0.0, { pan: 0.2, rate: 1.6 });
    this.layers.grit = this._noiseLayer('velvet', 2600, 1.1, 0.0, { pan: -0.3, rate: 0.9 });

    // City hum: two detuned low oscillators. Their beat frequency is under 1 Hz,
    // which is exactly the slow throb a city has.
    this.hum = [];
    for (const f of [51.3, 78.9, 104.7]) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * jitter(this.rng, 0.01);
      const g = gainNode(ac, 0);
      const p = stereoPan(ac, rr(this.rng, -0.4, 0.4));
      chain(o, g, p);
      p.connect(out);
      safeStart(o, ac.currentTime);
      this.hum.push({ osc: o, gain: g, base: f });
      this.nodes.push(o, g, p);
    }

    this.running = true;
    // Fade in rather than snapping on: an ambience bed that appears instantly is
    // the most obvious tell that a game just loaded.
    rampTo(out.gain, this.level, ac.currentTime + 2.5);
    this.applyWeather();
  }

  _noiseLayer(kind, freq, q, level, opts = {}) {
    const ac = this.ac;
    const src = this.nz.src(kind, { loop: true, rate: opts.rate ?? 1 });
    const f = biquad(ac, opts.type || 'bandpass', freq, q);
    const g = gainNode(ac, level);
    const p = stereoPan(ac, opts.pan ?? 0);
    chain(src, f, g, p);
    p.connect(this.out);
    this.nz.play(src, ac.currentTime);
    this.nodes.push(src, f, g, p);
    return { src, filter: f, gain: g, pan: p, target: level, freq };
  }

  setLevel(v) {
    this.level = clamp(v, 0, 2);
    if (this.out) rampTo(this.out.gain, this.level, this.ac.currentTime + 0.4);
  }

  setQuality(q) {
    this.quality = q;
  }

  /**
   * Pull the live weather record and recompute every layer's target.
   *
   * Wind, wetness and dust come from `ctx.materials.globals` — the shared
   * uniforms every surface, foliage card and decal in the game already reads.
   * Sourcing them anywhere else would let the audio drift out of step with what
   * is on screen. Rain rate, gust and cloud cover only exist on the weather
   * record, so those come from there.
   */
  applyWeather() {
    const st = this.ctx?.weather?.state || this.ctx?.weather?.get?.() || null;
    if (st) {
      this.w.wind = Number.isFinite(st.windSpeed) ? st.windSpeed : this.w.wind;
      this.w.gust = Number.isFinite(st.gust) ? st.gust : this.w.gust;
      this.w.rain = Number.isFinite(st.rain) ? st.rain : this.w.rain;
      this.w.wetness = Number.isFinite(st.wetness) ? st.wetness : this.w.wetness;
      this.w.dust = Number.isFinite(st.dust) ? st.dust : this.w.dust;
      this.w.coverage = Number.isFinite(st.coverage) ? st.coverage : this.w.coverage;
    }
    const g = this.ctx?.materials?.globals;
    if (g) {
      if (Number.isFinite(g.windStrength)) this.w.wind = g.windStrength;
      if (Number.isFinite(g.wetness)) this.w.wetness = g.wetness;
      if (Number.isFinite(g.dustLevel)) this.w.dust = g.dustLevel;
    }
    const p = this.ctx?.weather?.preset;
    if (typeof p === 'string') this.w.preset = p;
  }

  /**
   * Per-frame. Cheap: the LFOs run in JS and are pushed to AudioParams at 12 Hz
   * with setTargetAtTime, which is far below the rate at which the automation
   * queue starts to cost anything.
   */
  update(dt) {
    if (!this.running) return;
    this.time += dt;
    this.lfo.step(dt);
    this._paramT -= dt;
    if (this._paramT <= 0) {
      this._paramT = 0.08;
      // `weather:changed` only fires when a preset is *chosen*; the cross-fade
      // between two presets runs for another eight seconds after that, so the
      // record has to be re-read continuously or the bed lags the sky.
      this._weatherT = (this._weatherT ?? 0) - 0.08;
      if (this._weatherT <= 0) {
        this._weatherT = 0.5;
        this.applyWeather();
      }
      this._pushParams();
    }
    this._schedule(dt);
  }

  _pushParams() {
    const ac = this.ac;
    const t = ac.currentTime;
    const L = this.lfo;
    const w = this.w;
    const windN = clamp01(w.wind / 16);
    const gust = clamp01(w.gust);

    // Gusts: two slow LFOs beating, biased so calm weather is mostly silent and
    // a storm is mostly howling.
    const gustEnv = clamp01(0.5 + 0.5 * L.v2(0, 3)) * gust + windN * 0.55;

    const wind = this.layers.wind;
    if (wind) {
      targetAt(wind.gain.gain, clamp(0.035 + gustEnv * 0.3, 0, 0.5), t, 0.35);
      targetAt(wind.filter.frequency, hz(ac, 240 + gustEnv * 620 + L.v(1) * 90), t, 0.5);
      targetAt(wind.filter.Q, clamp(0.7 + gustEnv * 1.4, 0.2, 6), t, 0.6);
    }
    const whistle = this.layers.whistle;
    if (whistle) {
      // The whistle only exists above a real wind: it is edges and wires singing.
      const wh = clamp01((gustEnv - 0.35) / 0.65);
      targetAt(whistle.gain.gain, wh * wh * 0.05, t, 0.4);
      targetAt(whistle.filter.frequency, hz(ac, 1100 + L.v2(2, 5) * 450 + wh * 900), t, 0.7);
      targetAt(whistle.filter.Q, clamp(5 + L.v(4) * 3, 1.5, 14), t, 0.8);
    }
    const low = this.layers.lowWind;
    if (low) {
      targetAt(low.gain.gain, clamp(0.03 + gustEnv * 0.11, 0, 0.3), t, 0.6);
      targetAt(low.filter.frequency, hz(ac, 90 + L.v(6) * 30), t, 1.0);
    }

    // City: constant-ish, gently breathing, quieter in a storm (masked anyway).
    const city = this.layers.city;
    const mask = 1 - clamp01(w.rain) * 0.55;
    if (city) {
      targetAt(city.gain.gain, (0.05 + 0.012 * L.v(2)) * mask, t, 1.2);
      targetAt(city.filter.frequency, hz(ac, 175 + L.v(7) * 40), t, 1.5);
    }
    for (let i = 0; i < this.hum.length; i++) {
      const h = this.hum[i];
      const lv = [0.011, 0.007, 0.004][i] * mask * (0.7 + 0.3 * L.v(i + 2));
      targetAt(h.gain.gain, lv, t, 1.4);
      targetAt(h.osc.frequency, h.base * (1 + L.v(i + 4) * 0.004), t, 2.0);
    }

    // Rain: three bands with different thresholds so drizzle != downpour.
    const rain = clamp01(w.rain);
    const hiss = this.layers.rainHiss;
    const mid = this.layers.rainMid;
    const tickL = this.layers.rainTick;
    const breathe = 1 + 0.18 * L.v2(1, 6);
    if (hiss) {
      targetAt(hiss.gain.gain, Math.pow(rain, 0.75) * 0.13 * breathe, t, 0.5);
      targetAt(hiss.filter.frequency, hz(ac, 2600 + rain * 2200 + L.v(3) * 400), t, 0.9);
    }
    if (mid) {
      targetAt(mid.gain.gain, Math.pow(rain, 1.2) * 0.1 * breathe, t, 0.5);
      targetAt(mid.filter.frequency, hz(ac, 900 + rain * 1400 + L.v(5) * 200), t, 0.9);
      targetAt(mid.filter.Q, clamp(0.6 + rain * 0.8, 0.3, 3), t, 1.0);
    }
    if (tickL) {
      // Drops on tin and glass: only once it is properly raining.
      const hard = clamp01((rain - 0.3) / 0.7);
      targetAt(tickL.gain.gain, hard * 0.06 * breathe, t, 0.5);
      targetAt(tickL.filter.frequency, hz(ac, 4200 + L.v(0) * 900), t, 1.1);
    }

    // Blown grit — the dust preset's signature.
    const grit = this.layers.grit;
    if (grit) {
      const g = clamp01((this.w.dust - 0.25) / 0.75) * (0.35 + gustEnv * 0.65);
      targetAt(grit.gain.gain, g * 0.075, t, 0.6);
      targetAt(grit.filter.frequency, hz(ac, 2200 + L.v(4) * 600 + gustEnv * 900), t, 0.9);
    }
  }

  /** Poisson-ish one-shots. Everything here is optional colour. */
  _schedule(dt) {
    const rng = this.rng;
    const T = this.timers;
    const w = this.w;
    const clear = clamp01(1 - w.coverage) * clamp01(1 - w.rain * 3);
    const b = this.bounds;
    const L = this.ctx?.audio?.listener || null;
    const near = (spread, high) => ({
      x: (L?.x ?? 0) + rr(rng, -spread, spread),
      y: (L?.y ?? 1.7) + rr(rng, -1, high),
      z: (L?.z ?? 0) + rr(rng, -spread, spread),
    });

    // Birds: clear weather only, and they go quiet when it starts to rain.
    T.bird -= dt * (0.25 + clear * 1.6);
    if (T.bird <= 0) {
      T.bird = rr(rng, 3.5, 14) / (0.3 + clear);
      if (clear > 0.35) this.playAt('bird', near(22, 9), { level: rr(rng, 0.25, 0.75), occlude: false });
    }

    // Distant battle: the rest of the war, somewhere else.
    T.battle -= dt;
    if (T.battle <= 0) {
      T.battle = rr(rng, 6, 26);
      const p = {
        x: rr(rng, -1, 1) * 220,
        y: rr(rng, 2, 24),
        z: rr(rng, -1, 1) * 220,
      };
      const kind = rng();
      if (kind < 0.55) {
        const shots = 1 + Math.floor(rng() * 6);
        for (let i = 0; i < shots; i++) {
          this.playAt('distant_gunfire', p, {
            level: rr(rng, 0.25, 0.7),
            delay: i * rr(rng, 0.07, 0.16),
            occlude: false,
          });
        }
      } else if (kind < 0.85) {
        this.playAt('distant_explosion', p, { level: rr(rng, 0.3, 0.8), occlude: false });
      } else {
        this.playAt('distant_gunfire', p, { level: rr(rng, 0.4, 0.9), occlude: false, burst: true });
      }
    }

    // Structural creaks — corrugated roofs and shutters in the wind.
    T.creak -= dt * (0.4 + clamp01(w.wind / 12) * 2.2);
    if (T.creak <= 0) {
      T.creak = rr(rng, 9, 40);
      this.playAt('creak', near(16, 7), { level: rr(rng, 0.15, 0.5) });
    }

    // A dog, a distant vehicle. Sparse, and only outside a storm.
    T.dog -= dt * clamp01(1 - w.rain);
    if (T.dog <= 0) {
      T.dog = rr(rng, 35, 130);
      this.playAt('dog', { x: rr(rng, -70, 70), y: 1.2, z: rr(rng, -70, 70) }, { level: rr(rng, 0.12, 0.4) });
    }
    T.veh -= dt;
    if (T.veh <= 0) {
      T.veh = rr(rng, 25, 90);
      this.playAt('distant_vehicle', { x: rr(rng, -120, 120), y: 1, z: rr(rng, -120, 120) }, { level: rr(rng, 0.15, 0.45), occlude: false });
    }
  }

  stop() {
    if (!this.running) return;
    const t = this.ac.currentTime;
    rampTo(this.out.gain, 0, t + 0.6);
    this.running = false;
    for (const n of this.nodes) {
      if (n.stop) safeStop(n, t + 0.8);
    }
    setTimeout(() => this.dispose(), 1200);
  }

  dispose() {
    for (const n of this.nodes) {
      if (n.stop) safeStop(n, this.ac.currentTime);
      disconnect(n);
    }
    this.nodes.length = 0;
    this.layers = {};
    this.hum = [];
    this.running = false;
  }
}

/* ── the scheduled one-shots ───────────────────────────────────────────────── */

/** A bird. Two or three chirps, each a fast upward FM sweep. */
export function bird(S, p = {}) {
  const { ac, rng } = S;
  const t = S.t;
  const n = 2 + Math.floor(rng() * 4);
  const base = rr(rng, 2200, 4400);
  const level = 0.16 * (p.level ?? 1);
  S.setSend?.(0.7);
  for (let i = 0; i < n; i++) {
    const st = t + i * rr(rng, 0.07, 0.19);
    const o = ac.createOscillator();
    o.type = 'sine';
    const g = gainNode(ac, 0);
    // A touch of FM gives the chirp its edge without a second oscillator bank.
    const mod = ac.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = rr(rng, 60, 220);
    const modG = gainNode(ac, rr(rng, 80, 400));
    mod.connect(modG);
    try {
      modG.connect(o.frequency);
    } catch {
      /* ignore */
    }
    o.connect(g);
    g.connect(S.out);
    const f0 = base * jitter(rng, 0.12);
    setFreq(ac, o.frequency, f0, st);
    expFreq(ac, o.frequency, f0 * rr(rng, 1.15, 1.9), st + rr(rng, 0.02, 0.06));
    expFreq(ac, o.frequency, f0 * rr(rng, 0.8, 1.1), st + rr(rng, 0.07, 0.12));
    ahr(g.gain, st, level * rr(rng, 0.5, 1), 0.006, 0.02, rr(rng, 0.04, 0.1));
    safeStart(o, st);
    safeStart(mod, st);
    safeStop(o, st + 0.25);
    safeStop(mod, st + 0.25);
    S.track?.(o);
    S.track?.(mod);
  }
  return t + 1.2;
}

/** Corrugated metal or a wooden shutter complaining in the wind. */
export function creak(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const dur = rr(rng, 0.3, 1.1);
  const src = nz.src('velvet', { loop: true, rate: rr(rng, 0.25, 0.6) });
  const bp = biquad(ac, 'bandpass', rr(rng, 500, 1800), rr(rng, 8, 22));
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(S.out);
  S.setSend?.(0.9);
  ahr(g.gain, t, 0.14 * (p.level ?? 1), dur * 0.25, dur * 0.2, dur * 0.6);
  const f = rr(rng, 500, 1400);
  setFreq(ac, bp.frequency, f, t);
  expFreq(ac, bp.frequency, f * rr(rng, 0.55, 1.9), t + dur);
  nz.play(src, t);
  safeStop(src, t + dur + 0.2);
  S.track?.(src);
  return t + dur + 0.3;
}

/** A dog, several streets away. */
export function dog(S, p = {}) {
  const { ac, rng } = S;
  const t = S.t;
  const n = 2 + Math.floor(rng() * 3);
  S.setSend?.(1.5);
  for (let i = 0; i < n; i++) {
    const st = t + i * rr(rng, 0.22, 0.5);
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    const f = biquad(ac, 'bandpass', rr(rng, 500, 900), 2.2);
    const g = gainNode(ac, 0);
    chain(o, f, g);
    g.connect(S.out);
    const f0 = rr(rng, 160, 280);
    setFreq(ac, o.frequency, f0 * 1.6, st);
    expFreq(ac, o.frequency, f0 * 0.75, st + 0.09);
    ahr(g.gain, st, 0.09 * (p.level ?? 1), 0.008, 0.02, rr(rng, 0.08, 0.18));
    safeStart(o, st);
    safeStop(o, st + 0.35);
    S.track?.(o);
  }
  return t + 1.5;
}

/** A vehicle crossing somewhere out past the map edge. */
export function distantVehicle(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const dur = rr(rng, 3, 8);
  const src = nz.src('brown', { loop: true, rate: rr(rng, 0.6, 1.0) });
  const lp = biquad(ac, 'lowpass', rr(rng, 240, 460), 1.1);
  const g = gainNode(ac, 0);
  chain(src, lp, g);
  g.connect(S.out);
  S.setSend?.(1.2);
  ahr(g.gain, t, 0.1 * (p.level ?? 1), dur * 0.4, dur * 0.1, dur * 0.5);
  // Engine load rising and falling as it changes gear.
  setFreq(ac, lp.frequency, 220, t);
  expFreq(ac, lp.frequency, 480, t + dur * 0.35);
  expFreq(ac, lp.frequency, 180, t + dur);
  nz.play(src, t);
  safeStop(src, t + dur + 0.3);
  S.track?.(src);
  return t + dur + 0.4;
}
