/**
 * HomepageData ↔ SyncDocument 投影
 */

import { estimateBytes } from "./shared-utils.js";
import {
  SYNC_DOC_SCHEMA,
  SYNC_ICON_DATA_MAX_CHARS,
  SYNC_SETTINGS_WHITELIST,
  SYNC_TITLE_MAX_CHARS,
} from "./sync_policy.js";

function projAsNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function projAsStr(v) {
  return String(v ?? "");
}

function truncateTitle(title) {
  const t = projAsStr(title);
  if (t.length <= SYNC_TITLE_MAX_CHARS) return t;
  return t.slice(0, SYNC_TITLE_MAX_CHARS);
}

function projectIcon(node) {
  const iconType = projAsStr(node.iconType || "auto");
  const iconData = projAsStr(node.iconData || "");
  const color = projAsStr(node.color || "");

  // 大图上传不进同步：降级为 auto，他机本地重抓
  if (iconType === "upload") {
    return { iconType: "auto", iconData: "", color };
  }
  if (iconType === "remote") {
    if (!iconData || iconData.length > SYNC_ICON_DATA_MAX_CHARS || iconData.startsWith("data:")) {
      return { iconType: "auto", iconData: "", color };
    }
    return { iconType: "remote", iconData, color };
  }
  if (iconType === "color") {
    return { iconType: "color", iconData: "", color: color || "#4dd6a8" };
  }
  if (iconType === "letter") {
    return { iconType: "letter", iconData: "", color };
  }
  return { iconType: "auto", iconData: "", color };
}

/**
 * @param {object} data HomepageData
 * @param {{ deviceId: string, docId: string, revision?: number, writtenAt?: number }} ctx
 * @returns {object} SyncDocument
 */
export function toSyncDocument(data, ctx) {
  const now = projAsNum(ctx.writtenAt, Date.now());
  const deviceId = projAsStr(ctx.deviceId);
  const docId = projAsStr(ctx.docId);
  const revision = projAsNum(ctx.revision, 1);

  const settingsIn = data?.settings && typeof data.settings === "object" ? data.settings : {};
  const settings = {};
  for (const key of SYNC_SETTINGS_WHITELIST) {
    if (Object.hasOwn(settingsIn, key)) {
      settings[key] = settingsIn[key];
    }
  }
  // 自定义大图永不进投影
  if (settings.backgroundType === "custom") {
    settings.backgroundCustom = "";
  }

  const groups = [];
  for (const g of data?.groups || []) {
    if (!g?.id) continue;
    if (g.deletedAt || g.purgedAt) {
      groups.push({
        id: projAsStr(g.id),
        name: truncateTitle(g.name || ""),
        order: projAsNum(g.order, 0),
        updatedAt: projAsNum(g.updatedAt, now),
        updatedBy: projAsStr(g.updatedBy || deviceId),
        deletedAt: g.deletedAt ? projAsNum(g.deletedAt) : undefined,
        purgedAt: g.purgedAt ? projAsNum(g.purgedAt) : undefined,
      });
      continue;
    }
    groups.push({
      id: projAsStr(g.id),
      name: truncateTitle(g.name || ""),
      order: projAsNum(g.order, 0),
      updatedAt: projAsNum(g.updatedAt, projAsNum(data?.lastUpdated, now)),
      updatedBy: projAsStr(g.updatedBy || deviceId),
    });
  }

  const nodes = [];
  const placements = [];

  for (const [id, node] of Object.entries(data?.nodes || {})) {
    if (!node || typeof node !== "object") continue;
    const nid = projAsStr(id);
    const updatedAt = projAsNum(node.updatedAt, projAsNum(data?.lastUpdated, now));
    const updatedBy = projAsStr(node.updatedBy || deviceId);
    const icon = projectIcon(node);

    if (node.purgedAt || node.deletedAt) {
      nodes.push({
        id: nid,
        type: node.type === "folder" ? "folder" : "item",
        title: truncateTitle(node.title || ""),
        url: node.type === "folder" ? undefined : projAsStr(node.url || ""),
        ...icon,
        updatedAt,
        updatedBy,
        deletedAt: node.deletedAt ? projAsNum(node.deletedAt) : undefined,
        purgedAt: node.purgedAt ? projAsNum(node.purgedAt) : undefined,
      });
      continue;
    }

    if (node.type === "folder") {
      nodes.push({
        id: nid,
        type: "folder",
        title: truncateTitle(node.title || ""),
        ...icon,
        updatedAt,
        updatedBy,
      });
    } else {
      nodes.push({
        id: nid,
        type: "item",
        title: truncateTitle(node.title || ""),
        url: projAsStr(node.url || ""),
        ...icon,
        updatedAt,
        updatedBy,
        titleUpdatedAt: node.titleUpdatedAt ? projAsNum(node.titleUpdatedAt) : undefined,
        urlUpdatedAt: node.urlUpdatedAt ? projAsNum(node.urlUpdatedAt) : undefined,
      });
    }
  }

  // placements：从 group.nodes / folder.children 物化
  for (const g of data?.groups || []) {
    if (!g?.id || g.deletedAt || g.purgedAt) continue;
    const list = Array.isArray(g.nodes) ? g.nodes : [];
    list.forEach((nodeId, index) => {
      if (!nodeId || !data.nodes?.[nodeId]) return;
      if (data.nodes[nodeId].deletedAt || data.nodes[nodeId].purgedAt) return;
      placements.push({
        nodeId: projAsStr(nodeId),
        parentKind: "group",
        parentId: projAsStr(g.id),
        index,
        updatedAt: projAsNum(g.updatedAt, projAsNum(data?.lastUpdated, now)),
        updatedBy: projAsStr(g.updatedBy || deviceId),
      });
    });
  }

  for (const [id, node] of Object.entries(data?.nodes || {})) {
    if (node?.type !== "folder" || node.deletedAt || node.purgedAt) continue;
    const list = Array.isArray(node.children) ? node.children : [];
    list.forEach((childId, index) => {
      if (!childId || !data.nodes?.[childId]) return;
      if (data.nodes[childId].deletedAt || data.nodes[childId].purgedAt) return;
      placements.push({
        nodeId: projAsStr(childId),
        parentKind: "folder",
        parentId: projAsStr(id),
        index,
        updatedAt: projAsNum(node.updatedAt, projAsNum(data?.lastUpdated, now)),
        updatedBy: projAsStr(node.updatedBy || deviceId),
      });
    });
  }

  const doc = {
    schema: SYNC_DOC_SCHEMA,
    schemaVersion: 1,
    docId,
    revision,
    deviceId,
    writtenAt: now,
    contentHash: "",
    settings,
    groups,
    nodes,
    placements,
  };
  doc.contentHash = hashSyncDocument(doc);
  return doc;
}

