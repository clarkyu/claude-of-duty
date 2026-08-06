/**
 * CharacterBuilder.js — procedural soldier: skeleton, skinned mesh, kit, hitboxes.
 * Owner: AI agent.  Used by ai/Bot.js through ai/AISystem.js.
 *
 * There are no model files in this project, so the soldier is generated: a 16-bone
 * humanoid rig whose joint table is *numerically identical* to `defaultLayout()` in
 * physics/Ragdoll.js, geometry authored in that rig's rest pose, and automatic skin
 * weights solved per vertex against the bone segments. Because the rig and the ragdoll
 * agree on every joint height, the death handoff is a straight transform copy — no
 * retarget, no pop.
 *
 * ── What is actually modelled ───────────────────────────────────────────────────
 *   helmet shell + fabric cover + brim, NVG shroud & mount arm, side rails,
 *   counterweight pouch, four-point chin strap and chin cup, goggles on the brim,
 *   balaclava over the lower face, bare skin around the eyes, neck,
 *   plate carrier (front & back plate bags, cummerbund, shoulder yokes, MOLLE rows,
 *   three rifle-mag pouches, admin pouch, radio pouch, hydration hose),
 *   uniform blouse with rolled sleeve seams and elbow pads, gloves with knuckle plates,
 *   trousers with cargo pockets, knee pads and boot blousing, rigger belt with buckle
 *   and dump pouch, drop-leg holster, boots with lace panel, cuff and lugged sole,
 *   plus a carried rifle on a root-space weapon anchor with muzzle and grip locators.
 *
 * ── Why the rifle is not parented to a hand ─────────────────────────────────────
 * The anchor's yaw is the body's and its pitch is the aim's, so the barrel *is* the
 * fire vector — muzzle flash, tracer and projectile all leave the same place in the
 * same direction. The hands are then IK'd onto `gripR` / `gripL` (see Bot.js). Doing
 * it the other way round (hand drives gun) lets the barrel drift by whatever the
 * shoulder animation happens to be doing that frame.
 *
 * ── Public API ──────────────────────────────────────────────────────────────────
 *   createCharacterBuilder(ctx) -> {
 *     build(opts) -> Character,      opts: {variant, rng, height, quality}
 *     variants,                      the kit colourways
 *     layout(height),                joint table (shared with the ragdoll)
 *     stats, dispose()
 *   }
 *   Character = {
 *     root:      THREE.Group        add to the scene; origin is between the feet
 *     bones:     {name -> THREE.Bone}
 *     boneList:  THREE.Bone[]       canonical ragdoll order
 *     skeleton:  THREE.Skeleton
 *     meshes:    THREE.SkinnedMesh[]
 *     weaponAnchor, rifle, muzzle, gripR, gripL
 *     hitboxes:  [{id, hitbox, bones:[a,b], radius}]  kinematic proxy descriptors
 *     bodyCentre(name, outPos, outQuat)   ragdoll body transform for `name`
 *     applyBody(name, pos, quat)          inverse — drive a bone from a ragdoll body
 *     stowWeapon(toHand)                  hand the rifle to the ragdoll, or take it back
 *     setVisible(v) / dispose()
 *   }
 *
 * Geometry is cached per (variant, quality) and shared by every soldier; only the
 * bones, the skeleton and the SkinnedMesh wrappers are per-character.
 */
import * as THREE from 'three';

/** Canonical bone order — must match physics/Ragdoll.js RAGDOLL_BONES. */
export const BONE_ORDER = Object.freeze([
  'pelvis', 'spine', 'chest', 'head',
  'upperArmL', 'lowerArmL', 'handL',
  'upperArmR', 'lowerArmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
]);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Joint table. Deliberately the same fractions Ragdoll.defaultLayout() uses, so a
 * ragdoll built at the same `height` lines its capsules up with this mesh exactly.
 */
export function soldierLayout(H = 1.8) {
  const s = H / 1.8;
  const y = (f) => f * H;
  const hipY = y(0.53), kneeY = y(0.285), ankleY = y(0.039);
  const shoulderY = y(0.8), elbowY = y(0.63), wristY = y(0.485);
  const neckY = y(0.87);
  const hipX = 0.085 * s;
  const shoulderX = 0.175 * s;
  return {
    H, s, hipY, kneeY, ankleY, shoulderY, elbowY, wristY, neckY, hipX, shoulderX,
    spineY: hipY + 0.11 * s,
    chestY: hipY + 0.26 * s,
    elbowX: shoulderX + 0.015 * s,
    wristX: shoulderX + 0.02 * s,
  };
}

/**
 * Ragdoll body centres, in rest-pose world space, plus the bone each one rides.
 * Mirrors Ragdoll.defaultLayout().bodies so `bodyCentre()` reproduces exactly the
 * transform the physics side expects.
 */
function ragdollOffsets(L) {
  const s = L.s;
  return {
    pelvis: { bone: 'pelvis', p: [0, L.hipY + 0.035 * s, 0] },
    spine: { bone: 'spine', p: [0, L.hipY + 0.185 * s, 0] },
    chest: { bone: 'chest', p: [0, (L.shoulderY + L.neckY) * 0.5 - 0.1 * s, 0] },
    head: { bone: 'head', p: [0, L.neckY + 0.115 * s, 0.005 * s] },
    upperArmL: { bone: 'upperArmL', p: [-L.shoulderX - 0.01 * s, (L.shoulderY + L.elbowY) / 2, 0] },
    lowerArmL: { bone: 'lowerArmL', p: [-L.shoulderX - 0.02 * s, (L.elbowY + L.wristY) / 2, 0] },
    handL: { bone: 'handL', p: [-L.shoulderX - 0.02 * s, L.wristY - 0.05 * s, 0] },
    upperArmR: { bone: 'upperArmR', p: [L.shoulderX + 0.01 * s, (L.shoulderY + L.elbowY) / 2, 0] },
    lowerArmR: { bone: 'lowerArmR', p: [L.shoulderX + 0.02 * s, (L.elbowY + L.wristY) / 2, 0] },
    handR: { bone: 'handR', p: [L.shoulderX + 0.02 * s, L.wristY - 0.05 * s, 0] },
    thighL: { bone: 'thighL', p: [-L.hipX, (L.hipY + L.kneeY) / 2, 0] },
    shinL: { bone: 'shinL', p: [-L.hipX, (L.kneeY + L.ankleY) / 2, 0] },
    footL: { bone: 'footL', p: [-L.hipX, L.ankleY * 0.5, 0.045 * s] },
    thighR: { bone: 'thighR', p: [L.hipX, (L.hipY + L.kneeY) / 2, 0] },
    shinR: { bone: 'shinR', p: [L.hipX, (L.kneeY + L.ankleY) / 2, 0] },
    footR: { bone: 'footR', p: [L.hipX, L.ankleY * 0.5, 0.045 * s] },
  };
}

