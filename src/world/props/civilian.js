/**
 * props/civilian.js — the stuff that makes a street look inhabited. Owner: props agent.
 *
 * Same contract as props/street.js. Cloth (awnings, laundry, tarps) is built with the
 * `sheet()` grid and a catenary + ripple displacement so it never reads as a flat card,
 * and the fabric materials carry the MaterialLibrary's sheen path.
 */
import { chamferBox, cyl, revolve, tube, torusPrim, sheet, blob, xf, clamp01, lerp, TAU } from './geom.js';
import { signageLayout, cellUv, cellAspect, signQuad, addSign } from './signage.js';

/** The atlas layout is pure data — one copy for every generator in the module. */
const SIGNS = signageLayout();

/** Pick a cell from a group and return everything a quad needs to use it. */
function pickCell(r, group) {
  const list = SIGNS.groups[group] || SIGNS.groups.fascia;
  const name = list[r.int(list.length)];
  return { name, uv: cellUv(SIGNS, name), aspect: cellAspect(SIGNS, name) };
}

/* ========================================================================== */
/*                                market stall                                */
/* ========================================================================== */

/**
 * Souk stall: a timber trestle with a scalloped fabric awning on four poles, produce
 * crates on the counter, a hanging bulb and a price board.
 */
export function marketStall(a, r, o = {}) {
  const w = o.w ?? r.range(2.1, 2.7);
  const d = o.d ?? r.range(1.1, 1.4);
  const legH = 0.78;
  const poleH = o.poleH ?? r.range(2.15, 2.45);
  const cloth = r.pick(['tarp', 'canvas', 'tarp', 'canvas', 'tarp']);

  /* four poles, each leaning slightly differently */
  const poles = [
    [-w / 2 + 0.06, -d / 2 + 0.06],
    [w / 2 - 0.06, -d / 2 + 0.06],
    [-w / 2 + 0.06, d / 2 - 0.06],
    [w / 2 - 0.06, d / 2 - 0.06],
  ];
  for (const [px, pz] of poles) {
    a.add('wood', cyl(0.036, poleH, 8, { chamfer: 0.006 }), xf(px, poleH / 2, pz, r.jitter(0.025), 0, r.jitter(0.025)), {
      grimeHeight: 0.35,
    });
    a.add('rust', chamferBox(0.05, 0.02, 0.05, 0.004), xf(px, 0.01, pz), { grime: 1.6 });
  }
  /* header rails the awning is lashed to */
  for (const sz of [-1, 1]) {
    a.add('wood', chamferBox(w, 0.05, 0.045, 0.008), xf(0, poleH - 0.04, (sz * (d - 0.12)) / 2), { grimeHeight: 0.4 });
  }
  a.add('wood', chamferBox(0.045, 0.045, d, 0.008), xf(-w / 2 + 0.06, poleH - 0.09, 0), { grimeHeight: 0.4 });
  a.add('wood', chamferBox(0.045, 0.045, d, 0.008), xf(w / 2 - 0.06, poleH - 0.09, 0), { grimeHeight: 0.4 });

  /* awning: a sagging sheet with a ridge, overhanging the front */
  const phase = r.range(0, TAU);
  const over = r.range(0.35, 0.6);
  a.add(cloth, sheet(9, 5, (u, v) => {
    const across = (u - 0.5) * (w + 0.3);
    const along = (v - 0.5) * (d + over * 2);
    const ridge = Math.cos((u - 0.5) * Math.PI) * 0.1;
    const droop = -Math.pow(Math.abs(along) / (d / 2 + over), 2.2) * 0.24;
    const flap = Math.sin(u * 6.2 + phase) * 0.022 + Math.sin(v * 4.1 + phase * 1.3) * 0.018;
    return [across, poleH + 0.05 + ridge + droop + flap, along];
  }), null, {
    // dirtiest where the rain runs off the overhang and along the lashing line
    grime: (wx, wy, wz, lx, ly, lz) => 0.75 + 0.55 * clamp01((Math.abs(lz) - d * 0.2) / (over + d * 0.3)),
    uvOff: [r.range(0, 2), r.range(0, 2)],
    // free at the overhanging edges, pinned along the header rails
    flap: (wx, wy, wz, lx, ly, lz) => clamp01((Math.abs(lz) - d * 0.34) / (over + d * 0.16)),
  });
  /* scalloped valance along the front edge */
  const scallops = 7;
  for (let i = 0; i < scallops; i++) {
    const u = (i + 0.5) / scallops;
    const sw = (w + 0.3) / scallops;
    a.add(cloth, sheet(3, 3, (uu, vv) => [
      (u - 0.5) * (w + 0.3) + (uu - 0.5) * sw * 0.94,
      poleH - 0.05 - vv * (0.16 + Math.sin(uu * Math.PI) * 0.07),
      d / 2 + over + Math.sin(vv * 2.4 + phase) * 0.02,
    ]), null, { grime: 1.25, flap: (wx, wy, wz, lx, ly) => clamp01((poleH - 0.05 - ly) / 0.2) });
  }

  /* trestle counter */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      a.add('wood', chamferBox(0.06, legH, 0.06, 0.008), xf((sx * (w - 0.4)) / 2, legH / 2, (sz * (d - 0.36)) / 2), { grimeHeight: 0.3 });
    }
    a.add('wood', chamferBox(0.05, 0.05, d - 0.36, 0.008), xf((sx * (w - 0.4)) / 2, legH * 0.34, 0), { grimeHeight: 0.3 });
  }
  a.add('wood', chamferBox(w - 0.24, 0.045, d - 0.22, 0.01), xf(0, legH + 0.022, 0, r.jitter(0.008), 0, r.jitter(0.006)), {
    grimeHeight: 0.3,
    uvOff: [r.range(0, 2), r.range(0, 2)],
  });
  /* cloth thrown over the counter, hanging down the front */
  if (r.chance(0.6)) {
    a.add(cloth, sheet(7, 5, (u, v) => {
      const along = (v - 0.5) * (d + 0.22);
      const drop = clamp01((Math.abs(along) - d / 2 + 0.06) / 0.24);
      return [
        (u - 0.5) * (w - 0.18),
        legH + 0.05 - drop * r.range(0.3, 0.5) + Math.sin(u * 5 + phase) * 0.012,
        Math.sign(along) * Math.min(Math.abs(along), d / 2 + 0.02),
      ];
    }), null, {
      grime: 1.05,
      uvOff: [r.range(0, 2), r.range(0, 2)],
      flap: (wx, wy, wz, lx, ly) => clamp01((legH + 0.05 - ly) / 0.4) * 0.8,
    });
  }

  /* produce boxes on the counter */
  const boxes = 2 + r.int(3);
  for (let i = 0; i < boxes; i++) {
    const bw = r.range(0.3, 0.46);
    const bd = r.range(0.26, 0.36);
    const bx = -w / 2 + 0.35 + (i * (w - 0.7)) / Math.max(1, boxes - 1) + r.jitter(0.05);
    produceCrate(a, r, { w: bw, d: bd, ox: bx, oy: legH + 0.045, oz: r.jitter(d * 0.16), oyaw: r.jitter(0.3) });
  }
  /* a hanging bulb on a flex */
  a.add('rust', tube([[0, poleH, 0], [0.02, poleH - 0.24, 0.03], [0.02, poleH - 0.38, 0.03]], 0.006, 5, { cap: false }), null, { grime: 1.2 });
  a.add('lens', blob(0.075, 0.1, 0.075, 8), xf(0.02, poleH - 0.43, 0.03), { grime: 0.15 });
  /* Price board leaning against a leg — with something written on it. The plaza
     stalls are 13 m from the hero lens, so this is one of the closest legible marks
     in the whole frame. */
  {
    const board = pickCell(r, r.chance(0.5) ? 'notice' : 'street');
    const bw = 0.44;
    const bh = bw / board.aspect;
    const M = xf(-w / 2 + 0.28, 0.16 + bh * 0.5, d / 2 + 0.06, -0.28, r.jitter(0.2), 0);
    a.add('paintwood', chamferBox(bw + 0.03, bh + 0.03, 0.018, 0.006), M, { grime: 1.2 });
    addSign(a, 'signage', signQuad(bw, bh, board.uv), M.clone().multiply(xf(0, 0, 0.012)), { grime: 0.6 });
  }
  /* a fascia strip lashed to the front rail — the trader's own name */
  if (r.chance(0.55)) {
    const f = pickCell(r, 'fascia');
    const fw = Math.min(w * 0.86, 1.5);
    addSign(a, 'signage', signQuad(fw, fw / f.aspect, f.uv), xf(0, poleH - 0.16, d / 2 + over - 0.02), { grime: 0.7 });
  }

  return {
    colliders: [
      { type: 'box', halfExtents: [(w - 0.2) / 2, 0.09, (d - 0.18) / 2], pos: [0, legH, 0], surface: 'wood' },
      { type: 'box', halfExtents: [0.07, poleH / 2, 0.07], pos: [-w / 2 + 0.06, poleH / 2, -d / 2 + 0.06], surface: 'wood' },
      { type: 'box', halfExtents: [0.07, poleH / 2, 0.07], pos: [w / 2 - 0.06, poleH / 2, -d / 2 + 0.06], surface: 'wood' },
      { type: 'box', halfExtents: [0.07, poleH / 2, 0.07], pos: [-w / 2 + 0.06, poleH / 2, d / 2 - 0.06], surface: 'wood' },
      { type: 'box', halfExtents: [0.07, poleH / 2, 0.07], pos: [w / 2 - 0.06, poleH / 2, d / 2 - 0.06], surface: 'wood' },
    ],
    height: poleH + 0.2,
    radius: Math.max(w, d) * 0.65,
    lights: [{ kind: 'point', pos: [0.02, poleH - 0.46, 0.03], color: 0xffd9a2, intensity: 2.4, distance: 5 }],
  };
}

