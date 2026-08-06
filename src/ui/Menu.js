/**
 * Menu.js — the front end. Owner: ui agent.  Publishes `ctx.menu`.
 *
 * One DOM tree, six screens, no framework:
 *   lock       click-to-deploy overlay that owns the pointer-lock handshake
 *   main       title card + nav
 *   modes      the five game modes with their win conditions
 *   loadout    class picker, primary/secondary, attachments, perks, equipment, and a
 *              turntable of the *real* viewmodel mesh (see components/WeaponPreview)
 *   settings   video / effects / gameplay / controls / audio, all live-wired to
 *              ctx.settings, ctx.pipeline.setPassEnabled and ctx.audio.setBusGain
 *   pause      the same nav over a blurred freeze of the game
 *   end        the match result and full scoreboard
 *
 * ── Pointer-lock flow ───────────────────────────────────────────────────────────
 *   click overlay → input.requestLock() → 'input:lock' {locked:true} → play
 *   Escape (browser releases the lock) → 'input:lock' {locked:false} → pause screen
 *   Resume → requestLock() again. The browser enforces a short cool-down after an
 *   Escape release, so a failed request is retried on the next click rather than
 *   thrown.
 *
 * While any screen is open the game is paused (`ctx.game.pause(true)`), raw input is
 * disabled so WASD does not leak into the menu, and the HUD fades out. In headless
 * mode the menu is built but never opened — the screenshot harness must see the
 * world and the HUD, never the front end.
 *
 * ── Events emitted ──────────────────────────────────────────────────────────────
 *   menu:open {screen}   menu:close {}   menu:deploy {mode}
 *
 * ── Public API (ctx.menu) ───────────────────────────────────────────────────────
 *   ready open(screen) close() back() toggle() isOpen screen
 *   showEnd(board) refreshLoadout() root
 */
import { div, el, setText, setClass, reducedMotion, clamp01 } from './components/dom.js';
import { icon, weaponIcon } from './components/icons.js';
import { WeaponPreview } from './components/WeaponPreview.js';
import { Scoreboard } from './components/Scoreboard.js';
import * as Widgets from './components/Widgets.js';
import * as AttachmentsMod from '../weapons/Attachments.js';

const ATTACHMENTS = AttachmentsMod.ATTACHMENTS || {};
const SLOTS = AttachmentsMod.SLOTS || ['optic', 'muzzle', 'underbarrel', 'magazine'];

const MODE_BLURB = {
  tdm: 'Two squads. First to the kill limit takes it.',
  ffa: 'Everybody is hostile. Trust nothing.',
  dom: 'Three flags. Hold two and the clock does the work.',
  snd: 'One life. Plant it or defuse it.',
  hp: 'One rotating zone. Own it, or lose it.',
};

const BIND_ROWS = [
  ['forward', 'MOVE FORWARD'],
  ['back', 'MOVE BACK'],
  ['left', 'MOVE LEFT'],
  ['right', 'MOVE RIGHT'],
  ['jump', 'JUMP / MANTLE'],
  ['crouch', 'CROUCH'],
  ['prone', 'PRONE'],
  ['sprint', 'SPRINT'],
  ['reload', 'RELOAD'],
  ['use', 'USE'],
  ['melee', 'MELEE'],
  ['grenade', 'LETHAL'],
  ['tactical', 'TACTICAL'],
  ['swap', 'SWAP WEAPON'],
  ['fireMode', 'FIRE MODE'],
  ['inspect', 'INSPECT'],
  ['scoreboard', 'SCOREBOARD'],
];

const BUSES = [
  ['weapons', 'WEAPONS'],
  ['impacts', 'IMPACTS'],
  ['foley', 'FOLEY'],
  ['ambience', 'AMBIENCE'],
  ['voice', 'VOICE'],
  ['ui', 'INTERFACE'],
];

const PASSES = [
  ['bloom', 'BLOOM', 'bloom'],
  ['gtao', 'AMBIENT OCCLUSION', 'ssao'],
  ['ssr', 'SCREEN-SPACE REFLECTIONS', 'ssr'],
  ['volumetrics', 'VOLUMETRIC LIGHT', 'volumetrics'],
  ['taa', 'TEMPORAL AA', 'taa'],
  ['motionBlur', 'MOTION BLUR', 'motionBlur'],
  ['dof', 'DEPTH OF FIELD', 'dof'],
  ['lens', 'LENS IMPERFECTIONS', 'chromaticAberration'],
  ['fxaa', 'FXAA', 'fxaa'],
];

