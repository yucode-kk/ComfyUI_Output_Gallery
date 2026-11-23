import { app } from "../../scripts/app.js";

const BASE = "/output-gallery";
const PAGE_SIZE = 100;
const FALLBACK_CSS = "/extensions/ComfyUI_Output_Gallery/gallery.css";

const state = {
  root: null,
  scroll: null,
  grid: null,
  items: [],
  total: 0,
  hasMore: false,
  loading: false,
  query: "",
  order: "desc",
  selected: new Set(),
  anchor: -1,
  previewIndex: -1,
  previewBox: null,
  busy: false,
  selectMode: false,
  lastFocus: null,
};

let suppressClick = false;
let marquee = null;

/* ------------------------------------------------------------------ utils */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ensureStyles() {
  const id = "og-style";
  if (document.getElementById(id)) return;
  const link = el("link");
  link.id = id;
  link.rel = "stylesheet";
  try {
    link.href = new URL("./gallery.css", import.meta.url).href;
  } catch {
    link.href = FALLBACK_CSS;
  }
  document.head.appendChild(link);
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function fmtTime(seconds) {
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const thumbUrl = (item, w = 320) => `${BASE}/thumb?path=${encodeURIComponent(item.id)}&w=${w}`;
const imageUrl = (item) => `${BASE}/image?path=${encodeURIComponent(item.id)}`;

/* -------------------------------------------------------------------- api */

async function fetchPage(offset) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(PAGE_SIZE),
    order: state.order,
  });
  if (state.query) params.set("q", state.query);
  const res = await fetch(`${BASE}/list?${params}`);
  if (!res.ok) throw new Error(`列表加载失败 (${res.status})`);
  return res.json();
}

