/**
 * Spatial.js — per-voice 3D chain, air absorption and geometric occlusion.
 * Owner: audio agent.
 *
 * Signal path for one positional voice:
 *
 *   synth ─▶ occLP ─▶ airLP ─▶ voiceGain ─▶ panner(HRTF) ─▶ bus
 *                                  └─▶ sendGain ─▶ reverb.input
 *
 * `occLP` and `airLP` are both plain lowpasses, but they model different physics
 * and are kept separate so the occlusion tracker can retune one of them every
 * 150 ms without disturbing the distance curve.
 *
 * ── Occlusion ──────────────────────────────────────────────────────────────────
 * Five rays are cast from the listener toward the source: the direct path plus
 * four offset by ±0.9 m laterally and vertically. What matters is not *whether*
 * the direct path is blocked but *how many* of the paths are:
 *
 *   0/5 blocked   free field
 *   direct blocked, some offsets clear  →  the source is around a corner. Sound
 *                                          diffracts: it stays fairly bright but
 *                                          arrives mostly as reflections, so the
 *                                          filter opens up and the reverb send
 *                                          goes *up*.
 *   5/5 blocked   →  through a wall. Heavy lowpass driven by the intervening
 *                    material's `occlusion` term from SurfaceDefs, big gain cut,
 *                    and the reverb send drops with it.
 *
 * Results are cached on a 0.9 m grid and invalidated when the listener moves, so
 * sustained fire does not turn into a raycast storm.
 */
import { clamp, clamp01, lerp, gainNode, biquad, rampTo, setAt, hz, disconnect, finite } from './dsp.js';

const WORLD = 1;
const PROP = 8;
const OCCLUDER_MASK = WORLD | PROP;

/** Air absorption cutoff for a given distance, Hz. */
export function airCutoff(d) {
  return 780 + 19500 * Math.exp(-Math.max(0, d) / 34);
}

/** Free-field distance gain used for the non-spatial fallback path. */
export function distanceGain(d, ref = 3, max = 260, rolloff = 1) {
  const dd = clamp(d, ref, max);
  return ref / (ref + rolloff * (dd - ref));
}

const _dir = { x: 0, y: 0, z: 0 };

export class Spatializer {
  /**
   * @param {object} ctx game context
   * @param {AudioContext} ac
   */
  constructor(ctx, ac, opts = {}) {
    this.ctx = ctx;
    this.ac = ac;
    this.quality = opts.quality || 'high';
    this.maxDistance = opts.maxDistance ?? 280;
    this.refDistance = opts.refDistance ?? 3;
    this.listener = { x: 0, y: 1.7, z: 0 };
    this._cache = new Map();
    this._cacheAnchor = { x: 1e9, y: 1e9, z: 1e9 };
    this._budget = 0;
    this._budgetMax = opts.rayBudget ?? 46;
    this._warned = false;
    this.enabled = true;
    // PhysicsWorld.raycast allocates a fresh Hit unless you hand it one. We cast
    // a lot of these, so bring our own and keep the GC out of the audio path.
    this.hitOut = makeHitOut(ctx);
  }

  setQuality(q) {
    this.quality = q;
    this._budgetMax = q === 'low' ? 16 : q === 'medium' ? 30 : 46;
  }

  get panningModel() {
    // HRTF is a convolution per source. Worth it above `low`; on `low` the panner
    // count is what kills the audio thread, so fall back to cheap equal-power.
    return this.quality === 'low' ? 'equalpower' : 'HRTF';
  }

  /** Called once per frame with the listener's world position. */
  setListenerPosition(x, y, z) {
    this.listener.x = finite(x, 0);
    this.listener.y = finite(y, 1.7);
    this.listener.z = finite(z, 0);
    const a = this._cacheAnchor;
    const dx = x - a.x;
    const dy = y - a.y;
    const dz = z - a.z;
    if (dx * dx + dy * dy + dz * dz > 0.36) {
      this._cache.clear();
      a.x = x;
      a.y = y;
      a.z = z;
    }
    this._budget = this._budgetMax;
  }