/** Slatted produce crate, optionally heaped with fruit. */
export function produceCrate(a, r, o = {}) {
  const w = o.w ?? r.range(0.36, 0.48);
  const d = o.d ?? r.range(0.28, 0.36);
  const h = o.h ?? r.range(0.14, 0.2);
  const mat = o.mat || (r.chance(0.5) ? 'ply' : r.pick(['plasticBlue', 'plasticGreen']));
  // ox/oy/oz are a *local* offset (marketStall stacks crates on its counter). They are
  // deliberately not x/y/z: those are world-space placement fields owned by Props.js.
  const M = xf(o.ox ?? 0, o.oy ?? 0, o.oz ?? 0, 0, o.oyaw ?? 0, 0);
  a.push(M);
  /* corner posts + slatted sides */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      a.add(mat, chamferBox(0.028, h, 0.028, 0.005), xf((sx * (w - 0.02)) / 2, h / 2, (sz * (d - 0.02)) / 2), { grimeHeight: 0.16 });
    }
  }
  for (const sz of [-1, 1]) {
    for (const y of [h * 0.24, h * 0.76]) {
      a.add(mat, chamferBox(w, h * 0.34, 0.014, 0.004), xf(0, y, (sz * d) / 2), { grimeHeight: 0.16 });
    }
  }
  for (const sx of [-1, 1]) {
    for (const y of [h * 0.24, h * 0.76]) {
      a.add(mat, chamferBox(0.014, h * 0.34, d, 0.004), xf((sx * w) / 2, y, 0), { grimeHeight: 0.16 });
    }
  }
  a.add(mat, chamferBox(w - 0.02, 0.012, d - 0.02, 0.004), xf(0, 0.006, 0), { grimeHeight: 0.16 });
  /* heap of produce */
  if (o.empty !== true) {
    const n = 5 + r.int(6);
    for (let i = 0; i < n; i++) {
      const s = r.range(0.055, 0.095);
      a.add('produce', blob(s, s * r.range(0.8, 1.05), s, 7, (dx, dy, dz) => 1 + 0.08 * Math.sin(dx * 7 + dz * 5 + dy * 3)),
        xf(r.jitter(w * 0.34), h + r.range(-0.01, 0.05), r.jitter(d * 0.3), r.range(0, 1), r.range(0, TAU), r.range(0, 1)), {
          grime: 0.35,
          uvOff: [r.range(0, 3), r.range(0, 3)],
        });
    }
  }
  a.pop();
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, h / 2, d / 2], pos: [o.ox ?? 0, (o.oy ?? 0) + h / 2, o.oz ?? 0], surface: 'wood' }],
    height: (o.oy ?? 0) + h + 0.06,
    radius: Math.max(w, d) * 0.7,
    mass: 9,
  };
}

