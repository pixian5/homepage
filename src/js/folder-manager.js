/**
 * 文件夹覆盖层管理器（从 app.js 拆出，解耦第九阶段）。
 *
 * 职责：文件夹覆盖层生命周期（展开/嵌套后退/关闭、inert 与 aria 状态、
 * 标题与焦点管理）、文件夹重命名（字段时钟）、解散文件夹（子项原位回填）。
 * openFolderId 的真值仍由宿主持有（大量视图依赖），本模块经 getState/setState 读写。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

var HomepageFolderManager = (() => {
  /**
   * @param {{
   *   getElements: () => { folderOverlay: HTMLElement, folderTitle: HTMLElement, folderGrid: HTMLElement,
   *     btnCloseFolder: HTMLElement, btnFolderDissolve: HTMLElement, btnSettings?: HTMLElement },
   *   getData: () => object,
   *   getOpenFolderId: () => string|null,
   *   setOpenFolderId: (id: string|null) => void,
   *   getActiveGroup: () => object,
   *   getPlacementList: (container: object) => string[],
   *   setPlacementList: (container: object, list: string[]) => void,
   *   touchPlacementContainer: (container: object) => void,
   *   markNodeDeleted: (data: object, id: string, deletedAt?: number) => void,
   *   stampNodeFieldChanges: (node: object, changes: object) => void,
   *   pushBackup: () => void,
   *   queuePersist: () => void,
   *   render: () => void,
   *   toast: (message: string, kind?: string) => void,
   *   t: (key: string, vars?: object) => string,
   *   getActiveElement: () => Element|null,
   * }} deps
   */
  function createFolderManager(deps) {
    const isFolderOpen = () => !!deps.getOpenFolderId();
    const getOpenFolderId = () => deps.getOpenFolderId();

    /** 展开覆盖层：解除 inert、更新标题、渲染并聚焦网格 */
    function openFolder(folderId) {
      deps.setOpenFolderId(folderId);
      const elements = deps.getElements();
      elements.folderOverlay.removeAttribute("inert");
      elements.folderOverlay.classList.remove("hidden");
      elements.folderOverlay.setAttribute("aria-hidden", "false");
      const folder = deps.getData()?.nodes?.[folderId];
      elements.folderTitle.textContent = folder?.title || deps.t("folder.defaultTitle");
      deps.render();
      elements.folderGrid.focus({ preventScroll: true });
    }

    /** 查找直接包含该文件夹的父文件夹（不含当前分组根，用于嵌套后退） */
    function findParentFolderId(folderId) {
      if (!folderId) return "";
      const data = deps.getData();
      const activeGroupId = data?.groups?.find((group) => group?.id && group.nodes?.includes?.(folderId))?.id || "";
      for (const node of Object.values(data?.nodes || {})) {
        if (node.type !== "folder" || !Array.isArray(node.children)) continue;
        if (node.id === activeGroupId) continue;
        if (node.children.includes(folderId)) {
          return node.id;
        }
      }
      return "";
    }

    /**
     * 关闭覆盖层：嵌套文件夹先回退到父级；到顶层则隐藏、
     * 焦点若在覆盖层内则还给设置按钮（键盘漫游不中断）。
     */
    function closeFolder() {
      const elements = deps.getElements();
      const currentId = deps.getOpenFolderId();
      const parentId = findParentFolderId(currentId);
      if (parentId) {
        deps.setOpenFolderId(parentId);
        const parent = deps.getData()?.nodes?.[parentId];
        elements.folderTitle.textContent = parent?.title || deps.t("folder.defaultTitle");
        deps.render();
        return;
      }
      deps.setOpenFolderId(null);
      const activeEl = deps.getActiveElement();
      if (activeEl && elements.folderOverlay.contains(activeEl)) {
        elements.btnSettings?.focus?.({ preventScroll: true });
      }
      elements.folderOverlay.setAttribute("inert", "");
      elements.folderOverlay.classList.add("hidden");
      elements.folderOverlay.setAttribute("aria-hidden", "true");
      deps.render();
    }

    /**
     * 重命名文件夹：校验（存在、类型、非空、有变化）后更新标题并推进字段时钟。
     * @returns {boolean} 是否发生了修改
     */
    function renameFolder(folderId, newTitle) {
      const data = deps.getData();
      const folder = data?.nodes?.[folderId];
      if (folder?.type !== "folder") return false;
      const nextTitle = String(newTitle ?? "").trim();
      if (!nextTitle || nextTitle === folder.title) return false;
      deps.stampNodeFieldChanges(folder, { titleChanged: true });
      folder.title = nextTitle;
      deps.queuePersist();
      deps.render();
      return true;
    }

    /**
     * 解散文件夹：子节点依序平铺回父容器原位置（分组根 → 父文件夹 → 活动分组兜底），
     * 随后删除该 folder 节点并持久化。
     */
    function dismissFolder(folderId) {
      const data = deps.getData();
      const folder = data?.nodes?.[folderId];
      if (folder?.type !== "folder") return false;
      const children = Array.isArray(folder.children) ? folder.children.slice() : [];
      deps.pushBackup();
      let replaced = false;
      for (const group of data.groups) {
        const idx = group.nodes.indexOf(folderId);
        if (idx < 0) continue;
        group.nodes.splice(idx, 1, ...children);
        deps.touchPlacementContainer(group);
        replaced = true;
        break;
      }
      if (!replaced) {
        for (const node of Object.values(data.nodes)) {
          if (node.type !== "folder" || !Array.isArray(node.children)) continue;
          const idx = node.children.indexOf(folderId);
          if (idx < 0) continue;
          node.children.splice(idx, 1, ...children);
          deps.touchPlacementContainer(node);
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        const group = deps.getActiveGroup();
        const list = deps.getPlacementList(group);
        list.push(...children);
        deps.setPlacementList(group, list);
        deps.touchPlacementContainer(group);
      }
      deps.markNodeDeleted(data, folderId);
      deps.queuePersist();
      deps.render();
      deps.toast(deps.t("folder.dissolved"));
      return true;
    }

    /** 绑定覆盖层事件：返回按钮 / 解散按钮 / 点击空白关闭 */
    function bindOverlayEvents() {
      const elements = deps.getElements();
      elements.btnCloseFolder.addEventListener("click", () => closeFolder());
      elements.btnFolderDissolve.addEventListener("click", () => {
        const folderId = deps.getOpenFolderId();
        if (!folderId) return;
        closeFolder();
        dismissFolder(folderId);
      });
      elements.folderOverlay.addEventListener("click", (e) => {
        if (e.target.closest?.(".tile")) return;
        if (e.target.closest?.(".overlay-header")) return;
        closeFolder();
      });
    }

    return {
      openFolder,
      closeFolder,
      isFolderOpen,
      getOpenFolderId,
      findParentFolderId,
      renameFolder,
      dismissFolder,
      bindOverlayEvents,
    };
  }

  return { createFolderManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createFolderManager = HomepageFolderManager.createFolderManager;
