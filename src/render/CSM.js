/**
 * CSM — cascaded shadow maps for the key light (sun / moon).
 * Owner: lighting agent. Files owned: render/Lighting.js, render/CSM.js, render/ProbeSystem.js.
 *
 * This is a real CSM, not N directional lights stacked on top of each other:
 *
 *   • practical split scheme — a logarithmic/uniform blend (Zhang et al.), `lambda`
 *     controls the mix. Near cascades get the texels, far cascades get the range.
 *   • stabilised cascades — every slice is fitted to a **tight light-space box** around
 *     its eight frustum corners, whose half extents are quantised to a ladder derived
 *     from the slice's analytic bounding sphere (which depends only on
 *     near/far/fov/aspect), and whose origin is then snapped to whole shadow texels.
 *     The quantisation is what keeps the world-per-texel constant while the camera
 *     turns; without it — or without the snap — the shadow edges crawl and shimmer
 *     whenever the camera moves, which is the single most visible difference between a
 *     good and a bad CSM. Fitting the sphere itself is stable but spends about 60 % of
 *     every cascade's texels on empty space beside the view; see `_fitSlice`.
 *   • per-cascade depth bias + slope-scaled bias in the sampler, plus three's
 *     world-space `normalBias` in the vertex stage. Constant bias alone either
 *     peter-pans or acnes; you need all three terms.
 *   • blend bands — the last ~16% of every cascade cross-fades into the next one, so
 *     the resolution change never appears as a hard line across the floor.
 *   • PCSS — a Vogel-disc blocker search estimates the penumbra from the distance
 *     between blocker and receiver, so contact points stay razor sharp and the far
 *     end of a shadow softens exactly like the real thing. Falls back to fixed-radius
 *     rotated-Poisson PCF on lower tiers.
 *
 * Only cascade 0's light carries radiance; the rest exist purely to own a shadow map
 * and sit at intensity 0. A material that never gets patched therefore still sees
 * exactly one sun with a near-field shadow instead of N suns — the degradation path
 * matters because other agents create materials this module may not have reached yet.
 *
 * Requires `renderer.shadowMap.type = THREE.BasicShadowMap` so the maps stay plain
 * `sampler2D` depth textures. In PCF mode three binds them as `sampler2DShadow`, which
 * only answers comparisons and makes a blocker search impossible.
 *
 * Public API: see class docs. No events.
 */
import * as THREE from 'three';

export const MAX_CASCADES = 4;

const _snapped = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _up = new THREE.Vector3();
const _camPos = new THREE.Vector3();
/** Light-space AABB of the current slice — see `_fitSlice`. */
const _fit = { hx: 1, hy: 1, hz: 1, cx: 0, cy: 0, cz: 0 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Vogel disc: golden-angle spiral. Every prefix of the sequence is still evenly
 * distributed, and the sample count can be tuned per quality tier without
 * regenerating a hand-tuned Poisson set.
 */
function vogelDisc(count) {
  const pts = [];
  const golden = 2.399963229728653;
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt((i + 0.5) / count);
    const t = i * golden;
    pts.push([Math.cos(t) * r, Math.sin(t) * r]);
  }
  return pts;
}

export function glslDisc(name, pts) {
  const body = pts.map(([x, y]) => `vec2( ${x.toFixed(6)}, ${y.toFixed(6)} )`).join(', ');
  return `const vec2 ${name}[ ${pts.length} ] = vec2[ ${pts.length} ]( ${body} );`;
}

export { vogelDisc };

/**
 * Helpers shared by the cascade sampler and the local spot-light sampler. Lighting.js
 * emits this once, unconditionally, before either of them.
 */
// language=GLSL
export const SHADOW_COMMON_GLSL = /* glsl */ `
// Interleaved gradient noise — one rotation per pixel turns shadow banding into
// dither, which TAA then resolves away for free.
float codShadowNoise( vec2 p ) {
	return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

vec2 codRotate( vec2 v, vec2 r ) {
	return vec2( v.x * r.x - v.y * r.y, v.x * r.y + v.y * r.x );
}
`;

