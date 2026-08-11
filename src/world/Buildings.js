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
import { ridgeAt } from './LevelData.js';
import { wallRun, addPillar, addDownpipe, lowWall } from './kit/Walls.js';
import { stairs, railing, ladder, crate, crateStack } from './kit/Stairs.js';
import { roofDeck, parapet, pitchedRoof, balcony, awning, canopy, roofClutter } from './kit/Roofs.js';
import { signBoard, marketStall } from './kit/Street.js';

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
        // The plinth, the string course and the cornice run *through* the unit joints,
        // so they take one phase for the whole side. Per-segment phase made the dado
        // band jump at every boundary, which reads as the band stepping in height.
        const bph = hash3(Math.round(x0 * 3) + side * 13, Math.round(z0 * 3) + side, 3);
        const bph2 = hash3(Math.round(z0 * 3) - side * 7, Math.round(x0 * 3), 11);
        const bandUv = [bph * 5.11, bph2 * 3.73];

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
          bandUv,
          // Shopfront glazing is its own palette key: a shop window is plate glass in
          // a steel frame, not the same dirty domestic pane, and giving it a distinct
          // material stops the glazing inheriting the wall's read entirely.
          glassMat: spec?.style === 'shop' ? 'glass.shop' : 'glass.window',
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
          // Matching rib on the inside face. Two paints meeting at a bare vertical
          // seam in the middle of a wall reads as a material assignment error; a
          // pilaster is what a real party wall junction actually looks like.
          if (def.inner) {
            const q = sidePoint(rect, side, t, k * segLen, -t * 0.5 - 0.035);
            bat.b('struct.concreteClean').box([q.x, (y0 + y1) * 0.5, q.z], [0.14, (y1 - y0) * 0.5, 0.14], {
              chamfer: 0.02,
            });
          }
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
  if (def.interior === 'shop') buildShopInterior(bat, def, ys, rng);

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
    const size = tall ? 0.68 : 0.62;
    const y1 = tall ? roofY - 0.34 : mez - 0.28;
    for (const cz of colZ) {
      // A column that meets a tile floor at a razor 90 degrees reads as an extruded
      // rectangle, not as a column. Two extra boxes — a stepped plinth and a flared
      // capital — are what turn it into architecture, and they are also what carries
      // the contact shadow at the floor junction.
      addPillar(bat, cx, cz, g, y1, size, {
        mat: 'struct.concreteClean',
        round: true,
        segments: 14,
        baseH: 0.34,
        capH: 0.3,
      });
      const pm = bat.b('struct.concrete');
      pm.box([cx, g + 0.08, cz], [size * 0.92, 0.08, size * 0.92], { chamfer: 0.03 }); // sub-plinth
      pm.box([cx, y1 - 0.36, cz], [size * 0.86, 0.06, size * 0.86], { chamfer: 0.025 }); // necking
      // Splash-back kick at the very bottom, which is what stops the razor line.
      bat.b('int.tile').box([cx, g + 0.02, cz], [size * 1.02, 0.02, size * 1.02], { chamfer: 0.01 });
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

  /* ── the hall is 30 x 25 m: it needs beams, fittings and real furniture ──── */

  // Roof joists spanning the double-height void, hung off the transfer beam. Without
  // them the ceiling is a flat plane wearing the exterior wall's crack texture.
  const jm = bat.b('wood.weathered');
  for (let i = 0; ; i++) {
    const jz = z0 + 2.2 + i * 1.9;
    if (jz > z1 - 2.2) break;
    jm.box([(mx1 + x1) * 0.5 + 0.6, roofY - 0.62, jz], [(x1 - mx1) * 0.5 - 0.3, 0.13, 0.07], { chamfer: 0.014 });
  }
  // Purlins the other way, and a run of pendant fittings down the middle of the hall.
  for (const px of [mx1 + 2.4, mx1 + 6.4]) {
    jm.box([px, roofY - 0.78, (z0 + z1) * 0.5], [0.08, 0.1, (z1 - z0) * 0.5 - 1.6], { chamfer: 0.014 });
  }
  for (let i = 0; i < 4; i++) {
    const lz = lerp(z0 + 4.5, z1 - 4.5, i / 3);
    const lx = (mx1 + x1) * 0.5 + 0.6;
    bat.b('metal.rust').cylinder([lx, roofY - 0.8, lz], [lx, roofY - 2.1, lz], 0.01, 4);
    bat.b('metal.paintGreen').cylinder([lx, roofY - 2.08, lz], [lx, roofY - 2.34, lz], 0.24, 10, { radius2: 0.07 });
    bat.b('sign.lit').cylinder([lx, roofY - 2.32, lz], [lx, roofY - 2.36, lz], 0.14, 8);
  }

  // Skirting round the hall so the tile floor does not meet the plaster at a razor.
  const sk = bat.b('struct.concrete');
  for (const [ax, az, bx, bz] of [
    [x0 + t, z0 + t, x1 - t, z0 + t],
    [x1 - t, z0 + t, x1 - t, z1 - t],
    [x1 - t, z1 - t, x0 + t, z1 - t],
    [x0 + t, z1 - t, x0 + t, z0 + t],
  ]) {
    sk.box([(ax + bx) * 0.5, g + 0.075, (az + bz) * 0.5], [Math.abs(bx - ax) * 0.5 + 0.04, 0.075, Math.abs(bz - az) * 0.5 + 0.04], {
      chamfer: 0.012,
    });
  }

  // Market counters. These used to be five bare `lowWall` runs in the floor tile
  // material — a literal blockout mass with no material identity, still in the frame.
  // `marketStall` is a real stall: steel frame, canvas canopy, timber counter, and it
  // gives the hall the silhouette a market is supposed to have.
  /*
   * Six of the same prefab at three scales, all empty, is a furniture showroom. Each
   * stall now names a frame `variant` (pipe canopy / lean-to / timber A-frame) and a
   * `goods` deck (which produce, whether it hangs textiles, which end the balance is
   * on) so no two read alike, and every one of them is *stocked* — see
   * kit/Street.js marketStall().
   */
  const stalls = [
    [mx1 + 2.2, z0 + 4.6, 0, 0, 0, 2.4, 1.5],
    [mx1 + 2.4, z0 + 10.4, 0, 2, 1, 2.7, 1.6],
    [mx1 + 2.3, z0 + 16.2, 0, 1, 2, 2.3, 1.45],
    [x1 - 3.4, z0 + 7.2, Math.PI, 1, 3, 2.5, 1.5],
    [x1 - 3.6, z0 + 13.6, Math.PI, 0, 2, 2.6, 1.7],
    [x1 - 3.5, z0 + 19.4, Math.PI, 2, 1, 2.4, 1.4],
  ];
  for (const [sx, sz, syaw, variant, goods, sw, sd] of stalls) {
    if (sx <= mx1 || sx >= x1 - 1.2) continue;
    marketStall(bat, sx, g, sz, syaw + (rng() - 0.5) * 0.12, {
      width: sw,
      depth: sd,
      height: 2.1 + rng() * 0.28,
      variant,
      goods,
    });
  }
  // Two plain trestle counters as low cover between the stalls — with stock on them.
  for (const [cx, cz, yaw] of [
    [(mx1 + x1) * 0.5 + 0.4, z0 + 7.8, Math.PI / 2],
    [(mx1 + x1) * 0.5 + 0.2, z0 + 17.0, Math.PI / 2],
  ]) {
    lowWall(bat, cx - Math.cos(yaw) * 1.4, cz + Math.sin(yaw) * 1.4, cx + Math.cos(yaw) * 1.4, cz - Math.sin(yaw) * 1.4, g, g + 0.92, 0.55, 'wood.weathered', {
      copingMat: 'struct.concreteClean',
    });
    for (let i = 0; i < 4; i++) {
      const t = (i + 0.5) / 4;
      const bx = cx - Math.cos(yaw) * 1.4 + Math.cos(yaw) * 2.8 * t;
      const bz = cz + Math.sin(yaw) * 1.4 - Math.sin(yaw) * 2.8 * t;
      const bh = 0.16 + rng() * 0.16;
      bat.b(rng() > 0.5 ? 'wood.ply' : 'struct.panelPale').box([bx, g + 0.96 + bh * 0.5, bz], [0.17, bh * 0.5, 0.15], { chamfer: 0.012 });
      bat.b(rng() > 0.5 ? 'veg.citrus' : 'veg.green').cylinder(
        [bx, g + 0.96 + bh, bz], [bx, g + 1.0 + bh, bz], 0.13, 8, { radius2: 0.06 }
      );
    }
  }
  crateStack(bat, x1 - 2.2, z0 + 3.4, g, g + 1.9, 0.3, rng);
  crateStack(bat, mx1 + 1.3, z1 - 3.0, g, g + 1.5, -0.25, rng);

  /*
   * Break the floor. An unbroken tile grid running wall to wall with a stain overlay
   * on top of it is the single loudest "this ground is a texture" tell there is, so
   * the tile is physically interrupted: a screed patch where tiles have gone, a worn
   * lane down the middle of the hall in a duller tile, a threshold band at each door
   * and a floor gully with a grate.
   */
  const hallCx = (mx1 + x1) * 0.5 + 0.6;
  bat.b('int.tileWorn').box([hallCx, g + 0.012, (z0 + z1) * 0.5], [(x1 - mx1) * 0.22, 0.012, (z1 - z0) * 0.42], { chamfer: 0.008 });
  for (const [px, pz, pw, pd] of [
    [mx1 + 3.4, z0 + 8.2, 1.5, 1.1],
    [x1 - 4.6, z0 + 16.0, 1.2, 1.6],
    [hallCx + 1.4, z1 - 4.2, 1.8, 1.2],
    /* The three metres of floor directly under the `interior` review camera at
       (-14.4, -3.2): the first capture showed an unbroken tile grid running away
       from the lens, which is the exact complaint. A lifted patch, a screeded
       repair and a broken course put the joint pattern in conflict with itself
       where the eye actually lands. */
    [x0 + 7.2, z1 - 3.4, 2.2, 1.5],
    [x0 + 4.4, z1 - 5.6, 1.4, 1.9],
    [x0 + 10.6, z1 - 6.4, 1.7, 1.2],
  ]) {
    bat.b('int.screed').box([px, g + 0.018, pz], [pw * 0.5, 0.018, pd * 0.5], { chamfer: 0.012 });
    /* a lip of broken tile round the patch */
    bat.b('int.tileWorn').box([px, g + 0.024, pz], [pw * 0.5 + 0.09, 0.008, pd * 0.5 + 0.09], { chamfer: 0.02 });
  }
  /* floor gully with a cast grate, running to the north door */
  const gz = z0 + 2.6;
  bat.b('int.screed').box([hallCx, g + 0.006, gz], [(x1 - mx1) * 0.34, 0.03, 0.16], { chamfer: 0.02 });
  for (let i = 0; i < 9; i++) {
    const gx = hallCx - (x1 - mx1) * 0.3 + i * ((x1 - mx1) * 0.6) / 8;
    bat.b('metal.rust').box([gx, g + 0.028, gz], [0.03, 0.014, 0.13], { chamfer: 0.004 });
  }
  /* threshold bands in worn stone at the two main doors */
  bat.b('struct.concreteClean').box([x0 + 9, g + 0.02, z1 - t - 0.35], [1.5, 0.02, 0.35], { chamfer: 0.012 });
  bat.b('struct.concreteClean').box([x0 + 5.5, g + 0.02, z0 + t + 0.35], [1.7, 0.02, 0.35], { chamfer: 0.012 });
}

