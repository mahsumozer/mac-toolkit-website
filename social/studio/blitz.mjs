// Blitz — the shape of a hyped short, worn by one of our own posts.
//
// Remix (remix.html) does this to titles: a fast YouTube hook becomes a
// skeleton and the skeleton is filled with our claims. Blitz does it to the
// thing short-form actually rewards — the wall of text a creator burns over a
// face-cam clip, the "just watched a girl in my lecture …" block that carries
// the whole video. The rule is the one Remix already lives by: what is
// borrowed is the *shape* — the opener's grammar, the line count, the cadence,
// the lowercase, where it stops — and never the sentence, never the subject,
// and never a frame of the video.
//
// Three steps, three calls, because they cost three different things:
//
//   hunt()       yt-dlp, ~10s a query, cached for a few hours
//   readWall()   one small download plus one vision call
//   adaptWall()  one text call, the cheapest of the three
//
// The source clip lands in studio/tmp/blitz/ and never in the library. It is
// read and thrown away: the post that comes out the other end is our own
// footage with our own words on it, which is also why there is nothing here to
// argue about later.

import fs from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { shapeOf, jsonLines } from "./trends.mjs";
import { searchTikTok, tikTokProfileDir } from "./tiksearch.mjs";

const daysSince = (ms) => Math.max(1, (Date.now() - ms) / 86400000);

// Vision models, in the order they are tried. The list exists because the
// flash models answer a 503 "high demand" far more often than they fail, and
// falling to the next one is a second of latency against a dead run.
const VISION_MODELS = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-2.5-flash"];

/* -------------------------------------------------------------------- hunt */

/**
 * Where a name typed into the accounts field actually points.
 *
 * A bare `@name` is read as TikTok, because that is where this format lives and
 * it is what anyone typing one means. YouTube has to be said out loud — as a
 * link, or with a `yt:` in front — and what is read is the channel's Shorts
 * tab, never its uploads.
 */
export function parseAccount(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (/tiktok\.com/i.test(value)) {
    const found = /@([\w.\-]+)/.exec(value);
    return found ? { platform: "tiktok", handle: found[1] } : null;
  }
  if (/^yt:/i.test(value) || /youtube\.com|youtu\.be/i.test(value)) {
    const handle = /@([\w.\-]+)/.exec(value);
    if (handle) return { platform: "youtube", handle: handle[1], url: `https://www.youtube.com/@${handle[1]}/shorts` };
    const channel = /(?:channel|c|user)\/([\w.\-]+)/.exec(value);
    if (channel) return { platform: "youtube", handle: channel[1], url: `https://www.youtube.com/${/channel\//.test(value) ? "channel" : "c"}/${channel[1]}/shorts` };
    return null;
  }
  return { platform: "tiktok", handle: value.replace(/^@/, "") };
}

/**
 * What is blowing up in short-form right now, from the two places it happens.
 *
 * A phrase goes two ways. On YouTube it is the Shorts tab of the results page
 * (see `searchYouTubePage`). On TikTok there is no search to ask — yt-dlp's
 * tag and search extractors are broken and the site answers a headless browser
 * with a slider puzzle — so the phrase goes to DuckDuckGo as `site:tiktok.com
 * …` in a real Chrome (`tiksearch.mjs`), which hands back the video and
 * profile addresses it holds for it. The videos are read directly; the
 * profiles join the accounts that were typed, since a creator who turned up
 * for the phrase is exactly the kind of account worth reading.
 *
 * An *account* is the other way in: a channel's /shorts tab is nothing but
 * shorts, and a TikTok profile is nothing but TikToks. Reading by creator is
 * the more honest unit anyway — the shape being borrowed belongs to an account
 * that posts it every day, not to one lucky video.
 *
 * Ranked by velocity, views per day, for the same reason `trends.mjs` ranks
 * that way: a video that took three years to reach a million is not a trend.
 */
