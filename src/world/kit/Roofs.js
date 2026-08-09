/**
 * kit/Roofs.js — roof decks, parapets with coping, balconies, awnings and canopies.
 * Owner: level agent.
 *
 * The roofline is where a building silhouette is won or lost. Everything here exists
 * to stop a roof from being a flat rectangle sitting on a box:
 *   • parapets are separate walls with **coping stones** laid as individual pieces with
 *     open joints, so the top edge has a rhythm and a drip shadow;
 *   • the deck itself is slightly dished toward a scupper so water reads as if it goes
 *     somewhere;
 *   • balconies have real slab thickness, a nosing, underside brackets and railings;
 *   • awnings are fabric with a sagging valance and a visible steel frame.
 */
import * as THREE from 'three';
import { hash2, hash3, lerp, clamp01 } from './geom.js';
import { railing } from './Stairs.js';

const _up = new THREE.Vector3(0, 1, 0);

/**
 * Flat roof deck over a rectangular footprint, with a shallow fall to one corner.
 * @param {object} r  {x0,z0,x1,z1}
 */
export function roofDeck(bat, r, y, opts = {}) {
  const mat = opts.mat || 'struct.concrete';
  const inset = opts.inset ?? 0;
  const x0 = r.x0 + inset;
  const x1 = r.x1 - inset;
  const z0 = r.z0 + inset;
  const z1 = r.z1 - inset;
  const th = opts.thick ?? 0.28;
  const fall = opts.fall ?? 0.07;
  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;

  bat.upTo(mat, 0, (mb) => {
    const bot = [
      [x0, y - th, z0],
      [x1, y - th, z0],
      [x1, y - th, z1],
      [x0, y - th, z1],
    ];
    // Dished: the low corner is the one nearest the scupper.
    const top = [
      [x0, y, z0],
      [x1, y - fall, z0],
      [x1, y - fall * 0.5, z1],
      [x0, y - fall * 0.4, z1],
    ];
    mb.prism(bot, top);
  });
  bat.box(cx, y - th * 0.5, cz, (x1 - x0) * 0.5, th * 0.5, (z1 - z0) * 0.5, opts.surface || bat.palette.surface(mat));
  return { x0, x1, z0, z1, y };
}

/**
 * Parapet wall around a roof with individually laid coping stones.
 * @param {object} r  {x0,z0,x1,z1} outer edge of the building
 */
