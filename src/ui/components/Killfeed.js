/**
 * Killfeed.js — top-right kill log with weapon icons. Owner: ui agent.
 *
 * Rows enter with a slide, live for 7 s, then collapse. Nodes are recycled from a
 * fixed pool so a long match never grows the DOM. Icons are the real weapon class
 * silhouettes plus modifiers (headshot skull, wallbang, longshot) — the same visual
 * language CoD uses so the log is readable at a glance mid-fight.
 *
 * API: new Killfeed(root, ctx) → { push(entry), update(dt), clear() }
 */
import { div, el } from './dom.js';
import { icon, weaponIcon } from './icons.js';

const LIFE = 7.0;
const MAX = 5;

export class Killfeed {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.root = div('cod-killfeed', root);
    this.rows = [];
    this.pool = [];
  }

  _row() {
    const n = this.pool.pop();
    if (n) return n;
    const r = div('cod-kf');
    r.__a = el('b', '', r, '');
    r.__ico = div('', r);
    r.__ico.style.cssText = 'display:flex;align-items:center;gap:3px;color:var(--ink-2)';
    r.__v = el('b', '', r, '');
    return r;
  }

  /** @param {object} e killfeed entry from Scoring.js */
  push(e) {
    if (!e) return;
    const r = this._row();
    const localTeam = this.ctx.game?.localPlayer?.team ?? null;
    const attackerLocal = !!e.local && !!e.attacker;

    r.__a.textContent = String(e.attacker || '').toUpperCase() || '—';
    r.__v.textContent = String(e.victim || '').toUpperCase() || '—';
    r.__a.className = attackerLocal
      ? 'me'
      : e.attackerTeam && e.attackerTeam === localTeam
        ? 'ally'
        : e.attackerTeam
          ? 'foe'
          : '';
    r.__v.className =
      e.victimTeam && e.victimTeam === localTeam ? 'ally' : e.victimTeam ? 'foe' : '';
    r.classList.toggle('local', !!e.local);

    // Icon cluster: modifier, weapon, modifier.
    const ic = r.__ico;
    ic.textContent = '';
    if (e.wallbang) ic.appendChild(icon('wallbang', 13));
    if (e.longshot) ic.appendChild(icon('longshot', 13));
    const key = e.melee
      ? 'knife'
      : e.explosive
        ? 'explosive'
        : e.streak
          ? 'strike'
          : weaponIcon(e.weapon, this.ctx.weapons?.defs?.[e.weapon]);
    const wi = icon(key, 19);
    wi.style.color = e.local ? 'var(--accent)' : 'var(--ink)';
    ic.appendChild(wi);
    if (e.headshot) {
      const h = icon('headshot', 14);
      h.style.color = 'var(--accent)';
      ic.appendChild(h);
    }

    r.classList.remove('leave');
    // Newest at the top, the way every shooter does it.
    this.root.insertBefore(r, this.root.firstChild);
    // Restart the entry animation for a recycled node.
    r.classList.remove('enter');
    void r.offsetWidth;
    r.classList.add('enter');

    this.rows.push({ node: r, t: 0 });
    while (this.rows.length > MAX) this._retire(this.rows.shift());
  }

  _retire(item) {
    if (!item || item.dying) return;
    item.dying = true;
    item.node.classList.add('leave');
    item.t = LIFE; // keep it in the list until the fade finishes
    item.dead = 0;
  }

  update(dt) {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const it = this.rows[i];
      it.t += dt;
      if (!it.dying && it.t >= LIFE) this._retire(it);
      if (it.dying) {
        it.dead = (it.dead || 0) + dt;
        if (it.dead > 0.4) {
          it.node.remove();
          it.node.classList.remove('leave', 'enter', 'local');
          if (this.pool.length < 10) this.pool.push(it.node);
          this.rows.splice(i, 1);
        }
      }
    }
  }

  clear() {
    for (const it of this.rows) it.node.remove();
    this.rows.length = 0;
  }

  dispose() {
    this.root.remove();
  }
}

export default Killfeed;
