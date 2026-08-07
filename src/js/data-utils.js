/**
 * 数据工具模块
 * 提供与 DOM 无关的纯函数，用于数据处理、去重、排序、指纹计算等。
 *
 * @typedef {import('./types.js').Group} Group
 * @typedef {import('./types.js').HomepageData} HomepageData
 * @typedef {import('./types.js').Node} Node
 * @typedef {import('./types.js').Settings} Settings
 */

import { SYNC_TOMBSTONE_TTL_MS } from "./sync_policy.js";

let _itemSeq = 0;
const cloneValue = (value) =>
  typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));

export const ALL_BOOKMARKS_GROUP_ID = "grp_all";
const LEGACY_GROUP_FOLDER_PREFIX = "fld_group_";

export function getLegacyGroupFolderId(groupId) {
  return `${LEGACY_GROUP_FOLDER_PREFIX}${String(groupId || "")}`;
}

export function isAllBookmarksGroup(groupOrId) {
  return String(typeof groupOrId === "object" ? groupOrId?.id || "" : groupOrId || "") === ALL_BOOKMARKS_GROUP_ID;
}

export function getRootFolderNodeIds(data) {
  const root = (data?.groups || []).find((group) => isAllBookmarksGroup(group));
  return (root?.nodes || []).filter((id) => data?.nodes?.[id]?.type === "folder");
}

function isLinkedGroupFolder(node) {
  return !!(
    node?.type === "folder" &&
    node.systemGroupFolder === true &&
    typeof node.linkedGroupId === "string" &&
    node.linkedGroupId
  );
}

function createRootModelMigrationBackup(data) {
  if (!(data?.groups || []).some((group) => !isAllBookmarksGroup(group))) return;
  const snapshotData = cloneValue(data);
  snapshotData.backups = [];
  if (!Array.isArray(data.backups)) data.backups = [];
  data.backups.unshift({ id: `bak_root_model_${Date.now()}`, ts: Date.now(), data: snapshotData });
}

/** 将旧版多分组/代理结构迁移为“全部”唯一根目录。 */
export function ensureAllBookmarksGroup(data, name = "全部") {
  if (!data || typeof data !== "object") return false;
  let changed = false;
  if (!Array.isArray(data.groups)) {
    data.groups = [];
    changed = true;
  }
  if (!data.nodes || typeof data.nodes !== "object" || Array.isArray(data.nodes)) {
    data.nodes = {};
    changed = true;
  }

  let allGroup = data.groups.find((group) => isAllBookmarksGroup(group));
  if (!allGroup) {
    allGroup = { id: ALL_BOOKMARKS_GROUP_ID, name, order: -1, nodes: [], systemAllGroup: true };
    data.groups.unshift(allGroup);
    changed = true;
  }
  if (!Array.isArray(allGroup.nodes)) {
    allGroup.nodes = [];
    changed = true;
  }
  if (allGroup.name !== name || allGroup.order !== -1 || allGroup.systemAllGroup !== true) {
    allGroup.name = name;
    allGroup.order = -1;
    allGroup.systemAllGroup = true;
    changed = true;
  }

  const ordinaryGroups = data.groups
    .filter((group) => group?.id && !isAllBookmarksGroup(group))
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  if (ordinaryGroups.length) createRootModelMigrationBackup(data);

  for (const group of ordinaryGroups) {
    let folderId = getLegacyGroupFolderId(group.id);
    let folder = data.nodes[folderId];
    if (folder && folder.type !== "folder") {
      folderId = `fld_root_${group.id}`;
      folder = data.nodes[folderId];
    }
    const useLegacyGroupMetadata = !folder || isLinkedGroupFolder(folder);
    if (folder?.type !== "folder") {
      folder = {
        id: folderId,
        type: "folder",
        title: String(group.name || "未命名"),
        children: [],
        createdAt: Number(group.createdAt || group.updatedAt || Date.now()),
        updatedAt: Number(group.updatedAt || Date.now()),
      };
      data.nodes[folderId] = folder;
    }
    if (useLegacyGroupMetadata) folder.title = String(group.name || folder.title || "未命名");
    folder.children = [
      ...new Set([
        ...(Array.isArray(folder.children) ? folder.children : []),
        ...(Array.isArray(group.nodes) ? group.nodes : []),
      ]),
    ];
    delete folder.linkedGroupId;
    delete folder.systemGroupFolder;
    if (!allGroup.nodes.includes(folderId)) allGroup.nodes.push(folderId);
    if (data.settings?.lastActiveGroupId === group.id) data.settings.lastActiveGroupId = folderId;
    if (data.settings?.defaultGroupId === group.id) data.settings.defaultGroupId = folderId;
    markGroupDeleted(data, group);
    changed = true;
  }

  for (const node of Object.values(data.nodes)) {
    if (!isLinkedGroupFolder(node)) continue;
    delete node.linkedGroupId;
    delete node.systemGroupFolder;
    if (!Array.isArray(node.children)) node.children = [];
    changed = true;
  }

  if (data.groups.length !== 1 || data.groups[0] !== allGroup) {
    data.groups = [allGroup];
    changed = true;
  }
  const seen = new Set();
  allGroup.nodes = allGroup.nodes.filter((id) => {
    if (!data.nodes[id] || seen.has(id)) {
      changed = true;
      return false;
    }
    seen.add(id);
    return true;
  });
  if (!data._syncMeta || typeof data._syncMeta !== "object") {
    data._syncMeta = {};
    changed = true;
  }
  if (data._syncMeta.rootModelVersion !== 1) {
    data._syncMeta.rootModelVersion = 1;
    changed = true;
  }
  return changed;
}

