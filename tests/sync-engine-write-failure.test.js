import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getPendingConflict,
  getSyncStatus,
  initSyncEngine,
  pullNow,
  pushNow,
  reloadSyncState,
  resolveDocConflict,
} from "../src/js/sync_engine.js";
import { _setDeviceIdForTests } from "../src/js/sync_ids.js";
import { HOMEPAGE_SCHEMA_VERSION, SYNC_STATE_KEY } from "../src/js/sync_policy.js";
import { hashSyncDocument, toSyncDocument } from "../src/js/sync_projection.js";

const realChrome = globalThis.chrome;
const realFetch = globalThis.fetch;

function createMemoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    area: {
      get(keys, cb) {
        const out = {};
        const keyList = Array.isArray(keys) ? keys : keys === null || keys === undefined ? Object.keys(store) : [keys];
        for (const k of keyList) {
          if (Object.hasOwn(store, k)) out[k] = structuredClone(store[k]);
        }
        cb?.(out);
      },
      set(obj, cb) {
        for (const [k, v] of Object.entries(obj || {})) {
          store[k] = structuredClone(v);
        }
        cb?.();
      },
      remove(keys, cb) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        cb?.();
      },
    },
  };
}

function makeHomepageState({ baseUrl, title = "Local Title", extraNodes = {} }) {
  const nodes = {
    n1: {
      id: "n1",
      type: "item",
      title,
      url: "https://local.example/",
      iconType: "auto",
      updatedAt: 100,
      titleUpdatedAt: 100,
      updatedBy: "dev_local",
    },
    ...extraNodes,
  };
  return {
    schemaVersion: HOMEPAGE_SCHEMA_VERSION,
    settings: {
      syncEnabled: true,
      syncServerUrl: baseUrl,
      syncServerToken: "",
      syncInterval: "off",
    },
    groups: [
      {
        id: "grp_all",
        name: "全部",
        order: -1,
        nodes: Object.keys(nodes),
        updatedAt: 100,
        updatedBy: "dev_local",
        systemAllGroup: true,
      },
    ],
    nodes,
    backups: [],
    lastUpdated: 100,
  };
}

function setupHarness({ remoteDoc, initialSyncState = null, saveImpl = async () => null }) {
  const baseUrl = "http://127.0.0.1:18787";
  const storage = createMemoryStorage(initialSyncState ? { [SYNC_STATE_KEY]: initialSyncState } : {});
  const requests = { pulls: 0, puts: [], confirms: [] };

  globalThis.chrome = {
    runtime: {},
    storage: { local: storage.area },
  };
  _setDeviceIdForTests("dev_local");

  let liveRemoteDoc = structuredClone(remoteDoc);
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const method = String(init.method || "GET").toUpperCase();
    if (pathname === "/v1/sync/state" && method === "GET") {
      requests.pulls += 1;
      return new Response(
        JSON.stringify({
          doc: liveRemoteDoc,
          revision: liveRemoteDoc.revision,
          etag: `"rev-${liveRemoteDoc.revision}"`,
          epoch: 0,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: `"rev-${liveRemoteDoc.revision}"`,
          },
        },
      );
    }
    if (pathname === "/v1/sync/state" && method === "PUT") {
      const body = JSON.parse(init.body);
      requests.puts.push(body);
      liveRemoteDoc = body;
      return new Response(JSON.stringify({ ok: true, revision: body.revision, etag: `"rev-${body.revision}"` }), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: `"rev-${body.revision}"` },
      });
    }
    if (pathname === "/v1/sync/confirm" && method === "POST") {
      const body = JSON.parse(init.body);
      requests.confirms.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  };

  let data = makeHomepageState({ baseUrl });
  let onMergedCount = 0;
  let safetyCount = 0;
  let currentSaveImpl = saveImpl;

  initSyncEngine({
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    saveLocal: (next) => currentSaveImpl(next),
    createSafetySnapshot: async () => {
      safetyCount += 1;
    },
    onMerged: async () => {
      onMergedCount += 1;
    },
  });

  return {
    baseUrl,
    storage,
    requests,
    getData: () => data,
    setSaveImpl: (fn) => {
      currentSaveImpl = fn;
    },
    counts: () => ({ onMergedCount, safetyCount }),
  };
}

