/**
 * weather/ShelterMap.js — "what can the sky see?" Owner: weather agent.
 *
 * Rain that falls through roofs is the single most obvious tell that a weather system
 * is fake, and a per-drop raycast is far too expensive. So once the world is built we
 * render the whole scene from directly overhead with an orthographic camera and a
 * packed-depth material, read it back, and turn it into two small height fields:
 *
 *   top[]     world Y of the highest surface over (x, z)   — the surface rain lands on
 *   ground[]  world Y of the walkable floor                — where litter and mist live
 *
 * `top` is uploaded as a single-channel half-float texture that the rain, mote, splash
 * and litter shaders sample directly, so occlusion costs one texture fetch per particle
 * instead of a raycast. The same array answers CPU queries (`topAt`, `openSky`) for
 * splash placement, drip emitters and the lens droplets.
 *
 * The bake is one extra scene render, run once after the level, props and foliage have
 * all published their geometry — and again only when someone calls `rebuild()`
 * (destruction opening a roof, for instance).
 *
 * Owner-safe: nothing in another module is mutated except `object.visible`, which is
 * restored in the same synchronous block.
 */
import * as THREE from 'three';

const EMPTY = -9000;

/** RGBA-packed depth -> [0,1], matching three's packDepthToRGBA(). */
const UNPACK = 255 / 256;
function unpackDepth(buf, i) {
  return (
    UNPACK *
    (buf[i] / 255 / 16777216 + buf[i + 1] / 255 / 65536 + buf[i + 2] / 255 / 256 + buf[i + 3] / 255)
  );
}

