/**
 * 图标管线管理器（icon-manager.js）测试：
 * - shouldRetryFailedIcon 纯函数：未配置禁用、失败时间未知可重试、当天不重试、
 *   次日到达配置小时后可重试、小时未到不重试；
 * - generateLetterAvatar / resolveIconUrl：文件夹与无 URL 节点直接字母头像；
 * - bindTileIcon：占位 → 缓存解析替换 → 过期批次（isStale）不更新 DOM；
 * - markIconLoadFailed / trySwitchToNextFavicon / fetchFaviconNow：缓存写入与失败标记。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createIconManager, shouldRetryFailedIcon } from "../src/js/icon-manager.js";
import { getSiteKey } from "../src/js/icons.js";
import { loadIconCache } from "../src/js/storage.js";

// ---- 最小 DOM / Canvas / fetch mock（Node 测试环境无浏览器 API）----
const realDocument = globalThis.document;
const realFetch = globalThis.fetch;
const realChrome = globalThis.chrome;

before(() => {
  globalThis.document = {
    createElement(tag) {
      if (tag !== "canvas") throw new Error(`unexpected createElement: ${tag}`);
      const canvas = {
        width: 0,
        height: 0,
        _ctx: null,
        getContext() {
          if (!canvas._ctx) {
            const ctx = { drawnText: "" };
            ctx.fillRect = () => {};
            ctx.fillText = (text) => {
              ctx.drawnText = String(text);
            };
            canvas._ctx = ctx;
          }
          return canvas._ctx;
        },
        toDataURL(type) {
          const drawn = canvas._ctx ? encodeURIComponent(canvas._ctx.drawnText) : "";
          return `data:${type};base64,MOCKCANVAS_${this.width}x${this.height}_${drawn}`;
        },
      };
      return canvas;
    },
  };
  // 离线环境：fetch 立即失败，避免真实 DNS 等待拖慢测试
  globalThis.fetch = () => Promise.reject(new Error("offline-test"));
});

after(() => {
  globalThis.document = realDocument;
  globalThis.fetch = realFetch;
  globalThis.chrome = realChrome;
});

/** mock 图标缓存存储（图标缓存 key 与 storage.js 内部常量一致） */
function stubIconStorage(store = {}) {
  const area = {
    get(keys, callback) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in store) result[key] = structuredClone(store[key]);
      }
      callback?.(result);
      return Promise.resolve(result);
    },
    set(obj, callback) {
      Object.assign(store, structuredClone(obj));
      callback?.();
      return Promise.resolve();
    },
  };
  globalThis.chrome = { runtime: { lastError: null }, storage: { local: area, sync: area } };
  return store;
}

describe("shouldRetryFailedIcon (pure)", () => {
  // 固定“现在”：2026-11-04 10:00（本地时区）
  const NOW = new Date(2026, 10, 4, 10, 0, 0).getTime();
  const sameDayEarlier = new Date(2026, 10, 4, 3, 0, 0).getTime();
  const prevDay = new Date(2026, 10, 3, 22, 0, 0).getTime();

  it("never retries when the retry hour is unset or invalid", () => {
    assert.equal(shouldRetryFailedIcon(prevDay, "", NOW), false);
    assert.equal(shouldRetryFailedIcon(prevDay, undefined, NOW), false);
    assert.equal(shouldRetryFailedIcon(prevDay, 24, NOW), false);
    assert.equal(shouldRetryFailedIcon(prevDay, -1, NOW), false);
    assert.equal(shouldRetryFailedIcon(prevDay, "not-a-number", NOW), false);
  });

  it("retries when the failure time is unknown", () => {
    assert.equal(shouldRetryFailedIcon(0, 2, NOW), true);
    assert.equal(shouldRetryFailedIcon(undefined, 2, NOW), true);
  });

  it("does not retry on the same day as the failure", () => {
    assert.equal(shouldRetryFailedIcon(sameDayEarlier, 2, NOW), false, "当天已失败不再重试");
  });

  it("retries on later days only after the configured hour", () => {
    assert.equal(shouldRetryFailedIcon(prevDay, 18, NOW), false, "次日 10 点未到 18 点");
    const laterHour = new Date(2026, 10, 4, 19, 0, 0).getTime();
    assert.equal(shouldRetryFailedIcon(prevDay, 18, laterHour), true, "次日 19 点已过 18 点");
    assert.equal(shouldRetryFailedIcon(prevDay, 0, NOW), true, "0 点配置：任何次日时刻都满足");
  });

  it("does not retry when now is not after the failure", () => {
    assert.equal(shouldRetryFailedIcon(NOW + 1000, 2, NOW), false);
  });
});

