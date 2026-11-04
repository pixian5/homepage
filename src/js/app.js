import { getBingWallpaper } from "./bing-wallpaper.js";
import { bookmarksToHomepageData, exportNetscapeBookmarksHtml, parseNetscapeBookmarksHtml } from "./bookmark-html.js";
import { createContextMenuManager } from "./context-menu.js";
import {
  ALL_BOOKMARKS_GROUP_ID,
  canMoveNodeToFolder,
  cloneDataSnapshot,
  createItemNode,
  dedupeData,
  ensureAllBookmarksGroup,
  isAllBookmarksGroup,
  isSafeCssColor,
  markNodeDeleted,
  mergeRootBookmarkData,
  moveNodeInList,
  moveNodeToFolder,
  pruneSyncTombstones,
  repairHomepageData,
  stampNodeFieldChanges,
} from "./data-utils.js";
import { nextGridFocusIndex } from "./drag-geometry.js";
import { createDragManager } from "./drag-manager.js";
import { createFolderManager } from "./folder-manager.js";
import { createGridRenderer } from "./grid-renderer.js";
import { createHistoryManager } from "./history-manager.js";
import { createI18nManager } from "./i18n-manager.js";
import { createIconManager } from "./icon-manager.js";
import { clearIconCacheForUrl, compressImageFileToDataUrl, getSiteKey, retryFailedIconsIfDue } from "./icons.js";
import { createModalManager } from "./modal-manager.js";
import { createNodeOpsManager } from "./node-ops-manager.js";
import { createOpenModeManager } from "./open-mode-manager.js";
import { createPersistenceCoordinator } from "./persistence-coordinator.js";
import { createSearchManager } from "./search-manager.js";
import { createSelectionManager } from "./selection-manager.js";
import { createSettingsController } from "./settings-controller.js";
import {
  getStorageMode,
  normalizeUrl,
  RECENT_GROUP_ID,
  registerServiceWorkerIfNeeded,
  SAFE_URL_PROTOCOLS,
} from "./shared-utils.js";
import { createSidebarManager } from "./sidebar-manager.js";
import {
  clearData,
  deepClone,
  defaultData,
  defaultSettings,
  detectPreferredLanguage,
  getChromeApi,
  getStorageKey,
  loadBgCache,
  loadData,
  loadDataFromArea,
  loadIconCache,
  normalizeLanguage,
  pruneUnusedCaches,
  saveBgCache,
  saveData,
  saveIconCache,
} from "./storage.js";
import { createStorageListener } from "./storage-listener.js";
import { exportSyncBundle, importSyncBundle } from "./sync_bundle.js";
import {
  cancelScheduledPush,
  ensureDevicePairing,
  flushOutbox,
  getOutboxSummary,
  getPendingConflict,
  getSyncStatus,
  initSyncEngine,
  onSyncEnabledChanged,
  pullNow,
  pushNow,
  refreshSyncInterval,
  reloadSyncState,
  resolveDocConflict,
  schedulePush,
} from "./sync_engine.js";
import { httpGetDevices, httpHealth, httpPullState, httpRetireDevice } from "./sync_http_transport.js";
import { createDocId, getOrCreateDeviceId } from "./sync_ids.js";
import { mergeHomepage } from "./sync_merge.js";
import {
  normalizeSyncInterval,
  SYNC_INTERVAL_OPTIONS,
  SYNC_OUTBOX_KEY,
  SYNC_STATE_KEY,
  syncBytesBudgetLevel,
} from "./sync_policy.js";
import { estimateSyncProjectionBytes, toSyncDocument } from "./sync_projection.js";
import { createSyncBanner } from "./sync-banner.js";
import { createThemeManager } from "./theme-manager.js";
import { createToastManager } from "./toast-manager.js";
import { createTooltipManager } from "./tooltip-manager.js";
import { createTouchDragManager } from "./touch-drag-manager.js";
import { escapeHtml, html, rawHtml, runWithButtonState } from "./ui-utils.js";
import { attachVisitTracking, recordVisit } from "./visit-history.js";

const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const rafThrottle = (fn) => {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
};

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
  btnFolderDissolve: $("btnFolderDissolve"),
};

let data = null;
/**
 * 当前已应用的背景签名。
 * 同步合并、跨标签页重载这两条路径都会整体替换 data，但不会重跑背景初始化，
 * 导致「从服务器同步过来的背景设置要手动切一下才生效」。用它判断背景相关设置是否变了。
 */
let activeGroupId = null;
let openFolderId = null;
/** 拖拽与重排管理器（drag-manager.js），init 时创建 */
let dragManager = null;
/** 触摸拖拽状态机（touch-drag-manager.js），init 时创建 */
let touchDrag = null;
/** 存储变更热监听（storage-listener.js），init 时创建 */
let storageListener = null;
/** 批量选择管理器（selection-manager.js），init 时创建 */
let selectionMgr = null;
/** 主题与背景管线管理器（theme-manager.js），init 时创建 */
let themeMgr = null;
/** 卡片打开方式管理器（open-mode-manager.js），init 时创建 */
let openModeMgr = null;
/** Toast 提示管理器（toast-manager.js），模块加载即建（全文件大量调用） */
let toastMgr = null;
/** 侧边栏管理器（sidebar-manager.js），init 时创建 */
let sidebarMgr = null;
/** 文件夹覆盖层管理器（folder-manager.js），init 时创建 */
let folderMgr = null;
/** Tooltip 提示管理器（tooltip-manager.js），模块加载即建 */
let tooltipMgr = null;
/** 核心网格渲染器（grid-renderer.js），init 时创建 */
let gridRenderer = null;
/** 数据持久化与时钟协调器（persistence-coordinator.js），init 时创建 */
let persistenceCoordinator = null;
/** 节点与分组操作管理器（node-ops-manager.js），init 时创建 */
let nodeOpsManager = null;
/** 国际化与多语言管理器（i18n-manager.js），init 时创建 */
let i18nManager = null;

