import {
  loadData,
  loadDataFromArea,
  saveData,
  clearData,
  createBackupSnapshot,
  defaultData,
  getChromeApi,
} from "./storage.js";
import { getBingWallpaper } from "./bing-wallpaper.js";
import { resolveIcon, refreshAllIcons, retryFailedIconsIfDue } from "./icons.js";

const $ = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const elements = {
  background: $("background"),
  grid: $("grid"),
  emptyState: $("emptyState"),
  emptyHintToggle: $("emptyHintToggle"),
  recentTab: $("recentTab"),
  groupTabs: $("groupTabs"),
  topSearch: $("topSearch"),
  topSearchWrap: $("topSearchWrap"),
  btnAdd: $("btnAdd"),
  btnBatchDelete: $("btnBatchDelete"),
  btnOpenMode: $("btnOpenMode"),
  btnSettings: $("btnSettings"),
  btnSearch: $("btnSearch"),
  btnAddGroup: $("btnAddGroup"),
  modalOverlay: $("modalOverlay"),
  modal: $("modal"),
  contextMenu: $("contextMenu"),
  toastContainer: $("toastContainer"),
  tooltip: $("tooltip"),
  folderOverlay: $("folderOverlay"),
  folderGrid: $("folderGrid"),
  folderTitle: $("folderTitle"),
  btnCloseFolder: $("btnCloseFolder"),
  btnFolderAdd: $("btnFolderAdd"),
  btnFolderBatchDelete: $("btnFolderBatchDelete"),
};

let data = null;
let activeGroupId = null;
let openFolderId = null;
let selectionMode = false;
let selectedIds = new Set();
let pendingDeletion = null;
let tooltipTimer = null;
let dragState = null;
let lastSelectedIndex = null;
let recentItems = [];

const RECENT_GROUP_ID = "__recent__";
const RECENT_LIMIT = 24;

const densityMap = {
  compact: { gap: 10, size: 80, font: 12, icon: 32 },
  standard: { gap: 16, size: 96, font: 13, icon: 38 },
  spacious: { gap: 22, size: 112, font: 14, icon: 44 },
};

function applyDensity() {
  const d = densityMap[data.settings.gridDensity] || densityMap.standard;
  document.documentElement.style.setProperty("--grid-gap", `${d.gap}px`);
  document.documentElement.style.setProperty("--tile-size", `${d.size}px`);
  document.documentElement.style.setProperty("--tile-font", `${d.font}px`);
  document.documentElement.style.setProperty("--tile-icon", `${d.icon}px`);
}

function toast(message, actionLabel, action) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${message}</span>`;
  if (actionLabel && action) {
    const btn = document.createElement("button");
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => {
      action();
      el.remove();
    });
    el.appendChild(btn);
  }
  elements.toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function showTooltip(text, x, y) {
  if (!data.settings.tooltipEnabled) return;
  elements.tooltip.textContent = text;
  elements.tooltip.style.left = `${x + 12}px`;
  elements.tooltip.style.top = `${y + 12}px`;
  elements.tooltip.classList.remove("hidden");
}

function hideTooltip() {
  elements.tooltip.classList.add("hidden");
}

function normalizeUrl(input) {
  if (!input) return "";
  try {
    const url = new URL(input);
    return url.href;
  } catch (err) {
    const withScheme = `https://${input}`;
    try {
      const url = new URL(withScheme);
      return url.href;
    } catch (err2) {
      return "";
    }
  }
}

async function openUrl(url, mode) {
  const api = getChromeApi();
  const openMode = mode || data.settings.openMode;
  if (api?.tabs && (openMode === "new" || openMode === "background")) {
    api.tabs.create({ url, active: openMode !== "background" });
    return;
  }
  if (openMode === "new") {
    window.open(url, "_blank");
  } else if (openMode === "background") {
    window.open(url, "_blank", "noopener,noreferrer");
  } else {
    window.location.href = url;
  }
}

function setBackground(style) {
  if (!style) return;
  if (style.startsWith("data:") || style.startsWith("http")) {
    elements.background.style.backgroundImage = `url('${style}')`;
  } else {
    elements.background.style.backgroundImage = style;
  }
}

async function loadBackground() {
  const settings = data.settings;
  elements.background.classList.add("is-loading");

  if (settings.backgroundType === "bing") {
    const info = await getBingWallpaper();
    if (info.dataUrl) {
      setBackground(info.dataUrl);
      if (info.failed) toast("壁纸获取失败，已回退到缓存");
      else toast("已更新今日 Bing 壁纸");
    } else {
      elements.background.style.background = settings.backgroundColor;
      toast("壁纸获取失败，已使用默认背景");
    }
  } else if (settings.backgroundType === "color") {
    elements.background.style.backgroundImage = "none";
    elements.background.style.background = settings.backgroundColor;
  } else if (settings.backgroundType === "gradient") {
    setBackground(settings.backgroundGradient);
  } else if (settings.backgroundType === "custom") {
    setBackground(settings.backgroundCustom || settings.backgroundColor);
  }

  elements.background.classList.remove("is-loading");
}