/** Bone segments in rest world space — the skeleton the auto-skinner measures against. */
function boneSegments(L) {
  const s = L.s;
  return {
    pelvis: [[0, L.hipY - 0.03, 0], [0, L.spineY, 0]],
    spine: [[0, L.spineY, 0], [0, L.chestY, 0]],
    chest: [[0, L.chestY, 0], [0, L.neckY, 0]],
    head: [[0, L.neckY, 0], [0, L.neckY + 0.22 * s, 0]],
    upperArmL: [[-L.shoulderX, L.shoulderY, 0], [-L.elbowX, L.elbowY, 0]],
    lowerArmL: [[-L.elbowX, L.elbowY, 0], [-L.wristX, L.wristY, 0]],
    handL: [[-L.wristX, L.wristY, 0], [-L.wristX, L.wristY - 0.11 * s, 0]],
    upperArmR: [[L.shoulderX, L.shoulderY, 0], [L.elbowX, L.elbowY, 0]],
    lowerArmR: [[L.elbowX, L.elbowY, 0], [L.wristX, L.wristY, 0]],
    handR: [[L.wristX, L.wristY, 0], [L.wristX, L.wristY - 0.11 * s, 0]],
    thighL: [[-L.hipX, L.hipY, 0], [-L.hipX, L.kneeY, 0]],
    shinL: [[-L.hipX, L.kneeY, 0], [-L.hipX, L.ankleY, 0]],
    footL: [[-L.hipX, L.ankleY, 0], [-L.hipX, L.ankleY * 0.35, 0.17 * s]],
    thighR: [[L.hipX, L.hipY, 0], [L.hipX, L.kneeY, 0]],
    shinR: [[L.hipX, L.kneeY, 0], [L.hipX, L.ankleY, 0]],
    footR: [[L.hipX, L.ankleY, 0], [L.hipX, L.ankleY * 0.35, 0.17 * s]],
  };
}

/* ══════════════════════════════════════════════════════ geometry primitives ══ */

/**
 * Swept tube through a polyline of rings. Each ring is [x, y, z, rx, rz]; rx/rz make
 * the section elliptical, which is what stops a torso reading as a drainpipe.
 * UVs are in metres (the MaterialLibrary convention).
 */
function tubeGeom(rings, radial = 10, capStart = true, capEnd = true) {
  const n = rings.length;
  const verts = [];
  const norms = [];
  const uvs = [];
  const idx = [];
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3();
  const rgt = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  let vLen = 0;
  const vs = new Array(n);

  for (let i = 0; i < n; i++) {
    const r = rings[i];
    const prev = rings[Math.max(0, i - 1)];
    const next = rings[Math.min(n - 1, i + 1)];
    dir.set(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
    dir.normalize();
    up.copy(dir);
    // Reference axis: X unless the tube runs along X.
    rgt.set(1, 0, 0);
    if (Math.abs(up.x) > 0.92) rgt.set(0, 0, 1);
    fwd.crossVectors(rgt, up).normalize();
    rgt.crossVectors(up, fwd).normalize();
    if (i > 0) {
      const q = rings[i - 1];
      vLen += Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2]);
    }
    vs[i] = vLen;
    const rx = r[3];
    const rz = r[4] ?? r[3];
    for (let a = 0; a < radial; a++) {
      const t = (a / radial) * Math.PI * 2;
      const ca = Math.cos(t);
      const sa = Math.sin(t);
      p.set(
        r[0] + rgt.x * ca * rx + fwd.x * sa * rz,
        r[1] + rgt.y * ca * rx + fwd.y * sa * rz,
        r[2] + rgt.z * ca * rx + fwd.z * sa * rz
      );
      // Ellipse normal: scale the parametric derivative back into normal space.
      nrm.set(
        rgt.x * (ca / rx) + fwd.x * (sa / rz),
        rgt.y * (ca / rx) + fwd.y * (sa / rz),
        rgt.z * (ca / rx) + fwd.z * (sa / rz)
      ).normalize();
      verts.push(p.x, p.y, p.z);
      norms.push(nrm.x, nrm.y, nrm.z);
      uvs.push((a / radial) * (Math.PI * (rx + rz)), vLen);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let a = 0; a < radial; a++) {
      const b = (a + 1) % radial;
      const i0 = i * radial + a;
      const i1 = i * radial + b;
      const i2 = (i + 1) * radial + a;
      const i3 = (i + 1) * radial + b;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
  }
  const capFan = (ringIndex, flip) => {
    const r = rings[ringIndex];
    const base = verts.length / 3;
    const prev = rings[Math.max(0, ringIndex - 1)];
    const next = rings[Math.min(n - 1, ringIndex + 1)];
    dir.set(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
    if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
    dir.normalize();
    if (flip) dir.negate();
    verts.push(r[0], r[1], r[2]);
    norms.push(dir.x, dir.y, dir.z);
    uvs.push(0, vs[ringIndex]);
    for (let a = 0; a < radial; a++) {
      const o = ringIndex * radial + a;
      const b = ringIndex * radial + ((a + 1) % radial);
      if (flip) idx.push(base, o, b);
      else idx.push(base, b, o);
    }
  };
  if (capStart) capFan(0, true);
  if (capEnd) capFan(n - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** Rounded box, axis aligned, then transformed. `seg` subdivisions per face side. */
function roundedBoxGeom(w, h, d, r, seg = 2) {
  const hx = w * 0.5;
  const hy = h * 0.5;
  const hz = d * 0.5;
  const rr = Math.min(r, hx * 0.95, hy * 0.95, hz * 0.95);
  const ix = hx - rr;
  const iy = hy - rr;
  const iz = hz - rr;
  const g = new THREE.BoxGeometry(2, 2, 2, seg, seg, seg);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const v = new THREE.Vector3();
  const c = new THREE.Vector3();
  const dlt = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i) * 0.5 * w, pos.getY(i) * 0.5 * h, pos.getZ(i) * 0.5 * d);
    c.set(clamp(v.x, -ix, ix), clamp(v.y, -iy, iy), clamp(v.z, -iz, iz));
    dlt.subVectors(v, c);
    const len = dlt.length();
    if (len > 1e-6) {
      dlt.multiplyScalar(1 / len);
      // Analytic normal: identical for coincident verts, so the bevel stays smooth
      // even though BoxGeometry duplicates every face corner.
      nor.setXYZ(i, dlt.x, dlt.y, dlt.z);
      dlt.multiplyScalar(rr);
    }
    pos.setXYZ(i, c.x + dlt.x, c.y + dlt.y, c.z + dlt.z);
  }
  g.deleteAttribute('uv');
  return g;
}

