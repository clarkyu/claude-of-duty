/**
 * In-game overlay.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.hud
 */
export default function createHUD(ctx) {
  const api = { ready: false };
  return {
    name: 'hud',
    order: 95,
    async init() {
      ctx.hud = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
