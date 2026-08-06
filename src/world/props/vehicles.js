/**
 * props/vehicles.js — civilian vehicles. Owner: props agent.
 *
 * A car is the hardest prop to fake because everybody knows what one looks like, and a
 * lofted blob reads as a bar of soap. These are built the way a car actually is:
 *
 *   - the **lower body** is a swept cross-section from the sill up to the beltline. The
 *     section is an explicit profile — bottom pan, sill kick, a vertical flank, a
 *     shoulder crease at the belt — so the flanks are flat and the corners are radiused,
 *     which is what makes a car read as pressed steel rather than as a bubble;
 *   - the **greenhouse** is separate: a crowned roof panel, real A/B/C pillars, a header
 *     rail down each side, and glass filling the apertures between them. That gives
 *     genuine panel gaps and a silhouette with a windscreen rake;
 *   - **wheels** are tucked inside the arches (never proud of the flank), and the arch
 *     lip is a half-torus lying *in* the body surface;
 *   - bumpers wrap into the body rather than floating in front of it, lights are
 *     reflector + lens pairs, and the shut lines, sills and mirrors are separate parts.
 *
 * Damage variants deform the section sweep directly (a dent is a real dent in the
 * surface), blow the glass out leaving shards in the rubber, and the burnt-out variant
 * strips paint to the `burnt` material, drops the car onto bare rims, collapses the roof
 * and exposes the seat frames through the empty apertures.
 */
import { chamferBox, plainBox, revolve, tube, torusPrim, sheet, xf, clamp01, lerp, TAU } from './geom.js';

/* ========================================================================== */
/*                              body cross-section                            */
/* ========================================================================== */

/**
 * Right half of a car cross-section, bottom-centre to beltline, in the XY plane.
 * @param {object} s { y0, hw, beltY, kick }  floor height, half width, belt height
 */
function halfSection(s) {
  const hw = s.hw;
  return [
    [0, s.y0],
    [hw * 0.66, s.y0 - 0.005],
    [hw * 0.93, s.y0 + 0.045],
    [hw, s.y0 + 0.13],
    [hw, s.beltY - 0.16],
    [hw - 0.006, s.beltY - 0.05],
    [hw - 0.05, s.beltY],
    [hw * 0.72, s.beltY + 0.012],
    [0, s.beltY + 0.016],
  ];
}

/** Mirror a half-section into a closed ring, counter-clockwise seen from +Z. */
function ringOf(half) {
  const ring = half.slice();
  for (let i = half.length - 2; i >= 1; i--) ring.push([-half[i][0], half[i][1]]);
  return ring;
}

/**
 * Sweep the section table along Z. Each entry is
 * { z, y0, hw, beltY } and `dent` displaces the finished surface inward.
 */
function sweepBody(sections, dent = null) {
  const rings = sections.map((s) => ringOf(halfSection(s)));
  const n = rings[0].length;
  const rows = [];
  for (let j = 0; j < sections.length; j++) {
    const z = sections[j].z;
    const row = [];
    for (let i = 0; i < n; i++) {
      let [x, y] = rings[j][i];
      if (dent) {
        const d = dent(x, y, z);
        if (d > 0) {
          const l = Math.hypot(x, y - sections[j].y0 - 0.35) || 1;
          x -= (x / l) * d;
          y -= ((y - sections[j].y0 - 0.35) / l) * d;
        }
      }
      row.push([x, y, z]);
    }
    rows.push(row);
  }
  return sheetFromRows(rows, n);
}

function sheetFromRows(rows, ring) {
  const pr = { p: [], n: [], i: [] };
  const idx = [];
  for (let j = 0; j < rows.length; j++) {
    const line = [];
    for (let i = 0; i < ring; i++) {
      const p = rows[j][i];
      const a = rows[j][(i + 1) % ring];
      const b = rows[j][(i - 1 + ring) % ring];
      const c = rows[Math.min(rows.length - 1, j + 1)][i];
      const d = rows[Math.max(0, j - 1)][i];
      const ux = a[0] - b[0];
      const uy = a[1] - b[1];
      const uz = a[2] - b[2];
      const vx = c[0] - d[0];
      const vy = c[1] - d[1];
      const vz = c[2] - d[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      const id = pr.p.length / 3;
      pr.p.push(p[0], p[1], p[2]);
      pr.n.push(nx / l, ny / l, nz / l);
      line.push(id);
    }
    idx.push(line);
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < ring; i++) {
      const i2 = (i + 1) % ring;
      pr.i.push(idx[j][i], idx[j + 1][i2], idx[j + 1][i]);
      pr.i.push(idx[j][i], idx[j][i2], idx[j + 1][i2]);
    }
  }
  /* close both ends with a fan */
  for (const [j, dir] of [[0, -1], [rows.length - 1, 1]]) {
    let cx = 0;
    let cy = 0;
    const cz = rows[j][0][2];
    for (let i = 0; i < ring; i++) {
      cx += rows[j][i][0];
      cy += rows[j][i][1];
    }
    cx /= ring;
    cy /= ring;
    const cid = pr.p.length / 3;
    pr.p.push(cx, cy, cz);
    pr.n.push(0, 0, dir);
    for (let i = 0; i < ring; i++) {
      const i2 = (i + 1) % ring;
      if (dir > 0) pr.i.push(cid, idx[j][i], idx[j][i2]);
      else pr.i.push(cid, idx[j][i2], idx[j][i]);
    }
  }
  return pr;
}

