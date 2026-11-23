/**
 * ASCII Studio core: still-image path used by the preview, export, and tests.
 * Pure functions, no DOM, so it runs in a Worker and under Node tests.
 */

import { clamp, luma } from "./util.js";

export const CW = 12;
export const CH = 18;
/** Heavy-to-light, ordered by DejaVu Sans Mono ink coverage in a 12×18 cell. */
export const RAMP = "B#8Q0@&$aeo1un%t{i}z=xcvl[]>+<jr!;:,";

/**
 * @typedef {object} Layout
 * @property {number} cols
 * @property {number} rows
 * @property {number} SW  working pixels per cell, horizontally
 * @property {number} SH  working pixels per cell, vertically
 */

/**
 * @typedef {object} GridRequest
 * @property {Uint8ClampedArray} rgba  (cols*SW) x (rows*SH) RGBA pixels
 * @property {Layout} layout
 * @property {Float32Array} atlas  RAMP.length masks of SW x SH, coverage 0..1
 * @property {number} edgeGain
 * @property {boolean} separate  separate subject from background
 */

/**
 * @typedef {object} Grid
 * @property {Uint8Array} glyphs  ascii code - 32, per cell
 * @property {Uint8Array} ink  r,g,b per cell
 * @property {number} cols
 * @property {number} rows
 * @property {boolean} hasSubject
 */

/**
 * Grid size and working resolution for a source of srcW x srcH at `cols` columns.
 * Up to 100 columns the full 12x18 px per cell is used, above that half (6x9).
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} cols
 * @returns {Layout}
 */
export function frameLayout(srcW, srcH, cols) {
  const rows = Math.max(4, Math.round((srcH / srcW) * cols * CW / CH));
  const sub = cols <= 100 ? 1 : 0.5;
  return { cols, rows, SW: CW * sub, SH: CH * sub };
}

/** Glyph ids are printable ASCII shifted so that 0 is the space. */
export const glyphChar = (/** @type {number} */ id) => String.fromCharCode(id + 32);
export const glyphId = (/** @type {string} */ ch) => ch.charCodeAt(0) - 32;

