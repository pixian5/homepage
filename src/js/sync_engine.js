/**
 * 同步引擎：local 权威 + HTTP 服务器推送/拉取 + merge
 */

import { getLastError, storageArea } from "./shared-utils.js";
import { httpConfirmSyncState, httpPullState, httpPushState } from "./sync_http_transport.js";
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
import {
  normalizeSyncInterval,
  SYNC_OUTBOX_MAX_ATTEMPTS,
  SYNC_PUSH_DEBOUNCE_MS,
  SYNC_REVISION_RETRY,
  SYNC_STATE_KEY,
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
function getTransportConfig() {
  const data = _getData();
  const settings = data?.settings || {};
  return {
    // 同步只走自建 HTTP 服务；浏览器 storage.sync 不再作为数据源或写入目标。
    mode: "http",
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
  lastRemoteEpoch: 0,
  bytesEstimate: 0,
  transport: "http",
};

let _pushTimer = null;
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

/**
 * 判断本次远端 revision 是否明确由另一台设备写入。
 *
 * revision 只表示服务端文档推进，并不代表写入方。变更时自动推送会先预拉取，
 * 同机此前写入的版本也可能在这里被读到；这种情况不能提示为“另一设备”。
 */
export function isRemoteUpdateFromAnotherDevice({ previousRemoteRevision, remoteRevision, remoteDeviceId, deviceId }) {
  const previous = Number(previousRemoteRevision) || 0;
  const remote = Number(remoteRevision) || 0;
  const remoteWriter = String(remoteDeviceId || "").trim();
  const localDevice = String(deviceId || "").trim();
  return previous > 0 && remote > previous && !!remoteWriter && !!localDevice && remoteWriter !== localDevice;
}

export function getSyncStatus() {
  const data = _getData();
  const transport = getTransportConfig();
  return {
    ..._status,
    enabled: !!data?.settings?.syncEnabled,
    transport: transport.mode,
    serverUrl: transport.baseUrl,
    // need_setup 即代表存在待处理冲突；resolveDocConflict 会按需恢复上下文。
    hasConflict: _status.status === "need_setup",
    bytesEstimate: data ? estimateSyncProjectionBytes(data, { deviceId: "x", docId: _status.docId || "y" }) : 0,
    budgetLevel: syncBytesBudgetLevel(
      data ? estimateSyncProjectionBytes(data, { deviceId: "x", docId: _status.docId || "y" }) : 0,
    ),
  };
}

/**
 * 读取 outbox 概况（只读，不改状态）。
 * 供同步异常提示条判断「自动重试是否已放弃」，不触发任何重试动作。
 * @returns {Promise<Array<{targetKey: string, attempts: number, maxAttempts: number, lastError: string, nextRetryAtMs: number}>>}
 */
export async function getOutboxSummary() {
  const local = areaLocal();
  if (!local) return [];
  try {
    const got = await storageGetKeys(local, [SYNC_OUTBOX_KEY]);
    const list = normalizeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY]);
    return list.map((item) => ({
      targetKey: item.targetKey,
      attempts: Number(item.attempts || 0),
      maxAttempts: SYNC_OUTBOX_MAX_ATTEMPTS,
      lastError: String(item.lastError || ""),
      nextRetryAtMs: Number(item.nextRetryAtMs || 0),
    }));
  } catch {
    return [];
  }
}

/**
 * 从存储重新加载同步状态（含冲突上下文）。
 * 页面刚打开时 loadState 可能还没跑完；调用方读状态前应 await 一次，
 * 否则会把存储里的 need_setup 误当成 idle，导致「解决冲突」按钮被隐藏。
 */
export async function reloadSyncState() {
  await loadState();
  return getSyncStatus();
}

