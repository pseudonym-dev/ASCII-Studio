import { test } from "node:test";
import assert from "node:assert/strict";
import { openVideo } from "../../web/src/frames.js";

/** Minimal stand-in for HTMLVideoElement: just events and `src`. */
class FakeVideo extends EventTarget {
  src = "";
  listeners = /** @type {Record<string, number>} */ ({});
  count = () => ["loadeddata", "error"].map((t) => this.listeners[t] ?? 0);
  /** @param {string} t @param {any} fn @param {any} [o] */
  addEventListener(t, fn, o) { this.listeners[t] = (this.listeners[t] ?? 0) + 1; super.addEventListener(t, fn, o); }
  /** @param {string} t @param {any} fn */
  removeEventListener(t, fn) { this.listeners[t] -= 1; super.removeEventListener(t, fn); }
}

test("openVideo resolves on loadeddata and leaves no listeners behind", async () => {
  const v = new FakeVideo();
  const opened = openVideo(/** @type {any} */ (v), "blob:x");
  assert.equal(v.src, "blob:x");
  v.dispatchEvent(new Event("loadeddata"));
  await opened;
  assert.deepEqual(v.count(), [0, 0]);
});

test("openVideo rejects on error and leaves no listeners behind", async () => {
  const v = new FakeVideo();
  const opened = openVideo(/** @type {any} */ (v), "blob:y");
  v.dispatchEvent(new Event("error"));
  await assert.rejects(opened, /Couldn't open/);
  assert.deepEqual(v.count(), [0, 0]);
});
