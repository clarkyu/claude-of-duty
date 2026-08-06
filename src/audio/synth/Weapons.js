/**
 * Weapons.js — gunfire synthesis. Owner: audio agent.
 *
 * A gunshot is not one sound, it is four arriving within 90 ms:
 *
 *   1. transient crack   the muzzle blast's leading edge. A few milliseconds of
 *                        noise through a bandpass that sweeps 7 kHz -> 1.3 kHz in
 *                        18 ms. This carries the *calibre*.
 *   2. body / punch      a triangle sweeping 300 Hz -> 55 Hz. This is the chest
 *                        thump. Without it a rifle is a stapler.
 *   3. mechanical        bolt unlocking, carrier travelling back, buffer spring,
 *                        carrier slamming home. Per-weapon timing; it is the layer
 *                        players unconsciously use to identify a gun.
 *   4. tail              the report bouncing off the world. Fed into the current
 *                        reverb *and* into discrete slap-back taps whose delays
 *                        come from real raycast distances to nearby surfaces
 *                        (see AudioEngine's enclosure probe). This is the layer
 *                        that separates expensive-sounding gunfire from a toy.
 *
 * Every parameter is jittered per shot from the deterministic rng, so a 900 rpm
 * burst never sounds like one sample retriggered.
 *
 * Distance rewrites the whole recipe rather than just turning it down: past ~40 m
 * the crack collapses into a dull slap, the sub grows, and a long diffuse roll
 * appears behind it.
 */
import {
  ad, biquad, chain, clamp, clamp01, crack, gainNode, hz, jitter, lerp, pick, rr,
  ring, safeStart, safeStop, setFreq, expFreq, shaper, stereoPan, thump, tick, expTo, setAt,
} from './dsp.js';

/* ── per-class voicing ─────────────────────────────────────────────────────── */

const PROFILES = {
  ar: {
    gain: 1.0,
    snap: { level: 0.5, f: 7600, decay: 0.007 },
    crack: { level: 1.0, f0: 7400, f1: 1320, sweep: 0.017, decay: 0.055, q: 0.85, drive: 0.62 },
    knock: { level: 0.72, f0: 1250, f1: 250, sweep: 0.022, decay: 0.085, q: 1.5, drive: 0.4 },
    sub: { level: 0.9, f0: 300, f1: 56, sweep: 0.05, decay: 0.2, drive: 0.35 },
    mech: 'ar',
    tail: 0.92,
    wet: 0.55,
  },
  smg: {
    gain: 0.86,
    snap: { level: 0.55, f: 8600, decay: 0.005 },
    crack: { level: 0.95, f0: 8400, f1: 1750, sweep: 0.012, decay: 0.038, q: 0.95, drive: 0.55 },
    knock: { level: 0.6, f0: 1650, f1: 340, sweep: 0.016, decay: 0.055, q: 1.7, drive: 0.35 },
    sub: { level: 0.66, f0: 340, f1: 78, sweep: 0.038, decay: 0.13, drive: 0.3 },
    mech: 'blowback',
    tail: 0.72,
    wet: 0.48,
  },
  dmr: {
    gain: 1.12,
    snap: { level: 0.52, f: 6800, decay: 0.008 },
    crack: { level: 1.0, f0: 6600, f1: 1050, sweep: 0.024, decay: 0.075, q: 0.8, drive: 0.68 },
    knock: { level: 0.85, f0: 980, f1: 190, sweep: 0.03, decay: 0.12, q: 1.35, drive: 0.45 },
    sub: { level: 1.05, f0: 260, f1: 44, sweep: 0.07, decay: 0.3, drive: 0.42 },
    mech: 'ar',
    tail: 1.1,
    wet: 0.68,
  },
  sniper: {
    gain: 1.25,
    snap: { level: 0.48, f: 6200, decay: 0.01 },
    crack: { level: 1.0, f0: 5800, f1: 880, sweep: 0.03, decay: 0.09, q: 0.75, drive: 0.72 },
    knock: { level: 0.95, f0: 820, f1: 150, sweep: 0.038, decay: 0.16, q: 1.25, drive: 0.5 },
    sub: { level: 1.2, f0: 230, f1: 38, sweep: 0.085, decay: 0.4, drive: 0.45 },
    mech: 'bolt',
    tail: 1.3,
    wet: 0.8,
  },
  lmg: {
    gain: 1.08,
    snap: { level: 0.5, f: 7000, decay: 0.008 },
    crack: { level: 1.0, f0: 7000, f1: 1180, sweep: 0.02, decay: 0.065, q: 0.82, drive: 0.66 },
    knock: { level: 0.82, f0: 1080, f1: 210, sweep: 0.026, decay: 0.1, q: 1.4, drive: 0.44 },
    sub: { level: 1.0, f0: 280, f1: 48, sweep: 0.06, decay: 0.26, drive: 0.4 },
    mech: 'openbolt',
    tail: 1.05,
    wet: 0.62,
  },
  shotgun: {
    gain: 1.15,
    snap: { level: 0.4, f: 5200, decay: 0.012 },
    crack: { level: 0.95, f0: 4200, f1: 700, sweep: 0.035, decay: 0.12, q: 0.6, drive: 0.75 },
    knock: { level: 0.9, f0: 700, f1: 130, sweep: 0.045, decay: 0.17, q: 1.1, drive: 0.5 },
    sub: { level: 1.15, f0: 210, f1: 40, sweep: 0.08, decay: 0.33, drive: 0.48 },
    mech: 'pump',
    tail: 1.15,
    wet: 0.72,
  },
  pistol: {
    gain: 0.78,
    snap: { level: 0.55, f: 8200, decay: 0.005 },
    crack: { level: 0.92, f0: 8000, f1: 1600, sweep: 0.013, decay: 0.04, q: 1.0, drive: 0.5 },
    knock: { level: 0.55, f0: 1500, f1: 300, sweep: 0.017, decay: 0.06, q: 1.8, drive: 0.32 },
    sub: { level: 0.6, f0: 330, f1: 70, sweep: 0.04, decay: 0.14, drive: 0.28 },
    mech: 'blowback',
    tail: 0.7,
    wet: 0.5,
  },
};

