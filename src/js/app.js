import { getBingWallpaper } from "./bing-wallpaper.js";
import {
  buildBackupFingerprint,
  cloneDataSnapshot,
  collectNodeSubtreeIds,
  createItemNode,
  dedupeData,
  isSafeCssColor,
  moveNodeInList,
  repairHomepageData,
} from "./data-utils.js";
import {
  applyFailureToCache,
  avatarDataUrl,
  clearIconCacheForUrl,
  fetchAsDataUrl,
  getFaviconCandidates,
  getSiteKey,
  hashColor,
  probeImage,
  refreshAllIcons,
  resolveIcon,
  retryFailedIconsIfDue,
  withIconFetchConcurrency,
} from "./icons.js";
import { normalizeUrl, SAFE_URL_PROTOCOLS } from "./shared-utils.js";
import {
  clearData,
  createBackupSnapshot,
  deepClone,
  defaultData,
  defaultSettings,
  detectPreferredLanguage,
  getChromeApi,
  getStorageKey,
  loadData,
  loadDataFromArea,
  loadIconCache,
  normalizeLanguage,
  saveData,
  saveIconCache,
} from "./storage.js";
import { exportSyncBundle, importSyncBundle } from "./sync_bundle.js";
import {
  flushOutbox,
  getSyncStatus,
  initSyncEngine,
  onSyncEnabledChanged,
  pullNow,
  pushNow,
  schedulePull,
  schedulePush,
} from "./sync_engine.js";
import { httpHealth, httpPullState } from "./sync_http_transport.js";
import { createDocId, getOrCreateDeviceId } from "./sync_ids.js";
import { syncBytesBudgetLevel } from "./sync_policy.js";
import { estimateSyncProjectionBytes } from "./sync_projection.js";
import { attachVisitTracking, getVisitHistoryItems, recordVisit } from "./visit-history.js";

const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * 标记一段已经安全的 HTML 字符串，避免被 html 模板标签二次转义。
 * 仅用于由 html 模板标签自身生成的片段，禁止包裹用户输入。
 */
const rawHtml = (value) => ({ __rawHtml: true, value: String(value) });

/**
 * 安全的 HTML 模板标签：自动转义所有插值，避免 XSS。
 * 静态模板中的 HTML 标记保留；只有 ${...} 中的值会被转义。
 * 若插值为 rawHtml() 返回的对象，则直接拼接其 value，用于组合嵌套模板。
 */
const html = (strings, ...values) => {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      const value = values[i];
      if (value && typeof value === "object" && value.__rawHtml) {
        result += value.value;
      } else {
        result += escapeHtml(value);
      }
    }
  }
  return result;
};
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
let activeGroupId = null;
let openFolderId = null;
let selectionMode = false;
let selectedIds = new Set();
let pendingDeletion = null;
let tooltipTimer = null;
let dragState = null;
let lastSelectedIndex = null;
let recentItems = [];
/** @type {"unknown"|"ok"|"missing"|"error"} */
let historyApiStatus = "unknown";
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
let _settingsSaveNow = null;
let renderSeq = 0;
let lastMainLayout = null;
let storageReloadTimer = null;
let pendingStorageReload = false;
let suppressStorageUntil = 0;
let persistInFlight = 0;
let backupFingerprint = "";
let backupBaselineSnapshot = null;
let skipAutoBackupOnce = false;
let suppressTouchClickUntil = 0;
let modalPointerDownInsideDialog = false;
const touchDragState = {
  mode: "",
  timer: null,
  active: false,
  sourceId: "",
  sourceTile: null,
  targetTile: null,
  sourceGroupId: "",
  sourceGroupBtn: null,
  targetGroupBtn: null,
  startX: 0,
  startY: 0,
  x: 0,
  y: 0,
};
const touchMenuState = {
  timer: null,
  active: false,
  node: null,
  startX: 0,
  startY: 0,
  x: 0,
  y: 0,
};
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
const TOUCH_TILE_CONTEXT_MENU_MS = 1000;
const TOUCH_TILE_LONG_PRESS_MS = 3000;
const TOUCH_GROUP_LONG_PRESS_MS = 260;
const TOUCH_DRAG_MOVE_THRESHOLD = 18;
const TOUCH_CLICK_SUPPRESS_MS = 400;
const BACKUP_IGNORED_SETTINGS_KEYS = new Set(["lastActiveGroupId", "lastSaveUrl", "lastSaveTs", "lastSaveToast"]);

const densityMap = {
  compact: { gap: 10 },
  standard: { gap: 16 },
  spacious: { gap: 22 },
};
const _bgOverlayMap = {
  light: "rgba(245, 246, 250, 0.85)",
  dark: "rgba(12, 15, 20, 0.72)",
};

const APP_SUPPORTED_LANGUAGES = [
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "正體中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
];

