// Minimal frame-cost bisector. Orchestrator-owned.
// First question is always the same: does cost scale with pixel count (fill-bound)
// or stay flat (CPU-bound)? Everything else follows from the answer, so measure that
// before touching a single suspect.
import { serve, launch, bootGame, build } from './harness.mjs';

const QUALITY = process.argv[2] || 'medium';
const port = 4990 + Math.floor(Math.random() * 90);

const b = await build({ outDir: 'dist-bis' });
if (!b.ok) {
  console.error(b.error);
  process.exit(1);
}
const server = await serve(port, 'dist-bis');
const { browser, page } = await launch({ width: 320, height: 180 });

const time = async (n = 2) => {
  const t = Date.now();
  await page.evaluate((k) => window.__COD.step(k, 1 / 60), n);
  return (Date.now() - t) / n;
};

try {
  const t0 = Date.now();
  await bootGame(page, server.url, { quality: QUALITY });
  console.log(`boot ${((Date.now() - t0) / 1000).toFixed(0)}s @ ${QUALITY}`);
  await page.evaluate(() => window.__COD.step(2, 1 / 60));

  console.log('\n--- fill-bound or CPU-bound? ---');
  const sizes = [
    [320, 180],
    [640, 360],
    [1280, 720],
  ];
  const costs = [];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(() => window.__COD.step(1, 1 / 60));
    const ms = await time(2);
    costs.push(ms);
    console.log(`  ${String(w).padStart(4)}x${String(h).padStart(3)}  ${ms.toFixed(0).padStart(7)} ms/frame`);
  }
  const pixRatio = (1280 * 720) / (320 * 180);
  const costRatio = costs[2] / costs[0];
  console.log(
    `  pixels x${pixRatio}, cost x${costRatio.toFixed(1)} -> ${
      costRatio > pixRatio * 0.5 ? 'FILL-BOUND' : costRatio < 2 ? 'CPU-BOUND' : 'MIXED'
    }`
  );

  // Back to the small viewport so the bisection below is affordable.
  await page.setViewportSize({ width: 320, height: 180 });
  await page.evaluate(() => window.__COD.step(1, 1 / 60));
  const base = await time(2);
  console.log(`\nbaseline @320x180: ${base.toFixed(0)} ms/frame`);

  console.log('\n--- per-system CPU (ms/frame) ---');
  const cpu = await page.evaluate(() => {
    const e = window.__COD.engine;
    const acc = {};
    const ph = ['fixed', 'update', 'lateUpdate'];
    const saved = e.systems.map((s) => ({ s, f: ph.map((p) => s[p]) }));
    for (const s of e.systems) {
      acc[s.name] = 0;
      for (const p of ph) {
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
    for (let i = 0; i < 2; i++) e.tick(1 / 60);
    saved.forEach(({ s, f }) => ph.forEach((p, i) => f[i] && (s[p] = f[i])));
    return Object.entries(acc)
      .map(([n, ms]) => [n, +(ms / 2).toFixed(1)])
      .sort((a, b) => b[1] - a[1])
      .filter(([, ms]) => ms > 1);
  });
  for (const [n, ms] of cpu) console.log(`  ${n.padEnd(13)} ${String(ms).padStart(8)}`);

  console.log('\n--- system disable delta (ms saved, >5% only) ---');
  const names = await page.evaluate(() =>
    window.__COD.engine.systems.map((s) => s.name).filter((n) => n !== 'debug')
  );
  for (const n of names) {
    await page.evaluate((x) => {
      const s = window.__COD.engine.systems.find((y) => y.name === x);
      if (s) s._broken = true;
    }, n);
    const ms = await time(1);
    await page.evaluate((x) => {
      const s = window.__COD.engine.systems.find((y) => y.name === x);
      if (s) s._broken = false;
    }, n);
    const saved = base - ms;
    if (saved > base * 0.05) console.log(`  ${n.padEnd(13)} ${saved.toFixed(0).padStart(8)}`);
  }

  console.log('\n--- post pass delta (ms saved, >5% only) ---');
  const passes = await page.evaluate(() => {
    const p = window.__COD.ctx.pipeline;
    if (!p) return [];
    if (typeof p.passNames === 'function') return p.passNames();
    const list = p.passes;
    if (Array.isArray(list)) return list.map((x) => x?.name).filter(Boolean);
    if (list && typeof list.keys === 'function') return [...list.keys()];
    return [];
  });
  console.log(`  (${passes.length} passes exposed)`);
  for (const nm of passes) {
    await page.evaluate((x) => window.__COD.togglePass(x, false), nm);
    const ms = await time(1);
    await page.evaluate((x) => window.__COD.togglePass(x, true), nm);
    const saved = base - ms;
    if (saved > base * 0.05) console.log(`  ${String(nm).padEnd(18)} ${saved.toFixed(0).padStart(7)}`);
  }

  const st = await page.evaluate(() => window.__COD.stats());
  console.log(`\ndraws ${st.drawCalls}, tris ${(st.tris / 1000).toFixed(0)}k, textures ${st.textures}`);
} finally {
  await browser.close().catch(() => {});
  server.stop();
}
