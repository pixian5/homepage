/**
 * 「最近历史」分组管理器（从 app.js 拆出）。
 *
 * 职责：读取浏览器历史（chrome.history / browser.history）并合并扩展自建的
 * 最近访问回退（visit-history.js），产出历史卡片视图模型；把历史项固化为
 * 持久化快捷卡片（含目标分组选择弹窗）。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import { createItemNode } from "./data-utils.js";
import { getChromeApi, normalizeUrl, RECENT_GROUP_ID } from "./shared-utils.js";
import { getVisitHistoryItems } from "./visit-history.js";

var HomepageHistoryManager = (() => {
  /** 默认回看天数与条数（与拆出前的 app.js 常量一致） */
  const DEFAULT_DAYS = 7;
  const DEFAULT_LIMIT = 24;

  /**
   * 把多来源历史条目合并为历史卡片视图模型（纯函数，便于单测）：
   * 按 URL 规范化去重 → 按访问时间倒序 → 截断到 limit。
   * @param {Array<{title?:string, url:string, ts?:number}>} browserItems
   * @param {Array<{title?:string, url:string, ts?:number}>} visitItems
   * @param {number} limit
   * @returns {Array<{id:string, type:"history", title:string, url:string, ts:number}>}
   */
  function renderHistoryCards(browserItems, visitItems, limit = DEFAULT_LIMIT) {
    const merged = [];
    const seenUrl = new Set();
    const pushUnique = (entry) => {
      if (!entry?.url) return;
      let key = entry.url;
      try {
        key = new URL(entry.url).href;
      } catch (_e) {
        // 非法 URL 保留原始串作为键
      }
      if (seenUrl.has(key)) return;
      seenUrl.add(key);
      merged.push(entry);
    };
    for (const entry of Array.isArray(browserItems) ? browserItems : []) pushUnique(entry);
    for (const entry of Array.isArray(visitItems) ? visitItems : []) pushUnique(entry);
    merged.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    return merged.slice(0, limit).map((entry, idx) => ({
      id: `recent_${idx}`,
      type: "history",
      title: entry.title || entry.url,
      url: entry.url,
      ts: Number(entry.ts) || 0,
    }));
  }

  /**
   * @param {{
   *   debugLog?: (event: string, payload?: object) => void,
   *   t: (key: string, vars?: object) => string,
   *   toast: (message: string, kind?: string, actionLabel?: string, onAction?: () => void) => void,
   *   getData: () => object,
   *   getRootGroup: () => object,
   *   getRootContainers: () => Array<object>,
   *   getRootContainerById: (id: string) => object|null,
   *   isAllBookmarksGroup: (group: object) => boolean,
   *   getPlacementList: (container: object) => string[],
   *   setPlacementList: (container: object, list: string[]) => void,
   *   pushBackup: () => void,
   *   persistData: () => Promise<void>,
   *   render: () => void,
   *   processPendingIconFetches: () => void,
   *   openModal: (html: object) => void,
   *   closeModal?: () => void,
   *   html: (strings: Array<string>, ...values: Array<any>) => object,
   *   rawHtml: (text: string) => object,
   *   days?: number, limit?: number,
   * }} deps
   */
  function createHistoryManager(deps) {
    const debugLog = deps.debugLog || (() => {});
    const days = Number(deps.days) > 0 ? Number(deps.days) : DEFAULT_DAYS;
    const limit = Number(deps.limit) > 0 ? Number(deps.limit) : DEFAULT_LIMIT;
    /** history API 可用性：unknown | ok | error | missing | fallback */
    let apiStatus = "unknown";

    /** 读取浏览器历史（chrome.history.search / browser.history.search，双形态兼容） */
    async function fetchBrowserHistory() {
      const api = getChromeApi();
      const items = [];
      if (!api?.history?.search) {
        apiStatus = "missing";
        debugLog("history_api_missing", {
          hasChrome: typeof chrome !== "undefined",
          hasBrowser: typeof browser !== "undefined",
          keys: api ? Object.keys(api).slice(0, 30) : [],
        });
        return { items: [], ok: false };
      }
      const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
      const raw = await new Promise((resolve) => {
        let done = false;
        const settle = (res) => {
          if (!done) {
            done = true;
            resolve(res || []);
          }
        };
        try {
          const result = api.history.search({ text: "", startTime, maxResults: limit }, (res) => {
            const err = api.runtime?.lastError;
            if (err) {
              apiStatus = "error";
              console.warn("fetchRecentHistory lastError:", err.message || err);
              return settle([]);
            }
            settle(res || []);
          });
          // Promise 形态（Firefox）与回调形态（Chrome/Safari）双兼容
          if (result && typeof result.then === "function") {
            result.then(settle).catch((e) => {
              apiStatus = "error";
              console.warn("fetchRecentHistory rejected", e);
              settle([]);
            });
          }
        } catch (e) {
          apiStatus = "error";
          console.warn("fetchRecentHistory threw", e);
          settle([]);
        }
      });
      const seen = new Set();
      for (const item of raw || []) {
        if (!item?.url) continue;
        let normalized = item.url;
        try {
          normalized = new URL(item.url).href;
        } catch (e) {
          console.warn("fetchRecentHistory: invalid URL", item.url, e);
        }
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        items.push({
          title: item.title || item.url,
          url: item.url,
          ts: Number(item.lastVisitTime) || 0,
        });
      }
      if (apiStatus !== "error") apiStatus = "ok";
      return { items, ok: true };
    }

    /**
     * 拉取「最近历史」条目：浏览器历史优先，扩展自建访问记录兜底（Safari 等）。
     * 返回历史卡片视图模型（去重 / 倒序 / 截断）。
     */
    async function fetchRecentHistory() {
      const browser = await fetchBrowserHistory();
      let visitItems = [];
      try {
        visitItems = await getVisitHistoryItems(limit);
      } catch (e) {
        console.warn("getVisitHistoryItems failed", e);
      }
      const finalItems = renderHistoryCards(browser.items, visitItems, limit);

      if (finalItems.length > 0) {
        apiStatus = browser.ok ? "ok" : "fallback";
      } else if (apiStatus === "missing") {
        // 自建回退管道可用，空列表用 empty 文案而非 unavailable
        apiStatus = "fallback";
      }
      debugLog("history_loaded", {
        browser: browser.items.length,
        visits: visitItems.length,
        final: finalItems.length,
        status: apiStatus,
      });
      return finalItems;
    }

    /** 新增卡片的首选目标分组：固定分组 > 上次活跃分组 > 第一个分组 */
    function getPreferredGroupIdForNewItem() {
      const data = deps.getData();
      const settings = data?.settings || {};
      if (settings.defaultGroupMode === "fixed" && settings.defaultGroupId) {
        const fixed = deps.getRootContainerById(settings.defaultGroupId);
        if (fixed) return fixed.id;
      }
      if (settings.lastActiveGroupId && settings.lastActiveGroupId !== RECENT_GROUP_ID) {
        const last = deps.getRootContainerById(settings.lastActiveGroupId);
        if (last) return last.id;
      }
      return deps.getRootGroup()?.id || "";
    }

    /**
     * 把历史项固化为持久化快捷卡片（写入目标分组并持久化 + 触发同步）。
     * @param {{title?:string, url:string}} node 历史条目
     * @param {string} targetGroupId 目标分组 ID
     */
    async function addHistoryToShortcuts(node, targetGroupId) {
      if (!node?.url) return;
      const safeUrl = normalizeUrl(node.url);
      if (!safeUrl) {
        deps.toast(deps.t("error.invalidUrlSimple"), "error");
        return;
      }
      const targetGroup = deps.getRootContainerById(targetGroupId);
      if (!targetGroup) {
        deps.toast(deps.t("group.notFound"), "error");
        return;
      }
      const data = deps.getData();
      deps.pushBackup();
      let title = node.title || "";
      if (!title) {
        try {
          title = new URL(safeUrl).hostname;
        } catch (_e) {
          title = "";
        }
      }
      const item = createItemNode({ url: safeUrl, title, iconType: "auto", iconPending: true });
      data.nodes[item.id] = item;
      const targetList = deps.getPlacementList(targetGroup);
      targetList.push(item.id);
      deps.setPlacementList(targetGroup, targetList);
      await deps.persistData();
      deps.render();
      deps.processPendingIconFetches();
      deps.toast(deps.t("toast.addedToShortcuts"));
    }

    /** 固化到首选分组（无分组可用时提示） */
    async function addHistoryToDefaultGroup(node) {
      if (!node?.url) return;
      const targetGroupId = getPreferredGroupIdForNewItem();
      if (!targetGroupId) {
        deps.toast(deps.t("group.noneAvailable"), "warning");
        return;
      }
      return addHistoryToShortcuts(node, targetGroupId);
    }

    /** 弹窗选择目标分组后固化 */
    function openAddToGroupModal(node) {
      if (!node?.url) return;
      if (!deps.getRootGroup()) {
        deps.toast(deps.t("group.noneAvailable"), "warning");
        return;
      }
      const options = deps.rawHtml(
        deps
          .getRootContainers()
          .map((g) => deps.html`<option value="${g.id}">${deps.isAllBookmarksGroup(g) ? g.name : g.title}</option>`)
          .join(""),
      );
      const modalHtml = deps.html`
        <h2>${deps.t("context.addToShortcuts")}</h2>
        <div class="section">
          <label>${deps.t("common.selectGroup")}</label>
          <select id="addHistoryGroup">${options}</select>
        </div>
        <div class="actions">
          <button id="btnAddHistoryCancel" class="icon-btn">${deps.t("common.cancel")}</button>
          <button id="btnAddHistorySave" class="icon-btn">${deps.t("common.save")}</button>
        </div>
      `;
      deps.openModal(modalHtml);
      const preferred = getPreferredGroupIdForNewItem();
      const select = document.getElementById("addHistoryGroup");
      if (preferred && select) select.value = preferred;
      document.getElementById("btnAddHistoryCancel")?.addEventListener("click", () => deps.closeModal?.());
      document.getElementById("btnAddHistorySave")?.addEventListener("click", async () => {
        const groupId = select?.value || "";
        await addHistoryToShortcuts(node, groupId);
        deps.closeModal?.();
      });
    }

    return {
      fetchRecentHistory,
      renderHistoryCards,
      addHistoryToShortcuts,
      addHistoryToDefaultGroup,
      openAddToGroupModal,
      getPreferredGroupIdForNewItem,
      get status() {
        return apiStatus;
      },
    };
  }

  return { createHistoryManager, renderHistoryCards };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createHistoryManager = HomepageHistoryManager.createHistoryManager;
export const renderHistoryCards = HomepageHistoryManager.renderHistoryCards;
