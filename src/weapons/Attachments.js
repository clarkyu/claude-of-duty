/**
 * Attachments — optics, muzzle devices, underbarrel and magazines.
 * Owner: weapons agent.
 *
 * Every entry changes both the *mesh* (via a builder in ViewmodelBuilder.js) and the
 * *stats* (a multiplier/delta bag folded into the weapon def at equip time). A weapon
 * with no optic falls back to the folding back-up irons, so the sight line always
 * exists and ADS is always exact.
 *
 * Public API:
 *   ATTACHMENTS                       id -> entry
 *   listForSlot(slot, weaponClass)    -> entry[]
 *   resolveLoadout(def, chosen)       -> { optic, muzzle, underbarrel, magazine } ids
 *   applyStats(def, ids)              -> a derived, frozen stat view of the weapon
 *   buildAttachment(ctx, mats, id, def) -> { group, node, sight?, api } | null
 *
 * Slots:  optic | muzzle | underbarrel | magazine
 * Mounts: railTop | muzzle | underbarrel | magazine  (nodes published by buildWeapon)
 */
import { buildRedDot, buildScope, buildIrons, buildMuzzleDevice, buildForegrip } from './ViewmodelBuilder.js';

/* -------------------------------------------------------------------------- */

/**
 * `stats` keys are multiplicative unless prefixed with `+` (additive).
 * Recognised: adsTime, recoilV, recoilH, spreadHip, spreadAds, moveSpeed, adsMove,
 * muzzleVelocity, penetration, damageRange, magSize(+), zoom, sound, bloom.
 */
