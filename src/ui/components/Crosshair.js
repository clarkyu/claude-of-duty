/**
 * Crosshair.js — dynamic reticle + hitmarkers. Owner: ui agent.
 *
 * The reticle is a four-stroke SVG whose gap is the *real* projection of the
 * weapon's cone half-angle (`ctx.weapons.spread`) onto the framebuffer, so what you
 * see is genuinely where the bullets can go: it breathes with bloom, opens when you
 * sprint or jump, tightens when you crouch, and fades out as the sights come up
 * because the optic is the reticle then.
 *
 * Hitmarkers use four distinct silhouettes so you never have to read a colour to
 * know what happened:
 *   normal        thin X
 *   armour-break  X inside a broken bracket
 *   headshot      X with chevrons top and bottom
 *   lethal        heavy X plus a rotated square, in red
 *
 * API: new Crosshair(root, ctx) → { update(dt), hit(kind), setHidden(b), dispose() }
 */
import { svg, setAttr, setStyle, setClass, clamp, clamp01, damp, replay } from './dom.js';

const KINDS = ['normal', 'armour', 'headshot', 'lethal'];

export class Crosshair {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.wrap = document.createElement('div');
    this.wrap.className = 'cod-cross';
    root.appendChild(this.wrap);

    const s = svg('svg', { class: 'cx', viewBox: '-80 -80 160 160' }, this.wrap);
    this.svg = s;

    // Centre dot.
    this.dot = svg('circle', { class: 'dot', cx: 0, cy: 0, r: 1.05 }, s);

    // Four arms as groups so only one transform attribute changes per arm.
    this.arms = [];
    const g = svg('g', { class: 'arms' }, s);
    this.armGroup = g;
    for (let i = 0; i < 4; i++) {
      const grp = svg('g', {}, g);
      svg('line', { class: 'arm', x1: 0, y1: 0, x2: 0, y2: -7 }, grp);
      this.arms.push(grp);
    }
    // Rotations: up, right, down, left.
    this.armRot = [0, 90, 180, 270];

    /* ── hitmarkers ─────────────────────────────────────────────────────── */
    this.hmWrap = svg('svg', { class: 'cod-hm', viewBox: '-60 -60 120 120' }, this.wrap);
    this.marks = {};
    for (const k of KINDS) {
      const grp = svg('g', {}, this.hmWrap);
      grp.style.display = 'none';
      this.marks[k] = grp;
      buildMark(grp, k);
    }

    this.gap = 8;
    this.gapGoal = 8;
    this.hidden = false;
    this.adsFade = 1;
    this.friendly = false;
    this._lastGap = -1;
    this._lastOpacity = -1;
    this._hmTimer = 0;
    this._lastKind = null;
  }

  /** Project a cone half-angle (radians) to pixels at the current FOV. */
  _project(angle) {
    const cam = this.ctx.camera;
    const h = this.ctx.renderer?.domElement?.clientHeight || window.innerHeight || 900;
    const fov = ((cam?.fov ?? 80) * Math.PI) / 180;
    const half = Math.tan(fov * 0.5);
    if (half <= 0) return 0;
    return (h * 0.5 * Math.tan(clamp(angle, 0, 0.5))) / half;
  }

  update(dt) {
    const w = this.ctx.weapons;
    const player = this.ctx.player;

    // Spread → gap. A floor keeps the reticle from collapsing to a dot on a laser
    // and a ceiling keeps it on screen when you are sprinting with a shotgun.
    let cone = 0;
    try {
      cone = w?.spread ?? 0;
    } catch {
      cone = 0;
    }
    let px = this._project(cone);
    if (!Number.isFinite(px)) px = 8;
    this.gapGoal = clamp(px * 0.62 + 4.5, 4.5, 90);

    // Airborne / sprinting widen further even before the weapon reports it.
    if (player?.isGrounded === false) this.gapGoal *= 1.28;
    if (String(player?.state || '') === 'sprint') this.gapGoal *= 1.22;

    this.gap = damp(this.gap, this.gapGoal, 16, dt);

    const ads = clamp01(w?.adsProgress ?? 0);
    const lower = clamp01(player?.weaponLower ?? 0);
    const targetFade = this.hidden ? 0 : (1 - Math.pow(ads, 0.7)) * (1 - lower * 0.85);
    this.adsFade = damp(this.adsFade, targetFade, 14, dt);

    // Only touch the DOM when something visibly moved.
    if (Math.abs(this.gap - this._lastGap) > 0.25) {
      this._lastGap = this.gap;
      const len = clamp(7 + this.gap * 0.06, 6, 11);
      for (let i = 0; i < 4; i++) {
        const rot = this.armRot[i];
        setAttr(this.arms[i], 'transform', `rotate(${rot}) translate(0 ${-this.gap})`);
        const line = this.arms[i].firstChild;
        setAttr(line, 'y2', (-len).toFixed(1));
      }
    }
    if (Math.abs(this.adsFade - this._lastOpacity) > 0.01) {
      this._lastOpacity = this.adsFade;
      const o = this.adsFade.toFixed(3);
      setStyle(this.armGroup, 'opacity', o);
      // The dot survives a little longer than the arms: it is the last thing to go.
      setStyle(this.dot, 'opacity', Math.min(1, this.adsFade * 1.4).toFixed(3));
    }
  }

  /** @param {{kind?:string, headshot?:boolean, lethal?:boolean, armour?:boolean}} info */
  hit(info = {}) {
    let kind = 'normal';
    if (info.lethal) kind = 'lethal';
    else if (info.headshot) kind = 'headshot';
    else if (info.armour) kind = 'armour';
    if (this._lastKind && this._lastKind !== kind) {
      this.marks[this._lastKind].style.display = 'none';
    }
    this.marks[kind].style.display = '';
    this._lastKind = kind;
    setClass(this.hmWrap, 'kill', kind === 'lethal');
    replay(this.hmWrap, 'go');
  }

  setHidden(v) {
    this.hidden = !!v;
  }

  setFriendly(v) {
    setClass(this.wrap, 'friendly', !!v);
  }

  dispose() {
    this.wrap.remove();
  }
}

