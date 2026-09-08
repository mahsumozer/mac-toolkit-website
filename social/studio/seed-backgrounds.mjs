#!/usr/bin/env node
// Fills studio/library/videos/ with the background loops the video formats need.
// Usage:
//   node social/studio/seed-backgrounds.mjs              # every slot that is still missing
//   node social/studio/seed-backgrounds.mjs --list       # show the slots and what is already there
//   node social/studio/seed-backgrounds.mjs --bank mundane  # one bank
//   node social/studio/seed-backgrounds.mjs --only sand     # one slot
//   node social/studio/seed-backgrounds.mjs --force      # re-fetch even if the file exists
//
// `split-brainrot`, `pip-reaction` and `three-up` all composite the app
// recording over a second clip, so with an empty library those three formats
// cannot be previewed at all, let alone rendered. This is the one-off that
// gives them something real to sit on.
//
// Every clip is cut down before it lands: a 45-second section is pulled out of
// the middle of the source (the opening seconds are almost always an intro
// card), centre-cropped to 9:16, scaled to the composition's own 1080x1920 and
// stripped of audio. A background layer is never heard — music and voiceover
// come from elsewhere in the studio — and dropping the track is what keeps
// these files at a few megabytes instead of a few hundred.
//
// Provenance goes to library/videos/sources.json. These are YouTube uploads
// that describe themselves as free to reuse, which is the uploader's claim and
// not a verified licence, so the sidecar records where each one came from and
// a clip can be traced or pulled later.

import { spawn } from "node:child_process";
import { readdirSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIDEOS = join(HERE, "library", "videos");
const TMP = join(HERE, "tmp", "seed");
const SOURCES = join(VIDEOS, "sources.json");

// Section pulled from the source, and what survives into the library.
const CUT_FROM = 60;      // seconds — past the intro on essentially every upload
const CUT_LENGTH = 45;    // seconds fetched, so ffmpeg has room around keyframes
const CLIP_LENGTH = 35;   // seconds kept

// Two banks, and the difference between them is the whole point.
//
// `gameplay` is the 2023 bed: Subway Surfers, a hydraulic press, kinetic sand.
// It still renders, and split-brainrot still wants it, but it now reads as
// stock — every faceless account on the platform is using the same six loops.
//
// `mundane` is what the feed actually rewards in 2026. Look at any trending
// grid and the winning shot is not spectacular, it is *oddly specific and
// unstaged*: a bedside clock reading 5:01, a train window, rain on glass, a
// desk nobody tidied. The text carries the post — long, confessional, and
// often deliberately unrelated to what is on screen. The shot's job is to feel
// like someone's actual camera roll, which is exactly what a polished stock
// clip cannot do, so these searches ask for phone footage and POV rather than
// "4k cinematic".
const SLOTS = [
  { bank: "gameplay", slot: "subway", query: "subway surfers gameplay no copyright vertical", note: "the default brainrot bed" },
  { bank: "gameplay", slot: "parkour", query: "minecraft parkour gameplay no copyright vertical", note: "second gameplay bed, different palette" },
  { bank: "gameplay", slot: "soap", query: "satisfying soap cutting asmr no copyright", note: "close, high-contrast, reads at any size" },
  { bank: "gameplay", slot: "sand", query: "kinetic sand cutting satisfying no copyright", note: "slower than the gameplay beds" },
  { bank: "gameplay", slot: "press", query: "hydraulic press satisfying compilation no copyright", note: "hard cuts, good under a punchy hook" },
  { bank: "gameplay", slot: "drone", query: "drone forest flyover 4k no copyright", note: "calm bed for the non-meme formats" },

  { bank: "mundane", slot: "clock", query: "bedside alarm clock early morning dark room footage", note: "a time on screen — carries a question about mornings" },
  { bank: "mundane", slot: "nightwalk", query: "pov walking city street at night phone footage", note: "motion without spectacle, the confessional default" },
  { bank: "mundane", slot: "trainwindow", query: "train window seat view moving pov footage", note: "the thinking-on-the-way-home shot" },
  { bank: "mundane", slot: "rainglass", query: "rain on window closeup ambient footage", note: "soft, low contrast, text sits cleanly on it" },
  { bank: "mundane", slot: "deskmess", query: "messy desk cluttered workspace room tour footage", note: "the before shot for anything about focus" },
  { bank: "mundane", slot: "typing", query: "hands typing keyboard closeup desk footage", note: "closest to the product without being a demo" },
];

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
      if (err.length > 40000) err = err.slice(-20000);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${err.slice(-1200)}`))));
  });
}

// yt-dlp's flat search gives one JSON object per line. Anything shorter than
// two minutes cannot be cut at CUT_FROM, and anything past an hour tends to be
// a stream recording whose middle is a static screen.
async function pick(query) {
  const out = await run("yt-dlp", ["--flat-playlist", "--dump-json", "--no-warnings", `ytsearch20:${query}`]);
  const candidates = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.id && entry.duration >= 120 && entry.duration <= 3600 && !entry.is_live)
    .sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
  return candidates[0] || null;
}

const stamp = (seconds) => new Date(seconds * 1000).toISOString().slice(11, 19);

async function fetchSection(entry, slot) {
  rmSync(join(TMP, slot), { recursive: true, force: true });
  mkdirSync(join(TMP, slot), { recursive: true });
  await run("yt-dlp", [
    "-f", "bv*[height<=1080]/b[height<=1080]/b",
    "--download-sections", `*${stamp(CUT_FROM)}-${stamp(CUT_FROM + CUT_LENGTH)}`,
    "--force-keyframes-at-cuts",
    "--no-playlist",
    "--no-warnings",
    "-o", join(TMP, slot, "raw.%(ext)s"),
    `https://www.youtube.com/watch?v=${entry.id}`,
  ]);
  const files = readdirSync(join(TMP, slot));
  if (!files.length) throw new Error("yt-dlp wrote nothing");
  return join(TMP, slot, files[0]);
}

