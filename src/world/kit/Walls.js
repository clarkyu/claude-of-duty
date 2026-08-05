/**
 * kit/Walls.js — wall runs, openings, window frames, doors, pillars and arches.
 * Owner: level agent.
 *
 * Everything here authors in a **wall-local frame** that the caller pushes onto the
 * batcher: +X runs along the wall from its start point, +Y is up, +Z is the outward
 * face normal. Walking a footprint in order therefore produces correctly-facing walls
 * with no per-wall sign juggling.
 *
 * Non-negotiables baked into these modules:
 *   • Every wall is a **solid box of real thickness**. There is no single-plane wall
 *     anywhere, so a doorway shows a genuine reveal and a corner shows a mitre, not a
 *     zero-thickness edge.
 *   • Openings are made by *omitting mass*, not by cutting a plane: the pier / spandrel
 *     / header boxes around a window each contribute their own reveal faces.
 *   • Every exposed edge carries a 1.5–3 cm chamfer.
 *   • Facades are banded: a protruding plinth at splash-back height, the field, and a
 *     string course or cornice at the roofline — three material zones minimum.
 */
import * as THREE from 'three';
import { clamp, hash2, hash3, lerp } from './geom.js';

const CH = 0.022; // default chamfer, metres
const _v = new THREE.Vector3();

/** Wall-local frame: X along (p0->p1), Y up, Z outward. Right-handed by construction. */
export function wallFrame(x0, z0, x1, z1, y0) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 1e-5) return null;
  const ux = dx / len;
  const uz = dz / len;
  // outward = along x up  ->  (-uz, 0, ux)
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(ux, 0, uz),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(-uz, 0, ux)
  );
  m.setPosition(x0, y0, z0);
  return { matrix: m, length: len, ux, uz, nx: -uz, nz: ux };
}

/** Local (u, y, w) -> world, for collider placement while a frame is pushed. */
export function localToWorld(frame, u, y, w, out) {
  const o = out || {};
  o.x = frame.matrix.elements[12] + frame.ux * u + frame.nx * w;
  o.y = frame.matrix.elements[13] + y;
  o.z = frame.matrix.elements[14] + frame.uz * u + frame.nz * w;
  return o;
}

/**
 * The workhorse. Builds one straight run of wall with openings, banding and collision.
 *
 * @param {import('./Batcher.js').Batcher} bat
 * @param {object} o
 * @param {number} o.x0,o.z0,o.x1,o.z1  centreline in world XZ
 * @param {number} o.y0                 base height
 * @param {number} o.y1                 top height
 * @param {number} [o.thick=0.34]
 * @param {string} o.mat                outer palette key
 * @param {string} [o.inner]            inner leaf palette key (two-leaf construction)
 * @param {Array}  [o.openings]         [{u, w, h, sill, type, style}]
 * @param {object} [o.plinth]           {h, mat, out}
 * @param {object} [o.cornice]          {h, mat, out}
 * @param {boolean}[o.collide=true]
 * @param {number} [o.lodMax=2]         author the mass up to this LOD
 */
