/**
 * Foley.js — footsteps, landings, cloth and gear. Owner: audio agent.
 *
 * A footstep is a heel and a toe, 25-45 ms apart, plus whatever the surface
 * scatters and whatever the player is wearing. Getting the two-part structure
 * right matters more than the timbre: a single-blip footstep reads as a UI click
 * no matter how well it is filtered.
 *
 * Gear (sling swivel, magazines in a chest rig, buckles) is layered on every step
 * at a low level and randomised hard, which is most of what stops a run cycle
 * from sounding like a metronome.
 */
import {
  ad, ahr, biquad, chain, clamp, clamp01, crack, expFreq, gainNode, jitter, lerp,
  pick, ring, rr, safeStop, setFreq, stereoPan, thump, tick,
} from './dsp.js';

/**
 * heel / toe: filtered noise bursts. scatter: granular debris. squeak: a resonant
 * component (snow, rubber on polished floor). hollow: a resonant low body (wood).
 */
export const STEP_PROFILES = {
  concrete: {
    gain: 1.0, wet: 0.6,
    heel: { f: 2600, q: 1.3, decay: 0.045, level: 0.55, kind: 'white' },
    toe: { f: 1700, q: 1.1, decay: 0.05, level: 0.32, delay: 0.038 },
    body: { f0: 220, f1: 70, decay: 0.055, level: 0.4 },
    scatter: { freq: 4600, decay: 0.07, level: 0.09, rate: 1.0 },
  },
  metal: {
    gain: 1.05, wet: 0.7,
    heel: { f: 3400, q: 1.6, decay: 0.035, level: 0.55, kind: 'white' },
    toe: { f: 2200, q: 1.4, decay: 0.04, level: 0.3, delay: 0.034 },
    body: { f0: 320, f1: 110, decay: 0.04, level: 0.28 },
    ring: { freq: 1250, decay: 0.4, level: 0.22, partials: 4, spread: 1.42 },
  },
  wood: {
    gain: 0.95, wet: 0.5,
    heel: { f: 1900, q: 1.2, decay: 0.045, level: 0.5, kind: 'white' },
    toe: { f: 1300, q: 1.0, decay: 0.05, level: 0.3, delay: 0.04 },
    body: { f0: 280, f1: 95, decay: 0.075, level: 0.45 },
    ring: { freq: 420, decay: 0.13, level: 0.1, partials: 2, spread: 2.4 },
    creak: 0.25,
  },
  dirt: {
    gain: 0.85, wet: 0.32,
    heel: { f: 1200, q: 0.85, decay: 0.055, level: 0.4, kind: 'pink' },
    toe: { f: 850, q: 0.8, decay: 0.06, level: 0.24, delay: 0.042 },
    body: { f0: 175, f1: 55, decay: 0.07, level: 0.35 },
    scatter: { freq: 2400, decay: 0.12, level: 0.2, rate: 0.75 },
  },
  gravel: {
    gain: 0.95, wet: 0.36,
    heel: { f: 2000, q: 0.8, decay: 0.06, level: 0.35, kind: 'white' },
    toe: { f: 1500, q: 0.8, decay: 0.07, level: 0.22, delay: 0.045 },
    body: { f0: 190, f1: 62, decay: 0.06, level: 0.25 },
    scatter: { freq: 3800, decay: 0.2, level: 0.42, rate: 0.9 },
  },
  sand: {
    gain: 0.7, wet: 0.25,
    heel: { f: 1500, q: 0.65, decay: 0.08, level: 0.26, kind: 'white' },
    toe: { f: 1100, q: 0.6, decay: 0.09, level: 0.18, delay: 0.05 },
    body: { f0: 150, f1: 48, decay: 0.07, level: 0.22 },
    scatter: { freq: 3200, decay: 0.16, level: 0.3, rate: 1.05 },
  },
  grass: {
    gain: 0.72, wet: 0.28,
    heel: { f: 2400, q: 0.7, decay: 0.06, level: 0.24, kind: 'white' },
    toe: { f: 1800, q: 0.7, decay: 0.07, level: 0.17, delay: 0.046 },
    body: { f0: 170, f1: 56, decay: 0.06, level: 0.24 },
    scatter: { freq: 5000, decay: 0.14, level: 0.3, rate: 1.15 },
  },
  glass: {
    gain: 1.0, wet: 0.62,
    heel: { f: 4200, q: 1.4, decay: 0.04, level: 0.4, kind: 'white' },
    toe: { f: 2800, q: 1.2, decay: 0.045, level: 0.24, delay: 0.036 },
    body: { f0: 240, f1: 82, decay: 0.045, level: 0.24 },
    scatter: { freq: 7000, decay: 0.22, level: 0.4, rate: 1.3 },
    shards: 0.3,
  },
  water: {
    gain: 0.95, wet: 0.4,
    heel: { f: 1600, q: 0.7, decay: 0.07, level: 0.34, kind: 'white' },
    toe: { f: 1200, q: 0.7, decay: 0.09, level: 0.26, delay: 0.05 },
    body: { f0: 260, f1: 78, decay: 0.06, level: 0.24 },
    scatter: { freq: 5400, decay: 0.24, level: 0.34, rate: 1.2 },
    splash: 0.5,
  },
  fabric: {
    gain: 0.55, wet: 0.2,
    heel: { f: 1000, q: 0.7, decay: 0.05, level: 0.24, kind: 'pink' },
    toe: { f: 750, q: 0.7, decay: 0.055, level: 0.16, delay: 0.044 },
    body: { f0: 160, f1: 58, decay: 0.055, level: 0.2 },
  },
  flesh: {
    gain: 0.6, wet: 0.2,
    heel: { f: 900, q: 0.8, decay: 0.045, level: 0.26, kind: 'pink' },
    toe: { f: 700, q: 0.8, decay: 0.05, level: 0.18, delay: 0.04 },
    body: { f0: 190, f1: 62, decay: 0.06, level: 0.28 },
  },
  rubber: {
    gain: 0.7, wet: 0.35,
    heel: { f: 1400, q: 1.0, decay: 0.04, level: 0.32, kind: 'white' },
    toe: { f: 1000, q: 0.9, decay: 0.045, level: 0.2, delay: 0.038 },
    body: { f0: 200, f1: 74, decay: 0.05, level: 0.26 },
    squeak: 0.35,
  },
  plaster: {
    gain: 0.85, wet: 0.5,
    heel: { f: 2300, q: 1.1, decay: 0.045, level: 0.42, kind: 'white' },
    toe: { f: 1600, q: 1.0, decay: 0.05, level: 0.26, delay: 0.038 },
    body: { f0: 210, f1: 68, decay: 0.055, level: 0.3 },
    scatter: { freq: 4200, decay: 0.1, level: 0.16, rate: 0.9 },
  },
  ceramic: {
    gain: 1.0, wet: 0.72,
    heel: { f: 3800, q: 1.5, decay: 0.035, level: 0.5, kind: 'white' },
    toe: { f: 2600, q: 1.3, decay: 0.04, level: 0.3, delay: 0.034 },
    body: { f0: 260, f1: 92, decay: 0.04, level: 0.26 },
    ring: { freq: 2900, decay: 0.16, level: 0.12, partials: 3, spread: 1.36 },
  },
  foliage: {
    gain: 0.6, wet: 0.24,
    heel: { f: 3000, q: 0.7, decay: 0.07, level: 0.18, kind: 'white' },
    toe: { f: 2200, q: 0.7, decay: 0.08, level: 0.14, delay: 0.05 },
    scatter: { freq: 5600, decay: 0.2, level: 0.38, rate: 1.2 },
  },
  snow: {
    gain: 0.72, wet: 0.18,
    heel: { f: 1700, q: 0.6, decay: 0.075, level: 0.24, kind: 'white' },
    toe: { f: 1200, q: 0.6, decay: 0.085, level: 0.18, delay: 0.05 },
    body: { f0: 140, f1: 46, decay: 0.08, level: 0.2 },
    scatter: { freq: 6400, decay: 0.14, level: 0.2, rate: 1.1 },
    squeak: 0.45,
  },
};

