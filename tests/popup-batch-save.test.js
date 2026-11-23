/**
 * Popup 批量保存当前窗口标签页测试：
 * - 过滤：仅 http/https/ftp；chrome://、edge://、about:、扩展页、空 URL 一律排除；同 URL 去重；无标题回退 hostname；
 * - 写入：批量创建节点、按序追加到分组（group.nodes）或文件夹（folder.children）、
 *         登记结构时钟 placementClock、推进父容器 updatedAt；
 * - 异常：无可保存标签、目标容器不存在、数据未初始化。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_BOOKMARKS_GROUP_ID } from "../src/js/data-utils.js";
import { filterSavableTabs, saveSingleTabToContainer, saveTabsToContainer } from "../src/js/popup-batch-save.js";

/** 模拟 chrome.tabs.query({ currentWindow: true }) 的返回 */
function makeTabs() {
  return [
    { id: 1, title: "GitHub", url: "https://github.com/" },
    { id: 2, title: "内页 chrome", url: "chrome://settings/" },
    { id: 3, title: "Edge 内页", url: "edge://favorites" },
    { id: 4, title: "about", url: "about:blank" },
    { id: 5, title: "扩展页", url: "chrome-extension://abc123/newtab.html" },
    { id: 6, title: "空 URL", url: "" },
    { id: 7, title: "无 url 字段" },
    { id: 8, title: "FTP 站点", url: "ftp://files.example.com/pub" },
    { id: 9, title: "", url: "https://no-title.example.com/path" },
    { id: 10, title: "GitHub 重复标签", url: "https://github.com/" },
    { id: 11, title: "百度", url: "https://www.baidu.com/s?wd=1" },
  ];
}

function makeData() {
  return {
    groups: [{ id: ALL_BOOKMARKS_GROUP_ID, name: "全部", order: -1, nodes: ["fld_work"], systemAllGroup: true }],
    nodes: {
      fld_work: { id: "fld_work", type: "folder", title: "工作", children: [], createdAt: 1, updatedAt: 1 },
      itm_existing: { id: "itm_existing", type: "item", title: "已有", url: "https://keep.example.com/", createdAt: 1 },
    },
    settings: {},
    lastUpdated: 1,
  };
}

describe("filterSavableTabs", () => {
  it("keeps only http/https/ftp tabs and drops internal pages", () => {
    const savable = filterSavableTabs(makeTabs());
    assert.deepEqual(
      savable.map((entry) => entry.url),
      [
        "https://github.com/",
        "ftp://files.example.com/pub",
        "https://no-title.example.com/path",
        "https://www.baidu.com/s?wd=1",
      ],
    );
  });

  it("dedupes identical urls and falls back to hostname for empty titles", () => {
    const savable = filterSavableTabs(makeTabs());
    const github = savable.filter((entry) => entry.url === "https://github.com/");
    assert.equal(github.length, 1, "同一 URL 开多个标签只保留一份");
    assert.equal(github[0].title, "GitHub");
    const noTitle = savable.find((entry) => entry.url.startsWith("https://no-title"));
    assert.equal(noTitle.title, "no-title.example.com", "空标题回退 hostname");
    const ftp = savable.find((entry) => entry.url.startsWith("ftp://"));
    assert.equal(ftp.title, "FTP 站点");
  });

  it("returns empty for invalid input", () => {
    assert.deepEqual(filterSavableTabs([]), []);
    assert.deepEqual(filterSavableTabs(null), []);
    assert.deepEqual(filterSavableTabs(undefined), []);
  });
});

