// Autopilot — the page half.
//
// The server reads the site, decides what is worth making and hands back plans
// (studio/autopilot.mjs). Everything from a plan to a file happens here, for the
// same reason AI mode does it here: type is laid out by a canvas, and a clip's
// real crop and rect come from the element that decoded it. The preview and the
// render can only be guaranteed to agree in the place that draws both.
//
// A plan arrives the moment its producer finishes, not at the end of the run, so
// post one is rendering while post two is still downloading its footage. The
// queue below is what keeps that to one render at a time — the editor is a
// single canvas and two compositions cannot share it.

import { renderSlide, toPngDataUrl, textLayerToPng, loadImage } from "./studio/render-image.js";
import { newLayer, audioLayer, textLayer, timeTextLayers, fitLayer, COMP_W, COMP_H } from "./studio/composition.js";
import { Editor } from "./studio/editor.js";
import { freezeComposition } from "./studio/freeze.js";

const API = (window.SOCIAL_CONFIG && window.SOCIAL_CONFIG.studioApiBase) || "http://127.0.0.1:8789";
const $ = (sel) => document.querySelector(sel);

/* ----------------------------------------------------------------- plumbing */

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
  if (!res.ok) {
    const error = new Error(data.error || `${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function pollJob(jobId, onProgress) {
  return new Promise((resolvePromise, reject) => {
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
        resolvePromise(job.result);
      } else if (job.status === "error") {
        clearInterval(timer);
        reject(new Error(job.error || "failed"));
      }
    }, 600);
    state.timers.push(timer);
  });
}

const fileUrl = (path) => `${API}/file?p=${encodeURIComponent(path)}`;
const downloadUrl = (path) => `${API}/download?p=${encodeURIComponent(path)}`;
const zipUrl = (dir) => `${API}/zip?p=${encodeURIComponent(dir)}`;

const state = {
  library: { photos: [], videos: [], music: [], voice: [], gifs: [], appClips: [], appShots: [] },
  voices: [],
  sceneFallback: "laptop desk",
  running: false,
  stopped: false,
  queue: [],
  draining: false,
  made: 0,
  expected: 0,
  // Plans seen but not yet queued: the library is reloaded first, and without
  // this the run could call itself finished in the gap.
  pending: 0,
  lastDir: null,
  timers: [],
};

let editor = null;

/* --------------------------------------------------------------- the feed */

function phase(text) {
  $("#auto-phase-text").textContent = text;
}

function say(text, who = "assistant") {
  const el = document.createElement("div");
  el.className = `auto-msg is-${who}`;
  el.textContent = text;
  $("#auto-feed").appendChild(el);
  $("#auto-feed").scrollTop = $("#auto-feed").scrollHeight;
  return el;
}

function log(text, kind = "") {
  const el = document.createElement("div");
  el.className = `auto-msg is-tool ${kind}`.trim();
  el.textContent = text;
  $("#auto-feed").appendChild(el);
  $("#auto-feed").scrollTop = $("#auto-feed").scrollHeight;
  return el;
}

function progress(fraction, note) {
  $("#auto-progress").hidden = false;
  $("#auto-progress-fill").style.width = `${Math.round((fraction || 0) * 100)}%`;
  $("#auto-progress-note").textContent = note || "";
}

/* ------------------------------------------------------------------ library */

async function loadLibrary() {
  try {
    state.library = { ...state.library, ...(await api("/library")) };
  } catch {}
}

// A plan carries paths, not library entries. Anything the run downloaded a
// minute ago may not be in the listing yet, so a path that is not found still
// becomes a usable layer — the editor measures the file itself.
function mediaFor(path) {
  const all = [
    ...state.library.videos,
    ...state.library.appClips,
    ...state.library.photos,
    ...state.library.appShots,
    ...state.library.gifs,
    ...state.library.voice,
    ...state.library.music,
  ];
  const found = all.find((item) => item.path === path);
  if (found) return { ...found, src: `${API}${found.url}` };
  return { name: String(path).split("/").pop(), path, src: fileUrl(path), duration: 0 };
}

// What a path is decides how it goes on the canvas and how ffmpeg reads it: a
// still needs -loop 1 to last, a gif needs -ignore_loop 0, and a clip needs
// neither. Autopilot's product shots are usually stills taken off the site, so
// this is the ordinary case rather than an exception.
function layerKind(path) {
  const ext = String(path || "").toLowerCase().split(".").pop();
  if (ext === "gif") return "gif";
  if (["png", "jpg", "jpeg", "webp", "avif", "heic"].includes(ext)) return "image";
  return "video";
}

/* ------------------------------------------------------------------ layouts */

// Named places in the 1080x1920 frame. The model composes by naming these
// rather than by picking one of four fixed layouts, which is the difference
// between "app clip over background clip, again" and a photograph with a
// sticker landing on the punchline.
const REGIONS = {
  full: { x: 0, y: 0, w: COMP_W, h: COMP_H },
  top: { x: 0, y: 0, w: COMP_W, h: 960 },
  bottom: { x: 0, y: 960, w: COMP_W, h: 960 },
  "top-third": { x: 0, y: 0, w: COMP_W, h: 640 },
  "bottom-third": { x: 0, y: 1280, w: COMP_W, h: 640 },
  middle: { x: 0, y: 660, w: COMP_W, h: 600 },
  centre: { x: 90, y: 560, w: 900, h: 800 },
  // A tall panel, the shape a phone screenshot actually is.
  phone: { x: 250, y: 380, w: 580, h: 1160 },
  // A floating window, the shape a desktop screenshot actually is.
  card: { x: 70, y: 640, w: 940, h: 600 },
  "corner-top-left": { x: 60, y: 220, w: 420, h: 420 },
  "corner-top-right": { x: 600, y: 220, w: 420, h: 420 },
  "corner-bottom-left": { x: 60, y: 1260, w: 420, h: 420 },
  "corner-bottom-right": { x: 600, y: 1260, w: 420, h: 420 },
  "sticker-top": { x: 280, y: 280, w: 520, h: 520 },
  "sticker-middle": { x: 280, y: 700, w: 520, h: 520 },
  "sticker-bottom": { x: 280, y: 1240, w: 520, h: 520 },
};

// Where the captions go depends on what is under them: over a full-frame
// picture they sit low, but a layer occupying the bottom half wants them off
// it. Worked out from the layers rather than from a layout name, since there is
// no longer a layout name.
function captionY(layers) {
  const busyBottom = layers.some((layer) => {
    const box = REGIONS[layer.region] || REGIONS.full;
    return box.y > COMP_H * 0.45 && box.h > 500 && box.w > COMP_W * 0.8;
  });
  return busyBottom ? 0.4 : 0.72;
}

// Whole lines, one idea each — until a line is too long to read in one hold, and
// then it is broken into chunks. The studio's three-words-a-card setting is the
// brainrot style; a written line survives better when the words are the point.
function captionCards(lines) {
  const cards = [];
  for (const line of lines) {
    const words = String(line).trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    // Six words is about what fits on two lines at caption size; a nine-word
    // line came out as four lines lying across the seam between two layers.
    if (words.length <= 6) {
      cards.push(words.join(" "));
      continue;
    }
    const chunks = Math.ceil(words.length / 5);
    const per = Math.ceil(words.length / chunks);
    for (let i = 0; i < words.length; i += per) cards.push(words.slice(i, i + per).join(" "));
  }
  return cards;
}

/* -------------------------------------------------------------- video posts */

// A plan's layers, back to front. Anything the model leaves out is chosen here
// rather than refused: a clip behind everything wants cover and a little sound,
// a sticker wants contain and none.
function planLayers(plan) {
  if (Array.isArray(plan.layers) && plan.layers.length) {
    return plan.layers.filter((layer) => layer && layer.source);
  }
  // A producer that answers in the older slot shape still gets a post, rather
  // than a page that says nothing happened.
  const fallback = [];
  if (plan.backgroundPath) fallback.push({ source: plan.backgroundPath, region: "full", fit: "cover" });
  if (plan.appClipPath) fallback.push({ source: plan.appClipPath, region: plan.backgroundPath ? "card" : "full", fit: plan.backgroundPath ? "contain" : "cover" });
  if (plan.gifPath) fallback.push({ source: plan.gifPath, region: `sticker-${plan.gifPlacement === "top" ? "top" : plan.gifPlacement === "bottom" ? "bottom" : "middle"}`, fit: "contain" });
  return fallback;
}

async function buildVideo(plan) {
  const voice = plan.voicePath ? mediaFor(plan.voicePath) : null;
  const spoken = voice && voice.duration ? Number(voice.duration) : 0;
  // A read that is cut off mid-sentence is never what anyone wanted, so the
  // spoken length wins over whatever the plan guessed.
  const duration = Math.max(6, Math.min(spoken ? spoken + 0.6 : Number(plan.duration) || 20, 120));

  editor.setComposition({ duration, layers: [] });
  showCanvas("video");

  const wanted = planLayers(plan);
  if (!wanted.length) throw new Error("the plan had nothing to put on screen");

  for (const [index, entry] of wanted.entries()) {
    const item = mediaFor(entry.source);
    const kind = layerKind(item.path);
    const box = REGIONS[entry.region] || REGIONS.full;
    const fills = box.w >= COMP_W && box.h >= COMP_H;
    // A still or a sticker shows all of itself by default; a clip fills its box.
    const fit = entry.fit === "cover" || entry.fit === "contain" ? entry.fit : kind === "video" ? "cover" : fills ? "cover" : "contain";
    const start = Math.max(0, Math.min(Number(entry.start) || 0, duration - 0.5));
    const end = Math.max(start + 0.5, Math.min(Number(entry.end) || duration, duration));
    // Sound: the model may set it, but the sensible default depends on whether
    // anyone is talking and whether this layer is the bed or a detail on top.
    const volume =
      kind !== "video"
        ? 0
        : entry.volume !== undefined
          ? Math.max(0, Math.min(Number(entry.volume), 1))
          : voice
            ? index === 0
              ? 0.07
              : 0.12
            : index === 0
              ? 0.2
              : 0.8;

    // A picture that does not fill its box leaves the rest black; a blurred
    // copy of itself behind it belongs to the shot.
    if (kind !== "video" && fit === "contain" && box.w > 700 && box.h > 500) {
      editor.addLayer(
        newLayer({
          type: kind === "gif" ? "gif" : "image",
          name: `${item.name} (bed)`,
          path: item.path,
          src: item.src,
          ...box,
          fit: "cover",
          blur: 40,
          start,
          end,
        }),
        { select: false },
      );
    }

    editor.addLayer(
      newLayer({
        type: kind,
        name: item.name,
        path: item.path,
        src: item.src,
        ...box,
        fit,
        start,
        end,
        volume,
        blur: Math.max(0, Math.min(Number(entry.blur) || 0, 60)),
        opacity: entry.opacity === undefined ? 1 : Math.max(0.05, Math.min(Number(entry.opacity), 1)),
      }),
      { select: false },
    );
  }

  if (voice) {
    editor.addLayer(audioLayer({ ...voice, duration: spoken || duration }, { start: 0, end: spoken || duration }), { select: false });
  }

  /* captions */
  const style = plan.captionStyle || "outline";
  const hook = String(plan.hook || "").trim();
  const hookEnd = hook ? Math.min(2.6, duration * 0.35) : 0;
  const y = captionY(wanted);
  if (hook) {
    editor.addLayer(
      textLayer(hook, {
        isCaption: true,
        style,
        fontSize: 76,
        x: 90,
        y: Math.round(COMP_H * 0.2),
        w: COMP_W - 180,
        start: 0,
        end: hookEnd,
      }),
      { select: false },
    );
  }
  const cards = captionCards(plan.lines || []).map((text) =>
    textLayer(text, { isCaption: true, style, fontSize: 66, x: 90, y: Math.round(COMP_H * y), w: COMP_W - 180 }),
  );
  timeTextLayers(cards, hookEnd, Math.max(duration - 0.15, hookEnd + 0.5));
  for (const card of cards) editor.addLayer(card, { select: false });

  editor.select(null);
  editor.draw();
  log(`${editor.layers.length} layers, ${wanted.map((l) => l.region).join(" + ")}, ${duration.toFixed(1)}s`, "is-done");

  /* render */
  progress(0.02, "Waiting for the clips to load…");
  const { ready, waiting } = await editor.whenReady();
  if (!ready) log(`still loading after 15s: ${waiting.join(", ")}`, "is-error");

  const { layers, missing } = await freezeComposition(editor);
  if (missing.length) log(`skipped, still loading: ${missing.join(", ")}`, "is-error");
  if (!layers.length) throw new Error("nothing to render");

  const hashtags = (plan.hashtags || []).map((h) => String(h).replace(/^#/, ""));
  const { jobId } = await api("/render-video", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: plan.hook || plan.conceptId || "autopilot",
      duration: editor.comp.duration,
      layers,
      musicPath: "",
      musicVolume: 0,
      caption: plan.caption || "",
      hashtags,
      // The editable composition, saved beside the file, so a post the studio
      // never touched can still be opened in it afterwards.
      project: {
        derivedFrom: null,
        duration: editor.comp.duration,
        layers: editor.layers.map(({ src, ...layer }) => layer),
        script: { format: "autopilot", hook: plan.hook || "", lines: (plan.lines || []).join("\n"), topic: plan.angle || "" },
        captions: { style, fontSize: 66, wordsPerCard: 6, y },
        audio: { musicPath: "", musicVolume: 0, voice: "" },
        caption: plan.caption || "",
        hashtags: hashtags.join(" "),
      },
    }),
  });

  const result = await pollJob(jobId, (job) => progress(job.progress || 0, job.stage || job.status));
  progress(1, "Rendered");
  return {
    kind: "video",
    name: result.slug,
    dir: result.dir,
    path: result.file,
    url: result.url,
    duration: result.duration,
    caption: plan.caption || "",
    hashtags,
    hook: plan.hook || "",
    note: plan.note || "",
  };
}

/* -------------------------------------------------------------- image posts */

async function sampleBrightness(thumbUrl) {
  try {
    const img = await loadImage(`${API}/stock/proxy?url=${encodeURIComponent(thumbUrl)}`);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 32, 32);
    const { data } = ctx.getImageData(0, 0, 32, 32);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    return sum / (data.length / 4);
  } catch {
    return null;
  }
}

// Enough of the page to have a range to choose from, spread rather than sliced,
// so a six-card post does not use six near-identical frames.
function spread(list, count) {
  if (!list.length) return [];
  if (list.length <= count) return list.slice();
  const step = list.length / count;
  return Array.from({ length: count }, (_, i) => list[Math.min(list.length - 1, Math.round(i * step))]);
}

async function sceneBackgrounds(scene, slides) {
  const search = async (query) => {
    try {
      const { results } = await api(`/stock/photos?q=${encodeURIComponent(query)}&orientation=portrait`);
      return results || [];
    } catch {
      return [];
    }
  };

  let used = (scene || "").trim() || state.sceneFallback;
  let results = await search(used);
  // Commons ANDs every word, so a scene with one unmatched word returns nothing
  // at all and every card would come out flat.
  if (!results.length && used !== state.sceneFallback) {
    used = state.sceneFallback;
    results = await search(used);
  }
  if (!results.length) {
    log(`no photos for "${scene}" — the cards keep their flat background`, "is-error");
    return null;
  }

  const candidates = results.slice(0, Math.min(results.length, slides.length + 6));
  const lit = await Promise.all(candidates.map(async (r) => ({ r, light: await sampleBrightness(r.thumb) })));
  const measured = lit.every((entry) => entry.light !== null);
  if (measured) lit.sort((a, b) => a.light - b.light);
  const chosen = spread(lit.map((entry) => entry.r), slides.length);

  slides.forEach((slide, i) => {
    const choice = chosen[i % chosen.length];
    slide.background = { kind: "stock", src: `${API}/stock/proxy?url=${encodeURIComponent(choice.full)}`, credit: choice.credit };
  });
  log(`backgrounds from one scene: "${used}"${measured ? ", dark to bright" : ""}`, "is-done");
  return used;
}

async function buildImage(plan) {
  const slides = (plan.slides || []).map((s) => ({
    headline: s.headline || "",
    body: s.body || "",
    background: null,
    textY: 0.5,
  }));
  if (!slides.length) throw new Error("the plan had no slides");

  const look = {
    size: ["4:5", "9:16", "1:1"].includes(plan.size) ? plan.size : "4:5",
    style: ["sticker-white", "sticker-black", "sticker-accent", "outline"].includes(plan.captionStyle) ? plan.captionStyle : "sticker-white",
    headlineSize: 72,
    bodySize: 62,
    scrim: 0.2,
    handle: "",
  };

  progress(0.1, "Finding a scene…");
  const scene = await sceneBackgrounds(plan.scene, slides);

  const canvas = $("#auto-slide");
  showCanvas("image");
  const pngs = [];
  for (const [i, slide] of slides.entries()) {
    // Drawn onto the visible canvas rather than an offscreen one: the run is
    // long enough that watching the cards appear is the difference between
    // progress and a frozen page.
    await renderSlide(canvas, slide, look);
    pngs.push(toPngDataUrl(canvas));
    progress(0.1 + (0.8 * (i + 1)) / slides.length, `Card ${i + 1} of ${slides.length}`);
  }

  const hashtags = (plan.hashtags || []).map((h) => String(h).replace(/^#/, ""));
  const result = await api("/save-post", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: plan.hook || plan.conceptId || "autopilot",
      kind: "image",
      slides: pngs,
      caption: plan.caption || "",
      hashtags,
      meta: {
        format: "autopilot",
        look,
        scene,
        angle: plan.angle || "",
        credits: slides.map((s) => (s.background && s.background.credit) || ""),
      },
    }),
  });
  progress(1, "Saved");

  return {
    kind: "image",
    name: result.slug,
    dir: result.dir,
    files: result.files.map((file) => `${result.dir}/${file}`),
    caption: plan.caption || "",
    hashtags,
    hook: plan.hook || "",
    note: plan.note || "",
  };
}

/* ---------------------------------------------------------------- the queue */

function enqueue(plan) {
  state.queue.push(plan);
  drain();
}

async function drain() {
  if (state.draining) return;
  state.draining = true;
  while (state.queue.length && !state.stopped) {
    const plan = state.queue.shift();
    const label = plan.hook ? `"${plan.hook}"` : `post ${plan.index + 1}`;
    say(`Building ${label}`);
    if (plan.note) log(plan.note);
    try {
      const result = plan.kind === "image" ? await buildImage(plan) : await buildVideo(plan);
      state.made++;
      addResult(result);
      say(`${result.name} is done.`, "done");
    } catch (error) {
      log(`${label} failed: ${error.message}`, "is-error");
    }
  }
  state.draining = false;
  $("#auto-progress").hidden = true;
}

/* --------------------------------------------------------------- the result */

function showCanvas(which) {
  $("#auto-stage-empty").hidden = true;
  $("#auto-canvas").hidden = which !== "video";
  $("#auto-slide").hidden = which !== "image";
}

function addResult(result) {
  $("#auto-results").hidden = false;
  state.lastDir = result.dir;
  const card = document.createElement("article");
  card.className = "auto-card";

  const media = document.createElement("div");
  media.className = "auto-card-media";
  if (result.kind === "video") {
    const video = document.createElement("video");
    video.src = `${API}${result.url}`;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    media.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.src = fileUrl(result.files[0]);
    img.alt = result.hook || result.name;
    media.appendChild(img);
    if (result.files.length > 1) {
      const strip = document.createElement("div");
      strip.className = "auto-card-strip";
      for (const file of result.files.slice(1, 7)) {
        const thumb = document.createElement("img");
        thumb.src = fileUrl(file);
        thumb.alt = "";
        thumb.loading = "lazy";
        thumb.addEventListener("click", () => {
          img.src = thumb.src;
        });
        strip.appendChild(thumb);
      }
      media.appendChild(strip);
    }
  }
  card.appendChild(media);

  const body = document.createElement("div");
  body.className = "auto-card-body";

  const title = document.createElement("h3");
  title.textContent = result.hook || result.name;
  body.appendChild(title);

  const meta = document.createElement("p");
  meta.className = "auto-card-meta";
  meta.textContent =
    result.kind === "video"
      ? `Video · ${(result.duration || 0).toFixed(1)}s · ${result.name}`
      : `Carousel · ${result.files.length} cards · ${result.name}`;
  body.appendChild(meta);

  const caption = document.createElement("textarea");
  caption.className = "auto-card-caption";
  caption.rows = 4;
  caption.value = [result.caption, (result.hashtags || []).map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n");
  body.appendChild(caption);

  const row = document.createElement("div");
  row.className = "btn-row auto-card-actions";

  // Download is a real link with the server's own attachment header behind it:
  // an href to a video otherwise opens it in a tab, and a blob would mean
  // holding a whole mp4 in the page.
  const download = document.createElement("a");
  download.className = "button button-accent button-small";
  download.textContent = result.kind === "video" ? "Download video" : "Download cards";
  download.href = result.kind === "video" ? downloadUrl(result.path) : zipUrl(result.dir);
  download.setAttribute("download", "");
  row.appendChild(download);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "button button-dark button-small";
  copy.textContent = "Copy caption";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(caption.value);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy caption"), 1600);
    } catch {
      caption.select();
      toast("Press ⌘C to copy");
    }
  });
  row.appendChild(copy);

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "button button-ghost button-small";
  reveal.textContent = "Show in Finder";
  reveal.addEventListener("click", async () => {
    try {
      await api("/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: result.kind === "video" ? result.path : result.files[0] }),
      });
    } catch (error) {
      toast(`Could not open Finder: ${error.message}`);
    }
  });
  row.appendChild(reveal);

  body.appendChild(row);
  card.appendChild(body);
  $("#auto-grid").prepend(card);
}

/* ------------------------------------------------------------------ the run */

async function run(event) {
  event.preventDefault();
  if (state.running) return;

  let url = $("#auto-url").value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  state.running = true;
  state.stopped = false;
  state.made = 0;
  state.pending = 0;
  state.queue.length = 0;
  state.expected = Number($("#auto-count").value) || 3;
  $("#auto-go").disabled = true;
  $("#auto-go").textContent = "Running…";
  $("#auto-stop").hidden = false;
  $("#auto-run").hidden = false;
  $("#auto-feed").innerHTML = "";
  phase("Reading the site");
  say(`Reading ${url}`);

  const mix = $("#auto-mix").value;
  const wantsVoice = $("#auto-voice").checked;

  try {
    const { jobId } = await api("/auto/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        count: state.expected,
        mix:
          mix === "video"
            ? "every concept a video"
            : mix === "image"
              ? "every concept an image carousel"
              : `a mix of video and carousel, at least one of each when there is more than one`,
        voices: state.voices,
        voiceover: wantsVoice,
      }),
    });

    let shown = 0;
    await pollJob(jobId, (job) => {
      const messages = job.messages || [];
      for (const message of messages.slice(shown)) {
        if (message.role === "phase") phase(message.text);
        else if (message.role === "tool") log(`${message.tool} ${JSON.stringify(message.args || {}).slice(0, 90)}`);
        else if (message.role === "tool-result") log(`${message.tool} → ${message.text}`, "is-done");
        else if (message.role === "tool-error") log(`${message.tool} failed: ${message.text}`, "is-error");
        else if (message.role === "concept-start") say(`Producing "${(message.concept || {}).hook || ""}"`);
        else if (message.role === "concept-done" && message.plan) {
          // Render this one now; the server carries on with the next concept.
          state.pending++;
          loadLibrary().then(() => {
            state.pending--;
            enqueue(message.plan);
          });
        } else if (message.text) say(message.text);
      }
      shown = messages.length;
    });

    phase(state.pending || state.queue.length || state.draining ? "Rendering the last one" : "Done");
    // The producer's plans are already queued; wait for the renders to finish
    // before the run is called over.
    while ((state.pending || state.queue.length || state.draining) && !state.stopped) await new Promise((r) => setTimeout(r, 400));
    phase(state.made ? `Done — ${state.made} post${state.made === 1 ? "" : "s"}` : "Finished with nothing");
    if (state.made) say(`${state.made} post${state.made === 1 ? "" : "s"} ready to download.`, "done");
  } catch (error) {
    phase("Stopped");
    log(String(error.message || error), "is-error");
    say("That run did not finish. Anything it downloaded is in your library, and the Studio tab can carry on by hand.");
  } finally {
    state.running = false;
    $("#auto-go").disabled = false;
    $("#auto-go").textContent = "Run";
    $("#auto-stop").hidden = true;
  }
}

function stopRun() {
  state.stopped = true;
  state.queue.length = 0;
  state.pending = 0;
  for (const timer of state.timers) clearInterval(timer);
  state.timers.length = 0;
  state.running = false;
  $("#auto-go").disabled = false;
  $("#auto-go").textContent = "Run";
  $("#auto-stop").hidden = true;
  phase("Stopped");
  log("stopped — the server may still finish what it had already started", "is-error");
}

/* --------------------------------------------------------------------- boot */

async function init() {
  editor = new Editor($("#auto-canvas"));

  const pill = $("#server-pill");
  try {
    const health = await api("/health");
    pill.dataset.state = health.ffmpeg ? "ok" : "down";
    pill.textContent = health.ffmpeg ? "Studio server up" : "Studio server up · ffmpeg missing";
  } catch {
    pill.dataset.state = "down";
    pill.textContent = "Studio server down — run: node social/studio-server.mjs";
  }

  if (pill.dataset.state === "ok") {
    await loadLibrary();
    try {
      const { voices } = await api("/voices");
      // Kept as {id, label} pairs: the label carries the voice's character, and
      // choosing a voice that suits the script is part of producing the post.
      state.voices = (voices || []).filter((v) => v && v.id).map((v) => ({ id: v.id, label: v.label || v.id }));
    } catch {}
    if (!state.library.keys || !state.library.keys.deepseek) {
      say("No model key is set, so there is nothing to drive this. Add deepseekApiKey to social/studio.config.json.", "error");
    }
  }

  try {
    const formats = await fetch(`studio/formats.json?v=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
    if (formats.sceneFallback) state.sceneFallback = formats.sceneFallback;
  } catch {}

  // A run is minutes of searching, downloading and rendering; leaving takes all
  // of it with you.
  window.addEventListener("beforeunload", (event) => {
    if (!state.running && !state.draining && !state.pending) return;
    event.preventDefault();
    event.returnValue = "";
  });

  $("#auto-form").addEventListener("submit", run);
  $("#auto-stop").addEventListener("click", stopRun);
  $("#auto-again").addEventListener("click", () => {
    $("#auto-url").focus();
    $("#auto-url").select();
  });
  $("#auto-openfolder").addEventListener("click", async () => {
    if (!state.lastDir) return toast("Nothing rendered yet");
    try {
      await api("/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: state.lastDir }),
      });
    } catch (error) {
      toast(`Could not open Finder: ${error.message}`);
    }
  });

  $("#auto-url").focus();

  // The seam the run itself uses, left reachable: paste a plan from a finished
  // job into autopilot.enqueue() and it renders again without another pass over
  // the model. Runs cost minutes, so re-rendering one by hand is worth having.
  window.autopilot = { state, enqueue, buildVideo, buildImage };
}

init();
