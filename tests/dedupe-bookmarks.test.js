import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markNodeDeleted, stampNodeFieldChanges } from "../src/js/data-utils.js";
import {
  canonicalizeBookmarkUrl,
  findDuplicateBookmarkGroups,
  mergeDuplicateBookmarks,
} from "../src/js/dedupe-bookmarks.js";
import { defaultData } from "../src/js/storage.js";
import { mergeHomepage } from "../src/js/sync_merge.js";
import { hashSyncDocument, toSyncDocument } from "../src/js/sync_projection.js";

function makeItem(id, { title = "", url = "", iconType = "auto", iconData = "", createdAt = 1000 } = {}) {
  return {
    id,
    type: "item",
    title,
    url,
    iconType,
    iconData,
    createdAt,
    updatedAt: createdAt,
    titleUpdatedAt: createdAt,
    urlUpdatedAt: createdAt,
  };
}

describe("dedupe-bookmarks", () => {
  it("canonicalizes equivalent http/https URLs while keeping paths and queries", () => {
    assert.equal(canonicalizeBookmarkUrl("https://Example.COM:443/"), "https://example.com");
    assert.equal(canonicalizeBookmarkUrl("https://example.com"), "https://example.com");
    assert.equal(canonicalizeBookmarkUrl("http://Example.com:80/docs?q=1#top"), "http://example.com/docs?q=1#top");
    assert.equal(canonicalizeBookmarkUrl("javascript:alert(1)"), "");
  });

  it("ranks upload > remote > titled > oldest as keeper and skips tombstoned items", () => {
    const data = defaultData();
    data.nodes.fld_work = { id: "fld_work", type: "folder", title: "工作", children: ["itm_old", "itm_up"] };
    data.nodes.itm_old = makeItem("itm_old", {
      title: "旧书签",
      url: "https://example.com/",
      createdAt: 100,
    });
    data.nodes.itm_up = makeItem("itm_up", {
      title: "https://example.com",
      url: "https://Example.com",
      iconType: "upload",
      iconData: "data:image/png;base64,AAA",
      createdAt: 500,
    });
    data.nodes.itm_del = makeItem("itm_del", {
      title: "已删除",
      url: "https://example.com",
      createdAt: 10,
    });
    data.nodes.itm_del.deletedAt = 200;
    data.groups[0].nodes.push("fld_work");

    const scan = findDuplicateBookmarkGroups(data);
    assert.equal(scan.groups.length, 1);
    assert.equal(scan.totalDuplicateCount, 1);
    assert.equal(scan.groups[0].keep.id, "itm_up");
    assert.deepEqual(
      scan.groups[0].duplicates.map((d) => d.id),
      ["itm_old"],
    );
  });

  it("merges duplicate titles/icons, touches containers, tombstones removed nodes, and stays synced", () => {
    const data = defaultData();
    data.nodes.fld_a = { id: "fld_a", type: "folder", title: "分类A", children: ["itm_keep"], updatedAt: 100 };
    data.nodes.fld_b = { id: "fld_b", type: "folder", title: "分类B", children: ["itm_dup"], updatedAt: 100 };
    data.nodes.itm_keep = makeItem("itm_keep", {
      title: "",
      url: "https://example.com/app",
      iconType: "remote",
      iconData: "https://cdn.example.com/icon.png",
      createdAt: 100,
    });
    data.nodes.itm_dup = makeItem("itm_dup", {
      title: "我的应用",
      url: "https://Example.COM/app",
      iconType: "auto",
      createdAt: 200,
    });
    data.groups[0].nodes.push("fld_a", "fld_b");

    const remoteOldSnapshot = toSyncDocument(structuredClone(data), {
      deviceId: "dev_remote",
      docId: "doc_dedupe",
      revision: 1,
      writtenAt: Date.now() - 1000,
    });
    remoteOldSnapshot.contentHash = hashSyncDocument(remoteOldSnapshot);

    const res = mergeDuplicateBookmarks(data, { markNodeDeleted, stampNodeFieldChanges });
    assert.deepEqual(res, { mergedGroups: 1, removedCount: 1 });
    assert.equal(data.nodes.itm_keep.title, "我的应用");
    assert.equal(data.nodes.itm_keep.iconType, "remote");
    assert.equal(data.nodes.itm_keep.iconData, "https://cdn.example.com/icon.png");
    assert.deepEqual(data.nodes.fld_b.children, []);
    assert.ok(data.nodes.fld_b.updatedAt > 100);
    assert.equal(data.nodes.itm_dup, undefined);
    assert.ok(data._syncMeta?.nodeTombstones?.itm_dup?.deletedAt > 0);

    // 远端旧快照在多设备同步合并中不得把已被清理的重复书签复活
    const merged = mergeHomepage(data, remoteOldSnapshot, { deviceId: "dev_local", docId: "doc_dedupe" });
    assert.equal(merged.ok, true);
    assert.ok(merged.state.nodes.itm_dup?.deletedAt > 0);
    assert.ok(merged.state._syncMeta?.nodeTombstones?.itm_dup?.deletedAt > 0);
    assert.equal(findDuplicateBookmarkGroups(merged.state).totalDuplicateCount, 0);

    // 验证当副本携带更优上传图标时，主条目也继承该图标
    const dataIcon = defaultData();
    dataIcon.nodes.itm_best = makeItem("itm_best", {
      title: "应用B",
      url: "https://icon.example.com/",
      iconType: "upload",
      iconData: "data:image/png;base64,UP",
      createdAt: 300,
    });
    dataIcon.nodes.itm_plain = makeItem("itm_plain", {
      title: "",
      url: "https://icon.example.com",
      iconType: "auto",
      createdAt: 100,
    });
    dataIcon.groups[0].nodes.push("itm_plain", "itm_best");
    const resIcon = mergeDuplicateBookmarks(dataIcon, { markNodeDeleted, stampNodeFieldChanges });
    assert.deepEqual(resIcon, { mergedGroups: 1, removedCount: 1 });
    assert.equal(dataIcon.nodes.itm_best.title, "应用B");
    assert.equal(dataIcon.nodes.itm_plain, undefined);
    assert.deepEqual(dataIcon.groups[0].nodes, ["itm_best"]);
  });
});
