/**
 * kit/Stairs.js — vertical circulation. Owner: level agent.
 *
 * Stairs, ramps, ladders and mantle-height blocks: the pieces that make a map's
 * elevation tiers actually reachable. Two details matter more than they sound:
 *   • **Nosings.** Every tread overhangs its riser by ~3 cm. Without it a staircase is
 *     an accordion of grey rectangles; with it every step catches a highlight on the
 *     lip and a shadow under it, which is what makes stairs read as stairs from 30 m.
 *   • **Ramp collision.** The visual is stepped; the collider is a single inclined box
 *     so movement is smooth regardless of whether the player controller implements
 *     step-up yet.
 */
import * as THREE from 'three';
import { clamp } from './geom.js';

const _up = new THREE.Vector3(0, 1, 0);

/** Local frame for a run of steps: +X travels up-slope horizontally, +Z is to the left. */
function runFrame(x, y, z, yaw) {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(_up, yaw), new THREE.Vector3(1, 1, 1));
  return m;
}

/**
 * @param {object} o
 * @param {number} o.x,o.y,o.z    bottom-centre of the first riser
 * @param {number} o.yaw          direction of travel (0 = +X)
 * @param {number} o.width
 * @param {number} o.steps
 * @param {number} [o.rise=0.175]
 * @param {number} [o.run=0.29]
 * @param {string} [o.mat]
 * @param {'none'|'left'|'right'|'both'} [o.railing]
 * @param {boolean}[o.stringer=true]  solid triangular side cheeks
 * @returns {{topY:number, topX:number, topZ:number, length:number}}
 */
export function stairs(bat, o) {
  const rise = o.rise ?? 0.175;
  const run = o.run ?? 0.295;
  const n = Math.max(1, Math.round(o.steps));
  const w = o.width ?? 1.6;
  const mat = o.mat || 'struct.concrete';
  const nosingMat = o.nosingMat || mat;
  const L = n * run;
  const H = n * rise;
  const frame = runFrame(o.x, o.y, o.z, o.yaw || 0);
  const hw = w * 0.5;

  bat.push(frame);
  bat.upTo(mat, 0, (mb) => {
    for (let i = 0; i < n; i++) {
      const x0 = i * run;
      const top = (i + 1) * rise;
      // Column under the tread: solid, so the flight is never see-through.
      mb.box([x0 + run * 0.5, top * 0.5, 0], [run * 0.5, top * 0.5, hw], { chamfer: 0.014 });
    }
  });
  // Nosings: a proud lip on the leading edge of every tread.
  bat.upTo(nosingMat, 0, (mb) => {
    for (let i = 0; i < n; i++) {
      const x0 = i * run;
      const top = (i + 1) * rise;
      mb.box([x0 - 0.012, top - 0.024, 0], [0.036, 0.024, hw + 0.012], { chamfer: 0.009 });
    }
  });

  if (o.stringer !== false) {
    bat.upTo(o.stringerMat || mat, 0, (mb) => {
      for (const s of [-1, 1]) {
        const zc = s * (hw + 0.055);
        const tri = (zz) => [
          [0, 0, zz],
          [L, 0, zz],
          [L, H, zz],
          [0.02, rise * 0.9, zz],
        ];
        mb.prism(tri(zc - 0.055), tri(zc + 0.055));
      }
    });
  }
  bat.pop();

  // Collision: one inclined slab, plus a landing lip so you cannot clip the top edge.
  const cs = Math.cos(o.yaw || 0);
  const sn = Math.sin(o.yaw || 0);
  const slope = Math.atan2(rise, run);
  const midX = o.x + cs * L * 0.5;
  const midZ = o.z - sn * L * 0.5;
  const q = new THREE.Quaternion()
    .setFromAxisAngle(_up, o.yaw || 0)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), slope));
  const diag = Math.hypot(L, H);
  bat.collider({
    type: 'box',
    pos: { x: midX, y: o.y + H * 0.5 - 0.02, z: midZ },
    halfExtents: { x: diag * 0.5, y: 0.14, z: hw },
    quat: { x: q.x, y: q.y, z: q.z, w: q.w },
    surface: o.surface || bat.palette.surface(mat),
    occlude: false,
  });
  // AO occluder: the solid mass under the flight.
  bat.occluder({
    type: 'box',
    pos: { x: midX, y: o.y + H * 0.25, z: midZ },
    halfExtents: { x: L * 0.5, y: H * 0.25 + 0.05, z: hw },
    yaw: o.yaw || 0,
  });

  if (o.railing && o.railing !== 'none') {
    const sides = o.railing === 'both' ? [-1, 1] : [o.railing === 'left' ? 1 : -1];
    for (const s of sides) {
      railingSloped(bat, {
        x: o.x,
        y: o.y,
        z: o.z,
        yaw: o.yaw || 0,
        offset: s * (hw + 0.06),
        length: L,
        rise: H,
        height: o.railHeight ?? 1.0,
        mat: o.railMat || 'metal.rust',
      });
    }
  }

  return { topY: o.y + H, topX: o.x + cs * L, topZ: o.z - sn * L, length: L, height: H };
}

