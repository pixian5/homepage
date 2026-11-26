import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "src/js/error-bootstrap.js"), "utf8");

function createDomSandbox({ withBody = true } = {}) {
  const listeners = new Map();
  const bodyChildren = [];
  const createEl = (tag) => ({
    tagName: tag.toUpperCase(),
    id: "",
    style: { cssText: "" },
    textContent: "",
    children: [],
    remove() {
      const idx = bodyChildren.indexOf(this);
      if (idx !== -1) bodyChildren.splice(idx, 1);
    },
  });
  const doc = {
    body: withBody
      ? {
          children: bodyChildren,
          appendChild(el) {
            bodyChildren.push(el);
          },
        }
      : null,
    createElement: createEl,
    getElementById(id) {
      return bodyChildren.find((el) => el.id === id) || null;
    },
  };
  const win = {
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    dispatchEvent(type, payload) {
      for (const handler of listeners.get(type) || []) {
        handler(payload);
      }
    },
  };
  const context = vm.createContext({
    window: win,
    document: doc,
  });
  return { context, win, doc, bodyChildren, listeners };
}

describe("error-bootstrap", () => {
  it("renders fatal error panel safely with textContent and replaces previous panels", () => {
    const { context, win, doc, bodyChildren } = createDomSandbox();
    vm.runInContext(source, context);

    assert.equal(typeof win.__homepageRenderFatalError, "function");
    assert.equal(win.__homepageErrorBootstrapInjected, true);

    const payload = "<img src=x onerror=alert(1)>";
    win.__homepageRenderFatalError("发生故障", payload);
    assert.equal(bodyChildren.length, 1);
    const panel = doc.getElementById("fatalError");
    assert.ok(panel);
    assert.equal(panel.textContent, `发生故障\n${payload}`);
    assert.equal(panel.children.length, 0);

    win.__homepageRenderFatalError("二次错误", "detail-2");
    assert.equal(bodyChildren.length, 1);
    assert.equal(doc.getElementById("fatalError")?.textContent, "二次错误\ndetail-2");
  });

  it("handles missing document.body without throwing", () => {
    const { context, win } = createDomSandbox({ withBody: false });
    vm.runInContext(source, context);
    assert.doesNotThrow(() => win.__homepageRenderFatalError("无主体", "no body"));
  });

  it("listens to global error and unhandledrejection events idempotently", () => {
    const { context, win, doc, listeners } = createDomSandbox();
    vm.runInContext(source, context);
    vm.runInContext(source, context);

    assert.equal(listeners.get("error")?.length, 1);
    assert.equal(listeners.get("unhandledrejection")?.length, 1);

    win.dispatchEvent("error", { message: "boom" });
    assert.equal(doc.getElementById("fatalError")?.textContent, "我的首页加载失败\nboom");

    win.dispatchEvent("unhandledrejection", { reason: new Error("async-fail") });
    assert.match(doc.getElementById("fatalError")?.textContent || "", /^我的首页初始化失败\nError: async-fail/);
  });
});