/** Two lobes of impact damage, evaluated in body space. */
function dentField(r, count) {
  const lobes = [];
  for (let i = 0; i < count; i++) {
    lobes.push({
      x: r.range(-0.9, 0.9),
      y: r.range(0.45, 0.95),
      z: r.range(-1.6, 1.6),
      s: r.range(0.3, 0.62),
      d: r.range(0.04, 0.11),
    });
  }
  return (x, y, z) => {
    let acc = 0;
    for (const l of lobes) {
      const dd = Math.hypot((x - l.x) * 0.85, (y - l.y) * 1.15, (z - l.z) * 0.5) / l.s;
      acc += l.d * Math.exp(-dd * dd);
    }
    return acc;
  };
}

/* ========================================================================== */
/*                                  greenhouse                                */
/* ========================================================================== */

/**
 * Roof panel, pillars, header rails and glass. `apertures` are the side-window openings
 * as [zStart, zEnd] pairs; pillars are authored between them.
 */
function greenhouse(a, r, o) {
  const { body, glassMat, roofY, roofHW, zFront, zRear, beltY, hw, collapsed } = o;
  const pillar = 0.075;
  const drop = collapsed ? 0.18 : 0;

  /* crowned roof panel */
  a.add(body, sheet(5, 6, (u, v) => {
    const z = lerp(zFront, zRear, v);
    const w = roofHW * (1 - 0.05 * Math.sin(v * Math.PI));
    const crown = Math.cos((u - 0.5) * Math.PI) * 0.035;
    const sag = collapsed ? -Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * drop : 0;
    return [(u - 0.5) * w * 2, roofY + crown + sag, z];
  }), null, { grime: 0.55 });
  /* roof underside + drip rails, so the roof has thickness from every angle */
  for (const s of [-1, 1]) {
    a.add(body, chamferBox(0.055, 0.05, zRear - zFront, 0.014), xf(s * roofHW, roofY - 0.02 + drop * -0.4, (zFront + zRear) / 2), {
      grime: 0.8,
    });
  }
  a.add(body, chamferBox(roofHW * 1.9, 0.045, zRear - zFront - 0.05, 0.02), xf(0, roofY - 0.045 - drop * 0.4, (zFront + zRear) / 2), {
    grime: 0.9,
  });

  /* Pillars are defined by where their TOP meets the roof edge; a rotation about X
     maps local +Y to (0, cos, sin), so the centre has to be walked back down the lean
     or the pillar detaches from the roof it is supposed to hold up. */
  const h = roofY - beltY;
  const pil = [
    { top: zFront + 0.02, lean: 0.44, w: pillar * 1.3 },
    { top: o.zB, lean: 0.0, w: pillar },
    { top: zRear - 0.02, lean: -0.36, w: pillar * 1.25 },
  ];
  for (const p of pil) {
    if (p.top === undefined) continue;
    const cz = p.top - Math.sin(p.lean) * (h + 0.08) * 0.5;
    for (const s of [-1, 1]) {
      a.add(body, chamferBox(p.w, h + 0.08, p.w * 1.5, 0.016),
        xf(s * (roofHW - 0.01), beltY + h / 2, cz, p.lean, 0, 0), { grime: 0.75 });
    }
  }
  /* the beltline rail the glass drops into */
  for (const s of [-1, 1]) {
    a.add(body, chamferBox(0.05, 0.05, zRear - zFront + 0.1, 0.014), xf(s * (hw - 0.02), beltY + 0.01, (zFront + zRear) / 2), {
      grime: 1.0,
    });
  }

  if (!glassMat) return;
  /* windscreen and backlight, raked between the belt and the roof */
  const wsRake = Math.atan2(roofY - beltY, zFront - o.zScuttle);
  a.add(glassMat, chamferBox(roofHW * 1.72, Math.hypot(roofY - beltY, zFront - o.zScuttle) + 0.05, 0.016, 0.006),
    xf(0, (beltY + roofY) / 2 + 0.02, (o.zScuttle + zFront) / 2, Math.PI / 2 - wsRake, 0, 0), { grime: 0.25 });
  if (o.zBacklight !== undefined) {
    const blRake = Math.atan2(roofY - o.backlightY, o.zBacklight - zRear);
    a.add(glassMat, chamferBox(roofHW * 1.62, Math.hypot(roofY - o.backlightY, o.zBacklight - zRear) + 0.05, 0.016, 0.006),
      xf(0, (o.backlightY + roofY) / 2 + 0.02, (zRear + o.zBacklight) / 2, blRake - Math.PI / 2, 0, 0), { grime: 0.3 });
  }
  /* side glass between the pillars */
  for (const [z0, z1] of o.apertures || []) {
    for (const s of [-1, 1]) {
      a.add(glassMat, chamferBox(0.014, roofY - beltY - 0.1, z1 - z0, 0.005),
        xf(s * (roofHW - 0.012), (beltY + roofY) / 2 + 0.01, (z0 + z1) / 2), { grime: 0.28 });
    }
  }
  void r;
}

