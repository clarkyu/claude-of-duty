// Is the slow part the frame, or the screenshot?
// The bisector says a 1280x720 frame costs 2.9s, yet page.screenshot() blows a 300s
// cap on the same page. Those cannot both be about rendering the scene, so time the
// capture path itself, with and without the DOM overlay, and against a direct
// canvas readback that bypasses Chrome's compositor entirely.
import { appendFileSync, writeFileSync } from 'node:fs';
import { serve, launch, bootGame, build } from './harness.mjs';

const LOG = '/home/user/claude-of-duty/shots/shottest.log';
writeFileSync(LOG, '');
const say = (l) => {
  console.log(l);
  appendFileSync(LOG, l + '\n');
};

const port = 8600 + Math.floor(Math.random() * 200);
const b = await build({ outDir: 'dist-st' });
if (!b.ok) {
  say('BUILD FAIL');
  process.exit(1);
}
const server = await serve(port, 'dist-st');
const { browser, page } = await launch({ width: 1280, height: 720 });

const timeIt = async (label, fn) => {
  const t = Date.now();
  let note = '';
  try {
    note = (await fn()) || '';
  } catch (e) {
    note = 'FAILED: ' + e.message.slice(0, 80);
  }
  say(`  ${label.padEnd(34)} ${String(Date.now() - t).padStart(7)} ms  ${note}`);
};

try {
  const t0 = Date.now();
  await bootGame(page, server.url, { quality: 'medium' });
  say(`boot ${((Date.now() - t0) / 1000).toFixed(0)}s @ medium 1280x720`);

  await page.evaluate(() => window.__COD.applyPose(window.__COD.ctx.THREE ? {} : {}));
  await page.evaluate(() => window.__COD.step(4, 1 / 60));

  say('\n--- capture path timings ---');
  await timeIt('engine.tick x1 (render only)', () => page.evaluate(() => window.__COD.step(1, 1 / 60)));
  await timeIt('canvas.toDataURL (no compositor)', async () => {
    const len = await page.evaluate(
      () => document.getElementById('viewport').toDataURL('image/png').length
    );
    return `${(len / 1024).toFixed(0)} KB`;
  });
  await timeIt('page.screenshot, HUD visible', () =>
    page.screenshot({ path: '/tmp/st_hud.png', timeout: 240000 })
  );

  await page.evaluate(() => {
    const r = document.getElementById('ui-root');
    if (r) r.style.display = 'none';
  });
  await timeIt('page.screenshot, HUD hidden', () =>
    page.screenshot({ path: '/tmp/st_nohud.png', timeout: 240000 })
  );

  await page.evaluate(() => {
    const r = document.getElementById('ui-root');
    if (r) r.style.display = '';
  });
  await timeIt('page.screenshot, clip to viewport', () =>
    page.screenshot({ path: '/tmp/st_clip.png', timeout: 240000, clip: { x: 0, y: 0, width: 1280, height: 720 } })
  );
  await timeIt('page.screenshot, 2nd call (warm)', () =>
    page.screenshot({ path: '/tmp/st_warm.png', timeout: 240000 })
  );

  // What does the overlay actually contain that could cost this much?
  const css = await page.evaluate(() => {
    const out = { filter: 0, backdrop: 0, blur: 0, shadow: 0, gradient: 0, nodes: 0, canvases: 0 };
    const root = document.getElementById('ui-root');
    if (!root) return out;
    const all = root.querySelectorAll('*');
    out.nodes = all.length;
    out.canvases = root.querySelectorAll('canvas').length;
    for (const el of all) {
      const s = getComputedStyle(el);
      if (s.filter && s.filter !== 'none') out.filter++;
      if (s.backdropFilter && s.backdropFilter !== 'none') out.backdrop++;
      if ((s.filter || '').includes('blur') || (s.backdropFilter || '').includes('blur')) out.blur++;
      if (s.boxShadow && s.boxShadow !== 'none') out.shadow++;
      if ((s.backgroundImage || '').includes('gradient')) out.gradient++;
    }
    return out;
  });
  say(`\noverlay: ${css.nodes} nodes, ${css.canvases} canvas, filter ${css.filter}, backdrop-filter ${css.backdrop}, blur ${css.blur}, box-shadow ${css.shadow}, gradient ${css.gradient}`);
} finally {
  await browser.close().catch(() => {});
  server.stop();
}
