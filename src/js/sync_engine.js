/**
 * 同步引擎：local 权威 + 投影分片推送 + merge 拉取
 */

import { getLastError, storageArea } from "./shared-utils.js";
import { httpPullState, httpPushState } from "./sync_http_transport.js";
import { createDocId, getOrCreateDeviceId } from "./sync_ids.js";
import { mergeHomepage } from "./sync_merge.js";
import {
  isSyncOutboxReady,
  normalizeSyncOutbox,
  removeSyncOutbox,
  SYNC_OUTBOX_KEY,
  SYNC_OUTBOX_TARGET,
  upsertSyncOutbox,
} from "./sync_outbox.js";
import { packSyncDocument, SYNC_META_KEY, syncShardKeys, unpackSyncDocument } from "./sync_pack.js";
import {
  SYNC_OUTBOX_MAX_ATTEMPTS,
  SYNC_PULL_DEBOUNCE_MS,
  SYNC_PUSH_DEBOUNCE_MS,
  SYNC_REVISION_RETRY,
  SYNC_SHARD_KEY_PREFIX,
  SYNC_STATE_KEY,
  normalizeSyncInterval,
  syncBytesBudgetLevel,
  syncIntervalToMs,
} from "./sync_policy.js";
import {
  estimateSyncProjectionBytes,
  hashSyncDocument,
  syncDocumentToHomepageShape,
  toSyncDocument,
} from "./sync_projection.js";

function areaLocal() {
  return storageArea(false);
}
function areaSync() {
  return storageArea(true);
}

function getTransportConfig() {
  const data = _getData();
  const settings = data?.settings || {};
  const mode = settings.syncTransport === "http" ? "http" : "browser";
  return {
    mode,
    baseUrl: String(settings.syncServerUrl || "").trim(),
    token: String(settings.syncServerToken || "").trim(),
  };
}

function storageGetKeys(area, keys) {
  return new Promise((resolve) => {
    try {
      const result = area.get(keys, (res) => {
        if (getLastError()) return resolve({ ok: false, error: getLastError().message, value: {} });
        resolve({ ok: true, value: res || {} });
      });
      if (result && typeof result.then === "function") {
        result.then(
          (res) => resolve({ ok: true, value: res || {} }),
          (e) => resolve({ ok: false, error: e?.message || String(e), value: {} }),
        );
      }
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e), value: {} });
    }
  });
}

function storageSetObj(area, obj) {
  return new Promise((resolve) => {
    try {
      const result = area.set(obj, () => {
        const err = getLastError();
        resolve(err ? err.message || String(err) : null);
      });
      if (result && typeof result.then === "function") {
        result.then(
          () => resolve(null),
          (e) => resolve(e?.message || String(e)),
        );
      }
    } catch (e) {
      resolve(e?.message || String(e));
    }
  });
}

function storageRemoveKeys(area, keys) {
  return new Promise((resolve) => {
    try {
      const result = area.remove(keys, () => resolve(getLastError() ? getLastError().message : null));
      if (result && typeof result.then === "function") {
        result.then(
          () => resolve(null),
          (e) => resolve(e?.message || String(e)),
        );
      }
    } catch (e) {
      resolve(e?.message || String(e));
    }
  });
}

/** @type {object} */
let _status = {
  enabled: false,
  docId: null,
  status: "off",
  lastPullAt: 0,
  lastPushAt: 0,
  lastError: "",
  lastRemoteRevision: 0,
  lastRemoteEtag: "",
  bytesEstimate: 0,
  transport: "browser", // browser | http
};

let _pushTimer = null;
let _pullTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let _intervalTimer = null;
/** 当前 interval 定时器对应的 ms，避免重复重建 */
let _intervalMsApplied = -1;
let _chain = Promise.resolve();
let _getData = () => null;
let _setData = (_d) => {};
let _onMerged = async () => {};
let _saveLocal = async () => null;
let _createSafety = async () => {};
/** @type {object|null} */
let _pendingConflictRemote = null;

