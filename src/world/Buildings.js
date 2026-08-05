/**
 * Buildings.js — turns the LevelData descriptors into geometry. Owner: level agent.
 *
 * One generic generator drives every block: walk the footprint side by side, split it
 * into shop units, auto-place window openings around the declared doors, band the
 * facade (plinth / field / cornice), cap it with a roof, then hang the balconies,
 * awnings, signage, downpipes and stairs off it.
 *
 * Two deliberate choices:
 *   • **Every building is authored three times** — in full at LOD 0, as a two-tone
 *     shell with a parapet at LOD 1, and as a single silhouette box at LOD 2. The
 *     shells are generated, not decimated, so each is a dozen boxes rather than a
 *     re-run of the detailed pass; past ~60 m that is all you can resolve anyway, and
 *     past ~130 m the whole far half of the map collapses to a handful of draws.
 *   • **Adjacent buildings never share a palette key.** `unitWalls` gives a terrace a
 *     different paint per shop unit, and the descriptors alternate stucco / plaster /
 *     brick around each junction, so no two facades that meet in a frame match.
 *
 * Interiors exist for the buildings the map actually fights over — the Market Hall
 * (two storeys, arcade, mezzanine, two stair cores) and the Motor Works.
 */
import * as THREE from 'three';
import { clamp, hash2, hash3, lerp } from './kit/geom.js';
import { wallRun, addPillar, addDownpipe, lowWall } from './kit/Walls.js';
import { stairs, railing, ladder, crate, crateStack } from './kit/Stairs.js';
import { roofDeck, parapet, pitchedRoof, balcony, awning, canopy, roofClutter } from './kit/Roofs.js';
import { signBoard } from './kit/Street.js';

const _up = new THREE.Vector3(0, 1, 0);

/** side 0=+Z 1=+X 2=-Z 3=-X — the traversal order `wallRun` expects. */
export function sideLine(rect, side, t) {
  const [x0, z0, x1, z1] = rect;
  const h = t * 0.5;
  switch (side) {
    case 0:
      return { x0, z0: z1 - h, x1, z1: z1 - h, len: x1 - x0, nx: 0, nz: 1, yaw: 0 };
    case 1:
      return { x0: x1 - h, z0: z1, x1: x1 - h, z1: z0, len: z1 - z0, nx: 1, nz: 0, yaw: -Math.PI / 2 };
    case 2:
      return { x0: x1, z0: z0 + h, x1: x0, z1: z0 + h, len: x1 - x0, nx: 0, nz: -1, yaw: Math.PI };
    default:
      return { x0: x0 + h, z0, x1: x0 + h, z1, len: z1 - z0, nx: -1, nz: 0, yaw: Math.PI / 2 };
  }
}

/** Point on a side at distance `u` from its start, offset `w` along the outward normal. */
export function sidePoint(rect, side, t, u, w = 0) {
  const s = sideLine(rect, side, t);
  const ux = (s.x1 - s.x0) / (s.len || 1);
  const uz = (s.z1 - s.z0) / (s.len || 1);
  return { x: s.x0 + ux * u + s.nx * w, z: s.z0 + uz * u + s.nz * w };
}