export class CascadedShadowMaps {
  /**
   * @param {object} ctx engine service context
   * @param {{cascades?:number, resolution?:number, maxDistance?:number}} [opts]
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;

    this.count = clamp(Math.round(opts.cascades ?? 4), 1, MAX_CASCADES);
    this.resolution = clamp(Math.round(opts.resolution ?? 2048), 256, 4096);
    this.maxDistance = opts.maxDistance ?? 170;
    /**
     * Split-scheme blend: 1 = fully logarithmic, 0 = fully uniform.
     *
     * **0.9 was the whole of the "shadow contrast is unchanged" finding, and adding a
     * fourth cascade made it worse rather than better.** A practical split at lambda 0.9
     * over 0.15-72 m puts the four boundaries at 0.15 / 2.44 / 6.57 / 19.25 / 72, i.e. it
     * spends two of the four cascades on the first six and a half metres — which in a
     * first-person frame is the pavement under your own feet and nothing else — and then
     * asks one cascade to carry 6.6-19.3 m, the band every prop, stall, planter and
     * scaffold in this level actually stands in. Fitted to its bounding sphere at a 78
     * degree FOV that slice is 63.6 m of ortho across 1024 texels: **62 mm per texel**,
     * which is worse than the three-cascade split it replaced (42 mm) and is why the hero
     * scaffold — 76 mm standards, 60 mm ledgers, two metres off a sunlit wall at 11 m —
     * rasterises into 1.2 texels and casts nothing at all.
     *
     * 0.6 re-splits the same range to 0.15 / 7.67 / 16.40 / 30.84 / 72. The prop band
     * lands in cascade 1 at 52.9 mm and everything past 20 m lands in cascade 2 at 99.5
     * instead of the 309.7 the last cascade was giving it. It is strictly better than
     * both previous rounds over 6.6 m out, and the near field it gives up (24.7 mm rather
     * than 7.9) is still four times finer than the 100 mm a contact point needs.
     */
    this.lambda = 0.6;
    /** How far behind the slice the shadow camera pulls back, so off-screen casters still cast. */
    this.extrude = 70;
    /** Fraction of each cascade spent cross-fading into the next. */
    this.blendFraction = 0.16;
    /** Near plane used for the split scheme (the camera's 5 cm near plane is degenerate here). */
    this.shadowNear = 0.15;

    /** tan(angular radius) of the light source — drives PCSS penumbra growth. */
    this.sourceAngle = 0.026;
    this.intensity = 1.0;
    this.enabled = true;

    // Filtering budget, overwritten by setQuality().
    this.pcss = true;
    this.pcfTaps = 12;
    this.blockerTaps = 8;
    this.searchScale = 6.0;
    /**
     * Ceiling on the PCSS filter, in texels.
     *
     * 14 texels is 0.67 m of blur in the mid cascade, which is wider than most of the
     * things this level asks to be legible: a market frame, a railing post, a
     * scaffolding standard. Past a certain width a penumbra stops reading as "this
     * shadow's far end is soft" and starts reading as "there is a vague dark region
     * here", and the review's note that the plaza has light/shade *areas* instead of
     * shadow *bars* is exactly that failure. 9 texels keeps the contact-to-tip ramp
     * PCSS exists for and stops the tip dissolving.
     */
    /*
     * Trimmed again to 6 once the cascade texels were measured in-engine: in the band
     * the props stand in (3.5-13 m) a texel is 21 mm with four cascades, so nine of them
     * is a 19 cm penumbra on a 0.6 m barrel — wider than the thing casting it. Six is
     * 13 cm, which still opens visibly along a two-metre shadow and leaves the contact
     * point hard. The base radius comes down with it: 1.1 texels of *unconditional*
     * blur was ten screen pixels of softness on every contact point in the near field.
     */
    this.maxRadiusTexels = 6.0;
    this.baseRadiusTexels = 0.85;

    this.direction = new THREE.Vector3(0.35, 0.72, 0.6).normalize();
    this.color = new THREE.Color(1, 1, 1);
    this.lightIntensity = 8;

    this.group = new THREE.Group();
    this.group.name = 'lighting.csm';
    this.group.matrixAutoUpdate = false;

