/**
 * 同步引擎：local 权威 + HTTP 服务器推送/拉取 + merge
 */

import { isLocalTrimWarning } from "./shared-utils.js";
import { createSyncConflictResolver } from "./sync_conflict_resolver.js";
import { decryptSyncDocument, encryptSyncDocument, isEncryptedSyncEnvelope } from "./sync_crypto.js";
import { createSyncDeviceAuth } from "./sync_device_auth.js";
import { httpConfirmSyncState, httpPairDevice, httpPullState, httpPushState } from "./sync_http_transport.js";
import { createDocId, getOrCreateDeviceId } from "./sync_ids.js";
import { mergeHomepage } from "./sync_merge.js";
import {
  HOMEPAGE_SCHEMA_VERSION,
  normalizeSyncInterval,
  SYNC_PUSH_DEBOUNCE_MS,
  SYNC_REVISION_RETRY,
  syncBytesBudgetLevel,
  syncIntervalToMs,
} from "./sync_policy.js";
import {
  estimateSyncProjectionBytes,
  hashSyncDocument,
  syncDocumentToHomepageShape,
  toSyncDocument,
} from "./sync_projection.js";
import {
  clearOutboxRecord,
  enqueueOutboxRecord,
  readOutboxItems,
  readOutboxSummary,
  readPendingOutboxItem,
  readSyncStateAndCleanOutbox,
  writeSyncStateRecord,
} from "./sync_state_store.js";

const deviceAuth = createSyncDeviceAuth({
  getData: () => _getData(),
  saveLocal: (next) => _saveLocal(next),
  getOrCreateDeviceId,
  httpPairDevice,
  onDeviceRetired: async () => {
    _status.status = "device_retired";
    _status.lastError = "设备已被管理员注销 (403)";
    stopSyncInterval();
    cancelScheduledPush();
    await saveState();
  },
});

function getTransportConfig() {
  return deviceAuth.getTransportConfig();
}

async function getTransportAuth() {
  return deviceAuth.getTransportAuth();
}

export async function ensureDevicePairing() {
  return deviceAuth.ensureDevicePairing();
}

async function dropStaleDeviceCredentials() {
  return deviceAuth.dropStaleDeviceCredentials();
}

async function markDeviceRetired() {
  return deviceAuth.markDeviceRetired();
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
  installVisibilitySync();
}

/**
 * 切回标签页时补拉一次（60 秒节流）。
 *
 * 「同步间隔 = 关闭」只关掉周期轮询；用户切回页面时应该看到别处的最新数据，
 * 否则就变成「别的设备改了，这边永远不动」。远端没变时 pullNow 会直接短路，不会重绘。
 */
const VISIBILITY_SYNC_MIN_MS = 60_000;
let _visibilityBound = false;
let _lastVisibilitySyncAt = 0;

function installVisibilitySync() {
  if (_visibilityBound) return;
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  _visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const data = _getData();
    if (!data?.settings?.syncEnabled) return;
    const now = Date.now();
    if (now - _lastVisibilitySyncAt < VISIBILITY_SYNC_MIN_MS) return;
    _lastVisibilitySyncAt = now;
    void pullNow("visible")
      .then((res) => {
        // 合并后本地仍与远端不同 → 推上去收敛
        if (res?.needPush) return pushNow("visible_need_push");
        return null;
      })
      .catch((e) => console.warn("visibility sync failed", e));
  });
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

export async function getOutboxSummary() {
  return readOutboxSummary();
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
  const st = await readSyncStateAndCleanOutbox();
  if (st) {
    _status = { ..._status, ...st };
    // 恢复冲突标记：只要状态仍是 need_setup 就构造占位远端文档，
    // 让「解决冲突」按钮可用；真正内容在 resolve 时重新拉取。
    if (_status.status === "need_setup") {
      _pendingConflictRemote = { docId: _status.conflictRemoteDocId || "" };
    }
  }
}

