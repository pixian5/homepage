import assert from "node:assert";
import { describe, it } from "node:test";
import {
  buildBackupFingerprint,
  buildBackupSettingsSnapshot,
  cloneDataSnapshot,
  collectNodeSubtreeIds,
  createItemNode,
  dedupeData,
  isSafeCssColor,
  moveNodeInList,
  pickLatestData,
  repairHomepageData,
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
        // 文件夹必须挂在分组下，否则孤儿 GC 会一并清除
        groups: [{ id: "g1", nodes: ["f1"] }],
        nodes: {
          f1: { id: "f1", type: "folder", children: ["n1", "n1", "missing"] },
          n1: { id: "n1", type: "item" },
        },
      };
      const changed = dedupeData(data);
      assert.strictEqual(changed, true);
      assert.deepStrictEqual(data.nodes.f1.children, ["n1"]);
      assert.ok(data.nodes.n1);
    });

    it("removes orphan nodes not reachable from any group", () => {
      const data = {
        groups: [{ id: "g1", nodes: ["n1"] }],
        nodes: {
          n1: { id: "n1", type: "item" },
          orphan: { id: "orphan", type: "item" },
          deadFolder: { id: "deadFolder", type: "folder", children: ["orphanChild"] },
          orphanChild: { id: "orphanChild", type: "item" },
        },
      };
      const changed = dedupeData(data);
      assert.strictEqual(changed, true);
      assert.deepStrictEqual(Object.keys(data.nodes).sort(), ["n1"]);
    });

    it("keeps nested folder descendants reachable from groups", () => {
      const data = {
        groups: [{ id: "g1", nodes: ["f1"] }],
        nodes: {
          f1: { id: "f1", type: "folder", children: ["f2"] },
          f2: { id: "f2", type: "folder", children: ["n1"] },
          n1: { id: "n1", type: "item" },
        },
      };
      const changed = dedupeData(data);
      assert.strictEqual(changed, false);
      assert.ok(data.nodes.f2);
      assert.ok(data.nodes.n1);
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

  describe("collectNodeSubtreeIds", () => {
    it("collects folder and nested children", () => {
      const data = {
        nodes: {
          f1: { type: "folder", children: ["f2", "n1"] },
          f2: { type: "folder", children: ["n2"] },
          n1: { type: "item" },
          n2: { type: "item" },
        },
      };
      const ids = collectNodeSubtreeIds(data, "f1");
      assert.deepStrictEqual(new Set(ids), new Set(["f1", "f2", "n1", "n2"]));
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

  describe("repairHomepageData", () => {
    const defaults = { showSearch: true, syncEnabled: false };

    it("coerces missing top-level fields to expected types", () => {
      const repaired = repairHomepageData({}, defaults);
      assert.strictEqual(repaired.schemaVersion, 1);
      assert.deepStrictEqual(repaired.groups, []);
      assert.deepStrictEqual(repaired.nodes, {});
      assert.deepStrictEqual(repaired.backups, []);
      assert.strictEqual(repaired.settings.showSearch, true);
    });

    it("removes non-object / typeless nodes", () => {
      const data = {
        schemaVersion: 1,
        groups: [{ id: "g1", nodes: ["n1", "bad", "notype"] }],
        nodes: {
          n1: { type: "item", url: "https://a.com" },
          bad: null,
          notype: { id: "notype" },
        },
        settings: {},
      };
      const repaired = repairHomepageData(data, defaults);
      assert.deepStrictEqual(Object.keys(repaired.nodes), ["n1"]);
      assert.deepStrictEqual(repaired.groups[0].nodes, ["n1"]);
    });

    it("coerces folder children to array", () => {
      const data = {
        schemaVersion: 1,
        groups: [],
        nodes: { f1: { type: "folder", children: "nope" } },
        settings: {},
      };
      const repaired = repairHomepageData(data, defaults);
      assert.deepStrictEqual(repaired.nodes.f1.children, []);
    });

    it("drops group node references pointing to missing nodes", () => {
      const data = {
        schemaVersion: 1,
        groups: [{ id: "g1", nodes: ["n1", "ghost"] }],
        nodes: { n1: { type: "item" } },
        settings: {},
      };
      const repaired = repairHomepageData(data, defaults);
      assert.deepStrictEqual(repaired.groups[0].nodes, ["n1"]);
    });

    it("merges defaults under user settings without clobbering", () => {
      const data = {
        schemaVersion: 1,
        groups: [],
        nodes: {},
        settings: { syncEnabled: true, fontSize: 16 },
      };
      const repaired = repairHomepageData(data, defaults);
      assert.strictEqual(repaired.settings.syncEnabled, true);
      assert.strictEqual(repaired.settings.showSearch, true);
      assert.strictEqual(repaired.settings.fontSize, 16);
    });

    it("does not throw on garbage input", () => {
      assert.doesNotThrow(() => repairHomepageData("garbage", defaults));
      assert.doesNotThrow(() => repairHomepageData(null, defaults));
      assert.doesNotThrow(() => repairHomepageData({ nodes: [], groups: "x" }, defaults));
    });

    it("sanitizes unsafe search engine and background color", () => {
      const data = {
        schemaVersion: 1,
        groups: [],
        nodes: {
          n1: { type: "item", iconType: "upload", iconData: "javascript:alert(1)" },
        },
        settings: {
          searchEngineUrl: "javascript:alert(1)",
          backgroundColor: "red; background-image: url(//evil)",
        },
      };
      const repaired = repairHomepageData(data, {
        searchEngineUrl: "https://www.bing.com/search?q=",
        backgroundColor: "#0b0f14",
      });
      assert.equal(repaired.settings.searchEngineUrl, "https://www.bing.com/search?q=");
      assert.equal(repaired.settings.backgroundColor, "#0b0f14");
      assert.equal(repaired.nodes.n1.iconType, "auto");
      assert.equal(repaired.nodes.n1.iconData, "");
    });
  });

  describe("isSafeCssColor", () => {
    it("accepts hex and named colors", () => {
      assert.equal(isSafeCssColor("#fff"), true);
      assert.equal(isSafeCssColor("#0b0f14"), true);
      assert.equal(isSafeCssColor("red"), true);
      assert.equal(isSafeCssColor("rgb(1,2,3)"), true);
    });
    it("rejects injection-like strings", () => {
      assert.equal(isSafeCssColor("red; background-image:url(x)"), false);
      assert.equal(isSafeCssColor("url(https://x)"), false);
      assert.equal(isSafeCssColor(""), false);
    });
  });
});
