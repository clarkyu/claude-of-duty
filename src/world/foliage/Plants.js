/**
 * Ground cover, shrubs and climbers. Owner: foliage agent.
 *
 * Everything here returns a `BufferGeometry` in plant-local space with the origin at
 * the *base* of the plant and +Y up. Climbers use +Z as "away from the wall"; hanging
 * vines grow downwards from their anchor. The caller instances it; nothing in this file
 * touches the scene.
 *
 * ── Why the two-phase build ─────────────────────────────────────────────────────
 * Each builder first draws **all** of its random numbers into a fixed-size structure
 * (blade angles, leans, lengths, phases) and only then skins that structure at the
 * requested LOD. The random draws are therefore identical for LOD 0 and LOD 1, so the
 * two versions of a plant occupy the same space and lean the same way — which is the
 * whole reason the distance cross-dissolve is invisible. LOD 1 is not a decimated copy:
 * it is the same structure skinned with fewer, wider cards so the *visual density*
 * holds up at 25 m instead of turning to lace.
 */
import * as THREE from 'three';
import { MeshBuilder, addCard, addTube, addPot } from './Builder.js';
import { cellRect, LEAF_CELL, BARK_CELL } from './Atlas.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;

/** Draw `n * k` numbers up front so the stream is LOD-independent. */
function draws(rng, n, k) {
  const a = new Float32Array(n * k);
  for (let i = 0; i < a.length; i++) a[i] = rng();
  return a;
}

/* ========================================================================== */
/*                                ground cover                                */
/* ========================================================================== */

/**
 * A tuft of dry grass. Blades radiate from a common root, lean outwards, and arc over
 * under their own weight; crossed pairs give the clump thickness from every angle.
 * LOD 1 keeps every third blade and widens it.
 */
export function buildGrassTuft(rng, opts = {}) {
  const mb = new MeshBuilder();
  const cell = cellRect(LEAF_CELL.grass);
  const lod = opts.lod ?? 0;
  const N = opts.blades ?? 7;
  const height = opts.height ?? 0.42;
  const spread = opts.spread ?? 0.15;
  const d = draws(rng, N, 5);
  const stride = lod === 0 ? 1 : 3;
  const segs = lod === 0 ? 4 : 2;
  const widen = lod === 0 ? 1 : 2.2;
  const centre = V(0, height * 0.35, 0);

  for (let i = 0; i < N; i += stride) {
    const o = i * 5;
    const a = (i / N) * TAU + d[o] * 0.7;
    const r = spread * (0.15 + d[o + 1] * 0.85);
    const lean = 0.35 + d[o + 2] * 0.55;
    const h = height * (0.55 + d[o + 3] * 0.75) * (lod === 0 ? 1 : 1.1);
    addCard(mb, {
      origin: V(Math.cos(a) * r, 0, Math.sin(a) * r),
      dir: V(Math.cos(a) * lean * 0.45, 1, Math.sin(a) * lean * 0.45).normalize(),
      side: V(-Math.sin(a), 0, Math.cos(a)),
      length: h,
      width: 0.155 * widen * (0.7 + d[o + 4] * 0.6),
      bend: V(Math.cos(a), -0.55, Math.sin(a)).normalize(),
      bendAmount: h * (0.32 + d[o + 1] * 0.4),
      segments: segs,
      cell,
      taper: 0.3,
      bentCenter: centre,
      bentAmount: 0.4,
      flexBase: 0.05,
      flexTip: 1,
      phase: d[o],
      leaf: 0.75,
      cup: 0.5,
    });
  }
  return mb.toGeometry(`grass_lod${lod}`);
}

/**
 * A taller dry weed: a woody stalk, sparse leaves and a seed head. These grow where
 * nobody has cleared them — the base of a wall, the lee of a barrier.
 */
