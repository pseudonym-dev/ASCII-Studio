import { computeGrid } from "./core.js";

/** @type {{onmessage: ((e: MessageEvent) => void) | null, postMessage: (m: unknown, t?: Transferable[]) => void}} */
const scope = /** @type {any} */ (self);

scope.onmessage = (e) => {
  /** @type {import("./core.js").GridRequest} */
  const req = e.data;
  const t0 = performance.now();
  try {
    const grid = computeGrid(req);
    scope.postMessage({ grid, workerMs: performance.now() - t0 }, [grid.glyphs.buffer, grid.ink.buffer]);
  } catch (err) {
    scope.postMessage({ error: String(err && /** @type {Error} */ (err).message || err) });
  }
};
