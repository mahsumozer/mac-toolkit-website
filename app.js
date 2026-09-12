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

  // At most five messages stand at once: a burst of them — a run of copies,
  // say — pushes the oldest out rather than filling the screen.
  const TOASTS_ON_SCREEN = 5;

  // Set by the Screenshot card, which owns the corner the shots land in; the
  // mirror drops its stills into the same corner.
  let dropShotInCorner = null;

  function dismissToast(toast) {
    if (toast.classList.contains("out")) return;
    toast.classList.add("out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  }

  function showToast(message) {
    const region = document.getElementById("toast-region");
    if (!region) return;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    region.appendChild(toast);

    const standing = Array.from(region.querySelectorAll(".toast")).filter((t) => !t.classList.contains("out"));
    standing.slice(0, Math.max(0, standing.length - TOASTS_ON_SCREEN)).forEach(dismissToast);

    window.setTimeout(() => dismissToast(toast), 2600);
  }

  // A widget the visitor is actually using stays put: the panel's rotation
  // never swaps out a card that is holding something — a running timer, a
  // switch that is on, a name half typed — so nothing disappears mid-use.
  // Passing `seconds` releases the hold on its own, for one-off actions.
  const widgetHolds = new Map();

  function widgetCard(name) {
    return document.querySelector(`.hero-product .mock-card[data-widget="${name}"]`);
  }

  function holdWidget(name, seconds) {
    const card = widgetCard(name);
    if (!card) return;
    card.dataset.inUse = "true";
    // Held while it happens to be out of the panel — picked up from a search
    // hit, say — it goes to the front of the queue and comes back in.
    if (card.hidden) card.dataset.skips = "9";
    window.clearTimeout(widgetHolds.get(name));
    widgetHolds.delete(name);
    if (!seconds) return;
    widgetHolds.set(name, window.setTimeout(() => {
      card.dataset.inUse = "false";
      widgetHolds.delete(name);
    }, seconds * 1000));
  }

  function releaseWidget(name) {
    const card = widgetCard(name);
    window.clearTimeout(widgetHolds.get(name));
    widgetHolds.delete(name);
    if (card) card.dataset.inUse = "false";
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
    const strip = document.getElementById("strip-timer");
    const minutes = String(Math.floor(focusRemaining / 60)).padStart(2, "0");
    const seconds = String(focusRemaining % 60).padStart(2, "0");
    const degrees = Math.round((1 - focusRemaining / focusTotal) * 360);

    if (time) time.textContent = `${minutes}:${seconds}`;
    if (ring) ring.style.setProperty("--focus-progress", `${degrees}deg`);
    // The status item carries the time left while a session runs, and drops it
    // when the timer stops, the way the app titles its tray.
    if (strip) strip.textContent = `${minutes}:${seconds}`;
  }

  function showStripTimer(running) {
    const strip = document.getElementById("strip-timer");
    if (strip) strip.hidden = !running;
  }

  function toggleFocus() {
    const button = document.getElementById("focus-toggle");

    if (focusTimer) {
      window.clearInterval(focusTimer);
      focusTimer = null;
      if (button) button.textContent = "Start";
      showStripTimer(false);
      releaseWidget("pomodoro");
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
        showStripTimer(false);
        releaseWidget("pomodoro");
        showToast("Focus session complete.");
        return;
      }

      focusRemaining -= 1;
      updateFocus();
    }, 1000);

    if (button) button.textContent = "Pause";
    showStripTimer(true);
    holdWidget("pomodoro");
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
        holdWidget("clipboard", 20);
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
  }

  function setupAddMenu(toggle, menu) {
    if (!toggle || !menu) return;

    // The list hangs below the panel, so it lives outside it: a sheet blurred
    // inside the panel only sees the panel behind it, and past its edge it has
    // nothing to blur and turns into a black slab.
    const panel = toggle.closest(".hero-window");
    const hero = panel ? panel.closest(".hero") : null;
    if (panel && hero) hero.appendChild(menu);

    const close = () => {
      menu.classList.remove("is-open");
      toggle.classList.remove("is-active");
      toggle.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      if (panel && hero) {
        const box = hero.getBoundingClientRect();
        const at = panel.getBoundingClientRect();
        menu.style.top = `${Math.round(at.bottom - box.top + 6)}px`;
        menu.style.right = `${Math.round(box.right - at.right + 12)}px`;
      }
      menu.classList.add("is-open");
      toggle.classList.add("is-active");
      toggle.setAttribute("aria-expanded", "true");
    };

    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.classList.contains("is-open")) close();
      else open();
    });

    // Picking a tool types it into the panel's search, which is how the panel
    // brings a card to the front.
    const search = menu.closest(".hero-window")?.querySelector("[data-mock-search] input");
    menu.querySelectorAll("[role='menuitem']").forEach((item) => {
      item.addEventListener("click", () => {
        close();
        if (!search) return;
        search.value = item.dataset.query || item.textContent.trim();
        search.dispatchEvent(new Event("input", { bubbles: true }));
        search.focus({ preventScroll: true });
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
    // What the panel is allowed to hold at once, counted rather than measured.
    const MAX_CARDS = 5;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const shownAt = (card) => Number(card.dataset.shown || 0);
    const held = (card) => card.dataset.inUse === "true";
    const byOldest = (a, b) => shownAt(a) - shownAt(b);
    const gapOf = (col) => parseFloat(getComputedStyle(col).gap) || 0;
    const visibleIn = (col) => Array.from(col.children).filter((c) => c.matches(".mock-card") && !c.hidden);
    // Anything else in a column (the "+" add-tool button) keeps its row.
    const extrasHeight = (col, gap) => Array.from(col.children)
      .filter((c) => !c.matches(".mock-card") && !c.hidden)
      .reduce((sum, c) => sum + c.offsetHeight + gap, 0);
    const stackHeight = (list, gap) => list.reduce((sum, c) => sum + c.offsetHeight, 0) + gap * Math.max(0, list.length - 1);
    const shownCount = () => cards.filter((c) => !c.hidden).length;
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

    // The panel is only as tall as what is in it: every swap re-measures the
    // columns and the window settles on the taller one, so a line-up that
    // comes up short leaves no band of empty glass under the cards. The
    // opening layout still sets the ceiling — growing past it would push the
    // hero around — and while a search hit sits above the grid, the grid gives
    // up that much of the ceiling so the window's outer size stays put.
    const surface = mock.closest(".hero-window") || mock;
    let openHeight = 0;
    const contentHeight = () => cols.reduce((tallest, col) => {
      const gap = gapOf(col);
      return Math.max(tallest, stackHeight(visibleIn(col), gap) + extrasHeight(col, gap));
    }, 0);
    // `now` skips the height animation. The search hit's row opens in the same
    // frame it is filled, and the grid has to give up its share in that frame
    // too — a grid still easing down while the row is already there makes the
    // panel briefly taller than it has ever been, which pushes the headline
    // beside it down the page and back.
    function applyHeight(now) {
      if (!openHeight) return;
      // The grid never grows past the line-up the panel opened with, and never
      // past what the column it sits in can still give. When a search hit opens
      // a row above the grid, that row is paid for out of the column's spare
      // room first — the reservation is taller than the panel — so the grid
      // keeps its cards instead of being cut off at the window's edge. Only
      // where the column has nothing left to give does the grid give way.
      const ceiling = Math.min(openHeight, roomFor());
      const full = contentHeight();
      const height = Math.min(full, ceiling);
      if (now) mock.style.transition = "none";
      mock.style.height = `${Math.ceil(height)}px`;
      if (now) {
        void mock.offsetHeight;
        mock.style.transition = "";
      }
      // The fade belongs to a grid that is actually cut, not to every search.
      surface.classList.toggle("is-searching", full > height + 1);
      clip(height);
    }

    // What the grid has no room for is left out, not shown sliced: a card cut
    // through the middle by the window's edge draws a hard line across the
    // panel, and the line moves every time the line-up changes. Hidden by
    // visibility rather than by `hidden`, so the layout these heights were
    // measured from does not shift under the measurement.
    function clip(height) {
      // Off the layout, not off the painted box: cards carry a transform while
      // they glide into their new places, and a card measured mid-glide reads
      // as hanging out of the grid when its slot is well inside it.
      cols.forEach((col) => {
        Array.from(col.children).filter((item) => !item.hidden).forEach((item) => {
          const bottom = item.offsetTop - mock.offsetTop + item.offsetHeight;
          item.classList.toggle("is-clipped", bottom > height + 1);
        });
      });
    }
    // The hero's first grid row is as tall as its tallest column, and the copy
    // beside the panel is aligned to that row's bottom edge. A panel that
    // breathes would drag the headline up and down with it, so the column keeps
    // the height it opens at and the panel shrinks inside that reservation.
    const product = surface.closest(".hero-product");

    // How tall the grid may be before the column outgrows the height it was
    // reserved at: the reservation, less everything in the column that is not
    // the grid. The column is stretched to the hero's first row, so what it was
    // locked at is usually taller than the panel and there is room to spare.
    function roomFor() {
      if (!product) return Infinity;
      const locked = parseFloat(product.style.minHeight) || 0;
      if (!locked) return Infinity;
      const style = getComputedStyle(product);
      const gap = parseFloat(style.rowGap) || parseFloat(style.gap) || 0;
      let rest = 0;
      let count = 0;
      Array.from(product.children).forEach((child) => {
        if (child.hidden) return;
        const box = child.getBoundingClientRect();
        if (!box.height) return;
        rest += box.height + (parseFloat(getComputedStyle(child).marginTop) || 0);
        count += 1;
      });
      rest += gap * Math.max(0, count - 1);
      rest -= mock.getBoundingClientRect().height;
      return Math.max(0, locked - rest);
    }

    function lockHeight() {
      mock.style.height = "";
      if (product) product.style.minHeight = "";
      let tallest = 0;
      cols.forEach((col) => {
        const gap = gapOf(col);
        const set = Array.from(col.querySelectorAll(".mock-card[data-initial]"));
        tallest = Math.max(tallest, set.reduce((sum, c) => sum + measure(c, col), 0) + gap * Math.max(0, set.length - 1) + extrasHeight(col, gap));
      });
      openHeight = tallest;
      applyHeight(true);
      if (product) product.style.minHeight = `${Math.ceil(product.getBoundingClientRect().height)}px`;
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

    // Which of `options` fill `free` pixels best, in at most `room` cards. The
    // pool is small, so every subset is tried; the tallest total wins and older
    // cards break ties.
    function bestFill(options, free, gap, heightOf, room) {
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
        if (height > free || cards.length > room) continue;
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
      // Taken from the opening layout, not from the panel's current height:
      // the panel follows its contents now, and reading that back would mean a
      // column that once came up short could never fill again.
      const budget = openHeight - extrasHeight(col, gap);
      const colCards = visibleIn(col);
      // A held card keeps its place and its height; only the rest can leave.
      const colByAge = colCards.filter((c) => !held(c)).sort(byOldest);
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
          // Height alone is not a limit anyone can see. The short cards — a
          // title and one switch — are a third of the Clipboard's height, so a
          // column of them packs four or five into the same budget, and a
          // narrower window makes it worse: the opening cards the budget is
          // measured from grow as their text wraps, while a switch does not.
          const room = MAX_CARDS - (shownCount() - chain.length) - 1;
          const fill = bestFill(pool.filter((c) => c !== cand), free, gap, heightOf, Math.max(0, room));
          const score = free - fill.height + 14 * ci + 24 * (k - minimal);
          if (!best || score < best.score) best = { score, leaving: chain, entering: [cand, ...fill.cards] };
        }
      });
      if (!best && starved) return plan(pool.filter((c) => c !== starved), oldest, col);
      return best;
    }

    async function tick() {
      // Nothing rotates while the panel is put away from the status item, or
      // while the ghost cursor is on its way to a card it expects to find.
      if (busy || paused || searching || document.hidden || surface.classList.contains("is-closed")) return;
      if (surface.classList.contains("is-demoing")) return;
      const pool = cards.filter((c) => c.hidden).sort(byOldest);
      const visible = cards.filter((c) => !c.hidden && !held(c)).sort(byOldest);
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
      applyHeight();
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
      applyHeight(true);
    }

    function showHit(card) {
      if (hit && hit.card === card) return;
      mock.dispatchEvent(new CustomEvent("mock-layout-change", { bubbles: true }));
      clearHit();
      if (!card) return;
      hit = { card, parent: card.parentElement, next: card.nextElementSibling, wasHidden: card.hidden };
      card.classList.remove("is-entering", "is-leaving", "is-clipped");
      card.style.transition = "";
      card.style.transform = "";
      hitRow.appendChild(card);
      card.hidden = false;
      card.classList.add("is-hit");
      hitRow.hidden = false;
      applyHeight(true);
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
        const widget = toggle.closest(".mock-card")?.dataset.widget;
        if (widget) (on ? holdWidget : releaseWidget)(widget);
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

  // Visitors read the hero panel as a recording of the app and never touch it,
  // so it has to introduce itself twice: a line under the panel saying the
  // buttons are real, and — while nobody has taken over — a ghost cursor that
  // works two of them, which is the part people believe. Any real input hands
  // the panel straight back over.
  function initPanelInvite() {
    const hero = document.querySelector(".hero");
    const panel = document.getElementById("hero-panel");
    const invite = document.getElementById("panel-invite");
    if (!hero || !panel || !invite) return;

    const label = invite.querySelector("[data-panel-invite-text]");
    const search = panel.querySelector("[data-mock-search] input");
    const strip = document.querySelector(".desktop-strip");
    const coarse = window.matchMedia("(hover: none)").matches;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (coarse && label) label.textContent = "This panel is live — tap anything in it.";

    let ghost = null;
    let stopped = false;
    let dismissed = false;
    let typing = false;
    let undoing = [];
    // How many more tools are shown before the mirror is put away. It is the one
    // thing the panel hands to the desktop and leaves there, so closing it in
    // the same breath would make it read as a preview rather than as a window.
    // Declared up here with the rest of the state because `stop` reads it, and
    // `stop` is live on touch devices, where the ghost never gets this far.
    let mirrorFor = 0;
    let hoverOn = null;
    // Handing the panel over is a pause, not an ending: a visitor who looked,
    // touched nothing and moved on gets the demonstration back.
    const IDLE_MS = 5000;
    const FIRST = label ? label.textContent : "";
    let lastTouch = 0;

    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    // The invite only steps aside once the panel itself has been used; a click
    // anywhere else on the page is not an answer to it.
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      invite.classList.add("is-done");
    }

    function stop(event) {
      if (stopped) return;
      stopped = true;
      mirrorFor = 0;
      panel.classList.remove("is-demoing");
      ghostOver(null);
      // A timer left running or a recording left going is the point; a veil or
      // a drawing canvas over the whole hero is not, so those go back. Each
      // one names the control that means "I am driving this myself" — a stroke
      // on the canvas, a press on the status item — and stands down for it,
      // or it would undo the very thing the visitor just reached for.
      const target = event && event.target;
      undoing.splice(0).forEach(({ back, unless }) => {
        if (unless && target && target.closest && target.closest(unless)) return;
        back();
      });
      // A half-typed search is the one thing the ghost leaves behind that a
      // visitor would have to undo.
      if (typing && search) {
        typing = false;
        search.value = "";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        search.blur();
      }
      if (!ghost) return;
      const leaving = ghost;
      ghost = null;
      leaving.classList.remove("is-visible");
      window.setTimeout(() => leaving.remove(), 400);
      if (label && !dismissed) label.textContent = "Your turn — click anything in it.";
    }

    [panel, strip].forEach((target) => {
      if (!target) return;
      target.addEventListener("pointerdown", dismiss);
      target.addEventListener("keydown", dismiss);
    });
    // Only the app itself counts as taking over — the panel, the menu bar and
    // whatever the panel has put out on the hero. Reading the page, following
    // a link or hitting Download is not an answer to the invitation, and the
    // demo has no business stopping for any of it.
    const MINE = ".hero-window, .desktop-strip, .sticky-layer, .draw-canvas, .draw-bar, .clean-veil, .shot-tray, .mirror-frame";
    function handover(event) {
      // The demo draws by sending the canvas the same events a hand would, and
      // the canvas is one of its own. Only a real hand ends it.
      if (!event.isTrusted) return;
      const target = event.target;
      if (!target || !target.closest || !target.closest(MINE)) return;
      lastTouch = Date.now();
      stop(event);
    }
    document.addEventListener("pointerdown", handover, true);
    document.addEventListener("keydown", handover, true);
    // The pointer reaching the panel is the whole point of the thing, so it is
    // also the end of it: from here the panel is the visitor's.
    panel.addEventListener("pointerenter", (event) => {
      lastTouch = Date.now();
      stop(event);
    });

    // A finger has no cursor to borrow, a narrow layout has no room for one,
    // and a visitor who asked for less motion did not ask for this.
    if (coarse || reduceMotion || window.innerWidth < 960) return;

    // `pointerenter` needs the pointer to arrive, and a pointer already parked
    // over the panel never arrives — nor does one resting there while the
    // panel is away and taking no events at all. So where it last was is kept,
    // and read again before each turn.
    let cursorAt = null;
    document.addEventListener("pointermove", (event) => {
      if (!event.isTrusted) return;
      cursorAt = { x: event.clientX, y: event.clientY };
      // While the pointer is there the clock never starts; the five seconds are
      // counted from the moment it leaves.
      if (cursorOnPanel()) lastTouch = Date.now();
    }, { passive: true });

    function cursorOnPanel() {
      if (!cursorAt) return false;
      const box = panel.getBoundingClientRect();
      return cursorAt.x >= box.left && cursorAt.x <= box.right && cursorAt.y >= box.top && cursorAt.y <= box.bottom;
    }

    // Wide controls — the search bar — are clicked near their start rather
    // than dead centre, where a hand would go.
    function place(el, ghostEl) {
      const box = hero.getBoundingClientRect();
      const at = el.getBoundingClientRect();
      const x = at.width > 150 ? at.left + 46 : at.left + at.width / 2;
      ghostEl.style.transform = `translate3d(${Math.round(x - box.left)}px, ${Math.round(at.top - box.top + at.height / 2)}px, 0)`;
    }

    async function moveTo(el, ms) {
      ghost.style.transition = `transform ${ms}ms cubic-bezier(0.33, 0.06, 0.14, 1)`;
      place(el, ghost);
      await wait(ms);
    }

    // A drawn cursor casts no `:hover`, so the control it is standing on is
    // told, and stays told until the cursor goes somewhere else — the same
    // shape a real pointer has. Without it a control whose only answer is the
    // hover itself, like the drawing bar's bin, looks dead under the cursor.
    function ghostOver(el) {
      if (hoverOn === el) return;
      if (hoverOn) hoverOn.classList.remove("is-ghosted");
      hoverOn = el;
      if (el) el.classList.add("is-ghosted");
    }

    async function tap(el, travel) {
      if (stopped || !el || el.hidden) return false;
      const card = el.closest(".mock-card");
      if (card && (card.hidden || card.classList.contains("is-clipped"))) return false;
      await moveTo(el, travel || 620);
      if (stopped) return false;
      ghostOver(el);
      ghost.classList.add("is-pressing");
      await wait(150);
      ghost.classList.remove("is-pressing");
      el.click();
      await wait(160);
      return !stopped;
    }

    // Free-hand work has no element to aim at, so the ghost is sent to a point
    // on the hero instead of to the middle of a control.
    async function slideTo(x, y, ms) {
      if (!ghost) return;
      const box = hero.getBoundingClientRect();
      ghost.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.33, 0.06, 0.14, 1)` : "none";
      ghost.style.transform = `translate3d(${Math.round(x - box.left)}px, ${Math.round(y - box.top)}px, 0)`;
      if (ms) await wait(ms);
    }

    // A drag is the one gesture where the cursor and the thing under it have to
    // agree frame by frame: a window that moves in steps the cursor does not
    // take, or takes late, reads as a dropped grip rather than as a hand. So
    // both come off the same clock — every animation frame places the ghost and
    // sends the move that goes with it — instead of the ghost being handed to a
    // CSS transition while the element is fed a coarser set of positions.
    const swell = (t) => (t < 0.5 ? 2 * t * t : 1 - ((2 - 2 * t) ** 2) / 2);

    async function drag(el, from, to, span) {
      const send = (type, at, buttons) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: at.x, clientY: at.y,
        button: 0, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true,
      }));
      ghostOver(null);
      await slideTo(from.x, from.y, 560);
      if (stopped) return false;
      ghost.classList.add("is-pressing");
      // The press lands before anything moves, the way a hand takes hold of
      // something before it pulls.
      await wait(140);
      if (stopped) { ghost.classList.remove("is-pressing"); return false; }
      send("pointerdown", from, 1);
      // Read off the clock rather than counted out in fixed steps: a browser
      // that cannot give it 60 frames a second covers the same ground in the
      // same time with fewer, larger ones, instead of the whole gesture slowing
      // to a crawl. `requestAnimationFrame` would be the other way to pace it,
      // but it stops dead in a hidden tab and would leave the drag half done.
      const ms = span || 620;
      const begun = performance.now();
      for (;;) {
        const t = Math.min(1, (performance.now() - begun) / ms);
        const at = {
          x: from.x + (to.x - from.x) * swell(t),
          y: from.y + (to.y - from.y) * swell(t),
        };
        slideTo(at.x, at.y, 0);
        send("pointermove", at, 1);
        if (t >= 1 || stopped || !ghost) break;
        await wait(16);
      }
      send("pointerup", to, 0);
      if (ghost) ghost.classList.remove("is-pressing");
      return !stopped;
    }

    async function type(text, field) {
      const into = field || search;
      for (const letter of text) {
        if (stopped) return;
        into.value += letter;
        into.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(110);
      }
    }

    const cardOf = (widget) => panel.querySelector(`.mock-card[data-widget="${widget}"]`);
    const pick = (list) => list[Math.floor(Math.random() * list.length)];

    // A card the rotation happens to be showing is used where it stands; one
    // that is put away is fetched the way a visitor would fetch it, through the
    // panel's own search.
    async function reveal(widget, query, forceSearch) {
      const card = cardOf(widget);
      if (!card) return null;
      if (!forceSearch && !card.hidden) return card;
      if (!search) return null;
      if (!(await tap(search, 640))) return null;
      search.focus({ preventScroll: true });
      typing = true;
      await type(query);
      await wait(820);
      return stopped || card.hidden ? null : card;
    }

    async function restoreSearch() {
      if (!typing || !search) return;
      const clear = panel.querySelector(".mock-search-clear");
      if (!stopped && clear && !clear.hidden) await tap(clear, 380);
      typing = false;
      if (search.value) {
        search.value = "";
        search.dispatchEvent(new Event("input", { bubbles: true }));
      }
      search.blur();
    }

    // The menu bar can only be telling one story at a time: a recording clock
    // and a focus clock running side by side there reads as a bug rather than
    // as two tools. So whichever is running is put out before the next one is
    // started — and put out where it can be seen, through its own card and its
    // own button, rather than switched off behind the visitor's back.
    const RUNNING = {
      "screenshot": {
        query: "record",
        on: () => !!cardOf("screenshot")?.classList.contains("is-recording"),
        stop: (card) => card.querySelector("[data-shot='record']"),
      },
      "pomodoro": {
        query: "focus",
        on: () => document.getElementById("focus-toggle")?.textContent.trim() === "Pause",
        stop: (card) => card.querySelector("#focus-toggle"),
      },
    };

    // The switch on its own only lays an empty sheet over the hero. The drawing
    // is the tool, so the ghost picks up two of them, leaves a mark with each,
    // and wipes the sheet clean again before it puts it away.
    async function scribble() {
      const canvas = document.querySelector(".draw-canvas");
      if (!canvas || canvas.hidden) return;
      const at = canvas.getBoundingClientRect();
      const win = panel.getBoundingClientRect();
      // Drawn beside the panel rather than over it: the marks are the point,
      // and so is still being able to see what they are drawn on.
      const left = win.left - at.left >= at.right - win.right;
      const x0 = (left ? at.left : win.right) + 44;
      const x1 = (left ? win.left : at.right) - 44;
      if (x1 - x0 < 150) return;
      const top = at.top + at.height * 0.3;
      const bottom = at.top + at.height * 0.74;
      const mid = (top + bottom) / 2;
      const inset = (x1 - x0) * 0.22;
      const tool = (name) => document.querySelector(`.draw-bar [aria-label="${name}"]`);

      // Whichever swatch or nib is not the one already lit, so the second mark
      // always comes out in a different colour and a different weight from the
      // first — the bar is a set of settings, not one fixed pen, and only a
      // change in front of the visitor says so.
      const unlit = (names) => names.map(tool).find((item) => item && !item.classList.contains("is-on"));

      if (!(await tap(tool("Arrow"), 520))) return;
      if (!(await drag(canvas, { x: x0, y: mid - 14 }, { x: x1, y: top }))) return;
      await wait(520);
      if (!(await tap(tool("Ellipse"), 480))) return;
      const swatch = unlit(["Colour #f5941d", "Colour #4c6ef5", "Colour #ff453a"]);
      if (swatch && !(await tap(swatch, 420))) return;
      const nib = unlit(["12px", "3px"]);
      if (nib && !(await tap(nib, 360))) return;
      await wait(240);
      if (!(await drag(canvas, { x: x0 + inset, y: mid + 18 }, { x: x1 - inset, y: bottom }))) return;
      await wait(1200);
      if (await tap(tool("Clear"), 480)) await wait(600);
    }

    // Hung under the menu bar the frame still reads as part of the bar. Pulling
    // its corner out and carrying it onto the desktop is the thing that says it
    // is a window of its own, so the ghost does both before it puts the camera
    // away again.
    async function carryTheMirror() {
      const frame = document.querySelector(".mirror-frame");
      if (!frame || frame.hidden) return;
      const grip = frame.querySelector(".mirror-grip");
      const heroBox = hero.getBoundingClientRect();
      const ceiling = strip ? strip.getBoundingClientRect().bottom : heroBox.top;
      let at = frame.getBoundingClientRect();
      // Docked, the corner widens the frame from the middle, so the handle
      // travels half of what the frame gains: 45px out is 90px wider. The frame
      // keeps its 16/10 ratio and hangs from the bar, so its bottom edge drops
      // by the same 90px times that ratio — and the cursor has to fall with it,
      // or it slides off the corner it is supposed to be holding.
      const pull = 45;
      const drop = pull * 2 * (at.height / at.width);
      if (grip && !(await drag(grip, { x: at.right - 10, y: at.bottom - 10 }, { x: at.right - 10 + pull, y: at.bottom - 10 + drop }, 760))) return;
      await wait(560);
      at = frame.getBoundingClientRect();
      // Held by the glass above the blind button: that button is how the camera
      // gets asked for, and the frame refuses to be dragged by it.
      const hold = { x: at.left + 26, y: at.top + 22 };
      // Parked in the empty half of the hero, and on a narrow desktop backed off
      // far enough to keep the panel it came out of uncovered.
      const room = panel.getBoundingClientRect().left - at.width - 24;
      const left = Math.max(heroBox.left + 16, Math.min(heroBox.left + 150, room));
      await drag(frame, { x: hold.x, y: hold.y }, { x: left + 26, y: ceiling + 70 });
    }

    // Its way back out, for a visitor who takes the panel over while it is
    // still up. Unlike every other case this one outlives its own turn, so the
    // undo list keeps it until the frame is actually put away.
    function dropTheMirror() {
      const box = cardOf("mirror")?.querySelector(".mock-toggle");
      if (box && box.classList.contains("is-on")) box.querySelector(".mock-switch").click();
      putTheMirrorBack();
      mirrorFor = 0;
    }

    // Two tools later it goes away the way a visitor would put it away: through
    // the card, which is taken off the panel where it stands if the rotation
    // still has it, and fetched back through the search if it does not.
    async function closeTheMirror() {
      mirrorFor = 0;
      const frame = document.querySelector(".mirror-frame");
      if (!frame || frame.hidden) return;
      const card = await reveal("mirror", "mirror");
      if (card && !stopped) {
        const box = card.querySelector(".mock-toggle");
        if (box && box.classList.contains("is-on") && (await tap(card.querySelector(".mock-switch"), 620))) {
          await wait(400);
          putTheMirrorBack();
          undoing = undoing.filter((entry) => entry.back !== dropTheMirror);
        }
      }
      if (!stopped) await restoreSearch();
    }

    // Put away wide and parked where the ghost left it, the mirror would open
    // there for the next visitor. Its own gesture for going home keeps whatever
    // width it was given, by design, so that half is wound back here.
    function putTheMirrorBack() {
      const frame = document.querySelector(".mirror-frame");
      if (!frame) return;
      frame.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      frame.style.width = "";
    }

    async function takeTheBar(widget) {
      for (const other of Object.keys(RUNNING)) {
        if (other === widget || !RUNNING[other].on()) continue;
        // Fetched the way a visitor would fetch it: used where it stands if the
        // rotation still has the card, searched for if it does not.
        const card = await reveal(other, RUNNING[other].query);
        if (!card || stopped) return false;
        if (!(await tap(RUNNING[other].stop(card), 620))) return false;
        await wait(800);
        await restoreSearch();
        if (stopped) return false;
      }
      return true;
    }

    // Every tool the panel holds, as something to watch it do. `undo` is the
    // way back out of the ones that stay on — it runs if a visitor takes the
    // panel over mid-demo, so nothing is left locked, recording or ticking.
    const CASES = [
      {
        widget: "screenshot",
        query: "screenshot",
        run: async (card) => {
          if (await tap(card.querySelector("[data-shot='full']"), 620)) await wait(1200);
        },
      },
      {
        widget: "screenshot",
        query: "record",
        // Left running: the red badge and the clock in the menu bar keep
        // moving after the ghost has gone, and the button now says Stop, which
        // is a better invitation than anything written under the panel.
        bar: true,
        run: async (card) => {
          if (!(await tap(card.querySelector("[data-shot='record']"), 620))) return;
          await wait(1600);
        },
      },
      {
        widget: "clipboard",
        query: "clipboard",
        run: async (card) => {
          const rows = Array.from(card.querySelectorAll("[data-copy]"));
          if (await tap(pick(rows), 620)) await wait(1100);
        },
      },
      {
        widget: "pomodoro",
        query: "focus",
        // Left running, so the clock is still counting down — in the card and
        // in the menu bar — long after the demo is over.
        bar: true,
        run: async (card) => {
          if (!(await tap(card.querySelector("#focus-toggle"), 620))) return;
          await wait(1800);
        },
      },
      {
        widget: "color-picker",
        query: "color",
        run: async (card) => {
          const away = Array.from(card.querySelectorAll("[data-color-format]"))
            .filter((pill) => pill.dataset.colorFormat !== "hex");
          if (await tap(pick(away), 620)) await wait(1400);
        },
      },
      {
        widget: "caffeine",
        query: "awake",
        // Left on, the way it would be left on for a download: the card keeps
        // saying the display stays awake.
        run: async (card) => {
          if (await tap(card.querySelector(".mock-switch"), 620)) await wait(1600);
        },
      },
      {
        widget: "convert",
        query: "convert",
        run: async (card) => {
          const chips = Array.from(card.querySelectorAll("[data-convert-chips] button"))
            .filter((chip) => !chip.disabled && !chip.classList.contains("is-selected"));
          if (chips.length && !(await tap(pick(chips), 620))) return;
          await wait(500);
          if (await tap(card.querySelector("[data-convert-run]"), 300)) await wait(1500);
        },
      },
      {
        widget: "new-file",
        query: "new file",
        run: async (card) => {
          if (!(await tap(card.querySelector("#mock-file-create"), 620))) return;
          await wait(700);
          const places = Array.from(panel.querySelectorAll(".mock-place-menu.is-open [role='menuitem']"));
          if (places.length && (await tap(pick(places), 420))) await wait(1100);
        },
        undo: () => panel.querySelector(".mock-place-menu")?.classList.remove("is-open"),
      },
      {
        widget: "sticky-notes",
        query: "sticky",
        // The notes walk out of the panel and onto the page, where they stay to
        // be dragged and written in — so this one is deliberately not undone.
        // Two of them, because one note reads as a picture and a second one
        // landing beside it is the moment it stops looking like a screenshot.
        // Once the hero is carrying a few, the card tidies them instead of
        // adding to the pile.
        run: async (card) => {
          if (document.querySelectorAll(".sticky-note").length >= 4) {
            if (await tap(card.querySelector("[data-sticky='list']"), 620)) await wait(1200);
            return;
          }
          const make = card.querySelector("[data-sticky='new']");
          if (!(await tap(make, 620))) return;
          await wait(800);
          if (!(await tap(make, 240))) return;
          await wait(700);
          // A blank note is still furniture. One written on is the only proof
          // that these are fields and not a picture of a note.
          const note = [...document.querySelectorAll(".sticky-note")].pop();
          const line = note && note.querySelector(".sticky-note-row input");
          if (!line || !(await tap(line, 520))) return;
          line.focus({ preventScroll: true });
          await type("I love Mac Kit", line);
          await wait(900);
        },
      },
      {
        widget: "clean-mode",
        query: "clean",
        // Keyboard only: the trackpad lock swallows clicks, which is exactly
        // what a visitor being invited to click should not run into. Unlike
        // the timer or the recording, this one is switched back off — its veil
        // sits over the whole hero, and nothing should be left dimmed.
        run: async (card) => {
          if (!(await tap(card.querySelector("[data-clean='keyboard']"), 620))) return;
          await wait(2200);
          if (await tap(card.querySelector("[data-clean-unlock]"), 300)) await wait(600);
        },
        undo: () => {
          const unlock = cardOf("clean-mode")?.querySelector("[data-clean-unlock]");
          if (unlock && !unlock.closest("[data-clean-state]").hidden) unlock.click();
        },
      },
      {
        widget: "screen-draw",
        query: "draw",
        // Also switched back off: while it is on, its canvas takes every click
        // on the hero, including the ones meant for the panel.
        unless: ".draw-canvas, .draw-bar",
        run: async (card) => {
          const toggle = card.querySelector(".mock-switch");
          if (!(await tap(toggle, 620))) return;
          await wait(700);
          await scribble();
          if (await tap(toggle, 240)) await wait(500);
        },
        undo: () => {
          const box = cardOf("screen-draw")?.querySelector(".mock-toggle");
          if (box && box.classList.contains("is-on")) box.querySelector(".mock-switch").click();
        },
      },
      {
        widget: "mirror",
        query: "mirror",
        // Switched on, never asked. With no gesture behind it the frame comes
        // up blind — the camera crossed out — so the tool is shown without a
        // permission prompt nobody invited. Switched back off after, like the
        // veil: a grey pane parked on the hero is not a tool being shown.
        unless: ".mirror-frame",
        // The only case that is not over when its turn is: the frame is left on
        // the desktop while the next two tools are shown, which is the whole
        // point of a window that comes out of the panel. `closeTheMirror` is
        // what ends it, so this one's undo stays on the list until then.
        keep: true,
        run: async (card) => {
          const toggle = card.querySelector(".mock-switch");
          if (!(await tap(toggle, 620))) return;
          await wait(900);
          await carryTheMirror();
          if (!stopped) mirrorFor = 2;
        },
        undo: dropTheMirror,
      },
      {
        widget: "system-stats",
        query: "cpu",
        search: true,
        run: async () => { await wait(1500); },
      },
      {
        // Not a card but the status item itself: the bolt puts the panel away
        // and brings the same panel back, which is the one gesture that says
        // this lives in the menu bar rather than on a page. The panel is never
        // left away — unless the visitor's own press on the bolt is what cut
        // the demo short, in which case they are the ones opening it.
        widget: "panel-toggle",
        bare: true,
        unless: "#panel-toggle",
        run: async () => {
          const bolt = document.getElementById("panel-toggle");
          if (!bolt || !(await tap(bolt, 700))) return;
          await wait(1600);
          await tap(bolt, 300);
          await wait(600);
        },
        undo: () => {
          const bolt = document.getElementById("panel-toggle");
          if (bolt && panel.classList.contains("is-closed")) bolt.click();
        },
      },
    ];

    async function play(item) {
      // Whatever is holding the menu bar stands down first, so the clock the
      // visitor is about to be shown is not the second one up there.
      if (item.bar && !(await takeTheBar(item.widget))) return !stopped;
      const card = item.bare ? panel : await reveal(item.widget, item.query, item.search);
      if (card && !stopped) {
        if (item.undo) undoing.push({ back: item.undo, unless: item.unless });
        await item.run(card);
        if (!item.keep) undoing = undoing.filter((entry) => entry.back !== item.undo);
      }
      if (!stopped) await restoreSearch();
      return !stopped;
    }

    // It works its way through every tool in a shuffled order rather than
    // drawing each one fresh, so nothing comes up twice before the rest have
    // had a turn — and the same card never goes twice across the seam between
    // two shuffles. The order outlives a handover, so coming back does not mean
    // starting the round again.
    let queue = [];
    let last = null;
    let lastBar = false;
    function next() {
      if (!queue.length) {
        queue = CASES.slice();
        for (let i = queue.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [queue[i], queue[j]] = [queue[j], queue[i]];
        }
        if (queue.length > 1 && queue[0].widget === last) [queue[0], queue[1]] = [queue[1], queue[0]];
        // The two tools that live in the menu bar are kept apart. Back to back,
        // the second one opens by putting the first away, which is a minute of
        // the panel arguing with itself rather than showing anything; a tool
        // that wants nothing from the bar is pulled in between.
        for (let i = 0; i < queue.length; i += 1) {
          if (!queue[i].bar || !(i === 0 ? lastBar : queue[i - 1].bar)) continue;
          const j = queue.findIndex((item, k) => k > i && !item.bar);
          if (j > -1) [queue[i], queue[j]] = [queue[j], queue[i]];
        }
      }
      last = queue[0].widget;
      lastBar = !!queue[0].bar;
      return queue.shift();
    }

    async function run() {
      // A panel the visitor has just been using, or has put away, is not one to
      // start working in front of them. Staying stopped is enough: the watch
      // below tries again once the pointer has been gone long enough.
      if (panel.classList.contains("is-closed") || Date.now() - lastTouch < IDLE_MS) {
        stopped = true;
        panel.classList.remove("is-demoing");
        return;
      }
      stopped = false;
      // The line is the caption on the demonstration, not a one-off greeting:
      // while the ghost is working the panel it is up, even for a visitor who
      // has already sent it away once. Handing the panel back is what takes it
      // down again.
      if (label) label.textContent = FIRST;
      dismissed = false;
      invite.classList.remove("is-done");
      ghost = document.createElement("div");
      ghost.className = "ghost-cursor";
      ghost.setAttribute("aria-hidden", "true");
      ghost.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.44 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z" fill="#111" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"></path></svg>';
      hero.appendChild(ghost);
      // It sets off from the line that just claimed the panel is live, so the
      // sentence and the proof are the same gesture.
      place(invite, ghost);
      void ghost.offsetWidth;
      ghost.classList.add("is-visible");
      panel.classList.add("is-demoing");
      await wait(340);

      // It keeps going for as long as nobody comes near it. There is no point
      // working the panel for a tab nobody is looking at or a hero that has
      // been scrolled past, so it waits those out rather than counting them.
      while (!stopped) {
        while (!stopped && (document.hidden || !onScreen)) await wait(600);
        if (stopped) break;
        if (cursorOnPanel()) { stop(); break; }
        const item = next();
        await play(item);
        if (stopped) break;
        await wait(2400);
        if (item.widget !== "mirror" && mirrorFor > 0 && --mirrorFor === 0) {
          await closeTheMirror();
          if (stopped) break;
          await wait(1600);
        }
      }
    }

    // On the way in, every time. Nothing is remembered between visits: a panel
    // that only introduces itself once is a panel most people never see move.
    let onScreen = false;
    let started = false;
    const watcher = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        onScreen = entry.isIntersecting;
        if (!onScreen || started) return;
        started = true;
        panel.classList.add("is-demoing");
        window.setTimeout(run, 1600);
      });
    }, { threshold: 0.55 });
    watcher.observe(panel);

    // And back in, once the pointer has been away from the panel for five
    // seconds. Somebody who leant in, took nothing and moved on left the panel
    // no better explained than they found it.
    window.setInterval(() => {
      if (!stopped || !started || document.hidden || !onScreen) return;
      if (cursorOnPanel() || Date.now() - lastTouch < IDLE_MS) return;
      run();
    }, 500);
  }

  // Screen Draw. The app draws over your whole screen; the mock draws over the
  // page's own screen — the hero — with the same toolbar underneath: a tool,
  // a colour, a weight, and undo, redo, clear and close.
  function initScreenDraw() {
    const hero = document.querySelector(".hero");
    const card = document.querySelector('.hero-product .mock-card[data-widget="screen-draw"]');
    if (!hero || !card) return;
    const box = card.querySelector(".mock-toggle");
    const toggle = card.querySelector(".mock-switch");
    if (!box || !toggle) return;

    const TOOLS = [
      ["pen", "Pen", '<path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle>'],
      ["marker", "Highlighter", '<path d="m9 11-6 6v3h9l3-3"></path><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"></path>'],
      ["eraser", "Eraser", '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"></path><path d="M22 21H7"></path><path d="m5 11 9 9"></path>'],
      ["line", "Line", '<path d="M5 12h14"></path>'],
      ["arrow", "Arrow", '<path d="M7 17 17 7"></path><path d="M9 7h8v8"></path>'],
      ["rect", "Rectangle", '<rect x="4" y="6" width="16" height="12" rx="2"></rect>'],
      ["ellipse", "Ellipse", '<circle cx="12" cy="12" r="8"></circle>'],
    ];
    const COLORS = ["#1d1d1b", "#ff453a", "#f5941d", "#4c6ef5", "#34c759", "#ff2d55"];
    const SIZES = [3, 6, 12];

    const canvas = document.createElement("canvas");
    canvas.className = "draw-canvas";
    canvas.hidden = true;
    const paint = canvas.getContext("2d");

    const bar = document.createElement("div");
    bar.className = "draw-bar";
    bar.hidden = true;
    hero.append(canvas, bar);

    let tool = "pen";
    let color = COLORS[1];
    let size = SIZES[1];
    let shapes = [];
    let past = [];
    let future = [];
    let drawing = null;
    let hovered = null;

    // Every change is a whole state, so undo puts back an erased mark as
    // readily as it takes away a drawn one.
    function commit(next) {
      past.push(shapes);
      shapes = next;
      future = [];
      render();
    }

    function button(className, label, svg) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = className;
      item.title = label;
      item.setAttribute("aria-label", label);
      if (svg) item.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg}</svg>`;
      return item;
    }

    const toolButtons = TOOLS.map(([id, label, svg]) => {
      const item = button("draw-button", label, svg);
      item.classList.toggle("is-on", id === tool);
      item.addEventListener("click", () => {
        tool = id;
        hovered = null;
        toolButtons.forEach((other, index) => other.classList.toggle("is-on", TOOLS[index][0] === tool));
        canvas.classList.toggle("is-erasing", tool === "eraser");
        render();
      });
      bar.appendChild(item);
      return item;
    });

    const swatchRow = document.createElement("span");
    swatchRow.className = "draw-group";
    const swatches = COLORS.map((value) => {
      const item = button("draw-swatch", `Colour ${value}`, "");
      item.style.setProperty("--ink", value);
      item.classList.toggle("is-on", value === color);
      item.addEventListener("click", () => {
        color = value;
        swatches.forEach((other, index) => other.classList.toggle("is-on", COLORS[index] === color));
      });
      swatchRow.appendChild(item);
      return item;
    });
    bar.appendChild(swatchRow);

    const sizeRow = document.createElement("span");
    sizeRow.className = "draw-group";
    const sizeButtons = SIZES.map((value) => {
      const item = button("draw-size", `${value}px`, "");
      item.style.setProperty("--dot", `${Math.round(value / 1.6) + 4}px`);
      item.classList.toggle("is-on", value === size);
      item.addEventListener("click", () => {
        size = value;
        sizeButtons.forEach((other, index) => other.classList.toggle("is-on", SIZES[index] === size));
      });
      sizeRow.appendChild(item);
      return item;
    });
    bar.appendChild(sizeRow);

    const undo = button("draw-button", "Undo", '<path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>');
    const redo = button("draw-button", "Redo", '<path d="M21 7v6h-6"></path><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"></path>');
    const wipe = button("draw-button is-wipe", "Clear", '<path d="M3 6h18"></path><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>');
    const close = button("draw-button is-close", "Close", '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>');
    const tailRow = document.createElement("span");
    tailRow.className = "draw-group";
    tailRow.append(undo, redo, wipe, close);
    bar.appendChild(tailRow);

    function fit() {
      const at = hero.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(at.width * ratio);
      canvas.height = Math.round(at.height * ratio);
      canvas.style.width = `${Math.round(at.width)}px`;
      canvas.style.height = `${Math.round(at.height)}px`;
      paint.setTransform(ratio, 0, 0, ratio, 0, 0);
      render();
    }

    function stroke(shape) {
      paint.save();
      paint.lineCap = "round";
      paint.lineJoin = "round";
      paint.lineWidth = shape.size;
      paint.strokeStyle = shape.color;
      if (shape.tool === "marker") {
        paint.globalAlpha = 0.35;
        paint.lineWidth = shape.size * 2.4;
      }
      if (shape === hovered) paint.globalAlpha = 0.3;
      const [from, to] = [shape.points[0], shape.points[shape.points.length - 1]];
      paint.beginPath();
      if (shape.tool === "rect") {
        paint.rect(from.x, from.y, to.x - from.x, to.y - from.y);
      } else if (shape.tool === "ellipse") {
        paint.ellipse((from.x + to.x) / 2, (from.y + to.y) / 2, Math.abs(to.x - from.x) / 2, Math.abs(to.y - from.y) / 2, 0, 0, Math.PI * 2);
      } else if (shape.tool === "line" || shape.tool === "arrow") {
        paint.moveTo(from.x, from.y);
        paint.lineTo(to.x, to.y);
      } else {
        paint.moveTo(shape.points[0].x, shape.points[0].y);
        shape.points.forEach((point) => paint.lineTo(point.x, point.y));
      }
      paint.stroke();
      if (shape.tool === "arrow") {
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const head = Math.max(12, shape.size * 3);
        paint.beginPath();
        paint.moveTo(to.x, to.y);
        paint.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
        paint.moveTo(to.x, to.y);
        paint.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
        paint.stroke();
      }
      paint.restore();
    }

    function render() {
      paint.clearRect(0, 0, canvas.width, canvas.height);
      shapes.forEach(stroke);
      if (drawing) stroke(drawing);
    }

    // How far a point lies from a mark, so the eraser can take the whole mark
    // it is over rather than rubbing a hole in it.
    function distanceToSegment(point, a, b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
      return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
    }

    function distanceToShape(point, shape) {
      const from = shape.points[0];
      const to = shape.points[shape.points.length - 1];
      if (shape.tool === "rect") {
        const corners = [
          { x: from.x, y: from.y }, { x: to.x, y: from.y },
          { x: to.x, y: to.y }, { x: from.x, y: to.y },
        ];
        return Math.min(...corners.map((corner, index) => distanceToSegment(point, corner, corners[(index + 1) % 4])));
      }
      if (shape.tool === "ellipse") {
        const cx = (from.x + to.x) / 2;
        const cy = (from.y + to.y) / 2;
        const rx = Math.abs(to.x - from.x) / 2;
        const ry = Math.abs(to.y - from.y) / 2;
        let best = Infinity;
        for (let i = 0; i < 48; i += 1) {
          const angle = (i / 48) * Math.PI * 2;
          best = Math.min(best, Math.hypot(point.x - (cx + rx * Math.cos(angle)), point.y - (cy + ry * Math.sin(angle))));
        }
        return best;
      }
      let best = Infinity;
      for (let i = 1; i < shape.points.length; i += 1) {
        best = Math.min(best, distanceToSegment(point, shape.points[i - 1], shape.points[i]));
      }
      return shape.points.length > 1 ? best : Math.hypot(point.x - from.x, point.y - from.y);
    }

    function markAt(point) {
      for (let i = shapes.length - 1; i >= 0; i -= 1) {
        const shape = shapes[i];
        const reach = Math.max(10, shape.size / 2 + 6, size);
        if (distanceToShape(point, shape) <= reach) return shape;
      }
      return null;
    }

    const pointIn = (event) => {
      const at = canvas.getBoundingClientRect();
      return { x: event.clientX - at.left, y: event.clientY - at.top };
    };

    // With the eraser in hand, the mark under the pointer dims: that is the one
    // a click takes away, whole.
    canvas.addEventListener("pointermove", (event) => {
      if (tool !== "eraser" || drawing) return;
      const next = markAt(pointIn(event));
      if (next === hovered) return;
      hovered = next;
      render();
    });

    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const point = pointIn(event);
      // Capture keeps a stroke that wanders off the canvas attached to it. A
      // pointer that was never really down — the hero's own demo drawing
      // itself — has nothing to capture, and that is not a reason to drop the
      // stroke on the floor.
      try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* no live pointer */ }

      if (tool === "eraser") {
        let erased = shapes;
        const rub = (at) => {
          const mark = markAt(at);
          if (!mark) return;
          erased = erased.filter((shape) => shape !== mark);
          shapes = erased;
          hovered = null;
          render();
        };
        const before = shapes;
        shapes = shapes.slice();
        erased = shapes;
        rub(point);
        const move = (moveEvent) => rub(pointIn(moveEvent));
        const drop = () => {
          canvas.removeEventListener("pointermove", move);
          canvas.removeEventListener("pointerup", drop);
          canvas.removeEventListener("pointercancel", drop);
          const kept = shapes;
          shapes = before;
          if (kept.length !== before.length) commit(kept);
          else render();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", drop);
        canvas.addEventListener("pointercancel", drop);
        return;
      }

      drawing = { tool, color, size, points: [point, point] };
      render();

      const move = (moveEvent) => {
        const next = pointIn(moveEvent);
        if (drawing.tool === "pen" || drawing.tool === "marker") drawing.points.push(next);
        else drawing.points[1] = next;
        render();
      };
      const drop = () => {
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", drop);
        canvas.removeEventListener("pointercancel", drop);
        if (drawing) {
          const mark = drawing;
          drawing = null;
          commit(shapes.concat(mark));
        }
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", drop);
      canvas.addEventListener("pointercancel", drop);
    });

    undo.addEventListener("click", () => {
      if (!past.length) return;
      future.push(shapes);
      shapes = past.pop();
      render();
    });
    redo.addEventListener("click", () => {
      if (!future.length) return;
      past.push(shapes);
      shapes = future.pop();
      render();
    });
    wipe.addEventListener("click", () => {
      if (shapes.length) commit([]);
    });
    close.addEventListener("click", () => toggle.click());

    function start() {
      fit();
      canvas.hidden = false;
      bar.hidden = false;
      holdWidget("screen-draw");
    }
    function stop() {
      canvas.hidden = true;
      bar.hidden = true;
      shapes = [];
      past = [];
      future = [];
      drawing = null;
      hovered = null;
      render();
    }

    toggle.addEventListener("click", () => {
      if (box.classList.contains("is-on")) start();
      else stop();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !canvas.hidden) toggle.click();
    });
    window.addEventListener("resize", () => { if (!canvas.hidden) fit(); });
  }

  // Mirror. The app hangs a camera preview under the notch; flipping the mock's
  // switch asks the browser for the camera and hangs the same preview under the
  // menu bar. The picture is only ever shown — nothing is recorded and nothing
  // is sent anywhere — and the stream is handed back the moment it is switched
  // off, so the camera light goes out with it.
  function initMirror() {
    const hero = document.querySelector(".hero");
    const strip = document.querySelector(".desktop-strip");
    const card = document.querySelector('.hero-product .mock-card[data-widget="mirror"]');
    if (!hero || !strip || !card) return;
    const box = card.querySelector(".mock-toggle");
    const toggle = card.querySelector(".mock-switch");
    if (!box || !toggle) return;

    const frame = document.createElement("div");
    frame.className = "mirror-frame";
    frame.hidden = true;
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("aria-label", "Camera preview");
    // With no picture the frame is not empty: it is the camera, crossed out,
    // and pressing it is how the camera gets asked for.
    const blind = document.createElement("button");
    blind.type = "button";
    blind.className = "mirror-blind";
    blind.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 2 20 20"></path><path d="M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16"></path><path d="M9.5 4h5L17 7h3a2 2 0 0 1 2 2v7.5"></path><path d="M14.12 15.12A3 3 0 1 1 9.88 10.88"></path></svg>';
    const note = document.createElement("span");
    note.className = "mirror-note";
    blind.appendChild(note);
    const grip = document.createElement("i");
    grip.className = "mirror-grip";
    grip.setAttribute("aria-hidden", "true");

    // The mirror's own two controls: take the picture, and put the camera away.
    const bar = document.createElement("div");
    bar.className = "mirror-bar";
    const shoot = document.createElement("button");
    shoot.type = "button";
    shoot.className = "mirror-button";
    shoot.setAttribute("aria-label", "Take a photo");
    shoot.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>';
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mirror-button is-close";
    close.setAttribute("aria-label", "Turn the mirror off");
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
    bar.append(shoot, close);

    frame.append(video, blind, bar, grip);
    hero.appendChild(frame);

    let stream = null;
    let free = false;
    let asking = false;

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const ceiling = () => Math.round(strip.getBoundingClientRect().bottom - hero.getBoundingClientRect().top);

    // Docked, the mirror sits just under the menu bar — a hair below it, so its
    // rounded corners read.
    const place = () => {
      frame.style.top = `${ceiling()}px`;
    };

    // Dragged: it keeps its own place on the page, inside the hero and never
    // back up behind the bar.
    function put(x, y) {
      const box = hero.getBoundingClientRect();
      frame.style.left = `${Math.round(clamp(x, 8, Math.max(8, box.width - frame.offsetWidth - 8)))}px`;
      frame.style.top = `${Math.round(clamp(y, ceiling(), Math.max(ceiling(), box.height - frame.offsetHeight - 8)))}px`;
    }

    function unpin() {
      if (free) return;
      const box = hero.getBoundingClientRect();
      const at = frame.getBoundingClientRect();
      free = true;
      frame.classList.add("is-free");
      frame.style.left = `${Math.round(at.left - box.left)}px`;
      frame.style.top = `${Math.round(at.top - box.top)}px`;
    }

    // Back to the bar, keeping whatever width it was given.
    function dock() {
      free = false;
      frame.classList.remove("is-free");
      frame.style.left = "";
      place();
    }

    frame.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button, .mirror-grip")) return;
      const box = hero.getBoundingClientRect();
      const at = frame.getBoundingClientRect();
      const from = { x: event.clientX, y: event.clientY, left: at.left - box.left, top: at.top - box.top };
      let moving = false;
      event.preventDefault();
      try { frame.setPointerCapture(event.pointerId); } catch (error) { /* no live pointer */ }

      const move = (moveEvent) => {
        const dx = moveEvent.clientX - from.x;
        const dy = moveEvent.clientY - from.y;
        if (!moving) {
          if (Math.hypot(dx, dy) < 4) return;
          moving = true;
          unpin();
          frame.classList.add("is-dragging");
        }
        put(from.left + dx, from.top + dy);
      };
      const drop = () => {
        frame.classList.remove("is-dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", drop);
        window.removeEventListener("pointercancel", drop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", drop);
      window.addEventListener("pointercancel", drop);
    });

    // Two clicks send it back under the menu bar.
    frame.addEventListener("dblclick", dock);

    // The shutter: the frame on screen, mirrored as it is seen, goes to the
    // same corner the screen captures land in. It is drawn in the page and
    // never sent anywhere.
    shoot.addEventListener("click", () => {
      if (!stream || !video.videoWidth) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const paint = canvas.getContext("2d");
      paint.translate(canvas.width, 0);
      paint.scale(-1, 1);
      paint.drawImage(video, 0, 0);
      frame.classList.remove("is-flashing");
      void frame.offsetWidth;
      frame.classList.add("is-flashing");
      if (dropShotInCorner) dropShotInCorner(`${canvas.width} × ${canvas.height}`, canvas.toDataURL("image/png"));
    });

    close.addEventListener("click", () => toggle.click());

    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const box = hero.getBoundingClientRect();
      const startX = event.clientX;
      const startWidth = frame.offsetWidth;
      try { grip.setPointerCapture(event.pointerId); } catch (error) { /* no live pointer */ }
      frame.classList.add("is-sizing");

      const move = (moveEvent) => {
        const limit = Math.max(200, Math.min(680, box.width - 40));
        frame.style.width = `${Math.round(clamp(startWidth + (moveEvent.clientX - startX) * (free ? 1 : 2), 200, limit))}px`;
        if (free) put(parseFloat(frame.style.left) || 0, parseFloat(frame.style.top) || 0);
      };
      const drop = () => {
        frame.classList.remove("is-sizing");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", drop);
        window.removeEventListener("pointercancel", drop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", drop);
      window.addEventListener("pointercancel", drop);
    });

    function revert() {
      box.classList.remove("is-on");
      toggle.setAttribute("aria-pressed", "false");
      releaseWidget("mirror");
    }

    function stop() {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
      video.srcObject = null;
      frame.hidden = true;
      frame.classList.remove("is-live");
    }

    function blindWith(text) {
      note.textContent = text;
      frame.classList.remove("is-live");
    }

    async function allowed() {
      if (!navigator.permissions || !navigator.permissions.query) return false;
      try {
        return (await navigator.permissions.query({ name: "camera" })).state === "granted";
      } catch {
        return false;
      }
    }

    async function ask() {
      if (asking || stream) return;
      asking = true;
      blindWith("Starting the camera…");
      let opened = null;
      try {
        opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      } catch {
        asking = false;
        // Refused, the frame stays where it is rather than vanishing: the
        // answer can change, and when it does there is something here to fill.
        blindWith("Camera access is off. Allow it, then press here.");
        return;
      }
      asking = false;
      // Switched off again while the browser was still asking.
      if (!box.classList.contains("is-on")) {
        opened.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = opened;
      video.srcObject = stream;
      frame.classList.add("is-live");
    }

    function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        revert();
        showToast("The camera needs a secure connection.");
        return;
      }
      place();
      blindWith("Camera off. Press to turn it on.");
      frame.hidden = false;
      // A camera prompt belongs to whoever asked for it. A real press can raise
      // one; the hero's own demonstration flipping this switch cannot, so it
      // leaves the frame sitting there blind until somebody wants the picture.
      // Where the camera was allowed already there is nothing to ask.
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        allowed().then((yes) => { if (yes && box.classList.contains("is-on")) ask(); });
        return;
      }
      ask();
    }

    blind.addEventListener("click", ask);

    // Given the camera later — from the address bar, say — it fills itself in
    // rather than waiting to be switched off and on again.
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: "camera" }).then((status) => {
        status.addEventListener("change", () => {
          if (status.state === "granted" && box.classList.contains("is-on")) ask();
        });
      }).catch(() => {});
    }

    toggle.addEventListener("click", () => {
      if (box.classList.contains("is-on")) start();
      else stop();
    });
    window.addEventListener("resize", () => {
      if (frame.hidden) return;
      if (free) put(parseFloat(frame.style.left) || 0, parseFloat(frame.style.top) || 0);
      else place();
    });
  }

  // The Convert card. A file can be dropped on it or chosen from disk, and
  // only its name is ever read — nothing is opened, and nothing leaves the
  // browser. From that name the card knows the group it belongs to, offers the
  // formats the app offers for it, blocks the one it already is, and plays the
  // conversion out.
  function initConvert() {
    const card = document.querySelector('.hero-product .mock-card[data-widget="convert"]');
    if (!card) return;
    const drop = card.querySelector("[data-convert-drop]");
    const name = card.querySelector("[data-convert-name]");
    const clear = card.querySelector("[data-convert-clear]");
    const chips = card.querySelector("[data-convert-chips]");
    const run = card.querySelector("[data-convert-run]");
    if (!drop || !name || !clear || !chips || !run) return;

    const GROUPS = [
      { group: "Image", inputs: ["png", "jpg", "webp", "gif", "tiff", "bmp", "heic", "avif", "psd", "cr2", "nef", "arw", "dng"], items: ["png", "jpg", "gif", "tiff", "heic", "bmp", "ico", "pdf"] },
      { group: "Document", inputs: ["pdf", "txt", "md", "html", "rtf", "doc", "docx", "odt"], items: ["pdf", "docx", "txt", "md", "html", "rtf", "odt"] },
      { group: "Audio", inputs: ["mp3", "m4a", "wav", "aiff", "flac", "caf", "ogg", "opus", "aac"], items: ["m4a", "wav", "aiff", "flac", "caf"] },
      { group: "Video", inputs: ["mov", "mp4", "m4v"], items: ["mp4", "mov", "m4v", "m4a"] },
    ];
    const ALIASES = { jpeg: "jpg", tif: "tiff", heif: "heic", htm: "html", markdown: "md", aif: "aiff" };
    const extOf = (file) => {
      const dot = file.lastIndexOf(".");
      const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
      return ALIASES[ext] || ext;
    };
    const groupFor = (ext) => GROUPS.find((g) => g.inputs.includes(ext));

    const picker = document.createElement("input");
    picker.type = "file";
    picker.hidden = true;
    card.appendChild(picker);

    let file = name.textContent.trim();
    let target = "jpg";

    function render() {
      const ext = file ? extOf(file) : "";
      const group = groupFor(ext);
      name.textContent = file || "Drop or click to browse";
      drop.classList.toggle("is-empty", !file);
      clear.hidden = !file;
      chips.hidden = !file;
      run.disabled = !file;
      if (!group) {
        chips.replaceChildren();
        run.textContent = "Convert";
        return;
      }
      if (target === ext || !group.items.includes(target)) target = group.items.find((f) => f !== ext) || ext;
      chips.replaceChildren(...group.items.map((format) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.textContent = `.${format}`;
        chip.classList.toggle("is-selected", format === target);
        chip.classList.toggle("is-blocked", format === ext);
        chip.disabled = format === ext;
        chip.addEventListener("click", () => {
          target = format;
          holdWidget("convert", 20);
          render();
        });
        return chip;
      }));
      run.textContent = `→ .${target}`;
    }

    function accept(fileName) {
      const group = groupFor(extOf(fileName));
      if (!group) {
        showToast(`Unsupported format: ${fileName}`);
        return;
      }
      file = fileName;
      holdWidget("convert", 20);
      render();
    }

    drop.addEventListener("click", () => {
      if (file) return;
      picker.click();
    });
    drop.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (!file) picker.click();
    });
    picker.addEventListener("change", () => {
      const chosen = picker.files && picker.files[0];
      if (chosen) accept(chosen.name);
      picker.value = "";
    });

    ["dragenter", "dragover"].forEach((type) => {
      drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add("is-dropping");
      });
    });
    ["dragleave", "dragend"].forEach((type) => {
      drop.addEventListener(type, () => drop.classList.remove("is-dropping"));
    });
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("is-dropping");
      const dropped = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (dropped) accept(dropped.name);
    });

    clear.addEventListener("click", (event) => {
      event.stopPropagation();
      file = "";
      holdWidget("convert", 20);
      render();
    });

    let working = null;
    run.addEventListener("click", () => {
      if (!file) return;
      const out = `${file.replace(/\.[^.]+$/, "")}.${target}`;
      window.clearTimeout(working);
      run.disabled = true;
      run.textContent = "Converting…";
      holdWidget("convert", 20);
      working = window.setTimeout(() => {
        run.disabled = false;
        render();
        showToast(`Converted: ${out}`);
      }, 900);
    });

    render();
  }

  // Clean Mode. The app blocks the keyboard or the trackpad so a Mac can be
  // wiped down; the page cannot take a visitor's input away and should not try,
  // so it locks its own screen instead: the hero goes under a veil, a trackpad
  // lock really does swallow clicks on the panel until Esc, and the card wears
  // the same locked state the app shows.
  function initCleanMode() {
    const hero = document.querySelector(".hero");
    const panel = document.getElementById("hero-panel");
    const card = document.querySelector('.hero-product .mock-card[data-widget="clean-mode"]');
    if (!hero || !panel || !card) return;

    const locks = card.querySelector("[data-clean-locks]");
    const state = card.querySelector("[data-clean-state]");
    const title = card.querySelector("[data-clean-title]");
    const hint = card.querySelector("[data-clean-hint]");
    const unlock = card.querySelector("[data-clean-unlock]");
    if (!locks || !state || !title || !hint || !unlock) return;

    const veil = document.createElement("div");
    veil.className = "clean-veil";
    veil.innerHTML = '<p class="clean-veil-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg><span data-clean-veil-text></span></p>';
    const veilText = veil.querySelector("[data-clean-veil-text]");
    hero.appendChild(veil);

    let locked = null;
    // A phone has no Esc key, so on a touch screen the veil itself unlocks.
    const byTouch = () => window.matchMedia("(hover: none)").matches;

    function stop() {
      if (!locked) return;
      locked = null;
      veil.classList.remove("is-on", "is-blocking");
      panel.classList.remove("is-input-locked");
      state.hidden = true;
      locks.hidden = false;
      releaseWidget("clean-mode");
      showToast("Clean Mode off.");
    }

    function start(kind) {
      locked = kind;
      const keyboard = kind === "keyboard";
      title.textContent = keyboard ? "Keyboard Clean Mode" : "Trackpad Clean Mode";
      hint.hidden = keyboard;
      unlock.hidden = !keyboard;
      locks.hidden = true;
      state.hidden = false;
      const release = byTouch() ? "tap to unlock" : "press Esc to unlock";
      veilText.textContent = keyboard ? "Keyboard locked — wipe away" : `Trackpad locked — ${release}`;
      veil.classList.add("is-on");
      // Only the trackpad lock takes the pointer; a keyboard lock leaves the
      // mouse working, as it does in the app.
      veil.classList.toggle("is-blocking", !keyboard);
      panel.classList.toggle("is-input-locked", !keyboard);
      holdWidget("clean-mode");
      showToast(keyboard ? "Keyboard locked." : `Trackpad locked. ${byTouch() ? "Tap the screen" : "Press Esc"} to unlock.`);
    }

    card.querySelectorAll("[data-clean]").forEach((button) => {
      button.addEventListener("click", () => start(button.dataset.clean));
    });
    unlock.addEventListener("click", stop);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") stop();
    });
    // A click at the veil is the locked trackpad being tried; say so — or, with
    // no keyboard to press Esc on, let it go.
    veil.addEventListener("click", () => {
      if (locked !== "trackpad") return;
      if (byTouch()) stop();
      else showToast("Trackpad is locked. Press Esc to unlock.");
    });
  }

  // The menu bar's own menus. File, Edit and View each drop a menu holding the
  // one line this app was built for.
  function initStripMenus() {
    const strip = document.querySelector(".desktop-strip");
    if (!strip) return;

    // The hearts ride over the page, not inside the hero: rising out of the
    // menu bar they would otherwise slide in behind the site header.
    function love(from) {
      for (let i = 0; i < 7; i += 1) {
        const heart = document.createElement("span");
        heart.className = "love-heart";
        heart.textContent = "❤️";
        heart.style.left = `${Math.round(from.left + Math.random() * 90 - 20)}px`;
        heart.style.top = `${Math.round(from.bottom)}px`;
        heart.style.setProperty("--drift", `${Math.round(Math.random() * 70 - 35)}px`);
        heart.style.animationDelay = `${i * 90}ms`;
        heart.addEventListener("animationend", () => heart.remove(), { once: true });
        document.body.appendChild(heart);
      }
      showToast("We love you back. ❤️");
    }

    const words = Array.from(strip.querySelectorAll("[data-menu]"));
    let open = null;

    function close() {
      if (!open) return;
      open.menu.classList.remove("is-open");
      open.word.setAttribute("aria-expanded", "false");
      open = null;
    }

    words.forEach((word) => {
      const menu = document.createElement("div");
      menu.className = "mock-add-menu strip-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", word.textContent);

      const egg = document.createElement("button");
      egg.type = "button";
      egg.setAttribute("role", "menuitem");
      egg.textContent = "I love Mac Kit";
      egg.addEventListener("click", () => {
        const at = word.getBoundingClientRect();
        close();
        love(at);
      });
      menu.appendChild(egg);
      strip.appendChild(menu);

      const show = () => {
        close();
        const box = strip.getBoundingClientRect();
        const at = word.getBoundingClientRect();
        menu.style.left = `${Math.round(at.left - box.left)}px`;
        menu.classList.add("is-open");
        word.setAttribute("aria-expanded", "true");
        open = { word, menu };
      };

      word.addEventListener("click", (event) => {
        event.stopPropagation();
        if (open && open.word === word) close();
        else show();
      });
      // With one menu down, running along the bar opens the next, as macOS does.
      word.addEventListener("mouseenter", () => { if (open && open.word !== word) show(); });
    });

    document.addEventListener("click", (event) => {
      if (open && !open.menu.contains(event.target)) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    window.addEventListener("resize", close);
  }

  // The Screenshot card. The page cannot read the visitor's screen, and should
  // not ask to, so the capture is played out on the hero instead: the shutter
  // flashes, a thumbnail slides into the corner the way macOS parks one, and
  // Area and Window first ask what to take. Record keeps a red badge and a
  // running clock in the menu bar, as the app does while it captures video.
  function initScreenshot() {
    const hero = document.querySelector(".hero");
    const panel = document.getElementById("hero-panel");
    const card = document.querySelector('.hero-product .mock-card[data-widget="screenshot"]');
    const badge = document.getElementById("strip-record");
    if (!hero || !panel || !card) return;

    const layer = document.createElement("div");
    layer.className = "shot-layer";
    hero.appendChild(layer);

    const pad = (n) => String(n).padStart(2, "0");
    const stamp = (kind = "Screen Shot") => {
      const now = new Date();
      return `${kind} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.png`;
    };

    function flash() {
      const sheet = document.createElement("div");
      sheet.className = "shot-flash";
      layer.appendChild(sheet);
      sheet.addEventListener("animationend", () => sheet.remove(), { once: true });
    }

    // macOS parks the shot in the corner for a moment, and stacks the next ones
    // above it; three is as deep as the corner goes here. Resting on one holds
    // it there, so it can be read and saved instead of slipping away.
    const SHOTS_IN_CORNER = 3;
    const tray = document.createElement("div");
    tray.className = "shot-tray";
    (document.getElementById("toast-region") || layer).appendChild(tray);

    function dropShot(shot) {
      if (shot.classList.contains("is-leaving")) return;
      shot.classList.add("is-leaving");
      shot.addEventListener("animationend", () => shot.remove(), { once: true });
    }

    // `picture` is a still to show in place of the mock desktop — the mirror
    // sends the frame it just took.
    function thumbnail(size, picture) {
      const file = picture ? stamp("Mirror Shot") : stamp();
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "shot-thumb";
      thumb.setAttribute("aria-label", `Save ${file}`);
      thumb.innerHTML = picture
        ? '<span class="shot-thumb-screen"><img alt="" src=""><em class="shot-thumb-save">Save</em></span>'
        : '<span class="shot-thumb-screen"><i class="shot-thumb-strip"></i><i class="shot-thumb-panel"></i><em class="shot-thumb-save">Save</em></span>';
      if (picture) thumb.querySelector("img").src = picture;
      const label = document.createElement("span");
      label.className = "shot-thumb-size";
      label.textContent = size;
      thumb.appendChild(label);

      let leaving = null;
      const drop = () => dropShot(thumb);
      const park = (ms) => {
        window.clearTimeout(leaving);
        leaving = window.setTimeout(() => { if (thumb.isConnected) drop(); }, ms);
      };

      thumb.addEventListener("mouseenter", () => window.clearTimeout(leaving));
      thumb.addEventListener("mouseleave", () => park(2000));
      thumb.addEventListener("click", () => {
        showToast(`Saved: ~/Desktop/${file}`);
        drop();
      });

      const standing = Array.from(tray.children).filter((t) => !t.classList.contains("is-leaving"));
      standing.slice(0, Math.max(0, standing.length + 1 - SHOTS_IN_CORNER)).forEach(dropShot);
      tray.appendChild(thumb);
      park(5200);
    }

    // No message for a capture: the thumbnail in the corner already says it,
    // with the size on it.
    function capture(size) {
      flash();
      thumbnail(size);
      holdWidget("screenshot", 20);
    }

    const screenSize = () => `${Math.round(window.innerWidth)} × ${Math.round(window.innerHeight)}`;

    // Area: the hero dims and takes a drag, showing the size as it goes.
    function pickArea() {
      const picker = document.createElement("div");
      picker.className = "shot-picker";
      const hint = document.createElement("p");
      hint.className = "shot-hint";
      hint.textContent = "Drag to select an area — Esc to cancel";
      picker.appendChild(hint);
      const marquee = document.createElement("div");
      marquee.className = "shot-marquee";
      marquee.hidden = true;
      const size = document.createElement("span");
      size.className = "shot-marquee-size";
      marquee.appendChild(size);
      picker.appendChild(marquee);
      layer.appendChild(picker);
      holdWidget("screenshot");

      const close = () => {
        picker.remove();
        document.removeEventListener("keydown", onKey);
        holdWidget("screenshot", 20);
      };
      const onKey = (event) => { if (event.key === "Escape") close(); };
      document.addEventListener("keydown", onKey);

      picker.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        const box = picker.getBoundingClientRect();
        const from = { x: event.clientX - box.left, y: event.clientY - box.top };
        picker.setPointerCapture(event.pointerId);
        hint.remove();
        marquee.hidden = false;
        let width = 0;
        let height = 0;

        const move = (moveEvent) => {
          const x = moveEvent.clientX - box.left;
          const y = moveEvent.clientY - box.top;
          width = Math.abs(x - from.x);
          height = Math.abs(y - from.y);
          marquee.style.left = `${Math.min(x, from.x)}px`;
          marquee.style.top = `${Math.min(y, from.y)}px`;
          marquee.style.width = `${width}px`;
          marquee.style.height = `${height}px`;
          size.textContent = `${Math.round(width)} × ${Math.round(height)}`;
        };
        const drop = () => {
          picker.removeEventListener("pointermove", move);
          picker.removeEventListener("pointerup", drop);
          close();
          if (width > 8 && height > 8) capture(`${Math.round(width)} × ${Math.round(height)}`);
        };
        picker.addEventListener("pointermove", move);
        picker.addEventListener("pointerup", drop);
      });
    }

    // Window: the panel lights up as the window under the pointer.
    function pickWindow() {
      panel.classList.add("is-shot-target");
      holdWidget("screenshot");
      const close = () => {
        panel.classList.remove("is-shot-target");
        panel.removeEventListener("click", take, true);
        document.removeEventListener("keydown", onKey);
        window.removeEventListener("click", onOutside, true);
        holdWidget("screenshot", 20);
      };
      const take = (event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
        const at = panel.getBoundingClientRect();
        capture(`${Math.round(at.width)} × ${Math.round(at.height)}`);
      };
      const onKey = (event) => { if (event.key === "Escape") close(); };
      const onOutside = (event) => { if (!panel.contains(event.target)) close(); };
      panel.addEventListener("click", take, true);
      document.addEventListener("keydown", onKey);
      window.setTimeout(() => window.addEventListener("click", onOutside, true), 0);
    }

    // Record: the menu bar carries the red badge and the elapsed time.
    let recordTimer = null;
    let recordedFor = 0;
    const recordButton = card.querySelector("[data-shot='record']");
    const clock = (seconds) => `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;

    function stopRecording() {
      window.clearInterval(recordTimer);
      recordTimer = null;
      if (badge) badge.hidden = true;
      if (recordButton) recordButton.textContent = "Record";
      card.classList.remove("is-recording");
      showToast(`Recording saved — ${clock(recordedFor)}`);
      holdWidget("screenshot", 20);
    }

    function startRecording() {
      recordedFor = 0;
      if (badge) {
        badge.lastChild.textContent = clock(0);
        badge.hidden = false;
      }
      if (recordButton) recordButton.textContent = "Stop";
      card.classList.add("is-recording");
      holdWidget("screenshot");
      showToast("Recording the screen.");
      recordTimer = window.setInterval(() => {
        recordedFor += 1;
        if (badge) badge.lastChild.textContent = clock(recordedFor);
      }, 1000);
    }

    dropShotInCorner = thumbnail;

    card.querySelectorAll("[data-shot]").forEach((button) => {
      button.addEventListener("click", () => {
        const kind = button.dataset.shot;
        if (kind === "full") capture(screenSize());
        else if (kind === "area") pickArea();
        else if (kind === "window") pickWindow();
        else if (recordTimer) stopRecording();
        else startRecording();
      });
    });
  }

  // The Color Picker card. Pick Color opens the browser's eyedropper where
  // there is one — the same tool the app reaches for — so a visitor really
  // picks a colour off their screen; browsers without it step through a set of
  // samples instead. Each format button copies the colour in that notation,
  // the way the app's do.
  function initColorPicker() {
    const swatch = document.getElementById("mock-swatch");
    const value = document.getElementById("mock-color-value");
    const pick = document.getElementById("mock-pick-color");
    const pills = Array.from(document.querySelectorAll("[data-color-format]"));
    if (!swatch || !value || !pick) return;

    const SAMPLES = ["#F4F2ED", "#F5941D", "#2E9E7B", "#4C6EF5", "#E4572E", "#1D1D1B"];
    let sample = 0;
    let format = "hex";
    let color = value.textContent.trim() || SAMPLES[0];

    const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

    function asFormat(format) {
      const [r, g, b] = channels(color);
      if (format === "rgb") return `rgb(${r}, ${g}, ${b})`;
      if (format !== "hsl") return color;
      const [rf, gf, bf] = [r, g, b].map((c) => c / 255);
      const max = Math.max(rf, gf, bf);
      const min = Math.min(rf, gf, bf);
      const d = max - min;
      const l = (max + min) / 2;
      let h = 0;
      if (d) {
        h = max === rf ? ((gf - bf) / d) % 6 : max === gf ? (bf - rf) / d + 2 : (rf - gf) / d + 4;
        h = Math.round(h * 60);
        if (h < 0) h += 360;
      }
      const sat = d ? Math.round((d / (1 - Math.abs(2 * l - 1))) * 100) : 0;
      return `hsl(${h}, ${sat}%, ${Math.round(l * 100)}%)`;
    }

    // The card reads the colour in whichever notation was picked last, so the
    // code above the buttons is the one the visitor asked for.
    function render() {
      const text = asFormat(format);
      swatch.style.background = color;
      value.textContent = text;
      value.classList.toggle("is-long", text.length > 8);
      pills.forEach((pill) => pill.classList.toggle("is-selected", pill.dataset.colorFormat === format));
    }

    function show(next) {
      color = next.toUpperCase();
      render();
    }

    pills.forEach((pill) => {
      pill.addEventListener("click", async () => {
        format = pill.dataset.colorFormat;
        const text = asFormat(format);
        holdWidget("color-picker", 20);
        render();
        pills.forEach((other) => other.classList.remove("is-copied"));
        pill.classList.add("is-copied");
        window.setTimeout(() => pill.classList.remove("is-copied"), 900);
        try {
          await navigator.clipboard.writeText(text);
          showToast(`Copied: ${text}`);
        } catch {
          showToast(`Copy preview: ${text}`);
        }
      });
    });

    pick.addEventListener("click", async () => {
      holdWidget("color-picker", 20);
      if (window.EyeDropper) {
        try {
          const result = await new window.EyeDropper().open();
          show(result.sRGBHex);
          showToast(`Picked: ${color}`);
        } catch {
          // The eyedropper was dismissed; the card keeps the colour it had.
        }
        return;
      }
      sample = (sample + 1) % SAMPLES.length;
      show(SAMPLES[sample]);
      showToast(`Picked: ${color}`);
    });

    show(color);
  }

  // Sticky Notes: New slides a note out of the panel and onto the page, the
  // way the app opens a note window on your desktop. Notes can be typed in,
  // dragged around the hero and thrown away; List gathers them back into a
  // tidy cascade beside the panel. The palette and the ink are the app's own.
  function initStickyNotes() {
    const hero = document.querySelector(".hero");
    const panel = document.getElementById("hero-panel");
    const newButton = document.querySelector("[data-sticky='new']");
    const listButton = document.querySelector("[data-sticky='list']");
    if (!hero || !panel || !newButton || !listButton) return;

    const COLORS = ["#fbe08a", "#f9bfc8", "#dcc7f7", "#bcd7f7", "#b0e5cb"];
    const LINES = 3;

    // The app writes on a pastel card in a deep shade of the card's own hue,
    // so the print reads as part of the paper rather than grey laid over it.
    const inkFor = (hex, alpha = 1) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const max = Math.max(r, g, b);
      const d = max - Math.min(r, g, b);
      let hue = 0;
      if (d) {
        hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        hue = Math.round(hue * 60);
        if (hue < 0) hue += 360;
      }
      return `hsla(${hue}, 62%, 22%, ${alpha})`;
    };

    const layer = document.createElement("div");
    layer.className = "sticky-layer";
    hero.appendChild(layer);
    const notes = [];
    let made = 0;

    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

    // Where a note sits is written as left/top, so it is measured without the
    // tilt: a rotated element's bounding box is bigger than the note itself,
    // and mixing the two makes a note jump the moment it is picked up. The
    // whole note is kept on the hero, never half-clipped at an edge.
    function put(note, x, y) {
      const box = layer.getBoundingClientRect();
      const strip = document.querySelector(".desktop-strip");
      const ceiling = strip ? Math.max(8, strip.getBoundingClientRect().bottom - box.top + 10) : 8;
      note.style.left = `${Math.round(clamp(x, 8, Math.max(8, box.width - note.offsetWidth - 8)))}px`;
      note.style.top = `${Math.round(clamp(y, ceiling, Math.max(ceiling, box.height - note.offsetHeight - 8)))}px`;
    }

    const leftOf = (note) => parseFloat(note.style.left) || 0;
    const topOf = (note) => parseFloat(note.style.top) || 0;

    function front(note) {
      notes.forEach((other) => other.classList.toggle("is-front", other === note));
    }

    // Notes land in the open space under the panel and step down from there,
    // clear of the headline on the left.
    function slotFor(index) {
      const box = layer.getBoundingClientRect();
      const at = panel.getBoundingClientRect();
      const step = index % 5;
      return {
        x: at.left - box.left - 232 + step * 30,
        y: at.bottom - box.top + 22 + step * 26,
      };
    }

    // A note is dragged from anywhere on it, including its text: a press that
    // travels is a drag, a press that stays put is a click into the field.
    // The pointer is captured from the first press, so a fast drag that leaves
    // the note behind still moves it, and the note follows the pointer by the
    // distance travelled rather than by where it was grabbed.
    function drag(note) {
      note.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button")) return;
        const from = { x: event.clientX, y: event.clientY, left: leftOf(note), top: topOf(note) };
        const field = event.target.closest("input");
        let moving = false;
        front(note);
        // The note takes the press itself. Left to the browser, a press that
        // starts on a line becomes a text selection: it fights the move and
        // drops the pointer capture halfway through a quick drag. The caret is
        // put back below, on a press that turned out not to be a drag.
        event.preventDefault();
        note.setPointerCapture(event.pointerId);

        const move = (moveEvent) => {
          const dx = moveEvent.clientX - from.x;
          const dy = moveEvent.clientY - from.y;
          if (!moving) {
            if (Math.hypot(dx, dy) < 4) return;
            moving = true;
            note.classList.remove("is-tidy");
            note.classList.add("is-dragging");
          }
          put(note, from.left + dx, from.top + dy);
        };
        const drop = (upEvent) => {
          // A press that never travelled is a click into the line it landed on.
          if (!moving && field && upEvent.type === "pointerup") {
            field.focus();
            const end = field.value.length;
            field.setSelectionRange(end, end);
          }
          note.classList.remove("is-dragging");
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", drop);
          window.removeEventListener("pointercancel", drop);
        };
        // Tracked on the window, not on the note: a quick drag outruns the
        // note it is moving, and events aimed at whatever is under the cursor
        // would leave the note stranded mid-flight.
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", drop);
        window.addEventListener("pointercancel", drop);
      });
    }

    function remove(note) {
      note.classList.add("is-leaving");
      note.addEventListener("animationend", () => {
        note.remove();
        const at = notes.indexOf(note);
        if (at > -1) notes.splice(at, 1);
        if (!notes.length) releaseWidget("sticky-notes");
      }, { once: true });
    }

    function spawn() {
      const color = COLORS[made % COLORS.length];
      const note = document.createElement("div");
      note.className = "sticky-note is-front";
      note.style.background = color;
      note.style.color = inkFor(color);
      note.style.setProperty("--rule", inkFor(color, 0.3));
      // A stack of paper never lands square.
      note.style.setProperty("--tilt", `${(made % 3) - 1}deg`);

      const head = document.createElement("div");
      head.className = "sticky-note-head";
      const title = document.createElement("input");
      title.className = "sticky-note-title";
      title.type = "text";
      title.placeholder = "Note title";
      title.setAttribute("aria-label", "Note title");
      const close = document.createElement("button");
      close.className = "sticky-note-close";
      close.type = "button";
      close.setAttribute("aria-label", "Close note");
      close.innerHTML = "&times;";
      close.addEventListener("click", () => remove(note));
      head.append(title, close);

      const lines = document.createElement("div");
      lines.className = "sticky-note-lines";
      const rows = [];
      for (let i = 0; i < LINES; i += 1) {
        const row = document.createElement("label");
        row.className = "sticky-note-row";
        const mark = document.createElement("i");
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = `${i + 1}.`;
        const input = document.createElement("input");
        input.type = "text";
        input.setAttribute("aria-label", `Line ${i + 1}`);
        input.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          (rows[i + 1] || rows[0]).focus();
        });
        rows.push(input);
        row.append(mark, input);
        lines.appendChild(row);
      }

      note.append(head, lines);
      layer.appendChild(note);
      front(note);
      const slot = slotFor(made);
      put(note, slot.x, slot.y);

      // The note starts where the panel is and slides out to its slot.
      const from = panel.getBoundingClientRect();
      const at = note.getBoundingClientRect();
      note.style.setProperty("--from-x", `${Math.round(from.left + from.width / 2 - at.left - at.width / 2)}px`);
      note.style.setProperty("--from-y", `${Math.round(from.top + 120 - at.top)}px`);

      drag(note);
      notes.push(note);
      made += 1;
      title.focus({ preventScroll: true });
      return note;
    }

    newButton.addEventListener("click", () => {
      spawn();
      holdWidget("sticky-notes");
      showToast("Sticky note on screen.");
    });

    listButton.addEventListener("click", () => {
      if (!notes.length) {
        showToast("No sticky notes yet.");
        return;
      }
      notes.forEach((note, index) => {
        note.classList.add("is-tidy");
        const slot = slotFor(index);
        put(note, slot.x, slot.y);
        window.setTimeout(() => note.classList.remove("is-tidy"), 420);
      });
      showToast(`${notes.length} note${notes.length > 1 ? "s" : ""} on screen.`);
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        notes.forEach((note) => put(note, leftOf(note), topOf(note)));
      }, 150);
    });
  }

  // The New File card, typed like the app's: the name field is real, Create
  // waits for a name, and — as in the app, which opens a folder picker before
  // it writes anything — Create asks where the file should go. Choosing a
  // folder flashes the button and names the file that would land there;
  // dismissing the list creates nothing. The type comes from the list beside it.
  function initNewFileCard() {
    const surface = document.querySelector(".hero-product .hero-window");
    const name = document.getElementById("mock-file-name");
    const create = document.getElementById("mock-file-create");
    const type = document.querySelector("[data-file-type]");
    if (!surface || !name || !create || !type) return;

    const PLACES = [
      ["Desktop", '<rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8"></path><path d="M12 17v4"></path>', "~/Desktop"],
      ["Documents", '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"></path>', "~/Documents"],
      ["Downloads", '<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M4 21h16"></path>', "~/Downloads"],
      ["Home", '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M9 22V12h6v10"></path>', "~"],
    ];

    const menu = document.createElement("div");
    menu.className = "mock-add-menu mock-place-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Choose a folder");
    const title = document.createElement("p");
    title.className = "mock-menu-title";
    title.textContent = "Save to";
    menu.appendChild(title);

    let done = null;
    const fileName = () => {
      const typed = name.value.trim();
      if (!typed) return "";
      const ext = type.dataset.value || "txt";
      return typed.endsWith(`.${ext}`) ? typed : `${typed}.${ext}`;
    };

    const close = () => {
      menu.classList.remove("is-open");
      create.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      const box = surface.getBoundingClientRect();
      const at = create.getBoundingClientRect();
      menu.style.right = `${Math.round(box.right - at.right)}px`;
      menu.style.top = `${Math.round(at.bottom - box.top) + 6}px`;
      menu.classList.add("is-open");
      create.setAttribute("aria-expanded", "true");
    };

    const save = (path) => {
      const file = fileName();
      holdWidget("new-file", 20);
      close();
      if (!file) return;
      window.clearTimeout(done);
      create.classList.add("is-done");
      create.textContent = "Created";
      done = window.setTimeout(() => {
        create.classList.remove("is-done");
        create.textContent = "Create";
      }, 1400);
      showToast(`Created: ${path === "~" ? "~" : path}/${file}`);
    };

    PLACES.forEach(([label, icon, path]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      glyph.setAttribute("viewBox", "0 0 24 24");
      glyph.setAttribute("fill", "none");
      glyph.setAttribute("stroke", "currentColor");
      glyph.setAttribute("stroke-width", "2");
      glyph.setAttribute("stroke-linecap", "round");
      glyph.setAttribute("stroke-linejoin", "round");
      glyph.setAttribute("aria-hidden", "true");
      glyph.innerHTML = icon;
      const text = document.createElement("span");
      text.textContent = label;
      const where = document.createElement("em");
      where.textContent = path;
      item.append(glyph, text, where);
      item.addEventListener("click", () => save(path));
      menu.appendChild(item);
    });
    surface.appendChild(menu);

    const sync = () => { create.disabled = !name.value.trim(); };
    const ask = () => {
      holdWidget("new-file", 20);
      if (!fileName()) return;
      if (menu.classList.contains("is-open")) close();
      else open();
    };

    name.addEventListener("input", () => {
      sync();
      holdWidget("new-file", 20);
      if (!name.value.trim()) close();
    });
    name.addEventListener("focus", () => holdWidget("new-file", 20));
    name.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      ask();
    });
    create.addEventListener("click", (event) => {
      event.stopPropagation();
      ask();
    });
    document.addEventListener("click", (event) => {
      if (!menu.contains(event.target) && event.target !== create) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    document.addEventListener("mock-layout-change", close);
    window.addEventListener("resize", close);
    create.setAttribute("aria-haspopup", "menu");
    create.setAttribute("aria-expanded", "false");
    sync();
  }

  // The status item in the mock menu bar. The panel still opens on its own;
  // the bolt puts it away and brings the very same panel back, so nothing in
  // it is reset in between. The panel keeps its space while closed, so the
  // trial card below it and the rest of the hero stay where they are.
  function initPanelToggle() {
    const bolt = document.getElementById("panel-toggle");
    const panel = document.getElementById("hero-panel");
    if (!bolt || !panel) return;

    bolt.addEventListener("click", () => {
      const open = !panel.classList.toggle("is-closed");
      bolt.setAttribute("aria-expanded", String(open));
    });
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
    const title = document.createElement("p");
    title.className = "mock-menu-title";
    title.textContent = "File type";
    menu.appendChild(title);

    const close = () => {
      menu.classList.remove("is-open");
      field.classList.remove("is-active");
      field.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      holdWidget("new-file", 20);
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
        document.getElementById("pay-once")?.scrollIntoView({ behavior: "smooth" });
      });
    });
  }

  // The markup ships the current build so the buttons work without JS; this
  // asks GitHub for the newest release and rewrites every download link, so a
  // new release does not leave the page pointing at an old .dmg.
  function initLatestDownload() {
    const links = document.querySelectorAll("[data-latest-download]");
    if (!links.length) return;

    fetch("https://api.github.com/repos/mahsumozer/mac-kit-releases/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((release) => {
        const asset = (release?.assets || []).find((item) => item.name?.endsWith("arm64.dmg"));
        if (!asset?.browser_download_url) return;

        links.forEach((link) => link.setAttribute("href", asset.browser_download_url));
      })
      .catch(() => {});
  }

  // The compare panel mirrors the hero's rotating widgets. The pools are split
  // by size — the left column only holds tall cards, the right only short ones
  // — so the panel keeps its one-big-two-small shape no matter what is up.
  // Every five seconds two of the three on screen are swapped out at random.
  function initCompareRotation() {
    const mock = document.querySelector("[data-compare-rotate]");
    const menu = document.querySelector(".compare-menubar-kit");
    if (!mock || !menu) return;

    const columns = Array.from(mock.querySelectorAll(":scope > .mock-col"))
      .map((col) => Array.from(col.querySelectorAll(".mock-card[data-widget]")))
      .filter((cards) => cards.length > 1 && cards.some((card) => card.hidden));
    if (!columns.length) return;

    const INTERVAL = 5000;
    const LEAVE_MS = 200;
    const ENTER_MS = 400;
    const SWAPS = 2;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pick = (list) => list[Math.floor(Math.random() * list.length)];

    // Card heights differ a lot (six clipboard rows vs one toggle), so the
    // panel is held at the height of the layout it opens with instead of
    // resizing under the cursor on every swap.
    function lockHeight() {
      mock.style.minHeight = "";
      mock.style.minHeight = `${mock.offsetHeight}px`;
    }
    lockHeight();
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(lockHeight, 200);
    });

    function swap(leaving, entering) {
      const finish = () => {
        leaving.classList.remove("is-leaving");
        leaving.hidden = true;
        entering.hidden = false;
        if (reduceMotion.matches) return;
        entering.classList.add("is-entering");
        window.setTimeout(() => entering.classList.remove("is-entering"), ENTER_MS);
      };

      if (reduceMotion.matches) {
        finish();
        return;
      }
      leaving.classList.add("is-leaving");
      window.setTimeout(finish, LEAVE_MS);
    }

    window.setInterval(() => {
      if (document.hidden || !menu.classList.contains("is-open")) return;

      const slots = [];
      columns.forEach((cards) => {
        cards.filter((card) => !card.hidden).forEach((card) => slots.push({ card, cards }));
      });
      for (let i = slots.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }

      // Both swaps are decided before either one runs, so a card entering on
      // the first cannot also be chosen for the second.
      const claimed = new Set();
      slots.slice(0, SWAPS).forEach(({ card, cards }) => {
        const pool = cards.filter((option) => option.hidden && !claimed.has(option));
        if (!pool.length) return;
        const entering = pick(pool);
        claimed.add(entering);
        swap(card, entering);
      });
    }, INTERVAL);
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
    initPanelInvite();
    initPanelToggle();
    initNewFileCard();
    initStickyNotes();
    initColorPicker();
    initScreenshot();
    initStripMenus();
    initCleanMode();
    initConvert();
    initMirror();
    initScreenDraw();
    initFileTypeMenu();
    initAwakeToggle();
    initCompareRotation();
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
