/**
 * destruction/Patterns.js — precomputed fracture patterns. Owner: destruction agent.
 *
 * Nothing is fractured at the moment of impact. A pattern is generated once for a
 * (distribution, cell count, size bucket, variant) key, cached, and from then on a
 * break is just "instantiate these N cached geometries as rigid bodies" — which is what
 * keeps sustained fire allocation-free.
 *
 * The distributions are what make a break read as the right *material*:
 *   chunk  jittered 3D lattice           concrete, plaster, brick, stone, pots
 *   strip  rows along the longest axis    wood — planks split with the grain, then snap
 *   radial rings about a focus point      glass — shards run out from the impact
 *   shard  dense radial + jitter, flat    ceramic tile, crockery
 *   panel  a handful of big cells         sheet metal, chain-link, awning fabric
 *
 * Every distribution goes through the same Voronoi clip, so every fragment comes out
 * as a closed convex solid with real interior faces — never a shell, never a card.
 *
 * Exports: PatternCache.
 */
import { makeRNG } from '../../core/RNG.js';
import { voronoiCells, polyToGeometry } from './Voronoi.js';
import { hashStr, snapSize, LRU, clamp } from './util.js';

const TAU = Math.PI * 2;

/* ── site distributions ─────────────────────────────────────────────────────── */

function sitesChunk(hx, hy, hz, count, rnd) {
  // Jittered lattice: roughly equal cell volumes, no two fragments the same shape.
  const vol = hx * hy * hz;
  const per = Math.cbrt(vol / Math.max(1, count));
  const nx = Math.max(1, Math.round(hx / Math.max(1e-3, per)));
  const ny = Math.max(1, Math.round(hy / Math.max(1e-3, per)));
  const nz = Math.max(1, Math.round(hz / Math.max(1e-3, per)));
  const out = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        out.push([
          hx * (((i + 0.5) / nx) * 2 - 1) + (rnd() - 0.5) * (hx / nx) * 1.4,
          hy * (((j + 0.5) / ny) * 2 - 1) + (rnd() - 0.5) * (hy / ny) * 1.4,
          hz * (((k + 0.5) / nz) * 2 - 1) + (rnd() - 0.5) * (hz / nz) * 1.4,
        ]);
      }
    }
  }
  // Trim toward the requested count, deterministically.
  while (out.length > count && out.length > 2) out.splice(Math.floor(rnd() * out.length), 1);
  return out;
}

function sitesStrip(hx, hy, hz, count, rnd) {
  // Longest axis = the grain. Split hard along it, lightly across.
  const ext = [hx, hy, hz];
  let grain = 0;
  if (ext[1] > ext[grain]) grain = 1;
  if (ext[2] > ext[grain]) grain = 2;
  const cross = [0, 1, 2].filter((a) => a !== grain);
  const along = Math.max(2, Math.round(Math.sqrt(count) * 1.35));
  const acrossTotal = Math.max(1, Math.ceil(count / along));
  const a0 = Math.max(1, Math.round(Math.sqrt(acrossTotal)));
  const a1 = Math.max(1, Math.ceil(acrossTotal / a0));
  const counts = [];
  counts[grain] = along;
  counts[cross[0]] = a0;
  counts[cross[1]] = a1;
  const out = [];
  for (let i = 0; i < counts[0]; i++) {
    for (let j = 0; j < counts[1]; j++) {
      for (let k = 0; k < counts[2]; k++) {
        const idx = [i, j, k];
        const p = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
          const n = counts[a];
          const jitter = a === grain ? 0.9 : 0.35;
          p[a] = ext[a] * (((idx[a] + 0.5) / n) * 2 - 1) + (rnd() - 0.5) * (ext[a] / n) * jitter;
        }
        out.push(p);
      }
    }
  }
  return out;
}

function sitesRadial(hx, hy, hz, count, rnd, focus) {
  // Thin axis is the pane normal; rings live in the other two.
  const ext = [hx, hy, hz];
  let thin = 0;
  if (ext[1] < ext[thin]) thin = 1;
  if (ext[2] < ext[thin]) thin = 2;
  const a = [0, 1, 2].filter((i) => i !== thin);
  const fx = focus ? focus[0] : (rnd() - 0.5) * 0.7;
  const fy = focus ? focus[1] : (rnd() - 0.5) * 0.7;
  const cx = ext[a[0]] * fx;
  const cy = ext[a[1]] * fy;
  const rmax = Math.max(ext[a[0]], ext[a[1]]) * 1.55;
  const rings = clamp(Math.round(Math.sqrt(count) * 0.95), 2, 6);
  const out = [];
  // A tight cluster right at the impact — the pulverised centre of a bullet hole.
  out.push([0, 0, 0].map((_, i) => (i === thin ? 0 : i === a[0] ? cx : cy)));
  let placed = 1;
  for (let r = 1; r <= rings && placed < count; r++) {
    const t = r / rings;
    const radius = rmax * t * t * (0.55 + rnd() * 0.25);
    const nSeg = Math.max(3, Math.round((count - 1) * (t * 0.9) * (2 / rings)) + 2);
    const phase = rnd() * TAU;
    for (let s = 0; s < nSeg && placed < count; s++) {
      const ang = phase + (s / nSeg) * TAU + (rnd() - 0.5) * (TAU / nSeg) * 0.85;
      const rr = radius * (0.78 + rnd() * 0.5);
      const p = [0, 0, 0];
      p[thin] = (rnd() - 0.5) * ext[thin] * 0.3;
      p[a[0]] = cx + Math.cos(ang) * rr;
      p[a[1]] = cy + Math.sin(ang) * rr;
      out.push(p);
      placed++;
    }
  }
  return out;
}

