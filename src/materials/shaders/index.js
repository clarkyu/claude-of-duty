/**
 * Texture generation shaders. Owner: TextureForge agent (src/materials/*).
 *
 * Purpose
 *   The GLSL half of the procedural PBR pipeline. Exports:
 *     FULLSCREEN_VERT        vertex shader for the fullscreen triangle
 *     COMMON                 shared surface helpers (lattices, wear, grime, weave, ...)
 *     MATERIALS              named material recipes -> GLSL + physical parameters
 *     buildHeightFrag(name)  height-field pass  (1 attachment, RGBA16F)
 *     buildSurfaceFrag(name) surface pass       (3 attachments: albedo / normal / ORM)
 *     DISPLACE_FRAG, DETAIL_NORMAL_FRAG, GRUNGE_FRAG, NOISE_FRAG
 *
 * Two-pass model
 *   Pass 1 writes a float height field (+3 free aux channels the recipe may cache).
 *   Pass 2 texelFetches that field, derives the tangent-space normal with a Sobel
 *   filter and a multi-radius ambient-occlusion / cavity term, then asks the recipe
 *   for albedo / roughness / metalness. Nothing is faked from the albedo.
 *
 * Conventions
 *   - uv in [0,1] covers one tile of `worldSize` metres. Every noise call is tileable.
 *   - +V is "up" on wall materials, so run-off stains flow towards -V.
 *   - Surf.albedo is authored in *sRGB display space* (that is how texture artists
 *     think); the surface pass converts to linear on write, because attachment 0 is
 *     an sRGB texture and the hardware re-encodes it.
 *   - height 0..1 maps to `depth` metres of relief.
 */
import { NOISE_CORE, NOISE_FULL } from './noise.js';

/* ------------------------------------------------------------------ vertex */
// language=GLSL
export const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const PRECISION = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

const UNIFORMS = /* glsl */ `
in vec2 vUv;
uniform vec2 uRes;
uniform vec2 uTexel;
uniform float uSeed;
uniform float uQ;
uniform vec3 uTint;
uniform float uRoughBias;
uniform float uMacro;
uniform float uNormalScale;
uniform float uAO;
uniform vec4 uP0;
uniform vec4 uP1;
`;

/* ------------------------------------------------------------------ common */
// language=GLSL
export const COMMON = /* glsl */ `
const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

float sat(float x){ return clamp(x, 0.0, 1.0); }
vec2  sat(vec2 x){ return clamp(x, 0.0, 1.0); }
vec3  sat(vec3 x){ return clamp(x, 0.0, 1.0); }
float remap(float x, float a, float b, float c, float d){ return c + (d - c) * sat((x - a) / max(1e-5, b - a)); }
float n01(float x){ return x * 0.5 + 0.5; }
float contrastf(float x, float c){ return sat((x - 0.5) * c + 0.5); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
mat2  rot2(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

// Octave count driven by the quality uniform (headless renders fewer).
int OCT(int n){ return clamp(int(ceil(float(n) * uQ)), 2, 8); }

vec3 hsv2rgb(vec3 c){
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), sat(p - 1.0), c.y);
}
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
// Recipes author albedo in sRGB display space (that is how texture artists think);
// the pass converts to linear on write because attachment 0 is an sRGB texture.
vec3 srgbToLin(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linToSrgb(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

vec3 shiftHSV(vec3 rgb, float dh, float ds, float dv){
  vec3 h = rgb2hsv(rgb);
  h.x = fract(h.x + dh);
  h.y = sat(h.y * (1.0 + ds));
  h.z = sat(h.z * (1.0 + dv));
  return hsv2rgb(h);
}

// Shearing by an integer factor keeps a tileable field tileable — this is how we get
// diagonal features (scratches, brush marks, grain) without breaking the seam.
vec2 shearX(vec2 uv, float k){ return vec2(uv.x + floor(k + 0.5) * uv.y, uv.y); }
vec2 shearY(vec2 uv, float k){ return vec2(uv.x, uv.y + floor(k + 0.5) * uv.x); }

/* ------------------------------------------------------------- lattices */
struct Cell { vec2 luv; vec2 id; vec3 rnd; float face; float edge; vec2 sz; };

// Running-bond lattice. counts must be integral and counts.y even when rowOffset=0.5.
Cell brickCell(vec2 uv, vec2 counts, float rowOffset, vec2 joint, float seed){
  vec2 C = max(vec2(1.0), floor(counts + 0.5));
  float row = floor(uv.y * C.y);
  vec2 p = vec2(uv.x * C.x + rowOffset * row, uv.y * C.y);
  vec2 id = floor(p);
  vec2 f = p - id;
  Cell c;
  c.luv = f;
  c.id = mod(id, C);
  c.rnd = hash23(c.id, seed);
  vec2 j = max(joint, vec2(1e-4));
  vec2 d = min(f, 1.0 - f);
  // flat joint floor, quick ramp up onto the face
  c.face = min(smoothstep(j.x * 0.45, j.x, d.x), smoothstep(j.y * 0.45, j.y, d.y));
  c.edge = min(smoothstep(0.0, j.x * 3.0, d.x), smoothstep(0.0, j.y * 3.0, d.y));
  c.sz = 1.0 / C;
  return c;
}

// Planks running along U, each row shifted by an integral number of cells.
Cell plankCell(vec2 uv, vec2 counts, vec2 joint, float seed){
  vec2 C = max(vec2(1.0), floor(counts + 0.5));
  float row = floor(uv.y * C.y);
  float off = floor(hash21(vec2(7.0, mod(row, C.y)), seed) * C.x);
  vec2 p = vec2(uv.x * C.x + off, uv.y * C.y);
  vec2 id = floor(p);
  vec2 f = p - id;
  Cell c;
  c.luv = f;
  c.id = mod(id, C);
  c.rnd = hash23(c.id, seed + 3.0);
  vec2 j = max(joint, vec2(1e-4));
  vec2 d = min(f, 1.0 - f);
  c.face = min(smoothstep(j.x * 0.45, j.x, d.x), smoothstep(j.y * 0.45, j.y, d.y));
  c.edge = min(smoothstep(0.0, j.x * 3.0, d.x), smoothstep(0.0, j.y * 3.0, d.y));
  c.sz = 1.0 / C;
  return c;
}

/* --------------------------------------------------------- wear & story */

// Water running downwards (-V). Long, thin, broken vertical stains.
float runoff(vec2 uv, float cols, float seed){
  float a = tFbm(uv, vec2(cols, max(1.0, cols * 0.05)), OCT(5), seed);
  float b = tFbm(uv, vec2(cols * 2.2, max(1.0, cols * 0.16)), OCT(4), seed + 9.0);
  // where the water actually runs: only under a few spots, not across the whole wall
  float source = smoothstep(0.42, 0.80, n01(tFbm(uv, vec2(3.0, 2.0), OCT(4), seed + 27.0)));
  float m = sat(n01(a) * 1.20 - 0.22);
  m = m * m * sat(n01(b) + 0.25);
  return sat(m * 2.1 * source);
}

// Broad dirt blotches at several scales; the low frequency term is what stops a
// texture reading as "repeated".
float grunge(vec2 uv, float seed){
  float g = n01(tFbm(uv, vec2(2.0), OCT(4), seed)) * 0.55
          + n01(tFbm(uv, vec2(7.0), OCT(4), seed + 17.0)) * 0.30
          + n01(tFbm(uv, vec2(23.0), OCT(3), seed + 41.0)) * 0.15;
  return sat(g);
}

// Directional micro scratches. Sheared so they tile.
float scratchLayer(vec2 uv, float k, vec2 s, float sharp, float seed){
  vec2 q = shearX(uv, k);
  float n = tFbm(q, s, 3, seed);
  float m = 1.0 - smoothstep(0.0, sharp, abs(n));
  return m * sat(n01(tFbm(q, vec2(4.0, 9.0), 3, seed + 5.0)) + 0.35);
}
float scratches(vec2 uv, float amount, float seed){
  float a = scratchLayer(uv,  1.0, vec2(4.0, 150.0), 0.055, seed);
  float b = scratchLayer(uv, -2.0, vec2(6.0, 210.0), 0.040, seed + 31.0);
  float c = scratchLayer(uv,  3.0, vec2(3.0, 95.0),  0.030, seed + 67.0);
  return sat((a + b * 0.8 + c * 0.55) * amount);
}

// Crack network: worley cell borders, domain warped so the lines wander.
float crackField(vec2 uv, vec2 s, float width, float warpAmt, float seed){
  vec2 q = tWarp(uv, max(vec2(1.0), s * 0.4), warpAmt, 3, seed + 5.0);
  vec4 w = tWorley(q, s, 1.0, seed);
  float e = w.y - w.x;
  float m = 1.0 - smoothstep(0.0, width, e);
  // thin the network out so it is not a uniform mesh
  return m * sat(n01(tFbm(uv, vec2(4.0), 3, seed + 77.0)) * 1.6 - 0.25);
}

// Rounded aggregate / pebbles. x = height, y = per stone random, z = gap mask.
vec3 pebbles(vec2 uv, vec2 s, float jitter, float roundness, float seed){
  vec4 w = tWorley(uv, s, jitter, seed);
  float r = sat(1.0 - w.x / max(0.02, roundness));
  return vec3(pow(r, 0.55), w.z, sat((w.y - w.x) * 3.0));
}

// Plain weave: x = thread height, y = 0/1 warp-or-weft, z = along-thread coordinate.
vec3 weave(vec2 uv, vec2 threads, float seed){
  vec2 T = max(vec2(2.0), floor(threads * 0.5 + 0.5) * 2.0);
  vec2 p = uv * T;
  vec2 f = fract(p);
  float over = mod(floor(p.x) + floor(p.y), 2.0);
  float hx = sin(f.x * PI);
  float hy = sin(f.y * PI);
  float h = mix(hy * 0.95 + hx * 0.30, hx * 0.95 + hy * 0.30, over);
  // slubs: real yarn is not uniform, thread thickness wanders along its length
  float slubW = n01(tFbm(uv, vec2(max(2.0, T.x * 0.5), T.y * 3.0), 3, seed + 11.0));
  float slubF = n01(tFbm(uv, vec2(T.x * 3.0, max(2.0, T.y * 0.5)), 3, seed + 29.0));
  h *= 0.78 + 0.44 * mix(slubF, slubW, over);
  float fuzz = n01(tFbm(uv, T * 6.0, 3, seed)) * 0.16;
  return vec3(sat(h * 0.85 + fuzz), over, mix(f.y, f.x, over));
}

// Rust: patchy blooms that eat into the metal, 0..1.
float rustField(vec2 uv, float scale, float coverage, float seed){
  float a = n01(tWarpedFbm(uv, vec2(scale), OCT(5), 0.09, seed));
  float b = n01(tFbm(uv, vec2(scale * 3.5), OCT(4), seed + 23.0));
  float m = smoothstep(coverage, coverage + 0.22, a * 0.72 + b * 0.28);
  // ragged edges
  m = sat(m + (b - 0.5) * 0.35 * smoothstep(0.02, 0.35, m) * step(m, 0.98));
  return sat(m);
}

// Paint chipping driven by the height field: paint survives in the recesses.
float chipMask(float h, float cav, float noise, float amount){
  float t = mix(0.85, 0.18, sat(amount));
  return sat(smoothstep(t, t + 0.16, h * 0.7 + noise * 0.5 - cav * 0.45));
}

// Dust settling: on up-facing micro-facets for walls, in cavities for floors.
float dustField(vec2 uv, float up, float cav, float seed){
  float d = n01(tFbm(uv, vec2(9.0), OCT(4), seed)) * 0.6 + n01(tFbm(uv, vec2(35.0), 3, seed + 7.0)) * 0.4;
  return sat(d * (up * 0.85 + cav * 0.5 + 0.12));
}

/* ------------------------------------------------------------ interface */
struct SurfIn {
  vec2 uv;    // tile uv
  vec4 h;     // .x height, .yzw recipe aux cached from the height pass
  vec3 n;     // tangent-space normal derived from the height field
  float cav;  // small-radius concavity, 1 deep in a crevice
  float ao;   // broad ambient occlusion, 1 open
  float up;   // micro-facet facing +V
  float dn;   // micro-facet facing -V
};

struct Surf {
  vec3 albedo;  // sRGB display space
  float rough;
  float metal;
  float ao;     // extra occlusion the recipe wants on top of the derived term
  vec3 normal;
};

Surf defaultSurf(SurfIn c){
  Surf s;
  s.albedo = vec3(0.5);
  s.rough = 0.85;
  s.metal = 0.0;
  s.ao = 1.0;
  s.normal = c.n;
  return s;
}
`;

/* -------------------------------------------------------------- pass mains */
const HEIGHT_IO = /* glsl */ `
layout(location = 0) out vec4 outHeight;
`;

const HEIGHT_MAIN = /* glsl */ `
void main(){
  vec4 h = mHeight(vUv);
  outHeight = vec4(clamp(h.x, 0.0, 1.0), h.y, h.z, h.w);
}
`;

const SURFACE_IO = /* glsl */ `
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outORM;
uniform sampler2D uHeight;

ivec2 wrapTexel(ivec2 c, ivec2 n){
  return ivec2(((c.x % n.x) + n.x) % n.x, ((c.y % n.y) + n.y) % n.y);
}
`;

const SURFACE_MAIN = /* glsl */ `
ivec2 gSize;
vec4 hFetch(ivec2 c){ return texelFetch(uHeight, wrapTexel(c, gSize), 0); }
float hAt(ivec2 c){ return hFetch(c).x; }

const vec2 kDirs[8] = vec2[8](
  vec2( 1.0, 0.0), vec2( 0.707,  0.707), vec2(0.0,  1.0), vec2(-0.707,  0.707),
  vec2(-1.0, 0.0), vec2(-0.707, -0.707), vec2(0.0, -1.0), vec2( 0.707, -0.707));

void main(){
  gSize = ivec2(uRes + 0.5);
  ivec2 C = ivec2(gl_FragCoord.xy);
  vec4 h = hFetch(C);

  // --- Sobel on the height render target -> tangent-space normal ------------
  float tl = hAt(C + ivec2(-1,  1)), tc = hAt(C + ivec2(0,  1)), tr = hAt(C + ivec2(1,  1));
  float ml = hAt(C + ivec2(-1,  0)),                              mr = hAt(C + ivec2(1,  0));
  float bl = hAt(C + ivec2(-1, -1)), bc = hAt(C + ivec2(0, -1)), br = hAt(C + ivec2(1, -1));
  float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
  float k = uNormalScale * uRes.x * 0.125;
  vec3 nrm = normalize(vec3(-gx * k, -gy * k, 1.0));

  // --- multi radius occlusion from the same height field --------------------
  float rs = max(1.0, uRes.x / 512.0);
  float cav = 0.0, occ = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 d = kDirs[i];
    float h1 = hAt(C + ivec2(round(d * 2.0 * rs)));
    float h2 = hAt(C + ivec2(round(d * 7.0 * rs)));
    float h3 = hAt(C + ivec2(round(d * 18.0 * rs)));
    cav += max(0.0, h1 - h.x);
    occ += max(0.0, h2 - h.x) * 0.62 + max(0.0, h3 - h.x) * 0.38;
  }
  cav = sat(cav * 0.55);
  occ = sat(occ * 0.42 * uAO);

  SurfIn ci;
  ci.uv = vUv;
  ci.h = h;
  ci.n = nrm;
  ci.cav = cav;
  ci.ao = 1.0 - occ;
  ci.up = sat(nrm.y);
  ci.dn = sat(-nrm.y);

  Surf s = mSurface(ci);

  // --- macro variation moved to world space --------------------------------
  // This used to sample vUv, which is 0..1 across *one tile*. Every instance of the
  // tile therefore got the identical bright/dark blotch in the identical place, so the
  // block made the grid MORE visible, not less — the eye locks onto a repeating
  // feature far faster than onto a repeating texture. The real low-frequency drift now
  // happens at shading time from world position (COD_MACRO in materialExtensions.js)
  // where the period is 20-80 m and nothing can line up with a tile boundary.
  // uMacro survives as the per-recipe strength the runtime block reads through
  // opts.macro; only the per-set roughness bias is still applied here.
  s.rough = sat(s.rough + uRoughBias);

  float aoFinal = sat(s.ao * ci.ao);
  // A touch of the occlusion baked into albedo, exactly like a photoscan.
  s.albedo *= mix(1.0, aoFinal, 0.22);

  outAlbedo = vec4(srgbToLin(sat(s.albedo * uTint)), h.x);
  outNormal = vec4(normalize(s.normal) * 0.5 + 0.5, 1.0);
  outORM    = vec4(aoFinal, sat(s.rough), sat(s.metal), 1.0);
}
`;