/**
 * 将已修复的导入数据合并到当前唯一根目录模型。
 * 同 ID 节点以本机为准；文件夹 children 与根节点引用只追加缺失项，不覆盖本机顺序和元数据。
 */
export function mergeRootBookmarkData(target, incoming) {
  if (!target || typeof target !== "object" || !incoming || typeof incoming !== "object") return false;
  ensureAllBookmarksGroup(target);
  ensureAllBookmarksGroup(incoming);
  const targetRoot = target.groups.find((group) => isAllBookmarksGroup(group));
  const incomingRoot = incoming.groups.find((group) => isAllBookmarksGroup(group));
  if (!targetRoot || !incomingRoot) return false;

  let changed = false;
  for (const [id, node] of Object.entries(incoming.nodes || {})) {
    if (target.nodes[id]) continue;
    target.nodes[id] = cloneValue(node);
    changed = true;
  }

  for (const [id, incomingNode] of Object.entries(incoming.nodes || {})) {
    const targetNode = target.nodes[id];
    if (targetNode?.type !== "folder" || incomingNode?.type !== "folder") continue;
    if (!Array.isArray(targetNode.children)) targetNode.children = [];
    const have = new Set(targetNode.children);
    for (const childId of incomingNode.children || []) {
      if (have.has(childId) || !target.nodes[childId]) continue;
      targetNode.children.push(childId);
      have.add(childId);
      changed = true;
    }
  }

  const rootIds = new Set(targetRoot.nodes);
  for (const id of incomingRoot.nodes || []) {
    if (rootIds.has(id) || !target.nodes[id]) continue;
    targetRoot.nodes.push(id);
    rootIds.add(id);
    changed = true;
  }
  return dedupeData(target) || changed;
}

/**
 * 创建普通卡片节点
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.title]
 * @param {string} [options.iconType]
 * @param {string} [options.iconData]
 * @param {string} [options.color]
 * @param {boolean} [options.titlePending]
 * @param {boolean} [options.iconPending]
 * @returns {import('./types.js').ItemNode}
 */
