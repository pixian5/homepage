import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAppReloadCoordinator,
  defaultClaimExternalReload,
  isVisibleHomepageStateEqual,
  resolveActiveGroupId,
  resolveOpenFolderId,
} from "../src/js/app-reload-coordinator.js";

describe("app-reload-coordinator pure helpers", () => {
  const recentGroupId = "__recent__";

  it("resolveActiveGroupId returns recentGroupId when given recentGroupId", () => {
    const res = resolveActiveGroupId("__recent__", {
      getRootContainerById: () => null,
      getRootGroup: () => ({ id: "root-group" }),
      recentGroupId,
    });
    assert.equal(res, "__recent__");
  });

  it("resolveActiveGroupId keeps valid existing group", () => {
    const res = resolveActiveGroupId("custom-group", {
      getRootContainerById: (id) => (id === "custom-group" ? { id } : null),
      getRootGroup: () => ({ id: "root-group" }),
      recentGroupId,
    });
    assert.equal(res, "custom-group");
  });

  it("resolveActiveGroupId falls back to rootGroup id if candidate is invalid", () => {
    const res = resolveActiveGroupId("deleted-group", {
      getRootContainerById: () => null,
      getRootGroup: () => ({ id: "root-group" }),
      recentGroupId,
    });
    assert.equal(res, "root-group");
  });

  it("resolveActiveGroupId falls back to recentGroupId if rootGroup is missing", () => {
    const res = resolveActiveGroupId(null, {
      getRootContainerById: () => null,
      getRootGroup: () => null,
      recentGroupId,
    });
    assert.equal(res, "__recent__");
  });

  it("resolveOpenFolderId validates folder existence, type, and active status", () => {
    const nodes = {
      f1: { id: "f1", type: "folder" },
      fDeleted: { id: "fDeleted", type: "folder", deletedAt: 100 },
      fPurged: { id: "fPurged", type: "folder", purgedAt: 200 },
      b1: { id: "b1", type: "link" },
    };
    assert.equal(resolveOpenFolderId("f1", nodes), "f1");
    assert.equal(resolveOpenFolderId("fDeleted", nodes), null);
    assert.equal(resolveOpenFolderId("fPurged", nodes), null);
    assert.equal(resolveOpenFolderId("b1", nodes), null);
    assert.equal(resolveOpenFolderId("nonexistent", nodes), null);
    assert.equal(resolveOpenFolderId(null, nodes), null);
  });
});