/** Map a weapon id / class / sound id onto a profile name. */
export function profileNameFor(id = '', opts = {}) {
  const cls = (opts.weaponClass || opts.class || '').toLowerCase();
  if (PROFILES[cls]) return cls;
  const s = String(opts.weapon || id || '').toLowerCase();
  if (s.includes('sniper') || s.includes('bolt_') || s.includes('barrett')) return 'sniper';
  if (s.includes('shotgun') || s.includes('sg_') || s.includes('pump')) return 'shotgun';
  if (s.includes('lmg') || s.includes('mg_')) return 'lmg';
  if (s.includes('dmr') || s.includes('marks') || s.includes('kestrel')) return 'dmr';
  if (s.includes('smg') || s.includes('viper')) return 'smg';
  if (s.includes('pistol') || s.includes('sidearm') || s.includes('handgun')) return 'pistol';
  return 'ar';
}

export function profileFor(id, opts) {
  return PROFILES[profileNameFor(id, opts)] || PROFILES.ar;
}

/* ── mechanical action layers ──────────────────────────────────────────────── */

/**
 * The action cycling. Times are in seconds after the shot and are what makes an
 * AR read as an AR and a blowback SMG as an SMG.
 */
function mechanism(S, style, t, level, dest) {
  const { rng } = S;
  const j = () => jitter(rng, 0.16);
  const L = level;
  switch (style) {
    case 'blowback':
      // Light bolt: fast, tinny, two impacts close together.
      tick(S, { t: t + 0.009 * j(), level: L * 0.7, freq: 3900 * j(), q: 7, decay: 0.016, dest });
      tick(S, { t: t + 0.026 * j(), level: L * 0.85, freq: 2100 * j(), q: 4.5, decay: 0.03, dest });
      tick(S, { t: t + 0.045 * j(), level: L * 0.6, freq: 5200 * j(), q: 9, decay: 0.014, dest });
      ring(S, { t: t + 0.026, level: L * 0.1, freq: 3100 * j(), decay: 0.09, partials: 2, dest });
      break;
    case 'openbolt':
      // Belt-fed: the feed pawl and the link add a rattly extra layer.
      tick(S, { t: t + 0.014 * j(), level: L * 0.75, freq: 2600 * j(), q: 5, decay: 0.028, dest });
      tick(S, { t: t + 0.038 * j(), level: L * 0.55, freq: 1500 * j(), q: 3.5, decay: 0.04, dest });
      tick(S, { t: t + 0.052 * j(), level: L * 0.5, freq: 4600 * j(), q: 10, decay: 0.02, dest });
      tick(S, { t: t + 0.07 * j(), level: L * 0.8, freq: 980 * j(), q: 2.8, decay: 0.05, dest });
      ring(S, { t: t + 0.07, level: L * 0.14, freq: 1850 * j(), decay: 0.16, partials: 3, dest });
      break;
    case 'bolt':
      // Manually operated: nothing cycles on the shot itself, just the sear and
      // a long spring ring from the receiver.
      tick(S, { t: t + 0.004 * j(), level: L * 0.5, freq: 2300 * j(), q: 6, decay: 0.02, dest });
      ring(S, { t: t + 0.006, level: L * 0.16, freq: 1450 * j(), decay: 0.4, partials: 3, dest });
      break;
    case 'pump':
      tick(S, { t: t + 0.006 * j(), level: L * 0.55, freq: 1900 * j(), q: 5, decay: 0.026, dest });
      ring(S, { t: t + 0.008, level: L * 0.1, freq: 1150 * j(), decay: 0.25, partials: 2, dest });
      break;
    case 'ar':
    default:
      // Gas gun: sear release, carrier back into the buffer, spring, carrier home.
      tick(S, { t: t + 0.006 * j(), level: L * 0.45, freq: 4400 * j(), q: 8, decay: 0.012, dest });
      tick(S, { t: t + 0.031 * j(), level: L * 0.8, freq: 1750 * j(), q: 4, decay: 0.032, dest });
      ring(S, { t: t + 0.033, level: L * 0.13, freq: 2450 * j(), decay: 0.19, partials: 3, spread: 1.61, dest });
      tick(S, { t: t + 0.063 * j(), level: L * 0.9, freq: 1020 * j(), q: 2.6, decay: 0.045, dest });
      tick(S, { t: t + 0.066 * j(), level: L * 0.4, freq: 5600 * j(), q: 11, decay: 0.016, dest });
      break;
  }
}

