// One-shot scaffolder: writes a working no-op stub for every manifest slot that
// does not exist yet. Safe to re-run — never overwrites a real implementation.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const MODULES = [
  ['materials/TextureForge.js', 'textures', 10, 'ctx.textures', 'Procedural PBR texture generation'],
  ['materials/MaterialLibrary.js', 'materials', 12, 'ctx.materials', 'Shared material definitions'],
  ['render/RenderPipeline.js', 'pipeline', 20, 'ctx.pipeline', 'HDR render graph + post FX'],
  ['render/Sky.js', 'sky', 22, 'ctx.sky', 'Physical sky, clouds, celestial bodies'],
  ['render/Lighting.js', 'lighting', 24, 'ctx.lighting', 'Sun, CSM shadows, IBL, local lights'],
  ['render/Weather.js', 'weather', 26, 'ctx.weather', 'Rain, wind, fog, wetness'],
  ['physics/PhysicsWorld.js', 'physics', 30, 'ctx.physics', 'Rigid bodies, collision, ragdolls'],
  ['world/Level.js', 'level', 32, 'ctx.level', 'Map geometry and collision'],
  ['world/Props.js', 'props', 34, 'ctx.props', 'Set dressing and clutter'],
  ['world/Foliage.js', 'foliage', 36, 'ctx.foliage', 'Instanced vegetation'],
  ['world/Destruction.js', 'destruction', 38, 'ctx.destruction', 'Breakable geometry'],
  ['fx/FXSystem.js', 'fx', 40, 'ctx.fx', 'GPU particles, tracers, impacts'],
  ['fx/Decals.js', 'decals', 42, 'ctx.decals', 'Bullet holes and surface marks'],
  ['physics/Ballistics.js', 'ballistics', 44, 'ctx.ballistics', 'Projectile simulation'],
  ['audio/AudioEngine.js', 'audio', 50, 'ctx.audio', 'Spatial WebAudio mixer'],
  ['player/Controller.js', 'player', 60, 'ctx.player', 'FPS movement'],
  ['player/CameraRig.js', 'cameraRig', 62, 'ctx.cameraRig', 'Camera feel and shake'],
  ['weapons/WeaponSystem.js', 'weapons', 70, 'ctx.weapons', 'Viewmodel and gunplay'],
  ['ai/AISystem.js', 'ai', 80, 'ctx.ai', 'Enemy bots'],
  ['game/GameMode.js', 'game', 90, 'ctx.game', 'Rules and scoring'],
  ['ui/HUD.js', 'hud', 95, 'ctx.hud', 'In-game overlay'],
  ['ui/Menu.js', 'menu', 97, 'ctx.menu', 'Front end'],
];

let made = 0;
for (const [path, name, order, slot, purpose] of MODULES) {
  const full = resolve(ROOT, 'src', path);
  if (existsSync(full)) continue;
  mkdirSync(dirname(full), { recursive: true });
  const fn = 'create' + path.split('/').pop().replace('.js', '');
  writeFileSync(
    full,
    `/**
 * ${purpose}.
 * STUB — replace with a real implementation. See docs/ARCHITECTURE.md.
 * Publishes: ${slot}
 */
export default function ${fn}(ctx) {
  const api = { ready: false };
  return {
    name: '${name}',
    order: ${order},
    async init() {
      ${slot} = api;
    },
    update(_dt) {},
    dispose() {},
  };
}
`
  );
  made++;
}
console.log(`wrote ${made} stubs`);
