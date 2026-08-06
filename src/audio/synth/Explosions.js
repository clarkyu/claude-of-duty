/**
 * Explosions.js — ordnance, thunder and the ringing afterwards.
 * Owner: audio agent.
 *
 * An explosion is the same four-layer idea as a gunshot, stretched out and made
 * violent:
 *
 *   crack     the detonation front. 8 kHz -> 250 Hz in 25 ms, hard saturation.
 *   body      a sine falling 110 Hz -> 24 Hz over a fifth of a second. This is
 *             the part that is felt rather than heard, and it is what makes a
 *             grenade read as ordnance instead of a firework.
 *   debris    half a second of granular scatter, then sparse chunks landing.
 *   tail      2-4 seconds of dark roll fed hard into the reverb, plus the
 *             enclosure slap taps. Indoors this is overwhelming; outdoors it
 *             becomes the distant rumble bouncing off the far side of the map.
 *
 * The concussion side effects (duck + lowpass + tinnitus) are owned by
 * AudioEngine because they act on the master bus, not on this voice.
 */
import {
  ad, ahr, biquad, chain, clamp, clamp01, crack, expFreq, expTo, gainNode, jitter,
  lerp, rr, ring, safeStart, safeStop, setAt, setFreq, shaper, stereoPan, thump, tick,
} from './dsp.js';

/**
 * @param {object} p { radius, damage, distance, level, indoors }
 */
export function explosion(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const radius = clamp(p.radius ?? 6, 1, 40);
  const size = clamp(radius / 6, 0.35, 4); // 1 == a frag grenade
  const dist = Math.max(0, p.distance ?? 0);
  const far = clamp01((dist - 18) / 90);
  const base = clamp(1.15 * (p.level ?? 1) * Math.pow(size, 0.5), 0.1, 2.6);

  const dry = gainNode(ac, 1);
  dry.connect(S.out);
  S.track?.(dry);
  if (S.tailIn) {
    const tailSend = gainNode(ac, 1.5 * lerp(1, 2.4, far));
    dry.connect(tailSend);
    tailSend.connect(S.tailIn);
    S.track?.(tailSend);
  }
  S.setSend?.(1.4 * lerp(1, 2.0, far));

  /* 1 ── detonation front */
  crack(S, {
    t,
    dest: dry,
    level: base * 1.0 * lerp(1, 0.3, far),
    f0: rr(rng, 6000, 9000) * lerp(1, 0.22, far) / Math.sqrt(size),
    f1: rr(rng, 220, 380) / Math.sqrt(size),
    sweep: 0.026 * size * lerp(1, 2.5, far),
    decay: 0.14 * size * lerp(1, 2.2, far),
    q: 0.6,
    drive: 0.85,
    hp: 70,
  });
  // A second, lower crack a few ms behind: the shell body letting go.
  crack(S, {
    t: t + rr(rng, 0.004, 0.012),
    dest: dry,
    level: base * 0.85,
    f0: rr(rng, 1400, 2400) / size,
    f1: rr(rng, 120, 200) / size,
    sweep: 0.05 * size,
    decay: 0.24 * size,
    q: 0.75,
    drive: 0.8,
    hp: 45,
  });

  /* 2 ── the body you feel */
  thump(S, {
    t,
    dest: dry,
    level: base * 1.15 * lerp(1, 1.25, far),
    f0: 120 / size * jitter(rng, 0.15),
    f1: 26 / Math.sqrt(size),
    sweep: 0.16 * size,
    decay: 0.75 * size * lerp(1, 1.5, far),
    type: 'sine',
    drive: 0.45,
  });
  thump(S, {
    t: t + 0.004,
    dest: dry,
    level: base * 0.7,
    f0: 260 / size,
    f1: 58 / size,
    sweep: 0.09 * size,
    decay: 0.34 * size,
    type: 'triangle',
    drive: 0.55,
  });

  /* 3 ── debris field */
  const debDur = clamp(0.5 * size + 0.2, 0.3, 2.2);
  const deb = nz.src('crackle', { loop: true, rate: rr(rng, 0.7, 1.2) });
  const dbp = biquad(ac, 'bandpass', rr(rng, 1800, 3400), 0.8);
  const dg = gainNode(ac, 0);
  chain(deb, dbp, dg);
  dg.connect(dry);
  ahr(dg.gain, t + 0.02, base * 0.4 * (1 - far * 0.7), 0.02, debDur * 0.25, debDur);
  expFreq(ac, dbp.frequency, 700, t + debDur);
  nz.play(deb, t + 0.02);
  safeStop(deb, t + debDur + 0.4);
  S.track?.(deb);

  // Individual chunks landing afterwards.
  if (far < 0.6) {
    const chunks = 3 + Math.floor(rng() * 5 * size);
    for (let i = 0; i < chunks; i++) {
      const dt = rr(rng, 0.25, 0.35 + debDur * 1.6);
      tick(S, {
        t: t + dt,
        level: base * rr(rng, 0.02, 0.11) * (1 - dt / (debDur * 2.2 + 0.4)),
        freq: rr(rng, 500, 3200),
        q: rr(rng, 1.5, 7),
        decay: rr(rng, 0.02, 0.09),
        kind: rng() < 0.5 ? 'white' : 'pink',
        dest: S.out,
      });
    }
  }

  /* 4 ── the roll */
  const rollDur = clamp(1.2 * size + dist * 0.02, 0.9, 4.5);
  const roll = nz.src('brown', { loop: true, rate: rr(rng, 0.65, 0.95) });
  const rlp = biquad(ac, 'lowpass', 900, 0.7);
  const rhp = biquad(ac, 'highpass', 38, 0.7);
  const rg = gainNode(ac, 0);
  chain(roll, rlp, rhp, rg);
  rg.connect(dry);
  setAt(rg.gain, 1e-5, t + 0.01);
  expTo(rg.gain, base * 0.5 * lerp(0.8, 1.4, far), t + 0.09);
  expTo(rg.gain, 1e-5, t + rollDur);
  setFreq(ac, rlp.frequency, 1500, t + 0.01);
  expFreq(ac, rlp.frequency, 160, t + rollDur * 0.85);
  nz.play(roll, t + 0.01);
  safeStop(roll, t + rollDur + 0.2);
  S.track?.(roll);

  return t + rollDur + 0.5;
}

