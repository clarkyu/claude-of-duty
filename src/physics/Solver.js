/**
 * Solver.js — sequential-impulse constraint solver, joints, islands and sleeping.
 * Owner: physics agent. Internal to src/physics/*.
 *
 * Public API
 *   SOLVER_DEFAULTS                          tunables (iterations, slop, sleep…)
 *   ContactConstraint                        persistent per body-pair contact, warm started
 *   BallSocketConstraint / HingeConstraint / ConeTwistConstraint / DistanceConstraint
 *   Solver                                   owns the per-step solve + island sleeping
 *
 * Why it is built this way
 *   - Warm starting: last step's impulses are re-applied before iterating, so a stack
 *     converges in a handful of iterations instead of sinking and popping.
 *   - Split impulse: penetration is removed through a *separate* pseudo-velocity
 *     channel. Baumgarte alone injects energy and makes stacks explode when a body
 *     spawns interpenetrating.
 *   - Two-axis friction inside a cone: single-axis friction makes crates slide off
 *     diagonally; the box clamp makes them creep. The cone is clamped jointly.
 *   - Islands: bodies are only put to sleep as a connected group, so the bottom crate
 *     of a stack can never doze off while the top one is still moving.
 *
 * Determinism: constraints are solved in the order the caller supplies (PhysicsWorld
 * generates that list from a stable broadphase traversal), points are always visited
 * in index order and nothing here reads Map iteration order or object identity.
 */

export const SOLVER_DEFAULTS = {
  velocityIterations: 8,
  positionIterations: 3,
  relaxIterations: 1,
  baumgarte: 0.22,
  slop: 0.005,
  maxLinearCorrection: 0.2,
  restitutionThreshold: 1.0,
  /*
   * Joints correct their drift almost entirely through the split-impulse channel.
   * Leaving it to Baumgarte creates an energy pump: the contact position pass shoves a
   * bone out of the floor, the joint sees the new positional error and converts it into
   * real velocity, and a 0.5 kg hand ends up doing 90 rad/s. Ask a ragdoll how it feels.
   */
  jointBaumgarte: 0.05,
  jointPositionBeta: 0.35,
  maxJointCorrection: 2.5,
  sleepLinear: 0.055,
  sleepAngular: 0.18,
  sleepTime: 0.45,
  warmStarting: true,
  splitImpulse: true,
};

/* ------------------------------------------------------------------ *
 * Small rigid-body math helpers (operate on the Body shape defined by
 * PhysicsWorld: invMass:number, invI:Float64Array(9), v/w:{x,y,z})
 * ------------------------------------------------------------------ */

function applyLinear(b, ix, iy, iz) {
  b.velocity.x += ix * b.invMass;
  b.velocity.y += iy * b.invMass;
  b.velocity.z += iz * b.invMass;
}

function applyAngular(b, tx, ty, tz) {
  const I = b.invI;
  b.angularVelocity.x += I[0] * tx + I[1] * ty + I[2] * tz;
  b.angularVelocity.y += I[3] * tx + I[4] * ty + I[5] * tz;
  b.angularVelocity.z += I[6] * tx + I[7] * ty + I[8] * tz;
}

function applyImpulseAt(b, ix, iy, iz, rx, ry, rz, sign) {
  applyLinear(b, ix * sign, iy * sign, iz * sign);
  const tx = ry * iz - rz * iy;
  const ty = rz * ix - rx * iz;
  const tz = rx * iy - ry * ix;
  applyAngular(b, tx * sign, ty * sign, tz * sign);
}

function applyPseudoAt(b, ix, iy, iz, rx, ry, rz, sign) {
  b.pseudoV.x += ix * b.invMass * sign;
  b.pseudoV.y += iy * b.invMass * sign;
  b.pseudoV.z += iz * b.invMass * sign;
  const tx = (ry * iz - rz * iy) * sign;
  const ty = (rz * ix - rx * iz) * sign;
  const tz = (rx * iy - ry * ix) * sign;
  const I = b.invI;
  b.pseudoW.x += I[0] * tx + I[1] * ty + I[2] * tz;
  b.pseudoW.y += I[3] * tx + I[4] * ty + I[5] * tz;
  b.pseudoW.z += I[6] * tx + I[7] * ty + I[8] * tz;
}

/** Effective mass along a unit axis for a contact at r on both bodies. */
function normalEffectiveMass(a, b, rax, ray, raz, rbx, rby, rbz, nx, ny, nz) {
  let k = a.invMass + b.invMass;
  // (r x n) . I^-1 . (r x n)
  let cx = ray * nz - raz * ny, cy = raz * nx - rax * nz, cz = rax * ny - ray * nx;
  let Ia = a.invI;
  k += cx * (Ia[0] * cx + Ia[1] * cy + Ia[2] * cz)
     + cy * (Ia[3] * cx + Ia[4] * cy + Ia[5] * cz)
     + cz * (Ia[6] * cx + Ia[7] * cy + Ia[8] * cz);
  cx = rby * nz - rbz * ny; cy = rbz * nx - rbx * nz; cz = rbx * ny - rby * nx;
  Ia = b.invI;
  k += cx * (Ia[0] * cx + Ia[1] * cy + Ia[2] * cz)
     + cy * (Ia[3] * cx + Ia[4] * cy + Ia[5] * cz)
     + cz * (Ia[6] * cx + Ia[7] * cy + Ia[8] * cz);
  return k > 1e-12 ? 1 / k : 0;
}

/** Build an orthonormal tangent basis for n (Duff et al. branchless ONB). */
function tangentBasis(nx, ny, nz, out) {
  const sign = nz >= 0 ? 1 : -1;
  const a = -1 / (sign + nz);
  const b = nx * ny * a;
  out[0] = 1 + sign * nx * nx * a;
  out[1] = sign * b;
  out[2] = -sign * nx;
  out[3] = b;
  out[4] = sign + ny * ny * a;
  out[5] = -ny;
}
const _tb = new Float64Array(6);

/** 3x3 inverse, row-major. Returns false when singular. */
function mat3Invert(m, out) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  let det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return false;
  det = 1 / det;
  out[0] = A * det;
  out[1] = -(b * i - c * h) * det;
  out[2] = (b * f - c * e) * det;
  out[3] = B * det;
  out[4] = (a * i - c * g) * det;
  out[5] = -(a * f - c * d) * det;
  out[6] = C * det;
  out[7] = -(a * h - b * g) * det;
  out[8] = (a * e - b * d) * det;
  return true;
}

/** K = (imA+imB)I - skew(ra) IA skew(ra) - skew(rb) IB skew(rb) */
function pointToPointK(a, b, rax, ray, raz, rbx, rby, rbz, out) {
  const im = a.invMass + b.invMass;
  out[0] = im; out[1] = 0; out[2] = 0;
  out[3] = 0; out[4] = im; out[5] = 0;
  out[6] = 0; out[7] = 0; out[8] = im;
  addSkewITerm(out, a.invI, rax, ray, raz);
  addSkewITerm(out, b.invI, rbx, rby, rbz);
  return out;
}

