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

const _up = new THREE.Vector3(0, 1, 0);

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
export function marketStall(bat, x, y, z, yaw, opts = {}) {
  const w = opts.width ?? 2.6;
  const d = opts.depth ?? 1.8;
  const h = opts.height ?? 2.25;
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(_up, yaw),
    new THREE.Vector3(1, 1, 1)
  );
  bat.push(m);
  bat.upTo('metal.galv', 0, (mb) => {
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        mb.cylinder([sx * w * 0.5, 0, sz * d * 0.5], [sx * w * 0.5, h, sz * d * 0.5], 0.028, 8);
      }
    for (const sz of [-1, 1]) mb.cylinder([-w * 0.5, h, sz * d * 0.5], [w * 0.5, h, sz * d * 0.5], 0.024, 6);
    for (const sx of [-1, 1]) mb.cylinder([sx * w * 0.5, h, -d * 0.5], [sx * w * 0.5, h, d * 0.5], 0.024, 6);
  });
  bat.upTo(opts.canvas || 'fabric.awning2', 0, (mb) => {
    const n = 6;
    // Real sheet thickness. A canopy that terminates in a one-pixel edge reads as
    // paper from any angle that catches the rim, which on a stall is most of them.
    const th = 0.026;
    for (let i = 0; i < n; i++) {
      const u0 = lerp(-w * 0.5, w * 0.5, i / n);
      const u1 = lerp(-w * 0.5, w * 0.5, (i + 1) / n);
      const s0 = Math.sin((i / n) * Math.PI) * 0.09;
      const s1 = Math.sin(((i + 1) / n) * Math.PI) * 0.09;
      mb.prism(
        [
          [u0, h + 0.18 - s0 - th, -d * 0.5],
          [u1, h + 0.18 - s1 - th, -d * 0.5],
          [u1, h - s1 - th, d * 0.5],
          [u0, h - s0 - th, d * 0.5],
        ],
        [
          [u0, h + 0.18 - s0, -d * 0.5],
          [u1, h + 0.18 - s1, -d * 0.5],
          [u1, h - s1, d * 0.5],
          [u0, h - s0, d * 0.5],
        ]
      );
    }
    // Front valance, as a solid so the hem catches light.
    mb.prism(
      [
        [-w * 0.5, h - 0.32, d * 0.52 - th],
        [w * 0.5, h - 0.3, d * 0.52 - th],
        [w * 0.5, h, d * 0.5 - th],
        [-w * 0.5, h, d * 0.5 - th],
      ],
      [
        [-w * 0.5, h - 0.32, d * 0.52],
        [w * 0.5, h - 0.3, d * 0.52],
        [w * 0.5, h, d * 0.5],
        [-w * 0.5, h, d * 0.5],
      ]
    );
  });
  bat.upTo('wood.weathered', 0, (mb) => {
    mb.box([0, 0.88, d * 0.22], [w * 0.5 - 0.02, 0.045, d * 0.28], { chamfer: 0.012 });
    for (const sx of [-1, 1]) mb.box([sx * (w * 0.5 - 0.16), 0.44, d * 0.22], [0.05, 0.44, d * 0.26], { chamfer: 0.01 });
    mb.box([0, 0.62, d * 0.5 - 0.03], [w * 0.5 - 0.02, 0.26, 0.03], { chamfer: 0.01 });
  });
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

/** Wall-mounted shop sign board with a lit face. */
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
  bat.upTo(opts.faceMat || 'sign.lit', 0, (mb) => {
    mb.quad(
      [-w * 0.5 + 0.05, -h * 0.5 + 0.05, 0.058],
      [w * 0.5 - 0.05, -h * 0.5 + 0.05, 0.058],
      [w * 0.5 - 0.05, h * 0.5 - 0.05, 0.058],
      [-w * 0.5 + 0.05, h * 0.5 - 0.05, 0.058],
      [0, 0, 1]
    );
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
