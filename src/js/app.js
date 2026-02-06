import {
  loadData,
  loadDataFromArea,
  saveData,
  clearData,
  createBackupSnapshot,
  loadIconCache,
  saveIconCache,
  defaultData,
  getChromeApi,
  getStorageKey,
} from "./storage.js";
import { getBingWallpaper } from "./bing-wallpaper.js";
import { resolveIcon, refreshAllIcons, retryFailedIconsIfDue, getFaviconCandidates, getSiteKey } from "./icons.js";

const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const elements = {
  background: $("background"),
  grid: $("grid"),
  emptyState: $("emptyState"),
  emptyHintToggle: $("emptyHintToggle"),
  main: document.querySelector(".main"),
  recentTab: $("recentTab"),
  groupTabs: $("groupTabs"),
  topSearch: $("topSearch"),
  topSearchWrap: $("topSearchWrap"),
  btnAdd: $("btnAdd"),
  btnBatchDelete: $("btnBatchDelete"),
  btnSelectAll: $("btnSelectAll"),
  btnOpenMode: $("btnOpenMode"),
  btnSettings: $("btnSettings"),
  btnSearch: $("btnSearch"),
  btnToggleSidebar: $("btnToggleSidebar"),
  btnAddGroup: $("btnAddGroup"),
  modalOverlay: $("modalOverlay"),
  modal: $("modal"),
  contextMenu: $("contextMenu"),
  toastContainer: $("toastContainer"),
  tooltip: $("tooltip"),
  folderOverlay: $("folderOverlay"),
  folderGrid: $("folderGrid"),
  folderTitle: $("folderTitle"),
  btnCloseFolder: $("btnCloseFolder"),
  btnFolderAdd: $("btnFolderAdd"),
  btnFolderBatchDelete: $("btnFolderBatchDelete"),
};

let data = null;
let activeGroupId = null;
let openFolderId = null;
let selectionMode = false;
let selectedIds = new Set();
let pendingDeletion = null;
let tooltipTimer = null;
let dragState = null;
let lastSelectedIndex = null;
let recentItems = [];
let draggingGroupId = null;
let boxSelecting = false;
let selectionBox = null;
let selectionStart = null;
let suppressBlankClick = false;
let isDraggingBox = false;
let settingsOpen = false;
let settingsSaving = false;
let settingsSaveTimer = null;
let settingsSaveQueued = false;
let settingsSaveNow = null;
let renderSeq = 0;
let lastMainLayout = null;
let storageReloadTimer = null;
let pendingStorageReload = false;
let suppressStorageUntil = 0;
let persistInFlight = 0;
let backupFingerprint = "";
let backupBaselineSnapshot = null;
let skipAutoBackupOnce = false;
const DEBUG_LOG_KEY = "homepage_debug_log";

// ==================== 常量定义 ====================
const RECENT_GROUP_ID = "__recent__";
const RECENT_LIMIT = 24;

const DEFAULT_TILE_SIZE = 150;
const DEFAULT_BASE_FONT = 13;
const TOAST_DURATION_MS = 5000;
const TOOLTIP_DELAY_MS = 200;
const UNDO_TIMEOUT_MS = 10000;
const STORAGE_RELOAD_DELAY_MS = 120;
const STORAGE_SUPPRESS_MS = 350;
const SETTINGS_SAVE_DELAY_MS = 120;
const TOAST_CONSUME_TIMEOUT_MS = 15000;
const TITLE_FETCH_TIMEOUT_MS = 6000;
const ICON_PROBE_TIMEOUT_MS = 6000;
const HISTORY_DAYS = 7;
const MIN_TILE_SIZE = 32;
const MAX_TILE_SIZE = 220;
const MAX_DEBUG_LOG_ENTRIES = 200;
const BOX_SELECT_THRESHOLD = 6;

const densityMap = {
  compact: { gap: 10 },
  standard: { gap: 16 },
  spacious: { gap: 22 },
};
const bgOverlayMap = {
  light: "rgba(245, 246, 250, 0.85)",
  dark: "rgba(12, 15, 20, 0.72)",
};

function debugLog(event, payload = {}) {
  const entry = { ts: Date.now(), event, payload };
  try {
    const raw = localStorage.getItem(DEBUG_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(list.slice(0, MAX_DEBUG_LOG_ENTRIES)));
  } catch (err) {
    console.warn("debugLog failed", err);
  }
  console.log("[debug]", entry);
}

function getRuntimeInfo() {
  const api = getChromeApi();
  return {
    runtimeId: api?.runtime?.id || "",
    href: window.location.href,
    origin: window.location.origin,
  };
}

function shouldDebugPersist() {
  try {
    return localStorage.getItem("homepage_debug_persist") === "1";
  } catch (e) {
    console.warn("shouldDebugPersist failed", e);
    return false;
  }
}

async function loadLatestDataForApp() {
  const localData = await loadData();
  if (localData.settings.syncEnabled) {
    const syncData = await loadDataFromArea(true);
    if (syncData && syncData.groups?.length) {
      const localTs = Number(localData.lastUpdated || 0);
      const syncTs = Number(syncData.lastUpdated || 0);
      return syncTs >= localTs ? syncData : localData;
    }
  }
  return localData;
}

async function reloadFromStorage() {
  const prevActive = activeGroupId;
  const prevOpenFolder = openFolderId;
  const prevSelected = new Set(selectedIds);
  data = await loadLatestDataForApp();
  if (prevActive === RECENT_GROUP_ID) {
    activeGroupId = RECENT_GROUP_ID;
  } else if (prevActive && data.groups.find((g) => g.id === prevActive)) {
    activeGroupId = prevActive;
  } else {
    activeGroupId = data.groups?.[0]?.id || RECENT_GROUP_ID;
  }
  if (prevOpenFolder && data.nodes?.[prevOpenFolder]?.type === "folder") {
    openFolderId = prevOpenFolder;
  } else {
    openFolderId = null;
  }
  selectedIds = new Set([...prevSelected].filter((id) => data.nodes?.[id]));
  syncBackupBaseline(data);
  render();
  await consumeSaveToast();
}

function scheduleStorageReload() {
  if (settingsOpen) {
    pendingStorageReload = true;
    return;
  }
  if (storageReloadTimer) clearTimeout(storageReloadTimer);
  storageReloadTimer = setTimeout(async () => {
    storageReloadTimer = null;
    await reloadFromStorage();
  }, STORAGE_RELOAD_DELAY_MS);
}

function attachStorageListener() {
  const api = getChromeApi();
  if (!api?.storage?.onChanged) return;
  const key = getStorageKey();
  api.storage.onChanged.addListener((changes, areaName) => {
    if (persistInFlight > 0) return;
    if (Date.now() < suppressStorageUntil) return;
    if (!changes || !changes[key]) return;
    if (areaName !== "local" && areaName !== "sync") return;
    const incoming = changes[key].newValue;
    const incomingTs = Number(incoming?.lastUpdated || 0);
    const localTs = Number(data?.lastUpdated || 0);
    if (incomingTs > 0 && localTs > 0 && incomingTs <= localTs) return;
    scheduleStorageReload();
  });
}

window.homepageDebugLog = () => {
  try {
    return JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || "[]");
  } catch (e) {
    console.warn("homepageDebugLog parse failed", e);
    return [];
  }
};

window.homepageDebugEnv = async () => {
  const api = getChromeApi();
  const info = getRuntimeInfo();
  return new Promise((resolve) => {
    if (!api?.storage?.local?.getBytesInUse) return resolve(info);
    api.storage.local.getBytesInUse("homepage_data", (bytes) => {
      resolve({ ...info, bytes });
    });
  });
};

function applyDensity() {
  const d = densityMap[data.settings.gridDensity] || densityMap.standard;
  document.documentElement.style.setProperty("--grid-gap", `${d.gap}px`);
  const baseFont = Number(data.settings.fontSize) || DEFAULT_BASE_FONT;
  document.documentElement.style.setProperty("--tile-font", `${baseFont}px`);
  document.documentElement.style.setProperty("--base-font", `${baseFont}px`);
  if (!data.settings.lastTileSize || data.settings.lastTileSize <= 0 || data.settings.lastTileSize < DEFAULT_TILE_SIZE) {
    data.settings.lastTileSize = DEFAULT_TILE_SIZE;
  }
}

function applyTheme() {
  const theme = data.settings.theme || "system";
  if (theme === "system") {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
    applyBackgroundOverlay();
    return;
  }
  document.documentElement.setAttribute("data-theme", theme);
  applyBackgroundOverlay();
}

function applySidebarState() {
  document.body.classList.toggle("sidebar-collapsed", !!data.settings.sidebarCollapsed);
  document.body.classList.toggle("sidebar-hidden", !!data.settings.sidebarHidden);
  if (elements.btnToggleSidebar) {
    elements.btnToggleSidebar.textContent = data.settings.sidebarCollapsed ? "展开" : "收起";
  }
  syncSidebarTabLabels();
}

function syncSidebarTabLabels() {
  if (!elements.recentTab) return;
  const collapsed = !!data.settings.sidebarCollapsed;
  const recentLabel = elements.recentTab.dataset.label || elements.recentTab.textContent || "最近浏览";
  elements.recentTab.dataset.label = recentLabel;
  elements.recentTab.setAttribute("aria-label", recentLabel);
  elements.recentTab.textContent = collapsed ? "" : recentLabel;
  qsa(".group-tab", elements.groupTabs).forEach((btn) => {
    const label = btn.dataset.label || btn.textContent || "";
    btn.dataset.label = label;
    btn.setAttribute("aria-label", label || "分组");
    btn.textContent = collapsed ? "" : label;
  });
}

function toast(message, actionLabel, action) {
  const el = document.createElement("div");
  el.className = "toast";
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (actionLabel && action) {
    const btn = document.createElement("button");
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => {
      action();
      el.remove();
    });
    el.appendChild(btn);
  }
  elements.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), TOAST_DURATION_MS);
}

function listenForExternalToast() {
  const api = getChromeApi();
  if (!api?.runtime?.onMessage) return;
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "homepage_show_toast" && message?.text) {
      toast(message.text);
      sendResponse?.({ ok: true });
      return true;
    }
    return false;
  });
}

async function consumeSaveToast() {
  const toastInfo = data?.settings?.lastSaveToast;
  if (!toastInfo) return;
  const ts = Number(toastInfo.ts || 0);
  if (!ts || Date.now() - ts > TOAST_CONSUME_TIMEOUT_MS) {
    data.settings.lastSaveToast = null;
    await persistData();
    return;
  }
  const groupName = toastInfo.groupName || "未命名";
  toast(`已保存到分组：${groupName}`);
  data.settings.lastSaveToast = null;
  await persistData();
}

function showTooltip(text, x, y) {
  if (!data.settings.tooltipEnabled) return;
  elements.tooltip.textContent = text;
  elements.tooltip.style.left = `${x + 12}px`;
  elements.tooltip.style.top = `${y + 12}px`;
  elements.tooltip.classList.remove("hidden");
}

function hideTooltip() {
  elements.tooltip.classList.add("hidden");
}

function normalizeUrl(input) {
  if (!input) return "";
  try {
    const url = new URL(input);
    return url.href;
  } catch (err) {
    const withScheme = `https://${input}`;
    try {
      const url = new URL(withScheme);
      return url.href;
    } catch (err2) {
      return "";
    }
  }
}