function addSkewITerm(K, I, x, y, z) {
  // -S(r) * I * S(r) with S(r) the cross-product matrix.
  // S(r) = [[0,-z,y],[z,0,-x],[-y,x,0]]
  const s = _skewTmp;
  s[0] = 0; s[1] = -z; s[2] = y;
  s[3] = z; s[4] = 0; s[5] = -x;
  s[6] = -y; s[7] = x; s[8] = 0;
  const t = _skewTmp2;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      t[r * 3 + c] = s[r * 3] * I[c] + s[r * 3 + 1] * I[3 + c] + s[r * 3 + 2] * I[6 + c];
    }
  }
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      K[r * 3 + c] -= t[r * 3] * s[c] + t[r * 3 + 1] * s[3 + c] + t[r * 3 + 2] * s[6 + c];
    }
  }
}
const _skewTmp = new Float64Array(9);

/**
 * V8's Math.hypot does careful overflow/underflow scaling and shows up as ~10% of the
 * whole physics frame in a profile. At metre scale we do not need it.
 */
function len3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

const _skewTmp2 = new Float64Array(9);

/* ------------------------------------------------------------------ *
 * Contact constraint
 * ------------------------------------------------------------------ */

class ContactPointData {
  constructor() {
    this.id = -1;
    this.rax = 0; this.ray = 0; this.raz = 0;
    this.rbx = 0; this.rby = 0; this.rbz = 0;
    this.depth = 0;
    this.normalMass = 0;
    this.tMass1 = 0;
    this.tMass2 = 0;
    this.normalImpulse = 0;
    this.tImpulse1 = 0;
    this.tImpulse2 = 0;
    this.pseudoImpulse = 0;
    this.velocityBias = 0;
    /** approach speed sampled before the solve — restitution is computed from this */
    this.relativeVelocity = 0;
    this.maxNormalImpulse = 0;
    this.px = 0; this.py = 0; this.pz = 0;
  }
}

export class ContactConstraint {
  constructor() {
    this.bodyA = null;
    this.bodyB = null;
    this.key = 0;
    this.count = 0;
    this.points = [new ContactPointData(), new ContactPointData(), new ContactPointData(), new ContactPointData()];
    this.nx = 0; this.ny = 1; this.nz = 0;
    this.t1x = 0; this.t1y = 0; this.t1z = 0;
    this.t2x = 0; this.t2y = 0; this.t2z = 0;
    this.friction = 0.6;
    this.restitution = 0;
    this.touching = false;
    this.stamp = -1;
    /** frames this pair has been in contact — used by gameplay (grounded checks) */
    this.age = 0;
  }

