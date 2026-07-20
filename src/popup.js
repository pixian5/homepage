import { createItemNode, pickLatestData } from "./js/data-utils.js";
import {
  detectPreferredLanguage,
  estimateBytes,
  getChromeApi,
  normalizeLanguage,
  normalizeUrl,
  sanitizeForSync,
  storageGet as sharedStorageGet,
  storageSet as sharedStorageSet,
  storageArea,
} from "./js/shared-utils.js";
import { getStorageKey, loadData } from "./js/storage.js";

const ROOT_KEY = getStorageKey();
const SYNC_ITEM_QUOTA_BYTES = 7500;
const MAX_LOG_ENTRIES = 30;
const ICON_DATA_MAX_LENGTH = 2048;
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
    title: "添加当前标签页",
    save: "保存",
    saveToGroup: "保存到分组",
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
    title: "新增目前分頁",
    save: "儲存",
    saveToGroup: "儲存到分組",
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
    title: "Add Current Tab",
    save: "Save",
    saveToGroup: "Save to Group",
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
  const empty = document.getElementById("empty");
  if (empty) empty.textContent = tr("noTab", language);
}

/**
 * 从存储中获取数据
 * @param {string} key
 * @param {boolean} useSync
 * @returns {Promise<any>}
 */
function storageGet(key, useSync = false) {
  return sharedStorageGet(storageArea(useSync), key);
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
  // loadData 负责本地首启 bootstrap + migrate + repair
  const localData = await loadData();
  const useSync = !!localData?.settings?.syncEnabled;
  if (!useSync) return { data: localData, useSync: false };
  const syncData = (await storageGet(ROOT_KEY, true)) || null;
  // sync 缺失时 pickLatest 保留 local，避免空远端覆盖
  const data = pickLatestData(localData, syncData);
  return { data: data || localData, useSync: true };
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

/**
 * 渲染标签页信息
 * @param {chrome.tabs.Tab | null} tab
 */
function renderTab(tab) {
  const card = document.getElementById("tabCard");
  const empty = document.getElementById("empty");
  if (!tab) {
    empty.classList.remove("hidden");
    card.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  card.classList.remove("hidden");
  card.replaceChildren();
  const titleInput = document.createElement("input");
  titleInput.id = "tabTitleInput";
  titleInput.className = "tab-title-input";
  titleInput.type = "text";
  titleInput.value = tab.title || tab.url || "";
  titleInput.placeholder = tr("titlePlaceholder", popupLanguage);
  titleInput.spellcheck = false;
  const urlDiv = document.createElement("div");
  urlDiv.className = "tab-url";
  urlDiv.textContent = tab.url || "";
  card.appendChild(titleInput);
  card.appendChild(urlDiv);
}

/**
 * 渲染分组选择器
 * @param {object} data
 */
function renderGroups(data) {
  const select = document.getElementById("groupSelect");
  select.replaceChildren();
  const groups = (data?.groups || []).sort((a, b) => a.order - b.order);
  groups.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    select.appendChild(opt);
  });
  const mode = data?.settings?.defaultGroupMode || "last";
  const fixedId = data?.settings?.defaultGroupId;
  const last = data?.settings?.lastActiveGroupId;
  if (mode === "fixed" && fixedId) {
    select.value = fixedId;
  } else if (last) {
    select.value = last;
  }
}

/**
 * 保存到分组
 * @param {chrome.tabs.Tab} tab
 * @param {string} selectedGroupId
 * @param {string} customTitle
 * @returns {Promise<{groupId: string, groupName: string, fontSize: number} | null>}
 */