/** Stacked plastic chairs / a single chair, and a folding table. */
export function plasticChair(a, r, o = {}) {
  const mat = o.mat || r.pick(['plasticBlue', 'plasticGreen', 'signWhite']);
  const n = o.stack ?? 1;
  const seatY = 0.44;
  for (let k = 0; k < n; k++) {
    const y = k * 0.075;
    const yaw = r.jitter(0.08) * k;
    a.push(xf(r.jitter(0.012) * k, y, r.jitter(0.012) * k, 0, yaw, 0));
    /* four tapered legs */
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const tx = sx * 0.21;
        const tz = sz * 0.2;
        a.add(mat, tube([[tx * 0.78, 0.005, tz * 0.78], [tx, seatY - 0.02, tz]], 0.017, 6), null, { grimeHeight: 0.22 });
      }
    }
    /* dished seat */
    a.add(mat, sheet(5, 5, (u, v) => [
      (u - 0.5) * 0.44,
      seatY - (Math.sin(u * Math.PI) * Math.sin(v * Math.PI)) * 0.03,
      (v - 0.5) * 0.42,
    ]), null, { grime: 0.9 });
    a.add(mat, chamferBox(0.44, 0.022, 0.42, 0.012), xf(0, seatY - 0.035, 0), { grimeHeight: 0.22 });
    /* back with the classic slot */
    a.add(mat, chamferBox(0.42, 0.36, 0.024, 0.01), xf(0, seatY + 0.2, -0.19, -0.12, 0, 0), { grimeHeight: 0.3 });
    a.add(mat, chamferBox(0.3, 0.05, 0.03, 0.008), xf(0, seatY + 0.36, -0.21, -0.12, 0, 0), { grime: 0.7 });
    /* armrests */
    for (const sx of [-1, 1]) {
      a.add(mat, chamferBox(0.05, 0.03, 0.34, 0.008), xf(sx * 0.215, seatY + 0.19, -0.03), { grime: 0.8 });
      a.add(mat, chamferBox(0.045, 0.2, 0.045, 0.008), xf(sx * 0.215, seatY + 0.09, 0.12), { grime: 0.8 });
    }
    a.pop();
  }
  const h = seatY + 0.4 + (n - 1) * 0.075;
  return {
    colliders: [{ type: 'box', halfExtents: [0.24, h / 2, 0.24], pos: [0, h / 2, 0], surface: 'wood', material: 'plywood_painted' }],
    height: h,
    radius: 0.3,
    mass: 4 * n,
  };
}

/** Cafe table: a round top on a folding cross-frame. */
export function cafeTable(a, r, o = {}) {
  const R = o.radius ?? r.range(0.34, 0.42);
  const h = 0.72;
  a.add('plasticBlue', revolve([[0, h], [R - 0.02, h], [R, h - 0.015], [R, h - 0.04], [R - 0.02, h - 0.052], [0, h - 0.052]], 18), null, {
    grime: 0.85,
  });
  a.add('galv', cyl(0.03, h - 0.06, 8, { chamfer: 0.005 }), xf(0, (h - 0.06) / 2, 0), { grimeHeight: 0.3 });
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * TAU + r.range(0, 1);
    a.add('galv', tube([[0, 0.28, 0], [Math.cos(ang) * R * 0.85, 0.012, Math.sin(ang) * R * 0.85]], 0.017, 6), null, { grimeHeight: 0.25 });
  }
  return {
    colliders: [{ type: 'box', halfExtents: [R, h / 2, R], pos: [0, h / 2, 0], surface: 'metal' }],
    height: h,
    radius: R * 1.1,
    mass: 11,
  };
}

/**
 * Laundry line: a catenary cord between two anchors with garments pegged to it. The
 * origin is the first anchor; `o.to` is the second, in prop-local space.
 */
export function laundryLine(a, r, o = {}) {
  const to = o.to || [4, 0, 0];
  const sag = o.sag ?? Math.hypot(to[0], to[2]) * 0.06;
  const pts = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    pts.push([
      lerp(0, to[0], t),
      lerp(0, to[1], t) - Math.sin(t * Math.PI) * sag,
      lerp(0, to[2], t),
    ]);
  }
  a.add('rust', tube(pts, 0.006, 4, { cap: false }), null, { grime: 1.1 });
  /* a line has to hang off something: two lashed poles unless the caller says otherwise */
  if (o.posts !== false) {
    for (const [px, py, pz] of [[0, 0, 0], to]) {
      a.add('rust', cyl(0.028, 1.5, 7, { chamfer: 0.005 }), xf(px, py - 0.72, pz, r.jitter(0.03), 0, r.jitter(0.03)), { grimeHeight: 0.5 });
      a.add('rust', chamferBox(0.11, 0.03, 0.11, 0.006), xf(px, py - 1.45, pz), { grime: 1.5 });
    }
  }
  const n = o.count ?? 3 + r.int(5);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.7) / (n + 0.4);
    const px = lerp(0, to[0], t);
    const py = lerp(0, to[1], t) - Math.sin(t * Math.PI) * sag;
    const pz = lerp(0, to[2], t);
    const gw = r.range(0.3, 0.52);
    const gh = r.range(0.38, 0.72);
    // xf() maps local +X to (cos yaw, 0, -sin yaw), so the sign on Z is negated
    const yaw = Math.atan2(-to[2], to[0]);
    const phase = r.range(0, TAU);
    /**
     * Washing is mostly pale, and a shirt is roughly rectangular. The old garment was
     * pinched from 35 % at the line out to 100 % at the hem, which makes a triangle,
     * and it picked between two dark cloths — so a street full of these read as a row
     * of dark pennants rather than as laundry. Light cloth three times in four, and a
     * much gentler taper.
     */
    a.add(r.pick(['signWhite', 'signWhite', 'canvas', 'card', 'tarp']), sheet(5, 6, (u, v) => {
      // pinched at the shoulders, hanging almost straight below
      const pinch = 0.78 + 0.22 * v;
      const swayX = Math.sin(v * 3.1 + phase) * 0.05 * v;
      const swayZ = Math.sin(v * 2.3 + phase * 1.6) * 0.07 * v;
      return [(u - 0.5) * gw * pinch + swayX, -v * gh, swayZ + Math.sin(u * 4.4 + phase) * 0.035 * v];
    }), xf(px, py - 0.01, pz, 0, yaw, 0), {
      grime: 0.5,
      uvOff: [r.range(0, 2), r.range(0, 2)],
      flap: (wx, wy, wz, lx, ly) => clamp01(-ly / Math.max(0.05, gh)),
    });
    /* two pegs */
    for (const s of [-1, 1]) {
      a.add('ply', chamferBox(0.012, 0.045, 0.02, 0.003),
        xf(px, py + 0.012, pz, 0, yaw, 0).multiply(xf(s * gw * 0.16, 0, 0)), { grime: 0.9 });
    }
  }
  return { colliders: [], height: 0, radius: Math.hypot(to[0], to[2]) * 0.5 };
}

