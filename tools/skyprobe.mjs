// Attribute the multi-second frame spikes. Everything else has been ruled out by
// measurement: shader compilation (program count flat across spikes), the
// screenshot path (sub-second), the DOM overlay (149ms), the Lighting IBL
// rebuild (budgeted, spikes unchanged). Sky is what is left, so time its methods
// from inside the page and print a per-frame breakdown.
import { appendFileSync, writeFileSync } from 'node:fs';
import { serve, launch, bootGame, build } from './harness.mjs';
const LOG = '/home/user/claude-of-duty/shots/skyprobe.log';
writeFileSync(LOG, '');
const say = (l) => { console.log(l); appendFileSync(LOG, l + '\n'); };
const port = 8800 + Math.floor(Math.random() * 150);
const b = await build({ outDir: 'dist-sp' });
if (!b.ok) { say('BUILD FAIL'); process.exit(1); }
const server = await serve(port, 'dist-sp');
const { browser, page } = await launch({ width: 1280, height: 720 });
try {
  await bootGame(page, server.url, { quality: 'medium' });
  say('instrumenting sky + pipeline + lighting');
  await page.evaluate(() => {
    const acc = (window.__ACC = {});
    const wrap = (obj, name, label) => {
      if (!obj || typeof obj[name] !== 'function') return false;
      const f = obj[name].bind(obj);
      acc[label] = 0;
      obj[name] = (...a) => {
        const t = performance.now();
        const r = f(...a);
        acc[label] += performance.now() - t;
        return r;
      };
      return true;
    };
    const c = window.__COD.ctx;
    const sysOf = (n) => window.__COD.engine.systems.find((s) => s.name === n);
    window.__WRAPPED = {
      skyLate: wrap(sysOf('sky'), 'lateUpdate', 'sky.lateUpdate'),
      skyUpd: wrap(sysOf('sky'), 'update', 'sky.update'),
      clouds: wrap(c.sky, '_renderClouds', 'sky._renderClouds'),
      skyEnv: wrap(c.sky, '_updateEnvironment', 'sky._updateEnvironment'),
      ibl: wrap(c.lighting, '_rebuildIBL', 'lighting._rebuildIBL'),
      probes: wrap(sysOf('lighting'), 'update', 'lighting.update'),
      pipe: wrap(c.pipeline, 'render', 'pipeline.render'),
    };
  });
  say(JSON.stringify(await page.evaluate(() => window.__WRAPPED)));
  say('\nframe    total   ' + 'breakdown (ms)');
  for (let i = 1; i <= 12; i++) {
    await page.evaluate(() => { for (const k in window.__ACC) window.__ACC[k] = 0; });
    const t = Date.now();
    await page.evaluate(() => window.__COD.step(1, 1 / 60));
    const total = Date.now() - t;
    const acc = await page.evaluate(() => window.__ACC);
    const parts = Object.entries(acc)
      .filter(([, v]) => v > 40)
      .map(([k, v]) => `${k}=${v.toFixed(0)}`)
      .join('  ');
    say(`${String(i).padStart(5)} ${String(total).padStart(8)}   ${parts || '(all under 40ms)'}`);
  }
} finally { await browser.close().catch(() => {}); server.stop(); }
