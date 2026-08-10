/**
 * WeaponSystem — viewmodel ownership and gunplay. Owner: weapons agent.
 * Publishes `ctx.weapons`.
 *
 * Responsibilities
 *   • builds the viewmodel (ViewmodelBuilder) and its attachments (Attachments)
 *   • lights the viewmodel scene deliberately — its own key/fill/rim plus the world
 *     IBL, so the gun reads against a bright sky or a dark interior and still belongs
 *     to the scene it is standing in
 *   • drives ProcAnim every frame and keeps the optic's reticle collimated
 *   • owns fire-rate timing, fire modes, ammo, reloads, swaps, melee and inspect
 *   • emits the gunplay events and hands the shot off to ballistics / FX
 *
 * Events emitted
 *   weapon:fire     {weapon, weaponId, def, origin, dir, ads, shot, spread, ammo,
 *                    suppressed}
 *   weapon:reload   {weapon, stage}   stage: start|release|magout|magin|seat|
 *                                            boltrelease|end
 *   weapon:equip    {weapon, weaponId, def, ammo}
 *   weapon:empty    {weapon, dry}
 *   weapon:ammo     {weapon, ammo, reserve, magSize, mode}
 *   weapon:firemode {weapon, mode}
 *   weapon:melee    {weapon, stage|damage}
 *   weapon:inspect  {weapon}
 *
 * On `weapon:fire` and `weapon:equip`, `weapon` is the live **weapon handle**:
 * `{ id, name, def }` with a `toString()` that returns the id, so a consumer can use
 * it as an object (`payload.weapon.def.recoil`) or as a string (`\`${payload.weapon}\``)
 * without knowing which was meant. `weaponId` is always the plain id.
 *
 * Events consumed:  debug:pose, debug:cameraLock, quality:changed, entity:damage
 *
 * ctx.weapons API
 *   current {id,def,ammo,reserve,...} | null      currentId   defs   list()
 *   equip(id,{instant,attachments})   next()      prev()      holster()
 *   ads (bool)  adsProgress (0..1)  aiming  zoom  spread  bloom
 *   firing  reloading  busy  ammo  reserve  magSize  fireMode  fireModes
 *   startFire() stopFire() reload() melee() inspect() cycleFireMode()
 *   setAttachment(slot,id)  attachments  stats
 *   muzzleWorld(v3)  aimDir(v3)  moveSpeedScale  localMuzzleFlash
 *   root  scene  stats()
 */
import * as THREE from 'three';
import { WEAPON_DEFS, WEAPON_IDS, getWeaponDef, damageAt, rpmToInterval, recoilStep, spreadOf } from './WeaponDefs.js';
import { makeWeaponMaterials, buildWeapon, buildArms, makeBrassPool, makeMuzzleFlash, bakeViewmodel } from './ViewmodelBuilder.js';
import { resolveLoadout, applyStats, buildAttachment, ATTACHMENTS, SLOTS } from './Attachments.js';
import { createProcAnim } from './ProcAnim.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

