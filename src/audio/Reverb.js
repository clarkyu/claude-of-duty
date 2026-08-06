/**
 * Reverb.js — procedural convolution reverb. Owner: audio agent.
 *
 * There are no audio files in this project, so the impulse responses are grown
 * from noise at boot. Each zone is described by a handful of physical-ish numbers
 * and `renderIR()` turns them into a stereo AudioBuffer:
 *
 *   early reflections   discrete taps in the first ~90 ms, per-channel times so the
 *                       image is wide, amplitude following 1/d and the wall's
 *                       absorption. This is the part the ear uses to judge room
 *                       *size* — a hall without early reflections just sounds foggy.
 *   late field          exponentially decaying noise, run through a one-pole whose
 *                       cutoff itself falls over time. High frequencies die first in
 *                       every real space (air absorption + soft furnishings), and
 *                       modelling that single fact is most of the difference between
 *                       "reverb" and "a room".
 *   modal build         the late field fades *in* over the first few tens of ms so
 *                       it does not fight the early taps.
 *
 * Two convolvers run in parallel (A/B) with a cross-fade between them, so walking
 * from the street into the market hall is a 1.2 s morph rather than a click.
 *
 * Public API
 *   new Reverb(ac, { rng, quality })
 *   .input            AudioNode — send here
 *   .output           AudioNode — patch into the master pre-limiter
 *   .setZone(name, fadeSeconds)
 *   .zone             current zone name
 *   .setWet(v)        overall return level
 *   .zones            the spec table (read-only)
 *   .update(dt)       drives the cross-fade bookkeeping
 *   .dispose()
 */
import { clamp, clamp01, gainNode, delayNode, biquad, mulberry32, rampTo, setAt } from './synth/dsp.js';

/**
 * Zone specs.
 *   decay     total IR length, seconds
 *   tau       RT60-ish time constant of the late field
 *   build     seconds for the late field to fade in
 *   hf0/hf1   one-pole cutoff at t=0 and t=inf, Hz — the "brightness dies" curve
 *   hfTau     how fast the cutoff falls
 *   lowCut    high-pass on the tail, Hz
 *   preDelay  seconds before the late field starts
 *   early     [timeSeconds, gain] taps
 *   flutter   optional { spacing, count, gain } regular taps -> slap/flutter echo
 *   gain      overall return trim
 *   width     0..1 stereo decorrelation of the late field
 */
