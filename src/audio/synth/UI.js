/**
 * UI.js — hitmarkers, menu feedback, notifications. Owner: audio agent.
 *
 * These are 2D (never spatialised, never occluded, never reverbed) and short.
 * The hitmarker is the single most-heard sound in a shooter, so it gets the same
 * treatment as a weapon: a transient, a tone and a tiny amount of variation, so
 * a long burst does not turn into a machine-gun of identical beeps.
 */
import {
  ad, ahr, biquad, chain, clamp, gainNode, jitter, rr, safeStart, safeStop, setFreq,
  expFreq, tick,
} from './dsp.js';

function blip(S, { t, freq, level, decay = 0.045, type = 'square', sweep = 0 }) {
  const { ac } = S;
  const o = ac.createOscillator();
  o.type = type;
  const f = biquad(ac, 'bandpass', freq, 1.4);
  const g = gainNode(ac, 0);
  chain(o, f, g);
  g.connect(S.out);
  setFreq(ac, o.frequency, freq, t);
  if (sweep) expFreq(ac, o.frequency, freq * sweep, t + decay);
  ad(g.gain, t, level, 0.0008, decay);
  safeStart(o, t);
  safeStop(o, t + decay + 0.05);
  S.track?.(o);
}

/** The hitmarker "tk". Bright, dry, unmistakable, and gone in 40 ms. */
export function hitmarker(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const lethal = !!p.lethal;
  const head = !!p.headshot;
  const level = 0.32 * (p.level ?? 1);
  const j = jitter(rng, 0.05);
  tick(S, { t, level: level * 0.9, freq: (head ? 6200 : 4600) * j, q: 3.5, decay: 0.012 });
  blip(S, { t, freq: (head ? 2400 : 1750) * j, level: level * 0.5, decay: 0.032, sweep: 0.75 });
  if (lethal) {
    // Kill confirm: a second, lower pair a beat later.
    blip(S, { t: t + 0.055, freq: 1150 * j, level: level * 0.45, decay: 0.07, sweep: 0.6 });
    tick(S, { t: t + 0.055, level: level * 0.5, freq: 3200 * j, q: 4, decay: 0.02 });
  }
  return t + 0.2;
}

export function uiClick(S, p = {}) {
  const t = S.t;
  const l = 0.22 * (p.level ?? 1);
  tick(S, { t, level: l, freq: 3200 * jitter(S.rng, 0.03), q: 5, decay: 0.01 });
  blip(S, { t, freq: 900, level: l * 0.4, decay: 0.03, type: 'triangle', sweep: 0.7 });
  return t + 0.1;
}

export function uiHover(S, p = {}) {
  const t = S.t;
  tick(S, { t, level: 0.08 * (p.level ?? 1), freq: 5200, q: 7, decay: 0.008 });
  return t + 0.05;
}

export function uiBack(S, p = {}) {
  const t = S.t;
  const l = 0.2 * (p.level ?? 1);
  blip(S, { t, freq: 900, level: l * 0.5, decay: 0.05, type: 'triangle', sweep: 0.55 });
  tick(S, { t, level: l * 0.5, freq: 2000, q: 4, decay: 0.014 });
  return t + 0.12;
}

export function uiError(S, p = {}) {
  const t = S.t;
  const l = 0.2 * (p.level ?? 1);
  blip(S, { t, freq: 320, level: l, decay: 0.09, type: 'square' });
  blip(S, { t: t + 0.08, freq: 240, level: l * 0.8, decay: 0.12, type: 'square' });
  return t + 0.25;
}

/** Score / objective ping: a clean two-note rise. */
export function notify(S, p = {}) {
  const t = S.t;
  const l = 0.18 * (p.level ?? 1);
  blip(S, { t, freq: 1320, level: l, decay: 0.1, type: 'triangle' });
  blip(S, { t: t + 0.09, freq: 1980, level: l * 0.9, decay: 0.16, type: 'triangle' });
  return t + 0.35;
}

/** Low-ammo tick: deliberately unpleasant, deliberately short. */
export function ammoLow(S, p = {}) {
  const t = S.t;
  tick(S, { t, level: 0.14 * (p.level ?? 1), freq: 2600, q: 9, decay: 0.02 });
  return t + 0.06;
}

/** The heartbeat / low-health thud. */
export function heartbeat(S, p = {}) {
  const { ac } = S;
  const t = S.t;
  const l = 0.3 * (p.level ?? 1);
  for (const [dt, lv] of [[0, 1], [0.19, 0.7]]) {
    const o = ac.createOscillator();
    o.type = 'sine';
    const g = gainNode(ac, 0);
    chain(o, g);
    g.connect(S.out);
    setFreq(ac, o.frequency, 78, t + dt);
    expFreq(ac, o.frequency, 34, t + dt + 0.13);
    ad(g.gain, t + dt, l * lv, 0.008, 0.14);
    safeStart(o, t + dt);
    safeStop(o, t + dt + 0.25);
    S.track?.(o);
  }
  return t + 0.5;
}

/** Match countdown / round start. */
export function beep(S, p = {}) {
  const t = S.t;
  blip(S, { t, freq: p.high ? 1760 : 880, level: 0.2 * (p.level ?? 1), decay: 0.14, type: 'square' });
  return t + 0.2;
}
