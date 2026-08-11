/**
 * kit/Palette.js — the level's material vocabulary. Owner: level agent.
 *
 * Every batch in the map names a palette key, never a `ctx.materials` recipe directly.
 * That buys three things:
 *   1. **Variety with one program.** Two buildings can be `wall.sand` and `wall.ochre`
 *      — different `THREE.Material` instances with different tints and grime levels,
 *      but the same shader defines, so three compiles the program once. Shader compiles
 *      are ~1.5 s each under the CI's software rasteriser, so this matters a lot.
 *   2. **Trim-sheet banding.** Ground-level splash-back, mid-wall and roofline bands
 *      are separate keys, so a facade always has three material zones.
 *   3. A single place to add the vertex-AO shader hook (see VertexAO.js) to every
 *      material the level owns without touching anyone else's cached materials.
 *
 * Keys are `family.variant`. Unknown keys fall back to `struct.concrete` and log
 * nothing — a typo must never blank the level.
 */
import * as THREE from 'three';
import { attachVertexAO } from './VertexAO.js';
import { signageAtlas } from '../props/signageTexture.js';

/**
 * spec: { m: recipe name, o: get() opts, tint: hex, k: extra clone() overrides }
 * `tint` is applied through clone() so the cached program is shared.
 */
export const PALETTE = {
  /* ── render/structural concrete ─────────────────────────────────────── */
  /* `concreteClean` is the *trim* key: lintels, sills, copings, cornices, string
     courses, arch voussoirs, parapet caps, kerbs and pilaster ribs all resolve to it.
     Those are 0.15-0.30 m pieces, and at the recipe's native 3 m tile a lintel sampled
     ~7% of one tile — every aggregate speckle, form-board seam and tie hole in the
     recipe fell outside the piece, so forty lintels rendered as forty identical flat
     pale-grey slabs. `repeat: 2.6` puts the tile at 1.15 m so the detail actually
     lands on the moulding. Big cast surfaces keep the 3 m tile through
     `struct.concrete`. */
  'struct.concrete': { m: 'concrete_cast', o: { vertexColors: true, grime: 0.85 } },
  'struct.concreteClean': { m: 'concrete_cast', o: { vertexColors: true, grime: 0.35, repeat: 2.6 }, tint: 0xb8b3a8 },
  'struct.panel': { m: 'concrete_precast_panel', o: { vertexColors: true, grime: 0.9 } },
  'struct.panelPale': { m: 'concrete_precast_panel', o: { vertexColors: true, grime: 0.6, repeat: 1.5 }, tint: 0xc4bfb2 },

  /* ── plaster / stucco facades — the Mediterranean colour story ──────── */
  'wall.sand': { m: 'stucco', o: { vertexColors: true, grime: 1.05 }, tint: 0xd8c39a },
  'wall.ochre': { m: 'stucco', o: { vertexColors: true, grime: 1.15 }, tint: 0xc08a4e },
  'wall.bone': { m: 'stucco', o: { vertexColors: true, grime: 0.9 }, tint: 0xe0dbc9 },
  'wall.terracotta': { m: 'stucco', o: { vertexColors: true, grime: 1.2 }, tint: 0xa8613f },
  'wall.blue': { m: 'plaster_cracked', o: { vertexColors: true, grime: 1.1 }, tint: 0x7f95a3 },
  'wall.green': { m: 'plaster_cracked', o: { vertexColors: true, grime: 1.25 }, tint: 0x8a9878 },
  'wall.white': { m: 'plaster_cracked', o: { vertexColors: true, grime: 1.0 }, tint: 0xd9d5c8 },
  'wall.pink': { m: 'plaster_cracked', o: { vertexColors: true, grime: 1.3 }, tint: 0xc4a08e },

  /* ── the backdrop ranks ─────────────────────────────────────────────────
   * A distant city is read almost entirely as *value bands*: each rank is a step
   * lighter and a step cooler than the one in front, because that is what 100 m of
   * air does. The previous backdrop used the four playspace `wall.*` keys for every
   * rank, so 60 m and 340 m came back at the same hue and the same value and the
   * whole thing collapsed into one beige mass with no depth in it at all.
   *
   * Rank 1 (110-190 m) is the near hills: still chromatic, one stop up from the
   * playspace. Rank 2 (230-360 m) is the hill town: nearly achromatic, two stops up,
   * and the four tints inside it differ by hue only so the terrace does not stripe.
   * Grime is dialled down with distance for the same reason — dirt does not resolve.
   */
  'far.bone': { m: 'stucco', o: { vertexColors: true, grime: 0.55, repeat: 0.8 }, tint: 0xcdc7b6 },
  'far.dust': { m: 'stucco', o: { vertexColors: true, grime: 0.62, repeat: 0.8 }, tint: 0xb6a482 },
  'far.rose': { m: 'stucco', o: { vertexColors: true, grime: 0.6, repeat: 0.8 }, tint: 0xb08a76 },
  'far.slate': { m: 'stucco', o: { vertexColors: true, grime: 0.5, repeat: 0.8 }, tint: 0x99a2ab },
  'far.haze': { m: 'stucco', o: { vertexColors: true, grime: 0.3, repeat: 0.55 }, tint: 0xc6c6c0 },
  'far.hazeWarm': { m: 'stucco', o: { vertexColors: true, grime: 0.34, repeat: 0.55 }, tint: 0xcec2ac },
  'far.hazePale': { m: 'stucco', o: { vertexColors: true, grime: 0.24, repeat: 0.55 }, tint: 0xd9d6cc },
  'far.hazeCool': { m: 'stucco', o: { vertexColors: true, grime: 0.3, repeat: 0.55 }, tint: 0xb2bac4 },
  /** Roof decks and parapet caps on the far ranks: the dark end of the value ladder,
   *  which is what stops every block topping out in one flat pale line. */
  'far.deck': { m: 'concrete_cast', o: { vertexColors: true, grime: 1.15, repeat: 0.6 }, tint: 0x6e6a60 },
  'far.trim': { m: 'concrete_cast', o: { vertexColors: true, grime: 0.4, repeat: 0.9 }, tint: 0xd2ccbe },
  /**
   * ── Backdrop glazing, and why it is not glass ───────────────────────────────
   * The far ranks used `glass.window` for their fenestration. That key resolves to
   * `glass_dirty`: a MeshPhysical, `transparent`, `depthWrite:false`, double-sided
   * pane at **alpha 0.055**. Which means the eight thousand window quads on the
   * backdrop were, correctly, 5 % opaque — you could see the wall straight through
   * them, which is why a reviewer looking at the finished city reported "not a
   * single window". They were all there and all invisible.
   *
   * They were also the most expensive geometry in the map: transparent, so no depth
   * rejection and full overdraw; double-sided, so twice the fragments; physical, so
   * the heaviest shader in the library; and sorted per object every frame.
   *
   * At 60-360 m a window is a dark rectangle with a bit of sky in it. Two opaque
   * painted-metal keys — one dark, one catching the sky — give exactly that read for
   * a fraction of the cost, and they are visible, which the glass was not.
   */
  'far.glassDark': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 0.9, repeat: 1.4 }, tint: 0x2c343e },
  'far.glassLit': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 0.45, repeat: 1.4 }, tint: 0x93a4b0 },

  /* ── masonry ────────────────────────────────────────────────────────── */
  'brick.red': { m: 'brick_red', o: { vertexColors: true, grime: 1.0 } },
  'brick.buff': { m: 'brick_red', o: { vertexColors: true, grime: 1.1 }, tint: 0xb99b74 },
  'brick.painted': { m: 'brick_painted', o: { vertexColors: true, grime: 1.15 }, tint: 0xcfc6b0 },
  'brick.paintedBlue': { m: 'brick_painted', o: { vertexColors: true, grime: 1.2 }, tint: 0x8fa2ab },

  /* ── ground ─────────────────────────────────────────────────────────── */
  /* Made ground blends a second material through the vertex-colour green channel:
     asphalt breaking back to its aggregate base, paving silted over with dirt. The
     blend is height-aware, so it fills the joints and the low spots first — which is
     what stops 100 x 100 m of road reading as one tiled texture. */
  /* `layerAmount` was 0 on all three, so the whole second-material machinery was
     switched off and the ground was one uniform speckle from kerb to horizon. A small
     global amount, multiplied by the world-space macro band in the shader and biased
     into the cavities, gives grit collecting in the ruts of the road, silt over the
     paving joints and wind-drifted sand banking up on the dirt — patchy, at 20 m
     scale, and only on up-facing geometry so it never smears up a wall.

     Round 2 raised the amounts off zero and the ground still did not change, because
     the shader's weight was `sat(lw*(1+k) - bias*k)`: with k ≈ 1.8 and the height
     bias sitting near 0.5, nothing went positive below lw ≈ 0.32, so 0.2 bought a
     couple of percent coverage in the deepest cavities of the top of the macro band.
     materialExtensions now runs the standard height blend, whose 50% crossover is at
     bias == lw, so `layerAmount` finally means what it says: it is the *coverage
     fraction* at the middle of the macro band. `layerContrast` is now purely the
     hardness of the transition (higher = harder edge), not a gate. */
  'ground.road': {
    m: 'asphalt',
    o: {
      vertexColors: true,
      grime: 0.7,
      puddleLevel: 0.5,
      layer: 'gravel',
      layerAmount: 0.44,
      layerCavityBias: 0.85,
      layerUpFacing: 1,
      layerContrast: 2.4,
      layerRepeat: 1.35,
    },
  },
  'ground.pave': {
    m: 'sidewalk_paving',
    o: {
      vertexColors: true,
      grime: 0.9,
      puddleLevel: 0.45,
      layer: 'dirt_packed',
      layerAmount: 0.4,
      layerCavityBias: 0.9,
      layerUpFacing: 1,
      layerContrast: 2.0,
      layerRoughness: 1.05,
    },
  },
  'ground.dirt': {
    m: 'dirt_packed',
    o: {
      vertexColors: true,
      layer: 'sand',
      layerAmount: 0.5,
      // Drifted sand fills the hollows and banks against anything standing in it.
      layerCavityBias: 0.78,
      layerUpFacing: 1,
      layerContrast: 1.8,
      layerRepeat: 0.75,
      grime: 0.5,
      puddleLevel: 0.55,
    },
  },
  'ground.gravel': { m: 'gravel', o: { vertexColors: true, grime: 0.6 } },
  'ground.rubble': { m: 'rubble', o: { vertexColors: true, grime: 1.0 } },

  /* ── roofs ──────────────────────────────────────────────────────────── */
  'roof.shingle': { m: 'roof_shingle', o: { vertexColors: true, grime: 1.0 } },
  'roof.corrugated': { m: 'corrugated_metal', o: { vertexColors: true, grime: 1.1 } },
  'roof.corrugatedRust': { m: 'corrugated_metal', o: { vertexColors: true, grime: 1.35 }, tint: 0x9c7a5e },

  /* ── metal ──────────────────────────────────────────────────────────── */
  /* `galv` is what every rooftop AC unit, water tank and duct is made of; at the
     recipe's 1.6 m tile an 0.8 m casing showed half a spangle and read as flat grey
     card against the sky. `paintCream` is the window-frame key — a 5 cm mullion needs
     the chip and orange-peel detail an order of magnitude tighter than a door does. */
  'metal.rust': { m: 'rusted_steel', o: { vertexColors: true, grime: 1.1 } },
  'metal.galv': { m: 'galvanised_metal', o: { vertexColors: true, grime: 0.85, repeat: 2.2 } },
  'metal.paintBlue': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 1.0 }, tint: 0x5f7e8c },
  'metal.paintRed': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 1.1 }, tint: 0x9c4a38 },
  'metal.paintGreen': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 1.05 }, tint: 0x53664a },
  'metal.paintCream': { m: 'painted_steel_chipped', o: { vertexColors: true, grime: 0.95, repeat: 3.4 }, tint: 0xc3bda6 },

  /* ── timber ─────────────────────────────────────────────────────────── */
  'wood.weathered': { m: 'wood_plank_weathered', o: { vertexColors: true, grime: 1.05 } },
  /* `painted` is the joinery key — frames, shutters, door leaves. Same argument as the
     metal frames: the paint chipping and grain telegraph have to be at joinery scale. */
  'wood.painted': { m: 'plywood_painted', o: { vertexColors: true, grime: 1.0, repeat: 2.6 }, tint: 0x6d7f6a },
  'wood.paintedBlue': { m: 'plywood_painted', o: { vertexColors: true, grime: 1.05, repeat: 2.6 }, tint: 0x4a6272 },
  'wood.ply': { m: 'wood_ply', o: { vertexColors: true, grime: 1.2 } },

  /* ── glass & fabric ─────────────────────────────────────────────────── */
  /* One tile ~= one pane, so the recipe's edge dirt, runoff and cracks land at the
     size of the sheet they are meant to describe. */
  'glass.window': { m: 'glass_dirty', o: { side: 'double', repeat: 1.6 } },
  'glass.shop': { m: 'glass_dirty', o: { side: 'double', variant: 'shop' }, tint: 0xa8b2ae },
  'fabric.awning': { m: 'tarp', o: { side: 'double', vertexColors: true, grime: 1.0 }, tint: 0xa8564a },
  'fabric.awning2': { m: 'tarp', o: { side: 'double', vertexColors: true, grime: 1.0 }, tint: 0x4a6a86 },
  'fabric.canvas': { m: 'fabric_canvas', o: { side: 'double', vertexColors: true, grime: 1.1, repeat: 1.6 }, tint: 0xbcb096 },

  /* ── produce ────────────────────────────────────────────────────────────
     Three tints of one recipe, so the market stalls actually have *goods* on them.
     Same program, three clones — a heap of oranges next to a heap of greens is the
     only thing that separates a market from a row of empty trestles, and colour is
     doing almost all of that work at 8 m. */
  /*
   * Brightened hard, and the grime taken almost all the way off.
   *
   * Every stall in the map lives under an awning, so its goods are in shade — and
   * `dry_grass_ground` is a dark albedo that the tint multiplies, so 0xa8362a
   * tomatoes under a canopy rendered as near-black lumps. Reviewed at 3x that is
   * still "a row of dark blocks", just with the corners knocked off. Produce is the
   * one thing in a souk that is genuinely more saturated and more luminous than
   * anything around it, and these values are what it takes for that to survive both
   * the texture multiply and the shade.
   */
  'veg.citrus': { m: 'dry_grass_ground', o: { vertexColors: true, grime: 0.12, repeat: 5.0 }, tint: 0xf0a836 },
  'veg.tomato': { m: 'dry_grass_ground', o: { vertexColors: true, grime: 0.12, repeat: 5.0 }, tint: 0xd8503c },
  'veg.green': { m: 'dry_grass_ground', o: { vertexColors: true, grime: 0.16, repeat: 5.0 }, tint: 0x9dba4e },
  /** aubergine / dates / olives — the dark note the other three need to sit against */
  'veg.dark': { m: 'dry_grass_ground', o: { vertexColors: true, grime: 0.2, repeat: 5.0 }, tint: 0x6b4a6e },

  /* ── interior ───────────────────────────────────────────────────────── */
  /**
   * The macro band on the tile is dialled back hard. At full strength it painted a
   * 20 m blotch pattern across the floor that has nothing to do with the 30 cm tile
   * joints underneath it — a stain overlay unrelated to the geometry, which is worse
   * than a clean floor because it advertises that the wear is a texture. The wear is
   * now carried by *geometry*: a different tile in the traffic lane, screeded patches
   * where tiles have lifted, a stone threshold and a floor gully. See
   * buildMarketInterior() / buildShopInterior().
   */
  'int.tile': { m: 'ceramic_tile', o: { vertexColors: true, grime: 1.0, macro: 0.45 } },
  'int.tileWorn': { m: 'ceramic_tile', o: { vertexColors: true, grime: 1.45, repeat: 1.2 }, tint: 0x9a9184 },
  'int.screed': { m: 'concrete_cast', o: { vertexColors: true, grime: 1.3, repeat: 2.0 }, tint: 0x8f8779 },
  'int.plaster': { m: 'plaster_cracked', o: { vertexColors: true, grime: 0.85 }, tint: 0xcfc8b6 },

  /* ── water & signage ────────────────────────────────────────────────── */
  'water.pool': { m: 'water_pool', o: {} },
  /**
   * Lamp bowls and lit signs. 1.5 put the glazed underside of a street luminaire below
   * the pavement it was lighting on the night frame — the review read the fittings as
   * "black boxes with no emissive". A sodium lamp's own lens is the brightest thing on a
   * night street by an order of magnitude, and 2.8 is still under the bloom threshold
   * for anything but the fitting itself.
   */
  'sign.lit': { m: 'sign_emissive', o: {}, k: { emissiveIntensity: 2.8 } },
  /**
   * Lettered sign faces. The building-mounted fascia boards used to be an emissive
   * blank rectangle — a glowing panel with nothing written on it, which is worse than
   * no sign at all. This key resolves to the shared canvas atlas in
   * `props/signage.js`, so a fascia carries an actual shop name; the caller supplies
   * the atlas UVs on the quad. Not a recipe: see `signage: true` in Palette.get().
   */
  'sign.fascia': { m: 'painted_steel_chipped', o: {}, signage: true },
};