const STEP_ALIAS = {
  asphalt: 'concrete', brick: 'concrete', stone: 'concrete', marble: 'ceramic',
  tile: 'ceramic', rubble: 'gravel', shingle: 'wood', carpet: 'fabric',
  metal_thin: 'metal', sandbag: 'sand', mud: 'dirt',
};

export function stepProfile(surface) {
  const s = String(surface || 'concrete').toLowerCase().replace(/^step_/, '');
  return STEP_PROFILES[STEP_ALIAS[s] || s] || STEP_PROFILES.concrete;
}

function burst(S, spec, t, level, dest, pitch) {
  if (!spec || level <= 0.001) return;
  const { ac, rng, nz } = S;
  const src = nz.src(spec.kind || 'white', { rate: rr(rng, 0.85, 1.2) });
  const bp = biquad(ac, 'bandpass', spec.f * pitch, spec.q * jitter(rng, 0.2));
  const hp = biquad(ac, 'highpass', 120, 0.7);
  const g = gainNode(ac, 0);
  chain(src, bp, hp, g);
  g.connect(dest);
  const d = spec.decay * jitter(rng, 0.25);
  ad(g.gain, t, level, 0.0015, d);
  expFreq(ac, bp.frequency, spec.f * pitch * 0.55, t + d);
  nz.play(src, t);
  safeStop(src, t + d + 0.06);
  S.track?.(src);
}

