// The composition: one description of a video that both the canvas editor and
// the ffmpeg render read.
//
// The rule that keeps the preview honest is that every layer carries an
// explicit source crop *and* an explicit destination rect, both in real pixels.
// Canvas draws it as `drawImage(src, sx,sy,sw,sh, x,y,w,h)`; ffmpeg draws it as
// `crop=sw:sh:sx:sy,scale=w:h` then `overlay=x:y`. Neither side re-derives the
// geometry, so neither can disagree with the other.

/**
 * The frame a video is composed in.
 *
 * Portrait is the default because that is what the feeds this is built for
 * want, but nothing below is written for it: every helper here works from
 * COMP_W and COMP_H, so the same code lays out a wide frame.
 */
export const SIZES = {
  portrait: { id: "portrait", label: "Portrait 9:16", short: "9:16", w: 1080, h: 1920 },
  landscape: { id: "landscape", label: "Landscape 16:9", short: "16:9", w: 1920, h: 1080 },
  square: { id: "square", label: "Square 1:1", short: "1:1", w: 1080, h: 1080 },
};

// `let`, not `const`: a module export is a live binding, so every module that
// reads COMP_W *inside a function* sees the frame the composition is actually
// in. What this does not survive is a table of geometry built at import time
// next to its own import — those have to be functions, or they keep the frame
// that happened to be current when the file loaded.
export let COMP_W = SIZES.portrait.w;
export let COMP_H = SIZES.portrait.h;
export let COMP_SIZE = SIZES.portrait.id;

/** Switch the frame every module composes in. Returns the size it settled on. */
export function setCompSize(id) {
  const size = SIZES[id] || SIZES.portrait;
  COMP_W = size.w;
  COMP_H = size.h;
  COMP_SIZE = size.id;
  return size;
}

/** The named size closest to a pair of dimensions — for reopening a project. */
export function sizeFromDimensions(w, h) {
  if (!w || !h) return SIZES.portrait;
  const ratio = w / h;
  let best = SIZES.portrait;
  for (const size of Object.values(SIZES)) {
    if (Math.abs(size.w / size.h - ratio) < Math.abs(best.w / best.h - ratio)) best = size;
  }
  return best;
}

/**
 * Carry a layer from one frame into another.
 *
 * Boxes are stretched to the new frame rather than re-centred, so a layer that
 * filled the frame still fills it and one that sat a third of the way down
 * still sits there. A "cover" layer re-derives its crop from the new box, so
 * the picture inside is not distorted — only the hole it shows through is.
 * Type is scaled by the smaller of the two, which keeps a caption inside a
 * frame that got shorter.
 */
export function rescaleLayer(layer, fromW, fromH, toW, toH) {
  if (!fromW || !fromH || (fromW === toW && fromH === toH)) return layer;
  const kx = toW / fromW;
  const ky = toH / fromH;
  if (layer.type !== "audio") {
    layer.x = Math.round((Number(layer.x) || 0) * kx);
    layer.y = Math.round((Number(layer.y) || 0) * ky);
    layer.w = Math.round((Number(layer.w) || 0) * kx);
    layer.h = Math.round((Number(layer.h) || 0) * ky);
  }
  if (layer.fontSize) layer.fontSize = Math.max(18, Math.round(layer.fontSize * Math.min(kx, ky)));
  return layer;
}

let counter = 0;
export const uid = (prefix = "l") => `${prefix}${++counter}${Math.random().toString(36).slice(2, 6)}`;

