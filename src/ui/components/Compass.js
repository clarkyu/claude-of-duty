/**
 * Compass.js — the top-of-screen heading strip. Owner: ui agent.
 *
 * One scrolling strip translated by a single CSS transform per frame (never a
 * relayout), three copies of the 360° tape laid end to end so it wraps seamlessly,
 * and a separate marker layer that clamps objective pips to the edges and fades them
 * as they leave the field of view.
 *
 * Bearing convention: -Z is north, +X is east, matching the level's world axes.
 *
 * API: new Compass(root, ctx) → { update(dt), setMarkers(list), setVisible(b) }
 *      marker = { id, x, z, kind, label, owner }
 */
import { div, setStyle, setClass, clamp, clamp01 } from './dom.js';
import { icon } from './icons.js';

const SPAN = 132; // degrees visible across the strip
const CARDINAL = [
  [0, 'N', true],
  [45, 'NE', false],
  [90, 'E', true],
  [135, 'SE', false],
  [180, 'S', true],
  [225, 'SW', false],
  [270, 'W', true],
  [315, 'NW', false],
];

export class Compass {
  constructor(root, ctx) {
    this.ctx = ctx;
    this.root = div('cod-compass', root);
    this.strip = div('cod-compass-strip', this.root);
    this.markLayer = div('cod-compass-strip', this.root);
    this.markLayer.style.overflow = 'visible';
    div('cod-compass-base', this.root);
    div('cod-compass-needle', this.root);

    this.width = 470;
    this.pxPerDeg = this.width / SPAN;
    this._built = false;
    this._lastX = -99999;
    this.markers = [];
    this.markNodes = new Map();
    this.visible = false;
    // Measuring clientWidth forces layout, so it happens on resize only, never
    // in the frame loop.
    this._needMeasure = true;
  }

  invalidate() {
    this._needMeasure = true;
  }

  _build() {
    const ppd = this.pxPerDeg;
    const total = 1080;
    this.strip.style.width = `${total * ppd}px`;
    this.strip.textContent = '';
    for (let rep = 0; rep < 3; rep++) {
      const base = rep * 360;
      for (let d = 0; d < 360; d += 15) {
        const major = d % 45 === 0;
        const t = div(major ? 'cod-tick major' : 'cod-tick', this.strip);
        t.style.left = `${(base + d) * ppd}px`;
      }
      for (const [deg, label, big] of CARDINAL) {
        const c = div(big ? 'cod-card' : 'cod-card minor', this.strip, label);
        c.style.left = `${(base + deg) * ppd}px`;
      }
    }
    this._built = true;
  }

  resize(w) {
    const width = Math.max(200, w);
    if (Math.abs(width - this.width) < 1 && this._built) return;
    this.width = width;
    this.pxPerDeg = width / SPAN;
    this._build();
    this._lastX = -99999;
  }

  setVisible(v) {
    this.visible = !!v;
    setClass(this.root, 'on', this.visible);
    if (this.visible) this._needMeasure = true;
  }

  /** @param {Array<{id:string,x:number,z:number,kind?:string,label?:string,owner?:string}>} list */
  setMarkers(list) {
    this.markers = Array.isArray(list) ? list.slice(0, 8) : [];
    const seen = new Set();
    for (const m of this.markers) {
      seen.add(m.id);
      const short = String(m.label || '');
      let n = this.markNodes.get(m.id);
      if (!n) {
        n = div('cod-compass-mark', this.markLayer);
        this.markNodes.set(m.id, n);
        n.__glyph = null;
      }
      // A one-letter objective reads better as the letter itself in a diamond;
      // anything longer gets its icon.
      const wantLetter = short.length === 1;
      const key = wantLetter ? short : m.kind || 'flag';
      if (n.__glyph !== key) {
        n.__glyph = key;
        n.textContent = '';
        if (wantLetter) n.textContent = short;
        else n.appendChild(icon(m.kind || 'flag', 12));
      }
      const col =
        m.owner === 'own' ? 'var(--friendly)' : m.owner === 'foe' ? 'var(--danger)' : 'var(--accent)';
      setStyle(n, 'color', col);
    }
    for (const [id, n] of this.markNodes) {
      if (!seen.has(id)) {
        n.remove();
        this.markNodes.delete(id);
      }
    }
  }

  update(dt) {
    if (!this._built) this._build();
    if (this._needMeasure) {
      this._needMeasure = false;
      const w = this.root.clientWidth;
      if (w > 40 && Math.abs(w - this.width) > 2) this.resize(w);
    }
    if (!this.visible) return;

    const yaw = this.ctx.player?.yaw ?? this.ctx.camera?.rotation?.y ?? 0;
    let bearing = (-yaw * 180) / Math.PI;
    bearing = ((bearing % 360) + 360) % 360;

    const ppd = this.pxPerDeg;
    const x = this.width * 0.5 - (bearing + 360) * ppd;
    if (Math.abs(x - this._lastX) > 0.2) {
      this._lastX = x;
      this.strip.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
    }

    if (!this.markers.length) return;
    const px = this.ctx.player?.position?.x ?? this.ctx.camera?.position?.x ?? 0;
    const pz = this.ctx.player?.position?.z ?? this.ctx.camera?.position?.z ?? 0;
    const half = this.width * 0.5;
    for (const m of this.markers) {
      const n = this.markNodes.get(m.id);
      if (!n) continue;
      const dx = m.x - px;
      const dz = m.z - pz;
      let b = (Math.atan2(dx, -dz) * 180) / Math.PI;
      let rel = b - bearing;
      while (rel > 180) rel -= 360;
      while (rel < -180) rel += 360;
      const raw = rel * ppd;
      const clamped = clamp(raw, -half + 12, half - 12);
      const off = Math.abs(raw) - (half - 12);
      const fade = off > 0 ? clamp01(1 - off / (half * 0.9)) * 0.55 + 0.1 : 1;
      n.style.transform = `translate3d(${(half + clamped).toFixed(1)}px,0,0)`;
      setStyle(n, 'opacity', fade.toFixed(2));
    }
  }

  dispose() {
    this.root.remove();
  }
}

export default Compass;
