// Per-pass / per-system frame cost profiler. Orchestrator-owned, throwaway-friendly.
// Boots once at a small resolution so `high` tier frames are affordable, then measures
// relative cost by disabling one thing at a time. Fill-bound costs scale with pixel
// count, so the ranking transfers to full resolution even though absolute ms do not.
import { serve, launch, bootGame, build } from './harness.mjs';

const W = Number(process.argv[2] || 640);
const H = Number(process.argv[3] || 360);
const QUALITY = process.argv[4] || 'high';
const port = 4900 + Math.floor(Math.random() * 90);

const b = await build({ outDir: 'dist-prof' });
if (!b.ok) {
  console.error(b.error);
  process.exit(1);
}
const server = await serve(port, 'dist-prof');
const { browser, page } = await launch({ width: W, height: H });

try {
  console.log(`booting ${QUALITY} @ ${W}x${H}…`);
  const t0 = Date.now();
  await bootGame(page, server.url, { quality: QUALITY });
  console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  // Warm up so lazy allocation and shader compiles are not counted.
  await page.evaluate(() => window.__COD.step(3, 1 / 60));

  const timeFrames = async (n = 3) => {
    const t = Date.now();
    await page.evaluate((k) => window.__COD.step(k, 1 / 60), n);
    return (Date.now() - t) / n;
  };

  const baseline = await timeFrames(3);
  console.log(`BASELINE: ${baseline.toFixed(0)} ms/frame\n`);

  // 1. Per-system CPU cost, measured inside the page.
  const sys = await page.evaluate(() => {
    const e = window.__COD.engine;
    const acc = {};
    const phases = ['fixed', 'update', 'lateUpdate'];
    const orig = e.systems.map((s) => ({ s, fns: phases.map((p) => s[p]) }));
    for (const s of e.systems) {
      acc[s.name] = 0;
      for (const p of phases) {
        const f = s[p];
        if (!f) continue;
        s[p] = function (dt) {
          const t = performance.now();
          const r = f.call(this, dt);
          acc[s.name] += performance.now() - t;
          return r;
        };
      }
    }
    for (let i = 0; i < 3; i++) e.tick(1 / 60);
    orig.forEach(({ s, fns }) => phases.forEach((p, i) => (fns[i] ? (s[p] = fns[i]) : 0)));
    return Object.entries(acc)
      .map(([name, ms]) => ({ name, ms: +(ms / 3).toFixed(1) }))
      .sort((a, b) => b.ms - a.ms)
      .filter((x) => x.ms > 0.2);
  });
  console.log('PER-SYSTEM CPU (ms/frame, >0.2 only):');
  for (const s of sys) console.log(`  ${s.name.padEnd(14)} ${String(s.ms).padStart(8)}`);

  // 2. Cost of each system's whole contribution, by skipping it entirely.
  //    The engine already honours _broken as "skip this system".
  const names = await page.evaluate(() =>
    window.__COD.engine.systems.map((s) => s.name).filter((n) => n !== 'debug')
  );
  console.log('\nSYSTEM DISABLE DELTA (ms saved when skipped):');
  const deltas = [];
  for (const n of names) {
    await page.evaluate((name) => {
      const s = window.__COD.engine.systems.find((x) => x.name === name);
      if (s) s._broken = true;
    }, n);
    const ms = await timeFrames(2);
    await page.evaluate((name) => {
      const s = window.__COD.engine.systems.find((x) => x.name === name);
      if (s) s._broken = false;
    }, n);
    const saved = baseline - ms;
    deltas.push({ n, saved });
    if (saved > baseline * 0.03) console.log(`  ${n.padEnd(14)} ${saved.toFixed(0).padStart(7)} ms`);
  }

  // 3. Post-processing passes.
  const passes = await page.evaluate(() => {
    const p = window.__COD.ctx.pipeline;
    if (!p) return [];
    if (p.passNames) return p.passNames();
    if (p.passes) return (Array.isArray(p.passes) ? p.passes : [...p.passes.keys?.() || []])
      .map((x) => x?.name || x)
      .filter(Boolean);
    return [];
  });
  if (passes.length) {
    console.log('\nPOST PASS DELTA (ms saved when disabled):');
    for (const nm of passes) {
      await page.evaluate((n) => window.__COD.togglePass(n, false), nm);
      const ms = await timeFrames(2);
      await page.evaluate((n) => window.__COD.togglePass(n, true), nm);
      const saved = baseline - ms;
      if (saved > baseline * 0.02) console.log(`  ${String(nm).padEnd(18)} ${saved.toFixed(0).padStart(7)} ms`);
    }
  } else {
    console.log('\n(pipeline exposes no pass list; skipping pass bisection)');
  }

  // 4. Quality tiers for reference.
  console.log('\nTIER COST:');
  for (const t of ['low', 'medium', 'high', 'ultra']) {
    await page.evaluate((q) => window.__COD.setQuality(q), t);
    await page.evaluate(() => window.__COD.step(2, 1 / 60));
    console.log(`  ${t.padEnd(8)} ${(await timeFrames(2)).toFixed(0).padStart(8)} ms/frame`);
  }

  const stats = await page.evaluate(() => window.__COD.stats());
  console.log(`\ndraw calls ${stats.drawCalls}, tris ${(stats.tris / 1000).toFixed(0)}k, textures ${stats.textures}`);
} finally {
  await browser.close().catch(() => {});
  server.stop();
}