export default function createMenu(ctx) {
  let root = null;
  let lockEl = null;
  const screens = {};
  let screen = null;
  let stack = [];
  let headless = false;
  let preview = null;
  let endBoard = null;
  let deployed = false;
  let lockCooldown = 0;
  let built = false;
  let hudEnabled = true;
  const subs = [];
  const binds = new Map();

  const on = (name, fn) => {
    const off = ctx.bus?.on?.(name, fn);
    if (typeof off === 'function') subs.push(off);
  };
  const click = () => ctx.audio?.play?.('ui_click', { spatial: false, volume: 0.6 });
  const back = () => ctx.audio?.play?.('ui_back', { spatial: false, volume: 0.6 });

  /* ══════════════════════════════════════════════════════════════ scaffold ══ */

  function panel(title, parentScreen) {
    const p = div('codm-panel', parentScreen);
    const hd = div('codm-panel-hd', p);
    el('h2', '', hd, title);
    const tabs = div('codm-tabs', hd);
    const body = div('codm-panel-bd', p);
    const ft = div('codm-panel-ft', p);
    return { root: p, head: hd, tabs, body, foot: ft };
  }

  function makeScreen(name) {
    const s = div('codm-screen', root);
    screens[name] = s;
    return s;
  }

  /* ─────────────────────────────────────────────────────────────────── main ── */

  function buildMain() {
    const s = makeScreen('main');
    div('codm-strip', s);
    const t = div('codm-title', s);
    const h = el('h1', '', t);
    h.innerHTML = 'CLAUDE<br>OF <em>DUTY</em>';
    div('rule', t);
    el('p', '', t, 'BAZAAR · MULTIPLAYER');

    const nav = div('codm-nav', s);
    const first = Widgets.navItem(nav, 'DEPLOY', 'ENTER', () => {
      click();
      deploy();
    });
    first.classList.add('sel');
    Widgets.navItem(nav, 'GAME MODE', '', () => go('modes'));
    Widgets.navItem(nav, 'LOADOUT', '', () => go('loadout'));
    Widgets.navItem(nav, 'SETTINGS', '', () => go('settings'));
    Widgets.navItem(nav, 'CONTROLS', '', () => {
      go('settings');
      selectTab('controls');
    });

    const foot = div('', s);
    foot.style.cssText =
      'position:absolute;left:7vw;bottom:5vh;font-size:9px;letter-spacing:.3em;color:var(--ink-3)';
    foot.textContent = 'WASD MOVE · SHIFT SPRINT · RMB ADS · R RELOAD · TAB SCORES · ESC MENU';
  }

  /* ────────────────────────────────────────────────────────────────── modes ── */

  function buildModes() {
    const s = makeScreen('modes');
    div('codm-strip', s);
    const t = div('codm-title', s);
    el('h1', '', t, 'MODE');
    div('rule', t);
    const p = panel('SELECT A MODE', s);
    const list = div('codm-pick', p.body);
    const modes = ctx.game?.MODES || {};
    const ids = Object.keys(modes);
    for (const id of ids.length ? ids : ['tdm']) {
      const m = modes[id] || { id, name: id.toUpperCase(), short: id.toUpperCase() };
      const card = div('codm-card', list);
      card.appendChild(icon(id === 'snd' ? 'bomb' : id === 'dom' || id === 'hp' ? 'flag' : 'skull', 20));
      const col = div('', card);
      el('b', '', col, String(m.name || id).toUpperCase());
      const sub = el('div', '', col, MODE_BLURB[id] || '');
      sub.style.cssText = 'font-size:9px;letter-spacing:.14em;color:var(--ink-3);text-transform:none';
      el('em', '', card, m.scoreLimit ? `${m.scoreLimit} PTS` : '');
      card.addEventListener('click', () => {
        click();
        for (const c of list.children) setClass(c, 'sel', c === card);
        try {
          ctx.game?.setMode?.(id);
        } catch {
          /* mode switch is best effort */
        }
      });
      setClass(card, 'sel', ctx.game?.modeId === id);
    }
    Widgets.button(p.foot, 'BACK', () => goBack(), 'ghost');
    Widgets.button(p.foot, 'START MATCH', () => {
      click();
      try {
        ctx.game?.restart?.();
      } catch {
        /* best effort */
      }
      deploy();
    }, 'primary');
  }

  /* ──────────────────────────────────────────────────────────────── loadout ── */

  let loadoutUI = null;

  function buildLoadout() {
    const s = makeScreen('loadout');
    div('codm-strip', s);
    const t = div('codm-title', s);
    el('h1', '', t, 'LOADOUT');
    div('rule', t);

    const p = panel('ARMOURY', s);
    const grid = div('codm-loadout', p.body);
    const left = div('codm-preview', grid);
    const name = div('wname', left, '');
    const cls = div('wclass', left, '');
    const canvas = document.createElement('canvas');
    left.appendChild(canvas);
    div('stage', left);
    const bars = div('codm-bars', left);
    const barNodes = {};
    for (const k of ['DAMAGE', 'FIRE RATE', 'RANGE', 'ACCURACY', 'MOBILITY', 'CONTROL']) {
      const b = div('codm-bar', bars);
      el('span', '', b, k);
      const fill = div('', div('t', b));
      barNodes[k] = { fill, val: el('em', '', b, '0') };
    }

    const right = div('codm-pick', grid);
    preview = new WeaponPreview(canvas, ctx);

    // Tabs pick what the right-hand column is listing.
    const tabs = [
      ['primary', 'PRIMARY'],
      ['attach', 'ATTACHMENTS'],
      ['gear', 'EQUIPMENT'],
      ['perks', 'PERKS'],
    ];
    let tab = 'primary';
    const tabNodes = new Map();
    for (const [id, label] of tabs) {
      const n = div('codm-tab', p.tabs, label);
      tabNodes.set(id, n);
      n.addEventListener('click', () => {
        click();
        tab = id;
        for (const [k, v] of tabNodes) setClass(v, 'sel', k === id);
        renderList();
      });
    }
    setClass(tabNodes.get('primary'), 'sel', true);

    Widgets.button(p.foot, 'BACK', () => goBack(), 'ghost');
    Widgets.button(p.foot, 'DEPLOY', () => {
      click();
      deploy();
    }, 'primary');

    loadoutUI = { canvas, name, cls, barNodes, right, renderList: null, tab: () => tab };

    function card(parent, iconKey, title, sub, selected, onPick) {
      const c = div('codm-card', parent);
      c.appendChild(icon(iconKey, 19));
      const col = div('', c);
      el('b', '', col, String(title).toUpperCase());
      if (sub) {
        const d = el('div', '', col, sub);
        d.style.cssText =
          'font-size:9px;letter-spacing:.12em;color:var(--ink-3);text-transform:none';
      }
      setClass(c, 'sel', !!selected);
      c.addEventListener('click', () => {
        click();
        onPick?.();
        renderList();
      });
      return c;
    }

    function renderList() {
      right.textContent = '';
      const w = ctx.weapons;
      if (tab === 'primary') {
        const ids = w?.list?.() || [];
        for (const id of ids) {
          const def = w?.defs?.[id];
          card(
            right,
            weaponIcon(id, def),
            def?.name || id,
            def?.fullName || '',
            w?.currentId === id,
            () => equip(id)
          );
        }
      } else if (tab === 'attach') {
        const cur = w?.currentId;
        const def = cur ? w?.defs?.[cur] : null;
        const slots = def?.slots || SLOTS;
        const fitted = w?.attachments || {};
        for (const slot of slots) {
          const hdr = div('codm-sec', right, slot.toUpperCase());
          hdr.style.marginTop = '10px';
          const options = Object.values(ATTACHMENTS).filter((a) => a?.slot === slot);
          card(right, 'chevron', 'NONE', 'No attachment', !fitted[slot] || fitted[slot] === 'none', () =>
            setAttachment(slot, 'none')
          );
          for (const a of options) {
            if (!a?.id || a.id === 'none') continue;
            card(right, slotIcon(slot), a.name || a.id, a.blurb || '', fitted[slot] === a.id, () =>
              setAttachment(slot, a.id)
            );
          }
        }
      } else if (tab === 'gear') {
        const L = ctx.game?.loadouts;
        const active = L?.active;
        for (const [key, table, cur] of [
          ['LETHAL', L?.LETHALS, active?.lethal],
          ['TACTICAL', L?.TACTICALS, active?.tactical],
        ]) {
          if (!table) continue;
          div('codm-sec', right, key);
          for (const id of Object.keys(table)) {
            const d = table[id];
            card(right, id, d?.name || id, d?.blurb || '', cur === id, () => {
              const i = L?.index ?? 0;
              L?.setSlot?.(i, key === 'LETHAL' ? { lethal: id } : { tactical: id });
            });
          }
        }
      } else {
        const L = ctx.game?.loadouts;
        const perks = L?.PERKS || {};
        const active = L?.active?.perks || [];
        div('codm-sec', right, 'PERKS');
        for (const id of Object.keys(perks)) {
          const d = perks[id];
          card(right, 'chevron', d?.name || id, d?.blurb || d?.desc || '', active.includes(id), () => {
            const i = L?.index ?? 0;
            const next = active.includes(id)
              ? active.filter((x) => x !== id)
              : [...active, id].slice(-3);
            L?.setSlot?.(i, { perks: next });
          });
        }
      }
    }
    loadoutUI.renderList = renderList;
  }

  function slotIcon(slot) {
    switch (slot) {
      case 'optic':
        return 'longshot';
      case 'muzzle':
        return 'explosive';
      case 'underbarrel':
        return 'chevron';
      default:
        return 'ar';
    }
  }

  /** Changing an attachment changes the mesh, so the turntable must re-clone. */
  function setAttachment(slot, id) {
    try {
      ctx.weapons?.setAttachment?.(slot, id);
    } catch {
      /* the armoury must never take the menu down */
    }
    if (preview) preview.current = null;
    refreshLoadout();
  }

  function equip(id) {
    try {
      ctx.weapons?.equip?.(id, { instant: true });
    } catch {
      /* the armoury must never take the menu down */
    }
    refreshLoadout();
  }

  function refreshLoadout() {
    if (!loadoutUI) return;
    const w = ctx.weapons;
    const id = w?.currentId;
    const def = id ? w?.defs?.[id] : null;
    setText(loadoutUI.name, def?.name || '—');
    setText(loadoutUI.cls, (def?.class || '').toUpperCase() + (def?.calibre ? ' · ' + def.calibre : ''));
    const st = weaponBars(def);
    for (const k in loadoutUI.barNodes) {
      const v = st[k] ?? 0;
      loadoutUI.barNodes[k].fill.style.transform = `scaleX(${v.toFixed(3)})`;
      setText(loadoutUI.barNodes[k].val, Math.round(v * 100));
    }
    if (id) preview?.show(id);
    loadoutUI.renderList?.();
  }

  function weaponBars(def) {
    if (!def) return {};
    const dmg = def.damage?.[0]?.v ?? 30;
    const far = def.damage?.[def.damage.length - 1]?.r ?? 50;
    const rec = def.recoil || {};
    const kick = (rec.vertical ?? 0.02) + (rec.horizontal ?? 0.01);
    // Cone at the sights, in degrees — the honest measure of a weapon's accuracy.
    const ads = ((def.spread?.adsBase ?? 0.004) * 180) / Math.PI;
    return {
      DAMAGE: clamp01(dmg / 60),
      'FIRE RATE': clamp01((def.rpm ?? 600) / 1100),
      RANGE: clamp01(far / 110),
      ACCURACY: clamp01(1 - ads / 0.6),
      MOBILITY: clamp01(((def.moveSpeedScale ?? 1) - 0.7) / 0.4),
      CONTROL: clamp01(1 - kick * 22),
    };
  }

  /* ─────────────────────────────────────────────────────────────── settings ── */

  let tabNodes = null;
  let tabPages = null;

  function buildSettings() {
    const s = makeScreen('settings');
    div('codm-strip', s);
    const t = div('codm-title', s);
    el('h1', '', t, 'SETTINGS');
    div('rule', t);
    const p = panel('OPTIONS', s);

    tabNodes = new Map();
    tabPages = new Map();
    const defs = [
      ['video', 'VIDEO', pageVideo],
      ['effects', 'EFFECTS', pageEffects],
      ['gameplay', 'GAMEPLAY', pageGameplay],
      ['controls', 'CONTROLS', pageControls],
      ['audio', 'AUDIO', pageAudio],
    ];
    for (const [id, label, builder] of defs) {
      const n = div('codm-tab', p.tabs, label);
      tabNodes.set(id, n);
      const page = div('', p.body);
      page.style.display = 'none';
      tabPages.set(id, page);
      try {
        builder(page);
      } catch (err) {
        console.warn('[menu] settings page failed', id, err);
      }
      n.addEventListener('click', () => {
        click();
        selectTab(id);
      });
    }
    selectTab('video');

    Widgets.button(p.foot, 'BACK', () => goBack(), 'ghost');
    Widgets.button(p.foot, 'RESET TO DEFAULTS', () => {
      click();
      ctx.settings?.setTier?.('high');
      syncSettings();
    });
  }

  function selectTab(id) {
    if (!tabNodes) return;
    for (const [k, n] of tabNodes) setClass(n, 'sel', k === id);
    for (const [k, n] of tabPages) (n.style.display = k === id ? '' : 'none');
  }

  const controls = {};

  function settingRow(page, label, build) {
    const r = Widgets.row(page, label);
    const readout = document.createElement('span');
    readout.className = 'val';
    build(r, readout);
    // The numeric readout always sits to the right of its control.
    r.appendChild(readout);
    return r;
  }

  function pageVideo(page) {
    Widgets.section(page, 'PRESET');
    const r = Widgets.row(page, 'QUALITY TIER');
    controls.tier = Widgets.segmented(
      r,
      [
        { id: 'low', label: 'LOW' },
        { id: 'medium', label: 'MED' },
        { id: 'high', label: 'HIGH' },
        { id: 'ultra', label: 'ULTRA' },
      ],
      ctx.settings?.tier || 'high',
      (id) => {
        ctx.settings?.setTier?.(id);
        syncSettings();
      }
    );

    Widgets.section(page, 'IMAGE');
    settingRow(page, 'FIELD OF VIEW', (r2, out) => {
      controls.fov = Widgets.slider(r2, {
        min: 65, max: 120, step: 1,
        value: ctx.settings?.get?.('fov') ?? 90,
        readout: out,
        format: (v) => `${Math.round(v)}°`,
        onChange: (v) => {
          ctx.settings?.set?.('fov', v);
          if (ctx.camera) {
            ctx.camera.fov = v;
            ctx.camera.updateProjectionMatrix();
          }
        },
      });
    });
    settingRow(page, 'RENDER SCALE', (r2, out) => {
      controls.scale = Widgets.slider(r2, {
        min: 0.5, max: 1.5, step: 0.05,
        value: ctx.settings?.get?.('renderScale') ?? 1,
        readout: out,
        format: (v) => `${Math.round(v * 100)}%`,
        onChange: (v) => ctx.settings?.set?.('renderScale', v),
      });
    });
    settingRow(page, 'EXPOSURE', (r2, out) => {
      controls.exposure = Widgets.slider(r2, {
        min: 0.4, max: 1.8, step: 0.02,
        value: ctx.settings?.get?.('exposure') ?? 1,
        readout: out,
        format: (v) => v.toFixed(2),
        onChange: (v) => ctx.settings?.set?.('exposure', v),
      });
    });

    Widgets.section(page, 'SHADOWS');
    const sr = Widgets.row(page, 'DYNAMIC SHADOWS');
    controls.shadows = Widgets.toggle(sr, ctx.settings?.get?.('shadows') !== false, (v) =>
      ctx.settings?.set?.('shadows', v)
    );
    settingRow(page, 'SHADOW RESOLUTION', (r2, out) => {
      controls.shadowRes = Widgets.slider(r2, {
        min: 512, max: 3072, step: 512,
        value: ctx.settings?.get?.('shadowResolution') ?? 2048,
        readout: out,
        format: (v) => `${Math.round(v)}`,
        onChange: (v) => ctx.settings?.set?.('shadowResolution', Math.round(v)),
      });
    });
  }

  function pageEffects(page) {
    Widgets.section(page, 'POST PROCESSING');
    controls.passes = {};
    for (const [key, label, settingKey] of PASSES) {
      const r = Widgets.row(page, label);
      const enabled = ctx.pipeline?.isEnabled?.(key) ?? ctx.settings?.get?.(settingKey) ?? true;
      controls.passes[key] = Widgets.toggle(r, !!enabled, (v) => {
        ctx.pipeline?.setPassEnabled?.(key, v);
        if (settingKey) ctx.settings?.set?.(settingKey, v);
      });
    }
    Widgets.section(page, 'CAMERA');
    const gr = Widgets.row(page, 'SENSOR GRAIN');
    controls.grain = Widgets.toggle(gr, ctx.settings?.get?.('grain') !== false, (v) =>
      ctx.settings?.set?.('grain', v)
    );
    const fr = Widgets.row(page, 'FOLIAGE DENSITY');
    const fo = document.createElement('span');
    fo.className = 'val';
    controls.foliage = Widgets.slider(fr, {
      min: 0, max: 1.4, step: 0.05,
      value: ctx.settings?.get?.('foliageDensity') ?? 1,
      readout: fo,
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => ctx.settings?.set?.('foliageDensity', v),
    });
    fr.appendChild(fo);
  }

  function pageGameplay(page) {
    Widgets.section(page, 'AIM');
    settingRow(page, 'MOUSE SENSITIVITY', (r, out) => {
      controls.sens = Widgets.slider(r, {
        min: 0.0004, max: 0.006, step: 0.0001,
        value: ctx.settings?.get?.('sensitivity') ?? 0.0022,
        readout: out,
        format: (v) => (v * 1000).toFixed(2),
        onChange: (v) => ctx.settings?.set?.('sensitivity', v),
      });
    });
    const iy = Widgets.row(page, 'INVERT VERTICAL LOOK');
    controls.invertY = Widgets.toggle(iy, !!ctx.settings?.get?.('invertY'), (v) =>
      ctx.settings?.set?.('invertY', v)
    );
    settingRow(page, 'ADS FOV SCALE', (r, out) => {
      controls.adsFov = Widgets.slider(r, {
        min: 0.5, max: 1, step: 0.01,
        value: ctx.settings?.get?.('adsFovScale') ?? 0.72,
        readout: out,
        format: (v) => v.toFixed(2),
        onChange: (v) => ctx.settings?.set?.('adsFovScale', v),
      });
    });

    Widgets.section(page, 'MATCH');
    const dr = Widgets.row(page, 'BOT DIFFICULTY');
    controls.difficulty = Widgets.segmented(
      dr,
      [
        { id: 'recruit', label: 'RECRUIT' },
        { id: 'regular', label: 'REGULAR' },
        { id: 'hardened', label: 'HARDENED' },
        { id: 'veteran', label: 'VETERAN' },
      ],
      ctx.game?.difficulty || 'regular',
      (id) => ctx.game?.setDifficulty?.(id)
    );
    settingRow(page, 'BOT COUNT', (r, out) => {
      controls.bots = Widgets.slider(r, {
        min: 0, max: 16, step: 1,
        value: (ctx.ai?.bots?.length ?? 8) | 0,
        readout: out,
        format: (v) => String(Math.round(v)),
        onDone: (v) => ctx.game?.setBotCount?.(Math.round(v)),
        onChange: () => {},
      });
    });

    Widgets.section(page, 'INTERFACE');
    const fp = Widgets.row(page, 'SHOW PERFORMANCE');
    controls.fps = Widgets.toggle(fp, !!ctx.settings?.get?.('showFps'), (v) =>
      ctx.settings?.set?.('showFps', v)
    );
    const hd = Widgets.row(page, 'SHOW HUD');
    controls.hud = Widgets.toggle(hd, hudEnabled, (v) => {
      hudEnabled = v;
      if (!screen) ctx.hud?.setVisible?.(v);
    });
  }

  function pageControls(page) {
    Widgets.section(page, 'KEY BINDINGS');
    const input = ctx.input;
    for (const [action, label] of BIND_ROWS) {
      const r = Widgets.row(page, label);
      const cur = input?.binds?.[action]?.[0] || '';
      const kb = Widgets.keybind(r, cur, (code) => {
        if (!input?.binds) return;
        const list = input.binds[action] ? input.binds[action].slice() : [];
        list[0] = code;
        input.binds[action] = list;
      });
      binds.set(action, kb);
    }
    Widgets.section(page, 'MOUSE');
    const r = Widgets.row(page, 'FIRE / AIM');
    el('span', 'val', r, 'LMB / RMB');
  }

  function pageAudio(page) {
    Widgets.section(page, 'MIXER');
    settingRow(page, 'MASTER', (r, out) => {
      controls.master = Widgets.slider(r, {
        min: 0, max: 1, step: 0.01,
        value: 1,
        readout: out,
        format: (v) => `${Math.round(v * 100)}`,
        onChange: (v) => ctx.audio?.setMasterGain?.(v),
      });
    });
    controls.bus = {};
    for (const [bus, label] of BUSES) {
      settingRow(page, label, (r, out) => {
        const cur = ctx.audio?.getBusGain?.(bus);
        controls.bus[bus] = Widgets.slider(r, {
          min: 0, max: 1.6, step: 0.02,
          value: Number.isFinite(cur) ? cur : 1,
          readout: out,
          format: (v) => `${Math.round(v * 100)}`,
          onChange: (v) => ctx.audio?.setBusGain?.(bus, v),
        });
      });
    }
    Widgets.section(page, 'OUTPUT');
    const m = Widgets.row(page, 'MUTE ALL');
    controls.mute = Widgets.toggle(m, false, (v) => ctx.audio?.mute?.(v));
  }

  /** Pull every control back into agreement with the live settings object. */
  function syncSettings() {
    const s = ctx.settings;
    if (!s) return;
    controls.tier?.select?.(s.tier);
    controls.fov?.set?.(s.get('fov'));
    controls.scale?.set?.(s.get('renderScale'));
    controls.exposure?.set?.(s.get('exposure'));
    controls.shadows?.set?.(s.get('shadows') !== false);
    controls.shadowRes?.set?.(s.get('shadowResolution'));
    controls.sens?.set?.(s.get('sensitivity'));
    controls.invertY?.set?.(!!s.get('invertY'));
    controls.fps?.set?.(!!s.get('showFps'));
    controls.grain?.set?.(s.get('grain') !== false);
    controls.foliage?.set?.(s.get('foliageDensity'));
    if (controls.passes) {
      for (const [key, , settingKey] of PASSES) {
        const v = ctx.pipeline?.isEnabled?.(key) ?? s.get(settingKey);
        controls.passes[key]?.set?.(!!v);
      }
    }
  }

  /* ────────────────────────────────────────────────────────────────── pause ── */

  function buildPause() {
    const s = makeScreen('pause');
    div('codm-strip', s);
    const t = div('codm-title', s);
    el('h1', '', t, 'PAUSED');
    div('rule', t);
    const sub = el('p', '', t, '');
    sub.textContent = 'MATCH IN PROGRESS';

    const nav = div('codm-nav', s);
    const first = Widgets.navItem(nav, 'RESUME', 'ESC', () => {
      click();
      close();
    });
    first.classList.add('sel');
    Widgets.navItem(nav, 'LOADOUT', '', () => go('loadout'));
    Widgets.navItem(nav, 'SETTINGS', '', () => go('settings'));
    Widgets.navItem(nav, 'RESTART MATCH', '', () => {
      click();
      try {
        ctx.game?.restart?.();
      } catch {
        /* best effort */
      }
      close();
    });
    Widgets.navItem(nav, 'MAIN MENU', '', () => {
      back();
      deployed = false;
      go('main');
      stack = [];
    });
  }

  /* ──────────────────────────────────────────────────────────────────── end ── */

  function buildEnd() {
    const s = makeScreen('end');
    const r = div('codm-result', s);
    const h = el('h1', '', r, 'VICTORY');
    const p = el('p', '', r, '');
    const holder = div('board', r);
    endBoard = new Scoreboard(holder, ctx, { detached: true });
    const btns = div('', r);
    btns.style.cssText =
      'position:absolute;left:0;right:0;bottom:-8vh;display:flex;gap:12px;justify-content:center';
    Widgets.button(btns, 'PLAY AGAIN', () => {
      click();
      try {
        ctx.game?.restart?.();
      } catch {
        /* best effort */
      }
      deploy();
    }, 'primary');
    Widgets.button(btns, 'MAIN MENU', () => {
      back();
      deployed = false;
      go('main');
    }, 'ghost');
    screens.end.__h = h;
    screens.end.__p = p;
  }

  /* ═════════════════════════════════════════════════════════════════ flow ══ */

  function go(name) {
    if (!screens[name]) return;
    click();
    if (screen && screen !== name) stack.push(screen);
    show(name);
  }

  function goBack() {
    back();
    const prev = stack.pop();
    if (prev) show(prev);
    else if (deployed) show('pause');
    else show('main');
  }

  function show(name) {
    if (root) root.style.display = '';
    for (const k in screens) setClass(screens[k], 'show', k === name);
    screen = name;
    openState(true);
    if (name === 'loadout') {
      refreshLoadout();
      preview?.show(ctx.weapons?.currentId);
    } else preview?.hide();
    if (name === 'settings') syncSettings();
    ctx.bus?.emit?.('menu:open', { screen: name });
  }

  function openState(on) {
    setClass(root, 'open', on);
    setClass(lockEl, 'show', !on && !headless && deployed && !ctx.input?.locked);
    if (ctx.input) ctx.input.enabled = !on;
    try {
      ctx.game?.pause?.(on);
    } catch {
      /* pausing is best effort */
    }
    if (on) {
      ctx.hud?.setVisible?.(false);
      try {
        ctx.input?.exitLock?.();
      } catch {
        /* already released */
      }
    } else {
      ctx.hud?.setVisible?.(hudEnabled);
    }
  }

  function close() {
    if (!screen) return;
    for (const k in screens) setClass(screens[k], 'show', false);
    screen = null;
    stack = [];
    preview?.hide();
    openState(false);
    if (headless && root) root.style.display = 'none';
    ctx.bus?.emit?.('menu:close', {});
    requestLock();
  }

  function deploy() {
    deployed = true;
    ctx.bus?.emit?.('menu:deploy', { mode: ctx.game?.modeId });
    if (screen) close();
    else requestLock();
  }

  function requestLock() {
    if (headless) return;
    if (lockCooldown > 0) {
      setClass(lockEl, 'show', true);
      return;
    }
    try {
      const r = ctx.input?.requestLock?.();
      if (r && typeof r.catch === 'function') {
        r.catch(() => {
          lockCooldown = 1.4;
          setClass(lockEl, 'show', true);
        });
      }
    } catch {
      lockCooldown = 1.4;
      setClass(lockEl, 'show', true);
    }
  }

  function buildLock() {
    lockEl = div('codm-lock', root);
    div('ring', lockEl);
    el('h2', '', lockEl, 'CLICK TO DEPLOY');
    el('p', '', lockEl, 'POINTER LOCK REQUIRED · ESC TO PAUSE');
    lockEl.addEventListener('click', () => {
      click();
      setClass(lockEl, 'show', false);
      requestLock();
    });
  }

  /* ═══════════════════════════════════════════════════════════════ system ══ */

  const api = {
    ready: false,
    get root() {
      return root;
    },
    get isOpen() {
      return !!screen;
    },
    get screen() {
      return screen;
    },
    open: (name) => show(name || 'main'),
    close,
    back: goBack,
    toggle() {
      if (screen) close();
      else show(deployed ? 'pause' : 'main');
    },
    deploy,
    refreshLoadout,
    showEnd(board) {
      if (!screens.end) return;
      const localTeam = ctx.game?.localPlayer?.team || 'A';
      const won = board?.winner ? board.winner === localTeam : null;
      const h = screens.end.__h;
      h.textContent = won === null ? 'MATCH OVER' : won ? 'VICTORY' : 'DEFEAT';
      h.className = won === null ? '' : won ? 'win' : 'lose';
      screens.end.__p.textContent = String(board?.reason || '').toUpperCase();
      endBoard?.set?.(board);
      show('end');
    },
  };

  ctx.menu = api;

  function onKeyDown(e) {
    if (headless) return;
    // A keybind button is armed and owns this keystroke.
    if (document.documentElement.dataset.codBinding) return;
    if (e.code === 'Escape') {
      if (screen) {
        e.preventDefault();
        if (screen === 'main') return;
        if (stack.length || screen === 'settings' || screen === 'loadout' || screen === 'modes') goBack();
        else close();
      }
      return;
    }
    if (!screen && e.code === 'F1') {
      e.preventDefault();
      api.toggle();
    }
  }

  return {
    name: 'menu',
    order: 97,

    async init() {
      headless = !!ctx.settings?.get?.('headless');
      try {
        const host = document.getElementById('ui-root') || document.body;
        root = div('codm', host);
        if (reducedMotion()) root.classList.add('reduced');
        div('codm-scrim', root);
        buildMain();
        buildModes();
        buildLoadout();
        buildSettings();
        buildPause();
        buildEnd();
        buildLock();
        built = true;

        if (!headless) {
          window.addEventListener('keydown', onKeyDown, true);
          show('main');
        } else {
          // Harness: the front end exists but must never occlude the world.
          setClass(root, 'open', false);
          root.style.display = 'none';
        }

        on('input:lock', ({ locked } = {}) => {
          if (headless) return;
          if (locked) {
            setClass(lockEl, 'show', false);
            if (screen) {
              for (const k in screens) setClass(screens[k], 'show', false);
              screen = null;
              stack = [];
              setClass(root, 'open', false);
              if (ctx.input) ctx.input.enabled = true;
              ctx.game?.pause?.(false);
              ctx.hud?.setVisible?.(true);
              ctx.bus?.emit?.('menu:close', {});
            }
          } else if (deployed && !screen) {
            lockCooldown = 1.35;
            show('pause');
          }
        });

        on('game:end', (p) => {
          if (headless) return;
          const board = p?.scoreboard || ctx.game?.scoreboard?.();
          if (board) api.showEnd({ ...board, winner: p?.winner, reason: p?.reason });
        });

        on('weapon:equip', () => {
          if (screen === 'loadout') refreshLoadout();
        });

        // A pose may ask for a front-end screen (`state.menu = 'loadout'`); by
        // default the harness must see the world, so anything else closes it.
        on('debug:pose', (state) => {
          if (!state || !state.menu) {
            if (headless) root.style.display = 'none';
            return;
          }
          root.style.display = '';
          show(state.menu === true ? 'main' : String(state.menu));
          if (headless && ctx.input) ctx.input.enabled = true;
        });

        api.ready = true;
      } catch (err) {
        console.error('[menu] build failed', err);
      }
    },

    update(dt) {
      if (!built) return;
      if (lockCooldown > 0) lockCooldown = Math.max(0, lockCooldown - dt);
      if (screen !== 'loadout') return;
      try {
        preview?.update(dt);
      } catch (err) {
        console.warn('[menu] preview update failed', err);
        if (preview) preview.failed = true;
      }
    },

    dispose() {
      for (const off of subs) {
        try {
          off();
        } catch {
          /* best effort */
        }
      }
      subs.length = 0;
      window.removeEventListener('keydown', onKeyDown, true);
      preview?.dispose();
      endBoard?.dispose?.();
      root?.remove();
      root = null;
      if (ctx.menu === api) ctx.menu = null;
    },
  };
}
