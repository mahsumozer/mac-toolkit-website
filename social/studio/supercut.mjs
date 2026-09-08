// A script, cut out of other people's videos.
//
// You give it a sentence and a pile of transcripts; it finds where those words
// are actually spoken and hands back the timecodes. The words come back in your
// order, spoken by whoever happened to say them — the supercut that has been
// made by hand since people started grepping subtitles.
//
// Matching is greedy and longest-first: "menu bar app" taken whole from one
// video sounds like a sentence, while three single words from three videos
// sounds like a ransom note. Only when no run of two or more exists anywhere
// does it fall back to a lone word, and a word nobody says is reported rather
// than quietly dropped.

const STRIP = /[^\p{Letter}\p{Number}']/gu;

export const normalise = (word) =>
  String(word || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(STRIP, "");

/** The script as units to find, keeping the original spelling for the caption. */
export function tokenize(script) {
  return String(script || "")
    .split(/\s+/)
    .map((raw) => ({ raw, norm: normalise(raw) }))
    .filter((token) => token.norm);
}

/**
 * One searchable source.
 *
 * `words` are what transcript.mjs returns: text with a start and an end. The
 * normalised array is built once because the matcher walks it for every token.
 */
export function indexSource(video, words) {
  return {
    video,
    words,
    norm: words.map((word) => normalise(word.text)),
  };
}

// Every place `run` appears in this source, as an index into its words.
function findRun(source, run) {
  const hits = [];
  const first = run[0];
  for (let i = 0; i < source.norm.length; i++) {
    if (source.norm[i] !== first) continue;
    let ok = true;
    for (let k = 1; k < run.length; k++) {
      if (source.norm[i + k] !== run[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

// A clip is better when it is tight: the words spoken quickly and without a
// pause dropped in the middle. Long gaps mean the speaker paused, or the
// captions drifted, and the cut will sound wrong.
function clipFor(source, at, length, { pad = 0.08 } = {}) {
  const first = source.words[at];
  const last = source.words[at + length - 1];
  if (!first || !last) return null;
  const start = Math.max(0, first.t - pad);
  const end = Math.max(start + 0.25, (last.end || last.t + 0.5) + pad);
  const span = end - start;
  // Two seconds a word is a pause, not speech.
  if (span > length * 2 + 1.5) return null;
  return { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), span: Number(span.toFixed(2)) };
}

/**
 * Build the cut.
 *
 * Returns the segments in script order plus whatever could not be found, so the
 * page can offer to speak the gaps rather than pretending the script was made.
 */
export function buildCut(tokens, sources, { maxRun = 6 } = {}) {
  const segments = [];
  const missing = [];
  let i = 0;

  while (i < tokens.length) {
    let best = null;
    // Longest first: a whole phrase from one mouth beats three stitched words.
    for (let length = Math.min(maxRun, tokens.length - i); length >= 1 && !best; length--) {
      const run = tokens.slice(i, i + length).map((token) => token.norm);
      const candidates = [];
      for (const source of sources) {
        for (const at of findRun(source, run)) {
          const clip = clipFor(source, at, length);
          if (clip) candidates.push({ source, at, length, clip });
        }
      }
      if (!candidates.length) continue;
      // Among equally long runs, the tightest one: the least dead air.
      candidates.sort((a, b) => a.clip.span / a.length - b.clip.span / b.length);
      best = candidates[0];
    }

    if (!best) {
      missing.push(tokens[i].raw);
      // A word nobody says still belongs to the script, so it is kept in order
      // as a gap the page can fill with type or a spoken line.
      segments.push({ kind: "gap", text: tokens[i].raw });
      i += 1;
      continue;
    }

    segments.push({
      kind: "clip",
      text: tokens
        .slice(i, i + best.length)
        .map((token) => token.raw)
        .join(" "),
      words: best.length,
      url: best.source.video.url,
      title: best.source.video.title,
      channel: best.source.video.channel || "",
      start: best.clip.start,
      end: best.clip.end,
      span: best.clip.span,
    });
    i += best.length;
  }

  // Neighbouring gaps read as one missing phrase rather than as loose words.
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (segment.kind === "gap" && last && last.kind === "gap") {
      last.text = `${last.text} ${segment.text}`;
      continue;
    }
    merged.push({ ...segment });
  }

  const clips = merged.filter((segment) => segment.kind === "clip");
  return {
    segments: merged,
    missing,
    stats: {
      words: tokens.length,
      found: clips.reduce((sum, clip) => sum + clip.words, 0),
      clips: clips.length,
      sources: new Set(clips.map((clip) => clip.url)).size,
      seconds: Number(clips.reduce((sum, clip) => sum + clip.span, 0).toFixed(2)),
    },
  };
}