function pushBackup() {
  if (!data.settings.maxBackups) return;
  const snapshot = createBackupSnapshot(data);
  data.backups.unshift(snapshot);
  if (data.settings.maxBackups > 0 && data.backups.length > data.settings.maxBackups) {
    data.backups = data.backups.slice(0, data.settings.maxBackups);
  }
}

async function persistData() {
  const useSync = data.settings.syncEnabled;
  await saveData(data, useSync);
  if (useSync) {
    await saveData(data, false);
  }
}

function getActiveGroup() {
  return data.groups.find((g) => g.id === activeGroupId) || data.groups[0];
}

function getCurrentNodes() {
  if (activeGroupId === RECENT_GROUP_ID) return recentItems;
  const group = getActiveGroup();
  const nodeIds = openFolderId ? data.nodes[openFolderId]?.children || [] : group.nodes;
  return nodeIds.map((id) => data.nodes[id]).filter(Boolean);
}

function renderGroups() {
  elements.groupTabs.innerHTML = "";
  elements.recentTab.classList.toggle("active", activeGroupId === RECENT_GROUP_ID);
  data.groups
    .sort((a, b) => a.order - b.order)
    .forEach((group) => {
      const btn = document.createElement("button");
      btn.className = `group-tab ${group.id === activeGroupId ? "active" : ""}`;
      btn.textContent = group.name;
      btn.addEventListener("click", () => {
        activeGroupId = group.id;
        openFolderId = null;
        data.settings.lastActiveGroupId = activeGroupId;
        persistData();
        render();
      });
      elements.groupTabs.appendChild(btn);
    });
}

async function renderGrid() {
  const grid = openFolderId ? elements.folderGrid : elements.grid;
  const nodes = getCurrentNodes();
  grid.innerHTML = "";

  const width = grid.clientWidth || window.innerWidth;
  const tileSize = densityMap[data.settings.gridDensity]?.size || 96;
  let columns = Math.max(3, Math.floor(width / (tileSize + 32)));
  if (data.settings.fixedLayout) {
    columns = Math.max(1, data.settings.fixedCols || 8);
  }
  grid.style.gridTemplateColumns = `repeat(${columns}, minmax(${tileSize}px, 1fr))`;

  for (const [idx, node] of nodes.entries()) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.id = node.id;
    tile.dataset.index = idx;
    tile.draggable = true;
    tile.tabIndex = 0;

    const icon = document.createElement("div");
    icon.className = "tile-icon";
    const img = document.createElement("img");
    img.alt = node.title || node.url || "";
    img.src = await resolveIcon(node, data.settings);
    icon.appendChild(img);

    const title = document.createElement("div");
    title.className = "tile-title";
    title.textContent = node.title || node.url || "未命名";

    tile.appendChild(icon);
    tile.appendChild(title);

    if (node.type === "folder") {
      const badge = document.createElement("div");
      badge.className = "tile-badge";
      badge.textContent = `${node.children?.length || 0}`;
      tile.appendChild(badge);
    }

    if (selectedIds.has(node.id)) {
      tile.classList.add("selected");
    }

    tile.addEventListener("click", (e) => {
      if (selectionMode) {
        toggleSelect(node.id, idx, e.shiftKey);
        return;
      }
      if (node.type === "folder") {
        openFolder(node.id);
      } else {
        const url = normalizeUrl(node.url);
        if (!url) {
          toast("URL 无效");
          return;
        }
        openUrl(url);
      }
    });

    tile.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, node);
    });

    tile.addEventListener("mouseenter", (e) => {
      if (!data.settings.tooltipEnabled) return;
      clearTimeout(tooltipTimer);
      const text = node.type === "folder" ? `${node.title}（文件夹）` : `${node.title}\n${node.url}`;
      tooltipTimer = setTimeout(() => showTooltip(text, e.clientX, e.clientY), 200);
    });
    tile.addEventListener("mouseleave", () => {
      clearTimeout(tooltipTimer);
      hideTooltip();
    });

    tile.addEventListener("dragstart", (e) => {
      dragState = { id: node.id, fromFolder: openFolderId };
      e.dataTransfer.effectAllowed = "move";
    });
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleDropOnTile(node.id);
    });

    grid.appendChild(tile);
  }

  updateEmptyState();
}

function updateEmptyState() {
  if (activeGroupId === RECENT_GROUP_ID) {
    elements.emptyState.classList.add("hidden");
    return;
  }
  const nodes = getCurrentNodes();
  if (nodes.length === 0 && !data.settings.emptyHintDisabled) {
    elements.emptyState.classList.remove("hidden");
  } else {
    elements.emptyState.classList.add("hidden");
  }
}

function openFolder(folderId) {
  openFolderId = folderId;
  elements.folderOverlay.classList.remove("hidden");
  elements.folderOverlay.setAttribute("aria-hidden", "false");
  elements.folderTitle.textContent = data.nodes[folderId]?.title || "文件夹";
  render();
}

function closeFolder() {
  openFolderId = null;
  elements.folderOverlay.classList.add("hidden");
  elements.folderOverlay.setAttribute("aria-hidden", "true");
  render();
}

