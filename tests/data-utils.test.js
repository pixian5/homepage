import assert from "node:assert";
import { describe, it } from "node:test";
import {
  buildBackupFingerprint,
  buildBackupSettingsSnapshot,
  cloneDataSnapshot,
  createItemNode,
  dedupeData,
  moveNodeInList,
  pickLatestData,
} from "../src/js/data-utils.js";

describe("data-utils", () => {
  describe("buildBackupSettingsSnapshot", () => {
    it("keeps settings not in ignored set", () => {
      const result = buildBackupSettingsSnapshot({ fontSize: 14, theme: "dark" }, new Set());
      assert.deepStrictEqual(result, { fontSize: 14, theme: "dark" });
    });

    it("ignores keys in ignored set", () => {
      const result = buildBackupSettingsSnapshot({ fontSize: 14, lastSaveTs: 1 }, new Set(["lastSaveTs"]));
      assert.deepStrictEqual(result, { fontSize: 14 });
    });

    it("sorts keys", () => {
      const result = buildBackupSettingsSnapshot({ b: 2, a: 1 }, new Set());
      assert.deepStrictEqual(Object.keys(result), ["a", "b"]);
    });
  });

  describe("buildBackupFingerprint", () => {
    it("is stable for identical data", () => {
      const data = {
        settings: { fontSize: 14 },
        groups: [{ id: "g1", name: "A", order: 0, nodes: ["n1"] }],
        nodes: { n1: { id: "n1", type: "item", title: "T", url: "https://a.com", iconType: "auto", color: "" } },
      };
      const ignored = new Set();
      assert.strictEqual(buildBackupFingerprint(data, ignored), buildBackupFingerprint(data, ignored));
    });

    it("is equal regardless of group order", () => {
      const data1 = {
        settings: {},
        groups: [
          { id: "g1", name: "A", order: 0, nodes: [] },
          { id: "g2", name: "B", order: 1, nodes: [] },
        ],
        nodes: {},
      };
      const data2 = {
        settings: {},
        groups: [
          { id: "g2", name: "B", order: 1, nodes: [] },
          { id: "g1", name: "A", order: 0, nodes: [] },
        ],
        nodes: {},
      };
      const ignored = new Set();
      assert.strictEqual(buildBackupFingerprint(data1, ignored), buildBackupFingerprint(data2, ignored));
    });

    it("differs when data differs", () => {
      const data1 = { settings: {}, groups: [], nodes: {} };
      const data2 = { settings: { fontSize: 14 }, groups: [], nodes: {} };
      const ignored = new Set();
      assert.notStrictEqual(buildBackupFingerprint(data1, ignored), buildBackupFingerprint(data2, ignored));
    });

    it("ignores configured settings keys", () => {
      const data1 = { settings: { fontSize: 14, lastSaveTs: 1 }, groups: [], nodes: {} };
      const data2 = { settings: { fontSize: 14, lastSaveTs: 2 }, groups: [], nodes: {} };
      const ignored = new Set(["lastSaveTs"]);
      assert.strictEqual(buildBackupFingerprint(data1, ignored), buildBackupFingerprint(data2, ignored));
    });
  });

  describe("moveNodeInList", () => {
    it("moves id to target index", () => {
      const result = moveNodeInList(["a", "b", "c"], "a", 2);
      assert.deepStrictEqual(result, ["b", "a", "c"]);
    });

    it("returns same list when index unchanged", () => {
      const list = ["a", "b", "c"];
      const result = moveNodeInList(list, "b", 1);
      assert.deepStrictEqual(result, list);
    });

    it("returns same list when id not found", () => {
      const list = ["a", "b", "c"];
      const result = moveNodeInList(list, "z", 1);
      assert.deepStrictEqual(result, list);
    });

    it("clamps index to bounds", () => {
      const result = moveNodeInList(["a", "b", "c"], "a", 100);
      assert.deepStrictEqual(result, ["b", "c", "a"]);
    });

    it("does not mutate input list", () => {
      const list = ["a", "b", "c"];
      moveNodeInList(list, "a", 2);
      assert.deepStrictEqual(list, ["a", "b", "c"]);
    });
  });

  describe("dedupeData", () => {
    it("removes references to missing nodes", () => {
      const data = {
        groups: [{ id: "g1", nodes: ["n1", "n2"] }],
        nodes: { n1: { id: "n1", type: "item" } },
      };
      const changed = dedupeData(data);
      assert.strictEqual(changed, true);
      assert.deepStrictEqual(data.groups[0].nodes, ["n1"]);
    });

    it("removes duplicate node references", () => {
      const data = {
        groups: [{ id: "g1", nodes: ["n1", "n1", "n2"] }],
        nodes: { n1: { id: "n1", type: "item" }, n2: { id: "n2", type: "item" } },
      };
      const changed = dedupeData(data);
      assert.strictEqual(changed, true);
      assert.deepStrictEqual(data.groups[0].nodes, ["n1", "n2"]);
    });

    it("cleans folder children", () => {
      const data = {
        groups: [],
        nodes: {
          f1: { id: "f1", type: "folder", children: ["n1", "n1", "missing"] },
          n1: { id: "n1", type: "item" },
        },
      };
      const changed = dedupeData(data);
      assert.strictEqual(changed, true);
      assert.deepStrictEqual(data.nodes.f1.children, ["n1"]);
    });

    it("returns false when no changes", () => {
      const data = {
        groups: [{ id: "g1", nodes: ["n1"] }],
        nodes: { n1: { id: "n1", type: "item" } },
      };
      const changed = dedupeData(data);
      assert.strictEqual(changed, false);
      assert.deepStrictEqual(data.groups[0].nodes, ["n1"]);
    });
  });

  describe("cloneDataSnapshot", () => {
    it("returns deep clone", () => {
      const data = { settings: { fontSize: 14 }, nodes: { n1: { title: "A" } } };
      const clone = cloneDataSnapshot(data);
      clone.settings.fontSize = 20;
      clone.nodes.n1.title = "B";
      assert.strictEqual(data.settings.fontSize, 14);
      assert.strictEqual(data.nodes.n1.title, "A");
    });
  });

  describe("createItemNode", () => {
    it("creates item with defaults", () => {
      const node = createItemNode({ url: "https://example.com" });
      assert.strictEqual(node.type, "item");
      assert.strictEqual(node.url, "https://example.com");
      assert.strictEqual(node.iconType, "auto");
      assert.strictEqual(node.title, "");
      assert.strictEqual(node.iconData, "");
      assert.strictEqual(node.color, "");
      assert.strictEqual(node.titlePending, false);
      assert.strictEqual(node.iconPending, false);
      assert.ok(node.id.startsWith("itm_"));
      assert.ok(node.createdAt > 0);
      assert.strictEqual(node.createdAt, node.updatedAt);
    });

    it("uses provided values", () => {
      const node = createItemNode({
        url: "https://example.com",
        title: "Example",
        iconType: "color",
        iconData: "data:image/png;base64,x",
        color: "#ff0000",
        titlePending: true,
        iconPending: true,
      });
      assert.strictEqual(node.title, "Example");
      assert.strictEqual(node.iconType, "color");
      assert.strictEqual(node.iconData, "data:image/png;base64,x");
      assert.strictEqual(node.color, "#ff0000");
      assert.strictEqual(node.titlePending, true);
      assert.strictEqual(node.iconPending, true);
    });

    it("generates unique ids", () => {
      const a = createItemNode({ url: "https://a.com" });
      const b = createItemNode({ url: "https://b.com" });
      assert.notStrictEqual(a.id, b.id);
    });
  });

  describe("pickLatestData", () => {
    it("returns local when sync missing", () => {
      const local = { lastUpdated: 1 };
      assert.strictEqual(pickLatestData(local, null), local);
    });

    it("returns sync when local missing", () => {
      const sync = { lastUpdated: 1 };
      assert.strictEqual(pickLatestData(null, sync), sync);
    });

    it("returns newer by lastUpdated", () => {
      const local = { lastUpdated: 100 };
      const sync = { lastUpdated: 200 };
      assert.strictEqual(pickLatestData(local, sync), sync);
      assert.strictEqual(pickLatestData(sync, local), sync);
    });
  });
});
