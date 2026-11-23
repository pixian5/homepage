import assert from "node:assert/strict";
import { it } from "node:test";
import { createSettingsController } from "../src/js/settings-controller.js";
import { html, rawHtml } from "../src/js/ui-utils.js";

// 通过设置控制器的公开入口测试，使用与 app.js 相同的 ui/deps 分层。
function makePanel() {
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) {
      const field = { addEventListener: (type, fn) => (field[type] = fn) };
      fields.set(id, field);
    }
    return fields.get(id);
  };
  let data = { settings: {}, nodes: {}, groups: [], backups: [] };
  let saved;
  const panels = [];
  const ctl = createSettingsController({
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    ui: {
      $,
      html,
      rawHtml,
      leaveSettingsForSubpanel() {},
      openModal: (markup) => panels.push(markup),
      closeModal() {},
      toast() {},
      render() {},
      pushBackup() {},
      processPendingIconFetches() {},
      persistData: () => {
        saved = structuredClone(data);
        return { ok: true };
      },
      qsa: () => [],
      elements: { modal: {} },
    },
    deps: {
      cloneDataSnapshot: structuredClone,
      defaultSettings: () => ({}),
      repairHomepageData: (incoming) => incoming,
      resetSettingsClockBaseline() {},
      resetPlacementClockBaseline() {},
      normalizeUrl: (url) => url,
    },
  });
  return { ctl, $, panels, saved: () => saved };
}

it("设置入口的覆盖导入写回创建它的实例，而不是最后打开的面板", async () => {
  const first = makePanel();
  const second = makePanel();
  await first.ctl.openImportModal();
  assert.match(first.panels[0], /id="importText"/);
  first.$("importText").value = JSON.stringify({ schemaVersion: 2, settings: { fontSize: 17 }, nodes: {} });
  first.$("importMode").value = "replace";
  await first.$("btnImportNow").click();
  assert.equal(first.saved()?.settings.fontSize, 17);
  assert.equal(second.saved(), undefined);
  assert.equal(second.panels.length, 0);
  second.ctl.openBackupModal();
  assert.match(second.panels[0], /暂无备份/);
});

it("备份恢复写盘失败时保留原数据、备份基线和面板", async () => {
  const original = { settings: { fontSize: 13 }, backups: [{ id: "chosen", data: { settings: { fontSize: 22 } } }] };
  let data = original;
  let baseline;
  let restore;
  let notice;
  const { openBackupModal } = createSettingsController({
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    syncBackupBaseline: (next) => {
      baseline = next;
    },
    ui: {
      html,
      rawHtml,
      elements: {},
      openModal() {},
      leaveSettingsForSubpanel() {},
      closeModal: () => assert.fail("失败时不应关闭面板"),
      $: () => ({ addEventListener() {} }),
      qsa: (selector) =>
        selector === ".backup-restore"
          ? [
              {
                closest: () => ({ dataset: { backup: "chosen" } }),
                addEventListener: (_, handler) => {
                  restore = handler;
                },
              },
            ]
          : [],
      persistData: async () => ({ ok: false, err: "disk-full" }),
      toast: (text, type) => {
        notice = { text, type };
      },
    },
    deps: {
      cloneDataSnapshot: structuredClone,
      repairHomepageData: (value) => value,
      defaultSettings: () => ({}),
      resetSettingsClockBaseline: (next) => {
        settingsBaseline = next;
      },
      resetPlacementClockBaseline: (next) => {
        placementBaseline = next;
      },
    },
  });
  let settingsBaseline;
  let placementBaseline;
  openBackupModal();
  await restore();
  assert.equal(data, original);
  assert.equal(baseline, original);
  assert.equal(settingsBaseline, original);
  assert.equal(placementBaseline, original);
  assert.equal(notice.type, "error");
  assert.match(notice.text, /disk-full/);
});