/**
 * @param {{
 *   getData: () => object,
 *   setData: (d: object) => void,
 *   saveLocal: (d: object) => Promise<string|null>,
 *   onMerged?: (d: object, stats: object) => Promise<void>|void,
 *   createSafetySnapshot?: () => Promise<void>|void,
 * }} hooks
 */
export function initSyncEngine(hooks) {
  _getData = hooks.getData;
  _setData = hooks.setData;
  _saveLocal = hooks.saveLocal;
  _onMerged = hooks.onMerged || (async () => {});
  _createSafety = hooks.createSafetySnapshot || (async () => {});
}

export function getSyncStatus() {
  const data = _getData();
  const transport = getTransportConfig();
  return {
    ..._status,
    enabled: !!data?.settings?.syncEnabled,
    transport: transport.mode,
    serverUrl: transport.baseUrl,
    hasConflict: _status.status === "need_setup" && !!_pendingConflictRemote,
    bytesEstimate: data ? estimateSyncProjectionBytes(data, { deviceId: "x", docId: _status.docId || "y" }) : 0,
    budgetLevel: syncBytesBudgetLevel(
      data ? estimateSyncProjectionBytes(data, { deviceId: "x", docId: _status.docId || "y" }) : 0,
    ),
  };
}

async function loadState() {
  const local = areaLocal();
  if (!local) return;
  const got = await storageGetKeys(local, [SYNC_STATE_KEY, SYNC_OUTBOX_KEY]);
  const st = got.value?.[SYNC_STATE_KEY];
  if (st && typeof st === "object") {
    _status = { ..._status, ...st };
  }
}

async function saveState() {
  const local = areaLocal();
  if (!local) return;
  await storageSetObj(local, {
    [SYNC_STATE_KEY]: {
      docId: _status.docId,
      status: _status.status,
      lastPullAt: _status.lastPullAt,
      lastPushAt: _status.lastPushAt,
      lastError: _status.lastError,
      lastRemoteRevision: _status.lastRemoteRevision,
      lastRemoteEtag: _status.lastRemoteEtag || "",
      bytesEstimate: _status.bytesEstimate,
      transport: getTransportConfig().mode,
    },
  });
}