  /** Copy a fresh manifold in, transferring warm-start impulses by contact id. */
  update(m, bodyA, bodyB) {
    const old = _oldPoints;
    const oldCount = this.count;
    for (let i = 0; i < oldCount; i++) {
      const p = this.points[i];
      old[i * 4] = p.id;
      old[i * 4 + 1] = p.normalImpulse;
      old[i * 4 + 2] = p.tImpulse1;
      old[i * 4 + 3] = p.tImpulse2;
    }
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.nx = m.nx; this.ny = m.ny; this.nz = m.nz;
    const n = Math.min(m.count, 4);
    this.count = n;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      p.id = m.id[i];
      p.px = m.px[i]; p.py = m.py[i]; p.pz = m.pz[i];
      p.depth = m.depth[i];
      p.normalImpulse = 0; p.tImpulse1 = 0; p.tImpulse2 = 0; p.pseudoImpulse = 0;
      for (let j = 0; j < oldCount; j++) {
        if (old[j * 4] === p.id) {
          p.normalImpulse = old[j * 4 + 1];
          p.tImpulse1 = old[j * 4 + 2];
          p.tImpulse2 = old[j * 4 + 3];
          break;
        }
      }
    }
    this.touching = n > 0;
    this.age = this.age + 1;
  }

  prepare(dt, s) {
    const A = this.bodyA, B = this.bodyB;
    tangentBasis(this.nx, this.ny, this.nz, _tb);
    this.t1x = _tb[0]; this.t1y = _tb[1]; this.t1z = _tb[2];
    this.t2x = _tb[3]; this.t2y = _tb[4]; this.t2z = _tb[5];
    const invDt = dt > 0 ? 1 / dt : 0;
    for (let i = 0; i < this.count; i++) {
      const p = this.points[i];
      p.rax = p.px - A.position.x;
      p.ray = p.py - A.position.y;
      p.raz = p.pz - A.position.z;
      p.rbx = p.px - B.position.x;
      p.rby = p.py - B.position.y;
      p.rbz = p.pz - B.position.z;
      p.normalMass = normalEffectiveMass(A, B, p.rax, p.ray, p.raz, p.rbx, p.rby, p.rbz, this.nx, this.ny, this.nz);
      p.tMass1 = normalEffectiveMass(A, B, p.rax, p.ray, p.raz, p.rbx, p.rby, p.rbz, this.t1x, this.t1y, this.t1z);
      p.tMass2 = normalEffectiveMass(A, B, p.rax, p.ray, p.raz, p.rbx, p.rby, p.rbz, this.t2x, this.t2y, this.t2z);

      // Sample the approach speed now; the bounce is applied in its own pass at the
      // end of the step so the relaxation iterations cannot eat it.
      p.relativeVelocity = relativeNormalVelocity(A, B, p, this.nx, this.ny, this.nz);
      p.maxNormalImpulse = 0;
      p.velocityBias = 0;
      if (!s.splitImpulse) {
        // Fall back to plain Baumgarte when split impulse is disabled.
        const pen = p.depth - s.slop;
        if (pen > 0) p.velocityBias += Math.min(pen, s.maxLinearCorrection) * s.baumgarte * invDt;
      }
    }
  }

  warmStart() {
    const A = this.bodyA, B = this.bodyB;
    for (let i = 0; i < this.count; i++) {
      const p = this.points[i];
      const ix = this.nx * p.normalImpulse + this.t1x * p.tImpulse1 + this.t2x * p.tImpulse2;
      const iy = this.ny * p.normalImpulse + this.t1y * p.tImpulse1 + this.t2y * p.tImpulse2;
      const iz = this.nz * p.normalImpulse + this.t1z * p.tImpulse1 + this.t2z * p.tImpulse2;
      applyImpulseAt(A, ix, iy, iz, p.rax, p.ray, p.raz, -1);
      applyImpulseAt(B, ix, iy, iz, p.rbx, p.rby, p.rbz, 1);
    }
  }

  solveVelocity(forward = true) {
    const A = this.bodyA, B = this.bodyB;
    const mu = this.friction;
    const n = this.count;
    // Friction first (uses the previous normal impulse as the cone radius), then
    // the normal constraint — the Catto ordering, which converges better on stacks.
    for (let k = 0; k < n; k++) {
      const i = forward ? k : n - 1 - k;
      const p = this.points[i];
      const limit = mu * p.normalImpulse;
      if (limit > 0) {
        const vt1 = relativeVelocityAlong(A, B, p, this.t1x, this.t1y, this.t1z);
        const vt2 = relativeVelocityAlong(A, B, p, this.t2x, this.t2y, this.t2z);
        let n1 = p.tImpulse1 - vt1 * p.tMass1;
        let n2 = p.tImpulse2 - vt2 * p.tMass2;
        // Joint cone clamp (not two independent boxes) so friction is isotropic.
        const mag = Math.sqrt(n1 * n1 + n2 * n2);
        if (mag > limit) {
          const k = limit / mag;
          n1 *= k; n2 *= k;
        }
        const d1 = n1 - p.tImpulse1;
        const d2 = n2 - p.tImpulse2;
        p.tImpulse1 = n1; p.tImpulse2 = n2;
        const ix = this.t1x * d1 + this.t2x * d2;
        const iy = this.t1y * d1 + this.t2y * d2;
        const iz = this.t1z * d1 + this.t2z * d2;
        applyImpulseAt(A, ix, iy, iz, p.rax, p.ray, p.raz, -1);
        applyImpulseAt(B, ix, iy, iz, p.rbx, p.rby, p.rbz, 1);
      }
    }
    for (let k = 0; k < n; k++) {
      const i = forward ? k : n - 1 - k;
      const p = this.points[i];
      const vn = relativeNormalVelocity(A, B, p, this.nx, this.ny, this.nz);
      let lambda = -(vn - p.velocityBias) * p.normalMass;
      const old = p.normalImpulse;
      const next = old + lambda;
      p.normalImpulse = next > 0 ? next : 0;
      if (p.normalImpulse > p.maxNormalImpulse) p.maxNormalImpulse = p.normalImpulse;
      lambda = p.normalImpulse - old;
      if (lambda !== 0) {
        const ix = this.nx * lambda, iy = this.ny * lambda, iz = this.nz * lambda;
        applyImpulseAt(A, ix, iy, iz, p.rax, p.ray, p.raz, -1);
        applyImpulseAt(B, ix, iy, iz, p.rbx, p.rby, p.rbz, 1);
      }
    }
  }

  /**
   * Restitution pass. Runs after relaxation, using the approach speed captured in
   * prepare(). Doing it inline as a velocity bias makes the relaxation iterations
   * cancel the bounce, which is why "restitution does nothing" is such a common bug.
   */
  applyRestitution(threshold) {
    if (this.restitution <= 0) return;
    const A = this.bodyA, B = this.bodyB;
    for (let i = 0; i < this.count; i++) {
      const p = this.points[i];
      if (p.relativeVelocity > -threshold || p.maxNormalImpulse === 0) continue;
      const vn = relativeNormalVelocity(A, B, p, this.nx, this.ny, this.nz);
      let lambda = -p.normalMass * (vn + this.restitution * p.relativeVelocity);
      const old = p.normalImpulse;
      const next = old + lambda > 0 ? old + lambda : 0;
      p.normalImpulse = next;
      lambda = next - old;
      if (lambda !== 0) {
        const ix = this.nx * lambda, iy = this.ny * lambda, iz = this.nz * lambda;
        applyImpulseAt(A, ix, iy, iz, p.rax, p.ray, p.raz, -1);
        applyImpulseAt(B, ix, iy, iz, p.rbx, p.rby, p.rbz, 1);
      }
    }
  }

  /** Split-impulse pass: pseudo velocities only, so no energy enters the sim. */
  solvePosition(dt, s) {
    const A = this.bodyA, B = this.bodyB;
    const invDt = dt > 0 ? 1 / dt : 0;
    for (let i = 0; i < this.count; i++) {
      const p = this.points[i];
      const pen = p.depth - s.slop;
      if (pen <= 0) continue;
      const bias = Math.min(pen, s.maxLinearCorrection) * s.baumgarte * invDt;
      const vn = pseudoNormalVelocity(A, B, p, this.nx, this.ny, this.nz);
      let lambda = (bias - vn) * p.normalMass;
      const old = p.pseudoImpulse;
      const next = old + lambda;
      p.pseudoImpulse = next > 0 ? next : 0;
      lambda = p.pseudoImpulse - old;
      if (lambda !== 0) {
        const ix = this.nx * lambda, iy = this.ny * lambda, iz = this.nz * lambda;
        applyPseudoAt(A, ix, iy, iz, p.rax, p.ray, p.raz, -1);
        applyPseudoAt(B, ix, iy, iz, p.rbx, p.rby, p.rbz, 1);
      }
    }
  }

  maxImpulse() {
    let m = 0;
    for (let i = 0; i < this.count; i++) if (this.points[i].normalImpulse > m) m = this.points[i].normalImpulse;
    return m;
  }
}
const _oldPoints = new Float64Array(16);

function relativeNormalVelocity(A, B, p, nx, ny, nz) {
  const avx = A.velocity.x + (A.angularVelocity.y * p.raz - A.angularVelocity.z * p.ray);
  const avy = A.velocity.y + (A.angularVelocity.z * p.rax - A.angularVelocity.x * p.raz);
  const avz = A.velocity.z + (A.angularVelocity.x * p.ray - A.angularVelocity.y * p.rax);
  const bvx = B.velocity.x + (B.angularVelocity.y * p.rbz - B.angularVelocity.z * p.rby);
  const bvy = B.velocity.y + (B.angularVelocity.z * p.rbx - B.angularVelocity.x * p.rbz);
  const bvz = B.velocity.z + (B.angularVelocity.x * p.rby - B.angularVelocity.y * p.rbx);
  return (bvx - avx) * nx + (bvy - avy) * ny + (bvz - avz) * nz;
}
const relativeVelocityAlong = relativeNormalVelocity;

function pseudoNormalVelocity(A, B, p, nx, ny, nz) {
  const avx = A.pseudoV.x + (A.pseudoW.y * p.raz - A.pseudoW.z * p.ray);
  const avy = A.pseudoV.y + (A.pseudoW.z * p.rax - A.pseudoW.x * p.raz);
  const avz = A.pseudoV.z + (A.pseudoW.x * p.ray - A.pseudoW.y * p.rax);
  const bvx = B.pseudoV.x + (B.pseudoW.y * p.rbz - B.pseudoW.z * p.rby);
  const bvy = B.pseudoV.y + (B.pseudoW.z * p.rbx - B.pseudoW.x * p.rbz);
  const bvz = B.pseudoV.z + (B.pseudoW.x * p.rby - B.pseudoW.y * p.rbx);
  return (bvx - avx) * nx + (bvy - avy) * ny + (bvz - avz) * nz;
}

/* ------------------------------------------------------------------ *
 * Joints
 * ------------------------------------------------------------------ */

let _constraintId = 1;

class JointBase {
  constructor(bodyA, bodyB) {
    this.id = _constraintId++;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.enabled = true;
    this.collideConnected = false;
    this.breakForce = Infinity;
    this.broken = false;
    this.appliedImpulse = 0;
  }
  prepare() {}
  warmStart() {}
  solveVelocity() {}
  solvePosition() {}
  dispose() {}
}

