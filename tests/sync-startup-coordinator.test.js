import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startSyncOnLaunch } from "../src/js/sync-startup-coordinator.js";

describe("sync-startup-coordinator", () => {
  it("returns null when sync is disabled", () => {
    let intervalRefreshed = false;
    const res = startSyncOnLaunch({
      settings: { syncEnabled: false },
      refreshSyncInterval: () => {
        intervalRefreshed = true;
      },
    });
    assert.equal(res, null);
    assert.equal(intervalRefreshed, false);
  });

  it("orchestrates pull, push on demand, flush and banner lifecycle when sync is enabled", async () => {
    let intervalRefreshed = false;
    let pulledReason = null;
    let pushedReason = null;
    let outboxFlushed = false;
    let rendered = false;
    let bannerStarted = false;
    let bannerRefreshed = false;

    const mockBanner = {
      start: async () => {
        bannerStarted = true;
      },
      refresh: async () => {
        bannerRefreshed = true;
      },
    };

    const res = startSyncOnLaunch({
      settings: { syncEnabled: true },
      refreshSyncInterval: () => {
        intervalRefreshed = true;
      },
      reloadSyncState: () => ({ status: "ok" }),
      getOutboxSummary: () => ({ total: 0 }),
      pullNow: async (reason) => {
        pulledReason = reason;
        return { needPush: true };
      },
      pushNow: async (reason) => {
        pushedReason = reason;
      },
      flushOutbox: async () => {
        outboxFlushed = true;
      },
      openSettingsModal: () => {},
      getStorage: () => null,
      t: (k) => k,
      render: () => {
        rendered = true;
      },
      bannerFactory: () => mockBanner,
    });

    assert.ok(res);
    assert.equal(res.syncBanner, mockBanner);
    assert.equal(intervalRefreshed, true);
    assert.equal(bannerStarted, true);

    await res.startPromise;

    assert.equal(pulledReason, "init");
    assert.equal(pushedReason, "init_need_push");
    assert.equal(outboxFlushed, true);
    assert.equal(rendered, true);
    assert.equal(bannerRefreshed, true);
  });

  it("handles pull error gracefully and still refreshes banner", async () => {
    let bannerRefreshed = false;
    const mockBanner = {
      start: async () => {},
      refresh: async () => {
        bannerRefreshed = true;
      },
    };

    const res = startSyncOnLaunch({
      settings: { syncEnabled: true },
      refreshSyncInterval: () => {},
      reloadSyncState: () => ({ status: "error" }),
      getOutboxSummary: () => ({ total: 1 }),
      pullNow: async () => {
        throw new Error("Network unreachable");
      },
      pushNow: async () => {},
      flushOutbox: async () => {},
      openSettingsModal: () => {},
      getStorage: () => null,
      t: (k) => k,
      render: () => {},
      bannerFactory: () => mockBanner,
    });

    assert.ok(res);
    await res.startPromise;
    assert.equal(bannerRefreshed, true);
  });
});