export class ShelterMap {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = false;
    this.res = 0;
    this.minX = -64;
    this.maxZ = 60;
    this.sizeX = 128;
    this.sizeZ = 118;
    this.top = null; // Float32Array(res*res)
    this.ground = null;
    this.texture = null; // half-float R, world Y of the top surface
    this.groundTexture = null;
    /** vec4(minX, maxZ, 1/sizeX, -1/sizeZ) — the uv transform both textures share. */
    this.rect = new THREE.Vector4(-64, 60, 1 / 128, -1 / 118);
    /** Roof/awning lips that shed water: {x, y, z, fall}. */
    this.dripEdges = [];
    /** Outdoor, roughly flat, low-lying cells — where puddles gather. */
    this.puddleCells = [];
    this._rt = null;
    this._depthMat = null;
    this._cam = null;
    this._buf = null;
  }

  /** @param {number} res texels per side */
  build(res = 512) {
    const ctx = this.ctx;
    const renderer = ctx.renderer;
    const scene = ctx.scene;
    if (!renderer || !scene) return false;

    const b = ctx.level?.bounds;
    const minX = b?.min?.x ?? -64;
    const maxX = b?.max?.x ?? 64;
    const minZ = b?.min?.z ?? -58;
    const maxZ = b?.max?.z ?? 60;
    const minY = (b?.min?.y ?? -3) - 4;
    const maxY = (b?.max?.y ?? 26) + 12;

    // A little slop so drops just outside the play space still test correctly.
    const pad = 6;
    this.minX = minX - pad;
    this.maxZ = maxZ + pad;
    this.sizeX = maxX - minX + pad * 2;
    this.sizeZ = maxZ - minZ + pad * 2;
    this.res = res;
    this.rect.set(this.minX, this.maxZ, 1 / this.sizeX, -1 / this.sizeZ);

    if (!this._rt || this._rt.width !== res) {
      this._rt?.dispose();
      this._rt = new THREE.WebGLRenderTarget(res, res, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
      });
      this._rt.texture.name = 'weather.shelterDepth';
    }
    if (!this._depthMat) this._buildDepthMaterial();
    if (!this._farScene) this._buildFarQuad();

    const near = 0.5;
    const far = maxY - minY;
    const camY = maxY;
    if (!this._cam) this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, near, far);
    const cam = this._cam;
    cam.left = -this.sizeX * 0.5;
    cam.right = this.sizeX * 0.5;
    cam.top = this.sizeZ * 0.5;
    cam.bottom = -this.sizeZ * 0.5;
    cam.near = near;
    cam.far = far;
    cam.position.set(this.minX + this.sizeX * 0.5, camY, this.maxZ - this.sizeZ * 0.5);
    // Looking straight down: pick an up vector so screen +Y is world -Z.
    cam.up.set(0, 0, -1);
    cam.lookAt(cam.position.x, camY - 10, cam.position.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    // ── render ────────────────────────────────────────────────────────────────
    const hidden = [];
    const skyMesh = ctx.sky?._impl?.mesh;
    const stash = (o) => {
      if (o && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    };
    stash(skyMesh);
    scene.traverse((o) => {
      if (o === skyMesh) return;
      if (o.visible && (o.userData?.noShelter || o.isSprite || o.isPoints || o.isLine)) stash(o);
    });

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;

    let ok = true;
    try {
      scene.overrideMaterial = this._depthMat;
      scene.background = null;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(this._rt);
      renderer.autoClear = false;
      /**
       * The colour buffer is primed with a full-screen quad rather than a clear.
       *
       * Getting a known clear *colour* from outside the renderer is not reliable:
       * `setClearColor` only stores the value, and three does not push it into
       * `gl.clearColor` until `WebGLBackground.render()` runs inside `renderer.render()`.
       * Clearing by hand therefore uses whatever the previous pass left in GL state,
       * and this bake is exactly the kind of code where a silently wrong clear turns
       * into "the entire level is indoors". A quad has no such dependency.
       *
       * The *depth* clear is safe to do normally — three only ever sets gl.clearDepth
       * to 1 — and it has to happen, or the previous bake's depths would reject this
       * one's geometry.
       */
      renderer.clear(false, true, false);
      renderer.render(this._farScene, cam);
      renderer.render(scene, cam);
    } catch (err) {
      ok = false;
      console.warn('[weather] shelter bake failed', err?.message || err);
    } finally {
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
      renderer.shadowMap.autoUpdate = prevShadow;
      renderer.autoClear = prevAutoClear;
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.setRenderTarget(prevTarget);
      for (const o of hidden) o.visible = true;
    }
    if (!ok) return false;

    // ── read back and decode ─────────────────────────────────────────────────
    const n = res * res;
    if (!this._buf || this._buf.length !== n * 4) this._buf = new Uint8Array(n * 4);
    try {
      renderer.readRenderTargetPixels(this._rt, 0, 0, res, res, this._buf);
    } catch (err) {
      console.warn('[weather] shelter readback failed', err?.message || err);
      return false;
    }

    const top = new Float32Array(n);
    const range = far - near;
    let hits = 0;
    let pinned = 0;
    // Nothing in the level is legally above its own bounds. A readback that decodes
    // to a sky full of rooftops is a broken readback, whatever broke it — a failed
    // clear, a lost render target, or the depth inversion silently not applying.
    const ceiling = maxY - 10.5;
    for (let i = 0; i < n; i++) {
      // Stored inverted (see _buildDepthMaterial): 0 == nothing here.
      const stored = unpackDepth(this._buf, i * 4);
      if (stored <= 2e-4) {
        top[i] = EMPTY;
      } else {
        top[i] = camY - (near + (1 - stored) * range);
        hits++;
        if (top[i] > ceiling) pinned++;
      }
    }
    this.top = top;
    // Kept for diagnostics: a bake that goes wrong goes wrong silently and globally,
    // so it is worth being able to see what actually came back.
    let sumA = 0;
    for (let i = 3; i < this._buf.length; i += 4) sumA += this._buf[i];
    this.lastBake = { n, hits, pinned, empty: n - hits, meanAlpha: sumA / n, camY, near, far };
    if (hits < n * 0.02) {
      // Nothing was in front of the camera — an empty scene, not a real bake.
      console.warn('[weather] shelter bake saw no geometry; occlusion disabled');
      return false;
    }
    if (pinned > n * 0.5) {
      // Better no occlusion (rain everywhere) than total occlusion (rain nowhere).
      console.warn(
        `[weather] shelter bake decoded ${((pinned / n) * 100) | 0}% of the map above the ` +
          'level ceiling; occlusion disabled'
      );
      return false;
    }

    this._buildGround();
    this._floorTop();
    this._uploadTextures();
    this._findDripEdges();
    this._findPuddleCells();
    this.ready = true;
    return true;
  }

  /**
   * `MeshDepthMaterial` with one line changed: it stores **1 - depth** instead of
   * depth.
   *
   * This is the safety property the whole system rests on. Stored 0 has to mean "no
   * roof". A render target that was never written, a clear that silently used the
   * wrong colour, a readback that fails half way — all of those hand back zeros, and
   * with three's normal packing zeros decode as "a solid ceiling half a metre under
   * the bake camera", i.e. the entire level is indoors and not one raindrop falls.
   * Inverted, zeros decode as the bottom of the volume, which is filtered out as
   * empty: the failure mode becomes rain everywhere, which is merely wrong rather
   * than catastrophic.
   */
  _buildDepthMaterial() {
    const mat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.DoubleSide,
    });
    mat.name = 'weather:shelterDepth';
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = packDepthToRGBA( fragCoordZ );',
        () => 'gl_FragColor = packDepthToRGBA( 1.0 - fragCoordZ );'
      );
    };
    // Programs are cached globally by key: without this we would be handed (or hand
    // out) a stock shadow-caster's depth program and the inversion would vanish.
    mat.customProgramCacheKey = () => 'weather:shelterDepth:inverted';
    this._depthMat = mat;
  }

  /**
   * The topmost surface can never be *below* the walkable floor. Anything that decodes
   * that way — a texel the bake missed, or one that landed on the far plane because the
   * street is a hair outside the depth range — is snapped up to the floor.
   *
   * This is what makes the height field mean one simple thing everywhere: "the surface
   * rain lands on at (x, z)". Open street, and it is the road; under an awning, and it
   * is the awning. `_findDripEdges`, `_findPuddleCells`, the rain shader's occlusion
   * test and the splash placement all read it that way, and none of them has to carry
   * a special case for a bake that came back imperfect.
   */
  _floorTop() {
    const top = this.top;
    const ground = this.ground;
    if (!top || !ground) return;
    for (let i = 0; i < top.length; i++) {
      const g = ground[i];
      if (top[i] === EMPTY || top[i] < g) top[i] = g;
    }
  }

  /** A full-screen quad that writes the "nothing here" value — see above, that is 0. */
  _buildFarQuad() {
    const mat = new THREE.ShaderMaterial({
      name: 'weather:shelterFar',
      // Positions are already in clip space; the camera is irrelevant.
      vertexShader: 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
      fragmentShader: 'void main() { gl_FragColor = vec4( 0.0 ); }',
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this._farScene = new THREE.Scene();
    this._farScene.add(quad);
    this._farQuad = quad;
  }

  /**
   * The walkable floor, from the level's own terrain model where it exists. Falls
   * back to the depth bake, clamped so a rooftop never becomes "the ground".
   */
  _buildGround() {
    const res = this.res;
    const g = new Float32Array(res * res);
    const level = this.ctx.level;
    const canQuery = typeof level?.groundY === 'function' && level.ready !== false;
    for (let j = 0; j < res; j++) {
      const z = this.maxZ - ((j + 0.5) / res) * this.sizeZ;
      for (let i = 0; i < res; i++) {
        const k = j * res + i;
        const x = this.minX + ((i + 0.5) / res) * this.sizeX;
        let y;
        if (canQuery) {
          y = level.groundY(x, z);
          if (!Number.isFinite(y)) y = 0;
        } else {
          y = this.top[k];
          if (y === EMPTY) y = 0;
        }
        g[k] = y;
      }
    }
    this.ground = g;
  }

  _uploadTextures() {
    const res = this.res;
    const n = res * res;
    const toHalf = THREE.DataUtils.toHalfFloat;

    const mk = (src, name) => {
      const data = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        // Half-float tops out at 65504; EMPTY has to survive the round trip.
        const v = src[i] === EMPTY ? -6000 : src[i];
        data[i] = toHalf(v);
      }
      const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.HalfFloatType);
      tex.name = name;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = false;
      tex.needsUpdate = true;
      return tex;
    };

    this.texture?.dispose();
    this.groundTexture?.dispose();
    this.texture = mk(this.top, 'weather.shelterTop');
    this.groundTexture = mk(this.ground, 'weather.ground');
  }

  /**
   * A drip emitter is a texel whose neighbour drops away sharply — the lip of a roof,
   * an awning or a balcony. Picked on a coarse stride and sorted so we keep the
   * highest, longest falls, which are the ones that read on screen.
   */
  _findDripEdges() {
    const res = this.res;
    const top = this.top;
    const ground = this.ground;
    const out = [];
    const stride = Math.max(2, Math.round(res / 180));
    const dx = this.sizeX / res;
    for (let j = stride; j < res - stride; j += stride) {
      for (let i = stride; i < res - stride; i += stride) {
        const k = j * res + i;
        const h = top[k];
        if (h === EMPTY) continue;
        const gy = ground[k];
        if (h - gy < 2.2) continue; // not a roof, just the floor
        let drop = 0;
        for (let o = 0; o < 4; o++) {
          const ii = i + (o === 0 ? stride : o === 1 ? -stride : 0);
          const jj = j + (o === 2 ? stride : o === 3 ? -stride : 0);
          const nh = top[jj * res + ii];
          const d = nh === EMPTY ? h - ground[jj * res + ii] : h - nh;
          if (d > drop) drop = d;
        }
        if (drop < 1.6) continue;
        const x = this.minX + ((i + 0.5) / res) * this.sizeX;
        const z = this.maxZ - ((j + 0.5) / res) * this.sizeZ;
        out.push({ x, y: h - 0.06, z, fall: Math.min(drop, h - gy), score: drop * (h - gy) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    // Thin them out so a single long parapet does not eat the whole budget.
    const kept = [];
    const minSep = Math.max(1.1, dx * 4);
    const minSep2 = minSep * minSep;
    for (const e of out) {
      let clash = false;
      for (let i = kept.length - 1; i >= 0 && i > kept.length - 40; i--) {
        const d = kept[i];
        const ddx = d.x - e.x;
        const ddz = d.z - e.z;
        if (ddx * ddx + ddz * ddz < minSep2) {
          clash = true;
          break;
        }
      }
      if (!clash) kept.push(e);
      if (kept.length >= 420) break;
    }
    this.dripEdges = kept;
  }

  /** Low, flat, open-to-the-sky cells: the places standing water actually collects. */
  _findPuddleCells() {
    const res = this.res;
    const top = this.top;
    const ground = this.ground;
    const out = [];
    const stride = Math.max(3, Math.round(res / 90));
    scan: for (let j = stride; j < res - stride; j += stride) {
      for (let i = stride; i < res - stride; i += stride) {
        const k = j * res + i;
        if (top[k] === EMPTY) continue;
        const gy = ground[k];
        if (top[k] - gy > 0.6) continue; // under a roof
        let higher = 0;
        let sum = 0;
        let flat = true;
        for (let o = 0; o < 4; o++) {
          const ii = i + (o === 0 ? stride : o === 1 ? -stride : 0);
          const jj = j + (o === 2 ? stride : o === 3 ? -stride : 0);
          const ng = ground[jj * res + ii];
          sum += ng;
          if (ng > gy + 0.02) higher++;
          if (Math.abs(ng - gy) > 0.55) flat = false;
        }
        if (!flat) continue;
        // Water gathers where it cannot run off: a local dip, or dead-flat ground.
        // Demanding a strict local minimum finds nothing at all on asphalt, which is
        // flat to within a millimetre over a metre — so accept "not the high point"
        // as well, which still rejects the crown of a cambered road and keeps the
        // gutters.
        if (higher < 1 && gy > sum * 0.25 + 0.012) continue;
        out.push({
          x: this.minX + ((i + 0.5) / res) * this.sizeX,
          y: gy,
          z: this.maxZ - ((j + 0.5) / res) * this.sizeZ,
        });
        if (out.length >= 2000) break scan;
      }
    }
    this.puddleCells = out;
  }

  /* ─────────────────────────────────────────────────────────────── CPU queries */

  _index(x, z) {
    const res = this.res;
    if (!res) return -1;
    const u = (x - this.minX) / this.sizeX;
    const v = (this.maxZ - z) / this.sizeZ;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return -1;
    const i = Math.min(res - 1, (u * res) | 0);
    const j = Math.min(res - 1, (v * res) | 0);
    return j * res + i;
  }

  /** World Y of the topmost surface above (x,z), or null outside the bake. */
  topAt(x, z) {
    if (!this.ready) return null;
    const k = this._index(x, z);
    if (k < 0) return null;
    const v = this.top[k];
    return v === EMPTY ? null : v;
  }

  groundAt(x, z) {
    if (!this.ready) return null;
    const k = this._index(x, z);
    return k < 0 ? null : this.ground[k];
  }

  /** 1 when the point sees the sky, 0 when a roof is over it. */
  openSky(x, y, z, bias = 0.3) {
    const t = this.topAt(x, z);
    if (t === null) return 1;
    return y >= t - bias ? 1 : 0;
  }

  /**
   * Softened version for wetness / lens droplets: samples a small kernel so standing
   * one step outside a doorway does not snap the effect on.
   */
  exposure(x, y, z, radius = 1.6) {
    if (!this.ready) return 1;
    let s = 0;
    let n = 0;
    for (let o = 0; o < 5; o++) {
      const a = (o / 5) * Math.PI * 2;
      const r = o === 0 ? 0 : radius;
      s += this.openSky(x + Math.cos(a) * r, y, z + Math.sin(a) * r, 0.3);
      n++;
    }
    return s / n;
  }

  dispose() {
    this._rt?.dispose();
    this._depthMat?.dispose();
    this._farQuad?.geometry?.dispose();
    this._farQuad?.material?.dispose();
    this._farScene = null;
    this._farQuad = null;
    this.texture?.dispose();
    this.groundTexture?.dispose();
    this._rt = null;
    this._depthMat = null;
    this.texture = null;
    this.groundTexture = null;
    this.top = null;
    this.ground = null;
    this.ready = false;
  }
}

export default ShelterMap;