/** Rotate a local vector into world space with the body's quaternion. */
function rotWorld(b, x, y, z, out) {
  const q = b.quaternion;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + qy * tz - qz * ty;
  out[1] = y + qw * ty + qz * tx - qx * tz;
  out[2] = z + qw * tz + qx * ty - qy * tx;
  return out;
}
const _ra = new Float64Array(3);
const _rb = new Float64Array(3);
const _K = new Float64Array(9);
const _Kinv = new Float64Array(9);
const _axA = new Float64Array(3);
const _axB = new Float64Array(3);

/** 3-DOF point-to-point (ball socket). The workhorse for ragdolls. */
export class BallSocketConstraint extends JointBase {
  constructor(bodyA, bodyB, pivotA, pivotB) {
    super(bodyA, bodyB);
    this.pivotA = [pivotA.x, pivotA.y, pivotA.z];
    this.pivotB = [pivotB.x, pivotB.y, pivotB.z];
    this.impulse = new Float64Array(3);
    this.softness = 0;   // 0 = rigid; >0 lets the joint stretch (ragdoll shock absorber)
    this._bias = new Float64Array(3);
    this.m = new Float64Array(9);
    this._C = new Float64Array(3);
    this._pbias = new Float64Array(3);
    this._pimp = new Float64Array(3);
    this.valid = false;
  }

  prepare(dt, s) {
    const A = this.bodyA, B = this.bodyB;
    rotWorld(A, this.pivotA[0], this.pivotA[1], this.pivotA[2], _ra);
    rotWorld(B, this.pivotB[0], this.pivotB[1], this.pivotB[2], _rb);
    this.rax = _ra[0]; this.ray = _ra[1]; this.raz = _ra[2];
    this.rbx = _rb[0]; this.rby = _rb[1]; this.rbz = _rb[2];
    pointToPointK(A, B, this.rax, this.ray, this.raz, this.rbx, this.rby, this.rbz, _K);
    if (this.softness > 0) {
      _K[0] += this.softness; _K[4] += this.softness; _K[8] += this.softness;
    }
    this.valid = mat3Invert(_K, _Kinv);
    if (this.valid) this.m.set(_Kinv);
    const invDt = dt > 0 ? 1 / dt : 0;
    const beta = s.jointBaumgarte;
    const cx = (B.position.x + this.rbx) - (A.position.x + this.rax);
    const cy = (B.position.y + this.rby) - (A.position.y + this.ray);
    const cz = (B.position.z + this.rbz) - (A.position.z + this.raz);
    this._C[0] = cx; this._C[1] = cy; this._C[2] = cz;
    const cap = s.maxJointCorrection;
    this._bias[0] = clampAbs(-cx * beta * invDt, cap);
    this._bias[1] = clampAbs(-cy * beta * invDt, cap);
    this._bias[2] = clampAbs(-cz * beta * invDt, cap);
    this._pbias[0] = clampAbs(-cx * s.jointPositionBeta * invDt, cap * 4);
    this._pbias[1] = clampAbs(-cy * s.jointPositionBeta * invDt, cap * 4);
    this._pbias[2] = clampAbs(-cz * s.jointPositionBeta * invDt, cap * 4);
    this._pimp[0] = 0; this._pimp[1] = 0; this._pimp[2] = 0;
    this.errorSq = cx * cx + cy * cy + cz * cz;
  }

  /** Pseudo-velocity drift correction — adds position, never energy. */
  solvePosition() {
    if (!this.valid) return;
    const A = this.bodyA, B = this.bodyB;
    const avx = A.pseudoV.x + (A.pseudoW.y * this.raz - A.pseudoW.z * this.ray);
    const avy = A.pseudoV.y + (A.pseudoW.z * this.rax - A.pseudoW.x * this.raz);
    const avz = A.pseudoV.z + (A.pseudoW.x * this.ray - A.pseudoW.y * this.rax);
    const bvx = B.pseudoV.x + (B.pseudoW.y * this.rbz - B.pseudoW.z * this.rby);
    const bvy = B.pseudoV.y + (B.pseudoW.z * this.rbx - B.pseudoW.x * this.rbz);
    const bvz = B.pseudoV.z + (B.pseudoW.x * this.rby - B.pseudoW.y * this.rbx);
    const dvx = (bvx - avx) - this._pbias[0];
    const dvy = (bvy - avy) - this._pbias[1];
    const dvz = (bvz - avz) - this._pbias[2];
    const m = this.m;
    const ix = -(m[0] * dvx + m[1] * dvy + m[2] * dvz);
    const iy = -(m[3] * dvx + m[4] * dvy + m[5] * dvz);
    const iz = -(m[6] * dvx + m[7] * dvy + m[8] * dvz);
    this._pimp[0] += ix; this._pimp[1] += iy; this._pimp[2] += iz;
    applyPseudoAt(A, ix, iy, iz, this.rax, this.ray, this.raz, -1);
    applyPseudoAt(B, ix, iy, iz, this.rbx, this.rby, this.rbz, 1);
  }

  warmStart() {
    if (!this.valid) return;
    const A = this.bodyA, B = this.bodyB;
    const ix = this.impulse[0], iy = this.impulse[1], iz = this.impulse[2];
    applyImpulseAt(A, ix, iy, iz, this.rax, this.ray, this.raz, -1);
    applyImpulseAt(B, ix, iy, iz, this.rbx, this.rby, this.rbz, 1);
  }

  solveVelocity() {
    if (!this.valid) return;
    const A = this.bodyA, B = this.bodyB;
    const avx = A.velocity.x + (A.angularVelocity.y * this.raz - A.angularVelocity.z * this.ray);
    const avy = A.velocity.y + (A.angularVelocity.z * this.rax - A.angularVelocity.x * this.raz);
    const avz = A.velocity.z + (A.angularVelocity.x * this.ray - A.angularVelocity.y * this.rax);
    const bvx = B.velocity.x + (B.angularVelocity.y * this.rbz - B.angularVelocity.z * this.rby);
    const bvy = B.velocity.y + (B.angularVelocity.z * this.rbx - B.angularVelocity.x * this.rbz);
    const bvz = B.velocity.z + (B.angularVelocity.x * this.rby - B.angularVelocity.y * this.rbx);
    const dvx = (bvx - avx) - this._bias[0];
    const dvy = (bvy - avy) - this._bias[1];
    const dvz = (bvz - avz) - this._bias[2];
    const m = this.m;
    const ix = -(m[0] * dvx + m[1] * dvy + m[2] * dvz);
    const iy = -(m[3] * dvx + m[4] * dvy + m[5] * dvz);
    const iz = -(m[6] * dvx + m[7] * dvy + m[8] * dvz);
    this.impulse[0] += ix; this.impulse[1] += iy; this.impulse[2] += iz;
    this.appliedImpulse = len3(this.impulse[0], this.impulse[1], this.impulse[2]);
    applyImpulseAt(A, ix, iy, iz, this.rax, this.ray, this.raz, -1);
    applyImpulseAt(B, ix, iy, iz, this.rbx, this.rby, this.rbz, 1);
  }
}

