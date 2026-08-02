/**
 * Physical sky, clouds, celestial bodies.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.sky
 */
export default function createSky(ctx) {
  const api = { ready: false };
  return {
    name: 'sky',
    order: 22,
    async init() {
      ctx.sky = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
