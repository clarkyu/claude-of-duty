/**
 * kit/index.js — the modular level kit, re-exported. Owner: level agent.
 *
 *   geom      MeshBuilder + chamfered primitives + deterministic noise
 *   Palette   named material vocabulary (tinted variants share one shader program)
 *   Batcher   per-district geometry batching, LOD, instancing and collider capture
 *   VertexAO  hemisphere occlusion bake + the shader hook that consumes it
 *   Walls     wall runs with openings, window/door furniture, pillars, arches
 *   Stairs    stairs with nosings, ramps, ladders, railings, crates
 *   Roofs     decks, parapets with coping, pitched roofs, balconies, awnings, canopies
 *   Street    kerbs, storm drains, the drainage channel, bridges, cover, signage
 */
export * from './geom.js';
export { Palette, PALETTE } from './Palette.js';
export { Batcher, xform } from './Batcher.js';
export { attachVertexAO, OcclusionField, bakeOcclusion, setVertexAOStrength, aoUniform } from './VertexAO.js';
export * from './Walls.js';
export * from './Stairs.js';
export * from './Roofs.js';
export * from './Street.js';