/** Satellite dish on a wall or pole bracket (origin at the mount, +Z away from wall). */
export function satelliteDish(a, r, o = {}) {
  const R = o.radius ?? r.range(0.28, 0.44);
  const tiltX = o.tilt ?? r.range(-0.5, -0.15);
  const aim = o.aim ?? r.jitter(0.7);
  /* wall plate + arm */
  a.add('galv', chamferBox(0.11, 0.16, 0.02, 0.005), xf(0, 0, 0.01), { grime: 1.2 });
  a.add('galv', cyl(0.022, 0.22, 8, { chamfer: 0.004 }), xf(0, 0, 0.12, Math.PI / 2, 0, 0), { grime: 1.2 });
  a.push(xf(0, 0, 0.22, tiltX, aim, 0));
  /* the offset paraboloid: a shallow revolve with a rolled rim */
  const prof = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    prof.push([R * t, (R * t * R * t) / (R * 1.6)]);
  }
  prof.push([R + 0.012, (R * R) / (R * 1.6) - 0.012]);
  a.add('signWhite', revolve(prof, 18), xf(0, 0, 0, -Math.PI / 2, 0, 0), { grime: 1.05 });
  /* LNB on its arm */
  a.add('galv', tube([[0, 0.02, 0], [R * 0.28, 0.05, R * 0.62]], 0.012, 5), null, { grime: 1.1 });
  a.add('signWhite', cyl(0.028, 0.1, 8, { chamfer: 0.005 }), xf(R * 0.3, 0.05, R * 0.66, -0.9, 0, 0), { grime: 1.0 });
  a.pop();
  /* coax drooping away */
  a.add('rust', tube([[0, -0.02, 0.16], [0.03, -0.18, 0.1], [0.03, -0.42, 0.03]], 0.007, 5, { cap: false }), null, { grime: 1.2 });
  return { colliders: [], height: 0, radius: R * 1.2 };
}

/** Rooftop water tank on a steel stand. */
export function waterTank(a, r, o = {}) {
  const R = o.radius ?? r.range(0.46, 0.62);
  const H = o.h ?? r.range(0.8, 1.1);
  const standH = o.stand ?? r.range(0.35, 0.6);
  const mat = o.mat || r.pick(['plasticBlue', 'galv', 'signWhite']);
  /* stand */
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * TAU + 0.78;
    const px = Math.cos(ang) * R * 0.78;
    const pz = Math.sin(ang) * R * 0.78;
    a.add('rust', chamferBox(0.05, standH, 0.05, 0.008), xf(px, standH / 2, pz), { grimeHeight: 0.3 });
    a.add('rust', chamferBox(0.09, 0.02, 0.09, 0.004), xf(px, 0.01, pz), { grime: 1.6 });
  }
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * TAU + 0.78;
    const a1 = ((i + 1) / 4) * TAU + 0.78;
    a.add('rust', tube(
      [[Math.cos(a0) * R * 0.78, standH * 0.55, Math.sin(a0) * R * 0.78], [Math.cos(a1) * R * 0.78, standH * 0.55, Math.sin(a1) * R * 0.78]],
      0.016, 5
    ), null, { grimeHeight: 0.3 });
  }
  /* the tank: ribbed cylinder with a domed top and a lid */
  const prof = [[0, standH]];
  prof.push([R - 0.03, standH], [R, standH + 0.04]);
  const ribs = 4;
  for (let i = 0; i < ribs; i++) {
    const y0 = standH + 0.08 + (i * (H - 0.2)) / ribs;
    prof.push([R, y0], [R + 0.018, y0 + 0.02], [R + 0.018, y0 + 0.05], [R, y0 + 0.07]);
  }
  prof.push([R, standH + H - 0.1], [R * 0.86, standH + H - 0.02], [R * 0.5, standH + H + 0.03], [0, standH + H + 0.05]);
  a.add(mat, revolve(prof, 18), null, { grimeHeight: 0.5, uvOff: [r.range(0, 2), r.range(0, 2)] });
  /* screw lid + a vent */
  a.add(mat, revolve([[0, 0.03], [0.13, 0.03], [0.14, 0.005], [0.14, -0.02], [0, -0.02]], 12), xf(R * 0.22, standH + H + 0.03, 0), { grime: 0.9 });
  a.add('rust', tube([[0, standH + H * 0.2, R], [0.02, standH * 0.5, R + 0.08], [0.02, 0.05, R + 0.08]], 0.018, 6, { cap: false }), null, {
    grime: 1.3,
  });
  return {
    colliders: [{ type: 'box', halfExtents: [R, (standH + H) / 2, R], pos: [0, (standH + H) / 2, 0], surface: 'metal' }],
    height: standH + H + 0.1,
    radius: R * 1.15,
  };
}

/** TV aerial: a mast with a yagi boom and elements, plus a guy wire. */
export function tvAerial(a, r, o = {}) {
  const h = o.h ?? r.range(1.4, 2.4);
  a.add('rust', cyl(0.02, h, 6, { chamfer: 0.003 }), xf(0, h / 2, 0, r.jitter(0.05), 0, r.jitter(0.04)), { grimeHeight: 0.4 });
  a.add('rust', chamferBox(0.14, 0.03, 0.14, 0.006), xf(0, 0.015, 0), { grime: 1.6 });
  const yaw = r.range(0, TAU);
  a.push(xf(0, h - 0.06, 0, 0, yaw, 0));
  const boom = r.range(0.7, 1.2);
  a.add('rust', chamferBox(boom, 0.018, 0.018, 0.004), null, { grime: 1.2 });
  const n = 6 + r.int(4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const el = lerp(0.62, 0.24, t);
    a.add('rust', chamferBox(0.012, 0.012, el, 0.003), xf(-boom / 2 + t * boom, 0.014, 0), { grime: 1.2 });
  }
  a.add('rust', chamferBox(0.03, 0.05, 0.5, 0.006), xf(-boom / 2 + 0.05, 0.02, 0), { grime: 1.2 });
  a.pop();
  /* guy wire and the feeder */
  a.add('rust', tube([[0, h - 0.2, 0], [r.range(0.5, 0.9), 0.03, r.range(-0.6, 0.6)]], 0.005, 4, { cap: false }), null, { grime: 1.3 });
  a.add('rust', tube([[0, h - 0.1, 0.02], [0.03, h * 0.5, 0.05], [0.06, 0.06, 0.09]], 0.006, 4, { cap: false }), null, { grime: 1.3 });
  return { colliders: [], height: h, radius: 0.6 };
}