const FALLBACK = 'struct.concrete';

export class Palette {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map();
    this.owned = [];
    this.missing = new Set();
  }

  /** @returns {THREE.Material} never null */
  get(key) {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const spec = PALETTE[key] || PALETTE[FALLBACK];
    if (!PALETTE[key]) this.missing.add(key);
    if (spec.signage) {
      const m = this._signage();
      this.cache.set(key, m);
      return m;
    }
    let mat = null;
    try {
      const lib = this.ctx.materials;
      if (lib?.clone && (spec.tint !== undefined || spec.k)) {
        mat = lib.clone(spec.m, { ...spec.o, ...(spec.k || {}), color: spec.tint });
        this.owned.push(mat);
      } else if (lib?.get) {
        mat = lib.get(spec.m, spec.o);
      }
    } catch {
      mat = null;
    }
    if (!mat) {
      // The library is stubbed or threw: still render something with structure.
      mat = new THREE.MeshStandardMaterial({
        color: spec.tint ?? 0x9a948a,
        roughness: 0.85,
        metalness: 0.02,
        vertexColors: false,
      });
      this.owned.push(mat);
    }
    mat.name = mat.name || key;
    try {
      attachVertexAO(mat);
    } catch {
      /* AO is a nicety; never let it break the level */
    }
    this.cache.set(key, mat);
    return mat;
  }

  /**
   * The lettered sign face. A plain Standard material because MaterialLibrary owns
   * `map` on everything it builds and would overwrite the atlas with a tiling albedo;
   * every bit of wear, grime and chipped paint is painted into the canvas instead.
   * Aerial perspective is injected by hand so a fascia 60 m away hazes with the wall
   * it is bolted to.
   */
  _signage() {
    const { texture } = signageAtlas(this.ctx);
    const mat = new THREE.MeshStandardMaterial({
      name: 'sign.fascia',
      map: texture,
      // See props/materials.js signageMaterial(): white here clips the board to cream
      // under an 11-intensity sun and the lettering stops reading.
      color: 0xa9a59c,
      roughness: 0.72,
      metalness: 0.0,
      envMapIntensity: 0.4,
      dithering: true,
    });
    this.owned.push(mat);
    try {
      this.ctx.sky?.applyAerialPerspective?.(mat);
    } catch {
      /* nicety */
    }
    return mat;
  }

  /** The §5 surface tag for a palette key — drives bullets, footsteps and decals. */
  surface(key) {
    const spec = PALETTE[key] || PALETTE[FALLBACK];
    try {
      return this.ctx.materials?.surfaceTag?.(spec.m) || guessTag(spec.m);
    } catch {
      return guessTag(spec.m);
    }
  }

  dispose() {
    for (const m of this.owned) {
      try {
        m.dispose();
      } catch {
        /* best effort */
      }
    }
    this.owned.length = 0;
    this.cache.clear();
  }
}

function guessTag(name) {
  if (/glass/.test(name)) return 'glass';
  if (/water/.test(name)) return 'water';
  if (/steel|metal|alumin/.test(name)) return 'metal';
  if (/wood|ply/.test(name)) return 'wood';
  if (/tarp|canvas|sandbag|carpet/.test(name)) return 'fabric';
  if (/sand/.test(name)) return 'sand';
  if (/dirt|gravel/.test(name)) return 'dirt';
  if (/grass/.test(name)) return 'grass';
  if (/plaster|stucco|brick_painted/.test(name)) return 'plaster';
  if (/tile|marble/.test(name)) return 'ceramic';
  if (/rubber/.test(name)) return 'rubber';
  return 'concrete';
}

export default Palette;