function normalizeUrlWithScheme(input, scheme) {
  if (!input) return "";
  const raw = input.trim();
  if (!raw) return "";
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const candidate = hasScheme ? raw : `${scheme}://${raw.replace(/^\/+/, "")}`;
  try {
    const url = new URL(candidate);
    return url.href;
  } catch (e) {
    // URL 解析失败是预期行为，不需要警告
    return "";
  }
}

async function openUrl(url, mode) {
  const api = getChromeApi();
  const openMode = mode || data.settings.openMode;
  if (api?.tabs && (openMode === "new" || openMode === "background")) {
    api.tabs.create({ url, active: openMode !== "background" });
    return;
  }
  if (openMode === "new") {
    window.open(url, "_blank");
  } else if (openMode === "background") {
    window.open(url, "_blank", "noopener,noreferrer");
  } else {
    window.location.href = url;
  }
}

function setBackground(style) {
  if (!style) return;
  if (style.startsWith("data:") || style.startsWith("http")) {
    elements.background.style.backgroundImage = `url('${style}')`;
  } else {
    elements.background.style.backgroundImage = style;
  }
}

function applyBackgroundOverlay() {
  const type = data?.settings?.backgroundType || "bing";
  const isImage = type === "bing" || type === "custom";
  const strength = Math.min(0.6, Math.max(0, Number(data?.settings?.backgroundOverlayStrength)));
  if (isImage) {
    document.documentElement.style.setProperty("--bg-overlay", `rgba(0, 0, 0, ${strength})`);
    return;
  }
  document.documentElement.style.setProperty("--bg-overlay", "rgba(0, 0, 0, 0)");
}

async function loadBackground() {
  const settings = data.settings;
  elements.background.classList.add("is-loading");

  if (settings.backgroundType === "bing") {
    const info = await getBingWallpaper();
    if (info.dataUrl) {
      setBackground(info.dataUrl);
      if (info.failed) toast("壁纸获取失败，已回退到缓存");
      else if (!info.fromCache) toast("已更新今日 Bing 壁纸");
    } else {
      elements.background.style.background = settings.backgroundColor;
      toast("壁纸获取失败，已使用默认背景");
    }
  } else if (settings.backgroundType === "color") {
    elements.background.style.backgroundImage = "none";
    elements.background.style.background = settings.backgroundColor;
  } else if (settings.backgroundType === "gradient") {
    setBackground(settings.backgroundGradient);
  } else if (settings.backgroundType === "custom") {
    setBackground(settings.backgroundCustom || settings.backgroundColor);
  }

  applyBackgroundOverlay();
  elements.background.classList.remove("is-loading");
}

function pushBackup() {
  if (!data?.settings?.maxBackups) return false;
  const snapshot = createBackupSnapshot(data);
  data.backups.unshift(snapshot);
  if (data.settings.maxBackups > 0 && data.backups.length > data.settings.maxBackups) {
    data.backups = data.backups.slice(0, data.settings.maxBackups);
  }
  skipAutoBackupOnce = true;
  return true;
}

function cloneDataSnapshot(source) {
  return JSON.parse(JSON.stringify(source || {}));
}

function buildBackupFingerprint(source) {
  const input = source || {};
  const groups = (input.groups || [])
    .map((group) => ({
      id: String(group.id || ""),
      name: String(group.name || ""),
      order: Number(group.order) || 0,
      nodes: Array.isArray(group.nodes) ? group.nodes.map((id) => String(id)) : [],
    }))
    .sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  const nodes = Object.keys(input.nodes || {})
    .sort()
    .map((id) => {
      const node = input.nodes[id] || {};
      return {
        id,
        type: String(node.type || ""),
        title: String(node.title || ""),
        url: String(node.url || ""),
        iconType: String(node.iconType || ""),
        color: String(node.color || ""),
        children: Array.isArray(node.children) ? node.children.map((cid) => String(cid)) : [],
      };
    });
  return JSON.stringify({ groups, nodes });
}

function syncBackupBaseline(source = data) {
  backupFingerprint = buildBackupFingerprint(source);
  backupBaselineSnapshot = cloneDataSnapshot(source);
}

function ensureAutoBackupBeforePersist() {
  const currentFingerprint = buildBackupFingerprint(data);
  if (!backupFingerprint) {
    backupFingerprint = currentFingerprint;
    backupBaselineSnapshot = cloneDataSnapshot(data);
    skipAutoBackupOnce = false;
    return false;
  }
  if (!data?.settings?.maxBackups) {
    backupFingerprint = currentFingerprint;
    skipAutoBackupOnce = false;
    return false;
  }
  if (skipAutoBackupOnce) {
    skipAutoBackupOnce = false;
    backupFingerprint = currentFingerprint;
    return false;
  }
  if (currentFingerprint === backupFingerprint) return false;
  if (backupBaselineSnapshot) {
    const snapshot = createBackupSnapshot(backupBaselineSnapshot);
    data.backups.unshift(snapshot);
    if (data.settings.maxBackups > 0 && data.backups.length > data.settings.maxBackups) {
      data.backups = data.backups.slice(0, data.settings.maxBackups);
    }
  } else {
    pushBackup();
    skipAutoBackupOnce = false;
  }
  backupFingerprint = currentFingerprint;
  return true;
}

async function persistData() {
  persistInFlight += 1;
  const autoBackedUp = ensureAutoBackupBeforePersist();
  suppressStorageUntil = Math.max(suppressStorageUntil, Date.now() + STORAGE_SUPPRESS_MS * 4);
  try {
    debugLog("persist_start", {
      useSync: data.settings.syncEnabled,
      groups: data.groups?.length || 0,
      nodes: Object.keys(data.nodes || {}).length,
      lastUpdated: data.lastUpdated || 0,
      autoBackedUp,
    });
    const useSync = data.settings.syncEnabled;
    const changed = dedupeData(data);
    let warning = null;
    let err = null;
    const err1 = await saveData(data, useSync);
    if (err1) {
      if (err1 === "sync_quota_exceeded" || err1.startsWith("local_trimmed_")) {
        warning = err1;
      } else {
        err = err1;
      }
    }
    if (useSync) {
      await saveData(data, false);
    }
    if (changed) {
      const err2 = await saveData(data, useSync);
      if (useSync) await saveData(data, false);
      if (err2) {
        if (err2 === "sync_quota_exceeded" || err2.startsWith("local_trimmed_")) {
          warning = err2;
        } else {
          err = err2;
        }
      }
      debugLog("persist_dedupe", { changed, err2 });
    }
    if (shouldDebugPersist()) {
      const verify = await loadDataFromArea(false);
      debugLog("persist_verify", {
        groups: verify.groups?.length || 0,
        nodes: Object.keys(verify.nodes || {}).length,
        lastUpdated: verify.lastUpdated || 0,
      });
    }
    if (!err) {
      syncBackupBaseline(data);
    }
    debugLog("persist_done", { err1, changed, warning, err, autoBackedUp });
    return { ok: !err, warning, err };
  } finally {
    persistInFlight = Math.max(0, persistInFlight - 1);
  }
}

function getActiveGroup() {
  return data.groups.find((g) => g.id === activeGroupId) || data.groups[0];
}

function getCurrentNodes() {
  if (activeGroupId === RECENT_GROUP_ID) return recentItems;
  const group = getActiveGroup();
  const nodeIds = openFolderId ? data.nodes[openFolderId]?.children || [] : group.nodes;
  return nodeIds.map((id) => data.nodes[id]).filter(Boolean);
}

function uniqueNodes(nodes) {
  const seenId = new Set();
  const out = [];
  for (const node of nodes) {
    if (!node?.id) continue;
    if (seenId.has(node.id)) continue;
    seenId.add(node.id);
    out.push(node);
  }
  return out;
}

function renderGroups() {
  elements.groupTabs.innerHTML = "";
  elements.recentTab.classList.toggle("active", activeGroupId === RECENT_GROUP_ID);
  const recentLabel = elements.recentTab.dataset.label || elements.recentTab.textContent || "最近浏览";
  elements.recentTab.dataset.label = recentLabel;
  elements.recentTab.setAttribute("aria-label", recentLabel);
  elements.recentTab.textContent = data.settings.sidebarCollapsed ? "" : recentLabel;
  elements.recentTab.dataset.short = "历史";
  data.groups
    .sort((a, b) => a.order - b.order)
    .forEach((group, idx) => {
      const btn = document.createElement("button");
      btn.className = `group-tab draggable ${group.id === activeGroupId ? "active" : ""}`;
      btn.dataset.label = group.name;
      btn.setAttribute("aria-label", group.name);
      btn.textContent = data.settings.sidebarCollapsed ? "" : group.name;
      btn.dataset.short = String(idx + 1);
      btn.draggable = true;
      btn.addEventListener("click", () => {
        activeGroupId = group.id;
        openFolderId = null;
        data.settings.lastActiveGroupId = activeGroupId;
        persistData();
        render();
      });
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openGroupContextMenu(e.clientX, e.clientY, group);
      });
      btn.addEventListener("dragstart", () => {
        draggingGroupId = group.id;
        btn.classList.add("dragging");
      });
      btn.addEventListener("dragend", () => {
        draggingGroupId = null;
        btn.classList.remove("dragging");
        qsa(".group-tab", elements.groupTabs).forEach((el) => el.classList.remove("drop-target"));
      });
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        btn.classList.add("drop-target");
      });
      btn.addEventListener("dragleave", () => {
        btn.classList.remove("drop-target");
      });
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        btn.classList.remove("drop-target");
        if (!draggingGroupId || draggingGroupId === group.id) return;
        moveGroupBefore(draggingGroupId, group.id);
      });
      elements.groupTabs.appendChild(btn);
    });
}

