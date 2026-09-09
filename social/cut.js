// Supercut — the page half.
//
// The server finds the words and cuts them out (studio/supercut.mjs, /supercut/run).
// This lays the pieces end to end on the canvas, puts the word on screen while it
// is being said, and renders through the same /render-video everything else uses.
//
// The clips arrive already cut, so each one is a layer that starts where the last
// finished. There is no trimming here: the file *is* the word.

import { newLayer, audioLayer, textLayer, COMP_W, COMP_H } from "./studio/composition.js";
import { Editor } from "./studio/editor.js";
import { freezeComposition } from "./studio/freeze.js";

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

const state = { running: false, rendering: false, result: null, chips: [], editor: null, seed: null, jobId: null };

const phase = (text) => ($("#cut-phase-text").textContent = text);

function log(text, kind = "") {
  const el = document.createElement("div");
  el.className = `auto-msg is-tool ${kind}`.trim();
  el.textContent = text;
  $("#cut-feed").appendChild(el);
  $("#cut-feed").scrollTop = $("#cut-feed").scrollHeight;
}

function progress(fraction, note) {
  $("#cut-progress").hidden = false;
  $("#cut-progress-fill").style.width = `${Math.round((fraction || 0) * 100)}%`;
  $("#cut-progress-note").textContent = note || "";
}

/* ------------------------------------------------------------------- split */

// The line as the phrases it will be hunted for. Where the boundaries fall
// decides how the cut sounds: "window management" hunted as one phrase comes out
// of one mouth, hunted as two words comes out of two, and the join reads as a
// mistake. The model proposes them; the boundaries are then yours to move.
//
// The split is held as an array of word counts rather than as strings, so it can
// never stop spelling the line — clicking a seam splits a count in two, clicking
// a join adds two together, and the words themselves are never touched.
const SPLIT_HIDDEN_KEY = "supercut.splitHidden";
const PILL_COLOURS = ["#ffd7d9", "#ffe2c2", "#fff3bf", "#d8f5cb", "#cfe6ff", "#e6dcff", "#ffd9f0", "#cdf1ee"];

const split = { words: [], sizes: [], script: "", source: "", busy: false };

const scriptWords = (script) => String(script || "").trim().split(/\s+/).filter(Boolean);

function sizesFromChunks(words, chunks) {
  const sizes = [];
  let index = 0;
  for (const chunk of chunks) {
    const count = scriptWords(chunk).length;
    if (!count || index + count > words.length) return null;
    sizes.push(count);
    index += count;
  }
  return index === words.length ? sizes : null;
}

const chunksFromSizes = () => {
  const chunks = [];
  let index = 0;
  for (const size of split.sizes) {
    chunks.push(split.words.slice(index, index + size).join(" "));
    index += size;
  }
  return chunks;
};

function renderPills() {
  const wrap = $("#cut-pills");
  wrap.innerHTML = "";
  let index = 0;
  split.sizes.forEach((size, chunkIndex) => {
    if (chunkIndex > 0) {
      // The gap between two phrases: clicking it makes them one.
      const join = document.createElement("button");
      join.type = "button";
      join.className = "cut-join";
      join.title = "Join these two phrases";
      join.setAttribute("aria-label", "Join these two phrases");
      join.addEventListener("click", () => {
        split.sizes.splice(chunkIndex - 1, 2, split.sizes[chunkIndex - 1] + split.sizes[chunkIndex]);
        renderPills();
      });
      wrap.appendChild(join);
    }

    const pill = document.createElement("span");
    pill.className = "cut-pill";
    pill.style.background = PILL_COLOURS[chunkIndex % PILL_COLOURS.length];
    const words = split.words.slice(index, index + size);
    words.forEach((word, wordIndex) => {
      if (wordIndex > 0) {
        // A seam inside a phrase: clicking it breaks the phrase there.
        const seam = document.createElement("button");
        seam.type = "button";
        seam.className = "cut-seam";
        seam.title = "Break the phrase here";
        seam.setAttribute("aria-label", "Break the phrase here");
        const at = chunkIndex;
        const cutAfter = wordIndex;
        seam.addEventListener("click", () => {
          split.sizes.splice(at, 1, cutAfter, size - cutAfter);
          renderPills();
        });
        pill.appendChild(seam);
      }
      const span = document.createElement("span");
      span.className = "cut-pill-word";
      span.textContent = word;
      pill.appendChild(span);
    });
    wrap.appendChild(pill);
    index += size;
  });

  $("#cut-split-title").textContent = `${split.sizes.length} phrase${split.sizes.length === 1 ? "" : "s"}${
    split.source === "rules" ? " · split by rules" : split.source ? ` · split by ${split.source}` : ""
  }`;
}