function toggleSelect(id, index, range) {
  const nodes = getCurrentNodes();
  if (range && lastSelectedIndex !== null) {
    const start = Math.min(lastSelectedIndex, index);
    const end = Math.max(lastSelectedIndex, index);
    for (let i = start; i <= end; i++) {
      if (nodes[i]) selectedIds.add(nodes[i].id);
    }
  } else {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    lastSelectedIndex = index;
  }
  if (lastSelectedIndex === null && typeof index === "number") {
    lastSelectedIndex = index;
  }
  render();
}

function clearSelection() {
  selectedIds.clear();
  selectionMode = false;
  lastSelectedIndex = null;
}

function openContextMenu(x, y, node) {
  elements.contextMenu.innerHTML = "";
  const actions = [];
  if (activeGroupId === RECENT_GROUP_ID && node.type === "history") {
    actions.push({ label: "打开", fn: () => openUrl(normalizeUrl(node.url)) });
    actions.push({ label: "新标签打开", fn: () => openUrl(normalizeUrl(node.url), "new") });
    actions.push({ label: "添加到快捷", fn: () => addHistoryToShortcuts(node) });
  } else if (node.type !== "folder") {
    actions.push({ label: "打开", fn: () => openUrl(normalizeUrl(node.url)) });
    actions.push({ label: "新标签打开", fn: () => openUrl(normalizeUrl(node.url), "new") });
    actions.push({ label: "后台打开", fn: () => openUrl(normalizeUrl(node.url), "background") });
  } else {
    actions.push({ label: "打开文件夹", fn: () => openFolder(node.id) });
    actions.push({ label: "解散文件夹", fn: () => dissolveFolder(node.id) });
  }
  if (node.type !== "history") {
    actions.push({ label: "编辑", fn: () => openEditModal(node) });
    actions.push({ label: "删除", fn: () => deleteNodes([node.id]) });
  }

  for (const action of actions) {
    const btn = document.createElement("button");
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.fn();
      elements.contextMenu.classList.add("hidden");
    });
    elements.contextMenu.appendChild(btn);
  }
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.top = `${y}px`;
  elements.contextMenu.classList.remove("hidden");
}

function closeContextMenu() {
  elements.contextMenu.classList.add("hidden");
}

