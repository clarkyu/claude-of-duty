/**
 * kit/Street.js — everything between the buildings. Owner: level agent.
 *
 * Kerbs, gutters, storm drains, the drainage channel, and the architectural cover that
 * gives a lane its rhythm: bollards, planters, jersey barriers, sandbag lines, market
 * stall frames, lamp columns and signage. (Loose clutter — bins, tyres, wrecked cars —
 * belongs to the Props agent; everything here is fixed civil works.)
 *
 * Cover placement rule used by LevelData: a player walking any lane should never be
 * exposed for more than ~8 m without something at chest or waist height to break line
 * of sight. These modules are the vocabulary for that.
 *
 * Several of these are published as instanced-geometry factories so a hundred bollards
 * cost one draw call and one geometry.
 */
import * as THREE from 'three';
import { MeshBuilder, hash2, hash3, lerp, clamp01, TAU } from './geom.js';
import { signageLayout, cellUv } from '../props/signage.js';

const _up = new THREE.Vector3(0, 1, 0);

/** Atlas layout is pure data — see props/signage.js. Used by signBoard(). */
const SIGN_LAYOUT = signageLayout();
const SIGN_FASCIA = SIGN_LAYOUT.groups.fascia;

/**
 * A rough spheroid, six sides and three rings — a fruit, a melon, a bundle.
 *
 * Reviewed at 13 m the produce heaps read as "twelve identical maroon blocks in a row
 * that look like bricks", and that is exactly what they were: short 7-gon cylinders
 * with flat caps and a hard silhouette, laid out on an even pitch. Nothing about the
 * material was wrong; a cylinder seen end-on is a rectangle. 42 triangles buys an
 * actual round thing, and `wob` breaks each one so no two are the same shape.
 */
function ball(mb, x, y, z, r, wob = 0, seg = 6) {
  const rings = [
    [-1.0, 0.0],
    [-0.62, 0.72],
    [0.0, 1.0],
    [0.62, 0.74],
    [1.0, 0.0],
  ];
  const pt = (ri, i) => {
    const a = (i / seg) * TAU;
    const k = 1 + wob * Math.sin(a * 3 + ri * 2.1);
    return [x + Math.cos(a) * r * rings[ri][1] * k, y + rings[ri][0] * r * (1 + wob * 0.4), z + Math.sin(a) * r * rings[ri][1] * k];
  };
  for (let ri = 0; ri < rings.length - 1; ri++) {
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const a = pt(ri, i);
      const b = pt(ri, j);
      const c = pt(ri + 1, j);
      const d = pt(ri + 1, i);
      const nx = (a[0] + b[0] + c[0] + d[0]) * 0.25 - x;
      const ny = (a[1] + b[1] + c[1] + d[1]) * 0.25 - y;
      const nz = (a[2] + b[2] + c[2] + d[2]) * 0.25 - z;
      const l = Math.hypot(nx, ny, nz) || 1;
      mb.quad(a, b, c, d, [nx / l, ny / l, nz / l]);
    }
  }
  return mb;
}

/** Build a local-space geometry once, for InstancedMesh use. */
export function localGeometry(fn) {
  const mb = new MeshBuilder('inst');
  mb.colorFn = (x, y, z, nx, ny, nz, out) => {
    out[0] = 0.18 + clamp01(0.9 - y) * 0.35;
    out[1] = 0;
    out[2] = ny > 0.6 ? clamp01(0.4 - y) * 0.5 : 0;
  };
  fn(mb);
  return mb.toGeometry();
}

export function instMatrix(x, y, z, yaw = 0, s = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(s, s, s)
  );
}

/* ══════════════════════════════════════════════════════════ kerbs & gutters ══ */

/**
 * Kerb run: a chamfered upstand with a gutter channel on the road side. The 12 cm
 * upstand plus the dished gutter is what separates "road" from "pavement" visually
 * without needing a texture change to do all the work.
 */
export function kerb(bat, x0, z0, x1, z1, opts = {}) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const L = Math.hypot(dx, dz);
  if (L < 0.2) return;
  const ux = dx / L;
  const uz = dz / L;
  const yaw = Math.atan2(-uz, ux);
  const h = opts.height ?? 0.13;
  const w = opts.width ?? 0.24;
  const roadY = opts.roadY ?? 0;
  const y = opts.y ?? roadY;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((x0 + x1) * 0.5, y, (z0 + z1) * 0.5),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo(opts.mat || 'struct.concreteClean', 0, (mb) => {
    const seg = Math.max(1, Math.round(L / (opts.stone ?? 0.9)));
    const sw = L / seg;
    for (let i = 0; i < seg; i++) {
      const cu = -L * 0.5 + sw * (i + 0.5);
      const j = (hash3(Math.round(x0 * 3), Math.round(z0 * 3), i) - 0.5) * 0.008;
      // Kerb stones: pavement side flush, road side a chamfered upstand.
      mb.prism(
        [
          [cu - sw * 0.5 + 0.006, -0.24, -w * 0.5],
          [cu + sw * 0.5 - 0.006, -0.24, -w * 0.5],
          [cu + sw * 0.5 - 0.006, -0.24, w * 0.5],
          [cu - sw * 0.5 + 0.006, -0.24, w * 0.5],
        ],
        [
          [cu - sw * 0.5 + 0.006, h + j, -w * 0.5],
          [cu + sw * 0.5 - 0.006, h + j, -w * 0.5],
          [cu + sw * 0.5 - 0.006, h + j - 0.012, w * 0.5 - 0.02],
          [cu - sw * 0.5 + 0.006, h + j - 0.012, w * 0.5 - 0.02],
        ]
      );
    }
  });
  bat.pop();
  if (opts.collide !== false) {
    bat.boxYaw((x0 + x1) * 0.5, y + h * 0.5 - 0.12, (z0 + z1) * 0.5, L * 0.5, (h + 0.24) * 0.5, w * 0.5, yaw, 'concrete', {
      occlude: false,
    });
  }
}