function scatter(S, spec, t, level, dest) {
  if (!spec || level <= 0.001) return;
  const { ac, rng, nz } = S;
  const src = nz.src('velvet', { rate: (spec.rate || 1) * rr(rng, 0.7, 1.4) });
  const bp = biquad(ac, 'bandpass', spec.freq * jitter(rng, 0.25), rr(rng, 0.9, 2.2));
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(dest);
  const d = spec.decay * jitter(rng, 0.3);
  ad(g.gain, t + rr(rng, 0.002, 0.012), level, 0.005, d);
  nz.play(src, t);
  safeStop(src, t + d + 0.08);
  S.track?.(src);
}

/** Sling swivel, mag pouches, buckles. Quiet, but the run cycle dies without it. */
export function gearRustle(S, t, level, dest) {
  const { ac, rng, nz } = S;
  if (level <= 0.002) return;
  const src = nz.src('pink', { rate: rr(rng, 0.8, 1.3) });
  const bp = biquad(ac, 'bandpass', rr(rng, 1600, 3600), rr(rng, 0.8, 1.6));
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(dest || S.out);
  ahr(g.gain, t, level, rr(rng, 0.008, 0.03), 0.01, rr(rng, 0.06, 0.16));
  nz.play(src, t);
  safeStop(src, t + 0.3);
  S.track?.(src);
  // Occasionally a buckle or a swivel actually clicks.
  if (rng() < 0.35) {
    tick(S, {
      t: t + rr(rng, 0.01, 0.08),
      level: level * rr(rng, 0.4, 1.1),
      freq: rr(rng, 2800, 6200),
      q: rr(rng, 6, 14),
      decay: rr(rng, 0.006, 0.02),
      dest: dest || S.out,
    });
  }
}

/**
 * @param {object} p { surface, speed, volume, foot, landing, stance, level }
 */
