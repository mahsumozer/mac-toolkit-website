// Blitz — the page half.
//
// The server hunts, reads and adapts (studio/blitz.mjs, /blitz/*). This lays
// the answer out the way it will be watched: what it was taken from on the
// left, ours on the right, at the same size and running at the same time.
//
// The right-hand phone is the real editor canvas, not a mock-up of one — the
// same Editor the Studio and Supercut use, so the text sits exactly where it
// will sit in the file, and the render goes out through the same
// /render-video everything else does.

import { newLayer, textLayer, audioLayer, COMP_W, COMP_H, COMP_SIZE } from "./studio/composition.js";
import { Editor } from "./studio/editor.js";
import { freezeComposition } from "./studio/freeze.js";
import { measureTextLayer, ensureFonts } from "./studio/render-image.js";

const API = (window.SOCIAL_CONFIG && window.SOCIAL_CONFIG.studioApiBase) || "http://127.0.0.1:8789";
const $ = (sel) => document.querySelector(sel);

const STORE = "mackit.blitz.hunt";

function toast(message) {
  const region = $("#toast-region");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  region.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 260);
  }, 4200);
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text.slice(0, 300));
  }
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function pollJob(jobId, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      let job;
      try {
        job = await api(`/jobs/${jobId}`);
      } catch {
        return;
      }
      onProgress(job);
      if (job.status === "done") {
        clearInterval(timer);
        resolve(job.result);
      } else if (job.status === "error") {
        clearInterval(timer);
        reject(new Error(job.error || "failed"));
      }
    }, 700);
  });
}

const fileUrl = (path) => `${API}/file?p=${encodeURIComponent(path)}`;
const downloadUrl = (path) => `${API}/download?p=${encodeURIComponent(path)}`;

// Titles, captions and model answers all reach the page as somebody else's
// text; anything that lands in innerHTML rather than textContent goes through
// here first.
const escape = (text) => String(text ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

const compact = (n) => {
  const value = Number(n) || 0;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`;
  return String(value);
};

const state = {
  editor: null,
  brand: null,
  music: null,
  library: [],
  beds: [],
  items: [],
  picked: null,
  read: null,
  ours: null,
  bed: null,
  duration: 0,
  busy: false,
};

/* ------------------------------------------------------------------- hunt */

function note(text) {
  if (!text) return;
  $("#blitz-feed").hidden = false;
  const el = document.createElement("div");
  el.textContent = text;
  $("#blitz-feed").appendChild(el);
}

async function hunt(event) {
  event.preventDefault();
  if (state.busy) return;

  const url = $("#blitz-url").value.trim();
  const queries = $("#blitz-queries").value.split(/[,\n]/).map((q) => q.trim()).filter(Boolean);
  const accounts = $("#blitz-handles").value.split(/[,\n\s]/).map((h) => h.trim()).filter(Boolean);
  if (!url && !queries.length && !accounts.length) return toast("Give it a product's address, a phrase, or an account");

  localStorage.setItem(
    STORE,
    JSON.stringify({ url, queries: $("#blitz-queries").value, handles: $("#blitz-handles").value }),
  );

  state.busy = true;
  $("#blitz-go").disabled = true;
  $("#blitz-feed").innerHTML = "";
  $("#blitz-feed").hidden = false;
  // The job keeps one ordered list of everything it has said, and the feed is
  // a window onto it. Reading `job.stage` instead put the site's own lines —
  // which never become a stage — after the searches they came before.
  let shown = 0;

  try {
    const { jobId } = await post("/blitz/hunt", {
      url,
      queries,
      accounts,
      perSource: Number($("#blitz-per").value),
      maxDuration: Number($("#blitz-length").value),
      fresh: $("#blitz-fresh").checked,
    });
    const result = await pollJob(jobId, (job) => {
      const notes = job.notes || [];
      for (; shown < notes.length; shown += 1) note(notes[shown]);
    });

    // Whatever the last poll missed between it and the job finishing.
    (result.notes || []).slice(shown).forEach(note);
    state.items = result.items || [];
    // The fact sheet the site produced. Everything written from here on draws
    // on it and on nothing else, which is what stops a post inventing a feature.
    state.brand = result.brand || null;
    if (!state.items.length) return toast("Nothing came back — try a broader phrase, or a longer maximum");
    renderDeck(result.cached);
  } catch (error) {
    note(`failed: ${error.message}`);
    toast(`Hunt failed: ${error.message}`);
  } finally {
    state.busy = false;
    $("#blitz-go").disabled = false;
  }
}

function renderDeck(cached) {
  $("#blitz-deck").hidden = false;
  $("#blitz-deck-note").textContent = [
    `${state.items.length} under ${$("#blitz-length").value}s`,
    "sorted by views a day",
    state.brand ? `to remix for ${state.brand.name}` : "",
    cached ? "from the cache" : "",
  ]
    .filter(Boolean)
    .join(" · ");

  // One column per source. The two are ranked on the same number but are not
  // the same pool — a TikTok profile and a YouTube search return different
  // things — and side by side they can be compared instead of interleaved.
  for (const source of ["tiktok", "youtube"]) {
    const cards = $(`#blitz-cards-${source}`);
    cards.innerHTML = "";
    const mine = state.items.filter((item) => item.source === source);
    $(`#blitz-count-${source}`).textContent = mine.length ? `${mine.length}` : "";
    if (!mine.length) {
      const empty = document.createElement("p");
      empty.className = "blitz-column-empty";
      empty.textContent = source === "tiktok" ? "Nothing here — the phrase turned up no TikToks, and no account was given." : "Nothing here — no phrase matched, and no channel was given.";
      cards.appendChild(empty);
      continue;
    }
    for (const item of mine) cards.appendChild(card(item));
  }
}

