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
      },
      qsa: () => [],
      elements: { modal: {} },
    },
    deps: {
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
    deps: { cloneDataSnapshot: structuredClone, repairHomepageData: (value) => value, defaultSettings: () => ({}) },
  });
  openBackupModal();
  await restore();
  assert.equal(data, original);
  assert.equal(baseline, original);
  assert.equal(notice.type, "error");
  assert.match(notice.text, /disk-full/);
});
