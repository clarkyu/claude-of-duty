/**
 * dsp.js — Web Audio primitives shared by every synth voice. Owner: audio agent.
 *
 * Nothing in here touches the game. It is pure "how do I make a node do a thing"
 * plumbing: safe parameter automation (Web Audio throws on a non-finite or
 * non-positive exponential target and silently mis-schedules on a NaN), cached
 * noise buffers, cached waveshaper curves, and small envelope helpers.
 *
 * Every setter clamps. A single NaN reaching an AudioParam poisons the whole graph
 * for the rest of the session — there is no recovery — so the clamping is not
 * defensive style, it is load bearing.
 */

export const MIN = 1e-5;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(MIN, g));
export const finite = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** Speed of sound at 15 °C, sea level. Used for every delay/Doppler computation. */
export const SPEED_OF_SOUND = 343;

/** Deterministic RNG — never Math.random(), and never the shared ctx.rng stream
 *  either: consuming from it would shift every other system's seeded output and
 *  change the review screenshots. Level.js does the same for the same reason. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── parameter automation ──────────────────────────────────────────────────── */

export function setAt(param, value, t) {
  if (!param) return;
  try {
    param.setValueAtTime(finite(value, 0), Math.max(0, finite(t, 0)));
  } catch {
    /* an AudioParam can be detached mid-teardown */
  }
}

export function rampTo(param, value, t) {
  if (!param) return;
  try {
    param.linearRampToValueAtTime(finite(value, 0), Math.max(0, finite(t, 0)));
  } catch {
    /* ignore */
  }
}

/** Exponential ramp with the two footguns removed: zero targets and back-in-time. */
export function expTo(param, value, t) {
  if (!param) return;
  try {
    param.exponentialRampToValueAtTime(Math.max(MIN, finite(value, MIN)), Math.max(0, finite(t, 0)));
  } catch {
    /* ignore */
  }
}

export function targetAt(param, value, t, tau) {
  if (!param) return;
  try {
    param.setTargetAtTime(finite(value, 0), Math.max(0, finite(t, 0)), Math.max(1e-4, finite(tau, 0.01)));
  } catch {
    /* ignore */
  }
}

export function cancel(param, t) {
  if (!param) return;
  try {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(Math.max(0, finite(t, 0)));
    else param.cancelScheduledValues(Math.max(0, finite(t, 0)));
  } catch {
    /* ignore */
  }
}

/** Clamp a frequency into the legal biquad range for this context. */
export function hz(ac, f) {
  const n = (ac?.sampleRate || 48000) * 0.5;
  return clamp(finite(f, 1000), 10, n * 0.98);
}

export function setFreq(ac, param, f, t) {
  setAt(param, hz(ac, f), t);
}

export function rampFreq(ac, param, f, t) {
  rampTo(param, hz(ac, f), t);
}

export function expFreq(ac, param, f, t) {
  expTo(param, hz(ac, f), t);
}

/* ── node builders ─────────────────────────────────────────────────────────── */

export function gainNode(ac, v = 1) {
  const g = ac.createGain();
  g.gain.value = finite(v, 0);
  return g;
}

export function biquad(ac, type, freq, q = 0.7071, gainDb = 0) {
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz(ac, freq);
  f.Q.value = clamp(finite(q, 0.7071), 0.0001, 60);
  if (gainDb) f.gain.value = clamp(finite(gainDb, 0), -40, 40);
  return f;
}

export function delayNode(ac, seconds, max = 2) {
  const d = ac.createDelay(Math.max(0.001, max));
  d.delayTime.value = clamp(finite(seconds, 0), 0, max - 1e-3);
  return d;
}

export function compressor(ac, { threshold = -20, knee = 8, ratio = 4, attack = 0.004, release = 0.2 } = {}) {
  const c = ac.createDynamicsCompressor();
  c.threshold.value = clamp(threshold, -100, 0);
  c.knee.value = clamp(knee, 0, 40);
  c.ratio.value = clamp(ratio, 1, 20);
  c.attack.value = clamp(attack, 0, 1);
  c.release.value = clamp(release, 0, 1);
  return c;
}

