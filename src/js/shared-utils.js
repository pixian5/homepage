/**
 * 共享工具模块
 * 被 storage.js、popup.js、app.js 等共享，避免重复实现。
 */

/** @type {Set<string>} */
export const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "ftp:"]);

export const RECENT_GROUP_ID = "__recent__";

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
 * localStorage 支撑的 chrome.storage 兼容层（纯 Web / PWA 模式回退）。
 * 实现 chrome.storage.StorageArea 语义（get 支持 string/array/object/null），
 * 同时兼容回调与 Promise 两种调用形态（与 Firefox hybrid 一致），值经 JSON 序列化。
 */
function createLocalStorageArea() {
  const readKey = (key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch (_e) {
      return undefined;
    }
  };
  const writeKey = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("localStorage set failed:", e?.message || e);
    }
  };
  const area = {
    get(keys, callback) {
      let result = {};
      if (keys === null || keys === undefined) {
        // 全量读取（与 chrome.storage 语义一致）
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          const value = readKey(key);
          if (value !== undefined) result[key] = value;
        }
      } else if (typeof keys === "string") {
        const value = readKey(keys);
        if (value !== undefined) result[keys] = value;
      } else if (Array.isArray(keys)) {
        for (const key of keys) {
          const value = readKey(key);
          if (value !== undefined) result[key] = value;
        }
      } else if (typeof keys === "object") {
        // 对象形态：缺失键使用调用方给出的默认值
        result = { ...keys };
        for (const key of Object.keys(keys)) {
          const value = readKey(key);
          if (value !== undefined) result[key] = value;
        }
      }
      if (typeof callback === "function") {
        try {
          callback(result);
        } catch (_e) {
          // 回调异常不阻断 Promise 返回
        }
      }
      return Promise.resolve(result);
    },
    set(obj, callback) {
      for (const [key, value] of Object.entries(obj || {})) writeKey(key, value);
      if (typeof callback === "function") {
        try {
          callback();
        } catch (_e) {
          // ignore
        }
      }
      return Promise.resolve();
    },
    remove(keys, callback) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        try {
          localStorage.removeItem(key);
        } catch (_e) {
          // ignore
        }
      }
      if (typeof callback === "function") {
        try {
          callback();
        } catch (_e) {
          // ignore
        }
      }
      return Promise.resolve();
    },
    clear(callback) {
      try {
        localStorage.clear();
      } catch (_e) {
        // ignore
      }
      if (typeof callback === "function") {
        try {
          callback();
        } catch (_e) {
          // ignore
        }
      }
      return Promise.resolve();
    },
  };
  return area;
}

/** 缓存的 Web 回退存储层（同一页面内复用，保证引用稳定） */
let _webFallbackArea = null;

/**
 * 纯 Web / PWA 模式下注册离线 Service Worker（幂等）：
 * 仅在非扩展环境（无 runtime.id）且浏览器支持 serviceWorker 时注册，
 * 扩展环境自带打包资源，注册无意义。
 * @param {string} [swUrl] 相对当前页面的 SW 脚本地址，默认 "sw.js"
 * @returns {Promise<boolean>} 是否发起注册
 */
export async function registerServiceWorkerIfNeeded(swUrl = "sw.js") {
  try {
    const api = getChromeApi();
    if (api?.runtime?.id) return false; // 扩展环境
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return false;
    if (typeof window === "undefined" || !window.location) return false;
    // 仅安全上下文（https / localhost）允许注册
    if (!window.isSecureContext) return false;
    await navigator.serviceWorker.register(swUrl);
    console.info("[homepage] PWA 就绪：离线缓存已启用（Service Worker）");
    return true;
  } catch (e) {
    console.warn("[homepage] Service Worker 注册失败（离线功能不可用，应用仍可在线使用）:", e?.message || e);
    return false;
  }
}

/**
 * 当前存储模式：
 * - "extension"：扩展环境（chrome.storage 可用）；
 * - "web-local"：纯 Web / PWA 模式，回退到 window.localStorage；
 * - "memory"：两者皆不可用（极端环境），调用方自行兜底。
 * @returns {"extension"|"web-local"|"memory"}
 */
export function getStorageMode() {
  const api = getChromeApi();
  if (api?.storage?.local) return "extension";
  if (typeof localStorage !== "undefined") return "web-local";
  return "memory";
}

/**
 * 获取存储区域
 * 纯 Web / PWA 模式（无扩展 API 直接打开页面）下无缝回退到 window.localStorage，
 * 扩展环境行为完全不变。
 * @param {boolean} useSync
 * @returns {chrome.storage.StorageArea | null}
 */
export function storageArea(useSync) {
  const api = getChromeApi();
  if (api?.storage) {
    return useSync ? api.storage.sync : api.storage.local;
  }
  if (!_webFallbackArea && typeof localStorage !== "undefined") {
    _webFallbackArea = createLocalStorageArea();
  }
  return _webFallbackArea;
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
 * 从存储区域读取指定 key（空区域安全：返回 undefined）
 * @param {chrome.storage.StorageArea} area
 * @param {string} key
 * @returns {Promise<any>}
 */
export function storageGet(area, key) {
  if (!area) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    area.get(key, (res) => {
      const err = getLastError();
      if (err) return resolve(undefined);
      resolve(res[key]);
    });
  });
}

/**
 * 写入存储区域（空区域安全：返回错误串）
 * @param {chrome.storage.StorageArea} area
 * @param {object} obj
 * @returns {Promise<string | null>}
 */
export function storageSet(area, obj) {
  if (!area) return Promise.resolve("no_storage_area");
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

/**
 * 标准化 URL 并支持指定回退协议（默认 https）
 * @param {string} input
 * @param {string} [scheme="https"]
 * @returns {string}
 */
export function normalizeUrlWithScheme(input, scheme = "https") {
  if (!input) return "";
  const raw = String(input).trim();
  if (!raw) return "";
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const fallback = scheme || "https";
  const candidate = hasScheme ? raw : `${fallback}://${raw.replace(/^\/+/, "")}`;
  try {
    const url = new URL(candidate);
    if (!SAFE_URL_PROTOCOLS.has(url.protocol)) return "";
    return url.href;
  } catch (_e) {
    return "";
  }
}

/**
 * 检测当前是否为 Safari 浏览器
 * @param {string} [customUa] 可选注入 userAgent，方便测试
 * @returns {boolean}
 */
export function isSafariBrowser(customUa) {
  const ua =
    typeof customUa === "string" ? customUa : (typeof navigator !== "undefined" ? navigator.userAgent : "") || "";
  return /safari/i.test(ua) && !/chrome|crios|chromium|android/i.test(ua);
}

/**
 * 检测扩展运行平台（firefox | safari | chrome）
 * @param {string} [customUa] 可选注入 userAgent
 * @returns {"firefox" | "safari" | "chrome"}
 */
export function detectExtensionPlatform(customUa) {
  const ua =
    typeof customUa === "string" ? customUa : (typeof navigator !== "undefined" ? navigator.userAgent : "") || "";
  if (/firefox/i.test(ua)) return "firefox";
  if (isSafariBrowser(ua)) return "safari";
  return "chrome";
}

/**
 * 将 File/Blob 读取为 DataURL
 * @param {Blob|File} file
 * @returns {Promise<string>}
 */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve("");
    if (typeof FileReader === "undefined") return resolve("");
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
