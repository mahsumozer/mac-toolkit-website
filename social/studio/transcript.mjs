// What a video actually says, with timings.
//
// Ported from the user's own YouTube transcript tool (youtube-subtitles,
// transcript.py) — its SerpApi call, its video-id parsing and its SRT writer are
// all here. The original is untouched; this is the same job wired into the
// studio.
//
// Two sources, in this order:
//
//   yt-dlp   already a dependency, no key, no credit, and it returns YouTube's
//            own json3 captions with per-cue start and duration.
//   SerpApi  the original tool's route. Kept as the fallback for the videos
//            yt-dlp cannot get captions for, and only used when a key is set.
//
// This exists so Autopilot stops guessing which twenty seconds of a trending
// video are worth cutting: with the transcript it can read the thing and pick.

import fs from "node:fs/promises";
import { join } from "node:path";

/** Ported from extract_video_id() in transcript.py. */
export function videoId(url) {
  const parsed = new URL(String(url).trim());
  if (parsed.hostname === "youtu.be") return parsed.pathname.replace(/^\//, "").split("/")[0];
  if (/youtube\.com$/.test(parsed.hostname.replace(/^www\./, "")) || /youtube\.com$/.test(parsed.hostname)) {
    if (parsed.pathname === "/watch") return parsed.searchParams.get("v") || "";
    if (parsed.pathname.startsWith("/shorts/")) return parsed.pathname.split("/shorts/")[1].split("/")[0];
    if (parsed.pathname.startsWith("/embed/")) return parsed.pathname.split("/embed/")[1].split("/")[0];
  }
  throw new Error(`Not a YouTube address: ${url}`);
}

// YouTube's json3: events with a start, a duration and text split into segments.
// Empty events are the scroll-up placeholders auto-captions are full of.
export function parseJson3(text) {
  const data = JSON.parse(text);
  const cues = [];
  for (const event of data.events || []) {
    const body = (event.segs || []).map((seg) => seg.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!body) continue;
    const start = (event.tStartMs || 0) / 1000;
    cues.push({ start, end: start + (event.dDurationMs || 2000) / 1000, text: body });
  }
  return dedupe(cues);
}

export function parseVtt(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, "").split("\n\n");
  for (const block of blocks) {
    const match = /(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(block);
    if (!match) continue;
    const body = block
      .split("\n")
      .slice(1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!body) continue;
    cues.push({ start: clock(match[1]), end: clock(match[2]), text: body });
  }
  return dedupe(cues);
}

const clock = (stamp) => {
  const [h, m, s] = stamp.split(":");
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
};

// Auto-captions repeat the previous line as they roll, so consecutive cues where
// one contains the other collapse into the longer one.
function dedupe(cues) {
  const out = [];
  for (const cue of cues) {
    const last = out[out.length - 1];
    if (last && (last.text === cue.text || cue.text.startsWith(last.text))) {
      last.end = cue.end;
      last.text = cue.text;
      continue;
    }
    out.push(cue);
  }
  return out;
}

/** Ported from transcript_to_srt() / seconds_to_srt_time(). */
export function toSrt(cues) {
  const stamp = (seconds) => {
    const ms = Math.round(seconds * 1000);
    const pad = (n, width = 2) => String(n).padStart(width, "0");
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  };
  return cues.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join("\n");
}

/** Ported from get_youtube_transcript(): SerpApi's youtube_video_transcript engine. */
async function serpApiTranscript(url, { apiKey, lang = "en" }) {
  const query = new URLSearchParams({ engine: "youtube_video_transcript", v: videoId(url), api_key: apiKey, language_code: lang });
  const res = await fetch(`https://serpapi.com/search?${query}`, { signal: AbortSignal.timeout(60000) });
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(`SerpApi: ${data.error}`);
  if (!res.ok) throw new Error(`SerpApi ${res.status}`);
  const cues = (data.transcript || [])
    .map((chunk) => {
      const start = Number(chunk.start_time ?? chunk.start ?? chunk.timestamp ?? 0) || 0;
      return { start, end: Number(chunk.end_time ?? chunk.end ?? start + 2), text: String(chunk.snippet || "").trim() };
    })
    .filter((cue) => cue.text);
  return { cues, title: data.video_title || "", source: "serpapi" };
}

async function ytdlpTranscript(url, { run, tmpDir, lang = "en" }) {
  await fs.mkdir(tmpDir, { recursive: true });
  const id = videoId(url);
  // One language, not "en.*": asking for every English variant downloads three
  // files and earns a 429 on the third.
  await run("yt-dlp", [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    lang,
    "--sub-format",
    "json3/vtt",
    "--no-warnings",
    "-o",
    join(tmpDir, "%(id)s.%(ext)s"),
    url,
  ]);
  const names = await fs.readdir(tmpDir);
  const mine = names.filter((name) => name.startsWith(id));
  const pick = mine.find((name) => name.endsWith(".json3")) || mine.find((name) => name.endsWith(".vtt"));
  if (!pick) return { cues: [], title: "", source: "yt-dlp" };
  const body = await fs.readFile(join(tmpDir, pick), "utf8");
  return { cues: pick.endsWith(".json3") ? parseJson3(body) : parseVtt(body), title: "", source: "yt-dlp" };
}

/**
 * The transcript, from whichever source can produce one.
 *
 * Cached on disk by video id, because the same trending video is read by every
 * concept in a campaign and a fetch is ten seconds.
 */
export async function fetchTranscript(url, { run, tmpDir, cacheDir, serpApiKey, lang = "en" }) {
  const id = videoId(url);
  const cacheFile = cacheDir ? join(cacheDir, `${id}.json`) : null;
  if (cacheFile) {
    const cached = await fs.readFile(cacheFile, "utf8").then(JSON.parse, () => null);
    if (cached) return cached;
  }

  let result = { cues: [], title: "", source: "none" };
  try {
    result = await ytdlpTranscript(url, { run, tmpDir: join(tmpDir, id), lang });
  } catch {}
  if (!result.cues.length && serpApiKey) {
    try {
      result = await serpApiTranscript(url, { apiKey: serpApiKey, lang });
    } catch (error) {
      result = { cues: [], title: "", source: "none", error: error.message };
    }
  }
  if (!result.cues.length && !result.error) result.error = "no captions for this video";

  const payload = { videoId: id, url, ...result, seconds: result.cues.length ? Math.round(result.cues[result.cues.length - 1].end) : 0 };
  if (cacheFile && payload.cues.length) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(payload));
  }
  return payload;
}

/** The first words, which is where a video's hook lives. */
export function opening(cues, seconds = 12) {
  return cues
    .filter((cue) => cue.start < seconds)
    .map((cue) => cue.text)
    .join(" ")
    .slice(0, 240);
}

/**
 * The transcript as a model should read it: one line per window of speech, each
 * stamped, so it can answer "which twenty seconds" with a timecode rather than
 * a guess.
 */
export function condense(cues, { window = 15, limit = 60 } = {}) {
  const lines = [];
  let bucket = null;
  for (const cue of cues) {
    if (!bucket || cue.start - bucket.start >= window) {
      bucket = { start: cue.start, text: [] };
      lines.push(bucket);
    }
    bucket.text.push(cue.text);
  }
  const stamp = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return lines.slice(0, limit).map((line) => `${stamp(line.start)} ${line.text.join(" ").replace(/\s+/g, " ").slice(0, 220)}`);
}
