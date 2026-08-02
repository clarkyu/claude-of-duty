# Claude of Duty — Architecture Contract

**This file is the single source of truth for module boundaries. Read it fully before writing code.**

Multiple agents work on this repo in parallel. The ONLY way that works is strict file
ownership. Every module below is owned by exactly one agent. **Never edit a file you do
not own.** If you need something from another module, use its documented API. If the API
you need does not exist yet, code defensively against the stub contract (every stub is
already a working no-op that satisfies its interface).

---

## 1. Runtime shape

```
index.html  ->  src/main.js  ->  Engine  ->  [ System, System, System, ... ]
```

`src/core/Engine.js` owns the renderer, the frame loop, and a **service context** object
that is handed to every system. Systems are plain objects registered in
`src/core/manifest.js` (owned by the orchestrator — do not edit).

### System interface

Every module default-exports a factory: `(ctx) => System`.

```js
/** @returns {import('../core/types.js').System} */
export default function createThing(ctx) {
  return {
    name: 'thing',
    order: 100,            // lower runs first within a phase
    async init() {},       // may load/generate assets; awaited before first frame
    fixed(fdt) {},         // optional: fixed-step tick (physics), 1/120 s
    update(dt) {},         // per-frame, before render
    lateUpdate(dt) {},     // per-frame, after all update()s (camera-dependent work)
    resize(w, h) {},       // viewport changed
    dispose() {},
  };
}
```

Every callback is optional. Throwing from `init()` is caught and logged; the game keeps
booting so one broken subsystem never blanks the screen.

### The context object (`ctx`)

Read-only unless stated. Populated progressively — systems that fill a slot are noted.

| Field | Type | Filled by | Notes |
|---|---|---|---|
| `ctx.renderer` | `THREE.WebGLRenderer` | Engine | HDR, `outputColorSpace = SRGB`, no auto-clear |
| `ctx.scene` | `THREE.Scene` | Engine | the world |
| `ctx.camera` | `THREE.PerspectiveCamera` | Engine | world camera |
| `ctx.viewScene` | `THREE.Scene` | Engine | viewmodel-only scene, rendered with its own FOV |
| `ctx.viewCamera` | `THREE.PerspectiveCamera` | Engine | viewmodel camera (fov ~60, follows `ctx.camera`) |
| `ctx.settings` | `Settings` | Engine | quality tiers, see §4 |
| `ctx.bus` | `EventBus` | Engine | `on/off/emit`, see §3 |
| `ctx.time` | `{ elapsed, dt, frame, fixedAlpha }` | Engine | seconds |
| `ctx.input` | `Input` | Engine | keyboard/mouse/gamepad state |
| `ctx.rng` | `(…)=>number` | Engine | **seeded** deterministic RNG — use this, never `Math.random()` |
| `ctx.pipeline` | `RenderPipeline` | `render/RenderPipeline.js` | post chain; `.addPass()`, `.setQuality()` |
| `ctx.lighting` | `Lighting` | `render/Lighting.js` | `.sun`, `.envMap`, `.setTimeOfDay(t)` |
| `ctx.materials` | `MaterialLibrary` | `materials/MaterialLibrary.js` | `.get(name)` -> `THREE.Material` |
| `ctx.textures` | `TextureForge` | `materials/TextureForge.js` | `.pbr(name, opts)` -> `{map,normalMap,…}` |
| `ctx.level` | `Level` | `world/Level.js` | `.spawnPoints`, `.colliders`, `.query(...)` |
| `ctx.physics` | `PhysicsWorld` | `physics/PhysicsWorld.js` | see §5 |
| `ctx.ballistics` | `Ballistics` | `physics/Ballistics.js` | `.fire(origin, dir, weaponDef)` |
| `ctx.player` | `PlayerController` | `player/Controller.js` | `.position`, `.velocity`, `.state` |
| `ctx.weapons` | `WeaponSystem` | `weapons/WeaponSystem.js` | `.current`, `.equip(id)` |
| `ctx.fx` | `FXSystem` | `fx/FXSystem.js` | `.impact()`, `.tracer()`, `.muzzle()` |
| `ctx.audio` | `AudioEngine` | `audio/AudioEngine.js` | `.play(id, opts)` |
| `ctx.ai` | `AISystem` | `ai/AISystem.js` | `.bots`, `.spawn()` |
| `ctx.hud` | `HUD` | `ui/HUD.js` | DOM overlay |
| `ctx.game` | `GameMode` | `game/GameMode.js` | scoring, rounds |

