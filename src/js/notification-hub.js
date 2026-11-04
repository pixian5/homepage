import { getChromeApi } from "./storage.js";

export const SYNC_MERGE_TOAST_INTERVAL_MS = 30 * 60 * 1000;
export const SYNC_MERGE_TOAST_KEY = "homepage_sync_merge_toast_at";
export const DEFAULT_TOAST_CONSUME_TIMEOUT_MS = 15000;

/**
 * 创建应用级通知中枢与外部广播监听器
 * @param {Object} options
 * @param {Function} options.getData 获取当前数据引用
 * @param {Function} options.toast 显示 Toast 接口
 * @param {Function} options.t 多语言翻译接口
 * @param {Function} options.persistData 持久化接口
 * @param {Storage} [options.storage] 存储后端（默认全局 localStorage）
 * @param {Function} [options.getApi] 获取 Chrome/WebExtension API（默认 getChromeApi）
 * @param {number} [options.consumeTimeoutMs] 保存通知消费超时毫秒数（默认 15000）
 * @param {number} [options.syncToastIntervalMs] 同步覆盖提示最小间隔（默认 30 分钟）
 */
export function createNotificationHub(options) {
  const { getData, toast, t, persistData } = options;
  const getStorage = () => {
    if (options.storage) return options.storage;
    if (typeof localStorage !== "undefined") return localStorage;
    return null;
  };

  const getApi = options.getApi || getChromeApi;
  const consumeTimeoutMs = options.consumeTimeoutMs || DEFAULT_TOAST_CONSUME_TIMEOUT_MS;
  const syncToastIntervalMs = options.syncToastIntervalMs || SYNC_MERGE_TOAST_INTERVAL_MS;

  function toastSyncMergedOnce() {
    try {
      const storage = getStorage();
      const last = Number(storage?.getItem(SYNC_MERGE_TOAST_KEY)) || 0;
      if (Date.now() - last < syncToastIntervalMs) return false;
      storage?.setItem(SYNC_MERGE_TOAST_KEY, String(Date.now()));
    } catch {
      // 存储异常退化为允许提示
    }
    toast(t("toast.syncOverwritten"), "warning");
    return true;
  }

  function listenForExternalToast() {
    const api = getApi();
    if (!api?.runtime?.onMessage) return null;
    const listener = (message, _sender, sendResponse) => {
      if (message?.type === "homepage_show_toast" && message?.text) {
        toast(message.text);
        sendResponse?.({ ok: true });
        return true;
      }
      return false;
    };
    api.runtime.onMessage.addListener(listener);
    return listener;
  }

  async function consumeSaveToast() {
    const data = getData();
    const toastInfo = data?.settings?.lastSaveToast;
    if (!toastInfo) return false;
    const ts = Number(toastInfo.ts || 0);
    if (!ts || Date.now() - ts > consumeTimeoutMs) {
      data.settings.lastSaveToast = null;
      await persistData();
      return false;
    }
    const groupName = toastInfo.groupName || t("common.unnamed");
    toast(t("toast.savedToGroup", { name: groupName }));
    data.settings.lastSaveToast = null;
    await persistData();
    return true;
  }

  return {
    toastSyncMergedOnce,
    listenForExternalToast,
    consumeSaveToast,
  };
}
