// Minimal Chrome DevTools Protocol driver (no puppeteer): launches headless Chrome and exposes send/eval helpers.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {{port?: number, downloads: string, width?: number, height?: number}} opts */
export async function launch({ port = 9251, downloads, width = 1400, height = 1100 }) {
  const profile = mkdtempSync(join(tmpdir(), "ascii-chrome-"));
  const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--autoplay-policy=no-user-gesture-required", `--window-size=${width},${height}`, `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, "--remote-allow-origins=*", "about:blank"], { stdio: "ignore" });
  /** @type {any[]} */
  let tabs = [];
  for (let i = 0; i < 80 && !tabs.length; i++) {
    try { tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(150); }
  }
  const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  /** @type {Map<number, {res: (v: any) => void, rej: (e: Error) => void}>} */
  const pending = new Map();
  /** @type {string[]} */
  const pageErrors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = /** @type {NonNullable<ReturnType<typeof pending.get>>} */ (pending.get(m.id));
      pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result);
    } else if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  /** @param {string} method @param {object} [params] @returns {Promise<any>} */
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  return {
    send, pageErrors,
    /** @param {string} expression */
    async ev(expression) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
    /** @param {string} url */
    async goto(url) { await send("Page.navigate", { url }); await sleep(1200); },
    /** @param {string} file @param {Record<string, unknown>} [opts] */
    async screenshot(file, opts = {}) { writeFileSync(file, Buffer.from((await send("Page.captureScreenshot", { format: "png", ...opts })).data, "base64")); },
    /** @param {string} selector @param {string[]} files */
    async setFiles(selector, files) {
      const doc = await send("DOM.getDocument");
      const node = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
      await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files });
    },
    async close() {
      ws.close();
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
