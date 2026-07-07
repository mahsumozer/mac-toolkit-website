import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
// Intro scene: left-click the icon to reveal the quick-tools popover, then the
// rest of the tour is shifted later by this much so the existing beats are untouched.
const INTRO = 1.9;
const DURATION = 13.2 + INTRO;
// Linger on key beats so the switch reads slower.
const HOLDS = [
  [1.6, 0.9], // Quick-tools popover open — let it read
  [1.9 + INTRO, 0.7], // Context menu just opened
  [3.7 + INTRO, 0.4], // App window just opened (cursor parked on the menu item)
];
const TOTAL_HOLD = HOLDS.reduce((sum, [, d]) => sum + d, 0);
const FRAMES = Math.round(FPS * (DURATION + TOTAL_HOLD));
function storyTime(outT) {
  let acc = 0;
  for (const [s0, dur] of HOLDS) {
    const outStart = s0 + acc;
    if (outT < outStart) return outT - acc;
    if (outT < outStart + dur) return s0;
    acc += dur;
  }
  return outT - acc;
}
const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "marketing-video-window", "out");
const VIDEO_OUT = join(OUT_DIR, "mac-kit-window-promo.mp4");
const POSTER_OUT = join(OUT_DIR, "mac-kit-window-poster.png");

const orange = "#ff9f1c";
const ink = "#f7f3ea";
const mono = "SFMono-Regular, Menlo, monospace";
const sans = "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const PICK_HEX = "#5AA9FF";

// ---- Menu bar / icon ----
const MB_H = 40;
const ICON_CX = 1700;
const ICON_CY = 20;

// ---- Browser window (background decor) ----
const BX = 180;
const BY = 150;
const BW = 760;
const BH = 420;
const HERO_CX = 460;
const HERO_CY = 496;

// ---- Context menu ----
const MENU_X = 1466;
const MENU_W = 254;
const MENU_Y = 46;
const MENU_ROW = 40;
const MENU_PAD = 7;
const MENU_SEP = 12;
const MENU_ITEMS = [
  { label: "Open Full View" },
  { label: "Open in Window", hot: true },
  { label: "Settings" },
  { sep: true },
  { label: "Quit Mac Kit" },
];
const MENU_OPEN = 1.4 + INTRO;
const MENU_CLOSE = 3.35 + INTRO;

// ---- App window ----
const WIN_SCALE = 1.35;
const WX = 380;
const WY = 108;
const WIN_OPEN = 3.4 + INTRO;

// ---- Sidebar nav tour ----
// [storyTime, page] — page swaps to the given sidebar item.
const NAV = [
  [3.4 + INTRO, "home"],
  [4.7 + INTRO, "screenshot"],
  [6.6 + INTRO, "color"],
  [8.5 + INTRO, "pomodoro"],
];
// Index of each page inside the sidebar nav list (for the active pill position).
const PAGE_IDX = { home: 0, screenshot: 1, color: 7, pomodoro: 8 };

// Window palette (from src/styles/global.css)
const W_BG = "rgba(26,26,31,0.9)";
const W_SIDE = "rgba(0,0,0,0.16)";
const W_BORDER = "rgba(255,255,255,0.09)";
const W_T1 = "rgba(247,247,250,0.92)";
const W_T2 = "rgba(255,255,255,0.55)";
const W_T3 = "rgba(255,255,255,0.35)";
const W_ACCENT = "#ff9f1c";
const W_ACCENT_SUB = "rgba(255,159,28,0.16)";
const W_CARD = "rgba(255,255,255,0.04)";
const W_CARDB = "rgba(255,255,255,0.08)";
const W_GREEN = "#22c55e";