async function renderGrid() {
  const seq = ++renderSeq;
  const grid = openFolderId ? elements.folderGrid : elements.grid;
  const nodes = uniqueNodes(getCurrentNodes());
  grid.innerHTML = "";

  const referenceGrid = openFolderId ? elements.grid : grid;
  const width = referenceGrid.getBoundingClientRect().width || referenceGrid.clientWidth || window.innerWidth;
  const density = densityMap[data.settings.gridDensity] || densityMap.standard;
  const gap = density.gap || 16;
  const style = getComputedStyle(referenceGrid);
  const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const available = Math.max(0, width - paddingX);
  const baseSize = data.settings.lastTileSize || density.size || 96;
  let maxColumns = Math.max(1, Math.floor((available + gap) / (baseSize + gap)));
  let columns = maxColumns;
  if (data.settings.fixedLayout) {
    const desired = Math.max(1, data.settings.fixedCols || 8);
    columns = desired;
  }
  let tileSize = baseSize;
  if (data.settings.fixedLayout && available > 0) {
    const fitSize = Math.floor((available - gap * (columns - 1)) / columns);
    tileSize = Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, fitSize));
  } else if (columns <= 1 && available > 0) {
    tileSize = Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, Math.floor(available)));
  } else {
    tileSize = Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, baseSize));
  }
  const iconRatio = density.icon && density.size ? density.icon / density.size : 0.58;
  let iconSize = Math.max(18, Math.round(tileSize * (iconRatio || 0.58)));
  const maxIcon = Math.floor(tileSize * 0.52);
  if (iconSize > maxIcon) iconSize = maxIcon;
  if (!openFolderId) {
    lastMainLayout = { columns, tileSize, iconSize };
  } else if (lastMainLayout) {
    columns = lastMainLayout.columns;
    tileSize = lastMainLayout.tileSize;
    const iconRatioOverride = density.icon && density.size ? density.icon / density.size : 0.58;
    iconSize = Math.max(18, Math.round(tileSize * iconRatioOverride));
  }
  grid.style.setProperty("--tile-size", `${tileSize}px`);
  grid.style.setProperty("--tile-icon", `${iconSize}px`);
  const tightLayout = columns >= 8;
  const mediumLayout = columns >= 6;
  const tilePad = tightLayout ? "4px 4px 6px" : mediumLayout ? "6px 6px 8px" : "8px 8px 10px";
  const tileGap = tightLayout ? "2px" : mediumLayout ? "3px" : "4px";
  grid.style.setProperty("--tile-pad", tilePad);
  grid.style.setProperty("--tile-gap", tileGap);
  grid.style.gridTemplateColumns = `repeat(${columns}, minmax(${tileSize}px, 1fr))`;

  for (const [idx, node] of nodes.entries()) {
    if (seq !== renderSeq) return;
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.id = node.id;
    tile.dataset.index = idx;
    tile.draggable = true;
    tile.tabIndex = 0;

    const icon = document.createElement("div");
    icon.className = "tile-icon";
    const img = document.createElement("img");
    img.alt = node.title || node.url || "";
    const iconSrc = await resolveIcon(node, data.settings);
    img.src = iconSrc;
    if (node.url && data.settings.iconFetch && !iconSrc.startsWith("data:")) {
      const candidates = getFaviconCandidates(node.url);
      if (candidates.length) {
        let idx = Math.max(0, candidates.indexOf(iconSrc));
        img.onerror = () => {
          idx += 1;
          if (idx < candidates.length) img.src = candidates[idx];
        };
      }
    }
    if (seq !== renderSeq) return;
    icon.appendChild(img);

    const title = document.createElement("div");
    title.className = "tile-title";
    title.textContent = node.title || node.url || "未命名";

    tile.appendChild(icon);
    tile.appendChild(title);

    if (node.type === "folder") {
      const badge = document.createElement("div");
      badge.className = "tile-badge";
      badge.textContent = `${node.children?.length || 0}`;
      tile.appendChild(badge);
    }

    if (selectedIds.has(node.id)) {
      tile.classList.add("selected");
    }

    tile.addEventListener("click", (e) => {
      if (selectionMode) {
        toggleSelect(node.id, idx, e.shiftKey);
        return;
      }
      if (node.type === "folder") {
        openFolder(node.id);
      } else {
        const url = normalizeUrl(node.url);
        if (!url) {
          toast("URL 无效");
          return;
        }
        openUrl(url);
      }
    });

    tile.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, node);
    });

    tile.addEventListener("mouseenter", (e) => {
      if (!data.settings.tooltipEnabled) return;
      clearTimeout(tooltipTimer);
      const text = node.type === "folder" ? `${node.title}（文件夹）` : `${node.title}\n${node.url}`;
      tooltipTimer = setTimeout(() => showTooltip(text, e.clientX, e.clientY), TOOLTIP_DELAY_MS);
    });
    tile.addEventListener("mouseleave", () => {
      clearTimeout(tooltipTimer);
      hideTooltip();
    });

    tile.addEventListener("dragstart", (e) => {
      dragState = { id: node.id, fromFolder: openFolderId };
      e.dataTransfer.effectAllowed = "move";
    });
    tile.addEventListener("dragend", () => {
      dragState = null;
    });
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleDropOnTile(node.id, e.clientX, e.clientY);
      dragState = null;
    });

    grid.appendChild(tile);
  }

  updateEmptyState();
}

function updateEmptyState() {
  if (activeGroupId === RECENT_GROUP_ID) {
    elements.emptyState.classList.add("hidden");
    return;
  }
  const nodes = getCurrentNodes();
  if (nodes.length === 0 && !data.settings.emptyHintDisabled) {
    elements.emptyState.classList.remove("hidden");
  } else {
    elements.emptyState.classList.add("hidden");
  }
}

function openFolder(folderId) {
  openFolderId = folderId;
  elements.folderOverlay.classList.remove("hidden");
  elements.folderOverlay.setAttribute("aria-hidden", "false");
  elements.folderTitle.textContent = data.nodes[folderId]?.title || "文件夹";
  render();
}

function closeFolder() {
  openFolderId = null;
  elements.folderOverlay.classList.add("hidden");
  elements.folderOverlay.setAttribute("aria-hidden", "true");
  render();
}

function toggleSelect(id, index, range) {
  const nodes = getCurrentNodes();
  if (range && lastSelectedIndex !== null) {
    const start = Math.min(lastSelectedIndex, index);
    const end = Math.max(lastSelectedIndex, index);
    for (let i = start; i <= end; i++) {
      if (nodes[i]) selectedIds.add(nodes[i].id);
    }
  } else {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    lastSelectedIndex = index;
  }
  if (lastSelectedIndex === null && typeof index === "number") {
    lastSelectedIndex = index;
  }
  updateSelectionStyles();
}

function clearSelection() {
  selectedIds.clear();
  selectionMode = false;
  lastSelectedIndex = null;
  if (selectionBox) {
    selectionBox.remove();
    selectionBox = null;
  }
}

function updateSelectionControls() {
  elements.btnSelectAll.classList.toggle("hidden", !selectionMode);
  elements.btnBatchDelete.textContent = selectionMode ? "删除" : "批量删";
  elements.btnFolderBatchDelete.textContent = selectionMode ? "删除" : "批量删";
}

function updateSelectionStyles() {
  const grid = openFolderId ? elements.folderGrid : elements.grid;
  qsa(".tile", grid).forEach((tile) => {
    tile.classList.toggle("selected", selectedIds.has(tile.dataset.id));
  });
}

function showContextMenuAt(x, y) {
  const menu = elements.contextMenu;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const edgeGap = 8;

  menu.classList.remove("hidden");
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(edgeGap, viewportWidth - rect.width - edgeGap);
  const maxTop = Math.max(edgeGap, viewportHeight - rect.height - edgeGap);
  const nextLeft = Math.min(Math.max(Number(x) || 0, edgeGap), maxLeft);
  const nextTop = Math.min(Math.max(Number(y) || 0, edgeGap), maxTop);

  menu.style.left = `${nextLeft}px`;
  menu.style.top = `${nextTop}px`;
  menu.style.visibility = "";
}

function openContextMenu(x, y, node) {
  elements.contextMenu.innerHTML = "";
  const actions = [];
  if (activeGroupId === RECENT_GROUP_ID && node.type === "history") {
    actions.push({ label: "本页打开", fn: () => openUrl(normalizeUrl(node.url)) });
    actions.push({ label: "新页打开", fn: () => openUrl(normalizeUrl(node.url), "new") });
    actions.push({ label: "添加到快捷", fn: () => openAddHistoryToGroup(node) });
  } else if (node.type !== "folder") {
    actions.push({ label: "本页打开", fn: () => openUrl(normalizeUrl(node.url)) });
    actions.push({ label: "新页打开", fn: () => openUrl(normalizeUrl(node.url), "new") });
    actions.push({ label: "后台打开", fn: () => openUrl(normalizeUrl(node.url), "background") });
  } else {
    actions.push({ label: "打开文件夹", fn: () => openFolder(node.id) });
    actions.push({ label: "解散文件夹", fn: () => dissolveFolder(node.id) });
  }
  if (node.type !== "history") {
    actions.push({ label: "编辑", fn: () => openEditModal(node) });
    actions.push({ label: "删除", fn: () => deleteNodes([node.id]) });
  }

  for (const action of actions) {
    const btn = document.createElement("button");
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.fn();
      elements.contextMenu.classList.add("hidden");
    });
    elements.contextMenu.appendChild(btn);
  }
  showContextMenuAt(x, y);
}

function closeContextMenu() {
  elements.contextMenu.classList.add("hidden");
}

function openGroupContextMenu(x, y, group) {
  elements.contextMenu.innerHTML = "";
  const actions = [
    { label: "重命名", fn: () => renameGroup(group) },
    { label: "删除分组", fn: () => deleteGroup(group) },
  ];
  for (const action of actions) {
    const btn = document.createElement("button");
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.fn();
      elements.contextMenu.classList.add("hidden");
    });
    elements.contextMenu.appendChild(btn);
  }
  showContextMenuAt(x, y);
}

function getCurrentGridElement() {
  return openFolderId ? elements.folderGrid : elements.grid;
}

function getTileElementById(targetId) {
  const grid = getCurrentGridElement();
  return qsa(".tile", grid).find((tile) => tile.dataset.id === targetId) || null;
}

