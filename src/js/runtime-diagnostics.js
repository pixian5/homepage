import { getChromeApi } from "./storage.js";

export const DEBUG_LOG_KEY = "homepage_debug_log";
export const DEBUG_PERSIST_KEY = "homepage_debug_persist";
export const DEFAULT_MAX_DEBUG_LOG_ENTRIES = 200;

/**
 * 创建运行时诊断与调试管理器
 * @param {Object} [options]
 * @param {Storage} [options.storage] 存储后端（默认全局 localStorage）
 * @param {Function} [options.getApi] 获取 Chrome/WebExtension API（默认 getChromeApi）
 * @param {Object} [options.location] 位置信息对象（默认全局 window?.location）
 * @param {number} [options.maxEntries] 最大日志条数（默认 200）
 * @param {Console} [options.logger] 日志输出对象（默认 console）
 */
export function createRuntimeDiagnostics(options = {}) {
  const getStorage = () => {
    if (options.storage) return options.storage;
    if (typeof localStorage !== "undefined") return localStorage;
    return null;
  };

  const getApi = options.getApi || getChromeApi;
  const maxEntries = options.maxEntries || DEFAULT_MAX_DEBUG_LOG_ENTRIES;
  const logger = options.logger || console;

  function shouldDebugPersist() {
    try {
      const storage = getStorage();
      return storage?.getItem(DEBUG_PERSIST_KEY) === "1";
    } catch (e) {
      logger.warn("shouldDebugPersist failed", e);
      return false;
    }
  }

  function debugLog(event, payload = {}) {
    const entry = { ts: Date.now(), event, payload };
    try {
      const storage = getStorage();
      if (storage) {
        const raw = storage.getItem(DEBUG_LOG_KEY);
        const list = raw ? JSON.parse(raw) : [];
        list.unshift(entry);
        storage.setItem(DEBUG_LOG_KEY, JSON.stringify(list.slice(0, maxEntries)));
      }
    } catch (_err) {
      // 存储满或被禁用为预期边缘，不打断业务
    }
    if (shouldDebugPersist()) {
      logger.log("[debug]", entry);
    }
    return entry;
  }

  function getRuntimeInfo() {
    const api = getApi();
    const loc = options.location || (typeof window !== "undefined" ? window.location : null);
    return {
      runtimeId: api?.runtime?.id || "",
      href: loc?.href || "",
      origin: loc?.origin || "",
    };
  }

  function getAppVersion() {
    const api = getApi();
    try {
      const version = api?.runtime?.getManifest?.()?.version;
      return version ? String(version) : "";
    } catch (e) {
      logger.warn("getAppVersion failed", e);
      return "";
    }
  }

  function getDebugLogs() {
    try {
      const storage = getStorage();
      const raw = storage?.getItem(DEBUG_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_e) {
      return [];
    }
  }

  function clearDebugLogs() {
    try {
      const storage = getStorage();
      storage?.removeItem(DEBUG_LOG_KEY);
      return true;
    } catch (_e) {
      return false;
    }
  }

  return {
    debugLog,
    getRuntimeInfo,
    getAppVersion,
    shouldDebugPersist,
    getDebugLogs,
    clearDebugLogs,
  };
}
