import assert from "node:assert/strict";
import { it } from "node:test";
import * as bookmarkHtml from "../src/js/bookmark-html.js";
import * as dataUtils from "../src/js/data-utils.js";
import { createImportExport } from "../src/js/import-export.js";
import { normalizeUrl, normalizeUrlWithScheme } from "../src/js/shared-utils.js";
import { defaultData, defaultSettings } from "../src/js/storage.js";
import { exportSyncBundle, importSyncBundle } from "../src/js/sync_bundle.js";
import { mergeHomepage } from "../src/js/sync_merge.js";
import { toSyncDocument } from "../src/js/sync_projection.js";
import { html, rawHtml, runWithButtonState } from "../src/js/ui-utils.js";

// 真实按钮处理器配合内存控件、合成书签和模拟磁盘；不启动浏览器或真实同步服务。
function fixture() {
  const value = defaultData();
  value.nodes.old = { id: "old", type: "item", title: "原书签", url: "https://old.invalid/", updatedAt: 1 };
  value.groups[0].nodes = ["old"];
  return value;
}
const formats = ["replace", "merge", "add", "urls", "html", "sync-file", "sync-clipboard"];

async function exercise(format, failure) {
  const original = fixture();
  const snapshot = structuredClone(original);
  let data = original;
  const effects = { render: 0, close: 0, icons: 0, writes: 0, notices: [] };
  let mode = failure;
  let baseline = original;
  const settingsBaseline = original;
  const placementBaseline = original;
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) {
      const field = {
        value: "",
        textContent: id,
        disabled: false,
        isConnected: true,
        addEventListener: (name, fn) => {
          field[name] = fn;
        },
        setAttribute() {},
        removeAttribute() {},
      };
      fields.set(id, field);
    }
    return fields.get(id);
  };
  const incoming = defaultData();
  incoming.nodes.fresh = {
    id: "fresh",
    type: "item",
    title: "新增书签",
    url: "https://fresh.invalid/",
    updatedAt: Date.now(),
  };
  incoming.groups[0].nodes = ["fresh"];
  const bundle = exportSyncBundle(incoming, { deviceId: "fixture", docId: "fixture-doc" });
  const oldClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: async () => JSON.stringify(bundle) },
  });
  const ctl = createImportExport(
    {
      getData: () => data,
      setData: (next) => {
        data = next;
      },
      getActiveGroupId: () => "grp_all",
      syncBackupBaseline: (next) => {
        baseline = next;
      },
      ui: {
        $,
        html,
        rawHtml,
        runWithButtonState,
        t: (key, vars) => `${key}${vars?.reason ? `: ${vars.reason}` : ""}`,
        elements: { modalOverlay: { addEventListener() {}, removeEventListener() {} } },
        openModal() {},
        leaveSettingsForSubpanel() {},
        closeModal: () => {
          effects.close++;
        },
        render: () => {
          effects.render++;
        },
        processPendingIconFetches: () => {
          effects.icons++;
        },
        toast: (text, type = "success") => effects.notices.push({ text, type }),
        pushBackup: () => data.backups.unshift({ id: "before-import", data: structuredClone(data) }),
        persistData: async () => {
          effects.writes++;
          // 模拟真实持久化链会修改备份及字段时钟，不只返回一条错误。
          data.lastUpdated = 123456;
          data._syncMeta = { mutatedDuringSave: true };
          if (mode === "throw") throw new Error("disk-full");
          if (mode === "return") return { ok: false, err: "disk-full" };
          effects.saved = structuredClone(data);
          return { ok: true };
        },
      },
      deps: {
        ...dataUtils,
        ...bookmarkHtml,
        cloneDataSnapshot: structuredClone,
        defaultSettings,
        normalizeUrl,
        normalizeUrlWithScheme,
        mergeHomepage,
        toSyncDocument,
        importSyncBundle,
        getOrCreateDeviceId: async () => "fixture",
        createDocId: () => "fixture-doc",
        resetSettingsClockBaseline() {},
        resetPlacementClockBaseline() {},
        getRootGroup: () => data.groups[0],
        getRootContainers: () => data.groups,
        getRootContainerById: (id) => data.groups.find((group) => group.id === id),
        getPlacementList: (group) => [...group.nodes],
        setPlacementList: (group, nodes) => {
          group.nodes = nodes;
        },
        touchPlacementContainer() {},
      },
    },
    () => {},
  );
  try {
    ctl.bindButtons();
    let submit;
    if (["replace", "merge", "add"].includes(format)) {
      await ctl.openImportModal();
      $("importText").value = JSON.stringify(incoming);
      $("importMode").value = format;
      submit = () => $("btnImportNow").click();
    } else if (format === "urls") {
      ctl.openImportUrlModal();
      $("importUrlText").value = "fresh.invalid";
      submit = () => $("btnImportUrlHttps").click();
    } else if (format === "sync-clipboard") {
      submit = () => $("btnSyncImportBundle").click();
    } else {
      const input = $(format === "html" ? "importBookmarksHtmlInput" : "syncImportFileInput");
      input.files = [
        {
          name: "fixture",
          text: async () =>
            format === "html" ? '<DL><DT><A HREF="https://fresh.invalid/">新增书签</A></DL>' : JSON.stringify(bundle),
        },
      ];
      submit = () => input.change({ target: input });
    }
    effects.notices = [];
    await submit();
    assert.equal(effects.writes, 1);
    assert.equal(data, original, "失败后恢复原对象引用");
    assert.deepEqual(original, snapshot, "追加、备份及时钟变更不能污染原数据");
    assert.equal(baseline, original);
    assert.equal(settingsBaseline, original);
    assert.equal(placementBaseline, original);
    assert.equal(effects.render, 0);
    assert.equal(effects.close, 0);
    assert.equal(effects.icons, 0);
    assert.ok(effects.notices.some((entry) => entry.type === "error" && entry.text.includes("disk-full")));
    assert.equal(
      effects.notices.some((entry) => entry.type === "success"),
      false,
    );
    // 不重开面板就能重试：重试成功才展示成功与刷新，不能把按钮永久锁住。
    mode = null;
    effects.notices = [];
    await submit();
    assert.ok(
      effects.saved && Object.values(effects.saved.nodes).some((node) => node.url === "https://fresh.invalid/"),
    );
    assert.equal(effects.render, 1);
    assert.ok(effects.notices.some((entry) => entry.type === "success"));
  } finally {
    if (oldClipboard) Object.defineProperty(navigator, "clipboard", oldClipboard);
    else delete navigator.clipboard;
  }
}
for (const format of formats) {
  for (const failure of ["return", "throw"]) {
    it(`${format} 导入写盘 ${failure} 失败保全原数据且可重试`, () => exercise(format, failure));
  }
}

