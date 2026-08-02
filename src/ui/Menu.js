/**
 * Front end.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.menu
 */
export default function createMenu(ctx) {
  const api = { ready: false };
  return {
    name: 'menu',
    order: 97,
    async init() {
      ctx.menu = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
