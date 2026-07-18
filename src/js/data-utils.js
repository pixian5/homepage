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
 * 数据去重与修复：
 * - 删除 groups 中引用了不存在的节点的 ID
 * - 删除 groups 中重复的节点 ID
 * - 删除 folders 中引用不存在或重复的子节点 ID
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
