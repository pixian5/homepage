import { loadBgCache, saveBgCache } from "./storage.js";

const BING_API_ORIGINS = ["https://www.bing.com", "https://cn.bing.com", "https://global.bing.com"];
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

function buildBingApiUrls(language) {
  const mktMap = {
    "zh-CN": "zh-CN",
    "zh-TW": "zh-TW",
    en: "en-US",
  };
  const mkt = mktMap[language] || "en-US";
  return BING_API_ORIGINS.map(
    (origin) => `${origin}/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=${encodeURIComponent(mkt)}`,
  );
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

async function fetchBingMetadata(language) {
  const failures = [];
  for (const apiUrl of buildBingApiUrls(language)) {
    try {
      const res = await fetchWithTimeout(apiUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`metadata_http_${res.status}`);
      const json = await res.json();
      const image = json?.images?.[0];
      if (!image?.url) throw new Error("metadata_missing_image");
      return { apiUrl, image };
    } catch (error) {
      failures.push(error?.name === "AbortError" ? "metadata_timeout" : error?.message || "metadata_failed");
    }
  }
  throw new Error(failures.join(",") || "metadata_failed");
}

function imageUrlFor(apiUrl, rawUrl) {
  try {
    return new URL(String(rawUrl || ""), apiUrl).href;
  } catch {
    throw new Error("invalid_image_url");
  }
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
    const { apiUrl, image } = await fetchBingMetadata(language);
    const fullUrl = imageUrlFor(apiUrl, image.url);
    const imgRes = await fetchWithTimeout(fullUrl, { cache: "no-store" });
    if (!imgRes.ok) throw new Error(`bing image http ${imgRes.status}`);
    const blob = await imgRes.blob();
    const dataUrl = await blobToDataUrl(blob);

    const payload = { date: key, url: fullUrl, dataUrl, ts: Date.now() };
    await saveBgCache(payload);
    return { ...payload, fromCache: false };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "image_timeout" : error?.message || "wallpaper_failed";
    console.warn("Bing wallpaper fetch failed", reason);
    if (cache?.dataUrl) return { ...cache, fromCache: true, failed: true, reason };
    return { date: key, url: "", dataUrl: "", failed: true, reason };
  }
}
