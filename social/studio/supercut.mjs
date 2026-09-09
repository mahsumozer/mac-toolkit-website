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

// Content words, in order — "the", "a" and friends are in every video ever made
// and searching for them finds nothing in particular.
const FILLER = new Set(["a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "is", "it", "for", "with", "all", "one", "you", "your", "i"]);

/**
 * Phrases from the script worth searching YouTube for.
 *
 * Searching the subject alone gives a pool that happens to contain your words;
 * searching the phrases gives a pool chosen because someone says them, which is
 * what makes the cut flow instead of stutter.
 */
export function searchPhrases(script, { max = 5 } = {}) {
  // Clause by clause. A window that runs across a comma — "timer clipboard
  // history all" — is a phrase nobody has ever said, and searching for it finds
  // nothing while costing a request.
  const clauses = String(script || "")
    .split(/[,.;:!?\n]+/)
    .map((clause) => tokenize(clause).map((token) => token.norm))
    .filter((clause) => clause.length);

  const phrases = [];
  const add = (words) => {
    if (words.length < 2) return;
    if (words.every((word) => FILLER.has(word))) return;
    const phrase = words.join(" ");
    if (phrases.some((existing) => existing.includes(phrase) || phrase.includes(existing))) return;
    phrases.push(phrase);
  };

  for (const clause of clauses) {
    if (clause.length <= 4) {
      add(clause);
      continue;
    }
    // A long clause is searched at both ends: whoever says the opening four
    // words may not say the closing four, and either is worth having whole.
    add(clause.slice(0, 4));
    add(clause.slice(-4));
  }
  return phrases.slice(0, max);
}

/**
 * Does a proposed split actually spell the script?
 *
 * A model asked to break a line into phrases will occasionally drop a word,
 * reorder two, or helpfully correct the spelling. Every one of those makes a
 * video that says something the person did not write, so a split is only used
 * when its words are the script's words, in order.
 */
export function splitCovers(script, chunks) {
  const want = tokenize(script).map((token) => token.norm).join(" ");
  const got = (chunks || []).flatMap((chunk) => tokenize(chunk).map((token) => token.norm)).join(" ");
  return Boolean(want) && want === got;
}

/**
 * The fallback split: clause by clause, then in runs of at most four words.
 *
 * Used when there is no model key, when the model's answer does not spell the
 * script, and as the thing the model is asked to improve on.
 */
export function naiveSplit(script, { max = 4 } = {}) {
  const chunks = [];
  for (const clause of String(script || "").split(/(?<=[,.;:!?])\s+|\n+/)) {
    const words = clause.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += max) chunks.push(words.slice(i, i + max).join(" "));
  }
  return chunks.filter(Boolean);
}

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
export function indexSource(video, words, { onTopic = true } = {}) {
  return {
    video,
    words,
    // Videos dragged in by a phrase search are not about the subject: they are
    // about whoever happened to say those words. Useful, but a Windows tutorial
    // in the middle of a Mac cut is jarring, so they are used when they are
    // clearly better and not merely equal.
    onTopic,
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
 * Not greedy. Taking the longest run at each position is the obvious way and it
 * is wrong: "all in" exists, so a greedy pass takes it and never discovers that
 * one source says "in one menu bar app" whole. So every position is costed and
 * the cheapest path through the whole script wins — a cut costs a fixed amount
 * whatever its length, which is what makes the solver prefer three long clips to
 * six short ones, and a gap costs more than any cut, so it only appears where
 * nobody says the word at all.
 *
 * Returns the segments in script order plus whatever could not be found, so the
 * page can offer to speak the gaps rather than pretending the script was made.
 */
/**
 * A seeded random number generator (mulberry32).
 *
 * Seeded rather than free: two people typing the same line should not get the
 * same video, but one person who liked a take should be able to get it back.
 * The seed travels with the run.
 */
export function rng(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GAP_COST = 2.6;    // a word nobody says: worse than any join
const OFF_TOPIC_AIR = 1.2; // what a clip from outside the subject is worth in dead air
const AIR_COST = 0.25;   // per second of dead air inside a clip

// `cutCost` is the taste dial. At 0.6 the solver will happily take single words
// and the result is the classic stuttering ransom note; at 2.2 it holds out for
// whole phrases and cuts only where it must.
/**
 * Solve one script, chunk by chunk.
 *
 * With chunks, each is solved on its own and no clip may straddle a boundary:
 * "window management, keyboard cleaning mode" asked for as two phrases can never
 * come back as "management, keyboard" from one mouth, which is the kind of join
 * that reads as a mistake. Without chunks the whole line is one chunk, which is
 * what it always used to be.
 */
/**
 * Share the line out between mouths.
 *
 * A cut where one video supplies half the words sounds like a clip of that
 * video, not like a supercut. Where a segment has an alternate from a video
 * carrying less of the line, it is swapped — the words are identical either way,
 * only the face changes.
 */
export function spreadSources(segments) {
  const used = new Map();
  const count = (url) => used.get(url) || 0;
  for (const segment of segments) if (segment.kind === "clip") used.set(segment.url, count(segment.url) + 1);

  for (const segment of segments) {
    if (segment.kind !== "clip" || !segment.alternates || !segment.alternates.length) continue;
    if (count(segment.url) < 2) continue;
    const better = segment.alternates.find((alt) => count(alt.url) + 1 < count(segment.url));
    if (!better) continue;
    used.set(segment.url, count(segment.url) - 1);
    used.set(better.url, count(better.url) + 1);
    // The one it is stepping aside for becomes its own fallback.
    const wasHere = { url: segment.url, title: segment.title, start: segment.start, end: segment.end, span: segment.span };
    Object.assign(segment, { url: better.url, title: better.title, start: better.start, end: better.end, span: better.span });
    segment.alternates = [wasHere, ...segment.alternates.filter((alt) => alt.url !== better.url)].slice(0, 3);
  }
  return segments;
}

export function buildCutInChunks(script, chunks, sources, options = {}) {
  const usable = (chunks || []).filter((chunk) => tokenize(chunk).length);
  if (!usable.length || !splitCovers(script, usable)) return buildCut(tokenize(script), sources, options);

  const all = { segments: [], missing: [] };
  for (const [index, chunk] of usable.entries()) {
    const cut = buildCut(tokenize(chunk), sources, {
      ...options,
      wholeFirst: true,
      // Each phrase draws its own numbers; one seed for all of them would make
      // every chunk lean the same way.
      seed: (Number(options.seed) || 1) + index * 7919,
    });
    all.segments.push(...cut.segments);
    all.missing.push(...cut.missing);
  }
  spreadSources(all.segments);
  const clips = all.segments.filter((segment) => segment.kind === "clip");
  return {
    ...all,
    stats: {
      words: tokenize(script).length,
      found: clips.reduce((sum, clip) => sum + clip.words, 0),
      clips: clips.length,
      sources: new Set(clips.map((clip) => clip.url)).size,
      seconds: Number(clips.reduce((sum, clip) => sum + clip.span, 0).toFixed(2)),
    },
  };
}

export function buildCut(tokens, sources, { maxRun = 8, cutCost = 1, wholeFirst = false, seed = 1, jitter = 0.5 } = {}) {
  const random = rng(seed);
  // Inside a chunk, taking the whole thing in one breath is worth more than the
  // usual preference for fewer cuts: the chunk exists because those words belong
  // together.
  const CUT_COST = Math.max(0.2, Number(cutCost) || 1) * (wholeFirst ? 1.8 : 1);
  const n = tokens.length;

  // Every run that exists anywhere, per starting position. Longer runs are rare,
  // so this stays small even for a long script.
  const options = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let length = Math.min(maxRun, n - i); length >= 1; length--) {
      const run = tokens.slice(i, i + length).map((token) => token.norm);
      const candidates = [];
      for (const source of sources) {
        for (const at of findRun(source, run)) {
          const clip = clipFor(source, at, length);
          if (!clip) continue;
          // Among the same words in different mouths, the tightest reading —
          // with a thumb on the scale for videos that are actually about the
          // subject.
          // The jitter is what stops a line always coming out of the same
          // mouths: among readings that are within a breath of each other, which
          // one wins is decided by the seed rather than by the third decimal
          // place of a duration.
          const air =
            Math.max(0, clip.span - length * 0.42) + (source.onTopic ? 0 : OFF_TOPIC_AIR) + random() * jitter;
          candidates.push({ source, at, length, clip, air });
        }
      }
      if (!candidates.length) continue;
      candidates.sort((a, b) => a.air - b.air);
      const best = candidates[0];
      // Every other mouth that says the same words, kept in case the first one
      // will not download: YouTube asks a good share of them to prove they are
      // not a robot.
      best.alternates = candidates
        .slice(1)
        .filter((other) => other.source.video.url !== best.source.video.url)
        .slice(0, 3)
        .map((other) => ({
          url: other.source.video.url,
          title: other.source.video.title,
          start: other.clip.start,
          end: other.clip.end,
          span: other.clip.span,
        }));
      options[i].push(best);
    }
  }

  // Cheapest path from each position to the end, solved backwards.
  const best = new Array(n + 1).fill(null);
  best[n] = { cost: 0, next: null, take: null };
  for (let i = n - 1; i >= 0; i--) {
    let choice = { cost: GAP_COST + best[i + 1].cost, at: i + 1, take: null };
    for (const option of options[i]) {
      const cost = CUT_COST + option.air * AIR_COST + best[i + option.length].cost;
      if (cost < choice.cost) choice = { cost, at: i + option.length, take: option };
    }
    best[i] = { cost: choice.cost, next: choice.at, take: choice.take };
  }

  const segments = [];
  const missing = [];
  for (let i = 0; i < n; ) {
    const step = best[i];
    if (!step.take) {
      missing.push(tokens[i].raw);
      segments.push({ kind: "gap", text: tokens[i].raw });
      i = step.next;
      continue;
    }
    const { source, clip, length, alternates } = step.take;
    segments.push({
      kind: "clip",
      // The runners-up travel with the choice: a download can fail, and a second
      // mouth saying the same words beats a hole in the script.
      alternates: alternates || [],
      text: tokens
        .slice(i, i + length)
        .map((token) => token.raw)
        .join(" "),
      words: length,
      url: source.video.url,
      title: source.video.title,
      channel: source.video.channel || "",
      start: clip.start,
      end: clip.end,
      span: clip.span,
    });
    i = step.next;
  }

  spreadSources(segments);

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
