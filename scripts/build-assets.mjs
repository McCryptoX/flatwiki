/**
 * Minifiziert alle JS- und CSS-Dateien in public/ in-place.
 * Wird als Teil des Produktions-Builds ausgeführt (npm run build).
 * theme-init.js und theme.css werden ebenfalls minifiziert, da render.ts
 * sie beim Start vom Dateisystem liest und den Hash live berechnet.
 */

import { build } from "esbuild";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const PUBLIC = "public";

async function collectFiles(dir, ext) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(full, ext)));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

async function minifyJS(files) {
  for (const file of files) {
    await build({
      entryPoints: [file],
      outfile: file,
      minify: true,
      allowOverwrite: true,
      logLevel: "silent",
    });
  }
}

async function minifyCSS(files) {
  for (const file of files) {
    await build({
      entryPoints: [file],
      outfile: file,
      minify: true,
      allowOverwrite: true,
      bundle: false,
      loader: { ".css": "css" },
      logLevel: "silent",
    });
  }
}

const jsFiles = await collectFiles(PUBLIC, ".js");
const cssFiles = await collectFiles(PUBLIC, ".css");

const before = await Promise.all(
  [...jsFiles, ...cssFiles].map(async (f) => (await stat(f)).size)
);

await minifyJS(jsFiles);
await minifyCSS(cssFiles);

const after = await Promise.all(
  [...jsFiles, ...cssFiles].map(async (f) => (await stat(f)).size)
);

const totalBefore = before.reduce((a, b) => a + b, 0);
const totalAfter = after.reduce((a, b) => a + b, 0);
const saved = totalBefore - totalAfter;
const pct = ((saved / totalBefore) * 100).toFixed(1);

console.log(
  `Assets minifiziert: ${(totalBefore / 1024).toFixed(1)} KB → ${(totalAfter / 1024).toFixed(1)} KB (${pct}% gespart, ${(saved / 1024).toFixed(1)} KB)`
);
