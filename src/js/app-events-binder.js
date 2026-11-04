/**
 * 顶层 DOM 事件装配器（app-events-binder）。
 * 内聚应用全局与页面级 DOM 交互事件绑定（窗口调整、侧边栏折叠、分组新建、历史分组切换、
 * 批量选择、打开方式、模态弹窗遮罩交互、全局右键菜单关闭、悬停提示与拖拽投放）。
 */

/**
 * 绑定应用所有全局与页面级 DOM 交互事件。
 *
 * @param {Object} options
 * @param {Object} options.elements DOM 元素集合
 * @param {function(): Object} options.getData 获取最新主页数据
 * @param {function(): { activeGroupId: string, openFolderId: string|null, settingsOpen: boolean }} options.getState
 * @param {function(Object): void} options.setState 更新外部状态
 * @param {Object} options.actions 业务行为回调集合
 * @param {Object} options.managers 各子系统管理器集合
 * @param {Object} options.constants 常量集合
 * @param {function(string): string} options.t 国际化文案翻译
 * @param {function(function): function} [options.rafThrottle] 帧节流函数
 * @param {Object} [options.win] 窗口对象，默认 window
 * @param {Object} [options.doc] 文档对象，默认 document
 * @returns {{ resetModalPointerOrigin: function(): void }}
 */
export function bindAppDomEvents({
  elements,
  getData,
  getState,
  setState,
  actions,
  managers,
  constants,
  t,
  rafThrottle = (fn) => fn,
  win = typeof window !== "undefined" ? window : null,
  doc = typeof document !== "undefined" ? document : null,
}) {
  let modalPointerDownInsideDialog = false;

  const throttle = typeof rafThrottle === "function" ? rafThrottle : (fn) => fn;

  if (win && typeof win.addEventListener === "function") {
    win.addEventListener(
      "resize",
      throttle(() => actions?.render?.()),
    );
  }

  elements?.btnAdd?.addEventListener?.("click", () => actions?.openAddModal?.());
  elements?.btnFolderAdd?.addEventListener?.("click", () => actions?.openAddModal?.());

  elements?.btnToggleSidebar?.addEventListener?.("click", () => {
    const data = getData?.();
    if (data?.settings) {
      data.settings.sidebarCollapsed = !data.settings.sidebarCollapsed;
      managers?.sidebarMgr?.applySidebarState?.();
      actions?.queuePersist?.();
    }
  });

  elements?.recentTab?.addEventListener?.("click", async () => {
    const data = getData?.();
    const recentGroupId = constants?.recentGroupId || "__recent__";
    setState?.({ activeGroupId: recentGroupId, openFolderId: null });
    if (data?.settings) {
      data.settings.lastActiveGroupId = recentGroupId;
    }
    actions?.queuePersist?.();
    if (typeof actions?.fetchRecentHistory === "function") {
      const items = await actions.fetchRecentHistory();
      actions?.setRecentItems?.(items);
    }
    actions?.render?.();
  });

  elements?.btnAddGroup?.addEventListener?.("click", () => {
    const data = getData?.();
    if (!data?.nodes) return;
    const folderId = `fld_${Date.now()}`;
    const createdAt = Date.now();
    data.nodes[folderId] = {
      id: folderId,
      type: "folder",
      title: typeof t === "function" ? t("group.new") : "New Group",
      children: [],
      createdAt,
      updatedAt: createdAt,
      titleUpdatedAt: createdAt,
    };
    const root = typeof actions?.getRootGroup === "function" ? actions.getRootGroup() : null;
    if (root?.nodes) {
      root.nodes.push(folderId);
      actions?.touchPlacementContainer?.(root);
    }
    setState?.({ activeGroupId: folderId });
    if (data?.settings) {
      data.settings.lastActiveGroupId = folderId;
    }
    actions?.queuePersist?.();
    actions?.render?.();
  });

  managers?.selectionMgr?.bindBatchButtons?.();
  managers?.selectionMgr?.bindBoxSelectEvents?.();
  managers?.selectionMgr?.bindBlankClickClear?.();

  managers?.openModeMgr?.bindButton?.();

  elements?.btnSettings?.addEventListener?.("click", async () => {
    const state = getState?.();
    if (state?.settingsOpen) {
      actions?.closeModal?.();
      return;
    }
    actions?.openSettingsModal?.();
  });

  managers?.searchManager?.bind?.();

  elements?.emptyHintToggle?.addEventListener?.("change", async (e) => {
    const data = getData?.();
    if (data?.settings) {
      data.settings.emptyHintDisabled = !!e.target?.checked;
      await actions?.persistData?.();
      actions?.render?.();
    }
  });

  managers?.folderMgr?.bindOverlayEvents?.();

  if (elements?.modalOverlay) {
    elements.modalOverlay.addEventListener("click", async (e) => {
      if (e.target !== elements.modalOverlay) return;
      if (modalPointerDownInsideDialog) {
        modalPointerDownInsideDialog = false;
        return;
      }
      actions?.closeModal?.();
    });

    const markModalPointerOrigin = (e) => {
      modalPointerDownInsideDialog = !!e.target?.closest?.("#modal");
    };
    elements.modalOverlay.addEventListener("mousedown", markModalPointerOrigin);
    elements.modalOverlay.addEventListener("pointerdown", markModalPointerOrigin);
  }

  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("click", (e) => {
      if (!elements?.contextMenu?.contains?.(e.target)) {
        actions?.closeContextMenu?.();
      }
    });

    doc.addEventListener(
      "mousemove",
      throttle((e) => {
        if (elements?.tooltip && !elements.tooltip.classList?.contains?.("hidden")) {
          elements.tooltip.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY + 12}px, 0)`;
        }
      }),
    );

    doc.addEventListener("mouseover", (e) => {
      const target = e.target?.closest?.("[data-tooltip]");
      if (!target) return;
      const text = target.getAttribute?.("data-tooltip");
      if (text) {
        actions?.showTooltip?.(text, e.clientX, e.clientY);
      }
    });

    doc.addEventListener("mouseout", (e) => {
      const target = e.target?.closest?.("[data-tooltip]");
      if (!target) return;
      actions?.hideTooltip?.();
    });
  }

  managers?.keyboardNav?.bind?.();
  managers?.touchDrag?.bindDocumentTouchEvents?.();

  if (elements?.grid && managers?.dragManager) {
    managers.dragManager.bindGridDropEvents(elements.grid, {
      getContainer: () => actions?.getActiveGroup?.(),
      enabled: () => {
        const state = getState?.();
        const recentGroupId = constants?.recentGroupId || "__recent__";
        return !state?.openFolderId && state?.activeGroupId !== recentGroupId;
      },
    });
  }

  if (elements?.folderGrid && managers?.dragManager) {
    managers.dragManager.bindGridDropEvents(elements.folderGrid, {
      getContainer: () => {
        const state = getState?.();
        return actions?.getFolderPlacementContainer?.(state?.openFolderId);
      },
      enabled: () => {
        const state = getState?.();
        return !!state?.openFolderId;
      },
    });
  }

  if (elements?.groupTabs && managers?.dragManager) {
    managers.dragManager.bindGroupTabsEvents(elements.groupTabs);
  }

  return {
    resetModalPointerOrigin: () => {
      modalPointerDownInsideDialog = false;
    },
  };
}
