#!/usr/bin/env node
// Mac Kit Content Studio — local render/generation server.
//
//   node social/studio-server.mjs            # binds 127.0.0.1:8789
//
// The hub page (localhost:8787/social/studio.html) is static and cannot spawn
// ffmpeg, read the media library or hold an API key, so everything that needs a
// process or a secret lives here. Every response goes through the CORS wrapper
// in `serve()` — the page is a different origin (:8787) and the browser drops a
// response without those headers without telling anyone.
//
// Nothing here is deployed: social/ is excluded from scripts/build-pages.sh and
// gitignored, same as the rest of the hub.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, extname, basename, relative, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { runAgent, toolSchemas, buildBrief } from "./studio/agent.mjs";
import { runAutopilot } from "./studio/autopilot.mjs";
import { screenshotSite } from "./studio/shot.mjs";
import { trendingNow } from "./studio/trends.mjs";
import { fetchTranscript, condense, opening, guessLanguage } from "./studio/transcript.mjs";
import { tokenize, indexSource, buildCut, searchPhrases } from "./studio/supercut.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, "..");
const LIB = join(HERE, "studio", "library");
const OUT = join(HERE, "studio", "out");
const TMP = join(HERE, "studio", "tmp");
const PORT = Number(process.env.STUDIO_PORT || 8789);

// The composition canvas. The editor uses the same pair from studio/composition.js.
const COMP_W = 1080;
const COMP_H = 1920;

// Only these roots may be read through /file. A path that escapes them is a 403
// rather than a silent read of anything else on the disk.
const READ_ROOTS = [LIB, OUT, TMP, join(SITE, "social-media-video"), join(SITE, "videos"), join(SITE, "assets")];

/* ------------------------------------------------------------------ config */

// Keys come from studio.config.json (gitignored with the rest of social/) or
// from the environment, so nothing secret has to be typed into a page.
let config = {};
try {
  config = JSON.parse(await fs.readFile(join(HERE, "studio.config.json"), "utf8"));
} catch {
  config = {};
}
const key = (name, envName) => config[name] || process.env[envName] || "";
const ANTHROPIC_KEY = key("anthropicApiKey", "ANTHROPIC_API_KEY");
const DEEPSEEK_KEY = key("deepseekApiKey", "DEEPSEEK_API_KEY");
const PEXELS_KEY = key("pexelsApiKey", "PEXELS_API_KEY");
const ELEVEN_KEY = key("elevenLabsApiKey", "ELEVENLABS_API_KEY");
const GIPHY_KEY = key("giphyApiKey", "GIPHY_API_KEY");
const GEMINI_KEY = key("geminiApiKey", "GEMINI_API_KEY");
// SerpApi is the fallback transcript source, ported from the user's own
// youtube-subtitles tool; yt-dlp covers most videos without it.
const SERPAPI_KEY = key("serpApiKey", "SERPAPI_API_KEY");
// Off unless asked for. It reads the same captions yt-dlp does, charges per
// search, and since caption fetches learned to back off on a 429 it has almost
// nothing left to add. Set `useSerpApi: true` in the config to put it back.
const USE_SERPAPI = config.useSerpApi === true;

// Wikimedia rejects generic or contactless User-Agents with a 429, so every
// outbound request identifies the tool and where to complain about it.
const USER_AGENT = "MacKitStudio/1.0 (https://usemackit.com)";
const MODEL = config.model || "claude-opus-5";
const DEEPSEEK_MODEL = config.deepseekModel || "deepseek-v4-pro";
const GEMINI_TTS_MODEL = config.geminiTtsModel || "gemini-3.1-flash-tts-preview";

// `copyProvider` in the config picks between the providers that actually have a
// key; naming one without its key falls through rather than being honoured,
// because the alternative is every request failing at the API with a 401
// instead of the page quietly writing from templates.
const HAS_KEY = { deepseek: Boolean(DEEPSEEK_KEY), anthropic: Boolean(ANTHROPIC_KEY) };
const COPY_PROVIDER =
  (HAS_KEY[config.copyProvider] && config.copyProvider) ||
  (DEEPSEEK_KEY ? "deepseek" : ANTHROPIC_KEY ? "anthropic" : "none");

// Captions are rendered by the page onto a transparent canvas and overlaid as
// PNGs. That is deliberate: Homebrew's ffmpeg is built without libfreetype, so
// the drawtext filter does not exist here, and the overlay path also gives the
// captions the same type and sticker boxes as the image posts.

/* ----------------------------------------------------------------- helpers */

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const GIF_EXT = new Set([".gif", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);
const AUDIO_EXT = new Set([".mp3", ".m4a", ".wav", ".aiff"]);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function underRoot(path) {
  const abs = resolve(path);
  return READ_ROOTS.some((root) => abs === root || abs.startsWith(root + sep));
}

async function readBody(req, limitBytes = 512 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req, 64 * 1024 * 1024);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "post";
}

function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args);
    let err = "";
    child.stderr.on("data", (d) => {
      const text = d.toString();
      err += text;
      if (err.length > 40000) err = err.slice(-20000);
      if (onStderr) onStderr(text);
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new Error(`${cmd} exited ${code}\n${err.slice(-4000)}`));
    });
  });
}

async function probeDuration(path) {
  try {
    const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]);
    const value = Number(out.trim());
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function ffmpegVersion() {
  try {
    const out = await run("ffmpeg", ["-hide_banner", "-version"]);
    return out.split("\n")[0].trim();
  } catch {
    return null;
  }
}

// ffprobe is slow enough that probing the whole library on every /library call
// would be felt, so results are cached against the file's mtime and size.
const metaCache = new Map();

async function probeMeta(path, stat) {
  const key = `${path}:${stat.mtimeMs}:${stat.size}`;
  if (metaCache.has(key)) return metaCache.get(key);
  let meta = { duration: 0, width: 0, height: 0 };
  try {
    const out = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "default=nw=1:nk=0",
      path,
    ]);
    const read = (field) => {
      const match = new RegExp(`^${field}=(.+)$`, "m").exec(out);
      return match ? Number(match[1]) : 0;
    };
    meta = { duration: read("duration") || 0, width: read("width") || 0, height: read("height") || 0 };
  } catch {}
  metaCache.set(key, meta);
  return meta;
}

// A poster frame, written once and served from disk afterwards. Grabbing a
// frame is far cheaper than making the browser load a dozen full clips just to
// show a grid.
const THUMBS = join(TMP, "thumbs");

async function posterFrame(path, at) {
  const stat = await fs.stat(path);
  const key = createHash("sha1").update(`${path}:${stat.mtimeMs}:${at}`).digest("hex").slice(0, 20);
  const file = join(THUMBS, `${key}.jpg`);
  try {
    await fs.access(file);
    return file;
  } catch {}
  await fs.mkdir(THUMBS, { recursive: true });
  const meta = await probeMeta(path, stat);
  // A third of the way in beats frame zero: app recordings open on an empty
  // desktop and gameplay beds open on a title card.
  const seek = Math.min(Number(at) || Math.max(meta.duration * 0.35, 0.5), Math.max(meta.duration - 0.2, 0.1));
  await run("ffmpeg", ["-y", "-ss", String(seek), "-i", path, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", file]);
  return file;
}

async function hasAudio(path) {
  try {
    const out = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- library */

async function listDir(dir, extensions) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const items = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = extname(name).toLowerCase();
    if (!extensions.has(ext)) continue;
    const item = { name, path: abs, size: stat.size, url: `/file?p=${encodeURIComponent(abs)}` };
    if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
      const meta = await probeMeta(abs, stat);
      Object.assign(item, meta);
      if (VIDEO_EXT.has(ext)) item.poster = `/thumb?p=${encodeURIComponent(abs)}`;
    }
    items.push(item);
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

// The rendered marketing videos live one directory deep under videos/<project>/out.
async function listRenderedVideos() {
  const root = join(SITE, "videos");
  let projects = [];
  try {
    projects = await fs.readdir(root);
  } catch {
    return [];
  }
  const items = [];
  for (const project of projects) {
    const outDir = join(root, project, "out");
    for (const file of await listDir(outDir, VIDEO_EXT)) {
      items.push({ ...file, name: `${project}/${file.name}` });
    }
  }
  return items;
}

async function library() {
  const [photos, videos, music, voice, gifs, appClips, rendered, appShots] = await Promise.all([
    listDir(join(LIB, "photos"), IMAGE_EXT),
    listDir(join(LIB, "videos"), VIDEO_EXT),
    listDir(join(LIB, "music"), AUDIO_EXT),
    listDir(join(LIB, "voice"), AUDIO_EXT),
    listDir(join(LIB, "gifs"), GIF_EXT),
    listDir(join(SITE, "social-media-video"), VIDEO_EXT),
    listRenderedVideos(),
    listDir(join(SITE, "social-media-video"), IMAGE_EXT),
  ]);
  return {
    photos,
    videos,
    music,
    voice,
    gifs,
    appShots,
    appClips: [...appClips, ...rendered],
    copyProvider: COPY_PROVIDER,
    copyModel: COPY_PROVIDER === "deepseek" ? DEEPSEEK_MODEL : COPY_PROVIDER === "anthropic" ? MODEL : null,
    keys: {
      gemini: Boolean(GEMINI_KEY),
      anthropic: Boolean(ANTHROPIC_KEY),
      deepseek: Boolean(DEEPSEEK_KEY),
      giphy: Boolean(GIPHY_KEY),
      pexels: Boolean(PEXELS_KEY),
      elevenLabs: Boolean(ELEVEN_KEY),
    },
  };
}

/* ------------------------------------------------------------ stock photos */

const stripTags = (html) => String(html || "").replace(/<[^>]*>/g, "").trim();

// Pexels is the default because its licence needs no attribution. Without a key
// the fallback is Wikimedia Commons, which answers reliably and returns mostly
// CC0/CC-BY photography; Openverse stays available but its search endpoint
// times out often enough that it is not the default.
async function stockPhotos(query, provider, orientation) {
  if (provider === "pexels" || (!provider && PEXELS_KEY)) {
    if (!PEXELS_KEY) throw new Error("No Pexels API key — add pexelsApiKey to social/studio.config.json");
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=24&orientation=${orientation || "portrait"}`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    if (!res.ok) throw new Error(`Pexels ${res.status}`);
    const data = await res.json();
    return (data.photos || []).map((p) => ({
      id: `pexels-${p.id}`,
      thumb: p.src.medium,
      full: p.src.large2x || p.src.large,
      credit: p.photographer,
      creditUrl: p.url,
      licence: "Pexels licence",
      provider: "pexels",
    }));
  }

  if (provider === "openverse") {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial,modification&page_size=24&mature=false`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Openverse ${res.status}`);
    const data = await res.json();
    return (data.results || []).map((p) => ({
      id: `openverse-${p.id}`,
      thumb: p.thumbnail || p.url,
      full: p.url,
      credit: p.creator || "Unknown",
      creditUrl: p.foreign_landing_url,
      licence: `${(p.license || "").toUpperCase()} ${p.license_version || ""}`.trim(),
      provider: "openverse",
    }));
  }

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    generator: "search",
    gsrsearch: `filetype:bitmap ${query}`,
    gsrnamespace: "6",
    gsrlimit: "24",
    prop: "imageinfo",
    iiprop: "url|extmetadata|size",
    // Wide enough for the 1080 canvas and nothing more: the originals here run
    // 3-9 MB each, which is 40 MB of background for one six-slide post, and the
    // extra pixels are thrown away by the first draw.
    iiurlwidth: "1280",
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Wikimedia Commons ${res.status}`);
  const data = await res.json();
  const pages = Object.values((data.query && data.query.pages) || {});
  return pages
    .map((page) => {
      const info = (page.imageinfo || [])[0];
      if (!info) return null;
      const meta = info.extmetadata || {};
      // Portrait crops come from the canvas, but a very wide source loses most
      // of its subject, so landscape-only results are filtered out up front.
      if (info.width && info.height && info.width / info.height > 2.2) return null;
      return {
        id: `commons-${page.pageid}`,
        // Same URL for the grid and the canvas, so sampling a candidate's
        // brightness also warms the cache for the image about to be composited.
        thumb: info.thumburl || info.url,
        full: info.thumburl || info.url,
        credit: stripTags((meta.Artist || {}).value) || "Wikimedia Commons",
        creditUrl: info.descriptionurl,
        licence: stripTags((meta.LicenseShortName || {}).value) || "see file page",
        provider: "commons",
      };
    })
    .filter(Boolean);
}

// The page draws stock photos onto a canvas and then exports it, so the pixels
// have to arrive same-origin — a remote <img> taints the canvas and toBlob throws.
async function proxyImage(res, url) {
  const upstream = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!upstream.ok) return json(res, 502, { error: `upstream ${upstream.status}` });
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    "content-type": upstream.headers.get("content-type") || "image/jpeg",
    "content-length": buffer.length,
    "cache-control": "public, max-age=3600",
  });
  res.end(buffer);
}

