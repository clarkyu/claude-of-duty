/**
 * FPS movement.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.player
 */
export default function createController(ctx) {
  const api = { ready: false };
  return {
    name: 'player',
    order: 60,
    async init() {
      ctx.player = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
