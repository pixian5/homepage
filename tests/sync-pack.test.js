import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSyncOutboxReady,
  normalizeSyncOutbox,
  removeSyncOutbox,
  SYNC_OUTBOX_TARGET,
  upsertSyncOutbox,
} from "../src/js/sync_outbox.js";
import { packSyncDocument, unpackSyncDocument } from "../src/js/sync_pack.js";
import { SYNC_OUTBOX_BASE_DELAY_MS } from "../src/js/sync_policy.js";
import { toSyncDocument } from "../src/js/sync_projection.js";

function sampleDoc() {
  return toSyncDocument(
    {
      schemaVersion: 1,
      settings: { language: "zh-CN", syncEnabled: true },
      groups: [{ id: "g1", name: "G", order: 0, nodes: ["n1"], updatedAt: 1 }],
      nodes: {
        n1: {
          id: "n1",
          type: "item",
          title: "T",
          url: "https://example.com/",
          iconType: "auto",
          iconData: "",
          color: "",
          updatedAt: 1,
        },
      },
      backups: [],
      lastUpdated: 1,
    },
    { deviceId: "dev_a", docId: "doc1", revision: 3, writtenAt: 100 },
  );
}

describe("sync_pack", () => {
  it("roundtrips small document in one shard", () => {
    const doc = sampleDoc();
    const packed = packSyncDocument(doc);
    assert.equal(packed.meta.shardCount, 1);
    assert.ok(packed.shards.homepage_sync_s0);
    const unpacked = unpackSyncDocument(packed.meta, packed.shards);
    assert.equal(unpacked.ok, true);
    assert.equal(unpacked.doc.docId, "doc1");
    assert.equal(unpacked.doc.nodes[0].url, "https://example.com/");
  });

  it("rejects incomplete shards", () => {
    const doc = sampleDoc();
    const packed = packSyncDocument(doc);
    const bad = unpackSyncDocument({ ...packed.meta, shardCount: 2 }, packed.shards);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "incomplete_remote");
  });
});

describe("sync_outbox", () => {
  it("keeps latest payload per target and schedules retry", () => {
    let box = [];
    box = upsertSyncOutbox(box, {
      targetKey: SYNC_OUTBOX_TARGET,
      payload: { a: 1 },
      error: null,
      resetAttempts: true,
      nowMs: 1000,
    });
    box = upsertSyncOutbox(box, {
      targetKey: SYNC_OUTBOX_TARGET,
      payload: { a: 2 },
      error: "fail",
      nowMs: 2000,
    });
    assert.equal(box.length, 1);
    assert.equal(box[0].payload.a, 2);
    assert.equal(box[0].attempts, 1);
    assert.ok(box[0].nextRetryAtMs >= 2000 + SYNC_OUTBOX_BASE_DELAY_MS);
    assert.equal(isSyncOutboxReady(box[0], 2000), false);
    assert.equal(isSyncOutboxReady(box[0], box[0].nextRetryAtMs), true);
    box = removeSyncOutbox(box, SYNC_OUTBOX_TARGET);
    assert.equal(box.length, 0);
  });

  it("normalize drops invalid rows", () => {
    const box = normalizeSyncOutbox([
      { targetKey: "", payload: {} },
      { targetKey: "x", payload: { v: 1 } },
    ]);
    assert.equal(box.length, 1);
  });
});
