// Corrected bisector. Orchestrator-owned.
//
// The first version resized the viewport after booting at 320x180 and reported
// 2873ms at 1280x720. Booting natively at 1280x720 gives 18080ms for the same
// frame — a 6x discrepancy — because the render targets were never reallocated,
// so it was still rendering at the small size and only the blit grew. Both its
// numbers and its FILL-vs-CPU verdict were therefore worthless.
//
// This one boots natively at whatever size it is given and never resizes.
// Run it twice at different sizes to answer fill-vs-CPU honestly.
//
//   node tools/bisect2.mjs 640 360 medium
import { appendFileSync, writeFileSync } from 'node:fs';
import { serve, launch, bootGame, build } from './harness.mjs';

const W = Number(process.argv[2] || 640);
const H = Number(process.argv[3] || 360);
const QUALITY = process.argv[4] || 'medium';
const LOG = `/home/user/claude-of-duty/shots/bisect-${W}x${H}-${QUALITY}.log`;
writeFileSync(LOG, '');
const say = (l) => {
  console.log(l);
  appendFileSync(LOG, l + '\n');
};

// Chrome refuses a set of "unsafe ports" (5060/5061 among them).
const port = 8300 + Math.floor(Math.random() * 300);
const b = await build({ outDir: `dist-b2` });
if (!b.ok) {
  say('BUILD FAIL\n' + b.error);
  process.exit(1);
}
const server = await serve(port, 'dist-b2');
const { browser, page } = await launch({ width: W, height: H });

const time = async (n = 1) => {
  const t = Date.now();
  await page.evaluate((k) => window.__COD.step(k, 1 / 60), n);
  return (Date.now() - t) / n;
};

try {
  const t0 = Date.now();
  await bootGame(page, server.url, { quality: QUALITY });
  say(`boot ${((Date.now() - t0) / 1000).toFixed(0)}s  |  native ${W}x${H} @ ${QUALITY}  |  ${W * H} px`);
  await page.evaluate(() => window.__COD.step(2, 1 / 60));

  const base = await time(2);
  say(`BASELINE ${base.toFixed(0)} ms/frame\n`);

  say('--- disable one system at a time (ms saved) ---');
  const names = await page.evaluate(() =>
    window.__COD.engine.systems.map((s) => s.name).filter((n) => n !== 'debug')
  );
  const rows = [];
  for (const n of names) {
    await page.evaluate((x) => {
      const s = window.__COD.engine.systems.find((y) => y.name === x);
      if (s) s._broken = true;
    }, n);
    await page.evaluate(() => window.__COD.step(1, 1 / 60)); // settle
    const ms = await time(2);
    await page.evaluate((x) => {
      const s = window.__COD.engine.systems.find((y) => y.name === x);
      if (s) s._broken = false;
    }, n);
    await page.evaluate(() => window.__COD.step(1, 1 / 60));
    rows.push([n, base - ms]);
    say(`  ${n.padEnd(13)} ${(base - ms).toFixed(0).padStart(8)}`);
  }

  say('\n--- ranked ---');
  for (const [n, s] of rows.sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    say(`  ${n.padEnd(13)} ${s.toFixed(0).padStart(8)} ms  (${((s / base) * 100).toFixed(0)}%)`);
  }

  const st = await page.evaluate(() => window.__COD.stats());
  say(`\ndraws ${st.drawCalls}, tris ${(st.tris / 1000).toFixed(0)}k, textures ${st.textures}, programs ${st.programs}`);
} finally {
  await browser.close().catch(() => {});
  server.stop();
}