/** Solve a 1-DOF angular constraint about a world axis. */
function solveAngularLimit(A, B, ax, ay, az, targetVel, lo, hi, state, key) {
  const Ia = A.invI, Ib = B.invI;
  let k =
    ax * (Ia[0] * ax + Ia[1] * ay + Ia[2] * az) +
    ay * (Ia[3] * ax + Ia[4] * ay + Ia[5] * az) +
    az * (Ia[6] * ax + Ia[7] * ay + Ia[8] * az) +
    ax * (Ib[0] * ax + Ib[1] * ay + Ib[2] * az) +
    ay * (Ib[3] * ax + Ib[4] * ay + Ib[5] * az) +
    az * (Ib[6] * ax + Ib[7] * ay + Ib[8] * az);
  if (k < 1e-12) return 0;
  const em = 1 / k;
  const wrel =
    (B.angularVelocity.x - A.angularVelocity.x) * ax +
    (B.angularVelocity.y - A.angularVelocity.y) * ay +
    (B.angularVelocity.z - A.angularVelocity.z) * az;
  let lambda = (targetVel - wrel) * em;
  const old = state[key];
  let next = old + lambda;
  if (next < lo) next = lo;
  else if (next > hi) next = hi;
  lambda = next - old;
  state[key] = next;
  if (lambda !== 0) {
    applyAngular(A, -ax * lambda, -ay * lambda, -az * lambda);
    applyAngular(B, ax * lambda, ay * lambda, az * lambda);
  }
  return lambda;
}

/**
 * Joint friction expressed in *relative angular velocity* rather than raw impulse.
 * A hand weighs 0.5 kg and has an inverse inertia around 1700, so a fixed impulse clamp
 * that gently damps a thigh will fling a hand at 50 rad/s. Scaling the clamp by the
 * joint's effective inertia makes `maxDeltaOmega` mean the same thing on every bone:
 * the most relative spin (rad/s) this joint may remove in one step.
 */
function solveAngularFriction(A, B, ax, ay, az, maxDeltaOmega, state, key) {
  const Ia = A.invI, Ib = B.invI;
  const k =
    ax * (Ia[0] * ax + Ia[1] * ay + Ia[2] * az) +
    ay * (Ia[3] * ax + Ia[4] * ay + Ia[5] * az) +
    az * (Ia[6] * ax + Ia[7] * ay + Ia[8] * az) +
    ax * (Ib[0] * ax + Ib[1] * ay + Ib[2] * az) +
    ay * (Ib[3] * ax + Ib[4] * ay + Ib[5] * az) +
    az * (Ib[6] * ax + Ib[7] * ay + Ib[8] * az);
  if (k < 1e-12) return;
  const em = 1 / k;
  const limit = maxDeltaOmega * em;
  const wrel =
    (B.angularVelocity.x - A.angularVelocity.x) * ax +
    (B.angularVelocity.y - A.angularVelocity.y) * ay +
    (B.angularVelocity.z - A.angularVelocity.z) * az;
  let lambda = -wrel * em;
  const old = state[key];
  let next = old + lambda;
  if (next < -limit) next = -limit;
  else if (next > limit) next = limit;
  lambda = next - old;
  state[key] = next;
  if (lambda !== 0) {
    applyAngular(A, -ax * lambda, -ay * lambda, -az * lambda);
    applyAngular(B, ax * lambda, ay * lambda, az * lambda);
  }
}

/**
 * Hinge: point-to-point + the two angular DOFs perpendicular to the axis locked,
 * plus optional [min,max] limits and a motor. Used for knees, elbows and doors.
 */
export class HingeConstraint extends BallSocketConstraint {
  constructor(bodyA, bodyB, pivotA, pivotB, axisA, axisB, opts = {}) {
    super(bodyA, bodyB, pivotA, pivotB);
    this.axisA = normalise3([axisA.x, axisA.y, axisA.z]);
    this.axisB = normalise3([axisB.x, axisB.y, axisB.z]);
    this.refA = perpendicular(this.axisA);
    this.refB = perpendicular(this.axisB);
    this.lowerLimit = opts.lowerLimit ?? -Math.PI;
    this.upperLimit = opts.upperLimit ?? Math.PI;
    this.enableLimit = opts.enableLimit ?? (opts.lowerLimit !== undefined || opts.upperLimit !== undefined);
    this.motorSpeed = opts.motorSpeed ?? 0;
    this.maxMotorTorque = opts.maxMotorTorque ?? 0;
    this.angularDamping = opts.angularDamping ?? 0;
    this._axState = { a: 0, b: 0, lim: 0, motor: 0, damp: 0 };
    this._wasLimited = false;
    this.angle = 0;
  }

  prepare(dt, s) {
    super.prepare(dt, s);
    this._dt = dt;
    const A = this.bodyA, B = this.bodyB;
    rotWorld(A, this.axisA[0], this.axisA[1], this.axisA[2], _axA);
    rotWorld(B, this.axisB[0], this.axisB[1], this.axisB[2], _axB);
    this.wax = _axA[0]; this.way = _axA[1]; this.waz = _axA[2];
    this.wbx = _axB[0]; this.wby = _axB[1]; this.wbz = _axB[2];
    /*
     * Lock the two rotational DOFs perpendicular to the hinge axis.
     *
     * The subtle part is the *bias*. Rotating about p1 does not fix a misalignment
     * measured along p1 — it fixes the one along p2. Biasing each axis by its own
     * error component makes the hinge precess instead of aligning, and because the
     * error never goes away the bias keeps doing work: a slow, permanent energy pump
     * that shows up as a ragdoll whose elbows and knees never stop thrashing.
     * The correction axis is `axisA x axisB`, projected onto p1/p2.
     *
     * p2 is built as wa x p1 so (wa, p1, p2) is right-handed by construction and the
     * signs below cannot silently invert into anti-damping.
     */
    tangentBasis(this.wax, this.way, this.waz, _tb);
    this.p1x = _tb[0]; this.p1y = _tb[1]; this.p1z = _tb[2];
    this.p2x = this.way * this.p1z - this.waz * this.p1y;
    this.p2y = this.waz * this.p1x - this.wax * this.p1z;
    this.p2z = this.wax * this.p1y - this.way * this.p1x;
    const invDt = dt > 0 ? 1 / dt : 0;
    const beta = s.jointBaumgarte * 4;
    const ex = this.way * this.wbz - this.waz * this.wby;
    const ey = this.waz * this.wbx - this.wax * this.wbz;
    const ez = this.wax * this.wby - this.way * this.wbx;
    this.alignError = len3(ex, ey, ez);
    this.err1 = -(ex * this.p1x + ey * this.p1y + ez * this.p1z) * beta * invDt;
    this.err2 = -(ex * this.p2x + ey * this.p2y + ez * this.p2z) * beta * invDt;
    // Carry the alignment impulses over (warm start) — rebuilding them from zero every
    // step leaves a residual the size of the sleep threshold, so jointed bodies twitch
    // forever instead of dozing off.
    this._axState.a *= 0.85; this._axState.b *= 0.85;

    // Signed hinge angle from the reference vectors projected onto the hinge plane.
    rotWorld(A, this.refA[0], this.refA[1], this.refA[2], _ra);
    rotWorld(B, this.refB[0], this.refB[1], this.refB[2], _rb);
    const cx = _ra[1] * _rb[2] - _ra[2] * _rb[1];
    const cy = _ra[2] * _rb[0] - _ra[0] * _rb[2];
    const cz = _ra[0] * _rb[1] - _ra[1] * _rb[0];
    const sin = cx * this.wax + cy * this.way + cz * this.waz;
    const cos = _ra[0] * _rb[0] + _ra[1] * _rb[1] + _ra[2] * _rb[2];
    this.angle = Math.atan2(sin, cos);

    this._limitBias = 0;
    this._limitLo = 0;
    this._limitHi = 0;
    if (this.enableLimit) {
      if (this.angle < this.lowerLimit) {
        this._limitBias = Math.min(0.4, (this.lowerLimit - this.angle)) * s.jointBaumgarte * 4 * invDt;
        this._limitLo = 0; this._limitHi = Infinity;
        this._limitActive = true;
      } else if (this.angle > this.upperLimit) {
        this._limitBias = -Math.min(0.4, (this.angle - this.upperLimit)) * s.jointBaumgarte * 4 * invDt;
        this._limitLo = -Infinity; this._limitHi = 0;
        this._limitActive = true;
      } else {
        this._limitActive = false;
      }
    } else this._limitActive = false;
    if (!this._limitActive || !this._wasLimited) this._axState.lim = 0;
    this._wasLimited = this._limitActive;
    this._axState.motor = 0;
    this._axState.damp = 0;
  }

