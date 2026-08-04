/**
 * Broadphase.js — dynamic AABB tree (BVH) with a sweep-and-prune fallback.
 * Owner: physics agent. Internal to src/physics/*.
 *
 * Public API
 *   new DynamicAABBTree(margin)
 *     createProxy(min[3], max[3], userData) -> id
 *     destroyProxy(id)
 *     moveProxy(id, min, max, velX, velY, velZ) -> boolean   (true if the fat box was rebuilt)
 *     query(minx,miny,minz,maxx,maxy,maxz, cb)               cb(userData, proxyId)
 *     raycast(ox,oy,oz,dx,dy,dz,maxT, cb)                    cb(userData, proxyId) -> new maxT
 *   new SweepAndPrune()   same surface, O(n log n) sort-based; used when
 *                         `physics.broadphase = 'sap'` or as a safety net.
 *   new Broadphase(opts)  owns one static tree + one dynamic tree and produces the
 *                         per-step candidate pair list.
 *
 * Design notes
 *   - Static geometry lives in its own tree with a zero margin and is never re-fitted,
 *     so thousands of level colliders cost nothing per frame — only the ~200 dynamic
 *     proxies are queried against it.
 *   - Dynamic proxies are stored with a *fat* AABB (margin + velocity prediction) so a
 *     body only touches the tree when it leaves its enlarged box. Typical re-insert
 *     rate at 120 Hz is a few percent of the dynamic set.
 *   - Everything lives in typed arrays: no allocation, no GC, and the traversal order
 *     is a pure function of the insertion history, which is what makes the whole
 *     simulation reproducible.
 */

const NULL_NODE = -1;


export class DynamicAABBTree {
  constructor(margin = 0.08, capacity = 256) {
    this.margin = margin;
    this._cap = Math.max(16, capacity);
    this._alloc(this._cap);
    this.root = NULL_NODE;
    this.count = 0;
    this._stack = new Int32Array(256);
  }

  _alloc(cap) {
    const old = this.aabb;
    this.aabb = new Float64Array(cap * 6);
    this.parent = new Int32Array(cap);
    this.child1 = new Int32Array(cap);
    this.child2 = new Int32Array(cap);
    this.height = new Int32Array(cap);
    this.user = new Array(cap).fill(null);
    if (old) {
      this.aabb.set(old);
      this.parent.set(this._oldParent);
      this.child1.set(this._oldChild1);
      this.child2.set(this._oldChild2);
      this.height.set(this._oldHeight);
      for (let i = 0; i < this._oldUser.length; i++) this.user[i] = this._oldUser[i];
    }
    // Free list threading through `parent`.
    const start = old ? this._cap : 0;
    for (let i = start; i < cap; i++) {
      this.parent[i] = i + 1 < cap ? i + 1 : NULL_NODE;
      this.height[i] = -1;
    }
    this._free = old ? this._cap : 0;
    this._cap = cap;
  }

  _grow() {
    this._oldParent = this.parent;
    this._oldChild1 = this.child1;
    this._oldChild2 = this.child2;
    this._oldHeight = this.height;
    this._oldUser = this.user;
    this._alloc(this._cap * 2);
    this._oldParent = this._oldChild1 = this._oldChild2 = this._oldHeight = this._oldUser = null;
  }

  _allocNode() {
    if (this._free === NULL_NODE) this._grow();
    const id = this._free;
    this._free = this.parent[id];
    this.parent[id] = NULL_NODE;
    this.child1[id] = NULL_NODE;
    this.child2[id] = NULL_NODE;
    this.height[id] = 0;
    this.user[id] = null;
    return id;
  }

  _freeNode(id) {
    this.parent[id] = this._free;
    this.height[id] = -1;
    this.user[id] = null;
    this._free = id;
  }

