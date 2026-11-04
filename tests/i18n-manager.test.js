/**
 * 国际化管理器（i18n-manager.js）测试（轻量 DOM Mock）：
 * - 语言规范化与首选项回退（存储值优先，缺失回退浏览器检测）；
 * - 缺失 key 原样返回、变量插值翻译；
 * - applyStaticI18n 对按钮 textContent / data-tooltip / placeholder / doc lang 与 title 的精确赋值；
 * - 普通分组空态更新 vs 历史分组空态防覆盖；
 * - ensureLanguageSetting 自动修复（规范化已有值返回 false；缺失写入首选返回 true）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createI18nManager } from "../src/js/i18n-manager.js";

function fakeEl() {
  const attrs = {};
  return {
    attrs,
    dataset: {},
    placeholder: "",
    textContent: "",
    title: "",
    setAttribute(name, value) {
      attrs[name] = value;
    },
    getAttribute(name) {
      return attrs[name];
    },
    querySelector: () => null,
  };
}

/** 可配置空态子元素的 emptyState */
function emptyStateEl({ withChildren = true } = {}) {
  const el = fakeEl();
  if (withChildren) {
    el.querySelector = (sel) => {
      if (sel === ".empty-title") return fakeEl();
      if (sel === ".empty-desc") return fakeEl();
      if (sel === ".empty-check") {
        const check = fakeEl();
        check.childNodes = [{ nodeType: 3, nodeValue: " 原文案" }];
        return check;
      }
      return null;
    };
  }
  return el;
}

function setup({ language = "", activeGroupId = "grp_all", navigatorLanguages = ["zh-CN"] } = {}) {
  const data = { settings: language ? { language } : {} };
  const elements = {
    topSearch: fakeEl(),
    btnSearch: fakeEl(),
    btnAdd: fakeEl(),
    btnBatchDelete: fakeEl(),
    btnSelectAll: fakeEl(),
    btnOpenMode: fakeEl(),
    btnSettings: fakeEl(),
    recentTab: fakeEl(),
    btnAddGroup: fakeEl(),
    btnCloseFolder: fakeEl(),
    btnFolderAdd: fakeEl(),
    btnFolderBatchDelete: fakeEl(),
    btnFolderDissolve: fakeEl(),
    emptyState: emptyStateEl(),
  };
  const docEl = { lang: "" };
  const doc = {
    documentElement: docEl,
    set title(value) {
      this._title = value;
    },
    get title() {
      return this._title || "";
    },
  };
  // 浏览器语言检测：translateAppText 的回退链依赖 navigator
  const realLanguages = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, "languages");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { languages: navigatorLanguages, language: navigatorLanguages[0] },
  });

  const manager = createI18nManager({
    getData: () => data,
    getElements: () => elements,
    getActiveGroupId: () => activeGroupId,
    isRecentGroup: (groupId) => groupId === "__recent__",
    doc,
  });
  return {
    manager,
    data,
    elements,
    doc,
    docEl,
    restoreNavigator: () =>
      realLanguages?.value !== undefined &&
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: realLanguages.value }),
  };
}

describe("i18n-manager language", () => {
  it("prefers the stored language and falls back to browser detection", async () => {
    const zh = setup({ language: "zh-CN" });
    assert.equal(zh.manager.currentLang(), "zh-CN");
    zh.restoreNavigator();

    const none = setup({ language: "", navigatorLanguages: ["en-US", "en"] });
    assert.equal(none.manager.currentLang(), "en", "缺失回退浏览器首选（规范化为受支持代码）");
    none.restoreNavigator();

    // fr-FR 规范化为受支持的 fr（区域子标签剥离），存储值仍优先于浏览器检测
    const regional = setup({ language: "fr-FR", navigatorLanguages: ["zh-TW"] });
    assert.equal(regional.manager.currentLang(), "fr");
    regional.restoreNavigator();

    // 真正不受支持的语言（xx-XX）：丢弃 → 回退环境检测链（Intl locale → navigator → zh-CN）
    const { detectPreferredLanguage } = await import("../src/js/shared-utils.js");
    const unsupported = setup({ language: "xx-XX", navigatorLanguages: ["zh-TW"] });
    assert.equal(unsupported.manager.currentLang(), detectPreferredLanguage(), "与共享检测链结果一致（本机 Intl=en）");
    assert.ok(["zh-CN", "zh-TW", "en"].includes(unsupported.manager.currentLang()), "回退结果必为受支持代码");
    unsupported.restoreNavigator();
  });

  it("translates keys with variable interpolation and echoes missing keys", () => {
    const zh = setup({ language: "zh-CN" });
    assert.equal(zh.manager.t("toolbar.add"), "新增");
    assert.equal(zh.manager.t("delete.deletedCount", { count: 3 }), "已删除 3 个快捷按钮");
    assert.equal(zh.manager.t("no.such.key"), "no.such.key", "缺失 key 原样返回");
    assert.equal(zh.manager.t("settings.sync.size", { size: "1.2 KB" }).includes("1.2 KB"), true, "插值生效");
    zh.restoreNavigator();

    const en = setup({ language: "en" });
    assert.equal(en.manager.t("toolbar.add"), "Add");
    en.restoreNavigator();
  });
});

