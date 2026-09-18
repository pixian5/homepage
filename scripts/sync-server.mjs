#!/usr/bin/env node

/**
 * 最小 HTTP JSON 同步服务（本机或远程均可）
 *
 * 协议：
 *   GET  /v1/sync/state          → 200 { revision, etag, doc } | 404 无数据
 *   PUT  /v1/sync/state          → body: SyncDocument JSON
 *                                  Header: Authorization: Bearer <token>（若设置了 TOKEN）
 *                                  Header: If-Match: <etag>（可选，冲突返回 412）
 *                                  Header: Idempotency-Key: <string>（可选）
 *   GET  /health                 → 200 ok
 *
 * 环境变量：
 *   PORT=8787
 *   HOST=0.0.0.0
 *   TOKEN=可选共享密钥
 *   DATA_FILE=./data/homepage-sync-state.json
 *
 * 启动：
 *   node scripts/sync-server.mjs
 *   TOKEN=secret PORT=8787 node scripts/sync-server.mjs
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = String(process.env.TOKEN || "").trim();
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "homepage-sync-state.json");

/** @type {{ revision: number, etag: string, doc: object, updatedAt: number } | null} */
let state = null;
const idempotency = new Map(); // key -> { status, body, at }
let writeChain = Promise.resolve();

function enqueueWrite(task) {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function json(res, status, body, extraHeaders = {}) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, Idempotency-Key",
    "Access-Control-Expose-Headers": "ETag, X-Sync-Revision",
    ...extraHeaders,
  });
  res.end(raw);
}

function unauthorized(res) {
  json(res, 401, { error: "unauthorized" });
}

function checkAuth(req) {
  if (!TOKEN) return true;
  const h = String(req.headers.authorization || "").trim();
  // 允许大小写 Bearer，以及多余空白
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m && m[1].trim() === TOKEN) return true;
  return false;
}

function etagOf(doc, revision) {
  const h = createHash("sha256");
  h.update(String(revision));
  h.update("\n");
  h.update(JSON.stringify(doc));
  return `"${h.digest("hex").slice(0, 32)}"`;
}

async function loadFromDisk() {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const validationError = validateSyncDocument(parsed?.doc);
    const revision = parsed?.revision;
    if (
      !validationError &&
      Number.isSafeInteger(revision) &&
      revision >= 0 &&
      revision === parsed.doc.revision &&
      typeof parsed.updatedAt === "number" &&
      Number.isFinite(parsed.updatedAt)
    ) {
      state = {
        revision,
        etag: etagOf(parsed.doc, revision),
        doc: parsed.doc,
        updatedAt: parsed.updatedAt,
      };
      console.log(`[sync-server] loaded ${DATA_FILE} revision=${state.revision}`);
      return;
    }
    console.warn(`[sync-server] ignored invalid state file (${validationError || "invalid_state"})`);
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("[sync-server] load failed", e.message);
  }
  state = null;
  console.log("[sync-server] no existing state");
}