async function loadState() {
  const local = areaLocal();
  if (!local) return;
  const got = await storageGetKeys(local, [SYNC_STATE_KEY, SYNC_OUTBOX_KEY]);
  const st = got.value?.[SYNC_STATE_KEY];
  if (st && typeof st === "object") {
    _status = { ..._status, ...st };
    // 恢复冲突标记：只要状态仍是 need_setup 就构造占位远端文档，
    // 让「解决冲突」按钮可用；真正内容在 resolve 时重新拉取。
    // 老状态可能没有 conflictRemoteDocId，此时 docId 留空，由 resolve 现场识别。
    if (_status.status === "need_setup") {
      _pendingConflictRemote = { docId: _status.conflictRemoteDocId || "" };
    }
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
      // epoch 必须持久化：页面重建后若跳过预拉取直接推送，仍要带上正确代际
      lastRemoteEpoch: _status.lastRemoteEpoch || 0,
      bytesEstimate: _status.bytesEstimate,
      transport: getTransportConfig().mode,
      // 冲突上下文必须持久化：新标签页/刷新后内存会重建，
      // 否则 UI 显示“需要处理冲突”，但「解决冲突」找不到待处理文档而无法执行。
      conflictLocalDocId: _status.conflictLocalDocId || "",
      conflictRemoteDocId: _status.conflictRemoteDocId || "",
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
  if (!transport.baseUrl) return { ok: false, reason: "no_url" };
  const res = await httpPullState({ baseUrl: transport.baseUrl, token: transport.token });
  if (!res.ok) {
    if (res.reason === "no_remote") return { ok: false, reason: "no_remote" };
    return { ok: false, reason: res.reason || "http_error", error: res.error, status: res.status };
  }
  _status.lastRemoteEtag = res.etag || "";
  // epoch 由服务端在回收墓碑时递增；客户端只跟随，不自增
  if (Number.isSafeInteger(res.epoch)) _status.lastRemoteEpoch = res.epoch;
  return { ok: true, doc: res.doc, etag: res.etag, revision: res.revision, epoch: res.epoch };
}

/**
 * 写入远端投影
 */
async function writeRemoteSyncDocument(doc) {
  const transport = getTransportConfig();
  if (!transport.baseUrl) return "no_url";
  const res = await httpPushState({ baseUrl: transport.baseUrl, token: transport.token }, doc, {
    ifMatch: _status.lastRemoteEtag || undefined,
    // 告诉服务端本机所处的压缩代际；落后时服务端会以 409 stale_epoch 拒绝
    epoch: _status.lastRemoteEpoch || 0,
    // 稳定幂等键（docId:revision:deviceId）：同一逻辑写入重试时服务端才能命中缓存去重
    idempotencyKey: `${doc.docId || "doc"}:${doc.revision || 0}:${doc.deviceId || "dev"}`,
  });
  if (res.ok) {
    _status.lastRemoteEtag = res.etag || _status.lastRemoteEtag;
    if (res.revision) doc.revision = res.revision;
    return null;
  }
  if (res.reason === "precondition_failed") {
    // 把远端 doc 塞回，供上层 merge 重试
    if (res.remote?.doc) {
      return { code: "precondition_failed", remote: res.remote, etag: res.etag, revision: res.revision };
    }
    return "precondition_failed";
  }
  if (res.reason === "unauthorized") return "unauthorized";
  if (res.reason === "network_error") return res.error || "network_error";
  if (res.reason === "stale_epoch" || res.status === 409) {
    // 服务端已压缩墓碑并进入新一代：本机必须重新取基线，不能继续推送旧整包
    return { code: "stale_epoch", epoch: res.epoch };
  }
  return res.error || res.reason || "http_error";
}

/**
 * Pull + merge 到本地
 */
export async function pullNow(reason = "manual") {
  return enqueue(async () => {
    // 每个新标签页都有独立的引擎实例。解决冲突后 docId 只写进存储，
    // 其它页面若继续用内存里的旧 docId 会再次判定冲突并覆盖回 need_setup。
    // 因此每次同步前先采纳存储中的最新状态。
    await loadState();
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
      _status.status = "error";
      _status.lastError = remote.reason || "pull_failed";
      await saveState();
      return { ok: false, reason: remote.reason };
    }

    // 版本号没变 = 服务端没有任何新内容。此时完全不必 merge：
    // 合并会重算整份数据、必要时触发 render，而 render 会重新应用「副作用型」设置，
    // 表现出来就是「什么都没改，壁纸却被重刷了一次」。
    const prevRevision = Number(_status.lastRemoteRevision) || 0;
    const remoteRevision = Number(remote.doc.revision) || 0;
    if (prevRevision > 0 && remoteRevision === prevRevision) {
      _status.lastPullAt = Date.now();
      _status.status = "idle";
      _status.lastError = "";
      if (remote.etag) _status.lastRemoteEtag = remote.etag;
      await saveState();
      return { ok: true, merged: false, unchanged: true, reason };
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
  const remoteDeviceId = String(doc.deviceId || "");
  const remoteNewer = isRemoteUpdateFromAnotherDevice({
    previousRemoteRevision: prevRemoteRevision,
    remoteRevision,
    remoteDeviceId,
    deviceId,
  });

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
      remoteDeviceId,
      reason,
    });
  }

  _status.lastPullAt = Date.now();
  _status.lastRemoteRevision = remoteRevision;
  _status.status = "idle";
  _status.lastError = "";
  _status.docId = doc.docId || _status.docId;
  await saveState();
  // 只有“本地已保存且状态已落盘”之后才确认 revision；
  // 保存失败在上面的分支已经提前返回，不会走到这里。
  await confirmRemoteRevision(remoteRevision, deviceId);
  return {
    ok: true,
    merged: !!merged.stats?.applied,
    stats: { ...merged.stats, remoteNewer, remoteRevision, remoteDeviceId },
    reason,
  };
}

