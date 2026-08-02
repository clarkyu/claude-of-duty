/**
 * Shared material definitions.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.materials
 */
export default function createMaterialLibrary(ctx) {
  const api = { ready: false };
  return {
    name: 'materials',
    order: 12,
    async init() {
      ctx.materials = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