it("备份删除写盘失败时保留原备份列表、不提示已删除，重试成功后才删除并刷新", async () => {
  const original = {
    settings: { fontSize: 13 },
    backups: [
      { id: "b1", ts: 1000, data: { settings: { fontSize: 12 } } },
      { id: "b2", ts: 2000, data: { settings: { fontSize: 14 } } },
    ],
  };
  let data = original;
  let baseline;
  let deleteHandler;
  const notices = [];
  let modalOpenCount = 0;
  let failMode = "return";
  const { openBackupModal } = createSettingsController({
    getData: () => data,
    setData: (next) => {
      data = next;
    },
    syncBackupBaseline: (next) => {
      baseline = next;
    },
    ui: {
      html,
      rawHtml,
      elements: {},
      openModal: () => {
        modalOpenCount += 1;
      },
      leaveSettingsForSubpanel() {},
      closeModal() {},
      $: () => ({ addEventListener() {} }),
      qsa: (selector) =>
        selector === ".backup-delete"
          ? [
              {
                closest: () => ({ dataset: { backup: "b1" } }),
                addEventListener: (_, handler) => {
                  deleteHandler = handler;
                },
              },
            ]
          : [],
      persistData: async () => {
        if (failMode === "return") return { ok: false, err: "disk-full" };
        if (failMode === "throw") throw new Error("io-error");
        return { ok: true };
      },
      toast: (text, type = "success") => {
        notices.push({ text, type });
      },
    },
    deps: {
      cloneDataSnapshot: structuredClone,
      repairHomepageData: (value) => value,
      defaultSettings: () => ({}),
      resetSettingsClockBaseline() {},
      resetPlacementClockBaseline() {},
    },
  });

  openBackupModal();
  assert.equal(modalOpenCount, 1);

  // 1. 返回 { ok: false }
  await deleteHandler();
  assert.equal(data, original, "返回失败时恢复原数据引用");
  assert.equal(data.backups.length, 2, "备份列表未丢失");
  assert.equal(baseline, original);
  assert.equal(modalOpenCount, 1, "失败时不重绘备份弹窗");
  assert.ok(notices.some((n) => n.type === "error" && n.text.includes("disk-full")));
  assert.equal(
    notices.some((n) => n.text.includes("已删除备份")),
    false,
  );

  // 2. 抛出异常
  notices.length = 0;
  failMode = "throw";
  await deleteHandler();
  assert.equal(data, original, "抛异常时恢复原数据引用");
  assert.equal(data.backups.length, 2);
  assert.equal(modalOpenCount, 1);
  assert.ok(notices.some((n) => n.type === "error" && n.text.includes("io-error")));

  // 3. 重试成功
  notices.length = 0;
  failMode = null;
  await deleteHandler();
  assert.equal(data.backups.length, 1);
  assert.equal(data.backups[0].id, "b2");
  assert.equal(modalOpenCount, 2, "成功后重新渲染备份列表弹窗");
  assert.ok(notices.some((n) => n.type === "success" && n.text === "已删除备份"));
});

