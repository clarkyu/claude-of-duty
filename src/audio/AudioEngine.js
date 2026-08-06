/**
 * AudioEngine.js — the whole audio system. Owner: audio agent.
 * Publishes: `ctx.audio`.
 *
 * There are no audio files in this project. Every sound is synthesised with the
 * Web Audio API at the moment it is heard, from the recipes in `synth/` and the
 * procedurally-grown impulse responses in `Reverb.js`.
 *
 * ── Mixer ───────────────────────────────────────────────────────────────────────
 *
 *   weapons ─┐
 *   impacts ─┤
 *   foley   ─┼─▶ busSum ─▶ duck ─▶ muffle ─▶ limiter ─▶ clip ─▶ master ─▶ out
 *   ambience─┤      ▲                                              ▲
 *   voice   ─┤      │                                              │
 *   ui      ─┘   reverb                                        tinnitus
 *
 * Each sub-bus has its own gain and compressor so a wall of gunfire ducks itself
 * without flattening footsteps, and the master limiter guarantees that twenty
 * overlapping impacts never clip the DAC. Tinnitus is injected *after* the
 * limiter because it is meant to survive the ducking, not be crushed by it.
 *
 * ── Per-voice path ──────────────────────────────────────────────────────────────
 * synth ▶ occlusion LP ▶ air-absorption LP ▶ gain ▶ HRTF panner ▶ bus
 *                                             └▶ send ▶ reverb
 *       └▶ tailSend ▶ (shared) slap-back taps ▶ weapons bus + reverb
 *
 * Slap-back tap delays are not invented: every 0.4 s the engine fires a fan of
 * rays out of the listener and converts the hit distances into 2·d/c echo times,
 * damped by the hardness of whatever the ray hit. A gunshot fired in the drainage
 * channel therefore has different echoes from the same gunshot fired on the plaza,
 * because the geometry really is different. The tap network is shared and retuned
 * rather than rebuilt per shot: the echo pattern belongs to the room the listener
 * is standing in, not to the gun.
 *
 * ── Files ───────────────────────────────────────────────────────────────────────
 *   Reverb.js            procedural IRs + the A/B cross-fading convolver pair
 *   synth/dsp.js         safe AudioParam automation, noise bank, envelope helpers
 *   synth/Spatial.js     per-voice 3D chain, air absorption, occlusion raycasts
 *   synth/registry.js    id -> definition catalogue and the unknown-id resolver
 *   synth/Weapons.js     gunfire, suppressors, magazines, bolts
 *   synth/Impacts.js     per-surface impacts, penetration, ricochet, flyby, brass,
 *                        and every `breakSound` Destruction.js asks for
 *   synth/Foley.js       footsteps, landings, slides, cloth and gear, hurt, death
 *   synth/Explosions.js  ordnance, thunder, grenades, whooshes
 *   synth/Ambience.js    the continuous weather-driven bed and its one-shots
 *   synth/UI.js          hitmarkers, menu feedback, notifications
 *
 * ── Public API (ctx.audio) ──────────────────────────────────────────────────────
 *   play(id, opts)                 -> Voice | null      opts: {position, level,
 *                                     volume, pitch, delay, surface, energy, weapon,
 *                                     occlude, bus, ...} — anything extra is handed
 *                                     to the synth as params
 *   playAt(id, position, opts)     -> Voice | null
 *   stop(voice) / stopAll()
 *   setListener(pos, forward, up)
 *   setZone(name, fade) / zone     'tight'|'hall'|'stairwell'|'alley'|'street'|
 *                                  'open'|'underground'|'auto'
 *   setBusGain(bus, v) / getBusGain(bus)
 *   setMasterGain(v) / mute(bool)
 *   duck(amount, seconds) / concussion(strength) / tinnitus(amount, seconds)
 *   register(id, def) / has(id) / list()   the registry other modules extend
 *   resume()                       manual context resume (also hooked to gestures)
 *   context, buses, listener, reverb, stats, ready, enabled
 *
 * ── Events consumed ─────────────────────────────────────────────────────────────
 *   weapon:fire, weapon:reload, weapon:equip, weapon:empty, bullet:impact,
 *   bullet:penetrate, bullet:ricochet, bullet:whiz, entity:damage, entity:death,
 *   player:step, player:land, player:jump, player:slide, player:mantle,
 *   explosion, grenade:throw, grenade:detonate, weather:changed, hud:hitmarker,
 *   quality:changed, debug:pose {audio:{zone|mute|...}}
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   audio:ready {sampleRate}      the context actually started
 *   audio:zone  {zone, from}      the reverb zone changed
 */
import { Reverb, ZONE_SPECS } from './Reverb.js';
import { NoiseBank, mulberry32, clamp, clamp01, lerp, gainNode, biquad, compressor,
  shaper, delayNode, stereoPan, rampTo, setAt, targetAt, cancel, hz, disconnect,
  safeStart, safeStop, dbToGain, finite, chain, rr } from './synth/dsp.js';
import { Spatializer, setListenerPose, makeHitOut } from './synth/Spatial.js';
import { buildRegistry, resolveId } from './synth/registry.js';
import { Ambience } from './synth/Ambience.js';

const BUS_NAMES = ['weapons', 'impacts', 'foley', 'ambience', 'voice', 'ui'];

const BUS_SETUP = {
  weapons: { gain: 0.9, comp: { threshold: -14, knee: 6, ratio: 4.5, attack: 0.002, release: 0.22 } },
  impacts: { gain: 0.8, comp: { threshold: -18, knee: 8, ratio: 3.5, attack: 0.003, release: 0.18 } },
  foley: { gain: 0.85, comp: { threshold: -22, knee: 10, ratio: 2.6, attack: 0.006, release: 0.16 } },
  ambience: { gain: 0.7, comp: { threshold: -26, knee: 14, ratio: 2.0, attack: 0.05, release: 0.4 } },
  voice: { gain: 1.0, comp: { threshold: -18, knee: 8, ratio: 4.0, attack: 0.004, release: 0.2 } },
  ui: { gain: 0.75, comp: { threshold: -12, knee: 4, ratio: 3.0, attack: 0.002, release: 0.1 } },
};

/** Fan of directions for the enclosure probe. Cheap, and enough to tell a
 *  stairwell from a plaza. */
const PROBE_DIRS = (() => {
  const d = [[0, 1, 0], [0, -1, 0]];
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    d.push([Math.cos(a), 0.12, Math.sin(a)]);
  }
  d.push([0.5, 0.8, 0.33], [-0.5, 0.8, -0.33]);
  for (const v of d) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    v[0] /= l; v[1] /= l; v[2] /= l;
  }
  return d;
})();