function showSplit(visible) {
  $("#cut-split").hidden = !visible || !split.sizes.length;
  $("#cut-split-show").hidden = visible || !split.sizes.length;
  try {
    localStorage.setItem(SPLIT_HIDDEN_KEY, visible ? "0" : "1");
  } catch {}
}

const splitHidden = () => {
  try {
    return localStorage.getItem(SPLIT_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
};

// Ask the model where the phrases are. Called when the line settles, not on
// every keystroke: it is a round trip, and a half-typed line splits into
// nonsense.
async function requestSplit(force = false) {
  const script = $("#cut-script").value.trim();
  const words = scriptWords(script);
  if (words.length < 2) {
    split.words = [];
    split.sizes = [];
    showSplit(false);
    $("#cut-split-show").hidden = true;
    return;
  }
  if (!force && script === split.script && split.sizes.length) return;

  split.busy = true;
  $("#cut-split").classList.add("is-busy");
  try {
    const answer = await api("/supercut/split", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script, topic: $("#cut-topic").value.trim() }),
    });
    const sizes = sizesFromChunks(words, answer.chunks || []);
    split.words = words;
    split.sizes = sizes || [words.length];
    split.script = script;
    split.source = sizes ? answer.source : "rules";
    renderPills();
    showSplit(!splitHidden());
    if (answer.note) log(`split: ${answer.note}`, "is-error");
  } catch (error) {
    // No model, no network: one phrase per clause is still better than nothing,
    // and the seams are there to fix it by hand.
    split.words = words;
    split.sizes = words.map(() => 1);
    split.script = script;
    split.source = "rules";
    renderPills();
    showSplit(!splitHidden());
  } finally {
    split.busy = false;
    $("#cut-split").classList.remove("is-busy");
  }
}

/* ----------------------------------------------------------------- history */

// Past runs, in this browser. The subject and the line are the hard part of a
// supercut and the second attempt is usually the first one with a word changed,
// so every run is kept with the settings it ran under — and Add puts them back
// in the form without starting anything.
const HISTORY_KEY = "supercut.history";
const HISTORY_MAX = 40;

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {}
  renderHistory();
}

function currentSettings() {
  return {
    topic: $("#cut-topic").value.trim(),
    script: $("#cut-script").value.trim(),
    videoCount: $("#cut-count").value,
    lang: $("#cut-lang").value,
    cutCost: $("#cut-feel").value,
    captions: $("#cut-captions").checked,
    speak: $("#cut-speak").checked,
    chunks: split.script === $("#cut-script").value.trim() && split.sizes.length ? chunksFromSizes() : undefined,
  };
}

function rememberRun(settings) {
  // The same line run twice is one entry, moved back to the top: a history full
  // of the same script is a history nobody reads.
  const list = loadHistory().filter((entry) => !(entry.topic === settings.topic && entry.script === settings.script));
  list.unshift({ ...settings, at: Date.now(), id: `${Date.now()}` });
  saveHistory(list);
  return list[0].id;
}

function recordOutcome(id, outcome, seed) {
  const list = loadHistory();
  const entry = list.find((item) => item.id === id);
  if (!entry) return;
  entry.outcome = outcome;
  // The seed is what makes a run repeatable: Add brings back the same faces,
  // Another take asks for different ones.
  if (seed) entry.seed = seed;
  saveHistory(list);
}