function autoWindows(u0, u1, spec, blocked, margin = 1.15) {
  const out = [];
  if (!spec) return out;
  const usable = u1 - u0 - margin * 2;
  if (usable < spec.w * 1.2) return out;
  const n = Math.max(1, Math.round(usable / (spec.spacing || 3.2)));
  const step = usable / n;
  for (let i = 0; i < n; i++) {
    const u = u0 + margin + step * (i + 0.5);
    let clash = false;
    for (const b of blocked) {
      if (Math.abs(u - b.u) < (b.w + spec.w) * 0.5 + 0.55) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    out.push({
      u,
      w: spec.w,
      h: spec.h,
      sill: spec.sill,
      type: 'window',
      style: spec.style === 'shop' ? 'glazed' : spec.style,
      shop: spec.style === 'shop',
    });
  }
  return out;
}

/* ========================================================================== */

/**
 * @param {import('./kit/Batcher.js').Batcher} bat
 * @param {object} def  a LevelData.BUILDINGS entry
 * @param {() => number} rng
 */
export function buildBuilding(bat, def, rng) {
  const rect = def.rect;
  const [x0, z0, x1, z1] = rect;
  const t = def.thick ?? 0.4;
  const base = def.base ?? 0;
  const levels = def.levels || [3.6];
  const ys = [base];
  for (const h of levels) ys.push(ys[ys.length - 1] + h);
  const top = ys[ys.length - 1];
  const solid = new Set(def.solid || []);
  const unitAxis = x1 - x0 >= z1 - z0 ? 'x' : 'z';
  const units = Math.max(1, def.units || 1);
  const unitWalls = def.unitWalls || [def.wall];
  const wallOf = (k) => unitWalls[((k % unitWalls.length) + unitWalls.length) % unitWalls.length] || def.wall;

  if (def.ruin) {
    buildRuin(bat, def, rng);
    return { rect, top, ys };
  }

  /* ── floor slabs ─────────────────────────────────────────────────────── */
  const floorMat = def.interior ? 'int.tile' : 'struct.concrete';
  /**
   * Split [a0,a1] x [b0,b1] into the rectangles left after removing `hole`. Up to
   * four strips, so a floor can carry a double-height void without the slab, its
   * collider and its ceiling all having to be authored by hand.
   */
  const minus = (a0, b0, a1, b1, hole) => {
    if (!hole) return [[a0, b0, a1, b1]];
    const [hx0, hz0, hx1, hz1] = hole;
    if (hx1 <= a0 || hx0 >= a1 || hz1 <= b0 || hz0 >= b1) return [[a0, b0, a1, b1]];
    const cx0 = Math.max(a0, hx0);
    const cz0 = Math.max(b0, hz0);
    const cx1 = Math.min(a1, hx1);
    const cz1 = Math.min(b1, hz1);
    return [
      [a0, b0, a1, cz0],
      [a0, cz1, a1, b1],
      [a0, cz0, cx0, cz1],
      [cx1, cz0, a1, cz1],
    ].filter((r) => r[2] - r[0] > 0.05 && r[3] - r[1] > 0.05);
  };

  for (let i = 0; i < ys.length; i++) {
    const y = ys[i];
    if (i === ys.length - 1) break;
    const th = i === 0 ? 0.3 : 0.26;
    const inset = i === 0 ? 0 : t * 0.4;
    const hole = def.floorVoid && def.floorVoid.level === i ? def.floorVoid.rect : null;
    const cy = y - th * 0.5 + (i === 0 ? 0.05 : 0);
    for (const [a0, b0, a1, b1] of minus(x0 + inset, z0 + inset, x1 - inset, z1 - inset, hole)) {
      bat
        .b(i === 0 ? floorMat : 'struct.concrete')
        .box([(a0 + a1) * 0.5, cy, (b0 + b1) * 0.5], [(a1 - a0) * 0.5, th * 0.5, (b1 - b0) * 0.5], { chamfer: 0.01 });
    }
    // The collider follows the full footprint at ground level (the plinth wants a
    // continuous floor) but respects the void above it.
    for (const [a0, b0, a1, b1] of minus(x0, z0, x1, z1, hole)) {
      bat.box((a0 + a1) * 0.5, cy, (b0 + b1) * 0.5, (a1 - a0) * 0.5, th * 0.5, (b1 - b0) * 0.5, i === 0 ? 'ceramic' : 'concrete');
    }
    // Ceiling underside for upper floors so the storey below is not open sky.
    if (i > 0) {
      for (const [a0, b0, a1, b1] of minus(x0 + t * 0.4, z0 + t * 0.4, x1 - t * 0.4, z1 - t * 0.4, hole)) {
        bat
          .b('int.plaster')
          .box([(a0 + a1) * 0.5, y - th - 0.03, (b0 + b1) * 0.5], [(a1 - a0) * 0.5, 0.03, (b1 - b0) * 0.5], { chamfer: 0 });
      }
    }
    // Edge beam and nosing all the way round the void, so the cut reads as built.
    if (hole) {
      const eb = bat.b('struct.concreteClean');
      const [hx0, hz0, hx1, hz1] = hole;
      eb.box([(hx0 + hx1) * 0.5, cy - 0.06, hz0 + 0.11], [(hx1 - hx0) * 0.5 + 0.22, th * 0.5 + 0.06, 0.13], { chamfer: 0.02 });
      eb.box([(hx0 + hx1) * 0.5, cy - 0.06, hz1 - 0.11], [(hx1 - hx0) * 0.5 + 0.22, th * 0.5 + 0.06, 0.13], { chamfer: 0.02 });
      eb.box([hx0 + 0.11, cy - 0.06, (hz0 + hz1) * 0.5], [0.13, th * 0.5 + 0.06, (hz1 - hz0) * 0.5], { chamfer: 0.02 });
      eb.box([hx1 - 0.11, cy - 0.06, (hz0 + hz1) * 0.5], [0.13, th * 0.5 + 0.06, (hz1 - hz0) * 0.5], { chamfer: 0.02 });
      railing(bat, hx0, hz0, hx1, hz0, y, { height: 1.02, mat: 'metal.rust', style: 'baluster' });
      railing(bat, hx1, hz1, hx0, hz1, y, { height: 1.02, mat: 'metal.rust', style: 'baluster' });
      railing(bat, hx0, hz1, hx0, hz0, y, { height: 1.02, mat: 'metal.rust', style: 'baluster' });
      railing(bat, hx1, hz0, hx1, hz1, y, { height: 1.02, mat: 'metal.rust', style: 'baluster' });
    }
  }

  /* ── walls, level by level, side by side ─────────────────────────────── */
  for (let li = 0; li < levels.length; li++) {
    const y0 = ys[li];
    const y1 = ys[li + 1];
    const spec = li === 0 ? def.windows : def.upperWindows || def.windows;
    for (let side = 0; side < 4; side++) {
      const s = sideLine(rect, side, t);
      if (s.len < 0.6) continue;
      const isSplitSide = (unitAxis === 'x') === (side === 0 || side === 2);
      const nSeg = isSplitSide ? units : 1;
      const segLen = s.len / nSeg;
      for (let k = 0; k < nSeg; k++) {
        const u0 = k * segLen;
        const u1 = u0 + segLen;
        // Which unit tint: reversed for sides that run backwards along the axis.
        const idx = side === 2 || side === 1 ? nSeg - 1 - k : k;
        const mat = isSplitSide ? wallOf(idx) : wallOf(side === 1 ? 0 : units - 1);

        const doors = (def.doors || [])
          .filter((d) => d.side === side && (d.level ?? 0) === li && d.u > u0 && d.u < u1)
          .map((d) => ({ ...d, u: d.u - u0 }));
        const arc =
          def.arcade && def.arcade.side === side && li === 0
            ? Array.from({ length: def.arcade.count }, (_, ai) => {
                const span = s.len / def.arcade.count;
                return {
                  u: span * (ai + 0.5) - u0,
                  w: def.arcade.w,
                  h: def.arcade.h,
                  sill: 0,
                  type: 'arch',
                };
              }).filter((a) => a.u > 0.2 && a.u < segLen - 0.2)
            : [];
        const blocked = doors.concat(arc);
        const wins = solid.has(side) || arc.length ? [] : autoWindows(0, segLen, spec, blocked);

        const start = { x: s.x0 + ((s.x1 - s.x0) * u0) / s.len, z: s.z0 + ((s.z1 - s.z0) * u0) / s.len };
        const end = { x: s.x0 + ((s.x1 - s.x0) * u1) / s.len, z: s.z0 + ((s.z1 - s.z0) * u1) / s.len };

        // Every facade gets its own UV phase. UVs are generated from world position,
        // so without this two walls that meet at a corner — and two buildings that
        // share a recipe — show the identical crack in the identical place, which is
        // the single most obvious "one texture, tiled" tell on a large flat surface.
        // The offset is constant across one wall run, so the wall itself stays
        // continuous and only the corner reads as a different patch of render.
        const ph = hash3(Math.round(x0 * 3) + side, Math.round(z0 * 3), k + 1);
        const ph2 = hash3(Math.round(z0 * 3) - side, Math.round(x0 * 3), k + 7);
        bat.uvOffset = [ph * 6.37, ph2 * 4.91];

        // Three material zones on every facade, which is what stops a wall reading
        // as one extruded rectangle: a protruding plinth at splash-back height, a
        // string course on every intermediate floor line, and the cornice on top.
        const isTop = li === levels.length - 1;
        const band =
          def.stringCourse === false
            ? null
            : def.stringCourse || { h: 0.15, out: 0.07, mat: 'struct.concreteClean' };
        wallRun(bat, {
          x0: start.x,
          z0: start.z,
          x1: end.x,
          z1: end.z,
          y0,
          y1,
          thick: t,
          mat,
          inner: def.inner || null,
          openings: blocked.concat(wins),
          plinth: li === 0 ? def.plinth : null,
          cornice: isTop ? def.cornice : band,
          glassMat: 'glass.window',
          windowStyle: null,
        });
      }
      bat.uvOffset = [0, 0];
      // Vertical joint pilasters between shop units read as separate buildings.
      if (isSplitSide && nSeg > 1) {
        for (let k = 1; k < nSeg; k++) {
          const p = sidePoint(rect, side, t, k * segLen, t * 0.5 + 0.03);
          bat.b('struct.concreteClean').box([p.x, (y0 + y1) * 0.5, p.z], [0.16, (y1 - y0) * 0.5, 0.16], {
            chamfer: 0.02,
          });
        }
      }
    }
  }

  /* ── roof ────────────────────────────────────────────────────────────── */
  const roof = def.roof || { kind: 'flat' };
  let roofY = top;
  if (roof.kind === 'pitch') {
    roofY = pitchedRoof(bat, { x0, z0, x1, z1 }, top, roof.pitch ?? 0.34, { mat: roof.mat || 'roof.shingle' });
  } else if (roof.kind === 'corrugated') {
    const deck = roofDeck(bat, { x0, z0, x1, z1 }, top + 0.32, { mat: roof.deck || 'roof.corrugated', fall: 0.55 });
    if (roof.parapet) parapet(bat, { x0, z0, x1, z1 }, top, roof.parapet, { mat: def.wall });
    roofY = deck.y;
  } else if (roof.kind !== 'none') {
    const deck = roofDeck(bat, { x0, z0, x1, z1 }, top, { mat: roof.deck || 'struct.concrete', inset: t * 0.5 });
    const gap = roofStairGap(def, deck.y);
    parapet(bat, { x0, z0, x1, z1 }, top, roof.parapet ?? 0.9, {
      mat: def.wall,
      copeMat: 'struct.concreteClean',
      thick: Math.min(0.28, t * 0.7),
      gaps: gap ? [gap] : [],
    });
    roofY = deck.y;
  }
  if (roof.clutter) roofClutter(bat, { x0: x0 + 1.4, z0: z0 + 1.4, x1: x1 - 1.4, z1: z1 - 1.4 }, roofY, rng, { count: roof.clutter });

  /* ── hung details ────────────────────────────────────────────────────── */
  for (const b of def.balconies || []) {
    const y = ys[b.level ?? 1];
    const s = sideLine(rect, b.side, t);
    const p = sidePoint(rect, b.side, t, b.u, t * 0.5);
    balcony(bat, {
      x: p.x,
      z: p.z,
      y: y + 0.06,
      yaw: s.yaw,
      width: b.width ?? 2.7,
      depth: b.depth ?? 1.2,
      railStyle: (b.level ?? 1) % 2 ? 'baluster' : null,
      railMat: hash2(Math.round(p.x), Math.round(p.z)) > 0.5 ? 'metal.rust' : 'metal.paintGreen',
    });
  }
  for (const a of def.awnings || []) {
    const s = sideLine(rect, a.side, t);
    const p = sidePoint(rect, a.side, t, a.u, t * 0.5);
    awning(bat, {
      x: p.x,
      z: p.z,
      y: base + (a.y ?? 3.05),
      yaw: s.yaw,
      width: a.width ?? 3.2,
      depth: a.depth ?? 1.4,
      mat: hash2(Math.round(p.x * 2), Math.round(p.z * 2)) > 0.5 ? 'fabric.awning' : 'fabric.awning2',
    });
  }
  for (const g of def.signs || []) {
    const s = sideLine(rect, g.side, t);
    const p = sidePoint(rect, g.side, t, g.u, t * 0.5 + 0.09);
    signBoard(bat, p.x, base + g.y, p.z, s.yaw, g.w, g.h, {});
  }

  // Downpipes at three corners plus a hopper — instant vertical rust streaks.
  const corners = [
    [x0 + 0.28, z0 + 0.28, -1, -1],
    [x1 - 0.28, z0 + 0.28, 1, -1],
    [x0 + 0.28, z1 - 0.28, -1, 1],
    [x1 - 0.28, z1 - 0.28, 1, 1],
  ];
  for (let i = 0; i < corners.length; i++) {
    if (hash3(Math.round(x0), Math.round(z0), i) < 0.35) continue;
    const [cx, cz, sx, sz] = corners[i];
    addDownpipe(bat, cx + sx * 0.09, cz + sz * 0.09, base + 0.02, top - 0.1, sx * 0.7, sz * 0.7, i % 2 ? 'metal.galv' : 'metal.rust');
  }

  if (def.roofStair) buildRoofStair(bat, def, ys, roofY);
  if (def.fireEscape) buildFireEscape(bat, def, ys, roofY);
  if (def.interior === 'market') buildMarketInterior(bat, def, ys, roofY, rng);
  if (def.interior === 'garage') buildGarageInterior(bat, def, ys, rng);

  /* ── LOD 1 shell ─────────────────────────────────────────────────────── */
  bat.lod = 1;
  const shellMat = unitWalls[0] || def.wall;
  bat.b(shellMat).box(
    [(x0 + x1) * 0.5, (base + top) * 0.5, (z0 + z1) * 0.5],
    [(x1 - x0) * 0.5, (top - base) * 0.5, (z1 - z0) * 0.5],
    { chamfer: 0.05 }
  );
  if (units > 1 && unitWalls[1]) {
    // Two-tone shell so a terrace still reads as separate buildings at distance.
    const half = unitAxis === 'x' ? [(x0 + x1 * 3) / 4, (z0 + z1) * 0.5] : [(x0 + x1) * 0.5, (z0 + z1 * 3) / 4];
    bat
      .b(unitWalls[1])
      .box(
        [half[0], (base + top) * 0.5, half[1]],
        unitAxis === 'x'
          ? [(x1 - x0) * 0.25 + 0.01, (top - base) * 0.5 + 0.01, (z1 - z0) * 0.5 + 0.01]
          : [(x1 - x0) * 0.5 + 0.01, (top - base) * 0.5 + 0.01, (z1 - z0) * 0.25 + 0.01],
        { chamfer: 0.05 }
      );
  }
  if (roof.kind === 'pitch') {
    pitchedRoof(bat, { x0, z0, x1, z1 }, top, roof.pitch ?? 0.34, { mat: roof.mat || 'roof.shingle', overhang: 0.3 });
  } else if (roof.kind !== 'none') {
    bat
      .b(roof.deck || 'struct.concrete')
      .box([(x0 + x1) * 0.5, top + 0.1, (z0 + z1) * 0.5], [(x1 - x0) * 0.5, 0.14, (z1 - z0) * 0.5], { chamfer: 0.03 });
    const ph = roof.parapet ?? 0.9;
    if (ph > 0.1) {
      const pm = bat.b(shellMat);
      pm.box([(x0 + x1) * 0.5, top + ph * 0.5, z0 + 0.15], [(x1 - x0) * 0.5, ph * 0.5, 0.15], { chamfer: 0.03 });
      pm.box([(x0 + x1) * 0.5, top + ph * 0.5, z1 - 0.15], [(x1 - x0) * 0.5, ph * 0.5, 0.15], { chamfer: 0.03 });
      pm.box([x0 + 0.15, top + ph * 0.5, (z0 + z1) * 0.5], [0.15, ph * 0.5, (z1 - z0) * 0.5], { chamfer: 0.03 });
      pm.box([x1 - 0.15, top + ph * 0.5, (z0 + z1) * 0.5], [0.15, ph * 0.5, (z1 - z0) * 0.5], { chamfer: 0.03 });
    }
  }

  /* ── LOD 2 silhouette ────────────────────────────────────────────────── */
  // Beyond ~130 m the only thing that survives is the outline against the sky, so
  // this is one box per building in one material: the whole far half of the map
  // collapses to a handful of draw calls.
  bat.lod = 2;
  {
    const ph = roof.kind === 'pitch' ? 0 : (roof.parapet ?? 0.9) * 0.6;
    bat
      .b(shellMat)
      .box(
        [(x0 + x1) * 0.5, (base + top + ph) * 0.5, (z0 + z1) * 0.5],
        [(x1 - x0) * 0.5, (top + ph - base) * 0.5, (z1 - z0) * 0.5],
        { chamfer: 0.08 }
      );
    if (roof.kind === 'pitch') {
      pitchedRoof(bat, { x0, z0, x1, z1 }, top, roof.pitch ?? 0.34, {
        mat: roof.mat || 'roof.shingle',
        overhang: 0.2,
      });
    }
  }
  bat.lod = 0;

  return { rect, top, ys, roofY };
}

/* ------------------------------------------------------------------ ruins */

function buildRuin(bat, def, rng) {
  const [x0, z0, x1, z1] = def.rect;
  const t = def.thick ?? 0.42;
  const full = def.levels[0];
  for (let side = 0; side < 4; side++) {
    const s = sideLine(def.rect, side, t);
    const segs = Math.max(2, Math.round(s.len / 3.4));
    for (let k = 0; k < segs; k++) {
      const u0 = (s.len * k) / segs;
      const u1 = (s.len * (k + 1)) / segs;
      const r = hash3(Math.round(x0) + side, k, 3);
      if (r < 0.18) continue; // wall gone entirely
      const h = lerp(1.1, full + 0.7, r);
      const a = { x: s.x0 + ((s.x1 - s.x0) * u0) / s.len, z: s.z0 + ((s.z1 - s.z0) * u0) / s.len };
      const b = { x: s.x0 + ((s.x1 - s.x0) * u1) / s.len, z: s.z0 + ((s.z1 - s.z0) * u1) / s.len };
      wallRun(bat, {
        x0: a.x,
        z0: a.z,
        x1: b.x,
        z1: b.z,
        y0: def.base ?? 0,
        y1: (def.base ?? 0) + h,
        thick: t,
        mat: def.wall,
        openings: h > 2.6 ? [{ u: (u1 - u0) * 0.5, w: 1.3, h: 1.6, sill: 1.0, type: 'window', style: 'broken' }] : [],
        plinth: def.plinth,
        cornice: null,
      });
      // Ragged broken top: a few loose bricks left standing.
      const mb = bat.b(def.wall);
      const ux = (b.x - a.x) / (u1 - u0 || 1);
      const uz = (b.z - a.z) / (u1 - u0 || 1);
      for (let i = 0; i < 4; i++) {
        const f = (i + 0.5) / 4;
        const px = a.x + ux * (u1 - u0) * f;
        const pz = a.z + uz * (u1 - u0) * f;
        const hh = 0.07 + hash3(Math.round(px * 3), Math.round(pz * 3), i) * 0.22;
        mb.box([px, (def.base ?? 0) + h + hh * 0.5, pz], [0.3, hh * 0.5, t * 0.5 - 0.02], { chamfer: 0.02 });
      }
      // Exposed rebar, bent.
      if (r > 0.7) {
        const rb = bat.b('metal.rust');
        for (let i = 0; i < 3; i++) {
          const f = (i + 1) / 4;
          const px = a.x + ux * (u1 - u0) * f;
          const pz = a.z + uz * (u1 - u0) * f;
          rb.cylinder(
            [px, (def.base ?? 0) + h - 0.15, pz],
            [px + (rng() - 0.5) * 0.4, (def.base ?? 0) + h + 0.5 + rng() * 0.35, pz + (rng() - 0.5) * 0.4],
            0.012,
            5
          );
        }
      }
    }
  }
  // Collapsed floor slab, rubble piles and a burnt-out interior.
  const rb = bat.b('ground.rubble');
  for (let i = 0; i < 14; i++) {
    const px = lerp(x0 + 1, x1 - 1, rng());
    const pz = lerp(z0 + 1, z1 - 1, rng());
    const sx = 0.6 + rng() * 1.7;
    const sz = 0.6 + rng() * 1.7;
    const h = 0.18 + rng() * 0.75;
    rb.box([px, (def.base ?? 0) + h * 0.5, pz], [sx * 0.5, h * 0.5, sz * 0.5], { chamfer: 0.09 });
    bat.box(px, (def.base ?? 0) + h * 0.5, pz, sx * 0.5, h * 0.5, sz * 0.5, 'concrete');
  }
  const slab = bat.b('struct.concrete');
  slab.box([(x0 + x1) * 0.5, (def.base ?? 0) - 0.1, (z0 + z1) * 0.5], [(x1 - x0) * 0.5, 0.15, (z1 - z0) * 0.5], {
    chamfer: 0.02,
  });
  bat.box((x0 + x1) * 0.5, (def.base ?? 0) - 0.1, (z0 + z1) * 0.5, (x1 - x0) * 0.5, 0.15, (z1 - z0) * 0.5, 'concrete');

  bat.lod = 1;
  bat.b(def.wall).box(
    [(x0 + x1) * 0.5, (def.base ?? 0) + full * 0.35, (z0 + z1) * 0.5],
    [(x1 - x0) * 0.5, full * 0.35, (z1 - z0) * 0.5],
    { chamfer: 0.06 }
  );
  bat.lod = 0;
}

/* ------------------------------------------------------- vertical access */

/**
 * External roof stair: one straight service flight running *along* the facade, a top
 * landing that bridges the parapet, and a gap cut in the parapet where it lands.
 *
 * It has to run along the wall, not out from it: a flight perpendicular to the facade
 * needs 14 m of clear ground, and the buildings that carry one front a 4 m alley.
 * `roofStairGap()` returns the parapet gap so the caller can pass it to `parapet()`.
 */
const RSTAIR = { rise: 0.19, run: 0.263, width: 1.15, pad: 1.5 }; // 35.8 deg service stair

/** Where the flight starts and ends along its facade — shared by the geometry and the gap. */
function roofStairSpan(def, roofY) {
  const t = def.thick ?? 0.4;
  const s = sideLine(def.rect, def.roofStair.side, t);
  const steps = Math.max(6, Math.round(Math.max(1, roofY - (def.base ?? 0)) / RSTAIR.rise));
  const L = steps * RSTAIR.run;
  const u0 = clamp(def.roofStair.u, 0.5, Math.max(0.5, s.len - L - RSTAIR.pad));
  return { s, steps, L, u0, uTop: Math.min(s.len - 0.8, u0 + L + 0.75) };
}

function buildRoofStair(bat, def, ys, roofY) {
  const t = def.thick ?? 0.4;
  const side = def.roofStair.side;
  const base = def.base ?? 0;
  const { rise, run, width } = RSTAIR;
  const { s, steps, L, u0, uTop } = roofStairSpan(def, roofY);
  const off = t * 0.5 + 0.08 + width * 0.5;
  const p = sidePoint(def.rect, side, t, u0, off);
  const yawAlong = Math.atan2(-(s.z1 - s.z0), s.x1 - s.x0);

  const flight = stairs(bat, {
    x: p.x,
    y: base,
    z: p.z,
    yaw: yawAlong,
    width,
    steps,
    rise,
    run,
    mat: 'struct.concrete',
    nosingMat: 'struct.concreteClean',
    railing: 'right',
    railMat: 'metal.rust',
  });

  // Top landing: from the head of the flight back across the parapet line onto the
  // deck, so the last step actually delivers you somewhere.
  const deck = sidePoint(def.rect, side, t, uTop, -t * 0.5 - 0.55);
  const land = sidePoint(def.rect, side, t, uTop, off * 0.2);
  const lm = bat.b('struct.concrete');
  lm.box([(deck.x + land.x) * 0.5, roofY - 0.1, (deck.z + land.z) * 0.5], [
    Math.abs(deck.x - land.x) * 0.5 + width * 0.5,
    0.1,
    Math.abs(deck.z - land.z) * 0.5 + width * 0.5,
  ], { chamfer: 0.02 });
  bat.box(
    (deck.x + land.x) * 0.5,
    roofY - 0.1,
    (deck.z + land.z) * 0.5,
    Math.abs(deck.x - land.x) * 0.5 + width * 0.5,
    0.14,
    Math.abs(deck.z - land.z) * 0.5 + width * 0.5,
    'concrete'
  );
  // Guard rail across the outboard edge of the landing.
  const g0 = sidePoint(def.rect, side, t, Math.min(s.len - 0.2, uTop + 0.7), off + width * 0.5);
  const g1 = sidePoint(def.rect, side, t, Math.min(s.len - 0.2, uTop + 0.7), -t * 0.5 - 0.4);
  railing(bat, g0.x, g0.z, g1.x, g1.z, roofY, { height: 1.05, mat: 'metal.rust' });
  void ys;
  void L;
  return { flight, uTop };
}

/** The parapet span the roof stair lands through, in `parapet()`'s own side/u frame. */
function roofStairGap(def, roofY) {
  if (!def.roofStair) return null;
  const { uTop } = roofStairSpan(def, roofY);
  // parapet() walks its own ring: 0 = z0 edge, 1 = x1, 2 = z1, 3 = x0, and every one
  // of them runs opposite to the matching sideLine, hence `full - u`.
  const side = def.roofStair.side;
  const parSide = [2, 1, 0, 3][side];
  const full = side === 0 || side === 2 ? def.rect[2] - def.rect[0] : def.rect[3] - def.rect[1];
  const uc = full - uTop;
  return { side: parSide, u0: uc - 1.1, u1: uc + 1.1 };
}

function buildFireEscape(bat, def, ys, roofY) {
  const t = def.thick ?? 0.4;
  const side = def.fireEscape.side;
  const s = sideLine(def.rect, side, t);
  const u = def.fireEscape.u;
  for (let li = 1; li < ys.length; li++) {
    const y = ys[li];
    const p = sidePoint(def.rect, side, t, u, t * 0.5 + 0.85);
    const pl = bat.b('metal.rust');
    const cs = Math.cos(s.yaw);
    const sn = Math.sin(s.yaw);
    // Grated platform.
    for (let i = 0; i < 7; i++) {
      const o = -0.85 + i * 0.28;
      pl.box([p.x + o * cs, y - 0.05, p.z - o * sn], [0.055, 0.025, 0.85], { chamfer: 0.006 });
    }
    pl.box([p.x, y - 0.12, p.z], [1.05, 0.05, 0.9], { chamfer: 0.01 });
    bat.box(p.x, y - 0.09, p.z, 1.05, 0.09, 0.9, 'metal');
    const a = { x: p.x - cs * 1.0 - sn * 0.85, z: p.z + sn * 1.0 - cs * 0.85 };
    const b = { x: p.x + cs * 1.0 - sn * 0.85, z: p.z - sn * 1.0 - cs * 0.85 };
    railing(bat, a.x, a.z, b.x, b.z, y, { height: 1.05, mat: 'metal.rust' });
    // Ladder down to the platform below (or the street).
    const yPrev = ys[li - 1];
    ladder(bat, p.x + cs * 0.75, p.z - sn * 0.75, yPrev, y + 0.9, s.nx, s.nz, { offset: 0.55, mat: 'metal.rust' });
  }
  const pTop = sidePoint(def.rect, side, t, u, t * 0.5 + 0.6);
  ladder(bat, pTop.x, pTop.z, ys[ys.length - 1] - 0.4, roofY + 0.9, s.nx, s.nz, { offset: 0.35, mat: 'metal.rust' });
}

/* ---------------------------------------------------------------- interiors */

/**
 * The Market Hall. Two storeys, a colonnaded ground floor, a mezzanine over the west
 * half, two stair cores and roof access — the map's contested centre, built so it has
 * four ways in, two ways up and no single angle that covers all of them.
 */
function buildMarketInterior(bat, def, ys, roofY, rng) {
  const [x0, z0, x1, z1] = def.rect;
  const t = def.thick ?? 0.5;
  const g = ys[0];
  const mez = ys[1];

  // Column grid. The east range stands in the double-height void, so those columns
  // run the full height to the roof beam — stopping them at the (missing) first
  // floor would leave a column ending in mid-air right down the interior sight line.
  const colX = [x0 + 4.6, x0 + 13.2];
  const colZ = [z0 + 4.4, z0 + 11.8, z0 + 19.2];
  const voidX0 = def.floorVoid ? def.floorVoid.rect[0] : Infinity;
  for (const cx of colX) {
    const tall = cx > voidX0;
    for (const cz of colZ) {
      addPillar(bat, cx, cz, g, tall ? roofY - 0.34 : mez - 0.28, tall ? 0.68 : 0.62, {
        mat: 'struct.concreteClean',
        round: true,
        segments: 14,
      });
    }
  }
  // A transfer beam across the heads of the tall columns, so the roof visibly lands
  // on something instead of floating over an eight-metre room.
  if (def.floorVoid) {
    const bm = bat.b('struct.concreteClean');
    bm.box([x0 + 13.2, roofY - 0.5, (z0 + z1) * 0.5], [0.3, 0.34, (z1 - z0) * 0.5 - t], { chamfer: 0.025 });
  }
  // Upper-floor columns, thinner.
  for (const cx of colX) {
    for (const cz of colZ) {
      if (cx > x0 + 9) continue;
      addPillar(bat, cx, cz, mez, ys[2] - 0.26, 0.46, { mat: 'struct.concreteClean' });
    }
  }

  // The first floor is cut away over the east half (see `floorVoid` in LevelData),
  // so the deck that survives over the west half IS the mezzanine — it does not need
  // a second slab of its own, which is what used to sit here z-fighting the real one.
  // All that is added is a tiled finish over the concrete and the edge nosing.
  const mx1 = x0 + 9.2;
  bat.b('int.tile').box([(x0 + mx1) * 0.5, mez - 0.005, (z0 + z1) * 0.5], [(mx1 - x0) * 0.5 - 0.02, 0.02, (z1 - z0) * 0.5 - t * 0.45], {
    chamfer: 0.01,
  });

  // Stair core: ground -> mezzanine, tucked against the north wall.
  const f1 = stairs(bat, {
    x: x0 + 1.6,
    y: g,
    z: z0 + 2.0,
    yaw: -Math.PI / 2,
    width: 1.5,
    steps: Math.round((mez - g) / 0.185),
    rise: 0.185,
    run: 0.3,
    mat: 'struct.concreteClean',
    railing: 'left',
  });
  void f1;
  // Second flight: mezzanine -> roof hatch, in the south-west corner.
  const f2 = stairs(bat, {
    x: x0 + 1.6,
    y: mez,
    z: z1 - 2.0,
    yaw: Math.PI / 2,
    width: 1.4,
    steps: Math.round((roofY - mez) / 0.185),
    rise: 0.185,
    run: 0.3,
    mat: 'struct.concreteClean',
    railing: 'right',
  });
  // Roof hatch housing.
  bat.b('brick.buff').box([f2.topX, roofY + 0.6, f2.topZ - 0.9], [1.1, 0.6, 1.4], { chamfer: 0.03 });
  bat.box(f2.topX, roofY + 0.6, f2.topZ - 0.9, 1.1, 0.6, 1.4, 'concrete');

  // Roof lantern over the main hall — the light shaft the interior pose is composed on.
  const lx = (mx1 + x1) * 0.5;
  const lz = (z0 + z1) * 0.5;
  bat.b('struct.concreteClean').box([lx, roofY + 0.55, lz], [3.1, 0.55, 5.6], { chamfer: 0.03 });
  bat.b('glass.window').box([lx, roofY + 1.16, lz], [2.9, 0.05, 5.4], { chamfer: 0.02 });
  for (let i = -2; i <= 2; i++) {
    bat.b('metal.paintCream').box([lx, roofY + 1.2, lz + i * 2.1], [3.0, 0.06, 0.07], { chamfer: 0.012 });
  }

  // Market counters — waist-high cover inside the hall.
  for (let i = 0; i < 5; i++) {
    const cx = lerp(mx1 + 1.4, x1 - 2.4, rng());
    const cz = lerp(z0 + 2.4, z1 - 2.4, rng());
    const yaw = rng() > 0.5 ? 0 : Math.PI / 2;
    lowWall(bat, cx - Math.cos(yaw) * 1.3, cz + Math.sin(yaw) * 1.3, cx + Math.cos(yaw) * 1.3, cz - Math.sin(yaw) * 1.3, g, g + 0.92, 0.5, 'int.tile', {
      copingMat: 'wood.weathered',
    });
  }
  crateStack(bat, x1 - 2.2, z0 + 3.4, g, g + 1.9, 0.3, rng);
}

function buildGarageInterior(bat, def, ys, rng) {
  const [x0, z0, x1, z1] = def.rect;
  const g = ys[0];
  // Mezzanine office platform along the north wall.
  const my = g + 3.1;
  bat.b('wood.ply').box([(x0 + x1) * 0.5, my - 0.12, z0 + 2.6], [(x1 - x0) * 0.5 - 0.9, 0.12, 2.2], { chamfer: 0.02 });
  bat.box((x0 + x1) * 0.5, my - 0.14, z0 + 2.6, (x1 - x0) * 0.5 - 0.9, 0.16, 2.2, 'wood');
  railing(bat, x0 + 1.0, z0 + 4.8, x1 - 1.0, z0 + 4.8, my, { height: 1.02, mat: 'metal.rust' });
  for (let i = 0; i < 4; i++) {
    const px = lerp(x0 + 1.4, x1 - 1.4, i / 3);
    bat.b('metal.rust').cylinder([px, g, z0 + 4.6], [px, my - 0.12, z0 + 4.6], 0.06, 8);
  }
  stairs(bat, {
    x: x1 - 2.2,
    y: g,
    z: z0 + 5.4,
    yaw: Math.PI / 2,
    width: 1.1,
    steps: Math.round((my - g) / 0.19),
    rise: 0.19,
    run: 0.28,
    mat: 'metal.rust',
    nosingMat: 'metal.galv',
    railing: 'left',
    surface: 'metal',
  });
  // Inspection pit and a workbench run.
  bat.b('struct.concrete').box([(x0 + x1) * 0.5 + 1.5, g - 0.5, (z0 + z1) * 0.5 + 2], [1.1, 0.5, 3.2], { chamfer: 0.03 });
  lowWall(bat, x0 + 0.9, z1 - 1.4, x1 - 5.0, z1 - 1.4, g, g + 0.94, 0.62, 'wood.weathered', { copingMat: 'metal.galv' });
  for (let i = 0; i < 3; i++) {
    crate(bat, lerp(x0 + 2, x1 - 3, rng()), g, lerp(z0 + 7, z1 - 3, rng()), 0.9, 0.85, 0.9, rng() * 3, {
      mat: rng() > 0.5 ? 'wood.weathered' : 'wood.ply',
    });
  }
}

/* --------------------------------------------------------------- specials */

/** The minaret: tapering shaft, corbelled gallery, lantern and cap. A true landmark. */
export function buildMinaret(bat, m) {
  const { x, z, base, radius, height, galleryY, capY } = m;
  bat.b('wall.bone').box([x, base + 0.9, z], [radius + 0.5, 0.9, radius + 0.5], { chamfer: 0.04 });
  bat.box(x, base + 0.9, z, radius + 0.5, 0.9, radius + 0.5, 'concrete');
  // Octagonal tapering shaft, built as stacked prisms so it has real facets.
  const seg = 8;
  const rings = 7;
  const mb = bat.b('wall.sand');
  const ringPts = (y, r) => {
    const out = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2 + Math.PI / 8;
      out.push([x + Math.cos(a) * r, y, z + Math.sin(a) * r]);
    }
    return out;
  };
  for (let i = 0; i < rings; i++) {
    const y0 = lerp(base + 1.8, galleryY, i / rings);
    const y1 = lerp(base + 1.8, galleryY, (i + 1) / rings);
    const r0 = lerp(radius, radius * 0.72, i / rings);
    const r1 = lerp(radius, radius * 0.72, (i + 1) / rings);
    mb.prism(ringPts(y0, r0), ringPts(y1, r1), { cap: false });
    // String course between drums.
    if (i % 2 === 1) {
      bat.b('struct.concreteClean').prism(ringPts(y1 - 0.09, r1 + 0.11), ringPts(y1 + 0.03, r1 + 0.07), { cap: false });
    }
  }
  // Gallery: corbel, deck, balustrade.
  bat.b('struct.concreteClean').prism(ringPts(galleryY - 0.4, radius * 0.78), ringPts(galleryY, radius * 1.5), { cap: true });
  const gp = ringPts(galleryY, radius * 1.42);
  for (let i = 0; i < seg; i++) {
    const a = gp[i];
    const b = gp[(i + 1) % seg];
    railing(bat, a[0], a[2], b[0], b[2], galleryY, { height: 0.95, mat: 'metal.rust', style: 'baluster', collide: false });
  }
  bat.box(x, galleryY + 0.5, z, radius * 1.5, 0.5, radius * 1.5, 'concrete');
  // Upper drum and cap.
  const mb2 = bat.b('wall.bone');
  mb2.prism(ringPts(galleryY, radius * 0.66), ringPts(capY - 1.6, radius * 0.58), { cap: false });
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2 + Math.PI / 8;
    const px = x + Math.cos(a) * radius * 0.62;
    const pz = z + Math.sin(a) * radius * 0.62;
    mb2.box([px, galleryY + 1.5, pz], [0.22, 0.75, 0.22], { chamfer: 0.02 });
  }
  bat.b('roof.shingle').cylinder([x, capY - 1.6, z], [x, capY, z], radius * 0.72, 10, { radius2: 0.06 });
  bat.b('metal.galv').cylinder([x, capY, z], [x, capY + 0.9, z], 0.055, 6);
  bat.box(x, base + height * 0.5, z, radius * 0.85, height * 0.5, radius * 0.85, 'concrete');

  // The minaret is the map's orientation landmark; it has to survive to the far LOD
  // or it pops out of the skyline from the opposite corner.
  for (const l of [1, 2]) {
    bat.lod = l;
    bat.b('wall.sand').cylinder([x, base, z], [x, galleryY, z], radius * 0.92, l === 1 ? 8 : 6, { radius2: radius * 0.7 });
    bat.b('wall.bone').cylinder([x, galleryY, z], [x, capY, z], radius * 0.66, l === 1 ? 8 : 6, { radius2: radius * 0.2 });
  }
  bat.lod = 0;
}

