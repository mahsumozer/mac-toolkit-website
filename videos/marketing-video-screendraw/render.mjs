import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 25.5;
// Linger on key beats so the switch reads slower.
const HOLDS = [
  [2.9, 0.3], // Screen Draw fully enabled — brief ON read
  [21.2, 0.6], // annotations finished — hold on the result
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
const OUT_DIR = join(ROOT, "marketing-video-screendraw", "out");
const VIDEO_OUT = join(OUT_DIR, "mac-kit-screendraw-promo.mp4");
const POSTER_OUT = join(OUT_DIR, "mac-kit-screendraw-poster.png");

const orange = "#ff9f1c";
const ink = "#f7f3ea";
const mono = "SFMono-Regular, Menlo, monospace";
const sans = "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const PICK_HEX = "#5AA9FF";

// ---- Menu bar / icon ----
const MB_H = 40;
const ICON_CX = 1700;
const ICON_CY = 20;

// Window palette
const W_T1 = "rgba(247,247,250,0.92)";
const W_T2 = "rgba(255,255,255,0.55)";
const W_T3 = "rgba(255,255,255,0.35)";
const W_ACCENT = "#ff9f1c";
const W_ACCENT_SUB = "rgba(255,159,28,0.16)";
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
function iconPencil(x, y, size = 14, color = W_T2) {
  return icon(x, y, size, color, `<path d="M14 3 L17 6 L7 16 L4 16 L4 13 Z"/><line x1="12" y1="5" x2="15" y2="8"/>`);
}
function iconPlusW(x, y, size = 16, color = W_T1) {
  return icon(x, y, size, color, `<line x1="10" y1="5" x2="10" y2="15"/><line x1="5" y1="10" x2="15" y2="10"/>`);
}
function iconMinusW(x, y, size = 16, color = W_T1) {
  return icon(x, y, size, color, `<line x1="5" y1="10" x2="15" y2="10"/>`);
}
function iconBrush(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M11 3 L17 9 L11 12"/><path d="M4 16 C4 13 5.5 11.5 8 11.5 C9 11.5 10.5 12.5 10.5 14 C10.5 16 7.5 16.5 4 16 Z"/>`);
}
function iconEraser(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M4 13 L10 7 L15 12 L11 16 H6 Z"/><line x1="7" y1="16" x2="16" y2="16"/>`);
}
function iconReset(x, y, size = 20, color = W_T2) {
  return icon(x, y, size, color, `<path d="M4 10 A6 6 0 1 1 5.5 14"/><path d="M4 6 V10 H8"/>`);
}
function iconCursorTool(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M4 3 L4 15 L7.5 11.5 L10 16 L12 15 L9.5 10.5 L14 10 Z"/>`);
}
function iconLine(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<line x1="4" y1="15" x2="16" y2="5"/>`);
}
function iconBoxTool(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<rect x="4" y="6" width="12" height="9" rx="2"/>`);
}
function iconEllipse(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<ellipse cx="10" cy="10" rx="7" ry="5"/>`);
}
function iconTrash(x, y, size = 18, color = W_T2) {
  return icon(x, y, size, color, `<path d="M4 6 H16"/><path d="M6 6 V16 H14 V6"/><path d="M8 6 V4 H12 V6"/><line x1="8.5" y1="9" x2="8.5" y2="13"/><line x1="11.5" y1="9" x2="11.5" y2="13"/>`);
}
function iconClose(x, y, size = 18, color = "#ef4444") {
  return icon(x, y, size, color, `<line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/>`);
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
    <filter id="barShadow" x="-30%" y="-80%" width="160%" height="260%">
      <feDropShadow dx="0" dy="12" stdDeviation="20" flood-color="#000000" flood-opacity="0.42"/>
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

// ---- Quick-tools popover (left-click on the tray icon) ----
const POP_OPEN = 1.05;
const POP_CLOSE = 2.95;
const ENABLE_T = 2.5;
function popState(t) {
  return easeOutCubic(between(t, POP_OPEN, POP_OPEN + 0.22)) * (1 - easeOutCubic(between(t, POP_CLOSE, POP_CLOSE + 0.18)));
}
function toggleOn(t) {
  return easeOutCubic(between(t, ENABLE_T, ENABLE_T + 0.32));
}
function lightPopover(t) {
  const op = popState(t);
  if (op <= 0) return "";
  const PX = 640, PY = 48, PW = 760, PH = 478;
  const POP_SCALE = 0.8; // shrink the whole toolkit popover
  const POP_DX = ICON_CX - 1300;
  const CDX = 16, CDY = PY - 95;
  const muted = "#aaa5b2";
  const scale = POP_SCALE * lerp(0.94, 1, easeOutBack(op));
  const dy = lerp(-16, 0, easeOutCubic(op));
  const originX = ICON_CX;
  const originY = PY;

  const rows = [
    "https://usemackit.com",
    "~/Desktop/region.png",
    PICK_HEX,
    "hello@usemackit.com",
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

  // Screen Draw toggle — compact card in the right column (fits the grid)
  const on = toggleOn(t);
  const trackFill = on > 0.5 ? W_GREEN : "rgba(255,255,255,0.16)";
  const knobCx = lerp(1316, 1336, on);
  const sdCard = `
    <rect x="1016" y="514" width="360" height="42" rx="12" fill="${on > 0.5 ? "rgba(34,197,94,0.12)" : cardBg}" stroke="${on > 0.5 ? "rgba(34,197,94,0.4)" : cardBorder}"/>
    ${iconBrush(1030, 525, 20, on > 0.5 ? W_GREEN : orange)}
    ${text("Screen Draw", 1058, 540, 17, { weight: 800 })}
    ${text(on > 0.5 ? "ON" : "OFF", 1288, 540, 13, { anchor: "end", weight: 900, fill: on > 0.5 ? W_GREEN : muted, spacing: 1 })}
    <rect x="1300" y="524" width="52" height="24" rx="12" fill="${trackFill}" stroke="rgba(255,255,255,0.14)"/>
    <circle cx="${knobCx.toFixed(1)}" cy="536" r="10" fill="#ffffff"/>`;

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

    ${sdCard}
    </g>
    </g>
    </g>
  </g>`;
}

