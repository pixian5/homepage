import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSettingsStateCoordinator } from "../src/js/settings-state-coordinator.js";

describe("settings-state-coordinator", () => {
  it("manages state proxy properties correctly", () => {
    const coordinator = createSettingsStateCoordinator();
    assert.equal(coordinator.isSettingsOpen(), false);
    assert.equal(coordinator.state.settingsOpen, false);

    coordinator.state.settingsOpen = true;
    assert.equal(coordinator.isSettingsOpen(), true);

    coordinator.state.settingsSaving = true;
    assert.equal(coordinator.isSettingsSaving(), true);

    const dummyTimer = setTimeout(() => {}, 10000);
    coordinator.state.settingsSaveTimer = dummyTimer;
    assert.equal(coordinator.getSettingsSaveTimer(), dummyTimer);

    coordinator.clearTimer();
    assert.equal(coordinator.getSettingsSaveTimer(), null);

    coordinator.state.settingsSaveQueued = true;
    assert.equal(coordinator.isSettingsSaveQueued(), true);
  });

  it("leaveSettingsForSubpanel clears timer, saves pending changes and closes open state", async () => {
    const coordinator = createSettingsStateCoordinator();
    coordinator.setSettingsOpen(true);
    const dummyTimer = setTimeout(() => {}, 10000);
    coordinator.setSettingsSaveTimer(dummyTimer);

    let saved = false;
    await coordinator.leaveSettingsForSubpanel(() => ({
      saveNow: async () => {
        saved = true;
      },
    }));

    assert.equal(saved, true);
    assert.equal(coordinator.isSettingsOpen(), false);
    assert.equal(coordinator.getSettingsSaveTimer(), null);
  });

  it("leaveSettingsForSubpanel tolerates saveNow errors gracefully", async () => {
    const coordinator = createSettingsStateCoordinator();
    coordinator.setSettingsOpen(true);

    await coordinator.leaveSettingsForSubpanel(() => ({
      saveNow: async () => {
        throw new Error("Disk full");
      },
    }));

    assert.equal(coordinator.isSettingsOpen(), false);
  });

  it("flushPendingSettingsSave runs pending save when settings are open and triggers reload", async () => {
    const coordinator = createSettingsStateCoordinator();
    coordinator.setSettingsOpen(true);
    coordinator.setSettingsSaving(false);
    coordinator.setSettingsSaveQueued(true);

    let saved = false;
    let reloadFlushed = false;
    let pointerOriginReset = false;

    await coordinator.flushPendingSettingsSave({
      getSettingsCtl: () => ({
        saveNow: async () => {
          saved = true;
        },
      }),
      storageListener: {
        flushPendingReload: () => {
          reloadFlushed = true;
        },
      },
      appEventsBinder: {
        resetModalPointerOrigin: () => {
          pointerOriginReset = true;
        },
      },
    });

    assert.equal(saved, true);
    assert.equal(reloadFlushed, true);
    assert.equal(pointerOriginReset, true);
    assert.equal(coordinator.isSettingsOpen(), false);
    assert.equal(coordinator.isSettingsSaving(), false);
    assert.equal(coordinator.isSettingsSaveQueued(), false);
  });

  it("flushPendingSettingsSave skips save if settingsOpen was false", async () => {
    const coordinator = createSettingsStateCoordinator();
    coordinator.setSettingsOpen(false);

    let saved = false;
    await coordinator.flushPendingSettingsSave({
      getSettingsCtl: () => ({
        saveNow: async () => {
          saved = true;
        },
      }),
    });

    assert.equal(saved, false);
  });
});
