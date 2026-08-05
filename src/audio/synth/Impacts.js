/**
 * Impacts.js — everything a bullet does after it leaves the barrel.
 * Owner: audio agent.
 *
 *   bullet impacts      one recipe per SurfaceDefs tag: concrete spits grit, metal
 *                       rings, wood thocks and splinters, flesh is a wet slap over
 *                       a low thud, glass shatters, water plops and gulps.
 *   penetration         the muffled version heard on the *far* side of a wall.
 *   ricochet            the spall crack plus a whine whose pitch sweeps as the
 *                       fragment tumbles away.
 *   flyby               a supersonic N-wave crack with a genuine Doppler sweep,
 *                       flown past the listener by automating the panner position
 *                       along the round's actual path.
 *   shell casings       brass tone shaped by whatever it landed on.
 */
import {
  ad, ahr, biquad, chain, clamp, clamp01, crack, expFreq, expTo, gainNode, hz, jitter,
  lerp, pick, ring, rr, safeStart, safeStop, setAt, setFreq, shaper, stereoPan, thump, tick,
} from './dsp.js';
import { rampPannerTo, setPannerPosition } from './Spatial.js';

/**
 * Per-surface impact voicing.
 *   crack  the sharp part: filtered noise sweeping down
 *   body   the low thud
 *   grit   granular debris scattering after the hit
 *   ring   metallic/ceramic resonance
 *   wet    a short resonant "plop"
 */
