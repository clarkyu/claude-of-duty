/**
 * props/military.js — conflict dressing. Owner: props agent.
 *
 * Same contract as props/street.js: `build(a, r, o) -> {colliders, height, …}` with the
 * origin at the ground contact point.
 *
 * The rule that makes this read as real: **nothing is stacked identically**. Sandbags
 * squash against the bag under them and roll their fill towards the outside of the wall;
 * jersey barriers are cast from a worn mould and have chipped corners with rebar
 * showing; drums are dented; a wire coil is a coil, not a texture.
 */
import { chamferBox, cyl, revolve, tube, helix, torusPrim, sheet, blob, xf, clamp01, lerp, smooth, TAU } from './geom.js';

/* ========================================================================== */
/*                                  sandbags                                  */
/* ========================================================================== */

/**
 * One filled bag. `squashTop`/`squashBot` flatten it against its neighbours, and a
 * low-frequency lump function gives it the lopsided fill that reads as sand, not foam.
 */
function sandbagShape(r, len = 0.46, wid = 0.28, hgt = 0.17, squashTop = 0, squashBot = 1) {
  const lumpA = r.range(0, TAU);
  const lumpB = r.range(0, TAU);
  const bias = r.range(-0.14, 0.14);
  return blob(len, hgt, wid, 11, (dx, dy, dz) => {
    // waist bulge, a slump towards one end, hessian lumps and the seam ridge
    let g = 1 + 0.17 * (1 - Math.abs(dy)) + bias * dx * 0.5;
    g += 0.055 * Math.sin(dx * 5.1 + lumpA) * Math.cos(dz * 4.3 + lumpB);
    g += 0.03 * Math.sin(dz * 8.7 + lumpA * 2);
    g += 0.03 * Math.exp(-Math.abs(dz) * 6) * clamp01(dy);
    g = Math.max(0.55, g);
    // squash in Y only, so the bag flattens against its neighbour instead of pinching
    let sq = 1;
    if (dy > 0) sq -= squashTop * 0.34 * smooth(clamp01(dy));
    if (dy < 0) sq -= squashBot * 0.4 * smooth(clamp01(-dy));
    return [g, Math.max(0.45, sq), g * 0.97];
  });
}

/**
 * A sandbag emplacement. Courses are laid header/stretcher alternately, each course is
 * inset, and every bag is squashed against the one below.
 * @param {object} o { length, courses, height, curve }
 */
export function sandbagWall(a, r, o = {}) {
  const len = o.length ?? 3.0;
  const courses = o.courses ?? 5;
  const bagL = 0.46;
  const bagW = 0.28;
  const bagH = 0.17;
  const colliders = [];
  let top = 0;
  for (let c = 0; c < courses; c++) {
    const header = c % 2 === 1;
    const step = header ? bagW * 0.98 : bagL * 0.96;
    const n = Math.max(1, Math.round(len / step));
    const inset = c * 0.035;
    const y = c * (bagH * 0.86) + bagH * 0.5;
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + step * (i + 0.5) + r.jitter(0.02);
      const z = r.jitter(0.035) + (header ? 0 : 0);
      const yaw = (header ? Math.PI / 2 : 0) + r.jitter(0.09);
      const s = r.range(0.94, 1.06);
      const bag = sandbagShape(r, bagL * s, (bagW - inset) * s, bagH * s, c === courses - 1 ? 0.25 : 1, c === 0 ? 0.55 : 1);
      a.add('sacking', bag, xf(x, y - c * 0.006, z, r.jitter(0.06), yaw, r.jitter(0.05)), {
        grimeHeight: 0.5,
        uvOff: [r.range(0, 2), r.range(0, 2)],
      });
    }
    top = y + bagH * 0.5;
  }
  colliders.push({
    type: 'box',
    halfExtents: [len / 2, top / 2, bagW * 0.62],
    pos: [0, top / 2, 0],
    surface: 'fabric',
    material: 'sand',
  });
  return { colliders, height: top, radius: len * 0.55 };
}

