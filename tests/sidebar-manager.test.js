/**
 * 侧边栏管理器（sidebar-manager.js）测试（轻量 DOM Mock）：
 * - 折叠/隐藏状态机：body 类名切换、折叠按钮文案、aria-label 与 data-label 同步、
 *   折叠时文本清空但可读名保留；
 * - renderGroups：历史入口高亮、全部分组固定根 + 根文件夹 Tab、激活态类名、
 *   折叠时 Tab 文本清空、快捷序号 data-short；
 * - 切组：点击更新激活分组 / lastActiveGroupId / 持久化 / 重渲染；触摸抑制时不切组；
 *   右键菜单与 drag/touch 绑定回调透传。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSidebarManager } from "../src/js/sidebar-manager.js";

function fakeEl(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  const el = {
    tag,
    classes,
    dataset: {},
    attrs: {},
    textContent: "",
    children: [],
    draggable: false,
    listeners,
    /** className 字符串赋值与 classList 集合同步（模块两种方式都用） */
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/)) {
        if (name) classes.add(name);
      }
    },
    get className() {
      return [...classes].join(" ");
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn({ preventDefault: () => {}, clientX: 0, clientY: 0, ...event });
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
      this.attrs[name] = value;
    },
    getAttribute(name) {
      return this.attrs[name];
    },
    appendChild(child) {
      this.children.push(child);
    },
    replaceChildren() {
      this.children = [];
    },
  };
  return el;
}

function setup({ activeGroupId = "grp_all", sidebarCollapsed = false } = {}) {
  const calls = { persists: 0, renders: 0, groupContextMenus: [], sidebarBinds: [], touchBinds: [] };
  const state = { activeGroupId, openFolderId: null };
  const data = {
    settings: { sidebarCollapsed, sidebarHidden: false, lastActiveGroupId: "" },
    groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["fld_a", "fld_b"], systemAllGroup: true }],
    nodes: {
      fld_a: { id: "fld_a", type: "folder", title: "工作", children: [] },
      fld_b: { id: "fld_b", type: "folder", title: "生活", children: [] },
      itm: { id: "itm", type: "item", title: "卡片" },
    },
  };
  const elements = {
    groupTabs: fakeEl(),
    recentTab: fakeEl("button"),
    btnToggleSidebar: fakeEl("button"),
  };
  const body = fakeEl("body");
  let clickSuppressed = false;
  const manager = createSidebarManager({
    getElements: () => elements,
    getData: () => data,
    getState: () => state,
    setActiveGroup: (groupId) => {
      state.activeGroupId = groupId;
    },
    closeFolder: () => {
      state.openFolderId = null;
    },
    persist: () => {
      calls.persists += 1;
    },
    render: () => {
      calls.renders += 1;
    },
    t: (key) => key,
    isRecentGroup: (groupId) => groupId === "__recent__",
    isAllBookmarksGroup: (group) => group?.systemAllGroup === true,
    isClickSuppressed: () => clickSuppressed,
    bindSidebarFolderEvents: (btn, opts) => calls.sidebarBinds.push(opts),
    bindGroupTouchEvents: (btn, opts) => calls.touchBinds.push(opts),
    openGroupContextMenu: (x, y, group) => calls.groupContextMenus.push({ x, y, group }),
    qsa: (sel, root) => (sel === ".group-tab" ? root.children.filter((child) => child.classes.has("group-tab")) : []),
    getDocumentBody: () => body,
    createButton: () => fakeEl("button"),
  });
  return { manager, data, state, elements, body, calls, setSuppressed: (v) => (clickSuppressed = v) };
}

