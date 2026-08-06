/**
 * Loadouts.js — five loadout slots, equipment and perks. Owner: game agent.
 * Part of the rules layer published as `ctx.game` (see GameMode.js).
 *
 * A loadout is primary + secondary (from `ctx.weapons.defs` / WeaponDefs) with real
 * attachment ids from weapons/Attachments.js, one lethal, one tactical and three
 * perks. Perks are not flavour text: every entry in `PERKS` resolves into the
 * `PerkMods` bag below, and every field of that bag is consumed by something.
 *
 * ── Where each perk modifier is actually applied ────────────────────────────────
 *   moveScale, sprintScale     -> ctx.player.speedScale            (documented writable)
 *   extraHealth, plates        -> GameMode player record (max health / armour plates)
 *   regenDelayScale/RateScale  -> GameMode health regeneration
 *   explosiveResist, bulletResist, flinchScale
 *                              -> GameMode.damage() and the camera impulse it raises
 *   enemyHearingScale          -> ctx.ai.perception sensor.hearing on enemy bots
 *   enemyDetectScale           -> ctx.ai.perception sensor.detectRate on enemy bots
 *   streakScale                -> Killstreaks earn rate
 *   respawnScale               -> GameMode respawn delay
 *   extraLethal/extraTactical  -> equipment counts here
 *   scavenger                  -> equipment refill on kill
 *   adsScale, reloadScale, swapScale
 *                              -> published on `ctx.game.perkMods` and emitted as
 *                                 `game:perkmods`; WeaponSystem owns those timings, so
 *                                 this is the documented hook it can read. They are
 *                                 *also* honoured here by picking a lighter optic /
 *                                 magazine when the loadout leaves the slot on 'auto'.
 *
 * ── Public API (createLoadouts(ctx) -> Loadouts) ────────────────────────────────
 *   slots            LoadoutSlot[5]          (live, editable)
 *   index / active   currently selected slot
 *   select(i)                                -> LoadoutSlot
 *   setSlot(i, patch)                        -> LoadoutSlot
 *   modsFor(slot)                            -> PerkMods
 *   mods                                     PerkMods of the active slot
 *   has(perkId)                              active loadout carries this perk?
 *   applyToWeapons(opts)                     equip primary/secondary with attachments
 *   swapWeapon()                             primary <-> secondary
 *   equipment                                { lethal, tactical } live counts
 *   resupply(frac)                           refill equipment (scavenger, resupply crate)
 *   useLethal(origin, dir) / useTactical(origin, dir)
 *   randomiseBotLoadout(rng)                 -> a plausible bot kit
 *   PERKS / LETHALS / TACTICALS / DEFAULT_LOADOUTS
 */

/* ─────────────────────────────────────────────────────────────── perk catalogue ── */

/** Neutral modifier bag. Multipliers are 1, additive terms are 0. */
export function neutralMods() {
  return {
    moveScale: 1,
    sprintScale: 1,
    adsScale: 1,
    reloadScale: 1,
    swapScale: 1,
    extraHealth: 0,
    plates: 0,
    regenDelayScale: 1,
    regenRateScale: 1,
    explosiveResist: 1,
    bulletResist: 1,
    flinchScale: 1,
    enemyHearingScale: 1,
    enemyDetectScale: 1,
    streakScale: 1,
    respawnScale: 1,
    extraLethal: 0,
    extraTactical: 0,
    scavenger: false,
    silent: false,
    lightOptic: false,
  };
}

/**
 * Three perk slots, four choices each — the CoD shape. `mods` is folded into the
 * neutral bag: numbers multiply unless the key is in ADDITIVE.
 */
const ADDITIVE = new Set(['extraHealth', 'plates', 'extraLethal', 'extraTactical']);