/** A loose heap of bags — what a wall looks like after somebody drove into it. */
export function sandbagPile(a, r, o = {}) {
  const n = o.count ?? 5 + r.int(5);
  let top = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const y = 0.085 + t * 0.22 + r.jitter(0.02);
    const rad = (1 - t) * 0.42;
    const ang = r.range(0, TAU);
    a.add('sacking', sandbagShape(r, 0.46, 0.28, 0.17, 0.35, 0.7),
      xf(Math.cos(ang) * rad, y, Math.sin(ang) * rad, r.jitter(0.35), r.range(0, TAU), r.jitter(0.35)), {
        grimeHeight: 0.5,
        uvOff: [r.range(0, 2), r.range(0, 2)],
      });
    top = Math.max(top, y + 0.1);
  }
  return {
    colliders: [{ type: 'box', halfExtents: [0.6, top / 2, 0.6], pos: [0, top / 2, 0], surface: 'fabric', material: 'sand' }],
    height: top,
    radius: 0.7,
  };
}

/* ========================================================================== */
/*                              concrete barriers                             */
/* ========================================================================== */

/**
 * Jersey barrier authored from its real section: a 100 mm toe, a 55° lower batter, a
 * near-vertical upper face and a flat top. Lift-holes, a cast joint, chipped corners
 * with rebar poking out of two of them.
 */
export function jerseyBarrier(a, r, o = {}) {
  const len = o.length ?? r.range(2.2, 3.1);
  const h = 0.82;
  const baseW = 0.6;
  const topW = 0.18;
  const toeH = 0.09;
  const kneeH = 0.33;
  const kneeW = 0.28;

  /* the section, extruded by hand so the batter faces are separate quads */
  const prof = [
    [baseW / 2, 0],
    [baseW / 2, toeH],
    [kneeW / 2, kneeH],
    [topW / 2 + 0.015, h - 0.05],
    [topW / 2, h],
  ];
  const nSeg = 3;
  for (let s = 0; s < nSeg; s++) {
    const z0 = -len / 2 + (len / nSeg) * s + 0.008;
    const z1 = -len / 2 + (len / nSeg) * (s + 1) - 0.008;
    const sl = z1 - z0;
    const cz = (z0 + z1) / 2;
    for (let i = 0; i < prof.length - 1; i++) {
      const [w0, y0] = prof[i];
      const [w1, y1] = prof[i + 1];
      const midY = (y0 + y1) / 2;
      const midW = (w0 + w1) / 2;
      const dy = y1 - y0;
      const dw = w1 - w0;
      const face = Math.hypot(dy, dw);
      const tilt = Math.atan2(dw, dy);
      for (const sx of [1, -1]) {
        a.add('concrete', chamferBox(0.03, face + 0.008, sl, 0.012),
          xf(sx * midW, midY, cz, 0, 0, sx * tilt), { grimeHeight: 0.45 });
      }
    }
    /* core + top cap */
    a.add('concrete', chamferBox(kneeW, h - 0.02, sl, 0.014), xf(0, (h - 0.02) / 2, cz), { grimeHeight: 0.45 });
    a.add('concrete', chamferBox(topW + 0.03, 0.05, sl, 0.016), xf(0, h - 0.02, cz), { grimeHeight: 0.45 });
    a.add('concrete', chamferBox(baseW - 0.02, toeH + 0.02, sl, 0.014), xf(0, (toeH + 0.02) / 2, cz), { grimeHeight: 0.45 });
  }
  /* end faces */
  for (const sz of [-1, 1]) {
    a.add('concrete', chamferBox(baseW - 0.02, toeH, 0.03, 0.012), xf(0, toeH / 2, (sz * len) / 2), { grimeHeight: 0.45 });
    a.add('concrete', chamferBox(kneeW, h - toeH, 0.03, 0.012), xf(0, (h + toeH) / 2, (sz * len) / 2), { grimeHeight: 0.45 });
  }
  /* two lift holes in the top */
  for (const sz of [-0.28, 0.28]) {
    a.add('concrete', revolve([[0.055, -0.02], [0.055, 0.01], [0.04, 0.012]], 10), xf(0, h - 0.008, sz * len), { grime: 1.4 });
  }
  /* chipped corners: a couple of missing wedges with rebar showing */
  const chips = 1 + r.int(3);
  for (let i = 0; i < chips; i++) {
    const sz = r.chance(0.5) ? 1 : -1;
    const sx = r.chance(0.5) ? 1 : -1;
    const cy = r.chance(0.6) ? h - 0.03 : toeH + 0.02;
    const s = r.range(0.06, 0.14);
    a.add('concrete', blob(s * 1.8, s, s * 1.4, 7, (dx, dy) => 0.8 + 0.3 * Math.sin(dx * 6 + dy * 4)),
      xf((sx * (topW + 0.04)) / 2, cy, (sz * len) / 2 - sz * r.range(0.02, 0.2)), { grime: 1.6 });
    if (r.chance(0.5)) {
      const pts = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        pts.push([(sx * topW) / 2 + sx * t * 0.03, cy + Math.sin(t * 2.4) * 0.05, (sz * len) / 2 - sz * (0.02 + t * 0.16)]);
      }
      a.add('rust', tube(pts, 0.008, 5, { cap: false }), null, { grime: 1.7 });
    }
  }
  /* stencilled unit number and a strip of hazard tape */
  a.add('signWhite', chamferBox(0.24, 0.14, 0.006, 0.002), xf(kneeW / 2 + 0.005, h * 0.55, r.jitter(len * 0.2), 0, 0, 0.24), { grime: 1.0 });

  return {
    colliders: [
      { type: 'box', halfExtents: [baseW / 2, kneeH / 2, len / 2], pos: [0, kneeH / 2, 0], surface: 'concrete' },
      { type: 'box', halfExtents: [kneeW / 2, (h - kneeH) / 2, len / 2], pos: [0, (h + kneeH) / 2, 0], surface: 'concrete' },
    ],
    height: h,
    radius: len * 0.55,
  };
}

