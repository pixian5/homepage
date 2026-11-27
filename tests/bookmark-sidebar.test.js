import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createFakeDom() {
  const byId = new Map();
  const docListeners = new Map();
  let innerHTMLWrites = 0;

  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this.listeners = new Map();
      this.style = {};
      this._id = "";
      this._className = "";
      this._textContent = "";
      this.title = "";
    }

    get id() {
      return this._id;
    }

    set id(v) {
      if (this._id && byId.get(this._id) === this) byId.delete(this._id);
      this._id = String(v || "");
      if (this._id) byId.set(this._id, this);
    }

    get className() {
      return this._className;
    }

    set className(v) {
      this._className = String(v || "");
    }

    get classList() {
      const classes = () => new Set(this._className.split(/\s+/).filter(Boolean));
      return {
        add: (...names) => {
          const set = classes();
          for (const n of names) if (n) set.add(n);
          this._className = [...set].join(" ");
        },
        remove: (...names) => {
          const set = classes();
          for (const n of names) set.delete(n);
          this._className = [...set].join(" ");
        },
        contains: (name) => classes().has(name),
      };
    }

    get textContent() {
      return this._textContent;
    }

    set textContent(v) {
      this._textContent = String(v ?? "");
    }

    set innerHTML(html) {
      innerHTMLWrites += 1;
      this._innerHTML = String(html || "");
      this.children = [];
    }

    get innerHTML() {
      return this._innerHTML || "";
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    }

    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    }

    prepend(node) {
      node.parentNode = this;
      this.children.unshift(node);
      if (node.id) byId.set(node.id, node);
    }

    replaceChildren(...nodes) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      for (const n of nodes) this.appendChild(n);
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
      }
      if (this.id && byId.get(this.id) === this) byId.delete(this.id);
    }

    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === "id") this.id = val;
    }

    getAttribute(name) {
      return this.attributes[name];
    }

    addEventListener(type, fn) {
      const arr = this.listeners.get(type) || [];
      arr.push(fn);
      this.listeners.set(type, arr);
    }

    click() {
      const arr = this.listeners.get("click") || [];
      for (const fn of arr) {
        fn({ stopPropagation() {}, preventDefault() {}, target: this, currentTarget: this });
      }
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
      const steps = selector
        .trim()
        .split(/\s+/)
        .map((part) => part.split(".").filter(Boolean));
      const matchStep = (node, clsList) => clsList.every((cls) => node.classList.contains(cls));
      const collect = (node, stepIdx, out) => {
        for (const child of node.children) {
          if (matchStep(child, steps[stepIdx])) {
            if (stepIdx === steps.length - 1) out.push(child);
            else collect(child, stepIdx + 1, out);
          }
          collect(child, stepIdx, out);
        }
      };
      const out = [];
      collect(this, 0, out);
      return [...new Set(out)];
    }
  }

  const head = new FakeElement("head");
  const documentElement = new FakeElement("html");
  const document = {
    head,
    documentElement,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => byId.get(id) || null,
    addEventListener(type, fn) {
      const arr = docListeners.get(type) || [];
      arr.push(fn);
      docListeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = docListeners.get(type) || [];
      docListeners.set(
        type,
        arr.filter((item) => item !== fn),
      );
    },
    dispatchKeydown(key) {
      for (const fn of [...(docListeners.get("keydown") || [])]) {
        fn({ key });
      }
    },
    listenerCount(type) {
      return (docListeners.get(type) || []).length;
    },
  };
  return { document, getInnerHTMLWrites: () => innerHTMLWrites };
}

async function mountSidebar({ apiImpl }) {
  const code = await readFile(path.join(root, "src/js/bookmark-sidebar.js"), "utf8");
  const { document, getInnerHTMLWrites } = createFakeDom();
  const messageListeners = [];
  const runtimeApi = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        },
      },
      sendMessage: apiImpl,
    },
  };
  const context = vm.createContext({
    document,
    chrome: runtimeApi,
    browser: runtimeApi,
    URL,
    Set,
    setTimeout,
    clearTimeout,
  });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(code, context, { filename: "bookmark-sidebar.js" });
  return {
    document,
    runtimeApi,
    getInnerHTMLWrites,
    dispatchMessage: (msg) => {
      let response = null;
      messageListeners[0](msg, null, (r) => {
        response = r;
      });
      return response;
    },
  };
}