// Toast 管理器立即创建：模块内任何时点的 toast() 调用都必须可用
toastMgr = createToastManager({
  containerEl: () => elements?.toastContainer || null,
  getDurationMs: () => getToastDurationMs(),
});
// Tooltip 管理器立即创建（渲染卡片即绑定悬停）
tooltipMgr = createTooltipManager({
  tooltipEl: () => elements?.tooltip || null,
  delayMs: 200,
  isEnabled: () => !!data?.settings?.tooltipEnabled,
});
let recentItems = [];
/** 「最近历史」分组管理器（history-manager.js），init 时创建 */
let historyManager = null;
/** 顶部搜索管理器（search-manager.js），init 时创建 */
let searchManager = null;
/** 图标管线管理器（icon-manager.js），init 时创建 */
let iconManager = null;
let settingsOpen = false;
let settingsSaving = false;
let settingsSaveTimer = null;
let settingsSaveQueued = false;
/** 设置面板控制器（settings-controller.js），init 时注入依赖。 */
let settingsCtl = null;
/** 同步异常提示条控制器（init 时创建；storage 监听里可能先于创建触发，故用可选链） */
let syncBanner = null;
let modalPointerDownInsideDialog = false;
const DEBUG_LOG_KEY = "homepage_debug_log";

// ==================== 常量定义 ====================
const DEFAULT_TOAST_DURATION_SECONDS = 5;

function getToastDurationMs() {
  const seconds = Number(data?.settings?.toastDuration);
  const normalized = Number.isFinite(seconds) ? Math.min(60, Math.max(1, seconds)) : DEFAULT_TOAST_DURATION_SECONDS;
  return normalized * 1000;
}
const STORAGE_RELOAD_DELAY_MS = 120;
const STORAGE_SUPPRESS_MS = 350;
/** 备份指纹忽略的设置键：这些字段变化不构成“值得备份的变更” */
const BACKUP_IGNORED_SETTINGS_KEYS = new Set(["lastActiveGroupId", "lastSaveUrl", "lastSaveTs", "lastSaveToast"]);
const SETTINGS_SAVE_DELAY_MS = 120;
const TOAST_CONSUME_TIMEOUT_MS = 15000;
const MAX_DEBUG_LOG_ENTRIES = 200;

// ---- 国际化：全部代理到 i18nManager（下游管理器沿用旧函数名） ----
function currentLang() {
  return i18nManager.currentLang();
}

function t(key, vars = null) {
  return i18nManager.t(key, vars);
}

function ensureLanguageSetting() {
  return i18nManager.ensureLanguageSetting();
}

function buildLanguageOptions(selectedLanguage) {
  return i18nManager.buildLanguageOptions(selectedLanguage);
}

function applyStaticI18n() {
  return i18nManager.applyStaticI18n();
}

