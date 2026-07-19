/**
 * 存储模块 - 处理浏览器扩展存储操作
 * @module storage
 *
 * @typedef {import('./types.js').HomepageData} HomepageData
 * @typedef {import('./types.js').IconCacheEntry} IconCacheEntry
 */

import { repairHomepageData } from "./data-utils.js";
import {
  detectPreferredLanguage,
  estimateBytes,
  getChromeApi,
  getLastError,
  normalizeLanguage,
  sanitizeForSync,
  storageArea,
} from "./shared-utils.js";

// 供 app/popup 等从 storage 入口复用（避免各处直接依赖 shared-utils 路径不一致）
export { detectPreferredLanguage, getChromeApi, normalizeLanguage };

const ROOT_KEY = "homepage_data";
const ICON_CACHE_KEY = "homepage_icon_cache";
const BG_CACHE_KEY = "homepage_bg_cache";
const SYNC_ITEM_QUOTA_BYTES = 7500;
const ICON_DATA_MAX_LENGTH = 2048;
const MAX_ICON_CACHE_ENTRIES = 500;
const STORAGE_SUPPORTED_LANGUAGES = ["zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es"];
export const deepClone = (obj) =>
  typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));

function getDefaultGroupNameByLanguage(language) {
  switch (language) {
    case "zh-TW":
      return "預設";
    case "en":
      return "Default";
    case "ja":
      return "デフォルト";
    case "ko":
      return "기본";
    case "de":
      return "Standard";
    case "fr":
      return "Par defaut";
    case "es":
      return "Predeterminado";
    default:
      return "默认";
  }
}

/**
 * 默认设置配置
 * @type {Object}
 */
const DEFAULT_SETTINGS = {
  language: "",
  showSearch: true,
  enableSearchEngine: true,
  searchEngineUrl: "https://www.bing.com/search?q=",
  openMode: "current",
  fixedLayout: false,
  fixedCols: 8,
  gridDensity: "standard",
  fontSize: 13,
  tooltipEnabled: true,
  emptyHintDisabled: false,
  backgroundType: "bing",
  backgroundColor: "#0b0f14",
  backgroundGradient: "linear-gradient(120deg,#1d2a3b,#0b0f14)",
  backgroundGradientA: "#1d2a3b",
  backgroundGradientB: "#0b0f14",
  backgroundCustom: "",
  backgroundFade: true,
  backgroundOverlayStrength: 0.08,
  iconFetch: true,
  iconRetryAtSix: true,
  iconRetryHour: 18,
  syncEnabled: false,
  maxBackups: 30,
  keyboardNav: true,
  lastActiveGroupId: "",
  defaultGroupMode: "last",
  defaultGroupId: "",
  theme: "system",
  lastSaveUrl: "",
  lastSaveTs: 0,
  sidebarCollapsed: false,
  sidebarHidden: false,
};

function nowTs() {
  return Date.now();
}

function createDefaultData() {
  const language = detectPreferredLanguage(STORAGE_SUPPORTED_LANGUAGES);
  const groupId = `grp_${nowTs()}`;
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_SETTINGS, language },
    groups: [{ id: groupId, name: getDefaultGroupNameByLanguage(language), order: 0, nodes: [] }],
    nodes: {},
    backups: [],
    lastUpdated: nowTs(),
  };
}

function isQuotaError(err) {
  return typeof err === "string" && err.toLowerCase().includes("quota");
}

function trimLocalBackups(data) {
  if (Array.isArray(data.backups) && data.backups.length) {
    data.backups = [];
    return true;
  }
  return false;
}

function trimLocalUploadIcons(data) {
  let changed = false;
  for (const node of Object.values(data.nodes || {})) {
    if (node.iconType === "upload" && node.iconData) {
      node.iconData = "";
      node.iconType = "auto";
      changed = true;
    }
  }
  return changed;
}

function trimLocalBackground(data) {
  if (data.settings?.backgroundType === "custom" && data.settings.backgroundCustom) {
    data.settings.backgroundCustom = "";
    return true;
  }
  return false;
}

