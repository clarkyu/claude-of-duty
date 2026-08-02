/**
 * Map geometry and collision.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.level
 */
export default function createLevel(ctx) {
  const api = { ready: false };
  return {
    name: 'level',
    order: 32,
    async init() {
      ctx.level = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
