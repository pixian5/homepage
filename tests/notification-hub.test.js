import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createNotificationHub, SYNC_MERGE_TOAST_KEY } from "../src/js/notification-hub.js";

function createMockStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, val) {
      store.set(key, String(val));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

describe("notification-hub", () => {
  test("toastSyncMergedOnce throttles repeated toasts within interval", () => {
    const storage = createMockStorage();
    const toasts = [];
    const hub = createNotificationHub({
      getData: () => ({ settings: {} }),
      toast: (msg, type) => toasts.push({ msg, type }),
      t: (key) => key,
      persistData: async () => {},
      storage,
      syncToastIntervalMs: 1000,
    });

    const first = hub.toastSyncMergedOnce();
    assert.equal(first, true);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, "warning");
    assert.ok(storage.getItem(SYNC_MERGE_TOAST_KEY));

    // 立即再次调用应被抑制
    const second = hub.toastSyncMergedOnce();
    assert.equal(second, false);
    assert.equal(toasts.length, 1);

    // 模拟时间流逝超过 1000ms
    storage.setItem(SYNC_MERGE_TOAST_KEY, String(Date.now() - 1500));
    const third = hub.toastSyncMergedOnce();
    assert.equal(third, true);
    assert.equal(toasts.length, 2);
  });

  test("consumeSaveToast pops fresh toast and persists", async () => {
    const toasts = [];
    let persisted = 0;
    const data = {
      settings: {
        lastSaveToast: {
          ts: Date.now() - 1000,
          groupName: "工作区",
        },
      },
    };

    const hub = createNotificationHub({
      getData: () => data,
      toast: (msg) => toasts.push(msg),
      t: (key, vars) => `${key}:${vars?.name || ""}`,
      persistData: async () => {
        persisted += 1;
      },
      consumeTimeoutMs: 5000,
    });

    const consumed = await hub.consumeSaveToast();
    assert.equal(consumed, true);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0], "toast.savedToGroup:工作区");
    assert.equal(data.settings.lastSaveToast, null);
    assert.equal(persisted, 1);
  });

  test("consumeSaveToast clears expired toast without notifying", async () => {
    const toasts = [];
    let persisted = 0;
    const data = {
      settings: {
        lastSaveToast: {
          ts: Date.now() - 10000,
          groupName: "过期分组",
        },
      },
    };

    const hub = createNotificationHub({
      getData: () => data,
      toast: (msg) => toasts.push(msg),
      t: (key) => key,
      persistData: async () => {
        persisted += 1;
      },
      consumeTimeoutMs: 5000,
    });

    const consumed = await hub.consumeSaveToast();
    assert.equal(consumed, false);
    assert.equal(toasts.length, 0, "超时的 toast 不应弹出");
    assert.equal(data.settings.lastSaveToast, null, "超时的 toast 应被清除");
    assert.equal(persisted, 1);
  });

  test("listenForExternalToast registers listener and dispatches toast", () => {
    const toasts = [];
    let registeredListener = null;
    const mockApi = {
      runtime: {
        onMessage: {
          addListener(fn) {
            registeredListener = fn;
          },
        },
      },
    };

    const hub = createNotificationHub({
      getData: () => ({ settings: {} }),
      toast: (msg) => toasts.push(msg),
      t: (key) => key,
      persistData: async () => {},
      getApi: () => mockApi,
    });

    hub.listenForExternalToast();
    assert.ok(typeof registeredListener === "function");

    let response = null;
    const handled = registeredListener({ type: "homepage_show_toast", text: "已保存到快捷方式" }, {}, (res) => {
      response = res;
    });

    assert.equal(handled, true);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0], "已保存到快捷方式");
    assert.deepEqual(response, { ok: true });

    // 非相关消息忽略
    const ignored = registeredListener({ type: "other_event" }, {}, () => {});
    assert.equal(handled ? ignored : false, false);
  });
});