export async function hunt({
  queries = [],
  accounts = [],
  handles = [],
  run,
  cacheDir,
  tmpDir,
  perSource = 6,
  maxDuration = 90,
  limit = 18,
  ttlHours = 6,
  onNote = () => {},
}) {
  const wantedQueries = queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
  const wantedAccounts = [...accounts, ...handles]
    .map(parseAccount)
    .filter(Boolean)
    .filter((account, index, all) => all.findIndex((a) => a.platform === account.platform && a.handle === account.handle) === index)
    .slice(0, 6);
  if (!wantedQueries.length && !wantedAccounts.length) return { items: [], notes: ["nothing to hunt"] };

  const cacheKey = `v2:${wantedQueries.join("|")}::${wantedAccounts.map((a) => `${a.platform}:${a.handle}`).join("|")}::${maxDuration}`;
  const key = createHash("sha1").update(cacheKey).digest("hex").slice(0, 16);
  const cacheFile = cacheDir ? join(cacheDir, `blitz-${key}.json`) : null;
  if (cacheFile && ttlHours > 0) {
    const cached = await fs.readFile(cacheFile, "utf8").then(JSON.parse, () => null);
    if (cached && Date.now() - cached.at < ttlHours * 3600 * 1000) {
      onNote(`reusing a hunt from ${Math.round((Date.now() - cached.at) / 60000)} minutes ago`);
      return { items: cached.items, notes: cached.notes, cached: true };
    }
  }

  const notes = [];
  const seen = new Set();
  const items = [];

  for (const query of wantedQueries) {
    onNote(`searching YouTube for “${query}”`);
    try {
      // The Shorts tab of the results page, which is the only phrase search that
      // returns any: `ytsearch:` came back with forty results for "mac tips" and
      // not one under ninety seconds, the plain results page with none, and this
      // with eleven. YouTube still mixes long videos into that tab, hence the
      // duration filter underneath.
      let flat = await searchYouTubePage(query, { run, maxDuration, seen, shorts: true });
      if (flat.length < perSource) {
        onNote(`“${query}” again, without the shorts filter`);
        const more = await searchYouTubePage(query, { run, maxDuration, seen, exclude: flat });
        flat = [...flat, ...more];
      }
      flat = flat.sort((a, b) => (b.view_count || 0) - (a.view_count || 0)).slice(0, perSource);

      if (!flat.length) {
        notes.push(`“${query}” returned nothing under ${maxDuration}s — YouTube search buries shorts, so try an account instead`);
        continue;
      }
      flat.forEach((entry) => seen.add(`yt:${entry.id}`));
      items.push(...(await detailYouTube(flat.map((entry) => entry.id), { run, maxDuration, from: query, notes })));
    } catch (error) {
      notes.push(`“${query}” failed: ${String(error.message || error).slice(0, 120)}`);
    }
  }

  const ctx = { run, maxDuration, perSource, seen, notes };

  // TikTok by phrase. Each search is a Chrome launch and a page load, so the
  // phrases are the same few the YouTube pass used and the profiles it turns
  // up are read once each, after the typed accounts.
  const found = [];
  if (tmpDir) {
    for (const query of wantedQueries) {
      onNote(`searching TikTok for “${query}”`);
      try {
        const { videos, profiles } = await searchTikTok(query, { profileDir: tikTokProfileDir(tmpDir), limit: 20 });
        const fresh = videos.filter((url) => !seen.has(`tt:${(/\/video\/(\d+)/.exec(url) || [])[1]}`));
        if (fresh.length) items.push(...(await tikTokVideos(fresh, { ...ctx, from: query })));
        for (const handle of profiles) {
          if (!found.includes(handle) && !wantedAccounts.some((a) => a.platform === "tiktok" && a.handle === handle)) found.push(handle);
        }
        if (!videos.length && !profiles.length) notes.push(`“${query}” turned up nothing on TikTok`);
      } catch (error) {
        notes.push(`TikTok search for “${query}” failed: ${String(error.message || error).slice(0, 120)}`);
      }
    }
  }

  // A creator who turned up for the phrase is worth a look, but only a look:
  // their latest posts are whatever they filmed this week, not the phrase, so
  // three profiles at three videos each keeps the deck on the subject.
  const accountsToRead = [...wantedAccounts, ...found.slice(0, 3).map((handle) => ({ platform: "tiktok", handle, discovered: true }))];

  for (const account of accountsToRead) {
    onNote(`reading ${account.platform === "tiktok" ? "@" : "youtube.com/@"}${account.handle}${account.discovered ? " (turned up in the search)" : ""}`);
    try {
      if (account.platform === "youtube") {
        // Everything on a /shorts tab is a short, which is the whole reason
        // this path exists. The flat listing has no duration — that, the date
        // and the like count all come from the detailed pass.
        const flat = jsonLines(
          await run("yt-dlp", [
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            "--playlist-end",
            String(Math.max(perSource * 3, 12)),
            account.url || `https://www.youtube.com/@${account.handle}/shorts`,
          ]),
        )
          .filter((entry) => entry.id && !seen.has(`yt:${entry.id}`))
          .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
          .slice(0, perSource);

        if (!flat.length) {
          notes.push(`@${account.handle} has no shorts yt-dlp can list`);
          continue;
        }
        flat.forEach((entry) => seen.add(`yt:${entry.id}`));
        items.push(...(await detailYouTube(flat.map((entry) => entry.id), { run, maxDuration, from: `@${account.handle}`, notes })));
        continue;
      }

      items.push(...(await tikTokProfile(account.handle, account.discovered ? { ...ctx, perSource: Math.min(perSource, 3) } : ctx)));
    } catch (error) {
      // A profile that will not list is normal — TikTok rate-limits by IP and
      // yt-dlp's extractor breaks every few months. One account failing must
      // not take the other five down with it.
      notes.push(`${account.handle} could not be read: ${String(error.message || error).slice(0, 120)}`);
    }
  }

  // Per source, not overall: the two are shown side by side, and TikTok's
  // numbers are big enough that one limit across both left YouTube empty.
  items.sort((a, b) => b.velocity - a.velocity);
  const top = ["tiktok", "youtube"].flatMap((source) => items.filter((item) => item.source === source).slice(0, limit));

  if (cacheFile) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ at: Date.now(), items: top, notes }, null, 2));
  }
  return { items: top, notes };
}

