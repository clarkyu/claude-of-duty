/**
 * icons.js — inline SVG glyph factory. Owner: ui agent.
 *
 * Everything the HUD draws that is not text is a hand-authored path here: weapon
 * silhouettes for the killfeed, equipment and killstreak marks, compass pips. Paths
 * are drawn on a 24×24 grid and stroked, never filled with flat colour, so they keep
 * the thin-line character of the rest of the interface.
 *
 * icon(name, size, cls) -> SVGElement
 */

const NS = 'http://www.w3.org/2000/svg';

/* Each entry: [viewBoxSize, [ ...{d, fill?, w?} ] ] */
const P = {
  /* ── weapon classes: recognisable silhouettes at 22px ─────────────────── */
  ar: [
    { d: 'M2 12h4l1-2h6l1 2h5l2-1v3h-3l-1 2h-3l-1 3h-2l1-3H8l-1 2H5l1-2H2z', fill: 1 },
    { d: 'M13 10V7h2v3', w: 1.2 },
    { d: 'M6 12v3', w: 1.2 },
  ],
  smg: [
    { d: 'M3 12h3l1-2h7l1 2h4v3h-4l-1 2h-2l-1 3h-2l1-3H7l-1 2H4l1-2H3z', fill: 1 },
    { d: 'M11 10V8h2v2', w: 1.2 },
  ],
  dmr: [
    { d: 'M1 12h5l1-2h8l1 2h7v2h-4l-1 2h-3l-1 3h-2l1-3H8l-1 2H5l1-2H1z', fill: 1 },
    { d: 'M10 9h5v1.5h-5z', fill: 1 },
  ],
  lmg: [
    { d: 'M2 11h4l1-2h7l1 2h6v3h-3l-1 2h-3l-1 3h-2l1-3H8l-1 2H5l1-2H2z', fill: 1 },
    { d: 'M4 14a3 3 0 106 0 3 3 0 10-6 0', w: 1.1 },
  ],
  shotgun: [
    { d: 'M2 11h16v2H8l-1 2H5l1-2H2z', fill: 1 },
    { d: 'M2 13.6h14v1.4H2z', fill: 1 },
    { d: 'M16 10h5v4h-5z', fill: 1 },
  ],
  pistol: [
    { d: 'M5 9h11v3h-2l-3 4H9l1-4H5z', fill: 1 },
    { d: 'M6 12l-2 5h3l2-5', fill: 1 },
  ],
  sniper: [
    { d: 'M1 12h6l1-2h9l1 2h5v2h-5l-1 2h-3l-1 3h-2l1-3H8l-1 2H5l1-2H1z', fill: 1 },
    { d: 'M9 8.5h7V10H9z', fill: 1 },
    { d: 'M7 8.5v3M18 8.5v3', w: 1 },
  ],
  knife: [
    { d: 'M3 17l9-11 3 2-8 10z', fill: 1 },
    { d: 'M6 18l-2 2M14 8l4-3', w: 1.4 },
  ],
  /* ── damage kinds ─────────────────────────────────────────────────────── */
  headshot: [
    { d: 'M12 3a7 7 0 017 7v3l1.6 2.6-1.8.6.2 3.4-3 1.4H8l-3-1.4.2-3.4-1.8-.6L5 13v-3a7 7 0 017-7z', w: 1.3 },
    { d: 'M9 12.6a1.6 1.6 0 103.2 0 1.6 1.6 0 10-3.2 0M14.8 12.6a1.6 1.6 0 103.2 0 1.6 1.6 0 10-3.2 0', fill: 1 },
  ],
  explosive: [
    { d: 'M12 2l2.2 5.2L20 5l-2.4 5.4 5.2 1.8-5.2 1.8L20 19l-5.8-2.2L12 22l-2.2-5.2L4 19l2.4-5.4L1.2 12l5.2-1.8L4 5l5.8 2.2z', w: 1.2 },
  ],
  wallbang: [
    { d: 'M3 6v12M8 6v12M13 6v12M18 6v12', w: 1.1 },
    { d: 'M1 12h22', w: 1.6 },
    { d: 'M18 9l4 3-4 3', w: 1.4 },
  ],
  longshot: [
    { d: 'M12 3v3M12 18v3M3 12h3M18 12h3', w: 1.3 },
    { d: 'M12 5.5a6.5 6.5 0 100 13 6.5 6.5 0 100-13', w: 1.3 },
    { d: 'M12 10.6a1.4 1.4 0 100 2.8 1.4 1.4 0 100-2.8', fill: 1 },
  ],
  skull: [
    { d: 'M12 3a8 8 0 018 8v3l-2 1v3h-3v-2h-2v2h-2v-2H9v2H6v-3l-2-1v-3a8 8 0 018-8z', w: 1.2 },
  ],
  /* ── equipment ────────────────────────────────────────────────────────── */
  frag: [
    { d: 'M12 7a5.5 5.5 0 015.5 5.5v1A5.5 5.5 0 0112 19a5.5 5.5 0 01-5.5-5.5v-1A5.5 5.5 0 0112 7z', w: 1.3 },
    { d: 'M10 4.5h4v2.5h-4z', w: 1.2 },
    { d: 'M14 5.5l4-1.5', w: 1.2 },
    { d: 'M8 10.5h8M8 14h8M12 8v10', w: 0.8 },
  ],
  semtex: [
    { d: 'M8 8h8l1.5 8a5.5 5.5 0 01-11 0z', w: 1.3 },
    { d: 'M10 5h4v3h-4z', w: 1.2 },
  ],
  thermite: [
    { d: 'M12 3c3 4 5 5.5 5 9a5 5 0 11-10 0c0-3.5 2-5 5-9z', w: 1.3 },
    { d: 'M12 12c1.2 1.6 2 2.2 2 3.4a2 2 0 11-4 0c0-1.2.8-1.8 2-3.4z', fill: 1 },
  ],
  flash: [
    { d: 'M13 3L6 13h5l-1 8 7-10h-5z', w: 1.3 },
  ],
  stun: [
    { d: 'M12 6a6 6 0 100 12 6 6 0 100-12', w: 1.3 },
    { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2', w: 1.1 },
  ],
  smoke: [
    { d: 'M7 16a3 3 0 010-6 4.5 4.5 0 018.6-1.6A3.5 3.5 0 1117 16z', w: 1.3 },
  ],
  sensor: [
    { d: 'M4 12h4l2-5 3 10 2-5h5', w: 1.4 },
  ],
  /* ── killstreaks ──────────────────────────────────────────────────────── */
  uav: [
    { d: 'M3 10h18l-3 4H6z', w: 1.2 },
    { d: 'M12 14v5M8 19h8', w: 1.2 },
    { d: 'M8 10V6M16 10V6', w: 1 },
  ],
  cuav: [
    { d: 'M3 10h18l-3 4H6z', w: 1.2 },
    { d: 'M4 4l16 16', w: 1.6 },
  ],
  strike: [
    { d: 'M2 7h9l6 3-6 3H2z', w: 1.2 },
    { d: 'M17 10h5', w: 1.2 },
    { d: 'M7 14v6M12 14v4', w: 1.1 },
  ],
  cluster: [
    { d: 'M4 4l3 5M12 3v6M20 4l-3 5', w: 1.2 },
    { d: 'M5 13a1.6 1.6 0 103.2 0 1.6 1.6 0 10-3.2 0M10.4 15a1.6 1.6 0 103.2 0 1.6 1.6 0 10-3.2 0M15.8 13a1.6 1.6 0 103.2 0 1.6 1.6 0 10-3.2 0', fill: 1 },
  ],
  chopper: [
    { d: 'M2 6h20', w: 1.4 },
    { d: 'M12 6v3', w: 1.2 },
    { d: 'M6 12a5 4 0 0110 0l5 2-5 1H8z', w: 1.2 },
    { d: 'M8 15v3h8v-3', w: 1.1 },
  ],
  /* ── misc ─────────────────────────────────────────────────────────────── */
  flag: [
    { d: 'M6 3v18', w: 1.4 },
    { d: 'M6 4h12l-3 4 3 4H6z', w: 1.2 },
  ],
  bomb: [
    { d: 'M11 8a6 6 0 106 6 6 6 0 00-6-6z', w: 1.3 },
    { d: 'M15 7l3-3M18 4l2 1M18 4l-1-2', w: 1.2 },
  ],
  medal: [
    { d: 'M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9L9.5 8z', w: 1.2 },
  ],
  chevron: [{ d: 'M4 15l8-7 8 7', w: 1.6 }],
};

/**
 * @param {string} name key in P
 * @param {number} size pixel size
 * @param {string} [cls] class applied to the <svg>
 * @param {string} [colour] stroke/fill override
 */
export function icon(name, size = 16, cls, colour) {
  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('width', String(size));
  svgEl.setAttribute('height', String(size));
  svgEl.setAttribute('viewBox', '0 0 24 24');
  svgEl.setAttribute('fill', 'none');
  if (cls) svgEl.setAttribute('class', cls);
  const parts = P[name] || P.chevron;
  for (const seg of parts) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', seg.d);
    if (seg.fill) {
      p.setAttribute('fill', colour || 'currentColor');
    } else {
      p.setAttribute('stroke', colour || 'currentColor');
      p.setAttribute('stroke-width', String(seg.w ?? 1.3));
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }
    svgEl.appendChild(p);
  }
  return svgEl;
}

export function hasIcon(name) {
  return !!P[name];
}

/** Map a weapon id / class / kill kind onto an icon key. */
export function weaponIcon(idOrClass, def) {
  const s = String(idOrClass || '').toLowerCase();
  const cls = String(def?.class || '').toLowerCase();
  if (/knife|melee/.test(s)) return 'knife';
  if (/frag|semtex|grenade|rocket|launcher|c4|satchel|thermite|explos/.test(s)) return 'explosive';
  if (/uav|counter|airstrike|cluster|chopper|streak/.test(s)) return 'strike';
  for (const k of ['sniper', 'shotgun', 'pistol', 'lmg', 'dmr', 'smg', 'ar']) {
    if (cls === k || s.startsWith(k + '_') || s.includes(k)) return k;
  }
  return 'ar';
}

export default icon;