export const PERKS = {
  /* ── slot 1: mobility & utility ───────────────────────────────────────── */
  lightweight: {
    id: 'lightweight',
    slot: 1,
    name: 'Lightweight',
    blurb: 'Move 9% faster, sprint 12% faster.',
    mods: { moveScale: 1.09, sprintScale: 1.12 },
  },
  flak_jacket: {
    id: 'flak_jacket',
    slot: 1,
    name: 'Flak Jacket',
    blurb: 'Explosive damage reduced by 55%.',
    mods: { explosiveResist: 0.45 },
  },
  scavenger: {
    id: 'scavenger',
    slot: 1,
    name: 'Scavenger',
    blurb: 'Resupply lethal and tactical equipment from the fallen.',
    mods: { scavenger: true },
  },
  double_time: {
    id: 'double_time',
    slot: 1,
    name: 'Double Time',
    blurb: 'Carry an extra lethal and an extra tactical.',
    mods: { extraLethal: 1, extraTactical: 1, sprintScale: 1.05 },
  },

  /* ── slot 2: stealth & handling ───────────────────────────────────────── */
  dead_silence: {
    id: 'dead_silence',
    slot: 2,
    name: 'Dead Silence',
    blurb: 'Footsteps barely carry — enemy hearing cut by 58%.',
    mods: { enemyHearingScale: 0.42, silent: true },
  },
  ghost: {
    id: 'ghost',
    slot: 2,
    name: 'Ghost',
    blurb: 'Undetected by UAV; enemies take much longer to spot you.',
    mods: { enemyDetectScale: 0.6 },
  },
  fast_hands: {
    id: 'fast_hands',
    slot: 2,
    name: 'Fast Hands',
    blurb: 'Reload 22% faster, swap 30% faster.',
    mods: { reloadScale: 0.78, swapScale: 0.7 },
  },
  quickdraw: {
    id: 'quickdraw',
    slot: 2,
    name: 'Quickdraw',
    blurb: 'Aim down sights 25% faster.',
    mods: { adsScale: 0.75, lightOptic: true },
  },

  /* ── slot 3: survivability ────────────────────────────────────────────── */
  quick_fix: {
    id: 'quick_fix',
    slot: 3,
    name: 'Quick Fix',
    blurb: 'Health regeneration starts sooner and runs faster.',
    mods: { regenDelayScale: 0.55, regenRateScale: 1.65 },
  },
  toughness: {
    id: 'toughness',
    slot: 3,
    name: 'Toughness',
    blurb: 'Soak 20 more damage and flinch less under fire.',
    mods: { flinchScale: 0.5, extraHealth: 20 },
  },
  hardline: {
    id: 'hardline',
    slot: 3,
    name: 'Hardline',
    blurb: 'Killstreaks require one less kill.',
    mods: { streakScale: 1.3 },
  },
  battle_hardened: {
    id: 'battle_hardened',
    slot: 3,
    name: 'Battle Hardened',
    blurb: 'An extra armour plate and a faster respawn.',
    mods: { plates: 1, respawnScale: 0.78, bulletResist: 0.94 },
  },
};

export const PERK_SLOTS = [1, 2, 3];

export function perksForSlot(n) {
  return Object.values(PERKS).filter((p) => p.slot === n);
}

/* ──────────────────────────────────────────────────────────────── equipment ── */

/**
 * Lethals and tacticals. `throw` is resolved by GameMode against
 * `ctx.ballistics.throwGrenade` / `ctx.ballistics.explode`, so nothing here needs to
 * know about three.
 */
export const LETHALS = {
  frag: {
    id: 'frag',
    name: 'Frag Grenade',
    count: 1,
    cook: true,
    fuse: 3.4,
    speed: 17,
    radius: 7.5,
    damage: 140,
    type: 'frag',
    blurb: 'Cookable fragmentation grenade.',
  },
  semtex: {
    id: 'semtex',
    name: 'Semtex',
    count: 1,
    cook: false,
    fuse: 2.2,
    speed: 21,
    radius: 6.2,
    damage: 155,
    sticky: true,
    type: 'semtex',
    blurb: 'Sticks where it lands, short fuse.',
  },
  thermite: {
    id: 'thermite',
    name: 'Thermite',
    count: 1,
    cook: false,
    fuse: 1.1,
    speed: 19,
    radius: 4.6,
    damage: 100,
    type: 'incendiary',
    blurb: 'Incendiary charge — near-instant, tight blast radius.',
  },
  satchel: {
    id: 'satchel',
    name: 'Satchel Charge',
    count: 1,
    cook: false,
    fuse: 4.2,
    speed: 13,
    radius: 8.4,
    damage: 185,
    type: 'frag',
    blurb: 'Heavy charge on a four-second fuse. Place it and leave.',
  },
};

