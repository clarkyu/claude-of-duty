/**
 * Shared browser harness. Owner: ORCHESTRATOR ONLY.
 * Builds the app, serves it, drives it in headless Chromium with a software GL
 * rasteriser, and hands back a page that is booted and ready to pose.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const execFileP = promisify(execFile);
export const ROOT = resolve(import.meta.dirname, '..');

const CHROME_CANDIDATES = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  process.env.CHROME_PATH,
].filter(Boolean);

export function chromePath() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return undefined; // let Playwright resolve its own
}

export async function build({ quiet = true, outDir = 'dist' } = {}) {
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileP(
      'npx',
      ['vite', 'build', '--logLevel', 'warn', '--outDir', outDir, '--emptyOutDir'],
      {
        cwd: ROOT,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 600000,
      }
    );
    if (!quiet) process.stdout.write(stdout + stderr);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: `${err.message}\n${err.stdout || ''}\n${err.stderr || ''}`.slice(0, 6000),
    };
  }
}

export async function serve(port = 4173, outDir = 'dist') {
  const proc = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort', '--outDir', outDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('preview server did not start in 60s')), 60000);
    const onData = (d) => {
      if (/Local:|localhost:/.test(d.toString())) {
        clearTimeout(timer);
        res();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (c) => {
      clearTimeout(timer);
      rej(new Error(`preview exited early (${c})`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    },
  };
}

export async function launch({ width = 1600, height = 900 } = {}) {
  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-dev-shm-usage',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-frame-rate-limit',
      '--js-flags=--max-old-space-size=8192',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      '--mute-audio',
    ],
  });
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  // A single frame costs seconds on a software rasteriser, and page.screenshot()
  // forces a fresh paint. Playwright's 30s default trips on every capture.
  page.setDefaultTimeout(300000);
  page.setDefaultNavigationTimeout(300000);
  return { browser, page };
}

/** Load the game and wait until every system has finished init(). */
export async function bootGame(page, url, { quality = 'high', seed = 0x5eed1234, timeout = 600000 } = {}) {
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

  // Several agents capture concurrently on a 4-core box under a software
  // rasteriser, so navigation alone can take minutes. The old 120s cap turned
  // heavy load into a spurious failure.
  await page.goto(`${url}/?headless=1&quality=${quality}&seed=${seed}`, {
    waitUntil: 'domcontentloaded',
    timeout: 600000,
  });
  await page.waitForFunction('window.__BOOTED === true', null, { timeout, polling: 500 });
  return logs;
}

export async function capture(page, pose, outPath, { warm = null } = {}) {
  await page.evaluate((p) => window.__COD.applyPose(p), pose);
  // Auto-exposure needs time to settle. A reviewer measured hero at warm 6 against its
  // native warm 48 and found 1.6 of central chroma spread missing and black crush at
  // 13.75% against 7.68% — so a short warm-up does not just soften the frame, it roughly
  // doubles the apparent crush and invites tuning against an artefact. Floor it.
  const MIN_WARM = 16;
  const frames = Math.max(MIN_WARM, warm ?? pose.warm ?? 32);
  // Step in small batches so a slow software rasteriser never trips the
  // single-evaluate timeout.
  for (let done = 0; done < frames; ) {
    const batch = Math.min(8, frames - done);
    await page.evaluate((n) => window.__COD.step(n, 1 / 60), batch);
    done += batch;
  }
  await page.evaluate(() => window.__COD.frame(1 / 60));
  // Concurrent agents rendering on a 4-core box push a capture past any fixed cap, and a
  // single timeout used to lose the whole multi-pose run. Retry with a longer budget and
  // a settling pause instead of failing the pose.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.screenshot({
        path: outPath,
        type: 'png',
        timeout: 300000 + attempt * 300000,
        animations: 'disabled',
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await page.evaluate(() => window.__COD.frame(1 / 60)).catch(() => {});
    }
  }
  if (lastErr) throw lastErr;
  return page.evaluate(() => window.__COD.stats());
}
