/**
 * Projectile simulation.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.ballistics
 */
export default function createBallistics(ctx) {
  const api = { ready: false };
  return {
    name: 'ballistics',
    order: 44,
    async init() {
      ctx.ballistics = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
