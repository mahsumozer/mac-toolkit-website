# Mac Kit Content Studio (local-only)

A Fastlane-shaped generator sitting inside the social hub: brief in, finished
image carousel or vertical video out, ready to hand to the posting queue on
`social/index.html`.

Two pieces:

| Piece | What it does | Where |
| --- | --- | --- |
| `studio.html` / `studio.js` / `studio.css` | The page. Owns the copy, the slide layout and the canvas. | served by `npm run hub` on `:8787` |
| `studio-server.mjs` | Everything needing a process or a secret: ffmpeg, the media library, the DeepSeek / Claude / Pexels / ElevenLabs keys. | `node social/studio-server.mjs` on `:8789` |

Neither is deployed. `social/` is skipped by `scripts/build-pages.sh` and matched
by `/social/*` in `.gitignore`, same as the rest of the hub.

## Run

```
npm run hub                     # :8787 — serves the repo root
node social/studio-server.mjs   # :8789 — render + generation server
open http://127.0.0.1:8787/social/studio.html
```

The header pill turns green when the page can reach the server. Without the
server the page still loads but has no library, no stock search, no render.

## Keys (all optional)

Copy `studio.config.example.json` to `studio.config.json` and fill in what you
have; `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `PEXELS_API_KEY` and
`ELEVENLABS_API_KEY` in the environment work too. Every key has a working
fallback, so the studio is usable with none of them:

| Key | Used for | Without it |
| --- | --- | --- |
| `deepseekApiKey` / `anthropicApiKey` | The "Write with …" buttons — slide copy, video scripts, captions | The template writer in `studio/formats.json`, which assembles copy from a fixed feature bank |
| `pexelsApiKey` | Stock backgrounds (free licence, no attribution) | Wikimedia Commons — reliable, but CC-licensed, so check the licence shown under each thumbnail |
| `elevenLabsApiKey` | Voiceover | macOS `say`, offered as a voice list in the render panel |
| `giphyApiKey` | GIF and sticker search | GIF search is disabled; everything else works |

### Which model writes the copy

`copyProvider` picks one explicitly (`"deepseek"` or `"anthropic"`); left empty,
whichever key is set wins, DeepSeek first if both are. The page reads the answer
from `/library` and labels its button accordingly, so you can tell at a glance
which one is about to run.

The two providers get the same brief but not the same request. Anthropic takes a
`json_schema` structured output; DeepSeek has no schema mode, only
`response_format: json_object`, and its docs require the prompt to contain the
word "json" and show the shape — so the request carries both a schema and a
worked example, and the prompt itself is identical. DeepSeek occasionally returns
an empty body on JSON mode (their docs say so); that comes back as a readable
error rather than a JSON parse failure.

Defaults: `deepseek-v4-pro` and `claude-opus-5`, both overridable
(`deepseekModel`, `model`). DeepSeek's cheaper sibling is `deepseek-v4-flash`,
and its off-peak rates (01:00–04:00 and 06:00–10:00 UTC) are half the peak ones.

## Image posts

The format is the one the reference posts use: a photo, and bold centred type in
white rounded sticker boxes that hug each line.

1. **Brief** — pick a format (numbered listicle, problem → fix, POV, before →
   after, hot take), an audience persona from `content.json`, optionally a topic,
   then *Write with DeepSeek/Claude* or *Use templates*.
2. **Slides** — edit any headline or body, reorder, add, remove. The strip along
   the top is the running order.
3. **Background** — the local photo library (`studio/library/photos/`, drag and
   drop to add), a stock search, or the app screenshots already in
   `social-media-video/`. Slides open with no background; you pick one, or a
   freshly written post fills them all from a single scene (below).
4. **Look** — canvas 4:5 / 9:16 / 1:1, four text styles, type sizes, background
   darkening, an optional handle along the bottom.
5. **Blitz review** — `J` keeps a slide, `K` cuts it, arrows move. Only kept
   slides are exported.
6. **Export** — writes `studio/out/<date>-<slug>/01.png…` plus `caption.txt` and
   `post.json`.

The preview canvas renders at full export resolution and is scaled down with
CSS, so the preview *is* the file.

### One scene per post

Writing a post runs **one** stock search for the whole carousel, not one per
slide, and spreads the frames across the cards. Two reasons. Searching per slide
put the tool's own name into the query — `clean mode laptop desk` — and Wikimedia
Commons ANDs every term, so one word with no match there returns nothing and
that slide stayed blank; measured, every product-jargon query returned 0 results
while plain `laptop desk` returned 24. And a carousel whose cards were each
found separately reads as six unrelated stock photos rather than one place.

The scene comes from the model (a `scene` field: two plain words naming a place)
or from the measured bank in `formats.json` -> `scenes`. Two words is the
ceiling: a third narrows Commons hard, and `Unsplash night desk` returns nothing
where `laptop desk` returns a full page. A scene that finds nothing falls back to
`sceneFallback`, so no slide is left blank.

Candidate frames are sampled for mean luma through the proxy and the post is
arranged dark to bright, so it opens close and ends open. If the sampling fails
the search's own order is kept rather than a half-sorted one.

## Video posts

A small editor, not a form. The right-hand canvas plays the real clips at
1080×1920, the timeline across the foot of the page says when each layer is on
screen, and **Render** turns exactly what is on the canvas into an mp4.

Three kinds of layer go on it: clips, stills (the photo library and the app
screenshots, from the grid in block 2) and text.

Editing a layer:

- **Drag** it to move, **drag any of the four orange corners** to resize. The
  opposite corner stays pinned.
- **Arrow keys** nudge by a pixel, **shift+arrow** by ten. **Delete** removes.
- The **inspector** under the layer list holds exact numbers — x, y, width,
  height, fit, blur, volume, in/out times, and for text the wrap width and type
  size. **Fill frame / Centre / Top half / Bottom half** are one-click geometry.
- Building a canvas selects the top layer, so the size controls are on screen
  immediately rather than hiding until something is clicked.

The canvas paints while paused, so building a layout or scrubbing shows real
frames without pressing Play. Two things are needed for that and both are easy
to lose: the media elements live in an off-screen container in the document
(Chrome will not buffer past metadata for a detached `<video>` that is never
played), and `currentTime` is only set when it differs by more than a tolerance
and no seek is already in flight. A seek lands on the nearest decodable frame
rather than the exact time asked for, so re-seeking on any difference at all
makes every `seeked` schedule the next one — `readyState` never climbs out of 1,
`draw()` skips the layer every time, and the canvas stays black until playback
forces it.

Grips are sized in *screen* pixels and converted back to composition pixels: the
canvas is 1080 wide but displayed around 300, so a grip fixed in composition
pixels ends up under 9 pixels under the pointer and cannot be grabbed. They also
sit just inside the box, because a full-frame layer's corners are exactly on the
canvas edge. The selection outline follows the layer's own rectangle rather than
the drawn pixels, so for a `contain` layer what you drag is what the inspector's
numbers say.

### The timeline

Pinned to the bottom of the window, so the bars stay reachable while the
controls above them are scrolled. One row per layer, in the same order as the
layer list, with the clips in grey, the stills in green and the text in orange.

- **Drag a bar** to move it in time; **drag either end** to trim it. Trimming a
  clip's head moves its in-point with it, so the frames under the bar stay where
  they were instead of the clip restarting later. Dragging near the playhead
  snaps to it.
- **Split at playhead** (or <kbd>S</kbd>) cuts the selected layer in two. The
  second half's in-point advances by exactly what the first consumed, so the
  cut is seamless until you move one of the halves.
- **Duplicate** puts the copy *after* the original rather than on top of it,
  which is how a short clip is stretched to fill the rest of the composition.
- **Add text** starts at the playhead and runs 2.5 seconds; how long a caption
  stays on screen is that bar's width.
- Click the ruler to scrub, <kbd>Space</kbd> plays. **Length** and the *Length*
  slider in block 5 are the same number: layers that ran to the old end follow
  the new one, anything deliberately cut short keeps its own timing.

Two things the render has to do for a layer that does not begin at zero, and
neither is visible until something is moved or split: the clip is padded at the
front with `tpad`, because `-ss` puts the in-point at output time zero and
without the pad a layer starting at 4s would show the frame four seconds past
its in-point; and its audio is `atrim`med to the layer's own window and delayed
onto it, or the two halves of a split clip would each play their sound across
the whole render. A cut clip renders frame-identical to the same clip uncut.

### Finding footage

Block 1 searches the web for the background bed. Type what the video is about,
press **Suggest searches**, and the copy model turns it into footage queries
(gameplay, satisfying loops, drone shots); or type a query yourself. Results come
from YouTube via `yt-dlp` — no API key — ranked by view count, or from Pexels
video when a Pexels key is set.

*"What is viral right now" is not something a public API answers.* What this can
do is rank a search by views and recency, which is the closest honest proxy.

**Grab from / Seconds** downloads just that slice of a long video rather than the
whole thing, and every download is logged in
`studio/library/videos/sources.json` with its query, channel, URL, section and
licence note. Most gameplay beds are uploaded as "no copyright" by their
channels; that claim is the uploader's, not a verified licence, and the manifest
says so. Pexels clips are genuinely licence-clean.

Downloads pick the best format near 1080 and prefer H.264. Note that filtering
on `height<=1080` looks right and is not: a vertical 1080×1920 clip has a height
of 1920, so that filter throws away every good format and leaves a 480p one.
Sorting with `-S res:1080,vcodec:h264` is what works.

### Building a composition

There are no layout presets. Every shelf in **Clips** — app recordings,
background clips, stills, saved GIFs — is dragged onto the canvas, and the layer
lands where you let go. The first clip fills the frame, because the first one is
nearly always the bed; later ones arrive as a box centred on the pointer, sized
to their own aspect so nothing is cropped on arrival. Clicking a card instead
drops it in the middle. **Fill frame / Centre / Top half / Bottom half** in the
inspector do in one click what the old presets did in bulk.

Background clips go in `studio/library/videos/` (drag and drop onto the page),
music in `studio/library/music/`. App recordings come from
`social-media-video/` and `videos/*/out/` automatically.

### The script, spoken

**Speak the script** turns the hook and caption lines into a voiceover and puts
it on the timeline at the playhead as its own track. Trim its edges, drag it,
change its level — it is an ordinary layer, so the timeline code that moves a
clip moves it too, and the renderer places it with the same arithmetic. The
composition grows if the read runs past the end. It is audible in the preview,
unlike the clips: a voiceover you cannot hear is one you cannot time. The voice
comes from the picker in Captions & audio, where **Hear it** auditions it.

Files land in `studio/library/voice/`.

### GIFs and stickers

Search Giphy from the Clips block and save what you want; saved GIFs sit in
their own shelf and drag onto the canvas like anything else. **Stickers** are cut
out with real transparency and are usually what you want over a video; **GIFs**
are rectangular with a background.

A GIF's frames are decoded up front with `ImageDecoder` and drawn by
composition time, rather than being left to an `<img>`. Two reasons: a detached
`<img>` never advances its animation at all (which is why stickers sat frozen on
the canvas while the same file animated in the library grid), and an attached one
advances on the browser's own clock — so the preview would show a frame the
render never picks. Frames are downscaled to 512px and capped at 200, and the
bitmaps are closed with the layer. To ffmpeg it is a looping input
(`-ignore_loop 0` — without it the gif stops on its own last frame). Needs
`giphyApiKey` in `studio.config.json`; it is free from developers.giphy.com.
Giphy uploads are frequently third-party clips, so the licence line the manifest
records for them says to check before commercial use.

Both clip pickers are grids of poster frames rather than filename dropdowns:
hover a card to see it move, click to pick it, and the ⤢ button opens it full
size. Posters are single ffmpeg frames grabbed a third of the way in (frame zero
is a fade or a title card), cached under `studio/tmp/thumbs/`. Hover previews are
created and destroyed with the pointer — a dozen permanent `<video>` elements in
one grid is a dozen live decoders. The `<select>` behind each grid is still the
selection's source of truth, so the choice stays keyboard-reachable.

The same ⤢ opens rendered videos and image slides on the Output tab, and stock
or library photos on the Image post tab. **Hear it** auditions the chosen macOS
voice on your actual hook line, and **Play** auditions a music track.

### How the preview stays honest

Every layer carries an explicit source **crop** and an explicit destination
**rect**, both in real pixels (`studio/composition.js`). Canvas draws it as
`drawImage(src, sx,sy,sw,sh, x,y,w,h)`; ffmpeg draws it as
`crop=sw:sh:sx:sy,scale=w:h` then `overlay=x:y`. Neither side re-derives the
geometry, so neither can disagree with the other. Text layers go further: the
page paints each one onto a transparent 1080×1920 frame and ships that PNG, so
the type in the file is the same pixels you dragged.

That is also why only effects ffmpeg can reproduce are drawn in the preview —
blur is in, rounded corners are out until the render can match them.

Captions being PNGs rather than `drawtext` is not only about fidelity: this
machine's Homebrew ffmpeg is built without libfreetype, so `drawtext` does not
exist here at all. If a caption ever fails to appear, check that its PNG input
still has `-loop 1` — a plain image input decodes one frame and overlay stops
compositing long before the caption's turn comes round.

**Put captions on canvas** turns the script into timed text layers, spread across
the clip weighted by how much text each carries, and replaces the previous set
rather than stacking on it. Move or retime any of them afterwards. With a
voiceover the clip length comes from the audio, so captions and speech cannot
drift apart.

The preview is silent — audio is mixed at render.

### Output, and going back to it

Each render writes its own folder under `studio/out/`:

```
2026-09-07-fourteen-tools/
  video.mp4
  caption.txt
  project.json
```

`project.json` is the *editable* composition — layers with their boxes, times
and trims, the script, the caption settings — not the frozen render spec, whose
crops, rects and baked text PNGs describe one frame size and cannot be dragged.
Without it a finished video is a dead end.

**Open for editing** on an Output card, or **Open a project…** in the render
block, loads one back onto the canvas. Layers keep an absolute `path` and drop
their `src`, which is rebuilt on the way in — a project that hard-codes the
server's port stops opening the day the port moves.

Rendering an opened project never overwrites it: folder names are claimed with
`mkdir` and fall through to `<slug>-2`, `-3`, so the original stays where it
was and `derivedFrom` records what it came from. Renders made before projects
existed are still flat `.mp4` files and are listed, just without an Edit
button.

## Layout

```
social/
  studio.html  studio.js  studio.css      the page
  studio-server.mjs                        the local server
  studio.config.json                       keys (create from the .example)
  studio/
    formats.json                           post formats + the offline copy bank
    render-image.js                        canvas renderer (slides + text layers)
    composition.js                         the layer model both sides read
    editor.js                              the live draggable canvas
    library/photos|videos|music/           your footage
    library/videos/sources.json            where each downloaded clip came from
    out/                                   finished posts
    tmp/                                   per-render scratch, deleted on success
```

`yt-dlp` powers footage search and download (`brew install yt-dlp`); the header
pill and `/health` report whether it is present.

`studio/formats.json` holds `features` — the only list the copy generator may
draw claims from. It mirrors the app's sidebar (`src/components/Sidebar.tsx`);
adding a tool there without adding it to the app puts a false claim on a post.

## Not yet verified against the live API

The Anthropic copy path has never run with a real key; DeepSeek is the
configured provider and has. ElevenLabs is untested too — macOS `say` is what has
actually been used.

Canvas playback was verified in a real browser context (`readyState` 4, video
pixels reaching the canvas); it does *not* work under headless Chrome with
`--virtual-time-budget`, which freezes the clock so media never buffers. That is
the test harness, not the app — hold the load event open with a slow request
instead if you need to check it headlessly.
