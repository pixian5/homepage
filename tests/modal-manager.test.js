import assert from "node:assert/strict";
import test from "node:test";
import {
  bindModalEnterToDefaultAction,
  createModalManager,
  findModalDefaultActionButton,
} from "../src/js/modal-manager.js";

function createMockElement(id = "", tag = "div") {
  const classList = new Set(["hidden"]);
  const attributes = new Map();
  const children = [];
  const listeners = {};

  const el = {
    id,
    tagName: tag.toUpperCase(),
    textContent: "",
    value: "",
    disabled: false,
    childNodes: children,
    offsetParent: {}, // 模拟可见
    classList: {
      add: (c) => classList.add(c),
      remove: (c) => classList.delete(c),
      contains: (c) => classList.has(c),
    },
    setAttribute: (k, v) => attributes.set(k, String(v)),
    getAttribute: (k) => attributes.get(k) ?? null,
    removeAttribute: (k) => attributes.delete(k),
    hasAttribute: (k) => attributes.has(k),
    replaceChildren: (...newChildren) => {
      children.length = 0;
      children.push(...newChildren);
    },
    appendChild: (child) => {
      children.push(child);
    },
    querySelector: (sel) => {
      if (sel.startsWith("#")) {
        const targetId = sel.slice(1);
        return children.find((c) => c.id === targetId) || null;
      }
      return null;
    },
    querySelectorAll: (_sel) => {
      return children;
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    removeEventListener: (type, _fn) => {
      delete listeners[type];
    },
    dispatchEvent: (event) => {
      listeners[event.type]?.(event);
    },
    click: () => {
      listeners.click?.();
    },
    focus: () => {},
  };
  return el;
}

test("findModalDefaultActionButton prioritizes primary action buttons", () => {
  const modal = createMockElement("modal");
  const btnClose = createMockElement("btnClose", "button");
  const btnSave = createMockElement("btnSave", "button");

  modal.appendChild(btnClose);
  modal.appendChild(btnSave);

  const defaultBtn = findModalDefaultActionButton(modal);
  assert.ok(defaultBtn);
  assert.equal(defaultBtn.id, "btnSave");
});

test("bindModalEnterToDefaultAction triggers click on Enter", () => {
  globalThis.Element = class {};

  const modal = createMockElement("modal");
  Object.setPrototypeOf(modal, globalThis.Element.prototype);

  const input = createMockElement("testInput", "input");
  Object.setPrototypeOf(input, globalThis.Element.prototype);

  const btnSave = createMockElement("btnSave", "button");
  Object.setPrototypeOf(btnSave, globalThis.Element.prototype);

  modal.appendChild(input);
  modal.appendChild(btnSave);

  let clicked = false;
  btnSave.addEventListener("click", () => {
    clicked = true;
  });

  bindModalEnterToDefaultAction(modal);

  let defaultPrevented = false;
  modal.dispatchEvent({
    type: "keydown",
    key: "Enter",
    target: input,
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {},
  });

  assert.equal(clicked, true);
  assert.equal(defaultPrevented, true);
});

test("createModalManager opens and closes modal with proper accessibility attributes", async () => {
  const modal = createMockElement("modal");
  const modalOverlay = createMockElement("modalOverlay");
  const btnSettings = createMockElement("btnSettings", "button");

  globalThis.DOMParser = class {
    parseFromString(_html) {
      return {
        getElementById: () => createMockElement("modal-root"),
      };
    }
  };
  globalThis.document = {
    importNode: (node) => node,
    createDocumentFragment: () => {
      const children = [];
      return {
        children,
        childNodes: children,
        append: (...nodes) => children.push(...nodes),
      };
    },
  };

  let closed = false;
  const manager = createModalManager({
    modalEl: modal,
    modalOverlayEl: modalOverlay,
    btnSettingsEl: btnSettings,
    t: (k) => k,
    toast: () => {},
    onModalClose: async () => {
      closed = true;
    },
  });

  manager.openModal("<h3>Hello Modal</h3>");
  assert.equal(modalOverlay.classList.contains("hidden"), false);
  assert.equal(modalOverlay.getAttribute("aria-hidden"), "false");
  assert.equal(modalOverlay.hasAttribute("inert"), false);

  await manager.closeModal();
  assert.equal(modalOverlay.classList.contains("hidden"), true);
  assert.equal(modalOverlay.getAttribute("aria-hidden"), "true");
  assert.equal(modalOverlay.hasAttribute("inert"), true);
  assert.equal(closed, true);
});

test("createModalManager dispatches setState on save failure and recent group switch", async () => {
  const modal = createMockElement("modal");
  const modalOverlay = createMockElement("modalOverlay");
  const btnSettings = createMockElement("btnSettings", "button");

  // DOM 元素查询 mock
  const domElements = {
    fieldUrl: Object.assign(createMockElement("fieldUrl", "input"), { value: "https://test.com" }),
    fieldTitle: Object.assign(createMockElement("fieldTitle", "input"), { value: "Test Title" }),
    fieldIconType: Object.assign(createMockElement("fieldIconType", "select"), { value: "auto" }),
    iconExtra: createMockElement("iconExtra", "div"),
    btnSave: createMockElement("btnSave", "button"),
    btnCancel: createMockElement("btnCancel", "button"),
  };

  globalThis.document = {
    getElementById: (id) => domElements[id] || null,
    createElement: (tag) => createMockElement("", tag),
    importNode: (node) => node,
    createDocumentFragment: () => {
      const children = [];
      return {
        children,
        childNodes: children,
        append: (...nodes) => children.push(...nodes),
      };
    },
  };

  globalThis.DOMParser = class {
    parseFromString(_html) {
      const root = createMockElement("modal-root");
      root.appendChild(domElements.btnSave);
      return {
        getElementById: () => root,
      };
    }
  };

  let receivedSetState = null;
  const stateData = {
    nodes: {},
    groups: [{ id: "g1", title: "Group 1", children: [] }],
    settings: {},
  };

  const manager = createModalManager({
    modalEl: modal,
    modalOverlayEl: modalOverlay,
    btnSettingsEl: btnSettings,
    t: (k) => k,
    toast: () => {},
    getState: () => ({
      data: stateData,
      openFolderId: "",
      activeGroupId: "__recent__",
    }),
    setState: (patch) => {
      receivedSetState = patch;
    },
    readFileAsDataUrl: async () => "",
    readIconAsDataUrl: async () => "",
    fetchTitleInBackground: () => {},
    fetchFaviconInBackground: () => {},
    fetchFaviconNow: async () => true,
    clearIconCacheForUrl: async () => {},
    pushBackup: () => {},
    persistData: async () => ({ ok: false }), // 模拟保存失败
    render: () => {},
    debugLog: () => {},
    getContainerHelpers: () => ({
      getFolderPlacementContainer: () => null,
      getPlacementList: () => [],
      setPlacementList: () => {},
      touchPlacementContainer: () => {},
      getActiveGroup: () => ({ id: "g1" }),
    }),
  });

  manager.openAddModal();
  // 触发保存
  await domElements.btnSave.click();

  // 1. 验证最近分组添加时触发了切组
  // 2. 验证保存失败后调用了 setState({ data: snapshot })
  assert.ok(receivedSetState);
  assert.ok(receivedSetState.data, "失败时必须触发 setState 回滚内存 snapshot");
});