const SPEED_OF_SOUND = 343;
const WORLD_MASK = 1 | 8;

/** POI id -> a reverb zone, used when the live probe says "indoors". */
const POI_ZONES = {
  market_hall: 'hall', warehouse: 'hall', hotel: 'hall', garage: 'hall',
  channel_n: 'underground', channel_s: 'underground',
  back_alley: 'alley', west_alley: 'alley',
  minaret: 'stairwell', ruin: 'tight',
};

class AudioEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.rng = mulberry32(0x5ad10a17);
    this.silent = false;
    this.ready = false;
    this.enabled = true;
    this.ac = null;
    this.buses = {};
    this.voices = [];
    /** Voices still making sound. Dead-but-unreaped voices do not count. */
    this._liveVoices = 0;
    this.registry = buildRegistry();
    this.listener = { x: 0, y: 1.7, z: 0 };
    this.forward = { x: 0, y: 0, z: -1 };
    this.up = { x: 0, y: 1, z: 0 };
    this.zone = 'street';
    this.zoneMode = 'auto';
    this.spatializer = null;
    this.reverb = null;
    this.ambience = null;
    this.nz = null;
    this._cooldowns = new Map();
    this._dupes = new Map();
    this._unsub = [];
    this._gestureBound = false;
    this._probe = { taps: [], ceiling: Infinity, mean: 24, open: 1, t: 0, zone: 'street' };
    this._hitOut = makeHitOut(ctx);
    /** Nodes fading out, disconnected once their fade has really elapsed. */
    this._retired = [];
    this._probeTimer = 0;
    this._zoneTimer = 0;
    this._warned = new Set();
    this._masterMul = 1;
    this._time = 0;
    /** Shared material global — puddles, wet stone. Refreshed with the probe. */
    this.wetness = 0;
    this.stats = { voices: 0, pending: 0, spawned: 0, dropped: 0, zone: 'street', rays: 0 };
    this.maxVoices = 40;
    this.quality = ctx?.settings?.tier || 'high';
    this.busGains = {};
    for (const b of BUS_NAMES) this.busGains[b] = BUS_SETUP[b].gain;
    this.masterGainValue = 0.85;
  }

  /* ── boot ────────────────────────────────────────────────────────────────── */

  init() {
    this.silent = !!this.ctx?.settings?.get?.('headless');
    this.quality = this.ctx?.settings?.tier || 'high';
    // The spatialiser is useful even when muted: the occlusion probe is pure
    // geometry, and running it headless is how we find out it still works.
    this.spatializer = new Spatializer(this.ctx, null, { quality: this.quality });
    if (this.silent) {
      this.ready = true;
      return;
    }
    const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) {
      this.silent = true;
      this.ready = true;
      return;
    }
    try {
      this.ac = new AC({ latencyHint: 'interactive' });
    } catch (err) {
      this._warn('context', err);
      this.silent = true;
      this.ready = true;
      return;
    }
    this.spatializer.ac = this.ac;
    this.nz = new NoiseBank(this.ac, mulberry32(0x1234abcd));
    // Prime the colours we use most so the first gunshot does not allocate
    // 3 seconds of noise on the audio thread.
    this.nz.get('white');
    this.nz.get('pink');
    this.nz.get('velvet');

    this._buildGraph();
    this._bindGestures();
    this._bindEvents();
    // If the page already has an autoplay grant (a returning player, or a
    // browser configured to allow it) we can start without waiting for a click.
    try {
      this.resume();
    } catch {
      /* the gesture handler will get it */
    }
    this.ready = true;
  }

  _buildGraph() {
    const ac = this.ac;

    this.master = gainNode(ac, this.masterGainValue);
    this.master.connect(ac.destination);

    // Brick wall. Ratio 20 with a 2 ms attack is a limiter in everything but
    // name; the soft clipper behind it catches the few samples that slip past.
    this.limiter = compressor(ac, { threshold: -3.5, knee: 0, ratio: 20, attack: 0.002, release: 0.14 });
    this.clip = shaper(ac, 0.35);
    this.limiter.connect(this.clip);
    this.clip.connect(this.master);

    // Concussion chain: a gain to duck with and a lowpass to muffle with.
    this.muffle = biquad(ac, 'lowpass', 20000, 0.7);
    this.duck = gainNode(ac, 1);
    this.duck.connect(this.muffle);
    this.muffle.connect(this.limiter);

    this.busSum = gainNode(ac, 1);
    this.busSum.connect(this.duck);

    for (const name of BUS_NAMES) {
      const setup = BUS_SETUP[name];
      const input = gainNode(ac, 1);
      const comp = compressor(ac, setup.comp);
      const out = gainNode(ac, this.busGains[name]);
      input.connect(comp);
      comp.connect(out);
      out.connect(this.busSum);
      this.buses[name] = { name, input, comp, gain: out };
    }

    this.reverb = new Reverb(ac, { seed: 0xbeef17, quality: this.quality });
    this.reverb.output.connect(this.busSum);
    try {
      this.reverb.snapZone('street');
      this.reverb.warm(['street', 'alley', 'tight']);
    } catch (err) {
      this._warn('reverb', err);
    }

    // Tinnitus lives post-limiter so a concussion is not itself compressed away.
    this.tinnitusGain = gainNode(ac, 0);
    this.tinnitusGain.connect(this.master);
    this._tinnitusNodes = null;

    this._buildSlapback();

    this.ambience = new Ambience(ac, {
      nz: this.nz,
      rng: this.rng,
      dest: this.buses.ambience.input,
      ctx: this.ctx,
      quality: this.quality,
      playAt: (id, pos, opts) => this.playAt(id, pos, opts),
    });

    this.setQuality(this.quality);
  }

  _bindGestures() {
    if (this._gestureBound || typeof window === 'undefined') return;
    this._gestureBound = true;
    const kick = () => this.resume();
    this._gestureHandler = kick;
    for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click']) {
      window.addEventListener(ev, kick, { passive: true });
    }
    this._visHandler = () => {
      if (!this.ac || this.silent) return;
      try {
        if (document.hidden) {
          if (this.ac.state === 'running') this.ac.suspend();
        } else if (this._userStarted && this.ac.state === 'suspended') {
          this.ac.resume();
        }
      } catch {
        /* the browser may refuse either way; not fatal */
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._visHandler);
    }
  }

  _unbindGestures() {
    if (typeof window === 'undefined' || !this._gestureHandler) return;
    for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click']) {
      window.removeEventListener(ev, this._gestureHandler);
    }
    if (typeof document !== 'undefined' && this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
    }
    this._gestureHandler = null;
  }

  /** Resume the context. Called on the first gesture, and available manually. */
  resume() {
    if (this.silent || !this.ac) return Promise.resolve(false);
    this._userStarted = true;
    if (this.ac.state === 'running') {
      this._afterStart();
      return Promise.resolve(true);
    }
    let p;
    try {
      p = this.ac.resume();
    } catch {
      return Promise.resolve(false);
    }
    return Promise.resolve(p)
      .then(() => {
        this._afterStart();
        return true;
      })
      .catch(() => false);
  }

  _afterStart() {
    if (this._started) return;
    if (!this.ac || this.ac.state !== 'running') return;
    this._started = true;
    try {
      this.ambience?.start();
    } catch (err) {
      this._warn('ambience', err);
    }
    this.ctx?.bus?.emit?.('audio:ready', { sampleRate: this.ac.sampleRate });
  }

  /** True when a voice spawned right now would actually be heard. */
  get live() {
    return !this.silent && !!this.ac && this.ac.state === 'running' && this.enabled;
  }

  /* ── registry ────────────────────────────────────────────────────────────── */

  register(id, definition) {
    if (!id || typeof definition !== 'object') return null;
    const base = this.registry.get(id) || {};
    const merged = { bus: 'impacts', spatial: true, occlude: true, send: 0.4, priority: 4,
      ref: 3, max: 280, rolloff: 1.05, cooldown: 0, ...base, ...definition, id };
    this.registry.set(id, merged);
    return merged;
  }

  has(id) {
    return this.registry.has(id) || !!resolveId(this.registry, id);
  }

  list() {
    return Array.from(this.registry.keys()).sort();
  }

  lookup(id) {
    return this.registry.get(id) || resolveId(this.registry, id) || null;
  }

  /* ── playback ────────────────────────────────────────────────────────────── */

  playAt(id, position, opts = {}) {
    return this.play(id, { ...opts, position });
  }

  /**
   * @param {string} id
   * @param {object} opts
   * @returns {object|null} a voice handle, or null if nothing was spawned
   */
  play(id, opts = {}) {
    try {
      return this._play(id, opts);
    } catch (err) {
      this._warn(`play(${id})`, err);
      return null;
    }
  }

  _play(id, opts) {
    const d = this.lookup(id);
    if (!d) return null;
    if (!this.live) return null;

    const ac = this.ac;
    const nowT = ac.currentTime;

    // Anti-machine-gun: a per-id minimum spacing for the very chatty ids.
    const cd = opts.cooldown ?? d.cooldown;
    if (cd > 0) {
      const last = this._cooldowns.get(d.id);
      if (last !== undefined && nowT - last < cd) return null;
      this._cooldowns.set(d.id, nowT);
    }

    // Several systems both emit their event *and* call play() for the same
    // thing (Ballistics does it for every impact and every explosion,
    // WeaponSystem for every shot). Rather than pick one and have the other
    // silently stop working when its owner refactors, collapse anything
    // identical arriving at the same place inside 40 ms.
    // (A deliberately delayed play — a scheduled burst — is never a duplicate.)
    if (!opts.delay && !opts.nodedupe && this._isDuplicate(d.id, opts.position, nowT)) return null;

    const spatial = opts.spatial ?? d.spatial;
    const pos = readVec(opts.position) || (spatial ? { ...this.listener } : null);
    const dist = spatial && pos ? this.spatializer.distanceTo(pos) : 0;
    const maxD = opts.max ?? d.max;
    if (spatial && dist > maxD) return null;

    // Voice budget. A new sound only evicts an older one if it matters more.
    const prio = opts.priority ?? d.priority ?? 4;
    if (this._liveVoices >= this.maxVoices && !this._makeRoom(prio)) {
      this.stats.dropped++;
      return null;
    }

    const busName = opts.bus || d.bus || 'impacts';
    const bus = this.buses[busName] || this.buses.impacts;

    // Speed of sound. You see the muzzle flash across the plaza, then you hear it.
    let t0 = nowT + Math.max(0, finite(opts.delay, 0)) + 0.004;
    const propagate = opts.propagate ?? d.propagate ?? spatial;
    if (propagate && dist > 8) t0 += Math.min(1.4, (dist - 8) / SPEED_OF_SOUND);

    /* ── spatial chain ─────────────────────────────────────────────────────── */
    let chainObj = null;
    let out;
    if (spatial && pos) {
      chainObj = this.spatializer.makeChain({
        position: pos,
        dest: bus.input,
        reverb: this.reverb?.input,
        send: opts.send ?? d.send ?? 0,
        gain: 1,
        occlude: (opts.occlude ?? d.occlude) !== false,
        refDistance: opts.ref ?? d.ref,
        maxDistance: maxD,
        rolloff: opts.rolloff ?? d.rolloff,
      });
      out = chainObj.input;
    } else {
      // 2D: still gets a reverb send so a reload in a stairwell sounds like it.
      const g = gainNode(ac, 1);
      g.connect(bus.input);
      let sendGain = null;
      const s = opts.send ?? d.send ?? 0;
      if (s > 0 && this.reverb) {
        sendGain = gainNode(ac, s);
        g.connect(sendGain);
        sendGain.connect(this.reverb.input);
      }
      chainObj = {
        input: g, gain: g, panner: null, sendGain, position: pos || { ...this.listener },
        occlude: false,
        setPosition: () => {},
        applyOcclusion: () => {},
        updateAir: () => {},
        dispose: () => { disconnect(g); if (sendGain) disconnect(sendGain); },
      };
      out = g;
    }

    /* ── tail / slap-back ──────────────────────────────────────────────────── */
    const tailIn = (opts.tail ?? d.tail) && this.slap ? this.slap.input : null;

    /* ── the voice ─────────────────────────────────────────────────────────── */
    const tracked = [];
    const params = {
      ...(d.params || {}),
      ...opts,
      id: d.id,
      distance: dist,
      surface: opts.surface || d.surface,
      weaponClass: opts.weaponClass || d.weaponClass,
      suppressed: opts.suppressed ?? d.suppressed,
      wetness: opts.wetness ?? this.wetness,
      level: clamp(finite(opts.level, 1) * finite(opts.volume, 1), 0, 4),
    };

    const S = {
      ac,
      nz: this.nz,
      rng: this.rng,
      t: t0,
      out,
      tailIn,
      chain: chainObj,
      listener: this.listener,
      quality: this.quality,
      pitch: clamp(finite(opts.pitch, 1), 0.25, 4),
      zone: this.zone,
      probe: this._probe,
      track: (n) => { if (tracked.length < 64) tracked.push(n); },
      setSend: (v) => {
        if (!chainObj) return;
        chainObj.baseSend = finite(v, 0);
        if (!chainObj.sendGain) return;
        const dw = spatial ? clamp(0.35 + dist / 42, 0.35, 2.4) : 1;
        const occ = chainObj._occ?.send ?? 1;
        setAt(chainObj.sendGain.gain, clamp(chainObj.baseSend * dw * occ, 0, 4), t0);
      },
    };

    let end = t0 + 0.5;
    try {
      const r = d.build?.(S, params);
      if (Number.isFinite(r)) end = Math.max(end, r);
    } catch (err) {
      this._warn(`build(${d.id})`, err);
    }

    const voice = {
      id: d.id,
      bus: busName,
      priority: prio,
      start: t0,
      // The slap-back taps are on a shared network, but the voice's own send
      // node feeds them, so hold the voice open long enough for the last echo.
      end: end + 0.35 + (tailIn ? 1.4 : 0),
      chain: chainObj,
      tracked,
      position: chainObj.position,
      occlude: spatial && (opts.occlude ?? d.occlude) !== false && (end - t0) > 0.6,
      dead: false,
      stop: (fade = 0.05) => this._killVoice(voice, fade),
    };
    this.voices.push(voice);
    this._liveVoices++;
    this.stats.spawned++;
    return voice;
  }

  /**
   * The slap-back network: discrete echoes off the real geometry around the
   * listener. It is built once and *retuned* from the enclosure probe rather
   * than rebuilt per shot — the echo pattern is a property of the room the
   * listener is standing in, not of the gun, so one shared network is both
   * cheaper and more correct than one per voice.
   */
  _buildSlapback() {
    if (this.slap) this._disposeSlapback();
    const ac = this.ac;
    const n = this.quality === 'ultra' ? 4 : this.quality === 'high' ? 3 : this.quality === 'medium' ? 2 : 0;
    if (n === 0) {
      this.slap = null;
      return;
    }
    const input = gainNode(ac, 1);
    const taps = [];
    for (let i = 0; i < n; i++) {
      const dl = delayNode(ac, 0.04 + i * 0.02, 1.3);
      const lp = biquad(ac, 'lowpass', 5000, 0.7);
      const hp = biquad(ac, 'highpass', 120, 0.7);
      const g = gainNode(ac, 0);
      // Alternate across the stereo field: reflections do not all come from one
      // place, and a mono slap sounds like a delay pedal.
      const pan = stereoPan(ac, (i % 2 === 0 ? 1 : -1) * (0.34 + 0.16 * i));
      chain(input, dl, lp, hp, g, pan);
      pan.connect(this.buses.weapons.input);
      // Each echo also excites the reverb, which is what turns three discrete
      // slaps into one continuous tail.
      const rs = gainNode(ac, 0.55);
      g.connect(rs);
      if (this.reverb) rs.connect(this.reverb.input);
      taps.push({ dl, lp, hp, g, pan, rs });
    }
    // Straight into the reverb too, so even in open ground there is a bloom.
    const wet = gainNode(ac, 0.8);
    input.connect(wet);
    if (this.reverb) wet.connect(this.reverb.input);
    this.slap = { input, taps, wet };
    this._tuneSlapback(0);
  }

  /** Push the probe's measured echo times into the live network. */
  _tuneSlapback(glide = 0.3) {
    const s = this.slap;
    if (!s || !this.ac) return;
    const t = this.ac.currentTime;
    const src = this._probe.taps;
    for (let i = 0; i < s.taps.length; i++) {
      const tap = s.taps[i];
      const p = src[i];
      if (!p) {
        rampTo(tap.g.gain, 0, t + glide);
        continue;
      }
      // Delay time is glided rather than jumped: a step in a live delay line is
      // an audible click, and a slow glide reads as the room changing shape.
      targetAt(tap.dl.delayTime, clamp(p.delay, 0.006, 1.2), t, Math.max(0.02, glide * 0.4));
      targetAt(tap.lp.frequency, hz(this.ac, p.damp), t, glide * 0.5);
      rampTo(tap.g.gain, clamp(p.gain, 0, 0.6), t + glide);
    }
  }

  _disposeSlapback() {
    const s = this.slap;
    if (!s) return;
    for (const tap of s.taps) {
      disconnect(tap.dl); disconnect(tap.lp); disconnect(tap.hp);
      disconnect(tap.g); disconnect(tap.pan); disconnect(tap.rs);
    }
    disconnect(s.wet);
    disconnect(s.input);
    this.slap = null;
  }

  /** Collapse the same sound fired twice at the same spot within 40 ms. */
  _isDuplicate(id, position, now) {
    const p = readVec(position);
    const key = p
      ? `${id}|${Math.round(p.x * 2)},${Math.round(p.y * 2)},${Math.round(p.z * 2)}`
      : id;
    const last = this._dupes.get(key);
    if (last !== undefined && now - last < 0.04) return true;
    this._dupes.set(key, now);
    if (this._dupes.size > 256) {
      for (const [k, t] of this._dupes) {
        if (now - t > 0.5) this._dupes.delete(k);
      }
    }
    return false;
  }

  _makeRoom(priority) {
    // Evict the least important thing that is already past its transient.
    // Dead voices are skipped: they are already silent and no longer count
    // against the budget, they are just waiting for their nodes to be reaped.
    let worst = -1;
    let worstScore = Infinity;
    const now = this.ac.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.dead) continue;
      const age = now - v.start;
      const score = v.priority - clamp01(age / 1.5) * 2;
      if (score < worstScore) {
        worstScore = score;
        worst = i;
      }
    }
    if (worst < 0) return false;
    if (this.voices[worst].priority > priority) return false;
    this._killVoice(this.voices[worst], 0.04);
    return true;
  }

  _killVoice(v, fade = 0.04) {
    if (!v || v.dead) return;
    v.dead = true;
    this._liveVoices = Math.max(0, this._liveVoices - 1);
    const t = this.ac ? this.ac.currentTime : 0;
    try {
      if (v.chain?.gain) {
        cancel(v.chain.gain.gain, t);
        rampTo(v.chain.gain.gain, 0, t + fade);
      }
      for (const n of v.tracked) safeStop(n, t + fade + 0.01);
    } catch {
      /* best effort */
    }
    v.end = t + fade + 0.05;
  }

  _reap() {
    if (!this.ac) return;
    const now = this.ac.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (now < v.end) continue;
      this.voices.splice(i, 1);
      if (!v.dead) {
        v.dead = true;
        this._liveVoices = Math.max(0, this._liveVoices - 1);
      }
      try {
        for (const n of v.tracked) {
          safeStop(n, now);
          disconnect(n);
        }
        v.chain?.dispose?.();
      } catch {
        /* teardown is best effort */
      }
    }
    this.stats.voices = this._liveVoices;
    this.stats.pending = this.voices.length;
  }

  stopAll(fade = 0.06) {
    for (const v of this.voices.slice()) this._killVoice(v, fade);
    if (this.ac) {
      // Force the reap on the next update rather than waiting out long tails.
      const t = this.ac.currentTime + fade + 0.06;
      for (const v of this.voices) v.end = Math.min(v.end, t);
    }
  }

  /* ── listener, zones, enclosure ──────────────────────────────────────────── */

  setListener(pos, forward, up) {
    if (!pos) return;
    this.listener.x = finite(pos.x, this.listener.x);
    this.listener.y = finite(pos.y, this.listener.y);
    this.listener.z = finite(pos.z, this.listener.z);
    if (forward) {
      this.forward.x = finite(forward.x, this.forward.x);
      this.forward.y = finite(forward.y, this.forward.y);
      this.forward.z = finite(forward.z, this.forward.z);
    }
    if (up) {
      this.up.x = finite(up.x, this.up.x);
      this.up.y = finite(up.y, this.up.y);
      this.up.z = finite(up.z, this.up.z);
    }
    this.spatializer?.setListenerPosition(this.listener.x, this.listener.y, this.listener.z);
    if (this.ac) setListenerPose(this.ac, this.listener, this.forward, this.up);
  }

  setZone(name, fade = 1.2) {
    if (name === 'auto') {
      this.zoneMode = 'auto';
      return this.zone;
    }
    if (!ZONE_SPECS[name]) return this.zone;
    this.zoneMode = 'manual';
    return this._applyZone(name, fade);
  }

  _applyZone(name, fade) {
    if (name === this.zone) return this.zone;
    const from = this.zone;
    this.zone = name;
    this.stats.zone = name;
    this.reverb?.setZone(name, fade);
    this.ctx?.bus?.emit?.('audio:zone', { zone: name, from });
    return name;
  }

  /**
   * Fire a fan of rays out of the listener. One pass gives us:
   *   - the slap-back tap times for the next gunshot
   *   - the ceiling height and mean free path, which is how the zone is chosen
   * Cost is ~12 raycasts every 0.4 s, which is nothing next to a single frame.
   */
  probeEnclosure() {
    const phys = this.ctx?.physics;
    const P = this._probe;
    P.t = this._time;
    if (!phys?.raycast) {
      P.taps = [];
      P.ceiling = Infinity;
      P.mean = 30;
      P.open = 1;
      return P;
    }
    const L = this.listener;
    const origin = { x: L.x, y: L.y, z: L.z };
    const hits = [];
    let horizSum = 0;
    let horizN = 0;
    let ceiling = Infinity;
    let openRays = 0;
    let totalUpish = 0;
    const surfaceOf = this.ctx?.materials?.surfaceOf;

    for (let i = 0; i < PROBE_DIRS.length; i++) {
      const dv = PROBE_DIRS[i];
      let hit = null;
      try {
        hit = phys.raycast(origin, { x: dv[0], y: dv[1], z: dv[2] }, 90, WORLD_MASK, this._hitOut);
      } catch {
        hit = null;
      }
      this.stats.rays++;
      const upish = dv[1] > 0.55;
      if (upish) totalUpish++;
      if (!hit) {
        if (upish) openRays++;
        if (Math.abs(dv[1]) < 0.3) {
          horizSum += 90;
          horizN++;
        }
        continue;
      }
      const dist = clamp(finite(hit.distance, 90), 0.2, 90);
      if (upish) ceiling = Math.min(ceiling, dist);
      if (Math.abs(dv[1]) < 0.3) {
        horizSum += dist;
        horizN++;
      }
      // Hardness decides how bright the reflection comes back.
      let hard = 0.7;
      try {
        const sd = surfaceOf ? surfaceOf(hit) : null;
        if (sd && Number.isFinite(sd.hardness)) hard = sd.hardness;
      } catch {
        /* optional */
      }
      if (dist > 1.6 && dist < 55 && dv[1] < 0.6) {
        hits.push({
          delay: clamp((2 * dist) / SPEED_OF_SOUND, 0.008, 1.1),
          // 1/r for the round trip, times how reflective the surface is.
          gain: clamp((0.55 / (1 + dist * 0.28)) * (0.35 + hard * 0.75), 0.01, 0.55),
          damp: clamp(9000 * Math.exp(-dist / 26) * (0.35 + hard), 500, 14000),
          dist,
        });
      }
    }

    // Keep the loudest few, but spread in time so we get an echo pattern rather
    // than four taps 1 ms apart.
    hits.sort((a, b) => b.gain - a.gain);
    const taps = [];
    for (const h of hits) {
      if (taps.length >= 6) break;
      if (taps.some((t) => Math.abs(t.delay - h.delay) < 0.008)) continue;
      taps.push(h);
    }
    taps.sort((a, b) => a.delay - b.delay);
    P.taps = taps;
    P.ceiling = ceiling;
    P.mean = horizN ? horizSum / horizN : 30;
    P.open = totalUpish ? openRays / totalUpish : 1;
    P.zone = this._zoneFromProbe(P);
    this._tuneSlapback();
    return P;
  }

  _zoneFromProbe(P) {
    const enclosed = P.ceiling < 14 && P.open < 0.5;
    const mean = P.mean;
    if (!enclosed) {
      // Outside. Narrow means an alley, wide means genuinely open ground —
      // most of a dense map is neither, and 'street' is the right answer there.
      if (mean < 7.5) return 'alley';
      if (mean > 48) return 'open';
      return 'street';
    }
    // Inside. Let a POI name the space when we are standing in one, because a
    // ray fan cannot tell a market hall from a warehouse and the level can.
    const poi = this._poiZone();
    if (poi) return poi;
    if (P.ceiling < 3.6 && mean < 5.5) return 'tight';
    if (P.ceiling > 6 && mean > 9) return 'hall';
    if (P.ceiling > 8 && mean < 5) return 'stairwell';
    if (this.listener.y < 0.2 && mean < 9) return 'underground';
    return mean > 11 ? 'hall' : 'tight';
  }

  _poiZone() {
    const pois = this.ctx?.level?.pointsOfInterest;
    if (!pois || !pois.length) return null;
    const L = this.listener;
    let best = null;
    let bestD = Infinity;
    for (const p of pois) {
      const z = POI_ZONES[p.id];
      if (!z) continue;
      const pp = p.pos || p.position;
      if (!pp) continue;
      const dx = pp.x - L.x;
      const dz = pp.z - L.z;
      const d = Math.hypot(dx, dz);
      if (d < (p.radius ?? 8) && d < bestD) {
        bestD = d;
        best = z;
      }
    }
    return best;
  }

  /* ── concussion ──────────────────────────────────────────────────────────── */

  /**
   * Duck the whole mix. Used by the explosion handler and available to game code
   * for cinematic moments.
   */
  duckMix(amount = 0.5, seconds = 2.5, muffleHz = 900) {
    if (!this.live) return;
    const t = this.ac.currentTime;
    const a = clamp01(amount);
    cancel(this.duck.gain, t);
    setAt(this.duck.gain, this.duck.gain.value, t);
    rampTo(this.duck.gain, clamp(1 - a * 0.88, 0.05, 1), t + 0.03);
    rampTo(this.duck.gain, 1, t + Math.max(0.2, seconds));
    cancel(this.muffle.frequency, t);
    setAt(this.muffle.frequency, this.muffle.frequency.value, t);
    rampTo(this.muffle.frequency, hz(this.ac, lerp(20000, muffleHz, a)), t + 0.05);
    rampTo(this.muffle.frequency, hz(this.ac, 20000), t + Math.max(0.25, seconds * 1.1));
  }

  /**
   * The ringing. A narrow-band whistle plus a hiss, fading over several seconds.
   * Post-limiter so it survives the duck it arrives with.
   */
  tinnitus(amount = 0.6, seconds = 7) {
    if (!this.live) return;
    const ac = this.ac;
    const t = ac.currentTime;
    const a = clamp01(amount);
    if (a <= 0.01) return;
    this._clearTinnitus(t);
    const nodes = [];
    const sum = gainNode(ac, 0);
    sum.connect(this.tinnitusGain);
    nodes.push(sum);
    // Two close tones beating slowly is far more convincing than one.
    for (const [f, lv] of [[4180, 1], [4610, 0.55], [7900, 0.2]]) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz(ac, f * (0.94 + this.rng() * 0.12));
      const g = gainNode(ac, lv * 0.05 * a);
      o.connect(g);
      g.connect(sum);
      safeStart(o, t);
      safeStop(o, t + seconds + 0.5);
      nodes.push(o, g);
    }
    // A breath of high hiss under the tones.
    if (this.nz) {
      const src = this.nz.src('white', { loop: true });
      const bp = biquad(ac, 'bandpass', 6200, 3.5);
      const g = gainNode(ac, 0.02 * a);
      chain(src, bp, g);
      g.connect(sum);
      this.nz.play(src, t);
      safeStop(src, t + seconds + 0.5);
      nodes.push(src, bp, g);
    }
    setAt(sum.gain, 0, t);
    rampTo(sum.gain, 1, t + 0.06);
    rampTo(sum.gain, 0, t + Math.max(0.5, seconds));
    setAt(this.tinnitusGain.gain, 1, t);
    this._tinnitusNodes = { nodes, until: t + seconds + 0.7 };
  }

  /**
   * Retire the current ring. A second explosion while the first is still
   * ringing must not yank the oscillators out of the graph mid-cycle — that is
   * a hard click straight into the master, after the limiter. Fade, then let
   * the update loop disconnect once the fade has actually elapsed.
   */
  _clearTinnitus(t) {
    const cur = this._tinnitusNodes;
    if (!cur) return;
    const sum = cur.nodes[0];
    if (sum?.gain) {
      cancel(sum.gain, t);
      setAt(sum.gain, sum.gain.value, t);
      rampTo(sum.gain, 0, t + 0.08);
    }
    for (const n of cur.nodes) safeStop(n, t + 0.14);
    this._retired.push({ nodes: cur.nodes, at: t + 0.25 });
    this._tinnitusNodes = null;
  }

  _sweepRetired(now) {
    for (let i = this._retired.length - 1; i >= 0; i--) {
      if (now < this._retired[i].at) continue;
      for (const n of this._retired[i].nodes) disconnect(n);
      this._retired.splice(i, 1);
    }
  }

  /** One call for "something just went off next to you". */
  concussion(strength = 1) {
    const s = clamp01(strength);
    if (s < 0.05) return;
    this.duckMix(0.35 + s * 0.6, 1.6 + s * 3.2, lerp(2200, 420, s));
    if (s > 0.35) this.tinnitus(s * 0.9, 3 + s * 7);
  }

  /* ── mixer controls ──────────────────────────────────────────────────────── */

  setBusGain(name, v) {
    const g = clamp(finite(v, 1), 0, 4);
    this.busGains[name] = g;
    const b = this.buses[name];
    if (b && this.ac) rampTo(b.gain.gain, g * this._masterMul, this.ac.currentTime + 0.08);
  }

  getBusGain(name) {
    return this.busGains[name] ?? 1;
  }

  setMasterGain(v) {
    this.masterGainValue = clamp(finite(v, 1), 0, 2);
    if (this.master && this.ac) rampTo(this.master.gain, this.masterGainValue, this.ac.currentTime + 0.1);
  }

  mute(on = true) {
    this.enabled = !on;
    if (this.master && this.ac) rampTo(this.master.gain, on ? 0 : this.masterGainValue, this.ac.currentTime + 0.08);
  }

  setQuality(tier) {
    const prev = this.quality;
    this.quality = tier || 'high';
    this.spatializer?.setQuality(this.quality);
    this.reverb?.setQuality(this.quality);
    this.ambience?.setQuality(this.quality);
    this.maxVoices = this.quality === 'low' ? 20 : this.quality === 'medium' ? 30 : this.quality === 'ultra' ? 52 : 40;
    // Tap count is tier-dependent, so the network has to be re-laid out.
    if (this.ac && prev !== this.quality && this.buses.weapons) this._buildSlapback();
  }

  /* ── frame ───────────────────────────────────────────────────────────────── */

  update(dt) {
    this._time += dt;
    // The camera is the listener. CameraRig writes to ctx.camera in lateUpdate,
    // so we read it there too (see the System wrapper below).
    this._probeTimer -= dt;
    if (this._probeTimer <= 0) {
      this._probeTimer = this.silent ? 1.5 : this.quality === 'low' ? 0.7 : 0.4;
      try {
        this.probeEnclosure();
      } catch (err) {
        this._warn('probe', err);
      }
      // The one shared source of truth for how wet the world is.
      const w = this.ctx?.materials?.globals?.wetness;
      this.wetness = Number.isFinite(w) ? w : finite(this.ctx?.weather?.wetness, 0);
      if (this.silent && this.spatializer) {
        // Nothing is audible, but the occlusion path still has to be exercised
        // or a crash in it would only ever show up on a real machine.
        try {
          const L = this.listener;
          this.spatializer.occlusionAt({ x: L.x + 6, y: L.y, z: L.z + 6 }, { force: true });
        } catch (err) {
          this._warn('occl', err);
        }
      }
    }

    if (this.silent) return;

    this._zoneTimer -= dt;
    if (this._zoneTimer <= 0) {
      this._zoneTimer = 0.5;
      if (this.zoneMode === 'auto' && this._probe.zone && this._probe.zone !== this.zone) {
        this._applyZone(this._probe.zone, 1.25);
      }
    }

    if (!this.ac) return;
    this.reverb?.update(dt);
    try {
      this.ambience?.update(dt);
    } catch (err) {
      this._warn('ambience.update', err);
    }

    // Long voices track the listener moving behind cover.
    const now = this.ac.currentTime;
    for (const v of this.voices) {
      if (v.dead || !v.occlude || now > v.end) continue;
      v._nextOcc = v._nextOcc ?? 0;
      if (now < v._nextOcc) continue;
      v._nextOcc = now + 0.16;
      try {
        const occ = this.spatializer.occlusionAt(v.position);
        v.chain?.applyOcclusion?.(occ, now, 0.14);
        v.chain?.updateAir?.(now);
      } catch {
        /* the physics world can be mid-rebuild */
      }
    }

    this._reap();
    if (this._retired.length) this._sweepRetired(now);
    if (this._tinnitusNodes && now > this._tinnitusNodes.until) this._clearTinnitus(now);
  }

  _warn(tag, err) {
    if (this._warned.has(tag)) return;
    this._warned.add(tag);
    console.warn(`[audio] ${tag}:`, err?.message || err);
  }

  /* ── events ──────────────────────────────────────────────────────────────── */

  _bindEvents() {
    const bus = this.ctx?.bus;
    if (!bus?.on) return;
    const on = (name, fn) => {
      const off = bus.on(name, (p) => {
        try {
          fn(p || {});
        } catch (err) {
          this._warn(`on:${name}`, err);
        }
      });
      if (typeof off === 'function') this._unsub.push(off);
    };

    /* Weapons ------------------------------------------------------------- */
    on('weapon:fire', (p) => {
      const def = p.def || p.weapon?.def || null;
      const id = p.suppressed ? 'weapon_suppressed' : def?.audio?.fire || 'weapon_fire';
      this.play(id, {
        position: p.origin,
        weapon: p.weaponId || (typeof p.weapon === 'string' ? p.weapon : p.weapon?.id),
        weaponClass: def?.class,
        suppressed: p.suppressed,
        ads: p.ads,
      });
    });
    // Stage names are WeaponSystem's: start|release|magout|magin|seat|
    // boltrelease|end. It also calls play() directly for magout/magin; the
    // duplicate collapses in _isDuplicate.
    on('weapon:reload', (p) => {
      switch (p.stage) {
        case 'start': this.play('cloth', { level: 1.5 }); break;
        case 'magout': this.play('mag_out'); break;
        case 'magin': this.play('mag_in'); break;
        case 'boltrelease': this.play('bolt_release'); break;
        case 'end': this.play('cloth', { level: 0.8 }); break;
        default: break; // 'release' and 'seat' are inside mag_out / mag_in
      }
    });
    on('weapon:melee', (p) => {
      if (p.damage) this.play('impact_flesh', { spatial: false, energy: 1200 });
      else this.play('whoosh', { spatial: false, duration: 0.28, level: 0.8 });
    });
    on('weapon:equip', () => this.play('weapon_swap'));
    on('weapon:empty', (p) => {
      if (p.dry) this.play('weapon_dry');
    });

    /* Ballistics ----------------------------------------------------------- */
    on('bullet:impact', (p) => {
      this.play(`impact_${p.surface || 'concrete'}`, {
        position: p.point,
        surface: p.surface,
        material: p.material,
        energy: p.energy,
      });
    });
    on('bullet:penetrate', (p) => {
      this.play(`pen_${p.surface || 'concrete'}`, {
        position: p.exitPoint || p.entryPoint,
        surface: p.surface,
      });
    });
    on('bullet:ricochet', (p) => {
      this.play('ricochet', {
        position: p.point,
        surface: p.surface,
        material: p.material,
        energy: p.energy,
      });
    });
    on('bullet:whiz', (p) => {
      if (p.entity && p.entity !== this.ctx?.player) return;
      this.play('flyby', {
        position: p.point,
        distance: p.distance,
        speed: p.speed,
        dir: p.dir,
      });
    });

    /* Player --------------------------------------------------------------- */
    on('player:step', (p) => {
      // SurfaceDefs' `footstep` id is more specific than the §5 tag it rolls up
      // to (step_gravel vs 'dirt'), so prefer it for choosing the voicing.
      const fid = p.footstep || `step_${p.surface || 'concrete'}`;
      this.play(fid, {
        position: p.position,
        surface: fid.startsWith('step_') ? fid.slice(5) : p.surface,
        speed: p.speed,
        volume: p.volume,
        foot: p.foot,
        spatial: false, // it is our own body: 2D, always audible, never occluded
        bus: 'foley',
      });
    });
    on('player:land', (p) => {
      this.play('land', {
        position: p.position,
        surface: p.surface,
        impactSpeed: p.impactSpeed,
        hard: p.hard,
        spatial: false,
      });
    });
    on('player:jump', () => this.play('jump', { spatial: false }));
    on('player:state', (p) => {
      // Kit shifting as the player changes stance. Quiet, but its absence is
      // what makes a crouch feel like a camera transform instead of a body.
      if (p.from === p.to) return;
      const big = p.to === 'prone' || p.from === 'prone';
      this.play('cloth', { spatial: false, level: big ? 1.8 : 1.0, cooldown: 0.12 });
    });
    on('player:slide', (p) => {
      if (p.phase === 'start') this.play('slide', { spatial: false, surface: p.surface, duration: 0.9 });
    });
    on('player:mantle', (p) => this.play('mantle', { spatial: false, surface: p.surface, ...p }));

    /* Other bodies. AI is a stub today; these cost nothing until it is not. */
    on('entity:step', (p) => {
      this.play(p.footstep || `step_${p.surface || 'concrete'}`, {
        position: p.position, surface: p.surface, speed: p.speed, volume: p.volume, foot: p.foot,
      });
    });
    on('ai:step', (p) => {
      this.play(`step_${p.surface || 'concrete'}`, {
        position: p.position, surface: p.surface, speed: p.speed, volume: p.volume,
      });
    });
    on('ai:fire', (p) => {
      const def = p.def || p.weapon?.def || null;
      this.play(def?.audio?.fire || 'weapon_fire', {
        position: p.origin || p.position,
        weaponClass: def?.class,
        weapon: p.weaponId,
      });
    });

    /* Combat --------------------------------------------------------------- */
    on('entity:damage', (p) => {
      if (p.target === this.ctx?.player) this.play('hurt', { spatial: false, amount: p.amount });
    });
    on('entity:death', (p) => {
      const pos = p.point || p.target?.position || null;
      this.play('death', pos ? { position: pos } : { spatial: false });
    });
    on('hud:hitmarker', (p) => {
      this.play(p.lethal ? 'hitmarker_kill' : p.headshot ? 'hitmarker_head' : 'hitmarker', {
        lethal: p.lethal, headshot: p.headshot,
      });
    });

    /* Ordnance ------------------------------------------------------------- */
    on('explosion', (p) => {
      const pos = readVec(p.point) || { ...this.listener };
      const dist = this.spatializer.distanceTo(pos);
      this.play('explosion', { position: pos, radius: p.radius, damage: p.damage });
      const r = clamp(p.radius ?? 6, 1, 40);
      // Concussion falls off fast: at two radii out it is a loud bang, not a
      // ringing skull.
      const s = clamp01(1 - dist / (r * 2.6));
      if (s > 0.05) this.concussion(s);
    });
    on('grenade:throw', (p) => this.play('grenade_throw', { position: p.point || p.origin }));
    on('grenade:bounce', (p) => this.play('grenade_bounce', { position: p.point, surface: p.surface, level: p.speed ? clamp01(p.speed / 8) : 0.5 }));

    /* Loose objects. Props landing, debris tumbling, ragdolls settling. */
    on('physics:impact', (p) => {
      const speed = Math.abs(p.speed ?? 0);
      if (speed < 1.2) return;
      this.play(`impact_${p.surface || 'wood'}`, {
        position: p.point,
        surface: p.surface,
        // A crate dropping is not a bullet: scale the "energy" from momentum so
        // the impact recipe reads it as a soft hit rather than a rifle round.
        energy: clamp(speed * speed * 22, 60, 2600),
        level: clamp(speed / 5, 0.15, 1),
        cooldown: 0.03,
        priority: 2,
      });
    });

    /* World ---------------------------------------------------------------- */
    on('weather:changed', () => this.ambience?.applyWeather());
    on('weather:wind', () => this.ambience?.applyWeather());
    on('quality:changed', (p) => this.setQuality(p.tier));
    on('debug:pose', (p) => {
      const a = p.audio;
      if (!a) return;
      if (typeof a === 'string') this.setZone(a, 0);
      else if (typeof a === 'object') {
        if (a.zone) this.setZone(a.zone, 0);
        if (a.mute !== undefined) this.mute(!!a.mute);
        if (a.master !== undefined) this.setMasterGain(a.master);
      }
    });
  }

  dispose() {
    for (const off of this._unsub) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this._unsub.length = 0;
    this._unbindGestures();
    this.stopAll(0.01);
    try {
      this.ambience?.dispose();
      this._disposeSlapback();
      this.reverb?.dispose();
      for (const b of Object.values(this.buses)) {
        disconnect(b.input);
        disconnect(b.comp);
        disconnect(b.gain);
      }
      disconnect(this.busSum);
      disconnect(this.duck);
      disconnect(this.muffle);
      disconnect(this.limiter);
      disconnect(this.clip);
      disconnect(this.master);
      this.nz?.dispose();
      this.ac?.close?.();
    } catch {
      /* teardown is best effort */
    }
    this.ac = null;
    this.ready = false;
  }
}

