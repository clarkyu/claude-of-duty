#!/usr/bin/env node
// Lighting critic pixel probe. Read-only analysis of captured PNGs.
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, basename } from 'node:path';

export function decodePNG(path) {
  const buf = readFileSync(path);
  let p = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  let pal = null, trns = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') pal = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit supported, got ' + bitDepth);
  const chan = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * chan;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= chan ? cur[x - chan] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= chan ? prev[x - chan] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  // normalise to RGB
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    if (colorType === 6 || colorType === 2) {
      rgb[i * 3] = out[i * chan]; rgb[i * 3 + 1] = out[i * chan + 1]; rgb[i * 3 + 2] = out[i * chan + 2];
    } else if (colorType === 3) {
      const idx = out[i]; rgb[i * 3] = pal[idx * 3]; rgb[i * 3 + 1] = pal[idx * 3 + 1]; rgb[i * 3 + 2] = pal[idx * 3 + 2];
    } else {
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = out[i * chan];
    }
  }
  return { w, h, rgb };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function analyse(img) {
  const { w, h, rgb } = img;
  // central 40% box
  const x0 = Math.floor(w * 0.3), x1 = Math.ceil(w * 0.7);
  const y0 = Math.floor(h * 0.3), y1 = Math.ceil(h * 0.7);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 3; sr += rgb[i]; sg += rgb[i + 1]; sb += rgb[i + 2]; n++;
  }
  const mr = sr / n, mg = sg / n, mb = sb / n;
  const centralSpread = Math.max(mr, mg, mb) - Math.min(mr, mg, mb);

  // luminance histogram over whole frame
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = lum(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  const idx = Array.from(L.keys()).sort((a, b) => L[a] - L[b]);
  const N = idx.length;
  const dark = idx.slice(0, Math.floor(N * 0.20));
  const bright = idx.slice(Math.floor(N * 0.95));
  const rb = (arr) => {
    let s = 0; for (const i of arr) s += rgb[i * 3] - rgb[i * 3 + 2];
    return s / arr.length;
  };
  const keyFill = rb(bright) - rb(dark);
  let under32 = 0; for (let i = 0; i < N; i++) if (L[i] < 32) under32++;
  let over240 = 0; for (let i = 0; i < N; i++) if (L[i] > 240) over240++;
  const meanL = L.reduce((a, b) => a + b, 0) / N;
  const pct = (q) => L[idx[Math.min(N - 1, Math.floor(N * q))]];
  const meanOf = (arr) => {
    let s = 0; for (const i of arr) s += L[i]; return s / arr.length;
  };
  return {
    centralMean: [mr, mg, mb].map((v) => +v.toFixed(2)),
    centralSpread: +centralSpread.toFixed(2),
    keyFill: +keyFill.toFixed(2),
    darkRB: +rb(dark).toFixed(2), brightRB: +rb(bright).toFixed(2),
    darkMeanL: +meanOf(dark).toFixed(2), brightMeanL: +meanOf(bright).toFixed(2),
    under32: +(under32 / N * 100).toFixed(2),
    over240: +(over240 / N * 100).toFixed(2),
    meanL: +meanL.toFixed(2),
    p01: +pct(0.01).toFixed(1), p05: +pct(0.05).toFixed(1), p50: +pct(0.5).toFixed(1),
    p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1),
  };
}

// region probe: patch stats
export function patch(img, px, py, pw, ph) {
  const { w, rgb } = img;
  let sr = 0, sg = 0, sb = 0, n = 0;
  let mnL = 1e9, mxL = -1e9;
  const Ls = [];
  for (let y = py; y < py + ph; y++) for (let x = px; x < px + pw; x++) {
    const i = (y * w + x) * 3;
    sr += rgb[i]; sg += rgb[i + 1]; sb += rgb[i + 2]; n++;
    const l = lum(rgb[i], rgb[i + 1], rgb[i + 2]); Ls.push(l);
    if (l < mnL) mnL = l; if (l > mxL) mxL = l;
  }
  const mr = sr / n, mg = sg / n, mb = sb / n;
  Ls.sort((a, b) => a - b);
  const mean = Ls.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(Ls.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return {
    rgb: [mr, mg, mb].map((v) => +v.toFixed(2)),
    spread: +(Math.max(mr, mg, mb) - Math.min(mr, mg, mb)).toFixed(2),
    L: +mean.toFixed(2), sd: +sd.toFixed(2), min: +mnL.toFixed(1), max: +mxL.toFixed(1),
    rb: +(mr - mb).toFixed(2),
  };
}

if (process.argv[2]) {
  const dir = process.argv[2];
  const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  for (const f of files) {
    const img = decodePNG(join(dir, f));
    console.log(basename(f).padEnd(14), JSON.stringify(analyse(img)));
  }
}
