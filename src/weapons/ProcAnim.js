/**
 * ProcAnim — every frame of viewmodel animation, generated in code.
 * Owner: weapons agent.
 *
 * There are no animation files here and no skeletons: the viewmodel is a small tree of
 * nodes driven by (a) a weighted blend of authored *static* poses, (b) keyed timelines
 * for the discrete actions, and (c) a stack of additive spring layers that never stop
 * running. That last part is what makes a gun feel like it has mass — the pose is where
 * the weapon is *trying* to be, the springs are what it actually does on the way there.
 *
 * Layers, in the order they are composited:
 *   1. pose blend      hip / ads / sprint / tac-sprint / low-ready
 *   2. action overlay  reload, inspect, melee, weapon swap (keyed, eased)
 *   3. rotational lag  the weapon trails the camera on a spring and rolls into the turn
 *   4. movement sway   lateral velocity tilt + a counter-phased walk bob
 *   5. breathing       two-rate figure-eight, wider when winded, tighter on the sight
 *   6. recoil          per-shot impulse into a position and a rotation spring
 *
 * Sub-part animation (bolt carrier, charging handle, dust cover, trigger, selector,
 * bolt catch, magazine, follower, trigger finger) is driven from the same clock.
 *
 * Public API — createProcAnim(ctx):
 *   setRig(rig)                 {rig, gun, nodes, hands, def, view, mods}
 *   setSightLocal(vec3)         where ADS must place the optical axis
 *   update(dt, state)           state: {adsWant, firing, speed, lateral, stance,
 *                                       grounded, exertion, lowReady, ammo, magSize}
 *   fire(opts)                  per-shot impulse + mechanism cycle
 *   reload(empty)  inspect()  melee()  swap(dir)  cancelAction()
 *   adsBlend  adsRaw  busy  action  actionTime  chamberOpen
 *   flinch(amount)              external hit reaction
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

const smooth = (t) => t * t * (3 - 2 * t);
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const easeInQuad = (t) => t * t;
const easeOutBack = (t, k = 1.15) => {
  const c3 = k + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + k * u * u;
};

/* -------------------------------------------------------------------------- */
/*                                  springs                                   */
/* -------------------------------------------------------------------------- */

class Spring {
  constructor(freq = 9, zeta = 0.6) {
    this.f = freq;
    this.z = zeta;
    this.v = 0;
    this.x = 0;
  }
  push(dv) {
    this.v += dv;
  }
  set(x) {
    this.x = x;
    this.v = 0;
  }
  step(dt, target = 0) {
    // Sub-stepped so a 250 ms hitch cannot blow the integrator up.
    const w = TAU * this.f;
    let rem = clamp(dt, 0, 0.25);
    const maxH = 1 / Math.max(120, this.f * 12);
    while (rem > 1e-6) {
      const h = Math.min(maxH, rem);
      const a = -2 * this.z * w * this.v - w * w * (this.x - target);
      this.v += a * h;
      this.x += this.v * h;
      rem -= h;
    }
    if (!Number.isFinite(this.x) || !Number.isFinite(this.v)) {
      this.x = target;
      this.v = 0;
    }
    return this.x;
  }
}

class Spring3 {
  constructor(freq, zeta) {
    this.a = new Spring(freq, zeta);
    this.b = new Spring(freq, zeta);
    this.c = new Spring(freq, zeta);
  }
  push(x, y, z) {
    this.a.push(x);
    this.b.push(y);
    this.c.push(z);
  }
  step(dt) {
    this.a.step(dt);
    this.b.step(dt);
    this.c.step(dt);
  }
  reset() {
    this.a.set(0);
    this.b.set(0);
    this.c.set(0);
  }
  get x() {
    return this.a.x;
  }
  get y() {
    return this.b.x;
  }
  get z() {
    return this.c.x;
  }
}

/* -------------------------------------------------------------------------- */
/*                              keyed timelines                               */
/* -------------------------------------------------------------------------- */

