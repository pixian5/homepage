import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bindAppDomEvents } from "../src/js/app-events-binder.js";

function createMockElement(tagName = "div") {
  const listeners = {};
  return {
    tagName,
    listeners,
    classList: {
      _classes: new Set(),
      contains(c) {
        return this._classes.has(c);
      },
      add(c) {
        this._classes.add(c);
      },
      remove(c) {
        this._classes.delete(c);
      },
    },
    style: {},
    addEventListener(event, handler) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    trigger(event, evObj = {}) {
      const handlers = listeners[event] || [];
      for (const h of handlers) {
        h({ target: this, ...evObj });
      }
    },
    contains() {
      return false;
    },
    closest() {
      return null;
    },
    getAttribute() {
      return null;
    },
  };
}

describe("app-events-binder", () => {
  it("toggles sidebar collapsed state on btnToggleSidebar click", () => {
    const btnToggleSidebar = createMockElement("button");
    const data = { settings: { sidebarCollapsed: false } };
    let sidebarApplied = false;
    let persistQueued = false;

    bindAppDomEvents({
      elements: { btnToggleSidebar },
      getData: () => data,
      getState: () => ({ activeGroupId: "g1", openFolderId: null, settingsOpen: false }),
      setState: () => {},
      actions: {
        queuePersist: () => {
          persistQueued = true;
        },
      },
      managers: {
        sidebarMgr: {
          applySidebarState: () => {
            sidebarApplied = true;
          },
        },
      },
      constants: { recentGroupId: "__recent__" },
      t: (k) => k,
    });

    btnToggleSidebar.trigger("click");
    assert.equal(data.settings.sidebarCollapsed, true);
    assert.equal(sidebarApplied, true);
    assert.equal(persistQueued, true);
  });

  it("switches to recent tab and loads history", async () => {
    const recentTab = createMockElement("button");
    const data = { settings: { lastActiveGroupId: "g1" } };
    let nextState = null;
    let rendered = false;
    let historyFetched = false;

    bindAppDomEvents({
      elements: { recentTab },
      getData: () => data,
      getState: () => ({ activeGroupId: "g1", openFolderId: null, settingsOpen: false }),
      setState: (patch) => {
        nextState = patch;
      },
      actions: {
        queuePersist: () => {},
        fetchRecentHistory: async () => {
          historyFetched = true;
          return [{ id: "h1" }];
        },
        setRecentItems: (items) => {
          assert.equal(items.length, 1);
        },
        render: () => {
          rendered = true;
        },
      },
      managers: {},
      constants: { recentGroupId: "__recent__" },
      t: (k) => k,
    });

    recentTab.trigger("click");
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(nextState?.activeGroupId, "__recent__");
    assert.equal(nextState?.openFolderId, null);
    assert.equal(data.settings.lastActiveGroupId, "__recent__");
    assert.equal(historyFetched, true);
    assert.equal(rendered, true);
  });

  it("adds new group folder on btnAddGroup click", () => {
    const btnAddGroup = createMockElement("button");
    const rootGroup = { id: "root", nodes: [] };
    const data = { nodes: {}, settings: {} };
    let touched = false;
    let nextState = null;
    let rendered = false;

    bindAppDomEvents({
      elements: { btnAddGroup },
      getData: () => data,
      getState: () => ({ activeGroupId: "root", openFolderId: null, settingsOpen: false }),
      setState: (patch) => {
        nextState = patch;
      },
      actions: {
        getRootGroup: () => rootGroup,
        touchPlacementContainer: () => {
          touched = true;
        },
        queuePersist: () => {},
        render: () => {
          rendered = true;
        },
      },
      managers: {},
      constants: { recentGroupId: "__recent__" },
      t: () => "新分组",
    });

    btnAddGroup.trigger("click");

    assert.equal(rootGroup.nodes.length, 1);
    const newFolderId = rootGroup.nodes[0];
    assert.ok(data.nodes[newFolderId]);
    assert.equal(data.nodes[newFolderId].title, "新分组");
    assert.equal(touched, true);
    assert.equal(nextState?.activeGroupId, newFolderId);
    assert.equal(rendered, true);
  });

  it("handles modal overlay click to close unless pointer started inside dialog", () => {
    const modalOverlay = createMockElement("div");
    let modalClosed = false;

    bindAppDomEvents({
      elements: { modalOverlay },
      getData: () => ({}),
      getState: () => ({ activeGroupId: "g1", openFolderId: null, settingsOpen: false }),
      setState: () => {},
      actions: {
        closeModal: () => {
          modalClosed = true;
        },
      },
      managers: {},
      constants: { recentGroupId: "__recent__" },
      t: (k) => k,
    });

    // 模拟在遮罩本身点击
    modalOverlay.trigger("click", { target: modalOverlay });
    assert.equal(modalClosed, true);

    // 模拟内部按下拖出并在外部抬起
    modalClosed = false;
    const innerTarget = { closest: (sel) => (sel === "#modal" ? {} : null) };
    modalOverlay.trigger("mousedown", { target: innerTarget });
    modalOverlay.trigger("click", { target: modalOverlay });
    // 应该被拦截防止误关
    assert.equal(modalClosed, false);
  });

  it("toggles settings modal via btnSettings", () => {
    const btnSettings = createMockElement("button");
    let settingsOpenState = false;
    let openedSettings = false;
    let closedModal = false;

    bindAppDomEvents({
      elements: { btnSettings },
      getData: () => ({}),
      getState: () => ({ activeGroupId: "g1", openFolderId: null, settingsOpen: settingsOpenState }),
      setState: () => {},
      actions: {
        openSettingsModal: () => {
          openedSettings = true;
        },
        closeModal: () => {
          closedModal = true;
        },
      },
      managers: {},
      constants: { recentGroupId: "__recent__" },
      t: (k) => k,
    });

    btnSettings.trigger("click");
    assert.equal(openedSettings, true);

    settingsOpenState = true;
    btnSettings.trigger("click");
    assert.equal(closedModal, true);
  });

  it("updates empty hint disabled setting on checkbox change", async () => {
    const emptyHintToggle = createMockElement("input");
    const data = { settings: { emptyHintDisabled: false } };
    let persisted = false;
    let rendered = false;

    bindAppDomEvents({
      elements: { emptyHintToggle },
      getData: () => data,
      getState: () => ({ activeGroupId: "g1", openFolderId: null, settingsOpen: false }),
      setState: () => {},
      actions: {
        persistData: async () => {
          persisted = true;
        },
        render: () => {
          rendered = true;
        },
      },
      managers: {},
      constants: { recentGroupId: "__recent__" },
      t: (k) => k,
    });

    emptyHintToggle.trigger("change", { target: { checked: true } });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(data.settings.emptyHintDisabled, true);
    assert.equal(persisted, true);
    assert.equal(rendered, true);
  });
});
