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
open http://127.0.0.1:8787/social/auto.html    # Autopilot — a URL in, posts out
```

The header pill turns green when the page can reach the server. Without the
server the page still loads but has no library, no stock search, no render.

## Keys (all optional)

Copy `studio.config.example.json` to `studio.config.json` and fill in what you
have; `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `PEXELS_API_KEY`,
`GEMINI_API_KEY` and `ELEVENLABS_API_KEY` in the environment work too. Every key has a working
fallback, so the studio is usable with none of them:

| Key | Used for | Without it |
| --- | --- | --- |
| `deepseekApiKey` / `anthropicApiKey` | The "Write with …" buttons — slide copy, video scripts, captions | The template writer in `studio/formats.json`, which assembles copy from a fixed feature bank |
| `pexelsApiKey` | Stock backgrounds (free licence, no attribution) | Wikimedia Commons — reliable, but CC-licensed, so check the licence shown under each thumbnail |
| `geminiApiKey` | Voiceover — the default speaker | ElevenLabs if its key is set, otherwise macOS `say` |
| `elevenLabsApiKey` | Voiceover, when there is no Gemini key | macOS `say`, offered as a voice list in the render panel |
| `giphyApiKey` | GIF and sticker search | GIF search is disabled; everything else works |
| `serpApiKey` | Transcripts for videos YouTube publishes no captions for | `yt-dlp`'s own caption fetch, which covers most videos |

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

## AI mode

The leftmost tab. It asks five or six fixed questions — what we are making, what
about, what goes behind it, a sticker or not, a voiceover or not, how long — and
**Create** hands the answers to the model, which builds the post end to end.

The questions are asked by the page, not by the model. Fixed answers are faster
to give than a conversation, and they leave the model's turns for the work.

The split matters. Everything needing a key, a network call or a subprocess —
searching YouTube and Giphy, downloading, speaking a script — is a **tool** the
model calls on the server (`studio/agent.mjs`, `POST /ai/run`). Everything
needing a canvas — text laid out into PNGs, a clip's real crop and rect — stays
in the browser, because that is the only place the preview and the render are
guaranteed to agree. So the loop ends by calling `finish` with a *plan*: which
files, what script, what timings. The page executes that plan through the same
functions a person's clicks go through, which is why the result lands in Output
looking like anything else, with its `project.json` beside it.

Progress arrives as chat lines: each tool call, each download, then the model's
own note about what it chose. Needs the DeepSeek key; `deepseek-v4-pro` supports
OpenAI-shaped tool calls.

One trap this uncovered, which also bites a fast human: serialising a render
reads each layer's intrinsic size to work out its crop, and a layer added a
moment earlier has not measured itself yet. Those layers were silently dropped —
the first AI render was captions over black. `editor.whenReady()` now waits for
them before the freeze.

## Autopilot

`auto.html`, its own page rather than a tab. AI mode asks six questions and
builds one post; Autopilot asks nothing. You paste the address of a product —
any product, not only this one — and it comes back with a set of finished posts,
each with a Download button under it.

```
https://usemackit.com   →   3 posts, rendered, in social/studio/out/
```

The knobs under the field (how many, the mix, whether the scripts are spoken)
have working defaults; the URL is the only thing that has to be typed.

### The four passes

The prompts and the loop live in `studio/autopilot.mjs`, the server half in
`studio-server.mjs`, and each pass exists because the one before it is not
enough on its own.

1. **Recon.** The page is fetched and stripped to text, then up to four of its
   own links whose path or label looks like features, pricing, product or a
   tour. Only `http(s)`, and never an address on this machine or the private
   network — this fetcher follows a URL a person typed, and one that will go
   anywhere will eventually be pointed at a router's admin page.
2. **Brand.** The model turns that text into a fact sheet: name, one-liner,
   price line, audience, features, proofs, and an `avoid` list of claims the
   site does *not* support. Everything after this draws only on the fact sheet,
   which is what stops a post inventing a feature. For Mac Kit it replaces
   `formats.json` → `features`, which had to be kept in step with the app's
   sidebar by hand.
3. **Direct.** A creative director writes N concepts, each a different angle —
   a demo, an annoyance, a number, a confession — with a hook, a script or a
   card list, and visual direction (footage query, scene, sticker, layout).
