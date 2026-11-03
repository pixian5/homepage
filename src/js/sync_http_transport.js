/**
 * 自建 HTTP JSON 同步 transport
 * 协议见 scripts/sync-server.mjs
 */

/**
 * @typedef {{ baseUrl: string, token?: string, deviceId?: string, deviceSecret?: string }} HttpSyncConfig
 */

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/**
 * 计算鉴权头：
 * - deviceAuth（或 cfg 本身）携带 deviceId + deviceSecret → 使用设备独立凭据 Device <id>:<secret>
 * - 否则回退全局 Bearer Token（向前兼容：未配对的客户端行为完全不变）
 * @param {string} token 全局共享 Token（主管理凭据）
 * @param {{ deviceId?: string, deviceSecret?: string }} [deviceAuth] 设备独立凭据
 */
function authHeaders(token, deviceAuth) {
  const deviceId = String(deviceAuth?.deviceId || "").trim();
  const deviceSecret = String(deviceAuth?.deviceSecret || "").trim();
  if (deviceId && deviceSecret) {
    return { Authorization: `Device ${deviceId}:${deviceSecret}` };
  }
  let t = String(token || "").trim();
  if (!t) return {};
  // 用户若粘贴了 "Bearer xxx"，避免变成 "Bearer Bearer xxx"
  if (/^Bearer\s+/i.test(t)) t = t.replace(/^Bearer\s+/i, "").trim();
  if (!t) return {};
  return { Authorization: `Bearer ${t}` };
}

/**
 * 解析 403 响应体：服务端对已退役设备统一返回 { error: "device_retired" }。
 * @returns {Promise<boolean>} 是否为设备退役导致的 403
 */
async function isDeviceRetiredResponse(res) {
  try {
    const body = await res.json();
    return body?.error === "device_retired";
  } catch (_e) {
    return false;
  }
}

async function syncHttpFetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {HttpSyncConfig} cfg
 * @returns {Promise<{ ok: true, doc: object, revision: number, etag: string } | { ok: false, reason: string, status?: number, error?: string, remote?: object }>}
 */
export async function httpPullState(cfg) {
  const baseUrl = String(cfg?.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, reason: "no_url" };
  const url = joinUrl(baseUrl, "/v1/sync/state");
  try {
    const res = await syncHttpFetchWithTimeout(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...authHeaders(cfg.token, cfg),
      },
    });
    if (res.status === 404) return { ok: false, reason: "no_remote", status: 404 };
    if (res.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
    if (res.status === 403 && (await isDeviceRetiredResponse(res))) {
      // 本设备已被注销：提示用户重新配对，而不是笼统的「鉴权失败」
      return { ok: false, reason: "device_retired", status: 403 };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "http_error", status: res.status, error: text.slice(0, 200) };
    }
    const body = await res.json();
    const doc = body?.doc || body;
    if (!doc || typeof doc !== "object") {
      return { ok: false, reason: "invalid_doc", status: res.status };
    }
    const etag = res.headers.get("ETag") || body.etag || "";
    const revision = Number(body.revision || doc.revision) || 0;
    const epoch = Number(res.headers.get("X-Sync-Epoch") || body.epoch);
    return { ok: true, doc, revision, etag, epoch: Number.isSafeInteger(epoch) ? epoch : undefined };
  } catch (e) {
    const detail = e?.name === "AbortError" ? "请求超时（10 秒）" : e?.message || String(e);
    return { ok: false, reason: "network_error", error: `${detail} · ${url}` };
  }
}

/**
 * @param {HttpSyncConfig} cfg
 * @param {object} doc
 * @param {{ ifMatch?: string, idempotencyKey?: string }} [opts]
 */
