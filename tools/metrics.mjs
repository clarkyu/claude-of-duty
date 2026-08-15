#!/usr/bin/env node
/**
 * Reviewer-metric analyser. Orchestrator-owned.
 *
 * Implements, in pure Node with no browser, the measurements the review agents
 * actually use, so a fix can be verified in seconds instead of an hour of
 * capture-plus-review, and a regression in ANY pose is flagged mechanically:
 *
 *   spread   central-40% channel-mean spread: max(meanR,meanG,meanB) - min(...)
 *   keyFill  mean(R-B) of the brightest 5% of pixels minus mean(R-B) of the
 *            darkest 20%, by luma — "warm key over cool fill"
 *   <L32     fraction of pixels with Rec.709 luma under 32
 *   sat      mean per-pixel (max(R,G,B) - min(R,G,B))
 *   gc/gcLin ground contrast: bottom 32% of frame, mean luma of the top luma
 *            quartile over mean luma of the bottom quartile, in sRGB and in
 *            linear light (the sRGB ratio falls when a frame brightens even at
 *            constant physical contrast)
 *   >240     fraction of pixels with any channel at or above 240 (clipping)
 *
 *   node tools/metrics.mjs shots/setA              one set, table + means
 *   node tools/metrics.mjs shots/setA shots/setB   compare, ⚠ on regressions
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve, join, basename } from 'node:path';

function decodePNG(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + path);
  let off = 8;
  let w = 0, h = 0, depth = 0, colour = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') {
      const d = buf.subarray(off + 8, off + 8 + len);
      w = d.readUInt32BE(0); h = d.readUInt32BE(4);
      depth = d[8]; colour = d[9]; interlace = d[12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(off + 8, off + 8 + len));
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0)
    throw new Error(`unsupported PNG (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  const ch = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let pos = 0;
  let prev = null;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const cur = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(cur, 0, pos, pos + stride);
    pos += stride;
    if (f === 1) {
      for (let i = ch; i < stride; i++) cur[i] = (cur[i] + cur[i - ch]) & 255;
    } else if (f === 2 && prev) {
      for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 255;
    } else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? cur[i - ch] : 0;
        const b = prev ? prev[i] : 0;
        cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
      }
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? cur[i - ch] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= ch ? prev[i - ch] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    prev = cur;
  }
  return { w, h, ch, data: out };
}

const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const toLin = (v) => Math.pow(v / 255, 2.2);

function analyse(img) {
  const { w, h, ch, data } = img;
  const N = w * h;

  // Central 40% region for channel-mean spread.
  const cx0 = Math.floor(w * 0.3), cx1 = Math.floor(w * 0.7);
  const cy0 = Math.floor(h * 0.3), cy1 = Math.floor(h * 0.7);
  let cR = 0, cG = 0, cB = 0, cN = 0;

  // Full-frame accumulators.
  const lumBins = new Float64Array(256);
  const rbBins = new Float64Array(256);
  let under32 = 0, sat = 0, clip = 0;

  // Ground band: bottom 32% of rows.
  const gy0 = Math.floor(h * 0.68);
  const gBins = new Float64Array(256);
  const gLinSum = new Float64Array(256);

  for (let y = 0; y < h; y++) {
    const inC = y >= cy0 && y < cy1;
    const inG = y >= gy0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const L = lumaOf(r, g, b);
      const bin = Math.min(255, L | 0);
      lumBins[bin]++;
      rbBins[bin] += r - b;
      if (L < 32) under32++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sat += mx - mn;
      if (mx >= 240) clip++;
      if (inC && x >= cx0 && x < cx1) { cR += r; cG += g; cB += b; cN++; }
      if (inG) {
        gBins[bin]++;
        gLinSum[bin] += lumaOf(toLin(r) * 255, toLin(g) * 255, toLin(b) * 255);
      }
    }
  }

  const means = [cR / cN, cG / cN, cB / cN];
  const spread = Math.max(...means) - Math.min(...means);

  // key/fill from the luma histogram: brightest 5% and darkest 20% by count.
  const tail = (bins, rb, frac, fromTop) => {
    const target = N * frac;
    let got = 0, sumRB = 0;
    if (fromTop) {
      for (let i = 255; i >= 0 && got < target; i--) {
        const take = Math.min(bins[i], target - got);
        if (bins[i] > 0) sumRB += (rb[i] / bins[i]) * take;
        got += take;
      }
    } else {
      for (let i = 0; i < 256 && got < target; i++) {
        const take = Math.min(bins[i], target - got);
        if (bins[i] > 0) sumRB += (rb[i] / bins[i]) * take;
        got += take;
      }
    }
    return got > 0 ? sumRB / got : 0;
  };
  const keyFill = tail(lumBins, rbBins, 0.05, true) - tail(lumBins, rbBins, 0.2, false);

  // Ground contrast: quartiles by count within the ground band.
  const gN = gBins.reduce((a, v) => a + v, 0);
  const quart = (frac, fromTop) => {
    const target = gN * frac;
    let got = 0, sL = 0, sLin = 0;
    if (fromTop) {
      for (let i = 255; i >= 0 && got < target; i--) {
        const take = Math.min(gBins[i], target - got);
        if (gBins[i] > 0) { sL += i * take; sLin += (gLinSum[i] / gBins[i]) * take; }
        got += take;
      }
    } else {
      for (let i = 0; i < 256 && got < target; i++) {
        const take = Math.min(gBins[i], target - got);
        if (gBins[i] > 0) { sL += i * take; sLin += (gLinSum[i] / gBins[i]) * take; }
        got += take;
      }
    }
    return { l: got ? sL / got : 0, lin: got ? sLin / got : 0 };
  };
  const top = quart(0.25, true), bot = quart(0.25, false);

  let meanL = 0;
  for (let i = 0; i < 256; i++) meanL += i * lumBins[i];
  meanL /= N;

  return {
    spread,
    keyFill,
    under32: (under32 / N) * 100,
    sat: sat / N,
    gc: bot.l > 0.5 ? top.l / bot.l : Infinity,
    gcLin: bot.lin > 0.004 ? top.lin / bot.lin : Infinity,
    clip: (clip / N) * 100,
    meanL,
  };
}

const COLS = [
  ['spread', 1, 'higher'],
  ['keyFill', 1, 'higher'],
  ['under32', 1, 'lower'],
  ['sat', 1, 'higher'],
  ['gc', 2, 'higher'],
  ['gcLin', 2, 'higher'],
  ['clip', 2, 'lower'],
  ['meanL', 0, 'info'],
];

function loadSet(dir) {
  const full = resolve(dir);
  if (!existsSync(full)) throw new Error('no such dir: ' + dir);
  const out = {};
  for (const f of readdirSync(full).filter((f) => f.endsWith('.png') && !f.startsWith('.')).sort()) {
    out[basename(f, '.png')] = analyse(decodePNG(join(full, f)));
  }
  return out;
}

const [dirA, dirB] = process.argv.slice(2);
if (!dirA) {
  console.error('usage: node tools/metrics.mjs <shotsDir> [baselineDir]');
  process.exit(2);
}
const A = loadSet(dirA);
const B = dirB ? loadSet(dirB) : null;

const names = Object.keys(A);
const header = ['pose'.padEnd(11)].concat(COLS.map(([n]) => n.padStart(9))).join('');
console.log(header);
const meansA = {}, meansB = {};
for (const name of names) {
  let row = name.padEnd(11);
  for (const [key, dp, dir] of COLS) {
    const a = A[name][key];
    meansA[key] = (meansA[key] || 0) + a / names.length;
    if (B && B[name]) {
      const b = B[name][key];
      meansB[key] = (meansB[key] || 0) + b / names.length;
      const worse =
        dir === 'higher' ? a < b - Math.max(0.5, Math.abs(b) * 0.05)
        : dir === 'lower' ? a > b + Math.max(0.5, Math.abs(b) * 0.05)
        : false;
      row += `${a.toFixed(dp)}${worse ? '⚠' : ' '}`.padStart(9 + 1);
    } else {
      row += a.toFixed(dp).padStart(9);
    }
  }
  console.log(row);
}
let mrow = 'SET MEAN'.padEnd(11);
for (const [key, dp, dir] of COLS) {
  const a = meansA[key];
  if (B) {
    const b = meansB[key];
    const worse =
      dir === 'higher' ? a < b - Math.max(0.5, Math.abs(b) * 0.05)
      : dir === 'lower' ? a > b + Math.max(0.5, Math.abs(b) * 0.05)
      : false;
    mrow += `${a.toFixed(dp)}${worse ? '⚠' : ' '}`.padStart(10);
  } else {
    mrow += a.toFixed(dp).padStart(9);
  }
}
console.log(mrow);
if (B) {
  let brow = 'baseline'.padEnd(11);
  for (const [key, dp] of COLS) brow += (meansB[key] ?? 0).toFixed(dp).padStart(B ? 10 : 9);
  console.log(brow);
}
