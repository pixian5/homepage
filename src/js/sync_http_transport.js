/**
 * 自建 HTTP JSON 同步 transport
 * 协议见 scripts/sync-server.mjs
 */

/**
 * @typedef {{ baseUrl: string, token?: string }} HttpSyncConfig
 */

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function authHeaders(token) {
  let t = String(token || "").trim();
  if (!t) return {};
  // 用户若粘贴了 "Bearer xxx"，避免变成 "Bearer Bearer xxx"
  if (/^Bearer\s+/i.test(t)) t = t.replace(/^Bearer\s+/i, "").trim();
  if (!t) return {};
  return { Authorization: `Bearer ${t}` };
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
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...authHeaders(cfg.token),
      },
    });
    if (res.status === 404) return { ok: false, reason: "no_remote", status: 404 };
    if (res.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
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
    return { ok: true, doc, revision, etag };
  } catch (e) {
    return { ok: false, reason: "network_error", error: e?.message || String(e) };
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
      ...authHeaders(cfg.token),
    };
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const res = await fetch(url, {
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "http_error", status: res.status, error: text.slice(0, 200) };
    }
    const body = await res.json().catch(() => ({}));
    return {
      ok: true,
      revision: Number(body.revision || doc.revision) || 0,
      etag: res.headers.get("ETag") || body.etag || "",
    };
  } catch (e) {
    return { ok: false, reason: "network_error", error: e?.message || String(e) };
  }
}

/**
 * @param {HttpSyncConfig} cfg
 */
export async function httpHealth(cfg) {
  const baseUrl = String(cfg?.baseUrl || "").trim();
  if (!baseUrl) return { ok: false, reason: "no_url" };
  try {
    const res = await fetch(joinUrl(baseUrl, "/health"), {
      headers: { Accept: "application/json", ...authHeaders(cfg.token) },
    });
    if (!res.ok) return { ok: false, reason: "http_error", status: res.status };
    const body = await res.json().catch(() => ({}));
    return { ok: true, body };
  } catch (e) {
    return { ok: false, reason: "network_error", error: e?.message || String(e) };
  }
}
