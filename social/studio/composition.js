// The composition: one description of a video that both the canvas editor and
// the ffmpeg render read.
//
// The rule that keeps the preview honest is that every layer carries an
// explicit source crop *and* an explicit destination rect, both in real pixels.
// Canvas draws it as `drawImage(src, sx,sy,sw,sh, x,y,w,h)`; ffmpeg draws it as
// `crop=sw:sh:sx:sy,scale=w:h` then `overlay=x:y`. Neither side re-derives the
// geometry, so neither can disagree with the other.

export const COMP_W = 1080;
export const COMP_H = 1920;

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
    start: 0,
    end: 0,
    trim: 0,
    volume: 0,
    visible: true,
    ...props,
  };
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
 * to fill a 9:16 frame is nearly always cropped through the subject; the box is
 * draggable afterwards for the cases where filling is what you want.
 */
export function imageLayer(item, props = {}) {
  return newLayer({
    type: "image",
    name: item.name || "Image",
    path: item.path,
    src: item.src,
    x: 60,
    y: 480,
    w: COMP_W - 120,
    h: 960,
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
  if (layer.type === "video") tail.trim = Number(((Number(layer.trim) || 0) + (t - start)).toFixed(3));
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
    fontSize: 68,
    x: 90,
    y: 1290,
    w: COMP_W - 180,
    h: 240,
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
