/**
 * 多设备状态合并（纯函数）
 * 吸收 Pass：字段时钟、空值不覆盖、墓碑、ID 保全、空远端拒绝
 */

import { dedupeData } from "./data-utils.js";
import { deepClone } from "./storage.js";
import { syncDocumentToHomepageShape, toSyncDocument } from "./sync_projection.js";

function mergeAsNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mergeAsStr(v) {
  return String(v ?? "");
}

/**
 * 字段级裁决（Pass newerField 精简版）
 * @returns {{ value: string, at: number, by: string }}
 */
export function newerField(lhsValue, lhsAt, lhsBy, rhsValue, rhsAt, rhsBy) {
  const leftAt = mergeAsNum(lhsAt);
  const rightAt = mergeAsNum(rhsAt);
  const leftValue = mergeAsStr(lhsValue);
  const rightValue = mergeAsStr(rhsValue);
  const leftBy = mergeAsStr(lhsBy);
  const rightBy = mergeAsStr(rhsBy);

  if (leftAt > rightAt) return { value: leftValue, at: leftAt, by: leftBy };
  if (rightAt > leftAt) return { value: rightValue, at: rightAt, by: rightBy };

  // 时钟相同：空不覆盖有值
  if (!leftValue && rightValue) return { value: rightValue, at: rightAt, by: rightBy };
  if (leftValue && !rightValue) return { value: leftValue, at: leftAt, by: leftBy };
  if (leftValue === rightValue) {
    return { value: leftValue, at: leftAt, by: leftBy || rightBy };
  }

  // deviceId 字典序，大者胜（确定性）
  if (leftBy !== rightBy) {
    return leftBy > rightBy
      ? { value: leftValue, at: leftAt, by: leftBy }
      : { value: rightValue, at: rightAt, by: rightBy };
  }
  return leftValue.localeCompare(rightValue) >= 0
    ? { value: leftValue, at: leftAt, by: leftBy }
    : { value: rightValue, at: rightAt, by: rightBy };
}

function entityClock(entity) {
  return mergeAsNum(entity?.updatedAt || entity?.deletedAt || entity?.purgedAt || 0);
}

/**
 * 合并两个节点（含 tombstone）
 */
export function mergeNode(left, right) {
  if (!left) return deepClone(right);
  if (!right) return deepClone(left);

  const lPurge = mergeAsNum(left.purgedAt);
  const rPurge = mergeAsNum(right.purgedAt);
  if (lPurge || rPurge) {
    const win = lPurge >= rPurge ? left : right;
    return { ...deepClone(win), purgedAt: Math.max(lPurge, rPurge) || win.purgedAt };
  }

  const lDel = mergeAsNum(left.deletedAt);
  const rDel = mergeAsNum(right.deletedAt);
  const lUp = entityClock(left);
  const rUp = entityClock(right);

  // 删除 vs 更新：时钟大者胜
  if (lDel && !rDel) {
    if (lDel >= rUp) return { ...deepClone(left), deletedAt: lDel };
    // 右侧更新更晚 → 复活为 right
  }
  if (rDel && !lDel) {
    if (rDel >= lUp) return { ...deepClone(right), deletedAt: rDel };
  }
  if (lDel && rDel) {
    return lDel >= rDel ? deepClone(left) : deepClone(right);
  }

  // 双侧存活：字段合并
  const title = newerField(
    left.title,
    left.titleUpdatedAt || left.updatedAt,
    left.updatedBy,
    right.title,
    right.titleUpdatedAt || right.updatedAt,
    right.updatedBy,
  );
  const base = lUp >= rUp ? deepClone(left) : deepClone(right);
  base.title = title.value;
  base.titleUpdatedAt = title.at;
  base.updatedBy = title.by || base.updatedBy;

  if (base.type !== "folder") {
    const url = newerField(
      left.url,
      left.urlUpdatedAt || left.updatedAt,
      left.updatedBy,
      right.url,
      right.urlUpdatedAt || right.updatedAt,
      right.updatedBy,
    );
    base.url = url.value;
    base.urlUpdatedAt = url.at;
  }

  // icon 元数据随实体时钟较新侧
  if (lUp >= rUp) {
    base.iconType = left.iconType || base.iconType;
    base.iconData = left.iconData || "";
    base.color = left.color || base.color;
  } else {
    base.iconType = right.iconType || base.iconType;
    base.iconData = right.iconData || "";
    base.color = right.color || base.color;
  }

  base.updatedAt = Math.max(lUp, rUp);
  if (base.type === "folder") {
    // children 由 placements 重建，这里先置空
    base.children = [];
  }
  delete base.deletedAt;
  return base;
}

