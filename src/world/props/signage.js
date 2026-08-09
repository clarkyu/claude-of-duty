/**
 * props/signage.js — the town's written language. Owner: props agent.
 *
 * A street without a single readable glyph reads as a blockout no matter how good the
 * geometry is. Everything in this file exists to put *language* on the world: shop
 * fascias, unit numbers, street plates, painted stencils, hazard placards, spray-can
 * graffiti and road markings — plus the ground grime (cracks, skid marks, oil stains)
 * that shares the same atlas because it is drawn the same way.
 *
 * ── How it works ────────────────────────────────────────────────────────────────
 * One 1024² canvas is drawn at boot with the 2D context (fonts, paths, spray dots,
 * scratches) and uploaded as a single `THREE.CanvasTexture`. Every sign in the map is
 * a quad whose UVs point at one *cell* of that atlas, so the entire written layer of
 * the world costs **one texture and one draw call per district per material** — two
 * materials: an opaque board face and an alpha-tested decal.
 *
 * The layout is pure (`signageLayout()`) and the drawing is pure (`drawSignageAtlas()`),
 * which means the atlas can be rendered and inspected outside the game.
 *
 * Language mix is Levantine/Maghrebi: Arabic primary, French/English secondary. Arabic
 * is laid out with `ctx.direction = 'rtl'`; the browser's shaper does the joining.
 *
 * Public API:
 *   signageLayout()                  -> { W, H, cells, groups }
 *   drawSignageAtlas(g, layout, rnd) draws the whole atlas into a 2D context
 *   cellUv(layout, name)             -> [u0, v0, u1, v1]  (v already flipped for GL)
 *   signQuad(width, height, uv, o)   -> Prim  a UV-mapped quad in the XY plane
 */

/* ========================================================================== */
/*                                   layout                                   */
/* ========================================================================== */

export const ATLAS_W = 1024;
export const ATLAS_H = 1024;

/** Shop fascias: Arabic name, Latin strapline, board colour, paint colour. */
const SHOPS = [
  { ar: 'مخبز الشام', la: 'BOULANGERIE AL-CHAM', bg: '#1c4a35', fg: '#f0e5c8' },
  { ar: 'صيدلية النور', la: 'PHARMACIE AL-NOUR', bg: '#0e5257', fg: '#eef4ef' },
  { ar: 'سوبر ماركت المدينة', la: 'SUPERMARCHE EL-MEDINA', bg: '#8a2c21', fg: '#f2e4c8' },
  { ar: 'مقهى الياسمين', la: 'CAFE YASMINE', bg: '#1f3a56', fg: '#e5d6b2' },
  { ar: 'ورشة ميكانيك', la: 'GARAGE MECANIQUE 24H', bg: '#35383d', fg: '#dcb944' },
  { ar: 'خضار و فواكه', la: 'FRUITS & LEGUMES', bg: '#455618', fg: '#efe8d0' },
  { ar: 'أدوات منزلية', la: 'QUINCAILLERIE HAMDI', bg: '#54431f', fg: '#ecdfbc' },
  { ar: 'مطعم البركة', la: 'RESTAURANT AL-BARAKA', bg: '#74201a', fg: '#eddaa8' },
];

/** Small enamel plates: unit numbers and street names. */
const PLATES = [
  { kind: 'unit', la: '12', ar: '١٢' },
  { kind: 'unit', la: '14 A', ar: '١٤' },
  { kind: 'unit', la: '27', ar: '٢٧' },
  { kind: 'unit', la: '33', ar: '٣٣' },
  { kind: 'unit', la: '8', ar: '٨' },
  { kind: 'unit', la: '41', ar: '٤١' },
  { kind: 'unit', la: '6 B', ar: '٦' },
  { kind: 'unit', la: '19', ar: '١٩' },
  { kind: 'street', ar: 'شارع السوق', la: 'RUE DU SOUK' },
  { kind: 'street', ar: 'زقاق النخيل', la: 'IMPASSE NAKHIL' },
  { kind: 'street', ar: 'شارع المينا', la: 'RUE DU PORT' },
  { kind: 'street', ar: 'ساحة الجامع', la: 'PLACE DE LA MOSQUEE' },
  { kind: 'notice', ar: 'للإيجار', la: 'A LOUER  071 44 18' },
  { kind: 'notice', ar: 'مفتوح', la: 'OUVERT 07-21' },
  { kind: 'notice', ar: 'عيادة', la: 'CLINIQUE  1er ETAGE' },
  { kind: 'notice', ar: 'ماء صالح للشرب', la: 'EAU POTABLE' },
];