  /** Distance from the listener to a point. */
  distanceTo(p) {
    const l = this.listener;
    const dx = (p.x ?? 0) - l.x;
    const dy = (p.y ?? 0) - l.y;
    const dz = (p.z ?? 0) - l.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Sample occlusion between the listener and `p`.
   * @returns {{occ:number, corner:number, blocked:number, cutoff:number, gain:number, send:number}}
   */
  occlusionAt(p, { force = false } = {}) {
    const free = { occ: 0, corner: 0, blocked: 0, cutoff: 22000, gain: 1, send: 1 };
    if (!this.enabled) return free;
    const phys = this.ctx?.physics;
    if (!phys?.raycast) return free;
    const l = this.listener;
    const dx = (p.x ?? 0) - l.x;
    const dy = (p.y ?? 0) - l.y;
    const dz = (p.z ?? 0) - l.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1.4 || dist > this.maxDistance) return free;

    const key =
      (Math.round((p.x ?? 0) / 0.9) & 1023) * 1048576 +
      (Math.round((p.y ?? 0) / 0.9) & 1023) * 1024 +
      (Math.round((p.z ?? 0) / 0.9) & 1023);
    const hitCache = this._cache.get(key);
    if (hitCache) return hitCache;
    if (this._budget <= 0 && !force) return free;

    const inv = 1 / dist;
    _dir.x = dx * inv;
    _dir.y = dy * inv;
    _dir.z = dz * inv;
    // A perpendicular basis around the ray so the offsets probe *around* cover.
    let ux = -_dir.z;
    let uz = _dir.x;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul;
    uz /= ul;

    const spread = clamp(dist * 0.18, 0.55, 1.25);
    const samples = this.quality === 'low' ? 3 : 5;
    const offsets =
      samples === 3
        ? [
            [0, 0, 0, 0.5],
            [ux * spread, 0, uz * spread, 0.25],
            [-ux * spread, 0, -uz * spread, 0.25],
          ]
        : [
            [0, 0, 0, 0.36],
            [ux * spread, 0, uz * spread, 0.17],
            [-ux * spread, 0, -uz * spread, 0.17],
            [0, spread * 0.85, 0, 0.16],
            [0, -Math.min(0.75, spread * 0.7), 0, 0.14],
          ];

    let blockedW = 0;
    let matSum = 0;
    let matN = 0;
    let directBlocked = 0;
    const reach = Math.max(0.3, dist - 0.35);
    const surfaceOf = this.ctx?.materials?.surfaceOf;

    for (let i = 0; i < offsets.length; i++) {
      const [ox, oy, oz, w] = offsets[i];
      const sx = l.x + ox;
      const sy = l.y + oy;
      const sz = l.z + oz;
      // Re-aim each offset ray at the source so they all converge on it.
      let rx = (p.x ?? 0) - sx;
      let ry = (p.y ?? 0) - sy;
      let rz = (p.z ?? 0) - sz;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl;
      ry /= rl;
      rz /= rl;
      let hit = null;
      try {
        hit = phys.raycast({ x: sx, y: sy, z: sz }, { x: rx, y: ry, z: rz }, reach, OCCLUDER_MASK, this.hitOut);
      } catch {
        hit = null;
      }
      this._budget--;
      if (!hit) continue;
      blockedW += w;
      if (i === 0) directBlocked = 1;
      let m = 0.7;
      try {
        const def = surfaceOf ? surfaceOf(hit) : null;
        if (def && Number.isFinite(def.occlusion)) m = def.occlusion;
      } catch {
        /* SurfaceDefs is allowed to be absent */
      }
      matSum += m;
      matN++;
    }

    const frac = clamp01(blockedW);
    const mat = matN ? matSum / matN : 0.7;
    // Weighted by the material: a chain-link fence occludes almost nothing, a
    // reinforced concrete wall occludes nearly everything.
    const occ = clamp01(frac * (0.3 + 0.7 * mat));
    // "Corner-ness": the direct path is gone but a diffraction path survives.
    const corner = clamp01(directBlocked * (1 - frac) * 1.6);

    // Full occlusion collapses the top end; partial occlusion keeps it open.
    // Interpolate the cutoff *geometrically* — a linear sweep from 20 kHz to
    // 330 Hz spends almost all of its range in the top two octaves, so a wall
    // that should sound like 400 Hz would come out at 1.2 kHz and read as a
    // curtain instead.
    const cutoff =
      occ <= 0.001
        ? 22000
        : clamp(20000 * Math.pow(330 / 20000, Math.pow(occ, 0.62)) * (1 + corner * 2.6), 180, 22000);
    const gain = clamp(1 - 0.78 * occ + corner * 0.16, 0.06, 1);
    // Around a corner you hear mostly reflections: push the wet up. Through a
    // wall the reflections are muffled too: pull it down.
    const send = clamp(1 + 1.9 * corner - 0.55 * Math.max(0, occ - corner), 0.15, 3.2);

    const out = { occ, corner, blocked: frac, cutoff, gain, send };
    if (this._cache.size < 512) this._cache.set(key, out);
    return out;
  }

