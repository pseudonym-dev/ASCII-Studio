// End-to-end check in headless Chrome: images, video preview, MP4/WebM/GIF export validated with ffprobe.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, sleep } from "./cdp.mjs";

const root = new URL("../../", import.meta.url).pathname;
const art = join(root, "artifacts"), dl = join(art, "exports"), shots = join(art, "shots");
rmSync(dl, { recursive: true, force: true });
for (const d of [dl, shots]) mkdirSync(d, { recursive: true });
const sample = (/** @type {string} */ f) => join(root, "samples", f);

/** @type {{name: string, ok: boolean, detail: string}[]} */
const results = [];
const check = (/** @type {string} */ name, /** @type {unknown} */ ok, detail = "") => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const ffprobe = (/** @type {string} */ file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));

mkdirSync(join(art, "tmp"), { recursive: true });
const longVideo = join(art, "tmp", "long20s.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10", "-t", "20", "-pix_fmt", "yuv420p", longVideo]);
const audioOnly = join(art, "tmp", "audio-only.mp4");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", audioOnly]);
const longGop = join(art, "tmp", "longgop.mp4"); // worst case for seeking: one keyframe for the whole clip
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", sample("clownfish-video.mp4"), "-t", "3", "-c:v", "libx264", "-g", "9999", "-keyint_min", "9999", "-sc_threshold", "0", "-pix_fmt", "yuv420p", longGop]);
const bigFile = join(art, "tmp", "too-big.mp4");
execFileSync("truncate", ["-s", "101M", bigFile]);

