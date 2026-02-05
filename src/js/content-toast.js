const TOAST_ID = "homepage-save-toast";

function showToast(message) {
  const existing = document.getElementById(TOAST_ID);
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.textContent = message;
  Object.assign(el.style, {
    position: "fixed",
    top: "20px",
    right: "20px",
    zIndex: "2147483647",
    background: "rgba(15, 20, 28, 0.88)",
    color: "#ffffff",
    padding: "10px 14px",
    borderRadius: "10px",
    fontSize: "14px",
    lineHeight: "1.2",
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
    backdropFilter: "blur(6px)",
    fontFamily: "-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif",
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function getRuntime() {
  if (typeof chrome !== "undefined") return chrome;
  if (typeof browser !== "undefined") return browser;
  return null;
}

const api = getRuntime();
api?.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
  if (message?.type === "homepage_show_toast" && message?.text) {
    showToast(message.text);
    sendResponse?.({ ok: true });
    return true;
  }
  return false;
});
