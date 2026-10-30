import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cancelScheduledPush,
  initSyncEngine,
  isRemoteUpdateFromAnotherDevice,
  pullNow,
  pushNow,
  schedulePush,
} from "../src/js/sync_engine.js";
import { httpHealth, httpPullState, httpPushState } from "../src/js/sync_http_transport.js";
import { _setDeviceIdForTests } from "../src/js/sync_ids.js";
import { hashSyncDocument } from "../src/js/sync_projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function baseData(baseUrl, token) {
  return {
    schemaVersion: 1,
    settings: { syncEnabled: true, syncServerUrl: baseUrl, syncServerToken: token, syncInterval: "off" },
    groups: [
      { id: "grp_all", name: "全部", order: -1, nodes: ["n1"], updatedAt: 1, updatedBy: "dev_a", systemAllGroup: true },
    ],
    nodes: {
      n1: {
        id: "n1",
        type: "item",
        title: "Initial",
        url: "https://example.test/",
        iconType: "auto",
        updatedAt: 1,
        updatedBy: "dev_a",
      },
    },
    backups: [],
    lastUpdated: 1,
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

async function waitForHealth(baseUrl, token) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await httpHealth({ baseUrl, token })).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("sync engine test server did not start");
}

describe("sync_engine scheduling", () => {
  const originalClearTimeout = globalThis.clearTimeout;

  afterEach(() => {
    globalThis.clearTimeout = originalClearTimeout;
    cancelScheduledPush();
  });

  it("cancels a pending debounced push before manual synchronization", () => {
    let wasCleared = false;
    globalThis.clearTimeout = (timer) => {
      wasCleared = true;
      return originalClearTimeout(timer);
    };
    initSyncEngine({
      getData: () => ({ settings: { syncEnabled: true } }),
      setData: () => {},
      saveLocal: async () => null,
    });

    schedulePush();
    cancelScheduledPush();

    assert.equal(wasCleared, true);
  });
});

describe("sync_engine remote-device attribution", () => {
  it("does not report this device's pre-push pull as another device, but reports a real peer", async () => {
    const port = 23000 + (process.pid % 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = "sync-engine-test-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-engine-test."));
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN: token,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: "ignore",
    });

    try {
      await waitForHealth(baseUrl, token);
      let data = baseData(baseUrl, token);
      const merged = [];
      _setDeviceIdForTests("dev_a");
      initSyncEngine({
        getData: () => data,
        setData: (next) => {
          data = next;
        },
        saveLocal: async () => null,
        onMerged: async (_next, stats) => merged.push(stats),
      });

      const initial = await pushNow("initial");
      assert.equal(initial.ok, true);
      const firstRemote = await httpPullState({ baseUrl, token });
      assert.equal(firstRemote.ok, true);

      const sameDeviceDoc = structuredClone(firstRemote.doc);
      sameDeviceDoc.deviceId = "dev_a";
      sameDeviceDoc.nodes[0].title = "Written by this device";
      sameDeviceDoc.nodes[0].updatedAt = 2;
      sameDeviceDoc.nodes[0].titleUpdatedAt = 2;
      sameDeviceDoc.nodes[0].updatedBy = "dev_a";
      sameDeviceDoc.writtenAt = 2;
      sameDeviceDoc.contentHash = hashSyncDocument(sameDeviceDoc);
      const sameDeviceWrite = await httpPushState({ baseUrl, token }, sameDeviceDoc, { ifMatch: firstRemote.etag });
      assert.equal(sameDeviceWrite.ok, true);

      const selfPrePull = await pushNow("schedule");
      assert.equal(selfPrePull.ok, true);
      assert.equal(merged.at(-1)?.remoteNewer, false);
      assert.equal(merged.at(-1)?.remoteDeviceId, "dev_a");

      const afterSelf = await httpPullState({ baseUrl, token });
      assert.equal(afterSelf.ok, true);
      const peerDoc = structuredClone(afterSelf.doc);
      peerDoc.deviceId = "dev_b";
      peerDoc.nodes[0].title = "Written by another device";
      peerDoc.nodes[0].updatedAt = 3;
      peerDoc.nodes[0].titleUpdatedAt = 3;
      peerDoc.nodes[0].updatedBy = "dev_b";
      peerDoc.writtenAt = 3;
      peerDoc.contentHash = hashSyncDocument(peerDoc);
      const peerWrite = await httpPushState({ baseUrl, token }, peerDoc, { ifMatch: afterSelf.etag });
      assert.equal(peerWrite.ok, true);

      const peerPrePull = await pushNow("schedule");
      assert.equal(peerPrePull.ok, true);
      assert.equal(merged.at(-1)?.remoteNewer, true);
      assert.equal(merged.at(-1)?.remoteDeviceId, "dev_b");
    } finally {
      _setDeviceIdForTests("");
      await stopServer(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires a newer revision and a different known device id", () => {
    assert.equal(
      isRemoteUpdateFromAnotherDevice({
        previousRemoteRevision: 1,
        remoteRevision: 2,
        remoteDeviceId: "dev_a",
        deviceId: "dev_a",
      }),
      false,
    );
    assert.equal(
      isRemoteUpdateFromAnotherDevice({
        previousRemoteRevision: 1,
        remoteRevision: 2,
        remoteDeviceId: "dev_b",
        deviceId: "dev_a",
      }),
      true,
    );
    assert.equal(
      isRemoteUpdateFromAnotherDevice({
        previousRemoteRevision: 1,
        remoteRevision: 2,
        remoteDeviceId: "",
        deviceId: "dev_a",
      }),
      false,
    );
  });
});