it("导入写盘失败回滚时保留持久化等待期间的并发编辑与其它标签页写入", async () => {
  // 场景 A：同一标签页在 persistData 等待期间并发新增了书签并修改了设置
  const original = fixture();
  let data = original;
  const notices = [];
  const fields = new Map();
  const $ = (id) => {
    if (!fields.has(id)) {
      const field = {
        value: "",
        addEventListener: (name, fn) => {
          field[name] = fn;
        },
      };
      fields.set(id, field);
    }
    return fields.get(id);
  };
  let concurrentMode = "in-place";
  const externalTabData = fixture();
  externalTabData.nodes.remote_tab = {
    id: "remote_tab",
    type: "item",
    title: "跨标签页写入",
    url: "https://remote-tab.invalid/",
    updatedAt: 99,
  };
  externalTabData.groups[0].nodes = ["old", "remote_tab"];

  const ctl = createImportExport(
    {
      getData: () => data,
      setData: (next) => {
        data = next;
      },
      getActiveGroupId: () => "grp_all",
      syncBackupBaseline() {},
      ui: {
        $,
        html,
        rawHtml,
        runWithButtonState,
        t: (key) => key,
        elements: { modalOverlay: { addEventListener() {}, removeEventListener() {} } },
        openModal() {},
        leaveSettingsForSubpanel() {},
        closeModal() {},
        render() {},
        processPendingIconFetches() {},
        toast: (text, type = "success") => notices.push({ text, type }),
        pushBackup: () => data.backups.unshift({ id: "before-import", data: structuredClone(data) }),
        persistData: async () => {
          if (concurrentMode === "in-place") {
            // 模拟持久化异步等待期间，用户在当前页并发新增了一个书签并改了字号
            data.nodes.concurrent_edit = {
              id: "concurrent_edit",
              type: "item",
              title: "并发新增",
              url: "https://concurrent.invalid/",
              updatedAt: 50,
            };
            data.groups[0].nodes.push("concurrent_edit");
            data.settings.fontSize = 18;
          } else if (concurrentMode === "other-tab") {
            // 模拟持久化异步等待期间，另一标签页触发 reloadFromStorage 替换了 data
            data = externalTabData;
          }
          return { ok: false, err: "disk-full" };
        },
      },
      deps: {
        ...dataUtils,
        ...bookmarkHtml,
        cloneDataSnapshot: structuredClone,
        defaultSettings,
        normalizeUrl,
        normalizeUrlWithScheme,
        mergeHomepage,
        toSyncDocument,
        importSyncBundle,
        getOrCreateDeviceId: async () => "fixture",
        createDocId: () => "fixture-doc",
        resetSettingsClockBaseline() {},
        resetPlacementClockBaseline() {},
        getRootGroup: () => data.groups[0],
        getRootContainers: () => data.groups,
        getRootContainerById: (id) => data.groups.find((group) => group.id === id),
        getPlacementList: (group) => [...group.nodes],
        setPlacementList: (group, nodes) => {
          group.nodes = nodes;
        },
        touchPlacementContainer() {},
      },
    },
    () => {},
  );

  ctl.openImportUrlModal();
  $("importUrlText").value = "fresh.invalid";
  await $("btnImportUrlHttps").click();

  assert.equal(data, original, "回滚到原数据对象");
  assert.equal(
    Object.values(data.nodes).some((n) => n.url === "https://fresh.invalid/"),
    false,
    "失败的导入条目被回滚",
  );
  assert.equal(data.backups.length, 0, "失败导入产生的备份被回滚");
  assert.ok(data.nodes.concurrent_edit, "导入期间并发新增的节点被保留");
  assert.ok(data.groups[0].nodes.includes("concurrent_edit"), "并发新增节点的放置顺序被保留");
  assert.equal(data.settings.fontSize, 18, "导入期间并发修改的设置被保留");

  // 场景 B：持久化等待期间其它标签页写入并重载了 data，失败回滚不能用旧快照抹掉新标签页数据
  concurrentMode = "other-tab";
  await $("btnImportUrlHttps").click();
  assert.equal(data, externalTabData, "其它标签页重载的新数据未被旧快照覆盖");
  assert.ok(data.nodes.remote_tab);
});
