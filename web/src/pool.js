/** @typedef {import("./core.js").Grid} Grid */
/** @typedef {import("./core.js").GridRequest} GridRequest */
/** @typedef {Grid & {workerMs: number}} TimedGrid */

/**
 * @typedef {object} Job
 * @property {(g: TimedGrid) => void} resolve
 * @property {(e: Error) => void} reject
 */

/** Fixed-size pool of grid workers built from one source string. */
export class Pool {
  /** @param {string} source bundled worker code @param {number} size */
  constructor(source, size) {
    this.url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    /** @type {Map<Worker, Job | null>} */
    this.jobs = new Map();
    /** @type {Worker[]} */
    this.idle = [];
    /** @type {(() => void)[]} */
    this.waiting = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(this.url);
      w.onmessage = (e) => this.finish(w, e.data);
      w.onerror = (e) => this.finish(w, { error: e.message || "worker error" });
      this.jobs.set(w, null);
      this.idle.push(w);
    }
  }

  /**
   * @param {Worker} w
   * @param {{grid?: Grid, workerMs?: number, error?: string}} msg
   */
  finish(w, msg) {
    const job = this.jobs.get(w);
    if (!job) return; // a late error after the reply must not put the worker in the idle list twice
    this.jobs.set(w, null);
    this.idle.push(w);
    this.waiting.shift()?.();
    if (msg.error || !msg.grid) job.reject(new Error(msg.error || "worker failed"));
    else job.resolve({ ...msg.grid, workerMs: msg.workerMs ?? 0 });
  }

  /**
   * Run one frame; waits for a free worker. Transfers `req.rgba`.
   * @param {GridRequest} req @returns {Promise<TimedGrid>}
   */
  async run(req) {
    while (!this.idle.length) await new Promise((r) => this.waiting.push(() => r(undefined)));
    const w = /** @type {Worker} */ (this.idle.pop());
    return new Promise((resolve, reject) => {
      this.jobs.set(w, { resolve, reject });
      try {
        w.postMessage(req, [req.rgba.buffer]);
      } catch (e) { // a request that cannot be posted must not strand the worker
        this.finish(w, { error: String(e) });
      }
    });
  }

  terminate() {
    for (const w of this.jobs.keys()) w.terminate();
    URL.revokeObjectURL(this.url);
    this.jobs.clear();
    this.idle.length = 0;
  }
}

/**
 * Serialises async work and keeps only the newest request while one is running.
 * @template T
 * @param {(arg: T) => Promise<void>} task
 * @param {{onError?: (e: unknown) => void, onIdle?: () => void}} [hooks]
 */
export function latestWins(task, { onError = console.error, onIdle = () => {} } = {}) {
  /** @type {{arg: T} | null} */
  let pending = null;
  let running = false;
  async function drain() {
    running = true;
    while (pending) {
      const { arg } = pending;
      pending = null;
      try { await task(arg); } catch (e) { onError(e); }
    }
    running = false;
    onIdle();
  }
  return {
    /** @param {T} arg */
    request(arg) { pending = { arg }; if (!running) drain(); },
    get busy() { return running; },
  };
}
