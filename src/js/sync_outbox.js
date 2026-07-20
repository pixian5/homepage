/**
 * 同步推送 outbox（失败重试）
 */

import { SYNC_OUTBOX_KEY, SYNC_OUTBOX_MAX_ATTEMPTS, syncOutboxRetryDelayMs } from "./sync_policy.js";

export const SYNC_OUTBOX_TARGET = "storage.sync|homepage";

/**
 * @param {any} value
 * @param {number} [nowMs]
 */
export function normalizeSyncOutbox(value, nowMs = Date.now()) {
  const byKey = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const targetKey = String(item?.targetKey || "").trim();
    if (!targetKey || !item?.payload || typeof item.payload !== "object") continue;
    const attempts = Math.min(SYNC_OUTBOX_MAX_ATTEMPTS, Math.max(0, Math.floor(Number(item.attempts) || 0)));
    byKey.set(targetKey, {
      targetKey,
      payload: item.payload,
      createdAtMs: Number(item.createdAtMs) || nowMs,
      attempts,
      lastAttemptAtMs: Number(item.lastAttemptAtMs) || 0,
      nextRetryAtMs: Number(item.nextRetryAtMs) || 0,
      lastError: String(item.lastError || ""),
    });
  }
  return [...byKey.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export function isSyncOutboxReady(item, nowMs = Date.now()) {
  return !item || Number(item.nextRetryAtMs || 0) <= nowMs;
}

/**
 * 写入/更新队列项（同 target 只保留最新 payload，attempts+1）
 */
export function upsertSyncOutbox(value, { targetKey, payload, error, nowMs = Date.now(), resetAttempts = false }) {
  const current = normalizeSyncOutbox(value, nowMs);
  const previous = current.find((item) => item.targetKey === targetKey);
  const attempts = resetAttempts
    ? 0
    : Math.min(SYNC_OUTBOX_MAX_ATTEMPTS, Number(previous?.attempts || 0) + (error ? 1 : 0));
  const next = {
    targetKey,
    payload,
    createdAtMs: previous?.createdAtMs || nowMs,
    attempts,
    lastAttemptAtMs: error ? nowMs : previous?.lastAttemptAtMs || 0,
    nextRetryAtMs: error ? nowMs + syncOutboxRetryDelayMs(Math.max(1, attempts)) : 0,
    lastError: error ? String(error?.message || error || "") : "",
  };
  return normalizeSyncOutbox(current.filter((item) => item.targetKey !== targetKey).concat(next), nowMs);
}

export function removeSyncOutbox(value, targetKey) {
  return normalizeSyncOutbox(value).filter((item) => item.targetKey !== targetKey);
}

export { SYNC_OUTBOX_KEY };
