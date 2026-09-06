(function () {
  "use strict";

  const tools = {
    capture: {
      title: "Capture",
      visualId: "visual-capture",
      toast: "Capture controls ready.",
    },
    clipboard: {
      title: "Clipboard",
      visualId: "visual-clipboard",
      toast: "Clipboard history ready.",
    },
    monitor: {
      title: "Monitor",
      visualId: "visual-monitor",
      toast: "System monitor running.",
    },
    focus: {
      title: "Focus",
      visualId: "visual-focus",
      toast: "Pomodoro controls ready.",
    },
  };

  const formsApi = "https://mac-kit-forms.rojhot.workers.dev";

  let selectedTool = "capture";
  let focusTimer = null;
  let focusRemaining = 25 * 60;
  let focusTotal = 25 * 60;

  function showToast(message) {
    const region = document.getElementById("toast-region");
    if (!region) return;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    region.appendChild(toast);

    window.setTimeout(() => {
      toast.classList.add("out");
      toast.addEventListener("animationend", () => toast.remove(), { once: true });
    }, 2600);
  }

  function initHeader() {
    const header = document.getElementById("site-header");
    const menuButton = document.getElementById("menu-button");
    const nav = document.getElementById("main-nav");

    const updateHeader = () => {
      if (!header) return;
      header.classList.toggle("scrolled", window.scrollY > 18);
    };

    updateHeader();
    window.addEventListener("scroll", updateHeader, { passive: true });

    if (menuButton && nav) {
      menuButton.addEventListener("click", () => {
        const nextOpen = !document.body.classList.contains("menu-open");
        document.body.classList.toggle("menu-open", nextOpen);
        menuButton.setAttribute("aria-expanded", String(nextOpen));
      });

      nav.querySelectorAll("a").forEach((link) => {
        link.addEventListener("click", () => {
          document.body.classList.remove("menu-open");
          menuButton.setAttribute("aria-expanded", "false");
        });
      });
    }
  }

  function initClock() {
    const clock = document.getElementById("menu-clock");
    const showcaseClock = document.getElementById("showcase-clock");

    const update = () => {
      const now = new Date();
      let hours = now.getHours();
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const suffix = hours >= 12 ? "PM" : "AM";
      hours = hours % 12 || 12;
      const timeStr = `${hours}:${minutes} ${suffix}`;
      if (clock) clock.textContent = timeStr;
      if (showcaseClock) showcaseClock.textContent = `${hours}:${minutes}`;
    };

    update();
    window.setInterval(update, 1000);
  }

  function setTool(toolName, announce) {
    const tool = tools[toolName];
    const title = document.getElementById("hero-tool-title");
    if (!tool) return;

    selectedTool = toolName;
    if (title) title.textContent = tool.title;

    document.querySelectorAll(".tool-visual").forEach((visual) => {
      const active = visual.id === tool.visualId;
      visual.classList.toggle("active", active);
      visual.setAttribute("aria-hidden", String(!active));
    });

    document.querySelectorAll(".tool-switcher button").forEach((button) => {
      const active = button.dataset.tool === toolName;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });

    if (announce) showToast(tool.toast);
  }

  function initToolSwitcher() {
    document.querySelectorAll(".tool-switcher button").forEach((button) => {
      button.addEventListener("click", () => setTool(button.dataset.tool, true));
    });

    const action = document.getElementById("hero-primary-action");
    if (action) {
      action.addEventListener("click", () => {
        if (selectedTool === "focus") {
          toggleFocus();
          return;
        }
        showToast(tools[selectedTool].toast);
      });
    }
  }

  const SPARK_POINTS = 28;

  function nextMetricValue(prev, min, max) {
    const drift = (Math.random() - 0.5) * (max - min) * 0.35;
    return Math.min(max, Math.max(min, prev + drift));
  }

  function drawSpark(svg, history, min, max) {
    if (!svg) return;
    const w = 120;
    const h = Number(svg.viewBox.baseVal.height) || 36;
    const pad = 2;
    const span = Math.max(max - min, 1);
    const points = history.map((value, index) => {
      const x = (index / (SPARK_POINTS - 1)) * w;
      const y = pad + (1 - (value - min) / span) * (h - pad * 2);
      return [x, y];
    });
    const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    svg.querySelector(".metric-spark-line").setAttribute("d", line);
    svg.querySelector(".metric-spark-fill").setAttribute("d", `${line} L${w} ${h} L0 ${h} Z`);
  }

  function createSparkMetric(labelId, svgId, min, max) {
    const start = min + (max - min) * 0.5;
    const history = Array.from({ length: SPARK_POINTS }, () => min + Math.random() * (max - min) * 0.6);
    history[history.length - 1] = start;
    return { label: document.getElementById(labelId), svg: document.getElementById(svgId), history, min, max };
  }

  function initMonitor() {
    const metrics = [
      createSparkMetric("hero-cpu-label", "hero-cpu-spark", 8, 64),
      createSparkMetric("hero-ram-label", "hero-ram-spark", 38, 72),
      createSparkMetric("hero-net-label", "hero-net-spark", 2, 34),
      createSparkMetric("showcase-system-label", "showcase-system-spark", 24, 58),
    ];

    const update = () => {
      metrics.forEach((metric) => {
        const prev = metric.history[metric.history.length - 1];
        const value = nextMetricValue(prev, metric.min, metric.max);
        metric.history.push(value);
        metric.history.shift();
        if (metric.label) metric.label.textContent = `${Math.round(value)}%`;
        drawSpark(metric.svg, metric.history, metric.min, metric.max);
      });
    };

    update();
    window.setInterval(update, 1600);
  }

  function updateFocus() {
    const time = document.getElementById("focus-time");
    const ring = document.getElementById("focus-ring");
    const minutes = String(Math.floor(focusRemaining / 60)).padStart(2, "0");
    const seconds = String(focusRemaining % 60).padStart(2, "0");
    const degrees = Math.round((1 - focusRemaining / focusTotal) * 360);

    if (time) time.textContent = `${minutes}:${seconds}`;
    if (ring) ring.style.setProperty("--focus-progress", `${degrees}deg`);
  }

  function toggleFocus() {
    const button = document.getElementById("focus-toggle");

    if (focusTimer) {
      window.clearInterval(focusTimer);
      focusTimer = null;
      if (button) button.textContent = "Start";
      showToast("Focus timer paused.");
      return;
    }

    focusTimer = window.setInterval(() => {
      if (focusRemaining <= 0) {
        window.clearInterval(focusTimer);
        focusTimer = null;
        focusRemaining = focusTotal;
        if (button) button.textContent = "Start";
        updateFocus();
        showToast("Focus session complete.");
        return;
      }

      focusRemaining -= 1;
      updateFocus();
    }, 1000);

    if (button) button.textContent = "Pause";
    showToast("Focus timer started.");
  }

  function adjustFocus(deltaMinutes) {
    const next = focusTotal + deltaMinutes * 60;
    focusTotal = Math.min(60 * 60, Math.max(5 * 60, next));
    focusRemaining = focusTotal;
    updateFocus();
    showToast(`Session length: ${focusTotal / 60} min`);
  }

  function initFocus() {
    const button = document.getElementById("focus-toggle");
    const minus = document.getElementById("focus-minus");
    const plus = document.getElementById("focus-plus");
    if (button) button.addEventListener("click", toggleFocus);
    if (minus) minus.addEventListener("click", () => adjustFocus(-1));
    if (plus) plus.addEventListener("click", () => adjustFocus(1));
    updateFocus();
  }

  function initClipboard() {
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const value = button.dataset.copy || "";
        button.classList.remove("copied");
        void button.offsetWidth;
        button.classList.add("copied");
        window.setTimeout(() => button.classList.remove("copied"), 900);
        try {
          await navigator.clipboard.writeText(value);
          showToast(`Copied: ${value}`);
        } catch {
          showToast(`Copy preview: ${value}`);
        }
      });
    });
  }

  function initComparePopoverControls() {
    const popover = document.querySelector(".compare-menu-popover");
    if (!popover) return;

    const focusTime = popover.querySelector("[data-compare-focus-time]");
    const focusToggle = popover.querySelector("[data-compare-focus='toggle']");
    const focusMinus = popover.querySelector("[data-compare-focus='minus']");
    const focusPlus = popover.querySelector("[data-compare-focus='plus']");
    let compareFocusTotal = 25 * 60;
    let compareFocusRemaining = compareFocusTotal;
    let compareFocusTimer = null;

    function updateCompareFocus() {
      if (!focusTime) return;
      const mm = String(Math.floor(compareFocusRemaining / 60)).padStart(2, "0");
      const ss = String(compareFocusRemaining % 60).padStart(2, "0");
      focusTime.textContent = `${mm}:${ss}`;
    }

    function adjustCompareFocus(deltaMinutes) {
      compareFocusTotal = Math.min(60 * 60, Math.max(5 * 60, compareFocusTotal + deltaMinutes * 60));
      compareFocusRemaining = compareFocusTotal;
      updateCompareFocus();
      showToast(`Session length: ${compareFocusTotal / 60} min`);
    }

    if (focusToggle) {
      focusToggle.addEventListener("click", () => {
        if (compareFocusTimer) {
          window.clearInterval(compareFocusTimer);
          compareFocusTimer = null;
          focusToggle.textContent = "Start";
          showToast("Focus timer paused.");
          return;
        }

        compareFocusTimer = window.setInterval(() => {
          if (compareFocusRemaining <= 0) {
            window.clearInterval(compareFocusTimer);
            compareFocusTimer = null;
            compareFocusRemaining = compareFocusTotal;
            focusToggle.textContent = "Start";
            updateCompareFocus();
            showToast("Focus session complete.");
            return;
          }

          compareFocusRemaining -= 1;
          updateCompareFocus();
        }, 1000);

        focusToggle.textContent = "Pause";
        showToast("Focus timer started.");
      });
    }

    if (focusMinus) focusMinus.addEventListener("click", () => adjustCompareFocus(-1));
    if (focusPlus) focusPlus.addEventListener("click", () => adjustCompareFocus(1));
    updateCompareFocus();

    const shotButtons = Array.from(popover.querySelectorAll("[data-compare-shot]"));
    shotButtons.forEach((button) => {
      button.addEventListener("click", () => {
        shotButtons.forEach((item) => item.classList.remove("is-selected"));
        button.classList.add("is-selected");
        showToast(`${button.dataset.compareShot} capture selected.`);
      });
    });

    const colors = ["#F4F2ED", "#FF9B1A", "#70D7C4", "#8EA7FF", "#F06A6A"];
    const swatch = popover.querySelector("[data-compare-swatch]");
    const colorCode = popover.querySelector("[data-compare-color-code]");
    const colorButton = popover.querySelector("[data-compare-color]");
    let colorIndex = 0;

    function updateColorPreview() {
      const color = colors[colorIndex];
      if (swatch) swatch.style.background = color;
      if (colorCode) colorCode.textContent = color;
      if (colorButton) colorButton.textContent = "Pick Color";
    }

    if (colorButton) {
      colorButton.addEventListener("click", () => {
        colorIndex = (colorIndex + 1) % colors.length;
        updateColorPreview();
        showToast(`Picked color: ${colors[colorIndex]}`);
      });
    }

    updateColorPreview();

    setupAddMenu(
      popover.querySelector("[data-compare-add]"),
      popover.querySelector("[data-compare-add-menu]")
    );
  }

  function setupAddMenu(toggle, menu) {
    if (!toggle || !menu) return;

    const close = () => {
      menu.classList.remove("is-open");
      toggle.classList.remove("is-active");
      toggle.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      menu.classList.add("is-open");
      toggle.classList.add("is-active");
      toggle.setAttribute("aria-expanded", "true");
    };

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.classList.contains("is-open")) close();
      else open();
    });

    menu.querySelectorAll("[role='menuitem']").forEach((item) => {
      item.addEventListener("click", () => {
        showToast(`Added: ${item.textContent.trim()}`);
        close();
      });
    });

    document.addEventListener("click", (event) => {
      if (!menu.contains(event.target) && event.target !== toggle) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
  }

  // The hero panel cycles through every card the app's Panel Design page
  // offers. Every few seconds the card shown longest leaves its column and the
  // widget waiting longest takes its place; when the newcomer is taller, the
  // column's next-oldest cards leave with it, and any room left over is filled
  // with the next waiting cards that fit. Neighbours glide with a FLIP move.
  function initWidgetRotation() {
    const mock = document.querySelector(".hero-product .app-mock[data-rotate]");
    if (!mock) return;
    const cols = Array.from(mock.querySelectorAll(":scope > .mock-col"));
    const cards = Array.from(mock.querySelectorAll(".mock-card[data-widget]"));
    if (cols.length < 2 || cards.length < 3) return;

    const INTERVAL = 2000;
    const LEAVE_MS = 260;
    const ENTER_MS = 500;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const shownAt = (card) => Number(card.dataset.shown || 0);
    const byOldest = (a, b) => shownAt(a) - shownAt(b);
    const gapOf = (col) => parseFloat(getComputedStyle(col).gap) || 0;
    const visibleIn = (col) => Array.from(col.children).filter((c) => c.matches(".mock-card") && !c.hidden);
    // Anything else in a column (the "+" add-tool button) keeps its row.
    const extrasHeight = (col, gap) => Array.from(col.children)
      .filter((c) => !c.matches(".mock-card") && !c.hidden)
      .reduce((sum, c) => sum + c.offsetHeight + gap, 0);
    const stackHeight = (list, gap) => list.reduce((sum, c) => sum + c.offsetHeight, 0) + gap * Math.max(0, list.length - 1);
    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    let clock = 0;
    let paused = false;
    let busy = false;
    let searching = false;
    let hit = null;
    const hitRow = document.querySelector("[data-mock-search-hit]");

    // Leave order starts at the bottom of the columns and alternates between
    // them, so the first swaps happen away from the panel's top corners.
    const initial = [];
    const perCol = cols.map((col) => visibleIn(col).reverse());
    for (let i = 0; i < Math.max(...perCol.map((l) => l.length)); i += 1) {
      perCol.forEach((list) => { if (list[i]) initial.push(list[i]); });
    }
    initial.forEach((card) => { card.dataset.shown = String(++clock); });

    // A hidden card's height, measured in the column it would join.
    function measure(card, col) {
      if (!card.hidden) return card.offsetHeight;
      const style = card.getAttribute("style");
      card.hidden = false;
      card.style.cssText = `${style || ""};position:absolute;visibility:hidden;width:${col.clientWidth}px;transition:none;animation:none`;
      const height = card.offsetHeight;
      if (style) card.setAttribute("style", style);
      else card.removeAttribute("style");
      card.hidden = true;
      return height;
    }

    // The panel keeps the height of its opening layout, so swaps never move
    // the rest of the hero; the columns fill that budget and no more. While a
    // search hit sits above the grid, the grid gives up that much height so
    // the window's outer size, and everything below it, stays put.
    const surface = mock.closest(".hero-window") || mock;
    let lockedHeight = 0;
    function applyHeight() {
      if (!lockedHeight) return;
      let height = lockedHeight;
      if (hit) {
        const windowGap = parseFloat(getComputedStyle(surface).rowGap) || parseFloat(getComputedStyle(surface).gap) || 0;
        height = Math.max(0, lockedHeight - hitRow.offsetHeight - windowGap);
      }
      mock.style.height = `${Math.ceil(height)}px`;
      surface.classList.toggle("is-searching", !!hit);
    }
    function lockHeight() {
      mock.style.height = "";
      let tallest = 0;
      cols.forEach((col) => {
        const gap = gapOf(col);
        const set = Array.from(col.querySelectorAll(".mock-card[data-initial]"));
        tallest = Math.max(tallest, set.reduce((sum, c) => sum + measure(c, col), 0) + gap * Math.max(0, set.length - 1) + extrasHeight(col, gap));
      });
      lockedHeight = tallest;
      applyHeight();
    }

    function fadeOut(list) {
      if (reduceMotion.matches) return Promise.resolve();
      list.forEach((card) => card.classList.add("is-leaving"));
      return wait(LEAVE_MS);
    }

    function flip(before) {
      if (reduceMotion.matches) return;
      const moves = [];
      before.forEach(([card, top]) => {
        const dy = top - card.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) moves.push([card, dy]);
      });
      moves.forEach(([card, dy]) => {
        card.style.transition = "none";
        card.style.transform = `translateY(${dy}px)`;
      });
      void mock.offsetHeight;
      moves.forEach(([card]) => {
        card.style.transition = "";
        card.style.transform = "";
      });
    }

    // Which of `options` fill `free` pixels best. The pool is small, so every
    // subset is tried; the tallest total wins and older cards break ties.
    function bestFill(options, free, gap, heightOf) {
      let best = { cards: [], height: 0, age: Infinity };
      const n = Math.min(options.length, 6);
      for (let mask = 1; mask < (1 << n); mask += 1) {
        const cards = [];
        let height = 0;
        let age = 0;
        for (let i = 0; i < n; i += 1) {
          if (mask & (1 << i)) {
            cards.push(options[i]);
            height += gap + heightOf(options[i]);
            age += shownAt(options[i]);
          }
        }
        if (height > free) continue;
        if (height > best.height || (height === best.height && age < best.age)) best = { cards, height, age };
      }
      return best;
    }

    // The card shown longest always leaves. Among the few widgets waiting
    // longest, pick the one that leaves the least empty space once the
    // column's next-oldest cards go with it (a tall newcomer may need two) and
    // any room left is filled from the pool. Passing over a widget costs a
    // little, taking an extra card out of the column costs a little more, and a
    // widget passed over four times goes in next no matter what.
    function plan(pool, oldest, col) {
      const gap = gapOf(col);
      const budget = col.clientHeight - extrasHeight(col, gap);
      const colCards = visibleIn(col);
      const colByAge = colCards.slice().sort(byOldest);
      const heights = new Map();
      const heightOf = (card) => {
        if (!heights.has(card)) heights.set(card, measure(card, col));
        return heights.get(card);
      };
      const starved = pool.find((c) => Number(c.dataset.skips || 0) >= 4);
      const candidates = starved ? [starved] : pool.slice(0, 3);
      let best = null;
      candidates.forEach((cand, ci) => {
        const height = heightOf(cand);
        let minimal = 0;
        for (let k = 1; k <= colByAge.length; k += 1) {
          const chain = colByAge.slice(0, k);
          const staying = colCards.filter((c) => !chain.includes(c));
          const free = budget - stackHeight(staying, gap) - (staying.length ? gap : 0) - height;
          if (free < 0) continue;
          if (!minimal) minimal = k;
          const fill = bestFill(pool.filter((c) => c !== cand), free, gap, heightOf);
          const score = free - fill.height + 14 * ci + 24 * (k - minimal);
          if (!best || score < best.score) best = { score, leaving: chain, entering: [cand, ...fill.cards] };
        }
      });
      if (!best && starved) return plan(pool.filter((c) => c !== starved), oldest, col);
      return best;
    }

    async function tick() {
      if (busy || paused || searching || document.hidden) return;
      const pool = cards.filter((c) => c.hidden).sort(byOldest);
      const visible = cards.filter((c) => !c.hidden).sort(byOldest);
      if (!pool.length || !visible.length) return;

      const oldest = visible[0];
      const col = oldest.parentElement;
      const next = plan(pool, oldest, col);
      if (!next) return;
      const { leaving, entering } = next;
      pool.forEach((c) => {
        c.dataset.skips = entering.includes(c) ? "0" : String(Number(c.dataset.skips || 0) + 1);
      });
      const staying = visibleIn(col).filter((c) => !leaving.includes(c));

      busy = true;
      mock.dispatchEvent(new CustomEvent("mock-layout-change", { bubbles: true }));
      await fadeOut(leaving);
      const before = staying.map((card) => [card, card.getBoundingClientRect().top]);
      const anchor = leaving[0];
      leaving.forEach((card) => {
        card.classList.remove("is-leaving");
        card.hidden = true;
      });
      entering.forEach((card) => {
        col.insertBefore(card, anchor);
        card.hidden = false;
        card.dataset.shown = String(++clock);
        card.classList.add("is-entering");
      });
      flip(before);
      await wait(ENTER_MS);
      entering.forEach((card) => card.classList.remove("is-entering"));
      busy = false;
    }

    // The panel search, scored like the app's: label beats keyword alias beats
    // description. The best card moves up under the bar while there is text
    // and returns to its slot when it is cleared; rotation waits meanwhile.
    const SEARCH_FIELDS = {
      "system-stats": { description: "CPU, RAM & uptime", keywords: ["cpu", "ram", "memory", "uptime", "stats", "monitor", "system"] },
      "clipboard":    { description: "Recent clipboard items", keywords: ["copy", "paste", "history", "clip"] },
      "screenshot":   { description: "Quick screen capture", keywords: ["capture", "record", "screen", "video", "snap"] },
      "caffeine":     { description: "Prevent display sleep", keywords: ["awake", "sleep", "caffeine", "display"] },
      "new-file":     { description: "Create files quickly", keywords: ["file", "create", "new", "template"] },
      "convert":      { description: "Convert file formats", keywords: ["convert", "format", "pdf", "image", "jpg", "png", "rename"] },
      "color-picker": { description: "Pick colors from screen", keywords: ["color", "colour", "hex", "rgb", "eyedropper", "pick"] },
      "pomodoro":     { description: "Focus timer", keywords: ["timer", "focus", "break", "tomato"] },
      "screen-draw":  { description: "Draw over the screen", keywords: ["draw", "annotate", "pen", "brush", "paint"] },
      "mirror":       { description: "Camera preview under the notch", keywords: ["camera", "webcam", "notch", "face"] },
      "clean-mode":   { description: "Lock input while you clean", keywords: ["clean", "lock", "keyboard", "trackpad", "wipe"] },
      "sticky-notes": { description: "Quick notes on your screen", keywords: ["note", "notes", "memo", "sticky", "deck"] },
    };

    function searchScore(query, card) {
      const q = query.trim().toLowerCase();
      if (!q) return 0;
      const fields = SEARCH_FIELDS[card.dataset.widget] || {};
      const label = (card.querySelector(".mock-card-head strong")?.textContent || "").trim().toLowerCase();
      const words = (fields.keywords || []).map((w) => w.toLowerCase());
      const desc = (fields.description || "").toLowerCase();
      if (label === q) return 5;
      if (label.startsWith(q)) return 4;
      if (label.includes(q)) return 3;
      if (words.some((w) => w.startsWith(q))) return 2;
      if (words.some((w) => w.includes(q)) || desc.includes(q)) return 1;
      return 0;
    }

    const searchForm = document.querySelector("[data-mock-search]");
    const searchInput = searchForm ? searchForm.querySelector("input") : null;
    const searchClear = searchForm ? searchForm.querySelector(".mock-search-clear") : null;

    function clearHit() {
      if (!hit) return;
      const { card, parent, next, wasHidden } = hit;
      card.classList.remove("is-hit");
      card.style.transition = "";
      card.style.transform = "";
      parent.insertBefore(card, next && next.parentElement === parent ? next : null);
      card.hidden = wasHidden;
      hitRow.hidden = true;
      hit = null;
      applyHeight();
    }

    function showHit(card) {
      if (hit && hit.card === card) return;
      mock.dispatchEvent(new CustomEvent("mock-layout-change", { bubbles: true }));
      clearHit();
      if (!card) return;
      hit = { card, parent: card.parentElement, next: card.nextElementSibling, wasHidden: card.hidden };
      card.classList.remove("is-entering", "is-leaving");
      card.style.transition = "";
      card.style.transform = "";
      hitRow.appendChild(card);
      card.hidden = false;
      card.classList.add("is-hit");
      hitRow.hidden = false;
      applyHeight();
    }

    function runSearch() {
      const query = searchInput.value;
      searching = query.trim().length > 0;
      if (searchClear) searchClear.hidden = !query;
      let best = null;
      let bestScore = 0;
      cards.forEach((card) => {
        const score = searchScore(query, card);
        if (score > bestScore) { best = card; bestScore = score; }
      });
      showHit(best);
    }

    if (searchForm && searchInput && hitRow) {
      searchForm.addEventListener("submit", (event) => event.preventDefault());
      searchInput.addEventListener("input", runSearch);
      searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && searchInput.value) {
          searchInput.value = "";
          runSearch();
        }
      });
      if (searchClear) {
        searchClear.addEventListener("click", () => {
          searchInput.value = "";
          runSearch();
          searchInput.focus();
        });
      }
    }

    // Keep Awake, Mirror and Screen Draw flip their switch like the app does.
    mock.querySelectorAll(".mock-toggle .mock-switch").forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const box = toggle.closest(".mock-toggle");
        const on = box.classList.toggle("is-on");
        toggle.setAttribute("aria-pressed", String(on));
        const title = box.querySelector(on ? ".mock-toggle-title .is-on-text" : ".mock-toggle-title .is-off-text");
        if (title) showToast(`${title.textContent.trim()}.`);
      });
    });

    // A live CPU figure so the stats card reads as running, not printed.
    const cpuValue = mock.querySelector("[data-stat='cpu']");
    const cpuBar = mock.querySelector("[data-stat-bar='cpu']");
    if (cpuValue && cpuBar) {
      window.setInterval(() => {
        const pct = 16 + Math.round(Math.random() * 18);
        cpuValue.textContent = `${pct}%`;
        cpuBar.style.width = `${pct}%`;
      }, 2200);
    }

    // Hovering or focusing the panel holds the rotation so a visitor can play
    // with the card they're on.
    surface.addEventListener("mouseenter", () => { paused = true; });
    surface.addEventListener("mouseleave", () => { paused = false; });
    surface.addEventListener("focusin", () => { paused = true; });
    surface.addEventListener("focusout", (event) => {
      if (!surface.contains(event.relatedTarget)) paused = false;
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(lockHeight, 150);
    });

    lockHeight();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(lockHeight);
    window.setInterval(tick, INTERVAL);
  }

  // The New File card's type field opens the app's template list. The list
  // lives beside the "+" menu, outside the clipped grid, and is placed under
  // the field when it opens; any card movement closes it.
  function initFileTypeMenu() {
    const surface = document.querySelector(".hero-product .hero-window");
    const field = document.querySelector("[data-file-type]");
    if (!surface || !field) return;
    const label = field.querySelector("span");
    const TEMPLATES = [
      ["txt", "📄"], ["md", "📝"], ["js", "📜"], ["ts", "📘"], ["css", "🎨"], ["html", "🌐"],
      ["json", "📋"], ["py", "🐍"], ["yaml", "⚙️"], ["env", "🔐"], ["csv", "🧮"], ["xml", "🧾"],
      ["sql", "🗃️"], ["sh", "💻"], ["rtf", "🖋️"], ["docx", "📃"], ["xlsx", "📊"], ["pptx", "📽️"],
    ];
    const menu = document.createElement("div");
    menu.className = "mock-add-menu mock-file-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "File type");

    const close = () => {
      menu.classList.remove("is-open");
      field.classList.remove("is-active");
      field.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      const box = surface.getBoundingClientRect();
      const at = field.getBoundingClientRect();
      menu.style.left = `${Math.round(at.left - box.left)}px`;
      menu.style.top = `${Math.round(at.bottom - box.top) + 4}px`;
      menu.style.right = "auto";
      menu.classList.add("is-open");
      field.classList.add("is-active");
      field.setAttribute("aria-expanded", "true");
    };

    TEMPLATES.forEach(([ext, icon]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "option");
      const glyph = document.createElement("i");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = icon;
      item.append(glyph, `.${ext}`);
      if (ext === field.dataset.value) item.classList.add("is-selected");
      item.addEventListener("click", () => {
        field.dataset.value = ext;
        if (label) label.textContent = `${icon} .${ext}`;
        menu.querySelectorAll("button").forEach((b) => b.classList.toggle("is-selected", b === item));
        close();
        showToast(`File type: .${ext}`);
      });
      menu.appendChild(item);
    });
    surface.appendChild(menu);

    field.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.classList.contains("is-open")) close();
      else open();
    });
    document.addEventListener("click", (event) => {
      if (!menu.contains(event.target) && !field.contains(event.target)) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    document.addEventListener("mock-layout-change", close);
    window.addEventListener("resize", close);
  }

  function initAddMenu() {
    setupAddMenu(
      document.getElementById("mock-add-toggle"),
      document.getElementById("mock-add-menu")
    );
  }

  function initAwakeToggle() {
    const toggle = document.getElementById("awake-toggle");
    const label = document.getElementById("awake-label");
    if (!toggle || !label) return;

    toggle.addEventListener("click", () => {
      const nextPressed = toggle.getAttribute("aria-pressed") !== "true";
      toggle.setAttribute("aria-pressed", String(nextPressed));
      label.textContent = nextPressed ? "Blocked" : "Allowed";
      showToast(nextPressed ? "Display sleep blocked." : "Display sleep allowed.");
    });
  }

  function getSourcePage() {
    const path = window.location.pathname.replace(/\/+$/, "");
    if (path.endsWith("/pricing") || path.endsWith("/pricing.html")) return "pricing";
    if (path.endsWith("/success") || path.endsWith("/success.html")) return "success";
    return "home";
  }

  // The buttons go straight to Polar's hosted checkout page. Attribution is
  // appended here after the page loads: Polar records reference_id and utm_*
  // on the order; the checkout link itself carries the product and metadata.
  function decorateCheckoutLinks() {
    const params = new URLSearchParams(window.location.search);
    const campaignKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

    document.querySelectorAll("a[data-checkout-link]").forEach((link) => {
      let url;
      try {
        url = new URL(link.getAttribute("href"));
      } catch (error) {
        return;
      }

      url.searchParams.set("reference_id", getSourcePage());
      campaignKeys.forEach((key) => {
        const value = params.get(key);
        if (value) url.searchParams.set(key, value.slice(0, 250));
      });

      link.setAttribute("href", url.toString());
    });
  }

  function initDownloadButtons() {
    document.querySelectorAll("[data-download]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        document.getElementById("download")?.scrollIntoView({ behavior: "smooth" });
      });
    });
  }

  // The markup ships the current build so the button works without JS; this
  // asks GitHub for the newest release and rewrites the link, version and size
  // so a new release does not leave the page pointing at an old .dmg.
  function initLatestDownload() {
    const link = document.querySelector("[data-latest-download]");
    if (!link) return;

    fetch("https://api.github.com/repos/mahsumozer/mac-kit-releases/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((release) => {
        const asset = (release?.assets || []).find((item) => item.name?.endsWith("arm64.dmg"));
        if (!asset?.browser_download_url) return;

        link.setAttribute("href", asset.browser_download_url);

        const version = String(release.tag_name || "").replace(/^v/, "");
        const versionEl = document.querySelector("[data-latest-version]");
        if (version && versionEl) versionEl.textContent = `Version ${version}`;

        const sizeEl = document.querySelector("[data-latest-size]");
        if (asset.size && sizeEl) {
          sizeEl.innerHTML = `${Math.round(asset.size / 1048576)} MB &middot; .dmg`;
        }
      })
      .catch(() => {});
  }

  function formErrorMessage(code) {
    if (code === "invalid_email") return "Enter a valid email address.";
    if (code === "rate_limited") return "Too many requests. Try again in a few minutes.";
    return "Something went wrong. Please try again.";
  }

  function bindEmailForm(form, endpoint, successMessage, onSuccess) {
    if (!form) return;

    const button = form.querySelector("button[type='submit']");
    let pending = false;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pending) return;
      pending = true;
      if (button) button.disabled = true;

      const data = new FormData(form);
      try {
        const response = await fetch(`${formsApi}${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: String(data.get("EMAIL") || ""),
            email_address_check: String(data.get("email_address_check") || ""),
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (response.ok && result.ok) {
          form.reset();
          showToast(successMessage);
          onSuccess?.();
        } else {
          showToast(formErrorMessage(result.error));
        }
      } catch {
        showToast("Network error. Please try again.");
      } finally {
        pending = false;
        if (button) button.disabled = false;
      }
    });
  }

  const handoffSentKey = "toolkit-handoff-link-sent";
  const handoffPromptKey = "toolkit-handoff-prompt-seen";

  function readFlag(key) {
    try {
      return localStorage.getItem(key) === "true";
    } catch {
      // Privacy-restricted browsers can block localStorage.
      return false;
    }
  }

  function writeFlag(key) {
    try {
      localStorage.setItem(key, "true");
    } catch {
      // Ignore storage failures; these flags only tune how often we ask.
    }
  }

  function initEmailForms() {
    const handoffSent = "Link sent. Open it on your Mac to install Mac Kit.";

    bindEmailForm(
      document.getElementById("contact-form"),
      "/newsletter/subscribe",
      "You're on the list."
    );
    // The visitor has the link now, so stop offering it in every surface.
    const handoffDone = () => {
      writeFlag(handoffSentKey);
      const fab = document.getElementById("handoff-fab");
      if (fab) fab.hidden = true;
      const dialog = document.getElementById("handoff-dialog");
      if (dialog?.open) dialog.close();
    };

    bindEmailForm(
      document.getElementById("handoff-form"),
      "/handoff/email",
      handoffSent,
      handoffDone
    );
    bindEmailForm(
      document.getElementById("handoff-dialog-form"),
      "/handoff/email",
      handoffSent,
      handoffDone
    );
  }

  function initMacHandoff() {
    const ua = navigator.userAgent;
    // iOS user agents say "like Mac OS X", and iPadOS claims "Macintosh"
    // outright, so match on "Macintosh" and let touch points rule out iPads.
    const isIos = /iPhone|iPad|iPod/.test(ua);
    const isMac = !isIos && /Macintosh/.test(ua) && navigator.maxTouchPoints <= 1;
    if (isMac) return;
    document.body.classList.add("show-mac-handoff");
  }

  // Mac Kit cannot be installed from the device this visitor is holding, so
  // offer the link early. Dismissing the dialog shrinks it to a corner button
  // rather than taking the offer away; sending the link removes both.
  function initHandoffPrompt() {
    const dialog = document.getElementById("handoff-dialog");
    const fab = document.getElementById("handoff-fab");
    if (!dialog || !fab || typeof dialog.showModal !== "function") return;
    if (!document.body.classList.contains("show-mac-handoff")) return;
    if (readFlag(handoffSentKey)) return;

    const closeButton = document.getElementById("handoff-dialog-close");
    if (closeButton) closeButton.addEventListener("click", () => dialog.close());
    fab.addEventListener("click", () => {
      // The backdrop is translucent, so the button would sit dimmed behind the
      // dialog it just opened. The close handler brings it back.
      fab.hidden = true;
      dialog.showModal();
    });
    // Catches the close button, Esc, and the successful send alike.
    dialog.addEventListener("close", () => {
      fab.hidden = readFlag(handoffSentKey);
    });

    // Once the dialog has interrupted this browser, later visits only get the
    // button.
    if (readFlag(handoffPromptKey)) {
      fab.hidden = false;
      return;
    }

    window.setTimeout(() => {
      writeFlag(handoffPromptKey);
      dialog.showModal();
    }, 5000);
  }

  function initShowcaseRail() {
    const viewMeta = {
      control:   { label: "Quick controls without switching apps.", title: "Home" },
      capture:   { label: "Capture or record your screen.", title: "Screenshot & Recording" },
      clipboard: { label: "Everything you copy is saved here. Click any item to copy it again.", title: "Clipboard History" },
      focus:     { label: "Focus. Rest. Repeat.", title: "Pomodoro" },
    };
    const viewOrder = ["control", "capture", "clipboard", "focus"];

    const railBtns = document.querySelectorAll(".tool-rail [data-showcase-view]");
    const showcaseViews = document.querySelectorAll(".showcase-view");
    const labelEl = document.getElementById("showcase-view-label");
    const titleEl = document.getElementById("showcase-view-title");

    let current = "control";
    let autoTimer = null;

    function switchView(name) {
      current = name;
      const meta = viewMeta[name];

      railBtns.forEach((btn) => {
        const active = btn.dataset.showcaseView === name;
        btn.classList.toggle("active", active);
      });

      showcaseViews.forEach((el) => {
        const active = el.id === `showcase-${name}`;
        el.classList.toggle("active", active);
      });

      if (labelEl) labelEl.textContent = meta.label;
      if (titleEl) titleEl.textContent = meta.title;
    }

    function startCycle() {
      clearInterval(autoTimer);
      autoTimer = window.setInterval(() => {
        const idx = viewOrder.indexOf(current);
        switchView(viewOrder[(idx + 1) % viewOrder.length]);
      }, 2800);
    }

    railBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        switchView(btn.dataset.showcaseView);
        startCycle();
      });
    });

    const section = document.querySelector(".showcase-section");
    if (section && "IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              startCycle();
            } else {
              clearInterval(autoTimer);
            }
          });
        },
        { threshold: 0.25 }
      );
      observer.observe(section);
    }

    // Animate focus countdown in the control view
    let showcaseFocusRemaining = 24 * 60 + 59;
    const focusTotalSecs = 25 * 60;
    const showcaseFocusTimeEl = document.getElementById("showcase-focus-time");
    const showcaseFocusRingEl = document.getElementById("showcase-focus-ring-mini");
    window.setInterval(() => {
      showcaseFocusRemaining -= 1;
      if (showcaseFocusRemaining < 0) showcaseFocusRemaining = focusTotalSecs;
      const mm = String(Math.floor(showcaseFocusRemaining / 60)).padStart(2, "0");
      const ss = String(showcaseFocusRemaining % 60).padStart(2, "0");
      if (showcaseFocusTimeEl) showcaseFocusTimeEl.textContent = `${mm}:${ss}`;
      const progress = 1 - showcaseFocusRemaining / focusTotalSecs;
      const deg = Math.round(progress * 360);
      if (showcaseFocusRingEl) {
        showcaseFocusRingEl.style.borderColor = `rgba(255,255,255,0.12)`;
        showcaseFocusRingEl.style.borderTopColor = `var(--sw-accent)`;
        showcaseFocusRingEl.style.transform = `rotate(${deg}deg)`;
      }
    }, 1000);

    // Animate sc-focus-display in the focus view countdown
    let scFocusRemaining = 24 * 60 + 59;
    const scFocusDisplayEl = document.querySelector(".sc-focus-display");
    window.setInterval(() => {
      scFocusRemaining -= 1;
      if (scFocusRemaining < 0) scFocusRemaining = focusTotalSecs;
      const mm = String(Math.floor(scFocusRemaining / 60)).padStart(2, "0");
      const ss = String(scFocusRemaining % 60).padStart(2, "0");
      if (scFocusDisplayEl) scFocusDisplayEl.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function initCompareMerge() {
    const section = document.querySelector(".compare-section");
    if (!section) return;

    const oldCol = section.querySelector(".compare-old");
    const vs = section.querySelector(".compare-vs");
    const vsDot = vs && vs.querySelector("span");
    const kitMenu = section.querySelector(".compare-menubar-kit");
    const kitMenuIcon = section.querySelector(".compare-kit-menubar-icon");
    if (!oldCol || !vsDot || !kitMenuIcon) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const groups = Array.from(oldCol.querySelectorAll(".compare-app"));
    if (!groups.length) return;

    const appsWrap = oldCol.querySelector(".compare-apps");
    if (appsWrap) appsWrap.classList.add("is-scattered");

    const layer = document.createElement("div");
    layer.className = "compare-merge";
    layer.setAttribute("aria-hidden", "true");
    section.appendChild(layer);

    const lightning =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.55" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>';

    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    // Give every app a fresh random spot inside the area (loose grid + jitter so
    // they never sit in fixed slots and never heavily overlap).
    function scatter() {
      if (!appsWrap) return;
      const w = appsWrap.clientWidth;
      const h = appsWrap.clientHeight;
      const cols = 3;
      const rows = Math.ceil(groups.length / cols);
      const cellW = w / cols;
      const cellH = h / rows;
      const cells = shuffle(Array.from({ length: cols * rows }, (_, k) => k));
      groups.forEach((g, i) => {
        const cell = cells[i];
        const cx = cell % cols;
        const cy = Math.floor(cell / cols);
        const cw = g.offsetWidth || 112;
        const ch = g.offsetHeight || 96;
        const x = cx * cellW + Math.random() * Math.max(0, cellW - cw);
        const y = cy * cellH + Math.random() * Math.max(0, cellH - ch);
        g.style.left = Math.round(x) + "px";
        g.style.top = Math.round(y) + "px";
      });
    }

    function centerOf(el) {
      const s = section.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
    }

    // Phase 1: the real icon groups slide into the vs, shrinking and fading.
    function flyToVs() {
      const vsC = centerOf(vsDot);
      groups.forEach((g, i) => {
        const home = centerOf(g);
        const dx = vsC.x - home.x;
        const dy = vsC.y - home.y;
        const delay = i * 150;
        g.style.transition = `transform 0.7s cubic-bezier(0.55,0.06,0.3,1) ${delay}ms, opacity 0.7s ease-in ${delay}ms`;
        g.style.transform = `translate(${dx}px, ${dy}px) scale(0.12)`;
        g.style.opacity = "0";
      });
    }

    // Phase 2: fresh icons are re-created sliding in from the left, into new random spots.
    function regenerate() {
      groups.forEach((g) => {
        g.style.transition = "none";
        g.style.transform = "translate(-110px, 0) scale(1)";
        g.style.opacity = "0";
      });
      scatter();
      // Force reflow so the reset takes effect before the slide-in transition.
      void oldCol.offsetWidth;
      groups.forEach((g) => {
        const delay = Math.round(80 + Math.random() * 620);
        const dur = (0.55 + Math.random() * 0.25).toFixed(2);
        g.style.transition = `transform ${dur}s cubic-bezier(0.2,0.7,0.3,1) ${delay}ms, opacity ${dur}s ease ${delay}ms`;
        g.style.transform = "translate(0px, 0px) scale(1)";
        g.style.opacity = "1";
      });
    }

    function resetHome() {
      groups.forEach((g) => {
        g.style.transition = "none";
        g.style.transform = "";
        g.style.opacity = "";
        g.querySelectorAll(".compare-app-icons, .compare-app-name, b").forEach((el) => {
          el.style.transition = "none";
          el.style.transform = "";
          el.style.opacity = "";
        });
      });
    }

    // First appearance: each app's icons fade in first, then its name + price.
    function reveal() {
      groups.forEach((app) => {
        const icons = app.querySelector(".compare-app-icons");
        const texts = [app.querySelector(".compare-app-name"), app.querySelector("b")].filter(Boolean);
        [icons, ...texts].forEach((el) => {
          if (!el) return;
          el.style.transition = "none";
          el.style.opacity = "0";
          el.style.transform = "translateY(9px)";
        });
      });
      void oldCol.offsetWidth;
      groups.forEach((app, i) => {
        const icons = app.querySelector(".compare-app-icons");
        const texts = [app.querySelector(".compare-app-name"), app.querySelector("b")].filter(Boolean);
        const base = i * 85;
        if (icons) {
          icons.style.transition = `opacity 0.45s ease ${base}ms, transform 0.45s cubic-bezier(0.2,0.7,0.3,1) ${base}ms`;
          icons.style.opacity = "1";
          icons.style.transform = "translateY(0)";
        }
        texts.forEach((el, j) => {
          const d = base + 280 + j * 70;
          el.style.transition = `opacity 0.4s ease ${d}ms, transform 0.4s cubic-bezier(0.2,0.7,0.3,1) ${d}ms`;
          el.style.opacity = "1";
          el.style.transform = "translateY(0)";
        });
      });
    }

    // The Mac Kit app icon exits the portal and resolves into the menu bar icon.
    function emergeOne() {
      const start = centerOf(vsDot);
      const target = centerOf(kitMenuIcon);
      const size = 50;
      const icon = document.createElement("span");
      icon.className = "merge-app-icon";
      icon.innerHTML = lightning;
      icon.style.width = size + "px";
      icon.style.height = size + "px";
      icon.style.transform = `translate(${start.x - size / 2}px, ${start.y - size / 2}px) scale(1.16)`;
      layer.appendChild(icon);

      const midX = start.x + (target.x - start.x) * 0.6;
      const midY = Math.min(start.y, target.y) - Math.max(44, Math.abs(target.x - start.x) * 0.1);
      const frames = [
        { transform: `translate(${start.x - size / 2}px, ${start.y - size / 2}px) scale(1.16)`, opacity: 1 },
        { transform: `translate(${midX - size / 2}px, ${midY - size / 2}px) scale(0.78)`, opacity: 1, offset: 0.58 },
        { transform: `translate(${target.x - size / 2}px, ${target.y - size / 2}px) scale(0.48)`, opacity: 0.96 }
      ];

      if (icon.animate) {
        icon.animate(frames, {
          duration: 1120,
          easing: "cubic-bezier(0.2,0.7,0.25,1)",
          fill: "forwards"
        });
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            icon.style.transition = "transform 1.12s cubic-bezier(0.2,0.7,0.25,1)";
            icon.style.transform = frames[2].transform;
          });
        });
      }

      later(() => {
        icon.remove();
        kitMenuIcon.classList.add("is-active");
        if (kitMenu && !kitMenu.classList.contains("is-open")) kitMenu.classList.add("is-open");
      }, 1120);
    }

    const CYCLE = 4400;
    const timeouts = [];
    function later(fn, ms) {
      timeouts.push(window.setTimeout(fn, ms));
    }

    function runCycle() {
      flyToVs();
      later(() => vs.classList.add("is-active"), 250);
      later(emergeOne, 2000);
      later(() => vs.classList.remove("is-active"), 2300);
      later(regenerate, 2150);
    }

    let cycleTimer = null;
    let startTimer = null;
    function start() {
      if (cycleTimer || startTimer) return;
      reveal();
      startTimer = window.setTimeout(() => {
        startTimer = null;
        runCycle();
        cycleTimer = window.setInterval(runCycle, CYCLE);
      }, 1700);
    }
    function stop() {
      if (startTimer) window.clearTimeout(startTimer);
      startTimer = null;
      if (cycleTimer) window.clearInterval(cycleTimer);
      cycleTimer = null;
      timeouts.forEach(window.clearTimeout);
      timeouts.length = 0;
      vs.classList.remove("is-active");
      layer.replaceChildren();
      resetHome();
    }

    scatter();

    let resizeRAF = 0;
    window.addEventListener("resize", () => {
      window.cancelAnimationFrame(resizeRAF);
      resizeRAF = window.requestAnimationFrame(() => {
        resetHome();
        scatter();
      });
    });

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) start();
            else stop();
          });
        },
        { threshold: 0.35 }
      );
      observer.observe(section);
    } else {
      start();
    }
  }

  function initPrivacyChoice() {
    const notice = document.getElementById("privacy-choice");
    const button = document.getElementById("privacy-choice-button");
    if (!notice || !button) return;

    const storageKey = "toolkit-privacy-choices-ack";
    try {
      if (localStorage.getItem(storageKey) === "true") return;
    } catch {
      // Privacy-restricted browsers can block localStorage; still show the notice.
    }

    notice.hidden = false;
    button.addEventListener("click", () => {
      try {
        localStorage.setItem(storageKey, "true");
      } catch {
        // Ignore storage failures; the button should still close the notice.
      }
      notice.hidden = true;
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initHeader();
    initClock();
    initToolSwitcher();
    initMonitor();
    initFocus();
    initClipboard();
    initAddMenu();
    initWidgetRotation();
    initFileTypeMenu();
    initAwakeToggle();
    decorateCheckoutLinks();
    initDownloadButtons();
    initLatestDownload();
    initEmailForms();
    initMacHandoff();
    initHandoffPrompt();
    initPrivacyChoice();
    initShowcaseRail();
    initCompareMerge();
    initComparePopoverControls();
    setTool("capture", false);
  });
})();
