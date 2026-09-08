// Records the site's #compare section as a 1080x1920 vertical clip.
//
// Below 1080px the section stacks into one column, and below 820px the Mac Kit
// panel stops floating and sits inline in its box (no reserved empty space). We
// want the second layout without shrinking the viewport, so those rules are
// injected instead.
//
// The frame is 1080 device px wide but the page is laid out at VW CSS px and
// zoomed to fill it, so type is (1080 / VW) larger while every pixel is still
// rendered natively - no upscaling anywhere in the chain. The section's own
// vertical padding is then set so its height lands exactly on 16:9.
//
//   electron videos/compare-video/capture.mjs still 3.2 [more times...]
//   electron videos/compare-video/capture.mjs video 19.3
//
// Frames leave the page as raw BGRA paint events and are piped to ffmpeg live,
// then re-encoded once the capture is over.
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "..", "index.html");
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const OUT_W = 1080;
const OUT_H = 1920;
const VW = Number(process.env.VW || 1080); // layout width in CSS px
// Feeds, captions and the platform's own buttons sit over the top and bottom of
// a 9:16 post, so the section is kept inside a safe band and the rest is paper.
const SAFE_TOP = Number(process.env.SAFE_TOP || 110);
const SAFE_BOTTOM = Number(process.env.SAFE_BOTTOM || 320);
let band = OUT_H - SAFE_TOP - SAFE_BOTTOM; // shrinks the bottom margin rather than cropping the box
const PANEL = Number(process.env.PANEL || 540); // Mac Kit panel width in CSS px
// The section's small type is sized for a desktop reading distance; on a phone
// it has to carry from arm's length, so the two boxes get their own bump. The
// panel is scaled whole (type, padding, icons) rather than rule by rule.
const PANEL_ZOOM = Number(process.env.PANEL_ZOOM || 1.36);
const SCATTER_H = Number(process.env.SCATTER_H || 475); // pays for the panel's extra height
const ZOOM = OUT_W / VW;
const FPS = 30;
// The section's own animation: reveal at +1.7s, then a 4.4s merge cycle. The
// Mac Kit panel only opens 3.1s into the first cycle, so the camera waits for it.
const WARMUP = Number(process.env.WARMUP || 5600);

const mode = process.argv[2] || "still";
const times = process.argv.slice(3).map(Number).filter((n) => !Number.isNaN(n));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PREP = `(() => {
  const css = document.createElement('style');
  css.id = 'capture-prep';
  css.textContent = \`
    html { scroll-behavior: auto !important; }
    html, body { scrollbar-width: none !important; }
    ::-webkit-scrollbar { display: none !important; }
    .site-header, #privacy-choice, .site-footer { display: none !important; }
    /* the <=820px treatment of the Mac Kit panel, at any width */
    .compare-menu-popover {
      position: static !important;
      width: 100% !important;
      margin-top: 10px !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
      transform: none !important;
      transition: none !important;
    }
    .compare-menu-popover > .hero-window {
      max-width: ${PANEL}px;
      margin: 0 auto;
      zoom: ${PANEL_ZOOM};
    }
    .compare-empty-space { display: none !important; }
    /* the offer now rides with the MAC KIT tag, so the buy row is a repeat */
    .compare-buy-row { display: none !important; }

    /* Old-way box: bigger names, prices, menu bar and ticker. The scatter area
       gives back the height this costs. */
    .compare-apps.is-scattered { height: ${SCATTER_H}px !important; }
    .compare-apps.is-scattered .compare-app { width: 155px; }
    .compare-app { font-size: 18.5px; }
    .compare-app b { font-size: 30px; }
    .compare-app-icons { min-height: 40px; }
    .compare-menubar-word, .compare-menubar-clock { font-size: 15.5px; }
    .compare-chaos-set span { font-size: 15.5px; }
    .compare-total strong { font-size: 80px; }
    .compare-total small { font-size: 20px; }
    .compare-tag { font-size: 14px; }
    .compare-tag-accent { font-size: 28px; }

    /* The heading and the boxes' own padding are where the extra type comes
       from: both are generous at desktop reading distance. */
    .compare-section .section-kicker { margin-bottom: 4px !important; }
    .compare-section .section-kicker h2 { font-size: 42px !important; }
    .compare-col { padding: 13px !important; }
    .compare-total { padding-top: 10px !important; }

    /* Video-only: the price rides along with the MAC KIT tag, so the offer is
       readable in the first second instead of only at the very bottom. */
    .compare-cell > .compare-col-head:has(.compare-tag-accent) {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .capture-offer {
      font-size: 62px;
      font-weight: 820;
      letter-spacing: -0.05em;
      line-height: 1;
      color: var(--ink);
    }
    .capture-offer b { color: var(--accent); font-weight: 820; }
    /* the frame supplies the margin, so the section's own padding is set below */
    .compare-section { padding-top: 0 !important; padding-bottom: 0 !important; }
  \`;
  document.head.appendChild(css);
  const accent = document.querySelector('.compare-tag-accent');
  if (accent && !accent.parentElement.querySelector('.capture-offer')) {
    const offer = document.createElement('strong');
    offer.className = 'capture-offer';
    offer.innerHTML = 'Only for <b>$9.99</b>';
    accent.insertAdjacentElement('afterend', offer);
  }
  return true;
})()`;

