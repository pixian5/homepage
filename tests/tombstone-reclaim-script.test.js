/**
 * 墓碑回收常态化脚本（scripts/run-tombstone-reclaim.sh）测试：
 * - 演练（默认/--dry-run）：输出候选数量与详情、epoch，退出码 0，不产生回收；
 * - 执行（--force）：真正回收候选、递增 epoch，之后演练候选归零；
 * - 鉴权失败（TOKEN 错误）退出码 3；服务器不可达退出码 2；未知参数退出码 1。
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultData } from "../src/js/storage.js";
import { httpHealth } from "../src/js/sync_http_transport.js";
import { hashSyncDocument, toSyncDocument } from "../src/js/sync_projection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "reclaim-script-token";

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

/** 运行回收脚本，返回 { stdout, stderr, code } */
function runScript(args, env) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [path.join(root, "scripts", "run-tombstone-reclaim.sh"), ...args],
      { cwd: root, env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: error?.code ?? 0 }),
    );
  });
}

describe("run-tombstone-reclaim.sh", () => {
  let baseUrl = "";
  let child = null;
  let tempDir = "";

  before(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-reclaim-script."));
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

  /** 用主管理 Token 推一个带已删除节点的文档，制造一条可回收墓碑（推送设备自动确认） */
  async function pushTombstone(nodeId, revision) {
    const doc = toSyncDocument(defaultData(), {
      deviceId: "dev_ops",
      docId: "doc_reclaim_script",
      revision,
      writtenAt: Date.now(),
    });
    doc.nodes.push({
      id: nodeId,
      type: "item",
      title: "待回收节点",
      url: "https://gone.example.com/",
      updatedAt: Date.now(),
      updatedBy: "dev_ops",
      deletedAt: Date.now(),
    });
    doc.contentHash = hashSyncDocument(doc);
    const res = await fetch(`${baseUrl}/v1/sync/state`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    assert.equal(res.status, 200);
  }

  it("dry-run reports candidates and epoch without reclaiming", async () => {
    await pushTombstone("n_dry", 1);
    const result = await runScript(["--dry-run"], { SERVER_URL: baseUrl, TOKEN });
    assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /\[dry-run\] revision=\d+ epoch=\d+ 候选墓碑=1/);
    assert.match(result.stdout, /候选: n_dry/);
    assert.match(result.stdout, /\[health\].*墓碑=1 可回收=1/);
    assert.match(result.stdout, /\[devices\] 确认进度：/);
    assert.match(result.stdout, /演练完成/);

    // 演练不产生副作用：墓碑仍在
    const health = await httpHealth({ baseUrl, token: TOKEN });
    assert.equal(health.body.tombstoneCount, 1);
    assert.equal(health.body.reclaimCandidatesCount, 1);
  });

  it("force reclaims candidates, bumps epoch, and a follow-up dry-run shows zero", async () => {
    const before = await httpHealth({ baseUrl, token: TOKEN });
    const force = await runScript(["--force"], { SERVER_URL: baseUrl, TOKEN });
    assert.equal(force.code, 0, `stdout: ${force.stdout}\nstderr: ${force.stderr}`);
    assert.match(force.stdout, /\[force\] 已回收 1 条墓碑：revision \d+→\d+，epoch \d+→\d+/);

    const after = await httpHealth({ baseUrl, token: TOKEN });
    assert.equal(after.body.tombstoneCount, 0);
    assert.equal(after.body.reclaimCandidatesCount, 0);
    assert.ok(after.body.epoch > before.body.epoch, "epoch 必须递增");

    const again = await runScript([], { SERVER_URL: baseUrl, TOKEN });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /候选墓碑=0/);
    assert.doesNotMatch(again.stdout, /候选: /);
  });

  it("exits 3 on bad token and 2 when unreachable, 1 on unknown flag", async () => {
    const bad = await runScript(["--dry-run"], { SERVER_URL: baseUrl, TOKEN: "wrong-token" });
    assert.equal(bad.code, 3);
    assert.match(bad.stderr, /鉴权失败/);

    const unreachable = await runScript(["--dry-run"], { SERVER_URL: "http://127.0.0.1:1", TOKEN: "x" });
    assert.equal(unreachable.code, 2);
    assert.match(unreachable.stderr, /服务器不可达/);

    const badFlag = await runScript(["--nuke"], { SERVER_URL: baseUrl, TOKEN });
    assert.equal(badFlag.code, 1);
    assert.match(badFlag.stderr, /未知参数/);
  });
});
