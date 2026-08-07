import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectBookmarkFolders, collectBookmarkItems } from "../src/js/bookmark-utils.js";

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
});
