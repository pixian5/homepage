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