/* ---------------------------------------------------------------- copy (AI) */

const COPY_SYSTEM = `You write short-form social copy for Mac Kit, a one-time-purchase macOS menu bar app.

Rules:
- Write like a person who uses the app, never like an ad. No hype words ("game changer", "revolutionary", "insane", "unlock"), no emoji unless asked, no exclamation marks.
- Every claim must be something the app actually does, taken from the feature list you are given. Never invent a feature.
- Slide text is read in under two seconds on a phone. Headline: at most 7 words. Body: one or two short sentences, at most 22 words total.
- The first slide is the hook and must work with no context.
- British or American spelling is fine, but be consistent.

Return only JSON matching the schema you are given.`;

// DeepSeek has no json_schema mode — only `response_format: json_object`, and
// its docs are explicit that the prompt has to say "json" and show the shape.
// So the same request carries both: a schema for Anthropic and a worked example
// for DeepSeek, and neither provider sees a different brief.
const EXAMPLES = {
  image: {
    slides: [
      { headline: "4 things I stopped doing on my Mac", body: "Small stuff that was costing me minutes every day." },
      { headline: "1. Hunting for a copied hex code", body: "Clipboard history keeps the last hundred, searchable." },
    ],
    scene: "laptop desk",
    caption: "4 things I stopped doing on my Mac\n\nMac Kit — 7-day trial, then $9.99 once",
    hashtags: ["macos", "macapps", "productivity"],
  },
  video: {
    hook: "Fourteen menu bar apps became one",
    lines: ["I was paying for four of these separately.", "Clipboard history, searchable.", "Mac Kit. $9.99 once."],
    caption: "Fourteen menu bar apps became one\n\nMac Kit — 7-day trial, then $9.99 once",
    hashtags: ["macos", "macapps", "productivity"],
  },
};

function buildCopyPrompt(payload) {
  const { kind, format, slideCount, topic, persona, features, product, tone } = payload;
  return [
    `Product: ${product.name} — ${product.url}`,
    `Positioning: ${product.priceLine}`,
    ``,
    `Features you may reference (nothing else exists):`,
    features.map((f) => `- ${f}`).join("\n"),
    ``,
    persona ? `Audience: ${persona.label} — ${persona.job} Tone: ${persona.tone}` : "",
    tone ? `Extra tone note: ${tone}` : "",
    ``,
    `Post kind: ${kind}`,
    `Format: ${format.label} — ${format.brief}`,
    topic ? `Topic the post must be about: ${topic}` : "",
    kind === "video"
      ? `Write ${slideCount} caption lines. The hook is separate and comes first.`
      : `Write exactly ${slideCount} slides. Slide 1 is the hook; the last slide names Mac Kit and what to do next.`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function deepseekJson(system, prompt) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${DEEPSEEK_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      max_tokens: 8000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = ((data.choices || [])[0]?.message?.content || "").trim();
  // The docs warn that json_object occasionally comes back empty; say so rather
  // than throwing a bare JSON.parse error the page cannot explain.
  if (!text) throw new Error("DeepSeek returned an empty response — try again, or ask for less");
  return JSON.parse(text);
}

async function claudeJson(prompt, schema) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    throw new Error("The Anthropic SDK is not installed. Run: npm install @anthropic-ai/sdk");
  }
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: COPY_SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", ...(schema ? { format: { type: "json_schema", schema } } : {}) },
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this prompt");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

async function generateCopyWithDeepSeek(payload) {
  const prompt = [
    buildCopyPrompt(payload),
    ``,
    `Reply with json only — no prose, no code fence. Use exactly this shape, with your own content:`,
    JSON.stringify(EXAMPLES[payload.kind === "video" ? "video" : "image"], null, 2),
  ].join("\n");
  return deepseekJson(COPY_SYSTEM, prompt);
}

async function generateCopyWithClaude(payload) {
  const { kind } = payload;
  const schema =
    kind === "video"
      ? {
          type: "object",
          additionalProperties: false,
          required: ["hook", "lines", "caption", "hashtags"],
          properties: {
            hook: { type: "string", description: "On-screen text for the first 2 seconds" },
            lines: {
              type: "array",
              minItems: 3,
              maxItems: 12,
              items: { type: "string" },
              description: "Spoken/caption lines in order, one short sentence each",
            },
            caption: { type: "string", description: "The post caption" },
            hashtags: { type: "array", items: { type: "string" }, maxItems: 6 },
          },
        }
      : {
          type: "object",
          additionalProperties: false,
          required: ["slides", "scene", "caption", "hashtags"],
          properties: {
            slides: {
              type: "array",
              minItems: 3,
              maxItems: 12,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["headline", "body"],
                properties: {
                  headline: { type: "string" },
                  body: { type: "string" },
                },
              },
            },
            scene: {
              type: "string",
              description:
                "Two plain words naming ONE ordinary place the whole carousel is photographed in, e.g. \"laptop desk\" or \"cafe table\". No product names, no adjectives — it is a stock photo search and every word has to match.",
            },
            caption: { type: "string" },
            hashtags: { type: "array", items: { type: "string" }, maxItems: 6 },
          },
        };

  return claudeJson(buildCopyPrompt(payload), schema);
}

async function generateCopy(payload) {
  if (COPY_PROVIDER === "deepseek") return { source: "deepseek", model: DEEPSEEK_MODEL, ...(await generateCopyWithDeepSeek(payload)) };
  if (COPY_PROVIDER === "anthropic") return { source: "claude", model: MODEL, ...(await generateCopyWithClaude(payload)) };
  throw new Error("no-key");
}

/* ---------------------------------------------------------------------- TTS */

// `say -v ?` prints one voice per line as: "Name       en_US    # sample line".
// Only the English voices are offered — the rest read the script phonetically
// in the wrong language.

// Gemini's thirty voices, with the one-word character its docs give each. The
// descriptor is not decoration: it is what a person picks from, and what the
// producer in autopilot reads when it chooses one for a script.
const GEMINI_VOICES = [
  ["Charon", "Informative"], ["Kore", "Firm"], ["Puck", "Upbeat"], ["Zephyr", "Bright"],
  ["Aoede", "Breezy"], ["Callirrhoe", "Easy-going"], ["Leda", "Youthful"], ["Fenrir", "Excitable"],
  ["Orus", "Firm"], ["Autonoe", "Bright"], ["Enceladus", "Breathy"], ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"], ["Erinome", "Clear"],
  ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"], ["Laomedeia", "Upbeat"], ["Achernar", "Soft"],
  ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"], ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"],
  ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"],
];
const GEMINI_DEFAULT_VOICE = "Charon";

// The API answers with raw 24 kHz mono PCM, which ffmpeg will not read without
// being told the rate, the layout and the sample format. A 44-byte RIFF header
// costs nothing and makes the file a normal WAV that everything downstream
// already understands.
function wavFromPcm(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Style is a sentence in front of the script rather than a parameter: these
// models take direction in plain language ("Say this warmly, at an even pace"),
// and the instruction is read as direction, not spoken.
async function geminiSpeak(text, voiceName, style) {
  const voice = GEMINI_VOICES.some(([name]) => name === voiceName) ? voiceName : GEMINI_DEFAULT_VOICE;
  const input = style ? `${String(style).trim().replace(/[.:]*$/, "")}:\n\n${text}` : text;
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      model: GEMINI_TTS_MODEL,
      input,
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
    }),
  });
  if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();

  // The audio is one part of one step, and the shape has moved once already, so
  // it is searched for by kind rather than read out of a fixed path.
  const parts = [];
  for (const step of data.steps || []) for (const part of step.content || []) parts.push(part);
  if (data.output_audio) parts.push(data.output_audio);
  const audio = parts.find((part) => part && part.data && (part.type === "audio" || /audio/i.test(part.mime_type || "")));
  if (!audio) throw new Error(`Gemini TTS returned no audio (status ${data.status || "unknown"})`);

  const pcm = Buffer.from(audio.data, "base64");
  return wavFromPcm(pcm, Number(audio.sample_rate) || 24000, Number(audio.channels) || 1);
}

