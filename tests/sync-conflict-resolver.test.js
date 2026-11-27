import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSyncConflictResolver } from "../src/js/sync_conflict_resolver.js";

function createHarness({
  localData,
  initialStatus,
  initialPendingRemote = null,
  readRemoteImpl,
  writeRemoteImpl,
  applyConflictLocalStateImpl,
  mergeHomepageImpl,
  isContentEqualToRemote,
  getE2eeConfig,
} = {}) {
  const options = { isContentEqualToRemote, getE2eeConfig };
  let pendingRemote = initialPendingRemote;
  const status = {
    status: "idle",
    docId: "doc_local",
    lastError: "",
    lastRemoteRevision: 0,
    lastRemoteEtag: "",
    ...(initialStatus || {}),
  };
  let data = localData || {
    schemaVersion: 2,
    settings: { backgroundCustom: "data:image/png;base64,localbg", syncEnabled: true },
    groups: [{ id: "grp_all", name: "全部", order: -1, systemAllGroup: true, nodes: ["itm_local"] }],
    nodes: {
      itm_local: { id: "itm_local", type: "item", title: "Local", url: "https://local.test/" },
    },
    backups: [{ id: "bak_1", ts: 100, data: {} }],
    lastUpdated: 100,
  };
  const calls = {
    saveState: 0,
    pushNow: [],
    applied: [],
    writtenDocs: [],
  };

  const resolver = createSyncConflictResolver({
    enqueue: (fn) => fn(),
    getData: () => data,
    getStatus: () => status,
    getPendingConflictRemote: () => pendingRemote,
    setPendingConflictRemote: (doc) => {
      pendingRemote = doc;
    },
    saveState: async () => {
      calls.saveState += 1;
    },
    isContentEqualToRemote: options?.isContentEqualToRemote,
    getE2eeConfig: options?.getE2eeConfig || (() => ({ enabled: false })),
    readRemoteSyncDocument: readRemoteImpl || (async () => ({ ok: false, reason: "no_remote" })),
    writeRemoteSyncDocument:
      writeRemoteImpl ||
      (async (doc) => {
        calls.writtenDocs.push(doc);
        return null;
      }),
    applyConflictLocalState:
      applyConflictLocalStateImpl ||
      (async (nextState, docId, stats) => {
        data = nextState;
        status.docId = docId;
        calls.applied.push({ nextState, docId, stats });
        return { ok: true };
      }),
    pushNowImpl: async (reason) => {
      calls.pushNow.push(reason);
      return { ok: true };
    },
    getOrCreateDeviceId: async () => "dev_local",
    createDocId: () => "doc_generated",
    toSyncDocument: (d, meta) => ({
      schema: "homepage.sync.doc.v1",
      schemaVersion: 1,
      docId: meta.docId,
      revision: meta.revision,
      deviceId: meta.deviceId,
      writtenAt: meta.writtenAt,
      contentHash: "",
      settings: d.settings,
      groups: d.groups,
      nodes: Object.values(d.nodes || {}),
    }),
    hashSyncDocument: (doc) => `hash_${doc.docId}_${doc.revision}`,
    mergeHomepage:
      mergeHomepageImpl ||
      ((local, remote) => ({
        ok: true,
        state: {
          schemaVersion: 2,
          settings: { ...(local.settings || {}), ...(remote.settings || {}) },
          groups: remote.groups || local.groups,
          nodes: local.nodes,
          backups: local.backups || [],
          lastUpdated: 200,
        },
        stats: { merged: true },
      })),
    syncDocumentToHomepageShape: (doc) => ({
      settings: doc.settings || {},
      groups: doc.groups || [],
      nodes: Object.fromEntries((doc.nodes || []).map((n) => [n.id, n])),
    }),
    HOMEPAGE_SCHEMA_VERSION: 2,
  });

  return { resolver, status, calls, getData: () => data, getPendingRemote: () => pendingRemote };
}