export function footstep(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const prof = stepProfile(p.surface);
  const speed = clamp(p.speed ?? 3, 0, 9);
  const effort = clamp01(speed / 6.5);
  const base = (prof.gain || 1) * clamp(p.volume ?? lerp(0.35, 1, effort), 0.03, 1.6) * (p.level ?? 1);
  // Left and right feet are not identical; alternating pitch is a cheap and very
  // effective cue that a real person is walking.
  const footBias = p.foot === 'left' ? 0.97 : 1.03;
  const pitch = jitter(rng, 0.1) * footBias * lerp(1.06, 0.94, effort);
  S.setSend?.(prof.wet ?? 0.4);

  burst(S, prof.heel, t, (prof.heel?.level ?? 0.4) * base, S.out, pitch);
  const toeT = t + (prof.toe?.delay ?? 0.04) * lerp(1.4, 0.55, effort) * jitter(rng, 0.2);
  burst(S, prof.toe, toeT, (prof.toe?.level ?? 0.25) * base, S.out, pitch * jitter(rng, 0.05));
  if (prof.body) {
    thump(S, {
      t,
      level: prof.body.level * base * lerp(0.7, 1.25, effort),
      f0: prof.body.f0 * pitch,
      f1: prof.body.f1 * pitch,
      sweep: 0.012,
      decay: prof.body.decay * jitter(rng, 0.2),
      type: 'sine',
    });
  }
  if (prof.ring) {
    ring(S, {
      t,
      level: prof.ring.level * base,
      freq: prof.ring.freq * jitter(rng, 0.12),
      decay: prof.ring.decay * jitter(rng, 0.35),
      partials: prof.ring.partials,
      spread: prof.ring.spread,
    });
  }
  if (prof.scatter) scatter(S, prof.scatter, t, prof.scatter.level * base * jitter(rng, 0.4), S.out);
  if (prof.squeak && rng() < prof.squeak) {
    // A resonant chirp: snow compressing, rubber on a polished floor.
    const { ac } = S;
    const o = ac.createOscillator();
    o.type = 'sine';
    const g = gainNode(ac, 0);
    o.connect(g);
    g.connect(S.out);
    const f = rr(rng, 900, 2400);
    setFreq(ac, o.frequency, f, t + 0.008);
    expFreq(ac, o.frequency, f * rr(rng, 1.3, 2.1), t + 0.06);
    ad(g.gain, t + 0.008, base * 0.09, 0.008, 0.06);
    try { o.start(t + 0.008); o.stop(t + 0.1); } catch { /* ignore */ }
    S.track?.(o);
  }
  if (prof.splash) {
    const { ac } = S;
    const o = ac.createOscillator();
    o.type = 'sine';
    const g = gainNode(ac, 0);
    o.connect(g);
    g.connect(S.out);
    setFreq(ac, o.frequency, rr(rng, 500, 1100), t);
    expFreq(ac, o.frequency, rr(rng, 130, 260), t + 0.09);
    ad(g.gain, t, base * prof.splash * 0.4, 0.002, 0.1);
    try { o.start(t); o.stop(t + 0.2); } catch { /* ignore */ }
    S.track?.(o);
  }
  // Gear: louder the faster you move, and never on every step.
  if (rng() < 0.55 + effort * 0.4) {
    gearRustle(S, t + rr(rng, 0, 0.03), base * lerp(0.03, 0.13, effort), S.out);
  }
  return t + 0.4;
}

/** Landing: a heavier, doubled footstep plus a knee/kit thump. */
export function land(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const impact = clamp(p.impactSpeed ?? 4, 0, 22);
  const hard = p.hard || impact > 7;
  const level = clamp(0.35 + impact / 14, 0.3, 1.5) * (p.level ?? 1);
  footstep(S, { surface: p.surface, speed: 6.5, volume: level, foot: 'left' });
  footstep(S, { surface: p.surface, speed: 6.5, volume: level * 0.8, foot: 'right' });
  thump(S, {
    t,
    level: level * (hard ? 0.55 : 0.3),
    f0: 150 * jitter(rng, 0.12),
    f1: 42,
    sweep: 0.03,
    decay: hard ? 0.19 : 0.11,
    type: 'sine',
  });
  gearRustle(S, t + 0.005, level * 0.16, S.out);
  if (hard) {
    // Boots and kit compressing: a short, dull, wide burst.
    gearRustle(S, t + 0.05, level * 0.11, S.out);
    tick(S, { t: t + 0.012, level: level * 0.14, freq: 620, q: 1.4, decay: 0.07, kind: 'pink' });
  }
  return t + 0.6;
}

