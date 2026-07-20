/**
 * SyncDocument 分片编解码（storage.sync 单 key 体积限制）
 */

import { estimateBytes } from "./shared-utils.js";
import {
  SYNC_META_KEY,
  SYNC_META_SCHEMA,
  SYNC_SHARD_KEY_PREFIX,
  SYNC_SHARD_MAX_BYTES,
  SYNC_TOTAL_HARD_BYTES,
} from "./sync_policy.js";
import { hashSyncDocument } from "./sync_projection.js";

/**
 * @param {object} doc SyncDocument
 * @returns {{ meta: object, shards: Record<string, string>, bytesTotal: number }}
 */
export function packSyncDocument(doc) {
  const full = JSON.stringify(doc);
  const bytesTotal = estimateBytes(doc);
  if (bytesTotal > SYNC_TOTAL_HARD_BYTES) {
    const err = new Error("sync_quota_total");
    err.code = "sync_quota_total";
    err.bytes = bytesTotal;
    throw err;
  }

  // 小文档单片
  if (estimateBytes(full) <= SYNC_SHARD_MAX_BYTES - 64) {
    const meta = {
      schema: SYNC_META_SCHEMA,
      schemaVersion: 1,
      docId: doc.docId,
      revision: doc.revision,
      contentHash: doc.contentHash || hashSyncDocument(doc),
      shardCount: 1,
      deviceId: doc.deviceId,
      writtenAt: doc.writtenAt,
      bytesTotal,
    };
    return {
      meta,
      shards: { [`${SYNC_SHARD_KEY_PREFIX}0`]: full },
      bytesTotal,
    };
  }

  // 按字符粗切（UTF-8 近似：中文会偏大，故用更保守的切片）
  const chunkTarget = Math.floor(SYNC_SHARD_MAX_BYTES * 0.7);
  const parts = [];
  for (let i = 0; i < full.length; ) {
    let end = Math.min(full.length, i + chunkTarget);
    // 避免切断代理对
    if (end < full.length && full.charCodeAt(end - 1) >= 0xd800 && full.charCodeAt(end - 1) <= 0xdbff) {
      end += 1;
    }
    parts.push(full.slice(i, end));
    i = end;
  }

  const shards = {};
  parts.forEach((part, idx) => {
    const key = `${SYNC_SHARD_KEY_PREFIX}${idx}`;
    if (estimateBytes(part) > SYNC_SHARD_MAX_BYTES) {
      const err = new Error("sync_shard_too_large");
      err.code = "sync_shard_too_large";
      throw err;
    }
    shards[key] = part;
  });

  const meta = {
    schema: SYNC_META_SCHEMA,
    schemaVersion: 1,
    docId: doc.docId,
    revision: doc.revision,
    contentHash: doc.contentHash || hashSyncDocument(doc),
    shardCount: parts.length,
    deviceId: doc.deviceId,
    writtenAt: doc.writtenAt,
    bytesTotal,
  };
  return { meta, shards, bytesTotal };
}

/**
 * @param {object|null} meta
 * @param {Record<string, string>} shardMap key -> string
 * @returns {{ ok: true, doc: object } | { ok: false, reason: string }}
 */
export function unpackSyncDocument(meta, shardMap) {
  if (!meta || typeof meta !== "object") {
    return { ok: false, reason: "no_meta" };
  }
  if (meta.schema && meta.schema !== SYNC_META_SCHEMA) {
    return { ok: false, reason: "bad_meta_schema" };
  }
  const count = Number(meta.shardCount) || 0;
  if (count < 1) return { ok: false, reason: "incomplete_remote" };

  const parts = [];
  for (let i = 0; i < count; i++) {
    const key = `${SYNC_SHARD_KEY_PREFIX}${i}`;
    const piece = shardMap?.[key];
    if (typeof piece !== "string") {
      return { ok: false, reason: "incomplete_remote" };
    }
    parts.push(piece);
  }

  let doc;
  try {
    doc = JSON.parse(parts.join(""));
  } catch (_e) {
    return { ok: false, reason: "parse_error" };
  }
  if (!doc || typeof doc !== "object") {
    return { ok: false, reason: "invalid_doc" };
  }

  const expected = meta.contentHash || "";
  const actual = hashSyncDocument(doc);
  if (expected && expected !== actual) {
    // 允许 doc 自带 hash 一致
    if (doc.contentHash && doc.contentHash === expected) {
      // ok
    } else if (doc.contentHash === actual && !expected) {
      // ok
    } else if (expected !== actual && doc.contentHash !== expected) {
      return { ok: false, reason: "hash_mismatch" };
    }
  }
  // 规范化 hash
  doc.contentHash = actual;
  if (meta.docId) doc.docId = meta.docId;
  if (meta.revision != null) doc.revision = Number(meta.revision) || doc.revision;
  return { ok: true, doc };
}

export function syncShardKeys(count) {
  const n = Number(count) || 0;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(`${SYNC_SHARD_KEY_PREFIX}${i}`);
  return keys;
}

export { SYNC_META_KEY };
