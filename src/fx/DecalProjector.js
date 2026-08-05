/**
 * DecalProjector — the GPU half of the decal system: the procedural decal atlas, the
 * scene-depth source, and the instanced deferred-projection batch.
 * Owner: decals agent. Files owned: src/fx/Decals.js, src/fx/DecalProjector.js.
 *
 * ── Why deferred projection ─────────────────────────────────────────────────────
 * A decal here is a **box projector**, not a clipped mesh. Every pixel the box covers
 * reads the scene depth, reconstructs the view-space position of whatever is actually
 * visible there, transforms it into the projector's unit cube and discards if it falls
 * outside. What is left is, by construction, exactly the surface the decal should be
 * painted on — curved, bevelled, instanced or skinned, it does not matter, and there is
 * no geometry to clip, no z-fighting and no seam where two receiver meshes meet.
 *
 * Depth comes from a private depth-only prepass (`DecalDepth`) rendered in `lateUpdate`,
 * *after* the camera rig has finished writing the camera, so the reconstruction is exact.
 * The pipeline exposes no injection hook (`ctx.pipeline.addPass()` is a documented no-op)
 * and its own depth attachment is the target being written during the main pass, so
 * sampling it there would be a framebuffer feedback loop. The prepass costs one extra
 * depth-only traversal and is skipped entirely on any frame where no decal is on screen.
 *
 * The decals themselves live in `ctx.scene` as a single `InstancedMesh` per atlas, drawn
 * in the transparent queue of the pipeline's world pass with premultiplied alpha. Their
 * material is a real `MeshStandardMaterial` with the projection injected through
 * `onBeforeCompile`, which means Lighting.js picks it up in its material scan and the
 * holes get the *same* sun, CSM cascades, SH irradiance and reflection probes as the wall
 * they sit on. Overriding `vViewPosition` with the reconstructed position (three derives
 * `geometryPosition` from it) makes shadowing and IBL correct at the receiver surface
 * rather than at the projector box.
 *
 * ── Atlas ───────────────────────────────────────────────────────────────────────
 * Two textures, generated on the GPU at init, no art assets:
 *   albedo : RGB sRGB albedo (AO partly baked), A = coverage
 *   nrm    : RG tangent normal, B = roughness, A = height (parallax + occlusion)
 * Laid out as 32 small cells (top half) plus 8 large cells (bottom half); each decal
 * instance carries its own UV rect, so one draw call covers every decal type.
 *
 * Public API — see the class docs below. Nothing here touches another module's files.
 */
import * as THREE from 'three';

/* ══════════════════════════════════════════════════════════════════ constants ══ */

export const CELL_KIND = {
  crater: 1,
  metal: 2,
  wood: 3,
  soft: 4,
  fabric: 5,
  glass: 6,
  scorch: 7,
  blood: 8,
  foot: 9,
  tyre: 10,
  grime: 11,
  oil: 12,
  poster: 13,
  graffiti: 14,
  stencil: 15,
  scuff: 16,
  rust: 17,
  rubber: 18,
  drop: 19,
  crack: 20,
};

const K = CELL_KIND;

