/**
 * Procedural trees. Owner: foliage agent.
 *
 * Three Mediterranean / Levantine species, all grown by the same recursive skeleton
 * walker and then skinned differently:
 *
 *   olive   — the signature tree of this map. Short, massively thick, fluted trunk that
 *             forks low; four generations of branches with a strong apical droop, and a
 *             broken silver-green canopy that lets sky through.
 *   palm    — a single leaning columnar trunk with diamond leaf-base scars and a crown
 *             of arching pinnate fronds, dead ones hanging below the live ones.
 *   cypress — a narrow flame: one straight leader and a dense dark shell of scale
 *             sprays on a profile that is widest at a third height.
 *
 * ── Structure / skin split ──────────────────────────────────────────────────────
 * `grow()` never looks at the LOD. It draws every random number it will ever need and
 * emits a pure data skeleton (branch paths + leaf anchors). Skinning then turns that
 * one skeleton into either LOD, so both share the *identical* silhouette, lean and
 * branch layout and the distance cross-dissolve has nothing to give away. LOD 1 drops
 * the twig generation, halves the radial segments and keeps every third leaf at ~1.8x
 * the card size, which holds the canopy's visual density instead of thinning it out.
 *
 * Output per species:
 *   { wood: BufferGeometry|null, leaves: BufferGeometry|null,
 *     height, canopy:{y,r}, trunkR, tris }
 */
import * as THREE from 'three';
import { MeshBuilder, addCard, addTube, basisFrom } from './Builder.js';
import { cellRect, LEAF_CELL, BARK_CELL } from './Atlas.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;

const newBasis = () => ({ x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() });

/* ========================================================================== */
/*                          the recursive skeleton                            */
/* ========================================================================== */

/**
 * Grow a branch and its children. LOD-independent by construction.
 *
 * Taper follows the pipe model — a parent's cross-section is shared out among its
 * children, `r_child = r_parent * share^(1/2.3)` — which is what makes the fork
 * junctions look structural instead of arbitrary.
 */
function grow(p, cfg, out, rng) {
  const steps = Math.max(2, cfg.segments - p.depth);
  const seg = p.length / steps;
  const pos = p.origin.clone();
  const dir = p.dir.clone().normalize();
  const b = basisFrom(dir, newBasis());
  const path = [];
  const flexSpan = p.flexTip - p.flexBase;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Pipe-model taper plus a knot ripple: old wood is lumpy, not conical.
    const r = p.radius * (1 - (1 - cfg.tipRatio) * t) * (1 + Math.sin(t * 7.7 + p.seed) * cfg.knots);
    path.push({ p: pos.clone(), r: Math.max(0.006, r), flex: p.flexBase + flexSpan * t * t });
    if (i === steps) break;
    pos.addScaledVector(dir, seg);
    // Gnarl: the growth direction wanders; gravity and phototropism pull on it.
    const w = cfg.wobble * (1 + p.depth * 0.5);
    dir.addScaledVector(b.x, (rng() - 0.5) * w);
    dir.addScaledVector(b.z, (rng() - 0.5) * w);
    dir.y += (cfg.tropism - cfg.gravity * (p.depth + 1) * 0.25) * seg;
    dir.normalize();
  }

  out.branches.push({ path, depth: p.depth, phase: rng() });

  const tipDir = dir.clone();
  const tipPos = pos.clone();

  // Leaves live on the outer generations, densest right at the tips.
  if (p.depth >= cfg.leafFromDepth) {
    const n = Math.round(cfg.leavesPerTip * (0.55 + 0.45 * (p.depth / cfg.maxDepth)));
    for (let i = 0; i < n; i++) {
      const t = 1 - Math.pow(rng(), cfg.leafTipBias); // bias to the last third
      const k = Math.min(path.length - 1, Math.floor(t * (path.length - 1)));
      out.leaves.push({
        p: path[k].p.clone(),
        dir: tipDir.clone(),
        flex: path[k].flex,
        roll: rng(),
        size: rng(),
        phase: rng(),
      });
    }
  }

  if (p.depth >= cfg.maxDepth || p.length < cfg.minLength) return;

  const kids = cfg.childrenFor(p.depth, rng);
  const childR = p.radius * Math.pow(1 / kids, 1 / 2.3) * cfg.radiusKeep;
  const roll = rng() * TAU;
  for (let c = 0; c < kids; c++) {
    const a = roll + (c / kids) * TAU + (rng() - 0.5) * 0.7;
    const spread = cfg.angle * (0.65 + rng() * 0.7);
    const cd = tipDir.clone();
    const cb = basisFrom(cd, newBasis());
    cd.multiplyScalar(Math.cos(spread));
    cd.addScaledVector(cb.x, Math.sin(spread) * Math.cos(a));
    cd.addScaledVector(cb.z, Math.sin(spread) * Math.sin(a));
    cd.normalize();
    grow(
      {
        origin: tipPos.clone(),
        dir: cd,
        length: p.length * cfg.lengthRatio * (0.8 + rng() * 0.4),
        radius: childR * (0.85 + rng() * 0.3),
        depth: p.depth + 1,
        flexBase: p.flexTip,
        flexTip: Math.min(1, p.flexTip + (1 - p.flexTip) * 0.62),
        seed: p.seed + c * 3.7 + 1.3,
      },
      cfg,
      out,
      rng
    );
  }
}