/** Kerb-inlet storm drain with a real recessed grate. */
export function stormDrain(bat, x, z, y, yaw, opts = {}) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo('struct.concreteClean', 0, (mb) => {
    mb.box([0, -0.05, 0], [0.52, 0.06, 0.34], { chamfer: 0.014 });
    // Kerb throat above the inlet.
    mb.box([0, 0.13, -0.2], [0.52, 0.06, 0.1], { chamfer: 0.012 });
  });
  bat.upTo('metal.rust', 0, (mb) => {
    for (let i = 0; i < 6; i++) {
      const u = lerp(-0.42, 0.42, i / 5);
      mb.box([u, 0.005, 0], [0.032, 0.018, 0.24], { chamfer: 0.005 });
    }
    mb.box([0, 0.005, 0.26], [0.46, 0.018, 0.03], { chamfer: 0.005 });
    mb.box([0, 0.005, -0.26], [0.46, 0.018, 0.03], { chamfer: 0.005 });
  });
  bat.pop();
  void opts;
}

/** Round manhole cover, very slightly proud and slightly out of level. */
export function manhole(bat, x, z, y, rng) {
  const tilt = ((rng ? rng() : 0.5) - 0.5) * 0.03;
  bat.upTo('metal.rust', 0, (mb) => {
    mb.cylinder([x, y - 0.05, z], [x, y + 0.012 + tilt, z], 0.34, 16);
    mb.cylinder([x, y + 0.012 + tilt, z], [x, y + 0.02 + tilt, z], 0.3, 16);
  });
}

/* ═════════════════════════════════════════════════════════ drainage channel ══ */

/**
 * A sunken concrete storm channel — the map's below-grade flanking route.
 * Builds both retaining walls, an invert with a shallow low-flow gutter, coping along
 * the top edges and periodic weep pipes. Returns the walkable floor rect.
 */
export function drainageChannel(bat, o) {
  const { x0, x1, z0, z1 } = o;
  const topY = o.topY ?? 0;
  const floorY = o.floorY ?? -1.8;
  const wallT = o.wallThick ?? 0.42;
  const mat = o.mat || 'struct.panel';
  const depth = topY - floorY;

  // Invert slab with a low-flow gutter down the middle.
  bat.upTo(o.floorMat || 'struct.concrete', 0, (mb) => {
    const cx = (x0 + x1) * 0.5;
    const gw = 0.55;
    mb.prism(
      [
        [x0, floorY - 0.3, z0],
        [x1, floorY - 0.3, z0],
        [x1, floorY - 0.3, z1],
        [x0, floorY - 0.3, z1],
      ],
      [
        [x0, floorY + 0.05, z0],
        [x1, floorY + 0.05, z0],
        [x1, floorY + 0.05, z1],
        [x0, floorY + 0.05, z1],
      ]
    );
    // Gutter: a shallow dished strip, wet and darker.
    mb.box([cx, floorY + 0.048, (z0 + z1) * 0.5], [gw * 0.5, 0.02, (z1 - z0) * 0.5], { chamfer: 0.03 });
  });
  bat.box((x0 + x1) * 0.5, floorY - 0.15, (z0 + z1) * 0.5, (x1 - x0) * 0.5, 0.2, (z1 - z0) * 0.5, 'concrete');

  // A thin sheet of standing water in the invert.
  if (o.water !== false) {
    bat.upTo('water.pool', 0, (mb) => {
      const cx = (x0 + x1) * 0.5;
      mb.quad(
        [cx - 0.85, floorY + 0.075, z0 + 0.4],
        [cx + 0.85, floorY + 0.075, z0 + 0.4],
        [cx + 0.85, floorY + 0.075, z1 - 0.4],
        [cx - 0.85, floorY + 0.075, z1 - 0.4],
        [0, 1, 0]
      );
    });
  }

  for (const s of [-1, 1]) {
    const wx = s < 0 ? x0 - wallT * 0.5 : x1 + wallT * 0.5;
    bat.upTo(mat, 0, (mb) => {
      mb.box([wx, (floorY + topY) * 0.5, (z0 + z1) * 0.5], [wallT * 0.5, depth * 0.5, (z1 - z0) * 0.5], { chamfer: 0.025 });
      // Panel joints every 3 m — vertical grooves down the retaining wall.
      for (let z = z0 + 3; z < z1 - 0.5; z += 3) {
        mb.box([wx - s * (wallT * 0.5 - 0.012), (floorY + topY) * 0.5, z], [0.014, depth * 0.5 - 0.05, 0.03], {
          chamfer: 0.004,
        });
      }
    });
    bat.box(wx, (floorY + topY) * 0.5, (z0 + z1) * 0.5, wallT * 0.5, depth * 0.5, (z1 - z0) * 0.5, 'concrete');
    // Coping along the top lip.
    bat.upTo('struct.concreteClean', 0, (mb) => {
      const n = Math.max(1, Math.round((z1 - z0) / 1.1));
      const sw = (z1 - z0) / n;
      for (let i = 0; i < n; i++) {
        const cz = z0 + sw * (i + 0.5);
        mb.box([wx, topY + 0.06, cz], [wallT * 0.5 + 0.055, 0.06, sw * 0.5 - 0.009], { chamfer: 0.018 });
      }
    });
    // Weep pipes staining the wall below them.
    bat.upTo('metal.galv', 0, (mb) => {
      for (let z = z0 + 5.5; z < z1 - 2; z += 9) {
        mb.cylinder([wx - s * wallT * 0.5, floorY + 1.05, z], [wx - s * (wallT * 0.5 + 0.14), floorY + 1.02, z], 0.055, 8);
      }
    });
  }

  // Headwalls close the two ends. Without them the invert simply stops and the
  // terrain, which is voided over the whole channel footprint, leaves a hole.
  if (o.headwalls !== false) {
    const hw = o.headThick ?? 0.55;
    const ox0 = x0 - wallT;
    const ox1 = x1 + wallT;
    for (const [zc, sgn] of [
      [z0 - hw * 0.5 + 0.05, -1],
      [z1 + hw * 0.5 - 0.05, 1],
    ]) {
      bat.upTo(mat, 0, (mb) => {
        mb.box([(ox0 + ox1) * 0.5, (floorY + topY) * 0.5, zc], [(ox1 - ox0) * 0.5, depth * 0.5, hw * 0.5], {
          chamfer: 0.03,
        });
      });
      bat.box((ox0 + ox1) * 0.5, (floorY + topY) * 0.5, zc, (ox1 - ox0) * 0.5, depth * 0.5, hw * 0.5, 'concrete');
      bat.upTo('struct.concreteClean', 0, (mb) => {
        const n = Math.max(1, Math.round((ox1 - ox0) / 1.1));
        const sw = (ox1 - ox0) / n;
        for (let i = 0; i < n; i++) {
          mb.box([ox0 + sw * (i + 0.5), topY + 0.06, zc], [sw * 0.5 - 0.009, 0.06, hw * 0.5 + 0.05], { chamfer: 0.018 });
        }
      });
      void sgn;
    }
  }
  return { x0, x1, z0, z1, y: floorY + 0.05 };
}