async function trashFiles(paths) {
  const res = await fetch(`${BASE}/trash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || payload.text || `删除失败 (${res.status})`);
  return payload;
}

/* ------------------------------------------------------------------- dom */

function buildRoot() {
  const root = el("div", "og-root");
  root.innerHTML = `
    <header class="og-bar">
      <div class="og-brand">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"
                fill="none" stroke="currentColor" stroke-width="1.6"/>
          <circle cx="9" cy="9.4" r="1.5" fill="currentColor"/>
          <path d="M5 17l4.4-4.6 3.2 3.2 2.6-2.4L20 17.5" fill="none" stroke="currentColor"
                stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span>Output 图库</span>
      </div>
      <input class="og-search" type="search" placeholder="搜索文件名…" spellcheck="false">
      <select class="og-order" title="排序">
        <option value="desc">最新优先</option>
        <option value="asc">最早优先</option>
      </select>
      <span class="og-total">共 0 张</span>
      <span class="og-selcount">已选 0 张</span>
      <div class="og-tools">
        <button class="og-btn" data-act="refresh" title="重新扫描 output">刷新</button>
        <button class="og-btn" data-act="mode" title="删除模式下点击图片即选中">删除模式</button>
        <button class="og-btn" data-act="select-all">全选</button>
        <button class="og-btn" data-act="clear">取消选择</button>
        <button class="og-btn og-danger" data-act="trash" disabled>移入回收站</button>
        <button class="og-btn og-icon" data-act="close" title="关闭 (Esc)">✕</button>
      </div>
    </header>
    <main class="og-scroll">
      <div class="og-grid"></div>
      <div class="og-sentinel"></div>
      <div class="og-status"></div>
    </main>
  `;
  return root;
}

function card(item, index) {
  const fig = el("figure", "og-card");
  fig.dataset.index = String(index);
  fig.dataset.id = item.id;
  fig.tabIndex = 0;
  fig.setAttribute("role", "button");
  fig.setAttribute("aria-label", item.name);

  const box = el("div", "og-thumb");
  const img = el("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = item.name;
  img.draggable = false;
  img.src = thumbUrl(item);
  img.addEventListener("error", () => {
    if (img.dataset.fallback) return;
    img.dataset.fallback = "1";
    img.src = imageUrl(item);
  });
  box.appendChild(img);

  const check = el("div", "og-check");
  check.dataset.role = "check";
  check.title = "选择";
  box.appendChild(check);
  fig.appendChild(box);

  const cap = el("figcaption");
  cap.appendChild(el("span", "og-name", item.name));
  const dims = item.width && item.height ? `${item.width}×${item.height} · ` : "";
  cap.appendChild(el("span", "og-meta", `${dims}${fmtSize(item.size)} · ${fmtTime(item.modified)}`));
  fig.appendChild(cap);
  return fig;
}

function applySelectionClass(index) {
  const node = state.grid?.children[index];
  if (!node) return;
  const item = state.items[index];
  node.classList.toggle("is-selected", state.selected.has(item.id));
}

function updateChrome() {
  if (!state.root) return;
  state.root.querySelector(".og-total").textContent = `共 ${state.total} 张`;
  state.root.querySelector(".og-selcount").textContent = `已选 ${state.selected.size} 张`;
  const modeBtn = state.root.querySelector('[data-act="mode"]');
  modeBtn.textContent = state.selectMode ? "退出删除模式" : "删除模式";
  modeBtn.classList.toggle("is-active", state.selectMode);
  const trashBtn = state.root.querySelector('[data-act="trash"]');
  trashBtn.disabled = state.selected.size === 0 || state.busy;
  trashBtn.textContent = state.busy ? "处理中…" : `移入回收站${state.selected.size ? ` (${state.selected.size})` : ""}`;
}

function setSelectMode(enabled) {
  state.selectMode = enabled;
  state.root?.classList.toggle("og-select-mode", enabled);
  if (!enabled) {
    state.selected.clear();
    state.items.forEach((_, index) => applySelectionClass(index));
  }
  updateChrome();
}

function setStatus(text, isError = false) {
  const node = state.root?.querySelector(".og-status");
  if (!node) return;
  node.textContent = text || "";
  node.classList.toggle("is-error", Boolean(isError) && Boolean(text));
}

function renderAll() {
  state.grid.textContent = "";
  const frag = document.createDocumentFragment();
  state.items.forEach((item, index) => frag.appendChild(card(item, index)));
  state.grid.appendChild(frag);
  state.items.forEach((item, index) => applySelectionClass(index));
  updateChrome();
}

function appendItems(items) {
  const start = state.items.length;
  state.items = state.items.concat(items);
  const frag = document.createDocumentFragment();
  items.forEach((item, offset) => frag.appendChild(card(item, start + offset)));
  state.grid.appendChild(frag);
  items.forEach((_, offset) => applySelectionClass(start + offset));
  updateChrome();
}

/* ------------------------------------------------------------------ data */

async function reload(options = {}) {
  const quiet = options.quiet === true;
  if (state.loading) return;
  state.loading = true;
  setStatus("正在扫描 output…");
  try {
    const page = await fetchPage(0);
    state.items = page.items;
    state.total = page.total;
    state.hasMore = page.has_more;
    state.selected = new Set([...state.selected].filter((id) => state.items.some((i) => i.id === id)));
    state.anchor = -1;
    renderAll();
    if (page.total === 0) {
      setStatus(state.query ? `没有匹配「${state.query}」的图片` : "output 里还没有图片。");
    } else if (!quiet) {
      setStatus("");
    }
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.loading = false;
  }
}

async function loadMore() {
  if (state.loading || !state.hasMore) return;
  state.loading = true;
  setStatus("加载中…");
  try {
    const page = await fetchPage(state.items.length);
    appendItems(page.items);
    state.hasMore = page.has_more;
    state.total = page.total;
    setStatus("");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.loading = false;
  }
}

/* ------------------------------------------------------------- selection */

function toggleSelect(index, value) {
  const item = state.items[index];
  if (!item) return;
  const next = value ?? !state.selected.has(item.id);
  if (next) state.selected.add(item.id);
  else state.selected.delete(item.id);
  applySelectionClass(index);
  updateChrome();
}

function selectRange(from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i += 1) {
    if (state.items[i]) state.selected.add(state.items[i].id);
    applySelectionClass(i);
  }
  updateChrome();
}

function selectAllVisible() {
  state.items.forEach((item, index) => {
    state.selected.add(item.id);
    applySelectionClass(index);
  });
  updateChrome();
}

function clearSelection() {
  state.selected.clear();
  state.items.forEach((_, index) => applySelectionClass(index));
  updateChrome();
}

/* --------------------------------------------------------------- delete */

function confirmDialog(count, sample) {
  return new Promise((resolve) => {
    const layer = el("div", "og-modal-layer");
    const box = el("div", "og-modal");
    box.appendChild(el("h3", null, `移入回收站 ${count} 张图片？`));
    const hint = el("p", "og-modal-hint", "文件会进入 Windows 回收站，可在回收站里还原。");
    box.appendChild(hint);

    const list = el("ul", "og-modal-list");
    sample.slice(0, 6).forEach((name) => list.appendChild(el("li", null, name)));
    if (count > sample.length) list.appendChild(el("li", "og-more", `…其他 ${count - sample.length} 张`));
    box.appendChild(list);

    const actions = el("div", "og-modal-actions");
    const cancel = el("button", "og-btn", "取消");
    const confirm = el("button", "og-btn og-danger", "移入回收站");
    actions.append(cancel, confirm);
    box.appendChild(actions);
    layer.appendChild(box);

    const done = (value) => {
      layer.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => done(false));
    confirm.addEventListener("click", () => done(true));
    layer.addEventListener("click", (event) => {
      if (event.target === layer) done(false);
    });
    layer.tabIndex = -1;
    document.body.appendChild(layer);
    confirm.focus();
    layer.addEventListener("keydown", (event) => {
      if (event.key === "Escape") done(false);
      if (event.key !== "Tab") return;
      const ring = [cancel, confirm];
      const at = ring.indexOf(document.activeElement);
      event.preventDefault();
      ring[(at + (event.shiftKey ? -1 : 1) + ring.length) % ring.length].focus();
    });
  });
}

async function deleteSelected() {
  if (state.busy || !state.selected.size) return;
  const paths = [...state.selected];
  const sample = state.items.filter((i) => state.selected.has(i.id)).map((i) => i.name);
  const ok = await confirmDialog(paths.length, sample);
  if (!ok) return;

  state.busy = true;
  updateChrome();
  setStatus("正在移入回收站…");
  try {
    const result = await trashFiles(paths);
    const failed = new Set(result.failed.map((f) => f.path));
    if (failed.size) {
      setStatus(`${result.deleted} 张已移除，${failed.size} 张失败：${[...failed].slice(0, 3).join("、")}`, true);
    } else {
      setStatus(`${result.deleted} 张图片已移入回收站`);
    }
    if (state.previewIndex >= 0) closePreview();
    state.selected.clear();
    state.busy = false;
    await reload({ quiet: true });
    if (failed.size) {
      paths.filter((p) => failed.has(p)).forEach((p) => {
        const index = state.items.findIndex((i) => i.id === p);
        if (index >= 0) toggleSelect(index, true);
      });
    }
  } catch (error) {
    setStatus(error.message, true);
    state.busy = false;
    updateChrome();
  }
}

/* -------------------------------------------------------------- preview */

function openPreview(index) {
  const item = state.items[index];
  if (!item) return;
  state.previewIndex = index;

  if (!state.previewBox) {
    const layer = el("div", "og-preview");
    layer.innerHTML = `
      <div class="og-preview-bar">
        <span class="og-preview-name"></span>
        <span class="og-preview-meta"></span>
        <button class="og-btn og-icon" data-act="prev" title="上一张 (←)">‹</button>
        <button class="og-btn og-icon" data-act="next" title="下一张 (→)">›</button>
        <button class="og-btn og-icon" data-act="close" title="关闭 (Esc)">✕</button>
      </div>
      <div class="og-preview-stage"><img alt=""></div>
      <div class="og-preview-hint">滚轮缩放 · 双击复位 · ← → 切换 · Esc 关闭</div>
    `;
    state.previewBox = layer;
    state.root.appendChild(layer);

    layer.querySelector('[data-act="close"]').addEventListener("click", closePreview);
    layer.querySelector('[data-act="prev"]').addEventListener("click", () => stepPreview(-1));
    layer.querySelector('[data-act="next"]').addEventListener("click", () => stepPreview(1));
    const stage = layer.querySelector(".og-preview-stage");
    const img = stage.querySelector("img");
    let scale = 1;
    let fitScale = 1;
    const apply = () => {
      img.style.transform = `scale(${scale})`;
      stage.classList.toggle("is-zoomed", scale > fitScale + 0.01);
    };
    const reset = () => {
      scale = 1;
      fitScale = 1;
      apply();
    };
    stage.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const next = Math.min(8, Math.max(0.2, scale * (event.deltaY < 0 ? 1.15 : 0.87)));
        scale = next;
        apply();
      },
      { passive: false }
    );
    stage.addEventListener("dblclick", reset);
    layer.addEventListener("click", (event) => {
      if (event.target === layer || event.target === stage) closePreview();
    });
    stage._reset = reset;
  }

  const box = state.previewBox;
  const img = box.querySelector(".og-preview-stage img");
  box.querySelector(".og-preview-stage")._reset?.();
  img.src = imageUrl(item);
  img.alt = item.name;
  box.querySelector(".og-preview-name").textContent = item.name;
  const dims = item.width && item.height ? `${item.width}×${item.height} · ` : "";
  box.querySelector(".og-preview-meta").textContent = `${item.dir ? item.dir + " · " : ""}${dims}${fmtSize(item.size)} · ${fmtTime(item.modified)}`;
  box.classList.add("is-open");
}

function stepPreview(delta) {
  if (state.previewIndex < 0) return;
  const next = state.previewIndex + delta;
  if (next < 0 || next >= state.items.length) {
    if (delta > 0 && state.hasMore) loadMore().then(() => openPreview(next));
    return;
  }
  openPreview(next);
}

function closePreview() {
  state.previewIndex = -1;
  state.previewBox?.classList.remove("is-open");
}

/* ------------------------------------------------------------ lifecycle */

function onKeyDown(event) {
  if (!state.root) return;
  const key = event.key;
  const target = event.target;
  const tag = target?.tagName ? target.tagName.toLowerCase() : "";
  const typing = tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;

  // The confirm dialog manages its own keys (Esc keeps its own handler).
  if (target instanceof Element && target.closest(".og-modal-layer")) return;

  if (state.previewIndex >= 0) {
    if (key === "Escape") {
      closePreview();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (key === "ArrowRight") {
      stepPreview(1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (key === "ArrowLeft") {
      stepPreview(-1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  } else if (key === "Escape" && !typing) {
    if (state.selectMode) {
      setSelectMode(false);
      setStatus("已退出删除模式，点击图片可以查看大图");
    } else {
      close();
    }
    event.preventDefault();
    event.stopPropagation();
    return;
  } else if (!typing && target instanceof HTMLElement && target.classList.contains("og-card")) {
    const index = Number(target.dataset.index);
    if (key === "Enter") {
      if (state.selectMode) {
        toggleSelect(index);
        state.anchor = index;
      } else {
        openPreview(index);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (key === " ") {
      toggleSelect(index);
      state.anchor = index;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  if (!typing) event.stopPropagation();
}

function bindMarquee() {
  const scroll = state.scroll;

  const onDown = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, input, select, .og-preview")) return;
    marquee = {
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      base: new Set(state.selected),
      additive: event.ctrlKey || event.metaKey,
      box: null,
    };
  };

  const onMove = (event) => {
    if (!marquee) return;
    const dx = event.clientX - marquee.startX;
    const dy = event.clientY - marquee.startY;
    if (!marquee.dragging) {
      if (Math.hypot(dx, dy) < 6) return;
      marquee.dragging = true;
      const box = el("div", "og-marquee");
      scroll.appendChild(box);
      marquee.box = box;
      document.body.classList.add("og-dragging");
    }
    const rect = scroll.getBoundingClientRect();
    const left = Math.min(marquee.startX, event.clientX) - rect.left;
    const top = Math.min(marquee.startY, event.clientY) - rect.top;
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    Object.assign(marquee.box.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });

    const hit = new DOMRect(
      Math.min(marquee.startX, event.clientX),
      Math.min(marquee.startY, event.clientY),
      width,
      height
    );
    const picked = new Set(marquee.additive ? marquee.base : []);
    [...state.grid.children].forEach((node, index) => {
      const r = node.getBoundingClientRect();
      const overlap = !(r.right < hit.left || r.left > hit.right || r.bottom < hit.top || r.top > hit.bottom);
      if (overlap) picked.add(state.items[index].id);
    });
    state.items.forEach((item, index) => {
      const isIn = picked.has(item.id);
      const cls = state.grid.children[index]?.classList;
      if (!cls) return;
      cls.toggle("is-selected", isIn);
      if (isIn) state.selected.add(item.id);
      else state.selected.delete(item.id);
    });
    updateChrome();
  };

  const onUp = () => {
    if (!marquee) return;
    const wasDragging = marquee.dragging;
    marquee.box?.remove();
    document.body.classList.remove("og-dragging");
    marquee = null;
    if (wasDragging) {
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    }
  };

  scroll.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  state.unbindMarquee = () => {
    scroll.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}

function bindGrid() {
  state.grid.addEventListener("click", (event) => {
    if (suppressClick) return;
    const fig = event.target.closest(".og-card");
    if (!fig) return;
    const index = Number(fig.dataset.index);
    const onCheck = Boolean(event.target.closest('[data-role="check"]'));

    if (state.selectMode) {
      if (event.shiftKey && state.anchor >= 0) selectRange(state.anchor, index);
      else {
        toggleSelect(index);
        state.anchor = index;
      }
      return;
    }
    if (onCheck) {
      toggleSelect(index);
      state.anchor = index;
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      toggleSelect(index);
      state.anchor = index;
      return;
    }
    if (event.shiftKey && state.anchor >= 0) {
      selectRange(state.anchor, index);
      return;
    }
    state.anchor = index;
    openPreview(index);
  });

  state.grid.addEventListener("dblclick", (event) => {
    if (state.selectMode) return;
    if (event.target.closest('[data-role="check"]')) return;
    const fig = event.target.closest(".og-card");
    if (fig) toggleSelect(Number(fig.dataset.index));
  });
}

function bindChrome() {
  const root = state.root;
  const scroll = state.scroll;

  root.querySelector(".og-search").addEventListener("input", (event) => {
    const value = event.target.value.trim();
    clearTimeout(root._searchTimer);
    root._searchTimer = setTimeout(() => {
      state.query = value;
      reload();
    }, 320);
  });

  root.querySelector(".og-order").addEventListener("change", (event) => {
    state.order = event.target.value;
    reload();
  });

  root.querySelector(".og-tools").addEventListener("click", (event) => {
    const action = event.target.closest("[data-act]")?.dataset.act;
    if (!action) return;
    if (action === "refresh") reload();
    if (action === "mode") {
      setSelectMode(!state.selectMode);
      setStatus(
        state.selectMode
          ? "删除模式：点击图片即可选中，Shift 连选，Esc 退出"
          : "已退出删除模式，点击图片可以查看大图"
      );
    }
    if (action === "select-all") selectAllVisible();
    if (action === "clear") clearSelection();
    if (action === "trash") deleteSelected();
    if (action === "close") close();
  });

  scroll.addEventListener("scroll", () => {
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 600) loadMore();
  });

  scroll.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
}

function open() {
  if (state.root) return;
  ensureStyles();
  state.lastFocus = document.activeElement;
  const root = buildRoot();
  document.body.appendChild(root);
  document.body.classList.add("og-open");

  state.root = root;
  state.scroll = root.querySelector(".og-scroll");
  state.grid = root.querySelector(".og-grid");
  state.items = [];
  state.total = 0;
  state.hasMore = false;
  state.selected = new Set();
  state.query = "";
  state.order = root.querySelector(".og-order").value;
  state.previewIndex = -1;
  state.selectMode = false;
  root.classList.remove("og-select-mode");
  root.querySelector(".og-search").value = "";

  bindChrome();
  bindGrid();
  bindMarquee();
  window.addEventListener("keydown", onKeyDown, true);
  root.querySelector(".og-search").focus();
  reload();
}

function close() {
  if (!state.root) return;
  const back = state.lastFocus;
  window.removeEventListener("keydown", onKeyDown, true);
  state.unbindMarquee?.();
  state.previewBox?.remove();
  state.previewBox = null;
  state.root.remove();
  state.root = null;
  state.scroll = null;
  state.grid = null;
  state.items = [];
  state.selected = new Set();
  state.previewIndex = -1;
  state.selectMode = false;
  document.body.classList.remove("og-open", "og-dragging");
  if (back && typeof back.focus === "function") back.focus();
}

/* -------------------------------------------------------------- register */

app.registerExtension({
  name: "ComfyUI.OutputGallery",

  get actionBarButtons() {
    return [
      {
        icon: "icon-[lucide--images] size-4",
        label: "图库",
        tooltip: "打开 output 图片图库",
        onClick: open,
      },
    ];
  },

  commands: [
    {
      id: "output-gallery.open",
      label: "打开 Output 图库",
      icon: "icon-[lucide--images]",
      function: open,
    },
  ],

  setup() {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.ctrlKey && event.shiftKey && (event.key === "G" || event.key === "g")) {
          event.preventDefault();
          open();
        }
      },
      true
    );
  },
});