/** @param {Grid} grid @returns {string} pure ASCII, one line per row, trailing blanks trimmed */
export function gridToText(grid) {
  const lines = [];
  for (let r = 0; r < grid.rows; r++) {
    let line = "";
    for (let c = 0; c < grid.cols; c++) line += glyphChar(grid.glyphs[r * grid.cols + c]);
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}

const RAMP_G = Array.from(RAMP, glyphId);
const G_SPACE = 0;
/** Density of the dotted backdrop and strength of the tone stretch. */
const WATER = 0.35;
const CONTRAST = 0.45;

/** @param {number} a @param {number} b @param {number} x */
function smoothstep(a, b, x) {
  const t = clamp((x - a) / Math.max(b - a, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** @param {number} seed */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Separable box blur with edge replication.
 * @param {Float32Array} src @param {number} w @param {number} h @param {number} r
 */
function boxBlur(src, w, h, r) {
  if (r <= 0) return src.slice();
  const k = 2 * r + 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[o + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / k;
      s += src[o + Math.min(x + r + 1, w - 1)] - src[o + Math.max(x - r, 0)];
    }
  }
  const col = new Float64Array(w);
  for (let y = -r; y <= r; y++) {
    const row = clamp(y, 0, h - 1) * w;
    for (let x = 0; x < w; x++) col[x] += tmp[row + x];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = col[x] / k;
    const add = Math.min(y + r + 1, h - 1) * w;
    const sub = Math.max(y - r, 0) * w;
    for (let x = 0; x < w; x++) col[x] += tmp[add + x] - tmp[sub + x];
  }
  return out;
}

/** @param {ArrayLike<number>} arr @param {number} q percentile 0..100 */
function percentile(arr, q) {
  const a = Float32Array.from(arr).sort();
  const n = a.length;
  if (!n) return 0;
  const pos = ((n - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/**
 * Moving average over rows (edge clamped) of a per-row RGB triple array.
 * @param {Float32Array} v h*3 values @param {number} h @param {number} k
 */
function smoothRows(v, h, k) {
  const out = new Float32Array(v.length);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < h; i++) {
      let s = 0;
      for (let j = i + 1 - k; j <= i + k; j++) s += v[clamp(j, 0, h - 1) * 3 + c];
      out[i * 3 + c] = s / (2 * k);
    }
  }
  return out;
}

/** Otsu threshold over a 64-bin histogram spanning 0..441 @param {Float64Array} hist */
function otsu(hist) {
  let tot = 0;
  for (const n of hist) tot += n;
  const centers = Array.from(hist, (_, i) => ((i + 0.5) * 441) / hist.length);
  const mt = centers.reduce((s, c, i) => s + (hist[i] / tot) * c, 0);
  let w0 = 0, mm = 0, best = -1, bestC = centers[0];
  for (let i = 0; i < hist.length; i++) {
    const p = hist[i] / tot;
    w0 += p;
    mm += p * centers[i];
    const v = Math.pow(mt * w0 - mm, 2) / Math.max(w0 * (1 - w0), 1e-9);
    if (v > best) { best = v; bestC = centers[i]; }
  }
  return bestC;
}

/**
 * Distance of every pixel to a background model interpolated from the left/right borders.
 * @param {Float32Array[]} planes blurred R,G,B
 * @param {number} w @param {number} h
 * @returns {{dist: Float32Array, hist: Float64Array}}
 */
function backgroundDistance(planes, w, h) {
  const bw = Math.max(2, Math.floor(w * 0.04));
  const tmp = new Float32Array(bw);
  const median = (/** @type {number} */ off, /** @type {number} */ c) => {
    tmp.set(planes[c].subarray(off, off + bw));
    tmp.sort();
    return bw % 2 ? tmp[(bw - 1) >> 1] : 0.5 * (tmp[bw / 2 - 1] + tmp[bw / 2]);
  };
  let left = new Float32Array(h * 3);
  let right = new Float32Array(h * 3);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      left[y * 3 + c] = median(y * w, c);
      right[y * 3 + c] = median(y * w + w - bw, c);
    }
  }
  const k = Math.max(1, Math.floor(h / 12));
  left = smoothRows(left, h, k);
  right = smoothRows(right, h, k);
  const dist = new Float32Array(w * h);
  const hist = new Float64Array(64);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = w > 1 ? x / (w - 1) : 0;
      const idx = y * w + x;
      let d2 = 0;
      for (let c = 0; c < 3; c++) {
        const bg = left[y * 3 + c] * (1 - t) + right[y * 3 + c] * t;
        const dd = planes[c][idx] - bg;
        d2 += dd * dd;
      }
      const d = Math.sqrt(d2);
      dist[idx] = d;
      hist[Math.min(63, Math.floor((d / 441) * 64))]++;
    }
  }
  return { dist, hist };
}

/**
 * Soft subject mask 0..1 (adaptive background separation).
 * @param {Float32Array[]} planes blurred R,G,B
 * @param {number} w @param {number} h @param {number} fx working scale vs 12x18 cells
 * @returns {{mask: Float32Array, ok: boolean}}
 */