export const IMPACT_PROFILES = {
  concrete: {
    gain: 1.0, wet: 0.5,
    crack: { level: 0.85, f0: 4600, f1: 780, sweep: 0.008, decay: 0.045, q: 1.0, drive: 0.45 },
    body: { level: 0.5, f0: 260, f1: 70, sweep: 0.014, decay: 0.06 },
    grit: { level: 0.3, freq: 5200, decay: 0.16, rate: 1.0 },
  },
  metal: {
    gain: 1.0, wet: 0.62,
    crack: { level: 0.8, f0: 6800, f1: 2100, sweep: 0.005, decay: 0.03, q: 1.4, drive: 0.6 },
    body: { level: 0.28, f0: 420, f1: 150, sweep: 0.008, decay: 0.035 },
    ring: { level: 0.3, freq: 2400, decay: 0.34, partials: 4, spread: 1.51 },
    grit: { level: 0.08, freq: 7000, decay: 0.07 },
  },
  metal_thin: {
    gain: 0.95, wet: 0.6,
    crack: { level: 0.75, f0: 5200, f1: 1600, sweep: 0.005, decay: 0.028, q: 1.6, drive: 0.55 },
    body: { level: 0.2, f0: 520, f1: 190, sweep: 0.007, decay: 0.03 },
    ring: { level: 0.42, freq: 1150, decay: 0.55, partials: 5, spread: 1.37 },
  },
  wood: {
    gain: 0.92, wet: 0.42,
    crack: { level: 0.72, f0: 3000, f1: 620, sweep: 0.01, decay: 0.05, q: 1.2, drive: 0.42 },
    body: { level: 0.5, f0: 330, f1: 110, sweep: 0.012, decay: 0.07 },
    ring: { level: 0.09, freq: 780, decay: 0.11, partials: 2, spread: 2.3 },
    grit: { level: 0.16, freq: 3200, decay: 0.13, rate: 0.8 },
  },
  dirt: {
    gain: 0.8, wet: 0.28,
    crack: { level: 0.3, f0: 1500, f1: 320, sweep: 0.012, decay: 0.05, q: 0.9, drive: 0.2 },
    body: { level: 0.62, f0: 200, f1: 58, sweep: 0.02, decay: 0.09 },
    grit: { level: 0.28, freq: 1800, decay: 0.22, rate: 0.7 },
  },
  sand: {
    gain: 0.72, wet: 0.22,
    crack: { level: 0.24, f0: 2400, f1: 700, sweep: 0.014, decay: 0.06, q: 0.7, drive: 0.15 },
    body: { level: 0.42, f0: 180, f1: 52, sweep: 0.022, decay: 0.08 },
    grit: { level: 0.4, freq: 3400, decay: 0.3, rate: 0.85 },
  },
  grass: {
    gain: 0.68, wet: 0.24,
    crack: { level: 0.3, f0: 2800, f1: 900, sweep: 0.012, decay: 0.055, q: 0.8, drive: 0.15 },
    body: { level: 0.4, f0: 210, f1: 66, sweep: 0.02, decay: 0.075 },
    grit: { level: 0.3, freq: 4200, decay: 0.24, rate: 1.05 },
  },
  glass: {
    gain: 1.0, wet: 0.7,
    crack: { level: 0.8, f0: 8200, f1: 2600, sweep: 0.004, decay: 0.03, q: 1.6, drive: 0.5 },
    body: { level: 0.12, f0: 500, f1: 220, sweep: 0.006, decay: 0.02 },
    ring: { level: 0.22, freq: 5200, decay: 0.3, partials: 4, spread: 1.29 },
    shards: 0.6,
  },
  water: {
    gain: 0.8, wet: 0.4,
    crack: { level: 0.22, f0: 2600, f1: 900, sweep: 0.01, decay: 0.05, q: 0.8, drive: 0.1 },
    body: { level: 0.3, f0: 700, f1: 180, sweep: 0.03, decay: 0.06 },
    plop: { level: 0.55, f0: 1300, f1: 340, decay: 0.13 },
    grit: { level: 0.3, freq: 5600, decay: 0.3, rate: 1.2 },
  },
  fabric: {
    gain: 0.6, wet: 0.2,
    crack: { level: 0.28, f0: 2200, f1: 600, sweep: 0.012, decay: 0.05, q: 0.7, drive: 0.1 },
    body: { level: 0.35, f0: 240, f1: 80, sweep: 0.018, decay: 0.06 },
    grit: { level: 0.12, freq: 2600, decay: 0.1 },
  },
  flesh: {
    gain: 0.95, wet: 0.25,
    crack: { level: 0.42, f0: 2000, f1: 420, sweep: 0.008, decay: 0.035, q: 1.1, drive: 0.35 },
    body: { level: 0.72, f0: 300, f1: 62, sweep: 0.012, decay: 0.1 },
    plop: { level: 0.4, f0: 900, f1: 220, decay: 0.09 },
  },
  rubber: {
    gain: 0.7, wet: 0.3,
    crack: { level: 0.35, f0: 1700, f1: 430, sweep: 0.01, decay: 0.045, q: 1.0, drive: 0.25 },
    body: { level: 0.55, f0: 280, f1: 95, sweep: 0.016, decay: 0.07 },
    ring: { level: 0.05, freq: 420, decay: 0.09, partials: 2, spread: 1.9 },
  },
  plaster: {
    gain: 0.86, wet: 0.45,
    crack: { level: 0.62, f0: 3600, f1: 700, sweep: 0.01, decay: 0.05, q: 1.0, drive: 0.35 },
    body: { level: 0.4, f0: 250, f1: 74, sweep: 0.016, decay: 0.065 },
    grit: { level: 0.4, freq: 4400, decay: 0.28, rate: 0.9 },
  },
  ceramic: {
    gain: 0.95, wet: 0.6,
    crack: { level: 0.8, f0: 7200, f1: 1900, sweep: 0.005, decay: 0.032, q: 1.5, drive: 0.5 },
    body: { level: 0.25, f0: 380, f1: 140, sweep: 0.008, decay: 0.03 },
    ring: { level: 0.26, freq: 3900, decay: 0.26, partials: 3, spread: 1.44 },
    shards: 0.35,
  },
  foliage: {
    gain: 0.5, wet: 0.2,
    crack: { level: 0.2, f0: 3800, f1: 1400, sweep: 0.014, decay: 0.06, q: 0.7, drive: 0.1 },
    body: { level: 0.12, f0: 300, f1: 120, sweep: 0.02, decay: 0.05 },
    grit: { level: 0.45, freq: 5200, decay: 0.32, rate: 1.15 },
  },
  snow: {
    gain: 0.6, wet: 0.18,
    crack: { level: 0.18, f0: 2000, f1: 620, sweep: 0.016, decay: 0.07, q: 0.6, drive: 0.08 },
    body: { level: 0.34, f0: 170, f1: 48, sweep: 0.025, decay: 0.1 },
    grit: { level: 0.22, freq: 6200, decay: 0.2, rate: 1.1 },
  },
};

/** Materials whose SurfaceDefs name is not a tag get folded onto one that is. */
const ALIAS = {
  asphalt: 'concrete', brick: 'concrete', rubble: 'concrete', stone: 'concrete',
  marble: 'ceramic', tile: 'ceramic', gravel: 'sand', sandbag: 'sand',
  shingle: 'wood', carpet: 'fabric', tarp: 'fabric', canvas: 'fabric',
  thin_metal: 'metal_thin', sheet: 'metal_thin', corrugated: 'metal_thin',
};