async function listVoices() {
  // With a Gemini key the default is Gemini, so an empty voice — what every
  // caller that never asked for one sends — gets the good one.
  const voices = GEMINI_KEY
    ? [
        { id: "", label: `Default (Gemini · ${GEMINI_DEFAULT_VOICE})` },
        ...GEMINI_VOICES.map(([name, character]) => ({ id: `gemini:${name}`, label: `${name} — ${character} (Gemini)` })),
      ]
    : [{ id: "", label: "System default (say)" }];
  try {
    const out = await run("say", ["-v", "?"]);
    for (const line of out.split("\n")) {
      const match = /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})/.exec(line);
      if (!match) continue;
      if (!match[2].startsWith("en")) continue;
      voices.push({ id: `say:${match[1].trim()}`, label: `${match[1].trim()} (${match[2]})` });
    }
  } catch {}
  if (ELEVEN_KEY) {
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY } });
      if (res.ok) {
        const data = await res.json();
        for (const voice of data.voices || []) {
          voices.push({ id: `eleven:${voice.voice_id}`, label: `${voice.name} (ElevenLabs)` });
        }
      }
    } catch {}
  }
  return voices;
}

async function synthesise(text, voice, outPath, style) {
  // Gemini is the default speaker when its key is set: an empty voice, which is
  // what everything that does not care sends, lands here rather than on `say`.
  if (GEMINI_KEY && (!voice || voice.startsWith("gemini:"))) {
    try {
      const wav = outPath.replace(/\.\w+$/, "") + ".wav";
      await fs.writeFile(wav, await geminiSpeak(text, voice ? voice.slice("gemini:".length) : GEMINI_DEFAULT_VOICE, style));
      return wav;
    } catch (error) {
      // A quota that ran out, or a bad minute at the API, should cost the post
      // its nicest voice and nothing else — an autopilot run is minutes of
      // downloads by the time it gets here.
      console.warn(`  voice: Gemini failed (${String(error.message || error).slice(0, 120)}) — falling back to macOS say`);
      // Cleared rather than pointed at ElevenLabs: that route needs a voice id
      // nobody has chosen, while `say` with no name is the system default and
      // always works.
      voice = "";
    }
  }

  if (ELEVEN_KEY && voice && voice.startsWith("eleven:")) {
    const voiceId = voice.slice("eleven:".length);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await fs.writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    return outPath;
  }

  // macOS `say` is the zero-key, zero-network default. It writes AIFF, which
  // ffmpeg reads directly, so no intermediate conversion is needed.
  const aiff = outPath.replace(/\.\w+$/, "") + ".aiff";
  const args = ["-o", aiff];
  if (voice && voice.startsWith("say:")) args.push("-v", voice.slice("say:".length));
  args.push(text);
  await run("say", args);
  return aiff;
}

// The script as a file in the library, so it becomes a layer with a start, an
// end and a trim like everything else — rather than something the renderer
// conjures at the last moment and nobody can see or cut.
async function makeVoiceover({ text, voice, name, style }, job) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("Nothing to say — write a hook or some caption lines first");

  const dir = join(LIB, "voice");
  await fs.mkdir(dir, { recursive: true });
  const base = slugify(name || clean.slice(0, 40)) || "voiceover";
  const target = join(dir, `${base}-${Date.now().toString(36).slice(-4)}.m4a`);

  job.stage = "Speaking";
  const raw = await synthesise(clean, voice, join(TMP, `vo-${job.id}.mp3`), style);
  job.stage = "Encoding";
  // `say` writes AIFF, ElevenLabs writes MP3 and Gemini writes WAV; one remux
  // gives the page a format it can play and ffmpeg a consistent input.
  await run("ffmpeg", ["-y", "-i", raw, "-c:a", "aac", "-b:a", "160k", target]);
  await fs.rm(raw, { force: true });

  const stat = await fs.stat(target);
  const duration = await probeDuration(target);
  return { name: basename(target), path: target, size: stat.size, duration, url: `/file?p=${encodeURIComponent(target)}` };
}

/* ------------------------------------------------------------------ gifs */

