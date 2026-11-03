/**
 * 拖拽与重排管理器（从 app.js 拆出，解耦第四阶段）。
 *
 * 职责：卡片拖拽的三种意图统一处理——
 *   1. 排序插入（移动到目标索引，含空白区按几何最近矩形落位）；
 *   2. 放入已有文件夹（侧栏分组按钮 / 文件夹卡片图标区投放）；
 *   3. 合并成组（卡片拖到卡片图标上自动创建新文件夹并移入两项）；
 * 以及侧栏分组自身的拖拽排序（含容器首尾投放与边缘滚动）。
 * 触摸拖拽（touchDragState）仍留在 app.js，经 setDragState 等接口与本模块协同。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import { findNearestRect, isPointInsideRect, shouldInsertAfter, toPlainRect } from "./drag-geometry.js";

var HomepageDragManager = (() => {
  /**
   * @param {{
   *   getData: () => object,
   *   getState: () => { activeGroupId: string, openFolderId: string|null },
   *   getActiveGroup: () => object,
   *   getFolderPlacementContainer: (folderId: string) => object,
   *   getPlacementList: (container: object) => string[],
   *   setPlacementList: (container: object, list: string[]) => void,
   *   touchPlacementContainer: (container: object) => void,
   *   removeNodeFromLocation: (id: string) => void,
   *   moveNodeInList: (list: string[], id: string, index: number) => string[],
   *   moveNodeToFolder: (data: object, nodeId: string, folderId: string) => boolean,
   *   canMoveNodeToFolder: (data: object, nodeId: string, folderId: string) => boolean,
   *   createFolderNode: (childIds: string[]) => object,
   *   moveGroupToIndex: (groupId: string, index: number) => void,
   *   pushBackup: () => void,
   *   queuePersist: () => void,
   *   render: () => void,
   *   toast: (message: string, kind?: string) => void,
   *   t: (key: string, vars?: object) => string,
   *   isRecentGroup: (groupId: string) => boolean,
   *   isAllBookmarksGroup: (groupOrId: object|string) => boolean,
   *   getRootFolderIds: () => string[],
   *   qsa?: (selector: string, root?: HTMLElement) => Array<HTMLElement>,
   *   qs?: (selector: string, root?: HTMLElement) => HTMLElement|null,
   * }} deps
   */
  function createDragManager(deps) {
    const qsa = deps.qsa || ((sel, root) => Array.from((root || document).querySelectorAll(sel)));
    const qs = deps.qs || ((sel, root) => (root || document).querySelector(sel));

    /** @type {{id: string, fromFolder: string|null}|null} 当前卡片拖拽源 */
    let dragState = null;
    /** @type {string|null} 当前拖拽中的侧栏分组 ID */
    let draggingGroupId = null;

    const setDragState = (state) => {
      dragState = state || null;
    };
    const getDragState = () => dragState;
    const setDraggingGroupId = (id) => {
      draggingGroupId = id || null;
    };
    const getDraggingGroupId = () => draggingGroupId;

    /** 清理拖拽残留：状态、悬停高亮（tile 与侧栏分组按钮） */
    function cleanupDragState() {
      dragState = null;
      draggingGroupId = null;
      for (const el of qsa(".tile.drop-target")) el.classList.remove("drop-target");
      for (const el of qsa(".group-tab.drop-target")) el.classList.remove("drop-target");
      for (const el of qsa(".group-tab.dragging")) el.classList.remove("dragging");
    }

    function getTileElementById(targetId, grid) {
      // 未指定网格时在两个网格里找（与拆出前行为一致：按当前打开状态）
      const containers = grid ? [grid] : [document.getElementById("grid"), document.getElementById("folderGrid")];
      for (const container of containers) {
        if (!container) continue;
        const found = qsa(".tile", container).find((tile) => tile.dataset?.id === targetId);
        if (found) return found;
      }
      return null;
    }

    /** 命中判定：投放点是否落在目标卡片的图标区（= 合并/放入文件夹意图） */
    function isDropOnIcon(targetId, x, y, grid) {
      const tile = getTileElementById(targetId, grid);
      if (!tile) return false;
      const icon = qs(".tile-icon", tile);
      if (!icon) return false;
      return isPointInsideRect(toPlainRect(icon.getBoundingClientRect()), x, y);
    }

    /** 非图标区投放：按目标卡片左右半区决定插入前/后 */
    function getInsertIndexFromTarget(list, targetId, x, grid) {
      const targetIndex = list.indexOf(targetId);
      if (targetIndex < 0) return list.length;
      const tile = getTileElementById(targetId, grid);
      if (!tile) return targetIndex;
      const rect = tile.getBoundingClientRect();
      // 非图标区域拖放仅按左右半区判断前后，避免误判到行首/左侧。
      const insertAfter = x >= rect.left + rect.width / 2;
      return Math.max(0, Math.min(targetIndex + (insertAfter ? 1 : 0), list.length));
    }

    /** 空白区投放：按几何最近矩形与其前后半区决定插入索引 */
    function getDropIndex(grid, x, y) {
      const tiles = qsa(".tile", grid).filter((tile) => tile.getClientRects().length > 0);
      if (!tiles.length) return 0;
      const rects = tiles.map((tile) => toPlainRect(tile.getBoundingClientRect()));
      const { index } = findNearestRect(rects, x, y);
      return index + (shouldInsertAfter(rects[index], x, y) ? 1 : 0);
    }

    /**
     * 卡片投放的核心分发（三种意图）。
     * @param {string} targetId 投放目标卡片
     * @param {number} x 投放点
     * @param {number} y 投放点
     */
    function dropOnTile(targetId, x, y) {
      if (!dragState || dragState.id === targetId) return;
      const { activeGroupId, openFolderId } = deps.getState();
      if (deps.isRecentGroup(activeGroupId)) return;
      const data = deps.getData();
      const sourceId = dragState.id;
      const targetNode = data.nodes[targetId];
      const sourceNode = data.nodes[sourceId];
      if (!targetNode || !sourceNode) return;

      const inFolder = !!openFolderId;
      const container = inFolder ? deps.getFolderPlacementContainer(openFolderId) : deps.getActiveGroup();
      const grid = getTileElementById(targetId)?.parentElement || null;
      const list = deps.getPlacementList(container);
      const droppedOnIcon = isDropOnIcon(targetId, x, y, grid);

      if (!droppedOnIcon) {
        // 意图 1：排序插入
        const insertIndex = getInsertIndexFromTarget(list, targetId, x, grid);
        const next = deps.moveNodeInList(list, sourceId, insertIndex);
        if (next === list) return;
        deps.pushBackup();
        deps.setPlacementList(container, next);
        deps.touchPlacementContainer(container);
        deps.queuePersist();
        deps.render();
        return;
      }

      if (targetNode.type !== "folder") {
        // 意图 3：卡片拖到卡片图标上 → 创建新文件夹并移入两项
        deps.pushBackup();
        const targetIndex = list.indexOf(targetId);
        const sourceIndex = list.indexOf(sourceId);
        let insertIndex = targetIndex >= 0 ? targetIndex : list.length;
        if (sourceIndex >= 0 && sourceIndex < insertIndex) insertIndex -= 1;

        deps.removeNodeFromLocation(sourceId);
        deps.removeNodeFromLocation(targetId);

        const folder = deps.createFolderNode([targetId, sourceId]);
        data.nodes[folder.id] = folder;

        const next = deps.getPlacementList(container).filter((nid) => nid !== sourceId && nid !== targetId);
        next.splice(Math.max(0, Math.min(insertIndex, next.length)), 0, folder.id);
        deps.setPlacementList(container, next);
        deps.touchPlacementContainer(container);
        deps.queuePersist();
        deps.render();
        deps.toast(deps.t("folder.created"));
        return;
      }

      // 意图 2：拖到已有文件夹图标上 → 移入该文件夹（canMove 校验 + 全位置移除 + 追加）
      if (!deps.moveNodeToFolder(data, sourceId, targetId)) return;
      deps.pushBackup();
      deps.touchPlacementContainer(targetNode);
      deps.queuePersist();
      deps.render();
      deps.toast(deps.t("folder.added"));
    }

    /**
     * 为网格卡片绑定原生拖拽事件（renderGrid 逐卡片调用）。
     * dragover 时为目标卡片加 .drop-target 高亮（拖放指示器），离开/放下后清除。
     */
    function bindTileDragEvents(tile, node) {
      tile.addEventListener("dragstart", (e) => {
        const { openFolderId } = deps.getState();
        dragState = { id: node.id, fromFolder: openFolderId };
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      tile.addEventListener("dragend", () => {
        dragState = null;
        tile.classList.remove("drop-target");
      });
      tile.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (dragState && dragState.id !== node.id) tile.classList.add("drop-target");
      });
      tile.addEventListener("dragleave", () => {
        tile.classList.remove("drop-target");
      });
      tile.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        tile.classList.remove("drop-target");
        dropOnTile(node.id, e.clientX, e.clientY);
        dragState = null;
      });
    }

    /**
     * 为侧栏分组按钮绑定投放与分组拖拽排序事件。
     * @param {HTMLElement} btn 分组按钮元素
     * @param {{groupId: string, fixedAllGroup?: boolean}} options
     */
    function bindSidebarFolderEvents(btn, { groupId, fixedAllGroup = false }) {
      btn.addEventListener("dragstart", () => {
        if (fixedAllGroup) return;
        draggingGroupId = groupId;
        btn.classList.add("dragging");
      });
      btn.addEventListener("dragend", () => {
        draggingGroupId = null;
        btn.classList.remove("dragging");
        for (const el of qsa(".group-tab", document)) el.classList.remove("drop-target");
      });
      btn.addEventListener("dragover", (e) => {
        if (dragState && fixedAllGroup) return;
        e.preventDefault();
        if (dragState && e.dataTransfer) e.dataTransfer.dropEffect = "move";
        btn.classList.add("drop-target");
      });
      btn.addEventListener("dragleave", () => {
        btn.classList.remove("drop-target");
      });
      btn.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.classList.remove("drop-target");
        if (dragState && !fixedAllGroup) {
          moveDraggedNodeToSidebarFolder(dragState.id, groupId);
          dragState = null;
          return;
        }
        if (!draggingGroupId || draggingGroupId === groupId) return;
        moveGroupBefore(draggingGroupId, groupId);
      });
    }

    /**
     * 为网格容器（主网格 / 文件夹覆盖层网格）绑定空白区投放：按几何最近矩形排序插入。
     * @param {HTMLElement} gridEl
     * @param {{getContainer: () => object, enabled: () => boolean}} options
     */
    function bindGridDropEvents(gridEl, { getContainer, enabled }) {
      gridEl.addEventListener("dragover", (e) => e.preventDefault());
      gridEl.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragState) return;
        if (!enabled()) {
          dragState = null;
          return;
        }
        const container = getContainer();
        const index = getDropIndex(gridEl, e.clientX, e.clientY);
        const list = deps.getPlacementList(container);
        const next = deps.moveNodeInList(list, dragState.id, index);
        if (next !== list) {
          deps.setPlacementList(container, next);
          deps.touchPlacementContainer(container);
          deps.queuePersist();
          deps.render();
        }
        dragState = null;
      });
    }

    /**
     * 侧栏分组容器：拖拽悬停边缘自动滚动 + 投放到容器首/尾。
     * @param {HTMLElement} tabsEl 分组容器元素
     */
    function bindGroupTabsEvents(tabsEl) {
      tabsEl.addEventListener("dragover", (e) => {
        if (!draggingGroupId) return;
        e.preventDefault();
        const rect = tabsEl.getBoundingClientRect();
        const edge = 24;
        if (e.clientY < rect.top + edge) tabsEl.scrollTop -= 16;
        else if (e.clientY > rect.bottom - edge) tabsEl.scrollTop += 16;
      });
      tabsEl.addEventListener("drop", (e) => {
        if (!draggingGroupId) return;
        e.preventDefault();
        const rect = tabsEl.getBoundingClientRect();
        const edge = 24;
        const total = deps.getRootFolderIds().length;
        if (e.clientY < rect.top + edge) deps.moveGroupToIndex(draggingGroupId, 0);
        else if (e.clientY > rect.bottom - edge) deps.moveGroupToIndex(draggingGroupId, total);
        for (const el of qsa(".group-tab", tabsEl)) el.classList.remove("drop-target");
      });
    }

    /** 把拖拽节点移入侧栏分组（目标分组实为根目录下的顶层文件夹） */
    function moveDraggedNodeToSidebarFolder(nodeId, folderId) {
      const data = deps.getData();
      if (!deps.canMoveNodeToFolder(data, nodeId, folderId)) return false;
      deps.pushBackup();
      if (!deps.moveNodeToFolder(data, nodeId, folderId)) return false;
      deps.touchPlacementContainer(data.nodes[folderId]);
      deps.queuePersist();
      deps.render();
      deps.toast(deps.t("folder.added"));
      return true;
    }

    /** 分组拖拽排序：把源分组移动到目标分组之前 */
    function moveGroupBefore(sourceId, targetId) {
      if (deps.isAllBookmarksGroup(sourceId) || deps.isAllBookmarksGroup(targetId)) return;
      const targetIndex = deps.getRootFolderIds().indexOf(targetId);
      deps.moveGroupToIndex(sourceId, targetIndex);
    }

    return {
      setDragState,
      getDragState,
      setDraggingGroupId,
      getDraggingGroupId,
      cleanupDragState,
      bindTileDragEvents,
      bindSidebarFolderEvents,
      bindGridDropEvents,
      bindGroupTabsEvents,
      dropOnTile,
      moveDraggedNodeToSidebarFolder,
      moveGroupBefore,
      getDropIndex,
    };
  }

  return { createDragManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createDragManager = HomepageDragManager.createDragManager;
