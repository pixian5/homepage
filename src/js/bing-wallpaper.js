import { loadBgCache, saveBgCache } from "./storage.js";

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

export async function getBingWallpaper(language = "") {
  const cache = await loadBgCache();
  const key = todayKey();

  if (cache?.dataUrl) {
    const ts = Number(cache.ts || 0);
    const freshByDate = cache.date === key;
    const freshByTtl = ts > 0 && Date.now() - ts < CACHE_TTL_MS;
    if (freshByDate || freshByTtl) {
      if (!cache.ts) {
        cache.ts = Date.now();
        await saveBgCache(cache);
      }
      return { ...cache, fromCache: true };
    }
  }

  try {
    const res = await fetchWithTimeout(buildBingApiUrl(language), { cache: "no-store" });
    if (!res.ok) throw new Error(`bing api http ${res.status}`);
    const json = await res.json();
    const img = json?.images?.[0];
    if (!img?.url) throw new Error("no bing image");
    const fullUrl = img.url.startsWith("http") ? img.url : `https://www.bing.com${img.url}`;
    const imgRes = await fetchWithTimeout(fullUrl, { cache: "no-store" });
    if (!imgRes.ok) throw new Error(`bing image http ${imgRes.status}`);
    const blob = await imgRes.blob();
    const dataUrl = await blobToDataUrl(blob);

    const payload = { date: key, url: fullUrl, dataUrl, ts: Date.now() };
    await saveBgCache(payload);
    return { ...payload, fromCache: false };
  } catch (_err) {
    if (cache?.dataUrl) return { ...cache, fromCache: true, failed: true };
    return { date: key, url: "", dataUrl: "", failed: true };
  }
}