/** Hesco bastion: a welded mesh cage, a hessian liner and a rock/soil fill that bulges. */
export function hesco(a, r, o = {}) {
  const cells = o.cells ?? 2;
  const s = o.size ?? 1.06;
  const h = o.h ?? 1.12;
  const len = cells * s;
  for (let c = 0; c < cells; c++) {
    const cx = -len / 2 + s * (c + 0.5);
    /* liner: four bulging faces */
    for (const [ax, sgn] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
      const bulge = r.range(0.05, 0.1);
      a.add('sacking', sheet(5, 5, (u, v) => {
        const b = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * bulge;
        const lu = (u - 0.5) * (s - 0.03);
        const lv = v * h;
        return ax === 0
          ? [cx + lu, lv, (sgn * s) / 2 + sgn * b]
          : [cx + (sgn * s) / 2 + sgn * b, lv, lu];
      }), null, { grimeHeight: 0.6, uvOff: [r.range(0, 2), r.range(0, 2)] });
    }
    /* soil cap, heaped */
    a.add('produce', sheet(5, 5, (u, v) => [
      cx + (u - 0.5) * (s - 0.04),
      h + Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.07,
      (v - 0.5) * (s - 0.04),
    ]), null, { grime: 1.4 });
    /* the welded mesh cage: verticals + horizontals, sparse enough to be affordable */
    for (const [ax, sgn] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
      for (let i = 0; i <= 4; i++) {
        const u = i / 4 - 0.5;
        const lu = u * (s - 0.02);
        const p = ax === 0 ? [cx + lu, h / 2, (sgn * s) / 2] : [cx + (sgn * s) / 2, h / 2, lu];
        a.add('galv', chamferBox(ax === 0 ? 0.012 : 0.012, h, 0.012, 0.003), xf(p[0], p[1], p[2]), { grime: 1.2 });
      }
      for (let j = 0; j <= 3; j++) {
        const y = 0.06 + (j * (h - 0.12)) / 3;
        const p = ax === 0 ? [cx, y, (sgn * s) / 2] : [cx + (sgn * s) / 2, y, 0];
        a.add('galv', chamferBox(ax === 0 ? s : 0.012, 0.012, ax === 0 ? 0.012 : s, 0.003), xf(p[0], p[1], p[2]), { grime: 1.2 });
      }
    }
  }
  return {
    colliders: [{ type: 'box', halfExtents: [len / 2, h / 2, s / 2], pos: [0, h / 2, 0], surface: 'dirt', material: 'dirt' }],
    height: h + 0.08,
    radius: len * 0.55,
  };
}

/** Razor-wire coil: a real helix with blade tabs, sagging between two anchor heights. */
export function razorWire(a, r, o = {}) {
  const len = o.length ?? 3.0;
  const R = o.radius ?? 0.32;
  const turns = Math.max(3, Math.round(len / 0.42));
  a.add('galv', helix(len, R, 0.009, turns, 5, 7), null, { grime: 1.3 });
  /* blade tabs, every other node */
  const per = 6;
  for (let i = 0; i < turns * per; i += 2) {
    const t = i / (turns * per);
    const ang = t * turns * TAU;
    const x = t * len - len / 2;
    const y = Math.sin(ang) * R;
    const z = Math.cos(ang) * R;
    a.add('galv', chamferBox(0.006, 0.032, 0.05, 0.002), xf(x, y, z, ang, 0, r.jitter(0.4)), { grime: 1.2 });
  }
  return { colliders: [], height: R * 2, radius: R };
}