export function impactProfile(surface, materialName) {
  const m = ALIAS[String(materialName || '').toLowerCase()];
  if (m && IMPACT_PROFILES[m]) return IMPACT_PROFILES[m];
  const s = String(surface || 'concrete').toLowerCase();
  return IMPACT_PROFILES[ALIAS[s] || s] || IMPACT_PROFILES.concrete;
}

/** Granular debris: velvet noise through a sweeping bandpass. */
function grit(S, spec, t, level, dest) {
  if (!spec || level <= 0.001) return;
  const { ac, rng, nz } = S;
  const src = nz.src('velvet', { rate: (spec.rate || 1) * rr(rng, 0.75, 1.35) });
  const bp = biquad(ac, 'bandpass', spec.freq * jitter(rng, 0.2), rr(rng, 0.8, 1.8));
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(dest);
  const d = spec.decay * jitter(rng, 0.25);
  ad(g.gain, t + 0.006, level, 0.004, d);
  expFreq(ac, bp.frequency, spec.freq * 0.42, t + d);
  nz.play(src, t);
  safeStop(src, t + d + 0.1);
  S.track?.(src);
}

/** Wet resonant plop — water, flesh. */
function plop(S, spec, t, level, dest) {
  if (!spec) return;
  const { ac, rng } = S;
  const o = ac.createOscillator();
  o.type = 'sine';
  const g = gainNode(ac, 0);
  o.connect(g);
  g.connect(dest);
  setFreq(ac, o.frequency, spec.f0 * jitter(rng, 0.18), t);
  expFreq(ac, o.frequency, spec.f1 * jitter(rng, 0.15), t + spec.decay * 0.7);
  ad(g.gain, t, level, 0.0015, spec.decay);
  safeStart(o, t);
  safeStop(o, t + spec.decay + 0.05);
  S.track?.(o);
}

/** Glass / ceramic shards tinkling away after the hit. */
function shards(S, t, level, dest) {
  const { rng } = S;
  const n = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const dt = rr(rng, 0.02, 0.34);
    ring(S, {
      t: t + dt,
      level: level * rr(rng, 0.1, 0.35) * (1 - dt),
      freq: rr(rng, 2600, 7800),
      decay: rr(rng, 0.05, 0.19),
      partials: 2,
      spread: rr(rng, 1.3, 2.2),
      dest,
    });
  }
}

/**
 * A bullet hitting something.
 * @param {object} p { surface, material, energy, level }
 */
export function bulletImpact(S, p = {}) {
  const { ac, rng } = S;
  const t = S.t;
  const prof = impactProfile(p.surface, p.material);
  // 7.62 NATO is ~3400 J; scale level with the square root of the energy so a
  // pistol round is quieter but not silent.
  const e = clamp(Math.sqrt(clamp(p.energy ?? 1800, 40, 6000) / 1800), 0.35, 1.7);
  const base = (prof.gain || 1) * e * (p.level ?? 1);
  const pj = jitter(rng, 0.12);
  const lj = jitter(rng, 0.2);
  S.setSend?.(prof.wet);

  const cr = prof.crack;
  if (cr) {
    crack(S, {
      t,
      level: cr.level * base * lj,
      f0: cr.f0 * pj,
      f1: cr.f1 * pj,
      sweep: cr.sweep,
      decay: cr.decay * jitter(rng, 0.22),
      q: cr.q,
      drive: cr.drive,
      hp: 140,
    });
  }
  const bd = prof.body;
  if (bd) {
    thump(S, {
      t,
      level: bd.level * base * lj,
      f0: bd.f0 * pj,
      f1: bd.f1 * pj,
      sweep: bd.sweep,
      decay: bd.decay * jitter(rng, 0.25),
      type: 'triangle',
      drive: 0.2,
    });
  }
  if (prof.ring) {
    ring(S, {
      t: t + 0.0015,
      level: prof.ring.level * base,
      freq: prof.ring.freq * jitter(rng, 0.14),
      decay: prof.ring.decay * jitter(rng, 0.3),
      partials: prof.ring.partials,
      spread: prof.ring.spread,
    });
  }
  if (prof.plop) plop(S, prof.plop, t + 0.002, prof.plop.level * base, S.out);
  if (prof.grit) grit(S, prof.grit, t, prof.grit.level * base * jitter(rng, 0.3), S.out);
  if (prof.shards) shards(S, t + 0.01, prof.shards * base, S.out);

  return t + 0.5;
}