async function storageGetLocal(area, key) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    try {
      const result = area.get(key, (res) => {
        const err = getLastError();
        if (err) return finish(undefined);
        finish(res?.[key]);
      });
      if (result && typeof result.then === "function") {
        result.then(
          (res) => finish(res?.[key]),
          (e) => {
            console.warn("storageGet promise rejected", e);
            finish(undefined);
          },
        );
      }
    } catch (e) {
      console.warn("storageGet failed", e);
      finish(undefined);
    }
  });
}

async function storageSetLocal(area, obj) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (errMsg) => {
      if (done) return;
      done = true;
      resolve(errMsg);
    };
    try {
      const result = area.set(obj, () => {
        const err = getLastError();
        finish(err ? err.message : null);
      });
      if (result && typeof result.then === "function") {
        result.then(
          () => finish(null),
          (err) => finish(err?.message || String(err)),
        );
      }
    } catch (err) {
      finish(err?.message || String(err));
    }
  });
}

async function storageRemoveLocal(area, key) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (errMsg) => {
      if (done) return;
      done = true;
      resolve(errMsg);
    };
    try {
      const result = area.remove(key, () => {
        const err = getLastError();
        finish(err ? err.message : null);
      });
      if (result && typeof result.then === "function") {
        result.then(
          () => finish(null),
          (err) => finish(err?.message || String(err)),
        );
      }
    } catch (err) {
      finish(err?.message || String(err));
    }
  });
}

const CURRENT_SCHEMA_VERSION = 1;

/**
 * 已注册的迁移函数：键为起始版本号，值为将该版本数据升级到下一版本的函数。
 * 新增 schema 升级时，只需在这里追加一个版本号 -> 迁移函数的映射。
 * 每个迁移函数必须返回新数据对象（或原对象），并保证不抛错。
 */
const MIGRATIONS = {
  // 示例（保留以便未来追加）：
  // 1: (data) => {
  //   data.schemaVersion = 2;
  //   // ... 字段调整 ...
  //   return data;
  // },
};

/**
 * 按版本号顺序执行数据迁移。
 * - 没有 schemaVersion 的旧数据直接返回（视为最新）。
 * - 缺失的迁移步骤会被跳过，最终统一抬升到 CURRENT_SCHEMA_VERSION。
 * - 任何迁移函数抛错都会被吞掉，返回当前已迁移到的副本，避免阻塞加载。
 * @param {HomepageData | object} data
 * @returns {HomepageData | object}
 */
export function migrateData(data) {
  if (!data || typeof data !== "object") return data;
  if (!data.schemaVersion) return data;

  let current = deepClone(data);
  let version = Number(data.schemaVersion) || 0;
  const maxSteps = 32; // 防御性上限，避免错误数据导致死循环

  for (let i = 0; i < maxSteps && version < CURRENT_SCHEMA_VERSION; i++) {
    const migrator = MIGRATIONS[version];
    if (typeof migrator !== "function") {
      // 没有对应迁移函数，直接抬升版本号
      version = CURRENT_SCHEMA_VERSION;
      break;
    }
    try {
      current = migrator(current) || current;
      version = Number(current.schemaVersion) || version + 1;
    } catch (_err) {
      // 单步迁移失败：保留已有结果并停止
      version = CURRENT_SCHEMA_VERSION;
      break;
    }
  }

  current.schemaVersion = CURRENT_SCHEMA_VERSION;
  return current;
}

/**
 * 加载本地数据
 * @returns {Promise<HomepageData>}
 */
export async function loadData() {
  const base = createDefaultData();
  const api = getChromeApi();
  if (!api) return base;

  const local = storageArea(false);
  let data = await storageGetLocal(local, ROOT_KEY);
  if (!data) {
    await storageSetLocal(local, { [ROOT_KEY]: base });
    return base;
  }
  data = migrateData(data) || base;
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  data = repairHomepageData(data, DEFAULT_SETTINGS);
  return data;
}

/**
 * 从指定存储区域加载数据。
 * 注意：key 缺失时返回 null（不再伪造带 now 时间戳的默认数据），
 * 避免 LWW 把空 sync 当成“更新的空主页”覆盖本地真数据。
 * @param {boolean} useSync
 * @returns {Promise<HomepageData | null>}
 */
export async function loadDataFromArea(useSync = false) {
  const api = getChromeApi();
  if (!api) return null;
  const area = storageArea(useSync);
  let data = await storageGetLocal(area, ROOT_KEY);
  if (!data) return null;
  data = migrateData(data);
  if (!data || typeof data !== "object") return null;
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  data = repairHomepageData(data, DEFAULT_SETTINGS);
  return data;
}