export function wallRun(bat, o) {
  const frame = wallFrame(o.x0, o.z0, o.x1, o.z1, o.y0);
  if (!frame) return null;
  const L = frame.length;
  const H = Math.max(0.05, o.y1 - o.y0);
  const t = o.thick ?? 0.34;
  const half = t * 0.5;
  const mat = o.mat || 'struct.concrete';
  const inner = o.inner || null;
  const innerT = inner ? t * 0.42 : 0;
  const outerT = inner ? t - innerT : t;
  const surface = o.surface || bat.palette.surface(mat);
  const seed = Math.round(o.x0 * 7.13 + o.z0 * 3.71);

  const openings = (o.openings || [])
    .map((op) => {
      const type = op.type || 'window';
      // A doorway with a default sill is a doorway you cannot walk through: the
      // pier code fills the space under `sill` with solid, colliding mass. Anything
      // you are meant to pass through starts at the floor unless it says otherwise.
      const grounded = type === 'door' || type === 'gate' || type === 'hole' || type === 'arch';
      return {
        u: op.u,
        w: op.w ?? 1.1,
        h: op.h ?? 1.5,
        sill: op.sill ?? (grounded ? 0 : 0.95),
        type,
        style: op.style || null,
        arch: !!op.arch,
      };
    })
    .filter((op) => op.u - op.w * 0.5 > 0.02 && op.u + op.w * 0.5 < L - 0.02)
    .sort((a, b) => a.u - b.u);

  bat.push(frame.matrix);

  const solid = (u0, u1, ya, yb, extend) => {
    const w = u1 - u0;
    if (w <= 0.004 || yb - ya <= 0.004) return;
    const cu = (u0 + u1) * 0.5;
    const cy = (ya + yb) * 0.5;
    const ex = extend ? CH * 1.6 : 0;
    bat.upTo(mat, o.lodMax ?? 0, (mb) => {
      mb.box([cu, cy, inner ? half - outerT * 0.5 : 0], [w * 0.5 + ex, (yb - ya) * 0.5, outerT * 0.5], { chamfer: CH });
    });
    if (inner) {
      bat.upTo(inner, o.lodMax ?? 0, (mb) => {
        mb.box([cu, cy, -half + innerT * 0.5], [w * 0.5 + ex, (yb - ya) * 0.5, innerT * 0.5], { chamfer: CH });
      });
    }
    if (o.collide !== false) {
      const p = localToWorld(frame, cu, o.y0 + cy, 0);
      bat.boxYaw(p.x, p.y, p.z, w * 0.5, (yb - ya) * 0.5, half, Math.atan2(-frame.uz, frame.ux), surface);
    }
  };

  // Piers between openings.
  let cursor = 0;
  for (const op of openings) {
    const a = op.u - op.w * 0.5;
    const b = op.u + op.w * 0.5;
    if (a > cursor) solid(cursor, a, 0, H, false);
    const top = Math.min(H, op.sill + op.h);
    if (op.sill > 0.02) solid(a, b, 0, op.sill, true);
    if (top < H - 0.02) solid(a, b, top, H, true);
    cursor = b;
  }
  if (cursor < L) solid(cursor, L, 0, H, false);
  if (!openings.length && L > 0) {
    /* handled above */
  }

  /* ── banding: plinth / splash-back and cornice ─────────────────────────── */
  if (o.plinth !== null) {
    const pl = o.plinth || {};
    const ph = pl.h ?? 0.86;
    const pout = pl.out ?? 0.045;
    const pmat = pl.mat || 'struct.concrete';
    if (ph > 0.05 && ph < H) {
      // The plinth is a band of *mass*, so it has to stop at every opening that
      // reaches the floor. One box the full length of the wall would put a
      // walk-through slab across the bottom of every doorway and archway.
      let spans = [[0, L]];
      for (const op of openings) {
        if (op.sill > 0.05) continue;
        const a = op.u - op.w * 0.5 - pout;
        const b = op.u + op.w * 0.5 + pout;
        const next = [];
        for (const [s0, s1] of spans) {
          if (b <= s0 || a >= s1) {
            next.push([s0, s1]);
            continue;
          }
          if (a > s0) next.push([s0, a]);
          if (b < s1) next.push([b, s1]);
        }
        spans = next;
      }
      bat.upTo(pmat, 0, (mb) => {
        for (const [s0, s1] of spans) {
          if (s1 - s0 < 0.03) continue;
          // Only the free ends of a span get the outward overhang, so the plinth
          // returns cleanly into the reveal instead of floating past it.
          const e0 = s0 <= 0.001 ? pout : 0;
          const e1 = s1 >= L - 0.001 ? pout : 0;
          mb.box([(s0 - e0 + s1 + e1) * 0.5, ph * 0.5, 0], [(s1 + e1 - s0 + e0) * 0.5, ph * 0.5, half + pout], {
            chamfer: 0.02,
          });
        }
      });
    }
  }
  if (o.cornice) {
    const cn = o.cornice;
    const ch = cn.h ?? 0.24;
    const cout = cn.out ?? 0.1;
    bat.upTo(cn.mat || 'struct.concreteClean', 0, (mb) => {
      // Slightly wedge-shaped so the underside throws a real shadow line.
      const y0 = H - ch;
      const p = (u, y, w) => [u, y, w];
      mb.prism(
        [p(0, y0, -half - cout * 0.35), p(L, y0, -half - cout * 0.35), p(L, y0, half + cout * 0.35), p(0, y0, half + cout * 0.35)],
        [p(0, H, -half - cout), p(L, H, -half - cout), p(L, H, half + cout), p(0, H, half + cout)]
      );
    });
  }

  /* ── openings: reveals, sills, lintels, frames, glass ──────────────────── */
  for (const op of openings) {
    const r = hash2(seed + Math.round(op.u * 10), Math.round(op.sill * 10));
    if (op.type === 'door' || op.type === 'gate') {
      addDoorFurniture(bat, frame, op, { t, half, r, mat: o.doorMat || (r > 0.5 ? 'wood.weathered' : 'metal.paintBlue') });
    } else if (op.type === 'arch') {
      addArchOpening(bat, frame, op, { t, half, mat: o.archMat || 'struct.concreteClean' });
    } else if (op.type === 'hole') {
      /* pure opening — the reveal from the surrounding boxes is the whole detail */
    } else {
      addWindowFurniture(bat, frame, op, {
        t,
        half,
        r,
        sillMat: o.sillMat || 'struct.concreteClean',
        frameMat: o.frameMat || (r > 0.6 ? 'wood.painted' : 'metal.paintCream'),
        glassMat: o.glassMat || 'glass.window',
        style: op.style || o.windowStyle || null,
      });
    }
  }

  bat.pop();
  return frame;
}

