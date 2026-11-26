import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addBookmarkToFolderInData } from "../src/js/background.js";

function sampleData() {
  return {
    lastUpdated: 5000,
    groups: [
      {
        id: "grp_all",
        name: "全部",
        nodes: ["fld_work"],
        updatedAt: 4000,
        updatedBy: "dev_old",
      },
    ],
    nodes: {
      fld_work: {
        id: "fld_work",
        type: "folder",
        title: "Work",
        children: ["itm_1"],
        updatedAt: 5200,
        updatedBy: "dev_old",
      },
      itm_1: {
        id: "itm_1",
        type: "item",
        title: "Existing",
        url: "https://existing.example/",
        updatedAt: 3000,
        updatedBy: "dev_old",
      },
    },
    _syncMeta: { placementClock: {} },
  };
}

describe("background addBookmarkToFolderInData", () => {
  it("writes bookmark into group with monotonic sync timestamps and placementClock", () => {
    const data = sampleData();
    const res = addBookmarkToFolderInData(data, {
      folderId: "grp_all",
      url: "https://news.example.com/article",
      title: "News",
      deviceId: "dev_safari",
      now: 1200, // 故意落后于 data.lastUpdated (5000)
    });

    assert.equal(res.ok, true);
    const { node } = res;
    assert.equal(node.url, "https://news.example.com/article");
    assert.equal(node.title, "News");
    assert.equal(node.createdAt, 5001);
    assert.equal(node.updatedAt, 5001);
    assert.equal(node.titleUpdatedAt, 5001);
    assert.equal(node.urlUpdatedAt, 5001);
    assert.equal(node.updatedBy, "dev_safari");
    assert.equal(data.lastUpdated, 5001);
    assert.equal(data.groups[0].updatedAt, 5001);
    assert.equal(data.groups[0].updatedBy, "dev_safari");
    assert.equal(data.groups[0].nodes.at(-1), node.id);
    assert.deepEqual(data._syncMeta.placementClock[node.id], {
      parentKind: "group",
      parentId: "grp_all",
      index: 1,
      updatedAt: 5001,
      updatedBy: "dev_safari",
    });
  });

  it("writes bookmark into folder and advances beyond folder.updatedAt", () => {
    const data = sampleData();
    data.nodes.fld_work.titleUpdatedAt = 5300;
    const res = addBookmarkToFolderInData(data, {
      folderId: "fld_work",
      url: "http://docs.example.org/",
      deviceId: "dev_ff",
      now: 2000, // 落后于 folder.titleUpdatedAt (5300)
    });

    assert.equal(res.ok, true);
    const { node } = res;
    assert.equal(node.title, "http://docs.example.org/");
    assert.equal(node.createdAt, 5301);
    assert.equal(node.updatedAt, 5301);
    assert.equal(node.titleUpdatedAt, 5301);
    assert.equal(node.urlUpdatedAt, 5301);
    assert.equal(node.updatedBy, "dev_ff");
    assert.equal(data.nodes.fld_work.updatedAt, 5301);
    assert.equal(data.nodes.fld_work.updatedBy, "dev_ff");
    assert.equal(data.lastUpdated, 5301);
    assert.deepEqual(data._syncMeta.placementClock[node.id], {
      parentKind: "folder",
      parentId: "fld_work",
      index: 1,
      updatedAt: 5301,
      updatedBy: "dev_ff",
    });
  });

  it("rejects invalid urls, missing targets, tombstoned folders, and non-folder nodes cleanly", () => {
    const data = sampleData();
    data.nodes.fld_deleted = { id: "fld_deleted", type: "folder", title: "Deleted", children: [], deletedAt: 100 };
    assert.deepEqual(
      addBookmarkToFolderInData(data, { folderId: "grp_all", url: "javascript:alert(1)", deviceId: "d" }),
      { ok: false, error: "invalid_url" },
    );
    assert.deepEqual(addBookmarkToFolderInData(data, { folderId: "missing", url: "https://a.test/", deviceId: "d" }), {
      ok: false,
      error: "no_folder",
    });
    assert.deepEqual(
      addBookmarkToFolderInData(data, { folderId: "fld_deleted", url: "https://a.test/", deviceId: "d" }),
      { ok: false, error: "no_folder" },
    );
    assert.deepEqual(addBookmarkToFolderInData(data, { folderId: "itm_1", url: "https://a.test/", deviceId: "d" }), {
      ok: false,
      error: "no_folder",
    });
    assert.equal(Object.keys(data.nodes).length, 3);
  });
});
