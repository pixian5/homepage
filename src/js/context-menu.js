/**
 * 上下文右键菜单管理器
 * 负责卡片/文件夹/历史项以及分组的右键菜单定位、溢出修正与动作分发
 */

import { RECENT_GROUP_ID } from "./shared-utils.js";

/**
 * 计算菜单在视口内的安全坐标，防止贴边溢出
 * @param {HTMLElement} menu
 * @param {number} x
 * @param {number} y
 * @param {number} edgeGap
 */
export function positionMenuAt(menu, x, y, edgeGap = 8) {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  menu.classList.remove("hidden");
  menu.style.visibility = "hidden";
  menu.style.left = "0px";
  menu.style.top = "0px";

  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(edgeGap, viewportWidth - rect.width - edgeGap);
  const maxTop = Math.max(edgeGap, viewportHeight - rect.height - edgeGap);
  const nextLeft = Math.min(Math.max(Number(x) || 0, edgeGap), maxLeft);
  const nextTop = Math.min(Math.max(Number(y) || 0, edgeGap), maxTop);

  menu.style.left = `${nextLeft}px`;
  menu.style.top = `${nextTop}px`;
  menu.style.visibility = "";
}

/**
 * 创建上下文菜单管理器
 * @param {object} params
 * @param {HTMLElement} params.menuElement
 * @param {(key: string) => string} params.t
 * @param {(url: string) => string} params.normalizeUrl
 * @param {object} params.callbacks
 */
export function createContextMenuManager({ menuElement, t, normalizeUrl, callbacks }) {
  function closeMenu() {
    if (menuElement) {
      menuElement.classList.add("hidden");
    }
  }

  function showTileMenu(x, y, node, { activeGroupId } = {}) {
    if (!menuElement) return;
    menuElement.replaceChildren();
    const actions = [];

    const isRecent = activeGroupId === RECENT_GROUP_ID && node.type === "history";

    if (isRecent) {
      actions.push({
        label: t("context.openCurrent"),
        fn: () => callbacks.openUrl(normalizeUrl(node.url)),
      });
      actions.push({
        label: t("context.openNew"),
        fn: () => callbacks.openUrl(normalizeUrl(node.url), "new"),
      });
      actions.push({
        label: t("context.addToShortcuts"),
        fn: () => callbacks.openAddHistoryToGroup(node),
      });
    } else if (node.type !== "folder") {
      actions.push({
        label: t("context.openCurrent"),
        fn: () => callbacks.openUrl(normalizeUrl(node.url)),
      });
      actions.push({
        label: t("context.openNew"),
        fn: () => callbacks.openUrl(normalizeUrl(node.url), "new"),
      });
      actions.push({
        label: t("context.openBackground"),
        fn: () => callbacks.openUrl(normalizeUrl(node.url), "background"),
      });
    } else {
      actions.push({
        label: t("context.openFolder"),
        fn: () => callbacks.openFolder(node.id),
      });
      actions.push({
        label: t("context.dissolveFolder"),
        fn: () => callbacks.dissolveFolder(node.id),
      });
    }

    if (node.type !== "history") {
      actions.push({
        label: t("context.edit"),
        fn: () => callbacks.openEditModal(node),
      });
      actions.push({
        label: t("context.delete"),
        fn: () => callbacks.deleteNodes([node.id]),
      });
    }

    for (const action of actions) {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        action.fn();
        closeMenu();
      });
      menuElement.appendChild(btn);
    }

    positionMenuAt(menuElement, x, y);
  }

  function showGroupMenu(x, y, group) {
    if (!menuElement) return;
    menuElement.replaceChildren();
    const actions = [
      {
        label: t("context.renameGroup"),
        fn: () => callbacks.renameGroup(group),
      },
      {
        label: t("context.deleteGroup"),
        fn: () => callbacks.deleteGroup(group),
      },
    ];

    for (const action of actions) {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        action.fn();
        closeMenu();
      });
      menuElement.appendChild(btn);
    }

    positionMenuAt(menuElement, x, y);
  }

  return {
    showTileMenu,
    showGroupMenu,
    closeMenu,
    positionMenuAt: (x, y) => positionMenuAt(menuElement, x, y),
  };
}