function handleDropOnTile(targetId) {
  if (!dragState || dragState.id === targetId) return;
  if (activeGroupId === RECENT_GROUP_ID) return;
  const sourceId = dragState.id;
  const targetNode = data.nodes[targetId];
  const sourceNode = data.nodes[sourceId];
  if (!targetNode || !sourceNode) return;

  if (targetNode.type !== "folder") {
    pushBackup();
    const folderId = `fld_${Date.now()}`;
    const folder = {
      id: folderId,
      type: "folder",
      title: "新建文件夹",
      children: [targetId, sourceId],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    data.nodes[folderId] = folder;

    removeNodeFromLocation(sourceId);
    removeNodeFromLocation(targetId);

    const group = getActiveGroup();
    group.nodes.push(folderId);
    persistData();
    render();
    toast("已创建文件夹");
    return;
  }

  pushBackup();
  removeNodeFromLocation(sourceId);
  targetNode.children = targetNode.children || [];
  targetNode.children.push(sourceId);
  persistData();
  render();
  toast("已加入文件夹");
}

function dissolveFolder(folderId) {
  const folder = data.nodes[folderId];
  if (!folder || folder.type !== "folder") return;
  pushBackup();
  removeNodeFromLocation(folderId);
  const group = getActiveGroup();
  group.nodes.push(...(folder.children || []));
  delete data.nodes[folderId];
  persistData();
  render();
  toast("已解散文件夹");
}

function removeNodeFromLocation(id) {
  for (const group of data.groups) {
    group.nodes = group.nodes.filter((nid) => nid !== id);
  }
  for (const node of Object.values(data.nodes)) {
    if (node.type === "folder" && Array.isArray(node.children)) {
      node.children = node.children.filter((nid) => nid !== id);
    }
  }
}

function moveNodeInList(list, id, index) {
  const next = list.filter((nid) => nid !== id);
  const safeIndex = Math.max(0, Math.min(index, next.length));
  next.splice(safeIndex, 0, id);
  return next;
}

function deleteNodes(ids) {
  if (!ids.length) return;
  if (activeGroupId === RECENT_GROUP_ID) return;
  pushBackup();
  const snapshot = JSON.parse(JSON.stringify(data));

  ids.forEach((id) => {
    removeNodeFromLocation(id);
    delete data.nodes[id];
  });

  pendingDeletion = { snapshot, ids };
  persistData();
  render();

  toast(`已删除 ${ids.length} 个快捷按钮`, "撤销", () => undoDelete());
  setTimeout(() => {
    pendingDeletion = null;
  }, 5000);
}

function undoDelete() {
  if (!pendingDeletion) return;
  data = pendingDeletion.snapshot;
  pendingDeletion = null;
  persistData();
  render();
  toast("已恢复");
}

function openModal(html) {
  elements.modal.innerHTML = html;
  elements.modalOverlay.classList.remove("hidden");
  elements.modalOverlay.setAttribute("aria-hidden", "false");
}

function closeModal() {
  elements.modalOverlay.classList.add("hidden");
  elements.modalOverlay.setAttribute("aria-hidden", "true");
  elements.modal.innerHTML = "";
}

function openAddModal() {
  const html = `
    <h2>新增快捷按钮</h2>
    <div class="section">
      <label>网址</label>
      <input id="fieldUrl" type="url" placeholder="https://" />
    </div>
    <div class="section">
      <label>标题</label>
      <input id="fieldTitle" type="text" placeholder="可选" />
    </div>
    <div class="section">
      <label>图标来源</label>
      <select id="fieldIconType">
        <option value="auto">自动抓取 favicon</option>
        <option value="upload">上传图标</option>
        <option value="color">颜色头像</option>
        <option value="remote">远程图标 URL</option>
      </select>
    </div>
    <div id="iconExtra" class="section"></div>
    <div class="section">
      <button id="btnFromTab" class="icon-btn">从当前标签页添加</button>
    </div>
    <div class="actions">
      <button id="btnCancel" class="icon-btn">取消</button>
      <button id="btnSave" class="icon-btn">保存</button>
    </div>
  `;
  openModal(html);

  const iconTypeEl = $("fieldIconType");
  const iconExtra = $("iconExtra");

  function renderIconExtra(type) {
    iconExtra.innerHTML = "";
    if (type === "upload") {
      iconExtra.innerHTML = `<label>上传图标</label><input id="fieldUpload" type="file" accept="image/*" />`;
    } else if (type === "color") {
      iconExtra.innerHTML = `<label>头像颜色</label><input id="fieldColor" type="color" value="#4dd6a8" />`;
    } else if (type === "remote") {
      iconExtra.innerHTML = `<label>远程图标 URL</label><input id="fieldRemote" type="url" placeholder="https://" />`;
    }
  }

  renderIconExtra(iconTypeEl.value);
  iconTypeEl.addEventListener("change", () => renderIconExtra(iconTypeEl.value));

  $("btnFromTab").addEventListener("click", async () => {
    const api = getChromeApi();
    if (!api?.tabs) return;
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab) return;
      $("fieldUrl").value = tab.url || "";
      $("fieldTitle").value = tab.title || "";
    });
  });

  $("btnCancel").addEventListener("click", closeModal);
  $("btnSave").addEventListener("click", async () => {
    const url = normalizeUrl($("fieldUrl").value.trim());
    if (!url) {
      toast("URL 不合法");
      return;
    }
    const title = $("fieldTitle").value.trim() || new URL(url).hostname;
    const iconType = iconTypeEl.value;
    let iconData = "";
    let color = "";

    if (iconType === "upload") {
      const file = $("fieldUpload")?.files?.[0];
      if (file) {
        iconData = await readFileAsDataUrl(file);
      }
    } else if (iconType === "color") {
      color = $("fieldColor").value;
    } else if (iconType === "remote") {
      iconData = $("fieldRemote").value.trim();
    }

    pushBackup();
    const id = `itm_${Date.now()}`;
    data.nodes[id] = {
      id,
      type: "item",
      title,
      url,
      iconType,
      iconData,
      color,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (openFolderId) {
      data.nodes[openFolderId].children.push(id);
    } else {
      getActiveGroup().nodes.push(id);
    }
    await persistData();
    render();
    closeModal();
    toast("新增成功");
  });
}

function openEditModal(node) {
  const html = `
    <h2>编辑</h2>
    <div class="section">
      <label>标题</label>
      <input id="fieldTitle" type="text" value="${node.title || ""}" />
    </div>
    ${node.type === "item" ? `
    <div class="section">
      <label>网址</label>
      <input id="fieldUrl" type="url" value="${node.url || ""}" />
    </div>
    <div class="section">
      <label>图标来源</label>
      <select id="fieldIconType">
        <option value="auto">自动抓取 favicon</option>
        <option value="upload">上传图标</option>
        <option value="color">颜色头像</option>
        <option value="remote">远程图标 URL</option>
      </select>
    </div>
    <div id="iconExtra" class="section"></div>
    ` : ""}
    <div class="actions">
      <button id="btnCancel" class="icon-btn">取消</button>
      <button id="btnSave" class="icon-btn">保存</button>
    </div>
  `;
  openModal(html);

  if (node.type === "item") {
    const iconTypeEl = $("fieldIconType");
    iconTypeEl.value = node.iconType || "auto";
    const iconExtra = $("iconExtra");
    function renderIconExtra(type) {
      iconExtra.innerHTML = "";
      if (type === "upload") {
        iconExtra.innerHTML = `<label>上传图标</label><input id="fieldUpload" type="file" accept="image/*" />`;
      } else if (type === "color") {
        iconExtra.innerHTML = `<label>头像颜色</label><input id="fieldColor" type="color" value="${node.color || "#4dd6a8"}" />`;
      } else if (type === "remote") {
        iconExtra.innerHTML = `<label>远程图标 URL</label><input id="fieldRemote" type="url" value="${node.iconData || ""}" />`;
      }
    }
    renderIconExtra(iconTypeEl.value);
    iconTypeEl.addEventListener("change", () => renderIconExtra(iconTypeEl.value));
  }

  $("btnCancel").addEventListener("click", closeModal);
  $("btnSave").addEventListener("click", async () => {
    pushBackup();
    node.title = $("fieldTitle").value.trim() || node.title;
    if (node.type === "item") {
      const url = normalizeUrl($("fieldUrl").value.trim());
      if (!url) {
        toast("URL 不合法");
        return;
      }
      node.url = url;
      const iconType = $("fieldIconType").value;
      node.iconType = iconType;
      if (iconType === "upload") {
        const file = $("fieldUpload")?.files?.[0];
        if (file) node.iconData = await readFileAsDataUrl(file);
      } else if (iconType === "color") {
        node.color = $("fieldColor").value;
        node.iconData = "";
      } else if (iconType === "remote") {
        node.iconData = $("fieldRemote").value.trim();
      } else {
        node.iconData = "";
      }
    }
    node.updatedAt = Date.now();
    await persistData();
    render();
    closeModal();
    toast("保存成功");
  });
}

