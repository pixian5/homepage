import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markNodeDeleted, mergeRootBookmarkData } from "../src/js/data-utils.js";
import { exportSyncBundle, importSyncBundle } from "../src/js/sync_bundle.js";
import { _setDeviceIdForTests, createDocId } from "../src/js/sync_ids.js";
import { mergeHomepage, mergeNode, mergePlacements, newerField } from "../src/js/sync_merge.js";
import {
  normalizeSyncInterval,
  SYNC_TOTAL_SOFT_BYTES,
  syncBytesBudgetLevel,
  syncIntervalToMs,
} from "../src/js/sync_policy.js";
import {
  collectPlacementSnapshot,
  estimateSyncProjectionBytes,
  hashSyncDocument,
  stampChangedPlacementClock,
  syncDocumentToHomepageShape,
  toSyncDocument,
} from "../src/js/sync_projection.js";

function baseData(overrides = {}) {
  return {
    schemaVersion: 1,
    settings: { language: "zh-CN", syncEnabled: true, showSearch: true },
    groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["n1"], updatedAt: 1000, updatedBy: "dev_a" }],
    nodes: {
      n1: {
        id: "n1",
        type: "item",
        title: "A",
        url: "https://a.example/",
        iconType: "auto",
        iconData: "",
        color: "",
        updatedAt: 1000,
        updatedBy: "dev_a",
        createdAt: 1000,
      },
    },
    backups: [],
    lastUpdated: 1000,
    ...overrides,
  };
}

describe("sync_policy", () => {
  it("budget levels", () => {
    assert.equal(syncBytesBudgetLevel(0), "green");
    assert.equal(syncBytesBudgetLevel(SYNC_TOTAL_SOFT_BYTES), "yellow");
    assert.equal(syncBytesBudgetLevel(999999), "red");
  });

  it("sync interval normalize and ms", () => {
    assert.equal(normalizeSyncInterval("1h"), "1h");
    assert.equal(normalizeSyncInterval("nope"), "5m");
    assert.equal(syncIntervalToMs("off"), 0);
    assert.equal(syncIntervalToMs("1m"), 60_000);
    assert.equal(syncIntervalToMs("1h"), 3_600_000);
    assert.equal(syncIntervalToMs("1d"), 86_400_000);
  });
});

describe("newerField", () => {
  it("newer timestamp wins", () => {
    const r = newerField("old", 1, "dev_a", "new", 2, "dev_b");
    assert.equal(r.value, "new");
  });

  it("empty does not overwrite non-empty on tie", () => {
    const r = newerField("keep", 5, "dev_a", "", 5, "dev_b");
    assert.equal(r.value, "keep");
  });

  it("deviceId tie-break is deterministic", () => {
    const r = newerField("x", 5, "dev_a", "y", 5, "dev_z");
    assert.equal(r.value, "y");
  });
});

