/**
 * Tooltip 悬停提示管理器（从 app.js 拆出，解耦第九阶段）。
 *
 * 职责：悬停提示的防抖出现（默认 200ms）、文本设置、translate3d 定位与
 * 视口防越界钳制、鼠标离开/点击时即时隐藏并清除定时器。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */

var HomepageTooltipManager = (() => {
  /**
   * @param {{
   *   tooltipEl: () => HTMLElement,
   *   delayMs?: number,
   *   isEnabled?: () => boolean,
   *   getViewport?: () => { width: number, height: number },
   *   getTooltipSize?: (el: HTMLElement) => { width: number, height: number },
   * }} deps
   */
  function createTooltipManager(deps) {
    const delayMs = Number(deps?.delayMs) >= 0 ? Number(deps.delayMs) : 200;
    let timer = null;

    const viewport = () =>
      deps?.getViewport?.() || {
        width: (typeof window !== "undefined" && window.innerWidth) || 0,
        height: (typeof window !== "undefined" && window.innerHeight) || 0,
      };
    const size = (el) => deps?.getTooltipSize?.(el) || { width: el.offsetWidth || 0, height: el.offsetHeight || 0 };

    /** 立即显示：文本 + 定位（右下偏移 12px，越界时向内钳制） */
    function showTooltip(text, x, y) {
      if (deps?.isEnabled && !deps.isEnabled()) return;
      const el = deps.tooltipEl();
      if (!el) return;
      el.textContent = text;
      el.style.left = "0";
      el.style.top = "0";
      let nextX = x + 12;
      let nextY = y + 12;
      const view = viewport();
      if (view.width > 0 && view.height > 0) {
        const box = size(el);
        if (nextX + box.width > view.width) nextX = Math.max(0, view.width - box.width - 8);
        if (nextY + box.height > view.height) nextY = Math.max(0, view.height - box.height - 8);
      }
      el.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
      el.classList.remove("hidden");
    }

    /** 即时隐藏并清除待显示的防抖定时器 */
    function hideTooltip() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      deps.tooltipEl()?.classList.add("hidden");
    }

    /** 防抖显示：重复悬停会重置计时（鼠标滑过多卡片不闪烁） */
    function scheduleShow(text, x, y) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        showTooltip(text, x, y);
      }, delayMs);
    }

    return { showTooltip, hideTooltip, scheduleShow };
  }

  return { createTooltipManager };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createTooltipManager = HomepageTooltipManager.createTooltipManager;
