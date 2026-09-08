// Freezing a canvas into something ffmpeg can rebuild.
//
// Every clip carries the crop and rect the editor drew; every text layer becomes
// the exact PNG it painted. Nothing downstream re-derives geometry, so the file
// cannot disagree with the preview — which is also why this lives in one place
// rather than once per page: a second description of a composition is a second
// way for the two to drift.

import { fitLayer } from "./composition.js";
import { textLayerToPng } from "./render-image.js";

export async function freezeComposition(editor) {
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
      layers.push({ type: "audio", path: layer.path, start: layer.start, end: layer.end, trim: layer.trim || 0, volume: layer.volume ?? 1 });
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