export function buildWeed(rng, opts = {}) {
  const mb = new MeshBuilder();
  const leafCell = cellRect(LEAF_CELL.grass);
  const twigCell = cellRect(BARK_CELL.twig);
  const lod = opts.lod ?? 0;
  const height = opts.height ?? 0.7;
  const STALKS = 4;
  const LEAVES = 6;
  const HEADS = 5;
  const s = draws(rng, STALKS, 4);
  const lv = draws(rng, STALKS * LEAVES, 3);
  const hd = draws(rng, STALKS * HEADS, 2);
  const stalkStride = lod === 0 ? 1 : 2;
  const leafStride = lod === 0 ? 1 : 2;
  const headStride = lod === 0 ? 1 : 2;
  const widen = lod === 0 ? 1 : 1.9;

  for (let k = 0; k < STALKS; k += stalkStride) {
    const o = k * 4;
    const a = s[o] * TAU;
    const r = 0.05 * s[o + 1];
    const h = height * (0.6 + s[o + 2] * 0.6);
    const lean = 0.14 + s[o + 3] * 0.22;
    const base = V(Math.cos(a) * r, 0, Math.sin(a) * r);
    const tipX = base.x + Math.cos(a) * lean * h;
    const tipZ = base.z + Math.sin(a) * lean * h;

    if (lod === 0) {
      const path = [];
      for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        path.push({
          p: V(base.x + (tipX - base.x) * t * t, h * t, base.z + (tipZ - base.z) * t * t),
          r: 0.009 * (1 - t * 0.8) + 0.002,
          flex: t * t,
        });
      }
      addTube(mb, path, { radial: 3, cell: twigCell, phase: s[o] });
    }

    for (let i = 0; i < LEAVES; i += leafStride) {
      const q = (k * LEAVES + i) * 3;
      const t = 0.25 + 0.72 * Math.pow((i + 0.5) / LEAVES, 0.7);
      const la = a + i * 2.399 + lv[q] * 0.4;
      const len = h * (0.2 + lv[q + 1] * 0.16) * widen * 0.75;
      addCard(mb, {
        origin: V(base.x + (tipX - base.x) * t * t, h * t, base.z + (tipZ - base.z) * t * t),
        dir: V(Math.cos(la) * 0.8, 0.75, Math.sin(la) * 0.8).normalize(),
        length: len,
        width: 0.115 * widen * (0.8 + lv[q + 2] * 0.5),
        bend: V(Math.cos(la), -0.9, Math.sin(la)).normalize(),
        bendAmount: h * 0.1,
        segments: lod === 0 ? 3 : 1,
        cell: leafCell,
        taper: 0.28,
        bentCenter: V(0, h * 0.5, 0),
        bentAmount: 0.45,
        flexBase: t * 0.6,
        flexTip: 1,
        phase: lv[q],
        leaf: 1,
        cup: 0.4,
      });
    }

    for (let i = 0; i < HEADS; i += headStride) {
      const q = (k * HEADS + i) * 2;
      const la = hd[q] * TAU;
      addCard(mb, {
        origin: V(tipX, h * 0.94, tipZ),
        dir: V(Math.cos(la) * 0.35, 1, Math.sin(la) * 0.35).normalize(),
        length: h * 0.16,
        width: 0.058 * widen,
        bend: V(Math.cos(la), -0.4, Math.sin(la)).normalize(),
        bendAmount: h * 0.05,
        segments: lod === 0 ? 2 : 1,
        cell: leafCell,
        taper: 0.6,
        flexBase: 0.85,
        flexTip: 1,
        phase: hd[q + 1],
        leaf: 1,
      });
    }
  }
  return mb.toGeometry(`weed_lod${lod}`);
}

