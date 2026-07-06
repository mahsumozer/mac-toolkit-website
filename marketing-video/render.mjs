import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION = 24;
// Linger on each panel as it opens so the switch between settings reads slower.
// Each entry freezes story time at [storyTime] for [seconds] of output.
const HOLDS = [
  [2.95, 0.85], // Screenshot panel just opened
  [6.9, 0.85], // Color Picker panel just opened
  [10.7, 0.85], // Clipboard results just shown
  [13.95, 0.85], // Pomodoro panel just opened, before Start
  [16.2, 0.85], // "+" add-widget dropdown just opened
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
const OUT_DIR = join(ROOT, "marketing-video", "out");
const VIDEO_OUT = join(OUT_DIR, "mac-kit-launch-promo.mp4");
const POSTER_OUT = join(OUT_DIR, "mac-kit-launch-poster.png");

const orange = "#ff9f1c";
const ink = "#f7f3ea";
const muted = "#aaa5b2";
const mono = "SFMono-Regular, Menlo, monospace";
const sans = "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
const PICK_HEX = "#5AA9FF";

// ---- Menu bar / icon ----
const MB_H = 40;
const ICON_CX = 1700;
const ICON_CY = 20;
// Popover was laid out for an icon at x=1300; shift it to track the icon.
const POP_DX = ICON_CX - 1300;

// ---- Browser window ----
const BX = 180;
const BY = 150;
const BW = 760;
const BH = 420;
const HERO_CX = 460;
const HERO_CY = 496;

// ---- Popover ----
const PX = 640;
const PY = 48;
const PW = 760;
const PH = 478;
// Card content was authored for a box top at y=95; CDX/CDY re-center it inside the rect.
// The right column is additionally pulled 16px left inside popover() to tighten the gap.
const CDX = 16;
const CDY = PY - 95;

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
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase();
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
// Line-art category icons, drawn in a 20x20 box scaled to `size`.
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
function iconPlus(x, y, size = 18, color = ink) {
  return icon(x, y, size, color, `<line x1="10" y1="5" x2="10" y2="15"/><line x1="5" y1="10" x2="15" y2="10"/>`);
}
function iconMinus(x, y, size = 18, color = ink) {
  return icon(x, y, size, color, `<line x1="5" y1="10" x2="15" y2="10"/>`);
}
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
    <linearGradient id="rainbow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ff4d4d"/>
      <stop offset="20%" stop-color="#ff9f1c"/>
      <stop offset="40%" stop-color="#ffe14d"/>
      <stop offset="58%" stop-color="#6ee7b7"/>
      <stop offset="78%" stop-color="#5aa9ff"/>
      <stop offset="100%" stop-color="#b98bff"/>
    </linearGradient>
    <clipPath id="thumbClip"><rect x="12" y="12" width="206" height="142" rx="8"/></clipPath>
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

// ---- Popover open/close state ----
const POP_INTERVALS = [
  [2.6, 3.75, "screenshot"],
  [6.6, 7.5, "color"],
  [10.4, 13.2, "clipboard"],
  [13.7, 17.6, "pomodoro"],
];
function popoverState(t) {
  let op = 0;
  let active = "";
  for (const [openT, closeT, name] of POP_INTERVALS) {
    const v = easeOutCubic(between(t, openT, openT + 0.26)) * (1 - easeOutCubic(between(t, closeT, closeT + 0.26)));
    if (v > op) {
      op = v;
      active = name;
    }
  }
  return { op, active };
}

// ---- Menu bar ----
function menuBar(t) {
  const iconHot = popoverState(t).op > 0.05;
  // menu-bar pomodoro timer starts counting down right after Start (14.6), while the popover is still open
  const timerOp = fade(t, 14.7, 15.2, 22.6, 23.2);
  let timer = "";
  if (timerOp > 0) {
    const sec = Math.max(0, 1500 - Math.floor((t - 14.6) * 8));
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    const ringP = clamp((t - 14.6) / 12) * 0.4;
    const dash = 2 * Math.PI * 9;
    timer = `<g opacity="${timerOp}">
      <rect x="1550" y="6" width="108" height="28" rx="10" fill="rgba(255,159,28,0.18)" stroke="rgba(255,159,28,0.4)"/>
      <circle cx="1568" cy="20" r="9" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="3"/>
      <circle cx="1568" cy="20" r="9" fill="none" stroke="${orange}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${dash}" stroke-dashoffset="${dash * (1 - ringP)}" transform="rotate(-90 1568 20)"/>
      ${text(`${mm}:${ss}`, 1586, 25, 16, { weight: 800, fill: ink, family: mono })}
    </g>`;
  }
  return `<g>
    <rect x="0" y="0" width="${WIDTH}" height="${MB_H}" fill="rgba(20,20,26,0.55)"/>
    <line x1="0" y1="${MB_H}" x2="${WIDTH}" y2="${MB_H}" stroke="rgba(255,255,255,0.08)"/>
    ${text("File", 40, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    ${text("Edit", 100, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    ${text("View", 160, 26, 18, { weight: 600, fill: "#d9d5dc" })}
    ${timer}
    <rect x="${ICON_CX - 18}" y="4" width="36" height="32" rx="9" fill="${iconHot ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0)"}"/>
    ${bolt(ICON_CX - 11, ICON_CY - 12, 24, "#ffffff")}
    ${text("94%", 1745, 26, 17, { weight: 700, fill: ink })}
    ${text("3:51 PM", 1812, 26, 17, { weight: 700, fill: ink })}
  </g>`;
}

// ---- Desktop side windows (decor) ----
function deskWindows(t) {
  const op = fade(t, 0.2, 0.9, 18.4, 19.2);
  if (op <= 0) return "";
  const bar = (x, y, w, fill = "#cfcad8") => `<rect x="${x}" y="${y}" width="${w}" height="8" rx="4" fill="${fill}"/>`;
  return `<g opacity="${op}">
    <!-- Preview window with photo -->
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
    <!-- Chat app window -->
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

// ---- Browser window ----
function browserWindow(t) {
  const op = fade(t, 0.3, 1.0, 18.4, 19.2);
  if (op <= 0) return "";
  const cy = BY + 44; // content top
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

    <!-- Nav -->
    <rect x="${BX + 36}" y="${cy + 14}" width="26" height="26" rx="7" fill="#ffffff" stroke="#dcd8e2"/>
    ${bolt(BX + 41, cy + 17, 16, "#16131a")}
    ${text("Mac Kit", BX + 72, cy + 33, 18, { weight: 900, fill: "#1a1a22" })}
    ${text("Features", BX + 460, cy + 32, 14, { weight: 600, fill: "#6b6675" })}
    ${text("Pricing", BX + 545, cy + 32, 14, { weight: 600, fill: "#6b6675" })}
    <rect x="${BX + 620}" y="${cy + 10}" width="104" height="34" rx="17" fill="#1a1a22"/>
    ${text("Download", BX + 672, cy + 32, 14, { anchor: "middle", weight: 700, fill: "#ffffff" })}
    <line x1="${BX}" y1="${cy + 56}" x2="${BX + BW}" y2="${cy + 56}" stroke="#eceaf0" stroke-width="1.5"/>

    <!-- Hero -->
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

// "+" add-widget dropdown: a macOS-style menu that hangs below the button.
function addMenu(p) {
  if (p <= 0) return "";
  const mx = 1140, my = 562, mw = 236, rowH = 38;
  const items = [
    ["Keep Awake", `<circle cx="10" cy="10" r="3"/><path d="M2 10 C5 5 15 5 18 10 C15 15 5 15 2 10Z"/>`],
  ];
  const rows = items.map(([label, body], i) => {
    const y = my + 10 + i * rowH;
    return `${icon(mx + 16, y + 5, 20, "#d9d5dc", body)}${text(label, mx + 48, y + 24, 16, { weight: 700, fill: "#e8e4ee" })}`;
  }).join("");
  const sepY = my + 10 + items.length * rowH + 4;
  const footY = sepY + 8;
  const mh = footY + rowH + 4 - my;
  const s = lerp(0.9, 1, p);
  const ox = mx + mw, oy = my;
  return `<g opacity="${p}" transform="translate(${ox} ${oy}) scale(${s}) translate(${-ox} ${-oy})" filter="url(#popShadow)">
    <rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="14" fill="rgba(60,60,63,0.72)" stroke="rgba(255,255,255,0.16)"/>
    ${rows}
    <line x1="${mx + 14}" y1="${sepY}" x2="${mx + mw - 14}" y2="${sepY}" stroke="rgba(255,255,255,0.1)"/>
    <rect x="${mx + 10}" y="${footY}" width="${mw - 20}" height="${rowH - 4}" rx="9" fill="${orange}"/>
    ${text("and much more…", mx + mw / 2, footY + 23, 15, { anchor: "middle", weight: 800, fill: "#16131a" })}
  </g>`;
}

// ---- Popover widgets ----
function popover(t) {
  const { op, active } = popoverState(t);
  if (op <= 0) return "";
  const grow = easeOutBack(op);
  const scale = lerp(0.94, 1, grow);
  const dy = lerp(-16, 0, easeOutCubic(op));
  const originX = ICON_CX;
  const originY = PY;

  // --- Clipboard rows ---
  const rows = [
    "https://mackit.rojhot.com",
    "~/Desktop/region.png",
    PICK_HEX,
    "hello@rojhot.com",
    "Meeting notes",
  ];
  const shotDone = t > 6.0;
  const colorDone = t > 9.4;
  let hover = -1;
  if (active === "clipboard" && t > 11.62) hover = 1;
  const clip = rows.map((item, i) => {
    const y = 168 + i * 44;
    const on = i === hover;
    const isNew = (i === 1 && shotDone) || (i === 2 && colorDone);
    return `<rect x="664" y="${y}" width="296" height="34" rx="9" fill="${on ? "rgba(255,159,28,0.18)" : "rgba(0,0,0,0.24)"}" stroke="${on ? "rgba(255,159,28,0.42)" : "rgba(255,255,255,0.09)"}"/>
      ${isNew && !on ? `<circle cx="676" cy="${y + 17}" r="4" fill="${orange}"/>` : ""}
      ${text(item, on || isNew ? 692 : 680, y + 22, 15, { weight: 600, fill: on ? ink : "#c8c3cd", family: mono })}
      ${on
        ? `<g transform="translate(884 ${y + 6})"><rect x="0" y="0" width="66" height="22" rx="11" fill="rgba(110,231,183,0.16)" stroke="rgba(110,231,183,0.4)"/>${text("Copied", 33, 15, 12, { anchor: "middle", weight: 800, fill: "#8ff0c0" })}</g>`
        : iconCopy(936, y + 10, 15, "#8f8b96")}`;
  }).join("");

  // --- Screenshot buttons ---
  const areaOn = active === "screenshot" && t > 3.7;
  const shotBtns = [["Full", 1040, 160], ["Area", 1206, 160], ["Window", 1040, 204], ["Record", 1206, 204]]
    .map(([l, x, y], i) => {
      const on = i === 1 && areaOn;
      return `<rect x="${x}" y="${y}" width="150" height="34" rx="10" fill="${on ? "rgba(255,159,28,0.22)" : "rgba(255,255,255,0.07)"}" stroke="${on ? orange : "rgba(255,255,255,0.12)"}"/>
        ${text(l, x + 75, y + 22, 16, { anchor: "middle", weight: 800, fill: on ? ink : "#d9d5dc" })}`;
    }).join("");

  // --- Color picker widget ---
  const pickOn = active === "color" && t > 7.4;
  const swatchCol = colorDone ? PICK_HEX : "#f0eef4";
  const swatchHex = colorDone ? PICK_HEX : "#F4F2ED";

  // --- Pomodoro widget ---
  const startOn = active === "pomodoro" && t > 14.62;

  // --- "+" add-widget dropdown ---
  const addP = clamp((t - 15.9) / 0.3);
  const addOn = addP > 0;

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
    <rect x="648" y="428" width="328" height="128" rx="16" fill="${startOn ? "rgba(255,159,28,0.1)" : cardBg}" stroke="${startOn ? "rgba(255,159,28,0.4)" : cardBorder}"/>
    ${iconTimer(666, 442, 19)}
    ${text("Pomodoro", 694, 460, 20, { weight: 800 })}
    <circle cx="672" cy="494" r="5" fill="#ff4d4d"/>
    ${text("WORK", 690, 500, 15, { weight: 800, fill: muted, spacing: 3 })}
    ${text(startOn ? "24:59" : "25:00", 952, 502, 30, { anchor: "end", weight: 900, fill: orange, family: mono })}
    <rect x="664" y="516" width="32" height="34" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>
    ${iconMinus(671, 523, 18, "#d9d5dc")}
    <rect x="702" y="516" width="220" height="34" rx="10" fill="${orange}"/>
    ${text(startOn ? "Pause" : "Start", 812, 539, 17, { anchor: "middle", weight: 900, fill: "#16131a" })}
    <rect x="928" y="516" width="32" height="34" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)"/>
    ${iconPlus(935, 523, 18, "#d9d5dc")}

    <g transform="translate(-16 0)">
    <!-- Screenshot -->
    <rect x="1016" y="112" width="360" height="154" rx="16" fill="${cardBg}" stroke="${cardBorder}"/>
    ${iconCamera(1034, 126, 19)}
    ${text("Screenshot", 1062, 144, 20, { weight: 800 })}
    ${shotBtns}

    <!-- Color Picker -->
    <rect x="1016" y="282" width="360" height="224" rx="16" fill="${pickOn ? "rgba(255,159,28,0.1)" : cardBg}" stroke="${pickOn ? "rgba(255,159,28,0.4)" : cardBorder}"/>
    ${iconDroplet(1034, 296, 19)}
    ${text("Color Picker", 1062, 314, 20, { weight: 800 })}
    <rect x="1040" y="330" width="48" height="48" rx="11" fill="${swatchCol}" stroke="rgba(255,255,255,0.18)"/>
    ${text(swatchHex, 1104, 364, 26, { weight: 900, family: mono })}
    ${["HEX", "RGB", "HSL"].map((l, i) => `<rect x="${1040 + i * 108}" y="394" width="96" height="34" rx="9" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.1)"/>${text(l, 1088 + i * 108, 416, 14, { anchor: "middle", weight: 900, fill: "#d9d5dc", spacing: 2 })}`).join("")}
    <rect x="1040" y="440" width="312" height="44" rx="12" fill="${orange}"/>
    ${text(pickOn ? "Picking…" : "Pick Color", 1196, 468, 17, { anchor: "middle", weight: 900, fill: "#16131a" })}

    <!-- Add widget -->
    <rect x="1340" y="520" width="36" height="36" rx="10" fill="${addOn ? "rgba(255,159,28,0.22)" : "rgba(255,255,255,0.08)"}" stroke="${addOn ? orange : "rgba(255,255,255,0.12)"}"/>
    ${iconPlus(1349, 529, 18, addOn ? orange : "#d9d5dc")}
    ${addMenu(addP)}
    </g>
    </g>
    </g>
  </g>`;
}

// ---- Screenshot capture overlay ----
function captureOverlay(t, cx, cy) {
  const on = t > 3.8 && t < 6.35;
  if (!on) return "";
  const op = fade(t, 3.8, 4.0, 6.15, 6.35);
  const x0 = 340;
  const y0 = 270;
  const dragging = t > 4.6;
  const x1 = dragging ? clamp(cx, BX, BX + BW) : x0;
  const y1 = dragging ? clamp(cy, BY + 44, BY + BH) : y0;
  const rx = Math.min(x0, x1);
  const ry = Math.min(y0, y1);
  const rw = Math.abs(x1 - x0);
  const rh = Math.abs(y1 - y0);
  const flash = t > 5.75 ? easeOutCubic(between(t, 5.75, 5.9)) * (1 - easeOutCubic(between(t, 5.9, 6.15))) : 0;
  return `<g opacity="${op}">
    <rect x="0" y="${MB_H}" width="${WIDTH}" height="${HEIGHT - MB_H}" fill="rgba(10,12,20,0.42)"/>
    ${dragging ? `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="rgba(255,255,255,0.14)" stroke="${orange}" stroke-width="2.5" stroke-dasharray="9 7"/>
      ${text(`${Math.round(rw)} × ${Math.round(rh)}`, rx + rw / 2, ry - 12, 20, { anchor: "middle", weight: 800, fill: "#fff" })}
      <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="#ffffff" opacity="${flash * 0.7}"/>` : ""}
    <line x1="${x1}" y1="${MB_H}" x2="${x1}" y2="${HEIGHT}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>
    <line x1="0" y1="${y1}" x2="${WIDTH}" y2="${y1}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>
  </g>`;
}
function shotThumb(t) {
  const op = fade(t, 5.95, 6.25, 6.6, 6.9);
  if (op <= 0) return "";
  // Miniature of the actual captured region (340,270 → 760,560), scaled into the thumb.
  const s = 206 / 420;
  return `<g opacity="${op}" transform="translate(760 720)">
    <rect x="0" y="0" width="230" height="196" rx="14" fill="#1b1b24" stroke="rgba(255,255,255,0.2)"/>
    <g clip-path="url(#thumbClip)">
      <rect x="12" y="12" width="206" height="142" fill="#ffffff"/>
      <g transform="translate(${12 - 340 * s} ${12 - 270 * s}) scale(${s})">${browserWindow(5)}</g>
    </g>
    <circle cx="30" cy="174" r="9" fill="#6ee7b7"/>
    <path d="M25 174 l4 4 l7 -8" stroke="#16131a" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    ${text("Copied and saved", 48, 180, 15, { weight: 700, fill: "#d9d5dc" })}
  </g>`;
}

// ---- Color loupe on desktop ----
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mixHex(a, b, p) {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  const to = (i) => Math.round(lerp(ra[i], rb[i], clamp(p))).toString(16).padStart(2, "0");
  return `#${to(0)}${to(1)}${to(2)}`.toUpperCase();
}
// Mirrors the #wall gradient stops so the loupe can fake-sample the wallpaper.
const WALL_STOPS = [[0, "#2a3a6b"], [0.42, "#5b3f8f"], [0.72, "#a24d7a"], [1, "#e08a4c"]];
function wallColorAt(x, y) {
  const p = clamp((x / WIDTH + y / HEIGHT) / 2);
  for (let i = 1; i < WALL_STOPS.length; i += 1) {
    if (p <= WALL_STOPS[i][0]) {
      const [p0, c0] = WALL_STOPS[i - 1];
      const [p1, c1] = WALL_STOPS[i];
      return mixHex(c0, c1, (p - p0) / (p1 - p0));
    }
  }
  return WALL_STOPS[WALL_STOPS.length - 1][1];
}
function colorUnder(t, x, y) {
  if (x >= HERO_CX - 90 && x <= HERO_CX + 90 && Math.abs(y - HERO_CY) <= 24) return PICK_HEX;
  if (popoverState(t).op > 0.3 && x >= PX + POP_DX && x <= PX + POP_DX + PW && y >= PY && y <= PY + PH) return "#3C3C3F";
  if (x >= BX && x <= BX + BW && y >= BY && y <= BY + BH) {
    return y <= BY + 44 ? "#ECEAF0" : "#FFFFFF";
  }
  return wallColorAt(x, y);
}
function colorLoupe(t, cx, cy) {
  const on = t > 7.6 && t < 10.2;
  if (!on) return "";
  const lx = cx;
  const ly = cy;
  const picked = t > 9.2;
  // Loupe circle is only shown while sampling; it fades out the moment the color is picked.
  const loupeOp = fade(t, 7.6, 7.9, 9.2, 9.4);
  const loupe = loupeOp > 0
    ? `<g opacity="${loupeOp}">
        <circle cx="${lx}" cy="${ly}" r="49" fill="none" stroke="rgba(0,0,0,0.3)" stroke-width="2"/>
        <circle cx="${lx}" cy="${ly}" r="46" fill="${colorUnder(t, lx, ly)}" stroke="#fff" stroke-width="4"/>
        <line x1="${lx - 14}" y1="${ly}" x2="${lx + 14}" y2="${ly}" stroke="rgba(0,0,0,0.55)" stroke-width="2"/>
        <line x1="${lx}" y1="${ly - 14}" x2="${lx}" y2="${ly + 14}" stroke="rgba(0,0,0,0.55)" stroke-width="2"/>
      </g>`
    : "";
  // "Copied" chip appears at pick and lingers as the cursor heads back to the menu bar.
  const chip = picked
    ? `<g transform="translate(${lx + 40} ${ly - 10})" opacity="${fade(t, 9.2, 9.45, 10.0, 10.2)}">
        <rect x="0" y="0" width="180" height="52" rx="12" fill="rgba(20,20,26,0.92)" stroke="rgba(255,255,255,0.18)"/>
        <rect x="12" y="12" width="28" height="28" rx="7" fill="${PICK_HEX}"/>
        ${text(PICK_HEX, 52, 26, 20, { weight: 900, family: mono })}
        ${text("Copied", 52, 44, 13, { weight: 700, fill: "#8ff0c0" })}
      </g>`
    : "";
  return `${loupe}${chip}`;
}