/* ========================================================================== */
/*                            MATERIAL RECIPES                                */
/* ========================================================================== */

/** @type {Record<string, {worldSize:number, depth:number, surface:string, normalScale?:number, ao?:number, macro?:number, glsl:string}>} */
export const MATERIALS = {
  /* ------------------------------------------------------------ concrete */
  concrete_cast: {
    worldSize: 3.0, depth: 0.022, surface: 'concrete',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  float base = n01(tFbm(uv, vec2(5.0), OCT(6), uSeed));
  float fine = n01(tFbm(uv, vec2(46.0), OCT(5), uSeed + 3.0));
  vec3 agg = pebbles(uv, vec2(88.0), 1.0, 0.42, uSeed + 7.0);
  float bub  = sat(1.0 - tWorley(uv, vec2(64.0), 1.0, uSeed + 11.0).x * 6.5);
  float bub2 = sat(1.0 - tWorley(uv, vec2(140.0), 1.0, uSeed + 23.0).x * 8.5);
  float board = abs(fract(uv.y * 4.0) - 0.5) * 2.0;
  float seam = 1.0 - smoothstep(0.0, 0.055, board);
  vec4 tw = tWorley(uv, vec2(2.0), 0.0, uSeed + 31.0);
  float tie = sat(1.0 - tw.x * 13.0) * step(0.6, tw.z);
  float chip = sat(1.0 - tWorley(tWarp(uv, vec2(8.0), 0.03, 3, uSeed + 41.0), vec2(13.0), 1.0, uSeed + 43.0).x * 3.0);
  chip *= step(0.87, cellHash(uv, vec2(13.0), uSeed + 47.0));
  // Pour lines: a lift of concrete goes in every ~7 cm of a barrier's height and each
  // one leaves a faint horizontal register. It is the band between the 23 cm base
  // noise and the 2.5 cm fine noise that was missing on every cast piece in the map.
  float pour = n01(tFbm(uv, vec2(2.0, 17.0), OCT(4), uSeed + 59.0));
  float h = 0.60 + base * 0.19 + pour * 0.07 + fine * 0.09 + agg.x * 0.05;
  h -= seam * 0.09 + (bub * 0.55 + bub2 * 0.30) * 0.20 + tie * 0.34 + chip * 0.26;
  return vec4(h, base, chip, seam);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 col = mix(vec3(0.40, 0.400, 0.405), vec3(0.625, 0.620, 0.600), sat(c.h.y * 0.95 + 0.15));
  // Exposed aggregate, picked stone by stone rather than as one soft multiply: a
  // pale flint and a dark basalt at 1.3 cm are the difference between a cast face and
  // a cream card at 8 m, which is exactly the distance a jersey barrier is seen from.
  vec4 aw = tWorley(c.uv, vec2(88.0), 1.0, uSeed + 7.0);
  col *= 0.87 + 0.27 * aw.z;
  float prox = smoothstep(0.55, 0.86, c.h.x);                 // stones sit proud
  col = mix(col, col * 1.34 + 0.035, smoothstep(0.58, 0.97, aw.z) * prox * 0.62);
  col = mix(col, col * 0.64, smoothstep(0.34, 0.02, aw.z) * prox * 0.55);
  float pour = n01(tFbm(c.uv, vec2(2.0, 17.0), OCT(4), uSeed + 59.0));
  col *= 0.915 + 0.17 * pour;
  // Form-board seam: a dark line where the grout ran, with a pale laitance lip.
  float seam = c.h.w;
  col = mix(col, col * vec3(0.60, 0.595, 0.575), seam * 0.7);
  col = mix(col, col * 1.15 + 0.02, sat(seam * 3.0) * (1.0 - smoothstep(0.20, 0.55, seam)) * 0.35);
  float eff = smoothstep(0.60, 0.94, n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 61.0)));
  col = mix(col, vec3(0.80, 0.79, 0.755), eff * 0.5);
  // Tie holes bleed rust down the face — the single most legible piece of story a
  // cast concrete element has, and it was in the height field only.
  vec4 tw = tWorley(c.uv, vec2(2.0), 0.0, uSeed + 31.0);
  float tie = sat(1.0 - tw.x * 13.0) * step(0.6, tw.z);
  float bleed = sat(1.0 - tw.x * 3.4) * step(0.6, tw.z)
              * smoothstep(0.62, 0.05, fract(c.uv.y * 2.0))
              * (0.35 + 0.65 * n01(tFbm(c.uv, vec2(40.0, 8.0), 3, uSeed + 63.0)));
  col = mix(col, vec3(0.355, 0.205, 0.115), sat(bleed) * 0.55);
  col = mix(col, vec3(0.230, 0.150, 0.100), tie * 0.8);
  float grime = sat(c.cav * 2.6);
  col = mix(col, vec3(0.20, 0.190, 0.175), grime * 0.55);
  float st = runoff(c.uv, 24.0, uSeed + 71.0);
  col = mix(col, vec3(0.265, 0.255, 0.235), st * 0.45);
  // Rubber transfer: anything at kerb height gets hit by tyres and shoes.
  float rub = sat(n01(tFbm(shearX(c.uv, 1.0), vec2(6.0, 90.0), 3, uSeed + 87.0)) * 1.5 - 0.55)
            * smoothstep(0.35, 0.85, n01(tFbm(c.uv, vec2(4.0, 2.0), 3, uSeed + 89.0)));
  col = mix(col, vec3(0.135, 0.130, 0.128), rub * 0.45);
  col = mix(col, vec3(0.56, 0.535, 0.485), dustField(c.uv, c.up, 0.0, uSeed + 83.0) * 0.34);
  col = mix(col, vec3(0.665, 0.655, 0.625), c.h.z * 0.7);
  s.albedo = col;
  s.rough = 0.94 - eff * 0.06 - sat(c.h.y) * 0.07 + grime * 0.04 - st * 0.14
          - rub * 0.12 + (aw.z - 0.5) * 0.07 + seam * 0.03;
  s.ao = 1.0 - grime * 0.22 - tie * 0.35;
  return s;
}`,
  },

  concrete_precast_panel: {
    worldSize: 4.0, depth: 0.03, surface: 'concrete',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  Cell p = brickCell(uv, vec2(2.0, 2.0), 0.0, vec2(0.007, 0.007), uSeed);
  float base = n01(tFbm(uv, vec2(6.0), OCT(5), uSeed + p.rnd.x * 31.0));
  float fine = n01(tFbm(uv, vec2(52.0), OCT(4), uSeed + 5.0));
  vec3 agg = pebbles(uv, vec2(120.0), 1.0, 0.40, uSeed + 13.0);
  float bevel = smoothstep(0.0, 0.055, min(min(p.luv.x, 1.0 - p.luv.x), min(p.luv.y, 1.0 - p.luv.y)));
  float h = 0.34 + p.face * 0.42 * mix(0.9, 1.0, bevel);
  h += base * 0.07 + fine * 0.05 + agg.x * 0.035;
  float pit = sat(1.0 - tWorley(uv, vec2(90.0), 1.0, uSeed + 17.0).x * 7.0);
  h -= pit * 0.12;
  return vec4(h, base, p.rnd.x, p.face);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell p = brickCell(c.uv, vec2(2.0, 2.0), 0.0, vec2(0.007, 0.007), uSeed);
  vec3 col = mix(vec3(0.44, 0.44, 0.445), vec3(0.655, 0.650, 0.630), sat(c.h.y));
  col *= 0.88 + 0.24 * p.rnd.y;                       // panel to panel casting variation
  col *= 0.92 + 0.18 * tWorley(c.uv, vec2(120.0), 1.0, uSeed + 13.0).z;
  float joint = 1.0 - c.h.w;
  vec3 sealant = vec3(0.24, 0.235, 0.225);
  col = mix(col, sealant, joint * 0.85);
  float st = runoff(c.uv, 18.0, uSeed + 91.0) * (0.35 + 0.65 * smoothstep(0.0, 0.35, joint + c.cav));
  col = mix(col, vec3(0.235, 0.225, 0.205), st * 0.5);
  col = mix(col, vec3(0.20, 0.19, 0.175), sat(c.cav * 2.2) * 0.45);
  col = mix(col, vec3(0.58, 0.56, 0.51), dustField(c.uv, c.up, 0.0, uSeed + 33.0) * 0.28);
  s.albedo = col;
  s.rough = 0.90 - sat(c.h.y) * 0.08 + joint * 0.05 - st * 0.16;
  s.ao = 1.0 - joint * 0.35 - sat(c.cav) * 0.2;
  return s;
}`,
  },

  asphalt: {
    worldSize: 4.0, depth: 0.014, surface: 'concrete',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  vec3 a1 = pebbles(uv, vec2(150.0), 1.0, 0.46, uSeed);
  vec3 a2 = pebbles(uv, vec2(70.0), 1.0, 0.36, uSeed + 9.0);
  float fine = n01(tFbm(uv, vec2(240.0), OCT(4), uSeed + 3.0));
  float macro = n01(tFbm(uv, vec2(4.0), OCT(5), uSeed + 21.0));
  float crack = crackField(uv, vec2(9.0), 0.055, 0.05, uSeed + 55.0);
  float pothole = sat(1.0 - tWorley(uv, vec2(6.0), 1.0, uSeed + 71.0).x * 3.2);
  pothole *= step(0.90, cellHash(uv, vec2(6.0), uSeed + 73.0));
  float h = 0.58 + a1.x * 0.16 + a2.x * 0.14 + fine * 0.06 + (macro - 0.5) * 0.10;
  h -= crack * 0.30 + pothole * 0.28;
  return vec4(h, a1.y, crack, macro);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  float stone = c.h.y;
  vec3 col = mix(vec3(0.068, 0.067, 0.070), vec3(0.140, 0.138, 0.138), sat(c.h.w));
  // exposed aggregate reads slightly lighter and cooler
  col = mix(col, vec3(0.20, 0.195, 0.19) * (0.6 + 0.8 * stone), smoothstep(0.62, 0.86, c.h.x) * 0.55);
  float tar = smoothstep(0.45, 0.80, n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 111.0)));
  float oil = smoothstep(0.70, 0.95, n01(tWarpedFbm(c.uv, vec2(5.0), OCT(4), 0.08, uSeed + 131.0)));
  col = mix(col, vec3(0.030, 0.029, 0.032), oil * 0.8);
  col = mix(col, vec3(0.42, 0.41, 0.39), sat(c.h.z) * 0.35);       // dust in the cracks
  float dust = dustField(c.uv, 0.0, c.cav, uSeed + 151.0);
  col = mix(col, vec3(0.36, 0.34, 0.31), dust * 0.30);
  s.albedo = col;
  s.rough = 0.93 - tar * 0.18 - oil * 0.42 + dust * 0.05;
  s.metal = 0.0;
  s.ao = 1.0 - sat(c.cav) * 0.30 - sat(c.h.z) * 0.25;
  return s;
}`,
  },

  sidewalk_paving: {
    worldSize: 2.4, depth: 0.016, surface: 'concrete',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  // 3x3 slabs, not 2x2: 0.8 m is the real size of a paving flag, and nine distinct
  // slabs per tile instead of four is nine times harder for the eye to count.
  Cell p = brickCell(uv, vec2(3.0, 3.0), 0.0, vec2(0.010, 0.010), uSeed);
  // broom finish: fine parallel grooves with a slight arc
  vec2 q = uv + vec2(0.0, 0.02 * sin(uv.x * TAU));
  float broom = n01(tFbm(q, vec2(3.0, 260.0), 3, uSeed + 5.0));
  float base = n01(tFbm(uv, vec2(14.0), OCT(4), uSeed + 11.0));
  vec3 agg = pebbles(uv, vec2(130.0), 1.0, 0.4, uSeed + 19.0);
  float chip = sat(1.0 - tWorley(uv, vec2(18.0), 1.0, uSeed + 29.0).x * 4.0) * (1.0 - p.edge);
  chip *= step(0.55, p.rnd.z);
  float h = 0.30 + p.face * 0.50;
  h += broom * 0.06 + base * 0.06 + agg.x * 0.03;
  h -= chip * 0.30;
  return vec4(h, base, chip, p.face);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell p = brickCell(c.uv, vec2(3.0, 3.0), 0.0, vec2(0.010, 0.010), uSeed);
  vec3 col = mix(vec3(0.46, 0.455, 0.445), vec3(0.685, 0.680, 0.660), sat(c.h.y * 0.8 + 0.25));
  // Slabs are laid from whatever pallet turned up: tone AND cast colour vary per flag,
  // and roughly one in six is a visibly different batch.
  col *= 0.86 + 0.30 * p.rnd.x;
  col = shiftHSV(col, (p.rnd.y - 0.5) * 0.02, (p.rnd.z - 0.5) * 0.35, 0.0);
  col = mix(col, col * vec3(0.86, 0.88, 0.95), step(0.83, p.rnd.z) * 0.6);
  col *= 0.93 + 0.14 * tWorley(c.uv, vec2(130.0), 1.0, uSeed + 19.0).z;
  float joint = 1.0 - c.h.w;
  col = mix(col, vec3(0.155, 0.150, 0.135), joint * 0.8);
  float moss = smoothstep(0.55, 0.9, n01(tFbm(c.uv, vec2(11.0), OCT(4), uSeed + 61.0))) * joint;
  col = mix(col, vec3(0.135, 0.175, 0.105), moss * 0.7);
  float traffic = smoothstep(0.35, 0.85, n01(tFbm(c.uv, vec2(2.0, 5.0), OCT(4), uSeed + 81.0)));
  col = mix(col, col * vec3(0.82, 0.82, 0.84), traffic * 0.5);      // polished walking line
  col = mix(col, vec3(0.72, 0.71, 0.69), c.h.z * 0.55);             // fresh chip
  float gum = step(0.985, cellHash(c.uv, vec2(24.0), uSeed + 95.0)) *
              sat(1.0 - tWorley(c.uv, vec2(24.0), 1.0, uSeed + 95.0).x * 6.0);
  col = mix(col, vec3(0.115, 0.110, 0.105), gum);
  s.albedo = col;
  s.rough = 0.92 - traffic * 0.20 + joint * 0.04 - gum * 0.25;
  s.ao = 1.0 - joint * 0.4 - sat(c.cav) * 0.2;
  return s;
}`,
  },

  /* --------------------------------------------------------------- brick */
  brick_red: {
    worldSize: 2.4, depth: 0.014, surface: 'concrete',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  Cell b = brickCell(uv, vec2(10.0, 32.0), 0.5, vec2(0.045, 0.105), uSeed);
  float face = n01(tFbm(uv, vec2(60.0), OCT(4), uSeed + b.rnd.x * 51.0));
  float mortar = n01(tFbm(uv, vec2(150.0), OCT(4), uSeed + 7.0));
  float pit = sat(1.0 - tWorley(uv, vec2(180.0), 1.0, uSeed + 13.0).x * 7.0);
  float chipC = sat(1.0 - tWorley(uv, vec2(20.0, 40.0), 1.0, uSeed + 23.0).x * 4.5) * (1.0 - b.edge);
  chipC *= step(0.72, b.rnd.y);
  float h = 0.30 + b.face * 0.46;
  h += b.face * (face * 0.10 - pit * 0.10) + (1.0 - b.face) * mortar * 0.09;
  h -= chipC * 0.30;
  h += (b.rnd.z - 0.5) * 0.05 * b.face;              // bricks sit slightly proud/recessed
  return vec4(h, b.rnd.x, b.face, chipC);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell b = brickCell(c.uv, vec2(10.0, 32.0), 0.5, vec2(0.045, 0.105), uSeed);
  // three clay families, picked per brick
  vec3 clayA = vec3(0.455, 0.185, 0.130);
  vec3 clayB = vec3(0.330, 0.155, 0.125);
  vec3 clayC = vec3(0.560, 0.290, 0.200);
  vec3 clay = mix(clayA, clayB, smoothstep(0.3, 0.75, b.rnd.x));
  clay = mix(clay, clayC, smoothstep(0.78, 1.0, b.rnd.y));
  clay = shiftHSV(clay, (b.rnd.z - 0.5) * 0.02, (b.rnd.x - 0.5) * 0.22, (b.rnd.y - 0.5) * 0.16);
  // within-brick mottling and sand-struck flecks
  float mot = n01(tFbm(c.uv, vec2(60.0), OCT(4), uSeed + b.rnd.x * 51.0));
  clay *= 0.82 + 0.36 * mot;
  clay += (tWorley(c.uv, vec2(220.0), 1.0, uSeed + 41.0).z - 0.5) * 0.05;

  // Mortar has to stay LIGHTER than the clay or the courses read as a grid of voids
  // rather than as masonry — at 20 m the joint is the only thing carrying the bond,
  // and a dark joint turns a wall into a pegboard. The base is a buff sand/cement,
  // and the cavity grime below is explicitly weakened inside the joint so the two
  // effects cannot combine into a black line.
  vec3 mortarCol = vec3(0.620, 0.605, 0.565) * (0.86 + 0.26 * n01(tFbm(c.uv, vec2(150.0), 3, uSeed + 7.0)));
  vec3 col = mix(mortarCol, clay, c.h.z);
  // efflorescence blooms out of the joints
  float eff = smoothstep(0.58, 0.92, n01(tFbm(c.uv, vec2(4.0), OCT(4), uSeed + 61.0))) * (0.4 + 0.6 * (1.0 - c.h.z));
  col = mix(col, vec3(0.78, 0.775, 0.75), eff * 0.55);
  float grime = sat(c.cav * 2.4) * mix(0.42, 1.0, c.h.z);
  col = mix(col, vec3(0.135, 0.115, 0.100), grime * 0.55);
  float st = runoff(c.uv, 22.0, uSeed + 71.0);
  col = mix(col, vec3(0.185, 0.165, 0.145), st * 0.42);
  float moss = smoothstep(0.62, 0.95, n01(tFbm(c.uv, vec2(3.0, 8.0), OCT(4), uSeed + 87.0)))
             * smoothstep(0.40, 0.85, n01(tFbm(c.uv, vec2(2.0, 1.0), 3, uSeed + 89.0)));
  col = mix(col, vec3(0.13, 0.16, 0.10), moss * 0.45);
  col = mix(col, clay * 1.35 + 0.04, c.h.w * 0.8);   // fresh break is brighter
  col = mix(col, vec3(0.56, 0.54, 0.50), dustField(c.uv, c.up, 0.0, uSeed + 99.0) * 0.30);
  s.albedo = col;
  s.rough = mix(0.95, 0.80, c.h.z) - eff * 0.04 + grime * 0.03 - st * 0.10;
  s.ao = 1.0 - (1.0 - c.h.z) * 0.20 - grime * 0.18;
  return s;
}`,
  },

  brick_painted: {
    worldSize: 2.4, depth: 0.011, surface: 'plaster',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  Cell b = brickCell(uv, vec2(10.0, 32.0), 0.5, vec2(0.045, 0.105), uSeed);
  float face = n01(tFbm(uv, vec2(55.0), OCT(4), uSeed + b.rnd.x * 51.0));
  float mortar = n01(tFbm(uv, vec2(140.0), OCT(3), uSeed + 7.0));
  // paint fills the joints, so relief is shallower than bare brick
  float h = 0.36 + b.face * 0.34 + b.face * face * 0.07 + (1.0 - b.face) * mortar * 0.05;
  float peel = smoothstep(0.55, 0.85, n01(tWarpedFbm(uv, vec2(7.0), OCT(4), 0.10, uSeed + 33.0)));
  h += peel * 0.03;
  return vec4(h, b.rnd.x, b.face, peel);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell b = brickCell(c.uv, vec2(10.0, 32.0), 0.5, vec2(0.045, 0.105), uSeed);
  vec3 paint = vec3(0.735, 0.720, 0.665);
  paint = shiftHSV(paint, 0.0, 0.0, (n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 5.0)) - 0.5) * 0.14);
  vec3 clay = vec3(0.400, 0.180, 0.135) * (0.8 + 0.4 * b.rnd.x);
  vec3 mortarCol = vec3(0.50, 0.49, 0.465);
  vec3 under = mix(mortarCol, clay, c.h.z);
  // paint fails on the exposed brick faces first
  float wear = c.h.w * c.h.z * (0.35 + 0.9 * b.rnd.y)
             * smoothstep(0.30, 0.80, n01(tFbm(c.uv, vec2(40.0), OCT(4), uSeed + 45.0)));
  wear = sat(wear * 1.9 - sat(c.cav) * 0.8 - (1.0 - b.edge) * 0.35);
  vec3 col = mix(paint, under, wear);
  float chalk = n01(tFbm(c.uv, vec2(9.0), OCT(4), uSeed + 63.0));
  col *= 0.90 + 0.18 * chalk;
  float st = runoff(c.uv, 20.0, uSeed + 71.0);
  col = mix(col, vec3(0.315, 0.300, 0.270), st * 0.5);
  float grime = sat(c.cav * 2.4);
  col = mix(col, vec3(0.19, 0.180, 0.165), grime * 0.5);
  float graf = smoothstep(0.86, 0.98, n01(tWarpedFbm(c.uv, vec2(4.0, 6.0), OCT(4), 0.22, uSeed + 205.0)));
  col = mix(col, vec3(0.10, 0.14, 0.32), graf * 0.35);
  s.albedo = col;
  s.rough = mix(0.72, 0.93, wear) + chalk * 0.05 - st * 0.10 + grime * 0.03;
  s.ao = 1.0 - (1.0 - c.h.z) * 0.20 - grime * 0.18;
  return s;
}`,
  },

  plaster_cracked: {
    worldSize: 3.0, depth: 0.021, surface: 'plaster',
    glsl: /* glsl */ `
/*
 * Cracked render, authored the way it actually fails.
 *
 * The previous version ran crackField unmasked at two scales, so every square metre
 * of every plaster surface in the map carried an evenly-spaced Voronoi cell network:
 * crackle-glazed pottery, not a building. Real stucco is *sound* over ~90% of a wall
 * and fails in discrete patches — around a lintel, at a downpipe, where the substrate
 * moved. Where it has failed you get a hole with a hard chipped rim and a different
 * material visible inside it, with the crack net radiating out from that hole.
 *
 * So one warped low-frequency field (fail) decides everything, and both the cracks
 * and the spall hang off it. Roughly four fifths of any wall never crosses the first
 * threshold at all and stays sound.
 *
 * Scale budget. A 3 m tile with only 'base' at 7 cycles (43 cm) and 'trowel' at 6x40
 * (50 x 7.5 cm) has nothing at all between 1 cm and 40 cm, and nothing below 7 cm in
 * either direction — which is why killing the crack net emptied the wall instead of
 * cleaning it up. Render is applied in three operations and each leaves its own band:
 *   dubbing / float  ~15 cm   flt     the plasterer's arm
 *   darby / skim     ~4-10 cm skim    directional, follows the float
 *   sharp sand       ~2 cm    sandg   the aggregate in the mix
 *   fine sand skin   ~7 mm    grit
 *   pinholes         ~1 cm    pin     entrained air at the surface
 */
vec4 mHeight(vec2 uv){
  float base = n01(tFbm(uv, vec2(7.0), OCT(5), uSeed));
  float trowel = n01(tFbm(shearX(uv, 1.0), vec2(6.0, 40.0), OCT(4), uSeed + 3.0));
  float flt = n01(tFbm(uv, vec2(20.0), OCT(4), uSeed + 13.0));
  float skim = n01(tFbm(shearX(uv, -2.0), vec2(30.0, 96.0), OCT(3), uSeed + 19.0));
  vec3 sandg = pebbles(uv, vec2(155.0), 1.0, 0.40, uSeed + 23.0);
  float grit = n01(tFbm(uv, vec2(430.0), 3, uSeed + 29.0));
  float pin = sat(1.0 - tWorley(uv, vec2(270.0), 1.0, uSeed + 31.0).x * 7.5);
  pin *= step(0.42, cellHash(uv, vec2(270.0), uSeed + 33.0));

  float fail  = n01(tWarpedFbm(uv, vec2(1.7), OCT(5), 0.13, uSeed + 51.0));
  float zone  = smoothstep(0.575, 0.685, fail);   // sparse: cracks live only in here
  float spall = smoothstep(0.700, 0.748, fail);   // the middle of a zone has let go
  // The rim of the hole: a narrow band at the spall boundary. 4s(1-s) peaks exactly
  // on the transition, so the surface pass can rebuild it from spall alone.
  float lip = 4.0 * spall * (1.0 - spall);

  float c1 = crackField(uv, vec2(9.0),  0.024, 0.18, uSeed + 21.0);
  float c2 = crackField(uv, vec2(24.0), 0.014, 0.06, uSeed + 37.0);
  // Cracks are gated by the same field, densest right at the edge of the spall and
  // gone inside it (there is no render left there to crack).
  float crack = sat(c1 + c2 * 0.65) * zone * (1.0 - spall * 0.9);
  // A crack has a width-to-depth relationship: the wide ones are deep and open, the
  // hairlines are shallow. Squaring the mask before it cuts the height is what gives
  // the wide ones a slot with a shadow in it and leaves the hairlines as hairlines,
  // instead of every line being one pencil stroke of the same weight.
  float crackDeep = crack * crack;

  Cell sb = brickCell(uv, vec2(8.0, 26.0), 0.5, vec2(0.05, 0.11), uSeed + 71.0);
  float sub = n01(tFbm(uv, vec2(70.0), OCT(4), uSeed + 67.0)) * 0.5 + sb.face * 0.5;

  float h = 0.60 + base * 0.085 + trowel * 0.050 + flt * 0.058 + skim * 0.042;
  h += sandg.x * 0.034 + grit * 0.026 - pin * 0.048;
  h -= crack * 0.10 + crackDeep * 0.30;
  h += lip * lip * 0.055;                  // the render stands proud of the hole
  h = mix(h, 0.28 + sub * 0.16, spall);    // and steps down hard into the blockwork
  return vec4(h, base * 0.6 + flt * 0.4, crack, spall);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  float spall = c.h.w;
  float crack = sat(c.h.z);
  float lip = 4.0 * spall * (1.0 - spall);

  vec3 plaster = vec3(0.700, 0.680, 0.635);
  plaster = shiftHSV(plaster, 0.0, (c.h.y - 0.5) * 0.25, (c.h.y - 0.5) * 0.13);

  // ---- the bands the height field carries, brought through into colour ----------
  // A render that is uniform in albedo between 1 cm and 40 cm reads as painted card
  // however good its normal map is, because at 4 m the normal is doing almost nothing
  // and the albedo is doing everything.
  float flt  = n01(tFbm(c.uv, vec2(20.0), OCT(4), uSeed + 13.0));
  float skim = n01(tFbm(shearX(c.uv, -2.0), vec2(30.0, 96.0), OCT(3), uSeed + 19.0));
  vec3  sandg = pebbles(c.uv, vec2(155.0), 1.0, 0.40, uSeed + 23.0);
  float grit = n01(tFbm(c.uv, vec2(430.0), 3, uSeed + 29.0));
  plaster *= 0.855 + 0.30 * flt;                                 // float pass, ~15 cm
  plaster *= 0.930 + 0.145 * skim;                               // darby marks, ~5 cm
  // Sharp sand in the mix: a pale quartz grain and a dark one, both at 2 cm.
  plaster = mix(plaster, plaster * 1.30 + 0.035, smoothstep(0.48, 0.93, sandg.y) * 0.44);
  plaster = mix(plaster, plaster * 0.66, smoothstep(0.36, 0.02, sandg.y) * 0.40);
  plaster *= 0.920 + 0.16 * grit;                                // fine skin, ~7 mm

  Cell sb = brickCell(c.uv, vec2(8.0, 26.0), 0.5, vec2(0.05, 0.11), uSeed + 71.0);
  vec3 substrate = mix(vec3(0.500, 0.485, 0.455), vec3(0.400, 0.215, 0.165) * (0.7 + 0.6 * sb.rnd.x), sb.face);
  substrate *= 0.85 + 0.3 * n01(tFbm(c.uv, vec2(40.0), 3, uSeed + 67.0));
  vec3 col = mix(plaster, substrate, spall);
  // Fresh break: the exposed edge of the render is paler than the weathered face.
  col = mix(col, vec3(0.815, 0.795, 0.745), lip * 0.5 * (1.0 - spall));
  // A crack is a slot with a chipped pale rim, dirt in the bottom and the substrate
  // showing through the wide parts — not a pencil line. rim is the shoulder of the
  // mask, where the render has broken away but not opened; that pale edge with the
  // dark slot beside it is the whole reason a crack reads at 6 m.
  float rim = sat(crack * 3.4) * (1.0 - smoothstep(0.22, 0.62, crack));
  col = mix(col, vec3(0.845, 0.825, 0.775), rim * 0.42 * (1.0 - spall));
  float slot = smoothstep(0.18, 0.78, crack);
  col = mix(col, mix(vec3(0.115, 0.106, 0.094), substrate * 0.45, 0.45), slot * 0.9);
  float grime = sat(c.cav * 2.5);
  col = mix(col, vec3(0.21, 0.20, 0.18), grime * 0.45);
  float st = runoff(c.uv, 18.0, uSeed + 81.0);
  col = mix(col, vec3(0.30, 0.285, 0.255), st * 0.40);
  // Damp was at (2,3) cycles on a 3 m tile — a 1.5 m smear, and in tile UV so it
  // restarted every tile. At (6,9) it reads as patchy salt/damp discolouration, which
  // is what it is, and it no longer competes with the world-space macro band.
  float damp = smoothstep(0.52, 0.95, n01(tFbm(c.uv, vec2(6.0, 9.0), OCT(4), uSeed + 93.0)))
             * smoothstep(0.35, 0.80, n01(tFbm(c.uv, vec2(3.0, 5.0), 3, uSeed + 95.0)));
  col = mix(col, col * vec3(0.66, 0.66, 0.70), damp * 0.6);
  col = mix(col, vec3(0.60, 0.575, 0.52), dustField(c.uv, c.up, 0.0, uSeed + 105.0) * 0.28);
  s.albedo = col;
  // Exposed blockwork is coarser than the finished render; the chipped lip is not.
  s.rough = 0.86 + spall * 0.10 - damp * 0.18 + slot * 0.06 - st * 0.08 - lip * 0.06
          - rim * 0.05 + (sandg.x - 0.5) * 0.12 + (grit - 0.5) * 0.09 + (flt - 0.5) * 0.07;
  s.ao = 1.0 - slot * 0.55 - spall * 0.18;
  return s;
}`,
  },

  stucco: {
    worldSize: 2.5, depth: 0.017, surface: 'plaster',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  // trowelled swirls: warped low frequency plus a coarse aggregate skin.
  // Bands, coarse to fine on a 2.5 m tile: knock-down 25 cm, dash/float 9 cm,
  // aggregate 2.3 cm, skin 0.8 cm, sand 0.36 cm. The 5-12 cm band was the hole.
  vec2 q = tWarp(uv, vec2(6.0), 0.045, 3, uSeed + 2.0);
  float swirl = n01(tFbm(q, vec2(10.0), OCT(5), uSeed));
  float knock = smoothstep(0.42, 0.72, swirl);
  float dash = n01(tFbm(shearX(q, 2.0), vec2(27.0, 39.0), OCT(4), uSeed + 31.0));
  vec3 grit = pebbles(uv, vec2(110.0), 1.0, 0.44, uSeed + 11.0);
  float fine = n01(tFbm(uv, vec2(300.0), 3, uSeed + 17.0));
  float sandskin = n01(tFbm(uv, vec2(700.0), 3, uSeed + 37.0));
  float pin = sat(1.0 - tWorley(uv, vec2(300.0), 1.0, uSeed + 41.0).x * 8.0)
            * step(0.5, cellHash(uv, vec2(300.0), uSeed + 43.0));
  float h = 0.40 + knock * 0.28 + swirl * 0.10 + dash * 0.10 + grit.x * 0.085
          + fine * 0.045 + sandskin * 0.03 - pin * 0.05;
  return vec4(h, swirl * 0.65 + dash * 0.35, knock, grit.y);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 base = vec3(0.700, 0.660, 0.575);
  base = shiftHSV(base, (c.h.y - 0.5) * 0.012, (c.h.y - 0.5) * 0.3, (c.h.y - 0.5) * 0.16);
  vec3 col = base * (0.86 + 0.26 * c.h.y);
  // Aggregate: c.h.w is the per-stone random from the 2.3 cm pebble field, so a pale
  // quartz grain and a dark one can be picked out individually instead of the whole
  // skin being shaded by one 12% multiply.
  col = mix(col, col * 1.32 + 0.032, smoothstep(0.54, 0.96, c.h.w) * 0.48);
  col = mix(col, col * 0.68, smoothstep(0.40, 0.03, c.h.w) * 0.42);
  float sandskin = n01(tFbm(c.uv, vec2(700.0), 3, uSeed + 37.0));
  col *= 0.920 + 0.16 * sandskin;
  float dashc = n01(tFbm(shearX(c.uv, 2.0), vec2(27.0, 39.0), OCT(4), uSeed + 31.0));
  col *= 0.900 + 0.20 * dashc;
  float grime = sat(c.cav * 2.8);
  col = mix(col, vec3(0.235, 0.220, 0.190), grime * 0.5);
  float st = runoff(c.uv, 16.0, uSeed + 71.0);
  col = mix(col, vec3(0.325, 0.305, 0.265), st * 0.45);
  float splash = smoothstep(0.45, 0.90, n01(tFbm(c.uv, vec2(2.0, 1.0), 3, uSeed + 89.0)))
               * n01(tFbm(c.uv, vec2(28.0), OCT(4), uSeed + 91.0));
  col = mix(col, vec3(0.30, 0.265, 0.215), splash * 0.5);
  col = mix(col, vec3(0.615, 0.585, 0.520), dustField(c.uv, c.up, 0.0, uSeed + 101.0) * 0.35);
  s.albedo = col;
  s.rough = 0.93 - c.h.z * 0.05 + grime * 0.03 - st * 0.10
          + (sandskin - 0.5) * 0.10 + (c.h.w - 0.5) * 0.09 + (dashc - 0.5) * 0.06;
  s.ao = 1.0 - grime * 0.28;
  return s;
}`,
  },

  /* --------------------------------------------------------------- metal */
  rusted_steel: {
    worldSize: 2.0, depth: 0.007, surface: 'metal',
    glsl: /* glsl */ `