/** Tiny weeds pushing through a crack in the paving. */
export function buildCrackWeed(rng, opts = {}) {
  const mb = new MeshBuilder();
  const cell = cellRect(LEAF_CELL.grass);
  const lod = opts.lod ?? 0;
  const N = 6;
  const height = opts.height ?? 0.16;
  const d = draws(rng, N, 3);
  const stride = lod === 0 ? 1 : 2;
  const widen = lod === 0 ? 1 : 1.8;

  for (let i = 0; i < N; i += stride) {
    const o = i * 3;
    const a = (i / N) * TAU + d[o];
    const lean = 0.7 + d[o + 1] * 0.9;
    const h = height * (0.5 + d[o + 2] * 0.9);
    addCard(mb, {
      origin: V(Math.cos(a) * 0.02, 0, Math.sin(a) * 0.02),
      dir: V(Math.cos(a) * lean * 0.8, 1, Math.sin(a) * lean * 0.8).normalize(),
      side: V(-Math.sin(a), 0, Math.cos(a)),
      length: h,
      width: 0.085 * widen * (0.7 + d[o + 1] * 0.7),
      bend: V(Math.cos(a), -0.8, Math.sin(a)).normalize(),
      bendAmount: h * 0.5,
      segments: lod === 0 ? 3 : 1,
      cell,
      taper: 0.3,
      bentCenter: V(0, h * 0.3, 0),
      bentAmount: 0.5,
      flexBase: 0.08,
      flexTip: 1,
      phase: d[o],
      leaf: 1,
      cup: 0.5,
    });
  }
  return mb.toGeometry(`crackweed_lod${lod}`);
}

/**
 * A low scrubby bush: woody stems and a broken, lopsided leaf mass. Real scrub is never
 * a sphere — it is denser on the sheltered side and thin where it has been grazed.
 */
export function buildBush(rng, opts = {}) {
  const mb = new MeshBuilder();
  const leafCell = cellRect(LEAF_CELL.broad);
  const twigCell = cellRect(BARK_CELL.twig);
  const lod = opts.lod ?? 0;
  const radius = opts.radius ?? 0.55;
  const height = opts.height ?? 0.72;
  const centre = V(0, height * 0.52, 0);
  const STEMS = 6;
  const CLUSTERS = Math.max(6, Math.round(26 * (opts.density ?? 1)));
  const st = draws(rng, STEMS, 2);
  const shelter = rng() * TAU;
  const cl = draws(rng, CLUSTERS, 4);
  const stride = lod === 0 ? 1 : 3;
  const widen = lod === 0 ? 1 : 2.1;

  if (lod === 0) {
    for (let i = 0; i < STEMS; i++) {
      const o = i * 2;
      const a = (i / STEMS) * TAU + st[o] * 0.6;
      const h = height * (0.4 + st[o + 1] * 0.35);
      const path = [];
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        path.push({
          p: V(Math.cos(a) * radius * 0.42 * t * t, h * t, Math.sin(a) * radius * 0.42 * t * t),
          r: 0.022 * (1 - t * 0.72) + 0.004,
          flex: t * t * 0.5,
        });
      }
      addTube(mb, path, { radial: 4, cell: twigCell, phase: st[o], lobes: 3, lobeAmount: 0.18 });
    }
  }

  for (let i = 0; i < CLUSTERS; i += stride) {
    const o = i * 4;
    // Fibonacci distribution over a squashed upper hemisphere.
    const u = (i + 0.5) / CLUSTERS;
    const phi = Math.acos(1 - 1.35 * u);
    const theta = i * 2.39996 + cl[o] * 0.5;
    let rr = radius * (0.55 + cl[o + 1] * 0.5);
    rr *= 0.78 + 0.32 * Math.cos(theta - shelter); // thicker on the sheltered side
    const dirOut = V(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi) * 0.92 + 0.18,
      Math.sin(phi) * Math.sin(theta)
    ).normalize();
    const org = V(dirOut.x * rr * 0.55, height * 0.28 + dirOut.y * rr * 0.62, dirOut.z * rr * 0.55);
    const len = 0.36 * widen * radius * (0.7 + cl[o + 2] * 0.7);
    addCard(mb, {
      origin: org,
      dir: dirOut,
      length: len,
      width: 0.40 * widen * radius * (0.7 + cl[o + 3] * 0.6),
      bend: V(dirOut.x * 0.4, -1, dirOut.z * 0.4).normalize(),
      bendAmount: len * 0.4,
      segments: lod === 0 ? 2 : 1,
      cell: leafCell,
      taper: 0.7,
      bentCenter: centre,
      bentAmount: 0.72,
      flexBase: 0.28,
      flexTip: 1,
      phase: cl[o + 1],
      leaf: 0.85,
      cup: 0.25,
    });
  }
  return mb.toGeometry(`bush_lod${lod}`);
}

