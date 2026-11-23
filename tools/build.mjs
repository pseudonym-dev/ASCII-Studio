// Bundles web/src into one self-contained web/ascii-studio.html (worker inlined as a blob source, no network).
import { build } from "esbuild";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";

const root = new URL("../web/", import.meta.url);
const samples = new URL("../samples/", import.meta.url);
const bundle = async (/** @type {string} */ entry, /** @type {Record<string, string>} */ define = {}) => {
  const out = await build({
    entryPoints: [new URL(entry, root).pathname], bundle: true, write: false, format: "iife", target: "es2022",
    minify: true, legalComments: "none", define,
  });
  return out.outputFiles[0].text;
};

const dataUrl = async (/** @type {URL} */ file, /** @type {string} */ mime) =>
  `data:${mime};base64,${(await readFile(file)).toString("base64")}`;

const exampleMeta = [
  {
    id: "toucan",
    title: "Toco toucan",
    credit: "Eaktas06, Pixabay License",
    href: "https://pixabay.com/videos/tucano-p%C3%A1ssaro-%C3%A1rvore-verde-171255/",
    filename: "example-toucan.mp4",
  },
  {
    id: "macaw",
    title: "Scarlet macaw",
    credit: "ahrordzon, Pixabay License",
    href: "https://pixabay.com/videos/red-parrot-talking-parrot-114146/",
    filename: "example-macaw.mp4",
  },
  {
    id: "chameleon",
    title: "Chameleon",
    credit: "xBriantcx, Pixabay License",
    href: "https://pixabay.com/videos/chameleon-reptile-animal-green-233037/",
    filename: "example-chameleon.mp4",
  },
];

const pageBudget = 3 * 1048576;
const exampleSources = exampleMeta.map((e) => {
  const sourceFile = new URL(e.filename, samples);
  return { file: sourceFile, bytes: statSync(sourceFile).size };
});
const includeSources = true; // set false below if the page would exceed 3 MB
const buildExamples = async (/** @type {boolean} */ withSources) => Promise.all(exampleMeta.map(async (e, i) => ({
  title: e.title,
  credit: e.credit,
  href: e.href,
  filename: e.filename,
  clip: (await readFile(new URL(`assets/examples/${e.id}.bin.gz`, root))).toString("base64"),
  source: withSources ? await dataUrl(exampleSources[i].file, "video/mp4") : null,
  sourceBytes: withSources ? exampleSources[i].bytes : 0,
})));
let examples = await buildExamples(includeSources);

const worker = await bundle("src/worker.js");
const demo = (await readFile(new URL("assets/demo.jpg", root))).toString("base64");
const iconDir = new URL("assets/icons/", root);
const symbols = await Promise.all((await readdir(iconDir)).filter((f) => f.endsWith(".svg")).map(async (f) => {
  const svg = await readFile(new URL(f, iconDir), "utf8");
  return `<symbol id="i-${f.slice(0, -4)}" viewBox="0 0 24 24">${svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>")).trim()}</symbol>`;
}));
const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${symbols.join("")}</svg>`;
const assemble = async (/** @type {typeof examples} */ clips) => {
  const app = await bundle("src/app.js", {
    __WORKER_SOURCE__: JSON.stringify(worker),
    __DEMO_URL__: JSON.stringify(`data:image/jpeg;base64,${demo}`),
    __EXAMPLES__: JSON.stringify(clips),
  });
  return (await readFile(new URL("template.html", root), "utf8"))
    .replace("<!--__ICONS__-->", () => sprite)
    .replace("/*__APP__*/", () => app.replaceAll("</script", "<\\/script"));
};
let html = await assemble(examples);
if (html.length > pageBudget && examples.some((e) => e.source)) {
  examples = await buildExamples(false);
  html = await assemble(examples);
  console.log("example source videos omitted so the page stays under 3 MB");
}
const out = new URL("ascii-studio.html", root);
await writeFile(out, html);
const mb = html.length / 1048576;
console.log(`ascii-studio.html ${(html.length / 1024).toFixed(0)} KB (${mb.toFixed(2)} MB)`);
if (html.length > pageBudget) {
  throw new Error(`ascii-studio.html is ${mb.toFixed(2)} MB; keep the single file under 3 MB.`);
}