  warmStart() {
    super.warmStart();
    const A = this.bodyA, B = this.bodyB;
    const a = this._axState.a, b = this._axState.b;
    if (a !== 0) {
      applyAngular(A, -this.p1x * a, -this.p1y * a, -this.p1z * a);
      applyAngular(B, this.p1x * a, this.p1y * a, this.p1z * a);
    }
    if (b !== 0) {
      applyAngular(A, -this.p2x * b, -this.p2y * b, -this.p2z * b);
      applyAngular(B, this.p2x * b, this.p2y * b, this.p2z * b);
    }
    const l = this._axState.lim;
    if (this._limitActive && l !== 0) {
      applyAngular(A, -this.wax * l, -this.way * l, -this.waz * l);
      applyAngular(B, this.wax * l, this.way * l, this.waz * l);
    }
  }

  solveVelocity() {
    super.solveVelocity();
    const A = this.bodyA, B = this.bodyB;
    solveAngularLimit(A, B, this.p1x, this.p1y, this.p1z, this.err1, -Infinity, Infinity, this._axState, 'a');
    solveAngularLimit(A, B, this.p2x, this.p2y, this.p2z, this.err2, -Infinity, Infinity, this._axState, 'b');
    if (this._limitActive) {
      solveAngularLimit(A, B, this.wax, this.way, this.waz, this._limitBias,
        this._limitLo, this._limitHi, this._axState, 'lim');
    }
    if (this.maxMotorTorque > 0) {
      const cap = this.maxMotorTorque * this._dt;
      solveAngularLimit(A, B, this.wax, this.way, this.waz, this.motorSpeed,
        -cap, cap, this._axState, 'motor');
    }
    if (this.angularDamping > 0) {
      // Joint friction about the hinge axis, in rad/s of relative spin per step.
      solveAngularFriction(A, B, this.wax, this.way, this.waz,
        this.angularDamping, this._axState, 'damp');
    }
  }
}

/**
 * Cone-twist: ball socket + a swing cone (elliptical) + a twist limit.
 * The joint used for shoulders, hips, neck and spine in the ragdoll.
 */
export class ConeTwistConstraint extends BallSocketConstraint {
  constructor(bodyA, bodyB, pivotA, pivotB, axisA, axisB, opts = {}) {
    super(bodyA, bodyB, pivotA, pivotB);
    this.axisA = normalise3([axisA.x, axisA.y, axisA.z]);
    this.axisB = normalise3([axisB.x, axisB.y, axisB.z]);
    this.refA = perpendicular(this.axisA);
    this.refB = perpendicular(this.axisB);
    this.swingSpan1 = opts.swingSpan1 ?? opts.swing ?? 0.6;
    this.swingSpan2 = opts.swingSpan2 ?? opts.swing ?? 0.6;
    this.twistSpan = opts.twistSpan ?? 0.4;
    this.angularDamping = opts.angularDamping ?? 0.0;
    this._st = { swing: 0, twist: 0, d1: 0, d2: 0, d3: 0 };
    this._wasSwing = false;
    this._wasTwist = false;
    this.swingAngle = 0;
    this.twistAngle = 0;
  }