export function mergeGroup(left, right) {
  if (!left) return deepClone(right);
  if (!right) return deepClone(left);

  const lPurge = mergeAsNum(left.purgedAt);
  const rPurge = mergeAsNum(right.purgedAt);
  if (lPurge || rPurge) {
    const win = lPurge >= rPurge ? left : right;
    return { ...deepClone(win), nodes: [], purgedAt: Math.max(lPurge, rPurge) || win.purgedAt };
  }

  const lDel = mergeAsNum(left.deletedAt);
  const rDel = mergeAsNum(right.deletedAt);
  const lUp = entityClock(left);
  const rUp = entityClock(right);

  if (lDel && !rDel && lDel >= rUp) return { ...deepClone(left), nodes: [] };
  if (rDel && !lDel && rDel >= lUp) return { ...deepClone(right), nodes: [] };
  if (lDel && rDel) return lDel >= rDel ? deepClone(left) : deepClone(right);

  const name = newerField(
    left.name,
    left.nameUpdatedAt || left.updatedAt,
    left.updatedBy,
    right.name,
    right.nameUpdatedAt || right.updatedAt,
    right.updatedBy,
  );
  const orderLeft = {
    value: String(mergeAsNum(left.order)),
    at: mergeAsNum(left.orderUpdatedAt || left.updatedAt),
    by: mergeAsStr(left.updatedBy),
  };
  const orderRight = {
    value: String(mergeAsNum(right.order)),
    at: mergeAsNum(right.orderUpdatedAt || right.updatedAt),
    by: mergeAsStr(right.updatedBy),
  };
  const order = newerField(orderLeft.value, orderLeft.at, orderLeft.by, orderRight.value, orderRight.at, orderRight.by);

  return {
    id: left.id || right.id,
    name: name.value,
    order: mergeAsNum(order.value, 0),
    nodes: [],
    updatedAt: Math.max(lUp, rUp),
    updatedBy: name.by || order.by,
    nameUpdatedAt: name.at,
    orderUpdatedAt: order.at,
  };
}

/**
 * placement key
 */
function placementKey(p) {
  return `${p.parentKind}:${p.parentId}:${p.nodeId}`;
}

export function mergePlacements(leftList, rightList) {
  const map = new Map();
  const consider = (p) => {
    if (!p?.nodeId || !p?.parentId) return;
    const key = placementKey(p);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...p });
      return;
    }
    const cAt = mergeAsNum(cur.deletedAt || cur.updatedAt);
    const pAt = mergeAsNum(p.deletedAt || p.updatedAt);
    if (pAt > cAt) map.set(key, { ...p });
    else if (pAt === cAt) {
      // 删除优先于同秒存活；否则 deviceId
      if (p.deletedAt && !cur.deletedAt) map.set(key, { ...p });
      else if (!p.deletedAt && cur.deletedAt) return;
      else if (mergeAsStr(p.updatedBy) > mergeAsStr(cur.updatedBy)) map.set(key, { ...p });
    }
  };
  for (const p of leftList || []) consider(p);
  for (const p of rightList || []) consider(p);
  return [...map.values()];
}

function collectActiveIds(data) {
  const ids = new Set();
  for (const g of data?.groups || []) {
    if (g?.id && !g.deletedAt && !g.purgedAt) ids.add(`g:${g.id}`);
  }
  for (const [id, n] of Object.entries(data?.nodes || {})) {
    if (n && !n.deletedAt && !n.purgedAt) ids.add(`n:${id}`);
  }
  return ids;
}

/**
 * 主合并入口
 * @param {object} localData HomepageData
 * @param {object|null} remoteDoc SyncDocument
 * @param {{ deviceId: string, now?: number }} ctx
 */