/* ── the shot ──────────────────────────────────────────────────────────────── */

/**
 * @param {object} S synth context from AudioEngine
 * @param {object} p { id, weapon, distance, suppressed, ads, indoors, level }
 */
export function weaponFire(S, p = {}) {
  const { ac, rng } = S;
  const t = S.t;
  const prof = profileFor(p.id, p);
  const dist = Math.max(0, p.distance ?? 0);
  const far = clamp01((dist - 26) / 70); // 0 near, 1 at ~96 m
  const veryFar = clamp01((dist - 70) / 90);
  const base = (prof.gain || 1) * (p.level ?? 1);

  // Everything that is not the mechanism goes through `dry`, which also feeds the
  // tail network — the mechanical noises are too quiet and too close to echo.
  const dry = gainNode(ac, 1);
  dry.connect(S.out);
  S.track?.(dry);
  if (S.tailIn) {
    // The slap-back network is shared and permanent; this gain is what decides
    // how much of *this* shot reaches it, and dies with the voice.
    const tailSend = gainNode(ac, prof.tail * lerp(1, 2.1, far) * (p.suppressed ? 0.35 : 1));
    dry.connect(tailSend);
    tailSend.connect(S.tailIn);
    S.track?.(tailSend);
  }
  S.setSend?.(prof.wet * lerp(1, 1.9, far) * (p.suppressed ? 0.45 : 1));

  if (p.suppressed) {
    suppressedShot(S, prof, t, base, dry);
    mechanism(S, prof.mech, t, 0.5 * base, S.out);
    return t + 0.5;
  }

  const pj = jitter(rng, 0.045); // per-shot pitch
  const lj = jitter(rng, 0.11); // per-shot level

  /* 1 ── the leading edge. Almost inaudible alone, but its absence reads as
         "muffled". Dies completely at distance: it is the first thing the air
         eats. */
  if (far < 0.72) {
    const sn = prof.snap;
    const g = gainNode(ac, 0);
    const hp = biquad(ac, 'highpass', sn.f * pj * lerp(1, 0.45, far), 0.8);
    const src = S.nz.src('white');
    src.connect(hp);
    hp.connect(g);
    g.connect(dry);
    ad(g.gain, t, sn.level * base * lj * (1 - far * 1.3), 0.0004, sn.decay);
    S.nz.play(src, t);
    safeStop(src, t + 0.05);
    S.track?.(src);
  }

  /* 2 ── transient crack. */
  const cr = prof.crack;
  crack(S, {
    t,
    dest: dry,
    level: cr.level * base * lj * lerp(1, 0.34, far),
    f0: cr.f0 * pj * lerp(1, 0.28, far),
    f1: cr.f1 * pj * lerp(1, 0.5, far),
    sweep: cr.sweep * lerp(1, 2.4, far),
    decay: cr.decay * lerp(1, 2.6, far),
    q: cr.q * lerp(1, 1.5, far),
    drive: cr.drive * (1 - far * 0.5),
  });

  /* 3 ── mid knock: the "wood block" that gives the shot its weight. */
  const kn = prof.knock;
  crack(S, {
    t: t + 0.0012 * jitter(rng, 0.4),
    dest: dry,
    level: kn.level * base * lj * lerp(1, 1.15, far),
    f0: kn.f0 * pj * lerp(1, 0.55, far),
    f1: kn.f1 * pj,
    sweep: kn.sweep * lerp(1, 1.8, far),
    decay: kn.decay * lerp(1, 2.2, far),
    q: kn.q,
    drive: kn.drive,
    hp: 90,
  });

  /* 4 ── sub. Grows with distance: low frequencies survive the trip. */
  const sb = prof.sub;
  thump(S, {
    t,
    dest: dry,
    level: sb.level * base * lj * lerp(1, 1.35, far) * lerp(1, 0.55, veryFar),
    f0: sb.f0 * pj,
    f1: sb.f1 * pj,
    sweep: sb.sweep * lerp(1, 1.6, far),
    decay: sb.decay * lerp(1, 1.7, far),
    drive: sb.drive,
    type: 'triangle',
  });
  // A second, slower sub an octave down gives the shot a floor under it.
  thump(S, {
    t: t + 0.002,
    dest: dry,
    level: sb.level * base * 0.42 * lerp(1, 1.5, far),
    f0: sb.f0 * 0.5 * pj,
    f1: sb.f1 * 0.62 * pj,
    sweep: sb.sweep * 2.1,
    decay: sb.decay * 1.9,
    type: 'sine',
  });

  /* 5 ── mechanism, dry and close. Fades out with distance long before the
         report does; nobody hears a bolt from 40 m. */
  if (far < 0.45) {
    mechanism(S, prof.mech, t, 0.34 * base * (1 - far * 2.2) * (p.ads ? 0.85 : 1), S.out);
  }

  /* 6 ── distant roll. A long, dark, diffuse swell arriving just behind the slap:
         the report smeared by every surface between there and here. */
  if (far > 0.12) {
    distantRoll(S, t, base * far, dist, dry);
  }

  return t + 0.6 + far * 1.4;
}

