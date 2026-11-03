/**
 * 拖拽与重排管理器（drag-manager.js）测试（轻量 DOM Mock）：
 * - dragstart 设置拖拽状态与 effectAllowed，dragend 清理并移除高亮；
 * - dragover 给目标卡片加 .drop-target 指示高亮（自身除外），dragleave 清除；
 * - drop 到普通卡片非图标区 → moveNodeInList 排序插入（含 placementClock 推进）；
 * - drop 到文件夹卡片图标区 → moveNodeToFolder（移入已有文件夹）；
 * - drop 到普通卡片图标区 → createFolderNode 合并成组（两项移入新文件夹）；
 * - 历史分组（只读）禁投放保护；cleanupDragState 清状态与高亮；
 * - 侧栏分组按钮：卡片投放走 canMoveNodeToFolder 校验，分组拖拽走 moveGroupBefore。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canMoveNodeToFolder, moveNodeInList, moveNodeToFolder } from "../src/js/data-utils.js";
import { createDragManager } from "../src/js/drag-manager.js";

/** 轻量元素替身：类名集合 + 事件监听 + 可配置矩形 */
function fakeEl({ rect = { left: 0, top: 0, width: 100, height: 100 }, dataset = {} } = {}) {
  const el = {
    classes: new Set(),
    dataset,
    children: [],
    listeners: new Map(),
    scrollTop: 0,
    parentElement: null,
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    getClientRects: () => [rect],
    get classList() {
      return {
        add: (...names) => {
          for (const n of names) this.classes.add(n);
        },
        remove: (...names) => {
          for (const n of names) this.classes.delete(n);
        },
        toggle: (n, force) =>
          force === undefined
            ? this.classes.has(n)
              ? this.classes.delete(n)
              : this.classes.add(n)
            : force
              ? this.classes.add(n)
              : this.classes.delete(n),
        contains: (n) => this.classes.has(n),
      };
    },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of this.listeners.get(type) || []) {
        fn({ preventDefault: () => {}, stopPropagation: () => {}, clientX: 0, clientY: 0, dataTransfer: {}, ...event });
      }
    },
  };
  return el;
}

/** tile 结构替身：tile > tile-icon + tile-title */
function fakeTile(id, { iconRect, tileRect } = {}) {
  const tile = fakeEl({ rect: tileRect || { left: 0, top: 0, width: 120, height: 120 }, dataset: { id } });
  const icon = fakeEl({ rect: iconRect || { left: 10, top: 10, width: 40, height: 40 } });
  tile.iconEl = icon;
  return tile;
}

