// The canvas editor: a live, draggable preview of the composition.
//
// It plays the real clips onto a 1080×1920 canvas so the layout can be judged
// and changed before anything is rendered. Selection chrome is drawn on a
// separate pass over the finished frame, so it never leaks into the export.

import { COMP_W, COMP_H, fitLayer } from "./composition.js";
import { drawTextLayer, measureTextLayer, ensureFonts } from "./render-image.js";

// Grips are sized in *screen* pixels and converted back into composition
// pixels, because the canvas is 1080 wide but displayed around 300: a grip
// fixed at 30 composition pixels is under 9 pixels under the pointer, which is
// not something anyone can grab.
const GRIP_SCREEN = 15;
// Decoded GIF frames are kept as bitmaps; these bound what one sticker costs.
const GIF_MAX_EDGE = 512;
const GIF_MAX_FRAMES = 200;
const CORNERS = ["nw", "ne", "sw", "se"];

export class Editor {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    canvas.width = COMP_W;
    canvas.height = COMP_H;

    // The frame is composed offscreen and blitted, so the selection outline can
    // be drawn on top of a clean copy without ever being part of it.
    this.frame = document.createElement("canvas");
    this.frame.width = COMP_W;
    this.frame.height = COMP_H;
    this.frameCtx = this.frame.getContext("2d");

    // Media elements have to live in the document. Chrome will not buffer past
    // metadata for a detached <video> that is never played, so a composition
    // that is only ever scrubbed would sit at readyState 1 and paint nothing.
    // Off-screen rather than display:none, which can skip decoding entirely.
    this.pool = document.createElement("div");
    this.pool.setAttribute("aria-hidden", "true");
    this.pool.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0";
    document.body.appendChild(this.pool);

    this.comp = { duration: 20, layers: [] };
    this.media = new Map(); // path -> HTMLVideoElement | HTMLImageElement
    this.selectedId = null;
    this.time = 0;
    this.playing = false;
    this.onChange = onChange || (() => {});
    this.drag = null;

