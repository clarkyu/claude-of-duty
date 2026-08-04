/**
 * GLSL procedural noise library. Owner: TextureForge agent (src/materials/*).
 *
 * Purpose
 *   Every texture in the game is generated on the GPU from these functions. They are
 *   exported as GLSL source chunks (GLSL ES 3.00) that TextureForge concatenates into
 *   its generation shaders.
 *
 * Public API (JS)
 *   HASH, VALUE, GRADIENT, WORLEY, FBM, WARP, TILE, SIMPLEX, SIMPLEX4
 *   NOISE_CORE  — hash + value + gradient + worley + fbm + warp + uv helpers
 *   NOISE_FULL  — NOISE_CORE + simplex 2/3/4 + tileable simplex
 *
 * Tiling contract
 *   Everything named `t*` takes a uv in [0,1] and an integer lattice `scale`; the result
 *   is *exactly* seamless across the unit square because the lattice hash is taken
 *   modulo the period. Non-tileable variants exist only for 3D/4D use.
 *
 * Hashing is integer PCG (not sin-based) so results are bit-stable across drivers and
 * across runs, which the deterministic screenshot harness depends on.
 */

/* --------------------------------------------------------------- hashing */
// language=GLSL
export const HASH = /* glsl */ `
// PCG hash — high quality, integer-exact, deterministic on every GPU.
uint _pcg(uint v){
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
uint _pcg2(uvec2 v){ return _pcg(v.x ^ _pcg(v.y + 0x9e3779b9u)); }
uint _pcg3(uvec3 v){ return _pcg(v.x ^ _pcg(v.y ^ _pcg(v.z + 0x85ebca6bu))); }
float _u2f(uint u){ return float(u & 0x00ffffffu) * (1.0 / 16777216.0); }
uint  _seedU(float s){ return uint(int(s * 977.0)) * 0x9e3779b9u; }

float hash11(float x, float seed){ return _u2f(_pcg(uint(int(x)) + _seedU(seed))); }
float hash21(vec2 c, float seed){ return _u2f(_pcg2(uvec2(ivec2(c)) + uvec2(_seedU(seed)))); }
vec2  hash22(vec2 c, float seed){
  uint h = _pcg2(uvec2(ivec2(c)) + uvec2(_seedU(seed)));
  uint g = _pcg(h);
  return vec2(_u2f(h), _u2f(g));
}
vec3  hash23(vec2 c, float seed){
  uint h = _pcg2(uvec2(ivec2(c)) + uvec2(_seedU(seed)));
  uint g = _pcg(h); uint k = _pcg(g);
  return vec3(_u2f(h), _u2f(g), _u2f(k));
}
vec4  hash24(vec2 c, float seed){
  uint h = _pcg2(uvec2(ivec2(c)) + uvec2(_seedU(seed)));
  uint g = _pcg(h); uint k = _pcg(g); uint m = _pcg(k);
  return vec4(_u2f(h), _u2f(g), _u2f(k), _u2f(m));
}
float hash31(vec3 c, float seed){ return _u2f(_pcg3(uvec3(ivec3(c)) + uvec3(_seedU(seed)))); }
vec3  hash33(vec3 c, float seed){
  uint h = _pcg3(uvec3(ivec3(c)) + uvec3(_seedU(seed)));
  uint g = _pcg(h); uint k = _pcg(g);
  return vec3(_u2f(h), _u2f(g), _u2f(k));
}
`;

