/**
 * 卡片打开方式管理器（open-mode-manager.js）测试：
 * - 修饰键与中键判定：中键→后台、Ctrl/Cmd→新标签、Shift→新标签、无修饰→持久化设置；
 * - 打开跳转双环境：扩展 tabs.create（background 不激活）、Web window.open / location；
 * - 循环切换：current→new→background→current、落盘失败回滚、按钮文案更新；
 * - recordVisit 副作用记录。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createOpenModeManager } from "../src/js/open-mode-manager.js";

const realChrome = globalThis.chrome;

function setup({ openMode = "current" } = {}) {
  const calls = { toasts: [], persists: [], visits: [], tabsCreated: [], windowOpened: [], locationAssigned: [] };
  const data = { settings: { openMode } };
  let tabsApi = null;
  const realWindowOpen = globalThis.window?.open;
  const realLocation = globalThis.window?.location;
  globalThis.window = globalThis.window || {};
  globalThis.window.open = (url, target) => {
    calls.windowOpened.push({ url, target });
    return {};
  };
  Object.defineProperty(globalThis.window, "location", {
    configurable: true,
    value: {
      set href(url) {
        calls.locationAssigned.push(url);
      },
    },
  });
  const manager = createOpenModeManager({
    getData: () => data,
    persist: async () => {
      calls.persists.push(data.settings.openMode);
      return calls.persistResult === undefined ? { ok: true } : calls.persistResult;
    },
    recordVisit: async (visit) => calls.visits.push(visit),
    toast: (message, kind) => calls.toasts.push({ message, kind }),
    t: (key) => key,
    getButton: () => ({ textContent: "" }),
  });
  return {
    manager,
    data,
    calls,
    useExtensionTabs() {
      tabsApi = { create: (opts) => calls.tabsCreated.push(opts) };
      globalThis.chrome = { runtime: { id: "ext" }, tabs: tabsApi };
    },
    restore() {
      globalThis.chrome = realChrome;
      if (realWindowOpen === undefined) delete globalThis.window.open;
      else globalThis.window.open = realWindowOpen;
      if (realLocation === undefined) delete globalThis.window.location;
      else Object.defineProperty(globalThis.window, "location", { configurable: true, value: realLocation });
    },
  };
}

describe("open-mode-manager getEffectiveOpenMode", () => {
  it("maps middle click and modifier keys to explicit modes", () => {
    const ctx = setup({ openMode: "current" });
    const { manager } = ctx;
    assert.equal(manager.getEffectiveOpenMode({ button: 1 }), "background", "中键 → 后台");
    assert.equal(manager.getEffectiveOpenMode({ button: 0, ctrlKey: true }), "new", "Ctrl → 新标签");
    assert.equal(manager.getEffectiveOpenMode({ button: 0, metaKey: true }), "new", "Cmd → 新标签");
    assert.equal(manager.getEffectiveOpenMode({ button: 0, shiftKey: true }), "new", "Shift → 新标签");
    assert.equal(manager.getEffectiveOpenMode({ button: 0 }), "current", "无修饰 → 持久化设置");
    assert.equal(manager.getEffectiveOpenMode(null), "current");
    ctx.restore();
  });

  it("falls back to current for unknown persisted modes", () => {
    const ctx = setup({ openMode: "weird-mode" });
    assert.equal(ctx.manager.getEffectiveOpenMode({ button: 0 }), "current");
    ctx.restore();
  });
});

describe("open-mode-manager openUrlWithMode", () => {
  it("uses chrome.tabs in extension mode with active honoring background", () => {
    const ctx = setup();
    ctx.useExtensionTabs();
    ctx.manager.openUrlWithMode("https://a.example.com/", "new");
    ctx.manager.openUrlWithMode("https://b.example.com/", "background");
    assert.deepEqual(ctx.calls.tabsCreated, [
      { url: "https://a.example.com/", active: true },
      { url: "https://b.example.com/", active: false },
    ]);
    assert.deepEqual(
      ctx.calls.visits.map((v) => v.url),
      ["https://a.example.com/", "https://b.example.com/"],
      "访问记录副作用",
    );
    ctx.restore();
  });

  it("falls back to window.open / location in pure web mode", () => {
    const ctx = setup();
    ctx.manager.openUrlWithMode("https://new.example.com/", "new");
    ctx.manager.openUrlWithMode("https://cur.example.com/", "current");
    assert.deepEqual(ctx.calls.windowOpened, [{ url: "https://new.example.com/", target: "_blank" }]);
    assert.deepEqual(ctx.calls.locationAssigned, ["https://cur.example.com/"]);
    ctx.restore();
  });

  it("openCard combines event detection with opening", () => {
    const ctx = setup({ openMode: "current" });
    ctx.manager.openCard("https://mid.example.com/", { button: 1 });
    // 纯 Web 模式下 background 也走 window.open
    assert.deepEqual(ctx.calls.windowOpened, [{ url: "https://mid.example.com/", target: "_blank" }]);
    ctx.restore();
  });
});

describe("open-mode-manager cycleOpenMode", () => {
  it("cycles through the three modes, persists, and updates the button", async () => {
    const ctx = setup({ openMode: "current" });
    await ctx.manager.cycleOpenMode();
    assert.equal(ctx.data.settings.openMode, "new");
    await ctx.manager.cycleOpenMode();
    assert.equal(ctx.data.settings.openMode, "background");
    await ctx.manager.cycleOpenMode();
    assert.equal(ctx.data.settings.openMode, "current", "三态循环");
    assert.deepEqual(ctx.calls.persists, ["new", "background", "current"], "每次切换都落盘");
    assert.equal(ctx.calls.toasts.length, 3);
    ctx.restore();
  });

  it("rolls back to the previous mode when persisting fails", async () => {
    const ctx = setup({ openMode: "current" });
    ctx.calls.persistResult = { ok: false };
    await ctx.manager.cycleOpenMode();
    assert.equal(ctx.data.settings.openMode, "current", "落盘失败回滚");
    assert.deepEqual(
      ctx.calls.toasts.map((x) => x.message),
      ["openMode.new", "openMode.saveFailed"],
    );
    ctx.restore();
  });
});
