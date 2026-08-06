/**
 * CSM — cascaded shadow maps for the key light (sun / moon).
 * Owner: lighting agent. Files owned: render/Lighting.js, render/CSM.js, render/ProbeSystem.js.
 *
 * This is a real CSM, not N directional lights stacked on top of each other:
 *
 *   • practical split scheme — a logarithmic/uniform blend (Zhang et al.), `lambda`
 *     controls the mix. Near cascades get the texels, far cascades get the range.
 *   • stabilised cascades — every slice is fitted to its analytic **bounding sphere**
 *     (which depends only on near/far/fov/aspect, so it never changes when the camera
 *     turns) and the light-space origin is snapped to whole shadow texels. Without
 *     both of those the shadow edges crawl and shimmer whenever the camera moves; it
 *     is the single most visible difference between a good and a bad CSM.
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

const _center = new THREE.Vector3();
const _snapped = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _up = new THREE.Vector3();
const _camPos = new THREE.Vector3();

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
    /** Split-scheme blend: 1 = fully logarithmic, 0 = fully uniform. */
    this.lambda = 0.9;
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
    this.maxRadiusTexels = 14.0;
    this.baseRadiusTexels = 1.1;

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

  _buildLights() {
    this._disposeLights();
    const res = this.resolution;
    for (let i = 0; i < this.count; i++) {
      const light = new THREE.DirectionalLight(0xffffff, i === 0 ? this.lightIntensity : 0);
      light.name = `csm.cascade${i}`;
      light.castShadow = true;
      light.frustumCulled = false;
      // Far cascades cover 30x the area of the near one; spending equal texels on
      // them is wasted memory. Three quarters is invisible in motion.
      const r = i >= 2 ? Math.max(512, Math.round(res * 0.75)) : res;
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
      const size = i >= 2 ? Math.max(512, Math.round(r * 0.75)) : r;
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
    if (headless) this.maxDistance = Math.min(this.maxDistance, 90);
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
      const { centerZ, radius } = this._sliceSphere(camera, n, f);

      _center.copy(_camPos).addScaledVector(_forward, centerZ);

      const mapSize = light.shadow.mapSize.x;
      const texelWorld = (2 * radius) / mapSize;

      // Snap the slice centre to the shadow texel grid, in the light's own basis.
      const cx = Math.floor(_center.dot(_xAxis) / texelWorld) * texelWorld;
      const cy = Math.floor(_center.dot(_yAxis) / texelWorld) * texelWorld;
      const cz = _center.dot(dir);
      _snapped
        .copy(_xAxis)
        .multiplyScalar(cx)
        .addScaledVector(_yAxis, cy)
        .addScaledVector(dir, cz);

      const back = radius + this.extrude;
      light.position.copy(_snapped).addScaledVector(dir, back);
      light.target.position.copy(_snapped);
      light.shadow.camera.up.copy(_up);

      const cam = light.shadow.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 0.05;
      cam.far = back + radius + 1;
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
      p.set(constWorld / depthRange, slopeWorld / depthRange, depthRange, 2 * radius);

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