/* ----------------------------------------------------------- value noise */
// language=GLSL
export const VALUE = /* glsl */ `
// Periodic value noise. period is in lattice cells and must be integral.
float valueNoiseP(vec2 p, vec2 period, float seed){
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 pp = max(period, vec2(1.0));
  float a = hash21(mod(i,                pp), seed);
  float b = hash21(mod(i + vec2(1.0,0.0), pp), seed);
  float c = hash21(mod(i + vec2(0.0,1.0), pp), seed);
  float d = hash21(mod(i + vec2(1.0,1.0), pp), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float valueNoise(vec2 p, float seed){ return valueNoiseP(p, vec2(4096.0), seed); }

float valueNoise3(vec3 p, float seed){
  vec3 i = floor(p), f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash31(i + vec3(0,0,0), seed), b = hash31(i + vec3(1,0,0), seed);
  float c = hash31(i + vec3(0,1,0), seed), d = hash31(i + vec3(1,1,0), seed);
  float e = hash31(i + vec3(0,0,1), seed), g = hash31(i + vec3(1,0,1), seed);
  float h = hash31(i + vec3(0,1,1), seed), k = hash31(i + vec3(1,1,1), seed);
  return mix(mix(mix(a,b,u.x), mix(c,d,u.x), u.y), mix(mix(e,g,u.x), mix(h,k,u.x), u.y), u.z);
}
`;

/* -------------------------------------------------------- gradient noise */
// language=GLSL
export const GRADIENT = /* glsl */ `
vec2 _grad2(vec2 cell, float seed){
  float a = hash21(cell, seed) * 6.28318530718;
  return vec2(cos(a), sin(a));
}
// Periodic Perlin/gradient noise, returns roughly [-1,1].
float gradNoiseP(vec2 p, vec2 period, float seed){
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 pp = max(period, vec2(1.0));
  float a = dot(_grad2(mod(i,                 pp), seed), f);
  float b = dot(_grad2(mod(i + vec2(1.0,0.0), pp), seed), f - vec2(1.0,0.0));
  float c = dot(_grad2(mod(i + vec2(0.0,1.0), pp), seed), f - vec2(0.0,1.0));
  float d = dot(_grad2(mod(i + vec2(1.0,1.0), pp), seed), f - vec2(1.0,1.0));
  return (mix(mix(a, b, u.x), mix(c, d, u.x), u.y)) * 1.4142136;
}
float gradNoise(vec2 p, float seed){ return gradNoiseP(p, vec2(4096.0), seed); }
`;

/* ------------------------------------------------------- worley/cellular */
// language=GLSL
export const WORLEY = /* glsl */ `
// Periodic Worley. Returns vec4(F1, F2, cellRandom, cellRandom2).
vec4 worleyP(vec2 p, vec2 period, float jitter, float seed){
  vec2 ip = floor(p), fp = p - ip;
  vec2 pp = max(period, vec2(1.0));
  float f1 = 9.0, f2 = 9.0, id = 0.0, id2 = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 cell = mod(ip + g, pp);
      vec2 o = hash22(cell, seed);
      vec2 r = g + 0.5 + (o - 0.5) * jitter - fp;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; vec2 q = hash22(cell, seed + 91.0); id = q.x; id2 = q.y; }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec4(sqrt(f1), sqrt(f2), id, id2);
}
// Angular (chebyshev-blend) variant — reads as fractured/broken material.
vec4 worleyAngP(vec2 p, vec2 period, float jitter, float seed){
  vec2 ip = floor(p), fp = p - ip;
  vec2 pp = max(period, vec2(1.0));
  float f1 = 9.0, f2 = 9.0, id = 0.0, id2 = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 cell = mod(ip + g, pp);
      vec2 o = hash22(cell, seed);
      vec2 r = abs(g + 0.5 + (o - 0.5) * jitter - fp);
      float d = max(max(r.x, r.y), (r.x + r.y) * 0.72);
      if (d < f1) { f2 = f1; f1 = d; vec2 q = hash22(cell, seed + 91.0); id = q.x; id2 = q.y; }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec4(f1, f2, id, id2);
}
float worleyF1(vec2 p, vec2 period, float seed){ return worleyP(p, period, 1.0, seed).x; }
float worleyF2(vec2 p, vec2 period, float seed){ return worleyP(p, period, 1.0, seed).y; }
float worleyEdge(vec2 p, vec2 period, float seed){ vec4 w = worleyP(p, period, 1.0, seed); return w.y - w.x; }
`;