/** Thunder: the same machinery, much longer and with no transient to speak of. */
export function thunder(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const distant = !!p.distant;
  const level = clamp(p.level ?? 1, 0.05, 2);
  const dur = distant ? rr(rng, 2.6, 4.6) : rr(rng, 1.6, 3.0);
  S.setSend?.(distant ? 1.6 : 1.1);

  if (!distant) {
    // The near strike has an actual crack in front of it.
    crack(S, {
      t,
      level: level * 0.85,
      f0: rr(rng, 4000, 7000),
      f1: rr(rng, 300, 600),
      sweep: 0.05,
      decay: 0.3,
      q: 0.6,
      drive: 0.7,
      hp: 90,
    });
    thump(S, { t, level: level * 0.7, f0: 90, f1: 26, sweep: 0.2, decay: 1.1, type: 'sine', drive: 0.4 });
  }

  // The roll: three overlapping noise swells at different rates, so the ear
  // never finds a loop point.
  for (let i = 0; i < 3; i++) {
    const start = t + (distant ? rr(rng, 0, 0.5) : rr(rng, 0.05, 0.35)) + i * rr(rng, 0.15, 0.6);
    const src = nz.src('brown', { loop: true, rate: rr(rng, 0.5, 0.95) });
    const lp = biquad(ac, 'lowpass', distant ? rr(rng, 220, 420) : rr(rng, 500, 1100), 0.8);
    const hp = biquad(ac, 'highpass', distant ? 32 : 45, 0.7);
    const g = gainNode(ac, 0);
    const pan = stereoPan(ac, rr(rng, -0.5, 0.5));
    chain(src, lp, hp, g, pan);
    pan.connect(S.out);
    const d = dur * rr(rng, 0.5, 1);
    ahr(g.gain, start, level * rr(rng, 0.18, 0.42) * (distant ? 0.7 : 1), rr(rng, 0.08, 0.5), d * 0.2, d);
    // Wander the cutoff so the roll breathes.
    expFreq(ac, lp.frequency, (distant ? 120 : 260) * jitter(rng, 0.3), start + d);
    nz.play(src, start);
    safeStop(src, start + d + 0.4);
    S.track?.(src);
  }
  return t + dur + 1;
}

/** Grenade leaving the hand: cloth and a spoon pinging away. */
export function grenadeThrow(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const l = 0.5 * (p.level ?? 1);
  const src = nz.src('pink', { loop: true, rate: rr(rng, 0.9, 1.2) });
  const bp = biquad(ac, 'bandpass', 1400, 1.1);
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(S.out);
  ahr(g.gain, t, l * 0.22, 0.05, 0.03, 0.18);
  expFreq(ac, bp.frequency, 3200, t + 0.2);
  nz.play(src, t);
  safeStop(src, t + 0.45);
  S.track?.(src);
  // Spoon.
  tick(S, { t: t + rr(rng, 0.01, 0.05), level: l * 0.3, freq: rr(rng, 4200, 6400), q: 12, decay: 0.012 });
  ring(S, { t: t + 0.02, level: l * 0.07, freq: rr(rng, 3200, 4800), decay: 0.22, partials: 2 });
  return t + 0.5;
}

/** Grenade bouncing off the world before it goes off. */
export function grenadeBounce(S, p = {}) {
  const { rng } = S;
  const t = S.t;
  const l = clamp(p.level ?? 0.5, 0.05, 1.2);
  tick(S, { t, level: l * 0.5, freq: rr(rng, 1400, 2600), q: 4, decay: 0.03 });
  ring(S, { t, level: l * 0.12, freq: rr(rng, 900, 1600), decay: 0.14, partials: 2, spread: 1.8 });
  thump(S, { t, level: l * 0.2, f0: 320, f1: 120, sweep: 0.008, decay: 0.04 });
  return t + 0.3;
}

/** Whoosh past the ear — grenades, debris, RPGs. */
export function whoosh(S, p = {}) {
  const { ac, rng, nz } = S;
  const t = S.t;
  const dur = clamp(p.duration ?? 0.4, 0.1, 1.6);
  const src = nz.src('pink', { loop: true, rate: rr(rng, 0.8, 1.25) });
  const bp = biquad(ac, 'bandpass', 500, 1.6);
  const g = gainNode(ac, 0);
  chain(src, bp, g);
  g.connect(S.out);
  ahr(g.gain, t, 0.3 * (p.level ?? 1), dur * 0.4, 0.02, dur * 0.7);
  setFreq(ac, bp.frequency, 400, t);
  expFreq(ac, bp.frequency, 2200, t + dur * 0.45);
  expFreq(ac, bp.frequency, 380, t + dur);
  nz.play(src, t);
  safeStop(src, t + dur + 0.2);
  S.track?.(src);
  return t + dur + 0.2;
}
