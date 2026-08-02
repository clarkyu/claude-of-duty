/**
 * Bootstrap. Owner: ORCHESTRATOR ONLY.
 * Reads URL params for the harness, builds the Engine, boots the manifest, starts.
 *
 *   ?headless=1   deterministic mode: no autoplay audio, paused loop, fixed seed
 *   ?quality=ultra|high|medium|low
 *   ?seed=12345
 *   ?scale=1      render scale override
 */
import { Engine } from './core/Engine.js';
import MANIFEST from './core/manifest.js';

const params = new URLSearchParams(location.search);
const headless = params.get('headless') === '1';
const quality = params.get('quality') || 'high';
const seed = Number(params.get('seed') || 0x5eed1234);

const canvas = document.getElementById('viewport');
const boot = document.getElementById('boot');
const bootBar = document.getElementById('boot-bar');
const bootLabel = document.getElementById('boot-label');

const engine = new Engine(canvas, {
  seed,
  settings: { headless, exposure: 1.0 },
});
engine.settings.setTier(quality);
if (headless) {
  engine.settings.set('headless', true);
  engine.settings.set('maxPixelRatio', 1);
}
if (params.get('scale')) engine.settings.set('renderScale', Number(params.get('scale')));

engine.bus.on('boot:progress', ({ name, done, total }) => {
  if (bootBar) bootBar.style.width = `${Math.round((done / total) * 100)}%`;
  if (bootLabel) bootLabel.textContent = name.toUpperCase();
});

window.__ENGINE = engine;

(async () => {
  const t0 = performance.now();
  await engine.boot(MANIFEST);
  const bootMs = performance.now() - t0;
  console.log(`[boot] ${bootMs.toFixed(0)}ms, ${engine.systems.length} systems`);

  if (boot) {
    boot.classList.add('done');
    setTimeout(() => boot.remove(), 900);
  }

  // Prime shader compilation so the first real frame doesn't hitch.
  try {
    engine.renderer.compile(engine.scene, engine.camera);
  } catch {
    /* compile() is an optimisation, never fatal */
  }

  if (headless) {
    // The harness owns the clock: render one frame so there is something on
    // screen, then wait for __COD.step()/frame() calls.
    engine.tick(1 / 60);
  } else {
    engine.start();
  }
  window.__BOOTED = true;
})();
