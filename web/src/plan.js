/** Pure planning helpers: limits, trim, sizes, cost model, adaptive preview. No DOM. */
import { CW, CH } from "./core.js";
import { clamp } from "./util.js";

export const LIMITS = Object.freeze({
  maxSeconds: 15,
  maxBytes: 100 * 1024 * 1024,
  maxLong: 1920,
  minCols: 30,
  previewBudgetMs: 85,
});

const MB = 1024 * 1024;
/** Shortest trim window, in seconds. */
const MIN_TRIM = 0.1;
/** Playback within this many seconds of the trim end counts as having reached it. */
const END_SLACK = 0.02;

/** Message for a file over the size limit, or null when it fits. @param {number} bytes */
export const fileSizeProblem = (bytes) =>
  bytes > LIMITS.maxBytes ? `File too large (${Math.round(bytes / MB)} MB). The limit is ${LIMITS.maxBytes / MB} MB.` : null;

/** Frame rates offered in the export panel (video <= 30 fps, GIF <= 15 fps). */
export const FPS_CHOICES = Object.freeze({ video: [12, 15, 24, 30], gif: [8, 10, 12, 15] });

/**
 * GIF frame delay in ms for frame `i`. GIF delays are whole centiseconds, so the
 * rounding error is carried between frames and the total duration stays exact.
 * @param {number} i @param {number} fps
 */
export const gifDelayMs = (i, fps) => (Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps)) * 10;

/** Notice shown when the video is longer than the export limit, else "". @param {number} duration */
export const cutNotice = (duration) =>
  duration > LIMITS.maxSeconds ? `video is ${duration.toFixed(1)} s, exports at most ${LIMITS.maxSeconds} s · ` : "";

/** @param {number} t @param {{start: number, end: number}} trim */
export const atTrimEnd = (t, trim) => t >= trim.end - END_SLACK;

/** Where playback should resume: from the start when it is already at the trim end. */
export const resumeTime = (/** @type {number} */ t, /** @type {{start: number, end: number}} */ trim) => (atTrimEnd(t, trim) || t < trim.start ? trim.start : t);

/** Latest start that still leaves a minimal window. */
const lastStart = (/** @type {number} */ duration) => Math.max(0, duration - MIN_TRIM);

/**
 * Trim window after the user moves its start: the length is kept, the end follows.
 * @param {{start: number, end: number}} prev @param {number} newStart @param {number} duration
 */
export function shiftTrim(prev, newStart, duration) {
  const start = clamp(Number.isFinite(newStart) ? newStart : 0, 0, lastStart(duration));
  return clampTrim(start, start + (prev.end - prev.start), duration);
}

/** Time on a track of `duration` seconds at horizontal position `x` in a bar of `width` px. */
export const timeAt = (/** @type {number} */ x, /** @type {number} */ width, /** @type {number} */ duration) =>
  width > 0 && duration > 0 ? clamp((x / width) * duration, 0, duration) : 0;

/**
 * Keep the trim window inside the video and at most `maxSeconds` long.
 * @param {number} start @param {number} end @param {number} duration
 */
export function clampTrim(start, end, duration) {
  const s = clamp(Number.isFinite(start) ? start : 0, 0, lastStart(duration));
  const e = clamp(Number.isFinite(end) ? end : duration, s + MIN_TRIM, Math.max(duration, s + MIN_TRIM));
  return { start: s, end: Math.min(e, s + LIMITS.maxSeconds) };
}

/** @param {number} start @param {number} end @param {number} fps */
export const frameCount = (start, end, fps) => Math.max(1, Math.floor((end - start) * fps + 1e-6));

/** Timestamp sampled at the middle of frame i's interval (immune to seek rounding). */
export const frameTime = (/** @type {number} */ start, /** @type {number} */ end, /** @type {number} */ i, /** @type {number} */ fps) =>
  Math.min(end - 0.001, start + (i + 0.5) / fps);

