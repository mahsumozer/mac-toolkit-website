// Canvas renderer for image posts.
//
// The look is the TikTok/Reels text sticker: bold centred type sitting in white
// rounded boxes that hug each line, stacked with no gap so a wrapped sentence
// reads as one shape. Everything is drawn at full export resolution and the
// canvas is scaled down with CSS for the preview, so what you see is the file.

export const CANVAS_SIZES = {
  "4:5": { w: 1080, h: 1350, label: "4:5 — feed" },
  "9:16": { w: 1080, h: 1920, label: "9:16 — story / TikTok" },
  "1:1": { w: 1080, h: 1080, label: "1:1 — square" },
};

export const TEXT_STYLES = {
  "sticker-white": { label: "White sticker", box: "#ffffff", ink: "#000000", stroke: null },
  "sticker-black": { label: "Black sticker", box: "rgba(5,5,5,0.92)", ink: "#ffffff", stroke: null },
  "sticker-accent": { label: "Orange sticker", box: "#f5941d", ink: "#050505", stroke: null },
  outline: { label: "Outlined text", box: null, ink: "#ffffff", stroke: "rgba(0,0,0,0.92)" },
};

const FONT_STACK = `Inter, "Inter Display", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;

// Metrics come out wrong if the first paint happens before the face is ready,
// and the wrap is computed from those metrics — so every draw waits for it.
let fontsReady = null;
export function ensureFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all([
      document.fonts.load(`800 72px ${FONT_STACK}`),
      document.fonts.load(`700 72px ${FONT_STACK}`),
      document.fonts.ready,
    ]).catch(() => {});
  }
  return fontsReady;
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Stock photos are fetched through the studio server's /stock/proxy so they
    // arrive same-origin; a remote image would taint the canvas and toBlob would
    // throw a SecurityError at export time rather than here.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${src}`));
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrap(ctx, text, maxWidth) {
  const out = [];
  for (const paragraph of String(text || "").split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate;
      else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return out;
}

function coverDraw(ctx, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// One text run — a headline or a body — as a stack of hugging boxes.
function drawRun(ctx, lines, opts) {
  const { fontSize, weight, style, maxWidth, centerX, top } = opts;
  ctx.font = `${weight} ${fontSize}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lineHeight = Math.round(fontSize * 1.16);
  const padX = Math.round(fontSize * 0.26);
  const radius = Math.round(fontSize * 0.2);
  let y = top;

  for (const line of lines) {
    const width = ctx.measureText(line).width;
    const boxW = Math.min(width + padX * 2, maxWidth + padX * 2);
    const boxH = lineHeight;
    if (style.box) {
      ctx.fillStyle = style.box;
      // Boxes overlap by a pixel so the seam between two lines never shows a
      // hairline of background through it.
      roundRect(ctx, centerX - boxW / 2, y - 0.5, boxW, boxH + 1, radius);
      ctx.fill();
    }
    if (style.stroke) {
      ctx.lineWidth = Math.round(fontSize * 0.16);
      ctx.strokeStyle = style.stroke;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeText(line, centerX, y + boxH / 2);
    }
    ctx.fillStyle = style.ink;
    ctx.fillText(line, centerX, y + boxH / 2);
    y += lineHeight;
  }
  return y - top;
}

/**
 * Draw one slide.
 *
 * slide: { headline, body, background: {kind, src}, scrim, textY, headlineSize, bodySize, style }
 */
export async function renderSlide(canvas, slide, options = {}) {
  await ensureFonts();
  const size = CANVAS_SIZES[options.size || "4:5"];
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  const { w, h } = size;

  ctx.fillStyle = slide.fallbackColor || "#141414";
  ctx.fillRect(0, 0, w, h);

  if (slide.background && slide.background.src) {
    try {
      coverDraw(ctx, await loadImage(slide.background.src), w, h);
    } catch {
      // A missing background leaves the flat colour behind; the text still has
      // to render, otherwise one broken URL blanks the whole slide.
    }
  }

  const scrim = slide.scrim ?? options.scrim ?? 0.18;
  if (scrim > 0) {
    ctx.fillStyle = `rgba(0,0,0,${scrim})`;
    ctx.fillRect(0, 0, w, h);
  }

  const style = TEXT_STYLES[slide.style || options.style || "sticker-white"] || TEXT_STYLES["sticker-white"];
  const maxWidth = w * 0.82;
  const centerX = w / 2;
  const headlineSize = Math.round((slide.headlineSize || options.headlineSize || 72) * (w / 1080));
  const bodySize = Math.round((slide.bodySize || options.bodySize || 62) * (w / 1080));

  ctx.font = `800 ${headlineSize}px ${FONT_STACK}`;
  const headlineLines = wrap(ctx, slide.headline, maxWidth);
  ctx.font = `800 ${bodySize}px ${FONT_STACK}`;
  const bodyLines = wrap(ctx, slide.body, maxWidth);

  const blockHeight = headlineLines.length * Math.round(headlineSize * 1.16) + bodyLines.length * Math.round(bodySize * 1.16);
  const anchor = slide.textY ?? options.textY ?? 0.5;
  let top = Math.round(h * anchor - blockHeight / 2);
  top = Math.max(40, Math.min(top, h - blockHeight - 40));

  if (headlineLines.length) {
    top += drawRun(ctx, headlineLines, { fontSize: headlineSize, weight: 800, style, maxWidth, centerX, top });
  }
  if (bodyLines.length) {
    drawRun(ctx, bodyLines, { fontSize: bodySize, weight: 800, style, maxWidth, centerX, top });
  }

  if (slide.handle) {
    const handleSize = Math.round(w * 0.028);
    ctx.font = `700 ${handleSize}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 8;
    ctx.fillText(slide.handle, centerX, h - Math.round(h * 0.045));
    ctx.shadowBlur = 0;
  }

  return canvas;
}

export function toPngDataUrl(canvas) {
  return canvas.toDataURL("image/png");
}

/**
 * Draw a video text layer into `ctx` at composition coordinates.
 *
 * The editor calls this to paint the live preview and again, on a blank
 * 1080×1920 canvas, to produce the PNG ffmpeg overlays. One function for both
 * is the point: what you drag on the canvas is byte-for-byte what lands in the
 * mp4, and no drawtext filter is involved — Homebrew's ffmpeg has none.
 *
 * Returns the block's measured height so the layer's hit box can follow the
 * text as it wraps.
 */
export function drawTextLayer(ctx, layer) {
  const style = TEXT_STYLES[layer.style || "outline"] || TEXT_STYLES.outline;
  const fontSize = Math.max(12, Math.round(layer.fontSize || 68));
  const maxWidth = Math.max(60, layer.w);

  ctx.save();
  ctx.font = `800 ${fontSize}px ${FONT_STACK}`;
  const lines = wrap(ctx, layer.text, maxWidth);
  const lineHeight = Math.round(fontSize * 1.16);
  if (lines.length) {
    drawRun(ctx, lines, {
      fontSize,
      weight: 800,
      style,
      maxWidth,
      centerX: layer.x + layer.w / 2,
      top: layer.y,
    });
  }
  ctx.restore();
  return lines.length * lineHeight;
}

// Measures without painting, so geometry can be refreshed after an edit without
// a visible flicker.
export function measureTextLayer(ctx, layer) {
  const fontSize = Math.max(12, Math.round(layer.fontSize || 68));
  ctx.save();
  ctx.font = `800 ${fontSize}px ${FONT_STACK}`;
  const lines = wrap(ctx, layer.text, Math.max(60, layer.w));
  ctx.restore();
  return Math.max(lines.length, 1) * Math.round(fontSize * 1.16);
}

// A text layer as a transparent full-frame PNG, positioned exactly where the
// editor shows it. ffmpeg overlays these at 0:0.
export async function textLayerToPng(layer, width = 1080, height = 1920) {
  await ensureFonts();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  drawTextLayer(ctx, layer);
  return canvas.toDataURL("image/png");
}
