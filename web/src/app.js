import { CW, CH, gridToText } from "./core.js";
import { $, isPressed, setPressed } from "./dom.js";
import { Pool, latestWins } from "./pool.js";
import { fileSizeProblem } from "./plan.js";
import { frameRequest, paintGrid } from "./render.js";
import { createVideoSession } from "./video.js";
import { DEFAULT_LOOK, densityLabel, edgesLabel, zoomLabel } from "./defaults.js";
import { exampleZoomDataURL, mountExamples } from "./examples.js";

/** @typedef {import("./pool.js").TimedGrid} TimedGrid */
/** @typedef {import("./frames.js").FrameSource} FrameSource */
/** @typedef {import("./render.js").Look} Look */

const canvas = /** @type {HTMLCanvasElement} */ ($("out"));
const pool = new Pool(__WORKER_SOURCE__, 1);
/** @type {FrameSource | null} */ let imageSource = null;
/** @type {"image" | "video"} */ let mediaKind = "image";
/** @type {TimedGrid | null} */ let grid = null;
let loadSeq = 0; // bumps on every file choice so a slower, older load cannot overwrite a newer one
let renders = 0;
let stats = {};

/** @returns {Look} */
const look = () => ({ edgeGain: +$("edges").value / 100, separate: isPressed($("sep")), mono: isPressed($("mono")), glow: isPressed($("glow")) });
let stickyStatus = false; // user-facing errors must not be overwritten by the next render
/** @param {string} t @param {boolean} [sticky] */
const setStatus = (t, sticky = false) => {
  if (stickyStatus && !sticky) return;
  stickyStatus = sticky;
  $("status").textContent = t;
};

const session = createVideoSession({
  video: /** @type {HTMLVideoElement} */ ($("sourceVideo")),
  workerSource: __WORKER_SOURCE__,
  look,
  density: () => +$("density").value,
  requestRender: () => runner.request(undefined),
  bench: async (cols) => (await computeFrame(cols)).ms,
  save: download,
});

/** The frame source to render, or null while nothing can be rendered yet. */
const currentSource = () => (mediaKind === "video" ? (session.ready ? session.video : null) : imageSource);

/** Compute (not draw) one frame at `cols`. @param {number} cols */
async function computeFrame(cols) {
  const src = /** @type {FrameSource} */ (currentSource() ?? session.video);
  const t0 = performance.now();
  const req = frameRequest(src, cols, look());
  const resizeMs = performance.now() - t0;
  const g = await pool.run(req);
  return { grid: g, resizeMs, ms: performance.now() - t0 };
}

const runner = latestWins(async () => {
  if (!currentSource()) return;
  const seq = loadSeq;
  if (!session.playing) $("busy").classList.add("on");
  const r = await computeFrame(session.cols(+$("density").value));
  if (seq !== loadSeq || !currentSource()) return;
  grid = r.grid;
  const t1 = performance.now();
  draw();
  session.record(r.ms);
  stats = { renders: ++renders, cols: grid.cols, rows: grid.rows, resizeMs: +r.resizeMs.toFixed(1), workerMs: +grid.workerMs.toFixed(1),
    drawMs: +(performance.now() - t1).toFixed(1), totalMs: +r.ms.toFixed(1), hasSubject: grid.hasSubject, playing: session.playing };
  setStatus(`${grid.cols} × ${grid.rows} characters · ${Math.round(r.ms)} ms`);
}, { onIdle: () => $("busy").classList.remove("on") });