function segment(planes, w, h, fx) {
  const N = w * h;
  const [bR, bG, bB] = planes;
  const lum = new Float32Array(N);
  const chroma = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lum[i] = luma(bR[i], bG[i], bB[i]) / 255;
    chroma[i] = (Math.max(bR[i], bG[i], bB[i]) - Math.min(bR[i], bG[i], bB[i])) / 255;
  }
  const { dist, hist } = backgroundDistance(planes, w, h);
  const thr = clamp(otsu(hist) * 0.6, 22, 80);
  const m = new Float32Array(N);
  for (let i = 0; i < N; i++) m[i] = smoothstep(thr * 0.75, thr * 1.25, dist[i]);
  const minSide = Math.min(h, w) / fx;
  const scaled = (/** @type {number} */ r) => Math.max(1, Math.round(r * fx));
  const closed = boxBlur(m, w, h, scaled(Math.max(3, Math.floor(minSide / 110))));
  for (let i = 0; i < N; i++) m[i] = clamp(closed[i] * 1.15, 0, 1);

  const bw = Math.max(2, Math.floor(w * 0.04));
  let s1 = 0, s2 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < bw; x++) {
      const a = lum[y * w + x], b = lum[y * w + w - 1 - x];
      s1 += a + b;
      s2 += a * a + b * b;
    }
  }
  const cnt = 2 * h * bw, mean = s1 / cnt;
  const busyBorder = Math.sqrt(Math.max(0, s2 / cnt - mean * mean)) > 0.15;

  const notVoid = new Float32Array(N);
  for (let i = 0; i < N; i++) notVoid[i] = clamp(smoothstep(0.05, 0.14, lum[i]) + smoothstep(0.04, 0.10, chroma[i]), 0, 1);
  if (busyBorder) {
    for (let i = 0; i < N; i++) m[i] = Math.max(m[i], 0.75 * notVoid[i]);
  } else {
    const core = new Float32Array(N);
    for (let i = 0; i < N; i++) core[i] = m[i] > 0.45 ? 1 : 0;
    const near = boxBlur(core, w, h, scaled(Math.max(4, Math.floor(minSide / 80))));
    for (let i = 0; i < N; i++) m[i] = Math.max(m[i], 0.8 * notVoid[i] * clamp(near[i] * 1.4, 0, 1));
  }
  for (let y = 0; y < h; y++) {
    const ey = Math.min(y / h, (h - 1 - y) / h);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const e = Math.min(ey, x / w, (w - 1 - x) / w);
      const darkWater = lum[i] < 0.10 && chroma[i] < 0.11 && e < 0.22;
      const voidPx = lum[i] < 0.07 && chroma[i] < 0.08;
      if (darkWater || voidPx) m[i] *= 0.15;
    }
  }
  const fin = boxBlur(m, w, h, 1);
  let subject = 0;
  for (let i = 0; i < N; i++) {
    m[i] = clamp(fin[i], 0, 1);
    if (m[i] > 0.5) subject++;
  }
  return { mask: m, ok: subject / N > 0.01 };
}

/**
 * Edge-connected growth: keep weak cells that touch strong ones (<= 8 dilation steps).
 * @param {Uint8Array} strong @param {Uint8Array} weak @param {number} rows @param {number} cols
 */
function hysteresis(strong, weak, rows, cols) {
  const keep = strong.slice();
  let frontier = strong;
  for (let step = 0; step < 8; step++) {
    const grow = new Uint8Array(rows * cols);
    let any = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!weak[i] || keep[i]) continue;
        let hit = false;
        for (let dr = -1; dr <= 1 && !hit; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && frontier[rr * cols + cc]) { hit = true; break; }
          }
        }
        if (hit) { grow[i] = 1; any = true; }
      }
    }
    if (!any) break;
    for (let i = 0; i < grow.length; i++) if (grow[i]) keep[i] = 1;
    frontier = grow;
  }
  return keep;
}

/**
 * Per-cell block means of the source.
 * @param {Float32Array[]} rgb raw R,G,B planes @param {Float32Array} mask
 * @param {number} w @param {number} h @param {Layout} L
 */
function cellMeans(rgb, mask, w, h, L) {
  const n = L.rows * L.cols, area = L.SW * L.SH;
  const cr = new Float32Array(n), cg = new Float32Array(n), cb = new Float32Array(n), cover = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / L.SH) * L.cols;
    for (let x = 0; x < w; x++) {
      const ci = row + Math.floor(x / L.SW), pi = y * w + x;
      cr[ci] += rgb[0][pi]; cg[ci] += rgb[1][pi]; cb[ci] += rgb[2][pi]; cover[ci] += mask[pi];
    }
  }
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cr[i] /= area; cg[i] /= area; cb[i] /= area; cover[i] /= area;
    lum[i] = luma(cr[i], cg[i], cb[i]) / 255;
  }
  return { cr, cg, cb, cover, lum };
}

/**
 * Tone mapping with local contrast. `shadeFill` is the value that selects the ramp glyph.
 * @param {Float32Array} lum @param {Float32Array} cover @param {Layout} L @param {number} contrast
 */
