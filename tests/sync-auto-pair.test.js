/**
 * 同步引擎自动配对与退役熔断（P1 收尾）端到端测试：
 * 1. 配置 Master Token 且本地无凭据时，pull 前自动调用 /v1/sync/pair，
 *    secret 写入 settings.syncDeviceSecret（含签发时的服务器地址），后续读写走 Device 凭据；
 * 2. 设备被管理员退役后：pull/push 立即收到 device_retired，状态熔断、不进 outbox 重试；
 * 3. 恢复激活后同步自动恢复；
 * 4. 凭据失配（服务器重建）时 401 自动清凭据，下一轮用 Master Token 重新配对自愈。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultData } from "../src/js/storage.js";
import { getOutboxSummary, getSyncStatus, initSyncEngine, pullNow, pushNow } from "../src/js/sync_engine.js";
import { httpHealth, httpRetireDevice } from "../src/js/sync_http_transport.js";
import { _setDeviceIdForTests } from "../src/js/sync_ids.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "auto-pair-token";
const DEVICE_ID = "dev_autopair";

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

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 800)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

describe("sync engine auto pairing & retire circuit breaker", () => {
  let baseUrl = "";
  let child = null;
  let tempDir = "";
  /** 引擎使用的内存数据（getData 返回同一引用，配对写入直接可见） */
  let data = null;

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-auto-pair."));
    const port = await freePort();
    child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
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
    baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if ((await httpHealth({ baseUrl, token: TOKEN })).ok) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("sync server did not become ready");
  });

  after(async () => {
    await stopServer(child);
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function resetEngineData() {
    data = defaultData();
    data.settings = {
      ...data.settings,
      syncEnabled: true,
      syncServerUrl: baseUrl,
      syncServerToken: TOKEN,
      syncInterval: "off",
    };
    initSyncEngine({
      getData: () => data,
      setData: (next) => {
        data = next;
      },
      saveLocal: async () => null,
    });
  }

  it("pairs automatically on first pull and uses device credentials", async () => {
    _setDeviceIdForTests(DEVICE_ID);
    resetEngineData();
    assert.equal(data.settings.syncDeviceSecret, undefined, "初始不应有设备凭据");

    const pull = await pullNow("test_pair");
    assert.equal(pull?.ok, true, `pull 失败: ${JSON.stringify(pull)}`);

    // 自动配对已把凭据写入 settings（内存 + saveLocal 持久化由 hook 捕获）
    const secret = data.settings.syncDeviceSecret;
    assert.match(String(secret), /^[0-9a-f]{64}$/, "配对应写入 64 位 hex deviceSecret");
    assert.equal(data.settings.syncDeviceSecretUrl, baseUrl, "凭据应绑定签发时的服务器地址");

    // 服务端设备表已登记本设备（证明 pair 请求真实发生）
    const devicesRes = await fetch(`${baseUrl}/v1/sync/devices`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const devicesBody = await devicesRes.json();
    const mine = devicesBody.devices.find((device) => device.deviceId === DEVICE_ID);
    assert.ok(mine, "服务端设备表应包含本设备");
    assert.ok(!("secretHash" in mine), "设备表不得泄露 secretHash");

    // 后续读写确实走 Device 凭据：本轮 pull（空库）触发的 push 已用 Device 头成功写入
    const stateRes = await fetch(`${baseUrl}/v1/sync/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const stateBody = await stateRes.json();
    assert.equal(stateBody.doc.deviceId, DEVICE_ID, "首次推送应由本设备完成");
  });

  it("circuit-breaks with device_retired status after admin retires this device", async () => {
    const retire = await httpRetireDevice({ baseUrl, token: TOKEN }, { deviceId: DEVICE_ID, retired: true });
    assert.equal(retire.ok, true);

    const pull = await pullNow("test_retired");
    assert.equal(pull?.ok, false);
    assert.equal(pull?.reason, "device_retired");

    const status = getSyncStatus();
    assert.equal(status.status, "device_retired");
    assert.match(status.lastError, /403/);
    assert.equal(status.lastError, "设备已被管理员注销 (403)");

    // push 同样被熔断，且不得把失败写入 outbox（否则会无限重试 403）
    const push = await pushNow("test_retired");
    assert.equal(push?.ok, false);
    assert.equal(push?.reason, "device_retired");
    assert.equal(getSyncStatus().status, "device_retired", "熔断状态不得被 push 覆盖");
    const outbox = await getOutboxSummary();
    assert.equal(outbox.length, 0, "退役失败不得进入 outbox 重试队列");
  });

  it("resumes syncing after the device is reactivated", async () => {
    const reactivate = await httpRetireDevice({ baseUrl, token: TOKEN }, { deviceId: DEVICE_ID, retired: false });
    assert.equal(reactivate.ok, true);

    const pull = await pullNow("test_reactivated");
    assert.equal(pull?.ok, true, `恢复后应能继续同步: ${JSON.stringify(pull)}`);
    assert.equal(getSyncStatus().status, "idle");
    assert.equal(getSyncStatus().lastError, "");
    // 恢复使用原有 Device 凭据（未重新配对）
    assert.equal(data.settings.syncDeviceSecret?.length, 64);
  });

  it("self-heals by re-pairing after credentials go stale (401)", async () => {
    // 模拟服务器数据重建：本地凭据与服务端登记失配
    const staleSecret = data.settings.syncDeviceSecret;
    data.settings.syncDeviceSecret = "0".repeat(64);
    data.settings.syncDeviceSecretUrl = baseUrl;

    const pull = await pullNow("test_stale");
    assert.equal(pull?.ok, false);
    assert.equal(pull?.reason, "unauthorized");
    // 失配凭据应被清除，为下一轮重新配对让路
    assert.equal(data.settings.syncDeviceSecret, undefined, "401 后应清除失配凭据");

    const healed = await pullNow("test_repairs");
    assert.equal(healed?.ok, true, `重新配对后应恢复同步: ${JSON.stringify(healed)}`);
    assert.match(data.settings.syncDeviceSecret, /^[0-9a-f]{64}$/);
    assert.notEqual(data.settings.syncDeviceSecret, staleSecret);
    assert.equal(getSyncStatus().status, "idle");
  });

  it("accepts a first write with a stale If-Match against the devices-only placeholder state", async () => {
    // 回归：换新服务器时，配对会先建立「只有设备表、doc 为 null」的占位状态；
    // 客户端可能还留着旧服务器的 etag。占位状态没有文档，If-Match 不得触发 412，
    // 否则 412 响应带不回 remote.doc，客户端重试耗尽永远写不进新库。
    // 用独立空库实例验证（本套件共享的服务器已有真实文档，If-Match 不匹配时 412 才是正确行为）
    const port = 24000 + (process.pid % 2000);
    const freshBase = `http://127.0.0.1:${port}`;
    const freshDir = await mkdtemp(path.join(os.tmpdir(), "homepage-auto-pair-fresh."));
    const freshChild = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN,
        DATA_FILE: path.join(freshDir, "state.json"),
      },
      stdio: "ignore",
    });
    try {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await httpHealth({ baseUrl: freshBase, token: TOKEN })).ok) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const pair = await fetch(`${freshBase}/v1/sync/pair`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: "dev_fresh_server" }),
      });
      assert.equal(pair.status, 200);

      const { hashSyncDocument, toSyncDocument } = await import("../src/js/sync_projection.js");
      const doc = toSyncDocument(defaultData(), {
        deviceId: "dev_fresh_server",
        docId: "doc_fresh_server",
        revision: 1,
        writtenAt: Date.now(),
      });
      doc.contentHash = hashSyncDocument(doc);
      const put = await fetch(`${freshBase}/v1/sync/state`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          // 模拟来自其它服务器的陈旧 etag
          "If-Match": '"etag-from-another-server"',
        },
        body: JSON.stringify(doc),
      });
      assert.equal(put.status, 200, `占位状态下的首写不应被 If-Match 拦截: ${await put.text()}`);
    } finally {
      await stopServer(freshChild);
      await rm(freshDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
