import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { httpHealth, httpPullState, httpPushState } from "../src/js/sync_http_transport.js";
import { hashSyncDocument } from "../src/js/sync_projection.js";

import { startSyncServer, stopSyncServer } from "./helpers/sync-server.js";

const TOKEN = "test-token";

function makeDoc(docId = "doc_test") {
  const doc = {
    schema: "homepage.sync.doc.v1",
    schemaVersion: 1,
    docId,
    revision: 1,
    deviceId: "dev_test",
    writtenAt: Date.now(),
    contentHash: "",
    settings: { syncEnabled: true },
    groups: [{ id: "g1", name: "G", order: 0, updatedAt: 1, updatedBy: "dev_test" }],
    nodes: [
      {
        id: "n1",
        type: "item",
        title: "T",
        url: "https://example.com/",
        iconType: "auto",
        updatedAt: 1,
        updatedBy: "dev_test",
      },
    ],
    placements: [
      {
        nodeId: "n1",
        parentKind: "group",
        parentId: "g1",
        index: 0,
        updatedAt: 1,
        updatedBy: "dev_test",
      },
    ],
  };
  doc.contentHash = hashSyncDocument(doc);
  return doc;
}

async function putRaw(baseUrl, doc, token = TOKEN, headers = {}) {
  const response = await fetch(`${baseUrl}/v1/sync/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(doc),
  });
  return { response, body: await response.json() };
}

describe("sync_http_transport + server", () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let tempDir = "";
  let BASE = "";

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-http-test."));
    const server = await startSyncServer({ dataFile: path.join(tempDir, "state.json") });
    child = server.child;
    BASE = server.baseUrl;
  });

  after(async () => {
    await stopSyncServer(child);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("404 when empty then put/get roundtrip", async () => {
    const empty = await httpPullState({ baseUrl: BASE, token: TOKEN });
    assert.equal(empty.reason, "no_remote");
    const doc = makeDoc();
    const put = await httpPushState({ baseUrl: BASE, token: TOKEN }, doc);
    assert.equal(put.ok, true, JSON.stringify(put));
    assert.ok(put.revision >= 1);
    const got = await httpPullState({ baseUrl: BASE, token: TOKEN });
    assert.equal(got.ok, true);
    assert.equal(got.doc.docId, "doc_test");
    assert.equal(got.doc.nodes[0].url, "https://example.com/");
  });

  it("rejects bad token", async () => {
    const res = await httpPullState({ baseUrl: BASE, token: "wrong" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unauthorized");
  });

  it("rejects malformed collections, dangling placements, and content hash mismatches", async () => {
    const invalidCollections = makeDoc("doc_invalid_collections");
    invalidCollections.groups = {};
    invalidCollections.contentHash = hashSyncDocument(invalidCollections);
    const collectionsResult = await putRaw(BASE, invalidCollections);
    assert.equal(collectionsResult.response.status, 400);
    assert.equal(collectionsResult.body.error, "invalid_collections");

    const danglingPlacement = makeDoc("doc_dangling_placement");
    danglingPlacement.placements[0].parentId = "missing_group";
    danglingPlacement.contentHash = hashSyncDocument(danglingPlacement);
    const placementResult = await putRaw(BASE, danglingPlacement);
    assert.equal(placementResult.response.status, 400);
    assert.equal(placementResult.body.error, "invalid_placement_parent");

    const hashMismatch = makeDoc("doc_hash_mismatch");
    hashMismatch.nodes[0].title = "tampered after hashing";
    const hashResult = await putRaw(BASE, hashMismatch);
    assert.equal(hashResult.response.status, 400);
    assert.equal(hashResult.body.error, "invalid_content_hash");
  });

  it("includes the endpoint in a network error", async () => {
    const unavailable = "http://127.0.0.1:1";
    const res = await httpHealth({ baseUrl: unavailable, token: TOKEN });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "network_error");
    assert.match(res.error || "", /http:\/\/127\.0\.0\.1:1\/health/);
  });

  it("does not advance revision for a repeated idempotency key", async () => {
    const current = await httpPullState({ baseUrl: BASE, token: TOKEN });
    assert.equal(current.ok, true);
    const key = "same-operation";
    const doc = makeDoc("doc_idempotent");
    const first = await httpPushState({ baseUrl: BASE, token: TOKEN }, doc, {
      ifMatch: current.etag,
      idempotencyKey: key,
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const repeated = await httpPushState({ baseUrl: BASE, token: TOKEN }, doc, {
      ifMatch: current.etag,
      idempotencyKey: key,
    });
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.revision, first.revision);
    const after = await httpPullState({ baseUrl: BASE, token: TOKEN });
    assert.equal(after.revision, first.revision);
  });

  it("retries successfully after a real network outage", async () => {
    // 持有端口并主动断开连接，制造真实网络错误，不访问任何未知服务。
    const outage = createServer((socket) => socket.destroy());
    await new Promise((resolve) => outage.listen(0, "127.0.0.1", resolve));
    const retryPort = outage.address().port;
    const retryBase = `http://127.0.0.1:${retryPort}`;
    const retryDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-retry-test."));
    let retryServer = null;
    try {
      const doc = makeDoc("doc_network_retry");
      const unavailable = await httpPushState({ baseUrl: retryBase, token: TOKEN }, doc, {
        idempotencyKey: "network-retry",
      });
      assert.equal(unavailable.ok, false);
      assert.equal(unavailable.reason, "network_error");

      await new Promise((resolve) => outage.close(resolve));
      ({ child: retryServer } = await startSyncServer({
        dataFile: path.join(retryDir, "state.json"),
        port: retryPort,
      }));
      const retried = await httpPushState({ baseUrl: retryBase, token: TOKEN }, doc, {
        idempotencyKey: "network-retry",
      });
      assert.equal(retried.ok, true, JSON.stringify(retried));
      const repeated = await httpPushState({ baseUrl: retryBase, token: TOKEN }, doc, {
        idempotencyKey: "network-retry",
      });
      assert.equal(repeated.revision, retried.revision);
    } finally {
      if (outage.listening) await new Promise((resolve) => outage.close(resolve));
      await stopSyncServer(retryServer);
      await rm(retryDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent writes so memory and disk finish at the same revision", async () => {
    let baseUrl;
    const concurrentDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-concurrent-test."));
    const dataFile = path.join(concurrentDir, "state.json");
    let concurrentServer = null;
    try {
      ({ child: concurrentServer, baseUrl } = await startSyncServer({ dataFile }));

      const writes = Array.from({ length: 24 }, (_, index) => {
        const doc = makeDoc(`doc_concurrent_${index}`);
        doc.settings.concurrentMarker = `${index}:${"x".repeat(index % 2 === 0 ? 80_000 : 8)}`;
        doc.contentHash = hashSyncDocument(doc);
        return httpPushState({ baseUrl, token: TOKEN }, doc);
      });
      const results = await Promise.all(writes);
      assert.equal(
        results.every((result) => result.ok),
        true,
        JSON.stringify(results),
      );
      const revisions = results.map((result) => result.revision).sort((a, b) => a - b);
      assert.deepEqual(
        revisions,
        Array.from({ length: results.length }, (_, index) => index + 1),
      );

      const memory = await httpPullState({ baseUrl, token: TOKEN });
      const disk = JSON.parse(await readFile(dataFile, "utf8"));
      assert.equal(memory.ok, true);
      assert.equal(disk.revision, memory.revision);
      assert.equal(disk.etag, memory.etag);
      assert.deepEqual(disk.doc, memory.doc);
    } finally {
      await stopSyncServer(concurrentServer);
      await rm(concurrentDir, { recursive: true, force: true });
    }
  });

  it("keeps the published state unchanged when persistence fails", async () => {
    let baseUrl;
    const failureDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-save-failure-test."));
    const dataFile = path.join(failureDir, "state.json");
    let failureServer = null;
    try {
      ({ child: failureServer, baseUrl } = await startSyncServer({ dataFile }));
      const baselineWrite = await httpPushState({ baseUrl, token: TOKEN }, makeDoc("doc_before_failure"));
      assert.equal(baselineWrite.ok, true);
      const before = await httpPullState({ baseUrl, token: TOKEN });
      const diskBefore = await readFile(dataFile, "utf8");

      await chmod(failureDir, 0o500);
      const failed = await httpPushState({ baseUrl, token: TOKEN }, makeDoc("doc_after_failure"));
      assert.equal(failed.ok, false);
      assert.equal(failed.status, 500);
      const after = await httpPullState({ baseUrl, token: TOKEN });
      assert.equal(after.revision, before.revision);
      assert.equal(after.etag, before.etag);
      assert.equal(after.doc.docId, "doc_before_failure");
      assert.equal(await readFile(dataFile, "utf8"), diskBefore);
    } finally {
      await chmod(failureDir, 0o700).catch(() => {});
      await stopSyncServer(failureServer);
      await rm(failureDir, { recursive: true, force: true });
    }
  });

  it("does not load a malformed persisted document after restart", async () => {
    let baseUrl;
    const persistedDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-invalid-disk-test."));
    const dataFile = path.join(persistedDir, "state.json");
    let persistedServer = null;
    try {
      const malformed = makeDoc("doc_malformed_disk");
      malformed.groups = {};
      malformed.contentHash = hashSyncDocument(malformed);
      await writeFile(
        dataFile,
        JSON.stringify({ revision: 7, etag: "stale", updatedAt: Date.now(), doc: malformed }),
        "utf8",
      );
      ({ child: persistedServer, baseUrl } = await startSyncServer({ dataFile }));
      const empty = await httpPullState({ baseUrl, token: TOKEN });
      assert.equal(empty.reason, "no_remote");
    } finally {
      await stopSyncServer(persistedServer);
      await rm(persistedDir, { recursive: true, force: true });
    }
  });
});
