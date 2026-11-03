/**
 * Toast 提示体系（toast-manager.js）测试（轻量 DOM Mock + fake timers）：
 * - 三种类型：默认 success、显式 error/warning、兼容签名（第 2/3/4 参各种组合）；
 * - ARIA：role=status，error 为 aria-live=assertive、其余 polite；
 * - 动作按钮：点击执行回调并立即清除；
 * - 自动消失定时器：动态时长（getDurationMs）与固定时长兜底；
 * - 多条并存；容器缺失安全跳过。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { createToastManager } from "../src/js/toast-manager.js";

function fakeContainer() {
  const children = [];
  return {
    children,
    appendChild: (el) => children.push(el),
  };
}

function fakeEl() {
  const listeners = new Map();
  return {
    removed: false,
    className: "",
    textContent: "",
    attrs: {},
    listeners,
    children: [],
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn({ preventDefault: () => {}, ...event });
    },
    appendChild(child) {
      this.children.push(child);
    },
    remove() {
      this.removed = true;
    },
  };
}

/** 最小 document mock：createElement 产出 fakeEl */
function stubDocument() {
  if (!globalThis.document) globalThis.document = {};
  globalThis.document.createElement = () => fakeEl();
}

describe("toast-manager", () => {
  beforeEach(() => {
    stubDocument();
  });

  it("renders the default success kind with polite aria-live", () => {
    const container = fakeContainer();
    const manager = createToastManager({ containerEl: () => container, durationMs: 50 });
    manager.toast("已保存");
    assert.equal(container.children.length, 1);
    const el = container.children[0];
    assert.equal(el.className, "toast toast-success");
    assert.equal(el.attrs.role, "status");
    assert.equal(el.attrs["aria-live"], "polite");
    assert.equal(el.children[0].textContent, "已保存");
  });

  it("supports explicit kinds via all compatible signatures", () => {
    const container = fakeContainer();
    const manager = createToastManager({ containerEl: () => container, durationMs: 50 });
    manager.toast("失败", "error");
    assert.equal(container.children[0].className, "toast toast-error");
    assert.equal(container.children[0].attrs["aria-live"], "assertive", "error 为 assertive");

    manager.toast("警告", "warning");
    assert.equal(container.children[1].className, "toast toast-warning");

    // toast(msg, actionLabel, actionFn, "warning") 四参形态
    manager.toast("删除", "撤销", () => {}, "warning");
    assert.equal(container.children[2].className, "toast toast-warning");
    assert.ok(container.children[2].children[1], "带动作按钮");

    // 非法类型串按动作标签处理，kind 保持默认
    manager.toast("x", "someLabel");
    assert.equal(container.children[3].className, "toast toast-success");
  });

  it("runs the action and removes the toast on button click", () => {
    const container = fakeContainer();
    const manager = createToastManager({ containerEl: () => container, durationMs: 5000 });
    let fired = 0;
    manager.toast("已删除 3 项", "撤销", () => {
      fired += 1;
    });
    const el = container.children[0];
    const button = el.children[1];
    assert.equal(button.textContent, "撤销");
    button.dispatch("click");
    assert.equal(fired, 1, "动作回调执行");
    assert.equal(el.removed, true, "点击后立即清除");
  });

  it("auto-removes after the resolved duration (dynamic over fixed)", async () => {
    const container = fakeContainer();
    let dynamic = 30;
    const manager = createToastManager({
      containerEl: () => container,
      durationMs: 9999,
      getDurationMs: () => dynamic,
    });
    manager.toast("A");
    manager.toast("B");
    assert.equal(container.children.length, 2, "多条并存");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(container.children[0].removed, true, "30ms 后自动清除");
    assert.equal(container.children[1].removed, true);

    // getDurationMs 返回非法值时回退固定 durationMs
    dynamic = 0;
    manager.toast("C");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(container.children[2].removed, false, "20ms 内仍在（固定 9999ms）");
  });

  it("skips safely when the container is missing", () => {
    const manager = createToastManager({ containerEl: () => null, durationMs: 10 });
    assert.doesNotThrow(() => manager.toast("无容器"));
  });
});
