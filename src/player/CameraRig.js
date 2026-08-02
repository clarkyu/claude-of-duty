/**
 * Camera feel and shake.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.cameraRig
 */
export default function createCameraRig(ctx) {
  const api = { ready: false };
  return {
    name: 'cameraRig',
    order: 62,
    async init() {
      ctx.cameraRig = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