/*
 * Three genuinely different materials on one plate, not one material with a pattern.
 *
 * The failure before was that a single soft rustField drove colour, roughness AND
 * metalness, so the specular band ran continuously from oxide into bare steel without
 * ever changing character — which is physically impossible and reads as one plastic
 * object. Loose scale does not fade into steel: it lifts, cracks and falls off, and
 * the boundary is a hard chipped outline with a proud lip that catches the key light.
 *
 *   bare steel   metal 1.0   rough ~0.35  (after the [0.22,1] remap)
 *   oxide film   metal 0.45  rough ~0.68  thin, still specular, no relief
 *   loose scale  metal 0.0   rough ~0.95  matte, pitted, sits above the steel
 */
vec4 mHeight(vec2 uv){
  float stain = rustField(uv, 6.0, 0.36, uSeed);                       // soft oxide bloom
  float fn = n01(tWarpedFbm(uv, vec2(24.0), OCT(4), 0.07, uSeed + 29.0));
  // Hard cut across a field that already has ragged edges, so the scale gets a flake
  // outline instead of an airbrushed gradient. The window is ~2 texels at 1K, which is
  // as hard as it can be without the rim aliasing into a crawling white line.
  float rust = smoothstep(0.478, 0.522, stain * 0.74 + fn * 0.26);
  float scale = n01(tFbm(uv, vec2(40.0), OCT(5), uSeed + 13.0));
  float flake = smoothstep(0.54, 0.62, fn) * rust;
  float pit = sat(1.0 - tWorley(uv, vec2(110.0), 1.0, uSeed + 37.0).x * 6.0) * rust;
  float dent = n01(tFbm(uv, vec2(3.0), OCT(4), uSeed + 51.0));
  // weld seam across the plate
  float seam = 1.0 - smoothstep(0.0, 0.012, abs(fract(uv.y * 2.0 + 0.25) - 0.5) * 2.0 - 0.0);
  float bead = seam * (0.6 + 0.4 * n01(tFbm(uv, vec2(200.0, 6.0), 3, uSeed + 61.0)));
  // rivet line along the seam
  float rivRow = smoothstep(0.03, 0.0, abs(fract(uv.y * 2.0 + 0.25) - 0.5) * 2.0 - 0.02);
  float riv = sat(1.0 - length(vec2(fract(uv.x * 24.0) - 0.5, (fract(uv.y * 2.0 + 0.25) - 0.5) * 12.0)) * 4.0) * rivRow;
  // The scale sits ON the steel — a real step up, and a lip around its edge.
  float lip = 4.0 * rust * (1.0 - rust);
  float h = 0.58 + dent * 0.10 + rust * (0.06 + scale * 0.12);
  h += lip * lip * 0.05 + flake * 0.06 - pit * 0.22 + bead * 0.16 + riv * 0.22;
  return vec4(h, rust, flake, stain);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  float rust = c.h.y;                       // hard-edged loose scale
  float stain = c.h.w;                      // soft oxide film on otherwise sound steel
  float film = sat(stain * 1.25 - 0.25) * (1.0 - rust);
  float lip = 4.0 * rust * (1.0 - rust);

  vec3 steel = vec3(0.345, 0.350, 0.360);
  steel *= 0.88 + 0.22 * n01(tFbm(c.uv, vec2(70.0), OCT(3), uSeed + 7.0));
  float rn = n01(tFbm(c.uv, vec2(30.0), OCT(4), uSeed + 19.0));
  vec3 rustDark = vec3(0.215, 0.095, 0.045);
  vec3 rustMid  = vec3(0.445, 0.200, 0.085);
  vec3 rustPale = vec3(0.605, 0.330, 0.155);
  vec3 rustCol = mix(rustDark, rustMid, sat(rn * 1.3));
  rustCol = mix(rustCol, rustPale, smoothstep(0.62, 0.95, rn));
  // Pitting is visible as dark speckle inside the scale, not just as relief.
  rustCol *= 1.0 - sat(1.0 - tWorley(c.uv, vec2(110.0), 1.0, uSeed + 37.0).x * 6.0) * 0.45;
  vec3 col = mix(steel, rustCol, rust);
  col = mix(col, mix(steel, rustMid, 0.55), film * 0.8);          // the thin film
  // A freshly exposed flake edge is bright metal for a while.
  col = mix(col, vec3(0.60, 0.60, 0.61), lip * 0.28 * (1.0 - film));
  // rust bleeding downwards over clean steel
  float bleed = runoff(c.uv, 20.0, uSeed + 83.0) * (1.0 - rust);
  col = mix(col, vec3(0.395, 0.180, 0.080), bleed * 0.55);
  float scr = scratches(c.uv, 0.75, uSeed + 97.0) * (1.0 - rust * 0.8);
  col = mix(col, vec3(0.52, 0.53, 0.545), scr * 0.5);
  col = mix(col, vec3(0.17, 0.09, 0.05), sat(c.cav * 2.2) * rust * 0.5);
  s.albedo = col;
  // Metalness follows the *same* hard mask as the colour, so a boundary in the albedo
  // is always a boundary in the specular response too.
  float bare = (1.0 - rust) * (1.0 - film * 0.62);
  s.metal = sat(bare * (1.0 - bleed * 0.55));
  // uCodMetal/uCodRough remap [0.22,1] on top of this: 0.16 -> ~0.35, 0.94 -> ~0.95.
  s.rough = mix(0.94, 0.28, bare) + c.h.z * 0.06 - scr * 0.18 + bleed * 0.10 - lip * 0.10;
  s.ao = 1.0 - sat(c.cav) * 0.35;
  return s;
}`,
  },

  painted_steel_chipped: {
    worldSize: 2.0, depth: 0.005, surface: 'metal',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  Cell p = brickCell(uv, vec2(2.0, 2.0), 0.0, vec2(0.004, 0.004), uSeed + 1.0);
  float dent = n01(tFbm(uv, vec2(4.0), OCT(4), uSeed + 5.0));
  float orange = n01(tFbm(uv, vec2(38.0), OCT(3), uSeed + 11.0));      // orange-peel paint
  float chipN = n01(tWarpedFbm(uv, vec2(13.0), OCT(4), 0.07, uSeed + 23.0));
  float chipF = n01(tWarpedFbm(uv, vec2(38.0), OCT(4), 0.05, uSeed + 29.0));
  // Paint does not fade out, it lets go: a hard boundary with a raised lip of coating
  // around the bare patch. Two texels of window, same reasoning as rusted_steel.
  float chip = smoothstep(0.512, 0.552, chipN * (0.72 + 0.5 * (1.0 - p.edge)));
  chip = sat(chip + smoothstep(0.645, 0.675, chipF) * 0.75);
  float rust = rustField(uv, 9.0, 0.72, uSeed + 41.0) * chip;
  float lip = 4.0 * chip * (1.0 - chip);
  float h = 0.66 + dent * 0.12 + orange * 0.05 + p.face * 0.06;
  h -= chip * 0.13 + rust * 0.07;
  h += lip * lip * 0.035;                 // the coating stands proud of the bare metal
  return vec4(h, chip, rust, dent);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  float chip = c.h.y, rust = c.h.z;
  vec3 topcoat = vec3(0.145, 0.290, 0.245);
  topcoat = shiftHSV(topcoat, (n01(tFbm(c.uv, vec2(2.0), 3, uSeed + 3.0)) - 0.5) * 0.02, 0.0,
                     (n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 9.0)) - 0.5) * 0.22);
  vec3 primer = vec3(0.475, 0.315, 0.205);
  vec3 bare   = vec3(0.400, 0.405, 0.415);
  vec3 rustC  = vec3(0.360, 0.160, 0.070);
  float deep = smoothstep(0.35, 0.85, chip);
  vec3 col = mix(topcoat, primer, sat(chip * 1.6));
  col = mix(col, bare, deep * 0.8);
  col = mix(col, rustC, rust);
  float scr = scratches(c.uv, 0.9, uSeed + 55.0);
  col = mix(col, mix(primer, bare, 0.6), scr * (0.35 + 0.4 * (1.0 - chip)));
  float st = runoff(c.uv, 18.0, uSeed + 71.0);
  col = mix(col, vec3(0.30, 0.19, 0.11), st * rustField(c.uv, 4.0, 0.55, uSeed + 77.0) * 0.6);
  col = mix(col, vec3(0.235, 0.230, 0.215), sat(c.cav * 2.2) * 0.4);
  float dust = dustField(c.uv, c.up, 0.0, uSeed + 91.0);
  col = mix(col, vec3(0.50, 0.48, 0.44), dust * 0.22);
  s.albedo = col;
  s.metal = sat(deep * 0.9 * (1.0 - rust) + scr * 0.35 * (1.0 - rust));
  s.rough = mix(0.42, 0.88, sat(chip)) + rust * 0.20 - scr * 0.12 + dust * 0.10;
  s.rough = sat(s.rough - smoothstep(0.2, 0.0, chip) * 0.10);
  s.ao = 1.0 - sat(c.cav) * 0.3;
  return s;
}`,
  },

  galvanised_metal: {
    // 0.004 m, not 0.002: sheet steel is thin but it is *pressed*, and the swage
    // lines, the panel fold and the fixing screws are the only things standing
    // between a rooftop AC casing and a white cuboid at 8 m.
    worldSize: 1.6, depth: 0.004, surface: 'metal',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  // spangle: large flat zinc crystals
  vec2 q = tWarp(uv, vec2(20.0), 0.008, 2, uSeed + 3.0);
  vec4 w = tWorleyAng(q, vec2(34.0), 0.95, uSeed);
  vec4 w2 = tWorleyAng(q, vec2(80.0), 0.95, uSeed + 61.0);
  float facet = w.z * 0.7 + w2.z * 0.3;
  float grain = n01(tFbm(uv, vec2(120.0), OCT(3), uSeed + 7.0));
  float dent = n01(tFbm(uv, vec2(5.0), OCT(4), uSeed + 13.0));
  float edge = smoothstep(0.0, 0.035, w.y - w.x);
  // Oil-canning: a thin panel never stays flat, it waves between its fixings. This is
  // the ~30 cm band, and it is what breaks the specular into something readable.
  float can = n01(tFbm(uv, vec2(2.0, 3.0), OCT(4), uSeed + 53.0));
  // Pressed stiffening swages, two per panel, and the panel's own folded edge.
  float sw = abs(fract(uv.y * 4.0 + 0.5) - 0.5) * 2.0;
  float swage = smoothstep(0.22, 0.06, sw);
  float foldD = abs(fract(uv.y) - 0.5) * 2.0;
  float fold = smoothstep(0.055, 0.0, 1.0 - foldD);
  // Pan-head fixings on the fold line.
  float scr = sat(1.0 - length(vec2(fract(uv.x * 8.0) - 0.5, (fract(uv.y + 0.5) - 0.5) * 8.0)) * 6.0);
  float h = 0.66 + can * 0.20 + dent * 0.10 + grain * 0.035 + (facet - 0.5) * 0.02;
  h += swage * 0.11 + fold * 0.16 + scr * 0.14;
  h -= (1.0 - edge) * 0.04;
  return vec4(h, facet, edge, can);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 zinc = vec3(0.560, 0.575, 0.585);
  vec3 col = zinc * (0.90 + 0.19 * c.h.y);
  col = mix(col, zinc * 0.84, 1.0 - c.h.z);
  // Zinc weathers to a dull mid-grey long before it goes white; without that darker
  // family the sheet has nowhere to go but up and the whole casing clips to paper.
  float dull = smoothstep(0.35, 0.80, n01(tFbm(c.uv, vec2(4.0), OCT(4), uSeed + 19.0)));
  col = mix(col, vec3(0.360, 0.368, 0.372), dull * 0.55);
  float white = smoothstep(0.58, 0.9, n01(tWarpedFbm(c.uv, vec2(7.0), OCT(4), 0.08, uSeed + 33.0)));
  col = mix(col, vec3(0.700, 0.695, 0.665), white * 0.7);                 // white rust
  // Panel geometry read in colour as well as relief.
  float sw = abs(fract(c.uv.y * 4.0 + 0.5) - 0.5) * 2.0;
  float swage = smoothstep(0.22, 0.06, sw);
  float foldD = abs(fract(c.uv.y) - 0.5) * 2.0;
  float fold = smoothstep(0.055, 0.0, 1.0 - foldD);
  col = mix(col, col * 1.12 + 0.015, swage * 0.35);
  col = mix(col, col * 0.80, fold * 0.5);
  float scrw = sat(1.0 - length(vec2(fract(c.uv.x * 8.0) - 0.5, (fract(c.uv.y + 0.5) - 0.5) * 8.0)) * 6.0);
  col = mix(col, vec3(0.300, 0.290, 0.270), scrw * 0.6);
  // Rust weeps out of every fixing, and dirt collects along the swage.
  float weep = sat(1.0 - length(vec2(fract(c.uv.x * 8.0) - 0.5, (fract(c.uv.y + 0.5) - 0.62) * 2.6)) * 3.0)
             * step(0.35, cellHash(c.uv, vec2(8.0, 1.0), uSeed + 71.0));
  col = mix(col, vec3(0.330, 0.180, 0.095), sat(weep) * 0.5);
  float scr = scratches(c.uv, 0.6, uSeed + 45.0);
  col = mix(col, vec3(0.66, 0.67, 0.68), scr * 0.4);
  float grime = sat(c.cav * 2.0);
  col = mix(col, vec3(0.29, 0.29, 0.28), grime * 0.4);
  float st = runoff(c.uv, 22.0, uSeed + 61.0);
  col = mix(col, vec3(0.32, 0.315, 0.295), st * 0.42);
  s.albedo = col;
  s.metal = sat(1.0 - white * 0.75 - st * 0.25 - dull * 0.25 - weep * 0.6);
  s.rough = 0.30 + c.h.y * 0.20 + white * 0.40 + dull * 0.22 + grime * 0.10 + weep * 0.3
          - scr * 0.08 + (1.0 - c.h.z) * 0.06 + st * 0.12;
  s.ao = 1.0 - grime * 0.2 - fold * 0.25;
  return s;
}`,
  },

  brushed_aluminium: {
    worldSize: 1.0, depth: 0.0012, surface: 'metal',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  float brush = n01(tFbm(uv, vec2(6.0, 900.0), 3, uSeed));
  float brush2 = n01(tFbm(uv, vec2(3.0, 380.0), 3, uSeed + 5.0));
  float dent = n01(tFbm(uv, vec2(4.0), OCT(4), uSeed + 11.0));
  float ding = sat(1.0 - tWorley(uv, vec2(14.0), 1.0, uSeed + 17.0).x * 8.0) * step(0.88, cellHash(uv, vec2(14.0), uSeed + 19.0));
  float h = 0.72 + brush * 0.13 + brush2 * 0.09 + dent * 0.06 - ding * 0.20;
  return vec4(h, brush, brush2, ding);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 alu = vec3(0.735, 0.745, 0.755);
  vec3 col = alu * (0.93 + 0.10 * c.h.y);
  float smear = n01(tFbm(c.uv, vec2(5.0), OCT(4), uSeed + 29.0));
  col *= 0.96 + 0.06 * smear;
  float finger = smoothstep(0.66, 0.92, n01(tWarpedFbm(c.uv, vec2(9.0), OCT(4), 0.10, uSeed + 41.0)));
  col = mix(col, col * 0.90, finger * 0.7);
  float grime = sat(c.cav * 2.0);
  col = mix(col, vec3(0.34, 0.34, 0.335), grime * 0.30);
  col = mix(col, vec3(0.58, 0.57, 0.555), c.h.w * 0.4);
  s.albedo = col;
  s.metal = sat(1.0 - finger * 0.18 - grime * 0.25);
  // anisotropic-looking roughness: the brush lines drive it directly
  s.rough = 0.16 + c.h.y * 0.26 + c.h.z * 0.10 + finger * 0.22 + grime * 0.18 + c.h.w * 0.15;
  s.ao = 1.0 - grime * 0.15;
  return s;
}`,
  },

  corrugated_metal: {
    worldSize: 2.0, depth: 0.032, surface: 'metal',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  float ribs = 8.0;
  float ph = fract(uv.x * ribs);
  float wave = 0.5 - 0.5 * cos(ph * TAU);
  wave = pow(wave, 0.85);
  float dent = n01(tFbm(uv, vec2(5.0, 3.0), OCT(4), uSeed + 7.0));
  float buckle = n01(tFbm(uv, vec2(2.0, 9.0), OCT(4), uSeed + 13.0));
  // fixing screws along horizontal purlin lines
  float rowY = abs(fract(uv.y * 3.0) - 0.5) * 2.0;
  float row = smoothstep(0.10, 0.0, rowY);
  float screw = sat(1.0 - length(vec2((fract(uv.x * ribs) - 0.5) * 1.0, (fract(uv.y * 3.0) - 0.5) * 3.0)) * 7.0) * row;
  float rust = rustField(uv, 7.0, 0.58, uSeed + 21.0) * (0.35 + 0.65 * (1.0 - wave));
  float h = 0.20 + wave * 0.62 + dent * 0.06 + buckle * 0.05 + screw * 0.10 - rust * 0.05;
  return vec4(h, wave, rust, screw);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  float wave = c.h.y, rust = c.h.z;
  vec3 paint = vec3(0.310, 0.360, 0.375);
  paint = shiftHSV(paint, 0.0, 0.0, (n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 3.0)) - 0.5) * 0.28);
  float fade = smoothstep(0.3, 1.0, wave);
  paint = mix(paint, paint * 1.25 + 0.03, fade * 0.45);                  // sun-bleached crests
  vec3 rustC = mix(vec3(0.255, 0.115, 0.055), vec3(0.510, 0.245, 0.105),
                   n01(tFbm(c.uv, vec2(35.0), OCT(3), uSeed + 27.0)));
  vec3 col = mix(paint, rustC, sat(rust * 1.1));
  float bleed = runoff(c.uv, 26.0, uSeed + 51.0) * (1.0 - rust) * (0.4 + 0.6 * (1.0 - wave));
  col = mix(col, vec3(0.375, 0.175, 0.075), bleed * 0.5);
  col = mix(col, vec3(0.20, 0.19, 0.18), sat(c.cav * 2.0) * 0.35);
  col = mix(col, vec3(0.62, 0.62, 0.60), c.h.w * 0.35);
  float dust = dustField(c.uv, c.up, 0.0, uSeed + 63.0);
  col = mix(col, vec3(0.47, 0.45, 0.41), dust * 0.20);
  s.albedo = col;
  s.metal = sat((1.0 - rust) * 0.55);
  s.rough = mix(0.44, 0.92, sat(rust)) + dust * 0.10 - fade * 0.05 + bleed * 0.10;
  s.ao = 1.0 - (1.0 - wave) * 0.25 - sat(c.cav) * 0.2;
  return s;
}`,
  },

  /* ---------------------------------------------------------------- wood */
  wood_plank_weathered: {
    worldSize: 2.4, depth: 0.012, surface: 'wood',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  Cell p = plankCell(uv, vec2(3.0, 7.0), vec2(0.007, 0.014), uSeed);
  vec2 q = tWarp(uv, vec2(4.0, 26.0), 0.012, 3, uSeed + p.rnd.x * 41.0);
  float grain = n01(tFbm(q, vec2(9.0, 300.0), OCT(4), uSeed + p.rnd.x * 71.0));
  float rings = n01(tFbm(q, vec2(4.0, 46.0), OCT(4), uSeed + 5.0));
  float fibre = n01(tFbm(uv, vec2(14.0, 520.0), 3, uSeed + 9.0));
  // knots
  vec4 kw = tWorley(vec2(uv.x, uv.y * 2.0), vec2(6.0, 8.0), 1.0, uSeed + 17.0);
  float knot = sat(1.0 - kw.x * 7.0) * step(0.72, kw.z);
  float split = 1.0 - smoothstep(0.0, 0.02, abs(n01(tFbm(uv, vec2(3.0, 90.0), 3, uSeed + 23.0)) - 0.5));
  split *= step(0.6, cellHash(uv, vec2(3.0, 7.0), uSeed + 29.0));
  float h = 0.30 + p.face * 0.44;
  h += p.face * (grain * 0.10 + rings * 0.06 + fibre * 0.05 - knot * 0.10 - split * 0.16);
  h += (p.rnd.y - 0.5) * 0.05 * p.face;
  return vec4(h, grain, knot, p.rnd.x);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell p = plankCell(c.uv, vec2(3.0, 7.0), vec2(0.007, 0.014), uSeed);
  vec3 early = vec3(0.400, 0.290, 0.185);
  vec3 late  = vec3(0.225, 0.150, 0.090);
  vec3 wood = mix(late, early, sat(c.h.y * 1.15 - 0.05));
  wood = shiftHSV(wood, (p.rnd.x - 0.5) * 0.02, (p.rnd.y - 0.5) * 0.25, (p.rnd.z - 0.5) * 0.22);
  // sun/rain weathering turns the surface silver-grey
  float weather = sat(n01(tFbm(c.uv, vec2(4.0), OCT(4), uSeed + 61.0)) * 1.25 - 0.12);
  weather = sat(weather * (0.55 + 0.45 * c.up));
  vec3 grey = vec3(0.400, 0.385, 0.360);
  vec3 col = mix(wood, grey, weather * 0.72);
  col = mix(col, vec3(0.115, 0.080, 0.050), c.h.z * 0.85);               // knots
  float gap = 1.0 - p.face;
  col = mix(col, vec3(0.075, 0.062, 0.050), gap * 0.85);
  float grime = sat(c.cav * 2.4);
  col = mix(col, vec3(0.145, 0.125, 0.100), grime * 0.5);
  float st = runoff(c.uv, 16.0, uSeed + 77.0);
  col = mix(col, vec3(0.215, 0.190, 0.155), st * 0.35);
  float mould = smoothstep(0.66, 0.95, n01(tFbm(c.uv, vec2(9.0), OCT(4), uSeed + 91.0)));
  col = mix(col, vec3(0.135, 0.150, 0.115), mould * 0.4);
  s.albedo = col;
  s.rough = 0.90 + weather * 0.06 - c.h.z * 0.15 + grime * 0.03 - st * 0.08;
  s.ao = 1.0 - gap * 0.5 - grime * 0.2;
  return s;
}`,
  },

  wood_ply: {
    // 1.6 m, not 2.4 m. This is the board stock crates and hoardings are cut from, and
    // a crate face is 0.6-0.8 m: at 2.4 m the veneer fbm became a 50 cm smear and the
    // fibre collapsed sub-pixel, so a stack of crates read as laminate worktop. At
    // 1.6 m (and 0.76 m once props apply their own repeat) the boards, the fibre and
    // the mill stamp all land at the size they are in life.
    worldSize: 1.6, depth: 0.005, surface: 'wood',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  // Sawn boards, not one continuous sheet: crates and hoardings are made of strips.
  Cell b = plankCell(uv, vec2(1.0, 4.0), vec2(0.004, 0.010), uSeed + 61.0);
  vec2 q = tWarp(uv, vec2(3.0, 14.0), 0.03, 3, uSeed + 3.0);
  float veneer = n01(tFbm(q, vec2(7.0, 130.0), OCT(4), uSeed + b.rnd.x * 23.0));
  float fibre = n01(tFbm(uv, vec2(16.0, 520.0), 3, uSeed + 7.0));
  // oval repair patches ("football" plugs)
  vec4 w = tWorley(uv, vec2(4.0, 3.0), 1.0, uSeed + 13.0);
  float plug = smoothstep(0.30, 0.24, w.x) * step(0.82, w.z);
  // A nail line just inside each board edge, punched below the surface.
  float dy = min(abs(b.luv.y - 0.15), abs(b.luv.y - 0.85));
  float nail = sat(1.0 - length(vec2(fract(uv.x * 9.0) - 0.5, dy * 6.0)) * 12.0);
  // Splintered arris where the board has been knocked about.
  float splint = n01(tFbm(uv, vec2(220.0, 30.0), 3, uSeed + 37.0)) * (1.0 - b.face);
  float h = 0.58 + b.face * 0.16 + veneer * 0.12 + fibre * 0.09 - plug * 0.05;
  h -= (1.0 - b.face) * 0.20 + splint * 0.05 + nail * 0.10;
  h += (b.rnd.y - 0.5) * 0.045 * b.face;
  float ding = sat(1.0 - tWorley(uv, vec2(20.0), 1.0, uSeed + 19.0).x * 7.0) * step(0.9, cellHash(uv, vec2(20.0), uSeed + 21.0));
  h -= ding * 0.16;
  return vec4(h, veneer, plug, b.face);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell b = plankCell(c.uv, vec2(1.0, 4.0), vec2(0.004, 0.010), uSeed + 61.0);
  vec3 pale = vec3(0.700, 0.560, 0.360);
  vec3 warm = vec3(0.390, 0.270, 0.150);
  vec3 col = mix(warm, pale, sat(contrastf(c.h.y, 1.9)));
  // Board-to-board colour: no two strips out of a mill come the same.
  col = shiftHSV(col, (b.rnd.x - 0.5) * 0.018, (b.rnd.y - 0.5) * 0.22, (b.rnd.z - 0.5) * 0.20);
  col = mix(col, vec3(0.395, 0.290, 0.180), c.h.z * 0.8);                 // repair plug is darker
  float glue = smoothstep(0.80, 0.96, n01(tFbm(c.uv, vec2(22.0), OCT(3), uSeed + 31.0)));
  col = mix(col, vec3(0.560, 0.520, 0.450), glue * 0.4);
  float stampM = smoothstep(0.90, 0.99, n01(tWarpedFbm(c.uv, vec2(6.0, 4.0), OCT(3), 0.15, uSeed + 71.0)));
  col = mix(col, vec3(0.170, 0.165, 0.160), stampM * 0.55);               // mill stamp ink
  // Face checking: the veneer splits along the grain as it dries. Very fine, very
  // directional, and the reason ply never reads as laminate worktop in life.
  float check = 1.0 - smoothstep(0.0, 0.030,
      abs(n01(tFbm(shearY(c.uv, 1.0), vec2(9.0, 240.0), 3, uSeed + 87.0)) - 0.5));
  check *= smoothstep(0.40, 0.85, n01(tFbm(c.uv, vec2(5.0, 3.0), OCT(3), uSeed + 89.0)));
  col = mix(col, col * 0.52, check * 0.55);
  // Nail heads on the fixing line, each with its own rust halo in the timber.
  float dy = min(abs(b.luv.y - 0.15), abs(b.luv.y - 0.85));
  float nailD = length(vec2(fract(c.uv.x * 9.0) - 0.5, dy * 6.0));
  float nail = sat(1.0 - nailD * 12.0);
  float halo = sat(1.0 - nailD * 4.5) * step(0.3, cellHash(c.uv, vec2(9.0, 8.0), uSeed + 93.0));
  col = mix(col, vec3(0.330, 0.195, 0.115), sat(halo) * 0.42);
  col = mix(col, vec3(0.225, 0.220, 0.215), nail * 0.85);
  // The gap between boards, and the laminated edge you see down it: ply is a stack
  // of plies and the end grain reads as alternating pale/dark bands, not as a slot.
  float gap = 1.0 - c.h.w;
  vec3 edgeCol = mix(vec3(0.105, 0.085, 0.065), vec3(0.470, 0.375, 0.245),
                     smoothstep(0.35, 0.65, fract(b.luv.y * 5.0 + 0.25)));
  col = mix(col, edgeCol, gap * 0.82);
  float grime = sat(c.cav * 2.2);
  col = mix(col, vec3(0.230, 0.190, 0.140), grime * 0.4);
  float dust = dustField(c.uv, c.up, 0.0, uSeed + 83.0);
  col = mix(col, vec3(0.52, 0.48, 0.42), dust * 0.2);
  s.albedo = col;
  s.metal = nail * 0.55;
  s.rough = 0.83 + gap * 0.10 - glue * 0.18 + dust * 0.06 + check * 0.08
          - nail * 0.35 + halo * 0.05;
  s.ao = 1.0 - grime * 0.2 - gap * 0.45 - check * 0.15;
  return s;
}`,
  },

  plywood_painted: {
    worldSize: 2.4, depth: 0.004, surface: 'wood',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  vec2 q = tWarp(uv, vec2(3.0, 14.0), 0.03, 3, uSeed + 3.0);
  float veneer = n01(tFbm(q, vec2(5.0, 90.0), OCT(4), uSeed));
  float fibre = n01(tFbm(uv, vec2(12.0, 420.0), 3, uSeed + 7.0));
  float scuffN = n01(tWarpedFbm(uv, vec2(26.0), OCT(4), 0.05, uSeed + 27.0));
  float scuff = smoothstep(0.60, 0.70, scuffN)
              * smoothstep(0.35, 0.80, n01(tFbm(uv, vec2(6.0), OCT(4), uSeed + 33.0)));
  float h = 0.66 + veneer * 0.12 + fibre * 0.08 - scuff * 0.04;
  float ding = sat(1.0 - tWorley(uv, vec2(18.0), 1.0, uSeed + 19.0).x * 7.0) * step(0.88, cellHash(uv, vec2(18.0), uSeed + 21.0));
  h -= ding * 0.16;
  return vec4(h, veneer, scuff, ding);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 paint = vec3(0.615, 0.230, 0.175);
  paint = shiftHSV(paint, (n01(tFbm(c.uv, vec2(2.0), 3, uSeed + 5.0)) - 0.5) * 0.015, 0.0,
                   (n01(tFbm(c.uv, vec2(4.0), OCT(4), uSeed + 9.0)) - 0.5) * 0.26);
  vec3 wood = mix(vec3(0.460, 0.335, 0.190), vec3(0.660, 0.520, 0.335), c.h.y);
  // grain telegraphs through thin paint
  paint *= 0.94 + 0.10 * c.h.y;
  float wear = sat(c.h.z * 1.4 + c.h.w * 1.2 - sat(c.cav) * 0.6);
  vec3 col = mix(paint, wood, sat(wear));
  float scr = scratches(c.uv, 0.7, uSeed + 61.0);
  col = mix(col, mix(paint * 0.8, wood, 0.5), scr * 0.45);
  float grime = sat(c.cav * 2.2);
  col = mix(col, vec3(0.190, 0.165, 0.140), grime * 0.45);
  float st = runoff(c.uv, 18.0, uSeed + 77.0);
  col = mix(col, vec3(0.26, 0.22, 0.19), st * 0.35);
  s.albedo = col;
  s.rough = mix(0.62, 0.88, sat(wear)) + scr * 0.08 + grime * 0.04 - st * 0.08;
  s.ao = 1.0 - grime * 0.2;
  return s;
}`,
  },

  /* -------------------------------------------------------------- ground */
  sand: {
    worldSize: 4.0, depth: 0.035, surface: 'sand',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  vec2 q = tWarp(uv, vec2(3.0), 0.05, 3, uSeed + 3.0);
  float ripple = 0.5 - 0.5 * cos((q.y * 26.0 + n01(tFbm(q, vec2(6.0), OCT(4), uSeed)) * 5.0) * TAU);
  ripple = pow(ripple, 1.4);
  float dune = n01(tFbm(uv, vec2(3.0), OCT(5), uSeed + 11.0));
  float grain = n01(tFbm(uv, vec2(400.0), 3, uSeed + 17.0));
  vec3 peb = pebbles(uv, vec2(45.0), 1.0, 0.16, uSeed + 23.0);
  float h = 0.42 + ripple * 0.22 + dune * 0.20 + grain * 0.07 + peb.x * 0.09;
  return vec4(h, dune, ripple, peb.y);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 dry = vec3(0.755, 0.660, 0.480);
  vec3 warm = vec3(0.640, 0.520, 0.345);
  vec3 col = mix(warm, dry, sat(c.h.y * 1.1));
  col *= 0.94 + 0.12 * n01(tFbm(c.uv, vec2(40.0), OCT(3), uSeed + 31.0));
  // mineral speckle: dark and pale grains
  float sp = tWorley(c.uv, vec2(300.0), 1.0, uSeed + 37.0).z;
  col = mix(col, col * vec3(0.55, 0.52, 0.50), smoothstep(0.86, 1.0, sp) * 0.6);
  col = mix(col, vec3(0.86, 0.82, 0.72), smoothstep(0.9, 1.0, 1.0 - sp) * 0.4);
  float damp = smoothstep(0.55, 0.95, n01(tFbm(c.uv, vec2(2.0), OCT(4), uSeed + 51.0)));
  col = mix(col, col * vec3(0.68, 0.66, 0.63), damp * 0.7);
  col = mix(col, vec3(0.30, 0.26, 0.20), sat(c.cav * 1.8) * 0.25);
  s.albedo = col;
  s.rough = 0.95 - damp * 0.22 + c.h.z * 0.03;
  s.ao = 1.0 - sat(c.cav) * 0.3;
  return s;
}`,
  },

  dirt_packed: {
    worldSize: 4.0, depth: 0.03, surface: 'dirt',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  float base = n01(tWarpedFbm(uv, vec2(4.0), OCT(5), 0.06, uSeed));
  float fine = n01(tFbm(uv, vec2(70.0), OCT(4), uSeed + 7.0));
  vec3 stones = pebbles(uv, vec2(55.0), 1.0, 0.22, uSeed + 13.0);
  float embed = smoothstep(0.55, 0.95, stones.x) * step(0.45, stones.y);
  float crack = crackField(uv, vec2(9.0), 0.035, 0.06, uSeed + 29.0);
  float rut = n01(tFbm(uv, vec2(2.0, 14.0), OCT(4), uSeed + 41.0));
  float h = 0.52 + base * 0.20 + fine * 0.09 + embed * 0.14 - crack * 0.16 + (rut - 0.5) * 0.10;
  return vec4(h, base, embed, crack);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 darkE = vec3(0.215, 0.160, 0.110);
  vec3 midE  = vec3(0.395, 0.310, 0.215);
  vec3 dust  = vec3(0.560, 0.480, 0.360);
  vec3 col = mix(darkE, midE, sat(c.h.y * 1.25));
  col = mix(col, dust, smoothstep(0.42, 0.90, c.h.y) * 0.72);
  col *= 0.90 + 0.20 * n01(tFbm(c.uv, vec2(120.0), 3, uSeed + 37.0));
  col = mix(col, vec3(0.430, 0.410, 0.380), c.h.z * 0.65);                // stone faces
  float wet = smoothstep(0.6, 0.95, n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 55.0)));
  col = mix(col, col * vec3(0.60, 0.58, 0.56), wet * 0.75);
  col = mix(col, vec3(0.105, 0.080, 0.055), sat(c.cav * 2.2) * 0.5);
  float dry = dustField(c.uv, 0.0, 1.0 - sat(c.cav), uSeed + 71.0);
  col = mix(col, vec3(0.520, 0.455, 0.350), dry * 0.28);
  float org = smoothstep(0.78, 0.97, n01(tFbm(c.uv, vec2(22.0), OCT(4), uSeed + 83.0)));
  col = mix(col, vec3(0.170, 0.155, 0.090), org * 0.45);
  s.albedo = col;
  s.rough = 0.94 - wet * 0.28 + dry * 0.04;
  s.ao = 1.0 - sat(c.cav) * 0.4 - sat(c.h.w) * 0.2;
  return s;
}`,
  },

  gravel: {
    worldSize: 2.0, depth: 0.045, surface: 'dirt',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  vec3 big = pebbles(uv, vec2(26.0), 1.0, 0.30, uSeed);
  vec3 mid = pebbles(uv, vec2(48.0), 1.0, 0.24, uSeed + 11.0);
  vec3 sml = pebbles(uv, vec2(95.0), 1.0, 0.18, uSeed + 23.0);
  float fines = n01(tFbm(uv, vec2(160.0), OCT(4), uSeed + 31.0));
  float h = 0.20;
  h = max(h, big.x * 0.78 + 0.08);
  h = max(h, mid.x * 0.62 + 0.06);
  h = max(h, sml.x * 0.46 + 0.04);
  h += fines * 0.07;
  float id = big.x > mid.x ? big.y : mid.y;
  id = (max(big.x, mid.x) > sml.x) ? id : sml.y;
  return vec4(h, id, big.x, mid.x);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  float id = c.h.y;
  // a believable stone assortment: grey granite, buff limestone, dark basalt, rust flint
  vec3 g1 = vec3(0.430, 0.425, 0.410);
  vec3 g2 = vec3(0.560, 0.510, 0.420);
  vec3 g3 = vec3(0.185, 0.180, 0.180);
  vec3 g4 = vec3(0.390, 0.270, 0.190);
  vec3 stone = mix(g1, g2, smoothstep(0.20, 0.55, id));
  stone = mix(stone, g3, smoothstep(0.62, 0.80, id));
  stone = mix(stone, g4, smoothstep(0.85, 1.0, id));
  stone *= 0.85 + 0.30 * n01(tFbm(c.uv, vec2(220.0), 3, uSeed + 41.0));
  float dust = sat(1.0 - c.h.x * 1.5) ;
  vec3 col = mix(stone, vec3(0.360, 0.320, 0.255), sat(dust * 0.9 + sat(c.cav) * 0.5) * 0.75);
  col = mix(col, vec3(0.100, 0.090, 0.075), sat(c.cav * 2.0) * 0.45);
  float wet = smoothstep(0.62, 0.95, n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 61.0)));
  col = mix(col, col * vec3(0.62, 0.61, 0.60), wet * 0.7);
  s.albedo = col;
  s.rough = 0.88 - wet * 0.32 + dust * 0.08;
  s.ao = 1.0 - sat(c.cav) * 0.5;
  return s;
}`,
  },

  rubble: {
    worldSize: 3.0, depth: 0.09, surface: 'concrete',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  vec2 q = tWarp(uv, vec2(5.0), 0.03, 3, uSeed + 3.0);
  vec4 a = tWorleyAng(q, vec2(11.0), 0.95, uSeed);
  vec4 b = tWorleyAng(q * 1.0, vec2(23.0), 0.95, uSeed + 17.0);
  float chunkA = sat(1.0 - a.x * 2.0);
  float chunkB = sat(1.0 - b.x * 2.4);
  float grit = n01(tFbm(uv, vec2(120.0), OCT(4), uSeed + 29.0));
  float h = 0.18 + max(chunkA * 0.66, chunkB * 0.44) + grit * 0.10;
  float dustFill = n01(tFbm(uv, vec2(9.0), OCT(4), uSeed + 37.0));
  h += dustFill * 0.06;
  float which = chunkA * 0.66 > chunkB * 0.44 ? a.z : b.z;
  return vec4(h, which, chunkA, chunkB);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  float id = c.h.y;
  vec3 conc = vec3(0.520, 0.510, 0.490);
  vec3 brick = vec3(0.415, 0.185, 0.130);
  vec3 dark = vec3(0.215, 0.210, 0.205);
  vec3 plaster = vec3(0.660, 0.640, 0.600);
  vec3 col = mix(conc, brick, smoothstep(0.55, 0.72, id));
  col = mix(col, dark, smoothstep(0.80, 0.92, id));
  col = mix(col, plaster, smoothstep(0.10, 0.0, id));
  col *= 0.85 + 0.30 * n01(tFbm(c.uv, vec2(160.0), 3, uSeed + 47.0));
  // everything is coated in pale concrete dust, heavier low down
  float dust = sat((1.0 - c.h.x) * 1.2 + c.cav * 0.8);
  col = mix(col, vec3(0.585, 0.565, 0.520), sat(dust) * 0.62);
  col = mix(col, vec3(0.105, 0.100, 0.092), sat(c.cav * 2.0) * 0.5);
  float burn = smoothstep(0.72, 0.96, n01(tFbm(c.uv, vec2(4.0), OCT(4), uSeed + 63.0)));
  col = mix(col, vec3(0.115, 0.105, 0.100), burn * 0.45);
  // rebar fragments
  float bar = smoothstep(0.015, 0.0, abs(n01(tFbm(shearX(c.uv, 2.0), vec2(3.0, 40.0), 3, uSeed + 71.0)) - 0.5) - 0.006);
  bar *= step(0.75, cellHash(c.uv, vec2(6.0), uSeed + 73.0));
  col = mix(col, vec3(0.320, 0.165, 0.085), bar * 0.8);
  s.albedo = col;
  s.metal = bar * 0.25;
  s.rough = 0.95 - bar * 0.15;
  s.ao = 1.0 - sat(c.cav) * 0.55;
  return s;
}`,
  },

  dry_grass_ground: {
    worldSize: 3.0, depth: 0.04, surface: 'grass',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  float soil = n01(tWarpedFbm(uv, vec2(5.0), OCT(4), 0.06, uSeed));
  // blades: very anisotropic noise at several shear angles
  float b1 = n01(tFbm(shearX(uv, 1.0), vec2(16.0, 240.0), 3, uSeed + 7.0));
  float b2 = n01(tFbm(shearX(uv, -2.0), vec2(22.0, 300.0), 3, uSeed + 13.0));
  float b3 = n01(tFbm(uv, vec2(9.0, 190.0), 3, uSeed + 19.0));
  float blades = max(max(b1, b2), b3);
  float clump = n01(tFbm(uv, vec2(13.0), OCT(4), uSeed + 23.0));
  float cover = sat(0.52 + (clump - 0.5) * 0.95 + (blades - 0.5) * 0.5);
  float h = 0.30 + soil * 0.14 + blades * (0.45 + 0.55 * cover) * 0.46 + clump * 0.06;
  return vec4(h, cover, blades, soil);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 soilC = mix(vec3(0.180, 0.135, 0.090), vec3(0.365, 0.290, 0.200), c.h.w);
  vec3 strawA = vec3(0.560, 0.470, 0.240);
  vec3 strawB = vec3(0.400, 0.330, 0.150);
  vec3 green  = vec3(0.230, 0.290, 0.115);
  // per-blade colour, not per-blob: the fine anisotropic field drives the hue
  float blade = sat(c.h.z);
  vec3 grass = mix(strawB, strawA, blade);
  float alive = sat(n01(tFbm(shearX(c.uv, -1.0), vec2(26.0, 260.0), 3, uSeed + 41.0)) * 1.3 - 0.25);
  grass = mix(grass, green, alive * 0.45);
  grass *= 0.90 + 0.20 * n01(tFbm(c.uv, vec2(90.0), 3, uSeed + 47.0));
  vec3 col = mix(soilC, grass, sat(c.h.y * 0.9 + blade * 0.35));
  col = mix(col, vec3(0.115, 0.090, 0.062), sat(c.cav * 1.8) * 0.4);
  float dead = sat(n01(tFbm(shearX(c.uv, 2.0), vec2(18.0, 200.0), 3, uSeed + 59.0)) * 1.2 - 0.35);
  col = mix(col, vec3(0.330, 0.270, 0.165), dead * 0.4);
  s.albedo = col;
  s.rough = 0.90 - alive * 0.10 + sat(c.h.y) * 0.04;
  s.ao = 1.0 - sat(c.cav) * 0.45;
  return s;
}`,
  },

  /* ------------------------------------------------------------- fabrics */
  fabric_canvas: {
    worldSize: 1.0, depth: 0.0035, surface: 'fabric',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  vec3 w = weave(uv, vec2(120.0), uSeed);
  float slack = n01(tFbm(uv, vec2(4.0), OCT(4), uSeed + 7.0));
  float fuzz = n01(tFbm(uv, vec2(500.0), 3, uSeed + 11.0));
  float seamY = smoothstep(0.012, 0.0, abs(fract(uv.y * 2.0) - 0.5) * 2.0 - 0.006);
  float h = 0.42 + w.x * 0.34 + slack * 0.14 + fuzz * 0.05 + seamY * 0.12;
  return vec4(h, w.x, w.y, seamY);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 warpC = vec3(0.470, 0.430, 0.330);
  vec3 weftC = vec3(0.420, 0.385, 0.290);
  vec3 col = mix(warpC, weftC, c.h.z);
  col *= 0.82 + 0.34 * c.h.y;
  float fade = n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 31.0));
  col = mix(col, col * 1.20 + 0.03, fade * 0.5);
  float grime = sat(c.cav * 2.4);
  col = mix(col, vec3(0.180, 0.165, 0.140), grime * 0.5);
  float stain = smoothstep(0.62, 0.92, n01(tWarpedFbm(c.uv, vec2(6.0), OCT(4), 0.1, uSeed + 43.0)));
  col = mix(col, vec3(0.245, 0.205, 0.155), stain * 0.55);
  float st = runoff(c.uv, 14.0, uSeed + 51.0);
  col = mix(col, vec3(0.265, 0.235, 0.190), st * 0.35);
  col = mix(col, vec3(0.520, 0.485, 0.410), c.h.w * 0.25);
  s.albedo = col;
  s.rough = 0.94 - fade * 0.03 + grime * 0.03;
  s.ao = 1.0 - sat(c.cav) * 0.35;
  return s;
}`,
  },

  tarp: {
    // 0.9 m, not 2.0 m. On a ~4 m canopy the old tile put the ripstop grid at 4 cm and
    // the hue noise at 60-100 cm, which is why an awning read as a khaki plane with
    // green marker squiggles on it. At 0.9 m the ripstop lands at ~1.6 cm, the weave is
    // sub-centimetre, and the colour variation is fabric mottling rather than blotches.
    worldSize: 0.9, depth: 0.011, surface: 'fabric',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  // ripstop grid + wrinkles + a stitched panel seam
  vec2 g = abs(fract(uv * 56.0) - 0.5) * 2.0;
  float grid = max(smoothstep(0.86, 1.0, g.x), smoothstep(0.86, 1.0, g.y));
  vec3 w = weave(uv, vec2(200.0), uSeed + 3.0);
  vec2 q = tWarp(uv, vec2(3.0), 0.07, 3, uSeed + 5.0);
  float wrinkle = n01(tFbm(q, vec2(4.0, 2.0), OCT(5), uSeed + 11.0));
  float crease = 1.0 - smoothstep(0.0, 0.09, abs(n01(tFbm(q, vec2(3.5, 2.0), OCT(4), uSeed + 17.0)) - 0.5));
  // Panel seam: canvas comes in widths, so a canopy is stitched out of strips. One
  // felled seam per tile, with the needle holes actually modelled.
  float sd = abs(fract(uv.y + 0.5) - 0.5) * 2.0;
  float seam = smoothstep(0.055, 0.012, sd);
  float stitch = smoothstep(0.030, 0.016, sd) * step(0.45, fract(uv.x * 90.0));
  // Frayed selvedge along the same line where the coating has worn through.
  float fray = n01(tFbm(uv, vec2(160.0, 20.0), 3, uSeed + 43.0)) * smoothstep(0.10, 0.045, sd);
  float h = 0.44 + wrinkle * 0.28 + w.x * 0.11 + grid * 0.07 - crease * 0.17;
  h += seam * 0.09 + stitch * 0.06 - fray * 0.05;
  return vec4(h, wrinkle, crease, seam + grid * 0.25);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 base = vec3(0.130, 0.235, 0.185);
  // Weave-scale hue/value drift, not 60 cm blotches: the frequencies here are the whole
  // difference between "fabric" and "someone drew on it".
  base = shiftHSV(base, (n01(tFbm(c.uv, vec2(11.0), 3, uSeed + 2.0)) - 0.5) * 0.022, 0.0,
                  (n01(tFbm(c.uv, vec2(17.0), OCT(4), uSeed + 7.0)) - 0.5) * 0.20);
  vec3 col = base * (0.96 + 0.07 * c.h.y);
  // Per-thread value variation — a woven surface is never one value.
  vec3 wv = weave(c.uv, vec2(200.0), uSeed + 3.0);
  col *= 0.86 + 0.26 * wv.x;
  col = mix(col, col * 1.16 + 0.012, smoothstep(0.72, 1.0, c.h.y) * 0.5);    // sun-faded crests
  col = mix(col, vec3(0.170, 0.160, 0.140), sat(c.h.z * 1.1) * 0.45);        // dirt in creases
  col *= 0.94 + 0.11 * n01(tFbm(c.uv, vec2(240.0), 3, uSeed + 91.0));        // coating speckle
  float grime = sat(c.cav * 2.2);
  col = mix(col, vec3(0.145, 0.140, 0.125), grime * 0.5);
  float dust = dustField(c.uv, c.up, 0.0, uSeed + 61.0);
  col = mix(col, vec3(0.430, 0.410, 0.360), dust * 0.30);
  col += c.h.w * 0.02;
  s.albedo = col;
  // coated fabric: plasticky sheen on the taut areas, dull where dirty
  s.rough = 0.52 + c.h.z * 0.22 + grime * 0.18 + dust * 0.16 - smoothstep(0.6, 1.0, c.h.y) * 0.12;
  s.rough += (1.0 - wv.x) * 0.10;
  s.ao = 1.0 - sat(c.cav) * 0.35;
  return s;
}`,
  },

  sandbag: {
    worldSize: 1.0, depth: 0.022, surface: 'fabric',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  vec3 w = weave(uv, vec2(64.0), uSeed);
  // lumpy fill pressing through the hessian
  float lump = n01(tWarpedFbm(uv, vec2(7.0), OCT(4), 0.05, uSeed + 11.0));
  float fray = n01(tFbm(uv, vec2(300.0), 3, uSeed + 17.0));
  float stitch = smoothstep(0.010, 0.0, abs(fract(uv.y * 4.0) - 0.5) * 2.0 - 0.004);
  float thread = stitch * (0.5 + 0.5 * step(0.5, fract(uv.x * 40.0)));
  float h = 0.34 + lump * 0.36 + w.x * 0.22 + fray * 0.05 + thread * 0.10;
  return vec4(h, w.x, lump, w.y);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 hessA = vec3(0.480, 0.395, 0.250);
  vec3 hessB = vec3(0.375, 0.300, 0.185);
  vec3 col = mix(hessB, hessA, c.h.w);
  col *= 0.80 + 0.38 * c.h.y;
  float bleach = smoothstep(0.35, 0.9, c.h.z) * sat(c.up * 1.6 + 0.25);
  col = mix(col, vec3(0.610, 0.545, 0.410), bleach * 0.45);                  // sun-bleached tops
  float grime = sat(c.cav * 2.4);
  col = mix(col, vec3(0.155, 0.130, 0.100), grime * 0.55);
  float dirt = dustField(c.uv, 0.0, 1.0, uSeed + 41.0);
  col = mix(col, vec3(0.330, 0.280, 0.205), dirt * 0.40);
  float damp = smoothstep(0.5, 0.95, n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 55.0)))
             * smoothstep(0.35, 0.80, n01(tFbm(c.uv, vec2(2.0), 3, uSeed + 57.0)));
  col = mix(col, col * vec3(0.62, 0.60, 0.58), damp * 0.7);
  s.albedo = col;
  s.rough = 0.95 - damp * 0.20 + grime * 0.02;
  s.ao = 1.0 - sat(c.cav) * 0.45;
  return s;
}`,
  },

  carpet_worn: {
    worldSize: 2.0, depth: 0.007, surface: 'fabric',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  float pile = n01(tFbm(uv, vec2(420.0), 3, uSeed));
  float loops = 0.5 - 0.5 * cos(fract(uv.x * 170.0) * TAU);
  loops *= 0.5 - 0.5 * cos(fract(uv.y * 150.0) * TAU);
  float traffic = smoothstep(0.30, 0.80, n01(tFbm(uv, vec2(2.0, 4.0), OCT(4), uSeed + 11.0)));
  float wave = n01(tFbm(uv, vec2(9.0), OCT(4), uSeed + 17.0));
  float h = 0.42 + pile * 0.22 + loops * 0.22 + wave * 0.12;
  h -= traffic * 0.20;
  return vec4(h, pile, traffic, wave);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  // heather yarn: three fibre colours speckled together
  float f = tWorley(c.uv, vec2(260.0), 1.0, uSeed + 23.0).z;
  vec3 y1 = vec3(0.275, 0.245, 0.205);
  vec3 y2 = vec3(0.400, 0.360, 0.300);
  vec3 y3 = vec3(0.145, 0.150, 0.165);
  vec3 col = mix(y1, y2, smoothstep(0.25, 0.7, f));
  col = mix(col, y3, smoothstep(0.80, 1.0, f));
  col *= 0.78 + 0.42 * c.h.y;
  col *= 0.90 + 0.22 * n01(tFbm(c.uv, vec2(7.0), OCT(4), uSeed + 71.0));     // dye lot drift
  col = mix(col, col * vec3(0.66, 0.66, 0.67), c.h.z * 0.85);                // crushed traffic lane
  float stain = smoothstep(0.72, 0.95, n01(tWarpedFbm(c.uv, vec2(5.0), OCT(4), 0.09, uSeed + 37.0)));
  col = mix(col, vec3(0.135, 0.115, 0.095), stain * 0.6);
  col = mix(col, vec3(0.085, 0.080, 0.075), sat(c.cav * 2.2) * 0.45);
  s.albedo = col;
  s.rough = 0.97 - c.h.z * 0.10;
  s.ao = 1.0 - sat(c.cav) * 0.45 - c.h.z * 0.12;
  return s;
}`,
  },

  /* ------------------------------------------------------- hard surfaces */
  glass_dirty: {
    worldSize: 2.0, depth: 0.0012, surface: 'glass',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  float dirt = n01(tWarpedFbm(uv, vec2(6.0), OCT(4), 0.08, uSeed));
  float spots = sat(1.0 - tWorley(uv, vec2(40.0), 1.0, uSeed + 11.0).x * 5.0);
  float smear = n01(tFbm(shearX(uv, 1.0), vec2(6.0, 40.0), OCT(4), uSeed + 17.0));
  float crack = crackField(uv, vec2(5.0), 0.020, 0.03, uSeed + 29.0) * step(0.6, cellHash(uv, vec2(2.0), uSeed + 31.0));
  float edge = 1.0 - smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  float h = 0.80 + dirt * 0.05 + spots * 0.04 + smear * 0.03 + edge * 0.05 - crack * 0.35;
  return vec4(h, dirt, spots, crack);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  float edge = 1.0 - smoothstep(0.0, 0.08, min(min(c.uv.x, 1.0 - c.uv.x), min(c.uv.y, 1.0 - c.uv.y)));
  float dirt = sat(c.h.y * 1.1 - 0.15 + edge * 0.45);
  float st = runoff(c.uv, 30.0, uSeed + 41.0);
  float smear = n01(tFbm(shearX(c.uv, 1.0), vec2(6.0, 40.0), OCT(4), uSeed + 17.0));
  vec3 grimeC = vec3(0.330, 0.310, 0.275);
  // glass itself is near black in albedo; only the muck has colour
  vec3 col = mix(vec3(0.030, 0.033, 0.035), grimeC, sat(dirt * 0.8 + st * 0.5 + c.h.z * 0.5));
  col = mix(col, vec3(0.560, 0.545, 0.510), c.h.w * 0.8);                   // crushed white crack lines
  s.albedo = col;
  s.metal = 0.0;
  s.rough = sat(0.05 + dirt * 0.42 + st * 0.30 + c.h.z * 0.25 + smear * 0.12 + c.h.w * 0.4);
  s.ao = 1.0 - edge * 0.25 - c.h.w * 0.2;
  return s;
}`,
  },

  ceramic_tile: {
    worldSize: 1.6, depth: 0.005, surface: 'ceramic',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  Cell t = brickCell(uv, vec2(8.0, 8.0), 0.0, vec2(0.022, 0.022), uSeed);
  float dish = 1.0 - pow(length((t.luv - 0.5) * 2.0), 3.0) * 0.12;          // slight kiln dish
  float grout = n01(tFbm(uv, vec2(200.0), 3, uSeed + 7.0));
  float chip = sat(1.0 - tWorley(uv, vec2(16.0), 1.0, uSeed + 13.0).x * 6.0) * (1.0 - t.edge);
  chip *= step(0.82, t.rnd.y);
  float h = 0.30 + t.face * 0.50 * dish + (1.0 - t.face) * grout * 0.06;
  h -= chip * 0.35;
  return vec4(h, t.rnd.x, t.face, chip);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell t = brickCell(c.uv, vec2(8.0, 8.0), 0.0, vec2(0.022, 0.022), uSeed);
  vec3 glaze = vec3(0.720, 0.700, 0.655);
  glaze = shiftHSV(glaze, (t.rnd.x - 0.5) * 0.01, (t.rnd.y - 0.5) * 0.3, (t.rnd.z - 0.5) * 0.10);
  glaze *= 0.95 + 0.08 * n01(tFbm(c.uv, vec2(24.0), OCT(3), uSeed + 21.0));
  vec3 grout = vec3(0.430, 0.415, 0.385) * (0.85 + 0.3 * n01(tFbm(c.uv, vec2(200.0), 3, uSeed + 7.0)));
  float joint = 1.0 - c.h.z;
  vec3 col = mix(glaze, grout, joint);
  // Crazing: the glaze cracks in a fine web long before the tile does, and it is the
  // 2-5 mm band a ceramic floor is missing when it reads as vinyl. Per-tile seed so
  // the web does not run across the joint.
  float craze = 1.0 - smoothstep(0.0, 0.035,
      abs(n01(tFbm(c.uv, vec2(150.0), 3, uSeed + t.rnd.x * 37.0)) - 0.5));
  craze *= smoothstep(0.40, 0.85, t.rnd.z) * c.h.z;
  col = mix(col, col * 0.80, craze * 0.5);
  // Grime creeps out of the grout onto the first few millimetres of the tile. Squared
  // and at half strength: at 0.45 over the full edge feather it took the tile edge
  // DARKER than the grout, which turned a crisp 1 px joint into a soft dark band and
  // measurably cost the floor its near-field micro detail.
  float creep = (1.0 - t.edge) * (1.0 - t.edge) * c.h.z;
  col = mix(col, vec3(0.290, 0.275, 0.248), creep * 0.24);
  float grime = sat(c.cav * 2.4);
  col = mix(col, vec3(0.180, 0.170, 0.150), grime * 0.6);
  float scuff = scratches(c.uv, 0.5, uSeed + 33.0);
  col = mix(col, col * 0.92 + 0.02, scuff * 0.5);
  col = mix(col, vec3(0.585, 0.560, 0.520), c.h.w * 0.7);                    // exposed biscuit
  float haze = smoothstep(0.55, 0.95, n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 45.0)));
  s.albedo = col;
  s.rough = mix(0.10, 0.88, joint) + scuff * 0.22 + grime * 0.15 + haze * 0.08 + c.h.w * 0.5
          + craze * 0.18 + creep * 0.16;
  s.ao = 1.0 - joint * 0.45 - grime * 0.2 - craze * 0.1;
  return s;
}`,
  },

  marble_lobby: {
    worldSize: 3.0, depth: 0.003, surface: 'ceramic',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  Cell t = brickCell(uv, vec2(2.0, 2.0), 0.0, vec2(0.0025, 0.0025), uSeed);
  vec2 q = tWarp(shearX(uv, 1.0), vec2(6.0), 0.055, 4, uSeed + 3.0);
  float vein = tRidge(q, vec2(9.0, 16.0), OCT(5), uSeed + 7.0);
  float vein2 = tRidge(tWarp(shearX(uv, 1.0), vec2(14.0), 0.022, 3, uSeed + 11.0), vec2(26.0, 44.0), OCT(4), uSeed + 13.0);
  float scuff = n01(tFbm(uv, vec2(80.0), 3, uSeed + 17.0));
  float h = 0.62 + t.face * 0.30 + vein * 0.03 + scuff * 0.02;
  return vec4(h, vein, vein2, t.rnd.x);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell t = brickCell(c.uv, vec2(2.0, 2.0), 0.0, vec2(0.0025, 0.0025), uSeed);
  vec3 body = vec3(0.760, 0.750, 0.735);
  body = shiftHSV(body, 0.0, 0.0, (t.rnd.x - 0.5) * 0.06);
  vec3 veinC = vec3(0.320, 0.305, 0.300);
  vec3 veinWarm = vec3(0.470, 0.400, 0.320);
  float v = sat(smoothstep(0.52, 0.93, c.h.y));
  float v2 = sat(smoothstep(0.62, 0.97, c.h.z));
  vec3 col = mix(body, veinC, v * 0.62);
  col = mix(col, veinWarm, v2 * 0.30);
  col *= 0.96 + 0.07 * n01(tFbm(c.uv, vec2(14.0), OCT(4), uSeed + 23.0));
  float joint = 1.0 - t.face;
  col = mix(col, vec3(0.250, 0.245, 0.240), joint * 0.85);
  float traffic = smoothstep(0.35, 0.85, n01(tFbm(c.uv, vec2(2.0, 3.0), OCT(4), uSeed + 41.0)));
  float scuff = scratches(c.uv, 0.55, uSeed + 47.0);
  col = mix(col, col * 0.96, traffic * 0.5);
  col = mix(col, vec3(0.140, 0.135, 0.130), sat(c.cav * 2.0) * 0.4);
  s.albedo = col;
  // polished, but the walking line is dulled and the joints are matte
  s.rough = sat(0.075 + traffic * 0.22 + scuff * 0.28 + joint * 0.65 + v * 0.04);
  s.ao = 1.0 - joint * 0.4;
  return s;
}`,
  },

  roof_shingle: {
    worldSize: 2.0, depth: 0.014, surface: 'concrete',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  Cell sh = brickCell(uv, vec2(6.0, 14.0), 0.5, vec2(0.014, 0.022), uSeed);
  // each course overlaps the one below: height ramps up towards the butt edge
  float ramp = smoothstep(0.0, 0.75, sh.luv.y);
  float tab = smoothstep(0.0, 0.05, sh.luv.x) * smoothstep(1.0, 0.95, sh.luv.x);
  vec3 gran = pebbles(uv, vec2(300.0), 1.0, 0.5, uSeed + 11.0);
  float lift = (sh.rnd.z - 0.5) * 0.08 * smoothstep(0.6, 1.0, sh.luv.y);
  float h = 0.30 + ramp * 0.40 * tab + gran.x * 0.12 + lift;
  h -= (1.0 - tab) * 0.18;
  return vec4(h, sh.rnd.x, gran.y, tab * ramp);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  Cell sh = brickCell(c.uv, vec2(6.0, 14.0), 0.5, vec2(0.014, 0.022), uSeed);
  vec3 dark = vec3(0.115, 0.110, 0.108);
  vec3 mid  = vec3(0.215, 0.205, 0.195);
  vec3 col = mix(dark, mid, sat(c.h.z));
  col *= 0.80 + 0.42 * sh.rnd.y;                                          // shingle-to-shingle
  // mineral granules of several colours
  float g = tWorley(c.uv, vec2(300.0), 1.0, uSeed + 11.0).z;
  col = mix(col, vec3(0.330, 0.290, 0.230), smoothstep(0.85, 1.0, g) * 0.55);
  col = mix(col, vec3(0.075, 0.075, 0.080), smoothstep(0.15, 0.0, g) * 0.5);
  float algae = smoothstep(0.55, 0.92, runoff(c.uv, 14.0, uSeed + 31.0) + n01(tFbm(c.uv, vec2(3.0), OCT(4), uSeed + 37.0)) * 0.4);
  col = mix(col, vec3(0.115, 0.140, 0.110), algae * 0.55);
  float bald = smoothstep(0.7, 0.95, n01(tFbm(c.uv, vec2(9.0), OCT(4), uSeed + 43.0)));
  col = mix(col, vec3(0.155, 0.120, 0.095), bald * 0.5);                  // granule loss -> bitumen
  col = mix(col, vec3(0.070, 0.065, 0.060), sat(c.cav * 2.0) * 0.5);
  s.albedo = col;
  s.rough = 0.94 - bald * 0.22 + algae * 0.03;
  s.ao = 1.0 - sat(c.cav) * 0.45;
  return s;
}`,
  },

  rubber_tyre: {
    worldSize: 1.0, depth: 0.014, surface: 'rubber',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  // tread blocks in two staggered ribs plus sipes
  Cell b = brickCell(uv, vec2(6.0, 10.0), 0.5, vec2(0.075, 0.055), uSeed);
  float groove = smoothstep(0.03, 0.06, abs(fract(uv.x * 3.0) - 0.5) * 2.0 - 0.10);
  float sipe = smoothstep(0.02, 0.0, abs(fract(uv.y * 40.0) - 0.5) * 2.0 - 0.01) * b.face;
  float rub = n01(tFbm(uv, vec2(150.0), 3, uSeed + 7.0));
  float mould = n01(tFbm(uv, vec2(40.0), OCT(3), uSeed + 11.0));
  float h = 0.24 + b.face * groove * 0.54 + rub * 0.06 + mould * 0.04 - sipe * 0.22;
  return vec4(h, b.face * groove, rub, sipe);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 rubber = vec3(0.050, 0.049, 0.050);
  vec3 col = rubber * (0.85 + 0.45 * c.h.z);
  float bloom = smoothstep(0.55, 0.95, n01(tFbm(c.uv, vec2(5.0), OCT(4), uSeed + 23.0)));
  col = mix(col, vec3(0.135, 0.130, 0.125), bloom * 0.55);                // antiozonant bloom
  float dust = dustField(c.uv, 0.0, c.cav, uSeed + 31.0);
  col = mix(col, vec3(0.235, 0.215, 0.185), dust * 0.45);
  float polish = smoothstep(0.55, 1.0, c.h.x) * (1.0 - bloom);
  col = mix(col, col * 1.35 + 0.006, polish * 0.5);
  s.albedo = col;
  s.rough = 0.88 - polish * 0.34 + bloom * 0.08 + dust * 0.06;
  s.ao = 1.0 - sat(c.cav) * 0.5 - c.h.w * 0.2;
  return s;
}`,
  },

  snow_packed: {
    worldSize: 3.0, depth: 0.03, surface: 'snow',
    glsl: /* glsl */ `
vec4 mHeight(vec2 uv){
  float drift = n01(tWarpedFbm(uv, vec2(3.0), OCT(5), 0.07, uSeed));
  float crust = n01(tFbm(uv, vec2(28.0), OCT(4), uSeed + 7.0));
  float sparkle = n01(tFbm(uv, vec2(420.0), 3, uSeed + 11.0));
  // boot prints
  vec4 fw = tWorley(uv, vec2(7.0), 1.0, uSeed + 17.0);
  float print = smoothstep(0.30, 0.10, fw.x) * step(0.55, fw.z);
  float h = 0.56 + drift * 0.22 + crust * 0.10 + sparkle * 0.05 - print * 0.30;
  return vec4(h, drift, print, sparkle);
}
Surf mSurface(SurfIn c){
  Surf s = defaultSurf(c);
  vec3 snow = vec3(0.900, 0.915, 0.940);
  vec3 shade = vec3(0.640, 0.700, 0.790);                                  // cavities go blue
  vec3 col = mix(snow, shade, sat(c.cav * 2.0) * 0.65);
  col = mix(col, snow * 1.02, smoothstep(0.6, 1.0, c.h.y) * 0.4);
  float dirt = smoothstep(0.62, 0.95, n01(tFbm(c.uv, vec2(6.0), OCT(4), uSeed + 41.0)));
  col = mix(col, vec3(0.470, 0.455, 0.430), dirt * 0.45 * (0.4 + 0.6 * c.h.z));
  float ice = smoothstep(0.55, 0.85, c.h.w) * smoothstep(0.4, 0.9, n01(tFbm(c.uv, vec2(9.0), OCT(4), uSeed + 53.0)));
  col = mix(col, vec3(0.780, 0.820, 0.865), ice * 0.5);
  s.albedo = col;
  s.rough = sat(0.82 - ice * 0.50 - c.h.z * 0.12 + dirt * 0.06);
  s.ao = 1.0 - sat(c.cav) * 0.35;
  return s;
}`,
  },
};