const I18N = {
  "zh-CN": {
    "app.title": "我的首页",
    "search.placeholder": "搜索标题或网址...",
    "search.button": "搜索",
    "toolbar.add": "新增",
    "toolbar.batchDelete": "批量删",
    "toolbar.selectAll": "全选",
    "toolbar.settings": "设置",
    "toolbar.openMode": "打开方式",
    "sidebar.history": "历史",
    "sidebar.addGroup": "新增分组",
    "sidebar.collapse": "收起",
    "sidebar.expand": "展开",
    "empty.title": "还没有快捷按钮",
    "empty.desc": "点击右上角【新增】来添加卡片。如果有备份，可以去【设置】恢复备份",
    "empty.hideHint": "不再提示",
    "history.empty.title": "暂无最近历史",
    "history.empty.desc": "最近 7 天内没有可显示的访问记录，或浏览器未返回历史数据。",
    "history.fallback.desc":
      "Safari 无法读取系统浏览历史。已启用扩展内「最近访问」记录：请先用 Safari 打开一些网页，再回到此页查看。",
    "history.unavailable.title": "无法读取浏览器历史",
    "history.unavailable.desc":
      "当前浏览器未提供可用的 history API，或扩展未获得历史权限。Safari 需在扩展设置中允许相关权限后重试。",
    "folder.defaultTitle": "文件夹",
    "folder.back": "返回",
    "folder.add": "新增",
    "folder.batchDelete": "批量删除",
    "folder.dissolve": "解散文件夹",
    "context.openCurrent": "本页打开",
    "context.openNew": "新页打开",
    "context.openBackground": "后台打开",
    "context.addToShortcuts": "添加到快捷",
    "context.openFolder": "打开文件夹",
    "context.dissolveFolder": "解散文件夹",
    "context.edit": "编辑",
    "context.delete": "删除",
    "context.renameGroup": "重命名",
    "context.deleteGroup": "删除分组",
    "openMode.current": "本页打开",
    "openMode.new": "新页打开",
    "openMode.background": "后台打开",
    "openMode.saveFailed": "打开方式保存失败，已恢复",
    "settings.saved": "设置已保存",
    "settings.language": "语言",
    "settings.action.export": "导出设置",
    "settings.action.import": "导入设置",
    "settings.action.importUrl": "导入网址",
    "settings.action.backup": "备份管理",
    "settings.action.clearData": "清空数据",
    "settings.action.clearCards": "删除所有分组、卡片",
    "settings.action.refreshIcons": "刷新所有图标",
    "settings.action.refreshingIcons": "刷新中",
    "settings.showSearch": "显示顶部搜索框",
    "settings.searchEngine": "搜索引擎",
    "settings.searchEngine.custom": "自定义",
    "settings.fixedLayout": "固定列数",
    "settings.tileGap": "卡片间隙",
    "settings.density.compact": "紧凑",
    "settings.density.standard": "标准",
    "settings.density.spacious": "宽松",
    "settings.background": "背景",
    "settings.background.bing": "每日 Bing",
    "settings.background.color": "纯色",
    "settings.background.gradient": "渐变",
    "settings.background.custom": "自定义图片",
    "settings.gradientColor": "渐变颜色",
    "settings.bgOverlay": "背景遮罩",
    "settings.tooltip": "显示提示",
    "settings.keyboard": "启用键盘导航",
    "settings.theme": "主题颜色",
    "settings.theme.system": "跟随系统",
    "settings.theme.light": "浅色",
    "settings.theme.dark": "深色",
    "settings.fontSize": "字体大小",
    "settings.defaultGroup": "浏览网页时插件保存网页到分组",
    "settings.lastAddedGroup": "上次添加的分组",
    "settings.hideSidebar": "完全隐藏侧边栏",
    "settings.sync": "启用同步",
    "settings.sync.size": "同步数据约 {size}",
    "settings.sync.budget.green": "体积正常",
    "settings.sync.budget.yellow": "接近上限，建议精简",
    "settings.sync.budget.red": "可能超出同步配额",
    "settings.sync.exportBundle": "导出同步包",
    "settings.sync.importBundle": "导入并合并同步包",
    "settings.sync.exportOk": "同步包已复制到剪切板",
    "settings.sync.importOk": "同步包已合并",
    "settings.sync.importFail": "同步包合并失败：{reason}",
    "settings.sync.hint": "浏览器账号同步或自建 HTTP 服务；不含备份/壁纸/上传图标。跨浏览器也可用同步包/自建服。",
    "settings.sync.transport": "同步方式",
    "settings.sync.transport.browser": "浏览器账号",
    "settings.sync.transport.http": "自建服务器 (HTTP)",
    "settings.sync.serverUrl": "服务器 URL",
    "settings.sync.serverToken": "Token（可选）",
    "settings.sync.serverUrlPh": "http://127.0.0.1:8787",
    "settings.sync.testServer": "测试连接",
    "settings.sync.testOk": "服务器可用",
    "settings.sync.testFail": "连接失败：{reason}",
    "settings.sync.unauthorized": "鉴权失败：Token 与服务器不匹配（服务器未设置 TOKEN 时可留空）",
    "settings.sync.now": "立即同步",
    "settings.sync.nowOk": "同步完成",
    "settings.sync.state.off": "未启用",
    "settings.sync.state.idle": "已启用",
    "settings.sync.state.syncing": "同步中",
    "settings.sync.state.quota": "配额不足",
    "settings.sync.state.error": "同步出错",
    "settings.sync.state.conflict": "需处理数据冲突",
    "settings.sync.conflict.title": "同步数据冲突",
    "settings.sync.conflict.desc": "云端与本机不是同一份主页数据。请选择如何处理：",
    "settings.sync.conflict.merge": "合并两边",
    "settings.sync.conflict.local": "本机覆盖云端",
    "settings.sync.conflict.remote": "云端替换本机",
    "settings.sync.conflict.done": "冲突已处理",
    "settings.sync.exportFile": "导出到文件",
    "settings.sync.importFile": "从文件导入",
    "settings.sync.safariHint": "当前为 Safari：浏览器账号同步能力较弱，推荐使用「同步包」在设备间拷贝数据。",
    "settings.openMode": "网页打开方式",
    "settings.maxBackups": "最大备份数量（0 表示不备份）",
    "settings.iconRetry": "重新获取失败图标（每天）",
    "settings.retryDisabled": "不启用",
    "confirm.clearData": "确认清空全部数据？",
    "confirm.clearCards": "确认删除所有分组与快捷按钮？（设置将保留）",
    "toast.cleared": "已清空",
    "toast.cardsCleared": "已删除所有分组与快捷按钮，可在【备份管理】中恢复",
    "toast.iconsRefreshed": "图标刷新完成",
    "toast.savedToGroup": "已保存到分组：{name}",
    "common.unnamed": "未命名",
    "background.fetchFailedCache": "壁纸获取失败，已回退到缓存",
    "background.updatedToday": "已更新今日 Bing 壁纸",
    "background.failedDefault": "壁纸获取失败，已使用默认背景",
    "group.default": "默认",
    "group.new": "新分组",
    "group.promptName": "分组名称",
    "group.keepOne": "至少保留一个分组",
    "group.deleteConfirm": "删除分组「{name}」？",
    "delete.deletedCount": "已删除 {count} 个快捷按钮",
    "delete.undo": "撤销",
    "delete.restored": "已恢复",
    "history.batchDeleteDisabled": "历史不可批量删除",
    "selection.modeEnabled": "进入批量选择模式",
    "modal.add.title": "新增快捷按钮",
    "modal.edit.title": "编辑",
    "field.url": "网址",
    "field.title": "标题",
    "field.titleOptional": "可选",
    "field.iconSource": "图标来源",
    "field.icon.auto": "自动抓取 favicon",
    "field.icon.upload": "上传图标",
    "field.icon.color": "颜色头像",
    "field.icon.remote": "远程图标 URL",
    "field.icon.fetchNow": "立即抓取图标",
    "field.icon.fetching": "抓取中…",
    "field.icon.fetchOk": "图标已更新",
    "field.icon.fetchFail": "图标抓取失败",
    "field.fromTab": "从当前标签页添加",
    "common.cancel": "取消",
    "common.save": "保存",
    "field.uploadIcon": "上传图标",
    "field.colorAvatar": "头像颜色",
    "field.remoteIconUrl": "远程图标 URL",
    "error.invalidUrl": "URL 不合法",
    "error.invalidUrlSimple": "URL 无效",
    "error.saveQuota": "保存失败：本地存储空间不足",
    "toast.add.success": "新增成功",
    "toast.add.trimBackup": "新增成功（已清理备份以释放空间）",
    "toast.add.trimIcons": "新增成功（已重置上传图标以释放空间）",
    "toast.add.trimBackground": "新增成功（已清理自定义背景以释放空间）",
    "toast.add.syncFallback": "新增成功（同步空间不足，已保存到本地）",
    "toast.add.syncWriteFailed": "新增成功（同步写入失败，已关闭同步并保存到本地）",
    "toast.save.success": "保存成功",
    "toast.save.trimBackup": "保存成功（已清理备份以释放空间）",
    "toast.save.trimIcons": "保存成功（已重置上传图标以释放空间）",
    "toast.save.trimBackground": "保存成功（已清理自定义背景以释放空间）",
    "toast.save.syncFallback": "保存成功（同步空间不足，已保存到本地）",
    "toast.save.syncWriteFailed": "保存成功（同步写入失败，已关闭同步并保存到本地）",
    "toast.syncOverwritten": "检测到另一设备更新了更新的数据，本地未保存的改动可能已被覆盖",
    "tile.folderSuffix": "（文件夹）",
    "folder.newTitle": "新建文件夹",
    "folder.created": "已创建文件夹",
    "folder.added": "已加入文件夹",
    "folder.dissolved": "已解散文件夹",
    "group.noneAvailable": "没有可用分组",
    "group.notFound": "分组不存在",
    "common.selectGroup": "选择分组",
    "toast.addedToShortcuts": "已添加到快捷",
    "import.noUrls": "没有可导入的网址",
  },
  "zh-TW": {
    "app.title": "我的首頁",
    "search.placeholder": "搜尋標題或網址...",
    "search.button": "搜尋",
    "toolbar.add": "新增",
    "toolbar.batchDelete": "批次刪除",
    "toolbar.selectAll": "全選",
    "toolbar.settings": "設定",
    "toolbar.openMode": "開啟方式",
    "sidebar.history": "歷史",
    "sidebar.addGroup": "新增分組",
    "sidebar.collapse": "收起",
    "sidebar.expand": "展開",
    "empty.title": "還沒有快捷按鈕",
    "empty.desc": "點擊右上角【新增】新增卡片。如有備份可在【設定】還原",
    "empty.hideHint": "不再提示",
    "history.empty.title": "暫無最近歷史",
    "history.empty.desc": "最近 7 天內沒有可顯示的造訪記錄，或瀏覽器未回傳歷史資料。",
    "history.fallback.desc":
      "Safari 無法讀取系統瀏覽歷史。已啟用擴充功能內「最近造訪」記錄：請先用 Safari 開啟一些網頁，再回到此頁查看。",
    "history.unavailable.title": "無法讀取瀏覽器歷史",
    "history.unavailable.desc":
      "目前瀏覽器未提供可用的 history API，或擴充功能未取得歷史權限。Safari 需在擴充功能設定中允許相關權限後重試。",
    "folder.defaultTitle": "資料夾",
    "folder.back": "返回",
    "folder.add": "新增",
    "folder.batchDelete": "批次刪除",
    "folder.dissolve": "解散資料夾",
    "openMode.current": "本頁開啟",
    "openMode.new": "新頁開啟",
    "openMode.background": "背景開啟",
    "settings.saved": "設定已儲存",
    "settings.language": "語言",
    "settings.action.export": "匯出設定",
    "settings.action.import": "匯入設定",
    "settings.action.importUrl": "匯入網址",
    "settings.action.backup": "備份管理",
    "settings.action.clearData": "清空資料",
    "settings.action.clearCards": "刪除所有分組、卡片",
    "settings.action.refreshIcons": "重新整理所有圖示",
    "settings.action.refreshingIcons": "重新整理中",
    "settings.showSearch": "顯示頂部搜尋框",
    "settings.searchEngine": "搜尋引擎",
    "settings.searchEngine.custom": "自訂",
    "settings.fixedLayout": "固定欄數",
    "settings.tileGap": "卡片間距",
    "settings.density.compact": "緊湊",
    "settings.density.standard": "標準",
    "settings.density.spacious": "寬鬆",
    "settings.background": "背景",
    "settings.background.bing": "每日 Bing",
    "settings.background.color": "純色",
    "settings.background.gradient": "漸層",
    "settings.background.custom": "自訂圖片",
    "settings.gradientColor": "漸層顏色",
    "settings.bgOverlay": "背景遮罩",
    "settings.tooltip": "顯示提示",
    "settings.keyboard": "啟用鍵盤導覽",
    "settings.theme": "主題顏色",
    "settings.theme.system": "跟隨系統",
    "settings.theme.light": "淺色",
    "settings.theme.dark": "深色",
    "settings.fontSize": "字體大小",
    "settings.defaultGroup": "瀏覽網頁時插件保存網頁到分組",
    "settings.lastAddedGroup": "上次新增的分組",
    "settings.hideSidebar": "完全隱藏側邊欄",
    "settings.sync": "啟用同步",
    "settings.sync.size": "同步資料約 {size}",
    "settings.sync.budget.green": "體積正常",
    "settings.sync.budget.yellow": "接近上限，建議精簡",
    "settings.sync.budget.red": "可能超出同步配額",
    "settings.sync.exportBundle": "匯出同步包",
    "settings.sync.importBundle": "匯入並合併同步包",
    "settings.sync.exportOk": "同步包已複製到剪貼簿",
    "settings.sync.importOk": "同步包已合併",
    "settings.sync.importFail": "同步包合併失敗：{reason}",
    "settings.sync.hint": "瀏覽器帳號同步或自建 HTTP 服務；不含備份/桌布/上傳圖示。跨瀏覽器也可用同步包/自建服。",
    "settings.sync.transport": "同步方式",
    "settings.sync.transport.browser": "瀏覽器帳號",
    "settings.sync.transport.http": "自建伺服器 (HTTP)",
    "settings.sync.serverUrl": "伺服器 URL",
    "settings.sync.serverToken": "Token（可選）",
    "settings.sync.serverUrlPh": "http://127.0.0.1:8787",
    "settings.sync.testServer": "測試連線",
    "settings.sync.testOk": "伺服器可用",
    "settings.sync.testFail": "連線失敗：{reason}",
    "settings.sync.unauthorized": "鑑權失敗：Token 與伺服器不匹配（伺服器未設定 TOKEN 時可留空）",
    "settings.sync.now": "立即同步",
    "settings.sync.nowOk": "同步完成",
    "settings.sync.state.off": "未啟用",
    "settings.sync.state.idle": "已啟用",
    "settings.sync.state.syncing": "同步中",
    "settings.sync.state.quota": "配額不足",
    "settings.sync.state.error": "同步出錯",
    "settings.sync.state.conflict": "需處理資料衝突",
    "settings.sync.conflict.title": "同步資料衝突",
    "settings.sync.conflict.desc": "雲端與本機不是同一份主頁資料。請選擇如何處理：",
    "settings.sync.conflict.merge": "合併兩邊",
    "settings.sync.conflict.local": "本機覆蓋雲端",
    "settings.sync.conflict.remote": "雲端取代本機",
    "settings.sync.conflict.done": "衝突已處理",
    "settings.sync.exportFile": "匯出到檔案",
    "settings.sync.importFile": "從檔案匯入",
    "settings.sync.safariHint": "目前為 Safari：瀏覽器帳號同步能力較弱，建議使用「同步包」在裝置間拷貝資料。",
    "settings.openMode": "網頁開啟方式",
    "settings.maxBackups": "最大備份數量（0 代表不備份）",
    "settings.iconRetry": "重新取得失敗圖示（每日）",
    "settings.retryDisabled": "不啟用",
    "confirm.clearData": "確認清空全部資料？",
    "confirm.clearCards": "確認刪除所有分組與快捷按鈕？（設定將保留）",
    "toast.cleared": "已清空",
    "toast.cardsCleared": "已刪除所有分組與快捷按鈕，可在【備份管理】中還原",
    "toast.iconsRefreshed": "圖示已重新整理",
    "group.default": "預設",
    "group.new": "新分組",
  },
  en: {
    "app.title": "My Homepage",
    "search.placeholder": "Search title or URL...",
    "search.button": "Search",
    "toolbar.add": "Add",
    "toolbar.batchDelete": "Batch Delete",
    "toolbar.selectAll": "Select All",
    "toolbar.settings": "Settings",
    "toolbar.openMode": "Open Mode",
    "sidebar.history": "History",
    "sidebar.addGroup": "Add Group",
    "sidebar.collapse": "Collapse",
    "sidebar.expand": "Expand",
    "empty.title": "No shortcuts yet",
    "empty.desc": "Click Add on the top right to create cards. Restore backups in Settings if needed.",
    "empty.hideHint": "Do not show again",
    "history.empty.title": "No recent history",
    "history.empty.desc": "No visits in the last 7 days, or the browser returned no history data.",
    "history.fallback.desc":
      "Safari cannot read system browsing history. Extension-local recent visits are enabled: open some pages in Safari, then return here.",
    "history.unavailable.title": "History unavailable",
    "history.unavailable.desc":
      "This browser has no usable history API, or the extension lacks history permission. On Safari, allow the permission in extension settings and retry.",
    "folder.defaultTitle": "Folder",
    "folder.back": "Back",
    "folder.add": "Add",
    "folder.batchDelete": "Batch Delete",
    "folder.dissolve": "Dissolve Folder",
    "context.openCurrent": "Open Here",
    "context.openNew": "Open in New Tab",
    "context.openBackground": "Open in Background",
    "context.addToShortcuts": "Add to Shortcuts",
    "context.openFolder": "Open Folder",
    "context.dissolveFolder": "Dissolve Folder",
    "context.edit": "Edit",
    "context.delete": "Delete",
    "context.renameGroup": "Rename",
    "context.deleteGroup": "Delete Group",
    "openMode.current": "Open Here",
    "openMode.new": "Open in New Tab",
    "openMode.background": "Open in Background",
    "openMode.saveFailed": "Failed to save open mode, restored",
    "settings.saved": "Settings saved",
    "settings.language": "Language",
    "settings.action.export": "Export Settings",
    "settings.action.import": "Import Settings",
    "settings.action.importUrl": "Import URLs",
    "settings.action.backup": "Backup Manager",
    "settings.action.clearData": "Clear Data",
    "settings.action.clearCards": "Delete All Groups/Cards",
    "settings.action.refreshIcons": "Refresh All Icons",
    "settings.action.refreshingIcons": "Refreshing…",
    "settings.showSearch": "Show Top Search",
    "settings.searchEngine": "Search Engine",
    "settings.searchEngine.custom": "Custom",
    "settings.fixedLayout": "Fixed Columns",
    "settings.tileGap": "Card Gap",
    "settings.density.compact": "Compact",
    "settings.density.standard": "Standard",
    "settings.density.spacious": "Spacious",
    "settings.background": "Background",
    "settings.background.bing": "Daily Bing",
    "settings.background.color": "Color",
    "settings.background.gradient": "Gradient",
    "settings.background.custom": "Custom Image",
    "settings.gradientColor": "Gradient Colors",
    "settings.bgOverlay": "Overlay",
    "settings.tooltip": "Show Tooltip",
    "settings.keyboard": "Enable Keyboard Navigation",
    "settings.theme": "Theme",
    "settings.theme.system": "System",
    "settings.theme.light": "Light",
    "settings.theme.dark": "Dark",
    "settings.fontSize": "Font Size",
    "settings.defaultGroup": "Save web pages to group from extension",
    "settings.lastAddedGroup": "Last added group",
    "settings.hideSidebar": "Hide sidebar completely",
    "settings.sync": "Enable Sync",
    "settings.sync.size": "Sync payload ~ {size}",
    "settings.sync.budget.green": "Size OK",
    "settings.sync.budget.yellow": "Near limit",
    "settings.sync.budget.red": "May exceed sync quota",
    "settings.sync.exportBundle": "Export sync bundle",
    "settings.sync.importBundle": "Import & merge sync bundle",
    "settings.sync.exportOk": "Sync bundle copied",
    "settings.sync.importOk": "Sync bundle merged",
    "settings.sync.importFail": "Merge failed: {reason}",
    "settings.sync.hint":
      "Uses browser account sync. Backups, wallpaper files, and uploaded icons are local-only. Use a sync bundle across browsers.",
    "settings.openMode": "Link Open Mode",
    "settings.maxBackups": "Max backups (0 = disabled)",
    "settings.iconRetry": "Retry failed icons (daily)",
    "settings.retryDisabled": "Disabled",
    "confirm.clearData": "Clear all data?",
    "confirm.clearCards": "Delete all groups and cards? (settings will be kept)",
    "toast.cleared": "Cleared",
    "toast.cardsCleared": "All groups and cards deleted. Restore from Backup Manager.",
    "toast.iconsRefreshed": "Icons refreshed",
    "toast.savedToGroup": "Saved to group: {name}",
    "common.unnamed": "Unnamed",
    "background.fetchFailedCache": "Wallpaper fetch failed, fallback to cache",
    "background.updatedToday": "Bing wallpaper updated",
    "background.failedDefault": "Wallpaper fetch failed, using default background",
    "group.default": "Default",
    "group.new": "New Group",
    "group.promptName": "Group name",
    "group.keepOne": "At least one group must remain",
    "group.deleteConfirm": 'Delete group "{name}"?',
    "delete.deletedCount": "Deleted {count} shortcuts",
    "delete.undo": "Undo",
    "delete.restored": "Restored",
    "history.batchDeleteDisabled": "Batch delete is unavailable in history",
    "selection.modeEnabled": "Batch selection mode enabled",
    "modal.add.title": "Add Shortcut",
    "modal.edit.title": "Edit",
    "field.url": "URL",
    "field.title": "Title",
    "field.titleOptional": "Optional",
    "field.iconSource": "Icon Source",
    "field.icon.auto": "Auto favicon",
    "field.icon.upload": "Upload icon",
    "field.icon.color": "Color avatar",
    "field.icon.remote": "Remote icon URL",
    "field.icon.fetchNow": "Fetch icon now",
    "field.icon.fetching": "Fetching…",
    "field.icon.fetchOk": "Icon updated",
    "field.icon.fetchFail": "Failed to fetch icon",
    "field.fromTab": "Use Current Tab",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "field.uploadIcon": "Upload icon",
    "field.colorAvatar": "Avatar color",
    "field.remoteIconUrl": "Remote icon URL",
    "error.invalidUrl": "Invalid URL",
    "error.invalidUrlSimple": "Invalid URL",
    "error.saveQuota": "Save failed: local storage quota exceeded",
    "toast.add.success": "Added",
    "toast.add.trimBackup": "Added (backups trimmed)",
    "toast.add.trimIcons": "Added (uploaded icons reset)",
    "toast.add.trimBackground": "Added (custom background cleared)",
    "toast.add.syncFallback": "Added (sync quota exceeded, saved locally)",
    "toast.add.syncWriteFailed": "Added (sync write failed, sync disabled and saved locally)",
    "toast.save.success": "Saved",
    "toast.save.trimBackup": "Saved (backups trimmed)",
    "toast.save.trimIcons": "Saved (uploaded icons reset)",
    "toast.save.trimBackground": "Saved (custom background cleared)",
    "toast.save.syncFallback": "Saved (sync quota exceeded, saved locally)",
    "toast.save.syncWriteFailed": "Saved (sync write failed, sync disabled and saved locally)",
    "toast.syncOverwritten": "Another device had newer data; your unsaved local changes may have been overwritten",
    "tile.folderSuffix": " (Folder)",
    "folder.newTitle": "New Folder",
    "folder.created": "Folder created",
    "folder.added": "Added to folder",
    "folder.dissolved": "Folder dissolved",
    "group.noneAvailable": "No available groups",
    "group.notFound": "Group not found",
    "common.selectGroup": "Select Group",
    "toast.addedToShortcuts": "Added to shortcuts",
    "import.noUrls": "No URLs to import",
  },
  ja: {
    "app.title": "マイホーム",
    "search.placeholder": "タイトルまたはURLを検索...",
    "search.button": "検索",
    "toolbar.add": "追加",
    "toolbar.batchDelete": "一括削除",
    "toolbar.selectAll": "全選択",
    "toolbar.settings": "設定",
    "toolbar.openMode": "開き方",
    "sidebar.history": "履歴",
    "sidebar.addGroup": "グループ追加",
    "sidebar.collapse": "折りたたむ",
    "sidebar.expand": "展開",
    "empty.title": "ショートカットはまだありません",
    "empty.desc": "右上の追加をクリックしてカードを作成します。必要なら設定から復元できます。",
    "empty.hideHint": "今後表示しない",
    "folder.defaultTitle": "フォルダ",
    "folder.back": "戻る",
    "folder.add": "追加",
    "folder.batchDelete": "一括削除",
    "folder.dissolve": "フォルダ解除",
    "openMode.current": "このタブで開く",
    "openMode.new": "新しいタブで開く",
    "openMode.background": "バックグラウンドで開く",
    "settings.saved": "設定を保存しました",
    "settings.language": "言語",
    "group.default": "デフォルト",
    "group.new": "新規グループ",
  },
  ko: {
    "app.title": "내 홈페이지",
    "search.placeholder": "제목 또는 URL 검색...",
    "search.button": "검색",
    "toolbar.add": "추가",
    "toolbar.batchDelete": "일괄 삭제",
    "toolbar.selectAll": "전체 선택",
    "toolbar.settings": "설정",
    "toolbar.openMode": "열기 방식",
    "sidebar.history": "기록",
    "sidebar.addGroup": "그룹 추가",
    "sidebar.collapse": "접기",
    "sidebar.expand": "펼치기",
    "empty.title": "바로가기가 없습니다",
    "empty.desc": "오른쪽 위 추가 버튼으로 카드를 만드세요. 필요하면 설정에서 복원할 수 있습니다.",
    "empty.hideHint": "다시 표시 안 함",
    "folder.defaultTitle": "폴더",
    "folder.back": "뒤로",
    "folder.add": "추가",
    "folder.batchDelete": "일괄 삭제",
    "folder.dissolve": "폴더 해제",
    "openMode.current": "현재 탭 열기",
    "openMode.new": "새 탭 열기",
    "openMode.background": "백그라운드 열기",
    "settings.saved": "설정이 저장됨",
    "settings.language": "언어",
    "group.default": "기본",
    "group.new": "새 그룹",
  },
  de: {
    "app.title": "Meine Startseite",
    "search.placeholder": "Titel oder URL suchen...",
    "search.button": "Suchen",
    "toolbar.add": "Hinzufugen",
    "toolbar.batchDelete": "Mehrfach loschen",
    "toolbar.selectAll": "Alle auswahlen",
    "toolbar.settings": "Einstellungen",
    "toolbar.openMode": "Offnen",
    "sidebar.history": "Verlauf",
    "sidebar.addGroup": "Gruppe hinzufugen",
    "sidebar.collapse": "Einklappen",
    "sidebar.expand": "Ausklappen",
    "empty.title": "Noch keine Verknupfungen",
    "empty.desc": "Oben rechts auf Hinzufugen klicken. Backups lassen sich in Einstellungen wiederherstellen.",
    "empty.hideHint": "Nicht mehr anzeigen",
    "folder.defaultTitle": "Ordner",
    "folder.back": "Zuruck",
    "folder.add": "Hinzufugen",
    "folder.batchDelete": "Mehrfach loschen",
    "folder.dissolve": "Ordner auflosen",
    "openMode.current": "Hier offnen",
    "openMode.new": "In neuem Tab",
    "openMode.background": "Im Hintergrund",
    "settings.saved": "Einstellungen gespeichert",
    "settings.language": "Sprache",
    "group.default": "Standard",
    "group.new": "Neue Gruppe",
  },
  fr: {
    "app.title": "Ma page d'accueil",
    "search.placeholder": "Rechercher un titre ou une URL...",
    "search.button": "Rechercher",
    "toolbar.add": "Ajouter",
    "toolbar.batchDelete": "Suppression lot",
    "toolbar.selectAll": "Tout selectionner",
    "toolbar.settings": "Parametres",
    "toolbar.openMode": "Mode d'ouverture",
    "sidebar.history": "Historique",
    "sidebar.addGroup": "Ajouter groupe",
    "sidebar.collapse": "Replier",
    "sidebar.expand": "Deplier",
    "empty.title": "Aucun raccourci",
    "empty.desc": "Cliquez sur Ajouter en haut a droite. Les sauvegardes sont dans Parametres.",
    "empty.hideHint": "Ne plus afficher",
    "folder.defaultTitle": "Dossier",
    "folder.back": "Retour",
    "folder.add": "Ajouter",
    "folder.batchDelete": "Suppression lot",
    "folder.dissolve": "Dissoudre dossier",
    "openMode.current": "Ouvrir ici",
    "openMode.new": "Nouvel onglet",
    "openMode.background": "Arriere-plan",
    "settings.saved": "Parametres enregistres",
    "settings.language": "Langue",
    "group.default": "Par defaut",
    "group.new": "Nouveau groupe",
  },
  es: {
    "app.title": "Mi inicio",
    "search.placeholder": "Buscar titulo o URL...",
    "search.button": "Buscar",
    "toolbar.add": "Agregar",
    "toolbar.batchDelete": "Borrar lote",
    "toolbar.selectAll": "Seleccionar todo",
    "toolbar.settings": "Configuracion",
    "toolbar.openMode": "Modo de apertura",
    "sidebar.history": "Historial",
    "sidebar.addGroup": "Agregar grupo",
    "sidebar.collapse": "Contraer",
    "sidebar.expand": "Expandir",
    "empty.title": "Aun no hay accesos directos",
    "empty.desc": "Haz clic en Agregar arriba a la derecha. Puedes restaurar copias en Configuracion.",
    "empty.hideHint": "No volver a mostrar",
    "folder.defaultTitle": "Carpeta",
    "folder.back": "Volver",
    "folder.add": "Agregar",
    "folder.batchDelete": "Borrar lote",
    "folder.dissolve": "Disolver carpeta",
    "openMode.current": "Abrir aqui",
    "openMode.new": "Abrir en nueva pestana",
    "openMode.background": "Abrir en segundo plano",
    "settings.saved": "Configuracion guardada",
    "settings.language": "Idioma",
    "group.default": "Predeterminado",
    "group.new": "Nuevo grupo",
  },
};

function currentLang() {
  const stored = normalizeLanguage(data?.settings?.language || "");
  if (stored) return stored;
  return detectPreferredLanguage();
}

/**
 * 解析语言字典：残缺语言包以 en/zh-CN 为底，再叠本语言，避免界面大量 raw key / 半截翻译。
 * zh-TW 以 zh-CN 为底；其它非中文以 en 为底。
 */
function resolveDict(lang) {
  if (lang === "zh-CN") return I18N["zh-CN"] || {};
  if (lang === "zh-TW") return { ...(I18N["zh-CN"] || {}), ...(I18N["zh-TW"] || {}) };
  return { ...(I18N.en || I18N["zh-CN"] || {}), ...(I18N[lang] || {}) };
}

function t(key, vars = null) {
  const lang = currentLang();
  const dict = resolveDict(lang);
  const text = dict[key] || I18N.en?.[key] || I18N["zh-CN"]?.[key] || key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
}