export function parapet(bat, r, y, height, opts = {}) {
  const mat = opts.mat || 'struct.concrete';
  const copeMat = opts.copeMat || 'struct.concreteClean';
  const t = opts.thick ?? 0.24;
  const surf = opts.surface || bat.palette.surface(mat);
  const sides = [
    [r.x0, r.z0, r.x1, r.z0],
    [r.x1, r.z0, r.x1, r.z1],
    [r.x1, r.z1, r.x0, r.z1],
    [r.x0, r.z1, r.x0, r.z0],
  ];
  const gaps = opts.gaps || [];

  for (let si = 0; si < 4; si++) {
    const [ax, az, bx, bz] = sides[si];
    const dx = bx - ax;
    const dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.3) continue;
    const ux = dx / L;
    const uz = dz / L;
    // Inward normal so the wall sits inside the footprint.
    const nx = uz;
    const nz = -ux;
    const cxo = ax + ux * L * 0.5 + nx * t * 0.5;
    const czo = az + uz * L * 0.5 + nz * t * 0.5;
    const yaw = Math.atan2(-uz, ux);

    // Skip ranges (roof access hatches, where a stair lands).
    const spans = [[0, L]];
    for (const g of gaps) {
      if (g.side !== si) continue;
      for (let i = spans.length - 1; i >= 0; i--) {
        const [s0, s1] = spans[i];
        const a = Math.max(s0, g.u0);
        const b = Math.min(s1, g.u1);
        if (a >= b) continue;
        spans.splice(i, 1, ...[[s0, a], [b, s1]].filter((s) => s[1] - s[0] > 0.15));
      }
    }

    for (const [s0, s1] of spans) {
      const sl = s1 - s0;
      const mx = ax + ux * (s0 + sl * 0.5) + nx * t * 0.5;
      const mz = az + uz * (s0 + sl * 0.5) + nz * t * 0.5;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(mx, y, mz),
        new THREE.Quaternion().setFromAxisAngle(_up, yaw),
        new THREE.Vector3(1, 1, 1)
      );
      bat.push(m);
      bat.upTo(mat, 0, (mb) => {
        mb.box([0, height * 0.5, 0], [sl * 0.5, height * 0.5, t * 0.5], { chamfer: 0.02 });
      });
      // Coping stones, laid individually with a 16 mm open joint.
      const stone = opts.stone ?? 0.78;
      const nStones = Math.max(1, Math.round(sl / stone));
      const sw = sl / nStones;
      // The overhang the coping needs at a corner so the two runs mitre into each
      // other instead of both stopping 8 mm short and leaving a notch in the skyline.
      const over = t * 0.5 + 0.055;
      const runsToStart = s0 <= 0.001;
      const runsToEnd = s1 >= L - 0.001;
      bat.upTo(copeMat, 0, (mb) => {
        for (let i = 0; i < nStones; i++) {
          let a = -sl * 0.5 + sw * i + 0.008;
          let b = -sl * 0.5 + sw * (i + 1) - 0.008;
          if (i === 0 && runsToStart) a -= over + 0.008;
          if (i === nStones - 1 && runsToEnd) b += over + 0.008;
          const h4 = hash3(Math.round(mx * 4), Math.round(mz * 4), i);
          /* One stone in twelve has gone: a notch in the coping line, and the wall
             top showing through it. A dead-level run of coping from corner to corner
             is the single reason every roofline in the build read as a ruler. */
          if (h4 > 0.92 && i > 0 && i < nStones - 1) continue;
          // a stone settled out of course, and a run of them that never sits level
          const jitter = (h4 - 0.5) * 0.012 - (h4 > 0.84 ? 0.03 : 0);
          mb.box([(a + b) * 0.5, height + 0.055 + jitter, 0], [(b - a) * 0.5, 0.055, over], { chamfer: 0.016 });
        }
      });
      /**
       * Parapet piers. A Levantine parapet is not a continuous band — it is piers
       * every few metres with panels between them, and the piers stand proud of the
       * coping. Two boxes each, and it is what turns a flat top edge into a rhythm
       * the eye can read at 60 m.
       */
      if (opts.piers !== false && bat.lod === 0 && sl > 2.6) {
        const pierGap = opts.pierGap ?? 4.6;
        const nP = Math.max(1, Math.round(sl / pierGap));
        bat.upTo(mat, 0, (mb) => {
          for (let i = 0; i <= nP; i++) {
            const u = -sl * 0.5 + (sl * i) / nP;
            if (i > 0 && i < nP && Math.abs(u) > sl * 0.5 - 0.3) continue;
            const hp = hash3(Math.round(mx * 4) + 17, Math.round(mz * 4) + 7, i);
            const rise = 0.2 + hp * 0.26;
            mb.box([u, height * 0.5 + rise * 0.5, 0], [0.19, (height + rise) * 0.5, t * 0.62], { chamfer: 0.02 });
          }
        });
        bat.upTo(copeMat, 0, (mb) => {
          for (let i = 0; i <= nP; i++) {
            const u = -sl * 0.5 + (sl * i) / nP;
            if (i > 0 && i < nP && Math.abs(u) > sl * 0.5 - 0.3) continue;
            const hp = hash3(Math.round(mx * 4) + 17, Math.round(mz * 4) + 7, i);
            const rise = 0.2 + hp * 0.26;
            mb.box([u, height + rise + 0.05, 0], [0.24, 0.05, over + 0.02], { chamfer: 0.014 });
          }
        });
      }
      bat.pop();
      bat.boxYaw(mx, y + (height + 0.11) * 0.5, mz, sl * 0.5, (height + 0.11) * 0.5, t * 0.5 + 0.05, yaw, surf);
    }
  }
}

