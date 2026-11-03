/**
 * 核心网格渲染管线（从 app.js 拆出，解耦第十阶段）。
 *
 * 职责：主网格与文件夹覆盖层网格的完整渲染——布局计算（列数/卡片尺寸/密度）、
 * 卡片 DOM 生成（图标占位/标题/徽标/ARIA）、事件装配（点击/中键/键盘/右键/
 * 悬停/拖拽/触摸，全部委托各 manager）、空状态切换（普通分组 vs 最近历史分组）。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import { normalizeUrl } from "./shared-utils.js";

var HomepageGridRenderer = (() => {
  const MIN_TILE_SIZE = 32;
  const MAX_TILE_SIZE = 220;
  /** 网格密度表与 theme-manager 共用：compact 10 / standard 16 / spacious 22 */
  const DENSITY_GAPS = { compact: 10, standard: 16, spacious: 22 };

  /** 节点去重（异常数据防御：同 ID 多引用只渲染一次） */
  function uniqueNodes(nodes) {
    const seenId = new Set();
    const out = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node?.id) continue;
      if (seenId.has(node.id)) continue;
      seenId.add(node.id);
      out.push(node);
    }
    return out;
  }

  /**
   * @param {{
   *   getElements: () => { grid: HTMLElement, folderGrid: HTMLElement, emptyState: HTMLElement },
   *   getData: () => object,
   *   getState: () => { activeGroupId: string, openFolderId: string|null },
   *   getCurrentNodes: () => Array<object>,
   *   getRecentItems: () => Array<object>,
   *   loadIconCache: () => Promise<object>,
   *   iconManager: object, dragManager: object, touchDrag: object,
   *   openModeMgr: object, selectionMgr: object, tooltipMgr: object, historyManager: object,
   *   openFolder: (folderId: string) => void,
   *   openUrl: (url: string, mode?: string) => void,
   *   openContextMenu: (x: number, y: number, node: object) => void,
   *   toast: (message: string, kind?: string) => void,
   *   t: (key: string, vars?: object) => string,
   *   isRecentGroup: (groupId: string) => boolean,
   *   qs: (selector: string, root?: HTMLElement) => HTMLElement|null,
   *   createDiv?: () => HTMLElement,
   * }} deps
   */
  function createGridRenderer(deps) {
    const createDiv = deps.createDiv || (() => document.createElement("div"));
    /** 渲染批次序号：新一轮渲染开始后，旧批次的异步图标更新作废 */
    let renderSeq = 0;
    /** 主网格布局缓存：文件夹覆盖层沿用主网格列数，避免小网格重新计算 */
    let lastMainLayout = null;

    /**
     * 构建单个卡片元素并装配全部事件（各 manager 委托）。
     * @param {object} node 节点
     * @param {number} idx 在当前序列中的索引
     * @param {number} seq 渲染批次（异步图标更新的过期判定）
     * @param {object} [iconCache] 预加载的图标缓存（批次共享）
     * @returns {HTMLElement}
     */
    function createTileElement(node, idx, seq, iconCache = null) {
      const tile = createDiv();
      tile.className = "tile";
      tile.dataset.id = node.id;
      tile.dataset.index = idx;
      tile.draggable = true;
      tile.tabIndex = 0;
      // 无障碍：网格语义 + 卡片可读名称（键盘漫游 / 读屏依赖）
      tile.setAttribute("role", "gridcell");
      tile.setAttribute(
        "aria-label",
        node.type === "folder"
          ? `${node.title}${deps.t("tile.folderSuffix")}`
          : `${node.title} ${node.url || ""}`.trim(),
      );

      const icon = createDiv();
      icon.className = "tile-icon";
      const img = document.createElement("img");
      img.alt = node.title || node.url || "";
      // 字母头像占位 → 缓存解析异步替换 → 远程失败按候选回退（完整链路见 icon-manager.js）
      deps.iconManager.bindTileIcon(img, node, {
        cache: iconCache,
        // 渲染批次已过期（seq 变化）则放弃更新 DOM
        isStale: () => seq !== renderSeq,
      });
      icon.appendChild(img);

      const title = createDiv();
      title.className = "tile-title";
      title.textContent = node.title || node.url || deps.t("common.unnamed");

      tile.appendChild(icon);
      tile.appendChild(title);

      if (node.type === "folder") {
        const badge = createDiv();
        badge.className = "tile-badge";
        badge.textContent = `${node.children?.length || 0}`;
        tile.appendChild(badge);
      }

      if (deps.selectionMgr?.has(node.id)) {
        tile.classList.add("selected");
      }

      tile.addEventListener("click", (e) => {
        if (deps.touchDrag?.isClickSuppressed()) {
          e.preventDefault();
          return;
        }
        if (deps.selectionMgr?.isBatchModeActive()) {
          deps.selectionMgr.toggleTileSelection(node.id, idx, e.shiftKey);
          return;
        }
        if (node.type === "folder") {
          deps.openFolder(node.id);
          return;
        }
        const url = normalizeUrl(node.url);
        if (!url) {
          deps.toast(deps.t("error.invalidUrlSimple"), "error");
          return;
        }
        deps.openModeMgr.openCard(url, e);
      });
      // 中键点击：后台新标签（浏览器默认之外补充统一编排）
      tile.addEventListener("auxclick", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        if (deps.selectionMgr?.isBatchModeActive()) return;
        if (node.type === "folder") return;
        const url = normalizeUrl(node.url);
        if (!url) return;
        deps.openModeMgr.openCard(url, e);
      });

      tile.addEventListener("keydown", (e) => {
        if (!deps.getData()?.settings?.keyboardNav) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (deps.selectionMgr?.isBatchModeActive()) {
          deps.selectionMgr.toggleTileSelection(node.id, idx, e.shiftKey);
          return;
        }
        if (node.type === "folder") {
          deps.openFolder(node.id);
          return;
        }
        const url = normalizeUrl(node.url);
        if (!url) {
          deps.toast(deps.t("error.invalidUrlSimple"), "error");
          return;
        }
        deps.openUrl(url);
      });

      tile.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        deps.openContextMenu(e.clientX, e.clientY, node);
      });

      // 悬停提示防抖与越界钳制（tooltip-manager.js）
      tile.addEventListener("mouseenter", (e) => {
        const text =
          node.type === "folder" ? `${node.title}${deps.t("tile.folderSuffix")}` : `${node.title}\n${node.url}`;
        deps.tooltipMgr.scheduleShow(text, e.clientX, e.clientY);
      });
      tile.addEventListener("mouseleave", () => deps.tooltipMgr.hideTooltip());

      // 拖拽三意图（排序/入文件夹/合并成组）统一由 drag-manager 处理
      deps.dragManager.bindTileDragEvents(tile, node);
      // 触摸长按：1s 上下文菜单 / 3s 拖拽（状态机见 touch-drag-manager.js）
      deps.touchDrag.bindTileTouchEvents(tile, node);

      return tile;
    }

    /**
     * 渲染当前网格：布局计算（列数/尺寸随密度与视口自适应）→ 清空容器 →
     * 依序挂载卡片 → 刷新空状态。
     */
    async function renderGrid() {
      const seq = ++renderSeq;
      const elements = deps.getElements();
      const { openFolderId } = deps.getState();
      const grid = openFolderId ? elements.folderGrid : elements.grid;
      const nodes = uniqueNodes(deps.getCurrentNodes());
      grid.replaceChildren();

      // 布局基准：覆盖层用主网格宽度计算，保证与背后的主网格一致
      const referenceGrid = openFolderId ? elements.grid : grid;
      const width = referenceGrid.getBoundingClientRect().width || referenceGrid.clientWidth || window.innerWidth;
      const settings = deps.getData()?.settings || {};
      const density = DENSITY_GAPS[settings.gridDensity] || DENSITY_GAPS.standard;
      const gap = density.gap || 16;
      const style = getComputedStyle(referenceGrid);
      const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const available = Math.max(0, width - paddingX);
      const isMobileViewport = !!window.matchMedia?.("(max-width: 720px)").matches;
      const baseSize = settings.lastTileSize || 96;
      const maxColumns = Math.max(1, Math.floor((available + gap) / (baseSize + gap)));
      let columns = maxColumns;
      if (settings.fixedLayout) {
        const desired = Math.max(1, settings.fixedCols || 8);
        columns = desired;
      } else if (isMobileViewport) {
        columns = Math.max(3, columns);
      }
      let tileSize = baseSize;
      const clampTile = (size) => Math.max(MIN_TILE_SIZE, Math.min(MAX_TILE_SIZE, size));
      if (settings.fixedLayout && available > 0) {
        tileSize = clampTile(Math.floor((available - gap * (columns - 1)) / columns));
      } else if (isMobileViewport && available > 0) {
        tileSize = clampTile(Math.floor((available - gap * (columns - 1)) / columns));
      } else if (columns <= 1 && available > 0) {
        tileSize = clampTile(Math.floor(available));
      } else {
        tileSize = clampTile(baseSize);
      }
      let iconSize = Math.max(18, Math.min(Math.floor(tileSize * 0.52), Math.round(tileSize * 0.58)));
      if (!openFolderId) {
        lastMainLayout = { columns, tileSize, iconSize };
      } else if (lastMainLayout) {
        columns = lastMainLayout.columns;
        tileSize = lastMainLayout.tileSize;
        iconSize = lastMainLayout.iconSize;
      }
      grid.style.setProperty("--tile-size", `${tileSize}px`);
      grid.style.setProperty("--tile-icon", `${iconSize}px`);
      const tightLayout = columns >= 8;
      const mediumLayout = columns >= 6;
      const tilePad = tightLayout ? "4px 4px 6px" : mediumLayout ? "6px 6px 8px" : "8px 8px 10px";
      const tileGap = tightLayout ? "2px" : mediumLayout ? "3px" : "4px";
      grid.style.setProperty("--tile-pad", tilePad);
      grid.style.setProperty("--tile-gap", tileGap);
      grid.style.gridTemplateColumns = `repeat(${columns}, minmax(${tileSize}px, 1fr))`;

      // 预加载图标缓存，避免每个 tile 都独立读存储
      const iconCache = await deps.loadIconCache();

      for (const [idx, node] of nodes.entries()) {
        if (seq !== renderSeq) return;
        grid.appendChild(createTileElement(node, idx, seq, iconCache));
      }

      updateEmptyState();
    }

    /**
     * 空状态切换：最近历史分组按 API 状态给出不可用/回退/空数据说明；
     * 普通分组仅在无节点且未关闭提示时显示引导。
     */
    function updateEmptyState() {
      const elements = deps.getElements();
      const { activeGroupId } = deps.getState();
      const emptyTitle = deps.qs(".empty-title", elements.emptyState);
      const emptyDesc = deps.qs(".empty-desc", elements.emptyState);
      const emptyCheck = deps.qs(".empty-check", elements.emptyState);

      if (deps.isRecentGroup(activeGroupId)) {
        // 历史分组：API 不可用或暂无数据时给出明确说明（不再整块隐藏）
        if (deps.getRecentItems().length > 0) {
          elements.emptyState.classList.add("hidden");
          return;
        }
        const historyStatus = deps.historyManager?.status || "unknown";
        if (emptyCheck) emptyCheck.classList.add("hidden");
        if (historyStatus === "error") {
          if (emptyTitle) emptyTitle.textContent = deps.t("history.unavailable.title");
          if (emptyDesc) emptyDesc.textContent = deps.t("history.unavailable.desc");
        } else if (historyStatus === "missing") {
          // 理论上会被 fallback 覆盖；仍给出明确说明
          if (emptyTitle) emptyTitle.textContent = deps.t("history.unavailable.title");
          if (emptyDesc) emptyDesc.textContent = deps.t("history.fallback.desc");
        } else {
          if (emptyTitle) emptyTitle.textContent = deps.t("history.empty.title");
          if (emptyDesc) {
            emptyDesc.textContent =
              historyStatus === "fallback" ? deps.t("history.fallback.desc") : deps.t("history.empty.desc");
          }
        }
        elements.emptyState.classList.remove("hidden");
        return;
      }

      if (emptyCheck) emptyCheck.classList.remove("hidden");
      if (emptyTitle) emptyTitle.textContent = deps.t("empty.title");
      if (emptyDesc) emptyDesc.textContent = deps.t("empty.desc");
      const nodes = deps.getCurrentNodes();
      const hideHint = deps.getData()?.settings?.emptyHintDisabled;
      if (nodes.length === 0 && !hideHint) {
        elements.emptyState.classList.remove("hidden");
      } else {
        elements.emptyState.classList.add("hidden");
      }
    }

    return { renderGrid, createTileElement, updateEmptyState, uniqueNodes };
  }

  return { createGridRenderer, uniqueNodes };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createGridRenderer = HomepageGridRenderer.createGridRenderer;
export const uniqueNodes = HomepageGridRenderer.uniqueNodes;
