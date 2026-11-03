/**
 * 文件夹覆盖层管理器（folder-manager.js）测试（轻量 DOM Mock）：
 * - 展开覆盖层：inert 解除、aria-hidden=false、标题更新、渲染与聚焦；
 * - 关闭：嵌套文件夹回退父级（标题与状态保持打开）、顶层关闭恢复 inert/aria、
 *   覆盖层内焦点交还设置按钮；
 * - 重命名：非法输入（不存在/非文件夹/空白/未变化）拒绝，合法修改推进字段时钟并持久化；
 * - 解散：子项依序平填回分组根原位置 / 父文件夹原位置 / 活动分组兜底，
 *   folder 节点删除标记、时钟推进与 toast。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFolderManager } from "../src/js/folder-manager.js";

function fakeEl() {
  const listeners = new Map();
  const classes = new Set(["hidden"]);
  const attrs = { inert: "" };
  return {
    classes,
    attrs,
    dataset: {},
    textContent: "",
    children: [],
    focused: false,
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn({ preventDefault: () => {}, target: this, ...event });
    },
    classList: {
      add: (...names) => {
        for (const n of names) classes.add(n);
      },
      remove: (...names) => {
        for (const n of names) classes.delete(n);
      },
      toggle: (n, force) => {
        if (force === undefined) {
          if (classes.has(n)) classes.delete(n);
          else classes.add(n);
        } else if (force) classes.add(n);
        else classes.delete(n);
      },
      contains: (n) => classes.has(n),
    },
    setAttribute(name, value) {
      if (name === "inert") {
        if (value === "") attrs.inert = "";
        else delete attrs.inert;
        return;
      }
      attrs[name] = value;
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    focus() {
      this.focused = true;
    },
    contains() {
      return false;
    },
    closest: () => null,
  };
}

function setup({ activeGroupId = "grp_all" } = {}) {
  const state = { openFolderId: null };
  const calls = { renders: 0, persists: 0, backups: 0, stamps: [], toasts: [], deleted: [], touched: [] };
  const data = {
    nodes: {
      fld_root: { id: "fld_root", type: "folder", title: "工作", children: ["itm_1", "fld_sub"] },
      fld_sub: { id: "fld_sub", type: "folder", title: "子夹", children: ["itm_2"] },
      itm_1: { id: "itm_1", type: "item", title: "一", url: "https://1.example.com/" },
      itm_2: { id: "itm_2", type: "item", title: "二", url: "https://2.example.com/" },
    },
    groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["fld_root"], systemAllGroup: true }],
    settings: {},
  };
  const elements = {
    folderOverlay: fakeEl(),
    folderTitle: fakeEl(),
    folderGrid: fakeEl(),
    btnCloseFolder: fakeEl(),
    btnFolderDissolve: fakeEl(),
    btnSettings: fakeEl(),
  };
  let activeElement = null;
  const manager = createFolderManager({
    getElements: () => elements,
    getData: () => data,
    getOpenFolderId: () => state.openFolderId,
    setOpenFolderId: (id) => {
      state.openFolderId = id;
    },
    getActiveGroup: () => data.groups.find((group) => group.id === activeGroupId) || data.groups[0],
    getPlacementList: (container) => container.nodes || container.children,
    setPlacementList: (container, list) => {
      if (Array.isArray(container.nodes)) container.nodes = list;
      else container.children = list;
    },
    touchPlacementContainer: (container) => calls.touched.push(container.id || "?"),
    markNodeDeleted: (d, id) => {
      d.nodes[id].deletedAt = Date.now();
      calls.deleted.push(id);
    },
    stampNodeFieldChanges: (node, changes) => calls.stamps.push({ id: node.id, changes }),
    pushBackup: () => {
      calls.backups += 1;
    },
    queuePersist: () => {
      calls.persists += 1;
    },
    render: () => {
      calls.renders += 1;
    },
    toast: (message) => calls.toasts.push(message),
    t: (key) => key,
    getActiveElement: () => activeElement,
  });
  return { manager, data, state, elements, calls, setActiveElement: (el) => (activeElement = el) };
}

describe("folder-manager overlay lifecycle", () => {
  it("opens the overlay: inert off, aria visible, title set, grid focused", () => {
    const { manager, state, elements, calls } = setup();
    manager.openFolder("fld_root");
    assert.equal(state.openFolderId, "fld_root");
    assert.ok(manager.isFolderOpen());
    assert.equal(manager.getOpenFolderId(), "fld_root");
    assert.ok(!elements.folderOverlay.classes.has("hidden"));
    assert.ok(!("inert" in elements.folderOverlay.attrs), "inert 解除");
    assert.equal(elements.folderOverlay.attrs["aria-hidden"], "false");
    assert.equal(elements.folderTitle.textContent, "工作");
    assert.ok(elements.folderGrid.focused, "网格获得焦点");
    assert.equal(calls.renders, 1);
  });

  it("closes nested folders by stepping back to the parent folder", () => {
    const { manager, state, elements } = setup();
    manager.openFolder("fld_root");
    manager.openFolder("fld_sub");
    manager.closeFolder();
    assert.equal(state.openFolderId, "fld_root", "嵌套文件夹回退到父级");
    assert.equal(elements.folderTitle.textContent, "工作");
    assert.ok(manager.isFolderOpen(), "仍在覆盖层中");

    manager.closeFolder();
    assert.equal(state.openFolderId, null, "顶层关闭");
    assert.ok(elements.folderOverlay.classes.has("hidden"));
    assert.ok("inert" in elements.folderOverlay.attrs, "恢复 inert");
    assert.equal(elements.folderOverlay.attrs["aria-hidden"], "true");
  });

  it("returns focus to the settings button when focus was inside the overlay", () => {
    const { manager, elements, setActiveElement } = setup();
    manager.openFolder("fld_root");
    // 模拟焦点在覆盖层内
    elements.folderOverlay.contains = () => true;
    setActiveElement(elements.folderGrid);
    manager.closeFolder();
    assert.ok(elements.btnSettings.focused, "焦点交还设置按钮");
  });

  it("binds overlay events: back button, dissolve and blank-click close", () => {
    const { manager, state, elements, data, calls } = setup();
    manager.bindOverlayEvents();
    manager.openFolder("fld_root");

    // 空白点击（非 tile / 非 header）关闭
    elements.folderOverlay.dispatch("click", { target: { closest: () => null } });
    assert.equal(state.openFolderId, null);

    // 解散按钮：先关闭再解散，子项回填分组根原位置
    manager.openFolder("fld_root");
    elements.btnFolderDissolve.dispatch("click");
    assert.equal(state.openFolderId, null);
    assert.deepEqual(data.groups[0].nodes, ["itm_1", "fld_sub"], "子项依序平填回原位置");
    assert.ok(data.nodes.fld_root.deletedAt, "folder 节点标记删除");
    assert.deepEqual(calls.deleted, ["fld_root"]);
    assert.ok(calls.toasts.includes("folder.dissolved"));
    assert.ok(calls.backups >= 1);
    assert.ok(calls.persists >= 1);
  });
});

describe("folder-manager rename", () => {
  it("validates input and advances the field clock on success", () => {
    const { manager, data, calls } = setup();
    assert.equal(manager.renameFolder("missing", "x"), false);
    assert.equal(manager.renameFolder("itm_1", "x"), false, "非文件夹拒绝");
    assert.equal(manager.renameFolder("fld_root", "   "), false, "空白拒绝");
    assert.equal(manager.renameFolder("fld_root", "工作"), false, "未变化拒绝");
    assert.equal(calls.stamps.length, 0, "拒绝路径不推进时钟");
    assert.equal(calls.persists, 0);

    assert.equal(manager.renameFolder("fld_root", "新工作"), true);
    assert.equal(data.nodes.fld_root.title, "新工作");
    assert.deepEqual(calls.stamps, [{ id: "fld_root", changes: { titleChanged: true } }], "字段时钟推进");
    assert.equal(calls.persists, 1);
    assert.equal(calls.renders, 1);
  });
});

describe("folder-manager dismiss", () => {
  it("splices children back into a parent folder at the original position", () => {
    const { manager, data, calls } = setup();
    // fld_root 位于分组根；把 fld_sub 视为目标：它内部 itm_2 应回填到 fld_root 原位
    assert.equal(manager.dismissFolder("fld_sub"), true);
    assert.deepEqual(data.nodes.fld_root.children, ["itm_1", "itm_2"], "子项平填父文件夹原位置");
    assert.ok(data.nodes.fld_sub.deletedAt);
    assert.ok(calls.touched.includes("fld_root"));
  });

  it("falls back to the active group when the folder is unreferenced", () => {
    const { manager, data } = setup();
    // 孤儿文件夹（不在任何容器里）
    data.nodes.fld_orphan = { id: "fld_orphan", type: "folder", title: "孤儿", children: ["itm_9"] };
    data.nodes.itm_9 = { id: "itm_9", type: "item", title: "九" };
    assert.equal(manager.dismissFolder("fld_orphan"), true);
    assert.ok(data.groups[0].nodes.includes("itm_9"), "兜底平铺到活动分组");
  });

  it("refuses to dismiss non-folders", () => {
    const { manager } = setup();
    assert.equal(manager.dismissFolder("itm_1"), false);
  });
});
