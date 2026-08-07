import { createItemNode } from "./js/data-utils.js";
import {
  detectPreferredLanguage,
  getChromeApi,
  normalizeLanguage,
  normalizeUrl,
  storageSet as sharedStorageSet,
  storageArea,
} from "./js/shared-utils.js";
import { getStorageKey, loadData } from "./js/storage.js";

const ROOT_KEY = getStorageKey();
const _SYNC_ITEM_QUOTA_BYTES = 7500;
const MAX_LOG_ENTRIES = 30;
const _ICON_DATA_MAX_LENGTH = 2048;
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
const SUPPORTED_LANGUAGES = ["zh-CN", "zh-TW", "en"];

const POPUP_I18N = {
  "zh-CN": {
    title: "我的书签",
    save: "添加书签",
    saveToGroup: "添加到文件夹",
    allBookmarks: "所有书签",
    allFolders: "所有书签文件夹",
    close: "关闭",
    noBookmarks: "暂无书签",
    noFolders: "暂无文件夹",
    saving: "添加中",
    noTab: "未获取到当前标签页",
    titlePlaceholder: "请输入标题",
    savedToGroup: "已保存到分组：{name}",
    unnamed: "未命名",
    loadFailed: "加载失败，请关闭后重试",
    invalidUrl: "当前页面无法保存（仅支持 http/https/ftp）",
    saveFailed: "保存失败，请重试",
    noData: "尚未初始化数据，请先打开一次新标签页",
  },
  "zh-TW": {
    title: "我的書籤",
    save: "新增書籤",
    saveToGroup: "新增到資料夾",
    allBookmarks: "所有書籤",
    allFolders: "所有書籤資料夾",
    close: "關閉",
    noBookmarks: "暫無書籤",
    noFolders: "暫無資料夾",
    saving: "新增中",
    noTab: "未取得目前分頁",
    titlePlaceholder: "請輸入標題",
    savedToGroup: "已儲存到分組：{name}",
    unnamed: "未命名",
    loadFailed: "載入失敗，請關閉後重試",
    invalidUrl: "目前頁面無法儲存（僅支援 http/https/ftp）",
    saveFailed: "儲存失敗，請重試",
    noData: "尚未初始化資料，請先開啟一次新分頁",
  },
  en: {
    title: "My Bookmarks",
    save: "Add Bookmark",
    saveToGroup: "Add to Folder",
    allBookmarks: "All Bookmarks",
    allFolders: "All Bookmark Folders",
    close: "Close",
    noBookmarks: "No bookmarks",
    noFolders: "No folders",
    saving: "Adding…",
    noTab: "Current tab not found",
    titlePlaceholder: "Enter title",
    savedToGroup: "Saved to group: {name}",
    unnamed: "Unnamed",
    loadFailed: "Load failed, close and retry",
    invalidUrl: "This page cannot be saved (http/https/ftp only)",
    saveFailed: "Save failed, please retry",
    noData: "Data not initialized. Open a new tab once first.",
  },
};

function showPopupError(message) {
  const empty = document.getElementById("empty");
  if (empty) {
    empty.textContent = message;
    empty.classList.remove("hidden");
  }
  document.body.classList.remove("hidden");
}

function tr(key, language, vars = null) {
  const lang = normalizeLanguage(language) || "zh-CN";
  const dict = POPUP_I18N[lang] || POPUP_I18N.en || POPUP_I18N["zh-CN"];
  const text = dict[key] || POPUP_I18N.en?.[key] || POPUP_I18N["zh-CN"]?.[key] || key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
}

