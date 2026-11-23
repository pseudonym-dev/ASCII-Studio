import { frameLayout } from "./core.js";
import { $, isPressed, setPressed } from "./dom.js";
import { exportVideo } from "./exporter.js";
import { openVideo, seekTo } from "./frames.js";
import { clamp } from "./util.js";
import { FPS_CHOICES, PreviewGovernor, atTrimEnd, clampTrim, costModel, cutNotice, exportEstimateMs, exportSize, frameCount, resumeTime, shiftTrim, timeAt } from "./plan.js";

/** @typedef {import("./render.js").Look} Look */

/**
 * @typedef {object} VideoDeps
 * @property {HTMLVideoElement} video  hidden element that decodes the preview
 * @property {() => void} requestRender  ask the app to render the current frame
 * @property {(cols: number) => Promise<number>} bench  ms to compute one frame at `cols`
 * @property {() => number} density
 * @property {() => Look} look
 * @property {string} workerSource
 * @property {(blob: Blob, ext: string, cols: number) => void} save
 */

/**
 * @typedef {object} ExportResult
 * @property {string} format @property {number} bytes @property {number} ms @property {number} frames
 * @property {string} codec @property {boolean} realtime @property {number} width @property {number} height
 * @property {number} fps @property {number} cols
 * @property {{seekMs: number, pixelsMs: number, paintMs: number, encodeMs: number}} timing
 */

const fmtSeconds = (/** @type {number} */ s) => s.toFixed(1);
const poolSize = () => Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));

/**
 * Video preview + export panel. The app owns rendering; this owns the <video>, the
 * trim window, the adaptive preview density and the export job.
 * @param {VideoDeps} d
 */
