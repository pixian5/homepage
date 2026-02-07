import {
  getChromeApi,
  getStorageKey,
} from "./js/storage.js";

const ROOT_KEY = getStorageKey();
const SYNC_ITEM_QUOTA_BYTES = 7500;
const MAX_LOG_ENTRIES = 30;
const ICON_DATA_MAX_LENGTH = 2048;
const TOAST_DURATION_MS = 3000;
const DEFAULT_FONT_SIZE = 13;

/**
 * 获取浏览器 API
 * @returns {typeof chrome | null}
 */
function getChrome() {
  return getChromeApi();
}

/**
 * 获取最后一个错误
 * @returns {chrome.runtime.LastError | null}
 */
function getLastError() {
  const api = getChrome();
  return api?.runtime?.lastError || null;
}

/**
 * 获取存储区域
 * @param {boolean} useSync
 * @returns {chrome.storage.StorageArea | null}
 */
function storageArea(useSync) {
  const api = getChrome();
  if (!api || !api.storage) return null;
  return useSync ? api.storage.sync : api.storage.local;
}

/**
 * 从存储中获取数据
 * @param {string} key
 * @param {boolean} useSync
 * @returns {Promise<any>}
 */
function storageGet(key, useSync = false) {
  const area = storageArea(useSync);
  return new Promise((resolve) => {
    area.get(key, (res) => {
      const err = getLastError();
      if (err) return resolve(undefined);
      resolve(res[key]);
    });
  });
}

/**
 * 保存数据到存储
 * @param {object} obj
 * @param {boolean} useSync
 * @returns {Promise<string | null>}
 */
function storageSet(obj, useSync = false) {
  const area = storageArea(useSync);
  return new Promise((resolve) => {
    area.set(obj, () => {
      const err = getLastError();
      resolve(err ? err.message : null);
    });
  });
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
 * 规范化 URL
 * @param {string} input
 * @returns {string}
 */
function normalizeUrl(input) {
  if (!input) return "";
  try {
    return new URL(input).href;
  } catch (e) {
    try {
      return new URL(`https://${input}`).href;
    } catch (e2) {
      // URL 解析失败是预期行为
      return "";
    }
  }
}

/**
 * 估算字节大小
 * @param {any} value
 * @returns {number}
 */
function estimateBytes(value) {
  const str = JSON.stringify(value);
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str).length;
  }
  return str.length;
}

/**
 * 清理数据以适应同步存储
 * @param {object} data
 * @returns {object}
 */
function sanitizeForSync(data) {
  const clone = JSON.parse(JSON.stringify(data));
  if (clone.settings) {
    if (clone.settings.backgroundType === "custom") {
      clone.settings.backgroundCustom = "";
    }
  }
  clone.backups = [];
  for (const node of Object.values(clone.nodes || {})) {
    if (node.iconType === "upload" && node.iconData && node.iconData.length > ICON_DATA_MAX_LENGTH) {
      node.iconData = "";
      node.iconType = "auto";
    }
  }
  return clone;
}

/**
 * 选择最新的数据
 * @param {object | null} localData
 * @param {object | null} syncData
 * @returns {object | null}
 */
function pickLatestData(localData, syncData) {
  if (!syncData) return localData || null;
  if (!localData) return syncData || null;
  const localTs = Number(localData.lastUpdated || 0);
  const syncTs = Number(syncData.lastUpdated || 0);
  return syncTs >= localTs ? syncData : localData;
}

/**
 * 加载最新数据
 * @returns {Promise<{data: object | null, useSync: boolean}>}
 */
async function loadLatestData() {
  const localData = (await storageGet(ROOT_KEY, false)) || null;
  const useSync = !!localData?.settings?.syncEnabled;
  if (!useSync) return { data: localData, useSync: false };
  const syncData = (await storageGet(ROOT_KEY, true)) || null;
  const data = pickLatestData(localData, syncData);
  return { data, useSync: true };
}

/**
 * 获取当前标签页
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
async function getCurrentTab() {
  const api = getChrome();
  if (!api?.tabs) return null;
  const result = api.tabs.query({ active: true, currentWindow: true });
  if (typeof result?.then === "function") {
    const tabs = await result;
    return tabs?.[0] || null;
  }
  return new Promise((resolve) => api.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs?.[0] || null)));
}

/**
 * 获取扩展基础 URL
 * @returns {string}
 */