function openOpenModeMenu() {
  const html = `
    <h2>打开方式</h2>
    <div class="section">
      <select id="fieldOpenMode">
        <option value="current">当前标签打开</option>
        <option value="new">新标签打开</option>
        <option value="background">后台新标签打开</option>
      </select>
    </div>
    <div class="actions">
      <button id="btnCancel" class="icon-btn">取消</button>
      <button id="btnSave" class="icon-btn">保存</button>
    </div>
  `;
  openModal(html);
  $("fieldOpenMode").value = data.settings.openMode;
  $("btnCancel").addEventListener("click", closeModal);
  $("btnSave").addEventListener("click", async () => {
    data.settings.openMode = $("fieldOpenMode").value;
    await persistData();
    closeModal();
    toast("已更新打开方式");
  });
}

function openSettingsModal() {
  const groupsHtml = data.groups
    .sort((a, b) => a.order - b.order)
    .map(
      (g) => `
      <div class="row" data-group="${g.id}">
        <input type="text" value="${g.name}" class="group-name" />
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="icon-btn group-up">上移</button>
          <button class="icon-btn group-down">下移</button>
          <button class="icon-btn group-del">删除</button>
        </div>
      </div>`
    )
    .join("");

  const html = `
    <h2>设置</h2>
    <div class="section">
      <label><input id="settingShowSearch" type="checkbox"> 显示顶部搜索框</label>
      <label><input id="settingEnableSearchEngine" type="checkbox"> 回车使用默认搜索引擎</label>
      <label>默认搜索引擎 URL</label>
      <input id="settingSearchEngine" type="text" placeholder="https://www.bing.com/search?q=" />
    </div>

    <div class="section">
      <label>打开方式</label>
      <select id="settingOpenMode">
        <option value="current">当前标签打开</option>
        <option value="new">新标签打开</option>
        <option value="background">后台新标签打开</option>
      </select>
    </div>

    <div class="section">
      <label><input id="settingFixedLayout" type="checkbox"> 固定布局</label>
      <div class="row">
        <div>
          <label>行数</label>
          <input id="settingRows" type="number" min="1" />
        </div>
        <div>
          <label>列数</label>
          <input id="settingCols" type="number" min="1" />
        </div>
      </div>
      <label>网格密度</label>
      <select id="settingDensity">
        <option value="compact">紧凑</option>
        <option value="standard">标准</option>
        <option value="spacious">宽松</option>
      </select>
    </div>

    <div class="section">
      <label>背景</label>
      <select id="settingBgType">
        <option value="bing">每日 Bing</option>
        <option value="color">纯色</option>
        <option value="gradient">渐变</option>
        <option value="custom">自定义图片</option>
      </select>
      <label>背景颜色</label>
      <input id="settingBgColor" type="color" />
      <label>渐变 CSS</label>
      <input id="settingBgGradient" type="text" placeholder="linear-gradient(...)" />
      <label>自定义图片</label>
      <input id="settingBgFile" type="file" accept="image/*" />
    </div>

    <div class="section">
      <label><input id="settingTooltip" type="checkbox"> 启用 Tooltip</label>
      <label><input id="settingKeyboard" type="checkbox"> 启用键盘导航</label>
    </div>

    <div class="section">
      <label><input id="settingSync" type="checkbox"> 启用同步</label>
      <label><input id="settingTrash" type="checkbox"> 删除进入回收站（预留）</label>
      <label>最大备份数量（0 表示不备份）</label>
      <input id="settingBackup" type="number" min="0" />
      <label><input id="settingIconRetry" type="checkbox"> 18:00 自动重试图标</label>
    </div>

    <div class="section">
      <label>分组管理</label>
      <div id="groupList">${groupsHtml}</div>
      <button id="btnAddGroup" class="icon-btn">新增分组</button>
    </div>

    <div class="section">
      <button id="btnExport" class="icon-btn">导出 JSON</button>
      <button id="btnImport" class="icon-btn">导入 JSON</button>
      <button id="btnBackupManage" class="icon-btn">备份管理</button>
      <button id="btnClearData" class="icon-btn danger">清空数据</button>
      <button id="btnRefreshIcons" class="icon-btn">刷新所有图标</button>
    </div>

    <div class="actions">
      <button id="btnCancel" class="icon-btn">关闭</button>
      <button id="btnSave" class="icon-btn">保存设置</button>
    </div>
  `;
  openModal(html);

  $("settingShowSearch").checked = data.settings.showSearch;
  $("settingEnableSearchEngine").checked = data.settings.enableSearchEngine;
  $("settingSearchEngine").value = data.settings.searchEngineUrl;
  $("settingOpenMode").value = data.settings.openMode;
  $("settingFixedLayout").checked = data.settings.fixedLayout;
  $("settingRows").value = data.settings.fixedRows;
  $("settingCols").value = data.settings.fixedCols;
  $("settingDensity").value = data.settings.gridDensity;
  $("settingBgType").value = data.settings.backgroundType;
  $("settingBgColor").value = data.settings.backgroundColor;
  $("settingBgGradient").value = data.settings.backgroundGradient;
  $("settingTooltip").checked = data.settings.tooltipEnabled;
  $("settingKeyboard").checked = data.settings.keyboardNav;
  $("settingSync").checked = data.settings.syncEnabled;
  $("settingTrash").checked = data.settings.trashEnabled;
  $("settingBackup").value = data.settings.maxBackups;
  $("settingIconRetry").checked = data.settings.iconRetryAtSix;

  $("btnAddGroup").addEventListener("click", () => {
    const groupId = `grp_${Date.now()}`;
    data.groups.push({ id: groupId, name: "新分组", order: data.groups.length, nodes: [] });
    openSettingsModal();
  });

  qsa(".group-up", elements.modal).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-group]");
      const id = row.dataset.group;
      const idx = data.groups.findIndex((g) => g.id === id);
      if (idx > 0) {
        const tmp = data.groups[idx - 1];
        data.groups[idx - 1] = data.groups[idx];
        data.groups[idx] = tmp;
        openSettingsModal();
      }
    });
  });

  qsa(".group-down", elements.modal).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-group]");
      const id = row.dataset.group;
      const idx = data.groups.findIndex((g) => g.id === id);
      if (idx >= 0 && idx < data.groups.length - 1) {
        const tmp = data.groups[idx + 1];
        data.groups[idx + 1] = data.groups[idx];
        data.groups[idx] = tmp;
        openSettingsModal();
      }
    });
  });

  qsa(".group-del", elements.modal).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-group]");
      const id = row.dataset.group;
      if (data.groups.length <= 1) {
        toast("至少保留一个分组");
        return;
      }
      data.groups = data.groups.filter((g) => g.id !== id);
      if (activeGroupId === id) activeGroupId = data.groups[0].id;
      openSettingsModal();
    });
  });

  $("btnExport").addEventListener("click", () => openExportModal());
  $("btnImport").addEventListener("click", () => openImportModal());
  $("btnBackupManage").addEventListener("click", () => openBackupModal());
  $("btnClearData").addEventListener("click", async () => {
    if (!confirm("确认清空全部数据？")) return;
    data = defaultData();
    activeGroupId = data.groups[0].id;
    await clearData(data.settings.syncEnabled);
    await persistData();
    closeModal();
    render();
    toast("已清空");
  });
  $("btnRefreshIcons").addEventListener("click", async () => {
    await refreshAllIcons(Object.values(data.nodes));
    toast("图标刷新完成");
  });

  $("btnCancel").addEventListener("click", closeModal);
  $("btnSave").addEventListener("click", async () => {
    qsa(".group-name", elements.modal).forEach((input) => {
      const row = input.closest("[data-group]");
      const id = row.dataset.group;
      const group = data.groups.find((g) => g.id === id);
      if (group) group.name = input.value.trim() || group.name;
    });

    data.settings.showSearch = $("settingShowSearch").checked;
    data.settings.enableSearchEngine = $("settingEnableSearchEngine").checked;
    data.settings.searchEngineUrl = $("settingSearchEngine").value.trim() || data.settings.searchEngineUrl;
    data.settings.openMode = $("settingOpenMode").value;
    data.settings.fixedLayout = $("settingFixedLayout").checked;
    data.settings.fixedRows = Number($("settingRows").value) || 3;
    data.settings.fixedCols = Number($("settingCols").value) || 8;
    data.settings.gridDensity = $("settingDensity").value;
    data.settings.backgroundType = $("settingBgType").value;
    data.settings.backgroundColor = $("settingBgColor").value;
    data.settings.backgroundGradient = $("settingBgGradient").value.trim() || data.settings.backgroundGradient;
    data.settings.tooltipEnabled = $("settingTooltip").checked;
    data.settings.keyboardNav = $("settingKeyboard").checked;
    data.settings.syncEnabled = $("settingSync").checked;
    data.settings.trashEnabled = $("settingTrash").checked;
    data.settings.maxBackups = Number($("settingBackup").value) || 0;
    data.settings.iconRetryAtSix = $("settingIconRetry").checked;

    const bgFile = $("settingBgFile").files?.[0];
    if (bgFile) {
      data.settings.backgroundCustom = await readFileAsDataUrl(bgFile);
    }

    applyDensity();
    await persistData();
    await loadBackground();
    closeModal();
    render();
    toast("设置已保存");
  });
}

