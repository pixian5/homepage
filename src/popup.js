import { collectBookmarkFolders, collectBookmarkTree, getPopupBookmarkRoots } from "./js/bookmark-utils.js";
import { filterSavableTabs, saveSingleTabToContainer, saveTabsToContainer } from "./js/popup-batch-save.js";
import { POPUP_SUPPORTED_LANGUAGES, translatePopupText } from "./js/popup-i18n.js";
import {
  callExtensionApi,
  detectPreferredLanguage,
  getChromeApi,
  normalizeLanguage,
  normalizeUrl,
  storageSet as sharedStorageSet,
  storageArea,
} from "./js/shared-utils.js";
import { getStorageKey, loadData } from "./js/storage.js";
import { getOrCreateDeviceId } from "./js/sync_ids.js";

const ROOT_KEY = getStorageKey();
const MAX_LOG_ENTRIES = 30;
const TOAST_DURATION_MS = 3000;
const DEFAULT_FONT_SIZE = 13;
const TOAST_FONT_STACK = '"Avenir Next", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
const TOAST_STYLE_PROPS = {
  position: "fixed",
  top: "20px",
  right: "20px",
  zIndex: "2147483647",
  background: "rgba(22, 128, 72, 0.92)",
  color: "#ffffff",
  padding: "10px 14px",
  borderRadius: "10px",
  lineHeight: "1.2",
  boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
  backdropFilter: "blur(6px)",
  fontFamily: TOAST_FONT_STACK,
};
let popupLanguage = "zh-CN";

function showPopupError(message) {
  const empty = document.getElementById("empty");
  if (empty) {
    empty.textContent = message;
    empty.classList.remove("hidden");
  }
  document.body.classList.remove("hidden");
}

function tr(key, language, vars = null) {
  return translatePopupText(language, key, vars);
}

function applyPopupI18n(language) {
  document.documentElement.lang = normalizeLanguage(language) || "zh-CN";
  document.title = tr("title", language);
  const title = document.querySelector(".header .title");
  if (title) title.textContent = tr("title", language);
  const menuNav = document.querySelector("nav.bookmark-menu");
  if (menuNav) menuNav.setAttribute("aria-label", tr("menuAriaLabel", language));
  const addBookmarkLabel = document.getElementById("addBookmarkLabel");
  if (addBookmarkLabel) addBookmarkLabel.textContent = tr("save", language);
  const saveBtn = document.getElementById("btnSave");
  if (saveBtn) saveBtn.textContent = tr("save", language);
  const saveAllTabsLabel = document.getElementById("saveAllTabsLabel");
  if (saveAllTabsLabel) saveAllTabsLabel.textContent = tr("saveAllTabs", language);
  const label = document.querySelector(".section .label");
  if (label) label.textContent = tr("saveToGroup", language);
  for (const id of ["bookmarkPaneLeftTitle", "bookmarkPaneRightTitle"]) {
    const paneTitle = document.getElementById(id);
    if (paneTitle) paneTitle.textContent = tr("allBookmarks", language);
  }
  const foldersTitle = document.getElementById("bookmarkFoldersTitle");
  if (foldersTitle) foldersTitle.textContent = tr("allFolders", language);
  const closeButton = document.getElementById("btnCloseBookmarkPane");
  if (closeButton) {
    closeButton.title = tr("close", language);
    closeButton.setAttribute("aria-label", tr("close", language));
  }
  const empty = document.getElementById("empty");
  if (empty) empty.textContent = tr("noTab", language);
  const openLeft = document.getElementById("btnOpenLeftSidebar");
  if (openLeft) openLeft.textContent = tr("openLeftSidebar", language);
  const openRight = document.getElementById("btnOpenRightSidebar");
  if (openRight) openRight.textContent = tr("openRightSidebar", language);
  const popupBookmarksTitle = document.getElementById("popupBookmarksTitle");
  if (popupBookmarksTitle) popupBookmarksTitle.textContent = tr("allBookmarks", language);
}