/* -------------------------------------------------------------------------- */

function buildMark(g, kind) {
  const ink = '#f4f5f6';
  const red = '#ff4433';
  const warm = '#ffb648';
  const tick = (x1, y1, x2, y2, col, w) =>
    svg('line', {
      x1, y1, x2, y2,
      stroke: col,
      'stroke-width': w,
      'stroke-linecap': 'round',
    }, g);

  if (kind === 'normal') {
    const a = 6, b = 15, w = 2;
    tick(-a, -a, -b, -b, ink, w);
    tick(a, -a, b, -b, ink, w);
    tick(-a, a, -b, b, ink, w);
    tick(a, a, b, b, ink, w);
  } else if (kind === 'armour') {
    const a = 7, b = 14, w = 2;
    tick(-a, -a, -b, -b, ink, w);
    tick(a, -a, b, -b, ink, w);
    tick(-a, a, -b, b, ink, w);
    tick(a, a, b, b, ink, w);
    // Broken bracket: the armour shell cracking open.
    const br = (d) =>
      svg('path', { d, stroke: warm, 'stroke-width': 1.6, fill: 'none', 'stroke-linecap': 'round' }, g);
    br('M-19 -9 L-19 -19 L-9 -19');
    br('M19 -9 L19 -19 L9 -19');
    br('M-19 9 L-19 19 L-9 19');
    br('M19 9 L19 19 L9 19');
  } else if (kind === 'headshot') {
    const a = 6, b = 15, w = 2.2;
    tick(-a, -a, -b, -b, ink, w);
    tick(a, -a, b, -b, ink, w);
    tick(-a, a, -b, b, ink, w);
    tick(a, a, b, b, ink, w);
    const chev = (d) =>
      svg('path', { d, stroke: ink, 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    chev('M-7 -19 L0 -25 L7 -19');
    chev('M-7 19 L0 25 L7 19');
  } else {
    // Lethal: heavier X, rotated square, red.
    const a = 5, b = 17, w = 3;
    tick(-a, -a, -b, -b, red, w);
    tick(a, -a, b, -b, red, w);
    tick(-a, a, -b, b, red, w);
    tick(a, a, b, b, red, w);
    svg('rect', {
      x: -13, y: -13, width: 26, height: 26,
      transform: 'rotate(45)',
      fill: 'none',
      stroke: red,
      'stroke-width': 1.4,
      opacity: 0.75,
    }, g);
  }
}

export default Crosshair;
