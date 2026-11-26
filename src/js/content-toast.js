(() => {
  if (window.__homepageToastInjected) return;
  window.__homepageToastInjected = true;

  const TOAST_ID = "homepage-save-toast";
  const FONT_STACK = '"Avenir Next", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
  const TOAST_STYLE_PROPS = {
    position: "fixed",
    top: "20px",
    right: "20px",
    zIndex: "2147483647",
    background: "rgba(22, 128, 72, 0.92)",
    color: "#ffffff",
    padding: "10px 14px",
    borderRadius: "10px",
    lineHeight: "1.2",
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
    backdropFilter: "blur(6px)",
    fontFamily: FONT_STACK,
  };

  function showToast(message, fontSize) {
    if (!document.body) return false;
    const existing = document.getElementById(TOAST_ID);
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = TOAST_ID;
    el.textContent = message;
    Object.assign(el.style, TOAST_STYLE_PROPS, { fontSize: `${Number(fontSize) || 14}px` });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
    return true;
  }

  function getRuntime() {
    if (typeof chrome !== "undefined") return chrome;
    if (typeof browser !== "undefined") return browser;
    return null;
  }

  const api = getRuntime();
  api?.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type === "homepage_show_toast" && message?.text) {
      const ok = showToast(message.text, message.fontSize);
      sendResponse?.({ ok });
      return true;
    }
    return false;
  });
})();
