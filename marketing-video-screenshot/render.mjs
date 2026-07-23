import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 12.4;
// Linger on the beats where a new preview lands so the corner stack reads clearly.
const HOLDS = [
  [4.8, 0.5], // area screenshot lands in the corner
  [8.9, 0.8], // Quick Access screenshot — the full stack
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
const OUT_DIR = join(ROOT, "marketing-video-screenshot", "out");
const VIDEO_OUT = join(OUT_DIR, "mac-kit-screenshot-promo.mp4");
const POSTER_OUT = join(OUT_DIR, "mac-kit-screenshot-poster.png");

const orange = "#ff9f1c";
const ink = "#f7f3ea";
const muted = "#aaa5b2";
const mono = "SFMono-Regular, Menlo, monospace";
const sans = "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const PICK_HEX = "#5AA9FF";

// App accent (Screenshot preview + Quick Access ring use blue #3b82f6).
const ACC = "#3b82f6";
const ACC_SUB = "rgba(59,130,246,0.18)";

// ---- Menu bar / icon ----
const MB_H = 40;
const ICON_CX = 1700;
const ICON_CY = 20;
// Original popover was authored for an icon at x=1300; shift to track our icon.
const POP_DX = ICON_CX - 1300;
const CDX = 16;
const CDY = 48 - 95;
const PX = 640;
const PY = 48;
const PW = 760;
const PH = 478;
// Shrink the whole popover toward the menu-bar icon (top-right anchor).
const POP_SCALE = 0.78;

// ---- Capture preview stack (faithful to CapturePreview.tsx + main.ts layout) ----
const CARD_W = 230;
const CARD_H = 158;
const CARD_MARGIN = 16;
const CARD_GAP = 10;
const CARD_RIGHT_X = WIDTH - CARD_W - CARD_MARGIN;
const CARD_BOTTOM_Y = HEIGHT - CARD_H - CARD_MARGIN;

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
  const { fill = ink, weight = 700, anchor = "start", opacity = 1, spacing = 0, family = sans } = opts;
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

// -- Popover ("pet") icons: keep the original orange menu-bar look --
function mbClipboard(x, y, size = 18, color = orange) {
  return icon(x, y, size, color, `<rect x="3" y="4" width="14" height="15" rx="3"/><path d="M7 4 V2.5 A1.5 1.5 0 0 1 8.5 1 H11.5 A1.5 1.5 0 0 1 13 2.5 V4 Z" fill="${color}"/>`);
}
function mbCamera(x, y, size = 18, color = orange) {
  return icon(x, y, size, color, `<rect x="1.5" y="5" width="17" height="12.5" rx="3"/><path d="M6.5 5 L8 2.5 H12 L13.5 5"/><circle cx="10" cy="11.2" r="3.2"/>`);
}
function mbDroplet(x, y, size = 18, color = orange) {
  return icon(x, y, size, color, `<path d="M10 2 C6 8 5 11 5 13 A5 5 0 0 0 15 13 C15 11 14 8 10 2 Z"/>`);
}
function mbTimer(x, y, size = 18, color = orange) {
  return icon(x, y, size, color, `<circle cx="10" cy="12" r="6.6"/><line x1="10" y1="12" x2="10" y2="8"/><line x1="8" y1="2" x2="12" y2="2"/><line x1="10" y1="2" x2="10" y2="5.4"/>`);
}
function mbCopy(x, y, size = 15, color = "#98949e") {
  return icon(x, y, size, color, `<rect x="7" y="7" width="9" height="9" rx="2"/><path d="M4.5 12.5 H4 A1.5 1.5 0 0 1 2.5 11 V4 A1.5 1.5 0 0 1 4 2.5 H11 A1.5 1.5 0 0 1 12.5 4 V4.5"/>`);
}
function mbPlus(x, y, size = 18, color = ink) {
  return icon(x, y, size, color, `<line x1="10" y1="5" x2="10" y2="15"/><line x1="5" y1="10" x2="15" y2="10"/>`);
}
function mbMinus(x, y, size = 18, color = ink) {
  return icon(x, y, size, color, `<line x1="5" y1="10" x2="15" y2="10"/>`);
}

// -- Quick Access ring icons (lucide-style, blue) --
function rCamera(x, y, size = 18, color = ACC) {
  return icon(x, y, size, color, `<rect x="1.5" y="5" width="17" height="12.5" rx="3"/><path d="M6.5 5 L8 2.5 H12 L13.5 5"/><circle cx="10" cy="11.2" r="3.2"/>`);
}
function rCrop(x, y, size = 18, color = ACC) {
  return icon(x, y, size, color, `<path d="M6 2.5 V13.5 A1.5 1.5 0 0 0 7.5 15 H18"/><path d="M2 6 H12.5 A1.5 1.5 0 0 1 14 7.5 V18"/>`);
}
function rClipboard(x, y, size = 18, color = ACC) {
  return icon(x, y, size, color, `<rect x="3.5" y="4" width="13" height="14.5" rx="3"/><path d="M7 4 V2.6 A1.4 1.4 0 0 1 8.4 1.2 H11.6 A1.4 1.4 0 0 1 13 2.6 V4 Z" fill="${color}"/><line x1="7" y1="9" x2="13" y2="9"/><line x1="7" y1="12.5" x2="13" y2="12.5"/><line x1="7" y1="16" x2="10.5" y2="16"/>`);
}
function rCoffee(x, y, size = 18, color = ACC) {
  return icon(x, y, size, color, `<path d="M3.5 7 H14.5 V12.5 A4 4 0 0 1 10.5 16.5 H7.5 A4 4 0 0 1 3.5 12.5 Z"/><path d="M14.5 8 H16 A2.4 2.4 0 0 1 16 12.8 H14.5"/><path d="M6.5 2.2 V4"/><path d="M9.5 2.2 V4"/>`);
}
function rPipette(x, y, size = 18, color = ACC) {
  const s = (size / 20) * (20 / 24);
  const body = `<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>`;
  return `<g transform="translate(${x} ${y - 0.5 * (size / 20)}) scale(${s})" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}
function rBrush(x, y, size = 18, color = ACC) {
  const s = (size / 20) * (20 / 24);
  const body = `<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>`;
  return `<g transform="translate(${x} ${y - 0.5 * (size / 20)}) scale(${s})" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}
function rPointer(x, y, size = 18, color = ACC) {
  const s = size / 24;
  const body = `<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>`;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}
function rCopy(x, y, size = 15, color = "#98949e") {
  return icon(x, y, size, color, `<rect x="7" y="7" width="9" height="9" rx="2"/><path d="M4.5 12.5 H4 A1.5 1.5 0 0 1 2.5 11 V4 A1.5 1.5 0 0 1 4 2.5 H11 A1.5 1.5 0 0 1 12.5 4 V4.5"/>`);
}
function rSend(x, y, size = 18, color = "#ffffff") {
  return icon(x, y, size, color, `<path d="M3 10 L17 3 L11 17 L9 11 Z"/>`);
}

// ---- Defs / wallpaper ----
function defs() {
  return `<defs>
    <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#22315f"/>
      <stop offset="40%" stop-color="#3d3a86"/>
      <stop offset="72%" stop-color="#7a3f86"/>
      <stop offset="100%" stop-color="#c86f5a"/>
    </linearGradient>
    <radialGradient id="wallGlow" cx="70%" cy="24%" r="60%">
      <stop offset="0%" stop-color="#bcd4ff" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#bcd4ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="photoSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fbd08a"/>
      <stop offset="46%" stop-color="#f2896b"/>
      <stop offset="100%" stop-color="#6a4a8c"/>
    </linearGradient>
    <filter id="winShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="26" stdDeviation="38" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
    <filter id="popShadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="20" stdDeviation="30" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
    <filter id="ringShadow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="22" stdDeviation="34" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
    <filter id="cardShadow" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    <filter id="keyShadow" x="-40%" y="-40%" width="180%" height="200%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000000" flood-opacity="0.4"/>
    </filter>
    <radialGradient id="ctaGlow" cx="50%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#2f6bff" stop-opacity="0.14"/>
      <stop offset="100%" stop-color="#2f6bff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="btnGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#2f6bff" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#2f6bff" stop-opacity="0"/>
    </radialGradient>
    <filter id="ctaShadow" x="-60%" y="-60%" width="220%" height="240%">
      <feDropShadow dx="0" dy="14" stdDeviation="24" flood-color="#050505" flood-opacity="0.22"/>
    </filter>
  </defs>`;
}
function wallpaper(t) {
  const bx = 1360 + Math.sin(t * 0.3) * 60;
  const by = 300 + Math.cos(t * 0.35) * 40;
  return `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#wall)"/>
    <ellipse cx="${bx}" cy="${by}" rx="620" ry="520" fill="url(#wallGlow)"/>
    <circle cx="360" cy="900" r="340" fill="#ffffff" opacity="0.05"/>
    <path d="M0 950 C 460 890 720 1020 1120 940 S 1620 840 1920 920 V1080 H0Z" fill="rgba(255,255,255,0.05)"/>`;
}

// ---- Generic app window ----
function windowChrome(x, y, w, h, title, accentDot = "#febc2e") {
  const cy = y + 40;
  return {
    top: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="#ffffff"/>
      <rect x="${x}" y="${y}" width="${w}" height="40" rx="16" fill="#eceaf0"/>
      <rect x="${x}" y="${y + 20}" width="${w}" height="20" fill="#eceaf0"/>
      <circle cx="${x + 24}" cy="${y + 20}" r="6.5" fill="#ff5f57"/>
      <circle cx="${x + 44}" cy="${y + 20}" r="6.5" fill="${accentDot}"/>
      <circle cx="${x + 64}" cy="${y + 20}" r="6.5" fill="#28c840"/>
      ${text(title, x + w / 2, y + 25, 14, { anchor: "middle", weight: 700, fill: "#8a8692" })}
      <path d="M${x} ${cy} H${x + w} V${y + h - 16} A16 16 0 0 1 ${x + w - 16} ${y + h} H${x + 16} A16 16 0 0 1 ${x} ${y + h - 16} Z" fill="#ffffff"/>`,
    cy,
  };
}

// Browser window — Mac Kit landing page
const BW1 = { x: 232, y: 150, w: 610, h: 392 };
function browserWindow() {
  const { x, y, w, h } = BW1;
  const { top, cy } = windowChrome(x, y, w, h, "");
  const cx = x + w / 2;
  return `<g filter="url(#winShadow)">
    ${top}
    <rect x="${x + 150}" y="${y + 9}" width="${w - 300}" height="22" rx="11" fill="#ffffff" stroke="#d6d3dd"/>
    ${text("mackit.rojhot.com", x + w / 2, y + 24, 12, { anchor: "middle", weight: 600, fill: "#8a8692", family: mono })}
    <rect x="${x + 30}" y="${cy + 14}" width="24" height="24" rx="6" fill="#ffffff" stroke="#dcd8e2"/>
    ${bolt(x + 34, cy + 17, 15, "#16131a")}
    ${text("Mac Kit", x + 62, cy + 33, 17, { weight: 900, fill: "#1a1a22" })}
    <rect x="${x + w - 128}" y="${cy + 12}" width="100" height="30" rx="15" fill="#1a1a22"/>
    ${text("Download", x + w - 78, cy + 32, 13, { anchor: "middle", weight: 700, fill: "#ffffff" })}
    ${text("Everyday Mac tools,", cx, cy + 128, 34, { anchor: "middle", weight: 900, fill: "#1a1a22" })}
    ${text("one menu bar away.", cx, cy + 170, 34, { anchor: "middle", weight: 900, fill: "#f5941d" })}
    ${text("Screenshots, clipboard, color picker & more.", cx, cy + 204, 14, { anchor: "middle", weight: 600, fill: "#6b6675" })}
    <rect x="${cx - 170}" y="${cy + 234}" width="160" height="44" rx="12" fill="${PICK_HEX}"/>
    ${text("Get Mac Kit", cx - 90, cy + 262, 15, { anchor: "middle", weight: 800, fill: "#ffffff" })}
    <rect x="${cx + 10}" y="${cy + 234}" width="160" height="44" rx="12" fill="#ffffff" stroke="#d6d3dd"/>
    ${text("See features", cx + 90, cy + 262, 15, { anchor: "middle", weight: 800, fill: "#1a1a22" })}
  </g>`;
}

// AI assistant chat window
const AW = { x: 150, y: 604, w: 512, h: 356 };
function aiWindow() {
  const { x, y, w, h } = AW;
  const { top, cy } = windowChrome(x, y, w, h, "Assistant");
  const bubble = (bx, by, bw, bh, fill, stroke) => `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="13" fill="${fill}" stroke="${stroke}"/>`;
  const line = (lx, ly, lw, col) => `<rect x="${lx}" y="${ly}" width="${lw}" height="7" rx="3.5" fill="${col}"/>`;
  return `<g filter="url(#winShadow)">
    ${top}
    <circle cx="${x + 34}" cy="${cy + 30}" r="15" fill="${ACC_SUB}"/>
    ${bolt(x + 26, cy + 21, 18, ACC)}
    ${bubble(x + 58, cy + 14, w - 150, 62, "#f2f0f6", "#e6e3ec")}
    ${line(x + 74, cy + 30, w - 200, "#c7c3cf")}
    ${line(x + 74, cy + 46, w - 240, "#d6d2dd")}
    ${bubble(x + 120, cy + 92, w - 150, 74, ACC, "none")}
    ${line(x + 138, cy + 110, w - 220, "rgba(255,255,255,0.85)")}
    ${line(x + 138, cy + 126, w - 190, "rgba(255,255,255,0.65)")}
    ${line(x + 138, cy + 142, w - 250, "rgba(255,255,255,0.5)")}
    <rect x="${x + 20}" y="${y + h - 52}" width="${w - 40}" height="36" rx="18" fill="#f2f0f6" stroke="#e2dfe8"/>
    ${text("Ask anything…", x + 40, y + h - 29, 13, { weight: 600, fill: "#9a96a2" })}
    <circle cx="${x + w - 40}" cy="${y + h - 34}" r="14" fill="${ACC}"/>
    ${rSend(x + w - 49, y + h - 43, 18, "#ffffff")}
  </g>`;
}

// Notes window
const NW = { x: 1214, y: 556, w: 456, h: 404 };
function notesWindow() {
  const { x, y, w, h } = NW;
  const { top, cy } = windowChrome(x, y, w, h, "Notes");
  let rows = "";
  const items = [[true, 0.66], [true, 0.5], [false, 0.74], [false, 0.58], [false, 0.44]];
  items.forEach(([done, frac], i) => {
    const ry = cy + 44 + i * 40;
    rows += `<rect x="${x + 28}" y="${ry}" width="20" height="20" rx="6" fill="${done ? ACC : "#ffffff"}" stroke="${done ? ACC : "#d6d3dd"}"/>`;
    if (done) rows += icon(x + 30, ry + 2, 16, "#ffffff", `<path d="M4 10 L8.5 14 L16 5"/>`);
    rows += `<rect x="${x + 60}" y="${ry + 4}" width="${(w - 110) * frac}" height="9" rx="4.5" fill="${done ? "#cbc7d3" : "#3a3742"}"/>`;
  });
  return `<g filter="url(#winShadow)">
    ${top}
    ${text("To-do", x + 28, cy + 26, 20, { weight: 900, fill: "#1a1a22" })}
    ${rows}
  </g>`;
}

