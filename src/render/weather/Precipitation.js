/**
 * weather/Precipitation.js — rain and everything water does when it lands.
 * Owner: weather agent. Files owned: src/render/Weather.js, src/render/weather/**.
 *
 * Four draw calls, all instanced, all animated on the GPU:
 *
 *   rain     one camera-following volume of stretched billboards. Each drop is a
 *            quad oriented along its own velocity, so wind shear tilts the whole
 *            curtain; the streak length is the distance travelled in one exposure
 *            and the width grows with distance, which is what gives the depth
 *            parallax between the fat drops by your face and the far grey veil.
 *            Every drop tests the shelter map in the vertex shader, so nothing
 *            falls through a roof — one texture fetch instead of a raycast.
 *   splash   a pooled ring of crown billboards spawned on the CPU where drops
 *            actually land (the shelter map's top surface), skipped when that
 *            surface is over the camera's head.
 *   ripple   flat expanding rings, only in the low, flat, open cells the shelter
 *            bake identified as places standing water collects.
 *   drip     a static instance per roof lip / awning edge, each running its own
 *            swell-fall-swell cycle entirely in the vertex shader.
 *
 * Nothing here allocates per frame; the splash and ripple pools are ring buffers.
 */
import * as THREE from 'three';
import {
  RAIN_VERT,
  RAIN_FRAG,
  SPLASH_VERT,
  SPLASH_FRAG,
  RIPPLE_VERT,
  RIPPLE_FRAG,
  DRIP_VERT,
  DRIP_FRAG,
} from './shaders.js';

/**
 * A unit quad in the XY plane, centred, with uv 0..1 — the base every particle
 * shader expands from. Each geometry gets its own copy of the four vertices: sharing
 * one BufferAttribute across geometries means disposing any one of them frees the
 * shared GPU buffer out from under the others.
 *
 * @param {number} count instances
 */