async function saveToGroup(tab, selectedGroupId, customTitle = "") {
  const url = normalizeUrl(tab?.url);
  if (!url) {
    await appendLog({ ts: Date.now(), stage: "invalid_url", raw: tab?.url || "" });
    return { error: "invalid_url" };
  }
  const { data, useSync } = await loadLatestData();
  if (!data?.groups || !data.nodes) {
    await appendLog({ ts: Date.now(), stage: "no_data" });
    return { error: "no_data" };
  }

  const group = data.groups.find((g) => g.id === selectedGroupId) || data.groups[0];
  if (!group) {
    await appendLog({ ts: Date.now(), stage: "no_group" });
    return { error: "no_group" };
  }
  if (!Array.isArray(group.nodes)) group.nodes = [];

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
  group.nodes.push(node.id);
  data.settings.lastActiveGroupId = group.id;
  data.settings.lastSaveUrl = url;
  data.settings.lastSaveTs = Date.now();
  // 弹窗保存仅在当前网页显示 toast，避免新标签页读取存储后重复提示
  data.settings.lastSaveToast = null;
  data.lastUpdated = Date.now();
  const payload = useSync ? sanitizeForSync(data, ICON_DATA_MAX_LENGTH) : data;
  if (useSync) {
    const size = estimateBytes(payload);
    if (size > SYNC_ITEM_QUOTA_BYTES) {
      data.settings.syncEnabled = false;
      const localErr = await storageSet({ [ROOT_KEY]: data }, false);
      await appendLog({ ts: Date.now(), stage: "sync_quota_disable", bytes: size, localErr });
      if (localErr) return { error: "save_failed" };
      return {
        groupId: group.id,
        groupName: group.name || "",
        fontSize: data.settings.fontSize || DEFAULT_FONT_SIZE,
        warning: "sync_quota",
      };
    }
    const err = await storageSet({ [ROOT_KEY]: payload }, true);
    if (err) {
      data.settings.syncEnabled = false;
      const localErr = await storageSet({ [ROOT_KEY]: data }, false);
      await appendLog({ ts: Date.now(), stage: "sync_error", error: err, localErr });
      if (localErr) return { error: "save_failed" };
      return {
        groupId: group.id,
        groupName: group.name || "",
        fontSize: data.settings.fontSize || DEFAULT_FONT_SIZE,
        warning: "sync_error",
      };
    }
    const localErr = await storageSet({ [ROOT_KEY]: data }, false);
    if (localErr) {
      await appendLog({ ts: Date.now(), stage: "local_error_after_sync", error: localErr });
      // sync 已成功，仍提示成功
    }
  } else {
    const localErr = await storageSet({ [ROOT_KEY]: data }, false);
    if (localErr) {
      await appendLog({ ts: Date.now(), stage: "local_error", error: localErr });
      return { error: "save_failed" };
    }
  }
  await appendLog({ ts: Date.now(), stage: "saved", url, group: group.id });
  return { groupId: group.id, groupName: group.name || "", fontSize: data.settings.fontSize || DEFAULT_FONT_SIZE };
}

/**
 * 在标签页中显示 toast
 * @param {chrome.tabs.Tab} tab
 * @param {string} message
 * @param {number} fontSize
 * @returns {Promise<boolean>}
 */
async function showToastInTab(tab, message, fontSize) {
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
    normalizeLanguage(data?.settings?.language || detectPreferredLanguage(SUPPORTED_LANGUAGES)) || "zh-CN";
  applyPopupI18n(popupLanguage);
  const tab = await getCurrentTab();
  const fixedId = data?.settings?.defaultGroupId;
  const isFixed = data?.settings?.defaultGroupMode === "fixed";
  const hasFixedGroup = !!(fixedId && data?.groups?.some((g) => g.id === fixedId));
  if (isFixed && hasFixedGroup) {
    if (!tab) {
      showPopupError(tr("noTab", popupLanguage));
      return;
    }
    const result = await saveToGroup(tab, fixedId);
    if (result && !result.error) {
      await showToastInTab(
        tab,
        tr("savedToGroup", popupLanguage, { name: result.groupName || tr("unnamed", popupLanguage) }),
        result.fontSize,
      );
      window.close();
      return;
    }
    showPopupError(explainSaveError(result) || tr("saveFailed", popupLanguage));
    return;
  }
  if (!data?.groups?.length) {
    showPopupError(tr("noData", popupLanguage));
    return;
  }
  renderTab(tab);
  renderGroups(data);
  if (data?.settings?.fontSize) {
    document.body.style.fontSize = `${data.settings.fontSize}px`;
  }
  document.body.classList.remove("hidden");
  let saving = false;
  const btnSave = document.getElementById("btnSave");
  const doSave = async () => {
    if (saving) return;
    if (!tab) {
      showPopupError(tr("noTab", popupLanguage));
      return;
    }
    saving = true;
    btnSave.disabled = true;
    const selectedGroupId = document.getElementById("groupSelect").value;
    const tabTitleInput = document.getElementById("tabTitleInput");
    const customTitle = tabTitleInput ? tabTitleInput.value : "";
    const result = await saveToGroup(tab, selectedGroupId, customTitle);
    if (result && !result.error) {
      await showToastInTab(
        tab,
        tr("savedToGroup", popupLanguage, { name: result.groupName || tr("unnamed", popupLanguage) }),
        result.fontSize,
      );
      window.close();
      return;
    }
    showPopupError(explainSaveError(result) || tr("saveFailed", popupLanguage));
    saving = false;
    btnSave.disabled = false;
  };
  btnSave.addEventListener("click", () => {
    void doSave();
  });
  // 面板内回车默认保存（与 newtab 弹窗一致）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "textarea") return;
    if (e.target?.closest?.("select")) return;
    e.preventDefault();
    void doSave();
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
