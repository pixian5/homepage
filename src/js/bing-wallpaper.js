import { getChromeApi, loadBgCache, saveBgCache } from "./storage.js";

const BING_API_BASE = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1";
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

function buildBingApiUrl(language) {
  const mktMap = {
    "zh-CN": "zh-CN",
    "zh-TW": "zh-TW",
    en: "en-US",
  };
  const mkt = mktMap[language] || "en-US";
  return `${BING_API_BASE}&mkt=${encodeURIComponent(mkt)}`;
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (reader.error) reject(reader.error);
      else resolve(reader.result);
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function fetchViaBackground(language) {
  const api = getChromeApi();
  if (!api?.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), 20000);
    try {
      const result = api.runtime.sendMessage({ type: "homepage.fetchBingWallpaper", language }, (response) => {
        clearTimeout(timer);
        finish(response);
      });
      if (result && typeof result.then === "function") {
        result.then(
          (response) => {
            clearTimeout(timer);
            finish(response);
          },
          () => {
            clearTimeout(timer);
            finish(null);
          },
        );
      }
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

async function fetchAndSaveBingWallpaper(language, key, fallbackCache = null) {
  try {
    let fullUrl = "";
    let dataUrl = "";
    try {
      const res = await fetchWithTimeout(buildBingApiUrl(language), { cache: "no-store" });
      if (!res.ok) throw new Error(`bing api http ${res.status}`);
      const json = await res.json();
      const img = json?.images?.[0];
      if (!img?.url) throw new Error("no bing image");
      fullUrl = img.url || "";
      if (fullUrl.startsWith("//")) fullUrl = `https:${fullUrl}`;
      else if (fullUrl.startsWith("/")) fullUrl = `https://www.bing.com${fullUrl}`;
      else if (!/^https?:\/\//i.test(fullUrl)) fullUrl = `https://www.bing.com/${fullUrl.replace(/^\/+/, "")}`;
      const imgRes = await fetchWithTimeout(fullUrl, { cache: "no-store" });
      if (!imgRes.ok) throw new Error(`bing image http ${imgRes.status}`);
      dataUrl = await blobToDataUrl(await imgRes.blob());
    } catch (directError) {
      const background = await fetchViaBackground(language);
      if (!background?.ok || !background.dataUrl) throw directError;
      fullUrl = background.url || "";
      dataUrl = background.dataUrl;
    }

    const payload = { date: key, language, url: fullUrl, dataUrl, ts: Date.now() };
    await saveBgCache(payload);
    return { ...payload, fromCache: false };
  } catch (_err) {
    if (fallbackCache?.dataUrl) return { ...fallbackCache, fromCache: true, failed: true };
    return { date: key, language, url: "", dataUrl: "", failed: true };
  }
}

export async function getBingWallpaper(language = "", options = {}) {
  const cache = await loadBgCache();
  const key = todayKey();
  const normalizedLang = String(language || "zh-CN");

  if (cache?.dataUrl) {
    const ts = Number(cache.ts || 0);
    const sameLang = !cache.language || cache.language === normalizedLang;
    const freshByDate = cache.date === key && sameLang;
    const freshByTtl = ts > 0 && Date.now() - ts < CACHE_TTL_MS && sameLang;
    if (freshByDate || freshByTtl) {
      if (!cache.ts || !cache.language) {
        cache.ts = cache.ts || Date.now();
        cache.language = normalizedLang;
        await saveBgCache(cache);
      }
      return { ...cache, fromCache: true };
    }

    // Stale-While-Revalidate（SWR）：若外部注入了 onUpdated 回调，且本地已有一份旧壁纸，
    // 则先瞬时（0ms）返回旧壁纸供首屏快速呈现，彻底消灭纯色与白屏等待；
    // 后台异步静默拉取今日新壁纸，拉取成功且内容更新后触发 onUpdated 平滑替换。
    if (typeof options?.onUpdated === "function" && !options?.forceRefresh) {
      void fetchAndSaveBingWallpaper(normalizedLang, key, cache)
        .then((fresh) => {
          if (fresh?.dataUrl && fresh.dataUrl !== cache.dataUrl) {
            options.onUpdated(fresh);
          }
        })
        .catch((err) => {
          console.warn("background bing wallpaper revalidation failed", err);
        });
      return { ...cache, fromCache: true, stale: true };
    }
  }

  return await fetchAndSaveBingWallpaper(normalizedLang, key, cache);
}