function applyPopupI18n(language) {
  document.documentElement.lang = normalizeLanguage(language) || "zh-CN";
  document.title = tr("title", language);
  const title = document.querySelector(".header .title");
  if (title) title.textContent = tr("title", language);
  const saveBtn = document.getElementById("btnSave");
  if (saveBtn) saveBtn.textContent = tr("save", language);
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
  const openSidebar = document.getElementById("btnOpenSidebar");
  if (openSidebar) openSidebar.textContent = language === "en" ? "Open bookmark sidebars" : "打开书签侧栏";
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
function appendLog(entry) {
  const area = storageArea();
  return new Promise((resolve) => {
    area.get(LOG_KEY, (res) => {
      const list = Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
      list.unshift(entry);
      area.set({ [LOG_KEY]: list.slice(0, MAX_LOG_ENTRIES) }, () => resolve());
    });
  });
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
  if (!api?.tabs) return null;
  const result = api.tabs.query({ active: true, currentWindow: true });
  if (typeof result?.then === "function") {
    const tabs = await result;
    if (api.runtime?.lastError) {
      console.warn("getCurrentTab error:", api.runtime.lastError.message);
      return null;
    }
    return tabs?.[0] || null;
  }
  return new Promise((resolve) =>
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (api.runtime?.lastError) {
        console.warn("getCurrentTab error:", api.runtime.lastError.message);
        return resolve(null);
      }
      resolve(tabs?.[0] || null);
    }),
  );
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
 * 发送运行时消息
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendRuntimeMessage(message) {
  const api = getChromeApi();
  if (!api?.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      api.runtime.sendMessage(message, (res) => {
        const err = api.runtime?.lastError;
        if (err) return resolve(null);
        resolve(res || null);
      });
    } catch (_e) {
      // 消息发送失败是预期情况，静默处理
      resolve(null);
    }
  });
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
  return new Promise((resolve) => {
    try {
      api.tabs.sendMessage(tabId, message, (res) => {
        const err = api.runtime?.lastError;
        if (err) return resolve(null);
        resolve(res || null);
      });
    } catch (_e) {
      // 消息发送失败是预期情况，静默处理
      resolve(null);
    }
  });
}

async function openBookmarkSidebar(tab, data) {
  if (!tab?.id) return false;
  const response = await sendTabMessage(tab.id, { type: "homepage_open_bookmark_sidebar", data });
  if (response?.ok) return true;
  const api = getChromeApi();
  if (!api?.scripting?.executeScript) return false;
  return new Promise((resolve) => {
    api.scripting.executeScript({ target: { tabId: tab.id }, files: ["js/bookmark-sidebar.js"] }, () => {
      if (api.runtime?.lastError) return resolve(false);
      void sendTabMessage(tab.id, { type: "homepage_open_bookmark_sidebar", data }).then((res) => resolve(!!res?.ok));
    });
  });
}

async function openAddBookmarkPanel(tab, data) {
  if (!tab?.id) return false;
  const response = await sendTabMessage(tab.id, { type: "homepage_open_add_bookmark_panel", data });
  return !!response?.ok;
}

/**
 * 在两个侧栏中渲染本程序的所有普通书签。
 * @param {object} data
 */
/**
 * 保存到分组或任意嵌套文件夹
 * @param {chrome.tabs.Tab} tab
 * @param {string} selectedContainerId
 * @param {string} customTitle
 * @returns {Promise<{groupId: string, groupName: string, fontSize: number} | null>}
 */