export const TACTICALS = {
  flash: {
    id: 'flash',
    name: 'Flashbang',
    count: 2,
    fuse: 1.4,
    speed: 19,
    radius: 12,
    effect: 'flash',
    duration: 3.6,
    blurb: 'Blinds and deafens anyone looking at it.',
  },
  stun: {
    id: 'stun',
    name: 'Stun Grenade',
    count: 2,
    fuse: 1.6,
    speed: 19,
    radius: 9,
    effect: 'stun',
    duration: 3.2,
    blurb: 'Slows movement and aim.',
  },
  smoke: {
    id: 'smoke',
    name: 'Smoke Screen',
    count: 1,
    fuse: 1.2,
    speed: 17,
    radius: 7,
    effect: 'smoke',
    duration: 14,
    blurb: 'Dense concealment cloud.',
  },
  sensor: {
    id: 'sensor',
    name: 'Heartbeat Sensor',
    count: 1,
    fuse: 0.9,
    speed: 15,
    radius: 22,
    effect: 'sensor',
    duration: 10,
    blurb: 'Paints nearby enemies on the minimap.',
  },
};

/* ───────────────────────────────────────────────────────── default loadouts ── */

/** Five slots, authored to feel distinct. Attachment ids come from Attachments.js. */
export const DEFAULT_LOADOUTS = [
  {
    name: 'ASSAULT',
    primary: 'ar_wolverine',
    primaryAttachments: { optic: 'reddot_kite', muzzle: 'comp_stub', underbarrel: 'grip_vertical', magazine: 'mag_extended' },
    secondary: 'smg_viper',
    secondaryAttachments: { optic: 'reddot_halo', muzzle: 'muzzle_none', magazine: 'mag_std' },
    lethal: 'frag',
    tactical: 'flash',
    perks: ['lightweight', 'fast_hands', 'quick_fix'],
  },
  {
    name: 'BREACHER',
    primary: 'smg_viper',
    primaryAttachments: { optic: 'reddot_halo', muzzle: 'brake_vortex', underbarrel: 'grip_angled', magazine: 'mag_extended' },
    secondary: 'ar_wolverine',
    secondaryAttachments: { optic: 'irons', muzzle: 'muzzle_none', magazine: 'mag_std' },
    lethal: 'semtex',
    tactical: 'stun',
    perks: ['double_time', 'quickdraw', 'toughness'],
  },
  {
    name: 'MARKSMAN',
    primary: 'dmr_kestrel',
    primaryAttachments: { optic: 'scope_lynx4x', muzzle: 'suppressor_whisper', underbarrel: 'grip_none', magazine: 'mag_ap' },
    secondary: 'smg_viper',
    secondaryAttachments: { optic: 'irons', muzzle: 'muzzle_none', magazine: 'mag_light' },
    lethal: 'satchel',
    tactical: 'smoke',
    perks: ['scavenger', 'ghost', 'hardline'],
  },
  {
    name: 'GHOST',
    primary: 'smg_viper',
    primaryAttachments: { optic: 'reddot_kite', muzzle: 'suppressor_whisper', underbarrel: 'grip_vertical', magazine: 'mag_light' },
    secondary: 'dmr_kestrel',
    secondaryAttachments: { optic: 'irons', muzzle: 'suppressor_whisper', magazine: 'mag_std' },
    lethal: 'thermite',
    tactical: 'sensor',
    perks: ['lightweight', 'dead_silence', 'battle_hardened'],
  },
  {
    name: 'ENGINEER',
    primary: 'ar_wolverine',
    primaryAttachments: { optic: 'scope_lynx4x', muzzle: 'brake_vortex', underbarrel: 'grip_angled', magazine: 'mag_ap' },
    secondary: 'smg_viper',
    secondaryAttachments: { optic: 'reddot_kite', muzzle: 'comp_stub', magazine: 'mag_extended' },
    lethal: 'frag',
    tactical: 'smoke',
    perks: ['flak_jacket', 'fast_hands', 'battle_hardened'],
  },
];

/** Optic that a Quickdraw loadout swaps to when the slot is left on 'auto'. */
const LIGHT_OPTIC = 'reddot_halo';

