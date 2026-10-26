import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultData } from "../src/js/storage.js";
import { httpConfirmSyncState, httpHealth, httpPullState, httpPushState } from "../src/js/sync_http_transport.js";
import { toSyncDocument } from "../src/js/sync_projection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(dataFile, token) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TOKEN: token, DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if ((await httpHealth({ baseUrl, token })).ok) return { child, baseUrl };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("sync server did not become ready");
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 800)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function getDevices(baseUrl, token) {
  const res = await fetch(`${baseUrl}/v1/sync/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  return res.json();
}

function pushDoc(baseUrl, token, deviceId, docId, revision, ifMatch) {
  const doc = toSyncDocument(defaultData(), { deviceId, docId, revision, writtenAt: Date.now() });
  return httpPushState({ baseUrl, token }, doc, { ifMatch, idempotencyKey: `${deviceId}-${revision}-${Date.now()}` });
}

describe("sync server device table", () => {
  it("registers devices on push and persists them across restarts", async () => {
    const token = "device-table-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-device-table."));
    const dataFile = path.join(tempDir, "state.json");
    let server = await startServer(dataFile, token);
    try {
      const first = await pushDoc(server.baseUrl, token, "dev_a", "doc_table", 1);
      assert.equal(first.ok, true);

      const pulled = await httpPullState({ baseUrl: server.baseUrl, token });
      const second = await pushDoc(server.baseUrl, token, "dev_b", "doc_table", pulled.revision + 1, pulled.etag);
      assert.equal(second.ok, true);

      const devices = await getDevices(server.baseUrl, token);
      const ids = devices.devices.map((entry) => entry.deviceId).sort();
      assert.deepEqual(ids, ["dev_a", "dev_b"]);
      // 推送即视为持有该版本，应记录确认进度
      const confirmed = Object.fromEntries(
        devices.devices.map((entry) => [entry.deviceId, entry.lastConfirmedRevision]),
      );
      assert.equal(confirmed.dev_a, first.revision);
      assert.equal(confirmed.dev_b, second.revision);

      const health = await httpHealth({ baseUrl: server.baseUrl, token });
      assert.equal(health.deviceCount, 2);
      assert.equal(health.protocol, 2);

      // 落盘内容必须包含设备表
      const onDisk = JSON.parse(await readFile(dataFile, "utf8"));
      assert.deepEqual(Object.keys(onDisk.devices).sort(), ["dev_a", "dev_b"]);
      assert.equal(onDisk.epoch, 0);

      // 重启后设备表仍在
      await stopServer(server.child);
      server = await startServer(dataFile, token);
      const afterRestart = await getDevices(server.baseUrl, token);
      assert.deepEqual(afterRestart.devices.map((entry) => entry.deviceId).sort(), ["dev_a", "dev_b"]);
    } finally {
      await stopServer(server.child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts confirms up to the current revision and rejects future ones", async () => {
    const token = "device-confirm-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-device-confirm."));
    const server = await startServer(path.join(tempDir, "state.json"), token);
    try {
      const pushed = await pushDoc(server.baseUrl, token, "dev_x", "doc_confirm", 1);
      assert.equal(pushed.ok, true);

      const ok = await httpConfirmSyncState(
        { baseUrl: server.baseUrl, token },
        { deviceId: "dev_x", revision: pushed.revision, protocol: 2 },
      );
      assert.equal(ok.ok, true);
      assert.equal(ok.revision, pushed.revision);

      const ahead = await httpConfirmSyncState(
        { baseUrl: server.baseUrl, token },
        { deviceId: "dev_x", revision: pushed.revision + 10 },
      );
      assert.equal(ahead.ok, false);
      assert.equal(ahead.status, 409);

      const badDevice = await httpConfirmSyncState({ baseUrl: server.baseUrl, token }, { deviceId: "", revision: 1 });
      assert.equal(badDevice.ok, false);
      assert.equal(badDevice.status, 400);

      const devices = await getDevices(server.baseUrl, token);
      assert.equal(devices.devices.length, 1);
      assert.equal(devices.devices[0].lastConfirmedRevision, pushed.revision);
    } finally {
      await stopServer(server.child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps old state files working and adds an empty device table", async () => {
    const token = "device-legacy-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-device-legacy."));
    const dataFile = path.join(tempDir, "state.json");
    // 先用新服务生成一份状态，再手动删掉 devices/epoch 模拟旧文件
    let server = await startServer(dataFile, token);
    try {
      assert.equal((await pushDoc(server.baseUrl, token, "dev_old", "doc_legacy", 1)).ok, true);
    } finally {
      await stopServer(server.child);
    }
    const snapshot = JSON.parse(await readFile(dataFile, "utf8"));
    delete snapshot.devices;
    delete snapshot.epoch;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(dataFile, JSON.stringify(snapshot), "utf8"));

    server = await startServer(dataFile, token);
    try {
      const health = await httpHealth({ baseUrl: server.baseUrl, token });
      assert.equal(health.ok, true);
      assert.equal(health.epoch, 0);
      assert.equal(health.deviceCount, 0);
      const pulled = await httpPullState({ baseUrl: server.baseUrl, token });
      assert.equal(pulled.ok, true);
      assert.equal(pulled.revision, snapshot.revision);
      await rm(tempDir, { recursive: true, force: true });
    } finally {
      await stopServer(server.child);
    }
  });
});
