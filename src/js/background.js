/**
 * 扩展后台：记录最近访问（Safari 无 history API 时的回退数据源）
 * Chrome/Firefox 也加载，作为 history 的补充无害。
 */
import { initVisitTrackingInBackground } from "./visit-history.js";

const BING_API_URL = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1";

function bingApiUrl(language) {
  const market =
    language === "zh-CN" ? "zh-CN" : language === "zh-TW" ? "zh-TW" : language === "en" ? "en-US" : "en-US";
  return `${BING_API_URL}&mkt=${encodeURIComponent(market)}`;
}

function toDataUrl(buffer, contentType) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${contentType || "image/jpeg"};base64,${btoa(binary)}`;
}

async function fetchBingWallpaper(language) {
  const metadata = await fetch(bingApiUrl(language), { cache: "no-store" });
  if (!metadata.ok) throw new Error(`bing api http ${metadata.status}`);
  const json = await metadata.json();
  const rawUrl = json?.images?.[0]?.url;
  if (!rawUrl) throw new Error("no bing image");
  const imageUrl = rawUrl.startsWith("//")
    ? `https:${rawUrl}`
    : rawUrl.startsWith("/")
      ? `https://www.bing.com${rawUrl}`
      : /^https?:\/\//i.test(rawUrl)
        ? rawUrl
        : `https://www.bing.com/${rawUrl.replace(/^\/+/, "")}`;
  const image = await fetch(imageUrl, { cache: "no-store" });
  if (!image.ok) throw new Error(`bing image http ${image.status}`);
  return { url: imageUrl, dataUrl: toDataUrl(await image.arrayBuffer(), image.headers.get("content-type")) };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "homepage.fetchBingWallpaper") return undefined;
    fetchBingWallpaper(message.language)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "bing_fetch_failed" }));
    return true;
  });
}

try {
  initVisitTrackingInBackground();
} catch (e) {
  console.warn("background init failed", e);
}