export function jump(S, p = {}) {
  const t = S.t;
  const l = 0.45 * (p.level ?? 1);
  gearRustle(S, t, l * 0.3, S.out);
  // Exertion: a very short breath-shaped noise burst, no pitch.
  const { ac, rng, nz } = S;
  const src = nz.src('pink', { rate: rr(rng, 0.9, 1.2) });
  const bp = biquad(ac, 'bandpass', rr(rng, 480, 900), 1.4);
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(S.out);
  ahr(g.gain, t, l * 0.16, 0.02, 0.03, 0.14);
  nz.play(src, t);
  safeStop(src, t + 0.3);
  S.track?.(src);
  return t + 0.35;
}

export function slide(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const dur = clamp(p.duration ?? 0.75, 0.2, 2);
  const prof = stepProfile(p.surface);
  const src = nz.src('white', { loop: true, rate: rr(rng, 0.8, 1.15) });
  const bp = biquad(ac, 'bandpass', (prof.heel?.f ?? 2000) * 0.8, 1.1);
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(S.out);
  ahr(g.gain, t, 0.4 * (p.level ?? 1), 0.05, dur * 0.5, dur * 0.55);
  expFreq(ac, bp.frequency, (prof.heel?.f ?? 2000) * 0.35, t + dur);
  nz.play(src, t);
  safeStop(src, t + dur + 0.2);
  S.track?.(src);
  gearRustle(S, t, 0.16, S.out);
  return t + dur + 0.2;
}

export function mantle(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const l = 0.5 * (p.level ?? 1);
  gearRustle(S, t, l * 0.35, S.out);
  tick(S, { t: t + rr(rng, 0.05, 0.12), level: l * 0.3, freq: 900, q: 1.2, decay: 0.08, kind: 'pink' });
  footstep(S, { surface: p.surface, speed: 4, volume: l * 0.8 });
  return t + 0.6;
}

export function cloth(S, p = {}) {
  gearRustle(S, S.t, 0.09 * (p.level ?? 1), S.out);
  return S.t + 0.3;
}

/** Taking a hit: a short grunt shaped from filtered noise, plus a body thud. */
export function hurt(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const l = clamp(0.4 + (p.amount ?? 20) / 90, 0.3, 1.1) * (p.level ?? 1);
  const src = nz.src('pink', { rate: rr(rng, 0.85, 1.2) });
  const bp = biquad(ac, 'bandpass', rr(rng, 260, 480), 3.2);
  const bp2 = biquad(ac, 'bandpass', rr(rng, 900, 1500), 2.2);
  const g = gainNode(ac, 0);
  const g2 = gainNode(ac, 0.35);
  src.connect(bp);
  src.connect(bp2);
  bp.connect(g);
  bp2.connect(g2);
  g2.connect(g);
  g.connect(S.out);
  ahr(g.gain, t, l * 0.5, 0.012, 0.05, rr(rng, 0.18, 0.33));
  nz.play(src, t);
  safeStop(src, t + 0.6);
  S.track?.(src);
  thump(S, { t, level: l * 0.25, f0: 170, f1: 55, sweep: 0.02, decay: 0.1, type: 'sine' });
  return t + 0.6;
}

/** Death: the grunt, the collapse, the rifle hitting the deck. */
export function death(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const l = p.level ?? 1;
  hurt(S, { amount: 60, level: l * 1.1 });
  const fall = t + rr(rng, 0.28, 0.5);
  thump(S, { t: fall, level: l * 0.5, f0: 130, f1: 38, sweep: 0.035, decay: 0.26, type: 'sine' });
  gearRustle(S, fall, l * 0.3, S.out);
  tick(S, { t: fall + rr(rng, 0.05, 0.14), level: l * 0.22, freq: 1400, q: 3, decay: 0.06 });
  ring(S, { t: fall + 0.12, level: l * 0.05, freq: 2200, decay: 0.3, partials: 3 });
  return fall + 0.9;
}
