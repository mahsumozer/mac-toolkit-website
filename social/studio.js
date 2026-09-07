// Content Studio — briefs in, posts out.
//
// The page owns the copy, the layout and the canvas; studio-server.mjs owns
// everything that needs a process or a secret (ffmpeg, the media library, the
// Claude and stock-photo keys). Image slides are drawn here and shipped to the
// server as PNGs, so the preview is the export.

import { renderSlide, textLayerToPng, toPngDataUrl, loadImage, CANVAS_SIZES, TEXT_STYLES } from "./studio/render-image.js";
import { textLayer, imageLayer, audioLayer, splitLayerAt, timeTextLayers, splitIntoCards, newLayer, uid, fitLayer, COMP_W, COMP_H } from "./studio/composition.js";
import { Editor } from "./studio/editor.js";
import { Timeline } from "./studio/timeline.js";

const API = (window.SOCIAL_CONFIG && window.SOCIAL_CONFIG.studioApiBase) || "http://127.0.0.1:8789";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ----------------------------------------------------------------- helpers */

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

const fileUrl = (item) => `${API}${item.url}`;
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------- state */

const state = {
  formats: null,
  content: null,
  library: { photos: [], videos: [], music: [], appClips: [], appShots: [], keys: {} },
  stock: [],
  bgSource: "library",
  image: {
    slides: [],
    index: 0,
    look: { size: "4:5", style: "sticker-white", headlineSize: 72, bodySize: 62, scrim: 0.18, handle: "" },
    caption: "",
    hashtags: [],
  },
  video: { jobId: null, timer: null },
};

const blankSlide = () => ({ headline: "", body: "", background: null, textY: 0.5, keep: true });

/* -------------------------------------------------------------- offline copy */

// Used when there is no Anthropic key, and as the "Use templates" button. It
// only ever assembles strings from formats.json, so it can never invent a
// feature the app does not have.
function offlineImageCopy({ format, slideCount, topic }) {
  const bank = state.formats.painFixes;
  const names = shuffled(Object.keys(bank));
  const chosen = topic
    ? [...names.filter((n) => `${n} ${bank[n].short} ${bank[n].fix}`.toLowerCase().includes(topic.toLowerCase())), ...names]
    : names;

  const middleCount = Math.max(1, slideCount - 2);
  const tpl = format.template;
  const price = state.formats.positioning.price;
  const fill = (text, extra) =>
    String(text)
      .replace(/\{count\}/g, String(middleCount))
      .replace(/\{price\}/g, price)
      .replace(/\{n\}/g, extra.n)
      .replace(/\{feature_short\}/g, extra.short)
      .replace(/\{feature_pain\}/g, extra.pain)
      .replace(/\{feature_fix\}/g, extra.fix);

  const slides = [];
  slides.push({ ...blankSlide(), headline: fill(tpl.first.headline, {}), body: fill(tpl.first.body, {}) });
  for (let i = 0; i < middleCount; i++) {
    const name = chosen[i % chosen.length];
    const entry = bank[name];
    const extra = { n: String(i + 1), short: entry.short, pain: entry.pain, fix: entry.fix };
    slides.push({ ...blankSlide(), headline: fill(tpl.middle.headline, extra), body: fill(tpl.middle.body, extra) });
  }
  slides.push({ ...blankSlide(), headline: fill(tpl.last.headline, {}), body: fill(tpl.last.body, {}) });

  const hook = slides[0].headline;
  const caption = pick(state.formats.captionTemplates).replace("{hook}", hook).replace("{price}", price);
  return { slides, scene: pick(state.formats.scenes).query, caption, hashtags: pick(state.formats.hashtagSets) };
}

function offlineVideoCopy({ format, topic }) {
  const bank = state.formats.painFixes;
  const names = shuffled(Object.keys(bank));
  const chosen = topic ? [...names.filter((n) => n.toLowerCase().includes(topic.toLowerCase())), ...names] : names;
  const lines = [];
  for (let i = 0; i < format.lines - 1; i++) {
    const entry = bank[chosen[i % chosen.length]];
    lines.push(i % 2 === 0 ? entry.pain : entry.fix);
  }
  lines.push(`Mac Kit. ${state.formats.positioning.price}`);
  const hook = pick(state.formats.hooks);
  return {
    hook,
    lines,
    caption: pick(state.formats.captionTemplates)
      .replace("{hook}", hook)
      .replace("{price}", state.formats.positioning.price),
    hashtags: pick(state.formats.hashtagSets),
  };
}

async function modelCopy(payload) {
  const body = {
    ...payload,
    product: { name: state.content.product.name, url: state.content.product.url, priceLine: state.content.product.priceLine },
    features: state.formats.features,
  };
  return api("/copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/* ---------------------------------------------------------------- image tab */

const canvas = $("#preview-canvas");

const drawPreview = debounce(async () => {
  const { slides, index, look } = state.image;
  const slide = slides[index];
  $("#preview-label").textContent = slides.length ? `Slide ${index + 1} of ${slides.length}${slide && slide.keep === false ? " · cut" : ""}` : "No slides yet";
  $("#preview-empty").hidden = slides.length > 0;
  if (!slide) {
    const ctx = canvas.getContext("2d");
    canvas.width = 1080;
    canvas.height = 1350;
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  await renderSlide(canvas, { ...slide, handle: look.handle }, look);
}, 90);

// Thumbnails rather than clipped headlines: at chip width a title truncates to
// "2. 1. Hunting for cop…", which tells you nothing, while the background is
// what you actually recognise a slide by. The headline moves to the tooltip.
function renderSlideStrip() {
  // Keep and Cut on an empty deck are two buttons that do nothing, which is a
  // lesson in not trusting the rest of the page.
  const blitz = document.querySelector(".blitz");
  if (blitz) blitz.hidden = !state.image.slides.length;

  const strip = $("#slide-strip");
  strip.innerHTML = "";
  state.image.slides.forEach((slide, i) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `slide-chip${i === state.image.index ? " is-active" : ""}${slide.keep === false ? " is-cut" : ""}`;
    button.title = `${i + 1}. ${slide.headline || "Untitled"}`;

    if (slide.background && slide.background.src) {
      const img = document.createElement("img");
      img.className = "slide-chip-img";
      img.src = slide.background.src;
      img.loading = "lazy";
      img.alt = "";
      button.appendChild(img);
    } else {
      // No background yet is a normal state, not an error: the slide is still a
      // real slide, so it gets the same frame with a flat ground.
      button.classList.add("is-blank");
    }

    const number = document.createElement("span");
    number.className = "slide-chip-num";
    number.textContent = String(i + 1);
    button.appendChild(number);

    button.addEventListener("click", () => selectSlide(i));
    li.appendChild(button);
    strip.appendChild(li);
  });
}

function syncSlideEditor() {
  const slide = state.image.slides[state.image.index];
  $("#slide-headline").value = slide ? slide.headline : "";
  $("#slide-body").value = slide ? slide.body : "";
  const textY = slide ? slide.textY ?? 0.5 : 0.5;
  $("#slide-texty").value = String(textY);
  $("#slide-texty-out").textContent = Number(textY).toFixed(2);
  markActiveThumb();
}

function selectSlide(index) {
  state.image.index = Math.max(0, Math.min(index, state.image.slides.length - 1));
  renderSlideStrip();
  syncSlideEditor();
  drawPreview();
}

function applyLookToAll() {
  if (!$("#look-apply-all").checked) return;
  for (const slide of state.image.slides) {
    delete slide.style;
    delete slide.headlineSize;
    delete slide.bodySize;
    delete slide.scrim;
  }
}

function readLook() {
  const look = state.image.look;
  look.size = $("#look-size").value;
  look.style = $("#look-style").value;
  look.headlineSize = Number($("#look-hsize").value);
  look.bodySize = Number($("#look-bsize").value);
  look.scrim = Number($("#look-scrim").value);
  look.handle = $("#look-handle").value.trim();
  $("#look-hsize-out").textContent = String(look.headlineSize);
  $("#look-bsize-out").textContent = String(look.bodySize);
  $("#look-scrim-out").textContent = look.scrim.toFixed(2);
  applyLookToAll();
  drawPreview();
}

/* --------------------------------------------------------- background picker */

function markActiveThumb() {
  const slide = state.image.slides[state.image.index];
  const current = slide && slide.background ? slide.background.src : null;
  $$("#bg-grid .thumb").forEach((el) => el.classList.toggle("is-active", el.dataset.src === current));
}

function setBackground(background) {
  const slide = state.image.slides[state.image.index];
  if (!slide) return;
  slide.background = background;
  markActiveThumb();
  renderSlideStrip();
  drawPreview();
}

function renderThumbs(items) {
  const grid = $("#bg-grid");
  grid.innerHTML = "";
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb";
    button.dataset.src = item.src;
    const img = document.createElement("img");
    img.src = item.thumb;
    img.loading = "lazy";
    img.alt = item.label || "";
    button.appendChild(img);
    if (item.credit) {
      const credit = document.createElement("span");
      credit.className = "thumb-credit";
      credit.textContent = item.credit;
      button.appendChild(credit);
    }
    button.addEventListener("click", () => setBackground({ kind: item.kind, src: item.src, credit: item.credit || "" }));

    const expand = document.createElement("span");
    expand.className = "thumb-expand";
    expand.title = "Open large";
    expand.textContent = "⤢";
    expand.addEventListener("click", (e) => {
      e.stopPropagation();
      openLightbox("image", item.src, item.credit || item.label || "");
    });
    button.appendChild(expand);

    grid.appendChild(button);
  }
  markActiveThumb();
}

function showBackgroundSource(source) {
  state.bgSource = source;
  $$("#bg-source .seg-btn").forEach((el) => el.classList.toggle("is-active", el.dataset.src === source));
  $("#stock-search-row").hidden = source !== "stock";
  const hint = $("#bg-hint");

  if (source === "library") {
    hint.textContent = state.library.photos.length
      ? `${state.library.photos.length} photo${state.library.photos.length === 1 ? "" : "s"} in social/studio/library/photos/`
      : "No photos yet — drop some below, or switch to Stock.";
    renderThumbs(state.library.photos.map((p) => ({ kind: "library", src: fileUrl(p), thumb: fileUrl(p), label: p.name })));
  } else if (source === "shots") {
    hint.textContent = "Screenshots of the app itself, from social-media-video/.";
    renderThumbs(state.library.appShots.map((p) => ({ kind: "shot", src: fileUrl(p), thumb: fileUrl(p), label: p.name })));
  } else if (source === "stock") {
    hint.textContent = state.library.keys.pexels
      ? "Pexels — free for commercial use, no attribution needed."
      : "No Pexels key, so Wikimedia Commons is used. Its results are CC-licensed: check the licence under each thumbnail before posting.";
    renderThumbs(state.stock);
  } else {
    hint.textContent = "Flat colour behind the text.";
    renderThumbs([]);
    setBackground(null);
  }
}

async function searchStock() {
  const query = $("#stock-query").value.trim();
  if (!query) return;
  const provider = $("#stock-provider").value;
  $("#bg-hint").textContent = "Searching…";
  try {
    const { results } = await api(`/stock/photos?q=${encodeURIComponent(query)}&provider=${provider}&orientation=portrait`);
    state.stock = results.map((r) => ({
      kind: "stock",
      // Canvas export needs same-origin pixels, so the full-size image comes
      // through the server's proxy; the thumbnail can load straight from the CDN.
      src: `${API}/stock/proxy?url=${encodeURIComponent(r.full)}`,
      thumb: r.thumb,
      credit: `${r.credit} · ${r.licence}`,
    }));
    renderThumbs(state.stock);
    $("#bg-hint").textContent = `${results.length} results · ${results[0] ? results[0].provider : ""}`;
  } catch (error) {
    $("#bg-hint").textContent = `Search failed: ${error.message}`;
  }
}

// Fills every slide that has no background yet from one stock search per slide,
// so a freshly generated post is not eleven identical grey cards.
// Mean luma of a thumbnail, 0-255. Sampled through the proxy so the canvas
// stays same-origin and readable; a failure returns null rather than throwing,
// and the caller then keeps the search's own order.
async function sampleBrightness(thumbUrl) {
  try {
    const img = await loadImage(`${API}/stock/proxy?url=${encodeURIComponent(thumbUrl)}`);
    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 24;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    const px = ctx.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return sum / (px.length / 4);
  } catch {
    return null;
  }
}

// Take `count` frames spread evenly across a sorted list, so the post travels
// the whole range instead of clustering at one end of it.
function spread(list, count) {
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, i) => list[Math.round((i * (list.length - 1)) / (count - 1))]);
}

