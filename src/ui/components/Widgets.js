/**
 * Widgets.js — the front end's control vocabulary. Owner: ui agent.
 *
 * Sliders, toggles, segmented pickers, keybind capture buttons and menu rows. All
 * pointer-driven (no native form controls anywhere — a browser <input type=range>
 * would break the look instantly), all keyboard reachable, all animated through CSS
 * transforms rather than layout.
 */
import { div, el, setText, setClass, clamp, clamp01 } from './dom.js';

/** A labelled row inside a settings panel. */
export function row(parent, label) {
  const r = div('codm-row', parent);
  el('label', '', r, label);
  return r;
}

export function section(parent, label) {
  return div('codm-sec', parent, label);
}

/**
 * @param {HTMLElement} parent
 * @param {{min:number,max:number,step?:number,value:number,format?:Function,
 *          onChange:Function, onDone?:Function}} o
 */
export function slider(parent, o) {
  const wrap = div('codm-slider', parent);
  div('trk', wrap);
  const fil = div('fil', wrap);
  const kn = div('kn', wrap);
  const min = o.min;
  const max = o.max;
  const step = o.step || (max - min) / 100;
  let value = clamp(o.value, min, max);
  let dragging = false;

  const paint = () => {
    const t = clamp01((value - min) / (max - min || 1));
    fil.style.width = `${(t * 100).toFixed(2)}%`;
    kn.style.left = `${(t * 100).toFixed(2)}%`;
    if (o.readout) setText(o.readout, o.format ? o.format(value) : String(Math.round(value * 100) / 100));
  };

  const fromEvent = (e) => {
    const r = wrap.getBoundingClientRect();
    const t = clamp01((e.clientX - r.left) / (r.width || 1));
    const raw = min + t * (max - min);
    const snapped = Math.round(raw / step) * step;
    const next = clamp(Math.round(snapped * 1e6) / 1e6, min, max);
    if (next !== value) {
      value = next;
      paint();
      o.onChange?.(value);
    }
  };

  wrap.addEventListener('pointerdown', (e) => {
    dragging = true;
    wrap.setPointerCapture?.(e.pointerId);
    fromEvent(e);
    e.stopPropagation();
  });
  wrap.addEventListener('pointermove', (e) => {
    if (dragging) fromEvent(e);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      wrap.releasePointerCapture?.(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    o.onDone?.(value);
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);

  paint();
  return {
    node: wrap,
    get value() {
      return value;
    },
    set(v) {
      value = clamp(v, min, max);
      paint();
    },
  };
}

export function toggle(parent, on, onChange) {
  const t = div('codm-toggle', parent);
  el('i', '', t);
  let v = !!on;
  setClass(t, 'on', v);
  t.addEventListener('click', (e) => {
    e.stopPropagation();
    v = !v;
    setClass(t, 'on', v);
    onChange?.(v);
  });
  return {
    node: t,
    get value() {
      return v;
    },
    set(next) {
      v = !!next;
      setClass(t, 'on', v);
    },
  };
}

/** @param {Array<{id:string,label:string}>} options */
export function segmented(parent, options, value, onChange) {
  const s = div('codm-seg', parent);
  const btns = new Map();
  for (const o of options) {
    const b = el('button', '', s, o.label);
    b.type = 'button';
    btns.set(o.id, b);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      select(o.id);
      onChange?.(o.id);
    });
  }
  function select(id) {
    for (const [k, b] of btns) setClass(b, 'sel', k === id);
  }
  select(value);
  return { node: s, select, get value() { return value; } };
}

export function button(parent, label, onClick, cls) {
  const b = el('button', 'codm-btn' + (cls ? ' ' + cls : ''), parent, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick?.(e);
  });
  return b;
}

/**
 * A keybind capture button. Clicking arms it; the next keydown (or mouse button)
 * becomes the binding. Escape cancels.
 */
export function keybind(parent, code, onBind) {
  const b = div('codm-key', parent, prettyKey(code));
  let listening = false;

  const stop = () => {
    listening = false;
    setClass(b, 'listen', false);
    // Tells the menu's own Escape handler to stand down for this keypress.
    delete document.documentElement.dataset.codBinding;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
  };
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    stop();
    if (e.code === 'Escape') return;
    setText(b, prettyKey(e.code));
    onBind?.(e.code);
  };
  const onMouse = (e) => {
    if (e.target === b) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  };

  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (listening) {
      stop();
      return;
    }
    listening = true;
    setClass(b, 'listen', true);
    setText(b, 'PRESS A KEY');
    document.documentElement.dataset.codBinding = '1';
    setTimeout(() => {
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('mousedown', onMouse, true);
    }, 0);
  });

  return { node: b, set: (c) => setText(b, prettyKey(c)), stop };
}

export function prettyKey(code) {
  const c = String(code || '');
  if (!c) return '—';
  if (c.startsWith('Key')) return c.slice(3);
  if (c.startsWith('Digit')) return c.slice(5);
  if (c.startsWith('Arrow')) return c.slice(5).toUpperCase();
  const map = {
    Space: 'SPACE',
    ShiftLeft: 'L SHIFT',
    ShiftRight: 'R SHIFT',
    ControlLeft: 'L CTRL',
    ControlRight: 'R CTRL',
    AltLeft: 'L ALT',
    AltRight: 'R ALT',
    Tab: 'TAB',
    Escape: 'ESC',
    Enter: 'ENTER',
    Backquote: '`',
    CapsLock: 'CAPS',
  };
  return map[c] || c.toUpperCase();
}

/** A vertical list item used by the main menu / pause nav. */
export function navItem(parent, label, hint, onClick) {
  const n = div('codm-item', parent);
  el('i', 'mk', n);
  el('span', '', n, label);
  if (hint) el('span', 'hint', n, hint);
  n.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick?.(e);
  });
  return n;
}