// Put a past run back in the form. Deliberately does not start it: the reason to
// reach for an old prompt is usually to change one word in it.
function applySettings(entry) {
  $("#cut-topic").value = entry.topic || "";
  $("#cut-script").value = entry.script || "";
  if (entry.videoCount) $("#cut-count").value = entry.videoCount;
  if (entry.lang) $("#cut-lang").value = entry.lang;
  if (entry.cutCost) $("#cut-feel").value = entry.cutCost;
  $("#cut-captions").checked = entry.captions !== false;
  $("#cut-speak").checked = Boolean(entry.speak);
  // The phrases come back with the line, so an old prompt returns exactly as it
  // ran rather than being re-split into something slightly different.
  const words = scriptWords(entry.script);
  const sizes = entry.chunks ? sizesFromChunks(words, entry.chunks) : null;
  split.words = words;
  split.sizes = sizes || [];
  split.script = entry.script || "";
  split.source = sizes ? "your last run" : "";
  if (sizes) {
    renderPills();
    showSplit(!splitHidden());
  } else {
    requestSplit(true);
  }
  state.seed = entry.seed || null;
  $("#cut-script").focus();
  toast(entry.seed ? "Loaded — Cut it gives you the same take back" : "Loaded — change what you like, then Cut it");
}

const FEEL_LABEL = { "2.2": "long takes", "1": "balanced", "0.6": "chopped" };

const DRAWER_KEY = "supercut.historyOpen";

const drawerWasOpen = () => {
  try {
    return localStorage.getItem(DRAWER_KEY) === "1";
  } catch {
    return false;
  }
};

function setDrawer(open) {
  $("#cut-history").classList.toggle("is-open", open);
  document.body.classList.toggle("drawer-open", open);
  const toggle = $("#cut-history-toggle");
  toggle.classList.toggle("is-on", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.title = open ? "Hide past runs" : "Past runs";
  try {
    localStorage.setItem(DRAWER_KEY, open ? "1" : "0");
  } catch {}
  if (open) renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  const wrap = $("#cut-history-list");
  wrap.innerHTML = "";
  if (!list.length) {
    wrap.innerHTML = `<p class="cut-history-empty">Nothing yet — the runs you make are kept here.</p>`;
    return;
  }

  for (const entry of list) {
    const card = document.createElement("article");
    card.className = "cut-past";

    const body = document.createElement("div");
    body.className = "cut-past-body";
    const script = document.createElement("span");
    script.className = "cut-past-script";
    script.textContent = entry.script;
    const meta = document.createElement("span");
    meta.className = "cut-past-meta";
    const when = new Date(entry.at || Date.now());
    meta.textContent = [
      `“${entry.topic}”`,
      `${entry.videoCount || 12} videos`,
      entry.lang && entry.lang !== "auto" ? entry.lang : "auto",
      FEEL_LABEL[String(entry.cutCost)] || "balanced",
      entry.captions === false ? "no captions" : "captions",
      entry.speak ? "spoken gaps" : null,
      entry.outcome ? `→ ${entry.outcome}` : null,
      when.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    ]
      .filter(Boolean)
      .join(" · ");
    body.append(script, meta);

    const actions = document.createElement("div");
    actions.className = "cut-past-actions";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "button button-dark button-small";
    add.textContent = "Add";
    add.addEventListener("click", () => applySettings(entry));
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "cut-past-drop";
    drop.title = "Forget this one";
    drop.setAttribute("aria-label", "Forget this one");
    drop.textContent = "✕";
    drop.addEventListener("click", () => saveHistory(loadHistory().filter((item) => item.id !== entry.id)));
    actions.append(add, drop);

    card.append(body, actions);
    wrap.appendChild(card);
  }
}

/* ------------------------------------------------------------------- strip */

// The script as the pieces it became, in reading order, so the joins and the
// holes are visible before anything is rendered.
function renderStrip(segments) {
  const strip = $("#cut-strip");
  strip.innerHTML = "";
  state.chips = segments.map((segment) => {
    const chip = document.createElement("span");
    chip.className = `cut-chip${segment.kind === "gap" ? " is-gap" : ""}`;
    chip.textContent = segment.text;
    if (segment.kind === "clip") {
      const meta = document.createElement("small");
      meta.textContent = `${segment.span}s`;
      chip.appendChild(meta);
      chip.title = `${segment.title} · ${segment.start}s`;
    } else {
      chip.title = "Nobody in those videos says this";
    }
    strip.appendChild(chip);
    return chip;
  });
}

/* -------------------------------------------------------------- composition */

async function speak(text) {
  const { jobId } = await api("/voiceover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, name: `gap-${text.slice(0, 24)}` }),
  });
  return pollJob(jobId, () => {});
}

