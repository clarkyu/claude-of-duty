/**
 * Procedural PBR texture generation.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.textures
 */
export default function createTextureForge(ctx) {
  const api = { ready: false };
  return {
    name: 'textures',
    order: 10,
    async init() {
      ctx.textures = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
