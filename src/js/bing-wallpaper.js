import { loadBgCache, saveBgCache } from "./storage.js";

const BING_API = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US";
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

export async function getBingWallpaper() {
  const cache = await loadBgCache();
  const key = todayKey();

  if (cache && cache.dataUrl) {
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
    const res = await fetch(BING_API, { cache: "no-store" });
    const json = await res.json();
    const img = json?.images?.[0];
    if (!img?.url) throw new Error("no bing image");
    const fullUrl = img.url.startsWith("http") ? img.url : `https://www.bing.com${img.url}`;
    const imgRes = await fetch(fullUrl, { cache: "no-store" });
    const blob = await imgRes.blob();
    const dataUrl = await blobToDataUrl(blob);

    const payload = { date: key, url: fullUrl, dataUrl, ts: Date.now() };
    await saveBgCache(payload);
    return { ...payload, fromCache: false };
  } catch (err) {
    if (cache?.dataUrl) return { ...cache, fromCache: true, failed: true };
    return { date: key, url: "", dataUrl: "", failed: true };
  }
}