/* -------------------------------------------------------------------------- */

/**
 * Sill, lintel, inset frame, mullions and glazing. The sill projects and is sloped
 * with a drip edge — that projection is what makes a facade read as built rather
 * than extruded, and it is where the vertical grime streaks start.
 */
export function addWindowFurniture(bat, frame, op, cfg) {
  const { t, half, r } = cfg;
  const u = op.u;
  const w = op.w;
  const h = op.h;
  const y0 = op.sill;
  const y1 = op.sill + h;
  const proj = 0.075;

  // Sill: sloped stone, wider than the opening, with a drip return underneath.
  bat.upTo(cfg.sillMat, 0, (mb) => {
    const uw = w * 0.5 + 0.13;
    const zb = half + 0.012;
    const zf = half + proj;
    mb.prism(
      [
        [u - uw, y0 - 0.09, -half - 0.02],
        [u + uw, y0 - 0.09, -half - 0.02],
        [u + uw, y0 - 0.09, zf],
        [u - uw, y0 - 0.09, zf],
      ],
      [
        [u - uw, y0, -half - 0.02],
        [u + uw, y0, -half - 0.02],
        [u + uw, y0 - 0.028, zb + (zf - zb)],
        [u - uw, y0 - 0.028, zb + (zf - zb)],
      ]
    );
  });

  // Lintel above.
  bat.upTo(cfg.sillMat, 0, (mb) => {
    mb.box([u, y1 + 0.075, half - 0.02], [w * 0.5 + 0.15, 0.075, 0.06 + half * 0.5], { chamfer: 0.018 });
  });

  const style = cfg.style || (r < 0.12 ? 'boarded' : r < 0.22 ? 'broken' : r < 0.42 ? 'shutter' : 'glazed');
  const inset = half - 0.11;

  if (style !== 'boarded') {
    // Frame: four bars plus a cross mullion, inset into the reveal.
    const fw = 0.055;
    bat.upTo(cfg.frameMat, 0, (mb) => {
      mb.box([u, y0 + fw, inset], [w * 0.5, fw, 0.035], { chamfer: 0.008 });
      mb.box([u, y1 - fw, inset], [w * 0.5, fw, 0.035], { chamfer: 0.008 });
      mb.box([u - w * 0.5 + fw, (y0 + y1) * 0.5, inset], [fw, h * 0.5, 0.035], { chamfer: 0.008 });
      mb.box([u + w * 0.5 - fw, (y0 + y1) * 0.5, inset], [fw, h * 0.5, 0.035], { chamfer: 0.008 });
      mb.box([u, (y0 + y1) * 0.5, inset], [0.032, h * 0.5 - fw, 0.03], { chamfer: 0.006 });
      if (h > 1.2) mb.box([u, y0 + h * 0.62, inset], [w * 0.5 - fw, 0.028, 0.03], { chamfer: 0.006 });
    });
  }

  if (style === 'glazed' || style === 'shutter') {
    bat.upTo(cfg.glassMat, 0, (mb) => {
      const z = inset - 0.012;
      mb.quad(
        [u - w * 0.5 + 0.05, y0 + 0.09, z],
        [u + w * 0.5 - 0.05, y0 + 0.09, z],
        [u + w * 0.5 - 0.05, y1 - 0.09, z],
        [u - w * 0.5 + 0.05, y1 - 0.09, z],
        [0, 0, 1]
      );
    });
  } else if (style === 'broken') {
    // A few surviving shards clinging to the frame corners.
    bat.upTo(cfg.glassMat, 0, (mb) => {
      const z = inset - 0.012;
      mb.triangle([u - w * 0.5 + 0.05, y1 - 0.09, z], [u - w * 0.5 + 0.05 + w * 0.4, y1 - 0.09, z], [u - w * 0.5 + 0.09, y1 - 0.6, z], [0, 0, 1]);
      mb.triangle([u + w * 0.5 - 0.05, y0 + 0.09, z], [u + w * 0.5 - 0.05, y0 + 0.5, z], [u + w * 0.12, y0 + 0.09, z], [0, 0, 1]);
    });
  } else if (style === 'boarded') {
    bat.upTo('wood.ply', 0, (mb) => {
      const z = half - 0.06;
      for (let i = 0; i < 3; i++) {
        const yy = lerp(y0 + 0.25, y1 - 0.25, i / 2);
        const tilt = (hash3(Math.round(u * 10), i, 7) - 0.5) * 0.09;
        mb.box([u, yy, z], [w * 0.52, 0.13, 0.016], { chamfer: 0.006 });
        void tilt;
      }
    });
  }

  if (style === 'shutter') {
    const sw = w * 0.5 - 0.02;
    bat.upTo(cfg.frameMat === 'wood.painted' ? 'wood.paintedBlue' : 'wood.painted', 0, (mb) => {
      const z = half + 0.03;
      const open = 0.62 + r * 0.3;
      for (const s of [-1, 1]) {
        const cx = u + s * (w * 0.5 + sw * 0.5 * open);
        mb.box([cx, (y0 + y1) * 0.5, z], [sw * 0.5, h * 0.5 - 0.02, 0.022], { chamfer: 0.008 });
        for (let i = 0; i < 5; i++) {
          const yy = lerp(y0 + 0.16, y1 - 0.16, i / 4);
          mb.box([cx, yy, z + 0.024], [sw * 0.42, 0.024, 0.008], { chamfer: 0.004 });
        }
      }
    });
  }

  // A/C box or a laundry line bracket under one window in five — story, not symmetry.
  if (r > 0.78 && op.sill > 2.0) {
    bat.upTo('metal.galv', 0, (mb) => {
      mb.box([u + w * 0.35, y0 - 0.42, half + 0.28], [0.31, 0.24, 0.22], { chamfer: 0.015 });
      mb.box([u + w * 0.35, y0 - 0.66, half + 0.28], [0.33, 0.02, 0.24], { chamfer: 0.008 });
    });
  }
}

