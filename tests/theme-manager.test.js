/**
 * 主题与背景管线（theme-manager.js）测试（轻量 DOM Mock）：
 * - 主题切换：light/dark 写 data-theme、system 跟随 prefers-color-scheme；
 * - 字号与密度：--base-font/--tile-font/--grid-gap CSS 变量、非法密度回退 standard；
 * - 背景状态机：bing（加载成功/toast/缓存命中静默/失败回退纯色）、color/gradient/custom、
 *   防注入（setBackground 仅放行 url()/CSS 函数/关键字）、遮罩强度仅图片类生效；
 * - 签名对比：背景设置未变不重跑、变化后 refreshBackgroundIfChanged 重载、同页并发合并。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { backgroundSignature, createThemeManager } from "../src/js/theme-manager.js";

/** 最小 document/documentElement/background 元素 mock */
function setup(overrides = {}) {
  const cssVars = {};
  const attrs = {};
  const calls = { toasts: [], bingCalls: [] };
  const docEl = {
    style: { setProperty: (name, value) => (cssVars[name] = value) },
    setAttribute: (name, value) => (attrs[name] = value),
    getAttribute: (name) => attrs[name],
  };
  const backgroundEl = {
    classes: new Set(),
    style: {},
    get classList() {
      return {
        add: (...names) => {
          for (const n of names) this.classes.add(n);
        },
        remove: (...names) => {
          for (const n of names) this.classes.delete(n);
        },
        contains: (n) => this.classes.has(n),
      };
    },
  };
  let bingResponse = { dataUrl: "data:image/jpeg;base64,BING", fromCache: false, failed: false };
  const data = {
    settings: {
      theme: "system",
      gridDensity: "standard",
      fontSize: 14,
      backgroundType: "color",
      backgroundColor: "#123456",
      backgroundOverlayStrength: 0.2,
      language: "zh-CN",
    },
  };
  if (typeof globalThis.document === "undefined" || !globalThis.document) {
    globalThis.document = { documentElement: docEl };
  }
  globalThis.document = { ...globalThis.document, documentElement: docEl };
  globalThis.window = {
    matchMedia: (query) => ({
      matches: false,
      addEventListener: () => {},
    }),
    ...(overrides.window || {}),
  };
  const manager = createThemeManager({
    getData: () => data,
    getBackgroundEl: () => backgroundEl,
    getBingWallpaper: async (language) => {
      calls.bingCalls.push(language);
      return typeof bingResponse === "function" ? bingResponse() : bingResponse;
    },
    isSafeCssColor: (input) => /^#[0-9a-fA-F]{3,8}$/.test(String(input || "")),
    toast: (message, kind) => calls.toasts.push({ message, kind }),
    t: (key) => key,
    ...overrides.deps,
  });
  return { manager, data, calls, cssVars, attrs, backgroundEl, docEl, setBing: (v) => (bingResponse = v) };
}

describe("theme-manager theme & typography", () => {
  it("applies explicit light/dark themes via data-theme", () => {
    const { manager, attrs } = setup();
    manager.applyTheme("dark");
    assert.equal(attrs["data-theme"], "dark");
    manager.applyTheme("light");
    assert.equal(attrs["data-theme"], "light");
  });

  it("follows prefers-color-scheme in system mode", () => {
    const { manager, attrs } = setup({
      window: {
        matchMedia: () => ({ matches: true, addEventListener: () => {} }),
      },
    });
    manager.applyTheme("system");
    assert.equal(attrs["data-theme"], "dark", "系统深色 → dark");
  });

  it("falls back to the persisted theme when no explicit mode is given", () => {
    const { manager, attrs, data } = setup();
    data.settings.theme = "dark";
    manager.applyTheme();
    assert.equal(attrs["data-theme"], "dark");
  });

  it("writes font and density css variables with a safe fallback", () => {
    const { manager, cssVars, data } = setup();
    manager.applyFontSize(16);
    assert.equal(cssVars["--base-font"], "16px");
    assert.equal(cssVars["--tile-font"], "16px");

    data.settings.gridDensity = "spacious";
    manager.applyDensity();
    assert.equal(cssVars["--grid-gap"], "22px");
    assert.equal(data.settings.lastTileSize, 150, "过小的卡片尺寸兜底到默认值");

    data.settings.gridDensity = "nonsense";
    manager.applyDensity();
    assert.equal(cssVars["--grid-gap"], "16px", "非法密度回退 standard");
  });
});

