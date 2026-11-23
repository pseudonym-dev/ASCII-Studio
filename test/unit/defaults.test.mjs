import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_LOOK, densityLabel, edgesLabel, zoomLabel } from "../../web/src/defaults.js";

const html = readFileSync(new URL("../../web/template.html", import.meta.url), "utf8");

/** @param {string} id */
function tagFor(id) {
  const m = html.match(new RegExp(`<(?:input|button|select)[^>]*\\sid="${id}"[^>]*>`));
  assert.ok(m, `${id} is missing from the template`);
  return m[0];
}

test("the starting look is 158 columns, 85% zoom, 1.10× edges, and Glow", () => {
  assert.deepEqual(DEFAULT_LOOK, {
    density: 158,
    zoom: 85,
    edges: 110,
    mono: false,
    glow: true,
    sep: true,
  });
  assert.equal(densityLabel(DEFAULT_LOOK.density), "158 columns");
  assert.equal(zoomLabel(DEFAULT_LOOK.zoom), "85%");
  assert.equal(edgesLabel(DEFAULT_LOOK.edges), "1.10×");
});

test("template.html ships the same starting look, already disabled on the empty home screen", () => {
  const density = tagFor("density");
  const zoom = tagFor("zoom");
  const edges = tagFor("edges");
  assert.match(density, /value="158"/);
  assert.match(html, /id="densityVal">158 columns</);
  assert.match(zoom, /value="85"/);
  assert.match(html, /id="zoomVal">85%</);
  assert.match(edges, /value="110"/);
  assert.match(html, /id="edgesVal">1\.10×</);
  assert.match(tagFor("glow"), /aria-pressed="true"/);
  assert.match(tagFor("mono"), /aria-pressed="false"/);
  assert.match(tagFor("sep"), /aria-pressed="true"/);

  assert.match(html, /id="sidebarControls"[^>]*\binert\b/);
  assert.match(html, /id="sidebarControls"[^>]*aria-disabled="true"/);
  for (const id of ["density", "zoom", "edges", "mono", "glow", "sep", "dlPng", "copy", "dlTxt", "fmt", "res", "gifw", "fps"]) {
    assert.match(tagFor(id), /\bdisabled\b/, `${id} should start disabled`);
  }
  assert.doesNotMatch(tagFor("closeSidebar"), /\bdisabled\b/);
});
