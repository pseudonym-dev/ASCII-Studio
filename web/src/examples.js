import { CW, CH } from "./core.js";
import { unpackClip, gunzip } from "./clip.js";
import { DEFAULT_LOOK } from "./defaults.js";
import { $ } from "./dom.js";
import { LIMITS } from "./plan.js";
import { paintGrid } from "./render.js";

/**
 * @typedef {object} ExampleClip
 * @property {string} title
 * @property {string} credit
 * @property {string} href
 * @property {string} filename
 * @property {string} clip  gzipped ASX1, base64
 * @property {string | null} source  data URL of the original video, if inlined
 * @property {number} sourceBytes
 */

/** @param {string} s */
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const motionOk = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** @type {WeakMap<HTMLCanvasElement, import("./clip.js").PackedFrame & {cols: number, rows: number}>} */
const painted = new WeakMap();

/** @type {WeakMap<HTMLCanvasElement, HTMLCanvasElement>} */
const buffers = new WeakMap();

/**
 * Draw `grid` covering a 16:9 canvas, cropping overflow (object-fit: cover).
 * Glow is painted on an offscreen canvas so it is not clipped or offset by the cover crop.
 * @param {HTMLCanvasElement} canvas
 * @param {import("./clip.js").PackedFrame & {cols: number, rows: number}} grid
 */
function paintCover(canvas, grid) {
  const cssW = Math.max(1, canvas.clientWidth), cssH = Math.max(1, canvas.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pxW = Math.max(1, Math.round(cssW * dpr)), pxH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) { canvas.width = pxW; canvas.height = pxH; }
  const scale = Math.max(cssW / (grid.cols * CW), cssH / (grid.rows * CH));
  const gridW = Math.max(1, Math.round(grid.cols * CW * scale * dpr));
  const gridH = Math.max(1, Math.round(grid.rows * CH * scale * dpr));
  let buf = buffers.get(canvas);
  if (!buf) { buf = document.createElement("canvas"); buffers.set(canvas, buf); }
  if (buf.width !== gridW || buf.height !== gridH) { buf.width = gridW; buf.height = gridH; }
  paintGrid(/** @type {CanvasRenderingContext2D} */ (buf.getContext("2d")), { ...grid, hasSubject: true }, gridW / grid.cols, gridH / grid.rows, { mono: DEFAULT_LOOK.mono, glow: DEFAULT_LOOK.glow });
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, pxW, pxH);
  const s = Math.max(pxW / gridW, pxH / gridH);
  const dw = gridW * s, dh = gridH * s;
  ctx.drawImage(buf, (pxW - dw) / 2, (pxH - dh) / 2, dw, dh);
  painted.set(canvas, grid);
}

/**
 * Home-screen inspiration clips, painted live from packed grids.
 * A clip is decompressed only once it is near the viewport.
 * @param {(file: File) => void | Promise<void>} openFile
 * @param {() => number} [generation]  if provided, a click is ignored when this changes during open
 */
export function mountExamples(openFile, generation = () => 0) {
  const root = $("exampleGrid");
  const clips = /** @type {ExampleClip[]} */ (__EXAMPLES__);
  /** @type {WeakMap<HTMLElement, (on: boolean) => void>} */
  const plays = new WeakMap();

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      plays.get(/** @type {HTMLElement} */ (e.target))?.(e.isIntersecting);
    }
  }, { rootMargin: "80px 0px", threshold: 0.25 });

  for (const clip of clips) {
    const fig = document.createElement("figure");
    const canvas = document.createElement("canvas");
    canvas.className = "example-stage";
    canvas.setAttribute("aria-label", clip.title);
    const cap = document.createElement("figcaption");
    const title = document.createElement("strong");
    title.textContent = clip.title;
    const link = document.createElement("a");
    link.href = clip.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = clip.credit;
    link.addEventListener("click", (e) => e.stopPropagation());
    cap.append(title, document.createTextNode(" — "), link);
    fig.append(canvas, cap);

    /** @type {import("./clip.js").PackedClip | null} */
    let data = null;
    let frame = 0, raf = 0, t0 = 0, playing = false;
    const gridAt = (/** @type {number} */ i) => {
      const clipData = /** @type {NonNullable<typeof data>} */ (data);
      const f = clipData.frames[i];
      return { cols: clipData.cols, rows: clipData.rows, glyphs: f.glyphs, ink: f.ink };
    };
    const draw = () => { if (data?.frames[frame]) paintCover(canvas, gridAt(frame)); };
    const stop = () => { playing = false; if (raf) cancelAnimationFrame(raf); raf = 0; };
    const tick = (/** @type {number} */ now) => {
      if (!playing || !data) return;
      const n = data.frames.length;
      const i = ((Math.floor(Math.max(0, now - t0) / 1000 * data.fps) % n) + n) % n;
      if (i !== frame) { frame = i; draw(); }
      raf = requestAnimationFrame(tick);
    };
    const ensure = async () => {
      if (data) return;
      data = unpackClip(await gunzip(fromBase64(clip.clip)));
      canvas.dataset.ready = "1";
    };
    /** @param {boolean} on */
    const play = async (on) => {
      if (!on) { stop(); return; }
      try { await ensure(); } catch (e) { console.error(e); return; }
      if (!data) return;
      frame = 0;
      draw();
      if (!motionOk() || data.frames.length < 2) return;
      t0 = performance.now();
      stop();
      playing = true;
      raf = requestAnimationFrame(tick);
    };
    plays.set(fig, play);

    const source = clip.source;
    if (source && clip.sourceBytes <= LIMITS.maxBytes) {
      fig.classList.add("openable");
      fig.addEventListener("click", () => openFromData(source, clip.filename, openFile, generation));
    }
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    root.append(fig);
    io.observe(fig);
  }
}

/** @param {string} url @param {string} name @param {(file: File) => void | Promise<void>} openFile @param {() => number} generation */
async function openFromData(url, name, openFile, generation) {
  const g = generation();
  const blob = await (await fetch(url)).blob();
  if (g !== generation()) return;
  await openFile(new File([blob], name, { type: blob.type || "video/mp4" }));
}

/** Sharp zoom of the first example, for screenshots and tests. @param {number} [scale] */
export function exampleZoomDataURL(scale = 4) {
  const canvas = document.querySelector("#exampleGrid canvas");
  const grid = canvas instanceof HTMLCanvasElement ? painted.get(canvas) : undefined;
  if (!grid) return "";
  const cols = Math.min(grid.cols, 18), rows = Math.min(grid.rows, 10);
  const col0 = Math.max(0, Math.floor((grid.cols - cols) / 2));
  const row0 = Math.max(0, Math.floor((grid.rows - rows) / 2));
  const glyphs = new Uint8Array(cols * rows);
  const ink = new Uint8Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = (row0 + r) * grid.cols + (col0 + c), d = r * cols + c;
      glyphs[d] = grid.glyphs[s];
      ink[d * 3] = grid.ink[s * 3];
      ink[d * 3 + 1] = grid.ink[s * 3 + 1];
      ink[d * 3 + 2] = grid.ink[s * 3 + 2];
    }
  }
  const cw = CW * scale, ch = CH * scale;
  const out = document.createElement("canvas");
  out.width = cols * cw;
  out.height = rows * ch;
  paintGrid(/** @type {CanvasRenderingContext2D} */ (out.getContext("2d")), { cols, rows, glyphs, ink, hasSubject: true }, cw, ch, { mono: DEFAULT_LOOK.mono, glow: DEFAULT_LOOK.glow });
  return out.toDataURL("image/png");
}