function skeleton(cfg, rng) {
  const out = { branches: [], leaves: [] };
  grow(
    {
      origin: V(0, 0, 0),
      dir: V((rng() - 0.5) * cfg.leanAmount, 1, (rng() - 0.5) * cfg.leanAmount).normalize(),
      length: cfg.trunkLength,
      radius: cfg.trunkRadius,
      depth: 0,
      flexBase: 0,
      flexTip: cfg.trunkFlex,
      seed: rng() * 10,
    },
    cfg,
    out,
    rng
  );
  return out;
}

/* ========================================================================== */
/*                                   olive                                    */
/* ========================================================================== */

export function buildOlive(rng, opts = {}) {
  const lod = opts.lod ?? 0;
  const scale = opts.scale ?? 1;
  const cfg = {
    segments: 5,
    trunkLength: 1.35 * scale,
    trunkRadius: 0.24 * scale,
    trunkFlex: 0.05,
    tipRatio: 0.62,
    knots: 0.16,
    wobble: 0.34,
    tropism: 0.05,
    gravity: 0.05,
    leanAmount: 0.22,
    maxDepth: 4,
    minLength: 0.16 * scale,
    lengthRatio: 0.72,
    radiusKeep: 1.02,
    angle: 0.62,
    leafFromDepth: 2,
    leavesPerTip: 13,
    leafTipBias: 2.4,
    childrenFor: (depth, r) => (depth === 0 ? 3 + (r() < 0.4 ? 1 : 0) : 2 + (r() < 0.42 ? 1 : 0)),
  };
  const sk = skeleton(cfg, rng);

  /* ---- wood ---- */
  const wood = new MeshBuilder();
  const barkCell = cellRect(BARK_CELL.olive);
  const twigCell = cellRect(BARK_CELL.twig);
  for (const br of sk.branches) {
    if (lod === 1 && br.depth >= 3) continue; // twigs vanish at range; leaves cover it
    const radial = lod === 0 ? [8, 6, 5, 4, 4][Math.min(4, br.depth)] : [5, 4, 3, 3, 3][Math.min(4, br.depth)];
    addTube(wood, br.path, {
      radial,
      cell: br.depth <= 1 ? barkCell : twigCell,
      phase: br.phase,
      vScale: br.depth === 0 ? 1 : 0.6,
      lobes: br.depth === 0 ? 5 : 3,
      lobeAmount: br.depth === 0 ? 0.16 : 0.1,
      twist: br.depth === 0 ? 0.35 : 0,
    });
  }
  // Buttressed root flare — an olive grows out of the ground, it is not stuck into it.
  addRootFlare(wood, cfg.trunkRadius, barkCell, lod);

  /* ---- leaves ---- */
  const leaves = new MeshBuilder();
  const leafCell = cellRect(LEAF_CELL.olive);
  let hi = 0;
  let canopyR = 0.4;
  for (const l of sk.leaves) {
    hi = Math.max(hi, l.p.y);
    canopyR = Math.max(canopyR, Math.hypot(l.p.x, l.p.z));
  }
  const centre = V(0, hi * 0.72, 0);
  const stride = lod === 0 ? 1 : 3;
  const widen = lod === 0 ? 1 : 1.85;
  const bs = newBasis();
  for (let i = 0; i < sk.leaves.length; i += stride) {
    const l = sk.leaves[i];
    const a = l.roll * TAU;
    basisFrom(l.dir, bs);
    const dir = l.dir
      .clone()
      .multiplyScalar(0.45)
      .addScaledVector(bs.x, Math.cos(a) * 0.85)
      .addScaledVector(bs.z, Math.sin(a) * 0.85)
      .normalize();
    const len = 0.50 * widen * scale * (0.7 + l.size * 0.6);
    addCard(leaves, {
      origin: l.p,
      dir,
      length: len,
      width: len * 0.62 * (0.8 + l.size * 0.4),
      bend: V(dir.x * 0.35, -1, dir.z * 0.35).normalize(),
      bendAmount: len * 0.32,
      segments: lod === 0 ? 2 : 1,
      cell: leafCell,
      taper: 0.62,
      bentCenter: centre,
      bentAmount: 0.68,
      flexBase: l.flex,
      flexTip: 1,
      phase: l.phase,
      leaf: 1,
      cup: 0.22,
    });
  }

  return finish(wood, leaves, `olive_lod${lod}`, Math.max(hi, 1.5), canopyR, cfg.trunkRadius);
}

