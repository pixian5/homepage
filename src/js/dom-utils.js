/**
 * DOM 工具函数
 * @module dom-utils
 */

/**
 * 通过 ID 获取元素
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export const $ = (id) => document.getElementById(id);

/**
 * 查询单个元素
 * @param {string} sel
 * @param {Element} root
 * @returns {Element|null}
 */
export const qs = (sel, root = document) => root.querySelector(sel);

/**
 * 查询所有元素
 * @param {string} sel
 * @param {Element} root
 * @returns {Element[]}
 */
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 安全地设置元素的文本内容，防止 XSS
 * @param {HTMLElement} el
 * @param {string} text
 */
export function safeSetText(el, text) {
  el.textContent = text;
}

/**
 * 安全地设置元素属性，防止 XSS
 * @param {HTMLElement} el
 * @param {string} attr
 * @param {string} value
 */
export function safeSetAttr(el, attr, value) {
  el.setAttribute(attr, value);
}

/**
 * 创建带标签和输入框的表单项
 * @param {string} labelText
 * @param {HTMLElement} inputEl
 * @returns {HTMLElement}
 */
export function createFormSection(labelText, inputEl) {
  const section = document.createElement("div");
  section.className = "section";
  const label = document.createElement("label");
  label.textContent = labelText;
  section.appendChild(label);
  section.appendChild(inputEl);
  return section;
}

/**
 * 规范化 URL
 * @param {string} input
 * @returns {string}
 */
export function normalizeUrl(input) {
  if (!input) return "";
  try {
    const url = new URL(input);
    return url.href;
  } catch (err) {
    const withScheme = `https://${input}`;
    try {
      const url = new URL(withScheme);
      return url.href;
    } catch (err2) {
      return "";
    }
  }
}

/**
 * 规范化 URL 并指定协议
 * @param {string} input
 * @param {string} scheme
 * @returns {string}
 */
export function normalizeUrlWithScheme(input, scheme) {
  if (!input) return "";
  const raw = input.trim();
  if (!raw) return "";
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const candidate = hasScheme ? raw : `${scheme}://${raw.replace(/^\/+/, "")}`;
  try {
    const url = new URL(candidate);
    return url.href;
  } catch (e) {
    return "";
  }
}