/** Jagged remains in the rubber after the glass has gone. */
function shards(a, r, o) {
  for (let i = 0; i < 9; i++) {
    const s = r.chance(0.5) ? 1 : -1;
    a.add('glass', chamferBox(0.01, r.range(0.05, 0.17), r.range(0.05, 0.19), 0.003),
      xf(s * o.hw, o.beltY + r.range(0.03, 0.1), r.range(o.z0, o.z1), 0, 0, r.jitter(0.45)), { grime: 0.65 });
  }
}

/* ========================================================================== */
/*                                   wheel                                    */
/* ========================================================================== */

/**
 * Tyre + rim. `flat` squashes the sidewall onto the ground, `burnt` removes the tyre
 * entirely and leaves the car sitting on bare rims.
 */
function wheel(a, r, o = {}) {
  const R = o.radius ?? 0.32;
  const width = o.width ?? 0.2;
  /**
   * Every tyre carries a small contact patch even fully inflated. A perfect circle
   * tangent to the road is the thing that makes a parked car look like it is hovering
   * a millimetre above it, so the default is a slight squash rather than none.
   */
  const flat = o.flat ?? 0.14;
  const rimR = R * 0.62;
  /**
   * **The axle runs across the car, not along it.** `revolveXY` lathes about local +Z,
   * so the wheel disc is authored in the local XY plane — and the transform here used
   * to be a rotation about Z, which leaves the axle pointing down the car's length.
   * Every wheel was therefore turned 90 degrees: from the side you saw the tread band
   * edge-on as a plain cylinder with the rim showing as a bright ring, and none of them
   * lined up with their own arch lips (which are correctly authored about X). A yaw of
   * +/-90 degrees maps local +Z to +/-X, which also puts the hub cap outboard on both
   * sides instead of both hubs facing the same way.
   */
  const M = xf(o.x, o.y, o.z, 0, (o.x < 0 ? -1 : 1) * (Math.PI / 2), 0);
  a.push(M);
  if (!o.burnt) {
    /* tyre: a torus with a bulged sidewall profile and a squared tread band */
    const tr = (R - rimR) * 0.5;
    const cR = rimR + tr;
    const prof = [];
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ang = -Math.PI / 2 + t * Math.PI;
      // flat-ish tread across the middle, bulging sidewalls
      const bulge = 1 + 0.16 * Math.pow(Math.cos(ang), 2);
      prof.push([cR + Math.cos(ang) * tr * bulge, (Math.sin(ang) * width) / 2]);
    }
    const tyreGeo = revolveXY(prof, 14);
    /**
     * Contact patch. The squash has to act on the vertical (local Y, which the yaw
     * above leaves as world up), not on the axial coordinate: the old test was against
     * local Z, whose whole range is +/- half the tyre *width*, so it could never fire
     * and every tyre met the road at a single tangent point.
     */
    if (flat > 0) {
      for (let k = 0; k < tyreGeo.p.length; k += 3) {
        const py = tyreGeo.p[k + 1];
        if (py < -R * 0.5) {
          const f = 1 - flat * clamp01((-py - R * 0.5) / (R * 0.5));
          tyreGeo.p[k + 1] = py * f;
        }
      }
    }
    a.add('tyre', tyreGeo, null, { grime: 1.35, uvOff: [r.range(0, 2), r.range(0, 2)] });
    /* tread blocks — ten is enough to break the silhouette */
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * TAU;
      a.add('tyre', plainBox(0.038, 0.012, width * 0.86),
        xf(Math.cos(ang) * (R + 0.003), Math.sin(ang) * (R + 0.003), 0, 0, 0, ang + Math.PI / 2), { grime: 1.3 });
    }
  }
  /* rim: a dished face with spokes, a lip and a hub cap */
  a.add('alu', revolveXY([[0, -width * 0.42], [rimR * 0.9, -width * 0.42], [rimR, -width * 0.3], [rimR, width * 0.3], [rimR * 0.9, width * 0.42], [0, width * 0.42]], 12), null, {
    grime: 1.2,
  });
  const spokes = 5;
  for (let i = 0; i < spokes; i++) {
    const ang = (i / spokes) * TAU + 0.3;
    a.add('alu', plainBox(rimR * 1.05, 0.055, width * 0.3),
      xf(Math.cos(ang) * rimR * 0.5, Math.sin(ang) * rimR * 0.5, width * 0.16, 0, 0, ang), { grime: 1.15 });
  }
  a.add('alu', revolveXY([[0, width * 0.3], [rimR * 0.3, width * 0.3], [rimR * 0.32, width * 0.36], [0, width * 0.36]], 10), null, { grime: 1.0 });
  a.add('rust', revolveXY([[0, width * 0.36], [0.035, width * 0.36], [0.035, width * 0.4], [0, width * 0.4]], 6), null, { grime: 1.3 });
  a.pop();
}