export function createVideoSession(d) {
  const { video } = d;
  const bar = $("videoBar"), exportBar = $("exportBar"), topExport = $("topExport");
  /** @type {string | null} */ let url = null;
  let duration = 0, generation = 0, loop = true, ready = false, seekMs = 0;
  /** @type {PreviewGovernor | null} */ let governor = null;
  /** @type {((cols: number) => number) | null} */ let model = null;
  /** @type {AbortController | null} */ let job = null;
  let dims = { width: 0, height: 0 };
  let trimWin = { start: 0, end: 0 };

  const readTrim = () => clampTrim(parseFloat($("tStart").value), parseFloat($("tEnd").value), duration);
  /** @param {{start: number, end: number}} t */
  function writeTrim(t) {
    trimWin = t;
    $("tStart").value = fmtSeconds(t.start);
    $("tEnd").value = fmtSeconds(t.end);
    if (video.currentTime < t.start || video.currentTime > t.end) video.currentTime = t.start;
    paintTimeline();
  }

  /** Paint the trim span and playhead as percentages of the full duration. */
  function paintTimeline() {
    if (!duration) return;
    $("timelineSpan").style.left = `${(trimWin.start / duration) * 100}%`;
    $("timelineSpan").style.width = `${((trimWin.end - trimWin.start) / duration) * 100}%`;
    $("playhead").style.left = `${(clamp(video.currentTime, 0, duration) / duration) * 100}%`;
  }

  /** @param {PointerEvent} ev */
  const timeAtPointer = (ev) => {
    const r = $("timelineTrack").getBoundingClientRect();
    return timeAt(ev.clientX - r.left, r.width, duration);
  };

  /**
   * Drag a trim handle, slide the window, or scrub the playhead.
   * @param {"start" | "end" | "shift" | "play"} mode
   * @param {PointerEvent} ev0
   */
  function dragTimeline(mode, ev0) {
    ev0.preventDefault();
    ev0.stopPropagation();
    const grab = timeAtPointer(ev0) - (mode === "shift" ? trimWin.start : 0);
    const move = (/** @type {PointerEvent} */ ev) => {
      const t = timeAtPointer(ev);
      if (mode === "start") writeTrim(clampTrim(t, trimWin.end, duration));
      else if (mode === "end") writeTrim(clampTrim(trimWin.start, t, duration));
      else if (mode === "shift") writeTrim(shiftTrim(trimWin, t - grab, duration));
      else video.currentTime = clamp(t, trimWin.start, trimWin.end);
      tick();
      updateInfo();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(ev0);
  }

  function fillFps() {
    const gif = $("fmt").value === "gif";
    const choices = gif ? FPS_CHOICES.gif : FPS_CHOICES.video;
    $("fps").innerHTML = choices.map((f) => `<option value="${f}">${f}</option>`).join("");
    $("fps").value = String(gif ? 12 : 24);
    $("resCtl").hidden = gif;
    $("gifCtl").hidden = !gif;
  }

  function exportPlan() {
    const t = readTrim(), fps = +$("fps").value, gif = $("fmt").value === "gif";
    const layout = frameLayout(dims.width, dims.height, d.density());
    const size = exportSize(layout, gif ? { width: +$("gifw").value } : { shortSide: +$("res").value });
    return { t, fps, layout, size, frames: frameCount(t.start, t.end, fps) };
  }

  function updateInfo() {
    if (!model || !ready) return;
    const p = exportPlan();
    const secs = Math.max(1, Math.round(exportEstimateMs(model, p.frames, p.layout.cols, poolSize(), seekMs) / 1000));
    $("exportInfo").textContent = `${cutNotice(duration)}${p.frames} frames · ${p.size.width}×${p.size.height} · ${p.layout.cols} col · export takes ≈ ${secs} s on this machine`;
  }

  /** Per presented frame: loop/stop at the trim end, then refresh the transport UI. */
  function tick() {
    const t = trimWin;
    if (!video.paused && atTrimEnd(video.currentTime, t)) {
      if (loop) video.currentTime = t.start; else video.pause();
    }
    const pos = clamp(video.currentTime - t.start, 0, t.end - t.start);
    $("scrub").value = String(Math.round((pos / (t.end - t.start)) * 1000));
    $("timeVal").textContent = `${fmtSeconds(pos)} / ${fmtSeconds(t.end - t.start)} s`;
    $("playLabel").textContent = video.paused ? "Play" : "Pause";
    $("playIcon").setAttribute("href", video.paused ? "#i-play" : "#i-pause");
    if (ready) $("prevInfo").textContent = video.paused ? "paused: full density" : `preview: ${session.cols(d.density())} col · exports at ${d.density()} col`;
    paintTimeline();
  }

  /** @param {number} g generation this frame loop belongs to */
  function watchFrames(g) {
    const onFrame = () => {
      if (g !== generation) return;
      if (!video.paused) d.requestRender();
      tick();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  async function benchmark() {
    const samples = [];
    for (const cols of [60, 120]) {
      await d.bench(cols);
      samples.push({ cols, ms: await d.bench(cols) });
    }
    model = costModel(samples);
    governor = new PreviewGovernor(model);
    const mid = (trimWin.start + trimWin.end) / 2, t0 = performance.now();
    for (let k = 0; k < 3; k++) await seekTo(video, Math.min(mid + k / 24, duration - 0.01));
    seekMs = (performance.now() - t0) / 3;
  }

  /** @param {File} file */
  async function load(file) {
    session.detach();
    const g = ++generation;
    url = URL.createObjectURL(file);
    await openVideo(video, url);
    if (g !== generation) return;
    if (!Number.isFinite(video.duration)) throw new Error("This video has no known duration.");
    if (!video.videoWidth || !video.videoHeight) throw new Error("That file has no video picture.");
    duration = video.duration;
    dims = { width: video.videoWidth, height: video.videoHeight };
    writeTrim(clampTrim(0, duration, duration));
    fillFps();
    await benchmark();
    if (g !== generation) return;
    ready = true;
    bar.hidden = false;
    exportBar.hidden = false;
    topExport.hidden = false;
    watchFrames(g);
    video.currentTime = trimWin.start;
    await video.play().catch(() => {});
    d.requestRender();
    updateInfo();
  }

  /** @type {ExportResult | null} */
  let lastExport = null;

  async function runExport() {
    if (!url || job) return;
    writeTrim(readTrim());
    const p = exportPlan();
    const ctl = (job = new AbortController());
    const wasPlaying = !video.paused;
    const format = $("fmt").value;
    video.pause();
    $("exportBtn").hidden = true;
    $("cancelBtn").hidden = false;
    $("prog").hidden = false;
    $("prog").value = 0;
    try {
      const res = await exportVideo({
        videoUrl: url, workerSource: d.workerSource, format, fps: p.fps, cols: p.layout.cols,
        start: p.t.start, end: p.t.end, size: p.size, look: d.look(), workers: poolSize(), signal: ctl.signal,
        onProgress: (done, total, ms) => {
          $("prog").value = done / total;
          $("exportInfo").textContent = `frame ${done}/${total} · ≈ ${Math.round(((ms / done) * (total - done)) / 1000)} s left`;
        },
      });
      d.save(res.blob, format, p.layout.cols);
      lastExport = { format, bytes: res.blob.size, ms: res.ms, frames: res.frames, codec: res.codec, realtime: res.realtime, ...p.size, fps: p.fps, cols: p.layout.cols, timing: res.timing };
      $("exportInfo").textContent = `ready: ${(res.blob.size / 1048576).toFixed(1)} MB in ${(res.ms / 1000).toFixed(1)} s (${res.codec}${res.realtime ? ", real-time capture: reduced quality" : ""})`;
    } catch (e) {
      $("exportInfo").textContent = ctl.signal.aborted ? "export canceled" : `export failed: ${/** @type {Error} */ (e).message}`;
    } finally {
      job = null;
      $("exportBtn").hidden = false;
      $("cancelBtn").hidden = true;
      $("prog").hidden = true;
      if (url && wasPlaying) video.play().catch(() => {});
    }
  }

  const session = {
    /** Source element for the preview; only meaningful once `ready`. */
    video,
    /** True once the benchmark is done and frames may be rendered. */
    get ready() { return ready; },
    get playing() { return !video.paused; },
    get lastExport() { return lastExport; },

    /** Columns to render for the preview right now. */
    cols(/** @type {number} */ density) { return governor ? governor.cols(density, !video.paused) : density; },
    record(/** @type {number} */ ms) { if (!video.paused) governor?.record(ms, d.density()); },
    refresh: updateInfo,

    /** @param {File} file */
    async attach(file) {
      try { await load(file); } catch (e) { session.detach(); throw e; }
    },

    detach() {
      generation++;
      job?.abort();
      video.pause();
      if (url) URL.revokeObjectURL(url);
      url = null;
      ready = false;
      governor = null;
      model = null;
      bar.hidden = true;
      exportBar.hidden = true;
      topExport.hidden = true;
    },
  };

  $("playBtn").addEventListener("click", () => {
    if (!video.paused) { video.pause(); return; }
    video.currentTime = resumeTime(video.currentTime, trimWin);
    video.play();
  });
  video.addEventListener("pause", () => { if (ready) { tick(); d.requestRender(); } });
  video.addEventListener("play", () => { if (ready) tick(); });
  video.addEventListener("seeked", () => { if (ready && video.paused) d.requestRender(); });
  video.addEventListener("ended", () => { if (ready && loop) { video.currentTime = trimWin.start; video.play().catch(() => {}); } });
  $("loopBtn").addEventListener("click", () => { loop = !isPressed($("loopBtn")); setPressed($("loopBtn"), loop); });
  $("scrub").addEventListener("input", () => { video.currentTime = trimWin.start + (+$("scrub").value / 1000) * (trimWin.end - trimWin.start); });
  $("tStart").addEventListener("change", () => writeTrim(shiftTrim(trimWin, parseFloat($("tStart").value), duration)));
  $("tEnd").addEventListener("change", () => writeTrim(readTrim()));
  $("trimStart").addEventListener("pointerdown", (/** @type {PointerEvent} */ e) => dragTimeline("start", e));
  $("trimEnd").addEventListener("pointerdown", (/** @type {PointerEvent} */ e) => dragTimeline("end", e));
  $("timelineSpan").addEventListener("pointerdown", (/** @type {PointerEvent} */ e) => dragTimeline("shift", e));
  $("timelineTrack").addEventListener("pointerdown", (/** @type {PointerEvent} */ e) => dragTimeline("play", e));
  for (const id of ["tStart", "tEnd", "fmt", "res", "gifw", "fps"]) {
    $(id).addEventListener("change", () => {
      if (id === "fmt") fillFps();
      if (video.currentTime < trimWin.start || video.currentTime > trimWin.end) video.currentTime = trimWin.start;
      updateInfo();
    });
  }
  $("exportBtn").addEventListener("click", runExport);
  $("cancelBtn").addEventListener("click", () => job?.abort());
  return session;
}