export const ATTACHMENTS = {
  /* ─────────────────────────────── optics ─────────────────────────────── */
  irons: {
    id: 'irons',
    slot: 'optic',
    name: 'Back-up Irons',
    mount: 'railTop',
    build: (ctx, mats, def) => buildIrons(ctx, mats, { height: def.build.ironSightHeight }),
    stats: { adsTime: 0.9 },
  },
  reddot_kite: {
    id: 'reddot_kite',
    slot: 'optic',
    name: 'Kite RDS',
    mount: 'railTop',
    build: (ctx, mats) => buildRedDot(ctx, mats, { tubeR: 0.0192, glassR: 0.0162, length: 0.088, dotMoa: 2 }),
    stats: { adsTime: 1.02, spreadAds: 0.94 },
  },
  reddot_halo: {
    id: 'reddot_halo',
    slot: 'optic',
    name: 'Halo Reflex',
    mount: 'railTop',
    build: (ctx, mats) =>
      buildRedDot(ctx, mats, { tubeR: 0.0215, glassR: 0.0186, length: 0.074, dotMoa: 3, ring: true, mountH: 0.011 }),
    stats: { adsTime: 0.96, spreadAds: 0.97 },
  },
  scope_lynx4x: {
    id: 'scope_lynx4x',
    slot: 'optic',
    name: 'Lynx 4x',
    mount: 'railTop',
    build: (ctx, mats) => buildScope(ctx, mats, { zoom: 3.4, length: 0.196, objR: 0.0235, ocR: 0.0195 }),
    stats: { adsTime: 1.28, spreadAds: 0.8, zoom: 3.4, moveSpeed: 0.97, adsMove: 0.88 },
  },
  scope_lynx8x: {
    id: 'scope_lynx8x',
    slot: 'optic',
    name: 'Lynx 8x',
    mount: 'railTop',
    build: (ctx, mats) =>
      buildScope(ctx, mats, { zoom: 6.8, length: 0.232, objR: 0.0275, ocR: 0.0205, eyebox: 0.008 }),
    stats: { adsTime: 1.5, spreadAds: 0.7, zoom: 6.8, moveSpeed: 0.94, adsMove: 0.78 },
  },

  /* ─────────────────────────── muzzle devices ─────────────────────────── */
  muzzle_none: { id: 'muzzle_none', slot: 'muzzle', name: 'None', mount: 'muzzle', build: null, stats: {} },
  brake_vortex: {
    id: 'brake_vortex',
    slot: 'muzzle',
    name: 'Vortex Brake',
    mount: 'muzzle',
    build: (ctx, mats, def) =>
      buildMuzzleDevice(ctx, mats, { style: 'brake', len: def.build.muzzleDevice.len, r: def.build.muzzleDevice.r, ports: 3 }),
    stats: { recoilV: 0.82, recoilH: 1.14, adsTime: 1.03 },
  },
  comp_stub: {
    id: 'comp_stub',
    slot: 'muzzle',
    name: 'Stub Compensator',
    mount: 'muzzle',
    build: (ctx, mats, def) =>
      buildMuzzleDevice(ctx, mats, { style: 'comp', len: def.build.muzzleDevice.len, r: def.build.muzzleDevice.r, ports: 4 }),
    stats: { recoilV: 0.9, recoilH: 0.9, spreadHip: 1.05 },
  },
  suppressor_whisper: {
    id: 'suppressor_whisper',
    slot: 'muzzle',
    name: 'Whisper Suppressor',
    mount: 'muzzle',
    build: (ctx, mats, def) =>
      buildMuzzleDevice(ctx, mats, { style: 'suppressor', len: 0.155, r: def.build.muzzleDevice.r * 1.28 }),
    stats: {
      recoilV: 0.9,
      recoilH: 0.94,
      muzzleVelocity: 1.05,
      damageRange: 1.1,
      adsTime: 1.09,
      moveSpeed: 0.98,
      sound: 'suppressed',
    },
  },
  thread_bare: {
    id: 'thread_bare',
    slot: 'muzzle',
    name: 'Bare Thread',
    mount: 'muzzle',
    build: (ctx, mats, def) => buildMuzzleDevice(ctx, mats, { style: 'thread', len: 0.028, r: def.build.muzzleDevice.r }),
    stats: { adsTime: 0.98, recoilV: 1.06 },
  },

  /* ──────────────────────────── underbarrel ───────────────────────────── */
  grip_none: { id: 'grip_none', slot: 'underbarrel', name: 'None', mount: 'underbarrel', build: null, stats: {} },
  grip_vertical: {
    id: 'grip_vertical',
    slot: 'underbarrel',
    name: 'Vertical Grip',
    mount: 'underbarrel',
    build: (ctx, mats) => buildForegrip(ctx, mats, { style: 'vertical' }),
    stats: { recoilV: 0.88, spreadHip: 1.06, adsTime: 1.04 },
  },
  grip_angled: {
    id: 'grip_angled',
    slot: 'underbarrel',
    name: 'Angled Grip',
    mount: 'underbarrel',
    build: (ctx, mats) => buildForegrip(ctx, mats, { style: 'angled' }),
    stats: { recoilH: 0.86, adsTime: 0.94, spreadAds: 1.03 },
  },

  /* ───────────────────────────── magazines ────────────────────────────── */
  mag_std: { id: 'mag_std', slot: 'magazine', name: 'Standard', mount: 'magazine', build: null, stats: {} },
  mag_extended: {
    id: 'mag_extended',
    slot: 'magazine',
    name: 'Extended Mag',
    mount: 'magazine',
    build: null,
    magScale: 1.34,
    stats: { magSize: '+15', reloadTime: 1.12, moveSpeed: 0.98, adsTime: 1.04 },
  },
  mag_light: {
    id: 'mag_light',
    slot: 'magazine',
    name: 'Lightweight Mag',
    mount: 'magazine',
    build: null,
    magScale: 0.82,
    stats: { magSize: '-8', reloadTime: 0.86, adsTime: 0.97, moveSpeed: 1.02 },
  },
  mag_ap: {
    id: 'mag_ap',
    slot: 'magazine',
    name: 'AP Rounds',
    mount: 'magazine',
    build: null,
    stats: { penetration: 1.55, damageRange: 1.15, recoilV: 1.08, muzzleVelocity: 1.06 },
  },
};

export const SLOTS = ['optic', 'muzzle', 'underbarrel', 'magazine'];

export function listForSlot(slot) {
  return Object.values(ATTACHMENTS).filter((a) => a.slot === slot);
}