export const ZONE_SPECS = {
  /** A room, a shop interior, a stairwell landing. Short, dense, slightly boxy. */
  tight: {
    decay: 0.7, tau: 0.15, build: 0.006, hf0: 6200, hf1: 1500, hfTau: 0.1,
    lowCut: 120, preDelay: 0.004, gain: 0.62, width: 0.7,
    early: [[0.004, 0.72], [0.009, 0.55], [0.014, 0.44], [0.021, 0.35], [0.028, 0.27], [0.037, 0.21], [0.048, 0.15]],
  },
  /** Market hall, warehouse, hotel lobby. Big volume, hard floor. */
  hall: {
    decay: 2.8, tau: 0.62, build: 0.02, hf0: 8200, hf1: 1250, hfTau: 0.55,
    lowCut: 70, preDelay: 0.014, gain: 0.85, width: 0.95,
    early: [[0.011, 0.6], [0.019, 0.5], [0.027, 0.44], [0.038, 0.38], [0.052, 0.31], [0.068, 0.25], [0.086, 0.19], [0.104, 0.14]],
  },
  /** Concrete stairwell: small footprint, tall, parallel walls -> hard flutter. */
  stairwell: {
    decay: 2.0, tau: 0.44, build: 0.008, hf0: 7400, hf1: 2100, hfTau: 0.35,
    lowCut: 110, preDelay: 0.005, gain: 0.9, width: 0.55,
    early: [[0.005, 0.68], [0.011, 0.6], [0.016, 0.52]],
    flutter: { spacing: 0.0125, count: 26, gain: 0.4, decay: 0.34 },
  },
  /** Alley: two parallel facades, open above. Lateral slaps, no ceiling. */
  alley: {
    decay: 1.3, tau: 0.28, build: 0.01, hf0: 9000, hf1: 2400, hfTau: 0.3,
    lowCut: 95, preDelay: 0.008, gain: 0.72, width: 1.0,
    early: [[0.008, 0.66], [0.017, 0.5], [0.033, 0.36], [0.049, 0.24]],
    flutter: { spacing: 0.0225, count: 12, gain: 0.3, decay: 0.26 },
  },
  /** Open street: sparse late-arriving reflections off buildings across the road. */
  street: {
    decay: 1.9, tau: 0.32, build: 0.05, hf0: 5200, hf1: 850, hfTau: 0.32,
    lowCut: 80, preDelay: 0.03, gain: 0.5, width: 1.0,
    early: [[0.032, 0.42], [0.058, 0.33], [0.091, 0.26], [0.137, 0.19], [0.196, 0.13], [0.268, 0.09]],
  },
  /** Fully open ground, no facades close by. Almost nothing comes back. */
  open: {
    decay: 1.4, tau: 0.24, build: 0.09, hf0: 3600, hf1: 620, hfTau: 0.3,
    lowCut: 70, preDelay: 0.055, gain: 0.3, width: 1.0,
    early: [[0.09, 0.24], [0.16, 0.16], [0.245, 0.1]],
  },
  /** Drainage channel / underpass. Long, boomy, dark, strong regular taps. */
  underground: {
    decay: 3.4, tau: 0.9, build: 0.012, hf0: 4200, hf1: 560, hfTau: 0.7,
    lowCut: 42, preDelay: 0.009, gain: 1.0, width: 0.8,
    early: [[0.007, 0.7], [0.015, 0.62], [0.026, 0.54], [0.04, 0.45], [0.061, 0.36]],
    flutter: { spacing: 0.031, count: 16, gain: 0.34, decay: 0.7 },
  },
};

export const ZONE_NAMES = Object.keys(ZONE_SPECS);

/** One-pole coefficient for a cutoff at `f` Hz at sample rate `sr`. */
const onePole = (f, sr) => 1 - Math.exp((-2 * Math.PI * f) / sr);

/**
 * Grow a stereo impulse response for `spec`.
 * Deterministic: the same spec and the same seed always give the same buffer.
 */
