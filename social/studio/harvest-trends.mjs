#!/usr/bin/env node
// Builds studio/trends.json — what short-form is actually rewarding right now,
// reduced to the only thing a post can borrow: its shape.
//
// Usage:
//   node social/studio/harvest-trends.mjs              # both sources, merge into trends.json
//   node social/studio/harvest-trends.mjs --only reddit
//   node social/studio/harvest-trends.mjs --dry        # print the table, write nothing
//   node social/studio/harvest-trends.mjs --list       # what is in trends.json today
//
// The rule this file exists to enforce: a trend contributes a *structure* —
// hook pattern, format, beat count — and never a claim. Claims still come only
// from `features` in formats.json. That is also what keeps the copyright story
// simple: nothing is downloaded, nothing is re-published; a record is a title,
// a number and a link back to whoever made it.
//
// Two sources, because they answer different questions:
//
//   youtube — what phrasing earns a view. yt-dlp needs no key and is already a
//             dependency of the studio server. Ranked by velocity (views per
//             day), never raw views: a video that took three years to reach a
//             million is not a trend, one that took three days is.
//   reddit  — what the audience complains about, in their own words. The JSON
//             API answers 403 without an OAuth app, but the Atom feed at
//             /r/<sub>/top/.rss is public, and because it is the *top* feed the
//             ordering is already Reddit's own ranking, so position is the
//             score.

import { spawn } from "node:child_process";
import { shapeOf } from "./trends.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TRENDS = join(HERE, "trends.json");

// Searches that surface hooks aimed at the person who would buy Mac Kit.
const YOUTUBE_QUERIES = [
  "mac tips and tricks",
  "macos hidden features",
  "menu bar apps mac",
  "mac productivity apps",
  "macos shortcuts you should know",
  "best mac apps",
];

// r/apple is deliberately absent: its top-of-week is Apple corporate news —
// executive memos, component pricing — which is not a thing a Mac Kit post
// could ever be about.
const SUBREDDITS = ["macapps", "MacOS", "productivity"];

const SEARCH_WIDTH = 25;   // candidates yt-dlp returns per query
const PER_QUERY = 8;       // how many of those are worth a full metadata fetch
const REDDIT_LIMIT = 25;
const REDDIT_GAP = 12000;  // ms between feeds — anything quicker earns a 429
const KEEP_DAYS = 30;      // an unseen record older than this is dropped

// r/macapps is mostly developers announcing releases. Those are not what the
// audience complains about, so they are dropped before anything is stored.
const LAUNCH_NOISE =
  /^\[(?:os|free|paid|update|dev)\]|\b(?:just (?:got|hit|released|updated|launched)|v\d|version \d|is (?:now )?(?:free|out|live)|i (?:built|made|spent|created)|release[ds]?\b|update\b)/i;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-10000);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-800)}`))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jsonLines = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const daysSince = (iso) => Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));

// Runs `worker` over `items` a few at a time. yt-dlp spends its time waiting on
// YouTube, so a little concurrency turns a two-minute harvest into a thirty-
// second one; more than a handful and YouTube starts rate limiting.
async function pool(items, size, worker) {
  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          results.push(await worker(items[index]));
        } catch (error) {
          console.error(`  fail: ${String(error.message).split("\n")[0]}`);
        }
      }
    }),
  );
  return results.flat();
}

/* ------------------------------------------------------------------ youtube */

// Two passes on purpose. The flat search is one request for twenty-five
// results but carries no upload date, and without a date there is no velocity.
// The full dump has the date but costs a request per video, so only the best
// few candidates from each search are worth it.
async function harvestYouTube() {
  const seen = new Set();

  const shortlists = await pool(YOUTUBE_QUERIES, 3, async (query) => {
    const found = jsonLines(await run("yt-dlp", ["--flat-playlist", "--dump-json", "--no-warnings", `ytsearch${SEARCH_WIDTH}:${query}`]))
      .filter((entry) => entry.id && entry.view_count && entry.live_status !== "is_live")
      .sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
    console.log(`  search  ${query} — ${found.length} candidates`);
    return [{ query, ids: found.map((e) => e.id) }];
  });

  const batches = [];
  for (const { query, ids } of shortlists) {
    const fresh = ids.filter((id) => !seen.has(id)).slice(0, PER_QUERY);
    fresh.forEach((id) => seen.add(id));
    if (fresh.length) batches.push({ query, ids: fresh });
  }

  return pool(batches, 3, async ({ query, ids }) => {
    const urls = ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
    const detailed = jsonLines(await run("yt-dlp", ["--dump-json", "--no-warnings", "--skip-download", ...urls]));
    console.log(`  detail  ${query} — ${detailed.length} fetched`);
    return detailed.map((video) => {
      // upload_date arrives as YYYYMMDD.
      const raw = String(video.upload_date || "");
      const published = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : new Date().toISOString().slice(0, 10);
      const age = daysSince(published);
      return {
        id: `yt:${video.id}`,
        source: "youtube",
        kind: "hook",
        title: (video.title || "").trim(),
        url: `https://www.youtube.com/watch?v=${video.id}`,
        author: video.channel || video.uploader || "",
        views: video.view_count || 0,
        duration: video.duration || 0,
        isShort: (video.duration || 0) <= 90,
        publishedAt: published,
        ageDays: age,
        velocity: Math.round((video.view_count || 0) / age),
        query,
      };
    });
  });
}