/* ========================================================================== */
/*                                  climbers                                  */
/* ========================================================================== */

/**
 * Ivy creeping up a wall. Local frame: the wall is the XY plane and +Z points out of
 * it. Runners branch upwards; the leaves lie almost flat against the render surface
 * with a random tilt out, exactly like the real thing.
 */
export function buildIvyPatch(rng, opts = {}) {
  const mb = new MeshBuilder();
  const leafCell = cellRect(LEAF_CELL.broad);
  const twigCell = cellRect(BARK_CELL.twig);
  const lod = opts.lod ?? 0;
  const w = opts.width ?? 1.6;
  const h = opts.height ?? 2.2;
  const RUNNERS = 5;
  const LEAVES = 16;
  const STEPS = 7;
  const rn = draws(rng, RUNNERS, 3);
  const lf = draws(rng, RUNNERS * LEAVES, 4);
  const stride = lod === 0 ? 1 : 2;
  const leafStride = lod === 0 ? 1 : 2;
  const widen = lod === 0 ? 1 : 1.75;

  for (let s = 0; s < RUNNERS; s += stride) {
    const o = s * 3;
    const x0 = (rn[o] - 0.5) * w * 0.7;
    const drift = (rn[o + 1] - 0.5) * w * 0.55;
    const top = h * (0.55 + rn[o + 2] * 0.5);
    const path = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      path.push({
        p: V(x0 + drift * t + Math.sin(t * 6.1 + s) * 0.06, top * t, 0.012 + Math.sin(t * 4.3) * 0.006),
        r: 0.011 * (1 - t * 0.65) + 0.002,
        flex: t * 0.35,
      });
    }
    if (lod === 0) addTube(mb, path, { radial: 3, cell: twigCell, phase: rn[o] });

    for (let i = 0; i < LEAVES; i += leafStride) {
      const q = (s * LEAVES + i) * 4;
      const t = 0.06 + 0.92 * ((i + lf[q] * 0.6) / LEAVES);
      const anchor = path[Math.min(STEPS, Math.floor(t * STEPS))].p;
      const la = lf[q + 1] * TAU;
      const outward = 0.28 + lf[q + 2] * 0.45;
      const len = 0.17 * widen * (0.7 + lf[q + 3] * 0.7);
      addCard(mb, {
        origin: V(anchor.x, anchor.y, anchor.z),
        dir: V(Math.cos(la) * 0.85, Math.sin(la) * 0.85 + 0.35, outward).normalize(),
        length: len,
        width: len * (1.15 + lf[q + 2] * 0.45),
        bend: V(0, -0.5, 0.6).normalize(),
        bendAmount: len * 0.22,
        segments: lod === 0 ? 2 : 1,
        cell: leafCell,
        taper: 0.75,
        bentCenter: V(anchor.x, anchor.y, -0.35),
        bentAmount: 0.6,
        flexBase: 0.05,
        // Ivy is glued to the wall: it rustles, it does not sway.
        flexTip: 0.45,
        phase: lf[q + 1],
        leaf: 1,
        cup: 0.2,
      });
    }
  }
  return mb.toGeometry(`ivy_lod${lod}`);
}

/**
 * A hanging vine strand — over a coping, off a balcony, out of a broken gutter. The
 * origin is the anchor and growth is downwards, so flex is 1 at the *bottom*.
 */
