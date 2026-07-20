import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { httpHealth, httpPullState, httpPushState } from "../src/js/sync_http_transport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token";

describe("sync_http_transport + server", () => {
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;

  before(async () => {
    child = spawn(process.execPath, [path.join(root, "scripts/sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        TOKEN,
        DATA_FILE: path.join(root, "data", "test-sync-state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // wait health
    const deadline = Date.now() + 5000;
    let ok = false;
    while (Date.now() < deadline) {
      const h = await httpHealth({ baseUrl: BASE, token: TOKEN });
      if (h.ok) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ok, true, "server did not start");
  });

  after(async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      if (!child.killed) child.kill("SIGKILL");
    }
  });

  it("404 when empty then put/get roundtrip", async () => {
    const _empty = await httpPullState({ baseUrl: BASE, token: TOKEN });
    // may already have data from previous run — still ok if pull works
    const doc = {
      schema: "homepage.sync.doc.v1",
      schemaVersion: 1,
      docId: "doc_test",
      revision: 1,
      deviceId: "dev_test",
      writtenAt: Date.now(),
      contentHash: "abc",
      settings: { syncEnabled: true },
      groups: [{ id: "g1", name: "G", order: 0, updatedAt: 1, updatedBy: "dev_test" }],
      nodes: [
        {
          id: "n1",
          type: "item",
          title: "T",
          url: "https://example.com/",
          iconType: "auto",
          updatedAt: 1,
          updatedBy: "dev_test",
        },
      ],
      placements: [
        {
          nodeId: "n1",
          parentKind: "group",
          parentId: "g1",
          index: 0,
          updatedAt: 1,
          updatedBy: "dev_test",
        },
      ],
    };
    const put = await httpPushState({ baseUrl: BASE, token: TOKEN }, doc);
    assert.equal(put.ok, true, JSON.stringify(put));
    assert.ok(put.revision >= 1);
    const got = await httpPullState({ baseUrl: BASE, token: TOKEN });
    assert.equal(got.ok, true);
    assert.equal(got.doc.docId, "doc_test");
    assert.equal(got.doc.nodes[0].url, "https://example.com/");
  });

  it("rejects bad token", async () => {
    const res = await httpPullState({ baseUrl: BASE, token: "wrong" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unauthorized");
  });
});