/**
 * Rendered chimney / boiler flue: a masonry stack with a galvanised pipe and a cowl.
 * Every roofline in this part of the world has two or three, and a vertical of this
 * proportion is what stops a parapet reading as a ruler.
 */
export function chimneyFlue(a, r, o = {}) {
  const w = o.w ?? r.range(0.42, 0.68);
  const d = o.d ?? w * r.range(0.7, 1.0);
  const h = o.h ?? r.range(0.9, 1.9);
  const mat = o.mat || r.pick(['concrete', 'paving', 'concrete']);
  a.add(mat, chamferBox(w, h, d, 0.02), xf(0, h / 2, 0), { grimeHeight: h * 0.6, uvOff: [r.range(0, 2), r.range(0, 2)] });
  /* a flaunching band and a coping slab */
  a.add('paving', chamferBox(w + 0.09, 0.055, d + 0.09, 0.012), xf(0, h + 0.03, 0), { grime: 1.35 });
  /* the flue itself, off-centre, with a cowl */
  const ox = r.jitter(w * 0.18);
  const fh = r.range(0.35, 0.8);
  a.add('galv', cyl(0.072, fh, 9, { chamfer: 0.008 }), xf(ox, h + 0.06 + fh / 2, 0), { grimeHeight: 0.4 });
  a.add('galv', revolve([[0.05, 0], [0.115, 0.03], [0.115, 0.09], [0.06, 0.14], [0, 0.15]], 10),
    xf(ox, h + 0.06 + fh, 0), { grime: 1.05 });
  if (r.chance(0.55)) {
    a.add('rust', tube([[ox, h + 0.06 + fh * 0.6, 0], [ox + r.range(0.5, 0.9), 0.05, r.jitter(0.7)]], 0.005, 4, { cap: false }), null, {
      grime: 1.35,
    });
  }
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, h / 2, d / 2], pos: [0, h / 2, 0], surface: 'concrete' }],
    height: h + fh + 0.2,
    radius: Math.max(w, d) * 0.75,
  };
}

/**
 * Satellite farm: a short mast carrying three or four dishes plus the junction box and
 * the cable bundle that always hangs off one. Reads at 60 m as a distinctive cluster,
 * which is exactly what a flat parapet needs.
 */
export function dishFarm(a, r, o = {}) {
  const mastH = o.h ?? r.range(1.1, 1.8);
  const n = o.count ?? 3 + r.int(2);
  a.add('rust', cyl(0.038, mastH, 8, { chamfer: 0.005 }), xf(0, mastH / 2, 0, r.jitter(0.03), 0, r.jitter(0.03)), { grimeHeight: 0.5 });
  a.add('rust', chamferBox(0.26, 0.035, 0.26, 0.006), xf(0, 0.018, 0), { grime: 1.6 });
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * TAU + r.range(0, 0.9);
    const y = mastH * (0.42 + (i / n) * 0.5);
    const R = r.range(0.22, 0.38);
    const cx = Math.cos(ang) * 0.1;
    const cz = Math.sin(ang) * 0.1;
    a.add('galv', tube([[0, y, 0], [cx * 2.2, y + 0.02, cz * 2.2]], 0.016, 5), null, { grime: 1.2 });
    a.push(xf(cx * 2.2, y + 0.02, cz * 2.2, r.range(-0.55, -0.15), ang + r.jitter(0.5), 0));
    const prof = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      prof.push([R * t, (R * t * R * t) / (R * 1.6)]);
    }
    prof.push([R + 0.011, (R * R) / (R * 1.6) - 0.011]);
    a.add('signWhite', revolve(prof, 14), xf(0, 0, 0, -Math.PI / 2, 0, 0), { grime: 1.1 });
    a.add('galv', tube([[0, 0.02, 0], [R * 0.28, 0.05, R * 0.6]], 0.011, 5), null, { grime: 1.15 });
    a.pop();
  }
  /* junction box at the foot and a bundle of coax dropping over the parapet */
  a.add('galv', chamferBox(0.16, 0.2, 0.1, 0.012), xf(0.14, 0.11, 0.1), { grime: 1.2 });
  a.add('rust', tube([[0.14, 0.2, 0.12], [0.3, 0.12, 0.3], [0.42, 0.02, 0.55]], 0.014, 5, { cap: false }), null, { grime: 1.3 });
  return {
    colliders: [{ type: 'box', halfExtents: [0.2, mastH / 2, 0.2], pos: [0, mastH / 2, 0], surface: 'metal' }],
    height: mastH + 0.3,
    radius: 0.8,
  };
}

/**
 * Projecting shop sign / fascia board — with the shop's actual name on it.
 *
 * The board used to be a coloured rectangle with a smaller white rectangle glued to
 * the front, which is the single loudest "this is a blockout" tell a street can have.
 * The face is now a quad UV-mapped to a fascia cell of the signage atlas: an enamelled
 * board carrying an Arabic shop name, a French strapline and a phone number, weathered
 * with rust bleed from the fixings. Both faces are lettered, because a projecting sign
 * is read from both directions.
 */
export function shopSign(a, r, o = {}) {
  const cellName = o.cell || pickCell(r, 'fascia').name;
  const uv = cellUv(SIGNS, cellName);
  const aspect = cellAspect(SIGNS, cellName);
  const projecting = o.projecting ?? true;
  /* Size from the artwork, never independently: a 4.5:1 fascia squashed onto a 2:1
     board is illegible, and illegible lettering is worse than none. */
  const w = o.w ?? r.range(1.0, 1.7);
  const h = o.h ?? w / aspect;
  const frame = o.mat || r.pick(['rust', 'galv', 'signWhite']);

  if (projecting) {
    /* cantilever arm out from the wall with a diagonal stay, board hung under it */
    a.add('rust', chamferBox(0.025, 0.05, w * 0.92, 0.005), xf(0, 0.06, (w * 0.92) / 2), { grime: 1.2 });
    a.add('rust', tube([[0, 0.34, 0.02], [0, 0.05, w * 0.74]], 0.009, 5, { cap: false }), null, { grime: 1.3 });
    /* the board itself, hanging in the XZ sense: local +Z is out of the wall */
    const cz = w / 2 + 0.06;
    const cy = -h / 2 - 0.03;
    a.add(frame, chamferBox(0.028, h + 0.045, w + 0.04, 0.01), xf(0, cy, cz), { grime: 1.0 });
    for (const s of [-1, 1]) {
      /* the lettered face on each side of the board */
      addSign(a, 'signage', signQuad(w, h, uv, { flipU: s < 0 }), xf(s * 0.017, cy, cz, 0, s * Math.PI * 0.5, 0), { grime: 0.5 });
    }
    /* two hanger eyes so the board is visibly hung, not floating */
    for (const s of [-1, 1]) {
      a.add('rust', torusPrim(0.02, 0.005, 8, 4), xf(0, 0.02, cz + s * w * 0.36, 0, 0, Math.PI / 2), { grime: 1.4 });
    }
  } else {
    /* flat fascia against the wall, on a shallow tray with a lip */
    a.add(frame, chamferBox(w + 0.07, h + 0.07, 0.055, 0.012), xf(0, 0, 0.028), { grime: 1.0 });
    addSign(a, 'signage', signQuad(w, h, uv), xf(0, 0, 0.058), { grime: 0.45 });
    /* gooseneck lamps over the fascia — the thing that says "this shop trades at night" */
    for (const s of [-1, 1]) {
      const lx = (s * w) / 2 - s * 0.14;
      a.add('rust', tube([[lx, h / 2 + 0.02, 0.03], [lx, h / 2 + 0.17, 0.05], [lx, h / 2 + 0.13, 0.19]], 0.011, 5, { cap: false }), null, {
        grime: 1.3,
      });
      a.add('galv', revolve([[0, 0], [0.055, 0.005], [0.06, 0.03], [0.03, 0.055], [0, 0.055]], 9),
        xf(lx, h / 2 + 0.115, 0.2, Math.PI * 0.62, 0, 0), { grime: 1.1 });
    }
  }
  return { colliders: [], height: h, radius: w * 0.6 };
}

