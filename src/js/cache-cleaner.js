import { getSiteKey } from "./icons.js";
import { loadBgCache, loadIconCache, pruneUnusedCaches, saveBgCache, saveIconCache } from "./storage.js";

/**
 * 静默清理无用图标与背景缓存
 * @param {Object} options
 * @param {Function} options.getData 获取当前内存数据引用
 * @param {Function} [options.pruneCaches] 底层清理函数（默认 pruneUnusedCaches）
 * @param {Function} [options.siteKeyOf] 计算 siteKey（默认 getSiteKey）
 * @param {Function} [options.loadIcon]
 * @param {Function} [options.saveIcon]
 * @param {Function} [options.loadBg]
 * @param {Function} [options.saveBg]
 * @param {Console} [options.logger]
 * @returns {Promise<{ ok: boolean, iconRemoved: number, bgCleared: boolean, error: any }>}
 */
export async function pruneUnusedCachesQuietly(options = {}) {
  const { getData } = options;
  const prune = options.pruneCaches || pruneUnusedCaches;
  const siteKeyOf = options.siteKeyOf || getSiteKey;
  const loadIcon = options.loadIcon || loadIconCache;
  const saveIcon = options.saveIcon || saveIconCache;
  const loadBg = options.loadBg || loadBgCache;
  const saveBg = options.saveBg || saveBgCache;
  const logger = options.logger || console;

  try {
    const data = typeof getData === "function" ? getData() : null;
    const bookmarkUrls = Object.values(data?.nodes || {})
      .filter((n) => n?.type === "item" && typeof n.url === "string" && n.url)
      .map((n) => n.url);

    const res = await prune({
      bookmarkUrls,
      backgroundType: data?.settings?.backgroundType || "",
      siteKeyOf,
      loadIcon,
      saveIcon,
      loadBg,
      saveBg,
    });

    if (res?.iconRemoved > 0 || res?.bgCleared) {
      logger.info(`[homepage] 缓存清理：图标 ${res.iconRemoved || 0} 条，背景缓存${res.bgCleared ? "已清空" : "保留"}`);
    }
    return {
      ok: true,
      iconRemoved: res?.iconRemoved || 0,
      bgCleared: !!res?.bgCleared,
      error: null,
    };
  } catch (e) {
    logger.warn("pruneCachesQuietly failed", e);
    return {
      ok: false,
      iconRemoved: 0,
      bgCleared: false,
      error: e,
    };
  }
}