export function buildHangVine(rng, opts = {}) {
  const mb = new MeshBuilder();
  const leafCell = cellRect(LEAF_CELL.broad);
  const twigCell = cellRect(BARK_CELL.twig);
  const lod = opts.lod ?? 0;
  const length = opts.length ?? 1.1;
  const STRANDS = 3;
  const LEAVES = 12;
  const STEPS = 6;
  const sd = draws(rng, STRANDS, 4);
  const lf = draws(rng, STRANDS * LEAVES, 3);
  const stride = lod === 0 ? 1 : 2;
  const leafStride = lod === 0 ? 1 : 2;
  const widen = lod === 0 ? 1 : 1.7;

  for (let s = 0; s < STRANDS; s += stride) {
    const o = s * 4;
    const a = sd[o] * TAU;
    const ox = Math.cos(a) * 0.09 * sd[o + 1];
    const oz = Math.sin(a) * 0.09 * sd[o + 1];
    const len = length * (0.6 + sd[o + 2] * 0.7);
    const sway = (sd[o + 3] - 0.5) * 0.28;
    const path = [];
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      path.push({
        p: V(ox + sway * t * t, -len * t, oz + Math.sin(t * 3.7 + s) * 0.05),
        r: 0.01 * (1 - t * 0.6) + 0.002,
        flex: t * t,
      });
    }
    if (lod === 0) addTube(mb, path, { radial: 3, cell: twigCell, phase: sd[o] });

    for (let i = 0; i < LEAVES; i += leafStride) {
      const q = (s * LEAVES + i) * 3;
      const t = 0.08 + 0.9 * ((i + lf[q] * 0.5) / LEAVES);
      const anchor = path[Math.min(STEPS, Math.floor(t * STEPS))].p;
      const la = i * 2.399 + lf[q + 1] * 0.5;
      const lLen = 0.16 * widen * (0.7 + lf[q + 2] * 0.6);
      addCard(mb, {
        origin: V(anchor.x, anchor.y, anchor.z),
        dir: V(Math.cos(la) * 0.9, -0.42, Math.sin(la) * 0.9).normalize(),
        length: lLen,
        width: lLen * (1.0 + lf[q + 2] * 0.5),
        bend: V(0, -1, 0),
        bendAmount: lLen * 0.35,
        segments: lod === 0 ? 2 : 1,
        cell: leafCell,
        taper: 0.72,
        bentCenter: V(0, -len * 0.45, 0),
        bentAmount: 0.55,
        flexBase: t * 0.8,
        flexTip: 1,
        phase: lf[q + 1],
        leaf: 1,
        cup: 0.2,
      });
    }
  }
  return mb.toGeometry(`vine_lod${lod}`);
}

/** Terracotta pot. Separate geometry because it wants the clay material, not leaves. */
export function buildPotShell(rng, opts = {}) {
  const mb = new MeshBuilder();
  addPot(mb, {
    rTop: opts.rTop ?? 0.2,
    rBot: opts.rBot ?? 0.145,
    height: opts.height ?? 0.28,
    radial: opts.lod === 1 ? 8 : 14,
    rim: 0.018,
    cell: cellRect(BARK_CELL.smooth),
  });
  return mb.toGeometry(`pot_lod${opts.lod ?? 0}`);
}

/** The plant that lives in the pot: a dense little mound. */
export function buildPottedPlant(rng, opts = {}) {
  const lod = opts.lod ?? 0;
  const geo = buildBush(rng, {
    lod,
    radius: opts.radius ?? 0.24,
    height: opts.height ?? 0.34,
    density: 0.85,
  });
  geo.translate(0, opts.baseY ?? 0.24, 0);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  geo.name = `potted_lod${lod}`;
  return geo;
}

export default {
  buildGrassTuft,
  buildWeed,
  buildCrackWeed,
  buildBush,
  buildIvyPatch,
  buildHangVine,
  buildPotShell,
  buildPottedPlant,
};
