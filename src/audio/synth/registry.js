/**
 * registry.js — the sound catalogue. Owner: audio agent.
 *
 * Every id another system can pass to `ctx.audio.play()` resolves here. A
 * definition is data plus a `build(S, params)` function; AudioEngine owns the
 * routing, the spatial chain and the voice lifetime, so a definition never
 * touches the graph outside `S.out` / `S.tailIn`.
 *
 * Definition fields
 *   bus         'weapons' | 'impacts' | 'foley' | 'ambience' | 'voice' | 'ui'
 *   spatial     false for 2D sounds (UI, the local player's own body)
 *   occlude     run the listener->source occlusion probe (default: spatial)
 *   tail        build the slap-back/echo network for this voice
 *   send        default reverb send (a definition can override it at build time)
 *   priority    0..10, used when the voice cap is hit
 *   ref/max     distance model tuning, metres
 *   rolloff     distance rolloff factor
 *   cooldown    minimum seconds between two plays of this id (anti-machine-gun)
 *   propagate   apply speed-of-sound arrival delay (default true for spatial)
 *
 * Unknown ids are resolved by prefix (`impact_*`, `step_*`, `pen_*`, `ui_*`)
 * rather than dropped, so a system can invent `impact_terracotta` and still get
 * a plausible sound.
 */
import * as W from './Weapons.js';
import * as I from './Impacts.js';
import * as F from './Foley.js';
import * as X from './Explosions.js';
import * as A from './Ambience.js';
import * as U from './UI.js';

const SURFACES = [
  'concrete', 'metal', 'wood', 'dirt', 'sand', 'grass', 'glass', 'water',
  'fabric', 'flesh', 'rubber', 'plaster', 'ceramic', 'foliage', 'snow',
];
/** Extra material names SurfaceDefs emits that are not §5 tags. */
const EXTRA_IMPACTS = ['asphalt', 'brick', 'metal_thin', 'gravel', 'sandbag', 'rubble', 'marble', 'tile', 'stone'];
const EXTRA_STEPS = ['asphalt', 'gravel', 'rubble', 'shingle', 'marble', 'carpet', 'metal_thin', 'tile', 'mud'];

const def = (o) => ({
  bus: 'impacts',
  spatial: true,
  occlude: true,
  tail: false,
  send: 0.4,
  priority: 4,
  ref: 3,
  max: 280,
  rolloff: 1.05,
  cooldown: 0,
  ...o,
});