export function stereoPan(ac, v = 0) {
  if (ac.createStereoPanner) {
    const p = ac.createStereoPanner();
    p.pan.value = clamp(finite(v, 0), -1, 1);
    return p;
  }
  return gainNode(ac, 1);
}

/** Connect a chain of nodes left to right; returns the last one. */
export function chain(...nodes) {
  const list = nodes.filter(Boolean);
  for (let i = 0; i < list.length - 1; i++) {
    try {
      list[i].connect(list[i + 1]);
    } catch {
      /* mismatched node kinds are a programming error, not a runtime one */
    }
  }
  return list[list.length - 1] || null;
}

export function safeStart(node, t) {
  try {
    node.start(Math.max(0, finite(t, 0)));
  } catch {
    /* already started */
  }
}

export function safeStop(node, t) {
  try {
    node.stop(Math.max(0, finite(t, 0)));
  } catch {
    /* already stopped, or never started */
  }
}

export function disconnect(node) {
  try {
    node?.disconnect();
  } catch {
    /* ignore */
  }
}

/* ── envelopes ─────────────────────────────────────────────────────────────── */

/**
 * Percussive attack/decay on a gain param. Everything in this engine is
 * percussive, so this is the workhorse.
 * @param {AudioParam} param
 * @param {number} t0 start time
 * @param {number} peak linear peak
 * @param {number} attack seconds (>= 0.0004 so we never click the DAC)
 * @param {number} decay seconds to ~ -60 dB
 * @param {number} hold  seconds at peak before the decay starts
 */
export function ad(param, t0, peak, attack = 0.001, decay = 0.1, hold = 0) {
  const p = Math.max(MIN, finite(peak, 0));
  const a = Math.max(0.0004, finite(attack, 0.001));
  setAt(param, MIN, t0);
  expTo(param, p, t0 + a);
  if (hold > 0) setAt(param, p, t0 + a + hold);
  expTo(param, MIN, t0 + a + hold + Math.max(0.002, finite(decay, 0.1)));
  return t0 + a + hold + decay;
}

/** Attack / hold / linear-ish release, used where an exponential tail sounds too thin. */
export function ahr(param, t0, peak, attack, hold, release) {
  const p = Math.max(MIN, finite(peak, 0));
  setAt(param, 0, t0);
  rampTo(param, p, t0 + Math.max(0.0004, attack));
  setAt(param, p, t0 + attack + Math.max(0, hold));
  rampTo(param, 0, t0 + attack + hold + Math.max(0.002, release));
  return t0 + attack + hold + release;
}

/* ── cached buffers ────────────────────────────────────────────────────────── */

/**
 * Noise bank. Generating noise per voice is the classic Web Audio performance
 * trap: a 2 s white-noise buffer is 96 000 rng() calls. We generate each colour
 * once and read it back from a random offset, which is inaudible and free.
 */
export class NoiseBank {
  constructor(ac, rng) {
    this.ac = ac;
    this.rng = rng;
    this.buffers = new Map();
    this.seconds = 3;
  }

  get(kind) {
    let b = this.buffers.get(kind);
    if (b) return b;
    b = this._make(kind);
    this.buffers.set(kind, b);
    return b;
  }

