/**
 * WeaponDefs — the data behind every gun. Owner: weapons agent.
 *
 * Nothing in here touches three. It is pure data plus a few pure helpers, so the
 * balance pass, the HUD and the ballistics solver can all read the same numbers.
 *
 * Public API:
 *   WEAPON_DEFS                 id -> def
 *   WEAPON_IDS                  ordered id list
 *   getWeaponDef(id)            def | null   (accepts 'none')
 *   damageAt(def, metres)       interpolated body damage
 *   rpmToInterval(def)          seconds between shots
 *   recoilStep(def, shotIndex)  {x, y} authored pattern sample, in radians
 *   spreadOf(def, state)        current cone half-angle in radians
 *
 * ── Coordinate convention for `view` poses ───────────────────────────────────
 * Camera space, right-handed: +X right, +Y up, **−Z forward**. Weapon-local space
 * is the same: the bore runs down −Z, the origin sits on the bore axis at the rear
 * face of the receiver. `pos` is metres, `rot` is radians (XYZ order applied as
 * pitch/yaw/roll on a YXZ euler).
 *
 * ── Recoil patterns ──────────────────────────────────────────────────────────
 * `recoil.pattern` is an authored list of [horizontal, vertical] samples in
 * *pattern units* (1 unit = `recoil.unit` radians). It is deliberately learnable:
 * a hard climb for the first few rounds, then a signed drift. Past the end of the
 * list it wraps into `recoil.tail`, which is where the seeded jitter takes over.
 */

const DEG = Math.PI / 180;

/* -------------------------------------------------------------------------- */
/*                             shared sub-recipes                             */
/* -------------------------------------------------------------------------- */

const AR_SPREAD = {
  hipBase: 2.4 * DEG,
  hipMax: 6.2 * DEG,
  hipPerShot: 0.42 * DEG,
  hipRecover: 5.5 * DEG, // per second
  adsBase: 0.13 * DEG,
  adsMax: 1.05 * DEG,
  adsPerShot: 0.1 * DEG,
  adsRecover: 2.2 * DEG,
  moveMul: 1.65,
  jumpMul: 3.1,
  crouchMul: 0.78,
};

/* -------------------------------------------------------------------------- */
/*                                  weapons                                   */
/* -------------------------------------------------------------------------- */

/**
 * `build` is consumed by ViewmodelBuilder. Every length is metres in weapon-local
 * space; the bore is the Z axis at y = 0 and the muzzle is at negative Z.
 */
