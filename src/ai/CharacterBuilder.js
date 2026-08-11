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
 * ── Reading at range ────────────────────────────────────────────────────────────
 * A soldier is judged first as a silhouette. Two things decide whether he has one:
 * whether the kit is big enough to interrupt the outline of the body (a plate
 * carrier is armour worn *over* a man, so it is wider than his ribs; a helmet is a
 * shell over pads, so it is far bigger than his skull), and whether the recesses
 * between the shells are dark. Neither is free here — see `bakeVertexAO()` for the
 * second and the plate-carrier/helmet blocks for the first — and without them the
 * whole figure collapses into one tapered tube at 25 m.
 *
 * Geometry is cached per (variant, height, quality) and shared by every soldier;
 * only the bones, the skeleton and the SkinnedMesh wrappers are per-character.
 * `AISystem.spawn()` quantises height so that cache actually hits.
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
/*
 * ── Why there is a `scarf` slot, and why the whole ladder moved up ──────────────
 * Round one: helmet, torso, arms, thighs and boots were all in one narrow brown band.
 * The fix was a `scarf` slot — a light shemagh at the collar, a coloured brassard —
 * so the figure had something that was NOT brown.
 *
 * Round two measured what that actually bought at the distance the game shows an
 * enemy, and the answer was nothing. Mean luma 57-71 against a 94-100 background: the
 * soldier was a *hole* in the frame, not a figure in it, and every light value in the
 * kit was allocated to the two smallest surfaces on the model — a collar roll and a
 * strip of jaw, three pixels apiece at 40 px tall. Separation you can only see at 10 m
 * is not separation.
 *
 * So the ladder is rebuilt around surface *area*:
 *
 *   panel   0x93967a  lightest — shoulder yokes, thigh cargo panels, helmet cover
 *                     band, knee pads. Big, high, and on the outline.
 *   uniform 0x74785a  the blouse, the sleeves, the trouser legs: most of the body,
 *                     and now roughly the value of sunlit sand rather than of shade.
 *   helmet  0x6a6d54  a fabric COVER over the shell, not a black shell. A head-sized
 *                     dark mass on the shoulders was reading as a missing head.
 *   webbing 0x4a4c3a  plate bags, pouches, cummerbund — the mid-dark that the light
 *                     panels have to sit against or none of this works.
 *   boot    0x2b2823  boots, gloves, goggles. Dark, but not a cutout.
 *
 * Every value is roughly 1.7-2.6x its old albedo, which is what closes the 57 -> ~105
 * gap; the *ratios* between them are wider than before, not narrower, so the figure
 * gains internal contrast at the same time as it stops being a silhouette.
 */