  createProxy(mnx, mny, mnz, mxx, mxy, mxz, userData) {
    const id = this._allocNode();
    const m = this.margin;
    const a = this.aabb, o = id * 6;
    a[o] = mnx - m; a[o + 1] = mny - m; a[o + 2] = mnz - m;
    a[o + 3] = mxx + m; a[o + 4] = mxy + m; a[o + 5] = mxz + m;
    this.user[id] = userData;
    this.height[id] = 0;
    this._insertLeaf(id);
    this.count++;
    return id;
  }

  destroyProxy(id) {
    if (id < 0 || this.height[id] === -1) return;
    this._removeLeaf(id);
    this._freeNode(id);
    this.count--;
  }

  /** @returns {boolean} true when the proxy left its fat box and was re-inserted. */
  moveProxy(id, mnx, mny, mnz, mxx, mxy, mxz, vx = 0, vy = 0, vz = 0) {
    const a = this.aabb, o = id * 6;
    if (
      mnx >= a[o] && mny >= a[o + 1] && mnz >= a[o + 2] &&
      mxx <= a[o + 3] && mxy <= a[o + 4] && mxz <= a[o + 5]
    ) return false;

    this._removeLeaf(id);
    const m = this.margin;
    let nmnx = mnx - m, nmny = mny - m, nmnz = mnz - m;
    let nmxx = mxx + m, nmxy = mxy + m, nmxz = mxz + m;
    // Predict forward so a fast body does not thrash the tree every step.
    const k = 2;
    if (vx > 0) nmxx += k * vx; else nmnx += k * vx;
    if (vy > 0) nmxy += k * vy; else nmny += k * vy;
    if (vz > 0) nmxz += k * vz; else nmnz += k * vz;
    a[o] = nmnx; a[o + 1] = nmny; a[o + 2] = nmnz;
    a[o + 3] = nmxx; a[o + 4] = nmxy; a[o + 5] = nmxz;
    this._insertLeaf(id);
    return true;
  }

  _insertLeaf(leaf) {
    if (this.root === NULL_NODE) {
      this.root = leaf;
      this.parent[leaf] = NULL_NODE;
      return;
    }
    const a = this.aabb;
    const lo = leaf * 6;
    const lmnx = a[lo], lmny = a[lo + 1], lmnz = a[lo + 2];
    const lmxx = a[lo + 3], lmxy = a[lo + 4], lmxz = a[lo + 5];

    // Branch and bound on surface area.
    let index = this.root;
    while (this.child1[index] !== NULL_NODE) {
      const c1 = this.child1[index], c2 = this.child2[index];
      const area = surface(a, index);
      const combined = combinedSurface(a, index, lmnx, lmny, lmnz, lmxx, lmxy, lmxz);
      const cost = 2 * combined;
      const inheritance = 2 * (combined - area);

      let cost1 = combinedSurface(a, c1, lmnx, lmny, lmnz, lmxx, lmxy, lmxz);
      if (this.child1[c1] !== NULL_NODE) cost1 = cost1 - surface(a, c1);
      cost1 += inheritance;

      let cost2 = combinedSurface(a, c2, lmnx, lmny, lmnz, lmxx, lmxy, lmxz);
      if (this.child1[c2] !== NULL_NODE) cost2 = cost2 - surface(a, c2);
      cost2 += inheritance;

      if (cost < cost1 && cost < cost2) break;
      index = cost1 < cost2 ? c1 : c2;
    }

    const sibling = index;
    const oldParent = this.parent[sibling];
    const newParent = this._allocNode();
    // _allocNode may have reallocated the arrays.
    const A = this.aabb;
    this.parent[newParent] = oldParent;
    this.height[newParent] = this.height[sibling] + 1;
    unionInto(A, newParent, sibling, leaf);

    if (oldParent !== NULL_NODE) {
      if (this.child1[oldParent] === sibling) this.child1[oldParent] = newParent;
      else this.child2[oldParent] = newParent;
    } else {
      this.root = newParent;
    }
    this.child1[newParent] = sibling;
    this.child2[newParent] = leaf;
    this.parent[sibling] = newParent;
    this.parent[leaf] = newParent;

    let i = this.parent[leaf];
    while (i !== NULL_NODE) {
      i = this._balance(i);
      const c1 = this.child1[i], c2 = this.child2[i];
      this.height[i] = 1 + Math.max(this.height[c1], this.height[c2]);
      unionInto(this.aabb, i, c1, c2);
      i = this.parent[i];
    }
  }