/**
 * 保存数据
 * @param {HomepageData} data
 * @param {boolean} useSync
 * @returns {Promise<string | null>}
 */
export async function saveData(data, useSync = false) {
  const api = getChromeApi();
  if (!api) return "no_api";
  const area = storageArea(useSync);
  const prevLastUpdated = data.lastUpdated;
  data.lastUpdated = nowTs();
  const payload = useSync ? sanitizeForSync(data, ICON_DATA_MAX_LENGTH) : data;
  if (useSync) {
    const size = estimateBytes(payload);
    if (size > SYNC_ITEM_QUOTA_BYTES) {
      data.settings.syncEnabled = false;
      data.lastUpdated = nowTs();
      const localErr = await storageSetLocal(storageArea(false), { [ROOT_KEY]: data });
      if (localErr) data.lastUpdated = prevLastUpdated;
      return "sync_quota_exceeded";
    }
  }
  let err = await storageSetLocal(area, { [ROOT_KEY]: payload });
  if (!useSync && err && isQuotaError(err)) {
    if (trimLocalBackups(data)) {
      err = await storageSetLocal(area, { [ROOT_KEY]: data });
      if (!err) return "local_trimmed_backups";
    }
    if (trimLocalUploadIcons(data)) {
      err = await storageSetLocal(area, { [ROOT_KEY]: data });
      if (!err) return "local_trimmed_icons";
    }
    if (trimLocalBackground(data)) {
      err = await storageSetLocal(area, { [ROOT_KEY]: data });
      if (!err) return "local_trimmed_background";
    }
  }
  if (err && useSync) {
    // 远端同步写入失败：回退本地存储并把同步开关关闭，返回 sentinel 让 UI 给出准确提示。
    data.settings.syncEnabled = false;
    data.lastUpdated = nowTs();
    const localErr = await storageSetLocal(storageArea(false), { [ROOT_KEY]: data });
    if (localErr) data.lastUpdated = prevLastUpdated;
    return "sync_write_failed";
  }
  if (err) {
    // 写盘失败：回滚 lastUpdated，避免 LWW 把“内存新、磁盘旧”当成权威
    data.lastUpdated = prevLastUpdated;
  }
  return err;
}

export async function clearData(useSync = false) {
  const api = getChromeApi();
  if (!api) return;
  const area = storageArea(useSync);
  await storageRemoveLocal(area, ROOT_KEY);
}

let _iconCacheMemory = null;

/**
 * 规范化图标缓存条目，兼容旧版字符串格式。
 * 保留磁盘上的 ts（上次访问/失败时间），不要在此覆写成 now，
 * 否则跨会话 LRU 信息在加载瞬间全部丢失。
 * @param {IconCacheEntry | string} entry
 * @returns {IconCacheEntry}
 */
function normalizeIconCacheEntry(entry) {
  const now = Date.now();
  if (typeof entry === "string") {
    // 旧字符串格式没有 ts，只能用 now 兜底
    return { dataUrl: entry, ts: now };
  }
  if (entry && typeof entry === "object") {
    return {
      dataUrl: entry.dataUrl || "",
      url: entry.url || "",
      ts: entry.ts || now,
      hits: entry.hits || 0,
      failed: entry.failed ? true : undefined,
      // 保留失败退避次数，否则每次 save 都会把 attempts 抹成 1
      attempts: entry.attempts ? Number(entry.attempts) || undefined : undefined,
    };
  }
  return { dataUrl: "", url: "", ts: now, hits: 0 };
}

/**
 * 图标缓存 LRU 淘汰
 * @param {Record<string, IconCacheEntry | string>} cache
 * @param {number} maxEntries
 * @returns {Record<string, IconCacheEntry>}
 */
export function evictIconCacheLRU(cache, maxEntries = MAX_ICON_CACHE_ENTRIES) {
  const entries = Object.entries(cache).map(([key, value]) => [key, normalizeIconCacheEntry(value)]);
  if (entries.length <= maxEntries) {
    return Object.fromEntries(entries);
  }
  entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
  const kept = entries.slice(entries.length - maxEntries);
  return Object.fromEntries(kept);
}