/** 组装 drag-manager 与最小依赖（记录调用供断言） */
function setup({ activeGroupId = "grp_all", openFolderId = null } = {}) {
  const calls = {
    persists: 0,
    renders: 0,
    backups: 0,
    toasts: [],
    movedToFolder: [],
    createdFolders: [],
    groupMoves: [],
    touched: [],
  };
  const data = {
    nodes: {
      a: { id: "a", type: "item", title: "A", url: "https://a.example.com/" },
      b: { id: "b", type: "item", title: "B", url: "https://b.example.com/" },
      fld_1: { id: "fld_1", type: "folder", title: "文件夹1", children: [] },
    },
    groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["a", "b", "fld_1"], systemAllGroup: true }],
  };
  const gridTiles = [];
  const grid = fakeEl({});
  grid.tiles = gridTiles;

  const deps = {
    getData: () => data,
    getState: () => ({ activeGroupId, openFolderId }),
    getActiveGroup: () => data.groups[0],
    getFolderPlacementContainer: (folderId) => data.nodes[folderId],
    getPlacementList: (container) => container.nodes || container.children,
    setPlacementList: (container, list) => {
      if (Array.isArray(container.nodes)) container.nodes = list;
      else container.children = list;
    },
    touchPlacementContainer: (container) => calls.touched.push(container.id || "?"),
    removeNodeFromLocation: (id) => {
      for (const group of data.groups) group.nodes = group.nodes.filter((nid) => nid !== id);
      for (const node of Object.values(data.nodes)) {
        if (Array.isArray(node.children)) node.children = node.children.filter((nid) => nid !== id);
      }
    },
    moveNodeInList: (list, id, index) => moveNodeInList(list, id, index),
    // 用真实 data-utils 实现（全位置移除 + 追加），包装记录调用
    moveNodeToFolder: (d, nodeId, folderId) => {
      const ok = moveNodeToFolder(d, nodeId, folderId);
      if (ok) calls.movedToFolder.push({ nodeId, folderId });
      return ok;
    },
    canMoveNodeToFolder,
    createFolderNode: (childIds) => {
      const folder = {
        id: `fld_new_${calls.createdFolders.length}`,
        type: "folder",
        title: "新文件夹",
        children: childIds,
      };
      calls.createdFolders.push(folder);
      return folder;
    },
    moveGroupToIndex: (groupId, index) => calls.groupMoves.push({ groupId, index }),
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
    isRecentGroup: (groupId) => groupId === "__recent__",
    isAllBookmarksGroup: (id) => id === "grp_all",
    getRootFolderIds: () => data.groups[0].nodes.filter((id) => data.nodes[id]?.type === "folder"),
    qs: (sel, root) => (sel === ".tile-icon" ? root?.iconEl || null : null),
    qsa: (sel, root) =>
      sel === ".tile" ? (root === globalThis.document ? gridTiles : root === grid ? gridTiles : []) : [],
  };
  // 让 drag-manager 的 document.getElementById("grid") 命中我们的网格
  globalThis.document = {
    getElementById: (id) => (id === "grid" ? grid : null),
    querySelectorAll: (sel) => (sel === ".tile" ? gridTiles : []),
    querySelector: () => null,
  };
  const manager = createDragManager(deps);
  const addTile = (tile) => {
    tile.parentElement = grid;
    gridTiles.push(tile);
    return tile;
  };
  return { manager, data, calls, grid, addTile, deps };
}

describe("drag-manager tile events", () => {
  it("dragstart records state and effectAllowed; dragend clears state and highlight", () => {
    const { manager } = setup();
    const tile = fakeTile("a");
    manager.bindTileDragEvents(tile, { id: "a", type: "item" });

    let effect = "";
    tile.dispatch("dragstart", {
      dataTransfer: {
        set effectAllowed(v) {
          effect = v;
        },
        get effectAllowed() {
          return effect;
        },
      },
    });
    assert.equal(manager.getDragState()?.id, "a");
    assert.equal(effect, "move");

    tile.dispatch("dragend");
    assert.equal(manager.getDragState(), null);
  });

  it("dragover highlights the target tile (not itself) and dragleave clears it", () => {
    const { manager, addTile } = setup();
    const a = addTile(fakeTile("a"));
    const b = addTile(fakeTile("b"));
    manager.bindTileDragEvents(a, { id: "a", type: "item" });
    manager.bindTileDragEvents(b, { id: "b", type: "item" });

    manager.setDragState({ id: "a", fromFolder: null });
    b.dispatch("dragover");
    assert.ok(b.classes.has("drop-target"), "目标卡片出现投放高亮（指示器）");
    // 自身拖过自身不高亮
    a.dispatch("dragover");
    assert.ok(!a.classes.has("drop-target"), "拖拽源自身不显示高亮");
    b.dispatch("dragleave");
    assert.ok(!b.classes.has("drop-target"));
    manager.cleanupDragState();
    assert.equal(manager.getDragState(), null);
  });
});