function debugLog(event, payload = {}) {
  const entry = { ts: Date.now(), event, payload };
  try {
    const raw = localStorage.getItem(DEBUG_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    localStorage.setItem(DEBUG_LOG_KEY, JSON.stringify(list.slice(0, MAX_DEBUG_LOG_ENTRIES)));
  } catch (_err) {
    // localStorage 写入失败是预期行为，不需要警告
  }
  if (shouldDebugPersist()) {
    console.log("[debug]", entry);
  }
}

function getRuntimeInfo() {
  const api = getChromeApi();
  return {
    runtimeId: api?.runtime?.id || "",
    href: window.location.href,
    origin: window.location.origin,
  };
}

function getAppVersion() {
  const api = getChromeApi();
  try {
    const version = api?.runtime?.getManifest?.()?.version;
    return version ? String(version) : "";
  } catch (e) {
    console.warn("getAppVersion failed", e);
    return "";
  }
}

function shouldDebugPersist() {
  try {
    return localStorage.getItem("homepage_debug_persist") === "1";
  } catch (e) {
    console.warn("shouldDebugPersist failed", e);
    return false;
  }
}

async function reloadFromStorage() {
  const prevActive = activeGroupId;
  const prevOpenFolder = openFolderId;
  const prevLocalTs = Number(data?.lastUpdated || 0);
  const prevPending = persistenceCoordinator?.isPersistInFlight() || false;
  // 先从磁盘重载 local（popup 等外部写入），再按需 pull 合并远端投影
  const diskLocal = await loadData();
  const wasSync = !!diskLocal?.settings?.syncEnabled;
  data = diskLocal;
  if (wasSync) {
    try {
      await pullNow("storage_reload");
    } catch (e) {
      console.warn("reload pullNow failed", e);
    }
  }
  resetSettingsClockBaseline(data);
  resetPlacementClockBaseline(data);
  const newTs = Number(data?.lastUpdated || 0);
  // merge 提示由 engine onMerged 负责；此处仅非 sync 粗提示
  if (!wasSync && newTs > prevLocalTs && prevLocalTs > 0 && !prevPending) {
    toast(t("toast.syncOverwritten"), "warning");
  }
  if (prevActive === RECENT_GROUP_ID) {
    activeGroupId = RECENT_GROUP_ID;
  } else if (prevActive && getRootContainerById(prevActive)) {
    activeGroupId = prevActive;
  } else {
    activeGroupId = getRootGroup()?.id || RECENT_GROUP_ID;
  }
  if (prevOpenFolder && data.nodes?.[prevOpenFolder]?.type === "folder") {
    openFolderId = prevOpenFolder;
  } else {
    openFolderId = null;
  }
  selectionMgr?.retainOnly(new Set(Object.keys(data.nodes || {})));
  ensureLanguageSetting();
  syncBackupBaseline(data);
  render();
  iconManager.processPendingIconFetches();
  await consumeSaveToast();
  // popup 等只写了 local：reload 后把投影推到 sync
  if (data?.settings?.syncEnabled) schedulePush();
}

// 调试接口仅在开发构建中暴露，避免生产环境泄露运行时信息
if (typeof DEBUG !== "undefined" && DEBUG) {
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
}

/**
 * 「另一台设备有较新数据」的提示做了频率限制。
 *
 * 多设备场景下每个设备打开页面都会推进一次 revision，另一台下次加载必然看到
 * 「远端更新」，于是每次刷新都弹一次，提示失去意义。真正需要知道的是「有没有东西被改」，
 * 而合并结果里 applied=false 时本来就不会走到这里。
 * 这里再做一层：30 分钟内只提示一次，时间戳写 localStorage，跨页面刷新也生效。
 */
const SYNC_MERGE_TOAST_INTERVAL_MS = 30 * 60 * 1000;
const SYNC_MERGE_TOAST_KEY = "homepage_sync_merge_toast_at";

function toastSyncMergedOnce() {
  try {
    const last = Number(localStorage.getItem(SYNC_MERGE_TOAST_KEY)) || 0;
    if (Date.now() - last < SYNC_MERGE_TOAST_INTERVAL_MS) return;
    localStorage.setItem(SYNC_MERGE_TOAST_KEY, String(Date.now()));
  } catch {
    // localStorage 不可用（隐私模式等）时退化为每次都提示
  }
  toast(t("toast.syncOverwritten"), "warning");
}

/**
 * 显示 Toast（兼容签名见 toast-manager.js）。
 * 全文件与子组件（modal/drag/selection/...）都沿用这个入口。
 */
function toast(message, actionLabelOrType, actionOrType, type) {
  toastMgr?.toast(message, actionLabelOrType, actionOrType, type);
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
  const groupName = toastInfo.groupName || t("common.unnamed");
  toast(t("toast.savedToGroup", { name: groupName }));
  data.settings.lastSaveToast = null;
  await persistData();
}

// normalizeUrl 直接从 shared-utils 导入（Firefox bundle 不可使用 import alias）

function normalizeUrlWithScheme(input, scheme) {
  if (!input) return "";
  const raw = input.trim();
  if (!raw) return "";
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const candidate = hasScheme ? raw : `${scheme}://${raw.replace(/^\/+/, "")}`;
  try {
    const url = new URL(candidate);
    if (!SAFE_URL_PROTOCOLS.has(url.protocol)) return "";
    return url.href;
  } catch (_e) {
    // URL 解析失败是预期行为，不需要警告
    return "";
  }
}

function openUrl(url, mode) {
  return openModeMgr.openUrlWithMode(url, mode);
}

async function pruneCachesQuietly() {
  try {
    const bookmarkUrls = Object.values(data?.nodes || {})
      .filter((n) => n?.type === "item" && typeof n.url === "string" && n.url)
      .map((n) => n.url);
    const res = await pruneUnusedCaches({
      bookmarkUrls,
      backgroundType: data?.settings?.backgroundType || "",
      siteKeyOf: getSiteKey,
      loadIcon: loadIconCache,
      saveIcon: saveIconCache,
      loadBg: loadBgCache,
      saveBg: saveBgCache,
    });
    if (res.iconRemoved > 0 || res.bgCleared) {
      console.info(`[homepage] 缓存清理：图标 ${res.iconRemoved} 条，背景缓存${res.bgCleared ? "已清空" : "保留"}`);
    }
  } catch (e) {
    console.warn("pruneCachesQuietly failed", e);
  }
}

// ---- 持久化协调器透传：上百处调用点沿用这些旧函数名 ----
function pushBackup() {
  return persistenceCoordinator.pushBackup();
}

function syncBackupBaseline(source = data) {
  return persistenceCoordinator.syncBackupBaseline(source);
}

function resetSettingsClockBaseline(source = data) {
  return persistenceCoordinator.resetSettingsClockBaseline(source);
}

function resetPlacementClockBaseline(source = data) {
  return persistenceCoordinator.resetPlacementClockBaseline(source);
}

function queuePersist() {
  return persistenceCoordinator.queuePersist();
}

function persistData() {
  return persistenceCoordinator.persistData();
}

let contextMenuManager = null;
function getContextMenuManager() {
  if (!contextMenuManager) {
    contextMenuManager = createContextMenuManager({
      menuElement: elements.contextMenu,
      t,
      normalizeUrl,
      callbacks: {
        openUrl,
        openFolder,
        dissolveFolder: (folderId) => folderMgr.dismissFolder(folderId),
        openEditModal,
        deleteNodes,
        openAddHistoryToGroup: (node) => historyManager?.openAddToGroupModal(node),
        renameGroup,
        deleteGroup,
      },
    });
  }
  return contextMenuManager;
}

function openContextMenu(x, y, node) {
  getContextMenuManager().showTileMenu(x, y, node, { activeGroupId });
}

function closeContextMenu() {
  getContextMenuManager().closeMenu();
}

function openGroupContextMenu(x, y, group) {
  getContextMenuManager().showGroupMenu(x, y, group);
}

function getCurrentGridElement() {
  return openFolderId ? elements.folderGrid : elements.grid;
}

// ---- 节点与分组操作：全部代理到 nodeOpsManager（下游 drag/grid/context-menu 等沿用旧函数名） ----
function getActiveGroup() {
  return nodeOpsManager.getActiveGroup();
}

function getRootGroup() {
  return nodeOpsManager.getRootGroup();
}

function getRootFolderIds() {
  return nodeOpsManager.getRootFolderIds();
}

function getRootContainers() {
  return nodeOpsManager.getRootContainers();
}

function getRootContainerById(id) {
  return nodeOpsManager.getRootContainerById(id);
}

function getFolderPlacementContainer(folderId) {
  return nodeOpsManager.getFolderPlacementContainer(folderId);
}

function getPlacementList(container) {
  return nodeOpsManager.getPlacementList(container);
}

function setPlacementList(container, list) {
  return nodeOpsManager.setPlacementList(container, list);
}

function getCurrentNodes() {
  return nodeOpsManager.getCurrentNodes();
}

function removeNodeFromLocation(id) {
  return nodeOpsManager.removeNodeFromLocation(id);
}

function touchPlacementContainer(container) {
  return nodeOpsManager.touchPlacementContainer(container);
}

function moveGroupToIndex(sourceId, index) {
  return nodeOpsManager.moveGroupToIndex(sourceId, index);
}

function renameGroup(group) {
  return nodeOpsManager.renameGroup(group);
}

function deleteGroup(group) {
  return nodeOpsManager.deleteGroup(group);
}

function deleteNodes(ids) {
  return nodeOpsManager.deleteNodes(ids);
}

/**
 * 安全地设置元素的文本内容，防止 XSS
 * @param {HTMLElement} el
 * @param {string} text
 */
function _safeSetText(el, text) {
  el.textContent = text;
}

/**
 * 创建带标签和输入框的表单项
 * @param {string} labelText
 * @param {HTMLElement} inputEl
 * @returns {HTMLElement}
 */
function _createFormSection(labelText, inputEl) {
  const section = document.createElement("div");
  section.className = "section";
  const label = document.createElement("label");
  label.textContent = labelText;
  section.appendChild(label);
  section.appendChild(inputEl);
  return section;
}

let modalManager = null;
function getModalManager() {
  if (!modalManager) {
    modalManager = createModalManager({
      modalEl: elements.modal,
      modalOverlayEl: elements.modalOverlay,
      btnSettingsEl: elements.btnSettings,
      t,
      toast,
      getState: () => ({ data, openFolderId, activeGroupId }),
      setState: (patch) => {
        if (patch.data) data = patch.data;
        if (patch.activeGroupId) activeGroupId = patch.activeGroupId;
        if (patch.openFolderId !== undefined) openFolderId = patch.openFolderId;
      },
      readFileAsDataUrl,
      readIconAsDataUrl,
      fetchTitleInBackground: (nodeId, url) => iconManager.fetchTitleInBackground(nodeId, url),
      fetchFaviconInBackground: (nodeId, url) => iconManager.fetchFaviconInBackground(nodeId, url),
      fetchFaviconNow: (nodeId, url) => iconManager.fetchFaviconNow(nodeId, url),
      clearIconCacheForUrl,
      pushBackup,
      persistData,
      render,
      debugLog,
      getContainerHelpers: () => ({
        getFolderPlacementContainer,
        getPlacementList,
        setPlacementList,
        touchPlacementContainer,
        getActiveGroup,
      }),
      onModalClose: async () => {
        if (settingsSaveTimer) {
          clearTimeout(settingsSaveTimer);
          settingsSaveTimer = null;
        }
        const pendingSave = settingsCtl?.saveNow;
        if (settingsOpen && typeof pendingSave === "function" && !settingsSaving) {
          try {
            await pendingSave();
          } catch (e) {
            console.warn("flush settings on closeModal failed", e);
          }
        }
        modalPointerDownInsideDialog = false;
        settingsOpen = false;
        settingsSaving = false;
        settingsSaveQueued = false;
        // 设置弹窗打开期间挂起的外部存储变更，关闭后补一次重载
        storageListener?.flushPendingReload();
      },
    });
  }
  return modalManager;
}

function openModal(html) {
  getModalManager().openModal(html);
}

async function closeModal() {
  await getModalManager().closeModal();
}

function openAddModal() {
  getModalManager().openAddModal();
}

function openEditModal(node) {
  getModalManager().openEditModal(node);
}

/** 离开设置主表单进入子面板前：刷掉 debounce 中的保存，避免改动丢失 */
async function leaveSettingsForSubpanel() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  const pending = settingsCtl?.saveNow;
  if (typeof pending === "function" && !settingsSaving) {
    try {
      await pending();
    } catch (e) {
      console.warn("leaveSettingsForSubpanel flush failed", e);
    }
  }
  settingsOpen = false;
}

