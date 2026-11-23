import { frameLayout } from "./core.js";
import { openVideo, seekTo } from "./frames.js";
import { Pool } from "./pool.js";
import { frameRequest, paintGrid } from "./render.js";
import { createSink } from "./encoders.js";
import { frameCount, frameTime } from "./plan.js";

/** @typedef {import("./encoders.js").Format} Format */
/** @typedef {import("./render.js").Look} Look */

/**
 * @typedef {object} ExportJob
 * @property {string} videoUrl
 * @property {string} workerSource
 * @property {Format} format
 * @property {number} fps
 * @property {number} cols
 * @property {number} start  trim start, seconds
 * @property {number} end    trim end, seconds
 * @property {{width: number, height: number}} size  output pixels
 * @property {Look} look
 * @property {number} workers
 * @property {AbortSignal} signal
 * @property {(done: number, total: number, elapsedMs: number) => void} onProgress
 */

/**
 * Re-render the trimmed video offline, frame by frame, at the chosen density, and encode it.
 * Workers compute grids in parallel; frames are painted and encoded strictly in order.
 * @param {ExportJob} job
 * @returns {Promise<{blob: Blob, codec: string, realtime: boolean, frames: number, ms: number, timing: {seekMs: number, pixelsMs: number, paintMs: number, encodeMs: number}}>}
 */
export async function exportVideo(job) {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  const pool = new Pool(job.workerSource, job.workers);
  /** @type {import("./encoders.js").Sink | null} */
  let sink = null;
  /** @type {Promise<import("./pool.js").TimedGrid>[]} */
  const queue = [];
  try {
    await openVideo(video, job.videoUrl);
    const layout = frameLayout(video.videoWidth, video.videoHeight, job.cols);
    const canvas = document.createElement("canvas");
    canvas.width = job.size.width;
    canvas.height = job.size.height;
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    sink = await createSink(job.format, canvas, job.fps);

    const total = frameCount(job.start, job.end, job.fps);
    const cw = canvas.width / layout.cols, ch = canvas.height / layout.rows;
    const t0 = performance.now();
    const timing = { seekMs: 0, pixelsMs: 0, paintMs: 0, encodeMs: 0 };
    let encoded = 0;
    const drainOne = async () => {
      const grid = await /** @type {Promise<import("./pool.js").TimedGrid>} */ (queue.shift());
      const tPaint = performance.now();
      paintGrid(ctx, grid, cw, ch, job.look);
      const tEnc = performance.now();
      await sink?.add(encoded++);
      timing.paintMs += tEnc - tPaint;
      timing.encodeMs += performance.now() - tEnc;
      job.onProgress(encoded, total, performance.now() - t0);
    };
    for (let i = 0; i < total; i++) {
      job.signal.throwIfAborted();
      const tSeek = performance.now();
      await seekTo(video, frameTime(job.start, job.end, i, job.fps));
      const tPix = performance.now();
      const req = frameRequest(video, job.cols, job.look);
      timing.seekMs += tPix - tSeek;
      timing.pixelsMs += performance.now() - tPix;
      queue.push(pool.run(req));
      if (queue.length > job.workers) await drainOne();
    }
    while (queue.length) {
      job.signal.throwIfAborted();
      await drainOne();
    }
    const blob = await sink.finish();
    return { blob, codec: sink.codec, realtime: sink.realtime, frames: total, ms: performance.now() - t0, timing };
  } catch (e) {
    sink?.abort();
    for (const pending of queue) pending.catch(() => {}); // frames still in flight must not surface as unhandled rejections
    throw e;
  } finally {
    pool.terminate();
    video.removeAttribute("src");
    video.load();
  }
}