describe("app-reload-coordinator lifecycle", () => {
  it("keeps current data when storage reads fail", async () => {
    const currentData = { lastUpdated: 100, settings: { syncEnabled: false }, nodes: {} };
    const failedData = { lastUpdated: 0, settings: { syncEnabled: false }, nodes: {} };
    let rendered = false;
    let pullCount = 0;

    const coordinator = createAppReloadCoordinator({
      getData: () => currentData,
      setData: () => {
        throw new Error("failed storage data must not replace current data");
      },
      getActiveGroupId: () => null,
      setActiveGroupId: () => {},
      getOpenFolderId: () => null,
      setOpenFolderId: () => {},
      isPersistInFlight: () => false,
      loadData: async () => failedData,
      isStorageReadFailure: (data) => data === failedData,
      pullNow: async () => {
        pullCount++;
      },
      resetSettingsClockBaseline: () => {},
      resetPlacementClockBaseline: () => {},
      getRootContainerById: () => null,
      getRootGroup: () => null,
      recentGroupId: "__recent__",
      getSelectionMgr: () => null,
      ensureLanguageSetting: () => {},
      syncBackupBaseline: () => {},
      render: () => {
        rendered = true;
      },
      processPendingIconFetches: () => {},
      consumeSaveToast: async () => {},
      schedulePush: () => {},
      toast: () => {},
      t: (key) => key,
    });

    const reloaded = await coordinator.reloadFromStorage();
    assert.equal(reloaded, false);
    assert.equal(rendered, false);
    assert.equal(pullCount, 0);
  });

  it("reloads disk data and resets baselines without sync", async () => {
    let currentData = {
      lastUpdated: 100,
      settings: { syncEnabled: false },
      nodes: { g1: { id: "g1", type: "group" } },
    };
    const diskData = {
      lastUpdated: 200,
      settings: { syncEnabled: false },
      nodes: { g1: { id: "g1", type: "group" }, f1: { id: "f1", type: "folder" } },
    };

    let activeGroupId = "g1";
    let openFolderId = "f1";
    let baselineReset = false;
    let rendered = false;
    let iconsProcessed = false;
    let toastMsg = null;
    let toastType = null;
    let toastConsumed = false;

    const coordinator = createAppReloadCoordinator({
      getData: () => currentData,
      setData: (next) => {
        currentData = next;
      },
      getActiveGroupId: () => activeGroupId,
      setActiveGroupId: (id) => {
        activeGroupId = id;
      },
      getOpenFolderId: () => openFolderId,
      setOpenFolderId: (id) => {
        openFolderId = id;
      },
      isPersistInFlight: () => false,
      loadData: async () => diskData,
      pullNow: async () => {},
      resetSettingsClockBaseline: () => {
        baselineReset = true;
      },
      resetPlacementClockBaseline: () => {},
      getRootContainerById: (id) => (diskData.nodes[id] ? diskData.nodes[id] : null),
      getRootGroup: () => ({ id: "g1" }),
      recentGroupId: "__recent__",
      getSelectionMgr: () => ({ retainOnly: () => {} }),
      ensureLanguageSetting: () => {},
      syncBackupBaseline: () => {},
      render: () => {
        rendered = true;
      },
      processPendingIconFetches: () => {
        iconsProcessed = true;
      },
      consumeSaveToast: async () => {
        toastConsumed = true;
      },
      schedulePush: () => {},
      toast: (msg, type) => {
        toastMsg = msg;
        toastType = type;
      },
      t: (key) => key,
    });

    await coordinator.reloadFromStorage();

    assert.equal(currentData, diskData);
    assert.equal(baselineReset, true);
    assert.equal(rendered, true);
    assert.equal(iconsProcessed, true);
    assert.equal(toastConsumed, true);
    assert.equal(toastMsg, "toast.syncOverwritten");
    assert.equal(toastType, "warning");
    assert.equal(activeGroupId, "g1");
    assert.equal(openFolderId, "f1");
  });

  it("handles sync enabled reload with pullNow and schedulePush", async () => {
    let currentData = {
      lastUpdated: 100,
      settings: { syncEnabled: true },
      nodes: {},
    };
    const diskData = {
      lastUpdated: 150,
      settings: { syncEnabled: true },
      nodes: {},
    };

    let pulledReason = null;
    let pushScheduled = false;

    const coordinator = createAppReloadCoordinator({
      getData: () => currentData,
      setData: (next) => {
        currentData = next;
      },
      getActiveGroupId: () => null,
      setActiveGroupId: () => {},
      getOpenFolderId: () => null,
      setOpenFolderId: () => {},
      isPersistInFlight: () => false,
      loadData: async () => diskData,
      pullNow: async (reason) => {
        pulledReason = reason;
      },
      resetSettingsClockBaseline: () => {},
      resetPlacementClockBaseline: () => {},
      getRootContainerById: () => null,
      getRootGroup: () => null,
      recentGroupId: "__recent__",
      getSelectionMgr: () => null,
      ensureLanguageSetting: () => {},
      syncBackupBaseline: () => {},
      render: () => {},
      processPendingIconFetches: () => {},
      consumeSaveToast: async () => {},
      schedulePush: () => {
        pushScheduled = true;
      },
      toast: () => {},
      t: (k) => k,
    });

    await coordinator.reloadFromStorage();

    assert.equal(pulledReason, "storage_reload");
    assert.equal(pushScheduled, true);
  });

  it("stops pullNow/schedulePush/side-effects for newtab_edit and sync_merge sources", async () => {
    for (const source of ["newtab_edit", "sync_merge"]) {
      let currentData = {
        lastUpdated: 100,
        settings: { syncEnabled: true, language: "zh-CN" },
        groups: [{ id: "g1", name: "全部", order: -1, nodes: [] }],
        nodes: {},
      };
      const diskData = {
        lastUpdated: 200,
        settings: { syncEnabled: true, language: "zh-CN" },
        groups: [{ id: "g1", name: "全部", order: -1, nodes: ["itm_1"] }],
        nodes: { itm_1: { id: "itm_1", type: "item", title: "New", url: "https://new.test/" } },
        _syncMeta: { lastWriteSource: source },
      };

      const calls = { pull: 0, push: 0, render: 0, icons: 0, toastConsume: 0 };
      const coordinator = createAppReloadCoordinator({
        getData: () => currentData,
        setData: (next) => {
          currentData = next;
        },
        getActiveGroupId: () => "g1",
        setActiveGroupId: () => {},
        getOpenFolderId: () => null,
        setOpenFolderId: () => {},
        isPersistInFlight: () => false,
        loadData: async () => diskData,
        pullNow: async () => {
          calls.pull += 1;
        },
        resetSettingsClockBaseline: () => {},
        resetPlacementClockBaseline: () => {},
        getRootContainerById: () => ({ id: "g1" }),
        getRootGroup: () => ({ id: "g1" }),
        recentGroupId: "__recent__",
        getSelectionMgr: () => null,
        ensureLanguageSetting: () => {},
        syncBackupBaseline: () => {},
        render: () => {
          calls.render += 1;
        },
        processPendingIconFetches: () => {
          calls.icons += 1;
        },
        consumeSaveToast: async () => {
          calls.toastConsume += 1;
        },
        schedulePush: () => {
          calls.push += 1;
        },
        toast: () => {},
        t: (k) => k,
      });

      await coordinator.reloadFromStorage();

      assert.equal(calls.pull, 0, `${source} 不得再触发 pullNow`);
      assert.equal(calls.push, 0, `${source} 不得再触发 schedulePush`);
      assert.equal(calls.icons, 0, `${source} 不得触发跨标签补抓`);
      assert.equal(calls.toastConsume, 0, `${source} 不得重复消费保存提示`);
      assert.equal(calls.render, 1, `${source} 需要同步更新视图`);
    }
  });

  it("skips render and warning toast for sync_meta writes only when visible state matches", async () => {
    assert.equal(isVisibleHomepageStateEqual(null, {}), false);

    let currentData = {
      lastUpdated: 100,
      settings: { syncEnabled: false, theme: "dark", syncDeviceSecret: "old" },
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["n1"] }],
      nodes: { n1: { id: "n1", type: "item", title: "A", url: "https://a.test/" } },
    };
    const metaOnlyDisk = {
      lastUpdated: 200,
      settings: { syncEnabled: false, theme: "dark", syncDeviceSecret: "new" },
      groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["n1"] }],
      nodes: { n1: { url: "https://a.test/", title: "A", type: "item", id: "n1" } },
      _syncMeta: { lastWriteSource: "sync_meta", revision: 9 },
    };

    const calls = { render: 0, toast: 0 };
    let diskPayload = metaOnlyDisk;
    const coordinator = createAppReloadCoordinator({
      getData: () => currentData,
      setData: (next) => {
        currentData = next;
      },
      getActiveGroupId: () => "grp_all",
      setActiveGroupId: () => {},
      getOpenFolderId: () => null,
      setOpenFolderId: () => {},
      isPersistInFlight: () => false,
      loadData: async () => diskPayload,
      resetSettingsClockBaseline: () => {},
      resetPlacementClockBaseline: () => {},
      getRootContainerById: () => ({ id: "grp_all" }),
      getRootGroup: () => ({ id: "grp_all" }),
      recentGroupId: "__recent__",
      getSelectionMgr: () => null,
      ensureLanguageSetting: () => {},
      syncBackupBaseline: () => {},
      render: () => {
        calls.render += 1;
      },
      toast: () => {
        calls.toast += 1;
      },
      t: (k) => k,
    });

    await coordinator.reloadFromStorage();
    assert.equal(calls.render, 0, "仅 _syncMeta/凭据变化时跳过整页重绘");
    assert.equal(calls.toast, 0, "sync_meta 回写不得弹覆盖提示");

    // 若可见数据实际不同（例如此前漏过更新），仍需正常 render
    diskPayload = structuredClone(metaOnlyDisk);
    diskPayload.nodes.n1.title = "Updated Title";
    diskPayload.lastUpdated = 300;
    await coordinator.reloadFromStorage();
    assert.equal(calls.render, 1, "可见数据不一致时仍必须 render");
  });

  it("claims each external write once across multiple tabs via defaultClaimExternalReload", async () => {
    const map = new Map();
    const mockStorage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
    };
    const diskData = {
      lastUpdated: 999,
      settings: { syncEnabled: true },
      groups: [],
      nodes: {},
      _syncMeta: { lastWriteSource: "external" },
    };

    const statsA = { pull: 0, push: 0, icons: 0, toast: 0 };
    const statsB = { pull: 0, push: 0, icons: 0, toast: 0 };
    const makeCoord = (stats) => {
      let data = { lastUpdated: 100, settings: { syncEnabled: true }, groups: [], nodes: {} };
      return createAppReloadCoordinator({
        getData: () => data,
        setData: (next) => {
          data = next;
        },
        getActiveGroupId: () => null,
        setActiveGroupId: () => {},
        getOpenFolderId: () => null,
        setOpenFolderId: () => {},
        isPersistInFlight: () => false,
        loadData: async () => structuredClone(diskData),
        pullNow: async () => {
          stats.pull += 1;
        },
        resetSettingsClockBaseline: () => {},
        resetPlacementClockBaseline: () => {},
        getRootContainerById: () => null,
        getRootGroup: () => null,
        recentGroupId: "__recent__",
        getSelectionMgr: () => null,
        ensureLanguageSetting: () => {},
        syncBackupBaseline: () => {},
        render: () => {},
        processPendingIconFetches: () => {
          stats.icons += 1;
        },
        consumeSaveToast: async () => {
          stats.toast += 1;
        },
        schedulePush: () => {
          stats.push += 1;
        },
        claimExternalReload: (ts) => defaultClaimExternalReload(ts, { storage: mockStorage, now: 50_000 }),
        toast: () => {},
        t: (k) => k,
      });
    };

    await makeCoord(statsA).reloadFromStorage();
    await makeCoord(statsB).reloadFromStorage();

    assert.deepEqual(statsA, { pull: 1, push: 1, icons: 1, toast: 1 });
    assert.deepEqual(statsB, { pull: 0, push: 0, icons: 0, toast: 0 }, "第二标签页不得重复执行外部同步副作用");
  });
});