/**
 * One search for the whole post, not one per slide.
 *
 * Two things drove this. Searching per slide put the tool's own name in the
 * query — "clean mode laptop desk" — and Wikimedia Commons ANDs every term, so
 * a word with no match there returns nothing and that slide stayed blank. And a
 * carousel where every card was found separately looks like six unrelated
 * stock photos rather than one place. One scene fixes both: the frames all come
 * from the same visual family, and the arrangement runs dark to bright so the
 * post opens close and ends open.
 */
async function autoBackgrounds(scene) {
  const slides = state.image.slides;
  if (!slides.length) return;

  const query = (scene || "").trim() || pick(state.formats.scenes).query;
  const fetchScene = async (q) => {
    try {
      const { results } = await api(`/stock/photos?q=${encodeURIComponent(q)}&orientation=portrait`);
      return results || [];
    } catch {
      return [];
    }
  };

  let results = await fetchScene(query);
  let used = query;
  // A scene that finds nothing falls back to one that is known to, rather than
  // leaving the post on flat colour.
  if (!results.length && query !== state.formats.sceneFallback) {
    used = state.formats.sceneFallback;
    results = await fetchScene(used);
  }
  if (!results.length) {
    toast(`No photos for "${query}" — pick backgrounds by hand`);
    return;
  }

  // Enough candidates to have a range to sort, without measuring the whole page.
  const candidates = results.slice(0, Math.min(results.length, slides.length + 6));
  const lit = await Promise.all(candidates.map(async (r) => ({ r, light: await sampleBrightness(r.thumb) })));
  const measured = lit.every((entry) => entry.light !== null);
  if (measured) lit.sort((a, b) => a.light - b.light);
  const chosen = spread(lit.map((entry) => entry.r), slides.length);

  slides.forEach((slide, i) => {
    const choice = chosen[i % chosen.length];
    slide.background = {
      kind: "stock",
      src: `${API}/stock/proxy?url=${encodeURIComponent(choice.full)}`,
      credit: choice.credit,
    };
  });

  state.image.scene = used;
  renderSlideStrip();
  drawPreview();

  // A background that will not load leaves a flat card and no clue why, which
  // is exactly how a rejected upstream request hid for a while. Check one.
  const reachable = await loadImage(slides[0].background.src).then(
    () => true,
    () => false,
  );
  if (!reachable) {
    toast("Backgrounds found but the images will not load — check the studio server log");
    return;
  }
  toast(`Backgrounds from one scene: "${used}"${measured ? ", ordered dark to bright" : ""}`);
}

/* --------------------------------------------------------------- generation */

function currentImageFormat() {
  return state.formats.imageFormats.find((f) => f.id === $("#img-format").value) || state.formats.imageFormats[0];
}

function applyImageCopy(result) {
  state.image.scene = result.scene || "";
  state.image.slides = result.slides.map((s) => ({ ...blankSlide(), ...s }));
  state.image.index = 0;
  state.image.caption = result.caption || "";
  state.image.hashtags = result.hashtags || [];
  $("#img-caption").value = state.image.caption;
  $("#img-hashtags").value = state.image.hashtags.join(" ");
  renderSlideStrip();
  syncSlideEditor();
  drawPreview();
}

async function generateImageCopy(useModel) {
  const format = currentImageFormat();
  const slideCount = Math.max(3, Math.min(12, Number($("#img-count").value) || 6));
  const topic = $("#img-topic").value.trim();
  const personaId = $("#img-persona").value;
  const persona = (state.content.personas || []).find((p) => p.id === personaId);
  const button = useModel ? $("#img-generate") : $("#img-offline");
  button.disabled = true;
  button.textContent = useModel ? "Writing…" : "Filling…";
  try {
    let result;
    if (useModel) {
      result = await modelCopy({ kind: "image", format, slideCount, topic, persona, tone: $("#img-tone").value.trim() });
    } else {
      result = offlineImageCopy({ format, slideCount, topic });
    }
    applyImageCopy(result);
    toast(useModel ? `${result.model || PROVIDER_LABELS[result.source] || "The model"} wrote the slides` : "Slides filled from templates");
    await autoBackgrounds(result.scene);
  } catch (error) {
    if (error.status === 428) {
      toast("No model key configured — falling back to templates");
      const fallback = offlineImageCopy({ format, slideCount, topic });
      applyImageCopy(fallback);
      await autoBackgrounds(fallback.scene);
    } else {
      toast(`Copy failed: ${error.message}`);
    }
  } finally {
    button.disabled = false;
    button.textContent = useModel ? writerLabel() : "Use templates";
  }
}

/* ------------------------------------------------------------------- export */

async function exportImagePost() {
  const kept = state.image.slides.filter((s) => s.keep !== false);
  if (!kept.length) return toast("Nothing to export — every slide is cut");
  const button = $("#img-export");
  button.disabled = true;
  button.textContent = "Rendering…";
  try {
    const offscreen = document.createElement("canvas");
    const pngs = [];
    for (const slide of kept) {
      await renderSlide(offscreen, { ...slide, handle: state.image.look.handle }, state.image.look);
      pngs.push(toPngDataUrl(offscreen));
    }
    const hashtags = $("#img-hashtags").value.trim().split(/[\s,]+/).filter(Boolean);
    const result = await api("/save-post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: kept[0].headline || currentImageFormat().id,
        kind: "image",
        slides: pngs,
        caption: $("#img-caption").value,
        hashtags,
        meta: { format: currentImageFormat().id, look: state.image.look, credits: kept.map((s) => (s.background && s.background.credit) || "") },
      }),
    });
    $("#img-export-note").textContent = `${pngs.length} slides written to social/studio/out/${result.slug}/`;
    toast(`Exported ${pngs.length} slides`);
    loadOutput();
  } catch (error) {
    toast(`Export failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Export post";
  }
}

function downloadCurrentSlide() {
  const link = document.createElement("a");
  link.download = `slide-${state.image.index + 1}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

/* ----------------------------------------------------------------- lightbox */

// The lightbox holds a set, not a single frame: a carousel is the one thing you
// most want to page through at full size, and opening it on slide 4 to check
// the wording should not mean closing and reopening on slide 5.
const gallery = { items: [], index: 0 };

function showGalleryFrame() {
  const item = gallery.items[gallery.index];
  if (!item) return;
  const stage = $("#lightbox-stage");
  stage.innerHTML = "";
  if (item.kind === "video") {
    const video = document.createElement("video");
    video.src = item.src;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    stage.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.src = item.src;
    stage.appendChild(img);
  }

  const many = gallery.items.length > 1;
  $("#lightbox-prev").hidden = !many;
  $("#lightbox-next").hidden = !many;
  const dots = $("#lightbox-dots");
  dots.hidden = !many;
  dots.innerHTML = "";
  if (many) {
    gallery.items.forEach((_, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = `lightbox-dot${i === gallery.index ? " is-active" : ""}`;
      dot.setAttribute("aria-label", `Go to ${i + 1}`);
      dot.addEventListener("click", () => stepGallery(i - gallery.index));
      dots.appendChild(dot);
    });
  }
  $("#lightbox-caption").textContent = many
    ? `${item.caption || ""} · ${gallery.index + 1} of ${gallery.items.length}`
    : item.caption || "";
}

// Wraps, so the last slide steps round to the first rather than dead-ending.
function stepGallery(delta) {
  if (!gallery.items.length) return;
  const count = gallery.items.length;
  gallery.index = (((gallery.index + delta) % count) + count) % count;
  showGalleryFrame();
}

function openGallery(items, index = 0, caption = "") {
  gallery.items = items.map((item) => ({ ...item, caption: item.caption || caption }));
  gallery.index = Math.max(0, Math.min(index, items.length - 1));
  showGalleryFrame();
  $("#lightbox").hidden = false;
}

function openLightbox(kind, src, caption) {
  openGallery([{ kind, src, caption }], 0, caption);
}

function closeLightbox() {
  gallery.items = [];
  $("#lightbox").hidden = true;
  // Emptying the stage stops playback; a paused video left in the DOM keeps
  // decoding in some builds.
  $("#lightbox-stage").innerHTML = "";
}

function wireLightbox() {
  $("#lightbox-close").addEventListener("click", closeLightbox);
  $("#lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") closeLightbox();
  });
  $("#lightbox-prev").addEventListener("click", () => stepGallery(-1));
  $("#lightbox-next").addEventListener("click", () => stepGallery(1));
  document.addEventListener("keydown", (e) => {
    if ($("#lightbox").hidden) return;
    if (e.key === "Escape") closeLightbox();
    // Arrows page the set while it is open; the tabs' own arrow handlers check
    // for an open lightbox and stand down.
    else if (e.key === "ArrowLeft") stepGallery(-1);
    else if (e.key === "ArrowRight") stepGallery(1);
  });
}

