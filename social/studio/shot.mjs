// Photographing a live web page.
//
// A site whose product shots are drawn in CSS — which is most good landing
// pages — has no <img> worth downloading, so the page itself is the picture.
// Chrome is already on this machine and renders the live site, so this is still
// something fetched from the internet rather than something found on disk.
//
// Driven over the DevTools protocol rather than with `--screenshot`, for three
// reasons found the hard way: Chrome writes the file and then does not exit, so
// a plain spawn hangs the run forever; a first visit to any real site comes with
// a cookie or consent sheet across the picture, which has to be removed from the
// page before the shutter rather than cropped out afterwards; and `Page.navigate`
// succeeds on a 404 like any other response, so an invented path came back as a
// photograph of Chrome's error screen and went into a finished post.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CHROME_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const PRIVATE_HOST = /^(localhost$|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

// Anything fixed or sticky that reads as a consent sheet, a cookie bar or a
// newsletter pop-up. Matched on id, class and the first of its text.
const OVERLAY_JUNK = "cookie|consent|privacy|gdpr|cmp-|newsletter|subscribe|notification";

export async function chromeBinary() {
  for (const path of CHROME_BINARIES) {
    if (await fs.access(path).then(() => true, () => false)) return path;
  }
  return null;
}

const slug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "page";

export async function screenshotSite(url, { width = 1440, height = 900, scrollY = 0, outDir, profileDir } = {}) {
  const chrome = await chromeBinary();
  if (!chrome) throw new Error("No Chrome or Chromium on this machine, so a page cannot be photographed");
  const parsed = new URL(String(url).trim());
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("only http and https addresses can be photographed");
  if (PRIVATE_HOST.test(parsed.hostname)) throw new Error("that address is on this machine or the local network");

  const child = spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    `--user-data-dir=${profileDir || join(outDir || ".", ".shot-profile")}`,
    // Twice the pixels, so a 1440-wide page is still sharp filling a 1080-wide
    // composition.
    "--force-device-scale-factor=2",
    `--window-size=${Math.round(width)},${Math.round(height)}`,
    "about:blank",
  ]);

  try {
    // Chrome prints its debugger address on stderr and nowhere else.
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome did not start")), 20000);
      let buffer = "";
      child.stderr.on("data", (chunk) => {
        buffer += chunk.toString();
        const match = /ws:\/\/[^\s]+/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("Chrome exited before it was ready"));
      });
    });

    // That endpoint is the browser itself, which has no Page domain. The tab is
    // a separate target, and its own socket is what takes Page commands.
    const port = new URL(endpoint).port;
    let pageTarget = null;
    for (let attempt = 0; attempt < 40 && !pageTarget; attempt++) {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => []);
      pageTarget = (list || []).find((target) => target.type === "page");
      if (!pageTarget) await new Promise((r) => setTimeout(r, 200));
    }
    if (!pageTarget) throw new Error("Chrome opened no page to photograph");

    const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const waiters = new Map();
    // The status of the page itself, so a 404 is never photographed.
    let documentStatus = null;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
        return;
      }
      if (message.method === "Network.responseReceived" && message.params.type === "Document" && documentStatus === null) {
        documentStatus = message.params.response.status;
      }
      if (message.method && waiters.has(message.method)) {
        waiters.get(message.method)();
        waiters.delete(message.method);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const messageId = ++id;
        pending.set(messageId, { resolve, reject });
        socket.send(JSON.stringify({ id: messageId, method, params }));
      });
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));

    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error("could not talk to Chrome")));
    });

    await send("Page.enable");
    await send("Network.enable");

    // Chrome reports a 404 two ways depending on the site: as a status on the
    // document, and as net::ERR_HTTP_RESPONSE_CODE_FAILURE from navigate itself.
    // Both are the same fact, so both are read the same way.
    const go = async (target) => {
      documentStatus = null;
      const loaded = new Promise((resolve) => waiters.set("Page.loadEventFired", resolve));
      const result = await send("Page.navigate", { url: target });
      await Promise.race([loaded, settle(result.errorText ? 1200 : 15000)]);
      await settle(result.errorText ? 200 : 1400);
      return { status: documentStatus, errorText: result.errorText || null };
    };
    const failed = (outcome) => Boolean(outcome.errorText) || (outcome.status !== null && outcome.status >= 400);
    const why = (outcome) => outcome.errorText || `HTTP ${outcome.status}`;

    let shotUrl = parsed.toString();
    let outcome = await go(shotUrl);
    if (failed(outcome)) {
      // The producer guesses page paths — /compare, /features — and a guess that
      // misses is a picture of Chrome's 404, which is worse than no picture at
      // all. The front page always exists, so take that instead and say so.
      const root = parsed.origin + "/";
      if (shotUrl === root) throw new Error(`${shotUrl} answered ${why(outcome)} — there is no page there to photograph`);
      const rootOutcome = await go(root);
      if (failed(rootOutcome)) {
        throw new Error(`${parsed.hostname} answered ${why(outcome)} for that page and ${why(rootOutcome)} for its home page`);
      }
      shotUrl = root;
      outcome = rootOutcome;
    }
    const status = outcome.status;

    if (scrollY) {
      await send("Runtime.evaluate", { expression: `window.scrollTo(0, ${Math.round(scrollY)})` });
      await settle(600);
    }

    const removed = await send("Runtime.evaluate", {
      expression: `(() => {
        const junk = /${OVERLAY_JUNK}/i;
        let removed = 0;
        for (const el of document.querySelectorAll("body *")) {
          const style = getComputedStyle(el);
          if (style.position !== "fixed" && style.position !== "sticky") continue;
          const box = el.getBoundingClientRect();
          if (box.width < 60 || box.height < 30) continue;
          const label = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
          if (!junk.test(label) && !junk.test((el.innerText || "").slice(0, 300))) continue;
          el.style.setProperty("display", "none", "important");
          removed++;
        }
        return removed;
      })()`,
      returnByValue: true,
    });
    await settle(250);

    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const buffer = Buffer.from(shot.data, "base64");
    if (buffer.length < 1024) throw new Error(`${parsed.hostname} did not render into a picture`);

    const dir = outDir || ".";
    await fs.mkdir(dir, { recursive: true });
    const file = join(
      dir,
      `shot-${slug(parsed.hostname + parsed.pathname)}-${createHash("sha1").update(`${shotUrl}:${width}x${height}:${scrollY}`).digest("hex").slice(0, 6)}.png`,
    );
    await fs.writeFile(file, buffer);
    socket.close();
    return { file, stat: await fs.stat(file), shotUrl, status, overlaysRemoved: removed.result?.value ?? 0 };
  } finally {
    // Chrome writes the picture and then stays up, so it is always killed here
    // rather than waited on.
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}
