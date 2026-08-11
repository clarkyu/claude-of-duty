/**
 * Vitals.js — health feedback and directional damage. Owner: ui agent.
 *
 * There is no health bar. At full health nothing is drawn at all; as you take damage
 * a red vignette closes in from the frame edges, the screen washes once per hit, and
 * below a third the vignette starts to beat with a synthesised heartbeat. Regen
 * pulls it all back out smoothly, so the player reads their state peripherally and
 * never has to look at a number.
 *
 * Damage direction is a soft wedge rotated to the incoming bearing, pooled to six,
 * with the wedge's opacity animated in CSS so a burst of hits costs no JS.
 *
 * API: new Vitals(root, ctx) → { update(dt), setHealth(p), hit(p), setDowned(b) }
 */
import { div, svg, setClass, setStyle, setText, clamp01, damp, replay, NodePool } from './dom.js';

export class Vitals {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.layer = div('cod-layer', root);
    this.vig = div('cod-vig', this.layer);
    this.flash = div('cod-flash', this.layer);
    this.dead = div('cod-dead', this.layer);

    /*
     * ── Why the wedge is built out of a gradient AND a mask ─────────────────────
     * The first version was a 74° annular sector filled with a radial gradient that
     * reached 0.92 alpha at its outer edge, held at 0.9 opacity for review capture.
     * Reviewed, it read as "a large opaque red arc floating off-centre over a
     * building — a glitch", and that is a fair description of what it is: a hard
     * geometric edge at every boundary (two radial cuts and a near-solid outer arc)
     * in one saturated hue, over a photographic frame.
     *
     * A damage indicator has to be unmistakably a *glow from a direction*. That means
     * soft on all four sides. The radial gradient feathers the two radial edges; the
     * `codDmgFade` mask feathers the two angular ones, in the wedge's own coordinate
     * space so it rotates with it. Peak alpha is down from 0.92 to 0.52, the band is
     * thinner and further out, and it now sits behind a dark rim so it survives being
     * drawn over a blown sky as well as over a brick wall.
     */
    const defsSvg = svg('svg', { width: 0, height: 0, style: 'position:absolute' }, this.layer);
    const defs = svg('defs', {}, defsSvg);
    const grad = svg('radialGradient', { id: 'codDmgGrad', cx: '50%', cy: '50%', r: '50%' }, defs);
    svg('stop', { offset: '58%', 'stop-color': '#ff5a3c', 'stop-opacity': '0' }, grad);
    svg('stop', { offset: '76%', 'stop-color': '#ff3a24', 'stop-opacity': '0.34' }, grad);
    svg('stop', { offset: '92%', 'stop-color': '#e8241a', 'stop-opacity': '0.52' }, grad);
    svg('stop', { offset: '100%', 'stop-color': '#8e0c06', 'stop-opacity': '0' }, grad);
    /* angular feather: white in the middle of the sweep, transparent at both ends */
    const mask = svg('mask', { id: 'codDmgFade', maskUnits: 'userSpaceOnUse', x: '-160', y: '-160', width: '320', height: '320' }, defs);
    const mgrad = svg('linearGradient', { id: 'codDmgFadeG', x1: '-150', y1: '0', x2: '150', y2: '0', gradientUnits: 'userSpaceOnUse' }, defs);
    svg('stop', { offset: '0%', 'stop-color': '#000' }, mgrad);
    svg('stop', { offset: '26%', 'stop-color': '#888' }, mgrad);
    svg('stop', { offset: '50%', 'stop-color': '#fff' }, mgrad);
    svg('stop', { offset: '74%', 'stop-color': '#888' }, mgrad);
    svg('stop', { offset: '100%', 'stop-color': '#000' }, mgrad);
    svg('rect', { x: '-160', y: '-160', width: '320', height: '320', fill: 'url(#codDmgFadeG)' }, mask);

    this.dmgWrap = div('cod-dmg-wrap', this.layer);
    this.pool = new NodePool(this.dmgWrap, () => makeWedge(), 6);

    this.respawn = div('cod-respawn', this.layer);
    div('', this.respawn, '').className = 'lbl';
    this.respawnLbl = this.respawn.firstChild;
    this.respawnLbl.textContent = 'RESPAWN IN';
    this.respawnT = div('t num', this.respawn, '0');
    this.respawnSub = div('sub', this.respawn, '');