afterEach(() => {
  _setDeviceIdForTests("");
  if (realChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = realChrome;
  if (realFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = realFetch;
});

describe("sync_engine local write failure atomicity", () => {
  it("pullNow 遇到 saveLocal 返回错误或抛异常时不篡改内存、不回调 onMerged 且不确认服务端，恢复后可重试成功", async () => {
    const baseUrl = "http://127.0.0.1:18787";
    const remoteState = makeHomepageState({
      baseUrl,
      title: "Remote Newer Title",
      extraNodes: {
        n2: {
          id: "n2",
          type: "item",
          title: "Peer Card",
          url: "https://peer.example/",
          iconType: "auto",
          updatedAt: 200,
          updatedBy: "dev_peer",
        },
      },
    });
    remoteState.nodes.n1.updatedAt = 200;
    remoteState.nodes.n1.titleUpdatedAt = 200;
    remoteState.nodes.n1.updatedBy = "dev_peer";
    const remoteDoc = toSyncDocument(remoteState, {
      deviceId: "dev_peer",
      docId: "doc_shared",
      revision: 5,
      writtenAt: 200,
    });
    remoteDoc.contentHash = hashSyncDocument(remoteDoc);

    const h = setupHarness({
      remoteDoc,
      initialSyncState: {
        docId: "doc_shared",
        status: "idle",
        lastRemoteRevision: 2,
      },
      saveImpl: async () => "quota_exceeded",
    });

    const firstFail = await pullNow("manual");
    assert.equal(firstFail.ok, false);
    assert.equal(firstFail.reason, "local_write_failed");
    assert.equal(firstFail.error, "quota_exceeded");
    assert.equal(h.getData().nodes.n1.title, "Local Title");
    assert.equal(h.getData().nodes.n2, undefined);
    assert.equal(h.counts().onMergedCount, 0);
    assert.equal(h.requests.confirms.length, 0);
    assert.equal(getSyncStatus().status, "error");
    assert.equal(getSyncStatus().lastRemoteRevision, 2);

    h.setSaveImpl(async () => {
      throw new Error("disk_io_boom");
    });
    const secondFail = await pullNow("manual");
    assert.equal(secondFail.ok, false);
    assert.equal(secondFail.reason, "local_write_failed");
    assert.equal(secondFail.error, "disk_io_boom");
    assert.equal(h.getData().nodes.n1.title, "Local Title");
    assert.equal(h.counts().onMergedCount, 0);
    assert.equal(h.requests.confirms.length, 0);

    h.setSaveImpl(async () => null);
    const recovered = await pullNow("manual");
    assert.equal(recovered.ok, true);
    assert.equal(recovered.merged, true);
    assert.equal(h.getData().nodes.n1.title, "Remote Newer Title");
    assert.ok(h.getData().nodes.n2);
    assert.equal(h.counts().onMergedCount, 1);
    assert.equal(h.requests.confirms.length, 1);
    assert.equal(getSyncStatus().lastRemoteRevision, 5);
  });

  it("pushNow 预拉取遇到本地落盘失败时立即中止，不会向远端发起 PUT 覆盖", async () => {
    const baseUrl = "http://127.0.0.1:18787";
    const remoteState = makeHomepageState({ baseUrl, title: "Peer Title" });
    remoteState.nodes.n1.updatedAt = 300;
    remoteState.nodes.n1.titleUpdatedAt = 300;
    remoteState.nodes.n1.updatedBy = "dev_peer";
    const remoteDoc = toSyncDocument(remoteState, {
      deviceId: "dev_peer",
      docId: "doc_shared",
      revision: 3,
      writtenAt: 300,
    });
    remoteDoc.contentHash = hashSyncDocument(remoteDoc);

    const h = setupHarness({
      remoteDoc,
      initialSyncState: {
        docId: "doc_shared",
        status: "idle",
        lastRemoteRevision: 1,
      },
      saveImpl: async () => "local_storage_full",
    });

    const res = await pushNow("manual");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "local_write_failed");
    assert.equal(h.requests.puts.length, 0, "预拉取落盘失败不应覆盖远端");
    assert.equal(h.getData().nodes.n1.title, "Local Title");
  });

  for (const choice of ["remote", "merge"]) {
    it(`resolveDocConflict("${choice}") 本地写盘失败时保留原内存、docId 与冲突上下文，恢复后可重试成功`, async () => {
      const baseUrl = "http://127.0.0.1:18787";
      const remoteState = makeHomepageState({
        baseUrl,
        title: "Cloud Title",
        extraNodes: {
          n2: {
            id: "n2",
            type: "item",
            title: "Cloud Only",
            url: "https://cloud.example/",
            iconType: "auto",
            updatedAt: 200,
            updatedBy: "dev_cloud",
          },
        },
      });
      remoteState.nodes.n1.updatedAt = 200;
      remoteState.nodes.n1.titleUpdatedAt = 200;
      remoteState.nodes.n1.updatedBy = "dev_cloud";
      const remoteDoc = toSyncDocument(remoteState, {
        deviceId: "dev_cloud",
        docId: "doc_cloud",
        revision: 4,
        writtenAt: 200,
      });
      remoteDoc.contentHash = hashSyncDocument(remoteDoc);

      const h = setupHarness({
        remoteDoc,
        initialSyncState: {
          docId: "doc_local",
          status: "idle",
          lastRemoteRevision: 1,
        },
      });

      const conflictPull = await pullNow("manual");
      assert.equal(conflictPull.ok, false);
      assert.equal(conflictPull.reason, "doc_conflict");
      assert.deepEqual(getPendingConflict(), {
        localDocId: "doc_local",
        remoteDocId: "doc_cloud",
        remoteRevision: 4,
      });

      h.setSaveImpl(async () => "quota_fail");
      const failedResolve = await resolveDocConflict(choice);
      assert.equal(failedResolve.ok, false);
      assert.equal(failedResolve.reason, "quota_fail");
      assert.equal(h.getData().nodes.n2, undefined);
      assert.equal(getSyncStatus().docId, "doc_local");
      assert.equal(getSyncStatus().status, "need_setup");
      assert.deepEqual(getPendingConflict(), {
        localDocId: "doc_local",
        remoteDocId: "doc_cloud",
        remoteRevision: 4,
      });
      assert.equal(h.counts().onMergedCount, 0);

      // 模拟刷新恢复状态后再用异常方式重试一次仍保持 need_setup
      const reloaded = await reloadSyncState();
      assert.equal(reloaded.status, "need_setup");
      h.setSaveImpl(async () => {
        throw new Error("write_exception");
      });
      const failedAgain = await resolveDocConflict(choice);
      assert.equal(failedAgain.ok, false);
      assert.equal(failedAgain.reason, "write_exception");
      assert.ok(getPendingConflict());

      // 恢复写盘能力后正式解决冲突
      h.setSaveImpl(async () => null);
      const okResolve = await resolveDocConflict(choice);
      assert.equal(okResolve.ok, true);
      assert.equal(okResolve.choice, choice);
      assert.equal(getPendingConflict(), null);
      assert.equal(getSyncStatus().docId, "doc_cloud");
      assert.equal(getSyncStatus().status, "idle");
      assert.ok(h.getData().nodes.n2);
      assert.ok(h.counts().onMergedCount >= 1);
      if (choice === "merge") {
        assert.ok(h.requests.puts.length >= 1);
      }
    });
  }
});