export default function createWeaponSystem(ctx) {
  /* ------------------------------------------------------------------ state */
  let mats = null;
  let anim = null;
  const root = new THREE.Group();
  root.name = 'viewmodelRoot';
  root.matrixAutoUpdate = true;
  const rig = new THREE.Group();
  rig.name = 'viewmodelRig';
  root.add(rig);

  const built = new Map(); // id -> instance
  let cur = null; // active instance
  let curId = null;
  const ammoState = new Map(); // id -> {ammo, reserve, mode}

  const brass = { pool: null, live: [] };
  let flash = null;
  let flashT = 0;
  let flashSeed = 0;

  const lights = {};
  let envApplied = null;
  let baseViewFov = 60;

  /* input / intent */
  let wantFire = false;
  let firePressedEdge = false;
  let wantAds = false;
  let fireTimer = 0;
  let burstLeft = 0;
  let burstGap = 0;
  let semiLatch = false;
  let bloom = 0;
  let poseMode = false;
  let poseState = null;
  let hidden = false;
  const subs = [];

  /* scratch */
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _m2 = new THREE.Matrix4();
  const _axis = new THREE.Vector3();
  const _origin = new THREE.Vector3();
  const _col = new THREE.Color();
  const _clear = new THREE.Color();

  /* picture-in-picture scope */
  const pip = {
    rt: null,
    cam: null,
    enabled: true,
    broken: false,
    registered: false,
    active: false,
  };

  const on = (name, fn) => {
    const off = ctx.bus?.on?.(name, fn);
    if (typeof off === 'function') subs.push(off);
  };

  /* ====================================================================== */
  /*                               construction                             */
  /* ====================================================================== */

  function ensureBuilt(id) {
    if (built.has(id)) return built.get(id);
    const def = getWeaponDef(id);
    if (!def || !mats) return null;
    let inst = null;
    try {
      const w = buildWeapon(ctx, def, mats);
      const arms = buildArms(ctx, mats, def);
      const gun = new THREE.Group();
      gun.name = `gun:${id}`;
      gun.add(w.root);
      gun.add(arms.leftRig);
      gun.add(arms.rightRig);
      // Viewmodel scale. A 1:1 rifle simply does not fit a 60° viewmodel frustum at
      // a believable arm's length; every shooter shrinks the viewmodel a little and
      // pushes it out. The ADS solve reads the sight through this transform, so the
      // sight line stays exact whatever the scale is.
      const vs = def.view?.scale ?? 0.78;
      gun.scale.setScalar(vs);
      // Re-solve cavity occlusion over the gun and the hands together. Built
      // separately they cannot see each other, so the fingers land on the grip with no
      // darkening underneath them and read as floating. This is the contact shadow.
      try {
        bakeViewmodel(gun, { cell: 0.0032, maxDist: 0.03, amount: 1 });
      } catch (err) {
        console.warn('[weapons] cavity bake failed', err);
      }
      gun.visible = false;
      rig.add(gun);

      inst = {
        id,
        def,
        gun,
        weapon: w.root,
        nodes: w.nodes,
        hands: arms,
        attachments: resolveLoadout(def, null),
        fitted: {},
        stats: null,
        tris: w.tris,
        optic: null,
        muzzleTip: null,
        recip: def.class === 'smg',
        boltTravel: def.class === 'dmr' ? 0.062 : def.class === 'smg' ? 0.044 : 0.052,
      };
      built.set(id, inst);
      refitAll(inst);
    } catch (err) {
      console.warn(`[weapons] failed to build ${id}`, err);
      return null;
    }
    return inst;
  }

  function detach(inst, slot) {
    const f = inst.fitted[slot];
    if (!f) return;
    // The reticle lives under the viewmodel root (see fit()), so it has to be pulled
    // out by hand or it outlives the optic it belongs to.
    const ret = f.api?.reticle;
    if (ret?.parent) ret.parent.remove(ret);
    ret?.geometry?.dispose?.();
    if (f.group?.parent) f.group.parent.remove(f.group);
    disposeTree(f.group);
    inst.fitted[slot] = null;
    if (slot === 'optic') inst.optic = null;
    if (slot === 'muzzle') inst.muzzleTip = null;
  }

  function fit(inst, slot) {
    detach(inst, slot);
    const id = inst.attachments[slot];
    const a = buildAttachment(ctx, mats, id, inst.def);
    if (!a) return;
    inst.fitted[slot] = a;
    if (a.group) {
      const mount = inst.nodes[a.mount] || inst.weapon;
      mount.add(a.group);
    }
    if (slot === 'optic') {
      inst.optic = a.api || null;
      if (inst.optic?.reticle) {
        // The reticle is re-parented to the viewmodel root so it can be projected to
        // infinity every frame; it still depth-tests against the optic tube, which is
        // what produces a correct eyebox.
        root.add(inst.optic.reticle);
        inst.optic.reticle.visible = false;
      }
    }
    if (slot === 'muzzle') inst.muzzleTip = a.api?.tip || null;
    if (slot === 'magazine') {
      const k = ATTACHMENTS[id]?.magScale || 1;
      const magNode = inst.nodes.magazine;
      if (magNode) {
        // Scale about the feed lips so a longer magazine grows downward instead of
        // sinking into the magwell.
        const yTop = inst.def.build.mag.yTop;
        magNode.scale.set(1, k, 1);
        magNode.userData.magBase = yTop * (1 - k);
      }
    }
  }

  /**
   * A def with the fitted attachments folded in. This is what goes out on
   * `weapon:fire` and what CameraRig reads for its kick, so a suppressor or a brake
   * changes how the camera behaves and not just the numbers on the HUD.
   */
  function buildEffectiveDef(inst) {
    const st = inst.stats;
    const r = inst.def.recoil;
    const eff = {
      ...inst.def,
      magSize: st.magSize,
      adsTime: st.adsTime,
      zoom: st.zoom,
      adsFovScale: st.zoom > 1.05 ? clamp(1 / st.zoom, 0.14, 0.95) : inst.def.adsFovScale,
      muzzleVelocity: st.muzzleVelocity,
      penetration: st.penetration,
      moveSpeedScale: st.moveSpeedScale,
      suppressed: st.suppressed,
      recoil: {
        ...r,
        // CameraRig supplies the visual punch; the authored pattern (applied as an
        // explicit impulse in shoot()) supplies the climb. Split so they sum sanely.
        vertical: r.vertical * 0.52 * st.recoilV,
        horizontal: r.horizontal * 0.6 * st.recoilH,
        back: r.back * st.recoilV,
      },
    };
    inst.effDef = eff;
    inst.handle = {
      id: inst.id,
      name: inst.def.name,
      def: eff,
      toString() {
        return inst.id;
      },
    };
  }

  function refitAll(inst) {
    for (const slot of SLOTS) fit(inst, slot);
    inst.stats = applyStats(inst.def, inst.attachments);
    buildEffectiveDef(inst);
    const st = ammoState.get(inst.id);
    if (!st) {
      ammoState.set(inst.id, {
        ammo: inst.stats.magSize,
        reserve: inst.def.startReserve ?? inst.stats.magSize * 6,
        mode: 0,
      });
    } else {
      st.ammo = Math.min(st.ammo, inst.stats.magSize);
    }
  }

  function disposeTree(obj) {
    if (!obj) return;
    obj.traverse?.((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        const m = o.material;
        if (m && m.name && m.name.startsWith('weapon:opticGlass')) m.dispose?.();
      }
    });
  }

  /* ====================================================================== */
  /*                                 lighting                               */
  /* ====================================================================== */

  function setupLights() {
    const mk = (color, intensity, dir) => {
      const l = new THREE.DirectionalLight(color, intensity);
      l.position.set(dir[0], dir[1], dir[2]);
      l.castShadow = false;
      const t = new THREE.Object3D();
      t.position.set(0, 0, 0);
      root.add(t);
      l.target = t;
      root.add(l);
      return l;
    };
    /* Camera-relative rig: the gun must read as a solid object against a blown-out sky
     * or a black doorway, and still pick up the world IBL for bounce.
     *
     * Two of the four lights are gone and that is the whole point of this revision.
     *
     * Ablation: render the hero frame with each contribution removed in turn, invert the
     * tone curve and difference the results, and the weapon's top 1 % of pixels comes
     * out as *fill + bounce + rim + IBL*, not key. That is not an accident of these
     * particular intensities, it is what a dielectric does. A coated weapon has F0 =
     * 0.04, so at normal incidence 96 % of what you see is diffuse — but fresnel takes
     * the specular to 1.0 at grazing, so any light arriving side-on or behind puts
     * essentially *all* of its energy into a lobe along the silhouette and none into the
     * shading. A fill from the right, a bounce from below and a rim from behind are
     * three grazing lights, and between them they were most of the "white salt-crust"
     * the review kept measuring: they were paying for the highlight and not for the
     * form.
     *
     * So the two that exist purely to open up the shadow side are now a HemisphereLight.
     * In three's PBR a hemisphere light lands in `irradiance` and therefore only ever
     * reaches `RE_IndirectDiffuse`: it fills the dark side of the receiver with a cool
     * sky above and a warm ground bounce below and contributes **no specular at all**.
     * The key keeps its lobe, because a weapon with no highlight at all is a matte
     * cutout, and the rim survives at a third of its old weight to hold the silhouette
     * against a night street. */
    lights.key = mk(0xfff0dc, 1.7, [-0.62, 0.78, 0.42]);
    lights.rim = mk(0xdfe8f6, 0.24, [0.34, 0.52, -0.86]);
    const hemi = new THREE.HemisphereLight(0x93aecd, 0x6a5e4c, 0.92);
    root.add(hemi);
    lights.fill = hemi;
    lights.bounce = null;
    // Daylight hues, kept so syncEnvironment can lerp away from them and back.
    lights.key.userData.day = new THREE.Color(0xfff0dc);
    lights.rim.userData.day = new THREE.Color(0xdfe8f6);
    hemi.userData.day = new THREE.Color(0x93aecd);
    hemi.userData.dayGround = new THREE.Color(0x6a5e4c);

    // Exactly one of them casts. Without it nothing in the viewmodel scene occludes
    // anything: the hands float clear of the receiver, the optic leaves no mark on the
    // rail, and the magazine reads as painted onto the magwell. It is a ~25k-triangle
    // depth pass into a small map, so it is affordable even on the software rasteriser.
    /* Exactly one of them casts a real shadow, and only outside the capture harness.
     * A shadow-casting light in the viewmodel scene doubles the program variants for
     * every weapon material, and on the SwiftShader rasteriser that is minutes of
     * compile time on the first frame the gun appears — long enough to blow the
     * screenshot timeout. Headless gets the same read from the baked contact
     * occlusion in ensureBuilt(), which costs nothing per frame. */
    const shadowsOn =
      ctx.settings?.get?.('shadows') !== false &&
      ctx.renderer?.shadowMap?.enabled !== false &&
      !ctx.settings?.get?.('headless');
    if (shadowsOn) {
      const res = ctx.settings?.tier === 'low' ? 512 : 1024;
      lights.key.castShadow = true;
      lights.key.shadow.mapSize.set(res, res);
      const c = lights.key.shadow.camera;
      c.left = -0.42;
      c.right = 0.42;
      c.top = 0.42;
      c.bottom = -0.42;
      c.near = 0.05;
      c.far = 3.2;
      c.updateProjectionMatrix();
      lights.key.shadow.bias = -0.00055;
      lights.key.shadow.normalBias = 0.0019;
      // The light sits on a unit vector from the rig origin; push it out so the whole
      // viewmodel is inside the near/far window.
      lights.key.position.multiplyScalar(1.15);
    }
  }

  function syncEnvironment() {
    const scene = ctx.viewScene;
    if (!scene) return;
    const env = ctx.lighting?.envMap ?? ctx.lighting?.envTexture ?? null;
    if (env && env !== envApplied) {
      scene.environment = env;
      envApplied = env;
    }
    // How bright the world is right now, as seen by an up-facing surface.
    let lum = 0.6;
    try {
      const c = ctx.lighting?.ambientIrradiance?.(_v.set(0, 1, 0));
      if (c?.isColor) lum = clamp(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 0.02, 6);
    } catch {
      /* lighting may still be half-built */
    }

    // Clamp the environment's hold on the viewmodel. The viewmodel scene carries the
    // world's full HDR sky, and a gun lit primarily by that sky *is* a mirror of the
    // sky: white at noon, and — worse — a glowing blue-white beacon at night, when it
    // was the brightest object on screen in a black courtyard. The gun is lit by its
    // own rig; the environment is only allowed to contribute reflection and bounce.
    // It scales *down* with the world, not up: a dark scene is exactly where a residual
    // sky reflection becomes the brightest thing on screen. The rim light, which has
    // its own floor below, is what keeps the gun readable at night — not the sky.
    /* Environment weight. Measured alone — every rig light off, IBL on — the sky was
     * putting the weapon's top 1 % at 88/255 against a 42 scene, because a low
     * `envMapIntensity` still multiplies a genuinely HDR sky and grazing fresnel does
     * not care how small the multiplier is. It was buying almost nothing in exchange:
     * with the rig off the same frame's *median* weapon pixel was 6.6. So the sky is
     * now down to a sixth of its old hold and the shadow fill it used to pretend to
     * provide comes from the hemisphere light instead, where it cannot make a highlight. */
    scene.environmentIntensity = clamp(0.13 * Math.sqrt(lum / 0.6), 0.035, 0.17);

    // Key tracks the world, but with a hard floor: a COD viewmodel is always readable
    // because a camera-relative rig lights it, not the room it is standing in.
    const k = clamp(0.5 + Math.sqrt(lum) * 0.75, 0.62, 1.7);
    if (lights.key) lights.key.intensity = 1.7 * k;
    // Hemisphere: pure irradiance, so this can be generous without costing a highlight.
    if (lights.fill) lights.fill.intensity = 0.92 * k;
    /* Rim carries the silhouette; it is deliberately the last thing to fade at night —
     * but its night *floor* was doing real damage. At 1.45 x 0.78 it was still throwing
     * 1.13 of grazing light at a weapon standing in a courtyard whose median pixel is
     * 27, which is why the night frame measured the worst highlight ratio of the four
     * (4.1x scene at p99) despite being the darkest. */
    if (lights.rim) lights.rim.intensity = 0.24 * clamp(k, 0.7, 1.4);
    if (lights.bounce) lights.bounce.intensity = 0.3 * k;

    /* Night warmth.
     *
     * The rig's fill and rim are daylight hues — a blue north-sky fill and a cool
     * blue-white rim — because by day they stand in for skylight. At night the key
     * collapses to its floor and those two become most of what is lighting the gun,
     * so the whole weapon picked up a cold blue cast that belonged to no light source
     * in the scene. What is actually out there after dark is sodium and tungsten
     * practicals and a fire or two, so the rig rolls over to warm as the world darkens.
     * The rim stays the coolest of the three (it is still standing in for skyglow) but
     * lands amber rather than steel blue. */
    const night = clamp(1 - lum / 0.34, 0, 1);
    const warmTo = (l, hex, amt) => {
      if (!l?.userData?.day) return;
      l.color.copy(l.userData.day).lerp(_col.set(hex), amt * night);
    };
    warmTo(lights.fill, 0xffc48a, 0.82);
    warmTo(lights.rim, 0xffcf9a, 0.7);
    warmTo(lights.bounce, 0xff9c52, 0.55);
    // The hemisphere's lower half stands in for the old bounce light.
    if (lights.fill?.groundColor && lights.fill.userData?.dayGround) {
      lights.fill.groundColor.copy(lights.fill.userData.dayGround).lerp(_col.set(0xff9c52), 0.55 * night);
    }
    // The environment is a night sky: blue, and at this point the only blue left. Pull
    // its hold down further than the daylight curve does so it tints rather than casts.
    if (night > 0.01) scene.environmentIntensity *= 1 - 0.45 * night;

    const sc = ctx.lighting?.sunColor;
    // Only part-way to the sun's colour: steel and anodising are neutral, and a low warm
    // sun was pushing the entire weapon sepia until it read as one brown substance.
    if (sc?.isColor && lights.key) lights.key.color.copy(sc).lerp(_col.setRGB(1, 1, 1), 0.66);
    // ...but after dark there is no sun to track, so put the key on a warm practical.
    if (night > 0.01 && lights.key) {
      lights.key.color.lerp(_col.set(0xffbe86), 0.72 * night);
    }
  }

  /* ====================================================================== */
  /*                                  equip                                 */
  /* ====================================================================== */

  function equip(id, opts = {}) {
    if (id === 'none' || id == null) {
      holster();
      return null;
    }
    if (!WEAPON_DEFS[id]) return null;
    if (curId === id && cur && !hidden) return cur;
    const inst = ensureBuilt(id);
    if (!inst) return null;
    if (opts.attachments) {
      inst.attachments = resolveLoadout(inst.def, opts.attachments);
      refitAll(inst);
    }
    if (cur && cur !== inst) cur.gun.visible = false;
    if (cur?.optic?.reticle) cur.optic.reticle.visible = false;
    cur = inst;
    curId = id;
    hidden = false;
    cur.gun.visible = true;
    bindAnim(inst);
    attachFlash();
    if (!opts.instant) anim?.swap(1);
    ctx.bus?.emit?.('weapon:equip', {
      weapon: inst.handle,
      weaponId: id,
      def: inst.effDef,
      ammo: ammoOf().ammo,
    });
    emitAmmo();
    return inst;
  }

  function holster() {
    if (cur) cur.gun.visible = false;
    if (cur?.optic?.reticle) cur.optic.reticle.visible = false;
    hidden = true;
    cur = null;
    curId = 'none';
    anim?.setRig(null);
  }

  function bindAnim(inst) {
    const M = inst.nodes.magazine;
    const magLen = inst.def.build.mag.len;
    anim.setRig({
      rig,
      gun: inst.gun,
      nodes: inst.nodes,
      hands: inst.hands,
      def: inst.def,
      view: inst.def.view,
      mods: inst.stats?.mods || {},
      adsTime: inst.stats?.adsTime ?? inst.def.adsTime,
      adsOutTime: inst.stats?.adsOutTime ?? inst.def.adsOutTime,
      reloadTactical: inst.stats?.reloadTactical ?? inst.def.reload.tactical,
      reloadEmpty: inst.stats?.reloadEmpty ?? inst.def.reload.empty,
      recip: inst.recip,
      boltTravel: inst.boltTravel,
      magTravel: magLen * 0.62,
      followerTop: M ? inst.def.build.mag.yTop - 0.008 : 0,
      fireModeIndex: ammoOf().mode,
    });
    updateSightLocal(inst);
  }

  function updateSightLocal(inst) {
    const sight = inst.fitted.optic?.sight;
    const scale = inst.gun.scale.x || 1;
    if (!sight) {
      _v.set(0, inst.def.build.sightHeight * scale, -0.06 * scale);
      anim.setSightLocal(_v);
      return;
    }
    // Position of the optic's aim node in *rig* space (so the viewmodel scale is
    // baked in), taken with the rig at identity so the pose never feeds back into
    // the ADS solve.
    const savedP = rig.position.clone();
    const savedQ = rig.quaternion.clone();
    rig.position.set(0, 0, 0);
    rig.quaternion.identity();
    rig.updateWorldMatrix(true, true);
    _v.setFromMatrixPosition(sight.matrixWorld);
    rig.worldToLocal(_v);
    rig.position.copy(savedP);
    rig.quaternion.copy(savedQ);
    anim.setSightLocal(_v);
  }

  /* ====================================================================== */
  /*                                  ammo                                  */
  /* ====================================================================== */

  function ammoOf() {
    if (!cur) return { ammo: 0, reserve: 0, mode: 0 };
    let st = ammoState.get(cur.id);
    if (!st) {
      st = { ammo: cur.stats.magSize, reserve: cur.def.startReserve ?? 180, mode: 0 };
      ammoState.set(cur.id, st);
    }
    return st;
  }

  function emitAmmo() {
    const st = ammoOf();
    ctx.bus?.emit?.('weapon:ammo', {
      weapon: curId,
      ammo: st.ammo,
      reserve: st.reserve,
      magSize: cur?.stats?.magSize ?? 0,
      mode: currentMode(),
    });
  }

  function currentMode() {
    const modes = cur?.def?.fireModes || ['semi'];
    return modes[clamp(ammoOf().mode, 0, modes.length - 1)] || 'semi';
  }

  /* ====================================================================== */
  /*                                  firing                                */
  /* ====================================================================== */

  function canFire() {
    if (!cur || hidden) return false;
    if (anim?.busy) return false;
    return ammoOf().ammo > 0;
  }

  function shoot() {
    const st = ammoOf();
    const def = cur.def;
    const stats = cur.stats;
    st.ammo = Math.max(0, st.ammo - 1);

    // Aim solution: the shot leaves along the *camera* axis with a cone, which is
    // what every shooter since Quake has done and what the crosshair implies.
    const camera = ctx.camera;
    _origin.copy(camera ? camera.position : root.position);
    _axis.set(0, 0, -1);
    if (camera) _axis.applyQuaternion(camera.getWorldQuaternion(_q));

    const adsN = clamp01(anim?.adsRaw ?? 0);
    const cone = spreadOf(def, {
      ads: adsN,
      bloom,
      moving: clamp01((ctx.player?.speed ?? 0) / 4.5),
      airborne: ctx.player?.isGrounded === false,
      crouched: /crouch|prone|slide/.test(String(ctx.player?.stance ?? '')),
    }) * (adsN > 0.5 ? stats.spreadAds : stats.spreadHip);

    if (cone > 1e-5) {
      const r = ctx.rng;
      const a = (r ? r() : 0.5) * Math.PI * 2;
      const m = Math.sqrt(r ? r() : 0.5) * cone;
      _v.set(Math.cos(a) * m, Math.sin(a) * m, 0);
      _v2.set(1, 0, 0).applyQuaternion(_q).multiplyScalar(_v.x);
      _axis.add(_v2);
      _v2.set(0, 1, 0).applyQuaternion(_q).multiplyScalar(_v.y);
      _axis.add(_v2).normalize();
    }

    // Recoil comes from two places on purpose. The authored pattern is the part the
    // player learns and the part that moves the aim, so it goes in as an explicit
    // impulse; CameraRig's own `weapon:fire` kick is the punch on top of it. The 62x
    // converts a peak displacement into the velocity impulse its spring wants.
    const step = recoilStep(def, anim?.shotIndex ?? 0, ctx.rng);
    ctx.cameraRig?.addImpulse?.({
      rot: [-step.y * 62 * stats.recoilV, step.x * 62 * stats.recoilH, 0],
      space: 'local',
    });

    bloom = Math.min(
      def.spread.hipMax,
      bloom + (adsN > 0.5 ? def.spread.adsPerShot : def.spread.hipPerShot)
    );

    anim?.fire();
    fireFX();

    const payload = {
      // `weapon` is the live weapon handle: it carries `.id`, `.def` (attachment
      // folded) and stringifies to the id, so consumers can treat it either way.
      weapon: cur.handle,
      weaponId: curId,
      def: cur.effDef,
      origin: _origin.clone(),
      dir: _axis.clone(),
      ads: adsN > 0.5,
      shot: anim?.shotIndex ?? 0,
      spread: cone,
      ammo: st.ammo,
      suppressed: !!stats.suppressed,
    };
    ctx.bus?.emit?.('weapon:fire', payload);

    try {
      ctx.ballistics?.fire?.(payload.origin, payload.dir, {
        ...cur.effDef,
        muzzleVelocity: stats.muzzleVelocity,
        penetration: stats.penetration,
        damageAt: (m) => damageAt(def, m / Math.max(0.2, stats.damageRangeScale)),
        tracer: (anim?.shotIndex ?? 0) % (def.tracerEvery || 4) === 0,
        owner: 'player',
      });
    } catch (err) {
      warnOnce('ballistics.fire threw', err);
    }
    try {
      api.muzzleWorld(_v);
      ctx.fx?.muzzle?.(_v, _axis, {
        weapon: curId,
        scale: def.class === 'dmr' ? 1.35 : def.class === 'smg' ? 0.85 : 1,
        suppressed: !!stats.suppressed,
      });
    } catch (err) {
      warnOnce('fx.muzzle threw', err);
    }
    try {
      ctx.audio?.play?.(stats.suppressed ? 'weapon_suppressed' : def.audio?.fire || 'weapon_fire', {
        position: _origin,
        weapon: curId,
      });
    } catch {
      /* audio is optional */
    }

    ejectBrass();
    emitAmmo();

    if (st.ammo === 0) {
      anim?.setChamberOpen(true);
      ctx.bus?.emit?.('weapon:empty', { weapon: curId });
    }
  }

  function dryFire() {
    ctx.bus?.emit?.('weapon:empty', { weapon: curId, dry: true });
    try {
      ctx.audio?.play?.('weapon_dry', { weapon: curId });
    } catch {
      /* optional */
    }
  }

  /** Keep the flash (and its point light) parented to whatever the muzzle is now. */
  function attachFlash() {
    if (!flash) return;
    const tip = cur?.muzzleTip || cur?.nodes?.muzzle || null;
    if (tip && flash.group.parent !== tip) {
      flash.group.parent?.remove(flash.group);
      tip.add(flash.group);
    }
  }

  function fireFX() {
    if (!flash || !api.localMuzzleFlash) return;
    attachFlash();
    const supp = !!cur?.stats?.suppressed;
    flashT = supp ? 0.018 : 0.045;
    flashSeed = ctx.rng ? ctx.rng() : 0.5;
    flash.mat.uniforms.uSeed.value = flashSeed;
    if (flash.jetMat) flash.jetMat.uniforms.uSeed.value = flashSeed;
    flash.group.scale.setScalar((supp ? 0.34 : 1) * (cur?.def?.class === 'dmr' ? 1.3 : cur?.def?.class === 'smg' ? 0.82 : 1));
    for (let i = 0; i < flash.quads.length; i++) {
      flash.quads[i].rotation.z = flashSeed * 6.28 + (i / flash.quads.length) * Math.PI;
    }
  }

  function ejectBrass() {
    if (!brass.pool || !cur?.nodes?.eject) return;
    const slot = brass.pool.cases.find((c) => c.life <= 0);
    if (!slot) return;
    cur.nodes.eject.updateWorldMatrix(true, false);
    slot.mesh.position.setFromMatrixPosition(cur.nodes.eject.matrixWorld);
    slot.mesh.quaternion.setFromRotationMatrix(_m.extractRotation(cur.nodes.eject.matrixWorld));
    const r = ctx.rng || (() => 0.5);
    // Right, slightly rearward and up, in camera space.
    _v.set(2.3 + r() * 0.9, 1.5 + r() * 0.7, 1.0 + r() * 0.6);
    _v.applyQuaternion(root.getWorldQuaternion(_q));
    slot.vel.copy(_v);
    slot.spin.set((r() - 0.5) * 34, (r() - 0.5) * 26, (r() - 0.5) * 40);
    slot.life = 1.15;
    slot.mesh.visible = true;
    try {
      ctx.fx?.brass?.(slot.mesh.position, slot.vel, { weapon: curId });
    } catch {
      /* optional */
    }
  }

  function stepBrass(dt) {
    if (!brass.pool) return;
    for (const c of brass.pool.cases) {
      if (c.life <= 0) continue;
      c.life -= dt;
      if (c.life <= 0) {
        c.mesh.visible = false;
        continue;
      }
      c.vel.y -= 9.81 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      const fade = clamp01(c.life / 0.25);
      c.mesh.scale.setScalar(fade > 0 ? 1 : 1);
    }
  }

  /* ====================================================================== */
  /*                          reticle & optic frame                          */
  /* ====================================================================== */

  /**
   * Put the reticle where a collimated emitter would put it: on the sight's optical
   * axis as seen from the eye, so it never parallaxes off the target no matter where
   * your eye sits, and walks across the glass (and behind the tube wall) when you go
   * off-axis. That behaviour is the whole point of a red dot.
   */
  function updateReticle() {
    const optic = cur?.optic;
    if (!optic?.reticle) return;
    const group = optic.group;
    if (!group) return;
    group.updateWorldMatrix(true, false);
    // The optic group's origin sits on the rail, not on the optical axis, so build
    // the reticle plane point from the optic's own axis height.
    _m.copy(root.matrixWorld).invert().multiply(group.matrixWorld);
    _axis.set(0, 0, -1).applyMatrix4(_m2.extractRotation(_m)).normalize();
    _v.set(0, optic.axisY ?? 0, optic.planeZ ?? -0.02).applyMatrix4(_m);
    // The apparent direction is the optical axis, so project the eye (the root's
    // origin) onto that axis and put the quad there: collimated at infinity.
    const t = _v.dot(_axis);
    if (!(t > 0.01)) {
      optic.reticle.visible = false;
      return;
    }
    // Where the collimated dot actually lands on the reticle plane.
    _v2.copy(_axis).multiplyScalar(t);
    // A real emitter only reaches your eye through the front element: once the dot
    // walks past the glass aperture there is no light path left and it disappears.
    const glassR = optic.glassR ?? 0.014;
    const off = _v2.distanceTo(_v);
    const aperture = clamp01(1 - (off - glassR * 0.72) / (glassR * 0.42));
    if (aperture <= 0.002) {
      optic.reticle.visible = false;
      return;
    }
    optic.reticle.visible = !hidden && !!cur?.gun?.visible;
    optic.reticle.position.copy(_v2);
    optic.reticle.quaternion.identity();
    const dotRad = optic.dotRad ?? 0.0042;
    const uSize = optic.reticleMat?.uniforms?.uSize?.value ?? 0.003;
    optic.reticle.scale.setScalar(clamp((dotRad * t) / Math.max(1e-5, uSize), 0.004, 4));
    if (optic.reticleMat) {
      const u = optic.reticleMat.uniforms;
      u.uJitter.value = Math.sin((ctx.time?.elapsed ?? 0) * 41.3) * 0.5 + 0.5;
      // Enough to blow the core to white and bloom, not enough to make the white core
      // itself large: the dot has to stay an aiming point, not a splash of light.
      u.uIntensity.value = (3.3 + 2.2 * clamp01(anim?.adsBlend ?? 0)) * aperture;
    }
  }

  function updateOpticUniforms() {
    const optic = cur?.optic;
    if (!optic) return;
    // Feed the real environment into the glass shaders so the coatings pick up the
    // sky and the sun rather than a hard-coded blue.
    let sky = null;
    let ground = null;
    try {
      sky = ctx.lighting?.ambientIrradiance?.(_v.set(0, 1, 0));
      ground = ctx.lighting?.ambientIrradiance?.(_v.set(0, -1, 0));
    } catch {
      /* optional */
    }
    const sun = ctx.lighting?.sunColor;
    const sunDir = ctx.lighting?.sunDirection;
    const apply = (u) => {
      if (!u) return;
      if (sky?.isColor && u.uSky) u.uSky.value.copy(sky).multiplyScalar(1 / Math.PI);
      if (ground?.isColor && u.uGround) u.uGround.value.copy(ground).multiplyScalar(1 / Math.PI);
      if (sun?.isColor && u.uSunColor) u.uSunColor.value.copy(sun);
      if (sunDir && u.uSunDir) u.uSunDir.value.set(sunDir.x, Math.abs(sunDir.y), sunDir.z).normalize();
    };
    /* Emitter bleed into the coating stack. Deliberately *not* gated on the eye being
     * on-axis the way the collimated dot is (updateReticle bails out entirely once the
     * dot walks off the aperture, which is every hip-fire frame): the LED's own spill
     * is visible from anywhere you can see the element, and it is most of what tells a
     * viewer at hip that the tube is a live red dot rather than a pipe. */
    // Strong off-axis, almost gone once the eye is behind the sight: at hip it is the
    // "live optic" cue, but on the aiming axis it would be a pink filter over the target.
    /* Pulled back from 0.07: with the coating term now scaled by the environment (see
     * GLASS_FRAG) the emitter spill became the largest single contributor to the front
     * element in a dark room, and a red-dot objective that glows pink from the front in
     * an unlit interior is the same failure the coating had, one term along. */
    const glow = optic.kind === 'reflex' ? 0.045 * (1 - 0.72 * clamp01(anim?.adsBlend ?? 0)) : 0;
    for (const g of optic.glass || []) {
      apply(g?.uniforms);
      if (g?.uniforms?.uGlow) g.uniforms.uGlow.value = glow;
    }
    if (optic.imageMat) {
      const u = optic.imageMat.uniforms;
      apply(u);
      // Eyebox: how far the eye sits off the optical axis, in exit-pupil radii.
      const group = optic.group;
      if (group) {
        group.updateWorldMatrix(true, false);
        _m.copy(root.matrixWorld).invert().multiply(group.matrixWorld);
        _axis.set(0, 0, -1).applyMatrix4(_m2.extractRotation(_m)).normalize();
        // A point on the optical axis, at the ocular.
        _v.set(0, optic.axisY ?? 0, optic.sight?.position?.z ?? 0).applyMatrix4(_m);
        const along = _v.dot(_axis);
        // Perpendicular offset of the eye (the root's origin) from the axis line.
        _v2.copy(_axis).multiplyScalar(along).sub(_v);
        const ebr = optic.eyeboxRadius ?? 0.012;
        u.uOffX.value = clamp(_v2.x / ebr, -4, 4);
        u.uOffY.value = clamp(_v2.y / ebr, -4, 4);
        const ideal = (cur.def.view?.adsEyeRelief ?? 0.11) + 0.012;
        u.uBlackout.value = clamp01(Math.abs(Math.abs(along) - ideal) / 0.16 - 0.2) * 0.92;
        _v.copy(_axis).applyQuaternion(root.getWorldQuaternion(_q));
        u.uAxis.value.copy(_v);
      }
      u.uIllum.value = 0.35 + 0.5 * clamp01(anim?.adsBlend ?? 0);
      u.uMil.value = 1;
    }
  }

  /* ---------------------------- picture-in-picture ---------------------- */

  function pipWanted() {
    const optic = cur?.optic;
    if (!optic || optic.kind !== 'scope' || pip.broken || !pip.enabled) return false;
    return (anim?.adsBlend ?? 0) > 0.3;
  }

  function ensurePip() {
    if (pip.rt) return;
    const headless = !!ctx.settings?.get?.('headless');
    const res = headless ? 192 : ctx.settings?.tier === 'low' ? 256 : 512;
    pip.rt = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      colorSpace: THREE.NoColorSpace,
    });
    pip.rt.texture.minFilter = THREE.LinearFilter;
    pip.rt.texture.magFilter = THREE.LinearFilter;
    pip.cam = new THREE.PerspectiveCamera(20, 1, 0.08, 1400);
  }

  /** Runs *after* the main render so shadow maps are already resolved for the frame. */
  function renderPip() {
    pip.registered = false;
    if (!pipWanted()) {
      pip.active = false;
      if (cur?.optic?.imageMat) cur.optic.imageMat.uniforms.uUsePip.value = 0;
      return;
    }
    try {
      ensurePip();
      const optic = cur.optic;
      const group = optic.group;
      group.updateWorldMatrix(true, false);
      const zoom = Math.max(1.2, optic.zoom || 3);
      pip.cam.fov = clamp((ctx.camera?.fov ?? 90) / zoom, 2, 60);
      pip.cam.aspect = 1;
      pip.cam.near = 0.08;
      pip.cam.far = 1400;
      pip.cam.position.copy(ctx.camera.position);
      pip.cam.quaternion.setFromRotationMatrix(_m2.extractRotation(group.matrixWorld));
      pip.cam.updateProjectionMatrix();
      pip.cam.updateMatrixWorld(true);
      const r = ctx.renderer;
      const prevTarget = r.getRenderTarget();
      const prevShadowAuto = r.shadowMap.autoUpdate;
      const prevClear = r.getClearColor(_clear);
      const prevAlpha = r.getClearAlpha();
      // Shadow maps were already resolved by the main render this frame; re-rendering
      // them for a 192px inset would be pure waste.
      r.shadowMap.autoUpdate = false;
      r.setRenderTarget(pip.rt);
      r.setClearColor(0x000000, 1);
      r.clear(true, true, false);
      r.render(ctx.scene, pip.cam);
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevClear, prevAlpha);
      r.shadowMap.autoUpdate = prevShadowAuto;
      optic.imageMat.uniforms.uPip.value = pip.rt.texture;
      optic.imageMat.uniforms.uUsePip.value = 1;
      pip.active = true;
    } catch (err) {
      pip.broken = true;
      pip.active = false;
      if (cur?.optic?.imageMat) cur.optic.imageMat.uniforms.uUsePip.value = 0;
      warnOnce('scope picture-in-picture disabled', err);
    }
  }

  /* ====================================================================== */
  /*                                  input                                 */
  /* ====================================================================== */

  function readIntent(dt) {
    if (poseMode) {
      const prev = wantFire;
      wantFire = !!poseState?.firing;
      wantAds = !!poseState?.ads;
      firePressedEdge = wantFire && !prev;
      return;
    }
    const input = ctx.input;
    if (!input) return;
    const prevFire = wantFire;
    wantFire = !!input.fire;
    firePressedEdge = wantFire && !prevFire;
    wantAds = !!input.ads;
    if (input.pressed?.('reload')) api.reload();
    if (input.pressed?.('melee')) api.melee();
    if (input.pressed?.('inspect')) api.inspect();
    if (input.pressed?.('fireMode')) api.cycleFireMode();
    if (input.pressed?.('swap')) api.next();
    void dt;
  }

  /* ====================================================================== */
  /*                                  frame                                 */
  /* ====================================================================== */

  function tickFiring(dt) {
    const def = cur?.def;
    if (!def) return;
    const interval = rpmToInterval(def);
    fireTimer -= dt;
    burstGap -= dt;
    const mode = currentMode();

    if (mode === 'burst' && burstLeft > 0 && burstGap <= 0) {
      if (fireTimer <= 0) {
        if (canFire()) {
          shoot();
          burstLeft--;
          fireTimer += interval;
          if (burstLeft === 0) burstGap = interval * (def.burstGapScale ?? 2.5);
        } else {
          burstLeft = 0;
          if (ammoOf().ammo === 0) dryFire();
        }
      }
      return;
    }

    if (!wantFire) {
      semiLatch = false;
      return;
    }
    if (anim?.busy) return;

    if (ammoOf().ammo <= 0) {
      if (firePressedEdge) {
        dryFire();
        if (ammoOf().reserve > 0) api.reload();
      }
      return;
    }

    if (mode === 'semi') {
      if (!semiLatch && fireTimer <= 0) {
        semiLatch = true;
        shoot();
        fireTimer = interval;
      }
      return;
    }
    if (mode === 'burst') {
      if (!semiLatch && fireTimer <= 0 && burstGap <= 0) {
        semiLatch = true;
        burstLeft = (def.burstCount ?? 3) - 1;
        shoot();
        fireTimer = interval;
      }
      return;
    }
    // auto — frame-rate independent, up to a few rounds per frame on a bad hitch.
    let guard = 4;
    while (fireTimer <= 0 && guard-- > 0) {
      if (!canFire()) {
        if (ammoOf().ammo === 0 && firePressedEdge) dryFire();
        fireTimer = 0;
        break;
      }
      shoot();
      fireTimer += interval;
    }
    if (fireTimer < -interval) fireTimer = 0;
  }

  function handleAnimEvents(events) {
    if (!events) return;
    const st = ammoOf();
    for (const e of events) {
      switch (e) {
        case 'release':
          ctx.bus?.emit?.('weapon:reload', { weapon: curId, stage: 'release' });
          break;
        case 'magout':
          ctx.bus?.emit?.('weapon:reload', { weapon: curId, stage: 'magout' });
          try {
            ctx.audio?.play?.(cur?.def?.audio?.reloadOut || 'mag_out');
          } catch {
            /* optional */
          }
          break;
        case 'magin':
          ctx.bus?.emit?.('weapon:reload', { weapon: curId, stage: 'magin' });
          try {
            ctx.audio?.play?.(cur?.def?.audio?.reloadIn || 'mag_in');
          } catch {
            /* optional */
          }
          break;
        case 'seat': {
          const size = cur?.stats?.magSize ?? 30;
          const keepChambered = cur?.def?.chambered && st.ammo > 0;
          const want = size + (keepChambered ? 1 : 0) - st.ammo;
          const take = Math.min(st.reserve, Math.max(0, want));
          st.ammo += take;
          st.reserve -= take;
          if (!anim?.chamberOpen) {
            anim?.resetShotIndex();
          }
          ctx.bus?.emit?.('weapon:reload', { weapon: curId, stage: 'seat' });
          emitAmmo();
          break;
        }
        case 'boltrelease':
          anim?.setChamberOpen(false);
          anim?.resetShotIndex();
          ctx.bus?.emit?.('weapon:reload', { weapon: curId, stage: 'boltrelease' });
          break;
        case 'chambercheck':
          break;
        case 'meleehit':
          ctx.bus?.emit?.('weapon:melee', { weapon: curId, damage: 55 });
          break;
        case 'reload:end':
          if (anim?.chamberOpen && ammoOf().ammo > 0) anim.setChamberOpen(false);
          anim?.resetShotIndex();
          ctx.bus?.emit?.('weapon:reload', { weapon: curId, stage: 'end' });
          emitAmmo();
          break;
        case 'inspect:end':
        case 'melee:end':
        case 'swap:end':
          break;
        default:
          break;
      }
    }
  }

  function stateForAnim() {
    const p = ctx.player;
    const stance = String(p?.state ?? '');
    return {
      adsWant: wantAds && !hidden,
      firing: wantFire && (cur ? ammoOf().ammo > 0 : false),
      speed: p?.speed ?? 0,
      lateral: ctx.cameraRig?.getViewOffset?.()?.lateral ?? 0,
      stance,
      sprint: /sprint/i.test(stance) && !/tac/i.test(stance),
      tacSprint: /tacsprint/i.test(stance),
      grounded: p?.isGrounded !== false,
      exertion: ctx.cameraRig?.exertion ?? 0,
      lowReady: false,
      ammo: ammoOf().ammo,
      magSize: cur?.stats?.magSize ?? 30,
    };
  }

  /* ====================================================================== */
  /*                                   API                                  */
  /* ====================================================================== */

  let warned = new Set();
  function warnOnce(msg, err) {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.warn(`[weapons] ${msg}`, err || '');
  }

  const api = {
    ready: false,
    root,
    rig,
    /** FX may own the world-space muzzle flash; set false to suppress ours. */
    localMuzzleFlash: true,
    defs: WEAPON_DEFS,
    list: () => WEAPON_IDS.slice(),

    get current() {
      return cur
        ? {
            id: cur.id,
            def: cur.effDef,
            handle: cur.handle,
            ammo: ammoOf().ammo,
            reserve: ammoOf().reserve,
            magSize: cur.stats.magSize,
            attachments: { ...cur.attachments },
            adsProgress: clamp01(anim?.adsBlend ?? 0),
          }
        : null;
    },
    get currentId() {
      return curId;
    },
    get def() {
      return cur?.effDef ?? null;
    },
    /** The unmodified catalogue entry, before attachments. */
    get baseDef() {
      return cur?.def ?? null;
    },
    /** The attachment-folded tuning view of the current weapon. */
    get tuning() {
      return cur?.stats ?? null;
    },
    get ads() {
      return (anim?.adsRaw ?? 0) > 0.5;
    },
    get aiming() {
      return (anim?.adsRaw ?? 0) > 0.5;
    },
    get adsProgress() {
      return clamp01(anim?.adsBlend ?? 0);
    },
    get zoom() {
      return cur?.stats?.zoom ?? 1;
    },
    get adsFovScale() {
      const z = cur?.stats?.zoom ?? 1;
      if (z > 1.05) return clamp(1 / z, 0.14, 0.95);
      return cur?.def?.adsFovScale ?? 0.72;
    },
    get firing() {
      return wantFire && !!cur;
    },
    get reloading() {
      return anim?.action === 'reload';
    },
    get busy() {
      return !!anim?.busy;
    },
    get ammo() {
      return ammoOf().ammo;
    },
    get reserve() {
      return ammoOf().reserve;
    },
    get magSize() {
      return cur?.stats?.magSize ?? 0;
    },
    get fireMode() {
      return currentMode();
    },
    get fireModes() {
      return cur?.def?.fireModes?.slice() ?? [];
    },
    /** Current cone half-angle in radians — what the HUD should size the reticle to. */
    get spread() {
      if (!cur) return 0;
      const adsN = clamp01(anim?.adsRaw ?? 0);
      const cone = spreadOf(cur.def, {
        ads: adsN,
        bloom,
        moving: clamp01((ctx.player?.speed ?? 0) / 4.5),
        airborne: ctx.player?.isGrounded === false,
        crouched: /crouch|prone|slide/.test(String(ctx.player?.stance ?? '')),
      });
      return cone * (adsN > 0.5 ? cur.stats.spreadAds : cur.stats.spreadHip);
    },
    get bloom() {
      return bloom;
    },
    get moveSpeedScale() {
      if (!cur) return 1;
      const a = clamp01(anim?.adsBlend ?? 0);
      return lerp(cur.stats.moveSpeedScale, cur.stats.adsMoveScale, a);
    },
    get attachments() {
      return cur ? { ...cur.attachments } : null;
    },
    get scene() {
      return ctx.viewScene;
    },
    get animator() {
      return anim;
    },

    equip,
    holster,
    next() {
      const i = WEAPON_IDS.indexOf(curId);
      return equip(WEAPON_IDS[(i + 1 + WEAPON_IDS.length) % WEAPON_IDS.length]);
    },
    prev() {
      const i = WEAPON_IDS.indexOf(curId);
      return equip(WEAPON_IDS[(i - 1 + WEAPON_IDS.length) % WEAPON_IDS.length]);
    },
    startFire() {
      wantFire = true;
      firePressedEdge = true;
    },
    stopFire() {
      wantFire = false;
      semiLatch = false;
    },
    reload() {
      if (!cur || anim?.busy) return false;
      const st = ammoOf();
      const size = cur.stats.magSize;
      if (st.reserve <= 0 || st.ammo >= size + (cur.def.chambered ? 1 : 0)) return false;
      const empty = st.ammo <= 0;
      if (!anim?.reload(empty)) return false;
      ctx.bus?.emit?.('weapon:reload', { weapon: curId, stage: 'start', empty });
      return true;
    },
    melee() {
      if (!cur || anim?.action === 'melee') return false;
      anim?.melee();
      ctx.bus?.emit?.('weapon:melee', { weapon: curId, stage: 'start' });
      return true;
    },
    inspect() {
      if (!cur || anim?.busy) return false;
      anim?.inspect();
      ctx.bus?.emit?.('weapon:inspect', { weapon: curId });
      return true;
    },
    cycleFireMode() {
      if (!cur) return null;
      const modes = cur.def.fireModes || ['semi'];
      const st = ammoOf();
      st.mode = (st.mode + 1) % modes.length;
      burstLeft = 0;
      if (anim) anim.setRig && bindAnim(cur);
      ctx.bus?.emit?.('weapon:firemode', { weapon: curId, mode: modes[st.mode] });
      return modes[st.mode];
    },
    setAttachment(slot, id) {
      if (!cur || !SLOTS.includes(slot)) return false;
      const next = resolveLoadout(cur.def, { ...cur.attachments, [slot]: id });
      cur.attachments = next;
      fit(cur, slot);
      cur.stats = applyStats(cur.def, cur.attachments);
      buildEffectiveDef(cur);
      bindAnim(cur);
      const st = ammoOf();
      st.ammo = Math.min(st.ammo, cur.stats.magSize);
      emitAmmo();
      return true;
    },
    muzzleWorld(out) {
      const v = out || new THREE.Vector3();
      const tip = cur?.muzzleTip || cur?.nodes?.muzzle;
      if (tip) {
        tip.updateWorldMatrix(true, false);
        v.setFromMatrixPosition(tip.matrixWorld);
      } else if (ctx.camera) {
        v.copy(ctx.camera.position);
      }
      return v;
    },
    aimDir(out) {
      const v = out || new THREE.Vector3();
      v.set(0, 0, -1);
      if (ctx.camera) v.applyQuaternion(ctx.camera.getWorldQuaternion(_q));
      return v;
    },
    damageAt: (m) => (cur ? damageAt(cur.def, m) : 0),
    stats() {
      return {
        weapon: curId,
        tris: cur?.tris ?? 0,
        built: [...built.keys()],
        pip: pip.active,
        action: anim?.action ?? null,
        ammo: ammoOf().ammo,
        reserve: ammoOf().reserve,
        ads: clamp01(anim?.adsBlend ?? 0),
      };
    },
  };

  /* ====================================================================== */
  /*                                 system                                 */
  /* ====================================================================== */

  return {
    name: 'weapons',
    order: 70,

    async init() {
      ctx.weapons = api;
      try {
        mats = makeWeaponMaterials(ctx);
        anim = createProcAnim(ctx);

        ctx.viewScene?.add(root);
        setupLights();
        syncEnvironment();

        brass.pool = makeBrassPool(ctx, mats, 10, 0.0057);
        ctx.viewScene?.add(brass.pool.group);
        flash = makeMuzzleFlash(ctx, mats);

        baseViewFov = ctx.settings?.get?.('viewmodelFov') ?? 60;

        equip('ar_wolverine', { instant: true });

        on('debug:pose', (st) => {
          poseState = st || {};
          poseMode = true;
          const id = poseState.weapon;
          if (id === 'none') holster();
          else if (typeof id === 'string') equip(id, { instant: true });
          else if (!cur) equip('ar_wolverine', { instant: true });
          anim?.cancelAction();
          bloom = 0;
          fireTimer = 0;
          burstLeft = 0;
          semiLatch = false;
          if (cur) {
            const s = ammoOf();
            s.ammo = cur.stats.magSize;
            anim?.setChamberOpen(false);
            anim?.resetShotIndex();
          }
          // The harness only warms a handful of frames after a pose is applied, which
          // is less than the mount time — settle the aim transition now so an `ads`
          // pose is captured aiming rather than half-way up.
          anim?.snapAds?.(poseState.ads ? 1 : 0);
          if (poseState.inspect) anim?.inspect();
          if (poseState.attachments && cur) {
            cur.attachments = resolveLoadout(cur.def, poseState.attachments);
            refitAll(cur);
            bindAnim(cur);
          }
        });
        on('debug:cameraLock', ({ locked }) => {
          if (!locked) poseMode = false;
        });
        on('entity:damage', (e) => {
          if (e?.target === ctx.player || e?.target === 'player') anim?.flinch(0.35);
        });
        on('quality:changed', () => {
          if (pip.rt) {
            pip.rt.dispose();
            pip.rt = null;
          }
        });

        api.ready = true;
      } catch (err) {
        console.warn('[weapons] init failed, viewmodel disabled', err);
      }
    },

    update(dt) {
      if (!api.ready) return;
      const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 1 / 60;
      // Age the muzzle flash *before* this frame's shot so a round fired now is drawn
      // at full intensity on the frame it happens.
      if (flashT > 0) {
        flashT -= d;
        const k = clamp01(flashT / 0.045);
        if (flash) {
          const amt = flashT > 0 ? k * k : 0;
          flash.mat.uniforms.uAmount.value = amt;
          if (flash.jetMat) flash.jetMat.uniforms.uAmount.value = amt;
          flash.light.intensity = amt * 26;
        }
      }
      readIntent(d);
      if (cur) tickFiring(d);
      // Bloom recovery.
      if (cur) {
        const sp = cur.def.spread;
        const adsN = clamp01(anim?.adsRaw ?? 0);
        const rec = lerp(sp.hipRecover, sp.adsRecover ?? sp.hipRecover, adsN);
        bloom = Math.max(0, bloom - rec * d);
      }
      stepBrass(d);
    },

    lateUpdate(dt) {
      if (!api.ready) return;
      const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 1 / 60;
      const vc = ctx.viewCamera;
      if (vc) {
        root.position.copy(vc.position);
        root.quaternion.copy(vc.quaternion);
        root.updateMatrixWorld(true);
      }
      if (cur) {
        const events = anim?.update(d, stateForAnim());
        handleAnimEvents(events);
        root.updateMatrixWorld(true);
        updateReticle();
        updateOpticUniforms();
      }
      syncEnvironment();

      // Viewmodel FOV: pull in slightly on ADS, a lot behind a magnified optic.
      if (vc) {
        const a = clamp01(anim?.adsBlend ?? 0);
        const z = cur?.stats?.zoom ?? 1;
        const target = baseViewFov * lerp(1, z > 1.05 ? clamp(0.44 + 0.5 / z, 0.4, 0.8) : 0.84, a);
        if (Math.abs(vc.fov - target) > 0.01) {
          vc.fov = target;
          vc.updateProjectionMatrix();
        }
      }

      // Scope picture-in-picture runs after the main render.
      if (!pip.registered && pipWanted()) {
        pip.registered = true;
        ctx.engine?.onNextFrame?.(renderPip);
      } else if (!pipWanted() && cur?.optic?.imageMat) {
        cur.optic.imageMat.uniforms.uUsePip.value = 0;
      }
    },

    resize() {
      /* viewCamera aspect is handled by the engine */
    },

    dispose() {
      for (const off of subs) {
        try {
          off();
        } catch {
          /* best effort */
        }
      }
      subs.length = 0;
      try {
        pip.rt?.dispose();
      } catch {
        /* best effort */
      }
      for (const inst of built.values()) {
        disposeTree(inst.gun);
        inst.gun.parent?.remove(inst.gun);
      }
      built.clear();
      if (brass.pool?.group) {
        disposeTree(brass.pool.group);
        brass.pool.group.parent?.remove(brass.pool.group);
      }
      if (flash?.group) {
        disposeTree(flash.group);
        flash.group.parent?.remove(flash.group);
      }
      root.parent?.remove(root);
      for (const m of Object.values(mats || {})) {
        if (m?.dispose) m.dispose();
        else if (m && typeof m === 'object') for (const mm of Object.values(m)) mm?.dispose?.();
      }
      mats = null;
      cur = null;
      api.ready = false;
    },
  };
}
