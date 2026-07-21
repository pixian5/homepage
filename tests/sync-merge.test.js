import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportSyncBundle, importSyncBundle } from "../src/js/sync_bundle.js";
import { _setDeviceIdForTests, createDocId } from "../src/js/sync_ids.js";
import { mergeHomepage, mergeNode, mergePlacements, newerField } from "../src/js/sync_merge.js";
import { SYNC_TOTAL_SOFT_BYTES, normalizeSyncInterval, syncBytesBudgetLevel, syncIntervalToMs } from "../src/js/sync_policy.js";
import { estimateSyncProjectionBytes, hashSyncDocument, toSyncDocument } from "../src/js/sync_projection.js";

function baseData(overrides = {}) {
  return {
    schemaVersion: 1,
    settings: { language: "zh-CN", syncEnabled: true, showSearch: true },
    groups: [{ id: "g1", name: "默认", order: 0, nodes: ["n1"], updatedAt: 1000, updatedBy: "dev_a" }],
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
      groups: [{ id: "g1", name: "默认", order: 0, nodes: ["n2"], updatedAt: 2000, updatedBy: "dev_b" }],
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
    const g = result.state.groups.find((x) => x.id === "g1");
    assert.ok(g.nodes.includes("n1"));
    assert.ok(g.nodes.includes("n2"));
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
      groups: [{ id: "g1", name: "默认", order: 0, nodes: [], updatedAt: 3000, updatedBy: "dev_b" }],
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
    assert.equal(result.state.nodes.n1, undefined);
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
});

describe("sync_bundle", () => {
  it("export/import roundtrip merges", () => {
    _setDeviceIdForTests("dev_test");
    const local = baseData();
    const other = baseData({
      groups: [{ id: "g1", name: "默认", order: 0, nodes: ["n9"], updatedAt: 4000, updatedBy: "dev_c" }],
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