function isDropOnIcon(targetId, x, y) {
  const tile = getTileElementById(targetId);
  if (!tile) return false;
  const icon = qs(".tile-icon", tile);
  if (!icon) return false;
  const rect = icon.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function getInsertIndexFromTarget(list, sourceId, targetId, x, y) {
  const targetIndex = list.indexOf(targetId);
  if (targetIndex < 0) return list.length;
  const tile = getTileElementById(targetId);
  if (!tile) return targetIndex;

  const rect = tile.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  // 非图标区域拖放仅按左右半区判断前后，避免误判到行首/左侧。
  const insertAfter = x >= centerX;
  let insertIndex = targetIndex + (insertAfter ? 1 : 0);
  return Math.max(0, Math.min(insertIndex, list.length));
}

function handleDropOnTile(targetId, x, y) {
  if (!dragState || dragState.id === targetId) return;
  if (activeGroupId === RECENT_GROUP_ID) return;
  const sourceId = dragState.id;
  const targetNode = data.nodes[targetId];
  const sourceNode = data.nodes[sourceId];
  if (!targetNode || !sourceNode) return;

  const inFolder = !!openFolderId;
  const container = inFolder ? data.nodes[openFolderId] : getActiveGroup();
  const list = inFolder ? container.children || [] : container.nodes;
  const droppedOnIcon = isDropOnIcon(targetId, x, y);

  if (!droppedOnIcon) {
    const insertIndex = getInsertIndexFromTarget(list, sourceId, targetId, x, y);
    const next = moveNodeInList(list, sourceId, insertIndex);
    if (next === list) return;
    pushBackup();
    if (inFolder) {
      container.children = next;
    } else {
      container.nodes = next;
    }
    persistData();
    render();
    return;
  }

  if (targetNode.type !== "folder") {
    pushBackup();
    const targetIndex = list.indexOf(targetId);
    const sourceIndex = list.indexOf(sourceId);
    let insertIndex = targetIndex >= 0 ? targetIndex : list.length;
    if (sourceIndex >= 0 && sourceIndex < insertIndex) insertIndex -= 1;

    removeNodeFromLocation(sourceId);
    removeNodeFromLocation(targetId);

    const folderId = `fld_${Date.now()}`;
    const folder = {
      id: folderId,
      type: "folder",
      title: "新建文件夹",
      children: [targetId, sourceId],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    data.nodes[folderId] = folder;

    if (inFolder) {
      const next = (container.children || []).filter((nid) => nid !== sourceId && nid !== targetId);
      next.splice(Math.max(0, Math.min(insertIndex, next.length)), 0, folderId);
      container.children = next;
    } else {
      const next = container.nodes.filter((nid) => nid !== sourceId && nid !== targetId);
      next.splice(Math.max(0, Math.min(insertIndex, next.length)), 0, folderId);
      container.nodes = next;
    }
    persistData();
    render();
    toast("已创建文件夹");
    return;
  }

  pushBackup();
  removeNodeFromLocation(sourceId);
  targetNode.children = targetNode.children || [];
  targetNode.children.push(sourceId);
  persistData();
  render();
  toast("已加入文件夹");
}

function dissolveFolder(folderId) {
  const folder = data.nodes[folderId];
  if (!folder || folder.type !== "folder") return;
  pushBackup();
  removeNodeFromLocation(folderId);
  const group = getActiveGroup();
  group.nodes.push(...(folder.children || []));
  delete data.nodes[folderId];
  persistData();
  render();
  toast("已解散文件夹");
}

function removeNodeFromLocation(id) {
  for (const group of data.groups) {
    group.nodes = group.nodes.filter((nid) => nid !== id);
  }
  for (const node of Object.values(data.nodes)) {
    if (node.type === "folder" && Array.isArray(node.children)) {
      node.children = node.children.filter((nid) => nid !== id);
    }
  }
}


function moveNodeInList(list, id, index) {
  const currentIndex = list.indexOf(id);
  if (currentIndex < 0) return list;
  const safeIndex = Math.max(0, Math.min(index, list.length));
  let targetIndex = safeIndex;
  if (targetIndex > currentIndex) targetIndex -= 1;
  if (targetIndex === currentIndex) return list;
  const next = list.slice();
  next.splice(currentIndex, 1);
  next.splice(targetIndex, 0, id);
  return next;
}

function dedupeData(input) {
  let changed = false;
  input.nodes = { ...(input.nodes || {}) };

  for (const group of input.groups || []) {
    const uniq = [];
    const set = new Set();
    for (const id of group.nodes || []) {
      if (!input.nodes[id]) {
        changed = true;
        continue;
      }
      if (set.has(id)) {
        changed = true;
        continue;
      }
      set.add(id);
      uniq.push(id);
    }
    group.nodes = uniq;
  }

  for (const node of Object.values(input.nodes)) {
    if (node.type === "folder" && Array.isArray(node.children)) {
      const uniq = [];
      const set = new Set();
      for (const id of node.children) {
        if (!input.nodes[id]) {
          changed = true;
          continue;
        }
        if (set.has(id)) {
          changed = true;
          continue;
        }
        set.add(id);
        uniq.push(id);
      }
      node.children = uniq;
    }
  }

  return changed;
}

function moveGroupBefore(sourceId, targetId) {
  const targetIndex = data.groups
    .sort((a, b) => a.order - b.order)
    .map((g) => g.id)
    .indexOf(targetId);
  moveGroupToIndex(sourceId, targetIndex);
}

function moveGroupToIndex(sourceId, index) {
  const ordered = data.groups.sort((a, b) => a.order - b.order).map((g) => g.id);
  const ids = ordered.filter((id) => id !== sourceId);
  const safeIndex = Math.max(0, Math.min(index, ids.length));
  ids.splice(safeIndex, 0, sourceId);
  ids.forEach((id, idx) => {
    const group = data.groups.find((g) => g.id === id);
    if (group) group.order = idx;
  });
  persistData();
  render();
}

function renameGroup(group) {
  const name = prompt("分组名称", group.name);
  if (!name) return;
  group.name = name.trim();
  persistData();
  render();
}

function deleteGroup(group) {
  if (data.groups.length <= 1) {
    toast("至少保留一个分组");
    return;
  }
  if (!confirm(`删除分组「${group.name}」？`)) return;
  data.groups = data.groups.filter((g) => g.id !== group.id);
  if (activeGroupId === group.id) activeGroupId = data.groups[0].id;
  persistData();
  render();
}

function deleteNodes(ids) {
  if (!ids.length) return;
  if (activeGroupId === RECENT_GROUP_ID) return;
  pushBackup();
  const snapshot = JSON.parse(JSON.stringify(data));

  ids.forEach((id) => {
    removeNodeFromLocation(id);
    delete data.nodes[id];
  });

  pendingDeletion = { snapshot, ids };
  persistData();
  render();

  toast(`已删除 ${ids.length} 个快捷按钮`, "撤销", () => undoDelete());
  setTimeout(() => {
    pendingDeletion = null;
  }, UNDO_TIMEOUT_MS);
}

function undoDelete() {
  if (!pendingDeletion) return;
  data = pendingDeletion.snapshot;
  pendingDeletion = null;
  persistData();
  render();
  toast("已恢复");
}

/**
 * 安全地设置元素的文本内容，防止 XSS
 * @param {HTMLElement} el
 * @param {string} text
 */
function safeSetText(el, text) {
  el.textContent = text;
}

/**
 * 安全地设置元素属性，防止 XSS
 * @param {HTMLElement} el
 * @param {string} attr
 * @param {string} value
 */
function safeSetAttr(el, attr, value) {
  el.setAttribute(attr, value);
}

/**
 * 创建带标签和输入框的表单项
 * @param {string} labelText
 * @param {HTMLElement} inputEl
 * @returns {HTMLElement}
 */
function createFormSection(labelText, inputEl) {
  const section = document.createElement("div");
  section.className = "section";
  const label = document.createElement("label");
  label.textContent = labelText;
  section.appendChild(label);
  section.appendChild(inputEl);
  return section;
}

function openModal(html) {
  elements.modal.innerHTML = html;
  elements.modalOverlay.classList.remove("hidden");
  elements.modalOverlay.setAttribute("aria-hidden", "false");
}

function closeModal() {
  elements.modalOverlay.classList.add("hidden");
  elements.modalOverlay.setAttribute("aria-hidden", "true");
  elements.modal.innerHTML = "";
  settingsOpen = false;
  settingsSaving = false;
  settingsSaveQueued = false;
  settingsSaveNow = null;
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  if (pendingStorageReload) {
    pendingStorageReload = false;
    scheduleStorageReload();
  }
}

function openAddModal() {
  const html = `
    <h2>新增快捷按钮</h2>
    <div class="section">
      <label>网址</label>
      <input id="fieldUrl" type="url" placeholder="https://" />
    </div>
    <div class="section">
      <label>标题</label>
      <input id="fieldTitle" type="text" placeholder="可选" />
    </div>
    <div class="section">
      <label>图标来源</label>
      <select id="fieldIconType">
        <option value="auto">自动抓取 favicon</option>
        <option value="upload">上传图标</option>
        <option value="color">颜色头像</option>
        <option value="remote">远程图标 URL</option>
      </select>
    </div>
    <div id="iconExtra" class="section"></div>
    <div class="section">
      <button id="btnFromTab" class="icon-btn">从当前标签页添加</button>
    </div>
    <div class="actions">
      <button id="btnCancel" class="icon-btn">取消</button>
      <button id="btnSave" class="icon-btn">保存</button>
    </div>
  `;
  openModal(html);

  const iconTypeEl = $("fieldIconType");
  const iconExtra = $("iconExtra");

  function renderIconExtra(type) {
    iconExtra.innerHTML = "";
    if (type === "upload") {
      const label = document.createElement("label");
      label.textContent = "上传图标";
      const input = document.createElement("input");
      input.id = "fieldUpload";
      input.type = "file";
      input.accept = "image/*";
      iconExtra.appendChild(label);
      iconExtra.appendChild(input);
    } else if (type === "color") {
      const label = document.createElement("label");
      label.textContent = "头像颜色";
      const input = document.createElement("input");
      input.id = "fieldColor";
      input.type = "color";
      input.value = "#4dd6a8";
      iconExtra.appendChild(label);
      iconExtra.appendChild(input);
    } else if (type === "remote") {
      const label = document.createElement("label");
      label.textContent = "远程图标 URL";
      const input = document.createElement("input");
      input.id = "fieldRemote";
      input.type = "url";
      input.placeholder = "https://";
      iconExtra.appendChild(label);
      iconExtra.appendChild(input);
    }
  }

  renderIconExtra(iconTypeEl.value);
  iconTypeEl.addEventListener("change", () => renderIconExtra(iconTypeEl.value));
  const urlInput = $("fieldUrl");
  if (urlInput) {
    urlInput.focus();
    if (urlInput.select) urlInput.select();
  }

  $("btnFromTab").addEventListener("click", async () => {
    const api = getChromeApi();
    if (!api?.tabs) return;
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab) return;
      $("fieldUrl").value = tab.url || "";
      $("fieldTitle").value = tab.title || "";
    });
  });

  $("btnCancel").addEventListener("click", closeModal);
  $("btnSave").addEventListener("click", async () => {
    const snapshot = JSON.parse(JSON.stringify(data));
    const url = normalizeUrl($("fieldUrl").value.trim());
    if (!url) {
      toast("URL 不合法");
      return;
    }
    let title = $("fieldTitle").value.trim();
    const titlePending = !title;
    if (!title) title = new URL(url).hostname;
    let iconType = iconTypeEl.value;
    let iconData = "";
    let color = "";

    if (iconType === "upload") {
      const file = $("fieldUpload")?.files?.[0];
      if (file) {
        iconData = await readFileAsDataUrl(file);
      }
    } else if (iconType === "color") {
      color = $("fieldColor").value;
    } else if (iconType === "remote") {
      iconData = $("fieldRemote").value.trim();
    }

    const iconPending = iconType === "auto";
    if (iconType === "auto") {
      iconType = "letter";
    }

    pushBackup();
    const id = `itm_${Date.now()}`;
    data.nodes[id] = {
      id,
      type: "item",
      title,
      url,
      iconType,
      iconData,
      color,
      titlePending,
      iconPending,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (openFolderId) {
      data.nodes[openFolderId].children.push(id);
    } else {
      const targetGroup = getActiveGroup();
      targetGroup.nodes.push(id);
      if (activeGroupId === RECENT_GROUP_ID) {
        activeGroupId = targetGroup.id;
      }
    }
    data.settings.lastActiveGroupId = getActiveGroup().id;
    debugLog("add_item", {
      id,
      url,
      groupId: openFolderId ? openFolderId : getActiveGroup().id,
      openFolderId: openFolderId || "",
    });
    const result = await persistData();
    if (!result.ok) {
      data = snapshot;
      render();
      toast("保存失败：本地存储空间不足");
      return;
    }
    render();
    closeModal();
    if (titlePending) fetchTitleInBackground(id, url);
    if (iconPending) fetchFaviconInBackground(id, url);
    if (result.warning === "local_trimmed_backups") {
      toast("新增成功（已清理备份以释放空间）");
    } else if (result.warning === "local_trimmed_icons") {
      toast("新增成功（已重置上传图标以释放空间）");
    } else if (result.warning === "local_trimmed_background") {
      toast("新增成功（已清理自定义背景以释放空间）");
    } else if (result.warning === "sync_quota_exceeded") {
      toast("新增成功（同步空间不足，已保存到本地）");
    } else {
      toast("新增成功");
    }
  });
}

