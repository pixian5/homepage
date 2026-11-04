/**
 * 国际化与多语言管理器（从 app.js 拆出，解耦第十三阶段）。
 *
 * 职责：语言规范化与首选项回退、多语言字典翻译（含变量插值）、
 * 语言下拉选项渲染、全页面静态文案（按钮/占位符/tooltip/空态）注入。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import { APP_SUPPORTED_LANGUAGES, translateAppText } from "./app-i18n.js";
import { detectPreferredLanguage, normalizeLanguage } from "./shared-utils.js";
import { html } from "./ui-utils.js";

var HomepageI18nManager = (() => {
  /**
   * @param {{
   *   getData: () => object,
   *   getElements: () => object,
   *   getActiveGroupId: () => string,
   *   isRecentGroup: (groupId: string) => boolean,
   *   doc?: Document,
   * }} options
   */
  function createI18nManager(options) {
    const getData = options.getData;
    const getElements = options.getElements;
    const getActiveGroupId = options.getActiveGroupId;
    const isRecentGroup = options.isRecentGroup;
    const doc = options.doc || (typeof document !== "undefined" ? document : null);

    /** 综合持久化设置与浏览器语言检测，返回受支持的标准语言代码 */
    function currentLang() {
      const stored = normalizeLanguage(getData()?.settings?.language || "");
      if (stored) return stored;
      return detectPreferredLanguage();
    }

    /** 多语言文案翻译（vars 为 {name: value} 插值字典） */
    function t(key, vars = null) {
      return translateAppText(currentLang(), key, vars);
    }

    /**
     * 确保数据中的 language 字段存在且规范化：
     * 已有合法值 → 规范化写回并返回 false；缺失/非法 → 写入浏览器首选语言并返回 true。
     */
    function ensureLanguageSetting() {
      const settings = getData()?.settings;
      if (!settings) return false;
      const normalized = normalizeLanguage(settings.language || "");
      if (normalized) {
        settings.language = normalized;
        return false;
      }
      settings.language = detectPreferredLanguage();
      return true;
    }

    /** 语言下拉选项（selected 标记命中当前语言） */
    function buildLanguageOptions(selectedLanguage) {
      const normalized = normalizeLanguage(selectedLanguage || "") || currentLang();
      return APP_SUPPORTED_LANGUAGES.map(
        (item) =>
          html`<option value="${item.code}" ${item.code === normalized ? "selected" : ""}>${item.label}</option>`,
      ).join("");
    }

    /**
     * 全页面静态文案注入：document lang/title、搜索框占位符、工具栏按钮文本与
     * tooltip、侧边栏标签、文件夹工具条；空态文案在普通分组下更新，
     * 历史分组的空态由 updateEmptyState 负责（此处防覆盖）。
     */
    function applyStaticI18n() {
      const lang = currentLang();
      if (!doc) return;
      doc.documentElement.lang = lang;
      doc.title = t("app.title");
      const elements = getElements();
      if (elements.topSearch) elements.topSearch.placeholder = t("search.placeholder");
      if (elements.btnSearch) {
        elements.btnSearch.textContent = t("search.button");
        elements.btnSearch.setAttribute("data-tooltip", t("search.button"));
      }
      if (elements.btnAdd) {
        elements.btnAdd.textContent = t("toolbar.add");
        elements.btnAdd.setAttribute("data-tooltip", t("toolbar.add"));
      }
      if (elements.btnBatchDelete) elements.btnBatchDelete.setAttribute("data-tooltip", t("toolbar.batchDelete"));
      if (elements.btnSelectAll) {
        elements.btnSelectAll.textContent = t("toolbar.selectAll");
        elements.btnSelectAll.setAttribute("data-tooltip", t("toolbar.selectAll"));
      }
      if (elements.btnOpenMode) elements.btnOpenMode.setAttribute("data-tooltip", t("toolbar.openMode"));
      if (elements.btnSettings) {
        elements.btnSettings.textContent = t("toolbar.settings");
        elements.btnSettings.setAttribute("data-tooltip", t("toolbar.settings"));
      }
      if (elements.recentTab) elements.recentTab.dataset.label = t("sidebar.history");
      if (elements.btnAddGroup) {
        elements.btnAddGroup.textContent = t("sidebar.addGroup");
        elements.btnAddGroup.setAttribute("data-tooltip", t("sidebar.addGroup"));
      }
      if (elements.btnCloseFolder) elements.btnCloseFolder.textContent = t("folder.back");
      if (elements.btnFolderAdd) elements.btnFolderAdd.textContent = t("folder.add");
      if (elements.btnFolderBatchDelete) elements.btnFolderBatchDelete.textContent = t("folder.batchDelete");
      if (elements.btnFolderDissolve) elements.btnFolderDissolve.textContent = t("folder.dissolve");
      const emptyTitle = elements.emptyState?.querySelector?.(".empty-title") || null;
      const emptyDesc = elements.emptyState?.querySelector?.(".empty-desc") || null;
      // 历史分组的空态文案由 updateEmptyState 负责，避免这里盖掉
      if (!isRecentGroup(getActiveGroupId())) {
        if (emptyTitle) emptyTitle.textContent = t("empty.title");
        if (emptyDesc) emptyDesc.textContent = t("empty.desc");
      }
      const emptyCheckLabel = elements.emptyState?.querySelector?.(".empty-check") || null;
      if (emptyCheckLabel) {
        const textNode = Array.from(emptyCheckLabel.childNodes).find(
          (node) => node.nodeType === 3 /* Node.TEXT_NODE */,
        );
        if (textNode) textNode.nodeValue = ` ${t("empty.hideHint")}`;
      }
    }

    return { currentLang, t, ensureLanguageSetting, buildLanguageOptions, applyStaticI18n };
  }

  return { createI18nManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createI18nManager = HomepageI18nManager.createI18nManager;