/* -------------------------------------------------------------- clip picker */

const fmtDuration = (seconds) => {
  if (!seconds) return "";
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
};

// A grid of poster frames instead of a list of filenames. Cards are dragged onto
// the canvas — there is no selection to hold, so no <select> behind them.
function renderClipGrid(gridSel, items) {
  const grid = $(gridSel);
  grid.innerHTML = "";

  const addCard = (item) => {
    const card = document.createElement("div");
    card.className = "clip-card";
    card.dataset.path = item.path;
    card.tabIndex = 0;
    card.draggable = true;
    card.addEventListener("dragstart", (event) => startClipDrag(event, { kind: "video", item }));

    const media = document.createElement("div");
    media.className = "clip-media";
    {
      const poster = document.createElement("img");
      poster.loading = "lazy";
      poster.src = `${API}${item.poster || item.url}`;
      poster.alt = "";
      media.appendChild(poster);

      // The moving preview is created on hover and destroyed on leave: a dozen
      // permanent <video> elements in one grid is a dozen live decoders.
      let preview = null;
      const start = () => {
        if (preview) return;
        preview = document.createElement("video");
        preview.className = "clip-preview";
        preview.src = fileUrl(item);
        preview.muted = true;
        preview.loop = true;
        preview.playsInline = true;
        preview.currentTime = Math.max((item.duration || 0) * 0.35, 0.5);
        preview.play().catch(() => {});
        media.appendChild(preview);
      };
      const stop = () => {
        if (!preview) return;
        preview.pause();
        preview.remove();
        preview = null;
      };
      card.addEventListener("mouseenter", start);
      card.addEventListener("mouseleave", stop);

      const expand = document.createElement("button");
      expand.type = "button";
      expand.className = "clip-expand";
      expand.title = "Open large";
      expand.textContent = "⤢";
      expand.addEventListener("click", (e) => {
        e.stopPropagation();
        stop();
        openLightbox("video", fileUrl(item), `${item.name} · ${item.width}×${item.height} · ${fmtDuration(item.duration)}`);
      });
      media.appendChild(expand);
    }

    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = item.name;
    const meta = document.createElement("span");
    meta.className = "clip-meta";
    meta.textContent = [item.width && `${item.width}×${item.height}`, fmtDuration(item.duration)].filter(Boolean).join(" · ");

    card.append(media, name, meta);
    const add = () => addClipToCanvas(item);
    card.addEventListener("click", add);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        add();
      }
    });
    grid.appendChild(card);
  };

  for (const item of items) addCard(item);
}

// Stills for the video canvas. Only local files are offered: a stock photo has
// no path on this machine, and ffmpeg needs one at render.
function renderPhotoGrid() {
  const grid = $("#vid-photo-grid");
  // Two sources behind one shelf: the user's own drops, and the repo's real
  // marketing screenshots. Deleting the second kind costs the repo an asset, so
  // the confirm has to say which is which.
  const items = [
    ...state.library.photos.map((item) => ({ ...item, from: "studio/library/photos", mine: true })),
    ...state.library.appShots.map((item) => ({ ...item, from: "social-media-video (repo asset)", mine: false })),
  ];
  grid.innerHTML = "";
  $("#vid-photo-hint").textContent = items.length
    ? "Click a still to drop it on the canvas as its own layer."
    : "No stills yet — drop images below, or put screenshots in social-media-video/.";

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "clip-card";
    card.tabIndex = 0;
    card.draggable = true;
    card.addEventListener("dragstart", (event) => startClipDrag(event, { kind: "image", item }));

    const media = document.createElement("div");
    media.className = "clip-media";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = fileUrl(item);
    img.alt = "";
    media.appendChild(img);

    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "clip-expand";
    expand.title = "Open large";
    expand.textContent = "⤢";
    expand.addEventListener("click", (event) => {
      event.stopPropagation();
      openLightbox("image", fileUrl(item), item.name);
    });
    media.appendChild(expand);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "clip-remove";
    remove.title = `Move ${item.name} to the Trash`;
    remove.setAttribute("aria-label", `Delete ${item.name}`);
    remove.textContent = "✕";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      trashStill(item);
    });
    media.appendChild(remove);

    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = item.name;
    const meta = document.createElement("span");
    meta.className = "clip-meta";
    meta.textContent = item.size ? `${Math.max(Math.round(item.size / 1024), 1)} KB` : "image";

    card.append(media, name, meta);
    const add = () => addImageLayer(item);
    card.addEventListener("click", add);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        add();
      }
    });
    grid.appendChild(card);
  }
}

// Where a still or a GIF sits in time: from the playhead, for as long as the
// "Hold for" slider says. Running past the end grows the composition instead of
// clipping the layer, so the length asked for is the length you get.
function stillWindow() {
  const hold = Number($("#vid-still").value) || 3;
  const start = Number(editor.time.toFixed(2));
  const end = Number((start + hold).toFixed(2));
  if (end > editor.comp.duration) setCompDuration(end + 0.2);
  return { start, end };
}

// Goes to the Trash rather than being unlinked: half this shelf is the repo's
// own marketing screenshots, and a mis-click there should be undoable.
async function trashStill(item) {
  const where = item.mine ? "your library" : "the repo's marketing screenshots";
  if (
    !window.confirm(
      `Move ${item.name} to the Trash?\n\nIt comes from ${item.from} — ${where}.\nYou can put it back from the Trash if this was a mistake.`,
    )
  )
    return;
  try {
    await api("/library/trash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: item.path }),
    });
    await loadLibrary();
    renderPhotoGrid();
    toast(`${item.name} moved to the Trash`);
  } catch (error) {
    toast(`Could not delete: ${error.message}`);
  }
}

function addImageLayer(item, at) {
  editor.addLayer(
    imageLayer(
      { name: item.name, path: item.path, src: fileUrl(item) },
      { ...stillWindow(), ...(at ? centredBox(item, at) : {}), fit: "contain" },
    ),
  );
  showStage("edit");
  toast(`${item.name} added for ${$("#vid-still").value}s — drag its bar to move it`);
}

/* ------------------------------------------------------------------- gifs */

// A GIF is a still to the canvas and a looping clip to ffmpeg, so it gets its
// own layer type rather than being squeezed into either. Stickers carry real
// transparency, which is the reason to prefer them over plain GIFs on top of a
// video.
function gifLayer(item, at) {
  const box = at ? centredBox(item, at) : centredBox(item, { x: COMP_W / 2, y: COMP_H / 2 });
  return newLayer({
    type: "gif",
    name: item.name,
    path: item.path,
    src: fileUrl(item),
    fit: "contain",
    ...stillWindow(),
    ...box,
  });
}

function addGifLayer(item, at) {
  editor.addLayer(gifLayer(item, at));
  showStage("edit");
  toast(`${item.name} added for ${$("#vid-still").value}s — drag its bar to move it`);
}

function renderGifLibrary() {
  const grid = $("#gif-library");
  grid.innerHTML = "";
  const items = state.library.gifs || [];
  if (!items.length) {
    grid.innerHTML = `<p class="field-hint">Nothing saved yet — search above and download one.</p>`;
    return;
  }
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "clip-card";
    card.tabIndex = 0;
    card.draggable = true;
    card.addEventListener("dragstart", (event) => startClipDrag(event, { kind: "gif", item }));

    const media = document.createElement("div");
    media.className = "clip-media clip-media-gif";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = fileUrl(item);
    img.alt = "";
    media.appendChild(img);

    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = item.name;
    const meta = document.createElement("span");
    meta.className = "clip-meta";
    meta.textContent = item.width ? `${item.width}×${item.height}` : "gif";

    card.append(media, name, meta);
    const add = () => addGifLayer(item);
    card.addEventListener("click", add);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        add();
      }
    });
    grid.appendChild(card);
  }
}

async function searchGifs() {
  const query = $("#gif-query").value.trim();
  if (!query) return;
  const hint = $("#gif-hint");
  hint.textContent = "Searching…";
  try {
    const { results } = await api(`/gif/search?q=${encodeURIComponent(query)}&kind=${$("#gif-kind").value}`);
    const grid = $("#gif-results");
    grid.innerHTML = "";
    for (const item of results) {
      const card = document.createElement("div");
      card.className = "clip-card";

      const media = document.createElement("div");
      media.className = "clip-media clip-media-gif";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = item.thumb;
      img.alt = "";
      media.appendChild(img);

      const name = document.createElement("span");
      name.className = "clip-name";
      name.textContent = item.title;

      const save = document.createElement("button");
      save.type = "button";
      save.className = "button button-dark button-small";
      save.textContent = "Save";
      save.addEventListener("click", () => downloadGif(item, save));

      card.append(media, name, save);
      grid.appendChild(card);
    }
    hint.textContent = results.length ? `${results.length} results — Save one to put it in your library.` : "Nothing found.";
  } catch (error) {
    hint.textContent = error.message;
  }
}

async function downloadGif(item, button) {
  button.disabled = true;
  button.textContent = "…";
  $("#gif-progress").hidden = false;
  $("#gif-progress-note").textContent = `Saving ${item.title.slice(0, 40)}`;
  try {
    const { jobId } = await api("/gif/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...item, query: $("#gif-query").value.trim() }),
    });
    const result = await pollJob(jobId, (job) => {
      $("#gif-progress-fill").style.width = `${Math.round((job.progress || 0) * 100)}%`;
      $("#gif-progress-note").textContent = job.stage || job.status;
    });
    await loadLibrary();
    $("#gif-progress").hidden = true;
    button.textContent = "Saved";
    toast(`${result.name} saved — drag it onto the canvas`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Save";
    $("#gif-progress-note").textContent = error.message;
    toast(`Save failed: ${error.message}`);
  }
}

/* ------------------------------------------------------------ audio preview */

// One element for every audition on the page, so starting a second preview
// always stops the first.
let auditionEl = null;

function audition(src, button, label = "Play") {
  if (auditionEl) {
    auditionEl.pause();
    if (auditionEl.dataset.button) {
      const previous = document.getElementById(auditionEl.dataset.button);
      if (previous) previous.textContent = previous.dataset.label || "Play";
    }
    const wasSame = auditionEl.src === src;
    auditionEl = null;
    if (wasSame) return;
  }
  if (!src) return;
  auditionEl = new Audio(src);
  auditionEl.dataset.button = button.id;
  button.dataset.label = label;
  button.textContent = "Stop";
  auditionEl.addEventListener("ended", () => {
    button.textContent = label;
    auditionEl = null;
  });
  auditionEl.play().catch(() => {
    button.textContent = label;
    auditionEl = null;
  });
}