/* ========================================================================== */
/*                                    palm                                    */
/* ========================================================================== */

export function buildPalm(rng, opts = {}) {
  const lod = opts.lod ?? 0;
  const scale = opts.scale ?? 1;
  const FRONDS = 17;

  /* ---- structure (LOD-independent) ---- */
  const height = (6.2 + rng() * 2.4) * scale;
  const lean = (rng() - 0.5) * 0.28;
  const leanAxis = rng() * TAU;
  const trunkPhase = rng();
  const fronds = [];
  for (let f = 0; f < FRONDS; f++) {
    const dead = f < Math.round(FRONDS * 0.22);
    fronds.push({
      dead,
      a: (f / FRONDS) * TAU + rng() * 0.4,
      rise: dead ? -0.85 - rng() * 0.4 : 0.75 - (f / FRONDS) * 1.25 + rng() * 0.25,
      len: (dead ? 1.5 : 2.1 + rng() * 0.7) * scale,
      droop: dead ? 1.5 : 0.55 + rng() * 0.5,
      phase: rng(),
      jitter: [rng(), rng(), rng(), rng(), rng(), rng(), rng(), rng()],
    });
  }

  /* ---- trunk ---- */
  const wood = new MeshBuilder();
  const barkCell = cellRect(BARK_CELL.palm);
  const steps = lod === 0 ? 11 : 6;
  const path = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bend = lean * t * t * height;
    // Ring scars: the radius pulses where each shed frond left its base.
    const ring = 1 + Math.sin(t * 46) * (lod === 0 ? 0.045 : 0);
    path.push({
      p: V(Math.cos(leanAxis) * bend, height * t, Math.sin(leanAxis) * bend),
      r: (0.2 - 0.075 * t) * scale * ring,
      flex: t * t * 0.55,
    });
  }
  addTube(wood, path, { radial: lod === 0 ? 9 : 5, cell: barkCell, phase: trunkPhase, vScale: 1 });

  /* ---- crown ---- */
  const crown = path[path.length - 1].p.clone();
  const leaves = new MeshBuilder();
  const frondCell = cellRect(LEAF_CELL.frond);
  const twigCell = cellRect(BARK_CELL.twig);
  const rSteps = lod === 0 ? 6 : 3;
  const segsPer = lod === 0 ? 4 : 2;
  const widen = lod === 0 ? 1 : 1.75;
  const bs = newBasis();

  for (let f = 0; f < FRONDS; f++) {
    const fr = fronds[f];
    const dir = V(Math.cos(fr.a), fr.rise, Math.sin(fr.a)).normalize();
    const rp = [];
    for (let i = 0; i <= rSteps; i++) {
      const t = i / rSteps;
      rp.push({
        p: crown
          .clone()
          .addScaledVector(dir, fr.len * t)
          .addScaledVector(V(0, -1, 0), fr.droop * fr.len * t * t * 0.42),
        r: (0.03 - 0.024 * t) * scale,
        flex: 0.35 + 0.65 * t * t,
      });
    }
    if (lod === 0) addTube(leaves, rp, { radial: 3, cell: twigCell, phase: fr.phase });

    // Two pinnate ribbons, one either side of the rachis, following its arc.
    basisFrom(dir, bs);
    let j = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < segsPer; k++) {
        const t0 = k / segsPer;
        const anchor = rp[Math.min(rp.length - 1, Math.round(t0 * rSteps))].p;
        const along = dir
          .clone()
          .addScaledVector(V(0, -1, 0), fr.droop * 0.75 * t0)
          .addScaledVector(bs.x, side * (0.55 - 0.2 * t0))
          .normalize();
        const bladeLen = (fr.len / segsPer) * 1.15;
        const width = (0.52 - 0.22 * t0) * scale * widen * (fr.dead ? 0.8 : 1);
        addCard(leaves, {
          origin: anchor,
          dir: along,
          side: bs.z.clone(),
          length: bladeLen,
          width,
          bend: V(0, -1, 0),
          bendAmount: bladeLen * (fr.dead ? 0.55 : 0.28),
          segments: lod === 0 ? 3 : 1,
          cell: frondCell,
          taper: 0.72,
          bentCenter: crown,
          bentAmount: 0.35,
          flexBase: 0.3 + 0.5 * t0,
          flexTip: 1,
          phase: fr.phase * 0.6 + fr.jitter[j++ % fr.jitter.length] * 0.4,
          leaf: fr.dead ? 0.55 : 1,
          cup: 0.35,
        });
      }
    }
  }

  return finish(wood, leaves, `palm_lod${lod}`, height, 2.6 * scale, 0.2 * scale);
}