/** track = [[t, [x,y,z]], …] sampled with smoothstep. */
function sample3(track, t, out) {
  const n = track.length;
  if (!n) {
    out.set(0, 0, 0);
    return out;
  }
  if (t <= track[0][0]) {
    out.fromArray(track[0][1]);
    return out;
  }
  for (let i = 1; i < n; i++) {
    if (t <= track[i][0]) {
      const a = track[i - 1];
      const b = track[i];
      const k = smooth(clamp01((t - a[0]) / Math.max(1e-5, b[0] - a[0])));
      out.set(
        lerp(a[1][0], b[1][0], k),
        lerp(a[1][1], b[1][1], k),
        lerp(a[1][2], b[1][2], k)
      );
      return out;
    }
  }
  out.fromArray(track[n - 1][1]);
  return out;
}

function sample1(track, t) {
  const n = track.length;
  if (!n) return 0;
  if (t <= track[0][0]) return track[0][1];
  for (let i = 1; i < n; i++) {
    if (t <= track[i][0]) {
      const a = track[i - 1];
      const b = track[i];
      const k = smooth(clamp01((t - a[0]) / Math.max(1e-5, b[0] - a[0])));
      return lerp(a[1], b[1], k);
    }
  }
  return track[n - 1][1];
}

function scaleTrack(track, s) {
  return track.map(([t, v]) => [t * s, v]);
}

/* ------------------------------- reload ----------------------------------- */

const RELOAD_BASE = 2.1;

const RL_WEAPON_POS = [
  [0.0, [0, 0, 0]],
  [0.2, [-0.016, -0.042, 0.032]],
  [0.55, [-0.024, -0.055, 0.042]],
  [1.35, [-0.021, -0.048, 0.038]],
  [1.7, [-0.013, -0.034, 0.026]],
  [2.1, [0, 0, 0]],
];
const RL_WEAPON_ROT = [
  [0.0, [0, 0, 0]],
  [0.2, [0.13, 0.3, -0.4]],
  [0.55, [0.18, 0.36, -0.5]],
  [1.35, [0.16, 0.33, -0.45]],
  [1.7, [0.09, 0.2, -0.26]],
  [2.1, [0, 0, 0]],
];
const RL_HAND_POS = [
  [0.0, [0, 0, 0]],
  [0.22, [0.028, -0.058, 0.118]],
  [0.44, [0.02, -0.072, 0.104]],
  [0.62, [0.03, -0.15, 0.13]],
  [0.9, [0.04, -0.3, 0.1]],
  [1.14, [0.03, -0.235, 0.108]],
  [1.44, [0.008, -0.086, 0.1]],
  [1.62, [0.002, -0.066, 0.092]],
  [1.94, [0, 0, 0]],
  [2.1, [0, 0, 0]],
];
const RL_HAND_ROT = [
  [0.0, [0, 0, 0]],
  [0.22, [0.42, 0.2, 0.1]],
  [0.44, [0.52, 0.16, 0.12]],
  [0.62, [0.6, 0.1, 0.14]],
  [0.9, [0.5, 0.0, 0.1]],
  [1.14, [0.56, 0.06, 0.12]],
  [1.44, [0.5, 0.13, 0.12]],
  [1.62, [0.44, 0.13, 0.1]],
  [1.94, [0, 0, 0]],
  [2.1, [0, 0, 0]],
];
const RL_MAG_POS = [
  [0.0, [0, 0, 0]],
  [0.5, [0, 0, 0]],
  [0.66, [0.003, -0.085, 0.01]],
  [0.84, [0.012, -0.27, 0.03]],
  [1.1, [0.012, -0.34, 0.03]],
  [1.16, [-0.004, -0.3, 0.024]],
  [1.44, [0, -0.062, 0.005]],
  [1.58, [0, -0.008, 0.0]],
  [1.66, [0, 0, 0]],
  [2.1, [0, 0, 0]],
];
const RL_MAG_ROT = [
  [0.0, [0, 0, 0]],
  [0.5, [0, 0, 0]],
  [0.66, [0.12, 0.04, 0.1]],
  [0.84, [0.42, 0.1, 0.24]],
  [1.1, [0.5, 0.1, 0.3]],
  [1.16, [0.3, 0.05, 0.18]],
  [1.44, [0.06, 0.01, 0.04]],
  [1.66, [0, 0, 0]],
  [2.1, [0, 0, 0]],
];
const RL_MAG_VIS = [
  [0.0, 1],
  [0.99, 1],
  [1.0, 0],
  [1.11, 0],
  [1.12, 1],
  [2.1, 1],
];