/** Pitched roof over a rectangular plan, ridge running along the longer axis. */
export function pitchedRoof(bat, r, eaveY, pitch, opts = {}) {
  const mat = opts.mat || 'roof.shingle';
  const over = opts.overhang ?? 0.42;
  const x0 = r.x0 - over;
  const x1 = r.x1 + over;
  const z0 = r.z0 - over;
  const z1 = r.z1 + over;
  const alongX = x1 - x0 >= z1 - z0;
  const halfSpan = (alongX ? z1 - z0 : x1 - x0) * 0.5;
  const ridgeY = eaveY + halfSpan * Math.tan(pitch);
  const th = 0.16;

  bat.upTo(mat, 0, (mb) => {
    if (alongX) {
      const zc = (z0 + z1) * 0.5;
      for (const s of [-1, 1]) {
        const ez = s < 0 ? z0 : z1;
        mb.prism(
          [
            [x0, eaveY - th, ez],
            [x1, eaveY - th, ez],
            [x1, ridgeY - th, zc],
            [x0, ridgeY - th, zc],
          ],
          [
            [x0, eaveY, ez],
            [x1, eaveY, ez],
            [x1, ridgeY, zc],
            [x0, ridgeY, zc],
          ]
        );
      }
    } else {
      const xc = (x0 + x1) * 0.5;
      for (const s of [-1, 1]) {
        const ex = s < 0 ? x0 : x1;
        mb.prism(
          [
            [ex, eaveY - th, z0],
            [ex, eaveY - th, z1],
            [xc, ridgeY - th, z1],
            [xc, ridgeY - th, z0],
          ],
          [
            [ex, eaveY, z0],
            [ex, eaveY, z1],
            [xc, ridgeY, z1],
            [xc, ridgeY, z0],
          ]
        );
      }
    }
  });
  // Ridge cap.
  bat.upTo(opts.ridgeMat || 'struct.concreteClean', 0, (mb) => {
    if (alongX) mb.box([(x0 + x1) * 0.5, ridgeY + 0.045, (z0 + z1) * 0.5], [(x1 - x0) * 0.5, 0.05, 0.11], { chamfer: 0.02 });
    else mb.box([(x0 + x1) * 0.5, ridgeY + 0.045, (z0 + z1) * 0.5], [0.11, 0.05, (z1 - z0) * 0.5], { chamfer: 0.02 });
  });
  bat.box(
    (x0 + x1) * 0.5,
    (eaveY + ridgeY) * 0.5,
    (z0 + z1) * 0.5,
    (x1 - x0) * 0.5,
    (ridgeY - eaveY) * 0.5,
    (z1 - z0) * 0.5,
    opts.surface || 'concrete'
  );
  return ridgeY;
}

/** Projecting balcony: slab with nosing, brackets underneath, railing on three sides. */
export function balcony(bat, o) {
  const { x, z, y } = o;
  const yaw = o.yaw || 0;
  const w = o.width ?? 2.6;
  const d = o.depth ?? 1.15;
  const th = o.thick ?? 0.19;
  const mat = o.mat || 'struct.concreteClean';
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo(mat, 0, (mb) => {
    mb.box([0, -th * 0.5, d * 0.5], [w * 0.5, th * 0.5, d * 0.5], { chamfer: 0.018 });
    // Nosing band along the front edge.
    mb.box([0, -th - 0.035, d - 0.02], [w * 0.5 + 0.02, 0.035, 0.055], { chamfer: 0.012 });
  });
  bat.upTo(o.bracketMat || 'metal.rust', 0, (mb) => {
    for (const s of [-1, 0.0, 1]) {
      const bx = s * (w * 0.5 - 0.18);
      mb.prism(
        [
          [bx - 0.035, -th, 0.02],
          [bx + 0.035, -th, 0.02],
          [bx + 0.035, -th, d * 0.85],
          [bx - 0.035, -th, d * 0.85],
        ],
        [
          [bx - 0.035, -th - 0.5, 0.02],
          [bx + 0.035, -th - 0.5, 0.02],
          [bx + 0.035, -th - 0.06, d * 0.85],
          [bx - 0.035, -th - 0.06, d * 0.85],
        ]
      );
    }
  });
  bat.pop();

  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const toW = (lx, lz) => [x + lx * cs + lz * sn, z - lx * sn + lz * cs];
  const [fx0, fz0] = toW(-w * 0.5, d);
  const [fx1, fz1] = toW(w * 0.5, d);
  const [sx0, sz0] = toW(-w * 0.5, 0.02);
  const [sx1, sz1] = toW(w * 0.5, 0.02);
  const rh = o.railHeight ?? 1.02;
  const rmat = o.railMat || 'metal.rust';
  railing(bat, fx0, fz0, fx1, fz1, y, { height: rh, mat: rmat, style: o.railStyle });
  railing(bat, sx0, sz0, fx0, fz0, y, { height: rh, mat: rmat, style: o.railStyle });
  railing(bat, fx1, fz1, sx1, sz1, y, { height: rh, mat: rmat, style: o.railStyle });

  const [ccx, ccz] = toW(0, d * 0.5);
  bat.boxYaw(ccx, y - th * 0.5, ccz, w * 0.5, th * 0.5 + 0.02, d * 0.5, yaw, 'concrete');
}

