import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addBookmarkToFolderInData } from "../src/js/background.js";

function sampleData() {
  return {
    lastUpdated: 5000,
    groups: [
      {
        id: "grp_all",
        name: "全部",
        nodes: ["fld_work"],
        updatedAt: 4000,
        updatedBy: "dev_old",
      },
    ],
    nodes: {
      fld_work: {
        id: "fld_work",
        type: "folder",
        title: "Work",
        children: ["itm_1"],
        updatedAt: 5200,
        updatedBy: "dev_old",
      },
      itm_1: {
        id: "itm_1",
        type: "item",
        title: "Existing",
        url: "https://existing.example/",
        updatedAt: 3000,
        updatedBy: "dev_old",
      },
    },
    _syncMeta: { placementClock: {} },
  };
}

describe("background addBookmarkToFolderInData", () => {
  it("writes bookmark into group with monotonic sync timestamps and placementClock", () => {
    const data = sampleData();
    const res = addBookmarkToFolderInData(data, {
      folderId: "grp_all",
      url: "https://news.example.com/article",
      title: "News",
      deviceId: "dev_safari",
      now: 1200, // 故意落后于 data.lastUpdated (5000)
    });

    assert.equal(res.ok, true);
    const { node } = res;
    assert.equal(node.url, "https://news.example.com/article");
    assert.equal(node.title, "News");
    assert.equal(node.createdAt, 5001);
    assert.equal(node.updatedAt, 5001);
    assert.equal(node.titleUpdatedAt, 5001);
    assert.equal(node.urlUpdatedAt, 5001);
    assert.equal(node.updatedBy, "dev_safari");
    assert.equal(data.lastUpdated, 5001);
    assert.equal(data.groups[0].updatedAt, 5001);
    assert.equal(data.groups[0].updatedBy, "dev_safari");
    assert.equal(data.groups[0].nodes.at(-1), node.id);
    assert.deepEqual(data._syncMeta.placementClock[node.id], {
      parentKind: "group",
      parentId: "grp_all",
      index: 1,
      updatedAt: 5001,
      updatedBy: "dev_safari",
    });
  });

  it("writes bookmark into folder and advances beyond folder.updatedAt", () => {
    const data = sampleData();
    data.nodes.fld_work.titleUpdatedAt = 5300;
    const res = addBookmarkToFolderInData(data, {
      folderId: "fld_work",
      url: "http://docs.example.org/",
      deviceId: "dev_ff",
      now: 2000, // 落后于 folder.titleUpdatedAt (5300)
    });

    assert.equal(res.ok, true);
    const { node } = res;
    assert.equal(node.title, "http://docs.example.org/");
    assert.equal(node.createdAt, 5301);
    assert.equal(node.updatedAt, 5301);
    assert.equal(node.titleUpdatedAt, 5301);
    assert.equal(node.urlUpdatedAt, 5301);
    assert.equal(node.updatedBy, "dev_ff");
    assert.equal(data.nodes.fld_work.updatedAt, 5301);
    assert.equal(data.nodes.fld_work.updatedBy, "dev_ff");
    assert.equal(data.lastUpdated, 5301);
    assert.deepEqual(data._syncMeta.placementClock[node.id], {
      parentKind: "folder",
      parentId: "fld_work",
      index: 1,
      updatedAt: 5301,
      updatedBy: "dev_ff",
    });
  });

  it("rejects invalid urls, missing targets, tombstoned folders, and non-folder nodes cleanly", () => {
    const data = sampleData();
    data.nodes.fld_deleted = { id: "fld_deleted", type: "folder", title: "Deleted", children: [], deletedAt: 100 };
    assert.deepEqual(
      addBookmarkToFolderInData(data, { folderId: "grp_all", url: "javascript:alert(1)", deviceId: "d" }),
      { ok: false, error: "invalid_url" },
    );
    assert.deepEqual(addBookmarkToFolderInData(data, { folderId: "missing", url: "https://a.test/", deviceId: "d" }), {
      ok: false,
      error: "no_folder",
    });
    assert.deepEqual(
      addBookmarkToFolderInData(data, { folderId: "fld_deleted", url: "https://a.test/", deviceId: "d" }),
      { ok: false, error: "no_folder" },
    );
    assert.deepEqual(addBookmarkToFolderInData(data, { folderId: "itm_1", url: "https://a.test/", deviceId: "d" }), {
      ok: false,
      error: "no_folder",
    });
    assert.equal(Object.keys(data.nodes).length, 3);
  });

  it("runtime onMessage 串行处理并发添加书签并兼容 Promise-only 与 Chrome lastError", async () => {
    const realChrome = globalThis.chrome;
    const realBrowser = globalThis.browser;
    try {
      // 1) Firefox/Safari Promise-only runtime（无 globalThis.chrome）
      delete globalThis.chrome;
      const listeners = [];
      let storeData = sampleData();
      let setCalls = 0;
      globalThis.browser = {
        runtime: {
          onMessage: { addListener: (fn) => listeners.push(fn) },
        },
        storage: {
          local: {
            get(_keys, extra) {
              if (typeof extra === "function") throw new TypeError("Promise-only storage.get");
              return Promise.resolve({ homepage_data: structuredClone(storeData) });
            },
            set(obj, extra) {
              if (typeof extra === "function") throw new TypeError("Promise-only storage.set");
              setCalls += 1;
              if (obj.homepage_data) storeData = structuredClone(obj.homepage_data);
              return Promise.resolve();
            },
          },
        },
        tabs: {
          create(_opts, extra) {
            if (typeof extra === "function") throw new TypeError("Promise-only tabs.create");
            return Promise.resolve({ id: 91 });
          },
        },
      };

      await import(`../src/js/background.js?case=promise_${Date.now()}`);
      assert.equal(listeners.length, 1);

      const dispatch = (msg, sender = {}) =>
        new Promise((resolve) => {
          listeners[0](msg, sender, resolve);
        });

      const [r1, r2] = await Promise.all([
        dispatch(
          { type: "homepage_add_bookmark_to_folder", folderId: "fld_work" },
          { tab: { url: "https://one.example/", title: "One" } },
        ),
        dispatch(
          { type: "homepage_add_bookmark_to_folder", folderId: "fld_work" },
          { tab: { url: "https://two.example/", title: "Two" } },
        ),
      ]);
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.equal(setCalls, 2);
      assert.equal(storeData.nodes.fld_work.children.length, 3);

      // 2) Chrome 回调模式：tabs.create 触发 runtime.lastError 时必须消费并如实失败
      delete globalThis.browser;
      const chromeListeners = [];
      globalThis.chrome = {
        runtime: {
          lastError: null,
          onMessage: { addListener: (fn) => chromeListeners.push(fn) },
        },
        storage: {
          local: {
            get(_keys, cb) {
              cb({});
            },
          },
        },
        tabs: {
          query(_q, cb) {
            cb([]);
          },
          create(_opts, cb) {
            globalThis.chrome.runtime.lastError = { message: "Tab creation blocked" };
            cb(undefined);
            globalThis.chrome.runtime.lastError = null;
          },
        },
      };
      await import(`../src/js/background.js?case=chrome_${Date.now()}`);
      const openErr = await new Promise((resolve) => {
        chromeListeners[0](
          { type: "homepage_open_bookmark", url: "https://target.example/", settings: { openMode: "new" } },
          {},
          resolve,
        );
      });
      assert.equal(openErr.ok, false);
      assert.equal(openErr.error, "Tab creation blocked");
      assert.equal(globalThis.chrome.runtime.lastError, null);
    } finally {
      if (realChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = realChrome;
      if (realBrowser === undefined) delete globalThis.browser;
      else globalThis.browser = realBrowser;
    }
  });
});
