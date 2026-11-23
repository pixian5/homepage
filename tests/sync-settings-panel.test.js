import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createSyncSettingsPanel } from "../src/js/sync-settings-panel.js";
import { html } from "../src/js/ui-utils.js";

const realDocument = globalThis.document;

function makeField(initial = "") {
  const listeners = {};
  const classSet = new Set();
  return {
    value: initial,
    checked: false,
    textContent: "",
    disabled: false,
    dataset: {},
    children: [],
    classList: {
      toggle: (name, force) => {
        if (force === undefined) {
          if (classSet.has(name)) classSet.delete(name);
          else classSet.add(name);
        } else if (force) {
          classSet.add(name);
        } else {
          classSet.delete(name);
        }
      },
      contains: (name) => classSet.has(name),
    },
    replaceChildren(...items) {
      this.children = items;
    },
    append(...items) {
      this.children.push(...items);
    },
    appendChild(item) {
      this.children.push(item);
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    click() {
      return listeners.click?.();
    },
  };
}

function setupPanel({ syncState = { status: "idle", bytesEstimate: 512, budgetLevel: "green" }, devicesRes } = {}) {
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) fields.set(id, makeField());
    return fields.get(id);
  };
  const data = {
    settings: {
      syncEnabled: true,
      syncInterval: "5m",
      syncServerUrl: "http://127.0.0.1:8787",
      syncServerToken: "tok",
    },
  };
  const toasts = [];
  const panel = createSyncSettingsPanel({
    getData: () => data,
    ui: {
      $,
      html,
      t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
      toast: (msg, type = "success") => toasts.push({ msg, type }),
      openModal() {},
      closeModal() {},
      runWithButtonState: async (_btn, _label, fn) => fn(),
      render() {},
      persistData: async () => ({ ok: true }),
      processPendingIconFetches() {},
    },
    deps: {
      normalizeSyncInterval: (v) => v || "5m",
      syncBytesBudgetLevel: () => "green",
      estimateSyncProjectionBytes: () => 512,
      getOrCreateDeviceId: async () => "dev_local_12345",
      getSyncStatus: () => syncState,
      getPendingConflict: () => null,
      reloadSyncState: async () => syncState,
      resolveDocConflict: async () => ({ ok: true }),
      pullNow: async () => ({ ok: true }),
      pushNow: async () => ({ ok: true }),
      onSyncEnabledChanged: async () => {},
      refreshSyncInterval() {},
      cancelScheduledPush() {},
      httpHealth: async () => ({ ok: true, body: { tombstoneCount: 2 } }),
      httpPullState: async () => ({ ok: true }),
      httpGetDevices: async () =>
        devicesRes || {
          ok: true,
          revision: 9,
          epoch: 1,
          reclaimCandidates: [],
          devices: [
            { deviceId: "dev_local_12345", deviceName: "本机 Chrome", lastSeenAt: Date.now(), retiredAt: 0 },
            { deviceId: "dev_other_99999", deviceName: "办公 Firefox", lastSeenAt: Date.now(), retiredAt: 0 },
          ],
        },
      httpRetireDevice: async () => ({ ok: true }),
      ensureDevicePairing: async () => true,
    },
  });
  return { panel, $, data, toasts };
}

afterEach(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

describe("sync-settings-panel", () => {
  it("reads sync settings directly from form fields", () => {
    const { panel, $, data } = setupPanel();
    $("settingSync").checked = false;
    $("settingSyncInterval").value = "15m";
    $("settingSyncServerUrl").value = " https://sync.example.com ";
    $("settingSyncServerToken").value = " sec ";
    const cfg = panel.applySyncSettingsFromForm();
    assert.deepEqual(cfg, {
      enabled: false,
      transport: "http",
      interval: "15m",
      url: "https://sync.example.com",
      token: "sec",
    });
    assert.equal(data.settings.syncServerUrl, "https://sync.example.com");
  });

  it("renders status line and toggles conflict button visibility", async () => {
    const { panel, $ } = setupPanel({
      syncState: { status: "need_setup", hasConflict: true, bytesEstimate: 2048, budgetLevel: "yellow" },
    });
    await panel.refreshSyncStatusLine();
    assert.equal($("syncStatusLine").dataset.level, "red");
    assert.match($("syncStatusLine").textContent, /settings\.sync\.state\.conflict/);
    assert.equal($("btnSyncResolveConflict").classList.contains("hidden"), false);
  });

  it("renders device list and handles empty server url safely", async () => {
    globalThis.document = { createElement: () => makeField() };
    const { panel, $ } = setupPanel();
    $("settingSync").checked = true;
    $("settingSyncServerUrl").value = "";
    await panel.refreshSyncDevices();
    assert.equal($("syncDevicesList").dataset.state, "empty");

    $("settingSyncServerUrl").value = "http://127.0.0.1:8787";
    await panel.refreshSyncDevices();
    assert.equal($("syncDevicesList").dataset.state, "ready");
    assert.equal($("syncDevicesList").children.length, 2);
    assert.match($("syncDevicesHealth").textContent, /"active":2/);
  });
});
