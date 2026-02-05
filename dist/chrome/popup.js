const ROOT_KEY = "homepage_data";
const SYNC_ITEM_QUOTA_BYTES = 7500;

function getChrome() {
  if (typeof chrome !== "undefined") return chrome;
  if (typeof browser !== "undefined") return browser;
  return null;
}

function getLastError() {
  const api = getChrome();
  return api?.runtime?.lastError || null;
}

function storageArea(useSync) {
  const api = getChrome();
  if (!api || !api.storage) return null;
  return useSync ? api.storage.sync : api.storage.local;
}

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

function appendLog(entry) {
  const area = storageArea();
  return new Promise((resolve) => {
    area.get(LOG_KEY, (res) => {
      const list = Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
      list.unshift(entry);
      area.set({ [LOG_KEY]: list.slice(0, 30) }, () => resolve());
    });
  });
}

function normalizeUrl(input) {
  if (!input) return "";
  try {
    return new URL(input).href;
  } catch {
    try {
      return new URL(`https://${input}`).href;
    } catch {
      return "";
    }
  }
}

function estimateBytes(value) {
  const str = JSON.stringify(value);
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str).length;
  }
  return str.length;
}

function sanitizeForSync(data) {
  const clone = JSON.parse(JSON.stringify(data));
  if (clone.settings) {
    if (clone.settings.backgroundType === "custom") {
      clone.settings.backgroundCustom = "";
    }
  }
  clone.backups = [];
  for (const node of Object.values(clone.nodes || {})) {
    if (node.iconType === "upload" && node.iconData && node.iconData.length > 2048) {
      node.iconData = "";
      node.iconType = "auto";
    }
  }
  return clone;
}

function pickLatestData(localData, syncData) {
  if (!syncData) return localData || null;
  if (!localData) return syncData || null;
  const localTs = Number(localData.lastUpdated || 0);
  const syncTs = Number(syncData.lastUpdated || 0);
  return syncTs >= localTs ? syncData : localData;
}

async function loadLatestData() {
  const localData = (await storageGet(ROOT_KEY, false)) || null;
  const useSync = !!localData?.settings?.syncEnabled;
  if (!useSync) return { data: localData, useSync: false };
  const syncData = (await storageGet(ROOT_KEY, true)) || null;
  const data = pickLatestData(localData, syncData);
  return { data, useSync: true };
}

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
  card.innerHTML = `
    <div class="tab-title">${tab.title || tab.url}</div>
    <div class="tab-url">${tab.url || ""}</div>
  `;
}

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

async function saveToGroup(tab, selectedGroupId) {
  const url = normalizeUrl(tab?.url);
  if (!url) {
    await appendLog({ ts: Date.now(), stage: "invalid_url", raw: tab?.url || "" });
    return;
  }
  const { data, useSync } = await loadLatestData();
  if (!data || !data.groups || !data.nodes) {
    await appendLog({ ts: Date.now(), stage: "no_data" });
    return;
  }

  const group = data.groups.find((g) => g.id === selectedGroupId) || data.groups[0];
  if (!group) {
    await appendLog({ ts: Date.now(), stage: "no_group" });
    return;
  }
  if (!Array.isArray(group.nodes)) group.nodes = [];

  const id = `itm_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  data.nodes[id] = {
    id,
    type: "item",
    title: tab.title || new URL(url).hostname,
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
  data.lastUpdated = Date.now();
  const payload = useSync ? sanitizeForSync(data) : data;
  if (useSync) {
    const size = estimateBytes(payload);
    if (size > SYNC_ITEM_QUOTA_BYTES) {
      data.settings.syncEnabled = false;
      await storageSet({ [ROOT_KEY]: data }, false);
      await appendLog({ ts: Date.now(), stage: "sync_quota_disable", bytes: size });
      return;
    }
    const err = await storageSet({ [ROOT_KEY]: payload }, true);
    if (err) {
      data.settings.syncEnabled = false;
      await storageSet({ [ROOT_KEY]: data }, false);
      await appendLog({ ts: Date.now(), stage: "sync_error", error: err });
      return;
    }
    await storageSet({ [ROOT_KEY]: data }, false);
  } else {
    await storageSet({ [ROOT_KEY]: data }, false);
  }
  await appendLog({ ts: Date.now(), stage: "saved", url, group: group.id });
}

async function init() {
  const { data } = await loadLatestData();
  const tab = await getCurrentTab();
  renderTab(tab);
  renderGroups(data);
  if (data?.settings?.fontSize) {
    document.body.style.fontSize = `${data.settings.fontSize}px`;
  }
  let saving = false;
  const btnSave = document.getElementById("btnSave");
  btnSave.addEventListener("click", async () => {
    if (saving) return;
    if (!tab) return;
    saving = true;
    btnSave.disabled = true;
    const selectedGroupId = document.getElementById("groupSelect").value;
    await saveToGroup(tab, selectedGroupId);
    window.close();
  });
}

init();
