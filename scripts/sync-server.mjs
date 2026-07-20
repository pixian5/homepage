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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  const h = String(req.headers.authorization || "");
  if (h === `Bearer ${TOKEN}`) return true;
  // 也允许 ?token=
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
    if (parsed && typeof parsed === "object" && parsed.doc) {
      state = {
        revision: Number(parsed.revision) || 1,
        etag: parsed.etag || etagOf(parsed.doc, parsed.revision || 1),
        doc: parsed.doc,
        updatedAt: Number(parsed.updatedAt) || Date.now(),
      };
      console.log(`[sync-server] loaded ${DATA_FILE} revision=${state.revision}`);
      return;
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("[sync-server] load failed", e.message);
  }
  state = null;
  console.log("[sync-server] no existing state");
}

async function saveToDisk() {
  if (!state) return;
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(
    {
      revision: state.revision,
      etag: state.etag,
      updatedAt: state.updatedAt,
      doc: state.doc,
    },
    null,
    2,
  );
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, DATA_FILE);
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
    json(res, 200, { ok: true, service: "homepage-sync", hasState: !!state });
    return;
  }

  // token via query for simple local testing
  const queryToken = url.searchParams.get("token") || "";
  const authOk = checkAuth(req) || (TOKEN && queryToken === TOKEN);
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
    if (idem && idempotency.has(idem)) {
      const cached = idempotency.get(idem);
      json(res, cached.status, cached.body, cached.headers || {});
      return;
    }

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
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      json(res, 400, { error: "invalid_doc" });
      return;
    }
    // 允许 { doc, revision } 包装或裸 SyncDocument
    if (doc.doc && typeof doc.doc === "object") {
      doc = doc.doc;
    }
    if (!doc.schema && !doc.groups && !doc.nodes) {
      json(res, 400, { error: "invalid_doc_shape" });
      return;
    }

    const ifMatch = String(req.headers["if-match"] || "").trim();
    if (state && ifMatch && ifMatch !== state.etag && ifMatch !== "*") {
      json(
        res,
        412,
        {
          error: "precondition_failed",
          revision: state.revision,
          etag: state.etag,
          doc: state.doc,
        },
        {
          ETag: state.etag,
          "X-Sync-Revision": String(state.revision),
        },
      );
      return;
    }

    const nextRevision = state ? state.revision + 1 : Math.max(1, Number(doc.revision) || 1);
    doc.revision = nextRevision;
    const etag = etagOf(doc, nextRevision);
    state = {
      revision: nextRevision,
      etag,
      doc,
      updatedAt: Date.now(),
    };
    try {
      await saveToDisk();
    } catch (e) {
      console.error("[sync-server] save failed", e);
      json(res, 500, { error: "save_failed", message: e.message });
      return;
    }

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
    if (idem) {
      idempotency.set(idem, { status: 200, body, headers, at: Date.now() });
      // 简单清理：超过 200 条丢最旧
      if (idempotency.size > 200) {
        const first = idempotency.keys().next().value;
        idempotency.delete(first);
      }
    }
    json(res, 200, body, headers);
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