// ---- Math helpers ----
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}
function between(t, start, end) {
  return clamp((t - start) / (end - start));
}
function easeOutCubic(x) {
  return 1 - Math.pow(1 - clamp(x), 3);
}
function easeOutBack(x) {
  x = clamp(x);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
function easeInOutCubic(x) {
  x = clamp(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
function lerp(a, b, p) {
  return a + (b - a) * p;
}
function fade(t, start, end, outStart = null, outEnd = null) {
  const inP = easeOutCubic(between(t, start, end));
  if (outStart == null || outEnd == null) return inP;
  return inP * (1 - easeOutCubic(between(t, outStart, outEnd)));
}

// ---- SVG helpers ----
function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function text(content, x, y, size, opts = {}) {
  const {
    fill = ink,
    weight = 700,
    anchor = "start",
    opacity = 1,
    spacing = 0,
    family = sans,
  } = opts;
  return `<text x="${x}" y="${y}" fill="${fill}" opacity="${opacity}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${spacing}" font-family="${family}">${esc(content)}</text>`;
}
function bolt(x, y, size = 26, color = orange, opacity = 1) {
  const s = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})" opacity="${opacity}">
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" fill="${color}"/>
  </g>`;
}
function icon(x, y, size, color, body) {
  const s = size / 20;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}
function iconClipboard(x, y, size = 18, color = orange) {
  return icon(x, y, size, color, `<rect x="3" y="4" width="14" height="15" rx="3"/><path d="M7 4 V2.5 A1.5 1.5 0 0 1 8.5 1 H11.5 A1.5 1.5 0 0 1 13 2.5 V4 Z" fill="${color}"/>`);
}
function iconCamera(x, y, size = 18, color = orange) {
  return icon(x, y, size, color, `<rect x="1.5" y="5" width="17" height="12.5" rx="3"/><path d="M6.5 5 L8 2.5 H12 L13.5 5"/><circle cx="10" cy="11.2" r="3.2"/>`);
}
function iconDroplet(x, y, size = 18, color = orange) {
  return icon(x, y, size, color, `<path d="M10 2 C6 8 5 11 5 13 A5 5 0 0 0 15 13 C15 11 14 8 10 2 Z"/>`);
}
function iconTimer(x, y, size = 18, color = orange) {
  return icon(x, y, size, color, `<circle cx="10" cy="12" r="6.6"/><line x1="10" y1="12" x2="10" y2="8"/><line x1="8" y1="2" x2="12" y2="2"/><line x1="10" y1="2" x2="10" y2="5.4"/>`);
}
function iconCopy(x, y, size = 15, color = "#98949e") {
  return icon(x, y, size, color, `<rect x="7" y="7" width="9" height="9" rx="2"/><path d="M4.5 12.5 H4 A1.5 1.5 0 0 1 2.5 11 V4 A1.5 1.5 0 0 1 4 2.5 H11 A1.5 1.5 0 0 1 12.5 4 V4.5"/>`);
}
function iconHome(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M3 9.5 L10 3.5 L17 9.5"/><path d="M5 8.5 V16.5 H15 V8.5"/>`);
}
function iconCpu(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<rect x="5" y="5" width="10" height="10" rx="2"/><rect x="8" y="8" width="4" height="4"/><line x1="8" y1="2.5" x2="8" y2="5"/><line x1="12" y1="2.5" x2="12" y2="5"/><line x1="8" y1="15" x2="8" y2="17.5"/><line x1="12" y1="15" x2="12" y2="17.5"/><line x1="2.5" y1="8" x2="5" y2="8"/><line x1="2.5" y1="12" x2="5" y2="12"/><line x1="15" y1="8" x2="17.5" y2="8"/><line x1="15" y1="12" x2="17.5" y2="12"/>`);
}
function iconCoffee(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M4 8 H14 V13 A4 4 0 0 1 10 17 H8 A4 4 0 0 1 4 13 Z"/><path d="M14 9 H16 A2 2 0 0 1 16 13 H14"/><line x1="7" y1="3" x2="7" y2="5"/><line x1="10.5" y1="3" x2="10.5" y2="5"/>`);
}
function iconFilePlus(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M6 2.5 H11 L15 6.5 V17 H5 V2.5 Z"/><path d="M11 2.5 V6.5 H15"/><line x1="10" y1="9.5" x2="10" y2="14"/><line x1="7.75" y1="11.75" x2="12.25" y2="11.75"/>`);
}
function iconConvert(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M6 5 L3 8 L6 11"/><line x1="3" y1="8" x2="16" y2="8"/><path d="M14 9 L17 12 L14 15"/><line x1="4" y1="12" x2="17" y2="12"/>`);
}
function iconBrush(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M11 3 L17 9 L11 12"/><path d="M4 16 C4 13 5.5 11.5 8 11.5 C9 11.5 10.5 12.5 10.5 14 C10.5 16 7.5 16.5 4 16 Z"/>`);
}
function iconGear(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<circle cx="10" cy="10" r="3"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18"/><line x1="2" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18" y2="10"/><line x1="4.3" y1="4.3" x2="5.7" y2="5.7"/><line x1="14.3" y1="14.3" x2="15.7" y2="15.7"/><line x1="15.7" y1="4.3" x2="14.3" y2="5.7"/><line x1="5.7" y1="14.3" x2="4.3" y2="15.7"/>`);
}
function iconChevron(x, y, size = 18, color = W_T3) {
  return icon(x, y, size, color, `<line x1="4" y1="4" x2="4" y2="16"/><path d="M13 5 L8 10 L13 15"/>`);
}
function iconPencil(x, y, size = 14, color = W_T2) {
  return icon(x, y, size, color, `<path d="M14 3 L17 6 L7 16 L4 16 L4 13 Z"/><line x1="12" y1="5" x2="15" y2="8"/>`);
}
function iconPlusW(x, y, size = 16, color = W_T1) {
  return icon(x, y, size, color, `<line x1="10" y1="5" x2="10" y2="15"/><line x1="5" y1="10" x2="15" y2="10"/>`);
}
function iconMinusW(x, y, size = 16, color = W_T1) {
  return icon(x, y, size, color, `<line x1="5" y1="10" x2="15" y2="10"/>`);
}
function iconCrop(x, y, size = 20, color = W_ACCENT) {
  return icon(x, y, size, color, `<path d="M5 2 V13 A2 2 0 0 0 7 15 H18"/><path d="M15 18 V7 A2 2 0 0 0 13 5 H2"/>`);
}
function iconAppWindow(x, y, size = 20, color = W_ACCENT) {
  return icon(x, y, size, color, `<rect x="2.5" y="4" width="15" height="12" rx="2.5"/><line x1="2.5" y1="8" x2="17.5" y2="8"/>`);
}
function iconVideo(x, y, size = 20, color = "#ef4444") {
  return icon(x, y, size, color, `<rect x="2.5" y="6" width="11" height="8" rx="2"/><path d="M13.5 9 L18 6.5 V13.5 L13.5 11 Z"/>`);
}
function iconReset(x, y, size = 20, color = W_T2) {
  return icon(x, y, size, color, `<path d="M4 10 A6 6 0 1 1 5.5 14"/><path d="M4 6 V10 H8"/>`);
}
function iconSkip(x, y, size = 20, color = W_T2) {
  return icon(x, y, size, color, `<path d="M5 5 L12 10 L5 15 Z"/><line x1="14" y1="5" x2="14" y2="15"/>`);
}

// ---- Defs / wallpaper ----
function defs() {
  return `<defs>
    <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2a3a6b"/>
      <stop offset="42%" stop-color="#5b3f8f"/>
      <stop offset="72%" stop-color="#a24d7a"/>
      <stop offset="100%" stop-color="#e08a4c"/>
    </linearGradient>
    <radialGradient id="wallGlow" cx="72%" cy="26%" r="60%">
      <stop offset="0%" stop-color="#ffd9a0" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#ffd9a0" stop-opacity="0"/>
    </radialGradient>
    <filter id="winShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="30" stdDeviation="42" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    <filter id="popShadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="20" stdDeviation="30" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
    <radialGradient id="ctaGlow" cx="50%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#f5941d" stop-opacity="0.13"/>
      <stop offset="100%" stop-color="#f5941d" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="btnGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#f5941d" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#f5941d" stop-opacity="0"/>
    </radialGradient>
    <filter id="ctaShadow" x="-60%" y="-60%" width="220%" height="240%">
      <feDropShadow dx="0" dy="14" stdDeviation="24" flood-color="#050505" flood-opacity="0.22"/>
    </filter>
    <linearGradient id="photoSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd9a0"/>
      <stop offset="55%" stop-color="#ff9a62"/>
      <stop offset="100%" stop-color="#b0526e"/>
    </linearGradient>
    <clipPath id="photoClip"><rect x="92" y="656" width="436" height="302" rx="8"/></clipPath>
  </defs>`;
}
function wallpaper(t) {
  const bx = 1400 + Math.sin(t * 0.3) * 60;
  const by = 300 + Math.cos(t * 0.35) * 40;
  return `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#wall)"/>
    <ellipse cx="${bx}" cy="${by}" rx="620" ry="520" fill="url(#wallGlow)"/>
    <circle cx="360" cy="880" r="360" fill="#ffffff" opacity="0.05"/>
    <path d="M0 940 C 460 880 720 1010 1120 930 S 1620 830 1920 910 V1080 H0Z" fill="rgba(255,255,255,0.05)"/>`;
}

function menuState(t) {
  return easeOutCubic(between(t, MENU_OPEN, MENU_OPEN + 0.2)) * (1 - easeOutCubic(between(t, MENU_CLOSE, MENU_CLOSE + 0.16)));
}
function winState(t) {
  return easeOutCubic(between(t, WIN_OPEN, WIN_OPEN + 0.45));
}
function navIndex(t) {
  let i = 0;
  for (let k = 0; k < NAV.length; k += 1) if (t >= NAV[k][0]) i = k;
  return i;
}
function activePage(t) {
  return NAV[navIndex(t)][1];
}
function navRowTop(page) {
  return 90 + PAGE_IDX[page] * 36;
}
const NAV_XFADE = 0.34; // page + pill crossfade duration
// The accent pill glides from the previous row to the new one after each switch.
function activePillY(t) {
  const i = navIndex(t);
  const curTop = navRowTop(NAV[i][1]);
  if (i === 0) return curTop;
  const prevTop = navRowTop(NAV[i - 1][1]);
  const p = easeInOutCubic(between(t, NAV[i][0], NAV[i][0] + NAV_XFADE));
  return lerp(prevTop, curTop, p);
}
// 0..1 blend from the previous page to the current one across a switch.
function navBlend(t) {
  const i = navIndex(t);
  if (i === 0) return 1;
  return easeInOutCubic(between(t, NAV[i][0], NAV[i][0] + NAV_XFADE));
}

// ---- Quick-tools popover (left-click on the tray icon) ----
const POP_OPEN = 1.05;
const POP_CLOSE = 2.4;
function popState(t) {
  return easeOutCubic(between(t, POP_OPEN, POP_OPEN + 0.22)) * (1 - easeOutCubic(between(t, POP_CLOSE, POP_CLOSE + 0.18)));
}
function lightPopover(t) {
  const op = popState(t);
  if (op <= 0) return "";
  const PX = 640, PY = 48, PW = 760, PH = 478;
  const POP_DX = ICON_CX - 1300;
  const CDX = 16, CDY = PY - 95;
  const muted = "#aaa5b2";
  const scale = lerp(0.94, 1, easeOutBack(op));
  const dy = lerp(-16, 0, easeOutCubic(op));
  const originX = ICON_CX;
  const originY = PY;

  const rows = [
    "https://mackit.rojhot.com",
    "~/Desktop/region.png",
    PICK_HEX,
    "hello@rojhot.com",
    "Meeting notes",
  ];
  const clip = rows.map((item, i) => {
    const y = 168 + i * 44;
    return `<rect x="664" y="${y}" width="296" height="34" rx="9" fill="rgba(0,0,0,0.24)" stroke="rgba(255,255,255,0.09)"/>
      ${text(item, 680, y + 22, 15, { weight: 600, fill: "#c8c3cd", family: mono })}
      ${iconCopy(936, y + 10, 15, "#8f8b96")}`;
  }).join("");

  const shotBtns = [["Full", 1040, 160], ["Area", 1206, 160], ["Window", 1040, 204], ["Record", 1206, 204]]
    .map(([l, x, y]) => `<rect x="${x}" y="${y}" width="150" height="34" rx="10" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.12)"/>
        ${text(l, x + 75, y + 22, 16, { anchor: "middle", weight: 800, fill: "#d9d5dc" })}`).join("");

  const popBg = "rgba(60,60,63,0.72)";
  const cardBg = "rgba(255,255,255,0.05)";
  const cardBorder = "rgba(255,255,255,0.1)";
  return `<g opacity="${op}" filter="url(#popShadow)" transform="translate(${originX} ${originY}) scale(${scale}) translate(${-originX} ${-originY + dy})">
    <g transform="translate(${POP_DX} 0)">
    <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="22" fill="${popBg}" stroke="rgba(255,255,255,0.14)"/>
    <g transform="translate(${CDX} ${CDY})">

    <!-- Clipboard -->
    <rect x="648" y="112" width="328" height="300" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${iconClipboard(666, 126, 19)}
    ${text("Clipboard", 694, 144, 20, { weight: 800 })}
    ${clip}

    <!-- Pomodoro -->
    <rect x="648" y="428" width="328" height="128" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${iconTimer(666, 442, 19)}
    ${text("Pomodoro", 694, 460, 20, { weight: 800 })}
    <circle cx="672" cy="494" r="5" fill="#ff4d4d"/>
    ${text("WORK", 690, 500, 15, { weight: 800, fill: muted, spacing: 3 })}
    ${text("25:00", 952, 502, 30, { anchor: "end", weight: 900, fill: orange, family: mono })}
    <rect x="664" y="516" width="32" height="34" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>
    ${iconMinusW(671, 523, 18, "#d9d5dc")}
    <rect x="702" y="516" width="220" height="34" rx="10" fill="${orange}"/>
    ${text("Start", 812, 539, 17, { anchor: "middle", weight: 900, fill: "#16131a" })}
    <rect x="928" y="516" width="32" height="34" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>
    ${iconPlusW(935, 523, 18, "#d9d5dc")}

    <g transform="translate(-16 0)">
    <!-- Screenshot -->
    <rect x="1016" y="112" width="360" height="154" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${iconCamera(1034, 126, 19)}
    ${text("Screenshot", 1062, 144, 20, { weight: 800 })}
    ${shotBtns}

    <!-- Color Picker -->
    <rect x="1016" y="282" width="360" height="224" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${iconDroplet(1034, 296, 19)}
    ${text("Color Picker", 1062, 314, 20, { weight: 800 })}
    <rect x="1040" y="330" width="48" height="48" rx="11" fill="${PICK_HEX}" stroke="rgba(255,255,255,0.18)"/>
    ${text(PICK_HEX, 1104, 364, 26, { weight: 900, family: mono })}
    ${["HEX", "RGB", "HSL"].map((l, i) => `<rect x="${1040 + i * 108}" y="394" width="96" height="34" rx="9" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.1)"/>${text(l, 1088 + i * 108, 416, 14, { anchor: "middle", weight: 900, fill: "#d9d5dc", spacing: 2 })}`).join("")}
    <rect x="1040" y="440" width="312" height="44" rx="12" fill="${orange}"/>
    ${text("Pick Color", 1196, 468, 17, { anchor: "middle", weight: 900, fill: "#16131a" })}

    <!-- Add widget -->
    <rect x="1340" y="520" width="36" height="36" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>
    ${iconPlusW(1349, 529, 18, "#d9d5dc")}
    </g>
    </g>
    </g>
  </g>`;
}

// ---- Menu bar ----
function menuBar(t) {
  const iconHot = menuState(t) > 0.05 || popState(t) > 0.05;
  // attention ping guiding the eye to the menu-bar icon before the cursor arrives
  const gEnv = fade(t, 0.15, 0.5, 1.0, 1.25);
  let guide = "";
  if (gEnv > 0.01) {
    const ph = (t / 0.9) % 1;
    const pr = 15 + ph * 15;
    const pOp = (1 - ph) * 0.65 * gEnv;
    guide = `<circle cx="${ICON_CX}" cy="20" r="17" fill="${W_ACCENT}" opacity="${(0.14 * gEnv).toFixed(3)}"/>`
      + `<circle cx="${ICON_CX}" cy="20" r="${pr.toFixed(1)}" fill="none" stroke="${W_ACCENT}" stroke-width="2.5" opacity="${pOp.toFixed(3)}"/>`;
  }
  return `<g>
    <rect x="0" y="0" width="${WIDTH}" height="${MB_H}" fill="rgba(20,20,26,0.55)"/>
    <line x1="0" y1="${MB_H}" x2="${WIDTH}" y2="${MB_H}" stroke="rgba(255,255,255,0.08)"/>
    ${text("Finder", 40, 26, 18, { weight: 800, fill: "#ffffff" })}
    ${text("File", 128, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    ${text("Edit", 188, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    ${text("View", 248, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    ${guide}
    <rect x="${ICON_CX - 18}" y="4" width="36" height="32" rx="9" fill="${iconHot ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0)"}"/>
    ${bolt(ICON_CX - 11, ICON_CY - 12, 24, "#ffffff")}
    ${text("94%", 1745, 26, 17, { weight: 700, fill: ink })}
    ${text("3:51 PM", 1812, 26, 17, { weight: 700, fill: ink })}
  </g>`;
}

// ---- Desktop side windows (decor) ----
function deskWindows(t) {
  const op = fade(t, 0.2, 0.9, 8.4, 9.2);
  if (op <= 0) return "";
  const bar = (x, y, w, fill = "#cfcad8") => `<rect x="${x}" y="${y}" width="${w}" height="8" rx="4" fill="${fill}"/>`;
  return `<g opacity="${op}">
    <g filter="url(#winShadow)">
      <rect x="80" y="620" width="460" height="350" rx="14" fill="#ffffff"/>
      <circle cx="104" cy="638" r="6" fill="#ff5f57"/>
      <circle cx="124" cy="638" r="6" fill="#febc2e"/>
      <circle cx="144" cy="638" r="6" fill="#28c840"/>
      ${text("sunset.jpg", 310, 643, 13, { anchor: "middle", weight: 700, fill: "#6b6675" })}
      <g clip-path="url(#photoClip)">
        <rect x="92" y="656" width="436" height="302" fill="url(#photoSky)"/>
        <circle cx="430" cy="740" r="56" fill="#fff3d6" opacity="0.3"/>
        <circle cx="430" cy="740" r="30" fill="#fff3d6"/>
        <path d="M60 958 L235 760 L390 958 Z" fill="#6e3d63" opacity="0.85"/>
        <path d="M240 958 L400 790 L560 958 Z" fill="#472a4e"/>
        <rect x="92" y="912" width="436" height="46" fill="#3c2447" opacity="0.65"/>
      </g>
    </g>
    <g filter="url(#winShadow)">
      <rect x="1250" y="580" width="590" height="380" rx="14" fill="#ffffff"/>
      <circle cx="1274" cy="598" r="6" fill="#ff5f57"/>
      <circle cx="1294" cy="598" r="6" fill="#febc2e"/>
      <circle cx="1314" cy="598" r="6" fill="#28c840"/>
      ${text("AI Chat", 1545, 603, 13, { anchor: "middle", weight: 700, fill: "#6b6675" })}
      <path d="M1250 616 H1400 V960 H1264 A14 14 0 0 1 1250 946 Z" fill="#f4f2f8"/>
      <rect x="1262" y="630" width="126" height="30" rx="9" fill="#1a1a22"/>
      ${text("New chat", 1325, 650, 13, { anchor: "middle", weight: 700, fill: "#ffffff" })}
      ${[0, 1, 2, 3].map((i) => bar(1264, 684 + i * 30, i % 2 ? 92 : 114)).join("")}
      <rect x="1614" y="644" width="196" height="40" rx="12" fill="#dcebff"/>
      ${bar(1630, 660, 160, "#8ab2e0")}
      <circle cx="1432" cy="716" r="12" fill="#3fb68b"/>
      <path d="M1427 716 l4 4 l7 -8" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="1456" y="700" width="334" height="86" rx="12" fill="#f4f2f8"/>
      ${bar(1472, 716, 296)}
      ${bar(1472, 736, 302)}
      ${bar(1472, 756, 208)}
      <rect x="1662" y="806" width="148" height="40" rx="12" fill="#dcebff"/>
      ${bar(1678, 822, 112, "#8ab2e0")}
      <rect x="1416" y="884" width="394" height="44" rx="22" fill="#ffffff" stroke="#d6d3dd"/>
      ${text("Ask anything…", 1438, 911, 13, { weight: 600, fill: "#9a95a4" })}
      <circle cx="1786" cy="906" r="14" fill="#1a1a22"/>
      <path d="M1786 912 v-12 m-5 5 l5 -5 l5 5" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </g>`;
}

// ---- Browser window (background decor) ----
function browserWindow(t) {
  const op = fade(t, 0.3, 1.0, 8.4, 9.2);
  if (op <= 0) return "";
  const cy = BY + 44;
  const cx = BX + BW / 2;
  return `<g opacity="${op}" filter="url(#winShadow)">
    <rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="20" fill="#ffffff"/>
    <rect x="${BX}" y="${BY}" width="${BW}" height="44" rx="20" fill="#eceaf0"/>
    <rect x="${BX}" y="${BY + 22}" width="${BW}" height="22" fill="#eceaf0"/>
    <circle cx="${BX + 26}" cy="${BY + 22}" r="7" fill="#ff5f57"/>
    <circle cx="${BX + 48}" cy="${BY + 22}" r="7" fill="#febc2e"/>
    <circle cx="${BX + 70}" cy="${BY + 22}" r="7" fill="#28c840"/>
    <rect x="${BX + 150}" y="${BY + 12}" width="${BW - 300}" height="24" rx="12" fill="#ffffff" stroke="#d6d3dd"/>
    ${text("mackit.rojhot.com", cx, BY + 29, 15, { anchor: "middle", weight: 600, fill: "#6b6675", family: mono })}
    <path d="M${BX} ${cy} H${BX + BW} V${BY + BH - 20} A20 20 0 0 1 ${BX + BW - 20} ${BY + BH} H${BX + 20} A20 20 0 0 1 ${BX} ${BY + BH - 20} Z" fill="#ffffff"/>
    <rect x="${BX + 36}" y="${cy + 14}" width="26" height="26" rx="7" fill="#ffffff" stroke="#dcd8e2"/>
    ${bolt(BX + 41, cy + 17, 16, "#16131a")}
    ${text("Mac Kit", BX + 72, cy + 33, 18, { weight: 900, fill: "#1a1a22" })}
    ${text("Features", BX + 460, cy + 32, 14, { weight: 600, fill: "#6b6675" })}
    ${text("Pricing", BX + 545, cy + 32, 14, { weight: 600, fill: "#6b6675" })}
    <rect x="${BX + 620}" y="${cy + 10}" width="104" height="34" rx="17" fill="#1a1a22"/>
    ${text("Download", BX + 672, cy + 32, 14, { anchor: "middle", weight: 700, fill: "#ffffff" })}
    <line x1="${BX}" y1="${cy + 56}" x2="${BX + BW}" y2="${cy + 56}" stroke="#eceaf0" stroke-width="1.5"/>
    <rect x="${cx - 104}" y="${cy + 92}" width="208" height="28" rx="14" fill="#fdf2e2" stroke="#f3ddba"/>
    ${text("New · Pomodoro timer", cx, cy + 111, 13, { anchor: "middle", weight: 800, fill: "#b06a10" })}
    ${text("Everyday Mac tools,", cx, cy + 170, 38, { anchor: "middle", weight: 900, fill: "#1a1a22" })}
    ${text("one menu bar away.", cx, cy + 216, 38, { anchor: "middle", weight: 900, fill: "#f5941d" })}
    ${text("Screenshots, clipboard, color picker & pomodoro — one click away.", cx, cy + 252, 16, { anchor: "middle", weight: 600, fill: "#6b6675" })}
    <rect x="${HERO_CX - 90}" y="${HERO_CY - 24}" width="180" height="48" rx="12" fill="${PICK_HEX}"/>
    ${text("Get Mac Kit", HERO_CX, HERO_CY + 6, 17, { anchor: "middle", weight: 800, fill: "#ffffff" })}
    <rect x="${cx + 10}" y="${HERO_CY - 24}" width="180" height="48" rx="12" fill="#ffffff" stroke="#d6d3dd"/>
    ${text("See features", cx + 100, HERO_CY + 6, 17, { anchor: "middle", weight: 800, fill: "#1a1a22" })}
  </g>`;
}

// ---- Context menu (right-click on the tray icon) ----
function contextMenu(t) {
  const op = menuState(t);
  if (op <= 0) return "";
  const hotOn = t > 2.55 + INTRO && t < 3.4 + INTRO;
  const grow = lerp(0.92, 1, easeOutCubic(op));
  let y = MENU_Y + MENU_PAD;
  let rows = "";
  for (const it of MENU_ITEMS) {
    if (it.sep) {
      rows += `<line x1="${MENU_X + 12}" y1="${y + MENU_SEP / 2}" x2="${MENU_X + MENU_W - 12}" y2="${y + MENU_SEP / 2}" stroke="rgba(255,255,255,0.1)"/>`;
      y += MENU_SEP;
      continue;
    }
    const highlight = it.hot && hotOn;
    if (highlight) {
      rows += `<rect x="${MENU_X + 6}" y="${y + 2}" width="${MENU_W - 12}" height="${MENU_ROW - 4}" rx="7" fill="${W_ACCENT}"/>`;
    }
    rows += text(it.label, MENU_X + 20, y + MENU_ROW / 2 + 6, 18, { weight: 500, fill: highlight ? "#16131a" : W_T1 });
    y += MENU_ROW;
  }
  const menuH = y + MENU_PAD - MENU_Y;
  const ox = MENU_X + MENU_W;
  const oy = MENU_Y;
  return `<g opacity="${op}" transform="translate(${ox} ${oy}) scale(${grow}) translate(${-ox} ${-oy})" filter="url(#popShadow)">
    <rect x="${MENU_X}" y="${MENU_Y}" width="${MENU_W}" height="${menuH}" rx="12" fill="rgba(40,40,46,0.92)" stroke="rgba(255,255,255,0.14)"/>
    ${rows}
  </g>`;
}

// ---- App window (standalone) drawn in local 860x616 coords ----
function winCard(x, y, w, h) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${W_CARD}" stroke="${W_CARDB}"/>`;
}
function cardHeader(x, y, iconFn, title) {
  return `<rect x="${x + 14}" y="${y + 14}" width="22" height="22" rx="6" fill="${W_ACCENT_SUB}"/>`
    + iconFn(x + 17, y + 17, 16, W_ACCENT)
    + text(title, x + 46, y + 30, 12, { weight: 600, fill: W_T2 });
}
function statRow(x, y, w, label, val, pct, color) {
  return text(label, x, y, 11, { weight: 600, fill: W_T3 })
    + text(val, x + w, y, 11, { weight: 700, fill: W_T1, anchor: "end" })
    + `<rect x="${x}" y="${y + 6}" width="${w}" height="5" rx="2.5" fill="rgba(255,255,255,0.08)"/>`
    + `<rect x="${x}" y="${y + 6}" width="${w * pct}" height="5" rx="2.5" fill="${color}"/>`;
}
function cardSystemStats(x, y, w, h, t) {
  const cx = x + 16;
  const cw = w - 32;
  // live monitor: stats drift gently while the dashboard is on screen
  const cpu = 34 + Math.round(4 * Math.sin((t - (3.3 + INTRO)) * 2.4));
  const ram = 61 + Math.round(2 * Math.sin((t - (3.3 + INTRO)) * 1.7));
  return winCard(x, y, w, h)
    + cardHeader(x, y, iconCpu, "System Stats")
    + statRow(cx, y + 58, cw, "CPU", `${cpu}%`, cpu / 100, W_ACCENT)
    + statRow(cx, y + 96, cw, "RAM", `${ram}%`, ram / 100, W_GREEN)
    + text("Uptime", cx, y + 134, 11, { weight: 600, fill: W_T3 })
    + text("4h 12m", cx + cw, y + 134, 11, { weight: 700, fill: W_T1, anchor: "end" });
}
function cardClipboard(x, y, w, h) {
  const items = ["https://mackit.rojhot.com", "#3B82F6", "Meeting notes 2pm"];
  const rows = items.map((it, i) => {
    const ry = y + 48 + i * 34;
    return `<rect x="${x + 14}" y="${ry}" width="${w - 28}" height="28" rx="8" fill="rgba(0,0,0,0.2)" stroke="rgba(255,255,255,0.07)"/>`
      + text(it, x + 26, ry + 19, 12, { weight: 600, fill: "#c8c3cd", family: mono })
      + iconCopy(x + w - 42, ry + 7, 14, "#8f8b96");
  }).join("");
  return winCard(x, y, w, h) + cardHeader(x, y, iconClipboard, "Clipboard") + rows;
}
function cardScreenshot(x, y, w, h) {
  const labels = [["Full", 0, 0], ["Area", 1, 0], ["Window", 0, 1], ["Record", 1, 1]];
  const bw = 128;
  const bh = 36;
  const btns = labels.map(([l, col, row]) => {
    const bx = x + 16 + col * (bw + 12);
    const by = y + 50 + row * (bh + 10);
    return `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="9" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)"/>`
      + text(l, bx + bw / 2, by + 23, 13, { anchor: "middle", weight: 700, fill: W_T1 });
  }).join("");
  return winCard(x, y, w, h) + cardHeader(x, y, iconCamera, "Screenshot") + btns;
}
function cardColor(x, y, w, h) {
  const cx = x + 16;
  const pills = ["HEX", "RGB", "HSL"].map((l, i) => {
    const px = cx + i * 90;
    return `<rect x="${px}" y="${y + 106}" width="82" height="30" rx="8" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.1)"/>`
      + text(l, px + 41, y + 126, 12, { anchor: "middle", weight: 800, fill: W_T2, spacing: 1 });
  }).join("");
  return winCard(x, y, w, h)
    + cardHeader(x, y, iconDroplet, "Color Picker")
    + `<rect x="${cx}" y="${y + 52}" width="40" height="40" rx="10" fill="${PICK_HEX}" stroke="rgba(255,255,255,0.18)"/>`
    + text(PICK_HEX, cx + 54, y + 78, 22, { weight: 900, fill: W_T1, family: mono })
    + pills;
}
function cardPomodoro(x, y, w, h) {
  const cx = x + 20;
  return winCard(x, y, w, h)
    + cardHeader(x, y, iconTimer, "Pomodoro")
    + `<circle cx="${cx + 4}" cy="${y + 59}" r="4" fill="#ef4444"/>`
    + text("WORK", cx + 16, y + 63, 12, { weight: 800, fill: W_T3, spacing: 2 })
    + text("17:30", cx, y + 100, 34, { weight: 900, fill: W_ACCENT, family: mono })
    + `<rect x="${x + 200}" y="${y + 88}" width="200" height="6" rx="3" fill="rgba(255,255,255,0.1)"/>`
    + `<rect x="${x + 200}" y="${y + 88}" width="60" height="6" rx="3" fill="${W_ACCENT}"/>`
    + `<rect x="${x + 430}" y="${y + 70}" width="34" height="36" rx="9" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>`
    + iconReset(x + 439, y + 79, 18, W_T2)
    + `<rect x="${x + 472}" y="${y + 70}" width="96" height="36" rx="9" fill="${W_ACCENT}"/>`
    + `<rect x="${x + 486}" y="${y + 81}" width="5" height="15" rx="1.5" fill="#16131a"/>`
    + `<rect x="${x + 496}" y="${y + 81}" width="5" height="15" rx="1.5" fill="#16131a"/>`
    + text("Pause", x + 534, y + 93, 14, { anchor: "middle", weight: 800, fill: "#16131a" })
    + `<rect x="${x + 576}" y="${y + 70}" width="34" height="36" rx="9" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>`
    + iconSkip(x + 585, y + 79, 16, W_T2);
}
function sidebar(t) {
  let s = `<rect x="1" y="36" width="199" height="579" fill="${W_SIDE}"/>`;
  s += bolt(14, 51, 16, "#ffffff");
  s += text("Mac Kit", 40, 65, 15, { weight: 800, fill: W_T1 });
  s += iconChevron(176, 51, 15, W_T3);
  const nav = [
    ["Home", iconHome],
    ["Screenshot", iconCamera],
    ["Clipboard", iconClipboard],
    ["System Monitor", iconCpu],
    ["Keep Awake", iconCoffee],
    ["New File", iconFilePlus],
    ["Convert", iconConvert],
    ["Color Picker", iconDroplet],
    ["Pomodoro", iconTimer],
    ["Screen Draw", iconBrush],
  ];
  const ni = navIndex(t);
  const blend = navBlend(t);
  const litPage = ni > 0 && blend < 0.5 ? NAV[ni - 1][1] : NAV[ni][1];
  const activeIdx = PAGE_IDX[litPage];
  let pillY = activePillY(t);
  let pillOp = 1;
  if (ni > 0 && blend > 0 && blend < 1) {
    const gap = Math.abs(PAGE_IDX[NAV[ni][1]] - PAGE_IDX[NAV[ni - 1][1]]);
    // far jumps fade out at the source and in at the destination instead of sliding the pill across unrelated rows
    if (gap > 2) {
      pillOp = Math.max(0, Math.abs(blend - 0.5) * 2);
      pillY = blend < 0.5 ? navRowTop(NAV[ni - 1][1]) : navRowTop(NAV[ni][1]);
    }
  }
  s += `<rect x="10" y="${pillY}" width="180" height="32" rx="8" fill="${W_ACCENT_SUB}" opacity="${pillOp.toFixed(3)}"/>`;
  let y = 90;
  nav.forEach(([label, ic], idx) => {
    const active = idx === activeIdx;
    s += ic(20, y + 7, 18, active ? W_ACCENT : W_T2);
    s += text(label, 46, y + 21, 14, { weight: active ? 700 : 500, fill: active ? W_ACCENT : W_T2 });
    y += 36;
  });
  s += `<line x1="10" y1="560" x2="190" y2="560" stroke="rgba(255,255,255,0.06)"/>`;
  s += iconGear(20, 572, 18, W_T2);
  s += text("Settings", 46, 587, 14, { weight: 500, fill: W_T2 });
  return s;
}
function pageTitle(title, sub) {
  return text(title, 224, 78, 22, { weight: 800, fill: W_T1, spacing: -0.4 })
    + text(sub, 224, 100, 13, { weight: 500, fill: W_T2 });
}
function pageHome(t) {
  const X = 224;
  const col2 = 536;
  const colW = 300;
  let s = "";
  s += `<rect x="${X}" y="52" width="32" height="32" rx="9" fill="${W_ACCENT_SUB}"/>`;
  s += bolt(X + 8, 60, 16, W_ACCENT);
  s += text("Mac Kit", X + 44, 74, 16, { weight: 700, fill: W_T1, spacing: -0.4 });
  s += `<rect x="720" y="56" width="72" height="28" rx="8" fill="${W_CARD}" stroke="${W_BORDER}"/>`;
  s += iconPencil(729, 62, 13, W_T2);
  s += text("Edit", 752, 74, 12, { weight: 500, fill: W_T2 });
  s += `<rect x="800" y="56" width="30" height="28" rx="8" fill="${W_CARD}" stroke="${W_BORDER}"/>`;
  s += `<line x1="808" y1="70" x2="822" y2="70" stroke="${W_T3}" stroke-width="2" stroke-linecap="round"/>`;
  s += cardSystemStats(X, 108, colW, 150, t);
  s += cardClipboard(col2, 108, colW, 150);
  s += cardScreenshot(X, 270, colW, 150);
  s += cardColor(col2, 270, colW, 150);
  s += cardPomodoro(X, 432, 612, 120);
  return s;
}
function modeCard(x, y, w, h, iconFn, color, label, desc, shortcut) {
  const tint = color === W_ACCENT ? W_ACCENT_SUB : "rgba(239,68,68,0.16)";
  const bw = 14 + shortcut.length * 8.5;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${W_CARD}" stroke="${W_CARDB}"/>`
    + `<rect x="${x + 16}" y="${y + 16}" width="40" height="40" rx="11" fill="${tint}"/>`
    + iconFn(x + 26, y + 26, 20, color)
    + text(label, x + 16, y + 82, 15, { weight: 700, fill: W_T1 })
    + text(desc, x + 16, y + 102, 11.5, { weight: 500, fill: W_T3 })
    + `<rect x="${x + w - bw - 14}" y="${y + 18}" width="${bw}" height="22" rx="6" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)"/>`
    + text(shortcut, x + w - bw / 2 - 14, y + 33, 11, { anchor: "middle", weight: 700, fill: W_T2, family: mono });
}
function pageScreenshot(t) {
  const cw = 296;
  const ch = 116;
  let s = pageTitle("Screenshot & Recording", "Capture or record your screen.");
  s += modeCard(224, 128, cw, ch, iconCamera, W_ACCENT, "Full Screen", "Capture everything", "⇧⌘3");
  s += modeCard(540, 128, cw, ch, iconCrop, W_ACCENT, "Select Area", "Drag to select a region", "⇧⌘4");
  s += modeCard(224, 258, cw, ch, iconAppWindow, W_ACCENT, "Window", "Capture a single window", "⇧⌘5");
  s += modeCard(540, 258, cw, ch, iconVideo, "#ef4444", "Record Screen", "Record video with audio", "REC");
  // Options row
  s += `<rect x="224" y="392" width="612" height="34" rx="9" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.07)"/>`;
  const opts = [["Save to Desktop", true], ["Show cursor", true], ["Timer 3s", false]];
  let ox = 240;
  opts.forEach(([lab, on]) => {
    s += `<circle cx="${ox + 6}" cy="409" r="5" fill="${on ? W_GREEN : "rgba(255,255,255,0.2)"}"/>`;
    s += text(lab, ox + 18, 413, 12, { weight: 600, fill: on ? W_T1 : W_T3 });
    ox += 30 + lab.length * 7.2;
  });
  // Recent captures
  s += text("RECENT CAPTURES", 224, 456, 11, { weight: 800, fill: W_T3, spacing: 1.5 });
  const caps = [["#3a4a7b", "10:24"], ["#7b3f6a", "10:19"], ["#3f7b5a", "09:56"], ["#7b6a3f", "09:41"]];
  caps.forEach(([tint, ts], i) => {
    const tx = 224 + i * 156;
    s += `<rect x="${tx}" y="470" width="140" height="86" rx="10" fill="rgba(0,0,0,0.24)" stroke="rgba(255,255,255,0.07)"/>`;
    s += `<rect x="${tx + 8}" y="478" width="124" height="52" rx="6" fill="${tint}" opacity="0.6"/>`;
    s += `<circle cx="${tx + 38}" cy="498" r="10" fill="#ffffff" opacity="0.28"/>`;
    s += `<path d="M${tx + 8} 530 L${tx + 46} 502 L${tx + 84} 530 Z" fill="#000000" opacity="0.22"/>`;
    s += text(`Screen · ${ts}`, tx + 10, 547, 10.5, { weight: 600, fill: W_T3 });
  });
  return s;
}
function pageColor(t) {
  let s = pageTitle("Color Picker", "Pick colors from your screen.");
  const hx = 224;
  const hy = 122;
  const hw = 612;
  const hh = 168;
  s += `<rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="12" fill="${W_CARD}" stroke="${W_CARDB}"/>`;
  s += `<rect x="${hx + 18}" y="${hy + 18}" width="132" height="132" rx="14" fill="${PICK_HEX}" stroke="rgba(255,255,255,0.18)"/>`;
  // loupe on the swatch
  s += `<circle cx="${hx + 118}" cy="${hy + 118}" r="22" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.85"/>`;
  s += `<line x1="${hx + 118}" y1="${hy + 108}" x2="${hx + 118}" y2="${hy + 128}" stroke="#ffffff" stroke-width="1.4" opacity="0.7"/>`;
  s += `<line x1="${hx + 108}" y1="${hy + 118}" x2="${hx + 128}" y2="${hy + 118}" stroke="#ffffff" stroke-width="1.4" opacity="0.7"/>`;
  const formats = [["HEX", "#5AA9FF"], ["RGB", "rgb(90, 169, 255)"], ["HSL", "hsl(212, 100%, 68%)"]];
  formats.forEach(([lab, val], i) => {
    const ry = hy + 18 + i * 46;
    s += text(lab, hx + 178, ry + 14, 10.5, { weight: 800, fill: W_T3, spacing: 1.5 });
    s += `<rect x="${hx + 178}" y="${ry + 20}" width="396" height="30" rx="8" fill="rgba(0,0,0,0.2)" stroke="rgba(255,255,255,0.07)"/>`;
    s += text(val, hx + 192, ry + 40, 13, { weight: 700, fill: W_T1, family: mono });
    s += `<rect x="${hx + 540}" y="${ry + 24}" width="22" height="22" rx="6" fill="rgba(255,255,255,0.06)"/>`;
    s += iconCopy(hx + 543, ry + 27, 15, "#a8a4ae");
  });
  // Pick from Screen button
  s += `<rect x="${hx}" y="${hy + hh + 14}" width="${hw}" height="46" rx="12" fill="${W_ACCENT}"/>`;
  s += iconDroplet(hx + hw / 2 - 76, hy + hh + 24, 18, "#16131a");
  s += text("Pick from Screen", hx + hw / 2 + 4, hy + hh + 44, 15, { anchor: "middle", weight: 800, fill: "#16131a" });
  // Bottom: default format + recent colors
  const by = hy + hh + 14 + 46 + 30;
  s += text("DEFAULT COPY FORMAT", hx, by, 10.5, { weight: 800, fill: W_T3, spacing: 1.3 });
  const segLabels = ["HEX", "RGB", "HSL"];
  s += `<rect x="${hx}" y="${by + 12}" width="284" height="36" rx="9" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)"/>`;
  segLabels.forEach((lab, i) => {
    const sx = hx + 4 + i * 92;
    const active = i === 0;
    if (active) s += `<rect x="${sx}" y="${by + 16}" width="88" height="28" rx="7" fill="${W_ACCENT_SUB}" stroke="rgba(255,159,28,0.4)"/>`;
    s += text(lab, sx + 44, by + 35, 12, { anchor: "middle", weight: active ? 800 : 600, fill: active ? W_ACCENT : W_T2, spacing: 1 });
  });
  s += text("RECENT COLORS", hx + 316, by, 10.5, { weight: 800, fill: W_T3, spacing: 1.3 });
  const recents = ["#5AA9FF", "#22c55e", "#ff9f1c", "#ef4444", "#a855f7", "#14b8a6"];
  recents.forEach((c, i) => {
    s += `<circle cx="${hx + 332 + i * 46}" cy="${by + 30}" r="14" fill="${c}" stroke="rgba(255,255,255,0.18)"/>`;
  });
  return s;
}
function pomInfoCard(x, y, w, h, label, big, sub) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${W_CARD}" stroke="${W_CARDB}"/>`
    + text(label, x + 16, y + 26, 10.5, { weight: 800, fill: W_T3, spacing: 1.3 })
    + text(big, x + 16, y + 60, 26, { weight: 900, fill: W_T1 })
    + text(sub, x + 16, y + 84, 11.5, { weight: 500, fill: W_T3 });
}
function pagePomodoro(t) {
  let s = pageTitle("Pomodoro", "Focus. Rest. Repeat.");
  const segY = 124;
  const segH = 38;
  const modes = [["Work · 25m", W_ACCENT, true], ["Short Break · 5m", W_GREEN, false], ["Long Break · 15m", "#14b8a6", false]];
  const segW = [146, 196, 190];
  let sx = 224;
  modes.forEach(([lab, col, active], i) => {
    const w = segW[i];
    s += `<rect x="${sx}" y="${segY}" width="${w}" height="${segH}" rx="10" fill="${active ? W_ACCENT_SUB : "rgba(255,255,255,0.04)"}" stroke="${active ? "rgba(255,159,28,0.4)" : "rgba(255,255,255,0.08)"}"/>`;
    s += `<circle cx="${sx + 18}" cy="${segY + segH / 2}" r="4" fill="${col}"/>`;
    s += text(lab, sx + 32, segY + 24, 13, { weight: active ? 700 : 500, fill: active ? W_ACCENT : W_T2 });
    sx += w + 12;
  });
  const ccx = 530;
  const ccy = 328;
  const r = 92;
  const circ = 2 * Math.PI * r;
  // live-ticking session: counts down from 17:30 while the Pomodoro page is on screen
  const remain = Math.max(0, 1050 - Math.max(0, Math.floor(t - (8.5 + INTRO))));
  const frac = (1500 - remain) / 1500;
  const timeStr = `${String(Math.floor(remain / 60)).padStart(2, "0")}:${String(remain % 60).padStart(2, "0")}`;
  // side info cards
  s += pomInfoCard(224, 236, 168, 120, "TODAY", "3 / 8", "sessions done");
  s += pomInfoCard(668, 236, 168, 120, "FOCUSED", "1h 15m", "total time");
  // ring
  s += `<circle cx="${ccx}" cy="${ccy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="12"/>`;
  s += `<circle cx="${ccx}" cy="${ccy}" r="${r}" fill="none" stroke="${W_ACCENT}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - frac)}" transform="rotate(-90 ${ccx} ${ccy})"/>`;
  s += text(timeStr, ccx, ccy + 4, 38, { anchor: "middle", weight: 900, fill: W_T1, family: mono });
  s += text("WORK", ccx, ccy + 30, 11, { anchor: "middle", weight: 800, fill: W_T3, spacing: 3 });
  [0, 1, 2, 3].forEach((i) => {
    s += `<circle cx="${ccx - 24 + i * 16}" cy="${ccy + 56}" r="4" fill="${i === 0 ? W_ACCENT : "rgba(255,255,255,0.18)"}"/>`;
  });
  // task chip
  s += `<rect x="${ccx - 130}" y="466" width="260" height="34" rx="17" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)"/>`;
  s += `<circle cx="${ccx - 108}" cy="483" r="4" fill="${W_ACCENT}"/>`;
  s += text("Deep work — draft the promo", ccx, 487, 12.5, { anchor: "middle", weight: 600, fill: W_T2 });
  // controls
  const by = 542;
  s += `<circle cx="${ccx - 92}" cy="${by}" r="24" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)"/>`;
  s += iconReset(ccx - 92 - 11, by - 11, 22, W_T2);
  s += `<rect x="${ccx - 62}" y="${by - 23}" width="124" height="46" rx="23" fill="${W_ACCENT}"/>`;
  s += `<rect x="${ccx - 34}" y="${by - 9}" width="5.5" height="18" rx="1.5" fill="#16131a"/>`;
  s += `<rect x="${ccx - 24}" y="${by - 9}" width="5.5" height="18" rx="1.5" fill="#16131a"/>`;
  s += text("Pause", ccx + 14, by + 6, 16, { anchor: "middle", weight: 800, fill: "#16131a" });
  s += `<circle cx="${ccx + 92}" cy="${by}" r="24" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.12)"/>`;
  s += iconSkip(ccx + 92 - 11, by - 11, 22, W_T2);
  return s;
}
function renderPage(page, t) {
  if (page === "screenshot") return pageScreenshot(t);
  if (page === "color") return pageColor(t);
  if (page === "pomodoro") return pagePomodoro(t);
  return pageHome(t);
}
function mainContent(t) {
  const i = navIndex(t);
  const blend = navBlend(t);
  if (i > 0 && blend < 1) {
    const outOp = clamp(1 - blend * 1.45, 0, 1); // outgoing clears early to avoid a muddy 50/50 overlap
    const outDy = lerp(0, 10, blend); // outgoing drifts down as incoming rises up
    const inDy = lerp(12, 0, blend);
    return `<g opacity="${outOp}" transform="translate(0 ${outDy})">${renderPage(NAV[i - 1][1], t)}</g>`
      + `<g opacity="${blend}" transform="translate(0 ${inDy})">${renderPage(NAV[i][1], t)}</g>`;
  }
  return renderPage(NAV[i][1], t);
}
function windowContent(t) {
  let s = `<rect x="0" y="0" width="860" height="616" rx="13" fill="${W_BG}" stroke="rgba(255,255,255,0.08)"/>`;
  s += `<rect x="0.5" y="0.5" width="859" height="615" rx="12.5" fill="none" stroke="rgba(255,255,255,0.06)"/>`;
  s += `<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>`;
  s += `<line x1="0" y1="36" x2="860" y2="36" stroke="${W_BORDER}"/>`;
  s += sidebar(t);
  s += `<line x1="200" y1="36" x2="200" y2="616" stroke="${W_BORDER}"/>`;
  s += mainContent(t);
  return s;
}
function appWindow(t) {
  const op = winState(t);
  if (op <= 0) return "";
  const k = WIN_SCALE;
  const cx = WX + (860 * k) / 2;
  const cy = WY + (616 * k) / 2;
  const s = lerp(0.93, 1, easeOutBack(op));
  const dy = lerp(20, 0, easeOutCubic(op));
  return `<g opacity="${op}" transform="translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy + dy})">
    <g transform="translate(${WX} ${WY}) scale(${k})" filter="url(#winShadow)">
      ${windowContent(t)}
    </g>
  </g>`;
}

// ---- Cursor ----
const CURSOR_KEYS = [
  [0.0, 950, 1000],
  [1.0, ICON_CX, ICON_CY], // glide up to the icon
  [1.05, ICON_CX, ICON_CY], // left-click → quick-tools popover opens
  [2.4, ICON_CX, ICON_CY], // hold on the icon, then click again to dismiss
  [1.4 + INTRO, ICON_CX, ICON_CY], // right-click → context menu
  [2.6 + INTRO, 1593, 113],
  [3.3 + INTRO, 1593, 113], // click Open in Window
  [4.0 + INTRO, 1593, 113], // park on the menu item through window open + hold
  [4.55 + INTRO, 515, 300], // arrive at Screenshot nav row
  [4.7 + INTRO, 515, 300], // click Screenshot
  [6.3 + INTRO, 515, 300], // rest on Screenshot row through its dwell
  [6.55 + INTRO, 515, 591], // travel to Color Picker nav row
  [6.6 + INTRO, 515, 591], // click Color Picker
  [8.2 + INTRO, 515, 591], // rest on Color row through its dwell
  [8.45 + INTRO, 515, 640], // travel to Pomodoro nav row
  [8.5 + INTRO, 515, 640], // click Pomodoro
  [9.6 + INTRO, 830, 470], // drift into the content
];
const CLICK_TIMES = [POP_OPEN, POP_CLOSE, 1.4 + INTRO, 3.3 + INTRO, 4.7 + INTRO, 6.6 + INTRO, 8.5 + INTRO];

function cursorPos(t) {
  if (t <= CURSOR_KEYS[0][0]) return [CURSOR_KEYS[0][1], CURSOR_KEYS[0][2]];
  for (let i = 1; i < CURSOR_KEYS.length; i += 1) {
    if (t <= CURSOR_KEYS[i][0]) {
      const [t0, x0, y0] = CURSOR_KEYS[i - 1];
      const [t1, x1, y1] = CURSOR_KEYS[i];
      const p = easeInOutCubic((t - t0) / (t1 - t0));
      return [lerp(x0, x1, p), lerp(y0, y1, p)];
    }
  }
  const k = CURSOR_KEYS[CURSOR_KEYS.length - 1];
  return [k[1], k[2]];
}
function cursorLayer(t) {
  const op = fade(t, 0.0, 0.5, 10.1 + INTRO, 10.7 + INTRO);
  if (op <= 0) return "";
  const [x, y] = cursorPos(t);
  let ripples = "";
  for (const ct of CLICK_TIMES) {
    const rp = (t - ct) / 0.45;
    if (rp >= 0 && rp <= 1) {
      const r = 8 + rp * 28;
      ripples += `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${orange}" stroke-width="${3.2 * (1 - rp)}" opacity="${(1 - rp) * 0.9}"/>`;
    }
  }
  const press = CLICK_TIMES.some((ct) => Math.abs(t - ct) < 0.09);
  const s = press ? 0.88 : 1;
  return `<g opacity="${op}">
    ${ripples}
    <g transform="translate(${x} ${y}) scale(${s})">
      <path d="M0 0 L0 27 L7.5 20 L12.5 31 L17 29 L11.5 18.5 L21 18.5 Z" fill="#ffffff" stroke="#15151d" stroke-width="1.6" stroke-linejoin="round"/>
    </g>
  </g>`;
}

// ---- Captions ----
function captions(t) {
  const list = [
    [0.95, 2.35, "One click for quick tools."],
    [1.5 + INTRO, 3.3 + INTRO, "Right-click the menu bar icon."],
    [3.6 + INTRO, 4.6 + INTRO, "Open the whole toolkit in a window."],
    [4.9 + INTRO, 6.5 + INTRO, "Capture or record your screen."],
    [6.7 + INTRO, 8.4 + INTRO, "Pick colors from anywhere."],
    [8.6 + INTRO, 10.2 + INTRO, "Focus with a built-in timer."],
  ];
  return list.map(([s, e, label]) => {
    const p = fade(t, s, s + 0.3, e - 0.3, e);
    if (p <= 0) return "";
    const rise = lerp(10, 0, easeOutCubic(clamp((t - s) / 0.35, 0, 1)));
    const w = Math.round(label.length * 14 + 90);
    const x = 960 - w / 2;
    return `<g opacity="${p}" transform="translate(0 ${rise.toFixed(1)})">
      <rect x="${x}" y="972" width="${w}" height="60" rx="30" fill="rgba(12,12,18,0.66)" stroke="rgba(255,255,255,0.12)"/>
      ${text(label, 960, 1010, 26, { anchor: "middle", weight: 800 })}
    </g>`;
  }).join("");
}

// ---- CTA ----
function pill(x, y, w, h, label, opts = {}) {
  const fill = opts.fill || "rgba(255,255,255,0.08)";
  const color = opts.color || ink;
  const border = opts.border || "rgba(255,255,255,0.14)";
  const opacity = opts.opacity ?? 1;
  return `<g opacity="${opacity}">
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${border}"/>
    ${text(label, x + w / 2, y + h / 2 + 7, 22, { fill: color, weight: 700, anchor: "middle" })}
  </g>`;
}
function cta(t) {
  // quick clean wipe to an opaque canvas so the app window doesn't ghost through behind the copy
  const bgOp = clamp((t - (10.4 + INTRO)) / 0.25, 0, 1);
  if (bgOp <= 0) return "";
  const accent = "#f5941d";
  const pillOpts = { fill: "#ffffff", color: "#6d6b66", border: "rgba(5,5,5,0.12)" };
  const pulse = 0.5 + 0.5 * Math.sin((t - (10.7 + INTRO)) * Math.PI * 2 / 1.2);
  const btnScale = lerp(1, 1.04, pulse);
  const glowOp = lerp(0.1, 0.5, pulse);
  // staggered entrance: each block eases up in sequence once the canvas is clean
  const rev = (delay) => {
    const p = easeOutCubic(clamp((t - (10.7 + INTRO + delay)) / 0.5, 0, 1));
    return `opacity="${p.toFixed(3)}" transform="translate(0 ${lerp(26, 0, p).toFixed(1)})"`;
  };
  return `<g>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#f4f2ed" opacity="${bgOp.toFixed(3)}"/>
    <ellipse cx="960" cy="300" rx="720" ry="480" fill="url(#ctaGlow)" opacity="${bgOp.toFixed(3)}"/>
    <g ${rev(0)}>
      <g transform="translate(896 206)" filter="url(#ctaShadow)">
        <rect width="128" height="128" rx="30" fill="#ffffff" stroke="#e2ded6"/>
        ${bolt(34, 36, 56, "#16131a")}
      </g>
    </g>
    <g ${rev(0.12)}>
      ${text("Mac Kit", 960, 400, 42, { anchor: "middle", weight: 900, fill: accent, spacing: 1 })}
      ${text("Get everyday Mac tools out of the way.", 960, 484, 60, { anchor: "middle", weight: 900, fill: "#050505" })}
    </g>
    <g ${rev(0.24)}>
      ${text("Screenshots, clipboard history, color picker, pomodoro, keep awake, and more.", 960, 546, 27, { anchor: "middle", fill: "#6d6b66", weight: 600 })}
    </g>
    <g ${rev(0.36)}>
      <ellipse cx="960" cy="662" rx="380" ry="112" fill="url(#btnGlow)" opacity="${glowOp}"/>
      <g transform="translate(960 662) scale(${btnScale}) translate(-960 -662)">
        <g transform="translate(650 620)" filter="url(#ctaShadow)">
          <rect x="0" y="0" width="620" height="84" rx="42" fill="#050505"/>
          ${text("Get Mac Kit Now", 310, 53, 28, { anchor: "middle", fill: "#ffffff", weight: 800 })}
        </g>
      </g>
    </g>
    <g ${rev(0.48)}>
      <g transform="translate(576 766)">
        ${pill(0, 0, 300, 52, "Intel + Apple Silicon", pillOpts)}
        ${pill(324, 0, 230, 52, "50+ languages", pillOpts)}
        ${pill(578, 0, 190, 52, "$6.99/mo", pillOpts)}
      </g>
    </g>
  </g>`;
}

function frameSvg(index) {
  const t = storyTime(index / FPS);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    ${defs()}
    ${wallpaper(t)}
    ${menuBar(t)}
    ${lightPopover(t)}
    ${contextMenu(t)}
    ${appWindow(t)}
    ${captions(t)}
    ${cursorLayer(t)}
    ${cta(t)}
  </svg>`;
}

// ---- Render pipeline ----
function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}
function renderPng(svg) {
  const result = spawnSync("rsvg-convert", ["-w", String(WIDTH), "-h", String(HEIGHT), "-f", "png"], {
    input: svg,
    maxBuffer: 80 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error("rsvg-convert failed");
  }
  return result.stdout;
}
function writeStream(stream, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    stream.once("error", onError);
    if (stream.write(chunk)) {
      stream.off("error", onError);
      resolve();
    } else {
      stream.once("drain", onDrain);
    }
  });
}
function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const ffmpeg = spawn("ffmpeg", [
    "-y",
    "-f", "image2pipe",
    "-framerate", String(FPS),
    "-i", "-",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-crf", "18",
    VIDEO_OUT,
  ], { stdio: ["pipe", "inherit", "inherit"] });

  const posterStory = 4.3 + INTRO; // Home dashboard, just after the window opens
  let posterAcc = 0;
  for (const [s0, dur] of HOLDS) if (posterStory > s0) posterAcc += dur;
  const posterFrame = Math.round((posterStory + posterAcc) * FPS);
  for (let i = 0; i < FRAMES; i += 1) {
    const png = renderPng(frameSvg(i));
    if (i === posterFrame) {
      run("rsvg-convert", ["-w", String(WIDTH), "-h", String(HEIGHT), "-f", "png", "-o", POSTER_OUT], {
        input: frameSvg(i),
        stdio: ["pipe", "inherit", "inherit"],
      });
    }
    await writeStream(ffmpeg.stdin, png);
    if ((i + 1) % 60 === 0) {
      process.stdout.write(`Encoded ${i + 1}/${FRAMES} frames\n`);
    }
  }

  ffmpeg.stdin.end();
  await waitForProcess(ffmpeg);
  process.stdout.write(`Video written to ${VIDEO_OUT}\n`);
  process.stdout.write(`Poster written to ${POSTER_OUT}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
