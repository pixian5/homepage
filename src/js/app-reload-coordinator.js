/**
 * 应用状态重载与视图同步协调器（app-reload-coordinator）。
 * 内聚从存储/磁盘加载数据、远端投影合并、时间戳校验、分组/文件夹合法性归正、时钟基线重置与多子系统基线同步。
 */

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
  if (candidateFolderId && nodes && nodes[candidateFolderId]?.type === "folder") {
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
  toast,
  t,
}) {
  async function reloadFromStorage() {
    const prevActive = typeof getActiveGroupId === "function" ? getActiveGroupId() : null;
    const prevOpenFolder = typeof getOpenFolderId === "function" ? getOpenFolderId() : null;
    const currentData = typeof getData === "function" ? getData() : null;
    const prevLocalTs = Number(currentData?.lastUpdated || 0);
    const prevPending = typeof isPersistInFlight === "function" ? isPersistInFlight() : false;

    // 先从磁盘重载 local（popup 等外部写入），再按需 pull 合并远端投影
    const diskLocal = typeof loadData === "function" ? await loadData() : null;
    const wasSync = !!diskLocal?.settings?.syncEnabled;
    if (typeof setData === "function") {
      setData(diskLocal);
    }

    if (wasSync && typeof pullNow === "function") {
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
    // merge 提示由 engine onMerged 负责；此处仅非 sync 粗提示
    if (!wasSync && newTs > prevLocalTs && prevLocalTs > 0 && !prevPending) {
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
    if (typeof render === "function") {
      render();
    }
    if (typeof processPendingIconFetches === "function") {
      processPendingIconFetches();
    }
    if (typeof consumeSaveToast === "function") {
      await consumeSaveToast();
    }
    if (latestData?.settings?.syncEnabled && typeof schedulePush === "function") {
      schedulePush();
    }
  }

  return {
    reloadFromStorage,
  };
}
