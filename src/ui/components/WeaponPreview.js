/**
 * WeaponPreview.js — the rotating weapon in the loadout editor. Owner: ui agent.
 *
 * It is the *real* viewmodel: the group `WeaponSystem` built for that weapon id,
 * cloned (geometry and materials are shared, so no extra VRAM), lit with a
 * three-point product-shot rig plus the world IBL, and turned slowly on a turntable.
 *
 * Getting it onto a DOM canvas without a second WebGL context takes one wrinkle:
 * three disables tone mapping and output encoding when it renders to a render
 * target, so the raw target holds linear HDR. We therefore run a two-pixel-shader
 * chain — scene → HDR target → ACES + sRGB → LDR target — and read that back. The
 * readback is 8-bit and display-ready, happens only while the loadout screen is
 * open, and is throttled to 20 Hz.
 *
 * API: new WeaponPreview(canvas, ctx) → { show(id), hide(), update(dt), dispose() }
 */
import * as THREE from 'three';

const W = 460;
const H = 330;
const RATE = 1 / 20;

const TONEMAP_FRAG = /* language=GLSL */ `
  precision highp float;
  uniform sampler2D tSrc;
  uniform float exposure;
  varying vec2 vUv;

  vec3 rrt(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 aces(vec3 c) {
    const mat3 IN = mat3(0.59719, 0.07600, 0.02840,
                         0.35458, 0.90834, 0.13383,
                         0.04823, 0.01566, 0.83777);
    const mat3 OUT = mat3( 1.60475, -0.10208, -0.00327,
                          -0.53108,  1.10813, -0.07276,
                          -0.07367, -0.00605,  1.07602);
    c *= exposure / 0.6;
    c = IN * c;
    c = rrt(c);
    c = OUT * c;
    return clamp(c, 0.0, 1.0);
  }
  vec3 srgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(0.41666)) - 0.055, step(0.0031308, c));
  }
  void main() {
    vec4 s = texture2D(tSrc, vUv);
    vec3 col = srgb(aces(s.rgb));
    // A whisper of vignette so the weapon sits in a frame rather than floating.
    vec2 d = vUv - 0.5;
    col *= 1.0 - dot(d, d) * 0.55;
    gl_FragColor = vec4(col, s.a);
  }
`;