/** Sloped tube railing that follows a flight. */
export function railingSloped(bat, o) {
  const frame = runFrame(o.x, o.y, o.z, o.yaw);
  const L = o.length;
  const H = o.rise;
  const h = o.height ?? 1.0;
  bat.push(frame);
  bat.upTo(o.mat || 'metal.rust', 0, (mb) => {
    const posts = Math.max(2, Math.round(L / 1.15) + 1);
    for (let i = 0; i < posts; i++) {
      const x = (L * i) / (posts - 1);
      const yb = (H * i) / (posts - 1);
      mb.cylinder([x, yb, o.offset], [x, yb + h, o.offset], 0.024, 6);
    }
    mb.cylinder([0, h, o.offset], [L, h + H, o.offset], 0.028, 8);
    mb.cylinder([0, h * 0.52, o.offset], [L, h * 0.52 + H, o.offset], 0.019, 6);
  });
  bat.pop();
}

/** Horizontal railing along a straight run (balconies, roof edges, bridge parapets). */
export function railing(bat, x0, z0, x1, z1, y, opts = {}) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const L = Math.hypot(dx, dz);
  if (L < 0.2) return;
  const yaw = Math.atan2(-dz, dx);
  const frame = runFrame(x0, y, z0, yaw);
  const h = opts.height ?? 1.05;
  const mat = opts.mat || 'metal.rust';
  bat.push(frame);
  bat.upTo(mat, 0, (mb) => {
    const posts = Math.max(2, Math.round(L / (opts.spacing ?? 1.2)) + 1);
    for (let i = 0; i < posts; i++) {
      const x = (L * i) / (posts - 1);
      mb.box([x, h * 0.5, 0], [0.026, h * 0.5, 0.026], { chamfer: 0.006 });
    }
    if (opts.style === 'baluster') {
      const n = Math.max(2, Math.round(L / 0.16));
      for (let i = 1; i < n; i++) {
        const x = (L * i) / n;
        mb.box([x, h * 0.45, 0], [0.012, h * 0.45, 0.012], { chamfer: 0.004 });
      }
    } else {
      for (const f of [0.34, 0.67]) mb.cylinder([0, h * f, 0], [L, h * f, 0], 0.014, 6);
    }
    mb.cylinder([-0.03, h, 0], [L + 0.03, h, 0], 0.026, 8);
  });
  bat.pop();
  if (opts.collide !== false) {
    bat.boxYaw((x0 + x1) * 0.5, y + h * 0.5, (z0 + z1) * 0.5, L * 0.5, h * 0.5, 0.05, yaw, 'metal', { occlude: false });
  }
}

/** Wedge ramp — vehicle ramps into the drainage channel, loading docks. */
export function ramp(bat, o) {
  const frame = runFrame(o.x, o.y, o.z, o.yaw || 0);
  const L = o.length;
  const H = o.rise;
  const hw = (o.width ?? 3) * 0.5;
  bat.push(frame);
  bat.upTo(o.mat || 'struct.concrete', 0, (mb) => {
    const tri = (zz) => [
      [0, 0, zz],
      [L, 0, zz],
      [L, H, zz],
    ];
    mb.prism(tri(-hw), tri(hw));
  });
  bat.pop();
  const slope = Math.atan2(H, L);
  const q = new THREE.Quaternion()
    .setFromAxisAngle(_up, o.yaw || 0)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), slope));
  const cs = Math.cos(o.yaw || 0);
  const sn = Math.sin(o.yaw || 0);
  bat.collider({
    type: 'box',
    pos: { x: o.x + cs * L * 0.5, y: o.y + H * 0.5, z: o.z - sn * L * 0.5 },
    halfExtents: { x: Math.hypot(L, H) * 0.5, y: 0.16, z: hw },
    quat: { x: q.x, y: q.y, z: q.z, w: q.w },
    surface: o.surface || 'concrete',
  });
}