describe("toSyncDocument", () => {
  it("strips upload icon data and backups stay local-only", () => {
    const data = baseData({
      nodes: {
        n1: {
          id: "n1",
          type: "item",
          title: "A",
          url: "https://a.example/",
          iconType: "upload",
          iconData: "data:image/png;base64,aaaa",
          color: "",
          updatedAt: 1000,
        },
      },
      backups: [{ id: "b1", ts: 1, data: {} }],
      settings: {
        language: "zh-CN",
        syncEnabled: true,
        backgroundType: "custom",
        backgroundCustom: "data:image/png;base64,huge",
      },
    });
    const doc = toSyncDocument(data, { deviceId: "dev_a", docId: "doc1", revision: 1 });
    assert.equal(doc.schema, "homepage.sync.doc.v1");
    assert.equal(doc.nodes[0].iconType, "auto");
    assert.equal(doc.nodes[0].iconData, "");
    assert.equal(doc.settings.backgroundCustom, "");
    assert.ok(doc.placements.some((p) => p.nodeId === "n1" && p.parentKind === "group"));
    assert.equal(hashSyncDocument(doc), doc.contentHash);
  });

  it("projects settings clocks but never projects sync server token", () => {
    const data = baseData({
      settings: {
        language: "zh-CN",
        syncEnabled: true,
        syncTransport: "http",
        syncServerUrl: "https://sync.example",
        syncServerToken: "secret-token",
        theme: "dark",
      },
      _syncMeta: {
        settingsClock: {
          theme: { updatedAt: 3000, updatedBy: "dev_a" },
          syncServerToken: { updatedAt: 4000, updatedBy: "dev_a" },
        },
      },
    });
    const doc = toSyncDocument(data, { deviceId: "dev_a", docId: "doc1", revision: 1 });
    assert.equal(doc.settings.theme, "dark");
    assert.equal(doc.settings.syncEnabled, undefined);
    assert.equal(doc.settings.syncTransport, undefined);
    assert.equal(doc.settings.syncServerUrl, undefined);
    assert.equal(doc.settings.syncInterval, undefined);
    assert.equal(doc.settings.syncServerToken, undefined);
    assert.deepEqual(doc.settingsMeta.theme, { updatedAt: 3000, updatedBy: "dev_a" });
    assert.equal(doc.settingsMeta.syncServerToken, undefined);
  });

  it("roundtrips a real root folder and its children", () => {
    const data = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["folder"], updatedAt: 1000 }],
      nodes: {
        ...baseData().nodes,
        folder: {
          id: "folder",
          type: "folder",
          title: "工作",
          children: ["n1"],
          updatedAt: 1000,
        },
      },
    });
    const doc = toSyncDocument(data, { deviceId: "dev_a", docId: "doc1", revision: 1 });
    assert.ok(doc.placements.some((row) => row.nodeId === "folder" && row.parentId === "grp_all"));
    assert.ok(doc.placements.some((row) => row.nodeId === "n1" && row.parentId === "folder"));
    const restored = syncDocumentToHomepageShape(doc);
    assert.deepEqual(restored.groups[0].nodes, ["folder"]);
    assert.deepEqual(restored.nodes.folder.children, ["n1"]);
  });

  it("projects invisible group tombstones", () => {
    const data = baseData({
      _syncMeta: {
        groupTombstones: [{ id: "g0", name: "Deleted", order: 0, updatedAt: 3000, deletedAt: 3000 }],
      },
    });
    const doc = toSyncDocument(data, { deviceId: "dev_a", docId: "doc1", revision: 1, writtenAt: 4000 });
    assert.ok(doc.groups.some((group) => group.id === "g0" && group.deletedAt === 3000));
  });

  it("estimateSyncProjectionBytes returns positive size", () => {
    const n = estimateSyncProjectionBytes(baseData());
    assert.ok(n > 50);
  });
});

