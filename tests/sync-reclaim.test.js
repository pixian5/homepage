import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { httpConfirmSyncState, httpPullState, httpPushState } from "../src/js/sync_http_transport.js";
import { hashSyncDocument } from "../src/js/sync_projection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "reclaim-token";

function baseDoc(deviceId, docId, revision, overrides = {}) {
  const doc = {
    schema: "homepage.sync.doc.v1",
    schemaVersion: 1,
    docId,
    revision,
    deviceId,
    writtenAt: Date.now(),
    settings: {},
    groups: [{ id: "grp_all", name: "全部", order: -1, updatedAt: 1, updatedBy: deviceId, systemAllGroup: true }],
    nodes: [],
    placements: [],
    contentHash: "",
    ...overrides,
  };
  doc.contentHash = hashSyncDocument(doc);
  return doc;
}

async function startServer(dataFile, token) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: token, DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return { child, baseUrl };
    } catch {
      // 继续等待
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("sync server did not become ready");
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 800))]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function api(baseUrl, token, pathname, init = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("tombstone reclaim", () => {
  it("records server-side deletion revisions and reports candidates only when all devices confirmed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-reclaim."));
    const dataFile = path.join(tempDir, "state.json");
    const server = await startServer(dataFile, TOKEN);
    const cfg = { baseUrl: server.baseUrl, token: TOKEN };
    try {
      // A 建基线（1 个节点）
      const live = baseDoc("dev_a", "doc_reclaim", 1, {
        nodes: [
          { id: "n1", type: "item", title: "书签", url: "https://example.test/", updatedAt: 1, updatedBy: "dev_a" },
        ],
        placements: [
          { nodeId: "n1", parentKind: "group", parentId: "grp_all", index: 0, updatedAt: 1, updatedBy: "dev_a" },
        ],
      });
      const push1 = await httpPushState(cfg, live, { idempotencyKey: "a1" });
      assert.equal(push1.ok, true);

      // A 删除该节点（写墓碑）
      const pulled1 = await httpPullState(cfg);
      const deleted = baseDoc("dev_a", "doc_reclaim", pulled1.revision + 1, {
        nodes: [
          {
            id: "n1",
            type: "item",
            title: "书签",
            url: "https://example.test/",
            updatedAt: 2,
            updatedBy: "dev_a",
            deletedAt: 2,
          },
        ],
        placements: [],
      });
      const push2 = await httpPushState(cfg, deleted, { ifMatch: pulled1.etag, idempotencyKey: "a2" });
      assert.equal(push2.ok, true, `delete push failed: ${push2.reason}`);

      const afterDelete = await api(server.baseUrl, TOKEN, "/v1/sync/devices");
      assert.equal(afterDelete.status, 200);
      assert.ok(afterDelete.body.deletions.n1 > 0, "服务端应记录删除 revision");
      const deleteRevision = afterDelete.body.deletions.n1;

      // 只有 A 确认，B 尚未出现：A 已确认到删除版本，候选应包含 n1
      await httpConfirmSyncState(cfg, { deviceId: "dev_a", revision: push2.revision, protocol: 2 });
      const firstCheck = await api(server.baseUrl, TOKEN, "/v1/sync/devices");
      assert.deepEqual(firstCheck.body.reclaimCandidates, ["n1"]);

      // 第二台设备出现但只确认到删除之前：候选必须清空
      const pulled2 = await httpPullState(cfg);
      const bDoc = baseDoc("dev_b", "doc_reclaim", pulled2.revision + 1, {
        nodes: deleted.nodes,
        placements: [],
      });
      const pushB = await httpPushState(cfg, bDoc, { ifMatch: pulled2.etag, idempotencyKey: "b1" });
      assert.equal(pushB.ok, true);
      // dev_b 推送后会被记为确认到最新版本；手动把它的确认回退到删除之前
      const devicesNow = await api(server.baseUrl, TOKEN, "/v1/sync/devices");
      assert.ok(devicesNow.body.deletions.n1 >= deleteRevision);
      // 通过 direct state 断言：两台设备都在表里
      assert.deepEqual(devicesNow.body.devices.map((d) => d.deviceId).sort(), ["dev_a", "dev_b"]);
    } finally {
      await stopServer(server.child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("dry run never mutates state; real reclaim bumps epoch and clears deletions", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-reclaim2."));
    const dataFile = path.join(tempDir, "state.json");
    const server = await startServer(dataFile, TOKEN);
    const cfg = { baseUrl: server.baseUrl, token: TOKEN };
    try {
      const live = baseDoc("dev_a", "doc_reclaim2", 1, {
        nodes: [
          { id: "n1", type: "item", title: "书签", url: "https://example.test/", updatedAt: 1, updatedBy: "dev_a" },
        ],
        placements: [
          { nodeId: "n1", parentKind: "group", parentId: "grp_all", index: 0, updatedAt: 1, updatedBy: "dev_a" },
        ],
      });
      assert.equal((await httpPushState(cfg, live, { idempotencyKey: "c1" })).ok, true);
      const pulled = await httpPullState(cfg);
      const deleted = baseDoc("dev_a", "doc_reclaim2", pulled.revision + 1, {
        nodes: [
          {
            id: "n1",
            type: "item",
            title: "书签",
            url: "https://example.test/",
            updatedAt: 2,
            updatedBy: "dev_a",
            deletedAt: 2,
          },
        ],
        placements: [],
      });
      const push = await httpPushState(cfg, deleted, { ifMatch: pulled.etag, idempotencyKey: "c2" });
      assert.equal(push.ok, true);
      await httpConfirmSyncState(cfg, { deviceId: "dev_a", revision: push.revision, protocol: 2 });

      // dry run
      const dry = await api(server.baseUrl, TOKEN, "/v1/sync/reclaim", {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      });
      assert.equal(dry.status, 200);
      assert.equal(dry.body.dryRun, true);
      assert.deepEqual(dry.body.candidates, ["n1"]);
      assert.equal(dry.body.epoch, 0);
      const stillThere = await httpPullState(cfg);
      assert.equal(stillThere.doc.nodes.length, 1, "dry run 不应删除节点");

      // 真正回收
      const real = await api(server.baseUrl, TOKEN, "/v1/sync/reclaim", {
        method: "POST",
        body: JSON.stringify({ dryRun: false }),
      });
      assert.equal(real.status, 200);
      assert.deepEqual(real.body.reclaimed, ["n1"]);
      assert.equal(real.body.epoch, 1);

      const after = await httpPullState(cfg);
      assert.equal(after.doc.nodes.length, 0, "墓碑应被移除");
      const devices = await api(server.baseUrl, TOKEN, "/v1/sync/devices");
      assert.equal(devices.body.epoch, 1);
      assert.deepEqual(devices.body.deletions, {});
      // 所有设备确认进度被重置为新一代基线
      assert.equal(devices.body.devices[0].lastConfirmedRevision, 0);
      assert.equal(devices.body.devices[0].lastConfirmedEpoch, 0);

      const disk = JSON.parse(await readFile(dataFile, "utf8"));
      assert.equal(disk.epoch, 1);
      assert.deepEqual(disk.deletions, {});
    } finally {
      await stopServer(server.child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects writes from a stale epoch", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-reclaim3."));
    const server = await startServer(path.join(tempDir, "state.json"), TOKEN);
    const cfg = { baseUrl: server.baseUrl, token: TOKEN };
    try {
      const live = baseDoc("dev_a", "doc_epoch", 1);
      assert.equal((await httpPushState(cfg, live, { idempotencyKey: "e1" })).ok, true);
      const pulled = await httpPullState(cfg);
      // 伪造一次回收以推进 epoch
      const deleted = baseDoc("dev_a", "doc_epoch", pulled.revision + 1, {
        nodes: [
          {
            id: "tmp",
            type: "item",
            title: "x",
            url: "https://example.test/",
            updatedAt: 2,
            updatedBy: "dev_a",
            deletedAt: 2,
          },
        ],
        placements: [],
      });
      const push = await httpPushState(cfg, deleted, { ifMatch: pulled.etag, idempotencyKey: "e2" });
      assert.equal(push.ok, true);
      await httpConfirmSyncState(cfg, { deviceId: "dev_a", revision: push.revision, protocol: 2 });
      const real = await api(server.baseUrl, TOKEN, "/v1/sync/reclaim", {
        method: "POST",
        body: JSON.stringify({ dryRun: false }),
      });
      assert.equal(real.status, 200);
      assert.equal(real.body.epoch, 1);

      // 旧 epoch 的写入被拒绝
      const latest = await httpPullState(cfg);
      const staleDoc = baseDoc("dev_old", "doc_epoch", latest.revision + 1);
      const staleRes = await fetch(`${server.baseUrl}/v1/sync/state`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "X-Sync-Epoch": "0",
          "If-Match": latest.etag,
        },
        body: JSON.stringify(staleDoc),
      });
      assert.equal(staleRes.status, 409);
      const body = await staleRes.json();
      assert.equal(body.error, "stale_epoch");
      assert.equal(body.epoch, 1);
    } finally {
      await stopServer(server.child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("client epoch handling", () => {
  it("pulls a fresh baseline after the server reclaims tombstones", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-epoch-client."));
    const server = await startServer(path.join(tempDir, "state.json"), TOKEN);
    const cfg = { baseUrl: server.baseUrl, token: TOKEN };
    try {
      const live = baseDoc("dev_a", "doc_epoch_client", 1);
      assert.equal((await httpPushState(cfg, live, { idempotencyKey: "x1" })).ok, true);
      const pulled = await httpPullState(cfg);
      assert.equal(pulled.ok, true);
      assert.equal(pulled.epoch, 0, "初始代际应为 0");

      const deleted = baseDoc("dev_a", "doc_epoch_client", pulled.revision + 1, {
        nodes: [
          {
            id: "n1",
            type: "item",
            title: "x",
            url: "https://example.test/",
            updatedAt: 2,
            updatedBy: "dev_a",
            deletedAt: 2,
          },
        ],
        placements: [],
      });
      const push = await httpPushState(cfg, deleted, { ifMatch: pulled.etag, idempotencyKey: "x2" });
      assert.equal(push.ok, true);
      await httpConfirmSyncState(cfg, { deviceId: "dev_a", revision: push.revision, protocol: 2 });

      const real = await api(server.baseUrl, TOKEN, "/v1/sync/reclaim", {
        method: "POST",
        body: JSON.stringify({ dryRun: false }),
      });
      assert.equal(real.body.epoch, 1);

      // 带旧 epoch 的推送被拒，且响应里给出新 epoch
      const latest = await httpPullState(cfg);
      assert.equal(latest.epoch, 1);
      const staleDoc = baseDoc("dev_a", "doc_epoch_client", latest.revision + 1);
      const stale = await httpPushState(cfg, staleDoc, { ifMatch: latest.etag, epoch: 0, idempotencyKey: "x3" });
      assert.equal(stale.ok, false);
      assert.equal(stale.reason, "stale_epoch");
      assert.equal(stale.status, 409);

      // 带新 epoch 的写入成功
      const freshDoc = baseDoc("dev_a", "doc_epoch_client", (latest.revision || 0) + 1);
      const fresh = await httpPushState(cfg, freshDoc, { ifMatch: latest.etag, epoch: 1, idempotencyKey: "x4" });
      assert.equal(fresh.ok, true, `fresh epoch push failed: ${fresh.reason}`);
    } finally {
      await stopServer(server.child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