/**
 * 本地已把远端 revision 持久保存后，向服务端确认进度。
 * 第一阶段服务端只记录、不回收；确认失败也不影响同步结果，因此吞掉错误。
 */
async function confirmRemoteRevision(revision, deviceId) {
  const transport = getTransportConfig();
  if (!transport.baseUrl || !deviceId) return;
  if (!Number.isSafeInteger(revision) || revision <= 0) return;
  try {
    await httpConfirmSyncState(
      { baseUrl: transport.baseUrl, token: transport.token },
      { deviceId, revision, protocol: 2 },
    );
  } catch (e) {
    console.warn("confirm sync revision failed", e);
  }
}

/**
 * 推送本地投影（可在 pull 的 enqueue 内调用，勿再包 enqueue）
 */
/** 读取待推送队列（推送前判断有没有必须发出去的本地改动） */
async function readOutboxItems() {
  const got = await storageGetKeys(areaLocal(), [SYNC_OUTBOX_KEY]);
  if (!got.ok) return [];
  return normalizeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY]);
}

/**
 * 本地内容是否与远端那份完全一致。
 *
 * 不能直接比 contentHash：哈希覆盖整份文档，包含 deviceId / revision / writtenAt，
 * 两台设备算出来天然不同。这里用**远端那份的这三个值**重建本地文档再算哈希，
 * 内容一致时两者才会相等。
 *
 * @param {object} data 本地数据
 * @param {object} remoteDoc 远端同步文档（必须带 contentHash 与 writtenAt）
 * @param {string} [docId]
 * @returns {boolean}
 */
export function isContentEqualToRemote(data, remoteDoc, docId) {
  if (!remoteDoc?.contentHash) return false;
  const writtenAt = Number(remoteDoc.writtenAt);
  if (!writtenAt) return false;
  try {
    const localDoc = toSyncDocument(data, {
      deviceId: remoteDoc.deviceId,
      docId: docId || remoteDoc.docId,
      revision: Number(remoteDoc.revision) || 0,
      writtenAt,
    });
    return localDoc.contentHash === remoteDoc.contentHash;
  } catch {
    return false;
  }
}

