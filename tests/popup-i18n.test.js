import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_SUPPORTED_LANGUAGES, translateAppText } from "../src/js/app-i18n.js";
import { POPUP_SUPPORTED_LANGUAGES, translatePopupText } from "../src/js/popup-i18n.js";

describe("popup-i18n 8-language coverage", () => {
  it("supports the exact same 8 languages as the main app", () => {
    assert.deepEqual(
      POPUP_SUPPORTED_LANGUAGES,
      APP_SUPPORTED_LANGUAGES.map((entry) => entry.code),
    );
  });

  it("provides localized strings without Chinese leakage for all non-zh languages", () => {
    const keys = [
      "title",
      "save",
      "saveToGroup",
      "allBookmarks",
      "allFolders",
      "close",
      "noBookmarks",
      "noFolders",
      "saving",
      "noTab",
      "titlePlaceholder",
      "unnamed",
      "loadFailed",
      "invalidUrl",
      "saveFailed",
      "openFailed",
      "noData",
      "saveAllTabs",
      "noValidTabs",
      "saveAllFailed",
      "openLeftSidebar",
      "openRightSidebar",
      "openLeftSidebarFail",
      "openRightSidebarFail",
      "expandFolder",
      "collapseFolder",
      "menuAriaLabel",
    ];
    for (const lang of ["en", "ja", "ko", "de", "fr", "es"]) {
      for (const key of keys) {
        const value = translatePopupText(lang, key);
        const zhValue = translatePopupText("zh-CN", key);
        assert.notEqual(value, key, `${lang}.${key} 缺失翻译`);
        assert.notEqual(value, zhValue, `${lang}.${key} 不应回退为简体中文`);
        if (lang !== "ja") {
          assert.equal(/[\u4e00-\u9fff]/.test(value), false, `${lang}.${key} 不应含汉字: ${value}`);
        }
      }
      const grouped = translatePopupText(lang, "savedToGroup", { name: "Work" });
      assert.ok(grouped.includes("Work"), `${lang}.savedToGroup 未完成变量插值`);
      const batch = translatePopupText(lang, "savedAllToGroup", { count: 4, name: "Work" });
      assert.ok(batch.includes("4") && batch.includes("Work"), `${lang}.savedAllToGroup 未完成变量插值`);
    }
  });

  it("normalizes regional locale tags and handles zh-TW", () => {
    assert.equal(translatePopupText("en-US", "openLeftSidebar"), "Show bookmarks on left");
    assert.equal(translatePopupText("zh-Hant-HK", "save"), "新增書籤");
    assert.equal(translatePopupText("fr-FR", "close"), "Fermer");
  });
});

describe("app-i18n import/export/backup/clear keys across 8 languages", () => {
  it("provides localized import-export, backup, and clear error translations in all 8 languages", () => {
    const keys = [
      "common.close",
      "common.copy",
      "common.delete",
      "settings.export.title",
      "settings.export.clipboardOk",
      "settings.import.title",
      "settings.import.strategy",
      "settings.import.modeReplace",
      "settings.import.modeMerge",
      "settings.import.modeAdd",
      "settings.import.ok",
      "settings.importUrl.title",
      "settings.importUrl.http",
      "settings.importUrl.https",
      "settings.backup.title",
      "settings.backup.restore",
      "settings.backup.empty",
      "settings.backup.restoreOk",
      "settings.backup.deleteOk",
    ];
    for (const lang of APP_SUPPORTED_LANGUAGES.map((entry) => entry.code)) {
      for (const key of keys) {
        const text = translateAppText(lang, key);
        assert.notEqual(text, key, `${lang}.${key} 缺失`);
        if (!lang.startsWith("zh")) {
          assert.notEqual(text, translateAppText("zh-CN", key), `${lang}.${key} 不应回退为简体中文`);
          if (lang !== "ja") {
            assert.equal(/[\u4e00-\u9fff]/.test(text), false, `${lang}.${key} 不应含汉字: ${text}`);
          }
        }
      }
      assert.ok(translateAppText(lang, "settings.clearDataFail", { reason: "io" }).includes("io"));
      assert.ok(translateAppText(lang, "settings.clearCardsFail", { reason: "io" }).includes("io"));
    }
  });
});