// ---- Menu bar ----
function menuBar(t) {
  const iconHot = popState(t) > 0.05;
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

// ---- On-screen website (the surface being annotated) — Mac Kit landing page ----
const BX = 560, BY = 250, BW = 800, BH = 476;
function websiteWindow() {
  const cy = BY + 44; // content top (below the title bar)
  const cx = BX + BW / 2; // 960
  return `<g filter="url(#winShadow)">
    <rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="18" fill="#ffffff"/>
    <rect x="${BX}" y="${BY}" width="${BW}" height="44" rx="18" fill="#eceaf0"/>
    <rect x="${BX}" y="${BY + 22}" width="${BW}" height="22" fill="#eceaf0"/>
    <circle cx="${BX + 26}" cy="${BY + 22}" r="7" fill="#ff5f57"/>
    <circle cx="${BX + 48}" cy="${BY + 22}" r="7" fill="#febc2e"/>
    <circle cx="${BX + 70}" cy="${BY + 22}" r="7" fill="#28c840"/>
    <rect x="${BX + 150}" y="${BY + 12}" width="${BW - 300}" height="24" rx="12" fill="#ffffff" stroke="#d6d3dd"/>
    <path d="M${BX} ${cy} H${BX + BW} V${BY + BH - 18} A18 18 0 0 1 ${BX + BW - 18} ${BY + BH} H${BX + 18} A18 18 0 0 1 ${BX} ${BY + BH - 18} Z" fill="#ffffff"/>

    <!-- Nav -->
    <rect x="${BX + 36}" y="${cy + 14}" width="26" height="26" rx="7" fill="#ffffff" stroke="#dcd8e2"/>
    ${bolt(BX + 41, cy + 17, 16, "#16131a")}
    ${text("Mac Kit", BX + 72, cy + 33, 18, { weight: 900, fill: "#1a1a22" })}
    ${text("Features", BX + 470, cy + 32, 14, { weight: 600, fill: "#6b6675" })}
    ${text("Pricing", BX + 560, cy + 32, 14, { weight: 600, fill: "#6b6675" })}
    <rect x="${BX + BW - 150}" y="${cy + 10}" width="118" height="34" rx="17" fill="#1a1a22"/>
    ${text("Download", BX + BW - 91, cy + 32, 14, { anchor: "middle", weight: 700, fill: "#ffffff" })}
    <line x1="${BX}" y1="${cy + 56}" x2="${BX + BW}" y2="${cy + 56}" stroke="#eceaf0" stroke-width="1.5"/>

    <!-- Hero -->
    <rect x="${cx - 114}" y="${cy + 80}" width="228" height="30" rx="15" fill="#fdf2e2" stroke="#f3ddba"/>
    ${text("New · Pomodoro timer", cx, cy + 100, 13, { anchor: "middle", weight: 800, fill: "#b06a10" })}
    ${text("Everyday Mac tools,", cx, cy + 164, 40, { anchor: "middle", weight: 900, fill: "#1a1a22" })}
    ${text("one menu bar away.", cx, cy + 212, 40, { anchor: "middle", weight: 900, fill: "#f5941d" })}
    ${text("Screenshots, clipboard, color picker & pomodoro — one click away.", cx, cy + 250, 16, { anchor: "middle", weight: 600, fill: "#6b6675" })}
    <rect x="${cx - 196}" y="${cy + 290}" width="186" height="50" rx="13" fill="${PICK_HEX}"/>
    ${text("Get Mac Kit", cx - 103, cy + 322, 17, { anchor: "middle", weight: 800, fill: "#ffffff" })}
    <rect x="${cx + 10}" y="${cy + 290}" width="186" height="50" rx="13" fill="#ffffff" stroke="#d6d3dd"/>
    ${text("See features", cx + 103, cy + 322, 17, { anchor: "middle", weight: 800, fill: "#1a1a22" })}
  </g>`;
}

// Clean hand-drawn arrow: shaft reveals first, then two barbs aligned to the shaft.
function arrow(t, x1, y1, x2, y2, color, w, start, end, headLen = 26) {
  const p = between(t, start, end);
  if (p <= 0) return "";
  const common = `fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
  const shaftLen = Math.hypot(x2 - x1, y2 - y1);
  const ep = easeInOutCubic(p);
  const shaftOff = (shaftLen * (1 - ep)).toFixed(1);
  let s = `<path d="M${x1} ${y1} L${x2} ${y2}" ${common} stroke-dasharray="${shaftLen.toFixed(1)}" stroke-dashoffset="${shaftOff}"/>`;
  const hp = between(t, start + (end - start) * 0.7, end);
  if (hp > 0) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const spread = 0.44;
    const bx1 = (x2 - headLen * Math.cos(ang - spread)).toFixed(1);
    const by1 = (y2 - headLen * Math.sin(ang - spread)).toFixed(1);
    const bx2 = (x2 - headLen * Math.cos(ang + spread)).toFixed(1);
    const by2 = (y2 - headLen * Math.sin(ang + spread)).toFixed(1);
    const hLen = headLen * 2;
    const hOff = (hLen * (1 - easeOutCubic(hp))).toFixed(1);
    s += `<path d="M${bx1} ${by1} L${x2} ${y2} L${bx2} ${by2}" ${common} stroke-dasharray="${hLen.toFixed(1)}" stroke-dashoffset="${hOff}"/>`;
  }
  return s;
}

// Ellipse annotation geometry, shared by the reveal and the cursor that traces it.
const ELLIPSE = { cx: 857, cy: 609, rx: 114, ry: 36, rot: -6, start: 15.5, end: 16.9 };
function ellipsePoint(f) {
  // f in 0..1: clockwise sweep starting at the top (12 o'clock).
  const a = -Math.PI / 2 + f * Math.PI * 2;
  const px = ELLIPSE.rx * Math.cos(a);
  const py = ELLIPSE.ry * Math.sin(a);
  const r = (ELLIPSE.rot * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return [ELLIPSE.cx + px * cos - py * sin, ELLIPSE.cy + px * sin + py * cos];
}
function ellipsePath(f) {
  const n = Math.max(2, Math.ceil(f * 72));
  let d = "";
  for (let i = 0; i <= n; i += 1) {
    const [x, y] = ellipsePoint((f * i) / n);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
  }
  return d.trim();
}

// ---- Annotations: a showcase of drawing tools on the live page ----
// Each stroke reveals via dash-offset so it looks hand-drawn in real time.
function annotations(t) {
  let s = "";
  const draw = (d, color, w, len, start, end, dash = true) => {
    const p = between(t, start, end);
    if (p <= 0) return "";
    const common = `fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
    if (!dash) return `<path d="${d}" ${common} opacity="${easeOutCubic(p).toFixed(3)}"/>`;
    const off = (len * (1 - easeInOutCubic(p))).toFixed(1);
    return `<path d="${d}" ${common} stroke-dasharray="${len}" stroke-dashoffset="${off}"/>`;
  };
  // 1) Pen — wavy green underline beneath the orange headline
  s += draw("M800 520 Q880 508 960 520 T1120 520", "#22c55e", 5, 340, 5.8, 7.2);
  // 2) Line — red arrow pointing up to the "New · Pomodoro timer" badge
  s += arrow(t, 1235, 466, 1080, 392, "#ef4444", 5, 9.1, 10.4);
  // 3) Box — blue rectangle grows from the fixed corner to the cursor corner
  s += (() => {
    const p = between(t, 12.3, 13.6);
    if (p <= 0) return "";
    const e = easeInOutCubic(p);
    const x0 = 1204, y0 = 300, x1 = 1338, y1 = 342;
    const cxp = lerp(x0, x1, e), cyp = lerp(y0, y1, e);
    const rx = Math.min(x0, cxp), ry = Math.min(y0, cyp);
    const rw = Math.abs(cxp - x0), rh = Math.abs(cyp - y0);
    return `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${rw.toFixed(1)}" height="${rh.toFixed(1)}" fill="none" stroke="#5AA9FF" stroke-width="5" stroke-linejoin="round"/>`;
  })();
  // 4) Ellipse — orange circle traced clockwise, cursor riding the leading tip
  s += (() => {
    const p = between(t, ELLIPSE.start, ELLIPSE.end);
    if (p <= 0) return "";
    const f = easeInOutCubic(p);
    return `<path d="${ellipsePath(f)}" fill="none" stroke="#ff9f1c" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  })();
  // 5) Freehand marks OUTSIDE the window — annotate anywhere on the desktop
  s += draw("M300 560 L360 632 L472 468", "#ff9f1c", 8, 260, 18.1, 19.3);            // orange check
  s += draw("M380 290 L409 381 L333 325 L428 325 L351 381 Z", "#ff9f1c", 7, 480, 19.7, 21.1); // orange star
  return s;
}

// ---- Floating Screen Draw toolbar ----
function tbLayout(startX) {
  let x = startX + 14;
  const sep = 14;
  const boltCx = x + 22; x += 44;
  x += sep;
  const tools = [];
  for (let i = 0; i < 6; i += 1) { tools.push(x + 17); x += 38; }
  x += sep;
  const colors = [];
  for (let i = 0; i < 5; i += 1) { colors.push(x + 14); x += 30; }
  x += sep;
  const widths = [];
  for (let i = 0; i < 3; i += 1) { widths.push(x + 11); x += 24; }
  x += sep;
  const actions = [];
  for (let i = 0; i < 3; i += 1) { actions.push(x + 17); x += 38; }
  x += 14;
  return { boltCx, tools, colors, widths, actions, endX: x };
}
const TB_W = tbLayout(0).endX;
const TB_X = Math.round(960 - TB_W / 2);
const TB_Y = 96;
const TB_H = 56;
const TB_CY = TB_Y + TB_H / 2;
const L = tbLayout(TB_X);

const TOOL_ICONS = [iconCursorTool, iconPencil, iconEraser, iconLine, iconBoxTool, iconEllipse];
const TOOL_COLORS = ["#111318", "#ef4444", "#ff9f1c", "#5AA9FF", "#22c55e"];
const BOX_IN = 3.0;
const MORPH_IN = 3.4;

function activeTool(t) {
  if (t >= 17.5) return 1; // back to pen for freehand
  if (t >= 14.2) return 5; // ellipse
  if (t >= 11.0) return 4; // box
  if (t >= 7.8) return 3; // line
  return 1; // pen
}
function activeColor(t) {
  if (t >= 14.95) return 2; // orange
  if (t >= 11.75) return 3; // blue
  if (t >= 8.55) return 1; // red
  if (t >= 5.25) return 4; // green
  return 0;
}
function squircle(cx, cy, size, scale) {
  const s = size, r = s * 0.3;
  return `<g transform="translate(${cx} ${cy}) scale(${scale})">
    <rect x="${-s / 2}" y="${-s / 2}" width="${s}" height="${s}" rx="${r}" fill="#1b1c22" stroke="rgba(255,255,255,0.18)"/>
    <rect x="${-s * 0.32}" y="${-s * 0.32}" width="${s * 0.64}" height="${s * 0.64}" rx="${r * 0.62}" fill="rgba(255,255,255,0.07)"/>
    ${bolt(-s * 0.22, -s * 0.27, s * 0.5, "#ffffff")}
  </g>`;
}
function screenDrawUI(t) {
  const capIn = easeOutBack(between(t, BOX_IN, BOX_IN + 0.5));
  const gate = fade(t, BOX_IN, BOX_IN + 0.5, 21.8, 22.1);
  if (gate <= 0) return "";
  // box glides to the left-cap position, then the bar unfurls rightward from it
  const moveP = easeInOutCubic(between(t, MORPH_IN, MORPH_IN + 0.4));
  const unfurlP = easeInOutCubic(between(t, MORPH_IN + 0.4, MORPH_IN + 1.0));
  const capX = lerp(960, L.boltCx, moveP);
  const capY = lerp(336, TB_CY, moveP);
  const capSize = lerp(58, 40, moveP);

  // pill background + contents, revealed left→right as the box unfurls.
  // Clip spans the full pill (incl. rounded caps) so the ends never look sheared.
  const pillLeft = TB_X - 4;
  const pillRight = TB_X + TB_W + 4;
  const revealW = Math.max(0, (pillRight - pillLeft) * unfurlP);

  const at = activeTool(t);
  const ac = activeColor(t);
  let inner = `<rect x="${TB_X}" y="${TB_Y}" width="${TB_W}" height="${TB_H}" rx="${TB_H / 2}" fill="rgba(28,28,34,0.94)" stroke="rgba(255,255,255,0.12)"/>`;
  // separators
  const seps = [L.boltCx + 24, (L.tools[5] + L.colors[0]) / 2, (L.colors[4] + L.widths[0]) / 2, (L.widths[2] + L.actions[0]) / 2];
  seps.forEach((sx) => {
    inner += `<line x1="${sx.toFixed(1)}" y1="${TB_Y + 14}" x2="${sx.toFixed(1)}" y2="${TB_Y + TB_H - 14}" stroke="rgba(255,255,255,0.12)"/>`;
  });
  // tools
  L.tools.forEach((cx, i) => {
    const active = i === at;
    inner += `<rect x="${cx - 17}" y="${TB_CY - 17}" width="34" height="34" rx="9" fill="${active ? W_ACCENT_SUB : "rgba(255,255,255,0)"}" stroke="${active ? "rgba(255,159,28,0.5)" : "rgba(255,255,255,0)"}"/>`;
    inner += TOOL_ICONS[i](cx - 9, TB_CY - 9, 18, active ? "#ffffff" : "#9a97a2");
  });
  // colors
  L.colors.forEach((cx, i) => {
    const active = i === ac;
    const r = active ? 12 : 9;
    inner += `<circle cx="${cx}" cy="${TB_CY}" r="${r}" fill="${TOOL_COLORS[i]}" stroke="${active ? "#ffffff" : "rgba(255,255,255,0.3)"}" stroke-width="${active ? 2.5 : 1}"/>`;
  });
  // stroke widths
  L.widths.forEach((cx, i) => {
    const rr = [2.5, 4, 5.5][i];
    const sel = i === 1;
    inner += `<circle cx="${cx}" cy="${TB_CY}" r="${rr}" fill="${sel ? PICK_HEX : "#cfccd4"}"/>`;
    if (sel) inner += `<circle cx="${cx}" cy="${TB_CY}" r="${rr + 4}" fill="none" stroke="${PICK_HEX}" stroke-width="1.5"/>`;
  });
  // actions
  inner += iconReset(L.actions[0] - 10, TB_CY - 10, 20, "#9a97a2");
  inner += iconTrash(L.actions[1] - 9, TB_CY - 9, 18, "#9a97a2");
  inner += iconClose(L.actions[2] - 9, TB_CY - 9, 18, "#ef4444");

  return `<g opacity="${gate.toFixed(3)}">
    <defs><clipPath id="tbReveal"><rect x="${pillLeft}" y="${TB_Y - 8}" width="${revealW.toFixed(1)}" height="${TB_H + 16}"/></clipPath></defs>
    <g clip-path="url(#tbReveal)" filter="url(#barShadow)">${inner}</g>
    ${squircle(capX, capY, capSize, capIn)}
  </g>`;
}