function sitesShard(hx, hy, hz, count, rnd) {
  // Ceramic: radial about the centre but far less orderly than glass.
  const out = sitesRadial(hx, hy, hz, count, rnd, [(rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.5]);
  for (const p of out) {
    p[0] += (rnd() - 0.5) * hx * 0.35;
    p[1] += (rnd() - 0.5) * hy * 0.35;
    p[2] += (rnd() - 0.5) * hz * 0.35;
  }
  return out;
}

function sitesPanel(hx, hy, hz, count, rnd) {
  // Torn sheet: few, large, very irregular cells.
  const ext = [hx, hy, hz];
  let thin = 0;
  if (ext[1] < ext[thin]) thin = 1;
  if (ext[2] < ext[thin]) thin = 2;
  const a = [0, 1, 2].filter((i) => i !== thin);
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = [0, 0, 0];
    p[thin] = 0;
    p[a[0]] = (rnd() * 2 - 1) * ext[a[0]] * 0.92;
    p[a[1]] = (rnd() * 2 - 1) * ext[a[1]] * 0.92;
    out.push(p);
  }
  return out;
}

const DISTS = {
  chunk: sitesChunk,
  strip: sitesStrip,
  radial: sitesRadial,
  shard: sitesShard,
  panel: sitesPanel,
};

/* ── the cache ──────────────────────────────────────────────────────────────── */

export class PatternCache {
  /**
   * @param {number} limit   patterns held before the least-recently-used is disposed
   * @param {number} seed    base seed; every pattern derives from it + its key
   */
  constructor(limit = 40, seed = 0x9e3779b9) {
    this.seed = seed >>> 0;
    this.built = 0;
    this.buildMs = 0;
    this.lru = new LRU(limit, (p) => {
      for (const c of p.cells) c.geometry.dispose();
    });
  }

  /**
   * @param {object} o
   * @param {string} o.dist      chunk | strip | radial | shard | panel
   * @param {number} o.count     desired fragment count
   * @param {number} o.hx,hy,hz  half extents in metres (snapped into size buckets)
   * @param {number} [o.variant] 0..3, so the same crate does not always break the same
   * @returns {{cells:Array, key:string, volume:number, triangles:number}}
   */
  get(o) {
    const hx = snapSize(o.hx);
    const hy = snapSize(o.hy);
    const hz = snapSize(o.hz);
    const dist = DISTS[o.dist] ? o.dist : 'chunk';
    const count = clamp(Math.round(o.count || 8), 2, 40);
    const variant = (o.variant | 0) & 3;
    const key = `${dist}|${count}|${hx}|${hy}|${hz}|${variant}`;
    const hit = this.lru.get(key);
    if (hit) return hit;

    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const rnd = makeRNG((this.seed ^ hashStr(key)) >>> 0);
    let cells = [];
    try {
      const sites = DISTS[dist](hx, hy, hz, count, rnd);
      const raw = voronoiCells(hx, hy, hz, sites);
      const minVol = hx * hy * hz * 8 * 0.004;
      for (const cell of raw) {
        const built = polyToGeometry(cell, { hx, hy, hz }, rnd);
        if (!built) continue;
        if (built.volume < minVol) {
          built.geometry.dispose();
          continue;
        }
        cells.push(built);
      }
    } catch {
      cells = [];
    }
    // Biggest first: when the live-fragment budget clips a break, keep the chunks that
    // actually read on screen and drop the crumbs.
    cells.sort((a, b) => b.volume - a.volume);

    const pattern = {
      key,
      cells,
      volume: cells.reduce((s, c) => s + c.volume, 0),
      triangles: cells.reduce((s, c) => s + c.triangles, 0),
      half: [hx, hy, hz],
    };
    this.built++;
    this.buildMs += (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.lru.set(key, pattern);
    return pattern;
  }

  get size() {
    return this.lru.size;
  }

  dispose() {
    this.lru.clear();
  }
}

export default PatternCache;