/** Threshold, jamb lining and a leaf that is rarely dead square. */
export function addDoorFurniture(bat, frame, op, cfg) {
  const { half, r } = cfg;
  const u = op.u;
  const w = op.w;
  const h = op.h;
  const y1 = op.sill + h;

  // Threshold stone, a touch proud of the pavement.
  bat.upTo('struct.concreteClean', 0, (mb) => {
    mb.box([u, 0.035, half - 0.02], [w * 0.5 + 0.12, 0.035, half * 0.9 + 0.09], { chamfer: 0.016 });
  });
  // Lintel.
  bat.upTo('struct.concreteClean', 0, (mb) => {
    mb.box([u, y1 + 0.085, half - 0.03], [w * 0.5 + 0.17, 0.085, half * 0.6 + 0.05], { chamfer: 0.018 });
  });

  if (op.type === 'gate') {
    // Roller shutter, rolled up far enough that what you can see matches what you can
    // walk through: there is no collider here, so a shutter drawn across head height
    // would be a lie the nav grid does not tell.
    bat.upTo('roof.corrugated', 0, (mb) => {
      const z = half - 0.09;
      const top = y1 - 0.05;
      const bot = Math.min(top - 0.05, op.sill + 2.15 + r * 0.55);
      if (top > bot + 0.06) mb.box([u, (top + bot) * 0.5, z], [w * 0.5 - 0.03, (top - bot) * 0.5, 0.03], { chamfer: 0.01 });
      mb.box([u, top + 0.14, z + 0.05], [w * 0.5 + 0.06, 0.14, 0.11], { chamfer: 0.02 });
    });
    bat.upTo('metal.rust', 0, (mb) => {
      const z = half - 0.055;
      for (const s of [-1, 1]) mb.box([u + s * (w * 0.5 - 0.02), (op.sill + y1) * 0.5, z], [0.045, h * 0.5, 0.055], { chamfer: 0.008 });
    });
    return;
  }

  // Frame lining inside the reveal.
  bat.upTo(cfg.mat === 'wood.weathered' ? 'wood.painted' : 'metal.paintGreen', 0, (mb) => {
    const z = half - 0.1;
    mb.box([u - w * 0.5 + 0.05, (op.sill + y1) * 0.5, z], [0.05, h * 0.5, 0.045], { chamfer: 0.008 });
    mb.box([u + w * 0.5 - 0.05, (op.sill + y1) * 0.5, z], [0.05, h * 0.5, 0.045], { chamfer: 0.008 });
    mb.box([u, y1 - 0.05, z], [w * 0.5, 0.05, 0.045], { chamfer: 0.008 });
  });

  // The leaf, hinged wide open — 55 to 90 degrees — so a doorway you can walk through
  // looks like one. One door in six is simply gone, which is most of the "lived in"
  // read a row of identical openings otherwise loses.
  if (r < 0.17) return;
  const swing = 0.95 + r * 0.65;
  const cs = Math.cos(swing);
  const sn = Math.sin(swing);
  const hx = u - w * 0.5 + 0.06;
  const dz = half - 0.13;
  bat.upTo(cfg.mat, 0, (mb) => {
    const lw = w - 0.12;
    const p = (a, b, y) => [hx + a * cs - b * sn, y, dz + a * sn + b * cs];
    const y0 = op.sill + 0.02;
    const yt = y1 - 0.06;
    mb.prism(
      [p(0, -0.025, y0), p(lw, -0.025, y0), p(lw, 0.025, y0), p(0, 0.025, y0)],
      [p(0, -0.025, yt), p(lw, -0.025, yt), p(lw, 0.025, yt), p(0, 0.025, yt)]
    );
  });
}