/** Footbridge across the channel: deck, kerbs, railings, underside beams. */
export function bridge(bat, o) {
  const { x0, x1, z0, z1, y } = o;
  const th = o.thick ?? 0.28;
  bat.upTo(o.mat || 'struct.concrete', 0, (mb) => {
    mb.box([(x0 + x1) * 0.5, y - th * 0.5, (z0 + z1) * 0.5], [(x1 - x0) * 0.5, th * 0.5, (z1 - z0) * 0.5], {
      chamfer: 0.02,
    });
    for (let i = 0; i < 3; i++) {
      const zz = lerp(z0 + 0.4, z1 - 0.4, i / 2);
      mb.box([(x0 + x1) * 0.5, y - th - 0.11, zz], [(x1 - x0) * 0.5 + 0.05, 0.11, 0.13], { chamfer: 0.012 });
    }
  });
  bat.box((x0 + x1) * 0.5, y - th * 0.5, (z0 + z1) * 0.5, (x1 - x0) * 0.5, th * 0.5, (z1 - z0) * 0.5, 'concrete');
}

/* ══════════════════════════════════════════════════════════════════ cover ══ */

export function bollardGeometry() {
  return localGeometry((mb) => {
    mb.cylinder([0, 0, 0], [0, 0.14, 0], 0.14, 12);
    mb.cylinder([0, 0.13, 0], [0, 0.86, 0], 0.095, 12, { radius2: 0.082 });
    mb.cylinder([0, 0.86, 0], [0, 0.92, 0], 0.105, 12, { radius2: 0.05 });
  });
}

export function jerseyBarrier(bat, x, y, z, yaw, len = 2.4, mat = 'struct.concreteClean') {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  const h = 0.92;
  bat.push(m);
  bat.upTo(mat, 0, (mb) => {
    const prof = (yy, hw) => [
      [-len * 0.5, yy, -hw],
      [len * 0.5, yy, -hw],
      [len * 0.5, yy, hw],
      [-len * 0.5, yy, hw],
    ];
    mb.prism(prof(0, 0.31), prof(0.13, 0.29));
    mb.prism(prof(0.13, 0.29), prof(0.4, 0.155));
    mb.prism(prof(0.4, 0.155), prof(h, 0.115));
    // Lifting eyes.
    for (const s of [-1, 1]) mb.cylinder([s * len * 0.22, h, 0], [s * len * 0.22, h + 0.06, 0], 0.03, 8);
  });
  bat.pop();
  bat.boxYaw(x, y + h * 0.5, z, len * 0.5, h * 0.5, 0.3, yaw, 'concrete');
}

/** Raised planter — waist-high cover with a soil bed the Foliage agent can fill. */
export function planter(bat, x, y, z, sx, sz, yaw = 0, opts = {}) {
  const h = opts.height ?? 0.62;
  const t = 0.16;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo(opts.mat || 'struct.concrete', 0, (mb) => {
    for (const s of [-1, 1]) {
      mb.box([s * (sx * 0.5 - t * 0.5), h * 0.5, 0], [t * 0.5, h * 0.5, sz * 0.5], { chamfer: 0.02 });
      mb.box([0, h * 0.5, s * (sz * 0.5 - t * 0.5)], [sx * 0.5 - t, h * 0.5, t * 0.5], { chamfer: 0.02 });
    }
    mb.box([0, h - 0.24, 0], [sx * 0.5 - t, 0.06, sz * 0.5 - t], { chamfer: 0.015 });
  });
  bat.upTo(opts.soilMat || 'ground.dirt', 0, (mb) => {
    mb.box([0, h - 0.15, 0], [sx * 0.5 - t - 0.01, 0.05, sz * 0.5 - t - 0.01], { chamfer: 0.02 });
  });
  bat.pop();
  bat.boxYaw(x, y + h * 0.5, z, sx * 0.5, h * 0.5, sz * 0.5, yaw, 'concrete');
}

