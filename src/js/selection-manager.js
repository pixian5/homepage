/**
 * 批量选择管理器（从 app.js 拆出，解耦第六阶段）。
 *
 * 职责：批量删除模式的完整交互——工具栏按钮激活/退出、卡片单选/反选/Shift 范围选、
 * 鼠标框选拖拽多选、全选、空白点击清除、批量删除（复用支持撤销的 deleteNodes）。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

var HomepageSelectionManager = (() => {
  /** 框选启动阈值：位移超过该值才算拖框（否则视为普通点击） */
  const BOX_SELECT_THRESHOLD = 6;

  /**
   * @param {{
   *   getState: () => { activeGroupId: string, openFolderId: string|null },
   *   getNodes: () => Array<object>,
   *   getGrid: (inFolder: boolean) => HTMLElement,
   *   getMain: () => HTMLElement|null,
   *   deleteNodes: (ids: string[]) => void,
   *   toast: (message: string, kind?: string) => void,
   *   t: (key: string, vars?: object) => string,
   *   isRecentGroup: (groupId: string) => boolean,
   *   qsa: (selector: string, root?: HTMLElement) => Array<HTMLElement>,
   *   rafThrottle?: (fn: Function) => Function,
   * }} deps
   */
  function createSelectionManager(deps) {
    const qsa = deps.qsa;
    const throttle = deps.rafThrottle || ((fn) => fn);

    let selectionMode = false;
    /** @type {Set<string>} 选中的节点 ID */
    let selectedIds = new Set();
    let lastSelectedIndex = null;
    let boxSelecting = false;
    let selectionBox = null;
    let selectionStart = null;
    let isDraggingBox = false;
    /** 框选结束后的下一次点击要吞掉（避免清选后立刻误触发空白逻辑） */
    let suppressBlankClick = false;

    const isBatchModeActive = () => selectionMode;
    const isBoxSelecting = () => boxSelecting;
    const getSelectedIds = () => [...selectedIds];
    const has = (nodeId) => selectedIds.has(nodeId);
    const consumeBlankClickSuppress = () => {
      if (suppressBlankClick) {
        suppressBlankClick = false;
        return true;
      }
      return false;
    };

    /**
     * 进入/退出批量模式（无参切换；传布尔强制指定）。
     * 退出时同时清空选择集合与框选框。
     */
    function toggleBatchMode(forceState) {
      const next = typeof forceState === "boolean" ? forceState : !selectionMode;
      selectionMode = next;
      if (!next) clearSelection();
    }

    /** 卡片选择切换（range=true 时按上次选择做范围全选） */
    function toggleTileSelection(id, index, range) {
      const nodes = deps.getNodes();
      if (range && lastSelectedIndex !== null) {
        const start = Math.min(lastSelectedIndex, index);
        const end = Math.max(lastSelectedIndex, index);
        for (let i = start; i <= end; i++) {
          if (nodes[i]) selectedIds.add(nodes[i].id);
        }
      } else {
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        lastSelectedIndex = index;
      }
      if (lastSelectedIndex === null && typeof index === "number") {
        lastSelectedIndex = index;
      }
      updateStyles();
    }

    function selectTile(nodeId, selected) {
      if (selected) selectedIds.add(nodeId);
      else selectedIds.delete(nodeId);
      updateStyles();
    }

    /** 全选当前网格的全部卡片 */
    function selectAll() {
      if (!selectionMode) return;
      const grid = deps.getGrid(!!deps.getState().openFolderId);
      for (const tile of qsa(".tile", grid)) {
        selectedIds.add(tile.dataset.id);
      }
      updateStyles();
    }

    function clearSelection() {
      selectedIds.clear();
      selectionMode = false;
      lastSelectedIndex = null;
      if (selectionBox) {
        selectionBox.remove();
        selectionBox = null;
      }
    }

    /** 只保留仍存在的节点（数据整包替换后由调用方触发） */
    function retainOnly(validIds) {
      const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
      selectedIds = new Set([...selectedIds].filter((id) => valid.has(id)));
    }

    /** 工具栏状态：全选按钮可见性与批量按钮文案 */
    function updateControls() {
      const selectAllBtn = document.getElementById("btnSelectAll");
      const batchBtn = document.getElementById("btnBatchDelete");
      const folderBatchBtn = document.getElementById("btnFolderBatchDelete");
      if (selectAllBtn) selectAllBtn.classList.toggle("hidden", !selectionMode);
      if (batchBtn) batchBtn.textContent = selectionMode ? deps.t("context.delete") : deps.t("toolbar.batchDelete");
      if (folderBatchBtn) {
        folderBatchBtn.textContent = selectionMode ? deps.t("context.delete") : deps.t("folder.batchDelete");
      }
    }

    /** 网格卡片选中态样式 */
    function updateStyles() {
      const grid = deps.getGrid(!!deps.getState().openFolderId);
      for (const tile of qsa(".tile", grid)) {
        tile.classList.toggle("selected", selectedIds.has(tile.dataset.id));
      }
    }

    function ensureSelectionBox() {
      if (!selectionBox) {
        selectionBox = document.createElement("div");
        selectionBox.className = "selection-box hidden";
        document.body.appendChild(selectionBox);
      }
    }

    function updateSelectionBox(x1, y1, x2, y2) {
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x1 - x2);
      const height = Math.abs(y1 - y2);
      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${width}px`;
      selectionBox.style.height = `${height}px`;
      selectionBox.classList.remove("hidden");
    }

    /** 框选矩形与可见卡片的几何相交命中 */
    function selectTilesInBox(grid, x1, y1, x2, y2) {
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      for (const tile of qsa(".tile", grid)) {
        const rect = tile.getBoundingClientRect();
        const hit = rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top;
        if (hit) selectedIds.add(tile.dataset.id);
      }
    }

    /**
     * 批量删除按钮（主网格 / 文件夹覆盖层共用语义）：
     * 未激活 → 激活；激活但未选 → 退出；有选中 → 删除并退出。
     */
    function executeBatchDelete() {
      if (deps.isRecentGroup(deps.getState().activeGroupId)) {
        deps.toast(deps.t("history.batchDeleteDisabled"), "warning");
        return;
      }
      if (!selectionMode) {
        selectionMode = true;
        deps.toast(deps.t("selection.modeEnabled"));
        updateControls();
        return;
      }
      const ids = [...selectedIds];
      if (!ids.length) {
        clearSelection();
        updateControls();
        updateStyles();
        return;
      }
      clearSelection();
      deps.deleteNodes(ids);
      updateControls();
    }

    /** 绑定批量按钮（btnBatchDelete / btnFolderBatchDelete / btnSelectAll） */
    function bindBatchButtons() {
      document.getElementById("btnBatchDelete")?.addEventListener("click", () => executeBatchDelete());
      document.getElementById("btnFolderBatchDelete")?.addEventListener("click", () => executeBatchDelete());
      document.getElementById("btnSelectAll")?.addEventListener("click", () => selectAll());
    }

    /** 绑定鼠标框选（主网格 / 文件夹覆盖层 / main 空白兜底） */
    function bindBoxSelectEvents() {
      const handleStart = (e, grid) => {
        if (e.button !== 0) return;
        if (e.target.closest?.(".tile")) return;
        if (!selectionMode) return;
        boxSelecting = true;
        isDraggingBox = false;
        ensureSelectionBox();
        selectionStart = { x: e.clientX, y: e.clientY, grid };
        updateSelectionBox(e.clientX, e.clientY, e.clientX, e.clientY);
      };
      const handleMove = (e) => {
        if (!boxSelecting || !selectionStart) return;
        const dx = Math.abs(e.clientX - selectionStart.x);
        const dy = Math.abs(e.clientY - selectionStart.y);
        if (dx + dy > BOX_SELECT_THRESHOLD) isDraggingBox = true;
        updateSelectionBox(selectionStart.x, selectionStart.y, e.clientX, e.clientY);
      };
      const handleEnd = (e) => {
        if (!boxSelecting || !selectionStart) return;
        if (isDraggingBox) {
          selectTilesInBox(selectionStart.grid, selectionStart.x, selectionStart.y, e.clientX, e.clientY);
          suppressBlankClick = true;
        }
        boxSelecting = false;
        selectionStart = null;
        isDraggingBox = false;
        if (selectionBox) selectionBox.classList.add("hidden");
        updateStyles();
      };

      const grid = document.getElementById("grid");
      const folderGrid = document.getElementById("folderGrid");
      grid?.addEventListener("mousedown", (e) => handleStart(e, grid));
      folderGrid?.addEventListener("mousedown", (e) => handleStart(e, folderGrid));
      deps.getMain()?.addEventListener?.("mousedown", (e) => {
        if (deps.getState().openFolderId) return;
        handleStart(e, grid);
      });
      document.addEventListener("mousemove", throttle(handleMove));
      document.addEventListener("mouseup", handleEnd);
    }

    /** 主区域空白点击：批量模式下清除选择 */
    function bindBlankClickClear() {
      deps.getMain()?.addEventListener?.("click", (e) => {
        if (consumeBlankClickSuppress()) return;
        if (!selectionMode || boxSelecting) return;
        if (e.target.closest?.(".tile")) return;
        clearSelection();
        updateControls();
        updateStyles();
      });
    }

    return {
      isBatchModeActive,
      isBoxSelecting,
      toggleBatchMode,
      toggleTileSelection,
      selectTile,
      selectAll,
      getSelectedIds,
      has,
      retainOnly,
      clearSelection,
      executeBatchDelete,
      updateControls,
      updateStyles,
      bindBatchButtons,
      bindBoxSelectEvents,
      bindBlankClickClear,
      consumeBlankClickSuppress,
    };
  }

  return { createSelectionManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createSelectionManager = HomepageSelectionManager.createSelectionManager;