  /**
   * Build the spatial tail of a voice.
   * @param {object} o
   * @param {{x,y,z}} o.position
   * @param {AudioNode} o.dest   bus input
   * @param {AudioNode} [o.reverb] reverb input
   * @param {number} [o.send]    base reverb send
   * @param {number} [o.gain]
   * @param {boolean} [o.occlude]
   * @param {number} [o.refDistance]
   * @param {number} [o.maxDistance]
   * @param {number} [o.rolloff]
   */
  makeChain(o) {
    const ac = this.ac;
    const pos = o.position || { x: 0, y: 0, z: 0 };
    const dist = this.distanceTo(pos);

    const occLP = biquad(ac, 'lowpass', 22000, 0.7);
    const airLP = biquad(ac, 'lowpass', airCutoff(dist), 0.62);
    const vGain = gainNode(ac, clamp(finite(o.gain, 1), 0, 8));

    let panner = null;
    try {
      panner = ac.createPanner();
      panner.panningModel = this.panningModel;
      panner.distanceModel = 'inverse';
      panner.refDistance = Math.max(0.2, o.refDistance ?? this.refDistance);
      panner.maxDistance = Math.max(panner.refDistance + 1, o.maxDistance ?? this.maxDistance);
      panner.rolloffFactor = clamp(o.rolloff ?? 1.05, 0.05, 6);
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1;
      setPannerPosition(panner, pos.x ?? 0, pos.y ?? 0, pos.z ?? 0, ac.currentTime);
    } catch {
      panner = null;
    }

    occLP.connect(airLP);
    airLP.connect(vGain);
    const head = panner || vGain;
    if (panner) vGain.connect(panner);
    try {
      head.connect(o.dest);
    } catch {
      /* the bus can be torn down under us during dispose */
    }

    // Reverb send is taken *before* the panner so the wet field stays diffuse,
    // but *after* occlusion and air so a muffled source has a muffled tail.
    let sendGain = null;
    if (o.reverb && (o.send ?? 0) > 0) {
      const distWet = clamp(0.35 + dist / 42, 0.35, 2.4);
      sendGain = gainNode(ac, clamp(finite(o.send, 0.3) * distWet, 0, 4));
      vGain.connect(sendGain);
      try {
        sendGain.connect(o.reverb);
      } catch {
        /* ignore */
      }
    }

    const chainObj = {
      input: occLP,
      occLP,
      airLP,
      gain: vGain,
      panner,
      sendGain,
      position: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 },
      baseSend: o.send ?? 0,
      occlude: o.occlude !== false,
      _occ: null,
      setPosition: (x, y, z, when) => {
        chainObj.position.x = x;
        chainObj.position.y = y;
        chainObj.position.z = z;
        if (panner) setPannerPosition(panner, x, y, z, when ?? ac.currentTime);
        else {
          const d = this.distanceTo(chainObj.position);
          rampTo(vGain.gain, distanceGain(d) * clamp(finite(o.gain, 1), 0, 8), (when ?? ac.currentTime) + 0.02);
        }
      },
      applyOcclusion: (occ, when, glide = 0.09) => {
        const t = (when ?? ac.currentTime) + 0.001;
        chainObj._occ = occ;
        rampTo(occLP.frequency, hz(ac, occ.cutoff), t + glide);
        rampTo(vGain.gain, clamp(finite(o.gain, 1), 0, 8) * occ.gain, t + glide);
        if (sendGain) {
          const d = this.distanceTo(chainObj.position);
          const distWet = clamp(0.35 + d / 42, 0.35, 2.4);
          // `baseSend` is whatever the *synth* asked for via S.setSend, which
          // overrides the registry default — a distant rifle is much wetter
          // than the same id fired at your feet.
          rampTo(sendGain.gain, clamp(chainObj.baseSend * distWet * occ.send, 0, 4), t + glide);
        }
      },
      updateAir: (when) => {
        const d = this.distanceTo(chainObj.position);
        rampTo(airLP.frequency, hz(ac, airCutoff(d)), (when ?? ac.currentTime) + 0.08);
      },
      dispose: () => {
        disconnect(occLP);
        disconnect(airLP);
        disconnect(vGain);
        if (panner) disconnect(panner);
        if (sendGain) disconnect(sendGain);
      },
    };

