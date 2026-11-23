/** Pack and unpack pre-rendered ASCII clips (glyph ids + palettized ink, with frame deltas). */

/**
 * @typedef {object} PackedFrame
 * @property {Uint8Array} glyphs
 * @property {Uint8Array} ink  r,g,b per cell
 */

/**
 * @typedef {object} PackedClip
 * @property {number} cols
 * @property {number} rows
 * @property {number} fps
 * @property {PackedFrame[]} frames
 */

const MAGIC = 0x41535831; // ASX1
const MAX_COLORS = 256;

/** @param {Uint8Array} ink  concatenated rgb triples @param {number} [maxColors] */
export function makePalette(ink, maxColors = MAX_COLORS) {
  /** @type {number[][]} */
  const pts = [];
  for (let i = 0; i < ink.length; i += 3) pts.push([ink[i], ink[i + 1], ink[i + 2]]);
  if (pts.length === 0) return new Uint8Array([0, 0, 0]);
  /** @type {Map<number, number[]>} */
  const uniq = new Map();
  for (const p of pts) uniq.set((p[0] << 16) | (p[1] << 8) | p[2], p);
  const colors = [...uniq.values()];
  if (colors.length <= maxColors) {
    const pal = new Uint8Array(colors.length * 3);
    colors.forEach((p, i) => pal.set(p, i * 3));
    return pal;
  }
  /** @type {{pts: number[][]}[]} */
  const boxes = [{ pts: colors }];
  while (boxes.length < maxColors) {
    let splitAt = 0, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const span = channelSpan(boxes[i].pts);
      if (span.range > best) { best = span.range; splitAt = i; }
    }
    if (best <= 0) break;
    const [a, b] = splitBox(boxes[splitAt].pts, channelSpan(boxes[splitAt].pts).axis);
    if (!b.length) break;
    boxes.splice(splitAt, 1, { pts: a }, { pts: b });
  }
  const pal = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    const n = box.pts.length;
    let r = 0, g = 0, b = 0;
    for (const p of box.pts) { r += p[0]; g += p[1]; b += p[2]; }
    pal[i * 3] = Math.round(r / n);
    pal[i * 3 + 1] = Math.round(g / n);
    pal[i * 3 + 2] = Math.round(b / n);
  });
  return pal;
}

/** @param {number[][]} pts */
function channelSpan(pts) {
  let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
  for (const p of pts) {
    if (p[0] < r0) r0 = p[0]; if (p[0] > r1) r1 = p[0];
    if (p[1] < g0) g0 = p[1]; if (p[1] > g1) g1 = p[1];
    if (p[2] < b0) b0 = p[2]; if (p[2] > b1) b1 = p[2];
  }
  const spans = [r1 - r0, g1 - g0, b1 - b0];
  const axis = spans[0] >= spans[1] && spans[0] >= spans[2] ? 0 : spans[1] >= spans[2] ? 1 : 2;
  return { axis, range: spans[axis] };
}

/** @param {number[][]} pts @param {number} axis */
function splitBox(pts, axis) {
  const sorted = pts.slice().sort((a, b) => a[axis] - b[axis]);
  const mid = Math.max(1, Math.min(sorted.length - 1, Math.floor(sorted.length / 2)));
  return [sorted.slice(0, mid), sorted.slice(mid)];
}

/** Nearest palette index for one rgb triple. @param {Uint8Array} pal @param {number} r @param {number} g @param {number} b */
export function nearestColor(pal, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0, k = 0; i < pal.length; i += 3, k++) {
    const dr = pal[i] - r, dg = pal[i + 1] - g, db = pal[i + 2] - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = k; if (d === 0) return k; }
  }
  return best;
}

/** @param {Uint8Array} ink @param {Uint8Array} pal */
export function indexInk(ink, pal) {
  const n = ink.length / 3;
  const idx = new Uint8Array(n);
  for (let i = 0; i < n; i++) idx[i] = nearestColor(pal, ink[i * 3], ink[i * 3 + 1], ink[i * 3 + 2]);
  return idx;
}

