import { hierarchy as d3Hierarchy, treemap as d3Treemap, treemapSquarify } from "https://cdn.jsdelivr.net/npm/d3-hierarchy@3/+esm";

const presetButtonsEl = document.getElementById("presetButtons");
const controlsEl = document.querySelector(".controls");
const startDateEl = document.getElementById("startDate");
const endDateEl = document.getElementById("endDate");
const datePickerButtons = Array.from(document.querySelectorAll(".date-picker-btn"));
const benchmarksBarEl = document.getElementById("benchmarksBar");
const autoRefreshControlsEl = document.getElementById("autoRefreshControls");
const autoRefreshToggleEl = document.getElementById("autoRefreshToggle");
const autoRefreshToggleWrapEl = document.getElementById("autoRefreshToggleWrap");
const autoRefreshIntervalEl = document.getElementById("autoRefreshInterval");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const refreshBtn = document.getElementById("refreshBtn");
const heatmapEl = document.getElementById("heatmap");

const state = {
  sectors: [],
  benchmarks: [],
  preset: "latest",
  drilldownSectorCode: null,
  drilldownHintPending: false,
  autoRefreshEnabled: false,
  autoRefreshIntervalMs: 2000,
  autoRefreshTimer: null,
  requestController: null
};

init();

function init() {
  const today = shanghaiToday();
  startDateEl.value = today;
  endDateEl.value = today;

  presetButtonsEl.addEventListener("click", onPresetButtonClick);
  refreshBtn.addEventListener("click", loadData);
  autoRefreshToggleEl?.addEventListener("change", onAutoRefreshToggleChange);
  autoRefreshIntervalEl?.addEventListener("change", onAutoRefreshIntervalChange);
  fullscreenBtn?.addEventListener("click", toggleFullscreen);
  controlsEl?.addEventListener("dblclick", onControlsDblClick);
  for (const btn of datePickerButtons) {
    btn.addEventListener("click", onDatePickerButtonClick);
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  window.addEventListener("resize", render);

  syncPresetButtons();
  onPresetChange();
  renderBenchmarks();
  syncFullscreenButton();
  syncAutoRefreshControls();
  syncAutoRefreshTimer();
  loadData();
}

function onPresetButtonClick(event) {
  const btn = event.target.closest(".preset-btn");
  if (!btn) return;
  const nextPreset = btn.dataset.preset;
  if (!nextPreset) return;
  const wasPreset = state.preset;
  state.preset = nextPreset;
  syncPresetButtons();
  onPresetChange();
  if (state.preset !== "custom") {
    const forceLatestRefresh = wasPreset === "latest" && nextPreset === "latest";
    loadData({ forceLatestRefresh });
  }
}

function onPresetChange() {
  const isCustom = state.preset === "custom";
  startDateEl.disabled = !isCustom;
  endDateEl.disabled = !isCustom;
  for (const btn of datePickerButtons) {
    btn.disabled = !isCustom;
  }
  applyPresetDateInputs();
  syncAutoRefreshControls();
  syncAutoRefreshTimer();
}

function onAutoRefreshToggleChange() {
  state.autoRefreshEnabled = !!autoRefreshToggleEl?.checked;
  syncAutoRefreshControls();
  syncAutoRefreshTimer();
}

function onAutoRefreshIntervalChange() {
  const ms = Number(autoRefreshIntervalEl?.value);
  state.autoRefreshIntervalMs = Number.isFinite(ms) && ms > 0 ? ms : 2000;
  syncAutoRefreshTimer();
}

function syncAutoRefreshControls() {
  const latest = state.preset === "latest";
  if (autoRefreshControlsEl) {
    autoRefreshControlsEl.classList.toggle("is-inactive", !latest);
  }
  if (autoRefreshToggleEl) {
    autoRefreshToggleEl.disabled = !latest;
    autoRefreshToggleEl.checked = latest && state.autoRefreshEnabled;
  }
  if (autoRefreshToggleWrapEl) {
    autoRefreshToggleWrapEl.classList.toggle("is-active", latest && state.autoRefreshEnabled);
    autoRefreshToggleWrapEl.classList.toggle("is-disabled", !latest);
  }
  if (autoRefreshIntervalEl) {
    autoRefreshIntervalEl.disabled = !latest || !state.autoRefreshEnabled;
    autoRefreshIntervalEl.value = String(state.autoRefreshIntervalMs);
  }
}

function syncAutoRefreshTimer() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  if (!(state.preset === "latest" && state.autoRefreshEnabled)) {
    return;
  }
  state.autoRefreshTimer = setInterval(() => {
    if (state.preset !== "latest" || !state.autoRefreshEnabled) return;
    if (state.requestController) return;
    loadData({ forceLatestRefresh: true, backgroundRefresh: true });
  }, state.autoRefreshIntervalMs);
}

