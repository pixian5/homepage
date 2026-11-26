import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCommandEntries, createCommandPalette, filterCommandEntries } from "../src/js/command-palette.js";
import { defaultData } from "../src/js/storage.js";

function createFakePaletteDom() {
  const docListeners = new Map();
  const byId = new Map();

  class El {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this._id = "";
      this._className = "";
      this.value = "";
      this.textContent = "";
      this.placeholder = "";
      this.autocomplete = "";
      this.type = "";
      this.children = [];
      this.listeners = new Map();
      this.attributes = {};
      this.focused = false;
    }

    get id() {
      return this._id;
    }
    set id(val) {
      this._id = String(val || "");
      if (this._id) byId.set(this._id, this);
    }
    get className() {
      return this._className;
    }
    set className(val) {
      this._className = String(val || "");
    }
    get classList() {
      const set = () => new Set(this._className.split(/\s+/).filter(Boolean));
      return {
        add: (...names) => {
          const s = set();
          for (const n of names) s.add(n);
          this._className = [...s].join(" ");
        },
        remove: (...names) => {
          const s = set();
          for (const n of names) s.delete(n);
          this._className = [...s].join(" ");
        },
        contains: (name) => set().has(name),
      };
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    }
    getAttribute(k) {
      return this.attributes[k];
    }
    appendChild(child) {
      this.children.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    }
    replaceChildren(...items) {
      this.children = [...items];
    }
    querySelector(sel) {
      if (sel.startsWith("#")) return byId.get(sel.slice(1)) || null;
      return null;
    }
    addEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    dispatch(type, event = {}) {
      for (const fn of [...(this.listeners.get(type) || [])]) {
        fn({ preventDefault() {}, target: this, ...event });
      }
    }
    focus() {
      this.focused = true;
      doc.activeElement = this;
    }
  }

  const body = new El("body");
  const triggerBtn = new El("button");
  const doc = {
    body,
    activeElement: triggerBtn,
    createElement: (tag) => new El(tag),
    getElementById: (id) => byId.get(id) || null,
    addEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type) || [];
      docListeners.set(
        type,
        list.filter((f) => f !== fn),
      );
    },
    dispatchKeydown(ev) {
      for (const fn of [...(docListeners.get("keydown") || [])]) {
        fn({ preventDefault() {}, ...ev });
      }
    },
  };
  return { doc, byId, triggerBtn };
}

function makeSampleData() {
  const data = defaultData();
  data.nodes.fld_dev = { id: "fld_dev", type: "folder", title: "研发工具", children: ["itm_cq", "itm_del"] };
  data.nodes.itm_cq = { id: "itm_cq", type: "item", title: "重庆地图", url: "https://map.cq.example/nav" };
  data.nodes.itm_del = {
    id: "itm_del",
    type: "item",
    title: "已删节点",
    url: "https://deleted.example",
    deletedAt: 1000,
  };
  data.nodes.itm_root = { id: "itm_root", type: "item", title: "GitHub 仓库", url: "https://github.com/pixian5" };
  data.groups[0].nodes.push("fld_dev", "itm_root");
  return data;
}

describe("command-palette", () => {
  it("builds entries across nested folders, skips deleted nodes, and supports pinyin & command prefix", () => {
    const data = makeSampleData();
    const entries = buildCommandEntries(data, {
      actions: [{ id: "action:add", title: "新增书签", keywords: "add shortcut", run: () => {} }],
    });

    assert.equal(
      entries.some((e) => e.id === "itm_del"),
      false,
    );
    assert.ok(entries.some((e) => e.kind === "folder" && e.id === "fld_dev"));
    const cq = entries.find((e) => e.id === "itm_cq");
    assert.ok(cq);
    assert.match(cq.subtitle, /研发工具/);

    const pyHit = filterCommandEntries(entries, "zqdt"); // 多音字 重庆地图 zqdt/cqdt 均应命中
    assert.ok(pyHit.some((e) => e.id === "itm_cq"));

    const cmdOnly = filterCommandEntries(entries, "> add");
    assert.equal(cmdOnly.length, 1);
    assert.equal(cmdOnly[0].id, "action:add");
  });

  it("opens on Cmd/Ctrl+K, navigates with keyboard, executes bookmark/folder/action, and restores focus", () => {
    const { doc, byId, triggerBtn } = createFakePaletteDom();
    const data = makeSampleData();
    const openedBookmarks = [];
    const navigatedFolders = [];
    let actionCount = 0;

    const palette = createCommandPalette({
      doc,
      getData: () => data,
      t: (k) => k,
      openBookmark: (node) => openedBookmarks.push(node.id),
      navigateToFolder: (target) => navigatedFolders.push(target),
      getActions: () => [
        {
          id: "action:sync",
          title: "Sync Now",
          keywords: "sync",
          run: () => {
            actionCount += 1;
          },
        },
      ],
    });
    palette.bindGlobalShortcut();

    // Ctrl+K 打开命令面板并聚焦输入框
    doc.dispatchKeydown({ key: "k", ctrlKey: true });
    assert.equal(palette.isOpen(), true);
    const input = byId.get("commandPaletteInput");
    assert.equal(input.focused, true);

    // 过滤 ">" 动作并回车触发
    input.value = "> sync";
    input.dispatch("input");
    assert.equal(palette.getVisibleEntries().length, 1);
    input.dispatch("keydown", { key: "Enter" });
    assert.equal(actionCount, 1);
    assert.equal(palette.isOpen(), false);
    assert.equal(doc.activeElement, triggerBtn);

    // Cmd+K 再次打开，按 ArrowDown 选中书签并回车打开
    doc.dispatchKeydown({ key: "k", metaKey: true });
    input.value = "cqdt";
    input.dispatch("input");
    input.dispatch("keydown", { key: "Enter" });
    assert.deepEqual(openedBookmarks, ["itm_cq"]);

    // 打开后选文件夹导航
    palette.open();
    input.value = "研发";
    input.dispatch("input");
    const folderIdx = palette.getVisibleEntries().findIndex((e) => e.kind === "folder");
    assert.ok(folderIdx >= 0);
    for (let i = 0; i < folderIdx; i += 1) {
      input.dispatch("keydown", { key: "ArrowDown" });
    }
    input.dispatch("keydown", { key: "Enter" });
    assert.deepEqual(navigatedFolders, [{ id: "fld_dev", rootGroupId: "grp_all" }]);

    // Escape 关闭并阻断事件冒泡
    palette.open();
    assert.equal(palette.isOpen(), true);
    let stopped = false;
    input.dispatch("keydown", {
      key: "Escape",
      stopPropagation: () => {
        stopped = true;
      },
    });
    assert.equal(palette.isOpen(), false);
    assert.equal(stopped, true);
  });
});