/** Sandbag emplacement — staggered courses, hand-placed look. */
export function sandbagWall(bat, x0, z0, x1, z1, y, courses = 3) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const L = Math.hypot(dx, dz);
  if (L < 0.4) return;
  const yaw = Math.atan2(-dz, dx);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((x0 + x1) * 0.5, y, (z0 + z1) * 0.5),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo('fabric.canvas', 0, (mb) => {
    const bagL = 0.44;
    const bagH = 0.17;
    for (let c = 0; c < courses; c++) {
      const n = Math.max(1, Math.floor(L / bagL));
      const off = c % 2 ? bagL * 0.5 : 0;
      for (let i = 0; i < n; i++) {
        const u = -L * 0.5 + bagL * (i + 0.5) + off;
        if (u > L * 0.5 - 0.1) continue;
        const j = hash3(Math.round(x0 * 5), c, i);
        const wob = (j - 0.5) * 0.035;
        mb.box([u, bagH * (c + 0.5), wob], [bagL * 0.46, bagH * 0.5, 0.16 + j * 0.02], { chamfer: 0.05 });
      }
    }
  });
  bat.pop();
  bat.boxYaw((x0 + x1) * 0.5, y + courses * 0.17 * 0.5, (z0 + z1) * 0.5, L * 0.5, courses * 0.17 * 0.5, 0.2, yaw, 'fabric');
}

/** Market stall: steel frame, canvas roof, timber counter. Signature souk silhouette. */
/**
 * A trader's stall, and — critically — the goods on it.
 *
 * Six identical four-post canopies with nothing under them is a furniture showroom,
 * not a market. `opts.variant` (0-2) swaps the frame between a pipe canopy, a
 * single-slope lean-to and a timber A-frame; the canopy sags on *both* axes rather
 * than being a flat quad; and `opts.goods` (0-3) dresses the counter with produce
 * heaps, sacks, hanging textiles, a hanging balance and a chalk price board.
 */
