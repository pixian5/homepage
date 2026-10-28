/**
 * 同步异常提示条
 * @module sync-banner
 *
 * 目的：同步失败时让用户在新标签页直接看到，而不是只写进存储。
 * 之前的真实故障是「生产同步断了两个月无人察觉」，根因之一就是失败完全不可见。
 *
 * 触发条件（满足任一）：
 *  1. 同步状态为 error，且该状态已持续超过 SYNC_BANNER_ERROR_GRACE_MS（避免瞬时抖动就弹）；
 *  2. outbox 有待发送项且 attempts 已达上限（outbox_exhausted，自动重试已放弃）。
 *
 * 交互：
 *  - 「立即重试」调用手动同步（pushNow 不受 attempts 上限限制，可自救）；
 *  - 「查看设置」打开设置面板并滚到同步区；
 *  - 关闭后记录 dismissedAt，24 小时内不再弹（但 outbox 耗尽这类硬故障仍会再次提示）。
 */

const DISMISS_KEY = "homepage_sync_banner_dismissed";
/** error 状态持续多久才提示（避免一次网络抖动就弹窗） */
export const SYNC_BANNER_ERROR_GRACE_MS = 10 * 60 * 1000;
/** 关闭后静默时长（软故障：网络抖动等） */
export const SYNC_BANNER_DISMISS_MS = 24 * 60 * 60 * 1000;
/**
 * 硬故障（outbox 自动重试已放弃）的静默时长：比软故障短得多。
 * 完全不理会关闭会导致每次刷新都弹、用户只能无视它；
 * 静默过久又会重新回到「断链无人察觉」。折中为 2 小时提醒一次。
 */
export const SYNC_BANNER_HARD_DISMISS_MS = 2 * 60 * 60 * 1000;

/**
 * 判断是否应该显示提示条
 * @param {{state?: object, outbox?: any[], dismissedAt?: number, nowMs?: number}} input
 * @returns {{show: boolean, reason?: "error"|"outbox_exhausted", text?: string}}
 */
export function evaluateSyncBanner({ state, outbox, dismissedAt = 0, nowMs = Date.now() }) {
  const hasDismiss = Number.isFinite(dismissedAt) && dismissedAt > 0;
  const dismissedRecently = hasDismiss && nowMs - dismissedAt < SYNC_BANNER_DISMISS_MS;

  // 硬故障：outbox 已达上限，自动重试已放弃，必须提示。
  // 仍尊重关闭动作，但只静默 2 小时（见 SYNC_BANNER_HARD_DISMISS_MS）。
  const exhausted = (Array.isArray(outbox) ? outbox : []).some((item) => {
    const attempts = Number(item?.attempts || 0);
    const max = Number(item?.maxAttempts || 12);
    return attempts >= max;
  });
  if (exhausted) {
    const hardSnoozed = hasDismiss && nowMs - dismissedAt < SYNC_BANNER_HARD_DISMISS_MS;
    return hardSnoozed ? { show: false } : { show: true, reason: "outbox_exhausted" };
  }

  if (dismissedRecently) return { show: false };

  const status = String(state?.status || "");
  const lastError = String(state?.lastError || "");
  if (status !== "error") return { show: false };

  // error 状态持续时间：优先用状态自带的时间戳，没有再退回「有 lastError 就提示」
  const since = Number(state?.lastErrorAt || state?.lastPushAt || state?.lastPullAt || 0);
  if (since > 0 && nowMs - since < SYNC_BANNER_ERROR_GRACE_MS) return { show: false };

  return { show: true, reason: "error", text: lastError };
}

/**
 * 创建提示条控制器
 * @param {{
 *   getState: () => Promise<object>,
 *   getOutbox: () => Promise<any[]>,
 *   onRetry: () => Promise<any>,
 *   onOpenSettings: () => void,
 *   getStorage: () => any,
 *   t: (key: string, vars?: object) => string,
 * }} deps
 */
export function createSyncBanner(deps) {
  const { getState, getOutbox, onRetry, onOpenSettings, getStorage, t } = deps;
  let dismissedAt = 0;
  let busy = false;

  const el = () => document.getElementById("syncBanner");
  const textEl = () => document.getElementById("syncBannerText");

  async function loadDismissed() {
    const storage = getStorage();
    try {
      const got = await storage.get(DISMISS_KEY);
      dismissedAt = Number(got?.[DISMISS_KEY] || 0);
    } catch {
      dismissedAt = 0;
    }
  }

  async function saveDismissed() {
    const storage = getStorage();
    try {
      await storage.set({ [DISMISS_KEY]: dismissedAt });
    } catch {
      // 写失败不影响主流程
    }
  }

  /** 根据当前状态刷新提示条 */
  async function refresh() {
    const banner = el();
    if (!banner) return;
    let state = {};
    let outbox = [];
    try {
      const [st, ob] = await Promise.all([getState(), getOutbox()]);
      state = st || {};
      outbox = Array.isArray(ob) ? ob : [];
    } catch {
      return;
    }
    const verdict = evaluateSyncBanner({ state, outbox, dismissedAt, nowMs: Date.now() });
    if (!verdict.show) {
      hide();
      return;
    }
    const label = textEl();
    if (label) {
      label.textContent =
        verdict.reason === "outbox_exhausted"
          ? t("sync.banner.outboxExhausted")
          : t("sync.banner.error").replace("{error}", verdict.text || "");
    }
    show();
  }

  function show() {
    const banner = el();
    if (!banner?.classList.contains("hidden")) return;
    banner.classList.remove("hidden");
    document.body.classList.add("sync-banner-open");
    // 提示条是 fixed 定位，给 app 让出实际高度
    document.documentElement.style.setProperty("--sync-banner-height", `${banner.offsetHeight}px`);
  }

  function hide() {
    const banner = el();
    if (!banner) return;
    banner.classList.add("hidden");
    document.body.classList.remove("sync-banner-open");
    document.documentElement.style.setProperty("--sync-banner-height", "0px");
  }

  function attach() {
    document.getElementById("btnSyncBannerRetry")?.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      const label = textEl();
      const prev = label?.textContent || "";
      // 重试期间必须让提示条可见，否则用户看不到「正在重试」的进度反馈
      show();
      if (label) label.textContent = t("sync.banner.retrying");
      try {
        await onRetry();
      } catch (e) {
        console.warn("sync banner retry failed", e);
      } finally {
        busy = false;
        await refresh();
        // refresh 判定不该显示时会自动隐藏；仍显示则恢复原文案
        if (label && !el()?.classList.contains("hidden")) label.textContent = prev;
      }
    });

    document.getElementById("btnSyncBannerSettings")?.addEventListener("click", () => {
      onOpenSettings();
    });

    document.getElementById("btnSyncBannerDismiss")?.addEventListener("click", async () => {
      dismissedAt = Date.now();
      await saveDismissed();
      hide();
    });
  }

  /** 启动：绑定事件 + 载入关闭记录 + 首次评估 */
  async function start() {
    await loadDismissed();
    attach();
    await refresh();
  }

  return { start, refresh, hide, evaluate: evaluateSyncBanner };
}