async function saveState() {
  await writeSyncStateRecord({
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

function getE2eeConfig() {
  const settings = _getData()?.settings || {};
  return {
    enabled: !!settings.syncE2eeEnabled,
    passphrase: String(settings.syncE2eePassphrase || ""),
  };
}

async function decodeRemoteDocIfEncrypted(remoteDoc) {
  if (!remoteDoc || !isEncryptedSyncEnvelope(remoteDoc)) {
    return { ok: true, doc: remoteDoc };
  }
  const { passphrase } = getE2eeConfig();
  try {
    const plain = await decryptSyncDocument(remoteDoc, passphrase);
    return { ok: true, doc: plain };
  } catch (error) {
    return { ok: false, reason: error?.code || "e2ee_decrypt_failed" };
  }
}

/**
 * 读取远端 SyncDocument
 */
export async function readRemoteSyncDocument() {
  const transport = await getTransportAuth();
  if (!transport.baseUrl) return { ok: false, reason: "no_url" };
  const res = await httpPullState(transport);
  if (!res.ok) {
    if (res.reason === "no_remote") {
      // 云端无数据：旧 etag（可能来自其它服务器或重置前的库）已无意义，
      // 必须清掉——否则首写带着旧 If-Match，与占位状态 etag 不匹配会 412 且无法自愈
      _status.lastRemoteEtag = "";
      return { ok: false, reason: "no_remote" };
    }
    if (res.reason === "device_retired") {
      // 退役熔断：停掉周期与防抖，状态直接暴露给设置面板
      await markDeviceRetired();
      return { ok: false, reason: "device_retired" };
    }
    if (res.reason === "unauthorized" && transport.deviceSecret) {
      // 设备凭据失配（服务器重建/换库）：清凭据，下一轮自动重新配对
      await dropStaleDeviceCredentials();
    }
    return { ok: false, reason: res.reason || "http_error", error: res.error, status: res.status };
  }
  const wasEncrypted = isEncryptedSyncEnvelope(res.doc);
  const decoded = await decodeRemoteDocIfEncrypted(res.doc);
  if (!decoded.ok) {
    return { ok: false, reason: decoded.reason };
  }
  _status.lastRemoteEtag = res.etag || "";
  // epoch 由服务端在回收墓碑时递增；客户端只跟随，不自增
  if (Number.isSafeInteger(res.epoch)) _status.lastRemoteEpoch = res.epoch;
  return { ok: true, doc: decoded.doc, etag: res.etag, revision: res.revision, epoch: res.epoch, wasEncrypted };
}

/**
 * 写入远端投影
 */
async function writeRemoteSyncDocument(doc) {
  const transport = await getTransportAuth();
  if (!transport.baseUrl) return "no_url";
  let payloadDoc = doc;
  const e2ee = getE2eeConfig();
  if (e2ee.enabled) {
    if (!e2ee.passphrase) return "e2ee_passphrase_required";
    try {
      payloadDoc = await encryptSyncDocument(doc, e2ee.passphrase);
    } catch (error) {
      return error?.code || "e2ee_encrypt_failed";
    }
  }
  const res = await httpPushState(transport, payloadDoc, {
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
    // 把远端 doc 塞回，供上层 merge 重试（若远端为加密信封先在本地解密）
    if (res.remote?.doc) {
      const decoded = await decodeRemoteDocIfEncrypted(res.remote.doc);
      if (!decoded.ok) return decoded.reason;
      return {
        code: "precondition_failed",
        remote: { ...res.remote, doc: decoded.doc },
        etag: res.etag,
        revision: res.revision,
      };
    }
    return "precondition_failed";
  }
  if (res.reason === "unauthorized") {
    if (transport.deviceSecret) await dropStaleDeviceCredentials();
    return "unauthorized";
  }
  if (res.reason === "device_retired") {
    await markDeviceRetired();
    return "device_retired";
  }
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
    // docId 必须在本轮第一次 saveState 之前就绪。
    // 旧问题（26.4.0 排查）：状态里存着 docId: null 时，loadState 会把 null 覆盖回内存，
    // 随后的 saveState() 把 null 落盘；再进入 pushNowImpl 才会 createDocId()。
    // 若在两者之间发生页面重载或多标签页竞争，就会把空 docId 推给服务端，
    // 被以 invalid_doc_id 拒绝（同步直接失败）。这里提前生成即可封死该窗口。
    if (!_status.docId) _status.docId = createDocId();
    _status.status = "syncing";
    _status.lastError = "";
    await saveState();

    // 初次同步前自动配对设备独立凭据（无 Master Token 或已配对时为空操作）
    await ensureDevicePairing();
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
      if (remote.reason === "device_retired") {
        // 状态与定时器已在 readRemoteSyncDocument 内熔断处理
        return { ok: false, reason: "device_retired" };
      }
      _status.status = "error";
      _status.lastError = remote.reason || "pull_failed";
      await saveState();
      return { ok: false, reason: remote.reason };
    }

    // 版本号没变 = 服务端没有任何新内容，不必 merge：
    // 合并会重算整份数据、必要时触发 render，而 render 会重新应用「副作用型」设置。
    //
    // 但**不能只看共享状态里的 lastRemoteRevision**：同一浏览器的多个标签页共享这份状态，
    // A 标签拉到 88 之后，B 标签读到 88 就会以为自己也最新了——而 B 内存里的 data
    // 可能还停在 84，于是它永远不合并、界面一直显示旧设置。
    // 所以再加一条：本地数据自己的 _syncMeta.revision 也必须已经等于远端版本。
    // 判「有没有变化」只看内容，不看版本号记账。
    // 同机多标签共享 sync_state，版本号一致并不代表本实例的数据也是那一版；
    // 实测还出现过「版本号相同、内容不同」的僵局（本地 color、服务端 bing），
    // 靠版本号永远自愈不了，只会一直显示旧设置。
    // 内容一致时直接返回：不合并、不 render，也就不会重刷壁纸。
    if (isContentEqualToRemote(_getData(), remote.doc, _status.docId)) {
      _status.lastPullAt = Date.now();
      _status.status = "idle";
      _status.lastError = "";
      _status.lastRemoteRevision = Number(remote.doc.revision) || _status.lastRemoteRevision || 0;
      if (remote.etag) _status.lastRemoteEtag = remote.etag;
      await saveState();
      const e2ee = getE2eeConfig();
      const encryptionMismatch =
        Boolean(remote.wasEncrypted) !== Boolean(e2ee.enabled) && (!e2ee.enabled || Boolean(e2ee.passphrase));
      return {
        ok: true,
        merged: false,
        unchanged: !encryptionMismatch,
        ...(encryptionMismatch ? { needPush: true } : {}),
        reason,
      };
    }

    return applyRemoteDoc(remote.doc, deviceId, reason);
  });
}

/**
 * 先将合并结果安全落盘再切换内存引用，避免写盘失败/抛错后出现内存已污染、磁盘仍为旧值的裂脑状态。
 * saveData 返回的 `local_trimmed_*` 哨兵代表配额自动裁剪后已成功落盘，不得按失败处理。
 * @param {object} nextState
 * @returns {Promise<{ ok: true, warning?: string } | { ok: false, error: string }>}
 */
async function persistMergedLocalState(nextState) {
  let warning = "";
  try {
    const err = await _saveLocal(nextState);
    if (err) {
      if (isLocalTrimWarning(err)) {
        warning = err;
      } else {
        return { ok: false, error: typeof err === "string" ? err : err?.message || String(err) };
      }
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) || "local_write_failed" };
  }
  _setData(nextState);
  return warning ? { ok: true, warning } : { ok: true };
}

