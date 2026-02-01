const ROOT_KEY = "homepage_data";
const ICON_CACHE_KEY = "homepage_icon_cache";
const BG_CACHE_KEY = "homepage_bg_cache";

const DEFAULT_SETTINGS = {
  showSearch: true,
  enableSearchEngine: false,
  searchEngineUrl: "https://www.bing.com/search?q=",
  openMode: "current",
  fixedLayout: false,
  fixedRows: 3,
  fixedCols: 8,
  gridDensity: "standard",
  tooltipEnabled: true,
  emptyHintDisabled: false,
  backgroundType: "bing",
  backgroundColor: "#0b0f14",
  backgroundGradient: "linear-gradient(120deg,#1d2a3b,#0b0f14)",
  backgroundCustom: "",
  backgroundFade: true,
  iconFetch: true,
  iconRetryAtSix: true,
  trashEnabled: false,
  syncEnabled: false,
  maxBackups: 30,
  keyboardNav: true,
  lastActiveGroupId: "",
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

async function storageGet(area, key) {
  return new Promise((resolve) => {
    area.get(key, (res) => resolve(res[key]));
  });
}

async function storageSet(area, obj) {
  return new Promise((resolve) => {
    area.set(obj, () => resolve());
  });
}

async function storageRemove(area, key) {
  return new Promise((resolve) => {
    area.remove(key, () => resolve());
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
  await storageSet(area, { [ROOT_KEY]: data });
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
