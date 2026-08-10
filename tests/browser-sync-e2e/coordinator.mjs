import { createServer } from "node:http";

const GLOBAL_EVENTS = new Set(["add-a-pushed", "add-b-resolved", "edit-a-pushed", "edit-b-resolved"]);
const PRIVATE_EVENTS = new Set(["source-data"]);
const SAFE_EXTENSION_ORIGIN = /^(?:chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;

function writeJson(req, res, status, body) {
  const origin = String(req.headers.origin || "");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (SAFE_EXTENSION_ORIGIN.test(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

export async function startCoordinator({ nonce, host = "127.0.0.1", port = 0, onEvent = () => {} }) {
  if (!nonce) throw new Error("coordinator nonce is required");
  const events = new Map();
  const waiters = new Map();

  const publish = (key, value) => {
    events.set(key, value);
    const queued = waiters.get(key) || [];
    waiters.delete(key);
    for (const resolve of queued) resolve(value);
  };

  const server = createServer((req, res) => {
    const origin = String(req.headers.origin || "");
    if (origin && !SAFE_EXTENSION_ORIGIN.test(origin)) {
      return writeJson(req, res, 403, { ok: false, error: "origin_forbidden" });
    }

    if (req.method === "OPTIONS") {
      if (!origin) return writeJson(req, res, 403, { ok: false, error: "origin_required" });
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-E2E-Session",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      return res.end();
    }

    if (req.headers["x-e2e-session"] !== nonce) {
      return writeJson(req, res, 401, { ok: false, error: "invalid_session" });
    }

    const url = new URL(req.url || "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/event") {
      const name = url.searchParams.get("name") || "";
      return writeJson(req, res, 200, { ready: events.has(name), value: events.get(name) || null });
    }

    if (req.method === "POST" && url.pathname === "/event") {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      req.on("end", () => {
        if (size > 4 * 1024 * 1024) return writeJson(req, res, 413, { ok: false, error: "body_too_large" });
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!/^[AB]$/.test(body.role) || !/^[a-z0-9-]+$/.test(body.name)) {
            return writeJson(req, res, 400, { ok: false, error: "invalid_event" });
          }
          const details = body.details && typeof body.details === "object" ? body.details : {};
          publish(`${body.name}:${body.role}`, details);
          if (GLOBAL_EVENTS.has(body.name)) publish(body.name, details);
          const publicDetails = PRIVATE_EVENTS.has(body.name)
            ? { keys: Object.keys(details.homepageData || {}), nodeCount: Object.keys(details.homepageData?.nodes || {}).length }
            : details;
          onEvent({ role: body.role, name: body.name, details: publicDetails });
          return writeJson(req, res, 200, { ok: true });
        } catch (error) {
          return writeJson(req, res, 400, { ok: false, error: error.message });
        }
      });
      return;
    }

    return writeJson(req, res, 404, { ok: false, error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("coordinator address unavailable");

  return {
    url: `http://${host}:${address.port}`,
    events,
    publish,
    waitFor(name, timeoutMs = 30_000) {
      if (events.has(name)) return Promise.resolve(events.get(name));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const queued = waiters.get(name) || [];
          waiters.set(
            name,
            queued.filter((entry) => entry !== done),
          );
          reject(new Error(`event timeout: ${name}`));
        }, timeoutMs);
        const done = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.set(name, [...(waiters.get(name) || []), done]);
      });
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
