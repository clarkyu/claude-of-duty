/**
 * props/street.js — street furniture generators. Owner: props agent.
 *
 * Every generator has the same shape:
 *
 *   build(a: Accum, r: Rng, o: object) -> { colliders, height, lights? }
 *
 * `a` is a fresh prop-local Accum whose origin is the **ground contact point** and
 * whose +Y is up; the placer transforms the whole thing onto the surface afterwards.
 * `colliders` are prop-local `{type,halfExtents,pos,quat?,surface,dynamic?}` descriptors.
 *
 * House style, which is what separates this from scattered boxes:
 *   - nothing is a single box: a lamp post is a base flange, a tapered column, a bracket
 *     arm, a lantern housing, a lens, a service door and a drop cable;
 *   - every visible edge is chamfered 1-3 cm;
 *   - `r` drives lean, wear, dents and missing parts so no two instances match;
 *   - anything that touches the ground is authored to y = 0 exactly, and the placer
 *     sinks it 15 mm so there is never a seam.
 */
import { chamferBox, cyl, revolve, tube, torusPrim, sheet, blob, xf, lerp, TAU } from './geom.js';

/* ========================================================================== */
/*                                 lamp post                                  */
/* ========================================================================== */

/**
 * Municipal lamp column: cast base, tapered shaft with a joint collar, a swan-neck
 * bracket, a proper lantern with a glazed underside, the service-door cutout, and the
 * feeder cable that always droops off the back of a real one.
 */
export function lampPost(a, r, o = {}) {
  const h = o.height ?? r.range(4.4, 5.2);
  const lean = r.jitter(0.018);
  const arm = o.arm ?? r.range(0.9, 1.35);
  const armYaw = o.armYaw ?? 0;
  const shaftR = 0.075;

  a.push(xf(0, 0, 0, lean, armYaw, r.jitter(0.012)));

  /* cast base flange + bolt collar */
  a.add('steel', revolve([[0, 0], [0.17, 0], [0.175, 0.03], [0.15, 0.075], [0.115, 0.09], [0.11, 0.2], [0.1, 0.24]], 14));
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * TAU + 0.4;
    a.add('steel', cyl(0.014, 0.026, 6, { chamfer: 0.004 }), xf(Math.cos(ang) * 0.145, 0.043, Math.sin(ang) * 0.145));
  }

  /* tapered shaft in two sections with a visible joint */
  a.add('steel', cyl(shaftR, h * 0.55, 12, { chamfer: 0.008, rTop: shaftR * 0.9 }), xf(0, 0.24 + h * 0.275, 0));
  a.add('steel', revolve([[shaftR * 0.9, 0], [shaftR * 1.12, 0.012], [shaftR * 1.12, 0.05], [shaftR * 0.88, 0.062]], 12),
    xf(0, 0.24 + h * 0.55, 0));
  a.add('steel', cyl(shaftR * 0.88, h * 0.45 - 0.06, 12, { chamfer: 0.008, rTop: shaftR * 0.7 }),
    xf(0, 0.30 + h * 0.775, 0));

  /* service door — a shallow recessed panel with two screws */
  a.add('steel', chamferBox(0.09, 0.3, 0.018, 0.006), xf(0, 0.72, shaftR * 0.96), { grime: 0.55 });
  a.add('rust', cyl(0.008, 0.008, 6, { chamfer: 0.002 }), xf(0, 0.85, shaftR + 0.012, Math.PI / 2, 0, 0));
  a.add('rust', cyl(0.008, 0.008, 6, { chamfer: 0.002 }), xf(0, 0.59, shaftR + 0.012, Math.PI / 2, 0, 0));

  /* swan-neck bracket: a quarter arc then a straight run */
  const top = 0.24 + h;
  const pts = [];
  const bendR = 0.42;
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const ang = t * Math.PI * 0.5;
    pts.push([Math.sin(ang) * bendR, top - bendR + Math.cos(ang) * bendR, 0]);
  }
  for (let i = 1; i <= 3; i++) pts.push([bendR + (arm * i) / 3, top - 0.006 * i, 0]);
  a.add('steel', tube(pts, 0.048, 8, { cap: false }));

  /* lantern: housing, cowl, glazed underside, lens */
  const lx = bendR + arm + 0.14;
  const ly = top - 0.03;
  a.add('steel', chamferBox(0.44, 0.11, 0.24, 0.025), xf(lx, ly, 0), { grime: 0.35 });
  a.add('steel', chamferBox(0.5, 0.045, 0.3, 0.02), xf(lx, ly + 0.07, 0), { grime: 0.55 });
  a.add('galv', chamferBox(0.36, 0.05, 0.2, 0.018), xf(lx, ly - 0.07, 0), { grime: 0.3 });
  a.add('lens', chamferBox(0.3, 0.03, 0.16, 0.012), xf(lx, ly - 0.095, 0), { grime: 0.1 });
  /* the hinge lug and the catch, which is what reads as "an object, not a block" */
  a.add('steel', chamferBox(0.03, 0.05, 0.06, 0.008), xf(lx - 0.21, ly - 0.05, 0.08));
  a.add('steel', chamferBox(0.03, 0.05, 0.06, 0.008), xf(lx + 0.21, ly - 0.05, -0.08));

  /* feeder cable drooping from the bracket back down to the shaft */
  const cab = [];
  for (let i = 0; i <= 7; i++) {
    const t = i / 7;
    const cx = lerp(bendR * 0.4, bendR + arm * 0.75, t);
    const sag = Math.sin(t * Math.PI) * 0.11;
    cab.push([cx, top + 0.055 - sag * 0.6 - t * 0.03, -0.055]);
  }
  a.add('rust', tube(cab, 0.011, 5, { cap: false }));

  /* a wrapped-on cable spur down the shaft — every real pole has one */
  if (r.chance(0.5)) {
    const sp = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      sp.push([Math.sin(t * 4.2) * 0.02 - shaftR * 0.9, lerp(2.4, 0.5, t), Math.cos(t * 4.2) * 0.02]);
    }
    a.add('rust', tube(sp, 0.009, 5, { cap: false }));
  }

  a.pop();
  return {
    colliders: [{ type: 'box', halfExtents: [0.14, (0.24 + h) / 2, 0.14], pos: [0, (0.24 + h) / 2, 0], surface: 'metal' }],
    height: 0.24 + h,
    radius: 0.2,
    lights: [
      {
        kind: 'point',
        pos: [Math.sin(armYaw) * 0 + Math.cos(armYaw) * lx, ly - 0.14, -Math.sin(armYaw) * lx],
        color: 0xffc98a,
        intensity: 9,
        distance: 13,
      },
    ],
  };
}