export const VARIANTS = [
  {
    id: 'olive',
    uniform: 0x74785a, panel: 0x93967a, webbing: 0x4a4c3a, helmet: 0x6a6d54,
    boot: 0x2b2823, metalKit: 0x40434a, skin: 0xbd9068, scarf: 0xcfc6ae, grime: 0.6,
  },
  {
    id: 'coyote',
    uniform: 0x8d8161, panel: 0xa89b78, webbing: 0x554d3c, helmet: 0x7b7053,
    boot: 0x312b26, metalKit: 0x454039, skin: 0xb4835a, scarf: 0xb35646, grime: 0.75,
  },
  {
    id: 'urban',
    uniform: 0x686d76, panel: 0x868c96, webbing: 0x3e4147, helmet: 0x5b6068,
    boot: 0x26282c, metalKit: 0x3c3f45, skin: 0xa87a56, scarf: 0x9fb0ba, grime: 0.5,
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

  /**
   * ── Why every character material is a private clone, and why it is re-tuned ──────
   *
   * Measured on the firefight frame: a sunlit soldier came out at L≈167 against a
   * sunlit brick wall at L≈91 and sand at L≈100 — brighter than every surface around
   * him, with the whole authored value ladder (uniform 0x3c412e / helmet 0x22241c /
   * boot 0x131211) crushed into one cream tone. The albedo was innocent: the shader
   * multiplies `material.color` (linear 0.045) by the canvas albedo (~0.5), so the
   * diffuse term is *tiny*. What was lifting him were the **albedo-independent**
   * lobes, and on a body they cover a far larger share of the pixels than they do on
   * architecture, because a limb is a tube and most of a tube faces the eye at a
   * grazing angle:
   *
   *   • `fabric_uniform` ships sheen 0.85 / `fabric_webbing` 0.6 with a *bright*
   *     sheen colour. Sheen is a broad retro-reflective lobe that is *added* after
   *     the diffuse, is strongest at grazing angles, and does not care what colour
   *     the cloth is. Additive light is exactly what flattens a value ladder: the
   *     same +x lands on the 0.045 uniform and the 0.016 helmet.
   *   • `envMapIntensity` 1.0 gives the kit a full unoccluded sky hemisphere. A man
   *     standing in a street sees a slot of sky, not a dome of it.
   *   • the dust layer lerps albedo towards a pale sand colour on up-facing facets.
   *     Right for a windowsill that has stood there a month, wrong for a soldier.
   *
   * Those knobs belong to `materials/MaterialLibrary.js` and are correct for tarps,
   * awnings and sandbags, so they are not changed there — they are dialled back here,
   * on clones this module owns outright. Never `lib.get()`: that hands back a *shared
   * cached* material and re-tuning it would repaint every tarp on the map.
   */
  function material(name, tint, extra) {
    const lib = ctx.materials;
    const tune = (extra && extra.tune) || {};
    const opts = {
      vertexColors: true,
      dust: 0.12,
      wet: 0.45,
      grime: 0.85,
      /*
       * Crevice dirt doubles as the AO tint — see bakeVertexAO().
       *
       * Round two raised every authored albedo by ~1.75x and the rendered soldier
       * moved 71.8 -> 78.2 against a background that moved further, i.e. almost not
       * at all. The reason is here rather than in the palette: the grime mask runs
       * 0.3-1.0 over the whole kit and multiplies albedo *towards this colour*, so
       * whatever the tint says, most of the model is rendering some blend of
       * 0x6a6055 (linear 0.14). Raising the tint the mask blends to is a far more
       * direct lever on the shaded value than raising the tint it blends from, and
       * it keeps the mask — so seams still darken, they just darken to a value the
       * eye can still see into.
       */
      grimeColor: 0x8c8377,
      // Let occlusion bite into direct light too, or every pouch reads as a decal.
      aoDirect: 0.40,
      ...(extra || {}),
    };
    delete opts.tune;
    let m = null;
    try {
      if (lib?.clone) {
        m = lib.clone(name, {
          ...opts,
          color: tint ?? 0x6a6a5a,
          sheenColor: tune.sheenColor ?? 0x22241c,
        });
      }
    } catch (err) {
      warn(`material ${name} unavailable`, err);
      m = null;
    }
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: tint ?? 0x6a6a5a, roughness: 0.9, metalness: 0.03, vertexColors: true,
      });
    }
    owned.materials.push(m);
    // Re-tune. Guarded by `!== undefined` so the Standard/Physical split does not
    // matter and a fallback material survives the same code path.
    if (m.sheen !== undefined) m.sheen = tune.sheen ?? 0.3;
    if (m.specularIntensity !== undefined) m.specularIntensity = tune.spec ?? 0.3;
    m.envMapIntensity = tune.env ?? 0.55;
    // 1.35 was compounding with the grime mask above; both were darkening the
    // same crevices and the sum was a figure that read as a hole in the frame.
    m.aoMapIntensity = tune.aoInt ?? 1.12;
    if (tune.rough !== undefined) m.roughness = tune.rough;
    if (tune.metal !== undefined) m.metalness = tune.metal;
    m.needsUpdate = true;
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

      /*
       * Trouser leg, hip to boot blousing.
       *
       * The old profile went .132 → .092 at the knee → .094 → .082 → .090 with almost
       * no shaping in between, which is a pipe with a nick in it: reviewed at 7x it
       * read as "untapered tubes with a hard pinch at the knee". A leg is not a taper,
       * it is four masses — glute, quadriceps, knee, calf — and the calf is the widest
       * thing below the hip. Twelve rings instead of nine, the knee is now the
       * *narrowest* point of a smooth waist rather than a step, and the calf swells
       * back out to 0.112 before it runs down to the boot cuff.
       */
      add(tubeGeom([
        [X, L.hipY + 0.10 * s, 0.008 * s, 0.152 * s, 0.142 * s],
        [X, L.hipY + 0.01 * s, 0.006 * s, 0.145 * s, 0.136 * s],
        [X, L.hipY - 0.13 * s, 0.004 * s, 0.131 * s, 0.126 * s],
        [X, L.hipY - 0.28 * s, 0.002 * s, 0.117 * s, 0.114 * s],
        [X, L.kneeY + 0.10 * s, 0, 0.105 * s, 0.103 * s],
        [X, L.kneeY + 0.02 * s, 0.004 * s, 0.101 * s, 0.101 * s],
        [X, L.kneeY - 0.05 * s, 0.003 * s, 0.105 * s, 0.107 * s],
        [X, L.kneeY - 0.14 * s, 0.001 * s, 0.113 * s, 0.116 * s],
        [X, L.kneeY - 0.24 * s, -0.001 * s, 0.104 * s, 0.107 * s],
        [X, L.ankleY + 0.22 * s, -0.004 * s, 0.086 * s, 0.089 * s],
        [X, L.ankleY + 0.13 * s, -0.004 * s, 0.095 * s, 0.097 * s],
        [X, L.ankleY + 0.09 * s, -0.004 * s, 0.080 * s, 0.082 * s],
      ], RAD(12), true, true), 'uniform', [thighB, shinB, 'pelvis', footB], 0.4);

      // Cargo pocket, outboard, with a flap. In the LIGHT panel value: a thigh is a
      // big surface high in the silhouette, and this is where half the value read of
      // the whole figure at 40 m now lives.
      box('panel', [thighB], 0.5, 0.066 * s, 0.19 * s, 0.125 * s, 0.032 * s,
        X + side * 0.132 * s, L.hipY - 0.20 * s, 0.012 * s, 0, 0, side * 0.08);
      box('webbing', [thighB], 0.6, 0.058 * s, 0.045 * s, 0.13 * s, 0.018 * s,
        X + side * 0.135 * s, L.hipY - 0.117 * s, 0.012 * s, 0, 0, side * 0.08);

      // Knee pad — three raised ribs so it is not a flat slab.
      box('panel', [shinB, thighB], 0.75, 0.136 * s, 0.16 * s, 0.074 * s, 0.026 * s,
        X, L.kneeY + 0.012 * s, 0.09 * s, -0.05, 0, 0);
      for (let k = -1; k <= 1; k++) {
        box('webbing', [shinB, thighB], 0.8, 0.112 * s, 0.024 * s, 0.022 * s, 0.008 * s,
          X, L.kneeY + 0.012 * s + k * 0.045 * s, 0.124 * s, -0.05, 0, 0, 1);
      }

      /*
       * Boot.
       *
       * Three chamfered boxes stacked under a cylinder is exactly what "boots that
       * read as bolted on" describes — a shoe is one continuous mass from heel to toe
       * and it is *wider at the ball than at the heel*, which no axis-aligned box
       * gives you. It is now a single tube running along +Z through five stations —
       * heel, ankle, instep, ball, toe — with elliptical sections, so the upper
       * flows into the cuff instead of meeting it at a seam. The sole is the only
       * separate piece, because a sole genuinely is one.
       */
      add(tubeGeom([
        [X, L.ankleY + 0.155 * s, -0.008 * s, 0.072 * s, 0.078 * s],
        [X, L.ankleY + 0.075 * s, -0.006 * s, 0.066 * s, 0.074 * s],
        [X, L.ankleY + 0.018 * s, -0.002 * s, 0.062 * s, 0.070 * s],
      ], RAD(10), true, false), 'boot', [footB, shinB], 0.85);
      add(tubeGeom([
        /* heel → toe, running along +Z. rx is half-width, rz is half-height. */
        [X, L.ankleY + 0.010 * s, -0.072 * s, 0.048 * s, 0.036 * s],
        [X, L.ankleY - 0.004 * s, -0.040 * s, 0.056 * s, 0.050 * s],
        [X, L.ankleY - 0.010 * s, 0.020 * s, 0.055 * s, 0.052 * s],
        [X, L.ankleY - 0.014 * s, 0.088 * s, 0.058 * s, 0.048 * s],
        [X, L.ankleY - 0.016 * s, 0.140 * s, 0.052 * s, 0.040 * s],
        [X, L.ankleY - 0.014 * s, 0.172 * s, 0.032 * s, 0.026 * s],
      ], RAD(10), true, true), 'boot', [footB], 0.9);
      // Lugged sole: a thin slab that projects past the upper all the way round.
      box('boot', [footB], 1.0, 0.062 * s, 0.016 * s, 0.128 * s, 0.010 * s,
        X, L.ankleY - 0.056 * s, 0.048 * s, 0, 0, 0, 1);
      // Lace panel — pale, so the instep is not one dark lump.
      for (let k = 0; k < 3; k++) {
        box('panel', [footB, shinB], 0.7, 0.05 * s, 0.012 * s, 0.014 * s, 0.005 * s,
          X, L.ankleY + 0.036 * s + k * 0.038 * s, 0.056 * s - k * 0.006 * s, 0, 0, 0, 1);
      }
    }

    /*
     * Drop-leg holster, right thigh.
     *
     * The old one was a 75 mm slab centred 125 mm out from the leg axis, so its inner
     * half sat *inside* a 120 mm trouser tube and only 40 mm stood proud — which from
     * the front is a hard-edged rectangle half-swallowed by the thigh, i.e. exactly
     * the "rectangular notch bitten out of the silhouette" the review picked up at 7x.
     * A real drop-leg rig hangs clear of the leg on a hanger strap and is held on by a
     * band round the thigh, so that is what this is now: a tapered holster body wholly
     * outside the leg, a wrap strap that visibly ties it on, and the hanger up to the
     * belt. Nothing intersects anything.
     */
    {
      const hx = L.hipX + 0.155 * s;
      const hy = L.hipY - 0.245 * s;
      /* hanger strap from the belt down the outside of the hip */
      add(tubeGeom([
        [L.hipX + 0.13 * s, L.hipY + 0.045 * s, -0.01 * s, 0.022 * s, 0.008 * s],
        [hx, L.hipY - 0.09 * s, -0.008 * s, 0.024 * s, 0.008 * s],
        [hx, hy + 0.07 * s, -0.006 * s, 0.024 * s, 0.008 * s],
      ], 6, true, true), 'webbing', ['thighR', 'pelvis'], 0.62);
      /* the holster body: tapered, muzzle-down, hanging clear of the trouser */
      add(tubeGeom([
        [hx, hy + 0.078 * s, 0.004 * s, 0.048 * s, 0.056 * s],
        [hx, hy + 0.02 * s, 0.002 * s, 0.046 * s, 0.052 * s],
        [hx, hy - 0.05 * s, 0, 0.034 * s, 0.04 * s],
        [hx, hy - 0.078 * s, 0, 0.026 * s, 0.03 * s],
      ], RAD(9), true, true), 'webbing', ['thighR'], 0.6);
      /* retention hood over the top, and the pistol grip proud of it */
      box('webbing', ['thighR'], 0.5, 0.052 * s, 0.03 * s, 0.06 * s, 0.012 * s,
        hx, hy + 0.09 * s, 0.004 * s, 0, 0, 0, 1);
      box('boot', ['thighR'], 0.45, 0.03 * s, 0.062 * s, 0.042 * s, 0.014 * s,
        hx, hy + 0.125 * s, -0.012 * s, -0.28, 0, 0.06, 1);
      /* thigh band: a strap that actually wraps the leg, so the rig is attached */
      add(tubeGeom([
        [L.hipX, hy - 0.03 * s, 0, 0.098 * s, 0.1 * s],
        [L.hipX, hy + 0.012 * s, 0, 0.1 * s, 0.102 * s],
      ], RAD(10), false, false), 'webbing', ['thighR'], 0.72);
    }

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

    /* ── plate carrier ──────────────────────────────────────────────────────
     * Everything here used to sit *inside* the torso silhouette: the plate bag was
     * 0.30 wide against a 0.39-wide chest and the yokes ran at x = 0.10 against a
     * 0.196 half-width, so from the front not one piece of it broke the outline and
     * the whole rig read as a tapered tube. A carrier is the widest thing on a
     * soldier's body — it is armour worn *over* him — so it is now wider than the
     * ribs, the cummerbund steps proud of them, and the yokes cross the top of the
     * deltoid where they interrupt the shoulder line.
     */
    const pcY = L.chestY + 0.10 * s;
    box('webbing', ['chest', 'spine'], 0.45, 0.425 * s, 0.375 * s, 0.105 * s, 0.030 * s,
      0, pcY, 0.132 * s, -0.04, 0, 0, SEG + 1);
    box('webbing', ['chest', 'spine'], 0.5, 0.435 * s, 0.395 * s, 0.10 * s, 0.030 * s,
      0, pcY, -0.130 * s, 0.03, 0, 0, SEG + 1);
    // Cummerbund wrapping the ribs — a hard step outboard of the torso tube.
    add(tubeGeom([
      [0, L.chestY - 0.045 * s, 0.002 * s, 0.212 * s, 0.150 * s],
      [0, L.chestY + 0.060 * s, 0.004 * s, 0.218 * s, 0.156 * s],
    ], RAD(14), false, false), 'webbing', ['spine', 'chest'], 0.6);
    // Side plate pockets: the corners of the cummerbund, squared off.
    for (const side of [-1, 1]) {
      box('webbing', ['chest', 'spine'], 0.62, 0.05 * s, 0.20 * s, 0.20 * s, 0.024 * s,
        side * 0.208 * s, L.chestY + 0.015 * s, 0.005 * s, 0, 0, side * 0.05);
    }

    /*
     * Shoulder yokes, front-over-back, riding over the deltoid — and in the LIGHT
     * panel value. This is the top edge of the torso silhouette, the part of a
     * standing man that catches the sky, and the highest-value surface on the model
     * that is more than a few pixels wide at 40 m. Fatter than before for the same
     * reason: at RAD(8) and 48 mm it was a piped seam.
     */
    for (const side of [-1, 1]) {
      add(tubeGeom([
        [side * 0.108 * s, pcY + 0.155 * s, 0.122 * s, 0.058 * s, 0.034 * s],
        [side * 0.144 * s, L.shoulderY + 0.086 * s, 0.055 * s, 0.066 * s, 0.040 * s],
        [side * 0.154 * s, L.shoulderY + 0.108 * s, -0.018 * s, 0.066 * s, 0.040 * s],
        [side * 0.120 * s, pcY + 0.155 * s, -0.116 * s, 0.058 * s, 0.034 * s],
      ], RAD(9), true, true), 'panel', ['chest'], 0.5);
    }

    // MOLLE rows front and back.
    for (let r = 0; r < 3; r++) {
      box('webbing', ['chest'], 0.7, 0.30 * s, 0.016 * s, 0.014 * s, 0.005 * s,
        0, pcY - 0.11 * s + r * 0.080 * s, 0.187 * s, -0.04, 0, 0, 1);
    }
    for (let r = 0; r < 2; r++) {
      box('webbing', ['chest'], 0.75, 0.32 * s, 0.016 * s, 0.014 * s, 0.005 * s,
        0, pcY - 0.06 * s + r * 0.085 * s, -0.182 * s, 0.03, 0, 0, 1);
    }

    // Three rifle-mag pouches, admin pouch, radio.
    for (let m = -1; m <= 1; m++) {
      box('webbing', ['chest'], 0.6, 0.098 * s, 0.170 * s, 0.066 * s, 0.020 * s,
        m * 0.118 * s, pcY - 0.082 * s, 0.205 * s, -0.05, m * 0.10, 0);
      box('webbing', ['chest'], 0.65, 0.094 * s, 0.042 * s, 0.058 * s, 0.014 * s,
        m * 0.118 * s, pcY + 0.014 * s, 0.207 * s, -0.05, m * 0.10, 0, 1);
    }
    box('webbing', ['chest'], 0.55, 0.15 * s, 0.11 * s, 0.05 * s, 0.018 * s,
      -0.088 * s, pcY + 0.125 * s, 0.190 * s, -0.06, 0.1, 0);
    box('webbing', ['chest'], 0.6, 0.10 * s, 0.165 * s, 0.07 * s, 0.022 * s,
      0.115 * s, pcY + 0.02 * s, -0.185 * s, 0.03, -0.1, 0);
    // Antenna stub.
    add(placed(tubeGeom([
      [0, 0, 0, 0.007 * s, 0.007 * s],
      [0, 0.20 * s, -0.03 * s, 0.005 * s, 0.005 * s],
    ], 5, true, true), 0.145 * s, pcY + 0.10 * s, -0.19 * s), 'metal', ['chest'], 0.4);
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

      /*
       * Sleeve: deltoid, bicep, a *soft* elbow, a fat forearm belly and a wrist.
       * Same fault as the leg — the old profile stepped 0.066 → 0.070 → 0.063 across
       * the elbow, which is a kink, not a joint. The elbow is now the waist between
       * two masses and the forearm is widest just below it, which is where a
       * forearm is actually widest.
       */
      add(tubeGeom([
        [sx, L.shoulderY + 0.082 * s, 0, 0.074 * s, 0.074 * s],
        [sx, L.shoulderY + 0.02 * s, 0, 0.088 * s, 0.086 * s],
        [sx + side * 0.004 * s, L.shoulderY - 0.055 * s, 0, 0.082 * s, 0.080 * s],
        [sx + side * 0.006 * s, L.shoulderY - 0.115 * s, 0, 0.073 * s, 0.072 * s],
        [ex, L.elbowY + 0.05 * s, 0, 0.066 * s, 0.066 * s],
        [ex, L.elbowY, 0.002 * s, 0.064 * s, 0.065 * s],
        [ex, L.elbowY - 0.055 * s, 0.001 * s, 0.070 * s, 0.070 * s],
        [wx, L.wristY + 0.13 * s, 0, 0.064 * s, 0.064 * s],
        [wx, L.wristY + 0.06 * s, 0, 0.053 * s, 0.053 * s],
        [wx, L.wristY + 0.022 * s, 0, 0.048 * s, 0.049 * s],
        [wx, L.wristY + 0.008 * s, 0, 0.051 * s, 0.052 * s],
      ], RAD(10), true, true), 'uniform', [uB, lB, 'chest', hB], 0.35);

      // Elbow pad.
      box('webbing', [lB, uB], 0.8, 0.082 * s, 0.11 * s, 0.05 * s, 0.022 * s,
        ex, L.elbowY - 0.005 * s, -0.058 * s, 0.06, 0, 0);
      /**
       * Brassard. A band right round the deltoid in the accent colour, plus a small
       * flash on top of it — the one saturated mark on the whole soldier, and at
       * 25 m the thing that says "unit" rather than "shape". A flat patch pressed
       * into the sleeve reads as a decal; a band that wraps reads as worn.
       */
      add(tubeGeom([
        [sx, L.shoulderY - 0.012 * s, 0, 0.083 * s, 0.081 * s],
        [sx + side * 0.002 * s, L.shoulderY - 0.062 * s, 0, 0.079 * s, 0.077 * s],
      ], RAD(9), false, false), 'scarf', [uB], 0.5);
      box('webbing', [uB], 0.45, 0.02 * s, 0.05 * s, 0.062 * s, 0.008 * s,
        sx + side * 0.082 * s, L.shoulderY - 0.036 * s, 0.004 * s, 0, 0, 0, 1);

      // Glove: palm block, thumb, knuckle plate.
      box('boot', [hB, lB], 0.7, 0.058 * s, 0.12 * s, 0.095 * s, 0.026 * s,
        wx, L.wristY - 0.058 * s, 0.004 * s);
      box('boot', [hB], 0.7, 0.032 * s, 0.058 * s, 0.036 * s, 0.014 * s,
        wx - side * 0.032 * s, L.wristY - 0.04 * s, 0.038 * s, 0.2, 0, side * 0.35, 1);
      box('webbing', [hB], 0.75, 0.054 * s, 0.032 * s, 0.054 * s, 0.01 * s,
        wx, L.wristY - 0.105 * s, 0.012 * s, 0, 0, 0, 1);
    }

    /* ── neck & head ──────────────────────────────────────────────────────
     * The neck was there, but it was 56 mm of skin between a 108 mm collar and a
     * 64 mm balaclava, so at any distance the head read as sitting straight on the
     * shoulders. It is now longer and thinner, and the shemagh below it does the
     * separating: a light cloth roll at the collar with a tail over one shoulder,
     * which is both the value break the soldier was missing and the reason the head
     * has somewhere to sit.
     */
    add(tubeGeom([
      [0, L.neckY - 0.085 * s, -0.006 * s, 0.058 * s, 0.054 * s],
      [0, L.neckY - 0.02 * s, -0.002 * s, 0.049 * s, 0.047 * s],
      [0, L.neckY + 0.03 * s, 0, 0.048 * s, 0.046 * s],
      [0, L.neckY + 0.062 * s, 0.004 * s, 0.056 * s, 0.054 * s],
    ], RAD(9), true, false), 'skin', ['head', 'chest'], 0.25);

    /* shemagh: a rolled collar, thicker at the front, with a tail down one shoulder */
    add(tubeGeom([
      [0, L.neckY - 0.105 * s, -0.004 * s, 0.082 * s, 0.076 * s],
      [0, L.neckY - 0.062 * s, 0.006 * s, 0.088 * s, 0.082 * s],
      [0, L.neckY - 0.022 * s, 0.004 * s, 0.076 * s, 0.072 * s],
    ], RAD(10), true, true), 'scarf', ['head', 'chest'], 0.42);
    /* the tail, thrown back over the left shoulder */
    add(tubeGeom([
      [-0.04 * s, L.neckY - 0.09 * s, -0.05 * s, 0.05 * s, 0.03 * s],
      [-0.1 * s, L.neckY - 0.16 * s, -0.1 * s, 0.062 * s, 0.026 * s],
      [-0.14 * s, L.neckY - 0.27 * s, -0.13 * s, 0.055 * s, 0.02 * s],
      [-0.13 * s, L.neckY - 0.34 * s, -0.12 * s, 0.036 * s, 0.014 * s],
    ], RAD(7), true, true), 'scarf', ['chest', 'head'], 0.5);

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

    /* ── helmet ─────────────────────────────────────────────────────────────
     * Sized against the skull it covers, not fitted to it. The old shell was 0.104
     * against a 0.092 skull — 12 mm proud, which at 25 m and 720p is half a pixel,
     * so the head rendered as a bare skull and the single strongest silhouette cue a
     * soldier has was thrown away. A real ballistic shell over pads and a cover is
     * ~135 mm half-width over a ~92 mm skull, and that reads as a helmet at 40 m.
     * It also gets its own material slot so the shell can be the dark end of the
     * value ladder instead of matching the pouches.
     */
    add(tubeGeom([
      [0, hy + 0.112 * s, -0.006 * s, 0.126 * s, 0.136 * s],
      [0, hy + 0.142 * s, -0.006 * s, 0.135 * s, 0.146 * s],
      [0, hy + 0.186 * s, -0.008 * s, 0.132 * s, 0.142 * s],
      [0, hy + 0.224 * s, -0.011 * s, 0.118 * s, 0.127 * s],
      [0, hy + 0.256 * s, -0.014 * s, 0.094 * s, 0.101 * s],
      [0, hy + 0.282 * s, -0.016 * s, 0.060 * s, 0.065 * s],
      [0, hy + 0.298 * s, -0.018 * s, 0.026 * s, 0.028 * s],
      [0, hy + 0.304 * s, -0.019 * s, 0.006 * s, 0.007 * s],
    ], RAD(14), true, true), 'helmet', ['head'], 0.52);

    // Brim lip: the flare under the shell, and the widest point of the head.
    add(tubeGeom([
      [0, hy + 0.104 * s, -0.006 * s, 0.130 * s, 0.140 * s],
      [0, hy + 0.124 * s, -0.006 * s, 0.140 * s, 0.150 * s],
    ], RAD(14), false, false), 'helmet', ['head'], 0.68);

    /*
     * Helmet cover band, in the light panel value. A real cover is scrim held on by
     * a band round the crown, and it is the one place on a soldier where a light
     * value sits directly against the sky: the head is what the eye finds first at
     * range and it was previously the darkest thing on the model. Two rings, and it
     * is worth more to the read at 40 m than every pouch on the carrier.
     */
    add(tubeGeom([
      [0, hy + 0.150 * s, -0.007 * s, 0.138 * s, 0.148 * s],
      [0, hy + 0.196 * s, -0.009 * s, 0.135 * s, 0.145 * s],
    ], RAD(14), false, false), 'panel', ['head'], 0.5);
    /* and a light strip over the crown, so the top of the head is not one dark dome */
    add(tubeGeom([
      [0, hy + 0.238 * s, -0.013 * s, 0.106 * s, 0.113 * s],
      [0, hy + 0.266 * s, -0.015 * s, 0.086 * s, 0.092 * s],
    ], RAD(12), false, false), 'panel', ['head'], 0.55);

    // Goggles pushed up onto the shell, proud of it so they cast their own shadow.
    add(tubeGeom([
      [0, hy + 0.152 * s, 0.002 * s, 0.144 * s, 0.153 * s],
      [0, hy + 0.184 * s, 0.000 * s, 0.145 * s, 0.154 * s],
    ], RAD(11), false, false), 'boot', ['head'], 0.4);
    box('boot', ['head'], 0.3, 0.175 * s, 0.056 * s, 0.044 * s, 0.016 * s,
      0, hy + 0.168 * s, 0.112 * s, 0.12, 0, 0);
    box('metal', ['head'], 0.3, 0.188 * s, 0.013 * s, 0.018 * s, 0.005 * s,
      0, hy + 0.194 * s, 0.110 * s, 0.12, 0, 0, 1);

    // NVG shroud + folded mount arm, front and centre on the crown.
    box('metal', ['head'], 0.45, 0.068 * s, 0.048 * s, 0.040 * s, 0.008 * s,
      0, hy + 0.238 * s, 0.104 * s, 0.35, 0, 0, 1);
    add(placed(tubeGeom([
      [0, 0, 0, 0.016 * s, 0.016 * s],
      [0, 0.048 * s, 0.024 * s, 0.012 * s, 0.012 * s],
    ], 6, true, true), 0, hy + 0.254 * s, 0.106 * s, -0.7, 0, 0), 'metal', ['head'], 0.4);
    // Side rails + rear counterweight pouch.
    for (const side of [-1, 1]) {
      box('metal', ['head'], 0.5, 0.016 * s, 0.032 * s, 0.145 * s, 0.005 * s,
        side * 0.142 * s, hy + 0.186 * s, 0.010 * s, 0, side * 0.12, 0, 1);
    }
    box('helmet', ['head'], 0.6, 0.115 * s, 0.078 * s, 0.060 * s, 0.022 * s,
      0, hy + 0.226 * s, -0.128 * s, -0.18, 0, 0, 1);

    // Four-point chin strap + chin cup.
    for (const side of [-1, 1]) {
      for (const zf of [0.052, -0.048]) {
        add(tubeGeom([
          [side * 0.118 * s, hy + 0.112 * s, zf * s, 0.008 * s, 0.005 * s],
          [side * 0.086 * s, hy + 0.070 * s, zf * s * 0.95, 0.008 * s, 0.005 * s],
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
    const mesh = new THREE.Mesh(merged, material('painted_steel_chipped', 0x2b2d31, {
      repeat: 0.35,
      detail: 0.6,
      tune: { spec: 0.45, env: 0.85, rough: 0.6, metal: 0.55 },
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
  /*
   * `tune` is the per-slot dial-back described on material(). The helmet is its own
   * slot rather than sharing `webbing`: the value ladder the palette authors only
   * exists if the shell can actually be a different value from the pouches, and a
   * head-sized dark mass on top of the shoulders is most of what makes a soldier
   * read as a soldier at 40 m.
   */
  const SLOT_MATERIAL = {
    uniform: {
      // sheen*sheenColor lands at ~0.005 against the library's 0.174: the lobe is
      // still there as a hint of cloth, it just no longer outruns the albedo.
      name: 'fabric_uniform', repeat: 0.5, detail: 0.5, key: 'uniform',
      tune: { sheen: 0.28, sheenColor: 0x26281e, spec: 0.24, env: 1.0, rough: 1.0 },
    },
    webbing: {
      name: 'fabric_webbing', repeat: 0.45, detail: 0.5, key: 'webbing',
      tune: { sheen: 0.22, sheenColor: 0x1d1f18, spec: 0.22, env: 0.95, rough: 0.97 },
    },
    helmet: {
      name: 'fabric_webbing', repeat: 0.4, detail: 0.45, key: 'helmet',
      tune: { sheen: 0.2, sheenColor: 0x191b14, spec: 0.28, env: 0.9, rough: 0.9 },
    },
    /**
     * The light end of the ladder, and the whole point of this round: shoulder yokes,
     * thigh cargo panels, knee pads and the helmet cover band. Same cloth recipe as
     * the uniform so it reads as sun-bleached kit rather than as a different garment,
     * one value step up, and — critically — on surfaces that are still several pixels
     * across when the soldier is 40 px tall.
     */
    panel: {
      name: 'fabric_uniform', repeat: 0.45, detail: 0.5, key: 'panel',
      tune: { sheen: 0.26, sheenColor: 0x2b2d22, spec: 0.24, env: 1.0, rough: 1.0 },
    },
    boot: {
      name: 'rubber_tyre', repeat: 0.5, detail: 0.5, key: 'boot',
      tune: { spec: 0.3, env: 0.85, rough: 0.95 },
    },
    metal: {
      // Untinted this comes back as white chrome (recipe colour 0xffffff, metalness 1)
      // and the NVG shroud, rails and buckle turn into mirrors on the helmet.
      name: 'painted_steel_chipped', repeat: 0.5, detail: 0.5, key: 'metalKit',
      tune: { spec: 0.4, env: 0.9, rough: 0.66, metal: 0.55 },
    },
    skin: {
      name: 'skin_head', repeat: 0.12, detail: 0.35, key: 'skin',
      tune: { sheen: 0, spec: 0.4, env: 1.0 },
    },
    /**
     * Shemagh, brassard and shoulder tab. The one light, saturated thing on the
     * model — a full stop and a half above the uniform and a different hue — so the
     * silhouette has an internal read at 40 m instead of one flat mass. Costs one
     * extra draw call per soldier and is worth every one of them.
     */
    scarf: {
      name: 'fabric_canvas', repeat: 0.4, detail: 0.55, key: 'scarf',
      tune: { sheen: 0.34, sheenColor: 0x6b6455, spec: 0.26, env: 0.85, rough: 0.95 },
    },
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
      tune: def.tune,
    });
    m.name = `ai:${slot}:${variant.id}`;
    matCache.set(key, m);
    return m;
  }

  /* ── baked per-part occlusion ──────────────────────────────────────────── */

  /**
   * The kit is a stack of separate shells: pouches on a plate bag, the bag on a
   * chest, a helmet over a skull, a knee pad on a trouser leg. *Nothing* in the
   * material pipeline knows about that arrangement — the ORM map only describes the
   * weave of the cloth — so every junction renders as a flat plane and the gear
   * dissolves into the body exactly the way an un-occluded weapon viewmodel does.
   *
   * So bake it. Rasterise the assembled model into a 19 mm occupancy grid, then for
   * every vertex sample a cosine-distributed hemisphere around its normal and count
   * how much of it is walled off. The result rides in the vertex-colour *red* channel
   * — the mask the material shader already reads as grime, which darkens albedo and
   * lifts roughness. Dirt collects where light does not reach, so the same channel
   * doing both jobs is not a hack, it is how the two actually correlate.
   *
   * Runs once per cached (variant, height, quality) model; ~40 ms for a soldier.
   */
  const AO_CELL = 0.019;
  const AO_RADIUS = 0.088;
  const AO_BIAS = 0.024;

  /** Cosine-weighted hemisphere directions, +Y along the surface normal. */
  const AO_DIRS = (() => {
    const out = [];
    const N = 14;
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N;
      const y = Math.sqrt(1 - t);
      const r = Math.sqrt(t);
      const phi = i * 2.399963229728653;
      out.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
    }
    return out;
  })();
  const AO_RADII = [0.34, 0.66, 1.0];
  const AO_WEIGHTS = [1.35, 1.0, 0.62];

  /**
   * Which limb group a part belongs to. Geometry is authored in the bind pose, where
   * the arms hang *inside* the silhouette of the ribs — so an unrestricted bake
   * paints a dark stripe down the outside of the torso and the inside of both
   * sleeves, and that stripe is still there when the arms come up onto the weapon.
   * Occlusion therefore only accumulates within a group: the torso does not shadow
   * an arm, and an arm does not shadow the torso. Everything that does not move
   * relative to the trunk stays in group 0, where cross-occlusion is what we want.
   */
  function limbGroup(bones) {
    for (const b of bones) {
      if (b === 'upperArmL' || b === 'lowerArmL' || b === 'handL') return 1;
      if (b === 'upperArmR' || b === 'lowerArmR' || b === 'handR') return 2;
    }
    return 0;
  }

  function buildOccupancy(parts) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) {
      const pa = p.geometry.attributes.position.array;
      const n = p.geometry.attributes.position.count * 3;
      for (let i = 0; i < n; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = pa[i + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
    }
    if (!Number.isFinite(min[0])) return null;
    const pad = AO_RADIUS + AO_CELL * 2;
    const dim = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      min[k] -= pad;
      max[k] += pad;
      dim[k] = Math.max(1, Math.ceil((max[k] - min[k]) / AO_CELL));
    }
    // One bit per limb group, so a sample can ask "is anything from *my* group here".
    const grid = new Uint8Array(dim[0] * dim[1] * dim[2]);
    const inv = 1 / AO_CELL;
    let bit = 1;
    const mark = (x, y, z) => {
      const ix = ((x - min[0]) * inv) | 0;
      const iy = ((y - min[1]) * inv) | 0;
      const iz = ((z - min[2]) * inv) | 0;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= dim[0] || iy >= dim[1] || iz >= dim[2]) return;
      grid[(iz * dim[1] + iy) * dim[0] + ix] |= bit;
    };
    for (const p of parts) {
      const pos = p.geometry.attributes.position.array;
      const idx = p.geometry.index?.array;
      if (!idx) continue;
      bit = 1 << limbGroup(p.bones);
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3;
        const b = idx[t + 1] * 3;
        const c = idx[t + 2] * 3;
        const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
        const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
        const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
        const e = Math.max(
          Math.hypot(bx - ax, by - ay, bz - az),
          Math.hypot(cx - bx, cy - by, cz - bz),
          Math.hypot(ax - cx, ay - cy, az - cz)
        );
        const steps = clamp(Math.ceil(e / (AO_CELL * 0.72)), 1, 10);
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; j <= steps - i; j++) {
            const u = i / steps;
            const v = j / steps;
            const w = 1 - u - v;
            mark(ax * w + bx * u + cx * v, ay * w + by * u + cy * v, az * w + bz * u + cz * v);
          }
        }
      }
    }
    return { grid, min, dim, inv };
  }

  function bakeVertexAO(parts) {
    const occ = buildOccupancy(parts);
    if (!occ) return;
    const { grid, min, dim, inv } = occ;
    let wantBit = 1;
    const solid = (x, y, z) => {
      const ix = ((x - min[0]) * inv) | 0;
      const iy = ((y - min[1]) * inv) | 0;
      const iz = ((z - min[2]) * inv) | 0;
      if (ix < 0 || iy < 0 || iz < 0 || ix >= dim[0] || iy >= dim[1] || iz >= dim[2]) return 0;
      return grid[(iz * dim[1] + iy) * dim[0] + ix] & wantBit;
    };
    let wTotal = 0;
    for (const w of AO_WEIGHTS) wTotal += w * AO_DIRS.length;

    const tX = new THREE.Vector3();
    const tZ = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    for (const p of parts) {
      const pos = p.geometry.attributes.position;
      const nor = p.geometry.attributes.normal;
      const n = pos.count;
      const ao = new Float32Array(n);
      wantBit = 1 << limbGroup(p.bones);
      for (let i = 0; i < n; i++) {
        nrm.set(nor.getX(i), nor.getY(i), nor.getZ(i));
        if (nrm.lengthSq() < 1e-8) nrm.set(0, 1, 0);
        else nrm.normalize();
        // Any tangent will do — the sample set is rotationally symmetric enough.
        if (Math.abs(nrm.y) < 0.9) tX.set(0, 1, 0);
        else tX.set(1, 0, 0);
        tZ.crossVectors(nrm, tX).normalize();
        tX.crossVectors(tZ, nrm).normalize();
        const ox = pos.getX(i) + nrm.x * AO_BIAS;
        const oy = pos.getY(i) + nrm.y * AO_BIAS;
        const oz = pos.getZ(i) + nrm.z * AO_BIAS;
        let hit = 0;
        for (let d = 0; d < AO_DIRS.length; d++) {
          const dd = AO_DIRS[d];
          const wx = tX.x * dd[0] + nrm.x * dd[1] + tZ.x * dd[2];
          const wy = tX.y * dd[0] + nrm.y * dd[1] + tZ.y * dd[2];
          const wz = tX.z * dd[0] + nrm.z * dd[1] + tZ.z * dd[2];
          for (let r = 0; r < AO_RADII.length; r++) {
            const rad = AO_RADII[r] * AO_RADIUS;
            if (solid(ox + wx * rad, oy + wy * rad, oz + wz * rad)) hit += AO_WEIGHTS[r];
          }
        }
        ao[i] = clamp(1 - (hit / wTotal) * 1.3, 0, 1);
      }
      p.ao = ao;
    }
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
      // Grime mask: dirt climbs from the ground and settles in the low kit — plus
      // the baked cavity term, squared so only genuinely buried geometry goes dark
      // and a flat sleeve stays the value the palette asked for.
      const height = clamp(y / 1.85, 0, 1);
      const g = clamp(grimeBase * (1.25 - height * 0.85) + (1 - height) * 0.22, 0, 1);
      const cav = part.ao ? 1 - part.ao[i] : 0;
      col[i * 3] = clamp(g + cav * cav * cav * 0.7, 0, 1);
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
    try {
      bakeVertexAO(parts);
    } catch (err) {
      warn('vertex AO bake failed', err);
    }
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