function desktopWindows() {
  return `${browserWindow()}${aiWindow()}${notesWindow()}`;
}

// ---- Menu bar ----
function menuBar(iconHot) {
  return `<g>
    <rect x="0" y="0" width="${WIDTH}" height="${MB_H}" fill="rgba(20,20,26,0.55)"/>
    <line x1="0" y1="${MB_H}" x2="${WIDTH}" y2="${MB_H}" stroke="rgba(255,255,255,0.08)"/>
    ${text("Finder", 40, 26, 18, { weight: 800, fill: "#ffffff" })}
    ${text("File", 128, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    ${text("Edit", 188, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    ${text("View", 248, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    <rect x="${ICON_CX - 18}" y="4" width="36" height="32" rx="9" fill="${iconHot ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0)"}"/>
    ${bolt(ICON_CX - 11, ICON_CY - 12, 24, "#ffffff")}
    ${text("94%", 1745, 26, 17, { weight: 700, fill: ink })}
    ${text("3:51 PM", 1812, 26, 17, { weight: 700, fill: ink })}
  </g>`;
}

// ---- Menu-bar popover ("pet") — kept visually identical to the launch promo ----
const POP_OPEN = 2.1;
const POP_CLOSE = 3.35;
function popoverState(t) {
  return easeOutCubic(between(t, POP_OPEN, POP_OPEN + 0.26)) * (1 - easeOutCubic(between(t, POP_CLOSE, POP_CLOSE + 0.26)));
}
// Screenshot buttons are laid out at these local (x,y); the card group is shifted
// by -16. Return the screen-space center of a button so the cursor can click it.
const SHOT_BTNS = { Full: [1040, 160], Area: [1206, 160], Window: [1040, 204], Record: [1206, 204] };
function shotBtnCenter(name) {
  const [bx, by] = SHOT_BTNS[name];
  const baseX = bx + 75 - 16 + CDX + POP_DX;
  const baseY = by + 17 + CDY;
  return [ICON_CX + POP_SCALE * (baseX - ICON_CX), PY + POP_SCALE * (baseY - PY)];
}
// shotHi: index of highlighted screenshot button — 0 Full, 1 Area, 2 Window, 3 Record.
function popover(t) {
  const op = popoverState(t);
  if (op <= 0) return "";
  const grow = easeOutBack(op);
  const scale = lerp(0.94, 1, grow) * POP_SCALE;
  const dy = lerp(-16, 0, easeOutCubic(op));
  const originX = ICON_CX;
  const originY = PY;

  let shotHi = -1;
  if (t > 2.9 && t < 3.35) shotHi = 1; // Area

  const rows = ["https://mackit.rojhot.com", "~/Desktop/region.png", PICK_HEX, "hello@rojhot.com", "Meeting notes"];
  const clip = rows.map((item, i) => {
    const y = 168 + i * 44;
    return `<rect x="664" y="${y}" width="296" height="34" rx="9" fill="rgba(0,0,0,0.24)" stroke="rgba(255,255,255,0.09)"/>
      ${text(item, 680, y + 22, 15, { weight: 600, fill: "#c8c3cd", family: mono })}
      ${mbCopy(936, y + 10, 15, "#8f8b96")}`;
  }).join("");

  const shotBtns = [["Full", 1040, 160], ["Area", 1206, 160], ["Window", 1040, 204], ["Record", 1206, 204]]
    .map(([l, x, y], i) => {
      const on = i === shotHi;
      return `<rect x="${x}" y="${y}" width="150" height="34" rx="10" fill="${on ? "rgba(255,159,28,0.22)" : "rgba(255,255,255,0.07)"}" stroke="${on ? orange : "rgba(255,255,255,0.12)"}"/>
        ${text(l, x + 75, y + 22, 16, { anchor: "middle", weight: 800, fill: on ? ink : "#d9d5dc" })}`;
    }).join("");

  const popBg = "rgba(60,60,63,0.72)";
  const cardBg = "rgba(255,255,255,0.05)";
  const cardBorder = "rgba(255,255,255,0.1)";
  return `<g opacity="${op}" filter="url(#popShadow)" transform="translate(${originX} ${originY}) scale(${scale}) translate(${-originX} ${-originY + dy})">
    <g transform="translate(${POP_DX} 0)">
    <rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="22" fill="${popBg}" stroke="rgba(255,255,255,0.14)"/>
    <g transform="translate(${CDX} ${CDY})">

    <rect x="648" y="112" width="328" height="300" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${mbClipboard(666, 126, 19)}
    ${text("Clipboard", 694, 144, 20, { weight: 800 })}
    ${clip}

    <rect x="648" y="428" width="328" height="128" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${mbTimer(666, 442, 19)}
    ${text("Pomodoro", 694, 460, 20, { weight: 800 })}
    <circle cx="672" cy="494" r="5" fill="#ff4d4d"/>
    ${text("WORK", 690, 500, 15, { weight: 800, fill: muted, spacing: 3 })}
    ${text("25:00", 952, 502, 30, { anchor: "end", weight: 900, fill: orange, family: mono })}
    <rect x="664" y="516" width="32" height="34" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>
    ${mbMinus(671, 523, 18, "#d9d5dc")}
    <rect x="702" y="516" width="220" height="34" rx="10" fill="${orange}"/>
    ${text("Start", 812, 539, 17, { anchor: "middle", weight: 900, fill: "#16131a" })}
    <rect x="928" y="516" width="32" height="34" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>
    ${mbPlus(935, 523, 18, "#d9d5dc")}

    <g transform="translate(-16 0)">
    <rect x="1016" y="112" width="360" height="154" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${mbCamera(1034, 126, 19)}
    ${text("Screenshot", 1062, 144, 20, { weight: 800 })}
    ${shotBtns}

    <rect x="1016" y="282" width="360" height="224" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${mbDroplet(1034, 296, 19)}
    ${text("Color Picker", 1062, 314, 20, { weight: 800 })}
    <rect x="1040" y="330" width="48" height="48" rx="11" fill="#f0eef4" stroke="rgba(255,255,255,0.18)"/>
    ${text("#F4F2ED", 1104, 364, 26, { weight: 900, family: mono })}
    ${["HEX", "RGB", "HSL"].map((l, i) => `<rect x="${1040 + i * 108}" y="394" width="96" height="34" rx="9" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.1)"/>${text(l, 1088 + i * 108, 416, 14, { anchor: "middle", weight: 900, fill: "#d9d5dc", spacing: 2 })}`).join("")}
    <rect x="1040" y="440" width="312" height="44" rx="12" fill="${orange}"/>
    ${text("Pick Color", 1196, 468, 17, { anchor: "middle", weight: 900, fill: "#16131a" })}

    <rect x="1340" y="520" width="36" height="36" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>
    ${mbPlus(1349, 529, 18, "#d9d5dc")}
    </g>
    </g>
    </g>
  </g>`;
}
// ---- Quick Access ring (faithful to QuickActionOverlay.tsx) ----
const RING_CX = 900;
const RING_CY = 560;
const RING_SCALE = 1.62;
const L_CENTER = 230;
const L_RADIUS = 102;
const L_SLOT = 76;
const RING_OPEN = 6.7;
const RING_CLOSE = 8.4;
const SHOT_SLOT_HL = [7.6, 8.3]; // screenshot slot highlight window

function ringAppear(t) {
  return easeOutBack(between(t, RING_OPEN, RING_OPEN + 0.22)) * (1 - easeOutCubic(between(t, RING_CLOSE, RING_CLOSE + 0.22)));
}
function ringOpacity(t) {
  return fade(t, RING_OPEN, RING_OPEN + 0.18, RING_CLOSE, RING_CLOSE + 0.2);
}
function slotLocal(index) {
  const a = (-90 + index * 60) * (Math.PI / 180);
  return { x: L_CENTER + L_RADIUS * Math.cos(a), y: L_CENTER + L_RADIUS * Math.sin(a) };
}
function ringToAbs(lx, ly) {
  return [RING_CX + (lx - L_CENTER) * RING_SCALE, RING_CY + (ly - L_CENTER) * RING_SCALE];
}
function slotAbs(index) {
  const s = slotLocal(index);
  return ringToAbs(s.x, s.y);
}
const CLIP_PANEL = { w: 150, h: 126, left: 280, top: 243 };
const CLIP_ROWS = ["mackit.rojhot.com", "#3B82F6", "Meeting notes — Q3"];
const RING_SLOTS = [
  { id: "screenshot", label: "Screenshot", icon: rCamera },
  { id: "area", label: "Area", icon: rCrop },
  { id: "clipboard", label: "Clipboard", icon: rClipboard },
  { id: "caffeine", label: "Keep Awake", icon: rCoffee },
  { id: "color-picker", label: "Color Picker", icon: rPipette },
  { id: "screen-draw", label: "Screen Draw", icon: rBrush },
];
function shotSlotAmt(t) {
  return fade(t, SHOT_SLOT_HL[0], SHOT_SLOT_HL[0] + 0.2, SHOT_SLOT_HL[1] - 0.1, SHOT_SLOT_HL[1]);
}
function ringInner(t) {
  let slotSvg = "";
  RING_SLOTS.forEach((slot, index) => {
    const s = slotLocal(index);
    if (slot.id === "clipboard") return;
    const hov = index === 0 ? shotSlotAmt(t) : 0;
    const sc = lerp(1, 1.08, hov);
    const bg = hov > 0.5 ? "rgba(28,28,32,.94)" : "rgba(18,18,20,.86)";
    const border = hov > 0.5 ? ACC : "rgba(255,255,255,0.14)";
    const left = s.x - L_SLOT / 2;
    const top = s.y - L_SLOT / 2;
    slotSvg += `<g transform="translate(${s.x} ${s.y}) scale(${sc.toFixed(3)}) translate(${-s.x} ${-s.y})">
      <rect x="${left}" y="${top}" width="${L_SLOT}" height="${L_SLOT}" rx="18" fill="${bg}" stroke="${border}" stroke-width="${hov > 0.5 ? 2 : 1}"/>
      ${slot.icon(s.x - 11, s.y - 20, 22, ACC)}
      ${text(slot.label, s.x, s.y + 22, 8.5, { anchor: "middle", weight: 650, fill: "#e9e7ee", spacing: -0.2 })}
    </g>`;
  });

  const cp = CLIP_PANEL;
  let clipRows = "";
  CLIP_ROWS.forEach((item, i) => {
    const ry = cp.top + 6 + 19 + 3 + i * 31;
    clipRows += `<rect x="${cp.left + 6}" y="${ry}" width="${cp.w - 12}" height="28" rx="7" fill="rgba(28,28,32,.82)" stroke="rgba(255,255,255,0.14)"/>
      <clipPath id="cliprow${i}"><rect x="${cp.left + 12}" y="${ry}" width="${cp.w - 42}" height="28"/></clipPath>
      <g clip-path="url(#cliprow${i})">${text(item, cp.left + 14, ry + 17.5, 9.5, { weight: 600, fill: "#c8c3cd", family: mono })}</g>
      ${rCopy(cp.left + cp.w - 23, ry + 7.5, 13, "#7d7986")}`;
  });
  const panel = `<rect x="${cp.left}" y="${cp.top}" width="${cp.w}" height="${cp.h}" rx="14" fill="rgba(18,18,20,.9)" stroke="rgba(255,255,255,0.14)"/>
    ${rClipboard(cp.left + 8, cp.top + 8, 14, ACC)}
    ${text("Clipboard", cp.left + 27, cp.top + 20, 11, { weight: 800, fill: "#e9e7ee" })}
    ${clipRows}`;

  const center = `<circle cx="${L_CENTER}" cy="${L_CENTER}" r="34" fill="rgba(18,18,20,.9)" stroke="rgba(255,255,255,0.16)"/>
    ${rPointer(L_CENTER - 11, L_CENTER - 11.5, 22, ACC)}`;

  return `${panel}${slotSvg}${center}`;
}
function quickRing(t) {
  const op = ringOpacity(t);
  if (op <= 0) return "";
  const appear = ringAppear(t);
  const sc = lerp(0.72, 1, appear) * RING_SCALE;
  return `<g opacity="${op.toFixed(3)}" filter="url(#ringShadow)" transform="translate(${RING_CX} ${RING_CY}) scale(${sc.toFixed(4)}) translate(${-L_CENTER} ${-L_CENTER})">
    ${ringInner(t)}
  </g>`;
}
function scrim(t) {
  const op = fade(t, RING_OPEN, RING_OPEN + 0.25, RING_CLOSE, RING_CLOSE + 0.2) * 0.42;
  if (op <= 0) return "";
  return `<rect width="${WIDTH}" height="${HEIGHT}" fill="#0a0a12" opacity="${op.toFixed(3)}"/>`;
}

// ---- Shortcut keycap prompt ----
const KEY_IN = 5.8;
const KEY_PRESS = 6.5;
const KEY_OUT = 6.75;
function keycap(cx, cy, w, label, sub, press) {
  const depth = lerp(8, 2, press);
  const dip = press * 5;
  const topFill = press > 0.4 ? "#242732" : "#2c2f3b";
  const glowOp = 0.06 + press * 0.12;
  return `<g filter="url(#keyShadow)">
    <rect x="${cx - w / 2}" y="${cy - 34 + depth}" width="${w}" height="${68 - depth}" rx="15" fill="#15161c"/>
    <g transform="translate(0 ${dip.toFixed(2)})">
      <rect x="${cx - w / 2}" y="${cy - 34}" width="${w}" height="60" rx="15" fill="${topFill}" stroke="${press > 0.4 ? ACC : "rgba(255,255,255,0.14)"}" stroke-width="${press > 0.4 ? 1.6 : 1}"/>
      <rect x="${cx - w / 2 + 5}" y="${cy - 30}" width="${w - 10}" height="22" rx="10" fill="rgba(255,255,255,${glowOp.toFixed(3)})"/>
      ${text(label, cx, cy + (sub ? -2 : 6), 26, { anchor: "middle", weight: 900, fill: "#f4f3f7" })}
      ${sub ? text(sub, cx, cy + 18, 11, { anchor: "middle", weight: 800, fill: "#9a97a8", spacing: 1 }) : ""}
    </g>
  </g>`;
}
function shortcutPrompt(t) {
  const op = fade(t, KEY_IN, KEY_IN + 0.3, KEY_OUT, KEY_OUT + 0.25);
  if (op <= 0) return "";
  const press = easeOutCubic(clamp((t - KEY_PRESS) / 0.12, 0, 1));
  const rise = lerp(18, 0, easeOutCubic(between(t, KEY_IN, KEY_IN + 0.35)));
  const cx = RING_CX;
  const cy = 300;
  return `<g opacity="${op.toFixed(3)}" transform="translate(0 ${rise.toFixed(1)})">
    ${keycap(cx - 96, cy, 112, "⌥", "OPTION", press)}
    ${text("+", cx, cy + 8, 30, { anchor: "middle", weight: 800, fill: "#ffffff" })}
    ${keycap(cx + 108, cy, 176, "Space", "", press)}
    ${text("Press your shortcut", cx, cy + 74, 20, { anchor: "middle", weight: 700, fill: "rgba(255,255,255,0.85)" })}
  </g>`;
}

// ---- Area selection + capture preview stack ----
// Menu-bar scene uses only the Screenshot "Area" tool: dim the screen, drag a
// region, capture it. Then Quick Access takes a full screenshot. Each new shot
// lands at the bottom-right corner (slot 0) and pushes older previews upward,
// exactly like showCapturePreview() -> unshift + layout.
const AREA_IN = 3.3;
const AREA_DRAG0 = 3.55;
const AREA_CAP = 4.55; // area selection captured
const AREA_OUT = 4.75;
const SEL_A = [300, 300];
const SEL_B = [800, 540];
const QA_CAP = 8.3; // Quick Access screenshot captured

const CARD_ADDS = [
  { t: AREA_CAP + 0.15, thumb: thumbBrowser }, // menu-bar Area capture (Mac Kit window region)
  { t: QA_CAP + 0.1, thumb: thumbDesktop }, // Quick Access full screenshot
];

function thumbBrowser(ix, iy, iw, ih, id) {
  const bar = ih * 0.16;
  return `<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" fill="#ffffff"/>
    <rect x="${ix}" y="${iy}" width="${iw}" height="${bar}" fill="#eceaf0"/>
    <circle cx="${ix + 12}" cy="${iy + bar / 2}" r="3" fill="#ff5f57"/>
    <circle cx="${ix + 24}" cy="${iy + bar / 2}" r="3" fill="#febc2e"/>
    <circle cx="${ix + 36}" cy="${iy + bar / 2}" r="3" fill="#28c840"/>
    <rect x="${ix + iw / 2 - 44}" y="${iy + bar / 2 - 5}" width="88" height="10" rx="5" fill="#ffffff" stroke="#d6d3dd"/>
    ${text("Everyday Mac tools,", ix + iw / 2, iy + ih * 0.5, 16, { anchor: "middle", weight: 900, fill: "#1a1a22" })}
    ${text("one menu bar away.", ix + iw / 2, iy + ih * 0.66, 16, { anchor: "middle", weight: 900, fill: "#f5941d" })}
    <rect x="${ix + iw / 2 - 52}" y="${iy + ih * 0.76}" width="48" height="16" rx="8" fill="${PICK_HEX}"/>
    <rect x="${ix + iw / 2 + 4}" y="${iy + ih * 0.76}" width="48" height="16" rx="8" fill="#ffffff" stroke="#d6d3dd"/>`;
}
function thumbDesktop(ix, iy, iw, ih, id) {
  const win = (wx, wy, ww, wh, fill = "#ffffff") => `<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" rx="4" fill="${fill}"/><rect x="${wx}" y="${wy}" width="${ww}" height="6" rx="3" fill="#e2dfe8"/>`;
  return `<clipPath id="dth${id}"><rect x="${ix}" y="${iy}" width="${iw}" height="${ih}"/></clipPath>
    <g clip-path="url(#dth${id})">
      <rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" fill="url(#wall)"/>
      <rect x="${ix}" y="${iy}" width="${iw}" height="7" fill="rgba(20,20,26,0.55)"/>
      ${win(ix + iw * 0.06, iy + ih * 0.22, iw * 0.42, ih * 0.4)}
      ${win(ix + iw * 0.56, iy + ih * 0.16, iw * 0.36, ih * 0.34, "#ffffff")}
      ${win(ix + iw * 0.12, iy + ih * 0.62, iw * 0.34, ih * 0.3)}
      ${win(ix + iw * 0.62, iy + ih * 0.58, iw * 0.3, ih * 0.32)}
    </g>`;
}