/* ========================================================================== */
/*                               small furniture                              */
/* ========================================================================== */

/** Cast-iron bollard: ring-topped, scuffed, always slightly out of plumb. */
export function bollard(a, r) {
  const h = r.range(0.86, 0.98);
  a.push(xf(0, 0, 0, r.jitter(0.05), r.range(0, TAU), r.jitter(0.05)));
  a.add('steel', revolve(
    [
      [0, 0], [0.115, 0], [0.12, 0.02], [0.105, 0.05], [0.082, 0.07], [0.078, h - 0.22],
      [0.092, h - 0.19], [0.092, h - 0.14], [0.076, h - 0.11], [0.076, h - 0.05],
      [0.06, h - 0.012], [0.03, h], [0, h],
    ],
    14
  ));
  /* reflective band */
  a.add('signWhite', revolve([[0.081, h - 0.32], [0.081, h - 0.26]], 14), null, { grime: 0.4 });
  a.pop();
  return { colliders: [{ type: 'box', halfExtents: [0.12, h / 2, 0.12], pos: [0, h / 2, 0], surface: 'metal' }], height: h, radius: 0.13 };
}

/** Kerbstone run — a low chamfered edge with a joint gap every 0.9 m. */
export function kerbRun(a, r, o = {}) {
  const len = o.length ?? 3.6;
  const h = o.h ?? 0.16;
  const n = Math.max(1, Math.round(len / 0.9));
  const seg = len / n;
  for (let i = 0; i < n; i++) {
    const z = -len / 2 + seg * (i + 0.5);
    const drop = r.jitter(0.012);
    a.add('paving', chamferBox(0.3, h + 0.24, seg - 0.02, 0.022), xf(0, (h + 0.24) / 2 - 0.24 + drop, z, 0, r.jitter(0.008), 0), {
      grimeHeight: 0.2,
    });
  }
  return { colliders: [{ type: 'box', halfExtents: [0.15, h / 2, len / 2], pos: [0, h / 2, 0], surface: 'concrete' }], height: h };
}

/** Gully grate set into a concrete surround. */
export function drainGrate(a, r) {
  const w = 0.42;
  const l = 0.6;
  a.add('paving', chamferBox(w + 0.14, 0.1, l + 0.14, 0.012), xf(0, -0.045, 0), { grime: 1 });
  /* the bars, with one bent and one missing so it is not a repeated pattern */
  const bars = 7;
  const gone = r.int(bars);
  for (let i = 0; i < bars; i++) {
    if (i === gone && r.chance(0.35)) continue;
    const z = -l / 2 + 0.05 + (i * (l - 0.1)) / (bars - 1);
    const bend = i === (gone + 2) % bars ? r.range(0.06, 0.12) : 0;
    a.add('rust', chamferBox(w, 0.035, 0.028, 0.006), xf(0, -0.012 - bend * 0.4, z, bend, 0, 0), { grime: 1.2 });
  }
  a.add('rust', chamferBox(0.03, 0.05, l, 0.008), xf(-w / 2 - 0.005, -0.015, 0), { grime: 1.2 });
  a.add('rust', chamferBox(0.03, 0.05, l, 0.008), xf(w / 2 + 0.005, -0.015, 0), { grime: 1.2 });
  return { colliders: [], height: 0.02, flat: true };
}