function isSafariBrowser() {
  const ua = navigator.userAgent || "";
  return /safari/i.test(ua) && !/chrome|crios|chromium|android/i.test(ua);
}

function detectExtensionPlatform() {
  if (/firefox/i.test(navigator.userAgent || "")) return "firefox";
  if (isSafariBrowser()) return "safari";
  return "chrome";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function readIconAsDataUrl(file) {
  return compressImageFileToDataUrl(file, 128, 0.85);
}

/**
 * 创建图标管线管理器实例（能力与依赖见 icon-manager.js）：
 * 字母头像、缓存解析、候选回退、失败退避、后台补抓、批量刷新。
 */
function createIconManagerInstance() {
  return createIconManager({
    getData: () => data,
    persistData,
    render,
    stampNodeFieldChanges,
  });
}

/**
 * 创建「最近历史」管理器实例（能力与依赖见 history-manager.js）。
 * fetchRecentHistory / addHistoryToShortcuts / openAddToGroupModal 等均由其提供。
 */
function createHistoryManagerInstance() {
  return createHistoryManager({
    debugLog,
    t,
    toast,
    getData: () => data,
    getRootGroup,
    getRootContainers,
    getRootContainerById,
    isAllBookmarksGroup,
    getPlacementList,
    setPlacementList,
    pushBackup,
    persistData,
    render,
    processPendingIconFetches: () => iconManager.processPendingIconFetches(),
    openModal,
    closeModal,
    html,
    rawHtml,
  });
}

/**
 * 创建顶部搜索管理器实例（实时过滤 / 搜索引擎跳转 / Escape 恢复）。
 */
function createSearchManagerInstance() {
  return createSearchManager({
    searchInput: elements.topSearch,
    searchBtn: elements.btnSearch,
    getData: () => data,
    getActiveGrid: getCurrentGridElement,
    getNodes: () => data.nodes,
    openUrl,
    render,
    onFocus: async () => {
      // 历史分组下聚焦搜索框：顺手刷新一次最近访问
      if (activeGroupId === RECENT_GROUP_ID && historyManager) {
        recentItems = await historyManager.fetchRecentHistory();
        render();
      }
    },
    qsa,
  });
}

/**
 * 创建拖拽与重排管理器实例（能力与依赖见 drag-manager.js）：
 * 排序插入 / 放入文件夹 / 拖卡建夹三种意图 + 侧栏分组排序。
 */
function createDragManagerInstance() {
  return createDragManager({
    getData: () => data,
    getState: () => ({ activeGroupId, openFolderId }),
    getActiveGroup,
    getFolderPlacementContainer,
    getPlacementList,
    setPlacementList,
    touchPlacementContainer,
    removeNodeFromLocation,
    moveNodeInList,
    moveNodeToFolder,
    canMoveNodeToFolder,
    createFolderNode: (childIds) => {
      const createdAt = Date.now();
      return {
        id: `fld_${createdAt}`,
        type: "folder",
        title: t("folder.newTitle"),
        children: childIds,
        createdAt,
        updatedAt: createdAt,
        titleUpdatedAt: createdAt,
      };
    },
    moveGroupToIndex,
    pushBackup,
    queuePersist,
    render,
    toast,
    t,
    isRecentGroup: (groupId) => groupId === RECENT_GROUP_ID,
    isAllBookmarksGroup,
    getRootFolderIds,
    qsa,
    qs,
  });
}

/**
 * 创建触摸拖拽状态机实例（能力与依赖见 touch-drag-manager.js），
 * 与 dragManager 通过状态接口协同。
 */
function createTouchDragManagerInstance() {
  return createTouchDragManager({
    dragManager,
    getState: () => ({ activeGroupId, openFolderId }),
    getGrid: (inFolder) => (inFolder ? elements.folderGrid : elements.grid),
    getContainer: () => (openFolderId ? getFolderPlacementContainer(openFolderId) : getActiveGroup()),
    getPlacementList,
    setPlacementList,
    touchPlacementContainer,
    moveNodeInList,
    moveGroupToIndex,
    getRootFolderIds,
    getGroupTabs: () => elements.groupTabs,
    queuePersist,
    render,
    openContextMenu,
    closeContextMenu,
    isRecentGroup: (groupId) => groupId === RECENT_GROUP_ID,
    canStartTileTouch: () => !selectionMgr?.isBatchModeActive(),
  });
}

/**
 * 创建存储变更热监听实例（扩展 onChanged + Web storage 事件双通道）。
 * 自身写入抑制窗口 / 时间戳回声判定 / 设置弹窗挂起补刷全部内聚于监听器。
 */
function createStorageListenerInstance() {
  return createStorageListener({
    dataKey: getStorageKey(),
    syncKeys: [SYNC_STATE_KEY, SYNC_OUTBOX_KEY],
    getData: () => data,
    isPersistInFlight: () => persistenceCoordinator?.isPersistInFlight() || false,
    isSuppressed: () => persistenceCoordinator?.isStorageSuppressed() || false,
    isSettingsOpen: () => settingsOpen,
    reload: () => reloadFromStorage(),
    onSyncKeysChanged: () => void syncBanner?.refresh?.(),
    reloadDelayMs: STORAGE_RELOAD_DELAY_MS,
  });
}

/**
 * 创建核心网格渲染器实例（布局计算 + 卡片 DOM + 事件装配 + 空状态）。
 */
function createGridRendererInstance() {
  return createGridRenderer({
    getElements: () => elements,
    getData: () => data,
    getState: () => ({ activeGroupId, openFolderId }),
    getCurrentNodes,
    getRecentItems: () => recentItems,
    loadIconCache,
    iconManager,
    dragManager,
    touchDrag,
    openModeMgr,
    selectionMgr,
    tooltipMgr,
    historyManager,
    openFolder,
    openUrl,
    openContextMenu,
    toast,
    t,
    isRecentGroup: (groupId) => groupId === RECENT_GROUP_ID,
    qs,
  });
}

/**
 * 创建持久化与时钟协调器实例（串行保存链 / 自动备份 / 时钟基线 / 抑制窗）。
 */
/**
 * 创建国际化管理器实例（语言规范化 / 翻译 / 静态文案注入）。
 */
function createI18nManagerInstance() {
  return createI18nManager({
    getData: () => data,
    getElements: () => elements,
    getActiveGroupId: () => activeGroupId,
    isRecentGroup: (groupId) => groupId === RECENT_GROUP_ID,
  });
}

function createPersistenceCoordinatorInstance() {
  return createPersistenceCoordinator({
    getData: () => data,
    getDeviceId: () => getOrCreateDeviceId(),
    saveData,
    loadDataFromArea,
    schedulePush,
    debugLog,
    shouldDebugPersist,
    storageSuppressMs: STORAGE_SUPPRESS_MS,
    backupIgnoredSettingsKeys: BACKUP_IGNORED_SETTINGS_KEYS,
  });
}

/**
 * 创建节点与分组操作管理器实例（删除/撤销/分组操作/容器导航）。
 */
function createNodeOpsManagerInstance() {
  return createNodeOpsManager({
    getData: () => data,
    getState: () => ({ activeGroupId, openFolderId }),
    setActiveGroupId: (id) => {
      activeGroupId = id;
    },
    getRecentItems: () => recentItems,
    pushBackup,
    queuePersist,
    render,
    toast,
    t,
    getFolderManager: () => folderMgr,
    undoTimeoutMs: 10000,
    isRecentGroup: (groupId) => groupId === RECENT_GROUP_ID,
  });
}

function openFolder(folderId) {
  folderMgr.openFolder(folderId);
}

function closeFolder() {
  folderMgr.closeFolder();
}

/**
 * 创建文件夹覆盖层管理器实例（展开/后退/关闭、重命名、解散回填）。
 */
function createFolderManagerInstance() {
  return createFolderManager({
    getElements: () => elements,
    getData: () => data,
    getOpenFolderId: () => openFolderId,
    setOpenFolderId: (id) => {
      openFolderId = id;
    },
    getActiveGroup,
    getPlacementList,
    setPlacementList,
    touchPlacementContainer,
    markNodeDeleted,
    stampNodeFieldChanges,
    pushBackup,
    queuePersist,
    render,
    toast,
    t,
    getActiveElement: () => document.activeElement,
  });
}

/**
 * 创建侧边栏管理器实例（渲染分组 Tab、折叠状态机、标签同步）。
 */
function createSidebarManagerInstance() {
  return createSidebarManager({
    getElements: () => elements,
    getData: () => data,
    getState: () => ({ activeGroupId, openFolderId }),
    setActiveGroup: (groupId) => {
      activeGroupId = groupId;
    },
    closeFolder: () => {
      openFolderId = null;
    },
    persist: () => queuePersist(),
    render,
    t,
    isRecentGroup: (groupId) => groupId === RECENT_GROUP_ID,
    isAllBookmarksGroup,
    isClickSuppressed: () => !!touchDrag?.isClickSuppressed(),
    bindSidebarFolderEvents: (btn, opts) => dragManager.bindSidebarFolderEvents(btn, opts),
    bindGroupTouchEvents: (btn, opts) => touchDrag.bindGroupTouchEvents(btn, opts),
    openGroupContextMenu,
    qsa,
    getDocumentBody: () => document.body,
  });
}

/**
 * 创建打开方式管理器实例（修饰键/中键判定、双环境打开、模式循环切换）。
 */
function createOpenModeManagerInstance() {
  return createOpenModeManager({
    getData: () => data,
    persist: () => persistData(),
    recordVisit,
    toast,
    t,
    getButton: () => elements.btnOpenMode,
  });
}

/**
 * 创建批量选择管理器实例（能力与依赖见 selection-manager.js）。
 */
function createSelectionManagerInstance() {
  return createSelectionManager({
    getState: () => ({ activeGroupId, openFolderId }),
    getNodes: getCurrentNodes,
    getGrid: (inFolder) => (inFolder ? elements.folderGrid : elements.grid),
    getMain: () => elements.main,
    deleteNodes,
    toast,
    t,
    isRecentGroup: (groupId) => groupId === RECENT_GROUP_ID,
    qsa,
    rafThrottle,
  });
}

/**
 * 创建主题与背景管线实例（能力与依赖见 theme-manager.js）。
 */
function createThemeManagerInstance() {
  return createThemeManager({
    getData: () => data,
    getBackgroundEl: () => elements.background,
    getBingWallpaper,
    isSafeCssColor,
    toast,
    t,
  });
}

async function init() {
  debugLog("init_start", getRuntimeInfo());
  // 国际化管理器最先创建：后续所有 manager 的文案与渲染都依赖 t()
  i18nManager = createI18nManagerInstance();
  // 持久化协调器：后续任何 persist / 重载 / 监听都会用到它的状态
  persistenceCoordinator = createPersistenceCoordinatorInstance();
  nodeOpsManager = createNodeOpsManagerInstance();
  // 图标管线与拖拽管理器先建好（renderGrid / 弹窗 / 存储监听都会用到）
  iconManager = createIconManagerInstance();
  themeMgr = createThemeManagerInstance();
  openModeMgr = createOpenModeManagerInstance();
  sidebarMgr = createSidebarManagerInstance();
  folderMgr = createFolderManagerInstance();
  selectionMgr = createSelectionManagerInstance();
  dragManager = createDragManagerInstance();
  touchDrag = createTouchDragManagerInstance();
  // 网格渲染器依赖以上全部 manager 实例，必须最后创建
  gridRenderer = createGridRendererInstance();
  storageListener = createStorageListenerInstance();
  storageListener.bind();
  // 纯 Web / PWA 模式（无扩展 API 直接打开页面）：数据走 localStorage，扩展专属能力已安全降级
  if (getStorageMode() === "web-local") {
    console.info("[homepage] Web 模式就绪：无扩展环境，数据保存在浏览器 localStorage，历史/标签页等扩展能力已降级");
    // 注册离线 Service Worker（https / localhost 安全上下文时生效）
    void registerServiceWorkerIfNeeded();
  }
  // 设置面板控制器：注入数据访问、共享状态与 UI/业务依赖。
  // 使用 getter 读取 data，保证控制器始终看到最新的主页数据。
  settingsCtl = createSettingsController({
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    getActiveGroupId: () => activeGroupId,
    setActiveGroupId: (id) => {
      activeGroupId = id;
    },
    state: {
      get settingsOpen() {
        return settingsOpen;
      },
      set settingsOpen(value) {
        settingsOpen = value;
      },
      get settingsSaving() {
        return settingsSaving;
      },
      set settingsSaving(value) {
        settingsSaving = value;
      },
      get settingsSaveTimer() {
        return settingsSaveTimer;
      },
      set settingsSaveTimer(value) {
        settingsSaveTimer = value;
      },
      get settingsSaveQueued() {
        return settingsSaveQueued;
      },
      set settingsSaveQueued(value) {
        settingsSaveQueued = value;
      },
      settingsSaveNow: null,
    },
    consumeSkipAutoBackup: () => {
      const value = skipAutoBackupOnce;
      skipAutoBackupOnce = false;
      return value;
    },
    ui: {
      $,
      qsa,
      html,
      rawHtml,
      escapeHtml,
      t,
      currentLang,
      toast,
      elements,
      openModal,
      closeModal,
      runWithButtonState,
      render,
      persistData,
      queuePersist,
      pushBackup,
      processPendingIconFetches: () => iconManager.processPendingIconFetches(),
      loadBackground: (opts) => themeMgr.loadBackground(opts),
      applyDensity: () => themeMgr.applyDensity(),
      applyTheme: () => themeMgr.applyTheme(),
      applyStaticI18n,
      applySidebarState: () => sidebarMgr?.applySidebarState(),
      buildLanguageOptions,
      leaveSettingsForSubpanel,
      readFileAsDataUrl,
      getAppVersion,
      detectExtensionPlatform,
      detectPreferredLanguage,
    },
    deps: {
      normalizeUrl,
      normalizeUrlWithScheme,
      normalizeLanguage,
      normalizeSyncInterval,
      clearData,
      defaultData,
      defaultSettings,
      deepClone,
      cloneDataSnapshot,
      repairHomepageData,
      markNodeDeleted,
      mergeRootBookmarkData,
      mergeHomepage,
      toSyncDocument,
      createItemNode,
      stampNodeFieldChanges,
      resetSettingsClockBaseline,
      resetPlacementClockBaseline,
      getRootGroup,
      getRootContainers,
      getRootContainerById,
      getPlacementList,
      setPlacementList,
      touchPlacementContainer,
      isAllBookmarksGroup,
      refreshAllIcons: (nodes) => iconManager.batchRefreshAllIcons(nodes),
      syncBytesBudgetLevel,
      estimateSyncProjectionBytes,
      createDocId,
      getOrCreateDeviceId,
      getSyncStatus,
      getPendingConflict,
      reloadSyncState,
      resolveDocConflict,
      pullNow,
      pushNow,
      onSyncEnabledChanged,
      refreshSyncInterval,
      cancelScheduledPush,
      exportSyncBundle,
      importSyncBundle,
      httpHealth,
      httpPullState,
      httpGetDevices,
      httpRetireDevice,
      ensureDevicePairing,
      exportNetscapeBookmarksHtml,
      parseNetscapeBookmarksHtml,
      bookmarksToHomepageData,
      ALL_BOOKMARKS_GROUP_ID,
      RECENT_GROUP_ID,
      SYNC_INTERVAL_OPTIONS,
      DEFAULT_TOAST_DURATION_SECONDS,
      SETTINGS_SAVE_DELAY_MS,
    },
  });

  initSyncEngine({
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    saveLocal: async (next) => {
      pruneSyncTombstones(next);
      return saveData(next, false);
    },
    createSafetySnapshot: async () => {
      try {
        pushBackup();
      } catch (e) {
        console.warn("sync safety pushBackup failed", e);
      }
    },
    onMerged: async (_next, stats) => {
      // merge 成功几乎总会 applied；仅当远端 revision 推进，或用户选了「用云端」才提示
      if (stats?.applied) {
        resetSettingsClockBaseline(data);
        resetPlacementClockBaseline(data);
        if (stats.remoteNewer || stats.choice === "remote") {
          // 频率限制：多设备互相推送时不至于每次刷新都弹
          toastSyncMergedOnce();
        }
        // render() 内部会重新应用主题/密度/背景，覆盖远端改的「副作用型」设置
        render();
        iconManager.processPendingIconFetches();
      }
    },
  });
  // Safari 无系统 history：在新标签页也挂 tabs 监听作为兜底
  try {
    attachVisitTracking();
  } catch (e) {
    console.warn("attachVisitTracking failed", e);
  }
  listenForExternalToast();
  // 历史管理器先建好，再并行 loadData 与拉取最近历史，减少首屏等待
  historyManager = createHistoryManagerInstance();
  const recentPromise = historyManager.fetchRecentHistory();
  const localData = await loadData();
  debugLog("init_local", {
    groups: localData.groups?.length || 0,
    nodes: Object.keys(localData.nodes || {}).length,
    lastUpdated: localData.lastUpdated || 0,
    syncEnabled: !!localData.settings?.syncEnabled,
  });
  data = localData;
  const deduped = dedupeData(data);
  const languageInitialized = ensureLanguageSetting();
  if (deduped || languageInitialized) {
    await saveData(data, false);
  }
  syncBackupBaseline(data);
  resetSettingsClockBaseline(data);
  resetPlacementClockBaseline(data);
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
  } else if (preferredGroupId && getRootContainerById(preferredGroupId)) {
    activeGroupId = preferredGroupId;
  } else {
    activeGroupId = getRootGroup()?.id || RECENT_GROUP_ID;
    data.settings.lastActiveGroupId = activeGroupId;
  }
  recentItems = await recentPromise;
  themeMgr.applyDensity();
  themeMgr.applyTheme();
  sidebarMgr?.applySidebarState();
  closeModal();
  closeFolder();
  // 先渲染 UI，图标走缓存瞬显；背景和图标重试后台异步进行，不阻塞首屏
  render();
  iconManager.processPendingIconFetches();
  themeMgr.loadBackground({ silent: true });
  retryFailedIconsIfDue(data.settings);
  void consumeSaveToast();
  // 缓存瘦身：首屏渲染后异步执行，不阻塞加载。
  // 清理已删书签残留的图标缓存，以及背景非 bing 时无用的壁纸缓存（实测单张 442KB）。
  void pruneCachesQuietly();
  if (data.settings.syncEnabled) {
    refreshSyncInterval();
    // 同步异常提示条：让失败可见（此前断链两个月无人察觉）。
    // 重试走手动 pushNow —— 它不受 outbox attempts 上限限制，是用户的唯一自救入口。
    syncBanner = createSyncBanner({
      getState: () => reloadSyncState(),
      getOutbox: () => getOutboxSummary(),
      onRetry: async () => {
        // 先拉一次拿到最新基线（顺带刷 etag），再推本地；手动推送不受 outbox attempts 上限限制。
        await pullNow("banner_retry");
        return pushNow("banner_retry");
      },
      // openSettingsModal 由 settings-controller 提供，app.js 侧只能经 settingsCtl 访问
      onOpenSettings: () => settingsCtl?.openSettingsModal(),
      getStorage: () => getChromeApi()?.storage?.local,
      t: (k, vars) => t(k, vars),
    });
    void syncBanner.start();
    // 「同步间隔 = 关闭」只表示不做周期轮询，**不代表打开页面也不看云端**。
    // 早先这里用 interval !== "off" 把首拉也一起关掉了，结果是：
    // 别的设备改了背景/设置，本机只要不手动点「立即同步」就永远收不到，
    // 看起来就是「在 Chrome 改了渐变，Safari/火狐一点变化都没有」。
    // 打开页面拉一次只是一次轻量 GET；远端没变会直接短路返回，不会重绘也不会碰壁纸。
    void (async () => {
      try {
        const pull = await pullNow("init");
        if (pull?.needPush) await pushNow("init_need_push");
        // 离线时由本地变更产生的待发送项仍可在打开页面后重试。
        await flushOutbox();
        render();
      } catch (e) {
        console.warn("init sync failed", e);
      } finally {
        // 首次同步结束后刷新提示条：此时才拿到真实结果
        void syncBanner?.refresh?.();
      }
    })();
  }
}

