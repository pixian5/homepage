const ROOT_KEY = "homepage_data";
const ICON_CACHE_KEY = "homepage_icon_cache";
const BG_CACHE_KEY = "homepage_bg_cache";
const SYNC_ITEM_QUOTA_BYTES = 7500;

const DEFAULT_SETTINGS = {
  showSearch: true,
  enableSearchEngine: false,
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
  backgroundCustom: "",
  backgroundFade: true,
  iconFetch: true,
  iconRetryAtSix: true,
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
};

function nowTs() {
  return Date.now();
}

function createDefaultData() {
  const groupId = `grp_${nowTs()}`;
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_SETTINGS },
    groups: [
      { id: groupId, name: "默认", order: 0, nodes: [] }
    ],
    nodes: {},
    backups: [],
    lastUpdated: nowTs(),
  };
}

function getChrome() {
  if (typeof chrome !== "undefined") return chrome;
  if (typeof browser !== "undefined") return browser;
  return null;
}

function storageArea(useSync) {
  const api = getChrome();
  if (!api || !api.storage) return null;
  return useSync ? api.storage.sync : api.storage.local;
}

function getLastError() {
  const api = getChrome();
  return api?.runtime?.lastError || null;
}

function estimateBytes(value) {
  const str = JSON.stringify(value);
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str).length;
  }
  return str.length;
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

async function storageGet(area, key) {
  return new Promise((resolve) => {
    area.get(key, (res) => {
      const err = getLastError();
      if (err) return resolve(undefined);
      resolve(res[key]);
    });
  });
}

async function storageSet(area, obj) {
  return new Promise((resolve) => {
    area.set(obj, () => {
      const err = getLastError();
      resolve(err ? err.message : null);
    });
  });
}

async function storageRemove(area, key) {
  return new Promise((resolve) => {
    area.remove(key, () => {
      const err = getLastError();
      resolve(err ? err.message : null);
    });
  });
}

function migrateData(data) {
  if (!data || !data.schemaVersion) return data;
  // placeholder for future migrations
  return data;
}

export async function loadData() {
  const base = createDefaultData();
  const api = getChrome();
  if (!api) return base;

  const local = storageArea(false);
  let data = await storageGet(local, ROOT_KEY);
  if (!data) {
    await storageSet(local, { [ROOT_KEY]: base });
    return base;
  }
  data = migrateData(data) || base;
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  return data;
}

export async function loadDataFromArea(useSync = false) {
  const base = createDefaultData();
  const api = getChrome();
  if (!api) return base;
  const area = storageArea(useSync);
  let data = await storageGet(area, ROOT_KEY);
  if (!data) return base;
  data = migrateData(data) || base;
  data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  return data;
}

export async function saveData(data, useSync = false) {
  const api = getChrome();
  if (!api) return;
  const area = storageArea(useSync);
  data.lastUpdated = nowTs();
  const payload = useSync ? sanitizeForSync(data) : data;
  if (useSync) {
    const size = estimateBytes(payload);
    if (size > SYNC_ITEM_QUOTA_BYTES) {
      data.settings.syncEnabled = false;
      await storageSet(storageArea(false), { [ROOT_KEY]: data });
      return "sync_quota_exceeded";
    }
  }
  let err = await storageSet(area, { [ROOT_KEY]: payload });
  if (!useSync && err && isQuotaError(err)) {
    if (trimLocalBackups(data)) {
      err = await storageSet(area, { [ROOT_KEY]: data });
      if (!err) return "local_trimmed_backups";
    }
    if (trimLocalUploadIcons(data)) {
      err = await storageSet(area, { [ROOT_KEY]: data });
      if (!err) return "local_trimmed_icons";
    }
    if (trimLocalBackground(data)) {
      err = await storageSet(area, { [ROOT_KEY]: data });
      if (!err) return "local_trimmed_background";
    }
  }
  if (err && useSync) {
    data.settings.syncEnabled = false;
    await storageSet(storageArea(false), { [ROOT_KEY]: data });
  }
  return err;
}

export async function clearData(useSync = false) {
  const api = getChrome();
  if (!api) return;
  const area = storageArea(useSync);
  await storageRemove(area, ROOT_KEY);
}

export async function loadIconCache() {
  const api = getChrome();
  if (!api) return {};
  const local = storageArea(false);
  return (await storageGet(local, ICON_CACHE_KEY)) || {};
}

export async function saveIconCache(cache) {
  const api = getChrome();
  if (!api) return;
  const local = storageArea(false);
  await storageSet(local, { [ICON_CACHE_KEY]: cache });
}

export async function loadBgCache() {
  const api = getChrome();
  if (!api) return {};
  const local = storageArea(false);
  return (await storageGet(local, BG_CACHE_KEY)) || {};
}

export async function saveBgCache(cache) {
  const api = getChrome();
  if (!api) return;
  const local = storageArea(false);
  await storageSet(local, { [BG_CACHE_KEY]: cache });
}

function sanitizeForSync(data) {
  const clone = JSON.parse(JSON.stringify(data));
  if (clone.settings) {
    if (clone.settings.backgroundType === "custom") {
      clone.settings.backgroundCustom = "";
    }
  }
  clone.backups = [];
  for (const node of Object.values(clone.nodes || {})) {
    if (node.iconType === "upload" && node.iconData && node.iconData.length > 2048) {
      node.iconData = "";
      node.iconType = "auto";
    }
  }
  return clone;
}

export function createBackupSnapshot(data) {
  return {
    id: `bak_${nowTs()}`,
    ts: nowTs(),
    data: JSON.parse(JSON.stringify(data)),
  };
}

export function defaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

export function defaultData() {
  return createDefaultData();
}

export function getStorageKey() {
  return ROOT_KEY;
}

export function getChromeApi() {
  return getChrome();
}
