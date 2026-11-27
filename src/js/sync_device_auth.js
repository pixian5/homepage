/**
 * 同步设备认证、自动配对与退役熔断控制器（从 sync_engine.js 拆出）。
 *
 * 职责：组装传输配置与鉴权头（优先 Device 独立凭据，否则回退 Bearer Token）、
 * 首次同步或切服时自动调用 /v1/sync/pair 签发设备凭据（含单飞去重与落盘失败回滚）、
 * 401 失配凭据自愈清理、403 设备退役熔断通知。
 *
 * 用 IIFE 包裹：Firefox 版把所有模块拼成一个经典脚本，
 * 顶层 const/let 会和其它模块重名。IIFE 保证只暴露一个全局名。
 */
import { isLocalTrimWarning } from "./shared-utils.js";

var HomepageSyncDeviceAuth = (() => {
  /** 根据 UserAgent 生成友好设备名（配对时登记到服务端设备表，仪表盘可见） */
  function friendlyDeviceName() {
    const ua = String(typeof navigator !== "undefined" ? navigator.userAgent || "" : "");
    if (!ua) return "未命名设备";
    if (/firefox\//i.test(ua)) return "Firefox 浏览器";
    if (/edg\//i.test(ua)) return "Edge 浏览器";
    if (/chrome|crios/i.test(ua)) return "Chrome 浏览器";
    if (/safari/i.test(ua)) return "Safari 扩展";
    return "浏览器设备";
  }

  /**
   * @param {{
   *   getData: () => object,
   *   saveLocal: (data: object) => Promise<string|null>,
   *   getOrCreateDeviceId: () => Promise<string>,
   *   httpPairDevice: (cfg: object, body: { deviceId: string, deviceName: string }) => Promise<any>,
   *   onDeviceRetired?: () => Promise<void>|void,
   * }} deps
   */
  function createSyncDeviceAuth(deps) {
    const getData = deps.getData;
    const saveLocal = deps.saveLocal;
    const getOrCreateDeviceId = deps.getOrCreateDeviceId;
    const httpPairDevice = deps.httpPairDevice;
    const onDeviceRetired = deps.onDeviceRetired || (async () => {});

    /** 防止并发同步同时发起多次配对 */
    let _pairInFlight = null;

    function getTransportConfig() {
      const data = getData();
      const settings = data?.settings || {};
      return {
        // 同步只走自建 HTTP 服务；浏览器 storage.sync 不再作为数据源或写入目标。
        mode: "http",
        baseUrl: String(settings.syncServerUrl || "").trim(),
        token: String(settings.syncServerToken || "").trim(),
        // 设备独立凭据（P1 配对签发）：存在时 pull/push/confirm 优先使用 Device 头
        deviceSecret: String(settings.syncDeviceSecret || "").trim(),
        // 凭据签发时的服务器地址：换了服务器后旧凭据立即失效，需要重新配对
        deviceSecretUrl: String(settings.syncDeviceSecretUrl || "").trim(),
      };
    }

    /**
     * 组装本次请求的传输凭据：
     * - 配对过且服务器地址未变 → Device <deviceId>:<deviceSecret>（独立凭据，可被单独注销）；
     * - 否则 → 回退全局 Bearer Token（未配对客户端的兼容行为）。
     */
    async function getTransportAuth() {
      const transport = getTransportConfig();
      if (transport.deviceSecret && transport.baseUrl && transport.deviceSecretUrl === transport.baseUrl) {
        const deviceId = await getOrCreateDeviceId();
        if (deviceId) {
          return { ...transport, deviceId, deviceSecret: transport.deviceSecret };
        }
      }
      return { baseUrl: transport.baseUrl, token: transport.token };
    }

    /**
     * 自动配对设备独立凭据：
     * 同步开启 + 配置了服务器与 Master Token + 本地尚无凭据时，
     * 用 Master Token 为本机签发 Device 凭据并写入 settings 持久化；
     * 之后所有 pull / push / confirm 自动改用该凭据。
     * 配对失败静默降级（继续用 Bearer），不阻断同步本身。
     * @returns {Promise<boolean>} 是否完成配对（含已在飞行中）
     */
    async function ensureDevicePairing() {
      const data = getData();
      const settings = data?.settings || {};
      if (!settings.syncEnabled) return false;
      const baseUrl = String(settings.syncServerUrl || "").trim();
      const token = String(settings.syncServerToken || "").trim();
      // 开放模式（无 Master Token）没有配对意义：服务端不校验任何凭据
      if (!baseUrl || !token) return false;
      const existing = String(settings.syncDeviceSecret || "").trim();
      if (existing && String(settings.syncDeviceSecretUrl || "").trim() === baseUrl) return false;
      if (_pairInFlight) return _pairInFlight;
      _pairInFlight = (async () => {
        try {
          const deviceId = await getOrCreateDeviceId();
          if (!deviceId) return false;
          const res = await httpPairDevice({ baseUrl, token }, { deviceId, deviceName: friendlyDeviceName() });
          if (!res?.ok || !res.deviceSecret) return false;
          const current = getData();
          if (!current?.settings) return false;
          // 等待期间别的实例可能已配对成功
          const raced = String(current.settings.syncDeviceSecret || "").trim();
          if (raced && String(current.settings.syncDeviceSecretUrl || "").trim() === baseUrl) return true;
          current.settings.syncDeviceSecret = res.deviceSecret;
          current.settings.syncDeviceSecretUrl = baseUrl;
          current._syncMeta = {
            ...(current._syncMeta && typeof current._syncMeta === "object" ? current._syncMeta : {}),
            lastWriteSource: "sync_meta",
          };
          const err = await saveLocal(current);
          if (err && !isLocalTrimWarning(err)) {
            // 落盘失败必须回滚内存：否则本页一直用未持久化的凭据，重启后凭据丢失
            delete current.settings.syncDeviceSecret;
            delete current.settings.syncDeviceSecretUrl;
            return false;
          }
          return true;
        } catch (e) {
          console.warn("pair device failed", e);
          return false;
        } finally {
          _pairInFlight = null;
        }
      })();
      return _pairInFlight;
    }

    /**
     * 设备凭据被服务端判定未授权（401）：通常是服务器数据重建或换库后旧凭据失配。
     * 清掉本地凭据，下一轮同步会自动用 Master Token 重新配对自愈。
     */
    async function dropStaleDeviceCredentials() {
      const current = getData();
      if (!current?.settings?.syncDeviceSecret) return;
      delete current.settings.syncDeviceSecret;
      delete current.settings.syncDeviceSecretUrl;
      current._syncMeta = {
        ...(current._syncMeta && typeof current._syncMeta === "object" ? current._syncMeta : {}),
        lastWriteSource: "sync_meta",
      };
      try {
        await saveLocal(current);
      } catch (e) {
        console.warn("drop stale device credentials failed", e);
      }
    }

    /**
     * 退役熔断：本设备已被管理员注销，服务端对一切读写返回 403 device_retired。
     */
    async function markDeviceRetired() {
      await onDeviceRetired();
    }

    return {
      getTransportConfig,
      getTransportAuth,
      ensureDevicePairing,
      dropStaleDeviceCredentials,
      markDeviceRetired,
    };
  }

  return { createSyncDeviceAuth, friendlyDeviceName };
})();

// ESM 构建（Chrome/Safari）从这里取；Firefox 拼接时会剥掉 export，改用上面的全局变量。
export const createSyncDeviceAuth = HomepageSyncDeviceAuth.createSyncDeviceAuth;
export const friendlyDeviceName = HomepageSyncDeviceAuth.friendlyDeviceName;
