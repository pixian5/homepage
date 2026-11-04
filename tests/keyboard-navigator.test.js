import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createKeyboardNavigator } from "../src/js/keyboard-navigator.js";

function createMockElement(tagName = "div", props = {}) {
  const listeners = new Map();
  return {
    tagName: tagName.toUpperCase(),
    dataset: {},
    style: {},
    classList: {
      contains(cls) {
        return !!props[cls];
      },
    },
    addEventListener(event, fn) {
      listeners.set(event, fn);
    },
    removeEventListener(event) {
      listeners.delete(event);
    },
    dispatchEvent(event) {
      const fn = listeners.get(event.type);
      if (fn) fn(event);
    },
    focus() {
      this.focused = true;
    },
    ...props,
  };
}

describe("keyboard-navigator", () => {
  test("skips all navigation when keyboardNav setting is false", () => {
    let folderClosed = false;
    let focused = false;
    const navigator = createKeyboardNavigator({
      getData: () => ({ settings: { keyboardNav: false } }),
      getState: () => ({ activeGroupId: "g1", openFolderId: "f1" }),
      getElements: () => ({
        modalOverlay: createMockElement("div", { hidden: true }),
        topSearch: {
          focus: () => {
            focused = true;
          },
        },
      }),
      closeFolder: () => {
        folderClosed = true;
      },
      deleteNodes: () => {},
      doc: { activeElement: null },
    });

    const event = { key: "Escape", target: {} };
    navigator.handleKeydown(event);
    assert.equal(folderClosed, false);
    navigator.handleKeydown({ key: "/", target: {}, preventDefault: () => {} });
    assert.equal(focused, false);
  });

  test("focuses search input when pressing slash", () => {
    let searchFocused = false;
    let defaultPrevented = false;
    const navigator = createKeyboardNavigator({
      getData: () => ({ settings: { keyboardNav: true } }),
      getState: () => ({ activeGroupId: "g1", openFolderId: null }),
      getElements: () => ({
        modalOverlay: createMockElement("div", { hidden: true }),
        topSearch: {
          focus: () => {
            searchFocused = true;
          },
        },
      }),
      closeFolder: () => {},
      deleteNodes: () => {},
      doc: { activeElement: null },
    });

    navigator.handleKeydown({
      key: "/",
      target: createMockElement("div"),
      preventDefault: () => {
        defaultPrevented = true;
      },
    });

    assert.equal(searchFocused, true);
    assert.equal(defaultPrevented, true);
  });

  test("closes open folder when pressing Escape even in input", () => {
    let folderClosed = false;
    const navigator = createKeyboardNavigator({
      getData: () => ({ settings: { keyboardNav: true } }),
      getState: () => ({ activeGroupId: "g1", openFolderId: "fld_1" }),
      getElements: () => ({
        modalOverlay: createMockElement("div", { hidden: true }),
      }),
      closeFolder: () => {
        folderClosed = true;
      },
      deleteNodes: () => {},
      doc: { activeElement: null },
    });

    navigator.handleKeydown({
      key: "Escape",
      target: createMockElement("input"),
    });

    assert.equal(folderClosed, true);
  });

  test("deletes active focused tile and transfers focus", () => {
    let deletedIds = null;
    let defaultPrevented = false;
    const tile1 = createMockElement("div", { dataset: { id: "node_1" } });
    const tile2 = createMockElement("div", { dataset: { id: "node_2" } });
    const tiles = [tile1, tile2];

    const mockDoc = { activeElement: tile1 };
    const navigator = createKeyboardNavigator({
      getData: () => ({ settings: { keyboardNav: true } }),
      getState: () => ({ activeGroupId: "grp_all", openFolderId: null }),
      getElements: () => ({
        modalOverlay: createMockElement("div", { hidden: true }),
        grid: createMockElement("div"),
      }),
      closeFolder: () => {},
      deleteNodes: (ids) => {
        deletedIds = ids;
      },
      qsa: () => tiles,
      doc: mockDoc,
    });

    navigator.handleKeydown({
      key: "Delete",
      target: tile1,
      preventDefault: () => {
        defaultPrevented = true;
      },
    });

    assert.deepEqual(deletedIds, ["node_1"]);
    assert.equal(defaultPrevented, true);
    assert.equal(tile1.focused, true);
  });

  test("refuses delete in recent group", () => {
    let deleted = false;
    const tile1 = createMockElement("div", { dataset: { id: "node_1" } });
    const navigator = createKeyboardNavigator({
      getData: () => ({ settings: { keyboardNav: true } }),
      getState: () => ({ activeGroupId: "__recent__", openFolderId: null }),
      getElements: () => ({
        modalOverlay: createMockElement("div", { hidden: true }),
        grid: createMockElement("div"),
      }),
      closeFolder: () => {},
      deleteNodes: () => {
        deleted = true;
      },
      qsa: () => [tile1],
      doc: { activeElement: tile1 },
    });

    navigator.handleKeydown({
      key: "Backspace",
      target: tile1,
      preventDefault: () => {},
    });

    assert.equal(deleted, false);
  });
});
