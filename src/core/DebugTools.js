/**
 * DebugTools — the `window.__COD` harness API. Owner: ORCHESTRATOR ONLY.
 *
 * Everything the screenshot / review tooling needs to drive the game deterministically
 * lives here. Gameplay systems opt in by listening for `debug:pose` and applying the
 * pose's `state` object; they should never need to touch this file.
 *
 * See docs/ARCHITECTURE.md §6.
 */
import * as THREE from 'three';

export default function createDebugTools(ctx) {
  const engine = ctx.engine;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const errors = [];

  const origError = console.error;
  console.error = (...args) => {
    errors.push(args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' '));
    origError.apply(console, args);
  };
  window.addEventListener('error', (e) => errors.push(`uncaught: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) =>
    errors.push(`unhandled rejection: ${e.reason?.message || e.reason}`)
  );

  const api = {
    ready,
    engine,
    ctx,
    THREE,
    errors,

    /** Freeze the sim; the harness drives frames by hand from here. */
    pause() {
      engine.stop();
    },
    resume() {
      engine.start();
    },

    /**
     * @param {{pos?:number[], look?:number[], yaw?:number, pitch?:number, fov?:number,
     *          time?:number, state?:object}} pose
     */
    applyPose(pose = {}) {
      const cam = ctx.camera;
      if (pose.pos) cam.position.fromArray(pose.pos);
      if (pose.look) {
        const t = new THREE.Vector3().fromArray(pose.look);
        const d = t.clone().sub(cam.position).normalize();
        cam.rotation.y = Math.atan2(-d.x, -d.z);
        cam.rotation.x = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
        cam.rotation.z = 0;
      }
      if (pose.yaw !== undefined) cam.rotation.y = pose.yaw;
      if (pose.pitch !== undefined) cam.rotation.x = pose.pitch;
      if (pose.fov !== undefined) {
        cam.fov = pose.fov;
        cam.updateProjectionMatrix();
      }
      cam.updateMatrixWorld(true);
      // Keep the player capsule under the camera so systems that read player
      // position (audio, AI, culling) agree with what is on screen.
      if (ctx.player?.teleport && pose.pos) {
        ctx.player.teleport(cam.position, cam.rotation.y, cam.rotation.x);
      }
      if (pose.time !== undefined) ctx.lighting?.setTimeOfDay?.(pose.time);
      ctx.bus.emit('debug:pose', pose.state || {});
      // Poses take control of the camera: suspend anything that would fight it.
      api.cameraLocked = true;
      ctx.bus.emit('debug:cameraLock', { locked: true });
    },

    cameraLocked: false,

    releaseCamera() {
      api.cameraLocked = false;
      ctx.bus.emit('debug:cameraLock', { locked: false });
    },

    /** Advance the simulation n frames at a fixed dt without presenting. */
    step(n = 1, dt = 1 / 60) {
      for (let i = 0; i < n; i++) engine.tick(dt);
    },

    /** Render exactly one frame and resolve once the GPU has flushed it. */
    frame(dt = 1 / 60) {
      engine.tick(dt);
      return new Promise((resolve) => {
        ctx.renderer.getContext().finish?.();
        requestAnimationFrame(() => resolve());
      });
    },

    stats() {
      const m = ctx.renderer.info.memory;
      return {
        ...engine.stats,
        geometries: m.geometries,
        textures: m.textures,
        systems: engine.systems.map((s) => ({ name: s.name, broken: !!s._broken })),
        failed: engine.failed.map((f) => ({ name: f.name, message: f.err?.message })),
        errors: errors.slice(0, 30),
      };
    },

    setQuality(tier) {
      ctx.settings.setTier(tier);
    },

    setSetting(k, v) {
      ctx.settings.set(k, v);
    },

    /** Toggle individual post passes for A/B comparison shots. */
    togglePass(name, on) {
      ctx.pipeline?.setPassEnabled?.(name, on);
    },

    /** Wireframe / normals / roughness debug views, when the pipeline supports them. */
    debugView(mode) {
      ctx.pipeline?.setDebugView?.(mode);
    },
  };

  return {
    name: 'debug',
    order: 999,
    async init() {
      window.__COD = api;
      ctx.debug = api;
      resolveReady(api);
    },
  };
}