/**
 * 加载图标缓存，并迁移旧格式。
 * 不再在加载时把所有 ts 刷成 now：保留磁盘上的真实访问/失败时间，
 * 让 evictIconCacheLRU 跨会话仍能按真实热度淘汰（以前一加载全部 ts 相同，
 * 首次保存只能按插入顺序任意淘汰，等于丢失了 LRU 语义）。
 * @returns {Promise<Record<string, IconCacheEntry>>}
 */
export async function loadIconCache() {
  if (_iconCacheMemory) return _iconCacheMemory;
  const api = getChromeApi();
  if (!api) return {};
  const local = storageArea(false);
  const raw = (await storageGetLocal(local, ICON_CACHE_KEY)) || {};
  const normalized = {};
  for (const [key, value] of Object.entries(raw)) {
    normalized[key] = normalizeIconCacheEntry(value);
  }
  _iconCacheMemory = normalized;
  return _iconCacheMemory;
}

/**
 * 图标缓存刷盘：把并发的多次 saveIconCache 合并成尽量少的 storageSet。
 * 多个 resolveIcon 在一次渲染批次里并发调用 saveIconCache 时，共享同一个
 * _iconCacheMemory，这里只在「上一次写盘未结束时」排队再刷一次最新值，
 * 避免每个 tile 各写一次盘。await 语义保留：调用方 await 后能保证其值已落盘
 * （若期间有更新的并发写入，则以最新值为准）。
 */
let _iconCacheSaveInFlight = false;
let _iconCacheSaveQueued = false;
let _iconCacheSavePromise = null;
let _iconCacheSaveResolve = null;

async function flushIconCacheOnce() {
  try {
    while (true) {
      const api = getChromeApi();
      if (!api) break;
      const local = storageArea(false);
      await storageSetLocal(local, { [ICON_CACHE_KEY]: _iconCacheMemory });
      if (!_iconCacheSaveQueued) break;
      _iconCacheSaveQueued = false;
    }
  } finally {
    const resolve = _iconCacheSaveResolve;
    _iconCacheSaveInFlight = false;
    _iconCacheSaveQueued = false;
    _iconCacheSavePromise = null;
    _iconCacheSaveResolve = null;
    if (resolve) resolve();
  }
}

function scheduleIconCacheFlush() {
  if (_iconCacheSaveInFlight) {
    _iconCacheSaveQueued = true;
    return _iconCacheSavePromise;
  }
  _iconCacheSaveInFlight = true;
  _iconCacheSaveQueued = false;
  _iconCacheSavePromise = new Promise((resolve) => {
    _iconCacheSaveResolve = resolve;
  });
  void flushIconCacheOnce();
  return _iconCacheSavePromise;
}

/**
 * 保存图标缓存，写入前执行 LRU 淘汰；并发调用会合并写盘。
 * @param {Record<string, IconCacheEntry | string>} cache
 * @returns {Promise<void>}
 */
export async function saveIconCache(cache) {
  const trimmed = evictIconCacheLRU(cache || {}, MAX_ICON_CACHE_ENTRIES);
  _iconCacheMemory = trimmed;
  await scheduleIconCacheFlush();
}

export async function loadBgCache() {
  const api = getChromeApi();
  if (!api) return {};
  const local = storageArea(false);
  return (await storageGetLocal(local, BG_CACHE_KEY)) || {};
}

export async function saveBgCache(cache) {
  const api = getChromeApi();
  if (!api) return;
  const local = storageArea(false);
  await storageSetLocal(local, { [BG_CACHE_KEY]: cache });
}

/**
 * 创建备份快照
 * @param {HomepageData | object} data - 要备份的数据
 * @returns {object} - 备份快照对象
 */
export function createBackupSnapshot(data) {
  const snapshotData = deepClone(data || {});
  // 备份快照不携带历史备份，避免递归膨胀导致存储清空
  snapshotData.backups = [];
  return {
    id: `bak_${nowTs()}`,
    ts: nowTs(),
    data: snapshotData,
  };
}

/**
 * 获取默认设置
 * @returns {import('./types.js').Settings}
 */
export function defaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

/**
 * 获取默认数据结构
 * @returns {HomepageData}
 */
export function defaultData() {
  return createDefaultData();
}

/**
 * 获取存储键名
 * @returns {string}
 */
export function getStorageKey() {
  return ROOT_KEY;
}
