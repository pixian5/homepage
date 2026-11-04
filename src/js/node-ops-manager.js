/**
 * 节点与分组操作生命周期管理器（从 app.js 拆出，解耦第十二阶段）。
 *
 * 职责：删除（级联收集 + 位置记忆 + 软删除标记 + 撤销队列定时器）、
 * 撤销恢复（原位置逆序回插 + 墓碑清除）、分组删除/重命名/排序、
 * 容器与子节点定位导航（活动分组、根分组、放置列表、时钟推进）。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import {
  ALL_BOOKMARKS_GROUP_ID,
  collectNodeSubtreeIds,
  dedupeData,
  getRootFolderNodeIds,
  isAllBookmarksGroup,
  markNodeDeleted,
} from "./data-utils.js";
import { deepClone } from "./storage.js";
import { nextSyncTimestamp } from "./sync_policy.js";

var HomepageNodeOpsManager = (() => {
  /**
   * @param {{
   *   getData: () => object,
   *   getState: () => { activeGroupId: string, openFolderId: string|null },
   *   setActiveGroupId: (id: string) => void,
   *   getRecentItems: () => Array<object>,
   *   pushBackup: () => boolean,
   *   queuePersist: () => Promise<any>,
   *   render: () => void,
   *   toast: (message: string, actionLabelOrType?: any, actionOrType?: any, type?: any) => void,
   *   t: (key: string, vars?: object) => string,
   *   prompt?: (message: string, defaultValue?: string) => string | null,
   *   confirm?: (message: string) => boolean,
   *   getFolderManager?: () => { renameFolder: (folderId: string, newTitle: string) => boolean } | null,
   *   undoTimeoutMs?: number,
   * }} options
   */
  function createNodeOpsManager(options) {
    const getData = options.getData;
    const getState = options.getState;
    const setActiveGroupId = options.setActiveGroupId;
    const getRecentItems = options.getRecentItems || (() => []);
    const pushBackup = options.pushBackup;
    const queuePersist = options.queuePersist;
    const render = options.render;
    const toast = options.toast;
    const t = options.t;
    const promptFn = options.prompt || ((message, defaultValue) => globalThis.prompt?.(message, defaultValue));
    const confirmFn = options.confirm || ((message) => globalThis.confirm?.(message));
    const getFolderManager = options.getFolderManager || (() => null);
    const undoTimeoutMs = Number(options.undoTimeoutMs) > 0 ? Number(options.undoTimeoutMs) : 10000;
    const isRecentGroup = options.isRecentGroup || ((groupId) => groupId === "__recent__");

    /** @type {{deletedNodes: object, placements: Array<object>, ids: string[], timer: any}|null} 挂起的撤销 */
    let pendingDeletion = null;

    // ---- 容器导航 ----
    function getRootGroup() {
      const data = getData();
      return (data.groups || []).find((group) => isAllBookmarksGroup(group)) || data.groups[0];
    }

    function getActiveGroup() {
      const root = getRootGroup();
      const { activeGroupId } = getState();
      if (activeGroupId === root?.id) return root;
      const folder = getData().nodes[activeGroupId];
      return folder?.type === "folder" && root?.nodes?.includes(folder.id) ? folder : root;
    }

    function getRootFolderIds() {
      return getRootFolderNodeIds(getData());
    }

    function getRootContainers() {
      const data = getData();
      const root = getRootGroup();
      return [root, ...getRootFolderIds().map((id) => data.nodes[id])].filter(Boolean);
    }

    function getRootContainerById(id) {
      return getRootContainers().find((container) => container.id === id) || null;
    }

    function getFolderPlacementContainer(folderId) {
      return getData().nodes[folderId] || null;
    }

    function getPlacementList(container) {
      if (!container) return [];
      return Array.isArray(container.nodes)
        ? container.nodes
        : Array.isArray(container.children)
          ? container.children
          : [];
    }

    function setPlacementList(container, list) {
      if (!container) return;
      if (Array.isArray(container.nodes)) container.nodes = list;
      else container.children = list;
    }

    /** 当前网格应显示的节点序列（历史分组返回最近访问条目） */
    function getCurrentNodes() {
      const data = getData();
      const { activeGroupId, openFolderId } = getState();
      if (isRecentGroup(activeGroupId)) return getRecentItems();
      const group = getActiveGroup();
      const nodeIds = openFolderId
        ? getPlacementList(getFolderPlacementContainer(openFolderId))
        : getPlacementList(group);
      return nodeIds.map((id) => data.nodes[id]).filter(Boolean);
    }

    /** 推进容器结构时钟（updatedAt 取观察值最大者，投影时补设备 ID） */
    function touchPlacementContainer(container) {
      if (!container || typeof container !== "object") return;
      container.updatedAt = nextSyncTimestamp(
        Date.now(),
        container.updatedAt,
        container.titleUpdatedAt,
        container.nameUpdatedAt,
        container.orderUpdatedAt,
      );
      // 投影时为空会自动写入当前设备 ID，保证同一时间的并发变更可确定裁决。
      container.updatedBy = "";
    }

    /** 从所有 group 与 folder 的子节点数组中移除目标 id 并推进容器时钟 */
    function removeNodeFromLocation(id) {
      const data = getData();
      for (const group of data.groups || []) {
        if (!Array.isArray(group.nodes)) continue;
        const next = group.nodes.filter((nid) => nid !== id);
        if (next.length !== group.nodes.length) {
          group.nodes = next;
          touchPlacementContainer(group);
        }
      }
      for (const node of Object.values(data.nodes || {})) {
        if (node.type !== "folder" || !Array.isArray(node.children)) continue;
        const next = node.children.filter((nid) => nid !== id);
        if (next.length !== node.children.length) {
          node.children = next;
          touchPlacementContainer(node);
        }
      }
    }

    // ---- 分组操作 ----
    /** 在根分组节点列表中安全计算插入位置并重排（越界钳制） */
    function moveGroupToIndex(sourceId, index) {
      if (isAllBookmarksGroup(sourceId)) return;
      const data = getData();
      const root = getRootGroup();
      if (!root?.nodes?.includes(sourceId) || data.nodes[sourceId]?.type !== "folder") return;
      const visible = getRootFolderIds().filter((id) => id !== sourceId);
      const safeIndex = Math.max(0, Math.min(index, visible.length));
      const next = root.nodes.filter((id) => id !== sourceId);
      const targetId = visible[safeIndex];
      let insertAt = targetId ? next.indexOf(targetId) : next.length;
      if (!targetId && visible.length) insertAt = next.indexOf(visible[visible.length - 1]) + 1;
      next.splice(Math.max(0, insertAt), 0, sourceId);
      root.nodes = next;
      touchPlacementContainer(root);
      queuePersist();
      render();
    }

    /** prompt 弹窗重命名分组（固定根拦截），实际修改委派 folderManager 的字段时钟 */
    function renameGroup(group) {
      if (isAllBookmarksGroup(group)) return;
      const name = promptFn?.(t("group.promptName"), group.title);
      if (!name) return;
      getFolderManager()?.renameFolder(group.id, name);
    }

    /** 删除分组：固定根拦截 + 确认弹窗 + 激活分组切回根 + 级联删除 */
    function deleteGroup(group) {
      if (isAllBookmarksGroup(group)) return;
      if (!confirmFn?.(t("group.deleteConfirm", { name: group.title }))) return;
      const data = getData();
      if (getState().activeGroupId === group.id) {
        setActiveGroupId(ALL_BOOKMARKS_GROUP_ID);
        data.settings.lastActiveGroupId = ALL_BOOKMARKS_GROUP_ID;
      }
      deleteNodes([group.id]);
    }

    // ---- 删除与撤销 ----
    /**
     * 删除节点（级联展开子树）：深拷贝留存实体、记录各容器原位置、
     * 软删除标记 + 去重 + 持久化，撤销 Toast 与超时定时器。
     * 历史分组（只读）整体拦截。
     */
    function deleteNodes(ids) {
      if (!ids.length) return;
      if (isRecentGroup(getState().activeGroupId)) return;
      const data = getData();
      pushBackup();
      // 撤销只恢复本次删除的节点，避免整库快照抹掉后续编辑
      const deletedNodes = {};
      const expanded = new Set();
      for (const id of ids) {
        for (const nid of collectNodeSubtreeIds(data, id)) expanded.add(nid);
      }
      for (const id of expanded) {
        if (data.nodes[id]) deletedNodes[id] = deepClone(data.nodes[id]);
      }
      // 记录删除前各容器中的位置，便于精确回插
      const placements = [];
      for (const group of data.groups || []) {
        for (let i = 0; i < (group.nodes || []).length; i++) {
          const id = group.nodes[i];
          if (expanded.has(id)) placements.push({ kind: "group", groupId: group.id, index: i, id });
        }
      }
      for (const [folderId, node] of Object.entries(data.nodes || {})) {
        if (node?.type !== "folder" || !Array.isArray(node.children)) continue;
        for (let i = 0; i < node.children.length; i++) {
          const id = node.children[i];
          if (expanded.has(id)) placements.push({ kind: "folder", folderId, index: i, id });
        }
      }

      for (const id of expanded) {
        removeNodeFromLocation(id);
        markNodeDeleted(data, id);
      }
      dedupeData(data);

      pendingDeletion = { deletedNodes, placements, ids: [...expanded], timer: null };
      queuePersist();
      render();

      toast(t("delete.deletedCount", { count: expanded.size }), t("delete.undo"), () => undoDelete());
      if (pendingDeletion.timer) clearTimeout(pendingDeletion.timer);
      pendingDeletion.timer = setTimeout(() => {
        pendingDeletion = null;
      }, undoTimeoutMs);
    }

    /** 撤销删除：恢复节点实体（清软删标记与墓碑），按原位置逆序回插，保持相对顺序 */
    function undoDelete() {
      if (!pendingDeletion) return false;
      if (pendingDeletion.timer) clearTimeout(pendingDeletion.timer);
      const { deletedNodes, placements } = pendingDeletion;
      pendingDeletion = null;
      const data = getData();
      // 先恢复节点实体
      for (const [id, node] of Object.entries(deletedNodes || {})) {
        data.nodes[id] = { ...node, updatedAt: Date.now(), updatedBy: "" };
        delete data.nodes[id].deletedAt;
        delete data.nodes[id].purgedAt;
        if (data._syncMeta?.nodeTombstones) delete data._syncMeta.nodeTombstones[id];
      }
      // 再按原位置回插引用（倒序插入以尽量保持相对顺序）
      const sorted = [...(placements || [])].sort((a, b) => b.index - a.index);
      for (const p of sorted) {
        if (p.kind === "group") {
          const group = data.groups.find((g) => g.id === p.groupId);
          if (!group) continue;
          if (!Array.isArray(group.nodes)) group.nodes = [];
          if (!group.nodes.includes(p.id)) {
            const idx = Math.max(0, Math.min(p.index, group.nodes.length));
            group.nodes.splice(idx, 0, p.id);
            touchPlacementContainer(group);
          }
        } else if (p.kind === "folder") {
          const folder = data.nodes[p.folderId];
          if (folder?.type !== "folder") continue;
          if (!Array.isArray(folder.children)) folder.children = [];
          if (!folder.children.includes(p.id)) {
            const idx = Math.max(0, Math.min(p.index, folder.children.length));
            folder.children.splice(idx, 0, p.id);
            touchPlacementContainer(folder);
          }
        }
      }
      dedupeData(data);
      queuePersist();
      render();
      toast(t("delete.restored"));
      return true;
    }

    return {
      deleteNodes,
      undoDelete,
      deleteGroup,
      renameGroup,
      moveGroupToIndex,
      removeNodeFromLocation,
      touchPlacementContainer,
      getActiveGroup,
      getRootGroup,
      getRootFolderIds,
      getRootContainers,
      getRootContainerById,
      getFolderPlacementContainer,
      getPlacementList,
      setPlacementList,
      getCurrentNodes,
      getPendingDeletion: () => pendingDeletion,
    };
  }

  return { createNodeOpsManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createNodeOpsManager = HomepageNodeOpsManager.createNodeOpsManager;
