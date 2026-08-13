/**
 * 本程序书签树的只读遍历工具。
 * 分组是顶层书签文件夹，folder 节点可以继续嵌套 folder 节点。
 */

import { ALL_BOOKMARKS_GROUP_ID } from "./data-utils.js";

function byOrder(left, right) {
  return (
    Number(left?.order || 0) - Number(right?.order || 0) ||
    String(left?.id || "").localeCompare(String(right?.id || ""))
  );
}

function nodeLabel(node) {
  return String(node?.title || node?.url || "未命名").trim() || "未命名";
}

/**
 * 返回保留原始顺序的书签树，供弹窗等需要同时显示文件夹和书签的界面使用。
 * 只沿当前路径防循环，允许异常数据中的同一节点在不同引用位置继续显示。
 * @param {object} data
 * @returns {Array<{id:string, type:"group"|"folder"|"item", title:string, url?:string, path:string[], groupId:string, parentId:string, children:Array<object>}>}
 */
export function collectBookmarkTree(data) {
  const groups = [...(data?.groups || [])].filter((group) => group?.id).sort(byOrder);
  const allGroup = groups.find((group) => group.id === ALL_BOOKMARKS_GROUP_ID);
  const roots = allGroup ? [allGroup] : groups;

  const visit = (id, groupId, path, parentId, ancestors) => {
    if (!id) return null;
    const node = data?.nodes?.[id];
    if (!node || node.deletedAt || node.purgedAt || (node.type !== "folder" && node.type !== "item")) return null;
    const nodeId = String(node.id || id);
    if (ancestors.has(nodeId)) return null;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeId);
    const result = {
      id: nodeId,
      type: node.type,
      title: nodeLabel(node),
      path: node.type === "item" ? path : [...path, nodeLabel(node)],
      groupId,
      parentId,
      children: [],
    };
    if (node.type === "item") {
      result.url = String(node.url || "");
      return result;
    }
    const nextPath = result.path;
    for (const childId of Array.isArray(node.children) ? node.children : []) {
      const child = visit(childId, groupId, nextPath, nodeId, nextAncestors);
      if (child) result.children.push(child);
    }
    return result;
  };

  return roots.map((group) => {
    const groupName = nodeLabel({ title: group.name || "默认" });
    const root = {
      id: String(group.id),
      type: "group",
      title: groupName,
      path: [groupName],
      groupId: String(group.id),
      parentId: "",
      children: [],
    };
    const ancestors = new Set([root.id]);
    for (const nodeId of Array.isArray(group.nodes) ? group.nodes : []) {
      const child = visit(nodeId, root.groupId, root.path, root.id, ancestors);
      if (child) root.children.push(child);
    }
    return root;
  });
}

/**
 * 返回弹窗应显示的书签根节点。内部“全部”分组只用于存储，不能作为用户可见层级。
 *
 * @param {Array<object>} tree
 * @returns {Array<object>}
 */
export function getPopupBookmarkRoots(tree) {
  if (tree.length === 1 && tree[0].id === ALL_BOOKMARKS_GROUP_ID) return tree[0].children;
  return tree;
}

/**
 * 返回可作为“保存位置”的分组和嵌套文件夹。
 * @param {object} data
 * @returns {Array<{id:string, kind:"group"|"folder", name:string, depth:number, path:string[], groupId:string, parentId:string}>}
 */
export function collectBookmarkFolders(data) {
  const folders = [];
  const visited = new Set();
  const groups = [...(data?.groups || [])].filter((group) => group?.id).sort(byOrder);
  const allGroup = groups.find((group) => group.id === ALL_BOOKMARKS_GROUP_ID);

  const visit = (id, groupId, parentId, depth, path) => {
    if (!id || visited.has(`${groupId}:${id}`)) return;
    const node = data?.nodes?.[id];
    if (!node || node.deletedAt || node.purgedAt || node.type !== "folder") return;
    visited.add(`${groupId}:${id}`);
    const name = nodeLabel(node);
    const nextPath = [...path, name];
    folders.push({ id: node.id || id, kind: "folder", name, depth, path: nextPath, groupId, parentId: parentId || "" });
    for (const childId of Array.isArray(node.children) ? node.children : []) {
      visit(childId, groupId, node.id || id, depth + 1, nextPath);
    }
  };

  if (allGroup) {
    const allName = nodeLabel({ title: allGroup.name || "全部" });
    folders.push({
      id: allGroup.id,
      kind: "group",
      name: allName,
      depth: 0,
      path: [allName],
      groupId: allGroup.id,
      parentId: "",
    });
    for (const nodeId of Array.isArray(allGroup.nodes) ? allGroup.nodes : []) {
      visit(nodeId, allGroup.id, allGroup.id, 1, [allName]);
    }
    return folders;
  }

  for (const group of groups) {
    const groupName = nodeLabel({ title: group.name }) || "默认";
    folders.push({
      id: group.id,
      kind: "group",
      name: groupName,
      depth: 0,
      path: [groupName],
      groupId: group.id,
      parentId: "",
    });
    for (const nodeId of Array.isArray(group.nodes) ? group.nodes : []) {
      visit(nodeId, group.id, group.id, 1, [groupName]);
    }
  }
  return folders;
}

/**
 * 返回所有可见的普通书签，包含所在分组/文件夹路径。
 * @param {object} data
 * @returns {Array<{id:string, title:string, url:string, path:string[], groupId:string}>}
 */
export function collectBookmarkItems(data) {
  const items = new Map();
  const visited = new Set();
  const groups = [...(data?.groups || [])].filter((group) => group?.id).sort(byOrder);
  const allGroup = groups.find((group) => group.id === ALL_BOOKMARKS_GROUP_ID);

  const visit = (id, groupId, path) => {
    if (!id || visited.has(`${groupId}:${id}`)) return;
    const node = data?.nodes?.[id];
    if (!node || node.deletedAt || node.purgedAt) return;
    visited.add(`${groupId}:${id}`);
    if (node.type === "item") {
      if (!items.has(node.id || id)) {
        items.set(node.id || id, {
          id: node.id || id,
          title: nodeLabel(node),
          url: String(node.url || ""),
          path,
          groupId,
        });
      }
      return;
    }
    if (node.type !== "folder") return;
    const nextPath = [...path, nodeLabel(node)];
    for (const childId of Array.isArray(node.children) ? node.children : []) visit(childId, groupId, nextPath);
  };

  if (allGroup) {
    const allName = nodeLabel({ title: allGroup.name || "全部" });
    for (const nodeId of Array.isArray(allGroup.nodes) ? allGroup.nodes : []) {
      visit(nodeId, allGroup.id, [allName]);
    }
    return [...items.values()].sort(
      (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    );
  }

  for (const group of groups) {
    const groupName = nodeLabel({ title: group.name }) || "默认";
    for (const nodeId of Array.isArray(group.nodes) ? group.nodes : []) visit(nodeId, group.id, [groupName]);
  }
  return [...items.values()].sort(
    (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
  );
}