  _make(kind) {
    const ac = this.ac;
    const sr = ac.sampleRate;
    const n = Math.max(256, Math.floor(sr * this.seconds));
    const buf = ac.createBuffer(2, n, sr);
    const rng = this.rng;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      if (kind === 'white') {
        for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
      } else if (kind === 'pink') {
        // Paul Kellett's economy pink filter — flat enough for sound design.
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < n; i++) {
          const w = rng() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856;
          b4 = 0.55 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      } else if (kind === 'brown') {
        let last = 0;
        for (let i = 0; i < n; i++) {
          const w = rng() * 2 - 1;
          last = (last + 0.02 * w) * 0.998;
          d[i] = clamp(last * 8, -1, 1);
        }
      } else if (kind === 'velvet') {
        // Sparse signed impulses: the cheapest convincing "grain"/crackle source.
        d.fill(0);
        const density = Math.floor(sr / 900);
        for (let i = 0; i < n; i += density) {
          const j = i + Math.floor(rng() * density);
          if (j < n) d[j] = rng() < 0.5 ? -1 : 1;
        }
      } else if (kind === 'crackle') {
        // Bursty: long quiet stretches punctuated by dense clusters. Fire, rain
        // on tin, gravel underfoot.
        let energy = 0;
        for (let i = 0; i < n; i++) {
          if (rng() < 0.0007) energy = 1;
          energy *= 0.9993;
          d[i] = (rng() * 2 - 1) * energy * (rng() < 0.15 ? 1 : 0.12);
        }
      } else {
        for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
      }
    }
    return buf;
  }

  /** A buffer source reading `kind` from a random offset. Caller starts it. */
  src(kind, { loop = false, rate = 1, offset = -1 } = {}) {
    const s = this.ac.createBufferSource();
    s.buffer = this.get(kind);
    s.loop = loop;
    s.playbackRate.value = clamp(finite(rate, 1), 0.06, 12);
    s._offset = offset >= 0 ? offset : this.rng() * (this.seconds - 0.6);
    if (loop) {
      s.loopStart = 0;
      s.loopEnd = this.seconds;
    }
    return s;
  }

  /** Start a (non-looping) noise source at a random read offset. */
  play(s, t) {
    try {
      s.start(Math.max(0, t), s._offset ?? 0);
    } catch {
      safeStart(s, t);
    }
  }

  dispose() {
    this.buffers.clear();
  }
}

/* ── waveshaping ───────────────────────────────────────────────────────────── */

const CURVES = new Map();

/** tanh-ish soft clip. `k` 0..1: 0 is nearly linear, 1 is aggressive. */
export function saturationCurve(k) {
  const key = Math.round(clamp01(k) * 32);
  let c = CURVES.get(key);
  if (c) return c;
  const n = 1024;
  c = new Float32Array(n);
  const drive = 1 + key * 1.6;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  CURVES.set(key, c);
  return c;
}

export function shaper(ac, k = 0.5, oversample = 'none') {
  const w = ac.createWaveShaper();
  w.curve = saturationCurve(k);
  w.oversample = oversample;
  return w;
}

/* ── tiny helpers used all over the synth modules ──────────────────────────── */

/** Random in [a,b) from a supplied rng. */
export const rr = (rng, a, b) => a + (b - a) * rng();
/** Random symmetric jitter: 1 ± amount. */
export const jitter = (rng, amount) => 1 + (rng() * 2 - 1) * amount;
/** Weighted pick from an array. */
export const pick = (rng, arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];

/** Semitones -> playback / frequency ratio. */
export const semis = (n) => Math.pow(2, n / 12);

/**
 * A short filtered-noise "tick": the atomic unit of every mechanical sound in
 * this engine. Bolt carriers, mag catches, safety switches, casings, buckles.
 */
export function tick(S, {
  t = 0, level = 0.5, freq = 2400, q = 6, decay = 0.03, attack = 0.0006,
  type = 'bandpass', kind = 'white', rate = 1, pan = null, dest = null,
} = {}) {
  const { ac, nz } = S;
  const src = nz.src(kind, { rate });
  const f = biquad(ac, type, freq * (S.pitch || 1), q);
  const g = gainNode(ac, 0);
  src.connect(f);
  f.connect(g);
  let out = g;
  if (pan !== null && ac.createStereoPanner) {
    const p = stereoPan(ac, pan);
    g.connect(p);
    out = p;
  }
  out.connect(dest || S.out);
  ad(g.gain, t, level, attack, decay);
  nz.play(src, t);
  safeStop(src, t + decay + attack + 0.05);
  S.track?.(src);
  return t + decay;
}

/**
 * A damped resonant "ring": metal springs, casings, bell-like debris. Modelled
 * as a handful of decaying sines because a real modal model is inaudibly better
 * and ten times the code.
 */
