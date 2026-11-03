/**
 * 「最近历史」管理器（history-manager.js）测试：
 * - renderHistoryCards：URL 去重、按时间倒序、截断、视图模型形状（纯函数）；
 * - fetchRecentHistory：chrome.history 回调/Promise 双形态、7 天参数、限 24 条、
 *   自建访问记录兜底合并、status 状态机（ok / error / missing→fallback）；
 * - addHistoryToShortcuts：URL 白名单校验、目标分组校验、节点与位置写入、持久化触发。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createHistoryManager, renderHistoryCards } from "../src/js/history-manager.js";

/** 最小依赖注入（记录调用供断言） */
function makeDeps(overrides = {}) {
  const calls = { persist: 0, render: 0, icons: 0, toasts: [] };
  const data = {
    settings: {},
    groups: [{ id: "grp_all", name: "全部", order: -1, nodes: [], systemAllGroup: true }],
    nodes: {},
    backups: [],
  };
  const deps = {
    debugLog: () => {},
    t: (key) => key,
    toast: (message, kind) => calls.toasts.push({ message, kind }),
    getData: () => data,
    getRootGroup: () => data.groups[0],
    getRootContainers: () => data.groups,
    getRootContainerById: (id) => data.groups.find((group) => group.id === id) || data.nodes[id] || null,
    isAllBookmarksGroup: (group) => group?.systemAllGroup === true,
    getPlacementList: (container) => (Array.isArray(container.nodes) ? container.nodes : container.children),
    setPlacementList: () => {},
    pushBackup: () => {},
    persistData: async () => {
      calls.persist += 1;
    },
    render: () => {
      calls.render += 1;
    },
    processPendingIconFetches: () => {
      calls.icons += 1;
    },
    openModal: () => {},
    closeModal: () => {},
    html: (strings, ...values) => ({ strings, values }),
    rawHtml: (text) => ({ raw: text }),
    ...overrides,
  };
  return { deps, calls, data };
}

/** 注入假的 chrome.history（回调风格） */
function stubChromeHistory(items, style = "callback") {
  const searches = [];
  globalThis.chrome = {
    runtime: { lastError: null },
    history: {
      search(query, callback) {
        searches.push(query);
        if (style === "callback") {
          callback(items);
          return undefined;
        }
        return Promise.resolve(items);
      },
    },
  };
  return { searches };
}

describe("renderHistoryCards (pure)", () => {
  it("dedupes by normalized url, sorts by visit time desc, and truncates to limit", () => {
    const browserItems = [
      { title: "A", url: "https://a.example.com/", ts: 100 },
      { title: "A-重复", url: "https://a.example.com", ts: 300 },
      { title: "B", url: "https://b.example.com/", ts: 500 },
    ];
    const visitItems = [
      { title: "C", url: "https://c.example.com/", ts: 900 },
      { title: "B-重复", url: "https://b.example.com/", ts: 800 },
    ];
    const cards = renderHistoryCards(browserItems, visitItems, 3);
    assert.deepEqual(
      cards.map((card) => card.title),
      ["C", "B", "A"],
      "按访问时间倒序；同 URL（含尾斜杠差异）先到先得（浏览器历史顺序，真实 API 即最新在前）",
    );
    assert.equal(cards.length, 3, "截断到 limit");
    assert.deepEqual(Object.keys(cards[0]).sort(), ["id", "title", "ts", "type", "url"]);
    assert.equal(cards[0].type, "history");
    assert.equal(cards[0].id, "recent_0");
  });

  it("tolerates invalid urls and empty inputs", () => {
    assert.deepEqual(renderHistoryCards(null, undefined, 5), []);
    const cards = renderHistoryCards([{ url: "not a url", ts: 1 }], [], 5);
    assert.equal(cards.length, 1, "非法 URL 保留原始串，不丢弃条目");
  });
});