/**
 * 保存数据到存储
 * @param {object} obj
 * @param {boolean} useSync
 * @returns {Promise<string | null>}
 */
function storageSet(obj, useSync = false) {
  return sharedStorageSet(storageArea(useSync), obj);
}

const LOG_KEY = "homepage_save_log";

/**
 * 追加日志
 * @param {object} entry
 * @returns {Promise<void>}
 */
async function appendLog(entry) {
  const area = storageArea();
  if (!area) return;
  const api = getChromeApi();
  try {
    const res = await callExtensionApi(api, area, "get", [LOG_KEY]);
    const list = Array.isArray(res?.[LOG_KEY]) ? res[LOG_KEY] : [];
    list.unshift(entry);
    await callExtensionApi(api, area, "set", [{ [LOG_KEY]: list.slice(0, MAX_LOG_ENTRIES) }]);
  } catch (_e) {
    // 日志记录失败不影响保存主流程
  }
}

/**
 * 加载最新数据（复用 storage.loadData，首启会创建默认分组）
 * @returns {Promise<{data: object | null, useSync: boolean}>}
 */
async function loadLatestData() {
  // popup 只读取本机完整副本；服务器同步由新标签页同步引擎负责。
  return { data: await loadData(), useSync: false };
}

/**
 * 获取当前标签页
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
async function getCurrentTab() {
  const api = getChromeApi();
  if (!api?.tabs?.query) return null;
  try {
    const tabs = await callExtensionApi(api, api.tabs, "query", [{ active: true, lastFocusedWindow: true }]);
    return tabs?.[0] || null;
  } catch (e) {
    console.warn("getCurrentTab error:", e?.message || e);
    return null;
  }
}

/**
 * 获取当前窗口的全部标签页（兼容 Promise 与回调两种 API 形态）
 * @returns {Promise<Array<chrome.tabs.Tab>>}
 */
async function getCurrentWindowTabs() {
  const api = getChromeApi();
  if (!api?.tabs?.query) return [];
  try {
    const tabs = await callExtensionApi(api, api.tabs, "query", [{ currentWindow: true }]);
    return Array.isArray(tabs) ? tabs : [];
  } catch (e) {
    console.warn("getCurrentWindowTabs error:", e?.message || e);
    return [];
  }
}

/**
 * 获取扩展基础 URL
 * @returns {string}
 */
function getExtensionBaseUrl() {
  const api = getChromeApi();
  if (!api?.runtime?.getURL) return "";
  return api.runtime.getURL("");
}

/**
 * 检查是否是扩展页面 URL
 * @param {string} url
 * @returns {boolean}
 */
function isExtensionPageUrl(url) {
  const base = getExtensionBaseUrl();
  return !!(url && base && url.startsWith(base));
}

/**
 * MV3 按需注入脚本文件或函数（兼容 Chrome 回调与 Firefox/Safari Promise）
 * @param {typeof chrome | null} api
 * @param {object} injection
 * @returns {Promise<boolean>}
 */
export async function executeScriptingFiles(api, injection) {
  if (!api?.scripting?.executeScript) return false;
  await callExtensionApi(api, api.scripting, "executeScript", [injection]);
  return true;
}

/**
 * MV2 / Safari 兜底按需注入脚本（兼容 Chrome 回调与 Firefox/Safari Promise）
 * @param {typeof chrome | null} api
 * @param {number} tabId
 * @param {object} details
 * @returns {Promise<boolean>}
 */
export async function executeTabsScript(api, tabId, details) {
  if (!api?.tabs?.executeScript) return false;
  await callExtensionApi(api, api.tabs, "executeScript", [tabId, details]);
  return true;
}