/** @returns {Map<string, object>} */
export function buildRegistry() {
  const R = new Map();
  const add = (id, o) => R.set(id, def({ id, ...o }));

  /* ── weapons ─────────────────────────────────────────────────────────────── */
  const fireDef = {
    bus: 'weapons',
    tail: true,
    send: 0.55,
    priority: 9,
    ref: 6,
    max: 400,
    rolloff: 0.85,
    build: W.weaponFire,
  };
  add('weapon_fire', fireDef);
  for (const c of ['ar', 'smg', 'dmr', 'sniper', 'lmg', 'shotgun', 'pistol']) {
    add(`${c}_fire`, { ...fireDef, weaponClass: c });
    add(`${c}_tail`, {
      bus: 'weapons', tail: true, send: 1.4, priority: 5, ref: 8, max: 400, rolloff: 0.8,
      weaponClass: c, build: W.weaponTail,
    });
  }
  add('weapon_suppressed', { ...fireDef, send: 0.3, suppressed: true, max: 160, rolloff: 1.4 });
  add('weapon_dry', { bus: 'weapons', spatial: false, send: 0.12, priority: 6, build: W.dryFire });
  add('mag_out', { bus: 'weapons', spatial: false, send: 0.18, priority: 5, build: W.magOut });
  add('mag_in', { bus: 'weapons', spatial: false, send: 0.18, priority: 5, build: W.magIn });
  add('bolt_release', { bus: 'weapons', spatial: false, send: 0.18, priority: 5, build: W.boltRelease });
  add('charging_handle', { bus: 'weapons', spatial: false, send: 0.18, priority: 5, build: W.chargingHandle });
  add('weapon_swap', { bus: 'weapons', spatial: false, send: 0.15, priority: 4, build: W.weaponSwap });
  add('weapon_empty', { bus: 'weapons', spatial: false, send: 0.12, priority: 6, build: W.dryFire });

  /* ── impacts ─────────────────────────────────────────────────────────────── */
  const impactDef = { bus: 'impacts', send: 0.5, priority: 6, ref: 2.5, max: 180, build: I.bulletImpact };
  add('impact', impactDef);
  for (const s of SURFACES.concat(EXTRA_IMPACTS)) add(`impact_${s}`, { ...impactDef, surface: s });
  const penDef = { bus: 'impacts', send: 0.55, priority: 5, ref: 2.5, max: 140, build: I.penetration };
  add('pen', penDef);
  for (const s of SURFACES.concat(['soft'])) add(`pen_${s}`, { ...penDef, surface: s === 'soft' ? 'dirt' : s });
  add('ricochet', { bus: 'impacts', send: 0.85, priority: 6, ref: 3, max: 220, build: I.ricochet });
  for (const s of ['concrete', 'metal', 'stone', 'ceramic']) {
    add(`ricochet_${s}`, { bus: 'impacts', send: 0.85, priority: 6, ref: 3, max: 220, surface: s, build: I.ricochet });
  }
  add('flyby', {
    bus: 'impacts', send: 0.4, priority: 8, occlude: false, propagate: false,
    ref: 1.2, max: 40, rolloff: 1.6, build: I.flyby,
  });
  add('bullet_whiz', { bus: 'impacts', send: 0.4, priority: 8, occlude: false, propagate: false, ref: 1.2, max: 40, rolloff: 1.6, build: I.flyby });
  add('brass_bounce', {
    bus: 'foley', send: 0.5, priority: 2, ref: 1.5, max: 30, rolloff: 1.6,
    cooldown: 0.02, build: I.shellCasing,
  });
  add('shell_casing', { bus: 'foley', send: 0.5, priority: 2, ref: 1.5, max: 30, rolloff: 1.6, build: I.shellCasing });

  /* ── destruction ─────────────────────────────────────────────────────────── */
  for (const id of I.BREAK_IDS) {
    add(id, { bus: 'impacts', send: 0.6, priority: 7, ref: 3.5, max: 220, rolloff: 0.95, build: I.breakup });
  }

  /* ── foley ───────────────────────────────────────────────────────────────── */
  const stepDef = { bus: 'foley', send: 0.45, priority: 3, ref: 2, max: 60, rolloff: 1.5, build: F.footstep };
  add('footstep', stepDef);
  add('step', stepDef);
  for (const s of SURFACES.concat(EXTRA_STEPS)) add(`step_${s}`, { ...stepDef, surface: s });
  add('land', { bus: 'foley', send: 0.5, priority: 5, ref: 2, max: 70, rolloff: 1.4, build: F.land });
  add('jump', { bus: 'foley', send: 0.35, priority: 3, ref: 2, max: 40, rolloff: 1.6, build: F.jump });
  add('slide', { bus: 'foley', send: 0.5, priority: 4, ref: 2, max: 55, rolloff: 1.4, build: F.slide });
  add('mantle', { bus: 'foley', send: 0.4, priority: 4, ref: 2, max: 45, rolloff: 1.5, build: F.mantle });
  add('cloth', { bus: 'foley', send: 0.3, priority: 2, ref: 1.5, max: 25, rolloff: 1.8, cooldown: 0.09, build: F.cloth });
  add('gear', { bus: 'foley', send: 0.3, priority: 2, ref: 1.5, max: 25, rolloff: 1.8, cooldown: 0.09, build: F.cloth });

  /* ── voice / bodies ──────────────────────────────────────────────────────── */
  add('hurt', { bus: 'voice', send: 0.5, priority: 7, ref: 3, max: 90, build: F.hurt });
  add('pain', { bus: 'voice', send: 0.5, priority: 7, ref: 3, max: 90, build: F.hurt });
  add('death', { bus: 'voice', send: 0.6, priority: 7, ref: 3, max: 110, build: F.death });
  add('body_fall', { bus: 'foley', send: 0.6, priority: 5, ref: 2.5, max: 80, build: F.land });

  /* ── ordnance ────────────────────────────────────────────────────────────── */
  add('explosion', {
    bus: 'weapons', tail: true, send: 1.4, priority: 10, ref: 10, max: 600, rolloff: 0.7,
    build: X.explosion,
  });
  add('grenade_explode', { bus: 'weapons', tail: true, send: 1.4, priority: 10, ref: 10, max: 600, rolloff: 0.7, build: X.explosion });
  add('distant_explosion', {
    bus: 'ambience', tail: true, send: 1.8, priority: 3, occlude: false, ref: 40, max: 900,
    rolloff: 0.5, build: X.explosion, params: { radius: 12, distant: true },
  });
  add('grenade_throw', { bus: 'foley', send: 0.3, priority: 4, ref: 2, max: 40, build: X.grenadeThrow });
  add('grenade_bounce', { bus: 'impacts', send: 0.6, priority: 4, ref: 2, max: 60, cooldown: 0.03, build: X.grenadeBounce });
  add('whoosh', { bus: 'foley', send: 0.4, priority: 3, ref: 2, max: 50, build: X.whoosh });
  // Weather already queues thunder behind its own speed-of-sound delay, so we
  // must not add a second one.
  add('thunder', {
    bus: 'ambience', tail: true, send: 1.2, priority: 8, occlude: false, propagate: false,
    ref: 60, max: 1200, rolloff: 0.35, build: X.thunder,
  });
  add('thunder_distant', {
    bus: 'ambience', tail: true, send: 1.7, priority: 6, occlude: false, propagate: false,
    ref: 90, max: 1600, rolloff: 0.3, build: X.thunder, params: { distant: true },
  });

  /* ── ambience one-shots ──────────────────────────────────────────────────── */
  add('bird', { bus: 'ambience', send: 0.8, priority: 1, occlude: false, ref: 8, max: 90, build: A.bird });
  add('creak', { bus: 'ambience', send: 0.9, priority: 1, ref: 5, max: 60, build: A.creak });
  add('dog', { bus: 'ambience', send: 1.4, priority: 1, occlude: false, ref: 25, max: 300, rolloff: 0.6, build: A.dog });
  add('distant_vehicle', {
    bus: 'ambience', send: 1.2, priority: 1, occlude: false, ref: 40, max: 400, rolloff: 0.5,
    build: A.distantVehicle,
  });
  add('distant_gunfire', {
    bus: 'ambience', tail: true, send: 1.9, priority: 2, occlude: false, ref: 50, max: 1000,
    rolloff: 0.4, build: W.weaponFire, params: { distant: true },
  });

  /* ── UI ──────────────────────────────────────────────────────────────────── */
  const ui = (id, build, extra) => add(id, { bus: 'ui', spatial: false, occlude: false, send: 0, priority: 7, build, ...extra });
  ui('hitmarker', U.hitmarker);
  ui('hitmarker_kill', U.hitmarker, { params: { lethal: true } });
  ui('hitmarker_head', U.hitmarker, { params: { headshot: true } });
  ui('ui_click', U.uiClick);
  ui('ui_select', U.uiClick);
  ui('ui_hover', U.uiHover, { cooldown: 0.04 });
  ui('ui_back', U.uiBack);
  ui('ui_error', U.uiError);
  ui('notify', U.notify);
  ui('score', U.notify);
  ui('ammo_low', U.ammoLow, { cooldown: 0.05 });
  ui('heartbeat', U.heartbeat);
  ui('beep', U.beep);

  return R;
}