export function marketStall(bat, x, y, z, yaw, opts = {}) {
  const w = opts.width ?? 2.6;
  const d = opts.depth ?? 1.8;
  const h = opts.height ?? 2.25;
  const variant = opts.variant ?? 0;
  const goods = opts.goods ?? 0;
  const rn = (i) => hash3(Math.round(x * 7), Math.round(z * 7), i);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);

  /* ── frame ─────────────────────────────────────────────────────────────── */
  const backH = variant === 1 ? h + 0.34 : h;
  const frontH = variant === 1 ? h - 0.18 : h;
  const frameMat = variant === 2 ? 'wood.weathered' : 'metal.galv';
  const postR = variant === 2 ? 0.045 : 0.028;
  bat.upTo(frameMat, 0, (mb) => {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const ph = sz < 0 ? backH : frontH;
        mb.cylinder([sx * w * 0.5, 0, sz * d * 0.5], [sx * w * 0.5, ph, sz * d * 0.5], postR, variant === 2 ? 6 : 8);
      }
    }
    mb.cylinder([-w * 0.5, backH, -d * 0.5], [w * 0.5, backH, -d * 0.5], postR * 0.86, 6);
    mb.cylinder([-w * 0.5, frontH, d * 0.5], [w * 0.5, frontH, d * 0.5], postR * 0.86, 6);
    for (const sx of [-1, 1]) mb.cylinder([sx * w * 0.5, backH, -d * 0.5], [sx * w * 0.5, frontH, d * 0.5], postR * 0.86, 6);
    if (variant === 2) {
      /* an A-frame ridge over the middle, so the canopy has a spine */
      mb.cylinder([-w * 0.5, backH + 0.3, 0], [w * 0.5, backH + 0.3, 0], postR * 0.8, 6);
      for (const sx of [-1, 1]) mb.cylinder([sx * w * 0.5, backH, -d * 0.5], [sx * w * 0.5, backH + 0.3, 0], postR * 0.8, 5);
    }
    /* diagonal braces at the back corners — every real stall has them */
    for (const sx of [-1, 1]) {
      mb.cylinder([sx * w * 0.5, backH - 0.02, -d * 0.5], [sx * (w * 0.5 - 0.42), backH - 0.44, -d * 0.5], postR * 0.62, 5);
    }
  });

  /* ── canopy: sags across AND along, with a ridge on the A-frame ────────── */
  bat.upTo(opts.canvas || (variant === 1 ? 'fabric.awning' : 'fabric.awning2'), 0, (mb) => {
    const nu = 6;
    const nv = 4;
    const th = 0.026;
    const over = 0.26;
    const surf = (u, v) => {
      /* u across (-0.5..0.5), v back-to-front (0..1) */
      const px = u * (w + 0.12);
      const pz = lerp(-d * 0.5 - over * 0.4, d * 0.5 + over, v);
      const ridge = variant === 2 ? Math.cos((v - 0.5) * Math.PI) * 0.26 : 0;
      const sagU = Math.cos(u * Math.PI) * 0.085 - 0.085;
      const sagV = -Math.sin(v * Math.PI) * 0.13;
      const flap = Math.sin(u * 7.4 + rn(3) * 6) * 0.016 + Math.sin(v * 5.1 + rn(4) * 6) * 0.014;
      const base = lerp(backH + 0.2, frontH + 0.02, v);
      return [px, base + ridge + sagU + sagV + flap, pz];
    };
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const u0 = -0.5 + i / nu;
        const u1 = -0.5 + (i + 1) / nu;
        const v0 = j / nv;
        const v1 = (j + 1) / nv;
        const a = surf(u0, v0);
        const b = surf(u1, v0);
        const c = surf(u1, v1);
        const e = surf(u0, v1);
        mb.prism(
          [[a[0], a[1] - th, a[2]], [b[0], b[1] - th, b[2]], [c[0], c[1] - th, c[2]], [e[0], e[1] - th, e[2]]],
          [a, b, c, e]
        );
      }
    }
    /* scalloped front valance — five separate lappets, not one straight hem */
    const lap = 5;
    for (let i = 0; i < lap; i++) {
      const u0 = -0.5 + i / lap;
      const u1 = -0.5 + (i + 1) / lap;
      const drop = 0.2 + rn(10 + i) * 0.13;
      const p0 = surf(u0, 1);
      const p1 = surf(u1, 1);
      const mid = (drop + 0.06) * (1 + Math.sin(((i + 0.5) / lap) * Math.PI) * 0.4);
      /* Five points, walked as a ring: top-left, top-right, bottom-right, the low
         point of the scallop, bottom-left. The first pass omitted the top-left
         corner, which turned every lappet into a wedge sticking out at 45° — a row
         of dark tabs rather than a hem. */
      const ring = (zoff) => [
        [p0[0], p0[1], p0[2] + zoff],
        [p1[0], p1[1], p1[2] + zoff],
        [p1[0], p1[1] - drop, p1[2] + zoff],
        [(p0[0] + p1[0]) * 0.5, p0[1] - mid, p0[2] + zoff],
        [p0[0], p0[1] - drop, p0[2] + zoff],
      ];
      mb.prism(ring(-th), ring(0));
    }
  });

  /* ── counter ───────────────────────────────────────────────────────────── */
  bat.upTo('wood.weathered', 0, (mb) => {
    mb.box([0, 0.88, d * 0.22], [w * 0.5 - 0.02, 0.045, d * 0.28], { chamfer: 0.012 });
    for (const sx of [-1, 1]) mb.box([sx * (w * 0.5 - 0.16), 0.44, d * 0.22], [0.05, 0.44, d * 0.26], { chamfer: 0.01 });
    mb.box([0, 0.62, d * 0.5 - 0.03], [w * 0.5 - 0.02, 0.26, 0.03], { chamfer: 0.01 });
    /* a raked display tier at the back of the counter */
    mb.box([0, 1.06, -d * 0.06], [w * 0.5 - 0.12, 0.03, d * 0.14], { chamfer: 0.008 });
    for (const sx of [-1, 1]) mb.box([sx * (w * 0.5 - 0.14), 0.99, -d * 0.06], [0.03, 0.1, d * 0.14], { chamfer: 0.006 });
  });

  /* ── goods ─────────────────────────────────────────────────────────────── */
  if (goods >= 0) {
    /* open produce trays on the counter, heaped */
    const trays = 3 + ((rn(20) * 2) | 0);
    const tm = bat.b('wood.ply');
    for (let i = 0; i < trays; i++) {
      const tx = lerp(-w * 0.5 + 0.36, w * 0.5 - 0.36, trays === 1 ? 0.5 : i / (trays - 1));
      const tw = w / trays - 0.1;
      tm.box([tx, 0.955, d * 0.24], [tw * 0.46, 0.035, 0.2], { chamfer: 0.008 });
      for (const sz of [-1, 1]) tm.box([tx, 0.985, d * 0.24 + sz * 0.2], [tw * 0.46, 0.055, 0.014], { chamfer: 0.005 });
      for (const sx of [-1, 1]) tm.box([tx + sx * tw * 0.46, 0.985, d * 0.24], [0.014, 0.055, 0.2], { chamfer: 0.005 });
    }
    /*
     * The heaps themselves.
     *
     * Three things were wrong and all three were about *shape*, not colour: every
     * item was a flat-capped cylinder (a rectangle in silhouette), every tray held
     * one colour, and the pitch was even — so a stall front resolved as a row of
     * identical maroon blocks that read as brickwork. Now each tray gets a dominant
     * colour with a scatter of a second and a third through it, the items are rough
     * spheroids of visibly different sizes, and they are heaped in a mound (dense and
     * high in the middle, thinning to the rim) rather than sprinkled on a grid.
     */
    const produceMats = ['veg.citrus', 'veg.tomato', 'veg.green'];
    for (let i = 0; i < trays; i++) {
      const tx = lerp(-w * 0.5 + 0.36, w * 0.5 - 0.36, trays === 1 ? 0.5 : i / (trays - 1));
      const tw = w / trays - 0.1;
      const dom = (i * 2 + goods) % 3;
      /* A spheroid is 48 triangles against a 7-gon cylinder's 24, so the count comes
         down to pay for the shape. Fewer, bigger, rounder, in three colours reads as
         more produce than twice as many blocks did. */
      const per = 7 + ((rn(30 + i) * 4) | 0);
      for (let k = 0; k < per; k++) {
        /* Radial mound: r^0.65 biases the scatter outward but the *height* falls off
           with radius, so the pile has a crown. */
        const ang = rn(200 + i * 31 + k) * TAU;
        const rad = Math.pow(rn(60 + i * 11 + k), 0.62);
        const ox = Math.cos(ang) * rad * tw * 0.44;
        const oz = Math.sin(ang) * rad * 0.19;
        const rr = 0.044 + rn(40 + i * 9 + k) * 0.042;
        const oy = 1.015 + rr * 0.85 + (1 - rad * rad) * 0.055;
        /* one item in four is a different crop — a real tray is never monochrome */
        const which = rn(160 + i * 17 + k) < 0.74 ? dom : (dom + 1 + ((rn(170 + k) * 2) | 0)) % 3;
        ball(bat.b(produceMats[which]), tx + ox, oy, d * 0.24 + oz, rr, 0.14 + rn(180 + k) * 0.14);
      }
      /* a second heap on the raked back tier, which is the one the eye reads first */
      for (let k = 0; k < 4; k++) {
        const rr = 0.048 + rn(120 + i * 7 + k) * 0.036;
        const ox = (rn(140 + i * 5 + k) - 0.5) * (tw * 0.72);
        const which = rn(150 + i * 13 + k) < 0.7 ? (dom + 1) % 3 : dom;
        ball(bat.b(produceMats[which]), tx + ox, 1.1 + rr * 0.7, -d * 0.06 + (rn(190 + k) - 0.5) * 0.08, rr, 0.16);
      }
    }
    /* hessian sacks slumped at the foot of the counter, mouths rolled open */
    const sm = bat.b('fabric.canvas');
    const sacks = 2 + ((rn(21) * 2) | 0);
    for (let i = 0; i < sacks; i++) {
      const sx2 = lerp(-w * 0.5 + 0.3, w * 0.5 - 0.3, sacks === 1 ? 0.5 : i / (sacks - 1)) + (rn(22 + i) - 0.5) * 0.2;
      const sz2 = -d * 0.22 + (rn(23 + i) - 0.5) * 0.2;
      const sh = 0.34 + rn(24 + i) * 0.18;
      sm.cylinder([sx2, 0.0, sz2], [sx2, sh * 0.62, sz2], 0.19 + rn(25 + i) * 0.05, 9, { radius2: 0.17 });
      sm.cylinder([sx2, sh * 0.62, sz2], [sx2, sh, sz2], 0.17, 9, { radius2: 0.13 });
      sm.cylinder([sx2, sh, sz2], [sx2, sh + 0.07, sz2], 0.15, 9, { radius2: 0.16 });
      /* what is in it, proud of the mouth */
      bat.b(produceMats[(i + goods + 1) % 3]).cylinder([sx2, sh + 0.05, sz2], [sx2, sh + 0.12, sz2], 0.13, 8, { radius2: 0.05 });
    }
    /* textiles hanging off the front rail — the strongest vertical a stall has */
    if (goods % 2 === 1) {
      const cm = bat.b('fabric.awning');
      for (let i = 0; i < 3; i++) {
        const hx = lerp(-w * 0.4, w * 0.4, i / 2) + (rn(50 + i) - 0.5) * 0.1;
        const hh = 0.5 + rn(51 + i) * 0.55;
        const hw = 0.22 + rn(52 + i) * 0.12;
        for (let s = 0; s < 3; s++) {
          const t0 = s / 3;
          const t1 = (s + 1) / 3;
          const z0 = d * 0.5 + 0.02 + Math.sin(t0 * 2.1) * 0.03;
          const z1 = d * 0.5 + 0.02 + Math.sin(t1 * 2.1) * 0.03;
          cm.prism(
            [
              [hx - hw, frontH - 0.34 - t1 * hh, z1 - 0.012],
              [hx + hw, frontH - 0.34 - t1 * hh, z1 - 0.012],
              [hx + hw * (1 + t1 * 0.14), frontH - 0.34 - t0 * hh, z0 - 0.012],
              [hx - hw * (1 + t1 * 0.14), frontH - 0.34 - t0 * hh, z0 - 0.012],
            ],
            [
              [hx - hw, frontH - 0.34 - t1 * hh, z1],
              [hx + hw, frontH - 0.34 - t1 * hh, z1],
              [hx + hw * (1 + t1 * 0.14), frontH - 0.34 - t0 * hh, z0],
              [hx - hw * (1 + t1 * 0.14), frontH - 0.34 - t0 * hh, z0],
            ]
          );
        }
      }
    }
    /*
     * Hanging balance. The old one was a cone sitting on a disc, which is a lampshade
     * — the shape that identifies a souk scale is the *dial*: a flat drum hung face-on
     * to the aisle, with a hook under it and a shallow pan on three chains. So build
     * that: hanger rod, dial body, a pale face plate on the front of it, the hook, and
     * a pan that is a rim rather than a plate.
     */
    const bm = bat.b('metal.galv');
    const bx = w * (goods % 2 ? -0.34 : 0.34);
    const bz = d * 0.16;
    const dy = frontH - 0.44; // dial centre
    /* hanger */
    bm.cylinder([bx, frontH - 0.06, bz], [bx, dy + 0.14, bz], 0.006, 4);
    bm.cylinder([bx, dy + 0.16, bz], [bx, dy + 0.12, bz], 0.028, 6);
    /* the dial: a 22 cm drum lying in the XY plane, so its face looks down the aisle */
    bm.cylinder([bx, dy, bz - 0.032], [bx, dy, bz + 0.032], 0.112, 12);
    bat.b('metal.paintCream').cylinder([bx, dy, bz + 0.033], [bx, dy, bz + 0.042], 0.098, 12);
    /* pointer, a thin bar across the face — the one detail that says "instrument" */
    bat.b('metal.rust').box([bx + 0.03, dy + 0.03, bz + 0.048], [0.055, 0.006, 0.004]);
    /* hook and pan */
    bm.cylinder([bx, dy - 0.11, bz], [bx, dy - 0.19, bz], 0.007, 4);
    for (let s = 0; s < 3; s++) {
      const a = (s / 3) * TAU + 0.5;
      bm.cylinder([bx, dy - 0.19, bz], [bx + Math.cos(a) * 0.15, dy - 0.4, bz + Math.sin(a) * 0.15], 0.0035, 4);
    }
    /* the pan is an open dish: a rim ring plus a shallow floor, not a solid puck */
    bm.cylinder([bx, dy - 0.415, bz], [bx, dy - 0.4, bz], 0.13, 12, { radius2: 0.155 });
    bm.cylinder([bx, dy - 0.418, bz], [bx, dy - 0.412, bz], 0.148, 12);
    /* something actually in the pan */
    ball(bat.b(produceMats[(goods + 2) % 3]), bx - 0.04, dy - 0.36, bz + 0.02, 0.055, 0.18);
    ball(bat.b(produceMats[goods % 3]), bx + 0.05, dy - 0.365, bz - 0.03, 0.05, 0.2);
    /* chalk price board propped on the counter end */
    bat
      .b('wood.painted')
      .box([-bx, 1.16, d * 0.34], [0.2, 0.26, 0.016], { chamfer: 0.006 });
    bat.b('metal.rust').cylinder([-bx, 0.9, d * 0.34 + 0.03], [-bx, 1.16, d * 0.34 + 0.03], 0.008, 4);
  }
  bat.pop();
  bat.boxYaw(x, y + 0.46, z, w * 0.5 - 0.02, 0.46, d * 0.28, yaw, 'wood');
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const cs = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const lx = sx * w * 0.5;
      const lz = sz * d * 0.5;
      bat.box(x + lx * cs + lz * sn, y + h * 0.5, z - lx * sn + lz * cs, 0.05, h * 0.5, 0.05, 'metal', { occlude: false });
    }
}

