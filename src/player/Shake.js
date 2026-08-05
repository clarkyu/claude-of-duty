/**
 * Shake — the motion maths behind camera feel.
 * Owner: camera agent. Files owned: player/CameraRig.js, player/Shake.js.
 * Publishes: nothing on ctx; this is a pure library consumed by CameraRig.js.
 * Emits: nothing.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────
 * Camera feel is a stack of six or seven independent little dynamical systems that all
 * write into the same transform. Each one needs to be (a) frame-rate independent, (b)
 * deterministic, and (c) *stable* — a camera that explodes at 12 fps is worse than no
 * camera motion at all. Rather than sprinkle ad-hoc `lerp(a, b, 0.1)` calls through the
 * rig (which silently change behaviour with framerate and are the classic reason a game
 * "feels different on a 144 Hz monitor"), everything here is either:
 *
 *   • exponential damping — `damp(a, b, lambda, dt)` = the analytic solution to
 *     `da/dt = -lambda * (a - b)`, so the result is identical whether you take one
 *     16 ms step or four 4 ms steps; or
 *   • a damped harmonic oscillator — `Spring1` / `Spring3`, integrated semi-implicitly
 *     with a hard 1/120 s substep cap so a long frame can never make it blow up; or
 *   • an eased timer — `easeTowards`, which integrates a remaining-distance-dependent
 *     rate so the transition is non-linear (fast out, slow in) yet still dt-driven and
 *     continuous if the target flips mid-flight.
 *
 * Randomness comes from `Noise1D`, a seeded 1-D gradient (Perlin) noise. Shake driven by
 * noise rather than `sin()` reads as an impact instead of a wobble, and reading six
 * decorrelated channels out of one noise field (different offsets, slightly detuned
 * frequencies) is what stops explosion shake from looking like a metronome.
 *
 * ── Public API ──────────────────────────────────────────────────────────────────
 *   TAU, DEG2RAD, RAD2DEG
 *   clamp(v,lo,hi) clamp01(v) lerp(a,b,t) smoothstep(a,b,x) approach(a,b,maxDelta)
 *   damp(a, b, lambda, dt)                 frame-rate independent exponential smoothing
 *   dampAngle(a, b, lambda, dt)            same, shortest way round the circle
 *   easeOutCubic(t) easeOutQuint(t) easeInOutSine(t)
 *   easeTowards(cur, target, duration, dt, power)   fast-out / slow-in timer
 *   new Spring1({frequency, damping, value})        .update(dt) .impulse(v) .set(v)
 *   new Spring3({...})                              .update(dt) .impulse(x,y,z) .x .y .z
 *   new Noise1D(rng)                                .at(x) .fbm(x, octaves)
 *   new TraumaShake(rng, opts)             .add(t) .update(dt) -> .pos {x,y,z} .rot {x,y,z}
 *   new Sway(noise, opts)                  .update(dt, rate) -> .x .y .breath
 */

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Move `a` toward `b` by at most `maxDelta`. */
export function approach(a, b, maxDelta) {
  const d = b - a;
  if (d > maxDelta) return a + maxDelta;
  if (d < -maxDelta) return a - maxDelta;
  return b;
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is a rate in 1/seconds: the gap to `b` shrinks by `1/e` every `1/lambda` s.
 * Roughly, lambda 3 = lazy, 8 = responsive, 20 = snappy, 40 = almost instant.
 */
export function damp(a, b, lambda, dt) {
  if (!(dt > 0)) return a;
  return b + (a - b) * Math.exp(-lambda * dt);
}

/** As `damp`, but takes the short way around a 2*PI wrap. */
export function dampAngle(a, b, lambda, dt) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return damp(a, a + d, lambda, dt);
}

export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeOutQuint = (t) => 1 - Math.pow(1 - clamp01(t), 5);
export const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));