/**
 * A row of shop units. The `weapon` review camera stands in the middle one, and until
 * now that was a bare box: three walls, three windows, a floor and a ceiling, with no
 * door, no trim, no skirting and no light fitting.
 *
 * What actually makes a room read as a room, in order of how much it buys:
 *   1. a **skirting** and a **dado rail**, so the wall/floor junction is not a razor;
 *   2. **ceiling joists**, so the ceiling is not one flat plane wearing a wall texture;
 *   3. a **pendant light** on a flex — the single element that says "interior";
 *   4. a partition with a door opening, so the space has depth beyond the near wall;
 *   5. a counter, shelving and stock.
 */
function buildShopInterior(bat, def, ys, rng) {
  const [x0, z0, x1, z1] = def.rect;
  const t = def.thick ?? 0.4;
  const g = ys[0];
  const ceil = ys[1];
  const ix0 = x0 + t;
  const ix1 = x1 - t;
  const iz0 = z0 + t;
  const iz1 = z1 - t;
  const units = Math.max(1, def.units || 1);
  const unitAxis = x1 - x0 >= z1 - z0 ? 'x' : 'z';

  /* ── skirting + dado rail all the way round ────────────────────────────── */
  const runs = [
    [ix0, iz0, ix1, iz0],
    [ix1, iz0, ix1, iz1],
    [ix1, iz1, ix0, iz1],
    [ix0, iz1, ix0, iz0],
  ];
  const sk = bat.b('wood.painted');
  const dd = bat.b('struct.concreteClean');
  for (const [ax, az, bx, bz] of runs) {
    const cx = (ax + bx) * 0.5;
    const cz = (az + bz) * 0.5;
    const hx = Math.max(0.03, Math.abs(bx - ax) * 0.5);
    const hz = Math.max(0.03, Math.abs(bz - az) * 0.5);
    // skirting board
    sk.box([cx, g + 0.09, cz], [hx + 0.03, 0.09, hz + 0.03], { chamfer: 0.012 });
    // dado rail at chair height — the horizontal that stops a wall reading as one plane
    dd.box([cx, g + 1.05, cz], [hx + 0.018, 0.035, hz + 0.018], { chamfer: 0.01 });
  }

  /* ── ceiling joists ───────────────────────────────────────────────────── */
  const jm = bat.b('wood.weathered');
  const along = x1 - x0 >= z1 - z0;
  const span = along ? iz1 - iz0 : ix1 - ix0;
  const count = Math.max(4, Math.round((along ? ix1 - ix0 : iz1 - iz0) / 1.15));
  for (let i = 0; i < count; i++) {
    const u = lerp(along ? ix0 + 0.5 : iz0 + 0.5, along ? ix1 - 0.5 : iz1 - 0.5, i / (count - 1));
    if (along) jm.box([u, ceil - 0.42, (iz0 + iz1) * 0.5], [0.055, 0.13, span * 0.5], { chamfer: 0.012 });
    else jm.box([(ix0 + ix1) * 0.5, ceil - 0.42, u], [span * 0.5, 0.13, 0.055], { chamfer: 0.012 });
  }
  // one deeper spine beam under the joists
  if (along) jm.box([(ix0 + ix1) * 0.5, ceil - 0.6, (iz0 + iz1) * 0.5], [(ix1 - ix0) * 0.5, 0.16, 0.11], { chamfer: 0.016 });
  else jm.box([(ix0 + ix1) * 0.5, ceil - 0.6, (iz0 + iz1) * 0.5], [0.11, 0.16, (iz1 - iz0) * 0.5], { chamfer: 0.016 });

  /* ── one fit-out per unit ─────────────────────────────────────────────── */
  for (let k = 0; k < units; k++) {
    const f0 = k / units;
    const f1 = (k + 1) / units;
    const ux0 = unitAxis === 'x' ? lerp(ix0, ix1, f0) : ix0;
    const ux1 = unitAxis === 'x' ? lerp(ix0, ix1, f1) : ix1;
    const uz0 = unitAxis === 'x' ? iz0 : lerp(iz0, iz1, f0);
    const uz1 = unitAxis === 'x' ? iz1 : lerp(iz0, iz1, f1);
    const cx = (ux0 + ux1) * 0.5;
    const cz = (uz0 + uz1) * 0.5;

    /**
     * Party partition between units, as a **stub** running back from the shopfront
     * for a little over half the depth, with a doorway punched through it.
     *
     * A stub rather than a full division for two reasons: the far half stays open so
     * the eye reads all the way to the back of the terrace (depth, which a sealed box
     * has none of), and a receding wall a metre to one side of the camera is the
     * cheapest perspective line there is. It is deliberately offset off the exact unit
     * boundary so it can never land on top of a spawn or a review camera.
     */
    if (k > 0) {
      const runLen = unitAxis === 'x' ? (uz1 - uz0) * 0.56 : (ux1 - ux0) * 0.56;
      if (unitAxis === 'x') {
        const px = ux0 - 0.75;
        wallRun(bat, {
          x0: px,
          z0: uz0 + 0.05,
          x1: px,
          z1: uz0 + runLen,
          y0: g,
          y1: ceil - 0.1,
          thick: 0.2,
          mat: 'int.plaster',
          openings: [{ u: runLen * 0.62, w: 1.1, h: 2.15, type: 'door' }],
          plinth: null,
          cornice: null,
        });
      } else {
        const pz = uz0 - 0.75;
        wallRun(bat, {
          x0: ux0 + 0.05,
          z0: pz,
          x1: ux0 + runLen,
          z1: pz,
          y0: g,
          y1: ceil - 0.1,
          thick: 0.2,
          mat: 'int.plaster',
          openings: [{ u: runLen * 0.62, w: 1.1, h: 2.15, type: 'door' }],
          plinth: null,
          cornice: null,
        });
      }
    }

    // Pendant light on a flex — the one element that says "someone works here".
    const px = cx + (rng() - 0.5) * 1.4;
    const pz = cz + (rng() - 0.5) * 1.4;
    bat.b('metal.rust').cylinder([px, ceil - 0.62, pz], [px, ceil - 1.35, pz], 0.008, 4);
    bat.b('metal.paintCream').cylinder([px, ceil - 1.34, pz], [px, ceil - 1.52, pz], 0.16, 10, { radius2: 0.05 });
    bat.b('sign.lit').cylinder([px, ceil - 1.5, pz], [px, ceil - 1.55, pz], 0.1, 8);

    // Counter along the back, with a till plinth and a shelf under it.
    const back = unitAxis === 'x' ? { ax: ux0 + 0.5, az: uz0 + 1.1, bx: ux1 - 0.5, bz: uz0 + 1.1 } : { ax: ux0 + 1.1, az: uz0 + 0.5, bx: ux0 + 1.1, bz: uz1 - 0.5 };
    lowWall(bat, back.ax, back.az, back.bx, back.bz, g, g + 0.94, 0.56, 'wood.weathered', {
      copingMat: 'struct.concreteClean',
    });
    /*
     * Stock ON the counter. A bare counter reads as a low wall, which is exactly what
     * it was. Till, a jar row, a stack of trays, a paper roll on a spindle and a
     * carrier-bag hook — all four-to-twelve triangles apiece.
     */
    {
      const cAx = back.ax;
      const cAz = back.az;
      const cBx = back.bx;
      const cBz = back.bz;
      const at = (t, off = 0) => [
        lerp(cAx, cBx, t) + (unitAxis === 'x' ? 0 : off),
        0,
        lerp(cAz, cBz, t) + (unitAxis === 'x' ? off : 0),
      ];
      const top = g + 0.97;
      /* till: a boxy body with a raised display head */
      const [tx, , tz] = at(0.18);
      bat.b('struct.panelPale').box([tx, top + 0.11, tz], [0.19, 0.11, 0.16], { chamfer: 0.014 });
      bat.b('metal.paintCream').box([tx, top + 0.26, tz - 0.03], [0.13, 0.05, 0.09], { chamfer: 0.01, });
      bat.b('sign.lit').box([tx, top + 0.27, tz + 0.06], [0.1, 0.032, 0.006], { chamfer: 0.003 });
      /* Tin row. Deliberately NOT glass: five transparent cylinders a metre from the
         `weapon` review camera is five layers of blended overdraw across a third of
         the frame, and on the software rasteriser the harness captures with that is
         the difference between a 4-minute frame and a timed-out one. Painted tins
         with a printed band read the same at this distance and cost nothing. */
      for (let j = 0; j < 5; j++) {
        const [jx, , jz] = at(0.34 + j * 0.055, -0.1);
        const jh = 0.13 + rng() * 0.09;
        bat.b('metal.paintCream').cylinder([jx, top, jz], [jx, top + jh, jz], 0.052, 9);
        bat.b(rng() > 0.5 ? 'veg.citrus' : 'veg.green').cylinder([jx, top + jh * 0.28, jz], [jx, top + jh * 0.72, jz], 0.055, 9);
        bat.b('metal.galv').cylinder([jx, top + jh, jz], [jx, top + jh + 0.014, jz], 0.055, 9);
      }
      /* stacked trays and a paper roll on a spindle */
      const [sx2, , sz2] = at(0.68, 0.02);
      for (let s = 0; s < 3; s++) {
        bat.b('wood.ply').box([sx2 + s * 0.012, top + 0.035 + s * 0.062, sz2], [0.2, 0.03, 0.15], { chamfer: 0.008 });
      }
      const [px2, , pz2] = at(0.86, -0.06);
      bat.b('metal.rust').cylinder([px2, top, pz2 - 0.1], [px2, top, pz2 + 0.1], 0.008, 5);
      bat.b('struct.panelPale').cylinder([px2, top, pz2 - 0.07], [px2, top, pz2 + 0.07], 0.055, 10);
      /* a hook rail under the counter nose with carrier bags on it */
      const [hx, , hz] = at(0.5, 0.3);
      bat.b('metal.galv').cylinder([hx - 0.35, g + 0.86, hz], [hx + 0.35, g + 0.86, hz], 0.008, 5);
      for (let b = 0; b < 4; b++) {
        bat.b('struct.panelPale').box([hx - 0.28 + b * 0.19, g + 0.72, hz - 0.01], [0.07, 0.13, 0.02], { chamfer: 0.01 });
      }
    }

    /*
     * Wall shelving. It used to be sited on the *far* wall of the unit, which for the
     * `weapon` camera (standing inside unit 3 looking north) put every stocked board
     * ten metres behind the lens. It now runs along the back wall the shopfront faces
     * — the wall a camera standing in the unit is looking straight at — and a second,
     * shorter run goes on the party partition.
     */
    const shelfRuns =
      unitAxis === 'x'
        ? [{ x: cx, z: uz0 + 0.34, L: Math.min(2.4, (ux1 - ux0) * 0.42), axis: 'x' }]
        : [{ x: ux0 + 0.34, z: cz, L: Math.min(2.4, (uz1 - uz0) * 0.42), axis: 'z' }];
    for (const run of shelfRuns) {
      if (run.L < 0.6) continue;
      const bm = bat.b('wood.ply');
      for (let s = 0; s < 3; s++) {
        const sy = g + 0.86 + s * 0.6;
        if (run.axis === 'x') bm.box([run.x, sy, run.z], [run.L, 0.024, 0.23], { chamfer: 0.008 });
        else bm.box([run.x, sy, run.z], [0.23, 0.024, run.L], { chamfer: 0.008 });
        // stock: boxes, tins and sacks standing on the board — never an empty shelf
        const slots = Math.max(3, Math.round(run.L * 2.6));
        for (let b = 0; b < slots; b++) {
          const ft = (b + 0.5) / slots;
          const bx2 = run.axis === 'x' ? lerp(run.x - run.L + 0.16, run.x + run.L - 0.16, ft) : run.x;
          const bz2 = run.axis === 'x' ? run.z : lerp(run.z - run.L + 0.16, run.z + run.L - 0.16, ft);
          if (rng() < 0.16) continue;
          const kind = rng();
          const bh = 0.13 + rng() * 0.17;
          if (kind < 0.45) {
            bat
              .b(rng() > 0.5 ? 'wood.painted' : 'struct.panelPale')
              .box([bx2, sy + 0.024 + bh * 0.5, bz2], [0.1, bh * 0.5, 0.1], { chamfer: 0.012 });
          } else if (kind < 0.78) {
            bat.b('metal.paintCream').cylinder([bx2, sy + 0.026, bz2], [bx2, sy + 0.026 + bh * 0.7, bz2], 0.055, 9);
            bat.b(rng() > 0.5 ? 'veg.tomato' : 'veg.citrus').cylinder(
              [bx2, sy + 0.03, bz2], [bx2, sy + 0.026 + bh * 0.66, bz2], 0.057, 9
            );
          } else {
            bat.b('fabric.canvas').cylinder([bx2, sy + 0.026, bz2], [bx2, sy + 0.026 + bh * 0.8, bz2], 0.075, 8, { radius2: 0.055 });
          }
        }
      }
      // Bracket pairs under the shelves.
      const brm = bat.b('metal.rust');
      for (const s of [-1, 1]) {
        const bx2 = run.axis === 'x' ? run.x + s * (run.L - 0.22) : run.x;
        const bz2 = run.axis === 'x' ? run.z : run.z + s * (run.L - 0.22);
        brm.box([bx2, g + 1.5, bz2], [0.02, 0.64, 0.02], { chamfer: 0 });
      }
    }
  }
  /*
   * Break the floor. The tile grid used to run unbroken wall to wall under a stain
   * overlay that had nothing to do with the geometry. Now the wear lane is a *different
   * tile*, there is a screed patch where tiles have lifted, and the shopfront has a
   * stone threshold — so what you read as wear is actually there.
   */
  bat.b('int.tileWorn').box([(ix0 + ix1) * 0.5, g + 0.01, (iz0 + iz1) * 0.5], [(ix1 - ix0) * 0.3, 0.01, (iz1 - iz0) * 0.26], {
    chamfer: 0.006,
  });
  for (let k = 0; k < units; k++) {
    const f = (k + 0.5) / units;
    const px = unitAxis === 'x' ? lerp(ix0, ix1, f) + (rng() - 0.5) * 1.4 : lerp(ix0 + 1, ix1 - 1, rng());
    const pz = unitAxis === 'x' ? lerp(iz0 + 1.5, iz1 - 1.5, rng()) : lerp(iz0, iz1, f) + (rng() - 0.5) * 1.4;
    bat.b('int.screed').box([px, g + 0.016, pz], [0.55 + rng() * 0.4, 0.016, 0.45 + rng() * 0.4], { chamfer: 0.01 });
  }
  /* threshold strip along the shopfront side */
  if (unitAxis === 'x') bat.b('struct.concreteClean').box([(ix0 + ix1) * 0.5, g + 0.018, iz1 - 0.22], [(ix1 - ix0) * 0.5, 0.018, 0.22], { chamfer: 0.012 });
  else bat.b('struct.concreteClean').box([ix1 - 0.22, g + 0.018, (iz0 + iz1) * 0.5], [0.22, 0.018, (iz1 - iz0) * 0.5], { chamfer: 0.012 });
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

/**
 * A distant block, authored straight into LOD 2.
 *
 * ── What went wrong before, and what the rule is now ────────────────────────────
 * The previous version gave the `far` rank *nothing*: no windows, no ribs, no roof
 * plant, on the argument that none of it resolves past 200 m. That argument is only
 * true for a block that is a hundred pixels tall. The hill town was thirty-five
 * blocks 300 m out and, because their bases were authored in the sky rather than on
 * the ridge, each one was two hundred pixels of untextured stucco filling the upper
 * half of the establishing shot. They were the LARGEST objects in that frame.
 *
 * So the rank is now a quality dial, not an on/off switch:
 *
 *   rank 0 (60-110 m)   punched windows on a 3.6 m grid, pilaster ribs, roof plant,
 *                       setback tower, near-playspace stucco at ~1:1 UVs
 *   rank 1 (110-190 m)  ribbon glazing (one banded quad per floor per face, broken
 *                       into bays), stepped parapet, setback + stair housing, tanks
 *   rank 2 (230-360 m)  small punched windows 2-3 per face per floor, a flat or
 *                       pitched roof, a parapet band, a stair box — enough that the
 *                       terrace has an internal read and a serrated top edge
 *
 * Every rank gets its roof cap in `far.deck` (dark) and its parapet in `far.trim`
 * (light) so no block tops out flat and pale into the sky.
 *
 * A window here is two triangles. The whole three-rank set costs well under 30 k.
 */
export function buildBackdrop(bat, def) {
  const [x0, z0, x1, z1] = def.rect;
  const y0 = def.base ?? 0;
  const h = def.h;
  const top = y0 + h;
  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;
  const hx = (x1 - x0) * 0.5;
  const hz = (z1 - z0) * 0.5;
  const seed = Math.round(x0 * 0.37 + z0 * 0.71);
  const rank = def.rank ?? (def.far ? 2 : 0);
  bat.lod = 0;
  /*
   * UV scale by rank. 0.32 across the board was the bug the review named: it stretched
   * one stucco tile over eight metres, so the near rank had no surface at all and read
   * as painted card. A tile lands at ~2.5 m at scale 1; at 80 m that is 8 px, which is
   * exactly the size detail should be. Only the hill town, where a tile would be under
   * a pixel and would alias, still gets stretched.
   */
  bat.uvScale = rank === 0 ? 1.0 : rank === 1 ? 0.72 : 0.45;
  bat.uvOffset = [seed * 1.7, seed * 0.9];

  const t1 = hash2(seed, 3);
  const t2 = hash2(seed + 11, 7);
  const t3 = hash2(seed + 23, 13);
  const t4 = hash2(seed + 41, 17);

  /* ── the mass ─────────────────────────────────────────────────────────── */
  bat.b(def.wall).box([cx, y0 + h * 0.5, cz], [hx, h * 0.5, hz], { chamfer: 0.08 });
  /*
   * Roof deck (dark) inside a parapet RING (light). A solid cap would be cheaper by
   * three boxes and would hide the deck, the stair housing and the tanks behind one
   * pale slab — which is the flat top edge this whole pass exists to get rid of. The
   * ring is four unchamfered walls: forty-eight triangles for a roof you can see
   * into, and two values where the block meets the sky.
   */
  /* `chamfer: 0` throughout the roof furniture: MeshBuilder chamfers by default and a
     chamfered box is 44 triangles against 12, for a 2 cm bevel on something 60-360 m
     away. Five boxes per block over sixty-six blocks is ten thousand triangles of
     invisible edge treatment. */
  bat.b('far.deck').box([cx, top + 0.1, cz], [hx - 0.18, 0.12, hz - 0.18], { chamfer: 0 });
  {
    const ph = rank === 2 ? 0.55 : 0.85;
    const pt = 0.34;
    const tr = bat.b('far.trim');
    tr.box([cx, top + ph * 0.5, cz - hz + pt * 0.5], [hx + 0.1, ph * 0.5, pt * 0.5], { chamfer: 0 });
    tr.box([cx, top + ph * 0.5, cz + hz - pt * 0.5], [hx + 0.1, ph * 0.5, pt * 0.5], { chamfer: 0 });
    tr.box([cx - hx + pt * 0.5, top + ph * 0.5, cz], [pt * 0.5, ph * 0.5, hz + 0.1], { chamfer: 0 });
    tr.box([cx + hx - pt * 0.5, top + ph * 0.5, cz], [pt * 0.5, ph * 0.5, hz + 0.1], { chamfer: 0 });
  }

  /* ── silhouette ───────────────────────────────────────────────────────── */
  if (rank === 2) {
    /*
     * Hill town. Small houses: a stair box on one corner, and one house in three gets
     * a shallow pitched roof rather than a deck, which is what makes a terrace of
     * these read as a *town* rather than as a row of dominoes.
     */
    if (t1 > 0.62) {
      const rh = 1.1 + t2 * 1.7;
      const rm = bat.b(t3 > 0.5 ? 'roof.shingle' : 'far.deck');
      /* two slopes meeting on a ridge running along the longer axis */
      if (hx >= hz) {
        rm.prism(
          [[x0, top + 0.7, z0], [x1, top + 0.7, z0], [x1, top + 0.7, cz], [x0, top + 0.7, cz]],
          [[x0, top + 0.7, z0], [x1, top + 0.7, z0], [x1, top + 0.7 + rh, cz], [x0, top + 0.7 + rh, cz]]
        );
        rm.prism(
          [[x0, top + 0.7, cz], [x1, top + 0.7, cz], [x1, top + 0.7, z1], [x0, top + 0.7, z1]],
          [[x0, top + 0.7 + rh, cz], [x1, top + 0.7 + rh, cz], [x1, top + 0.7, z1], [x0, top + 0.7, z1]]
        );
      } else {
        rm.prism(
          [[x0, top + 0.7, z0], [cx, top + 0.7, z0], [cx, top + 0.7, z1], [x0, top + 0.7, z1]],
          [[x0, top + 0.7, z0], [cx, top + 0.7 + rh, z0], [cx, top + 0.7 + rh, z1], [x0, top + 0.7, z1]]
        );
        rm.prism(
          [[cx, top + 0.7, z0], [x1, top + 0.7, z0], [x1, top + 0.7, z1], [cx, top + 0.7, z1]],
          [[cx, top + 0.7 + rh, z0], [x1, top + 0.7, z0], [x1, top + 0.7, z1], [cx, top + 0.7 + rh, z1]]
        );
      }
    } else if (t1 > 0.3) {
      /* upper storey set back off one edge — the classic hillside step */
      const sh = 2.6 + t2 * 4.2;
      const sx = hx * (0.5 + t3 * 0.24);
      const sz = hz * (0.5 + t4 * 0.24);
      bat.b(def.wall).box([cx + (t2 - 0.5) * (hx - sx) * 1.5, top + 1.0 + sh * 0.5, cz + (t3 - 0.5) * (hz - sz) * 1.5], [sx, sh * 0.5, sz], {
        chamfer: 0.06,
      });
    }
    /* stair box + a single tank: two boxes, and the top edge stops being a ruler */
    bat.b('far.deck').box([cx + hx * 0.5, top + 1.5, cz - hz * 0.42], [1.5, 1.3, 1.4], { chamfer: 0 });
    if (t4 > 0.45) bat.b('metal.galv').cylinder([cx - hx * 0.4, top + 0.9, cz + hz * 0.3], [cx - hx * 0.4, top + 2.2, cz + hz * 0.3], 0.75, 6);
  } else {
    /* setback tower on most blocks, with its own cap */
    if (t1 > 0.28) {
      const sh = h * (rank === 1 ? 0.18 + t1 * 0.3 : 0.22 + t1 * 0.38);
      const sx = hx * (0.42 + t2 * 0.26);
      const sz = hz * (0.42 + t3 * 0.26);
      const ox = (t2 - 0.5) * (hx - sx) * 1.4;
      const oz = (t3 - 0.5) * (hz - sz) * 1.4;
      bat.b(def.wall).box([cx + ox, top + sh * 0.5, cz + oz], [sx, sh * 0.5, sz], { chamfer: 0.08 });
      bat.b('far.trim').box([cx + ox, top + sh + 0.3, cz + oz], [sx + 0.14, 0.3, sz + 0.14], { chamfer: 0.05 });
      backdropWindows(bat, rank, [cx - sx, cz - sz, cx + sx, cz + sz], top, sh, seed + 7);
    }
    // Stair / lift housing and water tanks on the main deck.
    bat.b('far.deck').box([cx - hx * 0.55, top + 1.5, cz + hz * 0.4], [1.9, 1.5, 1.8], { chamfer: 0 });
    const tk = bat.b('metal.galv');
    const tanks = rank === 0 ? 3 : 2;
    for (let i = 0; i < tanks; i++) {
      const f = (i + 0.6) / (tanks + 0.6);
      const tx = lerp(x0 + 2.5, x1 - 2.5, hash3(seed, i, 5));
      const tz = lerp(z0 + 2.5, z1 - 2.5, f);
      tk.cylinder([tx, top + 0.7, tz], [tx, top + 2.7, tz], 0.85 + hash3(seed, i, 9) * 0.4, 6);
    }
    if (rank === 0) {
      /* Shallow pilaster ribs, on the two faces that point at the playspace only.
         Unchamfered: a chamfered rib is 30 triangles and half a pixel of highlight. */
      const rb = bat.b('far.trim');
      for (let x = x0 + 4; x < x1 - 2; x += 7.5) {
        rb.box([x, y0 + h * 0.5, z1 + 0.14], [0.5, h * 0.5, 0.16], { chamfer: 0 });
        rb.box([x, y0 + h * 0.5, z0 - 0.14], [0.5, h * 0.5, 0.16], { chamfer: 0 });
      }
    }
  }

  backdropWindows(bat, rank, def.rect, y0, h, seed);
  bat.uvScale = 1;
  bat.uvOffset = [0, 0];
}

/**
 * Fenestration for a backdrop block, on the two faces that look at the map (+Z/-Z).
 *
 * Rank 0 and 2 punch individual openings; rank 1 draws ribbon glazing, one bay-broken
 * band per floor, which is both what a 1970s concrete slab actually looks like and a
 * tenth of the triangles of a punched grid on a 45 m tower.
 */
function backdropWindows(bat, rank, rect, y0, h, seed) {
  const [x0, z0, x1, z1] = rect;
  if (h < 4) return;
  /* Opaque glazing, dark and light — see `far.glassDark` in kit/Palette.js for why
     this is not the glass key. Roughly one pane in five catches the sky. */
  const dark = bat.b('far.glassDark');
  const lit = bat.b('far.glassLit');
  const face = (mb, xa, xb, ya, yb, z, s) => {
    if (s > 0) mb.quad([xa, ya, z], [xb, ya, z], [xb, yb, z], [xa, yb, z], [0, 0, 1]);
    else mb.quad([xa, ya, z], [xa, yb, z], [xb, yb, z], [xb, ya, z], [0, 0, -1]);
  };
  const zf = z1 + 0.05;
  const zb = z0 - 0.05;

  if (rank === 1) {
    /* ribbon glazing: one band per floor, split into 2-4 bays with solid piers */
    const floor = 3.4;
    const bays = 2 + (Math.round(hash2(seed, 5) * 2) % 3);
    const inset = 1.8;
    const span = x1 - x0 - inset * 2;
    if (span < 3) return;
    const bayW = span / bays;
    let k = 0;
    for (let y = y0 + 2.6; y < y0 + h - 2.0; y += floor) {
      for (let b = 0; b < bays; b++, k++) {
        const mb = hash3(seed, k, 3) > 0.82 ? lit : dark;
        const bx0 = x0 + inset + b * bayW + 0.55;
        const bx1 = x0 + inset + (b + 1) * bayW - 0.55;
        face(mb, bx0, bx1, y, y + 1.7, zf, 1);
        face(mb, bx0, bx1, y, y + 1.7, zb, -1);
      }
    }
    return;
  }

  /* punched openings */
  const step = rank === 0 ? 3.6 : 4.2;
  const ww = rank === 0 ? 1.2 : 1.3;
  const wh = rank === 0 ? 1.6 : 1.3;
  const floor = rank === 0 ? 3.2 : 3.0;
  for (let y = y0 + 2.4; y < y0 + h - 1.2; y += floor) {
    let k = 0;
    for (let x = x0 + 2.2; x < x1 - 1.8; x += step, k++) {
      /* Leave a hole here and there: a perfectly regular grid is a spreadsheet, and
         a shuttered or bricked-up bay is what a real hill town is full of. */
      const r = hash3(seed, k, Math.round(y));
      if (rank === 2 && r < 0.28) continue;
      const mb = r > 0.79 ? lit : dark;
      face(mb, x - ww * 0.5, x + ww * 0.5, y - wh * 0.5, y + wh * 0.5, zf, 1);
      face(mb, x - ww * 0.5, x + ww * 0.5, y - wh * 0.5, y + wh * 0.5, zb, -1);
    }
  }
}

/* ------------------------------------------------------- the far distance */

/**
 * The far terrain band. A retail vista frame is three explicit depth layers: the
 * playspace, a mid backdrop of non-playable geometry, and a far terrain layer whose
 * only job is to make sure the horizon is never a straight line. Without it the tan
 * ground plane meets the sky at a razor edge and the world visibly stops at the fence.
 *
 * Built as two nested cones: the ring nearest the camera sits below grade (hidden
 * behind the backdrop blocks) and the surface rises away to the ridgeline, so the
 * hillside faces the player and takes the sun the same way the map does.
 */
export function buildHorizon(bat, H) {
  if (!H) return;
  const seg = Math.max(24, H.segments ?? 96);
  const layer = (rNear, yNear, rFar, base, bands, mat) => {
    const mb = bat.b(mat);
    const dR = rFar - rNear;
    const prev = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
    let p0 = null;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const h = ridgeAt(a, base, bands);
      const dY = h - yNear;
      const nl = Math.hypot(ca * dY, dR, sa * dY) || 1;
      const cur = {
        nx: (-ca * dY) / nl,
        ny: dR / nl,
        nz: (-sa * dY) / nl,
        n0: [rNear * ca, yNear, rNear * sa],
        n1: [rFar * ca, h, rFar * sa],
      };
      if (p0) {
        mb.quad(p0.n0, cur.n0, cur.n1, p0.n1, [(p0.nx + cur.nx) * 0.5, (p0.ny + cur.ny) * 0.5, (p0.nz + cur.nz) * 0.5]);
      }
      p0 = cur;
    }
    void prev;
  };
  layer(H.inner ?? 235, -1.6, H.outer ?? 620, H.base ?? 34, H.bands || [[22, 1]], H.mat || 'ground.dirt');
  if (H.far) {
    layer(
      H.far.inner ?? 540,
      -12,
      H.far.outer ?? 1080,
      H.far.base ?? 96,
      [
        [H.far.amp ?? 44, 1],
        [(H.far.amp ?? 44) * 0.5, 3],
        [(H.far.amp ?? 44) * 0.22, 5],
      ],
      H.far.mat || 'wall.bone'
    );
  }
}