/** Street lamp: cast base, tapered column, curved arm, luminaire housing. */
export function lampGeometry(h = 4.6) {
  return localGeometry((mb) => {
    mb.box([0, 0.09, 0], [0.17, 0.09, 0.17], { chamfer: 0.014 });
    mb.cylinder([0, 0.16, 0], [0, 0.62, 0], 0.085, 10, { radius2: 0.07 });
    mb.cylinder([0, 0.6, 0], [0, h, 0], 0.062, 10, { radius2: 0.045 });
    // Arm sweeping out, built from short segments so it curves.
    let px = 0;
    let py = h;
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      const nx2 = t * 0.95;
      const ny2 = h + Math.sin(t * 1.35) * 0.28;
      mb.cylinder([px, py, 0], [nx2, ny2, 0], 0.042, 8);
      px = nx2;
      py = ny2;
    }
    // Luminaire: a real head, not a terminating stub. Housing, cowl, a glazed
    // underside and the hinge lug — a lamp column that ends in a small white box is
    // the fastest way to make a street read as untextured blockout.
    const lx = px + 0.3;
    const ly = py - 0.03;
    mb.box([lx, ly, 0], [0.34, 0.075, 0.16], { chamfer: 0.025 }); // housing
    mb.box([lx, ly + 0.085, 0], [0.38, 0.035, 0.19], { chamfer: 0.02 }); // cowl
    mb.box([lx, ly - 0.09, 0], [0.27, 0.04, 0.125], { chamfer: 0.018 }); // bowl rim
    mb.box([lx - 0.32, ly - 0.03, 0], [0.05, 0.05, 0.07], { chamfer: 0.012 }); // gear tray
    for (const s of [-1, 1]) mb.box([lx + s * 0.3, ly - 0.05, s * 0.11], [0.026, 0.035, 0.04], { chamfer: 0.008 });
  });
}