/** Manhole cover: a lifted lid ring, radial pattern, keyway slots. */
export function manholeCover(a, r) {
  const R = r.range(0.31, 0.36);
  a.add('paving', revolve([[R + 0.11, -0.06], [R + 0.11, 0.004], [R + 0.02, 0.008], [R + 0.02, -0.06]], 14), null, { grime: 1.1 });
  a.add('rust', revolve([[0, 0.01], [R, 0.012], [R + 0.005, 0.0], [R + 0.005, -0.05], [R, -0.05]], 14), null, { grime: 1.0 });
  /* raised tread pattern */
  const spokes = 6;
  for (let i = 0; i < spokes; i++) {
    const ang = (i / spokes) * TAU + r.jitter(0.05);
    a.add('rust', chamferBox(R * 0.72, 0.008, 0.045, 0.003), xf(Math.cos(ang) * R * 0.42, 0.017, Math.sin(ang) * R * 0.42, 0, -ang, 0), {
      grime: 0.9,
    });
  }
  a.add('rust', revolve([[R * 0.2, 0.014], [R * 0.24, 0.018], [R * 0.24, 0.012]], 10), null, { grime: 0.9 });
  /* the two lifting keyways */
  a.add('rust', chamferBox(0.075, 0.012, 0.03, 0.004), xf(R * 0.62, 0.016, 0), { grime: 1.3 });
  a.add('rust', chamferBox(0.075, 0.012, 0.03, 0.004), xf(-R * 0.62, 0.016, 0), { grime: 1.3 });
  return { colliders: [], height: 0.03, flat: true };
}

/** Traffic / street sign on a post: plate, clamp brackets, sticker damage. */
export function trafficSign(a, r, o = {}) {
  const h = o.height ?? r.range(2.05, 2.45);
  const kind = o.kind || r.pick(['round', 'rect', 'tall']);
  const lean = r.jitter(0.035);
  a.push(xf(0, 0, 0, lean, r.jitter(0.25), r.jitter(0.02)));
  a.add('galv', cyl(0.032, h, 10, { chamfer: 0.006 }), xf(0, h / 2, 0));
  a.add('concrete', revolve([[0, 0], [0.09, 0], [0.085, 0.05], [0.05, 0.07]], 10), null, { grime: 1.4 });

  const face = kind === 'round' ? 'signRed' : 'signWhite';
  if (kind === 'round') {
    a.add(face, revolve([[0, 0.011], [0.3, 0.011], [0.302, 0.006], [0.302, -0.006], [0.3, -0.011], [0, -0.011]], 16),
      xf(0, h - 0.34, 0.028, Math.PI / 2, 0, 0), { grime: 0.4 });
  } else if (kind === 'tall') {
    a.add(face, chamferBox(0.34, 0.9, 0.02, 0.008), xf(0, h - 0.55, 0.028), { grime: 0.45 });
  } else {
    a.add(face, chamferBox(0.72, 0.3, 0.02, 0.008), xf(0, h - 0.24, 0.028), { grime: 0.45 });
  }
  /* clamp brackets */
  for (const y of [h - 0.16, h - 0.62]) {
    if (y < 0.4) continue;
    a.add('galv', chamferBox(0.055, 0.05, 0.055, 0.008), xf(0, y, 0.014));
  }
  /* a fly-posted sticker and a bit of tape */
  if (r.chance(0.6)) {
    a.add('card', chamferBox(r.range(0.1, 0.2), r.range(0.12, 0.2), 0.004, 0.002),
      xf(r.jitter(0.06), h - r.range(0.3, 0.8), 0.041, 0, 0, r.jitter(0.25)), { grime: 0.9 });
  }
  a.pop();
  return {
    colliders: [{ type: 'box', halfExtents: [0.06, h / 2, 0.06], pos: [0, h / 2, 0], surface: 'metal' }],
    height: h,
    radius: 0.35,
  };
}

