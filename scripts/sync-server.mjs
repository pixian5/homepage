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
// 显式 PORT=0 时交由系统分配空闲端口，供隔离测试使用。
const PORT = process.env.PORT === "0" ? 0 : Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = String(process.env.TOKEN || "").trim();
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "homepage-sync-state.json");
/** 当前服务端协议版本；设备表随协议一起演进。 */
const SERVER_PROTOCOL = 2;
/** 设备列表上限，防止异常客户端无限撑大状态文件。 */
const MAX_DEVICES = 200;

/**
 * 服务端状态。
 * devices 只在第一阶段用于收集设备与确认信息，暂不触发回收。
 * @type {{
 *   revision: number,
 *   etag: string,
 *   doc: object,
 *   updatedAt: number,
 *   epoch: number,
 *   devices: Record<string, {deviceId: string, firstSeenAt: number, lastSeenAt: number,
 *     lastConfirmedRevision: number, lastConfirmedEpoch: number, protocol: number}>,
 *   deletions: Record<string, number>,
 * } | null}
 */
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
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, Idempotency-Key, X-Sync-Epoch",
    "Access-Control-Expose-Headers": "ETag, X-Sync-Revision, X-Sync-Epoch",
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
        // 旧状态文件没有 epoch/devices/deletions：按 0 / 空表补齐，迁移是只读的，不改盘
        epoch: Number.isSafeInteger(parsed.epoch) ? Math.max(0, parsed.epoch) : 0,
        devices: normalizeDevices(parsed.devices),
        deletions: normalizeDeletions(parsed.deletions),
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
      epoch: snapshot.epoch || 0,
      devices: snapshot.devices || {},
      deletions: snapshot.deletions || {},
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

/**
 * 规范化设备表：丢弃结构不合法的条目，并限制总数。
 * 设备表只保存标识与确认进度，不保存任何书签内容。
 */
function normalizeDevices(input) {
  const out = {};
  if (!isRecord(input)) return out;
  const entries = Object.entries(input)
    .filter(([id, value]) => typeof id === "string" && id && isRecord(value))
    .map(([id, value]) => [
      id,
      {
        deviceId: id,
        firstSeenAt: isTimestamp(value.firstSeenAt) ? value.firstSeenAt : 0,
        lastSeenAt: isTimestamp(value.lastSeenAt) ? value.lastSeenAt : 0,
        lastConfirmedRevision: Number.isSafeInteger(value.lastConfirmedRevision)
          ? Math.max(0, value.lastConfirmedRevision)
          : 0,
        lastConfirmedEpoch: Number.isSafeInteger(value.lastConfirmedEpoch) ? Math.max(0, value.lastConfirmedEpoch) : 0,
        protocol: Number.isSafeInteger(value.protocol) ? value.protocol : 1,
        // 退役时间戳：非 0 表示该设备已被显式退役。
        // 服务端拒绝其写入，也不再参与墓碑回收的「所有设备已确认」判定，
        // 否则一台废弃设备会永久卡住回收（永远等不到它的确认）。
        retiredAt: isTimestamp(value.retiredAt) ? value.retiredAt : 0,
      },
    ])
    .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
    .slice(0, MAX_DEVICES);
  for (const [id, value] of entries) out[id] = value;
  return out;
}

/**
 * 规范化删除版本索引：只保留「ID -> 正整数 revision」。
 * 客户端传来的删除时间戳不可信，删除版本一律由服务端在提交时写入。
 */
function normalizeDeletions(input) {
  const out = {};
  if (!isRecord(input)) return out;
  for (const [id, value] of Object.entries(input)) {
    if (typeof id !== "string" || !id) continue;
    if (!Number.isSafeInteger(value) || value <= 0) continue;
    out[id] = value;
  }
  return out;
}

/**
 * 计算本次提交新增的删除版本。
 * 节点/分组在本次文档里带 deletedAt/purgedAt，且 revisions 里还没有记录时，
 * 记为当前提交的 revision。
 */
function collectNewDeletions(doc, revision, previous = {}) {
  const next = { ...normalizeDeletions(previous) };
  const mark = (id, entity) => {
    if (!entity || typeof id !== "string" || !id) return;
    const deleted = Number(entity.deletedAt || entity.purgedAt || 0) > 0;
    if (!deleted) return;
    if (!next[id]) next[id] = revision;
  };
  for (const node of doc.nodes || []) mark(node.id, node);
  for (const group of doc.groups || []) mark(group.id, group);
  return next;
}