/* ------------------------------- inspect ---------------------------------- */

const IN_POS = [
  [0.0, [0, 0, 0]],
  [0.62, [-0.03, 0.012, 0.062]],
  [1.5, [-0.038, 0.004, 0.072]],
  [2.3, [-0.008, -0.016, 0.058]],
  [3.0, [0.004, -0.004, 0.03]],
  [3.6, [0, 0, 0]],
];
const IN_ROT = [
  [0.0, [0, 0, 0]],
  [0.62, [0.03, 0.66, -0.22]],
  [1.5, [-0.16, 1.05, -0.48]],
  [2.3, [0.34, 0.2, 0.72]],
  [3.0, [0.08, -0.4, 0.18]],
  [3.6, [0, 0, 0]],
];
const IN_HAND_POS = [
  [0.0, [0, 0, 0]],
  [1.5, [0.004, -0.008, 0.014]],
  [2.3, [0.016, -0.03, 0.03]],
  [3.0, [0.006, -0.006, 0.01]],
  [3.6, [0, 0, 0]],
];

/* -------------------------------------------------------------------------- */

export function createProcAnim(ctx) {
  const rng = typeof ctx?.rng === 'function' ? ctx.rng : () => 0.5;

  /* rig references */
  let R = null; // {rig, gun, nodes, hands, def, view, mods}
  const sightLocal = new THREE.Vector3(0, 0.063, -0.06);

  /* state */
  let adsRaw = 0;
  let adsBlend = 0;
  let sprintW = 0;
  let tacW = 0;
  let lowW = 0;
  let breathT = rng() * 10;
  let bobT = 0;
  let shotIndex = 0;
  let sinceShot = 99;
  let chamberOpen = false;
  let boltHold = 0;
  let action = null; // 'reload' | 'inspect' | 'melee' | 'swap'
  let actionT = 0;
  let actionLen = 0;
  let actionEmpty = false;
  let actionEvents = [];
  let swapDir = 0;
  let triggerPull = 0;
  let flinchAmt = 0;

  /* springs */
  const swayYaw = new Spring(6.5, 0.62);
  const swayPitch = new Spring(6.8, 0.62);
  const swayRoll = new Spring(5.4, 0.7);
  const recoilPos = new Spring3(13, 0.42);
  const recoilRot = new Spring3(11, 0.4);
  const settlePos = new Spring3(7, 0.75);
  const settleRot = new Spring3(6.5, 0.75);
  const boltSpring = new Spring(11, 0.34);
  const chSpring = new Spring(10, 0.36);
  const magSeat = new Spring(18, 0.5);

  /* scratch */
  const _p = new THREE.Vector3();
  const _r = new THREE.Vector3();
  const _p2 = new THREE.Vector3();
  const _r2 = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const posOut = new THREE.Vector3();
  const rotOut = new THREE.Vector3();

  let prevYaw = null;
  let prevPitch = null;
  const handPos = new THREE.Vector3();
  const handRot = new THREE.Vector3();
  const magPos = new THREE.Vector3();
  const magRot = new THREE.Vector3();

  /* ---------------------------------------------------------------- poses */

  function poseOf(name, fallback) {
    const v = R?.view?.[name];
    if (v?.pos && v?.rot) return v;
    return fallback;
  }

  const HIP_FALLBACK = { pos: [0.12, -0.11, -0.16], rot: [0.015, -0.06, 0.03] };

  /** Position that puts the optic's axis exactly on the camera axis. */
  function adsPose(out, outRot) {
    const relief = R?.view?.adsEyeRelief ?? 0.11;
    out.set(-sightLocal.x, -sightLocal.y, -relief - sightLocal.z);
    outRot.set(0, 0, 0);
  }

  /* --------------------------------------------------------------- actions */

  function reloadTracks(empty) {
    const s = empty ? 1.0 : 1.0;
    return {
      wp: RL_WEAPON_POS,
      wr: RL_WEAPON_ROT,
      hp: RL_HAND_POS,
      hr: RL_HAND_ROT,
      mp: RL_MAG_POS,
      mr: RL_MAG_ROT,
      mv: RL_MAG_VIS,
      scale: s,
    };
  }

  let eventScale = 1;

  /** Events are authored against a reference timeline; `ref` maps them onto `len`. */
  function begin(kind, len, events, ref) {
    action = kind;
    actionT = 0;
    actionLen = Math.max(0.05, len);
    eventScale = actionLen / Math.max(1e-4, ref || actionLen);
    actionEvents = (events || []).map((e) => ({ ...e, done: false }));
  }

  const api = {
    /* ------------------------------------------------------------- setup */
    setRig(rig) {
      R = rig || null;
      shotIndex = 0;
      sinceShot = 99;
      chamberOpen = false;
      action = null;
      actionT = 0;
      recoilPos.reset();
      recoilRot.reset();
      settlePos.reset();
      settleRot.reset();
      swayYaw.set(0);
      swayPitch.set(0);
      swayRoll.set(0);
      boltSpring.set(0);
      chSpring.set(0);
      prevYaw = null;
      prevPitch = null;
      adsRaw = 0;
      adsBlend = 0;
      sprintW = 0;
      tacW = 0;
    },
    setSightLocal(v) {
      if (v) sightLocal.copy(v);
    },

    get adsBlend() {
      return adsBlend;
    },
    get adsRaw() {
      return adsRaw;
    },
    get action() {
      return action;
    },
    get actionTime() {
      return actionT;
    },
    get actionLength() {
      return actionLen;
    },
    get busy() {
      return action !== null;
    },
    get chamberOpen() {
      return chamberOpen;
    },
    get shotIndex() {
      return shotIndex;
    },
    resetShotIndex() {
      shotIndex = 0;
    },
    setChamberOpen(v) {
      chamberOpen = !!v;
      boltHold = v ? 1 : 0;
    },

    /* -------------------------------------------------------------- events */
    fire(o = {}) {
      const v = R?.def?.recoil?.view || { back: 0.03, up: 0.006, pitch: 0.12, yaw: 0.05, roll: 0.07 };
      const mods = R?.mods || {};
      const mv = mods.recoilV ?? 1;
      const mh = mods.recoilH ?? 1;
      const adsDamp = lerp(1, 0.62, adsBlend);
      const g1 = rng() * 2 - 1;
      const g2 = rng() * 2 - 1;
      recoilPos.push(
        g1 * v.back * 0.22 * mh * adsDamp,
        v.up * 44 * mv * adsDamp,
        v.back * 62 * mv * adsDamp
      );
      recoilRot.push(
        -v.pitch * 26 * mv * adsDamp,
        g1 * v.yaw * 22 * mh * adsDamp,
        g2 * v.roll * 20 * mh * adsDamp
      );
      settlePos.push(0, v.up * 4 * adsDamp, v.back * 6 * adsDamp);
      settleRot.push(-v.pitch * 2.2 * adsDamp, g2 * v.yaw * 2.0, g1 * v.roll * 2.0);
      // Mechanism: the carrier is thrown rearward and the spring runs it home, which
      // for a rifle is a ~60 ms round trip.
      boltSpring.push(78);
      if (R?.recip) chSpring.push(72);
      shotIndex++;
      sinceShot = 0;
      triggerPull = 1;
      void o;
    },

    flinch(a = 0.4) {
      flinchAmt = clamp(flinchAmt + a, 0, 1.4);
      recoilRot.push(-0.9 * a, (rng() * 2 - 1) * 1.4 * a, (rng() * 2 - 1) * 1.1 * a);
      recoilPos.push((rng() * 2 - 1) * 0.05 * a, -0.05 * a, 0.1 * a);
    },

    reload(empty) {
      if (action === 'reload') return false;
      actionEmpty = !!empty;
      const len = empty ? R?.reloadEmpty ?? 2.9 : R?.reloadTactical ?? 2.1;
      begin(
        'reload',
        len,
        [
          { t: 0.42, name: 'release' },
          { t: 0.64, name: 'magout' },
          { t: 1.18, name: 'magin' },
          { t: 1.6, name: 'seat' },
          ...(empty ? [{ t: 2.28, name: 'boltrelease' }] : []),
        ],
        RELOAD_BASE
      );
      return true;
    },
    inspect() {
      if (action) return false;
      begin('inspect', R?.def?.inspectTime ?? 3.6, [{ t: 1.9, name: 'chambercheck' }], 3.6);
      return true;
    },
    melee() {
      if (action === 'melee') return false;
      const len = R?.def?.meleeTime ?? 0.72;
      begin('melee', len, [{ t: 0.24, name: 'meleehit' }], len);
      return true;
    },
    swap(dir) {
      swapDir = dir < 0 ? -1 : 1;
      const len = dir < 0 ? R?.def?.swapOut ?? 0.35 : R?.def?.swapIn ?? 0.55;
      begin('swap', len, [], len);
      return true;
    },
    cancelAction() {
      action = null;
      actionT = 0;
    },

    /* --------------------------------------------------------------- frame */
    update(dt, s = {}) {
      const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 1 / 60;
      if (!R?.rig) return null;
      const def = R.def || {};
      const view = R.view || {};

      /* --- 0. discrete state ------------------------------------------- */
      sinceShot += d;
      triggerPull = s.firing ? 1 : Math.max(0, triggerPull - d * 7);
      flinchAmt = Math.max(0, flinchAmt - d * 2.2);

      let ev = null;
      if (action) {
        actionT += d;
        for (const e of actionEvents) {
          if (!e.done && actionT >= e.t * eventScale) {
            e.done = true;
            ev = ev || [];
            ev.push(e.name);
          }
        }
        if (actionT >= actionLen) {
          const finished = action;
          action = null;
          actionT = 0;
          ev = ev || [];
          ev.push(`${finished}:end`);
        }
      }

      /* --- 1. weights --------------------------------------------------- */
      const stance = typeof s.stance === 'string' ? s.stance : '';
      const wantSprint = !!s.sprint && !action && adsRaw < 0.05;
      const wantTac = !!s.tacSprint && !action && adsRaw < 0.05;
      sprintW = damp(sprintW, wantSprint && !wantTac ? 1 : 0, 11, d);
      tacW = damp(tacW, wantTac ? 1 : 0, 9, d);
      lowW = damp(lowW, s.lowReady && !action ? 1 : 0, 8, d);

      const adsAllowed = !!s.adsWant && !action && !wantSprint && !wantTac;
      const tIn = Math.max(0.05, R.adsTime ?? def.adsTime ?? 0.25);
      const tOut = Math.max(0.04, R.adsOutTime ?? def.adsOutTime ?? 0.2);
      if (adsAllowed) adsRaw = Math.min(1, adsRaw + d / tIn);
      else adsRaw = Math.max(0, adsRaw - d / tOut);
      // Fast-out / slow-in with a touch of overshoot going in; a plainer curve coming
      // out so dropping the sight never feels sticky.
      adsBlend = adsAllowed
        ? clamp(easeOutBack(adsRaw, 0.9), 0, 1.09)
        : easeInQuad(adsRaw) * 0.35 + easeOutQuint(adsRaw) * 0.65;

      /* --- 2. pose blend ------------------------------------------------ */
      const hip = poseOf('hip', HIP_FALLBACK);
      posOut.fromArray(hip.pos);
      rotOut.fromArray(hip.rot);

      if (adsBlend > 1e-4) {
        adsPose(_p, _r);
        const k = clamp(adsBlend, 0, 1.09);
        posOut.lerp(_p, k);
        rotOut.lerp(_r, k);
      }
      const blendPose = (name, w) => {
        if (w <= 1e-4) return;
        const p = poseOf(name, null);
        if (!p) return;
        _p2.fromArray(p.pos);
        _r2.fromArray(p.rot);
        posOut.lerp(_p2, w);
        rotOut.lerp(_r2, w);
      };
      blendPose('lowReady', lowW * (1 - adsBlend));
      blendPose('sprint', sprintW * (1 - tacW));
      blendPose('tacSprint', tacW);

      /* --- 3. action overlay -------------------------------------------- */
      handPos.set(0, 0, 0);
      handRot.set(0, 0, 0);
      magPos.set(0, 0, 0);
      magRot.set(0, 0, 0);
      let magVisible = true;
      let chOffset = 0;

      if (action === 'reload') {
        const tr = reloadTracks(actionEmpty);
        const scale = actionLen / RELOAD_BASE;
        const t = actionT / Math.max(1e-4, scale);
        sample3(tr.wp, t, _p);
        sample3(tr.wr, t, _r);
        posOut.add(_p);
        rotOut.add(_r);
        sample3(tr.hp, t, handPos);
        sample3(tr.hr, t, handRot);
        sample3(tr.mp, t, magPos);
        sample3(tr.mr, t, magRot);
        magVisible = sample1(tr.mv, t) > 0.5;
        if (actionEmpty && t > RELOAD_BASE * 0.94) {
          // Bolt release: the support hand slaps the catch and the carrier runs home.
          const u = clamp01((t - RELOAD_BASE * 0.94) / (RELOAD_BASE * 0.26));
          handPos.set(-0.06 * Math.sin(u * Math.PI), 0.03 * Math.sin(u * Math.PI), 0.05 * Math.sin(u * Math.PI));
          handRot.set(0.2 * Math.sin(u * Math.PI), -0.3 * Math.sin(u * Math.PI), 0);
        }
      } else if (action === 'inspect') {
        const scale = actionLen / 3.6;
        const t = actionT / Math.max(1e-4, scale);
        sample3(IN_POS, t, _p);
        sample3(IN_ROT, t, _r);
        posOut.add(_p);
        rotOut.add(_r);
        sample3(IN_HAND_POS, t, handPos);
        // Chamber check: pull the charging handle back a third of the way and let go.
        const u = clamp01((t - 1.75) / 0.5);
        chOffset = Math.sin(clamp01(u) * Math.PI) * 0.028;
      } else if (action === 'melee') {
        const t = actionT / actionLen;
        const strike = Math.sin(clamp01(t / 0.36) * Math.PI * 0.5);
        const back = t > 0.36 ? smooth(clamp01((t - 0.36) / 0.64)) : 0;
        const k = strike * (1 - back);
        const mp = poseOf('melee', { pos: [0.2, -0.06, -0.09], rot: [-0.1, -1.0, 0.55] });
        posOut.x = lerp(posOut.x, mp.pos[0], k);
        posOut.y = lerp(posOut.y, mp.pos[1], k);
        posOut.z = lerp(posOut.z, mp.pos[2] + 0.1 * Math.sin(k * Math.PI), k);
        rotOut.x = lerp(rotOut.x, mp.rot[0], k);
        rotOut.y = lerp(rotOut.y, mp.rot[1], k);
        rotOut.z = lerp(rotOut.z, mp.rot[2], k);
      } else if (action === 'swap') {
        const t = clamp01(actionT / actionLen);
        const k = swapDir < 0 ? smooth(t) : 1 - smooth(t);
        posOut.y -= 0.26 * k;
        posOut.z += 0.06 * k;
        rotOut.x += 1.15 * k;
        rotOut.y -= 0.22 * k;
      }

      /* --- 4. additive layers ------------------------------------------- */
      const addScale = (1 - 0.86 * clamp01(adsBlend)) * (view.swayScale ?? 1);

      // 4a. rotational lag: the weapon trails the camera and rolls into the turn.
      const cam = ctx.viewCamera || ctx.camera;
      if (cam) {
        const yaw = cam.rotation.y;
        const pitch = cam.rotation.x;
        if (prevYaw !== null) {
          let dy = yaw - prevYaw;
          while (dy > Math.PI) dy -= TAU;
          while (dy < -Math.PI) dy += TAU;
          const dp = pitch - prevPitch;
          const gain = 3.4 * (def.handling ?? 1);
          swayYaw.push(clamp(-dy, -0.5, 0.5) * gain);
          swayPitch.push(clamp(-dp, -0.5, 0.5) * gain * 0.85);
          swayRoll.push(clamp(-dy, -0.5, 0.5) * gain * 1.35);
        }
        prevYaw = yaw;
        prevPitch = pitch;
      }
      swayYaw.step(d);
      swayPitch.step(d);
      swayRoll.step(d);
      const sy = clamp(swayYaw.x, -0.4, 0.4) * addScale;
      const sp = clamp(swayPitch.x, -0.35, 0.35) * addScale;
      const sr = clamp(swayRoll.x, -0.5, 0.5) * addScale;
      rotOut.y += sy * 0.72;
      rotOut.x += sp * 0.66;
      rotOut.z += sr * 0.5;
      posOut.x += sy * 0.052;
      posOut.y += sp * 0.038;

      // 4b. bob, counter-phased against the camera's own bob so the weapon reads as
      //     a heavy object being carried rather than something glued to the lens.
      const vo = ctx.cameraRig?.getViewOffset?.();
      const speed = Number.isFinite(s.speed) ? s.speed : vo?.speed ?? 0;
      const moveN = clamp01(speed / 5.2);
      const bobScale = (view.bobScale ?? 1) * addScale;
      let bx = 0;
      let by = 0;
      let bw = 0;
      if (vo?.bob && Number.isFinite(vo.bob.phase)) {
        bw = clamp01(vo.bob.weight ?? moveN);
        const ph = vo.bob.phase + Math.PI * 0.62; // counter-phase
        bx = Math.sin(ph);
        by = Math.sin(ph * 2);
      } else {
        bobT += d * (5.2 + 4.4 * moveN);
        bw = moveN;
        bx = Math.sin(bobT);
        by = Math.sin(bobT * 2);
      }
      const bAmp = 0.011 * bw * bobScale * (1 + 0.7 * tacW + 0.4 * sprintW);
      posOut.x += bx * bAmp;
      posOut.y += by * bAmp * 0.62;
      posOut.z += Math.abs(by) * bAmp * 0.3;
      rotOut.z += bx * 0.052 * bw * bobScale;
      rotOut.x += by * 0.026 * bw * bobScale;
      rotOut.y += bx * 0.038 * bw * bobScale;
      if (vo?.pos) {
        // Counter the camera's translation: the gun should not ride the lens exactly.
        posOut.x -= vo.pos.x * 0.42 * addScale;
        posOut.y -= vo.pos.y * 0.42 * addScale;
      }

      // 4c. lateral velocity tilt.
      const lat = Number.isFinite(s.lateral) ? s.lateral : vo?.lateral ?? 0;
      const latN = clamp(lat / 5, -1, 1);
      rotOut.z += latN * 0.06 * addScale;
      posOut.x -= latN * 0.012 * addScale;

      // 4d. breathing.
      const exert = clamp01(s.exertion ?? vo?.exertion ?? 0);
      breathT += d * (0.85 + 0.75 * exert + 0.5 * moveN);
      const bA = (0.0022 + 0.0032 * exert) * lerp(1, 0.3, clamp01(adsBlend)) * (view.swayScale ?? 1);
      posOut.x += Math.sin(breathT * 0.92) * bA;
      posOut.y += Math.sin(breathT * 1.83 + 1.1) * bA * 0.8;
      rotOut.x += Math.sin(breathT * 1.83 + 1.1) * bA * 3.4;
      rotOut.y += Math.sin(breathT * 0.92) * bA * 3.0;

      // 4e. recoil.
      recoilPos.step(d);
      recoilRot.step(d);
      settlePos.step(d);
      settleRot.step(d);
      posOut.x += recoilPos.x + settlePos.x;
      posOut.y += recoilPos.y + settlePos.y;
      posOut.z += recoilPos.z + settlePos.z;
      rotOut.x += recoilRot.x + settleRot.x;
      rotOut.y += recoilRot.y + settleRot.y;
      rotOut.z += recoilRot.z + settleRot.z;

      /* --- 5. commit the root pose -------------------------------------- */
      if (!Number.isFinite(posOut.x) || !Number.isFinite(rotOut.x)) {
        posOut.fromArray(hip.pos);
        rotOut.fromArray(hip.rot);
        recoilPos.reset();
        recoilRot.reset();
      }
      R.rig.position.set(posOut.x, posOut.y, posOut.z);
      _e.set(rotOut.x, rotOut.y, rotOut.z, 'YXZ');
      R.rig.quaternion.setFromEuler(_e);

      /* --- 6. sub-parts -------------------------------------------------- */
      const n = R.nodes || {};

      // Bolt carrier: driven back on the shot, returns on the recoil spring; held
      // open when the chamber is empty.
      boltSpring.step(d, boltHold);
      const boltT = clamp(boltSpring.x, 0, 1.15);
      const travel = R.boltTravel ?? 0.05;
      if (n.bolt) n.bolt.position.z = boltT * travel;
      if (n.charging) {
        chSpring.step(d, 0);
        const chT = (R.recip ? clamp(chSpring.x, 0, 1.15) * travel : 0) + chOffset;
        n.charging.position.z = chT;
      }
      // Ejection-port cover swings open on the first round and stays open.
      if (n.dustCover) {
        const want = shotIndex > 0 || chamberOpen ? 1 : 0;
        n.dustCover.userData.o = damp(n.dustCover.userData.o ?? 0, want, 14, d);
        n.dustCover.rotation.z = -n.dustCover.userData.o * 1.9;
      }
      if (n.trigger) {
        const pull = Math.max(triggerPull, action === 'melee' ? 0 : 0);
        n.trigger.rotation.x = pull * 0.2;
        n.trigger.position.z = pull * 0.0022;
      }
      if (n.boltCatch) n.boltCatch.rotation.x = (chamberOpen ? 0.16 : 0) + (action === 'reload' ? 0 : 0);
      if (n.selector) n.selector.rotation.x = (R.fireModeIndex ?? 0) * -0.5;

      // Magazine.
      magSeat.step(d, 0);
      if (n.magazine) {
        n.magazine.visible = magVisible;
        n.magazine.position.set(magPos.x, magPos.y + magSeat.x * 0.004, magPos.z);
        _e.set(magRot.x, magRot.y, magRot.z, 'YXZ');
        n.magazine.quaternion.setFromEuler(_e);
      }
      if (n.follower && R.magTravel) {
        const frac = clamp01((s.ammo ?? 0) / Math.max(1, s.magSize ?? 30));
        n.follower.position.y = (R.followerTop ?? 0) - frac * R.magTravel;
      }

      // Hands.
      if (R.hands?.leftRig) {
        R.hands.leftRig.position.set(handPos.x, handPos.y, handPos.z);
        _e.set(handRot.x, handRot.y, handRot.z, 'YXZ');
        R.hands.leftRig.quaternion.setFromEuler(_e);
      }
      if (R.hands?.rightRig) {
        // The firing hand only ever rides the grip; give it a whisker of give so the
        // recoil does not look welded.
        R.hands.rightRig.position.set(
          -recoilPos.x * 0.1,
          -recoilPos.y * 0.06,
          -recoilPos.z * 0.08
        );
      }
      // Trigger finger: indexed straight along the receiver until the trigger breaks.
      const idx = R.hands?.right?.indexJoints;
      if (idx && idx.length >= 4) {
        const k = triggerPull;
        idx[1].rotation.x = -lerp(0.1, 1.02, k);
        idx[2].rotation.x = -lerp(0.05, 1.15, k);
        idx[3].rotation.x = -lerp(0.03, 0.62, k);
      }

      return ev;
    },
  };

  return api;
}

function damp(a, b, rate, dt) {
  return b + (a - b) * Math.exp(-rate * Math.max(0, dt));
}

export { Spring, Spring3 };
export default createProcAnim;