export function createItemNode({
  url,
  title = "",
  iconType = "auto",
  iconData = "",
  color = "",
  titlePending = false,
  iconPending = false,
} = {}) {
  const now = Date.now();
  return {
    id: `itm_${now}_${(_itemSeq++).toString(36)}`,
    type: "item",
    title,
    url,
    iconType,
    iconData,
    color,
    titlePending,
    iconPending,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 构建设置快照（备份指纹用）
 * @param {Settings | object} settings
 * @param {Set<string>} ignoredKeys
 * @returns {object}
 */
export function buildBackupSettingsSnapshot(settings, ignoredKeys) {
  const input = settings || {};
  const out = {};
  const keys = Object.keys(input).sort();
  for (const key of keys) {
    if (ignoredKeys?.has(key)) continue;
    out[key] = input[key];
  }
  return out;
}

/**
 * 构建数据指纹，用于判断数据是否发生变化
 * @param {HomepageData | object} source
 * @param {Set<string>} ignoredSettingsKeys
 * @returns {string}
 */
export function buildBackupFingerprint(source, ignoredSettingsKeys) {
  const input = source || {};
  const settings = buildBackupSettingsSnapshot(input.settings, ignoredSettingsKeys);
  const groups = (input.groups || [])
    .map((group) => ({
      id: String(group.id || ""),
      name: String(group.name || ""),
      order: Number(group.order) || 0,
      nodes: Array.isArray(group.nodes) ? group.nodes.map((id) => String(id)) : [],
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const nodes = Object.keys(input.nodes || {})
    .sort()
    .map((id) => {
      const node = input.nodes[id] || {};
      return {
        id,
        type: String(node.type || ""),
        title: String(node.title || ""),
        url: String(node.url || ""),
        iconType: String(node.iconType || ""),
        color: String(node.color || ""),
        children: Array.isArray(node.children) ? node.children.map((cid) => String(cid)) : [],
      };
    });
  return JSON.stringify({ settings, groups, nodes });
}

/**
 * 在列表中移动指定 ID 到目标位置，返回新列表（不修改原列表）
 * @param {string[]} list
 * @param {string} id
 * @param {number} index
 * @returns {string[]}
 */
export function moveNodeInList(list, id, index) {
  const currentIndex = list.indexOf(id);
  if (currentIndex < 0) return list;
  const safeIndex = Math.max(0, Math.min(index, list.length));
  let targetIndex = safeIndex;
  if (targetIndex > currentIndex) targetIndex -= 1;
  if (targetIndex === currentIndex) return list;
  const next = list.slice();
  next.splice(currentIndex, 1);
  next.splice(targetIndex, 0, id);
  return next;
}

/** 判断节点是否可以移动到指定文件夹，不修改输入数据。 */
export function canMoveNodeToFolder(input, nodeId, folderId) {
  const node = input?.nodes?.[nodeId];
  const target = input?.nodes?.[folderId];
  if (!node || target?.type !== "folder" || nodeId === folderId) return false;
  if (node.type === "folder" && collectNodeSubtreeIds(input, nodeId).includes(folderId)) return false;
  if (Array.isArray(target.children) && target.children.includes(nodeId)) return false;
  return true;
}

/**
 * 将节点移动到指定文件夹。节点先从所有旧父容器移除，因此不会产生复制或多父引用。
 * @returns {boolean} 是否完成移动
 */
export function moveNodeToFolder(input, nodeId, folderId) {
  if (!canMoveNodeToFolder(input, nodeId, folderId)) return false;
  const target = input.nodes[folderId];

  for (const group of input.groups || []) {
    if (Array.isArray(group.nodes)) group.nodes = group.nodes.filter((id) => id !== nodeId);
  }
  for (const candidate of Object.values(input.nodes || {})) {
    if (candidate?.type === "folder" && Array.isArray(candidate.children)) {
      candidate.children = candidate.children.filter((id) => id !== nodeId);
    }
  }
  if (!Array.isArray(target.children)) target.children = [];
  target.children.push(nodeId);
  return true;
}

/**
 * 收集从 roots 可达的全部节点 ID（含文件夹内子孙）。
 * @param {HomepageData | object} input
 * @param {Iterable<string>} roots
 * @returns {Set<string>}
 */
export function collectReachableNodeIds(input, roots) {
  const nodes = input?.nodes || {};
  const reachable = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (!id || reachable.has(id)) continue;
    if (!nodes[id]) continue;
    reachable.add(id);
    const node = nodes[id];
    if (node?.type === "folder" && Array.isArray(node.children)) {
      for (const childId of node.children) stack.push(childId);
    }
  }
  return reachable;
}

/**
 * 递归收集删除某个节点时需要一并删除的 ID（含自身与文件夹子孙）。
 * @param {HomepageData | object} input
 * @param {string} rootId
 * @returns {string[]}
 */
export function collectNodeSubtreeIds(input, rootId) {
  const nodes = input?.nodes || {};
  const result = [];
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id) || !nodes[id]) continue;
    seen.add(id);
    result.push(id);
    const node = nodes[id];
    if (node?.type === "folder" && Array.isArray(node.children)) {
      for (const childId of node.children) stack.push(childId);
    }
  }
  return result;
}

function ensureSyncMeta(data) {
  if (!data._syncMeta || typeof data._syncMeta !== "object") data._syncMeta = {};
  return data._syncMeta;
}

/** 将节点移到不可见墓碑层，避免删除后被远端旧数据复活。 */
export function markNodeDeleted(data, id, deletedAt = Date.now()) {
  const node = data?.nodes?.[id] || data?._syncMeta?.nodeTombstones?.[id];
  if (!node) return null;
  const meta = ensureSyncMeta(data);
  if (!meta.nodeTombstones || typeof meta.nodeTombstones !== "object") meta.nodeTombstones = {};
  const tombstone = { ...cloneValue(node), updatedAt: deletedAt, deletedAt };
  delete data.nodes[id];
  meta.nodeTombstones[id] = tombstone;
  return tombstone;
}

/** 将分组移到不可见墓碑层；界面仍只使用 data.groups 中的活动分组。 */
export function markGroupDeleted(data, group, deletedAt = Date.now()) {
  if (!group?.id) return null;
  const meta = ensureSyncMeta(data);
  const list = Array.isArray(meta.groupTombstones) ? meta.groupTombstones : [];
  const tombstone = { ...cloneValue(group), nodes: [], updatedAt: deletedAt, deletedAt };
  meta.groupTombstones = [...list.filter((item) => item?.id !== group.id), tombstone];
  return tombstone;
}

/** 清理超过保留期的墓碑，避免长期删除操作撑爆同步额度。 */
export function pruneSyncTombstones(data, now = Date.now()) {
  let changed = false;
  const cutoff = now - SYNC_TOMBSTONE_TTL_MS;
  const isExpired = (item) =>
    Number(item?.deletedAt || item?.purgedAt || 0) > 0 && Number(item.deletedAt || item.purgedAt) < cutoff;
  for (const [id, node] of Object.entries(data?.nodes || {})) {
    if ((node?.deletedAt || node?.purgedAt) && isExpired(node)) {
      delete data.nodes[id];
      changed = true;
    }
  }
  const meta = data?._syncMeta;
  if (meta?.nodeTombstones && typeof meta.nodeTombstones === "object") {
    for (const [id, node] of Object.entries(meta.nodeTombstones)) {
      if (isExpired(node)) {
        delete meta.nodeTombstones[id];
        changed = true;
      }
    }
  }
  if (Array.isArray(meta?.groupTombstones)) {
    const next = meta.groupTombstones.filter((group) => !isExpired(group));
    if (next.length !== meta.groupTombstones.length) {
      meta.groupTombstones = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * 数据去重与修复：
 * - 删除 groups 中引用了不存在的节点的 ID
 * - 删除 groups 中重复的节点 ID
 * - 删除 folders 中引用不存在或重复的子节点 ID
 * - 每个节点只保留一个父位置，并切断文件夹循环引用
 * - 删除没有任何分组/文件夹引用的孤儿节点
 * @param {HomepageData | object} input
 * @returns {boolean} 是否发生了变化
 */
export function dedupeData(input) {
  let changed = false;
  input.nodes = { ...(input.nodes || {}) };

  // 从根目录按显示顺序深度遍历。显式栈避免恶意或异常深层导入耗尽调用栈。
  const placed = new Set();
  const normalizeList = (list) => {
    let result = [];
    const stack = [
      {
        source: Array.isArray(list) ? list : [],
        index: 0,
        normalized: [],
        assign: (value) => {
          result = value;
        },
      },
    ];
    if (!Array.isArray(list)) changed = true;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.source.length) {
        frame.assign(frame.normalized);
        stack.pop();
        continue;
      }
      const id = frame.source[frame.index++];
      const node = input.nodes[id];
      if (!node || node.deletedAt || node.purgedAt || placed.has(id)) {
        changed = true;
        continue;
      }
      placed.add(id);
      frame.normalized.push(id);
      if (node.type !== "folder") continue;
      const original = node.children;
      if (!Array.isArray(original)) changed = true;
      stack.push({
        source: Array.isArray(original) ? original : [],
        index: 0,
        normalized: [],
        assign: (value) => {
          if (!Array.isArray(original) || value.length !== original.length) changed = true;
          node.children = value;
        },
      });
    }
    return result;
  };

  for (const group of input.groups || []) {
    const nodes = normalizeList(group.nodes);
    if (!Array.isArray(group.nodes) || nodes.length !== group.nodes.length) changed = true;
    group.nodes = nodes;
  }

  // 孤儿 GC：只保留从任意 group.nodes 可达的节点
  const roots = [];
  for (const group of input.groups || []) {
    for (const id of group.nodes || []) roots.push(id);
  }
  const reachable = collectReachableNodeIds(input, roots);
  for (const id of Object.keys(input.nodes)) {
    // 删除墓碑虽然不再挂在任何分组下，也必须保留到同步完成，不能被孤儿 GC 提前抹掉。
    if (!reachable.has(id) && !input.nodes[id]?.deletedAt && !input.nodes[id]?.purgedAt) {
      delete input.nodes[id];
      changed = true;
    }
  }

  return changed;
}

/**
 * 数据快照深拷贝
 * @param {HomepageData | object} source
 * @returns {HomepageData | object}
 */
export function cloneDataSnapshot(source) {
  return cloneValue(source || {});
}

/**
 * 选择最新的数据（按 lastUpdated 比较）
 * @param {object | null} localData
 * @param {object | null} syncData
 * @returns {object | null}
 */
export function pickLatestData(localData, syncData) {
  if (!syncData) return localData || null;
  if (!localData) return syncData || null;
  const localTs = Number(localData.lastUpdated || 0);
  const syncTs = Number(syncData.lastUpdated || 0);
  return syncTs >= localTs ? syncData : localData;
}

/**
 * 运行时 schema 校验与修复：导入 / 同步 / 恢复入口共用。
 *
 * 之前三个入口几乎不做结构校验，损坏数据（带合法 schemaVersion）会原样进入运行态。
 * 这里在不破坏现有数据的前提下做防御性归一化：
 * - 确保 schema/groups/nodes/backups/settings 是期望类型
 * - 丢弃不是对象的 node；node 必须有 type（item/folder）
 * - groups 必须是数组且元素有 id；过滤不存在节点的 node 引用
 * - 合并 DEFAULT_SETTINGS（与 loadData 一致），避免缺字段导致渲染崩溃
 * - 不抛错：任何不合法字段静默修复，保证入口可用
 *
 * @param {object} input - 待校验数据（可能来自导入/同步/恢复）
 * @param {object} defaultSettings - 默认 settings 模板（由调用方传入，避免循环依赖 storage.js）
 * @returns {object} 校验后的数据
 */
export function repairHomepageData(input, defaultSettings = {}) {
  const data = input && typeof input === "object" ? input : {};
  if (typeof data.schemaVersion !== "number" || !Number.isFinite(data.schemaVersion)) {
    data.schemaVersion = 1;
  }
  if (!Array.isArray(data.groups)) data.groups = [];
  if (!data.nodes || typeof data.nodes !== "object" || Array.isArray(data.nodes)) {
    data.nodes = {};
  }
  if (!Array.isArray(data.backups)) data.backups = [];
  if (!data.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) {
    data.settings = { ...defaultSettings };
  } else {
    data.settings = { ...defaultSettings, ...data.settings };
  }

  // 清理非法 node：必须是非空对象且有 type 字段；文件夹需 children 为数组
  const validNodeIds = new Set();
  for (const [id, node] of Object.entries(data.nodes)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      delete data.nodes[id];
      continue;
    }
    if (typeof node.type !== "string" || !node.type) {
      delete data.nodes[id];
      continue;
    }
    if (node.type === "folder") {
      node.children = Array.isArray(node.children) ? node.children : [];
    }
    validNodeIds.add(id);
  }

  // 清理 groups：元素必须有 id；nodes 引用指向存在的节点
  const seenGroupIds = new Set();
  const validGroups = [];
  for (const group of data.groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const id =
      typeof group.id === "string" && group.id
        ? group.id
        : `grp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (seenGroupIds.has(id)) continue;
    seenGroupIds.add(id);
    const nodes = Array.isArray(group.nodes) ? group.nodes.filter((nid) => validNodeIds.has(nid)) : [];
    validGroups.push({ ...group, id, nodes });
  }
  data.groups = validGroups;

  ensureAllBookmarksGroup(data);

  if (typeof data.lastUpdated !== "number" || !Number.isFinite(data.lastUpdated)) {
    data.lastUpdated = Number(data.lastUpdated) || 0;
  }

  // 设置字段防御：搜索引擎 URL / 纯色背景等来自导入时可能带脏值
  if (data.settings) {
    const engine = String(data.settings.searchEngineUrl || "").trim();
    if (engine) {
      try {
        const u = new URL(engine);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          data.settings.searchEngineUrl = defaultSettings.searchEngineUrl || "https://www.bing.com/search?q=";
        }
      } catch (_e) {
        data.settings.searchEngineUrl = defaultSettings.searchEngineUrl || "https://www.bing.com/search?q=";
      }
    }
    const color = String(data.settings.backgroundColor || "").trim();
    if (color && !isSafeCssColor(color)) {
      data.settings.backgroundColor = defaultSettings.backgroundColor || "#0b0f14";
    }
    // 上传图标只允许 data:image/*
    for (const node of Object.values(data.nodes || {})) {
      if (node?.iconType === "upload" && node.iconData && !String(node.iconData).startsWith("data:image/")) {
        node.iconData = "";
        node.iconType = "auto";
      }
    }
  }

  return data;
}

/**
 * 允许的 CSS 颜色：hex / rgb(a) / 纯字母命名色
 * @param {string} input
 * @returns {boolean}
 */
export function isSafeCssColor(input) {
  const raw = String(input || "").trim();
  if (!raw) return false;
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) return true;
  if (/^rgba?\(\s*[\d.]+(?:\s*,\s*[\d.%]+){2,3}\s*\)$/.test(raw)) return true;
  if (/^[a-zA-Z]{1,30}$/.test(raw)) return true;
  return false;
}