/* ========================================================================== */
/*                                chain-link                                  */
/* ========================================================================== */

/**
 * Chain-link fence run. `cutoutMat` is the alpha-tested weave; posts, the top rail and
 * the tension wire are real geometry so the silhouette holds up close.
 */
export function chainLink(a, r, o = {}) {
  const len = o.length ?? 6;
  const h = o.h ?? 2.2;
  const bays = Math.max(1, Math.round(len / 3));
  const bay = len / bays;
  const cut = o.cutMat || 'chain';

  for (let i = 0; i <= bays; i++) {
    const x = -len / 2 + bay * i;
    const lean = r.jitter(0.03);
    a.add('galv', cyl(0.032, h + 0.06, 8, { chamfer: 0.006 }), xf(x, (h + 0.06) / 2, 0, lean, 0, r.jitter(0.02)), { grime: 1.2 });
    a.add('galv', revolve([[0, 0], [0.05, 0.005], [0.048, 0.03], [0.034, 0.04]], 8), xf(x, h + 0.06, 0), { grime: 1.0 });
    a.add('concrete', revolve([[0, 0], [0.1, 0], [0.095, 0.04], [0.05, 0.06]], 10), xf(x, 0, 0), { grime: 1.5 });
  }
  /* top rail, with a real sag between posts */
  for (let i = 0; i < bays; i++) {
    const x0 = -len / 2 + bay * i;
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      pts.push([x0 + t * bay, h - 0.05 - Math.sin(t * Math.PI) * 0.035, 0]);
    }
    a.add('galv', tube(pts, 0.021, 6, { cap: false }), null, { grime: 1.2 });
  }
  /* the mesh: one sagging cutout sheet per bay. A torn bay is *missing geometry* with
     a curled-back flap — tiling a hole into the alpha map would repeat the tear. */
  for (let i = 0; i < bays; i++) {
    const x0 = -len / 2 + bay * i;
    const tornBay = r.chance(0.22);
    const sagMax = r.range(0.02, 0.09);
    const v0 = tornBay ? r.range(0.3, 0.5) : 0;
    a.add(cut, sheet(6, 5, (u, v) => {
      const vv = v0 + v * (1 - v0);
      const sag = Math.sin(u * Math.PI) * sagMax * (0.4 + vv * 0.8);
      // a torn bay's bottom edge is ragged, not a clean cut
      const rag = tornBay && v < 0.02 ? Math.sin(u * 9.1 + i) * 0.09 : 0;
      return [x0 + u * bay, 0.03 + (vv + rag) * (h - 0.12), sag];
    }), null, { grime: 1.15, uvScale: 1, uvOff: [r.range(0, 1), 0] });
    if (tornBay) {
      /* the flap peeled back where somebody cut through */
      a.add(cut, sheet(4, 4, (u, v) => [
        x0 + bay * (0.25 + u * 0.45),
        0.05 + v * v0 * (h - 0.12) * 0.9,
        sagMax + v * r.range(0.18, 0.4) + Math.sin(u * 5 + i) * 0.03,
      ]), null, { grime: 1.3 });
    }
  }
  /* bottom tension wire */
  const bw = [];
  for (let k = 0; k <= bays * 3; k++) {
    const t = k / (bays * 3);
    bw.push([-len / 2 + t * len, 0.09 + Math.sin(t * bays * Math.PI) * 0.02, 0]);
  }
  a.add('galv', tube(bw, 0.008, 5, { cap: false }), null, { grime: 1.4 });

  return {
    colliders: [{ type: 'box', halfExtents: [len / 2, h / 2, 0.06], pos: [0, h / 2, 0], surface: 'metal', material: 'galvanised_metal' }],
    height: h,
    radius: len * 0.55,
  };
}

/* ========================================================================== */
/*                           crates, drums, cans, tyres                       */
/* ========================================================================== */