/** Bus shelter: steel frame, glazed back and ends, perforated bench, ad panel. */
export function busShelter(a, r) {
  const w = 3.6;
  const d = 1.35;
  const h = 2.42;
  const post = 0.07;
  /* four corner posts */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      a.add('steel', chamferBox(post, h, post, 0.01), xf((sx * (w - post)) / 2, h / 2, (sz * (d - post)) / 2), { grime: 1.1 });
      a.add('steel', chamferBox(post + 0.06, 0.03, post + 0.06, 0.008), xf((sx * (w - post)) / 2, 0.016, (sz * (d - post)) / 2), { grime: 1.4 });
    }
  }
  /* header beams */
  a.add('steel', chamferBox(w, 0.11, 0.09, 0.014), xf(0, h - 0.06, -(d - post) / 2));
  a.add('steel', chamferBox(w, 0.11, 0.09, 0.014), xf(0, h - 0.06, (d - post) / 2));
  a.add('steel', chamferBox(0.09, 0.11, d, 0.014), xf(-(w - post) / 2, h - 0.06, 0));
  a.add('steel', chamferBox(0.09, 0.11, d, 0.014), xf((w - post) / 2, h - 0.06, 0));
  /* cambered roof sheet */
  a.add('galv', sheet(9, 3, (u, v) => [
    (u - 0.5) * (w + 0.24),
    h + 0.02 + Math.sin(v * Math.PI) * 0.09,
    (v - 0.5) * (d + 0.3),
  ]), null, { grime: 1.3 });
  /* back glazing, one pane cracked out */
  const panes = 3;
  const broken = r.int(panes + 1);
  for (let i = 0; i < panes; i++) {
    if (i === broken) continue;
    const px = -w / 2 + (w / panes) * (i + 0.5);
    a.add('glass', chamferBox(w / panes - 0.08, h - 0.42, 0.012, 0.004), xf(px, h / 2 - 0.06, -(d - post) / 2), { grime: 0.2 });
  }
  /* remaining shards where the pane went */
  if (broken < panes) {
    const px = -w / 2 + (w / panes) * (broken + 0.5);
    for (let s = 0; s < 4; s++) {
      const sw = r.range(0.1, 0.26);
      a.add('glass', chamferBox(sw, r.range(0.08, 0.3), 0.01, 0.003),
        xf(px + r.jitter(0.35), h - 0.38 - r.range(0, 0.22), -(d - post) / 2, 0, 0, r.jitter(0.5)), { grime: 0.35 });
    }
  }
  a.add('glass', chamferBox(0.012, h - 0.5, d - 0.2, 0.004), xf(-(w - post) / 2, h / 2 - 0.1, 0), { grime: 0.25 });
  /* bench: three slats on cantilevered arms */
  for (let i = 0; i < 3; i++) {
    a.add('paintwood', chamferBox(w - 0.5, 0.045, 0.11, 0.012), xf(0, 0.47, -(d - post) / 2 + 0.16 + i * 0.15), { grime: 1.0 });
  }
  for (const sx of [-1, 0.2, 1]) {
    a.add('steel', chamferBox(0.05, 0.44, 0.36, 0.01), xf(sx * (w / 2 - 0.4), 0.24, -(d - post) / 2 + 0.31), { grime: 1.2 });
  }
  /* illuminated ad panel on the far end */
  a.add('steel', chamferBox(0.07, 1.65, d - 0.24, 0.014), xf((w - post) / 2, 1.15, 0), { grime: 0.9 });
  a.add('lens', chamferBox(0.02, 1.45, d - 0.42, 0.008), xf((w - post) / 2 - 0.045, 1.15, 0), { grime: 0.3 });

  return {
    colliders: [
      { type: 'box', halfExtents: [w / 2, h / 2, 0.09], pos: [0, h / 2, -(d - post) / 2], surface: 'glass' },
      { type: 'box', halfExtents: [0.09, h / 2, d / 2], pos: [-(w - post) / 2, h / 2, 0], surface: 'metal' },
      { type: 'box', halfExtents: [0.09, h / 2, d / 2], pos: [(w - post) / 2, h / 2, 0], surface: 'metal' },
      { type: 'box', halfExtents: [w / 2 - 0.2, 0.22, 0.24], pos: [0, 0.36, -(d - post) / 2 + 0.3], surface: 'wood' },
    ],
    height: h,
    radius: w * 0.55,
    lights: [{ kind: 'point', pos: [w / 2 - 0.3, 1.5, 0], color: 0xd8e6ff, intensity: 3.2, distance: 6 }],
  };
}

/** Park bench: slat seat and back on two cast end frames. */
export function bench(a, r) {
  const w = r.range(1.6, 2.0);
  const seatY = 0.44;
  for (const sx of [-1, 1]) {
    const x = (sx * (w - 0.16)) / 2;
    a.add('rust', chamferBox(0.06, seatY, 0.07, 0.01), xf(x, seatY / 2, -0.2), { grime: 1.3 });
    a.add('rust', chamferBox(0.06, seatY, 0.07, 0.01), xf(x, seatY / 2, 0.2), { grime: 1.3 });
    a.add('rust', chamferBox(0.055, 0.05, 0.56, 0.01), xf(x, seatY, 0));
    /* scrolled back support */
    a.add('rust', chamferBox(0.05, 0.5, 0.06, 0.01), xf(x, seatY + 0.25, -0.21, -0.14, 0, 0), { grime: 0.8 });
    a.add('rust', chamferBox(0.07, 0.03, 0.5, 0.008), xf(x, 0.03, 0), { grime: 1.5 });
  }
  const slats = 4;
  for (let i = 0; i < slats; i++) {
    const z = -0.19 + (i * 0.4) / (slats - 1);
    a.add('wood', chamferBox(w, 0.035, 0.085, 0.01), xf(0, seatY + 0.028, z, 0, r.jitter(0.006), 0), { grime: 0.9 });
  }
  for (let i = 0; i < 3; i++) {
    const t = i / 2;
    a.add('wood', chamferBox(w, 0.032, 0.075, 0.01), xf(0, seatY + 0.2 + t * 0.28, -0.235 - t * 0.055, -0.14, 0, 0), { grime: 0.8 });
  }
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, 0.24, 0.26], pos: [0, 0.32, 0], surface: 'wood' }],
    height: 0.9,
    radius: w * 0.55,
  };
}

