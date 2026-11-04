/**
 * 启动同步与异常条协调器（sync-startup-coordinator）。
 * 内聚打开新标签页时的同步状态检查、异常提示条生命周期装配、云端首拉（GET）与离线队列冲刷。
 */

import { createSyncBanner } from "./sync-banner.js";

/**
 * 在页面就绪后启动云端同步与同步异常提示条。
 *
 * @param {Object} options
 * @param {Object} options.settings 主页配置字典
 * @param {function(): void} [options.refreshSyncInterval] 刷新周期轮询定时器
 * @param {function(): any} [options.reloadSyncState] 读取最新同步状态
 * @param {function(): any} [options.getOutboxSummary] 获取发件箱统计
 * @param {function(string): Promise<any>} [options.pullNow] 执行远端拉取
 * @param {function(string): Promise<any>} [options.pushNow] 执行本地推送
 * @param {function(): Promise<any>} [options.flushOutbox] 冲刷离线待发队列
 * @param {function(): void} [options.openSettingsModal] 打开设置弹窗
 * @param {function(): any} [options.getStorage] 获取扩展 local 存储
 * @param {function(string, any): string} [options.t] 国际化文案翻译
 * @param {function(): void} [options.render] 重新渲染主界面
 * @returns {{ syncBanner: any, startPromise: Promise<any> } | null}
 */
export function startSyncOnLaunch({
  settings,
  refreshSyncInterval,
  reloadSyncState,
  getOutboxSummary,
  pullNow,
  pushNow,
  flushOutbox,
  openSettingsModal,
  getStorage,
  t,
  render,
  bannerFactory = createSyncBanner,
}) {
  if (!settings?.syncEnabled) {
    return null;
  }

  refreshSyncInterval?.();

  // 同步异常提示条：让失败可见（此前断链两个月无人察觉）。
  // 重试走手动 pushNow —— 它不受 outbox attempts 上限限制，是用户的唯一自救入口。
  const createBanner = typeof bannerFactory === "function" ? bannerFactory : createSyncBanner;
  const syncBanner = createBanner({
    getState: () => reloadSyncState?.(),
    getOutbox: () => getOutboxSummary?.(),
    onRetry: async () => {
      // 先拉一次拿到最新基线（顺带刷 etag），再推本地；手动推送不受 outbox attempts 上限限制。
      if (typeof pullNow === "function") {
        await pullNow("banner_retry");
      }
      if (typeof pushNow === "function") {
        return pushNow("banner_retry");
      }
    },
    onOpenSettings: () => openSettingsModal?.(),
    getStorage: () => (typeof getStorage === "function" ? getStorage() : null),
    t: (k, vars) => (typeof t === "function" ? t(k, vars) : k),
  });

  void syncBanner.start();

  // 「同步间隔 = 关闭」只表示不做周期轮询，不代表打开页面也不看云端。
  // 打开页面拉一次只是一次轻量 GET；远端没变会直接短路返回，不会重绘也不会碰壁纸。
  const startPromise = (async () => {
    try {
      const pull = typeof pullNow === "function" ? await pullNow("init") : null;
      if (pull?.needPush && typeof pushNow === "function") {
        await pushNow("init_need_push");
      }
      // 离线时由本地变更产生的待发送项仍可在打开页面后重试。
      if (typeof flushOutbox === "function") {
        await flushOutbox();
      }
      render?.();
    } catch (e) {
      console.warn("init sync failed", e);
    } finally {
      // 首次同步结束后刷新提示条：此时才拿到真实结果
      void syncBanner?.refresh?.();
    }
  })();

  return {
    syncBanner,
    startPromise,
  };
}
