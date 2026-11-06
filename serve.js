#!/usr/bin/env node
// Static server for the UI. Browsers refuse ES module imports over file://, so
// the page needs an origin — this is the smallest thing that provides one.
//
//   node serve.js        then open http://localhost:8000
//
// It serves the repository root so ui/app.js can import ../src/*.js unchanged.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: the repo lives under a directory with a
// space in its name, and pathname would hand back a percent-encoded "%20".
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 8000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);

  // Redirect rather than serve the page at "/": the document's own URL is what
  // its relative hrefs resolve against, so serving ui/index.html from the root
  // would look for style.css and app.js in the root too.
  if (path === "/" || path === "/ui" || path === "/ui/") {
    res.writeHead(302, { location: "/ui/index.html" }).end();
    return;
  }

  const target = join(ROOT, normalize(path));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`matchtool UI on http://localhost:${PORT}`));