async function saveToDisk(snapshot = state) {
  if (!snapshot) return;
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(
    {
      revision: snapshot.revision,
      etag: snapshot.etag,
      updatedAt: snapshot.updatedAt,
      doc: snapshot.doc,
    },
    null,
    2,
  );
  try {
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, DATA_FILE);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hashSyncDocument(doc) {
  const clone = { ...doc, contentHash: "" };
  const str = JSON.stringify(clone);
  let hash = 2166136261;
  for (let index = 0; index < str.length; index += 1) {
    hash ^= str.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isTimestamp(value) {
  return isFiniteNumber(value) && value >= 0;
}

function hasOptionalTimestamp(record, key) {
  return record[key] === undefined || isTimestamp(record[key]);
}

function validateSyncDocument(doc) {
  if (!isRecord(doc)) return "invalid_doc";
  if (doc.schema !== "homepage.sync.doc.v1" || doc.schemaVersion !== 1) return "invalid_schema";
  if (typeof doc.docId !== "string" || !doc.docId.trim()) return "invalid_doc_id";
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 0) return "invalid_revision";
  if (typeof doc.deviceId !== "string" || !doc.deviceId.trim()) return "invalid_device_id";
  if (!isTimestamp(doc.writtenAt)) return "invalid_written_at";
  if (typeof doc.contentHash !== "string" || doc.contentHash !== hashSyncDocument(doc)) return "invalid_content_hash";
  if (!isRecord(doc.settings)) return "invalid_settings";
  if (doc.settingsMeta !== undefined) {
    if (!isRecord(doc.settingsMeta)) return "invalid_settings_meta";
    for (const clock of Object.values(doc.settingsMeta)) {
      if (!isRecord(clock) || !isTimestamp(clock.updatedAt) || typeof clock.updatedBy !== "string") {
        return "invalid_settings_meta";
      }
    }
  }
  if (!Array.isArray(doc.groups) || !Array.isArray(doc.nodes) || !Array.isArray(doc.placements))
    return "invalid_collections";

  const groupIds = new Set();
  for (const group of doc.groups) {
    if (!isRecord(group) || typeof group.id !== "string" || !group.id) return "invalid_group";
    if (groupIds.has(group.id)) return "duplicate_group";
    groupIds.add(group.id);
    if (typeof group.name !== "string" || !isFiniteNumber(group.order)) return "invalid_group";
    if (!isTimestamp(group.updatedAt) || typeof group.updatedBy !== "string") return "invalid_group";
    if (!hasOptionalTimestamp(group, "deletedAt") || !hasOptionalTimestamp(group, "purgedAt")) return "invalid_group";
  }

  const nodes = new Map();
  for (const node of doc.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id) return "invalid_node";
    if (nodes.has(node.id)) return "duplicate_node";
    nodes.set(node.id, node);
    if (node.type !== "item" && node.type !== "folder") return "invalid_node_type";
    if (typeof node.title !== "string" || !isTimestamp(node.updatedAt) || typeof node.updatedBy !== "string") {
      return "invalid_node";
    }
    if (node.type === "item" && typeof node.url !== "string") return "invalid_node";
    for (const key of ["iconType", "iconData", "color"]) {
      if (node[key] !== undefined && typeof node[key] !== "string") return "invalid_node";
    }
    for (const key of ["titleUpdatedAt", "urlUpdatedAt", "deletedAt", "purgedAt"]) {
      if (!hasOptionalTimestamp(node, key)) return "invalid_node";
    }
  }

  const placedNodeIds = new Set();
  for (const placement of doc.placements) {
    if (!isRecord(placement) || typeof placement.nodeId !== "string" || !placement.nodeId) return "invalid_placement";
    if (!nodes.has(placement.nodeId) || placedNodeIds.has(placement.nodeId)) return "invalid_placement";
    placedNodeIds.add(placement.nodeId);
    if (placement.parentKind !== "group" && placement.parentKind !== "folder") return "invalid_placement_parent";
    if (typeof placement.parentId !== "string" || !placement.parentId) return "invalid_placement_parent";
    if (!Number.isSafeInteger(placement.index) || placement.index < 0) return "invalid_placement_index";
    if (!isTimestamp(placement.updatedAt) || typeof placement.updatedBy !== "string") return "invalid_placement";
    if (!hasOptionalTimestamp(placement, "deletedAt")) return "invalid_placement";
    if (placement.parentKind === "group" && !groupIds.has(placement.parentId)) return "invalid_placement_parent";
    if (placement.parentKind === "folder" && nodes.get(placement.parentId)?.type !== "folder") {
      return "invalid_placement_parent";
    }
  }
  return null;
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseUrl(req) {
  try {
    return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  } catch {
    return new URL("/", "http://localhost");
  }
}

const server = createServer(async (req, res) => {
  const url = parseUrl(req);
  const method = (req.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, Idempotency-Key",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      service: "homepage-sync",
      hasState: !!state,
      // 客户端可据此区分：open 时可留空 Token；true 时需填与启动 TOKEN 一致
      authRequired: !!TOKEN,
    });
    return;
  }

  // Token 只允许通过 Authorization 请求头传输，避免出现在 URL、日志和代理记录中。
  const authOk = checkAuth(req);
  if (url.pathname.startsWith("/v1/") && !authOk) {
    unauthorized(res);
    return;
  }

  if (url.pathname === "/v1/sync/state" && method === "GET") {
    if (!state) {
      json(res, 404, { error: "not_found" });
      return;
    }
    json(
      res,
      200,
      {
        revision: state.revision,
        etag: state.etag,
        updatedAt: state.updatedAt,
        doc: state.doc,
      },
      {
        ETag: state.etag,
        "X-Sync-Revision": String(state.revision),
      },
    );
    return;
  }

  if (url.pathname === "/v1/sync/state" && method === "PUT") {
    const idem = String(req.headers["idempotency-key"] || "").trim();

    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      json(res, e.message === "body_too_large" ? 413 : 400, { error: e.message || "bad_body" });
      return;
    }

    let doc;
    try {
      doc = JSON.parse(raw || "null");
    } catch {
      json(res, 400, { error: "invalid_json" });
      return;
    }
    if (!isRecord(doc)) {
      json(res, 400, { error: "invalid_doc" });
      return;
    }
    // 允许 { doc, revision } 包装或裸 SyncDocument
    if (doc.doc && typeof doc.doc === "object" && !Array.isArray(doc.doc)) {
      doc = doc.doc;
    }
    const result = await enqueueWrite(async () => {
      if (idem && idempotency.has(idem)) {
        return idempotency.get(idem);
      }
      const validationError = validateSyncDocument(doc);
      if (validationError) {
        return { status: 400, body: { error: validationError }, headers: {} };
      }

      const ifMatch = String(req.headers["if-match"] || "").trim();
      if (state && ifMatch && ifMatch !== state.etag && ifMatch !== "*") {
        return {
          status: 412,
          body: {
            error: "precondition_failed",
            revision: state.revision,
            etag: state.etag,
            doc: state.doc,
          },
          headers: {
            ETag: state.etag,
            "X-Sync-Revision": String(state.revision),
          },
        };
      }

      const nextRevision = state ? state.revision + 1 : Math.max(1, Number(doc.revision) || 1);
      const nextDoc = { ...doc, revision: nextRevision };
      nextDoc.contentHash = hashSyncDocument(nextDoc);
      const nextState = {
        revision: nextRevision,
        etag: etagOf(nextDoc, nextRevision),
        doc: nextDoc,
        updatedAt: Date.now(),
      };
      try {
        await saveToDisk(nextState);
      } catch (e) {
        console.error("[sync-server] save failed", e);
        return { status: 500, body: { error: "save_failed" }, headers: {} };
      }
      state = nextState;

      const body = {
        ok: true,
        revision: state.revision,
        etag: state.etag,
        updatedAt: state.updatedAt,
      };
      const headers = {
        ETag: state.etag,
        "X-Sync-Revision": String(state.revision),
      };
      const cached = { status: 200, body, headers, at: Date.now() };
      if (idem) {
        idempotency.set(idem, cached);
        // 简单清理：超过 200 条丢最旧
        if (idempotency.size > 200) {
          const first = idempotency.keys().next().value;
          idempotency.delete(first);
        }
      }
      return cached;
    });
    json(res, result.status, result.body, result.headers || {});
    return;
  }

  json(res, 404, { error: "not_found", path: url.pathname });
});

await loadFromDisk();
server.listen(PORT, HOST, () => {
  console.log(`[sync-server] http://${HOST}:${PORT}`);
  console.log(`[sync-server] GET/PUT /v1/sync/state  GET /health`);
  console.log(`[sync-server] auth: ${TOKEN ? "Bearer token required" : "open (no TOKEN)"}`);
  console.log(`[sync-server] data: ${DATA_FILE}`);
});
