import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

let stored = {};

global.chrome = {
  storage: {
    local: {
      get: (key, cb) => {
        cb({ [key]: stored[key] });
        return Promise.resolve();
      },
      set: (obj, cb) => {
        Object.assign(stored, obj);
        cb?.();
        return Promise.resolve();
      },
    },
  },
  runtime: { lastError: null },
};

beforeEach(() => {
  stored = {};
});

describe("bing-wallpaper", async () => {
  const { getBingWallpaper } = await import("../src/js/bing-wallpaper.js");

  it("returns cached wallpaper when fresh", async () => {
    stored.homepage_bg_cache = { date: "20990101", dataUrl: "data:image/png;base64,cached", ts: Date.now() };
    const result = await getBingWallpaper();
    assert.equal(result.dataUrl, "data:image/png;base64,cached");
    assert.equal(result.fromCache, true);
  });

  it("returns failed fallback when cache exists but fetch fails", async () => {
    stored.homepage_bg_cache = { date: "20000101", dataUrl: "data:image/png;base64,old", ts: 1 };

    global.fetch = async () => {
      throw new Error("network error");
    };

    const result = await getBingWallpaper();
    assert.equal(result.dataUrl, "data:image/png;base64,old");
    assert.equal(result.fromCache, true);
    assert.equal(result.failed, true);
  });

  it("uses the extension background when page fetch is blocked", async () => {
    global.fetch = async () => {
      throw new Error("cors blocked");
    };
    global.chrome.runtime.sendMessage = (_message, callback) => {
      callback({
        ok: true,
        url: "https://www.bing.com/th?id=background",
        dataUrl: "data:image/jpeg;base64,background",
      });
      return undefined;
    };

    const result = await getBingWallpaper();
    assert.equal(result.dataUrl, "data:image/jpeg;base64,background");
    assert.equal(result.url, "https://www.bing.com/th?id=background");
    global.chrome.runtime.sendMessage = undefined;
  });

  it("fetches and caches new wallpaper on success", async () => {
    global.fetch = async (url) => {
      if (url.includes("HPImageArchive")) {
        return {
          ok: true,
          json: async () => ({ images: [{ url: "/image.jpg" }] }),
        };
      }
      return {
        ok: true,
        blob: async () => ({ type: "image/jpeg", size: 100 }),
      };
    };

    global.FileReader = class {
      readAsDataURL() {
        this.result = "data:image/jpeg;base64,new";
        setTimeout(() => this.onloadend(), 0);
      }
    };
    global.Blob = class {
      constructor(_parts, opts) {
        this.type = opts?.type || "";
      }
    };

    const result = await getBingWallpaper();
    assert.equal(result.dataUrl, "data:image/jpeg;base64,new");
    assert.equal(result.fromCache, false);
    assert.equal(stored.homepage_bg_cache.dataUrl, "data:image/jpeg;base64,new");
  });

  it("supports Promise-only background messaging and consumes Chrome lastError cleanly", async () => {
    const realChrome = globalThis.chrome;
    const realBrowser = globalThis.browser;
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        throw new Error("cors blocked");
      };

      // 1) Firefox/Safari Promise-only sendMessage 兼容
      delete globalThis.chrome;
      globalThis.browser = {
        storage: {
          local: {
            get(key) {
              return Promise.resolve({ [key]: stored[key] });
            },
            set(obj) {
              Object.assign(stored, obj);
              return Promise.resolve();
            },
          },
        },
        runtime: {
          sendMessage(_msg, extra) {
            if (typeof extra === "function") throw new TypeError("Promise-only sendMessage");
            return Promise.resolve({
              ok: true,
              url: "https://www.bing.com/th?id=ff_bg",
              dataUrl: "data:image/jpeg;base64,ffbg",
            });
          },
        },
      };
      const ffResult = await getBingWallpaper();
      assert.equal(ffResult.dataUrl, "data:image/jpeg;base64,ffbg");
      assert.equal(ffResult.fromCache, false);

      // 2) Chrome 回调 runtime.lastError 必须被消费，失败时平滑回退旧缓存
      delete globalThis.browser;
      stored.homepage_bg_cache = { date: "20000101", dataUrl: "data:image/png;base64,fallback", ts: 1 };
      globalThis.chrome = {
        ...realChrome,
        runtime: {
          lastError: null,
          sendMessage(_msg, cb) {
            globalThis.chrome.runtime.lastError = { message: "Receiving end does not exist" };
            cb(undefined);
            globalThis.chrome.runtime.lastError = null;
          },
        },
      };
      const errResult = await getBingWallpaper();
      assert.equal(errResult.dataUrl, "data:image/png;base64,fallback");
      assert.equal(errResult.fromCache, true);
      assert.equal(errResult.failed, true);
      assert.equal(globalThis.chrome.runtime.lastError, null);
    } finally {
      globalThis.fetch = realFetch;
      if (realChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = realChrome;
      if (realBrowser === undefined) delete globalThis.browser;
      else globalThis.browser = realBrowser;
    }
  });
});