function card(item) {
  const wrap = document.createElement("div");
  wrap.className = "blitz-cardbtn";
  wrap.dataset.id = item.id;

  const chips = [
    `<span class="blitz-chip is-hot">${compact(item.velocity)}/day</span>`,
    `<span class="blitz-chip">${compact(item.views)} views</span>`,
    item.likes ? `<span class="blitz-chip">${compact(item.likes)} likes</span>` : "",
    `<span class="blitz-chip${item.source === "tiktok" ? " is-tiktok" : ""}">${item.source === "tiktok" ? "TikTok" : "Shorts"}</span>`,
    `<span class="blitz-chip">${Math.round(item.duration)}s</span>`,
  ].join("");

  wrap.innerHTML = `
    <div class="blitz-cardmedia">
      <img src="${escape(item.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" />
      <video playsinline loop muted preload="none"></video>
      <div class="blitz-cardctl">
        <button type="button" class="blitz-card-sound" title="Sound" aria-label="Sound">${ICON.sound}</button>
        <button type="button" class="blitz-card-big" title="Enlarge" aria-label="Enlarge">${ICON.big}</button>
        <a href="${escape(item.url)}" target="_blank" rel="noreferrer" title="Open on the site" aria-label="Open on the site">${ICON.open}</a>
      </div>
    </div>
    <div class="blitz-cardbtn-body">
      <p class="blitz-cardbtn-title"></p>
      <div class="blitz-chips">${chips}</div>
      <button type="button" class="button button-dark button-small blitz-cardbtn-remix">Remix this</button>
    </div>`;
  // The title is somebody else's text: it goes in as text, never as markup.
  wrap.querySelector(".blitz-cardbtn-title").textContent = item.title || item.author;

  const media = wrap.querySelector(".blitz-cardmedia");
  const video = wrap.querySelector("video");

  // Hovering plays, leaving stops. The clip is fetched on the first hover and
  // kept — the same file the read uses, so a video looked at here is already
  // on disk when it is picked.
  media.addEventListener("mouseenter", () => playPreview(item, media, video));
  media.addEventListener("mouseleave", () => stopPreview(media, video));
  media.addEventListener("click", () => enlarge(item));

  wrap.querySelector(".blitz-card-sound").addEventListener("click", (event) => {
    event.stopPropagation();
    video.muted = !video.muted;
    event.currentTarget.classList.toggle("is-on", !video.muted);
    if (!media.classList.contains("is-playing")) playPreview(item, media, video);
  });
  wrap.querySelector(".blitz-card-big").addEventListener("click", (event) => {
    event.stopPropagation();
    enlarge(item);
  });
  wrap.querySelector(".blitz-cardbtn-remix").addEventListener("click", () => pick(item));
  return wrap;
}