function ensureLanguageSetting() {
  if (!data?.settings) return false;
  const normalized = normalizeLanguage(data.settings.language || "");
  if (normalized) {
    data.settings.language = normalized;
    return false;
  }
  data.settings.language = detectPreferredLanguage();
  return true;
}

function buildLanguageOptions(selectedLanguage) {
  const normalized = normalizeLanguage(selectedLanguage || "") || currentLang();
  return APP_SUPPORTED_LANGUAGES.map(
    (item) => html`<option value="${item.code}" ${item.code === normalized ? "selected" : ""}>${item.label}</option>`,
  ).join("");
}

function applyStaticI18n() {
  const lang = currentLang();
  document.documentElement.lang = lang;
  document.title = t("app.title");
  if (elements.topSearch) elements.topSearch.placeholder = t("search.placeholder");
  if (elements.btnSearch) {
    elements.btnSearch.textContent = t("search.button");
    elements.btnSearch.setAttribute("data-tooltip", t("search.button"));
  }
  if (elements.btnAdd) {
    elements.btnAdd.textContent = t("toolbar.add");
    elements.btnAdd.setAttribute("data-tooltip", t("toolbar.add"));
  }
  if (elements.btnBatchDelete) elements.btnBatchDelete.setAttribute("data-tooltip", t("toolbar.batchDelete"));
  if (elements.btnSelectAll) {
    elements.btnSelectAll.textContent = t("toolbar.selectAll");
    elements.btnSelectAll.setAttribute("data-tooltip", t("toolbar.selectAll"));
  }
  if (elements.btnOpenMode) elements.btnOpenMode.setAttribute("data-tooltip", t("toolbar.openMode"));
  if (elements.btnSettings) {
    elements.btnSettings.textContent = t("toolbar.settings");
    elements.btnSettings.setAttribute("data-tooltip", t("toolbar.settings"));
  }
  if (elements.recentTab) elements.recentTab.dataset.label = t("sidebar.history");
  if (elements.btnAddGroup) {
    elements.btnAddGroup.textContent = t("sidebar.addGroup");
    elements.btnAddGroup.setAttribute("data-tooltip", t("sidebar.addGroup"));
  }
  if (elements.btnCloseFolder) elements.btnCloseFolder.textContent = t("folder.back");
  if (elements.btnFolderAdd) elements.btnFolderAdd.textContent = t("folder.add");
  if (elements.btnFolderBatchDelete) elements.btnFolderBatchDelete.textContent = t("folder.batchDelete");
  if (elements.btnFolderDissolve) elements.btnFolderDissolve.textContent = t("folder.dissolve");
  const emptyTitle = qs(".empty-title", elements.emptyState);
  const emptyDesc = qs(".empty-desc", elements.emptyState);
  // 历史分组的空态文案由 updateEmptyState 负责，避免这里盖掉
  if (activeGroupId !== RECENT_GROUP_ID) {
    if (emptyTitle) emptyTitle.textContent = t("empty.title");
    if (emptyDesc) emptyDesc.textContent = t("empty.desc");
  }
  const emptyCheckLabel = qs(".empty-check", elements.emptyState);
  if (emptyCheckLabel) {
    const textNode = Array.from(emptyCheckLabel.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.nodeValue = ` ${t("empty.hideHint")}`;
  }
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

async function _loadLatestDataForApp() {
  const localData = await loadData();
  if (localData.settings.syncEnabled) {
    // loadDataFromArea 在 key 缺失时返回 null，禁止用“空默认数据”参与 LWW
    const syncData = await loadDataFromArea(true);
    if (syncData?.groups?.length) {
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
  const prevLocalTs = Number(data?.lastUpdated || 0);
  const prevPending = persistInFlight > 0;
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
  const newTs = Number(data?.lastUpdated || 0);
  // merge 提示由 engine onMerged 负责；此处仅非 sync 粗提示
  if (!wasSync && newTs > prevLocalTs && prevLocalTs > 0 && !prevPending) {
    toast(t("toast.syncOverwritten"), "warning");
  }
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
  ensureLanguageSetting();
  syncBackupBaseline(data);
  render();
  processPendingIconFetches();
  await consumeSaveToast();
  // popup 等只写了 local：reload 后把投影推到 sync
  if (data?.settings?.syncEnabled) schedulePush();
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
    // 新同步协议：meta 变更触发 merge pull
    if (areaName === "sync" && (changes?.homepage_sync_meta || changes?.homepage_data)) {
      if (data?.settings?.syncEnabled) {
        schedulePull("onChanged");
        return;
      }
    }
    if (!changes?.[key]) return;
    if (areaName !== "local" && areaName !== "sync") return;
    // 本地 homepage_data 变更（如 popup 写入）
    if (areaName === "local") {
      const incoming = changes[key].newValue;
      const incomingTs = Number(incoming?.lastUpdated || 0);
      const localTs = Number(data?.lastUpdated || 0);
      if (incomingTs > 0 && localTs > 0 && incomingTs <= localTs) return;
      scheduleStorageReload();
    }
  });
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

function applyDensity() {
  const d = densityMap[data.settings.gridDensity] || densityMap.standard;
  document.documentElement.style.setProperty("--grid-gap", `${d.gap}px`);
  const baseFont = Number(data.settings.fontSize) || DEFAULT_BASE_FONT;
  document.documentElement.style.setProperty("--tile-font", `${baseFont}px`);
  document.documentElement.style.setProperty("--base-font", `${baseFont}px`);
  if (
    !data.settings.lastTileSize ||
    data.settings.lastTileSize <= 0 ||
    data.settings.lastTileSize < DEFAULT_TILE_SIZE
  ) {
    data.settings.lastTileSize = DEFAULT_TILE_SIZE;
  }
}

function applyTheme() {
  const theme = data.settings.theme || "system";
  if (theme === "system") {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    document.documentElement.setAttribute("data-theme", mq?.matches ? "dark" : "light");
    applyBackgroundOverlay();
    return;
  }
  document.documentElement.setAttribute("data-theme", theme);
  applyBackgroundOverlay();
}

if (typeof window !== "undefined" && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if ((data?.settings?.theme || "system") === "system") applyTheme();
  });
}

function applySidebarState() {
  document.body.classList.toggle("sidebar-collapsed", !!data.settings.sidebarCollapsed);
  document.body.classList.toggle("sidebar-hidden", !!data.settings.sidebarHidden);
  if (elements.btnToggleSidebar) {
    elements.btnToggleSidebar.textContent = data.settings.sidebarCollapsed
      ? t("sidebar.expand")
      : t("sidebar.collapse");
  }
  syncSidebarTabLabels();
}

function syncSidebarTabLabels() {
  if (!elements.recentTab) return;
  const collapsed = !!data.settings.sidebarCollapsed;
  const recentLabel = elements.recentTab.dataset.label || elements.recentTab.textContent || t("sidebar.history");
  elements.recentTab.dataset.label = recentLabel;
  elements.recentTab.setAttribute("aria-label", recentLabel);
  elements.recentTab.textContent = collapsed ? "" : recentLabel;
  qsa(".group-tab", elements.groupTabs).forEach((btn) => {
    const label = btn.dataset.label || btn.textContent || "";
    btn.dataset.label = label;
    btn.setAttribute("aria-label", label || t("sidebar.addGroup"));
    btn.textContent = collapsed ? "" : label;
  });
}

/**
 * 显示 Toast。
 * 用法：
 * - toast(msg) / toast(msg, "success"|"error"|"warning")
 * - toast(msg, actionLabel, actionFn)
 * - toast(msg, actionLabel, actionFn, "warning")
 * 默认 success（绿色）；error 红；warning 黄。
 * @param {string} message
 * @param {string | (() => void)} [actionLabelOrType]
 * @param {(() => void) | string} [actionOrType]
 * @param {"success"|"error"|"warning"} [type]
 */
function toast(message, actionLabelOrType, actionOrType, type) {
  let actionLabel = null;
  let action = null;
  let kind = "success";

  if (typeof actionLabelOrType === "function") {
    action = actionLabelOrType;
  } else if (actionLabelOrType === "success" || actionLabelOrType === "error" || actionLabelOrType === "warning") {
    kind = actionLabelOrType;
  } else if (typeof actionLabelOrType === "string") {
    actionLabel = actionLabelOrType;
  }

  if (typeof actionOrType === "function") {
    action = actionOrType;
  } else if (actionOrType === "success" || actionOrType === "error" || actionOrType === "warning") {
    kind = actionOrType;
  }

  if (type === "success" || type === "error" || type === "warning") {
    kind = type;
  }

  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (actionLabel && action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => {
      action();
      el.remove();
    });
    el.appendChild(btn);
  }
  elements.toastContainer?.appendChild(el);
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
  const groupName = toastInfo.groupName || t("common.unnamed");
  toast(t("toast.savedToGroup", { name: groupName }));
  data.settings.lastSaveToast = null;
  await persistData();
}

function showTooltip(text, x, y) {
  if (!data.settings.tooltipEnabled) return;
  elements.tooltip.textContent = text;
  elements.tooltip.style.left = "0";
  elements.tooltip.style.top = "0";
  elements.tooltip.style.transform = `translate3d(${x + 12}px, ${y + 12}px, 0)`;
  elements.tooltip.classList.remove("hidden");
}

function hideTooltip() {
  elements.tooltip.classList.add("hidden");
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

async function openUrl(url, mode) {
  const api = getChromeApi();
  const openMode = mode || data.settings.openMode;
  // 用户从本扩展打开的链接也记入「最近访问」（Safari 无系统历史时的数据来源）
  void recordVisit({ url, title: "" }).catch((e) => console.warn("recordVisit failed", e));
  if (api?.tabs && (openMode === "new" || openMode === "background")) {
    api.tabs.create({ url, active: openMode !== "background" });
    return;
  }
  if (openMode === "new") {
    window.open(url, "_blank", "noopener,noreferrer");
  } else if (openMode === "background") {
    window.open(url, "_blank", "noopener,noreferrer");
  } else {
    window.location.href = url;
  }
}

function setBackground(style) {
  if (!style) return;
  if (style.startsWith("data:") || style.startsWith("http")) {
    // JSON.stringify 给 URL 加引号并转义，比 CSS.escape(标识符) 更适合 url() 值
    elements.background.style.backgroundImage = `url(${JSON.stringify(style)})`;
  } else if (/^[a-zA-Z-]+\([^)]*\)$/.test(style)) {
    // 仅允许形如 linear-gradient(...) / radial-gradient(...) 的 CSS 函数
    elements.background.style.backgroundImage = style;
  } else if (/^[a-zA-Z-]+$/.test(style)) {
    // 仅允许纯关键字（如 none）
    elements.background.style.backgroundImage = style;
  }
  // 其它情况一律忽略，避免注入
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

function setSolidBackgroundColor(color) {
  const safe = isSafeCssColor(color) ? String(color).trim() : "#0b0f14";
  elements.background.style.backgroundImage = "none";
  elements.background.style.background = safe;
}

async function loadBackground() {
  const settings = data.settings;
  elements.background.classList.add("is-loading");

  if (settings.backgroundType === "bing") {
    const info = await getBingWallpaper(settings.language);
    if (info.dataUrl) {
      setBackground(info.dataUrl);
      if (info.failed) toast(t("background.fetchFailedCache"), "warning");
      else if (!info.fromCache) toast(t("background.updatedToday"));
    } else {
      setSolidBackgroundColor(settings.backgroundColor);
      toast(t("background.failedDefault"), "error");
    }
  } else if (settings.backgroundType === "color") {
    setSolidBackgroundColor(settings.backgroundColor);
  } else if (settings.backgroundType === "gradient") {
    setBackground(settings.backgroundGradient);
  } else if (settings.backgroundType === "custom") {
    if (settings.backgroundCustom) setBackground(settings.backgroundCustom);
    else setSolidBackgroundColor(settings.backgroundColor);
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

function syncBackupBaseline(source = data) {
  backupFingerprint = buildBackupFingerprint(source, BACKUP_IGNORED_SETTINGS_KEYS);
  backupBaselineSnapshot = cloneDataSnapshot(source);
}

function ensureAutoBackupBeforePersist() {
  const currentFingerprint = buildBackupFingerprint(data, BACKUP_IGNORED_SETTINGS_KEYS);
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

/** 串行化 persist，避免多路 fire-and-forget 互相覆盖 */
let _persistChain = Promise.resolve();

/**
 * 不需要等待结果的保存入口：吞掉异常，避免 unhandledrejection 触发全页红条。
 * 需要根据 ok/warning 提示用户时仍应 await persistData()。
 */
function queuePersist() {
  return persistData().catch((e) => {
    console.warn("queuePersist failed", e);
    return { ok: false, warning: null, err: e?.message || String(e) };
  });
}

async function persistData() {
  const run = async () => {
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
      // 本地权威：始终先写 local；同步改走投影分片 engine
      const changed = dedupeData(data);
      let warning = null;
      let err = null;
      const err1 = await saveData(data, false);
      if (err1) {
        if (typeof err1 === "string" && err1.startsWith("local_trimmed_")) {
          warning = err1;
        } else {
          err = err1;
        }
      }
      if (!err && data.settings.syncEnabled) {
        schedulePush();
      }
      if (changed) {
        debugLog("persist_dedupe", { changed });
      }
      if (shouldDebugPersist()) {
        const verify = await loadDataFromArea(false);
        debugLog("persist_verify", {
          groups: verify?.groups?.length || 0,
          nodes: Object.keys(verify?.nodes || {}).length,
          lastUpdated: verify?.lastUpdated || 0,
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
  };
  const next = _persistChain.then(run, run);
  // 不让单次失败打断队列
  _persistChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
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
  elements.groupTabs.replaceChildren();
  elements.recentTab.classList.toggle("active", activeGroupId === RECENT_GROUP_ID);
  const recentLabel = elements.recentTab.dataset.label || elements.recentTab.textContent || t("sidebar.history");
  elements.recentTab.dataset.label = recentLabel;
  elements.recentTab.setAttribute("aria-label", recentLabel);
  elements.recentTab.textContent = data.settings.sidebarCollapsed ? "" : recentLabel;
  elements.recentTab.dataset.short = t("sidebar.history");
  [...data.groups]
    .sort((a, b) => a.order - b.order)
    .forEach((group, idx) => {
      const btn = document.createElement("button");
      btn.className = `group-tab draggable ${group.id === activeGroupId ? "active" : ""}`;
      btn.dataset.label = group.name;
      btn.setAttribute("aria-label", group.name);
      btn.textContent = data.settings.sidebarCollapsed ? "" : group.name;
      btn.dataset.short = String(idx + 1);
      btn.dataset.groupId = group.id;
      btn.draggable = true;
      btn.addEventListener("click", (e) => {
        if (Date.now() < suppressTouchClickUntil) {
          e.preventDefault();
          return;
        }
        activeGroupId = group.id;
        openFolderId = null;
        data.settings.lastActiveGroupId = activeGroupId;
        queuePersist();
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
        qsa(".group-tab", elements.groupTabs).forEach((el) => {
          el.classList.remove("drop-target");
        });
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
      btn.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length !== 1) return;
          const touch = e.touches[0];
          beginTouchLongPress("group", group.id, btn, touch.clientX, touch.clientY);
        },
        { passive: true },
      );
      elements.groupTabs.appendChild(btn);
    });
}

async function renderGrid() {
  const seq = ++renderSeq;
  const grid = openFolderId ? elements.folderGrid : elements.grid;
  const nodes = uniqueNodes(getCurrentNodes());
  grid.replaceChildren();

  const referenceGrid = openFolderId ? elements.grid : grid;
  const width = referenceGrid.getBoundingClientRect().width || referenceGrid.clientWidth || window.innerWidth;
  const density = densityMap[data.settings.gridDensity] || densityMap.standard;
  const gap = density.gap || 16;
  const style = getComputedStyle(referenceGrid);
  const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const available = Math.max(0, width - paddingX);
  const isMobileViewport = !!window.matchMedia?.("(max-width: 720px)").matches;
  const baseSize = data.settings.lastTileSize || density.size || 96;
  const maxColumns = Math.max(1, Math.floor((available + gap) / (baseSize + gap)));
  let columns = maxColumns;
  if (data.settings.fixedLayout) {
    const desired = Math.max(1, data.settings.fixedCols || 8);
    columns = desired;
  } else if (isMobileViewport) {
    columns = Math.max(3, columns);
  }
  let tileSize = baseSize;
  if (data.settings.fixedLayout && available > 0) {
    const fitSize = Math.floor((available - gap * (columns - 1)) / columns);
    tileSize = Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, fitSize));
  } else if (isMobileViewport && available > 0) {
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

  // 预加载图标缓存，避免每个 tile 都独立读存储
  const iconCache = await loadIconCache();

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
    // 先用字母头像占位，图标并发解析后异步更新，避免串行 await 阻塞渲染
    img.src = letterIconDataUrl(node.title || node.url || "?", node.color);
    resolveIcon(node, data.settings, iconCache).then((iconSrc) => {
      if (seq !== renderSeq || !img.isConnected) return;
      img.src = iconSrc;
      if (node.url && data.settings.iconFetch && !iconSrc.startsWith("data:")) {
        const fallback = letterIconDataUrl(node.title || node.url || "?", node.color);
        const triedCandidates = new Set([iconSrc]);
        const tryNext = async () => {
          const nextIcon = await trySwitchToNextFavicon(node.url, triedCandidates);
          if (nextIcon) {
            img.src = nextIcon;
            return;
          }
          img.onerror = null;
          img.onload = null;
          img.src = fallback;
          await markIconLoadFailed(node.url);
        };
        img.onerror = tryNext;
        img.onload = () => {
          if (img.naturalWidth < 16 && img.naturalHeight < 16) {
            tryNext();
          }
        };
        // 旧缓存只有远程 URL，后台异步抓取为 dataURL 更新缓存，成功后直接更新 img.src
        migrateIconCacheToDataUrl(node, img);
      }
    });
    icon.appendChild(img);

    const title = document.createElement("div");
    title.className = "tile-title";
    title.textContent = node.title || node.url || t("common.unnamed");

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
      if (Date.now() < suppressTouchClickUntil) {
        e.preventDefault();
        return;
      }
      if (selectionMode) {
        toggleSelect(node.id, idx, e.shiftKey);
        return;
      }
      if (node.type === "folder") {
        openFolder(node.id);
      } else {
        const url = normalizeUrl(node.url);
        if (!url) {
          toast(t("error.invalidUrlSimple"), "error");
          return;
        }
        openUrl(url);
      }
    });

    tile.addEventListener("keydown", (e) => {
      if (!data.settings.keyboardNav) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (selectionMode) {
        toggleSelect(node.id, idx, e.shiftKey);
        return;
      }
      if (node.type === "folder") {
        openFolder(node.id);
        return;
      }
      const url = normalizeUrl(node.url);
      if (!url) {
        toast(t("error.invalidUrlSimple"), "error");
        return;
      }
      openUrl(url);
    });

    tile.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, node);
    });

    tile.addEventListener("mouseenter", (e) => {
      if (!data.settings.tooltipEnabled) return;
      clearTimeout(tooltipTimer);
      const text = node.type === "folder" ? `${node.title}${t("tile.folderSuffix")}` : `${node.title}\n${node.url}`;
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

    tile.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        if (selectionMode || activeGroupId === RECENT_GROUP_ID) return;
        const touch = e.touches[0];
        beginTouchTileHold(node, node.id, tile, touch.clientX, touch.clientY);
      },
      { passive: true },
    );

    grid.appendChild(tile);
  }

  updateEmptyState();
}

