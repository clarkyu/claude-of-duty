/**
 * Navmesh.js — navigation for the bots. Owner: AI agent.
 *
 * The level publishes a real navigation grid (`ctx.level.navRegions`, format
 * `cod-navgrid-2`): per-cell floor height, clearance, island id and — crucially —
 * *edge* openness probed with knee- and chest-height rays, so a jersey barrier
 * between two cell centres closes the edge even though the cells are adjacent. All
 * pathing goes through those edges, never through raw i±1 / j±1.
 *
 * If the level has not published a grid (stub, or a different map), one is voxelised
 * here by raycasting the physics world — same fields, same API, so nothing downstream
 * can tell the difference.
 *
 * ── Why paths are not staircases ────────────────────────────────────────────────
 * A* on a grid returns cell centres, which zig-zag. Two passes fix it:
 *   1. **Funnel (simple stupid funnel algorithm)** over the shared edges of the
 *      corridor, inset by the agent radius. This is what makes a bot hug the inside
 *      of a doorway instead of walking to the middle of every cell.
 *   2. A greedy **string pull**: keep advancing the end point while the straight line
 *      is walkable for a body of `radius`, tested with a supercover DDA that respects
 *      the same edge openness. Removes anything the funnel left behind.
 *
 * ── Public API ──────────────────────────────────────────────────────────────────
 *   build()                                     (re)read the level grid
 *   ready, cell, cols, rows, cellCount
 *   index(x,z) / cellCentre(k,out) / floorAt(x,z) / clearanceAt(x,z)
 *   isWalkable(x,z) / nearestWalkable(x,z,r) / sameIsland(a,b)
 *   findPath(from, to, opts) -> {points:Vector3[], cells:Int32Array, length, partial}
 *   canWalkLine(ax,az,bx,bz,radius) -> boolean
 *   sampleCells(x,z,minR,maxR,n,rng) -> number[]      candidate cells in an annulus
 *   coverPoints(anchor, threat, opts) -> [{pos, cell, score, kind, exposure}]
 *   avoid(agent, desired, agents, dt, out) -> steered direction
 *   claim(cell, owner) / release(owner) / isClaimed(cell, owner)
 *   debugDraw(scene, on) / setDebugPaths(list) / dispose()
 */
import * as THREE from 'three';

const WORLD_MASK = 1 | 8; // GROUP.WORLD | GROUP.PROP
const SQRT2 = Math.SQRT2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Binary min-heap over cell indices keyed by an external f-score array. */
class Heap {
  constructor(cap) {
    this.a = new Int32Array(Math.max(64, cap));
    this.f = new Float32Array(Math.max(64, cap));
    this.n = 0;
  }

  clear() {
    this.n = 0;
  }