// Giphy has two libraries behind the same shape: `gifs` are rectangular with a
// solid background, `stickers` are cut out with real transparency. The second
// is what you want on top of a video, so both are offered rather than guessed.
async function searchGiphy(query, { kind = "stickers", limit = 24, rating = "pg-13" } = {}) {
  if (!GIPHY_KEY) throw new Error("No Giphy API key — add giphyApiKey to social/studio.config.json (free at developers.giphy.com)");
  const endpoint = kind === "gifs" ? "gifs" : "stickers";
  const params = new URLSearchParams({ api_key: GIPHY_KEY, q: query, limit: String(limit), rating, bundle: "messaging_non_clips" });
  const res = await fetch(`https://api.giphy.com/v1/${endpoint}/search?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Giphy ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.data || [])
    .map((item) => {
      const images = item.images || {};
      const full = images.original || {};
      if (!full.url) return null;
      return {
        id: `giphy-${item.id}`,
        title: item.title || item.slug || item.id,
        // The small rendition is only ever shown in the grid; the original is
        // what gets downloaded, because a 200px sticker on a 1080 canvas is mush.
        thumb: (images.fixed_width_small || images.fixed_width || full).url,
        url: full.url,
        width: Number(full.width) || 0,
        height: Number(full.height) || 0,
        size: Number(full.size) || 0,
        kind: endpoint,
        creditUrl: item.url,
        channel: (item.user && item.user.display_name) || item.username || "Giphy",
        provider: "giphy",
      };
    })
    .filter(Boolean);
}

async function fetchGif(item, job) {
  const dir = join(LIB, "gifs");
  await fs.mkdir(dir, { recursive: true });
  const base = slugify(`${item.kind || "gif"}-${item.title || item.id}`).slice(0, 48) || "gif";
  const target = join(dir, `${base}.gif`);

  job.stage = "Downloading";
  const res = await fetch(item.url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
  job.progress = 1;

  const stat = await fs.stat(target);
  const meta = await probeMeta(target, stat);
  await recordSource(basename(target), { ...item, query: item.query || "" });
  return { name: basename(target), path: target, size: stat.size, ...meta, url: `/file?p=${encodeURIComponent(target)}` };
}

/* -------------------------------------------------------- footage from the web */

// "What is viral right now" is not something any public API answers. What is
// answerable is "what does YouTube return for this query, ranked by views", and
// yt-dlp does that with no API key at all, so that is what this searches.
async function ytdlpAvailable() {
  try {
    await run("yt-dlp", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function searchYouTube(query, { limit = 12, sort = "views", maxDuration = 3600 } = {}) {
  if (!(await ytdlpAvailable())) throw new Error("yt-dlp is not installed. Run: brew install yt-dlp");
  const out = await run("yt-dlp", ["--flat-playlist", "--dump-json", "--no-warnings", `ytsearch${Math.min(limit * 2, 40)}:${query}`]);
  const items = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => entry.id && (!entry.duration || entry.duration <= maxDuration))
    .map((entry) => ({
      id: entry.id,
      title: entry.title || entry.id,
      url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
      duration: entry.duration || 0,
      views: entry.view_count || 0,
      channel: entry.channel || entry.uploader || "",
      thumb: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
      provider: "youtube",
    }));
  if (sort === "views") items.sort((a, b) => b.views - a.views);
  return items.slice(0, limit);
}

async function searchPexelsVideos(query, { limit = 12, orientation = "portrait" } = {}) {
  if (!PEXELS_KEY) throw new Error("No Pexels API key — add pexelsApiKey to social/studio.config.json");
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${limit}&orientation=${orientation}`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
  if (!res.ok) throw new Error(`Pexels ${res.status}`);
  const data = await res.json();
  return (data.videos || []).map((video) => {
    // Prefer the largest file that is still under 1080 wide; the 4K variants
    // are hundreds of megabytes for footage that ends up 1080 across.
    const files = (video.video_files || []).filter((f) => f.width && f.width <= 1920).sort((a, b) => b.width - a.width);
    return {
      id: `pexels-${video.id}`,
      title: video.user ? `${video.user.name} — ${video.duration}s` : `Pexels ${video.id}`,
      url: (files[0] || video.video_files[0] || {}).link,
      duration: video.duration || 0,
      views: 0,
      channel: video.user ? video.user.name : "Pexels",
      thumb: video.image,
      provider: "pexels",
      direct: true,
    };
  }).filter((v) => v.url);
}

async function fetchFootage(item, job) {
  await fs.mkdir(join(LIB, "videos"), { recursive: true });
  const base = slugify(`${item.provider || "clip"}-${item.title || item.id}`).slice(0, 48);
  const target = join(LIB, "videos", `${base}.mp4`);

  if (item.direct) {
    job.stage = "Downloading";
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
    job.progress = 1;
  } else {
    if (!(await ytdlpAvailable())) throw new Error("yt-dlp is not installed. Run: brew install yt-dlp");
    job.stage = "Downloading";
    // Sorting, not filtering, picks the format: -S prefers ~1080 resolution and
    // H.264 among equals (the canvas editor decodes every layer on the main
    // thread each frame, and AV1 stutters there). A `height<=1080` filter looks
    // right and is not — on a vertical 1080x1920 clip the height is 1920, so it
    // throws away every good format and leaves a 480p one behind.
    await ytdlpDownload(
      [
        "-f",
        "bv*+ba/b",
        "-S",
        "res:1080,vcodec:h264,ext:mp4",
        "--merge-output-format",
        "mp4",
        "--no-playlist",
        "--no-warnings",
        ...(item.section ? ["--download-sections", `*${item.section}`, "--force-keyframes-at-cuts"] : []),
        "-o",
        target,
      ],
      item.url,
      {
        onStderr(text) {
          const match = /(\d+(?:\.\d+)?)%/.exec(text);
          if (match) job.progress = Math.min(0.99, Number(match[1]) / 100);
        },
      },
    );
  }

  const stat = await fs.stat(target);
  await recordSource(basename(target), item);
  return { name: basename(target), path: target, size: stat.size, url: `/file?p=${encodeURIComponent(target)}` };
}

// Every downloaded clip is logged in library/videos/sources.json. Six months
// from now the only way to answer "where did this footage come from and may we
// use it" is a record written at download time.
async function recordSource(name, item) {
  const folder = item.provider === "giphy" ? "gifs" : item.provider === "site" ? "photos" : "videos";
  const file = join(LIB, folder, "sources.json");
  let manifest = {};
  try {
    manifest = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {}
  manifest[name] = {
    query: item.query || "",
    title: item.title || "",
    channel: item.channel || "",
    url: item.url,
    ...(item.section ? { section: item.section } : {}),
    fetched: new Date().toISOString().slice(0, 10),
    licence:
      item.provider === "pexels"
        ? "Pexels licence — free for commercial use, no attribution required"
        : item.provider === "giphy"
          ? "Giphy — check the source before commercial use; many uploads are third-party clips"
          : item.provider === "site"
            ? "the product's own site — fine for a post about that product, nothing else"
            : item.provider === "commons"
              ? "Wikimedia Commons — mostly CC0/CC-BY; check the credit before commercial use"
              : "uploader states no-copyright / free to use — not verified",
  };
  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

// Turns a plain brief ("a video about clipboard history") into the search
// queries that actually find usable background footage. Falls back to a fixed
// set of well-known no-copyright staples when there is no model key.
const FALLBACK_QUERIES = [
  "subway surfers gameplay no copyright vertical",
  "minecraft parkour gameplay no copyright vertical",
  "satisfying soap cutting asmr vertical",
  "hydraulic press satisfying compilation",
  "drone forest flyover 4k no copyright",
];

async function suggestQueries(prompt) {
  if (COPY_PROVIDER === "none") return FALLBACK_QUERIES;
  const brief = [
    `A short vertical social video needs background footage. The video is about: ${prompt || "a macOS utility app"}.`,
    ``,
    `Give search queries for footage that holds attention behind captions: gameplay, satisfying loops, drone shots, oddly-specific b-roll. Prefer clips explicitly marked no-copyright, and prefer vertical.`,
    ``,
    `Reply with json only, in this shape:`,
    JSON.stringify({ queries: ["subway surfers gameplay no copyright vertical", "satisfying kinetic sand cutting"] }, null, 2),
  ].join("\n");

  try {
    const result =
      COPY_PROVIDER === "deepseek"
        ? await deepseekJson("You suggest stock-footage search queries. Reply with json only.", brief)
        : await claudeJson(brief);
    const queries = (result.queries || []).filter((q) => typeof q === "string" && q.trim());
    return queries.length ? queries.slice(0, 5) : FALLBACK_QUERIES;
  } catch {
    return FALLBACK_QUERIES;
  }
}

/* ------------------------------------------------------------ video render */

const jobs = new Map();

// Both rendering and footage downloads are slow enough to need progress, so
// they share one job record and one polling endpoint.
function startJob(name, work) {
  const job = {
    id: randomUUID(),
    slug: `${new Date().toISOString().slice(0, 10)}-${slugify(name)}`,
    status: "running",
    stage: "Starting",
    progress: 0,
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  work(job).then(
    (result) => Object.assign(job, { status: "done", progress: 1, stage: "Done", result }),
    (error) => Object.assign(job, { status: "error", stage: "Failed", error: String(error.message || error) }),
  );
  return job.id;
}

// One overlay per layer, in the composition's own order. Each layer arrives
// with the source crop and the destination rect already worked out by the
// editor, so this never re-derives geometry — that is the whole reason the
// preview and the file agree.
async function renderComposition(spec, job) {
  const workDir = join(TMP, job.id);
  await fs.mkdir(workDir, { recursive: true });

  const layers = (spec.layers || []).filter((l) => l.visible !== false);
  if (!layers.length) throw new Error("The canvas is empty — add a clip first");

  for (const layer of layers) {
    if (layer.path && !underRoot(layer.path)) throw new Error(`Path outside the media library: ${layer.path}`);
  }

  let duration = Math.max(2, Math.min(Number(spec.duration) || 20, 300));

  job.stage = "Preparing layers";
  const inputs = [];
  const addInput = (args) => {
    inputs.push(args);
    return inputs.length - 1;
  };

  // A generated black base means an empty region is black rather than whatever
  // the first layer happened to leave there.
  const baseIndex = addInput(["-f", "lavfi", "-i", `color=c=black:s=${COMP_W}x${COMP_H}:r=30`]);
  const chain = [];
  chain.push(`[${baseIndex}:v]setsar=1[v0]`);
  let videoLabel = "v0";

  const audioParts = [];
  let step = 0;

  for (const layer of layers) {
    const start = Number(layer.start) || 0;
    const end = Number(layer.end) || duration;
    if (end <= 0 || start >= duration) continue;

    let index;
    if (layer.type === "text") {
      const base64 = String(layer.png || "").replace(/^data:image\/\w+;base64,/, "");
      if (!base64) continue;
      const file = join(workDir, `text-${step}.png`);
      await fs.writeFile(file, Buffer.from(base64, "base64"));
      // A text PNG is already a positioned full frame, so it overlays at 0:0.
      // -loop 1 is what makes a still last: a plain image input decodes one
      // frame and overlay stops compositing long before its window comes round.
      index = addInput(["-loop", "1", "-i", file]);
      chain.push(`[${index}:v]format=rgba${layer.opacity < 1 ? `,colorchannelmixer=aa=${layer.opacity}` : ""}[l${step}]`);
      chain.push(`[${videoLabel}][l${step}]overlay=0:0:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[v${step + 1}]`);
      videoLabel = `v${step + 1}`;
      step++;
      continue;
    }

    // An audio layer has no picture: it contributes a stream to the mix and
    // nothing to the overlay chain.
    if (layer.type === "audio") {
      if (!layer.path || Number(layer.volume) <= 0) continue;
      index = addInput(["-ss", String(layer.trim || 0), "-i", layer.path]);
      const audio = [`volume=${Number(layer.volume)}`, `atrim=0:${(end - start).toFixed(3)}`, "asetpts=PTS-STARTPTS"];
      if (start > 0.01) audio.push(`adelay=delays=${Math.round(start * 1000)}:all=1`);
      chain.push(`[${index}:a]${audio.join(",")}[a${step}]`);
      audioParts.push(`[a${step}]`);
      step++;
      continue;
    }

    const crop = layer.crop || {};
    const rect = layer.rect || { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    if (!rect.w || !rect.h) continue;

    if (layer.type === "gif") {
      // -ignore_loop 0 makes the gif repeat for as long as the overlay needs it;
      // a gif input otherwise stops at its own last frame like any other file.
      index = addInput(["-ignore_loop", "0", "-i", layer.path]);
    } else if (layer.type === "image") {
      index = addInput(["-loop", "1", "-i", layer.path]);
    } else {
      index = addInput(["-stream_loop", "-1", "-ss", String(layer.trim || 0), "-i", layer.path]);
    }

    const filters = [];
    if (crop.sw && crop.sh) filters.push(`crop=${Math.round(crop.sw)}:${Math.round(crop.sh)}:${Math.round(crop.sx || 0)}:${Math.round(crop.sy || 0)}`);
    filters.push(`scale=${Math.round(rect.w)}:${Math.round(rect.h)}`);
    filters.push("setsar=1");
    // CSS blur(r) is a gaussian of roughly r/2, which is what the canvas
    // preview draws — matching it here keeps the two in step.
    if (layer.blur) filters.push(`gblur=sigma=${(Number(layer.blur) / 2).toFixed(2)}`);
    filters.push("format=rgba");
    if (layer.opacity < 1) filters.push(`colorchannelmixer=aa=${layer.opacity}`);
    // A clip that does not begin at zero has to be pushed down its own timeline
    // too, not merely hidden until its turn: `-ss` puts the in-point at output
    // time zero, so without this a layer starting at 4s would show the frame
    // four seconds past its in-point. The padding is transparent and falls
    // entirely inside the window `enable` already hides.
    if (layer.type === "video" && start > 0.01) filters.push(`tpad=start_duration=${start.toFixed(3)}:start_mode=add:color=black@0`);

    chain.push(`[${index}:v]${filters.join(",")}[l${step}]`);
    chain.push(
      `[${videoLabel}][l${step}]overlay=${Math.round(rect.x)}:${Math.round(rect.y)}:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[v${step + 1}]`,
    );
    videoLabel = `v${step + 1}`;

    if (layer.type === "video" && Number(layer.volume) > 0 && (await hasAudio(layer.path))) {
      // Audio is cut to the same window as the picture. Without the trim, two
      // halves of a split clip would each play their own sound over the whole
      // render instead of one after the other.
      const audio = [`volume=${Number(layer.volume)}`, `atrim=0:${(end - start).toFixed(3)}`, "asetpts=PTS-STARTPTS"];
      if (start > 0.01) audio.push(`adelay=delays=${Math.round(start * 1000)}:all=1`);
      chain.push(`[${index}:a]${audio.join(",")}[a${step}]`);
      audioParts.push(`[a${step}]`);
    }
    step++;
  }

  if (spec.musicPath && Number(spec.musicVolume) > 0) {
    if (!underRoot(spec.musicPath)) throw new Error("Music path outside the media library");
    const index = addInput(["-stream_loop", "-1", "-i", spec.musicPath]);
    chain.push(`[${index}:a]volume=${Number(spec.musicVolume)}[amus]`);
    audioParts.push("[amus]");
  }

  chain.push(`[${videoLabel}]null[vout]`);

  let audioLabel = "";
  if (audioParts.length === 1) audioLabel = audioParts[0].slice(1, -1);
  else if (audioParts.length > 1) {
    chain.push(`${audioParts.join("")}amix=inputs=${audioParts.length}:normalize=0:dropout_transition=0[amix]`);
    audioLabel = "amix";
  }

  // Each render gets its own folder, and a name is never reused: reopening a
  // project and rendering again has to leave the original where it was, or the
  // "edit a past render" loop quietly destroys what it started from.
  const dir = await uniqueOutDir(job.slug);
  job.slug = basename(dir);
  const outFile = join(dir, "video.mp4");
  const args = ["-y", ...inputs.flat(), "-filter_complex", chain.join(";"), "-map", "[vout]"];
  if (audioLabel) args.push("-map", `[${audioLabel}]`, "-c:a", "aac", "-b:a", "160k");
  else args.push("-an");
  args.push(
    "-t",
    duration.toFixed(2),
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outFile,
  );

  job.stage = "Rendering";
  job.command = `ffmpeg ${args.map((a) => (/[ ;']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  await run("ffmpeg", args, {
    onStderr(text) {
      const match = /time=(\d+):(\d+):(\d+\.\d+)/.exec(text);
      if (!match) return;
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      job.progress = Math.min(0.99, seconds / duration);
    },
  });

  // The caption travels with the file — a rendered mp4 with the copy left in a
  // browser tab is half a post.
  const caption = [spec.caption || "", "", (spec.hashtags || []).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")]
    .join("\n")
    .trim();
  if (caption) await fs.writeFile(join(dir, "caption.txt"), caption + "\n", "utf8");

  // The project is the editable composition, not the frozen render spec: crops,
  // rects and baked text PNGs describe one frame size and cannot be dragged.
  // Without this a finished video is a dead end.
  if (spec.project) {
    const project = {
      version: 1,
      kind: "video",
      created: new Date().toISOString(),
      slug: job.slug,
      video: "video.mp4",
      duration,
      ...spec.project,
    };
    await fs.writeFile(join(dir, "project.json"), JSON.stringify(project, null, 2) + "\n", "utf8");
  }

  await fs.rm(workDir, { recursive: true, force: true });
  return { file: outFile, dir, slug: job.slug, url: `/file?p=${encodeURIComponent(outFile)}`, duration };
}

// `<slug>`, then `<slug>-2`, `<slug>-3`… The caller gets a directory that did
// not exist a moment ago, so nothing is ever written over.
async function uniqueOutDir(slug) {
  for (let n = 1; n < 500; n++) {
    const name = n === 1 ? slug : `${slug}-${n}`;
    const dir = join(OUT, name);
    try {
      await fs.mkdir(dir, { recursive: false });
      return dir;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Too many renders named ${slug}`);
}

/* ------------------------------------------------------------------ ai mode */

// One completion, shaped for the loop in studio/agent.mjs. Tool use needs real
// room: the plan arrives as a single call carrying the whole script.
async function agentCall(messages, tools) {
  if (COPY_PROVIDER !== "deepseek") throw new Error("AI mode needs the DeepSeek key — add deepseekApiKey to social/studio.config.json");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${DEEPSEEK_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, tools, max_tokens: 8000 }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const choice = (data.choices || [])[0];
  if (!choice) throw new Error("DeepSeek returned no choices");
  return choice.message;
}

// The library as the model sees it: paths and the few facts that decide whether
// a clip is usable, without the URLs and byte counts it has no use for.
function libraryForAgent(lib) {
  const brief = (items, extra = () => ({})) =>
    items.slice(0, 40).map((i) => ({ name: i.name, path: i.path, ...extra(i) }));
  const size = (i) => ({ size: i.width && i.height ? `${i.width}x${i.height}` : undefined, seconds: i.duration ? Math.round(i.duration) : undefined });
  return {
    backgroundClips: brief(lib.videos, size),
    appRecordings: brief(lib.appClips, size),
    stills: brief([...lib.photos, ...lib.appShots]),
    gifs: brief(lib.gifs, size),
    music: brief(lib.music),
    voiceovers: brief(lib.voice, (i) => ({ seconds: i.duration ? Math.round(i.duration) : undefined })),
  };
}

function agentTools(job, label = "ai mode") {
  // Search results are held between calls so download_gif can take an id rather
  // than the model having to echo a URL back correctly.
  const seen = new Map();
  const push = (event) => job.messages.push({ at: Date.now(), ...event });

  return {
    async list_library() {
      return libraryForAgent(await library());
    },

    async search_footage({ query, sort }) {
      const results = await searchYouTube(query, { limit: 8, sort: sort || "views" });
      for (const r of results) seen.set(r.id, r);
      return results.map((r) => ({ id: r.id, title: r.title, url: r.url, seconds: r.duration, views: r.views, channel: r.channel }));
    },

    async download_footage({ url, title, section }) {
      job.stage = `Downloading ${String(title).slice(0, 40)}`;
      const item = { url, title, section, provider: "youtube", query: label };
      const file = await fetchFootage(item, job);
      push({ role: "tool-result", tool: "download_footage", text: `${file.name} (${Math.round(file.size / 1e6)} MB)` });
      return { path: file.path, name: file.name, size: file.width && file.height ? `${file.width}x${file.height}` : undefined, seconds: Math.round(file.duration || 0) };
    },

    async search_gif({ query, kind }) {
      const results = await searchGiphy(query, { kind: kind || "stickers", limit: 12 });
      for (const r of results) seen.set(r.id, r);
      return results.map((r) => ({ id: r.id, title: r.title, size: `${r.width}x${r.height}` }));
    },

    async download_gif({ id }) {
      const item = seen.get(id);
      if (!item) throw new Error(`No such gif id: ${id}. Call search_gif first and use an id from its results.`);
      job.stage = "Saving sticker";
      const file = await fetchGif({ ...item, query: label }, job);
      push({ role: "tool-result", tool: "download_gif", text: file.name });
      return { path: file.path, name: file.name };
    },

    async make_voiceover({ text, voice, style }) {
      job.stage = "Speaking the script";
      const file = await makeVoiceover({ text, voice, style, name: text.slice(0, 40) }, job);
      push({ role: "tool-result", tool: "make_voiceover", text: `${file.duration.toFixed(1)}s` });
      return { path: file.path, seconds: Number(file.duration.toFixed(2)) };
    },
  };
}

async function runAiMode(payload, job) {
  job.messages = [];
  job.stage = "Thinking";

  const formats = JSON.parse(await fs.readFile(join(HERE, "studio", "formats.json"), "utf8"));
  const brief = buildBrief({
    answers: payload.answers || {},
    features: formats.features,
    product: payload.product || { name: "Mac Kit", url: "https://usemackit.com/", priceLine: formats.positioning.price },
    voices: payload.voices || [],
  });

  const result = await runAgent({
    call: agentCall,
    tools: toolSchemas({ hasGiphy: Boolean(GIPHY_KEY) }),
    toolImpls: agentTools(job),
    brief,
    onEvent: (event) => {
      job.messages.push({ at: Date.now(), ...event });
      if (event.role === "tool") job.stage = event.tool.replace(/_/g, " ");
    },
  });

  job.stage = "Plan ready";
  return result;
}

/* ---------------------------------------------------------------- autopilot */

// One URL in, a campaign out. The passes and every prompt live in
// studio/autopilot.mjs; what lives here is what needs a socket or a subprocess —
// reading the site, and the producer's hands.

// The page hands this an address a person typed, so the fetcher is deliberately
// narrow: http(s) only, and never this machine or the private network. A
// fetcher that follows anything will eventually be pointed at a router's admin
// page.
const PRIVATE_HOST = /^(localhost$|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

async function fetchSitePage(target) {
  const parsed = new URL(String(target).trim());
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("only http and https addresses can be read");
  if (PRIVATE_HOST.test(parsed.hostname)) throw new Error("that address is on this machine or the local network");
  const res = await fetch(parsed, {
    headers: { "User-Agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${parsed.hostname} answered ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (type && !/html|xml|text/i.test(type)) throw new Error(`${parsed.hostname} returned ${type}, not a page`);
  const buffer = Buffer.from(await res.arrayBuffer());
  // Two megabytes of markup is already far more than the model will read.
  return buffer.subarray(0, 2 * 1024 * 1024).toString("utf8");
}

// What a video says, with timings. Cached by video id: the same trending upload
// is read by every concept in a campaign and a fetch is a couple of seconds.
const readVideo = (url, lang = "en", { allowSerpApi = USE_SERPAPI } = {}) =>
  fetchTranscript(url, { run, tmpDir: join(TMP, "subs"), cacheDir: join(TMP, "subs-cache"), serpApiKey: SERPAPI_KEY, lang, allowSerpApi });

function autopilotTools(job) {
  const photoResults = new Map();
  // `list_library` is deliberately dropped rather than left unused: an
  // autopilot post is made of things fetched during its own run, and a tool
  // that hands the model a shelf of leftovers is an invitation to reuse them.
  const { list_library, ...base } = agentTools(job, "autopilot");
  return {
    ...base,

    async screenshot_site({ url, width, height, scrollY }) {
      job.stage = "Photographing the site";
      const { file, stat, shotUrl } = await screenshotSite(url, {
        width: Number(width) || 1440,
        height: Number(height) || 900,
        scrollY: Number(scrollY) || 0,
        outDir: join(LIB, "photos"),
        profileDir: join(TMP, "shot-profile"),
      });
      const meta = await probeMeta(file, stat).catch(() => ({}));
      await recordSource(basename(file), { url: shotUrl, title: "page screenshot", provider: "site", query: "autopilot" });
      // Compared as URLs, not as strings: "https://x.com" and "https://x.com/"
      // are the same page, and saying one replaced the other is a lie.
      const asked = (() => {
        try {
          return new URL(String(url).trim()).toString();
        } catch {
          return String(url).trim();
        }
      })();
      const moved = shotUrl !== asked;
      job.messages.push({
        at: Date.now(),
        role: "tool-result",
        tool: "screenshot_site",
        text: `${basename(file)} ${meta.width || "?"}x${meta.height || "?"}${moved ? ` (that page 404'd — photographed ${shotUrl})` : ""}`,
      });
      return {
        path: file,
        name: basename(file),
        photographed: shotUrl,
        ...(moved ? { note: `${url} does not exist, so the site's home page was photographed instead` } : {}),
        size: meta.width && meta.height ? `${meta.width}x${meta.height}` : undefined,
      };
    },

    // The product's own site is the only place a screenshot of someone else's
    // app can come from, so the pictures on the page are downloadable like any
    // other source, with the same provenance record behind them.
    async download_site_image({ url, name }) {
      if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("download_site_image needs an http(s) url from the brief");
      job.stage = "Taking a picture off the site";
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
      const type = res.headers.get("content-type") || "";
      if (!/^image\//i.test(type)) throw new Error(`that url is ${type || "not an image"}`);
      if (/svg/i.test(type)) throw new Error("SVG cannot be rendered — pick a png, jpg or webp");
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > 25 * 1024 * 1024) throw new Error("that image is over 25 MB");

      const ext = /png/i.test(type) ? ".png" : /webp/i.test(type) ? ".webp" : /gif/i.test(type) ? ".gif" : ".jpg";
      const dir = join(LIB, "photos");
      await fs.mkdir(dir, { recursive: true });
      const base = slugify(name || basename(new URL(url).pathname) || "site-image");
      const file = join(dir, `${base}-${createHash("sha1").update(url).digest("hex").slice(0, 6)}${ext}`);
      await fs.writeFile(file, buffer);

      const meta = await probeMeta(file, await fs.stat(file)).catch(() => ({}));
      await recordSource(basename(file), { url, title: name || "", provider: "site", query: "autopilot", licence: "the product's own site" });
      job.messages.push({ at: Date.now(), role: "tool-result", tool: "download_site_image", text: `${basename(file)} ${meta.width || "?"}x${meta.height || "?"}` });
      return { path: file, name: basename(file), size: meta.width && meta.height ? `${meta.width}x${meta.height}` : undefined };
    },
    // The carousel's blank-slide trap, made checkable: Commons ANDs every word,
    // so a scene the producer likes can quietly return nothing. Now it can look
    // before it commits.
    // Reading before cutting. Without this the producer picks a section by
    // guessing a timecode, which is how a bed came back from the middle of a
    // sponsor read.
    async read_video({ url }) {
      job.stage = "Reading the video";
      const transcript = await readVideo(url);
      if (!transcript.cues.length) {
        job.messages.push({ at: Date.now(), role: "tool-result", tool: "read_video", text: `no captions (${transcript.error || "none published"})` });
        return { url, seconds: 0, transcript: [], note: transcript.error || "this video has no captions to read" };
      }
      job.messages.push({
        at: Date.now(),
        role: "tool-result",
        tool: "read_video",
        text: `${transcript.cues.length} lines over ${Math.round(transcript.seconds / 60)} min (${transcript.source})`,
      });
      return {
        url,
        seconds: transcript.seconds,
        source: transcript.source,
        opening: opening(transcript.cues),
        transcript: condense(transcript.cues),
      };
    },

    async search_photos({ query }) {
      const results = await stockPhotos(query, "", "portrait").catch(() => []);
      // Held between calls so download_photo can take an id rather than the
      // model having to echo a long URL back correctly.
      results.forEach((result, i) => photoResults.set(`p${i + 1}`, result));
      job.messages.push({ at: Date.now(), role: "tool-result", tool: "search_photos", text: `${query} — ${results.length} photos` });
      return {
        query,
        found: results.length,
        results: results.slice(0, 8).map((result, i) => ({ id: `p${i + 1}`, credit: result.credit || result.title || "" })),
      };
    },

    async download_photo({ id }) {
      const item = photoResults.get(id);
      if (!item) throw new Error(`No such photo id: ${id}. Call search_photos first and use an id from its results.`);
      job.stage = "Saving a photograph";
      const res = await fetch(item.full, { headers: { "User-Agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`the photo host answered ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const dir = join(LIB, "photos");
      await fs.mkdir(dir, { recursive: true });
      const type = res.headers.get("content-type") || "";
      const ext = /png/i.test(type) ? ".png" : /webp/i.test(type) ? ".webp" : ".jpg";
      const file = join(dir, `stock-${slugify(item.credit || "photo")}-${createHash("sha1").update(item.full).digest("hex").slice(0, 6)}${ext}`);
      await fs.writeFile(file, buffer);
      const meta = await probeMeta(file, await fs.stat(file)).catch(() => ({}));
      await recordSource(basename(file), { url: item.full, title: item.credit || "", provider: PEXELS_KEY ? "pexels" : "commons", query: "autopilot" });
      job.messages.push({ at: Date.now(), role: "tool-result", tool: "download_photo", text: `${basename(file)} ${meta.width || "?"}x${meta.height || "?"}` });
      return { path: file, name: basename(file), size: meta.width && meta.height ? `${meta.width}x${meta.height}` : undefined, credit: item.credit || "" };
    },
  };
}

async function runAutopilotJob(payload, job) {
  job.messages = [];
  job.plans = [];
  job.stage = "Reading the site";

  const result = await runAutopilot({
    url: payload.url,
    count: Math.max(1, Math.min(Number(payload.count) || 3, 6)),
    mix: payload.mix,
    voices: payload.voices || [],
    voiceover: payload.voiceover !== false,
    hasGiphy: Boolean(GIPHY_KEY),
    fetchPage: fetchSitePage,
    // Ranked by views per day and cached for half a day, because each query
    // costs two yt-dlp passes and a campaign is often re-run within an hour.
    trends: (queries) => trendingNow({ queries, run, cacheDir: join(TMP, "trends") }),
    readVideo,
    json: (system, prompt) => {
      if (COPY_PROVIDER === "deepseek") return deepseekJson(system, prompt);
      if (COPY_PROVIDER === "anthropic") return claudeJson(`${system}\n\n${prompt}`, null);
      throw new Error("Autopilot needs a model key — add deepseekApiKey to social/studio.config.json");
    },
    agentCall,
    toolImpls: autopilotTools(job),
    onEvent: (event) => {
      job.messages.push({ at: Date.now(), ...event });
      // A plan is carried on the message as well as returned at the end, so the
      // page can start rendering post one while post two is still downloading.
      if (event.role === "concept-done" && event.plan) job.plans.push(event.plan);
      if (event.role === "tool") job.stage = event.tool.replace(/_/g, " ");
    },
    onPhase: (stage) => {
      job.stage = stage;
      job.messages.push({ at: Date.now(), role: "phase", text: stage });
    },
  });

  job.stage = "Plans ready";
  return result;
}

/* ---------------------------------------------------------------- supercut */

// A script, cut out of other people's videos: find where each word is actually
// spoken, download those seconds, hand back the pieces in script order. The
// matching is in studio/supercut.mjs; what lives here is the searching, the
// reading and the cutting, all of which need a process.

const CUTS = join(LIB, "videos", "cuts");

// One clip, cut to the second. `--force-keyframes-at-cuts` re-encodes the edges
// so the cut lands on the word rather than on the nearest keyframe, which can be
// several seconds early — the whole point of cutting on a transcript.
// YouTube refuses a share of downloads with "Sign in to confirm you're not a
// bot", and which client is asked decides whether that happens: the default web
// player is challenged where the mobile ones are waved through. Measured on a
// refused video — web, tv and web_safari all failed, android downloaded it.
const PLAYER_CLIENTS = [null, "android", "ios", "tv_embedded"];
const BOT_CHECK = /not a bot|sign in to confirm|403: forbidden|please sign in/i;

async function ytdlpDownload(args, url, { onStderr } = {}) {
  let last = null;
  for (const client of PLAYER_CLIENTS) {
    try {
      await run("yt-dlp", [...args, ...(client ? ["--extractor-args", `youtube:player_client=${client}`] : []), url], { onStderr });
      return client;
    } catch (error) {
      last = error;
      if (!BOT_CHECK.test(String(error.message || error))) throw error;
    }
  }
  throw last;
}

async function cutSection(item, job) {
  await fs.mkdir(CUTS, { recursive: true });
  const target = join(CUTS, `${slugify(`${item.text}-${Math.round(item.start)}`).slice(0, 40)}-${createHash("sha1").update(`${item.url}${item.start}`).digest("hex").slice(0, 6)}.mp4`);
  try {
    await fs.access(target);
    return target;
  } catch {}
  await ytdlpDownload(
    [
      "-f",
      "bv*+ba/b",
      "-S",
      "res:1080,vcodec:h264,ext:mp4",
      "--merge-output-format",
      "mp4",
      "--no-playlist",
      "--no-warnings",
      "--download-sections",
      `*${item.start}-${item.end}`,
      "--force-keyframes-at-cuts",
      "-o",
      target,
    ],
    item.url,
  );
  await recordSource(basename(target), { url: item.url, title: item.title || "", provider: "youtube", query: "supercut", section: `${item.start}-${item.end}` });
  return target;
}

// Transcripts for a list of videos, a few at a time. Every one is a yt-dlp call,
// and forty at once is how a laptop stops answering.
async function readAll(videos, { lang = "en", job } = {}) {
  const sources = [];
  const queue = [...videos];
  // Three at a time, staggered. Four simultaneous caption fetches is what earns
  // the 429 in the first place, and a read that has to be retried costs more
  // than the one that was never throttled.
  const workers = Array.from({ length: 3 }, async (_unused, index) => {
    await new Promise((r) => setTimeout(r, index * 350));
    while (queue.length) {
      const video = queue.shift();
      try {
        // A supercut reads dozens of videos a run and SerpApi charges per
        // search, so the paid fallback stays for the one-video reads Autopilot
        // does and never fires here.
        const transcript = await readVideo(video.url, lang, { allowSerpApi: false });
        // A translated caption track is words nobody said. It is fine for
        // understanding a video and useless for cutting one, so it never becomes
        // a source here.
        if (transcript.words && transcript.words.length && transcript.original !== false) {
          sources.push(indexSource(video, transcript.words, { onTopic: video.onTopic !== false }));
          if (job) job.progress = Math.min(0.5, sources.length / Math.max(videos.length, 1) / 2);
        }
      } catch {}
    }
  });
  await Promise.all(workers);
  return sources;
}

async function runSupercut(payload, job) {
  job.messages = [];
  const say = (text, extra = {}) => job.messages.push({ at: Date.now(), role: "tool-result", tool: "supercut", text, ...extra });

  const topic = String(payload.topic || "").trim();
  const script = String(payload.script || "").trim();
  if (!topic) throw new Error("Pick a subject to cut from — 'macbook', 'coffee', 'formula one'");
  if (!script) throw new Error("Write the line you want assembled");

  const lang = payload.lang && payload.lang !== "auto" ? payload.lang : guessLanguage(script);

  job.stage = "Finding videos";
  const pool = new Map();
  const gather = async (query, limit, onTopic = true) => {
    const results = await searchYouTube(query, { limit, sort: "views", maxDuration: 2400 }).catch(() => []);
    for (const result of results) {
      if (!pool.has(result.id)) pool.set(result.id, { url: result.url, title: result.title, channel: result.channel, onTopic });
    }
    return results.length;
  };
  await gather(topic, Number(payload.videoCount) || 12);
  // A subject typed in English cannot supply Turkish words, so when the script
  // is not English the subject is searched again with a word that pulls that
  // language's own videos up.
  const LANGUAGE_SEED = { tr: "inceleme", de: "test", fr: "avis", es: "reseña", it: "recensione", pt: "análise" };
  // Videos found because someone says the phrase, not because they are about the
  // subject. This is what lets the solver take four words in one go instead of
  // stitching four singles.
  if (lang !== "en" && LANGUAGE_SEED[lang]) await gather(`${topic} ${LANGUAGE_SEED[lang]}`, 8);
  const phrases = searchPhrases(script);
  for (const phrase of phrases) await gather(`"${phrase}"`, 4, false);
  say(`${pool.size} videos — "${topic}" plus ${phrases.length} phrase searches (${phrases.map((p) => `"${p}"`).join(", ")})`);
  if (lang !== "en") say(`the script reads as ${lang}: only videos actually spoken in ${lang} can supply its words, so translated caption tracks are ignored`);

  job.stage = "Reading them";
  let sources = await readAll([...pool.values()], { lang, job });
  say(`${sources.length} of them have captions — ${sources.reduce((n, s) => n + s.words.length, 0).toLocaleString()} words to cut from`);

  // Plenty of uploads have no captions at all, and a thin pool is what makes a
  // cut stutter. So the search does not stop at one page: it keeps asking, in
  // the shapes that tend to return people talking, until there is enough to cut
  // from or the shapes run out.
  const TARGET = Math.max(6, Math.round((Number(payload.videoCount) || 12) * 0.6));
  const TOP_UPS = [(t) => `${t} review`, (t) => `${t} tips`, (t) => `${t} explained`, (t) => `${t} guide`, (t) => `${t} tutorial`];
  for (let round = 0; sources.length < TARGET && round < TOP_UPS.length; round++) {
    job.stage = `Looking for more captions (${sources.length}/${TARGET})`;
    const before = pool.size;
    await gather(TOP_UPS[round](topic), 8);
    if (pool.size === before) continue;
    const fresh = [...pool.values()].filter((video) => !sources.some((source) => source.video.url === video.url));
    if (!fresh.length) continue;
    const had = sources.length;
    sources = sources.concat(await readAll(fresh, { lang }));
    say(`searched again — ${sources.length - had} more with captions, ${sources.length} in the pool`);
  }
  if (!sources.length) throw new Error("None of those videos have captions to cut from — try a broader subject");

  job.stage = "Matching the script";
  const tokens = tokenize(script);
  const cutCost = Number(payload.cutCost) || 1;
  let cut = buildCut(tokens, sources, { cutCost });

  // A word nobody in the first pool says gets hunted on its own, and the hunt
  // does not stop at one search: a word that is missing is missing until it is
  // found, so each one is chased through several shapes of query and the match
  // is rebuilt after every round.
  const SHAPES = [
    (word) => `"${word}"`,
    (word) => `${topic} ${word}`,
    (word, neighbour) => (neighbour ? `"${word} ${neighbour}"` : `${word} nedir`),
    (word) => `${word} ${lang === "tr" ? "anlatım" : "explained"}`,
  ];
  const hunted = new Set();
  for (let round = 0; round < SHAPES.length; round++) {
    const stillMissing = cut.missing.filter((word) => !hunted.has(`${word}:${round}`));
    if (!stillMissing.length) break;
    let grew = false;
    for (const word of stillMissing.slice(0, 8)) {
      hunted.add(`${word}:${round}`);
      job.stage = `Hunting "${word}"`;
      const at = tokens.findIndex((token) => token.raw === word);
      const neighbour = at >= 0 && tokens[at + 1] ? tokens[at + 1].raw : "";
      const before = pool.size;
      await gather(SHAPES[round](word, neighbour), 5, false);
      if (pool.size === before) continue;
      const fresh = [...pool.values()].filter((video) => !sources.some((source) => source.video.url === video.url));
      if (!fresh.length) continue;
      // A Turkish script still says "clipboard" and "cleaning mode". Those words
      // are English wherever they are spoken, so when a missing word is plain
      // ASCII the hunt reads its videos as English as well — the cut is a
      // patchwork of voices either way, and a word found in the wrong language
      // is still the word.
      const alsoEnglish = lang !== "en" && /^[\x20-\x7E]+$/.test(word);
      sources = sources.concat(await readAll(fresh, { lang }));
      if (alsoEnglish) sources = sources.concat(await readAll(fresh, { lang: "en" }));
      grew = true;
      say(`hunted "${word}" through ${pool.size - before} more videos`);
    }
    if (!grew) continue;
    const before = cut.missing.length;
    cut = buildCut(tokens, sources, { cutCost });
    if (cut.missing.length < before) say(`found ${before - cut.missing.length} more of them`);
    if (!cut.missing.length) break;
  }

  job.stage = "Cutting";
  const clips = cut.segments.filter((segment) => segment.kind === "clip");
  let done = 0;
  for (const clip of clips) {
    // The first choice, then whoever else said the same words. A refused
    // download is not a reason to lose the line.
    const takes = [clip, ...(clip.alternates || [])];
    for (const [index, take] of takes.entries()) {
      try {
        clip.path = await cutSection({ ...take, text: clip.text }, job);
        if (index > 0) {
          Object.assign(clip, { url: take.url, title: take.title, start: take.start, end: take.end, span: take.span });
          say(`"${clip.text}" would not download — took it from ${String(take.title).slice(0, 40)} instead`);
        }
        break;
      } catch (error) {
        if (index === takes.length - 1) {
          say(`could not cut "${clip.text}" from any of ${takes.length} videos (${String(error.message).split("\n")[0].slice(0, 70)})`, { role: "tool-error" });
        }
      }
    }
    done++;
    job.progress = 0.5 + (0.5 * done) / clips.length;
    job.stage = `Cutting ${done} of ${clips.length}`;
  }

  const cutClips = clips.filter((clip) => clip.path);
  say(`${cutClips.length} clips from ${new Set(cutClips.map((c) => c.url)).size} videos, ${cut.stats.seconds}s of speech`);
  job.stage = "Ready";
  return {
    topic,
    script,
    lang,
    segments: cut.segments.filter((segment) => segment.kind !== "clip" || segment.path),
    missing: cut.missing,
    stats: cut.stats,
  };
}

/* -------------------------------------------------------------- save posts */

async function savePost(payload) {
  const { id, kind, slides = [], caption = "", hashtags = [], meta = {} } = payload;
  const slug = `${new Date().toISOString().slice(0, 10)}-${slugify(id)}`;
  const dir = join(OUT, slug);
  await fs.mkdir(dir, { recursive: true });

  const files = [];
  for (let i = 0; i < slides.length; i++) {
    const dataUrl = slides[i];
    const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, "");
    const name = `${String(i + 1).padStart(2, "0")}.png`;
    await fs.writeFile(join(dir, name), Buffer.from(base64, "base64"));
    files.push(name);
  }

  const text = [caption, "", hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")].join("\n").trim();
  await fs.writeFile(join(dir, "caption.txt"), text + "\n", "utf8");
  await fs.writeFile(join(dir, "post.json"), JSON.stringify({ id: slug, kind, caption, hashtags, files, meta }, null, 2) + "\n", "utf8");

  return { slug, dir, files, url: `/file?p=${encodeURIComponent(dir)}` };
}

async function listOut() {
  let names = [];
  try {
    names = await fs.readdir(OUT);
  } catch {
    return [];
  }
  const items = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const abs = join(OUT, name);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const read = async (file) => {
        try {
          return JSON.parse(await fs.readFile(join(abs, file), "utf8"));
        } catch {
          return null;
        }
      };
      const videos = await listDir(abs, VIDEO_EXT);
      if (videos.length) {
        const project = join(abs, "project.json");
        const hasProject = await fs
          .access(project)
          .then(() => true)
          .catch(() => false);
        items.push({
          kind: "video",
          name,
          at: stat.mtimeMs,
          url: videos[0].url,
          // listDir() thumbnails every video it returns; carrying the poster
          // through is what stops the Output tab being a wall of black cards.
          poster: videos[0].poster,
          path: videos[0].path,
          size: videos[0].size,
          dir: abs,
          project: hasProject ? project : null,
        });
        continue;
      }
      items.push({ kind: "image", name, at: stat.mtimeMs, post: await read("post.json"), images: await listDir(abs, IMAGE_EXT), dir: abs });
    } else if (VIDEO_EXT.has(extname(name).toLowerCase())) {
      // Renders from before projects existed are still flat files.
      items.push({
        kind: "video",
        name,
        at: stat.mtimeMs,
        url: `/file?p=${encodeURIComponent(abs)}`,
        poster: `/thumb?p=${encodeURIComponent(abs)}`,
        path: abs,
        size: stat.size,
        project: null,
      });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

// Deleted, but recoverable. This shelf mixes the user's own drops with the
// repo's real marketing screenshots (social-media-video/shot-*.png), and an
// unlink there would quietly cost the repo an asset. Finder's own delete is
// tried first because only that records an original path for Put Back; a plain
// move into ~/.Trash is the fallback when Finder automation is not permitted.
async function moveToTrash(abs) {
  try {
    await run("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(abs)}`]);
    return { method: "finder", name: basename(abs) };
  } catch {}

  const trash = join(process.env.HOME || "", ".Trash");
  let target = join(trash, basename(abs));
  const ext = extname(abs);
  const stem = basename(abs, ext);
  for (let n = 2; n < 500; n++) {
    try {
      await fs.access(target);
      target = join(trash, `${stem} ${n}${ext}`);
    } catch {
      break;
    }
  }
  try {
    await fs.rename(abs, target);
  } catch (error) {
    // ~/.Trash on another volume: rename cannot cross devices.
    if (error.code !== "EXDEV") throw error;
    await fs.copyFile(abs, target);
    await fs.unlink(abs);
  }
  return { method: "moved", name: basename(target) };
}

/* ------------------------------------------------------------ file serving */

function serveFile(req, res, path) {
  if (!underRoot(path)) return json(res, 403, { error: "path outside the media library" });
  fs.stat(path).then(
    (stat) => {
      if (stat.isDirectory()) return json(res, 400, { error: "is a directory" });
      const type = MIME[extname(path).toLowerCase()] || "application/octet-stream";
      const range = req.headers.range;
      // Chrome will not scrub a <video> without byte ranges, and refuses to load
      // some containers at all when the server ignores the Range header.
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Number(match[2]) : stat.size - 1;
          if (start >= stat.size) {
            res.writeHead(416, { "content-range": `bytes */${stat.size}` });
            return res.end();
          }
          res.writeHead(206, {
            "content-type": type,
            "content-length": end - start + 1,
            "content-range": `bytes ${start}-${end}/${stat.size}`,
            "accept-ranges": "bytes",
          });
          return createReadStream(path, { start, end }).pipe(res);
        }
      }
      res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes" });
      createReadStream(path).pipe(res);
    },
    () => json(res, 404, { error: "not found" }),
  );
}

/* -------------------------------------------------------------------- routes */

async function route(req, res, url) {
  const path = url.pathname;

  if (path === "/health") return json(res, 200, { ok: true, ffmpeg: await ffmpegVersion(), ytdlp: await ytdlpAvailable() });

  if (path === "/library") return json(res, 200, await library());

  if (path === "/voices") return json(res, 200, { voices: await listVoices() });

  if (path === "/thumb") {
    const target = resolve(url.searchParams.get("p") || "");
    if (!target || !underRoot(target)) return json(res, 403, { error: "path outside the media library" });
    return serveFile(req, res, await posterFrame(target, url.searchParams.get("t")));
  }

  if (path === "/voice-preview") {
    const voice = url.searchParams.get("voice") || "";
    const text = (url.searchParams.get("text") || "Fourteen menu bar apps became one.").slice(0, 200);
    const base = join(TMP, `voice-${createHash("sha1").update(`${voice}:${text}`).digest("hex").slice(0, 16)}`);
    const out = `${base}.m4a`;
    try {
      await fs.access(out);
    } catch {
      // `say` writes AIFF, which Chrome will not play; one remux makes it
      // audible in the page without changing what the render uses.
      const aiff = await synthesise(text, voice, `${base}.mp3`);
      await run("ffmpeg", ["-y", "-i", aiff, "-c:a", "aac", "-b:a", "128k", out]);
    }
    return serveFile(req, res, out);
  }

  if (path === "/file") {
    const p = url.searchParams.get("p");
    if (!p) return json(res, 400, { error: "missing p" });
    return serveFile(req, res, resolve(p));
  }

  if (path === "/stock/photos") {
    const query = url.searchParams.get("q") || "";
    if (!query) return json(res, 400, { error: "missing q" });
    const results = await stockPhotos(query, url.searchParams.get("provider") || "", url.searchParams.get("orientation") || "");
    return json(res, 200, { results });
  }

  if (path === "/stock/proxy") {
    const src = url.searchParams.get("url");
    if (!src || !/^https:\/\//.test(src)) return json(res, 400, { error: "missing or non-https url" });
    return proxyImage(res, src);
  }

  if (path === "/copy" && req.method === "POST") {
    const payload = await readJson(req);
    try {
      return json(res, 200, await generateCopy(payload));
    } catch (error) {
      if (error.message === "no-key") return json(res, 428, { error: "no-key" });
      throw error;
    }
  }

  if (path === "/upload" && req.method === "POST") {
    const dir = url.searchParams.get("dir") || "photos";
    const name = basename(url.searchParams.get("name") || `upload-${Date.now()}`);
    if (!["photos", "videos", "music"].includes(dir)) return json(res, 400, { error: "bad dir" });
    const target = join(LIB, dir, name);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, await readBody(req));
    return json(res, 200, { name, path: target, url: `/file?p=${encodeURIComponent(target)}` });
  }

  if (path === "/save-post" && req.method === "POST") {
    return json(res, 200, await savePost(await readJson(req)));
  }

  if (path === "/render-video" && req.method === "POST") {
    const spec = await readJson(req);
    return json(res, 202, { jobId: startJob(spec.id || "video", (job) => renderComposition(spec, job)) });
  }

  if (path === "/footage/search") {
    const query = url.searchParams.get("q") || "";
    if (!query) return json(res, 400, { error: "missing q" });
    const source = url.searchParams.get("source") || "youtube";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 12, 24);
    const results =
      source === "pexels"
        ? await searchPexelsVideos(query, { limit })
        : await searchYouTube(query, { limit, sort: url.searchParams.get("sort") || "views" });
    return json(res, 200, { results });
  }

  if (path === "/gif/search") {
    const query = url.searchParams.get("q") || "";
    if (!query) return json(res, 400, { error: "missing q" });
    const results = await searchGiphy(query, { kind: url.searchParams.get("kind") || "stickers" });
    return json(res, 200, { results });
  }

  if (path === "/gif/fetch" && req.method === "POST") {
    const item = await readJson(req);
    if (!/^https:\/\//.test(item.url || "")) return json(res, 400, { error: "missing or non-https url" });
    return json(res, 202, { jobId: startJob(item.title || "gif", (job) => fetchGif(item, job)) });
  }

  if (path === "/supercut/run" && req.method === "POST") {
    const payload = await readJson(req);
    return json(res, 202, { jobId: startJob("supercut", (job) => runSupercut(payload, job)) });
  }

  if (path === "/auto/run" && req.method === "POST") {
    const payload = await readJson(req);
    if (!payload || !String(payload.url || "").trim()) return json(res, 400, { error: "missing url" });
    return json(res, 202, { jobId: startJob("autopilot", (job) => runAutopilotJob(payload, job)) });
  }

  // Saving a finished post is one click on the page, so the browser is told to
  // save rather than play: a <video> href just opens in a tab otherwise.
  if (path === "/download") {
    const target = resolve(url.searchParams.get("p") || "");
    if (!underRoot(target)) return json(res, 403, { error: "path outside the media library" });
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || stat.isDirectory()) return json(res, 404, { error: "not a file" });
    res.writeHead(200, {
      "content-type": MIME[extname(target).toLowerCase()] || "application/octet-stream",
      "content-length": stat.size,
      "content-disposition": `attachment; filename="${basename(target).replace(/"/g, "")}"`,
    });
    return createReadStream(target).pipe(res);
  }

  // A carousel is six files; zipping is the difference between one click and
  // six. `ditto` is macOS's own archiver, so no dependency and no `zip` quirks.
  if (path === "/zip") {
    const target = resolve(url.searchParams.get("p") || "");
    if (!target.startsWith(OUT + sep)) return json(res, 403, { error: "only rendered output can be zipped" });
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) return json(res, 404, { error: "not a folder" });
    await fs.mkdir(join(TMP, "zips"), { recursive: true });
    const archive = join(TMP, "zips", `${basename(target)}.zip`);
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", target, archive]);
    const zipped = await fs.stat(archive);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": zipped.size,
      "content-disposition": `attachment; filename="${basename(target)}.zip"`,
    });
    return createReadStream(archive).pipe(res);
  }

  if (path === "/ai/run" && req.method === "POST") {
    const payload = await readJson(req);
    return json(res, 202, { jobId: startJob("ai-mode", (job) => runAiMode(payload, job)) });
  }

  if (path === "/voiceover" && req.method === "POST") {
    const payload = await readJson(req);
    return json(res, 202, { jobId: startJob(payload.name || "voiceover", (job) => makeVoiceover(payload, job)) });
  }

  if (path === "/footage/suggest" && req.method === "POST") {
    const { prompt } = await readJson(req);
    return json(res, 200, { queries: await suggestQueries(prompt) });
  }

  if (path === "/footage/fetch" && req.method === "POST") {
    const item = await readJson(req);
    if (!item || !/^https:\/\//.test(item.url || "")) return json(res, 400, { error: "missing or non-https url" });
    return json(res, 202, { jobId: startJob(item.title || "clip", (job) => fetchFootage(item, job)) });
  }

  if (path.startsWith("/jobs/")) {
    const job = jobs.get(path.slice("/jobs/".length));
    if (!job) return json(res, 404, { error: "no such job" });
    return json(res, 200, job);
  }

  if (path === "/out") return json(res, 200, { items: await listOut() });

  if (path === "/out/delete" && req.method === "POST") {
    const { path: target } = await readJson(req);
    const abs = resolve(target || "");
    // Deliberately stricter than underRoot(): this route destroys things, so it
    // will only ever touch something inside the output folder, and never the
    // output folder itself.
    if (!abs.startsWith(OUT + sep) || abs === OUT) return json(res, 403, { error: "only rendered output can be deleted" });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return json(res, 404, { error: "already gone" });
    await fs.rm(abs, { recursive: stat.isDirectory(), force: false });
    // A flat render from before projects existed keeps its caption beside it.
    if (stat.isFile()) await fs.rm(abs.replace(/\.\w+$/, ".txt"), { force: true });
    return json(res, 200, { ok: true, deleted: basename(abs) });
  }

  if (path === "/library/trash" && req.method === "POST") {
    const { path: target } = await readJson(req);
    const abs = resolve(target || "");
    if (!underRoot(abs)) return json(res, 403, { error: "path outside the media library" });
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) return json(res, 404, { error: "not a file" });
    return json(res, 200, { ok: true, ...(await moveToTrash(abs)) });
  }

  if (path === "/reveal" && req.method === "POST") {
    const { path: target } = await readJson(req);
    if (!underRoot(target)) return json(res, 403, { error: "path outside the media library" });
    await run("open", ["-R", target]);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: `no route for ${path}` });
}

const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  route(req, res, url).catch((error) => {
    console.error(`${req.method} ${url.pathname}:`, error);
    if (!res.headersSent) json(res, 500, { error: String(error.message || error) });
    else res.end();
  });
});

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(TMP, { recursive: true });
for (const dir of ["photos", "videos", "music", "voice", "gifs"]) await fs.mkdir(join(LIB, dir), { recursive: true });

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mac Kit Studio server → http://127.0.0.1:${PORT}`);
  console.log(`  copy         : ${COPY_PROVIDER === "none" ? "no key (offline templates will be used)" : `${COPY_PROVIDER} · ${COPY_PROVIDER === "deepseek" ? DEEPSEEK_MODEL : MODEL}`}`);
  console.log(`  Pexels       : ${PEXELS_KEY ? "ready" : "no key (Wikimedia Commons fallback)"}`);
  console.log(`  voice        : ${GEMINI_KEY ? `Gemini · ${GEMINI_TTS_MODEL}` : ELEVEN_KEY ? "ElevenLabs" : "macOS `say`"}`);
  console.log(`  transcripts  : yt-dlp${SERPAPI_KEY ? (USE_SERPAPI ? " + SerpApi fallback (paid)" : " (SerpApi key present but off)") : ""}`);
  console.log(`  Giphy        : ${GIPHY_KEY ? "ready" : "no key (GIF search disabled)"}`);
  console.log(`  library      : ${relative(SITE, LIB)}`);
});