async function buildComposition(result) {
  const editor = state.editor;
  const withCaptions = $("#cut-captions").checked;
  const speakGaps = $("#cut-speak").checked;
  const layers = [];
  const captions = [];
  const audio = [];
  let at = 0;

  for (const segment of result.segments) {
    if (segment.kind === "clip") {
      const span = Math.max(0.2, Number(segment.span) || 0.5);
      layers.push(
        newLayer({
          type: "video",
          name: segment.text,
          path: segment.path,
          src: fileUrl(segment.path),
          x: 0,
          y: 0,
          w: COMP_W,
          h: COMP_H,
          fit: "cover",
          start: Number(at.toFixed(3)),
          end: Number((at + span).toFixed(3)),
          volume: 1,
        }),
      );
      captions.push({ text: segment.text, start: at, end: at + span });
      at += span;
      continue;
    }

    // A word nobody said. It is never dropped — the script is the thing being
    // made — so it gets the studio's own voice saying it, and a picture from a
    // video about that word to say it over. A black frame for a second and a
    // half is what this used to be.
    let span = 0.8;
    if (speakGaps) {
      try {
        const voice = await speak(segment.text);
        span = Math.max(0.5, Number(voice.duration) || 0.8);
        audio.push({ path: voice.path, src: fileUrl(voice.path), duration: span, start: at });
      } catch (error) {
        log(`could not speak "${segment.text}": ${error.message}`, "is-error");
      }
    }
    if (segment.filler && segment.filler.path) {
      layers.push(
        newLayer({
          type: "video",
          name: `${segment.text} (filler)`,
          path: segment.filler.path,
          src: fileUrl(segment.filler.path),
          x: 0,
          y: 0,
          w: COMP_W,
          h: COMP_H,
          fit: "cover",
          start: Number(at.toFixed(3)),
          end: Number((at + span).toFixed(3)),
          // Muted: someone else's sentence under our own word is two voices at
          // once.
          volume: 0,
        }),
      );
    }
    captions.push({ text: segment.text, start: at, end: at + span, gap: true });
    at += span;
  }

  const duration = Math.max(1.5, Number(at.toFixed(3)));

  for (const track of audio) {
    layers.push(
      audioLayer(
        { name: track.path.split("/").pop(), path: track.path, src: track.src, duration: track.duration },
        { start: track.start, end: track.start + track.duration },
      ),
    );
  }

  if (withCaptions) {
    for (const caption of captions) {
      layers.push(
        textLayer(caption.text, {
          isCaption: true,
          style: caption.gap ? "sticker-accent" : "sticker-white",
          fontSize: 76,
          x: 90,
          y: Math.round(COMP_H * 0.74),
          w: COMP_W - 180,
          start: Number(caption.start.toFixed(3)),
          end: Number(caption.end.toFixed(3)),
        }),
      );
    }
  }

  // One composition, set once. Adding layers one at a time re-syncs the media
  // pool and redraws the whole 1080x1920 canvas on every call, so a paragraph —
  // forty-seven clips and as many captions — spent minutes doing the same work
  // a hundred times over before it could show anything.
  editor.setComposition({ duration, layers });
  editor.select(null);
  editor.draw();
  return duration;
}

/* ----------------------------------------------------------------- rendering */