function openExportModal() {
  const payload = JSON.stringify(data, null, 2);
  const html = `
    <h2>导出 JSON</h2>
    <div class="section">
      <textarea readonly>${payload}</textarea>
    </div>
    <div class="actions">
      <button id="btnCopy" class="icon-btn">复制</button>
      <button id="btnClose" class="icon-btn">关闭</button>
    </div>
  `;
  openModal(html);
  $("btnCopy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(payload);
    toast("已复制");
  });
  $("btnClose").addEventListener("click", closeModal);
}

function openImportModal() {
  const html = `
    <h2>导入 JSON</h2>
    <div class="section">
      <label>导入策略</label>
      <select id="importMode">
        <option value="replace">覆盖所有</option>
        <option value="merge">合并现有</option>
        <option value="add">仅新增不覆盖</option>
      </select>
    </div>
    <div class="section">
      <textarea id="importText" placeholder="粘贴 JSON"></textarea>
    </div>
    <div class="actions">
      <button id="btnCancel" class="icon-btn">取消</button>
      <button id="btnImportNow" class="icon-btn">导入</button>
    </div>
  `;
  openModal(html);
  $("btnCancel").addEventListener("click", closeModal);
  $("btnImportNow").addEventListener("click", async () => {
    try {
      const incoming = JSON.parse($("importText").value.trim());
      const mode = $("importMode").value;
      if (!incoming.schemaVersion) throw new Error("无 schemaVersion");
      pushBackup();
      if (mode === "replace") {
        data = incoming;
      } else if (mode === "merge") {
        data.groups = [...data.groups, ...incoming.groups];
        data.nodes = { ...data.nodes, ...incoming.nodes };
      } else if (mode === "add") {
        for (const [id, node] of Object.entries(incoming.nodes || {})) {
          if (!data.nodes[id]) data.nodes[id] = node;
        }
        data.groups = [...data.groups, ...incoming.groups.filter((g) => !data.groups.find((x) => x.id === g.id))];
      }
      await persistData();
      closeModal();
      render();
      toast("导入成功");
    } catch (err) {
      toast(`导入失败：${err.message}`);
    }
  });
}