export function renderIR(ac, spec, seed = 0x1f2e3d) {
  const sr = ac.sampleRate || 48000;
  const len = Math.max(64, Math.floor(spec.decay * sr));
  const buf = ac.createBuffer(2, len, sr);
  const preDelay = Math.floor((spec.preDelay || 0) * sr);
  const lowA = onePole(spec.lowCut || 80, sr);

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const rng = mulberry32(seed + c * 0x9e3779b9);
    // Decorrelate the two channels: channel 1 reads a different noise stream and
    // is offset by a few samples so the tail is wide without being phasey.
    const skew = Math.floor((spec.width ?? 1) * (c === 0 ? 0 : 13));
    let lp = 0;
    let dc = 0;
    const invTau = 1 / Math.max(0.01, spec.tau);
    const invHf = 1 / Math.max(0.01, spec.hfTau);
    const hf0 = spec.hf0 || 6000;
    const hf1 = spec.hf1 || 900;
    const build = Math.max(1e-4, spec.build || 0.01);

    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // Late field envelope: exponential decay with a short fade-in.
      const env = Math.exp(-t * invTau) * Math.min(1, t / build);
      if (env < 1e-5) {
        d[i] = 0;
        continue;
      }
      const n = rng() * 2 - 1;
      // Time-varying lowpass: the tail gets darker as it ages.
      const f = hf1 + (hf0 - hf1) * Math.exp(-t * invHf);
      const a = onePole(f, sr);
      lp += (n - lp) * a;
      // Leaky integrator removal (a high-pass) so the tail never rumbles.
      dc += (lp - dc) * lowA;
      const j = i + skew;
      if (j < len) d[j] += (lp - dc) * env;
    }

    // ── early reflections ────────────────────────────────────────────────────
    const erRng = mulberry32(seed + 977 + c * 31);
    for (const [time, g] of spec.early || []) {
      // Slightly different arrival time per channel = a wide, believable image.
      const jitterS = (erRng() * 2 - 1) * 0.0016 * (spec.width ?? 1);
      const idx = preDelay + Math.floor((time + jitterS) * sr);
      if (idx < 2 || idx >= len - 8) continue;
      const sign = erRng() < 0.5 ? -1 : 1;
      // Smear each tap over a few samples: a real reflection off a rough facade
      // is not a single Dirac, and a bare Dirac sounds like a click.
      const amp = g * sign * 0.85;
      d[idx] += amp;
      d[idx + 1] += amp * 0.55;
      d[idx + 2] += amp * -0.3;
      d[idx + 3] += amp * 0.16;
      d[idx + 5] += amp * -0.08;
    }

    // ── flutter / slap taps ──────────────────────────────────────────────────
    if (spec.flutter) {
      const { spacing, count, gain: fg, decay: fd } = spec.flutter;
      for (let k = 1; k <= count; k++) {
        const tt = spacing * k * (1 + (erRng() * 2 - 1) * 0.05);
        const idx = preDelay + Math.floor(tt * sr);
        if (idx < 2 || idx >= len - 4) break;
        const amp = fg * Math.exp(-tt / Math.max(0.02, fd)) * (erRng() < 0.5 ? -1 : 1);
        d[idx] += amp;
        d[idx + 1] += amp * 0.4;
        d[idx + 2] += amp * -0.18;
      }
    }
  }

  // Normalise by *total energy*, not by peak. A convolver's output level tracks
  // the energy in the IR, so peak-normalising would make the 3.4 s tunnel four
  // times louder than the 0.7 s room for no good reason. Energy normalisation
  // makes every zone the same loudness, and `spec.gain` then becomes an honest
  // artistic control instead of a guess.
  let peak = 0;
  let energy = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
      energy += d[i] * d[i];
    }
  }
  let norm = (1.35 / Math.max(1e-6, Math.sqrt(energy))) * (spec.gain ?? 1);
  // A single early-reflection tap must never on its own overdrive the return.
  if (peak * norm > 0.9) norm = 0.9 / peak;
  if (peak > 0 && Number.isFinite(norm)) {
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= norm;
    }
  }
  return buf;
}

export class Reverb {
  /**
   * @param {BaseAudioContext} ac
   * @param {{seed?:number, quality?:string, wet?:number}} opts
   */
  constructor(ac, opts = {}) {
    this.ac = ac;
    this.seed = opts.seed ?? 0xbeef17;
    this.quality = opts.quality || 'high';
    this.zone = 'street';
    this.target = 'street';
    this.buffers = new Map();
    this.broken = false;
    this._fade = 0;
    this._fadeLen = 0;
    this._slot = 0; // which convolver holds the *current* zone

    this.input = gainNode(ac, 1);
    // A short pre-delay in front of everything: separates the dry transient from
    // the wet bloom, which is what makes a big space read as big instead of muddy.
    this.preDelay = delayNode(ac, 0.012, 0.25);
    // Send-path tone shaping. Sending full-band into a convolver makes gunfire
    // tails hissy; rolling the top and the very bottom off is what mixers do.
    this.sendHP = biquad(ac, 'highpass', 130, 0.7);
    this.sendLP = biquad(ac, 'lowpass', 9000, 0.7);

    this.convA = ac.createConvolver();
    this.convB = ac.createConvolver();
    this.convA.normalize = false;
    this.convB.normalize = false;
    this.gainA = gainNode(ac, 1);
    this.gainB = gainNode(ac, 0);
    this.wet = gainNode(ac, opts.wet ?? 1);
    this.output = this.wet;

    this.input.connect(this.preDelay);
    this.preDelay.connect(this.sendHP);
    this.sendHP.connect(this.sendLP);
    this.sendLP.connect(this.convA);
    this.sendLP.connect(this.convB);
    this.convA.connect(this.gainA);
    this.convB.connect(this.gainB);
    this.gainA.connect(this.wet);
    this.gainB.connect(this.wet);

    this.zones = ZONE_SPECS;
  }