/** Accept a Vector3, a plain object, or an [x,y,z] array. */
function readVec(v) {
  if (!v) return null;
  if (Array.isArray(v)) return { x: finite(v[0], 0), y: finite(v[1], 0), z: finite(v[2], 0) };
  if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
    return { x: v.x, y: v.y, z: v.z };
  }
  return null;
}

const _fwd = { x: 0, y: 0, z: -1 };
const _up = { x: 0, y: 1, z: 0 };

/** @returns {import('../core/types.js').System} */
export default function createAudioEngine(ctx) {
  const engine = new AudioEngine(ctx);

  // A complete surface from the factory: other systems' factories and init()s
  // run before ours and are allowed to call us.
  const api = {
    ready: false,
    _impl: engine,
    play: (id, opts) => engine.play(id, opts),
    playAt: (id, position, opts) => engine.playAt(id, position, opts),
    stop: (v, fade) => engine._killVoice(v, fade),
    stopAll: (fade) => engine.stopAll(fade),
    setListener: (pos, forward, up) => engine.setListener(pos, forward, up),
    setZone: (name, fade) => engine.setZone(name, fade),
    setBusGain: (bus, v) => engine.setBusGain(bus, v),
    getBusGain: (bus) => engine.getBusGain(bus),
    setMasterGain: (v) => engine.setMasterGain(v),
    mute: (on) => engine.mute(on),
    duck: (amount, seconds, hzCut) => engine.duckMix(amount, seconds, hzCut),
    concussion: (s) => engine.concussion(s),
    tinnitus: (a, s) => engine.tinnitus(a, s),
    register: (id, d) => engine.register(id, d),
    has: (id) => engine.has(id),
    list: () => engine.list(),
    resume: () => engine.resume(),
    zones: () => Object.keys(ZONE_SPECS),
    get context() { return engine.ac; },
    get buses() { return engine.buses; },
    get listener() { return engine.listener; },
    get zone() { return engine.zone; },
    get reverb() { return engine.reverb; },
    get stats() { return engine.stats; },
    get enclosure() { return engine._probe; },
    get silent() { return engine.silent; },
    get enabled() { return engine.enabled; },
  };
  ctx.audio = api;

  return {
    name: 'audio',
    order: 50,

    async init() {
      ctx.audio = api;
      try {
        engine.init();
        api.ready = engine.ready;
      } catch (err) {
        // Audio must never take the frame down.
        console.warn('[audio] init failed, running silent:', err?.message || err);
        engine.silent = true;
        api.ready = true;
      }
    },

    update(dt) {
      try {
        engine.update(dt);
      } catch (err) {
        engine._warn('update', err);
      }
    },

    lateUpdate() {
      // Read the camera after CameraRig has finished authoring it, so recoil and
      // bob move the listener exactly as they move the view.
      const cam = ctx.camera;
      if (!cam) return;
      try {
        cam.updateMatrixWorld?.();
        const m = cam.matrixWorld?.elements;
        if (!m) return;
        // Column 2 of the world matrix is +Z; the camera looks down -Z.
        _fwd.x = -m[8];
        _fwd.y = -m[9];
        _fwd.z = -m[10];
        _up.x = m[4];
        _up.y = m[5];
        _up.z = m[6];
        engine.setListener({ x: m[12], y: m[13], z: m[14] }, _fwd, _up);
      } catch (err) {
        engine._warn('listener', err);
      }
    },

    dispose() {
      engine.dispose();
      if (ctx.audio === api) ctx.audio = null;
    },
  };
}
