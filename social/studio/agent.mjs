// AI mode: the model drives the studio instead of a person clicking it.
//
// The split is deliberate. Everything that needs a key, a network call or a
// subprocess — searching YouTube and Giphy, downloading, speaking a script —
// runs here as a tool the model can call. Everything that needs a canvas — text
// laid out into PNGs, a clip's real crop and rect — stays in the browser,
// because that is the only place the preview and the render can be guaranteed
// to agree.
//
// So the loop ends by calling `finish`, handing back a *plan*: which files, what
// script, what timings. The page executes that plan through the same functions a
// person's clicks go through, and renders. Nothing here writes a composition.

const MAX_STEPS = 24;

export const AGENT_SYSTEM = `You are the producer inside Mac Kit's Content Studio. You build one short vertical social post end to end by calling tools, then finish.

How to work:
- Call tools. Do not narrate what you would do, and never ask the user anything — you already have their brief.
- Look at the library before searching the web. A clip that is already downloaded costs nothing and is usually good enough.
- Search queries are two to four plain words. Never put a product name, a feature name or an adjective like "hypnotic" in a search — stock and YouTube search match every word, so "clean mode laptop desk" returns nothing at all.
- Download only what you will use. One background clip is almost always enough.
- Write the script yourself; there is no tool for it. Short lines, one idea each, read in under two seconds. Say what the app does, never what it "empowers" you to do.
- Every claim must come from the feature list you were given. If the brief asks for something the app does not do, build the closest true thing and say so in your final note.
- Then call finish with the whole plan. One call, everything in it.

Tone: a person who uses the app, talking to another person. No hype words, no exclamation marks, no emoji unless the brief asks.`;

export function toolSchemas({ hasGiphy }) {
  const tools = [
    {
      type: "function",
      function: {
        name: "list_library",
        description:
          "What is already downloaded: background clips, app screen recordings, stills, saved GIFs, music and voiceovers. Call this first — reusing a clip costs nothing.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: "search_footage",
        description:
          "Search YouTube for a background clip, ranked by view count. Two to four plain words, no product or feature names.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "e.g. 'minecraft parkour gameplay' or 'satisfying soap cutting'" },
            sort: { type: "string", enum: ["views", "relevance"] },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "download_footage",
        description:
          "Download one search result into the library. Grab a slice, not the whole video: a 30-minute gameplay upload is not worth keeping. Returns the local path to use in the plan.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            section: {
              type: "string",
              description: "Slice to take, as HH:MM:SS-HH:MM:SS. Start a minute or so in, past any intro. Keep it to 40 seconds or less.",
            },
          },
          required: ["url", "title", "section"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "make_voiceover",
        description: "Speak a script and add it to the library. Returns the local path and its real duration in seconds.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The whole read, as one string. Sentences separated by full stops." },
            voice: { type: "string", description: "A voice id from the brief, or empty for the default." },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "finish",
        description: "Hand back the finished plan. Call this exactly once, at the end, with everything filled in.",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["video", "image"] },
            layout: {
              type: "string",
              enum: ["split", "pip", "screen", "stack"],
              description:
                "video only. split = app recording on top, background below. pip = background full frame with the recording floating. screen = the recording over a blurred copy of itself. stack = three bands.",
            },
            duration: { type: "number", description: "video only, seconds. Match the voiceover if there is one." },
            backgroundPath: { type: "string", description: "video only. Local path from the library or a download." },
            appClipPath: { type: "string", description: "video only. Local path of a Mac Kit screen recording." },
            gifPath: { type: "string", description: "video only, optional. Local path of a sticker to sit on top." },
            voicePath: { type: "string", description: "video only, optional. Local path returned by make_voiceover." },
            hook: { type: "string", description: "The first line on screen. Under seven words, works with no context." },
            lines: {
              type: "array",
              items: { type: "string" },
              description: "video only. Caption lines in order, one idea each.",
            },
            slides: {
              type: "array",
              description: "image only. One entry per card.",
              items: {
                type: "object",
                properties: { headline: { type: "string" }, body: { type: "string" } },
                required: ["headline", "body"],
              },
            },
            scene: {
              type: "string",
              description: "image only. Two plain words naming one ordinary place the whole carousel is photographed in.",
            },
            caption: { type: "string", description: "The post caption." },
            hashtags: { type: "array", items: { type: "string" }, maxItems: 6 },
            note: { type: "string", description: "One sentence to the user about what you chose and why." },
          },
          required: ["kind", "hook", "caption", "hashtags", "note"],
        },
      },
    },
  ];

  if (hasGiphy) {
    tools.splice(3, 0, {
      type: "function",
      function: {
        name: "search_gif",
        description: "Search Giphy. Stickers have transparent backgrounds and are what you want over video; gifs are rectangular.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "One or two plain words, e.g. 'shocked' or 'thinking'" },
            kind: { type: "string", enum: ["stickers", "gifs"] },
          },
          required: ["query"],
        },
      },
    });
    tools.splice(4, 0, {
      type: "function",
      function: {
        name: "download_gif",
        description: "Save one search result into the library. Returns the local path to use in the plan.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "The id from search_gif" } },
          required: ["id"],
        },
      },
    });
  }

  return tools;
}

export function buildBrief({ answers, features, product, voices }) {
  const lines = [
    `Product: ${product.name} — ${product.url}`,
    `Positioning: ${product.priceLine}`,
    ``,
    `Features you may reference (nothing else exists):`,
    ...features.map((f) => `- ${f}`),
    ``,
    `The brief:`,
  ];
  for (const [question, answer] of Object.entries(answers)) {
    if (answer && String(answer).trim()) lines.push(`- ${question}: ${answer}`);
  }
  if (voices && voices.length) {
    lines.push(``, `Voice ids you may pass to make_voiceover: ${voices.slice(0, 12).join(", ")}`);
  }
  lines.push(``, `Build it now. Call tools, then finish.`);
  return lines.join("\n");
}

/**
 * Run the loop.
 *
 * `call` posts a messages array to the model and returns its choice message.
 * `tools` maps a tool name to an async function. `onEvent` receives chat-shaped
 * updates as they happen, so the page can show its own progress rather than
 * staring at a spinner.
 */
export async function runAgent({ call, toolImpls, tools, brief, onEvent, system = AGENT_SYSTEM }) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: brief },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const message = await call(messages, tools);
    messages.push(message);

    const calls = message.tool_calls || [];
    if (!calls.length) {
      // No tool and no finish: nudge once rather than accepting prose as an
      // answer, since prose cannot be rendered.
      if (message.content) onEvent({ role: "assistant", text: message.content });
      messages.push({
        role: "user",
        content: "Keep going with tools, and call finish when the plan is complete. Do not reply with prose.",
      });
      continue;
    }

    for (const toolCall of calls) {
      const name = toolCall.function.name;
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {}

      if (name === "finish") {
        onEvent({ role: "assistant", text: args.note || "Plan ready." });
        return { plan: args, steps: step + 1 };
      }

      onEvent({ role: "tool", tool: name, args });
      let result;
      try {
        result = await toolImpls[name](args, onEvent);
      } catch (error) {
        result = { error: String(error.message || error) };
        onEvent({ role: "tool-error", tool: name, text: result.error });
      }
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }

  throw new Error(`Gave up after ${MAX_STEPS} steps without a finished plan`);
}