/**
 * 发送运行时消息
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendRuntimeMessage(message) {
  const api = getChromeApi();
  if (!api?.runtime?.sendMessage) return Promise.resolve(null);
  return callExtensionApi(api, api.runtime, "sendMessage", [message])
    .then((res) => res || null)
    .catch(() => null);
}

/**
 * 从弹窗打开书签。弹窗的 runtime sender 在 Safari 中可能没有 tab，
 * 因此优先使用弹窗自身拿到的活动标签页，再回退到后台消息。
 * @param {string} url
 * @param {object} settings
 * @param {chrome.tabs.Tab | null} tab
 * @returns {Promise<{ok:boolean}>}
 */
async function openBookmarkFromPopup(url, settings, tab) {
  return (
    (await sendRuntimeMessage({
      type: "homepage_open_bookmark",
      url,
      settings,
      tabId: Number.isInteger(tab?.id) ? tab.id : undefined,
    })) || { ok: false }
  );
}

/**
 * 发送标签页消息
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendTabMessage(tabId, message) {
  const api = getChromeApi();
  if (!api?.tabs?.sendMessage) return Promise.resolve(null);
  return callExtensionApi(api, api.tabs, "sendMessage", [tabId, message])
    .then((res) => res || null)
    .catch(() => null);
}

export async function openBookmarkSidebar(tab, data, side) {
  if (!tab?.id) return false;
  const payload = { type: "homepage_open_bookmark_sidebar", data, side };
  const response = await sendTabMessage(tab.id, payload);
  if (response?.ok) return true;
  const api = getChromeApi();
  try {
    if (api?.scripting?.executeScript) {
      await executeScriptingFiles(api, { target: { tabId: tab.id }, files: ["js/bookmark-sidebar.js"] });
    } else if (api?.tabs?.executeScript) {
      await executeTabsScript(api, tab.id, { file: "js/bookmark-sidebar.js" });
    } else {
      return false;
    }
  } catch (e) {
    console.warn("openBookmarkSidebar inject failed", e);
    return false;
  }
  const res = await sendTabMessage(tab.id, payload);
  return !!res?.ok;
}

/**
 * 把 collectBookmarkFolders 的目标树渲染成可展开的文件夹菜单（纯 DOM 构建）。
 * 「添加书签」与「保存所有标签」两个入口共用同一棵树。
 * @param {HTMLElement} host 容器
 * @param {Array<object>} folders collectBookmarkFolders 结果
 * @param {(folder: object) => void} onPick 选中目标（分组/文件夹）后的回调
 */
function buildFolderMenuTree(host, folders, onPick) {
  const childrenOf = (folder) => folders.filter((entry) => entry.parentId === folder.id);
  const appendFolder = (folder, container) => {
    const row = document.createElement("div");
    row.className = "menu-folder-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menu-folder-button";
    button.textContent = folder.name;
    button.title = folder.path.join(" / ");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onPick(folder);
    });
    row.appendChild(button);
    const children = childrenOf(folder);
    if (children.length) {
      row.classList.add("has-children");
      const openByDefault = folder.kind === "group";
      if (openByDefault) row.classList.add("menu-open");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "menu-folder-toggle";
      toggle.textContent = "›";
      toggle.title = openByDefault ? tr("collapseFolder", popupLanguage) : tr("expandFolder", popupLanguage);
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(openByDefault));
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = row.classList.toggle("menu-open");
        toggle.setAttribute("aria-expanded", String(open));
        toggle.title = open ? tr("collapseFolder", popupLanguage) : tr("expandFolder", popupLanguage);
        toggle.setAttribute("aria-label", toggle.title);
      });
      row.appendChild(toggle);
      const submenu = document.createElement("div");
      submenu.className = "menu-submenu";
      for (const child of children) appendFolder(child, submenu);
      row.appendChild(submenu);
    }
    container.appendChild(row);
  };
  host.replaceChildren();
  for (const folder of folders.filter((entry) => entry.depth === 0)) appendFolder(folder, host);
}

/** 绑定“父菜单项点击展开/收起”的通用行为 */
function bindMenuToggle(parentId, toggleId) {
  const parent = document.getElementById(parentId);
  const toggleButton = document.getElementById(toggleId);
  if (!parent || !toggleButton) return;
  toggleButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = parent.classList.toggle("menu-open");
    toggleButton.setAttribute("aria-expanded", String(open));
  });
}

