/**
 * Rigid bodies, collision, ragdolls.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.physics
 */
export default function createPhysicsWorld(ctx) {
  const api = { ready: false };
  return {
    name: 'physics',
    order: 30,
    async init() {
      ctx.physics = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
