import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cancelScheduledPush,
  initSyncEngine,
  isRemoteUpdateFromAnotherDevice,
  pushNow,
  schedulePush,
} from "../src/js/sync_engine.js";
import { httpHealth, httpPullState, httpPushState } from "../src/js/sync_http_transport.js";
import { _setDeviceIdForTests } from "../src/js/sync_ids.js";
import { hashSyncDocument } from "../src/js/sync_projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function baseData(baseUrl, token) {
  return {
    schemaVersion: 1,
    settings: { syncEnabled: true, syncServerUrl: baseUrl, syncServerToken: token, syncInterval: "off" },
    groups: [
      { id: "grp_all", name: "全部", order: -1, nodes: ["n1"], updatedAt: 1, updatedBy: "dev_a", systemAllGroup: true },
    ],
    nodes: {
      n1: {
        id: "n1",
        type: "item",
        title: "Initial",
        url: "https://example.test/",
        iconType: "auto",
        updatedAt: 1,
        updatedBy: "dev_a",
      },
    },
    backups: [],
    lastUpdated: 1,
  };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function waitForHealth(baseUrl, token) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await httpHealth({ baseUrl, token })).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("sync engine test server did not start");
}

describe("sync_engine scheduling", () => {
  const originalClearTimeout = globalThis.clearTimeout;

  afterEach(() => {
    globalThis.clearTimeout = originalClearTimeout;
    cancelScheduledPush();
  });

  it("cancels a pending debounced push before manual synchronization", () => {
    let wasCleared = false;
    globalThis.clearTimeout = (timer) => {
      wasCleared = true;
      return originalClearTimeout(timer);
    };
    initSyncEngine({
      getData: () => ({ settings: { syncEnabled: true } }),
      setData: () => {},
      saveLocal: async () => null,
    });

    schedulePush();
    cancelScheduledPush();

    assert.equal(wasCleared, true);
  });
});

describe("sync_engine remote-device attribution", () => {
  it("does not report this device's pre-push pull as another device, but reports a real peer", async () => {
    const port = 23000 + (process.pid % 2000);
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = "sync-engine-test-token";
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "homepage-sync-engine-test."));
    const child = spawn(process.execPath, [path.join(root, "scripts", "sync-server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        TOKEN: token,
        DATA_FILE: path.join(tempDir, "state.json"),
      },
      stdio: "ignore",
    });

    try {
      await waitForHealth(baseUrl, token);
      let data = baseData(baseUrl, token);
      const merged = [];
      _setDeviceIdForTests("dev_a");
      initSyncEngine({
        getData: () => data,
        setData: (next) => {
          data = next;
        },
        saveLocal: async () => null,
        onMerged: async (_next, stats) => merged.push(stats),
      });

      const initial = await pushNow("initial");
      assert.equal(initial.ok, true);
      const firstRemote = await httpPullState({ baseUrl, token });
      assert.equal(firstRemote.ok, true);

      const sameDeviceDoc = structuredClone(firstRemote.doc);
      sameDeviceDoc.deviceId = "dev_a";
      sameDeviceDoc.nodes[0].title = "Written by this device";
      sameDeviceDoc.nodes[0].updatedAt = 2;
      sameDeviceDoc.nodes[0].titleUpdatedAt = 2;
      sameDeviceDoc.nodes[0].updatedBy = "dev_a";
      sameDeviceDoc.writtenAt = 2;
      sameDeviceDoc.contentHash = hashSyncDocument(sameDeviceDoc);
      const sameDeviceWrite = await httpPushState({ baseUrl, token }, sameDeviceDoc, { ifMatch: firstRemote.etag });
      assert.equal(sameDeviceWrite.ok, true);

      const selfPrePull = await pushNow("schedule");
      assert.equal(selfPrePull.ok, true);
      assert.equal(merged.at(-1)?.remoteNewer, false);
      assert.equal(merged.at(-1)?.remoteDeviceId, "dev_a");

      const afterSelf = await httpPullState({ baseUrl, token });
      assert.equal(afterSelf.ok, true);
      const peerDoc = structuredClone(afterSelf.doc);
      peerDoc.deviceId = "dev_b";
      peerDoc.nodes[0].title = "Written by another device";
      peerDoc.nodes[0].updatedAt = 3;
      peerDoc.nodes[0].titleUpdatedAt = 3;
      peerDoc.nodes[0].updatedBy = "dev_b";
      peerDoc.writtenAt = 3;
      peerDoc.contentHash = hashSyncDocument(peerDoc);
      const peerWrite = await httpPushState({ baseUrl, token }, peerDoc, { ifMatch: afterSelf.etag });
      assert.equal(peerWrite.ok, true);

      const peerPrePull = await pushNow("schedule");
      assert.equal(peerPrePull.ok, true);
      assert.equal(merged.at(-1)?.remoteNewer, true);
      assert.equal(merged.at(-1)?.remoteDeviceId, "dev_b");
    } finally {
      _setDeviceIdForTests("");
      await stopServer(child);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires a newer revision and a different known device id", () => {
    assert.equal(
      isRemoteUpdateFromAnotherDevice({
        previousRemoteRevision: 1,
        remoteRevision: 2,
        remoteDeviceId: "dev_a",
        deviceId: "dev_a",
      }),
      false,
    );
    assert.equal(
      isRemoteUpdateFromAnotherDevice({
        previousRemoteRevision: 1,
        remoteRevision: 2,
        remoteDeviceId: "dev_b",
        deviceId: "dev_a",
      }),
      true,
    );
    assert.equal(
      isRemoteUpdateFromAnotherDevice({
        previousRemoteRevision: 1,
        remoteRevision: 2,
        remoteDeviceId: "",
        deviceId: "dev_a",
      }),
      false,
    );
  });
});