/* ------------------------------------------------------------- utilities */

/** Ordered list of the shipped material names. */
export const MATERIAL_NAMES = Object.keys(MATERIALS);

/** Concatenate a full height-pass fragment shader for `name`. */
export function buildHeightFrag(name) {
  const m = MATERIALS[name];
  if (!m) return null;
  return PRECISION + UNIFORMS + HEIGHT_IO + NOISE_CORE + COMMON + m.glsl + HEIGHT_MAIN;
}

/** Concatenate a full surface-pass fragment shader for `name`. */
export function buildSurfaceFrag(name) {
  const m = MATERIALS[name];
  if (!m) return null;
  return PRECISION + UNIFORMS + SURFACE_IO + NOISE_CORE + COMMON + m.glsl + SURFACE_MAIN;
}

/* ------------------------------------------------ standalone helper passes */

/** Height render target -> greyscale displacement (rgb = height). */
// language=GLSL
export const DISPLACE_FRAG =
  PRECISION +
  /* glsl */ `
in vec2 vUv;
uniform sampler2D uHeight;
layout(location = 0) out vec4 outColor;
void main(){
  float h = texture(uHeight, vUv).x;
  outColor = vec4(h, h, h, 1.0);
}
`;

/**
 * Shared fine micro-detail normal map, meant to be tiled ~20x on top of any material.
 * Height is evaluated analytically at four taps so this needs only one pass.
 */