function shadeFields(lum, cover, L, contrast) {
  const n = lum.length;
  const subjectLum = Array.from(lum).filter((_, i) => cover[i] > 0.35);
  const ref = subjectLum.length > 20 ? subjectLum : lum;
  const lo = percentile(ref, 1), hi = percentile(ref, 99.5);
  const shade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = clamp((lum[i] - lo) / Math.max(hi - lo, 1e-3), 0, 1);
    shade[i] = clamp((1 - contrast) * lum[i] + contrast * s, 0, 1);
  }
  const local = boxBlur(lum, L.cols, L.rows, Math.max(2, Math.floor(L.cols / 16)));
  const delta = Float32Array.from(lum, (v, i) => v - local[i]);
  const subjectDelta = Array.from(delta, Math.abs).filter((_, i) => cover[i] > 0.35);
  const scale = percentile(subjectDelta.length > 20 ? subjectDelta : Array.from(delta, Math.abs), 90) + 1e-3;
  const shadeFill = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    shade[i] = clamp(shade[i] + 0.30 * clamp(delta[i] / scale, -1, 1), 0, 1);
    shadeFill[i] = cover[i] > 0.4 ? 0.16 + 0.84 * shade[i] : shade[i];
  }
  return shadeFill;
}

/**
 * Structure tensor per cell from Sobel gradients of blurred RGB and the blurred mask.
 * Returns edge strength (normalised to its 99th percentile), coherence and tangent direction.
 * @param {Float32Array[]} planes blurred planes (R,G,B[,mask*220]) @param {number} w @param {number} h @param {Layout} L
 */
function structureTensor(planes, w, h, L) {
  const n = L.rows * L.cols, area = L.SW * L.SH;
  const sxx = new Float64Array(n), syy = new Float64Array(n), sxy = new Float64Array(n);
  for (const p of planes) {
    for (let y = 0; y < h; y++) {
      const ym = Math.max(y - 1, 0) * w, y0 = y * w, yp = Math.min(y + 1, h - 1) * w;
      const row = Math.floor(y / L.SH) * L.cols;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
        const gx = ((p[ym + xp] + 2 * p[y0 + xp] + p[yp + xp]) - (p[ym + xm] + 2 * p[y0 + xm] + p[yp + xm])) / 8;
        const gy = ((p[yp + xm] + 2 * p[yp + x] + p[yp + xp]) - (p[ym + xm] + 2 * p[ym + x] + p[ym + xp])) / 8;
        const ci = row + Math.floor(x / L.SW);
        sxx[ci] += gx * gx; syy[ci] += gy * gy; sxy[ci] += gx * gy;
      }
    }
  }
  const strength = new Float32Array(n), coherence = new Float32Array(n);
  const tx = new Float32Array(n), ty = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const trace = sxx[i] + syy[i];
    strength[i] = Math.sqrt(trace / area);
    coherence[i] = Math.sqrt((sxx[i] - syy[i]) ** 2 + 4 * sxy[i] ** 2) / Math.max(trace, 1e-6);
    const theta = 0.5 * Math.atan2(2 * sxy[i], sxx[i] - syy[i]);
    tx[i] = -Math.sin(theta); ty[i] = Math.cos(theta);
  }
  const norm = percentile(strength, 99) + 1e-6;
  for (let i = 0; i < n; i++) strength[i] /= norm;
  return { strength, coherence, tx, ty };
}

/**
 * Ramp glyph per cell: Floyd-Steinberg along the ramp, with pattern matching against the
 * source pixels (luma) as tie-break between neighbouring ramp entries.
 * @param {Float32Array} shadeFill @param {Float32Array} lumHi per-pixel luma 0..1 @param {number} w
 * @param {Layout} L @param {Float32Array} atlas
 */