/** The low diffuse "boom-rrrr" behind distant gunfire. */
function distantRoll(S, t, level, dist, dest) {
  const { ac, rng, nz } = S;
  const dur = clamp(0.35 + dist * 0.014, 0.4, 1.9);
  const src = nz.src('brown', { loop: true, rate: rr(rng, 0.75, 1.1) });
  const bp = biquad(ac, 'lowpass', rr(rng, 380, 620), 0.8);
  const lo = biquad(ac, 'highpass', 55, 0.7);
  const g = gainNode(ac, 0);
  chain(src, bp, lo, g);
  g.connect(dest);
  const t0 = t + 0.012;
  setAt(g.gain, 1e-5, t0);
  expTo(g.gain, level * 0.55, t0 + 0.045);
  expTo(g.gain, 1e-5, t0 + dur);
  // The roll gets darker as it decays — later arrivals travelled further.
  setFreq(ac, bp.frequency, 900, t0);
  expFreq(ac, bp.frequency, 220, t0 + dur * 0.8);
  nz.play(src, t0);
  safeStop(src, t0 + dur + 0.08);
  S.track?.(src);
}

/** Suppressed: gas hiss and a dull thud, with the action now the loudest thing. */
function suppressedShot(S, prof, t, base, dest) {
  const { ac, rng, nz } = S;
  const pj = jitter(rng, 0.05);
  // The "phut": a short lowpassed burst, no high end at all.
  crack(S, {
    t,
    dest,
    level: 0.55 * base * jitter(rng, 0.12),
    f0: 1500 * pj,
    f1: 420 * pj,
    sweep: 0.014,
    decay: 0.05,
    q: 1.1,
    drive: 0.3,
    hp: 120,
  });
  thump(S, {
    t,
    dest,
    level: 0.45 * base,
    f0: 220 * pj,
    f1: 62 * pj,
    sweep: 0.035,
    decay: 0.11,
    type: 'sine',
  });
  // Gas bleeding past the can.
  const src = nz.src('white', { rate: rr(rng, 0.9, 1.15) });
  const bp = biquad(ac, 'bandpass', rr(rng, 2600, 4200), 1.1);
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(dest);
  ad(g.gain, t + 0.004, 0.11 * base, 0.004, 0.085);
  nz.play(src, t);
  safeStop(src, t + 0.15);
  S.track?.(src);
}

