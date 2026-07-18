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
});