function renderBookmarkFolderMenu(data, tab) {
  const menu = document.getElementById("bookmarkFolderMenu");
  if (!menu) return;
  bindMenuToggle("addBookmarkMenu", "addBookmarkToggle");
  buildFolderMenuTree(menu, collectBookmarkFolders(data), async (folder) => {
    const result = await saveToContainer(tab, folder.id, tab?.title || "");
    if (result?.error) {
      showPopupError(explainSaveError(result) || tr("saveFailed", popupLanguage));
      return;
    }
    await showToastInTab(
      tab,
      tr("savedToGroup", popupLanguage, { name: result.groupName || tr("unnamed", popupLanguage) }),
      result.fontSize,
    );
    window.close();
  });
}

/**
 * 批量保存当前窗口所有有效标签页到目标分组/文件夹。
 * @param {string} containerId 目标分组或文件夹 ID
 * @returns {Promise<{count: number, groupName: string, fontSize: number} | {error: string}>}
 */
async function saveAllTabsToContainer(containerId) {
  const tabs = await getCurrentWindowTabs();
  const savable = filterSavableTabs(tabs);
  if (!savable.length) {
    await appendLog({ ts: Date.now(), stage: "no_valid_tabs", windowTabs: tabs.length });
    return { error: "no_valid_tabs" };
  }
  const { data } = await loadLatestData();
  if (!data?.groups || !data.nodes) {
    await appendLog({ ts: Date.now(), stage: "no_data" });
    return { error: "no_data" };
  }
  const deviceId = await getOrCreateDeviceId().catch(() => "");
  const result = saveTabsToContainer(data, savable, { containerId, deviceId });
  if (result.error) {
    await appendLog({ ts: Date.now(), stage: result.error });
    return result;
  }
  // 弹窗保存只在网页里 toast，避免新标签页读取存储后重复提示
  data.settings.lastSaveToast = null;
  // 本地权威：popup 只写 local；newtab 监听 local 变更后 schedulePush 上传投影
  const localErr = await storageSet({ [ROOT_KEY]: data }, false);
  if (localErr) {
    await appendLog({ ts: Date.now(), stage: "local_error", error: localErr });
    return { error: "save_failed" };
  }
  await appendLog({ ts: Date.now(), stage: "saved_all_tabs", count: result.count, group: result.groupId });
  return {
    count: result.count,
    groupName: result.groupName,
    fontSize: data.settings.fontSize || DEFAULT_FONT_SIZE,
  };
}

function explainSaveAllError(result) {
  if (!result?.error) return "";
  if (result.error === "no_valid_tabs") return tr("noValidTabs", popupLanguage);
  if (result.error === "save_failed") return tr("saveAllFailed", popupLanguage);
  return explainSaveError(result);
}

/** 渲染「保存当前窗口所有标签」的目标文件夹菜单 */
function renderSaveAllTabsMenu(data, tab) {
  const menu = document.getElementById("saveAllTabsFolderMenu");
  if (!menu) return;
  bindMenuToggle("saveAllTabsMenu", "saveAllTabsToggle");
  buildFolderMenuTree(menu, collectBookmarkFolders(data), async (folder) => {
    const result = await saveAllTabsToContainer(folder.id);
    if (result?.error) {
      showPopupError(explainSaveAllError(result) || tr("saveAllFailed", popupLanguage));
      return;
    }
    await showToastInTab(
      tab,
      tr("savedAllToGroup", popupLanguage, {
        count: result.count,
        name: result.groupName || tr("unnamed", popupLanguage),
      }),
      result.fontSize,
    );
    window.close();
  });
}

/**
 * 在扩展弹窗中渲染本程序的所有普通书签。
 * @param {object} data
 * @param {chrome.tabs.Tab | null} tab
 */
