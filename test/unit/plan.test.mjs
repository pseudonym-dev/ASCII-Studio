import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, PreviewGovernor, adaptCap, atTrimEnd, cutNotice, fileSizeProblem, resumeTime, avcCodec, bitrate, clampTrim, costModel, exportEstimateMs, exportSize, frameCount, frameTime, FPS_CHOICES, gifDelayMs, shiftTrim, initialPreviewCap, timeAt } from "../../web/src/plan.js";

test("clampTrim limits the window to 15 s and keeps it inside the video", () => {
  assert.deepEqual(clampTrim(0, 99, 40), { start: 0, end: LIMITS.maxSeconds });
  assert.deepEqual(clampTrim(30, 99, 40), { start: 30, end: 40 });
  assert.deepEqual(clampTrim(-5, 3, 10), { start: 0, end: 3 });
  const tiny = clampTrim(9.99, 5, 10);
  assert.ok(tiny.end > tiny.start);
  assert.deepEqual(clampTrim(NaN, NaN, 8), { start: 0, end: 8 });
});

test("frame count and timestamps stay inside the trim window", () => {
  assert.equal(frameCount(0, 3, 12), 36);
  assert.equal(frameCount(1, 1.01, 30), 1);
  for (let i = 0; i < 36; i++) assert.ok(frameTime(0, 3, i, 12) < 3);
  assert.equal(frameTime(0, 3, 35, 12), 3 - 1 / 24);
  assert.ok(frameTime(0, 3.0004, 0, 1) <= 3.0004);
});

test("exportSize is even, bounded by 1080p-class limits, and honours GIF width", () => {
  const landscape = exportSize({ cols: 160, rows: 90 }, { shortSide: 1080 });
  assert.ok(landscape.width % 2 === 0 && landscape.height % 2 === 0);
  assert.ok(Math.max(landscape.width, landscape.height) <= LIMITS.maxLong);
  assert.equal(landscape.height, 1080);
  const portrait = exportSize({ cols: 100, rows: 130 }, { shortSide: 1080 });
  assert.ok(portrait.height <= LIMITS.maxLong && portrait.width <= 1080);
  const wide = exportSize({ cols: 220, rows: 40 }, { shortSide: 1080 });
  assert.ok(wide.width <= LIMITS.maxLong, `wide ${wide.width}`);
  assert.equal(exportSize({ cols: 90, rows: 60 }, { width: 480 }).width, 480);
});

test("bitrate and AVC level scale with frame size", () => {
  assert.equal(bitrate(100, 100, 10), 1.5e6);
  assert.equal(bitrate(4000, 4000, 60), 25e6);
  assert.equal(bitrate(1920, 1080, 30), 7464960);
  assert.equal(avcCodec(1280, 720), "avc1.640028");
  assert.equal(avcCodec(1920, 1080), "avc1.640028");
  assert.equal(avcCodec(1080, 1920), "avc1.640028");
  assert.equal(avcCodec(2560, 1440), "avc1.640032");
  assert.equal(avcCodec(3840, 2160), "avc1.640033");
});

test("cost model scales with cell count within each resolution mode", () => {
  const model = costModel([{ cols: 60, ms: 20 }, { cols: 120, ms: 60 }]);
  assert.equal(model(60), 20);
  assert.equal(model(30), 5);
  assert.equal(model(120), 60);
  assert.equal(model(240), 240);
  assert.ok(exportEstimateMs(model, 100, 120, 4, 0) < exportEstimateMs(model, 100, 120, 1, 0));
  assert.equal(exportEstimateMs(model, 10, 60, 4, 200), 10 * 220, "seek-bound exports are paced by the seek");
});

test("preview cap fits the budget, never below the minimum nor above the slider", () => {
  assert.equal(initialPreviewCap(() => 1, 90), 90);
  assert.equal(initialPreviewCap(() => 1e6, 90), LIMITS.minCols);
  const quadratic = (/** @type {number} */ c) => 0.01 * c * c;
  const cap = initialPreviewCap(quadratic, 200);
  assert.ok(quadratic(cap) <= LIMITS.previewBudgetMs && quadratic(cap + 1) > LIMITS.previewBudgetMs);
});

test("adaptCap lowers when slow, raises when fast, otherwise holds", () => {
  assert.ok(adaptCap(100, 200, 160) < 100);
  assert.equal(adaptCap(31, 500, 160), LIMITS.minCols);
  assert.ok(adaptCap(100, 20, 160) > 100);
  assert.equal(adaptCap(160, 20, 160), 160);
  assert.equal(adaptCap(100, 80, 160), 100);
});

test("PreviewGovernor uses full density when paused and adapts every 6 played frames", () => {
  const g = new PreviewGovernor(() => 1);
  assert.equal(g.cols(150, false), 150);
  assert.equal(g.cols(150, true), 150);
  const slow = new PreviewGovernor((/** @type {number} */ c) => 0.01 * c * c);
  const start = slow.cols(200, true);
  for (let i = 0; i < 6; i++) slow.record(300, 200);
  assert.ok(slow.cols(200, true) < start);
  assert.equal(slow.cols(200, false), 200);
});

test("GIF delays are whole centiseconds and keep the total duration exact", () => {
  for (const fps of [8, 10, 12, 15]) {
    const n = fps * 7;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = gifDelayMs(i, fps);
      assert.equal(d % 10, 0);
      total += d;
    }
    assert.equal(total, 7000, `fps ${fps}`);
  }
});

test("shiftTrim keeps the window length and stays inside the video", () => {
  assert.deepEqual(shiftTrim({ start: 0, end: 4 }, 2, 20), { start: 2, end: 6 });
  const late = shiftTrim({ start: 0, end: 4 }, 19, 20);
  assert.ok(late.start <= 19.9 && late.end <= 20 && late.end > late.start);
  assert.deepEqual(shiftTrim({ start: 1, end: 3 }, NaN, 20), { start: 0, end: 2 });
});

test("offered frame rates respect the 30 fps video and 15 fps GIF limits", () => {
  assert.ok(Math.max(...FPS_CHOICES.video) <= 30);
  assert.ok(Math.max(...FPS_CHOICES.gif) <= 15);
});

test("play at the trim end resumes from the start, anywhere else it continues", () => {
  const trim = { start: 2, end: 5 };
  assert.equal(atTrimEnd(4.99, trim), true);
  assert.equal(atTrimEnd(4.9, trim), false);
  assert.equal(resumeTime(5, trim), 2);
  assert.equal(resumeTime(4.99, trim), 2);
  assert.equal(resumeTime(3.5, trim), 3.5);
  assert.equal(resumeTime(1.2, trim), 2);
});

test("timeAt maps a click on the timeline to a time in the video", () => {
  assert.equal(timeAt(0, 200, 10), 0);
  assert.equal(timeAt(100, 200, 10), 5);
  assert.equal(timeAt(200, 200, 10), 10);
  assert.equal(timeAt(-20, 200, 10), 0);
  assert.equal(timeAt(400, 200, 10), 10);
  assert.equal(timeAt(50, 0, 10), 0);
});

test("the cut notice appears only for videos longer than the limit", () => {
  assert.equal(cutNotice(LIMITS.maxSeconds), "");
  assert.match(cutNotice(20), /20\.0 s.*15 s/);
});

test("file size limit gives one message with both sizes", () => {
  assert.equal(fileSizeProblem(LIMITS.maxBytes), null);
  assert.match(String(fileSizeProblem(LIMITS.maxBytes + 1)), /100 MB.*100 MB/);
  assert.match(String(fileSizeProblem(250 * 1048576)), /250 MB/);
});