function updateEmptyState() {
  const emptyTitle = qs(".empty-title", elements.emptyState);
  const emptyDesc = qs(".empty-desc", elements.emptyState);
  const emptyCheck = qs(".empty-check", elements.emptyState);

  if (activeGroupId === RECENT_GROUP_ID) {
    // 历史分组：API 不可用或暂无数据时给出明确说明（不再整块隐藏）
    if (recentItems.length > 0) {
      elements.emptyState.classList.add("hidden");
      return;
    }
    if (emptyCheck) emptyCheck.classList.add("hidden");
    if (historyApiStatus === "error") {
      if (emptyTitle) emptyTitle.textContent = t("history.unavailable.title");
      if (emptyDesc) emptyDesc.textContent = t("history.unavailable.desc");
    } else if (historyApiStatus === "missing") {
      // 理论上会被 fallback 覆盖；仍给出明确说明
      if (emptyTitle) emptyTitle.textContent = t("history.unavailable.title");
      if (emptyDesc) emptyDesc.textContent = t("history.fallback.desc");
    } else {
      if (emptyTitle) emptyTitle.textContent = t("history.empty.title");
      if (emptyDesc)
        emptyDesc.textContent = historyApiStatus === "fallback" ? t("history.fallback.desc") : t("history.empty.desc");
    }
    elements.emptyState.classList.remove("hidden");
    return;
  }

  if (emptyCheck) emptyCheck.classList.remove("hidden");
  if (emptyTitle) emptyTitle.textContent = t("empty.title");
  if (emptyDesc) emptyDesc.textContent = t("empty.desc");
  const nodes = getCurrentNodes();
  if (nodes.length === 0 && !data.settings.emptyHintDisabled) {
    elements.emptyState.classList.remove("hidden");
  } else {
    elements.emptyState.classList.add("hidden");
  }
}

function openFolder(folderId) {
  openFolderId = folderId;
  elements.folderOverlay.removeAttribute("inert");
  elements.folderOverlay.classList.remove("hidden");
  elements.folderOverlay.setAttribute("aria-hidden", "false");
  elements.folderTitle.textContent = data.nodes[folderId]?.title || t("folder.defaultTitle");
  render();
  elements.folderGrid.focus({ preventScroll: true });
}

function findParentFolderId(folderId) {
  if (!folderId) return "";
  for (const node of Object.values(data.nodes || {})) {
    if (node.type !== "folder" || !Array.isArray(node.children)) continue;
    if (node.children.includes(folderId)) {
      return node.id;
    }
  }
  return "";
}

function closeFolder() {
  const parentId = findParentFolderId(openFolderId);
  if (parentId) {
    openFolderId = parentId;
    elements.folderTitle.textContent = data.nodes[parentId]?.title || t("folder.defaultTitle");
    render();
    return;
  }
  openFolderId = null;
  const activeEl = document.activeElement;
  if (activeEl && elements.folderOverlay.contains(activeEl)) {
    elements.btnSettings?.focus?.({ preventScroll: true });
  }
  elements.folderOverlay.setAttribute("inert", "");
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
  elements.btnBatchDelete.textContent = selectionMode ? t("context.delete") : t("toolbar.batchDelete");
  elements.btnFolderBatchDelete.textContent = selectionMode ? t("context.delete") : t("folder.batchDelete");
}

function updateSelectionStyles() {
  const grid = openFolderId ? elements.folderGrid : elements.grid;
  qsa(".tile", grid).forEach((tile) => {
    tile.classList.toggle("selected", selectedIds.has(tile.dataset.id));
  });
}

function clearTouchDragTimer() {
  if (!touchDragState.timer) return;
  clearTimeout(touchDragState.timer);
  touchDragState.timer = null;
}

function clearTouchMenuTimer() {
  if (!touchMenuState.timer) return;
  clearTimeout(touchMenuState.timer);
  touchMenuState.timer = null;
}

function resetTouchMenuState() {
  clearTouchMenuTimer();
  touchMenuState.active = false;
  touchMenuState.node = null;
  touchMenuState.startX = 0;
  touchMenuState.startY = 0;
  touchMenuState.x = 0;
  touchMenuState.y = 0;
}

function beginTouchTileHold(node, sourceId, sourceEl, x, y) {
  resetTouchMenuState();
  beginTouchLongPress("tile", sourceId, sourceEl, x, y);
  touchMenuState.node = node;
  touchMenuState.startX = x;
  touchMenuState.startY = y;
  touchMenuState.x = x;
  touchMenuState.y = y;
  touchMenuState.timer = setTimeout(() => {
    if (touchDragState.active || !touchMenuState.node) return;
    touchMenuState.active = true;
    clearTouchMenuTimer();
    openContextMenu(touchMenuState.x, touchMenuState.y, touchMenuState.node);
  }, TOUCH_TILE_CONTEXT_MENU_MS);
}

function syncTouchDraggedTilePosition(x, y) {
  const tile = touchDragState.sourceTile;
  if (!tile) return;
  const dx = Math.round(x - touchDragState.startX);
  const dy = Math.round(y - touchDragState.startY);
  tile.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(0.98)`;
}

function clearTouchDragVisual() {
  if (touchDragState.sourceTile) {
    touchDragState.sourceTile.classList.remove("touch-dragging");
    touchDragState.sourceTile.style.transform = "";
    touchDragState.sourceTile.style.pointerEvents = "";
    touchDragState.sourceTile.style.zIndex = "";
    touchDragState.sourceTile.style.willChange = "";
  }
  if (touchDragState.targetTile) {
    touchDragState.targetTile.classList.remove("touch-drop-target");
  }
  if (touchDragState.sourceGroupBtn) {
    touchDragState.sourceGroupBtn.classList.remove("dragging");
  }
  if (touchDragState.targetGroupBtn) {
    touchDragState.targetGroupBtn.classList.remove("drop-target");
  }
  qsa(".group-tab", elements.groupTabs).forEach((el) => {
    el.classList.remove("drop-target");
  });
  document.body.classList.remove("touch-dragging");
}

function beginTouchLongPress(mode, sourceId, sourceEl, x, y) {
  resetTouchDragState();
  touchDragState.mode = mode;
  if (mode === "tile") {
    touchDragState.sourceId = sourceId;
    touchDragState.sourceTile = sourceEl;
  } else {
    touchDragState.sourceGroupId = sourceId;
    touchDragState.sourceGroupBtn = sourceEl;
  }
  touchDragState.startX = x;
  touchDragState.startY = y;
  touchDragState.x = x;
  touchDragState.y = y;
  const pressMs = mode === "tile" ? TOUCH_TILE_LONG_PRESS_MS : TOUCH_GROUP_LONG_PRESS_MS;
  touchDragState.timer = setTimeout(() => {
    activateTouchDrag();
  }, pressMs);
}

function activateTouchDrag() {
  if (!touchDragState.mode) return;
  touchDragState.active = true;
  clearTouchDragTimer();
  if (touchDragState.mode === "tile") {
    if (touchMenuState.active) closeContextMenu();
    resetTouchMenuState();
    dragState = { id: touchDragState.sourceId, fromFolder: openFolderId };
    if (touchDragState.sourceTile) {
      touchDragState.sourceTile.classList.add("touch-dragging");
      touchDragState.sourceTile.style.pointerEvents = "none";
      touchDragState.sourceTile.style.zIndex = "80";
      touchDragState.sourceTile.style.willChange = "transform";
      syncTouchDraggedTilePosition(touchDragState.x, touchDragState.y);
    }
    touchDragState.targetTile = null;
  } else if (touchDragState.mode === "group") {
    draggingGroupId = touchDragState.sourceGroupId;
    touchDragState.sourceGroupBtn?.classList.add("dragging");
    touchDragState.targetGroupBtn = null;
  }
  document.body.classList.add("touch-dragging");
}

function updateTouchDragTarget(x, y) {
  if (!touchDragState.active) return;
  touchDragState.x = x;
  touchDragState.y = y;
  const pointEl = document.elementFromPoint(x, y) || null;
  if (touchDragState.mode === "tile") {
    syncTouchDraggedTilePosition(x, y);
    const hoverTile = pointEl?.closest?.(".tile") || null;
    const nextTarget = hoverTile && hoverTile.dataset.id !== touchDragState.sourceId ? hoverTile : null;
    if (touchDragState.targetTile && touchDragState.targetTile !== nextTarget) {
      touchDragState.targetTile.classList.remove("touch-drop-target");
    }
    if (nextTarget && nextTarget !== touchDragState.targetTile) {
      nextTarget.classList.add("touch-drop-target");
    }
    touchDragState.targetTile = nextTarget;
    return;
  }
  if (touchDragState.mode === "group") {
    const hoverGroup = pointEl?.closest?.(".group-tab.draggable") || null;
    const nextTarget = hoverGroup && hoverGroup.dataset.groupId !== touchDragState.sourceGroupId ? hoverGroup : null;
    if (touchDragState.targetGroupBtn && touchDragState.targetGroupBtn !== nextTarget) {
      touchDragState.targetGroupBtn.classList.remove("drop-target");
    }
    if (nextTarget && nextTarget !== touchDragState.targetGroupBtn) {
      nextTarget.classList.add("drop-target");
    }
    touchDragState.targetGroupBtn = nextTarget;
  }
}

function resetTouchDragState() {
  clearTouchDragTimer();
  clearTouchDragVisual();
  resetTouchMenuState();
  touchDragState.mode = "";
  touchDragState.active = false;
  touchDragState.sourceId = "";
  touchDragState.sourceTile = null;
  touchDragState.targetTile = null;
  touchDragState.sourceGroupId = "";
  touchDragState.sourceGroupBtn = null;
  touchDragState.targetGroupBtn = null;
  dragState = null;
  draggingGroupId = null;
}

function finishTouchDrag() {
  if (!touchDragState.active) return false;
  if (touchDragState.mode === "tile") {
    const sourceId = touchDragState.sourceId;
    const targetId = touchDragState.targetTile?.dataset?.id || "";
    const x = touchDragState.x;
    const y = touchDragState.y;

    if (targetId && targetId !== sourceId) {
      handleDropOnTile(targetId, x, y);
    } else if (activeGroupId !== RECENT_GROUP_ID) {
      const inFolder = !!openFolderId;
      const container = inFolder ? data.nodes[openFolderId] : getActiveGroup();
      const list = inFolder ? container.children || [] : container.nodes;
      const grid = inFolder ? elements.folderGrid : elements.grid;
      const next = moveNodeInList(list, sourceId, getDropIndex(grid, x, y));
      if (next !== list) {
        if (inFolder) container.children = next;
        else container.nodes = next;
        queuePersist();
        render();
      }
    }
  } else if (touchDragState.mode === "group") {
    const sourceId = touchDragState.sourceGroupId;
    const targetId = touchDragState.targetGroupBtn?.dataset?.groupId || "";
    if (targetId && targetId !== sourceId) {
      moveGroupBefore(sourceId, targetId);
    } else {
      const rect = elements.groupTabs.getBoundingClientRect();
      const total = data.groups.length;
      if (touchDragState.y < rect.top + 24) moveGroupToIndex(sourceId, 0);
      else if (touchDragState.y > rect.bottom - 24) moveGroupToIndex(sourceId, total);
    }
  }

  suppressTouchClickUntil = Date.now() + TOUCH_CLICK_SUPPRESS_MS;
  resetTouchDragState();
  return true;
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
  elements.contextMenu.replaceChildren();
  const actions = [];
  if (activeGroupId === RECENT_GROUP_ID && node.type === "history") {
    actions.push({ label: t("context.openCurrent"), fn: () => openUrl(normalizeUrl(node.url)) });
    actions.push({ label: t("context.openNew"), fn: () => openUrl(normalizeUrl(node.url), "new") });
    actions.push({ label: t("context.addToShortcuts"), fn: () => openAddHistoryToGroup(node) });
  } else if (node.type !== "folder") {
    actions.push({ label: t("context.openCurrent"), fn: () => openUrl(normalizeUrl(node.url)) });
    actions.push({ label: t("context.openNew"), fn: () => openUrl(normalizeUrl(node.url), "new") });
    actions.push({ label: t("context.openBackground"), fn: () => openUrl(normalizeUrl(node.url), "background") });
  } else {
    actions.push({ label: t("context.openFolder"), fn: () => openFolder(node.id) });
    actions.push({ label: t("context.dissolveFolder"), fn: () => dissolveFolder(node.id) });
  }
  if (node.type !== "history") {
    actions.push({ label: t("context.edit"), fn: () => openEditModal(node) });
    actions.push({ label: t("context.delete"), fn: () => deleteNodes([node.id]) });
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
  elements.contextMenu.replaceChildren();
  const actions = [
    { label: t("context.renameGroup"), fn: () => renameGroup(group) },
    { label: t("context.deleteGroup"), fn: () => deleteGroup(group) },
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

function getInsertIndexFromTarget(list, _sourceId, targetId, x, _y) {
  const targetIndex = list.indexOf(targetId);
  if (targetIndex < 0) return list.length;
  const tile = getTileElementById(targetId);
  if (!tile) return targetIndex;

  const rect = tile.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  // 非图标区域拖放仅按左右半区判断前后，避免误判到行首/左侧。
  const insertAfter = x >= centerX;
  const insertIndex = targetIndex + (insertAfter ? 1 : 0);
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
    queuePersist();
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
      title: t("folder.newTitle"),
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
    queuePersist();
    render();
    toast(t("folder.created"));
    return;
  }

  pushBackup();
  removeNodeFromLocation(sourceId);
  targetNode.children = targetNode.children || [];
  targetNode.children.push(sourceId);
  queuePersist();
  render();
  toast(t("folder.added"));
}

function dissolveFolder(folderId) {
  const folder = data.nodes[folderId];
  if (folder?.type !== "folder") return;
  const children = Array.isArray(folder.children) ? folder.children.slice() : [];
  pushBackup();
  let replaced = false;
  for (const group of data.groups) {
    const idx = group.nodes.indexOf(folderId);
    if (idx < 0) continue;
    group.nodes.splice(idx, 1, ...children);
    replaced = true;
    break;
  }
  if (!replaced) {
    for (const node of Object.values(data.nodes)) {
      if (node.type !== "folder" || !Array.isArray(node.children)) continue;
      const idx = node.children.indexOf(folderId);
      if (idx < 0) continue;
      node.children.splice(idx, 1, ...children);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    const group = getActiveGroup();
    group.nodes.push(...children);
  }
  delete data.nodes[folderId];
  queuePersist();
  render();
  toast(t("folder.dissolved"));
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

function moveGroupBefore(sourceId, targetId) {
  const targetIndex = [...data.groups]
    .sort((a, b) => a.order - b.order)
    .map((g) => g.id)
    .indexOf(targetId);
  moveGroupToIndex(sourceId, targetIndex);
}

function moveGroupToIndex(sourceId, index) {
  const ordered = [...data.groups].sort((a, b) => a.order - b.order).map((g) => g.id);
  const ids = ordered.filter((id) => id !== sourceId);
  const safeIndex = Math.max(0, Math.min(index, ids.length));
  ids.splice(safeIndex, 0, sourceId);
  ids.forEach((id, idx) => {
    const group = data.groups.find((g) => g.id === id);
    if (group) group.order = idx;
  });
  queuePersist();
  render();
}

function renameGroup(group) {
  const name = prompt(t("group.promptName"), group.name);
  if (!name) return;
  group.name = name.trim();
  queuePersist();
  render();
}

function deleteGroup(group) {
  if (data.groups.length <= 1) {
    toast(t("group.keepOne"), "warning");
    return;
  }
  if (!confirm(t("group.deleteConfirm", { name: group.name }))) return;
  pushBackup();
  // 删除分组时级联删除其下全部节点（含文件夹子孙），避免孤儿占存储
  const toDelete = new Set();
  for (const id of group.nodes || []) {
    for (const nid of collectNodeSubtreeIds(data, id)) toDelete.add(nid);
  }
  for (const id of toDelete) {
    removeNodeFromLocation(id);
    delete data.nodes[id];
  }
  data.groups = data.groups.filter((g) => g.id !== group.id);
  if (activeGroupId === group.id) activeGroupId = data.groups[0].id;
  dedupeData(data);
  queuePersist();
  render();
}

function deleteNodes(ids) {
  if (!ids.length) return;
  if (activeGroupId === RECENT_GROUP_ID) return;
  pushBackup();
  // 撤销只恢复本次删除的节点，避免整库快照抹掉后续编辑
  const deletedNodes = {};
  const expanded = new Set();
  for (const id of ids) {
    for (const nid of collectNodeSubtreeIds(data, id)) expanded.add(nid);
  }
  for (const id of expanded) {
    if (data.nodes[id]) deletedNodes[id] = deepClone(data.nodes[id]);
  }
  // 记录删除前各容器中的位置，便于精确回插
  const placements = [];
  for (const group of data.groups || []) {
    for (let i = 0; i < (group.nodes || []).length; i++) {
      const id = group.nodes[i];
      if (expanded.has(id)) placements.push({ kind: "group", groupId: group.id, index: i, id });
    }
  }
  for (const [folderId, node] of Object.entries(data.nodes || {})) {
    if (node?.type !== "folder" || !Array.isArray(node.children)) continue;
    for (let i = 0; i < node.children.length; i++) {
      const id = node.children[i];
      if (expanded.has(id)) placements.push({ kind: "folder", folderId, index: i, id });
    }
  }

  for (const id of expanded) {
    removeNodeFromLocation(id);
    delete data.nodes[id];
  }
  dedupeData(data);

  pendingDeletion = { deletedNodes, placements, ids: [...expanded], timer: null };
  queuePersist();
  render();

  toast(t("delete.deletedCount", { count: expanded.size }), t("delete.undo"), () => undoDelete());
  if (pendingDeletion.timer) clearTimeout(pendingDeletion.timer);
  pendingDeletion.timer = setTimeout(() => {
    pendingDeletion = null;
  }, UNDO_TIMEOUT_MS);
}

function undoDelete() {
  if (!pendingDeletion) return;
  if (pendingDeletion.timer) clearTimeout(pendingDeletion.timer);
  const { deletedNodes, placements } = pendingDeletion;
  pendingDeletion = null;
  // 先恢复节点实体
  for (const [id, node] of Object.entries(deletedNodes || {})) {
    data.nodes[id] = node;
  }
  // 再按原位置回插引用（倒序插入以尽量保持相对顺序）
  const sorted = [...(placements || [])].sort((a, b) => b.index - a.index);
  for (const p of sorted) {
    if (p.kind === "group") {
      const group = data.groups.find((g) => g.id === p.groupId);
      if (!group) continue;
      if (!Array.isArray(group.nodes)) group.nodes = [];
      if (!group.nodes.includes(p.id)) {
        const idx = Math.max(0, Math.min(p.index, group.nodes.length));
        group.nodes.splice(idx, 0, p.id);
      }
    } else if (p.kind === "folder") {
      const folder = data.nodes[p.folderId];
      if (folder?.type !== "folder") continue;
      if (!Array.isArray(folder.children)) folder.children = [];
      if (!folder.children.includes(p.id)) {
        const idx = Math.max(0, Math.min(p.index, folder.children.length));
        folder.children.splice(idx, 0, p.id);
      }
    }
  }
  dedupeData(data);
  queuePersist();
  render();
  toast(t("delete.restored"));
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

function parseModalHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="modal-root">${html}</div>`, "text/html");
  const root = doc.getElementById("modal-root");
  const fragment = document.createDocumentFragment();
  if (!root) return fragment;
  fragment.append(...Array.from(root.childNodes).map((node) => document.importNode(node, true)));
  return fragment;
}

