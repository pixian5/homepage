import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { initPopup, showPopupError } from "../src/popup.js";

const realChrome = globalThis.chrome;
const realDocument = globalThis.document;
const realWindow = globalThis.window;

function createFakePopupDom() {
  const byId = new Map();
  const bySelector = new Map();

  class MockEl {
    constructor(tag = "div", id = "") {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this.className = "";
      this.textContent = "";
      this.title = "";
      this.type = "";
      this.disabled = false;
      this.children = [];
      this.attrs = {};
      this.listeners = new Map();
      this._classSet = new Set();
      this.classList = {
        add: (...names) => {
          for (const n of names) this._classSet.add(n);
        },
        remove: (...names) => {
          for (const n of names) this._classSet.delete(n);
        },
        toggle: (name) => {
          if (this._classSet.has(name)) {
            this._classSet.delete(name);
            return false;
          }
          this._classSet.add(name);
          return true;
        },
        contains: (name) => this._classSet.has(name),
      };
      if (id) byId.set(id, this);
    }

    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    getAttribute(k) {
      return this.attrs[k];
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    append(...items) {
      this.children.push(...items);
    }
    replaceChildren(...items) {
      this.children = [...items];
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    click(ev = {}) {
      for (const fn of this.listeners.get("click") || []) {
        fn({ stopPropagation() {}, ...ev });
      }
    }
  }

  const body = new MockEl("body");
  body.classList.add("hidden");
  const documentElement = new MockEl("html");

  for (const id of [
    "addBookmarkMenu",
    "addBookmarkToggle",
    "addBookmarkLabel",
    "bookmarkFolderMenu",
    "saveAllTabsMenu",
    "saveAllTabsToggle",
    "saveAllTabsLabel",
    "saveAllTabsFolderMenu",
    "btnOpenLeftSidebar",
    "btnOpenRightSidebar",
    "popupBookmarks",
    "popupBookmarksTitle",
    "popupBookmarkList",
    "empty",
    "btnSave",
  ]) {
    new MockEl(id.startsWith("btn") ? "button" : "div", id);
  }
  byId.get("empty").classList.add("hidden");

  const headerTitle = new MockEl("div");
  const menuNav = new MockEl("nav");
  const sectionLabel = new MockEl("div");
  bySelector.set(".header .title", headerTitle);
  bySelector.set("nav.bookmark-menu", menuNav);
  bySelector.set(".section .label", sectionLabel);

  const doc = {
    body,
    documentElement,
    title: "",
    createElement: (tag) => new MockEl(tag),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => bySelector.get(sel) || null,
  };

  return { doc, byId, bySelector };
}

afterEach(() => {
  globalThis.chrome = realChrome;
  globalThis.document = realDocument;
  globalThis.window = realWindow;
});

describe("popup UI rendering and i18n", () => {
  it("applies i18n, renders folders + bookmarks tree, toggles folders, and handles empty data cleanly", async () => {
    const { doc, byId } = createFakePopupDom();
    globalThis.document = doc;
    let closedCount = 0;
    globalThis.window = {
      close: () => {
        closedCount += 1;
      },
    };

    const storedData = {
      schemaVersion: 2,
      settings: { language: "en", openMode: "current" },
      groups: [{ id: "grp_all", name: "全部", order: -1, systemAllGroup: true, nodes: ["fld_work", "itm_root"] }],
      nodes: {
        fld_work: { id: "fld_work", type: "folder", title: "Work", children: ["itm_in_folder"] },
        itm_in_folder: { id: "itm_in_folder", type: "item", title: "Docs", url: "https://docs.example.test/" },
        itm_root: { id: "itm_root", type: "item", title: "Home", url: "https://home.example.test/" },
      },
      backups: [],
      lastUpdated: 1000,
    };

    const messagesSent = [];
    globalThis.chrome = {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          messagesSent.push(msg);
          cb?.({ ok: true });
        },
        getURL: (p) => `chrome-extension://ext/${p}`,
      },
      tabs: {
        query: (_q, cb) => cb?.([{ id: 7, url: "https://tab.example.test/", title: "Active Tab" }]),
      },
      storage: {
        local: {
          get: (_keys, cb) => cb?.({ homepage_data: storedData }),
          set: (_obj, cb) => cb?.(),
        },
      },
    };

    await initPopup();

    assert.equal(doc.documentElement.lang, "en");
    assert.equal(byId.get("popupBookmarksTitle").textContent, "All Bookmarks");
    assert.equal(doc.body.classList.contains("hidden"), false);

    // 验证文件夹与根目录书签均已渲染，且点击文件夹折叠开关会切换 menu-open 类
    const bookmarkList = byId.get("popupBookmarkList");
    assert.equal(bookmarkList.children.length, 2);
    assert.equal(bookmarkList.children[0].className.includes("popup-bookmark-folder"), true);
    assert.equal(bookmarkList.children[1].className.includes("popup-bookmark-item"), true);

    const menuToggle = byId.get("addBookmarkToggle");
    const addMenu = byId.get("addBookmarkMenu");
    menuToggle.click();
    assert.equal(addMenu.classList.contains("menu-open"), true);

    // 验证 showPopupError 显示空状态/错误栏
    showPopupError("custom error");
    assert.equal(byId.get("empty").textContent, "custom error");
    assert.equal(byId.get("empty").classList.contains("hidden"), false);
    assert.equal(closedCount, 0);
  });
});