/** Euro pallet: 3 bearers, 9 blocks, 5 top deck boards, 3 bottom boards. */
export function pallet(a, r, o = {}) {
  const w = o.w ?? 1.2;
  const d = o.d ?? 0.8;
  const bh = 0.078;
  const board = 0.022;
  /* bottom boards */
  for (const z of [-d / 2 + 0.05, 0, d / 2 - 0.05]) {
    a.add('wood', chamferBox(w, board, 0.1, 0.005), xf(0, board / 2, z), { grimeHeight: 0.25 });
  }
  /* nine blocks */
  for (const x of [-w / 2 + 0.05, 0, w / 2 - 0.05]) {
    for (const z of [-d / 2 + 0.05, 0, d / 2 - 0.05]) {
      a.add('wood', chamferBox(0.1, bh, 0.1, 0.006), xf(x, board + bh / 2, z), { grimeHeight: 0.25 });
    }
  }
  /* bearers */
  for (const z of [-d / 2 + 0.05, 0, d / 2 - 0.05]) {
    a.add('wood', chamferBox(w, board, 0.1, 0.005), xf(0, board * 1.5 + bh, z), { grimeHeight: 0.25 });
  }
  /* deck boards, one split off */
  const n = 5;
  const missing = r.chance(0.25) ? r.int(n) : -1;
  for (let i = 0; i < n; i++) {
    if (i === missing) continue;
    const z = -d / 2 + 0.055 + (i * (d - 0.11)) / (n - 1);
    const wide = i === 0 || i === n - 1 ? 0.145 : 0.1;
    a.add('wood', chamferBox(w, board, wide, 0.005), xf(0, board * 2.5 + bh, z, 0, r.jitter(0.008), 0), {
      grimeHeight: 0.25,
      uvOff: [r.range(0, 1.5), r.range(0, 1.5)],
    });
  }
  const top = board * 3 + bh;
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, top / 2, d / 2], pos: [0, top / 2, 0], surface: 'wood' }],
    height: top,
    radius: Math.max(w, d) * 0.6,
    mass: 22,
  };
}

/** Ammunition crate: rope handles, corner irons, a latched lid, stencil block. */
export function ammoCrate(a, r, o = {}) {
  const w = o.w ?? 0.86;
  const h = o.h ?? 0.34;
  const d = o.d ?? 0.4;
  const mat = o.mat || 'olive';
  const lid = o.open ? r.range(0.5, 1.1) : 0;
  a.add(mat, chamferBox(w, h - 0.05, d, 0.014), xf(0, (h - 0.05) / 2, 0), { grimeHeight: 0.24 });
  /* lid, hinged at the back */
  const ly = h - 0.02;
  a.add(mat, chamferBox(w, 0.05, d, 0.012),
    xf(0, ly + Math.sin(lid) * (d / 2), -(1 - Math.cos(lid)) * (d / 2), -lid), { grimeHeight: 0.3 });
  /* corner irons */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      a.add('rust', chamferBox(0.05, h - 0.06, 0.014, 0.004), xf((sx * (w - 0.05)) / 2, (h - 0.05) / 2, (sz * d) / 2 + sz * 0.004), { grime: 1.3 });
      a.add('rust', chamferBox(0.014, h - 0.06, 0.05, 0.004), xf((sx * w) / 2 + sx * 0.004, (h - 0.05) / 2, (sz * (d - 0.05)) / 2), { grime: 1.3 });
    }
  }
  /* rope handles at each end */
  for (const sx of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      pts.push([(sx * w) / 2 + sx * Math.sin(t * Math.PI) * 0.07, h * 0.6, lerp(-d * 0.28, d * 0.28, t)]);
    }
    a.add('canvas', tube(pts, 0.014, 5, { cap: false }), null, { grime: 1.3 });
  }
  /* latches */
  for (const sx of [-0.3, 0.3]) {
    a.add('rust', chamferBox(0.06, 0.07, 0.016, 0.004), xf(sx * w, h - 0.06, d / 2 + 0.008), { grime: 1.2 });
  }
  /* stencil */
  a.add('signWhite', chamferBox(w * 0.42, 0.075, 0.005, 0.002), xf(-w * 0.08, h * 0.45, d / 2 + 0.01), { grime: 0.9 });
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, h / 2, d / 2], pos: [0, h / 2, 0], surface: 'wood' }],
    height: h,
    radius: Math.max(w, d) * 0.6,
    mass: 34,
  };
}