it("清空卡片与清空数据写盘失败时恢复原数据、分组与基线且不关闭面板", async () => {
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) {
      const field = {
        value: "",
        checked: false,
        disabled: false,
        isConnected: true,
        dataset: {},
        classList: { toggle() {} },
        replaceChildren() {},
        appendChild() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener: (type, fn) => {
          field[type] = fn;
        },
      };
      fields.set(id, field);
    }
    return fields.get(id);
  };
  const original = {
    settings: { fontSize: 16, language: "zh-CN" },
    nodes: { itm_1: { id: "itm_1", type: "item", title: "保留项", url: "https://keep.invalid/" } },
    groups: [{ id: "grp_all", name: "全部", order: -1, nodes: ["itm_1"], systemAllGroup: true }],
    backups: [],
  };
  let data = original;
  let activeGroupId = "grp_custom";
  let baseline;
  let settingsBaseline;
  let placementBaseline;
  let closed = 0;
  let rendered = 0;
  const notices = [];
  const oldConfirm = globalThis.confirm;
  const oldDocument = globalThis.document;
  globalThis.confirm = () => true;
  globalThis.document = { createElement: () => ({}) };
  try {
    const ctl = createSettingsController({
      getData: () => data,
      setData: (next) => {
        data = next;
      },
      getActiveGroupId: () => activeGroupId,
      setActiveGroupId: (id) => {
        activeGroupId = id;
      },
      state: {},
      syncBackupBaseline: (next) => {
        baseline = next;
      },
      ui: {
        $,
        qsa: () => [],
        html,
        rawHtml,
        escapeHtml: (s) => String(s),
        t: (k, vars) => (vars?.reason ? `${k}: ${vars.reason}` : k),
        currentLang: () => "zh-CN",
        toast: (text, type = "success") => notices.push({ text, type }),
        elements: { modal: {} },
        openModal() {},
        closeModal: () => {
          closed += 1;
        },
        runWithButtonState: async (_btn, _label, fn) => fn(),
        render: () => {
          rendered += 1;
        },
        persistData: async () => ({ ok: false, err: "disk-full" }),
        pushBackup: () => data.backups.unshift({ id: "bk", data: structuredClone(data) }),
        processPendingIconFetches() {},
        loadBackground() {},
        applyDensity() {},
        applyTheme() {},
        applyStaticI18n() {},
        applySidebarState() {},
        buildLanguageOptions: () => "",
        leaveSettingsForSubpanel() {},
        readFileAsDataUrl: async () => "",
        getAppVersion: () => "27.2.0",
        detectExtensionPlatform: () => "chrome",
        detectPreferredLanguage: () => "zh-CN",
      },
      deps: {
        normalizeUrl: (u) => u,
        normalizeUrlWithScheme: (u) => u,
        normalizeLanguage: (l) => l,
        normalizeSyncInterval: (v) => v || "5m",
        clearData: async () => {},
        defaultData: () => ({
          settings: { language: "zh-CN" },
          nodes: {},
          groups: [{ id: "grp_all", name: "全部", order: -1, nodes: [], systemAllGroup: true }],
          backups: [],
        }),
        defaultSettings: () => ({}),
        deepClone: structuredClone,
        cloneDataSnapshot: structuredClone,
        repairHomepageData: (v) => v,
        markNodeDeleted: (d, id) => {
          delete d.nodes[id];
        },
        stampNodeFieldChanges() {},
        resetSettingsClockBaseline: (next) => {
          settingsBaseline = next;
        },
        resetPlacementClockBaseline: (next) => {
          placementBaseline = next;
        },
        getRootGroup: () => data.groups[0],
        getRootContainers: () => data.groups,
        getRootContainerById: (id) => data.groups.find((g) => g.id === id),
        isAllBookmarksGroup: (g) => g?.id === "grp_all",
        refreshAllIcons: async () => {},
        syncBytesBudgetLevel: () => "green",
        estimateSyncProjectionBytes: () => 0,
        createDocId: () => "doc_1",
        getOrCreateDeviceId: async () => "dev_1",
        getSyncStatus: () => ({ status: "off" }),
        getPendingConflict: () => null,
        reloadSyncState: async () => ({ status: "off" }),
        ALL_BOOKMARKS_GROUP_ID: "grp_all",
        SYNC_INTERVAL_OPTIONS: [{ value: "5m" }],
        DEFAULT_TOAST_DURATION_SECONDS: 5,
        SETTINGS_SAVE_DELAY_MS: 120,
      },
    });

    ctl.openSettingsModal();
    await $("btnClearCards").click();
    assert.equal(data, original, "清空卡片写盘失败时恢复原对象");
    assert.ok(data.nodes.itm_1, "原卡片未丢失");
    assert.equal(data.backups.length, 0, "失败时备份未污染原对象");
    assert.equal(activeGroupId, "grp_custom", "活跃分组回滚");
    assert.equal(baseline, original);
    assert.equal(settingsBaseline, original);
    assert.equal(placementBaseline, original);
    assert.equal(closed, 0);
    assert.equal(rendered, 0);
    assert.ok(notices.some((n) => n.type === "error" && n.text.includes("disk-full")));

    notices.length = 0;
    await $("btnClearData").click();
    assert.equal(data, original, "清空数据写盘失败时恢复原对象");
    assert.equal(activeGroupId, "grp_custom");
    assert.equal(closed, 0);
    assert.equal(rendered, 0);
    assert.ok(notices.some((n) => n.type === "error" && n.text.includes("disk-full")));
  } finally {
    globalThis.confirm = oldConfirm;
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

it("导入导出与备份管理子弹窗遵循注入的多语言翻译，不泄露中文硬编码", async () => {
  const { translateAppText } = await import("../src/js/app-i18n.js");
  for (const lang of ["en", "ja"]) {
    const fields = new Map();
    const $ = (id) => {
      if (!fields.has(id)) {
        const field = { value: "", addEventListener() {} };
        fields.set(id, field);
      }
      return fields.get(id);
    };
    const modals = [];
    const data = {
      settings: {},
      nodes: {},
      groups: [{ id: "grp_all", name: "All", order: -1, nodes: [], systemAllGroup: true }],
      backups: [],
    };
    const ctl = createSettingsController({
      getData: () => data,
      setData: () => {},
      getActiveGroupId: () => "grp_all",
      ui: {
        $,
        qsa: () => [],
        html,
        rawHtml,
        t: (key, vars) => translateAppText(lang, key, vars),
        elements: { modal: {}, modalOverlay: { addEventListener() {}, removeEventListener() {} } },
        openModal: (markup) => modals.push(markup),
        closeModal() {},
        leaveSettingsForSubpanel() {},
        toast() {},
        render() {},
        pushBackup() {},
        processPendingIconFetches() {},
        persistData: async () => ({ ok: true }),
      },
      deps: {
        getRootGroup: () => data.groups[0],
        getRootContainers: () => data.groups,
        isAllBookmarksGroup: () => true,
        RECENT_GROUP_ID: "__recent__",
      },
    });
    await ctl.openImportModal();
    ctl.openImportUrlModal();
    ctl.openBackupModal();
    assert.equal(modals.length, 3);
    for (const markup of modals) {
      if (lang === "en") {
        assert.equal(/[\u4e00-\u9fff]/.test(markup), false, `en 模式下不应出现中文硬编码: ${markup}`);
      } else {
        assert.match(markup, /[\u3040-\u30ff]/, `ja 模式下应渲染日文假名文案: ${markup}`);
        for (const zhWord of ["导入设置", "导入网址", "备份管理", "暂无备份"]) {
          assert.equal(markup.includes(zhWord), false, `ja 模式下不应残留中文 ${zhWord}`);
        }
      }
    }
  }
});