// Centre-crop to 9:16 whatever the source aspect is, then scale to the
// composition size. `min(iw, ih*9/16)` is the widest 9:16 slice that fits, and
// the 2*floor() keeps both sides even, which h264 requires.
async function normalise(raw, target) {
  const scratch = `${target}.part.mp4`;
  await run("ffmpeg", [
    "-y", "-i", raw,
    "-t", String(CLIP_LENGTH),
    "-vf", "crop='2*floor(min(iw,ih*9/16)/2)':'2*floor(min(ih,iw*16/9)/2)',scale=1080:1920,fps=30",
    "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    scratch,
  ]);
  renameSync(scratch, target);
}

function readSources() {
  if (!existsSync(SOURCES)) return {};
  try {
    return JSON.parse(readFileSync(SOURCES, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  mkdirSync(VIDEOS, { recursive: true });
  const only = value("--only");
  const bank = value("--bank");
  let wanted = SLOTS;
  if (bank) wanted = wanted.filter((s) => s.bank === bank);
  if (only) wanted = wanted.filter((s) => s.slot === only);
  if (!wanted.length) {
    console.error(`Nothing matched. Slots: ${SLOTS.map((s) => s.slot).join(", ")}. Banks: gameplay, mundane.`);
    process.exit(1);
  }

  if (has("--list")) {
    for (const { bank, slot, query, note } of SLOTS) {
      const path = join(VIDEOS, `bg-${slot}.mp4`);
      console.log(`${existsSync(path) ? "have" : "    "}  ${bank.padEnd(8)} bg-${slot}.mp4  ${note}\n        ${query}`);
    }
    return;
  }

  const sources = readSources();
  let added = 0;

  for (const { bank, slot, query, note } of wanted) {
    const target = join(VIDEOS, `bg-${slot}.mp4`);
    if (existsSync(target) && !has("--force")) {
      console.log(`skip  bg-${slot}.mp4 — already in the library`);
      continue;
    }
    try {
      process.stdout.write(`search  ${slot} …`);
      const entry = await pick(query);
      if (!entry) throw new Error("no candidate matched the duration filter");
      process.stdout.write(` ${entry.title.slice(0, 58)}\n`);

      process.stdout.write(`fetch   ${slot} …`);
      const raw = await fetchSection(entry, slot);
      process.stdout.write(" cutting …");
      await normalise(raw, target);
      rmSync(join(TMP, slot), { recursive: true, force: true });
      process.stdout.write(" done\n");

      sources[`bg-${slot}.mp4`] = {
        bank,
        note,
        query,
        title: entry.title,
        channel: entry.channel || entry.uploader || "",
        url: `https://www.youtube.com/watch?v=${entry.id}`,
        section: `${stamp(CUT_FROM)}–${stamp(CUT_FROM + CLIP_LENGTH)}`,
        fetched: new Date().toISOString().slice(0, 10),
        licence: "uploader states no-copyright / free to use — not verified",
      };
      writeFileSync(SOURCES, `${JSON.stringify(sources, null, 2)}\n`);
      added += 1;
    } catch (error) {
      process.stdout.write("\n");
      console.error(`fail  ${slot}: ${error.message.split("\n")[0]}`);
    }
  }

  rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${added} clip${added === 1 ? "" : "s"} added. Library: ${readdirSync(VIDEOS).filter((f) => f.endsWith(".mp4")).length} videos.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