/** Wooden shipping crate: framed panels, cleats, a stencil, sometimes broken slats. */
export function woodCrate(a, r, o = {}) {
  const s = o.size ?? r.range(0.5, 0.82);
  const hs = o.h ?? s * r.range(0.75, 1.05);
  const t = 0.022;
  const damaged = o.damaged ?? r.chance(0.28);
  /* panels: 3 slats per face so a missing one reads as damage */
  for (const [ax, sgn] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
    const nSlat = 3;
    for (let i = 0; i < nSlat; i++) {
      if (damaged && ax === 0 && sgn === 1 && i === 1 && r.chance(0.7)) continue;
      const y = (hs / nSlat) * (i + 0.5);
      const sh = hs / nSlat - 0.012;
      const p = ax === 0 ? [(sgn * s) / 2, y, 0] : [0, y, (sgn * s) / 2];
      a.add('wood', chamferBox(ax === 0 ? t : s, sh, ax === 0 ? s : t, 0.006),
        xf(p[0], p[1], p[2], 0, 0, r.jitter(0.01)), { grimeHeight: 0.3, uvOff: [r.range(0, 1.5), r.range(0, 1.5)] });
    }
  }
  a.add('wood', chamferBox(s, t, s, 0.006), xf(0, hs - t / 2, 0), { grimeHeight: 0.3 });
  a.add('wood', chamferBox(s - 0.04, t, s - 0.04, 0.005), xf(0, t / 2, 0), { grimeHeight: 0.3 });
  /* corner cleats */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      a.add('wood', chamferBox(0.045, hs, 0.045, 0.007), xf((sx * (s - 0.03)) / 2, hs / 2, (sz * (s - 0.03)) / 2), { grimeHeight: 0.3 });
    }
  }
  /* strap band and a stencil */
  if (r.chance(0.5)) a.add('rust', chamferBox(s + 0.01, 0.024, s + 0.01, 0.004), xf(0, hs * r.range(0.4, 0.7), 0), { grime: 1.3 });
  a.add('signWhite', chamferBox(s * 0.42, 0.09, 0.005, 0.002), xf(0, hs * 0.55, s / 2 + 0.006, 0, 0, r.jitter(0.06)), { grime: 0.85 });
  /* splintered slat on the floor next to it */
  if (damaged) {
    a.add('wood', chamferBox(r.range(0.2, 0.45), 0.02, 0.09, 0.005),
      xf(r.range(0.4, 0.7) * (r.chance(0.5) ? 1 : -1), 0.012, r.jitter(0.4), 0, r.range(0, TAU), 0), { grime: 1.4 });
  }
  return {
    colliders: [{ type: 'box', halfExtents: [s / 2, hs / 2, s / 2], pos: [0, hs / 2, 0], surface: 'wood' }],
    height: hs,
    radius: s * 0.72,
    mass: 28,
  };
}

/**
 * 205 l oil drum. Rolling hoops, chimes, two bungs, dents that actually deform the
 * silhouette, and a tipped variant that lies on its side.
 */
export function oilDrum(a, r, o = {}) {
  const R = 0.288;
  const H = 0.88;
  const tipped = o.tipped ?? false;
  const mat = o.mat || (r.chance(0.55) ? 'rust' : r.pick(['signRed', 'plasticBlue', 'olive']));
  const dentA = r.range(0, TAU);
  const dentB = r.range(0, TAU);
  const dentAmt = r.range(0.008, 0.03);

  const body = revolve(
    [
      [0, 0], [R - 0.025, 0], [R - 0.008, 0.022], [R - 0.008, 0.05],
      [R, 0.075], [R, 0.16], [R - 0.012, 0.185], [R - 0.012, H * 0.32],
      [R, H * 0.35], [R, H * 0.45], [R - 0.012, H * 0.48], [R - 0.012, H * 0.66],
      [R, H * 0.69], [R, H * 0.79], [R - 0.012, H * 0.82], [R - 0.012, H - 0.185],
      [R, H - 0.16], [R, H - 0.075], [R - 0.008, H - 0.05], [R - 0.008, H - 0.022],
      [R - 0.025, H], [0, H],
    ],
    18
  );
  /* dent the drum by pushing vertices in along two lobes */
  for (let k = 0; k < body.p.length; k += 3) {
    const x = body.p[k];
    const z = body.p[k + 2];
    const y = body.p[k + 1];
    const rr = Math.hypot(x, z);
    if (rr < 1e-4) continue;
    const ang = Math.atan2(z, x);
    const d =
      dentAmt * Math.exp(-Math.pow((((ang - dentA + Math.PI * 3) % TAU) - Math.PI) * 1.8, 2)) * Math.exp(-Math.pow((y - H * 0.42) * 4, 2)) +
      dentAmt * 0.7 * Math.exp(-Math.pow((((ang - dentB + Math.PI * 3) % TAU) - Math.PI) * 2.4, 2)) * Math.exp(-Math.pow((y - H * 0.72) * 5, 2));
    const f = (rr - d) / rr;
    body.p[k] = x * f;
    body.p[k + 2] = z * f;
  }

  const local = tipped ? xf(0, R, 0, 0, r.range(0, TAU), Math.PI / 2) : xf(0, 0, 0, 0, r.range(0, TAU), 0);
  a.push(local);
  a.add(mat, body, xf(0, tipped ? -H / 2 : 0, 0), { grimeHeight: 0.4, uvOff: [r.range(0, 2), r.range(0, 2)] });
  /* two bungs on the top head */
  const topY = tipped ? H / 2 : H;
  a.add('rust', cyl(0.036, 0.014, 8, { chamfer: 0.003 }), xf(R * 0.55, topY + 0.006, 0), { grime: 1.2 });
  a.add('rust', cyl(0.022, 0.012, 8, { chamfer: 0.003 }), xf(-R * 0.5, topY + 0.005, R * 0.28), { grime: 1.2 });
  /* a painted band so the drums are not all one value */
  if (r.chance(0.45)) {
    a.add(r.pick(['signWhite', 'signRed', 'olive']), revolve([[R + 0.002, H * 0.4], [R + 0.002, H * 0.58]], 18),
      xf(0, tipped ? -H / 2 : 0, 0), { grime: 1.1 });
  }
  a.pop();

  const collider = tipped
    ? { type: 'box', halfExtents: [H / 2, R, R], pos: [0, R, 0], surface: 'metal' }
    : { type: 'box', halfExtents: [R * 0.92, H / 2, R * 0.92], pos: [0, H / 2, 0], surface: 'metal' };
  return { colliders: [collider], height: tipped ? R * 2 : H, radius: tipped ? H * 0.55 : R * 1.1, mass: 32 };
}

