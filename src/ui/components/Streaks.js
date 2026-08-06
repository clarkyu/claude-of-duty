/**
 * Streaks.js — killstreak chips, score readout and equipment charges. Owner: ui agent.
 *
 * Bottom-left: what you have earned and what the next reward costs, with a progress
 * hairline that fills as the streak climbs. Bottom-right, above the ammo: the lethal
 * and tactical charges, which dim as they are spent and bump when they come back.
 *
 * Hierarchy down here is deliberately flat. The chips are the loudest thing in the
 * corner; personal score is a caption. A big score numeral bottom-left competes
 * with the ammo count bottom-right across the whole width of the frame and neither
 * one wins — CoD gives this corner to killstreaks and nothing else.
 *
 * API: new Streaks(root, ctx) → { setStreaks(p), setEquipment(p),
 *                                 setScore(n, instant), update(dt) }
 */
import { div, el, setText, setClass, setStyle, Counter, clamp01, replay } from './dom.js';
import { icon } from './icons.js';

export class Streaks {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.left = div('cod-left', root);
    this.chips = div('cod-streaks', this.left);

    const box = div('cod-scorebox', this.left);
    const line = div('cod-scoreline', box);
    div('lbl', line, 'SCORE');
    this.scoreEl = div('big num', line, '0');
    this.next = div('cod-nextstreak', box);
    this.nextLbl = div('lbl', this.next, '');
    // The fill has to be an <i>: `.cod-nextstreak .bar i` is the styled selector,
    // and a bare <div> in there is an invisible element on a grey rule — which is
    // exactly how this shipped, a progress bar that never showed progress.
    this.nextFill = el('i', '', div('bar', this.next));

    this.equip = div('cod-equip', root);
    this.lethal = this._slot('frag');
    this.tactical = this._slot('flash');

    this.score = new Counter(this.scoreEl, { rate: 7 });
    this.chipNodes = new Map();
    this._nextFrac = -1;
    this._nextText = '';
  }

  _slot(iconKey) {
    const n = div('cod-slot', this.equip);
    n.__ico = icon(iconKey, 20);
    n.appendChild(n.__ico);
    n.__count = el('em', '', n, '0');
    n.__key = iconKey;
    return n;
  }

  setVisible(v) {
    setClass(this.left, 'on', !!v);
    setClass(this.equip, 'on', !!v);
  }

  /** @param {object} p hud:killstreak payload */
  setStreaks(p) {
    if (!p) return;
    const list = Array.isArray(p.available) ? p.available : [];
    const seen = new Set();
    for (const s of list) {
      seen.add(s.id);
      let n = this.chipNodes.get(s.id);
      if (!n) {
        n = div('cod-streak', this.chips);
        n.appendChild(icon(s.icon || 'strike', 17));
        el('b', '', n, String(s.name || s.id).toUpperCase());
        el('kbd', '', n, String(s.key || ''));
        this.chipNodes.set(s.id, n);
        replay(n, 'enter');
      }
    }
    for (const [id, n] of this.chipNodes) {
      if (!seen.has(id)) {
        n.remove();
        this.chipNodes.delete(id);
      }
    }

    const nxt = p.next;
    const streak = p.streak || 0;
    // Name the reward and say what it costs, the way the real thing does. "2 MORE"
    // on its own is a fragment — more of what?
    const at = Math.max(0, Math.round(nxt?.at ?? 0));
    const text = nxt
      ? `${nxt.name} · ${at} ${at === 1 ? 'KILL' : 'KILLS'}`
      : 'ALL STREAKS EARNED';
    if (text !== this._nextText) {
      this._nextText = text;
      setText(this.nextLbl, text.toUpperCase());
    }
    const frac = nxt && nxt.cost ? clamp01(streak / nxt.cost) : 1;
    if (Math.abs(frac - this._nextFrac) > 0.01) {
      this._nextFrac = frac;
      setStyle(this.nextFill, 'transform', `scaleX(${frac.toFixed(3)})`);
    }
  }

  /** @param {object} p hud:equipment payload */
  setEquipment(p) {
    if (!p) return;
    this._apply(this.lethal, p.lethalId || 'frag', p.lethal ?? 0, p.lethalMax ?? 1);
    this._apply(this.tactical, p.tacticalId || 'flash', p.tactical ?? 0, p.tacticalMax ?? 1);
  }

  _apply(node, iconKey, count, max) {
    if (node.__key !== iconKey) {
      node.__key = iconKey;
      const next = icon(iconKey, 20);
      node.replaceChild(next, node.__ico);
      node.__ico = next;
    }
    const prev = node.__n ?? -1;
    if (prev !== count) {
      node.__n = count;
      setText(node.__count, String(count));
      if (count > prev && prev >= 0) replay(node, 'bump');
    }
    setClass(node, 'spent', count <= 0);
  }

  setScore(n, instant) {
    this.score.set(n || 0, instant);
  }

  update(dt) {
    this.score.update(dt);
  }

  dispose() {
    this.left.remove();
    this.equip.remove();
  }
}

export default Streaks;
