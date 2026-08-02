/**
 * Set dressing and clutter.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.props
 */
export default function createProps(ctx) {
  const api = { ready: false };
  return {
    name: 'props',
    order: 34,
    async init() {
      ctx.props = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
