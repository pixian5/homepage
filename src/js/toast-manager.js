/**
 * 全局 Toast 提示体系（从 app.js 拆出，解耦第八阶段）。
 *
 * 职责：多类型提示（success / error / warning）、带动作按钮（点击执行并清除）、
 * ARIA 动态属性（role=status、aria-live 按 error 级别切换）、自动定时消失。
 * toast() 签名与既有用法 100% 向前兼容。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

var HomepageToastManager = (() => {
  const VALID_KINDS = new Set(["success", "error", "warning"]);

  /**
   * @param {{
   *   containerEl: () => HTMLElement|null,
   *   getDurationMs?: () => number,
   *   durationMs?: number,
   * }} deps
   *   getDurationMs 优先（可动态读设置）；否则用固定 durationMs；默认 5000ms。
   */
  function createToastManager(deps) {
    const containerEl = deps?.containerEl || (() => null);
    const resolveDuration = () => {
      if (typeof deps?.getDurationMs === "function") {
        const dynamic = Number(deps.getDurationMs());
        if (Number.isFinite(dynamic) && dynamic > 0) return dynamic;
      }
      const fixed = Number(deps?.durationMs);
      return Number.isFinite(fixed) && fixed > 0 ? fixed : 5000;
    };

    /**
     * 显示 Toast（兼容三种调用形态）：
     * - toast(msg) / toast(msg, "success"|"error"|"warning")
     * - toast(msg, actionLabel, actionFn)
     * - toast(msg, actionLabel, actionFn, "warning")
     * @param {string} message
     * @param {string | (() => void)} [actionLabelOrType]
     * @param {(() => void) | string} [actionOrType]
     * @param {"success"|"error"|"warning"} [type]
     */
    function toast(message, actionLabelOrType, actionOrType, type) {
      const container = containerEl();
      if (!container) return;
      let actionLabel = null;
      let action = null;
      let kind = "success";

      if (typeof actionLabelOrType === "function") {
        action = actionLabelOrType;
      } else if (VALID_KINDS.has(actionLabelOrType)) {
        kind = actionLabelOrType;
      } else if (typeof actionLabelOrType === "string") {
        actionLabel = actionLabelOrType;
      }

      if (typeof actionOrType === "function") {
        action = actionOrType;
      } else if (VALID_KINDS.has(actionOrType)) {
        kind = actionOrType;
      }

      if (VALID_KINDS.has(type)) {
        kind = type;
      }

      const el = document.createElement("div");
      el.className = `toast toast-${kind}`;
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
      const span = document.createElement("span");
      span.textContent = message;
      el.appendChild(span);
      if (actionLabel && action) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = actionLabel;
        btn.addEventListener("click", () => {
          action();
          el.remove();
        });
        el.appendChild(btn);
      }
      // 多条并存：新 toast 追加在容器尾部，CSS 过渡负责进出动画
      container.appendChild(el);
      setTimeout(() => el.remove(), resolveDuration());
    }

    return { toast, resolveDuration };
  }

  return { createToastManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createToastManager = HomepageToastManager.createToastManager;