function renderPopupBookmarks(data, tab) {
  const section = document.getElementById("popupBookmarks");
  const list = document.getElementById("popupBookmarkList");
  if (!section || !list) return;
  const tree = collectBookmarkTree(data);
  const visibleTree = getPopupBookmarkRoots(tree);
  list.replaceChildren();
  if (!visibleTree.length) {
    const empty = document.createElement("div");
    empty.className = "popup-bookmark-empty";
    empty.textContent = tr("noBookmarks", popupLanguage);
    list.appendChild(empty);
    return;
  }

  const appendNode = (node, host) => {
    if (node.type === "item") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "popup-bookmark-item";

      const title = document.createElement("span");
      title.className = "popup-bookmark-item-title";
      title.textContent = node.title;
      button.append(title);
      button.addEventListener("click", async () => {
        button.disabled = true;
        const result = await openBookmarkFromPopup(node.url, data?.settings || {}, tab);
        if (result?.ok) {
          window.close();
          return;
        }
        button.disabled = false;
        showPopupError(tr("openFailed", popupLanguage));
      });
      host.appendChild(button);
      return;
    }

    const details = document.createElement("details");
    details.className = `popup-bookmark-folder popup-bookmark-${node.type}`;
    const summary = document.createElement("summary");
    summary.className = "popup-bookmark-folder-title";
    summary.textContent = node.title;
    details.appendChild(summary);
    const children = document.createElement("div");
    children.className = "popup-bookmark-children";
    for (const child of node.children) appendNode(child, children);
    details.appendChild(children);
    host.appendChild(details);
  };

  for (const root of visibleTree) {
    appendNode(root, list);
  }
}

/**
 * 保存到分组或任意嵌套文件夹
 * @param {chrome.tabs.Tab} tab
 * @param {string} selectedContainerId
 * @param {string} customTitle
 * @returns {Promise<{groupId: string, groupName: string, fontSize: number} | null>}
 */
async function saveToContainer(tab, selectedContainerId, customTitle = "") {
  const url = normalizeUrl(tab?.url);
  if (!url) {
    await appendLog({ ts: Date.now(), stage: "invalid_url", raw: tab?.url || "" });
    return { error: "invalid_url" };
  }
  const { data } = await loadLatestData();
  if (!data?.groups || !data.nodes) {
    await appendLog({ ts: Date.now(), stage: "no_data" });
    return { error: "no_data" };
  }
  const deviceId = await getOrCreateDeviceId().catch(() => "");
  const result = saveSingleTabToContainer(data, tab, { containerId: selectedContainerId, customTitle, deviceId });
  if (result.error) {
    await appendLog({ ts: Date.now(), stage: result.error });
    return result;
  }
  // 本地权威：popup 只写 local；newtab 监听 local 变更后 schedulePush 上传投影
  const localErr = await storageSet({ [ROOT_KEY]: data }, false);
  if (localErr) {
    await appendLog({ ts: Date.now(), stage: "local_error", error: localErr });
    return { error: "save_failed" };
  }
  await appendLog({ ts: Date.now(), stage: "saved", url, group: result.groupId });
  return {
    groupId: result.groupId,
    groupName: result.groupName,
    fontSize: data.settings.fontSize || DEFAULT_FONT_SIZE,
  };
}

/**
 * 在标签页中显示 toast
 * @param {chrome.tabs.Tab} tab
 * @param {string} message
 * @param {number} fontSize
 * @returns {Promise<boolean>}
 */