/** Shopfront awning: steel frame, sloped fabric, sagging valance. */
export function awning(bat, o) {
  const { x, y, z } = o;
  const yaw = o.yaw || 0;
  const w = o.width ?? 2.8;
  const d = o.depth ?? 1.35;
  const drop = o.drop ?? 0.42;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo(o.frameMat || 'metal.rust', 0, (mb) => {
    for (const s of [-1, 1]) {
      const bx = s * (w * 0.5 - 0.08);
      mb.cylinder([bx, 0, 0], [bx, -drop, d], 0.022, 6);
      mb.cylinder([bx, 0, 0], [bx, -drop * 0.55, d * 0.52], 0.018, 6);
      mb.cylinder([bx, -drop * 0.72, d * 0.72], [bx, 0.02, d * 0.06], 0.014, 6);
    }
    mb.cylinder([-w * 0.5, -drop, d], [w * 0.5, -drop, d], 0.02, 6);
  });
  bat.upTo(o.mat || 'fabric.awning', 0, (mb) => {
    const n = 7;
    /**
     * Real thickness, not a single quad. A sheet that terminates in a one-pixel edge is
     * the most common "cardboard cut-out" tell in the whole kit — canvas is 3 mm and it
     * always shows a lit edge and a shadow line where it turns down over the front bar.
     * Built as prisms so the top surface, the soffit and the edge are all real faces.
     */
    const th = 0.028;
    const sl = Math.hypot(d, drop) || 1;
    const uy = d / sl;
    const uz = drop / sl;
    for (let i = 0; i < n; i++) {
      const u0 = lerp(-w * 0.5, w * 0.5, i / n);
      const u1 = lerp(-w * 0.5, w * 0.5, (i + 1) / n);
      const sag0 = Math.sin((i / n) * Math.PI) * 0.05;
      const sag1 = Math.sin(((i + 1) / n) * Math.PI) * 0.05;
      // bottom (soffit) quad, offset back along the sheet normal
      mb.prism(
        [
          [u0, -th * uy, -th * uz],
          [u1, -th * uy, -th * uz],
          [u1, -drop - sag1 - th * uy, d - th * uz],
          [u0, -drop - sag0 - th * uy, d - th * uz],
        ],
        [
          [u0, 0, 0],
          [u1, 0, 0],
          [u1, -drop - sag1, d],
          [u0, -drop - sag0, d],
        ]
      );
    }
    // Valance hanging off the front bar, also a solid so it has a lit edge.
    for (let i = 0; i < n; i++) {
      const u0 = lerp(-w * 0.5, w * 0.5, i / n);
      const u1 = lerp(-w * 0.5, w * 0.5, (i + 1) / n);
      const s0 = 0.2 + Math.sin((i / n) * Math.PI * 3.1) * 0.045;
      const s1 = 0.2 + Math.sin(((i + 1) / n) * Math.PI * 3.1) * 0.045;
      mb.prism(
        [
          [u0, -drop - s0, d + 0.01 - th],
          [u1, -drop - s1, d + 0.01 - th],
          [u1, -drop - s1, d + 0.01],
          [u0, -drop - s0, d + 0.01],
        ],
        [
          [u0, -drop, d - th],
          [u1, -drop, d - th],
          [u1, -drop, d],
          [u0, -drop, d],
        ]
      );
    }
  });
  bat.pop();
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  bat.occluder({
    type: 'box',
    pos: { x: x + d * 0.5 * sn, y: y - drop * 0.5, z: z + d * 0.5 * cs },
    halfExtents: { x: Math.abs(cs) * w * 0.5 + Math.abs(sn) * d * 0.5, y: 0.06, z: Math.abs(sn) * w * 0.5 + Math.abs(cs) * d * 0.5 },
  });
}

