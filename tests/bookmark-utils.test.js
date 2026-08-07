import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectBookmarkFolders, collectBookmarkItems } from "../src/js/bookmark-utils.js";
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