4. **Trends.** What is moving in that niche right now, harvested per run from
   queries derived off the fact sheet — `studio/trends.mjs`, `trendingNow()`.
   Ranked by *velocity*, views per day, because a video that took three years to
   reach a million is not a trend and one that took three days is. A trend
   contributes a **shape** — hook pattern, format, beat count — and never a
   claim; claims still come only from the fact sheet. Each record keeps its link
   back to whoever made it, and a concept built on one carries `remixUrl`, whose
   video the producer cuts its bed from. Results are cached for twelve hours,
   since each query costs two `yt-dlp` passes (about ten seconds each).
5. **Critique.** A second read scores every hook out of ten on three things
   only: does it name something specific in the first four words, is every word
   supported by the fact sheet, and would the line already be on ten other
   accounts. Anything under 8 is rewritten. A first-draft hook is rarely the
   best one, and the model is a far better editor of its own work than an author
   of it. If this pass fails the run carries on with the first drafts — a failed
   edit is not a failed run.

### Reading the video before cutting it

`studio/transcript.mjs` turns a YouTube address into timestamped lines. It is a
port of the user's own transcript tool (`youtube-subtitles/transcript.py`) — its
video-id parsing, its SerpApi call and its SRT writer are all here, and the
original is untouched — with one source added in front: `yt-dlp`, which is
already a dependency, needs no key and returns YouTube's own `json3` captions
with a start and a duration per cue. SerpApi is the fallback for videos with no
published captions, and only runs when `serpApiKey` is set. Auto-captions repeat
the previous line as they scroll, so consecutive cues where one contains the
other are collapsed. Everything is cached by video id.

Two things use it. The trends pass reads how the fastest few videos *open*, since
a title is a filename and the first fifteen seconds are what earned the view, and
shows those openings to the director. And the producer has `read_video`: on a
concept's `remixUrl` it reads the whole thing as one line per fifteen seconds, so
it can cut the stretch where something happens instead of guessing a timecode and
landing in the sponsor read.

(The standing `studio/trends.json` is a different thing: `harvest-trends.mjs`
builds it for Mac Kit's own studio from a fixed query list plus Reddit's top
feeds, and both it and Autopilot now classify hooks with the same rules in
`studio/trends.mjs`.)

Then one **producer** agent per concept, the same tool-calling loop AI mode uses
(`runAgent` in `studio/agent.mjs`, which now takes its system prompt as an
argument). It searches and downloads footage, saves a sticker, speaks the script
and ends by calling `finish` with a plan. It has one tool AI mode does not:
`search_photos`, so a carousel's scene can be *checked* before it is committed
to — Wikimedia ANDs every word, and a scene that returns nothing is six flat
cards.

### Everything is fetched, nothing is reused

The library is not offered to Autopilot at all — `list_library` is the one tool
its producer does not get. Every frame of a post is fetched during that post's
own run: the background clip from YouTube, the sticker from Giphy, photographs
from stock — `search_photos` then `download_photo`, so a video can stand on a
still rather than always on footage — and the read from Gemini. That is deliberate, and it is what
makes the page work for a product this machine has never seen: there is no
screen recording of someone else's app lying in `library/`, and there never will
be.

The product itself comes off its own site, two ways. Recon collects the pictures
on every page it reads — `og:image`, `twitter:image`, every `<img>` (the widest
`srcset` candidate), minus icons, logos, favicons and SVG, which ffmpeg cannot
read anyway — and the producer pulls the ones it wants through
`download_site_image`. But a good landing page usually draws its product shots in
HTML rather than shipping them as files: usemackit.com's only real picture is its
`og:image`, and the other seventeen are competitors' icons from the comparison
table. So the second tool, `screenshot_site`, photographs the live page itself at
a size the producer picks, with an optional `scrollY` to reach a section further
down. Both land in `library/photos/` with a line in `photos/sources.json` saying
where they came from and that they are fine for a post about that product and
nothing else.

The page has to have loaded before the shutter. A producer that guessed a path —
`/compare`, `/features` — got a photograph of Chrome's error screen sitting in a
finished post, which is exactly what happened once. Chrome reports that two ways
depending on the site: as a status on the document (`Network.responseReceived`)
and as `net::ERR_HTTP_RESPONSE_CODE_FAILURE` back from `Page.navigate` itself.
Both are read as the same fact, and either one falls back to the site's front
page, with the tool saying so in its result. If the front page fails too it
errors rather than returning a picture of nothing. The producer's brief also lists the page
addresses recon actually read, and the tool says to use one of those.

