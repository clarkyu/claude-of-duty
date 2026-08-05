/**
 * weather/Atmospherics.js — the air itself: motes, grit, ground mist and litter.
 * Owner: weather agent. Files owned: src/render/Weather.js, src/render/weather/**.
 *
 *   motes   fine domestic dust, slow, tiny. Almost invisible until it crosses a sun
 *           shaft, so the shader marches the shelter map towards the sun and lifts
 *           anything that is lit — that plus strong forward scattering is what makes
 *           a shaft of light read as a shaft rather than a gradient.
 *   grit    the same shader with the dial at the other end: big, fast, wind-driven
 *           particulate for the dust storm, with the sun contribution flattened
 *           because in a haboob there is no directional light left to catch.
 *   mist    cylindrical billboards that sit on the ground height field, so the layer
 *           follows dips and hollows instead of being a flat slab at y = 0.
 *   litter  paper and leaves tumbling along the ground, spinning about the wind axis,
 *           hopping harder as the wind picks up.
 *
 * All four wrap inside a box that follows the camera, so density is constant wherever
 * you stand and nothing is ever simulated where it cannot be seen.
 */
import * as THREE from 'three';
import { MOTE_VERT, MOTE_FRAG, LITTER_VERT, LITTER_FRAG, MIST_VERT, MIST_FRAG } from './shaders.js';
import { instancedQuad } from './Precipitation.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Atmospherics {
  /**
   * @param {object} ctx
   * @param {import('./ShelterMap.js').ShelterMap} shelter
   */
  constructor(ctx, shelter) {
    this.ctx = ctx;
    this.shelter = shelter;
    this.group = new THREE.Group();
    this.group.name = 'weather.atmospherics';
    this.group.userData.noShelter = true;
    this.group.renderOrder = 2900;
    this.budget = { motes: 0, grit: 0, mist: 0, litter: 0 };
    this._built = false;
  }

  build(budget) {
    this.budget = budget;
    this.dispose();
    this.motes = this._buildMotes(budget.motes, 'motes', {
      box: [22, 9, 22],
      size: 0.022,
      jitter: [0.4, 0.25],
      shaftBoost: 5.5,
      indoorFloor: 0.22,
      color: [0.72, 0.68, 0.6],
      opacity: 0.5,
      renderOrder: 2905,
    });
    this.grit = this._buildMotes(budget.grit, 'grit', {
      // Tighter than the motes on purpose: the same instance count in a smaller
      // volume is what makes a dust storm read as dense rather than speckled, and
      // beyond ~20 m the aerial perspective has swallowed everything anyway.
      box: [21, 12, 21],
      size: 0.10,
      jitter: [1.5, 0.9],
      shaftBoost: 0.6,
      indoorFloor: 0.65,
      color: [0.60, 0.42, 0.26],
      opacity: 0.34,
      renderOrder: 2910,
    });
    this.mist = this._buildMist(budget.mist);
    this.litter = this._buildLitter(budget.litter);
    this.attachShelter();
    this._built = true;
  }

  /** Re-point the shelter / ground textures after a (re)bake. */
  attachShelter() {
    const s = this.shelter;
    const shelterTex = s?.ready ? s.texture : null;
    const groundTex = s?.ready ? s.groundTexture : null;
    for (const m of [this.motes, this.grit]) {
      const u = m?.material?.uniforms;
      if (!u) continue;
      u.uShelter.value = shelterTex;
      u.uHasShelter.value = shelterTex ? 1 : 0;
      if (s?.rect) u.uShelterRect.value.copy(s.rect);
    }
    for (const m of [this.mist, this.litter]) {
      const u = m?.material?.uniforms;
      if (!u) continue;
      u.uGround.value = groundTex;
      u.uHasGround.value = groundTex ? 1 : 0;
      if (s?.rect) u.uGroundRect.value.copy(s.rect);
    }
  }

  _buildMotes(count, name, opt) {
    if (count <= 0) return null;
    const rng = this.ctx.rng || Math.random;
    const seed = new Float32Array(count * 4);
    const param = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      seed[i * 4 + 0] = rng();
      seed[i * 4 + 1] = rng();
      seed[i * 4 + 2] = rng();
      seed[i * 4 + 3] = rng();
      param[i * 2 + 0] = rng();
      param[i * 2 + 1] = rng();
    }
    const g = instancedQuad(count);
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.setAttribute('aParam', new THREE.InstancedBufferAttribute(param, 2));

    const mat = new THREE.ShaderMaterial({
      name: `weather:${name}`,
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAnchor: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(...opt.box) },
        uDrift: { value: new THREE.Vector3(0.05, -0.01, 0.03) },
        uJitter: { value: new THREE.Vector2(...opt.jitter) },
        uSize: { value: opt.size },
        uIntensity: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uShaftBoost: { value: opt.shaftBoost },
        uIndoorFloor: { value: opt.indoorFloor },
        uColor: { value: new THREE.Color(...opt.color) },
        uOpacity: { value: opt.opacity },
        uShelter: { value: null },
        uShelterRect: { value: new THREE.Vector4(-64, 60, 1 / 128, -1 / 118) },
        uHasShelter: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `weather.${name}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = opt.renderOrder;
    mesh.userData.noShelter = true;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  _buildMist(count) {
    if (count <= 0) return null;
    const rng = this.ctx.rng || Math.random;
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seed[i * 4 + 0] = rng();
      seed[i * 4 + 1] = rng();
      seed[i * 4 + 2] = rng();
      seed[i * 4 + 3] = rng();
    }
    const g = instancedQuad(count);
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));

    const mat = new THREE.ShaderMaterial({
      name: 'weather:mist',
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAnchor: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(30, 3, 30) },
        uWind: { value: new THREE.Vector3() },
        uSize: { value: 7.5 },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(0.62, 0.66, 0.72) },
        uOpacity: { value: 0.09 },
        uGround: { value: null },
        uGroundRect: { value: new THREE.Vector4(-64, 60, 1 / 128, -1 / 118) },
        uHasGround: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'weather.mist';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2880;
    mesh.userData.noShelter = true;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  _buildLitter(count) {
    if (count <= 0) return null;
    const rng = this.ctx.rng || Math.random;
    const seed = new Float32Array(count * 4);
    const param = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      seed[i * 4 + 0] = rng(); // home x
      seed[i * 4 + 1] = rng() < 0.45 ? 1 : 0; // 0 = paper, 1 = leaf
      seed[i * 4 + 2] = rng(); // home z
      seed[i * 4 + 3] = rng(); // phase / speed
      param[i * 2 + 0] = rng();
      param[i * 2 + 1] = rng();
    }
    const g = instancedQuad(count);
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.setAttribute('aParam', new THREE.InstancedBufferAttribute(param, 2));

    const mat = new THREE.ShaderMaterial({
      name: 'weather:litter',
      vertexShader: LITTER_VERT,
      fragmentShader: LITTER_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAnchor: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector2(18, 18) },
        uWind: { value: new THREE.Vector3() },
        uIntensity: { value: 0 },
        uSize: { value: 0.09 },
        uPaper: { value: new THREE.Color(0.52, 0.50, 0.46) },
        uLeaf: { value: new THREE.Color(0.30, 0.22, 0.10) },
        uOpacity: { value: 0.9 },
        uGround: { value: null },
        uGroundRect: { value: new THREE.Vector4(-64, 60, 1 / 128, -1 / 118) },
        uHasGround: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'weather.litter';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2895;
    mesh.userData.noShelter = true;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * @param {number} dt
   * @param {{motes:number, moteSize:number, grit:number, mistParticles:number,
   *          litter:number, wind:THREE.Vector3, sunDir:THREE.Vector3,
   *          sunColor:THREE.Color, sunIntensity:number, fogColor:number[],
   *          wetness:number, time:number, camera:THREE.Camera}} s
   */
  update(dt, s) {
    if (!this._built) return;
    const t = s.time;
    const cam = s.camera.position;

    if (this.motes) {
      const a = clamp(s.motes, 0, 1);
      this.motes.visible = a > 0.01;
      if (this.motes.visible) {
        const u = this.motes.material.uniforms;
        u.uTime.value = t;
        u.uAnchor.value.copy(cam);
        u.uIntensity.value = a;
        u.uSize.value = s.moteSize;
        u.uSunDir.value.copy(s.sunDir);
        // Household dust barely moves: a tenth of the wind plus a slow settle.
        u.uDrift.value.set(s.wind.x * 0.10, -0.014, s.wind.z * 0.10);
        // Motes are lit by the sun, so they must dim with it or they glow at night.
        const k = clamp(0.25 + s.sunIntensity * 0.075, 0.12, 1.35);
        u.uColor.value.copy(s.sunColor).lerp(WHITE, 0.35).multiplyScalar(k);
      }
    }

    if (this.grit) {
      const a = clamp(s.grit, 0, 1);
      this.grit.visible = a > 0.01;
      if (this.grit.visible) {
        const u = this.grit.material.uniforms;
        u.uTime.value = t;
        u.uAnchor.value.copy(cam);
        u.uIntensity.value = a;
        u.uSunDir.value.copy(s.sunDir);
        // Grit is carried, not suspended: it travels at most of the wind speed.
        u.uDrift.value.set(s.wind.x * 0.85, -0.35 - 0.4 * a, s.wind.z * 0.85);
        u.uJitter.value.set(0.6 + 1.6 * a, 0.5 + 0.7 * a);
        u.uSize.value = 0.07 + 0.16 * a;
        u.uOpacity.value = 0.10 + 0.34 * a;
        u.uColor.value.setRGB(s.fogColor[0], s.fogColor[1], s.fogColor[2]).multiplyScalar(0.85);
      }
    }

    if (this.mist) {
      const a = clamp(s.mistParticles, 0, 1);
      this.mist.visible = a > 0.01;
      if (this.mist.visible) {
        const u = this.mist.material.uniforms;
        u.uTime.value = t;
        u.uAnchor.value.copy(cam);
        u.uWind.value.copy(s.wind);
        u.uIntensity.value = a;
        u.uOpacity.value = 0.035 + 0.085 * a;
        u.uColor.value.setRGB(s.fogColor[0], s.fogColor[1], s.fogColor[2]);
      }
    }

    if (this.litter) {
      const a = clamp(s.litter, 0, 1) * clamp(1 - s.wetness * 0.75, 0.1, 1);
      this.litter.visible = a > 0.01;
      if (this.litter.visible) {
        const u = this.litter.material.uniforms;
        u.uTime.value = t;
        u.uAnchor.value.copy(cam);
        u.uWind.value.copy(s.wind);
        u.uIntensity.value = a;
        u.uSize.value = 0.07 + 0.06 * a;
        // Litter is lit by the same key as everything else; keep it in the frame's
        // exposure range rather than at a fixed albedo.
        const k = clamp(0.18 + s.sunIntensity * 0.055, 0.08, 1.1);
        u.uPaper.value.setRGB(0.62, 0.60, 0.55).multiplyScalar(k);
        u.uLeaf.value.setRGB(0.40, 0.28, 0.13).multiplyScalar(k);
      }
    }
  }

  dispose() {
    for (const m of [this.motes, this.grit, this.mist, this.litter]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.motes = this.grit = this.mist = this.litter = null;
    this._built = false;
  }
}

const WHITE = new THREE.Color(1, 1, 1);

export default Atmospherics;
