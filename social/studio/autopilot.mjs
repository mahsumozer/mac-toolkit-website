// Autopilot — one URL in, a finished campaign out.
//
// AI mode (studio/agent.mjs) asks six questions and builds one post. This is the
// other end of the same idea: nothing is asked, the brief is *read* off the
// product's own site, and the model is left to decide what is worth making.
//
// Four passes, and each exists because the one before it is not enough on its
// own:
//
//   recon     fetch the page and a few of its own links, strip it to text.
//   brand     turn that text into a fact sheet — features, price, proofs.
//             Every later claim has to come from here, so a post can never
//             invent a feature the site does not describe.
//   direct    a creative director turns the fact sheet into N distinct
//             concepts: angle, hook, script, visual direction.
//   critique  a second read scores each hook and rewrites the weak ones. A
//             first draft hook is almost never the best one, and the model is
//             a far better editor of its own work than author of it.
//
// Then one producer agent per concept: it searches, downloads and speaks, and
// hands back a plan. Nothing here composes anything — the plan is executed in
// the browser, because the canvas is the only place the preview and the render
// are guaranteed to agree. Same split as AI mode, same reason.

import { runAgent } from "./agent.mjs";

const MAX_PAGES = 5;
const MAX_CHARS = 22000;

/* -------------------------------------------------------------- extraction */

const BLOCK_TAGS = /<\/(p|div|section|article|li|h[1-6]|tr|td|br)>/gi;

// A page reduced to the text a human would read out of it. Not a parser — a
// parser here would mean a dependency, and the model only needs the words.
export function extractPage(html, pageUrl) {
  const raw = String(html || "");
  const body = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");

  const meta = (name) => {
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, "i"),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(raw);
      if (match) return decode(match[1]);
    }
    return "";
  };

  // The site's own pictures are the only product footage that exists for a
  // product this tool has never seen: there is no screen recording of someone
  // else's app on this disk, and there never will be.
  const images = [];
  const pushImage = (raw) => {
    if (!raw || /^data:/i.test(raw)) return;
    let href;
    try {
      href = new URL(raw.trim().split(/\s+/)[0], pageUrl).toString();
    } catch {
      return;
    }
    // Vector marks and icons are chrome, not product shots, and ffmpeg cannot
    // read an SVG at all.
    if (/\.(svg|ico)(\?|$)/i.test(href)) return;
    if (/favicon|sprite|logo-|apple-touch|avatar|badge|1x1|pixel\.gif/i.test(href)) return;
    if (!images.includes(href)) images.push(href);
  };
  pushImage(meta("og:image"));
  pushImage(meta("twitter:image"));
  const imgPattern = /<img\b[^>]*>/gi;
  for (let m; (m = imgPattern.exec(body)); ) {
    const tag = m[0];
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag);
    const srcset = /\bsrcset=["']([^"']+)["']/i.exec(tag);
    // The last srcset candidate is the widest, which is the one worth having.
    if (srcset) pushImage(srcset[1].split(",").pop());
    else if (src) pushImage(src[1]);
    if (images.length > 40) break;
  }

  const links = [];
  const linkPattern = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (let m; (m = linkPattern.exec(body)); ) {
    let href;
    try {
      href = new URL(m[1], pageUrl).toString();
    } catch {
      continue;
    }
    links.push({ href, text: decode(m[2].replace(/<[^>]*>/g, " ")).slice(0, 80) });
    if (links.length > 300) break;
  }

  const text = decode(
    body
      .replace(BLOCK_TAGS, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/[ \t\r\f\v]+/g, " "),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 1)
    // A nav repeated on every page is noise the second time it appears, and the
    // budget is words the model has to read.
    .filter((line, i, all) => all.indexOf(line) === i)
    .join("\n");

  return {
    url: pageUrl,
    title: decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [, ""])[1]).trim(),
    description: meta("description") || meta("og:description"),
    image: meta("og:image") || meta("twitter:image"),
    siteName: meta("og:site_name"),
    links,
    images,
    text,
  };
}