function openModal(html) {
  elements.modal.replaceChildren(parseModalHtml(html));
  elements.modalOverlay.removeAttribute("inert");
  elements.modalOverlay.classList.remove("hidden");
  elements.modalOverlay.setAttribute("aria-hidden", "false");
  // 所有面板：回车默认触发主操作（保存/导入等）；搜索框除外（由搜索自己处理）
  bindModalEnterToDefaultAction();
}

/**
 * 弹窗内 Enter → 点击默认主按钮。
 * 优先级：btnSave > btnImportNow > btnAddHistorySave > btnImportUrlHttps > btnCopy > btnClose
 * 排除：顶部搜索、textarea（多行编辑用 Enter 换行）、已禁用的按钮。
 */
function bindModalEnterToDefaultAction() {
  const modal = elements.modal;
  if (!modal) return;
  // 去掉旧监听（每次 openModal 重绑）
  if (modal._enterHandler) {
    modal.removeEventListener("keydown", modal._enterHandler);
  }
  const handler = (e) => {
    if (e.key !== "Enter") return;
    if (e.isComposing || e.keyCode === 229) return; // IME 组字中不触发
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    const target = e.target;
    if (!(target instanceof Element)) return;

    // 搜索框：保持原搜索行为，不在这里处理
    if (target.id === "topSearch" || target.closest?.("#topSearchWrap")) return;

    // 多行文本：Enter 换行
    const tag = (target.tagName || "").toLowerCase();
    if (tag === "textarea") return;

    // contenteditable
    if (target.isContentEditable) return;

    // 已在可点击主按钮上：让浏览器默认/既有 click 走
    // 对 button 也统一走「找主按钮 click」，避免 type=button 时 Enter 无效果
    const defaultBtn = findModalDefaultActionButton(modal);
    if (!defaultBtn || defaultBtn.disabled) return;

    e.preventDefault();
    e.stopPropagation();
    defaultBtn.click();
  };
  modal._enterHandler = handler;
  modal.addEventListener("keydown", handler);
}

/**
 * @param {HTMLElement} modal
 * @returns {HTMLButtonElement | null}
 */
function findModalDefaultActionButton(modal) {
  const preferredIds = ["btnSave", "btnImportNow", "btnAddHistorySave", "btnImportUrlHttps", "btnCopy", "btnClose"];
  for (const id of preferredIds) {
    const btn = modal.querySelector?.(`#${id}`);
    if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
  }
  // 设置面板改完即存，且 actions 末钮是「刷新图标」——禁止 Enter 误触
  if (modal.querySelector?.(".settings-actions") && !modal.querySelector?.("#btnSave")) {
    return null;
  }
  // 其它有 .actions 的面板：取最后一个非 danger 按钮
  const actions = modal.querySelector?.(".actions");
  if (actions) {
    const buttons = [...actions.querySelectorAll("button.icon-btn, button")].filter(
      (b) => !b.disabled && !b.classList.contains("danger"),
    );
    if (buttons.length) return buttons[buttons.length - 1];
  }
  return null;
}

async function closeModal() {
  // 关闭前尽量刷掉 debounce 中的设置保存，避免点遮罩丢最后一次改动
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  const pendingSave = _settingsSaveNow;
  if (settingsOpen && typeof pendingSave === "function" && !settingsSaving) {
    try {
      await pendingSave();
    } catch (e) {
      console.warn("flush settings on closeModal failed", e);
    }
  }
  const activeEl = document.activeElement;
  if (activeEl && elements.modalOverlay.contains(activeEl)) {
    elements.btnSettings?.focus?.({ preventScroll: true });
  }
  elements.modalOverlay.setAttribute("inert", "");
  elements.modalOverlay.classList.add("hidden");
  elements.modalOverlay.setAttribute("aria-hidden", "true");
  modalPointerDownInsideDialog = false;
  elements.modal.replaceChildren();
  settingsOpen = false;
  settingsSaving = false;
  settingsSaveQueued = false;
  _settingsSaveNow = null;
  if (pendingStorageReload) {
    pendingStorageReload = false;
    scheduleStorageReload();
  }
}

function openAddModal() {
  const modalHtml = html`
    <h2>${t("modal.add.title")}</h2>
    <div class="section">
      <label>${t("field.url")}</label>
      <input id="fieldUrl" type="url" placeholder="https://" />
    </div>
    <div class="section">
      <label>${t("field.title")}</label>
      <input id="fieldTitle" type="text" placeholder="${t("field.titleOptional")}" />
    </div>
    <div class="section">
      <label>${t("field.iconSource")}</label>
      <select id="fieldIconType">
        <option value="auto">${t("field.icon.auto")}</option>
        <option value="upload">${t("field.icon.upload")}</option>
        <option value="color">${t("field.icon.color")}</option>
        <option value="remote">${t("field.icon.remote")}</option>
      </select>
    </div>
    <div id="iconExtra" class="section"></div>
    <div class="section">
      <button id="btnFromTab" class="icon-btn">${t("field.fromTab")}</button>
    </div>
    <div class="actions">
      <button id="btnCancel" class="icon-btn">${t("common.cancel")}</button>
      <button id="btnSave" class="icon-btn">${t("common.save")}</button>
    </div>
  `;
  openModal(modalHtml);

  const iconTypeEl = $("fieldIconType");
  const iconExtra = $("iconExtra");
  if (!iconTypeEl || !iconExtra) {
    console.warn("openAddModal: required fields missing after render");
    return;
  }

  function renderIconExtra(type) {
    iconExtra.replaceChildren();
    if (type === "upload") {
      const label = document.createElement("label");
      label.textContent = t("field.uploadIcon");
      const input = document.createElement("input");
      input.id = "fieldUpload";
      input.type = "file";
      input.accept = "image/*";
      iconExtra.appendChild(label);
      iconExtra.appendChild(input);
    } else if (type === "color") {
      const label = document.createElement("label");
      label.textContent = t("field.colorAvatar");
      const input = document.createElement("input");
      input.id = "fieldColor";
      input.type = "color";
      input.value = "#4dd6a8";
      iconExtra.appendChild(label);
      iconExtra.appendChild(input);
    } else if (type === "remote") {
      const label = document.createElement("label");
      label.textContent = t("field.remoteIconUrl");
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

  $("btnFromTab")?.addEventListener("click", async () => {
    const api = getChromeApi();
    if (!api?.tabs) return;
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (api.runtime?.lastError) {
        toast(t("error.invalidUrl"), "error");
        return;
      }
      const tab = tabs?.[0];
      if (!tab) return;
      const fieldUrl = $("fieldUrl");
      const fieldTitle = $("fieldTitle");
      if (fieldUrl) fieldUrl.value = tab.url || "";
      if (fieldTitle) fieldTitle.value = tab.title || "";
    });
  });

  $("btnCancel")?.addEventListener("click", closeModal);
  $("btnSave")?.addEventListener("click", async () => {
    const snapshot = deepClone(data);
    const url = normalizeUrl(($("fieldUrl")?.value || "").trim());
    if (!url) {
      toast(t("error.invalidUrl"), "error");
      return;
    }
    let title = ($("fieldTitle")?.value || "").trim();
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
      color = $("fieldColor")?.value || "#4dd6a8";
    } else if (iconType === "remote") {
      iconData = ($("fieldRemote")?.value || "").trim();
    }

    const iconPending = iconType === "auto";
    if (iconType === "auto") {
      iconType = "letter";
    }

    pushBackup();
    const node = createItemNode({
      url,
      title,
      iconType,
      iconData,
      color,
      titlePending,
      iconPending,
    });
    data.nodes[node.id] = node;

    if (openFolderId) {
      data.nodes[openFolderId].children.push(node.id);
    } else {
      const targetGroup = getActiveGroup();
      targetGroup.nodes.push(node.id);
      if (activeGroupId === RECENT_GROUP_ID) {
        activeGroupId = targetGroup.id;
      }
    }
    data.settings.lastActiveGroupId = getActiveGroup().id;
    debugLog("add_item", {
      id: node.id,
      url,
      groupId: openFolderId ? openFolderId : getActiveGroup().id,
      openFolderId: openFolderId || "",
    });
    const result = await persistData();
    if (!result.ok) {
      data = snapshot;
      render();
      toast(t("error.saveQuota"), "error");
      return;
    }
    render();
    closeModal();
    if (titlePending) fetchTitleInBackground(node.id, url);
    if (iconPending) fetchFaviconInBackground(node.id, url);
    if (result.warning === "local_trimmed_backups") {
      toast(t("toast.add.trimBackup"), "warning");
    } else if (result.warning === "local_trimmed_icons") {
      toast(t("toast.add.trimIcons"), "warning");
    } else if (result.warning === "local_trimmed_background") {
      toast(t("toast.add.trimBackground"), "warning");
    } else if (result.warning === "sync_quota_exceeded") {
      toast(t("toast.add.syncFallback"), "warning");
    } else if (result.warning === "sync_write_failed") {
      toast(t("toast.add.syncWriteFailed"), "warning");
    } else {
      toast(t("toast.add.success"));
    }
  });
}