/**
 * Integrate `cur` toward `target` with a rate that falls off as the gap closes: fast at
 * the start of the move, gently arriving at the end. Unlike `damp` this *reaches* the
 * target in bounded time (~`duration`), which matters for ADS — a sight that asymptotes
 * forever never feels "locked on". Continuous if the target flips mid-transition,
 * because only the remaining distance feeds the rate, never a stored progress value.
 *
 * @param {number} cur      current value
 * @param {number} target   destination
 * @param {number} duration approximate seconds for a full 0->1 move
 * @param {number} dt       frame time
 * @param {number} power    <1 spends longer easing in; 0.6 is a good default
 */
export function easeTowards(cur, target, duration, dt, power = 0.6) {
  if (!(dt > 0) || duration <= 0) return target;
  const gap = target - cur;
  const remaining = Math.abs(gap);
  if (remaining < 1e-4) return target;
  // Substep so a long frame still follows the curve instead of shooting past it.
  let t = Math.min(dt, 0.25);
  let v = cur;
  while (t > 1e-6) {
    const h = Math.min(t, 1 / 90);
    t -= h;
    const rem = Math.abs(target - v);
    if (rem < 1e-4) return target;
    const rate = (0.35 + 1.75 * Math.pow(clamp01(rem), power)) / duration;
    const step = rate * h;
    v = step >= rem ? target : v + Math.sign(target - v) * step;
  }
  return v;
}

/**
 * A damped harmonic oscillator.
 * `frequency` is the undamped natural frequency in Hz; `damping` is the ratio zeta
 * (1 = critically damped, <1 overshoots and rings, >1 crawls home). Springs are how you
 * get a landing dip that *bounces* rather than a lerp that mushes.
 *
 * Integrated semi-implicitly at a fixed 1/120 s substep: with the frequencies used here
 * (<= 14 Hz) `omega * h` stays well under 1, so it is unconditionally well behaved even
 * if the game hitches for a quarter of a second.
 */
export class Spring1 {
  constructor({ frequency = 6, damping = 0.7, value = 0, target = 0 } = {}) {
    this.value = value;
    this.velocity = 0;
    this.target = target;
    this.frequency = frequency;
    this.damping = damping;
    this.maxStep = 1 / 120;
  }

  /** Kick the spring: an instantaneous change of velocity, in units/second. */
  impulse(v) {
    if (Number.isFinite(v)) this.velocity += v;
    return this;
  }

  /** Teleport: no velocity, no ringing. */
  set(v) {
    this.value = v;
    this.velocity = 0;
    return this;
  }

  reset(v = 0) {
    this.value = v;
    this.velocity = 0;
    this.target = v;
    return this;
  }

  update(dt) {
    if (!(dt > 0)) return this.value;
    const omega = this.frequency * TAU;
    const k = omega * omega;
    const c = 2 * this.damping * omega;
    let remaining = Math.min(dt, 0.25);
    while (remaining > 1e-6) {
      const h = remaining > this.maxStep ? this.maxStep : remaining;
      remaining -= h;
      const a = -k * (this.value - this.target) - c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    if (!Number.isFinite(this.value)) this.reset(0);
    return this.value;
  }

  get atRest() {
    return Math.abs(this.value - this.target) < 1e-5 && Math.abs(this.velocity) < 1e-4;
  }
}

/** Three `Spring1`s sharing one set of parameters. */
export class Spring3 {
  constructor(opts = {}) {
    this.sx = new Spring1(opts);
    this.sy = new Spring1(opts);
    this.sz = new Spring1(opts);
  }

  get x() {
    return this.sx.value;
  }

  get y() {
    return this.sy.value;
  }

  get z() {
    return this.sz.value;
  }

  impulse(x = 0, y = 0, z = 0) {
    this.sx.impulse(x);
    this.sy.impulse(y);
    this.sz.impulse(z);
    return this;
  }

  setTarget(x = 0, y = 0, z = 0) {
    this.sx.target = x;
    this.sy.target = y;
    this.sz.target = z;
    return this;
  }

  reset() {
    this.sx.reset(0);
    this.sy.reset(0);
    this.sz.reset(0);
    return this;
  }