function openEditModal(node) {
  const html = `
    <h2>编辑</h2>
    <div class="section">
      <label>标题</label>
      <input id="fieldTitle" type="text" value="${node.title || ""}" />
    </div>
    ${node.type === "item" ? `
    <div class="section">
      <label>网址</label>
      <input id="fieldUrl" type="url" value="${node.url || ""}" />
    </div>
    <div class="section">
      <label>图标来源</label>
      <select id="fieldIconType">
        <option value="auto">自动抓取 favicon</option>
        <option value="upload">上传图标</option>
        <option value="color">颜色头像</option>
        <option value="remote">远程图标 URL</option>
      </select>
    </div>
    <div id="iconExtra" class="section"></div>
    ` : ""}
    <div class="actions">
      <button id="btnCancel" class="icon-btn">取消</button>
      <button id="btnSave" class="icon-btn">保存</button>
    </div>
  `;
  openModal(html);

  if (node.type === "item") {
    const iconTypeEl = $("fieldIconType");
    iconTypeEl.value = node.iconType === "letter" ? "auto" : (node.iconType || "auto");
    const iconExtra = $("iconExtra");
    function renderIconExtra(type) {
      iconExtra.innerHTML = "";
      if (type === "upload") {
        const label = document.createElement("label");
        label.textContent = "上传图标";
        const input = document.createElement("input");
        input.id = "fieldUpload";
        input.type = "file";
        input.accept = "image/*";
        iconExtra.appendChild(label);
        iconExtra.appendChild(input);
      } else if (type === "color") {
        const label = document.createElement("label");
        label.textContent = "头像颜色";
        const input = document.createElement("input");
        input.id = "fieldColor";
        input.type = "color";
        input.value = node.color || "#4dd6a8";
        iconExtra.appendChild(label);
        iconExtra.appendChild(input);
      } else if (type === "remote") {
        const label = document.createElement("label");
        label.textContent = "远程图标 URL";
        const input = document.createElement("input");
        input.id = "fieldRemote";
        input.type = "url";
        input.value = node.iconData || "";
        iconExtra.appendChild(label);
        iconExtra.appendChild(input);
      }
    }
    renderIconExtra(iconTypeEl.value);
    iconTypeEl.addEventListener("change", () => renderIconExtra(iconTypeEl.value));
  }

  $("btnCancel").addEventListener("click", closeModal);
  $("btnSave").addEventListener("click", async () => {
    const snapshot = JSON.parse(JSON.stringify(data));
    pushBackup();
    node.title = $("fieldTitle").value.trim() || node.title;
    if (node.type === "item") {
      const url = normalizeUrl($("fieldUrl").value.trim());
      if (!url) {
        toast("URL 不合法");
        return;
      }
      node.url = url;
      const iconType = $("fieldIconType").value;
      node.iconType = iconType;
      if (iconType === "upload") {
        const file = $("fieldUpload")?.files?.[0];
        if (file) node.iconData = await readFileAsDataUrl(file);
      } else if (iconType === "color") {
        node.color = $("fieldColor").value;
        node.iconData = "";
      } else if (iconType === "remote") {
        node.iconData = $("fieldRemote").value.trim();
      } else {
        node.iconData = "";
      }
    }
    node.updatedAt = Date.now();
    const result = await persistData();
    if (!result.ok) {
      data = snapshot;
      render();
      toast("保存失败：本地存储空间不足");
      return;
    }
    render();
    closeModal();
    if (result.warning === "local_trimmed_backups") {
      toast("保存成功（已清理备份以释放空间）");
    } else if (result.warning === "local_trimmed_icons") {
      toast("保存成功（已重置上传图标以释放空间）");
    } else if (result.warning === "local_trimmed_background") {
      toast("保存成功（已清理自定义背景以释放空间）");
    } else if (result.warning === "sync_quota_exceeded") {
      toast("保存成功（同步空间不足，已保存到本地）");
    } else {
      toast("保存成功");
    }
  });
}

async function openOpenModeMenu() {
  const modes = [
    { id: "current", label: "本页打开" },
    { id: "new", label: "新页打开" },
    { id: "background", label: "在后台打开" },
  ];
  const idx = modes.findIndex((m) => m.id === data.settings.openMode);
  const next = modes[(idx + 1) % modes.length];
  const prevMode = data.settings.openMode;
  data.settings.openMode = next.id;
  updateOpenModeButton();
  toast(`${next.label}`);
  const result = await persistData();
  if (!result?.ok) {
    data.settings.openMode = prevMode;
    updateOpenModeButton();
    toast("打开方式保存失败，已恢复");
  }
}

function openSettingsModal() {
  settingsOpen = true;
  const html = `
    <h2>设置</h2>
    <div class="section">
      <label><input id="settingShowSearch" type="checkbox"> 显示顶部搜索框</label>
      <div class="row-inline">
        <span class="inline-label">默认搜索引擎</span>
        <select id="settingSearchEnginePreset" class="inline-select">
          <option value="https://www.google.com/search?q=">Google</option>
          <option value="https://www.baidu.com/s?wd=">百度</option>
          <option value="https://www.bing.com/search?q=">Bing</option>
          <option value="https://www.so.com/s?q=">360</option>
          <option value="https://www.yandex.com/search/?text=">Yandex</option>
          <option value="custom">自定义</option>
        </select>
      </div>
      <input id="settingSearchEngine" type="text" placeholder="https://www.bing.com/search?q=" class="inline-text" />
    </div>


    <div class="section">
      <div class="row-inline">
        <label><input id="settingFixedLayout" type="checkbox"> 固定列数</label>
        <div class="inline-field">
          <input id="settingCols" type="number" min="1" />
        </div>
      </div>
      <div class="row-inline">
        <span class="inline-label">卡片间隙</span>
        <label><input type="radio" name="density" value="compact" /> 紧凑</label>
        <label><input type="radio" name="density" value="standard" /> 标准</label>
        <label><input type="radio" name="density" value="spacious" /> 宽松</label>
      </div>
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">背景</span>
        <select id="settingBgType" class="inline-select">
          <option value="bing">每日 Bing</option>
          <option value="color">纯色</option>
          <option value="gradient">渐变</option>
          <option value="custom">自定义图片</option>
        </select>
      </div>
      <div id="bgColorWrap">
        
        <input id="settingBgColor" type="color" />
      </div>
      <div id="bgGradientWrap">
        <label>渐变颜色</label>
        <div class="row">
          <input id="settingBgGradientA" type="color" />
          <input id="settingBgGradientB" type="color" />
        </div>
      </div>
      <input id="settingBgGradient" type="hidden" />
      <input id="settingBgFile" type="file" accept="image/*" />
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">背景遮罩</span>
        <input id="settingBgOverlay" type="range" min="0" max="0.6" step="0.01" class="inline-range" />
        <span id="settingBgOverlayValue" class="inline-value"></span>
      </div>
    </div>

    <div class="section">
      <label data-tooltip="开启后，鼠标悬停在快捷按钮上会显示标题和网址"><input id="settingTooltip" type="checkbox"> 显示提示</label>
      <label data-tooltip="开启后，可使用键盘进行导航与操作（如方向键移动、回车打开）"><input id="settingKeyboard" type="checkbox"> 启用键盘导航</label>
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">主题颜色</span>
        <select id="settingTheme" class="inline-select">
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">字体大小</span>
        <input id="settingFontSize" type="number" min="10" max="24" class="inline-number" />
      </div>
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">默认保存分组</span>
        <select id="settingDefaultGroupMode" class="inline-select">
          <option value="last">上次添加的分组</option>
          <option value="fixed">固定分组</option>
        </select>
        <select id="settingDefaultGroupId" class="inline-select"></select>
      </div>
    </div>

    <div class="section">
      <label><input id="settingSidebarCollapsed" type="checkbox"> 隐藏左侧分组</label>
    </div>

    <div class="section">
      <label><input id="settingSync" type="checkbox"> 启用同步</label>
      <div class="row-inline">
        <span class="inline-label">最大备份数量（0 表示不备份）</span>
        <input id="settingBackup" type="number" min="0" class="inline-number" />
      </div>
      <div class="row-inline">
        <span class="inline-label">重新获取失败图标（每天）</span>
        <select id="settingIconRetryHour" class="inline-select">
          <option value="">不启用</option>
          <option value="0">00:00</option>
          <option value="1">01:00</option>
          <option value="2">02:00</option>
          <option value="3">03:00</option>
          <option value="4">04:00</option>
          <option value="5">05:00</option>
          <option value="6">06:00</option>
          <option value="7">07:00</option>
          <option value="8">08:00</option>
          <option value="9">09:00</option>
          <option value="10">10:00</option>
          <option value="11">11:00</option>
          <option value="12">12:00</option>
          <option value="13">13:00</option>
          <option value="14">14:00</option>
          <option value="15">15:00</option>
          <option value="16">16:00</option>
          <option value="17">17:00</option>
          <option value="18">18:00</option>
          <option value="19">19:00</option>
          <option value="20">20:00</option>
          <option value="21">21:00</option>
          <option value="22">22:00</option>
          <option value="23">23:00</option>
        </select>
      </div>
    </div>

    <div class="section">
      <button id="btnExport" class="icon-btn">导出设置</button>
      <button id="btnImport" class="icon-btn">导入设置</button>
      <button id="btnImportUrl" class="icon-btn">导入网址</button>
      <button id="btnBackupManage" class="icon-btn">备份管理</button>
      <button id="btnClearData" class="icon-btn danger strong-label">清空数据</button>
      <button id="btnClearCards" class="icon-btn danger">删除所有分组、卡片</button>
      <button id="btnRefreshIcons" class="icon-btn">刷新所有图标</button>
    </div>

  `;
  openModal(html);

  $("settingShowSearch").checked = data.settings.showSearch;
  $("settingSearchEngine").value = data.settings.searchEngineUrl;
  const presets = {
    "https://www.google.com/search?q=": "https://www.google.com/search?q=",
    "https://www.baidu.com/s?wd=": "https://www.baidu.com/s?wd=",
    "https://www.bing.com/search?q=": "https://www.bing.com/search?q=",
    "https://www.so.com/s?q=": "https://www.so.com/s?q=",
    "https://www.yandex.com/search/?text=": "https://www.yandex.com/search/?text=",
  };
  const presetValue = presets[data.settings.searchEngineUrl] || "custom";
  $("settingSearchEnginePreset").value = presetValue;
  $("settingSearchEngine").disabled = presetValue !== "custom";
  $("settingFixedLayout").checked = data.settings.fixedLayout;
  $("settingCols").value = data.settings.fixedCols;
  const densityRadios = qsa("input[name='density']", elements.modal);
  densityRadios.forEach((radio) => {
    radio.checked = radio.value === data.settings.gridDensity;
  });
  $("settingBgType").value = data.settings.backgroundType;
  $("settingBgColor").value = data.settings.backgroundColor;
  $("settingBgGradient").value = data.settings.backgroundGradient;
  const match = /linear-gradient\\([^,]+,\\s*([^,]+),\\s*([^\\)]+)\\)/.exec(data.settings.backgroundGradient || "");
  const gA = data.settings.backgroundGradientA || match?.[1]?.trim() || "#1d2a3b";
  const gB = data.settings.backgroundGradientB || match?.[2]?.trim() || "#0b0f14";
  $("settingBgGradientA").value = gA;
  $("settingBgGradientB").value = gB;
  $("settingBgOverlay").value = Number(data.settings.backgroundOverlayStrength ?? 0.08);
  $("settingBgOverlayValue").textContent = `${Math.round(Number($("settingBgOverlay").value) * 100)}%`;
  $("settingTooltip").checked = data.settings.tooltipEnabled;
  $("settingKeyboard").checked = data.settings.keyboardNav;
  $("settingTheme").value = data.settings.theme || "system";
  $("settingFontSize").value = data.settings.fontSize || 13;
  $("settingSync").checked = data.settings.syncEnabled;
  $("settingBackup").value = data.settings.maxBackups;
  const retryHour = data.settings.iconRetryHour ?? (data.settings.iconRetryAtSix ? 18 : "");
  $("settingIconRetryHour").value = retryHour === "" ? "" : String(retryHour);
  $("settingSidebarCollapsed").checked = data.settings.sidebarHidden;
  $("settingSidebarCollapsed").addEventListener("change", (e) => {
    data.settings.sidebarHidden = e.target.checked;
    applySidebarState();
  });

  const defaultGroupMode = $("settingDefaultGroupMode");
  const defaultGroupId = $("settingDefaultGroupId");
  defaultGroupMode.value = data.settings.defaultGroupMode || "last";
  defaultGroupId.innerHTML = "";
  data.groups
    .sort((a, b) => a.order - b.order)
    .forEach((g) => {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.name;
      defaultGroupId.appendChild(opt);
    });
  if (data.settings.defaultGroupId) defaultGroupId.value = data.settings.defaultGroupId;
  const updateDefaultGroupControls = () => {
    const isFixed = defaultGroupMode.value === "fixed";
    defaultGroupId.classList.toggle("hidden", !isFixed);
    defaultGroupId.disabled = !isFixed;
  };
  defaultGroupMode.addEventListener("change", updateDefaultGroupControls);
  updateDefaultGroupControls();

  $("settingSearchEnginePreset").addEventListener("change", (e) => {
    const val = e.target.value;
    if (val === "custom") {
      $("settingSearchEngine").disabled = false;
      $("settingSearchEngine").focus();
    } else {
      $("settingSearchEngine").value = val;
      $("settingSearchEngine").disabled = true;
    }
  });

  $("btnExport").addEventListener("click", () => exportJsonToClipboard());
  $("btnImport").addEventListener("click", () => openImportModal());
  $("btnImportUrl").addEventListener("click", () => openImportUrlModal());
  $("btnBackupManage").addEventListener("click", () => openBackupModal());
  $("btnClearData").addEventListener("click", async () => {
    if (!confirm("确认清空全部数据？")) return;
    data = defaultData();
    activeGroupId = data.groups[0].id;
    await clearData(data.settings.syncEnabled);
    await persistData();
    closeModal();
    render();
    toast("已清空");
  });
  $("btnClearCards").addEventListener("click", async () => {
    if (!confirm("确认删除所有分组、卡片与卡片？（设置将保留）")) return;
    pushBackup();
    const preservedSettings = JSON.parse(JSON.stringify(data.settings || {}));
    const groupId = `grp_${Date.now()}`;
    data.nodes = {};
    data.groups = [{ id: groupId, name: "默认", order: 0, nodes: [] }];
    data.settings = preservedSettings;
    activeGroupId = groupId;
    await persistData();
    closeModal();
    render();
    toast("已删除所有分组、卡片与卡片，可在【备份管理】中恢复");
  });
  $("btnRefreshIcons").addEventListener("click", async () => {
    await refreshAllIcons(Object.values(data.nodes));
    toast("图标刷新完成");
  });

  const saveSettings = async ({ close = false, toastOnSave = false } = {}) => {
    if (settingsSaving) {
      settingsSaveQueued = true;
      return;
    }
    settingsSaving = true;
    qsa(".group-name", elements.modal).forEach((input) => {
      const row = input.closest("[data-group]");
      const id = row.dataset.group;
      const group = data.groups.find((g) => g.id === id);
      if (group) group.name = input.value.trim() || group.name;
    });

    data.settings.showSearch = $("settingShowSearch").checked;
    data.settings.enableSearchEngine = true;
    data.settings.searchEngineUrl = $("settingSearchEngine").value.trim() || data.settings.searchEngineUrl;
    data.settings.fixedLayout = $("settingFixedLayout").checked;
    data.settings.fixedCols = Number($("settingCols").value) || 8;
    const selectedDensity = qsa("input[name='density']", elements.modal).find((r) => r.checked);
    data.settings.gridDensity = selectedDensity ? selectedDensity.value : data.settings.gridDensity;
    data.settings.backgroundType = $("settingBgType").value;
    data.settings.backgroundColor = $("settingBgColor").value;
    const gA = $("settingBgGradientA").value || "#1d2a3b";
    const gB = $("settingBgGradientB").value || "#0b0f14";
    data.settings.backgroundGradientA = gA;
    data.settings.backgroundGradientB = gB;
    data.settings.backgroundGradient = `linear-gradient(120deg, ${gA}, ${gB})`;
    data.settings.backgroundOverlayStrength = Number($("settingBgOverlay").value);
    data.settings.tooltipEnabled = $("settingTooltip").checked;
    data.settings.keyboardNav = $("settingKeyboard").checked;
    data.settings.fontSize = Number($("settingFontSize").value) || data.settings.fontSize;
    data.settings.theme = $("settingTheme").value;
    data.settings.defaultGroupMode = $("settingDefaultGroupMode").value;
    data.settings.defaultGroupId = $("settingDefaultGroupId").value;
    data.settings.sidebarHidden = $("settingSidebarCollapsed").checked;
    data.settings.syncEnabled = $("settingSync").checked;
    const nextMaxBackups = Number($("settingBackup").value) || 0;
    if (nextMaxBackups > 0 && data.backups.length > nextMaxBackups) {
      data.backups = data.backups.slice(0, nextMaxBackups);
    }
    data.settings.maxBackups = nextMaxBackups;
    const retryVal = $("settingIconRetryHour").value;
    if (retryVal === "") {
      data.settings.iconRetryHour = "";
      data.settings.iconRetryAtSix = false;
    } else {
      data.settings.iconRetryHour = Number(retryVal);
      data.settings.iconRetryAtSix = Number(retryVal) === 18;
    }

    const bgFile = $("settingBgFile").files?.[0];
    if (bgFile) {
      data.settings.backgroundCustom = await readFileAsDataUrl(bgFile);
    }

    applyDensity();
    applyTheme();
    await persistData();
    await loadBackground();
    render();
    if (toastOnSave) toast("设置已保存");
    if (close) closeModal();
    settingsSaving = false;
    if (settingsSaveQueued) {
      settingsSaveQueued = false;
      saveSettings({ close: false, toastOnSave: false });
      return;
    }
    return;
  };
  settingsSaveNow = saveSettings;

  const scheduleSettingsSave = (immediate = false) => {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    if (immediate) {
      saveSettings({ close: false, toastOnSave: false });
      return;
    }
    const delay = immediate ? 0 : SETTINGS_SAVE_DELAY_MS;
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = null;
      saveSettings({ close: false, toastOnSave: false });
    }, delay);
  };

  const updateBgControls = (triggerSave = true) => {
    const type = $("settingBgType").value;
    $("bgColorWrap").classList.toggle("hidden", type !== "color");
    $("bgGradientWrap").classList.toggle("hidden", type !== "gradient");
    const bgFile = $("settingBgFile");
    bgFile.classList.toggle("hidden", type !== "custom");
    bgFile.disabled = type !== "custom";
    if (triggerSave) scheduleSettingsSave(true);
  };
  $("settingBgType").addEventListener("change", () => updateBgControls(true));
  updateBgControls(false);

  qsa("input, select, textarea", elements.modal).forEach((el) => {
    const type = el.getAttribute("type") || "";
    const eventName = type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
    el.addEventListener(eventName, () => scheduleSettingsSave(true));
  });
  $("settingBgFile").addEventListener("change", () => scheduleSettingsSave(true));
  $("settingBgOverlay").addEventListener("input", () => {
    $("settingBgOverlayValue").textContent = `${Math.round(Number($("settingBgOverlay").value) * 100)}%`;
  });
}

