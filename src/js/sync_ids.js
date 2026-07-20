/**
 * 设备 / 文档身份
 */

import { getChromeApi, getLastError, storageArea } from "./shared-utils.js";
import { DEVICE_ID_KEY } from "./sync_policy.js";

function randomId(prefix) {
  const core =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${core}`;
}

function syncIdsStorageGet(area, key) {
  return new Promise((resolve) => {
    try {
      const result = area.get(key, (res) => {
        if (getLastError()) return resolve(undefined);
        resolve(res?.[key]);
      });
      if (result && typeof result.then === "function") {
        result.then(
          (res) => resolve(res?.[key]),
          () => resolve(undefined),
        );
      }
    } catch (_e) {
      resolve(undefined);
    }
  });
}

function syncIdsStorageSet(area, obj) {
  return new Promise((resolve) => {
    try {
      const result = area.set(obj, () => resolve(getLastError() ? getLastError().message : null));
      if (result && typeof result.then === "function") {
        result.then(
          () => resolve(null),
          (e) => resolve(e?.message || String(e)),
        );
      }
    } catch (e) {
      resolve(e?.message || String(e));
    }
  });
}

let _deviceIdMemory = "";

/**
 * 获取或创建稳定 deviceId（local 持久）
 * @returns {Promise<string>}
 */
export async function getOrCreateDeviceId() {
  if (_deviceIdMemory) return _deviceIdMemory;
  const api = getChromeApi();
  if (!api?.storage?.local) {
    _deviceIdMemory = randomId("dev");
    return _deviceIdMemory;
  }
  const area = storageArea(false);
  const existing = await syncIdsStorageGet(area, DEVICE_ID_KEY);
  if (existing && typeof existing === "object" && existing.deviceId) {
    _deviceIdMemory = String(existing.deviceId);
    return _deviceIdMemory;
  }
  if (typeof existing === "string" && existing) {
    _deviceIdMemory = existing;
    return _deviceIdMemory;
  }
  const deviceId = randomId("dev");
  await syncIdsStorageSet(area, { [DEVICE_ID_KEY]: { deviceId } });
  _deviceIdMemory = deviceId;
  return deviceId;
}

/**
 * 新文档 id
 * @returns {string}
 */
export function createDocId() {
  return randomId("doc");
}

/** @param {string} [id] 测试用注入 */
export function _setDeviceIdForTests(id) {
  _deviceIdMemory = id || "";
}
