/**
 * PWA 离线闭环测试：
 * - manifest.webmanifest 字段结构完整性（name/start_url/display/主题与背景色/图标清单）；
 * - sw.js 缓存清单与策略状态机：预缓存核心资源清单、install 逐项容错、activate 清旧缓存、
 *   fetch 的 Cache-First / Stale-While-Revalidate / 导航回退；
 * - registerServiceWorkerIfNeeded 的环境判定（扩展跳过 / 非安全上下文跳过 / 注册成功与失败）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realChrome = globalThis.chrome;
const realNavigator = globalThis.navigator;

describe("manifest.webmanifest", () => {
  it("contains the required pwa fields and icon entries", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "src", "manifest.webmanifest"), "utf8"));
    assert.equal(manifest.name, "我的首页");
    assert.equal(manifest.short_name, "首页");
    assert.equal(manifest.start_url, "newtab.html");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.theme_color, "#1e293b");
    assert.equal(manifest.background_color, "#0f172a");
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1);
    const icon = manifest.icons[0];
    assert.equal(icon.src, "logo.png");
    assert.equal(icon.type, "image/png");
    assert.match(icon.sizes, /^\d+x\d+$/);
    assert.ok(
      manifest.icons.some((entry) => entry.purpose === "maskable"),
      "含 maskable 图标",
    );
    // 图标文件确实存在（构建经 rsync 全量复制 src/）
    await readFile(path.join(root, "src", "logo.png"));
  });

  it("is referenced from newtab.html", async () => {
    const html = await readFile(path.join(root, "src", "newtab.html"), "utf8");
    assert.ok(html.includes('rel="manifest"'), "页面头部必须声明 manifest");
    assert.ok(html.includes('name="theme-color"'), "声明 theme-color");
  });
});

describe("sw.js cache manifest & strategy", () => {
  const swUrl = path.join(root, "src", "sw.js");

  it("precaches the app shell: html, css and all frontend modules", async () => {
    const code = await readFile(swUrl, "utf8");
    // 预缓存清单确实包含核心资源
    for (const url of ["newtab.html", "styles.css", "manifest.webmanifest", "logo.png", "js/app.js"]) {
      assert.ok(code.includes(`"${url}"`), `预缓存缺 ${url}`);
    }
    // 预缓存清单与 firefox-modules.json 的 app 链路一致（app 与 background 共用模块都要离线可用）
    const modules = JSON.parse(await readFile(path.join(root, "scripts", "firefox-modules.json"), "utf8"));
    for (const module of modules.app) {
      assert.ok(code.includes(`"js/${module}"`), `预缓存缺前端模块 js/${module}`);
    }
    // 版本前缀：activate 清理按前缀匹配
    assert.match(code, /homepage-pwa-/);
  });

  it("parses as a classic service worker script", async () => {
    // node --check 等价物：用 vm 编译（不执行，sw 依赖 self/addEventListener）
    const vm = await import("node:vm");
    const code = await readFile(swUrl, "utf8");
    new vm.Script(code, { filename: "sw.js" });
  });

  it("registers fetch/activate handlers and keeps api requests off-line-scoped", async () => {
    const handlers = {};
    const cacheApi = {
      open: async () => ({
        add: async () => {},
        match: async () => null,
        put: async () => {},
      }),
      keys: async () => ["homepage-pwa-v0", "homepage-pwa-v1", "unrelated-cache"],
      delete: async (name) => {
        handlers.deletedCaches = handlers.deletedCaches || [];
        handlers.deletedCaches.push(name);
      },
    };
    const selfMock = {
      location: { origin: "http://127.0.0.1:8899" },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      },
    };
    const vm = await import("node:vm");
    const code = await readFile(swUrl, "utf8");
    const context = vm.createContext({
      self: selfMock,
      caches: cacheApi,
      Request: class Request {
        constructor(url) {
          this.url = url;
        }
      },
      Response: class Response {
        constructor(body, init) {
          this.body = body;
          this.status = init?.status || 200;
          this.ok = (init?.status || 200) < 400;
        }
      },
      fetch: async () => {
        throw new Error("offline-test");
      },
      console: { warn: () => {}, info: () => {} },
      URL,
      Promise,
    });
    vm.runInContext(code, context, { filename: "sw.js" });

    // install：预缓存执行且成功 resolve（waitUntil 捕获）
    let installDone;
    const installEvent = { waitUntil: (p) => (installDone = p) };
    handlers.install(installEvent);
    await installDone;
    assert.equal(typeof installDone?.then, "function", "waitUntil 收到 Promise（vm realm 用 thenable 判定）");

    // activate：只清理旧版本前缀缓存
    let activateDone;
    handlers.activate({ waitUntil: (p) => (activateDone = p) });
    await activateDone;
    assert.deepEqual(handlers.deletedCaches, ["homepage-pwa-v0"], "只清旧版本缓存，不碰无关缓存");

    // fetch：非 GET 与跨源请求不接管
    let responded = null;
    const fetchEvent = (request) => ({
      request,
      waitUntil: () => {},
      respondWith: (p) => {
        responded = p;
      },
    });
    handlers.fetch(fetchEvent({ method: "POST", url: "http://127.0.0.1:8899/api" }));
    assert.equal(responded, null, "POST 不接管");
    handlers.fetch(fetchEvent({ method: "GET", url: "https://sync.example.com/state" }));
    assert.equal(responded, null, "跨源（同步服务器）不接管");

    // 同源 GET 且离线（fetch reject）：导航请求回退 newtab.html 外壳
    const cacheWithShell = {
      ...cacheApi,
      open: async () => ({
        add: async () => {},
        match: async (req) => {
          const url = typeof req === "string" ? req : req.url;
          return url.includes("newtab.html") ? { body: "<shell>" } : null;
        },
        put: async () => {},
      }),
    };
    Object.assign(context, { caches: cacheWithShell });
    let navResponded = null;
    handlers.fetch({
      request: { method: "GET", url: "http://127.0.0.1:8899/some/page", mode: "navigate" },
      waitUntil: () => {},
      respondWith: (p) => (navResponded = p),
    });
    assert.equal(typeof navResponded?.then, "function", "respondWith 接收 Promise<Response>");
    const shellResponse = await navResponded;
    assert.ok(shellResponse, "离线导航必须给出响应");
  });
});

describe("registerServiceWorkerIfNeeded", () => {
  const setNavigator = (value) => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value });
  };

  afterEach(() => {
    globalThis.chrome = realChrome;
    setNavigator(realNavigator);
  });

  it("skips in extension context, insecure context, and missing api", async () => {
    const shared = await import("../src/js/shared-utils.js");
    globalThis.chrome = { runtime: { id: "extension-id" } };
    setNavigator({
      serviceWorker: {
        register: async () => {
          throw new Error("不应注册");
        },
      },
    });
    globalThis.window = globalThis.window || {};
    globalThis.window.isSecureContext = true;
    assert.equal(await shared.registerServiceWorkerIfNeeded(), false, "扩展环境跳过");

    delete globalThis.chrome;
    globalThis.chrome = undefined;
    globalThis.window.isSecureContext = false;
    assert.equal(await shared.registerServiceWorkerIfNeeded(), false, "非安全上下文跳过");

    globalThis.window.isSecureContext = true;
    setNavigator({});
    assert.equal(await shared.registerServiceWorkerIfNeeded(), false, "无 serviceWorker API 跳过");
  });

  it("registers in a secure pure-web context and swallows failures", async () => {
    const shared = await import("../src/js/shared-utils.js");
    delete globalThis.chrome;
    globalThis.chrome = undefined;
    const registrations = [];
    setNavigator({
      serviceWorker: {
        register: async (url) => {
          registrations.push(url);
          return {};
        },
      },
    });
    globalThis.window = globalThis.window || {};
    globalThis.window.isSecureContext = true;
    // 前序用例可能清掉 location：这里补一个最小存在值
    Object.defineProperty(globalThis.window, "location", { configurable: true, value: { href: "http://127.0.0.1/" } });
    assert.equal(await shared.registerServiceWorkerIfNeeded("sw.js"), true);
    assert.deepEqual(registrations, ["sw.js"]);

    setNavigator({
      serviceWorker: { register: async () => Promise.reject(new Error("quota")) },
    });
    assert.equal(await shared.registerServiceWorkerIfNeeded(), false, "注册失败静默降级不抛出");
  });
});