describe("mergeHomepage", () => {
  it("S8 empty remote does not wipe local", () => {
    const local = baseData();
    const remote = toSyncDocument(
      { schemaVersion: 1, settings: {}, groups: [], nodes: {}, backups: [], lastUpdated: 9999 },
      { deviceId: "dev_b", docId: "doc1", revision: 2, writtenAt: 9999 },
    );
    const result = mergeHomepage(local, remote, { deviceId: "dev_a" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "empty_remote");
    assert.equal(result.state.nodes.n1.title, "A");
  });

  it("S3 both sides add different nodes keeps both", () => {
    const local = baseData();
    const remoteData = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["n2"], updatedAt: 2000, updatedBy: "dev_b" }],
      nodes: {
        n2: {
          id: "n2",
          type: "item",
          title: "B",
          url: "https://b.example/",
          iconType: "auto",
          iconData: "",
          color: "",
          updatedAt: 2000,
          updatedBy: "dev_b",
          createdAt: 2000,
        },
      },
      lastUpdated: 2000,
    });
    // remote only has n2; merge with local n1
    const remote = toSyncDocument(remoteData, { deviceId: "dev_b", docId: "doc1", revision: 2, writtenAt: 2000 });
    // Fix remote placements: only n2 — local will contribute n1 via its projection inside merge
    const result = mergeHomepage(local, remote, { deviceId: "dev_a" });
    assert.equal(result.ok, true);
    assert.ok(result.state.nodes.n1);
    assert.ok(result.state.nodes.n2);
    const g = result.state.groups.find((x) => x.id === "grp_all");
    assert.ok(g.nodes.includes("n1"));
    assert.ok(g.nodes.includes("n2"));
  });

  it("keeps a moved node only in its newest parent", () => {
    const local = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["n1", "folder"], updatedAt: 1000 }],
      nodes: {
        ...baseData().nodes,
        folder: { id: "folder", type: "folder", title: "工作", children: [], updatedAt: 1000 },
      },
    });
    const remoteData = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["folder"], updatedAt: 2000 }],
      nodes: {
        ...baseData().nodes,
        folder: { id: "folder", type: "folder", title: "工作", children: ["n1"], updatedAt: 2100 },
      },
      lastUpdated: 2100,
    });
    const remote = toSyncDocument(remoteData, {
      deviceId: "dev_b",
      docId: "doc1",
      revision: 2,
      writtenAt: 2100,
    });

    const result = mergeHomepage(local, remote, { deviceId: "dev_a", now: 2200 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.state.groups[0].nodes, ["folder"]);
    assert.deepEqual(result.state.nodes.folder.children, ["n1"]);
  });

  it("does not revive an old position when the stale parent has an unrelated newer edit", () => {
    const item = baseData().nodes.n1;
    const folder = { id: "folder", type: "folder", title: "工作", children: ["n1"], updatedAt: 2000 };
    const local = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["folder"], updatedAt: 2000 }],
      nodes: { n1: item, folder },
      lastUpdated: 2000,
    });
    const beforeMove = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["n1", "folder"], updatedAt: 1000 }],
      nodes: { n1: item, folder: { ...folder, children: [], updatedAt: 1000 } },
    });
    stampChangedPlacementClock(local, collectPlacementSnapshot(beforeMove), {
      deviceId: "chrome",
      now: 2000,
    });

    const stale = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["n1", "folder", "other"], updatedAt: 3000 }],
      nodes: {
        n1: item,
        folder: { ...folder, children: [], updatedAt: 1000 },
        other: { id: "other", type: "item", title: "Other", url: "https://other.example/", updatedAt: 3000 },
      },
      lastUpdated: 3000,
    });
    stale._syncMeta = {
      placementClock: {
        n1: { parentKind: "group", parentId: "grp_all", index: 0, updatedAt: 1000, updatedBy: "firefox" },
        folder: { parentKind: "group", parentId: "grp_all", index: 1, updatedAt: 1000, updatedBy: "firefox" },
        other: { parentKind: "group", parentId: "grp_all", index: 2, updatedAt: 3000, updatedBy: "firefox" },
      },
    };
    const remote = toSyncDocument(stale, { deviceId: "firefox", docId: "doc1", revision: 2, writtenAt: 3000 });
    const result = mergeHomepage(local, remote, { deviceId: "chrome", now: 4000 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.state.groups[0].nodes, ["folder", "other"]);
    assert.deepEqual(result.state.nodes.folder.children, ["n1"]);
    assert.equal(result.state._syncMeta.placementClock.n1.parentId, "folder");
  });

  it("merges newer fields for existing IDs while add-only import keeps local fields", () => {
    const local = baseData();
    const incoming = baseData({
      nodes: { n1: { ...baseData().nodes.n1, title: "New", updatedAt: 5000, titleUpdatedAt: 5000 } },
      lastUpdated: 5000,
    });
    const addOnly = structuredClone(local);
    mergeRootBookmarkData(addOnly, structuredClone(incoming));
    assert.equal(addOnly.nodes.n1.title, "A");

    const remote = toSyncDocument(incoming, { deviceId: "import", docId: "doc-import", writtenAt: 5000 });
    const merged = mergeHomepage(local, remote, { deviceId: "local", now: 6000 });
    assert.equal(merged.state.nodes.n1.title, "New");
  });

  it("removes placement clocks for nodes that are no longer visible", () => {
    const data = baseData({
      _syncMeta: {
        placementClock: {
          n1: { parentKind: "group", parentId: "grp_all", index: 0, updatedAt: 1000, updatedBy: "dev_a" },
          deleted: { parentKind: "group", parentId: "grp_all", index: 1, updatedAt: 1000, updatedBy: "dev_a" },
        },
      },
    });
    stampChangedPlacementClock(data, collectPlacementSnapshot(data), { deviceId: "dev_a", now: 2000 });
    assert.deepEqual(Object.keys(data._syncMeta.placementClock), ["n1"]);
  });

  it("produces the same order regardless of merge direction", () => {
    const makeSide = (deviceId, nodeId) =>
      baseData({
        groups: [{ id: "grp_all", name: "全部", order: -1, nodes: [nodeId], updatedAt: 2000, updatedBy: deviceId }],
        nodes: {
          [nodeId]: {
            id: nodeId,
            type: "item",
            title: nodeId,
            url: `https://${nodeId}.example/`,
            updatedAt: 2000,
            updatedBy: deviceId,
            createdAt: 2000,
          },
        },
        lastUpdated: 2000,
      });
    const chrome = makeSide("chrome", "a");
    const firefox = makeSide("firefox", "b");
    const chromeDoc = toSyncDocument(chrome, { deviceId: "chrome", docId: "doc1", revision: 2, writtenAt: 2000 });
    const firefoxDoc = toSyncDocument(firefox, {
      deviceId: "firefox",
      docId: "doc1",
      revision: 2,
      writtenAt: 2000,
    });

    const onChrome = mergeHomepage(chrome, firefoxDoc, { deviceId: "chrome", now: 2100 });
    const onFirefox = mergeHomepage(firefox, chromeDoc, { deviceId: "firefox", now: 2100 });
    assert.equal(onChrome.ok, true);
    assert.equal(onFirefox.ok, true);
    assert.deepEqual(onChrome.state.groups[0].nodes, onFirefox.state.groups[0].nodes);
  });

  it("S4 delete tombstone wins over older live", () => {
    const local = baseData();
    const remoteData = baseData({
      nodes: {
        n1: {
          id: "n1",
          type: "item",
          title: "A",
          url: "https://a.example/",
          iconType: "auto",
          iconData: "",
          color: "",
          updatedAt: 500,
          deletedAt: 3000,
          updatedBy: "dev_b",
        },
      },
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: [], updatedAt: 3000, updatedBy: "dev_b" }],
      lastUpdated: 3000,
    });
    // force tombstone into projection by keeping deleted node in data.nodes
    const remote = toSyncDocument(
      {
        ...remoteData,
        nodes: remoteData.nodes,
        groups: remoteData.groups,
      },
      { deviceId: "dev_b", docId: "doc1", revision: 3, writtenAt: 3000 },
    );
    // toSyncDocument skips deleted from placements but keeps deleted nodes in nodes array — check
    assert.ok(remote.nodes.some((n) => n.id === "n1" && n.deletedAt));
    const result = mergeHomepage(local, remote, { deviceId: "dev_a" });
    assert.equal(result.ok, true);
    assert.equal(result.state.nodes.n1.deletedAt, 3000);
    assert.equal(result.state.groups[0].nodes.includes("n1"), false);
  });

  it("keeps a local delete tombstone when the remote still has the old live node", () => {
    const local = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: [], updatedAt: 3000, updatedBy: "dev_a" }],
      nodes: {
        n1: {
          id: "n1",
          type: "item",
          title: "A",
          url: "https://a.example/",
          iconType: "auto",
          updatedAt: 3000,
          deletedAt: 3000,
          updatedBy: "dev_a",
        },
      },
      lastUpdated: 3000,
    });
    const remote = toSyncDocument(baseData(), { deviceId: "dev_b", docId: "doc1", revision: 2, writtenAt: 2000 });
    const result = mergeHomepage(local, remote, { deviceId: "dev_a", now: 4000 });
    assert.equal(result.ok, true);
    assert.equal(result.state.nodes.n1.deletedAt, 3000);
    assert.equal(result.state.groups[0].nodes.includes("n1"), false);
  });

  it("keeps a deleted node deleted after the receiving device syncs it back", () => {
    const deletedOnChrome = baseData();
    markNodeDeleted(deletedOnChrome, "n1", 3000);
    deletedOnChrome.groups[0].nodes = [];
    deletedOnChrome.groups[0].updatedAt = 3000;
    const chromeDoc = toSyncDocument(deletedOnChrome, {
      deviceId: "chrome",
      docId: "doc1",
      revision: 2,
      writtenAt: 3000,
    });

    const firefoxResult = mergeHomepage(baseData(), chromeDoc, { deviceId: "firefox", now: 4000 });
    assert.equal(firefoxResult.ok, true);
    assert.equal(firefoxResult.state.nodes.n1.deletedAt, 3000);
    assert.equal(firefoxResult.state.groups[0].nodes.includes("n1"), false);

    const firefoxDoc = toSyncDocument(firefoxResult.state, {
      deviceId: "firefox",
      docId: "doc1",
      revision: 3,
      writtenAt: 4000,
    });
    assert.ok(firefoxDoc.nodes.some((node) => node.id === "n1" && node.deletedAt === 3000));

    const chromeResult = mergeHomepage(deletedOnChrome, firefoxDoc, { deviceId: "chrome", now: 5000 });
    assert.equal(chromeResult.ok, true);
    assert.equal(chromeResult.state.nodes.n1.deletedAt, 3000);
    assert.equal(chromeResult.state.groups[0].nodes.includes("n1"), false);
  });

  it("keeps a deleted group tombstone when the remote still has the old group", () => {
    const local = baseData({
      groups: [],
      nodes: {},
      _syncMeta: {
        groupTombstones: [{ id: "g1", name: "默认", order: 0, updatedAt: 3000, deletedAt: 3000, nodes: [] }],
      },
      lastUpdated: 3000,
    });
    const remote = toSyncDocument(baseData(), { deviceId: "dev_b", docId: "doc1", revision: 2, writtenAt: 2000 });
    const result = mergeHomepage(local, remote, { deviceId: "dev_a", now: 4000 });
    assert.equal(result.ok, true);
    assert.equal(
      result.state.groups.some((group) => group.id === "g1"),
      false,
    );
    assert.equal(result.state._syncMeta.groupTombstones[0].id, "g1");
  });

  it("newer title wins on same node", () => {
    const local = baseData();
    const remoteData = baseData({
      nodes: {
        n1: {
          id: "n1",
          type: "item",
          title: "RemoteTitle",
          url: "https://a.example/",
          iconType: "auto",
          iconData: "",
          color: "",
          updatedAt: 5000,
          titleUpdatedAt: 5000,
          updatedBy: "dev_b",
          createdAt: 1000,
        },
      },
      lastUpdated: 5000,
    });
    const remote = toSyncDocument(remoteData, { deviceId: "dev_b", docId: "doc1", revision: 4, writtenAt: 5000 });
    const result = mergeHomepage(local, remote, { deviceId: "dev_a" });
    assert.equal(result.ok, true);
    assert.equal(result.state.nodes.n1.title, "RemoteTitle");
  });

  it("remote bookmark update does not overwrite a newer local setting", () => {
    const local = baseData({
      settings: { language: "zh-CN", syncEnabled: true, showSearch: true, theme: "dark" },
      _syncMeta: {
        settingsClock: {
          theme: { updatedAt: 3000, updatedBy: "dev_a" },
        },
      },
    });
    const remoteData = baseData({
      settings: { language: "zh-CN", syncEnabled: true, showSearch: true, theme: "light" },
      _syncMeta: {
        settingsClock: {
          theme: { updatedAt: 1000, updatedBy: "dev_b" },
        },
      },
      nodes: {
        n1: {
          id: "n1",
          type: "item",
          title: "RemoteTitle",
          url: "https://a.example/",
          iconType: "auto",
          iconData: "",
          color: "",
          updatedAt: 5000,
          titleUpdatedAt: 5000,
          updatedBy: "dev_b",
          createdAt: 1000,
        },
      },
      lastUpdated: 5000,
    });
    const remote = toSyncDocument(remoteData, { deviceId: "dev_b", docId: "doc1", revision: 5, writtenAt: 5000 });
    const result = mergeHomepage(local, remote, { deviceId: "dev_a" });
    assert.equal(result.ok, true);
    assert.equal(result.state.nodes.n1.title, "RemoteTitle");
    assert.equal(result.state.settings.theme, "dark");
    assert.deepEqual(result.state._syncMeta.settingsClock.theme, { updatedAt: 3000, updatedBy: "dev_a" });
  });

  it("newer remote setting clock wins only for that setting", () => {
    const local = baseData({
      settings: { language: "zh-CN", syncEnabled: true, showSearch: true, theme: "dark", fontSize: 16 },
      _syncMeta: {
        settingsClock: {
          theme: { updatedAt: 1000, updatedBy: "dev_a" },
          fontSize: { updatedAt: 4000, updatedBy: "dev_a" },
        },
      },
    });
    const remoteData = baseData({
      settings: { language: "zh-CN", syncEnabled: true, showSearch: true, theme: "light", fontSize: 12 },
      _syncMeta: {
        settingsClock: {
          theme: { updatedAt: 5000, updatedBy: "dev_b" },
          fontSize: { updatedAt: 1000, updatedBy: "dev_b" },
        },
      },
      lastUpdated: 5000,
    });
    const remote = toSyncDocument(remoteData, { deviceId: "dev_b", docId: "doc1", revision: 6, writtenAt: 5000 });
    const result = mergeHomepage(local, remote, { deviceId: "dev_a" });
    assert.equal(result.ok, true);
    assert.equal(result.state.settings.theme, "light");
    assert.equal(result.state.settings.fontSize, 16);
  });

  it("legacy remote settings without clocks only fill missing keys", () => {
    const local = baseData({
      settings: { language: "zh-CN", syncEnabled: true, showSearch: true, theme: "dark" },
      _syncMeta: {
        settingsClock: {
          theme: { updatedAt: 3000, updatedBy: "dev_a" },
        },
      },
    });
    const remoteData = baseData({
      settings: { language: "zh-CN", syncEnabled: true, showSearch: false, theme: "light" },
      lastUpdated: 8000,
    });
    const remote = toSyncDocument(remoteData, { deviceId: "dev_b", docId: "doc1", revision: 7, writtenAt: 8000 });
    const result = mergeHomepage(local, remote, { deviceId: "dev_a" });
    assert.equal(result.ok, true);
    assert.equal(result.state.settings.theme, "dark");
    assert.equal(result.state.settings.showSearch, true);
  });

  it("purged rejects older live from other side", () => {
    const left = {
      id: "n1",
      type: "item",
      title: "gone",
      url: "https://a.example/",
      updatedAt: 100,
      purgedAt: 9000,
      updatedBy: "dev_a",
    };
    const right = {
      id: "n1",
      type: "item",
      title: "stale",
      url: "https://a.example/",
      updatedAt: 8000,
      updatedBy: "dev_b",
    };
    const m = mergeNode(left, right);
    assert.ok(m.purgedAt);
  });
});