    /** @type {THREE.DirectionalLight[]} */
    this.lights = [];
    /** Bumped whenever the generated GLSL changes; feeds the program cache key. */
    this.version = 0;

    this.uniforms = {
      uCsmSplits: { value: [] },
      uCsmParams: { value: [] },
      uCsmControl: { value: new THREE.Vector4(120, 165, 1, 1) },
      /**
       * Per-frame rotation offset for the PCF disc. Without it the disc rotation is a
       * pure function of `gl_FragCoord`, so the dither pattern is *identical* every
       * frame — TAA averages a constant and the noise survives every amount of warm-up.
       * Advancing it on a golden-ratio sequence turns the same taps into a temporal
       * multisample that TAA actually resolves.
       */
      uCsmJitter: { value: 0 },
    };

    this._splits = [];
    this._staggerPhase = 0;
    this.stagger = 0; // 0 = every cascade every frame

    this._buildLights();
  }

  /* ─────────────────────────────────────────────────────────────────── lights */

  /**
   * Texels for cascade `i`. The last cascade covers 30x the area of the near ones and
   * resolves nothing legible at any resolution, so it never grows past 768 — which is
   * what makes raising the near cascades to 1536 affordable. Only the *last* one is
   * shrunk: with 4 cascades the third is still doing mid-field work.
   */
  _mapSizeFor(i, res) {
    if (i < Math.max(2, this.count - 1)) return res;
    // Three quarters, and never more than 1024: past ~200 m of ortho the last cascade
    // resolves nothing legible however many texels it gets, so the ceiling is free
    // detail everywhere else. (Half was tried and put the headless far cascade on
    // 46 cm texels, which loses building shadows that 31 cm still carries.)
    return Math.max(512, Math.min(1024, Math.round(res * 0.75)));
  }

  _buildLights() {
    this._disposeLights();
    const res = this.resolution;
    for (let i = 0; i < this.count; i++) {
      const light = new THREE.DirectionalLight(0xffffff, i === 0 ? this.lightIntensity : 0);
      light.name = `csm.cascade${i}`;
      light.castShadow = true;
      light.frustumCulled = false;
      const r = this._mapSizeFor(i, res);
      light.shadow.mapSize.set(r, r);
      light.shadow.camera.near = 0.05;
      light.shadow.camera.far = 400;
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 0.02;
      light.shadow.intensity = 1;
      light.shadow.autoUpdate = true;
      light.target.name = `csm.cascade${i}.target`;
      this.group.add(light);
      this.group.add(light.target);
      this.lights.push(light);
    }

    const splits = [];
    const params = [];
    for (let i = 0; i < this.count; i++) {
      splits.push(new THREE.Vector4(0, 1, 1, 1 / res));
      params.push(new THREE.Vector4(0.0005, 0.002, 200, 40));
    }
    this.uniforms.uCsmSplits.value = splits;
    this.uniforms.uCsmParams.value = params;
    this.version++;
  }

  _disposeLights() {
    for (const light of this.lights) {
      light.shadow?.map?.depthTexture?.dispose?.();
      light.shadow?.map?.dispose?.();
      light.shadow?.dispose?.();
      this.group.remove(light.target);
      this.group.remove(light);
    }
    this.lights.length = 0;
  }

  attach(scene) {
    if (scene && this.group.parent !== scene) scene.add(this.group);
  }

  detach() {
    this.group.parent?.remove(this.group);
  }

  /* ──────────────────────────────────────────────────────────────── settings */

  setCascadeCount(n) {
    const c = clamp(Math.round(n), 1, MAX_CASCADES);
    if (c === this.count) return false;
    this.count = c;
    this._buildLights();
    return true;
  }

  setResolution(px) {
    const r = clamp(Math.round(px), 256, 4096);
    if (r === this.resolution) return false;
    this.resolution = r;
    // mapSize can only change before the map is allocated, so tear them down.
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const size = this._mapSizeFor(i, r);
      light.shadow.mapSize.set(size, size);
      light.shadow.map?.depthTexture?.dispose?.();
      light.shadow.map?.dispose?.();
      light.shadow.map = null;
    }
    return false; // no shader change: texel size travels through a uniform
  }

  /**
   * @param {'low'|'medium'|'high'|'ultra'} tier
   * @param {boolean} headless CI runs on a software rasteriser — keep the tap count sane.
   */
  setQuality(tier, headless) {
    const before = `${this.pcss}|${this.pcfTaps}|${this.blockerTaps}`;
    if (headless) {
      /**
       * **PCSS stays on here.** This branch and the medium tier are the two configs
       * the review captures actually run in, and turning the blocker search off in
       * exactly those two meant every shadow anyone ever looked at was a fixed-radius
       * blur: identical density and identical edge softness at the contact point and
       * two metres out, which is the single tell that separates a shadow from a decal.
       * It also silently discarded the horizon-widened source angle Lighting.js goes
       * to the trouble of computing (`setSoftness`, 0.0047 -> 0.02 rad at a low sun).
       *
       * A 6-tap PCF fed by a real 6-tap blocker search costs 12 texture reads against
       * the old 8 and buys contact hardening — the shadow is razor sharp where the
       * caster touches the ground and opens up along its length, which is exactly the
       * cue "is this object standing on the floor" is read from.
       */
      this.pcss = true;
      this.pcfTaps = 6;
      this.blockerTaps = 6;
      this.stagger = 1;
    } else {
      this.stagger = 0;
      switch (tier) {
        case 'low':
          this.pcss = false;
          this.pcfTaps = 6;
          this.blockerTaps = 4;
          break;
        case 'medium':
          this.pcss = true;
          this.pcfTaps = 8;
          this.blockerTaps = 6;
          break;
        case 'ultra':
          this.pcss = true;
          this.pcfTaps = 20;
          this.blockerTaps = 12;
          break;
        default:
          this.pcss = true;
          this.pcfTaps = 12;
          this.blockerTaps = 8;
          break;
      }
    }
    // Shadow range is a resolution budget, not a view distance. Every metre added to
    // the last cascade grows its texels, and coarse texels need bias, and bias eats
    // shadows. 120 m of crisp cascades beats 200 m of mush.
    switch (tier) {
      case 'low':
        this.maxDistance = 55;
        break;
      case 'medium':
        this.maxDistance = 85;
        break;
      case 'ultra':
        this.maxDistance = 165;
        break;
      default:
        this.maxDistance = 120;
        break;
    }
    /**
     * Headless caps the range harder than the tier asks for, and that *buys* shadow
     * detail rather than costing it. The last cascade's texels are (2 · 1.65 · far) /
     * mapSize, so at 90 m and a 78 deg FOV the far slice lands on 37 cm texels — a
     * railing is 4 cm, a market frame 8, a scaffolding standard 10, and none of them
     * survive rasterisation at that footprint. That is why the plaza had broad
     * light/shade regions and no shadow bars. 72 m puts the same slice at 23 cm and
     * pulls the mid cascade from 4.8 to 4.1 cm, which is where the legible casters are;
     * the cascade fade already starts at 0.82·far, so nothing pops.
     */
    if (headless) this.maxDistance = Math.min(this.maxDistance, 72);
    const changed = before !== `${this.pcss}|${this.pcfTaps}|${this.blockerTaps}`;
    if (changed) this.version++;
    return changed;
  }

  /**
   * @param {THREE.Vector3} dirToLight world-space direction *towards* the light
   * @param {THREE.Color} color linear
   * @param {number} intensity
   */
  setKeyLight(dirToLight, color, intensity) {
    if (dirToLight && dirToLight.lengthSq() > 1e-8) this.direction.copy(dirToLight).normalize();
    if (color) this.color.copy(color);
    if (Number.isFinite(intensity)) this.lightIntensity = Math.max(0, intensity);
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      light.color.copy(this.color);
      // Only the first slot carries radiance — see the file header.
      light.intensity = i === 0 ? this.lightIntensity : 0;
    }
  }

  /** Angular radius of the source in radians; larger = softer penumbrae. */
  setSoftness(angularRadius) {
    this.sourceAngle = Math.max(0.0008, angularRadius);
  }

  /* ──────────────────────────────────────────────────────────────── fitting */

  _computeSplits(camera) {
    const near = Math.max(this.shadowNear, camera.near);
    const far = Math.max(near + 1, Math.min(this.maxDistance, camera.far));
    const n = this.count;
    const out = this._splits;
    out.length = n + 1;
    out[0] = near;
    out[n] = far;
    for (let i = 1; i < n; i++) {
      const p = i / n;
      const log = near * Math.pow(far / near, p);
      const uni = near + (far - near) * p;
      out[i] = this.lambda * log + (1 - this.lambda) * uni;
    }
    return out;
  }

  /**
   * Analytic bounding sphere of the frustum slice [n, f]. Depends only on the
   * projection, never on where the camera is looking — which is precisely what makes
   * the cascade stable.
   * @returns {{ centerZ:number, radius:number }}
   */
  _sliceSphere(camera, n, f) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * (camera.aspect || 1.7777);
    const k2 = tanH * tanH + tanV * tanV;
    // When the frustum is wide relative to its length the sphere through both rims
    // would sit past the far plane and be needlessly large; the far cap bounds the
    // whole slice on its own. (k2 >= (f - n) / (f + n), rearranged to avoid a divide.)
    if (k2 * (f + n) >= f - n) {
      return { centerZ: f, radius: f * Math.sqrt(k2) };
    }
    const centerZ = 0.5 * (f + n) * (1 + k2);
    const dz = f - n;
    const sz = f + n;
    const radius = 0.5 * Math.sqrt(dz * dz + 2 * (f * f + n * n) * k2 + sz * sz * k2 * k2);
    return { centerZ, radius };
  }

  /**
   * **A tight light-space box instead of the slice's bounding sphere.**
   *
   * The sphere fit is stable because it depends only on the projection — but it is
   * enormous, because it is dominated by the far cap: for a slice [n, f] at a 78 degree
   * FOV the radius is `f · sqrt(tanH² + tanV²)` = 1.65 f whatever the slice's *length*.
   * Cascade 1 of a lambda-0.6 split is 8.7 m long and gets a 54 m box. The frustum slice
   * projected onto the light's own x/y plane is about 34 x 35 m of that, so roughly 60 %
   * of every cascade's texels are spent on empty space beside the view.
   *
   * Fitting the eight corners directly is exact and — this is the part that is easy to
   * get wrong — it is also **conservative for casters**. A shadow travels along the light
   * direction, which is precisely the box's z axis, so anything that can darken a pixel
   * inside the box shares that pixel's (x, y) and is inside the box's cross-section by
   * construction. Only the depth range has to be extended, which `extrude` already does.
   *
   * The one thing it costs is rotation invariance: the box breathes as the camera turns,
   * and a shadow map whose world-per-texel changes every frame crawls. So the half
   * extents are **quantised** to a fixed ladder derived from the (rotation-invariant)
   * sphere radius. Between steps the size is constant and the existing texel snap holds
   * the shadow perfectly still; a step changes the footprint by at most 1/48, which is a
   * sub-texel shift that TAA resolves in a frame.
   *
   * Writes `_fit` in light space (x along `_xAxis`, y along `_yAxis`, z along `dir`).
   */
  _fitSlice(camera, n, f, radius, dir) {
    const e = camera.matrixWorld.elements;
    _right.set(e[0], e[1], e[2]).normalize();
    _camUp.set(e[4], e[5], e[6]).normalize();

    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanH = tanV * (camera.aspect || 1.7777);

    // Project the camera basis onto the light basis once, then every corner is a
    // three-term dot product instead of a matrix transform.
    const fx = _forward.dot(_xAxis);
    const fy = _forward.dot(_yAxis);
    const fz = _forward.dot(dir);
    const rx = _right.dot(_xAxis);
    const ry = _right.dot(_yAxis);
    const rz = _right.dot(dir);
    const ux = _camUp.dot(_xAxis);
    const uy = _camUp.dot(_yAxis);
    const uz = _camUp.dot(dir);
    const ox = _camPos.dot(_xAxis);
    const oy = _camPos.dot(_yAxis);
    const oz = _camPos.dot(dir);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let c = 0; c < 8; c++) {
      const z = c & 1 ? f : n;
      const sh = c & 2 ? tanH * z : -tanH * z;
      const sv = c & 4 ? tanV * z : -tanV * z;
      const x = ox + fx * z + rx * sh + ux * sv;
      const y = oy + fy * z + ry * sh + uy * sv;
      const d = oz + fz * z + rz * sh + uz * sv;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (d < minZ) minZ = d;
      if (d > maxZ) maxZ = d;
    }

    // Quantise the half-extents so the world-per-texel only ever changes in steps.
    const step = Math.max(radius / 48, 1e-3);
    const quant = (h) => {
      const q = Math.ceil((h * 1.02 + step) / step) * step;
      return clamp(q, radius * 0.18, radius);
    };
    const hx = quant((maxX - minX) * 0.5);
    const hy = quant((maxY - minY) * 0.5);
    const hz = Math.max((maxZ - minZ) * 0.5, 0.5);

    if (!Number.isFinite(hx) || !Number.isFinite(hy) || !Number.isFinite(hz)) {
      _fit.hx = _fit.hy = _fit.hz = radius;
      _fit.cx = ox;
      _fit.cy = oy;
      _fit.cz = oz;
      return _fit;
    }
    _fit.hx = hx;
    _fit.hy = hy;
    _fit.hz = hz;
    _fit.cx = (minX + maxX) * 0.5;
    _fit.cy = (minY + maxY) * 0.5;
    _fit.cz = (minZ + maxZ) * 0.5;
    return _fit;
  }

  /** Fit + stabilise every cascade against the current camera. Call once per frame. */
  update(camera) {
    if (!camera || !this.lights.length) return;
    const splits = this._computeSplits(camera);
    const dir = this.direction;

    camera.updateMatrixWorld();
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    _forward.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

    // Matching three's Object3D.lookAt() basis exactly: the snap only stabilises the
    // shadow if it is quantised in the same frame the shadow camera ends up in.
    _up.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.995) _up.set(0, 0, 1);
    _xAxis.crossVectors(_up, dir).normalize();
    _yAxis.crossVectors(dir, _xAxis).normalize();

    this._staggerPhase++;

    for (let i = 0; i < this.count; i++) {
      const light = this.lights[i];
      const n = splits[i];
      const f = splits[i + 1];
      // The sphere no longer sets the ortho — it is only kept as the rotation-invariant
      // scale the tight box's quantisation ladder is derived from.
      const { radius } = this._sliceSphere(camera, n, f);

      const mapSize = light.shadow.mapSize.x;
      const fit = this._fitSlice(camera, n, f, radius, dir);
      const texelX = (2 * fit.hx) / mapSize;
      const texelY = (2 * fit.hy) / mapSize;
      // Bias and PCSS both want a single number; the coarser axis is the safe one.
      const texelWorld = Math.max(texelX, texelY);

      // Snap the box centre to the shadow texel grid, in the light's own basis.
      const cx = Math.floor(fit.cx / texelX) * texelX;
      const cy = Math.floor(fit.cy / texelY) * texelY;
      const cz = fit.cz;
      _snapped
        .copy(_xAxis)
        .multiplyScalar(cx)
        .addScaledVector(_yAxis, cy)
        .addScaledVector(dir, cz);

      const back = fit.hz + this.extrude;
      light.position.copy(_snapped).addScaledVector(dir, back);
      light.target.position.copy(_snapped);
      light.shadow.camera.up.copy(_up);

      const cam = light.shadow.camera;
      cam.left = -fit.hx;
      cam.right = fit.hx;
      cam.top = fit.hy;
      cam.bottom = -fit.hy;
      cam.near = 0.05;
      cam.far = back + fit.hz + 1;
      cam.updateProjectionMatrix();

      const depthRange = cam.far - cam.near;
      /**
       * Bias budget. Every metre of bias — depth or normal offset — costs
       * `bias / sin(sun elevation)` metres of shadow length, so at an 8-degree
       * sunrise a "safe" 0.5 m of slope bias silently deletes 3.5 m of shadow and
       * the scene looks like nothing casts at all. Keep all three terms small and
       * absolutely capped, and let the far cascades acne very slightly rather than
       * lose their shadows: at 0.3 m texels nobody can see the acne anyway.
       *
       * The three terms are not independent, which is how peter-panning survives a
       * per-term audit: the constant, the slope term *and* three's world-space normal
       * offset all push the same comparison the same way, and at a 13 deg sun their
       * sum divides by sin(13 deg) = 0.22 — a 4.5x lever on the gap between an object
       * and where its shadow starts. Detaching the normal offset from the full texel
       * (1.0 -> 0.6) and trimming the constant's texel share is worth a little acne on
       * the far cascades, and PCSS then hardens the near contact back to a sharp line.
       */
      const constWorld = 0.006 + texelWorld * 0.25;
      const slopeWorld = texelWorld * 0.5;
      light.shadow.bias = -constWorld / depthRange;
      light.shadow.normalBias = Math.min(texelWorld * 0.6, 0.14);

      const blendStart = f - (f - n) * this.blendFraction;
      const s = this.uniforms.uCsmSplits.value[i];
      s.set(n, f, blendStart, 1 / mapSize);
      const p = this.uniforms.uCsmParams.value[i];
      // w is the world size one full unit of shadow-map UV spans, which the PCSS step
      // divides a world-space penumbra by. The box is rectangular now, so hand over the
      // mean of the two axes — the residual anisotropy is under 10 % in practice.
      p.set(constWorld / depthRange, slopeWorld / depthRange, depthRange, fit.hx + fit.hy);

      // Far cascades change slowly; refreshing them every other frame halves the
      // shadow cost on the software rasteriser with no visible difference.
      if (this.stagger > 0 && i >= 2) {
        const period = i;
        const due = this._staggerPhase % period === 0;
        light.shadow.autoUpdate = false;
        light.shadow.needsUpdate = due;
      } else {
        light.shadow.autoUpdate = true;
      }
    }

    // Golden-ratio rotation sequence: successive frames land far apart on the circle,
    // so a handful of frames of TAA sees a well-spread set of PCF orientations.
    this.uniforms.uCsmJitter.value = (this._staggerPhase * 0.61803398875) % 1;

    const far = splits[this.count];
    this.uniforms.uCsmControl.value.set(
      far * 0.82,
      far,
      Math.max(this.sourceAngle, 0.0008),
      this.enabled ? this.intensity : 0
    );
  }

  /* ─────────────────────────────────────────────────────────────────── GLSL */

  /** Fragment-stage declarations + the cascade samplers. Insert before `void main`. */
  parsGLSL() {
    const n = this.count;
    const pcfPts = vogelDisc(this.pcfTaps);
    const blkPts = vogelDisc(this.blockerTaps);

    let out = `
// ── cascaded shadow maps ─────────────────────────────────────────────────────
// SHADOWMAP_TYPE_BASIC is required: it is the only mode in which three binds the
// shadow maps as plain sampler2D, and a blocker search needs the raw depth back.
#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_BASIC ) && ( NUM_DIR_LIGHT_SHADOWS >= ${n} )
#define COD_CSM 1

uniform vec4 uCsmSplits[ ${n} ];   // x near, y far, z blend start, w texel (uv)
uniform vec4 uCsmParams[ ${n} ];   // x const bias, y slope bias, z depth range (m), w ortho size (m)
uniform vec4 uCsmControl;          // x fade start, y fade end, z tan(source radius), w intensity
uniform float uCsmJitter;          // per-frame PCF rotation offset, 0..1

${glslDisc('COD_PCF_DISC', pcfPts)}
${glslDisc('COD_BLK_DISC', blkPts)}
`;

    for (let i = 0; i < n; i++) {
      out += this._cascadeGLSL(i);
    }

    out += `
float codCsmShadow( float viewDepth, vec3 nrmView, vec3 lightDirView ) {

	float ndl = clamp( dot( normalize( nrmView ), lightDirView ), 0.0, 1.0 );
	// Slope-scaled bias: grazing angles need far more of it than facing ones.
	float slope = clamp( sqrt( max( 1.0 - ndl * ndl, 0.0 ) ) / max( ndl, 0.2 ), 0.0, 2.0 );
	float ang = ( codShadowNoise( gl_FragCoord.xy ) + uCsmJitter ) * 6.2831853;
	vec2 rot = vec2( cos( ang ), sin( ang ) );

	float s = 1.0;
`;

    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const head = i === 0 ? 'if' : 'else if';
      if (last) {
        out +=
          n === 1
            ? `	s = codCsmCascade0( vDirectionalShadowCoord[ 0 ], slope, rot );
`
            : `	else {
		s = codCsmCascade${i}( vDirectionalShadowCoord[ ${i} ], slope, rot );
	}
`;
      } else {
        out += `	${head} ( viewDepth < uCsmSplits[ ${i} ].y ) {
		s = codCsmCascade${i}( vDirectionalShadowCoord[ ${i} ], slope, rot );
		float bs = uCsmSplits[ ${i} ].z;
		if ( viewDepth > bs ) {
			float t = smoothstep( bs, uCsmSplits[ ${i} ].y, viewDepth );
			s = mix( s, codCsmCascade${i + 1}( vDirectionalShadowCoord[ ${i + 1} ], slope, rot ), t );
		}
	}
`;
      }
    }

    out += `
	// Fade out over the last stretch of the final cascade. Note the explicit 1.0 - :
	// smoothstep() with edge0 > edge1 is *undefined* in GLSL, not a reversed ramp.
	float fade = 1.0 - smoothstep( uCsmControl.x, uCsmControl.y, viewDepth );
	return mix( 1.0, s, clamp( fade * uCsmControl.w, 0.0, 1.0 ) );

}

#endif
`;
    return out;
  }

  _cascadeGLSL(i) {
    const pcf = this.pcfTaps;
    const blk = this.blockerTaps;
    const pcss = this.pcss;

    let body = `
float codCsmCascade${i}( vec4 coord, float slope, vec2 rot ) {

	vec3 sc = coord.xyz / coord.w;
	if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;

	vec4 P = uCsmParams[ ${i} ];
	float texel = uCsmSplits[ ${i} ].w;
	float zr = sc.z - ( P.x + P.y * slope );
	if ( zr <= 0.0 ) return 1.0;

	float radius = texel * ${this.baseRadiusTexels.toFixed(2)};
`;

    if (pcss) {
      body += `
	// ── blocker search: how far in front of this pixel is the nearest occluder?
	float search = texel * ${this.searchScale.toFixed(2)} + texel * 2.0 * slope;
	float acc = 0.0;
	float hits = 0.0;
	for ( int k = 0; k < ${blk}; k ++ ) {
		vec2 o = codRotate( COD_BLK_DISC[ k ], rot ) * search;
		float d = texture2D( directionalShadowMap[ ${i} ], sc.xy + o ).r;
		if ( d < zr ) { acc += d; hits += 1.0; }
	}
	if ( hits < 0.5 ) return 1.0;   // nothing in front of us: fully lit, and cheap
	float blocker = acc / hits;

	// Similar triangles: penumbra width grows with blocker/receiver separation.
	float penumbra = ( zr - blocker ) * P.z * uCsmControl.z * 2.0;
	radius = clamp( penumbra / max( P.w, 1e-4 ), texel * 0.6, texel * ${this.maxRadiusTexels.toFixed(2)} );
`;
    }

    body += `
	float sum = 0.0;
	for ( int k = 0; k < ${pcf}; k ++ ) {
		vec2 o = codRotate( COD_PCF_DISC[ k ], rot ) * radius;
		sum += step( zr, texture2D( directionalShadowMap[ ${i} ], sc.xy + o ).r );
	}
	return sum * ${(1 / pcf).toFixed(8)};

}
`;
    return body;
  }

  /** Everything that must be shared with the patched materials. */
  get sharedUniforms() {
    return this.uniforms;
  }

  dispose() {
    this.detach();
    this._disposeLights();
  }
}

export default CascadedShadowMaps;