function enqueue(task) {
  const run = _chain.then(task, task);
  _chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 读取远端 SyncDocument
 */
export async function readRemoteSyncDocument() {
  const transport = getTransportConfig();
  if (transport.mode === "http") {
    if (!transport.baseUrl) return { ok: false, reason: "no_url" };
    const res = await httpPullState({ baseUrl: transport.baseUrl, token: transport.token });
    if (!res.ok) {
      if (res.reason === "no_remote") return { ok: false, reason: "no_remote" };
      return { ok: false, reason: res.reason || "http_error", error: res.error, status: res.status };
    }
    _status.lastRemoteEtag = res.etag || "";
    return { ok: true, doc: res.doc, etag: res.etag, revision: res.revision };
  }

  const sync = areaSync();
  if (!sync) return { ok: false, reason: "no_sync_area" };
  const metaGot = await storageGetKeys(sync, [SYNC_META_KEY, "homepage_data"]);
  if (!metaGot.ok) return { ok: false, reason: "meta_read_error", error: metaGot.error };
  const meta = metaGot.value?.[SYNC_META_KEY];
  const legacyBlob = metaGot.value?.homepage_data;

  if (meta?.shardCount) {
    const keys = syncShardKeys(meta.shardCount);
    const shardGot = await storageGetKeys(sync, keys);
    if (!shardGot.ok) return { ok: false, reason: "shard_read_error", error: shardGot.error };
    return unpackSyncDocument(meta, shardGot.value);
  }

  if (legacyBlob && typeof legacyBlob === "object" && (legacyBlob.groups || legacyBlob.nodes)) {
    return { ok: false, reason: "legacy_blob", legacy: legacyBlob };
  }
  if (meta?.groups && meta.nodes && !meta.shardCount) {
    return { ok: false, reason: "legacy_blob", legacy: meta };
  }
  return { ok: false, reason: "no_remote" };
}

/**
 * 写入远端投影
 */
async function writeRemoteSyncDocument(doc) {
  const transport = getTransportConfig();
  if (transport.mode === "http") {
    if (!transport.baseUrl) return "no_url";
    const res = await httpPushState({ baseUrl: transport.baseUrl, token: transport.token }, doc, {
      ifMatch: _status.lastRemoteEtag || undefined,
      idempotencyKey: `${doc.docId || "doc"}:${doc.revision || 0}:${Date.now()}`,
    });
    if (res.ok) {
      _status.lastRemoteEtag = res.etag || _status.lastRemoteEtag;
      if (res.revision) doc.revision = res.revision;
      return null;
    }
    if (res.reason === "precondition_failed") {
      // 把远端 doc 塞回，供上层 merge 重试
      if (res.remote?.doc) {
        return { code: "precondition_failed", remote: res.remote };
      }
      return "precondition_failed";
    }
    if (res.reason === "unauthorized") return "unauthorized";
    if (res.reason === "network_error") return res.error || "network_error";
    return res.error || res.reason || "http_error";
  }

  const sync = areaSync();
  if (!sync) return "no_sync_area";
  let packed;
  try {
    packed = packSyncDocument(doc);
  } catch (e) {
    if (e?.code === "sync_quota_total" || e?.code === "sync_shard_too_large") {
      return e.code;
    }
    return e?.message || String(e);
  }
  const removeKeys = [];
  for (let i = packed.meta.shardCount; i < packed.meta.shardCount + 20; i++) {
    removeKeys.push(`${SYNC_SHARD_KEY_PREFIX}${i}`);
  }
  const errShards = await storageSetObj(sync, packed.shards);
  if (errShards) return errShards;
  const errMeta = await storageSetObj(sync, { [SYNC_META_KEY]: packed.meta });
  if (errMeta) return errMeta;
  if (removeKeys.length) await storageRemoveKeys(sync, removeKeys);
  await storageRemoveKeys(sync, ["homepage_data"]);
  return null;
}

/**
 * Pull + merge 到本地
 */
export async function pullNow(reason = "manual") {
  return enqueue(async () => {
    const data = _getData();
    if (!data?.settings?.syncEnabled) {
      _status.status = "off";
      return { ok: true, skipped: true };
    }
    _status.status = "syncing";
    _status.lastError = "";
    await saveState();

    const deviceId = await getOrCreateDeviceId();
    const remote = await readRemoteSyncDocument();

    if (!remote.ok) {
      if (remote.reason === "no_remote") {
        // 远端空：若本地有数据则 push；否则 idle
        _status.status = "idle";
        _status.lastPullAt = Date.now();
        await saveState();
        if ((data.groups?.length || 0) > 0 || Object.keys(data.nodes || {}).length > 0) {
          // 同队列内直接 push，避免嵌套 enqueue 死锁
          const pushed = await pushNowImpl("pull_empty_remote");
          return { ok: true, empty: true, pushed };
        }
        return { ok: true, empty: true };
      }
      if (remote.reason === "legacy_blob") {
        // 将旧整包当 HomepageData 投影再 merge
        const legacy = remote.legacy;
        const docId = _status.docId || createDocId();
        _status.docId = docId;
        const asDoc = toSyncDocument(legacy, {
          deviceId: legacy?.settings?.lastDeviceId || deviceId,
          docId,
          revision: 1,
          writtenAt: Number(legacy.lastUpdated) || Date.now(),
        });
        return applyRemoteDoc(asDoc, deviceId, reason);
      }
      _status.status = remote.reason === "incomplete_remote" ? "error" : "error";
      _status.lastError = remote.reason || "pull_failed";
      await saveState();
      return { ok: false, reason: remote.reason };
    }

    return applyRemoteDoc(remote.doc, deviceId, reason);
  });
}

async function applyRemoteDoc(doc, deviceId, reason) {
  const data = _getData();
  if (!_status.docId) _status.docId = doc.docId || createDocId();
  if (doc.docId && _status.docId && doc.docId !== _status.docId) {
    // 文档冲突：缓存远端文档，交由 UI 三选一
    _pendingConflictRemote = doc;
    _status.status = "need_setup";
    _status.lastError = "doc_conflict";
    _status.conflictRemoteDocId = doc.docId;
    _status.conflictLocalDocId = _status.docId;
    await saveState();
    return { ok: false, reason: "doc_conflict", remoteDocId: doc.docId, localDocId: _status.docId };
  }
  if (!doc.docId) doc.docId = _status.docId;

  const prevRemoteRevision = Number(_status.lastRemoteRevision) || 0;
  const remoteRevision = Number(doc.revision) || 0;
  // 仅当此前已知远端 revision，且远端比上次更高，才视为「他端更新」
  // prev=0：首次 pull / 本机刚启用，不弹覆盖警告
  const remoteNewer = prevRemoteRevision > 0 && remoteRevision > prevRemoteRevision;

  const merged = mergeHomepage(data, doc, { deviceId, now: Date.now() });
  if (!merged.ok) {
    _status.status = "error";
    _status.lastError = merged.reason || "merge_failed";
    await saveState();
    return { ok: false, reason: merged.reason, stats: merged.stats };
  }

  if (merged.stats?.applied) {
    try {
      await _createSafety();
    } catch (e) {
      console.warn("sync safety snapshot failed", e);
    }
    _setData(merged.state);
    const err = await _saveLocal(merged.state);
    if (err) {
      _status.status = "error";
      _status.lastError = err;
      await saveState();
      return { ok: false, reason: "local_write_failed", error: err };
    }
    await _onMerged(merged.state, {
      ...merged.stats,
      remoteNewer,
      remoteRevision,
      prevRemoteRevision,
      reason,
    });
  }

  _status.lastPullAt = Date.now();
  _status.lastRemoteRevision = remoteRevision;
  _status.status = "idle";
  _status.lastError = "";
  _status.docId = doc.docId || _status.docId;
  await saveState();
  return {
    ok: true,
    merged: !!merged.stats?.applied,
    stats: { ...merged.stats, remoteNewer, remoteRevision },
    reason,
  };
}

/**
 * 推送本地投影（可在 pull 的 enqueue 内调用，勿再包 enqueue）
 */
async function pushNowImpl(reason = "manual") {
  const data = _getData();
  if (!data?.settings?.syncEnabled) {
    _status.status = "off";
    return { ok: true, skipped: true };
  }
  _status.status = "syncing";
  await saveState();

  const deviceId = await getOrCreateDeviceId();
  if (!_status.docId) _status.docId = createDocId();

  let baseRevision = 0;
  const remote = await readRemoteSyncDocument();
  if (remote.ok && remote.doc) {
    if (remote.doc.docId && _status.docId && remote.doc.docId !== _status.docId) {
      _status.status = "need_setup";
      _status.lastError = "doc_conflict";
      await saveState();
      return { ok: false, reason: "doc_conflict" };
    }
    baseRevision = Number(remote.doc.revision) || 0;
    if (baseRevision > (_status.lastRemoteRevision || 0)) {
      const pulled = await applyRemoteDoc(remote.doc, deviceId, "push_pre_pull");
      if (!pulled.ok && pulled.reason === "doc_conflict") return pulled;
    }
    const again = await readRemoteSyncDocument();
    if (again.ok) baseRevision = Number(again.doc.revision) || baseRevision;
  } else if (remote.reason === "legacy_blob" && remote.legacy) {
    const docId = _status.docId || createDocId();
    _status.docId = docId;
    const asDoc = toSyncDocument(remote.legacy, {
      deviceId: deviceId,
      docId,
      revision: 1,
      writtenAt: Number(remote.legacy.lastUpdated) || Date.now(),
    });
    await applyRemoteDoc(asDoc, deviceId, "push_legacy_pull");
    baseRevision = 1;
  }

  const latest = _getData();
  let lastErr = null;
  for (let attempt = 0; attempt < SYNC_REVISION_RETRY; attempt++) {
    const revision = baseRevision + 1;
    const doc = toSyncDocument(latest, {
      deviceId,
      docId: _status.docId,
      revision,
      writtenAt: Date.now(),
    });
    doc.contentHash = hashSyncDocument(doc);
    _status.bytesEstimate = estimateSyncProjectionBytes(latest, { deviceId, docId: _status.docId });

    const writeErr = await writeRemoteSyncDocument(doc);
    if (!writeErr) {
      _status.lastPushAt = Date.now();
      _status.lastRemoteRevision = revision;
      _status.status = "idle";
      _status.lastError = "";
      await clearOutboxSuccess();
      await saveState();
      return { ok: true, revision, reason };
    }
    // HTTP 412：服务端返回最新状态
    if (writeErr && typeof writeErr === "object" && writeErr.code === "precondition_failed") {
      lastErr = "precondition_failed";
      const remoteDoc = writeErr.remote?.doc;
      if (remoteDoc) {
        baseRevision = Number(writeErr.remote.revision || remoteDoc.revision) || baseRevision;
        await applyRemoteDoc(remoteDoc, deviceId, "push_412_pull");
        continue;
      }
    } else {
      lastErr = typeof writeErr === "string" ? writeErr : writeErr?.code || "push_failed";
    }
    if (lastErr === "sync_quota_total" || lastErr === "sync_shard_too_large") {
      _status.status = "quota";
      _status.lastError = lastErr;
      await enqueueOutbox(doc, lastErr);
      await saveState();
      return { ok: false, reason: lastErr };
    }
    if (lastErr === "unauthorized") {
      _status.status = "error";
      _status.lastError = "unauthorized";
      await saveState();
      return { ok: false, reason: "unauthorized" };
    }
    const again = await readRemoteSyncDocument();
    if (again.ok) {
      baseRevision = Number(again.doc.revision) || baseRevision;
      if (again.etag) _status.lastRemoteEtag = again.etag;
      await applyRemoteDoc(again.doc, deviceId, "push_retry_pull");
    }
  }

  _status.status = "error";
  _status.lastError = lastErr || "push_failed";
  await enqueueOutbox(
    toSyncDocument(_getData(), {
      deviceId,
      docId: _status.docId,
      revision: baseRevision + 1,
      writtenAt: Date.now(),
    }),
    lastErr,
  );
  await saveState();
  return { ok: false, reason: lastErr || "push_failed" };
}

export async function pushNow(reason = "manual") {
  return enqueue(() => pushNowImpl(reason));
}

async function enqueueOutbox(doc, error) {
  const local = areaLocal();
  if (!local) return;
  const got = await storageGetKeys(local, [SYNC_OUTBOX_KEY]);
  const next = upsertSyncOutbox(got.value?.[SYNC_OUTBOX_KEY], {
    targetKey: SYNC_OUTBOX_TARGET,
    payload: doc,
    error,
  });
  await storageSetObj(local, { [SYNC_OUTBOX_KEY]: next });
}

async function clearOutboxSuccess() {
  const local = areaLocal();
  if (!local) return;
  const got = await storageGetKeys(local, [SYNC_OUTBOX_KEY]);
  const next = removeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY], SYNC_OUTBOX_TARGET);
  await storageSetObj(local, { [SYNC_OUTBOX_KEY]: next });
}