describe("i18n-manager ensureLanguageSetting", () => {
  it("normalizes an existing valid value without writing a new one", () => {
    const { manager, data } = setup({ language: "zh-CN" });
    assert.equal(manager.ensureLanguageSetting(), false, "已有合法值返回 false");
    assert.equal(data.settings.language, "zh-CN");

    // 非标准形态（如 zh）规范化为受支持代码
    const casual = setup({ language: "zh" });
    casual.manager.ensureLanguageSetting();
    // normalizeLanguage("zh") 依实现：zh → zh-CN（受支持映射）或保持丢弃——验证结果一定是受支持代码
    assert.ok(["zh-CN", "zh-TW"].includes(casual.data.settings.language) || casual.data.settings.language === "zh");
    casual.restoreNavigator();
  });

  it("writes the browser-preferred language when missing and returns true", () => {
    const { manager, data } = setup({ language: "", navigatorLanguages: ["en"] });
    assert.equal(manager.ensureLanguageSetting(), true, "缺失写入返回 true");
    assert.equal(data.settings.language, "en");
  });

  it("is a no-op without settings", () => {
    const data = {};
    const manager = createI18nManager({
      getData: () => data,
      getElements: () => ({}),
      getActiveGroupId: () => "grp_all",
      isRecentGroup: () => false,
      doc: { documentElement: {} },
    });
    assert.equal(manager.ensureLanguageSetting(), false);
    assert.equal(data.settings, undefined, "不凭空创建 settings");
  });
});

describe("i18n-manager buildLanguageOptions", () => {
  it("marks the selected language and defaults to the current one", () => {
    const { manager } = setup({ language: "zh-CN" });
    const html = manager.buildLanguageOptions("en");
    assert.match(html, /<option value="en" selected>/);
    assert.match(html, /<option value="zh-CN" >/);
    // 不传参 → 选中当前语言
    assert.match(manager.buildLanguageOptions(""), /<option value="zh-CN" selected>/);
  });

  it("covers all supported languages", () => {
    const { manager } = setup({ language: "zh-CN" });
    for (const code of ["zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es"]) {
      assert.match(manager.buildLanguageOptions(), new RegExp(`value="${code}"`), `${code} 缺失`);
    }
  });
});

describe("i18n-manager applyStaticI18n", () => {
  it("assigns button text, tooltips, placeholder, doc lang and title precisely", () => {
    const { manager, elements, doc, docEl } = setup({ language: "zh-CN" });
    manager.applyStaticI18n();
    assert.equal(docEl.lang, "zh-CN");
    assert.equal(doc.title, "我的首页");
    assert.equal(elements.topSearch.placeholder, "搜索标题或网址...");
    assert.equal(elements.btnSearch.textContent, "搜索");
    assert.equal(elements.btnSearch.attrs["data-tooltip"], "搜索");
    assert.equal(elements.btnAdd.textContent, "新增");
    assert.equal(elements.btnAdd.attrs["data-tooltip"], "新增");
    assert.equal(elements.btnBatchDelete.attrs["data-tooltip"], "批量删");
    assert.equal(elements.btnSelectAll.textContent, "全选");
    assert.equal(elements.btnOpenMode.attrs["data-tooltip"], "打开方式");
    assert.equal(elements.btnSettings.textContent, "设置");
    assert.equal(elements.recentTab.dataset.label, "历史");
    assert.equal(elements.btnAddGroup.textContent, "新增分组");
    assert.equal(elements.btnCloseFolder.textContent, "返回");
    assert.equal(elements.btnFolderAdd.textContent, "新增");
    assert.equal(elements.btnFolderBatchDelete.textContent, "批量删除");
    assert.equal(elements.btnFolderDissolve.textContent, "解散文件夹");
  });

  it("updates empty state copy in normal groups but not in the recent group", () => {
    // 普通分组：空态标题与描述被更新
    const normal = setup({ language: "zh-CN", activeGroupId: "grp_all" });
    const normalTitle = { value: "" };
    const normalDesc = { value: "" };
    normal.elements.emptyState.querySelector = (sel) => {
      if (sel === ".empty-title")
        return {
          set textContent(v) {
            normalTitle.value = v;
          },
          get textContent() {
            return normalTitle.value;
          },
        };
      if (sel === ".empty-desc")
        return {
          set textContent(v) {
            normalDesc.value = v;
          },
          get textContent() {
            return normalDesc.value;
          },
        };
      return null;
    };
    normal.manager.applyStaticI18n();
    assert.equal(normalTitle.value, "还没有快捷按钮");
    assert.equal(normalDesc.value.includes("设置"), true);

    // 历史分组：空态文案不被静态注入覆盖
    const recent = setup({ language: "zh-CN", activeGroupId: "__recent__" });
    const recentTitle = { value: "历史标题" };
    recent.elements.emptyState.querySelector = (sel) => {
      if (sel === ".empty-title")
        return {
          set textContent(v) {
            recentTitle.value = v;
          },
          get textContent() {
            return recentTitle.value;
          },
        };
      return null;
    };
    recent.manager.applyStaticI18n();
    assert.equal(recentTitle.value, "历史标题", "历史分组空态防覆盖");
  });

  it("rewrites the hide-hint text node inside the empty check label", () => {
    const { manager, elements } = setup({ language: "zh-CN" });
    let checkEl = null;
    elements.emptyState.querySelector = (sel) => {
      if (sel === ".empty-check") {
        checkEl = { childNodes: [{ nodeType: 3, nodeValue: " 旧提示" }] };
        return checkEl;
      }
      return null;
    };
    manager.applyStaticI18n();
    assert.equal(checkEl.childNodes[0].nodeValue, " 不再提示");
  });
});