function onDatePickerButtonClick(event) {
  const targetId = event.currentTarget?.dataset?.target;
  const input = targetId ? document.getElementById(targetId) : null;
  if (!input || input.disabled) return;

  input.focus();
  if (typeof input.showPicker === "function") {
    input.showPicker();
    return;
  }
  input.click();
}

function onControlsDblClick(event) {
  if (!state.drilldownSectorCode) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("button, input")) return;
  state.drilldownSectorCode = null;
  render();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  } catch {
    // 用户手势限制或浏览器不支持时静默忽略
  }
}

function onFullscreenChange() {
  syncFullscreenButton();
  render();
}

function syncFullscreenButton() {
  if (!fullscreenBtn) return;
  const isFs = !!document.fullscreenElement;
  fullscreenBtn.textContent = isFs ? "退出全屏" : "全屏";
}

async function loadData(options = {}) {
  if (state.requestController && options.backgroundRefresh) {
    return;
  }
  if (state.requestController) {
    state.requestController.abort();
  }
  const controller = new AbortController();
  state.requestController = controller;

  if (!options.backgroundRefresh) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "加载中...";
    heatmapEl.innerHTML = '<div class="empty">正在获取 iFinD 数据...</div>';
  }

  try {
    const payload = { preset: state.preset };
    if (state.preset === "latest" && options.forceLatestRefresh === true) {
      payload.forceLatestRefresh = true;
    }
    if (state.preset === "custom") {
      payload.startDate = startDateEl.value;
      payload.endDate = endDateEl.value || shanghaiToday();
    }

    const resp = await fetch("/api/heatmap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || "请求失败");
    }

    state.sectors = data.sectors || [];
    state.benchmarks = data.benchmarks || [];
    if (state.drilldownSectorCode && !state.sectors.some((x) => x.sectorCode === state.drilldownSectorCode)) {
      state.drilldownSectorCode = null;
    }
    syncDateInputsFromResponse(data.range || {});
    renderBenchmarks();
    render();
  } catch (err) {
    if (err?.name === "AbortError") {
      return;
    }
    if (!options.backgroundRefresh) {
      state.sectors = [];
      state.benchmarks = [];
    }
    if (options.backgroundRefresh) {
      return;
    }
    heatmapEl.innerHTML = `<div class="empty">${escapeHtml(err.message || "加载失败")}</div>`;
  } finally {
    if (state.requestController === controller) {
      state.requestController = null;
    }
    if (!options.backgroundRefresh) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "查询";
    }
  }
}

function renderBenchmarks() {
  if (!benchmarksBarEl) return;
  const items = state.benchmarks || [];
  if (!items.length) {
    benchmarksBarEl.innerHTML = "";
    return;
  }
  benchmarksBarEl.innerHTML = items
    .map((x) => {
      const v = Number(x.returnPct);
      const cls = !Number.isFinite(v) ? "na" : v >= 0 ? "up" : "down";
      return `<span class="bench-item"><span class="bench-name">${escapeHtml(x.name)}</span> <span class="bench-ret ${cls}">${fmtPct(v)}</span></span>`;
    })
    .join("");
}

function render() {
  const sectors = state.sectors;
  if (!sectors?.length) {
    heatmapEl.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }

  if (state.drilldownSectorCode) {
    return renderSectorDrilldown();
  }

  renderMarketHeatmap();
}

