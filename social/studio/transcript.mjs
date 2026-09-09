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

/**
 * Every word with the moment it is spoken.
 *
 * YouTube's automatic captions carry a `tOffsetMs` per segment inside each cue,
 * which is the only reason a supercut can cut on the word rather than on the
 * line. Manually uploaded captions usually have no offsets; those fall back to
 * spreading the cue's words evenly across its own duration, which is wrong by a
 * fraction of a second rather than by a line.
 */
export function wordsFromJson3(text) {
  const data = JSON.parse(text);
  const words = [];
  for (const event of data.events || []) {
    const segs = (event.segs || []).filter((seg) => (seg.utf8 || "").trim());
    if (!segs.length) continue;
    const base = (event.tStartMs || 0) / 1000;
    const span = (event.dDurationMs || 0) / 1000;
    const offsets = segs.map((seg) => seg.tOffsetMs);
    const timed = offsets.some((offset) => typeof offset === "number");
    segs.forEach((seg, i) => {
      const at = timed
        ? base + (typeof seg.tOffsetMs === "number" ? seg.tOffsetMs / 1000 : 0)
        : base + (span ? (span * i) / segs.length : 0);
      words.push({ t: Number(at.toFixed(3)), text: seg.utf8.trim() });
    });
  }
  // Auto-captions roll: the same words arrive again in the next event. A word at
  // the same second as the one before it is that repeat.
  const out = [];
  for (const word of words.sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && last.text === word.text && Math.abs(last.t - word.t) < 0.35) continue;
    out.push(word);
  }
  // Each word ends where the next begins; the last one gets a normal word's worth.
  return out.map((word, i) => ({ ...word, end: Number((out[i + 1] ? Math.min(out[i + 1].t, word.t + 1.6) : word.t + 0.6).toFixed(3)) }));
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
  // SerpApi answers with lines, not words. Spreading a line's words across its
  // own duration is wrong by a fraction of a second rather than by a line, which
  // is the difference between a transcript that can be cut from and one that
  // can only be read.
  const words = [];
  for (const cue of cues) {
    const parts = cue.text.split(/\s+/).filter(Boolean);
    const step = parts.length ? (cue.end - cue.start) / parts.length : 0;
    parts.forEach((part, i) => {
      const at = cue.start + step * i;
      words.push({ t: Number(at.toFixed(3)), end: Number((at + step).toFixed(3)), text: part });
    });
  }
  return { cues, words, title: data.video_title || "", source: "serpapi", approximate: true };
}

// YouTube answers 429 when several caption fetches land at once, and a 429 is
// not "this video has no captions" — it is "come back in a moment". Treating the
// two the same is what sent a third of the reads to a paid API for no reason.
const RETRY_AFTER = [1200, 4000, 9000];

async function ytdlpTranscript(url, { run, tmpDir, lang = "en" }) {
  await fs.mkdir(tmpDir, { recursive: true });
  const id = videoId(url);
  // `<lang>-orig` is the track YouTube labels "(Original)": the words actually
  // spoken. Plain `<lang>` on a foreign video is a machine translation of them —
  // fine for understanding what a video is about, useless for cutting, because
  // the mouth never said those words. Both are asked for and which one arrived
  // is reported.
  const args = [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    `${lang}-orig,${lang}`,
    "--sub-format",
    "json3/vtt",
    "--no-warnings",
    "-o",
    join(tmpDir, "%(id)s.%(ext)s"),
    url,
  ];
  for (let attempt = 0; ; attempt++) {
    try {
      await run("yt-dlp", args);
      break;
    } catch (error) {
      const message = String(error.message || error);
      const throttled = /429|too many requests|rate.?limit/i.test(message);
      if (!throttled || attempt >= RETRY_AFTER.length) {
        if (!throttled) break; // a real failure: fall through and see what landed
        throw error;
      }
      await new Promise((r) => setTimeout(r, RETRY_AFTER[attempt]));
    }
  }
  const names = await fs.readdir(tmpDir);
  const mine = names.filter((name) => name.startsWith(id));
  const prefer = [`.${lang}-orig.json3`, `.${lang}.json3`, `.${lang}-orig.vtt`, `.${lang}.vtt`];
  const pick = prefer.map((suffix) => mine.find((name) => name.endsWith(suffix))).find(Boolean);
  if (!pick) return { cues: [], words: [], title: "", source: "yt-dlp", original: false };
  const original = pick.includes(`${lang}-orig.`);
  const body = await fs.readFile(join(tmpDir, pick), "utf8");
  if (!pick.endsWith(".json3")) return { cues: parseVtt(body), words: [], title: "", source: "yt-dlp", original };
  return { cues: parseJson3(body), words: wordsFromJson3(body), title: "", source: "yt-dlp", original };
}

/**
 * The transcript, from whichever source can produce one.
 *
 * Cached on disk by video id, because the same trending video is read by every
 * concept in a campaign and a fetch is ten seconds.
 */
export async function fetchTranscript(url, { run, tmpDir, cacheDir, serpApiKey, lang = "en", allowSerpApi = true }) {
  const id = videoId(url);
  // The language is part of the key: the same video read as Turkish and as
  // English are two different transcripts, and one must never be served as the
  // other.
  const cacheFile = cacheDir ? join(cacheDir, `${id}.${lang}.json`) : null;
  if (cacheFile) {
    const cached = await fs.readFile(cacheFile, "utf8").then(JSON.parse, () => null);
    if (cached) return cached;
  }

  let result = { cues: [], words: [], title: "", source: "none", original: false };
  try {
    result = await ytdlpTranscript(url, { run, tmpDir: join(tmpDir, id), lang });
  } catch {}
  if (!result.cues.length && serpApiKey && allowSerpApi) {
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

// Enough to tell apart the languages this tool gets pointed at. Not a language
// detector — a decision about which caption track to ask for.
const LANGUAGE_HINTS = [
  { lang: "tr", letters: /[ğışçöüİĞŞÇÖÜ]/g, words: /\b(ve|daha|bir|için|ile|bu|çok|var|olarak|hepsi|tek)\b/gi },
  { lang: "de", letters: /[äöüß]/g, words: /\b(und|der|die|das|nicht|mit|für)\b/gi },
  { lang: "fr", letters: /[àâçéèêëîïôùûœ]/g, words: /\b(le|la|les|des|avec|pour|dans)\b/gi },
  { lang: "es", letters: /[áéíóúñ¿¡]/g, words: /\b(el|la|los|las|para|con|una)\b/gi },
  { lang: "it", letters: /[àèéìòù]/g, words: /\b(il|lo|gli|per|con|una|che)\b/gi },
];

export function guessLanguage(text) {
  const body = String(text || "");
  let best = { lang: "en", score: 0 };
  for (const hint of LANGUAGE_HINTS) {
    const score = (body.match(hint.letters) || []).length * 2 + (body.match(hint.words) || []).length;
    if (score > best.score) best = { lang: hint.lang, score };
  }
  return best.score >= 2 ? best.lang : "en";
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
