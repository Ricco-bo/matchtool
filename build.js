#!/usr/bin/env node
// Bundle the app into one self-contained HTML file.
//
//   node build.js   ->   dist/matchtool.html
//
// The result has no external references at all, so it runs from a double-click
// over file:// with no server, and the on-prem version of this tool is simply
// this file. That is only possible because there are no dependencies: the
// modules are plain ES modules and deflate comes from the platform.
//
// The "bundler" is deliberately a hundred lines rather than a toolchain: resolve
// the import graph, strip the import/export keywords, concatenate in dependency
// order. Valid because every module here uses distinct top-level names.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Script } from "node:vm";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const IMPORT_RE = /^import\s+[\s\S]*?\sfrom\s+["']([^"']+)["'];?[ \t]*$/gm;

const seen = new Set();
const order = [];

/** Depth-first over the import graph, so a module is emitted after its imports. */
function collect(file) {
  const path = resolve(file);
  if (seen.has(path)) return;
  seen.add(path);

  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec.startsWith(".")) {
      throw new Error(`${relative(ROOT, path)} imports "${spec}" — bundling only handles relative paths`);
    }
    collect(resolve(dirname(path), spec));
  }
  order.push({ path, source });
}

function strip(source) {
  return source
    .replace(IMPORT_RE, "")
    .replace(/^export\s+(?=(const|let|var|function|async|class)\b)/gm, "")
    .trimStart();
}

collect(resolve(ROOT, "ui/app.js"));

const modules = order
  .map(({ path, source }) => `\n// ---- ${relative(ROOT, path)} ----\n${strip(source)}`)
  .join("\n");

/** Replace a <link rel=stylesheet> with the file's contents. */
function inlineCss(html, href) {
  const css = readFileSync(resolve(ROOT, "ui", href), "utf8");
  const tag = new RegExp(`<link rel="stylesheet" href="${href.replace(".", "\\.")}">`);
  if (!tag.test(html)) throw new Error(`no <link> for ${href} to inline`);
  // Function replacer, never a string: in a string replacement "$$" means a
  // literal "$", "$&" means the match, and so on — which silently rewrites the
  // file being inlined.
  return html.replace(tag, () => `<style>\n${css}\n</style>`);
}

function assertSelfContained(html, name) {
  for (const marker of ['<link rel="stylesheet"', '<script type="module" src=']) {
    if (html.includes(marker)) throw new Error(`${name}: failed to inline, ${marker} still present`);
  }
}

mkdirSync(resolve(ROOT, "dist"), { recursive: true });
const written = [];

// --- the app ---------------------------------------------------------------
let app = inlineCss(readFileSync(resolve(ROOT, "ui/index.html"), "utf8"), "style.css");
// Compile (without running) before shipping. This is what catches a bundler
// mistake that produces valid-looking but unparseable output — a duplicate
// top-level declaration, say — instead of letting it reach the browser.
try {
  new Script(`(async () => {\n${modules}\n})()`, { filename: "bundle.js" });
} catch (err) {
  throw new Error(`the bundled script does not parse: ${err.message}`);
}

app = app.replace(
  /<script type="module" src="app\.js"><\/script>/,
  // Guard the closing tag: a literal </script> anywhere in the source would end
  // the block early. And a function replacer, so "$$" and "$&" in the code are
  // not interpreted as replacement patterns.
  () => `<script type="module">\n${modules.replace(/<\/script>/gi, () => "<\\/script>")}\n</script>`,
);
assertSelfContained(app, "matchtool.html");
writeFileSync(resolve(ROOT, "dist/matchtool.html"), app);
written.push(["dist/matchtool.html", app, `${order.length} modules inlined`]);

// --- the landing page ------------------------------------------------------
// Emitted as index.html so the deploy is "upload dist/", nothing else.
let landing = readFileSync(resolve(ROOT, "ui/landing.html"), "utf8");
landing = inlineCss(landing, "style.css");
landing = inlineCss(landing, "landing.css");
assertSelfContained(landing, "index.html");
writeFileSync(resolve(ROOT, "dist/index.html"), landing);
written.push(["dist/index.html", landing, "landing page"]);

for (const [name, html, note] of written) {
  console.log(`${name.padEnd(22)} ${(Buffer.byteLength(html) / 1024).toFixed(0).padStart(3)} KB  (${note})`);
}