const ICON = {
  sound: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
  big: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  open: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>',
};

// One clip download per item, shared by every hover and by the enlarge.
const clips = new Map();
function clipFor(item) {
  if (!clips.has(item.id)) {
    clips.set(
      item.id,
      post("/blitz/clip", { item })
        .then(({ jobId }) => pollJob(jobId, () => {}))
        .then((clip) => `${API}${clip.videoUrl}`)
        .catch((error) => {
          clips.delete(item.id);
          throw error;
        }),
    );
  }
  return clips.get(item.id);
}

async function playPreview(item, media, video) {
  media.dataset.wanted = "1";
  if (!video.src) {
    media.classList.add("is-loading");
    try {
      video.src = await clipFor(item);
    } catch (error) {
      media.classList.remove("is-loading");
      toast(`Could not fetch that clip: ${error.message}`);
      return;
    }
    media.classList.remove("is-loading");
  }
  // The pointer may have left while the download ran.
  if (media.dataset.wanted !== "1") return;
  media.classList.add("is-playing");
  video.play().catch(() => {});
}

function stopPreview(media, video) {
  media.dataset.wanted = "0";
  media.classList.remove("is-playing");
  video.pause();
}

/* ----------------------------------------------------------------- enlarge */

let enlarged = null;

async function enlarge(item) {
  enlarged = item;
  const box = $("#blitz-lightbox");
  const video = $("#blitz-lightbox-video");
  box.hidden = false;
  $("#blitz-lightbox-title").textContent = item.title || item.author;
  $("#blitz-lightbox-open").href = item.url;
  $("#blitz-lightbox-chips").innerHTML = [
    `<span class="blitz-chip is-hot">${compact(item.velocity)} views a day</span>`,
    `<span class="blitz-chip">${compact(item.views)} views</span>`,
    item.likes ? `<span class="blitz-chip">${compact(item.likes)} likes</span>` : "",
    `<span class="blitz-chip">${item.ageDays}d old</span>`,
    `<span class="blitz-chip">${item.source === "tiktok" ? "TikTok" : "YouTube"}</span>`,
  ].join("");
  video.removeAttribute("src");
  video.poster = item.thumb || "";
  video.load();
  try {
    video.src = await clipFor(item);
    if (enlarged === item) video.play().catch(() => {});
  } catch (error) {
    toast(`Could not fetch that clip: ${error.message}`);
  }
}