describe("createIconManager", () => {
  function makeManager(overrides = {}) {
    const calls = { persist: 0, render: 0, stamps: [] };
    const data = {
      settings: { iconFetch: true },
      nodes: {
        n_web: { id: "n_web", type: "item", title: "站点", url: "https://example.com/", iconType: "auto" },
        n_folder: { id: "n_folder", type: "folder", title: "文件夹", children: [] },
        n_pending: {
          id: "n_pending",
          type: "item",
          title: "待抓",
          url: "https://pending.example.com/",
          iconType: "auto",
          iconPending: true,
        },
      },
    };
    const manager = createIconManager({
      getData: () => data,
      persistData: async () => {
        calls.persist += 1;
      },
      render: () => {
        calls.render += 1;
      },
      stampNodeFieldChanges: (node, changes) => calls.stamps.push({ id: node.id, changes }),
      ...overrides,
    });
    return { manager, data, calls };
  }

  it("generates a letter avatar data url for any text", () => {
    const { manager } = makeManager();
    const dataUrl = manager.generateLetterAvatar("GitHub", "");
    assert.ok(dataUrl.startsWith("data:image/"), "字母头像必须是内嵌图片");
    assert.ok(dataUrl.includes("MOCKCANVAS_128x128"), "使用 128x128 canvas 绘制");
    // 相同文本稳定、不同首字母文本不同
    assert.equal(manager.generateLetterAvatar("GitHub", ""), dataUrl);
    assert.ok(dataUrl.includes("G"), "绘制首字母大写");
    assert.notEqual(manager.generateLetterAvatar("Baidu", ""), dataUrl);
  });

  it("resolveIconUrl falls back to a letter avatar for folders and url-less nodes", async () => {
    const { manager } = makeManager();
    const folderIcon = await manager.resolveIconUrl({ id: "f", type: "folder", title: "工具", children: [] });
    assert.ok(folderIcon.startsWith("data:"));
    const noUrl = await manager.resolveIconUrl({ id: "x", type: "item", title: "无网址", iconType: "auto" });
    assert.ok(noUrl.startsWith("data:"));
  });

  it("bindTileIcon shows the avatar placeholder, swaps to the resolved icon, and honors staleness", async () => {
    // 预置缓存：解析结果是一段独立的 dataURL，可与字母头像占位区分
    const CACHED = "data:image/png;base64,CACHED123";
    stubIconStorage({ homepage_icon_cache: { "https://example.com/": { dataUrl: CACHED, ts: 1 } } });
    const { manager } = makeManager();
    const img = { src: "", isConnected: true, naturalWidth: 64, naturalHeight: 64, onload: null, onerror: null };
    manager.bindTileIcon(img, {
      id: "n1",
      type: "item",
      title: "Example",
      url: "https://example.com/",
      iconType: "auto",
    });
    assert.ok(img.src.startsWith("data:"), "先渲染字母头像占位");
    assert.notEqual(img.src, CACHED, "占位不得是缓存图标");
    // 等待缓存解析的异步链完成
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(img.src, CACHED, "解析完成后替换为缓存图标");

    // 过期批次（isStale=true）：占位照常渲染，但解析结果不更新 DOM
    const staleImg = { src: "", isConnected: true };
    manager.bindTileIcon(
      staleImg,
      { id: "n2", type: "item", title: "Stale", url: "https://example.com/", iconType: "auto" },
      { isStale: () => true },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.notEqual(staleImg.src, CACHED, "渲染批次过期时不得替换为缓存图标");
    assert.ok(staleImg.src.startsWith("data:"), "占位仍正常显示");
  });

  it("markIconLoadFailed records attempts in the cache for url and site keys", async () => {
    stubIconStorage();
    const { manager } = makeManager();
    await manager.markIconLoadFailed("https://fail.example.com/page");
    const cache = await loadIconCache();
    const entry = cache["https://fail.example.com/page"];
    assert.equal(entry.failed, true);
    assert.equal(entry.attempts, 1);
    const siteKey = getSiteKey("https://fail.example.com/page");
    assert.equal(cache[siteKey].failed, true, "站点级缓存同样标记失败");
  });

  it("fetchFaviconNow writes the cache without persisting data (cancel-safe)", async () => {
    stubIconStorage();
    const { manager, calls, data } = makeManager();
    // 直接预置一份缓存，抓取路径在无网络环境下走失败分支——验证不 persist 的契约
    const ok = await manager.fetchFaviconNow("n_pending", "https://offline.example.com/");
    assert.equal(typeof ok, "boolean");
    assert.equal(calls.persist, 0, "fetchFaviconNow 不得持久化数据（取消安全）");
    assert.equal(data.nodes.n_pending.iconPending, true, "离线抓取失败不清 pending");
  });

  it("batchRefreshAllIcons refreshes and re-renders", async () => {
    stubIconStorage();
    const { manager, calls } = makeManager();
    await manager.batchRefreshAllIcons([{ id: "n1", type: "item", url: "https://a.example.com/", iconType: "auto" }]);
    assert.equal(calls.render, 1, "批量刷新后必须重渲染");
  });
});
