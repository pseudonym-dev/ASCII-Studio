// Property and golden checks on the JS core. No Python, fonts, or photos required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGrid, frameLayout, gridToText, CW, CH, RAMP, glyphChar } from "../../web/src/core.js";

const EDGE = new Set("/\\|-_");

/**
 * Uniform coverage per ramp glyph, heavy (first) to light (last).
 * Enough for shade/dither to pick a density band without a font atlas.
 * @param {number} SW @param {number} SH
 */
function flatAtlas(SW, SH) {
  const n = RAMP.length, area = SW * SH;
  const atlas = new Float32Array(n * area);
  for (let k = 0; k < n; k++) {
    const coverage = 1 - k / Math.max(1, n - 1);
    atlas.fill(coverage, k * area, (k + 1) * area);
  }
  return atlas;
}

/**
 * @param {number} w @param {number} h @param {number} r @param {number} g @param {number} b
 * @param {(x: number, y: number, i: number) => boolean} [paint]
 */
function rgbaBuffer(w, h, r, g, b, paint) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (!paint || paint(x, y, i)) {
        rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b;
      }
      rgba[i * 4 + 3] = 255;
    }
  }
  return rgba;
}

/** @param {Uint8ClampedArray} rgba @param {import("../../web/src/core.js").Layout} layout @param {{edgeGain?: number, separate?: boolean}} [opts] */
function run(rgba, layout, opts = {}) {
  return computeGrid({
    rgba,
    layout,
    atlas: flatAtlas(layout.SW, layout.SH),
    edgeGain: opts.edgeGain ?? 1,
    separate: opts.separate ?? false,
  });
}

/** @param {import("../../web/src/core.js").Grid} grid */
function edgeCounts(grid) {
  /** @type {Record<string, number>} */
  const c = {};
  let n = 0;
  for (const id of grid.glyphs) {
    const ch = glyphChar(id);
    if (!EDGE.has(ch)) continue;
    c[ch] = (c[ch] ?? 0) + 1;
    n++;
  }
  return { n, c };
}

test("frameLayout picks full resolution up to 100 columns and half above", () => {
  assert.deepEqual(frameLayout(1200, 1800, 60), { cols: 60, rows: 60, SW: 12, SH: 18 });
  assert.deepEqual(frameLayout(1200, 1800, 160), { cols: 160, rows: 160, SW: 6, SH: 9 });
  assert.equal(frameLayout(4000, 10, 100).rows, 4);
});

test("the glyph ramp is unique and uses the measured heavy-to-light order", () => {
  assert.equal(RAMP, "B#8Q0@&$aeo1un%t{i}z=xcvl[]>+<jr!;:,");
  assert.equal(new Set(RAMP).size, RAMP.length);
});

test("computeGrid is deterministic and stays on the printable-ASCII glyph ids", () => {
  const layout = { cols: 16, rows: 12, SW: CW, SH: CH };
  const rgba = rgbaBuffer(layout.cols * layout.SW, layout.rows * layout.SH, 40, 80, 120, (x, y) => {
    const cx = layout.cols * layout.SW / 2, cy = layout.rows * layout.SH / 2;
    return (x - cx) ** 2 / 80 ** 2 + (y - cy) ** 2 / 50 ** 2 < 1;
  });
  const a = run(rgba, layout, { separate: true });
  const b = run(rgba, layout, { separate: true });
  assert.equal(a.cols, layout.cols);
  assert.equal(a.rows, layout.rows);
  assert.equal(a.glyphs.length, layout.cols * layout.rows);
  assert.equal(a.ink.length, layout.cols * layout.rows * 3);
  assert.deepEqual([...a.glyphs], [...b.glyphs]);
  assert.deepEqual([...a.ink], [...b.ink]);
  for (let i = 0; i < a.glyphs.length; i++) {
    assert.ok(a.glyphs[i] <= 94, `glyph id ${a.glyphs[i]}`);
    if (a.glyphs[i] === 0) {
      assert.equal(a.ink[i * 3], 0);
      assert.equal(a.ink[i * 3 + 1], 0);
      assert.equal(a.ink[i * 3 + 2], 0);
    }
  }
  const text = gridToText(a);
  assert.equal(text.split("\n").length, layout.rows);
  assert.equal(text, gridToText(b));
  for (const line of text.split("\n")) assert.equal(line, line.replace(/\s+$/, ""));
});

test("a bright field uses heavier ramp glyphs than a dark field", () => {
  const layout = { cols: 12, rows: 8, SW: CW, SH: CH };
  const w = layout.cols * layout.SW, h = layout.rows * layout.SH;
  const bright = run(rgbaBuffer(w, h, 245, 245, 245), layout);
  const dark = run(rgbaBuffer(w, h, 16, 16, 16), layout);
  const idx = (/** @type {import("../../web/src/core.js").Grid} */ g) => {
    const used = [...g.glyphs].map((id) => RAMP.indexOf(glyphChar(id))).filter((i) => i >= 0);
    assert.ok(used.length > 0, "expected some ramp glyphs");
    return used.reduce((s, i) => s + i, 0) / used.length;
  };
  assert.ok(idx(bright) < idx(dark) - 4, `bright ${idx(bright)} should be earlier in the ramp than dark ${idx(dark)}`);
});

