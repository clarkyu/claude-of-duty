/**
 * Status.js — match header, objective rings and the capture bar. Owner: ui agent.
 *
 * The header carries the two team scores and the clock; the clock turns red and
 * ticks under thirty seconds. Objective rings are SVG progress circles whose
 * stroke-dashoffset is the only thing that changes per update, so a three-flag
 * Domination readout costs three attribute writes.
 *
 * The capture bar appears only while the local player is personally standing in a
 * contested zone or planting/defusing — it is a *your action* bar, not a status one.
 *
 * API: new Status(root, ctx) → { setMode(p), setScore(p), setTimer(p),
 *                                setObjective(p), update(dt) }
 */
import { div, el, svg, setText, setAttr, setClass, setStyle, Counter, fmtTime, clamp01 } from './dom.js';
import { icon } from './icons.js';

const R = 15;
const CIRC = 2 * Math.PI * R;

export class Status {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.bar = div('cod-status', root);

    const a = div('cod-team a', this.bar);
    el('i', '', a);
    this.scoreA = el('span', 'num', a, '0');
    this.clock = div('cod-clock num', this.bar, '0:00');
    const b = div('cod-team b', this.bar);
    el('i', '', b);
    this.scoreB = el('span', 'num', b, '0');
    this.modeName = div('cod-modename', this.bar, '');

    this.objRow = div('cod-obj', root);
    this.zoneNodes = new Map();
    this.bomb = div('cod-bomb', this.objRow);
    this.bomb.appendChild(icon('bomb', 16));
    this.bombT = el('b', 'num', this.bomb, '');
    this.bombLbl = el('span', 'lbl', this.bomb, '');

    this.cap = div('cod-capbar', root);
    this.capLbl = div('lbl', this.cap, 'CAPTURING');
    // `.cod-capbar .track i` — see the note in Ammo.js; a <div> here is invisible.
    this.capFill = el('i', '', div('track', this.cap));

