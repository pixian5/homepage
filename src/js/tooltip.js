/**
 * Tooltip 提示模块
 * @module tooltip
 */

import { TOOLTIP_DELAY_MS } from "./constants.js";

/** @type {HTMLElement|null} */
let tooltipEl = null;

/** @type {number|null} */
let tooltipTimer = null;

/** @type {boolean} */
let tooltipEnabled = true;

/**
 * 初始化 tooltip 元素
 * @param {HTMLElement} element
 */
export function initTooltip(element) {
  tooltipEl = element;
}

/**
 * 设置 tooltip 是否启用
 * @param {boolean} enabled
 */
export function setTooltipEnabled(enabled) {
  tooltipEnabled = enabled;
}

/**
 * 显示 tooltip
 * @param {string} text
 * @param {number} x
 * @param {number} y
 */
export function showTooltip(text, x, y) {
  if (!tooltipEnabled || !tooltipEl) return;
  tooltipEl.textContent = text;
  tooltipEl.style.left = `${x + 12}px`;
  tooltipEl.style.top = `${y + 12}px`;
  tooltipEl.classList.remove("hidden");
}

/**
 * 隐藏 tooltip
 */
export function hideTooltip() {
  if (!tooltipEl) return;
  tooltipEl.classList.add("hidden");
}

/**
 * 延迟显示 tooltip
 * @param {string} text
 * @param {number} x
 * @param {number} y
 */
export function scheduleTooltip(text, x, y) {
  clearTooltipTimer();
  tooltipTimer = setTimeout(() => showTooltip(text, x, y), TOOLTIP_DELAY_MS);
}

/**
 * 清除 tooltip 定时器
 */
export function clearTooltipTimer() {
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
  }
}

/**
 * 更新 tooltip 位置
 * @param {number} x
 * @param {number} y
 */
export function updateTooltipPosition(x, y) {
  if (!tooltipEl || tooltipEl.classList.contains("hidden")) return;
  tooltipEl.style.left = `${x + 12}px`;
  tooltipEl.style.top = `${y + 12}px`;
}
