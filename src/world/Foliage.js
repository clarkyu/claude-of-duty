/**
 * Instanced vegetation.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.foliage
 */
export default function createFoliage(ctx) {
  const api = { ready: false };
  return {
    name: 'foliage',
    order: 36,
    async init() {
      ctx.foliage = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
