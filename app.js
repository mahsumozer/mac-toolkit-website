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

  function initDownloadButtons() {
    document.querySelectorAll("[data-download]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        showToast("Monthly and yearly checkout needs a final payment or release link.");
        document.getElementById("download")?.scrollIntoView({ behavior: "smooth" });
      });
    });
  }

  function initContactForm() {
    const form = document.getElementById("contact-form");
    if (!form) return;

    const button = form.querySelector("button[type='submit']");
    const frame = document.querySelector('iframe[name="brevo-frame"]');
    let pending = false;

    form.addEventListener("submit", () => {
      pending = true;
      if (button) button.disabled = true;
    });

    if (frame) {
      frame.addEventListener("load", () => {
        if (!pending) return;
        pending = false;
        if (button) button.disabled = false;
        form.reset();
        showToast("Thanks for subscribing. Check your inbox to confirm.");
      });
    }
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
    initAwakeToggle();
    initDownloadButtons();
    initContactForm();
    initPrivacyChoice();
    initShowcaseRail();
    setTool("capture", false);
  });
})();
