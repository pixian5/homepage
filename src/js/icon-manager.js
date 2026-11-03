/**
 * 图标管线管理器（从 app.js 拆出，解耦第三阶段）。
 *
 * 职责：卡片图标的完整生命周期——字母头像占位、缓存解析、候选回退链、
 * 失败标记与退避、旧缓存迁移 dataURL、后台补抓、标题补抓、批量刷新。
 * 底层能力复用 icons.js（候选生成/探测/抓取/并发信号量）与 storage.js（图标缓存）。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import {
  applyFailureToCache,
  avatarDataUrl,
  fetchAsDataUrl,
  getFaviconCandidates,
  getSiteKey,
  hashColor,
  probeImage,
  refreshAllIcons,
  resolveIcon,
  withIconFetchConcurrency,
} from "./icons.js";
import { getChromeApi } from "./shared-utils.js";
import { loadIconCache, saveIconCache } from "./storage.js";

var HomepageIconManager = (() => {
  /**
   * 失败图标是否应重试（纯函数，供调度判定与单测）：
   * - 未配置重试小时（空/非法）→ 永不重试；
   * - 失败时间未知 → 允许重试；
   * - 失败当天不重试（已试过）；次日起，到达配置小时后允许重试。
   * @param {number} failedAt 上次失败时间戳（毫秒）
   * @param {number|string} retryHour 每日重试小时（0-23；""/undefined 表示禁用）
   * @param {number} [now] 当前时间戳
   * @returns {boolean}
   */
  function shouldRetryFailedIcon(failedAt, retryHour, now = Date.now()) {
    // 注意 Number("") === 0：空串（未配置）必须显式排除，否则会被当成“每天 0 点重试”
    if (retryHour === "" || retryHour === null || retryHour === undefined) return false;
    const hour = Number(retryHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
    const failed = Number(failedAt);
    if (!Number.isFinite(failed) || failed <= 0) return true;
    if (now <= failed) return false;
    const failedDate = new Date(failed);
    const nowDate = new Date(now);
    const sameDay =
      failedDate.getFullYear() === nowDate.getFullYear() &&
      failedDate.getMonth() === nowDate.getMonth() &&
      failedDate.getDate() === nowDate.getDate();
    if (sameDay) return false;
    return nowDate.getHours() >= hour;
  }

  /** 进行中的旧缓存迁移 URL 集合（防同一站点并发迁移） */
  const _migratingIcons = new Set();

  /**
   * @param {{
   *   getData: () => object,
   *   persistData: () => Promise<void>,
   *   render: () => void,
   *   stampNodeFieldChanges?: (node: object, changes: object) => void,
   *   probeTimeoutMs?: number,
   *   titleTimeoutMs?: number,
   * }} deps
   */
  function createIconManager(deps) {
    const probeTimeoutMs = Number(deps.probeTimeoutMs) > 0 ? Number(deps.probeTimeoutMs) : 6000;
    const titleTimeoutMs = Number(deps.titleTimeoutMs) > 0 ? Number(deps.titleTimeoutMs) : 6000;

    /** Canvas 首字彩色头像（无图标时的占位/最终兜底） */
    function generateLetterAvatar(text, color) {
      const base = text || "?";
      return avatarDataUrl(base, color || hashColor(base));
    }

    /**
     * 解析节点应显示的图标 URL（或 dataURL / 字母头像）。
     * 文件夹与无 URL 节点直接用字母头像；其余走 icons.js 的缓存解析。
     * @param {object} node
     * @param {object} [preloadedCache] 预加载的图标缓存（渲染批次共享，避免逐 tile 读存储）
     */
    async function resolveIconUrl(node, preloadedCache = null) {
      if (!node) return generateLetterAvatar("?");
      if (node.type === "folder" || !node.url) return generateLetterAvatar(node.title || node.id || "?", node.color);
      return resolveIcon(node, deps.getData()?.settings, preloadedCache);
    }

    function probeImageWithIconTimeout(url) {
      // 复用 icons.js 的 probeImage（带 done 守卫与超时），仅注入本模块的超时常量
      return probeImage(url, 16, probeTimeoutMs);
    }

    async function markIconLoadFailed(url) {
      if (!url) return;
      const cache = await loadIconCache();
      applyFailureToCache(cache, url, cache[url]);
      const siteKey = getSiteKey(url);
      if (siteKey) applyFailureToCache(cache, siteKey, cache[siteKey]);
      await saveIconCache(cache);
    }

    /**
     * 渲染期候选回退：img 加载失败后按候选顺序换下一个可用 favicon。
     * 在全局并发信号量内串行尝试，避免一次渲染 N 个 tile 全部并发触发请求风暴。
     */
    async function trySwitchToNextFavicon(url, triedCandidates) {
      if (!url) return "";
      const candidates = getFaviconCandidates(url);
      if (!candidates.length) return "";
      return withIconFetchConcurrency(async () => {
        const cache = await loadIconCache();
        const siteKey = getSiteKey(url);
        for (const candidate of candidates) {
          if (triedCandidates.has(candidate)) continue;
          triedCandidates.add(candidate);
          const ok = await probeImageWithIconTimeout(candidate);
          if (!ok) continue;
          // 抓取为 dataURL 后缓存，下次打开页面可瞬显
          const dataUrl = await fetchAsDataUrl(candidate);
          if (dataUrl) {
            cache[url] = { dataUrl, ts: Date.now() };
            if (siteKey) cache[siteKey] = { dataUrl, ts: Date.now() };
            await saveIconCache(cache);
            return dataUrl;
          }
          // dataURL 化失败时退回远程 URL
          cache[url] = { url: candidate, ts: Date.now() };
          if (siteKey) cache[siteKey] = { url: candidate, ts: Date.now() };
          await saveIconCache(cache);
          return candidate;
        }
        return "";
      });
    }

    /**
     * 旧缓存只有远程 URL（{ url }）：后台异步抓取为 dataURL 并更新缓存，
     * 成功后直接更新 img.src，避免全量 render 闪烁。
     */
    async function migrateIconCacheToDataUrl(node, img) {
      if (!node?.url || node.iconType !== "auto" || _migratingIcons.has(node.url)) return;
      _migratingIcons.add(node.url);
      try {
        const cache = await loadIconCache();
        const siteKey = getSiteKey(node.url);
        const entry = (siteKey && cache[siteKey]) || cache[node.url];
        if (!entry || entry.dataUrl || !entry.url) return;
        const dataUrl = await fetchAsDataUrl(entry.url);
        if (!dataUrl) return;
        cache[node.url] = { dataUrl, ts: Date.now() };
        if (siteKey) cache[siteKey] = { dataUrl, ts: Date.now() };
        await saveIconCache(cache);
        if (img?.isConnected) img.src = dataUrl;
      } finally {
        _migratingIcons.delete(node.url);
      }
    }

    /**
     * 绑定卡片图标：先字母头像占位，缓存解析后异步替换；
     * 远程 URL 失败时按候选回退，全部失败则标记失败并回到字母头像。
     * @param {HTMLImageElement} img
     * @param {object} node
     * @param {{cache?: object, isStale?: () => boolean}} [opts]
     *   isStale：渲染批次已过期（seq 不匹配）时放弃更新 DOM
     */
    function bindTileIcon(img, node, opts = {}) {
      const fallback = generateLetterAvatar(node.title || node.url || "?", node.color);
      img.src = fallback;
      void resolveIconUrl(node, opts.cache).then((iconSrc) => {
        if (opts.isStale?.() || !img.isConnected) return;
        img.src = iconSrc;
        const settings = deps.getData()?.settings;
        if (node.url && settings?.iconFetch && !iconSrc.startsWith("data:")) {
          const triedCandidates = new Set([iconSrc]);
          const tryNext = async () => {
            const nextIcon = await trySwitchToNextFavicon(node.url, triedCandidates);
            if (nextIcon) {
              img.src = nextIcon;
              return;
            }
            img.onerror = null;
            img.onload = null;
            img.src = fallback;
            await markIconLoadFailed(node.url);
          };
          img.onerror = tryNext;
          img.onload = () => {
            if (img.naturalWidth < 16 && img.naturalHeight < 16) {
              tryNext();
            }
          };
          // 旧缓存只有远程 URL，后台异步抓取为 dataURL 更新缓存
          void migrateIconCacheToDataUrl(node, img);
        }
      });
    }

    /**
     * 立即抓取一次 favicon（编辑卡片对话框用）：
     * 只写图标缓存，不改 node、不 persist——「取消」后不落盘。
     */
    async function fetchFaviconNow(nodeId, url) {
      const candidates = getFaviconCandidates(url);
      if (!candidates.length) return false;
      return withIconFetchConcurrency(async () => {
        const cache = await loadIconCache();
        const siteKey = getSiteKey(url);
        for (const candidate of candidates) {
          const dataUrl = await fetchAsDataUrl(candidate);
          if (!dataUrl) continue;
          cache[url] = { dataUrl, ts: Date.now() };
          if (siteKey) cache[siteKey] = { dataUrl, ts: Date.now() };
          await saveIconCache(cache);
          const target = deps.getData()?.nodes?.[nodeId];
          // 仅当抓取的就是当前已保存 URL 时，清 pending 标记（仍不 persist，由调用方决定）
          if (target && target.url === url) {
            target.iconPending = false;
          }
          return true;
        }
        applyFailureToCache(cache, url, cache[url]);
        if (siteKey) applyFailureToCache(cache, siteKey, cache[siteKey]);
        await saveIconCache(cache);
        return false;
      });
    }

    /** 后台补抓 pending 图标：成功/失败都会清 iconPending 并持久化 */
    async function fetchFaviconInBackground(nodeId, url) {
      if (!deps.getData()?.settings?.iconFetch) return;
      const candidates = getFaviconCandidates(url);
      if (!candidates.length) return;
      // 在全局并发信号量内串行尝试候选，避免多节点并发抓取触发请求风暴
      await withIconFetchConcurrency(async () => {
        const cache = await loadIconCache();
        const siteKey = getSiteKey(url);
        for (const candidate of candidates) {
          const ok = await probeImageWithIconTimeout(candidate);
          if (!ok) continue;
          const dataUrl = await fetchAsDataUrl(candidate);
          cache[url] = dataUrl ? { dataUrl, ts: Date.now() } : { url: candidate, ts: Date.now() };
          if (siteKey) cache[siteKey] = { ...cache[url] };
          await saveIconCache(cache);
          const target = deps.getData()?.nodes?.[nodeId];
          if (target) target.iconPending = false;
          await deps.persistData();
          deps.render();
          return;
        }
        const target = deps.getData()?.nodes?.[nodeId];
        if (target) {
          target.iconPending = false;
          // 全部候选失败：按失败次数退避（首次 15min，递增封顶 7 天）
          applyFailureToCache(cache, url, cache[url]);
          if (siteKey) applyFailureToCache(cache, siteKey, cache[siteKey]);
          await saveIconCache(cache);
          await deps.persistData();
          deps.render();
        }
      });
    }

    /** 处理所有 iconPending 节点（导入/新增后调用） */
    function processPendingIconFetches() {
      const data = deps.getData();
      if (!data?.settings?.iconFetch || !data?.nodes) return;
      for (const node of Object.values(data.nodes)) {
        if (node?.type === "item" && node.iconPending && node.url) {
          void fetchFaviconInBackground(node.id, node.url);
        }
      }
    }

    /** 纯 Web / 无 tabs 环境返回空串（安全降级） */
    function fetchTitleViaTab(url) {
      const api = getChromeApi();
      if (!api?.tabs) return Promise.resolve("");
      return new Promise((resolve) => {
        api.tabs.create({ url, active: false }, (tab) => {
          if (!tab?.id) return resolve("");
          const tabId = tab.id;
          const timeout = setTimeout(() => finish(""), titleTimeoutMs);
          const finish = (title) => {
            clearTimeout(timeout);
            api.tabs.onUpdated.removeListener(onUpdated);
            api.tabs.remove(tabId, () => resolve(title || ""));
          };
          const onUpdated = (id, info, updatedTab) => {
            if (id === tabId && info.status === "complete") {
              finish(updatedTab?.title || "");
            }
          };
          try {
            api.tabs.onUpdated.addListener(onUpdated);
          } catch (_e) {
            finish("");
          }
        });
      });
    }

    /** 后台补抓标题：通过静默标签页读取页面 title 后回写节点 */
    async function fetchTitleInBackground(nodeId, url) {
      const title = await fetchTitleViaTab(url);
      if (!title) return;
      const target = deps.getData()?.nodes?.[nodeId];
      if (!target?.titlePending) return;
      deps.stampNodeFieldChanges?.(target, { titleChanged: true });
      target.title = title;
      target.titlePending = false;
      await deps.persistData();
      deps.render();
    }

    /** 批量刷新全部节点图标（复用 icons.js 的 6 路并发控制）并重渲染 */
    async function batchRefreshAllIcons(nodes) {
      await refreshAllIcons(Array.isArray(nodes) ? nodes : Object.values(deps.getData()?.nodes || {}));
      deps.render();
    }

    return {
      generateLetterAvatar,
      resolveIconUrl,
      bindTileIcon,
      markIconLoadFailed,
      trySwitchToNextFavicon,
      migrateIconCacheToDataUrl,
      fetchFaviconNow,
      fetchFaviconInBackground,
      processPendingIconFetches,
      fetchTitleInBackground,
      batchRefreshAllIcons,
    };
  }

  return { createIconManager, shouldRetryFailedIcon };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createIconManager = HomepageIconManager.createIconManager;
export const shouldRetryFailedIcon = HomepageIconManager.shouldRetryFailedIcon;