/** The glazed underside of the luminaire, instanced separately so it can be emissive. */
export function lampBowlGeometry(h = 4.6) {
  return localGeometry((mb) => {
    let px = 0;
    let py = h;
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      px = t * 0.95;
      py = h + Math.sin(t * 1.35) * 0.28;
    }
    mb.box([px + 0.3, py - 0.135, 0], [0.23, 0.022, 0.1], { chamfer: 0.012 });
  });
}

export function lampLensGeometry() {
  return localGeometry((mb) => {
    mb.box([0, 0, 0], [0.2, 0.012, 0.1], { chamfer: 0.008 });
  });
}

export function acUnitGeometry() {
  return localGeometry((mb) => {
    mb.box([0, 0.24, 0], [0.34, 0.24, 0.22], { chamfer: 0.018 });
    for (let i = 0; i < 7; i++) mb.box([-0.28 + i * 0.093, 0.24, 0.225], [0.032, 0.2, 0.012], { chamfer: 0.004 });
    mb.box([0, 0.02, -0.02], [0.36, 0.022, 0.2], { chamfer: 0.008 });
    mb.box([0, -0.06, -0.16], [0.05, 0.06, 0.05], { chamfer: 0.008 });
  });
}

export function grateGeometry() {
  return localGeometry((mb) => {
    mb.box([0, -0.015, 0], [0.42, 0.02, 0.3], { chamfer: 0.008 });
    for (let i = 0; i < 7; i++) mb.box([-0.34 + i * 0.113, 0.005, 0], [0.028, 0.02, 0.26], { chamfer: 0.005 });
  });
}

/**
 * Wall-mounted shop fascia, with the shop's name on it.
 *
 * This used to emit a blank emissive rectangle — a glowing panel with nothing written
 * on it, which on a street with no other lettering anywhere was the loudest tell in
 * the frame. The face is now a quad UV-mapped to a cell of the shared signage atlas
 * (props/signage.js), so the board carries an Arabic shop name, a French strapline and
 * a phone number, and the two gooseneck lamps over it get something to light.
 */
