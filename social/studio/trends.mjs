// What short-form is rewarding right now, reduced to the only thing a post can
// borrow: its shape.
//
// The rule this file exists to enforce: a trend contributes a *structure* — a
// hook pattern, a format, a beat count — and never a claim. Claims come from the
// product's own fact sheet. That is also what keeps the copyright story simple:
// a record is a title, a number and a link back to whoever made it.
//
// Two callers, one classifier. `harvest-trends.mjs` builds the standing
// trends.json for Mac Kit's own studio from a fixed set of queries; Autopilot
// calls `trendingNow` per run with queries derived from whatever product it was
// pointed at, because a trend in one niche says nothing about another.

import fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

// The classifier. Every id it can return already exists in formats.json, so a
// trend never introduces a format the studio cannot render.
export const RULES = [
  // A count at the front is the strongest signal there is, so it is tested
  // before anything else can claim the title.
  { format: "listicle", test: /^(?:the\s+)?(?:top\s+)?(\d{1,2})\b/i, beats: (m) => Number(m[1]) },
  { format: "pov", test: /^\s*pov\b|^\s*when you\b|^\s*me when\b/i },
  // "Bought a Mac? FIRST 10 THINGS TO DO" is a countdown too — the number just
  // is not at the start. Only counts attached to a list noun qualify, so a
  // model number like "M4 MacBook" cannot masquerade as a beat count.
  {
    format: "listicle",
    test: /\b(\d{1,2})\s+(?:things|apps|tips|tricks|settings|features|shortcuts|reasons|ways|hacks|mistakes)\b/i,
    beats: (m) => Number(m[1]),
  },
  { format: "before-after", test: /\b(?:before and after|before vs|vs\.?\s|instead of|used to)\b/i },
  { format: "hot-take", test: /\b(?:nobody|no one|everyone|unpopular|hot take|actually|the truth about|is missing|why .* (?:is|are) (?:bad|wrong|useless))\b/i },
  { format: "problem-solution", test: /\b(?:stop|don'?t|quit|never|delete|uninstall|fix|how to|switching|you (?:should|need to))\b/i },
];

// The pattern, not the sentence: digits become {n} so "7 mac tips" and
// "12 mac tips" collapse to one reusable skeleton, and the trailing noise that
// belongs to someone else's channel is cut.
export function hookPattern(title) {
  return String(title || "")
    .replace(/[|#].*$/, "")
    .replace(/\s*[\p{Extended_Pictographic}☀-➿]+\s*/gu, " ")
    .replace(/\b\d{1,3}\b/g, "{n}")
    .replace(/\s{2,}/g, " ")
    .replace(/[!.?\s]+$/, "")
    .trim();
}

// Only the hook corpus is classified. A Reddit record is a topic — what the
// audience is arguing about this week — and forcing a post format onto it would
// invent a structure nobody actually posted.
export function shapeOf(item) {
  if (item.kind !== "hook") return { format: null, hook: hookPattern(item.title), beats: null };
  for (const rule of RULES) {
    const match = rule.test.exec(item.title);
    if (!match) continue;
    return { format: rule.format, hook: hookPattern(item.title), beats: rule.beats ? rule.beats(match) : null };
  }
  return { format: null, hook: hookPattern(item.title), beats: null };
}

// Shared with blitz.mjs, which reads the same yt-dlp output a line at a time.
export const jsonLines = (text) =>
  String(text || "")
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

/**
 * What is moving in one niche, right now.
 *
 * Ranked by velocity — views per day — rather than raw views, because a video
 * that took three years to reach a million is not a trend and one that took
 * three days is. `run` is the caller's process runner (the server already has
 * one); `cacheDir` keeps a run from re-searching what it searched an hour ago,
 * since each query costs two yt-dlp passes.
 */
export async function trendingNow({ queries, run, cacheDir, perQuery = 5, ttlHours = 12 }) {
  const wanted = (queries || []).map((q) => String(q).trim()).filter(Boolean).slice(0, 5);
  if (!wanted.length) return [];

  const key = createHash("sha1").update(wanted.join("|")).digest("hex").slice(0, 16);
  const cacheFile = cacheDir ? join(cacheDir, `${key}.json`) : null;
  if (cacheFile) {
    const cached = await fs.readFile(cacheFile, "utf8").then(JSON.parse, () => null);
    if (cached && Date.now() - cached.at < ttlHours * 3600 * 1000) return cached.items;
  }

  const seen = new Set();
  const items = [];
  for (const query of wanted) {
    let shortlist = [];
    try {
      // The flat search is one cheap pass and carries view counts, but not the
      // upload date — so the top few get a second, detailed pass, which is the
      // only place velocity can come from.
      shortlist = jsonLines(await run("yt-dlp", ["--flat-playlist", "--dump-json", "--no-warnings", `ytsearch25:${query}`]))
        .filter((entry) => entry.id && entry.view_count && entry.live_status !== "is_live")
        .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
        .filter((entry) => !seen.has(entry.id))
        .slice(0, perQuery);
    } catch {
      continue;
    }
    if (!shortlist.length) continue;
    shortlist.forEach((entry) => seen.add(entry.id));

    let detailed = [];
    try {
      detailed = jsonLines(
        await run("yt-dlp", [
          "--dump-json",
          "--no-warnings",
          "--skip-download",
          ...shortlist.map((entry) => `https://www.youtube.com/watch?v=${entry.id}`),
        ]),
      );
    } catch {
      continue;
    }

    for (const video of detailed) {
      const raw = String(video.upload_date || "");
      const published = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : new Date().toISOString().slice(0, 10);
      const age = daysSince(published);
      const item = {
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
      item.shape = shapeOf(item);
      items.push(item);
    }
  }

  items.sort((a, b) => b.velocity - a.velocity);
  if (cacheFile) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ at: Date.now(), queries: wanted, items }, null, 2));
  }
  return items;
}
