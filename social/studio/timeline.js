// The timeline: the composition's second view.
//
// The canvas answers "where is this layer"; this answers "when is it". Both
// read the same layer objects, so a bar dragged here moves the same numbers the
// inspector shows and the render reads — there is no separate timing model to
// fall out of step.
//
// Rows are laid out twice, once as labels in the gutter and once as bars in the
// lanes, and the two are kept in the same order with the same fixed row height.
// That is why ROW_H and RULER_H below have to match the CSS: a mismatch shows up
// as labels sliding away from their bars further down the list.

const ROW_H = 30; // --tl-row in studio.css
const RULER_H = 24; // --tl-ruler in studio.css
const EDGE = 10; // trim-handle grab zone, in screen pixels
const SNAP = 0.05; // seconds; finer than anyone can drag, coarse enough to land on
const MIN_SPAN = 0.2;
const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const snap = (t) => Number((Math.round(t / SNAP) * SNAP).toFixed(3));
const fmt = (t) => `${Number(t).toFixed(1)}s`;

export class Timeline {
  constructor(els, editor, { onChange } = {}) {
    this.els = els;
    this.editor = editor;
    this.onChange = onChange || (() => {});
    this.pps = Number(els.zoom.value) || 40;
    this.userZoom = false;
    this.drag = null;
    // Rebuild guards: the structure is re-created only when the rows themselves
    // change, and the ruler only when the scale does. Everything else — bar
    // geometry, the playhead — is a style write on nodes that already exist,
    // because sync() runs on every animation frame while the preview plays.
    this.structure = "";
    this.rulerKey = "";
    // Ticked rows, for acting on several layers at once. Kept here rather than
    // on the editor because it is a timeline affordance: the editor's single
    // selection still drives the canvas chrome and the inspector.
    this.checked = new Set();

    els.zoom.addEventListener("input", () => {
      this.userZoom = true;
      this.pps = Number(els.zoom.value);
      this.layout();
    });
    // The gutter has no scrollbar of its own; it is moved by the lanes'.
    els.scroll.addEventListener("scroll", () => {
      els.gutterScroll.scrollTop = els.scroll.scrollTop;
    });
    this._wireLanes();
    this._wireRuler();
  }

  get duration() {
    return this.editor.comp.duration || 20;
  }

  // The ticked layers that still exist, in stack order. Falls back to the single
  // selection so the toolbar buttons work before anything is ticked.
  selection() {
    const ids = this.editor.layers.filter((l) => this.checked.has(l.id)).map((l) => l.id);
    if (ids.length) return ids;
    return this.editor.selectedId ? [this.editor.selectedId] : [];
  }

  clearChecks() {
    if (!this.checked.size) return;
    this.checked.clear();
    this.structure = "";
    this.sync();
  }

  // Top of the list is the top of the stack, the same way the layer list reads.
  get rows() {
    return this.editor.layers.slice().reverse();
  }

  /* ------------------------------------------------------------------ layout */

  // Pixels per second that make the whole composition fit the visible width.
  // Only used until the zoom slider is touched — after that the scale is the
  // user's, even if the composition gets longer.
  fitZoom() {
    const width = this.els.scroll.clientWidth;
    if (!width) return this.pps;
    return clamp(Math.round((width - 8) / this.duration), Number(this.els.zoom.min), Number(this.els.zoom.max));
  }

  sync() {
    const rows = this.rows;
    const signature =
      rows.map((l) => `${l.id}:${l.type}:${l.visible}:${l.type === "text" ? l.text : l.name}`).join("|") +
      `#${this.editor.selectedId}`;
    if (signature !== this.structure) {
      this.structure = signature;
      this.build(rows);
    }
    this.layout();
  }

  build(rows) {
    const { gutter, lanes } = this.els;
    gutter.innerHTML = "";
    lanes.innerHTML = "";

    const spacer = document.createElement("div");
    spacer.className = "tl-gutter-spacer";
    if (rows.length) {
      const all = document.createElement("input");
      all.type = "checkbox";
      all.className = "tl-check tl-check-all";
      all.title = "Select every layer";
      all.setAttribute("aria-label", "Select every layer");
      const ticked = rows.filter((l) => this.checked.has(l.id)).length;
      all.checked = ticked === rows.length;
      // Neither all nor none: the box shows the in-between state rather than
      // pretending the selection is empty.
      all.indeterminate = ticked > 0 && ticked < rows.length;
      all.addEventListener("change", () => {
        if (all.checked) for (const layer of rows) this.checked.add(layer.id);
        else this.checked.clear();
        this.structure = "";
        this.sync();
        this.onChange();
      });
      spacer.appendChild(all);
    }
    gutter.appendChild(spacer);

    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "tl-empty";
      empty.textContent = "No layers yet — drag a clip, a still or a GIF onto the canvas, or speak the script.";
      lanes.appendChild(empty);
      return;
    }

