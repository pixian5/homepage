/**
 * 全局快速启动命令面板（Cmd/Ctrl + K）。
 *
 * 职责：
 * - 跨全部分组与嵌套文件夹实时检索全部书签与文件夹（复用 pinyin-match 拼音/首字母/子序列）；
 * - 支持 `>` 快捷动作指令或直接输入关键字快速触发应用动作；
 * - 全程键盘导航（↑/↓/Home/End/Enter/Escape）且挂在独立 #commandPaletteOverlay 上，不干扰业务弹窗。
 *
 * 用 IIFE 包裹：兼容 Firefox 经典脚本拼接拓扑。
 */

import { isAllBookmarksGroup } from "./data-utils.js";
import { matchesSearchQuery } from "./pinyin-match.js";

var HomepageCommandPalette = (() => {
  const MAX_RESULTS = 40;

  function extractHost(url) {
    try {
      return new URL(url).hostname || url;
    } catch {
      return String(url || "");
    }
  }

  /**
   * 生成全库可搜索项（书签 + 文件夹 + 内置命令动作）。
   * @param {object} data
   * @param {{ t?: (key: string) => string, actions?: Array<{ id: string, title: string, keywords?: string, run: Function }> }} [opts]
   */
  function buildCommandEntries(data, opts = {}) {
    const t = typeof opts.t === "function" ? opts.t : (key) => key;
    const nodes = data?.nodes || {};
    const entries = [];
    const visitedNodes = new Set();

    const visitFolder = (folderId, rootGroupId, pathParts) => {
      const folder = nodes[folderId];
      if (folder?.type !== "folder" || folder.deletedAt || folder.purgedAt || visitedNodes.has(folderId)) return;
      visitedNodes.add(folderId);
      const folderTitle = String(folder.title || t("folder.defaultTitle")).trim();
      const nextPath = [...pathParts, folderTitle];
      entries.push({
        kind: "folder",
        id: folder.id,
        rootGroupId,
        title: folderTitle,
        subtitle: pathParts.join(" / ") || t("batchMove.rootContainer"),
        keywords: `${folderTitle} folder`,
      });
      for (const childId of folder.children || []) {
        const child = nodes[childId];
        if (!child || child.deletedAt || child.purgedAt) continue;
        if (child.type === "folder") {
          visitFolder(childId, rootGroupId, nextPath);
        } else if (child.type === "item" && child.url && !visitedNodes.has(childId)) {
          visitedNodes.add(childId);
          entries.push({
            kind: "bookmark",
            id: child.id,
            node: child,
            title: child.title || child.url,
            subtitle: nextPath.join(" / "),
            url: child.url,
            host: extractHost(child.url),
            keywords: `${child.title || ""} ${child.url || ""}`,
          });
        }
      }
    };

    for (const group of data?.groups || []) {
      if (!group) continue;
      const rootLabel = isAllBookmarksGroup(group) ? t("batchMove.rootContainer") : group.title || group.name || "";
      const rootPath = rootLabel ? [rootLabel] : [];
      for (const id of group.nodes || []) {
        const node = nodes[id];
        if (!node || node.deletedAt || node.purgedAt) continue;
        if (node.type === "folder") {
          visitFolder(id, group.id, rootPath);
        } else if (node.type === "item" && node.url && !visitedNodes.has(id)) {
          visitedNodes.add(id);
          entries.push({
            kind: "bookmark",
            id: node.id,
            node,
            title: node.title || node.url,
            subtitle: rootLabel,
            url: node.url,
            host: extractHost(node.url),
            keywords: `${node.title || ""} ${node.url || ""}`,
          });
        }
      }
    }

    for (const action of opts.actions || []) {
      if (!action?.id || !action.title) continue;
      entries.push({
        kind: "action",
        id: action.id,
        title: action.title,
        subtitle: t("cmdk.badge.action"),
        keywords: `${action.title} ${action.keywords || ""}`,
        run: action.run,
      });
    }

    return entries;
  }

  /**
   * 过滤命令面板条目。输入以 `>` 开头时只筛选动作命令。
   * @param {Array<object>} entries
   * @param {string} rawQuery
   * @param {number} [limit]
   */
  function filterCommandEntries(entries, rawQuery, limit = MAX_RESULTS) {
    const trimmed = String(rawQuery || "").trim();
    const actionOnly = trimmed.startsWith(">");
    const q = (actionOnly ? trimmed.slice(1) : trimmed).trim().toLowerCase();

    const pool = actionOnly ? entries.filter((entry) => entry.kind === "action") : entries;
    if (!q) {
      return pool.slice(0, limit);
    }

    const matched = [];
    for (const entry of pool) {
      if (matchesSearchQuery(entry.title, `${entry.url || ""} ${entry.keywords || ""} ${entry.subtitle || ""}`, q)) {
        matched.push(entry);
        if (matched.length >= limit) break;
      }
    }
    return matched;
  }

  /**
   * @param {{
   *   getData: () => object,
   *   t: (key: string, vars?: object) => string,
   *   openBookmark: (node: object) => void,
   *   navigateToFolder: (target: { id: string, rootGroupId: string }) => void,
   *   getActions?: () => Array<{ id: string, title: string, keywords?: string, run: Function }>,
   *   doc?: Document,
   * }} deps
   */
  function createCommandPalette(deps) {
    const doc = deps.doc || (typeof document !== "undefined" ? document : null);
    let overlayEl = null;
    let inputEl = null;
    let listEl = null;
    let entries = [];
    let visible = [];
    let activeIndex = 0;
    let previousFocus = null;
    let isOpen = false;
    let unbindDocKeydown = null;

    function ensureDom() {
      if (!doc || overlayEl) return;
      overlayEl = doc.getElementById?.("commandPaletteOverlay") || null;
      if (!overlayEl && doc.body) {
        overlayEl = doc.createElement("div");
        overlayEl.id = "commandPaletteOverlay";
        overlayEl.className = "cmdk-overlay hidden";
        overlayEl.setAttribute("role", "dialog");
        overlayEl.setAttribute("aria-modal", "true");
        overlayEl.setAttribute("aria-hidden", "true");
        overlayEl.setAttribute("inert", "");

        const dialog = doc.createElement("div");
        dialog.className = "cmdk-dialog";

        inputEl = doc.createElement("input");
        inputEl.id = "commandPaletteInput";
        inputEl.type = "search";
        inputEl.className = "cmdk-input";
        inputEl.autocomplete = "off";

        listEl = doc.createElement("div");
        listEl.id = "commandPaletteList";
        listEl.className = "cmdk-list";
        listEl.setAttribute("role", "listbox");

        dialog.appendChild(inputEl);
        dialog.appendChild(listEl);
        overlayEl.appendChild(dialog);
        doc.body.appendChild(overlayEl);
      } else if (overlayEl) {
        inputEl = overlayEl.querySelector?.("#commandPaletteInput") || null;
        listEl = overlayEl.querySelector?.("#commandPaletteList") || null;
      }

      if (overlayEl && !overlayEl.__cmdkBound) {
        overlayEl.__cmdkBound = true;
        overlayEl.addEventListener("click", (e) => {
          if (e.target === overlayEl) close();
        });
      }
      if (inputEl && !inputEl.__cmdkBound) {
        inputEl.__cmdkBound = true;
        inputEl.addEventListener("input", () => {
          activeIndex = 0;
          refreshList();
        });
        inputEl.addEventListener("keydown", (e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation?.();
            if (visible.length) {
              activeIndex = (activeIndex + 1) % visible.length;
              renderRows();
            }
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation?.();
            if (visible.length) {
              activeIndex = (activeIndex - 1 + visible.length) % visible.length;
              renderRows();
            }
          } else if (e.key === "Home") {
            if (visible.length) {
              e.preventDefault();
              e.stopPropagation?.();
              activeIndex = 0;
              renderRows();
            }
          } else if (e.key === "End") {
            if (visible.length) {
              e.preventDefault();
              e.stopPropagation?.();
              activeIndex = visible.length - 1;
              renderRows();
            }
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation?.();
            executeActive();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation?.();
            close();
          }
        });
      }
    }

    function kindLabel(kind) {
      if (kind === "folder") return deps.t("cmdk.badge.folder");
      if (kind === "action") return deps.t("cmdk.badge.action");
      return deps.t("cmdk.badge.bookmark");
    }

    function renderRows() {
      if (!listEl || !doc) return;
      listEl.replaceChildren();
      if (!visible.length) {
        const empty = doc.createElement("div");
        empty.className = "cmdk-empty";
        empty.textContent = deps.t("cmdk.empty");
        listEl.appendChild(empty);
        return;
      }
      if (activeIndex >= visible.length) activeIndex = visible.length - 1;
      if (activeIndex < 0) activeIndex = 0;

      visible.forEach((item, index) => {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = `cmdk-item${index === activeIndex ? " active" : ""}`;
        btn.setAttribute("role", "option");
        btn.setAttribute("aria-selected", index === activeIndex ? "true" : "false");

        const main = doc.createElement("span");
        main.className = "cmdk-main";

        const titleEl = doc.createElement("span");
        titleEl.className = "cmdk-title";
        titleEl.textContent = item.title;

        const metaEl = doc.createElement("span");
        metaEl.className = "cmdk-meta";
        metaEl.textContent =
          item.kind === "bookmark" ? [item.subtitle, item.host].filter(Boolean).join(" · ") : item.subtitle || "";

        main.appendChild(titleEl);
        main.appendChild(metaEl);

        const badge = doc.createElement("span");
        badge.className = "cmdk-badge";
        badge.textContent = kindLabel(item.kind);

        btn.appendChild(main);
        btn.appendChild(badge);
        btn.addEventListener("mouseenter", () => {
          if (activeIndex !== index) {
            activeIndex = index;
            renderRows();
          }
        });
        btn.addEventListener("click", () => {
          activeIndex = index;
          executeActive();
        });
        listEl.appendChild(btn);
      });
    }

    function refreshList() {
      visible = filterCommandEntries(entries, inputEl?.value || "");
      renderRows();
    }

    function executeActive() {
      const target = visible[activeIndex];
      if (!target) return;
      close();
      if (target.kind === "bookmark") {
        deps.openBookmark?.(target.node);
      } else if (target.kind === "folder") {
        deps.navigateToFolder?.({ id: target.id, rootGroupId: target.rootGroupId });
      } else if (target.kind === "action") {
        void target.run?.();
      }
    }

    function open() {
      if (!doc) return;
      ensureDom();
      if (!overlayEl || !inputEl) return;
      previousFocus = doc.activeElement || null;
      entries = buildCommandEntries(deps.getData?.(), {
        t: deps.t,
        actions: deps.getActions?.() || [],
      });
      inputEl.placeholder = deps.t("cmdk.placeholder");
      overlayEl.setAttribute("aria-label", deps.t("cmdk.ariaLabel"));
      inputEl.value = "";
      activeIndex = 0;
      isOpen = true;
      overlayEl.classList.remove("hidden");
      overlayEl.setAttribute("aria-hidden", "false");
      overlayEl.removeAttribute?.("inert");
      refreshList();
      inputEl.focus?.();
    }

    function close() {
      if (!isOpen || !overlayEl) return;
      isOpen = false;
      overlayEl.classList.add("hidden");
      overlayEl.setAttribute("aria-hidden", "true");
      overlayEl.setAttribute("inert", "");
      previousFocus?.focus?.();
      previousFocus = null;
    }

    function toggle() {
      if (isOpen) close();
      else open();
    }

    function bindGlobalShortcut() {
      unbindDocKeydown?.();
      if (!doc?.addEventListener) return () => {};
      const handler = (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key || "").toLowerCase() === "k") {
          e.preventDefault();
          e.stopPropagation?.();
          toggle();
          return;
        }
        if (isOpen && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation?.();
          close();
        }
      };
      doc.addEventListener("keydown", handler);
      unbindDocKeydown = () => doc.removeEventListener("keydown", handler);
      return unbindDocKeydown;
    }

    return {
      open,
      close,
      toggle,
      isOpen: () => isOpen,
      getVisibleEntries: () => visible,
      bindGlobalShortcut,
    };
  }

  return { buildCommandEntries, filterCommandEntries, createCommandPalette };
})();

export const buildCommandEntries = HomepageCommandPalette.buildCommandEntries;
export const filterCommandEntries = HomepageCommandPalette.filterCommandEntries;
export const createCommandPalette = HomepageCommandPalette.createCommandPalette;
