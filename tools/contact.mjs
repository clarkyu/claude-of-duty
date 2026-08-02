#!/usr/bin/env node
/**
 * Contact sheet + A/B compositor. Owner: ORCHESTRATOR ONLY.
 *
 * Review agents can only look at a handful of images per turn, so pack a whole pose
 * set into one sheet. Compositing runs in the browser (canvas) because there is no
 * native image library available here.
 *
 *   node tools/contact.mjs --in shots --out shots/contact.png
 *   node tools/contact.mjs --in shots --out shots/sheet.png --cols 2 --cell 900
 *   node tools/contact.mjs --ab shots/a/hero.png shots/b/hero.png --out shots/ab.png
 *
 * --blind shuffles and labels the A/B panels "LEFT"/"RIGHT" with the mapping written to
 * a sidecar .json, so a critic can be asked which is better without knowing which build
 * produced which panel.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { ROOT, launch } from './harness.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const outPath = resolve(ROOT, arg('out', 'shots/contact.png'));
const cell = Number(arg('cell', 760));
const cols = Number(arg('cols', 0));
const blind = flag('blind');

function collect() {
  const abIdx = argv.indexOf('--ab');
  if (abIdx >= 0) {
    const a = argv[abIdx + 1];
    const b = argv[abIdx + 2];
    if (!a || !b) throw new Error('--ab needs two image paths');
    return [
      { label: 'A', file: resolve(ROOT, a) },
      { label: 'B', file: resolve(ROOT, b) },
    ];
  }
  const dir = resolve(ROOT, arg('in', 'shots'));
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png') && !f.startsWith('.'))
    .sort()
    .map((f) => ({ label: basename(f, '.png'), file: join(dir, f) }));
}

let items = collect();
if (!items.length) throw new Error('no PNGs found to composite');

let mapping = null;
if (blind && items.length === 2) {
  // Deterministic-but-opaque shuffle: derived from the file bytes, not a clock, so
  // reruns are reproducible while the reviewer still cannot infer the order.
  const h = readFileSync(items[0].file).length % 2;
  if (h === 1) items = [items[1], items[0]];
  mapping = { LEFT: items[0].file, RIGHT: items[1].file };
  items[0].label = 'LEFT';
  items[1].label = 'RIGHT';
}

const payload = items.map((it) => ({
  label: it.label,
  data: 'data:image/png;base64,' + readFileSync(it.file).toString('base64'),
}));

const gridCols = cols || Math.min(items.length, Math.ceil(Math.sqrt(items.length)));

const { browser, page } = await launch({ width: 400, height: 300 });
try {
  const dataUrl = await page.evaluate(
    async ({ imgs, cell, cols }) => {
      const loaded = await Promise.all(
        imgs.map(
          (i) =>
            new Promise((res, rej) => {
              const im = new Image();
              im.onload = () => res({ im, label: i.label });
              im.onerror = () => rej(new Error('decode failed: ' + i.label));
              im.src = i.data;
            })
        )
      );
      const ar = loaded[0].im.height / loaded[0].im.width;
      const cw = cell;
      const ch = Math.round(cell * ar);
      const pad = 8;
      const bar = 30;
      const rows = Math.ceil(loaded.length / cols);
      const c = document.createElement('canvas');
      c.width = cols * cw + (cols + 1) * pad;
      c.height = rows * (ch + bar) + (rows + 1) * pad;
      const g = c.getContext('2d');
      g.fillStyle = '#0b0c0e';
      g.fillRect(0, 0, c.width, c.height);
      loaded.forEach(({ im, label }, i) => {
        const x = pad + (i % cols) * (cw + pad);
        const y = pad + Math.floor(i / cols) * (ch + bar + pad);
        g.drawImage(im, x, y, cw, ch);
        g.strokeStyle = 'rgba(255,255,255,0.13)';
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
        g.fillStyle = '#12141a';
        g.fillRect(x, y + ch, cw, bar);
        g.fillStyle = '#d8d4cc';
        g.font = '600 17px system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.fillText(label.toUpperCase(), x + 10, y + ch + bar / 2);
      });
      return c.toDataURL('image/png');
    },
    { imgs: payload, cell, cols: gridCols }
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  if (mapping) writeFileSync(outPath.replace(/\.png$/, '.map.json'), JSON.stringify(mapping, null, 2));
  console.log(`wrote ${outPath} (${items.length} panels, ${gridCols} cols)`);
} finally {
  await browser.close();
}