function closeLightbox() {
  enlarged = null;
  $("#blitz-lightbox").hidden = true;
  const video = $("#blitz-lightbox-video");
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/* -------------------------------------------------------------------- pick */

async function pick(item) {
  if (state.busy) return;
  state.busy = true;
  state.picked = item;

  document.querySelectorAll(".blitz-cardbtn").forEach((card) => card.classList.toggle("is-picked", card.dataset.id === item.id));
  $("#blitz-stage").hidden = false;
  $("#blitz-result").hidden = true;
  $("#blitz-read").hidden = true;
  // The source has to be downloaded before it can play, which is half a minute
  // of an empty black box otherwise. Its own thumbnail stands in until then.
  const video = $("#blitz-source-video");
  video.removeAttribute("src");
  video.load();
  video.poster = item.thumb || "";
  $("#blitz-source-download").hidden = true;
  $("#blitz-source-title").textContent = item.title || "";
  $("#blitz-source-link").textContent = `${item.author} ↗`;
  $("#blitz-source-link").href = item.authorUrl || item.url;
  $("#blitz-metric-likes").querySelector("b").textContent = item.likes ? compact(item.likes) : "—";
  $("#blitz-metric-views").querySelector("b").textContent = compact(item.views);
  $("#blitz-source-chips").innerHTML = [
    `<span class="blitz-chip is-hot">${compact(item.velocity)} views a day</span>`,
    `<span class="blitz-chip">${item.ageDays}d old</span>`,
    item.shape.format ? `<span class="blitz-chip">${item.shape.format}</span>` : "",
    `<span class="blitz-chip">${item.source === "tiktok" ? "TikTok" : "YouTube"}</span>`,
  ].join("");
  $("#blitz-stage").scrollIntoView({ behavior: "smooth", block: "start" });

  progress(0.05, "Reading the source");
  try {
    const { jobId } = await post("/blitz/read", { item });
    const read = await pollJob(jobId, (job) => progress(Math.max(0.08, job.progress || 0) * 0.6, job.stage || job.status));
    state.read = read;

    video.src = `${API}${read.videoUrl}`;
    video.play().catch(() => {});
    // The file is already on disk for the read; this is the same file, saved.
    $("#blitz-source-download").href = downloadUrl(read.path);
    $("#blitz-source-download").hidden = false;

    $("#blitz-read").hidden = false;
    const spoken = !read.onScreen && read.speech && read.speech.lines && read.speech.lines.length;
    $("#blitz-read").querySelector("summary").textContent = read.onScreen ? "What it says on screen" : spoken ? "What is said — nothing is written on the picture" : "What it says on screen";
    $("#blitz-read-wall").textContent = read.onScreen
      ? read.wall
      : spoken
        ? read.speech.lines.join("\n")
        : "Nothing written on the picture and no captions to read — its title is the only shape on offer.";
    $("#blitz-read-note").textContent = read.onScreen ? read.note || "" : spoken ? `${read.speech.original ? "Original" : "Translated"} captions · the shape is borrowed from how it is said` : "";

    await adapt();
  } catch (error) {
    progress(0, error.message);
    toast(`Could not read that one: ${error.message}`);
  } finally {
    state.busy = false;
  }
}

/* ------------------------------------------------------------------ adapt */

async function adapt({ keepFootage = false } = {}) {
  if (!state.picked || !state.read) return;
  progress(0.65, "Writing ours in the same shape");

  const ours = await post("/blitz/adapt", { item: state.picked, read: state.read, brand: state.brand });
  state.ours = ours;

  $("#blitz-pill-shape").textContent = shapeLabel();
  $("#blitz-pill-angle").textContent = ours.angle;
  $("#blitz-text").value = ours.wall;
  renderWhy();

  // A second draft is a second set of words, not a second download: the clip
  // behind them was already fetched and is just as good under the new ones.
  if (keepFootage && state.bed) {
    build();
    progress(1, "Rewritten");
    setTimeout(() => ($("#blitz-progress").hidden = true), 1200);
    return;
  }
  await dress();
}

// The left pill names the shape that was borrowed, in the words the classifier
// already uses, so it can be checked against the video sitting beside it.
function shapeLabel() {
  const format = state.picked.shape.format;
  const lines = (state.read.lines || []).length;
  if (format) return `${format.replace(/-/g, " ")} · ${lines || 1} beat${lines === 1 ? "" : "s"}`;
  if (state.read.onScreen) return `wall of text · ${lines || 1} line${lines === 1 ? "" : "s"}`;
  return state.read.speech && state.read.speech.lines && state.read.speech.lines.length ? "spoken hook" : "title only";
}

// Composed here rather than asked for, because the numbers in it are facts the
// hunt already measured and a model asked to justify itself will invent them.
function renderWhy() {
  const item = state.picked;
  const list = $("#blitz-why-list");
  const bullets = [
    `<b>${Number(item.velocity).toLocaleString("en-US")}</b> views a day — not ${compact(item.views)} in total, because a slow million is not a trend.`,
    item.likes ? `<b>${(item.engagement * 100).toFixed(1)}%</b> of the people who saw it liked it, ${item.ageDays} days after it went up.` : `Posted ${item.ageDays} days ago.`,
    state.read.onScreen
      ? `The words were read off the picture, not off the title — in this format the caption block is the video.`
      : state.read.speech && state.read.speech.lines && state.read.speech.lines.length
        ? `Nothing was written on the picture, so the shape was read off what is <em>said</em> — the spoken opener, where it turns, how it ends.`
        : `Nothing was written on the picture and it has no captions, so its title was the only shape on offer.`,
    state.ours.borrowed ? `Borrowed: ${escape(state.ours.borrowed)}.` : `Borrowed: the shape only.`,
    `Not borrowed: the subject, the sentence and every frame — the clip behind our words is our own.`,
    state.brand
      ? `Every claim in the text comes off <b>${escape(state.brand.name)}</b>'s own site, so nothing here can be a feature it does not have.`
      : `Every claim in the text comes from <code>formats.json → painFixes</code>, so nothing here can be a feature Mac Kit does not have.`,
  ];
  list.innerHTML = bullets.map((line) => `<li>${line}</li>`).join("");
}

/* ------------------------------------------------------------- the footage */

// A YouTube clip under the words was the wrong default: a tutorial cropped
// to portrait, with its own captions fighting ours, or a black frame. The
// library's own portrait backgrounds and the app's own recordings are what a
// bed is — so one of those goes on first, and the search is there for when
// none of them fits.
async function dress() {
  $("#blitz-footage-q").value = state.ours.footageQuery;
  const beds = state.beds.filter((bed) => bed.duration >= wantedDuration());
  if (beds.length) {
    progress(0.8, "Putting one of our own clips behind it");
    renderFootage(beds);
    // Any of them, not always the first: the same background under every
    // post is the tell that a feed was made by a script.
    await useFootage(beds[Math.floor(Math.random() * beds.length)]);
    return;
  }
  progress(0.75, "Finding something to put behind it");
  const results = await searchFootage(state.ours.footageQuery);
  if (!results.length) {
    progress(0, "No footage came back — search for something else under the phone");
    $("#blitz-footage").hidden = false;
    return;
  }
  await useFootage(results[0]);
}

async function searchFootage(query) {
  const target = wantedDuration();
  const { results } = await api(`/footage/search?q=${encodeURIComponent(query)}&source=youtube&limit=12&sort=views`);
  // A bed has to be at least as long as the post, with a few seconds spare so
  // the cut can start after whatever intro the clip opens on.
  const usable = (results || []).filter((clip) => clip.duration >= target + 6);
  renderFootage(usable.length ? usable : results || []);
  return usable.length ? usable : results || [];
}

function renderFootage(results) {
  const strip = $("#blitz-footage-strip");
  strip.innerHTML = "";
  const own = state.beds.filter((bed) => bed.duration >= wantedDuration() && !results.includes(bed));
  for (const clip of [...own, ...results].slice(0, 16)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "blitz-shot";
    button.innerHTML = `<img src="${escape(clip.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span></span>`;
    button.querySelector("span").textContent = clip.channel || clip.title;
    button.addEventListener("click", () => useFootage(clip).catch((error) => toast(error.message)));
    strip.appendChild(button);
  }
}

async function useFootage(clip) {
  const target = wantedDuration();
  if (clip.library) {
    state.bed = { name: clip.name, path: clip.path, duration: clip.duration };
    build();
    progress(1, "Ready — press play");
    setTimeout(() => ($("#blitz-progress").hidden = true), 1200);
    return;
  }
  progress(0.8, `Downloading ${clip.channel || "the bed"}`);
  // Only the seconds that end up on screen are downloaded. A minute of 1080p
  // to use eighteen of them is the difference between a run that takes six
  // seconds and one that takes ninety.
  const start = clip.duration > target + 12 ? 8 : 0;
  const { jobId } = await post("/footage/fetch", {
    ...clip,
    query: state.ours.footageQuery,
    section: `${start}-${Math.round(start + target + 2)}`,
  });
  const bed = await pollJob(jobId, (job) => progress(0.8 + (job.progress || 0) * 0.15, job.stage || "Downloading"));
  state.bed = bed;
  build();
  progress(1, "Ready — press play");
  setTimeout(() => ($("#blitz-progress").hidden = true), 1200);
}

/* --------------------------------------------------------- the composition */

const wantedDuration = () => Math.min(Math.max(Math.round(state.read?.duration || 12), 8), 22);

// A block this long has to be sized to fit rather than set to a number: the
// same 68px that suits a six-word hook runs a forty-word wall off the bottom
// of the frame.
function fitFontSize(text) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const width = COMP_W - 150;
  // A two-word line at the size that suits forty words is a caption nobody
  // sees; the ceiling rises as the text gets shorter, and the floor is where
  // a phone can still read it.
  const words = text.split(/\s+/).filter(Boolean).length;
  const ceiling = words <= 4 ? 118 : words <= 12 ? 92 : 76;
  for (let size = ceiling; size >= 44; size -= 2) {
    const height = measureTextLayer(ctx, { text, fontSize: size, w: width });
    if (height <= COMP_H * 0.5) return { size, height, width };
  }
  return { size: 44, height: measureTextLayer(ctx, { text, fontSize: 44, w: width }), width };
}