**Defensive access is mandatory.** Another system may not have initialised yet:
`ctx.audio?.play('shot')`. Never assume ordering beyond `order`.

---

## 2. Units & conventions

- **1 unit = 1 metre.** Y is up. Eye height 1.7 m. Crouch eye 1.05 m.
- Angles in radians. Time in seconds. Damage in HP (player has 100).
- **Colour space:** all albedo/emissive textures `SRGBColorSpace`; normal/roughness/
  metalness/AO are `NoColorSpace` (linear). Getting this wrong is the #1 cause of
  "washed out / plasticky" renders.
- **Lighting is physical.** Sun ~ 8–12 intensity with `renderer.toneMapping = ACESFilmic`
  and `toneMappingExposure ~ 1.0`. Do not fake brightness by cranking material colours
  above 1.0 — use light intensity and exposure.
- Never call `Math.random()`. Use `ctx.rng()` so screenshots are reproducible.
- Never add a `THREE.Object3D` directly to `ctx.scene` in a hot loop — pool and reuse.

---

## 3. Events (`ctx.bus`)

Fire-and-forget. `bus.emit(name, payload)`, `bus.on(name, fn) -> unsubscribe`.

| Event | Payload | Emitted by |
|---|---|---|
| `weapon:fire` | `{weapon, origin, dir, ads}` | weapons |
| `weapon:reload` | `{weapon, stage}` | weapons |
| `weapon:equip` | `{weapon}` | weapons |
| `bullet:impact` | `{point, normal, surface, material, energy, entity}` | ballistics |
| `bullet:penetrate` | `{entryPoint, exitPoint, surface}` | ballistics |
| `entity:damage` | `{target, amount, hitbox, attacker, point, dir}` | ballistics/ai |
| `entity:death` | `{target, attacker, weapon, hitbox}` | game |
| `player:land` | `{impactSpeed}` | player |
| `player:step` | `{surface, speed}` | player |
| `player:state` | `{from, to}` | player |
| `explosion` | `{point, radius, damage}` | fx/physics |
| `hud:hitmarker` | `{lethal, headshot}` | game |
| `game:score` | `{team, delta, reason}` | game |
| `quality:changed` | `{tier}` | settings |

Add new events freely; document them in your module header comment.

---

## 4. Settings / quality tiers (`ctx.settings`)

`ctx.settings.get(key)` / `.set(key, v)` / `.tier` in `'low'|'medium'|'high'|'ultra'`.

Everything expensive MUST respond to `quality:changed` and degrade gracefully. The
CI screenshot harness runs on a **software rasteriser (SwiftShader)** — it is slow. Honour
`ctx.settings.get('headless')`: when true, prefer correctness over framerate but keep
per-frame cost sane (target < 20 s/frame at 1600×900).

Standard keys: `shadows`, `shadowCascades`, `shadowResolution`, `ssao`, `ssr`, `taa`,
`bloom`, `motionBlur`, `dof`, `volumetrics`, `particleBudget`, `decalBudget`,
`textureResolution`, `anisotropy`, `renderScale`.

---

## 5. Physics contract (`ctx.physics`)

Custom deterministic solver — no external engine (keeps the bundle lean and the sim
reproducible for screenshots).