/** The far side of a wall: no crack left, just a dull knock and falling debris. */
export function penetration(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const prof = impactProfile(p.surface, p.material);
  const base = 0.5 * (p.level ?? 1);
  S.setSend?.(0.55);
  crack(S, {
    t,
    level: (prof.crack?.level ?? 0.5) * base * 0.5,
    f0: (prof.crack?.f0 ?? 3000) * 0.35 * jitter(rng, 0.15),
    f1: (prof.crack?.f1 ?? 700) * 0.6,
    sweep: 0.014,
    decay: 0.06,
    q: 0.8,
    drive: 0.2,
    hp: 80,
  });
  thump(S, { t, level: 0.42 * base, f0: 240 * jitter(rng, 0.15), f1: 64, sweep: 0.02, decay: 0.09 });
  if (prof.grit) grit(S, prof.grit, t + 0.01, (prof.grit.level ?? 0.2) * base * 1.4, S.out);
  return t + 0.4;
}

/**
 * Ricochet: the spall, then a fragment whining away. The whine's pitch sweeps
 * because the fragment is receding — that is the Doppler you actually hear.
 */
export function ricochet(S, p = {}) {
  const { ac, rng } = S;
  const t = S.t;
  const base = clamp(0.55 * (p.level ?? 1) * Math.sqrt(clamp((p.energy ?? 1200) / 1500, 0.15, 3)), 0.05, 1.4);
  S.setSend?.(0.85);

  bulletImpact(S, { ...p, level: (p.level ?? 1) * 0.55 });

  // The whine: two detuned bandpassed noise voices sweeping apart, plus a thin
  // sine on top. Real ricochet whines are noisy, not pure tones.
  const dur = rr(rng, 0.28, 0.75);
  const up = rng() < 0.35;
  const f0 = rr(rng, 1500, 3400);
  const f1 = up ? f0 * rr(rng, 1.6, 2.6) : f0 * rr(rng, 0.3, 0.55);
  for (let i = 0; i < 2; i++) {
    const src = S.nz.src('white', { rate: rr(rng, 0.9, 1.1), loop: true });
    const bp = biquad(ac, 'bandpass', f0, rr(rng, 14, 26));
    const g = gainNode(ac, 0);
    chain(src, bp, g);
    g.connect(S.out);
    const det = i === 0 ? 1 : rr(rng, 1.01, 1.06);
    setFreq(ac, bp.frequency, f0 * det, t + 0.006);
    expFreq(ac, bp.frequency, f1 * det, t + 0.006 + dur);
    ahr(g.gain, t + 0.006, base * (i === 0 ? 0.5 : 0.3), 0.012, dur * 0.2, dur * 0.8);
    S.nz.play(src, t + 0.006);
    safeStop(src, t + dur + 0.12);
    S.track?.(src);
  }
  const o = ac.createOscillator();
  o.type = 'sine';
  const og = gainNode(ac, 0);
  o.connect(og);
  og.connect(S.out);
  setFreq(ac, o.frequency, f0 * 1.02, t + 0.008);
  expFreq(ac, o.frequency, f1 * 1.02, t + 0.008 + dur);
  ahr(og.gain, t + 0.008, base * 0.14, 0.02, dur * 0.15, dur * 0.85);
  safeStart(o, t + 0.008);
  safeStop(o, t + dur + 0.1);
  S.track?.(o);
  return t + dur + 0.2;
}

/**
 * Supersonic flyby. The round arrives before its own report, as an N-wave: a
 * hard crack followed by a short whip as the shock passes. Real Doppler is
 * applied by sweeping the filters *and* by flying the panner along the path, so
 * a round passing left to right actually crosses the stereo field.
 *
 * @param {object} p { position, dir, speed, distance }
 */