function buildFolderCollisionData(language = "zh-CN") {
  return {
    settings: { language },
    groups: [
      {
        id: "grp_all",
        name: "全部",
        nodes: ["fld_ai", "fld_ai_tools", "fld_dup_1", "fld_dup_2"],
      },
    ],
    nodes: {
      fld_ai: { id: "fld_ai", type: "folder", title: "AI", children: ["itm_ai"] },
      fld_ai_tools: { id: "fld_ai_tools", type: "folder", title: "AI Tools", children: ["itm_tools"] },
      fld_dup_1: { id: "fld_dup_1", type: "folder", title: "Docs", children: ["itm_doc1"] },
      fld_dup_2: { id: "fld_dup_2", type: "folder", title: "Docs", children: ["itm_doc2"] },
      itm_ai: { id: "itm_ai", type: "item", title: "AI Only", url: "https://ai.example/", iconType: "color" },
      itm_tools: {
        id: "itm_tools",
        type: "item",
        title: "Tools Only",
        url: "https://tools.example/",
        iconType: "color",
      },
      itm_doc1: { id: "itm_doc1", type: "item", title: "Doc Alpha", url: "https://alpha.example/", iconType: "color" },
      itm_doc2: { id: "itm_doc2", type: "item", title: "Doc Beta", url: "https://beta.example/", iconType: "color" },
    },
  };
}