/** sRGB hex -> linear THREE.Color (the atlas shader writes linear). */
function lin(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

/**
 * Atlas cell table.
 *   kind   generator id
 *   big    true -> 512-px slot in the bottom half, false -> 256-px slot in the top half
 *   p0/p1  generator parameters (meaning is per-kind, documented in the shader)
 *   cols   [base, secondary, tertiary, cavity] albedo palette
 *   rough  [roughMin, roughMax, maskBias, jitter]
 *   mix    [cavityWeight, aoStrength, normalStrength, heightBias]
 */
export const CELLS = [
  /* ── concrete / masonry ─────────────────────────────────────────────────── */
  {
    name: 'hole_concrete_a', kind: K.crater, seed: 11.3,
    p0: [0.15, 0.40, 9.0, 0.55], p1: [0.30, 1.0, 0.9, 0.0],
    cols: ['#8d8981', '#b8b3a8', '#cfcac0', '#2b2724'],
    rough: [0.72, 0.94, 0.05, 0.06], mix: [1.0, 0.9, 1.0, 0.0],
  },
  {
    name: 'hole_concrete_b', kind: K.crater, seed: 27.9,
    p0: [0.17, 0.46, 12.0, 0.75], p1: [0.34, 1.0, 1.15, 0.0],
    cols: ['#847f77', '#b2ada2', '#d3cec3', '#252220'],
    rough: [0.70, 0.95, 0.05, 0.07], mix: [1.0, 0.95, 1.05, 0.0],
  },
  {
    name: 'hole_concrete_c', kind: K.crater, seed: 51.1,
    p0: [0.13, 0.34, 7.0, 0.40], p1: [0.26, 1.0, 0.7, 0.0],
    cols: ['#928d84', '#bdb8ad', '#d8d3c9', '#302c28'],
    rough: [0.74, 0.93, 0.04, 0.05], mix: [1.0, 0.85, 0.95, 0.0],
  },
  {
    name: 'hole_brick_a', kind: K.crater, seed: 73.4,
    p0: [0.16, 0.42, 8.0, 0.85], p1: [0.32, 1.0, 0.8, 0.0],
    cols: ['#7c4534', '#a5654a', '#cdbba4', '#241412'],
    rough: [0.78, 0.95, 0.04, 0.07], mix: [1.0, 0.95, 1.1, 0.0],
  },
  {
    name: 'hole_plaster_a', kind: K.crater, seed: 96.2,
    p0: [0.14, 0.48, 6.0, 1.10], p1: [0.42, 0.55, 1.3, 1.0],
    cols: ['#d6d0c2', '#efe9dc', '#9b8f7c', '#3a332c'],
    rough: [0.80, 0.96, 0.03, 0.06], mix: [1.0, 1.0, 1.05, 0.0],
  },
  {
    name: 'hole_plaster_b', kind: K.crater, seed: 118.7,
    p0: [0.12, 0.55, 5.0, 1.35], p1: [0.48, 0.55, 1.5, 1.0],
    cols: ['#ded8ca', '#f3eee2', '#8d8271', '#332d27'],
    rough: [0.82, 0.97, 0.03, 0.06], mix: [1.0, 1.0, 1.0, 0.0],
  },
  {
    name: 'hole_tile_a', kind: K.crater, seed: 141.5,
    p0: [0.12, 0.34, 14.0, 0.30], p1: [0.24, 1.0, 1.4, 0.0],
    cols: ['#cfcbc4', '#e9e6e0', '#b3aca1', '#211f1d'],
    rough: [0.22, 0.72, 0.10, 0.05], mix: [1.0, 0.9, 1.2, 0.0],
  },
  {
    name: 'hole_asphalt_a', kind: K.crater, seed: 163.8,
    p0: [0.16, 0.44, 6.0, 0.60], p1: [0.30, 1.0, 0.85, 0.0],
    cols: ['#33312e', '#4a4744', '#6d6862', '#141312'],
    rough: [0.80, 0.95, 0.04, 0.06], mix: [1.0, 0.9, 1.0, 0.0],
  },

  /* ── metal ──────────────────────────────────────────────────────────────── */
  {
    name: 'hole_metal_a', kind: K.metal, seed: 19.6,
    p0: [0.11, 0.24, 7.0, 0.9], p1: [0.5, 1.0, 0.0, 0.0],
    cols: ['#4a4744', '#cfd4d8', '#8f9498', '#0e0d0d'],
    rough: [0.20, 0.62, -0.05, 0.05], mix: [1.0, 1.0, 1.35, 0.0],
  },
  {
    name: 'hole_metal_b', kind: K.metal, seed: 38.2,
    p0: [0.13, 0.28, 9.0, 1.2], p1: [0.7, 1.0, 0.0, 0.0],
    cols: ['#3c3a37', '#dfe3e6', '#9aa0a4', '#0b0b0b'],
    rough: [0.16, 0.58, -0.05, 0.05], mix: [1.0, 1.0, 1.5, 0.0],
  },

  /* ── wood ───────────────────────────────────────────────────────────────── */
  {
    name: 'hole_wood_a', kind: K.wood, seed: 57.4,
    p0: [0.14, 0.36, 13.0, 0.9], p1: [0.5, 1.0, 0.0, 0.0],
    cols: ['#4a3520', '#a67c4c', '#d3b183', '#1b1109'],
    rough: [0.62, 0.93, 0.05, 0.08], mix: [1.0, 0.95, 1.25, 0.0],
  },
  {
    name: 'hole_wood_b', kind: K.wood, seed: 84.1,
    p0: [0.16, 0.42, 17.0, 1.2], p1: [0.7, 1.0, 0.0, 0.0],
    cols: ['#41301e', '#9b7245', '#c8a878', '#170e07'],
    rough: [0.60, 0.94, 0.05, 0.09], mix: [1.0, 1.0, 1.35, 0.0],
  },

  /* ── soft ground ────────────────────────────────────────────────────────── */
  {
    name: 'hole_dirt_a', kind: K.soft, seed: 103.7,
    p0: [0.30, 0.44, 0.55, 0.8], p1: [0.0, 1.0, 0.0, 0.0],
    cols: ['#4b3c2a', '#6d5a41', '#8a7554', '#1d160f'],
    rough: [0.88, 0.99, 0.02, 0.06], mix: [1.0, 0.85, 0.9, 0.0],
  },
  {
    name: 'hole_dirt_b', kind: K.soft, seed: 127.2,
    p0: [0.34, 0.50, 0.70, 1.1], p1: [0.0, 1.0, 0.0, 0.0],
    cols: ['#443728', '#655338', '#83704f', '#191309'],
    rough: [0.90, 0.99, 0.02, 0.06], mix: [1.0, 0.85, 0.95, 0.0],
  },
  {
    name: 'hole_sand_a', kind: K.soft, seed: 149.9,
    p0: [0.34, 0.52, 0.40, 1.3], p1: [0.0, 1.0, 0.0, 0.0],
    cols: ['#9c8358', '#c4a878', '#ddc79b', '#4c3f2a'],
    rough: [0.92, 1.00, 0.01, 0.04], mix: [1.0, 0.7, 0.75, 0.0],
  },
  {
    name: 'hole_snow_a', kind: K.soft, seed: 171.3,
    p0: [0.30, 0.50, 0.45, 1.0], p1: [0.0, 1.0, 0.0, 0.0],
    cols: ['#b9c3cd', '#e4ebf3', '#f4f8fc', '#69737f'],
    rough: [0.55, 0.86, 0.02, 0.05], mix: [1.0, 1.1, 0.85, 0.0],
  },

  /* ── soft materials ─────────────────────────────────────────────────────── */
  {
    name: 'hole_fabric_a', kind: K.fabric, seed: 193.5,
    p0: [0.13, 0.30, 15.0, 0.9], p1: [0.0, 1.0, 0.0, 0.0],
    cols: ['#2e2a23', '#6f6656', '#948a75', '#141210'],
    rough: [0.86, 0.99, 0.02, 0.07], mix: [1.0, 0.9, 1.0, 0.0],
  },
  {
    name: 'hole_rubber_a', kind: K.rubber, seed: 214.8,
    p0: [0.12, 0.26, 8.0, 0.7], p1: [0.0, 1.0, 0.0, 0.0],
    cols: ['#161514', '#33302c', '#4a453e', '#080808'],
    rough: [0.55, 0.90, 0.03, 0.05], mix: [1.0, 1.0, 1.15, 0.0],
  },

  /* ── glass: four growth stages ──────────────────────────────────────────── */
  {
    name: 'glass_0', kind: K.glass, seed: 231.1,
    p0: [0.0, 8.0, 2.0, 0.16], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#c8d6dd', '#eef6fa', '#ffffff', '#0d1214'],
    rough: [0.06, 0.42, 0.0, 0.03], mix: [0.6, 0.6, 1.0, 0.0],
  },
  {
    name: 'glass_1', kind: K.glass, seed: 231.1,
    p0: [1.0, 12.0, 3.0, 0.28], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#c8d6dd', '#eef6fa', '#ffffff', '#0d1214'],
    rough: [0.06, 0.46, 0.0, 0.03], mix: [0.6, 0.6, 1.05, 0.0],
  },
  {
    name: 'glass_2', kind: K.glass, seed: 231.1,
    p0: [2.0, 17.0, 4.0, 0.42], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#c5d3da', '#eef6fa', '#ffffff', '#0b0f11'],
    rough: [0.07, 0.52, 0.0, 0.03], mix: [0.7, 0.7, 1.1, 0.0],
  },
  {
    name: 'glass_3', kind: K.glass, seed: 231.1,
    p0: [3.0, 22.0, 5.0, 0.60], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#bfcdd4', '#eef6fa', '#ffffff', '#05080a'],
    rough: [0.08, 0.58, 0.0, 0.03], mix: [0.8, 0.8, 1.15, 0.0],
  },

  /* ── small marks ────────────────────────────────────────────────────────── */
  {
    name: 'blood_drop_a', kind: K.drop, seed: 249.4,
    p0: [0.22, 7.0, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#4a0a0b', '#7c0d10', '#2a0507', '#150203'],
    rough: [0.18, 0.52, 0.0, 0.05], mix: [0.4, 0.5, 0.7, 0.0],
  },
  {
    name: 'scuff_a', kind: K.scuff, seed: 263.7,
    p0: [11.0, 0.55, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#6c6862', '#a7a29a', '#c9c4bb', '#3a3733'],
    rough: [0.45, 0.9, 0.0, 0.06], mix: [0.5, 0.5, 0.7, 0.0],
  },
  {
    name: 'rust_a', kind: K.rust, seed: 277.2,
    p0: [6.0, 0.8, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#5a2f14', '#a35a22', '#c98a45', '#2a1408'],
    rough: [0.72, 0.98, 0.0, 0.06], mix: [0.4, 0.5, 0.6, 0.0],
  },
  {
    name: 'crack_a', kind: K.crack, seed: 291.6,
    p0: [5.0, 0.9, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#6a655d', '#8f8a81', '#b0aba2', '#26231f'],
    rough: [0.74, 0.95, 0.0, 0.05], mix: [1.0, 1.0, 1.0, 0.0],
  },
  {
    name: 'scorch_small', kind: K.scorch, seed: 305.9,
    p0: [0.55, 6.0, 0.9, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#141210', '#2c2723', '#4a423b', '#070606'],
    rough: [0.80, 0.99, 0.0, 0.05], mix: [0.3, 0.4, 0.35, 0.0],
  },

  /* ── footprints & stencils ──────────────────────────────────────────────── */
  {
    name: 'foot_boot_a', kind: K.foot, seed: 319.2,
    p0: [0.0, 5.0, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#3b342b', '#5d5346', '#7d7263', '#1a1611'],
    rough: [0.82, 0.98, 0.0, 0.05], mix: [1.0, 1.0, 1.1, 0.0],
  },
  {
    name: 'foot_boot_b', kind: K.foot, seed: 319.2,
    p0: [1.0, 5.0, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#3b342b', '#5d5346', '#7d7263', '#1a1611'],
    rough: [0.82, 0.98, 0.0, 0.05], mix: [1.0, 1.0, 1.1, 0.0],
  },
  {
    name: 'foot_tread_a', kind: K.foot, seed: 333.8,
    p0: [0.0, 8.0, 1.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#2b2620', '#4c443a', '#6b6153', '#120f0c'],
    rough: [0.84, 0.99, 0.0, 0.05], mix: [1.0, 1.0, 1.2, 0.0],
  },
  {
    name: 'stencil_arrow', kind: K.stencil, seed: 347.1,
    p0: [0.0, 0.72, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#c9b52c', '#e6d564', '#8a7a1c', '#2a2508'],
    rough: [0.42, 0.86, 0.0, 0.06], mix: [0.5, 0.6, 0.8, 0.0],
  },
  {
    name: 'stencil_hazard', kind: K.stencil, seed: 361.4,
    p0: [1.0, 0.62, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#d8d3c8', '#f0ece2', '#8d0f10', '#26231d'],
    rough: [0.40, 0.88, 0.0, 0.06], mix: [0.5, 0.6, 0.8, 0.0],
  },

  /* ── large cells ────────────────────────────────────────────────────────── */
  {
    name: 'scorch_large', kind: K.scorch, big: true, seed: 401.3,
    p0: [0.82, 9.0, 1.25, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#100e0d', '#2a2521', '#574e45', '#050404'],
    rough: [0.82, 0.99, 0.0, 0.05], mix: [0.3, 0.45, 0.4, 0.0],
  },
  {
    name: 'blood_splat_a', kind: K.blood, big: true, seed: 417.6, maskB: true,
    p0: [0.30, 18.0, 0.55, 7.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#59090b', '#8c1013', '#380406', '#1a0203'],
    rough: [0.16, 0.55, 0.0, 0.05], mix: [0.5, 0.6, 0.8, 0.0],
  },
  {
    name: 'blood_splat_b', kind: K.blood, big: true, seed: 433.9, maskB: true,
    p0: [0.24, 26.0, 0.85, 10.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#4e080a', '#7f0e12', '#300406', '#150203'],
    rough: [0.14, 0.58, 0.0, 0.05], mix: [0.5, 0.6, 0.85, 0.0],
  },
  {
    name: 'grime_streak', kind: K.grime, big: true, seed: 451.2,
    p0: [9.0, 0.85, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#2d2a25', '#4a453d', '#6a6459', '#191714'],
    rough: [0.70, 0.97, 0.0, 0.06], mix: [0.3, 0.4, 0.35, 0.0],
  },
  {
    name: 'oil_stain', kind: K.oil, big: true, seed: 467.5,
    p0: [0.62, 5.0, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#0a0908', '#181513', '#2c2723', '#050404'],
    rough: [0.07, 0.42, 0.0, 0.04], mix: [0.3, 0.4, 0.3, 0.0],
  },
  {
    name: 'poster_a', kind: K.poster, big: true, seed: 483.8,
    p0: [0.0, 0.0, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#cfc7b4', '#8f2f24', '#2b3c56', '#4a4438'],
    rough: [0.55, 0.92, 0.0, 0.05], mix: [0.5, 0.6, 0.55, 0.0],
  },
  {
    name: 'graffiti_a', kind: K.graffiti, big: true, seed: 499.1,
    p0: [0.0, 0.0, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#1a2f6e', '#d4d02c', '#c02a6a', '#0d1024'],
    rough: [0.38, 0.9, 0.0, 0.06], mix: [0.3, 0.4, 0.4, 0.0],
  },
  {
    name: 'tyre_mark', kind: K.tyre, big: true, seed: 515.4,
    p0: [7.0, 0.7, 0.0, 0.0], p1: [0.0, 0.0, 0.0, 0.0],
    cols: ['#121110', '#26231f', '#3a352f', '#080807'],
    rough: [0.55, 0.95, 0.0, 0.05], mix: [0.4, 0.5, 0.5, 0.0],
  },
];

/* ═════════════════════════════════════════════════════════════════════ shaders ══ */

// language=GLSL
const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

// language=GLSL
const NOISE_LIB = /* glsl */ `
const float TAU = 6.28318530718;

float hash11( float p ) {
  p = fract( p * 0.1031 );
  p *= p + 33.33;
  return fract( p * ( p + p ) );
}
float hash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 hash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = hash21( i );
  float b = hash21( i + vec2( 1.0, 0.0 ) );
  float c = hash21( i + vec2( 0.0, 1.0 ) );
  float d = hash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float fbm( vec2 p, int oct ) {
  float s = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < 8; i ++ ) {
    if ( i >= oct ) break;
    s += a * vnoise( p );
    n += a;
    a *= 0.5;
    p = p * 2.03 + vec2( 17.1, 9.7 );
  }
  return s / max( 1e-4, n );
}
float ridge( vec2 p, int oct ) {
  float s = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < 8; i ++ ) {
    if ( i >= oct ) break;
    s += a * ( 1.0 - abs( vnoise( p ) * 2.0 - 1.0 ) );
    n += a;
    a *= 0.5;
    p = p * 2.11 + vec2( 5.3, 23.9 );
  }
  return s / max( 1e-4, n );
}
/** x = nearest feature distance, y = second nearest, z = cell hash */
vec3 voro( vec2 p ) {
  vec2 n = floor( p ), f = fract( p );
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for ( int j = -1; j <= 1; j ++ ) {
    for ( int i = -1; i <= 1; i ++ ) {
      vec2 g = vec2( float( i ), float( j ) );
      vec2 o = hash22( n + g );
      float d = length( g + o - f );
      if ( d < f1 ) { f2 = f1; f1 = d; id = hash21( n + g + 3.7 ); }
      else if ( d < f2 ) { f2 = d; }
    }
  }
  return vec3( f1, f2, id );
}
float sdBox( vec2 p, vec2 b ) {
  vec2 d = abs( p ) - b;
  return length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 );
}
float sdSeg( vec2 p, vec2 a, vec2 b ) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp( dot( pa, ba ) / max( 1e-5, dot( ba, ba ) ), 0.0, 1.0 );
  return length( pa - ba * h );
}
/** Radiating hairline cracks around the origin. Returns 0..1 coverage. */
float radialCracks( vec2 q, float seed, float count, float reach, float width ) {
  float r = length( q );
  if ( r < 1e-4 ) return 1.0;
  float a = atan( q.y, q.x ) / TAU + 0.5;
  float best = 0.0;
  for ( int k = 0; k < 32; k ++ ) {
    if ( float( k ) >= count ) break;
    float fk = float( k );
    float base = ( fk + 0.5 ) / count;
    float jitter = ( hash11( fk * 3.13 + seed ) - 0.5 ) * 0.85 / count;
    float ang = base + jitter;
    float len = reach * ( 0.35 + 0.9 * hash11( fk * 7.71 + seed + 1.3 ) );
    // wander: the crack drifts in angle as it travels outwards
    float wob = ( vnoise( vec2( r * 9.0, fk * 4.3 + seed ) ) - 0.5 ) * 0.10;
    float d = abs( fract( a - ang - wob + 0.5 ) - 0.5 );
    float w = ( width * ( 0.35 + 0.65 * hash11( fk * 11.7 + seed ) ) ) / max( 0.05, r * TAU );
    float line = 1.0 - smoothstep( w * 0.45, w, d );
    line *= smoothstep( len, len * 0.45, r );
    best = max( best, line );
  }
  return best;
}
`;

// language=GLSL
const HEIGHT_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
uniform int uKind;
uniform float uSeed;
uniform vec4 uP0;
uniform vec4 uP1;
uniform sampler2D uGrunge;
uniform float uHasGrunge;
layout(location = 0) out vec4 outH;

${NOISE_LIB}

float grunge( vec2 uv, int ch ) {
  if ( uHasGrunge < 0.5 ) return fbm( uv * 5.0 + float( ch ) * 13.0 + uSeed, 4 );
  vec4 g = texture( uGrunge, uv );
  return ch == 0 ? g.r : ( ch == 1 ? g.g : ( ch == 2 ? g.b : g.a ) );
}

/* ── generators ────────────────────────────────────────────────────────────────
 * Every generator writes:
 *   h  height, -1 (deep) .. +1 (proud). 0 = flush with the receiver.
 *   a  coverage alpha.
 *   m1 primary mask — drives roughness and the second palette colour.
 *   m2 secondary mask — drives the third palette colour (dust, soot, bare metal).
 */

/* CRATER — concrete, brick, plaster, tile, asphalt.
 * p0 = ( coreRadius, craterRadius, crackCount, spallAmount )
 * p1 = ( dustHalo, rimStrength, crackDepth, substrate ) */
void genCrater( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float core = uP0.x, crat = uP0.y;
  float r0 = length( q );
  float lump = fbm( q * 3.4 + uSeed, 4 );
  float r = r0 * ( 0.86 + 0.28 * lump );
  h = 0.0;
  h -= 1.0 * smoothstep( core * 1.7, core * 0.15, r );
  h -= 0.52 * smoothstep( crat, core * 0.8, r );
  float rim = exp( -pow( ( r - crat ) / 0.115, 2.0 ) );
  h += uP1.y * 0.34 * rim * ( 0.55 + 0.9 * fbm( q * 8.0 + uSeed * 0.7, 3 ) );
  // spalled chunks around the crater lip
  vec3 v = voro( q * 8.5 + uSeed );
  float chunk = smoothstep( 0.02, 0.30, v.y - v.x );
  h += ( chunk - 0.5 ) * 0.22 * uP0.w * smoothstep( crat + 0.34, crat - 0.08, r );
  float cracks = radialCracks( q, uSeed, uP0.z, 0.94, 0.030 );
  h -= cracks * uP1.z * 0.30;
  float grain = fbm( q * 26.0 + uSeed * 2.0, 3 ) - 0.5;
  h += grain * 0.075;

  float body = smoothstep( crat + 0.42, crat * 0.75, r );
  body = max( body, chunk * smoothstep( crat + 0.46, crat, r ) * 0.9 );
  float dust = smoothstep( 1.02, 0.16, r0 ) * uP1.x;
  dust *= 0.35 + 0.85 * fbm( q * 2.6 + uSeed * 1.7, 4 );
  a = clamp( max( max( body, cracks * 0.92 ), dust * 0.85 ), 0.0, 1.0 );
  m1 = clamp( smoothstep( crat + 0.22, crat * 0.5, r ) * ( 0.45 + 0.7 * chunk ), 0.0, 1.0 );
  m2 = clamp( dust * 1.15 + uP1.w * smoothstep( crat * 0.95, crat * 0.45, r ) * 0.9, 0.0, 1.0 );
  m2 = max( m2, cracks * 0.15 );
}

/* METAL — a punched dimple with a bright torn lip.
 * p0 = ( coreRadius, lipRadius, petals, lipHeight )  p1.x = tearRagged */
void genMetal( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float r0 = length( q );
  float ang = atan( q.y, q.x );
  float petal = 0.5 + 0.5 * sin( ang * uP0.z + fbm( q * 5.0 + uSeed, 3 ) * 5.0 );
  float r = r0 * ( 0.92 + 0.14 * ( petal - 0.5 ) * uP1.x );
  float core = uP0.x, lip = uP0.y;
  h = -1.0 * smoothstep( core * 1.5, core * 0.1, r );
  h -= 0.35 * smoothstep( lip, core, r );
  float lipRing = exp( -pow( ( r - lip * 0.82 ) / 0.055, 2.0 ) );
  h += uP0.w * 0.55 * lipRing * ( 0.4 + 0.85 * petal );
  // hammered dents fanning out from the impact
  h += ( ridge( q * 13.0 + uSeed, 3 ) - 0.55 ) * 0.14 * smoothstep( lip + 0.34, lip, r );
  float paintChip = smoothstep( 0.45, 0.75, fbm( q * 7.0 + uSeed * 3.1, 4 ) );
  paintChip *= smoothstep( lip + 0.30, lip * 0.9, r );

  a = smoothstep( lip + 0.24, lip * 0.85, r );
  a = max( a, paintChip * 0.85 );
  a = max( a, smoothstep( lip + 0.42, lip + 0.05, r ) * 0.22 );
  // bare bright metal on the lip and wherever paint has flaked
  m1 = clamp( lipRing * 1.25 + paintChip * 0.9, 0.0, 1.0 );
  m1 *= 1.0 - smoothstep( core * 1.3, core * 0.4, r );
  // scorched darkening right at the entry
  m2 = clamp( smoothstep( lip * 1.1, core * 0.6, r ) * 0.9, 0.0, 1.0 );
}

/* WOOD — a torn hole with raised splinters and lifted fibre.
 * p0 = ( coreRadius, holeRadius, splinters, splinterLen ) */
void genWood( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float r0 = length( q );
  float ang = atan( q.y, q.x ) / TAU + 0.5;
  float core = uP0.x, hole = uP0.y;
  float count = uP0.z;
  float spl = 0.0, splH = 0.0;
  for ( int k = 0; k < 24; k ++ ) {
    if ( float( k ) >= count ) break;
    float fk = float( k );
    float base = ( fk + 0.5 ) / count + ( hash11( fk * 5.1 + uSeed ) - 0.5 ) * 0.7 / count;
    float len = hole * ( 0.9 + uP0.w * 1.7 * hash11( fk * 9.3 + uSeed ) );
    float wid = 0.014 + 0.024 * hash11( fk * 2.7 + uSeed );
    float d = abs( fract( ang - base + 0.5 ) - 0.5 );
    float w = wid / max( 0.04, r0 * TAU ) * ( 1.0 - smoothstep( 0.0, len, r0 ) * 0.6 );
    float s = ( 1.0 - smoothstep( w * 0.4, w, d ) ) * smoothstep( len, len * 0.3, r0 );
    spl = max( spl, s );
    splH = max( splH, s * ( 0.35 + 0.65 * hash11( fk * 13.7 + uSeed ) ) );
  }
  h = -1.0 * smoothstep( core * 1.6, core * 0.1, r0 );
  h -= 0.42 * smoothstep( hole, core, r0 );
  h += splH * 0.42 * smoothstep( core * 0.9, hole * 1.1, r0 );
  // grain ridges running across the plank
  h += ( ridge( vec2( q.x * 3.0, q.y * 30.0 ) + uSeed, 3 ) - 0.5 ) * 0.11;

  a = smoothstep( hole + 0.16, hole * 0.72, r0 );
  a = max( a, spl * 0.95 );
  a = max( a, smoothstep( hole + 0.40, hole, r0 ) * 0.18 );
  m1 = clamp( splH * 1.2 + smoothstep( hole * 1.2, hole * 0.5, r0 ) * 0.35, 0.0, 1.0 );
  m1 *= 1.0 - smoothstep( core * 1.4, core * 0.5, r0 );
  m2 = clamp( splH * 0.85, 0.0, 1.0 );
}

/* SOFT — dirt, sand, snow: a shallow crater with an ejecta ring.
 * p0 = ( craterRadius, rimRadius, rimHeight, ejecta ) */
void genSoft( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float lump = fbm( q * 2.6 + uSeed, 4 );
  float r = length( q ) * ( 0.82 + 0.36 * lump );
  float crat = uP0.x, rim = uP0.y;
  h = -0.72 * smoothstep( crat, 0.0, r );
  h += uP0.z * exp( -pow( ( r - rim ) / 0.17, 2.0 ) ) * ( 0.5 + 0.9 * fbm( q * 6.0 + uSeed, 3 ) );
  vec3 v = voro( q * 16.0 + uSeed );
  float clods = smoothstep( 0.55, 0.12, v.x ) * uP0.w;
  clods *= smoothstep( rim + 0.55, rim - 0.1, r );
  h += clods * 0.20;
  h += ( fbm( q * 22.0 + uSeed, 3 ) - 0.5 ) * 0.09;

  a = smoothstep( rim + 0.44, rim * 0.55, r );
  a = max( a, clods * 0.75 );
  a *= 0.55 + 0.7 * fbm( q * 4.5 + uSeed * 1.3, 3 );
  a = clamp( a, 0.0, 1.0 );
  m1 = clamp( smoothstep( crat * 1.4, 0.0, r ) * 0.95, 0.0, 1.0 );
  m2 = clamp( clods * 1.1 + smoothstep( rim + 0.3, rim * 0.8, r ) * 0.35, 0.0, 1.0 );
}

/* FABRIC — a frayed tear with lifted threads. */
void genFabric( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float r0 = length( q );
  float ang = atan( q.y, q.x ) / TAU + 0.5;
  float core = uP0.x, hole = uP0.y;
  float fr = 0.0;
  for ( int k = 0; k < 24; k ++ ) {
    if ( float( k ) >= uP0.z ) break;
    float fk = float( k );
    float base = ( fk + 0.5 ) / uP0.z + ( hash11( fk * 4.7 + uSeed ) - 0.5 ) * 0.9 / uP0.z;
    float len = hole * ( 1.0 + uP0.w * 1.4 * hash11( fk * 8.1 + uSeed ) );
    float d = abs( fract( ang - base + 0.5 ) - 0.5 );
    float w = 0.010 / max( 0.04, r0 * TAU );
    fr = max( fr, ( 1.0 - smoothstep( w * 0.4, w, d ) ) * smoothstep( len, len * 0.2, r0 ) );
  }
  h = -0.85 * smoothstep( core * 1.5, 0.0, r0 ) + fr * 0.30;
  h += ( vnoise( q * 42.0 + uSeed ) - 0.5 ) * 0.10;
  a = smoothstep( hole + 0.10, hole * 0.6, r0 );
  a = max( a, fr * 0.9 );
  m1 = clamp( fr, 0.0, 1.0 );
  m2 = clamp( smoothstep( hole, core, r0 ) * 0.7, 0.0, 1.0 );
}

/* RUBBER — a clean punched hole with a slightly proud, matte lip. */
void genRubber( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float r = length( q ) * ( 0.94 + 0.10 * fbm( q * 6.0 + uSeed, 3 ) );
  float core = uP0.x, hole = uP0.y;
  h = -1.0 * smoothstep( core * 1.5, 0.0, r );
  h += 0.28 * exp( -pow( ( r - hole * 0.85 ) / 0.06, 2.0 ) );
  h += ( vnoise( q * 30.0 + uSeed ) - 0.5 ) * 0.06;
  a = smoothstep( hole + 0.12, hole * 0.7, r );
  m1 = clamp( smoothstep( hole * 1.1, core, r ), 0.0, 1.0 );
  m2 = clamp( smoothstep( core * 1.6, core * 0.4, r ), 0.0, 1.0 );
}

/* GLASS — a spiderweb that grows with the stage.
 * p0 = ( stage, radialCount, ringCount, reach ) */
void genGlass( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float stage = uP0.x;
  float r = length( q );
  float ang = atan( q.y, q.x ) / TAU + 0.5;
  float reach = uP0.w;
  float web = 0.0;

  // radial fractures
  for ( int k = 0; k < 24; k ++ ) {
    if ( float( k ) >= uP0.y ) break;
    float fk = float( k );
    float base = ( fk + 0.5 ) / uP0.y + ( hash11( fk * 6.7 + uSeed ) - 0.5 ) * 0.9 / uP0.y;
    float len = reach * ( 0.55 + 1.5 * hash11( fk * 3.3 + uSeed + 2.0 ) );
    float wob = ( vnoise( vec2( r * 7.0, fk * 5.9 + uSeed ) ) - 0.5 ) * 0.055;
    float d = abs( fract( ang - base - wob + 0.5 ) - 0.5 );
    float w = 0.0085 / max( 0.03, r * TAU );
    float line = ( 1.0 - smoothstep( w * 0.35, w, d ) ) * smoothstep( len, len * 0.15, r );
    web = max( web, line );
  }
  // concentric ring fractures, polygonal because they hop between radials
  for ( int k = 0; k < 6; k ++ ) {
    if ( float( k ) >= uP0.z ) break;
    float fk = float( k );
    float rr = reach * ( 0.16 + 0.30 * fk ) * ( 0.8 + 0.5 * hash11( fk * 9.1 + uSeed ) );
    float poly = 0.020 * sin( ang * TAU * ( uP0.y * 0.5 ) + uSeed );
    float d = abs( r - rr + poly );
    float seg = step( 0.30, hash21( vec2( floor( ang * uP0.y ), fk + uSeed ) ) );
    web = max( web, ( 1.0 - smoothstep( 0.004, 0.011, d ) ) * seg * smoothstep( reach * 1.25, reach * 0.2, r ) );
  }
  float crushed = smoothstep( 0.075 + stage * 0.016, 0.0, r );
  float frost = smoothstep( 0.16 + stage * 0.05, 0.0, r ) * ( 0.35 + 0.65 * fbm( q * 24.0 + uSeed, 4 ) );
  float punched = stage > 2.5 ? smoothstep( 0.055, 0.018, r ) : 0.0;

  h = -0.85 * crushed - 0.35 * web * 0.5 - punched;
  h += ( fbm( q * 30.0 + uSeed, 3 ) - 0.5 ) * 0.06 * frost;
  a = clamp( max( max( web, crushed ), max( frost * 0.72, punched ) ), 0.0, 1.0 );
  m1 = clamp( web * 0.9 + frost * 0.7, 0.0, 1.0 );
  m2 = clamp( crushed * 1.1 + frost * 0.5, 0.0, 1.0 );
  // the punched-through core reads as a dark void
  m1 *= 1.0 - punched;
  m2 *= 1.0 - punched;
}

/* SCORCH — soft radial soot with directional streaking.
 * p0 = ( radius, streaks, density ) */
void genScorch( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float r = length( q );
  float ang = atan( q.y, q.x ) / TAU + 0.5;
  float wob = fbm( vec2( ang * 7.0, r * 2.0 ) * 1.4 + uSeed, 5 );
  float rr = r * ( 0.72 + 0.55 * wob );
  float core = smoothstep( uP0.x, 0.0, rr );
  float streak = fbm( vec2( ang * uP0.y, r * 3.4 ) + uSeed * 1.9, 5 );
  float soot = core * ( 0.45 + 0.85 * streak ) * uP0.z;
  soot = clamp( soot, 0.0, 1.0 );
  // a hotter, lighter ash ring at the outside
  float ash = smoothstep( uP0.x * 1.0, uP0.x * 0.55, rr ) * smoothstep( uP0.x * 0.45, uP0.x * 0.8, rr );
  h = -0.05 * soot + ( fbm( q * 18.0 + uSeed, 3 ) - 0.5 ) * 0.05 * soot;
  a = clamp( soot * 1.15, 0.0, 1.0 );
  m1 = clamp( soot * 1.2, 0.0, 1.0 );
  m2 = clamp( ash * 0.85 * ( 0.4 + 0.8 * streak ), 0.0, 1.0 );
}

/* BLOOD — a splat at the top of the cell, drips running down the rest of it.
 * p0 = ( poolRadius, droplets, directionality, drips )
 * m2 carries the drip *reveal parameter*: the decal shader compares it against the
 * instance's drip progress so the runs grow downwards over time. */
void genBlood( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  vec2 c = vec2( 0.0, 0.42 );      // splat centre, near the top of the cell
  vec2 d = q - c;
  float dirScale = 1.0 + uP0.z;
  vec2 ds = vec2( d.x / dirScale, d.y );
  float wob = fbm( ds * 4.0 + uSeed, 4 );
  float pool = smoothstep( uP0.x * ( 0.7 + 0.7 * wob ), 0.0, length( ds ) );

  // tendrils flicked outwards along the impact direction
  float tend = 0.0;
  for ( int k = 0; k < 32; k ++ ) {
    if ( float( k ) >= uP0.y ) break;
    float fk = float( k );
    float ang = hash11( fk * 3.9 + uSeed ) * TAU;
    float len = uP0.x * ( 0.9 + 2.6 * hash11( fk * 7.3 + uSeed ) );
    vec2 dir = vec2( cos( ang ) * dirScale, sin( ang ) );
    vec2 tip = c + dir * len;
    float w = 0.006 + 0.018 * hash11( fk * 11.9 + uSeed );
    float dd = sdSeg( q, c + dir * uP0.x * 0.4, tip );
    tend = max( tend, 1.0 - smoothstep( w * 0.5, w * 1.6, dd ) );
    // the droplet at the end of each flick
    float dr = 0.008 + 0.026 * hash11( fk * 5.5 + uSeed );
    tend = max( tend, 1.0 - smoothstep( dr * 0.7, dr, length( q - tip ) ) );
  }

  // runs
  float drip = 0.0, dripParam = 1.0;
  for ( int k = 0; k < 16; k ++ ) {
    if ( float( k ) >= uP0.w ) break;
    float fk = float( k );
    float x = ( hash11( fk * 2.3 + uSeed ) - 0.5 ) * uP0.x * 2.4;
    float top = c.y - uP0.x * ( 0.2 + 0.5 * hash11( fk * 6.1 + uSeed ) );
    float len = 0.35 + 0.95 * hash11( fk * 8.7 + uSeed );
    float bottom = top - len;
    float w = 0.010 + 0.020 * hash11( fk * 13.1 + uSeed );
    float wander = ( vnoise( vec2( q.y * 5.0, fk * 3.1 + uSeed ) ) - 0.5 ) * 0.05;
    float dd = abs( q.x - x - wander );
    float taper = w * ( 0.35 + 0.65 * smoothstep( bottom, top, q.y ) );
    float col = ( 1.0 - smoothstep( taper * 0.6, taper, dd ) ) * step( q.y, top ) * step( bottom, q.y );
    // bulbous head at the leading edge
    float head = 1.0 - smoothstep( w * 1.1, w * 1.9, length( vec2( q.x - x - wander, ( q.y - bottom ) * 0.75 ) ) );
    float m = max( col, head );
    if ( m > drip ) {
      drip = m;
      dripParam = clamp( ( top - q.y ) / max( 1e-3, len ), 0.0, 1.0 );
    }
  }

  float body = clamp( max( pool, tend ), 0.0, 1.0 );
  h = -0.10 * body - 0.06 * drip + ( fbm( q * 25.0 + uSeed, 3 ) - 0.5 ) * 0.05;
  h += 0.12 * smoothstep( 0.4, 0.9, pool );
  a = clamp( max( body, drip ), 0.0, 1.0 );
  // m1: thickness -> darker, glossier centre
  m1 = clamp( pool * 1.15 + drip * 0.55, 0.0, 1.0 );
  // m2: drip reveal parameter. 0 everywhere the splat itself is.
  m2 = body > 0.02 ? 0.0 : dripParam * step( 0.02, drip );
}

/* DROP — a single small spatter cluster. */
void genDrop( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float pool = smoothstep( uP0.x * ( 0.7 + 0.6 * fbm( q * 5.0 + uSeed, 4 ) ), 0.0, length( q ) );
  float sat = 0.0;
  for ( int k = 0; k < 16; k ++ ) {
    if ( float( k ) >= uP0.y ) break;
    float fk = float( k );
    float ang = hash11( fk * 4.1 + uSeed ) * TAU;
    float rad = uP0.x * ( 1.3 + 2.2 * hash11( fk * 9.7 + uSeed ) );
    vec2 p = vec2( cos( ang ), sin( ang ) ) * rad;
    float s = 0.008 + 0.022 * hash11( fk * 6.3 + uSeed );
    sat = max( sat, 1.0 - smoothstep( s * 0.7, s, length( q - p ) ) );
  }
  h = -0.05 * pool + 0.10 * smoothstep( 0.5, 1.0, pool );
  a = clamp( max( pool, sat ), 0.0, 1.0 );
  m1 = clamp( pool * 1.2, 0.0, 1.0 );
  m2 = clamp( sat * 0.6, 0.0, 1.0 );
}

/* FOOT — a boot sole pressed into dust or mud.
 * p0 = ( mirror, lugRows, deepTread ) */
void genFoot( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  vec2 p = q;
  if ( uP0.x > 0.5 ) p.x = -p.x;
  p.x *= 2.15;                                    // the cell is square, the boot is not
  // forefoot + heel
  float fore = sdBox( p - vec2( 0.0, 0.34 ), vec2( 0.52, 0.42 ) ) - 0.34;
  fore = min( fore, length( ( p - vec2( 0.0, 0.66 ) ) / vec2( 1.0, 0.78 ) ) - 0.55 );
  float heel = length( ( p - vec2( 0.0, -0.55 ) ) / vec2( 0.92, 1.0 ) ) - 0.44;
  float sole = min( fore, heel );
  float inside = 1.0 - smoothstep( -0.02, 0.045, sole );

  // tread: chevron lugs on the forefoot, blocks on the heel
  float chev = abs( fract( p.y * uP0.y - abs( p.x ) * 1.2 ) - 0.5 ) * 2.0;
  float lug = smoothstep( 0.30, 0.62, chev );
  float blocks = step( 0.35, fract( p.y * 5.0 ) ) * step( 0.30, fract( p.x * 3.0 + 0.5 ) );
  float tread = mix( blocks, lug, smoothstep( -0.15, 0.05, p.y ) );

  float depth = inside * ( 0.55 + 0.45 * tread ) * ( 0.7 + 0.5 * uP0.z );
  h = -depth;
  h += smoothstep( 0.055, -0.005, sole ) * ( 1.0 - inside ) * 0.22;   // squeezed rim
  h += ( fbm( q * 22.0 + uSeed, 3 ) - 0.5 ) * 0.08;
  a = inside * ( 0.55 + 0.55 * tread );
  a *= 0.7 + 0.55 * fbm( q * 6.0 + uSeed * 1.4, 4 );
  a = clamp( a, 0.0, 1.0 );
  m1 = clamp( inside * tread, 0.0, 1.0 );
  m2 = clamp( smoothstep( 0.10, -0.02, sole ) * ( 1.0 - inside ) * 0.8, 0.0, 1.0 );
}

/* TYRE — a strip of tread laid down under braking. p0 = ( blocks, contrast ) */
void genTyre( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float across = clamp( 1.0 - abs( q.x ) * 1.15, 0.0, 1.0 );
  float edge = smoothstep( 0.0, 0.22, across );
  float row = fract( q.y * uP0.x + 0.5 * step( 0.5, fract( q.x * 2.0 + 0.25 ) ) );
  float block = smoothstep( 0.10, 0.24, row ) * smoothstep( 0.90, 0.76, row );
  float grip = mix( 0.45, 1.0, block );
  float smear = fbm( vec2( q.x * 5.0, q.y * 1.6 ) + uSeed, 5 );
  float lay = edge * ( 0.35 + 0.9 * smear ) * grip * uP0.y;
  h = -0.05 * lay;
  a = clamp( lay * 1.25, 0.0, 1.0 );
  m1 = clamp( block * edge, 0.0, 1.0 );
  m2 = clamp( ( 1.0 - block ) * edge * smear * 0.7, 0.0, 1.0 );
}

/* GRIME — weathering streaks running down from the top edge. p0 = ( streaks, density ) */
void genGrime( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float t = q.y * 0.5 + 0.5;                     // 1 at the top
  float streak = 0.0;
  for ( int k = 0; k < 16; k ++ ) {
    if ( float( k ) >= uP0.x ) break;
    float fk = float( k );
    float x = ( hash11( fk * 3.7 + uSeed ) - 0.5 ) * 1.9;
    float w = 0.03 + 0.16 * hash11( fk * 8.9 + uSeed );
    float len = 0.35 + 0.75 * hash11( fk * 5.3 + uSeed );
    float wander = ( vnoise( vec2( q.y * 2.2, fk * 4.4 + uSeed ) ) - 0.5 ) * 0.16;
    float d = abs( q.x - x - wander ) / w;
    float s = exp( -d * d * 1.6 ) * smoothstep( 1.0 - len, 1.0, t );
    streak = max( streak, s );
  }
  float blotch = fbm( q * 2.3 + uSeed * 1.6, 5 );
  float dirt = clamp( streak * ( 0.5 + 0.9 * fbm( vec2( q.x * 9.0, q.y * 2.2 ) + uSeed, 4 ) ), 0.0, 1.0 );
  dirt = max( dirt, smoothstep( 0.62, 0.95, blotch ) * 0.55 );
  dirt *= uP0.y;
  h = -0.03 * dirt;
  a = clamp( dirt, 0.0, 1.0 );
  m1 = clamp( dirt * 1.1, 0.0, 1.0 );
  m2 = clamp( smoothstep( 0.55, 0.9, blotch ) * dirt, 0.0, 1.0 );
}

/* OIL — a slick puddle with a glossy centre and satellite drips. */
void genOil( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float wob = fbm( q * 2.1 + uSeed, 5 );
  float r = length( q * vec2( 1.0, 1.22 ) ) * ( 0.72 + 0.62 * wob );
  float pool = smoothstep( uP0.x, uP0.x * 0.25, r );
  float sat = 0.0;
  for ( int k = 0; k < 8; k ++ ) {
    if ( float( k ) >= uP0.y ) break;
    float fk = float( k );
    vec2 p = ( hash22( vec2( fk, uSeed ) ) - 0.5 ) * 1.7;
    float s = 0.03 + 0.09 * hash11( fk * 7.1 + uSeed );
    sat = max( sat, smoothstep( s, s * 0.3, length( q - p ) ) );
  }
  float film = clamp( max( pool, sat * 0.9 ), 0.0, 1.0 );
  h = -0.02 * film;
  a = film;
  m1 = clamp( pool * 1.2, 0.0, 1.0 );            // glossiest in the middle
  m2 = clamp( ( 1.0 - pool ) * film * 1.4, 0.0, 1.0 );
}

/* POSTER — flyposted paper, torn at the corners, printed and sun-bleached. */
void genPoster( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  vec2 half_ = vec2( 0.66, 0.88 );
  float tear = ( fbm( q * 9.0 + uSeed, 4 ) - 0.5 ) * 0.075;
  float paper = 1.0 - smoothstep( -0.01, 0.02, sdBox( q, half_ ) + tear );
  // one corner peeled away
  float peel = 1.0 - smoothstep( 0.0, 0.06, sdSeg( q, vec2( 0.28, 0.88 ), vec2( 0.70, 0.42 ) ) - 0.06 );
  paper *= 1.0 - step( 0.5, peel ) * step( 0.30, q.x ) * step( 0.40, q.y );

  // print: a big block, a banner and text bars
  vec2 p = ( q + half_ ) / ( half_ * 2.0 );
  float band = smoothstep( 0.62, 0.64, p.y ) * smoothstep( 0.90, 0.88, p.y );
  float disc = 1.0 - smoothstep( 0.20, 0.215, length( ( p - vec2( 0.5, 0.70 ) ) * vec2( 1.0, 1.35 ) ) );
  float bars = 0.0;
  for ( int k = 0; k < 7; k ++ ) {
    float fk = float( k );
    float y = 0.50 - fk * 0.058;
    float w = 0.14 + 0.24 * hash11( fk * 5.7 + uSeed );
    bars = max( bars, ( 1.0 - smoothstep( 0.010, 0.014, abs( p.y - y ) ) ) *
      step( 0.14, p.x ) * step( p.x, 0.14 + w ) );
  }
  float ink = clamp( max( band * 0.9, max( disc, bars * 0.8 ) ), 0.0, 1.0 ) * paper;
  float accent = disc * paper;

  float wrinkle = ( ridge( q * 6.0 + uSeed, 4 ) - 0.5 ) * 0.35;
  h = paper * ( 0.16 + wrinkle * 0.5 );
  float bleach = fbm( q * 3.0 + uSeed * 2.2, 4 );
  a = paper * ( 0.94 + 0.06 * bleach );
  m1 = ink;
  m2 = accent * 0.9 + ( 1.0 - ink ) * paper * smoothstep( 0.65, 0.95, bleach ) * 0.35;
}

/* GRAFFITI — spray strokes with overspray speckle. */
void genGraffiti( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float ink = 0.0, accent = 0.0;
  for ( int k = 0; k < 7; k ++ ) {
    float fk = float( k );
    vec2 a0 = ( hash22( vec2( fk * 1.7, uSeed ) ) - 0.5 ) * vec2( 1.7, 1.3 );
    vec2 a1 = ( hash22( vec2( fk * 3.1, uSeed + 4.0 ) ) - 0.5 ) * vec2( 1.9, 1.4 );
    vec2 mid = ( a0 + a1 ) * 0.5 + ( hash22( vec2( fk * 5.9, uSeed + 8.0 ) ) - 0.5 ) * 0.7;
    // two-segment polyline stands in for a curve
    float d = min( sdSeg( q, a0, mid ), sdSeg( q, mid, a1 ) );
    float w = 0.045 + 0.055 * hash11( fk * 9.3 + uSeed );
    float s = 1.0 - smoothstep( w * 0.75, w * 1.25, d );
    if ( hash11( fk * 13.9 + uSeed ) > 0.62 ) accent = max( accent, s );
    else ink = max( ink, s );
    // overspray haze
    ink = max( ink, ( 1.0 - smoothstep( w, w * 3.2, d ) ) * 0.22 *
      smoothstep( 0.35, 0.85, fbm( q * 26.0 + fk + uSeed, 3 ) ) );
  }
  float speck = smoothstep( 0.60, 0.95, fbm( q * 34.0 + uSeed * 3.0, 3 ) ) * 0.35;
  float cover = clamp( max( ink, accent ) + speck * 0.5, 0.0, 1.0 );
  h = cover * 0.05 + ( vnoise( q * 40.0 + uSeed ) - 0.5 ) * 0.03;
  a = cover;
  m1 = clamp( ink, 0.0, 1.0 );
  m2 = clamp( accent, 0.0, 1.0 );
}

/* STENCIL — sprayed warning markings, half worn away. p0 = ( variant, wear ) */
void genStencil( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float shape = 0.0, accent = 0.0;
  if ( uP0.x < 0.5 ) {
    // directional arrow
    vec2 p = q;
    float shaft = 1.0 - smoothstep( 0.0, 0.02, sdBox( p - vec2( 0.0, -0.18 ), vec2( 0.14, 0.44 ) ) );
    float head = 1.0 - smoothstep( 0.0, 0.02,
      max( abs( p.x ) * 0.86 + ( p.y - 0.62 ) * 0.5, -( p.y - 0.20 ) ) - 0.30 );
    shape = max( shaft, head );
    // stencil bridges
    shape *= 1.0 - ( 1.0 - smoothstep( 0.0, 0.012, abs( p.y - 0.16 ) - 0.022 ) ) * step( abs( p.x ), 0.2 );
  } else {
    // hazard triangle with a bang
    vec2 p = q * 1.05;
    float tri = max( max( abs( p.x ) * 0.87 + p.y * 0.5, -p.y ) - 0.42,
      -( max( abs( p.x ) * 0.87 + p.y * 0.5, -p.y ) - 0.30 ) );
    shape = 1.0 - smoothstep( 0.0, 0.02, tri );
    float bang = 1.0 - smoothstep( 0.0, 0.02, sdBox( p - vec2( 0.0, 0.02 ), vec2( 0.045, 0.18 ) ) );
    bang = max( bang, 1.0 - smoothstep( 0.0, 0.02, length( p - vec2( 0.0, -0.24 ) ) - 0.055 ) );
    accent = bang;
    shape = max( shape, bang );
  }
  float wear = smoothstep( uP0.y - 0.18, uP0.y + 0.22, fbm( q * 8.0 + uSeed, 5 ) );
  float paint = shape * ( 1.0 - wear * 0.85 );
  h = paint * 0.10;
  a = clamp( paint, 0.0, 1.0 );
  m1 = clamp( paint, 0.0, 1.0 );
  m2 = clamp( accent * paint, 0.0, 1.0 );
}

/* SCUFF — a cluster of shallow scratches. p0 = ( count, length ) */
void genScuff( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float s = 0.0;
  for ( int k = 0; k < 24; k ++ ) {
    if ( float( k ) >= uP0.x ) break;
    float fk = float( k );
    float ang = ( hash11( fk * 2.9 + uSeed ) - 0.5 ) * 1.1 + 0.35;
    vec2 dir = vec2( cos( ang ), sin( ang ) );
    vec2 c = ( hash22( vec2( fk * 4.3, uSeed ) ) - 0.5 ) * 1.5;
    float len = uP0.y * ( 0.3 + 0.9 * hash11( fk * 6.7 + uSeed ) );
    float d = sdSeg( q, c - dir * len, c + dir * len );
    float w = 0.004 + 0.010 * hash11( fk * 8.3 + uSeed );
    s = max( s, ( 1.0 - smoothstep( w * 0.5, w * 1.4, d ) ) *
      ( 0.4 + 0.6 * vnoise( q * 30.0 + fk ) ) );
  }
  h = -s * 0.35;
  a = clamp( s, 0.0, 1.0 );
  m1 = clamp( s, 0.0, 1.0 );
  m2 = 0.0;
}

/* RUST — a bleed running down from a fixing. p0 = ( streaks, density ) */
void genRust( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float t = q.y * 0.5 + 0.5;
  float src = 1.0 - smoothstep( 0.05, 0.14, length( q - vec2( 0.0, 0.72 ) ) );
  float streak = 0.0;
  for ( int k = 0; k < 12; k ++ ) {
    if ( float( k ) >= uP0.x ) break;
    float fk = float( k );
    float x = ( hash11( fk * 3.3 + uSeed ) - 0.5 ) * 0.55;
    float w = 0.02 + 0.07 * hash11( fk * 7.9 + uSeed );
    float wander = ( vnoise( vec2( q.y * 3.0, fk * 5.1 + uSeed ) ) - 0.5 ) * 0.12;
    float d = abs( q.x - x - wander ) / w;
    streak = max( streak, exp( -d * d ) * smoothstep( 0.0, 0.45, 0.95 - t ) * smoothstep( 0.95, 0.7, t ) );
  }
  float rustAmt = clamp( max( src, streak * ( 0.5 + 0.8 * fbm( vec2( q.x * 14.0, q.y * 3.0 ) + uSeed, 4 ) ) ), 0.0, 1.0 );
  rustAmt *= uP0.y;
  h = ( fbm( q * 24.0 + uSeed, 3 ) - 0.5 ) * 0.09 * rustAmt + src * 0.12;
  a = rustAmt;
  m1 = clamp( rustAmt * 1.2, 0.0, 1.0 );
  m2 = clamp( src * 0.9 + smoothstep( 0.55, 0.95, fbm( q * 11.0 + uSeed, 4 ) ) * rustAmt * 0.6, 0.0, 1.0 );
}

/* CRACK — a static structural crack for level dressing. p0 = ( branches, reach ) */
void genCrack( vec2 q, out float h, out float a, out float m1, out float m2 ) {
  float c = 0.0;
  vec2 prev = vec2( -0.9, -0.55 );
  for ( int k = 1; k <= 6; k ++ ) {
    float fk = float( k );
    vec2 next = vec2( -0.9 + 0.36 * fk, -0.55 + ( hash11( fk * 4.7 + uSeed ) - 0.4 ) * 0.85 );
    float d = sdSeg( q, prev, next );
    c = max( c, 1.0 - smoothstep( 0.006, 0.017, d ) );
    // a branch off every other node
    if ( hash11( fk * 9.1 + uSeed ) > 0.45 ) {
      vec2 br = next + ( hash22( vec2( fk, uSeed ) ) - 0.5 ) * vec2( 0.5, 0.9 );
      c = max( c, ( 1.0 - smoothstep( 0.004, 0.012, sdSeg( q, next, br ) ) ) * 0.8 );
    }
    prev = next;
  }
  c *= uP0.y;
  h = -c * 0.7;
  a = clamp( c * 1.1, 0.0, 1.0 );
  m1 = clamp( c, 0.0, 1.0 );
  m2 = clamp( c * 0.4, 0.0, 1.0 );
}

void main() {
  vec2 uv = vUv;
  vec2 q = uv * 2.0 - 1.0;
  float h = 0.0, a = 0.0, m1 = 0.0, m2 = 0.0;

  if      ( uKind == ${K.crater} )   genCrater( q, h, a, m1, m2 );
  else if ( uKind == ${K.metal} )    genMetal( q, h, a, m1, m2 );
  else if ( uKind == ${K.wood} )     genWood( q, h, a, m1, m2 );
  else if ( uKind == ${K.soft} )     genSoft( q, h, a, m1, m2 );
  else if ( uKind == ${K.fabric} )   genFabric( q, h, a, m1, m2 );
  else if ( uKind == ${K.glass} )    genGlass( q, h, a, m1, m2 );
  else if ( uKind == ${K.scorch} )   genScorch( q, h, a, m1, m2 );
  else if ( uKind == ${K.blood} )    genBlood( q, h, a, m1, m2 );
  else if ( uKind == ${K.foot} )     genFoot( q, h, a, m1, m2 );
  else if ( uKind == ${K.tyre} )     genTyre( q, h, a, m1, m2 );
  else if ( uKind == ${K.grime} )    genGrime( q, h, a, m1, m2 );
  else if ( uKind == ${K.oil} )      genOil( q, h, a, m1, m2 );
  else if ( uKind == ${K.poster} )   genPoster( q, h, a, m1, m2 );
  else if ( uKind == ${K.graffiti} ) genGraffiti( q, h, a, m1, m2 );
  else if ( uKind == ${K.stencil} )  genStencil( q, h, a, m1, m2 );
  else if ( uKind == ${K.scuff} )    genScuff( q, h, a, m1, m2 );
  else if ( uKind == ${K.rust} )     genRust( q, h, a, m1, m2 );
  else if ( uKind == ${K.rubber} )   genRubber( q, h, a, m1, m2 );
  else if ( uKind == ${K.drop} )     genDrop( q, h, a, m1, m2 );
  else if ( uKind == ${K.crack} )    genCrack( q, h, a, m1, m2 );

  // A hard gutter so neighbouring cells never bleed into each other through the mips.
  float b = min( min( uv.x, 1.0 - uv.x ), min( uv.y, 1.0 - uv.y ) );
  a *= smoothstep( 0.008, 0.055, b );

  // A trace of large-scale grunge stops every instance of a cell reading identically
  // once it is rotated and overlapped in the world.
  a *= 0.90 + 0.14 * grunge( uv * 0.83 + uSeed * 0.017, 1 );

  outH = vec4( clamp( h, -1.0, 1.0 ), clamp( a, 0.0, 1.0 ), clamp( m1, 0.0, 1.0 ), clamp( m2, 0.0, 1.0 ) );
}
`;

// language=GLSL
const RESOLVE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec4 uRect;         // cell rect in atlas UV space
uniform vec2 uTexel;        // 1 / atlas resolution
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec4 uRough;        // ( roughBase, roughMask, maskBias, jitter )
uniform vec4 uMix;          // ( cavityWeight, aoStrength, normalStrength, heightBias )
uniform float uSeed;
uniform float uSrgbManual;
uniform float uStoreMask;   // 1 -> pack mask2 into the roughness slot (drip reveal)
layout(location = 0) out vec4 gAlbedo;
layout(location = 1) out vec4 gNrm;

vec4 tap( vec2 local ) {
  vec2 c = clamp( local, vec2( 0.0015 ), vec2( 0.9985 ) );
  return texture( uSrc, uRect.xy + c * uRect.zw );
}

void main() {
  vec2 uv = vUv;
  vec4 s = tap( uv );
  float h = s.x;
  float alpha = s.y;
  float m1 = s.z;
  float m2 = s.w;

  // Sobel on the height field. The step is one atlas texel expressed in cell space.
  vec2 e = uTexel / max( uRect.zw, vec2( 1e-5 ) );
  float hL = tap( uv - vec2( e.x, 0.0 ) ).x;
  float hR = tap( uv + vec2( e.x, 0.0 ) ).x;
  float hD = tap( uv - vec2( 0.0, e.y ) ).x;
  float hU = tap( uv + vec2( 0.0, e.y ) ).x;
  float hL2 = tap( uv - vec2( e.x * 2.5, 0.0 ) ).x;
  float hR2 = tap( uv + vec2( e.x * 2.5, 0.0 ) ).x;
  float hD2 = tap( uv - vec2( 0.0, e.y * 2.5 ) ).x;
  float hU2 = tap( uv + vec2( 0.0, e.y * 2.5 ) ).x;

  float sc = uMix.z * 1.35;
  vec3 n = normalize( vec3(
    -( ( hR - hL ) * 0.66 + ( hR2 - hL2 ) * 0.34 ) * sc * 22.0,
    -( ( hU - hD ) * 0.66 + ( hU2 - hD2 ) * 0.34 ) * sc * 22.0,
    1.0
  ) );

  // Cavity occlusion: how much lower this texel sits than its wider neighbourhood.
  float wide = ( hL2 + hR2 + hD2 + hU2 + hL + hR + hD + hU ) * 0.125;
  float cav = clamp( ( wide - h ) * 2.2, 0.0, 1.0 );
  float ao = clamp( 1.0 - uMix.y * ( cav * 0.75 + clamp( -h, 0.0, 1.0 ) * 0.55 ), 0.05, 1.0 );

  vec3 col = mix( uC0, uC1, clamp( m1, 0.0, 1.0 ) );
  col = mix( col, uC2, clamp( m2, 0.0, 1.0 ) );
  col = mix( col, uC3, clamp( -h * uMix.x, 0.0, 1.0 ) );
  // AO is baked in at 70%; the rest is applied to indirect light at draw time.
  col *= mix( 1.0, ao, 0.7 );
  // fine albedo break-up so no decal is ever a flat colour
  float grain = fract( sin( dot( uv * 512.0 + uSeed, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  col *= 0.94 + 0.12 * grain;

  float rough = clamp( mix( uRough.x, uRough.y, m1 ) + uRough.z * m2 +
    ( grain - 0.5 ) * uRough.w, 0.03, 1.0 );

  if ( uSrgbManual > 0.5 ) col = pow( max( col, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );

  // Cells that animate (blood runs) trade the roughness slot for their reveal mask;
  // those instances carry a constant roughness in their per-instance parameters.
  float slotB = uStoreMask > 0.5 ? clamp( m2, 0.0, 1.0 ) : rough;

  gAlbedo = vec4( col, alpha );
  gNrm = vec4( n.xy * 0.5 + 0.5, slotB, clamp( h * 0.5 + 0.5 + uMix.w, 0.0, 1.0 ) );
}
`;

/* ═══════════════════════════════════════════════════════════════════════ atlas ══ */

/**
 * DecalAtlas — builds the two atlas textures on the GPU.
 *   build(res)   render every cell; safe to call again on a quality change
 *   albedo/nrm   THREE.Texture
 *   rect(name)   [u, v, w, h] in atlas UV space, or null
 *   srgbManual   true when the hardware refused an sRGB colour attachment
 */
export class DecalAtlas {
  constructor(ctx) {
    this.ctx = ctx;
    this.res = 0;
    this.rects = new Map();
    this.srgbManual = false;
    this.ready = false;
    this._rtHeight = null;
    this._rtOut = null;
    this._scene = null;
    this._empty = null;
    this._cam = null;
    this._quad = null;
    this._matH = null;
    this._matR = null;
    this._layout();
  }

  /** Cell rects are pure layout maths — available before any GPU work happens. */
  _layout() {
    let small = 0;
    let big = 0;
    for (const c of CELLS) {
      let rect;
      if (c.big) {
        const col = big % 4;
        const row = (big / 4) | 0;
        rect = [col * 0.25, row * 0.25, 0.25, 0.25];
        big++;
      } else {
        const col = small % 8;
        const row = (small / 8) | 0;
        rect = [col * 0.125, 0.5 + row * 0.125, 0.125, 0.125];
        small++;
      }
      this.rects.set(c.name, rect);
      c._rect = rect;
    }
    this.smallUsed = small;
    this.bigUsed = big;
  }

  rect(name) {
    return this.rects.get(name) || null;
  }

  get albedo() {
    return this._rtOut?.textures?.[0] || null;
  }

  get nrm() {
    return this._rtOut?.textures?.[1] || null;
  }

  _probeSRGB() {
    const renderer = this.ctx.renderer;
    let rt = null;
    let ok = false;
    try {
      rt = new THREE.WebGLRenderTarget(4, 4, { count: 2, depthBuffer: false, stencilBuffer: false });
      rt.textures[0].colorSpace = THREE.SRGBColorSpace;
      rt.textures[1].colorSpace = THREE.NoColorSpace;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      const gl = renderer.getContext();
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      renderer.setRenderTarget(prev);
    } catch {
      ok = false;
    }
    try {
      rt?.dispose();
    } catch {
      /* best effort */
    }
    return ok;
  }

  build(res) {
    const renderer = this.ctx.renderer;
    if (!renderer) return false;
    res = Math.max(512, Math.min(2048, res | 0));
    if (this.ready && res === this.res) return true;

    this._disposeTargets();
    this.res = res;
    const srgbOk = this._probeSRGB();
    this.srgbManual = !srgbOk;

    this._rtHeight = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    });

    const aniso = Math.min(this.ctx.maxAnisotropy || 4, this.ctx.settings?.get?.('anisotropy') ?? 8);
    this._rtOut = new THREE.WebGLRenderTarget(res, res, {
      count: 2,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      generateMipmaps: true,
      anisotropy: aniso,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._rtOut.textures[0].colorSpace = srgbOk ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    this._rtOut.textures[0].name = 'decalAtlas.albedo';
    this._rtOut.textures[1].colorSpace = THREE.NoColorSpace;
    this._rtOut.textures[1].name = 'decalAtlas.nrm';

    if (!this._scene) {
      this._scene = new THREE.Scene();
      this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const geo = new THREE.PlaneGeometry(2, 2);
      this._quad = new THREE.Mesh(geo, null);
      this._quad.frustumCulled = false;
      this._scene.add(this._quad);
    }

    let grunge = null;
    try {
      grunge = this.ctx.textures?.grungeMask?.() || null;
    } catch {
      grunge = null;
    }

    if (!this._matH) {
      this._matH = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: HEIGHT_FRAG,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
          uKind: { value: 1 },
          uSeed: { value: 0 },
          uP0: { value: new THREE.Vector4() },
          uP1: { value: new THREE.Vector4() },
          uGrunge: { value: null },
          uHasGrunge: { value: 0 },
        },
      });
      this._matR = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: RESOLVE_FRAG,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
          uSrc: { value: null },
          uRect: { value: new THREE.Vector4() },
          uTexel: { value: new THREE.Vector2() },
          uC0: { value: new THREE.Color() },
          uC1: { value: new THREE.Color() },
          uC2: { value: new THREE.Color() },
          uC3: { value: new THREE.Color() },
          uRough: { value: new THREE.Vector4() },
          uMix: { value: new THREE.Vector4() },
          uSeed: { value: 0 },
          uSrgbManual: { value: 0 },
          uStoreMask: { value: 0 },
        },
      });
    }
    this._matH.uniforms.uGrunge.value = grunge;
    this._matH.uniforms.uHasGrunge.value = grunge ? 1 : 0;
    this._matR.uniforms.uSrc.value = this._rtHeight.texture;
    this._matR.uniforms.uTexel.value.set(1 / res, 1 / res);
    this._matR.uniforms.uSrgbManual.value = this.srgbManual ? 1 : 0;

    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevTone = renderer.toneMapping;
    renderer.autoClear = false;
    renderer.toneMapping = THREE.NoToneMapping;

    // A render target carries its own viewport/scissor, and `setRenderTarget` installs
    // them verbatim — unlike `renderer.setViewport`, which would multiply by the device
    // pixel ratio and land the cell in the wrong place.
    const cellPass = (rt, mat, apply) => {
      this._quad.material = mat;
      rt.scissorTest = true;
      for (const c of CELLS) {
        const r = c._rect;
        const x = Math.round(r[0] * res);
        const y = Math.round(r[1] * res);
        const w = Math.round(r[2] * res);
        const h = Math.round(r[3] * res);
        rt.viewport.set(x, y, w, h);
        rt.scissor.set(x, y, w, h);
        apply(c);
        renderer.setRenderTarget(rt);
        renderer.render(this._scene, this._cam);
      }
      rt.scissorTest = false;
      rt.viewport.set(0, 0, res, res);
      rt.scissor.set(0, 0, res, res);
    };

    try {
      // Pass 1 — height / masks, one viewport per cell.
      cellPass(this._rtHeight, this._matH, (c) => {
        const u = this._matH.uniforms;
        u.uKind.value = c.kind;
        u.uSeed.value = c.seed || 0;
        u.uP0.value.fromArray(c.p0 || [0, 0, 0, 0]);
        u.uP1.value.fromArray(c.p1 || [0, 0, 0, 0]);
      });

      // Pass 2 — albedo + packed normal/roughness/height. three regenerates a render
      // target's mip chain at the end of every `render()`, so 40 cell draws would mean
      // 40 full mip builds; suppress them and do exactly one at the end.
      for (const t of this._rtOut.textures) t.generateMipmaps = false;
      cellPass(this._rtOut, this._matR, (c) => {
        const r = c._rect;
        const u = this._matR.uniforms;
        u.uRect.value.set(r[0], r[1], r[2], r[3]);
        u.uC0.value.copy(lin(c.cols[0]));
        u.uC1.value.copy(lin(c.cols[1]));
        u.uC2.value.copy(lin(c.cols[2]));
        u.uC3.value.copy(lin(c.cols[3]));
        u.uRough.value.fromArray(c.rough || [0.8, 0.9, 0, 0.05]);
        u.uMix.value.fromArray(c.mix || [1, 1, 1, 0]);
        u.uSeed.value = c.seed || 0;
        u.uStoreMask.value = c.maskB ? 1 : 0;
      });
      for (const t of this._rtOut.textures) t.generateMipmaps = true;
      if (!this._empty) this._empty = new THREE.Scene();
      renderer.setRenderTarget(this._rtOut);
      renderer.render(this._empty, this._cam);
      this.ready = true;
    } catch (err) {
      console.warn('[decals] atlas generation failed:', err);
      this.ready = false;
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.autoClear = prevAuto;
      renderer.toneMapping = prevTone;
    }
    return this.ready;
  }

  _disposeTargets() {
    try {
      this._rtHeight?.dispose();
    } catch {
      /* best effort */
    }
    try {
      this._rtOut?.dispose();
    } catch {
      /* best effort */
    }
    this._rtHeight = null;
    this._rtOut = null;
    this.ready = false;
  }

  dispose() {
    this._disposeTargets();
    try {
      this._matH?.dispose();
      this._matR?.dispose();
      this._quad?.geometry?.dispose();
    } catch {
      /* best effort */
    }
    this._matH = null;
    this._matR = null;
    this._quad = null;
    this._scene = null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════ depth ══ */

/**
 * DecalDepth — a private depth-only prepass of `ctx.scene`.
 *
 * Materials are swapped per mesh (the GBufferPass pattern) rather than through
 * `scene.overrideMaterial` so alpha-tested foliage still cuts its own silhouette and
 *真 transparent surfaces (glass with `depthWrite:false`) correctly do *not* occlude the
 * wall behind them. Every derived material collapses onto one of two or three programs,
 * so this costs shader compiles once, not per material.
 */
export class DecalDepth {
  constructor(ctx) {
    this.ctx = ctx;
    this.target = null;
    this.width = 0;
    this.height = 0;
    this.scale = 1;
    this.projection = new THREE.Matrix4();
    this.invProjection = new THREE.Matrix4();
    this._cache = new WeakMap();
    this._saved = [];
    this._hidden = [];
    this._owned = [];
    this._noop = null;
    this._warned = false;
  }

  setSize(w, h, scale) {
    const s = scale ?? this.scale;
    this.scale = s;
    const tw = Math.max(64, Math.round(w * s));
    const th = Math.max(64, Math.round(h * s));
    if (this.target && tw === this.width && th === this.height) return;
    this.width = tw;
    this.height = th;
    try {
      this.target?.dispose();
    } catch {
      /* best effort */
    }
    const depth = new THREE.DepthTexture(tw, th, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    depth.name = 'decal.depth';
    this.target = new THREE.WebGLRenderTarget(tw, th, {
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: depth,
      colorSpace: THREE.NoColorSpace,
    });
  }

  get texture() {
    return this.target?.depthTexture || null;
  }

  get _noopMaterial() {
    if (!this._noop) {
      this._noop = new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        transparent: false,
        fog: false,
        toneMapped: false,
      });
      this._owned.push(this._noop);
    }
    return this._noop;
  }

  /** @returns {THREE.Material|null} null = this material does not occlude decals. */
  _derive(src) {
    let m = this._cache.get(src);
    if (m !== undefined) return m;
    // Fully transparent surfaces do not occlude a decal on the wall behind them.
    if (src.transparent === true && src.depthWrite === false) {
      this._cache.set(src, null);
      return null;
    }
    const at = src.alphaTest || 0;
    m = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      transparent: false,
      fog: false,
      toneMapped: false,
      side: src.side ?? THREE.FrontSide,
      alphaTest: at,
      map: at > 0 && !src.alphaMap ? src.map || null : null,
      alphaMap: at > 0 ? src.alphaMap || null : null,
    });
    this._owned.push(m);
    this._cache.set(src, m);
    return m;
  }

  _swapIn(scene) {
    this._saved.length = 0;
    this._hidden.length = 0;
    scene.traverseVisible((o) => {
      if (o.isPoints || o.isLine || o.isSprite) {
        o.visible = false;
        this._hidden.push(o);
        return;
      }
      if (!o.isMesh || !o.material) return;
      if (o.userData?.noDecalDepth) {
        o.visible = false;
        this._hidden.push(o);
        return;
      }
      const m = o.material;
      if (Array.isArray(m)) {
        const swapped = m.map((sub) => (sub ? this._derive(sub) : null));
        if (swapped.every((s) => s === null)) {
          o.visible = false;
          this._hidden.push(o);
          return;
        }
        this._saved.push(o, m);
        o.material = swapped.map((s) => s || this._noopMaterial);
      } else {
        const d = this._derive(m);
        if (!d) {
          o.visible = false;
          this._hidden.push(o);
          return;
        }
        this._saved.push(o, m);
        o.material = d;
      }
    });
  }

  _swapOut() {
    for (let i = this._saved.length - 2; i >= 0; i -= 2) this._saved[i].material = this._saved[i + 1];
    this._saved.length = 0;
    for (const o of this._hidden) o.visible = true;
    this._hidden.length = 0;
  }

  /** Render the depth of `scene` from `camera`. Returns the depth texture, or null. */
  render(scene, camera) {
    const r = this.ctx.renderer;
    if (!r || !this.target || !scene || !camera) return null;
    const prevRT = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevShadow = r.shadowMap.autoUpdate;
    const bg = scene.background;
    const over = scene.overrideMaterial;
    const prevTone = r.toneMapping;
    try {
      r.autoClear = false;
      r.shadowMap.autoUpdate = false;
      r.toneMapping = THREE.NoToneMapping;
      scene.background = null;
      scene.overrideMaterial = null;
      this._swapIn(scene);
      r.setRenderTarget(this.target);
      r.clear(true, true, false);
      r.render(scene, camera);
      this.projection.copy(camera.projectionMatrix);
      this.invProjection.copy(camera.projectionMatrix).invert();
    } catch (err) {
      if (!this._warned) {
        this._warned = true;
        console.warn('[decals] depth prepass failed:', err);
      }
      return null;
    } finally {
      this._swapOut();
      scene.background = bg;
      scene.overrideMaterial = over;
      r.setRenderTarget(prevRT);
      r.autoClear = prevAuto;
      r.shadowMap.autoUpdate = prevShadow;
      r.toneMapping = prevTone;
    }
    return this.target.depthTexture;
  }

  dispose() {
    this._swapOut();
    try {
      this.target?.dispose();
    } catch {
      /* best effort */
    }
    for (const m of this._owned) {
      try {
        m.dispose();
      } catch {
        /* best effort */
      }
    }
    this._owned.length = 0;
    this.target = null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════ batch ══ */

// language=GLSL
const DECAL_VERT_HEAD = /* glsl */ `
attribute vec4 aAtlas;
attribute vec4 aParams;
attribute vec4 aTint;
attribute vec4 aParams2;
out vec4 vAtlas;
out vec4 vParams;
out vec4 vTint;
out vec4 vParams2;
out vec3 vDecalX;
out vec3 vDecalY;
out vec3 vDecalZ;
out vec3 vDecalO;
`;

// language=GLSL
const DECAL_VERT_BODY = /* glsl */ `
  vAtlas = aAtlas;
  vParams = aParams;
  vTint = aTint;
  vParams2 = aParams2;
  #ifdef USE_INSTANCING
    mat4 codMVI = modelViewMatrix * instanceMatrix;
  #else
    mat4 codMVI = modelViewMatrix;
  #endif
  vec3 c0 = codMVI[ 0 ].xyz;
  vec3 c1 = codMVI[ 1 ].xyz;
  vec3 c2 = codMVI[ 2 ].xyz;
  // Rows of the inverse of the (rotation * scale) block: row_i = c_i / |c_i|^2.
  vDecalX = c0 / max( 1e-8, dot( c0, c0 ) );
  vDecalY = c1 / max( 1e-8, dot( c1, c1 ) );
  vDecalZ = c2 / max( 1e-8, dot( c2, c2 ) );
  vDecalO = codMVI[ 3 ].xyz;
`;

// language=GLSL
const DECAL_FRAG_HEAD = /* glsl */ `
uniform sampler2D uDecalAlbedo;
uniform sampler2D uDecalNRM;
uniform sampler2D uDecalDepth;
uniform mat4 uDecalInvProj;
uniform vec2 uDecalScreen;    // 1 / main-pass resolution
uniform vec2 uDecalTexel;     // 1 / depth-target resolution
uniform vec4 uDecalGlobal;    // ( minAlign, globalOpacity, parallax, srgbManual )
uniform vec2 uDecalFade;      // ( fadeStart, fadeEnd ) metres
in vec4 vAtlas;
in vec4 vParams;              // ( opacity, normalStrength, metalness, roughnessBias )
in vec4 vTint;                // ( tint.rgb, aoStrength )
in vec4 vParams2;             // ( dripProgress | -1, spare, roughnessOverride | -1, spare )
in vec3 vDecalX;
in vec3 vDecalY;
in vec3 vDecalZ;
in vec3 vDecalO;

vec3 codDecalViewPos( vec2 suv ) {
  float d = min( texture2D( uDecalDepth, clamp( suv, vec2( 0.0 ), vec2( 1.0 ) ) ).x, 0.999969 );
  vec4 ndc = vec4( suv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 v = uDecalInvProj * ndc;
  return v.xyz / ( abs( v.w ) < 1e-7 ? 1e-7 : v.w );
}
`;

// language=GLSL
const DECAL_FRAG_BODY = /* glsl */ `
  vec2 codSuv = gl_FragCoord.xy * uDecalScreen;
  float codRawDepth = texture2D( uDecalDepth, codSuv ).x;
  if ( codRawDepth >= 0.999995 ) discard;                 // sky

  vec3 codVP = codDecalViewPos( codSuv );
  vec3 codRel = codVP - vDecalO;
  vec3 codLocal = vec3( dot( vDecalX, codRel ), dot( vDecalY, codRel ), dot( vDecalZ, codRel ) );
  if ( any( greaterThan( abs( codLocal ), vec3( 0.5 ) ) ) ) discard;

  // Geometric normal of the receiver, from two extra depth taps.
  vec3 codPX = codDecalViewPos( codSuv + vec2( uDecalTexel.x, 0.0 ) );
  vec3 codPY = codDecalViewPos( codSuv + vec2( 0.0, uDecalTexel.y ) );
  vec3 codGN = normalize( cross( codPX - codVP, codPY - codVP ) );
  if ( dot( codGN, codVP ) > 0.0 ) codGN = -codGN;

  vec3 codAxisZ = normalize( vDecalZ );
  vec3 codAxisX = normalize( vDecalX );
  vec3 codAxisY = normalize( vDecalY );
  float codAlign = dot( codGN, codAxisZ );
  float codAngleFade = smoothstep( uDecalGlobal.x, uDecalGlobal.x + 0.28, codAlign );
  if ( codAngleFade <= 0.001 ) discard;

  vec2 codUvL = codLocal.xy + 0.5;

  // One-step parallax so the crater reads as an actual hole at grazing angles.
  if ( uDecalGlobal.z > 0.001 ) {
    vec3 V = normalize( -codVP );
    vec3 vt = vec3( dot( codAxisX, V ), dot( codAxisY, V ), max( 0.22, dot( codGN, V ) ) );
    float h0 = texture2D( uDecalNRM, vAtlas.xy + clamp( codUvL, 0.001, 0.999 ) * vAtlas.zw ).a;
    vec2 off = ( vt.xy / vt.z ) * ( 0.5 - h0 ) * uDecalGlobal.z;
    codUvL = clamp( codUvL + off, 0.0, 1.0 );
  }

  vec2 codUv = vAtlas.xy + clamp( codUvL, 0.0005, 0.9995 ) * vAtlas.zw;
  vec4 codAlb = texture2D( uDecalAlbedo, codUv );
  vec4 codNRM = texture2D( uDecalNRM, codUv );
  if ( uDecalGlobal.w > 0.5 ) codAlb.rgb = pow( max( codAlb.rgb, vec3( 0.0 ) ), vec3( 2.2 ) );

  float codAlpha = codAlb.a * vParams.x * codAngleFade;
  // Feather against the front/back planes of the projector volume.
  codAlpha *= 1.0 - smoothstep( 0.34, 0.5, abs( codLocal.z ) );
  // Distance fade — a bullet hole 70 m away is noise, not detail.
  codAlpha *= 1.0 - smoothstep( uDecalFade.x, uDecalFade.y, -codVP.z );
  codAlpha *= uDecalGlobal.y;
  // Runs that grow downwards. Cells flagged maskB store the reveal parameter of each
  // drip in the roughness slot; the instance supplies its own constant roughness and a
  // progress threshold in vParams2.x ( < 0 disables the whole mechanism ).
  if ( vParams2.x >= 0.0 ) {
    codAlpha *= 1.0 - smoothstep( vParams2.x, vParams2.x + 0.10, codNRM.b );
  }
  if ( codAlpha <= 0.004 ) discard;

  vec2 codN2 = ( codNRM.rg * 2.0 - 1.0 ) * vParams.y;
  float codNZ = sqrt( max( 1e-4, 1.0 - dot( codN2, codN2 ) ) );
  vec3 codNormal = normalize( codAxisX * codN2.x + codAxisY * codN2.y + codGN * codNZ );

  float codHeight = codNRM.a;
  float codAO = mix( 1.0, clamp( 0.25 + 1.5 * codHeight, 0.0, 1.0 ), vTint.a );

  vViewPosition = -codVP;
  diffuseColor = vec4( codAlb.rgb * vTint.rgb, codAlpha );
  codDecalRough = clamp( mix( codNRM.b, vParams2.z, step( 0.0, vParams2.z ) ) + vParams.w, 0.03, 1.0 );
  codDecalMetal = vParams.z;
  codDecalNormal = codNormal;
  codDecalAO = codAO;
`;

/**
 * DecalBatch — one InstancedMesh, one draw call, every decal that lives in one atlas.
 *
 * The instance transform is the projector: translation = the decal centre, the three
 * scaled column axes are ( tangent * width, bitangent * height, normal * depth ).
 */
export class DecalBatch {
  constructor(ctx, atlas, depth, capacity) {
    this.ctx = ctx;
    this.atlas = atlas;
    this.depth = depth;
    this.capacity = Math.max(16, capacity | 0);
    this.count = 0;

    this.uniforms = {
      uDecalAlbedo: { value: atlas.albedo },
      uDecalNRM: { value: atlas.nrm },
      uDecalDepth: { value: null },
      uDecalInvProj: { value: new THREE.Matrix4() },
      uDecalScreen: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uDecalTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uDecalGlobal: { value: new THREE.Vector4(0.22, 1, 0.02, atlas.srgbManual ? 1 : 0) },
      uDecalFade: { value: new THREE.Vector2(55, 78) },
    };

    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.geometry = geo;

    const n = this.capacity;
    this.aAtlas = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aParams2 = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    for (const a of [this.aAtlas, this.aParams, this.aTint, this.aParams2]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute('aAtlas', this.aAtlas);
    geo.setAttribute('aParams', this.aParams);
    geo.setAttribute('aTint', this.aTint);
    geo.setAttribute('aParams2', this.aParams2);

    this.material = this._makeMaterial();

    this.mesh = new THREE.InstancedMesh(geo, this.material, n);
    this.mesh.name = 'decals';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = -2; // first thing in the transparent queue
    this.mesh.matrixAutoUpdate = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.userData.noDecalDepth = true;
    this.mesh.userData.decalBatch = true;

    // Decals belong in exactly one pass — the lit world pass. Every other traversal of
    // `ctx.scene` in the same frame (velocity reprojection, the half-res ORM g-buffer,
    // the debug albedo/overdraw views) would otherwise smear projector boxes into a
    // buffer that has no idea what a decal is. Hiding ourselves the instant we have been
    // drawn opts out of all of them without touching anyone else's pass; `lateUpdate()`
    // turns visibility back on for the next frame.
    this.mesh.onAfterRender = () => {
      this.mesh.visible = false;
    };
  }

  _makeMaterial() {
    const u = this.uniforms;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.0,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.BackSide,
      dithering: true,
    });
    mat.name = 'decalProjector';

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);

      /* ── vertex ─────────────────────────────────────────────────────────── */
      let v = shader.vertexShader;
      // Rename the interpolated view position so the fragment stage can shadow the
      // name with the *reconstructed* one; three derives geometryPosition from it.
      v = v.replace('varying vec3 vViewPosition;', `varying vec3 vCodViewSrc;\n${DECAL_VERT_HEAD}`);
      v = v.replace('vViewPosition = - mvPosition.xyz;', 'vCodViewSrc = - mvPosition.xyz;');
      v = v.replace('void main() {', `void main() {\n${DECAL_VERT_BODY}`);
      shader.vertexShader = v;

      /* ── fragment ───────────────────────────────────────────────────────── */
      let f = shader.fragmentShader;
      f = f.replace(
        'varying vec3 vViewPosition;',
        `varying vec3 vCodViewSrc;\nvec3 vViewPosition;\nvec3 codDecalNormal;\nfloat codDecalRough;\nfloat codDecalMetal;\nfloat codDecalAO;\n${DECAL_FRAG_HEAD}`
      );
      f = f.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${DECAL_FRAG_BODY}`
      );
      f = f.replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = codDecalRough;'
      );
      f = f.replace(
        '#include <metalnessmap_fragment>',
        'float metalnessFactor = codDecalMetal;'
      );
      f = f.replace(
        '#include <normal_fragment_begin>',
        'float faceDirection = 1.0;\nvec3 normal = codDecalNormal;\nvec3 nonPerturbedNormal = normal;'
      );
      f = f.replace('#include <normal_fragment_maps>', '');
      f = f.replace(
        '#include <aomap_fragment>',
        `reflectedLight.indirectDiffuse *= codDecalAO;
         reflectedLight.indirectSpecular *= mix( 1.0, codDecalAO, 0.6 );`
      );
      shader.fragmentShader = f;
    };
    // Distinguish this material's program from any other standard material.
    mat.customProgramCacheKey = () => 'codDecalProjector';
    return mat;
  }

  /** Point the material's samplers at a freshly rebuilt atlas. */
  refreshAtlas() {
    this.uniforms.uDecalAlbedo.value = this.atlas.albedo;
    this.uniforms.uDecalNRM.value = this.atlas.nrm;
    this.uniforms.uDecalGlobal.value.w = this.atlas.srgbManual ? 1 : 0;
  }

  setInstance(i, matrix, rect, params, tint, params2) {
    if (i < 0 || i >= this.capacity) return;
    this.mesh.setMatrixAt(i, matrix);
    const a = this.aAtlas.array;
    a[i * 4] = rect[0];
    a[i * 4 + 1] = rect[1];
    a[i * 4 + 2] = rect[2];
    a[i * 4 + 3] = rect[3];
    const p = this.aParams.array;
    p[i * 4] = params[0];
    p[i * 4 + 1] = params[1];
    p[i * 4 + 2] = params[2];
    p[i * 4 + 3] = params[3];
    const t = this.aTint.array;
    t[i * 4] = tint[0];
    t[i * 4 + 1] = tint[1];
    t[i * 4 + 2] = tint[2];
    t[i * 4 + 3] = tint[3];
    const q = this.aParams2.array;
    q[i * 4] = params2[0];
    q[i * 4 + 1] = params2[1];
    q[i * 4 + 2] = params2[2];
    q[i * 4 + 3] = params2[3];
  }

  setOpacity(i, v) {
    if (i < 0 || i >= this.capacity) return;
    this.aParams.array[i * 4] = v;
  }

  setDrip(i, v) {
    if (i < 0 || i >= this.capacity) return;
    this.aParams2.array[i * 4] = v;
  }

  flush(count, matrixDirty, paramsDirty) {
    this.count = Math.max(0, Math.min(this.capacity, count | 0));
    this.mesh.count = this.count;
    if (matrixDirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.aAtlas.needsUpdate = true;
      this.aTint.needsUpdate = true;
    }
    if (matrixDirty || paramsDirty) {
      this.aParams.needsUpdate = true;
      this.aParams2.needsUpdate = true;
    }
  }

  dispose() {
    try {
      this.geometry.dispose();
      this.material.dispose();
      this.mesh.dispose?.();
    } catch {
      /* best effort */
    }
  }
}

export default { DecalAtlas, DecalDepth, DecalBatch, CELLS, CELL_KIND };
