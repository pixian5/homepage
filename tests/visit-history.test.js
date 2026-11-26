import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

let stored = {};
global.chrome = {
  storage: {
    local: {
      get: (key, cb) => {
        cb({ [key]: stored[key] });
      },
      set: (obj, cb) => {
        Object.assign(stored, obj);
        cb?.();
      },
    },
  },
  runtime: { lastError: null },
};

beforeEach(() => {
  stored = {};
});

describe("visit-history", async () => {
  const { recordVisit, getVisitHistoryItems, loadVisitHistory, initVisitTrackingInBackground } = await import(
    "../src/js/visit-history.js"
  );

  it("records and dedupes visits by url", async () => {
    await recordVisit({ url: "https://example.com/a", title: "A" });
    await recordVisit({ url: "https://example.com/b", title: "B" });
    await recordVisit({ url: "https://example.com/a", title: "A2" });
    const list = await loadVisitHistory();
    assert.equal(list.length, 2);
    assert.equal(list[0].url, "https://example.com/a");
    assert.equal(list[0].title, "A2");
  });

  it("ignores non-http urls", async () => {
    await recordVisit({ url: "chrome://settings", title: "x" });
    await recordVisit({ url: "javascript:alert(1)", title: "x" });
    const list = await loadVisitHistory();
    assert.equal(list.length, 0);
  });

  it("maps items for history grid", async () => {
    await recordVisit({ url: "https://example.com", title: "Ex" });
    const items = await getVisitHistoryItems(24);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, "history");
    assert.equal(items[0].title, "Ex");
  });

  it("works cleanly under Promise-only browser.storage and browser.tabs APIs", async () => {
    const realChrome = globalThis.chrome;
    const realBrowser = globalThis.browser;
    try {
      delete globalThis.chrome;
      const ffStore = {};
      globalThis.browser = {
        storage: {
          local: {
            get(key, extra) {
              if (typeof extra === "function") throw new TypeError("Promise-only storage.get");
              return Promise.resolve({ [key]: ffStore[key] });
            },
            set(obj, extra) {
              if (typeof extra === "function") throw new TypeError("Promise-only storage.set");
              Object.assign(ffStore, obj);
              return Promise.resolve();
            },
          },
        },
        tabs: {
          onUpdated: { addListener() {}, removeListener() {} },
          query(_query, extra) {
            if (typeof extra === "function") throw new TypeError("Promise-only tabs.query");
            return Promise.resolve([{ url: "https://visit-ff.example/", title: "FF Visit" }]);
          },
        },
      };

      initVisitTrackingInBackground();
      await new Promise((r) => setTimeout(r, 15));
      const list = await loadVisitHistory();
      assert.equal(list.length, 1);
      assert.equal(list[0].url, "https://visit-ff.example/");
      assert.equal(list[0].title, "FF Visit");
    } finally {
      if (realChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = realChrome;
      if (realBrowser === undefined) delete globalThis.browser;
      else globalThis.browser = realBrowser;
    }
  });
});