export function flyby(S, p = {}) {
  const { ac, rng } = S;
  const t = S.t;
  const miss = clamp(p.distance ?? 1.5, 0.15, 12);
  // Close misses are violent; a round 8 m away is a distant zip.
  const base = clamp(1.25 / (0.5 + miss * 0.85), 0.05, 1.3) * (p.level ?? 1);
  const speed = clamp(p.speed ?? 830, 200, 1200);
  S.setSend?.(0.4 + 0.5 * clamp01(miss / 8));

  // The N-wave crack.
  crack(S, {
    t,
    level: base * 1.0,
    f0: rr(rng, 6800, 9500) * lerp(1, 0.6, clamp01(miss / 10)),
    f1: rr(rng, 1400, 2400),
    sweep: 0.006,
    decay: 0.022 + miss * 0.004,
    q: 1.2,
    drive: 0.55,
    hp: 400,
  });

  // The whip: bandpassed noise sweeping down hard as the round recedes. The
  // ratio is the honest Doppler figure for a source passing at `speed`.
  const dur = clamp(0.05 + miss * 0.02, 0.05, 0.28);
  const src = S.nz.src('white', { rate: 1, loop: true });
  const bp = biquad(ac, 'bandpass', 3000, rr(rng, 3.5, 7));
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(S.out);
  const c = 343;
  const fApproach = 1 / (1 - Math.min(0.82, speed / (speed + c)));
  const fRecede = 1 / (1 + speed / (speed + c) * 1.6);
  const fc = rr(rng, 1500, 2600);
  setFreq(ac, bp.frequency, fc * fApproach, t);
  expFreq(ac, bp.frequency, fc * fRecede, t + dur);
  ahr(g.gain, t, base * 0.55, 0.004, dur * 0.15, dur * 0.9);
  S.nz.play(src, t);
  safeStop(src, t + dur + 0.1);
  S.track?.(src);

  // Fly the panner along the round's path so the crack really crosses the head.
  const panner = S.chain?.panner;
  const pos = p.position;
  if (panner && pos) {
    const d = p.dir && Number.isFinite(p.dir.x) ? p.dir : null;
    let dx, dy, dz;
    if (d) {
      const l = Math.hypot(d.x, d.y, d.z) || 1;
      dx = d.x / l; dy = d.y / l; dz = d.z / l;
    } else {
      // No direction supplied: sweep across the listener's view instead of
      // sitting still, which is always better than a static point source.
      const lx = pos.x - (S.listener?.x ?? 0);
      const lz = pos.z - (S.listener?.z ?? 0);
      const l = Math.hypot(lx, lz) || 1;
      dx = -lz / l; dy = 0; dz = lx / l;
    }
    const travel = clamp(speed * dur * 0.5, 4, 26);
    setPannerPosition(panner, pos.x - dx * travel, pos.y - dy * travel, pos.z - dz * travel, t);
    rampPannerTo(panner, pos.x + dx * travel, pos.y + dy * travel, pos.z + dz * travel, t + dur + 0.02);
  }
  return t + dur + 0.15;
}

/* ── breaking things ───────────────────────────────────────────────────────── */

/**
 * Destruction voices. Every one of these is a transient plus a *cascade*: the
 * thing failing, then the pieces of it arriving over the next second. The
 * cascade is what sells destruction — a break with no debris sounds like a
 * cardboard box no matter how loud the crack is.
 *
 *   crack     the failure itself
 *   body      how heavy the object was
 *   cascade   {n, spread, freq, decay, kind} discrete pieces landing
 *   texture   {kind, freq, q, level, decay} a continuous layer (dust, rip, crush)
 */