// ---- Cursor ----
const PEN = L.tools[1], LINE = L.tools[3], BOXT = L.tools[4], ELL = L.tools[5];
const GREEN = L.colors[4], RED = L.colors[1], BLUE = L.colors[3], ORG = L.colors[2];
const CURSOR_KEYS = [
  [0.0, 950, 1000],
  [1.0, ICON_CX, ICON_CY], // glide up to the icon
  [1.05, ICON_CX, ICON_CY], // left-click → quick-tools popover opens
  [2.3, 1710, 401], // move to the Screen Draw toggle
  [2.5, 1710, 401], // click Enable
  [3.0, 1710, 401], // brief hold on the toggle as the popover clears
  // Beat 1 — Pen + green, underline (unhurried tool/color pick)
  [3.9, PEN, TB_CY], // glide to the Pen tool
  [4.5, PEN, TB_CY], // click Pen
  [4.65, PEN, TB_CY], // brief dwell
  [5.25, GREEN, TB_CY], // move to green swatch, click green
  [5.4, GREEN, TB_CY], // brief dwell
  [5.8, 800, 516], // to underline start
  [7.2, 1120, 516], // drag slowly draws the green underline
  // Beat 2 — Line + red, arrow
  [7.8, LINE, TB_CY], // move to Line tool, click
  [7.95, LINE, TB_CY], // dwell
  [8.55, RED, TB_CY], // move to red swatch, click
  [8.7, RED, TB_CY], // dwell
  [9.1, 1235, 466], // arrow start (tail)
  [10.4, 1080, 392], // drag slowly draws the red arrow up to the badge
  // Beat 3 — Box + blue, rectangle
  [11.0, BOXT, TB_CY], // move to Box tool, click
  [11.15, BOXT, TB_CY], // dwell
  [11.75, BLUE, TB_CY], // move to blue swatch, click
  [11.9, BLUE, TB_CY], // dwell
  [12.3, 1204, 300], // rect start
  [13.6, 1338, 342], // drag slowly draws the blue box
  // Beat 4 — Ellipse + orange, circle
  [14.2, ELL, TB_CY], // move to Ellipse tool, click
  [14.35, ELL, TB_CY], // dwell
  [14.95, ORG, TB_CY], // move to orange swatch, click
  [15.1, ORG, TB_CY], // dwell
  [15.5, 853, 573], // arrive at the top of the circle (cursorPos traces the arc from here)
  [16.9, 853, 573], // finish the loop back at the top
  // Beat 5 — back to Pen, annotate the bare desktop
  [17.5, PEN, TB_CY], // move to Pen, click
  [17.65, PEN, TB_CY], // dwell
  [18.1, 300, 560], // out to the bare desktop
  [18.5, 360, 632], // draw the check ↓
  [19.3, 472, 468], // ↗ finish the check
  [19.7, 380, 290], // to the star
  [20.0, 409, 381], [20.3, 333, 325], [20.6, 428, 325], [20.9, 351, 381], [21.1, 380, 290], // trace the star
  [21.4, 520, 430], // settle near the marks
];
const CLICK_TIMES = [POP_OPEN, ENABLE_T, 4.5, 5.25, 7.8, 8.55, 11.0, 11.75, 14.2, 14.95, 17.5];