/* -------------------------------------------------------------- fBm etc. */
// language=GLSL
export const FBM = /* glsl */ `
// Fractal brownian motion over periodic gradient noise. The period is advanced with
// the frequency (rounded to stay integral) so every octave keeps tiling exactly.
float fbmP(vec2 p, vec2 period, int oct, float lac, float gain, float seed){
  float sum = 0.0, amp = 0.5, norm = 0.0;
  vec2 per = max(period, vec2(1.0));
  vec2 q = p;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += amp * gradNoiseP(q, per, seed + float(i) * 17.31);
    norm += amp;
    amp *= gain;
    vec2 nper = max(vec2(1.0), floor(per * lac + 0.5));
    q *= nper / per;
    per = nper;
  }
  return sum / max(norm, 1e-4);
}

// Value-noise fBm — softer, cheaper, good for large blotches.
float fbmValP(vec2 p, vec2 period, int oct, float lac, float gain, float seed){
  float sum = 0.0, amp = 0.5, norm = 0.0;
  vec2 per = max(period, vec2(1.0));
  vec2 q = p;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += amp * (valueNoiseP(q, per, seed + float(i) * 23.7) * 2.0 - 1.0);
    norm += amp;
    amp *= gain;
    vec2 nper = max(vec2(1.0), floor(per * lac + 0.5));
    q *= nper / per;
    per = nper;
  }
  return sum / max(norm, 1e-4);
}

// |noise| stack — billowy turbulence, 0..1.
float turbP(vec2 p, vec2 period, int oct, float lac, float gain, float seed){
  float sum = 0.0, amp = 0.5, norm = 0.0;
  vec2 per = max(period, vec2(1.0));
  vec2 q = p;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += amp * abs(gradNoiseP(q, per, seed + float(i) * 13.7));
    norm += amp;
    amp *= gain;
    vec2 nper = max(vec2(1.0), floor(per * lac + 0.5));
    q *= nper / per;
    per = nper;
  }
  return sum / max(norm, 1e-4);
}

// Ridged multifractal — sharp crests, 0..1. Classic for rock/rust/erosion.
float ridgedP(vec2 p, vec2 period, int oct, float lac, float gain, float offset, float seed){
  float sum = 0.0, amp = 0.5, norm = 0.0, prev = 1.0;
  vec2 per = max(period, vec2(1.0));
  vec2 q = p;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float n = offset - abs(gradNoiseP(q, per, seed + float(i) * 29.1));
    n = max(n, 0.0);
    n = n * n;
    sum += amp * n * prev;
    norm += amp;
    prev = clamp(n * 2.0, 0.0, 1.0);
    amp *= gain;
    vec2 nper = max(vec2(1.0), floor(per * lac + 0.5));
    q *= nper / per;
    per = nper;
  }
  return clamp(sum / max(norm, 1e-4), 0.0, 1.0);
}
`;

/* ------------------------------------------------------------ warping */
// language=GLSL
export const WARP = /* glsl */ `
// Domain warp in lattice space; preserves the period so the result still tiles.
vec2 domainWarpP(vec2 p, vec2 period, float amount, int oct, float seed){
  float a = fbmP(p, period, oct, 2.0, 0.5, seed + 19.3);
  float b = fbmP(p, period, oct, 2.0, 0.5, seed + 71.9);
  return p + amount * vec2(a, b);
}
// Two-level warp (Inigo Quilez style) — organic, non-repeating look.
float warpedFbmP(vec2 p, vec2 period, int oct, float amount, float seed){
  vec2 q = domainWarpP(p, period, amount, max(2, oct - 1), seed);
  vec2 r = domainWarpP(q, period, amount * 0.5, max(2, oct - 2), seed + 137.0);
  return fbmP(r, period, oct, 2.0, 0.5, seed + 211.0);
}
`;