  _removeLeaf(leaf) {
    if (leaf === this.root) {
      this.root = NULL_NODE;
      return;
    }
    const parent = this.parent[leaf];
    const grand = this.parent[parent];
    const sibling = this.child1[parent] === leaf ? this.child2[parent] : this.child1[parent];

    if (grand !== NULL_NODE) {
      if (this.child1[grand] === parent) this.child1[grand] = sibling;
      else this.child2[grand] = sibling;
      this.parent[sibling] = grand;
      this._freeNode(parent);
      let i = grand;
      while (i !== NULL_NODE) {
        i = this._balance(i);
        const c1 = this.child1[i], c2 = this.child2[i];
        unionInto(this.aabb, i, c1, c2);
        this.height[i] = 1 + Math.max(this.height[c1], this.height[c2]);
        i = this.parent[i];
      }
    } else {
      this.root = sibling;
      this.parent[sibling] = NULL_NODE;
      this._freeNode(parent);
    }
  }

  /** AVL-style rotation to keep the tree shallow. */
  _balance(iA) {
    if (this.child1[iA] === NULL_NODE || this.height[iA] < 2) return iA;
    const iB = this.child1[iA], iC = this.child2[iA];
    const balance = this.height[iC] - this.height[iB];

    if (balance > 1) {
      const iF = this.child1[iC], iG = this.child2[iC];
      this.child1[iC] = iA;
      this.parent[iC] = this.parent[iA];
      this.parent[iA] = iC;
      if (this.parent[iC] !== NULL_NODE) {
        if (this.child1[this.parent[iC]] === iA) this.child1[this.parent[iC]] = iC;
        else this.child2[this.parent[iC]] = iC;
      } else this.root = iC;
      if (this.height[iF] > this.height[iG]) {
        this.child2[iC] = iF; this.child2[iA] = iG; this.parent[iG] = iA;
        unionInto(this.aabb, iA, iB, iG);
        unionInto(this.aabb, iC, iA, iF);
        this.height[iA] = 1 + Math.max(this.height[iB], this.height[iG]);
        this.height[iC] = 1 + Math.max(this.height[iA], this.height[iF]);
      } else {
        this.child2[iC] = iG; this.child2[iA] = iF; this.parent[iF] = iA;
        unionInto(this.aabb, iA, iB, iF);
        unionInto(this.aabb, iC, iA, iG);
        this.height[iA] = 1 + Math.max(this.height[iB], this.height[iF]);
        this.height[iC] = 1 + Math.max(this.height[iA], this.height[iG]);
      }
      return iC;
    }
    if (balance < -1) {
      const iD = this.child1[iB], iE = this.child2[iB];
      this.child1[iB] = iA;
      this.parent[iB] = this.parent[iA];
      this.parent[iA] = iB;
      if (this.parent[iB] !== NULL_NODE) {
        if (this.child1[this.parent[iB]] === iA) this.child1[this.parent[iB]] = iB;
        else this.child2[this.parent[iB]] = iB;
      } else this.root = iB;
      if (this.height[iD] > this.height[iE]) {
        this.child2[iB] = iD; this.child1[iA] = iE; this.parent[iE] = iA;
        unionInto(this.aabb, iA, iC, iE);
        unionInto(this.aabb, iB, iA, iD);
        this.height[iA] = 1 + Math.max(this.height[iC], this.height[iE]);
        this.height[iB] = 1 + Math.max(this.height[iA], this.height[iD]);
      } else {
        this.child2[iB] = iE; this.child1[iA] = iD; this.parent[iD] = iA;
        unionInto(this.aabb, iA, iC, iD);
        unionInto(this.aabb, iB, iA, iE);
        this.height[iA] = 1 + Math.max(this.height[iC], this.height[iD]);
        this.height[iB] = 1 + Math.max(this.height[iA], this.height[iE]);
      }
      return iB;
    }
    return iA;
  }