export async function showToastInTab(tab, message, fontSize) {
  const api = getChromeApi();
  if (!tab?.id) return false;
  const payload = { type: "homepage_show_toast", text: message, fontSize };
  if (isExtensionPageUrl(tab.url)) {
    const res = await sendRuntimeMessage(payload);
    if (res?.ok) return true;
  }
  try {
    const direct = await sendTabMessage(tab.id, payload);
    if (direct?.ok) return true;
    if (api?.scripting?.executeScript) {
      try {
        await executeScriptingFiles(api, { target: { tabId: tab.id }, files: ["js/content-toast.js"] });
        const res = await sendTabMessage(tab.id, payload);
        if (res?.ok) return true;
      } catch (e) {
        console.warn("scripting.executeScript content-toast failed", e);
      }
      await executeScriptingFiles(api, {
        target: { tabId: tab.id },
        func: (msg, size, duration, styleProps) => {
          if (!document.body) return;
          const toastId = "homepage-save-toast";
          const existing = document.getElementById(toastId);
          if (existing) existing.remove();
          const el = document.createElement("div");
          el.id = toastId;
          el.textContent = msg;
          Object.assign(el.style, styleProps, { fontSize: `${Number(size) || 14}px` });
          document.body.appendChild(el);
          setTimeout(() => el.remove(), duration);
        },
        args: [message, fontSize, TOAST_DURATION_MS, TOAST_STYLE_PROPS],
      });
      return true;
    }
    if (api?.tabs?.executeScript) {
      try {
        await executeTabsScript(api, tab.id, { file: "js/content-toast.js" });
        const res = await sendTabMessage(tab.id, payload);
        if (res?.ok) return true;
      } catch (e) {
        console.warn("tabs.executeScript content-toast failed", e);
      }
      const msg = JSON.stringify(message || "");
      const size = Number(fontSize) || 14;
      const styleJson = JSON.stringify(TOAST_STYLE_PROPS);
      const code = `(function(){if(!document.body){return;}var toastId="homepage-save-toast";var existing=document.getElementById(toastId);if(existing){existing.remove();}var el=document.createElement("div");el.id=toastId;el.textContent=${msg};Object.assign(el.style,${styleJson},{fontSize:"${size}px"});document.body.appendChild(el);setTimeout(function(){el.remove();},${TOAST_DURATION_MS});})();`;
      await executeTabsScript(api, tab.id, { code });
      return true;
    }
    // 没有任何注入 API 时不能谎报成功
    return false;
  } catch (e) {
    console.warn("showToastInTab failed", e);
    return false;
  }
}

function explainSaveError(result) {
  if (!result?.error) return "";
  if (result.error === "invalid_url") return tr("invalidUrl", popupLanguage);
  if (result.error === "no_data" || result.error === "no_group") return tr("noData", popupLanguage);
  return tr("saveFailed", popupLanguage);
}

/**
 * 初始化
 */
async function init() {
  const { data } = await loadLatestData();
  popupLanguage =
    normalizeLanguage(data?.settings?.language || detectPreferredLanguage(POPUP_SUPPORTED_LANGUAGES)) || "zh-CN";
  applyPopupI18n(popupLanguage);
  const tab = await getCurrentTab();
  if (!data?.groups?.length) {
    showPopupError(tr("noData", popupLanguage));
    return;
  }
  document.body.classList.remove("hidden");
  renderBookmarkFolderMenu(data, tab);
  renderSaveAllTabsMenu(data, tab);
  renderPopupBookmarks(data, tab);
  document.getElementById("btnOpenLeftSidebar")?.addEventListener("click", async () => {
    if (await openBookmarkSidebar(tab, data, "left")) window.close();
    else showPopupError(tr("openLeftSidebarFail", popupLanguage));
  });
  document.getElementById("btnOpenRightSidebar")?.addEventListener("click", async () => {
    if (await openBookmarkSidebar(tab, data, "right")) window.close();
    else showPopupError(tr("openRightSidebarFail", popupLanguage));
  });
}

if (typeof document !== "undefined" && document.getElementById("popupBookmarkList")) {
  init().catch((error) => {
    console.error("popup init failed", error);
    const empty = document.getElementById("empty");
    if (empty) {
      empty.textContent = tr("loadFailed", popupLanguage || detectPreferredLanguage(POPUP_SUPPORTED_LANGUAGES));
      empty.classList.remove("hidden");
    }
    document.body?.classList?.remove("hidden");
  });
}

export { applyPopupI18n, init as initPopup, renderPopupBookmarks, showPopupError };