/** Metre-space UVs by dominant-normal planar projection. */
function planarUv(g) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (ny >= nx && ny >= nz) {
      uv[i * 2] = x;
      uv[i * 2 + 1] = z;
    } else if (nx >= nz) {
      uv[i * 2] = z;
      uv[i * 2 + 1] = y;
    } else {
      uv[i * 2] = x;
      uv[i * 2 + 1] = y;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const _m4 = new THREE.Matrix4();
const _q4 = new THREE.Quaternion();
const _e4 = new THREE.Euler();

function placed(g, x, y, z, rx = 0, ry = 0, rz = 0) {
  _e4.set(rx, ry, rz, 'XYZ');
  _q4.setFromEuler(_e4);
  _m4.compose(new THREE.Vector3(x, y, z), _q4, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m4);
  return g;
}

/** Merge a list of {geometry, color[]} into one indexed buffer geometry. */
function mergeParts(parts) {
  let vCount = 0;
  let iCount = 0;
  for (const p of parts) {
    vCount += p.geometry.attributes.position.count;
    iCount += p.geometry.index ? p.geometry.index.count : 0;
  }
  const position = new Float32Array(vCount * 3);
  const normal = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const color = new Float32Array(vCount * 3);
  const skinIndex = new Uint16Array(vCount * 4);
  const skinWeight = new Float32Array(vCount * 4);
  const index = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const g = p.geometry;
    const pa = g.attributes.position;
    const na = g.attributes.normal;
    const ua = g.attributes.uv;
    const n = pa.count;
    position.set(pa.array.subarray(0, n * 3), vo * 3);
    if (na) normal.set(na.array.subarray(0, n * 3), vo * 3);
    if (ua) uv.set(ua.array.subarray(0, n * 2), vo * 2);
    if (p.color) color.set(p.color.subarray(0, n * 3), vo * 3);
    if (p.skinIndex) skinIndex.set(p.skinIndex.subarray(0, n * 4), vo * 4);
    if (p.skinWeight) skinWeight.set(p.skinWeight.subarray(0, n * 4), vo * 4);
    const gi = g.index;
    if (gi) {
      for (let k = 0; k < gi.count; k++) index[io + k] = gi.array[k] + vo;
      io += gi.count;
    }
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

/* ═══════════════════════════════════════════════════════════════ colourways ══ */

/**
 * Kit colourways. The values are deliberately *separated*: uniform mid-tone, load
 * bearing gear a stop and a half darker and a different hue, helmet darker again,
 * boots and gloves near-black. Kit that is all one value is exactly what makes a
 * character read as a mannequin under a hard sun.
 */
export const VARIANTS = [
  {
    id: 'olive',
    uniform: 0x3c412e, webbing: 0x1d1f19, helmet: 0x22241c,
    boot: 0x131211, skin: 0x9a6f50, grime: 0.6,
  },
  {
    id: 'coyote',
    uniform: 0x554c37, webbing: 0x2a2419, helmet: 0x2f2a1f,
    boot: 0x1a1611, skin: 0x8a5c3e, grime: 0.75,
  },
  {
    id: 'urban',
    uniform: 0x33363b, webbing: 0x18191b, helmet: 0x1d1e21, boot: 0x101011,
    skin: 0x784e33, grime: 0.5,
  },
];

/* ══════════════════════════════════════════════════════════════════ builder ══ */

export default function createCharacterBuilder(ctx) {
  const cache = new Map();
  const owned = { geometries: [], materials: [] };
  const stats = { built: 0, variants: 0, triangles: 0 };
  let warned = false;

  const warn = (msg, err) => {
    if (warned) return;
    warned = true;
    console.warn(`[ai/character] ${msg}`, err?.message || err || '');
  };

  function material(name, tint, extra) {
    const lib = ctx.materials;
    let m = null;
    const opts = { vertexColors: true, ...(extra || {}) };
    try {
      // Tinted kit is a *variant*, so it has to be a clone — never mutate a cached
      // library material, three other systems are sharing it.
      if (tint !== undefined && lib?.clone) {
        m = lib.clone(name, { ...opts, color: tint });
        if (m) owned.materials.push(m);
      } else if (lib?.get) {
        m = lib.get(name, opts);
      }
    } catch (err) {
      warn(`material ${name} unavailable`, err);
      m = null;
    }
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: tint ?? 0x6a6a5a, roughness: 0.85, metalness: 0.03, vertexColors: true,
      });
      owned.materials.push(m);
    }
    return m;
  }

  /* ── the model ─────────────────────────────────────────────────────────── */

  /**
   * Author every piece of kit in rest-pose world space. `q` is a quality knob
   * (0 = headless/low, 1 = full) that only drives tessellation.
   */
  function authorParts(L, variant, q) {
    /** @type {Array<{geometry:THREE.BufferGeometry, slot:string, bones:string[], grime:number}>} */
    const parts = [];
    const s = L.s;
    const RAD = (n) => Math.max(5, Math.round(n * (0.55 + 0.45 * q)));
    const SEG = q > 0.5 ? 2 : 1;

    const add = (geometry, slot, bones, grime = 0.35) => {
      if (!geometry) return;
      parts.push({ geometry, slot, bones, grime });
    };
    const box = (slot, bones, grime, w, h, d, r, x, y, z, rx, ry, rz, seg) =>
      add(placed(planarUv(roundedBoxGeom(w, h, d, r, seg ?? SEG)), x, y, z, rx, ry, rz), slot, bones, grime);

    /* ── legs ───────────────────────────────────────────────────────────── */
    for (const side of [-1, 1]) {
      const X = side * L.hipX;
      const sfx = side < 0 ? 'L' : 'R';
      const thighB = `thigh${sfx}`;
      const shinB = `shin${sfx}`;
      const footB = `foot${sfx}`;

      // Trouser leg: hip → boot blousing. The bulge at the calf and the flare at the
      // boot cuff are what read as "trousers tucked into boots".
      add(tubeGeom([
        [X, L.hipY + 0.09 * s, 0.006 * s, 0.132 * s, 0.125 * s],
        [X, L.hipY - 0.02 * s, 0.004 * s, 0.126 * s, 0.121 * s],
        [X, L.hipY - 0.16 * s, 0.002 * s, 0.112 * s, 0.108 * s],
        [X, L.kneeY + 0.09 * s, 0, 0.098 * s, 0.096 * s],
        [X, L.kneeY, 0.004 * s, 0.092 * s, 0.094 * s],
        [X, L.kneeY - 0.11 * s, 0.002 * s, 0.094 * s, 0.098 * s],
        [X, L.ankleY + 0.20 * s, -0.004 * s, 0.082 * s, 0.086 * s],
        [X, L.ankleY + 0.115 * s, -0.004 * s, 0.090 * s, 0.092 * s],
        [X, L.ankleY + 0.085 * s, -0.004 * s, 0.078 * s, 0.080 * s],
      ], RAD(12), true, true), 'uniform', [thighB, shinB, 'pelvis', footB], 0.4);

      // Cargo pocket, outboard, with a flap.
      box('uniform', [thighB], 0.5, 0.055 * s, 0.17 * s, 0.115 * s, 0.022 * s,
        X + side * 0.115 * s, L.hipY - 0.19 * s, 0.012 * s, 0, 0, side * 0.08);
      box('webbing', [thighB], 0.6, 0.05 * s, 0.045 * s, 0.12 * s, 0.014 * s,
        X + side * 0.118 * s, L.hipY - 0.115 * s, 0.012 * s, 0, 0, side * 0.08);

      // Knee pad — three raised ribs so it is not a flat slab.
      box('webbing', [shinB, thighB], 0.75, 0.10 * s, 0.135 * s, 0.055 * s, 0.026 * s,
        X, L.kneeY + 0.012 * s, 0.078 * s, -0.05, 0, 0);
      for (let k = -1; k <= 1; k++) {
        box('webbing', [shinB, thighB], 0.8, 0.085 * s, 0.022 * s, 0.02 * s, 0.008 * s,
          X, L.kneeY + 0.012 * s + k * 0.04 * s, 0.104 * s, -0.05, 0, 0, 1);
      }

      /* boot */
      add(tubeGeom([
        [X, L.ankleY + 0.135 * s, -0.006 * s, 0.070 * s, 0.076 * s],
        [X, L.ankleY + 0.055 * s, -0.004 * s, 0.064 * s, 0.070 * s],
        [X, L.ankleY, 0, 0.060 * s, 0.068 * s],
      ], RAD(10), true, false), 'boot', [footB, shinB], 0.85);
      box('boot', [footB], 0.9, 0.105 * s, 0.085 * s, 0.255 * s, 0.032 * s,
        X, L.ankleY - 0.008 * s, 0.055 * s);
      // Toe cap and heel block break the silhouette.
      box('boot', [footB], 0.95, 0.098 * s, 0.055 * s, 0.075 * s, 0.026 * s,
        X, L.ankleY - 0.018 * s, 0.145 * s, 0.12, 0, 0, 1);
      // Lugged sole.
      box('boot', [footB], 1.0, 0.112 * s, 0.028 * s, 0.272 * s, 0.012 * s,
        X, L.ankleY - 0.048 * s, 0.052 * s, 0, 0, 0, 1);
      // Lace panel.
      for (let k = 0; k < 3; k++) {
        box('webbing', [footB, shinB], 0.7, 0.05 * s, 0.012 * s, 0.014 * s, 0.005 * s,
          X, L.ankleY + 0.03 * s + k * 0.038 * s, 0.052 * s - k * 0.006 * s, 0, 0, 0, 1);
      }
    }

    /* drop-leg holster, right thigh */
    box('webbing', ['thighR'], 0.6, 0.075 * s, 0.155 * s, 0.09 * s, 0.026 * s,
      L.hipX + 0.125 * s, L.hipY - 0.235 * s, -0.005 * s, 0, 0, 0.1);
    box('webbing', ['thighR'], 0.55, 0.028 * s, 0.10 * s, 0.02 * s, 0.008 * s,
      L.hipX + 0.16 * s, L.hipY - 0.16 * s, -0.005 * s, 0, 0, 0.1, 1);

    /* ── hips, belt, torso ──────────────────────────────────────────────── */
    add(tubeGeom([
      [0, L.hipY - 0.05 * s, 0, 0.150 * s, 0.112 * s],
      [0, L.hipY + 0.03 * s, 0, 0.156 * s, 0.116 * s],
      [0, L.spineY, 0, 0.150 * s, 0.112 * s],
      [0, L.spineY + 0.09 * s, 0, 0.158 * s, 0.116 * s],
      [0, L.chestY, 0.004 * s, 0.176 * s, 0.126 * s],
      [0, L.chestY + 0.11 * s, 0.006 * s, 0.192 * s, 0.134 * s],
      [0, L.shoulderY - 0.02 * s, 0.004 * s, 0.196 * s, 0.130 * s],
      [0, L.shoulderY + 0.045 * s, 0, 0.170 * s, 0.116 * s],
      [0, L.neckY - 0.03 * s, 0, 0.108 * s, 0.088 * s],
    ], RAD(14), true, true), 'uniform', ['pelvis', 'spine', 'chest'], 0.3);

    // Rigger belt + buckle + dump pouch.
    add(tubeGeom([
      [0, L.hipY + 0.005 * s, 0, 0.162 * s, 0.122 * s],
      [0, L.hipY + 0.065 * s, 0, 0.164 * s, 0.124 * s],
    ], RAD(14), false, false), 'webbing', ['pelvis'], 0.65);
    box('metal', ['pelvis'], 0.5, 0.07 * s, 0.052 * s, 0.028 * s, 0.008 * s,
      0, L.hipY + 0.035 * s, 0.126 * s, 0, 0, 0, 1);
    box('webbing', ['pelvis'], 0.7, 0.10 * s, 0.12 * s, 0.07 * s, 0.026 * s,
      -0.155 * s, L.hipY - 0.02 * s, -0.055 * s, 0, -0.4, 0);

    /* ── plate carrier ──────────────────────────────────────────────────── */
    const pcY = L.chestY + 0.10 * s;
    box('webbing', ['chest', 'spine'], 0.45, 0.30 * s, 0.35 * s, 0.095 * s, 0.032 * s,
      0, pcY, 0.125 * s, -0.04, 0, 0, SEG + 1);
    box('webbing', ['chest', 'spine'], 0.5, 0.31 * s, 0.37 * s, 0.09 * s, 0.032 * s,
      0, pcY, -0.122 * s, 0.03, 0, 0, SEG + 1);
    // Cummerbund wrapping the ribs.
    add(tubeGeom([
      [0, L.chestY - 0.03 * s, 0.002 * s, 0.186 * s, 0.134 * s],
      [0, L.chestY + 0.055 * s, 0.004 * s, 0.192 * s, 0.140 * s],
    ], RAD(14), false, false), 'webbing', ['spine', 'chest'], 0.6);

    // Shoulder yokes, front-over-back.
    for (const side of [-1, 1]) {
      add(tubeGeom([
        [side * 0.088 * s, pcY + 0.14 * s, 0.10 * s, 0.040 * s, 0.022 * s],
        [side * 0.10 * s, L.shoulderY + 0.028 * s, 0.045 * s, 0.044 * s, 0.026 * s],
        [side * 0.108 * s, L.shoulderY + 0.042 * s, -0.02 * s, 0.044 * s, 0.026 * s],
        [side * 0.095 * s, pcY + 0.14 * s, -0.095 * s, 0.040 * s, 0.022 * s],
      ], RAD(8), true, true), 'webbing', ['chest'], 0.55);
    }

    // MOLLE rows front and back.
    for (let r = 0; r < 3; r++) {
      box('webbing', ['chest'], 0.7, 0.22 * s, 0.014 * s, 0.012 * s, 0.005 * s,
        0, pcY - 0.10 * s + r * 0.075 * s, 0.176 * s, -0.04, 0, 0, 1);
    }
    for (let r = 0; r < 2; r++) {
      box('webbing', ['chest'], 0.75, 0.24 * s, 0.014 * s, 0.012 * s, 0.005 * s,
        0, pcY - 0.06 * s + r * 0.085 * s, -0.168 * s, 0.03, 0, 0, 1);
    }

    // Three rifle-mag pouches, admin pouch, radio.
    for (let m = -1; m <= 1; m++) {
      box('webbing', ['chest'], 0.6, 0.082 * s, 0.155 * s, 0.055 * s, 0.02 * s,
        m * 0.093 * s, pcY - 0.075 * s, 0.192 * s, -0.05, m * 0.06, 0);
      box('webbing', ['chest'], 0.65, 0.078 * s, 0.038 * s, 0.05 * s, 0.014 * s,
        m * 0.093 * s, pcY + 0.012 * s, 0.193 * s, -0.05, m * 0.06, 0, 1);
    }
    box('webbing', ['chest'], 0.55, 0.13 * s, 0.10 * s, 0.045 * s, 0.018 * s,
      -0.075 * s, pcY + 0.115 * s, 0.178 * s, -0.06, 0.1, 0);
    box('webbing', ['chest'], 0.6, 0.085 * s, 0.15 * s, 0.06 * s, 0.022 * s,
      0.105 * s, pcY + 0.02 * s, -0.172 * s, 0.03, -0.1, 0);
    // Antenna stub.
    add(placed(tubeGeom([
      [0, 0, 0, 0.007 * s, 0.007 * s],
      [0, 0.16 * s, -0.02 * s, 0.005 * s, 0.005 * s],
    ], 5, true, true), 0.13 * s, pcY + 0.09 * s, -0.18 * s), 'metal', ['chest'], 0.4);
    // Hydration hose over the left shoulder.
    add(tubeGeom([
      [-0.13 * s, pcY - 0.02 * s, -0.14 * s, 0.011 * s, 0.011 * s],
      [-0.15 * s, L.shoulderY - 0.01 * s, -0.09 * s, 0.011 * s, 0.011 * s],
      [-0.12 * s, L.shoulderY + 0.05 * s, 0.02 * s, 0.011 * s, 0.011 * s],
      [-0.09 * s, pcY + 0.10 * s, 0.13 * s, 0.011 * s, 0.011 * s],
    ], 6, true, true), 'boot', ['chest'], 0.5);

    /* ── arms ───────────────────────────────────────────────────────────── */
    for (const side of [-1, 1]) {
      const sfx = side < 0 ? 'L' : 'R';
      const uB = `upperArm${sfx}`;
      const lB = `lowerArm${sfx}`;
      const hB = `hand${sfx}`;
      const sx = side * L.shoulderX;
      const ex = side * L.elbowX;
      const wx = side * L.wristX;

      // Sleeve: deltoid bulge, rolled cuff at the elbow, tapered forearm.
      add(tubeGeom([
        [sx, L.shoulderY + 0.078 * s, 0, 0.072 * s, 0.072 * s],
        [sx, L.shoulderY + 0.02 * s, 0, 0.084 * s, 0.082 * s],
        [sx + side * 0.004 * s, L.shoulderY - 0.075 * s, 0, 0.076 * s, 0.074 * s],
        [ex, L.elbowY + 0.045 * s, 0, 0.066 * s, 0.066 * s],
        [ex, L.elbowY - 0.005 * s, 0.002 * s, 0.070 * s, 0.070 * s],
        [ex, L.elbowY - 0.05 * s, 0, 0.063 * s, 0.063 * s],
        [wx, L.wristY + 0.10 * s, 0, 0.056 * s, 0.056 * s],
        [wx, L.wristY + 0.035 * s, 0, 0.050 * s, 0.050 * s],
        [wx, L.wristY + 0.012 * s, 0, 0.053 * s, 0.053 * s],
      ], RAD(10), true, true), 'uniform', [uB, lB, 'chest', hB], 0.35);

      // Elbow pad.
      box('webbing', [lB, uB], 0.8, 0.082 * s, 0.11 * s, 0.05 * s, 0.022 * s,
        ex, L.elbowY - 0.005 * s, -0.058 * s, 0.06, 0, 0);
      // Shoulder patch / brassard.
      box('webbing', [uB], 0.5, 0.022 * s, 0.065 * s, 0.085 * s, 0.008 * s,
        sx + side * 0.078 * s, L.shoulderY - 0.03 * s, 0, 0, 0, 0, 1);

      // Glove: palm block, thumb, knuckle plate.
      box('boot', [hB, lB], 0.7, 0.058 * s, 0.12 * s, 0.095 * s, 0.026 * s,
        wx, L.wristY - 0.058 * s, 0.004 * s);
      box('boot', [hB], 0.7, 0.032 * s, 0.058 * s, 0.036 * s, 0.014 * s,
        wx - side * 0.032 * s, L.wristY - 0.04 * s, 0.038 * s, 0.2, 0, side * 0.35, 1);
      box('webbing', [hB], 0.75, 0.054 * s, 0.032 * s, 0.054 * s, 0.01 * s,
        wx, L.wristY - 0.105 * s, 0.012 * s, 0, 0, 0, 1);
    }

    /* ── neck & head ────────────────────────────────────────────────────── */
    add(tubeGeom([
      [0, L.neckY - 0.055 * s, -0.004 * s, 0.054 * s, 0.050 * s],
      [0, L.neckY + 0.03 * s, 0, 0.050 * s, 0.048 * s],
      [0, L.neckY + 0.062 * s, 0.004 * s, 0.056 * s, 0.054 * s],
    ], RAD(9), true, false), 'skin', ['head', 'chest'], 0.25);

    // Skull. Rings from jaw to crown; the last two shrink to close the dome.
    const hy = L.neckY;
    add(tubeGeom([
      [0, hy + 0.045 * s, 0.006 * s, 0.062 * s, 0.062 * s],
      [0, hy + 0.075 * s, 0.010 * s, 0.078 * s, 0.082 * s],
      [0, hy + 0.115 * s, 0.008 * s, 0.088 * s, 0.096 * s],
      [0, hy + 0.155 * s, 0.004 * s, 0.092 * s, 0.100 * s],
      [0, hy + 0.196 * s, -0.002 * s, 0.080 * s, 0.086 * s],
      [0, hy + 0.226 * s, -0.008 * s, 0.048 * s, 0.052 * s],
      [0, hy + 0.240 * s, -0.012 * s, 0.014 * s, 0.016 * s],
    ], RAD(12), true, true), 'skin', ['head'], 0.2);

    // Balaclava: everything from the collar to the goggle line, leaving only a strip
    // of skin around the eyes — which the goggles then cover anyway.
    add(tubeGeom([
      [0, hy + 0.026 * s, 0.006 * s, 0.064 * s, 0.064 * s],
      [0, hy + 0.070 * s, 0.010 * s, 0.083 * s, 0.087 * s],
      [0, hy + 0.108 * s, 0.008 * s, 0.093 * s, 0.101 * s],
      [0, hy + 0.134 * s, 0.006 * s, 0.095 * s, 0.103 * s],
    ], RAD(11), true, true), 'webbing', ['head'], 0.45);

    /* ── helmet ─────────────────────────────────────────────────────────── */
    // Rounded ballistic dome: the ring radii follow a sphere so the crown does not
    // come to a point, which is the classic tell of a lathe-built helmet.
    add(tubeGeom([
      [0, hy + 0.130 * s, -0.004 * s, 0.104 * s, 0.113 * s],
      [0, hy + 0.152 * s, -0.004 * s, 0.110 * s, 0.119 * s],
      [0, hy + 0.196 * s, -0.006 * s, 0.106 * s, 0.114 * s],
      [0, hy + 0.230 * s, -0.009 * s, 0.094 * s, 0.101 * s],
      [0, hy + 0.256 * s, -0.012 * s, 0.074 * s, 0.080 * s],
      [0, hy + 0.274 * s, -0.014 * s, 0.048 * s, 0.052 * s],
      [0, hy + 0.284 * s, -0.015 * s, 0.020 * s, 0.022 * s],
      [0, hy + 0.288 * s, -0.016 * s, 0.005 * s, 0.006 * s],
    ], RAD(14), true, true), 'webbing', ['head'], 0.52);

    // Goggles pushed up onto the shell, proud of it so they cast their own shadow.
    add(tubeGeom([
      [0, hy + 0.150 * s, 0.002 * s, 0.116 * s, 0.124 * s],
      [0, hy + 0.180 * s, 0.000 * s, 0.117 * s, 0.125 * s],
    ], RAD(11), false, false), 'boot', ['head'], 0.4);
    box('boot', ['head'], 0.3, 0.148 * s, 0.050 * s, 0.040 * s, 0.016 * s,
      0, hy + 0.166 * s, 0.088 * s, 0.12, 0, 0);
    box('metal', ['head'], 0.3, 0.160 * s, 0.012 * s, 0.016 * s, 0.005 * s,
      0, hy + 0.190 * s, 0.086 * s, 0.12, 0, 0, 1);
    // Brim lip.
    add(tubeGeom([
      [0, hy + 0.126 * s, -0.004 * s, 0.108 * s, 0.117 * s],
      [0, hy + 0.140 * s, -0.004 * s, 0.113 * s, 0.122 * s],
    ], RAD(14), false, false), 'webbing', ['head'], 0.68);

    // NVG shroud + folded mount arm, front and centre on the crown.
    box('metal', ['head'], 0.45, 0.058 * s, 0.042 * s, 0.034 * s, 0.008 * s,
      0, hy + 0.222 * s, 0.088 * s, 0.35, 0, 0, 1);
    add(placed(tubeGeom([
      [0, 0, 0, 0.014 * s, 0.014 * s],
      [0, 0.040 * s, 0.020 * s, 0.011 * s, 0.011 * s],
    ], 6, true, true), 0, hy + 0.236 * s, 0.090 * s, -0.7, 0, 0), 'metal', ['head'], 0.4);
    // Side rails + rear counterweight pouch.
    for (const side of [-1, 1]) {
      box('metal', ['head'], 0.5, 0.014 * s, 0.028 * s, 0.12 * s, 0.005 * s,
        side * 0.112 * s, hy + 0.190 * s, 0.010 * s, 0, side * 0.12, 0, 1);
    }
    box('webbing', ['head'], 0.6, 0.09 * s, 0.066 * s, 0.05 * s, 0.02 * s,
      0, hy + 0.212 * s, -0.104 * s, -0.18, 0, 0, 1);

    // Four-point chin strap + chin cup.
    for (const side of [-1, 1]) {
      for (const zf of [0.052, -0.048]) {
        add(tubeGeom([
          [side * 0.098 * s, hy + 0.126 * s, zf * s, 0.008 * s, 0.005 * s],
          [side * 0.082 * s, hy + 0.076 * s, zf * s * 0.95, 0.008 * s, 0.005 * s],
          [side * 0.052 * s, hy + 0.036 * s, 0.022 * s, 0.008 * s, 0.005 * s],
        ], 5, true, true), 'webbing', ['head'], 0.55);
      }
    }
    box('webbing', ['head'], 0.6, 0.05 * s, 0.026 * s, 0.03 * s, 0.010 * s,
      0, hy + 0.030 * s, 0.044 * s, 0.3, 0, 0, 1);

    return parts;
  }

  /* ── the carried rifle (hung off the weapon anchor, gripped by IK) ──────── */

  function buildRifle(L, q) {
    const g = new THREE.Group();
    g.name = 'ai_rifle';
    // One material, one draw call. `grime` per part is carried in the vertex mask, so
    // the polymer furniture still reads differently from the machined receiver.
    const parts = [];
    const push = (geo, slot) => {
      geo.userData.grime = slot === 'boot' ? 0.72 : 0.3;
      parts.push(geo);
    };

    // Local space: +Z is muzzle-forward, origin at the pistol grip / trigger.
    push(placed(planarUv(roundedBoxGeom(0.052, 0.085, 0.30, 0.012, 2)), 0, 0.055, 0.10), 'metal');
    push(placed(planarUv(roundedBoxGeom(0.042, 0.055, 0.16, 0.010, 1)), 0, 0.052, -0.115), 'metal');
    // Stock.
    push(placed(planarUv(roundedBoxGeom(0.05, 0.075, 0.14, 0.016, 1)), 0, 0.048, -0.235), 'boot');
    // Handguard.
    push(placed(tubeGeom([
      [0, 0, 0.245, 0.030, 0.030],
      [0, 0, 0.40, 0.028, 0.028],
      [0, 0, 0.46, 0.026, 0.026],
    ], q > 0.5 ? 8 : 6, true, true), 0, 0.055, 0), 'metal');
    // Barrel + flash hider.
    push(placed(tubeGeom([
      [0, 0, 0.44, 0.010, 0.010],
      [0, 0, 0.575, 0.0095, 0.0095],
      [0, 0, 0.60, 0.014, 0.014],
      [0, 0, 0.635, 0.013, 0.013],
    ], 6, true, true), 0, 0.055, 0), 'metal');
    // Magazine.
    push(placed(planarUv(roundedBoxGeom(0.030, 0.20, 0.062, 0.010, 1)), 0, -0.055, 0.07, 0.16, 0, 0), 'metal');
    // Pistol grip.
    push(placed(planarUv(roundedBoxGeom(0.034, 0.115, 0.05, 0.014, 1)), 0, -0.048, -0.045, -0.32, 0, 0), 'boot');
    // Optic.
    push(placed(planarUv(roundedBoxGeom(0.036, 0.042, 0.115, 0.010, 1)), 0, 0.122, 0.10), 'metal');
    push(placed(planarUv(roundedBoxGeom(0.020, 0.035, 0.022, 0.006, 1)), 0, 0.098, 0.10, 0, 0, 0), 'metal');
    // Foregrip.
    push(placed(planarUv(roundedBoxGeom(0.026, 0.075, 0.030, 0.011, 1)), 0, 0.006, 0.36, 0.12, 0, 0), 'boot');

    const merged = mergeSimple(parts);
    owned.geometries.push(merged);
    const mesh = new THREE.Mesh(merged, material('painted_steel_chipped', 0x33353a, {
      repeat: 0.35, detail: 0.6,
    }));
    mesh.name = 'ai_rifle_mesh';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    // Locators. The hands are IK'd onto the grips, so these are the contract between
    // the weapon and the skeleton — move the rifle and the arms follow it.
    const locator = (name, x, y, z) => {
      const o = new THREE.Object3D();
      o.name = name;
      o.position.set(x, y, z);
      g.add(o);
      return o;
    };
    const muzzle = locator('muzzle', 0, 0.055, 0.65);
    locator('gripR', 0, 0.045, -0.045);
    locator('gripL', 0, 0.09, 0.24);
    locator('ejector', 0.035, 0.075, 0.10);
    return { group: g, muzzle };
  }

  /** Merge plain (unskinned) geometries — the rifle path. */
  function mergeSimple(list) {
    let vc = 0;
    let ic = 0;
    for (const g of list) {
      vc += g.attributes.position.count;
      ic += g.index ? g.index.count : 0;
    }
    const position = new Float32Array(vc * 3);
    const normal = new Float32Array(vc * 3);
    const uv = new Float32Array(vc * 2);
    const color = new Float32Array(vc * 3);
    const index = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
    let vo = 0;
    let io = 0;
    for (const g of list) {
      const n = g.attributes.position.count;
      position.set(g.attributes.position.array.subarray(0, n * 3), vo * 3);
      if (g.attributes.normal) normal.set(g.attributes.normal.array.subarray(0, n * 3), vo * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, n * 2), vo * 2);
      const grime = g.userData?.grime ?? 0.4;
      for (let k = 0; k < n; k++) {
        color[(vo + k) * 3] = grime;
        color[(vo + k) * 3 + 1] = 0;
        color[(vo + k) * 3 + 2] = 0;
      }
      if (g.index) {
        for (let k = 0; k < g.index.count; k++) index[io + k] = g.index.array[k] + vo;
        io += g.index.count;
      }
      vo += n;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(position, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.BufferAttribute(color, 3));
    out.setIndex(new THREE.BufferAttribute(index, 1));
    out.computeBoundingSphere();
    return out;
  }

  /*
   * The library's textures are authored for architecture: a canvas weave at 120
   * threads per metre and a carpet pile at 130 loops per metre look right on a tarp
   * or a rug, but a 20 cm head only spans a fifth of a tile, so the pattern lands at
   * ~4 px per cycle on screen and moirés into a wire net. Every slot therefore takes
   * a `repeat` well under 1 (blow the texture up) and a trimmed `detail` amount.
   */
  const SLOT_MATERIAL = {
    uniform: { name: 'fabric_uniform', repeat: 0.5, detail: 0.5, key: 'uniform' },
    webbing: { name: 'fabric_webbing', repeat: 0.45, detail: 0.5, key: 'webbing' },
    boot: { name: 'rubber_tyre', repeat: 0.5, detail: 0.5, key: 'boot' },
    metal: { name: 'painted_steel_chipped', repeat: 0.5, detail: 0.5 },
    skin: { name: 'skin_head', repeat: 0.12, detail: 0.35, key: 'skin' },
  };
  const matCache = new Map();
  function slotMaterial(slot, variant) {
    const key = `${slot}|${variant.id}`;
    let m = matCache.get(key);
    if (m) return m;
    const def = SLOT_MATERIAL[slot] || SLOT_MATERIAL.uniform;
    m = material(def.name, def.key ? variant[def.key] : undefined, {
      repeat: def.repeat,
      detail: def.detail,
    });
    matCache.set(key, m);
    return m;
  }

  /* ── auto skinning ─────────────────────────────────────────────────────── */

  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _ab = new THREE.Vector3();
  const _ap = new THREE.Vector3();

  function distToSegment(px, py, pz, seg) {
    _a.set(seg[0][0], seg[0][1], seg[0][2]);
    _b.set(seg[1][0], seg[1][1], seg[1][2]);
    _ab.subVectors(_b, _a);
    _ap.set(px - _a.x, py - _a.y, pz - _a.z);
    const l2 = _ab.lengthSq();
    const t = l2 > 1e-9 ? clamp(_ap.dot(_ab) / l2, 0, 1) : 0;
    const dx = _ap.x - _ab.x * t;
    const dy = _ap.y - _ab.y * t;
    const dz = _ap.z - _ab.z * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Inverse-cube distance weighting against the part's candidate bones. Restricting
   * the candidate set per part is what stops a hand (which is right next to a thigh
   * in the arms-down bind pose) from being skinned to the leg.
   */
  function skinPart(part, boneIndex, segs, variant) {
    const pos = part.geometry.attributes.position;
    const n = pos.count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    const cands = part.bones.filter((b) => boneIndex[b] !== undefined);
    if (!cands.length) cands.push('pelvis');
    const w = new Float64Array(cands.length);
    const grimeBase = clamp(part.grime * (0.6 + variant.grime * 0.7), 0, 1);
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      let total = 0;
      for (let c = 0; c < cands.length; c++) {
        const d = distToSegment(x, y, z, segs[cands[c]]);
        const v = 1 / Math.pow(d + 0.018, 3.2);
        w[c] = v;
        total += v;
      }
      // Keep the four strongest.
      const keep = Math.min(4, cands.length);
      const picked = [];
      const used = new Set();
      for (let k = 0; k < keep; k++) {
        let best = -1;
        let bv = -1;
        for (let c = 0; c < cands.length; c++) {
          if (used.has(c)) continue;
          if (w[c] > bv) { bv = w[c]; best = c; }
        }
        if (best < 0) break;
        used.add(best);
        picked.push([boneIndex[cands[best]], w[best]]);
      }
      let sum = 0;
      for (const pk of picked) sum += pk[1];
      if (sum <= 0) { picked.length = 0; picked.push([boneIndex[cands[0]], 1]); sum = 1; }
      for (let k = 0; k < 4; k++) {
        if (k < picked.length) {
          si[i * 4 + k] = picked[k][0];
          sw[i * 4 + k] = picked[k][1] / sum;
        }
      }
      // Grime mask: dirt climbs from the ground and settles in the low kit.
      const height = clamp(y / 1.85, 0, 1);
      const g = clamp(grimeBase * (1.25 - height * 0.85) + (1 - height) * 0.22, 0, 1);
      col[i * 3] = g;
      col[i * 3 + 1] = 0;
      col[i * 3 + 2] = 0;
      void total;
    }
    part.skinIndex = si;
    part.skinWeight = sw;
    part.color = col;
  }

  /* ── assembled, cached model ───────────────────────────────────────────── */

  function modelFor(variant, height, q) {
    const key = `${variant.id}|${height.toFixed(3)}|${q.toFixed(2)}`;
    let model = cache.get(key);
    if (model) return model;

    const L = soldierLayout(height);
    const segs = boneSegments(L);
    const boneIndex = {};
    BONE_ORDER.forEach((nm, i) => { boneIndex[nm] = i; });

    const parts = authorParts(L, variant, q);
    for (const p of parts) skinPart(p, boneIndex, segs, variant);

    const bySlot = new Map();
    for (const p of parts) {
      if (!bySlot.has(p.slot)) bySlot.set(p.slot, []);
      bySlot.get(p.slot).push(p);
    }
    const groups = [];
    let tris = 0;
    for (const [slot, list] of bySlot) {
      const geo = mergeParts(list);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height * 0.52, 0), height * 0.85);
      geo.boundingBox = new THREE.Box3(
        new THREE.Vector3(-0.9, -0.4, -0.9),
        new THREE.Vector3(0.9, height + 0.4, 0.9)
      );
      owned.geometries.push(geo);
      tris += (geo.index ? geo.index.count : 0) / 3;
      groups.push({ slot, geometry: geo, material: slotMaterial(slot, variant) });
      for (const p of list) p.geometry.dispose();
    }
    const rifle = buildRifle(L, q);
    model = { L, segs, groups, rifle, offsets: ragdollOffsets(L), triangles: tris };
    cache.set(key, model);
    stats.variants = cache.size;
    stats.triangles = tris;
    return model;
  }

  /* ── per-character instantiation ───────────────────────────────────────── */

  function makeBones(L) {
    const bones = {};
    const mk = (name, x, y, z, parent) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x, y, z);
      if (parent) parent.add(b);
      bones[name] = b;
      return b;
    };
    const pelvis = mk('pelvis', 0, L.hipY, 0, null);
    const spine = mk('spine', 0, L.spineY - L.hipY, 0, pelvis);
    const chest = mk('chest', 0, L.chestY - L.spineY, 0, spine);
    mk('head', 0, L.neckY - L.chestY, 0, chest);
    for (const side of [-1, 1]) {
      const sfx = side < 0 ? 'L' : 'R';
      const ua = mk(`upperArm${sfx}`, side * L.shoulderX, L.shoulderY - L.chestY, 0, chest);
      const la = mk(`lowerArm${sfx}`, side * (L.elbowX - L.shoulderX), L.elbowY - L.shoulderY, 0, ua);
      mk(`hand${sfx}`, side * (L.wristX - L.elbowX), L.wristY - L.elbowY, 0, la);
      const th = mk(`thigh${sfx}`, side * L.hipX, 0, 0, pelvis);
      const sh = mk(`shin${sfx}`, 0, L.kneeY - L.hipY, 0, th);
      mk(`foot${sfx}`, 0, L.ankleY - L.kneeY, 0, sh);
    }
    return { bones, root: pelvis };
  }

  /**
   * @param {{variant?:string|number, height?:number, quality?:number, rng?:Function}} opts
   */
  function build(opts = {}) {
    const q = clamp(opts.quality ?? 1, 0, 1);
    const height = clamp(opts.height ?? 1.8, 1.4, 2.1);
    let variant = VARIANTS[0];
    if (typeof opts.variant === 'number') variant = VARIANTS[opts.variant % VARIANTS.length];
    else if (typeof opts.variant === 'string') variant = VARIANTS.find((v) => v.id === opts.variant) || VARIANTS[0];

    const model = modelFor(variant, height, q);
    const L = model.L;
    const { bones, root: boneRoot } = makeBones(L);
    const boneList = BONE_ORDER.map((n) => bones[n]);

    const group = new THREE.Group();
    group.name = 'soldier';
    group.add(boneRoot);
    group.updateMatrixWorld(true);

    const skeleton = new THREE.Skeleton(boneList);
    const meshes = [];
    for (const g of model.groups) {
      const mesh = new THREE.SkinnedMesh(g.geometry, g.material);
      mesh.name = `soldier_${g.slot}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      mesh.bind(skeleton);
      mesh.normalizeSkinWeights();
      group.add(mesh);
      meshes.push(mesh);
    }

    /*
     * The weapon is NOT parented to a hand. It hangs off a root-space anchor whose
     * yaw is the body's and whose pitch is the aim's, so the barrel points *exactly*
     * along the fire direction — muzzle flash, tracer and bullet all agree — and the
     * hands are then IK'd onto its grips. Driving it the other way round (hand -> gun)
     * makes the barrel wander by whatever the shoulder pose happens to be.
     */
    const weaponAnchor = new THREE.Object3D();
    weaponAnchor.name = 'weaponAnchor';
    weaponAnchor.position.set(0.055 * L.s, L.chestY * 0.99, 0.27 * L.s);
    const rifle = model.rifle.group.clone(true);
    rifle.position.set(0, 0, 0);
    rifle.rotation.set(0, 0, 0);
    for (const c of rifle.children) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
    weaponAnchor.add(rifle);
    group.add(weaponAnchor);
    const muzzle = rifle.getObjectByName('muzzle') || rifle;
    const gripR = rifle.getObjectByName('gripR') || rifle;
    const gripL = rifle.getObjectByName('gripL') || rifle;

    // Hitbox proxies. `hitbox` is the tag Ballistics.classify() reads; the ids match
    // HITBOX_MULT exactly so the multipliers apply without a translation table.
    const hitboxes = [
      { id: 'head', hitbox: 'head', bones: ['head', 'head'], t0: 0.45, t1: 1.05, radius: 0.108 * L.s },
      { id: 'torso', hitbox: null, bones: ['pelvis', 'chest'], t0: -0.2, t1: 1.0, radius: 0.20 * L.s },
      { id: 'armL', hitbox: null, bones: ['upperArmL', 'handL'], t0: 0, t1: 1, radius: 0.072 * L.s },
      { id: 'armR', hitbox: null, bones: ['upperArmR', 'handR'], t0: 0, t1: 1, radius: 0.072 * L.s },
      { id: 'legL', hitbox: null, bones: ['thighL', 'footL'], t0: 0, t1: 1, radius: 0.105 * L.s },
      { id: 'legR', hitbox: null, bones: ['thighR', 'footR'], t0: 0, t1: 1, radius: 0.105 * L.s },
    ];

    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _sc = new THREE.Vector3();
    const _one = new THREE.Vector3(1, 1, 1);
    const _origin = new THREE.Vector3();
    const _off = new THREE.Matrix4();
    const _loc = new THREE.Matrix4();

    /** Rest-space offset from the bone origin to its ragdoll body centre. */
    function restOffset(name, out) {
      const def = model.offsets[name];
      const seg = model.segs[def.bone];
      const rest = seg ? seg[0] : [0, 0, 0];
      return out.set(def.p[0] - rest[0], def.p[1] - rest[1], def.p[2] - rest[2]);
    }

    /** World transform of the ragdoll body called `name`. */
    function bodyCentre(name, outPos, outQuat) {
      const def = model.offsets[name];
      const bone = bones[def?.bone];
      if (!bone) return false;
      bone.matrixWorld.decompose(_p, _q, _sc);
      restOffset(name, outPos).applyQuaternion(_q).add(_p);
      outQuat.copy(_q);
      return true;
    }

    /** Inverse of bodyCentre: place `bone` so its ragdoll body lands on (pos, quat). */
    function applyBody(name, pos, quat) {
      const def = model.offsets[name];
      const bone = bones[def?.bone];
      if (!bone) return false;
      restOffset(name, _origin).applyQuaternion(quat);
      _p.set(pos.x - _origin.x, pos.y - _origin.y, pos.z - _origin.z);
      _off.compose(_p, quat, _one);
      if (bone.parent) {
        _loc.copy(bone.parent.matrixWorld).invert().multiply(_off);
      } else {
        _loc.copy(_off);
      }
      _loc.decompose(bone.position, bone.quaternion, _sc);
      bone.scale.set(1, 1, 1);
      return true;
    }

    stats.built++;
    return {
      root: group,
      bones,
      boneList,
      skeleton,
      meshes,
      rifle,
      weaponAnchor,
      muzzle,
      gripR,
      gripL,
      hitboxes,
      layout: L,
      variant,
      offsets: model.offsets,
      segments: model.segs,
      bodyCentre,
      applyBody,
      setVisible(v) {
        group.visible = !!v;
      },
      /** Hand the weapon to the ragdoll (or take it back on respawn). */
      stowWeapon(toHand) {
        const parent = toHand ? bones.handR : group;
        if (weaponAnchor.parent === parent) return;
        group.updateMatrixWorld(true);
        parent.attach(weaponAnchor);
        if (!toHand) {
          weaponAnchor.position.set(0.055 * L.s, L.chestY * 0.99, 0.27 * L.s);
          weaponAnchor.quaternion.identity();
          weaponAnchor.scale.set(1, 1, 1);
        }
      },
      dispose() {
        group.removeFromParent();
        skeleton.dispose?.();
        // Geometry and materials are shared and owned by the builder.
        weaponAnchor.removeFromParent();
      },
    };
  }

  return {
    build,
    variants: VARIANTS,
    layout: soldierLayout,
    stats,
    dispose() {
      for (const g of owned.geometries) g.dispose?.();
      for (const m of owned.materials) m.dispose?.();
      owned.geometries.length = 0;
      owned.materials.length = 0;
      cache.clear();
      matCache.clear();
    },
  };
}