export const WEAPON_DEFS = {
  /* ═══════════════════════════════ assault rifle ═══════════════════════════ */
  ar_wolverine: {
    id: 'ar_wolverine',
    name: 'WOLVERINE',
    fullName: 'Wolverine M4A2',
    class: 'ar',
    calibre: '5.56x45',

    rpm: 735,
    fireModes: ['auto', 'burst', 'semi'],
    burstCount: 3,
    burstGapScale: 2.6,
    magSize: 30,
    startReserve: 210,
    chambered: true, // +1 in the pipe when reloading a partially-full mag

    damage: [
      { r: 0, v: 33 },
      { r: 22, v: 30 },
      { r: 42, v: 24 },
      { r: 75, v: 19 },
    ],
    headMult: 1.6,
    chestMult: 1.0,
    limbMult: 0.86,
    muzzleVelocity: 880,
    penetration: 0.72,
    tracerEvery: 5,

    spread: AR_SPREAD,

    recoil: {
      unit: 0.0031, // radians per pattern unit
      vertical: 0.0212, // camera kick hint for CameraRig
      horizontal: 0.0094,
      back: 0.023,
      recovery: 7.4,
      // Steep climb, then a lazy left drift, then a snap right — learnable.
      pattern: [
        [0.0, 1.0],
        [-0.1, 1.35],
        [0.15, 1.5],
        [-0.25, 1.45],
        [-0.5, 1.3],
        [-0.8, 1.1],
        [-1.05, 0.95],
        [-1.15, 0.8],
        [-1.0, 0.72],
        [-0.6, 0.68],
        [-0.1, 0.66],
        [0.45, 0.64],
        [0.9, 0.62],
        [1.2, 0.6],
        [1.3, 0.58],
        [1.15, 0.58],
        [0.8, 0.56],
        [0.3, 0.56],
        [-0.2, 0.55],
        [-0.65, 0.55],
      ],
      tail: { h: 0.9, v: 0.55, jitter: 0.42 },
      // viewmodel spring impulse
      view: { back: 0.034, up: 0.0075, pitch: 0.135, yaw: 0.05, roll: 0.075 },
    },

    adsTime: 0.26,
    adsOutTime: 0.2,
    sprintOutTime: 0.19,
    swapIn: 0.55,
    swapOut: 0.36,
    reload: { tactical: 2.1, empty: 2.9 },
    inspectTime: 3.6,
    meleeTime: 0.72,

    moveSpeedScale: 1.0,
    adsMoveScale: 0.53,
    adsFovScale: 0.7,
    zoom: 1.0,
    mass: 3.4, // drives sway inertia
    handling: 1.0,

    view: {
      hip: { pos: [0.1235, -0.1085, -0.163], rot: [0.014, -0.062, 0.031] },
      adsEyeRelief: 0.108,
      lowReady: { pos: [0.108, -0.152, -0.145], rot: [0.44, -0.1, 0.06] },
      sprint: { pos: [0.128, -0.13, -0.115], rot: [0.13, -0.62, 0.34] },
      tacSprint: { pos: [0.075, -0.2, -0.06], rot: [1.02, -0.5, 0.44] },
      inspect: { pos: [0.055, -0.09, -0.075], rot: [0.06, 0.92, -0.22] },
      melee: { pos: [0.2, -0.06, -0.09], rot: [-0.1, -1.0, 0.55] },
      swayScale: 1.0,
      bobScale: 1.0,
    },

    slots: ['optic', 'muzzle', 'underbarrel', 'magazine'],
    defaultAttachments: { optic: 'reddot_kite', muzzle: 'brake_vortex', underbarrel: 'none', magazine: 'mag_std' },

    audio: { fire: 'ar_fire', tail: 'ar_tail', reloadIn: 'mag_in', reloadOut: 'mag_out' },

    build: {
      style: 'ar',
      receiver: { z0: -0.207, z1: 0.006, halfW: 0.0192, yTop: 0.0205, yBot: -0.0158 },
      rail: { z0: -0.508, z1: 0.004, y: 0.0205, halfW: 0.0107 },
      port: { z0: -0.099, z1: -0.0345, y0: -0.0035, y1: 0.0142, depth: 0.0088 },
      lower: { z0: -0.19, z1: 0.006, yTop: -0.0158, yBot: -0.0335, halfW: 0.0172 },
      magwell: { z0: -0.1595, z1: -0.0805, yTop: -0.0158, yBot: -0.0705, halfW: 0.017, halfD: 0.0272, wallT: 0.0042 },
      barrel: {
        muzzleZ: -0.554,
        chamberZ: -0.203,
        chamberR: 0.0152,
        midR: 0.0091,
        thinR: 0.0079,
        gasBlockZ: -0.452,
        fluted: true,
      },
      handguard: {
        z0: -0.212,
        z1: -0.512,
        r: 0.0243,
        facets: 8,
        style: 'mlok',
        slotRows: [1, 2, 3, 5, 6, 7],
        ventRows: [],
      },
      stock: { style: 'ar_adjustable', z0: 0.004, len: 0.238, tubeR: 0.0168, cheek: true },
      grip: { style: 'ar', z: -0.0435, y: -0.0325, angle: 25 * DEG, len: 0.115, w: 0.0335, d: 0.0455 },
      mag: {
        style: 'stanag',
        z: -0.1205,
        yTop: -0.0405,
        len: 0.195,
        w: 0.0262,
        d: 0.046,
        curveR: 0.62,
        witness: 4,
      },
      muzzleDevice: { style: 'brake', len: 0.052, r: 0.0142, ports: 3 },
      sightHeight: 0.0632,
      ironSightHeight: 0.0335,
      wear: 0.62,
      tint: { metal: 0x2b2d31, polymer: 0x2e3029 },
    },
  },

  /* ══════════════════════════════════ smg ═════════════════════════════════ */
  smg_viper: {
    id: 'smg_viper',
    name: 'VIPER',
    fullName: 'Viper VMP-9',
    class: 'smg',
    calibre: '9x19',

    rpm: 935,
    fireModes: ['auto', 'semi'],
    burstCount: 2,
    magSize: 32,
    startReserve: 224,
    chambered: true,

    damage: [
      { r: 0, v: 28 },
      { r: 12, v: 25 },
      { r: 24, v: 19 },
      { r: 40, v: 15 },
    ],
    headMult: 1.45,
    chestMult: 1.0,
    limbMult: 0.9,
    muzzleVelocity: 390,
    penetration: 0.38,
    tracerEvery: 4,

    spread: {
      hipBase: 1.9 * DEG,
      hipMax: 5.4 * DEG,
      hipPerShot: 0.3 * DEG,
      hipRecover: 6.4 * DEG,
      adsBase: 0.2 * DEG,
      adsMax: 1.5 * DEG,
      adsPerShot: 0.11 * DEG,
      adsRecover: 2.9 * DEG,
      moveMul: 1.28,
      jumpMul: 2.6,
      crouchMul: 0.82,
    },

    recoil: {
      unit: 0.0024,
      vertical: 0.0158,
      horizontal: 0.0112,
      back: 0.016,
      recovery: 9.2,
      // Fast, whippy, alternating — controllable but noisy at the edges.
      pattern: [
        [0.0, 0.85],
        [0.2, 1.1],
        [-0.3, 1.15],
        [0.45, 1.0],
        [-0.55, 0.92],
        [0.7, 0.86],
        [-0.8, 0.8],
        [0.85, 0.76],
        [-0.9, 0.72],
        [0.95, 0.7],
        [-1.0, 0.68],
        [1.05, 0.66],
        [-1.1, 0.64],
        [1.0, 0.62],
        [-0.9, 0.62],
        [0.7, 0.6],
      ],
      tail: { h: 1.1, v: 0.58, jitter: 0.55 },
      view: { back: 0.024, up: 0.0055, pitch: 0.1, yaw: 0.052, roll: 0.06 },
    },

    adsTime: 0.2,
    adsOutTime: 0.16,
    sprintOutTime: 0.14,
    swapIn: 0.44,
    swapOut: 0.3,
    reload: { tactical: 1.95, empty: 2.62 },
    inspectTime: 3.2,
    meleeTime: 0.66,

    moveSpeedScale: 1.06,
    adsMoveScale: 0.62,
    adsFovScale: 0.78,
    zoom: 1.0,
    mass: 2.5,
    handling: 1.22,

    view: {
      hip: { pos: [0.118, -0.1015, -0.152], rot: [0.016, -0.07, 0.036] },
      adsEyeRelief: 0.1,
      lowReady: { pos: [0.104, -0.145, -0.135], rot: [0.46, -0.11, 0.07] },
      sprint: { pos: [0.122, -0.122, -0.108], rot: [0.14, -0.66, 0.37] },
      tacSprint: { pos: [0.07, -0.19, -0.055], rot: [1.06, -0.54, 0.47] },
      inspect: { pos: [0.05, -0.085, -0.07], rot: [0.05, 0.98, -0.24] },
      melee: { pos: [0.19, -0.055, -0.085], rot: [-0.12, -1.05, 0.58] },
      swayScale: 1.18,
      bobScale: 1.1,
    },

    slots: ['optic', 'muzzle', 'underbarrel', 'magazine'],
    defaultAttachments: { optic: 'reddot_kite', muzzle: 'comp_stub', underbarrel: 'grip_vertical', magazine: 'mag_std' },

    audio: { fire: 'smg_fire', tail: 'smg_tail', reloadIn: 'mag_in', reloadOut: 'mag_out' },

    build: {
      style: 'smg',
      receiver: { z0: -0.176, z1: 0.004, halfW: 0.0205, yTop: 0.0192, yBot: -0.0182 },
      rail: { z0: -0.398, z1: 0.002, y: 0.0192, halfW: 0.0107 },
      port: { z0: -0.084, z1: -0.0335, y0: -0.0025, y1: 0.0128, depth: 0.0082 },
      lower: { z0: -0.168, z1: 0.004, yTop: -0.0182, yBot: -0.0345, halfW: 0.019 },
      magwell: { z0: -0.128, z1: -0.062, yTop: -0.0182, yBot: -0.062, halfW: 0.0158, halfD: 0.0208, wallT: 0.004 },
      barrel: {
        muzzleZ: -0.428,
        chamberZ: -0.172,
        chamberR: 0.0132,
        midR: 0.0079,
        thinR: 0.0069,
        gasBlockZ: -0.362,
        fluted: false,
      },
      handguard: {
        z0: -0.182,
        z1: -0.402,
        r: 0.0232,
        facets: 8,
        style: 'vented',
        slotRows: [2, 6],
        ventRows: [1, 3, 5, 7],
      },
      stock: { style: 'folding', z0: 0.002, len: 0.178, tubeR: 0.014, cheek: false },
      grip: { style: 'smg', z: -0.0365, y: -0.0335, angle: 21 * DEG, len: 0.108, w: 0.0322, d: 0.0425 },
      mag: {
        style: 'stick',
        z: -0.0955,
        yTop: -0.038,
        len: 0.168,
        w: 0.0248,
        d: 0.0338,
        curveR: 0.96,
        witness: 5,
      },
      muzzleDevice: { style: 'comp', len: 0.038, r: 0.0122, ports: 4 },
      sightHeight: 0.0605,
      ironSightHeight: 0.0322,
      wear: 0.5,
      tint: { metal: 0x26282c, polymer: 0x35362f },
    },
  },

  /* ═════════════════════════════ marksman rifle ════════════════════════════ */
  dmr_kestrel: {
    id: 'dmr_kestrel',
    name: 'KESTREL',
    fullName: 'Kestrel MK12 DMR',
    class: 'dmr',
    calibre: '7.62x51',

    rpm: 400,
    fireModes: ['semi'],
    burstCount: 1,
    magSize: 20,
    startReserve: 100,
    chambered: true,

    damage: [
      { r: 0, v: 62 },
      { r: 45, v: 58 },
      { r: 90, v: 48 },
      { r: 150, v: 42 },
    ],
    headMult: 1.85,
    chestMult: 1.0,
    limbMult: 0.92,
    muzzleVelocity: 810,
    penetration: 1.35,
    tracerEvery: 3,

    spread: {
      hipBase: 3.6 * DEG,
      hipMax: 7.4 * DEG,
      hipPerShot: 0.9 * DEG,
      hipRecover: 4.2 * DEG,
      adsBase: 0.024 * DEG,
      adsMax: 0.6 * DEG,
      adsPerShot: 0.2 * DEG,
      adsRecover: 1.6 * DEG,
      moveMul: 2.3,
      jumpMul: 4.0,
      crouchMul: 0.7,
    },

    recoil: {
      unit: 0.0072,
      vertical: 0.042,
      horizontal: 0.012,
      back: 0.041,
      recovery: 5.6,
      pattern: [
        [0.0, 1.0],
        [0.35, 1.05],
        [-0.4, 1.0],
        [0.5, 0.98],
        [-0.55, 0.96],
        [0.6, 0.94],
        [-0.65, 0.92],
        [0.7, 0.9],
      ],
      tail: { h: 0.75, v: 0.9, jitter: 0.3 },
      view: { back: 0.055, up: 0.011, pitch: 0.24, yaw: 0.06, roll: 0.1 },
    },

    adsTime: 0.38,
    adsOutTime: 0.28,
    sprintOutTime: 0.27,
    swapIn: 0.68,
    swapOut: 0.46,
    reload: { tactical: 2.35, empty: 3.15 },
    inspectTime: 3.9,
    meleeTime: 0.8,

    moveSpeedScale: 0.92,
    adsMoveScale: 0.42,
    adsFovScale: 0.36,
    zoom: 3.4,
    mass: 4.6,
    handling: 0.78,

    view: {
      hip: { pos: [0.1315, -0.1155, -0.178], rot: [0.012, -0.056, 0.028] },
      adsEyeRelief: 0.152,
      lowReady: { pos: [0.115, -0.16, -0.155], rot: [0.42, -0.09, 0.055] },
      sprint: { pos: [0.135, -0.138, -0.125], rot: [0.12, -0.58, 0.32] },
      tacSprint: { pos: [0.082, -0.212, -0.07], rot: [0.98, -0.47, 0.42] },
      inspect: { pos: [0.062, -0.1, -0.085], rot: [0.07, 0.88, -0.2] },
      melee: { pos: [0.21, -0.07, -0.1], rot: [-0.09, -0.96, 0.52] },
      swayScale: 0.82,
      bobScale: 0.9,
    },

    slots: ['optic', 'muzzle', 'underbarrel', 'magazine'],
    defaultAttachments: { optic: 'scope_lynx4x', muzzle: 'suppressor_whisper', underbarrel: 'none', magazine: 'mag_std' },

    audio: { fire: 'dmr_fire', tail: 'dmr_tail', reloadIn: 'mag_in', reloadOut: 'mag_out' },

    build: {
      style: 'dmr',
      receiver: { z0: -0.238, z1: 0.008, halfW: 0.0205, yTop: 0.0232, yBot: -0.0178 },
      rail: { z0: -0.585, z1: 0.006, y: 0.0232, halfW: 0.0112 },
      port: { z0: -0.112, z1: -0.038, y0: -0.004, y1: 0.0162, depth: 0.0095 },
      lower: { z0: -0.216, z1: 0.008, yTop: -0.0178, yBot: -0.0365, halfW: 0.0182 },
      magwell: { z0: -0.178, z1: -0.088, yTop: -0.0178, yBot: -0.0745, halfW: 0.0182, halfD: 0.0338, wallT: 0.0045 },
      barrel: {
        muzzleZ: -0.686,
        chamberZ: -0.234,
        chamberR: 0.0172,
        midR: 0.0112,
        thinR: 0.0098,
        gasBlockZ: -0.545,
        fluted: true,
      },
      handguard: {
        z0: -0.242,
        z1: -0.592,
        r: 0.0268,
        facets: 8,
        style: 'mlok',
        slotRows: [1, 2, 3, 5, 6, 7],
        ventRows: [],
      },
      stock: { style: 'precision', z0: 0.006, len: 0.272, tubeR: 0.0178, cheek: true },
      grip: { style: 'ar', z: -0.0485, y: -0.0355, angle: 19 * DEG, len: 0.122, w: 0.0345, d: 0.047 },
      mag: {
        style: 'stanag',
        z: -0.1325,
        yTop: -0.0435,
        len: 0.178,
        w: 0.029,
        d: 0.0575,
        curveR: 0.78,
        witness: 3,
      },
      muzzleDevice: { style: 'thread', len: 0.03, r: 0.0122, ports: 0 },
      sightHeight: 0.0725,
      ironSightHeight: 0.0362,
      wear: 0.42,
      tint: { metal: 0x30322e, polymer: 0x4a4436 },
    },
  },
};