/* --------------------------------------------- uv-space tileable wrappers */
// language=GLSL
export const TILE = /* glsl */ `
// All of these take uv in [0,1] and an integer lattice scale, and tile exactly.
vec2 tScale(vec2 s){ return max(vec2(1.0), floor(s + 0.5)); }

float tValue(vec2 uv, vec2 s, float seed){ vec2 S = tScale(s); return valueNoiseP(uv * S, S, seed); }
float tGrad (vec2 uv, vec2 s, float seed){ vec2 S = tScale(s); return gradNoiseP(uv * S, S, seed); }
float tFbm  (vec2 uv, vec2 s, int o, float seed){ vec2 S = tScale(s); return fbmP(uv * S, S, o, 2.0, 0.5, seed); }
float tFbmG (vec2 uv, vec2 s, int o, float lac, float gain, float seed){ vec2 S = tScale(s); return fbmP(uv * S, S, o, lac, gain, seed); }
float tFbmV (vec2 uv, vec2 s, int o, float seed){ vec2 S = tScale(s); return fbmValP(uv * S, S, o, 2.0, 0.5, seed); }
float tTurb (vec2 uv, vec2 s, int o, float seed){ vec2 S = tScale(s); return turbP(uv * S, S, o, 2.0, 0.5, seed); }
float tRidge(vec2 uv, vec2 s, int o, float seed){ vec2 S = tScale(s); return ridgedP(uv * S, S, o, 2.0, 0.5, 1.0, seed); }
vec4  tWorley(vec2 uv, vec2 s, float jitter, float seed){ vec2 S = tScale(s); return worleyP(uv * S, S, jitter, seed); }
vec4  tWorleyAng(vec2 uv, vec2 s, float jitter, float seed){ vec2 S = tScale(s); return worleyAngP(uv * S, S, jitter, seed); }
float tWarpedFbm(vec2 uv, vec2 s, int o, float amt, float seed){ vec2 S = tScale(s); return warpedFbmP(uv * S, S, o, amt, seed); }

// Warp a uv by a tileable vector field. Result advances by exactly 1 per tile, so any
// tileable function evaluated at the warped uv is still seamless.
vec2 tWarp(vec2 uv, vec2 s, float amt, int oct, float seed){
  vec2 S = tScale(s);
  float a = fbmP(uv * S, S, oct, 2.0, 0.5, seed + 3.7);
  float b = fbmP(uv * S, S, oct, 2.0, 0.5, seed + 53.1);
  return uv + amt * vec2(a, b);
}

// Deterministic per-cell random that respects the tile (never seams).
float cellHash(vec2 uv, vec2 n, float seed){ vec2 N = tScale(n); return hash21(mod(floor(uv * N), N), seed); }
vec3  cellHash3(vec2 uv, vec2 n, float seed){ vec2 N = tScale(n); return hash23(mod(floor(uv * N), N), seed); }
`;