/** Sprayed / stencilled marks. Transparent ground: these go straight onto the wall. */
const STENCILS = [
  { ar: 'ممنوع الوقوف', la: 'STATIONNEMENT INTERDIT', col: '#d8d2c4' },
  { ar: 'خطر — كهرباء', la: 'DANGER 380V', col: '#e0c23a' },
  { ar: 'منطقة عسكرية', la: 'ZONE MILITAIRE', col: '#d8d2c4' },
  { ar: 'قابل للاشتعال', la: 'INFLAMMABLE', col: '#d9543a' },
  { ar: 'مخرج طوارئ', la: 'SORTIE DE SECOURS', col: '#7fc48a' },
  { ar: 'ممنوع التصوير', la: 'PHOTO INTERDITE', col: '#d8d2c4' },
  { ar: 'القطاع ٧', la: 'SECTEUR 7', col: '#c9c2b0' },
  { ar: 'تم التفتيش ٠٤-١٢', la: 'CLEARED 04-12', col: '#e4a63c' },
  { ar: 'توزيع المساعدات', la: 'DISTRIBUTION AIDE', col: '#8fb8d8' },
  { ar: 'احذر الحفرة', la: 'ATTENTION TRAVAUX', col: '#e0c23a' },
  { ar: 'بلوك ٢٤', la: 'BLOC 24', col: '#cbc4b2' },
  { ar: 'ماء', la: 'EAU  -  3m', col: '#8fb8d8' },
];

/** Spray-can tags. */
const TAGS = [
  { t: 'حرية', col: '#c4342a', style: 'brush' },
  { t: 'AL-SHAM', col: '#1d1f22', style: 'marker' },
  { t: 'K7', col: '#2d6ea8', style: 'bubble' },
  { t: 'الشعب', col: '#1d1f22', style: 'brush' },
  { t: '2011', col: '#c4342a', style: 'marker' },
  { t: 'ZRK', col: '#3f8a3c', style: 'bubble' },
  { t: 'NO WAR', col: '#1d1f22', style: 'marker' },
  { t: 'سلام', col: '#2d6ea8', style: 'brush' },
];

/**
 * Road markings live in 128 x 96 cells that are stretched onto a 1.4 x 3.6 m patch
 * when they are laid — the long axis running down the lane. Drawing them square and
 * stretching in world space is what gives arrows and text the elongation real road
 * paint has, so they read correctly from a driver's (or a player's) eye height.
 */
const ROADS = ['arrow_ahead', 'arrow_left', 'arrow_right', 'road_stop', 'road_slow', 'lane_dash', 'zebra', 'hatch'];
const GRIME = ['crack_a', 'crack_b', 'skid', 'stain'];

/**
 * Cell rectangles, in canvas pixels with y measured from the top.
 * @returns {{W:number,H:number,cells:Record<string,{x:number,y:number,w:number,h:number,kind:string,i:number}>,groups:Record<string,string[]>}}
 */
export function signageLayout() {
  const cells = {};
  const groups = { fascia: [], grime: [], plate: [], unit: [], street: [], notice: [], stencil: [], graffiti: [], road: [] };
  const put = (name, kind, x, y, w, h, i) => {
    cells[name] = { x, y, w, h, kind, i };
    return name;
  };

  /* fascias: 2 x 4 of 512 x 96 -> y 0..384 */
  for (let i = 0; i < 8; i++) {
    const c = i % 2;
    const r = (i / 2) | 0;
    groups.fascia.push(put(`fascia${i}`, 'fascia', c * 512, r * 96, 512, 96, i));
  }
  /* ground grime: 4 x 1 of 256 x 96 -> y 384..480 */
  for (let i = 0; i < 4; i++) groups.grime.push(put(GRIME[i], 'grime', i * 256, 384, 256, 96, i));
  /* plates: 8 x 2 of 128 x 64 -> y 480..608 */
  for (let i = 0; i < 16; i++) {
    const c = i % 8;
    const r = (i / 8) | 0;
    const def = PLATES[i];
    const name = put(`plate${i}`, def.kind, c * 128, 480 + r * 64, 128, 64, i);
    groups.plate.push(name);
    groups[def.kind].push(name);
  }
  /* stencils: 4 x 3 of 256 x 64 -> y 608..800 */
  for (let i = 0; i < 12; i++) {
    const c = i % 4;
    const r = (i / 4) | 0;
    groups.stencil.push(put(`stencil${i}`, 'stencil', c * 256, 608 + r * 64, 256, 64, i));
  }
  /* graffiti: 4 x 2 of 256 x 64 -> y 800..928 */
  for (let i = 0; i < 8; i++) {
    const c = i % 4;
    const r = (i / 4) | 0;
    groups.graffiti.push(put(`tag${i}`, 'graffiti', c * 256, 800 + r * 64, 256, 64, i));
  }
  /* road markings: 8 x 1 of 128 x 96 -> y 928..1024 */
  for (let i = 0; i < 8; i++) groups.road.push(put(ROADS[i], 'road', i * 128, 928, 128, 96, i));

  return { W: ATLAS_W, H: ATLAS_H, cells, groups };
}