/**
 * A mark on a wall: unit number, street plate, stencilled warning or a spray tag.
 * One quad, one atlas cell, no collider — and the cheapest legibility in the map.
 * `group` picks which family of the atlas to draw from.
 */
export function wallMark(a, r, o = {}) {
  const group = o.group || r.pick(['unit', 'stencil', 'stencil', 'graffiti', 'graffiti', 'street', 'notice']);
  const c = o.cell ? { name: o.cell, uv: cellUv(SIGNS, o.cell), aspect: cellAspect(SIGNS, o.cell) } : pickCell(r, group);
  const board = group === 'unit' || group === 'street' || group === 'notice';
  const w = o.w ?? (board ? r.range(0.4, 0.62) : group === 'graffiti' ? r.range(1.1, 2.0) : r.range(0.8, 1.5));
  const h = w / c.aspect;
  const tilt = board ? 0 : r.jitter(0.06);
  if (board) {
    /* enamel plate stands a few millimetres off the render on four screws */
    a.add('galv', chamferBox(w + 0.02, h + 0.02, 0.012, 0.004), xf(0, 0, 0.012), { grime: 1.1 });
    addSign(a, 'signage', signQuad(w, h, c.uv), xf(0, 0, 0.019), { grime: 0.4 });
  } else {
    /* paint on masonry: dead flat against the wall, slightly off level */
    addSign(a, 'signageDecal', signQuad(w, h, c.uv), xf(0, 0, 0.012, 0, 0, tilt), { grime: 0.5 });
  }
  return { colliders: [], height: h, radius: Math.max(w, h) * 0.6, flat: true };
}

/**
 * Paint on the road: lane arrows, STOP/SLOW, dashes, zebra bars, hatching — plus the
 * cracks, skid marks and oil stains from the same atlas, which is what stops a
 * carriageway reading as one sheet of uniform noise.
 *
 * The quad is laid in the XZ plane with the artwork's "up" pointing along +Z of the
 * prop, so a caller aims it down the lane with `yaw`.
 */
export function roadMark(a, r, o = {}) {
  const group = o.group || 'road';
  const c = o.cell ? { name: o.cell, uv: cellUv(SIGNS, o.cell) } : pickCell(r, group);
  const w = o.w ?? (group === 'grime' ? r.range(1.6, 3.0) : r.range(1.1, 1.5));
  const len = o.len ?? (group === 'grime' ? w * 0.55 : r.range(2.6, 3.9));
  const mat = 'signageDecal';
  /* signQuad is authored in XY; -90° about X lays it flat with +Y -> +Z */
  addSign(a, mat, signQuad(w, len, c.uv), xf(0, 0.006, 0, -Math.PI / 2, 0, 0), { grime: 0.6 });
  return { colliders: [], height: 0.02, radius: Math.max(w, len) * 0.55, flat: true };
}

/** Rolling shutter over a shop front: slats, guide rails, a padlocked hasp. */
export function shopShutter(a, r, o = {}) {
  const w = o.w ?? r.range(1.9, 2.8);
  const h = o.h ?? r.range(2.0, 2.4);
  const closed = o.closed ?? r.range(0.55, 1.0);
  const drop = h * closed;
  const mat = r.pick(['galv', 'plasticBlue', 'signRed']);
  /* head box */
  a.add('galv', chamferBox(w + 0.14, 0.22, 0.16, 0.012), xf(0, h + 0.1, 0.06), { grime: 1.15 });
  /* guide rails */
  for (const s of [-1, 1]) {
    a.add('galv', chamferBox(0.07, h, 0.09, 0.008), xf((s * (w + 0.07)) / 2, h / 2, 0.045), { grimeHeight: 0.4 });
  }
  /* slats — each one a shallow chamfered bar, so the curtain has a real profile */
  const slatH = 0.075;
  const n = Math.floor(drop / slatH);
  for (let i = 0; i < n; i++) {
    const y = h - slatH * (i + 0.5);
    a.add(mat, chamferBox(w, slatH - 0.006, 0.026, 0.007), xf(0, y, 0.03 + Math.sin(i * 0.9) * 0.004), {
      grimeHeight: 0.55,
      uvOff: [0, i * 0.03],
    });
  }
  /* bottom rail + hasp */
  if (n > 0) {
    const by = h - slatH * n;
    a.add('rust', chamferBox(w + 0.02, 0.05, 0.04, 0.008), xf(0, by, 0.03), { grime: 1.3 });
    if (drop > h * 0.85) {
      a.add('rust', chamferBox(0.06, 0.09, 0.02, 0.004), xf(0, by - 0.02, 0.055), { grime: 1.3 });
      a.add('rust', torusPrim(0.028, 0.008, 10, 5), xf(0, by - 0.06, 0.06, Math.PI / 2, 0, 0), { grime: 1.4 });
    }
  }
  /* Real graffiti — a sprayed tag from the signage atlas, bowed to follow the slats
     so it does not float off the curtain. */
  if (drop > 0.5 && r.chance(0.72)) {
    const tag = pickCell(r, 'graffiti');
    const tw = Math.min(w * r.range(0.6, 0.94), 2.1);
    const th = tw / tag.aspect;
    const ty = clamp01((h - slatH * n) / Math.max(0.1, h)) * 0.2 + r.range(0.32, 0.6) * drop + (h - drop);
    addSign(a, 'signageDecal', signQuad(tw, th, tag.uv, { curve: 0.004 }),
      xf(r.jitter(w * 0.1), ty, 0.05, 0, 0, r.jitter(0.05)), { grime: 0.7 });
  }
  /* the unit number stencilled on the head box — every shuttered unit has one */
  if (r.chance(0.6)) {
    const num = pickCell(r, 'unit');
    const nw = 0.34;
    addSign(a, 'signage', signQuad(nw, nw / num.aspect, num.uv), xf(w / 2 - 0.28, h + 0.1, 0.145), { grime: 0.5 });
  }
  return { colliders: [], height: h, radius: w * 0.6 };
}

