#!/usr/bin/env node
/**
 * Screenshot runner. Owner: ORCHESTRATOR ONLY.
 *
 *   node tools/shoot.mjs                       # every pose at 1600x900 -> shots/
 *   node tools/shoot.mjs --pose hero,vista     # a subset
 *   node tools/shoot.mjs --w 1920 --h 1080 --quality ultra --out shots/final
 *   node tools/shoot.mjs --no-build            # reuse the existing dist/
 *
 * Exit code is non-zero if the build fails or the game never boots, so agents can
 * gate on it.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { POSES, DEFAULT_SET } from './poses.js';
import { ROOT, build, serve, launch, bootGame, capture } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const width = Number(arg('w', 1600));
const height = Number(arg('h', 900));
const quality = arg('quality', 'high');
const outDir = resolve(ROOT, arg('out', 'shots'));
const tag = arg('tag', '');
const outDir2 = tag ? `dist-${tag}` : 'dist';
const port = Number(arg('port', 4173 + Math.floor(Math.random() * 400)));
const names = (arg('pose', DEFAULT_SET.join(',')) || '').split(',').filter((n) => POSES[n]);
const warmOverride = arg('warm', null);

if (!names.length) {
  console.error(`no valid poses. available: ${Object.keys(POSES).join(', ')}`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

let server, browser;
const report = { quality, width, height, poses: {}, build: null, bootLogs: [], ok: false };

try {
  if (!flag('no-build')) {
    process.stdout.write('building… ');
    const b = await build({ outDir: outDir2 });
    report.build = b;
    if (!b.ok) {
      console.error(`\nBUILD FAILED\n${b.error}`);
      writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
      process.exit(1);
    }
    console.log(`ok (${b.ms}ms)`);
  }

  server = await serve(port, outDir2);
  const l = await launch({ width, height });
  browser = l.browser;
  const page = l.page;

  process.stdout.write('booting game… ');
  const t0 = Date.now();
  const logs = await bootGame(page, server.url, { quality });
  console.log(`ok (${Date.now() - t0}ms)`);
  report.bootLogs = logs.slice(-120);

  const errs = logs.filter((l) => /\[error\]|\[pageerror\]/.test(l));
  if (errs.length) {
    console.log(`\n!! ${errs.length} console errors during boot:`);
    for (const e of errs.slice(0, 12)) console.log('   ' + e.slice(0, 300));
  }

  for (const name of names) {
    const pose = POSES[name];
    const out = join(outDir, `${name}.png`);
    const t = Date.now();
    process.stdout.write(`  ${name.padEnd(11)} `);
    try {
      // Re-boot between poses. A single boot lets the simulation run on across the whole
      // set: the player dies partway through and every later pose is captured through a
      // "RESPAWN IN n" death overlay. Measured on one contaminated run, firefight came
      // out at mean L 37.5 with 50.8% of pixels under L32, against 93.1 and 6.8% for the
      // identical code captured alive. That is the HUD, not the renderer, and it silently
      // corrupts every review that reads the set.
      if (name !== names[0]) await bootGame(page, server.url, { quality });
      const stats = await capture(page, pose, out, {
        warm: warmOverride ? Number(warmOverride) : null,
      });
      report.poses[name] = { ok: true, ms: Date.now() - t, file: out, stats, desc: pose.desc };
      console.log(
        `${String(Date.now() - t).padStart(6)}ms  ${String(stats.drawCalls).padStart(5)} calls  ${(
          stats.tris / 1000
        ).toFixed(0)}k tris`
      );
    } catch (err) {
      report.poses[name] = { ok: false, error: err.message };
      console.log(`FAILED: ${err.message.slice(0, 200)}`);
    }
  }

  report.ok = Object.values(report.poses).some((p) => p.ok);
  const finalStats = await page.evaluate(() => window.__COD.stats()).catch(() => null);
  report.final = finalStats;
  if (finalStats?.failed?.length) {
    console.log('\n!! broken systems:', finalStats.failed.map((f) => f.name).join(', '));
  }
} catch (err) {
  report.fatal = err.message;
  console.error('\nFATAL:', err.message);
} finally {
  await browser?.close().catch(() => {});
  server?.stop();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  try {
    rmSync(join(ROOT, '.vite-preview.lock'), { force: true });
  } catch {
    /* nothing to clean */
  }
}

console.log(`\nwrote ${Object.values(report.poses).filter((p) => p.ok).length}/${names.length} to ${outDir}`);
process.exit(report.ok ? 0 : 1);