/* --------------------------------------------------------------- video tab */

let editor = null;
let timeline = null;

function currentVideoFormat() {
  return state.formats.videoFormats.find((f) => f.id === $("#vid-format").value) || state.formats.videoFormats[0];
}

const videoDuration = () => (editor ? editor.comp.duration : Number($("#vid-dur").value) || 20);

// The length is the composition's, and both controls that set it — the coarse
// slider and the exact number beside the timeline — go through here so they can
// never disagree. Layers that ran to the old end follow the new one; anything
// deliberately cut short keeps the length it was given.
function setCompDuration(seconds) {
  const duration = Math.max(2, Math.min(Number(seconds) || 20, 300));
  const previous = editor.comp.duration;
  editor.comp.duration = duration;
  for (const layer of editor.layers) {
    if (Math.abs((Number(layer.end) || 0) - previous) < 0.02) layer.end = duration;
    layer.end = Math.min(Number(layer.end) || 0, duration);
    layer.start = Math.min(Number(layer.start) || 0, Math.max(duration - 0.2, 0));
  }
  // The slider only spans the useful social-video range; a longer composition
  // set by hand pins it at its top rather than quietly shortening the render.
  const slider = $("#vid-dur");
  slider.value = String(Math.min(Math.max(duration, Number(slider.min)), Number(slider.max)));
  $("#vid-dur-out").textContent = `${duration}s`;
  const field = $("#tl-duration");
  if (field !== document.activeElement) field.value = String(duration);
  editor.seek(Math.min(editor.time, duration));
}

/* --------------------------------------------------------- dropping on canvas */

// Cards carry their library entry through the drag. dataTransfer only moves
// strings, so the item is serialised and read back on drop.
function startClipDrag(event, payload) {
  event.dataTransfer.setData("application/x-mackit-media", JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copy";
}

// Where a dropped clip lands. The first one is nearly always the bed, so it
// fills the frame; later ones arrive as a box centred on the pointer, sized to
// their own aspect so nothing is cropped on arrival.
function clipPlacement(item, at) {
  const empty = !editor.layers.some((l) => l.type === "video" || l.type === "image");
  if (empty || !at) {
    return empty
      ? { x: 0, y: 0, w: COMP_W, h: COMP_H, fit: "cover" }
      : centredBox(item, { x: COMP_W / 2, y: COMP_H / 2 });
  }
  return centredBox(item, at);
}

function centredBox(item, at) {
  const ratio = item.width && item.height ? item.width / item.height : 16 / 9;
  const w = Math.round(COMP_W * 0.58);
  const h = Math.round(w / ratio);
  return {
    x: Math.round(at.x - w / 2),
    y: Math.round(at.y - h / 2),
    w,
    h,
    fit: "cover",
  };
}

function addClipToCanvas(item, at) {
  const layer = editor.addLayer(
    newLayer({
      type: "video",
      name: item.name,
      path: item.path,
      src: fileUrl(item),
      end: editor.comp.duration,
      volume: 0,
      ...clipPlacement(item, at),
    }),
  );
  showStage("edit");
  toast(`${item.name} added — drag to move, corners to resize`);
  return layer;
}

// The canvas itself is the drop target. Coordinates come back through the same
// mapping the pointer uses, so a clip lands under the cursor rather than near it.
function wireCanvasDrop() {
  const stage = $("#stage-edit");
  const over = (event) => {
    if (!event.dataTransfer.types.includes("application/x-mackit-media")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    stage.classList.add("is-drop-target");
  };
  stage.addEventListener("dragover", over);
  stage.addEventListener("dragenter", over);
  stage.addEventListener("dragleave", (event) => {
    if (event.target === stage) stage.classList.remove("is-drop-target");
  });
  stage.addEventListener("drop", (event) => {
    const raw = event.dataTransfer.getData("application/x-mackit-media");
    if (!raw) return;
    event.preventDefault();
    stage.classList.remove("is-drop-target");
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const at = editor.toComposition(event);
    if (payload.kind === "image") addImageLayer(payload.item, at);
    else if (payload.kind === "gif") addGifLayer(payload.item, at);
    else addClipToCanvas(payload.item, at);
  });
}

// Captions replace the previous set rather than stacking on top of it, so
// rewriting the script twice does not leave two generations of text on screen.
async function putCaptionsOnCanvas() {
  const hook = $("#vid-hook").value.trim();
  const lines = $("#vid-lines").value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!hook && !lines.length) return toast("Write a hook or some caption lines first");

  editor.comp.layers = editor.layers.filter((l) => l.type !== "text" || !l.isCaption);
  const duration = editor.comp.duration;
  const style = $("#vid-style").value;
  const fontSize = Number($("#vid-fs").value) || 68;
  const y = Number($("#vid-cy").value);

  const hookEnd = hook ? Math.min(2.4, duration * 0.4) : 0;
  if (hook) {
    editor.layers.push(
      textLayer(hook, {
        isCaption: true,
        style,
        fontSize: Math.round(fontSize * 1.1),
        x: 90,
        y: Math.round(COMP_H * 0.22),
        w: COMP_W - 180,
        start: 0,
        end: hookEnd,
      }),
    );
  }

  const cards = splitIntoCards(lines, Number($("#vid-wpc").value) || 3).map((text) =>
    textLayer(text, { isCaption: true, style, fontSize, x: 90, y: Math.round(COMP_H * y), w: COMP_W - 180 }),
  );
  timeTextLayers(cards, hookEnd, Math.max(duration - 0.15, hookEnd + 0.5));
  editor.layers.push(...cards);

  editor.syncMedia();
  editor.select(null);
  editor.draw();
  refreshLayerList();
  showStage("edit");
  toast(`${cards.length + (hook ? 1 : 0)} captions on the canvas`);
}

// The script, spoken, dropped on the timeline as its own track. It goes in at
// the playhead so a second take lands where you are looking, and the
// composition grows if the read runs past the end — a voiceover cut off
// mid-sentence is never what anyone wanted.
async function addVoiceover() {
  const hook = $("#vid-hook").value.trim();
  const lines = $("#vid-lines").value.split("\n").map((l) => l.trim()).filter(Boolean);
  const text = [hook, ...lines].filter(Boolean).join(". ");
  if (!text) return toast("Write a hook or some caption lines first");

  const button = $("#vid-voiceover");
  button.disabled = true;
  button.textContent = "Speaking…";
  $("#vid-vo-progress").hidden = false;
  $("#vid-vo-note").textContent = "Synthesising…";

  try {
    const { jobId } = await api("/voiceover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: $("#vid-voice").value, name: hook || lines[0] }),
    });
    const result = await pollJob(jobId, (job) => {
      $("#vid-vo-note").textContent = job.stage || job.status;
    });

    const start = Number(editor.time.toFixed(2));
    if (start + result.duration > editor.comp.duration) setCompDuration(start + result.duration + 0.3);
    editor.addLayer(
      audioLayer(
        { name: result.name, path: result.path, src: `${API}${result.url}`, duration: result.duration },
        { start, end: Number((start + result.duration).toFixed(3)) },
      ),
    );
    await loadLibrary();
    $("#vid-vo-progress").hidden = true;
    showStage("edit");
    toast(`Voiceover added — ${result.duration.toFixed(1)}s. Drag its bar to move it, its edges to trim.`);
  } catch (error) {
    $("#vid-vo-note").textContent = error.message;
    toast(`Voiceover failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Speak the script";
  }
}

/* ---------------------------------------------------------- timeline actions */

// A razor at the playhead. The two halves stay in the stack next to each other
// so the cut reads as one clip in two pieces rather than a new layer on top.
function splitSelected() {
  const layer = editor.selected;
  if (!layer) return toast("Select a layer first");
  const tail = splitLayerAt(layer, editor.time);
  if (!tail) return toast("Put the playhead inside the layer to cut it");
  editor.layers.splice(editor.layers.indexOf(layer) + 1, 0, tail);
  editor.syncMedia();
  editor.select(tail.id);
  refreshLayerList(true);
  toast(`Cut at ${editor.time.toFixed(1)}s`);
}

// Duplicating lands the copy after the original rather than on top of it, which
// is what extending a clip to fill the rest of the composition actually needs.
function duplicateSelected() {
  const layer = editor.selected;
  if (!layer) return toast("Select a layer first");
  const span = Math.max((Number(layer.end) || 0) - (Number(layer.start) || 0), 0.5);
  const start = Math.min(Number(layer.end) || 0, Math.max(editor.comp.duration - 0.5, 0));
  editor.addLayer(newLayer({ ...layer, id: uid(), start, end: Math.min(start + span, editor.comp.duration) }));
  toast("Duplicated");
}

// Text added from the timeline starts at the playhead and runs for a readable
// beat, so "how long is this on screen" is a bar to drag rather than a number to
// guess at.
function addTextAtPlayhead() {
  const start = Number(editor.time.toFixed(2));
  editor.addLayer(
    textLayer("New text", {
      style: $("#vid-style").value,
      fontSize: Number($("#vid-fs").value) || 68,
      y: Math.round(COMP_H * 0.45),
      start,
      end: Math.min(start + 2.5, editor.comp.duration),
    }),
  );
}

/* ------------------------------------------------------------- layer list UI */

let layerSignature = "";

function refreshLayerList(force = false) {
  const signature = editor.layers.map((l) => `${l.id}:${l.visible}:${l.name}`).join("|") + `#${editor.selectedId}`;
  if (!force && signature === layerSignature) return;
  layerSignature = signature;

  const list = $("#layer-list");
  list.innerHTML = "";
  // Topmost first, the way the stack reads on screen.
  for (let i = editor.layers.length - 1; i >= 0; i--) {
    const layer = editor.layers[i];
    const li = document.createElement("li");
    li.className = `layer-row${layer.id === editor.selectedId ? " is-active" : ""}`;

    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "layer-eye";
    eye.textContent = layer.visible ? "◉" : "○";
    eye.title = layer.visible ? "Hide" : "Show";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      editor.updateLayer(layer.id, { visible: !layer.visible });
      refreshLayerList(true);
    });

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = layer.type === "text" ? `“${layer.text}”` : layer.name;

    const kind = document.createElement("span");
    kind.className = "layer-kind";
    kind.textContent = layer.type;

    li.append(eye, name, kind);
    li.addEventListener("click", () => editor.select(layer.id));
    list.appendChild(li);
  }
}

const inspectorIds = [
  "#insp-text", "#insp-style", "#insp-fontsize", "#insp-x", "#insp-y", "#insp-w", "#insp-h",
  "#insp-fit", "#insp-blur", "#insp-volume", "#insp-start", "#insp-end", "#insp-trim",
];

