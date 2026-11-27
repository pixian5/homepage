/**
 * 文档 ID 冲突三选一解决器（merge / local / remote）（从 sync_engine.js 拆出）。
 *
 * 用 IIFE 包裹：Firefox 拼接经典脚本时不污染全局作用域。
 */

var HomepageSyncConflictResolver = (() => {
  function createSyncConflictResolver(deps) {
    const {
      enqueue,
      getData,
      getStatus,
      getPendingConflictRemote,
      setPendingConflictRemote,
      saveState,
      readRemoteSyncDocument,
      writeRemoteSyncDocument,
      applyConflictLocalState,
      pushNowImpl,
      isContentEqualToRemote,
      getE2eeConfig,
      getOrCreateDeviceId,
      createDocId,
      toSyncDocument,
      hashSyncDocument,
      mergeHomepage,
      syncDocumentToHomepageShape,
      HOMEPAGE_SCHEMA_VERSION,
    } = deps;

    async function resolveDocConflict(choice) {
      return enqueue(async () => {
        const status = getStatus();
        let remote = getPendingConflictRemote();
        if (!remote) {
          if (status.status !== "need_setup") {
            return { ok: false, reason: "no_conflict" };
          }
          const current = await readRemoteSyncDocument();
          if (!current.ok) return { ok: false, reason: current.reason || "remote_unavailable" };
          if (!status.docId || current.doc.docId === status.docId) {
            status.status = "idle";
            status.lastError = "";
            await saveState();
            return { ok: false, reason: "no_conflict" };
          }
          remote = current.doc;
          setPendingConflictRemote(remote);
          status.conflictRemoteDocId = remote.docId;
          status.conflictLocalDocId = status.docId;
          await saveState();
        }
        // 状态从存储恢复时只有占位 docId；需要完整文档再拉取一次
        if (!Array.isArray(remote.nodes) && !Array.isArray(remote.groups)) {
          const fresh = await readRemoteSyncDocument();
          if (!fresh.ok) {
            return { ok: false, reason: fresh.reason || "remote_unavailable" };
          }
          if (remote.docId && fresh.doc.docId !== remote.docId) {
            setPendingConflictRemote(fresh.doc);
            status.conflictRemoteDocId = fresh.doc.docId;
            await saveState();
            return { ok: false, reason: "doc_conflict" };
          }
          remote = fresh.doc;
          setPendingConflictRemote(remote);
        }

        const deviceId = await getOrCreateDeviceId();
        const local = getData();

        if (choice === "local") {
          const localDocId = status.conflictLocalDocId || status.docId || createDocId();
          status.docId = localDocId;
          const remoteRead = await readRemoteSyncDocument();
          let base = 0;
          if (remoteRead.ok) base = Number(remoteRead.doc.revision) || 0;
          const doc = toSyncDocument(local, {
            deviceId,
            docId: status.docId,
            revision: base + 1,
            writtenAt: Date.now(),
          });
          doc.contentHash = hashSyncDocument(doc);
          const err = await writeRemoteSyncDocument(doc);
          if (err) {
            const errorCode = typeof err === "string" ? err : err?.code || "push_failed";
            if (typeof err === "object" && err?.remote?.doc) {
              setPendingConflictRemote(err.remote.doc);
              status.conflictRemoteDocId = err.remote.doc.docId || status.conflictRemoteDocId;
              if (err.etag) status.lastRemoteEtag = err.etag;
            }
            status.conflictLocalDocId = localDocId;
            status.status = "need_setup";
            status.lastError = errorCode;
            await saveState();
            return { ok: false, reason: errorCode };
          }
          setPendingConflictRemote(null);
          delete status.conflictRemoteDocId;
          delete status.conflictLocalDocId;
          status.lastPushAt = Date.now();
          status.lastRemoteRevision = doc.revision;
          status.status = "idle";
          status.lastError = "";
          await saveState();
          return { ok: true, choice: "local" };
        }

        if (choice === "remote") {
          let forceDoc = { ...remote };
          if (!Array.isArray(forceDoc.nodes) || !Array.isArray(forceDoc.groups)) {
            const fresh = await readRemoteSyncDocument();
            if (!fresh.ok) {
              return { ok: false, reason: fresh.reason || "remote_unavailable" };
            }
            forceDoc = fresh.doc;
            status.lastRemoteEtag = fresh.etag || status.lastRemoteEtag;
          }
          const merged = mergeHomepage(
            {
              schemaVersion: HOMEPAGE_SCHEMA_VERSION,
              settings: { ...(local.settings || {}) },
              groups: [],
              nodes: {},
              backups: local.backups || [],
              lastUpdated: 0,
            },
            forceDoc,
            { deviceId, now: Date.now() },
          );
          let nextState;
          let mergedStats;
          if (!merged.ok) {
            const shape = syncDocumentToHomepageShape(forceDoc);
            nextState = {
              schemaVersion: HOMEPAGE_SCHEMA_VERSION,
              settings: {
                ...(local.settings || {}),
                ...(shape.settings || {}),
                backgroundCustom: local.settings?.backgroundCustom || shape.settings?.backgroundCustom || "",
                syncEnabled: true,
              },
              groups: shape.groups,
              nodes: shape.nodes,
              backups: local.backups || [],
              lastUpdated: Date.now(),
            };
            mergedStats = { applied: true, choice: "remote" };
          } else {
            merged.state.settings = {
              ...merged.state.settings,
              backgroundCustom: local.settings?.backgroundCustom || merged.state.settings?.backgroundCustom || "",
              syncEnabled: true,
            };
            nextState = merged.state;
            mergedStats = { ...merged.stats, choice: "remote" };
          }
          const committed = await applyConflictLocalState(nextState, forceDoc.docId, mergedStats);
          if (!committed.ok) return committed;
          status.status = "idle";
          status.lastError = "";
          status.lastPullAt = Date.now();
          status.lastRemoteRevision = Number(forceDoc.revision) || 0;
          await saveState();
          const skipRedundantPush =
            typeof isContentEqualToRemote === "function" &&
            !getE2eeConfig?.()?.enabled &&
            isContentEqualToRemote(getData(), forceDoc, forceDoc.docId);
          if (!skipRedundantPush) {
            await pushNowImpl("resolve_remote");
          }
          return { ok: true, choice: "remote" };
        }

        const merged = mergeHomepage(local, remote, { deviceId, now: Date.now() });
        if (!merged.ok) {
          return { ok: false, reason: merged.reason || "merge_failed" };
        }
        const committed = await applyConflictLocalState(merged.state, remote.docId, {
          ...merged.stats,
          choice: "merge",
        });
        if (!committed.ok) return committed;
        status.status = "idle";
        status.lastError = "";
        status.lastPullAt = Date.now();
        await saveState();
        await pushNowImpl("resolve_merge");
        return { ok: true, choice: "merge" };
      });
    }

    function getPendingConflict() {
      const pendingRemote = getPendingConflictRemote();
      if (!pendingRemote) return null;
      const status = getStatus();
      return {
        localDocId: status.conflictLocalDocId || status.docId,
        remoteDocId: status.conflictRemoteDocId || pendingRemote.docId,
        remoteRevision: pendingRemote.revision,
      };
    }

    return {
      resolveDocConflict,
      getPendingConflict,
    };
  }

  return { createSyncConflictResolver };
})();

export const createSyncConflictResolver = HomepageSyncConflictResolver.createSyncConflictResolver;