/** Size the canvas for the stage and repaint the current grid. */
function draw() {
  if (!grid) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const wrapW = Math.max(1, $("stage").clientWidth - 40), wrapH = Math.max(1, $("stage").clientHeight - 24);
  const fit = Math.min(wrapW / (grid.cols * CW), wrapH / (grid.rows * CH), 1.6);
  const z = +$("zoom").value / 100, cssCw = CW * fit * z, cssCh = CH * fit * z;
  const cap = Math.min(1, 8192 / (grid.cols * cssCw * dpr), 8192 / (grid.rows * cssCh * dpr));
  const cw = Math.max(1, Math.floor(cssCw * dpr * cap)), ch = Math.max(1, Math.floor(cssCh * dpr * cap));
  if (canvas.width !== grid.cols * cw || canvas.height !== grid.rows * ch) {
    canvas.width = grid.cols * cw;
    canvas.height = grid.rows * ch;
  }
  canvas.style.width = `${grid.cols * cssCw}px`;
  canvas.style.height = `${grid.rows * cssCh}px`;
  paintGrid(/** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d")), grid, cw, ch, look());
}

/** @param {Blob} blob @param {string} ext @param {number} [cols] */
function download(blob, ext, cols = grid?.cols ?? 0) {
  const d = new Date(), p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ascii-${cols}col-${stamp}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/**
 * Background separation suits a subject on a plain backdrop (photos); full-frame video looks
 * better without it, so the default follows the kind of media last opened.
 * @param {"image" | "video"} kind
 */
function useMediaKind(kind) {
  if (kind !== mediaKind) setPressed($("sep"), kind === "image");
  mediaKind = kind;
}

/** Decode and cap at 2400 px so huge photos stay cheap to resample. @param {Blob} blob */
async function decodeImage(blob) {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }).catch(() => createImageBitmap(blob));
  const s = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  if (s === 1) return bmp;
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  const x = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  x.imageSmoothingQuality = "high";
  x.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

/** @param {Blob} blob @param {string} name @returns {Promise<boolean>} */
async function loadImageBlob(blob, name, seq = ++loadSeq) {
  const decoded = await decodeImage(blob);
  if (seq !== loadSeq) {
    if (decoded instanceof ImageBitmap) decoded.close();
    return false;
  }
  useMediaKind("image");
  session.detach();
  if (imageSource instanceof ImageBitmap) imageSource.close();
  imageSource = decoded;
  $("foot").textContent = `Image: ${name} · Processed locally; nothing is uploaded. The downloaded .txt is plain ASCII (no colour).`;
  return true;
}

const isHome = () => document.body.classList.contains("home");

/** @param {string} msg */
const showError = (msg) => {
  setStatus(msg, true);
  if (isHome()) $("homeStatus").textContent = msg;
};

function enterEditor() {
  $("homeStatus").textContent = "";
  document.body.classList.remove("home");
  setControlsEnabled(true);
  requestAnimationFrame(() => { if (grid) draw(); else runner.request(undefined); });
}

/** Reset sliders and toggles to the starting look. */
function applyLookDefaults() {
  const d = DEFAULT_LOOK;
  setPressed($("sep"), d.sep);
  setPressed($("mono"), d.mono);
  setPressed($("glow"), d.glow);
  $("density").value = String(d.density);
  $("densityVal").textContent = densityLabel(d.density);
  $("zoom").value = String(d.zoom);
  $("zoomVal").textContent = zoomLabel(d.zoom);
  $("edges").value = String(d.edges);
  $("edgesVal").textContent = edgesLabel(d.edges);
  fillRanges();
}

/** Enable or disable the sidebar controls. The close button stays usable on a narrow screen. @param {boolean} on */
function setControlsEnabled(on) {
  const box = $("sidebarControls");
  box.toggleAttribute("inert", !on);
  box.setAttribute("aria-disabled", String(!on));
  for (const el of box.querySelectorAll("button, input, select")) el.disabled = !on;
}

/** Clear the session and return to the empty home screen. */
function resetSession() {
  loadSeq++;
  stickyStatus = false;
  session.detach();
  if (imageSource instanceof ImageBitmap) imageSource.close();
  imageSource = null;
  grid = null;
  renders = 0;
  stats = {};
  setStatus("");
  $("foot").textContent = "";
  $("homeStatus").textContent = "";
  canvas.width = 0;
  canvas.height = 0;
  canvas.removeAttribute("style");
  $("file").value = "";
  mediaKind = "image";
  applyLookDefaults();
  setControlsEnabled(false);
  setSidebar(false);
  document.body.classList.add("home");
  window.scrollTo(0, 0);
}

/** @param {File | undefined} file */
async function loadFile(file) {
  if (!file) return;
  stickyStatus = false;
  $("homeStatus").textContent = "";
  const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
  const isImage = file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name);
  if (!isVideo && !isImage) { showError("That file doesn't look like an image or a video."); return; }
  const tooBig = fileSizeProblem(file.size);
  if (tooBig) { showError(tooBig); return; }
  const fromHome = isHome();
  const prevKind = mediaKind, prevSep = isPressed($("sep"));
  const seq = ++loadSeq;
  try {
    if (fromHome) applyLookDefaults();
    if (fromHome) $("homeStatus").textContent = isVideo ? "Measuring this machine…" : "Opening…";
    if (isVideo) {
      setStatus("Measuring this machine…");
      useMediaKind("video");
      await session.attach(file);
      if (seq !== loadSeq) return;
      $("foot").textContent = `Video: ${file.name} · Processed locally; no audio. Export when you like the preview.`;
    } else if (!await loadImageBlob(file, file.name, seq)) return;
    if (seq !== loadSeq) return;
    enterEditor();
  } catch (e) {
    if (seq !== loadSeq) return;
    if (isVideo && imageSource) { // the failed video must not take the image off the stage
      mediaKind = "image";
      setPressed($("sep"), prevKind === "image" ? prevSep : true);
      enterEditor();
      runner.request(undefined);
    }
    showError(/** @type {Error} */ (e).message);
  }
}

/** Paint the filled part of a range track (Chrome has no native progress pseudo-element). @param {HTMLInputElement} el */
function fillRange(el) { el.style.setProperty("--p", `${((+el.value - +el.min) / (+el.max - +el.min)) * 100}%`); }
function fillRanges() { for (const id of ["density", "edges", "zoom"]) fillRange(/** @type {HTMLInputElement} */ ($(id))); }
document.addEventListener("input", (e) => { if (e.target instanceof HTMLInputElement && e.target.type === "range") fillRange(e.target); });
fillRanges();

for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll("[data-tab]")) t.setAttribute("aria-selected", String(t === tab));
    for (const p of document.querySelectorAll("[data-panel]")) /** @type {HTMLElement} */ (p).hidden = p.getAttribute("data-panel") !== tab.getAttribute("data-tab");
  });
}