/** Standalone tail (`ar_tail` etc.) for anything that wants only the report. */
export function weaponTail(S, p = {}) {
  const prof = profileFor(p.id, p);
  const t = S.t;
  const dest = S.tailIn || S.out;
  S.setSend?.(prof.wet * 1.6);
  distantRoll(S, t, (p.level ?? 1) * prof.tail * 0.6, p.distance ?? 30, dest);
  return t + 1.2;
}

/* ── handling ──────────────────────────────────────────────────────────────── */

export function dryFire(S, p = {}) {
  const t = S.t;
  const L = 0.5 * (p.level ?? 1);
  tick(S, { t, level: L, freq: 3400 * jitter(S.rng, 0.08), q: 7, decay: 0.02 });
  tick(S, { t: t + 0.004, level: L * 0.55, freq: 1500, q: 4, decay: 0.035 });
  ring(S, { t: t + 0.002, level: L * 0.08, freq: 2900, decay: 0.1, partials: 2 });
  return t + 0.2;
}

export function magOut(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const L = 0.55 * (p.level ?? 1);
  // Catch released, magazine dragged out of the well, then clear of the lips.
  tick(S, { t, level: L * 0.8, freq: 3100 * jitter(rng, 0.1), q: 8, decay: 0.017 });
  tick(S, { t: t + rr(rng, 0.05, 0.075), level: L * 0.5, freq: 1250 * jitter(rng, 0.12), q: 2.2, decay: 0.06, kind: 'pink' });
  tick(S, { t: t + rr(rng, 0.12, 0.16), level: L * 0.42, freq: 2200 * jitter(rng, 0.14), q: 3.5, decay: 0.03 });
  ring(S, { t: t + 0.13, level: L * 0.05, freq: 1700, decay: 0.14, partials: 2 });
  return t + 0.4;
}

export function magIn(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const L = 0.62 * (p.level ?? 1);
  // Mag lips brush the well, then the seat: a solid, low, damped knock.
  tick(S, { t, level: L * 0.35, freq: 2700 * jitter(rng, 0.12), q: 4, decay: 0.024, kind: 'pink' });
  const seat = t + rr(rng, 0.055, 0.085);
  tick(S, { t: seat, level: L, freq: 780 * jitter(rng, 0.1), q: 2.0, decay: 0.055 });
  tick(S, { t: seat + 0.002, level: L * 0.5, freq: 3600 * jitter(rng, 0.1), q: 9, decay: 0.018 });
  ring(S, { t: seat, level: L * 0.09, freq: 1900 * jitter(rng, 0.08), decay: 0.16, partials: 3 });
  return t + 0.35;
}

export function boltRelease(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const L = 0.6 * (p.level ?? 1);
  tick(S, { t, level: L * 0.5, freq: 4200, q: 9, decay: 0.014 });
  tick(S, { t: t + rr(rng, 0.03, 0.045), level: L, freq: 900 * jitter(rng, 0.08), q: 2.4, decay: 0.05 });
  ring(S, { t: t + 0.032, level: L * 0.12, freq: 2300, decay: 0.22, partials: 3 });
  return t + 0.35;
}

export function chargingHandle(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const L = 0.5 * (p.level ?? 1);
  // Metal-on-metal drag, then the bolt slamming forward.
  const { ac, nz } = S;
  const src = nz.src('velvet', { rate: rr(rng, 0.7, 1.0) });
  const bp = biquad(ac, 'bandpass', 2400, 3);
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(S.out);
  ad(g.gain, t, L * 0.35, 0.008, 0.09);
  nz.play(src, t);
  safeStop(src, t + 0.2);
  S.track?.(src);
  boltRelease(S, { level: (p.level ?? 1) * 0.9 });
  return t + 0.4;
}

export function weaponSwap(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const L = 0.4 * (p.level ?? 1);
  tick(S, { t, level: L * 0.5, freq: 900, q: 1.6, decay: 0.07, kind: 'pink' });
  tick(S, { t: t + rr(rng, 0.09, 0.13), level: L * 0.7, freq: 1600, q: 3, decay: 0.05 });
  return t + 0.3;
}

export { PROFILES as WEAPON_PROFILES };