function syncInspector() {
  const layer = editor.selected;
  $("#layer-inspector").hidden = !layer;
  $("#layer-empty").hidden = Boolean(layer);
  if (!layer) return;

  const isText = layer.type === "text";
  $("#insp-text-field").hidden = !isText;
  $("#insp-text-style").hidden = !isText;
  $("#insp-clip-row").hidden = isText;
  $("#insp-h-field").hidden = isText;
  $("#insp-trim-field").hidden = layer.type !== "video";

  const set = (sel, value) => {
    const el = $(sel);
    // Never overwrite the field the user is typing in.
    if (el === document.activeElement) return;
    el.value = String(value);
  };
  set("#insp-text", layer.text || "");
  set("#insp-style", layer.style || "outline");
  set("#insp-fontsize", layer.fontSize || 68);
  set("#insp-x", Math.round(layer.x));
  set("#insp-y", Math.round(layer.y));
  set("#insp-w", Math.round(layer.w));
  set("#insp-h", Math.round(layer.h));
  set("#insp-fit", layer.fit || "cover");
  set("#insp-blur", layer.blur || 0);
  set("#insp-volume", layer.volume || 0);
  set("#insp-start", layer.start || 0);
  set("#insp-end", layer.end || 0);
  set("#insp-trim", layer.trim || 0);

  $("#insp-fontsize-out").textContent = String(Math.round(layer.fontSize || 68));
  $("#insp-blur-out").textContent = String(Math.round(layer.blur || 0));
  $("#insp-volume-out").textContent = Number(layer.volume || 0).toFixed(2);
  $("#insp-start-out").textContent = `${Number(layer.start || 0).toFixed(1)}s`;
  $("#insp-end-out").textContent = `${Number(layer.end || 0).toFixed(1)}s`;
  $("#insp-trim-out").textContent = `${Math.round(layer.trim || 0)}s`;
}

function wireInspector() {
  const apply = (sel, prop, cast = Number) =>
    $(sel).addEventListener("input", () => {
      const layer = editor.selected;
      if (!layer) return;
      editor.updateLayer(layer.id, { [prop]: cast($(sel).value) });
    });

  apply("#insp-text", "text", String);
  apply("#insp-style", "style", String);
  apply("#insp-fontsize", "fontSize");
  apply("#insp-x", "x");
  apply("#insp-y", "y");
  apply("#insp-w", "w");
  apply("#insp-h", "h");
  apply("#insp-fit", "fit", String);
  apply("#insp-blur", "blur");
  apply("#insp-volume", "volume");
  apply("#insp-start", "start");
  apply("#insp-end", "end");
  apply("#insp-trim", "trim");

  // Geometry that is fiddly to drag by hand and exact when clicked.
  const geometry = (props) => {
    const layer = editor.selected;
    if (!layer) return;
    editor.updateLayer(layer.id, typeof props === "function" ? props(layer) : props);
  };
  $("#insp-fill").addEventListener("click", () => geometry({ x: 0, y: 0, w: COMP_W, h: COMP_H }));
  $("#insp-center").addEventListener("click", () =>
    geometry((layer) => ({ x: Math.round((COMP_W - layer.w) / 2), y: Math.round((COMP_H - layer.h) / 2) })),
  );
  $("#insp-half-top").addEventListener("click", () => geometry({ x: 0, y: 0, w: COMP_W, h: COMP_H / 2 }));
  $("#insp-half-bottom").addEventListener("click", () => geometry({ x: 0, y: COMP_H / 2, w: COMP_W, h: COMP_H / 2 }));

  $("#layer-add-text").addEventListener("click", addTextAtPlayhead);
  $("#layer-up").addEventListener("click", () => editor.selectedId && editor.moveLayer(editor.selectedId, 1));
  $("#layer-down").addEventListener("click", () => editor.selectedId && editor.moveLayer(editor.selectedId, -1));
  $("#layer-delete").addEventListener("click", () => editor.selectedId && editor.removeLayer(editor.selectedId));
}

/* ------------------------------------------------------------------- staging */

function showStage(mode) {
  $("#stage-edit").hidden = mode !== "edit";
  $("#stage-result").hidden = mode !== "result";
  $("#stage-mode-edit").classList.toggle("is-current", mode === "edit");
  $("#stage-mode-result").classList.toggle("is-current", mode === "result");
  if (mode === "result") editor.pause();
}

function onEditorChange() {
  // The "drag a clip here" prompt is only right while the canvas is genuinely
  // empty; a composition of nothing but captions still needs it.
  const empty = !editor.layers.some((l) => l.type === "video" || l.type === "image");
  $("#stage-empty").hidden = !empty;

  const label = editor.playing ? "Pause" : "Play";
  $("#stage-play").textContent = label;
  $("#tl-play").textContent = label;
  $("#stage-time").textContent = `${editor.time.toFixed(1)}s`;
  const scrub = $("#stage-scrub");
  scrub.max = String(editor.comp.duration);
  if (scrub !== document.activeElement) scrub.value = String(editor.time);
  refreshLayerList();
  syncInspector();
  if (timeline) timeline.sync();
}

/* -------------------------------------------------------------- script copy */

function applyVideoCopy(result) {
  $("#vid-hook").value = result.hook || "";
  $("#vid-lines").value = (result.lines || []).join("\n");
  if (result.caption) $("#vid-caption").value = result.caption;
  if (result.hashtags) $("#vid-hashtags").value = result.hashtags.join(" ");
}

async function generateVideoCopy(useModel) {
  const format = currentVideoFormat();
  const topic = $("#vid-topic").value.trim();
  const button = useModel ? $("#vid-generate") : $("#vid-offline");
  button.disabled = true;
  button.textContent = useModel ? "Writing…" : "Filling…";
  try {
    if (useModel) {
      const result = await modelCopy({ kind: "video", format: { label: format.label, brief: format.brief }, slideCount: format.lines, topic });
      applyVideoCopy(result);
      toast(`${result.model || PROVIDER_LABELS[result.source] || "The model"} wrote the script`);
    } else {
      applyVideoCopy(offlineVideoCopy({ format, topic }));
      toast("Script filled from templates");
    }
  } catch (error) {
    if (error.status === 428) {
      toast("No model key configured — falling back to templates");
      applyVideoCopy(offlineVideoCopy({ format, topic }));
    } else {
      toast(`Script failed: ${error.message}`);
    }
  } finally {
    button.disabled = false;
    button.textContent = useModel ? writerLabel() : "Use templates";
  }
}

/* ------------------------------------------------------------ footage finder */

function renderFootageResults(results) {
  const grid = $("#foot-grid");
  grid.innerHTML = "";
  for (const item of results) {
    const card = document.createElement("article");
    card.className = "foot-card";

    const img = document.createElement("img");
    img.src = item.thumb;
    img.loading = "lazy";
    img.alt = "";

    const body = document.createElement("div");
    body.className = "foot-body";
    const title = document.createElement("span");
    title.className = "foot-title";
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.className = "foot-meta";
    const mins = item.duration ? `${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, "0")}` : "—";
    meta.textContent = [item.views ? `${item.views.toLocaleString()} views` : item.channel, mins].filter(Boolean).join(" · ");

    const add = document.createElement("button");
    add.type = "button";
    add.className = "button button-dark button-small";
    add.textContent = "Watch & pick";
    add.addEventListener("click", () => openFootagePreview(item));

    body.append(title, meta, add);
    card.append(img, body);
    grid.appendChild(card);
  }
}

async function searchFootage(query) {
  const q = (query || $("#foot-query").value).trim();
  if (!q) return;
  $("#foot-query").value = q;
  $("#foot-hint").textContent = "Searching…";
  try {
    const { results } = await api(`/footage/search?q=${encodeURIComponent(q)}&source=${$("#foot-source").value}&limit=12`);
    renderFootageResults(results);
    $("#foot-hint").textContent = results.length
      ? `${results.length} results, most viewed first. Downloads land in studio/library/videos/.`
      : "Nothing found — try different words.";
  } catch (error) {
    $("#foot-hint").textContent = `Search failed: ${error.message}`;
  }
}

/* ------------------------------------------------------- footage preview -- */

// Choosing a slice by typing "01:00" at a video you have never seen is a guess.
// This plays the candidate and lets you mark the in and out points off the
// playhead, which is the only way to know the 35 seconds you are keeping are
// the interesting 35 seconds.
//
// YouTube will not let a page read a plain iframe's clock, so the embed is
// created through the IFrame Player API — the whole reason it is loaded. A
// Pexels result is a direct file, so a <video> element answers on its own.

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const parseClock = (text) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((text || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const preview = { item: null, kind: null, player: null, video: null };

let ytReady = null;
function youtubeApi() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => reject(new Error("Could not load the YouTube player"));
    document.head.appendChild(tag);
  });
  return ytReady;
}

// Whatever is playing, in seconds.
function previewTime() {
  if (preview.kind === "youtube" && preview.player) return preview.player.getCurrentTime() || 0;
  if (preview.video) return preview.video.currentTime || 0;
  return 0;
}

function previewDuration() {
  if (preview.kind === "youtube" && preview.player) return preview.player.getDuration() || 0;
  if (preview.video) return preview.video.duration || 0;
  return preview.item?.duration || 0;
}

function renderRangeNote() {
  const from = parseClock($("#foot-from").value);
  const len = Number($("#foot-len").value);
  const note = $("#foot-range-note");
  if (from === null || !len) {
    note.textContent = "Set a start and a length.";
    return;
  }
  const total = previewDuration();
  const past = total && from + len > total + 1;
  note.textContent = past
    ? `${clock(from)} → ${clock(from + len)} runs past the end of the clip (${clock(total)}).`
    : `Keeping ${clock(from)} → ${clock(from + len)} · ${len}s`;
}

function closeFootagePreview() {
  if (preview.player && preview.player.destroy) preview.player.destroy();
  preview.player = null;
  preview.video = null;
  preview.item = null;
  $("#foot-stage").innerHTML = "";
  $("#foot-preview").hidden = true;
}

async function openFootagePreview(item) {
  closeFootagePreview();
  preview.item = item;
  preview.kind = item.provider === "youtube" ? "youtube" : "direct";
  $("#foot-preview").hidden = false;
  $("#foot-preview-title").textContent = item.title;
  const stage = $("#foot-stage");

  if (preview.kind === "youtube") {
    stage.innerHTML = '<div id="foot-yt"></div>';
    try {
      const YT = await youtubeApi();
      preview.player = new YT.Player("foot-yt", {
        videoId: item.id,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
        events: { onReady: renderRangeNote },
      });
    } catch (error) {
      stage.innerHTML = `<p class="field-hint">${error.message}. Type the range by hand below.</p>`;
    }
  } else {
    const video = document.createElement("video");
    video.src = item.url;
    video.controls = true;
    video.preload = "metadata";
    video.addEventListener("loadedmetadata", renderRangeNote);
    stage.appendChild(video);
    preview.video = video;
  }
  renderRangeNote();
}

