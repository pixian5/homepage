import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectBookmarkFolders,
  collectBookmarkItems,
  collectBookmarkTree,
  getPopupBookmarkRoots,
} from "../src/js/bookmark-utils.js";
import { ensureAllBookmarksGroup, getLegacyGroupFolderId } from "../src/js/data-utils.js";

const data = {
  groups: [{ id: "g1", name: "工作", order: 0, nodes: ["folder", "item-2"] }],
  nodes: {
    folder: { id: "folder", type: "folder", title: "项目", children: ["nested", "item-1"] },
    nested: { id: "nested", type: "folder", title: "文档", children: ["item-3"] },
    "item-1": { id: "item-1", type: "item", title: "首页", url: "https://home.example/" },
    "item-2": { id: "item-2", type: "item", title: "博客", url: "https://blog.example/" },
    "item-3": { id: "item-3", type: "item", title: "文档", url: "https://docs.example/" },
  },
};

describe("bookmark-utils", () => {
  it("keeps groups, folders, bookmarks, and their original order in a tree", () => {
    const tree = collectBookmarkTree(data);
    assert.deepEqual(
      tree[0].children.map((node) => [node.id, node.type]),
      [
        ["folder", "folder"],
        ["item-2", "item"],
      ],
    );
    assert.deepEqual(
      tree[0].children[0].children.map((node) => [node.id, node.type]),
      [
        ["nested", "folder"],
        ["item-1", "item"],
      ],
    );
    assert.deepEqual(
      tree[0].children[0].children[0].children.map((node) => node.id),
      ["item-3"],
    );
  });

  it("does not flatten folder bookmarks into the group root", () => {
    const root = collectBookmarkTree(data)[0];
    assert.equal(
      root.children.some((node) => node.id === "item-1" || node.id === "item-3"),
      false,
    );
  });

  it("skips deleted nodes and cuts cyclic references without hanging", () => {
    const cyclic = {
      groups: [{ id: "g1", name: "工作", nodes: ["a", "deleted"] }],
      nodes: {
        a: { id: "a", type: "folder", title: "A", children: ["b"] },
        b: { id: "b", type: "folder", title: "B", children: ["a", "live"] },
        live: { id: "live", type: "item", title: "有效", url: "https://live.example/" },
        deleted: { id: "deleted", type: "item", title: "已删除", url: "https://deleted.example/", deletedAt: 1 },
      },
    };
    const tree = collectBookmarkTree(cyclic);
    assert.deepEqual(
      tree[0].children.map((node) => node.id),
      ["a"],
    );
    assert.deepEqual(
      tree[0].children[0].children[0].children.map((node) => node.id),
      ["live"],
    );
    assert.equal(tree[0].children[0].children[0].children[0].children.length, 0);
    assert.equal(
      tree[0].children.some((node) => node.id === "deleted"),
      false,
    );
  });

  it("flattens groups and nested folders for save targets", () => {
    assert.deepEqual(
      collectBookmarkFolders(data).map((folder) => [folder.id, folder.depth, folder.path.join("/")]),
      [
        ["g1", 0, "工作"],
        ["folder", 1, "工作/项目"],
        ["nested", 2, "工作/项目/文档"],
      ],
    );
  });

  it("collects all reachable ordinary bookmarks with their paths", () => {
    const actual = collectBookmarkItems(data)
      .map((item) => [item.id, item.path.join("/")])
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    assert.deepEqual(actual, [
      ["item-1", "工作/项目"],
      ["item-2", "工作"],
      ["item-3", "工作/项目/文档"],
    ]);
  });

  it("uses all as the single root and exposes migrated real folders below it", () => {
    const migrated = structuredClone(data);
    ensureAllBookmarksGroup(migrated);
    assert.deepEqual(
      collectBookmarkFolders(migrated).map((folder) => [folder.id, folder.depth, folder.path.join("/")]),
      [
        ["grp_all", 0, "全部"],
        [getLegacyGroupFolderId("g1"), 1, "全部/工作"],
        ["folder", 2, "全部/工作/项目"],
        ["nested", 3, "全部/工作/项目/文档"],
      ],
    );
  });

  it("hides the internal all root in the popup without flattening folders", () => {
    const migrated = structuredClone(data);
    ensureAllBookmarksGroup(migrated);
    const roots = getPopupBookmarkRoots(collectBookmarkTree(migrated));
    assert.deepEqual(
      roots.map((node) => [node.id, node.type, node.children.map((child) => child.id)]),
      [[getLegacyGroupFolderId("g1"), "folder", ["folder", "item-2"]]],
    );
  });

  it("collects direct all bookmarks together with root-folder bookmarks", () => {
    const migrated = structuredClone(data);
    ensureAllBookmarksGroup(migrated);
    migrated.nodes.direct = { id: "direct", type: "item", title: "直达", url: "https://direct.example/" };
    migrated.groups.find((group) => group.id === "grp_all").nodes.unshift("direct");
    const paths = new Map(collectBookmarkItems(migrated).map((item) => [item.id, item.path.join("/")]));
    assert.equal(paths.get("direct"), "全部");
    assert.equal(paths.get("item-1"), "全部/工作/项目");
  });
});