/** Concrete planter with soil, a kerb lip, and a straggly shrub. */
export function planter(a, r, o = {}) {
  const sx = o.sx ?? r.range(1.1, 1.7);
  const sz = o.sz ?? r.range(0.7, 1.1);
  const h = o.h ?? r.range(0.5, 0.66);
  const t = 0.11;
  /* four walls with a flared coping, not a hollow box */
  a.add('concrete', chamferBox(sx, h, t, 0.02), xf(0, h / 2, (sz - t) / 2), { grime: 1.2 });
  a.add('concrete', chamferBox(sx, h, t, 0.02), xf(0, h / 2, -(sz - t) / 2), { grime: 1.2 });
  a.add('concrete', chamferBox(t, h, sz - t * 2, 0.02), xf((sx - t) / 2, h / 2, 0), { grime: 1.2 });
  a.add('concrete', chamferBox(t, h, sz - t * 2, 0.02), xf(-(sx - t) / 2, h / 2, 0), { grime: 1.2 });
  a.add('concrete', chamferBox(sx + 0.05, 0.05, sz + 0.05, 0.02), xf(0, h + 0.02, 0), { grime: 0.8 });
  /* soil, mounded and cracked-dry */
  a.add('produce', sheet(5, 4, (u, v) => [
    (u - 0.5) * (sx - t * 2.2),
    h - 0.12 + Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.05,
    (v - 0.5) * (sz - t * 2.2),
  ]), null, { grime: 1.5 });
  /* a shrub built from overlapping masses rather than crossed cards: without an alpha
     cutout a flat card reads as painted cardboard from every angle but head-on */
  if (o.plant !== false) {
    const n = 3 + r.int(3);
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + r.jitter(0.5);
      const rad = r.range(0.05, 0.24) * Math.min(sx, sz);
      const ms = r.range(0.2, 0.34);
      const lumpA = r.range(0, TAU);
      a.add('produce', blob(ms * 1.25, ms * r.range(0.8, 1.15), ms * 1.15, 8,
        (dx, dy, dz) => 1 + 0.22 * Math.sin(dx * 4.4 + lumpA) * Math.cos(dz * 3.7 + lumpA) + 0.12 * Math.sin(dy * 5.1)),
        xf(Math.cos(ang) * rad, h - 0.05 + ms * r.range(0.4, 0.7), Math.sin(ang) * rad, r.jitter(0.3), ang, r.jitter(0.3)),
        { grime: 0.45, uvOff: [r.range(0, 3), r.range(0, 3)] });
    }
    /* a couple of woody stems poking out of the mass */
    for (let i = 0; i < 2; i++) {
      const ang = r.range(0, TAU);
      a.add('wood', tube([[0, h - 0.1, 0], [Math.cos(ang) * 0.12, h + 0.22, Math.sin(ang) * 0.12]], 0.012, 5, { cap: false }),
        null, { grime: 1.0 });
    }
  }
  return {
    colliders: [{ type: 'box', halfExtents: [sx / 2, h / 2, sz / 2], pos: [0, h / 2, 0], surface: 'concrete' }],
    height: h + 0.4,
    radius: Math.max(sx, sz) * 0.6,
  };
}

/** Fire hydrant — a proper lathe form with two side outlets and a bonnet nut. */
export function hydrant(a, r) {
  const h = 0.78;
  a.push(xf(0, 0, 0, r.jitter(0.03), r.range(0, TAU), r.jitter(0.03)));
  a.add('signRed', revolve(
    [
      [0, 0], [0.155, 0], [0.16, 0.035], [0.135, 0.06], [0.1, 0.085], [0.098, 0.12],
      [0.115, 0.15], [0.113, 0.2], [0.09, 0.235], [0.088, h - 0.24], [0.108, h - 0.21],
      [0.108, h - 0.16], [0.086, h - 0.13], [0.086, h - 0.07], [0.055, h - 0.02], [0.03, h], [0, h],
    ],
    14
  ), null, { grime: 1.0 });
  /* the two 65 mm outlets and their caps */
  for (const s of [-1, 1]) {
    a.add('signRed', cyl(0.055, 0.09, 10, { chamfer: 0.008 }), xf(s * 0.11, h - 0.3, 0, 0, 0, (s * Math.PI) / 2));
    a.add('rust', cyl(0.062, 0.03, 10, { chamfer: 0.006 }), xf(s * 0.165, h - 0.3, 0, 0, 0, (s * Math.PI) / 2), { grime: 1.2 });
  }
  /* pentagon operating nut */
  a.add('rust', cyl(0.036, 0.045, 5, { chamfer: 0.005 }), xf(0, h + 0.02, 0), { grime: 1.1 });
  /* chain to one cap */
  const ch = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    ch.push([lerp(0.16, 0.02, t), h - 0.3 - Math.sin(t * Math.PI) * 0.06 - t * 0.02, lerp(0.02, 0.075, t)]);
  }
  a.add('rust', tube(ch, 0.008, 5, { cap: false }), null, { grime: 1.3 });
  a.pop();
  return { colliders: [{ type: 'box', halfExtents: [0.14, h / 2, 0.14], pos: [0, h / 2, 0], surface: 'metal' }], height: h, radius: 0.2 };
}