    if (chainObj.occlude) {
      const occ = this.occlusionAt(chainObj.position);
      if (occ.occ > 0.001) {
        setAt(occLP.frequency, hz(ac, occ.cutoff), ac.currentTime);
        setAt(vGain.gain, clamp(finite(o.gain, 1), 0, 8) * occ.gain, ac.currentTime);
        if (sendGain) {
          const distWet = clamp(0.35 + dist / 42, 0.35, 2.4);
          setAt(sendGain.gain, clamp((o.send ?? 0) * distWet * occ.send, 0, 4), ac.currentTime);
        }
      }
      chainObj._occ = occ;
    }

    return chainObj;
  }
}

/**
 * A reusable physics Hit. Uses THREE.Vector3 when the engine handed us THREE
 * (it does), and a tiny stand-in with the two methods PhysicsWorld calls
 * (`set`, `negate`) when it did not.
 */
export function makeHitOut(ctx) {
  const V = ctx?.THREE?.Vector3;
  const vec = () =>
    V
      ? new V()
      : {
          x: 0, y: 0, z: 0,
          set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
          negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; },
        };
  return {
    point: vec(), normal: vec(), distance: 0, fraction: 0,
    body: null, faceIndex: -1, surface: 'concrete', material: null, entity: null,
  };
}

/** Panner position, with the pre-AudioParam fallback. */
export function setPannerPosition(panner, x, y, z, t) {
  if (!panner) return;
  const px = finite(x, 0);
  const py = finite(y, 0);
  const pz = finite(z, 0);
  if (panner.positionX) {
    setAt(panner.positionX, px, t);
    setAt(panner.positionY, py, t);
    setAt(panner.positionZ, pz, t);
  } else if (panner.setPosition) {
    try {
      panner.setPosition(px, py, pz);
    } catch {
      /* ignore */
    }
  }
}

/** Ramp a panner along a straight line — used for bullet flybys. */
export function rampPannerTo(panner, x, y, z, t) {
  if (!panner) return;
  if (panner.positionX) {
    rampTo(panner.positionX, finite(x, 0), t);
    rampTo(panner.positionY, finite(y, 0), t);
    rampTo(panner.positionZ, finite(z, 0), t);
  } else {
    setPannerPosition(panner, x, y, z, t);
  }
}

/** Listener pose, with the deprecated-API fallback. */
export function setListenerPose(ac, pos, fwd, up) {
  const L = ac?.listener;
  if (!L) return;
  const t = ac.currentTime;
  if (L.positionX) {
    // A short smoothing time constant kills the zipper noise from a jittery
    // camera without adding audible lag.
    const tau = 0.012;
    try {
      L.positionX.setTargetAtTime(finite(pos.x, 0), t, tau);
      L.positionY.setTargetAtTime(finite(pos.y, 0), t, tau);
      L.positionZ.setTargetAtTime(finite(pos.z, 0), t, tau);
      L.forwardX.setTargetAtTime(finite(fwd.x, 0), t, tau);
      L.forwardY.setTargetAtTime(finite(fwd.y, 0), t, tau);
      L.forwardZ.setTargetAtTime(finite(fwd.z, -1), t, tau);
      L.upX.setTargetAtTime(finite(up.x, 0), t, tau);
      L.upY.setTargetAtTime(finite(up.y, 1), t, tau);
      L.upZ.setTargetAtTime(finite(up.z, 0), t, tau);
    } catch {
      /* ignore */
    }
  } else {
    try {
      L.setPosition(finite(pos.x, 0), finite(pos.y, 0), finite(pos.z, 0));
      L.setOrientation(
        finite(fwd.x, 0), finite(fwd.y, 0), finite(fwd.z, -1),
        finite(up.x, 0), finite(up.y, 1), finite(up.z, 0)
      );
    } catch {
      /* ignore */
    }
  }
}
