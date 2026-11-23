import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { avcCodec, bitrate, gifDelayMs } from "./plan.js";

/**
 * @typedef {object} Sink
 * @property {string} codec
 * @property {boolean} realtime  true when the encoder runs in real time (lossy fallback)
 * @property {(frame: number) => Promise<void>} add  encode the current canvas as frame `frame`
 * @property {() => Promise<Blob>} finish
 * @property {() => void} abort
 */

/** @typedef {"mp4" | "webm" | "gif"} Format */

/**
 * Pick an encoder for `format`: GIF in JS, MP4/WebM through WebCodecs, MediaRecorder as last resort.
 * @param {Format} format @param {HTMLCanvasElement} canvas @param {number} fps
 * @returns {Promise<Sink>}
 */
export async function createSink(format, canvas, fps) {
  if (format === "gif") return gifSink(canvas, fps);
  const viaCodecs = typeof VideoEncoder !== "undefined" ? await webCodecsSink(format, canvas, fps) : null;
  return viaCodecs || recorderSink(format, canvas, fps);
}

/**
 * @param {HTMLCanvasElement} canvas @param {number} fps
 * @returns {Sink}
 */
function gifSink(canvas, fps) {
  const gif = GIFEncoder();
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  return {
    codec: "gif",
    realtime: false,
    async add(frameIndex) {
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const palette = quantize(data, 256, { format: "rgb444" });
      gif.writeFrame(applyPalette(data, palette, "rgb444"), canvas.width, canvas.height, { palette, delay: gifDelayMs(frameIndex, fps), repeat: 0 });
    },
    async finish() {
      gif.finish();
      return new Blob([/** @type {BlobPart} */ (gif.bytes())], { type: "image/gif" });
    },
    abort() {},
  };
}

/**
 * @param {"mp4" | "webm"} format @param {HTMLCanvasElement} canvas @param {number} fps
 * @returns {Promise<Sink | null>}
 */
async function webCodecsSink(format, canvas, fps) {
  const { width, height } = canvas;
  const candidates = format === "mp4"
    ? [{ codec: avcCodec(width, height), mux: "avc" }]
    : [{ codec: "vp09.00.10.08", mux: "V_VP9" }, { codec: "vp8", mux: "V_VP8" }];
  for (const cand of candidates) {
    const config = { codec: cand.codec, width, height, bitrate: bitrate(width, height, fps), framerate: fps };
    const supported = await VideoEncoder.isConfigSupported(config).then((r) => !!r.supported, () => false);
    if (!supported) continue;

    const muxer = format === "mp4"
      ? new Mp4Muxer({ target: new Mp4Target(), video: { codec: "avc", width, height }, fastStart: "in-memory" })
      : new WebmMuxer({ target: new WebmTarget(), video: { codec: /** @type {"V_VP9" | "V_VP8"} */ (cand.mux), width, height, frameRate: fps } });
    /** @type {Error | null} */
    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { failure = e; },
    });
    encoder.configure(config);
    const keyEvery = Math.max(1, Math.round(fps * 2));
    return {
      codec: cand.codec,
      realtime: false,
      async add(frameIndex) {
        if (failure) throw failure;
        while (encoder.encodeQueueSize > 8) await new Promise((r) => encoder.addEventListener("dequeue", r, { once: true }));
        const frame = new VideoFrame(canvas, { timestamp: Math.round((frameIndex * 1e6) / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: frameIndex % keyEvery === 0 });
        frame.close();
      },
      async finish() {
        await encoder.flush();
        if (failure) throw failure;
        encoder.close();
        muxer.finalize();
        return new Blob([/** @type {ArrayBuffer} */ (muxer.target.buffer)], { type: format === "mp4" ? "video/mp4" : "video/webm" });
      },
      abort() { if (encoder.state !== "closed") encoder.close(); },
    };
  }
  return null;
}

/**
 * MediaRecorder fallback: real time and lossy, only used when WebCodecs is missing.
 * @returns {Sink}
 */
function recorderSink(/** @type {"mp4" | "webm"} */ format, /** @type {HTMLCanvasElement} */ canvas, /** @type {number} */ fps) {
  const mimes = format === "mp4" ? ["video/mp4;codecs=avc1", "video/mp4"] : ["video/webm;codecs=vp9", "video/webm"];
  const mimeType = mimes.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error(`This browser can't create ${format.toUpperCase()}.`);
  const stream = canvas.captureStream(0);
  const track = /** @type {CanvasCaptureMediaStreamTrack} */ (stream.getVideoTracks()[0]);
  /** @type {Blob[]} */
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate(canvas.width, canvas.height, fps) });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start();
  const t0 = performance.now();
  return {
    codec: mimeType,
    realtime: true,
    async add(frameIndex) {
      track.requestFrame();
      const wait = t0 + ((frameIndex + 1) * 1000) / fps - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    },
    async finish() {
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.stop();
      await stopped;
      track.stop();
      return new Blob(chunks, { type: mimeType.split(";")[0] });
    },
    abort() { if (rec.state !== "inactive") rec.stop(); track.stop(); },
  };
}