  update(dt) {
    this.sx.update(dt);
    this.sy.update(dt);
    this.sz.update(dt);
    return this;
  }
}

/**
 * Seeded 1-D gradient noise (classic Perlin, one dimension) plus fBm.
 * Output of `at()` is roughly [-1, 1] and C1 continuous, so velocities derived from it
 * never step. The tables are built from whatever RNG you hand in — pass a *fork* of
 * `ctx.rng` so building them does not shift the global deterministic stream that other
 * systems are drawing from.
 */
export class Noise1D {
  constructor(rng) {
    const r = typeof rng === 'function' ? rng : Math.random;
    const N = 256;
    this.mask = N - 1;
    this.grad = new Float32Array(N);
    this.perm = new Uint8Array(N * 2);
    for (let i = 0; i < N; i++) {
      // Avoid near-zero gradients: they create flat spots that read as a stutter.
      const g = r() * 2 - 1;
      this.grad[i] = g >= 0 ? Math.max(g, 0.15) : Math.min(g, -0.15);
      this.perm[i] = i;
    }
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1)) & this.mask;
      const t = this.perm[i];
      this.perm[i] = this.perm[j];
      this.perm[j] = t;
    }
    for (let i = 0; i < N; i++) this.perm[i + N] = this.perm[i];
  }

  at(x) {
    if (!Number.isFinite(x)) return 0;
    const xf = Math.floor(x);
    const i0 = xf & this.mask;
    const i1 = (i0 + 1) & this.mask;
    const f = x - xf;
    const u = f * f * f * (f * (f * 6 - 15) + 10); // quintic fade: C2 continuous
    const g0 = this.grad[this.perm[i0]];
    const g1 = this.grad[this.perm[i1]];
    const n0 = g0 * f;
    const n1 = g1 * (f - 1);
    return (n0 + (n1 - n0) * u) * 2.2;
  }

  /** Fractal sum. 2–3 octaves is plenty for camera shake; more is just cost. */
  fbm(x, octaves = 3, gain = 0.5, lacunarity = 2.03) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += this.at(x * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * fBm shaped for driving a *displacement*.
   *
   * Raw fBm peaks near ±1 but its RMS is only ~0.23, so an amplitude tuned to look right
   * on the rare peak is invisible for the other 95% of the time — which is exactly why
   * naive noise shake reads as a faint shimmer instead of a hit. Dividing out the RMS
   * and soft-clipping with tanh gives a signal that spends most of its life near full
   * swing while still being hard-bounded to ±1, so the amplitude constants below mean
   * what they say and nothing can ever spike past them.
   */
  shaped(x, octaves = 2) {
    return Math.tanh(this.fbm(x, octaves) * 3.6);
  }
}

/**
 * Trauma-based shake (the Squirrel Eiserloh model).
 *
 * Callers add *trauma* in [0,1]; the actual shake amplitude is `trauma^exponent` with
 * exponent 2. That squaring is the whole trick: a grenade at your feet (trauma 1.0) is
 * sixteen times more violent than one at the far end of the street (trauma 0.5), and the
 * tail end of the decay falls off a cliff instead of dribbling out, so the camera
 * *settles* rather than shivering for a second and a half.
 *
 * Six channels — three positional, three rotational — are sampled from one noise field at
 * decorrelated offsets and slightly detuned frequencies, so nothing beats or repeats.
 * Roll gets the largest rotational amplitude because roll is what reads as "concussive"
 * on screen; yaw gets the least, because yaw shake makes people miss shots and hate you.
 */