/**
 * Fuel station: a steel canopy on four columns (its deck is a reachable vantage point
 * over the north end of Souk Street), two pump islands and a kiosk. This is the
 * landmark that terminates the main lane's long shot.
 */
export function buildFuelStation(bat, f, rng) {
  const c = f.canopy;
  canopy(bat, {
    x0: c.x0,
    z0: c.z0,
    x1: c.x1,
    z1: c.z1,
    y: c.y,
    thick: c.thick,
    baseY: 0,
    mat: 'metal.paintCream',
    fasciaMat: 'metal.paintRed',
    columns: [
      [c.x0 + 1.6, c.z0 + 1.6],
      [c.x1 - 1.6, c.z0 + 1.6],
      [c.x0 + 1.6, c.z1 - 1.6],
      [c.x1 - 1.6, c.z1 - 1.6],
    ],
  });
  // Pump islands: kerbed plinth, two dispensers, a bollard at each end.
  for (const [px, pz] of f.pumpIslands) {
    bat.b('struct.concreteClean').box([px, 0.11, pz], [0.75, 0.11, 2.6], { chamfer: 0.025 });
    bat.box(px, 0.11, pz, 0.75, 0.13, 2.6, 'concrete');
    for (const s of [-1, 1]) {
      bat.b('metal.paintRed').box([px, 0.22 + 0.72, pz + s * 1.1], [0.32, 0.72, 0.42], { chamfer: 0.03 });
      bat.b('metal.galv').box([px, 0.22 + 1.5, pz + s * 1.1], [0.34, 0.08, 0.44], { chamfer: 0.02 });
      bat.b('sign.lit').quad(
        [px - 0.24, 1.0, pz + s * 1.1 + 0.425],
        [px + 0.24, 1.0, pz + s * 1.1 + 0.425],
        [px + 0.24, 1.34, pz + s * 1.1 + 0.425],
        [px - 0.24, 1.34, pz + s * 1.1 + 0.425],
        [0, 0, 1]
      );
      bat.box(px, 0.94, pz + s * 1.1, 0.34, 0.72, 0.44, 'metal');
    }
  }
  // Kiosk.
  const k = f.kiosk.rect;
  const kh = f.kiosk.h;
  for (let side = 0; side < 4; side++) {
    const s = sideLine(k, side, 0.32);
    wallRun(bat, {
      x0: s.x0,
      z0: s.z0,
      x1: s.x1,
      z1: s.z1,
      y0: 0,
      y1: kh,
      thick: 0.32,
      mat: 'wall.bone',
      openings:
        side === 3
          ? [{ u: 2.6, w: 2.2, h: 1.5, sill: 1.0, type: 'window', style: 'glazed' }]
          : side === 0
            ? [{ u: 2.4, w: 1.1, h: 2.2, sill: 0, type: 'door' }]
            : [],
      plinth: { h: 0.7, mat: 'struct.concrete', out: 0.04 },
      cornice: { h: 0.2, out: 0.11 },
    });
  }
  roofDeck(bat, { x0: k[0], z0: k[1], x1: k[2], z1: k[3] }, kh, { mat: 'roof.corrugatedRust', fall: 0.2 });
  parapet(bat, { x0: k[0], z0: k[1], x1: k[2], z1: k[3] }, kh, 0.42, { mat: 'wall.bone', thick: 0.22 });
  bat.b('int.tile').box([(k[0] + k[2]) * 0.5, 0.03, (k[1] + k[3]) * 0.5], [(k[2] - k[0]) * 0.5, 0.06, (k[3] - k[1]) * 0.5], {
    chamfer: 0.01,
  });
  // The climb: crates on the forecourt to 2.7 m (mantle onto the 3.2 m kiosk roof),
  // then a pallet stack on that roof to 4.3 m, which puts the 5.28 m canopy deck one
  // mantle away. Both steps are ~1 m, which is what the movement code can take.
  crateStack(bat, k[0] - 1.4, k[1] + 1.2, 0, 2.7, 0.2, rng);
  crateStack(bat, k[0] + 1.6, k[3] - 1.4, kh + 0.05, kh + 1.15, -0.35, rng);
  bat.lod = 1;
  bat.b('metal.paintCream').box(
    [(c.x0 + c.x1) * 0.5, c.y - c.thick * 0.5, (c.z0 + c.z1) * 0.5],
    [(c.x1 - c.x0) * 0.5, c.thick * 0.5, (c.z1 - c.z0) * 0.5],
    { chamfer: 0.04 }
  );
  bat.b('wall.bone').box([(k[0] + k[2]) * 0.5, kh * 0.5, (k[1] + k[3]) * 0.5], [(k[2] - k[0]) * 0.5, kh * 0.5, (k[3] - k[1]) * 0.5], {
    chamfer: 0.05,
  });
  bat.lod = 0;
}

