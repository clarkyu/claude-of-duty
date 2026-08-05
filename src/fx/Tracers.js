/**
 * Tracers — the streak a round leaves between the muzzle and where it is now.
 * Owner: FX agent. Used by FXSystem.
 *
 * Ballistics hands us the exact segment a projectile flew this frame, once per
 * frame per round, keyed by `opts.projectile`. That is the important detail: a
 * 5.56 round covers ~14 m in one 60 Hz frame, so the *segment* is the tracer.
 * Drawing a fixed-length sprite at the round's position instead is what makes
 * cheap tracers stutter — the sprite lands at a different place each frame with
 * nothing joining the dots. Here the ribbon is stretched between the round's
 * previous and current positions, so no matter how fast it travels the streak is
 * continuous, sub-frame accurate, and the same length the round actually moved.
 *
 * Behind that head the tail keeps extending back towards the muzzle up to a fixed
 * length, fading and thinning as it goes. When the round dies (impact, or the
 * projectile stops reporting) the head stops and the tail runs into it, so the
 * streak retracts rather than vanishing mid-air.
 *
 * Geometry is one instanced quad per tracer, expanded in the vertex shader into a
 * camera-facing beam. Width is `max(worldWidth, N pixels)`, so a tracer 120 m out
 * still resolves instead of dropping below a pixel and shimmering — but it is
 * capped tight: fat glowing sausages read as arcade, real tracers are hairlines
 * with a bloom halo.
 */
import * as THREE from 'three';

const MAX_TRACERS = 96;
const TAIL_LENGTH = 26; // metres of visible trail behind the head

// language=GLSL
const TRACER_VERT = /* glsl */ `
attribute vec3 aTail;
attribute vec3 aHead;
attribute vec4 aParams;   // halfWidth, intensity, coreFrac, tailFade
attribute vec3 aTint;

uniform vec2 uFxRes;
uniform float uPixelWidth;
uniform float uProjScale;

varying vec2 vUv;
varying vec3 vTint;
varying vec3 vParams;
varying vec3 vViewPos;

void main() {
	vUv = uv;
	vTint = aTint;
	vParams = vec3( aParams.y, aParams.z, aParams.w );

	vec3 a = ( viewMatrix * vec4( aTail, 1.0 ) ).xyz;
	vec3 b = ( viewMatrix * vec4( aHead, 1.0 ) ).xyz;
	vec3 p = mix( a, b, uv.y );

	vec3 axis = b - a;
	float len = length( axis );
	if ( len < 1e-5 ) axis = vec3( 0.0, 1.0, 0.0 );
	else axis /= len;

	// View-space perpendicular: cross the segment with the view direction to the
	// point. Round tracers face the camera the same way at both ends.
	vec3 toCam = normalize( - p );
	vec3 side = cross( axis, toCam );
	float sl = length( side );
	side = sl > 1e-5 ? side / sl : vec3( 1.0, 0.0, 0.0 );

	// Never thinner than a pixel and change: below that the streak aliases into a
	// dashed line as it crosses the frame.
	float dist = max( - p.z, 0.02 );
	float minW = dist * uPixelWidth / max( uProjScale, 1e-4 );
	float hw = max( aParams.x, minW );

	p += side * ( ( uv.x - 0.5 ) * 2.0 * hw );
	vViewPos = p;
	gl_Position = projectionMatrix * vec4( p, 1.0 );
}
`;

// language=GLSL
const TRACER_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tFxDepth;
uniform vec2 uFxRes;
uniform float uDepthValid;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vParams;    // intensity, coreFrac, tailFade
varying vec3 vViewPos;