/**
 * UV rect for a cell, already flipped for a `flipY` texture, and inset by half a
 * texel so a mip level can never bleed a neighbouring cell across the border.
 * @returns {[number,number,number,number]} [u0, v0, u1, v1] with v0 at the cell BOTTOM
 */
export function cellUv(layout, name) {
  const c = layout.cells[name] || layout.cells[layout.groups.fascia[0]];
  const pad = 1.0;
  const u0 = (c.x + pad) / layout.W;
  const u1 = (c.x + c.w - pad) / layout.W;
  const v1 = 1 - (c.y + pad) / layout.H;
  const v0 = 1 - (c.y + c.h - pad) / layout.H;
  return [u0, v0, u1, v1];
}

/** Aspect ratio (w/h) of a cell — sizes a sign so its text is never squashed. */
export function cellAspect(layout, name) {
  const c = layout.cells[name];
  return c ? c.w / c.h : 4;
}

/* ========================================================================== */
/*                              drawing utilities                             */
/* ========================================================================== */

const FONT = "'DejaVu Sans', 'Liberation Sans', 'FreeSans', sans-serif";
const FONT_MONO = "'DejaVu Sans Mono', 'Liberation Mono', monospace";

/** Shrink until it fits, then return the size actually used. */
function fitFont(g, text, maxW, px, weight = '700', family = FONT) {
  let size = px;
  for (let i = 0; i < 22; i++) {
    g.font = `${weight} ${size}px ${family}`;
    if (g.measureText(text).width <= maxW || size <= 7) break;
    size -= Math.max(1, size * 0.07);
  }
  return size;
}

/** Per-pixel speckle. Cheap, and it is what stops flat paint reading as vector art. */
function grain(g, x, y, w, h, rnd, amount = 0.1, dark = true) {
  const n = Math.round(w * h * amount * 0.05);
  for (let i = 0; i < n; i++) {
    const px = x + rnd() * w;
    const py = y + rnd() * h;
    const a = rnd() * 0.22;
    g.fillStyle = dark ? `rgba(20,16,12,${a.toFixed(3)})` : `rgba(255,248,232,${a.toFixed(3)})`;
    g.fillRect(px, py, 1 + (rnd() < 0.2 ? 1 : 0), 1);
  }
}

/** Vertical dirt runs from the top edge — every outdoor sign has them. */
function streaks(g, x, y, w, h, rnd, count = 9, alpha = 0.2) {
  for (let i = 0; i < count; i++) {
    const sx = x + rnd() * w;
    const sw = 1 + rnd() * 4;
    const sh = h * (0.25 + rnd() * 0.75);
    const grd = g.createLinearGradient(0, y, 0, y + sh);
    grd.addColorStop(0, `rgba(38,31,22,${(alpha * (0.6 + rnd() * 0.6)).toFixed(3)})`);
    grd.addColorStop(1, 'rgba(38,31,22,0)');
    g.fillStyle = grd;
    g.fillRect(sx, y, sw, sh);
  }
}