The screenshotter drives Chrome over the DevTools protocol rather than using
`--screenshot`, for two reasons found the hard way. Chrome writes the file and
then does not exit, so a plain spawn hangs the whole run; and the first visit to
any real site brings a consent sheet across the picture — which is removed from
the document before the shutter (fixed and sticky elements whose id, class or
text reads as cookie/consent/privacy/newsletter), not cropped out afterwards. The
`ws://` address Chrome prints is the *browser*, which has no Page domain: the tab
is a separate target, found through `/json/list`.

A downloaded screenshot goes on the canvas as a **still**, not a clip: it is
contained inside the box its layout gave it rather than covering it, because a
screenshot cropped to a video-shaped hole loses most of the screenshot. ffmpeg
gets it as a `-loop 1` input so it lasts the whole post instead of showing one
frame.

### Where the work happens

Same split as AI mode, same reason: everything needing a key, a socket or a
subprocess is a tool on the server; everything needing a canvas stays in the
browser, because that is the only place the preview and the render are
guaranteed to agree. `auto.js` turns a plan into layers, captions and slides and
calls the same `/render-video` and `/save-post` the studio does, so the output
lands in `studio/out/` looking like anything else — including a `project.json`,
so a post Autopilot made can be opened in the studio's editor afterwards.

A plan is executed the moment its producer finishes rather than at the end of the
run, so post one renders while post two is still downloading its footage. A queue
keeps that to one at a time: the editor is a single canvas and two compositions
cannot share it.

### The picture is composed, not picked

There are no layouts. The producer returns a **list of layers**, back to front,
and each one names a source it downloaded and a place in the 1080×1920 frame:
`full`, `top`, `bottom`, `middle`, `centre`, `phone` (a tall panel, the shape a
phone screenshot is), `card` (a floating window, the shape a desktop screenshot
is), the four corners, and three sticker boxes. Layers carry their own `start`
and `end`, so a sticker can arrive on the punchline and leave.

That is the difference between "a clip over a clip, again" and what the format
actually allows: a photograph filling the frame with a cut-out bouncing over it,
a screenshot standing on a blurred copy of itself, a gif as the whole
background with the product in a corner, a second clip cutting in halfway. The
director is asked for a one-line `picture` per concept and told not to make the
same shape twice in a campaign.

What the model leaves out is chosen rather than refused: a clip fills its box, a
still or a sticker shows all of itself, the layer at the back gets a little
sound and the rest get less — much less when someone is speaking. A still that
does not fill its box gets a blurred copy of itself behind it instead of black
bars. Captions read the layers to decide their own height: a layer occupying the
bottom half pushes them up rather than sitting under them.

A producer that answers in the older fixed-slot shape (`backgroundPath`,
`appClipPath`, `gifPath`) still gets a post — those are mapped onto regions —
rather than a page reporting that nothing happened.

### Downloading

Each finished card carries **Download video** (or **Download cards**, which zips
the folder with `ditto`), an editable caption with **Copy caption**, and **Show
in Finder**. The downloads go through `/download` and `/zip`, which set
`Content-Disposition`: an `href` straight at an mp4 opens it in a tab instead of
saving it.

### What it costs

A three-post run is a dozen or so model calls plus a YouTube download per video,
so it takes minutes rather than seconds, and the feed on the left says which tool
is running. It needs the DeepSeek key; with no model key the page says so and
does nothing else.

## Supercut

`cut.html`. A third page, and the only one that makes a video out of nothing but
other people's mouths. Pick a subject, write a line, and it searches that corner
of YouTube, reads the captions, finds the seconds where each of your words is
actually spoken, cuts them out and puts them in your order.

```
macbook tips  +  "pomodoro timer, clipboard history, all in one menu bar app"
   →  6 clips from 5 videos, 4.5 seconds
```

### How the matching works

`studio/supercut.mjs` costs every possible run and takes the cheapest path
through the whole script. Greedy longest-first is the obvious way and it is
wrong: "all in" exists, so a greedy pass takes it and never discovers that one
video says "all in one menu" whole. A cut costs the same whatever its length,
which is what makes the solver prefer three long clips to six short ones, and a
gap costs more than any cut, so a word is only left out when nobody says it.