  prepare(dt, s) {
    super.prepare(dt, s);
    const A = this.bodyA, B = this.bodyB;
    rotWorld(A, this.axisA[0], this.axisA[1], this.axisA[2], _axA);
    rotWorld(B, this.axisB[0], this.axisB[1], this.axisB[2], _axB);
    const invDt = dt > 0 ? 1 / dt : 0;

    // --- swing: angle between the two bone axes, limited by an elliptical cone.
    let dot = _axA[0] * _axB[0] + _axA[1] * _axB[1] + _axA[2] * _axB[2];
    if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
    const swing = Math.acos(dot);
    this.swingAngle = swing;
    let sx = _axA[1] * _axB[2] - _axA[2] * _axB[1];
    let sy = _axA[2] * _axB[0] - _axA[0] * _axB[2];
    let sz = _axA[0] * _axB[1] - _axA[1] * _axB[0];
    const sl = len3(sx, sy, sz);
    this._swingActive = false;
    if (sl > 1e-6) {
      sx /= sl; sy /= sl; sz /= sl;
      // Elliptical limit: interpolate the span by where the swing lies in the cone.
      rotWorld(A, this.refA[0], this.refA[1], this.refA[2], _ra);
      const c1 = sx * _ra[0] + sy * _ra[1] + sz * _ra[2];
      const limit = Math.sqrt(
        (this.swingSpan1 * this.swingSpan2) ** 2 /
        Math.max(1e-6, (this.swingSpan2 * c1) ** 2 + (this.swingSpan1 ** 2) * (1 - c1 * c1))
      );
      if (swing > limit) {
        this._swingActive = true;
        this._sx = sx; this._sy = sy; this._sz = sz;
        this._swingBias = -Math.min(0.5, swing - limit) * s.jointBaumgarte * 5 * invDt;
      }
    }

    // --- twist: rotation of B about its own axis relative to A's reference.
    rotWorld(A, this.refA[0], this.refA[1], this.refA[2], _ra);
    rotWorld(B, this.refB[0], this.refB[1], this.refB[2], _rb);
    // Project both references onto the plane perpendicular to B's axis.
    const da = _ra[0] * _axB[0] + _ra[1] * _axB[1] + _ra[2] * _axB[2];
    const pax = _ra[0] - _axB[0] * da, pay = _ra[1] - _axB[1] * da, paz = _ra[2] - _axB[2] * da;
    const db = _rb[0] * _axB[0] + _rb[1] * _axB[1] + _rb[2] * _axB[2];
    const pbx = _rb[0] - _axB[0] * db, pby = _rb[1] - _axB[1] * db, pbz = _rb[2] - _axB[2] * db;
    const la = len3(pax, pay, paz), lb = len3(pbx, pby, pbz);
    this._twistActive = false;
    if (la > 1e-5 && lb > 1e-5) {
      const cx = (pay * pbz - paz * pby) / (la * lb);
      const cy = (paz * pbx - pax * pbz) / (la * lb);
      const cz = (pax * pby - pay * pbx) / (la * lb);
      const sin = cx * _axB[0] + cy * _axB[1] + cz * _axB[2];
      const cos = (pax * pbx + pay * pby + paz * pbz) / (la * lb);
      const twist = Math.atan2(sin, cos);
      this.twistAngle = twist;
      if (twist > this.twistSpan) {
        this._twistActive = true;
        this._twistBias = -Math.min(0.5, twist - this.twistSpan) * s.jointBaumgarte * 5 * invDt;
        this._twistLo = -Infinity; this._twistHi = 0;
      } else if (twist < -this.twistSpan) {
        this._twistActive = true;
        this._twistBias = Math.min(0.5, -this.twistSpan - twist) * s.jointBaumgarte * 5 * invDt;
        this._twistLo = 0; this._twistHi = Infinity;
      }
      this._tax = _axB[0]; this._tay = _axB[1]; this._taz = _axB[2];
    }
    if (!this._swingActive || !this._wasSwing) this._st.swing = 0;
    if (!this._twistActive || !this._wasTwist) this._st.twist = 0;
    this._wasSwing = this._swingActive;
    this._wasTwist = this._twistActive;
    this._st.d1 = 0; this._st.d2 = 0; this._st.d3 = 0;
  }

  warmStart() {
    super.warmStart();
    const A = this.bodyA, B = this.bodyB;
    const sw = this._st.swing;
    if (this._swingActive && sw !== 0) {
      applyAngular(A, -this._sx * sw, -this._sy * sw, -this._sz * sw);
      applyAngular(B, this._sx * sw, this._sy * sw, this._sz * sw);
    }
    const tw = this._st.twist;
    if (this._twistActive && tw !== 0) {
      applyAngular(A, -this._tax * tw, -this._tay * tw, -this._taz * tw);
      applyAngular(B, this._tax * tw, this._tay * tw, this._taz * tw);
    }
  }

  solveVelocity() {
    super.solveVelocity();
    const A = this.bodyA, B = this.bodyB;
    if (this._swingActive) {
      solveAngularLimit(A, B, this._sx, this._sy, this._sz, this._swingBias, -Infinity, 0, this._st, 'swing');
    }
    if (this._twistActive) {
      solveAngularLimit(A, B, this._tax, this._tay, this._taz, this._twistBias,
        this._twistLo, this._twistHi, this._st, 'twist');
    }
    const d = this.angularDamping;
    if (d > 0) {
      // Isotropic joint friction — this is what stops a ragdoll from flailing.
      solveAngularFriction(A, B, 1, 0, 0, d, this._st, 'd1');
      solveAngularFriction(A, B, 0, 1, 0, d, this._st, 'd2');
      solveAngularFriction(A, B, 0, 0, 1, d, this._st, 'd3');
    }
  }
}

/** Rigid or ranged distance between two anchor points. */
export class DistanceConstraint extends JointBase {
  constructor(bodyA, bodyB, pivotA, pivotB, opts = {}) {
    super(bodyA, bodyB);
    this.pivotA = [pivotA.x, pivotA.y, pivotA.z];
    this.pivotB = [pivotB.x, pivotB.y, pivotB.z];
    this.distance = opts.distance ?? -1;
    this.minDistance = opts.minDistance ?? -1;
    this.maxDistance = opts.maxDistance ?? -1;
    this.stiffness = opts.stiffness ?? 1;
    this.impulse = 0;
  }

  prepare(dt, s) {
    const A = this.bodyA, B = this.bodyB;
    rotWorld(A, this.pivotA[0], this.pivotA[1], this.pivotA[2], _ra);
    rotWorld(B, this.pivotB[0], this.pivotB[1], this.pivotB[2], _rb);
    this.rax = _ra[0]; this.ray = _ra[1]; this.raz = _ra[2];
    this.rbx = _rb[0]; this.rby = _rb[1]; this.rbz = _rb[2];
    let dx = (B.position.x + this.rbx) - (A.position.x + this.rax);
    let dy = (B.position.y + this.rby) - (A.position.y + this.ray);
    let dz = (B.position.z + this.rbz) - (A.position.z + this.raz);
    const len = len3(dx, dy, dz);
    this.currentLength = len;
    if (len < 1e-8) { this.active = false; return; }
    dx /= len; dy /= len; dz /= len;
    this.nx = dx; this.ny = dy; this.nz = dz;
    let target = this.distance;
    let lo = -Infinity, hi = Infinity;
    if (this.distance < 0) {
      if (this.maxDistance >= 0 && len > this.maxDistance) { target = this.maxDistance; hi = 0; }
      else if (this.minDistance >= 0 && len < this.minDistance) { target = this.minDistance; lo = 0; }
      else { this.active = false; return; }
    }
    this.active = true;
    this._lo = lo; this._hi = hi;
    this.mass = normalEffectiveMass(A, B, this.rax, this.ray, this.raz, this.rbx, this.rby, this.rbz, dx, dy, dz);
    const invDt = dt > 0 ? 1 / dt : 0;
    this.bias = -(len - target) * s.baumgarte * this.stiffness * invDt;
    this.impulse = 0;
  }

  solveVelocity() {
    if (!this.active) return;
    const A = this.bodyA, B = this.bodyB;
    const p = _distPoint;
    p.rax = this.rax; p.ray = this.ray; p.raz = this.raz;
    p.rbx = this.rbx; p.rby = this.rby; p.rbz = this.rbz;
    const vn = relativeNormalVelocity(A, B, p, this.nx, this.ny, this.nz);
    let lambda = (this.bias - vn) * this.mass;
    const old = this.impulse;
    let next = old + lambda;
    if (next < this._lo) next = this._lo;
    else if (next > this._hi) next = this._hi;
    lambda = next - old;
    this.impulse = next;
    this.appliedImpulse = Math.abs(next);
    const ix = this.nx * lambda, iy = this.ny * lambda, iz = this.nz * lambda;
    applyImpulseAt(A, ix, iy, iz, this.rax, this.ray, this.raz, -1);
    applyImpulseAt(B, ix, iy, iz, this.rbx, this.rby, this.rbz, 1);
  }
}
const _distPoint = { rax: 0, ray: 0, raz: 0, rbx: 0, rby: 0, rbz: 0 };