async function _saveToContainer(tab, selectedContainerId, customTitle = "") {
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

  const group = data.groups.find((g) => g.id === selectedContainerId);
  const folder = !group ? data.nodes[selectedContainerId] : null;
  const container = group || (folder?.type === "folder" ? folder : null);
  if (!container) {
    await appendLog({ ts: Date.now(), stage: "no_group" });
    return { error: "no_group" };
  }
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch (_e) {
    hostname = "";
  }
  const trimmedTitle = String(customTitle || "").trim();
  const node = createItemNode({
    url,
    title: trimmedTitle || tab.title || hostname,
    iconType: "auto",
    iconPending: true,
  });
  data.nodes[node.id] = node;
  if (group) {
    if (!Array.isArray(group.nodes)) group.nodes = [];
    group.nodes.push(node.id);
  } else {
    if (!Array.isArray(folder.children)) folder.children = [];
    folder.children.push(node.id);
  }
  container.updatedAt = Date.now();
  container.updatedBy = "";
  data.settings.lastActiveGroupId = container.id;
  data.settings.lastSaveUrl = url;
  data.settings.lastSaveTs = Date.now();
  // 弹窗保存仅在当前网页显示 toast，避免新标签页读取存储后重复提示
  data.settings.lastSaveToast = null;
  data.lastUpdated = Date.now();
  // 本地权威：popup 只写 local；newtab 监听 local 变更后 schedulePush 上传投影
  const localErr = await storageSet({ [ROOT_KEY]: data }, false);
  if (localErr) {
    await appendLog({ ts: Date.now(), stage: "local_error", error: localErr });
    return { error: "save_failed" };
  }
  await appendLog({ ts: Date.now(), stage: "saved", url, group: container.id });
  return {
    groupId: container.id,
    groupName: container.name || container.title || "",
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
async function _showToastInTab(tab, message, fontSize) {
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
        await new Promise((resolve, reject) => {
          api.scripting.executeScript({ target: { tabId: tab.id }, files: ["js/content-toast.js"] }, () => {
            const err = api.runtime?.lastError;
            if (err) return reject(err);
            resolve();
          });
        });
        const res = await sendTabMessage(tab.id, payload);
        if (res?.ok) return true;
      } catch (e) {
        console.warn("scripting.executeScript content-toast failed", e);
      }
      await new Promise((resolve, reject) => {
        api.scripting.executeScript(
          {
            target: { tabId: tab.id },
            func: (msg, size, duration, styleProps) => {
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
          },
          () => {
            const err = api.runtime?.lastError;
            if (err) return reject(err);
            resolve();
          },
        );
      });
      return true;
    }
    if (api?.tabs?.executeScript) {
      try {
        await new Promise((resolve, reject) => {
          api.tabs.executeScript(tab.id, { file: "js/content-toast.js" }, () => {
            const err = api.runtime?.lastError;
            if (err) return reject(err);
            resolve();
          });
        });
        const res = await sendTabMessage(tab.id, payload);
        if (res?.ok) return true;
      } catch (e) {
        console.warn("tabs.executeScript content-toast failed", e);
      }
      const msg = JSON.stringify(message || "");
      const size = Number(fontSize) || 14;
      const styleJson = JSON.stringify(TOAST_STYLE_PROPS);
      const code = `(function(){var toastId="homepage-save-toast";var existing=document.getElementById(toastId);if(existing){existing.remove();}var el=document.createElement("div");el.id=toastId;el.textContent=${msg};Object.assign(el.style,${styleJson},{fontSize:"${size}px"});document.body.appendChild(el);setTimeout(function(){el.remove();},${TOAST_DURATION_MS});})();`;
      await new Promise((resolve, reject) => {
        api.tabs.executeScript(tab.id, { code }, () => {
          const err = api.runtime?.lastError;
          if (err) return reject(err);
          resolve();
        });
      });
      return true;
    }
    // 没有任何注入 API 时不能谎报成功
    return false;
  } catch (e) {
    console.warn("showToastInTab failed", e);
    return false;
  }
}

function _explainSaveError(result) {
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
    normalizeLanguage(data?.settings?.language || detectPreferredLanguage(SUPPORTED_LANGUAGES)) || "zh-CN";
  applyPopupI18n(popupLanguage);
  const tab = await getCurrentTab();
  if (!data?.groups?.length) {
    showPopupError(tr("noData", popupLanguage));
    return;
  }
  void openBookmarkSidebar(tab, data);
  document.body.classList.remove("hidden");
  document.getElementById("btnOpenSidebar")?.addEventListener("click", () => {
    void openBookmarkSidebar(tab, data);
    window.close();
  });
  document.getElementById("btnAddBookmark")?.addEventListener("click", () => {
    void openAddBookmarkPanel(tab, data);
    window.close();
  });
}

init().catch((error) => {
  console.error("popup init failed", error);
  const empty = document.getElementById("empty");
  if (empty) {
    empty.textContent = tr("loadFailed", popupLanguage || detectPreferredLanguage(SUPPORTED_LANGUAGES));
    empty.classList.remove("hidden");
  }
  document.body.classList.remove("hidden");
});
