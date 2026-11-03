/**
 * 核心网格渲染器（grid-renderer.js）测试（轻量 DOM Mock）：
 * - 卡片元素：item 与 folder 的 class/属性（gridcell/aria-label/徽标/选中态）；
 * - manager 绑定装配：icon/drag/touch/tooltip 全部按预期收到调用与参数；
 * - 交互：点击普通卡片走 openModeMgr.openCard、文件夹走 openFolder、
 *   批量模式转 selection、点击（触摸抑制）忽略、中键后台、键盘 Enter；
 * - 空状态：历史分组按 API 状态切换文案（error/missing/fallback/empty/有数据隐藏）、
 *   普通分组无节点显示引导、emptyHintDisabled 隐藏；
 * - 渲染批次：新批次启动后旧批次中断（不追加 tile）；uniqueNodes 去重。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGridRenderer, uniqueNodes } from "../src/js/grid-renderer.js";

function fakeEl(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  const children = [];
  const el = {
    classes,
    children,
    dataset: {},
    attrs: {},
    style: { setProperty: () => {} },
    listeners,
    draggable: false,
    tabIndex: -1,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || [])
        fn({ preventDefault: () => {}, shiftKey: false, button: 0, ...event });
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
    appendChild(child) {
      children.push(child);
      return child;
    },
    replaceChildren() {
      children.length = 0;
    },
    getBoundingClientRect: () => ({ width: 1200, left: 0, top: 0, right: 1200, bottom: 800, height: 800 }),
    get clientWidth() {
      return 1200;
    },
    /** className 字符串赋值与 classList 集合同步（渲染器两种方式都用） */
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/)) {
        if (name) classes.add(name);
      }
    },
    get className() {
      return [...classes].join(" ");
    },
  };
  el.tag = tag;
  return el;
}

function setup({
  activeGroupId = "grp_all",
  openFolderId = null,
  nodes = {},
  groupNodes = [],
  recentItems = [],
  emptyHintDisabled = false,
  historyStatus = "ok",
} = {}) {
  const state = { activeGroupId, openFolderId };
  const data = {
    settings: { gridDensity: "standard", lastTileSize: 150, keyboardNav: true, emptyHintDisabled },
    groups: [{ id: "grp_all", name: "全部", order: -1, nodes: groupNodes, systemAllGroup: true }],
    nodes,
  };
  const calls = {
    iconBinds: [],
    dragBinds: [],
    touchBinds: [],
    tooltip: [],
    openCards: [],
    openUrls: [],
    openedFolders: [],
    contextMenus: [],
    toasts: [],
    selected: [],
  };
  const managers = {
    iconManager: {
      bindTileIcon: (_img, node, opts) => calls.iconBinds.push({ node: node.id, hasCache: !!opts.cache }),
    },
    dragManager: { bindTileDragEvents: (_tile, node) => calls.dragBinds.push(node.id) },
    touchDrag: {
      bindTileTouchEvents: (_tile, node) => calls.touchBinds.push(node.id),
      isClickSuppressed: () => false,
    },
    openModeMgr: { openCard: (url, e) => calls.openCards.push({ url, button: e?.button }) },
    selectionMgr: {
      has: (id) => id === "itm_sel",
      isBatchModeActive: () => false,
      toggleTileSelection: (id, idx, range) => calls.selected.push({ id, idx, range }),
    },
    tooltipMgr: {
      scheduleShow: (text, x, y) => calls.tooltip.push({ text, x, y }),
      hideTooltip: () => calls.tooltip.push("hide"),
    },
    historyManager: { status: historyStatus },
  };
  const elements = {
    grid: fakeEl(),
    folderGrid: fakeEl(),
    emptyState: fakeEl(),
  };
  const emptyTitle = fakeEl();
  const emptyDesc = fakeEl();
  const emptyCheck = fakeEl();
  let batchMode = false;
  let clickSuppressed = false;
  managers.selectionMgr.isBatchModeActive = () => batchMode;
  managers.touchDrag.isClickSuppressed = () => clickSuppressed;

  globalThis.window = globalThis.window || {};
  globalThis.window.innerWidth = 1280;
  globalThis.window.innerHeight = 800;
  globalThis.window.matchMedia = () => ({ matches: false });
  if (!globalThis.document) globalThis.document = {};
  globalThis.document.createElement = (tag) => fakeEl(tag);
  globalThis.getComputedStyle = () => ({ paddingLeft: "0px", paddingRight: "0px" });

  const renderer = createGridRenderer({
    getElements: () => elements,
    getData: () => data,
    getState: () => state,
    getCurrentNodes: () => groupNodes.map((id) => nodes[id]).filter(Boolean),
    getRecentItems: () => recentItems,
    loadIconCache: async () => ({ cached: true }),
    ...managers,
    openFolder: (id) => calls.openedFolders.push(id),
    openUrl: (url) => calls.openUrls.push(url),
    openContextMenu: (x, y, node) => calls.contextMenus.push({ x, y, id: node.id }),
    toast: (message, kind) => calls.toasts.push({ message, kind }),
    t: (key) => key,
    isRecentGroup: (groupId) => groupId === "__recent__",
    qs: (sel, root) => {
      if (root !== elements.emptyState) return null;
      if (sel === ".empty-title") return emptyTitle;
      if (sel === ".empty-desc") return emptyDesc;
      if (sel === ".empty-check") return emptyCheck;
      return null;
    },
  });
  return {
    renderer,
    elements,
    emptyState: elements.emptyState,
    calls,
    data,
    emptyTitle,
    emptyDesc,
    emptyCheck,
    setBatchMode: (v) => (batchMode = v),
    setClickSuppressed: (v) => (clickSuppressed = v),
  };
}