export function signBoard(bat, x, y, z, yaw, w, h, opts = {}) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo(opts.frameMat || 'metal.paintGreen', 0, (mb) => {
    mb.box([0, 0, 0], [w * 0.5, h * 0.5, 0.055], { chamfer: 0.014 });
    for (const s of [-1, 1]) mb.cylinder([s * (w * 0.5 - 0.1), h * 0.5, 0], [s * (w * 0.5 - 0.1), h * 0.5 + 0.22, -0.12], 0.018, 6);
  });
  /* Which fascia: deterministic from the board's own position, so a rebuild puts the
     same shop on the same wall. */
  const cellIdx = Math.abs(Math.round(x * 3) + Math.round(z * 7) + Math.round(w * 11)) % SIGN_FASCIA.length;
  const cellName = SIGN_FASCIA[cellIdx];
  const uv = cellUv(SIGN_LAYOUT, cellName);
  const cellDef = SIGN_LAYOUT.cells[cellName];
  const aspect = cellDef ? cellDef.w / cellDef.h : 5.33;
  const ax = w * 0.5 - 0.05;
  // Never stretch the artwork: an Arabic fascia squashed to a different aspect is
  // illegible, and illegible lettering is worse than no lettering. The face keeps the
  // cell's proportions and the frame takes up the slack.
  const ay = Math.min(h * 0.5 - 0.05, ax / aspect);
  bat.upTo(opts.faceMat || 'sign.fascia', 0, (mb) => {
    mb.quad(
      [-ax, -ay, 0.058],
      [ax, -ay, 0.058],
      [ax, ay, 0.058],
      [-ax, ay, 0.058],
      [0, 0, 1],
      [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]]
    );
  });
  /* Two gooseneck lamps washing the board — a lit fascia is a night-pose practical
     and a daytime silhouette break. */
  bat.upTo('metal.rust', 0, (mb) => {
    for (const s of [-1, 1]) {
      const lx = s * (w * 0.5 - 0.22);
      mb.cylinder([lx, h * 0.5 + 0.02, 0.02], [lx, h * 0.5 + 0.2, 0.06], 0.012, 5);
      mb.cylinder([lx, h * 0.5 + 0.2, 0.06], [lx, h * 0.5 + 0.16, 0.24], 0.012, 5);
      mb.cylinder([lx, h * 0.5 + 0.16, 0.24], [lx, h * 0.5 + 0.1, 0.29], 0.07, 8, { radius2: 0.03 });
    }
  });
  bat.pop();
}

/** Chain-link / mesh fence panel run — see-through cover, very COD. */
export function fence(bat, x0, z0, x1, z1, y, h = 2.1, opts = {}) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const L = Math.hypot(dx, dz);
  if (L < 0.4) return;
  const yaw = Math.atan2(-dz, dx);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((x0 + x1) * 0.5, y, (z0 + z1) * 0.5),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo(opts.mat || 'metal.galv', 0, (mb) => {
    const posts = Math.max(2, Math.round(L / 2.6) + 1);
    for (let i = 0; i < posts; i++) {
      const u = -L * 0.5 + (L * i) / (posts - 1);
      mb.cylinder([u, -0.1, 0], [u, h, 0], 0.032, 8);
    }
    mb.cylinder([-L * 0.5, h - 0.04, 0], [L * 0.5, h - 0.04, 0], 0.024, 6);
    mb.cylinder([-L * 0.5, 0.12, 0], [L * 0.5, 0.12, 0], 0.018, 6);
    // Mesh implied by a sparse grid of thin wires — cheaper than an alpha sheet
    // and it never shows the sorting artefacts a transparent plane would.
    const n = Math.max(2, Math.round(L / 0.34));
    for (let i = 1; i < n; i++) {
      const u = -L * 0.5 + (L * i) / n;
      mb.box([u, (h - 0.04) * 0.5 + 0.06, 0], [0.007, (h - 0.16) * 0.5, 0.007], { chamfer: 0 });
    }
    for (let k = 1; k < 6; k++) {
      const yy = 0.12 + ((h - 0.16) * k) / 6;
      mb.box([0, yy, 0], [L * 0.5, 0.006, 0.006], { chamfer: 0 });
    }
  });
  bat.pop();
  bat.boxYaw((x0 + x1) * 0.5, y + h * 0.5, (z0 + z1) * 0.5, L * 0.5, h * 0.5, 0.06, yaw, 'metal', { occlude: false });
}

/** Pipe run bracketed to a wall — the vertical interest a blank facade needs. */
export function pipeRun(bat, pts, radius = 0.07, mat = 'metal.rust') {
  bat.upTo(mat, 0, (mb) => {
    for (let i = 0; i < pts.length - 1; i++) {
      mb.cylinder(pts[i], pts[i + 1], radius, 8);
      if (i > 0) mb.cylinder(pts[i], pts[i], radius * 1.25, 8);
    }
    for (const p of pts) mb.box([p[0], p[1], p[2]], [radius * 1.3, radius * 1.3, radius * 1.3], { chamfer: 0.01 });
  });
  void hash2;
  void TAU;
}

export default {
  kerb,
  stormDrain,
  manhole,
  drainageChannel,
  bridge,
  jerseyBarrier,
  planter,
  sandbagWall,
  marketStall,
  signBoard,
  fence,
  pipeRun,
  bollardGeometry,
  lampGeometry,
  lampBowlGeometry,
  lampLensGeometry,
  acUnitGeometry,
  grateGeometry,
  localGeometry,
  instMatrix,
};