// language=GLSL
export const DETAIL_NORMAL_FRAG =
  PRECISION +
  UNIFORMS +
  /* glsl */ `
layout(location = 0) out vec4 outColor;
` +
  NOISE_CORE +
  COMMON +
  /* glsl */ `
float dHeight(vec2 uv){
  float a = n01(tFbm(uv, vec2(40.0), 5, uSeed));
  float b = n01(tFbm(uv, vec2(150.0), 4, uSeed + 7.0));
  float c = sat(1.0 - tWorley(uv, vec2(90.0), 1.0, uSeed + 13.0).x * 3.2);
  float d = sat(1.0 - tWorley(uv, vec2(210.0), 1.0, uSeed + 19.0).x * 5.0);
  float scr = scratches(uv, 0.6, uSeed + 23.0);
  return a * 0.34 + b * 0.24 + c * 0.20 + d * 0.14 - scr * 0.10;
}
void main(){
  vec2 e = uTexel;
  float hL = dHeight(vUv - vec2(e.x, 0.0));
  float hR = dHeight(vUv + vec2(e.x, 0.0));
  float hD = dHeight(vUv - vec2(0.0, e.y));
  float hU = dHeight(vUv + vec2(0.0, e.y));
  float k = uNormalScale * uRes.x * 0.5;
  vec3 n = normalize(vec3(-(hR - hL) * k, -(hU - hD) * k, 1.0));
  outColor = vec4(n * 0.5 + 0.5, dHeight(vUv));
}
`;