const b = await launch({ downloads: dl });
const waitFor = async (/** @type {string} */ expr, timeout = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await b.ev(expr)) return true; await sleep(100); }
  return false;
};
const setValue = (/** @type {string} */ id, /** @type {string | number} */ v, ev = "input") =>
  b.ev(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(String(v))};e.dispatchEvent(new Event(${JSON.stringify(ev)},{bubbles:true}));})()`);
const click = (/** @type {string} */ id) => b.ev(`document.getElementById(${JSON.stringify(id)}).click()`);
const renders = () => b.ev("ASCII.stats.renders || 0");

try {
  await b.goto("file://" + join(root, "web/ascii-studio.html"));
  const scheme = (/** @type {string} */ value) => b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  const defaultLook = "document.getElementById('density').value === '158' && document.getElementById('densityVal').textContent === '158 columns' && document.getElementById('zoom').value === '85' && document.getElementById('zoomVal').textContent === '85%' && document.getElementById('edges').value === '110' && document.getElementById('edgesVal').textContent === '1.10×' && document.getElementById('glow').getAttribute('aria-pressed') === 'true' && document.getElementById('mono').getAttribute('aria-pressed') === 'false' && document.getElementById('sep').getAttribute('aria-pressed') === 'true'";
  const sidebarIdle = "document.getElementById('sidebarControls').inert && document.getElementById('sidebarControls').getAttribute('aria-disabled') === 'true' && document.getElementById('density').disabled && document.getElementById('glow').disabled && document.getElementById('dlPng').disabled && getComputedStyle(document.getElementById('workspace')).display !== 'none' && getComputedStyle(document.getElementById('sidebar')).display !== 'none' && getComputedStyle(document.getElementById('home')).display !== 'none' && getComputedStyle(document.getElementById('stage')).display === 'none' && document.getElementById('videoBar').hidden";
  check("starts on the home screen, with the stage hidden and the sidebar visible", await b.ev("ASCII.mode === 'home' && document.body.classList.contains('home') && " + sidebarIdle));
  check("the empty sidebar shows the starting look, disabled", await b.ev(defaultLook));
  check("no media is loaded until the user chooses a file", await b.ev("(ASCII.stats.renders || 0) === 0"));
  check("the drop zone explains what to do", await b.ev("document.getElementById('dropzone').textContent.includes('Drop a video or image here') && document.getElementById('dropzone').textContent.includes('15 s') && document.getElementById('dropzone').textContent.includes('100 MB')"));
  check("choose file lives in the drop zone on home", await b.ev("document.getElementById('dropzone').contains(document.getElementById('homeFileBtn')) && getComputedStyle(document.getElementById('fileBtn')).display === 'none'"));
  check("three example clips are listed under the drop zone", await b.ev("document.querySelectorAll('#exampleGrid canvas').length === 3"));
  check("examples are visible without scrolling", await b.ev("(() => { const r = document.getElementById('examples').getBoundingClientRect(); return r.top >= 44 && r.top < innerHeight && r.bottom > r.top; })()"), await b.ev("String(document.getElementById('examples').getBoundingClientRect().top)"));
  check("the sidebar hint says a file can be dropped anywhere on the page", await b.ev("document.querySelector('#sidebarControls > .hint').textContent.includes('anywhere on this page') && !document.getElementById('sidebar').textContent.includes('dark area')"));
  check("example credits name the authors", await b.ev("['Eaktas06','ahrordzon','xBriantcx'].every((n) => document.getElementById('exampleGrid').textContent.includes(n))"));
  check("visible examples start playing", await waitFor("[...document.querySelectorAll('#exampleGrid canvas')].some((c) => c.dataset.ready === '1')", 10000));
  check("example cards share a 16:9 frame", await b.ev("[...document.querySelectorAll('.example-stage')].every((c) => Math.abs(c.clientWidth / c.clientHeight - 16/9) < 0.05)"));
  check("example letters are painted, not a blank card", await b.ev("(() => { const c = document.querySelector('#exampleGrid canvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; return [...d].some((v, i) => i % 4 !== 3 && v > 20); })()"));
  await scheme("light");
  await sleep(200);
  await b.screenshot(join(shots, "empty-light.png"));
  await scheme("dark");
  await sleep(200);
  await b.screenshot(join(shots, "empty-dark.png"));
  await scheme("light");
  await b.ev("document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }))");
  await b.ev("document.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }))");
  check("the drop zone is highlighted while a file is dragged", await b.ev("document.getElementById('dropzone').classList.contains('drag')"));
  await sleep(150);
  await b.screenshot(join(shots, "empty-dragover.png"));
  await b.ev("document.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))");
  const zoomUrl = await b.ev("ASCII.exampleZoomDataURL(4)");
  check("sharp zoom of example letters is available", typeof zoomUrl === "string" && zoomUrl.startsWith("data:image/png") && zoomUrl.length > 8000, String(zoomUrl).slice(0, 40));
  if (typeof zoomUrl === "string" && zoomUrl.includes(",")) writeFileSync(join(shots, "examples-zoom.png"), Buffer.from(zoomUrl.split(",")[1], "base64"));

  await b.ev("document.querySelector('#exampleGrid figure').click()");
  check("clicking an example opens the editor", await waitFor("ASCII.mode === 'editor' && !document.getElementById('videoBar').hidden && ASCII.stats.playing && document.getElementById('foot').textContent.includes('example-toucan.mp4')", 30000), await b.ev("ASCII.mode + ' ' + document.getElementById('foot').textContent"));
  check("the example opens at the starting look, with separation off for video", await b.ev("document.getElementById('density').value === '158' && document.getElementById('zoom').value === '85' && document.getElementById('edges').value === '110' && document.getElementById('glow').getAttribute('aria-pressed') === 'true' && document.getElementById('mono').getAttribute('aria-pressed') === 'false' && document.getElementById('sep').getAttribute('aria-pressed') === 'false'"));
  check("examples are hidden in the editor", await b.ev("getComputedStyle(document.getElementById('home')).display === 'none' && getComputedStyle(document.getElementById('stage')).display !== 'none'"));
  check("loading an example enables the sidebar controls", await b.ev("!document.getElementById('sidebarControls').inert && document.getElementById('sidebarControls').getAttribute('aria-disabled') === 'false' && !document.getElementById('density').disabled && !document.getElementById('glow').disabled"));
  check("choose file and export live in the top bar", await b.ev("document.getElementById('topbar').contains(document.getElementById('fileBtn')) && document.getElementById('topbar').contains(document.getElementById('exportBtn')) && getComputedStyle(document.getElementById('fileBtn')).display !== 'none'"));
  check("adjust settings live in the sidebar, not the transport", await b.ev("document.getElementById('sidebar').contains(document.getElementById('density')) && document.getElementById('sidebar').contains(document.getElementById('fmt')) && !document.getElementById('sidebar').contains(document.getElementById('playBtn'))"));
  check("menu button is hidden on a wide window", await b.ev("getComputedStyle(document.getElementById('menuBtn')).display === 'none'"));
  await sleep(400);
  await b.screenshot(join(shots, "editor-from-example.png"));

  await setValue("density", 60);
  await click("glow");
  check("the look can be changed in the editor", await b.ev("document.getElementById('density').value === '60' && document.getElementById('glow').getAttribute('aria-pressed') === 'false'"));
  await click("homeBtn");
  check("The title returns to the home screen and clears the session", await waitFor("ASCII.mode === 'home' && document.getElementById('videoBar').hidden && (ASCII.stats.renders || 0) === 0 && document.getElementById('sourceVideo').paused", 5000), await b.ev("ASCII.mode + ' renders=' + (ASCII.stats.renders || 0)"));
  check("The title restores the starting look and disables the sidebar", await b.ev(defaultLook + " && " + sidebarIdle), await b.ev("['density','zoom','edges'].map((id)=>document.getElementById(id).value).join(',') + ' glow=' + document.getElementById('glow').getAttribute('aria-pressed') + ' inert=' + document.getElementById('sidebarControls').inert"));

  await b.ev("document.querySelector('#exampleGrid figure').click()");
  await click("homeBtn");
  await sleep(3000);
  check("the title cancels an in-flight load and stays on home", await b.ev("ASCII.mode === 'home' && document.getElementById('sourceVideo').paused && (ASCII.stats.renders || 0) === 0 && !/failed|error|no video|too large/i.test(document.getElementById('homeStatus').textContent)"), await b.ev("ASCII.mode + ' status=' + document.getElementById('homeStatus').textContent"));

  // ---- limits (from home)
  await b.setFiles("#file", [bigFile]);
  check("file over 100 MB is refused", await waitFor("document.getElementById('homeStatus').textContent.includes('too large')", 5000), await b.ev("document.getElementById('homeStatus').textContent"));
  check("a refused file leaves the user on the home screen", await b.ev("ASCII.mode === 'home'"));

  // ---- image flow still works
  let n = await renders();
  await b.setFiles("#file", [sample("clownfish-real.jpg")]);
  check("choosing an image opens the editor", await waitFor("ASCII.mode === 'editor' && ASCII.stats.renders > 0", 30000));
  await waitFor(`ASCII.stats.renders > ${n}`);
  check("background separation defaults ON for images", await b.ev("ASCII.sepOn"));
  check("an image opens at the starting look", await b.ev(defaultLook + " && ASCII.stats.cols === 158 && document.getElementById('glow').getAttribute('aria-pressed') === 'true'"));
  check("choosing a file enables the sidebar controls", await b.ev("!document.getElementById('sidebarControls').inert && !document.getElementById('density').disabled"));
  check("video controls hidden for images", await b.ev("document.getElementById('videoBar').hidden && document.getElementById('exportBar').hidden && document.getElementById('topExport').hidden"));
  await scheme("light");
  await sleep(200);
  await b.screenshot(join(shots, "editor-defaults.png"));
  await setValue("density", 160);
  await waitFor(`ASCII.stats.cols === 160`);
  const imgStats = await b.ev("ASCII.stats");
  check("image at 160 cols has a subject", imgStats.hasSubject && imgStats.rows === 133, JSON.stringify(imgStats));
  check("text export is pure ASCII", await b.ev("/^[\\x20-\\x7e\\n]*$/.test(ASCII.text) && ASCII.text.split('\\n').length === 133"));
  await b.screenshot(join(shots, "image-160.png"));
  await scheme("light");
  await sleep(200);
  await b.screenshot(join(shots, "editor-image.png"));
  check("image view has no transport under the stage", await b.ev("document.getElementById('videoBar').hidden"));

  await click("homeBtn");
  check("the title returns to the home screen", await waitFor("ASCII.mode === 'home' && (ASCII.stats.renders || 0) === 0", 5000));
  check("returning home restores the starting look and disables the sidebar", await b.ev(defaultLook + " && " + sidebarIdle));
  await b.setFiles("#file", [sample("clownfish-real.jpg")]);
  await waitFor("ASCII.mode === 'editor' && ASCII.stats.renders > 0", 30000);

    // ---- a video without picture is refused and the image stays on stage
  n = await renders();
  await b.setFiles("#file", [audioOnly]);
  check("audio-only file is refused with a message", await waitFor("document.getElementById('status').textContent.includes('no video picture')", 15000), await b.ev("document.getElementById('status').textContent"));
  check("the refusal message stays after the previous image is redrawn", await waitFor(`ASCII.stats.renders > ${n}`, 5000) && await b.ev("document.getElementById('status').textContent.includes('no video picture')"), await b.ev("document.getElementById('status').textContent"));
  check("failed video load keeps the image and its separation default", await b.ev("ASCII.sepOn && document.getElementById('videoBar').hidden"));

  // ---- two videos chosen back to back: the last one wins
  await b.setFiles("#file", [sample("clownfish-video.mp4")]);
  await b.setFiles("#file", [sample("testsrc.mp4")]);
  await waitFor("!document.getElementById('videoBar').hidden && ASCII.stats.playing", 30000);
  await sleep(1500);
  check("last of two quick loads wins", await b.ev("document.getElementById('tEnd').value") === "3.0", await b.ev("document.getElementById('tEnd').value"));

  // ---- video: testsrc.mp4
  n = await renders();
  await b.setFiles("#file", [sample("testsrc.mp4")]);
  check("video bar appears after loading testsrc.mp4", await waitFor("!document.getElementById('videoBar').hidden", 30000));
  check("background separation defaults OFF for video", await b.ev("!ASCII.sepOn"));
  check("GIF width stays hidden while the format is MP4", await b.ev("document.getElementById('fmt').value === 'mp4' && getComputedStyle(document.getElementById('gifCtl')).display === 'none'"));
  await setValue("density", 60);
  await sleep(300);
  const r0 = await renders();
  await sleep(2000);
  const r1 = await renders();
  const playingStats = await b.ev("ASCII.stats");
  check("preview animates live while playing", playingStats.playing && r1 - r0 >= 6, `${r1 - r0} frames in 2 s`);
  check("preview is not stuck at one time", await b.ev("(()=>{const a=document.getElementById('timeVal').textContent;return a})()") !== "0.0 / 3.0 s");
  await click("playBtn");
  await sleep(500);
  const pausedAt = await renders();
  await sleep(600);
  check("pause stops animation", (await renders()) - pausedAt <= 1, `${(await renders()) - pausedAt} renders after pause`);
  await setValue("scrub", 500);
  await sleep(500);
  check("scrub moves the playhead", (await b.ev("document.getElementById('timeVal').textContent")).startsWith("1.5"), await b.ev("document.getElementById('timeVal').textContent"));
  check("playhead sits at mid-timeline when the trim is the whole clip", await b.ev("Math.abs(parseFloat(document.getElementById('playhead').style.left) - 50) < 2"), await b.ev("document.getElementById('playhead').style.left"));
  await setValue("tStart", 1, "change");
  await setValue("tEnd", 2, "change");
  check("timeline span follows the trim window", await b.ev("(() => { const s = document.getElementById('timelineSpan'); return Math.abs(parseFloat(s.style.left) - 100/3) < 2 && Math.abs(parseFloat(s.style.width) - 100/3) < 2; })()"), await b.ev("document.getElementById('timelineSpan').style.left + ' ' + document.getElementById('timelineSpan').style.width"));
  await setValue("tStart", 0, "change");
  await setValue("tEnd", 3, "change");
  await setValue("scrub", 800);
  await sleep(300);
  const dragged = await b.ev(`(() => {
    const track = document.getElementById("timelineTrack");
    const r = track.getBoundingClientRect();
    const ev = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height / 2, pointerId: 1, pointerType: "mouse" });
    document.getElementById("trimEnd").dispatchEvent(ev("pointerdown", r.left + r.width));
    window.dispatchEvent(ev("pointermove", r.left + r.width * 0.5));
    window.dispatchEvent(ev("pointerup", r.left + r.width * 0.5));
    return { tEnd: document.getElementById("tEnd").value, current: document.getElementById("sourceVideo").currentTime };
  })()`);
  check("dragging the end handle back jumps a playhead past the trim to the start", Math.abs(Number(dragged.tEnd) - 1.5) < 0.2 && dragged.current <= 0.05, JSON.stringify(dragged));
  await setValue("tEnd", 3, "change");

  /** Export through the UI and validate with ffprobe. */
  async function exportAndProbe(/** @type {string} */ tag, /** @type {string} */ fmt, /** @type {Record<string, string | number>} */ opts) {
    const before = new Set(readdirSync(dl));
    await setValue("fmt", fmt, "change");
    for (const [id, v] of Object.entries(opts)) await setValue(id, v, id === "density" ? "input" : "change");
    const estimate = Number(((await b.ev("document.getElementById('exportInfo').textContent")).match(/≈ (\d+) s/) || [])[1]);
    check(`${tag}: time estimate is shown before exporting`, Number.isFinite(estimate), String(estimate));
    await click("exportBtn");
    const finished = await waitFor("!document.getElementById('exportBtn').hidden && /ready|failed|cancel/.test(document.getElementById('exportInfo').textContent)", 240000);
    const info = await b.ev("document.getElementById('exportInfo').textContent");
    const le = await b.ev("ASCII.lastExport");
    check(`${tag}: export finished`, finished && /ready/.test(info), info);
    await sleep(1200);
    const files = readdirSync(dl).filter((f) => !before.has(f) && !f.endsWith(".crdownload"));
    check(`${tag}: one file downloaded`, files.length === 1, files.join(","));
    if (files.length !== 1 || !le) return null;
    const file = join(dl, files[0]);
    const named = join(dl, `${tag}.${fmt}`);
    execFileSync("mv", [file, named]);
    const probe = ffprobe(named);
    const v = probe.streams.find((/** @type {any} */ s) => s.codec_type === "video");
    check(`${tag}: file name carries the export columns`, files[0].startsWith(`ascii-${le.cols}col-`), `${files[0]} vs ${le.cols}`);
    if (le.realtime) {
      // MediaRecorder fallback: real-time, variable timing; only require a decodable VP8/VP9 stream and the flag.
      check(`${tag}: fallback decodes`, /vp9|vp8/.test(v.codec_name) && Number(v.nb_read_frames) > 0, `${v.codec_name} ${v.nb_read_frames} frames`);
    } else {
      const [num, den] = v.r_frame_rate.split("/").map(Number);
      const frames = Number(v.nb_read_frames);
      const dur = Number(probe.format.duration);
      check(`${tag}: resolution ${le.width}x${le.height}`, v.width === le.width && v.height === le.height, `${v.width}x${v.height}`);
      check(`${tag}: frame count ${le.frames}`, frames === le.frames, `${frames}`);
      check(`${tag}: duration ~ ${(le.frames / le.fps).toFixed(2)} s`, Math.abs(dur - le.frames / le.fps) < (fmt === "gif" ? 0.1 : 0.3), `${dur.toFixed(2)} s`);
      if (fmt === "gif") check(`${tag}: GIF codec`, v.codec_name === "gif", v.codec_name);
      else {
        check(`${tag}: fps ${le.fps}`, Math.abs(num / den - le.fps) < 0.5, `${(num / den).toFixed(2)}`);
        check(`${tag}: codec`, fmt === "mp4" ? v.codec_name === "h264" : /vp9|vp8/.test(v.codec_name), v.codec_name);
      }
    }
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", named, "-vf", `select=eq(n\\,${Math.floor(le.frames / 2)})`, "-frames:v", "1", join(shots, `${tag}-frame.png`)]);
    check(`${tag}: frame extracted`, existsSync(join(shots, `${tag}-frame.png`)) && statSync(join(shots, `${tag}-frame.png`)).size > 5000);
    return { tag, estimatedSeconds: estimate, ...le, sizeMB: +(le.bytes / 1048576).toFixed(2), exportSeconds: +(le.ms / 1000).toFixed(1), file: named };
  }

  /** @type {any[]} */
  const exported = [];
  const push = (/** @type {any} */ x) => { if (x) exported.push(x); };
  push(await exportAndProbe("testsrc-mp4", "mp4", { density: 60, res: 540, fps: 12 }));
  push(await exportAndProbe("testsrc-webm", "webm", { density: 60, res: 540, fps: 12 }));
  push(await exportAndProbe("testsrc-gif", "gif", { density: 60, gifw: 480, fps: 10 }));

  // ---- with loop off, play after the end starts over instead of stopping at once
  const label = () => b.ev("document.getElementById('playLabel').textContent");
  if (await label() === "Pause") await click("playBtn");
  await click("loopBtn");
  await setValue("tEnd", 2, "change"); // end before the file's own end, so the browser does not restart it by itself
  await setValue("scrub", 1000);
  await sleep(300);
  await click("playBtn");
  await sleep(700);
  check("loop off: play at the end restarts the clip", await label() === "Pause", `${await label()} ${await b.ev("document.getElementById('timeVal').textContent")}`);
  await click("loopBtn");
  await setValue("tEnd", 3, "change");

  // ---- exporting while paused leaves the preview paused
  if (await b.ev("ASCII.stats.playing")) await click("playBtn");
  await sleep(300);
  check("preview paused before export", await b.ev("!ASCII.stats.playing"));
  push(await exportAndProbe("paused-mp4", "mp4", { density: 40, res: 540, fps: 12 }));
  check("export while paused leaves it paused", await b.ev("!ASCII.stats.playing"));
  await click("playBtn");

  // ---- cancel
  await setValue("fmt", "mp4", "change");
  await setValue("density", 100);
  const filesBefore = readdirSync(dl).length;
  await click("exportBtn");
  await sleep(700);
  await click("cancelBtn");
  check("cancel stops export", await waitFor("/cancel/.test(document.getElementById('exportInfo').textContent) && !document.getElementById('exportBtn').hidden", 30000));
  await sleep(800);
  check("cancel leaves no download", readdirSync(dl).length === filesBefore);

  // ---- video > 15 s is trimmed to 15 s
  await b.setFiles("#file", [longVideo]);
  check("20 s video: trim window capped to 15 s", await waitFor("!document.getElementById('videoBar').hidden && document.getElementById('tEnd').value === '15.0' && ASCII.stats.playing", 30000), await b.ev("document.getElementById('tEnd').value"));
  check("20 s video: the 15 s limit is explained next to the export estimate", /20\.0 s.*15 s/.test(await b.ev("document.getElementById('exportInfo').textContent")), await b.ev("document.getElementById('exportInfo').textContent"));
  await setValue("density", 30);
  push(await exportAndProbe("long-mp4", "mp4", { density: 30, res: 540, fps: 12 }));

  // ---- real video
  await b.setFiles("#file", [sample("clownfish-video.mp4")]);
  await waitFor("!document.getElementById('videoBar').hidden && ASCII.stats.playing", 30000);
  await setValue("density", 120);
  await sleep(4000);
  await b.screenshot(join(shots, "video-preview.png"));
  await scheme("light");
  await sleep(200);
  await b.screenshot(join(shots, "editor-video-light.png"));
  await scheme("dark");
  await sleep(200);
  await b.screenshot(join(shots, "editor-video-dark.png"));
  await b.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  check("menu button appears on a narrow window", await b.ev("getComputedStyle(document.getElementById('menuBtn')).display !== 'none'"));
  await click("menuBtn");
  await sleep(300);
  check("narrow sidebar is open after the menu click", await b.ev("document.body.classList.contains('sidebar-open')"));
  await b.screenshot(join(shots, "sidebar-narrow.png"));
  await click("closeSidebar");
  await b.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false });
  await scheme("light");
  await sleep(200);
  const prev = await b.ev("({stats: ASCII.stats, info: document.getElementById('prevInfo').textContent})");
  check("real video preview plays", prev.stats.playing, JSON.stringify(prev));
  await setValue("tEnd", 5, "change");
  push(await exportAndProbe("clownfish-mp4", "mp4", { density: 120, res: 1080, fps: 24 }));
  push(await exportAndProbe("clownfish-webm", "webm", { density: 120, res: 720, fps: 24 }));
  push(await exportAndProbe("clownfish-gif", "gif", { density: 90, gifw: 640, fps: 12 }));

  // worst case: a clip with one keyframe for the whole video (slow seeks)
  await b.setFiles("#file", [longGop]);
  await waitFor("!document.getElementById('videoBar').hidden && ASCII.stats.playing", 30000);
  push(await exportAndProbe("longgop-mp4", "mp4", { density: 120, res: 720, fps: 24 }));

  // ---- MediaRecorder fallback when WebCodecs is unavailable (last: it disables WebCodecs for the page)
  await b.ev("window.VideoEncoder = undefined");
  push(await exportAndProbe("recorder-webm", "webm", { density: 40, res: 540, fps: 12 }));

  check("no page errors", b.pageErrors.length === 0, b.pageErrors.join(" | "));
  writeFileSync(join(art, "e2e-report.json"), JSON.stringify({ exported, results }, null, 1));
  console.log("\nEXPORTS\n" + exported.map((e) => `${e.tag}: ${e.width}x${e.height} ${e.fps}fps ${e.frames} frames, ${e.sizeMB} MB, ${e.exportSeconds} s vs estimated ${e.estimatedSeconds} s (${e.codec}) per-frame ms: seek ${(e.timing.seekMs / e.frames).toFixed(0)}, pixels ${(e.timing.pixelsMs / e.frames).toFixed(0)}, paint ${(e.timing.paintMs / e.frames).toFixed(0)}, encode ${(e.timing.encodeMs / e.frames).toFixed(0)}`).join("\n"));
} catch (e) {
  check("e2e run completed", false, String(e && /** @type {Error} */ (e).stack || e));
} finally {
  await b.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