async function renderCut() {
  if (!state.result) return;
  const button = $("#cut-render");
  button.disabled = true;
  state.rendering = true;
  try {
    progress(0.02, "Waiting for the clips to load…");
    const { ready, waiting } = await state.editor.whenReady();
    if (!ready) log(`still loading after 15s: ${waiting.join(", ")}`, "is-error");

    const { layers, missing } = await freezeComposition(state.editor);
    if (missing.length) log(`skipped, still loading: ${missing.join(", ")}`, "is-error");
    if (!layers.length) throw new Error("nothing to render");

    const { jobId } = await api("/render-video", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `supercut-${state.result.script.slice(0, 40)}`,
        duration: state.editor.comp.duration,
        layers,
        musicPath: "",
        musicVolume: 0,
        caption: state.result.script,
        hashtags: [],
        project: {
          derivedFrom: null,
          duration: state.editor.comp.duration,
          layers: state.editor.layers.map(({ src, ...layer }) => layer),
          script: { format: "supercut", hook: state.result.script, lines: "", topic: state.result.topic },
          captions: { style: "sticker-white", fontSize: 76, wordsPerCard: 6, y: 0.74 },
          audio: { musicPath: "", musicVolume: 0, voice: "" },
          caption: state.result.script,
          hashtags: "",
        },
      }),
    });

    const rendered = await pollJob(jobId, (job) => progress(job.progress || 0, job.stage || job.status));
    progress(1, "Rendered");
    showResult(rendered);
  } catch (error) {
    log(`render failed: ${error.message}`, "is-error");
    toast(`Render failed: ${error.message}`);
  } finally {
    state.rendering = false;
    button.disabled = false;
  }
}

function showResult(rendered) {
  $("#cut-results").hidden = false;
  const card = document.createElement("article");
  card.className = "auto-card";

  const media = document.createElement("div");
  media.className = "auto-card-media";
  const video = document.createElement("video");
  video.src = `${API}${rendered.url}`;
  video.controls = true;
  video.playsInline = true;
  media.appendChild(video);
  card.appendChild(media);

  const body = document.createElement("div");
  body.className = "auto-card-body";
  const title = document.createElement("h3");
  title.textContent = state.result.script;
  const meta = document.createElement("p");
  meta.className = "auto-card-meta";
  meta.textContent = `${rendered.duration.toFixed(1)}s · ${state.result.stats.clips} clips from ${state.result.stats.sources} videos · ${rendered.slug}`;
  const row = document.createElement("div");
  row.className = "btn-row auto-card-actions";
  const download = document.createElement("a");
  download.className = "button button-accent button-small";
  download.textContent = "Download video";
  download.href = downloadUrl(rendered.file);
  download.setAttribute("download", "");
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "button button-ghost button-small";
  reveal.textContent = "Show in Finder";
  reveal.addEventListener("click", () =>
    api("/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: rendered.file }) }).catch((error) =>
      toast(`Could not open Finder: ${error.message}`),
    ),
  );
  row.append(download, reveal);
  body.append(title, meta, row);
  card.appendChild(body);
  $("#cut-grid").prepend(card);
}

/* ---------------------------------------------------------------- subject */

// The subject decides who is available to say the line, so it can be worked out
// from the line itself. Pressing the button again offers the next idea rather
// than asking for the same one twice.
const topics = { script: "", list: [], at: 0 };