/** 20 l jerry can: the three-handle top, the X swage, a spout cap and a chain. */
export function jerryCan(a, r, o = {}) {
  const w = 0.165;
  const h = 0.47;
  const d = 0.34;
  const mat = o.mat || r.pick(['olive', 'rust', 'signRed']);
  a.add(mat, chamferBox(w, h - 0.08, d, 0.018), xf(0, (h - 0.08) / 2 + 0.01, 0), { grimeHeight: 0.24 });
  /* the pressed X swage on both faces */
  const diag = Math.hypot(h * 0.66, d * 0.72);
  for (const sx of [-1, 1]) {
    for (const s of [-1, 1]) {
      a.add(mat, chamferBox(0.012, 0.022, diag, 0.004),
        xf((sx * w) / 2 + sx * 0.004, h * 0.46, 0, s * Math.atan2(h * 0.66, d * 0.72), 0, 0), { grime: 0.9 });
    }
  }
  /* shoulder + the three handles */
  a.add(mat, chamferBox(w * 0.92, 0.07, d * 0.9, 0.014), xf(0, h - 0.055, 0), { grimeHeight: 0.3 });
  for (const z of [-d * 0.3, 0, d * 0.3]) {
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      pts.push([0, h - 0.03 + Math.sin(t * Math.PI) * 0.045, z + (t - 0.5) * 0.1]);
    }
    a.add(mat, tube(pts, 0.014, 5, { cap: false }), null, { grime: 1.0 });
  }
  /* spout + cap + retaining chain */
  a.add(mat, cyl(0.032, 0.05, 8, { chamfer: 0.005 }), xf(0, h - 0.005, d * 0.32, 0.22, 0, 0), { grime: 1.0 });
  a.add('rust', cyl(0.036, 0.02, 8, { chamfer: 0.004 }), xf(0, h + 0.025, d * 0.34, 0.22, 0, 0), { grime: 1.2 });
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, h / 2, d / 2], pos: [0, h / 2, 0], surface: 'metal' }],
    height: h,
    radius: d * 0.6,
    mass: 18,
  };
}