/**
 * Semicircular arched opening: voussoir ring, keystone, imposts — and, critically, the
 * **spandrel fill**. The wall around the opening is cut as a rectangle, so without the
 * fill you would see daylight through the corners either side of the arch head.
 */
export function addArchOpening(bat, frame, op, cfg) {
  const { t } = cfg;
  const u = op.u;
  const r = op.w * 0.5;
  const rOut = r + 0.26;
  const springing = op.sill + op.h - r;
  const rectTop = op.sill + op.h;
  bat.upTo(cfg.mat, 0, (mb) => {
    mb.archRing(u, springing, 0, r, rOut, t + 0.04, 'z', 14);
    // Keystone.
    mb.box([u, springing + rOut - 0.06, 0], [0.13, 0.2, t * 0.5 + 0.035], { chamfer: 0.02 });
    // Impost blocks.
    for (const s of [-1, 1]) {
      mb.box([u + s * (r + 0.11), springing - 0.05, 0], [0.13, 0.06, t * 0.5 + 0.04], { chamfer: 0.014 });
    }
    // Spandrels: stepped columns from the extrados up to the rectangular cut.
    const N = 9;
    const cw = op.w / N;
    for (let i = 0; i < N; i++) {
      const uu = -r + cw * (i + 0.5);
      const far = Math.max(Math.abs(uu) + cw * 0.5, 0);
      const ext = far >= rOut ? 0 : Math.sqrt(rOut * rOut - far * far);
      const y0 = springing + ext;
      if (rectTop - y0 < 0.02) continue;
      mb.box([u + uu, (y0 + rectTop) * 0.5, 0], [cw * 0.5 + 0.004, (rectTop - y0) * 0.5, t * 0.5], { chamfer: 0.006 });
    }
  });
}

/**
 * Square or round pier with a base and a capital. Columns are the cheapest way to
 * break a long interior sightline while keeping it traversable.
 */