/** Fill missing slots from the weapon's defaults, mapping 'none' onto the null entry. */
export function resolveLoadout(def, chosen) {
  const base = def?.defaultAttachments || {};
  const pick = chosen || {};
  const out = {};
  for (const slot of SLOTS) {
    let id = pick[slot] ?? base[slot];
    if (id === 'none' || id == null) {
      id = slot === 'optic' ? 'irons' : slot === 'muzzle' ? 'muzzle_none' : slot === 'underbarrel' ? 'grip_none' : 'mag_std';
    }
    if (!ATTACHMENTS[id] || ATTACHMENTS[id].slot !== slot) {
      id = slot === 'optic' ? 'irons' : slot === 'muzzle' ? 'muzzle_none' : slot === 'underbarrel' ? 'grip_none' : 'mag_std';
    }
    out[slot] = id;
  }
  return out;
}

function additive(v) {
  return typeof v === 'string' && (v[0] === '+' || v[0] === '-') ? Number(v) : null;
}

/**
 * Fold every fitted attachment's stat bag into a derived view of the weapon. The
 * source def is never mutated — WeaponSystem keeps this alongside it.
 */
export function applyStats(def, ids) {
  const acc = {
    adsTime: 1,
    recoilV: 1,
    recoilH: 1,
    spreadHip: 1,
    spreadAds: 1,
    bloom: 1,
    moveSpeed: 1,
    adsMove: 1,
    muzzleVelocity: 1,
    penetration: 1,
    damageRange: 1,
    reloadTime: 1,
    zoom: 1,
    magDelta: 0,
    sound: null,
  };
  for (const slot of SLOTS) {
    const a = ATTACHMENTS[ids?.[slot]];
    if (!a?.stats) continue;
    for (const [k, v] of Object.entries(a.stats)) {
      if (k === 'magSize') {
        const add = additive(v);
        if (add !== null) acc.magDelta += add;
        continue;
      }
      if (k === 'sound') {
        acc.sound = v;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(acc, k) && Number.isFinite(v)) acc[k] *= v;
    }
  }
  const magSize = Math.max(1, Math.round((def?.magSize ?? 30) + acc.magDelta));
  const rl = def?.reload || { tactical: 2.1, empty: 2.9 };
  return {
    mods: acc,
    magSize,
    adsTime: (def?.adsTime ?? 0.25) * acc.adsTime,
    adsOutTime: (def?.adsOutTime ?? 0.2) * Math.min(1.15, acc.adsTime),
    reloadTactical: rl.tactical * acc.reloadTime,
    reloadEmpty: rl.empty * acc.reloadTime,
    moveSpeedScale: (def?.moveSpeedScale ?? 1) * acc.moveSpeed,
    adsMoveScale: (def?.adsMoveScale ?? 0.5) * acc.adsMove,
    muzzleVelocity: (def?.muzzleVelocity ?? 800) * acc.muzzleVelocity,
    penetration: (def?.penetration ?? 0.6) * acc.penetration,
    damageRangeScale: acc.damageRange,
    recoilV: acc.recoilV,
    recoilH: acc.recoilH,
    spreadHip: acc.spreadHip,
    spreadAds: acc.spreadAds,
    zoom: Math.max(1, (def?.zoom ?? 1) * acc.zoom),
    suppressed: acc.sound === 'suppressed',
  };
}

/**
 * Instantiate one attachment.
 * @returns {{id:string, slot:string, mount:string, group:import('three').Object3D,
 *            sight?:import('three').Object3D, api:object}|null}
 */
export function buildAttachment(ctx, mats, id, def) {
  const a = ATTACHMENTS[id];
  if (!a) return null;
  if (typeof a.build !== 'function') return { id, slot: a.slot, mount: a.mount, group: null, api: null, entry: a };
  let res = null;
  try {
    res = a.build(ctx, mats, def);
  } catch (err) {
    console.warn(`[weapons] attachment "${id}" failed to build`, err);
    return null;
  }
  if (!res?.group) return null;
  res.group.name = `att:${id}`;
  return { id, slot: a.slot, mount: a.mount, group: res.group, sight: res.sight || null, api: res, entry: a };
}

export default ATTACHMENTS;
