/**
 * Tooltip 提示管理器（tooltip-manager.js）测试（轻量 DOM Mock）：
 * - 延时出现：防抖窗口内不显示、到点显示，重复悬停重置计时；
 * - 文本设置与 hidden 类切换；
 * - 定位防越界：右/下越界向内钳制（保留 8px 边距）、未越界原样偏移 12px；
 * - 即时隐藏：清除待显示定时器并立即隐藏；
 * - isEnabled=false 时不显示。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTooltipManager } from "../src/js/tooltip-manager.js";

function fakeTooltip({ width = 0, height = 0 } = {}) {
  const classes = new Set(["hidden"]);
  return {
    classes,
    textContent: "",
    style: {},
    get offsetWidth() {
      return width;
    },
    get offsetHeight() {
      return height;
    },
    classList: {
      add: (...names) => {
        for (const n of names) classes.add(n);
      },
      remove: (...names) => {
        for (const n of names) classes.delete(n);
      },
      contains: (n) => classes.has(n),
    },
  };
}

function setup({ width = 120, height = 40, viewport, enabled = true } = {}) {
  const el = fakeTooltip({ width, height });
  const manager = createTooltipManager({
    tooltipEl: () => el,
    delayMs: 20,
    isEnabled: () => enabled,
    getViewport: () => viewport || { width: 1000, height: 800 },
  });
  return { manager, el };
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tooltip-manager", () => {
  it("shows after the debounce delay with text set", async () => {
    const { manager, el } = setup();
    manager.scheduleShow("标题\nhttps://example.com/", 100, 100);
    assert.ok(el.classes.has("hidden"), "防抖窗口内不显示");
    await tick(35);
    assert.ok(!el.classes.has("hidden"), "到点显示");
    assert.equal(el.textContent, "标题\nhttps://example.com/");
  });

  it("resets the timer when hovering again within the window", async () => {
    const { manager, el } = setup();
    manager.scheduleShow("A", 10, 10);
    await tick(12);
    manager.scheduleShow("B", 20, 20); // 重置
    await tick(12);
    assert.ok(el.classes.has("hidden"), "重置后未到点仍隐藏");
    await tick(15);
    assert.ok(!el.classes.has("hidden"));
    assert.equal(el.textContent, "B", "显示最后一次内容");
  });

  it("clamps position to stay inside the viewport with a margin", () => {
    const { manager, el } = setup({ width: 120, height: 40, viewport: { width: 200, height: 150 } });
    // (990, 130) + 12 偏移 + 尺寸 → 右/下均越界
    manager.showTooltip("x", 990, 130);
    assert.equal(el.style.transform, "translate3d(72px, 102px, 0)", "右钳到 200-120-8=72，下钳到 150-40-8=102");

    // 未越界：原样 +12 偏移
    manager.showTooltip("y", 10, 10);
    assert.equal(el.style.transform, "translate3d(22px, 22px, 0)");
  });

  it("hides immediately and cancels a pending show", async () => {
    const { manager, el } = setup();
    manager.scheduleShow("pending", 10, 10);
    manager.hideTooltip();
    assert.ok(el.classes.has("hidden"), "立即隐藏");
    await tick(35);
    assert.ok(el.classes.has("hidden"), "被取消的定时器不再显示");
  });

  it("never shows when disabled by settings", async () => {
    const { manager, el } = setup({ enabled: false });
    manager.scheduleShow("off", 10, 10);
    await tick(35);
    assert.ok(el.classes.has("hidden"));
    manager.showTooltip("off-now", 10, 10);
    assert.ok(el.classes.has("hidden"), "立即显示也受开关拦截");
  });
});
