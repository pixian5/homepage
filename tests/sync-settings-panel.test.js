import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createSyncSettingsPanel } from "../src/js/sync-settings-panel.js";
import { html } from "../src/js/ui-utils.js";

const realDocument = globalThis.document;
const realConfirm = globalThis.confirm;

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

function setupPanel({
  syncState = { status: "idle", bytesEstimate: 512, budgetLevel: "green" },
  devicesRes,
  healthRes = { ok: true, body: { tombstoneCount: 2, encrypted: true, snapshotCount: 3 } },
  snapshotsRes = {
    ok: true,
    snapshots: [{ id: "snap_001.json", createdAt: Date.now(), bytes: 2048, revision: 12, encrypted: true }],
  },
  restoreRes = { ok: true, restoredFrom: "snap_001.json", revision: 15, epoch: 2, encrypted: true },
  rotateRes = { ok: true },
  resolveConflictImpl = async () => ({ ok: true }),
  pendingConflict = null,
} = {}) {
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
  const calls = {
    getDevices: [],
    health: [],
    retire: [],
    getSnapshots: [],
    restoreSnapshot: [],
    rotate: [],
    pullNow: [],
    openModal: 0,
    closeModal: 0,
  };
  const panel = createSyncSettingsPanel({
    getData: () => data,
    ui: {
      $,
      html,
      t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
      toast: (msg, type = "success") => toasts.push({ msg, type }),
      openModal() {
        calls.openModal += 1;
      },
      closeModal() {
        calls.closeModal += 1;
      },
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
      getPendingConflict: () => pendingConflict,
      reloadSyncState: async () => syncState,
      resolveDocConflict: resolveConflictImpl,
      pullNow: async (reason) => {
        calls.pullNow.push(reason);
        return { ok: true };
      },
      pushNow: async () => ({ ok: true }),
      rotateE2eePassphrase: async (payload) => {
        calls.rotate.push(payload);
        return typeof rotateRes === "function" ? rotateRes(payload) : rotateRes;
      },
      onSyncEnabledChanged: async () => {},
      refreshSyncInterval() {},
      cancelScheduledPush() {},
      httpHealth: async (cfg) => {
        calls.health.push(cfg);
        return healthRes;
      },
      httpPullState: async () => ({ ok: true }),
      httpGetDevices: async (cfg) => {
        calls.getDevices.push(cfg);
        return (
          devicesRes || {
            ok: true,
            revision: 9,
            epoch: 1,
            reclaimCandidates: [],
            devices: [
              { deviceId: "dev_local_12345", deviceName: "本机 Chrome", lastSeenAt: Date.now(), retiredAt: 0 },
              { deviceId: "dev_other_99999", deviceName: "办公 Firefox", lastSeenAt: Date.now(), retiredAt: 0 },
            ],
          }
        );
      },
      httpRetireDevice: async (cfg, payload) => {
        calls.retire.push({ cfg, payload });
        return { ok: true };
      },
      httpGetSnapshots: async (cfg) => {
        calls.getSnapshots.push(cfg);
        return snapshotsRes;
      },
      httpRestoreSnapshot: async (cfg, id) => {
        calls.restoreSnapshot.push({ cfg, id });
        return restoreRes;
      },
      ensureDevicePairing: async () => true,
    },
  });
  return { panel, $, data, toasts, calls };
}