/** A distant silhouette block: shell + parapet only, authored straight into LOD 2. */
export function buildBackdrop(bat, def) {
  const [x0, z0, x1, z1] = def.rect;
  const h = def.h;
  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;
  const hx = (x1 - x0) * 0.5;
  const hz = (z1 - z0) * 0.5;
  const seed = Math.round(x0 * 0.37 + z0 * 0.71);
  bat.lod = 0;
  // These blocks are 60-140 m out and 30 m wide. At 1:1 metre UVs the stucco tile
  // repeats every ~2.5 m across that face and reads as patterned wallpaper, which is
  // exactly what the eye picks up on a distant flat plane. Stretching the texture 3x
  // costs nothing here — none of that detail is resolvable at this range.
  bat.uvScale = 0.32;
  bat.uvOffset = [seed * 1.7, seed * 0.9];

  bat.b(def.wall).box([cx, h * 0.5, cz], [hx, h * 0.5, hz], { chamfer: 0.08 });
  bat.b('struct.concreteClean').box([cx, h + 0.35, cz], [hx + 0.12, 0.35, hz + 0.12], { chamfer: 0.05 });

  // A skyline is silhouette, and a row of identical rectangles is the one shape that
  // reads as scenery. Each block gets a setback tower, a stair housing and a couple
  // of tanks, all authored straight into the far LOD — a handful of boxes each, and
  // it is the difference between "a city behind the map" and "grey cardboard".
  const t1 = hash2(seed, 3);
  const t2 = hash2(seed + 11, 7);
  const t3 = hash2(seed + 23, 13);
  if (t1 > 0.28) {
    const sh = h * (0.22 + t1 * 0.38);
    const sx = hx * (0.42 + t2 * 0.26);
    const sz = hz * (0.42 + t3 * 0.26);
    const ox = (t2 - 0.5) * (hx - sx) * 1.4;
    const oz = (t3 - 0.5) * (hz - sz) * 1.4;
    bat.b(def.wall).box([cx + ox, h + sh * 0.5, cz + oz], [sx, sh * 0.5, sz], { chamfer: 0.08 });
    bat.b('struct.concreteClean').box([cx + ox, h + sh + 0.3, cz + oz], [sx + 0.14, 0.3, sz + 0.14], { chamfer: 0.05 });
  }
  // Stair / lift housing and water tanks on the main deck.
  bat.b('struct.concrete').box([cx - hx * 0.55, h + 1.5, cz + hz * 0.4], [1.9, 1.5, 1.8], { chamfer: 0.06 });
  const tk = bat.b('metal.galv');
  for (let i = 0; i < 3; i++) {
    const f = (i + 0.6) / 3.6;
    const tx = lerp(x0 + 2.5, x1 - 2.5, hash3(seed, i, 5));
    const tz = lerp(z0 + 2.5, z1 - 2.5, f);
    tk.cylinder([tx, h + 0.7, tz], [tx, h + 2.7, tz], 0.85 + hash3(seed, i, 9) * 0.4, 8);
    tk.box([tx, h + 0.35, tz], [1.0, 0.35, 1.0], { chamfer: 0.05 });
  }
  // Shallow pilaster ribs break the flat wall without costing a texture lookup.
  const rb = bat.b('struct.concreteClean');
  for (let x = x0 + 4; x < x1 - 2; x += 7.5) {
    rb.box([x, h * 0.5, z1 + 0.14], [0.5, h * 0.5, 0.16], { chamfer: 0.05 });
    rb.box([x, h * 0.5, z0 - 0.14], [0.5, h * 0.5, 0.16], { chamfer: 0.05 });
  }

  // Window rhythm as flat quads only — these blocks are 60-140 m out, where two
  // triangles per window is already more than the silhouette can resolve.
  const mb = bat.b('glass.window');
  for (let y = 2.6; y < h - 1.4; y += 3.2) {
    for (let x = x0 + 2.4; x < x1 - 1.8; x += 3.6) {
      mb.quad([x - 0.6, y - 0.8, z1 + 0.04], [x + 0.6, y - 0.8, z1 + 0.04], [x + 0.6, y + 0.8, z1 + 0.04], [x - 0.6, y + 0.8, z1 + 0.04], [0, 0, 1]);
      mb.quad([x - 0.6, y - 0.8, z0 - 0.04], [x - 0.6, y + 0.8, z0 - 0.04], [x + 0.6, y + 0.8, z0 - 0.04], [x + 0.6, y - 0.8, z0 - 0.04], [0, 0, -1]);
    }
  }
  bat.uvScale = 1;
  bat.uvOffset = [0, 0];
}

export default { buildBuilding, buildMinaret, buildFuelStation, buildBackdrop, sideLine, sidePoint };
