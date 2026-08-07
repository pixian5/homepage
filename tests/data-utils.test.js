import assert from "node:assert";
import { describe, it } from "node:test";
import {
  ALL_BOOKMARKS_GROUP_ID,
  buildBackupFingerprint,
  buildBackupSettingsSnapshot,
  cloneDataSnapshot,
  collectNodeSubtreeIds,
  createItemNode,
  dedupeData,
  ensureAllBookmarksGroup,
  getLegacyGroupFolderId,
  getRootFolderNodeIds,
  isSafeCssColor,
  markGroupDeleted,
  markNodeDeleted,
  mergeRootBookmarkData,
  moveNodeInList,
  pickLatestData,
  pruneSyncTombstones,
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

  describe("sync tombstones", () => {
    it("moves deleted nodes and groups out of the visible data", () => {
      const data = {
        groups: [{ id: "g1", name: "A", nodes: ["n1"] }],
        nodes: { n1: { id: "n1", type: "item", title: "A" } },
      };
      markNodeDeleted(data, "n1", 1000);
      markGroupDeleted(data, data.groups[0], 1000);

      assert.equal(data.nodes.n1, undefined);
      assert.equal(data._syncMeta.nodeTombstones.n1.deletedAt, 1000);
      assert.equal(data._syncMeta.groupTombstones[0].deletedAt, 1000);
    });

    it("prunes only expired tombstones", () => {
      const now = 10_000_000_000;
      const data = {
        nodes: {
          old: { id: "old", type: "item", deletedAt: now - 60 * 24 * 60 * 60 * 1000 - 1 },
          recent: { id: "recent", type: "item", deletedAt: now - 1 },
        },
        _syncMeta: {
          groupTombstones: [
            { id: "old-group", deletedAt: now - 60 * 24 * 60 * 60 * 1000 - 1 },
            { id: "recent-group", deletedAt: now - 1 },
          ],
        },
      };
      assert.equal(pruneSyncTombstones(data, now), true);
      assert.equal(data.nodes.old, undefined);
      assert.ok(data.nodes.recent);
      assert.deepEqual(
        data._syncMeta.groupTombstones.map((group) => group.id),
        ["recent-group"],
      );
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
      assert.deepStrictEqual(
        repaired.groups.map((group) => group.id),
        [ALL_BOOKMARKS_GROUP_ID],
      );
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
      assert.deepStrictEqual(Object.keys(repaired.nodes).sort(), [getLegacyGroupFolderId("g1"), "n1"].sort());
      assert.deepStrictEqual(repaired.groups[0].nodes, [getLegacyGroupFolderId("g1")]);
      assert.deepStrictEqual(repaired.nodes[getLegacyGroupFolderId("g1")].children, ["n1"]);
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
      assert.deepStrictEqual(repaired.nodes[getLegacyGroupFolderId("g1")].children, ["n1"]);
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

  describe("all bookmarks group", () => {
    it("migrates old groups into real folders under the fixed all root", () => {
      const data = {
        groups: [{ id: "g1", name: "工作", order: 0, nodes: ["n1"] }],
        nodes: { n1: { id: "n1", type: "item", title: "首页" } },
      };
      assert.equal(ensureAllBookmarksGroup(data), true);
      const allGroup = data.groups.find((group) => group.id === ALL_BOOKMARKS_GROUP_ID);
      const proxyId = getLegacyGroupFolderId("g1");
      assert.equal(data.groups.sort((a, b) => a.order - b.order)[0].id, ALL_BOOKMARKS_GROUP_ID);
      assert.deepEqual(allGroup.nodes, [proxyId]);
      assert.deepEqual(
        data.groups.map((group) => group.id),
        [ALL_BOOKMARKS_GROUP_ID],
      );
      assert.deepEqual(data.nodes[proxyId].children, ["n1"]);
      assert.equal(data.nodes[proxyId].linkedGroupId, undefined);
      assert.equal(data.backups.length, 1);
      assert.equal(data._syncMeta.groupTombstones[0].id, "g1");
    });

    it("preserves mixed direct bookmarks and converted real folders", () => {
      const proxyId = getLegacyGroupFolderId("g1");
      const data = {
        groups: [
          { id: ALL_BOOKMARKS_GROUP_ID, name: "全部", order: -1, nodes: ["direct", proxyId] },
          { id: "g1", name: "工作", order: 0, nodes: [] },
        ],
        nodes: {
          direct: { id: "direct", type: "item", title: "直接书签" },
          [proxyId]: {
            id: proxyId,
            type: "folder",
            title: "工作",
            children: [],
            linkedGroupId: "g1",
            systemGroupFolder: true,
          },
        },
      };
      assert.equal(ensureAllBookmarksGroup(data), true);
      assert.equal(ensureAllBookmarksGroup(data), false);
      assert.deepEqual(data.groups[0].nodes, ["direct", proxyId]);
      assert.equal(data.nodes[proxyId].systemGroupFolder, undefined);
    });

    it("is idempotent and keeps real root folders without a second structure", () => {
      const data = { groups: [{ id: "g1", name: "工作", order: 0, nodes: [] }], nodes: {} };
      ensureAllBookmarksGroup(data);
      assert.equal(ensureAllBookmarksGroup(data), false);
      const proxyId = getLegacyGroupFolderId("g1");
      assert.equal(data.nodes[proxyId].type, "folder");
      assert.deepEqual(data.groups[0].nodes, [proxyId]);
      assert.equal(data.groups.length, 1);
    });

    it("derives the left sidebar by filtering bookmarks out of the all root", () => {
      const data = {
        groups: [
          { id: ALL_BOOKMARKS_GROUP_ID, name: "全部", order: -1, nodes: ["item1", "folder1", "item2", "folder2"] },
        ],
        nodes: {
          item1: { id: "item1", type: "item" },
          folder1: { id: "folder1", type: "folder", children: [] },
          item2: { id: "item2", type: "item" },
          folder2: { id: "folder2", type: "folder", children: [] },
        },
      };
      assert.deepEqual(getRootFolderNodeIds(data), ["folder1", "folder2"]);
    });

    it("merges imported nodes and folder children into the single root without creating groups", () => {
      const target = {
        groups: [{ id: ALL_BOOKMARKS_GROUP_ID, name: "全部", order: -1, nodes: ["local", "folder"] }],
        nodes: {
          local: { id: "local", type: "item", title: "本机" },
          folder: { id: "folder", type: "folder", title: "本机文件夹", children: ["local"] },
        },
      };
      const incoming = {
        groups: [{ id: ALL_BOOKMARKS_GROUP_ID, name: "全部", order: -1, nodes: ["folder", "remote"] }],
        nodes: {
          folder: { id: "folder", type: "folder", title: "云端文件夹", children: ["remote"] },
          remote: { id: "remote", type: "item", title: "导入" },
        },
      };

      assert.equal(mergeRootBookmarkData(target, incoming), true);
      assert.deepEqual(
        target.groups.map((group) => group.id),
        [ALL_BOOKMARKS_GROUP_ID],
      );
      assert.deepEqual(target.groups[0].nodes, ["local", "folder", "remote"]);
      assert.deepEqual(target.nodes.folder.children, ["local", "remote"]);
      assert.equal(target.nodes.folder.title, "本机文件夹");
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
