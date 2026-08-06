/**
 * dom.js — tiny DOM/SVG helpers shared by every UI component. Owner: ui agent.
 *
 * No framework, no dependencies. Everything here is written to make the rest of the
 * interface cheap: element creation that never re-parses HTML, text writers that skip
 * the DOM entirely when the value has not changed, and a spring/ease number counter so
 * scores and reserve counts roll instead of snapping.
 *
 * Public API
 *   el(tag, cls, parent, text) / div(cls, parent, text) / svg(tag, attrs, parent)
 *   setText(node, value)            no-op when unchanged (returns true if written)
 *   setStyle(node, prop, value)     cached, no-op when unchanged
 *   setClass(node, name, on)        cached-ish, cheap
 *   Counter                         eased numeric readout
 *   clamp / clamp01 / lerp / damp / smoothstep / fmtTime / pad2
 *   reducedMotion()                 honours prefers-reduced-motion
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** Frame-rate independent exponential approach. `rate` ≈ 1/e time in Hz. */
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

export function el(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (parent) parent.appendChild(n);
  return n;
}

export function div(cls, parent, text) {
  return el('div', cls, parent, text);
}

export function svg(tag, attrs, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/** Write text only when it actually differs — the single biggest HUD cost saver. */
export function setText(node, value) {
  if (!node) return false;
  const s = value === null || value === undefined ? '' : String(value);
  if (node.__t === s) return false;
  node.__t = s;
  node.textContent = s;
  return true;
}

export function setAttr(node, name, value) {
  if (!node) return false;
  const s = String(value);
  const key = '__a_' + name;
  if (node[key] === s) return false;
  node[key] = s;
  node.setAttribute(name, s);
  return true;
}

export function setStyle(node, prop, value) {
  if (!node) return false;
  const s = String(value);
  const key = '__s_' + prop;
  if (node[key] === s) return false;
  node[key] = s;
  node.style.setProperty(prop, s);
  return true;
}

export function setClass(node, name, on) {
  if (!node) return false;
  const key = '__c_' + name;
  const v = !!on;
  if (node[key] === v) return false;
  node[key] = v;
  node.classList.toggle(name, v);
  return true;
}

/**
 * Restart a CSS animation. `offsetWidth` does not exist on SVG elements, so the
 * reflow is forced with getBoundingClientRect(), which works for both trees.
 */
export function replay(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  try {
    node.getBoundingClientRect();
  } catch {
    /* detached node */
  }
  node.classList.add(cls);
}

let REDUCED = null;
export function reducedMotion() {
  if (REDUCED !== null) return REDUCED;
  try {
    REDUCED = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  } catch {
    REDUCED = false;
  }
  return REDUCED;
}

export function pad2(n) {
  const v = Math.max(0, n | 0);
  return v < 10 ? '0' + v : String(v);
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds || 0));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/**
 * An eased numeric readout. Values roll toward the target at a rate proportional to
 * the distance, so +1 ticks over instantly-ish and +250 spins up like an odometer.
 */
export class Counter {
  constructor(node, opts = {}) {
    this.node = node;
    this.value = opts.start ?? 0;
    this.target = this.value;
    this.rate = opts.rate ?? 9;
    this.format = opts.format || ((v) => String(Math.round(v)));
    // Rolling odometers are motion; under prefers-reduced-motion they just snap.
    this.instant = !!opts.instant || reducedMotion();
    this.done = true;
  }

  set(v, instant) {
    const t = Number.isFinite(v) ? v : 0;
    if (t === this.target && !instant) return;
    this.target = t;
    if (instant || this.instant) {
      this.value = t;
      this.done = false;
    } else {
      this.done = false;
    }
  }

  update(dt) {
    if (this.done) return false;
    const d = this.target - this.value;
    if (Math.abs(d) < 0.5) {
      this.value = this.target;
      this.done = true;
    } else {
      this.value = damp(this.value, this.target, this.rate, dt);
      // Guarantee forward progress on tiny deltas.
      if (Math.abs(this.target - this.value) < 0.5) this.value = this.target;
    }
    return setText(this.node, this.format(this.value));
  }
}

/**
 * A fixed-size pool of DOM nodes reused for transient effects (hitmarkers, damage
 * arcs, floating score). Never allocates during play.
 */
export class NodePool {
  constructor(parent, make, size) {
    this.parent = parent;
    this.items = [];
    for (let i = 0; i < size; i++) {
      const node = make();
      node.style.display = 'none';
      parent.appendChild(node);
      this.items.push({ node, until: -1, data: null });
    }
    this.cursor = 0;
  }

  /** Grab the oldest free slot (or steal the oldest live one). */
  take(now, life) {
    let best = null;
    let bestUntil = Infinity;
    for (const it of this.items) {
      if (it.until <= now) {
        best = it;
        break;
      }
      if (it.until < bestUntil) {
        bestUntil = it.until;
        best = it;
      }
    }
    if (!best) best = this.items[0];
    best.until = now + life;
    best.node.style.display = '';
    return best;
  }

  /** Hide anything that has expired. Returns the live count. */
  sweep(now) {
    let live = 0;
    for (const it of this.items) {
      if (it.until <= 0) continue;
      if (it.until <= now) {
        it.until = -1;
        it.data = null;
        it.node.style.display = 'none';
      } else live++;
    }
    return live;
  }

  clear() {
    for (const it of this.items) {
      it.until = -1;
      it.data = null;
      it.node.style.display = 'none';
    }
  }
}