describe("sidebar-manager state machine", () => {
  it("toggles body classes and the collapse button label", () => {
    const { manager, data, body, elements } = setup();
    manager.applySidebarState();
    assert.ok(!body.classes.has("sidebar-collapsed"));
    assert.equal(elements.btnToggleSidebar.textContent, "sidebar.collapse");

    data.settings.sidebarCollapsed = true;
    data.settings.sidebarHidden = true;
    manager.applySidebarState();
    assert.ok(body.classes.has("sidebar-collapsed"));
    assert.ok(body.classes.has("sidebar-hidden"));
    assert.equal(elements.btnToggleSidebar.textContent, "sidebar.expand");
  });

  it("keeps aria-label while clearing visible text when collapsed", () => {
    const { manager, data, elements } = setup();
    data.settings.sidebarCollapsed = false;
    manager.renderGroups();
    const workTab = elements.groupTabs.children.find((btn) => btn.dataset.groupId === "fld_a");
    assert.equal(workTab.textContent, "工作");
    assert.equal(workTab.attrs["aria-label"], "工作");
    assert.equal(workTab.dataset.label, "工作");

    data.settings.sidebarCollapsed = true;
    manager.syncSidebarTabLabels();
    assert.equal(workTab.textContent, "", "折叠时清空可见文本");
    assert.equal(workTab.attrs["aria-label"], "工作", "可读名保留");
    assert.equal(elements.recentTab.attrs["aria-label"], "sidebar.history", "历史入口同步");
  });
});

describe("sidebar-manager renderGroups", () => {
  it("renders the fixed root plus root folders with active highlight and order hints", () => {
    const { manager, elements, calls } = setup({ activeGroupId: "fld_a" });
    manager.renderGroups();
    const tabs = elements.groupTabs.children;
    assert.equal(tabs.length, 3, "全部 + 工作 + 生活");
    assert.equal(tabs[0].dataset.groupId, "grp_all");
    assert.ok(!tabs[0].draggable, "固定根不可拖拽");
    assert.equal(tabs[0].dataset.short, "1");
    assert.equal(tabs[1].dataset.short, "2");
    assert.ok(tabs[1].draggable, "普通分组可拖拽");
    assert.ok(tabs[1].classes.has("active"), "当前激活分组高亮");
    assert.ok(!tabs[0].classes.has("active"));
    // drag/touch 绑定透传
    assert.equal(calls.sidebarBinds.length, 3);
    assert.equal(calls.touchBinds.length, 3);
    assert.equal(calls.touchBinds[0].disabled, true, "固定根禁触摸拖拽");
  });

  it("highlights the recent tab only in recent mode", () => {
    const { manager, elements } = setup({ activeGroupId: "__recent__" });
    manager.renderGroups();
    assert.ok(elements.recentTab.classes.has("active"));
    const { manager: mgr2, elements: els2 } = setup({ activeGroupId: "grp_all" });
    mgr2.renderGroups();
    assert.ok(!els2.recentTab.classes.has("active"));
  });
});

describe("sidebar-manager group switching", () => {
  it("switches the active group, records lastActive, persists and re-renders", () => {
    const { manager, data, state, elements, calls } = setup();
    manager.renderGroups();
    const workTab = elements.groupTabs.children.find((btn) => btn.dataset.groupId === "fld_a");
    workTab.dispatch("click");
    assert.equal(state.activeGroupId, "fld_a");
    assert.equal(data.settings.lastActiveGroupId, "fld_a");
    assert.equal(calls.persists, 1);
    assert.equal(calls.renders, 1);
  });

  it("does not switch when the click was suppressed right after touch drag", () => {
    const { manager, state, elements, calls, setSuppressed } = setup();
    manager.renderGroups();
    const workTab = elements.groupTabs.children.find((btn) => btn.dataset.groupId === "fld_a");
    setSuppressed(true);
    workTab.dispatch("click");
    assert.equal(state.activeGroupId, "grp_all", "触摸拖拽后的误触不切组");
    assert.equal(calls.persists, 0);
  });

  it("opens the group context menu only for non-root folders", () => {
    const { manager, elements, calls } = setup();
    manager.renderGroups();
    const tabs = elements.groupTabs.children;
    tabs[0].dispatch("contextmenu"); // 固定根
    assert.equal(calls.groupContextMenus.length, 0);
    tabs[1].dispatch("contextmenu"); // 普通分组
    assert.equal(calls.groupContextMenus.length, 1);
    assert.equal(calls.groupContextMenus[0].group.id, "fld_a");
  });
});
