/**
 * Notices.js — banners, countdowns, medals and floating score. Owner: ui agent.
 *
 * Everything here is transient and therefore driven by CSS keyframes on pooled nodes:
 * the JS cost of a medal toast is one class toggle and two textContent writes. A
 * banner queue keeps two messages from stacking on top of each other — the second
 * waits, then slides in, exactly like a CoD objective callout.
 *
 * API: new Notices(root, ctx) → { banner(p), countdown(p), medal(p), points(p),
 *                                 update(dt), clear() }
 */
import { div, el, setText, replay, NodePool } from './dom.js';
import { icon } from './icons.js';

const KIND_CLASS = {
  downed: 'danger',
  matchend: '',
  killstreak: 'streak',
  objective: 'streak',
  go: 'streak',
};

export class Notices {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.layer = div('cod-layer', root);

    this.banner = div('cod-banner', this.layer);
    this.bannerH = el('h2', '', this.banner, '');
    this.bannerP = el('p', '', this.banner, '');
    div('rule', this.banner);

    this.count = div('cod-countdown num', this.layer, '');

    this.medals = div('cod-medals', this.layer);
    this.medalPool = new NodePool(this.medals, () => {
      const n = div('cod-medal');
      n.__ico = icon('medal', 15);
      n.__ico.style.color = 'var(--accent)';
      n.appendChild(n.__ico);
      n.__b = el('b', '', n, '');
      n.__s = el('span', '', n, '');
      return n;
    }, 4);

    this.points = div('cod-points', this.layer);
    this.pointPool = new NodePool(this.points, () => div('cod-pt'), 6);

    this.now = 0;
    this.queue = [];
    this.busy = 0;
  }

  /** @param {{text:string, sub?:string, kind?:string, duration?:number}} p */
  bannerMsg(p) {
    if (!p?.text) return;
    this.queue.push(p);
    if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3);
  }

  _showBanner(p) {
    setText(this.bannerH, String(p.text || '').toUpperCase());
    setText(this.bannerP, String(p.sub || '').toUpperCase());
    this.banner.className = 'cod-banner ' + (KIND_CLASS[p.kind] ?? '');
    replay(this.banner, 'go');
    this.busy = Math.min(4, Math.max(1.4, p.duration || 3));
  }

  /** @param {{seconds:number, text:string}} p */
  countdown(p) {
    if (!p) return;
    setText(this.count, String(p.text ?? p.seconds ?? ''));
    replay(this.count, 'go');
  }

  /** @param {{name:string, points?:number, local?:boolean}} p */
  medal(p) {
    if (!p || p.local === false) return;
    const it = this.medalPool.take(this.now, 2.6);
    setText(it.node.__b, String(p.name || '').toUpperCase());
    setText(it.node.__s, p.points ? `+${p.points}` : '');
    replay(it.node, 'go');
    this.ctx.audio?.play?.('notify', { spatial: false, volume: 0.5 });
  }

  /** @param {{delta:number, label?:string, local?:boolean}} p */
  pointPop(p) {
    if (!p || !p.delta || p.local === false) return;
    const it = this.pointPool.take(this.now, 1.25);
    const sign = p.delta > 0 ? '+' : '';
    setText(it.node, `${sign}${Math.round(p.delta)}${p.label ? '  ' + String(p.label).toUpperCase() : ''}`);
    // Stagger vertically so a double award does not overprint.
    it.node.style.top = `${(this.pointPool.items.indexOf(it) % 3) * 20}px`;
    replay(it.node, 'go');
  }

  update(dt) {
    this.now += dt;
    this.medalPool.sweep(this.now);
    this.pointPool.sweep(this.now);
    if (this.busy > 0) this.busy -= dt;
    else if (this.queue.length) this._showBanner(this.queue.shift());
  }

  clear() {
    this.queue.length = 0;
    this.medalPool.clear();
    this.pointPool.clear();
  }

  dispose() {
    this.layer.remove();
  }
}

export default Notices;
