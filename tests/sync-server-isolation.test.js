import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { startSyncServer, stopSyncServer } from "./helpers/sync-server.js";

it("端口已被健康服务占用时明确失败，不能误认成自己的服务", async () => {
  let requests = 0;
  const occupied = createServer((_req, res) => {
    requests++;
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(path.join(tmpdir(), "homepage-occupied-"));
  try {
    await assert.rejects(
      startSyncServer({ dataFile: path.join(dir, "state.json"), port: occupied.address().port }),
      /EADDRINUSE/,
    );
    assert.equal(requests, 0, "启动失败后不得向已有服务发送健康检查或写请求");
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

it("两个同时运行的测试服务使用不同端口，并能确认各自退出", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "homepage-parallel-"));
  const servers = [];
  try {
    // 两个服务同时存活，系统必须分配不同端口。
    servers.push(await startSyncServer({ dataFile: path.join(dir, "a.json") }));
    servers.push(await startSyncServer({ dataFile: path.join(dir, "b.json") }));
    assert.notEqual(servers[0].port, servers[1].port);
    assert.notEqual(servers[0].child.pid, servers[1].child.pid);
  } finally {
    for (const server of servers) {
      await stopSyncServer(server.child);
      assert.ok(server.child.exitCode !== null || server.child.signalCode);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