describe("mergePlacements", () => {
  it("union placements from both sides", () => {
    const left = [{ nodeId: "n1", parentKind: "group", parentId: "g1", index: 0, updatedAt: 1, updatedBy: "a" }];
    const right = [{ nodeId: "n2", parentKind: "group", parentId: "g1", index: 1, updatedAt: 2, updatedBy: "b" }];
    const m = mergePlacements(left, right);
    assert.equal(m.length, 2);
  });

  it("selects one newest parent per node", () => {
    const oldPlacement = {
      nodeId: "n1",
      parentKind: "group",
      parentId: "grp_all",
      index: 0,
      updatedAt: 1000,
      updatedBy: "a",
    };
    const movedPlacement = {
      nodeId: "n1",
      parentKind: "folder",
      parentId: "folder",
      index: 0,
      updatedAt: 2000,
      updatedBy: "b",
    };

    assert.deepEqual(mergePlacements([oldPlacement], [movedPlacement]), [movedPlacement]);
    assert.deepEqual(mergePlacements([movedPlacement], [oldPlacement]), [movedPlacement]);
  });
});

describe("sync_bundle", () => {
  it("export/import roundtrip merges", () => {
    _setDeviceIdForTests("dev_test");
    const local = baseData();
    const other = baseData({
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["n9"], updatedAt: 4000, updatedBy: "dev_c" }],
      nodes: {
        n9: {
          id: "n9",
          type: "item",
          title: "Z",
          url: "https://z.example/",
          iconType: "auto",
          iconData: "",
          color: "",
          updatedAt: 4000,
          updatedBy: "dev_c",
          createdAt: 4000,
        },
      },
      lastUpdated: 4000,
    });
    const bundle = exportSyncBundle(other, { deviceId: "dev_c", docId: createDocId() });
    const result = importSyncBundle(local, bundle, { deviceId: "dev_a" });
    assert.equal(result.ok, true);
    assert.ok(result.state.nodes.n1);
    assert.ok(result.state.nodes.n9);
  });
});
