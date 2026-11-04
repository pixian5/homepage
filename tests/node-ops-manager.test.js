/**
 * 节点与分组操作管理器（node-ops-manager.js）测试：
 * - 单个与批量删除：级联子树展开、软删除标记、位置记忆、撤销 Toast（含动作回调）；
 * - 精确撤销：按原 index 回插、相对顺序不乱、墓碑与软删标记清理；
 * - 撤销超时自动清除（短 undoTimeoutMs）；
 * - 防御拦截：历史分组禁删、全书签根分组禁删禁改名；
 * - 删除激活分组自动切回根分组（确认弹窗注入）；
 * - moveGroupToIndex 越界钳制与重排；
 * - 容器导航辅助（getCurrentNodes / getPlacementList / removeNodeFromLocation + 时钟推进）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNodeOpsManager } from "../src/js/node-ops-manager.js";

function makeData() {
  return {
    schemaVersion: 1,
    settings: { lastActiveGroupId: "" },
    groups: [
      {
        id: "grp_all",
        name: "全部",
        order: -1,
        nodes: ["itm_1", "fld_a", "itm_2", "fld_b", "itm_3"],
        systemAllGroup: true,
        updatedAt: 1,
        updatedBy: "",
      },
    ],
    nodes: {
      itm_1: { id: "itm_1", type: "item", title: "一", url: "https://1.example.com/", updatedAt: 1, updatedBy: "" },
      itm_2: { id: "itm_2", type: "item", title: "二", url: "https://2.example.com/", updatedAt: 1, updatedBy: "" },
      itm_3: { id: "itm_3", type: "item", title: "三", url: "https://3.example.com/", updatedAt: 1, updatedBy: "" },
      fld_a: {
        id: "fld_a",
        type: "folder",
        title: "夹A",
        children: ["itm_a1", "fld_sub"],
        updatedAt: 1,
        updatedBy: "",
      },
      fld_sub: { id: "fld_sub", type: "folder", title: "子夹", children: ["itm_s1"], updatedAt: 1, updatedBy: "" },
      itm_a1: { id: "itm_a1", type: "item", title: "A1", url: "https://a1.example.com/", updatedAt: 1, updatedBy: "" },
      itm_s1: { id: "itm_s1", type: "item", title: "S1", url: "https://s1.example.com/", updatedAt: 1, updatedBy: "" },
      fld_b: { id: "fld_b", type: "folder", title: "夹B", children: [], updatedAt: 1, updatedBy: "" },
    },
    _syncMeta: { nodeTombstones: {} },
    backups: [],
    lastUpdated: 1,
  };
}

function setup({
  activeGroupId = "grp_all",
  openFolderId = null,
  undoTimeoutMs = 10000,
  confirmResult = true,
  promptResult = null,
} = {}) {
  const state = { activeGroupId, openFolderId };
  const calls = { persists: 0, renders: 0, backups: 0, toasts: [], renames: [] };
  const data = makeData();
  const folderManager = {
    renameFolder: (folderId, newTitle) => {
      calls.renames.push({ folderId, newTitle });
      return true;
    },
  };
  const manager = createNodeOpsManager({
    getData: () => data,
    getState: () => state,
    setActiveGroupId: (id) => {
      state.activeGroupId = id;
      data.settings.lastActiveGroupId = id;
    },
    getRecentItems: () => [],
    pushBackup: () => {
      calls.backups += 1;
      return true;
    },
    queuePersist: () => {
      calls.persists += 1;
    },
    render: () => {
      calls.renders += 1;
    },
    toast: (message, actionLabel, action) => calls.toasts.push({ message, actionLabel, action }),
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    prompt: () => promptResult,
    confirm: () => confirmResult,
    getFolderManager: () => folderManager,
    undoTimeoutMs,
    isRecentGroup: (groupId) => groupId === "__recent__",
  });
  return { manager, data, state, calls };
}

describe("node-ops-manager delete & undo", () => {
  it("deletes a single item with soft-delete mark, placement memory and undo toast", () => {
    const { manager, data, calls } = setup();
    manager.deleteNodes(["itm_2"]);
    // markNodeDeleted 软删 + dedupeData 孤儿 GC：节点实体移除、墓碑保留、撤销集合留存深拷贝
    assert.ok(!data.groups[0].nodes.includes("itm_2"), "引用已移除");
    assert.ok(!("itm_2" in data.nodes), "软删节点被孤儿 GC 清出实体表");
    assert.ok(data._syncMeta.nodeTombstones.itm_2, "墓碑记录（供撤销清理与同步投影）");
    assert.ok(manager.getPendingDeletion().deletedNodes.itm_2, "撤销集合留存删除前实体");
    assert.equal(calls.persists, 1);
    assert.equal(calls.renders, 1);
    assert.equal(calls.backups, 1, "删除前手动备份");
    const toastCall = calls.toasts[0];
    assert.match(toastCall.message, /delete\.deletedCount.*1/);
    assert.equal(toastCall.actionLabel, "delete.undo");
    assert.equal(typeof toastCall.action, "function", "撤销动作回调");
    assert.ok(manager.getPendingDeletion(), "撤销状态挂起");
  });

  it("cascades subtree deletion for folders with nested children", () => {
    const { manager, data } = setup();
    manager.deleteNodes(["fld_a"]);
    // 级联：fld_sub / itm_a1 / itm_s1 全部软删并被孤儿 GC 清出
    for (const id of ["fld_a", "fld_sub", "itm_a1", "itm_s1"]) {
      assert.ok(!(id in data.nodes), `${id} 被移除`);
      assert.ok(data._syncMeta.nodeTombstones[id], `${id} 墓碑`);
    }
    // 未涉及的节点不受影响
    assert.ok("itm_1" in data.nodes);
    assert.ok("fld_b" in data.nodes);
    assert.deepEqual(
      data.groups[0].nodes,
      ["itm_1", "itm_2", "fld_b", "itm_3"],
      "根列表仅移除 fld_a 本身（ itm_2 等非子树节点保留原位）",
    );
    assert.equal(manager.getPendingDeletion().ids.length, 4, "撤销集合含全部级联节点");
  });

  it("restores at the original positions preserving relative order and clearing tombstones", () => {
    const { manager, data } = setup();
    manager.deleteNodes(["itm_2", "itm_3"]);
    assert.deepEqual(data.groups[0].nodes, ["itm_1", "fld_a", "fld_b"]);
    manager.undoDelete();
    assert.deepEqual(
      data.groups[0].nodes,
      ["itm_1", "fld_a", "itm_2", "fld_b", "itm_3"],
      "按原 index 精确回插，还原出删除前的完整顺序",
    );
    for (const id of ["itm_2", "itm_3"]) {
      assert.ok(!data.nodes[id].deletedAt, `${id} 软删清除`);
      assert.ok(!data._syncMeta.nodeTombstones[id], `${id} 墓碑清除`);
    }
    assert.equal(manager.getPendingDeletion(), null, "撤销状态清空");
    assert.ok("itm_2" in data.nodes && "itm_3" in data.nodes, "实体恢复");
  });

  it("restores folder subtree placements (folder + nested item)", () => {
    const { manager, data } = setup();
    manager.deleteNodes(["fld_a"]);
    assert.deepEqual(data.groups[0].nodes, ["itm_1", "itm_2", "fld_b", "itm_3"]);
    manager.undoDelete();
    assert.deepEqual(data.groups[0].nodes, ["itm_1", "fld_a", "itm_2", "fld_b", "itm_3"], "文件夹回原位");
    assert.deepEqual(data.nodes.fld_a.children, ["itm_a1", "fld_sub"], "内部结构完整恢复");
    assert.deepEqual(data.nodes.fld_sub.children, ["itm_s1"]);
  });

  it("clears the pending undo after the timeout", async () => {
    const { manager } = setup({ undoTimeoutMs: 20 });
    manager.deleteNodes(["itm_1"]);
    assert.ok(manager.getPendingDeletion());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(manager.getPendingDeletion(), null, "超时自动清除");
    // 超时后撤销无效
    assert.equal(manager.undoDelete(), false);
  });

  it("refuses deletion in the read-only recent group", () => {
    const { manager, data, calls } = setup({ activeGroupId: "__recent__" });
    manager.deleteNodes(["itm_1"]);
    assert.ok("itm_1" in data.nodes, "历史分组节点不受影响");
    assert.equal(calls.persists, 0);
    assert.equal(calls.toasts.length, 0);
  });
});

describe("node-ops-manager group ops", () => {
  it("refuses renaming or deleting the all-bookmarks root group", () => {
    const { manager, data, calls } = setup({ promptResult: "新名字" });
    manager.renameGroup(data.groups[0]);
    manager.deleteGroup(data.groups[0]);
    assert.equal(calls.renames.length, 0, "根分组不可改名");
    assert.equal(calls.persists, 0, "根分组不可删除");
    assert.equal(calls.toasts.length, 0);
  });

  it("canceling the confirm dialog aborts group deletion", () => {
    const { manager, data, calls } = setup({ confirmResult: false });
    manager.deleteGroup(data.nodes.fld_a);
    assert.ok(!data.nodes.fld_a.deletedAt);
    assert.equal(calls.persists, 0);
  });

  it("deleting the active group switches back to the root group", () => {
    const { manager, data, state, calls } = setup({ activeGroupId: "fld_a" });
    manager.deleteGroup(data.nodes.fld_a);
    assert.equal(state.activeGroupId, "grp_all", "激活切回根分组");
    assert.equal(data.settings.lastActiveGroupId, "grp_all");
    assert.ok(!("fld_a" in data.nodes), "级联删除执行（实体被 GC）");
    assert.equal(calls.persists, 1);
  });

  it("renames via prompt and delegates to the folder manager", () => {
    const { manager, data, calls } = setup({ promptResult: "新标题" });
    manager.renameGroup(data.nodes.fld_a);
    assert.deepEqual(calls.renames, [{ folderId: "fld_a", newTitle: "新标题" }]);
    // 取消 prompt 不改名
    const cancelled = setup({ promptResult: null });
    cancelled.manager.renameGroup(cancelled.data.nodes.fld_a);
    assert.equal(cancelled.calls.renames.length, 0);
  });

  it("moveGroupToIndex clamps out-of-range indices and reorders", () => {
    const { manager, data } = setup();
    // 越界大索引：钳到最后一个文件夹之后（插入位按 visible 文件夹列表计算）
    manager.moveGroupToIndex("fld_a", 999);
    assert.deepEqual(data.groups[0].nodes, ["itm_1", "itm_2", "fld_b", "fld_a", "itm_3"]);
    // 负索引钳制到 0：移到第一个文件夹之前
    manager.moveGroupToIndex("fld_a", -5);
    assert.deepEqual(data.groups[0].nodes, ["itm_1", "itm_2", "fld_a", "fld_b", "itm_3"]);
    // index 1 越过最后一个文件夹：仍插到最后一个文件夹之后（此处已在其后，顺序不变）
    manager.moveGroupToIndex("fld_b", 1);
    assert.deepEqual(data.groups[0].nodes, ["itm_1", "itm_2", "fld_a", "fld_b", "itm_3"]);
    // 根分组拒绝移动；非根列表节点拒绝
    const before = [...data.groups[0].nodes];
    manager.moveGroupToIndex("grp_all", 0);
    manager.moveGroupToIndex("itm_1", 0);
    assert.deepEqual(data.groups[0].nodes, before);
  });
});

describe("node-ops-manager container helpers", () => {
  it("getCurrentNodes returns the active group list and honors open folders", () => {
    const { manager, state } = setup({ activeGroupId: "grp_all" });
    assert.deepEqual(
      manager.getCurrentNodes().map((node) => node.id),
      ["itm_1", "fld_a", "itm_2", "fld_b", "itm_3"],
    );
    state.openFolderId = "fld_a";
    assert.deepEqual(
      manager.getCurrentNodes().map((node) => node.id),
      ["itm_a1", "fld_sub"],
      "打开文件夹时返回其子节点",
    );
    state.openFolderId = null;
    state.activeGroupId = "__recent__";
    assert.deepEqual(manager.getCurrentNodes(), [], "历史分组返回最近条目（注入空）");
  });

  it("getActiveGroup falls back to root for unknown ids", () => {
    const { manager } = setup({ activeGroupId: "nope" });
    assert.equal(manager.getActiveGroup().id, "grp_all");
  });

  it("removeNodeFromLocation strips references everywhere and bumps clocks", () => {
    const { manager, data } = setup();
    const clockBefore = data.groups[0].updatedAt;
    manager.removeNodeFromLocation("itm_s1");
    assert.deepEqual(data.nodes.fld_sub.children, [], "文件夹内引用移除");
    assert.ok(data.nodes.fld_sub.updatedAt >= clockBefore, "容器时钟推进");
    manager.removeNodeFromLocation("itm_1");
    assert.ok(!data.groups[0].nodes.includes("itm_1"));
    assert.equal(data.nodes.fld_sub.updatedBy, "", "投影时补设备 ID 的空占位");
  });

  it("getPlacementList / setPlacementList operate on nodes or children arrays", () => {
    const { manager, data } = setup();
    assert.deepEqual(manager.getPlacementList(data.groups[0]).length, 5);
    assert.deepEqual(manager.getPlacementList(data.nodes.fld_a), ["itm_a1", "fld_sub"]);
    manager.setPlacementList(data.nodes.fld_a, ["fld_sub", "itm_a1"]);
    assert.deepEqual(data.nodes.fld_a.children, ["fld_sub", "itm_a1"]);
    assert.deepEqual(manager.getPlacementList(null), [], "空容器安全");
  });
});