/**
 * Output pixel size (even numbers). Either by target width (GIF) or by shorter side (video),
 * never beyond maxLong on the long side.
 * @param {{cols: number, rows: number}} grid
 * @param {{shortSide?: number, width?: number}} target
 */
export function exportSize(grid, target) {
  const natW = grid.cols * CW, natH = grid.rows * CH;
  let scale = target.width ? target.width / natW : (target.shortSide || 720) / Math.min(natW, natH);
  scale = Math.min(scale, LIMITS.maxLong / Math.max(natW, natH));
  const even = (/** @type {number} */ v) => Math.max(2, 2 * Math.round(v / 2));
  return { width: even(natW * scale), height: even(natH * scale) };
}

/** @param {number} w @param {number} h @param {number} fps bits per second */
export const bitrate = (w, h, fps) => Math.round(clamp(w * h * fps * 0.12, 1.5e6, 25e6));

/** H.264 High profile codec string with a level that fits the frame size. */
export function avcCodec(/** @type {number} */ w, /** @type {number} */ h) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  return "avc1.6400" + (mbs <= 8192 ? "28" : mbs <= 22080 ? "32" : "33");
}

/**
 * Cost model from two benchmark samples: one in full-resolution mode (<= 100 cols),
 * one in half-resolution mode. Cost scales with the number of cells (cols^2).
 * @param {{cols: number, ms: number}[]} samples
 * @returns {(cols: number) => number} ms per frame
 */
export function costModel(samples) {
  return (cols) => {
    const full = cols <= 100;
    const ref = samples.find((s) => (s.cols <= 100) === full) || samples[0];
    return ref.ms * (cols / ref.cols) ** 2;
  };
}

/** Largest column count whose predicted cost fits the preview budget. */
export function initialPreviewCap(/** @type {(c: number) => number} */ model, /** @type {number} */ density) {
  let cap = LIMITS.minCols;
  for (let c = LIMITS.minCols; c <= density; c++) if (model(c) <= LIMITS.previewBudgetMs) cap = c;
  return cap;
}

/**
 * Adapt the preview column cap to the measured moving-average frame time.
 * @param {number} cap @param {number} emaMs @param {number} density
 */
export function adaptCap(cap, emaMs, density) {
  if (emaMs > 110) return Math.max(LIMITS.minCols, Math.floor(cap * 0.8));
  if (emaMs < 55 && cap < density) return Math.min(density, Math.ceil(cap * 1.15) + 1);
  return cap;
}

/**
 * Predicted export duration in ms. Workers compute grids in parallel while the main thread
 * seeks, paints and encodes serially, so the slower of the two stages sets the pace.
 * @param {(cols: number) => number} model @param {number} frames @param {number} cols
 * @param {number} workers @param {number} seekMs measured cost of one forward seek
 */
export function exportEstimateMs(model, frames, cols, workers, seekMs) {
  return frames * Math.max((model(cols) / workers) * 1.15, seekMs + 20);
}

/** Keeps the preview's column cap in step with what this machine can render while playing. */
export class PreviewGovernor {
  /** @param {(cols: number) => number} model predicted ms per frame */
  constructor(model) {
    this.model = model;
    /** @type {number | null} */
    this.cap = null;
    this.ema = 0;
    this.samples = 0;
  }

  /** Columns to render now: the slider value when paused, capped while playing. */
  cols(/** @type {number} */ density, /** @type {boolean} */ playing) {
    if (!playing) return density;
    this.cap ??= initialPreviewCap(this.model, density);
    return Math.min(density, this.cap);
  }

  /** Feed the measured time of a played frame; adapts the cap every 6 frames. */
  record(/** @type {number} */ ms, /** @type {number} */ density) {
    this.ema = this.samples ? 0.7 * this.ema + 0.3 * ms : ms;
    if (++this.samples < 6) return;
    this.cap = adaptCap(this.cap ?? density, this.ema, density);
    this.samples = 0;
  }
}