    this.cA = new Counter(this.scoreA, { rate: 8 });
    this.cB = new Counter(this.scoreB, { rate: 8 });
    this._time = -1;
    this._urgent = false;
    this._teams = true;
    this._capOn = false;
    this._lastCap = -1;
    this.remaining = 0;
    this.running = true;
    this.visible = false;
  }

  setVisible(v) {
    this.visible = !!v;
    setClass(this.bar, 'on', this.visible);
  }

  setMode(p) {
    if (!p) return;
    this._teams = p.teams !== false;
    setText(this.modeName, String(p.name || '').toUpperCase());
    setClass(this.bar, 'ffa', !this._teams);
  }

  setScore(p, instant) {
    if (!p) return;
    this.cA.set(p.A ?? 0, instant);
    this.cB.set(p.B ?? 0, instant);
  }

  /**
   * @param {{remaining:number, running?:boolean}} p
   * The clock free-runs between updates so it never stutters at the emit rate,
   * but only while the match is actually running — during a pre-match hold or a
   * round break the number must sit still rather than quietly bleeding down.
   */
  setTimer(p) {
    if (!p) return;
    this.remaining = Math.max(0, p.remaining ?? 0);
    if (p.running !== undefined) this.running = !!p.running;
  }

  /** @param {object} p the hud:objective payload */
  setObjective(p) {
    if (!p) return;
    this.objective = p;
    const zones = Array.isArray(p.zones) ? p.zones.filter((z) => z.active !== false) : [];
    const localTeam = this.ctx.game?.localPlayer?.team ?? 'A';
    const seen = new Set();
    for (const z of zones) {
      seen.add(z.id);
      let n = this.zoneNodes.get(z.id);
      if (!n) {
        n = div('cod-zone', this.objRow);
        const s = svg('svg', { class: 'ring', width: 38, height: 38, viewBox: '0 0 38 38' }, n);
        svg('circle', { class: 'track', cx: 19, cy: 19, r: R }, s);
        const prog = svg('circle', {
          class: 'prog',
          cx: 19, cy: 19, r: R,
          'stroke-dasharray': CIRC.toFixed(1),
          'stroke-dashoffset': CIRC.toFixed(1),
        }, s);
        const t = svg('text', { x: 19, y: 19 }, s);
        n.__prog = prog;
        n.__text = t;
        n.__name = el('em', '', n, '');
        this.zoneNodes.set(z.id, n);
        // Keep the bomb strip last.
        this.objRow.insertBefore(n, this.bomb);
      }
      setText(n.__text, String(z.label || '').toUpperCase());
      setText(n.__name, String(z.name || '').toUpperCase().slice(0, 9));
      const owned = z.owner === localTeam;
      const foe = z.owner && z.owner !== localTeam;
      setClass(n, 'own', owned);
      setClass(n, 'foe', !!foe);
      setClass(n, 'cap', !!z.capturing && !owned);
      setClass(n, 'contested', !!z.contested);
      const frac = z.owner ? 1 : clamp01(z.progress ?? 0);
      setAttr(n.__prog, 'stroke-dashoffset', (CIRC * (1 - frac)).toFixed(1));
    }
    for (const [id, n] of this.zoneNodes) {
      if (!seen.has(id)) {
        n.remove();
        this.zoneNodes.delete(id);
      }
    }

    const bomb = p.bomb;
    const planted = !!bomb?.planted;
    setClass(this.bomb, 'on', planted);
    if (planted) {
      setText(this.bombT, Math.ceil(bomb.timer || 0));
      setText(this.bombLbl, `BOMB AT ${bomb.site || '?'}`);
    }

    setClass(this.objRow, 'on', zones.length > 0 || planted);

    // Capture bar: only for the thing the player is doing right now.
    let capFrac = -1;
    let capLabel = 'CAPTURING';
    if (bomb && bomb.plantProgress > 0.001 && !planted) {
      capFrac = bomb.plantProgress;
      capLabel = 'PLANTING';
    } else if (bomb && bomb.defuseProgress > 0.001) {
      capFrac = bomb.defuseProgress;
      capLabel = 'DEFUSING';
    } else {
      const me = this.ctx.game?.localPlayer;
      const px = me?.position?.x ?? this.ctx.player?.position?.x ?? 0;
      const pz = me?.position?.z ?? this.ctx.player?.position?.z ?? 0;
      for (const z of zones) {
        if (!z.capturing && !z.contested) continue;
        const dx = px - z.x;
        const dz = pz - z.z;
        if (dx * dx + dz * dz <= (z.radius || 4) * (z.radius || 4)) {
          capFrac = clamp01(z.progress ?? 0);
          capLabel = z.contested ? 'CONTESTED' : `CAPTURING ${z.label || ''}`;
          break;
        }
      }
    }
    const on = capFrac >= 0;
    if (on !== this._capOn) {
      this._capOn = on;
      setClass(this.cap, 'on', on);
    }
    if (on) {
      setText(this.capLbl, capLabel);
      if (Math.abs(capFrac - this._lastCap) > 0.004) {
        this._lastCap = capFrac;
        setStyle(this.capFill, 'transform', `scaleX(${capFrac.toFixed(3)})`);
      }
    }
  }

  /** Compass/minimap markers derived from the current objective state. */
  markers() {
    const out = [];
    const p = this.objective;
    const localTeam = this.ctx.game?.localPlayer?.team ?? 'A';
    if (p?.zones) {
      for (const z of p.zones) {
        if (z.active === false) continue;
        out.push({
          id: 'z' + z.id,
          x: z.x,
          z: z.z,
          radius: z.radius,
          label: z.label,
          kind: 'flag',
          owner: z.owner ? (z.owner === localTeam ? 'own' : 'foe') : null,
        });
      }
    }
    return out;
  }

  update(dt) {
    this.cA.update(dt);
    this.cB.update(dt);
    if (this.running && this.remaining > 0) this.remaining = Math.max(0, this.remaining - dt);
    const s = Math.ceil(this.remaining);
    if (s !== this._time) {
      this._time = s;
      setText(this.clock, fmtTime(s));
      const urgent = s <= 30 && s > 0;
      if (urgent !== this._urgent) {
        this._urgent = urgent;
        setClass(this.clock, 'urgent', urgent);
      }
    }
  }

  dispose() {
    this.bar.remove();
    this.objRow.remove();
    this.cap.remove();
  }
}

export default Status;
