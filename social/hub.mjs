#!/usr/bin/env node
// Static server for the local hub.
//
//   node social/hub.mjs        # binds 127.0.0.1:8787, serves the repo root
//
// This exists for one reason: `python3 -m http.server` sends no Cache-Control,
// so the browser applies heuristic freshness to the studio's ES modules. Adding
// a query to the page URL reloads the HTML but not the modules it imports, so a
// changed studio/timeline.js could keep serving from cache while the file on
// disk was already right — an edit that looked like it had done nothing.
//
// Nothing here is deployed; the site is built by scripts/build-pages.sh.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, normalize, sep } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.HUB_PORT || 8787);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let target = resolve(ROOT, "." + normalize(decodeURIComponent(url.pathname)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  let stat = await fs.stat(target).catch(() => null);
  if (stat && stat.isDirectory()) {
    target = join(target, "index.html");
    stat = await fs.stat(target).catch(() => null);
  }
  if (!stat) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }

  const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
  const headers = { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes" };
  // Never cache anything: this is a workbench that is edited while it is open,
  // and a stale module is indistinguishable from a change that did not work.
  headers["cache-control"] = "no-store, must-revalidate";

  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${stat.size}` });
    createReadStream(target, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(target).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Mac Kit hub → http://127.0.0.1:${PORT}/social/studio.html`);
  console.log(`  serving ${ROOT} with caching off`);
});
