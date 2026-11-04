/**
 * 核心视图渲染协调器（view-renderer）。
 * 内聚主界面渲染流水线：全量书签虚拟分组校正、静态多语言文案同步、侧栏分组渲染、
 * 网格布局与空态刷新、工具栏与选择控制器更新、以及主题/密度/背景等副作用设置收口。
 */

/**
 * 创建核心视图渲染协调器实例。
 *
 * @param {Object} options
 * @param {function(): Object} options.getData 获取最新主页数据
 * @param {function(): Object} options.getElements 获取 DOM 元素集合
 * @param {function(Object): void} [options.ensureAllBookmarksGroup] 确保全量书签虚拟根分组存在
 * @param {function(): void} [options.applyStaticI18n] 静态多语言文案注入
 * @param {function(): Object} [options.getSidebarMgr] 获取侧边栏管理器
 * @param {function(): Object} [options.getGridRenderer] 获取网格渲染器
 * @param {function(): Object} [options.getOpenModeMgr] 获取卡片打开方式管理器
 * @param {function(): Object} [options.getSelectionMgr] 获取批量选择管理器
 * @param {function(): Object} [options.getThemeMgr] 获取主题与背景管理器
 * @returns {{ render: function(): void }}
 */
export function createViewRenderer({
  getData,
  getElements,
  ensureAllBookmarksGroup,
  applyStaticI18n,
  getSidebarMgr,
  getGridRenderer,
  getOpenModeMgr,
  getSelectionMgr,
  getThemeMgr,
}) {
  function render() {
    const data = typeof getData === "function" ? getData() : null;
    const elements = typeof getElements === "function" ? getElements() : null;

    if (data && typeof ensureAllBookmarksGroup === "function") {
      ensureAllBookmarksGroup(data);
    }

    if (typeof applyStaticI18n === "function") {
      applyStaticI18n();
    }

    const sidebarMgr = typeof getSidebarMgr === "function" ? getSidebarMgr() : null;
    sidebarMgr?.applySidebarState?.();
    sidebarMgr?.renderGroups?.();

    const gridRenderer = typeof getGridRenderer === "function" ? getGridRenderer() : null;
    gridRenderer?.renderGrid?.();
    gridRenderer?.updateEmptyState?.();

    if (elements?.topSearchWrap && data?.settings) {
      elements.topSearchWrap.classList.toggle("hidden", !data.settings.showSearch);
    }

    if (elements?.emptyHintToggle && data?.settings) {
      elements.emptyHintToggle.checked = !!data.settings.emptyHintDisabled;
    }

    if (elements?.btnFolderDissolve) {
      elements.btnFolderDissolve.classList.remove("hidden");
    }

    const openModeMgr = typeof getOpenModeMgr === "function" ? getOpenModeMgr() : null;
    openModeMgr?.updateToolbarButton?.();

    const selectionMgr = typeof getSelectionMgr === "function" ? getSelectionMgr() : null;
    selectionMgr?.updateControls?.();

    // 收口在这里：主题/密度/背景都是「副作用型」设置，不经过普通渲染流水线。
    // 导入、恢复备份、清空数据、同步合并、跨标签页重载最终都会走到 render()，
    // 统一在这里重新应用，避免设置已变更但页面不生效的问题。
    const themeMgr = typeof getThemeMgr === "function" ? getThemeMgr() : null;
    themeMgr?.applyThemeAndDensity?.();
    void themeMgr?.refreshBackgroundIfChanged?.();
  }

  return {
    render,
  };
}
