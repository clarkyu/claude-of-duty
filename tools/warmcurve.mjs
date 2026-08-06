// Does frame cost decay? SwiftShader JIT-compiles each shader variant to machine
// code on first use, and this build has 235 programs. If the cost is compilation
// rather than steady-state rendering, frame N gets dramatically cheaper than
// frame 1 and the fix is warming, not optimisation.
import { appendFileSync, writeFileSync } from 'node:fs';
import { serve, launch, bootGame, build } from './harness.mjs';
const LOG = '/home/user/claude-of-duty/shots/warmcurve.log';
writeFileSync(LOG, '');
const say = (l) => { console.log(l); appendFileSync(LOG, l + '\n'); };
const port = 8700 + Math.floor(Math.random() * 200);
const b = await build({ outDir: 'dist-wc' });
if (!b.ok) { say('BUILD FAIL'); process.exit(1); }
const server = await serve(port, 'dist-wc');
const { browser, page } = await launch({ width: 1280, height: 720 });
try {
  const t0 = Date.now();
  await bootGame(page, server.url, { quality: 'medium' });
  say(`boot ${((Date.now() - t0) / 1000).toFixed(0)}s @ medium 1280x720`);
  say('\nframe   ms   programs');
  for (let i = 1; i <= 16; i++) {
    const t = Date.now();
    await page.evaluate(() => window.__COD.step(1, 1 / 60));
    const p = await page.evaluate(() => window.__COD.stats().programs);
    say(`${String(i).padStart(5)} ${String(Date.now() - t).padStart(6)} ${String(p).padStart(10)}`);
  }
  say('\n-- now apply the hero pose (new state -> possible new variants) --');
  const { POSES } = await import('./poses.js');
  await page.evaluate((p) => window.__COD.applyPose(p), POSES.hero);
  for (let i = 1; i <= 8; i++) {
    const t = Date.now();
    await page.evaluate(() => window.__COD.step(1, 1 / 60));
    const p = await page.evaluate(() => window.__COD.stats().programs);
    say(`${String(i).padStart(5)} ${String(Date.now() - t).padStart(6)} ${String(p).padStart(10)}`);
  }
} finally { await browser.close().catch(() => {}); server.stop(); }
