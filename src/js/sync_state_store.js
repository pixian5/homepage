/**
 * 同步状态与 Outbox 本地持久化存储层（从 sync_engine.js 拆出）。
 *
 * 统一通过 callExtensionApi 调用 chrome/browser storage，兼容回调与 Promise-only 运行时。
 * 用 IIFE 包裹：Firefox 拼接经典脚本时仅暴露一个顶层全局名。
 */

import { callExtensionApi, getChromeApi, storageArea } from "./shared-utils.js";
import {
  isSyncOutboxReady,
  normalizeSyncOutbox,
  removeSyncOutbox,
  SYNC_OUTBOX_KEY,
  SYNC_OUTBOX_TARGET,
  upsertSyncOutbox,
} from "./sync_outbox.js";
import { SYNC_OUTBOX_MAX_ATTEMPTS, SYNC_STATE_KEY } from "./sync_policy.js";

var HomepageSyncStateStore = (() => {
  function areaLocal() {
    return storageArea(false);
  }

  async function syncStorageGetKeys(area, keys) {
    if (!area) return { ok: false, error: "no_storage_area", value: {} };
    try {
      const res = await callExtensionApi(getChromeApi(), area, "get", [keys]);
      return { ok: true, value: res || {} };
    } catch (e) {
      return { ok: false, error: e?.message || String(e), value: {} };
    }
  }

  async function syncStorageSetObj(area, obj) {
    if (!area) return "no_storage_area";
    try {
      await callExtensionApi(getChromeApi(), area, "set", [obj]);
      return null;
    } catch (e) {
      return e?.message || String(e);
    }
  }

  /** 只保留当前传输目标的队列项，自动过滤早期遗留的废弃传输目标 */
  function filterCurrentOutbox(list) {
    return (Array.isArray(list) ? list : []).filter((item) => item.targetKey === SYNC_OUTBOX_TARGET);
  }

  async function readOutboxSummary() {
    const local = areaLocal();
    if (!local) return [];
    try {
      const got = await syncStorageGetKeys(local, [SYNC_OUTBOX_KEY]);
      const list = filterCurrentOutbox(normalizeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY]));
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

  async function readSyncStateAndCleanOutbox() {
    const local = areaLocal();
    if (!local) return null;
    const got = await syncStorageGetKeys(local, [SYNC_STATE_KEY, SYNC_OUTBOX_KEY]);
    const rawOutbox = normalizeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY]);
    const kept = filterCurrentOutbox(rawOutbox);
    if (kept.length !== rawOutbox.length) {
      await syncStorageSetObj(local, { [SYNC_OUTBOX_KEY]: kept });
    }
    const st = got.value?.[SYNC_STATE_KEY];
    return st && typeof st === "object" ? st : null;
  }

  async function writeSyncStateRecord(statusRecord) {
    const local = areaLocal();
    if (!local) return "no_storage_area";
    return syncStorageSetObj(local, { [SYNC_STATE_KEY]: statusRecord });
  }

  async function readOutboxItems() {
    const got = await syncStorageGetKeys(areaLocal(), [SYNC_OUTBOX_KEY]);
    if (!got.ok) return [];
    return normalizeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY]);
  }

  async function enqueueOutboxRecord(doc, error) {
    const local = areaLocal();
    if (!local) return;
    const got = await syncStorageGetKeys(local, [SYNC_OUTBOX_KEY]);
    const next = upsertSyncOutbox(got.value?.[SYNC_OUTBOX_KEY], {
      targetKey: SYNC_OUTBOX_TARGET,
      payload: doc,
      error,
    });
    await syncStorageSetObj(local, { [SYNC_OUTBOX_KEY]: next });
  }

  async function clearOutboxRecord() {
    const local = areaLocal();
    if (!local) return;
    const got = await syncStorageGetKeys(local, [SYNC_OUTBOX_KEY]);
    const current = normalizeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY]);
    const next = removeSyncOutbox(current, SYNC_OUTBOX_TARGET);
    if (next.length === current.length) return;
    await syncStorageSetObj(local, { [SYNC_OUTBOX_KEY]: next });
  }

  async function readPendingOutboxItem() {
    const local = areaLocal();
    if (!local) return { ok: false, reason: "no_local" };
    const got = await syncStorageGetKeys(local, [SYNC_OUTBOX_KEY]);
    const list = normalizeSyncOutbox(got.value?.[SYNC_OUTBOX_KEY]);
    const item = list.find((x) => x.targetKey === SYNC_OUTBOX_TARGET);
    if (!item) return { ok: true, empty: true };
    if (!isSyncOutboxReady(item)) return { ok: true, wait: true };
    if (item.attempts >= SYNC_OUTBOX_MAX_ATTEMPTS) {
      return { ok: false, reason: "outbox_exhausted", lastError: item.lastError || "outbox_exhausted" };
    }
    return { ok: true, ready: true, item };
  }

  return {
    syncStorageGetKeys,
    syncStorageSetObj,
    filterCurrentOutbox,
    readOutboxSummary,
    readSyncStateAndCleanOutbox,
    writeSyncStateRecord,
    readOutboxItems,
    enqueueOutboxRecord,
    clearOutboxRecord,
    readPendingOutboxItem,
  };
})();

export const syncStorageGetKeys = HomepageSyncStateStore.syncStorageGetKeys;
export const syncStorageSetObj = HomepageSyncStateStore.syncStorageSetObj;
export const filterCurrentOutbox = HomepageSyncStateStore.filterCurrentOutbox;
export const readOutboxSummary = HomepageSyncStateStore.readOutboxSummary;
export const readSyncStateAndCleanOutbox = HomepageSyncStateStore.readSyncStateAndCleanOutbox;
export const writeSyncStateRecord = HomepageSyncStateStore.writeSyncStateRecord;
export const readOutboxItems = HomepageSyncStateStore.readOutboxItems;
export const enqueueOutboxRecord = HomepageSyncStateStore.enqueueOutboxRecord;
export const clearOutboxRecord = HomepageSyncStateStore.clearOutboxRecord;
export const readPendingOutboxItem = HomepageSyncStateStore.readPendingOutboxItem;