/** Cardboard box — collapsed, open-flapped or taped shut. */
export function cardboardBox(a, r, o = {}) {
  const w = o.w ?? r.range(0.28, 0.5);
  const d = o.d ?? r.range(0.24, 0.42);
  const h = o.h ?? r.range(0.2, 0.4);
  const state = o.state || r.pick(['closed', 'open', 'crushed']);
  if (state === 'crushed') {
    a.add('card', sheet(5, 5, (u, v) => [
      (u - 0.5) * w,
      0.012 + Math.sin(u * 5.2) * 0.02 + Math.sin(v * 3.7) * 0.016,
      (v - 0.5) * d,
    ]), xf(0, 0, 0, 0, r.range(0, TAU), 0), { grime: 1.5 });
    return { colliders: [], height: 0.05, radius: Math.max(w, d) * 0.6, flat: true };
  }
  const bodyH = state === 'open' ? h * 0.86 : h;
  const t = 0.006;
  for (const [ax, sgn] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
    const p = ax === 0 ? [(sgn * w) / 2, bodyH / 2, 0] : [0, bodyH / 2, (sgn * d) / 2];
    a.add('card', chamferBox(ax === 0 ? t : w, bodyH, ax === 0 ? d : t, 0.004), xf(p[0], p[1], p[2]), { grimeHeight: 0.2 });
  }
  a.add('card', chamferBox(w - 0.01, t, d - 0.01, 0.003), xf(0, t / 2, 0), { grimeHeight: 0.2 });
  if (state === 'open') {
    /* four flaps splayed at different angles */
    for (const [ax, sgn] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
      const open = r.range(0.6, 1.5);
      const fl = ax === 0 ? d : w;
      const fw = (ax === 0 ? d : w) * 0.5;
      const p = ax === 0
        ? [((sgn * w) / 2) * Math.cos(open) + ((sgn * fw) / 2) * Math.cos(open), bodyH + (fw / 2) * Math.sin(open), 0]
        : [0, bodyH + (fw / 2) * Math.sin(open), ((sgn * d) / 2) * Math.cos(open) + ((sgn * fw) / 2) * Math.cos(open)];
      a.add('card', chamferBox(ax === 0 ? fw : w - 0.01, t, ax === 0 ? d - 0.01 : fw, 0.003),
        xf(p[0], p[1], p[2], ax === 2 ? -sgn * open : 0, 0, ax === 0 ? sgn * open : 0), { grime: 1.0 });
    }
  } else {
    a.add('card', chamferBox(w - 0.008, t, d - 0.008, 0.003), xf(0, bodyH - t / 2, 0), { grimeHeight: 0.2 });
    /* packing tape down the seam */
    a.add('signWhite', chamferBox(0.05, 0.004, d, 0.002), xf(r.jitter(w * 0.1), bodyH + 0.003, 0), { grime: 0.6 });
  }
  return {
    colliders: [{ type: 'box', halfExtents: [w / 2, bodyH / 2, d / 2], pos: [0, bodyH / 2, 0], surface: 'wood', material: 'wood_ply' }],
    height: h,
    radius: Math.max(w, d) * 0.62,
    mass: 3,
  };
}

/**
 * Litter cluster: paper, cans, a bottle, a rag. No colliders — small debris that a
 * player would kick through, and 40 colliders of newspaper is a waste of the solver.
 */
export function litter(a, r, o = {}) {
  const n = o.count ?? 5 + r.int(8);
  const spread = o.spread ?? 0.9;
  for (let i = 0; i < n; i++) {
    const px = r.gauss() * spread;
    const pz = r.gauss() * spread;
    const kind = r.next();
    if (kind < 0.34) {
      /* crumpled paper / flyer */
      a.add('card', sheet(4, 4, (u, v) => [
        (u - 0.5) * 0.16,
        0.004 + Math.sin(u * 7 + i) * 0.014 + Math.sin(v * 5 + i * 2) * 0.012,
        (v - 0.5) * 0.13,
      ]), xf(px, 0, pz, 0, r.range(0, TAU), 0), { grime: 1.3 });
    } else if (kind < 0.58) {
      /* drinks can, usually crushed */
      const crushed = r.chance(0.6);
      a.add('alu', cyl(0.033, crushed ? 0.055 : 0.115, 9, { chamfer: 0.006 }),
        xf(px, crushed ? 0.028 : 0.033, pz, crushed ? r.range(1.2, 1.6) : Math.PI / 2, r.range(0, TAU), 0), { grime: 1.2 });
    } else if (kind < 0.74) {
      /* plastic bottle on its side */
      a.add('glass', revolve([[0, 0], [0.032, 0], [0.034, 0.02], [0.034, 0.13], [0.02, 0.16], [0.014, 0.19], [0.016, 0.21], [0, 0.21]], 9),
        xf(px, 0.034, pz, Math.PI / 2, r.range(0, TAU), 0), { grime: 0.9 });
    } else if (kind < 0.88) {
      /* a rag / plastic sheet caught on the ground */
      a.add('tarp', sheet(4, 4, (u, v) => [
        (u - 0.5) * r.range(0.2, 0.45),
        0.006 + Math.sin(u * 4.3 + i) * 0.02,
        (v - 0.5) * r.range(0.18, 0.4),
      ]), xf(px, 0, pz, 0, r.range(0, TAU), 0), { grime: 1.4, flap: 0.5 });
    } else {
      /* broken masonry chunk */
      const s = r.range(0.04, 0.11);
      a.add('concrete', blob(s * 1.6, s, s * 1.3, 6, (dx, dy, dz) => 0.75 + 0.35 * Math.sin(dx * 5 + dz * 4 + dy * 6)),
        xf(px, s * 0.4, pz, r.range(0, 1), r.range(0, TAU), r.range(0, 1)), { grime: 1.4 });
    }
  }
  return { colliders: [], height: 0.12, radius: spread * 1.6, flat: true };
}