/**
 * 计算「所有有效设备都已确认」的墓碑候选集。
 * 第一阶段只输出诊断信息，不删除任何数据；真正回收需要递增 epoch 并原子落盘。
 *
 * 判定：某条墓碑的删除 revision 必须小于等于每台设备的 lastConfirmedRevision，
 * 且设备确认的 epoch 与当前 epoch 一致（旧代际的确认不算数）。
 */
function computeReclaimCandidates(snapshot) {
  if (!snapshot) return [];
  const epoch = snapshot.epoch || 0;
  const devices = Object.values(snapshot.devices || {});
  if (!devices.length) return [];
  const active = devices.filter((d) => !d.retiredAt && (d.lastConfirmedEpoch ?? epoch) >= epoch);
  if (!active.length) return [];
  const minConfirmed = Math.min(...active.map((d) => Number(d.lastConfirmedRevision) || 0));
  const out = [];
  for (const [id, deletedAtRevision] of Object.entries(snapshot.deletions || {})) {
    if (Number(deletedAtRevision) <= minConfirmed) out.push(id);
  }
  return out.sort();
}

/**
 * 返回登记了一次设备活动后的新设备表（纯函数，不改入参）。
 * 只在写入成功或设备确认时调用。
 */
function withDeviceTouched(devices, deviceId, { now = Date.now(), confirmedRevision, epoch, protocol } = {}) {
  if (typeof deviceId !== "string" || !deviceId.trim()) return normalizeDevices(devices);
  const id = deviceId.trim();
  const previous = devices?.[id];
  const next = {
    deviceId: id,
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
    lastConfirmedRevision: previous?.lastConfirmedRevision || 0,
    lastConfirmedEpoch: previous?.lastConfirmedEpoch || 0,
    protocol: Number.isSafeInteger(protocol) ? protocol : previous?.protocol || SERVER_PROTOCOL,
  };
  if (Number.isSafeInteger(confirmedRevision)) {
    next.lastConfirmedRevision = Math.max(next.lastConfirmedRevision, confirmedRevision);
  }
  if (Number.isSafeInteger(epoch)) {
    next.lastConfirmedEpoch = Math.max(next.lastConfirmedEpoch, epoch);
  }
  return normalizeDevices({ ...devices, [id]: next });
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
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, If-Match, Idempotency-Key, X-Sync-Epoch",
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
      // 便于判断「服务活着但数据停滞」：revision/updatedAt 是否在推进
      revision: state?.revision ?? null,
      updatedAt: state?.updatedAt ?? null,
      epoch: state?.epoch ?? 0,
      deviceCount: state ? Object.keys(state.devices || {}).length : 0,
      protocol: SERVER_PROTOCOL,
    });
    return;
  }

  // Token 只允许通过 Authorization 请求头传输，避免出现在 URL、日志和代理记录中。
  const authOk = checkAuth(req);
  if (url.pathname.startsWith("/v1/") && !authOk) {
    unauthorized(res);
    return;
  }

  // 设备确认：客户端已把 revision 持久保存到本地后调用。
  // 只记录确认进度，不做任何删除或回收决定。
  if (url.pathname === "/v1/sync/confirm" && method === "POST") {
    let raw;
    try {
      raw = await readBody(req, 64 * 1024);
    } catch (e) {
      json(res, e.message === "body_too_large" ? 413 : 400, { error: e.message || "bad_body" });
      return;
    }
    let body;
    try {
      body = JSON.parse(raw || "null");
    } catch {
      json(res, 400, { error: "invalid_json" });
      return;
    }
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
    const confirmedRevision = body?.revision;
    if (!deviceId) {
      json(res, 400, { error: "invalid_device_id" });
      return;
    }
    if (!Number.isSafeInteger(confirmedRevision) || confirmedRevision < 0) {
      json(res, 400, { error: "invalid_revision" });
      return;
    }
    const result = await enqueueWrite(async () => {
      if (!state) {
        return { status: 409, body: { error: "no_state" }, headers: {} };
      }
      // 已退役设备不得确认：否则它的确认会错误地让墓碑被判定为「全员已确认」。
      if (state.devices?.[deviceId]?.retiredAt) {
        return { status: 403, body: { error: "device_retired", deviceId }, headers: {} };
      }
      // 只接受不超前于当前服务端 revision 的确认，防止伪造未来确认。
      if (confirmedRevision > state.revision) {
        return { status: 409, body: { error: "revision_ahead", revision: state.revision }, headers: {} };
      }
      const nextState = {
        ...state,
        devices: withDeviceTouched(state.devices, deviceId, {
          now: Date.now(),
          confirmedRevision,
          epoch: state.epoch || 0,
          protocol: Number.isSafeInteger(body?.protocol) ? body.protocol : SERVER_PROTOCOL,
        }),
      };
      try {
        await saveToDisk(nextState);
      } catch (e) {
        console.error("[sync-server] confirm save failed", e);
        return { status: 500, body: { error: "save_failed" }, headers: {} };
      }
      state = nextState;
      return {
        status: 200,
        body: { ok: true, revision: state.revision, epoch: state.epoch || 0 },
        headers: {},
      };
    });
    json(res, result.status, result.body, result.headers || {});
    return;
  }

  // 设备表只读视图：用于排查「谁确认到哪个版本」，不含任何书签内容。
  if (url.pathname === "/v1/sync/devices" && method === "GET") {
    if (!state) {
      json(res, 404, { error: "not_found" });
      return;
    }
    json(res, 200, {
      revision: state.revision,
      epoch: state.epoch || 0,
      devices: Object.values(state.devices || {}),
      deletions: state.deletions || {},
      // 只读诊断：哪些墓碑已经可以被回收（本阶段不执行回收）
      reclaimCandidates: computeReclaimCandidates(state),
    });
    return;
  }

  // 设备退役 / 复职：显式管理设备表，避免废弃设备永久卡住墓碑回收。
  // body: { deviceId: string, retired: boolean }
  if (url.pathname === "/v1/sync/devices/retire" && method === "POST") {
    let raw;
    try {
      raw = await readBody(req, 16 * 1024);
    } catch (e) {
      json(res, e.message === "body_too_large" ? 413 : 400, { error: e.message || "bad_body" });
      return;
    }
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      json(res, 400, { error: "invalid_json" });
      return;
    }
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
    if (!deviceId) {
      json(res, 400, { error: "invalid_device_id" });
      return;
    }
    const retired = body?.retired !== false;
    const result = await enqueueWrite(async () => {
      if (!state) return { status: 409, body: { error: "no_state" }, headers: {} };
      const existing = state.devices?.[deviceId];
      if (!existing) return { status: 404, body: { error: "device_not_found", deviceId }, headers: {} };
      const devices = normalizeDevices({
        ...state.devices,
        [deviceId]: { ...existing, retiredAt: retired ? Date.now() : 0 },
      });
      const next = { ...state, devices };
      try {
        await saveToDisk(next);
      } catch (e) {
        console.error("[sync-server] retire save failed", e);
        return { status: 500, body: { error: "save_failed" }, headers: {} };
      }
      state = next;
      return {
        status: 200,
        body: {
          ok: true,
          deviceId,
          retired,
          deviceCount: Object.keys(devices).length,
          reclaimCandidates: computeReclaimCandidates(state),
        },
        headers: {},
      };
    });
    json(res, result.status, result.body, result.headers);
    return;
  }

  // 墓碑回收：默认只做演练（dryRun），真正执行需要显式 {"dryRun": false}。
  // 执行时递增 epoch，并原子落盘文档 + 设备表 + 删除索引。
  if (url.pathname === "/v1/sync/reclaim" && method === "POST") {
    let raw;
    try {
      raw = await readBody(req, 64 * 1024);
    } catch (e) {
      json(res, e.message === "body_too_large" ? 413 : 400, { error: e.message || "bad_body" });
      return;
    }
    let body = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: "invalid_json" });
        return;
      }
    }
    const dryRun = body?.dryRun !== false;
    const result = await enqueueWrite(async () => {
      if (!state) return { status: 409, body: { error: "no_state" }, headers: {} };
      const candidates = computeReclaimCandidates(state);
      if (dryRun) {
        return {
          status: 200,
          body: { ok: true, dryRun: true, candidates, epoch: state.epoch || 0, revision: state.revision },
          headers: {},
        };
      }
      if (!candidates.length) {
        return {
          status: 200,
          body: { ok: true, dryRun: false, reclaimed: [], epoch: state.epoch || 0, revision: state.revision },
          headers: {},
        };
      }
      const remove = new Set(candidates);
      const nextDoc = {
        ...state.doc,
        nodes: (state.doc.nodes || []).filter((node) => !remove.has(node.id)),
        groups: (state.doc.groups || []).filter((group) => !remove.has(group.id)),
        placements: (state.doc.placements || []).filter(
          (p) => !remove.has(p.nodeId) && !(p.parentKind === "folder" && remove.has(p.parentId)),
        ),
      };
      const nextRevision = state.revision + 1;
      const nextEpoch = (state.epoch || 0) + 1;
      nextDoc.revision = nextRevision;
      nextDoc.contentHash = hashSyncDocument(nextDoc);
      const nextDeletions = { ...state.deletions };
      for (const id of remove) delete nextDeletions[id];
      // 回收后所有设备必须重新确认新一代基线
      const nextDevices = {};
      for (const [id, device] of Object.entries(state.devices || {})) {
        nextDevices[id] = { ...device, lastConfirmedEpoch: 0, lastConfirmedRevision: 0, lastSeenAt: device.lastSeenAt };
      }
      const nextState = {
        revision: nextRevision,
        etag: etagOf(nextDoc, nextRevision),
        doc: nextDoc,
        updatedAt: Date.now(),
        epoch: nextEpoch,
        devices: nextDevices,
        deletions: nextDeletions,
      };
      try {
        await saveToDisk(nextState);
      } catch (e) {
        console.error("[sync-server] reclaim save failed", e);
        return { status: 500, body: { error: "save_failed" }, headers: {} };
      }
      state = nextState;
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: false,
          reclaimed: candidates,
          epoch: nextEpoch,
          revision: nextRevision,
        },
        headers: { "X-Sync-Epoch": String(nextEpoch) },
      };
    });
    json(res, result.status, result.body, result.headers || {});
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
        "X-Sync-Epoch": String(state.epoch || 0),
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

      // 已退役设备不得写入：退役是显式动作，之后该设备再推任何数据都拒绝。
      // 用 403 而不是 401，便于客户端区分「令牌错误」与「设备已被移除」。
      if (state?.devices?.[doc.deviceId]?.retiredAt) {
        return {
          status: 403,
          body: { error: "device_retired", deviceId: doc.deviceId },
          headers: {},
        };
      }

      // 压缩代际栅栏：客户端若显式声明 epoch 且落后，拒绝旧整包回推。
      // 未声明 epoch 的旧客户端在第一阶段放行（继续永久保留墓碑）。
      const clientEpoch = req.headers["x-sync-epoch"];
      if (clientEpoch !== undefined && clientEpoch !== "") {
        const parsed = Number(clientEpoch);
        if (Number.isSafeInteger(parsed) && parsed < (state?.epoch || 0)) {
          return {
            status: 409,
            body: { error: "stale_epoch", epoch: state.epoch, revision: state.revision },
            headers: { "X-Sync-Epoch": String(state.epoch) },
          };
        }
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
      const now = Date.now();
      // 第一阶段：只记录设备与它最后写入的 revision，不做任何回收。
      // 文档与设备表在同一次落盘里提交，避免只写一半。
      const nextState = {
        revision: nextRevision,
        etag: etagOf(nextDoc, nextRevision),
        doc: nextDoc,
        updatedAt: now,
        epoch: state?.epoch || 0,
        devices: withDeviceTouched(state?.devices, doc.deviceId, {
          now,
          confirmedRevision: nextRevision,
        }),
        // 删除版本由服务端写入，客户端不可伪造
        deletions: collectNewDeletions(nextDoc, nextRevision, state?.deletions),
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
  const address = server.address();
  console.log(`[sync-server] http://${HOST}:${address.port}`);
  console.log(`[sync-server] GET/PUT /v1/sync/state  GET /health`);
  console.log(`[sync-server] auth: ${TOKEN ? "Bearer token required" : "open (no TOKEN)"}`);
  console.log(`[sync-server] data: ${DATA_FILE}`);
  // 仅向启动本进程的父进程报告就绪；测试不再把其他服务的健康响应当作启动成功。
  if (process.send) process.send({ type: "sync-server-ready", port: address.port, pid: process.pid });
});
