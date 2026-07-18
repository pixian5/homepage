/**
 * 共享工具模块
 * 被 storage.js、popup.js、app.js 等共享，避免重复实现。
 */

/** @type {Set<string>} */
export const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "ftp:"]);

/**
 * 语言标签归一化
 * @param {string} input
 * @returns {string}
 */
export function normalizeLanguage(input) {
  if (!input) return "";
  const raw = String(input).trim().replace(/_/g, "-").toLowerCase();
  if (!raw) return "";
  if (raw === "zh" || raw.startsWith("zh-hans") || raw.startsWith("zh-cn") || raw.startsWith("zh-sg")) return "zh-CN";
  if (raw.startsWith("zh-hant") || raw.startsWith("zh-tw") || raw.startsWith("zh-hk") || raw.startsWith("zh-mo"))
    return "zh-TW";
  if (raw.startsWith("ja")) return "ja";
  if (raw.startsWith("ko")) return "ko";
  if (raw.startsWith("de")) return "de";
  if (raw.startsWith("fr")) return "fr";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("en")) return "en";
  return "";
}

/**
 * 检测系统语言
 * @returns {string}
 */
export function detectSystemLanguage() {
  try {
    const locale = Intl?.DateTimeFormat?.().resolvedOptions?.().locale || "";
    return normalizeLanguage(locale);
  } catch (_e) {
    return "";
  }
}

/**
 * 检测浏览器语言
 * @param {string[]} supportedLanguages
 * @returns {string}
 */
export function detectBrowserLanguage(supportedLanguages) {
  const api = getChromeApi();
  const candidates = [
    api?.i18n?.getUILanguage?.(),
    navigator?.language,
    ...(Array.isArray(navigator?.languages) ? navigator.languages : []),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeLanguage(candidate);
    if (supportedLanguages.includes(normalized)) return normalized;
  }
  return "";
}

/**
 * 获取首选语言
 * @param {string[]} [supportedLanguages]
 * @returns {string}
 */
export function detectPreferredLanguage(supportedLanguages = ["zh-CN", "zh-TW", "en"]) {
  const systemLanguage = detectSystemLanguage();
  if (supportedLanguages.includes(systemLanguage)) return systemLanguage;
  const browserLanguage = detectBrowserLanguage(supportedLanguages);
  if (supportedLanguages.includes(browserLanguage)) return browserLanguage;
  return "zh-CN";
}

/**
 * 获取浏览器 API（兼容 Chrome / Firefox / Safari）
 * @returns {typeof chrome | null}
 */
export function getChromeApi() {
  if (typeof chrome !== "undefined") return chrome;
  if (typeof browser !== "undefined") return browser;
  return null;
}

/**
 * 获取存储区域
 * @param {boolean} useSync
 * @returns {chrome.storage.StorageArea | null}
 */
export function storageArea(useSync) {
  const api = getChromeApi();
  if (!api?.storage) return null;
  return useSync ? api.storage.sync : api.storage.local;
}

/**
 * 获取最后一个 runtime 错误
 * @returns {chrome.runtime.LastError | null}
 */
export function getLastError() {
  const api = getChromeApi();
  return api?.runtime?.lastError || null;
}

/**
 * 估算 JSON 序列化后的字节大小
 * @param {any} value
 * @returns {number}
 */
export function estimateBytes(value) {
  const str = JSON.stringify(value);
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str).length;
  }
  return str.length;
}

/**
 * 清理数据以适应同步存储配额
 * @param {any} data
 * @param {number} iconDataMaxLength
 * @returns {any}
 */
export function sanitizeForSync(data, iconDataMaxLength) {
  const clone = typeof structuredClone === "function" ? structuredClone(data) : JSON.parse(JSON.stringify(data));
  if (clone.settings) {
    if (clone.settings.backgroundType === "custom") {
      clone.settings.backgroundCustom = "";
    }
  }
  clone.backups = [];
  for (const node of Object.values(clone.nodes || {})) {
    if (node.iconType === "upload" && node.iconData && node.iconData.length > iconDataMaxLength) {
      node.iconData = "";
      node.iconType = "auto";
    }
  }
  return clone;
}

/**
 * 从存储区域读取指定 key
 * @param {chrome.storage.StorageArea} area
 * @param {string} key
 * @returns {Promise<any>}
 */
export function storageGet(area, key) {
  return new Promise((resolve) => {
    area.get(key, (res) => {
      const err = getLastError();
      if (err) return resolve(undefined);
      resolve(res[key]);
    });
  });
}

/**
 * 写入存储区域
 * @param {chrome.storage.StorageArea} area
 * @param {object} obj
 * @returns {Promise<string | null>}
 */
export function storageSet(area, obj) {
  return new Promise((resolve) => {
    area.set(obj, () => {
      const err = getLastError();
      resolve(err ? err.message : null);
    });
  });
}

/**
 * 规范化 URL，仅允许安全协议
 * @param {string} input
 * @returns {string}
 */
export function normalizeUrl(input) {
  if (!input) return "";
  try {
    const url = new URL(input);
    if (!SAFE_URL_PROTOCOLS.has(url.protocol)) return "";
    return url.href;
  } catch (_e) {
    try {
      const url = new URL(`https://${input}`);
      if (!SAFE_URL_PROTOCOLS.has(url.protocol)) return "";
      return url.href;
    } catch (_e2) {
      return "";
    }
  }
}