void main() {
	// Across the ribbon: a hard gaussian core inside a much dimmer halo. Two lobes
	// is what gives a tracer a visible filament instead of a uniform bar.
	float x = ( vUv.x - 0.5 ) * 2.0;
	float core = exp( - x * x * 26.0 );
	float halo = exp( - x * x * 3.2 );

	// Along the ribbon: brightest at the head, decaying towards the tail.
	float t = vUv.y;
	float along = pow( t, 2.4 ) * 0.88 + 0.12;
	along *= mix( 1.0, smoothstep( 0.0, 0.28, t ), vParams.z );

	float i = vParams.x * along;
	vec3 col = vTint * ( core * 2.6 + halo * 0.30 ) * i;

	float a = clamp( ( core + halo * 0.35 ) * along, 0.0, 1.0 );

	if ( uDepthValid > 0.5 ) {
		float sceneD = texture2D( tFxDepth, gl_FragCoord.xy / uFxRes ).r;
		a *= clamp( ( sceneD - ( - vViewPos.z ) ) / 0.25, 0.0, 1.0 );
	}
	if ( a <= 0.002 ) discard;

	gl_FragColor = vec4( col * a, 0.0 );
}
`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Tracers {
  constructor(ctx, fx) {
    this.ctx = ctx;
    this.fx = fx;
    this.live = 0;
    this.slots = [];
    /** projectile id -> slot, so a round updates its own streak each frame. */
    this.byId = new Map();
  }

  init() {
    const cap = MAX_TRACERS;
    this.cap = cap;
    this.aTail = new Float32Array(cap * 3);
    this.aHead = new Float32Array(cap * 3);
    this.aParams = new Float32Array(cap * 4);
    this.aTint = new Float32Array(cap * 3);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3)
    );
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aTail', new THREE.InstancedBufferAttribute(this.aTail, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aHead', new THREE.InstancedBufferAttribute(this.aHead, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(this.aParams, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(this.aTint, 3).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geometry = g;

    const G = this.fx.globals;
    this.material = new THREE.ShaderMaterial({
      name: 'fx:tracers',
      uniforms: {
        tFxDepth: G.tFxDepth,
        uFxRes: G.uFxRes,
        uDepthValid: G.uDepthValid,
        uPixelWidth: { value: 0.0016 },
        uProjScale: { value: 1 },
      },
      vertexShader: TRACER_VERT,
      fragmentShader: TRACER_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'fx.tracers';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 16;
    this.mesh.visible = false;

    for (let i = 0; i < cap; i++) {
      this.slots.push({
        live: false,
        id: null,
        head: new THREE.Vector3(),
        tail: new THREE.Vector3(),
        origin: new THREE.Vector3(),
        travelled: 0,
        lastSeen: -1,
        fade: 1,
        width: 0.011,
        intensity: 1,
        r: 1,
        g: 0.62,
        b: 0.22,
        dying: false,
      });
    }
  }

  _alloc() {
    for (const s of this.slots) if (!s.live) return s;
    // Every slot busy: recycle the one with the least life left in it.
    let worst = this.slots[0];
    for (const s of this.slots) if (s.fade < worst.fade) worst = s;
    if (worst.id !== null) this.byId.delete(worst.id);
    return worst;
  }

  /**
   * @param {THREE.Vector3} from segment start (this frame)
   * @param {THREE.Vector3} to   segment end   (this frame)
   */
  tracer(from, to, opts = {}) {
    if (!from || !to) return false;
    const frame = this.ctx.time?.frame ?? 0;
    const id = opts.projectile ?? null;
    let s = id !== null ? this.byId.get(id) : null;

    if (!s || !s.live) {
      s = this._alloc();
      s.live = true;
      s.id = id;
      s.dying = false;
      s.travelled = 0;
      s.origin.copy(from);
      s.tail.copy(from);
      s.fade = 1;
      if (id !== null) this.byId.set(id, s);

      const supp = !!opts.suppressed;
      // Green for friendlies, orange-red for everyone else — the standard read.
      const friendly = opts.owner === 'player' || opts.owner === 'A';
      const heat = opts.heat ?? 1;
      s.r = (friendly ? 1.0 : 1.0) * heat;
      s.g = (friendly ? 0.66 : 0.42) * heat;
      s.b = (friendly ? 0.24 : 0.14) * heat;
      s.width = (opts.width ?? 0.011) * (opts.calibre === '7.62x51' ? 1.25 : 1);
      s.intensity = (opts.intensity ?? 5.5) * (supp ? 0.7 : 1);
    }

    s.head.copy(to);
    s.lastSeen = frame;
    s.travelled = s.origin.distanceTo(to);

    // The tail lags the head by a fixed length, clamped to the muzzle so a round
    // that has only flown 3 m does not draw a 26 m streak out of thin air.
    const back = Math.min(TAIL_LENGTH, s.travelled);
    _a.copy(s.head).sub(s.origin);
    const len = _a.length();
    if (len > 1e-4) {
      _a.multiplyScalar(1 / len);
      s.tail.copy(s.head).addScaledVector(_a, -back);
    } else {
      s.tail.copy(s.origin);
    }

    // A one-shot segment (no projectile id) still needs to expire on its own.
    if (id === null) s.dying = true;
    return true;
  }

  update(dt) {
    const frame = this.ctx.time?.frame ?? 0;
    let live = 0;
    for (const s of this.slots) {
      if (!s.live) continue;
      // Two frames without an update means the round is gone: retract the tail
      // into the head rather than blinking the whole streak off.
      if (s.dying || frame - s.lastSeen > 1) {
        s.fade -= dt * 14;
        _a.copy(s.head).sub(s.tail);
        const l = _a.length();
        if (l > 0.01) s.tail.addScaledVector(_a.multiplyScalar(1 / l), Math.min(l, 900 * dt));
        if (s.fade <= 0) {
          s.live = false;
          if (s.id !== null) this.byId.delete(s.id);
          s.id = null;
          continue;
        }
      }
      live++;
    }
    this.live = live;
  }

  lateUpdate(dt, camera) {
    if (!this.mesh) return;
    let n = 0;
    for (const s of this.slots) {
      if (!s.live || n >= this.cap) continue;
      const i3 = n * 3;
      const i4 = n * 4;
      this.aTail[i3] = s.tail.x;
      this.aTail[i3 + 1] = s.tail.y;
      this.aTail[i3 + 2] = s.tail.z;
      this.aHead[i3] = s.head.x;
      this.aHead[i3 + 1] = s.head.y;
      this.aHead[i3 + 2] = s.head.z;
      this.aParams[i4] = s.width;
      this.aParams[i4 + 1] = s.intensity * Math.max(0, s.fade);
      this.aParams[i4 + 2] = 0;
      this.aParams[i4 + 3] = s.travelled > TAIL_LENGTH ? 1 : 0;
      this.aTint[i3] = s.r;
      this.aTint[i3 + 1] = s.g;
      this.aTint[i3 + 2] = s.b;
      n++;
    }
    if (n > 0) {
      for (const name of ['aTail', 'aHead', 'aParams', 'aTint']) {
        this.geometry.getAttribute(name).needsUpdate = true;
      }
      if (camera) {
        // Half the vertical projection scale: converts a pixel budget into the
        // world width needed at a given view depth.
        const py = camera.projectionMatrix?.elements?.[5] ?? 1;
        this.material.uniforms.uProjScale.value = py * 0.5;
        this.material.uniforms.uPixelWidth.value = 1.35 / Math.max(1, this.fx.globals.uFxRes.value.y);
      }
    }
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  clear() {
    for (const s of this.slots) {
      s.live = false;
      s.id = null;
    }
    this.byId.clear();
    this.live = 0;
    if (this.geometry) this.geometry.instanceCount = 0;
    if (this.mesh) this.mesh.visible = false;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}

export default Tracers;
