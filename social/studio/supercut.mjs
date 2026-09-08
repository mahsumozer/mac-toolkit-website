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
const GAP_COST = 2.6;    // a word nobody says: worse than any join
const OFF_TOPIC_AIR = 1.2; // what a clip from outside the subject is worth in dead air
const AIR_COST = 0.25;   // per second of dead air inside a clip

// `cutCost` is the taste dial. At 0.6 the solver will happily take single words
// and the result is the classic stuttering ransom note; at 2.2 it holds out for
// whole phrases and cuts only where it must.
export function buildCut(tokens, sources, { maxRun = 8, cutCost = 1 } = {}) {
  const CUT_COST = Math.max(0.2, Number(cutCost) || 1);
  const n = tokens.length;

  // Every run that exists anywhere, per starting position. Longer runs are rare,
  // so this stays small even for a long script.
  const options = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let length = Math.min(maxRun, n - i); length >= 1; length--) {
      const run = tokens.slice(i, i + length).map((token) => token.norm);
      let best = null;
      for (const source of sources) {
        for (const at of findRun(source, run)) {
          const clip = clipFor(source, at, length);
          if (!clip) continue;
          // Among the same words in different mouths, the tightest reading —
          // with a thumb on the scale for videos that are actually about the
          // subject.
          const air = Math.max(0, clip.span - length * 0.42) + (source.onTopic ? 0 : OFF_TOPIC_AIR);
          if (!best || air < best.air) best = { source, at, length, clip, air };
        }
      }
      if (best) options[i].push(best);
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
    const { source, clip, length } = step.take;
    segments.push({
      kind: "clip",
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