describe("sync_engine conflict resolution", () => {
  it("preserves conflict context when local overwrite loses a concurrent 412 race", async () => {
    const port = 25000 + (process.pid % 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = "sync-engine-conflict-test-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-conflict-test."));
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN: token,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: "ignore",
    });
    const originalFetch = globalThis.fetch;

    try {
      await waitForHealth(baseUrl, token);
      const engine = await import(`../src/js/sync_engine.js?conflict=${Date.now()}`);
      let data = baseData(baseUrl, token);
      _setDeviceIdForTests("dev_conflict_local");
      engine.initSyncEngine({
        getData: () => data,
        setData: (next) => {
          data = next;
        },
        saveLocal: async () => null,
      });

      const initial = await engine.pushNow("initial_local");
      assert.equal(initial.ok, true);
      const localRemote = await httpPullState({ baseUrl, token });
      const conflicting = structuredClone(localRemote.doc);
      conflicting.docId = "doc_conflicting_remote";
      conflicting.deviceId = "dev_conflict_remote";
      conflicting.writtenAt += 1;
      conflicting.contentHash = hashSyncDocument(conflicting);
      const conflictWrite = await httpPushState({ baseUrl, token }, conflicting, { ifMatch: localRemote.etag });
      assert.equal(conflictWrite.ok, true);

      const detected = await engine.pullNow("detect_conflict");
      assert.equal(detected.reason, "doc_conflict");
      const pendingBefore = engine.getPendingConflict();
      assert.equal(pendingBefore.remoteDocId, "doc_conflicting_remote");

      let injectConcurrentWrite = true;
      globalThis.fetch = async (input, options = {}) => {
        const requestUrl = String(input);
        if (
          injectConcurrentWrite &&
          requestUrl === `${baseUrl}/v1/sync/state` &&
          (!options.method || options.method === "GET")
        ) {
          injectConcurrentWrite = false;
          const staleResponse = await originalFetch(input, options);
          const staleBody = await staleResponse.clone().json();
          const concurrent = structuredClone(staleBody.doc);
          concurrent.deviceId = "dev_concurrent_remote";
          concurrent.nodes[0].title = "Concurrent remote update";
          concurrent.nodes[0].updatedAt += 10;
          concurrent.nodes[0].titleUpdatedAt = concurrent.nodes[0].updatedAt;
          concurrent.writtenAt += 10;
          concurrent.contentHash = hashSyncDocument(concurrent);
          const competingResponse = await originalFetch(`${baseUrl}/v1/sync/state`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "If-Match": staleResponse.headers.get("ETag"),
            },
            body: JSON.stringify(concurrent),
          });
          assert.equal(competingResponse.status, 200);
          return staleResponse;
        }
        return originalFetch(input, options);
      };

      const resolved = await engine.resolveDocConflict("local");
      assert.deepEqual(resolved, { ok: false, reason: "precondition_failed" });
      const pendingAfter = engine.getPendingConflict();
      assert.ok(pendingAfter);
      assert.equal(pendingAfter.localDocId, pendingBefore.localDocId);
      assert.equal(pendingAfter.remoteDocId, "doc_conflicting_remote");
      assert.ok(pendingAfter.remoteRevision > pendingBefore.remoteRevision);
      assert.equal(engine.getSyncStatus().hasConflict, true);
    } finally {
      globalThis.fetch = originalFetch;
      _setDeviceIdForTests("");
      await stopServer(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sync_engine conflict persistence", () => {
  // 关键回归：冲突上下文原本只存在内存，刷新/新标签页后「解决冲突」会失效。
  async function startServer() {
    const port = 26000 + (process.pid % 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = "sync-engine-conflict-persist-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-conflict-persist."));
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN: token,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: "ignore",
    });
    await waitForHealth(baseUrl, token);
    return { baseUrl, token, tempDir, child };
  }

  function installStorageMock() {
    const store = {};
    globalThis.chrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (key in store) result[key] = structuredClone(store[key]);
            }
            callback(result);
          },
          set(obj, callback) {
            for (const [key, value] of Object.entries(obj)) store[key] = structuredClone(value);
            if (callback) callback();
          },
        },
        sync: {
          get(_k, cb) {
            if (cb) cb({});
          },
          set(_o, cb) {
            if (cb) cb();
          },
        },
      },
    };
    return store;
  }

  it("restores the pending conflict after a fresh page load", async () => {
    const { baseUrl, token, tempDir, child } = await startServer();
    const store = installStorageMock();
    try {
      const engine = await import(`../src/js/sync_engine.js?persist=${Date.now()}`);
      let data = baseData(baseUrl, token);
      _setDeviceIdForTests("dev_persist_local");
      engine.initSyncEngine({
        getData: () => data,
        setData: (n) => {
          data = n;
        },
        saveLocal: async () => null,
      });
      assert.equal((await engine.pushNow("initial")).ok, true);

      // 另一台设备换掉 docId，制造 doc_conflict
      const remote = await httpPullState({ baseUrl, token });
      const conflicting = structuredClone(remote.doc);
      conflicting.docId = "doc_persist_remote";
      conflicting.deviceId = "dev_persist_remote";
      conflicting.writtenAt += 1;
      conflicting.contentHash = hashSyncDocument(conflicting);
      assert.equal((await httpPushState({ baseUrl, token }, conflicting, { ifMatch: remote.etag })).ok, true);

      const detected = await engine.pullNow("detect");
      assert.equal(detected.reason, "doc_conflict");
      assert.equal(engine.getSyncStatus().hasConflict, true);

      // 状态必须写进存储，新页面才能恢复
      const saved = store.homepage_sync_state;
      assert.equal(saved.status, "need_setup");

      // 模拟更老的状态：只有 need_setup、没有冲突 docId，也要能自愈
      delete store.homepage_sync_state.conflictRemoteDocId;
      delete store.homepage_sync_state.conflictLocalDocId;

      // 模拟新标签页：重新加载模块（内存清空）后仅靠存储恢复
      const reloaded = await import(`../src/js/sync_engine.js?reload=${Date.now()}`);
      reloaded.initSyncEngine({
        getData: () => data,
        setData: (n) => {
          data = n;
        },
        saveLocal: async () => null,
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const pending = reloaded.getPendingConflict();
      assert.ok(pending, "刷新后应能恢复待处理冲突（老状态没有 docId 时也要可用）");
      assert.equal(reloaded.getSyncStatus().hasConflict, true);

      // 用恢复出来的上下文直接解决：合并应成功，且远端节点被并入
      const resolved = await reloaded.resolveDocConflict("merge");
      assert.equal(resolved.ok, true, `merge failed: ${resolved.reason}`);
      assert.equal(reloaded.getSyncStatus().hasConflict, false);
      assert.equal(reloaded.getSyncStatus().lastError, "", "解决后不应残留 doc_conflict");
      const after = await httpPullState({ baseUrl, token });
      assert.ok(Object.keys(after.doc.nodes).length >= 1);
    } finally {
      delete globalThis.chrome;
      _setDeviceIdForTests("");
      await stopServer(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sync_engine remote conflict branch", () => {
  // 回归：remote 分支若拿到 loadState 恢复的占位对象（只有 docId），
  // 曾会用空文档覆盖本地；必须重新拉取完整远端文档。
  it("replaces local with the real remote document after a fresh page load", async () => {
    const port = 27000 + (process.pid % 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = "sync-engine-remote-branch-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-remote-branch."));
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN: token,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: "ignore",
    });
    const store = {};
    globalThis.chrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (key in store) result[key] = structuredClone(store[key]);
            }
            callback(result);
          },
          set(obj, callback) {
            for (const [key, value] of Object.entries(obj)) store[key] = structuredClone(value);
            if (callback) callback();
          },
        },
        sync: {
          get(_k, cb) {
            if (cb) cb({});
          },
          set(_o, cb) {
            if (cb) cb();
          },
        },
      },
    };
    try {
      await waitForHealth(baseUrl, token);
      const engine = await import(`../src/js/sync_engine.js?remoteBranch=${Date.now()}`);
      let data = baseData(baseUrl, token);
      _setDeviceIdForTests("dev_remote_local");
      engine.initSyncEngine({
        getData: () => data,
        setData: (n) => {
          data = n;
        },
        saveLocal: async () => null,
      });
      assert.equal((await engine.pushNow("initial")).ok, true);

      // 云端换成另一个 docId，并只保留“云端书签”
      const remote = await httpPullState({ baseUrl, token });
      const cloud = structuredClone(remote.doc);
      cloud.docId = "doc_cloud_replace_test";
      cloud.deviceId = "cloud_device";
      // 服务端要求 nodes 是数组；客户端投影才会转成对象
      cloud.nodes = [
        {
          id: "cloud_only",
          type: "item",
          title: "仅云端书签",
          url: "https://example.invalid/cloud-only",
          iconType: "auto",
          updatedAt: Date.now(),
          updatedBy: "cloud_device",
        },
      ];
      cloud.groups = [{ id: "grp_all", name: "全部", order: -1, updatedAt: Date.now(), updatedBy: "cloud_device" }];
      cloud.placements = [
        {
          nodeId: "cloud_only",
          parentKind: "group",
          parentId: "grp_all",
          index: 0,
          updatedAt: Date.now(),
          updatedBy: "cloud_device",
        },
      ];
      cloud.revision = remote.revision + 1;
      cloud.writtenAt = Date.now();
      cloud.contentHash = hashSyncDocument(cloud);
      const cloudPush = await httpPushState({ baseUrl, token }, cloud, { ifMatch: remote.etag });
      assert.equal(cloudPush.ok, true, `cloud push failed: ${cloudPush.reason} ${cloudPush.error || ""}`);

      const conflict = await engine.pullNow("detect");
      assert.equal(conflict.reason, "doc_conflict");

      // 新页面：只靠存储恢复（占位对象）
      const reloaded = await import(`../src/js/sync_engine.js?remoteReload=${Date.now()}`);
      reloaded.initSyncEngine({
        getData: () => data,
        setData: (n) => {
          data = n;
        },
        saveLocal: async () => null,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const resolved = await reloaded.resolveDocConflict("remote");
      assert.equal(resolved.ok, true, `remote resolve failed: ${resolved.reason}`);
      assert.equal(resolved.choice, "remote");
      // 本地应被云端内容替换，而不是被空文档清空
      assert.ok(data.nodes.cloud_only, "云端节点应出现在本地");
      assert.equal(
        Object.values(data.nodes).some((n) => n.title === "Initial"),
        false,
        "旧本地书签应被替换",
      );
      assert.equal(reloaded.getSyncStatus().lastError, "");
    } finally {
      delete globalThis.chrome;
      _setDeviceIdForTests("");
      await stopServer(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sync_engine multi-tab conflict isolation", () => {
  // 回归：两个标签页各有独立引擎实例。一处解决冲突后，另一处若继续用旧 docId
  // 会重新判定冲突并把 need_setup 写回存储。
  it("does not resurrect a resolved conflict from a stale tab", async () => {
    const port = 28000 + (process.pid % 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = "sync-engine-multitab-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-multitab."));
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN: token,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: "ignore",
    });
    const store = {};
    globalThis.chrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (key in store) result[key] = structuredClone(store[key]);
            }
            callback(result);
          },
          set(obj, callback) {
            for (const [key, value] of Object.entries(obj)) store[key] = structuredClone(value);
            if (callback) callback();
          },
        },
        sync: {
          get(_k, cb) {
            if (cb) cb({});
          },
          set(_o, cb) {
            if (cb) cb();
          },
        },
      },
    };
    try {
      await waitForHealth(baseUrl, token);
      // 标签页 A
      const tabA = await import(`../src/js/sync_engine.js?tabA=${Date.now()}`);
      let data = baseData(baseUrl, token);
      _setDeviceIdForTests("dev_multitab");
      tabA.initSyncEngine({
        getData: () => data,
        setData: (n) => {
          data = n;
        },
        saveLocal: async () => null,
      });
      assert.equal((await tabA.pushNow("init")).ok, true);

      const remote = await httpPullState({ baseUrl, token });
      const cloud = structuredClone(remote.doc);
      cloud.docId = "doc_multitab_cloud";
      cloud.deviceId = "cloud";
      cloud.revision = remote.revision + 1;
      cloud.writtenAt = Date.now();
      cloud.contentHash = hashSyncDocument(cloud);
      assert.equal((await httpPushState({ baseUrl, token }, cloud, { ifMatch: remote.etag })).ok, true);
      assert.equal((await tabA.pullNow("detect")).reason, "doc_conflict");

      // 标签页 B：从存储加载，看到同一个冲突
      const tabB = await import(`../src/js/sync_engine.js?tabB=${Date.now()}`);
      tabB.initSyncEngine({
        getData: () => data,
        setData: (n) => {
          data = n;
        },
        saveLocal: async () => null,
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(tabB.getSyncStatus().hasConflict, true);

      // A 解决冲突
      const resolved = await tabA.resolveDocConflict("merge");
      assert.equal(resolved.ok, true, `resolve failed: ${resolved.reason}`);
      assert.equal(store.homepage_sync_state.status, "idle");

      // B 再次同步：必须先采纳存储里的新 docId，不能把冲突写回去
      await tabB.pushNow("stale-tab");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(store.homepage_sync_state.status, "idle", "旧标签页不应恢复已解决的冲突");
      assert.notEqual(store.homepage_sync_state.lastError, "doc_conflict");
    } finally {
      delete globalThis.chrome;
      _setDeviceIdForTests("");
      await stopServer(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sync_engine 412 retry", () => {
  // 关键回归（26.2.3）：412 重试必须采纳服务端新 etag，且推送合并后的最新本地快照。
  // 修复前：重试仍带旧 If-Match 必然再 412 直至耗尽（P1）；
  // 只修 etag 时：重试推的是合并前快照，会把并发方刚合并进来的变更从服务端抹掉（P2）。
  it("adopts the fresh etag from 412 and pushes the merged snapshot on retry", async () => {
    const port = 29000 + (process.pid % 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = "sync-engine-412-retry-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-412-retry."));
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN: token,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: "ignore",
    });
    const originalFetch = globalThis.fetch;

    try {
      await waitForHealth(baseUrl, token);
      // 独立模块实例：避免其它用例在模块级 _status 里留下的 docId 干扰
      const engine = await import(`../src/js/sync_engine.js?retry412=${Date.now()}`);
      let data = baseData(baseUrl, token);
      _setDeviceIdForTests("dev_retry_local");
      engine.initSyncEngine({
        getData: () => data,
        setData: (next) => {
          data = next;
        },
        saveLocal: async () => null,
      });

      const initial = await engine.pushNow("initial");
      assert.equal(initial.ok, true);
      const baseline = await httpPullState({ baseUrl, token });
      assert.equal(baseline.ok, true);

      // 基线之后本机改 n1 标题（与并发方新增的节点互不重叠，便于分别断言）
      const localEditAt = (baseline.doc.writtenAt || 0) + 100;
      data.nodes.n1.title = "Local edit after push";
      data.nodes.n1.updatedAt = localEditAt;
      data.nodes.n1.titleUpdatedAt = localEditAt;
      data.nodes.n1.updatedBy = "dev_retry_local";
      data.lastUpdated = localEditAt;

      const enginePuts = [];
      let injectedConcurrentWrite = false;
      globalThis.fetch = async (input, options = {}) => {
        const requestUrl = String(input);
        if (requestUrl !== `${baseUrl}/v1/sync/state`) return originalFetch(input, options);
        if (options.method === "PUT") {
          const headers = options.headers || {};
          if (!injectedConcurrentWrite) {
            // 引擎第一个 PUT 到达前，并发设备 B 在同一文档上新增节点 n_peer_added
            injectedConcurrentWrite = true;
            const concurrent = structuredClone(baseline.doc);
            concurrent.deviceId = "dev_b_concurrent";
            concurrent.writtenAt = (concurrent.writtenAt || 0) + 50;
            const peerAt = concurrent.writtenAt;
            concurrent.nodes.push({
              id: "n_peer_added",
              type: "item",
              title: "From peer",
              url: "https://peer.test/",
              iconType: "auto",
              updatedAt: peerAt,
              updatedBy: "dev_b_concurrent",
            });
            concurrent.placements.push({
              nodeId: "n_peer_added",
              parentKind: "group",
              parentId: concurrent.groups[0].id,
              index: concurrent.placements.length,
              updatedAt: peerAt,
              updatedBy: "dev_b_concurrent",
            });
            concurrent.contentHash = hashSyncDocument(concurrent);
            const competing = await originalFetch(requestUrl, {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "If-Match": baseline.etag,
              },
              body: JSON.stringify(concurrent),
            });
            assert.equal(competing.status, 200);
            const competingBody = await competing.json();
            // 引擎的这个 PUT 带着 rev1 的旧 etag，转发后必然 412
            const staleResponse = await originalFetch(input, options);
            assert.equal(staleResponse.status, 412);
            enginePuts.push({ first: true, ifMatch: headers["If-Match"], freshEtag: competingBody.etag });
            return staleResponse;
          }
          enginePuts.push({
            first: false,
            ifMatch: headers["If-Match"],
            idempotencyKey: headers["Idempotency-Key"],
            body: JSON.parse(options.body),
          });
        }
        return originalFetch(input, options);
      };

      const retried = await engine.pushNow("after_local_edit");
      // 断言①：412 后重试成功，而不是三次耗尽落 outbox
      assert.equal(retried.ok, true, `push failed: ${JSON.stringify(retried)}`);
      assert.equal(retried.revision, 3);
      assert.equal(enginePuts.length, 2);
      // 断言②：重试 PUT 携带 412 响应里的新 etag（P1）
      assert.equal(enginePuts[1].ifMatch, enginePuts[0].freshEtag);
      // 断言②补充：幂等键为稳定键 docId:revision:deviceId，不再含时间戳
      assert.equal(enginePuts[1].idempotencyKey, `${enginePuts[1].body.docId}:3:dev_retry_local`);
      // 断言③：服务端最终文档同时含本机标题修改与并发方新增节点（P2：推的是合并后快照）
      const finalState = await httpPullState({ baseUrl, token });
      assert.equal(finalState.ok, true);
      const finalN1 = finalState.doc.nodes.find((n) => n.id === "n1");
      const finalPeer = finalState.doc.nodes.find((n) => n.id === "n_peer_added");
      assert.equal(finalN1.title, "Local edit after push");
      assert.ok(finalPeer, "重试推送必须保留并发方新增的节点");
    } finally {
      globalThis.fetch = originalFetch;
      _setDeviceIdForTests("");
      await stopServer(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sync_engine no-op push", () => {
  // 回归：内容没变也写新 revision，多设备会「拉取→落盘→再推送」互相推高版本号，
  // 导致每次打开页面其它设备都判「有较新数据」，提示与流量被放大。
  it("skips the write when local content already equals remote, and pushes after a real change", async () => {
    const port = 28000 + (process.pid % 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = "sync-engine-noop-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-noop."));
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN: token,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: "ignore",
    });
    const store = {};
    globalThis.chrome = {
      runtime: { lastError: null },
      storage: {
        local: {
          get(keys, callback) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (key in store) result[key] = structuredClone(store[key]);
            }
            callback(result);
          },
          set(obj, callback) {
            for (const [key, value] of Object.entries(obj)) store[key] = structuredClone(value);
            if (callback) callback();
          },
        },
        sync: { get: (_k, cb) => cb?.({}), set: (_o, cb) => cb?.() },
      },
    };

    try {
      await waitForHealth(baseUrl, token);
      let data = baseData(baseUrl, token);
      const merged = [];
      _setDeviceIdForTests("dev_noop");
      initSyncEngine({
        getData: () => data,
        setData: (next) => {
          data = next;
        },
        saveLocal: async () => null,
        onMerged: async (_next, stats) => merged.push(stats),
      });

      const first = await pushNow("initial");
      assert.equal(first.ok, true);
      const afterFirst = await httpPullState({ baseUrl, token });
      assert.equal(afterFirst.ok, true);

      // 没做任何修改 → 不应再写新版本
      const second = await pushNow("unchanged");
      assert.equal(second.ok, true);
      assert.equal(second.skipped, true);
      const afterSecond = await httpPullState({ baseUrl, token });
      assert.equal(afterSecond.revision, afterFirst.revision);

      // 真的改了内容 → 必须推上去
      data.nodes.n1.title = "Changed locally";
      data.nodes.n1.updatedAt = 9;
      data.nodes.n1.titleUpdatedAt = 9;
      const third = await pushNow("changed");
      assert.equal(third.ok, true);
      assert.notEqual(third.skipped, true);
      const afterThird = await httpPullState({ baseUrl, token });
      assert.equal(afterThird.revision, afterSecond.revision + 1);
      assert.equal(afterThird.doc.nodes[0].title, "Changed locally");

      // 版本号没变时的轮询必须直接返回，不能走 merge（否则会触发整页 render 与壁纸重刷）
      const mergedBefore = merged.length;
      const poll = await pullNow("interval");
      assert.equal(poll.unchanged, true);
      assert.equal(merged.length, mergedBefore);
    } finally {
      delete globalThis.chrome;
      _setDeviceIdForTests("");
      await stopServer(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