async function exportJsonToClipboard() {
  try {
    const payload = JSON.stringify(data, null, 2);
    await navigator.clipboard.writeText(payload);
    toast("设置、卡片、分组数据都已复制到剪切板");
  } catch (err) {
    toast(`导出设置失败：${err.message || "无法写入剪切板"}`);
    openManualExportModal();
  }
}

function openManualExportModal() {
  const payload = JSON.stringify(data, null, 2);
  const html = `
    <h2>导出设置</h2>
    <div class="section">
      <textarea readonly>${payload}</textarea>
    </div>
    <div class="actions">
      <button id="btnCopy" class="icon-btn">复制</button>
      <button id="btnClose" class="icon-btn">关闭</button>
    </div>
  `;
  openModal(html);
  $("btnCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(payload);
      toast("已复制到剪切板");
    } catch (err) {
      toast(`复制失败：${err.message || "无法写入剪切板"}`);
    }
  });
  $("btnClose").addEventListener("click", closeModal);
}

async function openImportModal() {
  const html = `
    <h2>导入设置</h2>
    <div class="section">
      <label>导入策略</label>
      <select id="importMode">
        <option value="replace">覆盖所有</option>
        <option value="merge">合并现有</option>
        <option value="add">仅新增不覆盖</option>
      </select>
    </div>
    <div class="section">
      <textarea id="importText" placeholder="正在读取剪切板内设置，如果没导出设置你得先从你其它浏览器导出设置才能导入设置..."></textarea>
    </div>
    <div class="actions">
      <button id="btnCancel" class="icon-btn">取消</button>
      <button id="btnImportNow" class="icon-btn">导入</button>
    </div>
  `;
  openModal(html);
  $("btnCancel").addEventListener("click", closeModal);
  $("btnImportNow").addEventListener("click", async () => {
    try {
      const incoming = JSON.parse($("importText").value.trim());
      const mode = $("importMode").value;
      if (!incoming.schemaVersion) throw new Error("无 schemaVersion");
      pushBackup();
      if (mode === "replace") {
        data = incoming;
      } else if (mode === "merge") {
        const incomingNodes = incoming.nodes || {};
        for (const [id, node] of Object.entries(incomingNodes)) {
          if (!data.nodes[id]) data.nodes[id] = node;
        }
        const existingGroups = new Map(data.groups.map((g) => [g.id, g]));
        const existingIds = new Set(data.groups.map((g) => g.id));
        const makeGroupId = () => {
          let id = `grp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
          while (existingIds.has(id)) {
            id = `grp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
          }
          existingIds.add(id);
          return id;
        };
        for (const group of incoming.groups || []) {
          const target = existingGroups.get(group.id);
          if (!target) {
            data.groups.push(group);
            existingGroups.set(group.id, group);
            continue;
          }
          if ((target.name || "") !== (group.name || "")) {
            const newGroup = { ...group, id: makeGroupId() };
            data.groups.push(newGroup);
            existingGroups.set(newGroup.id, newGroup);
            continue;
          }
          const mergedNodes = new Set([...(target.nodes || []), ...(group.nodes || [])]);
          target.nodes = Array.from(mergedNodes).filter((id) => data.nodes[id] || incomingNodes[id]);
        }
      } else if (mode === "add") {
        const incomingNodes = incoming.nodes || {};
        for (const [id, node] of Object.entries(incomingNodes)) {
          if (!data.nodes[id]) data.nodes[id] = node;
        }
        const existingIds = new Set(data.groups.map((g) => g.id));
        for (const group of incoming.groups || []) {
          if (existingIds.has(group.id)) continue;
          data.groups.push(group);
          existingIds.add(group.id);
        }
      }
      await persistData();
      closeModal();
      render();
      toast("导入设置成功");
    } catch (err) {
      toast(`导入设置失败，你检查一下你的设置对了嘛，先去你其它浏览器导出设置才能导入设置：${err.message}`);
    }
  });

  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $("importText").value = text;
      toast("已从剪切板读取");
    } else {
      toast("剪切板为空");
    }
  } catch (err) {
    toast(`读取剪切板失败：${err.message || "权限受限"}`);
  }
}