export function addPillar(bat, x, z, y0, y1, size, opts = {}) {
  const mat = opts.mat || 'struct.concreteClean';
  const round = !!opts.round;
  const h = y1 - y0;
  if (h <= 0.1) return;
  const baseH = opts.baseH ?? 0.22;
  const capH = opts.capH ?? 0.2;
  bat.upTo(mat, opts.lodMax ?? 0, (mb) => {
    mb.box([x, y0 + baseH * 0.5, z], [size * 0.72, baseH * 0.5, size * 0.72], { chamfer: 0.025 });
    if (round) {
      mb.cylinder([x, y0 + baseH, z], [x, y1 - capH, z], size * 0.52, opts.segments ?? 12, { radius2: size * 0.47 });
    } else {
      mb.box([x, (y0 + baseH + y1 - capH) * 0.5, z], [size * 0.5, (h - baseH - capH) * 0.5, size * 0.5], {
        chamfer: 0.03,
      });
    }
    mb.box([x, y1 - capH * 0.5, z], [size * 0.78, capH * 0.5, size * 0.78], { chamfer: 0.028 });
  });
  if (opts.collide !== false) {
    bat.box(x, (y0 + y1) * 0.5, z, size * 0.55, h * 0.5, size * 0.55, opts.surface || bat.palette.surface(mat));
  }
}

/** Buttress / pilaster: a shallow vertical rib that gives a blank facade rhythm. */
export function addPilaster(bat, frame, u, y0, y1, w, depth, mat) {
  bat.upTo(mat, 0, (mb) => {
    mb.box([u, (y0 + y1) * 0.5, depth * 0.5], [w * 0.5, (y1 - y0) * 0.5, depth * 0.5], { chamfer: 0.02 });
  });
}

/**
 * A pipe running down a facade with brackets — the classic vertical rust streak
 * generator, and it breaks up flat wall panels for almost no cost.
 */
export function addDownpipe(bat, x, z, y0, y1, nx, nz, mat = 'metal.galv') {
  const r = 0.055;
  bat.upTo(mat, 0, (mb) => {
    mb.cylinder([x, y0, z], [x, y1, z], r, 8);
    for (let y = y0 + 0.9; y < y1 - 0.3; y += 1.7) {
      mb.box([x - nx * 0.05, y, z - nz * 0.05], [r + 0.03, 0.035, r + 0.03], { chamfer: 0.006 });
    }
    // Shoe at the bottom, kicking out over the pavement.
    mb.cylinder([x, y0 + 0.22, z], [x + nx * 0.16, y0 + 0.04, z + nz * 0.16], r * 1.05, 8);
  });
}

/** Simple opening-free wall segment, used for interior partitions and low walls. */
export function lowWall(bat, x0, z0, x1, z1, y0, y1, thick, mat, opts = {}) {
  const frame = wallFrame(x0, z0, x1, z1, y0);
  if (!frame) return;
  const L = frame.length;
  const H = y1 - y0;
  bat.push(frame.matrix);
  bat.upTo(mat, opts.lodMax ?? 0, (mb) => {
    mb.box([L * 0.5, H * 0.5, 0], [L * 0.5, H * 0.5, thick * 0.5], { chamfer: opts.chamfer ?? 0.025 });
  });
  if (opts.coping !== false && H > 0.3) {
    bat.upTo(opts.copingMat || 'struct.concreteClean', 0, (mb) => {
      mb.prism(
        [
          [0, H, -thick * 0.5 - 0.03],
          [L, H, -thick * 0.5 - 0.03],
          [L, H, thick * 0.5 + 0.03],
          [0, H, thick * 0.5 + 0.03],
        ],
        [
          [0, H + 0.06, -thick * 0.5 - 0.01],
          [L, H + 0.06, -thick * 0.5 - 0.01],
          [L, H + 0.075, thick * 0.5 + 0.01],
          [0, H + 0.075, thick * 0.5 + 0.01],
        ]
      );
    });
  }
  bat.pop();
  if (opts.collide !== false) {
    const cx = (x0 + x1) * 0.5;
    const cz = (z0 + z1) * 0.5;
    bat.boxYaw(
      cx,
      (y0 + y1) * 0.5 + 0.03,
      cz,
      L * 0.5,
      (H + 0.06) * 0.5,
      thick * 0.5 + 0.03,
      Math.atan2(-frame.uz, frame.ux),
      opts.surface || bat.palette.surface(mat)
    );
  }
}

export default { wallRun, wallFrame, addPillar, addPilaster, addDownpipe, lowWall, localToWorld };