  /** Build (or fetch) the IR for a zone. Lazy: a zone nobody visits costs nothing. */
  bufferFor(name) {
    const spec = ZONE_SPECS[name];
    if (!spec) return null;
    let b = this.buffers.get(name);
    if (b) return b;
    // On low quality, trim the tail: convolution cost is linear in IR length.
    const trim = this.quality === 'low' ? 0.45 : this.quality === 'medium' ? 0.75 : 1;
    const use = trim < 1 ? { ...spec, decay: Math.max(0.25, spec.decay * trim) } : spec;
    try {
      b = renderIR(this.ac, use, this.seed + name.length * 7919);
    } catch {
      return null;
    }
    this.buffers.set(name, b);
    return b;
  }

  /** Pre-render the zones we are most likely to need, so the first shot is not late. */
  warm(names = ['street', 'alley', 'tight']) {
    for (const n of names) this.bufferFor(n);
  }

  /**
   * Cross-fade to `name` over `fade` seconds. Calling it with the current zone
   * (or mid-fade with the same target) is a no-op, so it is safe to call every
   * frame from the zone estimator.
   */
  setZone(name, fade = 1.2) {
    if (!ZONE_SPECS[name] || this.broken) return this.zone;
    if (name === this.target) return this.zone;
    const buf = this.bufferFor(name);
    if (!buf) return this.zone;
    const ac = this.ac;
    const t = ac.currentTime;
    const incoming = this._slot === 0 ? this.convB : this.convA;
    const gIn = this._slot === 0 ? this.gainB : this.gainA;
    const gOut = this._slot === 0 ? this.gainA : this.gainB;
    try {
      incoming.buffer = buf;
    } catch {
      this.broken = true;
      return this.zone;
    }
    const f = Math.max(0.05, fade);
    // Equal-power would be nicer but the two IRs are uncorrelated noise, so a
    // linear cross-fade already sums to roughly constant energy.
    setAt(gIn.gain, gIn.gain.value, t);
    setAt(gOut.gain, gOut.gain.value, t);
    rampTo(gIn.gain, 1, t + f);
    rampTo(gOut.gain, 0, t + f);
    this._slot ^= 1;
    this.target = name;
    this.zone = name;
    this._fade = f;
    return name;
  }

  /** Force a zone with no cross-fade (teleports, respawns, pose setup). */
  snapZone(name) {
    if (!ZONE_SPECS[name]) return;
    const buf = this.bufferFor(name);
    if (!buf) return;
    const cur = this._slot === 0 ? this.convA : this.convB;
    const gCur = this._slot === 0 ? this.gainA : this.gainB;
    const gOther = this._slot === 0 ? this.gainB : this.gainA;
    try {
      cur.buffer = buf;
    } catch {
      return;
    }
    gCur.gain.cancelScheduledValues(this.ac.currentTime);
    gOther.gain.cancelScheduledValues(this.ac.currentTime);
    gCur.gain.value = 1;
    gOther.gain.value = 0;
    this.zone = name;
    this.target = name;
  }

  setWet(v) {
    const t = this.ac.currentTime;
    rampTo(this.wet.gain, clamp(v, 0, 4), t + 0.15);
  }

  /** The current zone's spec — voices read `preDelay`/`tau` to time their tails. */
  spec() {
    return ZONE_SPECS[this.zone] || ZONE_SPECS.street;
  }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    this.buffers.clear();
    const z = this.zone;
    this.target = null;
    this.snapZone(z);
  }

  update(dt) {
    if (this._fade > 0) this._fade = Math.max(0, this._fade - dt);
  }

  dispose() {
    try {
      this.input.disconnect();
      this.preDelay.disconnect();
      this.sendHP.disconnect();
      this.sendLP.disconnect();
      this.convA.disconnect();
      this.convB.disconnect();
      this.gainA.disconnect();
      this.gainB.disconnect();
      this.wet.disconnect();
    } catch {
      /* teardown is best effort */
    }
    this.convA.buffer = null;
    this.convB.buffer = null;
    this.buffers.clear();
  }
}

export default Reverb;
