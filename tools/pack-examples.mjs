// Rebuild web/assets/examples/*.bin.gz from the trimmed clips in samples/.
// Needs ffmpeg on PATH and `@napi-rs/canvas` (install with `npm install --no-save @napi-rs/canvas`).
// Look matches the editor opening a video: 158 columns, edge gain 1.10×, color, no subject separation.
// Glow and zoom are paint-time only and are not stored in the pack.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { CW, CH, RAMP, computeGrid, frameLayout } from "../web/src/core.js";
import { packClip } from "../web/src/clip.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COLS = 158;
const EDGE_GAIN = 1.10;
const FPS = 12;
const FONT_PX = 20;
const BASE_Y = 15.56; // must match web/src/render.js so glyph coverage stays in sync
const FONT_NAME = "DejaVu Sans Mono";
const FONT_PATHS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
  "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
];

const examples = [
  { id: "toucan", file: "example-toucan.mp4" },
  { id: "macaw", file: "example-macaw.mp4" },
  { id: "chameleon", file: "example-chameleon.mp4" },
];

/** @param {string} spec */
const optionalImport = (spec) => import(spec);

/**
 * @returns {Promise<{
 *   createCanvas: (w: number, h: number) => { getContext: (type: "2d") => CanvasRenderingContext2D },
 *   GlobalFonts: { registerFromPath: (path: string, name: string) => boolean },
 * }>}
 */
async function loadCanvas() {
  try {
    return await optionalImport("@napi-rs/canvas");
  } catch {
    throw new Error("pack-examples needs ffmpeg and @napi-rs/canvas. Install the canvas package with: npm install --no-save @napi-rs/canvas");
  }
}

/** @param {{ createCanvas: (w: number, h: number) => { getContext: (type: "2d") => CanvasRenderingContext2D } }} canvas @param {number} SW @param {number} SH */
function buildAtlas(canvas, SW, SH) {
  const c = canvas.createCanvas(CW, CH);
  const x = c.getContext("2d");
  const f = CW / SW, area = SW * SH;
  const atlas = new Float32Array(RAMP.length * area);
  x.font = `${FONT_PX}px "${FONT_NAME}"`;
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
  return atlas;
}

/** @param {string} src @param {number} tw @param {number} th @param {number} fps */
function extractRgbaFrames(src, tw, th, fps) {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", src,
    "-vf", `fps=${fps},scale=${tw}:${th}:flags=lanczos,format=rgba`,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
  const n = tw * th * 4;
  const count = Math.floor(raw.length / n);
  /** @type {Uint8ClampedArray[]} */
  const frames = [];
  for (let i = 0; i < count; i++) frames.push(new Uint8ClampedArray(raw.subarray(i * n, (i + 1) * n)));
  return frames;
}

async function main() {
  const canvas = await loadCanvas();
  const font = FONT_PATHS.find((p) => {
    try { return canvas.GlobalFonts.registerFromPath(p, FONT_NAME); } catch { return false; }
  });
  if (!font) throw new Error(`could not load ${FONT_NAME}; install fonts-dejavu-core`);

  const layout = frameLayout(480, 270, COLS);
  const tw = layout.cols * layout.SW, th = layout.rows * layout.SH;
  const atlas = buildAtlas(canvas, layout.SW, layout.SH);
  const outDir = resolve(root, "web/assets/examples");
  mkdirSync(outDir, { recursive: true });

  for (const example of examples) {
    const src = resolve(root, "samples", example.file);
    console.log(`packing ${example.id} from ${example.file} (${layout.cols}×${layout.rows} @ ${FPS} fps)`);
    const frames = extractRgbaFrames(src, tw, th, FPS);
    if (frames.length < 2) throw new Error(`${example.file}: expected a looping clip, got ${frames.length} frame(s)`);
    const grids = frames.map((rgba) => computeGrid({ rgba, layout, atlas, edgeGain: EDGE_GAIN, separate: false }));
    const packed = packClip({
      cols: layout.cols,
      rows: layout.rows,
      fps: FPS,
      frames: grids.map((g) => ({ glyphs: g.glyphs, ink: g.ink })),
    });
    const gz = gzipSync(packed, { level: 9 });
    const dest = resolve(outDir, `${example.id}.bin.gz`);
    writeFileSync(dest, gz);
    console.log(`  ${frames.length} frames, ${gz.length} bytes -> ${dest}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
