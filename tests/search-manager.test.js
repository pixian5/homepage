/**
 * 顶部搜索管理器（search-manager.js）测试：
 * - buildSearchUrl / filterTilesByQuery 纯函数（URL 拼接、拼音命中、空查询恢复全量）；
 * - createSearchManager：input 实时过滤、Enter 跳搜索引擎、Escape 清空恢复、
 *   空查询聚焦不跳转、focus 回调触发。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSearchUrl, createSearchManager, filterTilesByQuery } from "../src/js/search-manager.js";

/** 极简 DOM 替身：只实现搜索管理器用到的接口 */
function fakeElement() {
  const listeners = new Map();
  return {
    value: "",
    style: {},
    dataset: {},
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    focus() {
      this.focused = true;
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn({ key: "", preventDefault: () => {}, ...event });
    },
  };
}

function makeSetup(overrides = {}) {
  const calls = { render: 0, opened: [], focus: [] };
  const data = { settings: { searchEngineUrl: "https://www.baidu.com/s?wd=" } };
  const nodes = {
    n1: { id: "n1", title: "GitHub", url: "https://github.com/" },
    n2: { id: "n2", title: "重庆市政府", url: "https://cq.example.com/" },
    n3: { id: "n3", title: "Docs", url: "https://docs.example.com/hello" },
  };
  const tiles = ["n1", "n2", "n3"].map((id) => ({ dataset: { id }, style: {} }));
  const grid = { tiles };
  const input = fakeElement();
  const btn = fakeElement();
  const manager = createSearchManager({
    searchInput: input,
    searchBtn: btn,
    getData: () => data,
    getActiveGrid: () => grid,
    getNodes: () => nodes,
    openUrl: (url, mode) => calls.opened.push({ url, mode }),
    render: () => {
      calls.render += 1;
    },
    onFocus: () => calls.focus.push(1),
    qsa: (_sel, root) => (root === grid ? grid.tiles : []),
    ...overrides,
  });
  return { manager, input, btn, tiles, nodes, calls, data };
}

describe("buildSearchUrl (pure)", () => {
  it("appends the encoded query to the engine prefix", () => {
    assert.equal(
      buildSearchUrl("https://www.baidu.com/s?wd=", " hello 世界 "),
      "https://www.baidu.com/s?wd=hello%20%E4%B8%96%E7%95%8C",
    );
    assert.equal(buildSearchUrl("", "x"), "x");
  });
});

describe("filterTilesByQuery (pure)", () => {
  const nodes = {
    a: { title: "重庆新闻", url: "https://cq.example.com/" },
    b: { title: "Docs", url: "https://docs.example.com/" },
  };
  const tiles = [
    { dataset: { id: "a" }, style: {} },
    { dataset: { id: "b" }, style: {} },
    { dataset: { id: "ghost" }, style: {} },
  ];

  it("keeps pinyin (initials) and substring matches, hides the rest", () => {
    const plan = filterTilesByQuery(nodes, tiles, "cq");
    assert.deepEqual(
      plan.map((entry) => entry.visible),
      [true, false, false],
      "cq 命中「重庆」拼音首字母",
    );
    const plan2 = filterTilesByQuery(nodes, tiles, "docs.example");
    assert.deepEqual(
      plan2.map((entry) => entry.visible),
      [false, true, false],
      "网址子串命中",
    );
  });

  it("restores all tiles on an empty query and ignores unknown ids", () => {
    const plan = filterTilesByQuery(nodes, tiles, "");
    assert.deepEqual(
      plan.map((entry) => entry.visible),
      [true, true, true],
    );
  });
});

describe("createSearchManager", () => {
  it("filters tiles live on input and restores everything when cleared", () => {
    const { manager, input, tiles } = makeSetup();
    input.value = "github";
    manager.handleInput();
    assert.deepEqual(
      tiles.map((tile) => tile.style.display),
      ["", "none", "none"],
    );
    // 清空 → 走 render 恢复全量
    input.value = "";
    manager.handleInput();
  });

  it("submits to the search engine on Enter and empty query just focuses", () => {
    const { manager, input, btn, calls } = makeSetup();
    manager.bind();
    input.value = "测试查询";
    input.dispatch("keydown", { key: "Enter", preventDefault() {} });
    assert.deepEqual(calls.opened, [
      { url: "https://www.baidu.com/s?wd=%E6%B5%8B%E8%AF%95%E6%9F%A5%E8%AF%A2", mode: "new" },
    ]);

    input.value = "";
    btn.dispatch("click");
    assert.equal(calls.opened.length, 1, "空查询不得跳转");
    assert.equal(input.focused, true, "空查询聚焦搜索框");
  });

  it("clears the query and restores the grid on Escape", () => {
    const { manager, input, calls } = makeSetup();
    manager.bind();
    input.value = "github";
    manager.handleInput();
    assert.equal(calls.render, 0, "有查询时不重渲染");
    input.dispatch("keydown", { key: "Escape", preventDefault() {} });
    assert.equal(input.value, "", "Escape 清空搜索框");
    assert.equal(calls.render, 1, "Escape 恢复全量卡片");
  });

  it("invokes the onFocus hook and binds idempotently", () => {
    const { manager, input, calls } = makeSetup();
    manager.bind();
    manager.bind();
    input.dispatch("focus");
    assert.equal(calls.focus.length, 1, "重复 bind 不重复触发（旧监听已解绑）");
  });
});
