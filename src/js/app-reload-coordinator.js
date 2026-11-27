/**
 * 应用状态重载与视图同步协调器（app-reload-coordinator）。
 * 内聚从存储/磁盘加载数据、远端投影合并、时间戳校验、分组/文件夹合法性归正、时钟基线重置与多子系统基线同步。
 */

const EXTERNAL_RELOAD_CLAIM_KEY = "homepage_ext_reload_claim";
const EXTERNAL_RELOAD_CLAIM_TTL_MS = 10_000;
const IGNORED_VISIBLE_SETTINGS_KEYS = new Set([
  "syncDeviceSecret",
  "syncDeviceSecretUrl",
  "syncE2eePassphrase",
  "lastSaveToast",
  "lastSaveTs",
  "lastSaveUrl",
  "lastActiveGroupId",
]);

function reloadValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (!reloadValuesEqual(left[i], right[i])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left).filter((k) => left[k] !== undefined);
  const rightKeys = Object.keys(right).filter((k) => right[k] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (!reloadValuesEqual(left[key], right[key])) return false;
  }
  return true;
}

function normalizeVisibleSettings(settings) {
  if (!settings || typeof settings !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (IGNORED_VISIBLE_SETTINGS_KEYS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 判断两份主页数据在可见内容（分组、节点、非运行时/非凭据设置）上是否完全一致。
 * 任一输入非对象返回 false。
 * @param {any} prev
 * @param {any} next
 * @returns {boolean}
 */
export function isVisibleHomepageStateEqual(prev, next) {
  if (!prev || !next || typeof prev !== "object" || typeof next !== "object") return false;
  if (!reloadValuesEqual(prev.groups, next.groups)) return false;
  if (!reloadValuesEqual(prev.nodes, next.nodes)) return false;
  return reloadValuesEqual(normalizeVisibleSettings(prev.settings), normalizeVisibleSettings(next.settings));
}

/**
 * 多标签页外部写入认领（localStorage 协调，10 秒 TTL）：
 * 仅允许首个认领同一 lastUpdated 的标签页执行补拉、补抓图标与触发 schedulePush，
 * 避免 popup / background 写入一次唤醒全部标签页同时放大同步请求。
 * @param {number} lastUpdated
 * @param {{ storage?: Storage|null, now?: number }} [options]
 * @returns {boolean}
 */
export function defaultClaimExternalReload(lastUpdated, options = {}) {
  const ts = Number(lastUpdated || 0);
  if (!Number.isFinite(ts) || ts <= 0) return true;
  const storage = options.storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return true;
  }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  try {
    const raw = String(storage.getItem(EXTERNAL_RELOAD_CLAIM_KEY) || "");
    if (raw) {
      const [claimedTsRaw, claimedAtRaw] = raw.split(":");
      const claimedTs = Number(claimedTsRaw);
      const claimedAt = Number(claimedAtRaw);
      if (
        claimedTs === ts &&
        Number.isFinite(claimedAt) &&
        now - claimedAt >= 0 &&
        now - claimedAt < EXTERNAL_RELOAD_CLAIM_TTL_MS
      ) {
        return false;
      }
    }
    storage.setItem(EXTERNAL_RELOAD_CLAIM_KEY, `${ts}:${now}`);
    return true;
  } catch {
    return true;
  }
}

/**
 * 计算合法有效的活跃分组 ID（带合法性校验与 fallback 回退）。
 *
 * @param {string|null} candidateId 候选分组 ID
 * @param {Object} options
 * @param {function(string): any} options.getRootContainerById 查找根级容器方法
 * @param {function(): { id: string }|null} options.getRootGroup 获取默认根分组
 * @param {string} options.recentGroupId "最近"内置分组常数值
 * @returns {string} 最终有效的活跃分组 ID
 */
export function resolveActiveGroupId(candidateId, { getRootContainerById, getRootGroup, recentGroupId }) {
  if (candidateId === recentGroupId) {
    return recentGroupId;
  }
  if (candidateId && typeof getRootContainerById === "function" && getRootContainerById(candidateId)) {
    return candidateId;
  }
  const root = typeof getRootGroup === "function" ? getRootGroup() : null;
  return root?.id || recentGroupId;
}

/**
 * 校验当前展开的文件夹是否有效。
 *
 * @param {string|null} candidateFolderId 候选文件夹 ID
 * @param {Object} nodes 节点映射字典
 * @returns {string|null} 有效的文件夹 ID 或 null
 */
export function resolveOpenFolderId(candidateFolderId, nodes) {
  const folder = candidateFolderId && nodes ? nodes[candidateFolderId] : null;
  if (folder?.type === "folder" && !folder.deletedAt && !folder.purgedAt) {
    return candidateFolderId;
  }
  return null;
}

/**
 * 创建应用重载与视图同步协调器实例。
 */
export function createAppReloadCoordinator({
  getData,
  setData,
  getActiveGroupId,
  setActiveGroupId,
  getOpenFolderId,
  setOpenFolderId,
  isPersistInFlight,
  loadData,
  pullNow,
  resetSettingsClockBaseline,
  resetPlacementClockBaseline,
  getRootContainerById,
  getRootGroup,
  recentGroupId,
  getSelectionMgr,
  ensureLanguageSetting,
  syncBackupBaseline,
  render,
  processPendingIconFetches,
  consumeSaveToast,
  schedulePush,
  claimExternalReload = defaultClaimExternalReload,
  toast,
  t,
}) {
  async function reloadFromStorage() {
    const prevActive = typeof getActiveGroupId === "function" ? getActiveGroupId() : null;
    const prevOpenFolder = typeof getOpenFolderId === "function" ? getOpenFolderId() : null;
    const currentData = typeof getData === "function" ? getData() : null;
    const prevLocalTs = Number(currentData?.lastUpdated || 0);
    const prevPending = typeof isPersistInFlight === "function" ? isPersistInFlight() : false;

    // 先从磁盘重载 local（popup / 其它标签页 / sync_engine），再按写入来源决定是否触发同步
    const diskLocal = typeof loadData === "function" ? await loadData() : null;
    const writeSource = String(diskLocal?._syncMeta?.lastWriteSource || "external");
    const isNewtabManaged =
      writeSource === "newtab_edit" || writeSource === "sync_merge" || writeSource === "sync_meta";
    const isMetaOnly = writeSource === "sync_meta";
    const claimedExternal =
      !isNewtabManaged &&
      (typeof claimExternalReload === "function" ? claimExternalReload(Number(diskLocal?.lastUpdated || 0)) : true);
    const wasSync = !!diskLocal?.settings?.syncEnabled;
    if (typeof setData === "function") {
      setData(diskLocal);
    }

    if (wasSync && claimedExternal && typeof pullNow === "function") {
      try {
        await pullNow("storage_reload");
      } catch (e) {
        console.warn("reload pullNow failed", e);
      }
    }

    const latestData = typeof getData === "function" ? getData() : diskLocal;
    if (typeof resetSettingsClockBaseline === "function") {
      resetSettingsClockBaseline(latestData);
    }
    if (typeof resetPlacementClockBaseline === "function") {
      resetPlacementClockBaseline(latestData);
    }

    const newTs = Number(latestData?.lastUpdated || 0);
    // merge 提示由 engine onMerged 负责；纯元数据回写不弹出覆盖提示
    if (!wasSync && !isMetaOnly && newTs > prevLocalTs && prevLocalTs > 0 && !prevPending) {
      if (typeof toast === "function" && typeof t === "function") {
        toast(t("toast.syncOverwritten"), "warning");
      }
    }

    const nextActive = resolveActiveGroupId(prevActive, {
      getRootContainerById,
      getRootGroup,
      recentGroupId,
    });
    if (typeof setActiveGroupId === "function") {
      setActiveGroupId(nextActive);
    }

    const nextOpenFolder = resolveOpenFolderId(prevOpenFolder, latestData?.nodes);
    if (typeof setOpenFolderId === "function") {
      setOpenFolderId(nextOpenFolder);
    }

    const selMgr = typeof getSelectionMgr === "function" ? getSelectionMgr() : null;
    selMgr?.retainOnly?.(new Set(Object.keys(latestData?.nodes || {})));

    if (typeof ensureLanguageSetting === "function") {
      ensureLanguageSetting();
    }
    if (typeof syncBackupBaseline === "function") {
      syncBackupBaseline(latestData);
    }
    const skipRender = isMetaOnly && isVisibleHomepageStateEqual(currentData, latestData);
    if (!skipRender && typeof render === "function") {
      render();
    }
    if (claimedExternal && typeof processPendingIconFetches === "function") {
      processPendingIconFetches();
    }
    if (claimedExternal && typeof consumeSaveToast === "function") {
      await consumeSaveToast();
    }
    if (claimedExternal && latestData?.settings?.syncEnabled && typeof schedulePush === "function") {
      schedulePush();
    }
  }

  return {
    reloadFromStorage,
  };
}