function openEditModal(node) {
  // 嵌套 html 片段必须 rawHtml，否则会被外层 html 转义成纯文本（编辑弹窗炸裂）
  const itemFields =
    node.type === "item"
      ? rawHtml(html`
          <div class="section">
            <label>${t("field.url")}</label>
            <input id="fieldUrl" type="url" value="${node.url || ""}" />
          </div>
          <div class="section">
            <label>${t("field.iconSource")}</label>
            <select id="fieldIconType">
              <option value="auto">${t("field.icon.auto")}</option>
              <option value="upload">${t("field.icon.upload")}</option>
              <option value="color">${t("field.icon.color")}</option>
              <option value="remote">${t("field.icon.remote")}</option>
            </select>
          </div>
          <div id="iconExtra" class="section"></div>
        `)
      : "";
  const fetchIconBtn =
    node.type === "item"
      ? rawHtml(html`
          <div class="actions-start">
            <button id="btnFetchIcon" type="button" class="icon-btn">${t("field.icon.fetchNow")}</button>
          </div>
        `)
      : "";
  const modalHtml = html`
    <h2>${t("modal.edit.title")}</h2>
    <div class="section">
      <label>${t("field.title")}</label>
      <input id="fieldTitle" type="text" value="${node.title || ""}" />
    </div>
    ${itemFields}
    <div class="actions">
      ${fetchIconBtn}
      <button id="btnCancel" class="icon-btn">${t("common.cancel")}</button>
      <button id="btnSave" class="icon-btn">${t("common.save")}</button>
    </div>
  `;
  openModal(modalHtml);

  if (node.type === "item") {
    const iconTypeEl = $("fieldIconType");
    if (!iconTypeEl) {
      console.warn("openEditModal: fieldIconType missing after render");
      return;
    }
    iconTypeEl.value = node.iconType === "letter" ? "auto" : node.iconType || "auto";
    const iconExtra = $("iconExtra");
    function renderIconExtra(type) {
      if (!iconExtra) return;
      iconExtra.replaceChildren();
      if (type === "upload") {
        const label = document.createElement("label");
        label.textContent = t("field.uploadIcon");
        const input = document.createElement("input");
        input.id = "fieldUpload";
        input.type = "file";
        input.accept = "image/*";
        iconExtra.appendChild(label);
        iconExtra.appendChild(input);
      } else if (type === "color") {
        const label = document.createElement("label");
        label.textContent = t("field.colorAvatar");
        const input = document.createElement("input");
        input.id = "fieldColor";
        input.type = "color";
        input.value = node.color || "#4dd6a8";
        iconExtra.appendChild(label);
        iconExtra.appendChild(input);
      } else if (type === "remote") {
        const label = document.createElement("label");
        label.textContent = t("field.remoteIconUrl");
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

    const btnFetchIcon = $("btnFetchIcon");
    btnFetchIcon?.addEventListener("click", async () => {
      if (!btnFetchIcon || btnFetchIcon.disabled) return;
      const url = normalizeUrl(($("fieldUrl")?.value || "").trim() || node.url || "");
      if (!url) {
        toast(t("error.invalidUrl"), "error");
        return;
      }
      const original = t("field.icon.fetchNow");
      btnFetchIcon.disabled = true;
      btnFetchIcon.textContent = t("field.icon.fetching");
      try {
        // 只刷新图标缓存；节点字段等用户点「保存」再提交
        await clearIconCacheForUrl(url === node.url ? node.url : "", url);
        const ok = await fetchFaviconNow(node.id, url);
        if (ok) {
          if (iconTypeEl) iconTypeEl.value = "auto";
          renderIconExtra("auto");
          // 表单层面切到 auto，不改 node、不 persist
          toast(t("field.icon.fetchOk"));
          // 若抓取的是当前已保存 URL，刷新网格以显示新图标；URL 有改动时等保存后再显示
          if (url === node.url) {
            node.iconType = "auto";
            node.iconData = "";
            node.iconPending = false;
            render();
          }
        } else {
          toast(t("field.icon.fetchFail"), "warning");
        }
      } catch (e) {
        console.warn("btnFetchIcon failed", e);
        toast(t("field.icon.fetchFail"), "error");
      } finally {
        const live = $("btnFetchIcon");
        if (live) {
          live.disabled = false;
          live.textContent = original;
        }
      }
    });
  }

  $("btnCancel")?.addEventListener("click", closeModal);
  $("btnSave")?.addEventListener("click", async () => {
    // 先校验再改内存/备份，避免无效 URL 留下半截修改
    const nextTitle = ($("fieldTitle")?.value || "").trim() || node.title;
    let nextUrl = node.url;
    if (node.type === "item") {
      nextUrl = normalizeUrl(($("fieldUrl")?.value || "").trim());
      if (!nextUrl) {
        toast(t("error.invalidUrl"), "error");
        return;
      }
    }

    const snapshot = deepClone(data);
    pushBackup();

    const oldUrl = node.url;
    const oldIconType = node.iconType;

    node.title = nextTitle;
    if (node.type === "item") {
      const url = nextUrl;
      node.url = url;
      const iconType = $("fieldIconType")?.value || "auto";
      node.iconType = iconType;
      if (iconType === "upload") {
        const file = $("fieldUpload")?.files?.[0];
        if (file) node.iconData = await readFileAsDataUrl(file);
      } else if (iconType === "color") {
        node.color = $("fieldColor")?.value || node.color;
        node.iconData = "";
      } else if (iconType === "remote") {
        node.iconData = ($("fieldRemote")?.value || "").trim();
      } else {
        node.iconData = "";
      }

      const urlChanged = oldUrl !== url;
      const iconTypeChanged = oldIconType !== iconType;
      const shouldRefetchIcon = urlChanged || (iconTypeChanged && iconType === "auto");

      if (shouldRefetchIcon) {
        await clearIconCacheForUrl(oldUrl, url);
        if (iconType === "auto") {
          node.iconPending = true;
        }
      }
    }
    node.updatedAt = Date.now();
    const result = await persistData();
    if (!result.ok) {
      data = snapshot;
      render();
      toast(t("error.saveQuota"), "error");
      return;
    }
    render();
    closeModal();
    if (node.type === "item" && node.iconPending) {
      fetchFaviconInBackground(node.id, node.url);
    }
    if (result.warning === "local_trimmed_backups") {
      toast(t("toast.save.trimBackup"), "warning");
    } else if (result.warning === "local_trimmed_icons") {
      toast(t("toast.save.trimIcons"), "warning");
    } else if (result.warning === "local_trimmed_background") {
      toast(t("toast.save.trimBackground"), "warning");
    } else if (result.warning === "sync_quota_exceeded") {
      toast(t("toast.save.syncFallback"), "warning");
    } else if (result.warning === "sync_write_failed") {
      toast(t("toast.save.syncWriteFailed"), "warning");
    } else {
      toast(t("toast.save.success"));
    }
  });
}

async function openOpenModeMenu() {
  const modes = [
    { id: "current", label: t("openMode.current") },
    { id: "new", label: t("openMode.new") },
    { id: "background", label: t("openMode.background") },
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
    toast(t("openMode.saveFailed"), "error");
  }
}

/** 离开设置主表单进入子面板前：刷掉 debounce 中的保存，避免改动丢失 */
async function leaveSettingsForSubpanel() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  const pending = _settingsSaveNow;
  if (typeof pending === "function" && !settingsSaving) {
    try {
      await pending();
    } catch (e) {
      console.warn("leaveSettingsForSubpanel flush failed", e);
    }
  }
  settingsOpen = false;
  _settingsSaveNow = null;
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

function downloadJsonFile(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openSyncConflictModal() {
  const pending = getPendingConflict();
  if (!pending) {
    toast(t("settings.sync.state.idle"));
    return;
  }
  const modalHtml = html`
    <h2>${t("settings.sync.conflict.title")}</h2>
    <div class="section">
      <p>${t("settings.sync.conflict.desc")}</p>
      <p class="settings-sync-hint">local: ${pending.localDocId || "-"}<br/>remote: ${pending.remoteDocId || "-"}</p>
    </div>
    <div class="actions">
      <button type="button" id="btnConflictMerge" class="icon-btn">${t("settings.sync.conflict.merge")}</button>
      <button type="button" id="btnConflictLocal" class="icon-btn">${t("settings.sync.conflict.local")}</button>
      <button type="button" id="btnConflictRemote" class="icon-btn">${t("settings.sync.conflict.remote")}</button>
      <button type="button" id="btnConflictCancel" class="icon-btn">${t("common.cancel")}</button>
    </div>
  `;
  openModal(modalHtml);
  const run = async (choice) => {
    const btnIds = ["btnConflictMerge", "btnConflictLocal", "btnConflictRemote", "btnConflictCancel"];
    for (const id of btnIds) {
      const b = $(id);
      if (b) b.disabled = true;
    }
    try {
      const res = await resolveDocConflict(choice);
      if (!res?.ok) {
        toast(t("settings.sync.importFail", { reason: res?.reason || "conflict" }), "error");
        return;
      }
      closeModal();
      toast(t("settings.sync.conflict.done"));
      render();
      processPendingIconFetches();
      // 若设置仍打开则刷新状态（关闭后由下次打开刷新）
    } catch (e) {
      toast(t("settings.sync.importFail", { reason: e?.message || "conflict" }), "error");
    }
  };
  $("btnConflictMerge")?.addEventListener("click", () => void run("merge"));
  $("btnConflictLocal")?.addEventListener("click", () => void run("local"));
  $("btnConflictRemote")?.addEventListener("click", () => void run("remote"));
  $("btnConflictCancel")?.addEventListener("click", () => closeModal());
}

/** 从设置表单即时读入同步相关字段（不依赖 debounce 保存） */
function applySyncSettingsFromForm() {
  if (!data.settings) data.settings = {};
  const syncEl = $("settingSync");
  const transportEl = $("settingSyncTransport");
  const urlEl = $("settingSyncServerUrl");
  const tokenEl = $("settingSyncServerToken");
  if (syncEl) data.settings.syncEnabled = !!syncEl.checked;
  if (transportEl) data.settings.syncTransport = transportEl.value === "http" ? "http" : "browser";
  if (urlEl) data.settings.syncServerUrl = (urlEl.value || "").trim();
  if (tokenEl) data.settings.syncServerToken = (tokenEl.value || "").trim();
  return {
    enabled: !!data.settings.syncEnabled,
    transport: data.settings.syncTransport || "browser",
    url: data.settings.syncServerUrl || "",
    token: data.settings.syncServerToken || "",
  };
}

async function refreshSyncStatusLine() {
  const el = $("syncStatusLine");
  if (!el) return;
  try {
    const st = getSyncStatus();
    const deviceId = await getOrCreateDeviceId();
    const bytes = st.bytesEstimate || estimateSyncProjectionBytes(data, { deviceId, docId: st.docId || "doc_ui" });
    const level = st.budgetLevel || syncBytesBudgetLevel(bytes);
    const kb = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
    const budgetKey =
      level === "red"
        ? "settings.sync.budget.red"
        : level === "yellow"
          ? "settings.sync.budget.yellow"
          : "settings.sync.budget.green";
    const statusKey =
      st.status === "syncing"
        ? "settings.sync.state.syncing"
        : st.status === "quota"
          ? "settings.sync.state.quota"
          : st.status === "error"
            ? "settings.sync.state.error"
            : st.status === "need_setup"
              ? "settings.sync.state.conflict"
              : data.settings.syncEnabled
                ? "settings.sync.state.idle"
                : "settings.sync.state.off";
    const err = st.lastError ? ` · ${st.lastError}` : "";
    const via = st.transport === "http" ? t("settings.sync.transport.http") : t("settings.sync.transport.browser");
    el.textContent = `${t(statusKey)} · ${via} · ${t("settings.sync.size", { size: kb })} · ${t(budgetKey)}${err}`;
    el.dataset.level = st.status === "error" || st.status === "quota" || st.status === "need_setup" ? "red" : level;
    const resolveBtn = $("btnSyncResolveConflict");
    if (resolveBtn) {
      resolveBtn.classList.toggle("hidden", !(st.hasConflict || st.status === "need_setup"));
    }
    const safariHint = $("syncSafariHint");
    if (safariHint) {
      safariHint.classList.toggle("hidden", !isSafariBrowser());
    }
  } catch (e) {
    console.warn("refreshSyncStatusLine failed", e);
    el.textContent = "";
  }
}

function openSettingsModal() {
  settingsOpen = true;
  const modalHtml = html`
    <div class="section settings-actions">
      <button id="btnExport" class="icon-btn">${t("settings.action.export")}</button>
      <button id="btnImport" class="icon-btn">${t("settings.action.import")}</button>
      <button id="btnImportUrl" class="icon-btn">${t("settings.action.importUrl")}</button>
      <button id="btnBackupManage" class="icon-btn">${t("settings.action.backup")}</button>
      <button id="btnClearData" class="icon-btn danger strong-label">${t("settings.action.clearData")}</button>
      <button id="btnClearCards" class="icon-btn danger">${t("settings.action.clearCards")}</button>
      <button id="btnRefreshIcons" class="icon-btn">${t("settings.action.refreshIcons")}</button>
    </div>
    <div class="section settings-language-row">
      <div class="row-inline settings-language-wrap">
        <span class="settings-language-hint">中/臺/EN/JP/KR/DE/FR/ES</span>
        <select id="settingLanguage" class="inline-select settings-language-select">${rawHtml(buildLanguageOptions(data.settings.language))}</select>
      </div>
      <span id="settingsVersion" class="build-version"></span>
    </div>

    <div class="section">
      <label><input id="settingShowSearch" type="checkbox"> ${t("settings.showSearch")}</label>
      <div class="row-inline">
        <span class="inline-label">${t("settings.searchEngine")}</span>
        <select id="settingSearchEnginePreset" class="inline-select">
          <option value="https://www.google.com/search?q=">Google</option>
          <option value="https://www.baidu.com/s?wd=">百度</option>
          <option value="https://www.bing.com/search?q=">Bing</option>
          <option value="https://www.so.com/s?q=">360</option>
          <option value="https://www.yandex.com/search/?text=">Yandex</option>
          <option value="custom">${t("settings.searchEngine.custom")}</option>
        </select>
      </div>
      <input id="settingSearchEngine" type="text" placeholder="https://www.bing.com/search?q=" class="inline-text" />
    </div>


    <div class="section">
      <div class="row-inline">
        <label><input id="settingFixedLayout" type="checkbox"> ${t("settings.fixedLayout")}</label>
        <div class="inline-field">
          <input id="settingCols" type="number" min="1" />
        </div>
      </div>
      <div class="row-inline density-row">
        <span class="inline-label">${t("settings.tileGap")}</span>
        <label><input type="radio" name="density" value="compact" /> ${t("settings.density.compact")}</label>
        <label><input type="radio" name="density" value="standard" /> ${t("settings.density.standard")}</label>
        <label><input type="radio" name="density" value="spacious" /> ${t("settings.density.spacious")}</label>
      </div>
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">${t("settings.background")}</span>
        <select id="settingBgType" class="inline-select">
          <option value="bing">${t("settings.background.bing")}</option>
          <option value="color">${t("settings.background.color")}</option>
          <option value="gradient">${t("settings.background.gradient")}</option>
          <option value="custom">${t("settings.background.custom")}</option>
        </select>
      </div>
      <div id="bgColorWrap">
        
        <input id="settingBgColor" type="color" />
      </div>
      <div id="bgGradientWrap">
        <label>${t("settings.gradientColor")}</label>
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
        <span class="inline-label">${t("settings.bgOverlay")}</span>
        <input id="settingBgOverlay" type="range" min="0" max="0.6" step="0.01" class="inline-range" />
        <span id="settingBgOverlayValue" class="inline-value"></span>
      </div>
    </div>

    <div class="section">
      <label><input id="settingTooltip" type="checkbox"> ${t("settings.tooltip")}</label>
      <label><input id="settingKeyboard" type="checkbox"> ${t("settings.keyboard")}</label>
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">${t("settings.theme")}</span>
        <select id="settingTheme" class="inline-select">
          <option value="system">${t("settings.theme.system")}</option>
          <option value="light">${t("settings.theme.light")}</option>
          <option value="dark">${t("settings.theme.dark")}</option>
        </select>
      </div>
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">${t("settings.fontSize")}</span>
        <input id="settingFontSize" type="number" min="10" max="24" class="inline-number" />
      </div>
    </div>

    <div class="section">
      <div class="row-inline">
        <span class="inline-label">${t("settings.defaultGroup")}</span>
      </div>
      <div class="row-inline">
        <select id="settingDefaultGroupId" class="inline-select"></select>
      </div>
    </div>

    <div class="section">
      <label><input id="settingSidebarCollapsed" type="checkbox"> ${t("settings.hideSidebar")}</label>
    </div>

    <div class="section">
      <label><input id="settingSync" type="checkbox"> ${t("settings.sync")}</label>
      <div class="row-inline">
        <span class="inline-label">${t("settings.sync.transport")}</span>
        <select id="settingSyncTransport" class="inline-select">
          <option value="browser">${t("settings.sync.transport.browser")}</option>
          <option value="http">${t("settings.sync.transport.http")}</option>
        </select>
      </div>
      <div id="syncHttpFields" class="settings-sync-http hidden">
        <div class="row-inline">
          <span class="inline-label">${t("settings.sync.serverUrl")}</span>
          <input id="settingSyncServerUrl" type="url" class="inline-text" placeholder="${t("settings.sync.serverUrlPh")}" />
        </div>
        <div class="row-inline">
          <span class="inline-label">${t("settings.sync.serverToken")}</span>
          <input id="settingSyncServerToken" type="password" class="inline-text" autocomplete="off" />
        </div>
        <div class="row-inline settings-sync-actions">
          <button type="button" id="btnSyncTestServer" class="icon-btn">${t("settings.sync.testServer")}</button>
        </div>
      </div>
      <div id="syncStatusLine" class="settings-sync-status"></div>
      <div class="row-inline settings-sync-actions">
        <button type="button" id="btnSyncNow" class="icon-btn">${t("settings.sync.now")}</button>
        <button type="button" id="btnSyncResolveConflict" class="icon-btn hidden">${t("settings.sync.state.conflict")}</button>
        <button type="button" id="btnSyncExportBundle" class="icon-btn">${t("settings.sync.exportBundle")}</button>
        <button type="button" id="btnSyncImportBundle" class="icon-btn">${t("settings.sync.importBundle")}</button>
        <button type="button" id="btnSyncExportFile" class="icon-btn">${t("settings.sync.exportFile")}</button>
        <button type="button" id="btnSyncImportFile" class="icon-btn">${t("settings.sync.importFile")}</button>
      </div>
      <input id="syncImportFileInput" type="file" accept="application/json,.json" class="hidden" />
      <p class="settings-sync-hint">${t("settings.sync.hint")}</p>
      <p id="syncSafariHint" class="settings-sync-hint hidden">${t("settings.sync.safariHint")}</p>
      <div class="row-inline">
        <span class="inline-label">${t("settings.openMode")}</span>
        <select id="settingOpenMode" class="inline-select">
          <option value="current">${t("openMode.current")}</option>
          <option value="new">${t("openMode.new")}</option>
          <option value="background">${t("openMode.background")}</option>
        </select>
      </div>
      <div class="row-inline">
        <span class="inline-label">${t("settings.maxBackups")}</span>
        <input id="settingBackup" type="number" min="0" class="inline-number" />
      </div>
      <div class="row-inline">
        <span class="inline-label">${t("settings.iconRetry")}</span>
        <select id="settingIconRetryHour" class="inline-select">
          <option value="">${t("settings.retryDisabled")}</option>
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

  `;
  openModal(modalHtml);

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
  // 形如 "linear-gradient(120deg, #aaa, #bbb)"，跳过角度，直接取两个颜色
  const match = /linear-gradient\([^,]+,\s*([^,]+),\s*([^)]+)\)/.exec(data.settings.backgroundGradient || "");
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
  $("settingLanguage").value = currentLang();
  $("settingSync").checked = data.settings.syncEnabled;
  const transportSel = $("settingSyncTransport");
  if (transportSel) transportSel.value = data.settings.syncTransport === "http" ? "http" : "browser";
  const urlInput = $("settingSyncServerUrl");
  if (urlInput) urlInput.value = data.settings.syncServerUrl || "";
  const tokenInput = $("settingSyncServerToken");
  if (tokenInput) tokenInput.value = data.settings.syncServerToken || "";
  const httpFields = $("syncHttpFields");
  const syncHttpVisibility = () => {
    if (httpFields) httpFields.classList.toggle("hidden", transportSel?.value !== "http");
  };
  syncHttpVisibility();
  transportSel?.addEventListener("change", syncHttpVisibility);
  $("btnSyncTestServer")?.addEventListener("click", async () => {
    const cfg = applySyncSettingsFromForm();
    const baseUrl = cfg.url;
    const token = cfg.token;
    if (!baseUrl) {
      toast(t("settings.sync.testFail", { reason: "no_url" }), "error");
      return;
    }
    // 先 health（可达性），再 pull state（鉴权；404 表示空库也算鉴权通过）
    const health = await httpHealth({ baseUrl, token });
    if (!health.ok && health.reason === "network_error") {
      toast(
        t("settings.sync.testFail", {
          reason: `network_error · ${health.error || "服务未启动？"}`,
        }),
        "error",
      );
      return;
    }
    const pull = await httpPullState({ baseUrl, token });
    if (pull.reason === "unauthorized") {
      toast(t("settings.sync.unauthorized"), "error");
      return;
    }
    if (pull.ok || pull.reason === "no_remote") {
      toast(t("settings.sync.testOk"));
      return;
    }
    const detail = [pull.reason, pull.error, pull.status != null ? `HTTP ${pull.status}` : ""]
      .filter(Boolean)
      .join(" · ");
    toast(t("settings.sync.testFail", { reason: detail || health.reason || "error" }), "error");
  });
  void refreshSyncStatusLine();
  $("btnSyncNow")?.addEventListener("click", async () => {
    const btn = $("btnSyncNow");
    if (btn) btn.disabled = true;
    try {
      // 立即同步前先把表单里的同步配置写入 data（避免只改了 UI 未保存）
      const prevEnabled = !!data.settings.syncEnabled;
      const prevTransport = data.settings.syncTransport || "browser";
      const prevUrl = data.settings.syncServerUrl || "";
      const prevToken = data.settings.syncServerToken || "";
      const cfg = applySyncSettingsFromForm();
      if (!cfg.enabled) {
        toast(t("settings.sync.state.off"), "warning");
        void refreshSyncStatusLine();
        return;
      }
      if (cfg.transport === "http" && !cfg.url) {
        toast(t("settings.sync.testFail", { reason: "no_url" }), "error");
        void refreshSyncStatusLine();
        return;
      }
      // 落盘配置（仅 local），再触发同步
      await saveData(data, false);
      const transportChanged = prevTransport !== cfg.transport || prevUrl !== cfg.url || prevEnabled !== cfg.enabled;
      if (transportChanged) {
        await onSyncEnabledChanged(true);
        const st = getSyncStatus();
        if (String(st.lastError || "").includes("unauthorized")) toast(t("settings.sync.unauthorized"), "error");
        else if (st.status === "error" && st.lastError) toast(t("settings.sync.testFail", { reason: st.lastError }), "error");
        else if (st.status === "quota") toast(t("settings.sync.state.quota"), "warning");
        else toast(t("settings.sync.nowOk"));
      } else {
        const pull = await pullNow("manual");
        if (pull?.reason === "doc_conflict") {
          openSyncConflictModal();
          void refreshSyncStatusLine();
          return;
        }
        if (pull?.reason === "unauthorized") {
          toast(t("settings.sync.unauthorized"), "error");
          void refreshSyncStatusLine();
          return;
        }
        if (pull?.reason === "network_error" || pull?.reason === "no_url") {
          toast(
            t("settings.sync.testFail", {
              reason: (pull.reason || "") + (pull.error ? ` · ${pull.error}` : ""),
            }),
            "error",
          );
          void refreshSyncStatusLine();
          return;
        }
        const res = await pushNow("manual");
        if (res?.reason === "doc_conflict") {
          openSyncConflictModal();
        } else if (res?.reason === "sync_quota_total") toast(t("settings.sync.state.quota"), "warning");
        else if (res?.reason === "unauthorized") {
          toast(t("settings.sync.unauthorized"), "error");
        } else if (res?.reason === "network_error" || res?.reason === "no_url") {
          const r = res?.reason || "error";
          const err = res?.error || "";
          toast(t("settings.sync.testFail", { reason: err ? `${r} · ${err}` : r }), "error");
        } else if (res && res.ok === false) {
          toast(t("settings.sync.importFail", { reason: res.reason || "push" }), "error");
        } else toast(t("settings.sync.nowOk"));
      }
      void refreshSyncStatusLine();
      render();
    } catch (e) {
      toast(t("settings.sync.importFail", { reason: e?.message || "sync" }), "error");
    } finally {
      const live = $("btnSyncNow");
      if (live) live.disabled = false;
    }
  });
  $("btnSyncExportBundle")?.addEventListener("click", async () => {
    try {
      const deviceId = await getOrCreateDeviceId();
      const bundle = exportSyncBundle(data, {
        deviceId,
        docId: createDocId(),
        platform: /firefox/i.test(navigator.userAgent)
          ? "firefox"
          : /safari/i.test(navigator.userAgent) && !/chrome|crios|android/i.test(navigator.userAgent)
            ? "safari"
            : "chrome",
      });
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      toast(t("settings.sync.exportOk"));
    } catch (e) {
      toast(t("settings.sync.importFail", { reason: e?.message || "export" }), "error");
    }
  });
  $("btnSyncImportBundle")?.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const bundle = JSON.parse(text);
      const deviceId = await getOrCreateDeviceId();
      const result = importSyncBundle(data, bundle, { deviceId });
      if (!result.ok) {
        toast(t("settings.sync.importFail", { reason: result.reason || "merge" }), "error");
        return;
      }
      pushBackup();
      data = result.state;
      if (!data.settings) data.settings = {};
      // 保持用户当前同步开关
      await persistData();
      render();
      processPendingIconFetches();
      toast(t("settings.sync.importOk"));
      void refreshSyncStatusLine();
    } catch (e) {
      toast(t("settings.sync.importFail", { reason: e?.message || "parse" }), "error");
    }
  });

  $("btnSyncResolveConflict")?.addEventListener("click", () => openSyncConflictModal());
  $("btnSyncExportFile")?.addEventListener("click", async () => {
    try {
      const deviceId = await getOrCreateDeviceId();
      const st = getSyncStatus();
      const bundle = exportSyncBundle(data, {
        deviceId,
        docId: st.docId || createDocId(),
        platform: detectExtensionPlatform(),
      });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      downloadJsonFile(`homepage-sync-${stamp}.json`, bundle);
      toast(t("settings.sync.exportOk"));
    } catch (e) {
      toast(t("settings.sync.importFail", { reason: e?.message || "export" }), "error");
    }
  });
  $("btnSyncImportFile")?.addEventListener("click", () => {
    $("syncImportFileInput")?.click();
  });
  $("syncImportFileInput")?.addEventListener("change", async (e) => {
    const file = e.target?.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const deviceId = await getOrCreateDeviceId();
      const result = importSyncBundle(data, bundle, { deviceId });
      if (!result.ok) {
        toast(t("settings.sync.importFail", { reason: result.reason || "merge" }), "error");
        return;
      }
      pushBackup();
      data = result.state;
      if (!data.settings) data.settings = {};
      await persistData();
      render();
      processPendingIconFetches();
      toast(t("settings.sync.importOk"));
      void refreshSyncStatusLine();
    } catch (err) {
      toast(t("settings.sync.importFail", { reason: err?.message || "parse" }), "error");
    }
  });

  $("settingOpenMode").value = data.settings.openMode || "current";
  $("settingBackup").value = data.settings.maxBackups;
  const retryHour = data.settings.iconRetryHour ?? (data.settings.iconRetryAtSix ? 18 : "");
  $("settingIconRetryHour").value = retryHour === "" ? "" : String(retryHour);
  $("settingSidebarCollapsed").checked = data.settings.sidebarHidden;
  $("settingSidebarCollapsed").addEventListener("change", (e) => {
    data.settings.sidebarHidden = e.target.checked;
    applySidebarState();
  });

  const defaultGroupId = $("settingDefaultGroupId");
  defaultGroupId.replaceChildren();
  const lastOpt = document.createElement("option");
  lastOpt.value = "";
  lastOpt.textContent = t("settings.lastAddedGroup");
  defaultGroupId.appendChild(lastOpt);
  [...data.groups]
    .sort((a, b) => a.order - b.order)
    .forEach((g) => {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = g.name;
      defaultGroupId.appendChild(opt);
    });
  const useFixed = data.settings.defaultGroupMode === "fixed" && data.settings.defaultGroupId;
  defaultGroupId.value = useFixed ? data.settings.defaultGroupId : "";

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
  $("settingLanguage").addEventListener("change", async () => {
    data.settings.language = normalizeLanguage($("settingLanguage").value) || detectPreferredLanguage();
    applyStaticI18n();
    render();
    await persistData();
    if (settingsOpen) openSettingsModal();
  });

  $("btnExport").addEventListener("click", () => exportJsonToClipboard());
  $("btnImport").addEventListener("click", () => openImportModal());
  $("btnImportUrl").addEventListener("click", () => openImportUrlModal());
  $("btnBackupManage").addEventListener("click", () => openBackupModal());
  $("btnClearData").addEventListener("click", async () => {
    if (!confirm(t("confirm.clearData"))) return;
    const keepLanguage = currentLang();
    // 必须在重置前记下是否开过同步，否则 defaultData 会把 syncEnabled 置 false，云端清不掉
    const prevSync = !!data?.settings?.syncEnabled;
    await clearData(false);
    if (prevSync) await clearData(true);
    data = defaultData();
    data.settings.language = keepLanguage;
    data.settings.syncEnabled = false;
    if (data.groups?.[0]) data.groups[0].name = t("group.default");
    activeGroupId = data.groups[0].id;
    await persistData();
    closeModal();
    render();
    toast(t("toast.cleared"));
  });
  $("btnClearCards").addEventListener("click", async () => {
    if (!confirm(t("confirm.clearCards"))) return;
    pushBackup();
    const preservedSettings = deepClone(data.settings || {});
    const groupId = `grp_${Date.now()}`;
    data.nodes = {};
    data.groups = [{ id: groupId, name: t("group.default"), order: 0, nodes: [] }];
    data.settings = preservedSettings;
    activeGroupId = groupId;
    await persistData();
    closeModal();
    render();
    toast(t("toast.cardsCleared"));
  });
  $("btnRefreshIcons").addEventListener("click", async () => {
    const btn = $("btnRefreshIcons");
    if (!btn || btn.disabled) return;
    const originalLabel = t("settings.action.refreshIcons");
    btn.disabled = true;
    btn.textContent = t("settings.action.refreshingIcons");
    try {
      await refreshAllIcons(Object.values(data.nodes || {}));
      render();
      toast(t("toast.iconsRefreshed"));
    } catch (e) {
      console.warn("refreshAllIcons failed", e);
      toast(t("toast.iconsRefreshed"), "warning");
    } finally {
      // 设置面板可能仍开着；若按钮还在 DOM 上则恢复文案
      const live = $("btnRefreshIcons");
      if (live) {
        live.disabled = false;
        live.textContent = originalLabel;
      }
    }
  });

  const saveSettings = async ({ close = false, toastOnSave = false } = {}) => {
    if (settingsSaving) {
      settingsSaveQueued = true;
      return;
    }
    // 设置表单不在 DOM（已进入导入/导出等子面板）时不要读 null
    if (!$("settingShowSearch")) {
      return;
    }
    settingsSaving = true;
    try {
      qsa(".group-name", elements.modal).forEach((input) => {
        const row = input.closest("[data-group]");
        const id = row.dataset.group;
        const group = data.groups.find((g) => g.id === id);
        if (group) group.name = input.value.trim() || group.name;
      });

      data.settings.showSearch = $("settingShowSearch").checked;
      data.settings.enableSearchEngine = true;
      {
        const engineInput = $("settingSearchEngine").value.trim();
        if (engineInput) {
          const normalizedEngine = normalizeUrl(engineInput);
          data.settings.searchEngineUrl = normalizedEngine || data.settings.searchEngineUrl;
        }
      }
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
      data.settings.language = normalizeLanguage($("settingLanguage").value) || detectPreferredLanguage();
      const selectedDefaultGroupId = $("settingDefaultGroupId").value;
      data.settings.defaultGroupMode = selectedDefaultGroupId ? "fixed" : "last";
      data.settings.defaultGroupId = selectedDefaultGroupId;
      data.settings.sidebarHidden = $("settingSidebarCollapsed").checked;
      const prevSyncEnabled = !!data.settings.syncEnabled;
      const prevTransport = data.settings.syncTransport || "browser";
      const prevUrl = data.settings.syncServerUrl || "";
      const prevToken = data.settings.syncServerToken || "";
      data.settings.syncEnabled = $("settingSync").checked;
      data.settings.syncTransport = $("settingSyncTransport")?.value === "http" ? "http" : "browser";
      data.settings.syncServerUrl = ($("settingSyncServerUrl")?.value || "").trim();
      data.settings.syncServerToken = ($("settingSyncServerToken")?.value || "").trim();
      const transportChanged =
        prevTransport !== data.settings.syncTransport ||
        prevUrl !== data.settings.syncServerUrl ||
        prevToken !== data.settings.syncServerToken;
      if (prevSyncEnabled !== data.settings.syncEnabled || (data.settings.syncEnabled && transportChanged)) {
        void onSyncEnabledChanged(data.settings.syncEnabled);
      }
      data.settings.openMode = $("settingOpenMode").value || "current";
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
      applyStaticI18n();
      await persistData();
      render();
      loadBackground();
      if (toastOnSave) toast(t("settings.saved"));
      if (close) closeModal();
    } finally {
      settingsSaving = false;
    }
    if (settingsSaveQueued) {
      settingsSaveQueued = false;
      void saveSettings({ close: false, toastOnSave: false });
      return;
    }
  };
  _settingsSaveNow = saveSettings;

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
    el.addEventListener(eventName, () => scheduleSettingsSave(false));
  });
  $("settingBgFile").addEventListener("change", () => scheduleSettingsSave(true));
  $("settingBgOverlay").addEventListener("input", () => {
    $("settingBgOverlayValue").textContent = `${Math.round(Number($("settingBgOverlay").value) * 100)}%`;
  });
  const version = getAppVersion();
  $("settingsVersion").textContent = version || "";
}