function previewStack(t) {
  const visible = CARD_ADDS.map((c, i) => ({ ...c, i })).filter((c) => t >= c.t - 0.02);
  if (!visible.length) return "";
  let out = "";
  visible.forEach((card) => {
    // slot index grows as each newer card slides in (older cards ride upward).
    let slot = 0;
    for (const other of CARD_ADDS) {
      if (other.t > card.t) slot += easeOutCubic(between(t, other.t, other.t + 0.32));
    }
    const appear = easeOutCubic(between(t, card.t, card.t + 0.36));
    if (appear <= 0) return;
    const isNewest = card.i === visible[visible.length - 1].i;
    const y = CARD_BOTTOM_Y - slot * (CARD_H + CARD_GAP);
    const enterOff = (1 - appear) * 18;
    const sc = lerp(0.92, 1, appear);
    const cardX = CARD_RIGHT_X;
    const ox = cardX + CARD_W / 2;
    const oy = y + CARD_H / 2;
    const border = isNewest ? `${ACC}` : "rgba(255,255,255,0.16)";
    const borderW = isNewest ? 1.5 : 1;
    out += `<g opacity="${appear.toFixed(3)}" filter="url(#cardShadow)" transform="translate(${enterOff.toFixed(1)} ${enterOff.toFixed(1)})">
      <g transform="translate(${ox} ${oy}) scale(${sc.toFixed(3)}) translate(${-ox} ${-oy})">
        <clipPath id="cardclip${card.i}"><rect x="${cardX}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12"/></clipPath>
        <g clip-path="url(#cardclip${card.i})">
          <rect x="${cardX}" y="${y}" width="${CARD_W}" height="${CARD_H}" fill="rgba(18,18,20,0.92)"/>
          ${card.thumb(cardX, y, CARD_W, CARD_H, card.i)}
        </g>
        <rect x="${cardX}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="12" fill="none" stroke="${border}" stroke-width="${borderW}"/>
      </g>
    </g>`;
  });
  return out;
}

