import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { hashSyncDocument, toSyncDocument } from "../src/js/sync_projection.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = "retire-test-token";

async function waitForHealth(baseUrl, token) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return;
    } catch {
      // 服务还没起来
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("同步服务未能在 10 秒内启动");
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 启动独立服务实例，返回工具函数 */
async function startServer() {
  const port = 31000 + (process.pid % 1000) + Math.floor(Math.random() * 500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-retire."));
  const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      TOKEN,
      DATA_FILE: path.join(tempDir, "state.json"),
    },
    stdio: "ignore",
  });
  await waitForHealth(baseUrl, TOKEN);
  const api = async (pathname, options = {}) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  };
  return { baseUrl, child, tempDir, api };
}

/** 用项目自带投影生成服务端能通过的合法 SyncDocument */
function makeDoc({ deviceId, revision = 1, nodes = [] }) {
  const data = {
    schemaVersion: 1,
    settings: { syncEnabled: false, backgroundType: "color" },
    groups: [
      { id: "grp_all", name: "全部", order: -1, nodes: nodes.map((n) => n.id), updatedAt: 1, updatedBy: deviceId },
    ],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    lastUpdated: Date.now(),
  };
  const doc = toSyncDocument(data, { deviceId, docId: "doc_retire_test", revision, writtenAt: Date.now() });
  doc.contentHash = hashSyncDocument(doc);
  return doc;
}

describe("设备退役", () => {
  it("retires a device, blocks its writes and confirmations, and unblocks reclaim", async () => {
    const server = await startServer();
    try {
      const { api } = server;

      // 两台设备各推一次，建立文档与设备表
      assert.equal(
        (await api("/v1/sync/state", { method: "PUT", body: JSON.stringify(makeDoc({ deviceId: "dev_a" })) })).status,
        200,
      );
      assert.equal(
        (
          await api("/v1/sync/state", {
            method: "PUT",
            body: JSON.stringify(makeDoc({ deviceId: "dev_b", revision: 2 })),
          })
        ).status,
        200,
      );

      let devices = await api("/v1/sync/devices");
      assert.equal(devices.body.devices.length, 2, "两台设备都应登记");
      assert.ok(
        devices.body.devices.every((d) => d.retiredAt === 0),
        "新设备默认未退役",
      );

      // 退役 dev_b
      const retire = await api("/v1/sync/devices/retire", {
        method: "POST",
        body: JSON.stringify({ deviceId: "dev_b" }),
      });
      assert.equal(retire.status, 200);
      assert.equal(retire.body.retired, true);

      devices = await api("/v1/sync/devices");
      const devB = devices.body.devices.find((d) => d.deviceId === "dev_b");
      assert.ok(devB.retiredAt > 0, "退役时间戳应被记录");

      // 退役设备写入被拒绝
      const blockedPut = await api("/v1/sync/state", {
        method: "PUT",
        body: JSON.stringify(makeDoc({ deviceId: "dev_b", revision: 3 })),
      });
      assert.equal(blockedPut.status, 403);
      assert.equal(blockedPut.body.error, "device_retired");

      // 退役设备确认被拒绝
      const blockedConfirm = await api("/v1/sync/confirm", {
        method: "POST",
        body: JSON.stringify({ deviceId: "dev_b", revision: 2 }),
      });
      assert.equal(blockedConfirm.status, 403);
      assert.equal(blockedConfirm.body.error, "device_retired");

      // 未退役设备仍然正常
      const okPut = await api("/v1/sync/state", {
        method: "PUT",
        body: JSON.stringify(makeDoc({ deviceId: "dev_a", revision: 4 })),
      });
      assert.equal(okPut.status, 200, "未退役设备不应被拦截");

      // 复职后可以恢复写入
      const revive = await api("/v1/sync/devices/retire", {
        method: "POST",
        body: JSON.stringify({ deviceId: "dev_b", retired: false }),
      });
      assert.equal(revive.status, 200);
      assert.equal(revive.body.retired, false);
      const afterRevive = await api("/v1/sync/state", {
        method: "PUT",
        body: JSON.stringify(makeDoc({ deviceId: "dev_b", revision: 5 })),
      });
      assert.equal(afterRevive.status, 200, "复职后应能再次写入");
    } finally {
      await stopServer(server.child);
      await rm(server.tempDir, { recursive: true, force: true });
    }
  });

  it("rejects retiring an unknown device and empty deviceId", async () => {
    const server = await startServer();
    try {
      const { api } = server;
      await api("/v1/sync/state", { method: "PUT", body: JSON.stringify(makeDoc({ deviceId: "dev_a" })) });

      const unknown = await api("/v1/sync/devices/retire", {
        method: "POST",
        body: JSON.stringify({ deviceId: "dev_does_not_exist" }),
      });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error, "device_not_found");

      const empty = await api("/v1/sync/devices/retire", {
        method: "POST",
        body: JSON.stringify({ deviceId: "  " }),
      });
      assert.equal(empty.status, 400);
      assert.equal(empty.body.error, "invalid_device_id");

      const noAuth = await fetch(`${server.baseUrl}/v1/sync/devices/retire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: "dev_a" }),
      });
      assert.equal(noAuth.status, 401, "退役属于管理操作，必须鉴权");
    } finally {
      await stopServer(server.child);
      await rm(server.tempDir, { recursive: true, force: true });
    }
  });

  it("excludes retired devices from reclaim candidate computation", async () => {
    const server = await startServer();
    try {
      const { api } = server;
      // dev_a 推一个删除（节点 n1 带 deletedAt → 服务端记 deletions）
      const docWithTombstone = makeDoc({
        deviceId: "dev_a",
        revision: 1,
        nodes: [{ id: "n1", type: "item", title: "x", url: "https://x.test/", deletedAt: Date.now() }],
      });
      assert.equal(
        (await api("/v1/sync/state", { method: "PUT", body: JSON.stringify(docWithTombstone) })).status,
        200,
      );

      // dev_b 只确认到 revision 0（用 confirm 而非 PUT：PUT 会顺带把它的确认推进到最新）
      assert.equal(
        (await api("/v1/sync/confirm", { method: "POST", body: JSON.stringify({ deviceId: "dev_b", revision: 0 }) }))
          .status,
        200,
      );

      let devices = await api("/v1/sync/devices");
      const before = devices.body.reclaimCandidates || [];
      assert.equal(before.length, 0, "dev_b 尚未确认到删除版本，不应出现候选");

      // 退役 dev_b：它不再参与判定，候选应出现
      await api("/v1/sync/devices/retire", { method: "POST", body: JSON.stringify({ deviceId: "dev_b" }) });
      devices = await api("/v1/sync/devices");
      assert.ok((devices.body.reclaimCandidates || []).includes("n1"), "退役设备被排除后，删除应进入可回收候选");
    } finally {
      await stopServer(server.child);
      await rm(server.tempDir, { recursive: true, force: true });
    }
  });
});
