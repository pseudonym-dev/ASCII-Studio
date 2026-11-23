import { test } from "node:test";
import assert from "node:assert/strict";
import { openVideo } from "../../web/src/frames.js";

/** Minimal stand-in for HTMLVideoElement: just events and `src`. */
class FakeVideo extends EventTarget {
  src = "";
  listeners = /** @type {Record<string, number>} */ ({});
  count = () => ["loadeddata", "loadedmetadata", "error"].map((t) => this.listeners[t] ?? 0);
  readyState = 0;
  plays = 0;
  pauses = 0;
  play() { this.plays++; return Promise.resolve(); }
  pause() { this.pauses++; }
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
  assert.deepEqual(v.count(), [0, 0, 0]);
});

test("openVideo rejects on error and leaves no listeners behind", async () => {
  const v = new FakeVideo();
  const opened = openVideo(/** @type {any} */ (v), "blob:y");
  v.dispatchEvent(new Event("error"));
  await assert.rejects(opened, /Couldn't open/);
  assert.deepEqual(v.count(), [0, 0, 0]);
});

test("openVideo nudges a muted play/pause when only metadata arrives (iOS Safari)", async () => {
  const v = new FakeVideo();
  const opened = openVideo(/** @type {any} */ (v), "blob:z");
  v.dispatchEvent(new Event("loadedmetadata"));
  await Promise.resolve();
  assert.equal(v.plays, 1);
  await Promise.resolve();
  assert.equal(v.pauses, 1);
  v.dispatchEvent(new Event("loadeddata"));
  await opened;
  assert.deepEqual(v.count(), [0, 0, 0]);
});

test("openVideo gives up with an error instead of hanging", async () => {
  const v = new FakeVideo();
  await assert.rejects(openVideo(/** @type {any} */ (v), "blob:w", 10), /didn't load the video/);
  assert.deepEqual(v.count(), [0, 0, 0]);
});