afterEach(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  if (realConfirm === undefined) delete globalThis.confirm;
  else globalThis.confirm = realConfirm;
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

  it("renders device list with baseUrl transport config, health encryption summary, and empty url guard", async () => {
    globalThis.document = { createElement: () => makeField() };
    const { panel, $, calls } = setupPanel();
    $("settingSync").checked = true;
    $("settingSyncServerUrl").value = "";
    await panel.refreshSyncDevices();
    assert.equal($("syncDevicesList").dataset.state, "empty");

    $("settingSyncServerUrl").value = "http://127.0.0.1:8787";
    $("settingSyncServerToken").value = "tok";
    await panel.refreshSyncDevices();
    assert.deepEqual(calls.getDevices[0], { baseUrl: "http://127.0.0.1:8787", token: "tok" });
    assert.deepEqual(calls.health[0], { baseUrl: "http://127.0.0.1:8787", token: "tok" });
    assert.equal($("syncDevicesList").dataset.state, "ready");
    assert.equal($("syncDevicesList").children.length, 2);
    assert.match($("syncDevicesHealth").textContent, /"active":2/);
    assert.match($("syncDevicesHealth").textContent, /settings\.sync\.health\.encrypted/);
    assert.match($("syncDevicesHealth").textContent, /"count":3/);
  });

  it("opens snapshots modal with baseUrl transport config, handles empty/unauthorized, and restores snapshot", async () => {
    globalThis.document = { createElement: () => makeField() };
    globalThis.confirm = () => true;

    // 1. unauthorized 错误分支
    const unauth = setupPanel({ snapshotsRes: { ok: false, reason: "unauthorized" } });
    unauth.$("settingSyncServerUrl").value = "http://127.0.0.1:8787";
    unauth.panel.bindButtons();
    await unauth.$("btnSyncSnapshots").click();
    assert.deepEqual(unauth.calls.getSnapshots[0], { baseUrl: "http://127.0.0.1:8787", token: "" });
    assert.equal(unauth.calls.openModal, 0);
    assert.match(unauth.toasts[0].msg, /settings\.sync\.unauthorized/);

    // 2. 空快照分支
    const emptyPanel = setupPanel({ snapshotsRes: { ok: true, snapshots: [] } });
    emptyPanel.$("settingSyncServerUrl").value = "http://127.0.0.1:8787";
    emptyPanel.$("settingSyncServerToken").value = "tok";
    emptyPanel.panel.bindButtons();
    await emptyPanel.$("btnSyncSnapshots").click();
    assert.equal(emptyPanel.calls.openModal, 1);
    assert.equal(emptyPanel.$("syncSnapshotsList").children[0].textContent, "settings.sync.snapshots.empty");

    // 3. 正常快照渲染并执行恢复
    const full = setupPanel();
    full.$("settingSyncServerUrl").value = "http://127.0.0.1:8787";
    full.$("settingSyncServerToken").value = "tok";
    full.panel.bindButtons();
    await full.$("btnSyncSnapshots").click();
    const row = full.$("syncSnapshotsList").children[0];
    const restoreBtn = row.children[2];
    await restoreBtn.click();
    assert.deepEqual(full.calls.restoreSnapshot[0], {
      cfg: { baseUrl: "http://127.0.0.1:8787", token: "tok" },
      id: "snap_001.json",
    });
    assert.deepEqual(full.calls.pullNow, ["snapshot_restore"]);
    assert.equal(full.calls.closeModal, 1);
  });

  it("validates E2EE passphrase rotation inputs and handles failure/success", async () => {
    const { panel, $, toasts, calls } = setupPanel({
      rotateRes: ({ oldPassphrase }) =>
        oldPassphrase === "bad" ? { ok: false, reason: "e2ee_decrypt_failed" } : { ok: true },
    });
    $("settingSync").checked = true;
    $("settingSyncServerUrl").value = "http://127.0.0.1:8787";
    panel.bindButtons();
    await $("btnSyncRotateE2ee").click();
    assert.equal(calls.openModal, 1);

    // 缺少口令
    $("e2eeRotateOldPass").value = "";
    $("e2eeRotateNewPass").value = "";
    await $("btnRotateE2eeConfirm").click();
    assert.equal(toasts.at(-1).msg, "settings.sync.e2ee.passphraseRequired");

    // 新旧确认不一致
    $("e2eeRotateOldPass").value = "bad";
    $("e2eeRotateNewPass").value = "new1";
    $("e2eeRotateConfirmPass").value = "new2";
    await $("btnRotateE2eeConfirm").click();
    assert.equal(toasts.at(-1).msg, "settings.sync.e2ee.rotateMismatch");

    // 旧口令解密失败
    $("e2eeRotateConfirmPass").value = "new1";
    await $("btnRotateE2eeConfirm").click();
    assert.equal(toasts.at(-1).msg, "settings.sync.e2ee.decryptFailed");
    assert.equal(calls.closeModal, 0);

    // 成功轮换并关窗
    $("e2eeRotateOldPass").value = "good";
    await $("btnRotateE2eeConfirm").click();
    assert.equal(calls.closeModal, 1);
    assert.equal(toasts.at(-1).msg, "settings.sync.e2ee.rotateDone");
  });

  it("re-enables conflict modal buttons via finally when resolveDocConflict fails or throws", async () => {
    const btnIds = ["btnConflictMerge", "btnConflictLocal", "btnConflictRemote", "btnConflictCancel"];

    // 返回 ok: false 分支
    const failPanel = setupPanel({
      pendingConflict: { localDocId: "doc_l", remoteDocId: "doc_r" },
      resolveConflictImpl: async () => ({ ok: false, reason: "network_error" }),
    });
    failPanel.panel.openSyncConflictModal();
    await failPanel.$("btnConflictMerge").click();
    for (const id of btnIds) {
      assert.equal(failPanel.$(id).disabled, false, `${id} should re-enable after failure`);
    }

    // 抛异常分支
    const throwPanel = setupPanel({
      pendingConflict: { localDocId: "doc_l", remoteDocId: "doc_r" },
      resolveConflictImpl: async () => {
        throw new Error("boom");
      },
    });
    throwPanel.panel.openSyncConflictModal();
    await throwPanel.$("btnConflictLocal").click();
    for (const id of btnIds) {
      assert.equal(throwPanel.$(id).disabled, false, `${id} should re-enable after throw`);
    }
  });
});