/**
 * Tall non-playable silhouette elements at 150-300 m: minarets, water towers, tower
 * cranes, smokestacks and radio masts. A skyline is silhouette — a row of flat-topped
 * boxes at similar heights is scenery, and these are what turn it into a city.
 * Everything here is authored with the fewest segments that still reads at range.
 */
export function buildSkyline(bat, list) {
  for (const s of list || []) {
    const { x, z } = s;
    const y0 = s.base ?? 0;
    const h = s.h ?? 30;
    try {
      switch (s.kind) {
        case 'minaret': {
          const r = s.r ?? 3.2;
          bat.b('wall.bone').cylinder([x, y0, z], [x, y0 + h * 0.72, z], r, 8, { radius2: r * 0.74 });
          bat.b('struct.concreteClean').cylinder([x, y0 + h * 0.7, z], [x, y0 + h * 0.75, z], r * 1.45, 8);
          bat.b('wall.sand').cylinder([x, y0 + h * 0.75, z], [x, y0 + h * 0.9, z], r * 0.62, 8, { radius2: r * 0.55 });
          bat.b('roof.shingle').cylinder([x, y0 + h * 0.9, z], [x, y0 + h, z], r * 0.7, 8, { radius2: 0.1 });
          bat.b('metal.galv').cylinder([x, y0 + h, z], [x, y0 + h + r * 0.9, z], r * 0.05, 5);
          break;
        }
        case 'dome': {
          const r = s.r ?? 10;
          bat.b('wall.bone').box([x, y0 + h * 0.35, z], [r, h * 0.35, r], { chamfer: 0.5 });
          bat.b('wall.sand').cylinder([x, y0 + h * 0.7, z], [x, y0 + h, z], r * 0.62, 10, { radius2: r * 0.1 });
          break;
        }
        case 'tower': {
          // Water tower: four legs, a braced ring and a big drum on top.
          const r = s.r ?? 6;
          const lm = bat.b('metal.rust');
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + 0.78;
            lm.cylinder([x + Math.cos(a) * r, y0, z + Math.sin(a) * r], [x + Math.cos(a) * r * 0.6, y0 + h * 0.66, z + Math.sin(a) * r * 0.6], 0.42, 5);
          }
          for (const f of [0.3, 0.52]) {
            for (let i = 0; i < 4; i++) {
              const a0 = (i / 4) * Math.PI * 2 + 0.78;
              const a1 = ((i + 1) / 4) * Math.PI * 2 + 0.78;
              const rr = r * (1 - f * 0.6);
              lm.cylinder(
                [x + Math.cos(a0) * rr, y0 + h * f, z + Math.sin(a0) * rr],
                [x + Math.cos(a1) * rr, y0 + h * f, z + Math.sin(a1) * rr],
                0.22,
                4
              );
            }
          }
          bat.b('metal.galv').cylinder([x, y0 + h * 0.66, z], [x, y0 + h * 0.94, z], r * 0.86, 10);
          bat.b('metal.galv').cylinder([x, y0 + h * 0.94, z], [x, y0 + h, z], r * 0.7, 10, { radius2: r * 0.12 });
          break;
        }
        case 'stack': {
          const r = s.r ?? 3;
          bat.b('brick.red').cylinder([x, y0, z], [x, y0 + h, z], r, 10, { radius2: r * 0.52 });
          bat.b('struct.concreteClean').cylinder([x, y0 + h, z], [x, y0 + h + 0.9, z], r * 0.62, 10);
          for (let i = 1; i <= 3; i++) {
            const yy = y0 + (h * i) / 4;
            bat.b('struct.concreteClean').cylinder([x, yy, z], [x, yy + 0.5, z], r * (1 - i * 0.12) + 0.22, 10);
          }
          break;
        }
        case 'crane': {
          // Tower crane: mast, jib, counter-jib, hook block. Pure silhouette.
          const jib = s.jib ?? 30;
          const yaw = s.yaw ?? 0;
          const cs = Math.cos(yaw);
          const sn = Math.sin(yaw);
          const m = bat.b('metal.paintRed');
          for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            m.cylinder([x + ox * 0.85, y0, z + oz * 0.85], [x + ox * 0.85, y0 + h, z + oz * 0.85], 0.16, 4);
          }
          for (let i = 1; i * 3 < h; i++) {
            const yy = y0 + i * 3;
            m.cylinder([x - 0.85, yy, z - 0.85], [x + 0.85, yy, z + 0.85], 0.1, 4);
            m.cylinder([x - 0.85, yy, z + 0.85], [x + 0.85, yy, z - 0.85], 0.1, 4);
          }
          // jib + counter-jib
          const jx = x + cs * jib;
          const jz = z - sn * jib;
          const bx = x - cs * jib * 0.34;
          const bz = z + sn * jib * 0.34;
          m.cylinder([x, y0 + h, z], [jx, y0 + h - 0.6, jz], 0.2, 4);
          m.cylinder([x, y0 + h - 1.4, z], [jx, y0 + h - 1.8, jz], 0.14, 4);
          m.cylinder([x, y0 + h, z], [bx, y0 + h - 0.2, bz], 0.18, 4);
          // apex A-frame and the two pendants
          m.cylinder([x, y0 + h, z], [x, y0 + h + 6.5, z], 0.13, 4);
          m.cylinder([x, y0 + h + 6.5, z], [x + cs * jib * 0.66, y0 + h - 0.4, z - sn * jib * 0.66], 0.07, 4);
          m.cylinder([x, y0 + h + 6.5, z], [bx, y0 + h - 0.2, bz], 0.07, 4);
          bat.b('struct.concrete').box([bx, y0 + h - 1.4, bz], [1.5, 1.0, 1.5], { chamfer: 0.1 });
          // hook block on its fall
          const hx = x + cs * jib * 0.55;
          const hz = z - sn * jib * 0.55;
          bat.b('metal.galv').cylinder([hx, y0 + h - 1.0, hz], [hx, y0 + h * 0.45, hz], 0.05, 4);
          bat.b('metal.galv').box([hx, y0 + h * 0.44, hz], [0.4, 0.5, 0.4], { chamfer: 0.06 });
          break;
        }
        default: {
          // lattice radio mast
          const m = bat.b('metal.galv');
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * Math.PI * 2;
            m.cylinder([x + Math.cos(a) * 1.2, y0, z + Math.sin(a) * 1.2], [x, y0 + h, z], 0.13, 4);
          }
          for (let i = 1; i * 4 < h; i++) {
            const yy = y0 + i * 4;
            const rr = 1.2 * (1 - yy / (h * 1.3));
            for (let k = 0; k < 3; k++) {
              const a0 = (k / 3) * Math.PI * 2;
              const a1 = ((k + 1) / 3) * Math.PI * 2;
              m.cylinder(
                [x + Math.cos(a0) * rr, yy, z + Math.sin(a0) * rr],
                [x + Math.cos(a1) * rr, yy, z + Math.sin(a1) * rr],
                0.07,
                4
              );
            }
          }
          bat.b('metal.paintRed').cylinder([x, y0 + h, z], [x, y0 + h + 3, z], 0.08, 4);
          break;
        }
      }
    } catch {
      /* one bad silhouette must never take the horizon with it */
    }
  }
}

export default { buildBuilding, buildMinaret, buildFuelStation, buildBackdrop, buildHorizon, buildSkyline, sideLine, sidePoint };