function decode(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// Which of the site's own links are worth a second fetch. Pricing and features
// are where the facts live; a blog index is a hundred headlines about nothing
// in particular.
const WORTH_READING = /(feature|pricing|price|product|tour|how-it-works|why|download|about|use-?case|docs?)\b/i;

export function pickFollowUps(links, pageUrl, limit = MAX_PAGES - 1) {
  const origin = new URL(pageUrl).origin;
  const seen = new Set([stripHash(pageUrl)]);
  const picked = [];
  for (const link of links) {
    const href = stripHash(link.href);
    if (seen.has(href)) continue;
    if (!href.startsWith(origin)) continue;
    if (/\.(png|jpe?g|webp|gif|svg|pdf|zip|dmg|mp4|xml|txt|ico)$/i.test(href)) continue;
    if (!WORTH_READING.test(href) && !WORTH_READING.test(link.text)) continue;
    seen.add(href);
    picked.push(href);
    if (picked.length >= limit) break;
  }
  return picked;
}

const stripHash = (href) => href.split("#")[0].replace(/\/$/, "") || href;

/* ------------------------------------------------------------------ prompts */

const BRAND_SYSTEM = `You read a product's own website and write down what is verifiably true about it, as json.

Rules:
- Only write down what the page actually says. If the price is not on the page, say so rather than guessing.
- Features are what the product does, one short sentence each, in the product's own words trimmed down. No marketing adjectives.
- "avoid" is for claims the page does NOT support, which later copy must never make.
- Return only a json object.`;

function brandPrompt(pages) {
  const shape = {
    name: "Mac Kit",
    url: "https://usemackit.com/",
    category: "macOS menu bar utility",
    oneLiner: "Fourteen everyday Mac tools in one menu bar app",
    priceLine: "7-day trial, then $9.99 once",
    audience: ["Mac users who have collected a folder of single-purpose utilities"],
    features: ["Clipboard history you can search and paste back", "Screenshot capture with an editor before you share"],
    proofs: ["runs locally, nothing is uploaded", "no subscription"],
    tone: "plain, first person, no hype",
    keywords: ["macos", "menu bar", "productivity"],
    avoid: ["do not claim an iOS app", "do not claim team features"],
  };
  return [
    `Here is a product website, page by page. Write the fact sheet as json in exactly this shape:`,
    JSON.stringify(shape, null, 2),
    ``,
    ...pages.map((page, i) => [`--- page ${i + 1}: ${page.url}`, page.title, page.description, page.text].filter(Boolean).join("\n")),
  ]
    .join("\n\n")
    .slice(0, MAX_CHARS);
}

const DIRECTOR_SYSTEM = `You are the creative director for a short-form social account. You are given a product fact sheet and you decide what is worth making this week, as json.

How to think:
- Each concept is a different *angle*, not the same post twice. A demo, an annoyance, a comparison, a confession, a number, a before and after — pick angles that sit apart from each other.
- The hook is the whole thing. It is the first line on screen, under seven words, and it has to work for someone who has never heard of this product. No "introducing", no "check out", no question that answers itself.
- Video scripts: short lines, one idea each, read in under two seconds. Say what the product does, never what it "empowers" you to do.
- Say what the post looks like in "picture", in one sentence, and make the concepts look different from each other: a photograph with a sticker over it, a screenshot on a moving backdrop, a gif filling the frame, a corner reaction. Not the same arrangement twice.
- You are shown what is moving in this niche right now. Borrow the *shape* of one — its hook pattern, its format, how many beats it runs — and put the product's own truth inside it. Never borrow a claim, a number or a sentence: those come from the fact sheet and nowhere else. When a concept is built on one, put its address in "remixUrl" and say what you took in "remixNote"; the producer will cut its bed from that video. At least one concept should do this when anything is listed, and none should if nothing is.
- Carousels: the first card is the hook, the rest carry one point each, the last one says what to do next.
- Every claim comes from the fact sheet. Nothing else exists.
- Footage queries are two to four plain words that a stock or YouTube search will match — "laptop desk", "minecraft parkour". Never a product name, never an adjective.
- Nothing exists on this machine. Every frame of this post is downloaded during the run: the background from YouTube, the product shots from the product's own site, stock photos for a carousel. Do not plan around footage you imagine is lying around.
- No hype words, no exclamation marks, no emoji.
- Return only a json object.`;

function directorPrompt({ brand, count, mix, images, trends }) {
  const shape = {
    concepts: [
      {
        id: "clipboard-loss",
        kind: "video",
        angle: "the annoyance everyone has had",
        hook: "You copied over the hex code again",
        promise: "shows the clipboard history finding it back",
        lines: ["I copy a colour, then copy something else.", "The first one is gone.", "Clipboard history keeps the last hundred, searchable."],
        footageQuery: "satisfying soap cutting",
        stickerQuery: "annoyed",
        remixUrl: "https://www.youtube.com/watch?v=xxxxxxxxxxx",
        remixNote: "borrowed the '{n} things I stopped doing' skeleton and its four-beat pace",
        wantsVoiceover: true,
        picture: "the app's own screenshot standing on the lower half, the clip filling the frame behind it, a sticker landing on the last line",
        duration: 18,
        caption: "You copied over the hex code again\n\nMac Kit — $9.99 once",
        hashtags: ["macos", "macapps", "productivity"],
      },
      {
        id: "one-icon",
        kind: "image",
        angle: "the count",
        hook: "Fourteen menu bar icons became one",
        promise: "one card per tool it replaced",
        slides: [
          { headline: "Fourteen menu bar icons became one", body: "I was paying for four of these separately." },
          { headline: "1. Clipboard history", body: "The last hundred things you copied, searchable." },
        ],
        scene: "laptop desk",
        size: "4:5",
        caption: "Fourteen menu bar icons became one\n\nMac Kit — $9.99 once",
        hashtags: ["macos", "macapps", "productivity"],
      },
    ],
  };
  return [
    `Fact sheet:`,
    JSON.stringify(brand, null, 2),
    ``,
    `Pictures on the product's own site — the only product footage there is:`,
    (images || []).slice(0, 20).map((url) => `- ${url}`).join("\n") || "- none found on the page",
    ``,
    `Moving in this niche right now, fastest first (views per day, not raw views — a video that took three years to reach a million is not a trend):`,
    (trends || [])
      .slice(0, 14)
      .map(
        (item) =>
          `- ${item.velocity.toLocaleString()}/day · ${item.shape?.format || "no set format"}${item.shape?.beats ? ` (${item.shape.beats} beats)` : ""} · "${item.shape?.hook || item.title}"${item.isShort ? " · short" : ""} · ${item.url}`,
      )
      .join("\n") || "- nothing harvested for this niche",
    ``,
    `Give me ${count} concepts, ${mix}. Return json in exactly this shape:`,
    JSON.stringify(shape, null, 2),
  ].join("\n\n");
}

const CRITIC_SYSTEM = `You are the editor. You are given concepts a director just wrote and you improve them, as json.

Judge each hook on three things only:
- Stops a thumb: does it name something specific that happened to a real person, in the first four words?
- Honest: is every word of it supported by the fact sheet?
- Fresh: would this line already be on ten other accounts? "Game changer", "you need this", "POV: you..." — all dead.

Score each concept 1-10. Anything under 8 you rewrite: a sharper hook, tighter lines, and cut any line that repeats the one before it. Keep the concept's angle, the format and its media direction — you are editing the words, not commissioning a different post. Then return every concept, improved, in the same shape you were given, each with "score" (before your edit) and "editNote" (one clause on what you changed, or "kept").

Return only a json object with a "concepts" array.`;

function criticPrompt({ brand, concepts }) {
  return [
    `Fact sheet:`,
    JSON.stringify(brand, null, 2),
    ``,
    `Concepts to edit, as json:`,
    JSON.stringify({ concepts }, null, 2),
  ].join("\n\n");
}

export const PRODUCER_SYSTEM = `You are the producer. One concept has been handed to you and you gather what it needs by calling tools, then call finish with a plan someone else can execute.

How to work:
- Call tools. Never narrate, never ask a question — the concept is the brief and it is settled.
- Everything this post is made of has to be fetched during this run: the background clip from YouTube, the product shots from the product's own site, a sticker from Giphy, photos from stock. There is nothing on this machine you may reach for, and nothing left over from an earlier post is yours to use.
- Show the product. If the site ships real screenshots, download_site_image takes one; if its pictures are logos and icons — which is what the list usually is — photograph the page itself with screenshot_site. One or two is plenty.
- Build the picture yourself, layer by layer. A post is not obliged to be one clip above another: a stock photograph filling the frame with a sticker bouncing over it, a screenshot standing on a colour field, a gif as the entire background with the product floating in a corner, a slow drone shot with a phone-shaped screenshot in the middle — all of these are one call to finish with different layers in it. Pick the arrangement the line deserves, and do not make the same shape twice in one campaign.
- Layers are drawn in the order you list them: first is furthest back. Every layer needs a source you downloaded in this run.
- Timing is yours too. A sticker that appears on the punchline and leaves is better than one that sits there for sixteen seconds; a second clip can cut in halfway.
- Search queries are two to four plain words. Never a product name, a feature name or an adjective: stock and YouTube match every word, so "clean mode laptop desk" returns nothing at all.
- Download one background clip. One is enough; a second is a minute of someone's life for nothing.
- If the concept carries a remixUrl, that is the video whose shape it borrows: download a slice of it with download_footage and use it as the bed, rather than searching for something else. Only the pictures are borrowed — every word still comes from the fact sheet.
- For a carousel, check the scene with search_photos before you commit to it. Two plain words. If it returns nothing, try one other scene, then use whatever did return.
- The script is already written for you. Tighten it if a line does not survive being read aloud, but do not rewrite the concept.
- Every claim must come from the fact sheet. If the concept asks for something the product does not do, build the closest true thing and say so in your note.
- Then call finish once, with everything.

Tone: someone who uses the product, talking to someone who does not. No hype, no exclamation marks, no emoji.`;

export function producerTools({ hasGiphy }) {
  const tools = [
    {
      type: "function",
      function: {
        name: "screenshot_site",
        description:
          "Photograph a page on the product's own site as it renders right now. This is how you get a picture of the product when the site draws its screenshots in HTML rather than shipping them as image files — which is most good landing pages. Use one of the page addresses listed in your brief: those are the ones that were actually read and exist. Do not invent a path like /compare or /features; a guess that misses is a photograph of a 404 page. A wide window (1440x900) reads as a desktop, a tall narrow one (900x1400) as a phone.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "A page on the product's site." },
            width: { type: "number" },
            height: { type: "number" },
            scrollY: { type: "number", description: "Optional. Scroll this many pixels first, to photograph a section further down the page rather than the top of it." },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "download_site_image",
        description:
          "Download one picture from the product's own site — a screenshot, a hero shot, a product photo. The URLs are in your brief. Returns a local path and the image's real size, so you can tell a wide hero from a tall screenshot.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "One of the image URLs from the brief." },
            name: { type: "string", description: "A short name for the file, e.g. 'panel-screenshot'." },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_footage",
        description: "Search YouTube for a background clip, ranked by view count. Two to four plain words.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, sort: { type: "string", enum: ["views", "relevance"] } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "download_footage",
        description: "Download one search result into the library. Take a slice, not the whole upload. Returns the local path.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            section: {
              type: "string",
              description:
                "HH:MM:SS-HH:MM:SS. Start at least two minutes in — a minute is often still inside a title card, and an upload's own burnt-in text ends up in the post. 40 seconds or less.",
            },
          },
          required: ["url", "title", "section"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_photos",
        description:
          "Search stock photography. Two plain words naming an ordinary place or thing. Use it to check a carousel's scene before committing to it, and to find a still to build a video on. Returns ids you can hand to download_photo.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    },
    {
      type: "function",
      function: {
        name: "download_photo",
        description:
          "Save one photo from the last search into the library, full size. This is how a video gets a photograph behind it instead of a clip. Returns the local path and its real size.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "The id from search_photos." } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "make_voiceover",
        description: "Speak the script and add it to the library. Returns the local path and its real duration in seconds.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The whole read as one string, sentences separated by full stops." },
            voice: { type: "string", description: "A voice id from the brief, or empty for the default." },
            style: {
              type: "string",
              description:
                "Optional direction for the read, in plain language: 'Say this dryly, like you are describing a bug you fixed' or 'Read this quickly and flatly'. It is direction, not something that gets spoken.",
            },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "Hand back the finished plan. Call this exactly once, at the end.",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["video", "image"] },
            duration: { type: "number", description: "video only, seconds. Match the voiceover if there is one." },
            layers: {
              type: "array",
              description:
                "video only. The picture, back to front: the first entry is furthest back. Every source must be a local path a tool returned during this run. Two or three layers is usual; one full-frame layer is a perfectly good post.",
              items: {
                type: "object",
                properties: {
                  source: { type: "string", description: "Local path returned by download_footage, download_photo, download_gif, download_site_image or screenshot_site." },
                  region: {
                    type: "string",
                    enum: [
                      "full",
                      "top",
                      "bottom",
                      "top-third",
                      "bottom-third",
                      "middle",
                      "centre",
                      "phone",
                      "card",
                      "corner-top-left",
                      "corner-top-right",
                      "corner-bottom-left",
                      "corner-bottom-right",
                      "sticker-top",
                      "sticker-middle",
                      "sticker-bottom",
                    ],
                    description:
                      "Where it sits in the 1080x1920 frame. full fills it; top and bottom are halves; phone is a tall panel for a screenshot; card is a floating window; the corners and stickers are small boxes for a reaction or a cut-out.",
                  },
                  fit: {
                    type: "string",
                    enum: ["cover", "contain"],
                    description: "cover crops to fill the region, contain shows all of it. A photo or clip behind everything wants cover; a screenshot or a sticker wants contain.",
                  },
                  start: { type: "number", description: "Seconds. Leave out for the whole post." },
                  end: { type: "number", description: "Seconds. Leave out for the whole post." },
                  blur: { type: "number", description: "0-60. Blur a backdrop so what is over it reads." },
                  opacity: { type: "number", description: "0-1." },
                  volume: { type: "number", description: "0-1, clips only. Leave out and it is chosen for you: quiet under a voiceover, present without one." },
                },
                required: ["source", "region"],
              },
            },
            voicePath: { type: "string", description: "video only, optional. Local path returned by make_voiceover." },
            hook: { type: "string", description: "The first line on screen. Under seven words." },
            lines: { type: "array", items: { type: "string" }, description: "video only. Caption lines in order, one idea each." },
            captionStyle: {
              type: "string",
              enum: ["sticker-white", "sticker-black", "sticker-accent", "outline"],
              description: "How the type is set. Outline reads best over busy footage.",
            },
            slides: {
              type: "array",
              description: "image only. One entry per card, hook card first.",
              items: {
                type: "object",
                properties: { headline: { type: "string" }, body: { type: "string" } },
                required: ["headline", "body"],
              },
            },
            scene: { type: "string", description: "image only. Two plain words naming the one place the whole carousel is photographed in." },
            size: { type: "string", enum: ["4:5", "9:16", "1:1"], description: "image only. Canvas shape." },
            caption: { type: "string", description: "The post caption." },
            hashtags: { type: "array", items: { type: "string" }, maxItems: 6 },
            note: { type: "string", description: "One sentence on what you chose and why." },
          },
          required: ["kind", "hook", "caption", "hashtags", "note"],
        },
      },
    },
  ];

  if (hasGiphy) {
    tools.splice(4, 0, {
      type: "function",
      function: {
        name: "search_gif",
        description: "Search Giphy. Stickers are cut out and belong over video; gifs bring their own rectangle.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, kind: { type: "string", enum: ["stickers", "gifs"] } },
          required: ["query"],
        },
      },
    });
    tools.splice(5, 0, {
      type: "function",
      function: {
        name: "download_gif",
        description: "Save one search result into the library. Returns the local path.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    });
  }

  return tools;
}

export function producerBrief({ brand, concept, voices, images, pages, index, total, voiceover = true }) {
  const lines = [
    `Fact sheet (the only claims that exist):`,
    JSON.stringify(brand, null, 2),
    ``,
    `Concept ${index + 1} of ${total}, already approved by the editor:`,
    JSON.stringify(concept, null, 2),
    ``,
    `Pages that exist — screenshot_site takes one of these and nothing else:`,
    ...((pages && pages.length ? pages : [brand.url]).map((page) => `- ${page}`)),
    ``,
    `Pictures on the product's site, for download_site_image:`,
    ...(images && images.length ? images.slice(0, 20).map((url) => `- ${url}`) : ["- none were found on the page"]),
    ``,
  ];
  if (voiceover && voices && voices.length) {
    // Each voice's character, not only its id: "Charon" says nothing about how
    // it sounds, and the choice of voice is part of the post.
    lines.push(
      `Voices for make_voiceover — the character is what to choose on:`,
      ...voices.slice(0, 14).map((voice) => (typeof voice === "string" ? `- ${voice}` : `- ${voice.label} → pass "${voice.id}"`)),
      ``,
    );
  }
  // Off means off. Without this the producer speaks the script anyway, because
  // a voiceover is the obvious thing to reach for and nothing said not to.
  if (!voiceover) lines.push(`Do not call make_voiceover. This post is silent and carried by its captions.`, ``);
  lines.push(`Gather what it needs, then finish.`);
  return lines.join("\n");
}

/* ----------------------------------------------------------------- pipeline */

const trim = (value, max) => (typeof value === "string" && value.length > max ? value.slice(0, max) : value);

/**
 * The whole run.
 *
 * `fetchPage(url)` returns HTML. `json(system, prompt)` returns a parsed object
 * from whichever provider is configured. `agentCall(messages, tools)` is one
 * tool-calling completion. `toolImpls` are the producer's hands. `onEvent` gets
 * chat-shaped progress, so the page can show the run rather than a spinner.
 */
export async function runAutopilot({ url, count = 3, mix, voices, voiceover = true, fetchPage, json, agentCall, toolImpls, hasGiphy, trends, onEvent, onPhase }) {
  const say = (text, extra = {}) => onEvent({ role: "assistant", text, ...extra });
  const log = (text, extra = {}) => onEvent({ role: "tool-result", tool: extra.tool || "autopilot", text, ...extra });

  /* recon */
  onPhase("Reading the site");
  const first = extractPage(await fetchPage(url), url);
  const pages = [first];
  for (const href of pickFollowUps(first.links, url)) {
    try {
      pages.push(extractPage(await fetchPage(href), href));
      log(`read ${new URL(href).pathname || "/"}`);
    } catch (error) {
      log(`could not read ${href}: ${error.message}`, { role: "tool-error", tool: "read" });
    }
  }
  const images = [];
  for (const page of pages) for (const image of page.images || []) if (!images.includes(image)) images.push(image);
  // Only the addresses that answered. The producer photographs one of these
  // rather than guessing a path, because a guessed path that 404s is a
  // screenshot of Chrome's error screen sitting in a finished post.
  const pageUrls = pages.map((page) => page.url);
  log(`${pages.length} page${pages.length === 1 ? "" : "s"} read from ${new URL(url).hostname}, ${images.length} pictures found on them`);

  /* brand */
  onPhase("Working out what this product is");
  const brand = await json(BRAND_SYSTEM, brandPrompt(pages));
  brand.url = brand.url || url;
  brand.name = brand.name || first.siteName || first.title || new URL(url).hostname;
  if (!Array.isArray(brand.features) || !brand.features.length) {
    throw new Error(`Nothing readable at ${url} — the page may render its text with JavaScript, which this cannot see.`);
  }
  say(`${brand.name}: ${brand.oneLiner || brand.category || ""}`.trim(), { kind: "brand", brand });
  log(`${brand.features.length} features taken off the site${brand.priceLine ? `, ${brand.priceLine}` : ""}`);

  /* trends */
  // Queries come from the fact sheet, not from a fixed list: what is moving in
  // one niche says nothing about another, and this page is pointed at whatever
  // product someone pastes.
  let moving = [];
  if (trends) {
    onPhase("Seeing what is moving");
    const queries = [
      ...(brand.keywords || []).slice(0, 3),
      ...(brand.category ? [brand.category] : []),
      ...(brand.audience || []).slice(0, 1).map((line) => String(line).split(/[,.]/)[0]),
    ]
      .map((query) => String(query || "").trim())
      .filter((query) => query.length > 2 && query.split(/\s+/).length <= 5);
    try {
      moving = await trends([...new Set(queries)]);
      log(
        moving.length
          ? `${moving.length} trending records, fastest ${moving[0].velocity.toLocaleString()} views/day: "${moving[0].title}"`
          : "nothing trending found for this niche — the concepts will not borrow a shape",
      );
    } catch (error) {
      log(`could not read the trends (${error.message}) — carrying on without them`, { role: "tool-error", tool: "trends" });
    }
  }

  /* direct */
  onPhase("Deciding what is worth making");
  const directed = await json(
    DIRECTOR_SYSTEM,
    directorPrompt({ brand, count, mix: mix || `a mix of video and carousel, at least one of each if ${count} is more than one`, images, trends: moving }),
  );
  let concepts = (directed.concepts || []).slice(0, count);
  if (!concepts.length) throw new Error("The director came back with no concepts");
  log(`${concepts.length} concepts: ${concepts.map((c) => c.angle || c.id).join(", ")}`);

  /* critique */
  onPhase("Editing the hooks");
  try {
    const edited = await json(CRITIC_SYSTEM, criticPrompt({ brand, concepts }));
    if (Array.isArray(edited.concepts) && edited.concepts.length) {
      // Match on id where the editor kept it, fall back to position: an editor
      // that renames a concept must not be allowed to lose one.
      concepts = concepts.map((original, i) => {
        const match = edited.concepts.find((c) => c.id && c.id === original.id) || edited.concepts[i];
        return match ? { ...original, ...match } : original;
      });
      for (const concept of concepts) {
        if (concept.editNote && concept.editNote !== "kept") log(`${concept.id}: ${trim(concept.editNote, 90)} (was ${concept.score ?? "?"}/10)`);
      }
    }
  } catch (error) {
    // A failed edit is not a failed run; the director's draft is still a post.
    log(`the editing pass failed (${error.message}) — going with the first drafts`, { role: "tool-error", tool: "edit" });
  }
  say(concepts.map((c, i) => `${i + 1}. ${c.hook}`).join("\n"), { kind: "concepts", concepts });

  /* produce */
  const plans = [];
  for (const [index, concept] of concepts.entries()) {
    onPhase(`Producing ${index + 1} of ${concepts.length}`);
    onEvent({ role: "concept-start", index, concept });
    try {
      const { plan } = await runAgent({
        call: agentCall,
        tools: producerTools({ hasGiphy }),
        toolImpls,
        brief: producerBrief({ brand, concept, voices, voiceover, images, pages: pageUrls, index, total: concepts.length }),
        onEvent: (event) => onEvent({ ...event, index }),
        system: PRODUCER_SYSTEM,
      });
      plans.push({ ...plan, index, conceptId: concept.id, angle: concept.angle });
      onEvent({ role: "concept-done", index, plan: plans[plans.length - 1] });
    } catch (error) {
      // One concept that will not come together should not take the other two
      // with it — this run costs minutes of downloads.
      onEvent({ role: "tool-error", tool: "produce", index, text: `concept ${index + 1} failed: ${error.message}` });
    }
  }

  if (!plans.length) throw new Error("Every concept failed to produce a plan");
  onPhase("Plans ready");
  return { brand, concepts, plans, images, trends: moving };
}