const MEASURE = `(() => {
  const s = document.querySelector('.compare-section');
  const r = s.getBoundingClientRect();
  return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height), w: Math.round(r.width) };
})()`;

const padTo = (px) => `(() => {
  const s = document.querySelector('.compare-section');
  s.style.setProperty('padding-top', '${px}px', 'important');
  s.style.setProperty('padding-bottom', '${px}px', 'important');
  return true;
})()`;

async function run() {
  const win = new BrowserWindow({
    width: OUT_W,
    height: OUT_H,
    show: false,
    frame: false,
    useContentSize: true,
    backgroundColor: "#ffffff",
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(FPS);

  await win.loadFile(SITE);
  await wait(1600);
  win.webContents.setZoomFactor(ZOOM);
  await win.webContents.executeJavaScript(PREP);
  await wait(500);

  // With no padding of its own, how tall is the section? The rest of the frame
  // becomes its padding, so the capture is exactly 16:9 with nothing cropped.
  let box = await win.webContents.executeJavaScript(MEASURE);
  const targetCss = band / ZOOM;
  // A section taller than the band eats into the bottom margin; cropping it
  // would cut the box's own border off.
  if (box.h * ZOOM > band) band = Math.min(OUT_H - SAFE_TOP, Math.round(box.h * ZOOM));
  const pad = Math.max(0, Math.round((band / ZOOM - box.h) / 2));
  await win.webContents.executeJavaScript(padTo(pad));
  await wait(600);
  box = await win.webContents.executeJavaScript(MEASURE);

  // Size the window to the section so nothing else can enter the frame.
  const winH = Math.round(box.h * ZOOM);
  win.setContentSize(OUT_W, winH);
  await wait(900);
  box = await win.webContents.executeJavaScript(MEASURE);
  console.log(
    `layout ${VW}css zoom ${ZOOM.toFixed(4)} content ${box.h}css pad ${pad}css -> band ${OUT_W}x${band} top ${SAFE_TOP} bottom ${OUT_H - SAFE_TOP - band}`
  );

  await win.webContents.executeJavaScript(`window.scrollTo(0, ${Math.max(0, box.top - box.h)})`);
  await wait(2500);
  await win.webContents.executeJavaScript(`window.scrollTo(0, ${box.top})`);

  // Paint events arrive at the window's pixel size (capturePage would hand back
  // 2x), so stills and video frames come from the same buffer.
  let latestImage = null;
  let latestBitmap = null;
  win.webContents.on("paint", (_e, _dirty, image) => {
    latestImage = image;
    latestBitmap = image.toBitmap();
  });
  while (!latestBitmap) await wait(20);
  const frame = latestImage.getSize();
  console.log("frame", JSON.stringify(frame));

  if (mode === "still") {
    const marks = times.length ? times : [WARMUP / 1000];
    let last = 0;
    for (const t of marks) {
      await wait(Math.max(0, t * 1000 - last));
      last = t * 1000;
      writeFileSync(join(OUT, `still-${t.toFixed(2)}.png`), latestImage.toPNG());
      console.log("still", t);
    }
    win.destroy();
    return;
  }

  const seconds = times[0] || 19.3;
  const rawFile = join(OUT, "capture-raw.mp4");
  const outFile = join(OUT, "compare-9x16.mp4");

  // Two passes: the live one has to keep up with 30fps of raw BGRA, so it encodes
  // as fast as x264 can (near-lossless); the finished file is made from that.
  const ff = spawn(
    "ffmpeg",
    ["-y", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${frame.width}x${frame.height}`,
     "-r", String(FPS), "-i", "-", "-an",
     "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv444p", rawFile],
    { stdio: ["pipe", "inherit", "inherit"] }
  );

  await wait(WARMUP);

  const total = Math.round(seconds * FPS);
  const t0 = Date.now();
  let late = 0;
  for (let i = 0; i < total; i++) {
    const lag = t0 + (i * 1000) / FPS - Date.now();
    if (lag > 0) await wait(lag);
    else if (lag < -50) late++;
    if (!ff.stdin.write(latestBitmap)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log("captured", total, "frames in", ((Date.now() - t0) / 1000).toFixed(2) + "s", "late", late);

  // Trim or letterbox by whatever the section missed 16:9 by - single digits.
  const crop = `crop=${frame.width}:${Math.min(frame.height, band)}`;
  const pad2 = `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:${SAFE_TOP}:color=white`;
  await new Promise((resolve, reject) => {
    const enc = spawn(
      "ffmpeg",
      ["-y", "-i", rawFile, "-vf", `${crop},${pad2}`,
       "-c:v", "libx264", "-preset", "slow", "-crf", "18",
       "-pix_fmt", "yuv420p", "-movflags", "+faststart", outFile],
      { stdio: ["ignore", "ignore", "inherit"] }
    );
    enc.on("close", (code) => (code === 0 ? resolve() : reject(new Error("encode failed " + code))));
  });
  win.destroy();
  rmSync(rawFile, { force: true });
  console.log("video", outFile);
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    console.error("ERR", e);
  }
  app.quit();
});