/**
 * Shared grunge atlas used by decals, props and the weapon shaders.
 *   r = fine dirt   g = large blotches   b = crack/cell network   a = downward streaks
 */
// language=GLSL
export const GRUNGE_FRAG =
  PRECISION +
  UNIFORMS +
  /* glsl */ `
layout(location = 0) out vec4 outColor;
` +
  NOISE_CORE +
  COMMON +
  /* glsl */ `
void main(){
  float fine = sat(n01(tFbm(vUv, vec2(48.0), 5, uSeed)) * 1.1 - 0.05);
  float blotch = sat(n01(tWarpedFbm(vUv, vec2(4.0), 5, 0.10, uSeed + 17.0)) * 1.2 - 0.1);
  float net = crackField(vUv, vec2(14.0), 0.06, 0.05, uSeed + 31.0);
  float streak = runoff(vUv, 22.0, uSeed + 47.0);
  outColor = vec4(fine, blotch, net, streak);
}
`;

/**
 * Generic noise texture generator. `uKind` selects the field; rgba carry four
 * decorrelated seeds of the same field so one fetch gives four masks.
 */
// language=GLSL
export const NOISE_FRAG =
  PRECISION +
  UNIFORMS +
  /* glsl */ `
layout(location = 0) out vec4 outColor;
uniform int uKind;
uniform vec2 uScale;
uniform int uOct;
uniform float uLac;
uniform float uGain;
uniform float uAmt;
` +
  NOISE_FULL +
  COMMON +
  /* glsl */ `
float field(vec2 uv, float seed){
  vec2 S = tScale(uScale);
  if (uKind == 0) return tValue(uv, S, seed);
  if (uKind == 1) return n01(tGrad(uv, S, seed));
  if (uKind == 2) return n01(snoise2(uv * S));
  if (uKind == 3) return n01(snoise3(vec3(uv * S, seed * 0.13)));
  if (uKind == 4) return n01(simplexTiled(uv, S, seed));
  if (uKind == 5) return sat(tWorley(uv, S, 1.0, seed).x);
  if (uKind == 6) return sat(tWorley(uv, S, 1.0, seed).y);
  if (uKind == 7) { vec4 w = tWorley(uv, S, 1.0, seed); return sat(w.y - w.x); }
  if (uKind == 8) return n01(tFbmG(uv, S, uOct, uLac, uGain, seed));
  if (uKind == 9) return tRidge(uv, S, uOct, seed);
  if (uKind == 10) return tTurb(uv, S, uOct, seed);
  if (uKind == 11) return n01(tWarpedFbm(uv, S, uOct, uAmt, seed));
  if (uKind == 12) return crackField(uv, S, uAmt, 0.05, seed);
  if (uKind == 13) return n01(simplexTiledFbm(uv, S, uOct, seed));
  return n01(tFbm(uv, S, uOct, seed));
}
void main(){
  outColor = vec4(
    field(vUv, uSeed),
    field(vUv, uSeed + 101.0),
    field(vUv, uSeed + 211.0),
    field(vUv, uSeed + 307.0));
}
`;

export default MATERIALS;