/** Big steel canopy on columns — fuel station, loading bay. Reachable roof. */
export function canopy(bat, o) {
  const { x0, z0, x1, z1, y } = o;
  const th = o.thick ?? 0.55;
  const mat = o.mat || 'metal.paintCream';
  const fascia = o.fasciaMat || 'metal.paintRed';
  bat.upTo(mat, 0, (mb) => {
    mb.box([(x0 + x1) * 0.5, y - th * 0.5, (z0 + z1) * 0.5], [(x1 - x0) * 0.5, th * 0.5 - 0.09, (z1 - z0) * 0.5], {
      chamfer: 0.03,
    });
    // Deck on top with a raised lip — the canopy is a real vantage point.
    mb.box([(x0 + x1) * 0.5, y + 0.03, (z0 + z1) * 0.5], [(x1 - x0) * 0.5 + 0.05, 0.05, (z1 - z0) * 0.5 + 0.05], {
      chamfer: 0.02,
    });
  });
  bat.upTo(fascia, 0, (mb) => {
    const h = 0.16;
    for (const s of [-1, 1]) {
      mb.box([(x0 + x1) * 0.5, y - th + h, s < 0 ? z0 - 0.03 : z1 + 0.03], [(x1 - x0) * 0.5 + 0.06, h, 0.06], {
        chamfer: 0.015,
      });
      mb.box([s < 0 ? x0 - 0.03 : x1 + 0.03, y - th + h, (z0 + z1) * 0.5], [0.06, h, (z1 - z0) * 0.5 + 0.06], {
        chamfer: 0.015,
      });
    }
  });
  const cols = o.columns || [
    [x0 + 1.2, z0 + 1.2],
    [x1 - 1.2, z0 + 1.2],
    [x0 + 1.2, z1 - 1.2],
    [x1 - 1.2, z1 - 1.2],
  ];
  for (const [cx, cz] of cols) {
    bat.upTo(mat, 0, (mb) => {
      mb.box([cx, (o.baseY ?? 0) + (y - th - (o.baseY ?? 0)) * 0.5, cz], [0.22, (y - th - (o.baseY ?? 0)) * 0.5, 0.22], {
        chamfer: 0.025,
      });
      mb.box([cx, (o.baseY ?? 0) + 0.12, cz], [0.34, 0.12, 0.34], { chamfer: 0.02 });
    });
    bat.box(cx, (o.baseY ?? 0) + (y - th) * 0.5, cz, 0.26, (y - th - (o.baseY ?? 0)) * 0.5, 0.26, 'metal');
  }
  // The collider has to reach the *visible* deck (y + 0.08), not the slab soffit, or
  // the player stands 8 cm inside the surface they can see.
  bat.box(
    (x0 + x1) * 0.5,
    y - th * 0.5 + 0.04,
    (z0 + z1) * 0.5,
    (x1 - x0) * 0.5 + 0.05,
    th * 0.5 + 0.04,
    (z1 - z0) * 0.5 + 0.05,
    'metal'
  );
}

/**
 * Roof clutter: AC condensers, vents, water tanks, aerials and satellite dishes.
 *
 * The default used to be four items per roof with an 18 % chance of the water tank —
 * the only element tall enough to break the parapet line — so five roofs shared about
 * three visible boxes and the skyline was a row of empty grey trays. The count is now
 * scaled to the roof's own area and the tall variants are biased up hard, because at
 * 60-120 m the *only* thing a roof contributes to a frame is its silhouette.
 */
