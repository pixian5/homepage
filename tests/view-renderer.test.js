import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createViewRenderer } from "../src/js/view-renderer.js";

function createMockElement() {
  return {
    classList: {
      _classes: new Set(),
      toggle(cls, force) {
        if (force === undefined) {
          if (this._classes.has(cls)) this._classes.delete(cls);
          else this._classes.add(cls);
        } else if (force) {
          this._classes.add(cls);
        } else {
          this._classes.delete(cls);
        }
      },
      contains(cls) {
        return this._classes.has(cls);
      },
      remove(cls) {
        this._classes.delete(cls);
      },
      add(cls) {
        this._classes.add(cls);
      },
    },
    checked: false,
  };
}

describe("view-renderer", () => {
  it("orchestrates all rendering sub-pipelines in correct sequence", () => {
    let allBookmarksEnsured = false;
    let staticI18nApplied = false;
    let sidebarStateApplied = false;
    let groupsRendered = false;
    let gridRendered = false;
    let emptyStateUpdated = false;
    let toolbarUpdated = false;
    let controlsUpdated = false;
    let themeApplied = false;
    let bgRefreshed = false;

    const topSearchWrap = createMockElement();
    const emptyHintToggle = createMockElement();
    const btnFolderDissolve = createMockElement();
    btnFolderDissolve.classList.add("hidden");

    const data = {
      settings: {
        showSearch: false,
        emptyHintDisabled: true,
      },
    };

    const renderer = createViewRenderer({
      getData: () => data,
      getElements: () => ({
        topSearchWrap,
        emptyHintToggle,
        btnFolderDissolve,
      }),
      ensureAllBookmarksGroup: () => {
        allBookmarksEnsured = true;
      },
      applyStaticI18n: () => {
        staticI18nApplied = true;
      },
      getSidebarMgr: () => ({
        applySidebarState: () => {
          sidebarStateApplied = true;
        },
        renderGroups: () => {
          groupsRendered = true;
        },
      }),
      getGridRenderer: () => ({
        renderGrid: () => {
          gridRendered = true;
        },
        updateEmptyState: () => {
          emptyStateUpdated = true;
        },
      }),
      getOpenModeMgr: () => ({
        updateToolbarButton: () => {
          toolbarUpdated = true;
        },
      }),
      getSelectionMgr: () => ({
        updateControls: () => {
          controlsUpdated = true;
        },
      }),
      getThemeMgr: () => ({
        applyThemeAndDensity: () => {
          themeApplied = true;
        },
        refreshBackgroundIfChanged: async () => {
          bgRefreshed = true;
        },
      }),
    });

    renderer.render();

    assert.equal(allBookmarksEnsured, true);
    assert.equal(staticI18nApplied, true);
    assert.equal(sidebarStateApplied, true);
    assert.equal(groupsRendered, true);
    assert.equal(gridRendered, true);
    assert.equal(emptyStateUpdated, true);
    assert.equal(toolbarUpdated, true);
    assert.equal(controlsUpdated, true);
    assert.equal(themeApplied, true);
    assert.equal(bgRefreshed, true);

    // showSearch 为 false 时 topSearchWrap 应带有 hidden
    assert.equal(topSearchWrap.classList.contains("hidden"), true);
    assert.equal(emptyHintToggle.checked, true);
    assert.equal(btnFolderDissolve.classList.contains("hidden"), false);
  });

  it("handles null data and missing managers safely without throwing", () => {
    const renderer = createViewRenderer({
      getData: () => null,
      getElements: () => null,
    });
    assert.doesNotThrow(() => {
      renderer.render();
    });
  });
});