/** Punch paint away — chips, flaking and scratches. Requires a clipped cell. */
function chip(g, x, y, w, h, rnd, count = 26, scale = 1) {
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < count; i++) {
    const px = x + rnd() * w;
    const py = y + rnd() * h;
    const r = (0.6 + rnd() * 3.4) * scale;
    g.beginPath();
    const pts = 5 + ((rnd() * 3) | 0);
    for (let k = 0; k <= pts; k++) {
      const a = (k / pts) * Math.PI * 2;
      const rr = r * (0.5 + rnd() * 0.8);
      const vx = px + Math.cos(a) * rr;
      const vy = py + Math.sin(a) * rr;
      if (k === 0) g.moveTo(vx, vy);
      else g.lineTo(vx, vy);
    }
    g.closePath();
    g.fillStyle = 'rgba(0,0,0,1)';
    g.fill();
  }
  /* a couple of long scratches */
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    g.strokeStyle = `rgba(0,0,0,${(0.35 + rnd() * 0.5).toFixed(2)})`;
    g.lineWidth = (0.6 + rnd() * 1.1) * scale;
    g.beginPath();
    let px = x + rnd() * w;
    let py = y + rnd() * h;
    g.moveTo(px, py);
    for (let k = 0; k < 4; k++) {
      px += (rnd() - 0.5) * w * 0.35;
      py += (rnd() - 0.5) * h * 0.5;
      g.lineTo(px, py);
    }
    g.stroke();
  }
  g.restore();
}