function clampAbs(v, lim) {
  return v > lim ? lim : (v < -lim ? -lim : v);
}

function normalise3(v) {
  const l = len3(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function perpendicular(a) {
  if (Math.abs(a[0]) <= Math.abs(a[1]) && Math.abs(a[0]) <= Math.abs(a[2])) {
    return normalise3([0, -a[2], a[1]]);
  }
  if (Math.abs(a[1]) <= Math.abs(a[2])) return normalise3([-a[2], 0, a[0]]);
  return normalise3([-a[1], a[0], 0]);
}

/* ------------------------------------------------------------------ *
 * Solver
 * ------------------------------------------------------------------ */

export class Solver {
  constructor(settings = {}) {
    this.settings = { ...SOLVER_DEFAULTS, ...settings };
    this._parent = new Int32Array(256);
    this._sleepy = new Uint8Array(256);
    this.stats = { contacts: 0, points: 0, joints: 0, islands: 0, sleeping: 0 };
  }

  configure(patch) {
    Object.assign(this.settings, patch);
  }

  /**
   * @param {ContactConstraint[]} contacts active this step (stable order)
   * @param {number} contactCount
   * @param {JointBase[]} joints
   * @param {object[]} bodies dynamic bodies (stable order)
   */
  solve(contacts, contactCount, joints, bodies, dt) {
    const s = this.settings;
    let points = 0;
    for (let i = 0; i < contactCount; i++) {
      const c = contacts[i];
      c.prepare(dt, s);
      points += c.count;
    }
    let jointCount = 0;
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (!j.enabled || j.broken) continue;
      j.prepare(dt, s);
      jointCount++;
    }

    if (s.warmStarting) {
      for (let i = 0; i < contactCount; i++) contacts[i].warmStart();
      for (let i = 0; i < joints.length; i++) {
        const j = joints[i];
        if (j.enabled && !j.broken) j.warmStart();
      }
    }

    /*
     * Gauss-Seidel is order dependent: always sweeping 0..n biases a symmetrically
     * loaded body (a crate dropped flat) into a small spin. Alternating the sweep
     * direction each iteration cancels most of that, and costs nothing.
     */
    const vi = Math.max(1, s.velocityIterations | 0);
    for (let it = 0; it < vi; it++) {
      const fwd = (it & 1) === 0;
      for (let i = 0; i < joints.length; i++) {
        const j = joints[fwd ? i : joints.length - 1 - i];
        if (j.enabled && !j.broken) j.solveVelocity();
      }
      for (let i = 0; i < contactCount; i++) {
        contacts[fwd ? i : contactCount - 1 - i].solveVelocity(fwd);
      }
    }

    // Relaxation pass with every bias removed: bleeds off the energy Baumgarte
    // injected, which is what stops a tall stack from slowly pumping itself apart.
    for (let it = 0; it < (s.relaxIterations | 0); it++) {
      for (let i = 0; i < contactCount; i++) {
        const c = contacts[i];
        for (let p = 0; p < c.count; p++) c.points[p].velocityBias = 0;
        c.solveVelocity();
      }
    }

    // Then, and only then, put the bounce back.
    for (let i = 0; i < contactCount; i++) contacts[i].applyRestitution(s.restitutionThreshold);

    if (s.splitImpulse) {
      const pi = Math.max(0, s.positionIterations | 0);
      for (let it = 0; it < pi; it++) {
        for (let i = 0; i < contactCount; i++) contacts[i].solvePosition(dt, s);
        for (let i = 0; i < joints.length; i++) {
          const j = joints[i];
          if (j.enabled && !j.broken) j.solvePosition(dt, s);
        }
      }
    }

    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (j.enabled && !j.broken && j.appliedImpulse > j.breakForce * dt) {
        j.broken = true;
      }
    }

    this.stats.contacts = contactCount;
    this.stats.points = points;
    this.stats.joints = jointCount;
    void bodies;
  }

  /**
   * Union-find islands over contacts + joints, then sleep whole islands.
   * A body only sleeps if every body it is touching is also ready to sleep.
   */
  updateSleeping(bodies, contacts, contactCount, joints, dt) {
    const s = this.settings;
    const n = bodies.length;
    if (this._parent.length < n) {
      this._parent = new Int32Array(n * 2);
      this._sleepy = new Uint8Array(n * 2);
    }
    const parent = this._parent;
    for (let i = 0; i < n; i++) {
      parent[i] = i;
      bodies[i]._index = i;
    }
    const find = (x) => {
      let r = x;
      while (parent[r] !== r) r = parent[r];
      while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
      return r;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra > rb ? ra : rb] = ra > rb ? rb : ra;
    };
    for (let i = 0; i < contactCount; i++) {
      const c = contacts[i];
      if (!c.touching) continue;
      const A = c.bodyA, B = c.bodyB;
      if (A.invMass > 0 && B.invMass > 0) union(A._index, B._index);
    }
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (!j.enabled || j.broken) continue;
      const A = j.bodyA, B = j.bodyB;
      if (A.invMass > 0 && B.invMass > 0 && A._index >= 0 && B._index >= 0) union(A._index, B._index);
    }

    const sleepy = this._sleepy;
    sleepy.fill(1, 0, n);
    const lin = s.sleepLinear * s.sleepLinear;
    const ang = s.sleepAngular * s.sleepAngular;
    let islands = 0, sleepingCount = 0;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.invMass === 0 || b.isKinematic) { b.sleepTimer = 0; continue; }
      if (!b.allowSleep) { sleepy[find(i)] = 0; continue; }
      const v = b.velocity, w = b.angularVelocity;
      const vv = v.x * v.x + v.y * v.y + v.z * v.z;
      const ww = w.x * w.x + w.y * w.y + w.z * w.z;
      if (vv > lin || ww > ang) {
        b.sleepTimer = 0;
        sleepy[find(i)] = 0;
      } else {
        b.sleepTimer += dt;
        if (b.sleepTimer < s.sleepTime) sleepy[find(i)] = 0;
      }
    }
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.invMass === 0 || b.isKinematic) continue;
      if (find(i) === i) islands++;
      const canSleep = sleepy[find(i)] === 1;
      if (canSleep && b.awake) {
        b.awake = false;
        b.velocity.x = b.velocity.y = b.velocity.z = 0;
        b.angularVelocity.x = b.angularVelocity.y = b.angularVelocity.z = 0;
      } else if (!canSleep && !b.awake) {
        b.awake = true;
        b.sleepTimer = 0;
      }
      if (!b.awake) sleepingCount++;
    }
    this.stats.islands = islands;
    this.stats.sleeping = sleepingCount;
  }
}

export default Solver;