function render() {
  ensureAllBookmarksGroup(data);
  applyStaticI18n();
  sidebarMgr?.applySidebarState();
  sidebarMgr?.renderGroups();
  gridRenderer?.renderGrid();
  // 网格渲染后统一刷新空态（含历史分组的不可用/无数据提示）
  gridRenderer?.updateEmptyState();
  elements.topSearchWrap.classList.toggle("hidden", !data.settings.showSearch);
  elements.emptyHintToggle.checked = data.settings.emptyHintDisabled;
  elements.btnFolderDissolve.classList.remove("hidden");
  openModeMgr?.updateToolbarButton();
  selectionMgr?.updateControls();
  // 收口在这里：主题/密度/背景都是「副作用型」设置，不经过渲染流程。
  // 导入、恢复备份、清空数据、同步合并、跨标签页重载最终都会走到 render()，
  // 统一在这里重新应用，才能避免「设置变了但页面要手动切一次才生效」这一类问题。
  themeMgr?.applyThemeAndDensity();
  void themeMgr?.refreshBackgroundIfChanged?.();
}

function bindEvents() {
  window.addEventListener(
    "resize",
    rafThrottle(() => render()),
  );

  elements.btnAdd.addEventListener("click", openAddModal);
  elements.btnFolderAdd.addEventListener("click", openAddModal);
  elements.btnToggleSidebar?.addEventListener("click", () => {
    data.settings.sidebarCollapsed = !data.settings.sidebarCollapsed;
    sidebarMgr?.applySidebarState();
    queuePersist();
  });
  elements.recentTab.addEventListener("click", async () => {
    activeGroupId = RECENT_GROUP_ID;
    openFolderId = null;
    data.settings.lastActiveGroupId = activeGroupId;
    queuePersist();
    recentItems = await historyManager.fetchRecentHistory();
    render();
  });
  elements.btnAddGroup.addEventListener("click", () => {
    const folderId = `fld_${Date.now()}`;
    const createdAt = Date.now();
    data.nodes[folderId] = {
      id: folderId,
      type: "folder",
      title: t("group.new"),
      children: [],
      createdAt,
      updatedAt: createdAt,
      titleUpdatedAt: createdAt,
    };
    const root = getRootGroup();
    root.nodes.push(folderId);
    touchPlacementContainer(root);
    activeGroupId = folderId;
    data.settings.lastActiveGroupId = activeGroupId;
    queuePersist();
    render();
  });

  // 批量选择交互（按钮/框选/空白清除）统一由 selection-manager 处理
  selectionMgr.bindBatchButtons();
  selectionMgr.bindBoxSelectEvents();
  selectionMgr.bindBlankClickClear();

  // 打开方式循环切换（open-mode-manager.js）
  openModeMgr.bindButton();
  elements.btnSettings.addEventListener("click", async () => {
    if (settingsOpen) {
      closeModal();
      return;
    }
    settingsCtl.openSettingsModal();
  });
  // 顶部搜索：实时过滤（拼音）、Enter/按钮跳搜索引擎、Escape 恢复全量
  searchManager = createSearchManagerInstance();
  searchManager.bind();

  elements.emptyHintToggle.addEventListener("change", async (e) => {
    data.settings.emptyHintDisabled = e.target.checked;
    await persistData();
    render();
  });

  // 文件夹覆盖层生命周期（返回/解散/空白关闭）统一由 folder-manager 处理
  folderMgr.bindOverlayEvents();

  elements.modalOverlay.addEventListener("click", async (e) => {
    if (e.target !== elements.modalOverlay) return;
    if (modalPointerDownInsideDialog) {
      modalPointerDownInsideDialog = false;
      return;
    }
    if (settingsOpen) {
      closeModal();
      return;
    }
    closeModal();
  });
  const markModalPointerOrigin = (e) => {
    modalPointerDownInsideDialog = !!e.target.closest("#modal");
  };
  elements.modalOverlay.addEventListener("mousedown", markModalPointerOrigin);
  elements.modalOverlay.addEventListener("pointerdown", markModalPointerOrigin);

  document.addEventListener("click", (e) => {
    if (!elements.contextMenu.contains(e.target)) closeContextMenu();
  });

  document.addEventListener(
    "mousemove",
    rafThrottle((e) => {
      if (!elements.tooltip.classList.contains("hidden")) {
        elements.tooltip.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY + 12}px, 0)`;
      }
    }),
  );

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
    // 弹窗打开时：Enter 交给 modal 内逻辑；不跑网格键盘导航
    const modalOpen = elements.modalOverlay && !elements.modalOverlay.classList.contains("hidden");
    if (modalOpen && e.key === "Enter") {
      // 搜索仍允许（不在 modal 内）
      return;
    }

    if (!data?.settings?.keyboardNav) return;
    // 输入框内不劫持方向键
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) {
      if (e.key === "Escape" && openFolderId) closeFolder();
      return;
    }
    if (e.key === "Escape" && openFolderId) {
      closeFolder();
      return;
    }
    if (e.key === "/") {
      // 弹窗打开时不要抢焦点到搜索
      if (modalOpen) return;
      elements.topSearch.focus();
      e.preventDefault();
      return;
    }
    // 方向键 / Home / End 在可见卡片间漫游焦点；Delete 删除聚焦卡片
    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key) ||
      e.key === "Delete" ||
      e.key === "Backspace"
    ) {
      if (modalOpen) return;
      const grid = openFolderId ? elements.folderGrid : elements.grid;
      // 只在可见卡片间漫游：被搜索过滤隐藏的卡片不参与
      const tiles = qsa(".tile", grid).filter(
        (tile) => tile.style.display !== "none" && tile.getClientRects().length > 0,
      );
      if (e.key === "Delete" || e.key === "Backspace") {
        const active = document.activeElement;
        const idx = tiles.indexOf(active);
        if (idx < 0) return;
        const nodeId = active.dataset?.id;
        if (!nodeId || activeGroupId === RECENT_GROUP_ID) return;
        e.preventDefault();
        deleteNodes([nodeId]);
        // 删除后把焦点移到同位置的下一个卡片，漫游不中断
        tiles[Math.min(idx, tiles.length - 1)]?.focus?.();
        return;
      }
      if (!tiles.length) return;
      const cols = Math.max(1, Number.parseInt(getComputedStyle(grid).gridTemplateColumns.split(" ").length, 10) || 1);
      const idx = tiles.indexOf(document.activeElement);
      const next = nextGridFocusIndex({ index: idx, columns: cols, count: tiles.length, key: e.key });
      if (next >= 0) {
        tiles[next]?.focus?.();
        e.preventDefault();
      }
    }
  });

  // 触摸拖拽全局监听（状态机见 touch-drag-manager.js）
  touchDrag.bindDocumentTouchEvents();

  // 网格空白区投放（主网格 / 文件夹覆盖层）与侧栏分组容器拖拽，统一由 drag-manager 处理
  dragManager.bindGridDropEvents(elements.grid, {
    getContainer: () => getActiveGroup(),
    enabled: () => !openFolderId && activeGroupId !== RECENT_GROUP_ID,
  });
  dragManager.bindGridDropEvents(elements.folderGrid, {
    getContainer: () => getFolderPlacementContainer(openFolderId),
    enabled: () => !!openFolderId,
  });

  dragManager.bindGroupTabsEvents(elements.groupTabs);
}

(async () => {
  try {
    await init();
    bindEvents();
    // 标记完整初始化完成，诊断和冒烟测试据此确认事件已绑定。
    document.documentElement.dataset.homepageReady = "true";
  } catch (error) {
    console.error("homepage init failed", error);
    if (typeof window !== "undefined" && typeof window.__homepageRenderFatalError === "function") {
      window.__homepageRenderFatalError(
        "我的首页启动失败",
        error?.stack || error?.message || String(error || "未知错误"),
      );
    }
  }
})();
