/**
 * Rain, wind, fog, wetness.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.weather
 */
export default function createWeather(ctx) {
  const api = { ready: false };
  return {
    name: 'weather',
    order: 26,
    async init() {
      ctx.weather = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
