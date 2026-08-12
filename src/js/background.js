/**
 * 扩展后台：记录最近访问（Safari 无 history API 时的回退数据源）
 * Chrome/Firefox 也加载，作为 history 的补充无害。
 */
import { createItemNode } from "./data-utils.js";
import { writeSafariStableHomepage } from "./safari_native_storage.js";
import { getOrCreateDeviceId } from "./sync_ids.js";
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
    if (message?.type === "homepage_add_bookmark_to_folder") {
      const tab = _sender?.tab;
      const folderId = String(message.folderId || "");
      const url = String(tab?.url || "");
      if (!folderId || !/^https?:\/\//i.test(url)) {
        sendResponse({ ok: false, error: "invalid_url" });
        return false;
      }
      void getOrCreateDeviceId().then((deviceId) =>
        chrome.storage.local.get("homepage_data", (result) => {
          const data = result?.homepage_data;
          const container = data?.groups?.find((group) => group.id === folderId) || data?.nodes?.[folderId];
          if (!data?.nodes || !container || (container.type && container.type !== "folder")) {
            sendResponse({ ok: false, error: "no_folder" });
            return;
          }
          const now = Date.now();
          const node = createItemNode({ url, title: tab.title || url, iconType: "auto", iconPending: true });
          data.nodes[node.id] = node;
          if (Array.isArray(container.nodes)) container.nodes.push(node.id);
          else {
            if (!Array.isArray(container.children)) container.children = [];
            container.children.push(node.id);
          }
          container.updatedAt = now;
          if (!data._syncMeta || typeof data._syncMeta !== "object") data._syncMeta = {};
          if (!data._syncMeta.placementClock || typeof data._syncMeta.placementClock !== "object") {
            data._syncMeta.placementClock = {};
          }
          const list = Array.isArray(container.nodes) ? container.nodes : container.children;
          data._syncMeta.placementClock[node.id] = {
            parentKind: Array.isArray(container.nodes) ? "group" : "folder",
            parentId: container.id,
            index: list.indexOf(node.id),
            updatedAt: now,
            updatedBy: deviceId,
          };
          data.lastUpdated = now;
          chrome.storage.local.set({ homepage_data: data }, () => sendResponse({ ok: !chrome.runtime.lastError }));
        }),
      );
      return true;
    }
    if (message?.type === "homepage_open_bookmark") {
      const url = String(message.url || "");
      const settings = message.settings || {};
      if (!/^https?:\/\//i.test(url)) {
        sendResponse({ ok: false, error: "invalid_url" });
        return false;
      }
      const mode = settings.openMode || "current";
      const tabId = _sender?.tab?.id;
      const action =
        mode === "new" || !tabId
          ? chrome.tabs.create({ url })
          : mode === "background"
            ? chrome.tabs.create({ url, active: false })
            : chrome.tabs.update(tabId, { url });
      Promise.resolve(action)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || "open_failed" }));
      return true;
    }
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

if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const next = changes?.homepage_data?.newValue;
    if (areaName === "local" && next && typeof next === "object") {
      void writeSafariStableHomepage(next);
    }
  });
}