export function roofClutter(bat, r, y, rng, opts = {}) {
  const area = Math.max(1, (r.x1 - r.x0) * (r.z1 - r.z0));
  const base = opts.count ?? 4;
  const n = opts.exact ?? Math.max(6, Math.min(12, Math.round(base * 2 + area / 34)));
  for (let i = 0; i < n; i++) {
    const fx = 0.16 + rng() * 0.68;
    const fz = 0.16 + rng() * 0.68;
    const x = lerp(r.x0, r.x1, fx);
    const z = lerp(r.z0, r.z1, fz);
    // Tall first: tanks and aerials get 45 % of the roll between them, and the low
    // condenser boxes take what is left.
    const kind = rng();
    if (kind < 0.24) {
      // Water tank on legs — the one element that reads above a parapet.
      bat.upTo('metal.galv', 0, (mb) => {
        const tr = 0.5 + rng() * 0.24;
        const th = 1.0 + rng() * 0.7;
        for (const sx of [-1, 1])
          for (const sz of [-1, 1])
            mb.cylinder([x + sx * tr * 0.72, y, z + sz * tr * 0.72], [x + sx * tr * 0.72, y + 0.78, z + sz * tr * 0.72], 0.038, 6);
        mb.cylinder([x, y + 0.78, z], [x, y + 0.78 + th, z], tr, 14);
        mb.cylinder([x, y + 0.78 + th, z], [x, y + 0.86 + th, z], tr * 0.9, 14);
        mb.cylinder([x + tr * 0.3, y + 0.86 + th, z], [x + tr * 0.3, y + 0.92 + th, z], 0.12, 8);
      });
      bat.box(x, y + 1.3, z, 0.6, 0.9, 0.6, 'metal');
      continue;
    }
    if (kind < 0.36) {
      // TV aerial / dish mast: pure silhouette, almost no triangles.
      bat.upTo('metal.rust', 0, (mb) => {
        const mh = 1.6 + rng() * 1.5;
        mb.cylinder([x, y, z], [x, y + mh, z], 0.026, 6);
        mb.box([x, y + 0.06, z], [0.13, 0.06, 0.13], { chamfer: 0.02 });
        const nEl = 4 + Math.floor(rng() * 4);
        for (let k = 0; k < nEl; k++) {
          const yy = y + mh * (0.45 + (0.5 * k) / nEl);
          const ew = 0.5 - (0.32 * k) / nEl;
          mb.cylinder([x - ew, yy, z], [x + ew, yy, z], 0.011, 4);
        }
        mb.cylinder([x, y + mh * 0.44, z], [x, y + mh * 0.44, z + 0.02], 0.03, 6);
        // guy wire down to the deck, which is what stops a mast looking pasted on
        mb.cylinder([x + 0.01, y + mh * 0.9, z], [x + 0.8, y + 0.04, z + 0.5], 0.007, 4);
      });
      continue;
    }
    if (kind < 0.45) {
      // Stair / lift head housing: a hard rectangular mass against the sky.
      bat.upTo(opts.mat || 'struct.concrete', 0, (mb) => {
        const hw = 0.7 + rng() * 0.38;
        const hh = 1.5 + rng() * 0.8;
        mb.box([x, y + hh * 0.5, z], [hw, hh * 0.5, hw * 0.8], { chamfer: 0.03 });
        mb.box([x, y + hh + 0.07, z], [hw + 0.09, 0.07, hw * 0.8 + 0.09], { chamfer: 0.02 });
      });
      bat.box(x, y + 1.2, z, 1.0, 1.2, 0.85, 'concrete');
      continue;
    }
    if (kind < 0.62) {
      // Condenser unit on a plinth.
      bat.upTo('metal.galv', 0, (mb) => {
        mb.box([x, y + 0.06, z], [0.52, 0.06, 0.42], { chamfer: 0.012 });
        mb.box([x, y + 0.44, z], [0.46, 0.32, 0.36], { chamfer: 0.02 });
        mb.cylinder([x, y + 0.76, z], [x, y + 0.8, z], 0.28, 12);
      });
      bat.box(x, y + 0.4, z, 0.5, 0.4, 0.4, 'metal');
    } else if (kind < 0.7) {
      bat.upTo('metal.rust', 0, (mb) => {
        mb.cylinder([x, y, z], [x, y + 0.62, z], 0.19, 10);
        mb.cylinder([x, y + 0.62, z], [x, y + 0.72, z], 0.25, 10);
      });
      bat.box(x, y + 0.35, z, 0.2, 0.35, 0.2, 'metal');
    } else if (kind < 0.88) {
      // Water tank on legs.
      bat.upTo('metal.galv', 0, (mb) => {
        for (const sx of [-1, 1])
          for (const sz of [-1, 1]) mb.cylinder([x + sx * 0.42, y, z + sz * 0.42], [x + sx * 0.42, y + 0.75, z + sz * 0.42], 0.035, 6);
        mb.cylinder([x, y + 0.75, z], [x, y + 1.72, z], 0.56, 14);
        mb.cylinder([x, y + 1.72, z], [x, y + 1.8, z], 0.5, 14);
      });
      bat.box(x, y + 1.25, z, 0.58, 0.55, 0.58, 'metal');
    } else {
      bat.upTo('metal.galv', 0, (mb) => {
        mb.cylinder([x, y, z], [x, y + 0.9, z], 0.035, 6);
        mb.cylinder([x + 0.3, y + 0.9, z], [x + 0.02, y + 0.9, z], 0.31, 12, { radius2: 0.06, caps: true });
      });
    }
  }
  void hash2;
  void clamp01;
}

export default { roofDeck, parapet, pitchedRoof, balcony, awning, canopy, roofClutter };
