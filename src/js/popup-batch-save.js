/**
 * Popup「批量保存当前窗口所有标签页」的核心逻辑（纯函数，便于单元测试）。
 * chrome.tabs 查询与存储写入留在 popup.js，本模块只做过滤与数据变换。
 */

import { createItemNode } from "./data-utils.js";
import { normalizeUrl } from "./shared-utils.js";

/**
 * 过滤出可保存的标签页：
 * - 仅保留 http/https/ftp 协议（chrome://、edge://、about:、扩展页、空 URL 一律排除）；
 * - 同一 URL 只保留第一份（同一页面开多个标签没必要重复保存）；
 * - 无标题时回退为 hostname。
 *
 * @param {Array<chrome.tabs.Tab>} tabs
 * @returns {Array<{url: string, title: string}>}
 */
export function filterSavableTabs(tabs) {
  const out = [];
  const seen = new Set();
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    const url = normalizeUrl(tab?.url);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    let title = String(tab?.title || "").trim();
    if (!title) {
      try {
        title = new URL(url).hostname;
      } catch (_e) {
        title = "";
      }
    }
    out.push({ url, title });
  }
  return out;
}

/**
 * 把一批标签页批量写入目标分组/文件夹（修改传入的 data）：
 * - 每个标签生成独立 item 节点并按序追加；
 * - 为每个新节点登记结构时钟 placementClock（与后台保存路径一致，保证多端并发裁决准确）；
 * - 推进父容器 updatedAt。
 *
 * @param {object} data 主数据
 * @param {Array<{url: string, title: string}>} savableTabs filterSavableTabs 的结果
 * @param {{containerId: string, deviceId?: string, now?: number}} options
 * @returns {{ok: true, count: number, groupId: string, groupName: string} | {error: string}}
 */
export function saveTabsToContainer(data, savableTabs, { containerId, deviceId = "", now = Date.now() } = {}) {
  if (!data?.groups || !data.nodes) return { error: "no_data" };
  const group = data.groups.find((entry) => entry.id === containerId);
  const folder = !group ? data.nodes[containerId] : null;
  const container = group || (folder?.type === "folder" ? folder : null);
  if (!container) return { error: "no_group" };
  if (!Array.isArray(savableTabs) || !savableTabs.length) return { error: "no_valid_tabs" };

  // 初始化容器子节点列表（group.nodes / folder.children）
  const list = Array.isArray(container.nodes)
    ? container.nodes
    : Array.isArray(container.children)
      ? container.children
      : (container.children = []);
  const parentKind = Array.isArray(container.nodes) ? "group" : "folder";

  if (!data._syncMeta || typeof data._syncMeta !== "object") data._syncMeta = {};
  if (!data._syncMeta.placementClock || typeof data._syncMeta.placementClock !== "object") {
    data._syncMeta.placementClock = {};
  }
  for (const entry of savableTabs) {
    const node = createItemNode({
      url: entry.url,
      title: entry.title || entry.url,
      iconType: "auto",
      iconPending: true,
    });
    data.nodes[node.id] = node;
    list.push(node.id);
    data._syncMeta.placementClock[node.id] = {
      parentKind,
      parentId: container.id,
      index: list.indexOf(node.id),
      updatedAt: now,
      updatedBy: deviceId,
    };
  }
  container.updatedAt = now;
  container.updatedBy = "";
  if (data.settings) {
    data.settings.lastActiveGroupId = container.id;
  }
  data.lastUpdated = now;
  return {
    ok: true,
    count: savableTabs.length,
    groupId: container.id,
    groupName: String(container.name || container.title || ""),
  };
}
