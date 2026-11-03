/**
 * 存储变更热监听（从 app.js 拆出，解耦第五阶段）。
 *
 * 职责：统一监听本地存储变更——扩展环境 chrome.storage.onChanged，
 * Web 模式 window "storage" 事件（跨标签页）。区分外部变更与自身写入
 * （写入窗口期 / 抑制期 / 时间戳不超前），核心数据变更防抖安全重载并
 * 局部刷新；同步状态/队列键变更时刷新提示条；设置弹窗打开期间挂起重载，
 * 关闭后补一次。解绑逻辑内聚（dispose）。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import { getChromeApi } from "./shared-utils.js";

var HomepageStorageListener = (() => {
  /**
   * @param {{
   *   dataKey: string,
   *   syncKeys?: string[],
   *   getData: () => object,
   *   isPersistInFlight: () => boolean,
   *   isSuppressed: () => boolean,
   *   isSettingsOpen: () => boolean,
   *   reload: () => Promise<void>|void,
   *   onSyncKeysChanged?: () => void,
   *   reloadDelayMs?: number,
   *   getWebStorage?: () => Storage|null,
   * }} deps
   */
  function createStorageListener(deps) {
    const dataKey = deps.dataKey;
    const syncKeys = deps.syncKeys || [];
    const reloadDelayMs = Number(deps.reloadDelayMs) > 0 ? Number(deps.reloadDelayMs) : 120;
    let reloadTimer = null;
    /** 设置弹窗打开期间挂起的重载，关闭后 flush */
    let pendingReload = false;
    let disposed = false;

    function scheduleReload() {
      if (deps.isSettingsOpen()) {
        pendingReload = true;
        return;
      }
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void deps.reload();
      }, reloadDelayMs);
    }

    /** 设置弹窗关闭后由调用方调用：补一次挂起的外部变更重载 */
    function flushPendingReload() {
      if (!pendingReload) return false;
      pendingReload = false;
      scheduleReload();
      return true;
    }

    /**
     * 扩展 storage.onChanged 分流。
     * @param {Record<string, {newValue: any, oldValue: any}>} changes
     * @param {string} areaName
     */
    function handleExtensionChanges(changes, areaName) {
      if (disposed) return;
      if (areaName !== "local") return;
      // 同步状态/队列变化：其它标签页解决冲突或后台推送后，本页状态栏与提示条也要跟上。
      // 这些键不受写入窗口期 / 抑制期影响（它们只保护数据写入）。
      if (syncKeys.some((key) => changes?.[key])) {
        deps.onSyncKeysChanged?.();
        return;
      }
      if (deps.isPersistInFlight()) return;
      if (deps.isSuppressed()) return;
      if (!changes?.[dataKey]) return;
      // 本地核心数据变更（如 popup 写入 / 其它标签页保存 / 同步引擎落盘）
      const incoming = changes[dataKey].newValue;
      const incomingTs = Number(incoming?.lastUpdated || 0);
      const localTs = Number(deps.getData()?.lastUpdated || 0);
      // 时间戳不超前视为自身写入的回声，直接忽略（防自触发循环渲染）
      if (incomingTs > 0 && localTs > 0 && incomingTs <= localTs) return;
      scheduleReload();
    }

    /**
     * Web 模式 storage 事件（跨标签页；本标签页的写入不触发本事件）。
     * @param {StorageEvent} event
     */
    function handleWebStorageEvent(event) {
      if (disposed) return;
      if (event.key !== null && event.key !== dataKey) return;
      if (deps.isPersistInFlight() || deps.isSuppressed()) return;
      try {
        const incoming = event.newValue ? JSON.parse(event.newValue) : null;
        const incomingTs = Number(incoming?.lastUpdated || 0);
        const localTs = Number(deps.getData()?.lastUpdated || 0);
        if (incomingTs > 0 && localTs > 0 && incomingTs <= localTs) return;
      } catch (_e) {
        // 解析失败按「可能更新」处理，交给防抖重载兜底
      }
      scheduleReload();
    }

    /** 绑定（扩展 + Web 双通道），dispose 解绑双通道并清理定时器 */
    let _dispose = null;

    function bind() {
      dispose();
      const api = getChromeApi();
      const disposers = [];
      if (api?.storage?.onChanged?.addListener) {
        api.storage.onChanged.addListener(handleExtensionChanges);
        disposers.push(() => {
          try {
            api.storage.onChanged.removeListener(handleExtensionChanges);
          } catch (_e) {
            // ignore
          }
        });
      }
      // Web 模式：window storage 事件覆盖跨标签页热同步
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("storage", handleWebStorageEvent);
        disposers.push(() => window.removeEventListener("storage", handleWebStorageEvent));
      }
      _dispose = () => {
        disposed = true;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = null;
        pendingReload = false;
        for (const disposer of disposers) disposer();
      };
      return _dispose;
    }

    function dispose() {
      _dispose?.();
    }

    return {
      bind,
      dispose,
      handleExtensionChanges,
      handleWebStorageEvent,
      scheduleReload,
      flushPendingReload,
      get hasPendingReload() {
        return pendingReload;
      },
    };
  }

  return { createStorageListener };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createStorageListener = HomepageStorageListener.createStorageListener;
