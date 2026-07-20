/**
 * 同步包导入导出（与 merge 共用语义）
 */

import { mergeHomepage } from "./sync_merge.js";
import { SYNC_BUNDLE_SCHEMA } from "./sync_policy.js";
import { hashSyncDocument, toSyncDocument } from "./sync_projection.js";

/**
 * @param {object} data HomepageData
 * @param {{ deviceId: string, docId: string, platform?: string }} ctx
 */
export function exportSyncBundle(data, ctx) {
  const doc = toSyncDocument(data, {
    deviceId: ctx.deviceId,
    docId: ctx.docId || "doc_export",
    revision: 1,
    writtenAt: Date.now(),
  });
  return {
    schema: SYNC_BUNDLE_SCHEMA,
    exportedAtMs: Date.now(),
    source: {
      app: "homepage-extension",
      platform: ctx.platform || "unknown",
      deviceId: ctx.deviceId,
      formatVersion: 1,
    },
    payload: doc,
  };
}

/**
 * @param {object} localData
 * @param {object} bundle
 * @param {{ deviceId: string }} ctx
 */
export function importSyncBundle(localData, bundle, ctx) {
  if (!bundle || typeof bundle !== "object") {
    return { ok: false, reason: "invalid_bundle" };
  }
  let doc = null;
  if (bundle.schema === SYNC_BUNDLE_SCHEMA && bundle.payload) {
    doc = bundle.payload;
  } else if (bundle.schema === "homepage.sync.doc.v1") {
    doc = bundle;
  } else if (bundle.groups || bundle.nodes) {
    // 允许直接把 SyncDocument 当 payload
    doc = bundle;
  } else {
    return { ok: false, reason: "unknown_schema" };
  }
  if (!doc.contentHash) {
    doc = { ...doc, contentHash: hashSyncDocument(doc) };
  }
  return mergeHomepage(localData, doc, { deviceId: ctx.deviceId, now: Date.now() });
}