function renderMarketHeatmap() {
  const sectors = state.sectors;

  heatmapEl.innerHTML = "";
  const width = heatmapEl.clientWidth;
  const height = heatmapEl.clientHeight;
  const tiles = squarify(
    sectors.map((s) => ({ value: Math.max(Number(s.tileValue) || 0, 0.0001), data: s })),
    { x: 0, y: 0, w: width, h: height }
  );

  for (const tile of tiles) {
    const s = tile.data;
    const div = document.createElement("div");
    div.className = "tile";
    div.style.left = `${tile.x}px`;
    div.style.top = `${tile.y}px`;
    div.style.width = `${Math.max(tile.w, 0)}px`;
    div.style.height = `${Math.max(tile.h, 0)}px`;

    const sectorRet = Number(s.sectorReturnPct);
    const hasSectorRet = Number.isFinite(sectorRet);
    const absMove = Math.min(1, Math.abs(hasSectorRet ? sectorRet : 0) / 6);
    const opacity = 0.38 + absMove * 0.52;
    if (!hasSectorRet) {
      div.style.background = "rgba(115,130,156,0.28)";
    } else if (sectorRet >= 0) {
      div.style.background = `rgba(214,92,92,${opacity})`;
    } else {
      div.style.background = `rgba(48,168,126,${opacity})`;
    }

    const signColor = !hasSectorRet ? "#c7d2e8" : sectorRet >= 0 ? "#ffd5d5" : "#d7ffe6";
    const maxStockLines = calcVisibleStockLines(tile);
    const stockHtml = (s.topStocks || [])
      .slice(0, maxStockLines)
      .map((x) => `<div class="stock-line">${escapeHtml(x.name)} ${fmtPct(x.returnPct)}</div>`)
      .join("");

    div.innerHTML = `
      <p class="tile-title">${escapeHtml(s.sectorName)} <span class="inline-ret" style="color:${signColor}">${fmtPct(s.sectorReturnPct)}</span></p>
      <div class="stock-list">${stockHtml}</div>
    `;
    if ((s.drilldownStocks || []).length > 0) {
      div.classList.add("clickable");
      div.title = `点击查看${s.sectorName}行业个股热力图`;
      div.addEventListener("click", () => {
        state.drilldownHintPending = true;
        state.drilldownSectorCode = s.sectorCode;
        render();
      });
    }

    heatmapEl.appendChild(div);
  }
}

function renderSectorDrilldown() {
  const sector = state.sectors.find((x) => x.sectorCode === state.drilldownSectorCode);
  if (!sector) {
    state.drilldownSectorCode = null;
    return renderMarketHeatmap();
  }
  const stocks = (sector.drilldownStocks || []).filter((x) => Number(x.tileValue) > 0);
  if (!stocks.length) {
    state.drilldownSectorCode = null;
    return renderMarketHeatmap();
  }

  heatmapEl.innerHTML = "";
  const width = heatmapEl.clientWidth;
  const height = heatmapEl.clientHeight;
  const tiles = squarify(
    stocks.map((s) => ({ value: Math.max(Number(s.tileValue) || 0, 0.0001), data: s })),
    { x: 0, y: 0, w: width, h: height }
  );

  for (const tile of tiles) {
    const s = tile.data;
    const div = document.createElement("div");
    div.className = "tile stock-tile";
    div.style.left = `${tile.x}px`;
    div.style.top = `${tile.y}px`;
    div.style.width = `${Math.max(tile.w, 0)}px`;
    div.style.height = `${Math.max(tile.h, 0)}px`;

    const stockRet = Number(s.returnPct);
    const hasStockRet = Number.isFinite(stockRet);
    const absMove = Math.min(1, Math.abs(hasStockRet ? stockRet : 0) / 8);
    const opacity = 0.34 + absMove * 0.56;
    if (!hasStockRet) {
      div.style.background = "rgba(115,130,156,0.28)";
    } else if (stockRet >= 0) {
      div.style.background = `rgba(214,92,92,${opacity})`;
    } else {
      div.style.background = `rgba(48,168,126,${opacity})`;
    }

    const signColor = !hasStockRet ? "#c7d2e8" : stockRet >= 0 ? "#ffd5d5" : "#d7ffe6";
    const compact = tile.w < 88 || tile.h < 40;
    const valuationLines = calcVisibleValuationLines(tile, compact);
    const valuationLineHtml = [];
    if (valuationLines >= 1) valuationLineHtml.push(`<div class="stock-meta-line">PE ${fmtMetric(s.pe)}</div>`);
    if (valuationLines >= 2) valuationLineHtml.push(`<div class="stock-meta-line">PB ${fmtMetric(s.pb)}</div>`);
    if (valuationLines >= 3) valuationLineHtml.push(`<div class="stock-meta-line">DY ${fmtMetricPct(s.dy)}</div>`);
    const valuationHtml = valuationLineHtml.length ? `<div class="stock-meta">${valuationLineHtml.join("")}</div>` : "";
    div.innerHTML = compact
      ? `<p class="tile-title">${escapeHtml(shortLabel(s.name, 6))} <span class="inline-ret" style="color:${signColor}">${fmtPct(s.returnPct)}</span></p>`
      : `<p class="tile-title">${escapeHtml(s.name)} <span class="inline-ret" style="color:${signColor}">${fmtPct(s.returnPct)}</span></p>${valuationHtml}`;
    heatmapEl.appendChild(div);
  }

  if (state.drilldownHintPending) {
    state.drilldownHintPending = false;
    const hint = document.createElement("div");
    hint.className = "drilldown-hint";
    hint.textContent = "双击空白处返回";
    heatmapEl.appendChild(hint);
  }
}

