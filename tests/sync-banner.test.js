import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSyncBanner,
  evaluateSyncBanner,
  SYNC_BANNER_DISMISS_MS,
  SYNC_BANNER_ERROR_GRACE_MS,
} from "../src/js/sync-banner.js";

const NOW = 1_800_000_000_000;

describe("sync-banner evaluateSyncBanner", () => {
  it("stays hidden when sync is healthy", () => {
    const verdict = evaluateSyncBanner({
      state: { status: "idle", lastError: "" },
      outbox: [],
      nowMs: NOW,
    });
    assert.equal(verdict.show, false);
  });

  it("stays hidden for a transient error inside the grace window", () => {
    const verdict = evaluateSyncBanner({
      state: { status: "error", lastError: "network_error", lastPushAt: NOW - 60_000 },
      outbox: [],
      nowMs: NOW,
    });
    assert.equal(verdict.show, false, "刚失败不到 10 分钟不该弹，避免网络抖动就打扰用户");
  });

  it("shows after the error persists past the grace window", () => {
    const verdict = evaluateSyncBanner({
      state: { status: "error", lastError: "network_error", lastPushAt: NOW - SYNC_BANNER_ERROR_GRACE_MS - 1 },
      outbox: [],
      nowMs: NOW,
    });
    assert.equal(verdict.show, true);
    assert.equal(verdict.reason, "error");
    assert.equal(verdict.text, "network_error");
  });

  it("shows when the error has no timestamp (legacy state)", () => {
    const verdict = evaluateSyncBanner({
      state: { status: "error", lastError: "unauthorized" },
      outbox: [],
      nowMs: NOW,
    });
    assert.equal(verdict.show, true, "老状态没有时间戳时也应提示，不能静默");
  });

  it("shows immediately when outbox exhausted", () => {
    const verdict = evaluateSyncBanner({
      state: { status: "error", lastError: "outbox_exhausted" },
      outbox: [{ targetKey: "http-server|homepage", attempts: 12, maxAttempts: 12 }],
      nowMs: NOW,
    });
    assert.equal(verdict.show, true);
    assert.equal(verdict.reason, "outbox_exhausted");
  });

  it("snoozes the exhausted banner for only 2h, not 24h", () => {
    const outbox = [{ targetKey: "http-server|homepage", attempts: 12, maxAttempts: 12 }];
    // 关闭后 1 小时：静默
    assert.equal(
      evaluateSyncBanner({ state: {}, outbox, dismissedAt: NOW - 60 * 60 * 1000, nowMs: NOW }).show,
      false,
      "刚关掉 1 小时内不该再弹",
    );
    // 关闭后 3 小时：重新提示（硬故障不能长期静默）
    assert.equal(
      evaluateSyncBanner({ state: {}, outbox, dismissedAt: NOW - 3 * 60 * 60 * 1000, nowMs: NOW }).show,
      true,
      "硬故障静默 2 小时后必须再次提醒",
    );
  });

  it("respects dismissal within 24h for soft errors", () => {
    const verdict = evaluateSyncBanner({
      state: { status: "error", lastError: "network_error", lastPushAt: NOW - SYNC_BANNER_ERROR_GRACE_MS - 1 },
      outbox: [],
      dismissedAt: NOW - 60 * 60 * 1000,
      nowMs: NOW,
    });
    assert.equal(verdict.show, false);
  });

  it("shows again once the 24h dismissal expires", () => {
    const verdict = evaluateSyncBanner({
      state: { status: "error", lastError: "network_error", lastPushAt: NOW - SYNC_BANNER_ERROR_GRACE_MS - 1 },
      outbox: [],
      dismissedAt: NOW - SYNC_BANNER_DISMISS_MS - 1000,
      nowMs: NOW,
    });
    assert.equal(verdict.show, true);
  });

  it("does not treat an outbox item below the limit as exhausted", () => {
    const verdict = evaluateSyncBanner({
      state: { status: "idle" },
      outbox: [{ targetKey: "http-server|homepage", attempts: 3, maxAttempts: 12 }],
      nowMs: NOW,
    });
    assert.equal(verdict.show, false);
  });

  it("retry preserves fresh refreshed error text instead of clobbering it with stale label", async () => {
    const prevDoc = globalThis.document;
    const makeEl = (hidden = false) => {
      const classes = new Set(hidden ? ["hidden"] : []);
      const listeners = new Map();
      const props = {};
      return {
        textContent: "",
        offsetHeight: 36,
        classList: {
          contains: (c) => classes.has(c),
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
        },
        style: { setProperty: (k, v) => (props[k] = v) },
        addEventListener: (type, fn) => {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        click: async () => {
          for (const fn of listeners.get("click") || []) await fn();
        },
      };
    };
    const banner = makeEl(true);
    const label = makeEl(false);
    label.textContent = "old_error_text";
    const retryBtn = makeEl(false);
    const body = makeEl(false);
    const docEl = makeEl(false);
    const map = new Map([
      ["syncBanner", banner],
      ["syncBannerText", label],
      ["btnSyncBannerRetry", retryBtn],
      ["btnSyncBannerSettings", makeEl(false)],
      ["btnSyncBannerDismiss", makeEl(false)],
    ]);
    globalThis.document = {
      getElementById: (id) => map.get(id) || null,
      body,
      documentElement: docEl,
    };

    try {
      let currentState = { status: "error", lastError: "old_err" };
      const ctrl = createSyncBanner({
        getState: async () => currentState,
        getOutbox: async () => [],
        onRetry: async () => {
          currentState = { status: "error", lastError: "fresh_auth_error" };
        },
        onOpenSettings: () => {},
        getStorage: () => ({ get: async () => ({}), set: async () => {} }),
        t: (key) => (key === "sync.banner.error" ? "ERR:{error}" : key),
      });
      await ctrl.start();
      assert.equal(label.textContent, "ERR:old_err");

      await retryBtn.click();
      assert.equal(banner.classList.contains("hidden"), false);
      assert.equal(label.textContent, "ERR:fresh_auth_error", "重试后应保留 refresh() 写入的最新错误文案");
    } finally {
      globalThis.document = prevDoc;
    }
  });
});
