import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { executeScriptingFiles, executeTabsScript, openBookmarkSidebar, showToastInTab } from "../src/popup.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realChrome = globalThis.chrome;
const realBrowser = globalThis.browser;

afterEach(() => {
  if (realChrome === undefined) {
    delete globalThis.chrome;
  } else {
    globalThis.chrome = realChrome;
  }
  if (realBrowser === undefined) {
    delete globalThis.browser;
  } else {
    globalThis.browser = realBrowser;
  }
});

describe("manifest content_scripts convergence", () => {
  for (const filename of ["manifest.chrome.json", "manifest.firefox.json", "manifest.safari.json"]) {
    it(`${filename} 不应声明静态 <all_urls> content_scripts，并保留按需注入权限`, async () => {
      const manifest = JSON.parse(await readFile(path.join(root, filename), "utf8"));
      assert.equal("content_scripts" in manifest, false, `${filename} 仍包含静态 content_scripts`);
      assert.ok(Array.isArray(manifest.permissions), `${filename} 缺少 permissions`);
      for (const perm of ["scripting", "tabs", "activeTab"]) {
        assert.ok(manifest.permissions.includes(perm), `${filename} 缺少按需注入权限 ${perm}`);
      }
      assert.ok(
        Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes("<all_urls>"),
        `${filename} 缺少 <all_urls> host_permissions`,
      );
    });
  }

  it("按需注入目标脚本 js/content-toast.js 与 js/bookmark-sidebar.js 均存在", async () => {
    await access(path.join(root, "src/js/content-toast.js"));
    await access(path.join(root, "src/js/bookmark-sidebar.js"));
  });
});

describe("popup on-demand script injection compatibility", () => {
  it("Chrome 回调模式下未预注入页面可按需注入 bookmark-sidebar 并打开侧栏", async () => {
    let injected = false;
    const injectedFiles = [];
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getURL: (p) => `chrome-extension://ext/${p || ""}`,
      },
      tabs: {
        sendMessage(_tabId, msg, callback) {
          if (!injected) {
            globalThis.chrome.runtime.lastError = { message: "Receiving end does not exist." };
            callback(undefined);
            globalThis.chrome.runtime.lastError = null;
            return;
          }
          assert.equal(msg.type, "homepage_open_bookmark_sidebar");
          assert.equal(msg.side, "left");
          callback({ ok: true });
        },
      },
      scripting: {
        executeScript(injection, callback) {
          injectedFiles.push(...(injection.files || []));
          injected = true;
          callback([{ result: undefined }]);
        },
      },
    };

    const ok = await openBookmarkSidebar({ id: 42, url: "https://example.com" }, { groups: [] }, "left");
    assert.equal(ok, true);
    assert.deepEqual(injectedFiles, ["js/bookmark-sidebar.js"]);
  });

  it("Firefox / Safari Promise-only API（传入 trailing callback 抛错）可回退单参数 Promise 完成注入", async () => {
    delete globalThis.chrome;
    let toastReady = false;
    const calls = [];
    globalThis.browser = {
      runtime: {
        getURL: (p) => `moz-extension://ext/${p || ""}`,
      },
      tabs: {
        sendMessage(tabId, msg, options) {
          // 模拟 Firefox browser.tabs.sendMessage 第 3 参数非对象时同步抛错
          if (typeof options === "function") {
            throw new TypeError("Error processing options");
          }
          calls.push(`sendMessage:${tabId}:${msg.type}`);
          if (!toastReady) {
            return Promise.reject(new Error("Could not establish connection."));
          }
          return Promise.resolve({ ok: true });
        },
      },
      scripting: {
        executeScript(injection, ...extraArgs) {
          if (extraArgs.length > 0) {
            throw new TypeError("Too many arguments for executeScript.");
          }
          calls.push(`scripting:${(injection.files || []).join(",")}`);
          if (injection.files?.includes("js/content-toast.js")) {
            toastReady = true;
          }
          return Promise.resolve([]);
        },
      },
    };

    const ok = await showToastInTab({ id: 7, url: "https://example.org" }, "已保存", 14);
    assert.equal(ok, true);
    assert.deepEqual(calls, [
      "sendMessage:7:homepage_show_toast",
      "scripting:js/content-toast.js",
      "sendMessage:7:homepage_show_toast",
    ]);
  });

  it("tabs.executeScript 兜底与内联 Toast func 回退在 Promise/回调模式下均正常工作", async () => {
    const steps = [];
    globalThis.chrome = {
      runtime: {
        lastError: null,
        getURL: (p) => `chrome-extension://ext/${p || ""}`,
      },
      tabs: {
        sendMessage(_tabId, _msg, cb) {
          globalThis.chrome.runtime.lastError = { message: "No receiver" };
          cb(undefined);
          globalThis.chrome.runtime.lastError = null;
        },
        executeScript(tabId, details, cb) {
          steps.push(details.file ? `file:${tabId}:${details.file}` : `code:${tabId}`);
          cb([]);
        },
      },
    };

    const ok = await showToastInTab({ id: 9, url: "https://example.net" }, "Saved", 13);
    assert.equal(ok, true);
    assert.deepEqual(steps, ["file:9:js/content-toast.js", "code:9"]);
  });

  it("受限页面注入失败时应如实返回 false 而非谎报成功", async () => {
    const api = {
      runtime: { lastError: null, getURL: () => "chrome-extension://ext/" },
      tabs: {
        sendMessage(_tabId, _msg, cb) {
          api.runtime.lastError = { message: "Cannot access contents of url" };
          cb(undefined);
          api.runtime.lastError = null;
        },
      },
      scripting: {
        executeScript() {
          return Promise.reject(new Error("Cannot access a chrome:// URL"));
        },
      },
    };
    globalThis.chrome = api;

    await assert.rejects(executeScriptingFiles(api, { target: { tabId: 1 }, files: ["js/content-toast.js"] }));
    assert.equal(await executeTabsScript(api, 1, { file: "js/content-toast.js" }), false);
    assert.equal(await openBookmarkSidebar({ id: 1, url: "chrome://settings" }, { groups: [] }, "right"), false);
    assert.equal(await showToastInTab({ id: 1, url: "chrome://settings" }, "fail", 13), false);
  });
});