/** A drift of rubble against a wall — the thing that makes a corner look bombed. */
export function rubblePile(a, r, o = {}) {
  const len = o.length ?? r.range(1.6, 3.2);
  const depth = o.depth ?? r.range(0.5, 0.9);
  const hgt = o.h ?? r.range(0.25, 0.55);
  const n = o.count ?? 16 + r.int(14);
  for (let i = 0; i < n; i++) {
    const t = r.next();
    const px = (r.next() - 0.5) * len;
    const pz = Math.pow(r.next(), 1.6) * depth;
    const fall = clamp01(1 - pz / depth);
    const s = r.range(0.05, 0.2) * (0.6 + fall * 0.7);
    const y = fall * hgt * r.range(0.15, 1.0);
    const mat = t < 0.7 ? 'concrete' : t < 0.88 ? 'paving' : 'wood';
    if (mat === 'wood') {
      a.add('wood', chamferBox(r.range(0.2, 0.7), 0.035, r.range(0.06, 0.12), 0.006),
        xf(px, y + 0.02, pz, r.jitter(0.4), r.range(0, TAU), r.jitter(0.5)), { grime: 1.5 });
    } else {
      a.add(mat, blob(s * 1.7, s, s * 1.4, 6, (dx, dy, dz) => 0.72 + 0.36 * Math.sin(dx * 4.7 + dz * 3.9 + dy * 5.4 + i)),
        xf(px, y + s * 0.4, pz, r.range(0, 1), r.range(0, TAU), r.range(0, 1)), { grime: 1.45, uvOff: [r.range(0, 3), r.range(0, 3)] });
    }
  }
  /* two lengths of exposed rebar */
  for (let i = 0; i < 2; i++) {
    const pts = [];
    const bx = r.jitter(len * 0.35);
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      pts.push([bx + Math.sin(t * 3 + i) * 0.1, hgt * 0.5 + Math.sin(t * 2.2) * 0.14, t * depth * 0.8]);
    }
    a.add('rust', tube(pts, 0.009, 5, { cap: false }), null, { grime: 1.6 });
  }
  return {
    colliders: [{ type: 'box', halfExtents: [len / 2, hgt * 0.4, depth / 2], pos: [0, hgt * 0.4, depth / 2], surface: 'concrete', material: 'rubble' }],
    height: hgt,
    radius: Math.max(len, depth) * 0.6,
  };
}

/** Tarp draped over something lumpy, roped down at the corners. */
export function tarpCover(a, r, o = {}) {
  const w = o.w ?? r.range(1.4, 2.4);
  const d = o.d ?? r.range(1.0, 1.8);
  const h = o.h ?? r.range(0.6, 1.1);
  const phase = r.range(0, TAU);
  a.add('tarp', sheet(9, 8, (u, v) => {
    const cu = (u - 0.5) * 2;
    const cv = (v - 0.5) * 2;
    const dome = Math.max(0, 1 - (cu * cu * 0.85 + cv * cv * 0.9));
    const lump = 0.12 * Math.sin(u * 5.1 + phase) * Math.sin(v * 4.2 + phase * 1.4) * dome;
    return [cu * w * 0.5, h * Math.pow(dome, 0.65) + lump, cv * d * 0.5];
  }), null, {
    grimeHeight: 0.5,
    uvOff: [r.range(0, 2), r.range(0, 2)],
    flap: (wx, wy, wz, lx, ly) => clamp01(1 - ly / Math.max(0.05, h)) * 0.35,
  });
  /* tie-down ropes at the corners */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      a.add('canvas', tube(
        [[sx * w * 0.44, h * 0.22, sz * d * 0.44], [sx * (w * 0.5 + 0.16), 0.02, sz * (d * 0.5 + 0.14)]],
        0.008, 4, { cap: false }
      ), null, { grime: 1.3 });
      a.add('rust', chamferBox(0.05, 0.03, 0.05, 0.006), xf(sx * (w * 0.5 + 0.18), 0.015, sz * (d * 0.5 + 0.16)), { grime: 1.6 });
    }
  }
  return {
    colliders: [{ type: 'box', halfExtents: [w * 0.45, h / 2, d * 0.45], pos: [0, h / 2, 0], surface: 'fabric' }],
    height: h,
    radius: Math.max(w, d) * 0.6,
  };
}

/** Gas cylinder — the blue/red bottle on every roof and behind every kitchen. */
export function gasCylinder(a, r, o = {}) {
  const R = 0.16;
  const H = r.range(0.56, 0.72);
  const mat = o.mat || r.pick(['plasticBlue', 'signRed', 'olive']);
  a.add(mat, revolve(
    [
      [0, 0], [R - 0.02, 0], [R, 0.03], [R, H - 0.14], [R * 0.86, H - 0.05],
      [R * 0.5, H], [R * 0.28, H + 0.01], [R * 0.28, H + 0.06], [0, H + 0.06],
    ],
    14
  ), xf(0, 0, 0, 0, r.range(0, TAU), 0), { grimeHeight: 0.35, uvOff: [r.range(0, 2), r.range(0, 2)] });
  /* foot ring and the valve guard */
  a.add('rust', revolve([[R - 0.03, 0], [R, 0], [R, 0.055], [R - 0.03, 0.055]], 14), null, { grime: 1.4 });
  a.add('rust', revolve([[R * 0.3, H + 0.06], [R * 0.34, H + 0.07], [R * 0.34, H + 0.14], [R * 0.3, H + 0.15]], 12), null, { grime: 1.2 });
  a.add('rust', cyl(0.022, 0.07, 8, { chamfer: 0.004 }), xf(0, H + 0.1, 0), { grime: 1.2 });
  return {
    colliders: [{ type: 'box', halfExtents: [R, (H + 0.15) / 2, R], pos: [0, (H + 0.15) / 2, 0], surface: 'metal' }],
    height: H + 0.15,
    radius: R * 1.1,
    mass: 26,
  };
}

export default {
  marketStall,
  produceCrate,
  plasticChair,
  cafeTable,
  laundryLine,
  satelliteDish,
  waterTank,
  tvAerial,
  chimneyFlue,
  dishFarm,
  shopSign,
  shopShutter,
  wallMark,
  roadMark,
  cardboardBox,
  litter,
  rubblePile,
  tarpCover,
  gasCylinder,
};
