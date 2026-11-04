/**
 * PWA 离线 Service Worker（纯 Web / PWA 模式）。
 *
 * 策略：
 * - install：预缓存离线核心静态资源（页面 / 样式 / 全部前端模块）；
 * - activate：清理旧版本 CacheStorage；
 * - fetch：同源 GET 走 Cache-First + 后台更新（Stale-While-Revalidate），
 *   导航请求无缓存时回退 newtab.html——离线打开即是完整应用。
 *
 * 仅在非扩展环境注册（见 shared-utils.registerServiceWorkerIfNeeded）；
 * 扩展环境自带打包资源，Service Worker 无意义且会干扰调试。
 */

const CACHE_VERSION = "homepage-pwa-v1";

/** 预缓存清单：页面外壳 + 样式 + 前端模块（与 scripts/firefox-modules.json 的 app 链路对应） */
const PRECACHE_URLS = [
  "newtab.html",
  "styles.css",
  "manifest.webmanifest",
  "logo.png",
  "js/app.js",
  "js/app-i18n.js",
  "js/shared-utils.js",
  "js/storage-listener.js",
  "js/pinyin-match.js",
  "js/search-manager.js",
  "js/sync_policy.js",
  "js/data-utils.js",
  "js/bookmark-html.js",
  "js/drag-geometry.js",
  "js/drag-manager.js",
  "js/touch-drag-manager.js",
  "js/safari_native_storage.js",
  "js/storage.js",
  "js/icons.js",
  "js/icon-manager.js",
  "js/bing-wallpaper.js",
  "js/visit-history.js",
  "js/history-manager.js",
  "js/sync_settings.js",
  "js/sync_ids.js",
  "js/sync_projection.js",
  "js/sync_merge.js",
  "js/sync_bundle.js",
  "js/sync_pack.js",
  "js/sync_outbox.js",
  "js/sync_http_transport.js",
  "js/sync_engine.js",
  "js/sync-banner.js",
  "js/ui-utils.js",
  "js/context-menu.js",
  "js/modal-manager.js",
  "js/settings-controller.js",
  "js/selection-manager.js",
  "js/toast-manager.js",
  "js/folder-manager.js",
  "js/tooltip-manager.js",
  "js/grid-renderer.js",
  "js/persistence-coordinator.js",
  "js/node-ops-manager.js",
  "js/sidebar-manager.js",
  "js/theme-manager.js",
  "js/open-mode-manager.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // 逐个放入：单个资源失败不阻塞整个安装（addAll 任一失败会整体回滚）
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((error) => {
            console.warn("[sw] precache miss:", url, error?.message || error);
          }),
        ),
      );
      // 新版本装好后尽快接管，不等旧标签页全部关闭
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("homepage-pwa-") && name !== CACHE_VERSION)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 只接管同源静态资源，不碰同步服务器与壁纸 API

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) {
        // Stale-While-Revalidate：先回缓存，后台更新下一版
        event.waitUntil(
          (async () => {
            try {
              const fresh = await fetch(request);
              if (fresh?.ok) await cache.put(request, fresh.clone());
            } catch (_e) {
              // 离线时后台更新失败是预期情况
            }
          })(),
        );
        return cached;
      }
      try {
        const fresh = await fetch(request);
        if (fresh?.ok && fresh.type === "basic") {
          await cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (_e) {
        // 导航请求无缓存也无网络：回退应用外壳
        if (request.mode === "navigate") {
          const shell = await cache.match("newtab.html", { ignoreSearch: true });
          if (shell) return shell;
        }
        return new Response("offline", { status: 503, statusText: "offline" });
      }
    })(),
  );
});