function build() {
  if (!state.bed || !state.ours) return;
  const duration = wantedDuration();
  const text = $("#blitz-text").value.trim() || state.ours.wall;
  const { size, height, width } = fitFontSize(text);

  const layers = [
    newLayer({
      type: "video",
      name: state.bed.name,
      path: state.bed.path,
      src: fileUrl(state.bed.path),
      x: 0,
      y: 0,
      w: COMP_W,
      h: COMP_H,
      fit: "cover",
      start: 0,
      end: duration,
      trim: 0,
      // The source's own audio is somebody else's room tone under our words.
      volume: 0,
    }),
    textLayer(text, {
      style: "outline",
      fontSize: size,
      x: 75,
      w: width,
      // Sat a little above the middle, where this format always puts it: below
      // the app's own header, above the caption and the buttons.
      y: Math.round(COMP_H * 0.42 - height / 2),
      h: height,
      start: 0,
      end: duration,
    }),
  ];

  // The music is a layer rather than a render-time setting, so the preview
  // plays what the file will carry and there is one description of the post.
  if (state.music) {
    layers.push(
      audioLayer(
        { name: state.music.name, path: state.music.path, src: fileUrl(state.music.path), duration: state.music.duration },
        { start: 0, end: duration, volume: Number($("#blitz-musicvol").value) },
      ),
    );
  }

  state.duration = duration;
  state.editor.setComposition({ duration, layers });
  state.editor.select(null);
  state.editor.seek(0);
  $("#blitz-phone-empty").hidden = true;
}

