/**
 * 数据工具模块
 * 提供与 DOM 无关的纯函数，用于数据处理、去重、排序、指纹计算等。
 *
 * @typedef {import('./types.js').Group} Group
 * @typedef {import('./types.js').HomepageData} HomepageData
 * @typedef {import('./types.js').Node} Node
 * @typedef {import('./types.js').Settings} Settings
 */

import { deepClone } from "./storage.js";

let _itemSeq = 0;

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

/**
 * 数据去重与修复：
 * - 删除 groups 中引用了不存在的节点的 ID
 * - 删除 groups 中重复的节点 ID
 * - 删除 folders 中引用不存在或重复的子节点 ID
 * - 删除没有任何分组/文件夹引用的孤儿节点
 * @param {HomepageData | object} input
 * @returns {boolean} 是否发生了变化
 */
export function dedupeData(input) {
  let changed = false;
  input.nodes = { ...(input.nodes || {}) };

  for (const group of input.groups || []) {
    const uniq = [];
    const set = new Set();
    for (const id of group.nodes || []) {
      if (!input.nodes[id]) {
        changed = true;
        continue;
      }
      if (set.has(id)) {
        changed = true;
        continue;
      }
      set.add(id);
      uniq.push(id);
    }
    group.nodes = uniq;
  }

  for (const node of Object.values(input.nodes)) {
    if (node.type === "folder" && Array.isArray(node.children)) {
      const uniq = [];
      const set = new Set();
      for (const id of node.children) {
        if (!input.nodes[id]) {
          changed = true;
          continue;
        }
        if (set.has(id)) {
          changed = true;
          continue;
        }
        set.add(id);
        uniq.push(id);
      }
      node.children = uniq;
    }
  }

  // 孤儿 GC：只保留从任意 group.nodes 可达的节点
  const roots = [];
  for (const group of input.groups || []) {
    for (const id of group.nodes || []) roots.push(id);
  }
  const reachable = collectReachableNodeIds(input, roots);
  for (const id of Object.keys(input.nodes)) {
    if (!reachable.has(id)) {
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
  return deepClone(source || {});
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