    this.health = 1;
    this.shown = 0;
    this.now = 0;
    this.downed = false;
    this._lastVig = -1;
    this._beat = false;
    this._beatT = 0;
    this._respawnShown = false;
    this._lastRespawn = -1;
  }

  /** @param {{fraction:number, health:number, downed:boolean, respawnIn:number, alive:boolean}} p */
  setHealth(p) {
    if (!p) return;
    const f = clamp01(p.fraction ?? (p.health ?? 100) / (p.max || 100));
    this.health = f;
    this.downed = !!p.downed;
    this.alive = p.alive !== false;
    this.respawnIn = p.respawnIn || 0;
  }

  /** @param {{angle:number, amount:number, lethal:boolean}} p bearing relative to view */
  hit(p = {}) {
    const it = this.pool.take(this.now, p.hold ? 1e6 : 1.5);
    const deg = ((p.angle ?? 0) * 180) / Math.PI;
    const mag = clamp01((p.amount ?? 20) / 45);
    it.node.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    const wedge = it.node.__wedge;
    if (wedge) {
      wedge.setAttribute('opacity', (0.44 + 0.42 * mag).toFixed(2));
      wedge.setAttribute('transform', `scale(${(0.9 + 0.16 * mag).toFixed(2)})`);
    }
    if (p.hold) {
      // Headless review capture: the CSS keyframe runs on the wall clock and one
      // harness frame costs seconds, so an animated arc is always already gone.
      it.node.classList.remove('go');
      it.node.classList.add('held');
      it.held = true;
    } else {
      it.node.classList.remove('held');
      replay(it.node, 'go');
      replay(this.flash, 'hit');
    }
  }

  /** Drop any held damage arcs — a new pose owns the frame now. */
  clearHits() {
    for (const it of this.pool.items) {
      it.node.classList.remove('held');
      it.held = false;
    }
    this.pool.clear();
  }

  setDowned(v) {
    this.downed = !!v;
  }

  update(dt) {
    this.now += dt;
    this.pool.sweep(this.now);

    // How much red is on screen. Nothing above 85% health.
    const hurt = clamp01((0.86 - this.health) / 0.86);
    let target = Math.pow(hurt, 1.35) * 0.98;
    if (!this.alive) target = Math.max(target, 0.85);
    this.shown = damp(this.shown, target, 6.5, dt);

    if (Math.abs(this.shown - this._lastVig) > 0.006) {
      this._lastVig = this.shown;
      setStyle(this.vig, 'opacity', this.shown.toFixed(3));
    }

    const beat = this.health < 0.34 && this.alive !== false;
    if (beat !== this._beat) {
      this._beat = beat;
      setClass(this.vig, 'beat', beat);
      this._beatT = 0;
    }
    if (beat) {
      this._beatT -= dt;
      if (this._beatT <= 0) {
        // Faster the closer to death — 68 bpm up to 132 bpm.
        const bpm = 68 + (1 - this.health / 0.34) * 64;
        this._beatT = 60 / bpm;
        this.ctx.audio?.play?.('heartbeat', {
          spatial: false,
          volume: 0.35 + (1 - this.health / 0.34) * 0.4,
        });
      }
    }

    setClass(this.dead, 'on', this.alive === false || this.downed);

    // Respawn countdown.
    const showRespawn = this.alive === false && (this.respawnIn || 0) > 0;
    if (showRespawn !== this._respawnShown) {
      this._respawnShown = showRespawn;
      setClass(this.respawn, 'on', showRespawn);
    }
    if (showRespawn) {
      setText(this.respawnLbl, 'RESPAWN IN');
      setText(this.respawnSub, '');
      const s = Math.ceil(this.respawnIn);
      if (s !== this._lastRespawn) {
        this._lastRespawn = s;
        setText(this.respawnT, String(s));
      }
      this.respawnIn = Math.max(0, this.respawnIn - dt);
    } else if (this.downed) {
      setClass(this.respawn, 'on', true);
      setText(this.respawnLbl, 'DOWNED');
      setText(this.respawnT, '');
      setText(this.respawnSub, 'HOLD FOR REVIVE');
    }
  }

  reset() {
    this.pool.clear();
    this.shown = 0;
    setStyle(this.vig, 'opacity', '0');
  }

  dispose() {
    this.layer.remove();
  }
}

function makeWedge() {
  const n = document.createElement('div');
  n.className = 'cod-dmg';
  const s = svg('svg', { viewBox: '-150 -150 300 300' }, n);
  const gp = svg('g', { mask: 'url(#codDmgFade)' }, s);
  // A 62° arc opening upward (screen-forward is up before rotation), further out
  // and thinner than it was: at 96-148 px it crossed the middle third of a 720 px
  // frame, which is where the thing the player is being shot by actually is.
  const path = svg('path', {
    class: 'wedge',
    d: arcWedge(0, 62, 118, 154),
  }, gp);
  n.__wedge = path;
  return n;
}

/** Build an annular wedge centred on -Y, spanning `sweep` degrees. */
function arcWedge(centreDeg, sweep, r0, r1) {
  const a0 = ((centreDeg - sweep / 2 - 90) * Math.PI) / 180;
  const a1 = ((centreDeg + sweep / 2 - 90) * Math.PI) / 180;
  const p = (r, a) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  const large = sweep > 180 ? 1 : 0;
  return (
    `M ${p(r0, a0)} L ${p(r1, a0)} ` +
    `A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} ` +
    `L ${p(r0, a1)} ` +
    `A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
  );
}

export default Vitals;