/**
 * 防抖推送
 */
export function schedulePush() {
  const data = _getData();
  if (!data?.settings?.syncEnabled) return;
  if (_pushTimer) clearTimeout(_pushTimer);
  _pushTimer = setTimeout(() => {
    _pushTimer = null;
    void pushNow("schedule").catch((e) => console.warn("schedulePush", e));
  }, SYNC_PUSH_DEBOUNCE_MS);
}

export function schedulePull(reason = "onChanged") {
  const data = _getData();
  if (!data?.settings?.syncEnabled) return;
  if (_pullTimer) clearTimeout(_pullTimer);
  _pullTimer = setTimeout(() => {
    _pullTimer = null;
    void pullNow(reason).catch((e) => console.warn("schedulePull", e));
  }, SYNC_PULL_DEBOUNCE_MS);
}

/**
 * 刷新 outbox 到期项
 */
export async function flushOutbox() {
  const data = _getData();
  if (!data?.settings?.syncEnabled) return { ok: true, skipped: true };
  const local = areaLocal();
  if (!local) return { ok: false, reason: "no_local" };
  const got = await storageGetKeys(local, [SYNC_OUTBOX_KEY]);
  const list = normalizeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY]);
  const item = list.find((x) => x.targetKey === SYNC_OUTBOX_TARGET);
  if (!item) return { ok: true, empty: true };
  if (!isSyncOutboxReady(item)) return { ok: true, wait: true };
  if (item.attempts >= SYNC_OUTBOX_MAX_ATTEMPTS) {
    _status.status = "error";
    _status.lastError = item.lastError || "outbox_exhausted";
    await saveState();
    return { ok: false, reason: "outbox_exhausted" };
  }
  return pushNow("outbox");
}