/**
 * Resolve an id that is not literally in the registry.
 * @param {Map} R
 * @param {string} id
 * @returns {object|null}
 */
export function resolveId(R, id) {
  if (!id) return null;
  const s = String(id);
  const direct = R.get(s);
  if (direct) return direct;
  const us = s.indexOf('_');
  const prefix = us > 0 ? s.slice(0, us) : s;
  const rest = us > 0 ? s.slice(us + 1) : '';
  switch (prefix) {
    case 'impact': {
      // impact_<anything>: pick the closest surface we do know.
      const near = SURFACES.find((t) => rest.includes(t));
      return R.get(`impact_${near || 'concrete'}`) || R.get('impact');
    }
    case 'step':
    case 'footstep': {
      const near = SURFACES.concat(EXTRA_STEPS).find((t) => rest.includes(t));
      return R.get(`step_${near || 'concrete'}`) || R.get('step');
    }
    case 'pen': {
      const near = SURFACES.find((t) => rest.includes(t));
      return R.get(`pen_${near || 'concrete'}`) || R.get('pen');
    }
    case 'ricochet':
      return R.get('ricochet');
    case 'break':
    case 'shatter':
      return R.get(rest.includes('glass') ? 'glass_shatter' : 'concrete_break');
    case 'ui':
    case 'menu':
      return R.get('ui_click');
    case 'weapon':
    case 'gun':
      return R.get('weapon_fire');
    case 'thunder':
      return R.get('thunder');
    default:
      break;
  }
  // `<material>_break` / `_shatter` / `_tear` / `_crush` from Destruction.
  if (/_(break|shatter|tear|crush|crack|burst)$/.test(s)) {
    if (s.includes('glass')) return R.get('glass_shatter');
    if (s.includes('metal') || s.includes('steel')) return R.get('metal_tear');
    if (s.includes('ceramic') || s.includes('pot') || s.includes('tile')) return R.get('ceramic_break');
    if (s.includes('plaster') || s.includes('drywall')) return R.get('plaster_break');
    if (s.includes('concrete') || s.includes('stone') || s.includes('brick')) return R.get('concrete_break');
    if (s.includes('plastic')) return R.get('plastic_break');
    if (s.includes('fabric') || s.includes('cloth') || s.includes('tarp')) return R.get('fabric_tear');
    if (s.includes('card') || s.includes('paper')) return R.get('cardboard_crush');
    return R.get('wood_break');
  }
  // Last resort: anything with a surface-ish word in it becomes an impact.
  const near = SURFACES.find((t) => s.includes(t));
  if (near) return R.get(`impact_${near}`);
  return null;
}

export { SURFACES as REGISTRY_SURFACES };
