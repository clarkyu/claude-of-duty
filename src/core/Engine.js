/**
 * Engine — renderer ownership, system registry, frame loop. Owner: orchestrator (core).
 *
 * Systems are registered from src/core/manifest.js. Each is `(ctx) => System`; see
 * docs/ARCHITECTURE.md §1. The engine guarantees:
 *   - `init()` of every system is awaited (in `order`) before the first frame
 *   - a failing system is isolated: it is disabled, logged, and the game still boots
 *   - fixed-step `fixed(fdt)` at 120 Hz with an accumulator, capped to avoid spirals
 *   - `update(dt)` then `lateUpdate(dt)` then render, every frame
 *
 * Rendering is delegated: if `ctx.pipeline` exists the engine calls
 * `pipeline.render(dt)`, otherwise it falls back to a plain forward render so the
 * project is always runnable even with the post stack stubbed out.
 */
import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Settings } from './Settings.js';
import { Input } from './Input.js';
import { makeRNG } from './RNG.js';

const FIXED_DT = 1 / 120;
const MAX_FIXED_STEPS = 8;

export class Engine {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.bus = new EventBus();
    this.settings = new Settings(this.bus, options.settings || {});
    this.rng = makeRNG(options.seed ?? 0x5eed1234);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // TAA/FXAA handled in the post chain
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // screenshot harness needs this
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.settings.get('maxPixelRatio')));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.settings.get('exposure');
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    this.renderer = renderer;
    this.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.name = 'world';
    this.camera = new THREE.PerspectiveCamera(
      this.settings.get('fov'),
      window.innerWidth / window.innerHeight,
      0.05,
      2000
    );
    this.camera.name = 'worldCamera';
    this.camera.position.set(0, 1.7, 0);
    this.camera.rotation.order = 'YXZ';

    // Viewmodel is rendered in its own scene with a narrower FOV so the weapon
    // never distorts when the world FOV is cranked up — standard CoD practice.
    this.viewScene = new THREE.Scene();
    this.viewScene.name = 'viewmodel';
    this.viewCamera = new THREE.PerspectiveCamera(
      this.settings.get('viewmodelFov'),
      window.innerWidth / window.innerHeight,
      0.002,
      12
    );
    this.viewCamera.name = 'viewmodelCamera';
    this.viewCamera.rotation.order = 'YXZ';

    this.input = new Input(canvas, this.bus, this.settings);

    this.time = { elapsed: 0, dt: 0, frame: 0, fixedAlpha: 0, scale: 1 };

    /** @type {import('./types.js').Ctx} */
    this.ctx = {
      engine: this,
      renderer,
      scene: this.scene,
      camera: this.camera,
      viewScene: this.viewScene,
      viewCamera: this.viewCamera,
      settings: this.settings,
      bus: this.bus,
      input: this.input,
      rng: this.rng,
      time: this.time,
      maxAnisotropy: this.maxAnisotropy,
      THREE,
    };

    this.systems = [];
    this.failed = [];
    this.running = false;
    this._accum = 0;
    this._lastT = 0;
    this._raf = 0;
    this._frameCallbacks = [];
    this.stats = { drawCalls: 0, tris: 0, programs: 0, cpuMs: 0, gpuMs: 0 };

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    this.bus.on('setting:changed', ({ key, value }) => {
      if (key === 'exposure') renderer.toneMappingExposure = value;
      if (key === 'renderScale') this.resize();
    });
  }

  /** @param {Array<{name:string, factory:Function}>} defs */
  async boot(defs) {
    for (const def of defs) {
      let sys = null;
      try {
        sys = def.factory(this.ctx);
      } catch (err) {
        console.error(`[engine] ${def.name} factory threw:`, err);
        this.failed.push({ name: def.name, err });
        continue;
      }
      if (!sys) continue;
      sys.name = sys.name || def.name;
      sys.order = sys.order ?? def.order ?? 100;
      this.systems.push(sys);
    }
    this.systems.sort((a, b) => a.order - b.order);

    for (const sys of this.systems) {
      if (!sys.init) continue;
      const t0 = performance.now();
      try {
        await sys.init();
        sys._ok = true;
      } catch (err) {
        console.error(`[engine] ${sys.name}.init() failed:`, err);
        sys._broken = true;
        this.failed.push({ name: sys.name, err });
      }
      if (!this.settings.get('headless')) {
        console.log(`[engine] ${sys.name} ${(performance.now() - t0).toFixed(0)}ms`);
      }
      this.bus.emit('boot:progress', {
        name: sys.name,
        done: this.systems.indexOf(sys) + 1,
        total: this.systems.length,
      });
    }
    this.resize();
    this.bus.emit('boot:done', { failed: this.failed });
    return this;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastT = performance.now();
    const tick = () => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);
      const now = performance.now();
      let dt = (now - this._lastT) / 1000;
      this._lastT = now;
      // A tab that was backgrounded must not teleport the sim.
      if (dt > 0.25) dt = 0.25;
      this.tick(dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  /** One full simulation + render step. Also used by the screenshot harness. */
  tick(dt) {
    const cpu0 = performance.now();
    const scaled = dt * this.time.scale;
    this.time.dt = scaled;
    this.time.elapsed += scaled;
    this.time.frame++;

    this._accum += scaled;
    let steps = 0;
    while (this._accum >= FIXED_DT && steps < MAX_FIXED_STEPS) {
      for (const s of this.systems) {
        if (s._broken || !s.fixed) continue;
        try {
          s.fixed(FIXED_DT);
        } catch (err) {
          this._fail(s, 'fixed', err);
        }
      }
      this._accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_FIXED_STEPS) this._accum = 0;
    this.time.fixedAlpha = this._accum / FIXED_DT;

    for (const s of this.systems) {
      if (s._broken || !s.update) continue;
      try {
        s.update(scaled);
      } catch (err) {
        this._fail(s, 'update', err);
      }
    }
    for (const s of this.systems) {
      if (s._broken || !s.lateUpdate) continue;
      try {
        s.lateUpdate(scaled);
      } catch (err) {
        this._fail(s, 'lateUpdate', err);
      }
    }

    this.renderer.info.reset();
    if (this.ctx.pipeline?.render) {
      this.ctx.pipeline.render(scaled);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.viewScene, this.viewCamera);
    }

    const info = this.renderer.info;
    this.stats.drawCalls = info.render.calls;
    this.stats.tris = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;
    this.stats.cpuMs = performance.now() - cpu0;

    this.input.endFrame();

    if (this._frameCallbacks.length) {
      const cbs = this._frameCallbacks.slice();
      this._frameCallbacks.length = 0;
      for (const cb of cbs) cb();
    }
  }

  _fail(sys, phase, err) {
    console.error(`[engine] ${sys.name}.${phase}() threw, disabling:`, err);
    sys._broken = true;
    this.failed.push({ name: sys.name, phase, err });
  }

  onNextFrame(cb) {
    this._frameCallbacks.push(cb);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = this.settings.get('renderScale') || 1;
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, this.settings.get('maxPixelRatio')) * scale
    );
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    const dw = Math.round(w * this.renderer.getPixelRatio());
    const dh = Math.round(h * this.renderer.getPixelRatio());
    for (const s of this.systems) {
      if (s._broken || !s.resize) continue;
      try {
        s.resize(dw, dh);
      } catch (err) {
        this._fail(s, 'resize', err);
      }
    }
    this.bus.emit('engine:resize', { w, h, dw, dh });
  }

  get(name) {
    return this.systems.find((s) => s.name === name);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const s of this.systems) {
      try {
        s.dispose?.();
      } catch {
        /* teardown is best-effort */
      }
    }
    this.input.dispose();
    this.renderer.dispose();
  }
}