/** Caged or plain ladder. Rungs are real geometry so it reads at close range. */
export function ladder(bat, x, z, y0, y1, nx, nz, opts = {}) {
  const mat = opts.mat || 'metal.rust';
  const w = opts.width ?? 0.44;
  const tx = -nz;
  const tz = nx;
  const off = opts.offset ?? 0.09;
  bat.upTo(mat, 0, (mb) => {
    for (const s of [-1, 1]) {
      const px = x + tx * s * w * 0.5 + nx * off;
      const pz = z + tz * s * w * 0.5 + nz * off;
      mb.cylinder([px, y0, pz], [px, y1, pz], 0.023, 6);
    }
    for (let y = y0 + 0.28; y < y1 - 0.05; y += 0.31) {
      mb.cylinder(
        [x - tx * w * 0.5 + nx * off, y, z - tz * w * 0.5 + nz * off],
        [x + tx * w * 0.5 + nx * off, y, z + tz * w * 0.5 + nz * off],
        0.016,
        6
      );
    }
    // Stand-off brackets into the wall.
    for (let y = y0 + 0.5; y < y1; y += 1.9) {
      mb.box([x + nx * off * 0.5, y, z + nz * off * 0.5], [0.05 + Math.abs(nx) * off, 0.028, 0.05 + Math.abs(nz) * off], {
        chamfer: 0.006,
      });
    }
  });
  // A thin climbable volume so the player controller has something to detect.
  bat.collider({
    type: 'box',
    pos: { x: x + nx * off, y: (y0 + y1) * 0.5, z: z + nz * off },
    halfExtents: { x: Math.abs(tx) * w * 0.5 + 0.05, y: (y1 - y0) * 0.5, z: Math.abs(tz) * w * 0.5 + 0.05 },
    surface: 'metal',
    tag: 'ladder',
    occlude: false,
  });
}

/**
 * A crate: mantle-height cover that doubles as a step onto a roof. Built as a real
 * timber box — corner posts, planks and a lid — because a plain cube at 1 m from the
 * camera is exactly the kind of thing screenshots punish.
 */
export function crate(bat, x, y, z, sx, sy, sz, yaw = 0, opts = {}) {
  const mat = opts.mat || 'wood.weathered';
  const frame = runFrame(x, y, z, yaw);
  const hx = sx * 0.5;
  const hy = sy * 0.5;
  const hz = sz * 0.5;
  bat.push(frame);
  bat.upTo(mat, 0, (mb) => {
    mb.box([0, hy, 0], [hx - 0.035, hy - 0.03, hz - 0.035], { chamfer: 0.012 });
    // Corner posts.
    for (const sxx of [-1, 1]) {
      for (const szz of [-1, 1]) {
        mb.box([sxx * (hx - 0.035), hy, szz * (hz - 0.035)], [0.038, hy, 0.038], { chamfer: 0.008 });
      }
    }
    // Rails top and bottom on all four faces.
    for (const yy of [0.06, sy - 0.06]) {
      mb.box([0, yy, hz - 0.03], [hx - 0.03, 0.045, 0.032], { chamfer: 0.007 });
      mb.box([0, yy, -hz + 0.03], [hx - 0.03, 0.045, 0.032], { chamfer: 0.007 });
      mb.box([hx - 0.03, yy, 0], [0.032, 0.045, hz - 0.03], { chamfer: 0.007 });
      mb.box([-hx + 0.03, yy, 0], [0.032, 0.045, hz - 0.03], { chamfer: 0.007 });
    }
    // Lid, very slightly proud.
    mb.box([0, sy - 0.012, 0], [hx - 0.01, 0.018, hz - 0.01], { chamfer: 0.01 });
  });
  bat.pop();
  bat.boxYaw(x, y + hy, z, hx, hy, hz, yaw, opts.surface || 'wood');
}

/** Stack of crates that forms a mantle staircase up to `targetY`. */
export function crateStack(bat, x, z, y, targetY, yaw, rng) {
  let cur = y;
  let i = 0;
  const out = [];
  while (cur < targetY - 0.35 && i < 4) {
    const h = clamp(targetY - cur > 1.5 ? 0.86 : targetY - cur - 0.05, 0.42, 0.92);
    const s = 0.82 + (rng ? rng() : 0.5) * 0.24;
    const ox = (rng ? rng() - 0.5 : 0) * 0.22;
    const oz = (rng ? rng() - 0.5 : 0) * 0.22;
    crate(bat, x + ox - i * 0.34, cur, z + oz, s, h, s, yaw + (rng ? (rng() - 0.5) * 0.3 : 0), {
      mat: i % 2 ? 'wood.weathered' : 'wood.ply',
    });
    out.push({ x: x + ox - i * 0.34, y: cur + h, z: z + oz });
    cur += h;
    i++;
  }
  return out;
}

export default { stairs, ramp, ladder, railing, railingSloped, crate, crateStack };