/* ------------------------------------------------------------------- music */

// What "silly" is searched as. Openverse indexes by title and tag, so these are
// the words people actually put on a goofy track, not moods.
const SILLY = ["funny", "comedy", "circus", "polka", "kazoo", "cartoon", "ukulele", "chiptune", "banjo", "silly", "whistle", "accordion"];

function fillMusic() {
  const select = $("#blitz-music");
  select.innerHTML = `<option value="">None</option>`;
  for (const track of state.library) select.appendChild(new Option(track.name, track.path));
  if (state.music) select.value = state.music.path;
}

function useMusic(track) {
  state.music = track;
  fillMusic();
  $("#blitz-music-credit").hidden = !track || !track.credit;
  $("#blitz-music-credit").textContent = track && track.credit ? track.credit : "";
  if (state.bed) build();
}

async function somethingSilly() {
  const button = $("#blitz-music-silly");
  button.disabled = true;
  try {
    const query = SILLY[Math.floor(Math.random() * SILLY.length)];
    progress(0.2, `Looking for something ${query}`);
    const { results } = await api(`/music/search?q=${encodeURIComponent(query)}&limit=12`);
    // Long enough to cover the post, and any one of them — the point is that
    // it is not the same track as last time.
    const usable = (results || []).filter((track) => track.duration >= wantedDuration() + 2);
    if (!usable.length) throw new Error(`nothing ${query} on Openverse today — try again`);
    const pick = usable[Math.floor(Math.random() * Math.min(usable.length, 6))];
    progress(0.5, `Fetching “${pick.title}” by ${pick.creator || "someone"}`);
    const { jobId } = await post("/music/fetch", pick);
    const file = await pollJob(jobId, (job) => progress(0.5 + (job.progress || 0) * 0.4, job.stage || "Downloading"));
    const track = {
      name: file.name,
      path: file.path,
      duration: file.duration || pick.duration,
      credit: `♪ ${pick.title} — ${pick.creator || "unknown"} (CC ${String(pick.license || "").toUpperCase()}, via Openverse)`,
    };
    state.library = [track, ...state.library.filter((t) => t.path !== track.path)];
    useMusic(track);
    progress(1, "Music on");
    setTimeout(() => ($("#blitz-progress").hidden = true), 1200);
    toast(`${pick.title} — ${pick.creator || "unknown"}`);
  } catch (error) {
    progress(0, error.message);
    toast(`No music: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ render */

async function render() {
  if (!state.editor.layers.length) return toast("Nothing on the canvas yet");
  const button = $("#blitz-render");
  button.disabled = true;
  state.editor.pause();
  try {
    progress(0.05, "Waiting for the clip to load…");
    const { ready, waiting } = await state.editor.whenReady();
    if (!ready) toast(`Still loading after 15s: ${waiting.join(", ")}`);

    const { layers, missing } = await freezeComposition(state.editor);
    if (missing.length) toast(`Still loading, skipped: ${missing.join(", ")}`);
    if (!layers.length) throw new Error("nothing to render");

    const { jobId } = await post("/render-video", {
      id: `blitz-${(state.ours.angle || "post").slice(0, 30)}`,
      duration: state.duration,
      width: COMP_W,
      height: COMP_H,
      layers,
      musicPath: "",
      musicVolume: 0,
      caption: state.ours.caption,
      hashtags: state.ours.hashtags,
      project: {
        derivedFrom: null,
        duration: state.duration,
        size: COMP_SIZE,
        width: COMP_W,
        height: COMP_H,
        layers: state.editor.layers.map(({ src, ...layer }) => layer),
        script: {
          format: "blitz",
          hook: $("#blitz-text").value.trim(),
          lines: "",
          // The receipt: six months from now this is the only record of which
          // post the shape came off.
          remixedFrom: { title: state.picked.title, url: state.picked.url, author: state.picked.author, velocity: state.picked.velocity },
        },
        captions: { style: "outline", fontSize: 0, wordsPerCard: 0, y: 0.42 },
        audio: { musicPath: state.music ? state.music.path : "", musicVolume: state.music ? Number($("#blitz-musicvol").value) : 0, voice: "" },
        caption: state.ours.caption,
        hashtags: (state.ours.hashtags || []).join(" "),
      },
    });

    const result = await pollJob(jobId, (job) => progress(job.progress || 0, job.stage || job.status));
    progress(1, "Rendered");
    $("#blitz-result").hidden = false;
    $("#blitz-result-video").src = `${API}${result.url}`;
    $("#blitz-result-video").load();
    $("#blitz-download").href = downloadUrl(result.file);
    $("#blitz-result-caption").textContent = `${state.ours.caption} ${(state.ours.hashtags || []).map((h) => `#${h}`).join(" ")}`;
    $("#blitz-reveal").onclick = () => post("/reveal", { path: result.file }).catch(() => {});
    toast(`Rendered to ${result.slug || "out"}/`);
  } catch (error) {
    progress(0, error.message);
    toast(`Render failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function progress(fraction, text) {
  $("#blitz-progress").hidden = false;
  $("#blitz-progress-fill").style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  $("#blitz-progress-note").textContent = text || "";
}

/* -------------------------------------------------------------------- wire */

async function boot() {
  await ensureFonts();
  state.editor = new Editor($("#blitz-canvas"));

  const saved = JSON.parse(localStorage.getItem(STORE) || "null");
  if (saved) {
    $("#blitz-url").value = saved.url || "";
    $("#blitz-queries").value = saved.queries || "";
    $("#blitz-handles").value = saved.handles || "";
  }

  $("#blitz-form").addEventListener("submit", hunt);

  const PLAY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
  $("#blitz-play").addEventListener("click", () => {
    state.editor.toggle();
    const playing = state.editor.playing;
    $("#blitz-play").innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    $("#blitz-play").setAttribute("aria-label", playing ? "Pause" : "Play");
  });

  $("#blitz-why-toggle").addEventListener("click", () => {
    const open = $("#blitz-why").hidden;
    $("#blitz-why").hidden = !open;
    $("#blitz-why-toggle").setAttribute("aria-expanded", String(open));
  });

  $("#blitz-again").addEventListener("click", async () => {
    if (state.busy || !state.read) return;
    state.busy = true;
    try {
      await adapt({ keepFootage: true });
    } catch (error) {
      toast(`Could not write it again: ${error.message}`);
    } finally {
      state.busy = false;
    }
  });

  $("#blitz-swap").addEventListener("click", () => {
    $("#blitz-footage").hidden = !$("#blitz-footage").hidden;
  });

  $("#blitz-footage-go").addEventListener("click", async () => {
    const query = $("#blitz-footage-q").value.trim();
    if (!query) return;
    try {
      await searchFootage(query);
    } catch (error) {
      toast(`Search failed: ${error.message}`);
    }
  });

  $("#blitz-edit").addEventListener("click", () => {
    const box = $("#blitz-textwrap");
    box.hidden = !box.hidden;
    if (!box.hidden) $("#blitz-text").focus();
  });

  // Retyping rebuilds rather than redrawing: the block's font size and its
  // position both depend on how many lines it wraps to, so a longer line that
  // only redrew would run off the bottom of the frame.
  $("#blitz-text").addEventListener("input", () => {
    if (state.bed) build();
  });

  $("#blitz-render").addEventListener("click", render);

  // The source plays muted so two soundtracks never start at once; this is the
  // way to hear what it actually says.
  $("#blitz-source-sound").addEventListener("click", () => {
    const video = $("#blitz-source-video");
    video.muted = !video.muted;
    $("#blitz-source-sound").classList.toggle("is-on", !video.muted);
    $("#blitz-source-sound").setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    if (video.paused) video.play().catch(() => {});
  });

  $("#blitz-lightbox-close").addEventListener("click", closeLightbox);
  $("#blitz-lightbox-back").addEventListener("click", closeLightbox);
  $("#blitz-lightbox-remix").addEventListener("click", () => {
    const item = enlarged;
    closeLightbox();
    if (item) pick(item);
  });
  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#blitz-lightbox").hidden) closeLightbox();
  });

  $("#blitz-music-silly").addEventListener("click", somethingSilly);
  $("#blitz-music").addEventListener("change", () => {
    useMusic(state.library.find((t) => t.path === $("#blitz-music").value) || null);
  });
  // The level changes on the layer in place; nothing else about the
  // composition depends on it, so a rebuild would only reset the playhead.
  $("#blitz-musicvol").addEventListener("input", () => {
    const layer = state.editor.layers.find((l) => l.type === "audio");
    if (layer) state.editor.updateLayer(layer.id, { volume: Number($("#blitz-musicvol").value) });
  });

  try {
    const lib = await api("/library");
    state.library = (lib.music || []).map((t) => ({ name: t.name, path: t.path, duration: t.duration || 0, credit: "" }));
    // The beds. Portrait clips only — a landscape recording cropped to 9:16
    // is a strip of the middle of somebody's screen — and the app's own
    // recordings count, since for this product they are the best bed there is.
    // A clip whose size could not be read is a clip ffmpeg could not open —
    // there is one such file in the library — and it cannot be a bed either.
    state.beds = [...(lib.videos || []), ...(lib.appClips || [])]
      .filter((v) => v.duration >= 6 && v.width && v.height && v.height >= v.width)
      .map((v) => ({ name: v.name, path: v.path, duration: v.duration, thumb: `${API}/thumb?p=${encodeURIComponent(v.path)}`, channel: "library", provider: "library", library: true }));
    fillMusic();
  } catch {
    // No server, no library — the pill below says so.
  }

  const pill = $("#server-pill");
  try {
    const health = await api("/health");
    pill.dataset.state = health.ytdlp ? "ok" : "down";
    pill.textContent = health.ytdlp ? "Studio server up" : "Studio server up · yt-dlp missing";
  } catch {
    pill.dataset.state = "down";
    pill.textContent = "Studio server down — run: node social/studio-server.mjs";
  }
}

boot();