export async function httpPushState(cfg, doc, opts = {}) {
  const baseUrl = String(cfg?.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, reason: "no_url" };
  const url = joinUrl(baseUrl, "/v1/sync/state");
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(cfg.token, cfg),
    };
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    // 压缩代际：服务端回收墓碑后递增，旧代际写入会被拒绝（409 stale_epoch）
    // epoch 0 也要发：服务端回收过墓碑时，代际 0 的写入必须被识别为过期
    if (Number.isSafeInteger(opts.epoch)) headers["X-Sync-Epoch"] = String(opts.epoch);

    const res = await syncHttpFetchWithTimeout(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(doc),
    });

    if (res.status === 412) {
      let remote = null;
      try {
        remote = await res.json();
      } catch (_e) {
        remote = null;
      }
      return {
        ok: false,
        reason: "precondition_failed",
        status: 412,
        remote,
        etag: res.headers.get("ETag") || remote?.etag || "",
        revision: Number(remote?.revision) || 0,
      };
    }
    if (res.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
    if (res.status === 403 && (await isDeviceRetiredResponse(res))) {
      return { ok: false, reason: "device_retired", status: 403 };
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      const serverEpoch = Number(res.headers.get("X-Sync-Epoch") || body.epoch);
      return {
        ok: false,
        reason: body.error === "stale_epoch" ? "stale_epoch" : "conflict",
        status: 409,
        epoch: Number.isSafeInteger(serverEpoch) ? serverEpoch : undefined,
        error: body.error || "conflict",
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "http_error", status: res.status, error: text.slice(0, 200) };
    }
    const body = await res.json().catch(() => ({}));
    const epoch = Number(res.headers.get("X-Sync-Epoch") || body.epoch);
    return {
      ok: true,
      revision: Number(body.revision || doc.revision) || 0,
      etag: res.headers.get("ETag") || body.etag || "",
      epoch: Number.isSafeInteger(epoch) ? epoch : undefined,
    };
  } catch (e) {
    const detail = e?.name === "AbortError" ? "请求超时（10 秒）" : e?.message || String(e);
    return { ok: false, reason: "network_error", error: `${detail} · ${url}` };
  }
}

/**
 * @param {HttpSyncConfig} cfg
 */
export async function httpHealth(cfg) {
  const baseUrl = String(cfg?.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, reason: "no_url" };
  try {
    const res = await syncHttpFetchWithTimeout(joinUrl(baseUrl, "/health"), {
      headers: { Accept: "application/json", ...authHeaders(cfg.token) },
    });
    if (!res.ok) return { ok: false, reason: "http_error", status: res.status };
    const body = await res.json().catch(() => ({}));
    // 展开常用字段，调用方不必再写 health.body.xxx
    return { ok: true, body, ...body };
  } catch (e) {
    const detail = e?.name === "AbortError" ? "请求超时（10 秒）" : e?.message || String(e);
    return { ok: false, reason: "network_error", error: `${detail} · ${joinUrl(baseUrl, "/health")}` };
  }
}

/**
 * 设备确认：本地已把远端 revision 持久保存后调用。
 * 服务端只记录“这台设备确认到了哪个版本”，不会因此删除任何数据。
 * 失败不应影响同步本身，调用方可以忽略返回值。
 *
 * @param {HttpSyncConfig} cfg
 * @param {{ deviceId: string, revision: number, protocol?: number }} payload
 */
export async function httpConfirmSyncState(cfg, payload) {
  const baseUrl = String(cfg?.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, reason: "no_url" };
  const url = joinUrl(baseUrl, "/v1/sync/confirm");
  try {
    const res = await syncHttpFetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders(cfg.token, cfg),
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
    if (res.status === 403 && (await isDeviceRetiredResponse(res))) {
      return { ok: false, reason: "device_retired", status: 403 };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "http_error", status: res.status, error: text.slice(0, 200) };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, revision: Number(body.revision) || 0, epoch: Number(body.epoch) || 0 };
  } catch (e) {
    const detail = e?.name === "AbortError" ? "请求超时（10 秒）" : e?.message || String(e);
    return { ok: false, reason: "network_error", error: `${detail} · ${url}` };
  }
}