/** Expand palette indices to rgb ink. @param {Uint8Array} idx @param {Uint8Array} pal */
export function expandInk(idx, pal) {
  const ink = new Uint8Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    const p = idx[i] * 3;
    ink[i * 3] = pal[p]; ink[i * 3 + 1] = pal[p + 1]; ink[i * 3 + 2] = pal[p + 2];
  }
  return ink;
}

/**
 * Encode a clip to the ASX1 binary (not gzipped).
 * @param {PackedClip} clip
 */
export function packClip(clip) {
  const { cols, rows, fps, frames } = clip;
  const n = cols * rows;
  const allInk = new Uint8Array(frames.length * n * 3);
  frames.forEach((f, i) => allInk.set(f.ink, i * n * 3));
  const pal = makePalette(allInk);
  const indexed = frames.map((f) => ({ glyphs: f.glyphs, idx: indexInk(f.ink, pal) }));
  /** @type {Uint8Array[]} */
  const chunks = [];
  const head = new Uint8Array(13 + pal.length);
  const v = new DataView(head.buffer);
  v.setUint32(0, MAGIC);
  v.setUint16(4, cols);
  v.setUint16(6, rows);
  head[8] = fps;
  v.setUint16(9, frames.length);
  v.setUint16(11, pal.length / 3);
  head.set(pal, 13);
  chunks.push(head);
  let prev = /** @type {{glyphs: Uint8Array, idx: Uint8Array} | null} */ (null);
  for (const f of indexed) {
    const key = new Uint8Array(1 + n * 2);
    key[0] = 0;
    key.set(f.glyphs, 1);
    key.set(f.idx, 1 + n);
    if (!prev) { chunks.push(key); prev = f; continue; }
    const bits = new Uint8Array(Math.ceil(n / 8));
    /** @type {number[]} */
    const changed = [];
    for (let i = 0; i < n; i++) {
      if (f.glyphs[i] !== prev.glyphs[i] || f.idx[i] !== prev.idx[i]) {
        bits[i >> 3] |= 1 << (i & 7);
        changed.push(i);
      }
    }
    const delta = new Uint8Array(1 + bits.length + changed.length * 2);
    delta[0] = 1;
    delta.set(bits, 1);
    changed.forEach((i, k) => { delta[1 + bits.length + k * 2] = f.glyphs[i]; delta[1 + bits.length + k * 2 + 1] = f.idx[i]; });
    chunks.push(delta.length < key.length ? delta : key);
    prev = f;
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Decode an ASX1 binary (not gzipped).
 * @param {Uint8Array} buf
 * @returns {PackedClip}
 */
export function unpackClip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (v.getUint32(0) !== MAGIC) throw new Error("Not an ASCII clip.");
  const cols = v.getUint16(4), rows = v.getUint16(6), fps = buf[8], frameCount = v.getUint16(9);
  const palN = v.getUint16(11);
  const pal = buf.subarray(13, 13 + palN * 3);
  let o = 13 + palN * 3;
  const n = cols * rows;
  /** @type {PackedFrame[]} */
  const frames = [];
  let prevG = new Uint8Array(n), prevI = new Uint8Array(n);
  for (let f = 0; f < frameCount; f++) {
    const kind = buf[o++];
    const glyphs = new Uint8Array(n), idx = new Uint8Array(n);
    if (kind === 0) {
      glyphs.set(buf.subarray(o, o + n)); o += n;
      idx.set(buf.subarray(o, o + n)); o += n;
    } else if (kind === 1) {
      glyphs.set(prevG); idx.set(prevI);
      const bits = buf.subarray(o, o + Math.ceil(n / 8)); o += bits.length;
      for (let i = 0; i < n; i++) {
        if (bits[i >> 3] & (1 << (i & 7))) {
          glyphs[i] = buf[o++];
          idx[i] = buf[o++];
        }
      }
    } else throw new Error("Unknown clip frame type.");
    prevG = glyphs; prevI = idx;
    frames.push({ glyphs, ink: expandInk(idx, pal) });
  }
  return { cols, rows, fps, frames };
}

/** @param {Uint8Array} bytes */
export async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("This browser cannot decompress the examples.");
  const ab = bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : bytes.slice().buffer;
  const out = await new Response(new Blob([ab]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return new Uint8Array(out);
}