export function mergeHomepage(localData, remoteDoc, ctx = {}) {
  const deviceId = mergeAsStr(ctx.deviceId || "dev_unknown");
  const now = mergeAsNum(ctx.now, Date.now());

  if (!remoteDoc || typeof remoteDoc !== "object") {
    return { ok: true, state: deepClone(localData), stats: { reason: "no_remote", applied: false } };
  }

  const remoteShape = syncDocumentToHomepageShape(remoteDoc);
  const remoteEmpty = (remoteShape.groups?.length || 0) === 0 && Object.keys(remoteShape.nodes || {}).length === 0;

  if (remoteEmpty) {
    const localHas = (localData?.groups?.length || 0) > 0 || Object.keys(localData?.nodes || {}).length > 0;
    if (localHas) {
      return {
        ok: false,
        reason: "empty_remote",
        state: deepClone(localData),
        stats: { applied: false },
      };
    }
    return { ok: true, state: deepClone(localData), stats: { reason: "both_empty", applied: false } };
  }

  // 投影 local 以便取 placements / tombstones 一致结构
  const localDoc = toSyncDocument(localData, {
    deviceId,
    docId: remoteDoc.docId || "doc_local",
    revision: 0,
    writtenAt: mergeAsNum(localData?.lastUpdated, now),
  });
  const localShape = syncDocumentToHomepageShape(localDoc);

  // 合并 nodes（含 tombstone 侧影）
  const nodeIds = new Set([
    ...Object.keys(localShape.nodes || {}),
    ...Object.keys(localShape._tombstoneNodes || {}),
    ...Object.keys(remoteShape.nodes || {}),
    ...Object.keys(remoteShape._tombstoneNodes || {}),
  ]);

  const mergedNodes = {};
  for (const id of nodeIds) {
    const l = localShape.nodes?.[id] || localShape._tombstoneNodes?.[id];
    const r = remoteShape.nodes?.[id] || remoteShape._tombstoneNodes?.[id];
    const m = mergeNode(l, r);
    if (m) mergedNodes[id] = m;
  }

  // 合并 groups
  const groupById = new Map();
  for (const g of [...(localShape.groups || []), ...(localShape._tombstoneGroups || [])]) {
    groupById.set(g.id, g);
  }
  for (const g of [...(remoteShape.groups || []), ...(remoteShape._tombstoneGroups || [])]) {
    const cur = groupById.get(g.id);
    groupById.set(g.id, cur ? mergeGroup(cur, g) : deepClone(g));
  }

  const placements = mergePlacements(localShape._allPlacements, remoteShape._allPlacements);

  // 物化 parent 列表
  for (const n of Object.values(mergedNodes)) {
    if (n.type === "folder") n.children = [];
  }
  const activeGroups = [];
  for (const g of groupById.values()) {
    if (g.deletedAt || g.purgedAt) continue;
    g.nodes = [];
    activeGroups.push(g);
  }
  const gmap = new Map(activeGroups.map((g) => [g.id, g]));

  const placeSorted = placements.filter((p) => !p.deletedAt).sort((a, b) => mergeAsNum(a.index) - mergeAsNum(b.index));

  for (const p of placeSorted) {
    const node = mergedNodes[p.nodeId];
    if (!node || node.deletedAt || node.purgedAt) continue;
    if (p.parentKind === "group") {
      const g = gmap.get(p.parentId);
      if (!g) continue;
      if (!g.nodes.includes(p.nodeId)) g.nodes.push(p.nodeId);
    } else if (p.parentKind === "folder") {
      const folder = mergedNodes[p.parentId];
      if (folder?.type !== "folder" || folder.deletedAt || folder.purgedAt) continue;
      if (!folder.children.includes(p.nodeId)) folder.children.push(p.nodeId);
    }
  }

  // settings：白名单已在投影中；简单 key 级 LWW 用 remote.writtenAt vs local.lastUpdated
  const localSettings = { ...(localData?.settings || {}) };
  const remoteSettings = { ...(remoteShape.settings || {}) };
  const remoteWritten = mergeAsNum(remoteDoc.writtenAt);
  const localWritten = mergeAsNum(localData?.lastUpdated);
  const mergedSettings = { ...localSettings };
  for (const [k, v] of Object.entries(remoteSettings)) {
    if (remoteWritten >= localWritten) mergedSettings[k] = v;
    else if (mergedSettings[k] === undefined) mergedSettings[k] = v;
  }
  // syncEnabled 以本地开关为准（避免远端关同步锁死）
  if (Object.hasOwn(localSettings, "syncEnabled")) {
    mergedSettings.syncEnabled = localSettings.syncEnabled;
  }

  const visibleNodes = {};
  for (const [id, n] of Object.entries(mergedNodes)) {
    if (!n.deletedAt && !n.purgedAt) visibleNodes[id] = n;
  }

  const state = {
    schemaVersion: 1,
    settings: mergedSettings,
    groups: activeGroups.sort((a, b) => mergeAsNum(a.order) - mergeAsNum(b.order)),
    nodes: visibleNodes,
    backups: Array.isArray(localData?.backups) ? deepClone(localData.backups) : [],
    lastUpdated: Math.max(localWritten, remoteWritten, now),
  };

  // 安全闸门：本地未删除的活跃 id 必须仍在
  const beforeIds = collectActiveIds(localData);
  dedupeData(state);
  const afterIds = collectActiveIds(state);
  const missing = [];
  for (const id of beforeIds) {
    if (!afterIds.has(id)) {
      // 若 merge 结果中带 tombstone 且时钟证明删除，允许缺失
      const rawId = id.slice(2);
      const n = mergedNodes[rawId];
      const g = groupById.get(rawId);
      if (id.startsWith("n:") && n && (n.deletedAt || n.purgedAt)) continue;
      if (id.startsWith("g:") && g && (g.deletedAt || g.purgedAt)) continue;
      missing.push(id);
    }
  }
  if (missing.length) {
    return {
      ok: false,
      reason: "missing_local_ids",
      state: deepClone(localData),
      stats: { missing, applied: false },
    };
  }

  return {
    ok: true,
    state,
    stats: {
      applied: true,
      groups: state.groups.length,
      nodes: Object.keys(state.nodes).length,
      remoteRevision: mergeAsNum(remoteDoc.revision),
      docId: remoteDoc.docId,
    },
  };
}