async function suggestTopic() {
  const script = $("#cut-script").value.trim();
  if (!script) return toast("Write the line first — the subject comes out of it");
  const button = $("#cut-topic-suggest");

  if (topics.script === script && topics.list.length > 1) {
    topics.at = (topics.at + 1) % topics.list.length;
    $("#cut-topic").value = topics.list[topics.at];
    return;
  }

  button.disabled = true;
  button.textContent = "Thinking…";
  try {
    const answer = await api("/supercut/topic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script }),
    });
    topics.script = script;
    topics.list = answer.topics || [];
    topics.at = 0;
    if (!topics.list.length) return toast("Could not think of a subject — type one");
    $("#cut-topic").value = topics.list[0];
    if (topics.list.length > 1) toast(`${topics.list.length} ideas — press again for the next`);
  } catch (error) {
    toast(`Could not suggest a subject: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Suggest";
  }
}

/* ------------------------------------------------------------- more credit */

// The run stops and asks rather than ending with a hole in the line. Rendered
// once per question: the poller sees the same `awaiting` on every tick until it
// is answered.
let askedAt = 0;

function renderAsk(job, jobId) {
  const ask = job.awaiting;
  if (!ask || ask.asked === askedAt) return;
  askedAt = ask.asked;
  phase("Waiting for you");

  const wrap = document.createElement("div");
  wrap.className = "auto-msg is-error cut-ask";
  const line = document.createElement("p");
  line.className = "cut-ask-line";
  line.textContent = `${ask.read} videos read and nobody says ${ask.missing.map((word) => `“${word}”`).join(", ")}. Keep looking?`;
  wrap.appendChild(line);

  const row = document.createElement("div");
  row.className = "cut-ask-row";
  const answer = async (reads, button) => {
    if (state.jobId !== jobId) {
      log("that question belonged to an earlier run", "is-error");
      for (const other of row.querySelectorAll("button")) other.disabled = true;
      return;
    }
    for (const other of row.querySelectorAll("button")) other.disabled = true;
    button.classList.add("is-chosen");
    try {
      // The run this question belongs to, captured when it was asked. Reading
      // the current job at click time answers for whichever run happens to be
      // going, which is the wrong one the moment a second run has started.
      await api("/supercut/continue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId, reads }),
      });
      log(reads ? `asked for ${reads} more videos` : "cutting what it has", "is-done");
    } catch (error) {
      log(`could not answer: ${error.message}`, "is-error");
    }
  };
  for (const reads of ask.options || [50, 100, 200]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-dark button-small";
    button.textContent = `+${reads} videos`;
    button.addEventListener("click", () => answer(reads, button));
    row.appendChild(button);
  }
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "button button-ghost button-small";
  stop.textContent = "Cut what you have";
  stop.addEventListener("click", () => answer(0, stop));
  row.appendChild(stop);

  wrap.appendChild(row);
  $("#cut-feed").appendChild(wrap);
  $("#cut-feed").scrollTop = $("#cut-feed").scrollHeight;
}

/* --------------------------------------------------------------------- run */

// A second opinion on the same line. The transcripts are already on disk, so a
// new take is the searching over again with different numbers — a minute, not
// five — and a different set of faces saying the same words.
async function anotherTake() {
  if (state.running || !state.result) return;
  state.seed = null;
  await run(new Event("submit"));
}

async function run(event) {
  if (event && event.preventDefault) event.preventDefault();
  if (state.running) return;
  const topic = $("#cut-topic").value.trim();
  const script = $("#cut-script").value.trim();
  // The subject may be left empty: the server works it out from the line and
  // says which one it used.
  if (!script) return;

  const settings = currentSettings();
  const historyId = rememberRun(settings);

  state.running = true;
  state.result = null;
  $("#cut-go").disabled = true;
  $("#cut-go").textContent = "Cutting…";
  $("#cut-run").hidden = false;
  $("#cut-feed").innerHTML = "";
  $("#cut-strip").innerHTML = "";
  $("#cut-render").disabled = true;
  $("#cut-again").disabled = true;
  phase("Finding videos");

  try {
    const { jobId } = await api("/supercut/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        topic,
        script,
        videoCount: Number($("#cut-count").value) || 12,
        cutCost: Number($("#cut-feel").value) || 1,
        lang: $("#cut-lang").value,
        chunks: split.script === script && split.sizes.length ? chunksFromSizes() : undefined,
        // Only sent when a take is being asked for again; left out, the server
        // draws a fresh one.
        seed: state.seed || undefined,
      }),
    });

    state.jobId = jobId;
    let shown = 0;
    const result = await pollJob(jobId, (job) => {
      phase(job.stage || job.status);
      progress(job.progress || 0, job.stage || "");
      // The backlog first, then the question: a poll tick usually carries both,
      // and asking above the lines that led to it reads as though the answer
      // was ignored.
      for (const message of (job.messages || []).slice(shown)) log(message.text, message.role === "tool-error" ? "is-error" : "is-done");
      shown = (job.messages || []).length;
      if (job.awaiting) renderAsk(job, jobId);
    });

    state.result = result;
    state.seed = result.seed || null;
    // Show what it decided to cut from, so the next run starts from that rather
    // than guessing again.
    if (result.topicWasGuessed && result.topic) $("#cut-topic").value = result.topic;
    recordOutcome(historyId, `${result.stats.found}/${result.stats.words} words, ${result.stats.clips} clips`, result.seed);
    renderStrip(result.segments);
    if (result.missing.length) {
      const how = [
        result.fillers ? `${result.fillers} shown over a related clip` : null,
        $("#cut-speak").checked ? "spoken by the studio" : "shown as type",
      ]
        .filter(Boolean)
        .join(", ");
      log(`nobody says: ${result.missing.join(", ")} — ${how}`, "is-error");
    }

    phase("Laying it out");
    const duration = await buildComposition(result);
    log(`${state.editor.layers.length} layers, ${duration.toFixed(1)}s`, "is-done");
    phase(`Ready — ${duration.toFixed(1)}s`);
    $("#cut-render").disabled = false;
    $("#cut-again").disabled = false;
    $("#cut-progress").hidden = true;
  } catch (error) {
    phase("Stopped");
    log(String(error.message || error), "is-error");
  } finally {
    state.running = false;
    $("#cut-go").disabled = false;
    $("#cut-go").textContent = "Cut it";
  }
}

/* -------------------------------------------------------------------- boot */

async function init() {
  state.editor = new Editor($("#cut-canvas"));

  const pill = $("#server-pill");
  try {
    const health = await api("/health");
    pill.dataset.state = health.ytdlp ? "ok" : "down";
    pill.textContent = health.ytdlp ? "Studio server up" : "Studio server up · yt-dlp missing";
  } catch {
    pill.dataset.state = "down";
    pill.textContent = "Studio server down — run: node social/studio-server.mjs";
  }

  // The playhead lights the word being spoken, which is the quickest way to
  // hear whether a join lands.
  state.editor.canvas.addEventListener("click", () => {});
  setInterval(() => {
    if (!state.result) return;
    const time = state.editor.time;
    let at = 0;
    state.result.segments.forEach((segment, i) => {
      const span = segment.kind === "clip" ? Number(segment.span) || 0.5 : 0.8;
      const chip = state.chips[i];
      if (chip) chip.classList.toggle("is-playing", time >= at && time < at + span);
      at += span;
    });
  }, 120);

  renderHistory();
  document.body.classList.add("has-drawer");
  // The header is sticky and its height depends on its own padding, so it is
  // measured rather than guessed — and measured again when the window changes.
  const placeRail = () => {
    const header = document.querySelector(".hub-header");
    if (header) document.documentElement.style.setProperty("--rail-top", `${Math.round(header.getBoundingClientRect().height)}px`);
  };
  placeRail();
  window.addEventListener("resize", placeRail);
  // The drawer remembers whether it was open: someone working through a batch of
  // lines wants it there, someone writing one wants the room.
  setDrawer(drawerWasOpen());
  $("#cut-history-toggle").addEventListener("click", () => setDrawer($("#cut-history").classList.contains("is-open") ? false : true));
  $("#cut-history-close").addEventListener("click", () => setDrawer(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#cut-history").classList.contains("is-open")) setDrawer(false);
  });
  $("#cut-history-clear").addEventListener("click", () => {
    if (loadHistory().length && window.confirm("Forget every past run on this machine?")) saveHistory([]);
  });

  // The line settles, then it is split: on blur, and after a pause in typing.
  let splitTimer = null;
  $("#cut-script").addEventListener("blur", () => requestSplit());
  $("#cut-script").addEventListener("input", () => {
    clearTimeout(splitTimer);
    splitTimer = setTimeout(() => requestSplit(), 1100);
  });
  $("#cut-split-again").addEventListener("click", () => requestSplit(true));
  $("#cut-split-hide").addEventListener("click", () => showSplit(false));
  $("#cut-split-show").addEventListener("click", () => showSplit(true));

  // Closing the tab mid-run throws away everything the run has not finished
  // paying for: minutes of searching, a pile of downloads, and a question it may
  // be waiting on. The browser only allows a generic prompt, but a generic
  // prompt is enough to stop a reflex.
  window.addEventListener("beforeunload", (event) => {
    if (!state.running && !state.rendering) return;
    event.preventDefault();
    event.returnValue = "";
  });

  $("#cut-form").addEventListener("submit", run);
  $("#cut-render").addEventListener("click", renderCut);
  $("#cut-again").addEventListener("click", anotherTake);
  $("#cut-topic-suggest").addEventListener("click", suggestTopic);
  $("#cut-topic").focus();

  // The same seam Autopilot leaves: a result can be re-laid-out from the console.
  window.supercut = { state, buildComposition, renderCut };
}

init();
