/**
 * 侧边栏管理器（从 app.js 拆出，解耦第八阶段）。
 *
 * 职责：侧边栏（历史入口、全部书签、根文件夹分组 Tab）的完整渲染、
 * 折叠/隐藏状态机、折叠态下按钮的 aria-label 与 data-label 同步、切组交互。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

var HomepageSidebarManager = (() => {
  /**
   * @param {{
   *   getElements: () => { groupTabs: HTMLElement, recentTab: HTMLElement, btnToggleSidebar: HTMLElement|null },
   *   getData: () => object,
   *   getState: () => { activeGroupId: string, openFolderId: string|null },
   *   setActiveGroup: (groupId: string) => void,
   *   closeFolder: () => void,
   *   persist: () => void,
   *   render: () => void,
   *   t: (key: string, vars?: object) => string,
   *   isRecentGroup: (groupId: string) => boolean,
   *   isAllBookmarksGroup: (group: object) => boolean,
   *   isClickSuppressed: () => boolean,
   *   bindSidebarFolderEvents: (btn: HTMLElement, opts: object) => void,
   *   bindGroupTouchEvents: (btn: HTMLElement, opts: object) => void,
   *   openGroupContextMenu: (x: number, y: number, group: object) => void,
   *   qsa: (selector: string, root?: HTMLElement) => Array<HTMLElement>,
   *   getDocumentBody: () => HTMLElement,
   *   createButton?: () => HTMLElement,
   * }} deps
   */
  function createSidebarManager(deps) {
    const qsa = deps.qsa;
    const createButton = deps.createButton || (() => document.createElement("button"));

    /** 折叠/隐藏状态机：body 类名 + 折叠按钮文案 + 标签同步 */
    function applySidebarState() {
      const settings = deps.getData()?.settings || {};
      deps.getDocumentBody().classList.toggle("sidebar-collapsed", !!settings.sidebarCollapsed);
      deps.getDocumentBody().classList.toggle("sidebar-hidden", !!settings.sidebarHidden);
      const toggleBtn = deps.getElements().btnToggleSidebar;
      if (toggleBtn) {
        toggleBtn.textContent = settings.sidebarCollapsed ? deps.t("sidebar.expand") : deps.t("sidebar.collapse");
      }
      syncSidebarTabLabels();
    }

    /** 折叠与展开状态下同步分组按钮的 aria-label 与 data-label（折叠时文本清空保留可读名） */
    function syncSidebarTabLabels() {
      const elements = deps.getElements();
      if (!elements.recentTab) return;
      const collapsed = !!deps.getData()?.settings?.sidebarCollapsed;
      const recentLabel =
        elements.recentTab.dataset.label || elements.recentTab.textContent || deps.t("sidebar.history");
      elements.recentTab.dataset.label = recentLabel;
      elements.recentTab.setAttribute("aria-label", recentLabel);
      elements.recentTab.textContent = collapsed ? "" : recentLabel;
      for (const btn of qsa(".group-tab", elements.groupTabs)) {
        const label = btn.dataset.label || btn.textContent || "";
        btn.dataset.label = label;
        btn.setAttribute("aria-label", label || deps.t("sidebar.addGroup"));
        btn.textContent = collapsed ? "" : label;
      }
    }

    /**
     * 渲染侧栏分组 Tab：全部书签（固定根）+ 根目录下的顶层文件夹分组，
     * 高亮当前激活分组，绑定点击切组 / 右键菜单 / 投放 / 触摸长按。
     */
    function renderGroups() {
      const data = deps.getData();
      const elements = deps.getElements();
      const { activeGroupId } = deps.getState();
      elements.groupTabs.replaceChildren();
      elements.recentTab.classList.toggle("active", deps.isRecentGroup(activeGroupId));
      const recentLabel =
        elements.recentTab.dataset.label || elements.recentTab.textContent || deps.t("sidebar.history");
      elements.recentTab.dataset.label = recentLabel;
      elements.recentTab.setAttribute("aria-label", recentLabel);
      elements.recentTab.textContent = data.settings?.sidebarCollapsed ? "" : recentLabel;
      elements.recentTab.dataset.short = deps.t("sidebar.history");

      const root = data.groups.find((group) => deps.isAllBookmarksGroup(group)) || data.groups[0];
      const sidebarEntries = [
        root,
        ...(root?.nodes || []).map((id) => data.nodes[id]).filter((node) => node?.type === "folder"),
      ].filter(Boolean);
      sidebarEntries.forEach((group, idx) => {
        const fixedAllGroup = deps.isAllBookmarksGroup(group);
        const btn = createButton();
        btn.className = `group-tab${fixedAllGroup ? "" : " draggable"} ${group.id === activeGroupId ? "active" : ""}`;
        const label = fixedAllGroup ? group.name : group.title;
        btn.dataset.label = label;
        btn.setAttribute("aria-label", label);
        btn.textContent = data.settings?.sidebarCollapsed ? "" : label;
        btn.dataset.short = String(idx + 1);
        btn.dataset.groupId = group.id;
        btn.draggable = !fixedAllGroup;
        btn.addEventListener("click", (e) => {
          if (deps.isClickSuppressed()) {
            e.preventDefault();
            return;
          }
          deps.setActiveGroup(group.id);
          deps.closeFolder();
          deps.getData().settings.lastActiveGroupId = group.id;
          deps.persist();
          deps.render();
        });
        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          if (!fixedAllGroup) deps.openGroupContextMenu(e.clientX, e.clientY, group);
        });
        // 侧栏分组的卡片投放与分组拖拽排序（drag-manager / touch-drag-manager）
        deps.bindSidebarFolderEvents(btn, { groupId: group.id, fixedAllGroup });
        deps.bindGroupTouchEvents(btn, { groupId: group.id, disabled: fixedAllGroup });
        elements.groupTabs.appendChild(btn);
      });
    }

    return { applySidebarState, syncSidebarTabLabels, renderGroups };
  }

  return { createSidebarManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createSidebarManager = HomepageSidebarManager.createSidebarManager;