// One flat pass over YouTube's results page. Flat entries carry a duration
// here, so the long ones are dropped before the expensive detail pass rather
// than after it.
//
// `sp=EgIYAQ==` is the Shorts tab of that page, and yt-dlp does pass it
// through — the same query with and without it comes back with two different
// sets of videos.
const SHORTS_FILTER = "EgIYAQ%3D%3D";

async function searchYouTubePage(query, { run, maxDuration, seen, exclude = [], shorts = false }) {
  const already = new Set(exclude.map((entry) => entry.id));
  return jsonLines(
    await run("yt-dlp", [
      "--flat-playlist",
      "--dump-json",
      "--no-warnings",
      "--playlist-end",
      "40",
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${shorts ? `&sp=${SHORTS_FILTER}` : ""}`,
    ]),
  )
    .filter((entry) => entry.id && entry.view_count && entry.live_status !== "is_live")
    .filter((entry) => Number(entry.duration) > 0 && Number(entry.duration) <= maxDuration)
    .filter((entry) => !seen.has(`yt:${entry.id}`) && !already.has(entry.id))
    // The results page repeats a video across its shelves; the first of each
    // wins and the rest would be the same card twice.
    .filter((entry, index, all) => all.findIndex((e) => e.id === entry.id) === index);
}

// A TikTok profile listing is the one place here that needs no second pass:
// the flat entries already carry views, likes and the timestamp.
async function tikTokProfile(handle, { run, maxDuration, perSource, seen, notes }) {
  const entries = jsonLines(
    await run("yt-dlp", [
      "--flat-playlist",
      "--dump-json",
      "--no-warnings",
      "--playlist-end",
      String(Math.max(perSource * 3, 12)),
      `https://www.tiktok.com/@${handle}`,
    ]),
  )
    .filter((entry) => entry.id && Number(entry.duration) > 0 && Number(entry.duration) <= maxDuration)
    .filter((entry) => !seen.has(`tt:${entry.id}`));

  if (!entries.length) {
    notes.push(`@${handle} returned nothing under ${maxDuration}s`);
    return [];
  }
  const scored = entries
    .map((entry) => tikTokRecord(entry, handle, `@${handle}`))
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, perSource);
  scored.forEach((item) => seen.add(item.id));
  return scored;
}

// Videos the search turned up, read in one yt-dlp pass. A single-video read
// carries everything a profile listing does, so the records are the same shape.
async function tikTokVideos(urls, { run, maxDuration, perSource, seen, notes, from }) {
  let detailed = [];
  try {
    detailed = jsonLines(await run("yt-dlp", ["--dump-json", "--no-warnings", "--skip-download", ...urls.slice(0, 12)]));
  } catch (error) {
    notes.push(`“${from}”: could not read ${urls.length} TikToks — ${String(error.message || error).slice(0, 100)}`);
    return [];
  }
  const scored = detailed
    .filter((video) => video.id && Number(video.duration) > 0 && Number(video.duration) <= maxDuration && !seen.has(`tt:${video.id}`))
    .map((video) => tikTokRecord(video, video.uploader || video.channel || "", from))
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, perSource);
  scored.forEach((item) => seen.add(item.id));
  return scored;
}

