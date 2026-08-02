/**
 * HDR render graph + post FX.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.pipeline
 */
export default function createRenderPipeline(ctx) {
  const api = { ready: false };
  return {
    name: 'pipeline',
    order: 20,
    async init() {
      ctx.pipeline = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