function openBackupModal() {
  const list = data.backups
    .map((b) => `<div class="row" data-backup="${b.id}"><div>${new Date(b.ts).toLocaleString()}</div><button class="icon-btn backup-restore">恢复</button></div>`)
    .join("");
  const html = `
    <h2>备份管理</h2>
    <div class="section">${list || "暂无备份"}</div>
    <div class="actions"><button id="btnClose" class="icon-btn">关闭</button></div>
  `;
  openModal(html);
  qsa(".backup-restore", elements.modal).forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-backup]");
      const backup = data.backups.find((b) => b.id === row.dataset.backup);
      if (!backup) return;
      data = backup.data;
      persistData();
      closeModal();
      render();
      toast("已恢复备份");
    });
  });
  $("btnClose").addEventListener("click", closeModal);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadRecentHistory() {
  const api = getChromeApi();
  if (!api?.history?.search) return [];
  const startTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    const result = api.history.search({ text: "", startTime, maxResults: RECENT_LIMIT });
    const items = typeof result?.then === "function" ? await result : await new Promise((resolve) => {
      api.history.search({ text: "", startTime, maxResults: RECENT_LIMIT }, (res) => resolve(res || []));
    });
    return (items || [])
      .filter((item) => item.url)
      .map((item, idx) => ({
        id: `recent_${idx}`,
        type: "history",
        title: item.title || item.url,
        url: item.url,
      }));
  } catch (err) {
    return [];
  }
}