  query(mnx, mny, mnz, mxx, mxy, mxz, cb) {
    if (this.root === NULL_NODE) return;
    const st = this._stack;
    const a = this.aabb;
    let sp = 0;
    st[sp++] = this.root;
    while (sp > 0) {
      const n = st[--sp];
      const o = n * 6;
      if (a[o] > mxx || a[o + 3] < mnx || a[o + 1] > mxy || a[o + 4] < mny || a[o + 2] > mxz || a[o + 5] < mnz) {
        continue;
      }
      const c1 = this.child1[n];
      if (c1 === NULL_NODE) {
        cb(this.user[n], n);
      } else if (sp + 2 <= st.length) {
        st[sp++] = c1;
        st[sp++] = this.child2[n];
      }
    }
  }

  raycast(ox, oy, oz, dx, dy, dz, maxT, cb) {
    if (this.root === NULL_NODE) return maxT;
    const invx = dx !== 0 ? 1 / dx : 1e30;
    const invy = dy !== 0 ? 1 / dy : 1e30;
    const invz = dz !== 0 ? 1 / dz : 1e30;
    const st = this._stack;
    const a = this.aabb;
    let sp = 0, best = maxT;
    st[sp++] = this.root;
    while (sp > 0) {
      const n = st[--sp];
      const o = n * 6;
      let t0 = 0, t1 = best;
      let lo = (a[o] - ox) * invx, hi = (a[o + 3] - ox) * invx;
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
      lo = (a[o + 1] - oy) * invy; hi = (a[o + 4] - oy) * invy;
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
      lo = (a[o + 2] - oz) * invz; hi = (a[o + 5] - oz) * invz;
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
      const c1 = this.child1[n];
      if (c1 === NULL_NODE) {
        const r = cb(this.user[n], n);
        if (typeof r === 'number' && r < best) best = r;
      } else if (sp + 2 <= st.length) {
        st[sp++] = c1;
        st[sp++] = this.child2[n];
      }
    }
    return best;
  }

  clear() {
    this.root = NULL_NODE;
    this.count = 0;
    for (let i = 0; i < this._cap; i++) {
      this.parent[i] = i + 1 < this._cap ? i + 1 : NULL_NODE;
      this.height[i] = -1;
      this.user[i] = null;
    }
    this._free = 0;
  }

  /** Copy a proxy's stored fat AABB into out[0..5]. */
  getFatAABB(id, out) {
    const o = id * 6, a = this.aabb;
    out[0] = a[o]; out[1] = a[o + 1]; out[2] = a[o + 2];
    out[3] = a[o + 3]; out[4] = a[o + 4]; out[5] = a[o + 5];
    return out;
  }

  /** Max tree depth — useful for the debug HUD. */
  get depth() {
    return this.root === NULL_NODE ? 0 : this.height[this.root];
  }
}

function surface(a, i) {
  const o = i * 6;
  const dx = a[o + 3] - a[o], dy = a[o + 4] - a[o + 1], dz = a[o + 5] - a[o + 2];
  return 2 * (dx * dy + dy * dz + dz * dx);
}

function combinedSurface(a, i, mnx, mny, mnz, mxx, mxy, mxz) {
  const o = i * 6;
  const dx = Math.max(a[o + 3], mxx) - Math.min(a[o], mnx);
  const dy = Math.max(a[o + 4], mxy) - Math.min(a[o + 1], mny);
  const dz = Math.max(a[o + 5], mxz) - Math.min(a[o + 2], mnz);
  return 2 * (dx * dy + dy * dz + dz * dx);
}

function unionInto(a, dst, i, j) {
  const o = dst * 6, oi = i * 6, oj = j * 6;
  a[o] = Math.min(a[oi], a[oj]);
  a[o + 1] = Math.min(a[oi + 1], a[oj + 1]);
  a[o + 2] = Math.min(a[oi + 2], a[oj + 2]);
  a[o + 3] = Math.max(a[oi + 3], a[oj + 3]);
  a[o + 4] = Math.max(a[oi + 4], a[oj + 4]);
  a[o + 5] = Math.max(a[oi + 5], a[oj + 5]);
}

