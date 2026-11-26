import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCommandPaletteActions, collectBatchMoveTargets } from "../src/js/app-actions.js";

describe("app-actions", () => {
  it("excludes selected folder and its descendants from batch move targets to prevent cycles", () => {
    const data = {
      groups: [{ id: "grp_all", name: "全部", systemAllGroup: true, nodes: ["fld_parent", "fld_other"] }],
      nodes: {
        fld_parent: { id: "fld_parent", type: "folder", title: "Parent", children: ["fld_child", "itm_1"] },
        fld_child: { id: "fld_child", type: "folder", title: "Child", children: [] },
        fld_other: { id: "fld_other", type: "folder", title: "Other", children: [] },
        itm_1: { id: "itm_1", type: "item", title: "A", url: "https://a.test" },
      },
    };
    const targets = collectBatchMoveTargets({
      data,
      selectedIds: ["fld_parent"],
      getRootGroup: () => data.groups[0],
      t: (k) => k,
    });
    assert.deepEqual(
      targets.map((item) => item.id),
      ["grp_all", "fld_other"],
    );
  });

  it("builds command palette actions and routes sync action by syncEnabled state", () => {
    const calls = [];
    let syncEnabled = false;
    const actions = buildCommandPaletteActions({
      t: (k) => k,
      openAddModal: () => calls.push("add"),
      openSettingsModal: () => calls.push("settings"),
      getData: () => ({ settings: { syncEnabled } }),
      pullNow: (reason) => calls.push(`pull:${reason}`),
      clickDedupeButton: () => calls.push("dedupe"),
      toggleTheme: () => calls.push("theme"),
      toggleSidebar: () => calls.push("sidebar"),
    });
    assert.equal(actions.length, 6);
    actions.find((a) => a.id === "action:sync").run();
    syncEnabled = true;
    actions.find((a) => a.id === "action:sync").run();
    assert.deepEqual(calls, ["settings", "pull:manual"]);
  });
});
