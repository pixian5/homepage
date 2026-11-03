/**
 * 触摸拖拽状态机（从 app.js 拆出，解耦第五阶段）。
 *
 * 职责：移动端长按（分组 260ms / 卡片 3000ms）激活拖拽、拖动中的元素拾取
 * （elementFromPoint）与悬停高亮、松手分发 drop 意图、长按 1s 上下文菜单、
 * 拖拽后的点击抑制（防止松手误触打开卡片）。与 drag-manager.js 通过
 * setDragState / cleanupDragState 等接口深度联动。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

var HomepageTouchDragManager = (() => {
  /** 触摸长按出上下文菜单的时长 */
  const TILE_CONTEXT_MENU_MS = 1000;
  /** 卡片长按激活拖拽的时长（远大于菜单：先出菜单，继续按住才进入拖拽） */
  const TILE_LONG_PRESS_MS = 3000;
  /** 分组长按激活拖拽排序的时长 */
  const GROUP_LONG_PRESS_MS = 260;
  /** 长按等待期内移动超过该距离视为滑动，取消长按 */
  const DRAG_MOVE_THRESHOLD = 18;
  /** 拖拽结束后抑制点击的时长（防止松手误触打开卡片） */
  const CLICK_SUPPRESS_MS = 400;

  /**
   * @param {{
   *   dragManager: {
   *     setDragState: (state: object|null) => void,
   *     setDraggingGroupId: (id: string|null) => void,
   *     cleanupDragState: () => void,
   *     getDropIndex: (grid: HTMLElement, x: number, y: number) => number,
   *     dropOnTile: (targetId: string, x: number, y: number) => void,
   *     moveDraggedNodeToSidebarFolder: (nodeId: string, folderId: string) => boolean,
   *     moveGroupBefore: (sourceId: string, targetId: string) => void,
   *   },
   *   getState: () => { activeGroupId: string, openFolderId: string|null },
   *   getGrid: (inFolder: boolean) => HTMLElement,
   *   getContainer: () => object,
   *   getPlacementList: (container: object) => string[],
   *   setPlacementList: (container: object, list: string[]) => void,
   *   touchPlacementContainer: (container: object) => void,
   *   moveNodeInList: (list: string[], id: string, index: number) => string[],
   *   moveGroupToIndex: (groupId: string, index: number) => void,
   *   getRootFolderIds: () => string[],
   *   getGroupTabs: () => HTMLElement,
   *   queuePersist: () => void,
   *   render: () => void,
   *   openContextMenu: (x: number, y: number, node: object) => void,
   *   closeContextMenu: () => void,
   *   isRecentGroup: (groupId: string) => boolean,
   *   canStartTileTouch?: () => boolean,
   * }} deps
   */
  function createTouchDragManager(deps) {
    const drag = deps.dragManager;

    const touchDragState = {
      mode: "",
      timer: null,
      active: false,
      sourceId: "",
      sourceTile: null,
      targetTile: null,
      sourceGroupId: "",
      sourceGroupBtn: null,
      targetGroupBtn: null,
      startX: 0,
      startY: 0,
      x: 0,
      y: 0,
    };
    const touchMenuState = {
      timer: null,
      active: false,
      node: null,
      startX: 0,
      startY: 0,
      x: 0,
      y: 0,
    };
    let suppressClickUntil = 0;

    function clearTouchDragTimer() {
      if (!touchDragState.timer) return;
      clearTimeout(touchDragState.timer);
      touchDragState.timer = null;
    }

    function clearTouchMenuTimer() {
      if (!touchMenuState.timer) return;
      clearTimeout(touchMenuState.timer);
      touchMenuState.timer = null;
    }

    function resetTouchMenuState() {
      clearTouchMenuTimer();
      touchMenuState.active = false;
      touchMenuState.node = null;
      touchMenuState.startX = 0;
      touchMenuState.startY = 0;
      touchMenuState.x = 0;
      touchMenuState.y = 0;
    }

    function clearTouchDragVisual() {
      if (touchDragState.sourceTile) {
        touchDragState.sourceTile.classList.remove("touch-dragging");
        touchDragState.sourceTile.style.transform = "";
        touchDragState.sourceTile.style.pointerEvents = "";
        touchDragState.sourceTile.style.zIndex = "";
        touchDragState.sourceTile.style.willChange = "";
      }
      if (touchDragState.targetTile) {
        touchDragState.targetTile.classList.remove("touch-drop-target");
      }
      if (touchDragState.sourceGroupBtn) {
        touchDragState.sourceGroupBtn.classList.remove("dragging");
      }
      if (touchDragState.targetGroupBtn) {
        touchDragState.targetGroupBtn.classList.remove("drop-target");
      }
      for (const el of deps.getGroupTabs()?.querySelectorAll?.(".group-tab") || []) {
        el.classList.remove("drop-target");
      }
      document.body.classList.remove("touch-dragging");
    }

    function resetTouchDragState() {
      clearTouchDragTimer();
      clearTouchDragVisual();
      resetTouchMenuState();
      touchDragState.mode = "";
      touchDragState.active = false;
      touchDragState.sourceId = "";
      touchDragState.sourceTile = null;
      touchDragState.targetTile = null;
      touchDragState.sourceGroupId = "";
      touchDragState.sourceGroupBtn = null;
      touchDragState.targetGroupBtn = null;
      drag.cleanupDragState();
    }

    /** 卡片按下：先启动长按拖拽计时（内部会重置全部状态），再挂 1s 上下文菜单计时 */
    function bindTileTouchEvents(tile, node) {
      tile.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length !== 1) return;
          // 选择模式与历史分组（只读）不进入触摸长按
          if (deps.canStartTileTouch && !deps.canStartTileTouch()) return;
          const touch = e.touches[0];
          // 顺序关键：beginLongPress 内部会重置菜单状态，必须先执行
          beginLongPress("tile", node.id, tile, touch.clientX, touch.clientY);
          touchMenuState.node = node;
          touchMenuState.startX = touch.clientX;
          touchMenuState.startY = touch.clientY;
          touchMenuState.x = touch.clientX;
          touchMenuState.y = touch.clientY;
          touchMenuState.timer = setTimeout(() => {
            if (touchDragState.active || !touchMenuState.node) return;
            touchMenuState.active = true;
            clearTouchMenuTimer();
            deps.openContextMenu(touchMenuState.x, touchMenuState.y, touchMenuState.node);
          }, TILE_CONTEXT_MENU_MS);
        },
        { passive: true },
      );
    }

    /** 侧栏分组按下：短长按即可拖拽排序 */
    function bindGroupTouchEvents(btn, { groupId, disabled = false }) {
      btn.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length !== 1 || disabled) return;
          const touch = e.touches[0];
          beginLongPress("group", groupId, btn, touch.clientX, touch.clientY);
        },
        { passive: true },
      );
    }

    function beginLongPress(mode, sourceId, sourceEl, x, y) {
      resetTouchDragState();
      touchDragState.mode = mode;
      if (mode === "tile") {
        touchDragState.sourceId = sourceId;
        touchDragState.sourceTile = sourceEl;
      } else {
        touchDragState.sourceGroupId = sourceId;
        touchDragState.sourceGroupBtn = sourceEl;
      }
      touchDragState.startX = x;
      touchDragState.startY = y;
      touchDragState.x = x;
      touchDragState.y = y;
      const pressMs = mode === "tile" ? TILE_LONG_PRESS_MS : GROUP_LONG_PRESS_MS;
      touchDragState.timer = setTimeout(() => {
        activate();
      }, pressMs);
    }

    function activate() {
      if (!touchDragState.mode) return;
      touchDragState.active = true;
      clearTouchDragTimer();
      if (touchDragState.mode === "tile") {
        if (touchMenuState.active) deps.closeContextMenu();
        resetTouchMenuState();
        drag.setDragState({ id: touchDragState.sourceId, fromFolder: deps.getState().openFolderId });
        if (touchDragState.sourceTile) {
          touchDragState.sourceTile.classList.add("touch-dragging");
          touchDragState.sourceTile.style.pointerEvents = "none";
          touchDragState.sourceTile.style.zIndex = "80";
          touchDragState.sourceTile.style.willChange = "transform";
          syncSourcePosition(touchDragState.x, touchDragState.y);
        }
        touchDragState.targetTile = null;
      } else if (touchDragState.mode === "group") {
        drag.setDraggingGroupId(touchDragState.sourceGroupId);
        touchDragState.sourceGroupBtn?.classList.add("dragging");
        touchDragState.targetGroupBtn = null;
      }
      document.body.classList.add("touch-dragging");
    }

    /** 拖拽中的源卡片跟随手指（位移 transform，不触发布局） */
    function syncSourcePosition(x, y) {
      const tile = touchDragState.sourceTile;
      if (!tile) return;
      const dx = Math.round(x - touchDragState.startX);
      const dy = Math.round(y - touchDragState.startY);
      tile.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    /** 拖动中：elementFromPoint 拾取悬停目标并维护高亮 */
    function updateTarget(x, y) {
      if (!touchDragState.active) return;
      touchDragState.x = x;
      touchDragState.y = y;
      const pointEl = document.elementFromPoint(x, y) || null;
      if (touchDragState.mode === "tile") {
        syncSourcePosition(x, y);
        const hoverTile = pointEl?.closest?.(".tile") || null;
        const nextTile = hoverTile && hoverTile.dataset.id !== touchDragState.sourceId ? hoverTile : null;
        if (touchDragState.targetTile && touchDragState.targetTile !== nextTile) {
          touchDragState.targetTile.classList.remove("touch-drop-target");
        }
        if (nextTile && nextTile !== touchDragState.targetTile) {
          nextTile.classList.add("touch-drop-target");
        }
        touchDragState.targetTile = nextTile;
        const hoverGroup = pointEl?.closest?.(".group-tab.draggable") || null;
        if (touchDragState.targetGroupBtn && touchDragState.targetGroupBtn !== hoverGroup) {
          touchDragState.targetGroupBtn.classList.remove("drop-target");
        }
        if (hoverGroup && hoverGroup !== touchDragState.targetGroupBtn) hoverGroup.classList.add("drop-target");
        touchDragState.targetGroupBtn = hoverGroup;
        return;
      }
      if (touchDragState.mode === "group") {
        const hoverGroup = pointEl?.closest?.(".group-tab.draggable") || null;
        const nextTarget =
          hoverGroup && hoverGroup.dataset.groupId !== touchDragState.sourceGroupId ? hoverGroup : null;
        if (touchDragState.targetGroupBtn && touchDragState.targetGroupBtn !== nextTarget) {
          touchDragState.targetGroupBtn.classList.remove("drop-target");
        }
        if (nextTarget && nextTarget !== touchDragState.targetGroupBtn) {
          nextTarget.classList.add("drop-target");
        }
        touchDragState.targetGroupBtn = nextTarget;
      }
    }

    /** 松手：按悬停目标分发 drop 意图（侧栏文件夹 / 卡片 / 空白区排序） */
    function finish() {
      if (!touchDragState.active) return false;
      const state = deps.getState();
      if (touchDragState.mode === "tile") {
        const sourceId = touchDragState.sourceId;
        const targetId = touchDragState.targetTile?.dataset?.id || "";
        const x = touchDragState.x;
        const y = touchDragState.y;

        const targetFolderId = touchDragState.targetGroupBtn?.dataset?.groupId || "";
        if (targetFolderId) {
          drag.moveDraggedNodeToSidebarFolder(sourceId, targetFolderId);
        } else if (targetId && targetId !== sourceId) {
          drag.dropOnTile(targetId, x, y);
        } else if (!deps.isRecentGroup(state.activeGroupId)) {
          const inFolder = !!state.openFolderId;
          const container = deps.getContainer();
          const list = deps.getPlacementList(container);
          const grid = deps.getGrid(inFolder);
          const next = deps.moveNodeInList(list, sourceId, drag.getDropIndex(grid, x, y));
          if (next !== list) {
            deps.setPlacementList(container, next);
            deps.touchPlacementContainer(container);
            deps.queuePersist();
            deps.render();
          }
        }
      } else if (touchDragState.mode === "group") {
        const sourceId = touchDragState.sourceGroupId;
        const targetId = touchDragState.targetGroupBtn?.dataset?.groupId || "";
        if (targetId && targetId !== sourceId) {
          drag.moveGroupBefore(sourceId, targetId);
        } else {
          const rect = deps.getGroupTabs()?.getBoundingClientRect?.();
          if (rect) {
            const total = deps.getRootFolderIds().length;
            if (touchDragState.y < rect.top + 24) deps.moveGroupToIndex(sourceId, 0);
            else if (touchDragState.y > rect.bottom - 24) deps.moveGroupToIndex(sourceId, total);
          }
        }
      }

      suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
      resetTouchDragState();
      return true;
    }

    /** 全局触摸监听（touchmove / touchend / touchcancel），init 时绑定一次 */
    function bindDocumentTouchEvents() {
      document.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches.length !== 1) return;
          const touch = e.touches[0];
          if (!touchDragState.active && touchMenuState.timer) {
            touchMenuState.x = touch.clientX;
            touchMenuState.y = touch.clientY;
            const moved = Math.hypot(touch.clientX - touchMenuState.startX, touch.clientY - touchMenuState.startY);
            if (moved > DRAG_MOVE_THRESHOLD) {
              resetTouchMenuState();
              clearTouchDragTimer();
            }
          }
          if (touchMenuState.active && !touchDragState.active) {
            e.preventDefault();
            return;
          }
          if (!touchDragState.active && touchDragState.timer) {
            const moved = Math.hypot(touch.clientX - touchDragState.startX, touch.clientY - touchDragState.startY);
            if (moved > DRAG_MOVE_THRESHOLD) {
              clearTouchDragTimer();
              resetTouchMenuState();
            }
            return;
          }
          if (!touchDragState.active) return;
          e.preventDefault();
          updateTarget(touch.clientX, touch.clientY);
        },
        { passive: false },
      );

      document.addEventListener(
        "touchend",
        (e) => {
          if (touchMenuState.timer && !touchMenuState.active) {
            resetTouchMenuState();
          }
          if (touchMenuState.active && !touchDragState.active) {
            e.preventDefault();
            suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
            resetTouchMenuState();
            clearTouchDragTimer();
            return;
          }
          if (touchDragState.timer && !touchDragState.active) {
            clearTouchDragTimer();
            return;
          }
          if (!touchDragState.active) return;
          const touch = e.changedTouches?.[0];
          if (touch) {
            updateTarget(touch.clientX, touch.clientY);
          }
          e.preventDefault();
          finish();
        },
        { passive: false },
      );

      document.addEventListener(
        "touchcancel",
        () => {
          resetTouchDragState();
        },
        { passive: true },
      );
    }

    return {
      bindTileTouchEvents,
      bindGroupTouchEvents,
      bindDocumentTouchEvents,
      finish,
      reset: resetTouchDragState,
      isClickSuppressed: () => Date.now() < suppressClickUntil,
      get isActive() {
        return touchDragState.active;
      },
      get mode() {
        return touchDragState.mode;
      },
    };
  }

  return { createTouchDragManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createTouchDragManager = HomepageTouchDragManager.createTouchDragManager;