function getExtensionBaseUrl() {
  const api = getChrome();
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
  const api = getChrome();
  if (!api?.runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      api.runtime.sendMessage(message, (res) => {
        const err = api.runtime?.lastError;
        if (err) return resolve(null);
        resolve(res || null);
      });
    } catch (e) {
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
  const api = getChrome();
  if (!api?.tabs?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      api.tabs.sendMessage(tabId, message, (res) => {
        const err = api.runtime?.lastError;
        if (err) return resolve(null);
        resolve(res || null);
      });
    } catch (e) {
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
  card.innerHTML = "";
  const titleInput = document.createElement("input");
  titleInput.id = "tabTitleInput";
  titleInput.className = "tab-title-input";
  titleInput.type = "text";
  titleInput.value = tab.title || tab.url || "";
  titleInput.placeholder = "请输入标题";
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
  select.innerHTML = "";
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
    return null;
  }
  const { data, useSync } = await loadLatestData();
  if (!data || !data.groups || !data.nodes) {
    await appendLog({ ts: Date.now(), stage: "no_data" });
    return null;
  }

  const group = data.groups.find((g) => g.id === selectedGroupId) || data.groups[0];
  if (!group) {
    await appendLog({ ts: Date.now(), stage: "no_group" });
    return null;
  }
  if (!Array.isArray(group.nodes)) group.nodes = [];

  const id = `itm_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const trimmedTitle = String(customTitle || "").trim();
  const fallbackTitle = tab.title || new URL(url).hostname;
  data.nodes[id] = {
    id,
    type: "item",
    title: trimmedTitle || fallbackTitle,
    url,
    iconType: "auto",
    iconData: "",
    color: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  group.nodes.push(id);
  data.settings.lastActiveGroupId = group.id;
  data.settings.lastSaveUrl = url;
  data.settings.lastSaveTs = Date.now();
  // 弹窗保存仅在当前网页显示 toast，避免新标签页读取存储后重复提示
  data.settings.lastSaveToast = null;
  data.lastUpdated = Date.now();
  const payload = useSync ? sanitizeForSync(data) : data;
  if (useSync) {
    const size = estimateBytes(payload);
    if (size > SYNC_ITEM_QUOTA_BYTES) {
      data.settings.syncEnabled = false;
      await storageSet({ [ROOT_KEY]: data }, false);
      await appendLog({ ts: Date.now(), stage: "sync_quota_disable", bytes: size });
      return null;
    }
    const err = await storageSet({ [ROOT_KEY]: payload }, true);
    if (err) {
      data.settings.syncEnabled = false;
      await storageSet({ [ROOT_KEY]: data }, false);
      await appendLog({ ts: Date.now(), stage: "sync_error", error: err });
      return null;
    }
    await storageSet({ [ROOT_KEY]: data }, false);
  } else {
    await storageSet({ [ROOT_KEY]: data }, false);
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
  const api = getChrome();
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
          api.scripting.executeScript(
            { target: { tabId: tab.id }, files: ["js/content-toast.js"] },
            () => {
              const err = api.runtime?.lastError;
              if (err) return reject(err);
              resolve();
            }
          );
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
            func: (msg, size, duration) => {
              const toastId = "homepage-save-toast";
              const existing = document.getElementById(toastId);
              if (existing) existing.remove();
              const el = document.createElement("div");
              el.id = toastId;
              el.textContent = msg;
              const fontSizePx = `${Number(size) || 14}px`;
              Object.assign(el.style, {
                position: "fixed",
                top: "20px",
                right: "20px",
                zIndex: "2147483647",
                background: "rgba(15, 20, 28, 0.88)",
                color: "#ffffff",
                padding: "10px 14px",
                borderRadius: "10px",
                fontSize: fontSizePx,
                lineHeight: "1.2",
                boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                backdropFilter: "blur(6px)",
                fontFamily: "\"Avenir Next\", \"Noto Sans SC\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif",
              });
              document.body.appendChild(el);
              setTimeout(() => el.remove(), duration);
            },
            args: [message, fontSize, TOAST_DURATION_MS],
          },
          () => {
            const err = api.runtime?.lastError;
            if (err) return reject(err);
            resolve();
          }
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
      const code = `(function(){var toastId="homepage-save-toast";var existing=document.getElementById(toastId);if(existing){existing.remove();}var el=document.createElement("div");el.id=toastId;el.textContent=${msg};el.style.position="fixed";el.style.top="20px";el.style.right="20px";el.style.zIndex="2147483647";el.style.background="rgba(15, 20, 28, 0.88)";el.style.color="#ffffff";el.style.padding="10px 14px";el.style.borderRadius="10px";el.style.fontSize="${size}px";el.style.lineHeight="1.2";el.style.boxShadow="0 10px 30px rgba(0,0,0,0.35)";el.style.backdropFilter="blur(6px)";el.style.fontFamily="Avenir Next, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif";document.body.appendChild(el);setTimeout(function(){el.remove();},${TOAST_DURATION_MS});})();`;
      await new Promise((resolve, reject) => {
        api.tabs.executeScript(tab.id, { code }, () => {
          const err = api.runtime?.lastError;
          if (err) return reject(err);
          resolve();
        });
      });
      return true;
    }
    return true;
  } catch (e) {
    console.warn("showToastInTab failed", e);
    return false;
  }
}

/**
 * 初始化
 */
async function init() {
  const { data } = await loadLatestData();
  const tab = await getCurrentTab();
  const fixedId = data?.settings?.defaultGroupId;
  const isFixed = data?.settings?.defaultGroupMode === "fixed";
  const hasFixedGroup = !!(fixedId && data?.groups?.some((g) => g.id === fixedId));
  if (isFixed && hasFixedGroup) {
    if (tab) {
      const result = await saveToGroup(tab, fixedId);
      if (result) {
        await showToastInTab(tab, `已保存到分组：${result.groupName || "未命名"}`, result.fontSize);
      }
    }
    window.close();
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
  btnSave.addEventListener("click", async () => {
    if (saving) return;
    if (!tab) return;
    saving = true;
    btnSave.disabled = true;
    const selectedGroupId = document.getElementById("groupSelect").value;
    const tabTitleInput = document.getElementById("tabTitleInput");
    const customTitle = tabTitleInput ? tabTitleInput.value : "";
    const result = await saveToGroup(tab, selectedGroupId, customTitle);
    if (result) {
      await showToastInTab(tab, `已保存到分组：${result.groupName || "未命名"}`, result.fontSize);
    }
    window.close();
  });
}

init().catch((error) => {
  console.error("popup init failed", error);
  const empty = document.getElementById("empty");
  if (empty) {
    empty.textContent = "加载失败，请关闭后重试";
    empty.classList.remove("hidden");
  }
  document.body.classList.remove("hidden");
});