describe("bookmark-sidebar filtering, feedback and Escape handling", () => {
  it("filters by ancestor folderId instead of title prefix and isolates same-name folders", async () => {
    const { document, dispatchMessage } = await mountSidebar({
      apiImpl: (_msg, cb) => cb?.({ ok: true }),
    });
    const res = dispatchMessage({
      type: "homepage_open_bookmark_sidebar",
      side: "left",
      data: buildFolderCollisionData("en"),
    });
    assert.equal(res?.ok, true);

    const rootEl = document.getElementById("homepage-bookmark-sidebar-root");
    const leftPanel = rootEl.querySelector(".hp-side.hp-left");
    const folderButtons = leftPanel.querySelector(".hp-folders").querySelectorAll(".hp-folder");

    const aiBtn = folderButtons.find((btn) => btn.textContent === "AI");
    assert.ok(aiBtn);
    aiBtn.click();
    const aiVisibleTitles = leftPanel.querySelectorAll(".hp-item .hp-title").map((el) => el.textContent);
    assert.deepEqual(aiVisibleTitles, ["AI Only"]);

    const docButtons = folderButtons.filter((btn) => btn.textContent === "Docs");
    assert.equal(docButtons.length, 2);
    docButtons[1].click();
    const doc2VisibleTitles = leftPanel.querySelectorAll(".hp-item .hp-title").map((el) => el.textContent);
    assert.deepEqual(doc2VisibleTitles, ["Doc Beta"]);
  });

  it("shows localized saved and saveFailed status across callback & Promise-only runtimes and updates list", async () => {
    let shouldFail = false;
    const sent = [];
    const { document, dispatchMessage } = await mountSidebar({
      apiImpl(msg, extra) {
        if (typeof extra === "function") {
          throw new TypeError("Promise-only sendMessage");
        }
        sent.push(msg);
        if (shouldFail) return Promise.resolve({ ok: false, error: "no_folder" });
        return Promise.resolve({
          ok: true,
          folderId: msg.folderId,
          node: { id: "itm_new", type: "item", title: "Current Page", url: "https://current.example/" },
        });
      },
    });

    dispatchMessage({
      type: "homepage_open_add_bookmark_panel",
      data: buildFolderCollisionData("en"),
    });

    const rootEl = document.getElementById("homepage-bookmark-sidebar-root");
    assert.equal(rootEl.querySelectorAll(".hp-side").length, 1, "只应渲染当前开启一侧，避免双倍 DOM 与图标请求");
    const leftPanel = rootEl.querySelector(".hp-side.hp-left");
    const addTarget = leftPanel.querySelector(".hp-menu-parent .hp-submenu").querySelectorAll(".hp-folder")[1];
    assert.ok(addTarget);

    addTarget.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent[0].type, "homepage_add_bookmark_to_folder");
    assert.equal(sent[0].folderId, "fld_ai");
    const statusEl = leftPanel.querySelector(".hp-status");
    assert.equal(statusEl.textContent, "Saved");
    assert.equal(statusEl.classList.contains("hp-status-ok"), true);
    assert.equal(/[\u4e00-\u9fff]/.test(statusEl.textContent), false);
    assert.equal(
      leftPanel.querySelectorAll(".hp-item .hp-title").some((el) => el.textContent === "Current Page"),
      true,
      "添加书签成功后侧栏当前列表应即时刷新可见",
    );

    shouldFail = true;
    addTarget.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(statusEl.textContent, "Save failed");
    assert.equal(statusEl.classList.contains("hp-status-err"), true);
  });

  it("supports Escape to close sidebar and removes keydown listener cleanly", async () => {
    const { document, dispatchMessage } = await mountSidebar({
      apiImpl: (_msg, cb) => cb?.({ ok: true }),
    });
    dispatchMessage({
      type: "homepage_open_bookmark_sidebar",
      side: "right",
      data: buildFolderCollisionData("ja"),
    });

    assert.ok(document.getElementById("homepage-bookmark-sidebar-root"));
    assert.equal(document.listenerCount("keydown"), 1);

    document.dispatchKeydown("Escape");
    assert.equal(document.getElementById("homepage-bookmark-sidebar-root"), null);
    assert.equal(document.listenerCount("keydown"), 0);
  });

  it("avoids third-party favicon fallback URLs when iconThirdPartyFallback is false", async () => {
    const { document, dispatchMessage } = await mountSidebar({
      apiImpl: (_msg, cb) => cb?.({ ok: true }),
    });
    const data = buildFolderCollisionData("zh-CN");
    data.settings.iconThirdPartyFallback = false;
    data.nodes.itm_ai.iconType = "auto";
    data.nodes.itm_tools.iconType = "remote";
    data.nodes.itm_tools.iconData = "https://www.google.com/s2/favicons?sz=64&domain=tools.example";

    dispatchMessage({
      type: "homepage_open_bookmark_sidebar",
      side: "left",
      data,
    });

    const imgs = document.getElementById("homepage-bookmark-sidebar-root").querySelectorAll(".hp-logo");
    assert.ok(imgs.length >= 2);
    for (const img of imgs) {
      const visited = [img.src];
      while (img.listeners.get("error")?.length && img.parentNode) {
        img.listeners.get("error")[0]();
        if (img.parentNode) visited.push(img.src);
      }
      assert.equal(
        visited.some((url) => url.includes("google.com/s2/favicons") || url.includes("duckduckgo.com")),
        false,
        `隐私开关关闭后不得包含第三方候选：${JSON.stringify(visited)}`,
      );
    }
  });

  it("renders bookmark list items with pure DOM nodes without touching innerHTML (Trusted Types safe)", async () => {
    const { document, getInnerHTMLWrites, dispatchMessage } = await mountSidebar({
      apiImpl: (_msg, cb) => cb?.({ ok: true }),
    });
    dispatchMessage({
      type: "homepage_open_bookmark_sidebar",
      side: "left",
      data: buildFolderCollisionData("zh-CN"),
    });

    assert.equal(getInnerHTMLWrites(), 0);
    const rootEl = document.getElementById("homepage-bookmark-sidebar-root");
    const titles = rootEl.querySelectorAll(".hp-title").map((el) => el.textContent);
    const urls = rootEl.querySelectorAll(".hp-url").map((el) => el.textContent);
    const paths = rootEl.querySelectorAll(".hp-path").map((el) => el.textContent);
    assert.deepEqual(titles, ["AI Only", "Tools Only", "Doc Alpha", "Doc Beta"]);
    assert.deepEqual(urls, [
      "https://ai.example/",
      "https://tools.example/",
      "https://alpha.example/",
      "https://beta.example/",
    ]);
    assert.equal(paths.length, 4);
    assert.ok(paths.every((p) => p.length > 0));
  });
});