/* ------------------------------------------------------------------ *
 * Sweep and prune fallback
 * ------------------------------------------------------------------ */

/**
 * Single-axis SAP with an insertion-sorted endpoint list. Slower asymptotically than
 * the tree for big static sets, but it has no rebuild cost and is a useful
 * cross-check when a tree bug is suspected (`physics.setBroadphase('sap')`).
 */
export class SweepAndPrune {
  constructor(margin = 0.08) {
    this.margin = margin;
    this.aabb = new Float64Array(64 * 6);
    this.user = [];
    this.alive = [];
    this.order = [];
    this._freeIds = [];
    this.count = 0;
  }

  _ensure(id) {
    if ((id + 1) * 6 <= this.aabb.length) return;
    const next = new Float64Array(Math.max((id + 1) * 6, this.aabb.length * 2));
    next.set(this.aabb);
    this.aabb = next;
  }

  createProxy(mnx, mny, mnz, mxx, mxy, mxz, userData) {
    const id = this._freeIds.length ? this._freeIds.pop() : this.user.length;
    this._ensure(id);
    const o = id * 6, m = this.margin;
    this.aabb[o] = mnx - m; this.aabb[o + 1] = mny - m; this.aabb[o + 2] = mnz - m;
    this.aabb[o + 3] = mxx + m; this.aabb[o + 4] = mxy + m; this.aabb[o + 5] = mxz + m;
    this.user[id] = userData;
    this.alive[id] = true;
    this.order.push(id);
    this.count++;
    return id;
  }

  destroyProxy(id) {
    if (!this.alive[id]) return;
    this.alive[id] = false;
    this.user[id] = null;
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    this._freeIds.push(id);
    this.count--;
  }

  moveProxy(id, mnx, mny, mnz, mxx, mxy, mxz) {
    const o = id * 6, m = this.margin;
    this.aabb[o] = mnx - m; this.aabb[o + 1] = mny - m; this.aabb[o + 2] = mnz - m;
    this.aabb[o + 3] = mxx + m; this.aabb[o + 4] = mxy + m; this.aabb[o + 5] = mxz + m;
    return true;
  }

  /** Insertion sort on min-X: nearly free when the set is already coherent. */
  _sort() {
    const ord = this.order, a = this.aabb;
    for (let i = 1; i < ord.length; i++) {
      const v = ord[i];
      const key = a[v * 6];
      let j = i - 1;
      while (j >= 0 && (a[ord[j] * 6] > key || (a[ord[j] * 6] === key && ord[j] > v))) {
        ord[j + 1] = ord[j];
        j--;
      }
      ord[j + 1] = v;
    }
  }

  query(mnx, mny, mnz, mxx, mxy, mxz, cb) {
    const a = this.aabb;
    for (let i = 0; i < this.order.length; i++) {
      const id = this.order[i];
      const o = id * 6;
      if (a[o] > mxx) break;
      if (a[o + 3] < mnx || a[o + 1] > mxy || a[o + 4] < mny || a[o + 2] > mxz || a[o + 5] < mnz) continue;
      cb(this.user[id], id);
    }
  }

  raycast(ox, oy, oz, dx, dy, dz, maxT, cb) {
    let best = maxT;
    const a = this.aabb;
    for (let i = 0; i < this.order.length; i++) {
      const id = this.order[i];
      const o = id * 6;
      if (!slabHit(a, o, ox, oy, oz, dx, dy, dz, best)) continue;
      const r = cb(this.user[id], id);
      if (typeof r === 'number' && r < best) best = r;
    }
    return best;
  }

  getFatAABB(id, out) {
    const o = id * 6, a = this.aabb;
    out[0] = a[o]; out[1] = a[o + 1]; out[2] = a[o + 2];
    out[3] = a[o + 3]; out[4] = a[o + 4]; out[5] = a[o + 5];
    return out;
  }