async function exportJsonToClipboard() {
  try {
    const payload = JSON.stringify(data, null, 2);
    await navigator.clipboard.writeText(payload);
    toast("设置、卡片、分组数据都已复制到剪切板", "success");
  } catch (err) {
    toast(`导出设置失败：${err.message || "无法写入剪切板"}`, "error");
    openManualExportModal();
  }
}

function openManualExportModal() {
  void leaveSettingsForSubpanel();
  const payload = JSON.stringify(data, null, 2);
  const modalHtml = html`
    <h2>导出设置</h2>
    <div class="section">
      <textarea readonly>${payload}</textarea>
    </div>
    <div class="actions">
      <button id="btnCopy" class="icon-btn">复制</button>
      <button id="btnClose" class="icon-btn">关闭</button>
    </div>
  `;
  openModal(modalHtml);
  $("btnCopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(payload);
      toast("已复制到剪切板", "success");
    } catch (err) {
      toast(`复制失败：${err.message || "无法写入剪切板"}`, "error");
    }
  });
  $("btnClose").addEventListener("click", closeModal);
}

async function openImportModal() {
  await leaveSettingsForSubpanel();

  const modalHtml = html`
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
  openModal(modalHtml);
  $("btnCancel").addEventListener("click", closeModal);
  $("btnImportNow").addEventListener("click", async () => {
    try {
      const incoming = JSON.parse($("importText").value.trim());
      const mode = $("importMode").value;
      if (!incoming || typeof incoming !== "object") throw new Error("数据格式不合法");
      // 运行时 schema 校验：修复非法字段、清理悬空引用、合并默认 settings
      const repairedIncoming = repairHomepageData(incoming, defaultSettings());
      if (!repairedIncoming.schemaVersion) throw new Error("无 schemaVersion");
      pushBackup();
      if (mode === "replace") {
        data = repairedIncoming;
      } else if (mode === "merge") {
        const incomingNodes = repairedIncoming.nodes || {};
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
        for (const group of repairedIncoming.groups || []) {
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
        const incomingNodes = repairedIncoming.nodes || {};
        for (const [id, node] of Object.entries(incomingNodes)) {
          if (!data.nodes[id]) data.nodes[id] = node;
        }
        const existingById = new Map(data.groups.map((g) => [g.id, g]));
        for (const group of repairedIncoming.groups || []) {
          const target = existingById.get(group.id);
          if (!target) {
            data.groups.push(group);
            existingById.set(group.id, group);
            continue;
          }
          // 同 ID 分组：只追加本地尚不存在的节点引用，避免仅新增节点被孤儿 GC 清掉
          const have = new Set(target.nodes || []);
          for (const nid of group.nodes || []) {
            if (!have.has(nid) && data.nodes[nid]) {
              target.nodes.push(nid);
              have.add(nid);
            }
          }
        }
      }
      // 导入完成后对所有节点 URL 做协议白名单校验，丢弃危险协议
      if (data?.nodes) {
        for (const id of Object.keys(data.nodes)) {
          const node = data.nodes[id];
          if (!node || node.type === "folder") continue;
          const safe = normalizeUrl(node.url);
          if (!safe) {
            delete data.nodes[id];
            for (const g of data.groups || []) {
              if (Array.isArray(g.nodes)) g.nodes = g.nodes.filter((nid) => nid !== id);
            }
          } else {
            node.url = safe;
          }
        }
      }
      await persistData();
      closeModal();
      render();
      processPendingIconFetches();
      toast("导入设置成功", "success");
    } catch (err) {
      toast(`导入设置失败，你检查一下你的设置对了嘛，先去你其它浏览器导出设置才能导入设置：${err.message}`, "error");
    }
  });

  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $("importText").value = text;
      toast("已从剪切板读取", "success");
    } else {
      toast("剪切板为空", "warning");
    }
  } catch (err) {
    toast(`读取剪切板失败：${err.message || "权限受限"}`, "error");
  }
}

function openImportUrlModal() {
  void leaveSettingsForSubpanel();

  if (!data.groups?.length) {
    toast(t("group.noneAvailable"), "warning");
    return;
  }
  const options = rawHtml(
    [...data.groups]
      .sort((a, b) => a.order - b.order)
      .map((g) => html`<option value="${g.id}">${g.name}</option>`)
      .join(""),
  );
  const modalHtml = html`
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
  openModal(modalHtml);
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
      toast(t("group.notFound"), "error");
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
      toast(t("import.noUrls"), "warning");
      return;
    }
    if (!Array.isArray(group.nodes)) group.nodes = [];
    pushBackup();
    for (const url of urls) {
      let title = "";
      try {
        title = new URL(url).hostname;
      } catch (_e) {
        title = "";
      }
      const node = createItemNode({ url, title, iconType: "auto", iconPending: true });
      data.nodes[node.id] = node;
      group.nodes.push(node.id);
    }
    data.settings.lastActiveGroupId = group.id;
    await persistData();
    closeWithCleanup();
    render();
    processPendingIconFetches();
    toast(
      invalid ? `已导入 ${urls.length} 条，忽略 ${invalid} 条` : `已导入 ${urls.length} 条`,
      invalid ? "warning" : "success",
    );
  };

  $("btnImportUrlCancel").addEventListener("click", closeWithCleanup);
  $("btnImportUrlHttp").addEventListener("click", () => importWithScheme("http"));
  $("btnImportUrlHttps").addEventListener("click", () => importWithScheme("https"));
}

function openBackupModal() {
  void leaveSettingsForSubpanel();
  const list = rawHtml(
    data.backups
      .map(
        (b) =>
          html`<div class="row" data-backup="${b.id}"><div>${new Date(b.ts).toLocaleString()}</div><div class="row-actions"><button class="icon-btn backup-restore">恢复</button><button class="icon-btn backup-delete">删除</button></div></div>`,
      )
      .join(""),
  );
  const modalHtml = html`
    <h2>备份管理</h2>
    <div class="section">${list || "暂无备份"}</div>
    <div class="actions"><button id="btnClose" class="icon-btn">关闭</button></div>
  `;
  openModal(modalHtml);
  qsa(".backup-restore", elements.modal).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-backup]");
      const backup = data.backups.find((b) => b.id === row.dataset.backup);
      if (!backup) return;
      const backupsBeforeRestore = Array.isArray(data.backups) ? cloneDataSnapshot(data.backups) : [];
      // 恢复前先做运行时 schema 校验，避免损坏的备份快照原样进入运行态
      const restoredData = repairHomepageData(cloneDataSnapshot(backup.data), defaultSettings());
      restoredData.backups = backupsBeforeRestore;
      // 恢复后对所有节点 URL 做协议白名单校验，丢弃危险协议
      if (restoredData?.nodes) {
        for (const id of Object.keys(restoredData.nodes)) {
          const node = restoredData.nodes[id];
          if (!node || node.type === "folder") continue;
          const safe = normalizeUrl(node.url);
          if (!safe) {
            delete restoredData.nodes[id];
            for (const g of restoredData.groups || []) {
              if (Array.isArray(g.nodes)) g.nodes = g.nodes.filter((nid) => nid !== id);
            }
          } else {
            node.url = safe;
          }
        }
      }
      data = restoredData;
      skipAutoBackupOnce = true;
      queuePersist();
      closeModal();
      render();
      toast("已恢复备份", "success");
    });
  });
  qsa(".backup-delete", elements.modal).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-backup]");
      if (!row) return;
      const id = row.dataset.backup;
      if (!id) return;
      data.backups = (data.backups || []).filter((b) => b.id !== id);
      queuePersist();
      openBackupModal();
      toast("已删除备份", "success");
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

function letterIconDataUrl(text, color) {
  // 复用 icons.js 的 avatarDataUrl + hashColor，避免在 app.js 重复实现字母头像逻辑
  return avatarDataUrl(text || "?", color || hashColor(text || "?"));
}

async function markIconLoadFailed(url) {
  if (!url) return;
  const cache = await loadIconCache();
  applyFailureToCache(cache, url, cache[url]);
  const siteKey = getSiteKey(url);
  if (siteKey) applyFailureToCache(cache, siteKey, cache[siteKey]);
  await saveIconCache(cache);
}