function tikTokRecord(entry, handle, from) {
  return record({
    id: `tt:${entry.id}`,
    source: "tiktok",
    // A TikTok has no title, only a caption, and the caption is the hook —
    // which is exactly what the classifier wants to read.
    title: (entry.title || entry.description || "").replace(/\s+/g, " ").trim(),
    url: entry.webpage_url || `https://www.tiktok.com/@${handle}/video/${entry.id}`,
    author: entry.channel || entry.uploader || handle,
    authorUrl: `https://www.tiktok.com/@${entry.uploader || handle}`,
    views: entry.view_count || 0,
    likes: entry.like_count || 0,
    comments: entry.comment_count || 0,
    duration: entry.duration || 0,
    thumb: (entry.thumbnails || []).find((t) => t.id === "cover")?.url || (entry.thumbnails || [])[0]?.url || "",
    publishedAt: entry.timestamp ? new Date(entry.timestamp * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    ageDays: Math.round(daysSince((entry.timestamp || Date.now() / 1000) * 1000)),
    query: from,
  });
}

// The second pass. It is the only place a YouTube upload date comes from, and
// without a date there is no velocity — which is the number everything here is
// sorted by.
async function detailYouTube(ids, { run, maxDuration, from, notes }) {
  if (!ids.length) return [];
  let detailed = [];
  try {
    detailed = jsonLines(
      await run("yt-dlp", ["--dump-json", "--no-warnings", "--skip-download", ...ids.map((id) => `https://www.youtube.com/watch?v=${id}`)]),
    );
  } catch (error) {
    notes.push(`${from}: could not read ${ids.length} videos in detail — ${String(error.message || error).slice(0, 100)}`);
    return [];
  }

  return detailed
    .filter((video) => Number(video.duration) > 0 && Number(video.duration) <= maxDuration)
    .map((video) => {
      const raw = String(video.upload_date || "");
      const published = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : new Date().toISOString().slice(0, 10);
      return record({
        id: `yt:${video.id}`,
        source: "youtube",
        title: (video.title || "").trim(),
        url: `https://www.youtube.com/watch?v=${video.id}`,
        author: video.channel || video.uploader || "",
        authorUrl: video.channel_url || video.uploader_url || "",
        views: video.view_count || 0,
        likes: video.like_count || 0,
        comments: video.comment_count || 0,
        duration: video.duration || 0,
        thumb: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
        publishedAt: published,
        ageDays: Math.round(daysSince(new Date(published).getTime())),
        query: from,
      });
    });
}

// One shape for both sources, so nothing downstream has to ask where a record
// came from. `engagement` is the like rate: on TikTok a 10% like rate is the
// difference between a video the algorithm pushed and one people actually
// liked, and it is the only number YouTube and TikTok report the same way.
function record(item) {
  const age = Math.max(1, item.ageDays || 1);
  return {
    ...item,
    kind: "hook",
    velocity: Math.round((item.views || 0) / age),
    engagement: item.views ? Number(((item.likes || 0) / item.views).toFixed(4)) : 0,
    shape: shapeOf({ kind: "hook", title: item.title }),
  };
}

/* ---------------------------------------------------------------- read it */

/**
 * What the creator actually wrote on the picture.
 *
 * The words that matter in this format are never in the title and rarely in
 * the captions — they are burned into the frames, which is why this reads the
 * frames. Three of them, spread across the clip, because the block sometimes
 * changes halfway through and one frame would report half a video.
 */
/**
 * The source clip, on disk. Shared by the read and by the deck's hover
 * preview, so a video watched on the deck is already here when it is picked.
 *
 * 720 is plenty to read type off, and a quarter of the bytes of 1080. The file
 * lives in tmp, never the library: it exists to be looked at and OCR'd, and to
 * sit in the left-hand pane as proof of what was borrowed from.
 */
export async function fetchClip({ item, run, ytdlpDownload, tmpDir, onStage = () => {} }) {
  const dir = join(tmpDir, "blitz");
  await fs.mkdir(dir, { recursive: true });
  const slug = String(item.id || "clip").replace(/[^a-z0-9]+/gi, "-");
  const file = join(dir, `${slug}.mp4`);

  const downloaded = await fs.access(file).then(() => true, () => false);
  if (!downloaded) {
    onStage("Downloading the source");
    await ytdlpDownload(
      ["-f", "bv*+ba/b", "-S", "res:720,vcodec:h264,ext:mp4", "--merge-output-format", "mp4", "--no-playlist", "--no-warnings", "-o", file],
      item.url,
    );
  }
  const duration = Number(item.duration) || (await probe(run, file)) || 10;
  return { file, dir, slug, duration };
}

export async function readWall({ item, run, ytdlpDownload, tmpDir, geminiKey, models = VISION_MODELS, onStage = () => {} }) {
  if (!geminiKey) throw new Error("Reading a video needs a Gemini key — add geminiApiKey to social/studio.config.json");

  const { file, dir, slug, duration } = await fetchClip({ item, run, ytdlpDownload, tmpDir, onStage });

  onStage("Grabbing frames");
  const frames = [];
  for (const [index, fraction] of [0.12, 0.42, 0.74].entries()) {
    const at = Math.max(0.2, Math.min(duration * fraction, Math.max(duration - 0.3, 0.3)));
    const frame = join(dir, `${slug}-${index}.jpg`);
    try {
      await run("ffmpeg", ["-y", "-ss", at.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "4", frame]);
      frames.push(frame);
    } catch {
      // A seek past the last keyframe of a very short clip returns nothing;
      // two frames read a caption as well as three.
    }
  }
  if (!frames.length) throw new Error("ffmpeg could not read a frame out of that clip");

  onStage("Reading the words off the picture");
  const read = await visionJson({
    key: geminiKey,
    models,
    prompt: READ_PROMPT,
    images: await Promise.all(frames.map(async (path) => ({ mime: "image/jpeg", data: (await fs.readFile(path)).toString("base64") }))),
  });

  const wall = String(read.wall || "").trim();
  return {
    path: file,
    frames,
    duration,
    // A video with nothing written on it is not a failure — it just has no
    // shape to lend, and saying so is more use than a made-up caption.
    onScreen: Boolean(read.onScreen) && Boolean(wall),
    wall,
    lines: Array.isArray(read.lines) ? read.lines.map((l) => String(l)) : wall.split("\n").filter(Boolean),
    casing: read.casing || "sentence",
    opener: read.opener || wall.split(/\s+/).slice(0, 4).join(" "),
    scene: read.scene || "",
    note: read.note || "",
  };
}

const READ_PROMPT = `These are frames from one short-form video, in order.

Read the words the creator burned onto the picture — the caption block that is part of the video.
Ignore everything the app drew around it: the @handle, the like/comment/share/bookmark counts, the
music ticker, the Follow button, the progress bar, any watermark, and word-by-word auto-subtitles.
If the same block sits on every frame, it is one caption — report it once.

Reply with json only, in this shape:
{
  "wall": "the caption exactly as written, its own spelling, casing and line breaks (\\n)",
  "lines": ["one array entry per line as it is broken on screen"],
  "casing": "lower | sentence | shouty",
  "opener": "the first three or four words",
  "onScreen": true,
  "scene": "what the camera is pointing at, six words, no names",
  "note": "one line on the shape worth borrowing — the rhythm, where it turns, how it ends"
}

If there is no burned-in caption at all, set "onScreen" to false and leave "wall" empty.`;

/* -------------------------------------------------------------- adapt it */

/**
 * Our version of that shape, for whichever product was pointed at.
 *
 * The model is given the source block and a **fact sheet** — the same one
 * Autopilot builds by reading a site (`readBrand` in autopilot.mjs) — and asked
 * for the same skeleton with that product's subject in it. The fact sheet is
 * the whole safety net: a claim that is not in it cannot be written, which is
 * the rule the copy generator, Autopilot and Remix all already follow.
 */
export async function adaptWall({ read, item, brand, ask }) {
  const features = (brand.features || []).map((line) => `- ${line}`);
  const shape = item.shape || {};

  // Three different briefs, because a video lends its shape three ways. With a
  // caption block, the block is the shape. Without one but with speech, the
  // shape is how it is *said* — the spoken opener, where it turns, how it lands
  // — and the answer is that story, written as a block for this product. With
  // neither, the only shape on offer is the title's — its count, its "X vs Y",
  // its "stop doing …" — and the answer is a line in that pattern, not a wall
  // of text conjured from nowhere.
  const spoken = !read.onScreen && read.speech && read.speech.lines && read.speech.lines.length;
  const sourceBrief = read.onScreen
    ? [
        `This is the block of text they wrote over their video:`,
        ``,
        `"""`,
        read.wall,
        `"""`,
        ``,
        read.note ? `What the shape does: ${read.note}` : "",
        `Its casing is ${read.casing}. It runs to ${read.lines.length || 1} line${(read.lines.length || 1) === 1 ? "" : "s"} on screen.`,
        ``,
        `Write ${brand.name}'s block in that same shape.`,
      ]
    : spoken
      ? [
          `Nothing is written on the picture — the hook is spoken. This is what they say, with timecodes:`,
          ``,
          `"""`,
          ...read.speech.lines,
          `"""`,
          ``,
          `Their title: "${item.title}".`,
          `Read it for its shape: how it opens (the first line is what earned the view), where it turns, how it ends, how many beats it runs, whether it is a story, a comparison, a list or a warning.`,
          `Write the on-screen block ${brand.name}'s version of this video would carry — the same move, the same number of beats, the same register — three to five short lines, as a creator would burn over their own footage. It is what a person would say on camera, not what a company would write on a slide.`,
        ]
      : [
        `There is no text on the picture, so the only shape on offer is the title's:`,
        ``,
        `"""`,
        item.title,
        `"""`,
        ``,
        `Its pattern: ${shape.hook || item.title}${shape.format ? ` (${shape.format.replace(/-/g, " ")}${shape.beats ? `, ${shape.beats} beats` : ""})` : ""}.`,
        `Write the line that would sit on screen for ${brand.name} in THAT pattern — the same opener, the same comparison or count or warning — short, the length of a title. Not a paragraph.`,
      ];

  const prompt = [
    `Someone else's short-form post is doing ${Number(item.velocity || 0).toLocaleString("en-US")} views a day.`,
    ...sourceBrief,
    ``,
    `BORROW: the opener's grammar, the number of beats, the rhythm, the casing, the punctuation, how it lands.`,
    `NEVER BORROW: their subject, their nouns, their joke, their sentence. If a reader could tell which post it came from, it is wrong.`,
    `ONE THING: pick one feature off the fact bank and one moment someone would actually see. A line that tours three features is a brochure, not a post.`,
    `A PERSON, NOT A BRAND: this is written by someone who uses the thing, in their own voice — "just watched", "my roommate", "I did not know" — never by the company. The product is not the subject of the first sentence; it turns up once, late, the way you would mention it to a friend. No price in the block. No "here's what that means", "at the end of the day", "the thing people are mixing up", no exclamation marks, no emoji.`,
    `LENGTH: about as many words as the source. If the source is a wall, ours is a wall; if it is one word, ours is one word.`,
    ``,
    `The product is ${brand.name}${brand.category ? `, a ${brand.category}` : ""} — ${brand.oneLiner || ""}.`,
    brand.priceLine ? `Price: ${brand.priceLine}.` : "",
    (brand.audience || []).length ? `Who it is for: ${(brand.audience || []).join("; ")}.` : "",
    (brand.proofs || []).length ? `Proofs that may be used: ${(brand.proofs || []).join("; ")}.` : "",
    brand.tone ? `Its tone: ${brand.tone}.` : "",
    ``,
    `The fact bank. Every claim in your answer must come from here — if it is not below, ${brand.name} does not do it:`,
    ...(features.length ? features : ["- (nothing was readable off the site; write about it in the most general terms its one-liner allows)"]),
    (brand.avoid || []).length ? `` : "",
    (brand.avoid || []).length ? `Never claim: ${(brand.avoid || []).join("; ")}.` : "",
    ``,
    // The keys and nothing else. A worked example with real words in it was
    // copied wholesale the first time a source had no text of its own — the
    // model borrowed the example's shape instead of the video's.
    `Reply with json only — no prose, no code fence — with exactly these keys. The values below describe what goes in each, they are not text to imitate:`,
    JSON.stringify(
      {
        wall: "the on-screen text, in the source's shape, about this product",
        lines: ["one entry per line, as it should break on screen"],
        angle: "two to four words naming the angle, used as a label",
        caption: "the post caption, one or two plain sentences",
        hashtags: ["three", "to", "six"],
        borrowed: "one sentence naming exactly what was taken from the source's shape",
        footageQuery: "two to four plain words for a stock or YouTube search, no product names",
      },
      null,
      2,
    ),
  ]
    .filter((line) => line !== "")
    .join("\n");

  let answer = await ask(adaptSystem(brand), prompt);
  // The tells of a first draft written by the brand rather than by a person.
  // A second pass with the offence named is far cheaper than a rendered ad.
  const tells = [
    [new RegExp(`^\\s*${brand.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), `it opens with the product's name`],
    [/\$\s?\d|\b\d+(?:\.\d+)?\s?(?:usd|eur|tl|dollars?)\b|\bone-time\b|\bsubscription\b|\bfree trial\b/i, "it has the price in it"],
    [/here'?s what (?:that|this) (?:actually )?means|at the end of the day|the thing people are mixing up|game.?changer|seamless(?:ly)?|empower/i, "it talks like a company"],
    [/!|[\u{1F300}-\u{1FAFF}]/u, "it shouts or uses emoji"],
  ];
  const offence = tells.find(([test]) => test.test(String(answer.wall || "")));
  if (offence) {
    answer = await ask(
      adaptSystem(brand),
      `${prompt}\n\nYour previous draft was rejected because ${offence[1]}:\n"""\n${answer.wall}\n"""\nWrite it again as a person would, keeping the borrowed shape.`,
    );
  }
  const wall = String(answer.wall || "").trim();
  if (!wall) throw new Error("the model returned no text");
  return {
    wall,
    lines: Array.isArray(answer.lines) && answer.lines.length ? answer.lines.map((l) => String(l)) : wall.split("\n").filter(Boolean),
    angle: String(answer.angle || "").trim() || (item.shape.format || "remix"),
    caption: String(answer.caption || [brand.oneLiner, brand.priceLine].filter(Boolean).join(". ")).trim(),
    hashtags: (Array.isArray(answer.hashtags) ? answer.hashtags : []).map((h) => String(h).replace(/^#/, "")).slice(0, 6),
    borrowed: String(answer.borrowed || "").trim(),
    footageQuery: String(answer.footageQuery || read.scene || "person laptop desk").trim(),
  };
}

const adaptSystem = (brand) =>
  [
    `You write the on-screen text for short-form videos about ${brand.name}${brand.category ? `, a ${brand.category}` : ""}.`,
    "You are shown one post that is already working and you return ours in the same shape.",
    "You are a stylist, not a copier: the skeleton is borrowed, the flesh is ours.",
    "Never write a feature that is not in the fact bank you are given. Never name another product.",
    "Write the way the source writes — if it is lowercase and unpunctuated, so are you.",
    "Answer with json.",
  ].join(" ");

/* ------------------------------------------------------------------ vision */

async function visionJson({ key, models, prompt, images }) {
  const body = JSON.stringify({
    contents: [
      {
        parts: [{ text: prompt }, ...images.map((img) => ({ inline_data: { mime_type: img.mime, data: img.data } }))],
      },
    ],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });

  let last = null;
  for (const model of models) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // A frame upload is a megabyte of base64 against a model that thinks
        // before it answers; undici's default is generous but the socket does
        // get dropped, and "fetch failed" with nothing after it is unreadable.
        signal: AbortSignal.timeout(120000),
      });
    } catch (error) {
      last = new Error(`Gemini ${model} did not answer: ${error.cause?.message || error.message}`);
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      // A thinking model answers in several parts, only some of which are text;
      // joining the text ones is the documented way to read it.
      const text = ((data.candidates || [])[0]?.content?.parts || [])
        .map((part) => part.text || "")
        .join("")
        .trim();
      if (!text) throw new Error(`${model} returned no text`);
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    }
    const detail = (await res.text()).slice(0, 200);
    last = new Error(`Gemini ${model} ${res.status}: ${detail}`);
    // 429 and 503 mean "this model, right now" — the next one on the list is
    // usually up. Anything else is the request itself and retrying is pointless.
    if (res.status !== 429 && res.status !== 503) throw last;
  }
  throw last || new Error("no vision model answered");
}

async function probe(run, path) {
  try {
    const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]);
    const value = Number(String(out).trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}