  clear() {
    this.order.length = 0;
    this.user.length = 0;
    this.alive.length = 0;
    this._freeIds.length = 0;
    this.count = 0;
  }

  get depth() { return 1; }
}

function slabHit(a, o, ox, oy, oz, dx, dy, dz, maxT) {
  let t0 = 0, t1 = maxT;
  const invx = dx !== 0 ? 1 / dx : 1e30;
  const invy = dy !== 0 ? 1 / dy : 1e30;
  const invz = dz !== 0 ? 1 / dz : 1e30;
  let lo = (a[o] - ox) * invx, hi = (a[o + 3] - ox) * invx;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
  lo = (a[o + 1] - oy) * invy; hi = (a[o + 4] - oy) * invy;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
  lo = (a[o + 2] - oz) * invz; hi = (a[o + 5] - oz) * invz;
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
  return t0 <= t1;
}

/* ------------------------------------------------------------------ *
 * Broadphase — static tree + dynamic tree + pair generation
 * ------------------------------------------------------------------ */

export class Broadphase {
  constructor({ margin = 0.08, kind = 'tree' } = {}) {
    this.kind = kind;
    const Impl = kind === 'sap' ? SweepAndPrune : DynamicAABBTree;
    this.staticTree = new Impl(0.001, 4096);
    this.dynamicTree = new Impl(margin, 512);
    /** @type {any[]} */
    this.pairA = [];
    /** @type {any[]} */
    this.pairB = [];
    this.pairCount = 0;
    this.stats = { queries: 0, candidates: 0, moved: 0, cachedStatics: 0 };
    this._self = null;
    /** bumped whenever the static set changes, invalidating every per-body cache */
    this.staticEpoch = 1;
    this._onLeaf = (other) => this._collect(other);
    this._onStaticLeaf = (other) => this._collectStatic(other);
    this._fat = new Float64Array(6);
  }

  addProxy(body) {
    const tree = body.isStatic ? this.staticTree : this.dynamicTree;
    body.proxyId = tree.createProxy(
      body.aabbMin.x, body.aabbMin.y, body.aabbMin.z,
      body.aabbMax.x, body.aabbMax.y, body.aabbMax.z,
      body
    );
    body.proxyStatic = body.isStatic;
    if (body.isStatic) this.staticEpoch++;
    else { body._staticCache = null; body._staticEpoch = 0; }
    return body.proxyId;
  }

  removeProxy(body) {
    if (body.proxyId === undefined || body.proxyId < 0) return;
    const tree = body.proxyStatic ? this.staticTree : this.dynamicTree;
    tree.destroyProxy(body.proxyId);
    body.proxyId = -1;
    if (body.proxyStatic) this.staticEpoch++;
  }

  updateProxy(body, vx = 0, vy = 0, vz = 0) {
    if (body.proxyId === undefined || body.proxyId < 0) return false;
    const tree = body.proxyStatic ? this.staticTree : this.dynamicTree;
    const moved = tree.moveProxy(
      body.proxyId,
      body.aabbMin.x, body.aabbMin.y, body.aabbMin.z,
      body.aabbMax.x, body.aabbMax.y, body.aabbMax.z,
      vx, vy, vz
    );
    if (moved) {
      this.stats.moved++;
      body._staticCache = null; // left its fat box: the static neighbour list is stale
    }
    return moved;
  }

  /** Collect into the querying body's cached static-neighbour list. */
  _collectStatic(other) {
    const self = this._self;
    if (other === null || other === self) return;
    if ((self.group & other.mask) === 0 || (other.group & self.mask) === 0) return;
    if (self.ignore !== null && self.ignore.has(other.id)) return;
    if (other.ignore !== null && other.ignore.has(self.id)) return;
    self._staticCache.push(other);
  }

