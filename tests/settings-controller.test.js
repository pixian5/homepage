import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ALL_BOOKMARKS_GROUP_ID } from "../src/js/data-utils.js";
import { createSettingsController } from "../src/js/settings-controller.js";
import { defaultData } from "../src/js/storage.js";
import { SYNC_INTERVAL_OPTIONS } from "../src/js/sync_policy.js";
import { html, rawHtml } from "../src/js/ui-utils.js";

const realConfirm = globalThis.confirm;
const realDocument = globalThis.document;

function makeElement(id, { tagName = "INPUT", type = "", value = "", name = "" } = {}) {
  const listeners = new Map();
  const classSet = new Set();
  const el = {
    id,
    tagName,
    value,
    name,
    checked: false,
    disabled: false,
    focused: false,
    textContent: "",
    files: [],
    dataset: {},
    children: [],
    classList: {
      toggle(cls, force) {
        if (force === undefined) {
          if (classSet.has(cls)) classSet.delete(cls);
          else classSet.add(cls);
        } else if (force) {
          classSet.add(cls);
        } else {
          classSet.delete(cls);
        }
      },
      contains: (cls) => classSet.has(cls),
    },
    getAttribute(attr) {
      if (attr === "type") return type;
      return null;
    },
    setAttribute() {},
    removeAttribute() {},
    focus() {
      this.focused = true;
    },
    replaceChildren(...items) {
      this.children = items;
    },
    append(...items) {
      this.children.push(...items);
    },
    appendChild(item) {
      this.children.push(item);
      return item;
    },
    addEventListener(eventName, fn) {
      const list = listeners.get(eventName) || [];
      list.push(fn);
      listeners.set(eventName, list);
    },
    async dispatch(eventName, event = { target: el }) {
      const snapshot = [...(listeners.get(eventName) || [])];
      for (const fn of snapshot) {
        await fn(event);
      }
    },
    click() {
      return this.dispatch("click", { target: this });
    },
  };
  return el;
}