/** Street cabinet / utility box: a plinth, a door with hinges, a warning label. */
export function utilityBox(a, r, o = {}) {
  const w = o.w ?? r.range(0.62, 0.86);
  const d = o.d ?? r.range(0.3, 0.42);
  const h = o.h ?? r.range(1.0, 1.35);
  a.add('concrete', chamferBox(w + 0.1, 0.11, d + 0.1, 0.018), xf(0, 0.055, 0), { grime: 1.5 });
  a.add('galv', chamferBox(w, h, d, 0.022), xf(0, 0.11 + h / 2, 0), { grime: 1.0 });
  /* sloped rain cap with a drip lip */
  a.add('galv', sheet(4, 3, (u, v) => [
    (u - 0.5) * (w + 0.09),
    0.11 + h + 0.03 + (1 - v) * 0.045,
    (v - 0.5) * (d + 0.09),
  ]), null, { grime: 1.4 });
  /* door: a recessed panel with a lock and two hinges */
  a.add('galv', chamferBox(w - 0.09, h - 0.14, 0.014, 0.008), xf(0, 0.11 + h / 2, d / 2 + 0.004), { grime: 0.75 });
  a.add('rust', cyl(0.019, 0.02, 8, { chamfer: 0.004 }), xf(w / 2 - 0.1, 0.11 + h / 2, d / 2 + 0.016, Math.PI / 2, 0, 0), { grime: 1.1 });
  for (const y of [0.11 + h * 0.24, 0.11 + h * 0.76]) {
    a.add('rust', chamferBox(0.028, 0.07, 0.028, 0.005), xf(-w / 2 + 0.035, y, d / 2 + 0.012), { grime: 1.1 });
  }
  /* louvre slots — the giveaway detail on a real cabinet */
  for (let i = 0; i < 4; i++) {
    a.add('rust', chamferBox(w * 0.5, 0.012, 0.01, 0.003), xf(0, 0.11 + h - 0.14 - i * 0.045, d / 2 + 0.012), { grime: 1.3 });
  }
  /* hazard label, peeling */
  a.add('signRed', chamferBox(0.12, 0.14, 0.005, 0.002), xf(-w / 2 + 0.14, 0.11 + h * 0.68, d / 2 + 0.016, 0, 0, r.jitter(0.12)), { grime: 0.7 });
  /* fly-posting and tags along the base */
  if (r.chance(0.55)) {
    a.add('card', chamferBox(r.range(0.14, 0.26), r.range(0.16, 0.28), 0.004, 0.002),
      xf(r.jitter(w * 0.2), 0.11 + h * r.range(0.3, 0.6), d / 2 + 0.017, 0, 0, r.jitter(0.2)), { grime: 1.0 });
  }
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2 + 0.03, (h + 0.11) / 2, d / 2 + 0.03], pos: [0, (h + 0.11) / 2, 0], surface: 'metal' }],
    height: h + 0.15,
    radius: Math.max(w, d) * 0.7,
  };
}

/**
 * Split-system AC condenser. Wall-mounted (origin at the wall face, +Z out of the wall)
 * or floor-standing on a roof. Grille is real geometry, not a texture.
 */
export function acUnit(a, r, o = {}) {
  const w = o.w ?? r.range(0.72, 0.9);
  const h = o.h ?? r.range(0.52, 0.64);
  const d = o.d ?? r.range(0.26, 0.34);
  const wall = o.wall !== false;
  const yb = wall ? 0 : 0.06;

  if (!wall) {
    /* rubber anti-vibration feet on a roof deck */
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        a.add('tyre', chamferBox(0.09, 0.06, 0.07, 0.012), xf((sx * (w - 0.16)) / 2, 0.03, (sz * (d - 0.12)) / 2), { grime: 1.4 });
      }
    }
  }
  const cy = yb + h / 2;
  a.add('galv', chamferBox(w, h, d, 0.02), xf(0, cy, d / 2), { grime: 1.15 });
  /* stamped panel lines */
  for (const sy of [-0.26, 0.26]) {
    a.add('galv', chamferBox(w - 0.06, 0.01, 0.008, 0.002), xf(0, cy + sy * h, d + 0.006), { grime: 1.0 });
  }
  /* fan grille: an outer ring plus radial spokes, with the fan behind it */
  const gr = Math.min(h, w) * 0.36;
  const gx = w * 0.14;
  a.add('rust', revolve([[gr, 0], [gr + 0.022, 0.008], [gr + 0.022, 0.022], [gr, 0.03]], 16),
    xf(gx, cy, d + 0.002, -Math.PI / 2, 0, 0), { grime: 1.0 });
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * TAU;
    a.add('rust', chamferBox(gr * 1.9, 0.012, 0.008, 0.002), xf(gx, cy, d + 0.016, 0, 0, ang), { grime: 1.1 });
  }
  a.add('rust', revolve([[0, 0], [0.05, 0], [0.05, 0.02], [0, 0.02]], 10), xf(gx, cy, d - 0.02, -Math.PI / 2, 0, 0), { grime: 1.2 });
  /* three fan blades behind the grille, caught mid-rotation */
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * TAU + r.range(0, 1);
    a.add('rust', chamferBox(gr * 1.5, 0.02, 0.09, 0.004), xf(gx, cy, d - 0.045, 0.18, 0, ang), { grime: 1.3 });
  }
  /* side louvre stack */
  for (let i = 0; i < 7; i++) {
    a.add('galv', chamferBox(0.008, 0.014, d - 0.06, 0.002), xf(-w / 2 - 0.002, cy - h * 0.35 + i * (h * 0.7) / 6, d / 2), { grime: 1.2 });
  }
  /* refrigerant lines and the condensate drip that stains the wall below */
  const lines = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    lines.push([-w / 2 - 0.03, cy - 0.1 - t * (cy - 0.06), lerp(d * 0.5, 0.02, t)]);
  }
  a.add('rust', tube(lines, 0.016, 6, { cap: false }), null, { grime: 1.2 });
  a.add('rust', tube(lines.map((p) => [p[0] - 0.045, p[1], p[2]]), 0.013, 6, { cap: false }), null, { grime: 1.2 });

  if (wall) {
    /* the two L-brackets it hangs from */
    for (const sx of [-1, 1]) {
      a.add('rust', chamferBox(0.05, 0.045, d + 0.08, 0.008), xf((sx * (w - 0.14)) / 2, yb - 0.02, (d + 0.08) / 2), { grime: 1.4 });
      a.add('rust', chamferBox(0.05, 0.24, 0.045, 0.008), xf((sx * (w - 0.14)) / 2, yb + 0.09, 0.03), { grime: 1.4 });
    }
  }
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, h / 2, d / 2], pos: [0, cy, d / 2], surface: 'metal' }],
    height: yb + h,
    radius: Math.max(w, d) * 0.7,
  };
}