async function pushNowImpl(reason = "manual") {
  await loadState();
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
  /** 本轮实际对照的远端文档（预拉取后会重取一次，可能更新） */
  let latestRemote = null;
  const remote = await readRemoteSyncDocument();
  if (remote.ok && remote.doc) {
    if (remote.doc.docId && _status.docId && remote.doc.docId !== _status.docId) {
      _status.status = "need_setup";
      _status.lastError = "doc_conflict";
      // 记录冲突双方 docId，刷新/新标签页后才能恢复「解决冲突」
      _pendingConflictRemote = remote.doc;
      _status.conflictRemoteDocId = remote.doc.docId;
      _status.conflictLocalDocId = _status.docId;
      await saveState();
      return { ok: false, reason: "doc_conflict" };
    }
    baseRevision = Number(remote.doc.revision) || 0;
    if (baseRevision > (_status.lastRemoteRevision || 0)) {
      const pulled = await applyRemoteDoc(remote.doc, deviceId, "push_pre_pull");
      if (!pulled.ok && pulled.reason === "doc_conflict") return pulled;
    }
    latestRemote = remote;
    const again = await readRemoteSyncDocument();
    if (again.ok) {
      baseRevision = Number(again.doc.revision) || baseRevision;
      latestRemote = again;
    }
  }

  // 内容与远端完全一致、且没有待推送项时，不再写新 revision。
  // 否则多设备会「拉取 → 落盘 → 再推送」互相推高版本号：
  // 每台设备每次打开页面都 +1，其它设备下次加载必然判「有较新数据」，提示和流量都被放大。
  if (latestRemote?.doc && isContentEqualToRemote(_getData(), latestRemote.doc, _status.docId)) {
    const pending = await readOutboxItems();
    if (!pending.length) {
      _status.status = "idle";
      _status.lastError = "";
      _status.lastRemoteRevision = Number(latestRemote.doc.revision) || baseRevision;
      if (latestRemote.etag) _status.lastRemoteEtag = latestRemote.etag;
      await saveState();
      return { ok: true, skipped: true, reason: "unchanged" };
    }
  }

  let lastErr = null;
  for (let attempt = 0; attempt < SYNC_REVISION_RETRY; attempt++) {
    // 每次重取本地快照：412/重试分支可能刚把远端合并进本地（setData 整体替换引用），
    // 沿用循环外的旧快照会把并发方刚合并进来的变更从服务端抹掉
    const latest = _getData();
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
      // 推送成功说明本机持有该版本，可以确认
      await confirmRemoteRevision(revision, deviceId);
      return { ok: true, revision, reason };
    }
    // HTTP 412：服务端返回最新状态
    if (writeErr && typeof writeErr === "object" && writeErr.code === "precondition_failed") {
      lastErr = "precondition_failed";
      const remoteDoc = writeErr.remote?.doc;
      if (remoteDoc) {
        baseRevision = Number(writeErr.remote.revision || remoteDoc.revision) || baseRevision;
        // 412 响应携带服务端最新 etag，必须立即采纳；
        // 否则后续重试仍带旧 If-Match，只会一次次再 412 直到重试耗尽
        if (writeErr.etag) _status.lastRemoteEtag = writeErr.etag;
        const applied = await applyRemoteDoc(remoteDoc, deviceId, "push_412_pull");
        if (!applied.ok) {
          lastErr = applied.reason || "merge_failed";
          break;
        }
        continue;
      }
    } else {
      lastErr = typeof writeErr === "string" ? writeErr : writeErr?.code || "push_failed";
    }
    if (lastErr === "unauthorized") {
      _status.status = "error";
      _status.lastError = "unauthorized";
      await saveState();
      return { ok: false, reason: "unauthorized" };
    }
    if (lastErr === "stale_epoch") {
      // 服务端已完成墓碑回收并进入新一代：本机先拉取新基线，本轮推送作废。
      // 不进入 outbox 重试，避免把旧整包反复推给新代际。
      const epoch = writeErr?.epoch;
      if (Number.isSafeInteger(epoch)) _status.lastRemoteEpoch = epoch;
      _status.status = "error";
      _status.lastError = "stale_epoch";
      await saveState();
      const refreshed = await readRemoteSyncDocument();
      if (refreshed.ok) await applyRemoteDoc(refreshed.doc, deviceId, "push_stale_epoch");
      return { ok: false, reason: "stale_epoch" };
    }
    const again = await readRemoteSyncDocument();
    if (again.ok) {
      baseRevision = Number(again.doc.revision) || baseRevision;
      if (again.etag) _status.lastRemoteEtag = again.etag;
      const applied = await applyRemoteDoc(again.doc, deviceId, "push_retry_pull");
      if (!applied.ok) {
        lastErr = applied.reason || "merge_failed";
        break;
      }
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

/** 取消尚未执行的本地变更防抖推送（手动/首次同步会自行写入）。 */
export function cancelScheduledPush() {
  if (!_pushTimer) return;
  clearTimeout(_pushTimer);
  _pushTimer = null;
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
    let remote = _pendingConflictRemote;
    if (!remote) {
      // 老版本写入的状态可能只有 need_setup 而没有冲突上下文；
      // 只要云端确实与本机 docId 不同，就现场恢复上下文，而不是让按钮点了没反应。
      if (_status.status !== "need_setup") {
        return { ok: false, reason: "no_conflict" };
      }
      const current = await readRemoteSyncDocument();
      if (!current.ok) return { ok: false, reason: current.reason || "remote_unavailable" };
      if (!_status.docId || current.doc.docId === _status.docId) {
        // 云端已经不是冲突文档了，清掉过期状态
        _status.status = "idle";
        _status.lastError = "";
        await saveState();
        return { ok: false, reason: "no_conflict" };
      }
      remote = current.doc;
      _pendingConflictRemote = remote;
      _status.conflictRemoteDocId = remote.docId;
      _status.conflictLocalDocId = _status.docId;
      await saveState();
    }
    // 状态从存储恢复时只有 docId（占位对象），没有节点/分组内容。
    // merge/remote 分支都需要完整远端文档，这里重新拉取一次。
    if (!Array.isArray(remote.nodes) && !Array.isArray(remote.groups)) {
      const fresh = await readRemoteSyncDocument();
      if (!fresh.ok) {
        return { ok: false, reason: fresh.reason || "remote_unavailable" };
      }
      if (remote.docId && fresh.doc.docId !== remote.docId) {
        // 云端在这期间又被换成了第三个文档，保持冲突状态让用户重新判断
        _pendingConflictRemote = fresh.doc;
        _status.conflictRemoteDocId = fresh.doc.docId;
        await saveState();
        return { ok: false, reason: "doc_conflict" };
      }
      // remote.docId 为空表示老状态没有记录，直接采用现场拉到的文档

      remote = fresh.doc;
      _pendingConflictRemote = remote;
    }
    const deviceId = await getOrCreateDeviceId();
    const local = _getData();

    if (choice === "local") {
      // 本机覆盖云端：采用本机 docId 强制推送
      const localDocId = _status.conflictLocalDocId || _status.docId || createDocId();
      _status.docId = localDocId;
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
        const errorCode = typeof err === "string" ? err : err?.code || "push_failed";
        if (typeof err === "object" && err?.remote?.doc) {
          _pendingConflictRemote = err.remote.doc;
          _status.conflictRemoteDocId = err.remote.doc.docId || _status.conflictRemoteDocId;
          if (err.etag) _status.lastRemoteEtag = err.etag;
        }
        _status.conflictLocalDocId = localDocId;
        _status.status = "need_setup";
        _status.lastError = errorCode;
        await saveState();
        return { ok: false, reason: errorCode };
      }
      _pendingConflictRemote = null;
      delete _status.conflictRemoteDocId;
      delete _status.conflictLocalDocId;
      _status.lastPushAt = Date.now();
      _status.lastRemoteRevision = doc.revision;
      _status.status = "idle";
      // 冲突已解决，必须清掉 doc_conflict，否则状态栏会一直显示上一次的错误
      _status.lastError = "";
      await saveState();
      return { ok: true, choice: "local" };
    }

    if (choice === "remote") {
      // 云端替换本机：接受远端 docId，强制应用远端（绕过 docId 检查）
      // 重要：remote 可能是 loadState 恢复出的占位对象（只有 docId），
      // 必须重新拉取完整文档，否则会用空对象覆盖本地。
      let forceDoc = { ...remote };
      if (!Array.isArray(forceDoc.nodes) || !Array.isArray(forceDoc.groups)) {
        const fresh = await readRemoteSyncDocument();
        if (!fresh.ok) {
          return { ok: false, reason: fresh.reason || "remote_unavailable" };
        }
        forceDoc = fresh.doc;
        _status.lastRemoteEtag = fresh.etag || _status.lastRemoteEtag;
      }
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
        // unchanged = 远端版本号没变，本地也没有需要补推的东西，直接结束这一轮
        if (pull?.unchanged) return;
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