async function addHistoryToShortcuts(node) {
  if (!node?.url) return;
  pushBackup();
  const id = `itm_${Date.now()}`;
  data.nodes[id] = {
    id,
    type: "item",
    title: node.title || new URL(node.url).hostname,
    url: node.url,
    iconType: "auto",
    iconData: "",
    color: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  getActiveGroup().nodes.push(id);
  await persistData();
  render();
  toast("已添加到快捷");
}

function handleSearchInput() {
  const query = elements.topSearch.value.trim().toLowerCase();
  if (!query) {
    render();
    return;
  }
  const grid = openFolderId ? elements.folderGrid : elements.grid;
  qsa(".tile", grid).forEach((tile) => {
    const node = data.nodes[tile.dataset.id];
    const text = `${node.title || ""} ${node.url || ""}`.toLowerCase();
    tile.style.display = text.includes(query) ? "" : "none";
  });
}

function getDropIndex(grid, x, y) {
  const tiles = qsa(".tile", grid);
  for (let i = 0; i < tiles.length; i++) {
    const rect = tiles[i].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return i;
  }
  return tiles.length;
}

async function init() {
  data = await loadData();
  if (data.settings.syncEnabled) {
    const syncData = await loadDataFromArea(true);
    if (syncData && syncData.groups?.length) data = syncData;
  }
  activeGroupId = data.settings.lastActiveGroupId || RECENT_GROUP_ID;
  if (activeGroupId !== RECENT_GROUP_ID && !data.groups.find((g) => g.id === activeGroupId)) {
    activeGroupId = RECENT_GROUP_ID;
  }
  recentItems = await loadRecentHistory();
  applyDensity();
  closeModal();
  closeFolder();
  await loadBackground();
  await retryFailedIconsIfDue(data.settings);
  render();
}

function render() {
  renderGroups();
  renderGrid();
  elements.topSearchWrap.classList.toggle("hidden", !data.settings.showSearch);
  elements.emptyHintToggle.checked = data.settings.emptyHintDisabled;
}

function bindEvents() {
  window.addEventListener("resize", () => render());

  elements.btnAdd.addEventListener("click", openAddModal);
  elements.btnFolderAdd.addEventListener("click", openAddModal);
  elements.recentTab.addEventListener("click", async () => {
    activeGroupId = RECENT_GROUP_ID;
    openFolderId = null;
    data.settings.lastActiveGroupId = activeGroupId;
    persistData();
    recentItems = await loadRecentHistory();
    render();
  });
  elements.btnAddGroup.addEventListener("click", () => {
    const groupId = `grp_${Date.now()}`;
    data.groups.push({ id: groupId, name: "新分组", order: data.groups.length, nodes: [] });
    activeGroupId = groupId;
    data.settings.lastActiveGroupId = activeGroupId;
    persistData();
    render();
  });

  elements.btnBatchDelete.addEventListener("click", () => {
    if (activeGroupId === RECENT_GROUP_ID) {
      toast("最近浏览不可批量删除");
      return;
    }
    if (!selectionMode) {
      selectionMode = true;
      toast("进入批量选择模式");
      render();
      return;
    }
    const ids = Array.from(selectedIds);
    if (!ids.length) {
      toast("未选择任何按钮");
      return;
    }
    deleteNodes(ids);
    clearSelection();
    render();
  });

  elements.btnFolderBatchDelete.addEventListener("click", () => {
    if (activeGroupId === RECENT_GROUP_ID) {
      toast("最近浏览不可批量删除");
      return;
    }
    if (!selectionMode) {
      selectionMode = true;
      toast("进入批量选择模式");
      render();
      return;
    }
    const ids = Array.from(selectedIds);
    if (!ids.length) {
      toast("未选择任何按钮");
      return;
    }
    deleteNodes(ids);
    clearSelection();
    render();
  });

  elements.btnOpenMode.addEventListener("click", openOpenModeMenu);
  elements.btnSettings.addEventListener("click", openSettingsModal);
  elements.btnSearch.addEventListener("click", () => elements.topSearch.focus());

  elements.topSearch.addEventListener("input", handleSearchInput);
  elements.topSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && data.settings.enableSearchEngine) {
      const query = elements.topSearch.value.trim();
      if (!query) return;
      openUrl(`${data.settings.searchEngineUrl}${encodeURIComponent(query)}`, "new");
    }
  });

  elements.topSearch.addEventListener("focus", async () => {
    if (activeGroupId === RECENT_GROUP_ID) {
      recentItems = await loadRecentHistory();
      render();
    }
  });

  elements.emptyHintToggle.addEventListener("change", async (e) => {
    data.settings.emptyHintDisabled = e.target.checked;
    await persistData();
    render();
  });

  elements.btnCloseFolder.addEventListener("click", closeFolder);

  elements.modalOverlay.addEventListener("click", (e) => {
    if (e.target === elements.modalOverlay) closeModal();
  });

  document.addEventListener("click", (e) => {
    if (!elements.contextMenu.contains(e.target)) closeContextMenu();
  });

  document.addEventListener("mousemove", (e) => {
    if (!elements.tooltip.classList.contains("hidden")) {
      elements.tooltip.style.left = `${e.clientX + 12}px`;
      elements.tooltip.style.top = `${e.clientY + 12}px`;
    }
  });

  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (!target) return;
    const text = target.getAttribute("data-tooltip");
    if (text) showTooltip(text, e.clientX, e.clientY);
  });

  document.addEventListener("mouseout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (!target) return;
    hideTooltip();
  });

  document.addEventListener("keydown", (e) => {
    if (!data.settings.keyboardNav) return;
    if (e.key === "Escape" && openFolderId) closeFolder();
    if (e.key === "/") {
      elements.topSearch.focus();
      e.preventDefault();
    }
  });

  elements.grid.addEventListener("dragover", (e) => e.preventDefault());
  elements.grid.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragState) return;
    if (activeGroupId === RECENT_GROUP_ID) return;
    const sourceId = dragState.id;
    if (openFolderId) return;
    const group = getActiveGroup();
    const index = getDropIndex(elements.grid, e.clientX, e.clientY);
    group.nodes = moveNodeInList(group.nodes, sourceId, index);
    persistData();
    render();
  });

  elements.folderGrid.addEventListener("dragover", (e) => e.preventDefault());
  elements.folderGrid.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!dragState || !openFolderId) return;
    const sourceId = dragState.id;
    const folder = data.nodes[openFolderId];
    const index = getDropIndex(elements.folderGrid, e.clientX, e.clientY);
    folder.children = moveNodeInList(folder.children || [], sourceId, index);
    persistData();
    render();
  });
}

init();
bindEvents();