const BREAK_PROFILES = {
  glass_shatter: {
    gain: 1.0, wet: 0.75,
    crack: { level: 0.85, f0: 9000, f1: 2600, sweep: 0.006, decay: 0.05, q: 1.4, drive: 0.5 },
    body: { level: 0.18, f0: 420, f1: 150, sweep: 0.01, decay: 0.05 },
    cascade: { n: 22, spread: 1.5, freq: [2400, 8600], decay: [0.04, 0.24], ring: true },
    texture: { kind: 'velvet', freq: 6400, q: 1.1, level: 0.24, decay: 0.7, rate: 1.4 },
  },
  glass_shatter_safety: {
    gain: 0.95, wet: 0.6,
    crack: { level: 0.6, f0: 5200, f1: 1500, sweep: 0.01, decay: 0.06, q: 1.0, drive: 0.4 },
    body: { level: 0.25, f0: 340, f1: 120, sweep: 0.012, decay: 0.06 },
    cascade: { n: 10, spread: 0.9, freq: [1600, 4200], decay: [0.02, 0.08] },
    // Safety glass does not tinkle, it pours: one dense granular mass.
    texture: { kind: 'velvet', freq: 4200, q: 0.8, level: 0.42, decay: 0.85, rate: 2.1 },
  },
  glass_crack: {
    gain: 0.8, wet: 0.7,
    crack: { level: 0.55, f0: 7600, f1: 2200, sweep: 0.005, decay: 0.035, q: 1.8, drive: 0.4 },
    cascade: { n: 3, spread: 0.4, freq: [3000, 7000], decay: [0.03, 0.12], ring: true },
  },
  wood_break: {
    gain: 1.0, wet: 0.5,
    crack: { level: 0.75, f0: 2600, f1: 460, sweep: 0.02, decay: 0.11, q: 1.0, drive: 0.5 },
    body: { level: 0.55, f0: 260, f1: 78, sweep: 0.025, decay: 0.16 },
    cascade: { n: 9, spread: 1.1, freq: [700, 3200], decay: [0.02, 0.09] },
    texture: { kind: 'velvet', freq: 2200, q: 1.4, level: 0.26, decay: 0.45, rate: 0.7 },
    rip: { f0: 900, f1: 260, dur: 0.16, level: 0.3 },
  },
  crate_break: {
    gain: 0.95, wet: 0.5,
    crack: { level: 0.7, f0: 2200, f1: 520, sweep: 0.018, decay: 0.09, q: 1.1, drive: 0.45 },
    body: { level: 0.5, f0: 300, f1: 90, sweep: 0.022, decay: 0.14 },
    cascade: { n: 14, spread: 1.4, freq: [600, 2800], decay: [0.02, 0.11] },
    texture: { kind: 'velvet', freq: 1800, q: 1.2, level: 0.2, decay: 0.5, rate: 0.65 },
  },
  concrete_break: {
    gain: 1.15, wet: 0.65,
    crack: { level: 0.85, f0: 3400, f1: 480, sweep: 0.024, decay: 0.14, q: 0.85, drive: 0.6 },
    body: { level: 0.9, f0: 190, f1: 46, sweep: 0.05, decay: 0.4 },
    cascade: { n: 16, spread: 1.6, freq: [400, 2400], decay: [0.02, 0.1] },
    texture: { kind: 'velvet', freq: 3000, q: 0.9, level: 0.4, decay: 0.9, rate: 0.6 },
  },
  plaster_break: {
    gain: 0.85, wet: 0.55,
    crack: { level: 0.5, f0: 2800, f1: 560, sweep: 0.016, decay: 0.09, q: 0.9, drive: 0.35 },
    body: { level: 0.4, f0: 210, f1: 62, sweep: 0.03, decay: 0.18 },
    cascade: { n: 11, spread: 1.3, freq: [500, 2000], decay: [0.02, 0.08] },
    texture: { kind: 'velvet', freq: 3800, q: 0.8, level: 0.44, decay: 1.0, rate: 0.8 },
  },
  ceramic_break: {
    gain: 0.95, wet: 0.7,
    crack: { level: 0.8, f0: 7000, f1: 1700, sweep: 0.007, decay: 0.05, q: 1.5, drive: 0.5 },
    body: { level: 0.25, f0: 360, f1: 120, sweep: 0.01, decay: 0.06 },
    cascade: { n: 12, spread: 1.0, freq: [1800, 6400], decay: [0.03, 0.18], ring: true },
    texture: { kind: 'velvet', freq: 5200, q: 1.0, level: 0.2, decay: 0.5, rate: 1.2 },
  },
  metal_tear: {
    gain: 1.05, wet: 0.7,
    crack: { level: 0.6, f0: 5200, f1: 1200, sweep: 0.02, decay: 0.09, q: 1.6, drive: 0.6 },
    body: { level: 0.4, f0: 400, f1: 130, sweep: 0.02, decay: 0.12 },
    cascade: { n: 5, spread: 0.8, freq: [900, 3600], decay: [0.08, 0.4], ring: true },
    rip: { f0: 1800, f1: 420, dur: 0.35, level: 0.42, q: 9 },
  },
  chainlink_break: {
    gain: 0.85, wet: 0.6,
    crack: { level: 0.4, f0: 4600, f1: 1400, sweep: 0.008, decay: 0.04, q: 2.0, drive: 0.35 },
    cascade: { n: 20, spread: 1.1, freq: [1800, 6000], decay: [0.03, 0.14], ring: true },
    texture: { kind: 'velvet', freq: 4200, q: 2.4, level: 0.28, decay: 0.7, rate: 1.5 },
  },
  drum_burst: {
    gain: 1.15, wet: 0.75,
    crack: { level: 0.85, f0: 4200, f1: 700, sweep: 0.016, decay: 0.1, q: 0.9, drive: 0.7 },
    body: { level: 0.75, f0: 220, f1: 52, sweep: 0.04, decay: 0.3 },
    cascade: { n: 6, spread: 0.9, freq: [500, 2600], decay: [0.15, 0.7], ring: true },
    // The shell keeps ringing long after the burst.
    resonance: { freq: 320, decay: 1.4, level: 0.3, partials: 5, spread: 1.47 },
  },
  plastic_break: {
    gain: 0.75, wet: 0.45,
    crack: { level: 0.6, f0: 4200, f1: 1100, sweep: 0.008, decay: 0.04, q: 1.6, drive: 0.4 },
    body: { level: 0.2, f0: 320, f1: 110, sweep: 0.01, decay: 0.05 },
    cascade: { n: 6, spread: 0.7, freq: [1200, 4400], decay: [0.02, 0.07] },
  },
  cardboard_crush: {
    gain: 0.6, wet: 0.3,
    crack: { level: 0.25, f0: 1800, f1: 500, sweep: 0.02, decay: 0.08, q: 0.7, drive: 0.15 },
    body: { level: 0.18, f0: 200, f1: 70, sweep: 0.02, decay: 0.09 },
    texture: { kind: 'crackle', freq: 2400, q: 0.9, level: 0.4, decay: 0.55, rate: 1.1 },
  },
  fabric_tear: {
    gain: 0.7, wet: 0.35,
    crack: { level: 0.2, f0: 2600, f1: 900, sweep: 0.014, decay: 0.05, q: 0.8, drive: 0.15 },
    rip: { f0: 2600, f1: 700, dur: 0.42, level: 0.4, q: 2.2 },
    texture: { kind: 'velvet', freq: 3600, q: 1.1, level: 0.16, decay: 0.35, rate: 1.6 },
  },
};

