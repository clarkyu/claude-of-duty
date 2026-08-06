/**
 * Scoreboard.js — Tab board and the end-of-match summary. Owner: ui agent.
 *
 * Rows are recycled: the board rebuilds its text in place rather than tearing down
 * the DOM, so holding Tab during a firefight costs nothing. The same component
 * renders inside the end-of-match screen (`detached: true`) so the two can never
 * disagree about what the match looked like.
 *
 * API: new Scoreboard(root, ctx, {detached}) → { set(board), setOpen(b), el }
 */
import { div, el, setText, setClass } from './dom.js';

const COLS = ['SCORE', 'K', 'D', 'A', 'KD'];

export class Scoreboard {
  constructor(root, ctx, opts = {}) {
    this.ctx = ctx;
    this.detached = !!opts.detached;
    this.root = div(this.detached ? 'cod-board detached' : 'cod-board', root);
    if (this.detached) {
      this.root.style.cssText = 'position:relative;opacity:1;background:none;inset:auto';
    }

    const head = div('cod-board-head', this.root);
    this.title = el('h2', '', head, 'SCOREBOARD');
    this.sa = el('span', 'sc a num', head, '0');
    el('span', 'vs', head, 'VS');
    this.sb = el('span', 'sc b num', head, '0');

    const teams = div('cod-board-teams', this.root);
    this.colA = div('cod-board-col a', teams);
    this.colB = div('cod-board-col b', teams);
    this.hA = el('h3', '', this.colA, 'ALLIES');
    this.hB = el('h3', '', this.colB, 'OPFOR');
    this.headA = this._head(this.colA);
    this.headB = this._head(this.colB);
    this.rowsA = [];
    this.rowsB = [];

    this.sum = div('cod-board-sum', this.root);
    this.stats = {};
    for (const k of ['KILLS', 'DEATHS', 'ASSISTS', 'ACCURACY', 'BEST STREAK', 'SCORE']) {
      const s = div('cod-stat', this.sum);
      this.stats[k] = el('b', 'num', s, '0');
      el('span', '', s, k);
    }
    this.open = false;
  }

  _head(col) {
    const r = div('cod-row head', col);
    el('span', 'nm', r, 'OPERATOR');
    for (const c of COLS) el('span', '', r, c);
    return r;
  }

  _row(col, list, i) {
    let r = list[i];
    if (!r) {
      r = div('cod-row', col);
      r.__cells = [el('span', 'nm', r, '')];
      for (let k = 0; k < COLS.length; k++) r.__cells.push(el('span', '', r, ''));
      list[i] = r;
    }
    return r;
  }

  setOpen(v) {
    if (this.detached) return;
    this.open = !!v;
    setClass(this.root, 'on', this.open);
  }

  /** @param {object} b scoreboard() payload from Scoring.js */
  set(b) {
    if (!b) return;
    const teams = b.teams || { A: 0, B: 0 };
    setText(this.sa, teams.A ?? 0);
    setText(this.sb, teams.B ?? 0);
    setText(this.title, String(b.mode || 'SCOREBOARD').toUpperCase());

    const localTeam = b.local?.team || this.ctx.game?.localPlayer?.team || 'A';
    const other = localTeam === 'A' ? 'B' : 'A';
    setText(this.hA, 'ALLIES');
    setText(this.hB, 'OPFOR');

    const tr = b.teamRows || {};
    const mine = tr[localTeam] || b.rows || [];
    const theirs = tr[other] || [];
    this._fill(this.colA, this.rowsA, mine);
    this._fill(this.colB, this.rowsB, theirs);
    this.colB.style.display = theirs.length ? '' : 'none';

    const s = b.summary || {};
    setText(this.stats.KILLS, s.kills ?? 0);
    setText(this.stats.DEATHS, s.deaths ?? 0);
    setText(this.stats.ASSISTS, s.assists ?? 0);
    setText(this.stats.ACCURACY, `${s.accuracy ?? 0}%`);
    setText(this.stats['BEST STREAK'], s.bestStreak ?? 0);
    setText(this.stats.SCORE, b.local?.score ?? 0);
  }

  _fill(col, list, rows) {
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i];
      const r = this._row(col, list, i);
      const c = r.__cells;
      setText(c[0], String(d.name || '').toUpperCase());
      setText(c[1], d.score ?? 0);
      setText(c[2], d.kills ?? 0);
      setText(c[3], d.deaths ?? 0);
      setText(c[4], d.assists ?? 0);
      setText(c[5], Number.isFinite(d.kdr) ? d.kdr.toFixed(2) : '0.00');
      setClass(r, 'me', !!d.isLocal);
      setClass(r, 'dead', d.alive === false);
      r.style.display = '';
    }
    for (let i = rows.length; i < list.length; i++) list[i].style.display = 'none';
  }

  dispose() {
    this.root.remove();
  }
}

export default Scoreboard;