/** Wheelie / municipal bin — lid ajar, body dented, wheels. */
export function rubbishBin(a, r, o = {}) {
  const w = o.w ?? 0.58;
  const d = o.d ?? 0.52;
  const h = o.h ?? 0.92;
  const mat = o.mat || r.pick(['plasticGreen', 'plasticBlue', 'galv']);
  const lidOpen = r.chance(0.45) ? r.range(0.25, 0.9) : 0.02;
  /* tapered body: narrower at the bottom, like a real moulding */
  const bw = w * 0.86;
  const bd = d * 0.86;
  a.add(mat, chamferBox(bw, 0.1, bd, 0.02), xf(0, 0.14, 0), { grime: 1.4 });
  a.add(mat, chamferBox(w, h - 0.2, d, 0.03), xf(0, 0.14 + (h - 0.2) / 2, 0), { grime: 1.15 });
  /* moulded rib */
  a.add(mat, chamferBox(w + 0.012, 0.035, d + 0.012, 0.01), xf(0, 0.14 + (h - 0.2) * 0.62, 0), { grime: 1.0 });
  /* lid on a hinge at the back */
  a.add(mat, chamferBox(w + 0.03, 0.055, d + 0.03, 0.016),
    xf(0, h - 0.05 + Math.sin(lidOpen) * (d / 2), (Math.cos(lidOpen) - 1) * (d / 2) * 0.5 - (1 - Math.cos(lidOpen)) * 0.1, -lidOpen), { grime: 0.85 });
  /* wheels + axle */
  for (const s of [-1, 1]) {
    a.add('tyre', torusPrim(0.075, 0.028, 12, 6), xf((s * (bw - 0.06)) / 2, 0.08, -bd / 2 + 0.06, 0, 0, Math.PI / 2), { grime: 1.5 });
  }
  a.add('rust', cyl(0.014, bw, 6, { chamfer: 0.003 }), xf(0, 0.08, -bd / 2 + 0.06, 0, 0, Math.PI / 2), { grime: 1.5 });
  /* overflowing rubbish when the lid is up */
  if (lidOpen > 0.3) {
    for (let i = 0; i < 5; i++) {
      a.add('card', chamferBox(r.range(0.1, 0.24), r.range(0.06, 0.16), r.range(0.05, 0.14), 0.008),
        xf(r.jitter(w * 0.28), h - 0.16 + r.range(0, 0.12), r.jitter(d * 0.25), r.jitter(0.7), r.range(0, TAU), r.jitter(0.7)), { grime: 1.2 });
    }
  }
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, h / 2, d / 2], pos: [0, h / 2, 0], surface: 'metal' }],
    height: h,
    radius: Math.max(w, d) * 0.72,
    mass: 24,
  };
}

/** Standpipe / downpipe run bracketed to a wall (origin at the wall, +Z out). */
export function downpipe(a, r, o = {}) {
  const h = o.height ?? r.range(3.2, 6.4);
  const rr = 0.055;
  const pts = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push([Math.sin(t * 3.1) * 0.012, t * h, 0.075 + Math.cos(t * 2.2) * 0.006]);
  }
  a.add('rust', tube(pts, rr, 8, { cap: false }), null, { grime: 1.3 });
  /* shoe at the bottom that kicks the water out */
  a.add('rust', tube([[0, 0.16, 0.075], [0, 0.06, 0.1], [0, 0.03, 0.17]], rr, 8, { cap: false }), null, { grime: 1.6 });
  for (let i = 0; i * 1.4 < h; i++) {
    const y = 0.5 + i * 1.4;
    if (y > h - 0.2) break;
    a.add('rust', chamferBox(0.14, 0.028, 0.09, 0.006), xf(0, y, 0.04), { grime: 1.4 });
  }
  return { colliders: [], height: h, radius: 0.14 };
}