export function instancedQuad(count) {
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex([0, 2, 1, 2, 3, 1]);
  /**
   * `position` is **all zeros**, deliberately. Every weather shader builds its vertex
   * from `uv` and the instance attributes and never reads `position` — but the
   * pipeline's g-buffer and debug passes swap in their own stand-in materials, which
   * *do*. With a real quad in there, every one of these meshes would stamp a
   * thousand-times-overdrawn 1 m square at the world origin into the ORM buffer and
   * corrupt the reflections that read it. Zeroed, those passes rasterise nothing:
   * degenerate triangles, no fragments, no cost, and our own shaders are unaffected.
   */
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2));
  g.instanceCount = count;
  // Every vertex is placed from uniforms and instance attributes, so a real bounding
  // volume is meaningless — never let three cull on it or try to recompute one.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
  g.computeBoundingSphere = function () {};
  return g;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Precipitation {
  /**
   * @param {object} ctx
   * @param {import('./ShelterMap.js').ShelterMap} shelter
   */
  constructor(ctx, shelter) {
    this.ctx = ctx;
    this.shelter = shelter;
    this.group = new THREE.Group();
    this.group.name = 'weather.precipitation';
    this.group.frustumCulled = false;
    // The shelter bake must not see the rain as a roof.
    this.group.userData.noShelter = true;
    this.group.renderOrder = 3000;

    this.intensity = 0;
    this.enabled = true;
    this.budget = { rain: 0, splash: 0, ripple: 0, drip: 0 };

    this._wind = new THREE.Vector3();
    this._splashCursor = 0;
    this._rippleCursor = 0;
    this._splashDebt = 0;
    this._rippleDebt = 0;
    this._tmp = new THREE.Vector3();
    this._built = false;
  }

  /* ────────────────────────────────────────────────────────────────── build */

  build(budget) {
    this.budget = budget;
    this.dispose(false);
    this._buildRain(budget.rain);
    this._buildSplash(budget.splash);
    this._buildRipple(budget.ripple);
    this._buildDrips(budget.drip);
    this.attachShelter();
    this._built = true;
  }

  /**
   * Re-point the rain shader at the current bake. A failed or absent bake leaves
   * `uHasShelter` at 0, which makes the shader treat the whole world as open sky —
   * rain everywhere is a far better failure mode than rain nowhere.
   */
  attachShelter() {
    const s = this.shelter;
    const tex = s?.ready ? s.texture : null;
    const u = this.rainMat?.uniforms;
    if (!u) return;
    u.uShelter.value = tex;
    u.uHasShelter.value = tex ? 1 : 0;
    if (s?.rect) u.uShelterRect.value.copy(s.rect);
  }

  _buildRain(count) {
    if (count <= 0) return;
    const rng = this.ctx.rng || Math.random;
    const seed = new Float32Array(count * 4);
    const param = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      seed[i * 4 + 0] = rng();
      seed[i * 4 + 1] = rng();
      seed[i * 4 + 2] = rng();
      seed[i * 4 + 3] = rng();
      // Threshold: a drop only exists once the intensity passes its own number, so
      // the curtain thickens smoothly instead of every drop fading in together.
      param[i * 2 + 0] = rng();
      param[i * 2 + 1] = rng();
    }
    const g = instancedQuad(count);
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.setAttribute('aParam', new THREE.InstancedBufferAttribute(param, 2));

    this.rainMat = new THREE.ShaderMaterial({
      name: 'weather:rain',
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAnchor: { value: new THREE.Vector3() },
        // Half-extents. Y is deliberately shallow and the anchor is lifted (see
        // update()) so almost the whole volume sits between the player's feet and
        // ~15 m up: drops spawned below the ground are killed by the shelter test
        // and would otherwise waste half the instance budget.
        uBox: { value: new THREE.Vector3(26, 9, 26) },
        uVel: { value: new THREE.Vector3(0, -9, 0) },
        uWidth: { value: 0.016 },
        uStretch: { value: 0.055 },
        uIntensity: { value: 0 },
        uNearFade: { value: 0.55 },
        uColor: { value: new THREE.Color(0.58, 0.66, 0.82) },
        uSunColor: { value: new THREE.Color(0.5, 0.5, 0.5) },
        uOpacity: { value: 0.55 },
        uShelter: { value: null },
        uShelterRect: { value: new THREE.Vector4(-64, 60, 1 / 128, -1 / 118) },
        uHasShelter: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.rainMesh = new THREE.Mesh(g, this.rainMat);
    this.rainMesh.name = 'weather.rain';
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 3010;
    this.rainMesh.userData.noShelter = true;
    this.rainMesh.visible = false;
    this.group.add(this.rainMesh);
  }

  _buildSplash(count) {
    if (count <= 0) return;
    const g = instancedQuad(count);
    this.splashOrigin = new Float32Array(count * 3);
    this.splashData = new Float32Array(count * 4);
    // Birth far in the past so nothing draws until a slot is claimed.
    for (let i = 0; i < count; i++) this.splashData[i * 4 + 0] = -1e4;
    this.splashOriginAttr = new THREE.InstancedBufferAttribute(this.splashOrigin, 3);
    this.splashDataAttr = new THREE.InstancedBufferAttribute(this.splashData, 4);
    this.splashOriginAttr.setUsage(THREE.DynamicDrawUsage);
    this.splashDataAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aOrigin', this.splashOriginAttr);
    g.setAttribute('aData', this.splashDataAttr);

    this.splashMat = new THREE.ShaderMaterial({
      name: 'weather:splash',
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSizeScale: { value: 1 },
        uColor: { value: new THREE.Color(0.66, 0.72, 0.82) },
        uOpacity: { value: 0.5 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.splashMesh = new THREE.Mesh(g, this.splashMat);
    this.splashMesh.name = 'weather.splash';
    this.splashMesh.frustumCulled = false;
    this.splashMesh.renderOrder = 3005;
    this.splashMesh.userData.noShelter = true;
    this.splashMesh.visible = false;
    this.group.add(this.splashMesh);
  }

  _buildRipple(count) {
    if (count <= 0) return;
    const g = instancedQuad(count);
    this.rippleOrigin = new Float32Array(count * 3);
    this.rippleData = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) this.rippleData[i * 4 + 0] = -1e4;
    this.rippleOriginAttr = new THREE.InstancedBufferAttribute(this.rippleOrigin, 3);
    this.rippleDataAttr = new THREE.InstancedBufferAttribute(this.rippleData, 4);
    this.rippleOriginAttr.setUsage(THREE.DynamicDrawUsage);
    this.rippleDataAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aOrigin', this.rippleOriginAttr);
    g.setAttribute('aData', this.rippleDataAttr);

    this.rippleMat = new THREE.ShaderMaterial({
      name: 'weather:ripple',
      vertexShader: RIPPLE_VERT,
      fragmentShader: RIPPLE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0.72, 0.78, 0.88) },
        uOpacity: { value: 0.35 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.rippleMesh = new THREE.Mesh(g, this.rippleMat);
    this.rippleMesh.name = 'weather.ripple';
    this.rippleMesh.frustumCulled = false;
    this.rippleMesh.renderOrder = 2990;
    this.rippleMesh.userData.noShelter = true;
    this.rippleMesh.visible = false;
    this.group.add(this.rippleMesh);
  }

  /** Static: one instance per roof lip the shelter bake found. */
  _buildDrips(maxCount) {
    const edges = this.shelter?.dripEdges || [];
    const count = Math.min(maxCount, edges.length);
    if (count <= 0) return;
    const rng = this.ctx.rng || Math.random;
    const edge = new Float32Array(count * 4);
    const tune = new Float32Array(count * 3);
    // The bake sorts by "most visible"; take a deterministic even spread of them.
    const stride = Math.max(1, Math.floor(edges.length / count));
    for (let i = 0; i < count; i++) {
      const e = edges[Math.min(edges.length - 1, i * stride)];
      edge[i * 4 + 0] = e.x;
      edge[i * 4 + 1] = e.y;
      edge[i * 4 + 2] = e.z;
      edge[i * 4 + 3] = clamp(e.fall, 0.4, 12);
      tune[i * 3 + 0] = 0.9 + rng() * 2.6; // seconds between beads
      tune[i * 3 + 1] = rng();
      tune[i * 3 + 2] = 0.018 + rng() * 0.016;
    }
    const g = instancedQuad(count);
    g.setAttribute('aEdge', new THREE.InstancedBufferAttribute(edge, 4));
    g.setAttribute('aTune', new THREE.InstancedBufferAttribute(tune, 3));

    this.dripMat = new THREE.ShaderMaterial({
      name: 'weather:drip',
      vertexShader: DRIP_VERT,
      fragmentShader: DRIP_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uRate: { value: 1 },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(0.6, 0.68, 0.8) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.dripMesh = new THREE.Mesh(g, this.dripMat);
    this.dripMesh.name = 'weather.drip';
    this.dripMesh.frustumCulled = false;
    this.dripMesh.renderOrder = 3008;
    this.dripMesh.userData.noShelter = true;
    this.dripMesh.visible = false;
    this.group.add(this.dripMesh);
  }

  /* ───────────────────────────────────────────────────────────────── update */

  /**
   * @param {number} dt
   * @param {{rain:number, wetness:number, rainSpeed:number, tint:number[],
   *          wind:THREE.Vector3, sunColor:THREE.Color, sunIntensity:number,
   *          time:number, camera:THREE.Camera}} s
   */
  update(dt, s) {
    if (!this._built) return;
    const t = s.time;
    const rain = clamp(s.rain, 0, 1);
    this.intensity = rain;
    const on = this.enabled && rain > 0.004;

    if (this.rainMesh) {
      this.rainMesh.visible = on;
      if (on) {
        const u = this.rainMat.uniforms;
        u.uTime.value = t;
        const box = u.uBox.value;
        const p = s.camera.position;
        // 2.5 m of headroom below the eye covers the ground under your feet; the rest
        // of the column goes upward, where the rain you can actually see is.
        u.uAnchor.value.set(p.x, p.y + box.y - 2.5, p.z);
        // Wind shear tilts the fall vector; heavier rain falls faster and straighter.
        const fall = -(s.rainSpeed * (0.75 + 0.45 * rain));
        u.uVel.value.set(s.wind.x * 0.62, fall, s.wind.z * 0.62);
        u.uIntensity.value = rain;
        // Big drops in a downpour, a fine mist in a drizzle.
        u.uWidth.value = 0.011 + 0.013 * rain;
        u.uStretch.value = 0.030 + 0.038 * rain;
        u.uOpacity.value = 0.16 + 0.55 * rain;
        u.uColor.value.setRGB(s.tint[0], s.tint[1], s.tint[2]);
        // The rain lights up when the sun is behind it and goes flat under cloud.
        const k = clamp(s.sunIntensity * 0.06, 0, 1.2);
        u.uSunColor.value.copy(s.sunColor).multiplyScalar(k);
      }
    }

    if (this.splashMesh) {
      this.splashMesh.visible = on;
      this.splashMat.uniforms.uTime.value = t;
      this.splashMat.uniforms.uOpacity.value = 0.25 + 0.5 * rain;
      if (on) this._spawnSplashes(dt, rain, t, s.camera);
    }

    if (this.rippleMesh) {
      const wet = clamp(s.wetness, 0, 1);
      const rippleOn = on && wet > 0.25;
      this.rippleMesh.visible = rippleOn;
      this.rippleMat.uniforms.uTime.value = t;
      this.rippleMat.uniforms.uOpacity.value = 0.14 + 0.34 * rain * wet;
      if (rippleOn) this._spawnRipples(dt, rain * wet, t, s.camera);
    }

    if (this.dripMesh) {
      // Roofs keep dripping for a while after the rain stops — that is most of
      // what makes a shower feel like it happened.
      const drip = clamp(Math.max(rain, (s.wetness - 0.35) * 1.3), 0, 1);
      this.dripMesh.visible = drip > 0.02;
      const u = this.dripMat.uniforms;
      u.uTime.value = t;
      u.uIntensity.value = drip;
      u.uRate.value = 0.35 + 1.5 * drip;
    }
  }

  /** Land drops on whatever the sky can actually see at (x,z). */
  _spawnSplashes(dt, rain, now, camera) {
    const shelter = this.shelter;
    const n = this.budget.splash;
    if (!n) return;
    const rng = this.ctx.rng || Math.random;
    this._splashDebt += dt * (18 + 190 * rain * rain);
    let budget = Math.min(this._splashDebt | 0, 24);
    this._splashDebt -= budget;

    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;

    let guard = budget * 3;
    while (budget > 0 && guard-- > 0) {
      // Denser near the camera, where a splash is actually resolvable.
      const r = 1.2 + 13.0 * rng() * rng();
      const a = rng() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const top = shelter?.ready ? shelter.topAt(x, z) : cy - 1.7;
      if (top === null || top === undefined) continue;
      // A surface above head height is a roof, not a floor we can see water hit.
      if (top > cy + 1.2 || top < cy - 14) continue;
      budget--;
      const i = this._splashCursor;
      this._splashCursor = (this._splashCursor + 1) % n;
      this.splashOrigin[i * 3 + 0] = x;
      this.splashOrigin[i * 3 + 1] = top + 0.012;
      this.splashOrigin[i * 3 + 2] = z;
      this.splashData[i * 4 + 0] = now;
      this.splashData[i * 4 + 1] = 0.16 + 0.13 * rng();
      this.splashData[i * 4 + 2] = 0.045 + 0.075 * rng() * (0.6 + 0.7 * rain);
      this.splashData[i * 4 + 3] = rng();
    }
    this.splashOriginAttr.needsUpdate = true;
    this.splashDataAttr.needsUpdate = true;
  }

  /** Rings only where the bake said water pools: low, flat, open ground. */
  _spawnRipples(dt, amount, now, camera) {
    const cells = this.shelter?.puddleCells;
    const n = this.budget.ripple;
    if (!n || !cells || !cells.length) return;
    const rng = this.ctx.rng || Math.random;
    this._rippleDebt += dt * (6 + 70 * amount);
    let budget = Math.min(this._rippleDebt | 0, 10);
    this._rippleDebt -= budget;

    const cx = camera.position.x;
    const cz = camera.position.z;
    let guard = budget * 4;
    while (budget > 0 && guard-- > 0) {
      const c = cells[(rng() * cells.length) | 0];
      if (!c) break;
      const dx = c.x - cx;
      const dz = c.z - cz;
      if (dx * dx + dz * dz > 400) continue; // 20 m
      budget--;
      const i = this._rippleCursor;
      this._rippleCursor = (this._rippleCursor + 1) % n;
      this.rippleOrigin[i * 3 + 0] = c.x + (rng() - 0.5) * 1.4;
      this.rippleOrigin[i * 3 + 1] = c.y + 0.006;
      this.rippleOrigin[i * 3 + 2] = c.z + (rng() - 0.5) * 1.4;
      this.rippleData[i * 4 + 0] = now;
      this.rippleData[i * 4 + 1] = 0.55 + 0.5 * rng();
      this.rippleData[i * 4 + 2] = 0.22 + 0.34 * rng();
      this.rippleData[i * 4 + 3] = rng();
    }
    this.rippleOriginAttr.needsUpdate = true;
    this.rippleDataAttr.needsUpdate = true;
  }

  /* ──────────────────────────────────────────────────────────────── teardown */

  dispose(full = true) {
    for (const m of [this.rainMesh, this.splashMesh, this.rippleMesh, this.dripMesh]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.rainMesh = this.splashMesh = this.rippleMesh = this.dripMesh = null;
    this.rainMat = this.splashMat = this.rippleMat = this.dripMat = null;
    this._built = false;
    void full;
  }
}

export default Precipitation;
