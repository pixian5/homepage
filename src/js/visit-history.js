/**
 * 最近访问记录（扩展自建）
 * Safari 不支持 WebExtensions history API，用 tabs 事件 + storage 做回退。
 * Chrome/Firefox 仍优先用 browser.history；此模块作为补充数据源。
 */

import { getChromeApi, getLastError, normalizeUrl, storageArea, storageGet, storageSet } from "./shared-utils.js";

export const VISIT_HISTORY_KEY = "homepage_visit_history";
export const VISIT_HISTORY_LIMIT = 48;
export const VISIT_HISTORY_DAYS = 14;

/**
 * @typedef {{ url: string, title: string, ts: number }} VisitEntry
 */

/**
 * @returns {Promise<VisitEntry[]>}
 */
export async function loadVisitHistory() {
  const area = storageArea(false);
  if (!area) return [];
  const raw = await storageGet(area, VISIT_HISTORY_KEY);
  return Array.isArray(raw) ? raw : [];
}

/**
 * @param {VisitEntry[]} list
 */
export async function saveVisitHistory(list) {
  const area = storageArea(false);
  if (!area) return "no_storage";
  return storageSet(area, { [VISIT_HISTORY_KEY]: list });
}

/**
 * 记录一次访问（按 URL 去重，最新的排前面）
 * 串行化写入，避免多标签页并发 RMW 丢记录（Safari 依赖此数据源）。
 * @param {{ url?: string, title?: string }} tab
 * @returns {Promise<VisitEntry[]>}
 */
let _recordVisitChain = Promise.resolve();

export async function recordVisit(tab) {
  const run = async () => {
    const url = normalizeUrl(tab?.url || "");
    if (!url) return loadVisitHistory();
    let title = String(tab?.title || "").trim();
    if (!title) {
      try {
        title = new URL(url).hostname;
      } catch (_e) {
        title = url;
      }
    }
    const now = Date.now();
    const cutoff = now - VISIT_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const prev = await loadVisitHistory();
    const next = [{ url, title, ts: now }, ...prev.filter((e) => e && e.url !== url && Number(e.ts) >= cutoff)].slice(
      0,
      VISIT_HISTORY_LIMIT,
    );
    await saveVisitHistory(next);
    return next;
  };
  const result = _recordVisitChain.then(run, run);
  _recordVisitChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * 读取用于「历史」分组展示的条目
 * @param {number} [limit]
 * @returns {Promise<Array<{id:string,type:string,title:string,url:string,ts:number}>>}
 */
export async function getVisitHistoryItems(limit = 24) {
  const list = await loadVisitHistory();
  const cutoff = Date.now() - VISIT_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return list
    .filter((e) => e?.url && Number(e.ts) >= cutoff)
    .slice(0, limit)
    .map((e, idx) => ({
      id: `visit_${idx}`,
      type: "history",
      title: e.title || e.url,
      url: e.url,
      ts: e.ts,
    }));
}

/**
 * 在扩展页面（newtab/popup）内挂 tabs 监听，记录访问。
 * Safari 无 background 时也可用；有 background 时双挂无妨（按 URL 去重）。
 * @returns {() => void} dispose
 */
export function attachVisitTracking() {
  const api = getChromeApi();
  if (!api?.tabs?.onUpdated) return () => {};

  const onUpdated = (_tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
    if (!tab?.url) return;
    // fire-and-forget
    recordVisit(tab).catch((e) => console.warn("recordVisit failed", e));
  };

  try {
    api.tabs.onUpdated.addListener(onUpdated);
  } catch (e) {
    console.warn("attachVisitTracking failed", e);
    return () => {};
  }

  return () => {
    try {
      api.tabs.onUpdated.removeListener(onUpdated);
    } catch (_e) {
      // ignore
    }
  };
}

/**
 * 供 background 脚本使用的精简初始化
 */
export function initVisitTrackingInBackground() {
  attachVisitTracking();
  // 启动时也记一下当前活动标签（若可获取）
  const api = getChromeApi();
  if (!api?.tabs?.query) return;
  try {
    const result = api.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const err = getLastError();
      if (err) return;
      const tab = tabs?.[0];
      if (tab) recordVisit(tab).catch(() => {});
    });
    if (result && typeof result.then === "function") {
      result
        .then((tabs) => {
          const tab = tabs?.[0];
          if (tab) return recordVisit(tab);
        })
        .catch(() => {});
    }
  } catch (_e) {
    // ignore
  }
}
