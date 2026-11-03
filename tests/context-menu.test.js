import assert from "node:assert/strict";
import test from "node:test";
import { createContextMenuManager, positionMenuAt } from "../src/js/context-menu.js";

function createMockElement(tag = "div") {
  const classList = new Set(["hidden"]);
  const style = {};
  const children = [];
  const listeners = {};

  return {
    tagName: tag.toUpperCase(),
    textContent: "",
    classList: {
      add: (c) => classList.add(c),
      remove: (c) => classList.delete(c),
      contains: (c) => classList.has(c),
    },
    style,
    getBoundingClientRect: () => ({ width: 150, height: 200 }),
    replaceChildren: () => {
      children.length = 0;
    },
    appendChild: (child) => {
      children.push(child);
    },
    querySelectorAll: (sel) => {
      if (sel === "button") return children.filter((c) => c.tagName === "BUTTON");
      return children;
    },
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    click: () => {
      listeners.click?.();
    },
  };
}

test("positionMenuAt prevents menu from overflowing viewport edges", () => {
  const menu = createMockElement("div");
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  globalThis.document = { documentElement: { clientWidth: 800, clientHeight: 600 } };

  // 视口内正常坐标
  positionMenuAt(menu, 100, 150, 8);
  assert.equal(menu.style.left, "100px");
  assert.equal(menu.style.top, "150px");
  assert.equal(menu.classList.contains("hidden"), false);

  // 溢出右/下边缘：maxLeft = 800 - 150 - 8 = 642, maxTop = 600 - 200 - 8 = 392
  positionMenuAt(menu, 780, 580, 8);
  assert.equal(menu.style.left, "642px");
  assert.equal(menu.style.top, "392px");

  // 越界负值坐标
  positionMenuAt(menu, -20, -50, 8);
  assert.equal(menu.style.left, "8px");
  assert.equal(menu.style.top, "8px");
});

test("createContextMenuManager shows correct actions for bookmark items and dispatches callback", () => {
  const menu = createMockElement("div");
  globalThis.document = {
    createElement: (tag) => createMockElement(tag),
  };

  let openedUrl = null;
  let deletedIds = null;

  const manager = createContextMenuManager({
    menuElement: menu,
    t: (key) => key,
    normalizeUrl: (u) => u,
    callbacks: {
      openUrl: (url) => {
        openedUrl = url;
      },
      deleteNodes: (ids) => {
        deletedIds = ids;
      },
    },
  });

  const node = { id: "item1", type: "item", url: "https://example.com" };
  manager.showTileMenu(50, 50, node);

  const buttons = menu.querySelectorAll("button");
  const labels = buttons.map((b) => b.textContent);

  assert.ok(labels.includes("context.openCurrent"));
  assert.ok(labels.includes("context.openNew"));
  assert.ok(labels.includes("context.openBackground"));
  assert.ok(labels.includes("context.edit"));
  assert.ok(labels.includes("context.delete"));

  // 点击 openCurrent
  const openBtn = buttons.find((b) => b.textContent === "context.openCurrent");
  openBtn.click();
  assert.equal(openedUrl, "https://example.com");
  assert.equal(menu.classList.contains("hidden"), true);

  // 再次打开并点击 delete
  manager.showTileMenu(50, 50, node);
  const deleteBtn = menu.querySelectorAll("button").find((b) => b.textContent === "context.delete");
  deleteBtn.click();
  assert.deepEqual(deletedIds, ["item1"]);
});

test("createContextMenuManager shows folder-specific actions for folders", () => {
  const menu = createMockElement("div");
  globalThis.document = {
    createElement: (tag) => createMockElement(tag),
  };

  let openedFolderId = null;
  let dissolvedFolderId = null;

  const manager = createContextMenuManager({
    menuElement: menu,
    t: (key) => key,
    normalizeUrl: (u) => u,
    callbacks: {
      openFolder: (id) => {
        openedFolderId = id;
      },
      dissolveFolder: (id) => {
        dissolvedFolderId = id;
      },
    },
  });

  const folder = { id: "folder1", type: "folder", title: "My Folder" };
  manager.showTileMenu(30, 30, folder);

  const labels = menu.querySelectorAll("button").map((b) => b.textContent);
  assert.ok(labels.includes("context.openFolder"));
  assert.ok(labels.includes("context.dissolveFolder"));
  assert.ok(!labels.includes("context.openBackground"));

  menu
    .querySelectorAll("button")
    .find((b) => b.textContent === "context.openFolder")
    .click();
  assert.equal(openedFolderId, "folder1");

  manager.showTileMenu(30, 30, folder);
  menu
    .querySelectorAll("button")
    .find((b) => b.textContent === "context.dissolveFolder")
    .click();
  assert.equal(dissolvedFolderId, "folder1");
});