/**
 * 在提交冲突解决前先落盘再切换 docId 与清理冲突上下文，确保写盘失败时冲突状态可完整重试。
 * @param {object} nextState
 * @param {string} targetDocId
 * @param {object} onMergedStats
 * @returns {Promise<{ ok: true, warning?: string } | { ok: false, reason: string }>}
 */
async function applyConflictLocalState(nextState, targetDocId, onMergedStats) {
  try {
    await _createSafety();
  } catch (_e) {}
  const saved = await persistMergedLocalState(nextState);
  if (!saved.ok) {
    _status.status = "need_setup";
    _status.lastError = saved.error;
    await saveState();
    return { ok: false, reason: saved.error };
  }
  _status.docId = targetDocId;
  _pendingConflictRemote = null;
  delete _status.conflictRemoteDocId;
  delete _status.conflictLocalDocId;
  await _onMerged(nextState, saved.warning ? { ...onMergedStats, warning: saved.warning } : onMergedStats);
  return saved.warning ? { ok: true, warning: saved.warning } : { ok: true };
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
    const saved = await persistMergedLocalState(merged.state);
    if (!saved.ok) {
      _status.status = "error";
      _status.lastError = saved.error;
      await saveState();
      return { ok: false, reason: "local_write_failed", error: saved.error };
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
    // 合并后的本地内容若仍与远端不同，说明本地「赢了」某个字段——
    // 必须把它推上去，否则服务端永远保留旧值，两端长期不一致（背景来回切换就是这么来的）。
    needPush: !isContentEqualToRemote(_getData(), doc, _status.docId),
    stats: { ...merged.stats, remoteNewer, remoteRevision, remoteDeviceId },
    reason,
  };
}

