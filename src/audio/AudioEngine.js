/**
 * Spatial WebAudio mixer.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.audio
 */
export default function createAudioEngine(ctx) {
  const api = { ready: false };
  return {
    name: 'audio',
    order: 50,
    async init() {
      ctx.audio = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