// ---- Cursor ----
const CURSOR_KEYS = [
  [0.0, 950, 1000],
  [1.8, 950, 860],
  [2.6, ICON_CX, ICON_CY],
  [3.7, 1265 + POP_DX + CDX, 177 + CDY],
  [4.4, 360, 300],
  [4.6, 360, 300],
  [5.75, 760, 560],
  [6.6, ICON_CX, ICON_CY],
  [7.4, 1180 + POP_DX + CDX, 462 + CDY],
  [8.6, HERO_CX, HERO_CY],
  [9.3, HERO_CX, HERO_CY],
  [10.4, ICON_CX, ICON_CY],
  [11.6, 812 + POP_DX + CDX, 229 + CDY],
  [13.7, ICON_CX, ICON_CY],
  [14.6, 812 + POP_DX + CDX, 533 + CDY],
  [15.9, 1342 + POP_DX + CDX, 538 + CDY],
  [16.8, 1342 + POP_DX + CDX, 538 + CDY],
  [17.9, 900, 660],
  [19.4, 950, 900],
];
const CLICK_TIMES = [2.6, 3.7, 6.6, 7.4, 9.3, 10.4, 11.6, 13.7, 14.6, 15.9];

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
  const op = fade(t, 0.0, 0.5, 18.4, 19.0);
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
    [2.7, 3.7, "Open it straight from the menu bar."],
    [4.2, 6.2, "Screenshot any region of your screen."],
    [7.8, 10.0, "Pick any color, right off the screen."],
    [10.8, 13.1, "Every action lands in your clipboard."],
    [15.6, 17.1, "Keep awake, and much more — one click away."],
    [17.4, 18.4, "A focus timer that lives in the menu bar."],
  ];
  return list.map(([s, e, label]) => {
    const p = fade(t, s, s + 0.3, e - 0.3, e);
    if (p <= 0) return "";
    return `<g opacity="${p}">
      <rect x="${960 - 400}" y="972" width="800" height="64" rx="32" fill="rgba(12,12,18,0.62)" stroke="rgba(255,255,255,0.12)"/>
      ${text(label, 960, 1012, 27, { anchor: "middle", weight: 800 })}
    </g>`;
  }).join("");
}