export function ring(S, { t = 0, level = 0.2, freq = 1800, decay = 0.35, partials = 3, spread = 1.73, dest = null } = {}) {
  const { ac, rng } = S;
  const out = dest || S.out;
  for (let i = 0; i < partials; i++) {
    const o = ac.createOscillator();
    o.type = i === 0 ? 'sine' : 'triangle';
    const f = freq * Math.pow(spread, i) * jitter(rng, 0.02) * (S.pitch || 1);
    o.frequency.value = hz(ac, f);
    const g = gainNode(ac, 0);
    o.connect(g);
    g.connect(out);
    const lv = level / (1 + i * 1.7);
    const dc = decay / (1 + i * 0.65);
    ad(g.gain, t, lv, 0.0008, dc);
    safeStart(o, t);
    safeStop(o, t + dc + 0.06);
    S.track?.(o);
  }
}

/**
 * A pitch-swept sine/triangle "body". This is the punch under a gunshot and the
 * thump under an explosion; without it a gun is a click.
 */
export function thump(S, {
  t = 0, level = 0.6, f0 = 240, f1 = 52, sweep = 0.055, decay = 0.19,
  type = 'triangle', drive = 0, dest = null,
} = {}) {
  const { ac } = S;
  const o = ac.createOscillator();
  o.type = type;
  const g = gainNode(ac, 0);
  const ps = S.pitch || 1;
  setFreq(ac, o.frequency, f0 * ps, t);
  expFreq(ac, o.frequency, f1 * ps, t + Math.max(0.004, sweep));
  let node = g;
  o.connect(g);
  if (drive > 0) {
    const w = shaper(ac, drive);
    g.connect(w);
    node = w;
  }
  node.connect(dest || S.out);
  ad(g.gain, t, level, 0.0012, decay);
  safeStart(o, t);
  safeStop(o, t + decay + 0.08);
  S.track?.(o);
  return t + decay;
}

/**
 * The transient crack: a very short noise burst whose bandpass sweeps down
 * hard. Every impulsive sound in the game is some tuning of this.
 */
export function crack(S, {
  t = 0, level = 0.9, f0 = 7000, f1 = 1400, sweep = 0.02, decay = 0.05,
  q = 0.9, hp = 260, drive = 0.55, kind = 'white', dest = null,
} = {}) {
  const { ac, nz } = S;
  const ps = S.pitch || 1;
  const src = nz.src(kind, { rate: 1 });
  const bp = biquad(ac, 'bandpass', f0 * ps, q);
  const high = biquad(ac, 'highpass', hp, 0.7);
  const g = gainNode(ac, 0);
  src.connect(bp);
  bp.connect(high);
  high.connect(g);
  let out = g;
  if (drive > 0) {
    const w = shaper(ac, drive);
    g.connect(w);
    out = w;
  }
  out.connect(dest || S.out);
  setFreq(ac, bp.frequency, f0 * ps, t);
  expFreq(ac, bp.frequency, f1 * ps, t + Math.max(0.003, sweep));
  ad(g.gain, t, level, 0.0006, decay);
  nz.play(src, t);
  safeStop(src, t + decay + 0.06);
  S.track?.(src);
  return t + decay;
}

/** Band-limited noise swell — wind gusts, distant rumble, whoosh. */
export function swell(S, {
  t = 0, level = 0.2, freq = 700, q = 1.2, attack = 0.35, hold = 0.2, release = 0.9,
  kind = 'pink', rate = 1, type = 'bandpass', dest = null,
} = {}) {
  const { ac, nz } = S;
  const src = nz.src(kind, { rate, loop: true });
  const f = biquad(ac, type, freq, q);
  const g = gainNode(ac, 0);
  src.connect(f);
  f.connect(g);
  g.connect(dest || S.out);
  ahr(g.gain, t, level, attack, hold, release);
  nz.play(src, t);
  safeStop(src, t + attack + hold + release + 0.1);
  S.track?.(src);
  return { src, filter: f, gain: g, end: t + attack + hold + release };
}