function wireFootagePreview() {
  $("#foot-preview-close").addEventListener("click", closeFootagePreview);

  $("#foot-mark-in").addEventListener("click", () => {
    $("#foot-from").value = clock(previewTime());
    renderRangeNote();
  });

  // Marking the end sets the length rather than a second timestamp, because
  // that is what yt-dlp and the rest of the page already work in.
  $("#foot-mark-out").addEventListener("click", () => {
    const from = parseClock($("#foot-from").value);
    const at = previewTime();
    if (from === null || at <= from) {
      toast("Mark the start first, then play on and mark the end.");
      return;
    }
    $("#foot-len").value = Math.max(1, Math.round(at - from));
    renderRangeNote();
  });

  for (const id of ["#foot-from", "#foot-len"]) $(id).addEventListener("input", renderRangeNote);

  // downloadFootage leaves its button reading "In library", which is right for
  // a card that stands for one clip and wrong for the one shared button here.
  $("#foot-grab").addEventListener("click", async (event) => {
    if (!preview.item) return;
    const button = event.currentTarget;
    await downloadFootage(preview.item, button);
    button.disabled = false;
    button.textContent = "Download this slice";
  });
}

// yt-dlp takes a section as *start-end; the page works in "from + length"
// because that is how you actually think about grabbing a piece of a long clip.
function footageSection() {
  const from = $("#foot-from").value.trim();
  const seconds = Number($("#foot-len").value);
  if (!/^\d{1,2}:\d{2}$/.test(from) || !seconds) return "";
  const [m, sec] = from.split(":").map(Number);
  const startAt = m * 60 + sec;
  const stamp = (t) =>
    `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  return `${stamp(startAt)}-${stamp(startAt + seconds)}`;
}

async function downloadFootage(item, button) {
  button.disabled = true;
  button.textContent = "…";
  $("#foot-progress").hidden = false;
  $("#foot-progress-note").textContent = `Downloading ${item.title.slice(0, 50)}`;
  try {
    const { jobId } = await api("/footage/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...item, query: $("#foot-query").value.trim(), section: item.direct ? "" : footageSection() }),
    });
    const result = await pollJob(jobId, (job) => {
      $("#foot-progress-fill").style.width = `${Math.round((job.progress || 0) * 100)}%`;
      $("#foot-progress-note").textContent = job.stage || job.status;
    });
    await loadLibrary();
    $("#foot-progress").hidden = true;
    button.textContent = "In library";
    toast(`${result.name} added — drag it onto the canvas from Clips`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Download";
    $("#foot-progress-note").textContent = error.message;
    toast(`Download failed: ${error.message}`);
  }
}

async function suggestFootageQueries() {
  const button = $("#foot-suggest");
  button.disabled = true;
  button.textContent = "Thinking…";
  try {
    const { queries } = await api("/footage/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: $("#foot-prompt").value.trim() || $("#vid-topic").value.trim() }),
    });
    const row = $("#foot-queries");
    row.innerHTML = "";
    for (const query of queries) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "query-chip";
      chip.textContent = query;
      chip.addEventListener("click", () => searchFootage(query));
      row.appendChild(chip);
    }
    if (queries.length) searchFootage(queries[0]);
  } catch (error) {
    toast(`Could not suggest searches: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Suggest searches";
  }
}

/* ------------------------------------------------------------------ projects */

// What gets written beside the mp4. Layers keep their absolute `path` but drop
// `src`, which is only a URL onto this server and is rebuilt on the way back
// in — a project that hard-codes a port stops opening the day the port moves.
function currentProject() {
  return {
    derivedFrom: state.video.derivedFrom || null,
    duration: editor.comp.duration,
    layers: editor.layers.map(({ src, ...layer }) => layer),
    script: {
      format: currentVideoFormat().id,
      hook: $("#vid-hook").value,
      lines: $("#vid-lines").value,
      topic: $("#vid-topic").value,
    },
    captions: {
      style: $("#vid-style").value,
      fontSize: Number($("#vid-fs").value),
      wordsPerCard: Number($("#vid-wpc").value),
      y: Number($("#vid-cy").value),
    },
    audio: {
      musicPath: $("#vid-music").value || "",
      musicVolume: Number($("#vid-musicvol").value),
      voice: $("#vid-voice").value,
    },
    caption: $("#vid-caption").value,
    hashtags: $("#vid-hashtags").value,
  };
}

function applyProject(project, sourceLabel) {
  const layers = (project.layers || []).map((layer) =>
    layer.path ? { ...layer, src: `${API}/file?p=${encodeURIComponent(layer.path)}` } : { ...layer },
  );
  editor.setComposition({ duration: project.duration || 20, layers });
  setCompDuration(project.duration || 20);

  const script = project.script || {};
  if (script.format) $("#vid-format").value = script.format;
  $("#vid-hook").value = script.hook || "";
  $("#vid-lines").value = script.lines || "";
  $("#vid-topic").value = script.topic || "";
  $("#vid-format").dispatchEvent(new Event("change"));

  const caps = project.captions || {};
  if (caps.style) $("#vid-style").value = caps.style;
  if (caps.fontSize) $("#vid-fs").value = String(caps.fontSize);
  if (caps.wordsPerCard) $("#vid-wpc").value = String(caps.wordsPerCard);
  if (caps.y) $("#vid-cy").value = String(caps.y);

  const audio = project.audio || {};
  if (audio.musicPath) $("#vid-music").value = audio.musicPath;
  if (audio.musicVolume !== undefined) $("#vid-musicvol").value = String(audio.musicVolume);
  if (audio.voice) $("#vid-voice").value = audio.voice;

  $("#vid-caption").value = project.caption || "";
  $("#vid-hashtags").value = project.hashtags || "";
  for (const input of ["#vid-wpc", "#vid-fs", "#vid-cy", "#vid-musicvol"]) $(input).dispatchEvent(new Event("input"));

  // Rendering this again writes a new folder; the original is never touched.
  state.video.derivedFrom = project.slug || sourceLabel || null;
  showTab("video");
  showStage("edit");
  if (layers.length) editor.select(layers[layers.length - 1].id);
  toast(`Opened ${sourceLabel || project.slug || "project"} — rendering again saves a new copy`);
}