function ditherGlyphs(shadeFill, lumHi, w, L, atlas) {
  const { rows, cols, SW, SH } = L;
  const area = SW * SH, nRamp = RAMP_G.length;
  const aSq = new Float32Array(nRamp);
  for (let k = 0; k < nRamp; k++) {
    for (let i = 0; i < area; i++) aSq[k] += atlas[k * area + i] ** 2;
  }
  const err = new Float32Array(rows * cols);
  const glyph = new Uint8Array(rows * cols);
  const patch = new Float32Array(area);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const target = clamp(Math.pow(1 - shadeFill[i], 1.35) * (nRamp - 1), 0, nRamp - 1);
      const pos = clamp(target + err[i], 0, nRamp - 1);
      const k0 = Math.round(pos);
      const origin = r * SH * w + c * SW;
      for (let py = 0, q = 0; py < SH; py++) for (let px = 0; px < SW; px++) patch[q++] = lumHi[origin + py * w + px];
      let smin = Infinity, smax = -Infinity, kbest = Math.max(0, k0 - 1);
      for (let k = Math.max(0, k0 - 1); k < Math.min(nRamp, k0 + 2); k++) {
        let dot = 0;
        for (let q = 0; q < area; q++) dot += patch[q] * atlas[k * area + q];
        const s = aSq[k] - 2 * dot;
        if (s < smin) { smin = s; kbest = k; }
        if (s > smax) smax = s;
      }
      const kk = smax - smin > 0.08 * area ? kbest : k0;
      glyph[i] = RAMP_G[kk];
      const e = pos - kk;
      if (c + 1 < cols) err[i + 1] += (e * 7) / 16;
      if (r + 1 < rows) {
        if (c > 0) err[i + cols - 1] += (e * 3) / 16;
        err[i + cols] += (e * 5) / 16;
        if (c + 1 < cols) err[i + cols + 1] += e / 16;
      }
    }
  }
  return glyph;
}

/**
 * Contour cells and their direction glyph (/ \ | - _).
 * @param {{strength: Float32Array, coherence: Float32Array, tx: Float32Array, ty: Float32Array}} T
 * @param {Float32Array} cover @param {Layout} L @param {boolean} hasSubject @param {number} edgeGain
 */
function findEdges(T, cover, L, hasSubject, edgeGain) {
  const { rows, cols } = L, n = rows * cols;
  const near = boxBlur(cover, cols, rows, 1);
  const cv = (/** @type {number} */ r, /** @type {number} */ c) => cover[clamp(r, 0, rows - 1) * cols + clamp(c, 0, cols - 1)];
  const gain = Math.max(edgeGain, 0.1);
  const seed = new Uint8Array(n), weak = new Uint8Array(n), interior = new Uint8Array(n), silhouetteCells = new Uint8Array(n);
  const glyph = new Uint8Array(n);
  const [gBar, gUnder, gDash, gSlash, gBack] = ["|", "_", "-", "/", "\\"].map(glyphId);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const nearCell = !hasSubject || near[i] > 0.03;
      const up = cv(r - 1, c), down = cv(r + 1, c);
      const gradC = Math.max(Math.abs(cv(r, c + 1) - cv(r, c - 1)), Math.abs(down - up));
      const silhouette = gradC > 0.28 && cover[i] > 0.12 && nearCell;
      const s = T.strength[i], coh = T.coherence[i];
      const strong = s > 0.42 / gain && coh > 0.50 && nearCell;
      const isWeak = s > 0.28 / gain && coh > 0.40 && nearCell;
      const stroke = cover[i] > 0.08 && cover[i] < 0.55 && coh > 0.55 && s > 0.28;
      seed[i] = silhouette || strong || stroke ? 1 : 0;
      weak[i] = isWeak || silhouette ? 1 : 0;
      interior[i] = strong && s > 0.55 ? 1 : 0;
      silhouetteCells[i] = silhouette ? 1 : 0;
      const cellX = T.tx[i] / CW;
      const cellY = T.ty[i] / CH;
      const rise = Math.abs(cellY);
      const run = Math.abs(cellX);
      if (rise > run * 2) glyph[i] = gBar;
      else if (run > rise * 2) glyph[i] = up > down ? gUnder : gDash;
      else glyph[i] = cellX * cellY < 0 ? gSlash : gBack;
    }
  }
  const isEdge = hysteresis(seed, weak, rows, cols);
  for (let i = 0; i < n; i++) if (cover[i] > 0.70) isEdge[i] = interior[i] | silhouetteCells[i];
  return { isEdge, glyph };
}

