// Build the actwhy web playground into web/dist/ — fully self-contained,
// zero external requests. Bundles web/src/main.ts to web/dist/app.js and copies
// the static assets (index.html, robots.txt, sitemap.xml, og.svg) alongside it.
//
// Run via: npm run build:web
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdirSync, copyFileSync, statSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

// Absolute shim paths so the build works regardless of the invoking cwd.
// `yaml` (via @actions/workflow-parser) does top-level `require('process')` and
// `require('buffer')`; in a browser bundle esbuild turns those into throwing
// stubs. Aliasing them to tiny shims keeps the parser 100% client-side safe.
const shim = (name) => resolve(here, "shims", name);

const result = await build({
  entryPoints: [join(here, "src", "main.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  sourcemap: false,
  // Keep dependency license notices in the shipped bundle (MIT requires it).
  legalComments: "eof",
  outfile: join(dist, "app.js"),
  alias: {
    process: shim("process.js"),
    buffer: shim("buffer.js"),
  },
  logLevel: "warning",
  metafile: true,
});

// Copy static assets into dist. og.png is intentionally optional (see README).
const assets = ["index.html", "robots.txt", "sitemap.xml", "og.svg", "og.png"];
for (const name of assets) {
  const src = join(here, name);
  if (existsSync(src)) copyFileSync(src, join(dist, name));
}

const kb = (bytes) => (bytes / 1024).toFixed(1) + " KB";
const appBytes = statSync(join(dist, "app.js")).size;
const total = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`built web/dist/app.js  (${kb(appBytes)}, total out ${kb(total)})`);
console.log(`copied: ${assets.filter((a) => existsSync(join(dist, a))).join(", ")}`);