describe("saveTabsToContainer", () => {
  const savable = [
    { url: "https://github.com/", title: "GitHub" },
    { url: "https://example.com/", title: "Example" },
  ];
  const NOW = 1700000000000;

  it("batch-writes items into a group with placement clocks", () => {
    const data = makeData();
    const result = saveTabsToContainer(data, savable, {
      containerId: ALL_BOOKMARKS_GROUP_ID,
      deviceId: "dev_test",
      now: NOW,
    });
    assert.deepEqual(result, { ok: true, count: 2, groupId: ALL_BOOKMARKS_GROUP_ID, groupName: "全部" });
    const root = data.groups[0];
    // 原有引用保留，新节点按序追加
    assert.equal(root.nodes.length, 3);
    assert.equal(root.nodes[0], "fld_work");
    const newIds = root.nodes.slice(1);
    for (const id of newIds) {
      const node = data.nodes[id];
      assert.equal(node.type, "item");
      assert.ok(node.url.startsWith("https://"));
      assert.equal(node.iconPending, true, "图标交给后台抓取");
      const clock = data._syncMeta.placementClock[id];
      assert.equal(clock.parentKind, "group");
      assert.equal(clock.parentId, ALL_BOOKMARKS_GROUP_ID);
      assert.equal(clock.updatedAt, NOW);
      assert.equal(clock.updatedBy, "dev_test");
      assert.equal(clock.index, root.nodes.indexOf(id));
    }
    assert.equal(root.updatedAt, NOW);
    assert.equal(data.lastUpdated, NOW);
    assert.equal(data.settings.lastActiveGroupId, ALL_BOOKMARKS_GROUP_ID);
    // 既有节点不受影响
    assert.equal(data.nodes.itm_existing.url, "https://keep.example.com/");
  });

  it("batch-writes items into a nested folder (children list)", () => {
    const data = makeData();
    const result = saveTabsToContainer(data, savable, { containerId: "fld_work", deviceId: "dev_test", now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.groupName, "工作");
    const folder = data.nodes.fld_work;
    assert.equal(folder.children.length, 2);
    const clock = data._syncMeta.placementClock[folder.children[1]];
    assert.equal(clock.parentKind, "folder");
    assert.equal(clock.parentId, "fld_work");
    assert.equal(clock.index, 1);
    // 分组根未被污染
    assert.deepEqual(data.groups[0].nodes, ["fld_work"]);
  });

  it("initializes a missing children list on the target folder", () => {
    const data = makeData();
    delete data.nodes.fld_work.children;
    const result = saveTabsToContainer(data, savable.slice(0, 1), { containerId: "fld_work", now: NOW });
    assert.equal(result.ok, true);
    assert.equal(data.nodes.fld_work.children.length, 1);
  });

  it("rejects no valid tabs, unknown container and uninitialized data", () => {
    const data = makeData();
    assert.deepEqual(saveTabsToContainer(data, [], { containerId: ALL_BOOKMARKS_GROUP_ID }), {
      error: "no_valid_tabs",
    });
    assert.deepEqual(saveTabsToContainer(data, savable, { containerId: "nope" }), { error: "no_group" });
    assert.deepEqual(saveTabsToContainer({ groups: null, nodes: null }, savable, { containerId: "x" }), {
      error: "no_data",
    });
    // 目标是普通书签节点（非分组/文件夹）时同样拒绝
    assert.deepEqual(saveTabsToContainer(data, savable, { containerId: "itm_existing" }), { error: "no_group" });
  });
});

describe("saveSingleTabToContainer", () => {
  const NOW = 1700000000000;

  it("writes a single tab into group or folder with placementClock and save metadata", () => {
    const data = makeData();
    const resGroup = saveSingleTabToContainer(
      data,
      { url: "https://docs.example.com/a", title: "Docs" },
      { containerId: ALL_BOOKMARKS_GROUP_ID, deviceId: "dev_single", now: NOW },
    );
    assert.equal(resGroup.ok, true);
    assert.equal(resGroup.groupId, ALL_BOOKMARKS_GROUP_ID);
    const groupNode = data.nodes[resGroup.nodeId];
    assert.equal(groupNode.title, "Docs");
    assert.equal(groupNode.updatedBy, "dev_single");
    const groupClock = data._syncMeta.placementClock[resGroup.nodeId];
    assert.deepEqual(groupClock, {
      parentKind: "group",
      parentId: ALL_BOOKMARKS_GROUP_ID,
      index: 1,
      updatedAt: NOW,
      updatedBy: "dev_single",
    });
    assert.equal(data.settings.lastSaveUrl, "https://docs.example.com/a");
    assert.equal(data.settings.lastSaveTs, NOW);
    assert.equal(data.settings.lastSaveToast, null);
    assert.equal(data.settings.lastActiveGroupId, ALL_BOOKMARKS_GROUP_ID);

    // 写入嵌套文件夹并验证自定义标题与时钟单调推进
    const resFolder = saveSingleTabToContainer(
      data,
      { url: "https://app.example.com/page", title: "原标题" },
      { containerId: "fld_work", customTitle: "自定义标题", deviceId: "dev_single", now: NOW + 10 },
    );
    assert.equal(resFolder.ok, true);
    assert.equal(data.nodes[resFolder.nodeId].title, "自定义标题");
    assert.deepEqual(data._syncMeta.placementClock[resFolder.nodeId], {
      parentKind: "folder",
      parentId: "fld_work",
      index: 0,
      updatedAt: NOW + 10,
      updatedBy: "dev_single",
    });
  });

  it("monotonically advances placementClock when container clock is ahead of wall clock", () => {
    const data = makeData();
    data.nodes.fld_work.updatedAt = NOW + 5000;
    data.lastUpdated = NOW + 6000;
    const res = saveSingleTabToContainer(
      data,
      { url: "https://skew.example.com/", title: "" },
      { containerId: "fld_work", deviceId: "dev_skew", now: NOW },
    );
    assert.equal(res.ok, true);
    assert.equal(data.nodes[res.nodeId].title, "skew.example.com");
    assert.equal(data._syncMeta.placementClock[res.nodeId].updatedAt, NOW + 5001);
    assert.equal(data.nodes.fld_work.updatedAt, NOW + 5001);
    assert.equal(data.lastUpdated, NOW + 6001);
  });

  it("rejects invalid url, unknown container, or uninitialized data", () => {
    const data = makeData();
    assert.deepEqual(
      saveSingleTabToContainer(data, { url: "javascript:alert(1)" }, { containerId: ALL_BOOKMARKS_GROUP_ID }),
      { error: "invalid_url" },
    );
    assert.deepEqual(saveSingleTabToContainer(data, { url: "https://a.example/" }, { containerId: "missing" }), {
      error: "no_group",
    });
    assert.deepEqual(
      saveSingleTabToContainer({ groups: null, nodes: null }, { url: "https://a.example/" }, { containerId: "x" }),
      { error: "no_data" },
    );
  });
});