// Screenshot "Area": dim the screen and drag a selection rectangle, then flash.
function areaOverlay(t) {
  const op = fade(t, AREA_IN, AREA_IN + 0.15, AREA_CAP + 0.06, AREA_OUT);
  if (op <= 0) return "";
  const dragP = easeInOutCubic(between(t, AREA_DRAG0, AREA_CAP));
  const ex = lerp(SEL_A[0], SEL_B[0], dragP);
  const ey = lerp(SEL_A[1], SEL_B[1], dragP);
  const rx = Math.min(SEL_A[0], ex);
  const ry = Math.min(SEL_A[1], ey);
  const rw = Math.abs(ex - SEL_A[0]);
  const rh = Math.abs(ey - SEL_A[1]);
  const flash = easeOutCubic(between(t, AREA_CAP - 0.02, AREA_CAP + 0.08)) * (1 - easeOutCubic(between(t, AREA_CAP + 0.08, AREA_CAP + 0.28)));
  const dragging = t > AREA_DRAG0;
  return `<g opacity="${op}">
    <rect x="0" y="${MB_H}" width="${WIDTH}" height="${HEIGHT - MB_H}" fill="rgba(10,12,20,0.42)"/>
    ${dragging ? `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="rgba(255,255,255,0.10)" stroke="${ACC}" stroke-width="2.5" stroke-dasharray="9 7"/>
      ${text(`${Math.round(rw)} × ${Math.round(rh)}`, rx + rw / 2, ry - 12, 20, { anchor: "middle", weight: 800, fill: "#fff" })}
      <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="#ffffff" opacity="${(flash * 0.7).toFixed(3)}"/>` : ""}
    <line x1="${ex}" y1="${MB_H}" x2="${ex}" y2="${HEIGHT}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>
    <line x1="0" y1="${ey}" x2="${WIDTH}" y2="${ey}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>
  </g>`;
}