async function openProjectFromPath(path, label) {
  try {
    const res = await fetch(`${API}/file?p=${encodeURIComponent(path)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`could not read the project file (${res.status})`);
    applyProject(await res.json(), label);
  } catch (error) {
    toast(`Open failed: ${error.message}`);
  }
}

function wireProjectImport() {
  $("#vid-open-input").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      applyProject(JSON.parse(await file.text()), file.name);
    } catch (error) {
      toast(`That is not a project file: ${error.message}`);
    }
    event.target.value = "";
  });
}

/* -------------------------------------------------------------------- render */

// Polls one job to completion. Both rendering and footage downloads use it.
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
  });
}

// Freezes the canvas into something ffmpeg can rebuild: every clip carries the
// crop and rect the editor drew, every text layer becomes the exact PNG it
// painted. Nothing downstream re-derives geometry, so the file matches the
// preview.
async function serializeComposition() {
  const layers = [];
  const missing = [];
  for (const layer of editor.layers) {
    if (!layer.visible) continue;
    if (layer.type === "text") {
      layers.push({ type: "text", start: layer.start, end: layer.end, opacity: layer.opacity ?? 1, png: await textLayerToPng(layer) });
      continue;
    }
    // Sound has no geometry to freeze, only a window and a level.
    if (layer.type === "audio") {
      layers.push({
        type: "audio",
        path: layer.path,
        start: layer.start,
        end: layer.end,
        trim: layer.trim || 0,
        volume: layer.volume ?? 1,
      });
      continue;
    }
    const size = editor.sourceSize(layer);
    if (!size.w || !size.h) {
      missing.push(layer.name);
      continue;
    }
    const { crop, rect } = fitLayer(layer, size.w, size.h);
    layers.push({
      type: layer.type,
      path: layer.path,
      crop,
      rect,
      blur: layer.blur || 0,
      opacity: layer.opacity ?? 1,
      start: layer.start,
      end: layer.end,
      trim: layer.trim || 0,
      volume: layer.volume || 0,
    });
  }
  return { layers, missing };
}

async function renderVideo() {
  if (!editor.layers.length) return toast("The canvas is empty — build it first");
  const button = $("#vid-render");
  button.disabled = true;
  editor.pause();
  $("#vid-progress").hidden = false;
  $("#vid-progress-fill").style.width = "0%";
  $("#vid-progress-note").textContent = "Freezing the canvas…";

  try {
    const { layers, missing } = await serializeComposition();
    if (missing.length) toast(`Still loading, skipped: ${missing.join(", ")}`);
    if (!layers.length) throw new Error("nothing to render");

    const spec = {
      id: $("#vid-hook").value || currentVideoFormat().id,
      duration: editor.comp.duration,
      layers,
      musicPath: $("#vid-music").value || "",
      musicVolume: Number($("#vid-musicvol").value),
      caption: $("#vid-caption").value,
      hashtags: $("#vid-hashtags").value.trim().split(/[\s,]+/).filter(Boolean),
      project: currentProject(),
    };

    const { jobId } = await api("/render-video", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });
    const result = await pollJob(jobId, (job) => {
      $("#vid-progress-fill").style.width = `${Math.round((job.progress || 0) * 100)}%`;
      $("#vid-progress-note").textContent = job.stage || job.status;
      if (job.command) {
        $("#vid-cmd").hidden = false;
        $("#vid-cmd").textContent = job.command;
      }
    });

    const player = $("#vid-player");
    player.src = `${API}${result.url}`;
    player.load();
    $("#stage-mode-result").disabled = false;
    showStage("result");
    $("#vid-preview-label").textContent = `Rendered · ${result.duration.toFixed(1)}s`;
    // Everything rendered from here on is a further version of this one.
    state.video.derivedFrom = result.slug || null;
    toast(`Rendered to ${result.slug || "out"}/ — the project is saved beside it`);
    loadOutput();
  } catch (error) {
    $("#vid-progress-note").textContent = error.message;
    toast(`Render failed: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

/* ---------------------------------------------------------------------- wire */

function wireVideoTab() {
  fillSelect($("#vid-format"), state.formats.videoFormats, { value: (f) => f.id, label: (f) => f.label });
  fillSelect($("#vid-style"), Object.entries(TEXT_STYLES), { value: ([k]) => k, label: ([, v]) => v.label });
  fillSelect($("#insp-style"), Object.entries(TEXT_STYLES), { value: ([k]) => k, label: ([, v]) => v.label });
  $("#vid-style").value = "outline";

  editor = new Editor($("#stage-canvas"), { onChange: onEditorChange });
  editor.setComposition({ duration: Number($("#vid-dur").value) || 20, layers: [] });
  timeline = new Timeline(
    {
      gutter: $("#tl-gutter"),
      gutterScroll: $("#tl-gutter-scroll"),
      scroll: $("#tl-scroll"),
      canvas: $("#tl-canvas"),
      ruler: $("#tl-ruler"),
      lanes: $("#tl-lanes"),
      playhead: $("#tl-playhead"),
      zoom: $("#tl-zoom"),
      time: $("#tl-time"),
    },
    editor,
    { onChange: onEditorChange },
  );
  wireInspector();

  $("#tl-play").addEventListener("click", () => editor.toggle());
  $("#tl-split").addEventListener("click", splitSelected);
  $("#tl-duplicate").addEventListener("click", duplicateSelected);
  $("#tl-add-text").addEventListener("click", addTextAtPlayhead);
  $("#tl-delete").addEventListener("click", () => {
    const ids = timeline.selection();
    if (!ids.length) return toast("Tick some layers, or select one");
    // Only a bulk removal is worth a confirm; deleting the one layer you have
    // selected is a click you can undo by adding it again.
    if (ids.length > 1 && !window.confirm(`Delete ${ids.length} layers from the canvas?`)) return;
    for (const id of ids) editor.removeLayer(id);
    timeline.clearChecks();
    toast(ids.length > 1 ? `${ids.length} layers deleted` : "Layer deleted");
  });
  // The lanes are sized from the visible width, which is not known until the
  // panel is on screen and changes with the window.
  window.addEventListener("resize", () => timeline.sync());

  const showBrief = () => {
    $("#vid-format-brief").textContent = currentVideoFormat().brief;
  };
  $("#vid-format").addEventListener("change", showBrief);
  showBrief();

  $("#vid-captions").addEventListener("click", putCaptionsOnCanvas);
  $("#vid-voiceover").addEventListener("click", addVoiceover);
  $("#vid-generate").addEventListener("click", () => generateVideoCopy(true));
  $("#vid-offline").addEventListener("click", () => generateVideoCopy(false));
  $("#vid-render").addEventListener("click", renderVideo);

  // Arrow keys nudge the selection; shift makes it ten pixels. Text fields keep
  // their own arrow behaviour.
  document.addEventListener("keydown", (e) => {
    if (!$('.tab-panel[data-panel="video"]').classList.contains("is-active")) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (e.key === " ") {
      if (tag === "BUTTON") return;
      editor.toggle();
      e.preventDefault();
    } else if (e.key === "s" || e.key === "S") {
      splitSelected();
      e.preventDefault();
    } else if (moves[e.key] && editor.nudge(...moves[e.key])) e.preventDefault();
    else if (e.key === "Backspace" || e.key === "Delete") {
      if (editor.selectedId) {
        editor.removeLayer(editor.selectedId);
        e.preventDefault();
      }
    }
  });

  wireCanvasDrop();
  wireProjectImport();
  $("#stage-play").addEventListener("click", () => editor.toggle());
  $("#stage-scrub").addEventListener("input", (e) => editor.seek(Number(e.target.value)));
  $("#stage-mode-edit").addEventListener("click", () => showStage("edit"));
  $("#stage-mode-result").addEventListener("click", () => showStage("result"));

  $("#vid-music-preview").addEventListener("click", (e) => {
    const path = $("#vid-music").value;
    if (!path) return toast("Pick a music track first");
    audition(`${API}/file?p=${encodeURIComponent(path)}`, e.currentTarget, "Play");
  });
  $("#vid-voice-preview").addEventListener("click", (e) => {
    const line = $("#vid-hook").value.trim() || "Fourteen menu bar apps became one.";
    audition(`${API}/voice-preview?voice=${encodeURIComponent($("#vid-voice").value)}&text=${encodeURIComponent(line)}`, e.currentTarget, "Hear it");
  });

  $("#gif-go").addEventListener("click", searchGifs);
  $("#gif-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchGifs();
  });

  $("#foot-suggest").addEventListener("click", suggestFootageQueries);
  $("#foot-go").addEventListener("click", () => searchFootage());
  $("#foot-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchFootage();
  });

  const bind = (input, out, format) => {
    const sync = () => {
      $(out).textContent = format(Number($(input).value));
    };
    $(input).addEventListener("input", sync);
    sync();
  };
  bind("#vid-wpc", "#vid-wpc-out", (v) => String(v));
  bind("#vid-fs", "#vid-fs-out", (v) => String(v));
  bind("#vid-cy", "#vid-cy-out", (v) => v.toFixed(2));
  bind("#vid-musicvol", "#vid-musicvol-out", (v) => v.toFixed(2));

  $("#vid-dur").addEventListener("input", (event) => setCompDuration(event.target.value));
  $("#tl-duration").addEventListener("change", (event) => setCompDuration(event.target.value));
  setCompDuration(Number($("#vid-dur").value) || 20);

  // Images are filed with the photos, clips and music with the videos, so one
  // drop zone can take whatever is dragged onto it.
  wireDropZone(
    $("#video-drop"),
    $("#video-input"),
    (file) => (file.type.startsWith("image/") ? "photos" : file.type.startsWith("audio/") ? "music" : "videos"),
    // The stills shelf is built from the library, so it has to be redrawn once
    // an upload lands or a dropped image is invisible until the next reload.
    () => renderPhotoGrid(),
  );

  const holdOut = () => {
    $("#vid-still-out").textContent = `${Number($("#vid-still").value)}s`;
  };
  $("#vid-still").addEventListener("input", holdOut);
  holdOut();
  showStage("edit");
}

/* ------------------------------------------------------------------- output */

// Deleting a render takes the folder with it — video, caption and project. The
// confirm says so in as many words, because there is no undo behind this and
// nothing goes to the Trash to be fished back out.
async function deleteOutput(item, card) {
  const target = item.dir || item.path;
  const what = item.kind === "video" ? "video, its caption and its project file" : "slides and caption";
  if (!window.confirm(`Delete ${item.name}?\n\nThis removes the ${what} from disk permanently. It cannot be undone.`)) return;
  try {
    await api("/out/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    card.remove();
    toast(`${item.name} deleted`);
    if (!$("#out-list").children.length) loadOutput();
  } catch (error) {
    toast(`Could not delete: ${error.message}`);
  }
}

async function loadOutput() {
  const list = $("#out-list");
  try {
    const { items } = await api("/out");
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = `<p class="field-hint">Nothing rendered yet.</p>`;
      return;
    }
    for (const item of items) {
      const card = document.createElement("article");
      card.className = "out-card";

      const trash = document.createElement("button");
      trash.type = "button";
      trash.className = "out-trash";
      trash.title = "Delete permanently";
      trash.setAttribute("aria-label", `Delete ${item.name}`);
      trash.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';
      trash.addEventListener("click", () => deleteOutput(item, card));
      card.appendChild(trash);

      const media = document.createElement("div");
      media.className = "out-card-media";
      if (item.kind === "video") {
        const video = document.createElement("video");
        video.src = fileUrl(item);
        video.controls = true;
        video.preload = "metadata";
        // Without a poster the card is a black rectangle until it is played.
        // The server already thumbnails every video it lists.
        if (item.poster) video.poster = `${API}${item.poster}`;
        media.appendChild(video);
        const expand = document.createElement("button");
        expand.type = "button";
        expand.className = "clip-expand";
        expand.title = "Open large";
        expand.textContent = "⤢";
        expand.addEventListener("click", () => openLightbox("video", fileUrl(item), item.name));
        media.appendChild(expand);
        card.dataset.project = item.project || "";
      } else if (item.images && item.images.length) {
        const frames = item.images.map((image) => ({ kind: "image", src: fileUrl(image), caption: item.name }));
        let at = 0;

        const img = document.createElement("img");
        img.src = frames[0].src;
        img.loading = "lazy";
        img.style.cursor = "zoom-in";
        img.addEventListener("click", () => openGallery(frames, at, item.name));
        media.appendChild(img);

        if (frames.length > 1) {
          const count = document.createElement("span");
          count.className = "out-count";
          const show = (delta) => {
            at = (((at + delta) % frames.length) + frames.length) % frames.length;
            img.src = frames[at].src;
            count.textContent = `${at + 1}/${frames.length}`;
          };
          for (const [dir, label, cls] of [[-1, "‹", "is-prev"], [1, "›", "is-next"]]) {
            const nav = document.createElement("button");
            nav.type = "button";
            nav.className = `out-nav ${cls}`;
            nav.textContent = label;
            nav.setAttribute("aria-label", dir < 0 ? "Previous slide" : "Next slide");
            nav.addEventListener("click", (event) => {
              event.stopPropagation();
              show(dir);
            });
            media.appendChild(nav);
          }
          count.textContent = `1/${frames.length}`;
          media.appendChild(count);
        }
      }
      const body = document.createElement("div");
      body.className = "out-card-body";
      const name = document.createElement("span");
      name.className = "out-card-name";
      name.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "out-card-meta";
      meta.textContent =
        item.kind === "video"
          ? `${(item.size / 1024 / 1024).toFixed(1)} MB`
          : `${item.images ? item.images.length : 0} slides${item.post && item.post.caption ? ` · ${item.post.caption.slice(0, 50)}…` : ""}`;
      const reveal = document.createElement("button");
      reveal.className = "button button-ghost button-small";
      reveal.type = "button";
      reveal.textContent = "Reveal in Finder";
      reveal.addEventListener("click", () =>
        api("/reveal", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: item.dir || item.path }),
        }).catch((error) => toast(error.message)),
      );
      body.append(name, meta);
      if (item.project) {
        const edit = document.createElement("button");
        edit.className = "button button-dark button-small";
        edit.type = "button";
        edit.textContent = "Open for editing";
        edit.addEventListener("click", () => openProjectFromPath(item.project, item.name));
        body.appendChild(edit);
      }
      body.appendChild(reveal);
      card.append(media, body);
      list.appendChild(card);
    }
  } catch (error) {
    list.innerHTML = `<p class="field-hint">Could not read the output folder: ${error.message}</p>`;
  }
}

/* --------------------------------------------------------------------- wire */

function fillSelect(select, items, { value, label, empty }) {
  select.innerHTML = "";
  if (empty) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = empty;
    select.appendChild(option);
  }
  for (const item of items) {
    const option = document.createElement("option");
    option.value = value(item);
    option.textContent = label(item);
    select.appendChild(option);
  }
}

