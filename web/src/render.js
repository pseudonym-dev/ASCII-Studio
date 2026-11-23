import { CW, CH, RAMP, frameLayout, glyphChar } from "./core.js";
import { framePixels, sourceSize } from "./frames.js";
import { luma } from "./util.js";

/** @typedef {import("./core.js").Grid} Grid */
/** @typedef {import("./frames.js").FrameSource} FrameSource */
/** @typedef {{edgeGain: number, separate: boolean, mono: boolean, glow: boolean}} Look */

export const FONT = '"DejaVu Sans Mono","Menlo","Consolas","Liberation Mono",ui-monospace,monospace';
const FONT_PX = 20;
const BASE_Y = 15.56;
const CHARS = Array.from({ length: 96 }, (_, i) => glyphChar(i));

/** @type {Map<string, Float32Array>} */
const atlasCache = new Map();

/**
 * Coverage masks of the ramp glyphs at SW x SH, used by the worker to break ties by shape.
 * @param {number} SW @param {number} SH
 */
export function getAtlas(SW, SH) {
  const key = `${SW}x${SH}`;
  const cached = atlasCache.get(key);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = CW; c.height = CH;
  const x = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d", { willReadFrequently: true }));
  const f = CW / SW, area = SW * SH;
  const atlas = new Float32Array(RAMP.length * area);
  x.font = `${FONT_PX}px ${FONT}`;
  x.textBaseline = "alphabetic";
  for (let k = 0; k < RAMP.length; k++) {
    x.clearRect(0, 0, CW, CH);
    x.fillStyle = "#fff";
    x.fillText(RAMP[k], 0, BASE_Y);
    const d = x.getImageData(0, 0, CW, CH).data;
    for (let py = 0; py < SH; py++) {
      for (let px = 0; px < SW; px++) {
        let s = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += d[((py * f + j) * CW + px * f + i) * 4 + 3];
        atlas[k * area + py * SW + px] = s / (f * f) / 255;
      }
    }
  }
  atlasCache.set(key, atlas);
  return atlas;
}

/** @type {HTMLCanvasElement | null} */
let glowScratch = null;

/**
 * Draw a grid. Cell size may be fractional. Glow adds two blurred, downscaled copies.
 * @param {CanvasRenderingContext2D} ctx @param {Grid} grid @param {number} cw @param {number} ch
 * @param {Pick<Look, "mono" | "glow">} opts
 */
export function paintGrid(ctx, grid, cw, ch, opts) {
  const W = grid.cols * cw, H = grid.rows * ch;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.font = `${(ch / CH) * FONT_PX}px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const by = (BASE_Y / CH) * ch;
  const { glyphs, ink } = grid;
  for (let r = 0, i = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++, i++) {
      if (!glyphs[i]) continue;
      let R = ink[i * 3], G = ink[i * 3 + 1], B = ink[i * 3 + 2];
      if (opts.mono) R = G = B = Math.min(255, Math.round(40 + luma(R, G, B) * 1.05));
      ctx.fillStyle = `rgb(${R},${G},${B})`;
      ctx.fillText(CHARS[glyphs[i]], c * cw, r * ch + by);
    }
  }
  if (opts.glow) paintGlow(ctx, W, H);
}

/** @param {CanvasRenderingContext2D} ctx @param {number} W @param {number} H */
function paintGlow(ctx, W, H) {
  glowScratch ??= document.createElement("canvas");
  glowScratch.width = Math.max(8, Math.round(W / 4));
  glowScratch.height = Math.max(8, Math.round(H / 4));
  /** @type {CanvasRenderingContext2D} */ (glowScratch.getContext("2d")).drawImage(ctx.canvas, 0, 0, W, H, 0, 0, glowScratch.width, glowScratch.height);
  const s = W / 1920;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.filter = `blur(${6.4 * s}px)`;
  ctx.globalAlpha = 0.28;
  ctx.drawImage(glowScratch, 0, 0, W, H);
  ctx.filter = `blur(${22 * s}px)`;
  ctx.globalAlpha = 0.126;
  ctx.drawImage(glowScratch, 0, 0, W, H);
  ctx.restore();
}

/**
 * Sample `src` at `cols` columns and package it for a worker (shared by preview and export).
 * @param {FrameSource} src @param {number} cols @param {Look} look
 * @returns {import("./core.js").GridRequest}
 */
export function frameRequest(src, cols, look) {
  const { width, height } = sourceSize(src);
  const layout = frameLayout(width, height, cols);
  const rgba = framePixels(src, layout.cols * layout.SW, layout.rows * layout.SH);
  return { rgba, layout, atlas: getAtlas(layout.SW, layout.SH), edgeGain: look.edgeGain, separate: look.separate };
}