function cursorPos(t) {
  if (t >= ELLIPSE.start && t <= ELLIPSE.end) {
    return ellipsePoint(easeInOutCubic((t - ELLIPSE.start) / (ELLIPSE.end - ELLIPSE.start)));
  }
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
  const op = fade(t, 0.0, 0.5, 21.5, 22.0);
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
    [0.95, 2.35, "Open Mac Kit's quick tools."],
    [2.45, 3.35, "Turn on Screen Draw."],
    [3.1, 4.4, "Your toolbar floats on screen."],
    [4.4, 7.2, "Underline with the pen."],
    [7.4, 10.4, "Draw arrows and lines."],
    [11.0, 13.6, "Box anything important."],
    [14.2, 16.9, "Circle the key action."],
    [17.7, 21.1, "And anywhere on your desktop."],
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
  const bgOp = clamp((t - 21.8) / 0.25, 0, 1);
  if (bgOp <= 0) return "";
  const accent = "#f5941d";
  const pillOpts = { fill: "#ffffff", color: "#6d6b66", border: "rgba(5,5,5,0.12)" };
  const pulse = 0.5 + 0.5 * Math.sin((t - 22.1) * Math.PI * 2 / 1.2);
  const btnScale = lerp(1, 1.04, pulse);
  const glowOp = lerp(0.1, 0.5, pulse);
  const rev = (delay) => {
    const p = easeOutCubic(clamp((t - (22.1 + delay)) / 0.5, 0, 1));
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
      ${text("Draw on your screen. Present anything.", 960, 484, 60, { anchor: "middle", weight: 900, fill: "#050505" })}
    </g>
    <g ${rev(0.24)}>
      ${text("Pen, shapes, arrows and text — annotate live over any app.", 960, 546, 27, { anchor: "middle", fill: "#6d6b66", weight: 600 })}
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
  const sceneFade = fade(t, 3.0, 3.7, 21.8, 22.1);
  const scene = sceneFade > 0 ? `<g opacity="${sceneFade.toFixed(3)}">${websiteWindow()}${annotations(t)}</g>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    ${defs()}
    ${wallpaper(t)}
    ${scene}
    ${menuBar(t)}
    ${lightPopover(t)}
    ${screenDrawUI(t)}
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

  const posterStory = 21.1; // all annotations drawn, inside + outside
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
