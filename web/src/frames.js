/** @typedef {HTMLVideoElement | HTMLCanvasElement | ImageBitmap} FrameSource */

/** @param {FrameSource} src @returns {{width: number, height: number}} */
export function sourceSize(src) {
  return src instanceof HTMLVideoElement ? { width: src.videoWidth, height: src.videoHeight } : src;
}

/** Scratch canvases reused across frames (index = halving step; last slot = final size). */
/** @type {HTMLCanvasElement[]} */
const scratch = [];

/** @param {number} slot @param {number} w @param {number} h @param {CanvasRenderingContext2DSettings} [settings] */
function scratchContext(slot, w, h, settings) {
  const c = (scratch[slot] ??= document.createElement("canvas"));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return /** @type {CanvasRenderingContext2D} */ (c.getContext("2d", settings));
}

/**
 * Resample a source to tw x th RGBA (stepwise halving keeps downscales smooth).
 * @param {FrameSource} src @param {number} tw @param {number} th
 * @returns {Uint8ClampedArray}
 */
export function framePixels(src, tw, th) {
  let cur = src;
  let { width: cw, height: ch } = sourceSize(src);
  for (let step = 0; cw / 2 >= tw && ch / 2 >= th; step++) {
    cw = Math.max(tw, Math.floor(cw / 2));
    ch = Math.max(th, Math.floor(ch / 2));
    const x = scratchContext(step, cw, ch);
    x.clearRect(0, 0, cw, ch);
    x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, cw, ch);
    cur = x.canvas;
  }
  const ctx = scratchContext(15, tw, th, { willReadFrequently: true });
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, tw, th);
  return ctx.getImageData(0, 0, tw, th).data;
}

/**
 * Seek and wait until the frame at `t` is decoded.
 * @param {HTMLVideoElement} video @param {number} t @param {number} [timeoutMs]
 */
export function seekTo(video, t, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && Math.abs(video.currentTime - t) < 1e-4) { resolve(undefined); return; }
    const timer = setTimeout(() => { cleanup(); reject(new Error("seek timeout")); }, timeoutMs);
    const onSeeked = () => { cleanup(); resolve(undefined); };
    const onError = () => { cleanup(); reject(new Error("video error")); };
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    }
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = t;
  });
}

/**
 * Point `video` at `url` and wait until its first frame is decoded.
 * @param {HTMLVideoElement} video @param {string} url
 */
export function openVideo(video, url) {
  return new Promise((resolve, reject) => {
    const onLoaded = () => { cleanup(); resolve(undefined); };
    const onError = () => { cleanup(); reject(new Error("Couldn't open that video in this browser.")); };
    function cleanup() {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
    }
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("error", onError);
    video.src = url;
  });
}