test("a vertical bright bar produces mostly | contour glyphs", () => {
  const layout = { cols: 24, rows: 16, SW: CW, SH: CH };
  const w = layout.cols * layout.SW, h = layout.rows * layout.SH;
  const rgba = rgbaBuffer(w, h, 20, 20, 24, (x) => x >= 10 * layout.SW && x < 14 * layout.SW);
  // paint the bar white
  for (let y = 0; y < h; y++) {
    for (let x = 10 * layout.SW; x < 14 * layout.SW; x++) {
      const i = y * w + x;
      rgba[i * 4] = 250; rgba[i * 4 + 1] = 250; rgba[i * 4 + 2] = 250;
    }
  }
  const { n, c } = edgeCounts(run(rgba, layout, { edgeGain: 1.4, separate: false }));
  assert.ok(n > 8, `expected several contour glyphs, got ${n} (${JSON.stringify(c)})`);
  assert.ok((c["|"] ?? 0) > n * 0.5, `expected | to dominate, got ${JSON.stringify(c)}`);
});

test("a horizontal bright bar produces mostly - or _ contour glyphs", () => {
  const layout = { cols: 24, rows: 16, SW: CW, SH: CH };
  const w = layout.cols * layout.SW, h = layout.rows * layout.SH;
  const rgba = rgbaBuffer(w, h, 20, 20, 24);
  for (let y = 6 * layout.SH; y < 10 * layout.SH; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      rgba[i * 4] = 250; rgba[i * 4 + 1] = 250; rgba[i * 4 + 2] = 250;
    }
  }
  const { n, c } = edgeCounts(run(rgba, layout, { edgeGain: 1.4, separate: false }));
  const flat = (c["-"] ?? 0) + (c["_"] ?? 0);
  assert.ok(n > 8, `expected several contour glyphs, got ${n} (${JSON.stringify(c)})`);
  assert.ok(flat > n * 0.5, `expected -/_ to dominate, got ${JSON.stringify(c)}`);
});

test("a dark-to-light diagonal produces mostly / or \\ contour glyphs", () => {
  const layout = { cols: 24, rows: 16, SW: CW, SH: CH };
  const w = layout.cols * layout.SW, h = layout.rows * layout.SH;
  const rgba = rgbaBuffer(w, h, 20, 20, 24, (x, y) => y > (x * h) / w - 18 && y < (x * h) / w + 18);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    if (y > (x * h) / w - 18 && y < (x * h) / w + 18) {
      rgba[i * 4] = 250; rgba[i * 4 + 1] = 250; rgba[i * 4 + 2] = 250;
    }
  }
  const { n, c } = edgeCounts(run(rgba, layout, { edgeGain: 1.4, separate: false }));
  const slash = (c["/"] ?? 0) + (c["\\"] ?? 0);
  assert.ok(n > 8, `expected several contour glyphs, got ${n} (${JSON.stringify(c)})`);
  assert.ok(slash > n * 0.5, `expected / or \\ to dominate, got ${JSON.stringify(c)}`);
});

test("a centred subject on a flat field is separated from the background", () => {
  const layout = { cols: 20, rows: 14, SW: CW, SH: CH };
  const w = layout.cols * layout.SW, h = layout.rows * layout.SH;
  const rgba = rgbaBuffer(w, h, 8, 28, 48, (x, y) => {
    const cx = w / 2, cy = h / 2;
    return (x - cx) ** 2 / 70 ** 2 + (y - cy) ** 2 / 55 ** 2 < 1;
  });
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const cx = w / 2, cy = h / 2;
      if ((x - cx) ** 2 / 70 ** 2 + (y - cy) ** 2 / 55 ** 2 < 1) {
        rgba[i * 4] = 240; rgba[i * 4 + 1] = 90; rgba[i * 4 + 2] = 30;
      }
    }
  }
  const grid = run(rgba, layout, { separate: true });
  assert.equal(grid.hasSubject, true);
  const text = gridToText(grid);
  assert.match(text, /[B#8Q0@&$aeo]/);
});

test("a synthetic scene stays on a stable golden transcript", () => {
  const layout = { cols: 16, rows: 10, SW: CW, SH: CH };
  const w = layout.cols * layout.SW, h = layout.rows * layout.SH;
  const rgba = rgbaBuffer(w, h, 12, 24, 40);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const inRect = x >= 4 * layout.SW && x < 12 * layout.SW && y >= 2 * layout.SH && y < 8 * layout.SH;
      const inBand = Math.abs(y - x * 0.6 - 20) < 10;
      if (inRect) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 140; rgba[i * 4 + 2] = 40; }
      else if (inBand) { rgba[i * 4] = 200; rgba[i * 4 + 1] = 220; rgba[i * 4 + 2] = 255; }
    }
  }
  const text = gridToText(run(rgba, layout, { edgeGain: 1, separate: true }));
  assert.equal(text, "---,,,,,,,,,,;;;\n_-----------,,!;\n___\\/------||,;;\n,,,\\|Q00008||,;;\n:,,||0&&&&@||,,,\n;;,||0&$&&@|\\-,,\n;!,||80000Q8\\---\n;;,||______||___\n;!,,________/,__\n;;;,,,,,,,,,,,,,");
});
