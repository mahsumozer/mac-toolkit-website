// Finding TikToks by phrase, which TikTok itself will not allow.
//
// Every direct road is closed: yt-dlp's TikTok search and tag extractors are
// broken, TikTok's own search page answers a headless browser with a slider
// puzzle, and Bing hands an automated session a page of decoy results with the
// query quietly ignored. What does work is DuckDuckGo, in a real Chrome, asked
// for `site:tiktok.com <phrase>` — it returns the video and profile addresses
// its index holds for that phrase, and yt-dlp can read any one of those.
//
// So this drives Chrome over the DevTools protocol the way shot.mjs does,
// reads the result list off the page, and hands back two lists: videos, which
// are read directly, and profiles, which are read the way a typed account is.
// Nothing here downloads anything; it is a directory lookup.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { join } from "node:path";
import { chromeBinary } from "./shot.mjs";

// A desktop Chrome, said out loud. Headless Chrome's own string is what gets
// DuckDuckGo to answer with a challenge instead of a page.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const VIDEO = /^https?:\/\/(?:www\.)?tiktok\.com\/@([\w.\-]+)\/video\/(\d+)/;
const PROFILE = /^https?:\/\/(?:www\.)?tiktok\.com\/@([\w.\-]+)\/?(?:\?.*)?$/;

/**
 * Video addresses and creator handles DuckDuckGo holds for a phrase on TikTok.
 *
 * `profileDir` keeps Chrome's cookies between calls, so the second query in a
 * hunt is not a first visit. Returns empty lists rather than throwing when the
 * page comes back without results — a phrase nobody has posted about is not
 * an error.
 */
export async function searchTikTok(query, { profileDir, limit = 20, timeoutMs = 25000 } = {}) {
  const chrome = await chromeBinary();
  if (!chrome) throw new Error("No Chrome or Chromium on this machine, so TikTok cannot be searched");
  await fs.mkdir(profileDir, { recursive: true });

  const child = spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--lang=en-US",
    `--user-data-dir=${profileDir}`,
    "--window-size=1280,900",
    "about:blank",
  ]);

  try {
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
    });

    // The address Chrome prints is the browser; the tab is a separate target.
    const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome opened no tab");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", () => reject(new Error("could not reach Chrome's tab")));
    });

    let seq = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.setUserAgentOverride", { userAgent: USER_AGENT });
    await send("Page.navigate", {
      url: `https://duckduckgo.com/?q=${encodeURIComponent(`site:tiktok.com ${query}`)}&ia=web&kl=us-en`,
    });

    // Results render after the page's own script runs; poll rather than wait a
    // fixed time, and stop early once the list has filled.
    const started = Date.now();
    let hrefs = [];
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1200));
      hrefs = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('article h2 a')].map((a) => a.href))`));
      if (hrefs.length >= Math.min(limit, 10)) break;
    }
    // One more page when the first was full — DuckDuckGo appends rather than
    // paginates, and the button is only there when there is more.
    if (hrefs.length >= 10 && limit > 10) {
      try {
        await evaluate(`(() => { const b = document.querySelector('#more-results'); if (b) b.click(); return !!b; })()`);
        await new Promise((r) => setTimeout(r, 2500));
        hrefs = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('article h2 a')].map((a) => a.href))`));
      } catch {}
    }
    ws.close();

    const videos = [];
    const profiles = [];
    for (const href of hrefs.slice(0, limit)) {
      const video = VIDEO.exec(href);
      if (video) {
        const url = `https://www.tiktok.com/@${video[1]}/video/${video[2]}`;
        if (!videos.includes(url)) videos.push(url);
        continue;
      }
      const profile = PROFILE.exec(href);
      if (profile && !profiles.includes(profile[1])) profiles.push(profile[1]);
    }
    return { videos, profiles };
  } finally {
    child.kill();
  }
}

export const tikTokProfileDir = (tmpDir) => join(tmpDir, "tiksearch-profile");