export const BREAK_IDS = Object.keys(BREAK_PROFILES);

/** A continuous rip/screech: bandpassed velvet noise sweeping down. */
function rip(S, spec, t, level, dest) {
  const { ac, rng, nz } = S;
  const src = nz.src('velvet', { loop: true, rate: rr(rng, 1.4, 2.6) });
  const bp = biquad(ac, 'bandpass', spec.f0, spec.q ?? 3.2);
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(dest);
  const dur = spec.dur * jitter(rng, 0.25);
  ahr(g.gain, t, level, 0.01, dur * 0.3, dur * 0.8);
  setFreq(ac, bp.frequency, spec.f0 * jitter(rng, 0.15), t);
  expFreq(ac, bp.frequency, spec.f1, t + dur);
  nz.play(src, t);
  safeStop(src, t + dur + 0.2);
  S.track?.(src);
}

/** Something coming apart. Used for every `breakSound` id in Destruction.js. */
export function breakup(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const prof = BREAK_PROFILES[p.id] || BREAK_PROFILES[p.breakProfile] || BREAK_PROFILES.wood_break;
  const base = (prof.gain || 1) * clamp(p.level ?? 1, 0.05, 2.5);
  const pj = jitter(rng, 0.1);
  S.setSend?.(prof.wet ?? 0.5);

  if (prof.crack) {
    crack(S, {
      t,
      level: prof.crack.level * base * jitter(rng, 0.15),
      f0: prof.crack.f0 * pj,
      f1: prof.crack.f1 * pj,
      sweep: prof.crack.sweep,
      decay: prof.crack.decay * jitter(rng, 0.2),
      q: prof.crack.q,
      drive: prof.crack.drive,
      hp: 100,
    });
  }
  if (prof.body) {
    thump(S, {
      t,
      level: prof.body.level * base,
      f0: prof.body.f0 * pj,
      f1: prof.body.f1 * pj,
      sweep: prof.body.sweep,
      decay: prof.body.decay * jitter(rng, 0.2),
      type: 'triangle',
      drive: 0.3,
    });
  }
  if (prof.texture) {
    const tx = prof.texture;
    const src = nz.src(tx.kind, { loop: true, rate: (tx.rate || 1) * rr(rng, 0.8, 1.3) });
    const bp = biquad(ac, 'bandpass', tx.freq * pj, tx.q);
    const g = gainNode(ac, 0);
    chain(src, bp, g);
    g.connect(S.out);
    const d = tx.decay * jitter(rng, 0.25);
    ahr(g.gain, t + 0.01, tx.level * base, 0.02, d * 0.2, d);
    expFreq(ac, bp.frequency, tx.freq * 0.35, t + d);
    nz.play(src, t + 0.01);
    safeStop(src, t + d + 0.3);
    S.track?.(src);
  }
  if (prof.rip) rip(S, prof.rip, t + 0.004, prof.rip.level * base, S.out);
  if (prof.resonance) {
    ring(S, {
      t,
      level: prof.resonance.level * base,
      freq: prof.resonance.freq * pj,
      decay: prof.resonance.decay,
      partials: prof.resonance.partials,
      spread: prof.resonance.spread,
    });
  }
  if (prof.cascade) {
    const c = prof.cascade;
    const n = Math.round(c.n * clamp(p.level ?? 1, 0.4, 1.6));
    for (let i = 0; i < n; i++) {
      // Pieces arrive densest right after the break and thin out.
      const u = rng() * rng();
      const dt = 0.02 + u * c.spread;
      const lv = base * rr(rng, 0.03, 0.16) * (1 - u * 0.7);
      const f = rr(rng, c.freq[0], c.freq[1]);
      tick(S, { t: t + dt, level: lv, freq: f, q: rr(rng, 3, 11), decay: rr(rng, c.decay[0], c.decay[1]) });
      if (c.ring && rng() < 0.45) {
        ring(S, { t: t + dt, level: lv * 0.5, freq: f * 0.8, decay: rr(rng, c.decay[0], c.decay[1]) * 2.4, partials: 2, spread: rr(rng, 1.3, 2.1) });
      }
    }
    return t + 0.3 + c.spread;
  }
  return t + 0.9;
}