// ---- CTA ----
function cta(t) {
  const opacity = fade(t, 18.6, 19.4);
  if (opacity <= 0) return "";
  const rise = lerp(26, 0, easeOutCubic(between(t, 18.6, 19.7)));
  const accent = "#f5941d";
  const pillOpts = { fill: "#ffffff", color: "#6d6b66", border: "rgba(5,5,5,0.12)" };
  const pulse = 0.5 + 0.5 * Math.sin((t - 18.9) * Math.PI * 2 / 1.2);
  const btnScale = lerp(1, 1.04, pulse);
  const glowOp = lerp(0.1, 0.5, pulse);
  return `<g opacity="${opacity}">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#f4f2ed"/>
    <ellipse cx="960" cy="300" rx="720" ry="480" fill="url(#ctaGlow)"/>
    <g transform="translate(0 ${rise})">
      <g transform="translate(896 206)" filter="url(#ctaShadow)">
        <rect width="128" height="128" rx="30" fill="#ffffff" stroke="#e2ded6"/>
        ${bolt(34, 36, 56, "#16131a")}
      </g>
      ${text("Mac Kit", 960, 400, 42, { anchor: "middle", weight: 900, fill: accent, spacing: 1 })}
      ${text("Get everyday Mac tools out of the way.", 960, 484, 60, { anchor: "middle", weight: 900, fill: "#050505" })}
      ${text("Screenshots, clipboard history, color picker, pomodoro, keep awake, and more.", 960, 546, 27, { anchor: "middle", fill: "#6d6b66", weight: 600 })}
      <ellipse cx="960" cy="662" rx="380" ry="112" fill="url(#btnGlow)" opacity="${glowOp}"/>
      <g transform="translate(960 662) scale(${btnScale}) translate(-960 -662)">
        <g transform="translate(650 620)" filter="url(#ctaShadow)">
          <rect x="0" y="0" width="620" height="84" rx="42" fill="#050505"/>
          ${text("Get Mac Kit Now", 310, 53, 28, { anchor: "middle", fill: "#ffffff", weight: 800 })}
        </g>
      </g>
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
  const [cx, cy] = cursorPos(t);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    ${defs()}
    ${wallpaper(t)}
    ${deskWindows(t)}
    ${browserWindow(t)}
    ${menuBar(t)}
    ${captureOverlay(t, cx, cy)}
    ${shotThumb(t)}
    ${colorLoupe(t, cx, cy)}
    ${popover(t)}
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

  const posterFrame = Math.round((21.4 + TOTAL_HOLD) * FPS);
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