describe("sync_conflict_resolver", () => {
  it("returns no_conflict when idle and reports null getPendingConflict", async () => {
    const { resolver } = createHarness();
    assert.equal(resolver.getPendingConflict(), null);
    const res = await resolver.resolveDocConflict("merge");
    assert.deepEqual(res, { ok: false, reason: "no_conflict" });
  });

  it("re-fetches full remote doc when restored from placeholder and detects docId drift", async () => {
    const h = createHarness({
      initialStatus: {
        status: "need_setup",
        docId: "doc_local",
        conflictLocalDocId: "doc_local",
        conflictRemoteDocId: "doc_remote_1",
      },
      initialPendingRemote: { docId: "doc_remote_1", revision: 4 },
      readRemoteImpl: async () => ({
        ok: true,
        doc: { docId: "doc_remote_2", revision: 5, groups: [], nodes: [] },
      }),
    });

    assert.deepEqual(h.resolver.getPendingConflict(), {
      localDocId: "doc_local",
      remoteDocId: "doc_remote_1",
      remoteRevision: 4,
    });

    const res = await h.resolver.resolveDocConflict("merge");
    assert.deepEqual(res, { ok: false, reason: "doc_conflict" });
    assert.equal(h.status.conflictRemoteDocId, "doc_remote_2");
    assert.equal(h.getPendingRemote().docId, "doc_remote_2");
  });

  it("handles choice=local success and preserves updated conflict state on push failure", async () => {
    const hOk = createHarness({
      initialStatus: {
        status: "need_setup",
        docId: "doc_local",
        conflictLocalDocId: "doc_local",
        conflictRemoteDocId: "doc_remote",
      },
      initialPendingRemote: { docId: "doc_remote", revision: 6, groups: [], nodes: [] },
      readRemoteImpl: async () => ({
        ok: true,
        doc: { docId: "doc_remote", revision: 6, groups: [], nodes: [] },
      }),
    });

    const okRes = await hOk.resolver.resolveDocConflict("local");
    assert.deepEqual(okRes, { ok: true, choice: "local" });
    assert.equal(hOk.status.status, "idle");
    assert.equal(hOk.status.lastRemoteRevision, 7);
    assert.equal("conflictRemoteDocId" in hOk.status, false);
    assert.equal("conflictLocalDocId" in hOk.status, false);
    assert.equal(hOk.calls.writtenDocs[0].contentHash, "hash_doc_local_7");

    const hFail = createHarness({
      initialStatus: {
        status: "need_setup",
        docId: "doc_local",
        conflictLocalDocId: "doc_local",
        conflictRemoteDocId: "doc_remote",
      },
      initialPendingRemote: { docId: "doc_remote", revision: 6, groups: [], nodes: [] },
      readRemoteImpl: async () => ({
        ok: true,
        doc: { docId: "doc_remote", revision: 6, groups: [], nodes: [] },
      }),
      writeRemoteImpl: async () => ({
        code: "etag_mismatch",
        etag: '"rev-8"',
        remote: { doc: { docId: "doc_remote_new", revision: 8, groups: [], nodes: [] } },
      }),
    });

    const failRes = await hFail.resolver.resolveDocConflict("local");
    assert.deepEqual(failRes, { ok: false, reason: "etag_mismatch" });
    assert.equal(hFail.status.status, "need_setup");
    assert.equal(hFail.status.conflictRemoteDocId, "doc_remote_new");
    assert.equal(hFail.status.lastRemoteEtag, '"rev-8"');
  });

  it("handles choice=remote preserving backgroundCustom and triggers resolve_remote push", async () => {
    const h = createHarness({
      initialStatus: {
        status: "need_setup",
        docId: "doc_local",
        conflictLocalDocId: "doc_local",
        conflictRemoteDocId: "doc_remote",
      },
      initialPendingRemote: {
        docId: "doc_remote",
        revision: 12,
        settings: { fontSize: 16, backgroundCustom: "" },
        groups: [{ id: "grp_all", name: "All", order: -1, systemAllGroup: true, nodes: [] }],
        nodes: [],
      },
    });

    const res = await h.resolver.resolveDocConflict("remote");
    assert.deepEqual(res, { ok: true, choice: "remote" });
    assert.equal(h.status.status, "idle");
    assert.equal(h.status.lastRemoteRevision, 12);
    assert.equal(h.getData().settings.backgroundCustom, "data:image/png;base64,localbg");
    assert.deepEqual(h.calls.pushNow, ["resolve_remote"]);
  });

  it("handles choice=merge success and surfaces merge failures cleanly", async () => {
    const h = createHarness({
      initialStatus: { status: "need_setup", docId: "doc_local", conflictRemoteDocId: "doc_remote" },
      initialPendingRemote: { docId: "doc_remote", revision: 3, groups: [], nodes: [], settings: { fontSize: 18 } },
    });
    const res = await h.resolver.resolveDocConflict("merge");
    assert.deepEqual(res, { ok: true, choice: "merge" });
    assert.deepEqual(h.calls.pushNow, ["resolve_merge"]);
    assert.equal(h.calls.applied[0].docId, "doc_remote");

    const hErr = createHarness({
      initialStatus: { status: "need_setup", docId: "doc_local", conflictRemoteDocId: "doc_remote" },
      initialPendingRemote: { docId: "doc_remote", revision: 3, groups: [], nodes: [] },
      mergeHomepageImpl: () => ({ ok: false, reason: "schema_mismatch" }),
    });
    const errRes = await hErr.resolver.resolveDocConflict("merge");
    assert.deepEqual(errRes, { ok: false, reason: "schema_mismatch" });
    assert.deepEqual(hErr.calls.pushNow, []);
  });

  it("skips redundant resolve_remote push when choice=remote matches remote content without E2EE", async () => {
    const h = createHarness({
      initialStatus: { status: "need_setup", docId: "doc_local", conflictRemoteDocId: "doc_remote" },
      initialPendingRemote: {
        docId: "doc_remote",
        revision: 12,
        settings: {},
        groups: [{ id: "grp_all", name: "All", order: -1, systemAllGroup: true, nodes: [] }],
        nodes: [],
      },
      isContentEqualToRemote: () => true,
      getE2eeConfig: () => ({ enabled: false }),
    });
    const res = await h.resolver.resolveDocConflict("remote");
    assert.deepEqual(res, { ok: true, choice: "remote" });
    assert.deepEqual(h.calls.pushNow, []);
  });
});