    this._loop = this._loop.bind(this);
    this._wirePointer();
    ensureFonts().then(() => this.draw());
    requestAnimationFrame(this._loop);
  }

  /* ------------------------------------------------------------- composition */

  setComposition(comp) {
    this.comp = comp;
    this.selectedId = null;
    this.time = 0;
    this.syncMedia();
    this.onChange();
    this.draw();
  }

  get layers() {
    return this.comp.layers;
  }

  get selected() {
    return this.layers.find((l) => l.id === this.selectedId) || null;
  }

  select(id) {
    this.selectedId = id;
    this.onChange();
    this.draw();
  }

  addLayer(layer, { select = true } = {}) {
    this.layers.push(layer);
    this.syncMedia();
    if (select) this.selectedId = layer.id;
    this.onChange();
    this.draw();
    return layer;
  }

  removeLayer(id) {
    const index = this.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    this.layers.splice(index, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.onChange();
    this.draw();
  }

  moveLayer(id, delta) {
    const index = this.layers.findIndex((l) => l.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this.layers.length) return;
    [this.layers[index], this.layers[target]] = [this.layers[target], this.layers[index]];
    this.onChange();
    this.draw();
  }

  updateLayer(id, props) {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    Object.assign(layer, props);
    this.onChange();
    this.draw();
  }

  /* -------------------------------------------------------------- media pool */

  // One element per distinct source, shared by every layer that uses it — a
  // clip appearing twice (the blurred fill and the sharp copy) must not decode
  // twice or the two halves drift apart on screen.
  syncMedia() {
    const wanted = new Set(this.layers.filter((l) => l.src).map((l) => l.src));
    for (const [src, el] of this.media) {
      if (!wanted.has(src)) {
        if (el.kind === "gif") for (const frame of el.frames) frame.close();
        else if (el.tagName === "VIDEO" || el.tagName === "AUDIO") {
          el.pause();
          el.removeAttribute("src");
          el.load();
          el.remove();
        }
        this.media.delete(src);
      }
    }
    for (const layer of this.layers) {
      if (!layer.src || this.media.has(layer.src)) continue;
      if (layer.type === "gif") {
        // Frames are decoded here rather than left to an <img>. A detached
        // <img> never advances its animation at all, and an attached one
        // advances on the browser's own clock — which is not the composition's,
        // so the preview would be showing a frame the render never picks. With
        // the frames in hand the phase follows the layer's start and trim.
        const film = { kind: "gif", frames: [], durations: [], total: 0, width: 0, height: 0, ready: false };
        this.media.set(layer.src, film);
        this.decodeGif(layer.src, film);
      } else if (layer.type === "image") {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => this.draw();
        img.src = layer.src;
        this.media.set(layer.src, img);
      } else if (layer.type === "audio") {
        // Audible in the preview, unlike the clips: a voiceover you cannot hear
        // is one you cannot time. Its element is driven by the transport in
        // syncAudio() rather than by the draw loop, which never touches it.
        const audio = document.createElement("audio");
        audio.preload = "auto";
        audio.src = layer.src;
        this.pool.appendChild(audio);
        this.media.set(layer.src, audio);
      } else if (layer.type === "video") {
        const video = document.createElement("video");
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.src = layer.src;
        // While paused nothing drives a redraw, so the canvas has to be told
        // every time a frame becomes paintable. `loadedmetadata` alone is not
        // enough: it fires at readyState 1, which draw() skips, and without
        // these the composition stays black until the first Play.
        for (const event of ["loadedmetadata", "loadeddata", "canplay", "seeked"]) {
          video.addEventListener(event, () => this.draw());
        }
        // Nudging currentTime once metadata lands forces a decode, so the very
        // first frame appears without waiting for anyone to press Play.
        video.addEventListener(
          "loadedmetadata",
          () => {
            try {
              video.currentTime = Math.min(0.04, Math.max(video.duration - 0.05, 0));
            } catch {}
          },
          { once: true },
        );
        this.pool.appendChild(video);
        video.load();
        this.media.set(layer.src, video);
      }
    }
  }

  // Decodes every frame once, downscaled to something the canvas will actually
  // use, and closes the VideoFrames as it goes so the decoder's buffers are not
  // held for the life of the page.
  async decodeGif(src, film) {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`${res.status}`);
      const type = res.headers.get("content-type") || "image/gif";
      const decoder = new ImageDecoder({ data: await res.arrayBuffer(), type });
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      const count = Math.min(track.frameCount || 1, GIF_MAX_FRAMES);

      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        if (!film.width) {
          const scale = Math.min(1, GIF_MAX_EDGE / Math.max(image.displayWidth, image.displayHeight));
          film.width = Math.max(1, Math.round(image.displayWidth * scale));
          film.height = Math.max(1, Math.round(image.displayHeight * scale));
        }
        film.frames.push(await createImageBitmap(image, { resizeWidth: film.width, resizeHeight: film.height }));
        // A GIF frame with no stated duration is the 100ms browsers assume.
        const ms = image.duration ? image.duration / 1000 : 100;
        film.durations.push(ms);
        film.total += ms;
        image.close();
      }
      decoder.close();
      film.ready = film.frames.length > 0;
      this.draw();
    } catch (error) {
      // Falling back to an <img> at least shows the first frame rather than a
      // hole where the sticker should be.
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => this.draw();
      img.src = src;
      this.media.set(src, img);
    }
  }

  // Which frame of a decoded GIF belongs at the current composition time.
  gifFrame(layer, film) {
    if (!film.ready || !film.total) return null;
    const elapsed = ((this.time - layer.start + (Number(layer.trim) || 0)) * 1000) % film.total;
    let at = elapsed < 0 ? elapsed + film.total : elapsed;
    for (let i = 0; i < film.frames.length; i++) {
      at -= film.durations[i];
      if (at < 0) return film.frames[i];
    }
    return film.frames[film.frames.length - 1];
  }

  /**
   * Resolves once every visible layer can report a source size, or after
   * `timeout`.
   *
   * Serialising reads each layer's intrinsic dimensions to work out its crop,
   * and a layer that cannot answer is dropped from the render. A person is slow
   * enough that this is rarely hit; a script that adds layers and renders in the
   * same breath hits it every time, and the result is a video of captions over
   * black.
   */
  async whenReady(timeout = 15000) {
    const pending = () =>
      this.layers.filter((layer) => {
        if (!layer.visible || layer.type === "text" || layer.type === "audio") return false;
        const size = this.sourceSize(layer);
        return !size.w || !size.h;
      });

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const waiting = pending();
      if (!waiting.length) return { ready: true, waiting: [] };
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return { ready: false, waiting: pending().map((l) => l.name) };
  }

  sourceSize(layer) {
    const el = this.media.get(layer.src);
    if (!el) return { w: 0, h: 0 };
    if (el.kind === "gif") return { w: el.width, h: el.height };
    if (el.tagName === "VIDEO") return { w: el.videoWidth, h: el.videoHeight };
    return { w: el.naturalWidth, h: el.naturalHeight };
  }

  /* --------------------------------------------------------------- transport */

  play() {
    this.playing = true;
    for (const layer of this.layers) {
      const el = this.media.get(layer.src);
      if (el && el.tagName === "VIDEO") el.play().catch(() => {});
    }
    this.syncAudio();
    this.onChange();
  }

  pause() {
    this.playing = false;
    for (const el of this.media.values()) if (el.tagName === "VIDEO" || el.tagName === "AUDIO") el.pause();
    this.onChange();
  }

  // Audio is not drawn, so it needs its own pass: play the layers whose window
  // covers the playhead, pause the rest, and keep each one lined up with the
  // composition clock. Scrubbing moves it too, which is the whole point of
  // having it on the timeline.
  syncAudio() {
    for (const layer of this.layers) {
      if (layer.type !== "audio") continue;
      const el = this.media.get(layer.src);
      if (!el || el.tagName !== "AUDIO") continue;
      const inside = layer.visible && this.time >= layer.start && this.time <= layer.end;
      const want = (Number(layer.trim) || 0) + (this.time - layer.start);
      el.volume = Math.max(0, Math.min(Number(layer.volume) ?? 1, 1));
      if (!inside || !this.playing) {
        if (!el.paused) el.pause();
        if (inside && el.readyState >= 1 && Math.abs(el.currentTime - want) > 0.1) el.currentTime = want;
        continue;
      }
      if (el.readyState >= 1 && Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
      if (el.paused) el.play().catch(() => {});
    }
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(time) {
    this.time = Math.max(0, Math.min(time, this.comp.duration));
    this.draw();
    this.syncAudio();
    this.onChange();
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    if (this.playing) {
      const dt = this._last ? (now - this._last) / 1000 : 0;
      this.time += dt;
      if (this.time >= this.comp.duration) {
        this.time = 0;
        for (const el of this.media.values()) if (el.tagName === "VIDEO") el.currentTime = 0;
      }
      this.draw();
      this.syncAudio();
      this.onChange();
    }
    this._last = now;
  }

  // Where a layer's source should be at composition time `t`, wrapping so a
  // short clip under a long composition loops instead of freezing on its last
  // frame.
  sourceTime(layer, el) {
    const span = (el.duration || 0) - (layer.trim || 0);
    const local = this.time - layer.start;
    if (!Number.isFinite(span) || span <= 0.05) return layer.trim || 0;
    return (layer.trim || 0) + (((local % span) + span) % span);
  }

  /* ------------------------------------------------------------------ drawing */

  draw() {
    const ctx = this.frameCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, COMP_W, COMP_H);

    for (const layer of this.layers) {
      if (!layer.visible) continue;
      if (this.time < layer.start || this.time > layer.end) continue;
      // Sound contributes nothing to the picture.
      if (layer.type === "audio") continue;
      if (layer.type === "text") {
        ctx.globalAlpha = layer.opacity ?? 1;
        const height = drawTextLayer(ctx, layer);
        if (height && Math.abs(height - layer.h) > 2) layer.h = height;
        ctx.globalAlpha = 1;
        continue;
      }

      const el = this.media.get(layer.src);
      if (!el) continue;
      const size = this.sourceSize(layer);
      if (!size.w || !size.h) continue;

      let source = el;
      if (el.kind === "gif") {
        source = this.gifFrame(layer, el);
        if (!source) continue;
      }

      if (el.tagName === "VIDEO") {
        const want = this.sourceTime(layer, el);
        // Seek only on real drift, and never while one is already in flight.
        // A seek lands on the nearest decodable frame, not the exact time asked
        // for, so re-seeking on any difference at all means every `seeked`
        // schedules the next one: readyState never climbs out of 1 and the
        // canvas stays black until something forces playback.
        const tolerance = this.playing ? 0.3 : 0.1;
        if (!el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - want) > tolerance) {
          el.currentTime = want;
        }
        // readyState 2 means "a frame at the current position is decoded".
        // Below that there is nothing to paint yet; the media events call back
        // once there is.
        if (el.readyState < 2) continue;
      }

      const { crop, rect } = fitLayer(layer, size.w, size.h);
      ctx.save();
      ctx.globalAlpha = layer.opacity ?? 1;
      // Only effects ffmpeg can reproduce are drawn here. Anything the render
      // cannot match would make the preview a lie, which is the one thing this
      // editor exists to avoid.
      if (layer.blur) ctx.filter = `blur(${layer.blur}px)`;
      try {
        ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, rect.x, rect.y, rect.w, rect.h);
      } catch {
        // A frame that is not decodable yet is skipped rather than aborting the
        // whole draw and blanking every other layer.
      }
      ctx.restore();
    }
    ctx.restore();

    const out = this.ctx;
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.clearRect(0, 0, COMP_W, COMP_H);
    out.drawImage(this.frame, 0, 0);
    this._drawChrome(out);
  }

  // One composition pixel is this many screen pixels; everything the pointer has
  // to hit is sized through it.
  displayScale() {
    return this.contentRect().scale;
  }

  gripSize() {
    return Math.max(16, Math.round(GRIP_SCREEN / this.displayScale()));
  }

  // Grips sit just inside the box. A full-frame layer's corners are on the
  // canvas edge, and a grip drawn outside it would be unclickable.
  gripRects(box) {
    const g = this.gripSize();
    const inset = g * 0.5;
    return {
      nw: { x: box.x + inset - g / 2, y: box.y + inset - g / 2, w: g, h: g },
      ne: { x: box.x + box.w - inset - g / 2, y: box.y + inset - g / 2, w: g, h: g },
      sw: { x: box.x + inset - g / 2, y: box.y + box.h - inset - g / 2, w: g, h: g },
      se: { x: box.x + box.w - inset - g / 2, y: box.y + box.h - inset - g / 2, w: g, h: g },
    };
  }

  _drawChrome(ctx) {
    const layer = this.selected;
    if (!layer) return;
    const box = this.editBox(layer);
    const scale = this.displayScale();
    ctx.save();
    ctx.strokeStyle = "#f5941d";
    ctx.lineWidth = Math.max(3, 2 / scale);
    ctx.setLineDash([16, 10]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);

    const grips = this.gripRects(box);
    for (const corner of CORNERS) {
      const grip = grips[corner];
      ctx.fillStyle = "#f5941d";
      ctx.fillRect(grip.x, grip.y, grip.w, grip.h);
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = Math.max(2, 1.5 / scale);
      ctx.strokeRect(grip.x, grip.y, grip.w, grip.h);
    }
    ctx.restore();
  }

  // The frame being edited: the layer's own rectangle, which for a "contain"
  // layer is larger than the pixels on screen. Selection chrome and the resize
  // grips use this, so what you drag is what the inspector's numbers say.
  editBox(layer) {
    if (layer.type === "text") {
      return { x: layer.x, y: layer.y, w: layer.w, h: Math.max(measureTextLayer(this.frameCtx, layer), 40) };
    }
    return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
  }

  // The box the pointer hits when selecting. For a contained clip that is the
  // drawn rect, not the declared one — clicking the letterboxing beside a video
  // should not grab it.
  layerBox(layer) {
    if (layer.type === "text") {
      const height = measureTextLayer(this.frameCtx, layer);
      return { x: layer.x, y: layer.y, w: layer.w, h: Math.max(height, 40) };
    }
    const size = this.sourceSize(layer);
    if (!size.w) return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    return fitLayer(layer, size.w, size.h).rect;
  }

  // Arrow-key nudging: one pixel, or ten with shift. Dragging is for roughing
  // out, this is for landing on a number.
  nudge(dx, dy) {
    const layer = this.selected;
    if (!layer) return false;
    layer.x = Math.round(layer.x + dx);
    layer.y = Math.round(layer.y + dy);
    this.onChange();
    this.draw();
    return true;
  }

  /* -------------------------------------------------------------- interaction */

  // Where the 1080x1920 image actually sits inside the canvas element. The
  // element is width:100% with a max-height, so it is routinely wider than the
  // frame it draws and the picture is letterboxed inside it. Mapping against
  // the element box instead of the picture puts every drag, resize and drop off
  // by the size of those bars.
  contentRect() {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / COMP_W, rect.height / COMP_H) || 1;
    const w = COMP_W * scale;
    const h = COMP_H * scale;
    return { left: rect.left + (rect.width - w) / 2, top: rect.top + (rect.height - h) / 2, scale };
  }

  // Client coordinates to composition pixels. Public because dropping a clip
  // has to land exactly where the pointer let go, using the same mapping the
  // drag interaction uses.
  toComposition(event) {
    const { left, top, scale } = this.contentRect();
    return { x: (event.clientX - left) / scale, y: (event.clientY - top) / scale };
  }

  _toComp(event) {
    return this.toComposition(event);
  }

  _hit(point) {
    // Topmost first: the last layer drawn is the one the pointer is over.
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (!layer.visible) continue;
      if (this.time < layer.start || this.time > layer.end) continue;
      const box = this.layerBox(layer);
      if (point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h) return { layer, box };
    }
    return null;
  }

  _wirePointer() {
    this.canvas.addEventListener("pointerdown", (event) => {
      const point = this._toComp(event);
      const selected = this.selected;

      if (selected) {
        const box = this.editBox(selected);
        const grips = this.gripRects(box);
        for (const corner of CORNERS) {
          const grip = grips[corner];
          const pad = this.gripSize() * 0.4;
          if (
            point.x >= grip.x - pad &&
            point.x <= grip.x + grip.w + pad &&
            point.y >= grip.y - pad &&
            point.y <= grip.y + grip.h + pad
          ) {
            // The opposite corner is the anchor and stays put while the drag
            // moves the one under the pointer.
            const anchor = {
              x: corner === "nw" || corner === "sw" ? selected.x + selected.w : selected.x,
              y: corner === "nw" || corner === "ne" ? selected.y + selected.h : selected.y,
            };
            this.drag = {
              mode: "resize",
              corner,
              anchor,
              id: selected.id,
              from: point,
              x: selected.x,
              y: selected.y,
              w: selected.w,
              h: selected.h,
              fontSize: selected.fontSize,
            };
            this.canvas.setPointerCapture(event.pointerId);
            return;
          }
        }
      }

      const hit = this._hit(point);
      if (!hit) {
        this.selectedId = null;
        this.onChange();
        this.draw();
        return;
      }
      this.selectedId = hit.layer.id;
      this.drag = { mode: "move", id: hit.layer.id, from: point, x: hit.layer.x, y: hit.layer.y };
      this.canvas.setPointerCapture(event.pointerId);
      this.onChange();
      this.draw();
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      const point = this._toComp(event);
      const layer = this.layers.find((l) => l.id === this.drag.id);
      if (!layer) return;
      const dx = point.x - this.drag.from.x;
      const dy = point.y - this.drag.from.y;

      if (this.drag.mode === "move") {
        layer.x = Math.round(this.drag.x + dx);
        layer.y = Math.round(this.drag.y + dy);
      } else if (layer.type === "text") {
        // Text scales by type size, with the wrap width following it, so a
        // resized caption keeps the same number of lines. Only the horizontal
        // drag counts — dragging a text block taller means nothing.
        const signed = this.drag.corner === "nw" || this.drag.corner === "sw" ? -dx : dx;
        const factor = Math.max(0.2, (this.drag.w + signed) / Math.max(this.drag.w, 1));
        layer.w = Math.max(120, Math.round(this.drag.w * factor));
        layer.fontSize = Math.max(18, Math.round(this.drag.fontSize * factor));
        if (this.drag.corner === "nw" || this.drag.corner === "sw") {
          layer.x = Math.round(this.drag.anchor.x - layer.w);
        }
      } else {
        // The anchor corner stays put; the box grows away from it in whichever
        // direction the pointer went.
        const { anchor } = this.drag;
        const w = Math.max(60, Math.abs(point.x - anchor.x));
        const h = Math.max(60, Math.abs(point.y - anchor.y));
        layer.w = Math.round(w);
        layer.h = Math.round(h);
        layer.x = Math.round(point.x > anchor.x ? anchor.x : anchor.x - w);
        layer.y = Math.round(point.y > anchor.y ? anchor.y : anchor.y - h);
      }
      this.onChange();
      this.draw();
    });

    // Without this the grips look like decoration; the cursor is the only hint
    // that the corner does something different from the middle.
    this.canvas.addEventListener("pointermove", (event) => {
      if (this.drag) return;
      const selected = this.selected;
      if (!selected) {
        this.canvas.style.cursor = this._hit(this._toComp(event)) ? "grab" : "default";
        return;
      }
      const point = this._toComp(event);
      const grips = this.gripRects(this.editBox(selected));
      const pad = this.gripSize() * 0.4;
      for (const corner of CORNERS) {
        const grip = grips[corner];
        if (point.x >= grip.x - pad && point.x <= grip.x + grip.w + pad && point.y >= grip.y - pad && point.y <= grip.y + grip.h + pad) {
          this.canvas.style.cursor = corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
          return;
        }
      }
      this.canvas.style.cursor = this._hit(point) ? "grab" : "default";
    });

    const end = (event) => {
      if (!this.drag) return;
      this.drag = null;
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch {}
      this.onChange();
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
  }
}