async function trySwitchToNextFavicon(url, triedCandidates) {
  if (!url) return "";
  const candidates = getFaviconCandidates(url);
  if (!candidates.length) return "";
  // 在全局并发信号量内串行尝试候选，避免一次渲染 N 个 tile 全部并发触发请求风暴
  return withIconFetchConcurrency(async () => {
    const cache = await loadIconCache();
    const siteKey = getSiteKey(url);
    for (const candidate of candidates) {
      if (triedCandidates.has(candidate)) continue;
      triedCandidates.add(candidate);
      const ok = await probeImageWithIconTimeout(candidate);
      if (!ok) continue;
      // 抓取为 dataURL 后缓存，下次打开页面可瞬显
      const dataUrl = await fetchAsDataUrl(candidate);
      if (dataUrl) {
        cache[url] = { dataUrl, ts: Date.now() };
        if (siteKey) cache[siteKey] = { dataUrl, ts: Date.now() };
        await saveIconCache(cache);
        return dataUrl;
      }
      // dataURL 化失败时退回远程 URL
      cache[url] = { url: candidate, ts: Date.now() };
      if (siteKey) cache[siteKey] = { url: candidate, ts: Date.now() };
      await saveIconCache(cache);
      return candidate;
    }
    return "";
  });
}

function probeImageWithIconTimeout(url) {
  // 复用 icons.js 的 probeImage（带 done 守卫与超时），仅注入本模块的超时常量
  return probeImage(url, 16, ICON_PROBE_TIMEOUT_MS);
}

async function fetchTitleInBackground(nodeId, url) {
  const title = await fetchTitleViaTab(url);
  if (!title) return;
  const target = data?.nodes?.[nodeId];
  if (!target?.titlePending) return;
  target.title = title;
  target.titlePending = false;
  await persistData();
  render();
}

async function fetchFaviconNow(nodeId, url) {
  const candidates = getFaviconCandidates(url);
  if (!candidates.length) return false;
  return withIconFetchConcurrency(async () => {
    const cache = await loadIconCache();
    const siteKey = getSiteKey(url);
    for (const candidate of candidates) {
      const dataUrl = await fetchAsDataUrl(candidate);
      if (!dataUrl) continue;
      // 只写图标缓存，不改 node、不 persist——避免「取消」后仍落盘
      cache[url] = { dataUrl, ts: Date.now() };
      if (siteKey) cache[siteKey] = { dataUrl, ts: Date.now() };
      await saveIconCache(cache);
      const target = data?.nodes?.[nodeId];
      // 仅当抓取的就是当前已保存 URL 时，清 pending 标记（仍不 persist，由调用方决定）
      if (target && target.url === url) {
        target.iconPending = false;
      }
      return true;
    }
    applyFailureToCache(cache, url, cache[url]);
    if (siteKey) applyFailureToCache(cache, siteKey, cache[siteKey]);
    await saveIconCache(cache);
    return false;
  });
}

function processPendingIconFetches() {
  if (!data?.settings?.iconFetch || !data?.nodes) return;
  for (const node of Object.values(data.nodes)) {
    if (node?.type === "item" && node.iconPending && node.url) {
      fetchFaviconInBackground(node.id, node.url);
    }
  }
}

async function fetchFaviconInBackground(nodeId, url) {
  if (!data?.settings?.iconFetch) return;
  const candidates = getFaviconCandidates(url);
  if (!candidates.length) return;
  // 在全局并发信号量内串行尝试候选，避免多节点并发抓取触发请求风暴
  await withIconFetchConcurrency(async () => {
    const cache = await loadIconCache();
    const siteKey = getSiteKey(url);
    for (const candidate of candidates) {
      const ok = await probeImageWithIconTimeout(candidate);
      if (!ok) continue;
      // 抓取为 dataURL 后缓存，下次打开页面可瞬显
      const dataUrl = await fetchAsDataUrl(candidate);
      if (dataUrl) {
        cache[url] = { dataUrl, ts: Date.now() };
        if (siteKey) cache[siteKey] = { dataUrl, ts: Date.now() };
        await saveIconCache(cache);
        const target = data?.nodes?.[nodeId];
        if (target) target.iconPending = false;
        await persistData();
        render();
        return;
      }
      // dataURL 化失败时退回远程 URL
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
      // 全部候选失败：按失败次数退避（首次 15min，递增封顶 7 天）
      applyFailureToCache(cache, url, cache[url]);
      if (siteKey) applyFailureToCache(cache, siteKey, cache[siteKey]);
      await saveIconCache(cache);
      await persistData();
      render();
    }
  });
}

const _migratingIcons = new Set();
/**
 * 旧缓存只有远程 URL（{ url }），后台异步抓取为 dataURL 并更新缓存。
 * 成功后直接更新 img.src，避免全量 render 闪烁；下次打开页面瞬显。
 */
async function migrateIconCacheToDataUrl(node, img) {
  if (!node?.url || node.iconType !== "auto" || _migratingIcons.has(node.url)) return;
  _migratingIcons.add(node.url);
  try {
    const cache = await loadIconCache();
    const siteKey = getSiteKey(node.url);
    const entry = (siteKey && cache[siteKey]) || cache[node.url];
    if (!entry || entry.dataUrl || !entry.url) return;
    const dataUrl = await fetchAsDataUrl(entry.url);
    if (!dataUrl) return;
    cache[node.url] = { dataUrl, ts: Date.now() };
    if (siteKey) cache[siteKey] = { dataUrl, ts: Date.now() };
    await saveIconCache(cache);
    if (img?.isConnected) img.src = dataUrl;
  } finally {
    _migratingIcons.delete(node.url);
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
      try {
        api.tabs.onUpdated.addListener(onUpdated);
      } catch (_e) {
        finish("");
      }
    });
  });
}

async function loadRecentHistory() {
  const api = getChromeApi();
  const browserItems = [];
  let browserOk = false;

  if (!api?.history?.search) {
    historyApiStatus = "missing";
    debugLog("history_api_missing", {
      hasChrome: typeof chrome !== "undefined",
      hasBrowser: typeof browser !== "undefined",
      keys: api ? Object.keys(api).slice(0, 30) : [],
    });
  } else {
    const startTime = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    try {
      const items = await new Promise((resolve) => {
        let done = false;
        const settle = (res) => {
          if (!done) {
            done = true;
            resolve(res || []);
          }
        };
        try {
          const result = api.history.search({ text: "", startTime, maxResults: RECENT_LIMIT }, (res) => {
            const err = api.runtime?.lastError;
            if (err) {
              historyApiStatus = "error";
              console.warn("loadRecentHistory lastError:", err.message || err);
              return settle([]);
            }
            settle(res || []);
          });
          if (result && typeof result.then === "function") {
            result.then(settle).catch((e) => {
              historyApiStatus = "error";
              console.warn("loadRecentHistory rejected", e);
              settle([]);
            });
          }
        } catch (e) {
          historyApiStatus = "error";
          console.warn("loadRecentHistory threw", e);
          settle([]);
        }
      });
      const seen = new Set();
      for (const item of items || []) {
        if (!item?.url) continue;
        let norm = item.url;
        try {
          norm = new URL(item.url).href;
        } catch (e) {
          console.warn("loadRecentHistory: invalid URL", item.url, e);
        }
        if (seen.has(norm)) continue;
        seen.add(norm);
        browserItems.push({
          id: `recent_${browserItems.length}`,
          type: "history",
          title: item.title || item.url,
          url: item.url,
          ts: Number(item.lastVisitTime) || 0,
        });
      }
      if (historyApiStatus !== "error") {
        historyApiStatus = "ok";
        browserOk = true;
      }
    } catch (_err) {
      historyApiStatus = "error";
    }
  }

  // Safari 等无 history API：用扩展自建的最近访问回退
  let visitItems = [];
  try {
    visitItems = await getVisitHistoryItems(RECENT_LIMIT);
  } catch (e) {
    console.warn("getVisitHistoryItems failed", e);
  }

  const merged = [];
  const seenUrl = new Set();
  const pushUnique = (entry) => {
    if (!entry?.url) return;
    let key = entry.url;
    try {
      key = new URL(entry.url).href;
    } catch (_e) {
      // keep raw
    }
    if (seenUrl.has(key)) return;
    seenUrl.add(key);
    merged.push(entry);
  };

  for (const e of browserItems) pushUnique(e);
  for (const e of visitItems) pushUnique(e);

  merged.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const finalItems = merged.slice(0, RECENT_LIMIT).map((e, idx) => ({
    id: `recent_${idx}`,
    type: "history",
    title: e.title || e.url,
    url: e.url,
  }));

  if (finalItems.length > 0) {
    historyApiStatus = browserOk ? "ok" : "fallback";
  } else if (historyApiStatus === "missing") {
    // 自建回退管道可用，空列表用 empty 文案而非 unavailable
    historyApiStatus = "fallback";
  }

  debugLog("history_loaded", {
    browser: browserItems.length,
    visits: visitItems.length,
    final: finalItems.length,
    status: historyApiStatus,
  });
  return finalItems;
}

async function _addHistoryToShortcuts(node) {
  if (!node?.url) return;
  const targetGroupId = getPreferredGroupIdForNewItem();
  if (!targetGroupId) {
    toast(t("group.noneAvailable"), "warning");
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
    toast(t("group.noneAvailable"), "warning");
    return;
  }
  const options = rawHtml(
    [...data.groups]
      .sort((a, b) => a.order - b.order)
      .map((g) => html`<option value="${g.id}">${g.name}</option>`)
      .join(""),
  );
  const modalHtml = html`
    <h2>${t("context.addToShortcuts")}</h2>
    <div class="section">
      <label>${t("common.selectGroup")}</label>
      <select id="addHistoryGroup">${options}</select>
    </div>
    <div class="actions">
      <button id="btnAddHistoryCancel" class="icon-btn">${t("common.cancel")}</button>
      <button id="btnAddHistorySave" class="icon-btn">${t("common.save")}</button>
    </div>
  `;
  openModal(modalHtml);
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
  const safeUrl = normalizeUrl(node.url);
  if (!safeUrl) {
    toast(t("error.invalidUrlSimple"), "error");
    return;
  }
  const targetGroup = data.groups.find((g) => g.id === groupId);
  if (!targetGroup) {
    toast(t("group.notFound"), "error");
    return;
  }
  pushBackup();
  let title = node.title || "";
  if (!title) {
    try {
      title = new URL(safeUrl).hostname;
    } catch (_e) {
      title = "";
    }
  }
  const item = createItemNode({ url: safeUrl, title, iconType: "auto", iconPending: true });
  data.nodes[item.id] = item;
  targetGroup.nodes.push(item.id);
  await persistData();
  render();
  processPendingIconFetches();
  toast(t("toast.addedToShortcuts"));
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
  initSyncEngine({
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    saveLocal: async (next) => saveData(next, false),
    createSafetySnapshot: async () => {
      try {
        pushBackup();
      } catch (e) {
        console.warn("sync safety pushBackup failed", e);
      }
    },
    onMerged: async (_next, stats) => {
      if (stats?.applied) {
        toast(t("toast.syncOverwritten"), "warning");
        render();
        processPendingIconFetches();
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
  attachStorageListener();
  // loadData 和 loadRecentHistory 并行，减少首屏等待
  const recentPromise = loadRecentHistory();
  const localData = await loadData();
  debugLog("init_local", {
    groups: localData.groups?.length || 0,
    nodes: Object.keys(localData.nodes || {}).length,
    lastUpdated: localData.lastUpdated || 0,
    syncEnabled: !!localData.settings?.syncEnabled,
  });
  if (localData.settings.syncEnabled) {
    // 空 sync 返回 null，不能当成“更新的空主页”；完整 merge 由下方 pullNow 处理
    const syncData = await loadDataFromArea(true);
    // 旧整包兼容：仅作 lastUpdated 粗选，随后 engine.pull 会 merge 投影
    if (syncData?.groups?.length) {
      const localTs = Number(localData.lastUpdated || 0);
      const syncTs = Number(syncData.lastUpdated || 0);
      data = syncTs >= localTs ? syncData : localData;
    } else {
      data = localData;
    }
  } else {
    data = localData;
  }
  const deduped = dedupeData(data);
  const languageInitialized = ensureLanguageSetting();
  if (deduped || languageInitialized) {
    await saveData(data, false);
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
  recentItems = await recentPromise;
  applyDensity();
  applyTheme();
  applySidebarState();
  closeModal();
  closeFolder();
  // 先渲染 UI，图标走缓存瞬显；背景和图标重试后台异步进行，不阻塞首屏
  render();
  processPendingIconFetches();
  loadBackground();
  retryFailedIconsIfDue(data.settings);
  await consumeSaveToast();
  if (data.settings.syncEnabled) {
    try {
      const pull = await pullNow("init");
      if (pull?.needPush) await pushNow("init_need_push");
      await flushOutbox();
      render();
    } catch (e) {
      console.warn("init sync failed", e);
    }
  }
}

function render() {
  applyStaticI18n();
  applySidebarState();
  renderGroups();
  renderGrid();
  // 网格渲染后统一刷新空态（含历史分组的不可用/无数据提示）
  updateEmptyState();
  elements.topSearchWrap.classList.toggle("hidden", !data.settings.showSearch);
  elements.emptyHintToggle.checked = data.settings.emptyHintDisabled;
  elements.btnSelectAll.classList.toggle("hidden", !selectionMode);
  elements.btnBatchDelete.textContent = selectionMode ? t("context.delete") : t("toolbar.batchDelete");
  updateOpenModeButton();
}

function updateOpenModeButton() {
  const map = {
    current: t("openMode.current"),
    new: t("openMode.new"),
    background: t("openMode.background"),
  };
  const label = map[data.settings.openMode] || t("openMode.current");
  elements.btnOpenMode.textContent = `${label}`;
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
    applySidebarState();
    queuePersist();
  });
  elements.recentTab.addEventListener("click", async () => {
    activeGroupId = RECENT_GROUP_ID;
    openFolderId = null;
    data.settings.lastActiveGroupId = activeGroupId;
    queuePersist();
    recentItems = await loadRecentHistory();
    render();
  });
  elements.btnAddGroup.addEventListener("click", () => {
    const groupId = `grp_${Date.now()}`;
    data.groups.push({ id: groupId, name: t("group.new"), order: data.groups.length, nodes: [] });
    activeGroupId = groupId;
    data.settings.lastActiveGroupId = activeGroupId;
    queuePersist();
    render();
  });

  elements.btnBatchDelete.addEventListener("click", () => {
    if (activeGroupId === RECENT_GROUP_ID) {
      toast(t("history.batchDeleteDisabled"), "warning");
      return;
    }
    if (!selectionMode) {
      selectionMode = true;
      toast(t("selection.modeEnabled"));
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
      toast(t("history.batchDeleteDisabled"), "warning");
      return;
    }
    if (!selectionMode) {
      selectionMode = true;
      toast(t("selection.modeEnabled"));
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
    qsa(".tile", grid).forEach((tile) => {
      selectedIds.add(tile.dataset.id);
    });
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
  elements.btnFolderDissolve.addEventListener("click", () => {
    if (!openFolderId) return;
    const folderId = openFolderId;
    closeFolder();
    dissolveFolder(folderId);
  });
  elements.folderOverlay.addEventListener("click", (e) => {
    if (e.target.closest(".tile")) return;
    if (e.target.closest(".overlay-header")) return;
    closeFolder();
  });

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
  document.addEventListener("mousemove", rafThrottle(handleBoxSelectMove));
  document.addEventListener("mouseup", handleBoxSelectEnd);

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
    // 方向键在网格卡片间移动焦点
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      if (modalOpen) return;
      const grid = openFolderId ? elements.folderGrid : elements.grid;
      const tiles = qsa(".tile", grid);
      if (!tiles.length) return;
      const active = document.activeElement;
      let idx = tiles.indexOf(active);
      if (idx < 0) idx = 0;
      else {
        const cols = Math.max(
          1,
          Number.parseInt(getComputedStyle(grid).gridTemplateColumns.split(" ").length, 10) || 1,
        );
        if (e.key === "ArrowLeft") idx = Math.max(0, idx - 1);
        else if (e.key === "ArrowRight") idx = Math.min(tiles.length - 1, idx + 1);
        else if (e.key === "ArrowUp") idx = Math.max(0, idx - cols);
        else if (e.key === "ArrowDown") idx = Math.min(tiles.length - 1, idx + cols);
      }
      tiles[idx]?.focus?.();
      e.preventDefault();
    }
  });

  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (!touchDragState.active && touchMenuState.timer) {
        touchMenuState.x = touch.clientX;
        touchMenuState.y = touch.clientY;
        const moved = Math.hypot(touch.clientX - touchMenuState.startX, touch.clientY - touchMenuState.startY);
        if (moved > TOUCH_DRAG_MOVE_THRESHOLD) {
          resetTouchMenuState();
          clearTouchDragTimer();
        }
      }
      if (touchMenuState.active && !touchDragState.active) {
        e.preventDefault();
        return;
      }
      if (!touchDragState.active && touchDragState.timer) {
        const moved = Math.hypot(touch.clientX - touchDragState.startX, touch.clientY - touchDragState.startY);
        if (moved > TOUCH_DRAG_MOVE_THRESHOLD) {
          clearTouchDragTimer();
          resetTouchMenuState();
        }
        return;
      }
      if (!touchDragState.active) return;
      e.preventDefault();
      updateTouchDragTarget(touch.clientX, touch.clientY);
    },
    { passive: false },
  );

  document.addEventListener(
    "touchend",
    (e) => {
      if (touchMenuState.timer && !touchMenuState.active) {
        resetTouchMenuState();
      }
      if (touchMenuState.active && !touchDragState.active) {
        e.preventDefault();
        suppressTouchClickUntil = Date.now() + TOUCH_CLICK_SUPPRESS_MS;
        resetTouchMenuState();
        clearTouchDragTimer();
        return;
      }
      if (touchDragState.timer && !touchDragState.active) {
        clearTouchDragTimer();
        return;
      }
      if (!touchDragState.active) return;
      const touch = e.changedTouches?.[0];
      if (touch) {
        updateTouchDragTarget(touch.clientX, touch.clientY);
      }
      e.preventDefault();
      finishTouchDrag();
    },
    { passive: false },
  );

  document.addEventListener(
    "touchcancel",
    () => {
      resetTouchDragState();
    },
    { passive: true },
  );

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
    queuePersist();
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
    queuePersist();
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
    qsa(".group-tab", elements.groupTabs).forEach((el) => {
      el.classList.remove("drop-target");
    });
  });
}

(async () => {
  try {
    await init();
    bindEvents();
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
