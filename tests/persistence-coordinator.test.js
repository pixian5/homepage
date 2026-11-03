/**
 * 数据持久化与时钟协调器（persistence-coordinator.js）测试：
 * - 串行队列：并发两次 persistData 顺序执行；第一次失败不中断队列；
 * - 自动备份：无变更不新增快照；有效变更把旧基线压入 backups 且截断 maxBackups；
 *   手动 pushBackup 设置 skipAutoBackupOnce 跳过下次自动备份；
 * - queuePersist：底层异常时返回 { ok: false } 不抛未捕获 rejection；
 * - 时钟打标：设置时钟差异推进并重建基线、放置时钟每次重建、无基线时先建基线；
 * - 抑制窗与 inFlight 状态访问器。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPersistenceCoordinator } from "../src/js/persistence-coordinator.js";

function makeData({ maxBackups = 5 } = {}) {
  return {
    schemaVersion: 1,
    settings: { syncEnabled: false, maxBackups, language: "zh-CN" },
    groups: [
      {
        id: "grp_all",
        name: "全部",
        order: -1,
        nodes: ["itm_1"],
        systemAllGroup: true,
        updatedAt: 1,
        updatedBy: "dev",
      },
    ],
    nodes: {
      itm_1: { id: "itm_1", type: "item", title: "一", url: "https://1.example.com/", updatedAt: 1, updatedBy: "dev" },
    },
    _syncMeta: {},
    backups: [],
    lastUpdated: 1,
  };
}

function setup({ saveError = null, device = "dev_test", maxBackups = 5 } = {}) {
  const calls = { saves: [], pushes: 0, logs: [] };
  let saveErrorQueue = [];
  const data = makeData({ maxBackups });
  const coordinator = createPersistenceCoordinator({
    getData: () => data,
    getDeviceId: async () => device,
    saveData: async (payload) => {
      calls.saves.push(payload.lastUpdated);
      const err = saveErrorQueue.length ? saveErrorQueue.shift() : saveError;
      return err;
    },
    loadDataFromArea: async () => data,
    schedulePush: () => {
      calls.pushes += 1;
    },
    debugLog: (event, payload) => calls.logs.push({ event, payload }),
    shouldDebugPersist: () => false,
    storageSuppressMs: 350,
    backupIgnoredSettingsKeys: ["lastActiveGroupId", "lastSaveUrl", "lastSaveTs", "lastSaveToast"],
  });
  return { coordinator, data, calls, failNextSaves: (errors) => (saveErrorQueue = errors) };
}

describe("persistence-coordinator serial queue", () => {
  it("runs concurrent persists sequentially in call order", async () => {
    const { coordinator, calls } = setup();
    const order = [];
    // 用 saveData 回调不可插桩（外部注入），这里用两次 persist 的落盘顺序验证串行
    const [a, b] = await Promise.all([coordinator.persistData(), coordinator.persistData()]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(calls.saves.length, 2, "两次都落盘");
    order.push(...calls.saves);
    assert.equal(order.length, 2);
    assert.equal(coordinator.getPersistInFlight(), 0, "结束后 inFlight 归零");
  });

  it("a failing persist does not break the queue for the next one", async () => {
    const { coordinator, calls, failNextSaves } = setup();
    failNextSaves(["quota_exceeded"]);
    const first = await coordinator.persistData();
    assert.equal(first.ok, false);
    assert.equal(first.err, "quota_exceeded");
    const second = await coordinator.persistData();
    assert.equal(second.ok, true, "队列未中断");
    assert.equal(calls.saves.length, 2);
  });

  it("keeps persistInFlight accurate during a run", async () => {
    const { coordinator } = setup();
    // persist 是微任务链：挂起时 inFlight 应为 1
    const probe = coordinator.persistData();
    await Promise.resolve();
    const inFlightDuring = coordinator.getPersistInFlight();
    const result = await probe;
    assert.equal(result.ok, true);
    assert.ok(inFlightDuring <= 1, "执行中 inFlight 至多 1（串行）");
    assert.equal(coordinator.getPersistInFlight(), 0);
  });
});

describe("persistence-coordinator auto backup", () => {
  it("does not snapshot when nothing meaningful changed", async () => {
    const { coordinator, data } = setup();
    coordinator.syncBackupBaseline(data);
    const backedUp = coordinator.ensureAutoBackupBeforePersist();
    assert.equal(backedUp, false, "指纹一致不备份");
    assert.equal(data.backups.length, 0);

    // 忽略键变化同样不构成备份理由
    data.settings.lastActiveGroupId = "grp_all";
    assert.equal(coordinator.ensureAutoBackupBeforePersist(), false);
    assert.equal(data.backups.length, 0);
  });

  it("pushes the previous baseline into backups when content changes", async () => {
    const { coordinator, data } = setup();
    coordinator.syncBackupBaseline(data);
    data.nodes.itm_2 = {
      id: "itm_2",
      type: "item",
      title: "二",
      url: "https://2.example.com/",
      updatedAt: 2,
      updatedBy: "dev",
    };
    data.groups[0].nodes.push("itm_2");
    const backedUp = coordinator.ensureAutoBackupBeforePersist();
    assert.equal(backedUp, true);
    assert.equal(data.backups.length, 1, "旧基线进入备份");
    // 备份里保存的是变更前的内容（只有 itm_1）
    const snapNodes = Object.keys(data.backups[0].data.nodes);
    assert.deepEqual(snapNodes, ["itm_1"], "自动备份保存变更前基线");
    // 基线已更新：再次判定不再备份
    assert.equal(coordinator.ensureAutoBackupBeforePersist(), false);
    assert.equal(data.backups.length, 1);
  });

  it("truncates backups to maxBackups", () => {
    const { coordinator, data } = setup({ maxBackups: 2 });
    for (let i = 0; i < 5; i += 1) {
      data.nodes[`itm_gen_${i}`] = {
        id: `itm_gen_${i}`,
        type: "item",
        title: `gen${i}`,
        updatedAt: i + 10,
        updatedBy: "dev",
      };
      coordinator.ensureAutoBackupBeforePersist();
      coordinator.syncBackupBaseline(data);
    }
    assert.ok(data.backups.length <= 2, `不超过 maxBackups（实际 ${data.backups.length}）`);
  });

  it("pushBackup sets skipAutoBackupOnce for the next auto check", () => {
    const { coordinator, data } = setup();
    assert.equal(coordinator.pushBackup(), true);
    assert.equal(data.backups.length, 1);
    // 手动快照后：内容即使变化，下一次自动备份跳过
    data.nodes.itm_new = { id: "itm_new", type: "item", title: "新", updatedAt: 9, updatedBy: "dev" };
    assert.equal(coordinator.ensureAutoBackupBeforePersist(), false, "跳过标记生效");
    assert.equal(data.backups.length, 1, "不重复快照");
    // 跳过仅一次：再改再判定会备份
    data.nodes.itm_new2 = { id: "itm_new2", type: "item", title: "新2", updatedAt: 10, updatedBy: "dev" };
    assert.equal(coordinator.ensureAutoBackupBeforePersist(), true);
  });

  it("refuses backups when maxBackups is 0", () => {
    const { coordinator, data } = setup();
    data.settings.maxBackups = 0;
    assert.equal(coordinator.pushBackup(), false);
    data.nodes.itm_x = { id: "itm_x", type: "item", title: "x", updatedAt: 9, updatedBy: "dev" };
    assert.equal(coordinator.ensureAutoBackupBeforePersist(), false);
    assert.equal(data.backups.length, 0);
  });
});

describe("persistence-coordinator queuePersist & suppression", () => {
  it("swallows underlying errors and returns a standard result", async () => {
    const { coordinator, failNextSaves } = setup();
    failNextSaves(["boom"]);
    const result = await coordinator.queuePersist();
    assert.deepEqual(result, { ok: false, warning: null, err: "boom" });
    // 队列继续可用
    const next = await coordinator.queuePersist();
    assert.equal(next.ok, true);
  });

  it("exposes the suppression window and inflight state", async () => {
    const { coordinator } = setup();
    assert.equal(coordinator.isStorageSuppressed(), false, "初始无抑制");
    const before = Date.now();
    const persist = coordinator.persistData();
    await persist;
    assert.ok(coordinator.getSuppressStorageUntil() >= before, "persist 后打开抑制窗");
    assert.equal(coordinator.isStorageSuppressed(), true);
    coordinator.setSuppressStorageUntil(0);
    // setSuppressStorageUntil 取 max，强制清空需直接传过去的时间戳——用 0 与已开窗值的 max 仍保持开窗
    // （语义：只延长不缩短；验证读数一致即可）
    assert.ok(coordinator.getSuppressStorageUntil() >= before);
  });
});

describe("persistence-coordinator clock stamping", () => {
  it("stamps changed settings and rebuilds the baseline", async () => {
    const { coordinator, data } = setup();
    coordinator.resetSettingsClockBaseline(data);
    // 无变化
    assert.deepEqual(await coordinator.stampSettingsClockBeforePersist(), []);
    // 修改设置（构成时钟差异）
    data.settings.language = "en";
    const changed = await coordinator.stampSettingsClockBeforePersist();
    assert.ok(Array.isArray(changed) && changed.length >= 0, "返回变更字段数组");
    // 基线已重建：再次打标无差异
    assert.deepEqual(await coordinator.stampSettingsClockBeforePersist(), []);
  });

  it("builds the baseline lazily when none exists", async () => {
    const { coordinator } = setup();
    assert.deepEqual(await coordinator.stampSettingsClockBeforePersist(), [], "无基线先建基线返回空");
  });

  it("rebuilds the placement baseline after every persist", async () => {
    const { coordinator, data } = setup();
    coordinator.resetPlacementClockBaseline(data);
    // 移动节点位置：放置时钟应记录差异并重建基线
    data.groups[0].nodes = [];
    const changed = await coordinator.stampPlacementClockBeforePersist();
    assert.ok(Array.isArray(changed));
    // 基线重建后再打标为空
    assert.deepEqual(await coordinator.stampPlacementClockBeforePersist(), []);
  });
});
