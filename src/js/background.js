/**
 * 扩展后台：记录最近访问（Safari 无 history API 时的回退数据源）
 * Chrome/Firefox 也加载，作为 history 的补充无害。
 */
import { createItemNode } from "./data-utils.js";
import { writeSafariStableHomepage } from "./safari_native_storage.js";
import { getOrCreateDeviceId } from "./sync_ids.js";
import { nextSyncTimestamp } from "./sync_policy.js";
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

function queryActiveTab() {
  if (!chrome.tabs?.query) return Promise.resolve(null);
  const query = { active: true, lastFocusedWindow: true };
  const pickWebTab = (tabs) =>
    (Array.isArray(tabs) ? tabs : []).find((tab) => {
      const url = String(tab?.url || "");
      return Number.isInteger(tab?.id) && !/^(?:chrome|edge|about|safari-web-extension):/i.test(url);
    }) || null;
  return new Promise((resolve) => {
    try {
      const result = chrome.tabs.query(query, (tabs) => {
        if (chrome.runtime?.lastError) return resolve(null);
        resolve(pickWebTab(tabs));
      });
      if (typeof result?.then === "function")
        result.then((tabs) => resolve(pickWebTab(tabs))).catch(() => resolve(null));
    } catch (_error) {
      resolve(null);
    }
  });
}

function isWebTab(tab) {
  const url = String(tab?.url || "");
  return Number.isInteger(tab?.id) && !/^(?:chrome|edge|about|safari-web-extension):/i.test(url);
}

function queryWebTabById(tabId) {
  if (!Number.isInteger(tabId) || !chrome.tabs?.get) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const result = chrome.tabs.get(tabId, (tab) =>
        resolve(chrome.runtime?.lastError ? null : isWebTab(tab) ? tab : null),
      );
      if (typeof result?.then === "function")
        result.then((tab) => resolve(isWebTab(tab) ? tab : null)).catch(() => resolve(null));
    } catch (_error) {
      resolve(null);
    }
  });
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

/**
 * 将网页侧栏传入的当前标签页写入目标分组或文件夹，并保持 node/容器时钟与 placementClock 单调一致。
 * @param {object} data
 * @param {{ folderId: string, url: string, title?: string, deviceId?: string, now?: number }} params
 * @returns {{ ok: true, node: object } | { ok: false, error: string }}
 */
export function addBookmarkToFolderInData(data, { folderId, url, title, deviceId, now = Date.now() }) {
  const targetId = String(folderId || "");
  const cleanUrl = String(url || "");
  if (!targetId || !/^https?:\/\//i.test(cleanUrl)) {
    return { ok: false, error: "invalid_url" };
  }
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  const container = groups.find((group) => group?.id === targetId) || data?.nodes?.[targetId];
  if (
    !data?.nodes ||
    !container ||
    container.deletedAt ||
    container.purgedAt ||
    (container.type && container.type !== "folder")
  ) {
    return { ok: false, error: "no_folder" };
  }
  const ts = nextSyncTimestamp(
    now,
    data.lastUpdated,
    container.updatedAt,
    container.titleUpdatedAt,
    container.nameUpdatedAt,
    container.orderUpdatedAt,
  );
  const node = createItemNode({ url: cleanUrl, title: title || cleanUrl, iconType: "auto", iconPending: true });
  node.createdAt = ts;
  node.updatedAt = ts;
  node.titleUpdatedAt = ts;
  node.urlUpdatedAt = ts;
  if (deviceId) node.updatedBy = deviceId;
  data.nodes[node.id] = node;
  const isGroup = Array.isArray(container.nodes);
  const list = isGroup
    ? container.nodes
    : Array.isArray(container.children)
      ? container.children
      : (container.children = []);
  list.push(node.id);
  container.updatedAt = ts;
  if (deviceId) container.updatedBy = deviceId;
  if (!data._syncMeta || typeof data._syncMeta !== "object") data._syncMeta = {};
  if (!data._syncMeta.placementClock || typeof data._syncMeta.placementClock !== "object") {
    data._syncMeta.placementClock = {};
  }
  data._syncMeta.placementClock[node.id] = {
    parentKind: isGroup ? "group" : "folder",
    parentId: container.id,
    index: list.indexOf(node.id),
    updatedAt: ts,
    updatedBy: deviceId,
  };
  data.lastUpdated = ts;
  return { ok: true, node };
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
      void getOrCreateDeviceId()
        .then((deviceId) =>
          chrome.storage.local.get("homepage_data", (result) => {
            if (chrome.runtime?.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message || "storage_read_failed" });
              return;
            }
            const data = result?.homepage_data;
            const added = addBookmarkToFolderInData(data, {
              folderId,
              url,
              title: tab?.title || url,
              deviceId,
            });
            if (!added.ok) {
              sendResponse({ ok: false, error: added.error });
              return;
            }
            chrome.storage.local.set({ homepage_data: data }, () =>
              sendResponse(
                chrome.runtime?.lastError
                  ? { ok: false, error: chrome.runtime.lastError.message }
                  : { ok: true, node: added.node, folderId },
              ),
            );
          }),
        )
        .catch((error) => sendResponse({ ok: false, error: error?.message || "save_failed" }));
      return true;
    }
    if (message?.type === "homepage_open_bookmark") {
      const url = String(message.url || "");
      const settings = message.settings || {};
      if (!/^(?:https?|ftp):\/\//i.test(url)) {
        sendResponse({ ok: false, error: "invalid_url" });
        return false;
      }
      const mode = settings.openMode || "current";
      const senderTabId = _sender?.tab?.id;
      const senderUrl = String(_sender?.tab?.url || "");
      const senderIsWebTab = senderUrl && !/^(?:chrome|edge|about|safari-web-extension):/i.test(senderUrl);
      const requestedTabId =
        senderIsWebTab && Number.isInteger(senderTabId)
          ? senderTabId
          : Number.isInteger(message.tabId)
            ? message.tabId
            : undefined;
      const open = (tabId) => {
        if (mode === "new" || mode === "background" || !Number.isInteger(tabId)) {
          return chrome.tabs.create({ url, ...(mode === "background" ? { active: false } : {}) });
        }
        return chrome.tabs.update(tabId, { url });
      };
      const target = requestedTabId
        ? queryWebTabById(requestedTabId)
            .then((tab) => tab?.id)
            .then((id) => id || queryActiveTab().then((tab) => tab?.id))
        : queryActiveTab().then((tab) => tab?.id);
      Promise.resolve(target)
        .then((tabId) => open(tabId))
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