const TONEMAP_VERT = /* language=GLSL */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export class WeaponPreview {
  constructor(canvas, ctx) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = canvas.getContext('2d');
    this.blit = document.createElement('canvas');
    this.blit.width = W;
    this.blit.height = H;
    this.blitG = this.blit.getContext('2d');
    this.imageData = this.blitG ? this.blitG.createImageData(W, H) : null;
    this.pixels = new Uint8Array(W * H * 4);

    this.scene = new THREE.Scene();
    this.turntable = new THREE.Group();
    this.scene.add(this.turntable);
    this.camera = new THREE.PerspectiveCamera(30, W / H, 0.01, 40);

    // Three-point rig: warm key from the upper front-left, cool fill from the
    // right, hard rim from behind to pull the silhouette off the panel.
    const key = new THREE.DirectionalLight(0xfff0dc, 3.4);
    key.position.set(-1.4, 1.5, 1.9);
    const fill = new THREE.DirectionalLight(0x9fc0e0, 1.05);
    fill.position.set(2.0, -0.3, 1.1);
    const rim = new THREE.DirectionalLight(0xffc98a, 4.2);
    rim.position.set(0.7, 0.9, -2.2);
    this.scene.add(key, fill, rim);
    this.lights = [key, fill, rim];
    // The viewmodel may live on its own layer; the armoury shows everything.
    this.camera.layers.enableAll();
    for (const l of this.lights) l.layers.enableAll();

    this.rtHdr = null;
    this.rtLdr = null;
    this.quadScene = null;
    this.quadCam = null;
    this.mat = null;

    this.current = null;
    this.clone = null;
    this.spin = 0.5;
    this.acc = 0;
    this.active = false;
    this.failed = false;
    this._drawn = false;
  }

  _ensureTargets() {
    if (this.rtHdr) return true;
    const THREE_ = THREE;
    try {
      const opts = {
        depthBuffer: true,
        stencilBuffer: false,
        type: THREE_.HalfFloatType,
        colorSpace: THREE_.NoColorSpace,
        minFilter: THREE_.LinearFilter,
        magFilter: THREE_.LinearFilter,
      };
      this.rtHdr = new THREE_.WebGLRenderTarget(W, H, opts);
      this.rtLdr = new THREE_.WebGLRenderTarget(W, H, {
        depthBuffer: false,
        stencilBuffer: false,
        type: THREE_.UnsignedByteType,
        colorSpace: THREE_.NoColorSpace,
        minFilter: THREE_.LinearFilter,
        magFilter: THREE_.LinearFilter,
      });
      this.mat = new THREE_.ShaderMaterial({
        uniforms: {
          tSrc: { value: this.rtHdr.texture },
          exposure: { value: this.ctx.renderer?.toneMappingExposure ?? 1 },
        },
        vertexShader: TONEMAP_VERT,
        fragmentShader: TONEMAP_FRAG,
        depthTest: false,
        depthWrite: false,
        // Raw RGBA straight into the target: the readback must not be blended.
        blending: THREE_.NoBlending,
        toneMapped: false,
      });
      this.quadScene = new THREE_.Scene();
      const quad = new THREE_.Mesh(new THREE_.PlaneGeometry(2, 2), this.mat);
      quad.frustumCulled = false;
      this.quadScene.add(quad);
      this.quadCam = new THREE_.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.quadGeom = quad.geometry;
      return true;
    } catch (err) {
      console.warn('[menu] weapon preview targets failed', err);
      this.failed = true;
      return false;
    }
  }

  /** Swap in the viewmodel group for `id`, cloning it out of the live rig. */
  show(id) {
    this.active = true;
    if (this.current === id && this.clone) return;
    const rig = this.ctx.weapons?.rig;
    if (!rig) return;
    let src = rig.children.find((c) => c.name === `gun:${id}`);
    if (!src) src = rig.children.find((c) => c.visible) || rig.children[0];
    if (!src) return;

    if (this.clone) {
      this.turntable.remove(this.clone);
      this.clone = null;
    }
    let node = null;
    try {
      node = src.clone(true);
    } catch (err) {
      console.warn('[menu] could not clone viewmodel', err);
      return;
    }
    node.visible = true;
    // Only the gun — hands are for the viewmodel, not the armoury. They are
    // *removed*, not hidden: Box3.setFromObject ignores visibility, so a hidden
    // forearm would still inflate the bounds and frame the weapon half-size.
    for (const child of node.children.slice()) {
      if (!/^weapon:/.test(child.name || '')) node.remove(child);
    }
    node.position.set(0, 0, 0);
    node.rotation.set(0, 0, 0);
    node.updateMatrixWorld(true);

    // Centre on the bounding box so every weapon frames the same way.
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    node.position.sub(centre);

    const holder = new THREE.Group();
    holder.add(node);
    this.turntable.add(holder);
    this.clone = holder;
    this.current = id;

    // Frame for the *rotating* footprint, not the bounding sphere: a rifle spinning
    // about Y sweeps a disc of max(x, z), and that is what has to fit the width.
    const rXZ = Math.max(Math.max(size.x, size.z) * 0.5, 0.02);
    const rY = Math.max(size.y * 0.5, 0.01);
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov * 0.5) * this.camera.aspect);
    const dist =
      Math.max(rXZ / Math.tan(hfov * 0.5), rY / Math.tan(vfov * 0.5)) * 1.16 + rXZ * 0.55;
    this.camera.position.set(0, rY * 0.5, dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    // Start broadside-ish: the bore runs down -Z, so a quarter turn puts the whole
    // length across the frame, and a little extra shows the receiver face.
    this.spin = Math.PI * 0.5 + 0.42;
    this._drawn = false;
  }

  hide() {
    this.active = false;
  }

  update(dt) {
    if (!this.active || this.failed) return;
    this.spin += dt * 0.34;
    if (this.clone) {
      this.clone.rotation.y = this.spin;
      this.clone.rotation.x = Math.sin(this.spin * 0.7) * 0.07;
      this.clone.rotation.z = Math.sin(this.spin * 0.43 + 1.1) * 0.04;
    }
    this.acc += dt;
    if (this.acc < RATE && this._drawn) return;
    this.acc = 0;
    this.render();
  }

  render() {
    const renderer = this.ctx.renderer;
    if (!renderer || !this.clone) return;
    if (!this._ensureTargets()) return;

    const env = this.ctx.lighting?.envMap ?? this.ctx.scene?.environment ?? null;
    if (this.scene.environment !== env) {
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.85;
    }
    if (this.mat) this.mat.uniforms.exposure.value = renderer.toneMappingExposure ?? 1;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevScissor = renderer.getScissorTest();
    try {
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.rtHdr);
      renderer.clear(true, true, false);
      renderer.render(this.scene, this.camera);

      renderer.setRenderTarget(this.rtLdr);
      renderer.clear(true, false, false);
      renderer.render(this.quadScene, this.quadCam);

      renderer.readRenderTargetPixels(this.rtLdr, 0, 0, W, H, this.pixels);
      this._present();
      this._drawn = true;
    } catch (err) {
      console.warn('[menu] weapon preview render failed', err);
      this.failed = true;
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.setScissorTest(prevScissor);
    }
  }

  _present() {
    if (!this.imageData || !this.blitG || !this.g) return;
    this.imageData.data.set(this.pixels);
    this.blitG.putImageData(this.imageData, 0, 0);
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.save();
    // GL reads bottom-up; flip on the way to the visible canvas.
    g.translate(0, H);
    g.scale(1, -1);
    g.drawImage(this.blit, 0, 0);
    g.restore();
  }

  dispose() {
    this.rtHdr?.dispose();
    this.rtLdr?.dispose();
    this.quadGeom?.dispose();
    this.mat?.dispose();
    this.rtHdr = this.rtLdr = null;
    this.clone = null;
  }
}

export default WeaponPreview;