export function newLayer(props = {}) {
  return {
    id: uid(),
    type: "video",
    name: "Layer",
    x: 0,
    y: 0,
    w: COMP_W,
    h: COMP_H,
    fit: "cover",
    blur: 0,
    opacity: 1,
    // The rest of what a layer can have done to it. Every one of these is
    // drawn by the canvas *and* reproduced by ffmpeg — that pairing is the
    // rule for adding one, not the look of it in the preview.
    speed: 1, // clips only: 0.25 slow-motion to 4 time-lapse
    rotate: 0, // degrees, about the centre of the drawn picture
    flipH: false,
    flipV: false,
    fadeIn: 0, // seconds, picture and sound together
    fadeOut: 0,
    brightness: 1, // 1 is untouched; CSS-filter scale, so 2 is twice as bright
    contrast: 1,
    saturation: 1, // 0 is black and white
    hue: 0, // degrees around the wheel
    start: 0,
    end: 0,
    trim: 0,
    volume: 0,
    visible: true,
    ...props,
  };
}

/** The default backdrop of a composition, drawn under every layer. */
export const DEFAULT_BACKGROUND = "#000000";

/** True when a layer has any colour work on it that the render must repeat. */
export function hasColorWork(layer) {
  return (
    Math.abs((layer.brightness ?? 1) - 1) > 0.005 ||
    Math.abs((layer.contrast ?? 1) - 1) > 0.005 ||
    Math.abs((layer.saturation ?? 1) - 1) > 0.005 ||
    Math.abs(layer.hue || 0) > 0.5
  );
}

/**
 * How visible a layer is at composition time `t`, once its fades are counted.
 * Straight ramps, in and out, multiplied into the layer's own opacity — the
 * same arithmetic ffmpeg's `fade=alpha=1` does, which is the point.
 */
export function fadeAlpha(layer, t) {
  const start = Number(layer.start) || 0;
  const end = Number(layer.end) || 0;
  let alpha = 1;
  const fi = Number(layer.fadeIn) || 0;
  const fo = Number(layer.fadeOut) || 0;
  if (fi > 0) alpha = Math.min(alpha, (t - start) / fi);
  if (fo > 0) alpha = Math.min(alpha, (end - t) / fo);
  return Math.max(0, Math.min(1, alpha));
}

/**
 * Change a clip's speed and keep the same stretch of footage on the timeline:
 * at twice the speed the same frames take half as long, so the layer's end
 * moves in. The end is clamped to the composition, so speeding a clip up can
 * only ever shorten it and slowing one down is stopped at the last second.
 */
export function setLayerSpeed(layer, speed) {
  const next = Math.max(0.25, Math.min(Number(speed) || 1, 4));
  const previous = Number(layer.speed) || 1;
  const start = Number(layer.start) || 0;
  const span = (Number(layer.end) || 0) - start;
  layer.speed = Number(next.toFixed(2));
  // Never clamped here. A clip that ran to the end of the composition, slowed
  // and then sped back up, used to come back shorter each time — the clamp ate
  // the footage past the end and the next change scaled what was left. The
  // caller grows the composition instead when a slowed clip runs past it.
  if (span > 0) layer.end = Number((start + (span * previous) / next).toFixed(3));
  return layer;
}

/**
 * Where a source of `sw x sh` lands inside `rect`.
 *
 * "cover" crops the source so the box is filled; "contain" shrinks the box to
 * the source's aspect and centres it, which is why this returns a rect as well
 * as a crop — a contained layer's real bounds are not the box you asked for.
 */
export function fitLayer(layer, sourceW, sourceH) {
  if (!sourceW || !sourceH) {
    return { crop: { sx: 0, sy: 0, sw: sourceW || 1, sh: sourceH || 1 }, rect: { x: layer.x, y: layer.y, w: layer.w, h: layer.h } };
  }
  const boxRatio = layer.w / layer.h;
  const srcRatio = sourceW / sourceH;

  if (layer.fit === "contain") {
    let w = layer.w;
    let h = layer.h;
    if (srcRatio > boxRatio) h = Math.round(layer.w / srcRatio);
    else w = Math.round(layer.h * srcRatio);
    return {
      crop: { sx: 0, sy: 0, sw: sourceW, sh: sourceH },
      rect: { x: Math.round(layer.x + (layer.w - w) / 2), y: Math.round(layer.y + (layer.h - h) / 2), w, h },
    };
  }

  let sw = sourceW;
  let sh = sourceH;
  if (srcRatio > boxRatio) sw = Math.round(sourceH * boxRatio);
  else sh = Math.round(sourceW / boxRatio);
  return {
    crop: { sx: Math.round((sourceW - sw) / 2), sy: Math.round((sourceH - sh) / 2), sw, sh },
    rect: { x: layer.x, y: layer.y, w: layer.w, h: layer.h },
  };
}