/**
 * Final glyph + colour per cell: fill colour, subject/background split, dotted backdrop, contours.
 * @param {ReturnType<typeof cellMeans>} cells @param {Uint8Array} fill
 * @param {ReturnType<typeof findEdges>} edges @param {boolean} hasSubject @param {Layout} L
 * @returns {{glyphs: Uint8Array, ink: Uint8Array}}
 */
function colorize(cells, fill, edges, hasSubject, L) {
  const n = L.rows * L.cols;
  const { cr, cg, cb, cover, lum } = cells;
  const glyphs = new Uint8Array(n), ink = new Uint8Array(n * 3);
  const rand = mulberry32((0x9e3779b1 ^ (L.cols * 131 + L.rows)) | 0);
  const [gColon, gDot, gTick] = [":", ".", "`"].map(glyphId);
  const c01 = (/** @type {number} */ v) => clamp(v, 0, 1);
  for (let i = 0; i < n; i++) {
    let r = c01((cr[i] / 255) * 1.06), g = c01((cg[i] / 255) * 1.06), b = c01((cb[i] / 255) * 1.06);
    if (Math.max(r, g, b) < 0.12) { r = c01(r + 0.07); g = c01(g + 0.07); b = c01(b + 0.07); }
    const gray = (r + g + b) / 3;
    r = c01(gray + 1.12 * (r - gray)); g = c01(gray + 1.12 * (g - gray)); b = c01(gray + 1.12 * (b - gray));
    let glyph = fill[i], k = 1;
    if (hasSubject && cover[i] <= 0.32) {
      const bgT = c01((lum[i] - 0.02) / 0.45);
      const dens = 0.04 + 0.28 * WATER + 0.55 * WATER * bgT;
      if (cover[i] > 0.08) k = 0.65;
      else if (rand() < dens) {
        glyph = bgT > 0.55 ? gColon : (bgT > 0.25 ? gDot : gTick);
        const bs = 0.28 + 0.22 * bgT;
        r = c01((cr[i] / 255) * bs); g = c01((cg[i] / 255) * bs); b = c01((cb[i] / 255) * bs);
      } else glyph = G_SPACE;
    }
    if (edges.isEdge[i]) {
      glyph = edges.glyph[i];
      r = c01(r * 0.92 + 0.06); g = c01(g * 0.92 + 0.06); b = c01(b * 0.92 + 0.06); k = 1;
    }
    glyphs[i] = glyph;
    if (glyph !== G_SPACE) {
      ink[i * 3] = Math.round(r * k * 255); ink[i * 3 + 1] = Math.round(g * k * 255); ink[i * 3 + 2] = Math.round(b * k * 255);
    }
  }
  return { glyphs, ink };
}

/**
 * Convert one frame of pixels into an ASCII grid.
 * @param {GridRequest} req
 * @returns {Grid}
 */
export function computeGrid(req) {
  const { layout: L, rgba } = req;
  const w = L.cols * L.SW, h = L.rows * L.SH, N = w * h, fx = L.SW / CW;
  const raw = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const lumHi = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = rgba[4 * i], g = rgba[4 * i + 1], b = rgba[4 * i + 2];
    raw[0][i] = r; raw[1][i] = g; raw[2][i] = b;
    lumHi[i] = luma(r, g, b) / 255;
  }
  const blurred = raw.map((p) => boxBlur(p, w, h, 1));

  /** @type {Float32Array} */
  let mask = new Float32Array(N).fill(1);
  let hasSubject = false;
  if (req.separate) {
    const seg = segment(blurred, w, h, fx);
    hasSubject = seg.ok;
    if (hasSubject) mask = seg.mask;
  }
  const cells = cellMeans(raw, mask, w, h, L);
  const fill = ditherGlyphs(shadeFields(cells.lum, cells.cover, L, CONTRAST), lumHi, w, L, req.atlas);
  /** @type {Float32Array[]} */
  const tensorPlanes = hasSubject ? [...blurred, boxBlur(mask, w, h, 1).map((v) => v * 220)] : blurred;
  const edges = findEdges(structureTensor(tensorPlanes, w, h, L), cells.cover, L, hasSubject, req.edgeGain);
  const { glyphs, ink } = colorize(cells, fill, edges, hasSubject, L);
  return { glyphs, ink, cols: L.cols, rows: L.rows, hasSubject };
}
