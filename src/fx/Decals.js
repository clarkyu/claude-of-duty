/**
 * Bullet holes and surface marks.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.decals
 */
export default function createDecals(ctx) {
  const api = { ready: false };
  return {
    name: 'decals',
    order: 42,
    async init() {
      ctx.decals = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
