/**
 * 卡片打开方式编排（从 app.js 拆出，解耦第七阶段）。
 *
 * 职责：卡片点击导航（本页 / 前台新标签 / 后台新标签）、修饰键与中键的智能判定、
 * 工具栏打开模式循环切换与按钮文案更新。扩展环境走 tabs API，
 * 纯 Web / PWA 模式回退 window.open / location。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

import { getChromeApi } from "./shared-utils.js";

var HomepageOpenModeManager = (() => {
  const MODE_ORDER = ["current", "new", "background"];

  /**
   * @param {{
   *   getData: () => object,
   *   persist: () => Promise<{ok?: boolean}|void>,
   *   recordVisit?: (visit: {url: string, title?: string}) => Promise<void>,
   *   toast: (message: string, kind?: string) => void,
   *   t: (key: string, vars?: object) => string,
   *   getButton: () => HTMLElement|null,
   * }} deps
   */
  function createOpenModeManager(deps) {
    const labelOf = (mode) => {
      const map = {
        current: deps.t("openMode.current"),
        new: deps.t("openMode.new"),
        background: deps.t("openMode.background"),
      };
      return map[mode] || map.current;
    };

    /**
     * 本次点击的实际打开方式：
     * - 中键（button === 1）→ 后台新标签；
     * - Ctrl / Cmd + 点击 → 前台新标签；
     * - Shift + 点击 → 前台新标签；
     * - 其余 → 持久化设置 data.settings.openMode。
     * @param {MouseEvent|KeyboardEvent|null} [event]
     * @returns {"current"|"new"|"background"}
     */
    function getEffectiveOpenMode(event) {
      if (event) {
        if (event.button === 1) return "background";
        if (event.metaKey || event.ctrlKey) return "new";
        if (event.shiftKey) return "new";
      }
      const saved = deps.getData()?.settings?.openMode;
      return MODE_ORDER.includes(saved) ? saved : "current";
    }

    /**
     * 按指定方式打开 URL：
     * - 扩展环境（chrome.tabs 可用）且新标签类 → tabs.create（background 不激活）；
     * - 纯 Web / PWA：new/background → window.open，current → location 跳转。
     * @param {string} url
     * @param {"current"|"new"|"background"} [mode]
     */
    function openUrlWithMode(url, mode) {
      if (!url) return;
      const api = getChromeApi();
      const openMode = mode || getEffectiveOpenMode(null);
      // 用户从本扩展打开的链接也记入「最近访问」（Safari 无系统历史时的数据来源）
      try {
        deps.recordVisit?.({ url, title: "" })?.catch?.((e) => console.warn("recordVisit failed", e));
      } catch (_e) {
        // 记录失败不影响打开
      }
      if (api?.tabs && (openMode === "new" || openMode === "background")) {
        api.tabs.create({ url, active: openMode !== "background" });
        return;
      }
      if (openMode === "new" || openMode === "background") {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        window.location.href = url;
      }
    }

    /** 卡片点击入口：结合事件修饰键判定后打开 */
    function openCard(url, event) {
      openUrlWithMode(url, getEffectiveOpenMode(event));
    }

    /**
     * 循环切换工具栏打开模式（current → new → background → current），
     * 先落盘再确认，失败回滚上一个模式。
     */
    async function cycleOpenMode() {
      const settings = deps.getData()?.settings;
      if (!settings) return;
      const idx = MODE_ORDER.indexOf(settings.openMode);
      const nextId = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
      const prevMode = settings.openMode;
      settings.openMode = nextId;
      updateToolbarButton();
      deps.toast(labelOf(nextId));
      const result = await deps.persist();
      if (result && result.ok === false) {
        settings.openMode = prevMode;
        updateToolbarButton();
        deps.toast(deps.t("openMode.saveFailed"), "error");
      }
    }

    /** 工具栏按钮：文案随当前模式更新 */
    function updateToolbarButton() {
      const btn = deps.getButton();
      if (!btn) return;
      btn.textContent = labelOf(deps.getData()?.settings?.openMode);
    }

    /** 绑定工具栏按钮（点击循环切换） */
    function bindButton() {
      deps.getButton()?.addEventListener("click", () => void cycleOpenMode());
    }

    return {
      getEffectiveOpenMode,
      openUrlWithMode,
      openCard,
      cycleOpenMode,
      updateToolbarButton,
      bindButton,
    };
  }

  return { createOpenModeManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createOpenModeManager = HomepageOpenModeManager.createOpenModeManager;