describe("drag-manager drop intents", () => {
  it("drop beside a tile reorders via moveNodeInList and bumps clocks", () => {
    const { manager, data, calls, addTile } = setup();
    const a = addTile(fakeTile("a", { tileRect: { left: 0, top: 0, width: 120, height: 120 } }));
    const b = addTile(fakeTile("b", { tileRect: { left: 120, top: 0, width: 120, height: 120 } }));
    manager.bindTileDragEvents(a, { id: "a", type: "item" });
    manager.bindTileDragEvents(b, { id: "b", type: "item" });

    manager.setDragState({ id: "b", fromFolder: null });
    // 投放在 a 的右半区（x=90 > a 中点 60）→ b 移到 a 之后
    a.dispatch("drop", { clientX: 90, clientY: 80 });
    assert.equal(manager.getDragState(), null, "drop 后清理拖拽状态");
    assert.deepEqual(
      data.groups[0].nodes,
      ["a", "b", "fld_1"].slice(0, 0).concat(["a", "b", "fld_1"]),
      "顺序不变时也要幂等",
    );
    // 顺序本来就是 a,b → moveNodeInList 返回原数组 → 不触发持久化
    assert.equal(calls.persists, 0);
    assert.equal(calls.renders, 0);

    // 再从 b 拖到 a 左半区（x=20）→ b 移到最前
    manager.setDragState({ id: "b", fromFolder: null });
    a.dispatch("drop", { clientX: 20, clientY: 80 });
    assert.deepEqual(data.groups[0].nodes, ["b", "a", "fld_1"]);
    assert.equal(calls.persists, 1, "真实重排触发持久化");
    assert.equal(calls.renders, 1);
    assert.ok(calls.touched.includes("grp_all"), "容器结构时钟推进");
    assert.ok(calls.backups >= 1);
  });

  it("drop on a folder tile's icon moves the node into that folder", () => {
    const { manager, data, calls, addTile } = setup();
    const a = addTile(fakeTile("a", { iconRect: { left: 10, top: 10, width: 40, height: 40 } }));
    const fld = addTile(fakeTile("fld_1", { iconRect: { left: 10, top: 10, width: 40, height: 40 } }));
    manager.bindTileDragEvents(a, { id: "a", type: "item" });
    manager.bindTileDragEvents(fld, { id: "fld_1", type: "folder" });

    manager.setDragState({ id: "a", fromFolder: null });
    // 投放在文件夹图标中心 (30, 30) → 经 moveNodeToFolder 移入
    fld.dispatch("drop", { clientX: 30, clientY: 30 });
    assert.deepEqual(data.nodes.fld_1.children, ["a"]);
    assert.ok(!data.groups[0].nodes.includes("a"), "源位置引用被移除");
    assert.equal(calls.persists, 1);
    assert.equal(calls.renders, 1);
    assert.ok(calls.toasts.includes("folder.added"));
    assert.ok(calls.touched.includes("fld_1"), "目标文件夹结构时钟推进");
  });

  it("drop on a plain tile's icon creates a folder with both nodes", () => {
    const { manager, data, calls, addTile } = setup();
    const a = addTile(fakeTile("a", { iconRect: { left: 10, top: 10, width: 40, height: 40 } }));
    const b = addTile(fakeTile("b", { iconRect: { left: 10, top: 10, width: 40, height: 40 } }));
    manager.bindTileDragEvents(a, { id: "a", type: "item" });
    manager.bindTileDragEvents(b, { id: "b", type: "item" });

    manager.setDragState({ id: "b", fromFolder: null });
    // 投放在 a 的图标中心 → 合并成组
    a.dispatch("drop", { clientX: 30, clientY: 30 });
    assert.equal(calls.createdFolders.length, 1, "创建一个新文件夹");
    const folder = calls.createdFolders[0];
    assert.deepEqual(folder.children, ["a", "b"], "目标在前、源在后");
    assert.equal(data.nodes[folder.id], folder);
    assert.deepEqual(data.groups[0].nodes, [folder.id, "fld_1"], "新文件夹插到原目标位置");
    assert.ok(calls.toasts.includes("folder.created"));
    assert.equal(calls.persists, 1);
  });

  it("refuses any drop in the read-only recent group", () => {
    const { manager, calls, addTile } = setup({ activeGroupId: "__recent__" });
    const a = addTile(fakeTile("a"));
    manager.bindTileDragEvents(a, { id: "a", type: "item" });
    manager.setDragState({ id: "b", fromFolder: null });
    a.dispatch("drop", { clientX: 30, clientY: 30 });
    assert.equal(calls.persists, 0, "历史分组禁止投放");
    assert.equal(calls.createdFolders.length, 0);
  });
});