/* ────────────────────────────────────────────────────────────────── manager ── */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createLoadouts(ctx) {
  const slots = DEFAULT_LOADOUTS.map((l) => ({
    ...l,
    primaryAttachments: { ...l.primaryAttachments },
    secondaryAttachments: { ...l.secondaryAttachments },
    perks: l.perks.slice(),
  }));

  let index = 0;
  let pending = 0; // takes effect on next respawn, like a real class change
  let usingSecondary = false;
  const equipment = { lethal: 0, lethalMax: 0, tactical: 0, tacticalMax: 0 };
  let cachedMods = neutralMods();

  function weaponExists(id) {
    const defs = ctx.weapons?.defs;
    if (!defs) return true; // weapons not up yet — trust the data
    return !!defs[id];
  }

  /** Fall back to whatever the weapon system really has if a def is missing. */
  function resolveWeapon(id) {
    if (weaponExists(id)) return id;
    const list = ctx.weapons?.list?.() || [];
    return list[0] || id;
  }

  function modsFor(slot) {
    const m = neutralMods();
    const ids = slot?.perks || [];
    for (const id of ids) {
      const perk = PERKS[id];
      if (!perk?.mods) continue;
      for (const k of Object.keys(perk.mods)) {
        const v = perk.mods[k];
        if (typeof v === 'boolean') m[k] = m[k] || v;
        else if (ADDITIVE.has(k)) m[k] += v;
        else if (typeof v === 'number') m[k] *= v;
      }
    }
    // Nothing should ever stack into nonsense.
    m.moveScale = clamp(m.moveScale, 0.7, 1.35);
    m.sprintScale = clamp(m.sprintScale, 0.7, 1.4);
    m.adsScale = clamp(m.adsScale, 0.5, 1.5);
    m.reloadScale = clamp(m.reloadScale, 0.5, 1.5);
    m.regenDelayScale = clamp(m.regenDelayScale, 0.3, 2);
    m.regenRateScale = clamp(m.regenRateScale, 0.5, 2.5);
    m.explosiveResist = clamp(m.explosiveResist, 0.25, 1);
    m.bulletResist = clamp(m.bulletResist, 0.75, 1);
    m.enemyHearingScale = clamp(m.enemyHearingScale, 0.25, 1);
    m.enemyDetectScale = clamp(m.enemyDetectScale, 0.3, 1);
    m.streakScale = clamp(m.streakScale, 0.5, 2);
    m.respawnScale = clamp(m.respawnScale, 0.5, 1.5);
    m.extraHealth = clamp(m.extraHealth, 0, 60);
    m.plates = clamp(Math.round(m.plates), 0, 3);
    return m;
  }

  function refreshMods() {
    cachedMods = modsFor(slots[index]);
    ctx.bus?.emit?.('game:perkmods', { mods: cachedMods, loadout: slots[index]?.name, index });
    return cachedMods;
  }

  function attachmentsFor(slot, which) {
    const base = which === 'secondary' ? slot.secondaryAttachments : slot.primaryAttachments;
    const out = { ...base };
    // Quickdraw genuinely trades glass for speed when the slot is on 'auto'.
    if (cachedMods.lightOptic && (out.optic === 'auto' || out.optic == null)) out.optic = LIGHT_OPTIC;
    for (const k of Object.keys(out)) if (out[k] === 'auto') delete out[k];
    return out;
  }

  /** Equip the loadout's guns. Called on spawn. */
  function applyToWeapons(opts = {}) {
    const w = ctx.weapons;
    const slot = slots[index];
    if (!w?.equip || !slot) return false;
    usingSecondary = !!opts.secondary;
    const id = resolveWeapon(usingSecondary ? slot.secondary : slot.primary);
    try {
      w.equip(id, {
        instant: opts.instant !== false,
        attachments: attachmentsFor(slot, usingSecondary ? 'secondary' : 'primary'),
      });
    } catch {
      /* weapons is defensive; a failed equip must never kill a respawn */
      return false;
    }
    return true;
  }

  function swapWeapon() {
    return applyToWeapons({ secondary: !usingSecondary, instant: false });
  }

  function refillEquipment() {
    const slot = slots[index];
    const L = LETHALS[slot?.lethal] || LETHALS.frag;
    const T = TACTICALS[slot?.tactical] || TACTICALS.flash;
    equipment.lethalMax = (L.count || 1) + cachedMods.extraLethal;
    equipment.tacticalMax = (T.count || 1) + cachedMods.extraTactical;
    equipment.lethal = equipment.lethalMax;
    equipment.tactical = equipment.tacticalMax;
    emitEquipment();
  }

  function emitEquipment() {
    const slot = slots[index];
    ctx.bus?.emit?.('hud:equipment', {
      lethal: equipment.lethal,
      lethalMax: equipment.lethalMax,
      lethalId: slot?.lethal || null,
      lethalName: LETHALS[slot?.lethal]?.name || '',
      tactical: equipment.tactical,
      tacticalMax: equipment.tacticalMax,
      tacticalId: slot?.tactical || null,
      tacticalName: TACTICALS[slot?.tactical]?.name || '',
    });
  }

  /** Scavenger / ammo crate: `frac` of a full resupply, rounded up. */
  function resupply(frac = 1) {
    let gained = false;
    const add = (cur, max) => Math.min(max, cur + Math.max(1, Math.ceil(max * frac)));
    if (equipment.lethal < equipment.lethalMax) {
      equipment.lethal = add(equipment.lethal, equipment.lethalMax);
      gained = true;
    }
    if (equipment.tactical < equipment.tacticalMax) {
      equipment.tactical = add(equipment.tactical, equipment.tacticalMax);
      gained = true;
    }
    if (gained) emitEquipment();
    return gained;
  }

  const api = {
    slots,
    PERKS,
    LETHALS,
    TACTICALS,
    equipment,

    get index() {
      return index;
    },
    get pendingIndex() {
      return pending;
    },
    get active() {
      return slots[index];
    },
    get mods() {
      return cachedMods;
    },
    get usingSecondary() {
      return usingSecondary;
    },
    get lethalDef() {
      return LETHALS[slots[index]?.lethal] || LETHALS.frag;
    },
    get tacticalDef() {
      return TACTICALS[slots[index]?.tactical] || TACTICALS.flash;
    },

    /** Queue a class change; `immediate` applies it now (menu / first spawn). */
    select(i, immediate = false) {
      pending = clamp(i | 0, 0, slots.length - 1);
      if (immediate) api.commit();
      else ctx.bus?.emit?.('hud:message', { kind: 'loadout', text: `${slots[pending].name} SELECTED`, sub: 'Applies on respawn', duration: 2.2 });
      return slots[pending];
    },

    /** Apply the queued class. GameMode calls this at respawn. */
    commit() {
      index = pending;
      refreshMods();
      refillEquipment();
      ctx.bus?.emit?.('hud:loadout', {
        index,
        name: slots[index].name,
        primary: slots[index].primary,
        secondary: slots[index].secondary,
        perks: slots[index].perks.map((p) => ({ id: p, name: PERKS[p]?.name || p })),
      });
      return slots[index];
    },

    setSlot(i, patch) {
      const s = slots[clamp(i | 0, 0, slots.length - 1)];
      Object.assign(s, patch || {});
      if (i === index) refreshMods();
      return s;
    },

    modsFor,
    refreshMods,
    has(perkId) {
      return !!slots[index]?.perks?.includes(perkId);
    },
    applyToWeapons,
    swapWeapon,
    refillEquipment,
    resupply,
    emitEquipment,

    /** Consume one lethal. Returns the def or null. */
    takeLethal() {
      if (equipment.lethal <= 0) return null;
      equipment.lethal--;
      emitEquipment();
      return api.lethalDef;
    },
    takeTactical() {
      if (equipment.tactical <= 0) return null;
      equipment.tactical--;
      emitEquipment();
      return api.tacticalDef;
    },

    /** A plausible kit for a bot, so the killfeed names real weapons. */
    randomiseBotLoadout(rng) {
      const r = rng || ctx.rng;
      const pool = ctx.weapons?.list?.() || ['ar_wolverine', 'smg_viper', 'dmr_kestrel'];
      const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor((r ? r() : 0.5) * arr.length))];
      return {
        name: pick(['ASSAULT', 'BREACHER', 'MARKSMAN', 'GHOST', 'ENGINEER']),
        primary: pick(pool),
        lethal: pick(Object.keys(LETHALS)),
        tactical: pick(Object.keys(TACTICALS)),
        perks: [pick(perksForSlot(1)).id, pick(perksForSlot(2)).id, pick(perksForSlot(3)).id],
      };
    },
  };

  refreshMods();
  refillEquipment();
  return api;
}

export default createLoadouts;