  _collect(other) {
    const self = this._self;
    if (other === self || other === null) return;
    // Ordering rule: statics always attach to the querying dynamic body; two awake
    // dynamics are emitted once by the lower-index one; a sleeping body is emitted
    // by its awake partner. Two sleeping bodies produce nothing (nothing to solve).
    if (!other.isStatic) {
      if (other.awake && self.awake) {
        if (other._index <= self._index) return;
      } else if (!self.awake) {
        return;
      }
    }
    if ((self.group & other.mask) === 0 || (other.group & self.mask) === 0) return;
    // Explicit exclusions: jointed ragdoll bones, weapon-vs-owner, etc.
    if (self.ignore !== null && self.ignore.has(other.id)) return;
    if (other.ignore !== null && other.ignore.has(self.id)) return;
    const a = self.id <= other.id ? self : other;
    const b = self.id <= other.id ? other : self;
    if (a.isStatic && b.isStatic) return;
    const n = this.pairCount++;
    this.pairA[n] = a;
    this.pairB[n] = b;
    this.stats.candidates++;
  }

  /**
   * @param {Array} bodies dynamic bodies in stable index order
   */
  computePairs(bodies) {
    this.pairCount = 0;
    this.stats.queries = 0;
    this.stats.candidates = 0;
    if (this.kind === 'sap') {
      this.staticTree._sort?.();
      this.dynamicTree._sort?.();
    }
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.isStatic) continue;
      // Sleeping bodies never query; an awake neighbour finds them from its side.
      if (!b.awake) continue;
      this._self = b;
      const mn = b.aabbMin, mx = b.aabbMax;
      const m = 0.02;
      this.stats.queries++;
      this.dynamicTree.query(mn.x - m, mn.y - m, mn.z - m, mx.x + m, mx.y + m, mx.z + m, this._onLeaf);

      /*
       * Static neighbours are cached per body and only re-queried when the body leaves
       * its fat AABB (or the level changes). Re-walking a 5000-proxy tree every step for
       * every body was the single biggest broadphase cost, and it is pure waste: level
       * geometry does not move.
       */
      if (b._staticCache === null || b._staticCache === undefined || b._staticEpoch !== this.staticEpoch) {
        b._staticCache = [];
        b._staticEpoch = this.staticEpoch;
        this.stats.queries++;
        /*
         * Query the proxy's *actual* stored fat box, not a guessed margin. The fat box
         * includes velocity prediction, so a body doing 20 m/s owns a much larger region
         * than a fixed margin would cover — guess too small and a fast body slides past
         * a collider that was never in its cache.
         */
        const f = this.dynamicTree.getFatAABB(b.proxyId, this._fat);
        this.staticTree.query(f[0], f[1], f[2], f[3], f[4], f[5], this._onStaticLeaf);
        b._staticCache.sort((p, q) => p.id - q.id);
      } else {
        this.stats.cachedStatics++;
      }
      // Cached statics were already filtered at cache time; emitting them directly
      // skips a function call and four redundant checks per pair.
      const sc = b._staticCache;
      const pa = this.pairA, pb = this.pairB;
      for (let k = 0; k < sc.length; k++) {
        const o = sc[k];
        if ((b.group & o.mask) === 0 || (o.group & b.mask) === 0) continue;
        const n = this.pairCount++;
        if (b.id <= o.id) { pa[n] = b; pb[n] = o; } else { pa[n] = o; pb[n] = b; }
      }
    }
    this._self = null;
    return this.pairCount;
  }

  queryAABB(mnx, mny, mnz, mxx, mxy, mxz, cb) {
    this.dynamicTree.query(mnx, mny, mnz, mxx, mxy, mxz, cb);
    this.staticTree.query(mnx, mny, mnz, mxx, mxy, mxz, cb);
  }

  raycast(ox, oy, oz, dx, dy, dz, maxT, cb) {
    let best = this.staticTree.raycast(ox, oy, oz, dx, dy, dz, maxT, cb);
    best = this.dynamicTree.raycast(ox, oy, oz, dx, dy, dz, best, cb);
    return best;
  }

  clear() {
    this.staticTree.clear();
    this.dynamicTree.clear();
    this.pairCount = 0;
  }
}

export default Broadphase;