```js
ctx.physics.addStatic(collider)                  // {type:'box'|'mesh'|'sphere'|'capsule', ...}
ctx.physics.addBody({shape, mass, pos, quat, material, group}) -> Body
ctx.physics.raycast(origin, dir, maxDist, mask) -> Hit | null
ctx.physics.sweepCapsule(from, to, radius, height, mask) -> Hit | null
ctx.physics.overlapSphere(center, radius, mask) -> Body[]
ctx.physics.applyImpulse(body, impulse, worldPoint)
```

`Hit = { point, normal, distance, body, surface, material, faceIndex, entity }`

**Surface tags** drive audio, decals and particles. Use exactly these strings:
`concrete, metal, wood, dirt, sand, grass, glass, water, fabric, flesh, rubber, plaster,
ceramic, foliage, snow`.

Collision groups (bitmask): `1 WORLD`, `2 PLAYER`, `4 AI`, `8 PROP`, `16 PROJECTILE`,
`32 TRIGGER`, `64 RAGDOLL`, `128 VIEWMODEL`.

---

## 6. Screenshot / review harness

```
npm run build          # must always pass — a broken build blocks every other agent
npm run shoot          # renders the review pose set to shots/
node tools/shoot.mjs --pose hero --w 1920 --h 1080 --out shots/hero.png
node tools/check.mjs   # boot smoke test: asserts no console errors, reports frame budget
```

Poses live in `tools/poses.js` (orchestrator-owned). Each pose is a camera transform plus
a game-state setup string. **Your work is judged from these screenshots**, so if your
subsystem needs a dedicated viewpoint, ask the orchestrator to add a pose — do not edit
`poses.js` yourself.

The page exposes a debug API used by the harness:

```js
window.__COD.ready          // Promise, resolves when init() of every system is done
window.__COD.applyPose(p)   // {pos:[x,y,z], look:[x,y,z], fov, state:{...}}
window.__COD.step(n, dt)    // advance the sim n deterministic frames
window.__COD.frame()        // render exactly one frame, resolves after GPU flush
window.__COD.stats()        // {drawCalls, tris, programs, ms, memory}
```

Register anything you need to pose (weapon equipped, bot placement, time of day) through
`ctx.bus.on('debug:pose', fn)` — the harness emits it with the pose's `state` object.

---

## 7. Quality bar

The target is *Call of Duty: Modern Warfare III / Black Ops 6* fidelity, in a browser. In
practice, that means:

- **No flat colours.** Every surface gets albedo variation, normal detail, roughness
  variation and AO. A single-colour `MeshStandardMaterial` is an automatic fail.
- **Grounded contact.** Contact shadows / AO at every mesh-to-mesh junction. Objects that
  look like they're floating are the fastest way to read as "hobby project".
- **Physically-plausible light.** Bounce/ambient must come from an IBL environment, not a
  flat `AmbientLight`. Shadows are soft and cascade with distance.
- **Wear and story.** Edge wear, grime in crevices, water stains, chipped paint, scuffs,
  rust streaks below metal, dust accumulation on up-facing surfaces.
- **Camera realism.** Slight lens imperfection: subtle chromatic aberration at the edges,
  filmic vignette, sensor grain, bloom only on genuinely bright pixels.
- **Motion.** Nothing static-looking: foliage sways, dust motes drift, cloth ripples,
  lights flicker imperceptibly, the viewmodel is never locked to the camera.
- **60 fps on a real GPU** at 1080p on `high`. Instance everything, LOD everything.

---

## 8. Coding standards

- ES modules, no build-time transpile beyond Vite's default.
- No new runtime dependencies without orchestrator approval. `three` only.
- Shaders live in the module that owns them, as template-literal strings with a
  `// language=GLSL` comment for editor support.
- Dispose everything you create in `dispose()`.
- Keep a header comment in every file: purpose, owner, public API, events emitted.
- Prefer `const`/`let`, no `var`. Prefer small pure helpers.