/**
 * 启用时初始化状态并尝试首同步
 */

/**
 * 解决 docId 冲突。
 * @param {"merge"|"local"|"remote"} choice
 */
export async function resolveDocConflict(choice) {
  return enqueue(async () => {
    const remote = _pendingConflictRemote;
    if (!remote) {
      return { ok: false, reason: "no_conflict" };
    }
    const deviceId = await getOrCreateDeviceId();
    const local = _getData();

    if (choice === "local") {
      // 本机覆盖云端：采用本机 docId 强制推送
      _status.docId = _status.conflictLocalDocId || _status.docId || createDocId();
      _pendingConflictRemote = null;
      _status.status = "idle";
      _status.lastError = "";
      delete _status.conflictRemoteDocId;
      delete _status.conflictLocalDocId;
      await saveState();
      // 提高 revision 盖过远端
      const remoteRead = await readRemoteSyncDocument();
      let base = 0;
      if (remoteRead.ok) base = Number(remoteRead.doc.revision) || 0;
      const doc = toSyncDocument(local, {
        deviceId,
        docId: _status.docId,
        revision: base + 1,
        writtenAt: Date.now(),
      });
      doc.contentHash = hashSyncDocument(doc);
      const err = await writeRemoteSyncDocument(doc);
      if (err) {
        _status.status = err.includes("quota") ? "quota" : "error";
        _status.lastError = err;
        await saveState();
        return { ok: false, reason: err };
      }
      _status.lastPushAt = Date.now();
      _status.lastRemoteRevision = doc.revision;
      _status.status = "idle";
      await saveState();
      return { ok: true, choice: "local" };
    }

    if (choice === "remote") {
      // 云端替换本机：接受远端 docId，强制应用远端（绕过 docId 检查）
      const forceDoc = { ...remote };
      _status.docId = forceDoc.docId;
      _pendingConflictRemote = null;
      delete _status.conflictRemoteDocId;
      delete _status.conflictLocalDocId;
      // 临时清空 local doc 绑定后 apply
      const merged = mergeHomepage(
        {
          schemaVersion: 1,
          settings: { ...(local.settings || {}) },
          groups: [],
          nodes: {},
          backups: local.backups || [],
          lastUpdated: 0,
        },
        forceDoc,
        { deviceId, now: Date.now() },
      );
      // 更好：直接用 from remote shape — merge empty local keeps remote
      if (!merged.ok) {
        // fallback: project remote only
        const shape = syncDocumentToHomepageShape(forceDoc);
        const state = {
          schemaVersion: 1,
          settings: { ...(local.settings || {}), ...(shape.settings || {}), syncEnabled: true },
          groups: shape.groups,
          nodes: shape.nodes,
          backups: local.backups || [],
          lastUpdated: Date.now(),
        };
        try {
          await _createSafety();
        } catch (_e) {}
        _setData(state);
        const err = await _saveLocal(state);
        if (err) return { ok: false, reason: err };
        await _onMerged(state, { applied: true, choice: "remote" });
      } else {
        merged.state.settings = { ...merged.state.settings, syncEnabled: true };
        try {
          await _createSafety();
        } catch (_e) {}
        _setData(merged.state);
        const err = await _saveLocal(merged.state);
        if (err) return { ok: false, reason: err };
        await _onMerged(merged.state, { ...merged.stats, choice: "remote" });
      }
      _status.status = "idle";
      _status.lastError = "";
      _status.lastPullAt = Date.now();
      _status.lastRemoteRevision = Number(forceDoc.revision) || 0;
      await saveState();
      // 再推一次确认
      await pushNowImpl("resolve_remote");
      return { ok: true, choice: "remote" };
    }

    // merge：两侧并集，docId 采用远端（已有云）并 push
    const merged = mergeHomepage(local, remote, { deviceId, now: Date.now() });
    if (!merged.ok) {
      // 若因 empty 等失败，仍尝试以 placements 并集：放宽 — 用远端 docId 强制 merge 忽略 doc check already done
      return { ok: false, reason: merged.reason || "merge_failed" };
    }
    _status.docId = remote.docId;
    _pendingConflictRemote = null;
    delete _status.conflictRemoteDocId;
    delete _status.conflictLocalDocId;
    try {
      await _createSafety();
    } catch (_e) {}
    _setData(merged.state);
    const err = await _saveLocal(merged.state);
    if (err) return { ok: false, reason: err };
    await _onMerged(merged.state, { ...merged.stats, choice: "merge" });
    _status.status = "idle";
    _status.lastError = "";
    _status.lastPullAt = Date.now();
    await saveState();
    await pushNowImpl("resolve_merge");
    return { ok: true, choice: "merge" };
  });
}

