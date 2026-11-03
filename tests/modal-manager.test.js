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
  // 设置 Element 运行时类型守卫
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

  // mock DOMParser
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