/* ------------------------------------------------------------------- reddit */

const UNESCAPE = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'" };
const unescapeXml = (text) =>
  text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code) => {
    if (UNESCAPE[code]) return UNESCAPE[code];
    if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return whole;
  });

// Atom, parsed with regex rather than a dependency: the feed is machine-written
// and every field wanted here sits on one line inside <entry>.
function parseAtom(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
    const field = (tag) => {
      const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry);
      return match ? unescapeXml(match[1].trim()) : "";
    };
    const link = /<link[^>]*href="([^"]+)"/.exec(entry);
    return {
      title: field("title"),
      url: link ? unescapeXml(link[1]) : "",
      author: field("name"),
      updated: field("updated") || field("published"),
      id: field("id"),
    };
  });
}

// One 429 is not a refusal, it is a request to slow down. Reddit hands them out
// freely to anything without an OAuth app, so a feed that trips the limit backs
// off twice, for longer each time, before it is given up on.
const BACKOFF = [15000, 30000];

async function fetchFeed(url, attempt = 0) {
  const res = await fetch(url, { headers: { "user-agent": "mac-kit-studio/1.0 (trend harvest)" } });
  if (res.status === 429 && attempt < BACKOFF.length) {
    console.log(`    429 — backing off ${BACKOFF[attempt] / 1000}s`);
    await sleep(BACKOFF[attempt]);
    return fetchFeed(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function harvestReddit() {
  const items = [];
  for (const [feedIndex, sub] of SUBREDDITS.entries()) {
    if (feedIndex) await sleep(REDDIT_GAP);
    const url = `https://www.reddit.com/r/${sub}/top/.rss?t=week&limit=${REDDIT_LIMIT}`;
    try {
      const entries = parseAtom(await fetchFeed(url)).filter((entry) => !LAUNCH_NOISE.test(entry.title));
      console.log(`  r/${sub} — ${entries.length} posts after dropping launch announcements`);
      entries.forEach((entry, index) => {
        const published = (entry.updated || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
        items.push({
          id: `rd:${(entry.id || entry.url).split("/").filter(Boolean).pop()}`,
          source: "reddit",
          kind: "topic",
          title: entry.title,
          url: entry.url,
          author: `r/${sub}`,
          views: null,
          publishedAt: published,
          ageDays: daysSince(published),
          // The feed is already Reddit's top-of-week ordering, so position is
          // the ranking. Stored as a descending number so higher is better in
          // the same direction as velocity.
          rank: index + 1,
          velocity: REDDIT_LIMIT - index,
          query: `r/${sub} top/week`,
        });
      });
    } catch (error) {
      console.error(`  fail r/${sub}: ${error.message}`);
    }
  }
  return items;
}

/* -------------------------------------------------------------------- shape */

/* --------------------------------------------------------------------- main */

function readTrends() {
  if (!existsSync(TRENDS)) return { items: [] };
  try {
    return JSON.parse(readFileSync(TRENDS, "utf8"));
  } catch {
    return { items: [] };
  }
}

// Velocity is not comparable between a view count and a feed position, so each
// source is normalised inside itself and `score` is what the picker sorts on.
function scoreWithinSource(items) {
  for (const source of new Set(items.map((i) => i.source))) {
    const group = items.filter((i) => i.source === source).sort((a, b) => b.velocity - a.velocity);
    group.forEach((item, index) => {
      item.score = Number(((group.length - index) / group.length).toFixed(3));
    });
  }
  return items;
}

function table(items, limit = 20) {
  for (const item of items.slice(0, limit)) {
    const metric = item.source === "youtube" ? `${item.velocity.toLocaleString()}/day` : `#${item.rank}`;
    console.log(
      `${String(item.score).padEnd(6)} ${item.kind.padEnd(6)} ${(item.shape.format || "—").padEnd(17)} ${metric.padStart(11)}  ${item.shape.hook.slice(0, 56)}`,
    );
  }
}

async function main() {
  if (has("--list")) {
    const current = readTrends();
    if (!current.items?.length) return console.log("trends.json is empty — run the harvest.");
    console.log(`${current.items.length} records, harvested ${current.harvestedAt}\n`);
    return table(current.items, Number(value("--limit")) || 30);
  }

  const only = value("--only");
  console.log("harvesting…");
  const fresh = [
    ...(only === "reddit" ? [] : await harvestYouTube()),
    ...(only === "youtube" ? [] : await harvestReddit()),
  ].filter((item) => item.title);

  const harvestedAt = new Date().toISOString();
  for (const item of fresh) {
    item.shape = shapeOf(item);
    item.harvestedAt = harvestedAt;
  }

  // Merge: a record seen again is refreshed in place, one not seen survives
  // until it is KEEP_DAYS old. That way a single failed source does not wipe
  // the corpus, and the file grows into a history rather than a snapshot.
  const previous = readTrends().items || [];
  const byId = new Map(previous.map((item) => [item.id, item]));
  for (const item of fresh) byId.set(item.id, { ...byId.get(item.id), ...item });

  // Surviving a run is not the same as still belonging in the corpus: dropping a
  // subreddit from SUBREDDITS has to drop its records too, or the file keeps
  // serving posts from a source that was removed on purpose.
  const configured = new Set(SUBREDDITS.map((sub) => `r/${sub}`));
  const items = scoreWithinSource(
    [...byId.values()]
      .filter((item) => daysSince(item.harvestedAt) <= KEEP_DAYS)
      .filter((item) => item.source !== "reddit" || configured.has(item.author)),
  ).sort((a, b) => b.score - a.score);

  const hooks = items.filter((i) => i.kind === "hook");
  const topics = items.filter((i) => i.kind === "topic");
  const classified = hooks.filter((i) => i.shape?.format).length;
  console.log(
    `\n${fresh.length} fetched. Corpus: ${hooks.length} hooks (${classified} carry a format), ${topics.length} topics.\n`,
  );
  table(items);

  if (has("--dry")) return console.log("\n--dry — trends.json untouched.");

  mkdirSync(HERE, { recursive: true });
  writeFileSync(
    TRENDS,
    `${JSON.stringify(
      {
        note: "Harvested by studio/harvest-trends.mjs. A record contributes structure only — hook pattern, format, beat count. Claims still come from `features` in formats.json; nothing here is a fact about Mac Kit. `shape.format` ids match formats.json, and `score` is normalised inside each source so youtube and reddit can be ranked together.",
        harvestedAt,
        sources: [
          { name: "youtube", via: "yt-dlp search, ranked by views per day", queries: YOUTUBE_QUERIES },
          { name: "reddit", via: "public top/week Atom feed, ranked by feed position", subreddits: SUBREDDITS },
        ],
        items,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${TRENDS.replace(/.*\/social\//, "social/")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