const NODES = {
  itm_a: { id: "itm_a", type: "item", title: "站点A", url: "https://a.example.com/" },
  itm_sel: { id: "itm_sel", type: "item", title: "已选", url: "https://s.example.com/" },
  fld_x: { id: "fld_x", type: "folder", title: "文件夹", children: ["itm_a"] },
  itm_bad: { id: "itm_bad", type: "item", title: "坏", url: "chrome://settings/" },
};

describe("grid-renderer createTileElement", () => {
  it("builds an item tile with gridcell role, aria-label and no badge", () => {
    const { renderer } = setup();
    const tile = renderer.createTileElement(NODES.itm_a, 0, 1, {});
    assert.equal(tile.classes.has("tile"), true);
    assert.equal(tile.dataset.id, "itm_a");
    assert.equal(tile.attrs.role, "gridcell");
    assert.equal(tile.attrs["aria-label"], "站点A https://a.example.com/");
    assert.equal(tile.tabIndex, 0);
    assert.ok(tile.draggable);
    const badge = tile.children.find((child) => child.classes.has("tile-badge"));
    assert.equal(badge, undefined, "普通卡片无徽标");
    const title = tile.children.find((child) => child.classes.has("tile-title"));
    assert.equal(title.textContent, "站点A");
  });

  it("builds a folder tile with count badge and folder aria-label", () => {
    const { renderer } = setup();
    const tile = renderer.createTileElement(NODES.fld_x, 1, 1, {});
    assert.equal(tile.attrs["aria-label"], "文件夹tile.folderSuffix");
    const badge = tile.children.find((child) => child.classes.has("tile-badge"));
    assert.equal(badge.textContent, "1", "徽标显示子项数");
  });

  it("marks preselected tiles and wires every manager", () => {
    const { renderer, calls } = setup();
    renderer.createTileElement(NODES.itm_sel, 0, 1, { cached: true });
    assert.ok(calls.iconBinds[0].hasCache, "图标绑定收到批次共享缓存");
    assert.deepEqual(calls.dragBinds, ["itm_sel"], "drag-manager 绑定");
    assert.deepEqual(calls.touchBinds, ["itm_sel"], "touch-drag-manager 绑定");
    const tile = renderer.createTileElement(NODES.itm_sel, 0, 1, {});
    assert.ok(tile.classes.has("selected"), "选中态样式");
  });

  it("routes interactions: item open / folder open / batch select / suppressed click", () => {
    const { renderer, calls, setBatchMode, setClickSuppressed } = setup();
    const itemTile = renderer.createTileElement(NODES.itm_a, 0, 1, {});
    itemTile.dispatch("click", {});
    assert.deepEqual(calls.openCards, [{ url: "https://a.example.com/", button: 0 }]);

    // 非法 URL：toast 拒绝
    const badTile = renderer.createTileElement(NODES.itm_bad, 1, 1, {});
    badTile.dispatch("click", {});
    assert.equal(calls.openCards.length, 1);
    assert.equal(calls.toasts[0].kind, "error");

    const folderTile = renderer.createTileElement(NODES.fld_x, 2, 1, {});
    folderTile.dispatch("click", {});
    assert.deepEqual(calls.openedFolders, ["fld_x"]);

    // 中键后台 → openCard（带 button=1）
    itemTile.dispatch("auxclick", { button: 1 });
    assert.deepEqual(calls.openCards[1], { url: "https://a.example.com/", button: 1 });

    // 批量模式：点击转为选择
    setBatchMode(true);
    itemTile.dispatch("click", { shiftKey: true });
    assert.deepEqual(calls.selected, [{ id: "itm_a", idx: 0, range: true }]);

    // 触摸拖拽后的抑制点击：忽略
    setBatchMode(false);
    setClickSuppressed(true);
    itemTile.dispatch("click", {});
    assert.equal(calls.openCards.length, 2, "抑制点击不开卡");

    // 键盘 Enter：普通打开
    setClickSuppressed(false);
    itemTile.dispatch("keydown", { key: "Enter" });
    assert.deepEqual(calls.openUrls, ["https://a.example.com/"]);

    // 右键菜单
    itemTile.dispatch("contextmenu", { clientX: 5, clientY: 6 });
    assert.deepEqual(calls.contextMenus, [{ x: 5, y: 6, id: "itm_a" }]);

    // 悬停 tooltip 文案（文件夹带后缀 / 卡片带 URL）
    folderTile.dispatch("mouseenter", { clientX: 1, clientY: 2 });
    assert.equal(calls.tooltip[0].text, "文件夹tile.folderSuffix");
    folderTile.dispatch("mouseleave");
    assert.equal(calls.tooltip[1], "hide");
  });
});