function openImportUrlModal() {
  if (!data.groups?.length) {
    toast("没有可用分组");
    return;
  }
  const options = data.groups
    .sort((a, b) => a.order - b.order)
    .map((g) => `<option value="${g.id}">${g.name}</option>`)
    .join("");
  const html = `
    <h2>导入网址</h2>
    <div class="section">
      <label>选择分组</label>
      <select id="importUrlGroup">${options}</select>
    </div>
    <div class="section">
      <div class="row-inline">
        <button id="btnImportUrlHttp" class="icon-btn">导入为HTTP</button>
        <button id="btnImportUrlHttps" class="icon-btn">导入为HTTPS</button>
        <button id="btnImportUrlCancel" class="icon-btn">取消</button>
      </div>
    </div>
    <div class="section">
      <textarea id="importUrlText" placeholder="每行一个网址"></textarea>
    </div>
  `;
  openModal(html);
  const groupSelect = $("importUrlGroup");
  const defaultGroupId = activeGroupId && activeGroupId !== RECENT_GROUP_ID ? activeGroupId : data.groups[0].id;
  groupSelect.value = defaultGroupId;

  const closeWithCleanup = () => {
    elements.modalOverlay.removeEventListener("click", onOverlayClick);
    closeModal();
  };
  const onOverlayClick = (e) => {
    if (e.target === elements.modalOverlay) closeWithCleanup();
  };
  elements.modalOverlay.addEventListener("click", onOverlayClick);

  const importWithScheme = async (scheme) => {
    const groupId = groupSelect.value;
    const group = data.groups.find((g) => g.id === groupId);
    if (!group) {
      toast("分组不存在");
      return;
    }
    const rawText = $("importUrlText").value || "";
    const lines = rawText.split(/\r?\n/);
    const urls = [];
    let invalid = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const token = trimmed.split(/\s+/)[0];
      const normalized = normalizeUrlWithScheme(token, scheme);
      if (!normalized) {
        invalid += 1;
        continue;
      }
      urls.push(normalized);
    }
    if (!urls.length) {
      toast("没有可导入的网址");
      return;
    }
    if (!Array.isArray(group.nodes)) group.nodes = [];
    pushBackup();
    const now = Date.now();
    urls.forEach((url) => {
      const id = `itm_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      data.nodes[id] = {
        id,
        type: "item",
        title: new URL(url).hostname,
        url,
        iconType: "auto",
        iconData: "",
        color: "",
        createdAt: now,
        updatedAt: now,
      };
      group.nodes.push(id);
    });
    data.settings.lastActiveGroupId = group.id;
    await persistData();
    closeModal();
    render();
    toast(invalid ? `已导入 ${urls.length} 条，忽略 ${invalid} 条` : `已导入 ${urls.length} 条`);
  };

  $("btnImportUrlCancel").addEventListener("click", closeWithCleanup);
  $("btnImportUrlHttp").addEventListener("click", () => importWithScheme("http"));
  $("btnImportUrlHttps").addEventListener("click", () => importWithScheme("https"));
}

function openBackupModal() {
  settingsOpen = false;
  const list = data.backups
    .map((b) => `<div class="row" data-backup="${b.id}"><div>${new Date(b.ts).toLocaleString()}</div><div class="row-actions"><button class="icon-btn backup-restore">恢复</button><button class="icon-btn backup-delete">删除</button></div></div>`)
    .join("");
  const html = `
    <h2>备份管理</h2>
    <div class="section">${list || "暂无备份"}</div>
    <div class="actions"><button id="btnClose" class="icon-btn">关闭</button></div>
  `;
  openModal(html);
  qsa(".backup-restore", elements.modal).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-backup]");
      const backup = data.backups.find((b) => b.id === row.dataset.backup);
      if (!backup) return;
      data = backup.data;
      persistData();
      closeModal();
      render();
      toast("已恢复备份");
    });
  });
  qsa(".backup-delete", elements.modal).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-backup]");
      if (!row) return;
      const id = row.dataset.backup;
      if (!id) return;
      data.backups = (data.backups || []).filter((b) => b.id !== id);
      persistData();
      openBackupModal();
      toast("已删除备份");
    });
  });
  $("btnClose").addEventListener("click", closeModal);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function probeImage(url, timeoutMs = ICON_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const img = new Image();
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

async function fetchTitleInBackground(nodeId, url) {
  const title = await fetchTitleViaTab(url);
  if (!title) return;
  const target = data?.nodes?.[nodeId];
  if (!target || !target.titlePending) return;
  target.title = title;
  target.titlePending = false;
  await persistData();
  render();
}

async function fetchFaviconInBackground(nodeId, url) {
  if (!data?.settings?.iconFetch) return;
  const candidates = getFaviconCandidates(url);
  if (!candidates.length) return;
  const cache = await loadIconCache();
  const siteKey = getSiteKey(url);
  for (const candidate of candidates) {
    const ok = await probeImage(candidate);
    if (!ok) continue;
    cache[url] = { url: candidate, ts: Date.now() };
    if (siteKey) cache[siteKey] = { url: candidate, ts: Date.now() };
    await saveIconCache(cache);
    const target = data?.nodes?.[nodeId];
    if (target) target.iconPending = false;
    await persistData();
    render();
    return;
  }
  const target = data?.nodes?.[nodeId];
  if (target) {
    target.iconPending = false;
    await persistData();
    render();
  }
}

async function fetchTitleViaTab(url) {
  const api = getChromeApi();
  if (!api?.tabs) return "";
  return new Promise((resolve) => {
    api.tabs.create({ url, active: false }, (tab) => {
      if (!tab?.id) return resolve("");
      const tabId = tab.id;
      const timeout = setTimeout(() => finish(""), TITLE_FETCH_TIMEOUT_MS);
      const finish = (title) => {
        clearTimeout(timeout);
        api.tabs.onUpdated.removeListener(onUpdated);
        api.tabs.remove(tabId, () => resolve(title || ""));
      };
      const onUpdated = (id, info, updatedTab) => {
        if (id === tabId && info.status === "complete") {
          finish(updatedTab?.title || "");
        }
      };
      api.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function loadRecentHistory() {
  const api = getChromeApi();
  if (!api?.history?.search) return [];
  const startTime = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  try {
    const result = api.history.search({ text: "", startTime, maxResults: RECENT_LIMIT });
    const items = typeof result?.then === "function" ? await result : await new Promise((resolve) => {
      api.history.search({ text: "", startTime, maxResults: RECENT_LIMIT }, (res) => resolve(res || []));
    });
    const seen = new Set();
    return (items || [])
      .filter((item) => item.url)
      .filter((item) => {
        let norm = item.url;
        try { norm = new URL(item.url).href; } catch (e) {
          console.warn("loadRecentHistory: invalid URL", item.url, e);
        }
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
      })
      .map((item, idx) => ({
        id: `recent_${idx}`,
        type: "history",
        title: item.title || item.url,
        url: item.url,
      }));
  } catch (err) {
    return [];
  }
}

async function addHistoryToShortcuts(node) {
  if (!node?.url) return;
  const targetGroupId = getPreferredGroupIdForNewItem();
  if (!targetGroupId) {
    toast("没有可用分组");
    return;
  }
  return addHistoryToShortcutsInGroup(node, targetGroupId);
}

function getPreferredGroupIdForNewItem() {
  if (data.settings.defaultGroupMode === "fixed" && data.settings.defaultGroupId) {
    const fixed = data.groups.find((g) => g.id === data.settings.defaultGroupId);
    if (fixed) return fixed.id;
  }
  if (data.settings.lastActiveGroupId && data.settings.lastActiveGroupId !== RECENT_GROUP_ID) {
    const last = data.groups.find((g) => g.id === data.settings.lastActiveGroupId);
    if (last) return last.id;
  }
  return data.groups?.[0]?.id || "";
}

function openAddHistoryToGroup(node) {
  if (!node?.url) return;
  if (!data.groups?.length) {
    toast("没有可用分组");
    return;
  }
  const options = data.groups
    .sort((a, b) => a.order - b.order)
    .map((g) => `<option value="${g.id}">${g.name}</option>`)
    .join("");
  const html = `
    <h2>添加到快捷</h2>
    <div class="section">
      <label>选择分组</label>
      <select id="addHistoryGroup">${options}</select>
    </div>
    <div class="actions">
      <button id="btnAddHistoryCancel" class="icon-btn">取消</button>
      <button id="btnAddHistorySave" class="icon-btn">保存</button>
    </div>
  `;
  openModal(html);
  const preferred = getPreferredGroupIdForNewItem();
  if (preferred) $("addHistoryGroup").value = preferred;
  $("btnAddHistoryCancel").addEventListener("click", closeModal);
  $("btnAddHistorySave").addEventListener("click", async () => {
    const groupId = $("addHistoryGroup").value;
    await addHistoryToShortcutsInGroup(node, groupId);
    closeModal();
  });
}

async function addHistoryToShortcutsInGroup(node, groupId) {
  if (!node?.url) return;
  const targetGroup = data.groups.find((g) => g.id === groupId);
  if (!targetGroup) {
    toast("分组不存在");
    return;
  }
  pushBackup();
  const id = `itm_${Date.now()}`;
  data.nodes[id] = {
    id,
    type: "item",
    title: node.title || new URL(node.url).hostname,
    url: node.url,
    iconType: "auto",
    iconData: "",
    color: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  targetGroup.nodes.push(id);
  await persistData();
  render();
  toast("已添加到快捷");
}

function handleSearchInput() {
  const query = elements.topSearch.value.trim().toLowerCase();
  if (!query) {
    render();
    return;
  }
  const grid = openFolderId ? elements.folderGrid : elements.grid;
  qsa(".tile", grid).forEach((tile) => {
    const node = data.nodes[tile.dataset.id];
    const text = `${node.title || ""} ${node.url || ""}`.toLowerCase();
    tile.style.display = text.includes(query) ? "" : "none";
  });
}

function ensureSelectionBox() {
  if (!selectionBox) {
    selectionBox = document.createElement("div");
    selectionBox.className = "selection-box hidden";
    document.body.appendChild(selectionBox);
  }
}

function updateSelectionBox(x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x1 - x2);
  const height = Math.abs(y1 - y2);
  selectionBox.style.left = `${left}px`;
  selectionBox.style.top = `${top}px`;
  selectionBox.style.width = `${width}px`;
  selectionBox.style.height = `${height}px`;
  selectionBox.classList.remove("hidden");
}

function selectTilesInBox(grid, x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  qsa(".tile", grid).forEach((tile) => {
    const rect = tile.getBoundingClientRect();
    const hit = rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top;
    if (hit) selectedIds.add(tile.dataset.id);
  });
}

function getDropIndex(grid, x, y) {
  const tiles = qsa(".tile", grid).filter((tile) => tile.getClientRects().length > 0);
  if (!tiles.length) return 0;

  let nearest = { index: 0, rect: tiles[0].getBoundingClientRect(), distance: Infinity };
  for (let i = 0; i < tiles.length; i++) {
    const rect = tiles[i].getBoundingClientRect();
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const distance = dx + dy;
    if (distance < nearest.distance) {
      nearest = { index: i, rect, distance };
    }
  }

  const rect = nearest.rect;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  let insertAfter = false;
  if (x < rect.left) insertAfter = false;
  else if (x > rect.right) insertAfter = true;
  else if (y < rect.top) insertAfter = false;
  else if (y > rect.bottom) insertAfter = true;
  else {
    const nearRowCenter = Math.abs(y - centerY) <= rect.height * 0.35;
    insertAfter = nearRowCenter ? x >= centerX : y >= centerY;
  }

  return nearest.index + (insertAfter ? 1 : 0);
}

async function init() {
  debugLog("init_start", getRuntimeInfo());
  listenForExternalToast();
  attachStorageListener();
  const localData = await loadData();
  debugLog("init_local", {
    groups: localData.groups?.length || 0,
    nodes: Object.keys(localData.nodes || {}).length,
    lastUpdated: localData.lastUpdated || 0,
    syncEnabled: !!localData.settings?.syncEnabled,
  });
  if (localData.settings.syncEnabled) {
    const syncData = await loadDataFromArea(true);
    if (syncData && syncData.groups?.length) {
      const localTs = Number(localData.lastUpdated || 0);
      const syncTs = Number(syncData.lastUpdated || 0);
      data = syncTs >= localTs ? syncData : localData;
      if (data === localData) {
        await saveData(localData, true);
      }
    } else {
      data = localData;
    }
  } else {
    data = localData;
  }
  const deduped = dedupeData(data);
  if (deduped) {
    await saveData(data, data.settings.syncEnabled);
    if (data.settings.syncEnabled) await saveData(data, false);
  }
  syncBackupBaseline(data);
  debugLog("init_ready", {
    groups: data.groups?.length || 0,
    nodes: Object.keys(data.nodes || {}).length,
    lastUpdated: data.lastUpdated || 0,
    deduped,
    activeGroupId,
  });
  const preferredGroupId = data.settings.lastActiveGroupId;
  if (preferredGroupId === RECENT_GROUP_ID) {
    activeGroupId = RECENT_GROUP_ID;
  } else if (preferredGroupId && data.groups.find((g) => g.id === preferredGroupId)) {
    activeGroupId = preferredGroupId;
  } else {
    activeGroupId = data.groups?.[0]?.id || RECENT_GROUP_ID;
    data.settings.lastActiveGroupId = activeGroupId;
  }
  recentItems = await loadRecentHistory();
  applyDensity();
  applyTheme();
  applySidebarState();
  closeModal();
  closeFolder();
  await loadBackground();
  await retryFailedIconsIfDue(data.settings);
  render();
  await consumeSaveToast();
}

function render() {
  renderGroups();
  renderGrid();
  elements.topSearchWrap.classList.toggle("hidden", !data.settings.showSearch);
  elements.emptyHintToggle.checked = data.settings.emptyHintDisabled;
  elements.btnSelectAll.classList.toggle("hidden", !selectionMode);
  elements.btnBatchDelete.textContent = selectionMode ? "删除" : "批量删";
  updateOpenModeButton();
}

function updateOpenModeButton() {
  const map = {
    current: "本页打开",
    new: "新页打开",
    background: "在后台打开",
  };
  const label = map[data.settings.openMode] || "本页打开";
  elements.btnOpenMode.textContent = `${label}`;
}

function bindEvents() {
  window.addEventListener("resize", () => render());

  elements.btnAdd.addEventListener("click", openAddModal);
  elements.btnFolderAdd.addEventListener("click", openAddModal);
  elements.btnToggleSidebar?.addEventListener("click", () => {
    data.settings.sidebarCollapsed = !data.settings.sidebarCollapsed;
    applySidebarState();
    persistData();
  });
  elements.recentTab.addEventListener("click", async () => {
    activeGroupId = RECENT_GROUP_ID;
    openFolderId = null;
    data.settings.lastActiveGroupId = activeGroupId;
    persistData();
    recentItems = await loadRecentHistory();
    render();
  });
  elements.btnAddGroup.addEventListener("click", () => {
    const groupId = `grp_${Date.now()}`;
    data.groups.push({ id: groupId, name: "新分组", order: data.groups.length, nodes: [] });
    activeGroupId = groupId;
    data.settings.lastActiveGroupId = activeGroupId;
    persistData();
    render();
  });

  elements.btnBatchDelete.addEventListener("click", () => {
    if (activeGroupId === RECENT_GROUP_ID) {
      toast("最近浏览不可批量删除");
      return;
    }
    if (!selectionMode) {
      selectionMode = true;
      toast("进入批量选择模式");
      updateSelectionControls();
      return;
    }
    const ids = Array.from(selectedIds);
    if (!ids.length) {
      clearSelection();
      updateSelectionControls();
      updateSelectionStyles();
      return;
    }
    clearSelection();
    deleteNodes(ids);
    updateSelectionControls();
  });

  elements.btnFolderBatchDelete.addEventListener("click", () => {
    if (activeGroupId === RECENT_GROUP_ID) {
      toast("最近浏览不可批量删除");
      return;
    }
    if (!selectionMode) {
      selectionMode = true;
      toast("进入批量选择模式");
      updateSelectionControls();
      return;
    }
    const ids = Array.from(selectedIds);
    if (!ids.length) {
      clearSelection();
      updateSelectionControls();
      updateSelectionStyles();
      return;
    }
    clearSelection();
    deleteNodes(ids);
    updateSelectionControls();
  });

  elements.btnSelectAll.addEventListener("click", () => {
    if (!selectionMode) return;
    const grid = openFolderId ? elements.folderGrid : elements.grid;
    qsa(".tile", grid).forEach((tile) => selectedIds.add(tile.dataset.id));
    updateSelectionStyles();
  });

  elements.main?.addEventListener?.("click", (e) => {
    if (suppressBlankClick) {
      suppressBlankClick = false;
      return;
    }
    if (!selectionMode || boxSelecting) return;
    if (e.target.closest(".tile")) return;
    clearSelection();
    updateSelectionControls();
    updateSelectionStyles();
  });

  elements.btnOpenMode.addEventListener("click", openOpenModeMenu);
  elements.btnSettings.addEventListener("click", async () => {
    if (settingsOpen) {
      closeModal();
      return;
    }
    openSettingsModal();
  });
  elements.btnSearch.addEventListener("click", () => {
    const query = elements.topSearch.value.trim();
    if (!query) {
      elements.topSearch.focus();
      return;
    }
    openUrl(`${data.settings.searchEngineUrl}${encodeURIComponent(query)}`, "new");
  });

  elements.topSearch.addEventListener("input", handleSearchInput);
  elements.topSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const query = elements.topSearch.value.trim();
      if (!query) return;
      openUrl(`${data.settings.searchEngineUrl}${encodeURIComponent(query)}`, "new");
    }
  });

  elements.topSearch.addEventListener("focus", async () => {
    if (activeGroupId === RECENT_GROUP_ID) {
      recentItems = await loadRecentHistory();
      render();
    }
  });

  elements.emptyHintToggle.addEventListener("change", async (e) => {
    data.settings.emptyHintDisabled = e.target.checked;
    await persistData();
    render();
  });

  elements.btnCloseFolder.addEventListener("click", closeFolder);
  elements.folderOverlay.addEventListener("click", (e) => {
    if (e.target.closest(".tile")) return;
    if (e.target.closest(".overlay-header")) return;
    closeFolder();
  });

  elements.modalOverlay.addEventListener("click", async (e) => {
    if (e.target !== elements.modalOverlay) return;
    if (settingsOpen) {
      closeModal();
      return;
    }
    closeModal();
  });

  const handleBoxSelectStart = (e, grid) => {
    if (e.button !== 0) return;
    if (e.target.closest(".tile")) return;
    if (!selectionMode) return;
    boxSelecting = true;
    isDraggingBox = false;
    ensureSelectionBox();
    selectionStart = { x: e.clientX, y: e.clientY, grid };
    updateSelectionBox(e.clientX, e.clientY, e.clientX, e.clientY);
  };

  const handleBoxSelectMove = (e) => {
    if (!boxSelecting || !selectionStart) return;
    const dx = Math.abs(e.clientX - selectionStart.x);
    const dy = Math.abs(e.clientY - selectionStart.y);
    if (dx + dy > BOX_SELECT_THRESHOLD) isDraggingBox = true;
    updateSelectionBox(selectionStart.x, selectionStart.y, e.clientX, e.clientY);
  };

  const handleBoxSelectEnd = (e) => {
    if (!boxSelecting || !selectionStart) return;
    if (isDraggingBox) {
      selectTilesInBox(selectionStart.grid, selectionStart.x, selectionStart.y, e.clientX, e.clientY);
      suppressBlankClick = true;
    }
    boxSelecting = false;
    selectionStart = null;
    isDraggingBox = false;
    if (selectionBox) selectionBox.classList.add("hidden");
    updateSelectionStyles();
  };

  elements.grid.addEventListener("mousedown", (e) => handleBoxSelectStart(e, elements.grid));
  elements.folderGrid.addEventListener("mousedown", (e) => handleBoxSelectStart(e, elements.folderGrid));
  elements.main?.addEventListener?.("mousedown", (e) => {
    if (openFolderId) return;
    handleBoxSelectStart(e, elements.grid);
  });
  document.addEventListener("mousemove", handleBoxSelectMove);
  document.addEventListener("mouseup", handleBoxSelectEnd);

  document.addEventListener("click", (e) => {
    if (!elements.contextMenu.contains(e.target)) closeContextMenu();
  });

  document.addEventListener("mousemove", (e) => {
    if (!elements.tooltip.classList.contains("hidden")) {
      elements.tooltip.style.left = `${e.clientX + 12}px`;
      elements.tooltip.style.top = `${e.clientY + 12}px`;
    }
  });

  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (!target) return;
    const text = target.getAttribute("data-tooltip");
    if (text) showTooltip(text, e.clientX, e.clientY);
  });

  document.addEventListener("mouseout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (!target) return;
    hideTooltip();
  });

  document.addEventListener("keydown", (e) => {
    if (!data.settings.keyboardNav) return;
    if (e.key === "Escape" && openFolderId) closeFolder();
    if (e.key === "/") {
      elements.topSearch.focus();
      e.preventDefault();
    }
  });

  elements.grid.addEventListener("dragover", (e) => e.preventDefault());
  elements.grid.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragState) return;
    if (activeGroupId === RECENT_GROUP_ID) return;
    const sourceId = dragState.id;
    if (openFolderId) return;
    const group = getActiveGroup();
    const index = getDropIndex(elements.grid, e.clientX, e.clientY);
    const next = moveNodeInList(group.nodes, sourceId, index);
    if (next === group.nodes) {
      dragState = null;
      return;
    }
    group.nodes = next;
    persistData();
    render();
    dragState = null;
  });

  elements.folderGrid.addEventListener("dragover", (e) => e.preventDefault());
  elements.folderGrid.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragState || !openFolderId) return;
    const sourceId = dragState.id;
    const folder = data.nodes[openFolderId];
    const index = getDropIndex(elements.folderGrid, e.clientX, e.clientY);
    const list = folder.children || [];
    const next = moveNodeInList(list, sourceId, index);
    if (next === list) {
      dragState = null;
      return;
    }
    folder.children = next;
    persistData();
    render();
    dragState = null;
  });

  elements.groupTabs.addEventListener("dragover", (e) => {
    if (!draggingGroupId) return;
    e.preventDefault();
    const rect = elements.groupTabs.getBoundingClientRect();
    const edge = 24;
    if (e.clientY < rect.top + edge) {
      elements.groupTabs.scrollTop -= 16;
    } else if (e.clientY > rect.bottom - edge) {
      elements.groupTabs.scrollTop += 16;
    }
  });

  elements.groupTabs.addEventListener("drop", (e) => {
    if (!draggingGroupId) return;
    e.preventDefault();
    const rect = elements.groupTabs.getBoundingClientRect();
    const edge = 24;
    const total = data.groups.length;
    if (e.clientY < rect.top + edge) {
      moveGroupToIndex(draggingGroupId, 0);
    } else if (e.clientY > rect.bottom - edge) {
      moveGroupToIndex(draggingGroupId, total);
    }
    qsa(".group-tab", elements.groupTabs).forEach((el) => el.classList.remove("drop-target"));
  });
}

init();
bindEvents();