/** Lathe around the local Z axis (wheels are authored face-on). */
function revolveXY(profile, seg) {
  const pr = { p: [], n: [], i: [] };
  for (let k = 0; k < profile.length - 1; k++) {
    const [r0, z0] = profile[k];
    const [r1, z1] = profile[k + 1];
    if (Math.abs(r0) < 1e-6 && Math.abs(r1) < 1e-6) continue;
    const dr = r1 - r0;
    const dz = z1 - z0;
    const nl = Math.hypot(dr, dz) || 1;
    const nr = dz / nl;
    const nz = -dr / nl;
    for (let s = 0; s < seg; s++) {
      const a0 = (TAU * s) / seg;
      const a1 = (TAU * (s + 1)) / seg;
      const c0 = Math.cos(a0);
      const q0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const q1 = Math.sin(a1);
      const base = pr.p.length / 3;
      pr.p.push(r0 * c0, r0 * q0, z0, r0 * c1, r0 * q1, z0, r1 * c1, r1 * q1, z1, r1 * c0, r1 * q0, z1);
      pr.n.push(nr * c0, nr * q0, nz, nr * c1, nr * q1, nz, nr * c1, nr * q1, nz, nr * c0, nr * q0, nz);
      // A -> B -> C -> D: the Z-axis sweep is the opposite handedness to geom.js's
      // Y-axis revolve(), so the winding is mirrored.
      pr.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return pr;
}

/* ========================================================================== */
/*                                  hatchback                                 */
/* ========================================================================== */

/** Small three-door hatchback. `o.damage` in 'none'|'dented'|'stripped'|'burnt'. */
export function hatchback(a, r, o = {}) {
  const paint = o.paint || r.pick(['carWhite', 'carBlue', 'carSand']);
  const dmg = o.damage || 'none';
  const burnt = dmg === 'burnt';
  const body = burnt ? 'burnt' : paint;
  const L = 3.9;
  const W = 1.68;
  const hw = W / 2;
  const wheelR = 0.3;
  const tyreOuter = wheelR * 1.032;
  const ride = burnt ? wheelR * 0.626 : tyreOuter - (dmg === 'stripped' ? 0.04 : 0);
  const floor = ride - 0.09;
  const dent = dmg === 'none' ? null : dentField(r, dmg === 'dented' ? 2 : 3);

  /* lower body: nose, bonnet, scuttle, cabin, tail */
  const S = [
    { z: -L / 2, y0: floor + 0.16, hw: hw * 0.80, beltY: 0.70 },
    { z: -L / 2 + 0.22, y0: floor + 0.02, hw: hw * 0.95, beltY: 0.80 },
    { z: -L / 2 + 0.70, y0: floor, hw, beltY: 0.86 },
    { z: -L / 2 + 1.20, y0: floor, hw, beltY: 0.90 },
    { z: -0.10, y0: floor, hw, beltY: 0.92 },
    { z: 0.95, y0: floor, hw, beltY: 0.92 },
    { z: L / 2 - 0.62, y0: floor + 0.01, hw: hw * 0.99, beltY: 0.93 },
    { z: L / 2 - 0.20, y0: floor + 0.08, hw: hw * 0.92, beltY: 0.90 },
    { z: L / 2, y0: floor + 0.22, hw: hw * 0.74, beltY: 0.82 },
  ];
  a.add(body, sweepBody(S, dent), null, { grimeHeight: 0.62, uvOff: [r.range(0, 2), r.range(0, 2)] });

  /* greenhouse */
  const roofY = 1.42;
  const zScuttle = -L / 2 + 1.24;
  const zFront = -L / 2 + 1.86;
  const zRear = L / 2 - 0.66;
  greenhouse(a, r, {
    body,
    glassMat: burnt || dmg === 'stripped' ? null : 'glass',
    roofY,
    roofHW: hw * 0.80,
    zFront,
    zRear,
    zB: 0.42,
    zScuttle,
    beltY: 0.93,
    hw,
    collapsed: burnt,
    zBacklight: L / 2 - 0.16,
    backlightY: 0.95,
    apertures: [[zFront + 0.1, 0.36], [0.5, zRear - 0.1]],
  });
  if (burnt || dmg === 'stripped') shards(a, r, { hw: hw * 0.79, beltY: 0.93, z0: zFront, z1: zRear });

  /* bonnet and hatch shut lines, and the sill */
  a.add('burnt', chamferBox(hw * 1.7, 0.012, 0.014, 0.003), xf(0, 0.9, zScuttle - 0.02), { grime: 1.1 });
  for (const s of [-1, 1]) {
    a.add('burnt', chamferBox(0.014, 0.012, 1.05, 0.003), xf(s * hw * 0.78, 0.895, zScuttle - 0.56), { grime: 1.1 });
    a.add('burnt', chamferBox(0.014, 0.5, 0.014, 0.003), xf(s * (hw + 0.002), 0.66, -0.12), { grime: 1.1 });
    a.add('burnt', chamferBox(0.014, 0.5, 0.014, 0.003), xf(s * (hw + 0.002), 0.66, 1.02), { grime: 1.1 });
    /* sill and arch lip, both lying in the body surface */
    a.add('burnt', chamferBox(0.06, 0.07, 1.7, 0.016), xf(s * (hw - 0.015), floor + 0.09, 0.2), { grime: 1.45 });
    for (const wz of [-L / 2 + 0.78, L / 2 - 0.72]) {
      a.add('burnt', torusPrim(wheelR + 0.055, 0.021, 11, 5, Math.PI),
        xf(s * (hw - 0.004), ride, wz, -Math.PI / 2, Math.PI / 2, 0), { grime: 1.3 });
    }
    if (!burnt) {
      a.add(paint, chamferBox(0.045, 0.04, 0.15, 0.012), xf(s * (hw + 0.012), 0.82, 0.62), { grime: 0.9 });
    }
  }

  /* bumpers wrap into the corners rather than floating in front */
  for (const [bz, bw] of [[-L / 2 + 0.09, hw * 1.68], [L / 2 - 0.09, hw * 1.62]]) {
    a.add('burnt', chamferBox(bw, 0.3, 0.3, 0.05), xf(0, floor + 0.24, bz), { grimeHeight: 0.55 });
  }
  /* grille + plate + lights */
  a.add('burnt', chamferBox(hw * 1.05, 0.16, 0.06, 0.014), xf(0, 0.66, -L / 2 + 0.03), { grime: 1.05 });
  for (let i = 0; i < 3; i++) {
    a.add('burnt', chamferBox(hw * 1.0, 0.02, 0.03, 0.005), xf(0, 0.61 + i * 0.05, -L / 2 + 0.005), { grime: 1.15 });
  }
  if (!burnt) {
    a.add('signWhite', chamferBox(0.44, 0.11, 0.01, 0.003), xf(0, floor + 0.26, -L / 2 + 0.02), { grime: 1.15 });
    for (const s of [-1, 1]) {
      a.add('signWhite', chamferBox(0.3, 0.14, 0.05, 0.012), xf(s * hw * 0.62, 0.71, -L / 2 + 0.1), { grime: 0.7 });
      a.add('glass', chamferBox(0.32, 0.16, 0.02, 0.007), xf(s * hw * 0.62, 0.71, -L / 2 + 0.06), { grime: 0.4 });
      a.add('signRed', chamferBox(0.17, 0.24, 0.05, 0.012), xf(s * hw * 0.78, 0.78, L / 2 - 0.06), { grime: 0.6 });
    }
    /* mirrors on the A-pillar foot */
    for (const s of [-1, 1]) {
      if (dmg !== 'none' && s < 0 && r.chance(0.5)) continue;
      a.add('burnt', chamferBox(0.05, 0.03, 0.05, 0.008), xf(s * (hw + 0.02), 0.99, zScuttle + 0.12), { grime: 1.0 });
      a.add(burnt ? 'burnt' : paint, chamferBox(0.11, 0.085, 0.05, 0.014), xf(s * (hw + 0.09), 1.01, zScuttle + 0.14), { grime: 0.9 });
    }
  } else {
    for (const s of [-1, 1]) {
      a.add('burnt', chamferBox(0.3, 0.14, 0.05, 0.012), xf(s * hw * 0.62, 0.71, -L / 2 + 0.07), { grime: 1.5 });
      /* seat frames through the empty apertures, and soot up the flanks */
      a.add('burnt', chamferBox(0.4, 0.06, 0.42, 0.01), xf(s * 0.35, 0.72, 0.1), { grime: 1.6 });
      a.add('burnt', chamferBox(0.38, 0.46, 0.06, 0.01), xf(s * 0.35, 0.95, -0.14, -0.2, 0, 0), { grime: 1.6 });
      a.add('burnt', sheet(4, 4, (u, v) => [s * (hw + 0.006), 0.92 + v * 0.42, lerp(zFront, zRear, u)]), null, { grime: 1.7 });
    }
  }

  /* wheels, tucked inside the arches */
  const wheelX = hw - 0.095 - 0.02;
  const flats = burnt ? 1 : dmg === 'stripped' && r.chance(0.6) ? 0.7 : 0;
  for (const s of [-1, 1]) {
    for (const z of [-L / 2 + 0.78, L / 2 - 0.72]) {
      wheel(a, r, { x: s * wheelX, y: ride, z, radius: wheelR, width: 0.19, flat: flats, burnt });
    }
  }

  const topY = burnt ? roofY - 0.16 : roofY + 0.02;
  return {
    colliders: [
      { type: 'box', halfExtents: [hw, (0.95 - floor) / 2 + 0.04, L / 2], pos: [0, floor + (0.95 - floor) / 2, 0], surface: 'metal' },
      { type: 'box', halfExtents: [hw * 0.82, (roofY - 0.95) / 2, (zRear - zFront) / 2 + 0.2], pos: [0, (0.95 + roofY) / 2, (zFront + zRear) / 2], surface: burnt ? 'metal' : 'glass' },
    ],
    height: topY,
    radius: L * 0.55,
    length: L,
    width: W,
  };
}

/* ========================================================================== */
/*                                   pickup                                   */
/* ========================================================================== */

/** Single-cab pickup with a drop-side bed, a rollbar and a spare wheel. */
export function pickup(a, r, o = {}) {
  const paint = o.paint || r.pick(['carSand', 'carWhite', 'carBlue']);
  const dmg = o.damage || 'none';
  const burnt = dmg === 'burnt';
  const body = burnt ? 'burnt' : paint;
  const L = 5.1;
  const W = 1.86;
  const hw = W / 2;
  const wheelR = 0.38;
  const tyreOuter = wheelR * 1.032;
  // the axle line IS the tyre radius: a lifted look comes from the body sitting
  // higher above the axle, never from floating the wheels off the ground
  const ride = burnt ? wheelR * 0.626 : tyreOuter;
  const floor = ride - 0.05;
  const belt = 1.02;
  const dent = dmg === 'none' ? null : dentField(r, dmg === 'dented' ? 2 : 3);
  const cabZ0 = -L / 2 + 1.25;
  const cabZ1 = -L / 2 + 2.65;

  const S = [
    { z: -L / 2, y0: floor + 0.2, hw: hw * 0.82, beltY: 0.94 },
    { z: -L / 2 + 0.24, y0: floor + 0.02, hw: hw * 0.96, beltY: 1.0 },
    { z: -L / 2 + 0.85, y0: floor, hw, beltY: 1.0 },
    { z: cabZ0, y0: floor, hw, beltY: belt },
    { z: cabZ1, y0: floor, hw, beltY: belt },
    { z: cabZ1 + 0.16, y0: floor, hw: hw * 0.99, beltY: 0.98 },
    { z: L / 2 - 0.12, y0: floor, hw: hw * 0.99, beltY: 0.98 },
    { z: L / 2, y0: floor + 0.12, hw: hw * 0.86, beltY: 0.94 },
  ];
  a.add(body, sweepBody(S, dent), null, { grimeHeight: 0.72, uvOff: [r.range(0, 2), r.range(0, 2)] });

  /* cab greenhouse */
  const roofY = 1.72;
  const zScuttle = cabZ0 + 0.06;
  const zFront = cabZ0 + 0.5;
  greenhouse(a, r, {
    body,
    glassMat: burnt || dmg === 'stripped' ? null : 'glass',
    roofY,
    roofHW: hw * 0.82,
    zFront,
    zRear: cabZ1,
    zB: undefined,
    zScuttle,
    beltY: belt,
    hw,
    collapsed: burnt,
    zBacklight: cabZ1 + 0.1,
    backlightY: belt + 0.05,
    apertures: [[zFront + 0.08, cabZ1 - 0.08]],
  });
  if (burnt || dmg === 'stripped') shards(a, r, { hw: hw * 0.81, beltY: belt, z0: zFront, z1: cabZ1 });

  /* the bed sits on the deck: floor, ribbed base, four drop sides */
  const bedZ0 = cabZ1 + 0.2;
  const bedZ1 = L / 2 - 0.14;
  const bedLen = bedZ1 - bedZ0;
  const bedY = 1.0;
  const sideH = 0.46;
  a.add(body, chamferBox(hw * 1.88, 0.05, bedLen, 0.014), xf(0, bedY, (bedZ0 + bedZ1) / 2), { grimeHeight: 0.8 });
  for (let i = 0; i < 6; i++) {
    a.add(body, plainBox(hw * 1.8, 0.018, 0.05), xf(0, bedY + 0.035, bedZ0 + 0.14 + (i * (bedLen - 0.28)) / 5), { grime: 1.2 });
  }
  for (const s of [-1, 1]) {
    a.add(body, chamferBox(0.06, sideH, bedLen, 0.016), xf(s * (hw - 0.03), bedY + sideH / 2, (bedZ0 + bedZ1) / 2), { grimeHeight: 0.9 });
    a.add(body, chamferBox(0.1, 0.05, bedLen, 0.016), xf(s * (hw - 0.03), bedY + sideH, (bedZ0 + bedZ1) / 2), { grime: 0.95 });
  }
  const tailDown = dmg !== 'none' && r.chance(0.5);
  a.add(body, chamferBox(hw * 1.9, sideH, 0.055, 0.016),
    tailDown ? xf(0, bedY - sideH / 2 + 0.03, bedZ1 + 0.05, Math.PI / 2 - 0.16, 0, 0) : xf(0, bedY + sideH / 2, bedZ1 + 0.02), {
      grimeHeight: 0.9,
    });
  a.add(body, chamferBox(hw * 1.9, sideH + 0.1, 0.06, 0.016), xf(0, bedY + (sideH + 0.1) / 2, bedZ0 - 0.02), { grimeHeight: 0.9 });

  /* rollbar over the bed head */
  if (r.chance(0.65) && !burnt) {
    const arc = [];
    const upH = 0.66;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      let x;
      let y;
      if (t < 0.26) {
        x = -hw * 0.82;
        y = bedY + (t / 0.26) * upH * 0.62;
      } else if (t > 0.74) {
        x = hw * 0.82;
        y = bedY + ((1 - t) / 0.26) * upH * 0.62;
      } else {
        const tt = (t - 0.26) / 0.48;
        const ang = Math.PI * (1 - tt);
        x = Math.cos(ang) * hw * 0.82;
        y = bedY + upH * 0.62 + Math.sin(ang) * upH * 0.44;
      }
      arc.push([x, y, bedZ0 + 0.14]);
    }
    a.add('galv', tube(arc, 0.035, 8, { cap: false }), null, { grime: 1.15 });
    for (const s of [-1, 1]) {
      a.add('galv', tube([[s * hw * 0.7, bedY + upH * 1.02, bedZ0 + 0.14], [s * hw * 0.7, bedY + 0.12, bedZ0 + 0.72]], 0.024, 6), null, {
        grime: 1.2,
      });
    }
  }
  /* spare wheel flat in the bed */
  if (r.chance(0.55) && !burnt) {
    const sx = r.jitter(0.3);
    a.add('tyre', torusPrim(wheelR * 0.76, wheelR * 0.2, 14, 6), xf(sx, bedY + wheelR * 0.24, bedZ1 - 0.62), { grime: 1.4 });
    a.add('galv', revolve([[0, -0.03], [wheelR * 0.46, -0.03], [wheelR * 0.46, 0.03], [0, 0.03]], 12),
      xf(sx, bedY + wheelR * 0.24, bedZ1 - 0.62), { grime: 1.3 });
  }

  /* bumpers, grille, lights, sill step, mirrors, exhaust */
  a.add('burnt', chamferBox(hw * 1.9, 0.28, 0.32, 0.05), xf(0, floor + 0.28, -L / 2 + 0.1), { grimeHeight: 0.62 });
  a.add('burnt', chamferBox(hw * 1.82, 0.2, 0.24, 0.04), xf(0, floor + 0.22, L / 2 - 0.06), { grimeHeight: 0.62 });
  a.add('burnt', chamferBox(hw * 1.2, 0.26, 0.06, 0.014), xf(0, 0.76, -L / 2 + 0.03), { grime: 1.05 });
  for (let i = 0; i < 4; i++) {
    a.add('burnt', plainBox(hw * 1.14, 0.022, 0.03), xf(0, 0.68 + i * 0.052, -L / 2 + 0.005), { grime: 1.2 });
  }
  for (const s of [-1, 1]) {
    if (!burnt) {
      a.add('signWhite', chamferBox(0.26, 0.18, 0.05, 0.012), xf(s * hw * 0.66, 0.84, -L / 2 + 0.11), { grime: 0.7 });
      a.add('glass', chamferBox(0.28, 0.2, 0.02, 0.007), xf(s * hw * 0.66, 0.84, -L / 2 + 0.07), { grime: 0.4 });
      a.add('signRed', chamferBox(0.15, 0.3, 0.05, 0.012), xf(s * hw * 0.86, bedY + 0.22, L / 2 - 0.04), { grime: 0.6 });
      a.add('burnt', chamferBox(0.05, 0.03, 0.05, 0.008), xf(s * (hw + 0.02), 1.24, zScuttle + 0.16), { grime: 1.0 });
      a.add(paint, chamferBox(0.13, 0.11, 0.05, 0.014), xf(s * (hw + 0.1), 1.26, zScuttle + 0.18), { grime: 0.9 });
    } else {
      a.add('burnt', chamferBox(0.42, 0.06, 0.44, 0.01), xf(s * 0.36, 0.98, (cabZ0 + cabZ1) / 2), { grime: 1.6 });
      a.add('burnt', chamferBox(0.4, 0.48, 0.06, 0.01), xf(s * 0.36, 1.24, cabZ1 - 0.16, -0.18, 0, 0), { grime: 1.6 });
    }
    /* running board, shut lines, arch lips */
    a.add('burnt', chamferBox(0.12, 0.06, 1.2, 0.014), xf(s * (hw - 0.01), floor + 0.06, (cabZ0 + cabZ1) / 2), { grime: 1.5 });
    a.add('burnt', chamferBox(0.014, 0.6, 0.014, 0.003), xf(s * (hw + 0.002), 0.72, cabZ0 - 0.04), { grime: 1.1 });
    a.add('burnt', chamferBox(0.014, 0.6, 0.014, 0.003), xf(s * (hw + 0.002), 0.72, cabZ1 + 0.04), { grime: 1.1 });
    for (const wz of [-L / 2 + 0.98, L / 2 - 0.92]) {
      a.add('burnt', torusPrim(wheelR + 0.06, 0.026, 11, 5, Math.PI),
        xf(s * (hw - 0.004), ride, wz, -Math.PI / 2, Math.PI / 2, 0), { grime: 1.3 });
    }
  }
  a.add('rust', tube([[hw * 0.3, floor - 0.03, 0.4], [hw * 0.32, floor - 0.04, L / 2 - 0.12], [hw * 0.36, floor, L / 2 + 0.02]], 0.028, 6, { cap: false }),
    null, { grime: 1.5 });

  const wheelX = hw - 0.12 - 0.02;
  const flats = burnt ? 1 : dmg === 'stripped' && r.chance(0.6) ? 0.7 : 0;
  for (const s of [-1, 1]) {
    for (const z of [-L / 2 + 0.98, L / 2 - 0.92]) {
      wheel(a, r, { x: s * wheelX, y: ride, z, radius: wheelR, width: 0.24, flat: flats, burnt });
    }
  }

  return {
    colliders: [
      { type: 'box', halfExtents: [hw, (belt - floor) / 2 + 0.05, L / 2], pos: [0, floor + (belt - floor) / 2, 0], surface: 'metal' },
      { type: 'box', halfExtents: [hw * 0.84, (roofY - belt) / 2, (cabZ1 - zFront) / 2 + 0.25], pos: [0, (belt + roofY) / 2, (zFront + cabZ1) / 2], surface: burnt ? 'metal' : 'glass' },
      { type: 'box', halfExtents: [hw, sideH / 2, (bedZ1 - bedZ0) / 2], pos: [0, bedY + sideH / 2, (bedZ0 + bedZ1) / 2], surface: 'metal' },
    ],
    height: burnt ? roofY - 0.18 : roofY + 0.05,
    radius: L * 0.55,
    length: L,
    width: W,
  };
}

export default { hatchback, pickup };
