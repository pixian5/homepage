export const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * 标记一段已经安全的 HTML 字符串，避免被 html 模板标签二次转义。
 * 仅用于由 html 模板标签自身生成的片段，禁止包裹用户输入。
 */
export const rawHtml = (value) => ({ __rawHtml: true, value: String(value) });

/**
 * 安全的 HTML 模板标签：自动转义所有插值，避免 XSS。
 * 静态模板中的 HTML 标记保留；只有 ${...} 中的值会被转义。
 * 若插值为 rawHtml() 返回的对象，则直接拼接其 value，用于组合嵌套模板。
 */
export const html = (strings, ...values) => {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      const value = values[i];
      if (value && typeof value === "object" && value.__rawHtml) {
        result += value.value;
      } else {
        result += escapeHtml(value);
      }
    }
  }
  return result;
};

/** 执行异步按钮操作时统一显示进行中文案，并在结束后恢复。 */
export async function runWithButtonState(button, busyLabel, operation) {
  if (!button || button.disabled) return undefined;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = busyLabel;
  try {
    return await operation();
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = originalLabel;
    }
  }
}