describe("drag-manager sidebar & group tabs", () => {
  it("sidebar drop moves the node into the folder after validation", () => {
    const { manager, calls, deps } = setup();
    const btn = fakeEl({});
    manager.bindSidebarFolderEvents(btn, { groupId: "fld_1" });

    manager.setDragState({ id: "a", fromFolder: null });
    btn.dispatch("drop");
    assert.deepEqual(calls.movedToFolder, [{ nodeId: "a", folderId: "fld_1" }]);
    assert.equal(manager.getDragState(), null, "投放后清理拖拽状态");

    // 校验不通过（如目标是自身的子孙）时不落任何变更
    deps.canMoveNodeToFolder = () => false;
    manager.setDragState({ id: "a", fromFolder: null });
    btn.dispatch("drop");
    assert.equal(calls.movedToFolder.length, 1, "校验失败不再移动");
  });

  it("sidebar drop reorders groups via moveGroupBefore", () => {
    const { manager, calls } = setup();
    const btn = fakeEl({});
    manager.bindSidebarFolderEvents(btn, { groupId: "fld_1" });

    manager.setDraggingGroupId("fld_2");
    btn.dispatch("drop");
    assert.deepEqual(calls.groupMoves, [{ groupId: "fld_2", index: 0 }], "移到目标分组 fld_1（根列表 index 0）之前");
    manager.setDraggingGroupId(null);
  });

  it("group tabs drop at edges moves the group to head or tail", () => {
    const { manager, calls } = setup();
    const tabs = fakeEl({ rect: { left: 0, top: 0, width: 200, height: 400 } });
    manager.bindGroupTabsEvents(tabs);

    manager.setDraggingGroupId("fld_1");
    tabs.dispatch("drop", { clientY: 10 });
    tabs.dispatch("drop", { clientY: 390 });
    assert.deepEqual(calls.groupMoves, [
      { groupId: "fld_1", index: 0 },
      { groupId: "fld_1", index: 1 },
    ]);
    manager.cleanupDragState();
  });

  it("grid empty-area drop reorders by nearest geometry", () => {
    const { manager, data, calls, grid, addTile } = setup();
    const a = addTile(fakeTile("a", { tileRect: { left: 0, top: 0, width: 100, height: 100 } }));
    const b = addTile(fakeTile("b", { tileRect: { left: 100, top: 0, width: 100, height: 100 } }));
    manager.bindTileDragEvents(a, { id: "a", type: "item" });
    manager.bindTileDragEvents(b, { id: "b", type: "item" });
    manager.bindGridDropEvents(grid, {
      getContainer: () => data.groups[0],
      enabled: () => true,
    });

    manager.setDragState({ id: "b", fromFolder: null });
    grid.dispatch("drop", { clientX: 10, clientY: 50 });
    assert.deepEqual(data.groups[0].nodes, ["b", "a", "fld_1"], "空白区左端 → 移到最前");
    assert.equal(calls.persists, 1);
    assert.equal(manager.getDragState(), null);

    // enabled=false（如历史分组/文件夹上下文不符）：直接清理不落盘
    manager.setDragState({ id: "b", fromFolder: null });
    // 复用同一 manager，绑定一个禁用网格
    const otherGrid = fakeEl({});
    manager.bindGridDropEvents(otherGrid, { getContainer: () => data.groups[0], enabled: () => false });
    otherGrid.dispatch("drop", { clientX: 10, clientY: 50 });
    assert.equal(calls.persists, 1, "禁用时不得再次持久化");
  });
});
