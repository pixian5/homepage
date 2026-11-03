/**
 * 批量选择管理器（selection-manager.js）测试（轻量 DOM Mock）：
 * - 批量模式激活/退出与控件更新（全选按钮可见性、批量按钮文案切换）；
 * - 多选集合：单选切换、Shift 范围选、selectTile 显式设置、retainOnly 过滤、全选；
 * - 框选：阈值判定（小位移不算拖框）、矩形几何命中多卡片、结束后的样式刷新；
 * - 批量删除：未激活先激活、空选退出、有选中调用 deleteNodes 并清空；
 * - 历史分组禁批量；空白点击清除；consumeBlankClickSuppress 单次吞掉。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSelectionManager } from "../src/js/selection-manager.js";

function fakeEl(id, { classes = new Set() } = {}) {
  const listeners = new Map();
  return {
    id,
    classes,
    style: {},
    dataset: {},
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn({ preventDefault: () => {}, ...event });
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
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    closest: () => null,
    appendChild: () => {},
    removeChild: () => {},
    remove: () => {},
  };
}

function setup({ activeGroupId = "grp_all" } = {}) {
  const calls = { deletes: [], toasts: [] };
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const tiles = nodes.map((node) => {
    const tile = fakeEl(node.id);
    tile.dataset.id = node.id;
    return tile;
  });
  const grid = { id: "grid", tiles, listeners: new Map() };
  grid.addEventListener = (type, fn) => {
    if (!grid.listeners.has(type)) grid.listeners.set(type, []);
    grid.listeners.get(type).push(fn);
  };
  const main = fakeEl("main");
  const byId = new Map([
    ["btnSelectAll", fakeEl("btnSelectAll")],
    ["btnBatchDelete", fakeEl("btnBatchDelete")],
    ["btnFolderBatchDelete", fakeEl("btnFolderBatchDelete")],
    ["grid", grid],
    ["folderGrid", fakeEl("folderGrid")],
  ]);
  // Node 无原生 document：先建立最小骨架再注入按 id 查找
  if (typeof globalThis.document === "undefined" || !globalThis.document) {
    globalThis.document = { addEventListener: () => {} };
  }
  const docListeners = new Map();
  globalThis.document = {
    ...globalThis.document,
    getElementById: (id) => byId.get(id) || null,
    createElement: () => fakeEl("selection-box"),
    body: fakeEl("body"),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };
  const manager = createSelectionManager({
    getState: () => ({ activeGroupId, openFolderId: null }),
    getNodes: () => nodes,
    getGrid: () => grid,
    getMain: () => main,
    deleteNodes: (ids) => calls.deletes.push(ids),
    toast: (message, kind) => calls.toasts.push({ message, kind }),
    t: (key) => key,
    isRecentGroup: (groupId) => groupId === "__recent__",
    qsa: (sel, root) => (sel === ".tile" ? root.tiles || [] : []),
  });
  return { manager, calls, grid, main, byId, tiles, docListeners };
}

describe("selection-manager mode & set operations", () => {
  it("activates batch mode with toast and updates controls", () => {
    const { manager, calls, byId } = setup();
    assert.equal(manager.isBatchModeActive(), false);
    manager.executeBatchDelete(); // 未激活 → 激活
    assert.equal(manager.isBatchModeActive(), true);
    assert.deepEqual(calls.toasts, [{ message: "selection.modeEnabled", kind: undefined }]);
    assert.ok(!byId.get("btnSelectAll").classes.has("hidden"), "全选按钮可见");
    assert.equal(byId.get("btnBatchDelete").textContent, "context.delete");

    manager.toggleBatchMode(false);
    assert.equal(manager.isBatchModeActive(), false);
    manager.updateControls();
    assert.equal(byId.get("btnBatchDelete").textContent, "toolbar.batchDelete");
  });

  it("toggles, range-selects, and filters the selection set", () => {
    const { manager } = setup();
    manager.toggleBatchMode(true);
    manager.toggleTileSelection("a", 0, false);
    manager.toggleTileSelection("b", 1, false);
    assert.deepEqual(manager.getSelectedIds().sort(), ["a", "b"]);
    manager.toggleTileSelection("a", 0, false); // 反选移除
    assert.deepEqual(manager.getSelectedIds(), ["b"]);
    manager.toggleTileSelection("c", 2, true); // Shift 范围：反选 a 后锚点回到 0，范围 0..2 带回 a
    assert.deepEqual(manager.getSelectedIds().sort(), ["a", "b", "c"]);
    manager.selectTile("d", true);
    assert.deepEqual(manager.getSelectedIds().sort(), ["a", "b", "c", "d"]);
    manager.retainOnly(new Set(["c", "d", "ghost"]));
    assert.deepEqual(manager.getSelectedIds().sort(), ["c", "d"], "只保留仍存在的节点");
    manager.clearSelection();
    assert.deepEqual(manager.getSelectedIds(), []);
    assert.equal(manager.isBatchModeActive(), false, "clearSelection 同时退出批量模式");
  });

  it("selects all visible tiles in the current grid", () => {
    const { manager, tiles } = setup();
    manager.toggleBatchMode(true);
    manager.selectAll();
    assert.deepEqual(manager.getSelectedIds().sort(), ["a", "b", "c", "d"]);
    assert.ok(
      tiles.every((tile) => tile.classes.has("selected")),
      "卡片选中样式刷新",
    );
  });
});

describe("selection-manager box select", () => {
  it("starts, drags past threshold, and hits tiles geometrically on release", () => {
    const setupRefs = setup();
    const { manager, grid, tiles } = setupRefs;
    manager.toggleBatchMode(true);
    manager.bindBoxSelectEvents();
    const { docListeners } = setupRefs;
    // mousedown 在网格空白处（closest(".tile") 为 null）
    grid.listeners.get("mousedown")[0]({
      button: 0,
      clientX: 10,
      clientY: 10,
      target: { closest: () => null },
      preventDefault: () => {},
    });
    assert.equal(manager.isBoxSelecting(), true);
    // 小位移（1px）不构成拖框；大位移（300px）才命中
    for (const fn of docListeners.get("mousemove")) fn({ clientX: 11, clientY: 11 });
    for (const fn of docListeners.get("mousemove")) fn({ clientX: 300, clientY: 300 });
    // mouseup 触发几何命中（全部卡片矩形 0..100 与框 10..300 相交）
    for (const fn of docListeners.get("mouseup")) fn({ clientX: 300, clientY: 300, preventDefault: () => {} });
    assert.deepEqual(manager.getSelectedIds().sort(), ["a", "b", "c", "d"]);
    assert.ok(
      tiles.every((tile) => tile.classes.has("selected")),
      "框选后卡片选中样式刷新",
    );
    // 框选结束后的第一次点击被吞（suppress），第二次正常
    assert.equal(manager.consumeBlankClickSuppress(), true, "框选后的下一次点击应被吞掉");
    assert.equal(manager.consumeBlankClickSuppress(), false);
  });
});

describe("selection-manager batch delete & guards", () => {
  it("deletes the selected ids via deleteNodes and clears the mode", () => {
    const { manager, calls } = setup();
    manager.toggleBatchMode(true);
    manager.selectTile("a", true);
    manager.selectTile("b", true);
    manager.executeBatchDelete();
    assert.deepEqual(calls.deletes, [["a", "b"]]);
    assert.deepEqual(manager.getSelectedIds(), []);
    assert.equal(manager.isBatchModeActive(), false);
  });

  it("exits the mode without deleting when nothing is selected", () => {
    const { manager, calls } = setup();
    manager.toggleBatchMode(true);
    manager.executeBatchDelete();
    assert.equal(calls.deletes.length, 0, "空选不得触发删除");
    assert.equal(manager.isBatchModeActive(), false, "空选直接退出批量模式");
  });

  it("refuses batch operations in the read-only recent group", () => {
    const { manager, calls } = setup({ activeGroupId: "__recent__" });
    manager.executeBatchDelete();
    assert.deepEqual(calls.toasts, [{ message: "history.batchDeleteDisabled", kind: "warning" }]);
    assert.equal(manager.isBatchModeActive(), false);
    assert.equal(calls.deletes.length, 0);
  });

  it("clears selection on blank click outside tiles", () => {
    const { manager, main } = setup();
    manager.bindBlankClickClear();
    manager.toggleBatchMode(true);
    manager.selectTile("a", true);
    main.dispatch("click", { target: { closest: () => null } });
    assert.deepEqual(manager.getSelectedIds(), [], "空白点击清除选择");
    assert.equal(manager.isBatchModeActive(), false);
    // 点击卡片本身不清除
    manager.toggleBatchMode(true);
    manager.selectTile("a", true);
    main.dispatch("click", { target: { closest: (sel) => (sel === ".tile" ? {} : null) } });
    assert.deepEqual(manager.getSelectedIds(), ["a"], "点在卡片上不清除选择");
  });
});