$("themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch { /* private mode: theme lasts for this visit */ }
});

// Star count is a nice-to-have: any failure (offline, rate limit) just leaves the plain "Star" button.
fetch("https://api.github.com/repos/pseudonym-dev/ASCII-Studio")
  .then((r) => (r.ok ? r.json() : null))
  .then((repo) => {
    if (typeof repo?.stargazers_count !== "number") return;
    $("ghStars").textContent = new Intl.NumberFormat("en", { notation: "compact" }).format(repo.stargazers_count);
    $("ghStars").hidden = false;
  })
  .catch(() => {});

const redrawSoon = (() => { let raf = 0; return () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }; })();

$("density").addEventListener("input", () => { $("densityVal").textContent = densityLabel(+$("density").value); session.refresh(); runner.request(undefined); });
$("edges").addEventListener("input", () => { $("edgesVal").textContent = edgesLabel(+$("edges").value); runner.request(undefined); });
$("zoom").addEventListener("input", () => { $("zoomVal").textContent = zoomLabel(+$("zoom").value); redrawSoon(); });
window.addEventListener("resize", redrawSoon);
for (const id of ["mono", "glow"]) $(id).addEventListener("click", () => { setPressed($(id), !isPressed($(id))); redrawSoon(); });
$("sep").addEventListener("click", () => { setPressed($("sep"), !isPressed($("sep"))); runner.request(undefined); });
$("file").addEventListener("change", () => { const f = $("file").files[0]; $("file").value = ""; loadFile(f); });
for (const id of ["fileBtn", "homeFileBtn"]) $(id).addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
$("homeBtn").addEventListener("click", resetSession);
/** @param {boolean} on */
const markDrag = (on) => {
  $("dropzone").classList.toggle("drag", on && isHome());
  $("stage").classList.toggle("drag", on && !isHome());
};
for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, (e) => { e.preventDefault(); markDrag(true); });
for (const ev of ["dragleave", "drop"]) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || !(/** @type {DragEvent} */ (e)).relatedTarget) markDrag(false); });
document.addEventListener("drop", (e) => loadFile(e.dataTransfer?.files[0]));
document.addEventListener("paste", (e) => loadFile(Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith("image/"))));

function pngCanvas() {
  const g = /** @type {TimedGrid} */ (grid);
  const scale = g.cols > 140 ? 1 : 2, c = document.createElement("canvas");
  c.width = g.cols * CW * scale;
  c.height = g.rows * CH * scale;
  paintGrid(/** @type {CanvasRenderingContext2D} */ (c.getContext("2d")), g, CW * scale, CH * scale, look());
  return c;
}
$("dlPng").addEventListener("click", () => grid && pngCanvas().toBlob((b) => b && download(b, "png"), "image/png"));
$("dlTxt").addEventListener("click", () => grid && download(new Blob([gridToText(grid) + "\n"], { type: "text/plain;charset=utf-8" }), "txt"));
$("copy").addEventListener("click", async () => {
  if (!grid) return;
  const label = $("copyLabel"), old = label.textContent, text = gridToText(grid);
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { ok = document.execCommand("copy"); } catch { /* clipboard unavailable */ }
    ta.remove();
  }
  label.textContent = ok ? "Copied!" : "Couldn't copy";
  setTimeout(() => { label.textContent = old; }, 1500);
});

/** Read-only handle for the end-to-end tests. */
Object.defineProperty(window, "ASCII", {
  value: {
    get stats() { return stats; },
    get text() { return grid ? gridToText(grid) : ""; },
    get lastExport() { return session.lastExport; },
    get sepOn() { return isPressed($("sep")); },
    get mode() { return isHome() ? "home" : "editor"; },
    pngDataURL: () => pngCanvas().toDataURL("image/png"),
    exampleZoomDataURL,
  },
});

/** Keep in sync with the @media (max-width: 860px) rule in template.html. */
const narrowUi = window.matchMedia("(max-width: 860px)");
const setSidebar = (/** @type {boolean} */ open) => {
  document.body.classList.toggle("sidebar-open", open);
  $("menuBtn").setAttribute("aria-expanded", String(open));
};
$("menuBtn").addEventListener("click", () => setSidebar(!document.body.classList.contains("sidebar-open")));
$("closeSidebar").addEventListener("click", () => setSidebar(false));
$("scrim").addEventListener("click", () => setSidebar(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setSidebar(false); });
narrowUi.addEventListener("change", () => { if (!narrowUi.matches) setSidebar(false); });

mountExamples(loadFile, () => loadSeq);
setControlsEnabled(false);