/* ---------------------------------------------------------- simplex 2/3D */
// language=GLSL
export const SIMPLEX = /* glsl */ `
vec3 _mod289v3(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _mod289v4(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 _mod289v2(vec2 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
float _mod289f(float x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 _permute3(vec3 x){ return _mod289v3(((x * 34.0) + 10.0) * x); }
vec4 _permute4(vec4 x){ return _mod289v4(((x * 34.0) + 10.0) * x); }
float _permutef(float x){ return _mod289f(((x * 34.0) + 10.0) * x); }
vec4 _taylorInvSqrt4(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float _taylorInvSqrtf(float r){ return 1.79284291400159 - 0.85373472095314 * r; }

// Classic 2D simplex noise, [-1,1]. Not tileable — use simplexTiled() for that.
float snoise2(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = _mod289v2(i);
  vec3 p = _permute3(_permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Classic 3D simplex noise, [-1,1].
float snoise3(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = _mod289v3(i);
  vec4 p = _permute4(_permute4(_permute4(
             i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
             i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
             i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _taylorInvSqrt4(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/* -------------------------------------- simplex 4D + tileable simplex 2D */
// language=GLSL
export const SIMPLEX4 = /* glsl */ `
vec4 _grad4(float j, vec4 ip){
  const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
  vec4 p, s;
  p.xyz = floor(fract(vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
  p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
  s = vec4(lessThan(p, vec4(0.0)));
  p.xyz = p.xyz + (s.xyz * 2.0 - 1.0) * s.www;
  return p;
}

// Classic 4D simplex noise, [-1,1].
float snoise4(vec4 v){
  const vec4 C = vec4(0.138196601125011, 0.276393202250021, 0.414589803375032, -0.447213595499958);
  const float F4 = 0.309016994374947451;
  vec4 i  = floor(v + dot(v, vec4(F4)));
  vec4 x0 = v - i + dot(i, C.xxxx);
  vec4 i0;
  vec3 isX = step(x0.yzw, x0.xxx);
  vec3 isYZ = step(x0.zww, x0.yyz);
  i0.x = isX.x + isX.y + isX.z;
  i0.yzw = 1.0 - isX;
  i0.y += isYZ.x + isYZ.y;
  i0.zw += 1.0 - isYZ.xy;
  i0.z += isYZ.z;
  i0.w += 1.0 - isYZ.z;
  vec4 i3 = clamp(i0, 0.0, 1.0);
  vec4 i2 = clamp(i0 - 1.0, 0.0, 1.0);
  vec4 i1 = clamp(i0 - 2.0, 0.0, 1.0);
  vec4 x1 = x0 - i1 + C.xxxx;
  vec4 x2 = x0 - i2 + C.yyyy;
  vec4 x3 = x0 - i3 + C.zzzz;
  vec4 x4 = x0 + C.wwww;
  i = _mod289v4(i);
  float j0 = _permutef(_permutef(_permutef(_permutef(i.w) + i.z) + i.y) + i.x);
  vec4 j1 = _permute4(_permute4(_permute4(_permute4(
              i.w + vec4(i1.w, i2.w, i3.w, 1.0)) +
              i.z + vec4(i1.z, i2.z, i3.z, 1.0)) +
              i.y + vec4(i1.y, i2.y, i3.y, 1.0)) +
              i.x + vec4(i1.x, i2.x, i3.x, 1.0));
  vec4 ip = vec4(1.0 / 294.0, 1.0 / 49.0, 1.0 / 7.0, 0.0);
  vec4 p0 = _grad4(j0,   ip);
  vec4 p1 = _grad4(j1.x, ip);
  vec4 p2 = _grad4(j1.y, ip);
  vec4 p3 = _grad4(j1.z, ip);
  vec4 p4 = _grad4(j1.w, ip);
  vec4 norm = _taylorInvSqrt4(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  p4 *= _taylorInvSqrtf(dot(p4, p4));
  vec3 m0 = max(0.6 - vec3(dot(x0,x0), dot(x1,x1), dot(x2,x2)), 0.0);
  vec2 m1 = max(0.6 - vec2(dot(x3,x3), dot(x4,x4)), 0.0);
  m0 = m0 * m0; m1 = m1 * m1;
  return 49.0 * (dot(m0 * m0, vec3(dot(p0,x0), dot(p1,x1), dot(p2,x2))) +
                 dot(m1 * m1, vec2(dot(p3,x3), dot(p4,x4))));
}

// Seamlessly tileable 2D simplex: the unit square is mapped onto a 4D torus, so the
// field is genuinely periodic in both axes with no lattice-modulo trickery.
float simplexTiled(vec2 uv, vec2 s, float seed){
  vec2 S = max(vec2(1.0), floor(s + 0.5));
  vec2 a = uv * 6.28318530718;
  vec4 q = vec4(cos(a.x), sin(a.x), cos(a.y), sin(a.y)) * vec4(S.xx, S.yy) * 0.15915494;
  return snoise4(q + seed * 0.137);
}
float simplexTiledFbm(vec2 uv, vec2 s, int oct, float seed){
  float sum = 0.0, amp = 0.5, norm = 0.0;
  vec2 S = max(vec2(1.0), floor(s + 0.5));
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    sum += amp * simplexTiled(uv, S, seed + float(i) * 31.0);
    norm += amp; amp *= 0.5; S *= 2.0;
  }
  return sum / max(norm, 1e-4);
}
`;

/** Everything the material shaders need. Kept lean so shader compiles stay fast. */
export const NOISE_CORE = HASH + VALUE + GRADIENT + WORLEY + FBM + WARP + TILE;

/** Full library, including simplex 2/3/4D. Used by noiseTexture(). */
export const NOISE_FULL = NOISE_CORE + SIMPLEX + SIMPLEX4;

export default NOISE_CORE;