function createHarness(seedOverride = null) {
  let data = seedOverride || defaultData();
  let activeGroupId = ALL_BOOKMARKS_GROUP_ID;
  const fields = new Map();

  const densityRadios = ["compact", "standard", "spacious"].map((val) =>
    makeElement(`density_${val}`, { tagName: "INPUT", type: "radio", value: val, name: "density" }),
  );
  const selectIds = new Set([
    "settingLanguage",
    "settingSearchEnginePreset",
    "settingBgType",
    "settingTheme",
    "settingDefaultGroupId",
    "settingSyncInterval",
    "settingOpenMode",
    "settingIconRetryHour",
  ]);
  const checkboxIds = new Set([
    "settingShowSearch",
    "settingFixedLayout",
    "settingTooltip",
    "settingKeyboard",
    "settingSync",
    "settingSidebarCollapsed",
  ]);

  const $ = (id) => {
    if (!fields.has(id)) {
      const tagName = selectIds.has(id) ? "SELECT" : id.startsWith("btn") ? "BUTTON" : "INPUT";
      const type = checkboxIds.has(id) ? "checkbox" : id === "settingBgFile" ? "file" : "text";
      fields.set(id, makeElement(id, { tagName, type }));
    }
    return fields.get(id);
  };

  const qsa = (selector) => {
    if (selector === "input[name='density']") return densityRadios;
    if (selector === ".group-name") return [];
    if (selector === "input, select, textarea") {
      return [...fields.values()].filter((el) => ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName));
    }
    return [];
  };

  globalThis.document = {
    createElement: (tag) => makeElement(`created_${tag}`, { tagName: tag.toUpperCase() }),
  };

  const calls = {
    openModalHtml: "",
    closed: 0,
    renders: 0,
    persists: 0,
    backups: 0,
    loadsBackground: 0,
    appliesDensity: 0,
    appliesTheme: 0,
    appliesStaticI18n: 0,
    appliesSidebarState: 0,
    clearDataCalls: [],
    deletedMarks: [],
    baselineSyncs: 0,
    settingsClockResets: 0,
    placementClockResets: 0,
    toasts: [],
  };

  let persistResult = { ok: true };
  const state = {
    settingsOpen: false,
    settingsSaving: false,
    settingsSaveQueued: false,
    settingsSaveTimer: null,
    settingsSaveNow: null,
    modalDirty: false,
  };

  const ctx = {
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    getActiveGroupId: () => activeGroupId,
    setActiveGroupId: (id) => {
      activeGroupId = id;
    },
    state,
    syncBackupBaseline: () => {
      calls.baselineSyncs += 1;
    },
    ui: {
      $,
      qsa,
      html,
      rawHtml,
      escapeHtml: (s) => String(s ?? ""),
      t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
      currentLang: () => data.settings.language || "zh-CN",
      toast: (msg, type = "success") => calls.toasts.push({ msg, type }),
      elements: { modal: {} },
      openModal: (markup) => {
        fields.clear();
        calls.openModalHtml = markup;
      },
      closeModal: () => {
        fields.clear();
        calls.closed += 1;
        state.settingsOpen = false;
      },
      runWithButtonState: async (_btn, _label, fn) => fn(),
      render: () => {
        calls.renders += 1;
      },
      persistData: async () => {
        calls.persists += 1;
        return typeof persistResult === "function" ? persistResult() : persistResult;
      },
      pushBackup: () => {
        calls.backups += 1;
      },
      loadBackground: () => {
        calls.loadsBackground += 1;
      },
      applyDensity: () => {
        calls.appliesDensity += 1;
      },
      applyTheme: () => {
        calls.appliesTheme += 1;
      },
      applyStaticI18n: () => {
        calls.appliesStaticI18n += 1;
      },
      applySidebarState: () => {
        calls.appliesSidebarState += 1;
      },
      buildLanguageOptions: () => '<option value="zh-CN">简体中文</option><option value="en">English</option>',
      setModalDirty: (dirty) => {
        state.modalDirty = !!dirty;
      },
      processPendingIconFetches: () => {},
    },
    deps: {
      normalizeUrl: (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`),
      normalizeLanguage: (v) => (v === "en" || v === "zh-CN" ? v : ""),
      normalizeSyncInterval: (v) => v || "5m",
      detectPreferredLanguage: () => "zh-CN",
      getAppVersion: () => "27.3.3",
      onSyncEnabledChanged: async () => {},
      refreshSyncInterval: () => {},
      cancelScheduledPush: () => {},
      readFileAsDataUrl: async () => "data:image/png;base64,test",
      clearData: async (useSync) => {
        calls.clearDataCalls.push(useSync);
      },
      defaultData,
      deepClone: (v) => structuredClone(v),
      cloneDataSnapshot: (v) => structuredClone(v),
      markNodeDeleted: (_d, id) => {
        calls.deletedMarks.push(id);
      },
      stampNodeFieldChanges: () => {},
      resetSettingsClockBaseline: () => {
        calls.settingsClockResets += 1;
      },
      resetPlacementClockBaseline: () => {
        calls.placementClockResets += 1;
      },
      getRootGroup: () => data.groups[0],
      getRootContainers: () => [
        data.groups[0],
        ...Object.values(data.nodes || {}).filter((n) => n?.type === "folder" && !n.deletedAt),
      ],
      getRootContainerById: (id) => (id === ALL_BOOKMARKS_GROUP_ID ? data.groups[0] : data.nodes?.[id] || null),
      isAllBookmarksGroup: (g) => g?.id === ALL_BOOKMARKS_GROUP_ID,
      refreshAllIcons: async () => {},
      ALL_BOOKMARKS_GROUP_ID,
      SYNC_INTERVAL_OPTIONS,
      DEFAULT_TOAST_DURATION_SECONDS: 5,
      SETTINGS_SAVE_DELAY_MS: 20,
      getSyncStatus: () => ({ status: "idle", state: "idle", detail: "" }),
      getPendingConflict: () => null,
      reloadSyncState: async () => ({ status: "idle", lastSyncAt: 0 }),
      resolveDocConflict: async () => ({ ok: true }),
      pullNow: async () => ({ ok: true }),
      estimateSyncProjectionBytes: () => 512,
      syncBytesBudgetLevel: () => "green",
      getSyncServerCapabilities: () => ({ deviceAuthSupported: true }),
      httpHealth: async () => ({ ok: true }),
      httpPullState: async () => ({ ok: true }),
      httpGetDevices: async () => ({
        ok: true,
        status: 200,
        data: { devices: [], deletions: {}, reclaimCandidates: [] },
      }),
      httpRetireDevice: async () => ({ ok: true }),
      ensureDevicePairing: async () => ({ ok: true }),
      getOrCreateDeviceId: async () => "dev_test",
      clearDeviceCredentials: async () => {},
      setSyncEnabledNow: async () => ({ ok: true }),
      pushNow: async () => ({ ok: true }),
      triggerSync: async () => ({ ok: true }),
      buildSyncBundleText: async () => "bundle",
      importSyncBundleText: async () => ({ ok: true }),
      parseSyncBundleText: () => ({}),
      resolveSyncConflictChoice: async () => ({ ok: true }),
    },
  };

  const ctl = createSettingsController(ctx);
  return {
    ctl,
    ctx,
    $,
    densityRadios,
    calls,
    state,
    getData: () => data,
    getActiveGroupId: () => activeGroupId,
    setPersistResult: (res) => {
      persistResult = res;
    },
  };
}

describe("settings-controller", () => {
  afterEach(() => {
    globalThis.confirm = realConfirm;
    globalThis.document = realDocument;
  });

  const clearPendingSaveTimer = (h) => {
    if (h.state.settingsSaveTimer) {
      clearTimeout(h.state.settingsSaveTimer);
      h.state.settingsSaveTimer = null;
    }
  };

  it("populates modal form fields from current settings and populates fixed default folder", () => {
    const seed = defaultData();
    seed.nodes.fld_work = { id: "fld_work", type: "folder", title: "工作", children: [] };
    seed.groups[0].nodes.push("fld_work");
    Object.assign(seed.settings, {
      showSearch: false,
      searchEngineUrl: "https://custom.search/?q=",
      fixedLayout: true,
      fixedCols: 6,
      gridDensity: "compact",
      backgroundType: "gradient",
      backgroundGradientA: "#112233",
      backgroundGradientB: "#445566",
      backgroundOverlayStrength: 0.25,
      theme: "dark",
      fontSize: 16,
      toastDuration: 9,
      defaultGroupMode: "fixed",
      defaultGroupId: "fld_work",
      openMode: "new",
      maxBackups: 12,
      iconRetryHour: 7,
      sidebarHidden: true,
    });

    const h = createHarness(seed);
    h.ctl.openSettingsModal();

    assert.equal(h.state.settingsOpen, true);
    assert.equal(h.$("settingShowSearch").checked, false);
    assert.equal(h.$("settingSearchEnginePreset").value, "custom");
    assert.equal(h.$("settingSearchEngine").disabled, false);
    assert.equal(h.$("settingFixedLayout").checked, true);
    assert.equal(h.$("settingCols").value, 6);
    assert.equal(h.densityRadios.find((r) => r.value === "compact")?.checked, true);
    assert.equal(h.$("settingBgType").value, "gradient");
    assert.equal(h.$("settingBgGradientA").value, "#112233");
    assert.equal(h.$("settingBgOverlayValue").textContent, "25%");
    assert.equal(h.$("settingTheme").value, "dark");
    assert.equal(h.$("settingFontSize").value, 16);
    assert.equal(h.$("settingToastDuration").value, 9);
    assert.equal(h.$("settingDefaultGroupId").value, "fld_work");
    assert.equal(h.$("settingDefaultGroupId").children.length, 3);
    assert.equal(h.$("settingOpenMode").value, "new");
    assert.equal(h.$("settingBackup").value, 12);
    assert.equal(h.$("settingIconRetryHour").value, "7");
    assert.equal(h.$("settingSidebarCollapsed").checked, true);
    assert.equal(h.$("settingsVersion").textContent, "27.3.3");
  });

  it("toggles search engine preset disabled state and persists updated settings via saveNow", async () => {
    const h = createHarness();
    h.ctl.openSettingsModal();

    const preset = h.$("settingSearchEnginePreset");
    const customInput = h.$("settingSearchEngine");

    preset.value = "https://www.google.com/search?q=";
    await preset.dispatch("change");
    assert.equal(customInput.value, "https://www.google.com/search?q=");
    assert.equal(customInput.disabled, true);

    preset.value = "custom";
    await preset.dispatch("change");
    assert.equal(customInput.disabled, false);
    assert.equal(customInput.focused, true);

    customInput.value = "https://duckduckgo.com/?q=";
    h.$("settingTheme").value = "light";
    h.$("settingFontSize").value = "18";
    h.$("settingOpenMode").value = "background";
    h.$("settingIconRetryHour").value = "";
    h.densityRadios.forEach((r) => {
      r.checked = r.value === "spacious";
    });

    await h.ctl.saveNow({ close: true, toastOnSave: true });

    const s = h.getData().settings;
    assert.equal(s.searchEngineUrl, "https://duckduckgo.com/?q=");
    assert.equal(s.theme, "light");
    assert.equal(s.fontSize, 18);
    assert.equal(s.gridDensity, "spacious");
    assert.equal(s.openMode, "background");
    assert.equal(s.iconRetryHour, "");
    assert.equal(s.iconRetryAtSix, false);
    assert.equal(h.calls.appliesDensity, 1);
    assert.equal(h.calls.appliesTheme, 1);
    assert.equal(h.calls.appliesStaticI18n, 1);
    assert.equal(h.calls.persists, 1);
    assert.equal(h.calls.renders, 1);
    assert.equal(h.calls.loadsBackground, 1);
    assert.equal(h.calls.closed, 1);
    assert.equal(h.calls.toasts.at(-1)?.msg, "settings.saved");
  });

  it("switches language, persists, and re-renders modal when open", async () => {
    const h = createHarness();
    h.ctl.openSettingsModal();
    const initialMarkup = h.calls.openModalHtml;
    h.calls.openModalHtml = "";

    h.$("settingLanguage").value = "en";
    await h.$("settingLanguage").dispatch("change");

    assert.equal(initialMarkup.length > 0, true);
    assert.equal(h.getData().settings.language, "en");
    assert.equal(h.calls.appliesStaticI18n, 1);
    assert.equal(h.calls.persists, 1);
    assert.ok(h.calls.openModalHtml.length > 0);
    clearPendingSaveTimer(h);
  });

  it("tombstones nodes and clears cards on success, and rolls back cleanly on write failure", async () => {
    globalThis.confirm = () => true;
    const seed = defaultData();
    seed.nodes.itm_1 = { id: "itm_1", type: "item", title: "示例", url: "https://example.com" };
    seed.groups[0].nodes.push("itm_1");

    const h = createHarness(seed);
    h.ctl.openSettingsModal();
    h.setPersistResult({ ok: false, err: "disk_full" });

    await h.$("btnClearCards").click();
    assert.ok(h.getData().nodes.itm_1, "写入失败时卡片数据应完整回滚");
    assert.equal(h.calls.baselineSyncs, 1);
    assert.equal(h.calls.settingsClockResets, 1);
    assert.equal(h.calls.placementClockResets, 1);
    assert.equal(h.calls.toasts.at(-1)?.type, "error");

    h.setPersistResult({ ok: true });
    await h.$("btnClearCards").click();
    assert.deepEqual(h.calls.deletedMarks, ["itm_1", "itm_1"]);
    assert.deepEqual(h.getData().nodes, {});
    assert.equal(h.getData().groups.length, 1);
    assert.equal(h.getData().groups[0].id, ALL_BOOKMARKS_GROUP_ID);
    assert.equal(h.calls.closed, 1);
    assert.equal(h.calls.toasts.at(-1)?.msg, "toast.cardsCleared");
  });

  it("rolls back full data reset when btnClearData persistence fails", async () => {
    globalThis.confirm = () => true;
    const seed = defaultData();
    seed.settings.syncEnabled = true;
    seed.settings.language = "en";
    seed.nodes.itm_keep = { id: "itm_keep", type: "item", title: "保留", url: "https://keep.example" };
    seed.groups[0].nodes.push("itm_keep");

    const h = createHarness(seed);
    h.ctl.openSettingsModal();
    h.setPersistResult({ ok: false, err: "write_blocked" });

    await h.$("btnClearData").click();

    assert.deepEqual(h.calls.clearDataCalls, [false, true]);
    assert.ok(h.getData().nodes.itm_keep, "清空数据落盘失败后必须恢复原数据");
    assert.equal(h.getData().settings.syncEnabled, true);
    assert.equal(h.calls.baselineSyncs, 1);
    assert.equal(h.calls.settingsClockResets, 1);
    assert.equal(h.calls.placementClockResets, 1);
    assert.equal(h.calls.closed, 0);
    assert.equal(h.calls.toasts.at(-1)?.type, "error");
  });
});
