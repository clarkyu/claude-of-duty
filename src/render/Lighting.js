/**
 * Sun, CSM shadows, IBL, local lights.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.lighting
 */
export default function createLighting(ctx) {
  const api = { ready: false };
  return {
    name: 'lighting',
    order: 24,
    async init() {
      ctx.lighting = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
