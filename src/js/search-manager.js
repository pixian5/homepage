/**
 * 顶部搜索管理器（从 app.js 拆出）。
 *
 * 职责：搜索框实时过滤当前网格卡片（标题/网址/拼音，复用 pinyin-match）；
 * Enter / 搜索按钮按当前搜索引擎打开新标签搜索；清空或 Escape 恢复全量卡片。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import { matchesSearchQuery } from "./pinyin-match.js";

var HomepageSearchManager = (() => {
  /**
   * 构造外部搜索引擎跳转 URL（纯函数，便于单测）。
   * @param {string} engineUrl 搜索引擎前缀（如 https://www.baidu.com/s?wd=）
   * @param {string} query 搜索词
   * @returns {string}
   */
  function buildSearchUrl(engineUrl, query) {
    return `${String(engineUrl || "")}${encodeURIComponent(String(query || "").trim())}`;
  }

  /**
   * 按查询词计算每个卡片的可见性（纯函数，便于单测）。
   * @param {object} nodes id -> node 映射
   * @param {Array<{dataset?: {id: string}}>} tiles 当前网格的卡片元素（或带 dataset.id 的替身）
   * @param {string} query 已 trim 的小写查询词；空串表示恢复全量
   * @returns {Array<{tile: object, visible: boolean}>}
   */
  function filterTilesByQuery(nodes, tiles, query) {
    const q = String(query || "")
      .trim()
      .toLowerCase();
    return (Array.isArray(tiles) ? tiles : []).map((tile) => {
      if (!q) return { tile, visible: true };
      const node = nodes?.[tile?.dataset?.id];
      return { tile, visible: !!node && matchesSearchQuery(node.title, node.url, q) };
    });
  }

  /**
   * @param {{
   *   searchInput: HTMLInputElement,
   *   searchBtn?: HTMLButtonElement|null,
   *   getData: () => object,
   *   getActiveGrid: () => HTMLElement|null,
   *   getNodes: () => object,
   *   openUrl: (url: string, mode?: string) => void,
   *   render: () => void,
   *   onFocus?: () => void|Promise<void>,
   *   qsa?: (selector: string, root?: HTMLElement) => Array<HTMLElement>,
   * }} deps
   */
  function createSearchManager(deps) {
    const input = deps.searchInput;
    const qsa =
      deps.qsa || ((selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector)));

    /** 当前查询词（trim 后；未 trim 的原始值用于占位判断） */
    function getQuery() {
      return String(input?.value || "").trim();
    }

    /** 实时过滤当前网格卡片：拼音/标题/网址命中保留，其余隐藏 */
    function handleInput() {
      const query = String(input?.value || "")
        .trim()
        .toLowerCase();
      const grid = deps.getActiveGrid?.();
      if (!query) {
        // 清空 → 恢复全量（重渲染消除所有内联 display）
        deps.render();
        return;
      }
      if (!grid) return;
      const plan = filterTilesByQuery(deps.getNodes?.() || {}, qsa(".tile", grid), query);
      for (const { tile, visible } of plan) {
        tile.style.display = visible ? "" : "none";
      }
    }

    /** 跳转外部搜索引擎（Enter / 搜索按钮）；空查询聚焦搜索框 */
    function submitSearch() {
      const query = getQuery();
      if (!query) {
        input?.focus?.();
        return;
      }
      const engineUrl = deps.getData?.()?.settings?.searchEngineUrl || "";
      deps.openUrl(buildSearchUrl(engineUrl, query), "new");
    }

    /** Escape：清空搜索并恢复全量卡片 */
    function handleEscape() {
      if (!input) return;
      if (!input.value) return;
      input.value = "";
      deps.render();
    }

    /** 绑定 DOM 事件（幂等：重复调用先解绑旧监听） */
    let unbind = null;
    function bind() {
      unbind?.();
      if (!input) return () => {};
      const onInput = () => handleInput();
      const onKeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitSearch();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          handleEscape();
        }
      };
      const onFocus = () => void deps.onFocus?.();
      input.addEventListener("input", onInput);
      input.addEventListener("keydown", onKeydown);
      input.addEventListener("focus", onFocus);
      const btn = deps.searchBtn;
      const onClick = () => submitSearch();
      btn?.addEventListener?.("click", onClick);
      unbind = () => {
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onKeydown);
        input.removeEventListener("focus", onFocus);
        btn?.removeEventListener?.("click", onClick);
      };
      return unbind;
    }

    return { bind, handleInput, submitSearch, handleEscape, getQuery, buildSearchUrl };
  }

  return { createSearchManager, buildSearchUrl, filterTilesByQuery };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createSearchManager = HomepageSearchManager.createSearchManager;
export const buildSearchUrl = HomepageSearchManager.buildSearchUrl;
export const filterTilesByQuery = HomepageSearchManager.filterTilesByQuery;