describe("theme-manager background pipeline", () => {
  it("loads the bing wallpaper with toast, silently for cache hits", async () => {
    const { manager, data, calls, backgroundEl } = setup();
    data.settings.backgroundType = "bing";
    await manager.loadBackground();
    assert.equal(calls.bingCalls.length, 1);
    assert.equal(calls.bingCalls[0], "zh-CN", "按语言取图");
    assert.equal(backgroundEl.style.backgroundImage, 'url("data:image/jpeg;base64,BING")');
    assert.deepEqual(calls.toasts, [{ message: "background.updatedToday", kind: undefined }]);
    assert.ok(!backgroundEl.classes.has("is-loading"), "加载完成退出 loading 态");

    // 缓存命中：静默不提示
    const cached = setup();
    cached.setBing({ dataUrl: "data:image/jpeg;base64,CACHED", fromCache: true });
    cached.data.settings.backgroundType = "bing";
    await cached.manager.loadBackground();
    assert.deepEqual(cached.calls.toasts, [], "缓存命中不提示");
  });

  it("falls back to the solid color when bing fails entirely", async () => {
    const failed = setup();
    failed.setBing({ dataUrl: "", failed: true });
    failed.data.settings.backgroundType = "bing";
    await failed.manager.loadBackground();
    assert.equal(failed.backgroundEl.style.background, "#123456", "失败回退纯色");
    assert.equal(failed.calls.toasts[0].message, "background.failedDefault");
    assert.ok(!failed.backgroundEl.classes.has("is-loading"), "失败也退出 loading 态");
  });

  it("applies gradient and custom backgrounds; unsafe styles are ignored", async () => {
    const { manager, data, backgroundEl } = setup();
    data.settings.backgroundType = "gradient";
    data.settings.backgroundGradient = "linear-gradient(120deg, #aaa, #bbb)";
    await manager.loadBackground({ silent: true });
    assert.equal(backgroundEl.style.backgroundImage, "linear-gradient(120deg, #aaa, #bbb)");

    data.settings.backgroundType = "custom";
    data.settings.backgroundCustom = "data:image/png;base64,XXX";
    await manager.loadBackground({ silent: true });
    assert.equal(backgroundEl.style.backgroundImage, 'url("data:image/png;base64,XXX")');

    // 防注入：任意字符串被忽略，不写入样式
    manager.setBackground("javascript:alert(1)");
    assert.notEqual(backgroundEl.style.backgroundImage, "javascript:alert(1)");
  });

  it("applies the overlay only for image backgrounds", async () => {
    const { manager, data, cssVars } = setup();
    data.settings.backgroundType = "color";
    await manager.loadBackground({ silent: true });
    assert.equal(cssVars["--bg-overlay"], "rgba(0, 0, 0, 0)", "纯色背景无遮罩");

    data.settings.backgroundType = "bing";
    data.settings.backgroundOverlayStrength = 0.3;
    await manager.loadBackground({ silent: true });
    assert.equal(cssVars["--bg-overlay"], "rgba(0, 0, 0, 0.3)");
    // 超过 0.6 封顶
    data.settings.backgroundOverlayStrength = 0.9;
    manager.applyBackgroundOverlay();
    assert.equal(cssVars["--bg-overlay"], "rgba(0, 0, 0, 0.6)");
  });

  it("refreshes only when the background signature changed, merging concurrent loads", async () => {
    const { manager, data, calls } = setup();
    data.settings.backgroundType = "bing";
    await manager.loadBackground({ silent: true });
    assert.equal(calls.bingCalls.length, 1);

    // 签名未变：不重跑
    await manager.refreshBackgroundIfChanged();
    assert.equal(calls.bingCalls.length, 1);

    // 背景类型变化 → 签名变化 → 重跑
    data.settings.backgroundType = "gradient";
    data.settings.backgroundGradient = "linear-gradient(0deg, #000, #111)";
    await manager.refreshBackgroundIfChanged();
    assert.equal(calls.bingCalls.length, 1, "切换到渐变后不再请求 bing");

    // 并发调用合并为一次
    data.settings.backgroundType = "bing";
    await Promise.all([manager.loadBackground({ silent: true }), manager.loadBackground({ silent: true })]);
    assert.equal(calls.bingCalls.length, 2, "两次并发合并后仅新增一次请求");
  });
});

describe("backgroundSignature (pure)", () => {
  it("encodes the fields that decide the rendered background", () => {
    const base = {
      backgroundType: "color",
      backgroundColor: "#111",
      backgroundOverlayStrength: 0.1,
      language: "zh-CN",
    };
    assert.equal(backgroundSignature(base), backgroundSignature({ ...base }));
    assert.notEqual(backgroundSignature(base), backgroundSignature({ ...base, backgroundType: "bing" }));
    assert.notEqual(backgroundSignature(base), backgroundSignature({ ...base, backgroundColor: "#222" }));
    // 自定义图按长度 + 前缀区分
    assert.notEqual(
      backgroundSignature({ ...base, backgroundCustom: "data:image/png;base64,AAAA" }),
      backgroundSignature({ ...base, backgroundCustom: "data:image/png;base64,BBBB" }),
    );
  });
});