export const WEAPON_IDS = Object.keys(WEAPON_DEFS);

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

export function getWeaponDef(id) {
  if (!id || id === 'none') return null;
  return WEAPON_DEFS[id] || null;
}

/** Linear interpolation through the authored damage/distance curve. */
export function damageAt(def, metres) {
  const c = def?.damage;
  if (!Array.isArray(c) || !c.length) return 25;
  const d = Number.isFinite(metres) ? metres : 0;
  if (d <= c[0].r) return c[0].v;
  for (let i = 1; i < c.length; i++) {
    if (d <= c[i].r) {
      const a = c[i - 1];
      const b = c[i];
      const t = (d - a.r) / Math.max(1e-4, b.r - a.r);
      return a.v + (b.v - a.v) * t;
    }
  }
  return c[c.length - 1].v;
}

export function rpmToInterval(def) {
  const rpm = def?.rpm;
  return Number.isFinite(rpm) && rpm > 0 ? 60 / rpm : 0.1;
}

/**
 * Authored recoil sample for shot `i` (0-based), in radians.
 * Past the end of the pattern it settles into a signed alternating tail so long
 * sprays stay recognisably "this gun" instead of turning into white noise.
 */
export function recoilStep(def, i, rng) {
  const r = def?.recoil;
  if (!r) return { x: 0, y: 0 };
  const unit = r.unit ?? 0.003;
  const pat = r.pattern;
  let h;
  let v;
  if (pat && i < pat.length) {
    h = pat[i][0];
    v = pat[i][1];
  } else {
    const tail = r.tail || { h: 0.8, v: 0.6, jitter: 0.4 };
    const k = i - (pat?.length ?? 0);
    h = tail.h * (k % 2 === 0 ? 1 : -1) * (0.7 + 0.3 * Math.sin(k * 0.9));
    v = tail.v;
  }
  const jitter = r.tail?.jitter ?? 0.4;
  if (typeof rng === 'function') {
    h += (rng() * 2 - 1) * jitter * 0.5;
    v *= 1 + (rng() * 2 - 1) * jitter * 0.22;
  }
  return { x: h * unit, y: v * unit };
}

/**
 * Current cone half-angle.
 * @param {object} def
 * @param {{ads:number, bloom:number, moving:number, airborne:boolean, crouched:boolean}} s
 */
export function spreadOf(def, s = {}) {
  const sp = def?.spread;
  if (!sp) return 0.02;
  const ads = Math.min(1, Math.max(0, s.ads ?? 0));
  const bloom = Math.max(0, s.bloom ?? 0);
  const base = sp.hipBase + (sp.adsBase - sp.hipBase) * ads;
  const max = sp.hipMax + (sp.adsMax - sp.hipMax) * ads;
  let cone = Math.min(max, base + bloom);
  const move = Math.min(1, Math.max(0, s.moving ?? 0));
  const moveMul = 1 + (sp.moveMul - 1) * move * (1 - 0.55 * ads);
  cone *= moveMul;
  if (s.airborne) cone *= sp.jumpMul;
  if (s.crouched) cone *= sp.crouchMul;
  return cone;
}

export default WEAPON_DEFS;