// The rail is built from whatever blocks the open tab actually has, so it can
// never list a step that is not there.
//
// Picking a step shows that step and only that step. Six blocks stacked in one
// column means the one you are working in is surrounded by five you are not,
// and the page is three screens tall for no reason. "All steps" puts the stack
// back, and is where every tab starts.
function renderStepRail() {
  const rail = $("#step-rail");
  if (!rail) return;
  rail.innerHTML = "";
  const panel = document.querySelector(".tab-panel.is-active");
  if (!panel) return;

  const blocks = [...panel.querySelectorAll("details.block")];
  if (!blocks.length) return;

  const mark = (button) => {
    for (const other of rail.children) other.classList.toggle("is-active", other === button);
  };

  const all = document.createElement("button");
  all.type = "button";
  all.className = "step-rail-item step-rail-all is-active";
  all.textContent = "All steps";
  all.addEventListener("click", () => {
    panel.classList.remove("is-solo");
    for (const block of blocks) block.classList.remove("is-solo-target");
    mark(all);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  rail.appendChild(all);

  for (const block of blocks) {
    const summary = block.querySelector("summary");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "step-rail-item";
    button.textContent = (summary ? summary.textContent : "Step").trim();
    button.addEventListener("click", () => {
      panel.classList.add("is-solo");
      for (const other of blocks) other.classList.toggle("is-solo-target", other === block);
      // A step arrived at on purpose should not also be collapsed.
      block.open = true;
      mark(button);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    rail.appendChild(button);
  }
}

function showTab(name) {
  const tab = $$(".tab").find((t) => t.dataset.tab === name);
  if (!tab) return;
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === name));
  renderStepRail();
  if (location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
  if (name === "output") loadOutput();
  // The timeline sizes itself from its visible width, which is zero while the
  // panel is display:none — so it has to be laid out again on the way in.
  if (name === "video" && timeline) timeline.sync();
}

function wireTabs() {
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1) || "image"));
  $("#out-refresh").addEventListener("click", loadOutput);
}

function wireDropZone(zone, input, dir, done) {
  const upload = async (files) => {
    for (const file of files) {
      try {
        const target = typeof dir === "function" ? dir(file) : dir;
        await fetch(`${API}/upload?dir=${target}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      } catch (error) {
        toast(`Upload failed: ${error.message}`);
      }
    }
    toast(`Added ${files.length} file${files.length === 1 ? "" : "s"}`);
    await loadLibrary();
    done();
  };
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => upload(Array.from(input.files)));
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("is-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("is-over");
    upload(Array.from(e.dataTransfer.files));
  });
}

const PROVIDER_LABELS = { deepseek: "DeepSeek", anthropic: "Claude", none: "AI" };
const writerLabel = () => `Write with ${PROVIDER_LABELS[state.library.copyProvider] || "AI"}`;

// With no model key the writer returns 428, so the button that cannot work
// stops looking like the one you are meant to press: the templates take the
// dark weight and the writer says what it is waiting for.
function syncWriterButtons() {
  const ready = state.library.copyProvider && state.library.copyProvider !== "none";
  for (const [writer, templates] of [
    ["#img-generate", "#img-offline"],
    ["#vid-generate", "#vid-offline"],
  ]) {
    const write = $(writer);
    const offline = $(templates);
    if (!write || !offline) continue;
    write.textContent = ready ? writerLabel() : "Write with AI";
    write.disabled = !ready;
    write.title = ready ? "" : "Add deepseekApiKey or anthropicApiKey to social/studio.config.json";
    write.classList.toggle("button-dark", ready);
    write.classList.toggle("button-ghost", !ready);
    offline.classList.toggle("button-dark", !ready);
    offline.classList.toggle("button-ghost", ready);
  }
}

async function loadLibrary() {
  state.library = await api("/library");
  syncWriterButtons();
  fillSelect($("#vid-music"), state.library.music, { value: (i) => i.path, label: (i) => i.name, empty: "None" });
  renderClipGrid("#vid-app-grid", state.library.appClips);
  renderClipGrid("#vid-bg-grid", state.library.videos);
  renderGifLibrary();
  renderPhotoGrid();
}

async function loadVoices() {
  try {
    const { voices } = await api("/voices");
    fillSelect($("#vid-voice"), voices, { value: (v) => v.id, label: (v) => v.label });
    const preferred = voices.find((v) => /Samantha|Alex|Daniel/.test(v.label));
    if (preferred) $("#vid-voice").value = preferred.id;
  } catch {
    fillSelect($("#vid-voice"), [{ id: "", label: "System default" }], { value: (v) => v.id, label: (v) => v.label });
  }
}

function wireImageTab() {
  fillSelect($("#img-format"), state.formats.imageFormats, { value: (f) => f.id, label: (f) => f.label });
  fillSelect($("#img-persona"), state.content.personas || [], { value: (p) => p.id, label: (p) => p.label, empty: "Any Mac user" });
  fillSelect($("#look-size"), Object.entries(CANVAS_SIZES), { value: ([k]) => k, label: ([, v]) => v.label });
  fillSelect($("#look-style"), Object.entries(TEXT_STYLES), { value: ([k]) => k, label: ([, v]) => v.label });

  const showBrief = () => {
    const format = currentImageFormat();
    $("#img-format-brief").textContent = format.brief;
    $("#img-count").value = String(format.slides);
  };
  $("#img-format").addEventListener("change", showBrief);
  showBrief();

  $("#img-generate").addEventListener("click", () => generateImageCopy(true));
  $("#img-offline").addEventListener("click", () => generateImageCopy(false));

  $("#slide-headline").addEventListener("input", (e) => {
    const slide = state.image.slides[state.image.index];
    if (!slide) return;
    slide.headline = e.target.value;
    const chip = $("#slide-strip").children[state.image.index];
    if (chip) chip.firstElementChild.title = `${state.image.index + 1}. ${slide.headline || "Untitled"}`;
    drawPreview();
  });
  $("#slide-body").addEventListener("input", (e) => {
    const slide = state.image.slides[state.image.index];
    if (!slide) return;
    slide.body = e.target.value;
    drawPreview();
  });
  $("#slide-texty").addEventListener("input", (e) => {
    const slide = state.image.slides[state.image.index];
    if (!slide) return;
    slide.textY = Number(e.target.value);
    $("#slide-texty-out").textContent = slide.textY.toFixed(2);
    drawPreview();
  });

  $("#slide-add").addEventListener("click", () => {
    state.image.slides.splice(state.image.index + 1, 0, blankSlide());
    selectSlide(state.image.index + 1);
  });
  $("#slide-remove").addEventListener("click", () => {
    if (!state.image.slides.length) return;
    state.image.slides.splice(state.image.index, 1);
    selectSlide(Math.min(state.image.index, state.image.slides.length - 1));
  });
  const move = (delta) => {
    const { slides, index } = state.image;
    const target = index + delta;
    if (target < 0 || target >= slides.length) return;
    [slides[index], slides[target]] = [slides[target], slides[index]];
    selectSlide(target);
  };
  $("#slide-up").addEventListener("click", () => move(-1));
  $("#slide-down").addEventListener("click", () => move(1));

  $$("#bg-source .seg-btn").forEach((button) => button.addEventListener("click", () => showBackgroundSource(button.dataset.src)));
  $("#stock-go").addEventListener("click", searchStock);
  $("#stock-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchStock();
  });

  ["#look-size", "#look-style", "#look-hsize", "#look-bsize", "#look-scrim", "#look-handle"].forEach((sel) =>
    $(sel).addEventListener("input", readLook),
  );
  readLook();

  $("#preview-prev").addEventListener("click", () => selectSlide(state.image.index - 1));
  $("#preview-next").addEventListener("click", () => selectSlide(state.image.index + 1));

  const setKeep = (keep) => {
    const slide = state.image.slides[state.image.index];
    if (!slide) return;
    slide.keep = keep;
    renderSlideStrip();
    if (state.image.index < state.image.slides.length - 1) selectSlide(state.image.index + 1);
    else drawPreview();
  };
  // The empty stage is the first thing anyone sees, so it carries the action
  // rather than describing it.
  const start = $("#preview-start");
  if (start) start.addEventListener("click", () => $("#img-offline").click());

  $("#blitz-keep").addEventListener("click", () => setKeep(true));
  $("#blitz-cut").addEventListener("click", () => setKeep(false));

  $("#img-caption").addEventListener("input", (e) => {
    state.image.caption = e.target.value;
  });
  $("#img-export").addEventListener("click", exportImagePost);
  $("#img-download").addEventListener("click", downloadCurrentSlide);

  wireDropZone($("#photo-drop"), $("#photo-input"), "photos", () => showBackgroundSource("library"));

  // Blitz shortcuts, but never while a text field has focus.
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!$('.tab-panel[data-panel="image"]').classList.contains("is-active")) return;
    if (!$("#lightbox").hidden) return;
    if (e.key === "j" || e.key === "J") setKeep(true);
    else if (e.key === "k" || e.key === "K") setKeep(false);
    else if (e.key === "ArrowLeft") selectSlide(state.image.index - 1);
    else if (e.key === "ArrowRight") selectSlide(state.image.index + 1);
  });
}


/* --------------------------------------------------------------------- boot */

async function init() {
  wireTabs();
  wireLightbox();

  const pill = $("#server-pill");
  try {
    const health = await api("/health");
    pill.dataset.state = health.ffmpeg ? "ok" : "down";
    pill.textContent = health.ffmpeg ? "Studio server up" : "Studio server up · ffmpeg missing";
  } catch {
    pill.dataset.state = "down";
    pill.textContent = "Studio server down — run: node social/studio-server.mjs";
  }

  // Read once per load, so a stale copy survives for the life of the tab — and
  // a browser cache would make even a reload stale. The price lived on in an
  // open tab for exactly that reason, so these two are always fetched fresh.
  const fresh = (path) => fetch(`${path}?v=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
  const [formats, content] = await Promise.all([fresh("studio/formats.json"), fresh("content.json")]);
  state.formats = formats;
  state.content = content;

  if (pill.dataset.state === "ok") {
    await loadLibrary();
    await loadVoices();
  }

  wireImageTab();
  wireVideoTab();
  wireFootagePreview();
  showBackgroundSource("library");
  // No slides until you ask for some: the page used to open on six template
  // cards nobody had written, which read as work already done.
  renderSlideStrip();
  syncSlideEditor();
  drawPreview();

  showTab(location.hash.slice(1) || "image");
}

init().catch((error) => {
  console.error(error);
  toast(`Studio failed to start: ${error.message}`);
});
