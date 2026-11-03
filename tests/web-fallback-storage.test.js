/**
 * 纯 Web / PWA 模式存储回退测试（shared-utils.js）：
 * - 无扩展 API 注入时 storageArea 回退到 window.localStorage 封装层；
 * - get 支持全部 chrome.storage 语义（string / array / object 默认值 / null 全量）；
 * - set / remove / clear 读写正确，值经 JSON 序列化往返无损；
 * - 回调与 Promise 双签名兼容；storageGet/storageSet 空区域安全；
 * - getStorageMode 三态判定；扩展 API 存在时行为完全不变（优先扩展存储）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

// 先注入假的 localStorage 再导入被测模块（模块级缓存 _webFallbackArea 在首次调用时建立）
const storageBacking = new Map();
globalThis.localStorage = {
  get length() {
    return storageBacking.size;
  },
  key(index) {
    return [...storageBacking.keys()][index] ?? null;
  },
  getItem(key) {
    return storageBacking.has(String(key)) ? storageBacking.get(String(key)) : null;
  },
  setItem(key, value) {
    storageBacking.set(String(key), String(value));
  },
  removeItem(key) {
    storageBacking.delete(String(key));
  },
  clear() {
    storageBacking.clear();
  },
};

const shared = await import("../src/js/shared-utils.js");
const storage = await import("../src/js/storage.js");

const realChrome = globalThis.chrome;
const realBrowser = globalThis.browser;

function clearExtensionApis() {
  delete globalThis.chrome;
  delete globalThis.browser;
  globalThis.chrome = undefined;
  globalThis.browser = undefined;
}

describe("web fallback storage (shared-utils)", () => {
  afterEach(() => {
    globalThis.chrome = realChrome;
    globalThis.browser = realBrowser;
    storageBacking.clear();
  });

  it("falls back to a localStorage-backed area when no extension api is present", async () => {
    clearExtensionApis();
    assert.equal(shared.getStorageMode(), "web-local");
    const area = shared.storageArea(false);
    assert.ok(area, "必须返回 localStorage 兼容层而非 null");
    // 同一页面内引用稳定
    assert.equal(shared.storageArea(false), area);
    assert.equal(shared.storageArea(true), area, "sync 区域同样回退（Web 模式无 sync 概念）");
  });

  it("supports chrome.storage get semantics: string, array, object defaults and null (all)", async () => {
    clearExtensionApis();
    const area = shared.storageArea(false);
    await area.set({ homepage_data: { hello: 1 }, visit_history: ["a"], other_key: { deep: { value: true } } });

    // string
    assert.deepEqual(await area.get("homepage_data"), { homepage_data: { hello: 1 } });
    assert.deepEqual(await area.get("missing_key"), {}, "缺失键不出现");
    // array
    assert.deepEqual(await area.get(["homepage_data", "missing_key"]), { homepage_data: { hello: 1 } });
    // object 默认值
    assert.deepEqual(await area.get({ homepage_data: null, missing_key: "默认" }), {
      homepage_data: { hello: 1 },
      missing_key: "默认",
    });
    // null 全量
    const all = await area.get(null);
    assert.deepEqual(Object.keys(all).sort(), ["homepage_data", "other_key", "visit_history"]);
  });

  it("round-trips values via JSON and supports callback signatures", async () => {
    clearExtensionApis();
    const area = shared.storageArea(false);
    // 回调签名
    await new Promise((resolve) => area.set({ k: { list: [1, 2, 3] } }, resolve));
    const got = await new Promise((resolve) => area.get("k", resolve));
    assert.deepEqual(got, { k: { list: [1, 2, 3] } });
    // Promise 签名（Firefox 风格）
    assert.deepEqual(await area.get("k"), { k: { list: [1, 2, 3] } });
  });

  it("removes and clears keys", async () => {
    clearExtensionApis();
    const area = shared.storageArea(false);
    await area.set({ a: 1, b: 2, c: 3 });
    await area.remove("a");
    assert.deepEqual(await area.get(["a", "b"]), { b: 2 });
    await area.remove(["b", "c"]);
    assert.deepEqual(await area.get(null), {});
    await area.set({ z: 9 });
    await area.clear();
    assert.equal(storageBacking.size, 0);
  });

  it("keeps extension storage preferred when the api exists", () => {
    const extensionArea = {
      get(_keys, callback) {
        callback({ homepage_data: "from-extension" });
      },
      set(_obj, callback) {
        callback();
      },
    };
    globalThis.chrome = { runtime: { lastError: null }, storage: { local: extensionArea, sync: extensionArea } };
    assert.equal(shared.getStorageMode(), "extension");
    assert.equal(shared.storageArea(false), extensionArea, "扩展环境必须原样返回扩展存储");
  });

  it("storageGet/storageSet are null-area safe", async () => {
    assert.equal(await shared.storageGet(null, "x"), undefined);
    assert.equal(await shared.storageSet(null, { x: 1 }), "no_storage_area");
  });

  it("storage.loadData persists defaults into localStorage in web mode and reads them back", async () => {
    clearExtensionApis();
    storageBacking.clear();
    const first = await storage.loadData();
    assert.ok(Array.isArray(first.groups), "Web 模式首次加载返回默认数据");
    assert.ok(storageBacking.size > 0, "默认数据必须落盘 localStorage");
    // 修改后重新加载：应读到写入的版本（持久化生效，刷新不丢）
    first.settings.language = "en";
    const area = shared.storageArea(false);
    await area.set({ homepage_data: first });
    const second = await storage.loadData();
    assert.equal(second.settings.language, "en", "Web 模式数据必须跨 loadData 持久化");
    assert.equal(second.groups[0].id, first.groups[0].id);
  });

  it("reports memory mode when neither extension nor localStorage exists", () => {
    clearExtensionApis();
    const savedLocalStorage = globalThis.localStorage;
    delete globalThis.localStorage;
    globalThis.localStorage = undefined;
    assert.equal(shared.getStorageMode(), "memory");
    globalThis.localStorage = savedLocalStorage;
  });
});
