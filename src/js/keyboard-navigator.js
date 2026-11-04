import { nextGridFocusIndex } from "./drag-geometry.js";
import { RECENT_GROUP_ID } from "./shared-utils.js";

/**
 * 创建键盘无障碍导航控制器
 * @param {Object} options
 * @param {Function} options.getData
 * @param {Function} options.getState 返回 { activeGroupId, openFolderId }
 * @param {Function} options.getElements 返回 { modalOverlay, topSearch, grid, folderGrid }
 * @param {Function} options.closeFolder
 * @param {Function} options.deleteNodes
 * @param {Function} [options.qsa]
 * @param {Document} [options.doc]
 */
export function createKeyboardNavigator(options) {
  const { getData, getState, getElements, closeFolder, deleteNodes } = options;
  const qsa = options.qsa || ((sel, root = document) => Array.from(root.querySelectorAll(sel)));
  const doc = options.doc || (typeof document !== "undefined" ? document : null);

  function handleKeydown(e) {
    if (!doc) return;
    const elements = getElements();
    const data = getData();
    const { activeGroupId, openFolderId } = getState();

    // 弹窗打开时：Enter 交给 modal 内逻辑；不跑网格键盘导航
    const modalOpen = elements.modalOverlay && !elements.modalOverlay.classList.contains("hidden");
    if (modalOpen && e.key === "Enter") {
      return;
    }

    if (!data?.settings?.keyboardNav) return;

    // 输入框内不劫持方向键
    const tag = (e.target?.tagName || "").toLowerCase();
    const isEditing = tag === "input" || tag === "textarea" || !!e.target?.isContentEditable;
    if (isEditing) {
      if (e.key === "Escape" && openFolderId) closeFolder();
      return;
    }

    if (e.key === "Escape" && openFolderId) {
      closeFolder();
      return;
    }

    if (e.key === "/") {
      // 弹窗打开时不要抢焦点到搜索
      if (modalOpen) return;
      if (elements.topSearch) {
        elements.topSearch.focus();
        e.preventDefault();
      }
      return;
    }

    // 方向键 / Home / End 在可见卡片间漫游焦点；Delete 删除聚焦卡片
    const navKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    const isNav = navKeys.includes(e.key);
    const isDel = e.key === "Delete" || e.key === "Backspace";

    if (isNav || isDel) {
      if (modalOpen) return;
      const grid = openFolderId ? elements.folderGrid : elements.grid;
      if (!grid) return;

      // 只在可见卡片间漫游：被搜索过滤隐藏的卡片不参与
      const tiles = qsa(".tile", grid).filter(
        (tile) => tile.style.display !== "none" && (!tile.getClientRects || tile.getClientRects().length > 0),
      );

      if (isDel) {
        const active = doc.activeElement;
        const idx = tiles.indexOf(active);
        if (idx < 0) return;
        const nodeId = active.dataset?.id;
        if (!nodeId || activeGroupId === RECENT_GROUP_ID) return;
        e.preventDefault();
        deleteNodes([nodeId]);
        // 删除后把焦点移到同位置的下一个卡片，漫游不中断
        tiles[Math.min(idx, tiles.length - 1)]?.focus?.();
        return;
      }

      if (!tiles.length) return;
      const gridCols =
        typeof getComputedStyle !== "undefined"
          ? getComputedStyle(grid).gridTemplateColumns?.split(" ").length || 1
          : 1;
      const cols = Math.max(1, Number.parseInt(gridCols, 10) || 1);
      const idx = tiles.indexOf(doc.activeElement);
      const next = nextGridFocusIndex({ index: idx, columns: cols, count: tiles.length, key: e.key });
      if (next >= 0 && tiles[next]) {
        tiles[next].focus?.();
        e.preventDefault();
      }
    }
  }

  function bind(target = doc) {
    if (!target) return () => {};
    const listener = (e) => handleKeydown(e);
    target.addEventListener("keydown", listener);
    return () => target.removeEventListener("keydown", listener);
  }

  return {
    handleKeydown,
    bind,
  };
}
