import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool, latestWins } from "../../web/src/pool.js";

/** Fake Worker: records posted messages; the test answers or fails them by hand. */
class FakeWorker {
  static all = /** @type {FakeWorker[]} */ ([]);
  /** @type {any[]} */ posted = [];
  /** @type {any} */ onmessage = null;
  /** @type {any} */ onerror = null;
  constructor() { FakeWorker.all.push(this); }
  postMessage(/** @type {any} */ m) {
    if (this.failNextPost) { this.failNextPost = false; throw new Error("DataCloneError"); }
    this.posted.push(m);
  }
  reply() { this.onmessage?.({ data: { grid: { cols: 1, rows: 1 }, workerMs: 1 } }); }
  failNextPost = false;
  terminate() {}
}
const req = () => ({ rgba: new Uint8ClampedArray(4) });

test("a late worker error after the reply does not hand the worker out twice", async () => {
  FakeWorker.all.length = 0;
  Object.assign(globalThis, { Worker: FakeWorker });
  const pool = new Pool("//", 1);
  const w = FakeWorker.all[0];
  const first = pool.run(/** @type {any} */ (req()));
  w.reply();
  await first;
  w.onerror?.({ message: "late" }); // used to push the same worker into `idle` a second time
  const a = pool.run(/** @type {any} */ (req())), b = pool.run(/** @type {any} */ (req()));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.posted.length, 2, "only one new job may be in flight on a one-worker pool");
  w.reply();
  await a;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.posted.length, 3);
  w.reply();
  await b;
  pool.terminate();
});

test("a worker error rejects only its own job", async () => {
  FakeWorker.all.length = 0;
  const pool = new Pool("//", 2);
  const [w1, w2] = FakeWorker.all;
  const a = pool.run(/** @type {any} */ (req())), b = pool.run(/** @type {any} */ (req()));
  w2.onerror?.({ message: "boom" }); // the pool hands out the last idle worker first, so `a` runs on w2
  w1.reply();
  await assert.rejects(a, /boom/);
  assert.equal((await b).workerMs, 1);
  pool.terminate();
});

test("a request that cannot be posted rejects and gives the worker back", async () => {
  FakeWorker.all.length = 0;
  const pool = new Pool("//", 1);
  const w = FakeWorker.all[0];
  w.failNextPost = true;
  await assert.rejects(pool.run(/** @type {any} */ (req())), /DataCloneError/);
  const next = pool.run(/** @type {any} */ (req()));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.posted.length, 1, "the worker must be reusable after a failed post");
  w.reply();
  await next;
  pool.terminate();
});

test("latestWins runs the newest pending request and skips the stale ones", async () => {
  /** @type {number[]} */ const seen = [];
  let release = () => {};
  const runner = latestWins(async (/** @type {number} */ n) => { seen.push(n); await new Promise((r) => { release = () => r(undefined); }); });
  runner.request(1);
  runner.request(2);
  runner.request(3);
  assert.equal(runner.busy, true);
  release();
  await new Promise((r) => setTimeout(r, 5));
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [1, 3]);
  assert.equal(runner.busy, false);
});
