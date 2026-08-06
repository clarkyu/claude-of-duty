/**
 * Ammo.js — magazine / reserve readout. Owner: ui agent.
 *
 * Reads the live weapon state (`ctx.weapons.ammo/reserve/magSize/fireMode`) rather
 * than caching what an event told us, so it can never drift out of sync with the gun.
 * The magazine number snaps and pops — a round leaving the gun should feel discrete —
 * while the reserve rolls, because that is a resource, not an event. Low ammo pushes
 * the numerals to the warm accent and pulses; empty goes red.
 *
 * API: new Ammo(root, ctx) → { update(dt), setVisible(b), flashReload(on) }
 */
import { div, setText, setClass, setStyle, Counter, clamp01, replay } from './dom.js';

export class Ammo {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.root = div('cod-ammo', root);
    this.name = div('cod-weapname', this.root, '');
    const row = div('cod-ammo-row', this.root);
    this.mag = div('cod-mag num', row, '0');
    div('cod-slash', row, '/');
    this.res = div('cod-res num', row, '0');
    const bar = div('cod-ammo-bar', this.root);
    this.fill = div('', bar);
    this.mode = div('cod-firemode', this.root, '');
    this.reload = div('cod-reload', this.root, 'RELOADING');

    this.resCount = new Counter(this.res, { rate: 11 });
    this._mag = -1;
    this._magSize = 30;
    this._name = '';
    this._mode = '';
    this._state = '';
    this._lastFill = -1;
    this._lowAudio = 0;
  }

  setVisible(v) {
    setClass(this.root, 'on', !!v);
  }

  update(dt) {
    const w = this.ctx.weapons;
    let ammo = 0;
    let reserve = 0;
    let size = 30;
    let name = '';
    let mode = '';
    if (w) {
      try {
        ammo = w.ammo | 0;
        reserve = w.reserve | 0;
        size = Math.max(1, w.magSize | 0);
        name = w.def?.name || w.currentId || '';
        mode = w.fireMode || '';
      } catch {
        /* the weapon may be mid-swap */
      }
    }

    if (ammo !== this._mag) {
      const dropped = ammo < this._mag;
      this._mag = ammo;
      setText(this.mag, String(ammo));
      if (dropped) replay(this.mag, 'pop');
    }
    this.resCount.set(reserve);
    this.resCount.update(dt);

    if (name !== this._name) {
      this._name = name;
      setText(this.name, name);
    }
    if (mode !== this._mode) {
      this._mode = mode;
      setText(this.mode, mode ? modeLabel(mode) : '');
    }

    const frac = clamp01(ammo / size);
    if (Math.abs(frac - this._lastFill) > 0.005) {
      this._lastFill = frac;
      setStyle(this.fill, 'transform', `scaleX(${frac.toFixed(3)})`);
    }

    const low = ammo > 0 && frac <= 0.28;
    const empty = ammo <= 0;
    setClass(this.root, 'low', low && !empty);
    setClass(this.root, 'empty', empty);

    const reloading = !!w?.reloading;
    setClass(this.reload, 'on', reloading);

    // One warning chirp when the mag first crosses the low line.
    if (low && this._state !== 'low') {
      this.ctx.audio?.play?.('ammo_low', { spatial: false, volume: 0.5 });
    }
    this._state = empty ? 'empty' : low ? 'low' : 'ok';
  }

  dispose() {
    this.root.remove();
  }
}

function modeLabel(m) {
  switch (String(m)) {
    case 'auto':
      return 'AUTO';
    case 'burst':
      return 'BURST';
    case 'semi':
      return 'SEMI';
    case 'pump':
      return 'PUMP';
    case 'bolt':
      return 'BOLT';
    default:
      return String(m).toUpperCase();
  }
}

export default Ammo;
