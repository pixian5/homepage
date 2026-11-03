/**
 * 设备独立凭据（Device Credentials）端到端测试：
 * 1. POST /v1/sync/pair 用主管理 Token 配对并下发 deviceSecret；
 * 2. Device <id>:<secret> 凭据可正常 GET/PUT /v1/sync/state；
 * 3. 错误 deviceSecret 返回 401；
 * 4. 设备退役后其凭据读写立即 403 device_retired；
 * 5. GET /v1/sync/devices 绝不泄露 secretHash；
 * 6. GET /health 暴露 tombstoneCount / reclaimCandidatesCount；
 * 7. 全局 Bearer Token 始终保持管理员权限（向前兼容）。
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
import {
  httpGetDevices,
  httpHealth,
  httpPairDevice,
  httpPullState,
  httpPushState,
  httpRetireDevice,
} from "../src/js/sync_http_transport.js";
import { hashSyncDocument, toSyncDocument } from "../src/js/sync_projection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "device-auth-master-token";

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

/** 用项目投影生成服务端能通过的合法 SyncDocument */
function makeDoc(deviceId, extraNodes = []) {
  const doc = toSyncDocument(defaultData(), {
    deviceId,
    docId: "doc_device_auth",
    revision: 1,
    writtenAt: Date.now(),
  });
  for (const node of extraNodes) doc.nodes.push(node);
  doc.contentHash = hashSyncDocument(doc);
  return doc;
}

