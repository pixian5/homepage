function renderFatalError(message, details) {
  const existing = document.getElementById("fatalError");
  if (existing) existing.remove();
  const panel = document.createElement("div");
  panel.id = "fatalError";
  panel.style.cssText = [
    "position:fixed",
    "left:24px",
    "right:24px",
    "top:24px",
    "z-index:9999",
    "padding:16px 18px",
    "border-radius:14px",
    "background:rgba(120,20,20,.92)",
    "color:#fff",
    "font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "box-shadow:0 12px 40px rgba(0,0,0,.28)",
    "white-space:pre-wrap",
  ].join(";");
  panel.textContent = details ? `${message}\n${details}` : message;
  document.body.appendChild(panel);
}

window.__homepageRenderFatalError = renderFatalError;

window.addEventListener("error", (event) => {
  renderFatalError("我的首页加载失败", event?.error?.stack || event?.message || "未知错误");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event?.reason;
  renderFatalError(
    "我的首页初始化失败",
    reason?.stack || reason?.message || String(reason || "未知错误")
  );
});
