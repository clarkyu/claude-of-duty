/**
 * GPU particles, tracers, impacts.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.fx
 */
export default function createFXSystem(ctx) {
  const api = { ready: false };
  return {
    name: 'fx',
    order: 40,
    async init() {
      ctx.fx = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
