import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { httpHealth, httpPullState, httpPushState } from "../src/js/sync_http_transport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token";

function makeDoc(docId = "doc_test") {
  return {
    schema: "homepage.sync.doc.v1",
    schemaVersion: 1,
    docId,
    revision: 1,
    deviceId: "dev_test",
    writtenAt: Date.now(),
    contentHash: "abc",
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
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await httpHealth({ baseUrl, token: TOKEN });
    if (health.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("sync_http_transport + server", () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let tempDir = "";

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-http-test."));
    child = spawn(process.execPath, [path.join(root, "scripts/sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        TOKEN,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(await waitForHealth(BASE), true, "server did not start");
  });

  after(async () => {
    await stopServer(child);
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
    const retryPort = 18788;
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

      retryServer = spawn(process.execPath, [path.join(root, "scripts/sync-server.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          PORT: String(retryPort),
          HOST: "127.0.0.1",
          TOKEN,
          DATA_FILE: path.join(retryDir, "state.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(await waitForHealth(retryBase), true, "retry server did not start");
      const retried = await httpPushState({ baseUrl: retryBase, token: TOKEN }, doc, {
        idempotencyKey: "network-retry",
      });
      assert.equal(retried.ok, true, JSON.stringify(retried));
      const repeated = await httpPushState({ baseUrl: retryBase, token: TOKEN }, doc, {
        idempotencyKey: "network-retry",
      });
      assert.equal(repeated.revision, retried.revision);
    } finally {
      await stopServer(retryServer);
      await rm(retryDir, { recursive: true, force: true });
    }
  });
});