    for (const layer of rows) {
      const label = document.createElement("div");
      label.className = `tl-label${layer.id === this.editor.selectedId ? " is-active" : ""}${layer.visible ? "" : " is-hidden"}${this.checked.has(layer.id) ? " is-checked" : ""}`;
      label.dataset.id = layer.id;

      const tick = document.createElement("input");
      tick.type = "checkbox";
      tick.className = "tl-check";
      tick.checked = this.checked.has(layer.id);
      tick.title = "Select for bulk actions";
      tick.setAttribute("aria-label", `Select ${layer.type === "text" ? layer.text : layer.name}`);
      tick.addEventListener("click", (event) => event.stopPropagation());
      tick.addEventListener("change", () => {
        if (tick.checked) this.checked.add(layer.id);
        else this.checked.delete(layer.id);
        this.structure = "";
        this.sync();
        this.onChange();
      });
      label.appendChild(tick);

      const eye = document.createElement("span");
      eye.className = "tl-label-eye";
      eye.textContent = layer.visible ? "◉" : "○";
      eye.title = layer.visible ? "Hide" : "Show";
      eye.addEventListener("click", (event) => {
        event.stopPropagation();
        this.editor.updateLayer(layer.id, { visible: !layer.visible });
      });
      const name = document.createElement("span");
      name.className = "tl-label-name";
      name.textContent = layer.type === "text" ? `“${layer.text}”` : layer.name;
      label.append(eye, name);
      label.addEventListener("click", () => this.editor.select(layer.id));
      gutter.appendChild(label);

      const lane = document.createElement("div");
      lane.className = "tl-lane";
      lane.dataset.id = layer.id;

      const bar = document.createElement("div");
      bar.className = `tl-bar is-${layer.type}${layer.id === this.editor.selectedId ? " is-active" : ""}${layer.visible ? "" : " is-hidden"}`;
      bar.dataset.id = layer.id;
      bar.innerHTML =
        '<span class="tl-grip tl-grip-in"></span>' +
        '<span class="tl-bar-text"></span>' +
        '<span class="tl-grip tl-grip-out"></span>';
      lane.appendChild(bar);
      lanes.appendChild(lane);
    }
  }

  layout() {
    if (!this.userZoom) {
      const fit = this.fitZoom();
      if (fit !== this.pps) {
        this.pps = fit;
        this.els.zoom.value = String(fit);
      }
    }
    const width = Math.max(Math.round(this.duration * this.pps), 40);
    this.els.canvas.style.width = `${width}px`;
    this.drawRuler(width);

    // A horizontal scrollbar takes height from the lanes but not from the
    // gutter beside them, so the two would run out of scroll at different
    // points and the labels would drift off their bars at the bottom of a long
    // list. Padding the gutter by the scrollbar's height makes the two scroll
    // ranges identical again.
    const bar = Math.max(0, this.els.scroll.offsetHeight - this.els.scroll.clientHeight);
    if (bar !== this._scrollbar) {
      this._scrollbar = bar;
      this.els.gutter.style.paddingBottom = `${bar}px`;
      // The height cap is written in rows, and a horizontal scrollbar eats into
      // it — three rows became two and a half. Measured rather than assumed,
      // because it is zero on a machine with overlay scrollbars.
      const root = this.els.scroll.closest(".timeline");
      if (root) root.style.setProperty("--tl-hbar", `${bar}px`);
    }

    for (const bar of this.els.lanes.querySelectorAll(".tl-bar")) {
      const layer = this.editor.layers.find((l) => l.id === bar.dataset.id);
      if (!layer) continue;
      const start = Math.max(0, Number(layer.start) || 0);
      const end = Math.max(start, Number(layer.end) || 0);
      bar.style.left = `${start * this.pps}px`;
      bar.style.width = `${Math.max((end - start) * this.pps, 6)}px`;
      bar.querySelector(".tl-bar-text").textContent =
        `${layer.type === "text" ? layer.text || "Text" : layer.name} · ${fmt(end - start)}`;
      bar.title = `${fmt(start)} → ${fmt(end)}`;
    }

    const x = clamp(this.editor.time, 0, this.duration) * this.pps;
    this.els.playhead.style.left = `${x}px`;
    this.els.time.textContent = fmt(this.editor.time);

    // Follow the playhead while it runs, but never fight a scroll in progress:
    // only nudge when it has actually left the window.
    if (this.editor.playing && !this.drag) {
      const view = this.els.scroll;
      if (x < view.scrollLeft + 20 || x > view.scrollLeft + view.clientWidth - 20) {
        view.scrollLeft = Math.max(0, x - view.clientWidth * 0.4);
      }
    }
  }

  drawRuler(width) {
    // A tick every `step` seconds, where step is the smallest one that leaves at
    // least 58px between labels — otherwise the numbers overprint each other as
    // soon as the composition is long.
    const step = TICK_STEPS.find((s) => s * this.pps >= 58) || TICK_STEPS[TICK_STEPS.length - 1];
    const key = `${step}:${width}`;
    if (key === this.rulerKey) return;
    this.rulerKey = key;

    const ruler = this.els.ruler;
    ruler.innerHTML = "";
    for (let t = 0; t <= this.duration + 0.001; t += step) {
      const tick = document.createElement("span");
      tick.className = "tl-tick";
      tick.style.left = `${t * this.pps}px`;
      tick.textContent = step < 1 ? `${t.toFixed(2)}` : `${Math.round(t)}s`;
      ruler.appendChild(tick);
    }
  }

  /* ------------------------------------------------------------- interaction */

  _timeAt(clientX) {
    const rect = this.els.lanes.getBoundingClientRect();
    return clamp(snap((clientX - rect.left) / this.pps), 0, this.duration);
  }

  // Dragging near the playhead lands on it. Cutting a clip exactly where the
  // frame is being previewed is the one alignment worth helping with.
  _magnet(t) {
    return Math.abs(t - this.editor.time) * this.pps < 8 ? snap(this.editor.time) : t;
  }

  _wireLanes() {
    const lanes = this.els.lanes;

    lanes.addEventListener("pointerdown", (event) => {
      const bar = event.target.closest(".tl-bar");
      if (!bar) {
        this.editor.seek(this._timeAt(event.clientX));
        return;
      }
      const layer = this.editor.layers.find((l) => l.id === bar.dataset.id);
      if (!layer) return;
      this.editor.select(layer.id);

      const rect = bar.getBoundingClientRect();
      const from = event.clientX - rect.left;
      const mode = from <= EDGE ? "in" : rect.width - from <= EDGE ? "out" : "move";
      this.drag = {
        mode,
        id: layer.id,
        clientX: event.clientX,
        start: Number(layer.start) || 0,
        end: Number(layer.end) || 0,
        trim: Number(layer.trim) || 0,
      };
      lanes.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    lanes.addEventListener("pointermove", (event) => {
      if (!this.drag) {
        const bar = event.target.closest(".tl-bar");
        if (!bar) {
          lanes.style.cursor = "default";
          return;
        }
        const rect = bar.getBoundingClientRect();
        const from = event.clientX - rect.left;
        lanes.style.cursor = from <= EDGE || rect.width - from <= EDGE ? "ew-resize" : "grab";
        return;
      }

      const layer = this.editor.layers.find((l) => l.id === this.drag.id);
      if (!layer) return;
      const dt = (event.clientX - this.drag.clientX) / this.pps;

      if (this.drag.mode === "move") {
        const span = this.drag.end - this.drag.start;
        const start = this._magnet(clamp(snap(this.drag.start + dt), 0, Math.max(this.duration - span, 0)));
        this.editor.updateLayer(layer.id, { start, end: snap(start + span) });
      } else if (this.drag.mode === "in") {
        const start = this._magnet(clamp(snap(this.drag.start + dt), 0, this.drag.end - MIN_SPAN));
        // Trimming the head of a clip moves its in-point with it, so the frames
        // under the bar stay where they were instead of the whole clip
        // restarting later. Text and stills have no in-point to move.
        const patch = { start };
        if (layer.type === "video" || layer.type === "audio") patch.trim = Math.max(0, snap(this.drag.trim + (start - this.drag.start)));
        this.editor.updateLayer(layer.id, patch);
      } else {
        const end = this._magnet(clamp(snap(this.drag.end + dt), (Number(layer.start) || 0) + MIN_SPAN, this.duration));
        this.editor.updateLayer(layer.id, { end });
      }
    });

    const end = (event) => {
      if (!this.drag) return;
      this.drag = null;
      try {
        lanes.releasePointerCapture(event.pointerId);
      } catch {}
      this.onChange();
    };
    lanes.addEventListener("pointerup", end);
    lanes.addEventListener("pointercancel", end);
  }

  _wireRuler() {
    const ruler = this.els.ruler;
    let scrubbing = false;
    ruler.addEventListener("pointerdown", (event) => {
      scrubbing = true;
      ruler.setPointerCapture(event.pointerId);
      this.editor.seek(this._timeAt(event.clientX));
    });
    ruler.addEventListener("pointermove", (event) => {
      if (scrubbing) this.editor.seek(this._timeAt(event.clientX));
    });
    const stop = (event) => {
      if (!scrubbing) return;
      scrubbing = false;
      try {
        ruler.releasePointerCapture(event.pointerId);
      } catch {}
    };
    ruler.addEventListener("pointerup", stop);
    ruler.addEventListener("pointercancel", stop);
  }
}

export { ROW_H, RULER_H };