The **Cuts** control is that cost: *fewer, longer takes* holds out for whole
phrases, *chop it up* is the stuttering ransom-note look on purpose.

Two things feed the solver enough material to find long runs. The subject search
gives videos that are *about* the thing; then each clause of the script is
searched as a quoted phrase, which gives videos chosen because someone says those
words. Phrase-search results are marked off-topic and carry a penalty, so a
Windows tutorial can supply "clipboard history" when nothing else does but loses
to any Mac video that says the same words — which is exactly what it did on the
verified run.

Cutting on the *word* rather than the caption line is possible because YouTube's
automatic captions carry a `tOffsetMs` per word inside each cue — `wordsFromJson3`
in `studio/transcript.mjs` unpacks those. Manually uploaded captions usually have
no offsets, so their words are spread evenly across the cue, which is wrong by a
fraction of a second rather than by a line. Auto-captions also roll, repeating the
previous words in the next event; a word at the same second as the one before it
is that repeat and is dropped.

A candidate is rejected when its span is longer than two seconds a word: that
means the speaker paused mid-phrase, or the captions drifted, and the cut will
sound wrong.

### Hunting the missing words

The first pool rarely says everything. Every word nobody said gets searched for on
its own — `<subject> <word>`, then the bare word — and the pool grows before the
match is rebuilt. That is what turns "we could not find pomodoro" into a clip of
someone saying *pomodoro*: on the verified run it found it in "Best Pomodoro
Timer Apps EVER!" at 4:48.

What is still missing after the hunt is never dropped. It stays in the script as a
gap, shown in the strip in red, and is either typed on screen or spoken by the
studio's own voice, depending on the switch.

### Cutting and laying out

Each clip is one `yt-dlp --download-sections` with `--force-keyframes-at-cuts`,
because without the re-encode the cut lands on the nearest keyframe, which can be
seconds early — the whole point of cutting on a transcript. Clips are cached by
url and start time, so re-running a script costs nothing for the words it already
has.

The page lays them end to end: each clip is a full-frame layer starting where the
last one finished, with no trimming, because the file *is* the word. The word
being spoken is drawn over it, and the strip above the log lights up chip by chip
as the playhead crosses it. Render goes through the same `/render-video` as
everything else, so the result lands in `studio/out/` with its `project.json`.

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

### Which voice speaks

With `geminiApiKey` set, Gemini speaks everything — the **Speak the script**
button, **Hear it**, AI mode and Autopilot — and an empty voice, which is what
every caller that does not care sends, resolves to Gemini's `Charon`. Its thirty
voices are listed in the picker with the one-word character its docs give each
(`Sulafat — Warm`, `Fenrir — Excitable`), because a name alone says nothing about
how it sounds. Without the key the order is ElevenLabs, then macOS `say`, exactly
as before; the macOS voices stay in the list either way.

The API answers with raw 24 kHz mono PCM, so the server writes a 44-byte RIFF
header in front of it — ffmpeg will not read headerless PCM without being told
its rate and layout, and a WAV is something everything downstream already
understands.

These models take **direction in plain language**, so a read can be asked for:
Autopilot's producer has a `style` argument on `make_voiceover` ("Read this
dryly, like you are telling a friend what you did at the weekend") and it is
prefixed to the script as an instruction, not spoken.

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
  auto.html    auto.js    auto.css        Autopilot — a URL in, finished posts out
  cut.html     cut.js     cut.css         Supercut — a line, cut out of other people's videos
  studio-server.mjs                        the local server
  studio.config.json                       keys (create from the .example)
  studio/
    formats.json                           post formats + the offline copy bank
    render-image.js                        canvas renderer (slides + text layers)
    composition.js                         the layer model both sides read
    agent.mjs                              AI mode's tool loop
    autopilot.mjs                          Autopilot's five passes and its producer
    trends.mjs                             velocity-ranked trends + the hook classifier
    transcript.mjs                         what a video says, with timings (yt-dlp, then SerpApi)
    supercut.mjs                           finds a script's words inside those transcripts
    freeze.js                              canvas -> render spec, shared by every page
    shot.mjs                               photographs a live page with headless Chrome
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