  push(v, f) {
    if (this.n >= this.a.length) {
      const a = new Int32Array(this.a.length * 2);
      const g = new Float32Array(this.a.length * 2);
      a.set(this.a);
      g.set(this.f);
      this.a = a;
      this.f = g;
    }
    let i = this.n++;
    this.a[i] = v;
    this.f[i] = f;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      this._swap(i, p);
      i = p;
    }
  }

  pop() {
    if (this.n === 0) return -1;
    const top = this.a[0];
    this.n--;
    if (this.n > 0) {
      this.a[0] = this.a[this.n];
      this.f[0] = this.f[this.n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && this.f[l] < this.f[m]) m = l;
        if (r < this.n && this.f[r] < this.f[m]) m = r;
        if (m === i) break;
        this._swap(i, m);
        i = m;
      }
    }
    return top;
  }

  _swap(i, j) {
    const a = this.a[i];
    this.a[i] = this.a[j];
    this.a[j] = a;
    const f = this.f[i];
    this.f[i] = this.f[j];
    this.f[j] = f;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════ */

export default function createNavmesh(ctx) {
  const api = {
    ready: false,
    cell: 2,
    cols: 0,
    rows: 0,
    cellCount: 0,
    origin: [0, 0],
    source: 'none',
    stats: { paths: 0, pathCells: 0, pathMs: 0, failures: 0, coverQueries: 0 },
  };

  let nav = null;
  let cols = 0;
  let rows = 0;
  let cell = 2;
  let x0 = 0;
  let z0 = 0;
  let walkable = null;
  let floor = null;
  let clearance = null;
  let islands = null;
  let openX = null;
  let openZ = null;

  // A* scratch, stamped rather than cleared so a path costs no memset.
  let gScore = null;
  let cameFrom = null;
  let stamp = null;
  let stampVal = 1;
  let heap = null;
  let extraCost = null; // dynamic avoidance / squad lane spreading

  const claimed = new Map(); // cell -> owner
  const ownerCell = new Map();

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _dir = new THREE.Vector3();

  /* ── grid access ───────────────────────────────────────────────────────── */

  function index(x, z) {
    const i = Math.floor((x - x0) / cell);
    const j = Math.floor((z - z0) / cell);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return -1;
    return j * cols + i;
  }

  function cellCentre(k, out) {
    const o = out || new THREE.Vector3();
    if (k < 0 || k >= cols * rows) return o.set(0, 0, 0);
    const i = k % cols;
    const j = (k - i) / cols;
    return o.set(x0 + (i + 0.5) * cell, floor ? floor[k] : 0, z0 + (j + 0.5) * cell);
  }

  function isWalkableCell(k) {
    return k >= 0 && k < cols * rows && walkable[k] === 1;
  }

  /** dir: 0=+X 1=-X 2=+Z 3=-Z */
  function isOpen(k, d) {
    if (k < 0 || k >= cols * rows) return false;
    const i = k % cols;
    const j = (k - i) / cols;
    switch (d) {
      case 0: return i + 1 < cols && openX[k] === 1;
      case 1: return i > 0 && openX[k - 1] === 1;
      case 2: return j + 1 < rows && openZ[k] === 1;
      default: return j > 0 && openZ[k - cols] === 1;
    }
  }

  function nearestWalkable(x, z, radius = 10) {
    const k0 = index(x, z);
    if (k0 >= 0 && walkable[k0]) return k0;
    const r = Math.ceil(radius / cell);
    const i0 = Math.floor((x - x0) / cell);
    const j0 = Math.floor((z - z0) / cell);
    let best = -1;
    let bestD = Infinity;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
        const k = j * cols + i;
        if (!walkable[k]) continue;
        const d = di * di + dj * dj;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
    }
    return best;
  }

  /* ── build ─────────────────────────────────────────────────────────────── */

  function adopt(src) {
    nav = src;
    cols = src.cols | 0;
    rows = src.rows | 0;
    cell = src.cell || 2;
    x0 = src.origin?.[0] ?? 0;
    z0 = src.origin?.[1] ?? 0;
    walkable = src.walkable;
    floor = src.floor;
    clearance = src.clearance || new Float32Array(cols * rows).fill(2);
    islands = src.islands || new Int16Array(cols * rows);
    openX = src.openX;
    openZ = src.openZ;

    const n = cols * rows;
    gScore = new Float32Array(n);
    cameFrom = new Int32Array(n);
    stamp = new Uint32Array(n);
    extraCost = new Float32Array(n);
    heap = new Heap(Math.max(256, n >> 2));
    api.cols = cols;
    api.rows = rows;
    api.cell = cell;
    api.cellCount = n;
    api.origin = [x0, z0];
    api.ready = n > 0 && !!walkable && !!openX && !!openZ;
  }

  /**
   * Fallback grid: raycast the physics world on a lattice, then flood connectivity.
   * Only used when the level has not published `navRegions`.
   */
  function voxelise() {
    const phys = ctx.physics;
    const bounds = ctx.level?.bounds;
    if (!phys?.raycast) return null;
    const minX = bounds?.min?.x ?? -60;
    const maxX = bounds?.max?.x ?? 60;
    const minZ = bounds?.min?.z ?? -60;
    const maxZ = bounds?.max?.z ?? 60;
    const topY = (bounds?.max?.y ?? 30) + 5;
    const c = 2;
    const cx = Math.max(2, Math.ceil((maxX - minX) / c));
    const cz = Math.max(2, Math.ceil((maxZ - minZ) / c));
    const n = cx * cz;
    if (n > 40000) return null;
    const wk = new Uint8Array(n);
    const fl = new Float32Array(n);
    const cl = new Float32Array(n);
    const ox = new Uint8Array(n);
    const oz = new Uint8Array(n);
    const down = new THREE.Vector3(0, -1, 0);
    const up = new THREE.Vector3(0, 1, 0);
    const o = new THREE.Vector3();
    for (let j = 0; j < cz; j++) {
      for (let i = 0; i < cx; i++) {
        const k = j * cx + i;
        o.set(minX + (i + 0.5) * c, topY, minZ + (j + 0.5) * c);
        const hit = phys.raycast(o, down, topY + 10, WORLD_MASK);
        if (!hit || (hit.normal && hit.normal.y < 0.6)) continue;
        fl[k] = hit.point.y;
        o.set(hit.point.x, hit.point.y + 0.25, hit.point.z);
        const ceil = phys.raycast(o, up, 3.0, WORLD_MASK);
        cl[k] = ceil ? ceil.distance + 0.25 : 3.0;
        wk[k] = cl[k] >= 1.8 ? 1 : 0;
      }
    }
    // Edge openness: a step is open if both cells are walkable, the step-up is small
    // and a knee-height ray between the centres is clear.
    const a = new THREE.Vector3();
    const d = new THREE.Vector3();
    const probe = (ka, kb, ax, az, bx, bz) => {
      if (!wk[ka] || !wk[kb]) return 0;
      if (Math.abs(fl[ka] - fl[kb]) > 0.9) return 0;
      const y = Math.max(fl[ka], fl[kb]);
      for (const h of [0.35, 1.1]) {
        a.set(ax, y + h, az);
        d.set(bx - ax, 0, bz - az);
        const len = d.length();
        d.multiplyScalar(1 / Math.max(1e-4, len));
        const hit = phys.raycast(a, d, len, WORLD_MASK);
        if (hit) return 0;
      }
      return 1;
    };
    for (let j = 0; j < cz; j++) {
      for (let i = 0; i < cx; i++) {
        const k = j * cx + i;
        const ax = minX + (i + 0.5) * c;
        const az = minZ + (j + 0.5) * c;
        if (i + 1 < cx) ox[k] = probe(k, k + 1, ax, az, ax + c, az);
        if (j + 1 < cz) oz[k] = probe(k, k + cx, ax, az, ax, az + c);
      }
    }
    return {
      format: 'cod-navgrid-2', cell: c, origin: [minX, minZ], cols: cx, rows: cz,
      walkable: wk, standable: wk, floor: fl, clearance: cl,
      openX: ox, openZ: oz, islands: new Int16Array(n),
    };
  }

  function build() {
    const src = ctx.level?.navRegions;
    if (src && src.cols > 0 && src.walkable && src.openX && src.openZ) {
      adopt(src);
      api.source = 'level';
      return true;
    }
    const gen = voxelise();
    if (gen) {
      adopt(gen);
      api.source = 'voxelised';
      return true;
    }
    api.ready = false;
    api.source = 'none';
    return false;
  }

  /* ── line-of-walk ──────────────────────────────────────────────────────── */

  /** Supercover DDA that only crosses *open* edges. */
  function lineClear(ax, az, bx, bz) {
    let k = index(ax, az);
    if (!isWalkableCell(k)) return false;
    const kEnd = index(bx, bz);
    if (!isWalkableCell(kEnd)) return false;
    if (k === kEnd) return true;

    let i = k % cols;
    let j = (k - i) / cols;
    const iE = kEnd % cols;
    const jE = (kEnd - iE) / cols;
    const dx = bx - ax;
    const dz = bz - az;
    const stepI = dx > 0 ? 1 : -1;
    const stepJ = dz > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
    const invDz = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
    // Distance (as a fraction of the segment) to the next vertical / horizontal line.
    const nextX = x0 + (i + (stepI > 0 ? 1 : 0)) * cell;
    const nextZ = z0 + (j + (stepJ > 0 ? 1 : 0)) * cell;
    let tMaxX = dx !== 0 ? Math.abs(nextX - ax) * invDx : Infinity;
    let tMaxZ = dz !== 0 ? Math.abs(nextZ - az) * invDz : Infinity;
    const tDeltaX = cell * invDx;
    const tDeltaZ = cell * invDz;
    let guard = 0;
    const maxSteps = cols + rows + 8;
    while ((i !== iE || j !== jE) && guard++ < maxSteps) {
      if (tMaxX < tMaxZ) {
        if (!isOpen(k, stepI > 0 ? 0 : 1)) return false;
        i += stepI;
        k += stepI;
        tMaxX += tDeltaX;
      } else {
        if (!isOpen(k, stepJ > 0 ? 2 : 3)) return false;
        j += stepJ;
        k += stepJ * cols;
        tMaxZ += tDeltaZ;
      }
      if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
      if (!walkable[k]) return false;
    }
    return guard < maxSteps;
  }

  /** Line-of-walk for a body of `radius`: the centre line plus two offset rails. */
  function canWalkLine(ax, az, bx, bz, radius = 0.34) {
    if (!api.ready) return true;
    if (!lineClear(ax, az, bx, bz)) return false;
    if (radius <= 0.05) return true;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return true;
    const nx = (-dz / len) * radius;
    const nz = (dx / len) * radius;
    return (
      lineClear(ax + nx, az + nz, bx + nx, bz + nz) &&
      lineClear(ax - nx, az - nz, bx - nx, bz - nz)
    );
  }

  /* ── A* ────────────────────────────────────────────────────────────────── */

  const NB_DI = [1, -1, 0, 0, 1, 1, -1, -1];
  const NB_DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  const _cellsOut = [];

  function heuristic(i, j, ti, tj) {
    const dx = Math.abs(i - ti);
    const dz = Math.abs(j - tj);
    const mn = dx < dz ? dx : dz;
    return (dx + dz - 2 * mn + SQRT2 * mn) * cell;
  }

  /**
   * @returns {number[]} cell indices start..goal, or [] on failure. `opts.maxNodes`
   * bounds the search so a hopeless request cannot eat a frame.
   */
  function astar(start, goal, opts) {
    const maxNodes = opts?.maxNodes ?? 2400;
    const spread = opts?.spread ?? 0;
    _cellsOut.length = 0;
    if (start < 0 || goal < 0) return _cellsOut;
    if (start === goal) {
      _cellsOut.push(start);
      return _cellsOut;
    }
    stampVal++;
    if (stampVal === 0xffffffff) {
      stamp.fill(0);
      stampVal = 1;
    }
    heap.clear();
    const ti = goal % cols;
    const tj = (goal - ti) / cols;
    gScore[start] = 0;
    cameFrom[start] = -1;
    stamp[start] = stampVal;
    heap.push(start, heuristic(start % cols, (start - (start % cols)) / cols, ti, tj));

    let expanded = 0;
    let best = start;
    let bestH = Infinity;
    while (heap.n > 0 && expanded < maxNodes) {
      const k = heap.pop();
      if (k === goal) {
        best = goal;
        bestH = -1;
        break;
      }
      expanded++;
      const i = k % cols;
      const j = (k - i) / cols;
      const h = heuristic(i, j, ti, tj);
      if (h < bestH) {
        bestH = h;
        best = k;
      }
      const gk = gScore[k];
      for (let d = 0; d < 8; d++) {
        const ni = i + NB_DI[d];
        const nj = j + NB_DJ[d];
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
        const nk = nj * cols + ni;
        if (!walkable[nk]) continue;
        let step;
        if (d < 4) {
          if (!isOpen(k, d)) continue;
          step = cell;
        } else {
          // A diagonal is only legal if both orthogonal legs of the corner are open,
          // otherwise a bot slips through the gap between two barriers.
          const dirI = NB_DI[d] > 0 ? 0 : 1;
          const dirJ = NB_DJ[d] > 0 ? 2 : 3;
          const viaI = k + NB_DI[d];
          const viaJ = k + NB_DJ[d] * cols;
          const okA = isOpen(k, dirI) && walkable[viaI] && isOpen(viaI, dirJ);
          const okB = isOpen(k, dirJ) && walkable[viaJ] && isOpen(viaJ, dirI);
          if (!okA || !okB) continue;
          step = cell * SQRT2;
        }
        const cost = gk + step * (1 + extraCost[nk] * spread);
        if (stamp[nk] === stampVal && cost >= gScore[nk]) continue;
        stamp[nk] = stampVal;
        gScore[nk] = cost;
        cameFrom[nk] = k;
        heap.push(nk, cost + heuristic(ni, nj, ti, tj));
      }
    }

    let cur = bestH === -1 ? goal : best;
    if (stamp[cur] !== stampVal) return _cellsOut;
    while (cur !== -1) {
      _cellsOut.push(cur);
      cur = cameFrom[cur];
      if (_cellsOut.length > cols * rows) break;
    }
    _cellsOut.reverse();
    return _cellsOut;
  }

  /* ── funnel ────────────────────────────────────────────────────────────── */

  const _portL = [];
  const _portR = [];

  /** Shared-edge portals for a corridor of cells, inset by the agent radius. */
  function buildPortals(cells, radius) {
    _portL.length = 0;
    _portR.length = 0;
    const inset = Math.min(radius, cell * 0.42);
    for (let n = 0; n < cells.length - 1; n++) {
      const a = cells[n];
      const b = cells[n + 1];
      const ai = a % cols;
      const aj = (a - ai) / cols;
      const bi = b % cols;
      const bj = (b - bi) / cols;
      const di = bi - ai;
      const dj = bj - aj;
      const ex = x0 + (Math.max(ai, bi)) * cell;
      const ez = z0 + (Math.max(aj, bj)) * cell;
      if (di !== 0 && dj === 0) {
        const zc0 = z0 + aj * cell + inset;
        const zc1 = z0 + (aj + 1) * cell - inset;
        if (di > 0) {
          _portL.push(ex, zc1);
          _portR.push(ex, zc0);
        } else {
          _portL.push(ex, zc0);
          _portR.push(ex, zc1);
        }
      } else if (dj !== 0 && di === 0) {
        const xc0 = x0 + ai * cell + inset;
        const xc1 = x0 + (ai + 1) * cell - inset;
        if (dj > 0) {
          _portL.push(xc0, ez);
          _portR.push(xc1, ez);
        } else {
          _portL.push(xc1, ez);
          _portR.push(xc0, ez);
        }
      } else {
        // Diagonal: the corner point is the whole portal.
        const cx = x0 + (Math.max(ai, bi)) * cell;
        const cz = z0 + (Math.max(aj, bj)) * cell;
        _portL.push(cx, cz);
        _portR.push(cx, cz);
      }
    }
  }

  const cross2 = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

  /** Simple stupid funnel algorithm over the portal list. */
  function funnel(startX, startZ, endX, endZ, out) {
    const nPort = _portL.length / 2;
    out.length = 0;
    out.push(startX, startZ);
    let apexX = startX;
    let apexZ = startZ;
    let lX = startX;
    let lZ = startZ;
    let rX = startX;
    let rZ = startZ;
    let apexI = 0;
    let lI = 0;
    let rI = 0;
    // Degenerate (zero-width) portals from diagonal steps can make the classic
    // restart-at-apex loop spin; a hard iteration budget keeps it honest.
    let guard = 0;
    const guardMax = nPort * 4 + 32;
    for (let i = 0; i <= nPort && guard < guardMax; i++) {
      guard++;
      const pLx = i < nPort ? _portL[i * 2] : endX;
      const pLz = i < nPort ? _portL[i * 2 + 1] : endZ;
      const pRx = i < nPort ? _portR[i * 2] : endX;
      const pRz = i < nPort ? _portR[i * 2 + 1] : endZ;

      // Right side.
      if (cross2(apexX, apexZ, rX, rZ, pRx, pRz) <= 0) {
        if (apexX === rX && apexZ === rZ) {
          rX = pRx; rZ = pRz; rI = i;
        } else if (cross2(apexX, apexZ, lX, lZ, pRx, pRz) > 0) {
          rX = pRx; rZ = pRz; rI = i;
        } else {
          out.push(lX, lZ);
          apexX = lX; apexZ = lZ; apexI = lI;
          lX = apexX; lZ = apexZ; rX = apexX; rZ = apexZ;
          lI = apexI; rI = apexI;
          i = apexI;
          continue;
        }
      }
      // Left side.
      if (cross2(apexX, apexZ, lX, lZ, pLx, pLz) >= 0) {
        if (apexX === lX && apexZ === lZ) {
          lX = pLx; lZ = pLz; lI = i;
        } else if (cross2(apexX, apexZ, rX, rZ, pLx, pLz) < 0) {
          lX = pLx; lZ = pLz; lI = i;
        } else {
          out.push(rX, rZ);
          apexX = rX; apexZ = rZ; apexI = rI;
          lX = apexX; lZ = apexZ; rX = apexX; rZ = apexZ;
          lI = apexI; rI = apexI;
          i = apexI;
          continue;
        }
      }
    }
    out.push(endX, endZ);
    return out;
  }

  /* ── public path query ─────────────────────────────────────────────────── */

  const _funnelOut = [];

  /**
   * @param {{x,y,z}} from @param {{x,y,z}} to
   * @param {{radius?:number, maxNodes?:number, spread?:number, snap?:number}} [opts]
   */
  function findPath(from, to, opts = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const radius = opts.radius ?? 0.34;
    const result = { points: [], cells: null, length: 0, partial: false, ok: false };
    if (!api.ready || !from || !to) return result;
    const sk = nearestWalkable(from.x, from.z, opts.snap ?? 6);
    const gk = nearestWalkable(to.x, to.z, opts.snap ?? 8);
    if (sk < 0 || gk < 0) {
      api.stats.failures++;
      return result;
    }
    const cells = astar(sk, gk, opts);
    if (!cells.length) {
      api.stats.failures++;
      return result;
    }
    result.partial = cells[cells.length - 1] !== gk;

    // Endpoints: clamp the true start/goal into their cells so the funnel is stable.
    const sC = cellCentre(cells[0], _v);
    const gC = cellCentre(cells[cells.length - 1], _v2);
    const sx = clamp(from.x, sC.x - cell * 0.45, sC.x + cell * 0.45);
    const sz = clamp(from.z, sC.z - cell * 0.45, sC.z + cell * 0.45);
    const ex = result.partial ? gC.x : clamp(to.x, gC.x - cell * 0.45, gC.x + cell * 0.45);
    const ez = result.partial ? gC.z : clamp(to.z, gC.z - cell * 0.45, gC.z + cell * 0.45);

    buildPortals(cells, radius);
    funnel(sx, sz, ex, ez, _funnelOut);

    // String pull: drop any waypoint the body can simply walk past.
    const pts = [];
    let ci = 0;
    pts.push(_funnelOut[0], _funnelOut[1]);
    const count = _funnelOut.length / 2;
    while (ci < count - 1) {
      let far = ci + 1;
      for (let j = count - 1; j > ci + 1; j--) {
        if (canWalkLine(_funnelOut[ci * 2], _funnelOut[ci * 2 + 1], _funnelOut[j * 2], _funnelOut[j * 2 + 1], radius)) {
          far = j;
          break;
        }
      }
      pts.push(_funnelOut[far * 2], _funnelOut[far * 2 + 1]);
      ci = far;
    }

    let len = 0;
    const out = [];
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i];
      const z = pts[i + 1];
      const k = index(x, z);
      const y = (k >= 0 && walkable[k] ? floor[k] : (ctx.level?.groundY?.(x, z) ?? 0));
      const p = new THREE.Vector3(x, y, z);
      if (out.length) len += p.distanceTo(out[out.length - 1]);
      out.push(p);
    }
    result.points = out;
    result.cells = Int32Array.from(cells);
    result.length = len;
    result.ok = out.length > 0;
    api.stats.paths++;
    api.stats.pathCells += cells.length;
    api.stats.pathMs += (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    return result;
  }

  /* ── sampling & cover ──────────────────────────────────────────────────── */

  /** Walkable cells in an annulus around (x,z). Deterministic ordering. */
  function sampleCells(x, z, minR, maxR, n = 16, rng) {
    const out = [];
    const r0 = Math.max(0, minR);
    const r1 = Math.max(r0 + cell, maxR);
    const tries = n * 3;
    const jitter = rng || (() => 0.5);
    for (let t = 0; t < tries && out.length < n; t++) {
      const a = (t / tries) * Math.PI * 2 + jitter() * 0.9;
      const r = r0 + (r1 - r0) * (0.35 + 0.65 * jitter());
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      const k = index(px, pz);
      if (k < 0 || !walkable[k]) continue;
      if (out.indexOf(k) >= 0) continue;
      out.push(k);
    }
    return out;
  }

  function losBlocked(from, to) {
    const phys = ctx.physics;
    if (!phys?.raycast) return false;
    _dir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const d = _dir.length();
    if (d < 0.05) return false;
    _dir.multiplyScalar(1 / d);
    const hit = phys.raycast(from, _dir, d - 0.05, WORLD_MASK);
    return !!hit;
  }

  const _from = new THREE.Vector3();
  const _to = new THREE.Vector3();

  /**
   * Cover candidates: cells where geometry sits between the threat's eye and a
   * standing (or at least crouching) body. Scored for proximity, cover quality and
   * a preference for keeping the threat in front, not behind.
   *
   * @param {{x,y,z}} anchor  where the bot is / wants to stay near
   * @param {{x,y,z}} threat  the eye position to hide from
   */
  function coverPoints(anchor, threat, opts = {}) {
    const out = [];
    if (!api.ready || !anchor || !threat) return out;
    api.stats.coverQueries++;
    const minR = opts.minRadius ?? 1.0;
    const maxR = opts.maxRadius ?? 12;
    const want = opts.samples ?? 14;
    const rng = opts.rng;
    const cells = sampleCells(anchor.x, anchor.z, minR, maxR, want, rng);
    const keepAway = opts.minThreatDistance ?? 4.0;
    const idealRange = opts.idealRange ?? 16;
    _from.set(threat.x, threat.y, threat.z);
    for (const k of cells) {
      if (claimed.has(k) && claimed.get(k) !== opts.owner) continue;
      const c = cellCentre(k, new THREE.Vector3());
      const dThreat = Math.hypot(c.x - threat.x, c.z - threat.z);
      if (dThreat < keepAway) continue;
      _to.set(c.x, c.y + 1.55, c.z);
      const standBlocked = losBlocked(_from, _to);
      _to.set(c.x, c.y + 0.95, c.z);
      const crouchBlocked = losBlocked(_from, _to);
      if (!crouchBlocked && !standBlocked) continue;
      const kind = standBlocked && crouchBlocked ? 'full' : 'crouch';
      const exposure = crouchBlocked ? (standBlocked ? 0 : 0.45) : 1;
      const dSelf = Math.hypot(c.x - anchor.x, c.z - anchor.z);
      let score = (kind === 'full' ? 2.2 : 1.4);
      score -= dSelf * 0.075;
      score -= Math.abs(dThreat - idealRange) * 0.035;
      // Prefer a spot the bot can actually reach without a long detour.
      if (!canWalkLine(anchor.x, anchor.z, c.x, c.z, 0.34)) score -= 0.55;
      out.push({ pos: c, cell: k, score, kind, exposure, distance: dSelf, threatDistance: dThreat });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /* ── local steering ────────────────────────────────────────────────────── */

  const _steer = new THREE.Vector3();
  const _probe = new THREE.Vector3();

  /**
   * Blend the desired direction with separation from the other agents and a short
   * wall whisker, so bots do not clump, push through each other, or scrape corners.
   * @returns {THREE.Vector3} `out`, normalised (or zero if fully blocked)
   */
  function avoid(agent, desired, agents, dt, out) {
    const o = out || new THREE.Vector3();
    o.copy(desired);
    o.y = 0;
    if (o.lengthSq() < 1e-8) return o.set(0, 0, 0);
    o.normalize();
    const px = agent.position.x;
    const pz = agent.position.z;
    const radius = agent.radius ?? 0.36;

    // Separation.
    _steer.set(0, 0, 0);
    if (agents) {
      for (let i = 0; i < agents.length; i++) {
        const b = agents[i];
        if (b === agent || b.alive === false) continue;
        const dx = px - b.position.x;
        const dz = pz - b.position.z;
        const d2 = dx * dx + dz * dz;
        const want = radius + (b.radius ?? 0.36) + 0.42;
        if (d2 > want * want || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (1 - d / want);
        _steer.x += (dx / d) * push;
        _steer.z += (dz / d) * push;
      }
    }
    if (_steer.lengthSq() > 1e-8) {
      o.addScaledVector(_steer, 1.35).normalize();
    }

    // Wall whiskers: if the path ahead is blocked, rotate to the freer side.
    if (api.ready) {
      const look = 1.15;
      const ahead = canWalkLine(px, pz, px + o.x * look, pz + o.z * look, radius * 0.9);
      if (!ahead) {
        let bestAng = 0;
        let found = false;
        for (const ang of [0.6, -0.6, 1.15, -1.15, 1.9, -1.9, 2.6, -2.6]) {
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const nx = o.x * ca - o.z * sa;
          const nz = o.x * sa + o.z * ca;
          if (canWalkLine(px, pz, px + nx * look, pz + nz * look, radius * 0.9)) {
            bestAng = ang;
            found = true;
            break;
          }
        }
        if (found) {
          const ca = Math.cos(bestAng);
          const sa = Math.sin(bestAng);
          const nx = o.x * ca - o.z * sa;
          const nz = o.x * sa + o.z * ca;
          o.set(nx, 0, nz).normalize();
        } else {
          o.set(0, 0, 0);
        }
      }
    }
    void dt;
    void _probe;
    return o;
  }

  /* ── lane claims (squad spreading) ─────────────────────────────────────── */

  function claim(k, owner) {
    if (k < 0) return;
    release(owner);
    claimed.set(k, owner);
    ownerCell.set(owner, k);
    if (extraCost) {
      // Bias other bots' A* away from a claimed lane so they pick a different route.
      const i = k % cols;
      const j = (k - i) / cols;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          extraCost[nj * cols + ni] = Math.min(1.6, extraCost[nj * cols + ni] + 0.5);
        }
      }
    }
  }

  function release(owner) {
    const k = ownerCell.get(owner);
    if (k === undefined) return;
    ownerCell.delete(owner);
    if (claimed.get(k) === owner) claimed.delete(k);
    if (extraCost) {
      const i = k % cols;
      const j = (k - i) / cols;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ni = i + di;
          const nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const kk = nj * cols + ni;
          extraCost[kk] = Math.max(0, extraCost[kk] - 0.5);
        }
      }
    }
  }

  /* ── debug ─────────────────────────────────────────────────────────────── */

  let debugGroup = null;
  let pathLines = null;
  let debugPaths = [];

  function buildDebugMesh() {
    const g = new THREE.Group();
    g.name = 'navmesh_debug';
    const verts = [];
    const colors = [];
    for (let k = 0; k < cols * rows; k++) {
      if (!walkable[k]) continue;
      const i = k % cols;
      const j = (k - i) / cols;
      const cx = x0 + (i + 0.5) * cell;
      const cz = z0 + (j + 0.5) * cell;
      const y = floor[k] + 0.04;
      const h = cell * 0.42;
      const cost = Math.min(1, extraCost[k]);
      const r = 0.15 + cost * 0.7;
      const gg = 0.75 - cost * 0.5;
      // Cell quad outline.
      const corners = [
        [cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h],
      ];
      for (let c = 0; c < 4; c++) {
        const a = corners[c];
        const b = corners[(c + 1) % 4];
        verts.push(a[0], y, a[1], b[0], y, b[1]);
        colors.push(r, gg, 0.35, r, gg, 0.35);
      }
      // Open edges as spurs so connectivity is visible.
      if (isOpen(k, 0)) {
        verts.push(cx, y, cz, cx + cell * 0.5, y, cz);
        colors.push(0.2, 0.9, 0.4, 0.2, 0.9, 0.4);
      }
      if (isOpen(k, 2)) {
        verts.push(cx, y, cz, cx, y, cz + cell * 0.5);
        colors.push(0.2, 0.9, 0.4, 0.2, 0.9, 0.4);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false });
    g.add(new THREE.LineSegments(geo, mat));

    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4096 * 3), 3));
    const pmat = new THREE.LineBasicMaterial({ color: 0xffc040, depthTest: false, transparent: true, opacity: 0.9 });
    pathLines = new THREE.LineSegments(pgeo, pmat);
    pathLines.renderOrder = 999;
    pathLines.frustumCulled = false;
    g.add(pathLines);
    return g;
  }

  function debugDraw(scene, on) {
    if (!scene || !api.ready) return null;
    if (on) {
      if (!debugGroup) debugGroup = buildDebugMesh();
      if (!debugGroup.parent) scene.add(debugGroup);
    } else if (debugGroup?.parent) {
      debugGroup.removeFromParent();
    }
    return debugGroup;
  }

  function setDebugPaths(list) {
    debugPaths = list || [];
    if (!pathLines || !debugGroup?.parent) return;
    const arr = pathLines.geometry.attributes.position.array;
    let n = 0;
    for (const path of debugPaths) {
      const pts = path?.points;
      if (!pts || pts.length < 2) continue;
      for (let i = 0; i < pts.length - 1 && n + 6 <= arr.length; i++) {
        arr[n++] = pts[i].x; arr[n++] = pts[i].y + 0.28; arr[n++] = pts[i].z;
        arr[n++] = pts[i + 1].x; arr[n++] = pts[i + 1].y + 0.28; arr[n++] = pts[i + 1].z;
      }
    }
    pathLines.geometry.setDrawRange(0, n / 3);
    pathLines.geometry.attributes.position.needsUpdate = true;
  }

  /* ── exports ───────────────────────────────────────────────────────────── */

  Object.assign(api, {
    build,
    index,
    cellCentre,
    isWalkableCell,
    isWalkable: (x, z) => isWalkableCell(index(x, z)),
    floorAt: (x, z) => {
      const k = index(x, z);
      return k >= 0 && walkable[k] ? floor[k] : (ctx.level?.groundY?.(x, z) ?? 0);
    },
    /**
     * Bilinear floor height over the four surrounding cell centres. Cell floors are
     * piecewise constant, and walking on that reads as a bot climbing invisible steps
     * every two metres; interpolating between the *walkable* neighbours fixes it while
     * still refusing to average in a rooftop that happens to be next door.
     */
    groundAt(x, z) {
      if (!api.ready) return ctx.level?.groundY?.(x, z) ?? 0;
      const fx = (x - x0) / cell - 0.5;
      const fz = (z - z0) / cell - 0.5;
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fz);
      const tx = fx - i0;
      const tz = fz - j0;
      const base = index(x, z);
      const ref = base >= 0 && walkable[base] ? floor[base] : (ctx.level?.groundY?.(x, z) ?? 0);
      let sum = 0;
      let wsum = 0;
      for (let dj = 0; dj <= 1; dj++) {
        for (let di = 0; di <= 1; di++) {
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
          const k = j * cols + i;
          if (!walkable[k]) continue;
          if (Math.abs(floor[k] - ref) > 0.75) continue; // different deck, do not blend
          const w = (di ? tx : 1 - tx) * (dj ? tz : 1 - tz);
          sum += floor[k] * w;
          wsum += w;
        }
      }
      return wsum > 1e-4 ? sum / wsum : ref;
    },
    clearanceAt: (x, z) => {
      const k = index(x, z);
      return k >= 0 ? clearance[k] : 0;
    },
    islandOf: (x, z) => {
      const k = index(x, z);
      return k >= 0 && islands ? islands[k] : -1;
    },
    sameIsland: (a, b) => {
      if (!islands) return true;
      const ka = index(a.x, a.z);
      const kb = index(b.x, b.z);
      if (ka < 0 || kb < 0) return false;
      return islands[ka] === islands[kb];
    },
    nearestWalkable,
    findPath,
    canWalkLine,
    lineClear,
    sampleCells,
    coverPoints,
    losBlocked,
    avoid,
    claim,
    release,
    isClaimed: (k, owner) => claimed.has(k) && claimed.get(k) !== owner,
    debugDraw,
    setDebugPaths,
    get raw() { return nav; },
    dispose() {
      if (debugGroup) {
        debugGroup.removeFromParent();
        debugGroup.traverse((o) => {
          o.geometry?.dispose?.();
          o.material?.dispose?.();
        });
        debugGroup = null;
        pathLines = null;
      }
      claimed.clear();
      ownerCell.clear();
    },
  });

  return api;
}