/* ── brass ─────────────────────────────────────────────────────────────────── */

const CASING_TONE = {
  concrete: { f: 4200, decay: 0.16, bright: 1.0, thud: 0.1 },
  metal: { f: 5200, decay: 0.34, bright: 1.25, thud: 0.06 },
  metal_thin: { f: 3400, decay: 0.42, bright: 1.15, thud: 0.14 },
  wood: { f: 3000, decay: 0.11, bright: 0.7, thud: 0.2 },
  dirt: { f: 1800, decay: 0.04, bright: 0.25, thud: 0.3 },
  sand: { f: 1500, decay: 0.03, bright: 0.15, thud: 0.28 },
  grass: { f: 2200, decay: 0.05, bright: 0.25, thud: 0.2 },
  glass: { f: 6200, decay: 0.2, bright: 1.2, thud: 0.05 },
  water: { f: 1200, decay: 0.06, bright: 0.2, thud: 0.35 },
  fabric: { f: 1400, decay: 0.03, bright: 0.12, thud: 0.22 },
  flesh: { f: 900, decay: 0.03, bright: 0.08, thud: 0.3 },
  rubber: { f: 1700, decay: 0.05, bright: 0.2, thud: 0.26 },
  plaster: { f: 3200, decay: 0.1, bright: 0.6, thud: 0.18 },
  ceramic: { f: 5600, decay: 0.24, bright: 1.15, thud: 0.08 },
  foliage: { f: 2600, decay: 0.04, bright: 0.2, thud: 0.12 },
  snow: { f: 1300, decay: 0.03, bright: 0.1, thud: 0.2 },
};

/** A casing hitting the ground. Called once per bounce by FX/Impacts.js. */
export function shellCasing(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const tone = CASING_TONE[ALIAS[p.surface] || p.surface] || CASING_TONE.concrete;
  const base = clamp(p.level ?? 0.3, 0.02, 1) * 1.5;
  S.setSend?.(0.5);
  const pj = jitter(rng, 0.16);
  tick(S, {
    t,
    level: base * 0.55 * tone.bright,
    freq: tone.f * pj,
    q: rr(rng, 7, 14),
    decay: 0.012,
  });
  if (tone.bright > 0.2) {
    ring(S, {
      t,
      level: base * 0.34 * tone.bright,
      freq: tone.f * 0.72 * pj,
      decay: tone.decay * jitter(rng, 0.35),
      partials: 3,
      spread: rr(rng, 1.4, 1.9),
    });
  }
  if (tone.thud > 0.02) {
    thump(S, { t, level: base * tone.thud, f0: 420 * pj, f1: 160, sweep: 0.006, decay: 0.03 });
  }
  return t + 0.4;
}