/** 一个已删除的节点：PUT 后会被服务端记入墓碑索引 */
function deletedNode(deviceId) {
  return {
    id: `node_tomb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "item",
    title: "将被删除的节点",
    url: "https://example.com/tombstone",
    updatedAt: Date.now(),
    updatedBy: deviceId,
    deletedAt: Date.now(),
  };
}

describe("sync server device credentials", () => {
  let baseUrl = "";
  let child = null;
  let tempDir = "";
  /** 各用例共享的设备凭据缓存 */
  const secrets = {};

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-device-auth."));
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

  const masterCfg = () => ({ baseUrl, token: TOKEN });
  const deviceCfg = (deviceId) => ({
    baseUrl,
    deviceId,
    deviceSecret: secrets[deviceId],
  });

  it("pairs a device with the master token and returns a one-time secret", async () => {
    // 此时尚无任何 PUT：pair 应建立只含设备表的占位状态
    const res = await httpPairDevice(masterCfg(), { deviceId: "dev_pair", deviceName: "测试 MacBook" });
    assert.equal(res.ok, true);
    assert.equal(res.deviceId, "dev_pair");
    // 32 字节随机数的 hex = 64 个十六进制字符
    assert.match(res.deviceSecret, /^[0-9a-f]{64}$/);
    secrets.dev_pair = res.deviceSecret;

    // 无 Token / 错 Token 的配对必须被拒绝
    const noToken = await httpPairDevice({ baseUrl }, { deviceId: "dev_evil" });
    assert.equal(noToken.ok, false);
    assert.equal(noToken.status, 401);
    const badToken = await httpPairDevice({ baseUrl, token: "wrong-token" }, { deviceId: "dev_evil" });
    assert.equal(badToken.ok, false);
    assert.equal(badToken.status, 401);
    // deviceId 缺失：客户端侧拦截
    const noId = await httpPairDevice(masterCfg(), { deviceId: "  " });
    assert.equal(noId.ok, false);
    assert.equal(noId.reason, "invalid_device_id");
  });

  it("allows device credentials to push and pull state", async () => {
    const paired = await httpPairDevice(masterCfg(), { deviceId: "dev_rw" });
    assert.equal(paired.ok, true);
    secrets.dev_rw = paired.deviceSecret;

    const cfg = deviceCfg("dev_rw");
    const push = await httpPushState(cfg, makeDoc("dev_rw"), {
      idempotencyKey: `dev_rw-${Date.now()}`,
    });
    assert.equal(push.ok, true);
    assert.ok(push.revision >= 1);

    const pull = await httpPullState(cfg);
    assert.equal(pull.ok, true);
    assert.equal(pull.doc.deviceId, "dev_rw");
  });

  it("rejects a wrong device secret with 401", async () => {
    const cfg = { baseUrl, deviceId: "dev_rw", deviceSecret: "0".repeat(64) };
    const pull = await httpPullState(cfg);
    assert.equal(pull.ok, false);
    assert.equal(pull.reason, "unauthorized");
    assert.equal(pull.status, 401);
    const push = await httpPushState(cfg, makeDoc("dev_rw"), { idempotencyKey: `bad-${Date.now()}` });
    assert.equal(push.ok, false);
    assert.equal(push.reason, "unauthorized");
    assert.equal(push.status, 401);
    // 未登记过的设备同样 401
    const unknown = await httpPullState({ baseUrl, deviceId: "dev_ghost", deviceSecret: "f".repeat(64) });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 401);
  });

  it("blocks a retired device with 403 device_retired immediately", async () => {
    const paired = await httpPairDevice(masterCfg(), { deviceId: "dev_retire", deviceName: "旧手机" });
    assert.equal(paired.ok, true);
    secrets.dev_retire = paired.deviceSecret;
    const cfg = deviceCfg("dev_retire");
    // 先正常写一次，确认退役前凭据可用
    assert.equal((await httpPushState(cfg, makeDoc("dev_retire"), { idempotencyKey: `r0-${Date.now()}` })).ok, true);

    // 管理员退役该设备
    const retire = await httpRetireDevice(masterCfg(), { deviceId: "dev_retire", retired: true });
    assert.equal(retire.ok, true);
    assert.equal(retire.retired, true);

    // 退役后读写立即 403 device_retired（transport 已解析为 reason=device_retired）
    const pull = await httpPullState(cfg);
    assert.equal(pull.ok, false);
    assert.equal(pull.reason, "device_retired");
    assert.equal(pull.status, 403);
    const push = await httpPushState(cfg, makeDoc("dev_retire"), { idempotencyKey: `r1-${Date.now()}` });
    assert.equal(push.ok, false);
    assert.equal(push.reason, "device_retired");
    assert.equal(push.status, 403);

    // 原始响应体也必须是 403 + error=device_retired（服务端契约，非 transport 包装）
    const raw = await fetch(`${baseUrl}/v1/sync/state`, {
      headers: { Authorization: `Device dev_retire:${secrets.dev_retire}` },
    });
    assert.equal(raw.status, 403);
    const body = await raw.json();
    assert.equal(body.error, "device_retired");
    assert.equal(body.deviceId, "dev_retire");
  });

  it("never leaks secretHash from the device list", async () => {
    const list = await httpGetDevices(masterCfg());
    assert.equal(list.ok, true);
    assert.ok(list.devices.length >= 3);
    for (const device of list.devices) {
      assert.equal("secretHash" in device, false, `设备 ${device.deviceId} 不应携带 secretHash`);
    }
    // 原始响应文本里连字段名都不应出现
    const raw = await fetch(`${baseUrl}/v1/sync/devices`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(raw.status, 200);
    const text = await raw.text();
    assert.equal(text.includes("secretHash"), false);
    // 配对时下发的 secret 明文也绝不能出现在设备表里
    assert.equal(text.includes(secrets.dev_pair), false);
  });

  it("exposes tombstoneCount and reclaimCandidatesCount in /health", async () => {
    // 推一个带已删除节点的文档，制造一条墓碑
    const push = await httpPushState(masterCfg(), makeDoc("dev_master", [deletedNode("dev_master")]), {
      idempotencyKey: `tomb-${Date.now()}`,
    });
    assert.equal(push.ok, true);

    const health = await httpHealth(masterCfg());
    assert.equal(health.ok, true);
    assert.equal(typeof health.body.tombstoneCount, "number");
    assert.equal(typeof health.body.reclaimCandidatesCount, "number");
    assert.ok(health.body.tombstoneCount >= 1, `墓碑计数应 >= 1，实际 ${health.body.tombstoneCount}`);
  });

  it("keeps the master bearer token as full admin (backward compatible)", async () => {
    // 管理员读写照常
    const pull = await httpPullState(masterCfg());
    assert.equal(pull.ok, true);
    const push = await httpPushState(masterCfg(), makeDoc("dev_master"), {
      ifMatch: pull.etag,
      idempotencyKey: `admin-${Date.now()}`,
    });
    assert.equal(push.ok, true);

    // 管理员可以继续配对新设备（本轮第二次签发）
    const second = await httpPairDevice(masterCfg(), { deviceId: "dev_second" });
    assert.equal(second.ok, true);
    assert.match(second.deviceSecret, /^[0-9a-f]{64}$/);

    // 管理员可执行退役演练等管理接口
    const drill = await fetch(`${baseUrl}/v1/sync/reclaim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(drill.status, 200);

    // 设备凭据不能调管理接口（防横向提权）：pair / retire / devices 全部 401
    const evilCfg = { baseUrl, deviceId: "dev_second", deviceSecret: second.deviceSecret };
    const pairAttempt = await httpPairDevice(evilCfg, { deviceId: "dev_pwned" });
    assert.equal(pairAttempt.ok, false);
    assert.equal(pairAttempt.status, 401);
    const retireAttempt = await httpRetireDevice(evilCfg, { deviceId: "dev_master", retired: true });
    assert.equal(retireAttempt.ok, false);
    assert.equal(retireAttempt.status, 401);
    const listAttempt = await httpGetDevices(evilCfg);
    assert.equal(listAttempt.ok, false);
    assert.equal(listAttempt.status, 401);
  });
});