/**
 * Surface-run electrical conduit with saddle clips, a junction box and a drop to a
 * meter. Origin at the wall face, +Z out of the wall.
 *
 * This is the cheapest silhouette-breaker there is — six cylinders and two boxes — and
 * it is the reason a real wall never reads as a flat plane at grazing light. Every
 * facade sample that gets nothing else gets one of these.
 */
export function wallConduit(a, r, o = {}) {
  const h = o.height ?? r.range(2.1, 4.2);
  const drop = o.drop ?? r.range(0.9, 1.6);
  const z = 0.045;
  const mat = r.chance(0.45) ? 'galv' : 'rust';
  /* the vertical run */
  a.add(mat, cyl(0.019, h, 7, { chamfer: 0.003 }), xf(0, h / 2, z), { grimeHeight: 0.5 });
  /* a horizontal spur at the head, kicked round the corner */
  a.add(mat, cyl(0.019, r.range(0.5, 1.4), 7, { chamfer: 0.003 }), xf(r.range(0.25, 0.7), h - 0.03, z, 0, 0, Math.PI / 2), {
    grime: 1.2,
  });
  /* saddle clips every ~700 mm */
  for (let y = 0.28; y < h - 0.1; y += r.range(0.6, 0.9)) {
    a.add('galv', chamferBox(0.055, 0.018, 0.055, 0.004), xf(0, y, z * 0.55), { grime: 1.35 });
  }
  /* junction box on the run */
  const jy = Math.min(h - 0.35, drop + r.range(0.3, 0.9));
  a.add('galv', chamferBox(0.13, 0.17, 0.075, 0.012), xf(0, jy, 0.04), { grime: 1.1 });
  a.add('rust', chamferBox(0.1, 0.13, 0.008, 0.003), xf(0, jy, 0.082), { grime: 0.9 });
  /* a soft cable dropping away from it — nothing in a street hangs dead straight */
  const cab = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    cab.push([-0.06 - t * r.range(0.05, 0.22), jy - t * drop, 0.05 + Math.sin(t * 2.4) * 0.035]);
  }
  a.add('rust', tube(cab, 0.009, 5, { cap: false }), null, { grime: 1.25 });
  return { colliders: [], height: h, radius: 0.22 };
}

/** Louvred wall vent with a hood and a stain trail. Origin at the wall face, +Z out. */
export function wallVent(a, r, o = {}) {
  const w = o.w ?? r.range(0.34, 0.52);
  const h = o.h ?? r.range(0.28, 0.42);
  a.add('galv', chamferBox(w, h, 0.06, 0.01), xf(0, 0, 0.03), { grime: 1.2 });
  const n = Math.max(3, Math.round(h / 0.075));
  for (let i = 0; i < n; i++) {
    const y = -h / 2 + 0.045 + (i * (h - 0.09)) / Math.max(1, n - 1);
    a.add('rust', chamferBox(w - 0.06, 0.016, 0.03, 0.004), xf(0, y, 0.075, 0.35, 0, 0), { grime: 1.35 });
  }
  /* hood over the top so it throws a shadow line */
  a.add('galv', sheet(3, 2, (u, v) => [(u - 0.5) * (w + 0.09), h / 2 + 0.035 - v * 0.03, 0.01 + v * 0.11]), null, { grime: 1.3 });
  if (r.chance(0.5)) {
    a.add('rust', chamferBox(0.03, 0.03, 0.03, 0.006), xf(w / 2 + 0.03, -h / 2, 0.05), { grime: 1.5 });
  }
  return { colliders: [], height: h, radius: w * 0.6 };
}

/** Domestic electricity meter in a box with the tails running away. +Z out of the wall. */
export function meterBox(a, r, o = {}) {
  const w = o.w ?? r.range(0.3, 0.4);
  const h = o.h ?? r.range(0.4, 0.52);
  const d = 0.13;
  a.add('ply', chamferBox(w, h, d, 0.012), xf(0, 0, d / 2), { grime: 1.1 });
  a.add('galv', chamferBox(w - 0.05, h - 0.06, 0.012, 0.004), xf(0, 0, d + 0.004), { grime: 0.85 });
  a.add('glass', chamferBox(w * 0.42, h * 0.3, 0.006, 0.002), xf(0, h * 0.12, d + 0.012), { grime: 0.5 });
  a.add('rust', cyl(0.012, 0.05, 6, { chamfer: 0.002 }), xf(w / 2 - 0.05, -h * 0.3, d + 0.02, Math.PI / 2, 0, 0), { grime: 1.2 });
  /* the two tails, dropping and disappearing into the wall */
  for (const s of [-1, 1]) {
    a.add('rust', tube(
      [[s * w * 0.24, -h / 2, d * 0.6], [s * w * 0.24 + s * 0.03, -h / 2 - 0.32, d * 0.4], [s * w * 0.2, -h / 2 - 0.6, 0.05]],
      0.011, 5, { cap: false }
    ), null, { grime: 1.3 });
  }
  return { colliders: [], height: h, radius: w * 0.6 };
}

export default {
  lampPost,
  bollard,
  kerbRun,
  drainGrate,
  manholeCover,
  trafficSign,
  busShelter,
  bench,
  planter,
  hydrant,
  utilityBox,
  acUnit,
  rubbishBin,
  downpipe,
  wallConduit,
  wallVent,
  meterBox,
};