/**
 * A still from the media library. Centred and "contain", because a photo forced
 * to fill the frame is nearly always cropped through the subject; the box is
 * draggable afterwards for the cases where filling is what you want.
 */
export function imageLayer(item, props = {}) {
  return newLayer({
    type: "image",
    name: item.name || "Image",
    path: item.path,
    src: item.src,
    x: Math.round(COMP_W * 0.056),
    y: Math.round(COMP_H * 0.25),
    w: Math.round(COMP_W * 0.888),
    h: Math.round(COMP_H * 0.5),
    fit: "contain",
    ...props,
  });
}

/**
 * Cut one layer in two at composition time `t`, the way a razor does: the first
 * half keeps its start, the second keeps its end, and for a clip the second
 * half's in-point advances by exactly what the first half consumed, so the
 * frames run on unbroken across the cut.
 *
 * Returns the new second half, or null when `t` is not inside the layer.
 */
export function splitLayerAt(layer, t) {
  const start = Number(layer.start) || 0;
  const end = Number(layer.end) || 0;
  if (!(t > start + 0.05 && t < end - 0.05)) return null;
  const tail = newLayer({ ...layer, id: uid(), start: Number(t.toFixed(3)), end });
  // At 2x the first half consumed twice as much footage as it took time, so
  // the in-point moves by composition time × speed, not by time alone.
  if (layer.type === "video") tail.trim = Number(((Number(layer.trim) || 0) + (t - start) * (Number(layer.speed) || 1)).toFixed(3));
  layer.end = Number(t.toFixed(3));
  return tail;
}

/**
 * A sound with no picture. It carries the same start/end/trim as everything
 * else, so the timeline can move and cut it with the code that already exists
 * and the renderer places it with the same arithmetic — there is no separate
 * notion of "the voiceover" anywhere.
 */
export function audioLayer(item, props = {}) {
  return newLayer({
    type: "audio",
    name: item.name || "Audio",
    path: item.path,
    src: item.src,
    w: 0,
    h: 0,
    volume: 1,
    sourceDuration: item.duration || 0,
    ...props,
  });
}

export function textLayer(text, props = {}) {
  return newLayer({
    type: "text",
    name: text.slice(0, 28) || "Text",
    text,
    style: "outline",
    // Type is sized off the short side, so a caption reads the same however
    // the frame is turned.
    fontSize: Math.round(68 * (Math.min(COMP_W, COMP_H) / 1080)),
    x: Math.round(COMP_W * 0.083),
    y: Math.round(COMP_H * 0.672),
    w: COMP_W - Math.round(COMP_W * 0.166),
    h: Math.round(COMP_H * 0.125),
    fit: "contain",
    ...props,
  });
}

/**
 * Spread caption text layers across a window, weighted by how much each carries.
 * An even split leaves a one-word card up as long as a full sentence.
 */
export function timeTextLayers(layers, from, to) {
  if (!layers.length) return layers;
  const weights = layers.map((l) => Math.max(String(l.text || "").length, 6));
  const sum = weights.reduce((a, b) => a + b, 0);
  const total = Math.max(to - from, 0.5);
  let at = from;
  layers.forEach((layer, i) => {
    const span = (weights[i] / sum) * total;
    layer.start = Number(at.toFixed(3));
    layer.end = Number(Math.min(at + span, to).toFixed(3));
    at += span;
  });
  return layers;
}

export function splitIntoCards(lines, wordsPerCard) {
  const cards = [];
  for (const line of lines) {
    const words = String(line).trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += wordsPerCard) cards.push(words.slice(i, i + wordsPerCard).join(" "));
  }
  return cards;
}
