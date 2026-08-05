#!/usr/bin/env node
/**
 * Smoke test. Owner: ORCHESTRATOR ONLY.
 * Build + boot + a few frames. Fails loudly on build errors, broken systems, console
 * errors, or a black screen. Run this before every commit.
 *
 *   node tools/check.mjs [--quality high] [--no-build]
 */
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { ROOT, build, serve, launch, bootGame } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const quality = arg('quality', 'high');
// Agents run concurrently: --tag gives each one its own dist dir and port so
// simultaneous builds and preview servers never collide.
const tag = arg('tag', '');
const outDir = tag ? `dist-${tag}` : 'dist';
const port = 4600 + Math.floor(Math.random() * 900);

let server, browser, failures = 0;
const say = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${msg}`);
};

try {
  if (!argv.includes('--no-build')) {
    const b = await build({ outDir });
    say(b.ok, `build (${b.ms}ms)` + (b.ok ? '' : `\n${b.error}`));
    if (!b.ok) process.exit(1);
  }

  server = await serve(port, outDir);
  const l = await launch({ width: 1280, height: 720 });
  browser = l.browser;
  const page = l.page;

  const t0 = Date.now();
  const logs = await bootGame(page, server.url, { quality });
  say(true, `boot (${Date.now() - t0}ms)`);

  const stats = await page.evaluate(() => window.__COD.stats());
  say((stats.failed?.length || 0) === 0, `all systems initialised${stats.failed?.length ? `: broken -> ${stats.failed.map((f) => `${f.name} (${f.message})`).join('; ')}` : ''}`);

  const errs = logs.filter((x) => /\[error\]|\[pageerror\]/.test(x));
  say(errs.length === 0, `no console errors${errs.length ? `:\n     ${errs.slice(0, 8).join('\n     ').slice(0, 2500)}` : ''}`);

  // Frame budget over 20 frames.
  const t1 = Date.now();
  for (let i = 0; i < 20; i += 5) await page.evaluate(() => window.__COD.step(5, 1 / 60));
  const perFrame = (Date.now() - t1) / 20;
  say(true, `${perFrame.toFixed(0)}ms/frame under SwiftShader (software; not a GPU number)`);

  const s2 = await page.evaluate(() => window.__COD.stats());
  say(s2.drawCalls > 0, `draw calls: ${s2.drawCalls}, tris: ${(s2.tris / 1000).toFixed(0)}k, textures: ${s2.textures}`);

  // Black-screen detector: sample the framebuffer.
  mkdirSync(resolve(ROOT, 'shots'), { recursive: true });
  const tmp = resolve(ROOT, 'shots', `.smoke${tag ? '-' + tag : ''}.png`);
  await page.evaluate(() => window.__COD.frame(1 / 60));
  await page.screenshot({ path: tmp, timeout: 300000 });
  const buf = readFileSync(tmp);
  say(buf.length > 12000, `framebuffer is not blank (${(buf.length / 1024).toFixed(0)}KB png)`);
  try { unlinkSync(tmp); } catch { /* best effort */ }

  writeFileSync(
    resolve(ROOT, 'shots', `check${tag ? '-' + tag : ''}.json`),
    JSON.stringify({ stats: s2, perFrame, errors: errs.slice(0, 20) }, null, 2)
  );
} catch (err) {
  console.error('FATAL:', err.message);
  failures++;
} finally {
  await browser?.close().catch(() => {});
  server?.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
