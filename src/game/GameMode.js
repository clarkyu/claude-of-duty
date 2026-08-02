/**
 * Rules and scoring.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.game
 */
export default function createGameMode(ctx) {
  const api = { ready: false };
  return {
    name: 'game',
    order: 90,
    async init() {
      ctx.game = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