/**
 * 稳定 hash（非加密，用于完整性校验）
 * @param {object} doc
 * @returns {string}
 */
export function hashSyncDocument(doc) {
  const clone = { ...doc, contentHash: "" };
  const str = JSON.stringify(clone);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 估算投影字节
 * @param {object} data
 * @param {{ deviceId?: string, docId?: string }} [ctx]
 * @returns {number}
 */
export function estimateSyncProjectionBytes(data, ctx = {}) {
  const doc = toSyncDocument(data, {
    deviceId: ctx.deviceId || "dev_estimate",
    docId: ctx.docId || "doc_estimate",
    revision: 1,
    writtenAt: Date.now(),
  });
  return estimateBytes(doc);
}

/**
 * SyncDocument → 可合并的稀疏 HomepageData 形态（含 tombstone 节点）
 * @param {object} doc
 * @returns {object}
 */
export function syncDocumentToHomepageShape(doc) {
  const nodes = {};
  for (const n of doc?.nodes || []) {
    if (!n?.id) continue;
    if (n.type === "folder") {
      nodes[n.id] = {
        id: n.id,
        type: "folder",
        title: n.title || "",
        children: [],
        iconType: n.iconType || "auto",
        iconData: n.iconData || "",
        color: n.color || "",
        updatedAt: projAsNum(n.updatedAt),
        updatedBy: projAsStr(n.updatedBy),
        deletedAt: n.deletedAt,
        purgedAt: n.purgedAt,
        createdAt: projAsNum(n.updatedAt),
      };
    } else {
      nodes[n.id] = {
        id: n.id,
        type: "item",
        title: n.title || "",
        url: n.url || "",
        iconType: n.iconType || "auto",
        iconData: n.iconData || "",
        color: n.color || "",
        updatedAt: projAsNum(n.updatedAt),
        updatedBy: projAsStr(n.updatedBy),
        deletedAt: n.deletedAt,
        purgedAt: n.purgedAt,
        titleUpdatedAt: n.titleUpdatedAt,
        urlUpdatedAt: n.urlUpdatedAt,
        createdAt: projAsNum(n.updatedAt),
      };
    }
  }

  // 先建 group 壳
  const groups = (doc?.groups || [])
    .filter((g) => g?.id)
    .map((g) => ({
      id: g.id,
      name: g.name || "",
      order: projAsNum(g.order, 0),
      nodes: [],
      updatedAt: projAsNum(g.updatedAt),
      updatedBy: projAsStr(g.updatedBy),
      deletedAt: g.deletedAt,
      purgedAt: g.purgedAt,
    }));

  const groupMap = new Map(groups.map((g) => [g.id, g]));

  // placements 填 children / group.nodes
  const sorted = [...(doc?.placements || [])].sort((a, b) => projAsNum(a.index) - projAsNum(b.index));
  for (const p of sorted) {
    if (!p?.nodeId || p.deletedAt) continue;
    if (!nodes[p.nodeId] || nodes[p.nodeId].deletedAt || nodes[p.nodeId].purgedAt) continue;
    if (p.parentKind === "group") {
      const g = groupMap.get(p.parentId);
      if (!g || g.deletedAt || g.purgedAt) continue;
      if (!g.nodes.includes(p.nodeId)) g.nodes.push(p.nodeId);
    } else if (p.parentKind === "folder") {
      const folder = nodes[p.parentId];
      if (folder?.type !== "folder" || folder.deletedAt || folder.purgedAt) continue;
      if (!folder.children.includes(p.nodeId)) folder.children.push(p.nodeId);
    }
  }

  return {
    schemaVersion: 1,
    settings: { ...(doc?.settings || {}) },
    groups: groups.filter((g) => !g.deletedAt && !g.purgedAt),
    nodes: Object.fromEntries(Object.entries(nodes).filter(([, n]) => !n.deletedAt && !n.purgedAt)),
    // 保留 tombstone 供 merge 使用
    _tombstoneNodes: Object.fromEntries(Object.entries(nodes).filter(([, n]) => n.deletedAt || n.purgedAt)),
    _tombstoneGroups: groups.filter((g) => g.deletedAt || g.purgedAt),
    _allPlacements: doc?.placements || [],
    backups: [],
    lastUpdated: projAsNum(doc?.writtenAt, Date.now()),
    _syncMeta: {
      docId: doc?.docId,
      revision: projAsNum(doc?.revision),
      contentHash: doc?.contentHash,
    },
  };
}