/* ========================================================================== */
/*                                  cypress                                   */
/* ========================================================================== */

export function buildCypress(rng, opts = {}) {
  const lod = opts.lod ?? 0;
  const scale = opts.scale ?? 1;
  const SPRAYS = 135;

  const height = (6.5 + rng() * 3.0) * scale;
  const lean = (rng() - 0.5) * 0.06;
  const trunkPhase = rng();
  const maxR = (0.72 + rng() * 0.24) * scale;
  const sprays = [];
  for (let i = 0; i < SPRAYS; i++) sprays.push([rng(), rng(), rng()]);

  const wood = new MeshBuilder();
  const barkCell = cellRect(BARK_CELL.smooth);
  const steps = lod === 0 ? 8 : 4;
  const path = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    path.push({
      p: V(lean * t * t * height, height * t, lean * 0.4 * t * t * height),
      r: (0.13 - 0.108 * t) * scale,
      flex: t * t * 0.7,
    });
  }
  addTube(wood, path, { radial: lod === 0 ? 6 : 4, cell: barkCell, phase: trunkPhase, lobes: 4, lobeAmount: 0.1 });

  const leaves = new MeshBuilder();
  const sprayCell = cellRect(LEAF_CELL.frond);
  // A flame silhouette: widest at ~a third of the height, pinched to a point on top.
  const profile = (t) => Math.pow(Math.max(0, Math.sin(Math.pow(t, 0.62) * Math.PI)), 0.72);
  const stride = lod === 0 ? 1 : 3;
  const widen = lod === 0 ? 1 : 1.9;

  for (let i = 0; i < SPRAYS; i += stride) {
    const s = sprays[i];
    const u = (i + 0.5) / SPRAYS;
    const t = 0.1 + 0.88 * u;
    const a = i * 2.39996 + s[0] * 0.4;
    const shell = profile(t) * maxR * (0.55 + s[1] * 0.55);
    const base = V(lean * t * t * height, height * t, lean * 0.4 * t * t * height);
    const org = V(base.x + Math.cos(a) * shell * 0.75, base.y, base.z + Math.sin(a) * shell * 0.75);
    const dir = V(Math.cos(a) * 0.75, 0.42 + s[2] * 0.3, Math.sin(a) * 0.75).normalize();
    const len = 1.05 * widen * scale * (0.62 + s[1] * 0.55);
    addCard(leaves, {
      origin: org,
      dir,
      length: len,
      width: len * 0.80,
      bend: V(Math.cos(a) * 0.3, -1, Math.sin(a) * 0.3).normalize(),
      bendAmount: len * 0.45,
      segments: lod === 0 ? 2 : 1,
      cell: sprayCell,
      taper: 0.5,
      bentCenter: V(base.x, base.y - height * 0.05, base.z),
      bentAmount: 0.8,
      flexBase: t * 0.55,
      flexTip: 1,
      phase: s[0],
      leaf: 0.9,
      cup: 0.3,
    });
  }

  return finish(wood, leaves, `cypress_lod${lod}`, height, maxR, 0.13 * scale);
}

/* ========================================================================== */
/*                                  helpers                                   */
/* ========================================================================== */

/** A ring of buttress lobes so the trunk grows out of the ground, not into it. */
function addRootFlare(mb, radius, cell, lod) {
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + i * 0.37;
    const out = 0.7 + ((i * 0.31) % 1) * 0.7;
    addTube(
      mb,
      [
        { p: V(Math.cos(a) * radius * 1.9 * out, 0, Math.sin(a) * radius * 1.9 * out), r: radius * 0.34, flex: 0 },
        {
          p: V(Math.cos(a) * radius * 1.0 * out, radius * 0.7, Math.sin(a) * radius * 1.0 * out),
          r: radius * 0.42,
          flex: 0,
        },
        { p: V(Math.cos(a) * radius * 0.3, radius * 1.7, Math.sin(a) * radius * 0.3), r: radius * 0.3, flex: 0 },
      ],
      { radial: lod === 0 ? 5 : 3, cell, phase: 0, lobes: 3, lobeAmount: 0.2 }
    );
  }
}

function finish(wood, leaves, name, height, canopyR, trunkR) {
  return {
    wood: wood.vertexCount ? wood.toGeometry(`${name}_wood`) : null,
    leaves: leaves.vertexCount ? leaves.toGeometry(`${name}_leaf`) : null,
    height,
    canopy: { y: height * 0.7, r: Math.max(0.35, canopyR) },
    trunkR,
    tris: wood.triangleCount + leaves.triangleCount,
  };
}

export default { buildOlive, buildPalm, buildCypress };
