/**
 * 同步服务端安全与历史快照回归测试：
 * 1. 常量时间 Bearer 主令牌比对（大小写 Bearer 与多余空白兼容，错误令牌拒收）；
 * 2. 滑动窗口限流（authFail 401 冷却触发 429 + Retry-After；/v1/sync/pair 限流；/health 不受阻）；
 * 3. ALLOWED_ORIGINS CORS 白名单（允许/拒绝 Origin、OPTIONS 预检 403、默认 * 向后兼容）；
 * 4. MAX_HISTORY_SNAPSHOTS 写前滚动历史快照保留最近 N 份旧状态。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultData } from "../src/js/storage.js";
import { hashSyncDocument, toSyncDocument } from "../src/js/sync_projection.js";

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

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function startIsolatedServer(envOverrides = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-sec-"));
  const port = await freePort();
  const dataFile = path.join(tmpDir, "sync-state.json");
  const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_FILE: dataFile,
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(ready, "sync-server failed to start in time");
  return { child, baseUrl, tmpDir, dataFile };
}

function makeDoc(revision = 1, title = `书签-${revision}`) {
  const data = defaultData();
  const nodeId = `itm_${revision}`;
  data.nodes[nodeId] = {
    id: nodeId,
    type: "item",
    title,
    url: `https://example.com/${revision}`,
    updatedAt: Date.now(),
    updatedBy: "dev_sec_test",
  };
  data.groups[0].nodes.push(nodeId);
  const doc = toSyncDocument(data, {
    deviceId: "dev_sec_test",
    docId: "doc_sec_test",
    revision,
    writtenAt: Date.now(),
  });
  doc.contentHash = hashSyncDocument(doc);
  return doc;
}

describe("sync-server security & snapshots", () => {
  const cleanups = [];

  afterEach(async () => {
    while (cleanups.length) {
      const { child, tmpDir } = cleanups.pop();
      await stopServer(child);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("verifies Bearer master token with constant-time compare and rejects mismatches", async () => {
    const srv = await startIsolatedServer({ TOKEN: "SuperSecretToken_2026!" });
    cleanups.push(srv);

    const exact = await fetch(`${srv.baseUrl}/v1/sync/state`, {
      headers: { Authorization: "bearer   SuperSecretToken_2026!  " },
    });
    assert.equal(exact.status, 404);

    for (const wrong of ["SuperSecretToken_2026?", "short", "SuperSecretToken_2026!extra", ""]) {
      const res = await fetch(`${srv.baseUrl}/v1/sync/state`, {
        headers: wrong ? { Authorization: `Bearer ${wrong}` } : {},
      });
      assert.equal(res.status, 401);
    }
  });

  it("rate limits repeated auth failures and pair endpoint with 429 + Retry-After", async () => {
    const srv = await startIsolatedServer({
      TOKEN: "rate-limit-token",
      RATE_LIMIT_RPM: "3",
      PAIR_RATE_LIMIT_RPM: "2",
    });
    cleanups.push(srv);

    for (let i = 0; i < 3; i += 1) {
      const failRes = await fetch(`${srv.baseUrl}/v1/sync/state`, {
        headers: { Authorization: "Bearer wrong" },
      });
      assert.equal(failRes.status, 401);
    }

    const blocked = await fetch(`${srv.baseUrl}/v1/sync/state`, {
      headers: { Authorization: "Bearer rate-limit-token" },
    });
    assert.equal(blocked.status, 429);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.error, "rate_limited");

    const health = await fetch(`${srv.baseUrl}/health`);
    assert.equal(health.status, 200);

    // 另一台独立实例验证 pair 限流（避免复用上面被 authFail 冷却的实例）
    const pairSrv = await startIsolatedServer({
      TOKEN: "pair-limit-token",
      RATE_LIMIT_RPM: "10",
      PAIR_RATE_LIMIT_RPM: "2",
    });
    cleanups.push(pairSrv);

    for (let i = 1; i <= 2; i += 1) {
      const pairOk = await fetch(`${pairSrv.baseUrl}/v1/sync/pair`, {
        method: "POST",
        headers: {
          Authorization: "Bearer pair-limit-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deviceId: `dev_${i}`, deviceName: `Device ${i}` }),
      });
      assert.equal(pairOk.status, 200);
    }

    const pairBlocked = await fetch(`${pairSrv.baseUrl}/v1/sync/pair`, {
      method: "POST",
      headers: {
        Authorization: "Bearer pair-limit-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deviceId: "dev_3", deviceName: "Device 3" }),
    });
    assert.equal(pairBlocked.status, 429);
    assert.ok(Number(pairBlocked.headers.get("retry-after")) >= 1);
  });

  it("enforces ALLOWED_ORIGINS whitelist when configured and defaults to wildcard", async () => {
    const restricted = await startIsolatedServer({
      TOKEN: "cors-token",
      ALLOWED_ORIGINS: "https://allowed.example, chrome-extension://ext123",
    });
    cleanups.push(restricted);

    const allowedPreflight = await fetch(`${restricted.baseUrl}/v1/sync/state`, {
      method: "OPTIONS",
      headers: { Origin: "chrome-extension://ext123" },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), "chrome-extension://ext123");
    assert.equal(allowedPreflight.headers.get("vary"), "Origin");

    const deniedPreflight = await fetch(`${restricted.baseUrl}/v1/sync/state`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(deniedPreflight.status, 403);
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);

    const deniedGet = await fetch(`${restricted.baseUrl}/health`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(deniedGet.status, 200);
    assert.equal(deniedGet.headers.get("access-control-allow-origin"), null);

    const openCors = await startIsolatedServer({ TOKEN: "cors-open-token" });
    cleanups.push(openCors);
    const wildcard = await fetch(`${openCors.baseUrl}/health`, {
      headers: { Origin: "https://any.example" },
    });
    assert.equal(wildcard.headers.get("access-control-allow-origin"), "*");
  });

  it("retains bounded rolling pre-overwrite history snapshots under .snapshots", async () => {
    const srv = await startIsolatedServer({
      TOKEN: "snap-token",
      MAX_HISTORY_SNAPSHOTS: "2",
    });
    cleanups.push(srv);

    for (let rev = 1; rev <= 4; rev += 1) {
      const putRes = await fetch(`${srv.baseUrl}/v1/sync/state`, {
        method: "PUT",
        headers: {
          Authorization: "Bearer snap-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(makeDoc(rev)),
      });
      assert.equal(putRes.status, 200);
    }

    const snapDir = path.join(srv.tmpDir, ".snapshots");
    const files = (await readdir(snapDir)).sort();
    assert.equal(files.length, 2);

    const revisions = [];
    for (const file of files) {
      const snap = JSON.parse(await readFile(path.join(snapDir, file), "utf8"));
      revisions.push(snap.revision);
    }
    assert.deepEqual(revisions, [2, 3]);
  });

  it("lists snapshots (master-only) and restores atomically with validation and epoch bump", async () => {
    const srv = await startIsolatedServer({
      TOKEN: "restore-token",
      MAX_HISTORY_SNAPSHOTS: "3",
    });
    cleanups.push(srv);

    const docWithTitle = (rev, title) => {
      const base = makeDoc(rev);
      base.nodes = [
        { id: `n_${rev}`, type: "item", title, url: `https://${rev}.example/`, updatedAt: rev, updatedBy: "dev_sec" },
      ];
      base.placements = [
        {
          nodeId: `n_${rev}`,
          parentKind: "group",
          parentId: "grp_all",
          index: 0,
          updatedAt: rev,
          updatedBy: "dev_sec",
        },
      ];
      base.contentHash = hashSyncDocument(base);
      return base;
    };

    for (const [rev, title] of [
      [1, "First"],
      [2, "Second"],
      [3, "Third"],
    ]) {
      const putRes = await fetch(`${srv.baseUrl}/v1/sync/state`, {
        method: "PUT",
        headers: { Authorization: "Bearer restore-token", "Content-Type": "application/json" },
        body: JSON.stringify(docWithTitle(rev, title)),
      });
      assert.equal(putRes.status, 200);
    }

    // 鉴权与入参防护检查
    assert.equal((await fetch(`${srv.baseUrl}/v1/sync/snapshots`)).status, 401);

    const listRes = await fetch(`${srv.baseUrl}/v1/sync/snapshots`, {
      headers: { Authorization: "Bearer restore-token" },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.ok, true);
    assert.equal(listBody.snapshots.length, 2);
    const targetSnap = listBody.snapshots.find((s) => s.revision === 1);
    assert.ok(targetSnap);
    assert.equal(targetSnap.encrypted, false);

    // 路径穿越、缺 confirm 与不存在的快照必须被安全拒绝
    const traversal = await fetch(`${srv.baseUrl}/v1/sync/snapshots/restore`, {
      method: "POST",
      headers: { Authorization: "Bearer restore-token", "Content-Type": "application/json" },
      body: JSON.stringify({ id: "../state.json", confirm: "RESTORE" }),
    });
    assert.equal(traversal.status, 400);
    assert.equal((await traversal.json()).error, "invalid_snapshot_id");

    const noConfirm = await fetch(`${srv.baseUrl}/v1/sync/snapshots/restore`, {
      method: "POST",
      headers: { Authorization: "Bearer restore-token", "Content-Type": "application/json" },
      body: JSON.stringify({ id: targetSnap.id }),
    });
    assert.equal(noConfirm.status, 400);

    const missing = await fetch(`${srv.baseUrl}/v1/sync/snapshots/restore`, {
      method: "POST",
      headers: { Authorization: "Bearer restore-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        id: targetSnap.id.replace(/\d+-\d+\.json$/, "999999999999999-9999.json"),
        confirm: "RESTORE",
      }),
    });
    assert.equal(missing.status, 404);

    // 回滚到 revision=1 快照
    const restoreRes = await fetch(`${srv.baseUrl}/v1/sync/snapshots/restore`, {
      method: "POST",
      headers: { Authorization: "Bearer restore-token", "Content-Type": "application/json" },
      body: JSON.stringify({ id: targetSnap.id, confirm: "RESTORE" }),
    });
    assert.equal(restoreRes.status, 200);
    const restoreBody = await restoreRes.json();
    assert.equal(restoreBody.ok, true);
    assert.equal(restoreBody.revision, 4);
    assert.equal(restoreBody.epoch, 1);

    const stateAfter = await (
      await fetch(`${srv.baseUrl}/v1/sync/state`, { headers: { Authorization: "Bearer restore-token" } })
    ).json();
    assert.equal(stateAfter.doc.nodes[0].title, "First");
  });
});
