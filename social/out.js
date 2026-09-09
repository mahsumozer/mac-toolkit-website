// Output — everything the studio, Autopilot and Supercut have made, on a page of
// its own.
//
// The studio has its own Output tab and it stays exactly as it is; this is the
// same folder read by the same endpoints, on a page that loads in a moment
// rather than behind the whole editor. What it adds is what a finished post is
// actually for: watch it, download it, copy its caption, find it on disk, throw
// it away.

const API = (window.SOCIAL_CONFIG && window.SOCIAL_CONFIG.studioApiBase) || "http://127.0.0.1:8789";
const $ = (sel) => document.querySelector(sel);

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

const fileUrl = (item) => `${API}${item.url || `/file?p=${encodeURIComponent(item.path)}`}`;
const downloadUrl = (path) => `${API}/download?p=${encodeURIComponent(path)}`;
const zipUrl = (dir) => `${API}/zip?p=${encodeURIComponent(dir)}`;

const state = { items: [], filter: "all" };

const when = (at) => {
  const date = new Date(at);
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};

/* --------------------------------------------------------------- lightbox */

function openLightbox(node) {
  const body = $("#out-lightbox-body");
  body.innerHTML = "";
  body.appendChild(node);
  $("#out-lightbox").hidden = false;
}

function closeLightbox() {
  const body = $("#out-lightbox-body");
  for (const video of body.querySelectorAll("video")) video.pause();
  body.innerHTML = "";
  $("#out-lightbox").hidden = true;
}

/* ------------------------------------------------------------------ cards */

function card(item) {
  const article = document.createElement("article");
  article.className = "auto-card";

  const media = document.createElement("div");
  media.className = "auto-card-media";

  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "out-expand";
  expand.title = "Open large";
  expand.textContent = "⤢";
  media.appendChild(expand);

  if (item.kind === "video") {
    const video = document.createElement("video");
    video.src = fileUrl(item);
    video.controls = true;
    video.preload = "metadata";
    video.playsInline = true;
    // Without a poster the card is a black rectangle until it is played, and the
    // server already thumbnails every video it lists.
    if (item.poster) video.poster = `${API}${item.poster}`;
    media.appendChild(video);
    expand.addEventListener("click", () => {
      const large = document.createElement("video");
      large.src = fileUrl(item);
      large.controls = true;
      large.autoplay = true;
      large.playsInline = true;
      openLightbox(large);
    });
  } else {
    const images = item.images || [];
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = item.name;
    if (images[0]) img.src = fileUrl(images[0]);
    media.appendChild(img);
    if (images.length > 1) {
      const strip = document.createElement("div");
      strip.className = "auto-card-strip";
      for (const image of images.slice(1, 8)) {
        const thumb = document.createElement("img");
        thumb.src = fileUrl(image);
        thumb.loading = "lazy";
        thumb.alt = "";
        thumb.addEventListener("click", () => {
          img.src = thumb.src;
        });
        strip.appendChild(thumb);
      }
      media.appendChild(strip);
    }
    expand.addEventListener("click", () => {
      const large = document.createElement("img");
      large.src = img.src;
      large.alt = item.name;
      openLightbox(large);
    });
  }
  article.appendChild(media);

  const body = document.createElement("div");
  body.className = "auto-card-body";

  const post = item.post || {};
  const title = document.createElement("h3");
  title.textContent = post.caption ? String(post.caption).split("\n")[0] : item.name;
  body.appendChild(title);

  const meta = document.createElement("p");
  meta.className = "auto-card-meta";
  meta.textContent =
    item.kind === "video"
      ? `Video · ${item.size ? `${(item.size / 1e6).toFixed(1)} MB` : "—"} · ${when(item.at)}`
      : `Carousel · ${(item.images || []).length} cards · ${when(item.at)}`;
  body.appendChild(meta);

  if (post.caption || (post.hashtags || []).length) {
    const caption = document.createElement("textarea");
    caption.className = "auto-card-caption";
    caption.rows = 3;
    caption.value = [post.caption, (post.hashtags || []).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")].filter(Boolean).join("\n\n");
    body.appendChild(caption);
  }

  const row = document.createElement("div");
  row.className = "btn-row auto-card-actions";

  const download = document.createElement("a");
  download.className = "button button-accent button-small";
  download.textContent = item.kind === "video" ? "Download video" : "Download cards";
  download.href = item.kind === "video" ? downloadUrl(item.path) : zipUrl(item.dir);
  download.setAttribute("download", "");
  row.appendChild(download);

  const caption = body.querySelector(".auto-card-caption");
  if (caption) {
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
  }

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "button button-ghost button-small";
  reveal.textContent = "Show in Finder";
  reveal.addEventListener("click", () =>
    api("/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: item.path || (item.images || [])[0]?.path || item.dir }),
    }).catch((error) => toast(`Could not open Finder: ${error.message}`)),
  );
  row.appendChild(reveal);

  // Deleting takes the folder with it, so the confirm says so in as many words:
  // there is no undo behind this and nothing goes to the Trash.
  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "button button-ghost button-small out-trash";
  trash.textContent = "Delete";
  trash.addEventListener("click", async () => {
    const what = item.kind === "video" ? "video, its caption and its project file" : "slides and caption";
    if (!window.confirm(`Delete ${item.name}?\n\nThis removes the ${what} from disk permanently. It cannot be undone.`)) return;
    try {
      await api("/out/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: item.dir || item.path }),
      });
      article.remove();
      state.items = state.items.filter((other) => other !== item);
      count();
      toast(`${item.name} deleted`);
    } catch (error) {
      toast(`Could not delete: ${error.message}`);
    }
  });
  row.appendChild(trash);

  body.appendChild(row);
  article.appendChild(body);
  return article;
}

