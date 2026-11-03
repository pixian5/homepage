/**
 * 存储变更热监听（storage-listener.js）测试：
 * - 扩展 storage.onChanged 分流：同步键刷新提示条、数据键时间戳回声忽略、
 *   写入窗口期与抑制期忽略、外部更新触发防抖重载、非 local 区域忽略；
 * - Web 模式 storage 事件：跨标签页数据键变更触发重载、回声忽略、其它键忽略；
 * - 防抖：连续多次变更只重载一次；dispose 后不再响应；
 * - 设置弹窗打开期间挂起，关闭后 flushPendingReload 补一次。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createStorageListener } from "../src/js/storage-listener.js";

const realChrome = globalThis.chrome;

/** 最小依赖（记录调用；状态可被用例翻转） */
function setup(overrides = {}) {
  const state = { persisting: false, suppressed: false, settingsOpen: false, lastUpdated: 100 };
  const calls = { reloads: 0, syncRefreshes: 0 };
  const listener = createStorageListener({
    dataKey: "homepage_data",
    syncKeys: ["homepage_sync_state", "homepage_sync_outbox"],
    getData: () => ({ lastUpdated: state.lastUpdated }),
    isPersistInFlight: () => state.persisting,
    isSuppressed: () => state.suppressed,
    isSettingsOpen: () => state.settingsOpen,
    reload: () => {
      calls.reloads += 1;
    },
    onSyncKeysChanged: () => {
      calls.syncRefreshes += 1;
    },
    reloadDelayMs: 5,
    ...overrides,
  });
  return { listener, state, calls };
}

/** 等防抖定时器触发 */
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** 触发防抖后的重载并等待 */
async function flushReloads(expected, calls) {
  await tick();
  assert.equal(calls.reloads, expected);
}

describe("storage-listener extension onChanged", () => {
  afterEach(() => {
    globalThis.chrome = realChrome;
  });

  it("routes sync-state keys to the banner refresh without reloading", () => {
    const { listener, calls } = setup();
    listener.handleExtensionChanges({ homepage_sync_state: { newValue: 1 } }, "local");
    assert.equal(calls.syncRefreshes, 1);
    assert.equal(calls.reloads, 0, "同步键不得触发数据重载");
  });

  it("ignores echo writes whose timestamp is not ahead of local", async () => {
    const { listener, state, calls } = setup();
    state.lastUpdated = 200;
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 150 } } }, "local");
    await flushReloads(0, calls);
    // 相同时间戳同样视为回声
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 200 } } }, "local");
    await flushReloads(0, calls);
  });

  it("ignores changes while persisting or suppressed, and non-local areas", async () => {
    const { listener, state, calls } = setup();
    state.persisting = true;
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 500 } } }, "local");
    state.persisting = false;
    state.suppressed = true;
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 500 } } }, "local");
    state.suppressed = false;
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 500 } } }, "sync");
    listener.handleExtensionChanges({ other_key: { newValue: 1 } }, "local");
    await flushReloads(0, calls);
  });

  it("debounces a genuinely newer external write into a single reload", async () => {
    const { listener, calls } = setup();
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 300 } } }, "local");
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 301 } } }, "local");
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 302 } } }, "local");
    await flushReloads(1, calls);
  });

  it("stops responding after dispose", async () => {
    const { listener, calls } = setup();
    const dispose = listener.bind();
    dispose();
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 999 } } }, "local");
    await flushReloads(0, calls);
  });
});

describe("storage-listener web storage event", () => {
  it("reloads on cross-tab homepage_data change and ignores echoes and other keys", async () => {
    const { listener, calls } = setup();
    // 其它键
    listener.handleWebStorageEvent({ key: "homepage_sync_state", newValue: "1" });
    // 回声（时间戳不超前）
    listener.handleWebStorageEvent({ key: "homepage_data", newValue: JSON.stringify({ lastUpdated: 50 }) });
    await flushReloads(0, calls);
    // 真正的外部更新
    listener.handleWebStorageEvent({ key: "homepage_data", newValue: JSON.stringify({ lastUpdated: 400 }) });
    await flushReloads(1, calls);
    // 解析失败的载荷交给重载兜底
    listener.handleWebStorageEvent({ key: "homepage_data", newValue: "{broken json" });
    await flushReloads(2, calls);
  });

  it("binds to window storage events and removes them on dispose", async () => {
    const added = [];
    const removed = [];
    globalThis.window = {
      addEventListener: (type, fn) => added.push({ type, fn }),
      removeEventListener: (type, fn) => removed.push({ type, fn }),
    };
    const { listener, calls } = setup();
    const dispose = listener.bind();
    assert.equal(added.length, 1);
    assert.equal(added[0].type, "storage");
    // 直接派发绑定的处理器（模拟跨标签页事件）
    added[0].fn({ key: "homepage_data", newValue: JSON.stringify({ lastUpdated: 900 }) });
    await flushReloads(1, calls);
    dispose();
    assert.equal(removed.length, 1);
    delete globalThis.window;
  });
});

describe("storage-listener settings-modal deferral", () => {
  it("defers reload while settings are open and flushes once after close", async () => {
    const { listener, state, calls } = setup();
    state.settingsOpen = true;
    listener.handleExtensionChanges({ homepage_data: { newValue: { lastUpdated: 700 } } }, "local");
    await flushReloads(0, calls);
    assert.equal(listener.hasPendingReload, true, "设置打开期间挂起重载");

    // 关闭设置后补一次（flush 内部再次走防抖）
    state.settingsOpen = false;
    assert.equal(listener.flushPendingReload(), true);
    await flushReloads(1, calls);
    assert.equal(listener.flushPendingReload(), false, "无挂起时 flush 返回 false");
  });
});