export class TraumaShake {
  constructor(rng, opts = {}) {
    this.noise = opts.noise instanceof Noise1D ? opts.noise : new Noise1D(rng);
    this.trauma = 0;
    this.decay = opts.decay ?? 1.05; // trauma units per second
    this.frequency = opts.frequency ?? 13.5; // Hz
    this.exponent = opts.exponent ?? 2;
    this.octaves = opts.octaves ?? 2;
    this.posAmp = opts.posAmp ?? { x: 0.055, y: 0.070, z: 0.032 };
    this.rotAmp = opts.rotAmp ?? { x: 0.030, y: 0.020, z: 0.055 };
    this.pos = { x: 0, y: 0, z: 0 };
    this.rot = { x: 0, y: 0, z: 0 };
    this.intensity = 0;
    this.t = 0;
    // Decorrelated sample offsets and per-channel frequency detune.
    this._off = [0, 37.13, 74.29, 111.7, 148.9, 186.1];
    this._det = [1.0, 1.13, 0.87, 1.07, 0.93, 1.21];
  }

  /** Add trauma; saturates at 1 so a chain of explosions cannot stack into a seizure. */
  add(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return this;
    this.trauma = clamp01(this.trauma + amount);
    return this;
  }

  reset() {
    this.trauma = 0;
    this.intensity = 0;
    this.pos.x = this.pos.y = this.pos.z = 0;
    this.rot.x = this.rot.y = this.rot.z = 0;
    return this;
  }

  update(dt) {
    if (dt > 0) {
      this.t += dt;
      this.trauma = Math.max(0, this.trauma - this.decay * dt);
    }
    const s = Math.pow(this.trauma, this.exponent);
    this.intensity = s;
    if (s <= 1e-5) {
      this.pos.x = this.pos.y = this.pos.z = 0;
      this.rot.x = this.rot.y = this.rot.z = 0;
      return this;
    }
    const f = this.frequency;
    const n = this.noise;
    const o = this._off;
    const d = this._det;
    const t = this.t;
    this.pos.x = s * this.posAmp.x * n.shaped(t * f * d[0] + o[0], this.octaves);
    this.pos.y = s * this.posAmp.y * n.shaped(t * f * d[1] + o[1], this.octaves);
    this.pos.z = s * this.posAmp.z * n.shaped(t * f * d[2] + o[2], this.octaves);
    this.rot.x = s * this.rotAmp.x * n.shaped(t * f * d[3] + o[3], this.octaves);
    this.rot.y = s * this.rotAmp.y * n.shaped(t * f * d[4] + o[4], this.octaves);
    this.rot.z = s * this.rotAmp.z * n.shaped(t * f * d[5] + o[5], this.octaves);
    return this;
  }
}

/**
 * Breathing / idle sway.
 *
 * A 1:2 Lissajous (`sin t`, `sin 2t`) traces a figure-eight — the shape a rifle muzzle
 * actually describes when someone is holding it still — and a slow fBm wander on top
 * stops it from being visibly periodic, which is what separates "alive" from "animated".
 * `breath` is a 0..1 inhale/exhale envelope other systems can hang effects off.
 */
export class Sway {
  constructor(noise, { rate = 0.24, wander = 0.11 } = {}) {
    this.noise = noise;
    this.rate = rate;
    this.wander = wander;
    this.phase = 0;
    this.t = 0;
    this.x = 0;
    this.y = 0;
    this.breath = 0;
  }

  update(dt, rate) {
    if (Number.isFinite(rate)) this.rate = rate;
    if (dt > 0) {
      this.phase = (this.phase + dt * this.rate * TAU) % TAU;
      this.t += dt;
    }
    const p = this.phase;
    const w = this.t * this.wander;
    this.x = Math.sin(p) + this.noise.fbm(w + 3.1, 2) * 0.42;
    this.y = Math.sin(p * 2 + 0.7) * 0.62 + this.noise.fbm(w * 1.31 + 19.7, 2) * 0.34;
    this.breath = 0.5 - 0.5 * Math.cos(p);
    return this;
  }
}

export default {
  TAU,
  DEG2RAD,
  RAD2DEG,
  clamp,
  clamp01,
  lerp,
  smoothstep,
  approach,
  damp,
  dampAngle,
  easeOutCubic,
  easeOutQuint,
  easeInOutSine,
  easeTowards,
  Spring1,
  Spring3,
  Noise1D,
  TraumaShake,
  Sway,
};
