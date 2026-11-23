import { test } from "node:test";
import assert from "node:assert/strict";
import { expandInk, indexInk, makePalette, packClip, unpackClip } from "../../web/src/clip.js";

/** @param {number} cols @param {number} rows @param {number} glyph @param {number} r @param {number} g @param {number} b */
function solid(cols, rows, glyph, r, g, b) {
  const n = cols * rows;
  const glyphs = new Uint8Array(n).fill(glyph);
  const ink = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { ink[i * 3] = r; ink[i * 3 + 1] = g; ink[i * 3 + 2] = b; }
  return { glyphs, ink };
}

test("unpack(pack) is a round trip when the clip uses few colours", () => {
  const a = solid(4, 2, 1, 255, 0, 0);
  const b = solid(4, 2, 1, 255, 0, 0);
  b.glyphs[3] = 5;
  b.ink[9] = 0; b.ink[10] = 255; b.ink[11] = 0;
  const out = unpackClip(packClip({ cols: 4, rows: 2, fps: 12, frames: [a, b] }));
  assert.equal(out.cols, 4);
  assert.equal(out.rows, 2);
  assert.equal(out.fps, 12);
  assert.equal(out.frames.length, 2);
  assert.deepEqual([...out.frames[0].glyphs], [...a.glyphs]);
  assert.deepEqual([...out.frames[1].glyphs], [...b.glyphs]);
  assert.deepEqual([...out.frames[0].ink], [...a.ink]);
  assert.deepEqual([...out.frames[1].ink], [...b.ink]);
});

test("a later frame that only changes one cell packs smaller than a keyframe pair", () => {
  const a = solid(16, 8, 2, 10, 20, 30);
  const b = solid(16, 8, 2, 10, 20, 30);
  b.glyphs[0] = 9;
  const packed = packClip({ cols: 16, rows: 8, fps: 12, frames: [a, b] });
  const twice = packClip({ cols: 16, rows: 8, fps: 12, frames: [a] });
  assert.ok(packed.length < twice.length * 2 - 16, `${packed.length} vs 2x ${twice.length}`);
});

test("makePalette caps at the requested size and indices expand back to palette colours", () => {
  const ink = new Uint8Array(400 * 3);
  for (let i = 0; i < 400; i++) { ink[i * 3] = i % 256; ink[i * 3 + 1] = (i * 5) % 256; ink[i * 3 + 2] = (i * 13) % 256; }
  const pal = makePalette(ink, 64);
  assert.equal(pal.length, 64 * 3);
  const idx = indexInk(ink.subarray(0, 9), pal);
  const back = expandInk(idx, pal);
  assert.equal(back.length, 9);
  for (let i = 0; i < 3; i++) {
    let best = Infinity;
    for (let p = 0; p < pal.length; p += 3) {
      const d = (pal[p] - ink[i * 3]) ** 2 + (pal[p + 1] - ink[i * 3 + 1]) ** 2 + (pal[p + 2] - ink[i * 3 + 2]) ** 2;
      if (d < best) best = d;
    }
    const got = (back[i * 3] - ink[i * 3]) ** 2 + (back[i * 3 + 1] - ink[i * 3 + 1]) ** 2 + (back[i * 3 + 2] - ink[i * 3 + 2]) ** 2;
    assert.equal(got, best);
  }
});

test("unpackClip rejects a buffer that is not a clip", () => {
  assert.throws(() => unpackClip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])));
});