describe("grid-renderer renderGrid", () => {
  it("mounts tiles in order with layout vars applied", async () => {
    const { renderer, elements } = setup({
      nodes: NODES,
      groupNodes: ["itm_a", "fld_x", "itm_sel"],
    });
    await renderer.renderGrid();
    assert.equal(elements.grid.children.length, 3);
    assert.deepEqual(
      elements.grid.children.map((tile) => tile.dataset.id),
      ["itm_a", "fld_x", "itm_sel"],
    );
    assert.ok(elements.grid.style.gridTemplateColumns.startsWith("repeat("), "列模板已应用");
  });

  it("aborts a stale render batch when a new one starts", async () => {
    const { renderer, elements } = setup({
      nodes: NODES,
      groupNodes: ["itm_a", "fld_x", "itm_sel"],
    });
    const first = renderer.renderGrid();
    const second = renderer.renderGrid();
    await Promise.all([first, second]);
    assert.equal(elements.grid.children.length, 3, "旧批次中断，只有最新批次的结果");
  });
});

describe("grid-renderer updateEmptyState", () => {
  it("shows the normal empty hint only when the group has no nodes", () => {
    const { renderer, elements, emptyTitle } = setup({ nodes: NODES, groupNodes: [] });
    renderer.updateEmptyState();
    assert.ok(!elements.emptyState.classes.has("hidden"), "无节点显示引导");
    assert.equal(emptyTitle.textContent, "empty.title");

    const withNodes = setup({ nodes: NODES, groupNodes: ["itm_a"] });
    withNodes.renderer.updateEmptyState();
    assert.ok(withNodes.elements.emptyState.classes.has("hidden"), "有节点隐藏");

    const hintOff = setup({ nodes: NODES, groupNodes: [], emptyHintDisabled: true });
    hintOff.renderer.updateEmptyState();
    assert.ok(hintOff.elements.emptyState.classes.has("hidden"), "关闭提示后隐藏");
    assert.equal(hintOff.data.settings.emptyHintDisabled, true);
  });

  it("switches history empty copy by api status and hides when data exists", () => {
    const mk = (status, items) =>
      setup({ activeGroupId: "__recent__", historyStatus: status, recentItems: items, groupNodes: [] });

    const err = mk("error", []);
    err.renderer.updateEmptyState();
    assert.equal(err.emptyTitle.textContent, "history.unavailable.title");
    assert.equal(err.emptyDesc.textContent, "history.unavailable.desc");
    assert.ok(!err.emptyState.classes.has("hidden"));

    const missing = mk("missing", []);
    missing.renderer.updateEmptyState();
    assert.equal(missing.emptyTitle.textContent, "history.unavailable.title");

    const fallback = mk("fallback", []);
    fallback.renderer.updateEmptyState();
    assert.equal(fallback.emptyDesc.textContent, "history.fallback.desc");

    const okEmpty = mk("ok", []);
    okEmpty.renderer.updateEmptyState();
    assert.equal(okEmpty.emptyTitle.textContent, "history.empty.title");

    const withData = mk("ok", [{ id: "recent_0", url: "https://x.example.com/" }]);
    withData.renderer.updateEmptyState();
    assert.ok(withData.emptyState.classes.has("hidden"), "有历史数据时隐藏空状态");
  });
});

describe("uniqueNodes (pure)", () => {
  it("dedupes by id and drops id-less entries", () => {
    const nodes = [{ id: "a" }, { id: "a" }, { title: "no-id" }, { id: "b" }];
    assert.deepEqual(
      uniqueNodes(nodes).map((node) => node.id),
      ["a", "b"],
    );
    assert.deepEqual(uniqueNodes(null), []);
  });
});
