// Scout: render the #compare section at a few widths so the vertical framing is
// chosen against the real responsive layout. Offscreen so the window can be
// taller than the display.
import { app, BrowserWindow } from "electron";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "..", "index.html");
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const widths = process.argv.slice(2).map(Number).filter(Boolean);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(width) {
  const win = new BrowserWindow({
    width,
    height: Number(process.env.SCOUT_H || 1920),
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(30);
  await win.loadFile(SITE);
  await wait(2500);
  const rect = await win.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('.compare-section');
    s.scrollIntoView({ block: 'start' });
    return new Promise((res) => setTimeout(() => {
      const r = s.getBoundingClientRect();
      res({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    }, 400));
  })()`);
  await wait(3200);
  console.log("rect", JSON.stringify(rect));
  const img = await win.webContents.capturePage();
  writeFileSync(join(OUT, `scout-${width}.png`), img.toPNG());
  console.log(width, JSON.stringify(rect), img.getSize());
  win.destroy();
}

app.whenReady().then(async () => {
  try {
    for (const w of widths) await shoot(w);
  } catch (e) {
    console.error("ERR", e);
  }
  app.quit();
});
