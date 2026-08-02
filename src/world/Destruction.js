/**
 * Breakable geometry.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.destruction
 */
export default function createDestruction(ctx) {
  const api = { ready: false };
  return {
    name: 'destruction',
    order: 38,
    async init() {
      ctx.destruction = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
