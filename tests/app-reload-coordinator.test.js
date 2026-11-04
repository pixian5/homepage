import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAppReloadCoordinator,
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

  it("resolveOpenFolderId validates folder existence and type", () => {
    const nodes = {
      f1: { id: "f1", type: "folder" },
      b1: { id: "b1", type: "link" },
    };
    assert.equal(resolveOpenFolderId("f1", nodes), "f1");
    assert.equal(resolveOpenFolderId("b1", nodes), null);
    assert.equal(resolveOpenFolderId("nonexistent", nodes), null);
    assert.equal(resolveOpenFolderId(null, nodes), null);
  });
});

describe("app-reload-coordinator lifecycle", () => {
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
});