// Brief full-screen white flash for the Quick Access screenshot capture.
function captureFlash(t) {
  const op = easeOutCubic(between(t, QA_CAP - 0.12, QA_CAP)) * (1 - easeOutCubic(between(t, QA_CAP, QA_CAP + 0.22)));
  if (op <= 0) return "";
  return `<rect x="0" y="${MB_H}" width="${WIDTH}" height="${HEIGHT - MB_H}" fill="#ffffff" opacity="${(op * 0.5).toFixed(3)}"/>`;
}

// ---- Cursor ----
const CURSOR_KEYS = (() => {
  const areaBtn = shotBtnCenter("Area"); // Screenshot "Area" button center
  const s0 = slotAbs(0); // screenshot slot (top of ring)
  return [
    [0.0, 900, 780],
    [1.4, 1300, 470],
    [2.2, ICON_CX, ICON_CY], // click menu-bar icon
    [3.1, areaBtn[0], areaBtn[1]], // click Area
    [3.55, SEL_A[0], SEL_A[1]], // move to selection start
    [4.55, SEL_B[0], SEL_B[1]], // drag out the region
    [5.3, 980, 600], // drift toward where the ring opens
    [6.4, RING_CX, RING_CY], // settle for the shortcut press
    [7.1, RING_CX, RING_CY],
    [7.7, s0[0], s0[1]], // hover Screenshot slot
    [8.3, s0[0], s0[1]], // click it
    [8.9, s0[0] + 60, s0[1] + 40],
  ];
})();
const CLICK_TIMES = [2.2, 3.1, 8.3];
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
  const op = fade(t, 0.0, 0.5, RING_CLOSE + 0.4, RING_CLOSE + 0.8);
  if (op <= 0) return "";
  const [x, y] = cursorPos(t);
  let ripples = "";
  for (const ct of CLICK_TIMES) {
    const rp = (t - ct) / 0.45;
    if (rp >= 0 && rp <= 1) {
      const r = 8 + rp * 26;
      ripples += `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${ACC}" stroke-width="${3.2 * (1 - rp)}" opacity="${(1 - rp) * 0.9}"/>`;
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
    [0.6, 2.0, "Capture from the menu bar."],
    [3.3, 4.7, "Grab any area of the screen."],
    [6.7, 8.3, "Or snap one from Quick Access."],
    [8.6, 9.8, "Every shot stacks in the corner."],
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
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${border}"/>
    ${text(label, x + w / 2, y + h / 2 + 7, 22, { fill: color, weight: 700, anchor: "middle" })}
  </g>`;
}
const CTA_IN = 10.3;
function cta(t) {
  const bgOp = clamp((t - CTA_IN) / 0.25, 0, 1);
  if (bgOp <= 0) return "";
  const accent = "#2f6bff";
  const pillOpts = { fill: "#ffffff", color: "#6d6b66", border: "rgba(5,5,5,0.12)" };
  const pulse = 0.5 + 0.5 * Math.sin((t - (CTA_IN + 0.3)) * Math.PI * 2 / 1.2);
  const btnScale = lerp(1, 1.04, pulse);
  const glowOp = lerp(0.1, 0.5, pulse);
  const rev = (delay) => {
    const p = easeOutCubic(clamp((t - (CTA_IN + 0.3 + delay)) / 0.5, 0, 1));
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
      ${text("Screenshots, always one click away.", 960, 484, 60, { anchor: "middle", weight: 900, fill: "#050505" })}
    </g>
    <g ${rev(0.24)}>
      ${text("Capture from the menu bar or Quick Access — previews stack in the corner.", 960, 546, 27, { anchor: "middle", fill: "#6d6b66", weight: 600 })}
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

function frameSvg(index, storyTOverride = null) {
  const t = storyTOverride != null ? storyTOverride : storyTime(index / FPS);
  const sceneFade = fade(t, 0.2, 0.9);
  const scene = sceneFade > 0 ? `<g opacity="${sceneFade.toFixed(3)}">${desktopWindows()}</g>` : "";
  const iconHot = popoverState(t) > 0.05;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    ${defs()}
    ${wallpaper(t)}
    ${scene}
    ${scrim(t)}
    ${menuBar(iconHot)}
    ${popover(t)}
    ${areaOverlay(t)}
    ${shortcutPrompt(t)}
    ${quickRing(t)}
    ${captureFlash(t)}
    ${previewStack(t)}
    ${captions(t)}
    ${cursorLayer(t)}
    ${cta(t)}
  </svg>`;
}

// ---- Render pipeline ----
function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}
function writeStream(stream, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { stream.off("drain", onDrain); reject(error); };
    const onDrain = () => { stream.off("error", onError); resolve(); };
    stream.once("error", onError);
    if (stream.write(chunk)) { stream.off("error", onError); resolve(); }
    else { stream.once("drain", onDrain); }
  });
}
function renderPng(svg) {
  const result = spawnSync("rsvg-convert", ["-w", String(WIDTH), "-h", String(HEIGHT), "-f", "png"], {
    input: svg,
    maxBuffer: 80 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("rsvg-convert failed");
  return result.stdout;
}
function waitForProcess(child) {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`ffmpeg exited with code ${code}`)); });
  });
}
async function renderStills(times) {
  mkdirSync(OUT_DIR, { recursive: true });
  times.forEach((t) => {
    const outPath = join(OUT_DIR, `still-${String(t).replace(".", "_")}.png`);
    run("rsvg-convert", ["-w", String(WIDTH), "-h", String(HEIGHT), "-f", "png", "-o", outPath], {
      input: frameSvg(0, t),
      stdio: ["pipe", "inherit", "inherit"],
    });
    process.stdout.write(`Still written to ${outPath}\n`);
  });
}
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const ffmpeg = spawn("ffmpeg", [
    "-y", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-crf", "18",
    VIDEO_OUT,
  ], { stdio: ["pipe", "inherit", "inherit"] });

  const posterStory = 8.9;
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
    if ((i + 1) % 60 === 0) process.stdout.write(`Encoded ${i + 1}/${FRAMES} frames\n`);
  }
  ffmpeg.stdin.end();
  await waitForProcess(ffmpeg);
  process.stdout.write(`Video written to ${VIDEO_OUT}\n`);
  process.stdout.write(`Poster written to ${POSTER_OUT}\n`);
}

const stillArg = process.argv.indexOf("--stills");
if (stillArg !== -1) {
  const times = process.argv.slice(stillArg + 1).map(Number).filter((n) => !Number.isNaN(n));
  renderStills(times.length ? times : [1.0, 3.6, 5.0, 8.0, 9.2, 11.0]).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