/**
 * 本地已把远端 revision 持久保存后，向服务端确认进度。
 * 第一阶段服务端只记录、不回收；确认失败也不影响同步结果，因此吞掉错误。
 */
async function confirmRemoteRevision(revision, deviceId) {
  const transport = await getTransportAuth();
  if (!transport.baseUrl || !deviceId) return;
  if (!Number.isSafeInteger(revision) || revision <= 0) return;
  try {
    await httpConfirmSyncState(transport, { deviceId, revision, protocol: 2 });
  } catch (e) {
    console.warn("confirm sync revision failed", e);
  }
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

  // 推送前同样先补配对：设置刚保存完（未发生过 pull）时首次动作可能就是 push
  await ensureDevicePairing();
  const deviceId = await getOrCreateDeviceId();
  if (!_status.docId) _status.docId = createDocId();

  let baseRevision = 0;
  /** 本轮实际对照的远端文档（预拉取后会重取一次，可能更新） */
  let latestRemote = null;
  const remote = await readRemoteSyncDocument();
  // 退役设备：预拉取阶段即被 403 拒绝，状态已熔断，不再进入推送与 outbox 重试
  if (remote.reason === "device_retired") {
    return { ok: false, reason: "device_retired" };
  }
  // E2EE 解密失败/缺少口令或鉴权失效时禁止跳过预拉取直接覆盖云端（防止明文覆写云端密文或覆盖他人修改）
  if (
    !remote.ok &&
    (remote.reason === "e2ee_passphrase_required" ||
      remote.reason === "e2ee_decrypt_failed" ||
      remote.reason === "unauthorized")
  ) {
    _status.status = "error";
    _status.lastError = remote.reason;
    await saveState();
    return { ok: false, reason: remote.reason };
  }
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
    latestRemote = remote;

    // 关键：不再用「revision 是否比本机记录更新」来决定要不要预拉取。
    // 同一台机器上的多个标签页、多个浏览器共享一份数据，某个实例的 lastRemoteRevision
    // 可能已经被别的实例推到最新，但它内存里的 data 还没重载（storage 监听是防抖的）。
    // 这种情况下直接推，会把整份旧快照写上去，覆盖别处刚做的修改——
    // 表现出来就是「在一个浏览器里改了，过一会儿被另一个浏览器改回去」。
    // 改成按内容判断：本地与远端不一致，就一定先把远端合并进来再推。
    const sameAsRemote = isContentEqualToRemote(_getData(), remote.doc, _status.docId);
    if (!sameAsRemote) {
      const pulled = await applyRemoteDoc(remote.doc, deviceId, "push_pre_pull");
      if (!pulled.ok) return pulled;
      // 合并可能把远端最新内容写进本地，重取一次拿到最新 revision / etag
      const again = await readRemoteSyncDocument();
      if (again.ok) {
        baseRevision = Number(again.doc.revision) || baseRevision;
        latestRemote = again;
      }
    }
  }

  // 内容与远端完全一致、且没有待推送项时，不再写新 revision。
  // 否则多设备会「拉取 → 落盘 → 再推送」互相推高版本号：
  // 每台设备每次打开页面都 +1，其它设备下次加载必然判「有较新数据」，提示和流量都被放大。
  const e2ee = getE2eeConfig();
  const encryptionMatches = Boolean(latestRemote?.wasEncrypted) === Boolean(e2ee.enabled);
  if (latestRemote?.doc && encryptionMatches && isContentEqualToRemote(_getData(), latestRemote.doc, _status.docId)) {
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
      // 推送成功后，本地内容此刻就等于刚写上去的 revision，把它记进数据本身。
      // pull 的短路判断（以及多标签场景）需要「这份 data 究竟处于哪一版」这个事实，
      // 只靠共享状态里的 lastRemoteRevision 会被别的标签页带偏。
      const current = _getData();
      if (current && typeof current === "object") {
        current._syncMeta = {
          ...(current._syncMeta && typeof current._syncMeta === "object" ? current._syncMeta : {}),
          docId: _status.docId,
          revision,
          contentHash: doc.contentHash,
        };
        try {
          await _saveLocal(current);
        } catch (e) {
          console.warn("record local revision failed", e);
        }
      }
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
    if (lastErr === "unauthorized" || lastErr === "e2ee_passphrase_required" || lastErr === "e2ee_decrypt_failed") {
      _status.status = "error";
      _status.lastError = lastErr;
      await saveState();
      return { ok: false, reason: lastErr };
    }
    if (lastErr === "device_retired") {
      // 已熔断（writeRemoteSyncDocument 内处理状态与定时器）；
      // 关键：不进 outbox 重试——退役设备重试永远 403，只会空转
      return { ok: false, reason: "device_retired" };
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

/**
 * E2EE 端到端加密口令安全轮换：
 * 1) 先用 oldPassphrase 拉取并解密合并云端最新数据；
 * 2) 构造 SyncDocument 并显式用 newPassphrase 重新加密推送（若遇 412 重试一次）；
 * 3) 云端落盘成功后再原子更新本机保存的 syncE2eePassphrase 并写入 _saveLocal。
 * 任一校验或加解密步骤失败均保持旧口令与云端密文原封不动。
 *
 * @param {{ oldPassphrase: string, newPassphrase: string }} params
 */
export async function rotateE2eePassphrase({ oldPassphrase, newPassphrase } = {}) {
  return enqueue(async () => {
    const oldSecret = String(oldPassphrase || "");
    const newSecret = String(newPassphrase || "");
    if (!oldSecret || !newSecret) return { ok: false, reason: "invalid_passphrase" };
    if (oldSecret === newSecret) return { ok: false, reason: "passphrase_unchanged" };

    await loadState();
    const initialData = _getData();
    if (!initialData?.settings?.syncEnabled) {
      return { ok: false, reason: "sync_disabled" };
    }

    await ensureDevicePairing();
    const transport = await getTransportAuth();
    if (!transport.baseUrl) return { ok: false, reason: "no_url" };
    const deviceId = await getOrCreateDeviceId();
    if (!_status.docId) _status.docId = createDocId();

    const decodeWithOldSecret = async (rawDoc) => {
      if (!rawDoc || !isEncryptedSyncEnvelope(rawDoc)) return { ok: true, doc: rawDoc };
      try {
        return { ok: true, doc: await decryptSyncDocument(rawDoc, oldSecret) };
      } catch (e) {
        return { ok: false, reason: e?.code || "e2ee_decrypt_failed" };
      }
    };

    const pull = await httpPullState(transport);
    let baseRevision = 0;
    if (pull.ok) {
      const decoded = await decodeWithOldSecret(pull.doc);
      if (!decoded.ok) {
        _status.status = "error";
        _status.lastError = decoded.reason;
        await saveState();
        return { ok: false, reason: decoded.reason };
      }
      _status.lastRemoteEtag = pull.etag || _status.lastRemoteEtag;
      if (Number.isSafeInteger(pull.epoch)) _status.lastRemoteEpoch = pull.epoch;
      baseRevision = Number(decoded.doc?.revision || pull.revision) || 0;
      if (!isContentEqualToRemote(_getData(), decoded.doc, _status.docId)) {
        const applied = await applyRemoteDoc(decoded.doc, deviceId, "e2ee_rotate_pull");
        if (!applied.ok) return applied;
      }
    } else if (pull.reason !== "no_remote") {
      if (pull.reason === "device_retired") {
        await markDeviceRetired();
      } else if (pull.reason === "unauthorized" && transport.deviceSecret) {
        await dropStaleDeviceCredentials();
      }
      _status.status = pull.reason === "device_retired" ? "device_retired" : "error";
      _status.lastError = pull.reason || "pull_failed";
      await saveState();
      return { ok: false, reason: pull.reason || "pull_failed", error: pull.error };
    }

    let pushRes = null;
    let pushedDoc = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const latest = _getData();
      const revision = baseRevision + 1;
      const doc = toSyncDocument(latest, {
        deviceId,
        docId: _status.docId,
        revision,
        writtenAt: Date.now(),
      });
      doc.contentHash = hashSyncDocument(doc);
      let envelope;
      try {
        envelope = await encryptSyncDocument(doc, newSecret);
      } catch (e) {
        return { ok: false, reason: e?.code || "e2ee_encrypt_failed" };
      }
      pushRes = await httpPushState(await getTransportAuth(), envelope, {
        ifMatch: _status.lastRemoteEtag || undefined,
        epoch: _status.lastRemoteEpoch || 0,
        idempotencyKey: `rotate:${doc.docId}:${revision}:${deviceId}`,
      });
      if (pushRes.ok) {
        pushedDoc = doc;
        break;
      }
      if (pushRes.reason === "precondition_failed" && pushRes.remote?.doc && attempt === 0) {
        if (pushRes.etag) _status.lastRemoteEtag = pushRes.etag;
        if (Number.isSafeInteger(pushRes.epoch)) _status.lastRemoteEpoch = pushRes.epoch;
        const retryDecoded = await decodeWithOldSecret(pushRes.remote.doc);
        if (!retryDecoded.ok) return { ok: false, reason: retryDecoded.reason };
        baseRevision = Number(pushRes.revision || retryDecoded.doc?.revision) || baseRevision;
        const applied = await applyRemoteDoc(retryDecoded.doc, deviceId, "e2ee_rotate_412");
        if (!applied.ok) return applied;
        continue;
      }
      if (pushRes.reason === "stale_epoch" && attempt === 0) {
        if (Number.isSafeInteger(pushRes.epoch)) _status.lastRemoteEpoch = pushRes.epoch;
        const retryPull = await httpPullState(await getTransportAuth());
        if (retryPull.ok) {
          if (retryPull.etag) _status.lastRemoteEtag = retryPull.etag;
          if (Number.isSafeInteger(retryPull.epoch)) _status.lastRemoteEpoch = retryPull.epoch;
          const retryDecoded = await decodeWithOldSecret(retryPull.doc);
          if (!retryDecoded.ok) {
            _status.status = "error";
            _status.lastError = retryDecoded.reason;
            await saveState();
            return { ok: false, reason: retryDecoded.reason };
          }
          baseRevision = Number(retryDecoded.doc?.revision || retryPull.revision) || baseRevision;
          if (!isContentEqualToRemote(_getData(), retryDecoded.doc, _status.docId)) {
            const applied = await applyRemoteDoc(retryDecoded.doc, deviceId, "e2ee_rotate_stale_epoch");
            if (!applied.ok) return applied;
          }
          continue;
        }
        if (retryPull.reason === "no_remote") {
          baseRevision = 0;
          _status.lastRemoteEtag = "";
          continue;
        }
        _status.status = retryPull.reason === "device_retired" ? "device_retired" : "error";
        _status.lastError = retryPull.reason || "pull_failed";
        await saveState();
        return { ok: false, reason: retryPull.reason || "pull_failed", error: retryPull.error };
      }
      if (pushRes.reason === "device_retired") await markDeviceRetired();
      _status.status = pushRes.reason === "device_retired" ? "device_retired" : "error";
      _status.lastError = pushRes.reason || pushRes.error || "push_failed";
      await saveState();
      return { ok: false, reason: pushRes.reason || "push_failed", error: pushRes.error };
    }

    if (!pushRes?.ok || !pushedDoc) {
      return { ok: false, reason: "push_failed" };
    }

    const current = _getData();
    const prevEnabled = !!current?.settings?.syncE2eeEnabled;
    const prevPassphrase = String(current?.settings?.syncE2eePassphrase || "");
    if (current && typeof current === "object") {
      current.settings = {
        ...(current.settings || {}),
        syncE2eeEnabled: true,
        syncE2eePassphrase: newSecret,
      };
      current._syncMeta = {
        ...(current._syncMeta && typeof current._syncMeta === "object" ? current._syncMeta : {}),
        docId: _status.docId,
        revision: Number(pushRes.revision || pushedDoc.revision),
        contentHash: pushedDoc.contentHash,
      };
      try {
        const writeErr = await _saveLocal(current);
        if (writeErr && !isLocalTrimWarning(writeErr)) {
          current.settings.syncE2eeEnabled = prevEnabled;
          current.settings.syncE2eePassphrase = prevPassphrase;
          return { ok: false, reason: "local_write_failed", error: String(writeErr) };
        }
      } catch (e) {
        current.settings.syncE2eeEnabled = prevEnabled;
        current.settings.syncE2eePassphrase = prevPassphrase;
        return { ok: false, reason: "local_write_failed", error: e?.message || String(e) };
      }
    }

    _status.lastRemoteEtag = pushRes.etag || _status.lastRemoteEtag;
    if (Number.isSafeInteger(pushRes.epoch)) _status.lastRemoteEpoch = pushRes.epoch;
    _status.lastRemoteRevision = Number(pushRes.revision || pushedDoc.revision);
    _status.lastPushAt = Date.now();
    _status.status = "idle";
    _status.lastError = "";
    await clearOutboxSuccess();
    await saveState();
    await confirmRemoteRevision(_status.lastRemoteRevision, deviceId);
    return { ok: true, revision: _status.lastRemoteRevision };
  });
}

async function enqueueOutbox(doc, error) {
  await enqueueOutboxRecord(doc, error);
}

async function clearOutboxSuccess() {
  await clearOutboxRecord();
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
  // 退役熔断未解除前不消费 outbox：重试永远 403，只会徒增请求
  if (_status.status === "device_retired") return { ok: false, reason: "device_retired" };
  const check = await readPendingOutboxItem();
  if (!check.ok) {
    if (check.reason === "outbox_exhausted") {
      _status.status = "error";
      _status.lastError = check.lastError || "outbox_exhausted";
      await saveState();
    }
    return { ok: false, reason: check.reason };
  }
  if (!check.ready) return { ok: true, ...(check.empty ? { empty: true } : { wait: true }) };
  return pushNow("outbox");
}

/**
 * 启用时初始化状态并尝试首同步
 */

const conflictResolver = createSyncConflictResolver({
  enqueue,
  getData: () => _getData(),
  getStatus: () => _status,
  getPendingConflictRemote: () => _pendingConflictRemote,
  setPendingConflictRemote: (val) => {
    _pendingConflictRemote = val;
  },
  saveState,
  readRemoteSyncDocument,
  writeRemoteSyncDocument,
  applyConflictLocalState,
  pushNowImpl,
  getOrCreateDeviceId,
  createDocId,
  toSyncDocument,
  hashSyncDocument,
  mergeHomepage,
  syncDocumentToHomepageShape,
  HOMEPAGE_SCHEMA_VERSION,
});

/**
 * 解决 docId 冲突。
 * @param {"merge"|"local"|"remote"} choice
 */
export async function resolveDocConflict(choice) {
  return conflictResolver.resolveDocConflict(choice);
}

export function getPendingConflict() {
  return conflictResolver.getPendingConflict();
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
