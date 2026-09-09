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

const state = { running: false, result: null, chips: [], editor: null };

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

function recordOutcome(id, outcome) {
  const list = loadHistory();
  const entry = list.find((item) => item.id === id);
  if (!entry) return;
  entry.outcome = outcome;
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
  $("#cut-script").focus();
  toast("Loaded — change what you like, then Cut it");
}

const FEEL_LABEL = { "2.2": "long takes", "1": "balanced", "0.6": "chopped" };

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

    // A word nobody said. Either it is spoken by the studio's own voice over a
    // held frame, or it is simply typed — but it is never dropped, because the
    // script is the thing being made.
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
    captions.push({ text: segment.text, start: at, end: at + span, gap: true });
    at += span;
  }

  const duration = Math.max(1.5, Number(at.toFixed(3)));
  editor.setComposition({ duration, layers });

  for (const track of audio) {
    editor.addLayer(
      audioLayer({ name: track.path.split("/").pop(), path: track.path, src: track.src, duration: track.duration }, { start: track.start, end: track.start + track.duration }),
      { select: false },
    );
  }

  if (withCaptions) {
    for (const caption of captions) {
      editor.addLayer(
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
        { select: false },
      );
    }
  }

  editor.select(null);
  editor.draw();
  return duration;
}

/* ----------------------------------------------------------------- rendering */

async function renderCut() {
  if (!state.result) return;
  const button = $("#cut-render");
  button.disabled = true;
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

/* --------------------------------------------------------------------- run */

async function run(event) {
  event.preventDefault();
  if (state.running) return;
  const topic = $("#cut-topic").value.trim();
  const script = $("#cut-script").value.trim();
  if (!topic || !script) return;

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
      }),
    });

    let shown = 0;
    const result = await pollJob(jobId, (job) => {
      phase(job.stage || job.status);
      progress(job.progress || 0, job.stage || "");
      for (const message of (job.messages || []).slice(shown)) log(message.text, message.role === "tool-error" ? "is-error" : "is-done");
      shown = (job.messages || []).length;
    });

    state.result = result;
    recordOutcome(historyId, `${result.stats.found}/${result.stats.words} words, ${result.stats.clips} clips`);
    renderStrip(result.segments);
    if (result.missing.length) log(`nobody says: ${result.missing.join(", ")} — ${$("#cut-speak").checked ? "spoken by the studio instead" : "shown as type"}`, "is-error");

    phase("Laying it out");
    const duration = await buildComposition(result);
    log(`${state.editor.layers.length} layers, ${duration.toFixed(1)}s`, "is-done");
    phase(`Ready — ${duration.toFixed(1)}s`);
    $("#cut-render").disabled = false;
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
  $("#cut-history-toggle").addEventListener("click", () => {
    const panel = $("#cut-history");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderHistory();
  });
  $("#cut-history-clear").addEventListener("click", () => {
    if (loadHistory().length && window.confirm("Forget every past run on this machine?")) saveHistory([]);
  });

  $("#cut-form").addEventListener("submit", run);
  $("#cut-render").addEventListener("click", renderCut);
  $("#cut-topic").focus();

  // The same seam Autopilot leaves: a result can be re-laid-out from the console.
  window.supercut = { state, buildComposition, renderCut };
}

init();
