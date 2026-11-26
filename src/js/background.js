/**
 * 扩展后台：记录最近访问（Safari 无 history API 时的回退数据源）
 * Chrome/Firefox 也加载，作为 history 的补充无害。
 */
import { createItemNode } from "./data-utils.js";
import { writeSafariStableHomepage } from "./safari_native_storage.js";
import { callExtensionApi, getChromeApi } from "./shared-utils.js";
import { getOrCreateDeviceId } from "./sync_ids.js";
import { nextSyncTimestamp } from "./sync_policy.js";
import { initVisitTrackingInBackground } from "./visit-history.js";

const BING_API_URL = "https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1";
const RESTRICTED_TAB_URL_RE = /^(?:chrome|edge|about|safari-web-extension):/i;
let _bookmarkWriteChain = Promise.resolve();

function isWebTabUrl(url) {
  return !RESTRICTED_TAB_URL_RE.test(String(url || ""));
}

function isWebTab(tab) {
  return Number.isInteger(tab?.id) && isWebTabUrl(tab?.url);
}

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

async function queryActiveTab() {
  const api = getChromeApi();
  if (!api?.tabs?.query) return null;
  try {
    const tabs = await callExtensionApi(api, api.tabs, "query", [{ active: true, lastFocusedWindow: true }]);
    return (Array.isArray(tabs) ? tabs : []).find((tab) => isWebTab(tab)) || null;
  } catch (_error) {
    return null;
  }
}

async function queryWebTabById(tabId) {
  const api = getChromeApi();
  if (!Number.isInteger(tabId) || !api?.tabs?.get) return null;
  try {
    const tab = await callExtensionApi(api, api.tabs, "get", [tabId]);
    return isWebTab(tab) ? tab : null;
  } catch (_error) {
    return null;
  }
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

function serializeBookmarkWrite(task) {
  const next = _bookmarkWriteChain.then(task, task);
  _bookmarkWriteChain = next.catch(() => {});
  return next;
}

const _bgApi = getChromeApi();
if (_bgApi?.runtime?.onMessage) {
  _bgApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const api = getChromeApi();
    if (message?.type === "homepage_add_bookmark_to_folder") {
      const tab = _sender?.tab;
      const folderId = String(message.folderId || "");
      const url = String(tab?.url || "");
      if (!folderId || !/^https?:\/\//i.test(url)) {
        sendResponse({ ok: false, error: "invalid_url" });
        return false;
      }
      void serializeBookmarkWrite(async () => {
        if (!api?.storage?.local) return { ok: false, error: "no_storage" };
        const deviceId = await getOrCreateDeviceId().catch(() => "");
        const result = await callExtensionApi(api, api.storage.local, "get", ["homepage_data"]);
        const data = result?.homepage_data;
        const added = addBookmarkToFolderInData(data, {
          folderId,
          url,
          title: tab?.title || url,
          deviceId,
        });
        if (!added.ok) return { ok: false, error: added.error };
        await callExtensionApi(api, api.storage.local, "set", [{ homepage_data: data }]);
        return { ok: true, node: added.node, folderId };
      })
        .then((reply) => sendResponse(reply))
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
      const senderIsWebTab = senderUrl && isWebTabUrl(senderUrl);
      const requestedTabId =
        senderIsWebTab && Number.isInteger(senderTabId)
          ? senderTabId
          : Number.isInteger(message.tabId)
            ? message.tabId
            : undefined;
      const open = (tabId) => {
        if (mode === "new" || mode === "background" || !Number.isInteger(tabId)) {
          return callExtensionApi(api, api?.tabs, "create", [
            { url, ...(mode === "background" ? { active: false } : {}) },
          ]);
        }
        return callExtensionApi(api, api?.tabs, "update", [tabId, { url }]);
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

if (_bgApi?.storage?.onChanged) {
  _bgApi.storage.onChanged.addListener((changes, areaName) => {
    const next = changes?.homepage_data?.newValue;
    if (areaName === "local" && next && typeof next === "object") {
      void writeSafariStableHomepage(next);
    }
  });
}
