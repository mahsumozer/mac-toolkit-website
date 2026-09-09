// Freezing a canvas into something ffmpeg can rebuild.
//
// Every clip carries the crop and rect the editor drew; every text layer becomes
// the exact PNG it painted. Nothing downstream re-derives geometry, so the file
// cannot disagree with the preview — which is also why this lives in one place
// rather than once per page: a second description of a composition is a second
// way for the two to drift.

import { fitLayer, COMP_W, COMP_H } from "./composition.js";
import { textLayerToPng } from "./render-image.js";

export async function freezeComposition(editor) {
  // Nothing can be frozen before its size is known; wait for the media first.
  await editor.whenReady();
  const layers = [];
  const missing = [];
  for (const layer of editor.layers) {
    if (!layer.visible) continue;
    if (layer.type === "text") {
      layers.push({
        type: "text",
        start: layer.start,
        end: layer.end,
        opacity: layer.opacity ?? 1,
        fadeIn: Number(layer.fadeIn) || 0,
        fadeOut: Number(layer.fadeOut) || 0,
        png: await textLayerToPng(layer, COMP_W, COMP_H),
      });
      continue;
    }
    // Sound has no geometry to freeze, only a window and a level.
    if (layer.type === "audio") {
      layers.push({ type: "audio", path: layer.path, start: layer.start, end: layer.end, trim: layer.trim || 0, volume: layer.volume ?? 1, speed: Number(layer.speed) || 1, fadeIn: Number(layer.fadeIn) || 0, fadeOut: Number(layer.fadeOut) || 0 });
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
      // The rest of the treatment, each with its twin in the render's filter
      // chain. A still has no speed; it is always 1 here so the server never
      // has to ask what kind of layer it is looking at.
      speed: layer.type === "video" ? Number(layer.speed) || 1 : 1,
      rotate: Number(layer.rotate) || 0,
      flipH: Boolean(layer.flipH),
      flipV: Boolean(layer.flipV),
      fadeIn: Number(layer.fadeIn) || 0,
      fadeOut: Number(layer.fadeOut) || 0,
      brightness: Number(layer.brightness ?? 1),
      contrast: Number(layer.contrast ?? 1),
      saturation: Number(layer.saturation ?? 1),
      hue: Number(layer.hue) || 0,
    });
  }
  return { layers, missing };
}