function calcVisibleStockLines(tile) {
  // 留出标题和内边距后，根据剩余高度估算可容纳行数；再用宽度兜底避免挤压。
  if (tile.w < 105 || tile.h < 66) return 0;
  if (tile.w < 130 || tile.h < 78) return 1;

  const paddingAndGap = 20;
  const titleHeight = tile.w < 220 ? 22 : 26;
  const lineHeight = tile.w < 220 ? 16 : 17;
  const remaining = tile.h - paddingAndGap - titleHeight;
  const byHeight = Math.max(0, Math.floor(remaining / lineHeight));

  // 宽度仅做“可读性下限”限制；有足够高度时尽量多显示。
  let byWidth = 10;
  if (tile.w < 150) byWidth = 2;
  else if (tile.w < 180) byWidth = 3;
  else if (tile.w < 220) byWidth = 5;

  return Math.max(0, Math.min(10, byHeight, byWidth));
}

function calcVisibleValuationLines(tile, compact) {
  if (compact) return 0;
  if (tile.w < 90 || tile.h < 50) return 0;
  if (tile.h < 62) return 1;
  if (tile.h < 74) return 2;

  const titleHeight = tile.w < 120 ? 18 : 22;
  const lineHeight = 11;
  const basePadding = 10;
  const remaining = tile.h - basePadding - titleHeight;
  const byHeight = Math.floor(Math.max(0, remaining) / lineHeight);

  let byWidth = 3;
  if (tile.w < 98) byWidth = 1;
  else if (tile.w < 108) byWidth = 2;

  return Math.max(0, Math.min(3, byHeight, byWidth));
}

function shortLabel(name, maxChars) {
  const s = String(name || "");
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

function fmtMetric(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "--";
  return n.toFixed(n >= 100 ? 0 : 1);
}

function fmtMetricPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "--";
  return `${n.toFixed(2)}%`;
}

function syncPresetButtons() {
  for (const btn of presetButtonsEl.querySelectorAll(".preset-btn")) {
    btn.classList.toggle("is-active", btn.dataset.preset === state.preset);
  }
}

function applyPresetDateInputs() {
  if (state.preset === "custom") {
    if (!endDateEl.value) endDateEl.value = shanghaiToday();
    if (!startDateEl.value) startDateEl.value = endDateEl.value;
    return;
  }

  const today = shanghaiToday();
  let start = today;
  if (state.preset === "1w") start = shiftDate(today, -7);
  if (state.preset === "1m") start = shiftMonth(today, -1);
  if (state.preset === "ytd") start = `${today.slice(0, 4)}-01-01`;
  if (state.preset === "1y") start = shiftYear(today, -1);
  startDateEl.value = start;
  endDateEl.value = today;
}

function syncDateInputsFromResponse(range) {
  if (range.startDate) startDateEl.value = range.startDate;
  if (range.endDate) endDateEl.value = range.endDate;
}

function squarify(items, rect) {
  const values = items
    .slice()
    .filter((x) => Number(x.value) > 0)
    .map((x) => ({ value: Number(x.value), data: x.data }));
  if (!values.length || rect.w <= 0 || rect.h <= 0) {
    return [];
  }

  const root = d3Hierarchy({ children: values })
    .sum((d) => d.value)
    .sort((a, b) => (b.value || 0) - (a.value || 0));

  d3Treemap()
    .size([rect.w, rect.h])
    .paddingInner(0)
    .round(true)
    .tile(treemapSquarify)(root);

  return root.leaves().map((leaf) => ({
    x: rect.x + leaf.x0,
    y: rect.y + leaf.y0,
    w: Math.max(0, leaf.x1 - leaf.x0),
    h: Math.max(0, leaf.y1 - leaf.y0),
    data: leaf.data.data
  }));
}

function shanghaiToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

function fmtPct(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) {
    return "--";
  }
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shiftDate(isoDate, delta) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function shiftMonth(isoDate, delta) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

function shiftYear(isoDate, delta) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + delta);
  return d.toISOString().slice(0, 10);
}
