/**
 * Viewmodel and gunplay.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ctx.weapons
 */
export default function createWeaponSystem(ctx) {
  const api = { ready: false };
  return {
    name: 'weapons',
    order: 70,
    async init() {
      ctx.weapons = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
