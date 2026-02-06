/**
 * 共享工具函数模块
 * 用于 popup.js 和其他模块之间共享的通用函数
 */

const ROOT_KEY = "homepage_data";
const SYNC_ITEM_QUOTA_BYTES = 7500;
const ICON_DATA_MAX_LENGTH = 2048;
const MAX_LOG_ENTRIES = 30;

/**
 * 获取浏览器扩展 API
 * @returns {typeof chrome | typeof browser | null}
 */
export function getChrome() {
  if (typeof chrome !== "undefined") return chrome;
  if (typeof browser !== "undefined") return browser;
  return null;
}

/**
 * 获取最后一个运行时错误
 * @returns {chrome.runtime.LastError | null}
 */
export function getLastError() {
  const api = getChrome();
  return api?.runtime?.lastError || null;
}

/**
 * 获取存储区域
 * @param {boolean} useSync - 是否使用同步存储
 * @returns {chrome.storage.StorageArea | null}
 */
export function storageArea(useSync) {
  const api = getChrome();
  if (!api || !api.storage) return null;
  return useSync ? api.storage.sync : api.storage.local;
}

/**
 * 从存储中获取数据
 * @param {string} key - 存储键
 * @param {boolean} useSync - 是否使用同步存储
 * @returns {Promise<any>}
 */
export function storageGet(key, useSync = false) {
  const area = storageArea(useSync);
  if (!area) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    area.get(key, (res) => {
      const err = getLastError();
      if (err) {
        console.warn("storageGet error", err);
        return resolve(undefined);
      }
      resolve(res[key]);
    });
  });
}

/**
 * 向存储中写入数据
 * @param {object} obj - 要存储的对象
 * @param {boolean} useSync - 是否使用同步存储
 * @returns {Promise<string | null>} - 错误消息或 null
 */
export function storageSet(obj, useSync = false) {
  const area = storageArea(useSync);
  if (!area) return Promise.resolve("storage not available");
  return new Promise((resolve) => {
    area.set(obj, () => {
      const err = getLastError();
      resolve(err ? err.message : null);
    });
  });
}

/**
 * 估算对象的字节大小
 * @param {any} value - 要估算的值
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
 * 规范化 URL
 * @param {string} input - 输入的 URL
 * @returns {string} - 规范化后的 URL 或空字符串
 */
export function normalizeUrl(input) {
  if (!input) return "";
  try {
    return new URL(input).href;
  } catch (e) {
    try {
      return new URL(`https://${input}`).href;
    } catch (e2) {
      // URL 解析失败是预期行为
      return "";
    }
  }
}

/**
 * 清理数据以适应同步存储配额
 * @param {object} data - 原始数据
 * @returns {object} - 清理后的数据副本
 */
export function sanitizeForSync(data) {
  const clone = JSON.parse(JSON.stringify(data));
  if (clone.settings) {
    if (clone.settings.backgroundType === "custom") {
      clone.settings.backgroundCustom = "";
    }
  }
  clone.backups = [];
  for (const node of Object.values(clone.nodes || {})) {
    if (node.iconType === "upload" && node.iconData && node.iconData.length > ICON_DATA_MAX_LENGTH) {
      node.iconData = "";
      node.iconType = "auto";
    }
  }
  return clone;
}

/**
 * 比较并选择最新的数据
 * @param {object | null} localData - 本地数据
 * @param {object | null} syncData - 同步数据
 * @returns {object | null}
 */
export function pickLatestData(localData, syncData) {
  if (!syncData) return localData || null;
  if (!localData) return syncData || null;
  const localTs = Number(localData.lastUpdated || 0);
  const syncTs = Number(syncData.lastUpdated || 0);
  return syncTs >= localTs ? syncData : localData;
}

// 导出常量
export { ROOT_KEY, SYNC_ITEM_QUOTA_BYTES, ICON_DATA_MAX_LENGTH, MAX_LOG_ENTRIES };