/** Soft spray dots around a path — the aerosol overspray halo. */
function overspray(g, x, y, w, h, rnd, colour, count = 260) {
  g.save();
  for (let i = 0; i < count; i++) {
    const px = x + rnd() * w;
    const py = y + rnd() * h;
    const r = 0.4 + rnd() * 1.4;
    g.globalAlpha = 0.03 + rnd() * 0.12;
    g.fillStyle = colour;
    g.beginPath();
    g.arc(px, py, r, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** Paint drips running down from a baseline. */
function drips(g, x0, x1, y, rnd, colour, count = 5, maxLen = 22) {
  g.save();
  g.fillStyle = colour;
  for (let i = 0; i < count; i++) {
    const px = x0 + rnd() * (x1 - x0);
    const len = 4 + rnd() * maxLen;
    const wdt = 1 + rnd() * 2.2;
    g.globalAlpha = 0.55 + rnd() * 0.4;
    g.fillRect(px, y, wdt, len);
    g.beginPath();
    g.arc(px + wdt * 0.5, y + len, wdt * 0.75, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** Arabic text, right-aligned, RTL — the browser's shaper does the joining. */
function arabic(g, text, x, y, maxW, px, colour, weight = '700') {
  g.save();
  g.direction = 'rtl';
  g.textAlign = 'right';
  g.textBaseline = 'alphabetic';
  fitFont(g, text, maxW, px, weight);
  g.fillStyle = colour;
  g.fillText(text, x, y);
  g.restore();
}

/** Latin text, condensed a little so a strapline fills its board. */
function latin(g, text, x, y, maxW, px, colour, align = 'left', weight = '700', family = FONT) {
  g.save();
  g.direction = 'ltr';
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  const size = fitFont(g, text, maxW / 0.86, px, weight, family);
  g.translate(x, y);
  g.scale(0.86, 1);
  g.font = `${weight} ${size}px ${family}`;
  g.fillStyle = colour;
  g.fillText(text, 0, 0);
  g.restore();
  return size;
}

/* ========================================================================== */
/*                                 the atlas                                  */
/* ========================================================================== */

/**
 * @param {CanvasRenderingContext2D} g
 * @param {ReturnType<signageLayout>} layout
 * @param {() => number} rnd deterministic 0..1
 */
export function drawSignageAtlas(g, layout, rnd) {
  g.clearRect(0, 0, layout.W, layout.H);
  g.lineJoin = 'round';

  const cell = (name, fn) => {
    const c = layout.cells[name];
    if (!c) return;
    g.save();
    g.beginPath();
    g.rect(c.x, c.y, c.w, c.h);
    g.clip();
    g.translate(c.x, c.y);
    fn(c.w, c.h, c);
    g.restore();
  };

  /* ── shop fascias ──────────────────────────────────────────────────────── */
  layout.groups.fascia.forEach((name, i) => {
    const s = SHOPS[i % SHOPS.length];
    cell(name, (w, h) => {
      /* enamelled board with a gradient and a painted border */
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, shade(s.bg, 1.16));
      grd.addColorStop(0.55, s.bg);
      grd.addColorStop(1, shade(s.bg, 0.78));
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
      g.strokeStyle = hexA(s.fg, 0.5);
      g.lineWidth = 2;
      g.strokeRect(4.5, 4.5, w - 9, h - 9);
      g.strokeStyle = hexA(s.fg, 0.16);
      g.lineWidth = 1;
      g.strokeRect(9.5, 9.5, w - 19, h - 19);

      /* Arabic name across the top two thirds, Latin strapline under it */
      arabic(g, s.ar, w - 20, h * 0.52, w - 44, 44, s.fg);
      latin(g, s.la, 20, h * 0.86, w - 44, 21, hexA(s.fg, 0.9));
      /* a phone number in the corner, because real ones always have one */
      latin(g, `0${(21 + i * 7) % 90}-${(100 + i * 37) % 900} ${(100 + i * 53) % 900}`, w - 20, h * 0.86, w * 0.3, 15,
        hexA(s.fg, 0.6), 'right', '400', FONT_MONO);

      streaks(g, 0, 0, w, h, rnd, 11, 0.26);
      grain(g, 0, 0, w, h, rnd, 0.13);
      chip(g, 0, 0, w, h, rnd, 30, 1.0);
      /* rust bleed from the fixings */
      for (const fx of [w * 0.08, w * 0.92]) {
        const rg = g.createRadialGradient(fx, h * 0.16, 1, fx, h * 0.16, h * 0.5);
        rg.addColorStop(0, 'rgba(96,52,22,0.55)');
        rg.addColorStop(1, 'rgba(96,52,22,0)');
        g.fillStyle = rg;
        g.fillRect(fx - h * 0.5, 0, h, h);
      }
    });
  });

  /* ── ground grime: cracks, skid, stain ─────────────────────────────────── */
  cell('crack_a', (w, h) => crackNet(g, w, h, rnd, 8));
  cell('crack_b', (w, h) => crackNet(g, w, h, rnd, 13));
  cell('skid', (w, h) => {
    for (const off of [h * 0.3, h * 0.68]) {
      g.save();
      g.globalAlpha = 0.62;
      const grd = g.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0, 'rgba(18,16,15,0)');
      grd.addColorStop(0.25, 'rgba(18,16,15,0.9)');
      grd.addColorStop(0.85, 'rgba(18,16,15,0.55)');
      grd.addColorStop(1, 'rgba(18,16,15,0)');
      g.fillStyle = grd;
      for (let x = 0; x < w; x += 2) {
        const wob = Math.sin(x * 0.05 + off) * 2.4;
        g.fillRect(x, off + wob - 5, 2.2, 10);
      }
      g.restore();
      grain(g, 0, off - 8, w, 16, rnd, 0.5);
    }
  });
  cell('stain', (w, h) => {
    for (let i = 0; i < 5; i++) {
      const cx = w * (0.2 + rnd() * 0.6);
      const cy = h * (0.2 + rnd() * 0.6);
      const r = h * (0.2 + rnd() * 0.4);
      const grd = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
      grd.addColorStop(0, 'rgba(14,12,10,0.72)');
      grd.addColorStop(0.6, 'rgba(20,17,13,0.34)');
      grd.addColorStop(1, 'rgba(20,17,13,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(cx, cy, r * (0.8 + rnd() * 0.6), r * (0.5 + rnd() * 0.5), rnd() * 3, 0, Math.PI * 2);
      g.fill();
    }
    grain(g, 0, 0, w, h, rnd, 0.35);
  });

  /* ── plates ────────────────────────────────────────────────────────────── */
  layout.groups.plate.forEach((name, i) => {
    const p = PLATES[i];
    cell(name, (w, h) => {
      const enamel = p.kind === 'street' ? '#123a6b' : p.kind === 'notice' ? '#e8e1cd' : '#1d3f2c';
      const ink = p.kind === 'notice' ? '#20242a' : '#f2efe4';
      const inset = p.kind === 'unit' ? 22 : 6;
      g.fillStyle = enamel;
      roundRect(g, inset, 5, w - inset * 2, h - 10, 3);
      g.fill();
      g.strokeStyle = hexA(ink, 0.75);
      g.lineWidth = 1.6;
      roundRect(g, inset + 3.5, 8.5, w - inset * 2 - 7, h - 17, 2);
      g.stroke();
      if (p.kind === 'unit') {
        latin(g, p.la, w * 0.5, h * 0.66, w - inset * 2 - 14, 34, ink, 'center');
        arabic(g, p.ar, w - inset - 8, h * 0.28, 24, 14, hexA(ink, 0.8), '400');
      } else {
        arabic(g, p.ar, w - 12, h * 0.44, w - 24, 20, ink);
        latin(g, p.la, 12, h * 0.78, w - 24, 12, hexA(ink, 0.86), 'left', '700', FONT_MONO);
      }
      streaks(g, inset, 5, w - inset * 2, h - 10, rnd, 4, 0.3);
      grain(g, 0, 0, w, h, rnd, 0.16);
      chip(g, inset, 5, w - inset * 2, h - 10, rnd, 12, 0.7);
    });
  });

  /* ── stencils ──────────────────────────────────────────────────────────── */
  layout.groups.stencil.forEach((name, i) => {
    const s = STENCILS[i];
    cell(name, (w, h) => {
      /* stencilled paint straight onto masonry: no ground, hard edges, gaps */
      arabic(g, s.ar, w - 10, h * 0.46, w - 22, 27, s.col);
      latin(g, s.la, 10, h * 0.86, w - 20, 17, hexA(s.col, 0.92), 'left', '700', FONT_MONO);
      /* the stencil bridges: thin gaps that prove it was cut from a sheet */
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      for (let k = 0; k < 5; k++) {
        const yy = h * (0.14 + k * 0.18);
        g.fillRect(0, yy, w, 1.6);
      }
      g.restore();
      overspray(g, 0, 0, w, h, rnd, s.col, 180);
      chip(g, 0, 0, w, h, rnd, 30, 0.8);
    });
  });

  /* ── graffiti ──────────────────────────────────────────────────────────── */
  layout.groups.graffiti.forEach((name, i) => {
    const t = TAGS[i];
    cell(name, (w, h) => {
      const isArabic = /[؀-ۿ]/.test(t.t);
      g.save();
      if (t.style === 'bubble') {
        /* outlined bubble letters: a fat stroke under a lighter fill */
        g.lineJoin = 'round';
        g.lineWidth = 11;
        g.strokeStyle = '#141414';
        g.fillStyle = t.col;
        g.textBaseline = 'alphabetic';
        g.textAlign = 'center';
        const size = fitFont(g, t.t, w - 40, 46, '700');
        g.font = `700 ${size}px ${FONT}`;
        g.translate(w * 0.5, h * 0.78);
        g.rotate(-0.05);
        g.strokeText(t.t, 0, 0);
        g.fillText(t.t, 0, 0);
      } else if (isArabic) {
        g.translate(w * 0.5, h * 0.5);
        g.rotate(-0.04);
        g.translate(-w * 0.5, -h * 0.5);
        arabic(g, t.t, w - 18, h * 0.8, w - 36, 50, t.col, '700');
      } else {
        g.translate(w * 0.5, h * 0.5);
        g.rotate(-0.07);
        g.translate(-w * 0.5, -h * 0.5);
        latin(g, t.t, 16, h * 0.8, w - 32, 44, t.col, 'left', '700');
      }
      g.restore();
      /* a slashing underline, the way a tag is finished */
      g.save();
      g.strokeStyle = t.col;
      g.lineWidth = 3 + rnd() * 3;
      g.lineCap = 'round';
      g.globalAlpha = 0.85;
      g.beginPath();
      g.moveTo(10, h * 0.9);
      g.bezierCurveTo(w * 0.3, h * 0.98, w * 0.7, h * 0.74, w - 12, h * 0.9);
      g.stroke();
      g.restore();
      drips(g, 12, w - 12, h * 0.86, rnd, t.col, 6, 12);
      overspray(g, 0, 0, w, h, rnd, t.col, 300);
      chip(g, 0, 0, w, h, rnd, 24, 0.9);
    });
  });

  /* ── road markings ─────────────────────────────────────────────────────── */
  const shaftArrow = (w, h, bend) => {
    /* head at the top (which becomes "away down the lane" once laid) */
    g.beginPath();
    g.moveTo(w * 0.5, h * 0.03);
    g.lineTo(w * 0.86, h * 0.30);
    g.lineTo(w * 0.65, h * 0.30);
    g.lineTo(w * 0.65, h * 0.97);
    g.lineTo(w * 0.35, h * 0.97);
    g.lineTo(w * 0.35, h * 0.30);
    g.lineTo(w * 0.14, h * 0.30);
    g.closePath();
    g.fill();
    if (bend) {
      /* the turn barb: a second head off the side of the shaft */
      g.save();
      g.translate(w * 0.5, h * 0.46);
      g.rotate(bend * Math.PI * 0.5);
      g.beginPath();
      g.moveTo(0, -h * 0.03);
      g.lineTo(w * 0.40, h * 0.20);
      g.lineTo(w * 0.20, h * 0.20);
      g.lineTo(w * 0.20, h * 0.40);
      g.lineTo(-w * 0.02, h * 0.40);
      g.lineTo(-w * 0.02, h * 0.20);
      g.lineTo(-w * 0.22, h * 0.20);
      g.closePath();
      g.fill();
      g.restore();
    }
  };
  cell('arrow_ahead', (w, h) => roadPaint(g, rnd, w, h, () => shaftArrow(w, h, 0)));
  cell('arrow_left', (w, h) => roadPaint(g, rnd, w, h, () => shaftArrow(w, h, -1)));
  cell('arrow_right', (w, h) => roadPaint(g, rnd, w, h, () => shaftArrow(w, h, 1)));
  const roadWord = (w, h, la, ar) => {
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const size = fitFont(g, la, w - 12, 44, '700');
    g.font = `700 ${size}px ${FONT}`;
    g.fillText(la, w * 0.5, h * 0.28);
    g.direction = 'rtl';
    const s2 = fitFont(g, ar, w - 34, 30, '700');
    g.font = `700 ${s2}px ${FONT}`;
    g.fillText(ar, w * 0.5, h * 0.66);
    g.restore();
  };
  cell('road_stop', (w, h) => roadPaint(g, rnd, w, h, () => roadWord(w, h, 'STOP', 'قف')));
  cell('road_slow', (w, h) => roadPaint(g, rnd, w, h, () => roadWord(w, h, 'SLOW', 'مهل')));
  cell('lane_dash', (w, h) => {
    roadPaint(g, rnd, w, h, () => {
      g.fillRect(w * 0.38, h * 0.06, w * 0.24, h * 0.52);
    });
  });
  cell('zebra', (w, h) => {
    roadPaint(g, rnd, w, h, () => {
      for (let i = 0; i < 3; i++) g.fillRect(w * (0.04 + i * 0.34), 0, w * 0.2, h);
    });
  });
  cell('hatch', (w, h) => {
    roadPaint(g, rnd, w, h, () => {
      g.lineWidth = w * 0.06;
      g.strokeStyle = '#b8b3a4';
      g.strokeRect(w * 0.06, h * 0.04, w * 0.88, h * 0.92);
      g.lineWidth = w * 0.05;
      for (let i = -1; i < 4; i++) {
        g.beginPath();
        g.moveTo(w * 0.06, h * (0.04 + i * 0.3));
        g.lineTo(w * 0.94, h * (0.04 + (i + 1) * 0.3));
        g.stroke();
      }
    });
  });
}

/**
 * Worn road paint: lay the shape, then abrade it hard.
 *
 * Deliberately NOT white. A 128-texel cell stretched onto a 1.4 x 3.6 m patch is
 * 3 cm per texel, so at two metres from the lens a coarse erosion pattern reads as a
 * bite taken out of a bright white slab rather than as wear. The paint is a dirty
 * bone, the erosion is finer and more of it, and there is a grime pass on top.
 */
function roadPaint(g, rnd, w, h, shape) {
  g.fillStyle = '#b8b3a4';
  shape();
  g.save();
  g.globalCompositeOperation = 'destination-out';
  /* the two wheel tracks that wear a marking out first */
  for (const lane of [0.3, 0.72]) {
    const grd = g.createLinearGradient(w * (lane - 0.16), 0, w * (lane + 0.16), 0);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.5, 'rgba(0,0,0,0.5)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }
  g.fillStyle = '#000';
  for (let i = 0; i < 150; i++) {
    const px = rnd() * w;
    const py = rnd() * h;
    const r = 0.5 + rnd() * 3.2;
    g.globalAlpha = 0.25 + rnd() * 0.55;
    g.beginPath();
    g.ellipse(px, py, r, r * (0.4 + rnd() * 0.8), rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 0.4;
  for (let x = 0; x < w; x += 1 + rnd() * 3) g.fillRect(x, 0, 0.6 + rnd() * 1.2, h);
  g.restore();
  grain(g, 0, 0, w, h, rnd, 0.6);
  /* road dirt over the top, so fresh paint never sits on filthy tarmac */
  g.save();
  g.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 26; i++) {
    const px = rnd() * w;
    const py = rnd() * h;
    const r = 3 + rnd() * 14;
    const grd = g.createRadialGradient(px, py, 0, px, py, r);
    grd.addColorStop(0, `rgba(38,34,28,${(0.18 + rnd() * 0.3).toFixed(2)})`);
    grd.addColorStop(1, 'rgba(38,34,28,0)');
    g.fillStyle = grd;
    g.fillRect(px - r, py - r, r * 2, r * 2);
  }
  g.restore();
}

/** Branching crack network with a dark core and a lighter spall lip. */
function crackNet(g, w, h, rnd, seeds) {
  g.save();
  g.lineCap = 'round';
  for (let s = 0; s < seeds; s++) {
    let x = rnd() * w;
    let y = rnd() * h;
    let a = rnd() * Math.PI * 2;
    const branch = (bx, by, ba, depth, width) => {
      let px = bx;
      let py = by;
      let pa = ba;
      const segs = 4 + ((rnd() * 6) | 0);
      g.beginPath();
      g.moveTo(px, py);
      for (let i = 0; i < segs; i++) {
        pa += (rnd() - 0.5) * 0.9;
        const len = 4 + rnd() * 14;
        px += Math.cos(pa) * len;
        py += Math.sin(pa) * len;
        g.lineTo(px, py);
      }
      g.strokeStyle = `rgba(14,12,10,${(0.72 + rnd() * 0.28).toFixed(2)})`;
      g.lineWidth = width;
      g.stroke();
      /* spall lip: a pale hairline offset from the crack */
      g.strokeStyle = 'rgba(232,224,204,0.2)';
      g.lineWidth = width * 0.5;
      g.stroke();
      if (depth > 0 && rnd() < 0.8) branch(px, py, pa + (rnd() - 0.5) * 2, depth - 1, width * 0.7);
      if (depth > 0 && rnd() < 0.5) branch(bx, by, ba + (rnd() - 0.5) * 2.2, depth - 1, width * 0.7);
    };
    branch(x, y, a, 2, 1.1 + rnd() * 1.5);
  }
  g.restore();
}

/* ---------------------------------------------------------------- colours */

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function shade(hex, mul) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * mul)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/* ========================================================================== */
/*                             geometry for a sign                            */
/* ========================================================================== */

/**
 * A UV-mapped quad in the XY plane, +Z facing, centred on the origin — the carrier for
 * every glyph in the world. Returns a `Prim` in the props/geom.js format so it can go
 * straight into an `Accum` with `uvFn`.
 *
 * @param {number} w metres across
 * @param {number} h metres tall
 * @param {[number,number,number,number]} uv [u0,v0,u1,v1]
 * @param {{flipU?:boolean, curve?:number}} o `curve` bows the quad in +Z (shutter slats)
 */
export function signQuad(w, h, uv, o = {}) {
  const [u0, v0, u1, v1] = uv;
  const a = w * 0.5;
  const b = h * 0.5;
  const cols = o.curve ? 5 : 2;
  const p = [];
  const n = [];
  const t = [];
  const i = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < cols; c++) {
      const fu = c / (cols - 1);
      const x = -a + fu * w;
      const y = r === 0 ? -b : b;
      const z = o.curve ? Math.sin(fu * Math.PI) * o.curve : 0;
      p.push(x, y, z);
      n.push(0, 0, 1);
      const uu = o.flipU ? u1 - fu * (u1 - u0) : u0 + fu * (u1 - u0);
      t.push(uu, r === 0 ? v0 : v1);
    }
  }
  for (let c = 0; c < cols - 1; c++) {
    const a0 = c;
    const a1 = c + 1;
    const b0 = cols + c;
    const b1 = cols + c + 1;
    i.push(a0, a1, b1, a0, b1, b0);
  }
  return { p, n, i, uv: t };
}

/**
 * Append a signage quad to an `Accum`. The atlas UVs travel in the prim's own `uv`
 * array, which `Accum.add()` reads through `uvFn` keyed on the vertex index.
 */
export function addSign(acc, matKey, prim, matrix, opts = {}) {
  let k = 0;
  acc.add(matKey, prim, matrix, {
    grime: opts.grime ?? 0.35,
    uvFn: () => {
      const u = prim.uv[k * 2];
      const v = prim.uv[k * 2 + 1];
      k++;
      return [u, v];
    },
  });
  return acc;
}

export default { signageLayout, drawSignageAtlas, cellUv, cellAspect, signQuad, addSign, ATLAS_W, ATLAS_H };