/**
 * 设备配对：用主管理 Token 为指定 deviceId 签发独立凭据。
 * deviceSecret 明文只在本次响应中出现一次，调用方应立即持久保存。
 *
 * @param {HttpSyncConfig} cfg 需携带主管理 token
 * @param {{ deviceId: string, deviceName?: string }} payload
 * @returns {Promise<{ ok: true, deviceId: string, deviceSecret: string } | { ok: false, reason: string, status?: number, error?: string }>}
 */
export async function httpPairDevice(cfg, payload) {
  const baseUrl = String(cfg?.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, reason: "no_url" };
  const deviceId = String(payload?.deviceId || "").trim();
  if (!deviceId) return { ok: false, reason: "invalid_device_id" };
  const url = joinUrl(baseUrl, "/v1/sync/pair");
  try {
    const res = await syncHttpFetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders(cfg.token),
      },
      body: JSON.stringify({ deviceId, deviceName: payload?.deviceName }),
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "http_error", status: res.status, error: text.slice(0, 200) };
    }
    const body = await res.json().catch(() => ({}));
    if (!body?.ok || typeof body.deviceSecret !== "string" || !body.deviceSecret) {
      return { ok: false, reason: "invalid_response", status: res.status };
    }
    return { ok: true, deviceId: body.deviceId || deviceId, deviceSecret: body.deviceSecret };
  } catch (e) {
    const detail = e?.name === "AbortError" ? "请求超时（10 秒）" : e?.message || String(e);
    return { ok: false, reason: "network_error", error: `${detail} · ${url}` };
  }
}

/**
 * 拉取协同设备表与健康度诊断（不含 secretHash，服务端已脱敏）。
 *
 * @param {HttpSyncConfig} cfg 需携带主管理 token
 * @returns {Promise<{ ok: true, revision: number, epoch: number, devices: Array<object>, reclaimCandidates: string[] } | { ok: false, reason: string, status?: number, error?: string }>}
 */
export async function httpGetDevices(cfg) {
  const baseUrl = String(cfg?.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, reason: "no_url" };
  const url = joinUrl(baseUrl, "/v1/sync/devices");
  try {
    const res = await syncHttpFetchWithTimeout(url, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders(cfg.token) },
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "http_error", status: res.status, error: text.slice(0, 200) };
    }
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      revision: Number(body?.revision) || 0,
      epoch: Number(body?.epoch) || 0,
      devices: Array.isArray(body?.devices) ? body.devices : [],
      reclaimCandidates: Array.isArray(body?.reclaimCandidates) ? body.reclaimCandidates : [],
    };
  } catch (e) {
    const detail = e?.name === "AbortError" ? "请求超时（10 秒）" : e?.message || String(e);
    return { ok: false, reason: "network_error", error: `${detail} · ${url}` };
  }
}

/**
 * 退役 / 复职一台协同设备（管理操作，需主管理 token）。
 * 退役后该设备的 Device 凭据立即失效（403 device_retired）。
 *
 * @param {HttpSyncConfig} cfg 需携带主管理 token
 * @param {{ deviceId: string, retired?: boolean }} payload retired 省略时默认 true
 */
export async function httpRetireDevice(cfg, payload) {
  const baseUrl = String(cfg?.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, reason: "no_url" };
  const deviceId = String(payload?.deviceId || "").trim();
  if (!deviceId) return { ok: false, reason: "invalid_device_id" };
  const url = joinUrl(baseUrl, "/v1/sync/devices/retire");
  try {
    const res = await syncHttpFetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders(cfg.token),
      },
      body: JSON.stringify({ deviceId, retired: payload?.retired !== false }),
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "http_error", status: res.status, error: text.slice(0, 200) };
    }
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      deviceId: body?.deviceId || deviceId,
      retired: body?.retired !== false,
      reclaimCandidates: Array.isArray(body?.reclaimCandidates) ? body.reclaimCandidates : [],
    };
  } catch (e) {
    const detail = e?.name === "AbortError" ? "请求超时（10 秒）" : e?.message || String(e);
    return { ok: false, reason: "network_error", error: `${detail} · ${url}` };
  }
}