describe("createHistoryManager.fetchRecentHistory", () => {
  it("queries the last 7 days with max 24 and prefers browser history", async () => {
    const now = Date.now();
    const stub = stubChromeHistory([
      { url: "https://a.example.com/", title: "A", lastVisitTime: now },
      { url: "https://a.example.com/", title: "A-again", lastVisitTime: now + 1 },
    ]);
    const { deps } = makeDeps();
    const manager = createHistoryManager(deps);
    const items = await manager.fetchRecentHistory();
    assert.equal(items.length, 1, "浏览器历史内部按 URL 去重");
    assert.equal(items[0].url, "https://a.example.com/");
    assert.equal(manager.status, "ok");
    assert.equal(stub.searches.length, 1);
    assert.equal(stub.searches[0].maxResults, 24);
    assert.ok(stub.searches[0].startTime <= now - 7 * 24 * 60 * 60 * 1000 + 1000, "回看 7 天");
  });

  it("supports promise-style history api and merges visit-history fallback", async () => {
    stubChromeHistory([{ url: "https://p.example.com/", title: "P", lastVisitTime: 10 }], "promise");
    const { deps } = makeDeps();
    const manager = createHistoryManager(deps);
    const items = await manager.fetchRecentHistory();
    const urls = items.map((item) => item.url);
    assert.ok(urls.includes("https://p.example.com/"));
    // visit-history 回退条目也进入结果（依赖 Node 下 chrome.storage 不可用时的空回退）
    assert.equal(manager.status, "ok");
  });

  it("falls back with 'fallback' status when history api is missing (safari-like)", async () => {
    delete globalThis.chrome;
    globalThis.chrome = undefined;
    const { deps } = makeDeps();
    const manager = createHistoryManager(deps);
    await manager.fetchRecentHistory();
    // Node 无自建访问记录存储 → 空列表，但状态应标记为 fallback（回退管道可用）
    assert.equal(manager.status, "fallback");
  });

  it("keeps error status when the history api reports lastError and fallback is empty", async () => {
    globalThis.chrome = {
      runtime: {},
      history: {
        search(_query, callback) {
          globalThis.chrome.runtime.lastError = { message: "denied" };
          callback([]);
          globalThis.chrome.runtime.lastError = null;
        },
      },
    };
    const { deps } = makeDeps();
    const manager = createHistoryManager(deps);
    await manager.fetchRecentHistory();
    // 浏览器历史报错 + Node 下自建访问记录为空 → 保持 error（面板显示「无法读取」）
    // （真实浏览器里自建记录非空时则升级为 fallback，与拆出前行为一致）
    assert.equal(manager.status, "error");
  });
});

describe("createHistoryManager.addHistoryToShortcuts", () => {
  it("persists a normalized item into the target group and refreshes icons", async () => {
    const { deps, calls, data } = makeDeps();
    const manager = createHistoryManager(deps);
    await manager.addHistoryToShortcuts({ title: "示例", url: "https://example.com/" }, "grp_all");
    const ids = data.groups[0].nodes;
    assert.equal(ids.length, 1);
    const node = data.nodes[ids[0]];
    assert.equal(node.type, "item");
    assert.equal(node.url, "https://example.com/");
    assert.equal(node.title, "示例");
    assert.equal(node.iconPending, true);
    assert.equal(calls.persist, 1, "必须触发持久化（进而触发同步）");
    assert.equal(calls.render, 1);
    assert.equal(calls.icons, 1);
  });

  it("rejects unsafe urls and unknown groups with a toast", async () => {
    const { deps, calls, data } = makeDeps();
    const manager = createHistoryManager(deps);
    await manager.addHistoryToShortcuts({ title: "内页", url: "chrome://settings/" }, "grp_all");
    assert.equal(calls.toasts.length, 1, "协议白名单拒绝 → toast");
    assert.equal(calls.toasts[0].kind, "error");
    await manager.addHistoryToShortcuts({ title: "x", url: "https://ok.example.com/" }, "nope");
    assert.equal(calls.toasts.length, 2, "未知分组 → toast");
    assert.equal(Object.keys(data.nodes).length, 0, "不得写入任何节点");
    assert.equal(calls.persist, 0);
  });

  it("falls back to hostname when the history item has no title", async () => {
    const { deps, data } = makeDeps();
    const manager = createHistoryManager(deps);
    await manager.addHistoryToShortcuts({ url: "https://news.example.com/story" }, "grp_all");
    const node = data.nodes[data.groups[0].nodes[0]];
    assert.equal(node.title, "news.example.com");
  });

  it("addHistoryToDefaultGroup prefers the fixed default group and skips the recent group", async () => {
    const { deps, data } = makeDeps();
    data.settings.defaultGroupMode = "fixed";
    data.settings.defaultGroupId = "grp_fixed";
    data.groups.push({ id: "grp_fixed", name: "固定", order: 0, nodes: [] });
    const manager = createHistoryManager(deps);
    await manager.addHistoryToDefaultGroup({ title: "x", url: "https://x.example.com/" });
    assert.ok(data.groups.find((group) => group.id === "grp_fixed").nodes.length === 1);

    // lastActive 指向历史分组时应跳过，回落到第一个分组
    data.settings.defaultGroupMode = "last";
    data.settings.lastActiveGroupId = "__recent__";
    await manager.addHistoryToDefaultGroup({ title: "y", url: "https://y.example.com/" });
    assert.ok(data.groups[0].nodes.length === 1, "历史分组不可作为固化目标");
  });
});