/** Tyre stack — each tyre squashed by the one above and rotated off-axis. */
export function tyreStack(a, r, o = {}) {
  const n = o.count ?? 2 + r.int(4);
  const R = o.radius ?? r.range(0.31, 0.36);
  const tr = R * 0.3;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const squash = 1 - i * 0.02;
    const th = tr * 2 * 0.8 * squash;
    a.add('tyre', torusPrim(R - tr * 0.55, tr * 0.8, 16, 8),
      xf(r.jitter(0.035), y + th / 2, r.jitter(0.035), r.jitter(0.05), r.range(0, TAU), r.jitter(0.05), squash), {
        grimeHeight: 0.5,
        uvOff: [r.range(0, 2), r.range(0, 2)],
      });
    /* the rim on some of them */
    if (r.chance(0.3)) {
      a.add('galv', revolve([[0, 0], [R * 0.52, 0], [R * 0.6, th * 0.2], [R * 0.6, -th * 0.2], [R * 0.52, 0]], 12),
        xf(0, y + th / 2, 0), { grime: 1.3 });
    }
    y += th * 0.92;
  }
  return {
    colliders: [{ type: 'box', halfExtents: [R, y / 2, R], pos: [0, y / 2, 0], surface: 'rubber' }],
    height: y,
    radius: R * 1.1,
    mass: 9 * n,
  };
}

/** Single tyre lying flat or leaning. */
export function tyre(a, r, o = {}) {
  const R = o.radius ?? r.range(0.3, 0.36);
  const tr = R * 0.27;
  const lean = o.lean ?? (r.chance(0.35) ? r.range(0.9, 1.5) : 0);
  a.add('tyre', torusPrim(R - tr, tr, 16, 8), xf(0, lean > 0.5 ? R * 0.9 : tr, 0, lean, r.range(0, TAU), 0), {
    grimeHeight: 0.4,
    uvOff: [r.range(0, 2), r.range(0, 2)],
  });
  return {
    colliders: [{ type: 'box', halfExtents: [R, tr, R], pos: [0, tr, 0], surface: 'rubber' }],
    height: tr * 2,
    radius: R,
    mass: 8,
  };
}

/** Cable drum: two timber flanges, a lagged barrel, a part-unwound cable. */
export function cableSpool(a, r, o = {}) {
  const R = o.radius ?? r.range(0.52, 0.72);
  const w = o.w ?? R * 0.85;
  const hubR = R * 0.34;
  const onSide = o.onSide ?? r.chance(0.25);
  a.push(onSide ? xf(0, R, 0, 0, r.range(0, TAU), 0) : xf(0, R, 0, 0, r.range(0, TAU), Math.PI / 2));
  /* flanges: a disc with radial planks */
  for (const s of [-1, 1]) {
    a.add('wood', revolve([[0, 0], [R, 0], [R, 0.035], [0, 0.035]], 20), xf(0, (s * w) / 2 - 0.017, 0), { grime: 1.2 });
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * TAU;
      a.add('wood', chamferBox(R * 1.8, 0.02, 0.09, 0.005), xf(0, (s * w) / 2 + s * 0.026, 0, 0, ang, 0), { grime: 1.15 });
    }
  }
  a.add('wood', cyl(hubR, w - 0.05, 14, { chamfer: 0.01 }), null, { grime: 1.2 });
  /* the cable, coiled */
  const turns = 5;
  for (let i = 0; i < turns; i++) {
    const rr = hubR + 0.035 + i * 0.035;
    if (rr > R - 0.09) break;
    a.add('tyre', torusPrim(rr, 0.016, 18, 5), xf(0, r.jitter(w * 0.2), 0, 0, 0, Math.PI / 2), { grime: 1.1 });
  }
  /* the loose tail hanging off */
  const tail = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    tail.push([Math.cos(t * 2.4) * (R * 0.9), -w / 2 - t * 0.05, Math.sin(t * 2.4) * (R * 0.9) - t * 0.3]);
  }
  a.add('tyre', tube(tail, 0.016, 5, { cap: false }), null, { grime: 1.3 });
  /* axle stub */
  a.add('rust', cyl(0.035, w + 0.14, 8, { chamfer: 0.005 }), null, { grime: 1.3 });
  a.pop();
  return {
    colliders: onSide
      ? [{ type: 'box', halfExtents: [R, w / 2 + 0.05, R], pos: [0, w / 2 + 0.05, 0], surface: 'wood' }]
      : [{ type: 'box', halfExtents: [R, R, w / 2 + 0.05], pos: [0, R, 0], surface: 'wood' }],
    height: onSide ? w + 0.1 : R * 2,
    radius: R * 1.05,
    mass: 65,
  };
}

export default {
  sandbagWall,
  sandbagPile,
  jerseyBarrier,
  hesco,
  razorWire,
  chainLink,
  pallet,
  ammoCrate,
  woodCrate,
  oilDrum,
  jerryCan,
  tyreStack,
  tyre,
  cableSpool,
};
