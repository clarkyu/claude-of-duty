/**
 * Enemy bots.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.ai
 */
export default function createAISystem(ctx) {
  const api = { ready: false };
  return {
    name: 'ai',
    order: 80,
    async init() {
      ctx.ai = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