export function getPendingConflict() {
  if (!_pendingConflictRemote) return null;
  return {
    localDocId: _status.conflictLocalDocId || _status.docId,
    remoteDocId: _status.conflictRemoteDocId || _pendingConflictRemote.docId,
    remoteRevision: _pendingConflictRemote.revision,
  };
}

export async function onSyncEnabledChanged(enabled) {
  await loadState();
  if (!enabled) {
    _status.status = "off";
    await saveState();
    stopSyncInterval();
    return;
  }
  _status.status = "idle";
  if (!_status.docId) _status.docId = createDocId();
  await saveState();
  const pull = await pullNow("enable");
  if (pull?.needPush || pull?.empty || (pull?.ok && !pull?.merged)) {
    await pushNow("enable");
  } else if (pull?.ok && pull?.merged) {
    // 已从远端合并，再推一次拉齐 revision（push 内部会处理）
    await pushNow("enable_after_pull");
  }
  startSyncInterval();
}

/**
 * 停止周期同步定时器
 */
export function stopSyncInterval() {
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
  _intervalMsApplied = -1;
}

/**
 * 按 settings.syncInterval 启停周期 pull（随后必要时 push）
 * 本地变更仍走 schedulePush 防抖，不受「关闭周期」影响。
 */
export function startSyncInterval() {
  const data = _getData();
  if (!data?.settings?.syncEnabled) {
    stopSyncInterval();
    return;
  }
  const key = normalizeSyncInterval(data.settings.syncInterval);
  const ms = syncIntervalToMs(key);
  if (!ms) {
    stopSyncInterval();
    return;
  }
  if (_intervalTimer && _intervalMsApplied === ms) return;
  stopSyncInterval();
  _intervalMsApplied = ms;
  _intervalTimer = setInterval(() => {
    void (async () => {
      try {
        const live = _getData();
        if (!live?.settings?.syncEnabled) return;
        if (document.visibilityState && document.visibilityState === "hidden") return;
        const pull = await pullNow("interval");
        if (pull?.needPush || pull?.empty || (pull?.ok && !pull?.merged && pull?.reason !== "doc_conflict")) {
          // empty / 未合并：尝试推本地；doc_conflict 交给 UI
          if (pull?.reason !== "doc_conflict") await pushNow("interval");
        } else if (pull?.ok && pull?.merged) {
          await pushNow("interval_after_pull");
        }
      } catch (e) {
        console.warn("sync interval tick failed", e);
      }
    })();
  }, ms);
}

/**
 * 设置变更后调用：按最新 syncEnabled / syncInterval 重建定时器
 */
export function refreshSyncInterval() {
  startSyncInterval();
}

// 启动时加载状态
void loadState();
