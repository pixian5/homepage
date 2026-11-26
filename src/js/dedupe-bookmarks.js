/**
 * 重复书签检测与安全合并工具。
 *
 * 职责：
 * - 将 URL 标准化为等价规范键（忽略域名大小写、默认端口与纯根路径斜杠差异）；
 * - 在保持同步删除语义（markNodeDeleted 墓碑）的前提下选出最优保留项并合并标题/图标；
 * - 用 IIFE 包裹：兼容 Firefox 经典脚本合并拓扑。
 */

import { isAllBookmarksGroup, markNodeDeleted, stampNodeFieldChanges } from "./data-utils.js";
import { nextSyncTimestamp } from "./sync_policy.js";

var HomepageDedupeBookmarks = (() => {
  function defaultTouchContainer(container) {
    if (!container || typeof container !== "object") return;
    container.updatedAt = nextSyncTimestamp(
      Date.now(),
      container.updatedAt,
      container.titleUpdatedAt,
      container.nameUpdatedAt,
      container.orderUpdatedAt,
    );
    container.updatedBy = "";
  }
  function canonicalizeBookmarkUrl(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return "";
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      const protocol = parsed.protocol.toLowerCase();
      const hostname = parsed.hostname.toLowerCase();
      const port =
        (protocol === "http:" && parsed.port === "80") || (protocol === "https:" && parsed.port === "443")
          ? ""
          : parsed.port;
      const host = port ? `${hostname}:${port}` : hostname;
      const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
      return `${protocol}//${host}${pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return "";
    }
  }

  function iconQualityScore(node) {
    if (!node) return 0;
    if (node.iconType === "upload" && node.iconData) return 3;
    if (node.iconType === "remote" && node.iconData) return 2;
    if (node.iconData) return 1;
    return 0;
  }

  function hasMeaningfulTitle(node) {
    const title = String(node?.title || "").trim();
    if (!title) return false;
    return title !== String(node?.url || "").trim();
  }

  function compareKeeperPriority(a, b) {
    const iconDiff = iconQualityScore(b) - iconQualityScore(a);
    if (iconDiff !== 0) return iconDiff;
    const titleDiff = Number(hasMeaningfulTitle(b)) - Number(hasMeaningfulTitle(a));
    if (titleDiff !== 0) return titleDiff;
    const aCreated = Number(a?.createdAt) || Number.MAX_SAFE_INTEGER;
    const bCreated = Number(b?.createdAt) || Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  }

  function buildLocationMap(data) {
    const locations = new Map();
    const record = (nodeId, label) => {
      if (!nodeId || !label) return;
      const list = locations.get(nodeId) || [];
      list.push(label);
      locations.set(nodeId, list);
    };
    const nodes = data?.nodes || {};
    for (const group of data?.groups || []) {
      const groupName = isAllBookmarksGroup(group) ? "" : group.title || group.name || "";
      for (const id of group.nodes || []) {
        if (groupName) record(id, groupName);
      }
    }
    const visitFolder = (folderId, prefix) => {
      const folder = nodes[folderId];
      if (folder?.type !== "folder" || folder.deletedAt || folder.purgedAt) return;
      const title = String(folder.title || "").trim();
      const nextPrefix = prefix ? (title ? `${prefix} / ${title}` : prefix) : title;
      for (const childId of folder.children || []) {
        const child = nodes[childId];
        if (!child || child.deletedAt || child.purgedAt) continue;
        if (child.type === "folder") visitFolder(childId, nextPrefix);
        else if (nextPrefix) record(childId, nextPrefix);
      }
    };
    for (const group of data?.groups || []) {
      for (const id of group.nodes || []) {
        if (nodes[id]?.type === "folder") visitFolder(id, "");
      }
    }
    return locations;
  }

  /**
   * 扫描全部活跃书签，按标准化 URL 识别重复分组。
   * @param {object} data
   * @returns {{ groups: Array<{ canonicalUrl: string, keep: object, duplicates: Array<object>, paths: string[] }>, totalDuplicateCount: number }}
   */
  function findDuplicateBookmarkGroups(data) {
    const nodes = data?.nodes || {};
    const buckets = new Map();
    for (const node of Object.values(nodes)) {
      if (node?.type !== "item" || node.deletedAt || node.purgedAt) continue;
      const key = canonicalizeBookmarkUrl(node.url);
      if (!key) continue;
      const list = buckets.get(key) || [];
      list.push(node);
      buckets.set(key, list);
    }
    const locations = buildLocationMap(data);
    const groups = [];
    let totalDuplicateCount = 0;
    for (const [canonicalUrl, list] of buckets.entries()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort(compareKeeperPriority);
      const keep = sorted[0];
      const duplicates = sorted.slice(1);
      totalDuplicateCount += duplicates.length;
      const paths = [...new Set(list.flatMap((item) => locations.get(item.id) || []))];
      groups.push({ canonicalUrl, keep, duplicates, paths });
    }
    return { groups, totalDuplicateCount };
  }

  /**
   * 原地合并重复书签：将副本书签从容器摘除并写入墓碑（markNodeDeleted），
   * 仅保留每组最优主条目，并继承副本中更优质的自定义标题或图标。
   */
  function mergeDuplicateBookmarks(data, helpers = {}) {
    if (!data || typeof data !== "object") return { mergedGroups: 0, removedCount: 0 };
    const { groups, totalDuplicateCount } = findDuplicateBookmarkGroups(data);
    if (!totalDuplicateCount) return { mergedGroups: 0, removedCount: 0 };
    const removeLoc = helpers.removeNodeFromLocation;
    const touchContainer = helpers.touchPlacementContainer || defaultTouchContainer;
    const markDeleted = helpers.markNodeDeleted || markNodeDeleted;
    const stampChanges = helpers.stampNodeFieldChanges || stampNodeFieldChanges;

    let removedCount = 0;
    for (const { keep, duplicates } of groups) {
      if (!hasMeaningfulTitle(keep)) {
        const donor = duplicates.find(hasMeaningfulTitle);
        if (donor) {
          stampChanges?.(keep, { titleChanged: true });
          keep.title = donor.title;
        }
      }
      if (iconQualityScore(keep) < 2) {
        const donor = [...duplicates].sort((a, b) => iconQualityScore(b) - iconQualityScore(a))[0];
        if (donor && iconQualityScore(donor) >= 2) {
          stampChanges?.(keep, { iconChanged: true });
          keep.iconType = donor.iconType;
          keep.iconData = donor.iconData;
          if (donor.color) keep.color = donor.color;
        }
      }
      for (const dup of duplicates) {
        if (typeof removeLoc === "function") {
          removeLoc(dup.id);
        } else {
          for (const group of data.groups || []) {
            if (!Array.isArray(group.nodes)) continue;
            const filtered = group.nodes.filter((id) => id !== dup.id);
            if (filtered.length !== group.nodes.length) {
              group.nodes = filtered;
              touchContainer?.(group);
            }
          }
          for (const node of Object.values(data.nodes || {})) {
            if (node?.type !== "folder" || !Array.isArray(node.children)) continue;
            const filtered = node.children.filter((id) => id !== dup.id);
            if (filtered.length !== node.children.length) {
              node.children = filtered;
              touchContainer?.(node);
            }
          }
        }
        markDeleted?.(data, dup.id);
        removedCount += 1;
      }
    }
    return { mergedGroups: groups.length, removedCount };
  }

  return { canonicalizeBookmarkUrl, findDuplicateBookmarkGroups, mergeDuplicateBookmarks };
})();

export const canonicalizeBookmarkUrl = HomepageDedupeBookmarks.canonicalizeBookmarkUrl;
export const findDuplicateBookmarkGroups = HomepageDedupeBookmarks.findDuplicateBookmarkGroups;
export const mergeDuplicateBookmarks = HomepageDedupeBookmarks.mergeDuplicateBookmarks;