function count() {
  const shown = state.items.filter((item) => state.filter === "all" || item.kind === state.filter);
  const videos = state.items.filter((item) => item.kind === "video").length;
  const images = state.items.length - videos;
  $("#out-count").textContent = state.items.length
    ? `${videos} video${videos === 1 ? "" : "s"} and ${images} carousel${images === 1 ? "" : "s"} in social/studio/out/${
        state.filter === "all" ? "" : ` · showing ${shown.length}`
      }`
    : "Nothing rendered yet.";
}

function draw() {
  const grid = $("#out-grid");
  grid.innerHTML = "";
  const shown = state.items.filter((item) => state.filter === "all" || item.kind === state.filter);
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "out-empty";
    empty.textContent = state.items.length ? "Nothing of that kind yet." : "Nothing rendered yet — make something in Autopilot or Supercut.";
    grid.appendChild(empty);
    return;
  }
  for (const item of shown) grid.appendChild(card(item));
}

async function load() {
  const button = $("#out-refresh");
  button.disabled = true;
  try {
    const { items } = await api("/out");
    state.items = items || [];
    count();
    draw();
  } catch (error) {
    $("#out-count").textContent = `Could not read the output folder: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

/* --------------------------------------------------------------------- boot */

async function init() {
  const pill = $("#server-pill");
  try {
    const health = await api("/health");
    pill.dataset.state = health.ffmpeg ? "ok" : "down";
    pill.textContent = health.ffmpeg ? "Studio server up" : "Studio server up · ffmpeg missing";
  } catch {
    pill.dataset.state = "down";
    pill.textContent = "Studio server down — run: node social/studio-server.mjs";
    $("#out-count").textContent = "The studio server is not running.";
    return;
  }

  $("#out-refresh").addEventListener("click", load);
  $("#out-filter").addEventListener("change", (event) => {
    state.filter = event.target.value;
    count();
    draw();
  });
  $("#out-reveal").addEventListener("click", () => {
    const first = state.items[0];
    if (!first) return toast("Nothing rendered yet");
    api("/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: first.dir || first.path }),
    }).catch((error) => toast(`Could not open Finder: ${error.message}`));
  });

  $("#out-lightbox-close").addEventListener("click", closeLightbox);
  $("#out-lightbox").addEventListener("click", (event) => {
    if (event.target === $("#out-lightbox")) closeLightbox();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#out-lightbox").hidden) closeLightbox();
  });

  await load();
}

init();
