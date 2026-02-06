/**
 * Toast 通知模块
 * @module toast
 */

import { TOAST_DURATION_MS } from "./constants.js";

/** @type {HTMLElement|null} */
let toastContainer = null;

/**
 * 初始化 toast 容器
 * @param {HTMLElement} container
 */
export function initToastContainer(container) {
  toastContainer = container;
}

/**
 * 显示 toast 通知
 * @param {string} message - 消息内容
 * @param {string} [actionLabel] - 操作按钮文本
 * @param {Function} [action] - 操作按钮回调
 */
export function toast(message, actionLabel, action) {
  if (!toastContainer) {
    console.warn("Toast container not initialized");
    return;
  }
  const el = document.createElement("div");
  el.className = "toast";
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (actionLabel && action) {
    const btn = document.createElement("button");
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => {
      action();
      el.remove();
    });
    el.appendChild(btn);
  }
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), TOAST_DURATION_MS);
}
